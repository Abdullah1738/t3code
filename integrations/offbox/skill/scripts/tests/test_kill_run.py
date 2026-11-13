"""Offline tests for `offbox kill <run>`, the release refusal message, and the reaper's no-box run cleanup."""
import contextlib
import io
import itertools
import os
import signal
import subprocess
import threading
import sys
import unittest
from pathlib import Path
from unittest.mock import ANY, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, home, identity, lease, misc, reap, runs, start_check  # noqa: E402
from offbox_lib.common import now  # noqa: E402

from test_capacity import Isolated  # noqa: E402


class KillRunTests(Isolated):
    def setUp(self):
        super().setUp()
        # The fake boxes have no start claim: the SSH check fences any late start by default.
        self.start_check = self.stack.enter_context(patch.object(start_check, 'check',
                                                                return_value=start_check.Result('fenced')))
        self.elapsed = 0.0
        self.stack.enter_context(patch.object(misc, 'monotonic', side_effect=lambda: self.elapsed, create=True))
        self.sleep = self.stack.enter_context(patch.object(misc, 'sleep', side_effect=self.advance, create=True))

    def advance(self, seconds):
        self.elapsed += seconds

    def run_row(self, rid='run-1', box='bx_1', pid=42, status='running', mode='fg', start=None, error=None,
                client=None, owner=None, remote_dir=None, claim=True):
        self.con.execute("""INSERT INTO runs(run_id,box_id,process_id,status,mode,start_at,error,client_pid,owner,remote_dir)
                            VALUES (?,?,?,?,?,?,?,?,?,?)""",
                         (rid, box, pid, status, mode, start if start is not None else now() - 60, error, client, owner, remote_dir))
        if claim:
            self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?, '1')", (f'start_claim:{rid}',))
        self.con.commit()

    def status_of(self, rid):
        return self.con.execute("SELECT status, exit_code FROM runs WHERE run_id=?", (rid,)).fetchone()

    def patched_kill(self, kill_side_effect=None, status_values=(None,)):
        """Patch the boat calls kill_run uses; returns (kill_mock, status_mock) for assertions."""
        kill = patch.object(api, 'cmd_kill', side_effect=kill_side_effect, return_value={})
        st = patch.object(api, 'cmd_status', side_effect=itertools.chain(status_values, itertools.repeat(status_values[-1])))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        km = self.stack.enter_context(kill)
        sm = self.stack.enter_context(st)
        return km, sm

    def test_kill_confirms_then_marks_killed(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': False, 'status': 'exited', 'exitCode': 143},))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 0)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('bx_1', out.getvalue())
        self.assertIn('offbox release', out.getvalue())
        sm.assert_called_once()
        self.sleep.assert_not_called()

    def test_home_kill_waits_for_delayed_stop_and_clears_quarantine(self):
        self.run_row()
        self.con.execute("UPDATE runs SET command_id='cmd-42'")
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_unknown:run-1','bx_1')")
        self.con.commit()
        km, sm = self.patched_kill()
        def status(*args, **kwargs):
            return {'running': self.elapsed < 15, 'commandId': 'cmd-42'}
        sm.side_effect = status
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertGreaterEqual(self.elapsed, 15)
        self.assertLessEqual(self.elapsed, 17)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='start_unknown:run-1'").fetchone())
        self.assertEqual(err.getvalue().count('waiting up to 40 s'), 1)

    def test_kill_404_on_third_poll_confirms_stop(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': True}, {'running': True}, None))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(sm.call_count, 3)
        self.assertEqual(self.elapsed, 2)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_lost_mid_poll_keeps_existing_confirmation_rules(self):
        for i, confirmation in enumerate(({'running': False, 'status': 'lost'}, None,
                                          api.OffboxError('confirmation failed'))):
            with self.subTest(confirmation=confirmation):
                rid = f'run-lost-{i}'
                self.run_row(rid)
                km, sm = self.patched_kill(status_values=({'running': True}, {'status': 'lost', 'running': False}))
                with patch.object(runs, 'confirmed_lost', side_effect=(
                        confirmation if isinstance(confirmation, Exception) else None),
                        return_value=confirmation) as confirm, contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    expected = 0 if isinstance(confirmation, dict) else 1
                    self.assertEqual(misc.kill_run(rid), expected)
                self.assertEqual(sm.call_count, 2)
                self.assertEqual(confirm.call_args.args, ('bx_1', rid))
                self.assertLessEqual(confirm.call_args.kwargs['timeout'], 39)
                km.assert_called_once_with('bx_1', 42)
                self.assertEqual(self.status_of(rid)['status'], 'running' if expected else 'killed')

    def test_status_errors_are_retried_until_stop(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=(api.OffboxError('GET one'), api.OffboxError('GET two'),
                                                  {'running': False}))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(sm.call_count, 3)
        self.assertEqual(self.elapsed, 2)
        km.assert_called_once_with('bx_1', 42)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_kill_rerun_settles_after_previous_confirmation_timed_out(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=({'running': True},))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
            self.assertEqual(self.status_of('run-1')['status'], 'running')
            elapsed = self.elapsed
            self.sleep.reset_mock()
            sm.side_effect = None
            sm.return_value = {'running': False}
            sm.reset_mock()
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(self.elapsed, elapsed)
        self.sleep.assert_not_called()
        sm.assert_called_once()
        self.assertEqual(km.call_args_list, [call('bx_1', 42), call('bx_1', 42)])
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_cli_still_running_returns_failure_after_bound(self):
        self.run_row(owner=self.me['owner'])
        km, sm = self.patched_kill(status_values=({'running': True},))
        err = io.StringIO()
        with patch.object(identity, 'whoami', return_value=dict(self.me, proven=True)), \
                patch.object(home, 'person_gate'), patch.object(cli, 'log'), contextlib.redirect_stderr(err):
            self.assertEqual(cli.main(['kill', 'run-1']), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('still reports it running after 40 s', err.getvalue())
        self.assertIn('offbox kill run-1` (safe to repeat)', err.getvalue())
        self.assertIn('offbox logs run-1', err.getvalue())
        km.assert_called_once_with('bx_1', 42)
        self.assertGreater(sm.call_count, 1)
        for poll in sm.call_args_list:
            self.assertEqual(poll.kwargs['retries'], 0)
            self.assertLessEqual(poll.kwargs['timeout'], 5)

    def test_slow_get_errors_cannot_extend_confirmation_bound(self):
        self.run_row()
        _, sm = self.patched_kill()
        def timeout(*args, **kwargs):
            self.advance(kwargs['timeout'])
            raise api.OffboxError('GET timed out')
        sm.side_effect = timeout
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('could not read process', err.getvalue())
        self.assertIn('GET timed out', err.getvalue())

    def test_kill_status_none_counts_as_confirmed(self):
        self.run_row()
        self.patched_kill(status_values=(None,))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(self.status_of('run-1')['status'], 'killed')

    def test_unconfirmed_kill_leaves_row_running(self):
        self.run_row()
        self.patched_kill(status_values=({'running': True, 'status': 'running'},))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = misc.kill_run('run-1')
        self.assertEqual(rc, 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertIn('still reports', err.getvalue())

    def test_status_error_leaves_row_running(self):
        self.run_row()
        km, sm = self.patched_kill(status_values=(api.OffboxError('status boom'),))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.elapsed, 40)
        self.assertGreater(sm.call_count, 1)
        km.assert_called_once_with('bx_1', 42)
        self.assertIn('could not read process', err.getvalue())
        self.assertIn('status boom', err.getvalue())
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_empty_or_unknown_status_never_marks_killed(self):
        # An empty successful response ({}) or one without a running field is not proof the process stopped.
        for i, bogus in enumerate(({}, {'status': 'running'}, {'exitCode': 143},
                                   {'running': 0}, {'running': None}, {'running': 'false'})):
            with self.subTest(status=bogus):
                rid = f'run-bogus-{i}'
                self.run_row(rid)
                self.patched_kill(status_values=(bogus,))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    self.assertEqual(misc.kill_run(rid), 1)
                self.assertEqual(self.status_of(rid)['status'], 'running')
                self.assertIn('row left as running', err.getvalue())
                self.assertEqual(self.elapsed, 40 * (i + 1))

    def test_delete_error_then_404_confirms_stop(self):
        # DELETE timed out but the process is gone: the follow-up GET returning 404 is the accepted confirmation.
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'), status_values=(None,))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertIn('kill request failed', out.getvalue())

    def test_delete_error_with_still_running_leaves_row_running(self):
        self.run_row()
        self.patched_kill(kill_side_effect=api.OffboxError('DELETE timed out'),
                          status_values=({'running': True, 'status': 'running'},))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')

    def test_local_and_no_process_rows_refused(self):
        self.run_row('run-local', box=None, pid=None, mode='local')
        self.run_row('run-nopid', box='bx_1', pid=None, mode='fg')
        self.run_row('run-nobox', box=None, pid=None, mode='bg')
        km, _ = self.patched_kill()
        for rid in ('run-local', 'run-nopid', 'run-nobox'):
            with self.assertRaises(api.OffboxError):
                misc.kill_run(rid)
        km.assert_not_called()
        self.assertEqual(self.status_of('run-nopid')['status'], 'running')

    def test_prestart_live_client_is_stopped_without_boat(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        # Reap our child as the real client's tool-call parent would.
        waiter = threading.Thread(target=child.wait)
        waiter.start()
        self.addCleanup(waiter.join, 5)
        self.addCleanup(cleanup)
        self.run_row(pid=None, status='starting', start=now(), client=child.pid,
                     owner=self.me['owner'], remote_dir='w/repo-907')
        km, sm = self.patched_kill(kill_side_effect=AssertionError('boat kill'),
                                   status_values=(AssertionError('boat status'),))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(misc.kill_run('run-1', self.me), 0)
        waiter.join(timeout=5)
        self.assertFalse(waiter.is_alive())
        self.assertEqual(child.returncode, -signal.SIGTERM)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        row = self.con.execute("SELECT error, end_at FROM runs WHERE run_id='run-1'").fetchone()
        self.assertEqual(row['error'], 'cancelled before the command started (client stopped by offbox kill)')
        self.assertIsNotNone(row['end_at'])
        km.assert_not_called()
        sm.assert_not_called()
        self.start_check.assert_called_once_with('bx_1', 'run-1', claim=True)
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 0)
        for text in ('before its command started', str(child.pid), 'bx_1', 'offbox release',
                     'partial upload', 'w/repo-907'):
            self.assertIn(text, output.getvalue())

    def test_prestart_dead_missing_or_reused_client_is_not_signalled(self):
        for i, (box, client) in enumerate((('bx_1', None), ('bx_1', 12345), (None, 12345))):
            with self.subTest(box=box, client=client):
                rid = f'run-dead-{i}'
                self.run_row(rid, box=box, pid=None, status='starting', client=client)
                with patch.object(misc, '_client_alive', return_value=False), patch.object(os, 'kill') as kill, \
                        patch.object(os, 'killpg') as killpg:
                    with self.assertRaisesRegex(api.OffboxError, 'its client is gone; `offbox reap`'):
                        misc.kill_run(rid)
                kill.assert_not_called()
                killpg.assert_not_called()
                self.assertEqual(self.status_of(rid)['status'], 'starting')

    def test_prestart_pid_reuse_check(self):
        self.run_row(pid=None, client=12345, start=now() - 60)
        with patch.object(misc, '_pid_started_at', return_value=now()), patch.object(os, 'kill') as kill:
            with self.assertRaisesRegex(api.OffboxError, 'offbox reap'):
                misc.kill_run('run-1')
        kill.assert_called_once_with(12345, 0)

    def test_prestart_other_owner_and_unproven_caller_refused_before_signal(self):
        self.run_row(pid=None, client=12345, owner='someone-else')
        with patch.object(misc, '_client_alive') as alive, patch.object(os, 'kill') as kill:
            with self.assertRaisesRegex(api.OffboxError, 'another caller'):
                misc.kill_run('run-1', self.me)
            with self.assertRaisesRegex(api.OffboxError, 'proven'):
                misc.kill_run('run-1', dict(self.me, proven=False))
        alive.assert_not_called()
        kill.assert_not_called()

    def test_prestart_signal_races_with_remote_start(self):
        self.run_row(pid=None, client=12345)
        km, sm = self.patched_kill(status_values=({'running': True, 'commandId': 'cmd-99'}, {'running': False}))
        def stop(pid, start):
            self.con.execute("UPDATE runs SET process_id=99, command_id='cmd-99', status='running' WHERE run_id='run-1'")
            self.con.commit()
            return True
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        km.assert_called_once_with('bx_1', 99)
        self.assertEqual(sm.call_args_list, [call('bx_1', 99),
                                            call('bx_1', 99, timeout=5, retries=0, deadline=ANY)])
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))

    def test_prestart_settlement_is_guarded_against_late_process_id(self):
        self.run_row(pid=None, client=12345)
        km, sm = self.patched_kill(status_values=({'running': True, 'commandId': 'cmd-99'}, {'running': False}))
        read = misc._run_row
        calls = 0
        def read_then_start(rid):
            nonlocal calls
            row = read(rid)
            calls += 1
            if calls == 2:
                self.con.execute("UPDATE runs SET process_id=99, command_id='cmd-99', status='running' WHERE run_id=?", (rid,))
                self.con.commit()
            return row
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', return_value=True), \
                patch.object(misc, '_run_row', side_effect=read_then_start), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        km.assert_called_once_with('bx_1', 99)
        self.assertEqual(sm.call_args_list, [call('bx_1', 99),
                                            call('bx_1', 99, timeout=5, retries=0, deadline=ANY)])
        self.assertIsNone(read('run-1')['error'])

    def test_prestart_client_handler_settles_first(self):
        self.run_row(pid=None, client=12345)
        def stop(pid, start):
            self.con.execute("UPDATE runs SET status='killed', exit_code=130, end_at=? WHERE run_id='run-1'", (now(),))
            self.con.commit()
            return True
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.start_check.assert_not_called()

    def test_prestart_other_terminal_status_is_preserved(self):
        self.run_row(pid=None, client=12345)
        def stop(pid, start):
            self.con.execute("UPDATE runs SET status='done', exit_code=0 WHERE run_id='run-1'")
            self.con.commit()
            return True
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 0)
        self.assertEqual(tuple(self.status_of('run-1')), ('done', 0))

    def test_prestart_unstoppable_client_keeps_reservation(self):
        self.run_row(pid=None, client=12345)
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', return_value=False), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.assertEqual(self.status_of('run-1')['status'], 'running')
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)

    def test_prestart_group_signals_and_escalation_are_safe(self):
        # group leader, ordinary child, and the caller's own group must have distinct signal targets.
        for pgid, own_group, expected in ((12345, 54321, True), (54321, 54321, False), (12345, 12345, False)):
            with self.subTest(pgid=pgid, own_group=own_group):
                clock = [0.0]
                alive = [True]
                def signal_pid(pid, sig):
                    if sig == signal.SIGKILL:
                        alive[0] = False
                def signal_group(group, sig):
                    if sig == signal.SIGKILL:
                        alive[0] = False
                with patch.object(misc, '_client_alive', side_effect=lambda *a: alive[0]), \
                        patch.object(os, 'kill', side_effect=signal_pid) as kill, \
                        patch.object(os, 'killpg', side_effect=signal_group) as killpg, \
                        patch.object(os, 'getpgid', return_value=pgid), patch.object(os, 'getpgrp', return_value=own_group), \
                        patch.object(misc.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(misc.time, 'sleep', side_effect=lambda dt: clock.__setitem__(0, clock[0] + dt)):
                    self.assertTrue(misc._stop_run_client(12345, now()))
                if expected:
                    self.assertEqual(kill.call_args_list, [call(12345, signal.SIGTERM)])
                    self.assertEqual(killpg.call_args_list, [call(12345, signal.SIGTERM),
                                                            call(12345, signal.SIGKILL)])
                else:
                    killpg.assert_not_called()
                    self.assertEqual(kill.call_args_list, [call(12345, signal.SIGTERM),
                                                          call(12345, signal.SIGKILL)])
                self.assertGreaterEqual(clock[0], 10)
                self.assertLess(clock[0], 11)

    def test_prestart_reused_pid_before_signal_is_not_touched(self):
        with patch.object(misc, '_client_alive', return_value=False), patch.object(os, 'kill') as kill, \
                patch.object(os, 'killpg') as killpg:
            self.assertTrue(misc._stop_run_client(12345, now()))
        kill.assert_not_called()
        killpg.assert_not_called()

    def test_prestart_pid_reused_while_waiting_is_not_escalated(self):
        clock = [0.0]
        with patch.object(misc, '_client_alive', side_effect=lambda *a: clock[0] < 5), \
                patch.object(os, 'kill') as kill, patch.object(os, 'killpg') as killpg, \
                patch.object(os, 'getpgid', return_value=54321), patch.object(os, 'getpgrp', return_value=54321), \
                patch.object(misc.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(misc.time, 'sleep', side_effect=lambda dt: clock.__setitem__(0, clock[0] + dt)):
            self.assertTrue(misc._stop_run_client(12345, now()))
        kill.assert_called_once_with(12345, signal.SIGTERM)
        killpg.assert_not_called()

    def test_prestart_unrecorded_start_outcomes(self):
        # Cover the whole #680 evidence class: fence, running wrapper, ended receipt, and uncertain/legacy starts.
        cases = (
            ('fenced', start_check.Result('fenced'), True, 0, ('killed', 143), 0),
            ('running', start_check.Result('started', pid=99), True, 1, ('starting', None), 1),
            ('receipt-ok', start_check.Result('started', code=0, pid=4242), True, 0, ('done', 0), 0),
            ('receipt-failed', start_check.Result('started', code=7, pid=4242), True, 0, ('failed', 7), 0),
            ('unknown', start_check.Result(), True, 1, ('starting', None), 1),
            ('unknown-with-pid', start_check.Result(pid=99), True, 1, ('starting', None), 1),
            ('running-unknown', start_check.Result(), True, 1, ('starting', None), 1),
            ('started-no-pid', start_check.Result('started'), True, 1, ('starting', None), 1),
            ('legacy', start_check.Result(), False, 1, ('starting', None), 1),
            ('legacy-with-pid', start_check.Result(pid=99), False, 1, ('starting', None), 1),
        )
        for name, result, claim, rc, expected, reserved in cases:
            with self.subTest(outcome=name):
                rid = f'run-{name}'
                self.run_row(rid, pid=None, client=12345,
                             status='running' if name == 'running-unknown' else 'starting', claim=claim)
                km, sm = self.patched_kill(status_values=({'running': False},))
                self.start_check.return_value = result
                output, err = io.StringIO(), io.StringIO()
                with patch.object(misc, '_client_alive', return_value=True), \
                        patch.object(misc, '_stop_run_client', return_value=True), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(err):
                    self.assertEqual(misc.kill_run(rid), rc)
                self.start_check.assert_called_with('bx_1', rid, claim=claim)
                self.assertEqual(tuple(self.status_of(rid)), expected)
                self.assertIsNone(self.con.execute("SELECT process_id FROM runs WHERE run_id=?", (rid,)).fetchone()[0])
                km.assert_not_called()
                sm.assert_not_called()
                if name != 'fenced':
                    self.assertNotIn('nothing ran', output.getvalue())
                if reserved:
                    self.assertIn('reservation kept', err.getvalue())
                self.assertEqual(lease.active_runs(self.con, 'bx_1'), reserved)
                self.assertEqual(self.con.execute("SELECT COUNT(*) FROM kv WHERE k=?", (f'start_unknown:{rid}',)).fetchone()[0],
                                 reserved)
                if reserved:
                    # The one-hour legacy fallback may settle the row without proving remote termination.
                    self.con.execute("UPDATE runs SET status='infra' WHERE run_id=?", (rid,))
                    self.con.commit()
                    self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)
                self.con.execute("DELETE FROM runs WHERE run_id=?", (rid,))
                self.con.commit()

    def test_prestart_reconciliation_lock_failure_keeps_reservation(self):
        self.run_row(pid=None, client=12345, status='starting')
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', return_value=True), \
                patch.object(misc, 'file_lock', side_effect=api.OffboxError('box busy')), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        self.start_check.assert_not_called()
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)
        self.con.execute("UPDATE runs SET status='infra' WHERE run_id='run-1'")
        self.con.commit()
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)

    def test_prestart_recorded_id_race_keeps_normal_remote_recovery(self):
        self.run_row(pid=None, client=12345, status='starting')
        km, _ = self.patched_kill(status_values=({'running': True, 'commandId': 'cmd-1001'}, {'running': True}))
        read = misc._run_row
        reads = 0
        def record_id(rid):
            nonlocal reads
            reads += 1
            if reads == 3:
                self.con.execute("UPDATE runs SET process_id=1001, command_id='cmd-1001', status='running' WHERE run_id=?", (rid,))
                self.con.commit()
            return read(rid)
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', return_value=True), \
                patch.object(misc, '_run_row', side_effect=record_id), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1'), 1)
        km.assert_called_once_with('bx_1', 1001)
        self.start_check.assert_not_called()
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='start_unknown:run-1'").fetchone())
        self.con.execute("UPDATE runs SET status='done', exit_code=0 WHERE run_id='run-1'")
        self.con.commit()
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 0)

    def test_prestart_concurrently_recovered_wrapper_pid_is_not_an_api_id(self):
        for at_read in (2, 3, 4, 5):
            with self.subTest(recovery_at_read=at_read):
                rid = f'run-recovered-{at_read}'
                self.run_row(rid, pid=None, client=12345, status='starting')
                km, sm = self.patched_kill(kill_side_effect=AssertionError('wrong API command ID'),
                                           status_values=(AssertionError('wrong API command ID'),))
                read = misc._run_row
                reads = 0
                def recover_pid(run_id):
                    nonlocal reads
                    reads += 1
                    if reads == at_read:
                        self.con.execute("UPDATE runs SET process_id=4242, status='running' WHERE run_id=?", (run_id,))
                        self.con.commit()
                    return read(run_id)
                with patch.object(misc, '_client_alive', return_value=True), \
                        patch.object(misc, '_stop_run_client', return_value=True), \
                        patch.object(misc, '_run_row', side_effect=recover_pid), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 1)
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 1)
                km.assert_not_called()
                sm.assert_not_called()
                self.assertEqual(self.status_of(rid)['status'], 'running')
                self.con.execute("UPDATE runs SET status='infra' WHERE run_id=?", (rid,))
                self.con.commit()
                self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)
                self.con.execute("DELETE FROM runs WHERE run_id=?", (rid,))
                self.con.commit()

    def test_prestart_api_id_provenance_failure_never_sends_kill(self):
        for i, status in enumerate((None, {}, {'commandId': 'other-command'}, api.OffboxError('status failed'))):
            with self.subTest(status=status):
                rid = f'run-id-proof-{i}'
                self.run_row(rid, pid=None, client=12345, status='starting')
                km, sm = self.patched_kill(kill_side_effect=AssertionError('unproven API ID'), status_values=(status, status))
                def stop(pid, start):
                    self.con.execute("UPDATE runs SET process_id=4242, command_id='cmd-1001', status='running' "
                                     "WHERE run_id=?", (rid,))
                    self.con.commit()
                    return True
                with patch.object(misc, '_client_alive', return_value=True), \
                        patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 1)
                    self.assertEqual(misc.kill_run(rid), 1)
                km.assert_not_called()
                self.assertEqual(sm.call_args_list, [call('bx_1', 4242), call('bx_1', 4242)])
                self.assertEqual(self.status_of(rid)['status'], 'running')
                self.con.execute("UPDATE runs SET status='infra' WHERE run_id=?", (rid,))
                self.con.commit()
                self.assertEqual(lease.active_runs(self.con, 'bx_1'), 1)
                self.con.execute("DELETE FROM runs WHERE run_id=?", (rid,))
                self.con.commit()

    def test_prestart_concurrent_recovery_proof_releases_quarantine(self):
        for name, result, expected in (
                ('fenced', start_check.Result('fenced'), ('lost', None)),
                ('completed', start_check.Result('started', code=0, pid=4242), ('done', 0)),
                ('failed', start_check.Result('started', code=7, pid=4242), ('failed', 7))):
            with self.subTest(proof=name):
                rid = f'run-proof-{name}'
                self.run_row(rid, pid=None, client=12345, status='starting')
                km, sm = self.patched_kill(kill_side_effect=AssertionError('remote kill'),
                                           status_values=(AssertionError('remote status'),))
                def stop(pid, start):
                    self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?, 'bx_1')", (f'start_unknown:{rid}',))
                    self.con.commit()
                    row = misc._run_row(rid)
                    start_check.settle(self.con, row, result, 'concurrent reap')
                    return True
                with patch.object(misc, '_client_alive', return_value=True), \
                        patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(misc.kill_run(rid), 0)
                self.assertEqual(tuple(self.status_of(rid)), expected)
                self.assertEqual(lease.active_runs(self.con, 'bx_1'), 0)
                self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k=?", (f'start_unknown:{rid}',)).fetchone())
                km.assert_not_called()
                sm.assert_not_called()

    def test_overlapping_prestart_cancellations_do_not_leave_quarantine(self):
        self.run_row(pid=None, client=12345, status='starting', owner=self.me['owner'])
        km, sm = self.patched_kill(kill_side_effect=AssertionError('remote kill'),
                                   status_values=(AssertionError('remote status'),))
        inner_results = []
        def stop(pid, start):
            # The second caller finishes while the first caller is still waiting for the client to exit.
            with patch.object(misc, '_stop_run_client', return_value=True):
                inner_results.append(misc.kill_run('run-1', self.me))
            return True
        with patch.object(misc, '_client_alive', return_value=True), \
                patch.object(misc, '_stop_run_client', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-1', self.me), 0)
        self.assertEqual(inner_results, [0])
        self.assertEqual(tuple(self.status_of('run-1')), ('killed', 143))
        self.assertEqual(lease.active_runs(self.con, 'bx_1'), 0)
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='start_unknown:run-1'").fetchone())
        km.assert_not_called()
        sm.assert_not_called()

    def test_prestart_box_lock_covers_final_update_and_is_released(self):
        for fail in (False, True):
            with self.subTest(update_fails=fail):
                rid = f'run-lock-{fail}'
                self.run_row(rid, pid=None, client=12345, status='starting')
                con, seen = self.con, []
                test = self
                class Probe:
                    def execute(self, sql, *args):
                        if sql.startswith("UPDATE runs SET status='killed'"):
                            seen.append(True)
                            with test.assertRaisesRegex(api.OffboxError, 'timed out waiting for lock'):
                                with common.file_lock('box-bx_1', timeout=0):
                                    pass
                            if fail:
                                raise api.OffboxError('settlement failed')
                        return con.execute(sql, *args)

                    def __getattr__(self, name):
                        return getattr(con, name)
                with patch.object(misc, 'db', return_value=Probe()), \
                        patch.object(misc, '_client_alive', return_value=True), \
                        patch.object(misc, '_stop_run_client', return_value=True), contextlib.redirect_stdout(io.StringIO()):
                    if fail:
                        with self.assertRaisesRegex(api.OffboxError, 'settlement failed'):
                            misc.kill_run(rid)
                    else:
                        self.assertEqual(misc.kill_run(rid), 0)
                self.assertEqual(seen, [True])
                with common.file_lock('box-bx_1', timeout=0):
                    pass

    def test_settled_row_refused(self):
        self.run_row('run-done', status='done')
        km, _ = self.patched_kill()
        with self.assertRaises(api.OffboxError):
            misc.kill_run('run-done')
        km.assert_not_called()

    def test_release_refusal_names_runs_and_suggests_kill(self):
        self.box('bx_busy')
        self.run_row('run-hung', box='bx_busy', pid=7)
        r = self.con.execute("SELECT * FROM leases WHERE box_id='bx_busy'").fetchone()
        err = io.StringIO()
        with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
            misc._release_one(self.con, r, False)
        self.assertIn('run-hung', err.getvalue())
        self.assertIn('offbox kill <run>', err.getvalue())

    def test_public_release_names_runs_when_box_lock_is_held(self):
        # A streaming foreground run holds box-<id>; public release must still name the hung run and suggest kill.
        self.box('bx_held')
        self.run_row('run-streaming', box='bx_held', pid=9)
        held = common.file_lock('box-bx_held', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_held', False, False)
            self.assertIn('run-streaming', err.getvalue())
            self.assertIn('offbox kill <run>', err.getvalue())
            self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='bx_held'").fetchone()[0],
                             'running')
        finally:
            held.__exit__(None, None, None)

    def test_public_release_busy_lock_without_runs_is_not_run_hint(self):
        self.box('bx_busy2')
        held = common.file_lock('box-bx_busy2', timeout=0)
        held.__enter__()
        try:
            err = io.StringIO()
            with patch.object(misc, 'db', return_value=self.con), contextlib.redirect_stderr(err):
                misc.release(self.me, 'bx_busy2', False, False)
            self.assertIn('box is busy', err.getvalue())
            self.assertNotIn('offbox kill', err.getvalue())
        finally:
            held.__exit__(None, None, None)

    def test_reaper_marks_old_nobox_rows_lost_only(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='bg', start=now() - 3 * 3600)
        self.run_row('run-new-nobox', box=None, pid=None, mode='fg', start=now() - 600)
        self.run_row('run-old-boxed', box='bx_9', pid=5, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, False, actions)
        old = self.status_of('run-old-nobox')
        self.assertEqual(old['status'], 'lost')
        row = self.con.execute("SELECT error FROM runs WHERE run_id='run-old-nobox'").fetchone()
        self.assertEqual(row['error'], 'client ended before it got a box')
        self.assertEqual(self.status_of('run-new-nobox')['status'], 'running')
        self.assertEqual(self.status_of('run-old-boxed')['status'], 'running')
        self.assertTrue(any('run-old-nobox' in a for a in actions))

    def test_reaper_dry_run_writes_nothing(self):
        self.run_row('run-old-nobox', box=None, pid=None, mode='fg', start=now() - 3 * 3600)
        self.stack.enter_context(patch.object(api, 'list_boxes', return_value=[]))
        actions = []
        reap._reap(self.con, True, actions)
        self.assertEqual(self.status_of('run-old-nobox')['status'], 'running')
        self.assertTrue(any('would mark no-box run run-old-nobox' in a for a in actions))


if __name__ == '__main__':
    unittest.main()
