"""Offline settled-log recovery, including independent stream offsets and large retained histories."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, misc, pool, reap, runs
from offbox_lib.common import OffboxError
from test_capacity import Isolated

HISTORY_LOGS = api.history_logs


class LogCatchupTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.stack.enter_context(patch.object(api, 'get', return_value=dict(state='archived')))
        self.stack.enter_context(patch.object(runs.lease, 'touch'))
        self.stack.enter_context(patch.object(runs.lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.history = self.stack.enter_context(patch.object(api, 'history_logs'))
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,exit_code,pulls,start_at) "
                         "VALUES ('run-x','bx_a','cmd_a',7,'done','bg',0,'[]',900)")
        self.con.commit()
        self.path = common.LOGS_DIR / 'run-x.log'
        self.prefix(b'prefix\n')
        self.streams(b'prefix\nrest\n', b'')

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone()

    def state(self, status, code):
        self.con.execute("UPDATE runs SET status=?,exit_code=? WHERE run_id='run-x'", (status, code))
        self.con.commit()

    def prefix(self, data, out=None, err=0):
        self.path.write_bytes(data)
        common.atomic_write_json(common.offsets_path(self.path),
                                 dict(stdoutOffset=len(data) if out is None else out,
                                      stderrOffset=err, logBytes=len(data)))

    def streams(self, stdout, stderr, page=4096):
        def history(box, cmd, which, offset, **kwargs):
            self.assertEqual((box, cmd), ('bx_a', 'cmd_a'))
            self.assertIn('deadline', kwargs)
            source = stdout if which == 'stdout' else stderr
            data = source[offset:offset + page]
            nxt = offset + len(data)
            return dict(data=data.decode(), nextOffset=nxt, size=len(source), done=nxt == len(source))
        self.history.side_effect = history

    def invoke(self, wait=False, follow=False):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = misc.wait('run-x', None) if wait else misc.logs('run-x', follow)
        return code, out.getvalue(), err.getvalue()

    def test_logs_completes_and_repeated_logs_do_not_duplicate(self):
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=12, stderrOffset=0, logBytes=12))
        self.history.reset_mock()
        inode = self.path.stat().st_ino
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual([c.args[3] for c in self.history.call_args_list], [12, 0])
        self.assertEqual(self.path.stat().st_ino, inode)

    def test_wait_completes_and_preserves_exit_code(self):
        self.state('failed', 7)
        code, out, err = self.invoke(wait=True)
        self.assertEqual(code, 7)
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
        self.assertIn('failed exit=7', out)
        self.assertEqual(err, '')

    def test_logs_and_stuck_wait_replay_failure_advice(self):
        for content, expected in (
                ('offbox: node v24.22.3 (box default)\n'
                 '/home/user/.nvm/nvm.sh: No such file or directory\n',
                 'your command sourced ~/.nvm/nvm.sh'),
                (runs.NO_NODE_MODULES_MARKER + '\n' + runs.DEPS_INSTALL_MARKER + '[1, "npm ci"]\n',
                 'its own install step (npm ci)')):
            for code, steps in ((1, []), (127, []), (127, [(1, 127), (2, 0)])):
                for entry in ('logs', 'wait', 'stuck'):
                    with self.subTest(entry=entry, expected=expected, code=code, steps=steps):
                        self.state('failed', code)
                        self.con.execute("UPDATE runs SET step_count=? WHERE run_id='run-x'", (len(steps),))
                        self.con.commit()
                        data = (content + ''.join(f'offbox step {n} rc={rc}: check\n' for n, rc in steps)).encode()
                        self.prefix(data)
                        self.streams(data, b'')
                        if entry != 'stuck':
                            _, _, err = self.invoke(wait=entry == 'wait')
                        else:
                            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as output:
                                self.assertEqual(misc._holder_stuck(
                                    self.row(), {'status': 'exited', 'exitCode': code}, self.path, 0, False), code)
                            err = output.getvalue()
                        wanted = code != 127 or 'your command sourced' in expected
                        self.assertEqual(err.count(expected), int(wanted), err)
                        if 'your command sourced' in expected:
                            self.assertNotIn('node_modules', err)

    def test_partial_step_failure_hint_uses_received_or_recovered_output(self):
        self.con.execute("UPDATE runs SET step_count=2 WHERE run_id='run-x'")
        self.con.commit()
        for recovered in (False, True):
            for complete in (False, True):
                for entry in ('logs', 'wait', 'stuck'):
                    with self.subTest(recovered=recovered, complete=complete, entry=entry):
                        self.state('failed', 127)
                        content = ('offbox: node v24.22.1 (box default)\n'
                                   '/home/user/.nvm/nvm.sh: No such file or directory\n'
                                   + runs.NO_NODE_MODULES_MARKER + '\n'
                                   'offbox step 1 rc=127: hidden script\n'
                                   + ('offbox step 2 rc=0: later\n' if complete else ''))
                        self.prefix(b'prefix\n' if recovered else content.encode())
                        if recovered:
                            Path(str(self.path) + '.remote').write_text(content)
                            common.atomic_write_json(Path(str(self.path) + '.remote.json'),
                                                     dict(source='process log', merged=True))
                        with patch.object(misc, '_catch_up_log', return_value='complete'):
                            if entry != 'stuck':
                                code, _, err = self.invoke(wait=entry == 'wait')
                            else:
                                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as output:
                                    code = misc._holder_stuck(self.row(), {'status': 'exited', 'exitCode': 127},
                                                              self.path, 0, False)
                                err = output.getvalue()
                        self.assertEqual(code, (0 if entry == 'logs' else 127) if complete else 90)
                        self.assertEqual(err.count('your command sourced ~/.nvm/nvm.sh'), 1, err)
                        self.assertEqual('steps incomplete:' in err, not complete)
                        self.assertNotIn('node_modules', err)

    def test_detached_recovery_places_setup_before_command_output(self):
        preamble = b'offbox: node v24.22.1\noffbox: pnpm v11.10.0\noffbox-command-started: run-x\n'
        stdout = b'pytest failure details\n20 failed, 3 passed\n'
        stderr = preamble + b'command error\n'
        self.path.write_bytes(b'')
        common.offsets_path(self.path).unlink(missing_ok=True)
        self.streams(stdout, stderr, page=7)
        self.state('failed', 1)
        code, output, errors = self.invoke(wait=True)
        self.assertEqual(code, 1)
        expected = preamble + stdout + b'command error\n'
        self.assertEqual(self.path.read_bytes(), expected)
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=len(stdout), stderrOffset=len(stderr),
                                                           logBytes=len(expected)))
        self.assertIn(expected.decode(), output)
        self.assertEqual(errors, '')
        self.assertNotIn('pytest failure details', self.invoke(wait=True)[1])

    def test_uncommitted_suffix_is_removed_before_appending(self):
        with self.path.open('ab') as f:
            f.write(b'rest\nuncommitted')
        self.assertEqual(self.invoke(), (0, 'prefix\nrest\n', ''))
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')

    def test_history_error_leaves_original_and_warns(self):
        ck = common.offsets_path(self.path).read_bytes()
        self.history.side_effect = OffboxError('history unavailable')
        code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertIn("local log stops at 7 bytes", err)
        self.assertIn('history unavailable', err)
        self.assertIn('output is incomplete', err)
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.assertFalse(list(self.path.parent.glob('*.catchup.*')))
        self.assertEqual(self.invoke(wait=True)[0], 0)

    def test_incomplete_step_warnings_never_repeat_a_recorded_zero(self):
        self.con.execute("UPDATE runs SET step_count=2 WHERE run_id='run-x'")
        self.con.commit()
        self.prefix(b'offbox step 1 rc=0: first\n')
        for result in ('complete', 'caught_up', 'n/a', 'incomplete:history unavailable', 'incomplete:timeout'):
            for reader in ('logs', 'logs-follow', 'wait'):
                with self.subTest(result=result, reader=reader):
                    self.state('done', 0)
                    with patch.object(api, 'BACKEND', 'server'), \
                            patch.object(misc, '_catch_up_log', return_value=result):
                        for _ in range(2):
                            code, out, err = self.invoke(wait=reader == 'wait', follow=reader == 'logs-follow')
                            self.assertEqual(code, 90)
                            self.assertIn('steps incomplete: got 1 of 2 step results', err)
                            self.assertNotIn('done exit=0', out + err)
                            self.assertNotIn('remote exit 0', out + err)

    def test_step_history_timeout_never_describes_a_recorded_zero_as_validated(self):
        self.con.execute("UPDATE runs SET step_count=2 WHERE run_id='run-x'")
        self.con.commit()
        for complete_prefix in (False, True):
            with self.subTest(complete_prefix=complete_prefix):
                self.state('done', 0)
                data = b'offbox step 1 rc=0: first\n'
                if complete_prefix:
                    data += b'offbox step 2 rc=0: second\n'
                self.prefix(data)
                clock = [1000]
                def timeout(*args, **kwargs):
                    clock[0] = 1002
                    return 'incomplete:timeout'
                out, err = io.StringIO(), io.StringIO()
                with patch.object(api, 'BACKEND', 'server'), \
                        patch.object(misc, 'now', side_effect=lambda: clock[0]), \
                        patch.object(misc, '_catch_up_log', side_effect=timeout), \
                        contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    with self.assertRaises(OffboxError) as raised:
                        misc.wait('run-x', 1)
                self.assertEqual(raised.exception.code, common.EXIT_WAIT_TIMEOUT)
                self.assertIn('steps incomplete:', err.getvalue())
                report = out.getvalue() + err.getvalue() + str(raised.exception)
                self.assertNotIn('done exit=0', report)
                self.assertNotIn('remote exit 0', report)

    def test_wait_replays_failure_recovered_from_a_recorded_zero(self):
        self.con.execute("UPDATE runs SET step_count=1 WHERE run_id='run-x'")
        self.con.commit()
        failure = b'actual failed assertion\noffbox step 1 rc=7: check\n'
        self.prefix(failure)
        self.streams(failure, b'')
        code, output, errors = self.invoke(wait=True)
        self.assertEqual(code, 7)
        self.assertIn(failure.decode(), output)
        self.assertIn('failed exit=7', output)
        self.assertNotIn('actual failed assertion', self.invoke(wait=True)[1])

    def test_failure_tail_stops_at_sampled_size_when_history_grows(self):
        self.path.write_bytes(b'x' * 20000)
        tail = misc._tail
        def grow(*args, **kwargs):
            with self.path.open('ab') as log:
                log.write(b'late failure\n' * 2000)
            return tail(*args, **kwargs)
        output = io.StringIO()
        with patch.object(misc, '_tail', side_effect=grow), contextlib.redirect_stdout(output):
            misc._failure_tail(self.path)
        self.assertEqual(output.getvalue(), 'x' * 16384)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            misc._failure_tail(self.path)
        self.assertIn('late failure', output.getvalue())
        self.assertLessEqual(len(output.getvalue()), 16384)

    def test_no_checkpoint_does_not_guess_stream_offsets(self):
        common.offsets_path(self.path).unlink()
        code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertIn('no checkpoint', err)
        self.assertIn('output is incomplete', err)
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_box_lock_does_not_block_settled_logs_or_wait(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                self.prefix(b'prefix\n')
                self.streams(b'prefix\nrest\n', b'error\n')
                with common.file_lock('box-bx_a', timeout=0):
                    code, out, err = self.invoke(wait=wait)
                self.assertEqual(code, 0)
                self.assertEqual(self.path.read_bytes(), b'prefix\nrest\nerror\n')
                self.assertIn('done exit=0' if wait else 'rest\nerror\n', out)
                self.assertEqual(err, '')

    def test_held_run_lock_skips_fetch_and_write(self):
        ck = common.offsets_path(self.path).read_bytes()
        with common.file_lock('log-run-x', timeout=0), patch.object(misc, 'LOG_READ_WAIT_S', 0.02):
            self.assertEqual(misc._catch_up_log(self.row()), 'n/a')
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertIn("couldn't be checked against the server and may be incomplete", err)
        self.assertNotIn('box lock', err)
        self.assertNotIn('this output is incomplete', err)
        self.history.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)

    def test_empty_skipped_readback_names_recorded_failure(self):
        self.prefix(b'')
        self.state('failed', 127)
        with common.file_lock('log-run-x', timeout=0), patch.object(misc, 'LOG_READ_WAIT_S', 0.02):
            for wait in (False, True):
                code, out, err = self.invoke(wait=wait)
                self.assertEqual(code, 127 if wait else 1)
                self.assertIn('run ended failed exit=127', err)
                self.assertIn('may be incomplete', err)
                self.assertNotIn('no output', err)
        self.history.assert_not_called()

    def test_wait_timeout_caps_settled_run_lock_wait(self):
        for status, code in (('done', 0), ('failed', 127), ('infra', None)):
            for prefix in (b'', b'prefix\n'):
                with self.subTest(status=status, prefix=prefix):
                    self.prefix(prefix)
                    self.state(status, code)
                    err = io.StringIO()
                    with common.file_lock('log-run-x', timeout=0), contextlib.redirect_stderr(err):
                        started = time.monotonic()
                        with self.assertRaises(OffboxError) as raised:
                            misc.wait('run-x', 0.02)
                        elapsed = time.monotonic() - started
                    self.assertEqual(raised.exception.code, common.EXIT_WAIT_TIMEOUT)
                    self.assertLess(elapsed, 0.25)
                    self.assertIn(f'run ended {status} exit={code}', str(raised.exception))
                    self.assertNotIn('keeps running', str(raised.exception))
                    self.assertIn('may be incomplete', err.getvalue())
                    self.assertNotIn('no output', err.getvalue())
        self.history.assert_not_called()

    def test_skipped_checks_without_history_identity_report_recorded_result(self):
        self.prefix(b'')
        for box, command in ((None, None), ('bx_a', None)):
            for mode in ('bg', 'fg'):
                for status, code in (('done', 0), ('failed', 127), ('infra', None)):
                    with self.subTest(box=box, mode=mode, status=status):
                        self.con.execute("UPDATE runs SET box_id=?,command_id=?,mode=? WHERE run_id='run-x'",
                                         (box, command, mode))
                        self.con.commit()
                        self.state(status, code)
                        with patch.object(api, 'BACKEND', 'server'):
                            for wait in (False, True):
                                actual, out, err = self.invoke(wait=wait)
                                expected = (90 if code is None else code) if wait else (1 if mode == 'bg' else 0)
                                self.assertEqual(actual, expected)
                                self.assertIn(f'run ended {status} exit={code}', err)
                                self.assertIn('server history is unavailable', err)
                                self.assertIn('may be incomplete', err)
                                self.assertNotIn('no output', err)
        self.history.assert_not_called()

    def test_running_writers_preserve_timeout_exit_when_run_lock_is_busy(self):
        self.state('running', None)
        for route in ('follow', 'takeover'):
            with self.subTest(route=route), common.file_lock('log-run-x', timeout=0):
                ck = common.offsets_path(self.path).read_bytes()
                deadline = misc.now() + 0.02
                with self.assertRaises(OffboxError) as raised:
                    if route == 'follow':
                        runs.follow('bx_a', 7, self.path, echo=False, run_id='run-x', until=deadline)
                    else:
                        misc._replay_takeover(self.row(), False, deadline, (7, 0), self.path, 7, True)
                self.assertEqual(raised.exception.code, common.EXIT_WAIT_TIMEOUT)
                self.assertEqual(self.path.read_bytes(), b'prefix\n')
                self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)

    def test_reaper_completes_during_readers_wait(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                self.prefix(b'')
                held, release, done = threading.Event(), threading.Event(), threading.Event()
                errors = []
                row = dict(self.row())
                def reaper():
                    try:
                        with runs.log_lock('run-x'):
                            held.set()
                            if not release.wait(2):
                                raise AssertionError('reader did not wait')
                            self.assertEqual(misc._catch_up_log(row, locked=True), 'caught_up')
                    except BaseException as e:
                        errors.append(e)
                    finally:
                        done.set()
                worker = threading.Thread(target=reaper)
                worker.start()
                self.assertTrue(held.wait(2))
                def finish_reaper(_):
                    release.set()
                    self.assertTrue(done.wait(2))
                self.history.reset_mock()
                try:
                    with patch.object(runs.time, 'sleep', side_effect=finish_reaper):
                        code, out, err = self.invoke(wait=wait)
                finally:
                    release.set()
                    worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(code, 0)
                self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
                self.assertEqual(self.history.call_count, 2)  # Only the reaper fetched the two streams.
                self.assertEqual(err, '')
                if not wait:
                    self.assertEqual(out, 'prefix\nrest\n')

    def test_contended_checkpoint_reuse_requires_identity_and_success_marker(self):
        cases = (
            (None, {}, False),
            (None, dict(settledCheck=1), False),
            (None, dict(settledCommandId=None, settledCheck=1), False),
            ('cmd_a', {}, False),
            ('cmd_a', dict(settledCommandId='cmd_a'), False),
            ('cmd_a', dict(settledCommandId='cmd_a', settledCheck=None), False),
            ('cmd_a', dict(settledCommandId='cmd_a', settledCheck=0), False),
            ('cmd_a', dict(settledCommandId='other', settledCheck=1), False),
            ('cmd_a', dict(settledCommandId='cmd_a', settledCheck=1), True),
        )
        for command, marker, reusable in cases:
            for reader in ('logs', 'logs-follow', 'wait'):
                with self.subTest(command=command, marker=marker, reader=reader):
                    self.prefix(b'prefix\n')
                    self.state('failed', 127)
                    self.con.execute("UPDATE runs SET command_id=? WHERE run_id='run-x'", (command,))
                    self.con.commit()
                    self.history.reset_mock()
                    with contextlib.ExitStack() as holder:
                        holder.enter_context(common.file_lock('log-run-x', timeout=0))
                        def publish(_):
                            self.prefix(b'')
                            ck = common.checkpoint(self.path)
                            common.atomic_write_json(common.offsets_path(self.path), dict(ck, **marker))
                            holder.close()
                        with patch.object(runs.time, 'sleep', side_effect=publish), \
                                patch.object(api, 'BACKEND', 'server'):
                            code, out, err = self.invoke(wait=reader == 'wait', follow=reader == 'logs-follow')
                    self.assertEqual(code, 127 if reader == 'wait' else (1 if reusable or not command else 0))
                    if not command:
                        self.assertIn('server history is unavailable', err)
                        self.assertIn('may be incomplete', err)
                        self.assertIn('run ended failed exit=127', err)
                        self.assertNotIn('no output', err)
                        self.history.assert_not_called()
                    elif reusable:
                        self.assertIn('no output', err)
                        self.assertNotIn('incomplete', err)
                        self.history.assert_not_called()
                    else:
                        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
                        self.assertEqual(self.history.call_count, 2)
                        self.assertEqual(err, '')

    def test_finalization_deadline_reports_the_persisted_result(self):
        finish_run = runs.finish
        for route in ('takeover', 'direct-follow'):
            for mode in ('bg', 'fg'):
                for exit_code in (0, 127):
                    with self.subTest(route=route, mode=mode, exit_code=exit_code):
                        self.prefix(b'')
                        self.state('running', None)
                        self.con.execute("UPDATE runs SET mode=? WHERE run_id='run-x'", (mode,))
                        self.con.commit()
                        clock = [1000.0]
                        out, err = io.StringIO(), io.StringIO()
                        def finish(*args, **kwargs):
                            finish_run(*args, **kwargs)
                            if mode == 'fg':
                                clock[0] = 1011.0
                        def history(*args, **kwargs):
                            clock[0] = 1011.0
                            raise OffboxError('history deadline')
                        self.history.side_effect = history
                        self.history.reset_mock()
                        with patch.object(api, 'BACKEND', 'server'), \
                                patch.object(misc.time, 'time', side_effect=lambda: clock[0]), \
                                patch.object(misc, '_resolve_exit', return_value=exit_code), \
                                patch.object(misc, '_catch_up_finished'), \
                                patch.object(runs, 'finish', side_effect=finish), \
                                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            with self.assertRaises(OffboxError) as raised:
                                if route == 'takeover':
                                    misc._replay_takeover(self.row(), False, 1010, (0, 0), self.path, 0, True)
                                else:
                                    misc._wait_run(self.row(), False, until=1010)
                        status = 'failed' if exit_code else 'done'
                        self.assertEqual((self.row()['status'], self.row()['exit_code']), (status, exit_code))
                        self.assertEqual(raised.exception.code, common.EXIT_WAIT_TIMEOUT)
                        self.assertIn(f'run ended {status} exit={exit_code}', str(raised.exception))
                        self.assertNotIn('keeps running', str(raised.exception))
                        if mode == 'bg':
                            self.assertIn(f'run ended {status} exit={exit_code}', err.getvalue())
                            self.assertIn('this output is incomplete', err.getvalue())
                        self.assertNotIn('no output', err.getvalue())

    def test_maintenance_skips_held_run_lock_and_records_reason(self):
        ck = common.offsets_path(self.path).read_bytes()
        with common.file_lock('log-run-x', timeout=0):
            misc._catch_up_finished(self.con, 'run-x')
        self.history.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        recorded = self.con.execute("SELECT * FROM events WHERE kind='log_catchup_failed'").fetchall()
        self.assertEqual(len(recorded), 1)
        self.assertIn('run log lock held', str(tuple(recorded[0])))

    def test_takeover_and_catchup_cannot_write_together(self):
        held, release = threading.Event(), threading.Event()
        errors = []
        row = dict(self.row())
        def replay(*args, **kwargs):
            held.set()
            if not release.wait(2):
                raise AssertionError('reader did not try catchup')
            return 0
        def takeover():
            try:
                misc._replay_takeover(row, False, None, (7, 0), self.path, 7, has_checkpoint=True)
            except BaseException as e:
                errors.append(e)
        with patch.object(misc, '_resolve_exit', side_effect=replay), patch.object(misc, '_finalize', return_value=0):
            worker = threading.Thread(target=takeover)
            worker.start()
            try:
                self.assertTrue(held.wait(2))
                self.assertEqual(misc._catch_up_log(row, locked=True), 'n/a')
                self.assertEqual(self.path.read_bytes(), b'prefix\n')
            finally:
                release.set()
                worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.history.assert_not_called()

    def test_running_plain_logs_leave_active_followers_log_alone(self):
        for status in ('starting', 'running'):
            with self.subTest(status=status):
                self.state(status, None)
                ck = common.offsets_path(self.path).read_bytes()
                before = self.path.stat()
                with common.file_lock('box-bx_a', timeout=0), patch.object(misc, '_refresh_running_ttl'):
                    code, out, err = self.invoke()
                self.assertEqual((code, out), (0, 'prefix\n'))
                self.assertIn('is still running', err)
                self.assertIn('7 bytes, last written ', err)
                self.assertIn('includes the output fetched so far', err)
                self.assertIn('`offbox wait run-x` using the remote-compute skill', err)
                self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)
                self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.history.assert_not_called()

    def test_running_with_no_local_log_says_never(self):
        self.state('running', None)
        self.path.unlink()
        ck = common.offsets_path(self.path).read_bytes()
        with common.file_lock('box-bx_a', timeout=0), patch.object(misc, '_refresh_running_ttl'):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, ''))
        self.assertIn('0 bytes, last written never', err)
        self.assertFalse(self.path.exists())
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)
        self.history.assert_not_called()

    def test_already_complete_does_not_replace_log(self):
        self.streams(b'prefix\n', b'')
        inode = self.path.stat().st_ino
        self.assertEqual(misc._catch_up_log(self.row()), 'complete')
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertEqual(common.checkpoint(self.path)['logBytes'], 7)

    def test_running_quiet_history_without_size_is_caught_up(self):
        self.state('running', None)
        self.history.side_effect = lambda box, cmd, which, offset, **kw: dict(
            data='', nextOffset=offset, done=False)
        ck = common.offsets_path(self.path).read_bytes()
        before = self.path.stat()
        self.assertEqual(misc._catch_up_log(self.row(), live=True), 'complete')
        with patch.object(misc, '_refresh_running_ttl'):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\n'))
        self.assertNotIn('incomplete', err)
        self.assertEqual([c.args[2:4] for c in self.history.call_args_list],
                         [('stdout', 7), ('stderr', 0)] * 2)
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(self.path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)

    def test_running_history_without_size_appends_and_advances_both_streams(self):
        self.state('running', None)
        streams = dict(stdout='prefix\nrest €\n'.encode(), stderr=b'error\n')
        def history(box, cmd, which, offset, **kw):
            data = streams[which][offset:]
            return dict(data=data.decode(), nextOffset=offset + len(data), done=False)
        self.history.side_effect = history
        self.assertEqual(misc._catch_up_log(self.row(), live=True), 'caught_up')
        expected = streams['stdout'] + streams['stderr']
        self.assertEqual(self.path.read_bytes(), expected)
        self.assertEqual(common.checkpoint(self.path),
                         dict(stdoutOffset=len(streams['stdout']), stderrOffset=len(streams['stderr']),
                              logBytes=len(expected)))
        with patch.object(misc, '_refresh_running_ttl'):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, expected.decode()))
        self.assertNotIn('incomplete', err)

    def test_running_quiet_history_without_size_cannot_hide_uncheckpointed_bytes(self):
        self.state('running', None)
        with self.path.open('ab') as log:
            log.write(b'uncheckpointed\n')
        original = self.path.read_bytes()
        ck = common.offsets_path(self.path).read_bytes()
        self.history.side_effect = lambda box, cmd, which, offset, **kw: dict(
            data='', nextOffset=offset, done=False)
        self.assertEqual(misc._catch_up_log(self.row(), live=True), 'incomplete:history behind local log')
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)

    def test_stderr_only_prefix_with_stdout_zero_and_stderr_tail(self):
        prefix = b'e' * 4082
        tail = b'\n' + b'x' * 53 + b'\noffbox step 2 rc=0\n'
        stdout = b'399/399 stdout\n' * 300
        self.prefix(prefix, out=0, err=4082)
        self.streams(stdout, prefix + tail, page=1000)
        self.state('failed', 1)
        self.assertEqual(self.invoke(wait=True)[0], 1)
        self.assertEqual(self.path.read_bytes(), prefix + stdout + tail)
        self.assertEqual(common.checkpoint(self.path),
                         dict(stdoutOffset=len(stdout), stderrOffset=4082 + len(tail),
                              logBytes=4082 + len(stdout) + len(tail)))
        self.assertEqual([c.args[3] for c in self.history.call_args_list if c.args[2] == 'stderr'], [4082])

    def test_more_than_200_pages_and_settled_follow(self):
        stdout = b'prefix\n' + b'x' * (300 * 4096)
        for follow in (False, True):
            with self.subTest(follow=follow):
                self.prefix(b'prefix\n')
                self.streams(stdout, b'')
                self.history.reset_mock()
                with patch.object(misc.time, 'time', return_value=1000):
                    code, out, err = self.invoke(follow=follow)
                self.assertEqual((code, out, err), (0, stdout.decode(), ''))
                self.assertGreater(self.history.call_count, 300)
                self.assertEqual(self.path.stat().st_size, len(stdout))

    def test_45_mb_tail_has_bounded_memory_and_no_page_cap(self):
        pages = 11_520
        chunk = 'x' * 4096
        size = 7 + pages * 4096
        calls = [0]
        def history(box, cmd, which, offset, **kw):
            calls[0] += 1
            if which == 'stderr' or offset == size:
                return dict(data='', nextOffset=offset, size=0 if which == 'stderr' else size, done=True)
            nxt = offset + 4096
            return dict(data=chunk, nextOffset=nxt, size=size, done=nxt == size)
        # Avoid Mock retaining 11,520 calls: the producer and the consumer both keep one page at a time.
        with patch.object(api, 'history_logs', history), patch.object(misc.time, 'time', lambda: 1000):
            tracemalloc.start()
            try:
                self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        self.assertEqual(calls[0], pages + 1)
        self.assertEqual(self.path.stat().st_size, size)
        self.assertLess(peak, 5 * 1024 * 1024)
        digest = hashlib.sha256(b'prefix\n')
        for _ in range(pages):
            digest.update(chunk.encode())
        with self.path.open('rb') as f:
            self.assertEqual(hashlib.file_digest(f, 'sha256').digest(), digest.digest())

    def test_no_progress_preserves_original(self):
        self.history.side_effect = None
        ck = common.offsets_path(self.path).read_bytes()
        for size in ({'size': 100}, {}):
            with self.subTest(size=size):
                self.history.return_value = dict(data='', nextOffset=7, done=False, **size)
                self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:no progress')
                self.assertEqual(self.path.read_bytes(), b'prefix\n')
                self.assertEqual(common.offsets_path(self.path).read_bytes(), ck)

    def test_partial_second_stream_error_does_not_publish_stdout_tail(self):
        original = self.history.side_effect
        def history(box, cmd, which, offset, **kw):
            if which == 'stderr':
                raise OffboxError('stderr unavailable')
            return original(box, cmd, which, offset, **kw)
        self.history.side_effect = history
        self.assertIn('incomplete:', misc._catch_up_log(self.row()))
        self.assertEqual(self.path.read_bytes(), b'prefix\n')
        self.assertEqual(common.checkpoint(self.path)['stdoutOffset'], 7)

    def test_timeout_preserves_original_and_is_forwarded_to_transport(self):
        for backend, deadline in (('boat', 1005), ('server', 1010)):
            with self.subTest(backend=backend):
                clock = [1000.0]
                def history(*args, **kwargs):
                    self.assertEqual(kwargs['deadline'], deadline)
                    clock[0] = deadline + 1
                    raise OffboxError('deadline expired')
                self.history.side_effect = history
                with patch.object(api, 'BACKEND', backend), \
                        patch.object(misc.time, 'time', side_effect=lambda: clock[0]):
                    self.assertEqual(misc._catch_up_log(self.row(), budget=10), 'incomplete:timeout')
                self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def fetch_events(self):
        rows = self.con.execute("SELECT detail FROM events WHERE kind='logs_fetch'").fetchall()
        events = [json.loads(row[0]) for row in rows]
        lines = [json.loads(line.split('logs_fetch bx_a ', 1)[1])
                 for line in common.LOG_PATH.read_text().splitlines() if 'logs_fetch bx_a ' in line]
        self.assertEqual(lines, events)
        return events

    def test_live_budget_keeps_pages_offsets_and_reports_progress_with_fetch_stats(self):
        self.state('running', None)
        clock = [1000.0]
        def history(box, cmd, which, offset, **kw):
            self.assertEqual(kw['deadline'], 1010)
            clock[0] += 4
            return dict(data='more', nextOffset=offset + 4, size=100, done=False)
        self.history.side_effect = history
        with patch.object(misc, '_refresh_running_ttl'), \
                patch.object(misc.time, 'time', lambda: clock[0]), \
                patch.object(misc, 'monotonic', lambda: clock[0]):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\nmoremore'))
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=15, stderrOffset=0, logBytes=15))
        self.assertIn('is still running; fetched 15 bytes so far (timeout after 12.0s)', err)
        self.assertIn('offbox logs run-x --follow, or offbox wait run-x --timeout 570', err)
        self.assertEqual(err.count('is still running'), 1)
        self.assertNotIn('incomplete', err)
        event, = self.fetch_events()
        self.assertEqual(event, dict(run='run-x', live=True, result='incomplete:timeout', seconds=12,
                                    pages=[3, 0], bytes=8, slowest_ms=4000, lock_wait_ms=0, budget=10,
                                    page_ms=[[4000, 4000, 4000], []], page_ms_omitted=[0, 0]))

    def test_queued_only_log_reports_utc_queue_time_without_incomplete_or_running(self):
        lines = [
            b'offbox-server: waiting for earlier runs in the queue\n',
            b'offbox-server: waiting for memory (this kind peaks ~15.5 GB, 6.5 GB free after reserve)\n',
            b'offbox-server: waiting; position 2 of 2; behind bx_head/1 queued 60 s; the head runner to admit; waited 60 s\n',
            b'offbox-server: waiting; position 1 of 1; memory; waited 60 s\n',
            b'offbox-server: waiting; position 1 of 1; max_running cap 1/1; waited 60 s\n',
            b'offbox-server: waiting; position 1 of 1; host CPU pressure; waited 60 s\n',
            b'offbox-server: waiting; position 1 of 1; memory; waited 60 s\n' * 20,
        ]
        for status in ('starting', 'running', 'queued'):
            for line in lines:
                with self.subTest(status=status, line=line[:100]):
                    self.state(status, None)
                    self.prefix(line, out=0, err=len(line))
                    def timeout(*args, **kwargs):
                        raise OffboxError('timeout')
                    self.history.side_effect = timeout
                    with patch.object(misc, '_refresh_running_ttl'), patch.object(misc, 'now', return_value=1000):
                        code, out, err = self.invoke()
                    self.assertEqual((code, out), (0, self.path.read_text()))
                    self.assertIn('is queued on the server (since 1970-01-01T00:15:00Z, 100s)', err)
                    self.assertIn('nothing has run yet', err)
                    self.assertNotIn('behind earlier runs', err)
                    self.assertNotIn('incomplete', err)
                    self.assertNotIn('still running', err)

    def test_live_log_notice_uses_displayed_copy_and_authoritative_status(self):
        self.state('running', None)
        shown = self.path.with_suffix('.log.takeover')
        shown.write_bytes(b'offbox-server: waiting; position 1 of 1; memory\n')
        output = []
        with patch.object(misc, 'say', side_effect=output.append):
            self.assertTrue(misc._live_log_notice(self.row(), shown, 'n/a', 0))
        self.assertIn('is queued on the server', output[0])
        common.atomic_write_json(common.LOGS_DIR / 'run-x.home-read.json', dict(status='running'))
        output = []
        with patch.object(misc, 'say', side_effect=output.append):
            self.assertFalse(misc._live_log_notice(self.row(), shown, 'n/a', 0))
        self.assertEqual(output, [])
        (common.LOGS_DIR / 'run-x.home-read.json').unlink()
        shown.write_bytes(shown.read_bytes() + b'offbox-command-started: yes\n')
        with patch.object(misc, 'say') as say:
            self.assertFalse(misc._live_log_notice(self.row(), shown, 'n/a', 0))
        say.assert_not_called()

    def test_first_logs_fetch_notices_home_queue_without_preseeded_evidence(self):
        from offbox_lib import home_run_observation as observation
        self.state('running', None)
        common.BACKEND_STATE.parent.mkdir(parents=True, exist_ok=True)
        common.BACKEND_STATE.write_text(json.dumps(dict(state='home_down', since=1794728800)))
        with patch.object(common, '_BACKEND', 'server'), patch.object(api, 'BACKEND', 'server'), \
                patch.dict('os.environ', {'OFFBOX_BACKEND': 'server'}), patch.object(misc, '_refresh_running_ttl'), \
                patch.object(observation.toollog, 'emit') as event:
            for remote, text, expected in [(None, b'offbox-server: waiting; position 1 of 1; memory\n', True),
                                           ('queued', b'', True), ('running', b'offbox-server: waiting; position 1 of 1\n', False)]:
                with self.subTest(remote=remote):
                    (common.LOGS_DIR / 'run-x.home-read.json').unlink(missing_ok=True)
                    (common.LOGS_DIR / 'run-x.home-queue-notice').unlink(missing_ok=True)
                    self.prefix(b'', out=0, err=0)
                    self.streams(b'', text)
                    history = self.history.side_effect
                    self.history.side_effect = lambda *a, **kw: dict(history(*a, **kw), **(
                        dict(status=remote, attempt=2) if remote else {}))
                    event.reset_mock()
                    observation.observe('run-x', 'accepted')
                    code, out, err = self.invoke()
                    self.assertEqual(code, 0)
                    self.assertEqual(out, text.decode())
                    self.assertEqual(err.count('it will not move to Boat'), int(expected))
                    self.assertEqual(event.call_count, int(expected))
                    if expected:
                        self.assertEqual(event.call_args.args[1], 'run.queue.home_down_notice')
                    self.assertNotIn('it will not move to Boat', self.invoke()[2])

    def test_settled_logs_and_wait_timeout_keep_wording_and_record_fetch(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                clock = [1000.0]
                def history(*args, **kwargs):
                    clock[0] += 31
                    raise OffboxError('deadline expired')
                self.history.side_effect = history
                with patch.object(api, 'BACKEND', 'server'), \
                        patch.object(misc.time, 'time', lambda: clock[0]), \
                        patch.object(misc, 'monotonic', lambda: clock[0]):
                    code, out, err = self.invoke(wait=wait)
                self.assertEqual(code, 0)
                self.assertIn("offbox: run-x local log stops at 7 bytes and the rest couldn't be fetched "
                              "(timeout); this output is incomplete\n", err)
                self.assertIn('offbox: run-x run ended done exit=0\n', err)
                event = self.fetch_events()[-1]
                self.assertEqual((event['live'], event['result'], event['bytes'], event['pages']),
                                 (False, 'incomplete:timeout', 0, [1, 0]))
                self.assertEqual((event['seconds'], event['slowest_ms'], event['budget']), (31, 31000, None))

    def test_caught_up_live_fetch_records_both_streams_without_warning(self):
        self.state('running', None)
        self.streams(b'prefix\nrest\n', b'error\n')
        with patch.object(misc, '_refresh_running_ttl'):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'prefix\nrest\nerror\n'))
        self.assertNotIn('incomplete', err)
        self.assertNotIn('more output is on the server', err)
        event, = self.fetch_events()
        self.assertEqual((event['result'], event['pages'], event['bytes']), ('caught_up', [1, 1], 11))
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=12, stderrOffset=6, logBytes=18))

    def test_log_lock_wait_is_measured_separately(self):
        clock = [1000.0]
        @contextlib.contextmanager
        def lock(*args, **kwargs):
            clock[0] += 0.25
            yield False
        with patch.object(runs, 'log_lock', lock), patch.object(misc, 'monotonic', lambda: clock[0]):
            self.assertEqual(misc._catch_up_log(self.row(), lock_wait=10), 'caught_up')
        event, = self.fetch_events()
        self.assertEqual((event['lock_wait_ms'], event['seconds']), (250, 0.25))

    def test_history_error_and_held_lock_still_record_fetch_outcomes(self):
        self.history.side_effect = OffboxError('history unavailable')
        self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:history unavailable')
        with common.file_lock('log-run-x', timeout=0):
            self.assertEqual(misc._catch_up_log(self.row()), 'n/a')
        error, locked = self.fetch_events()
        self.assertEqual((error['pages'], error['bytes']), ([1, 0], 0))
        self.assertEqual((locked['result'], locked['pages'], locked['bytes']), ('n/a', [0, 0], 0))

    def test_per_page_timing_samples_are_bounded_but_totals_cover_every_page(self):
        self.streams(b'prefix\n' + b'x' * 12, b'', page=1)
        self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
        event, = self.fetch_events()
        self.assertEqual(event['pages'], [12, 1])
        self.assertEqual([len(times) for times in event['page_ms']], [8, 1])
        self.assertEqual(event['page_ms_omitted'], [4, 0])

    def test_fetch_diagnostics_do_not_wait_for_a_database_writer(self):
        row = self.row()
        connect = common.sqlite3.connect
        timeouts = []
        def connection(*args, **kwargs):
            con = connect(*args, **kwargs)
            timeouts.append(con.execute('PRAGMA busy_timeout').fetchone()[0])
            return con
        self.con.execute('BEGIN IMMEDIATE')
        try:
            with common.file_lock('log-run-x', timeout=0), patch.object(common, 'DB_TIMEOUT', 0.05), \
                    patch.object(misc.sqlite3, 'connect', side_effect=connection):
                self.assertEqual(misc._catch_up_log(row, budget=0), 'n/a')
            self.assertEqual(timeouts, [0])
            self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='logs_fetch'").fetchone()[0], 0)
            line, = [line for line in common.LOG_PATH.read_text().splitlines() if 'logs_fetch bx_a ' in line]
            event = json.loads(line.split('logs_fetch bx_a ', 1)[1])
            self.assertEqual((event['run'], event['result'], event['budget']), ('run-x', 'n/a', 0))
        finally:
            self.con.rollback()

    def test_fetch_byte_count_uses_only_a_valid_local_prefix(self):
        cases = [
            ('missing', None, True, 'caught_up', 12),
            ('empty', b'', True, 'caught_up', 12),
            ('short', b'pre', True, 'incomplete:invalid checkpoint', 0),
            ('valid', b'prefix\n', True, 'caught_up', 5),
            ('uncommitted suffix', b'prefix\njunk', True, 'caught_up', 5),
            ('empty without checkpoint', b'', False, 'caught_up', 12),
            ('legacy bytes without checkpoint', b'prefix\n', False, 'incomplete:no checkpoint', 0),
        ]
        for name, content, saved_checkpoint, expected_result, added in cases:
            with self.subTest(name=name):
                self.prefix(b'prefix\n')
                if content is None:
                    self.path.unlink()
                else:
                    self.path.write_bytes(content)
                if not saved_checkpoint:
                    common.offsets_path(self.path).unlink()
                self.assertEqual(misc._catch_up_log(self.row()), expected_result)
                event = self.fetch_events()[-1]
                self.assertEqual(event['bytes'], added)
                if expected_result == 'caught_up':
                    self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
                    self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=12, stderrOffset=0, logBytes=12))

    def test_stale_takeover_cannot_shrink_completed_log(self):
        takeover = self.path.with_name(self.path.name + '.takeover')
        takeover.write_bytes(self.path.read_bytes())
        common.offsets_path(takeover).write_bytes(common.offsets_path(self.path).read_bytes())
        self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
        self.assertFalse(takeover.exists())
        self.assertFalse(common.offsets_path(takeover).exists())
        ck = common.checkpoint(self.path)
        with patch.object(misc, '_resolve_exit', return_value=0), patch.object(misc, '_finalize', return_value=0):
            misc._replay_takeover(self.row(), False, None, (ck['stdoutOffset'], ck['stderrOffset']),
                                  self.path, ck['logBytes'], has_checkpoint=True)
        self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')

    def test_reaper_and_pool_best_effort_settlement(self):
        self.box('bx_a', member=True)
        for caller in ('reaper', 'pool'):
            for error in (False, True):
                with self.subTest(caller=caller, error=error):
                    self.prefix(b'prefix\n')
                    self.streams(b'prefix\nrest\n', b'')
                    if error:
                        self.history.side_effect = OffboxError('history unavailable')
                    self.state('running', None)
                    with patch.object(api, 'cmd_status', return_value=dict(running=False,status='exited',exitCode=3)):
                        if caller == 'reaper':
                            reap._check_stale_runs(self.con, 'bx_a', 'running', False, [])
                        else:
                            pool._refresh_background(self.con, 'repo')
                    self.assertEqual((self.row()['status'], self.row()['exit_code']), ('failed', 3))
                    self.assertEqual(self.path.read_bytes(), b'prefix\n' if error else b'prefix\nrest\n')
        self.assertGreaterEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='log_catchup_failed'").fetchone()[0], 2)

    def test_reaper_dry_run_leaves_log_and_run_alone(self):
        self.state('running', None)
        with patch.object(api, 'cmd_status', return_value=dict(running=False,status='exited',exitCode=0)):
            reap._check_stale_runs(self.con, 'bx_a', 'running', True, [])
        self.history.assert_not_called()
        self.assertEqual(self.row()['status'], 'running')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_missing_settled_log_starts_from_zero_for_logs_and_wait(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                self.path.unlink(missing_ok=True)
                common.offsets_path(self.path).unlink(missing_ok=True)
                self.assertEqual(self.invoke(wait=wait)[0], 0)
                self.assertEqual(self.path.read_bytes(), b'prefix\nrest\n')
                self.assertEqual(common.checkpoint(self.path)['stdoutOffset'], 12)

    def test_held_lock_with_missing_log_does_not_create_it(self):
        self.path.unlink()
        with common.file_lock('log-run-x', timeout=0):
            self.assertEqual(misc._catch_up_log(self.row()), 'n/a')
        self.assertFalse(self.path.exists())
        self.history.assert_not_called()

    def test_size_extends_budget_but_maintenance_budget_stays_tight(self):
        for budget in (None, 10):
            with self.subTest(budget=budget):
                self.prefix(b'prefix\n')
                clock = [1000.0]
                page_size = 128 * 1024
                total = 7 + 360 * page_size
                def history(box, cmd, which, offset, **kw):
                    clock[0] += 0.15
                    if which == 'stderr':
                        return dict(data='', nextOffset=0, size=0, done=True)
                    nxt = min(total, offset + page_size)
                    return dict(data='x' * (nxt - offset), nextOffset=nxt, size=total, done=nxt == total)
                with patch.object(api, 'history_logs', history), patch.object(misc.time, 'time', lambda: clock[0]):
                    result = misc._catch_up_log(self.row(), budget=budget)
                self.assertEqual(result, 'caught_up' if budget is None else 'incomplete:timeout')
                self.assertEqual(self.path.stat().st_size, total if budget is None else 7)

    def test_deadline_is_capped_at_180_seconds(self):
        clock = [1000.0]
        def history(box, cmd, which, offset, **kw):
            if offset == 7:
                return dict(data='x', nextOffset=8, size=300_000_000, done=False)
            self.assertEqual(kw['deadline'], 1180)
            clock[0] = 1181
            return dict(data='', nextOffset=8, size=300_000_000, done=False)
        self.history.side_effect = history
        with patch.object(misc.time, 'time', lambda: clock[0]):
            self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:timeout')
        self.assertEqual(self.path.read_bytes(), b'prefix\n')

    def test_retained_copy_budget_includes_the_checkpointed_history_being_verified(self):
        prefix, total, page_size = 40_000_000, 50_000_000, 1_000_000
        with self.path.open('wb') as f:
            f.truncate(prefix)
        common.atomic_write_json(common.offsets_path(self.path),
                                 dict(stdoutOffset=prefix, stderrOffset=0, logBytes=prefix))
        Path(str(self.path) + '.remote').write_bytes(b'\0')
        common.atomic_write_json(Path(str(self.path) + '.remote.json'), dict(source='process log', merged=False))
        clock = [1000.0]
        def history(box, cmd, which, offset, **kw):
            clock[0] += 1
            size = total if which == 'stdout' else 0
            nxt = min(size, offset + page_size)
            return dict(data='\0' * (nxt - offset), nextOffset=nxt, size=size, done=nxt == size)
        with patch.object(api, 'history_logs', history), patch.object(misc.time, 'time', lambda: clock[0]):
            self.assertEqual(misc._catch_up_log(self.row()), 'caught_up')
        self.assertGreater(clock[0], 1030)
        self.assertEqual(self.path.stat().st_size, total)
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=total, stderrOffset=0, logBytes=total))
        self.assertEqual(misc._shown_log(self.path), self.path)

    def test_streaming_log_preserves_utf8_across_file_chunks(self):
        content = 'x' * 65535 + '€' + 'y' * 65535 + 'é'
        data = content.encode()
        self.prefix(data)
        self.streams(data, b'')
        self.assertEqual(self.invoke(), (0, content, ''))

    def test_history_transport_uses_deadline(self):
        with patch.object(api, 'call', return_value={}) as call:
            HISTORY_LOGS('bx_a', 'cmd_a', 'stderr', 4082, deadline=1010)
        self.assertEqual(call.call_args.kwargs['deadline'], 1010)
        self.assertIn('stream=stderr&offset=4082', call.call_args.args[1])


if __name__ == '__main__':
    unittest.main()
