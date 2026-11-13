"""Foreground cancellation versus a Robob shutdown; no live providers or boxes."""
import contextlib
import io
import json
import signal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from test_capacity import Isolated
from offbox_lib import api, common, lease, misc, reap, runs


class HostLossTests(Isolated):
    def setUp(self):
        super().setUp()
        self.marker = Path(self.tmp.name) / 'restarting'
        self.stack.enter_context(patch.object(runs, 'RESTART_MARKER', self.marker))
        self.stack.enter_context(patch.object(runs, 'now', return_value=1000))
        self.kill = self.stack.enter_context(patch.object(api, 'cmd_kill'))
        self.get = self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.ttl = self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.handlers = {}
        self.stack.enter_context(patch.object(runs.signal, 'signal', side_effect=self.install))
        self.a = SimpleNamespace(bg=False, cmd=['proof'], pull=['result.txt'], steps=[], no_sync=True)
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def install(self, sig, handler):
        old = self.handlers.get(sig)
        self.handlers[sig] = handler
        return old

    def runner(self, sig, *, early=False, starting=False):
        rn = runs.Runner(self.a, self.me)
        rn.root = Path(self.tmp.name)
        def start():
            self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,log_path,pulls,owner,client_pid) "
                             "VALUES (?, 'fg','starting',1000,?,'[\"result.txt\"]','worker',?)",
                             (rn.run_id, str(rn.log_path), 999999999))
            self.con.commit()
            if early:
                self.handlers[sig](sig, None)
            rn.started, rn.box, rn.pid = True, 'bx_test', 42
            rn.record(box_id=rn.box, process_id=rn.pid, status='running')
            if starting:
                self.handlers[sig](sig, None)
        def stream():
            rn.log_path.write_bytes(b'proof prefix\n')
            runs._commit(rn.log_path, 13, 0, 13)
            self.handlers[sig](sig, None)
        rn.start, rn.stream = start, stream
        return rn

    def fresh(self):
        self.marker.write_text(json.dumps({'pid': 123, 'at': 999}))

    def test_term_and_hup_detach_only_with_fresh_marker(self):
        self.fresh()
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                rn = self.runner(sig)
                self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED)
                self.kill.assert_not_called()
                self.ttl.assert_called_with('bx_test', runs.BG_TTL_S, self.get.return_value)
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
                self.assertEqual((row['mode'], row['status'], row['start_at'], row['exit_code']),
                                 ('bg', 'running', 1000, None))
                self.assertEqual(row['pulls'], '["result.txt"]')
                self.assertIsNone(row['error'])
                line = f'offbox: client lost ({sig.name}); run {rn.run_id} keeps going on bx_test. Re-attach: offbox wait {rn.run_id}'
                self.assertIn(line, rn.log_path.read_text())
                self.assertIn(line, self.err.getvalue())
                self.assertEqual(common.checkpoint(rn.log_path)['logBytes'], rn.log_path.stat().st_size)

    def test_interrupt_and_unmarked_signals_still_kill(self):
        for marked, sig in ((True, signal.SIGINT), (False, signal.SIGINT),
                            (False, signal.SIGTERM), (False, signal.SIGHUP)):
            with self.subTest(marked=marked, sig=sig):
                if marked:
                    self.fresh()
                else:
                    self.marker.unlink(missing_ok=True)
                rn = self.runner(sig)
                self.kill.reset_mock()
                self.assertEqual(runs._run_remote(self.a, rn), 130)
                self.kill.assert_called_once_with('bx_test', 42)

    def test_marker_input_matrix(self):
        for content in ('invalid', '[]', '{}', '{"pid":true,"at":999}', '{"pid":0,"at":999}',
                        '{"pid":123,"at":"999"}', '{"pid":123,"at":700}',
                        '{"pid":123,"at":1001}', '{"pid":123,"at":NaN}'):
            with self.subTest(content=content):
                self.marker.write_text(content)
                rn = self.runner(signal.SIGTERM)
                self.kill.reset_mock()
                self.assertEqual(runs._run_remote(self.a, rn), 130)
                self.kill.assert_called_once_with('bx_test', 42)

    def test_signal_before_remote_start_still_finishes_killed(self):
        self.fresh()
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(sig=sig):
                rn = self.runner(sig, early=True)
                with patch.object(runs, 'Runner', return_value=rn), self.assertRaises(KeyboardInterrupt):
                    runs._run_attempt(self.a, self.me)
                row = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
                self.assertEqual(tuple(row), ('killed', 130))
        self.kill.assert_not_called()

    def test_accepted_start_detaches_even_before_start_returns(self):
        self.fresh()
        rn = self.runner(signal.SIGTERM, starting=True)
        self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED)
        self.kill.assert_not_called()
        self.assertTrue(rn.log_path.exists())

    def test_wait_reattaches_and_collects_real_exit_and_pulls(self):
        self.fresh()
        rn = self.runner(signal.SIGTERM)
        self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED)
        def frames(*args, **kwargs):
            yield {'type': 'stdout', 'data': 'proof passed\n'}
            yield {'type': 'exit', 'exitCode': 0}
        with patch.object(misc, '_require_my_run'), patch.object(runs.api, 'stream', side_effect=frames), \
                patch.object(runs, '_ttl_keeper'), patch.object(runs, 'do_pulls') as pulls, \
                patch.object(misc, '_catch_up_finished'), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait(rn.run_id, None), 0)
        self.kill.assert_not_called()
        pulls.assert_called_once()
        self.assertIn('proof passed', rn.log_path.read_text())
        self.assertIn('client lost (SIGTERM)', rn.log_path.read_text())
        row = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        self.assertEqual(tuple(row), ('done', 0))

    def test_detach_does_not_restart_orphan_allowance(self):
        self.fresh()
        rn = self.runner(signal.SIGTERM)
        start = rn.start
        def aged_start():
            start()
            rn.record(start_at=1000 - common.ORPHAN_RUN_MAX_S + 60)
        rn.start = aged_start
        self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED)
        self.ttl.assert_called_once_with('bx_test', 60, self.get.return_value)
        with patch.object(reap, 'now', return_value=1060):
            reap._keep_live_runs(self.con, 'bx_test', self.get.return_value, False)
        self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='run_orphan_cap'").fetchone()[0], 1)

    def test_signal_handler_never_calls_kill_or_writes_stderr(self):
        rn = self.runner(signal.SIGTERM)
        def start():
            with patch.object(runs, 'say') as say, patch.object(rn, 'kill') as kill:
                with self.assertRaises(KeyboardInterrupt):
                    self.handlers[signal.SIGTERM](signal.SIGTERM, None)
                self.handlers[signal.SIGHUP](signal.SIGHUP, None)
                say.assert_not_called()
                kill.assert_not_called()
            raise KeyboardInterrupt
        rn.start = start
        with self.assertRaises(KeyboardInterrupt):
            runs._run_remote(self.a, rn)

    def test_real_follow_signal_never_waits_on_blocked_keeper(self):
        for marked, sig in ((False, signal.SIGINT), (False, signal.SIGTERM),
                            (True, signal.SIGTERM), (True, signal.SIGHUP)):
            with self.subTest(marked=marked, sig=sig):
                if marked:
                    self.fresh()
                else:
                    self.marker.unlink(missing_ok=True)
                rn = self.runner(sig)
                rn.stream = lambda: runs.follow(rn.box, rn.pid, rn.log_path, echo=False, run_id=rn.run_id)
                keeper = Mock()
                keeper.join.side_effect = lambda timeout: self.assertEqual(timeout, 0)
                def frames(*args, **kwargs):
                    yield {'type': 'stdout', 'data': 'proof prefix\n'}
                    self.handlers[sig](sig, None)
                self.kill.reset_mock()
                with patch.object(runs.threading, 'Thread', return_value=keeper), \
                        patch.object(api, 'stream', side_effect=frames):
                    self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED if marked else 130)
                keeper.join.assert_called_once_with(0)
                if marked:
                    self.kill.assert_not_called()
                else:
                    self.kill.assert_called_once_with('bx_test', 42)

    def test_detach_discards_uncommitted_chunk_before_wait_replays_it(self):
        self.fresh()
        rn = self.runner(signal.SIGTERM)
        rn.stream = lambda: runs.follow(rn.box, rn.pid, rn.log_path, echo=False, run_id=rn.run_id)
        commit = runs._commit
        writes = 0
        def interrupt_commit(*args):
            nonlocal writes
            writes += 1
            if writes == 2:
                self.handlers[signal.SIGTERM](signal.SIGTERM, None)
            commit(*args)
        def frames(*args, **kwargs):
            yield {'type': 'stdout', 'data': 'proof passed\n'}
            yield {'type': 'exit', 'exitCode': 0}
        with patch.object(runs, '_ttl_keeper'), patch.object(api, 'stream', side_effect=frames), \
                patch.object(runs, '_commit', side_effect=interrupt_commit):
            self.assertEqual(runs._run_remote(self.a, rn), common.EXIT_DETACHED)
        self.assertNotIn('proof passed', rn.log_path.read_text())
        self.assertEqual(common.checkpoint(rn.log_path)['stdoutOffset'], 0)
        with patch.object(misc, '_require_my_run'), patch.object(api, 'stream', side_effect=frames), \
                patch.object(runs, '_ttl_keeper'), patch.object(runs, 'do_pulls'), \
                patch.object(misc, '_catch_up_finished'), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait(rn.run_id, None), 0)
        self.assertEqual(rn.log_path.read_text().count('proof passed'), 1)
        self.assertIn('client lost (SIGTERM)', rn.log_path.read_text())
        self.kill.assert_not_called()
