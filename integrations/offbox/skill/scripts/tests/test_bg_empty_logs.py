"""Detached runs retain output at settlement and never silently pass with an empty log."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests._env import clean_env
from offbox_lib import api, cli, common, lease, misc, pool, reap, runs, ssh_sync, start_check
from test_capacity import Isolated


class BackgroundOutputTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.stack.enter_context(patch.object(api, 'BACKEND', 'boat'))
        self.stack.enter_context(patch.object(api, 'NAME', 'boat'))
        self.box_get = self.stack.enter_context(patch.object(api, 'get', return_value=None))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.history = self.stack.enter_context(patch.object(api, 'history_logs', side_effect=self.empty))
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,exit_code,pulls,start_at) "
                         "VALUES ('run-x','bx_a','cmd_a',7,'done','bg',0,'[]',900)")
        self.con.commit()
        self.path = common.LOGS_DIR / 'run-x.log'

    @staticmethod
    def empty(box, cmd, which, offset, **kwargs):
        return dict(data='', nextOffset=offset, size=0, done=True)

    def streams(self):
        def history(box, cmd, which, offset, **kwargs):
            data = b'hello\n' if which == 'stdout' else b'error\n'
            return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-x'").fetchone()

    def invoke(self, wait=False, follow=False):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = misc.wait('run-x', None) if wait else misc.logs('run-x', follow)
        return code, out.getvalue(), err.getvalue()

    def test_missing_log_recovers_both_history_streams(self):
        self.streams()
        self.assertEqual(self.invoke(), (0, 'hello\nerror\n', ''))
        self.assertEqual(self.path.read_bytes(), b'hello\nerror\n')
        self.box_get.assert_not_called()

    def test_first_empty_unfinished_page_retries_same_offset(self):
        self.streams()
        history = self.history.side_effect
        def first_empty(*args, **kwargs):
            if self.history.call_count == 1:
                return dict(data='', nextOffset=0, size=6, done=False)
            return history(*args, **kwargs)
        self.history.side_effect = first_empty
        self.assertEqual(self.invoke(), (0, 'hello\nerror\n', ''))
        self.assertEqual([call.args[3] for call in self.history.call_args_list], [0, 0, 0])

    def test_empty_or_missing_file_ignores_orphaned_checkpoint(self):
        for create_empty in (False, True):
            with self.subTest(create_empty=create_empty):
                self.path.unlink(missing_ok=True)
                if create_empty:
                    self.path.touch()
                common.atomic_write_json(common.offsets_path(self.path),
                                         dict(stdoutOffset=6, stderrOffset=6, logBytes=12))
                self.streams()
                self.assertEqual(self.invoke(), (0, 'hello\nerror\n', ''))

    def test_all_empty_logs_fail_and_wait_keeps_real_exit(self):
        for exit_code in (0, 1, 7):
            for follow in (False, True):
                with self.subTest(exit_code=exit_code, follow=follow):
                    self.con.execute("UPDATE runs SET exit_code=?,status=? WHERE run_id='run-x'",
                                     (exit_code, 'failed' if exit_code else 'done'))
                    self.con.commit()
                    code, out, err = self.invoke(follow=follow)
                    self.assertNotEqual(code, 0)
                    self.assertEqual(out, '')
                    self.assertIn('no output recorded for run-x', err)
                    self.assertEqual(len(err.splitlines()), 1)
                    code, out, err = self.invoke(wait=True)
                    self.assertEqual(code, exit_code)
                    self.assertIn(f'exit={exit_code}', out)
                    self.assertIn('no output on record', err)
                    self.assertEqual(len(err.splitlines()), 1)

    def test_remote_copy_fallback_for_empty_or_error_history(self):
        home = Path(self.tmp.name) / 'remote-home'
        for source in ('.offbox/out/run-x.log', '.ascii/processes/7.log'):
            for history_error in (False, True):
                with self.subTest(source=source, history_error=history_error):
                    self.path.unlink(missing_ok=True)
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    self.history.side_effect = common.OffboxError('history failed') if history_error else self.empty
                    remote = home / source
                    remote.parent.mkdir(parents=True, exist_ok=True)
                    remote.write_bytes(b'from remote stdout\nfrom remote stderr\n')
                    self.box_get.return_value = dict(state='running')
                    real_run = subprocess.run
                    with patch.object(ssh_sync, 'ssh_base', return_value=['env', 'HOME=' + str(home), 'bash', '-c']), \
                            patch.object(misc.subprocess, 'run', wraps=subprocess.run) as ssh:
                        # ssh passes the remote command after the hostname; execute that command in a real shell.
                        ssh.side_effect = lambda argv, **kw: real_run(['bash', '-c', argv[-1]],
                                                                 env=clean_env(HOME=str(home)), **kw)
                        code, out, err = self.invoke()
                    self.assertEqual((code, out), (0, remote.read_text()))
                    self.assertEqual(self.path.read_bytes(), remote.read_bytes())
                    self.assertIsNone(common.checkpoint(self.path))
                    self.assertIn('no stream checkpoint', err)
                    remote.unlink()

    def test_remote_log_pid_namespace_matrix(self):
        home = Path(self.tmp.name) / 'remote-home'
        for process_id, wrapper_pid, log_pid in ((1001, None, 1001), (None, 4242, 4242),
                                                 (4242, None, 4242), (1001, 4242, 4242),
                                                 (1001, 1002, 1002), (None, None, None)):
            for history_error in (False, True):
                with self.subTest(process_id=process_id, wrapper_pid=wrapper_pid, history_error=history_error):
                    self.path.unlink(missing_ok=True)
                    self.con.execute('UPDATE runs SET process_id=?,wrapper_pid=? WHERE run_id=?',
                                     (process_id, wrapper_pid, 'run-x'))
                    self.con.commit()
                    self.history.side_effect = common.OffboxError('history failed') if history_error else self.empty
                    remote = home / f'.ascii/processes/{log_pid}.log' if log_pid else None
                    if remote:
                        remote.parent.mkdir(parents=True, exist_ok=True)
                        remote.write_bytes(b'wrapper output retained\n')
                    self.box_get.return_value = dict(state='running')
                    real_run = subprocess.run
                    commands = []
                    def ssh(argv, **kw):
                        commands.append(argv[-1])
                        return real_run(['bash', '-c', argv[-1]], env=clean_env(HOME=str(home)), **kw)
                    with patch.object(ssh_sync, 'ssh_base', return_value=['ssh']), \
                            patch.object(misc.subprocess, 'run', side_effect=ssh):
                        code, out, _ = self.invoke()
                    self.assertEqual(code, 0 if remote else 1)
                    self.assertEqual(out, remote.read_text() if remote else '')
                    if remote:
                        self.assertIn(f'.ascii/processes/{log_pid}.log', commands[0])
                        if process_id and process_id != log_pid:
                            self.assertNotIn(f'.ascii/processes/{process_id}.log', commands[0])
                        remote.unlink()
                    else:
                        self.assertNotIn('.ascii/processes/', commands[0])

    def test_stuck_empty_page_falls_back_without_looping(self):
        self.history.side_effect = lambda *a, **kw: dict(data='', nextOffset=0, size=6, done=False)
        code, out, err = self.invoke()
        self.assertEqual((code, out), (1, ''))
        self.assertIn('this output is incomplete', err)
        self.assertNotIn('no output', err)
        self.assertEqual(self.history.call_count, 3)

    def test_receipt_without_command_id_can_recover_remote_copy(self):
        self.con.execute("UPDATE runs SET command_id=NULL WHERE run_id='run-x'")
        self.con.commit()
        self.box_get.return_value = dict(state='running')
        def ssh(argv, **kwargs):
            kwargs['stdout'].write(b'output without history id\n')
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(misc.subprocess, 'run', side_effect=ssh):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'output without history id\n'))
        self.history.assert_not_called()

    def test_settlement_paths_create_log_without_a_follower(self):
        self.box('bx_a', member=True)
        for caller in ('finish', 'reaper', 'pool', 'receipt'):
            for exit_code in (0, 3):
                with self.subTest(caller=caller, exit_code=exit_code):
                    self.path.unlink(missing_ok=True)
                    common.offsets_path(self.path).unlink(missing_ok=True)
                    self.streams()
                    self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                    self.con.commit()
                    with patch.object(api, 'cmd_status', return_value=dict(running=False,status='exited',exitCode=exit_code)):
                        if caller == 'finish':
                            runs.finish('run-x', exit_code)
                        elif caller == 'reaper':
                            reap._check_stale_runs(self.con, 'bx_a', 'running', False, [])
                        elif caller == 'pool':
                            pool._refresh_background(self.con, 'repo')
                        else:
                            start_check.settle(self.con, self.row(), start_check.Result('started', exit_code, 7), 'receipt')
                    self.assertEqual(self.path.read_bytes(), b'hello\nerror\n')
                    self.assertEqual(self.row()['exit_code'], exit_code)
                    self.assertEqual(self.invoke(), (0, 'hello\nerror\n', ''))

    def test_wait_which_settles_empty_run_warns_without_changing_exit(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        with patch.object(runs, 'follow', return_value=7):
            code, out, err = self.invoke(wait=True)
        self.assertEqual(code, 7)
        self.assertIn('no output on record', err)
        self.assertEqual(self.row()['exit_code'], 7)

    def test_follow_and_failed_wait_deliver_settlement_output_once(self):
        for caller in ('follow', 'wait', 'direct_follow'):
            for source, live_prefix in (('history', ''), ('history', 'live\n'), ('remote', ''), ('empty', '')):
                for exit_code in (0, 7):
                    with self.subTest(caller=caller, source=source, live_prefix=live_prefix, exit_code=exit_code):
                        self.path.unlink(missing_ok=True)
                        common.offsets_path(self.path).unlink(missing_ok=True)
                        Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                        self.con.commit()
                        self.box_get.return_value = dict(state='running')
                        content = live_prefix + 'hello\nerror\n' if source != 'empty' else ''
                        def history(box, cmd, which, offset, **kw):
                            data = (live_prefix + 'hello\n' if which == 'stdout' else 'error\n') if source == 'history' else ''
                            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
                        self.history.side_effect = history
                        frames = ([dict(type='stdout', data=live_prefix, nextOffset=len(live_prefix))] if live_prefix else [])
                        frames.append(dict(type='exit', exitCode=exit_code))
                        def ssh(argv, **kw):
                            kw['stdout'].write(content.encode())
                            return subprocess.CompletedProcess(argv, 0)
                        out_bytes, err = io.BytesIO(), io.StringIO()
                        out = io.TextIOWrapper(out_bytes, encoding='utf-8', write_through=True)
                        self.addCleanup(out.close)
                        with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                                patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                                patch.object(misc.subprocess, 'run', side_effect=ssh), \
                                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            if caller == 'direct_follow':
                                code = misc._wait_run(self.row(), echo=True)
                            else:
                                code = misc.wait('run-x', None) if caller == 'wait' else misc.logs('run-x', True)
                        self.assertEqual(code, exit_code)
                        self.assertEqual(self.path.read_text(), content)
                        failed_wait = caller == 'wait' and exit_code != 0
                        expected = (content if caller != 'wait' or failed_wait else '')
                        expected += f"run-x: {'failed ' if failed_wait else ''}exit={exit_code}\n"
                        self.assertEqual(out_bytes.getvalue().decode(), expected)
                        if source == 'empty':
                            self.assertIn('no output on record', err.getvalue())

    def test_follow_then_wait_does_not_replay_delivered_failure(self):
        for source in ('stream', 'history', 'remote', 'broken-output'):
            with self.subTest(source=source):
                self.path.unlink(missing_ok=True)
                common.offsets_path(self.path).unlink(missing_ok=True)
                Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                self.con.commit()
                self.history.side_effect = self.empty
                if source == 'history':
                    self.streams()
                self.box_get.return_value = dict(state='running')
                frames = [dict(type='exit', exitCode=7)]
                if source in ('stream', 'broken-output'):
                    frames[:0] = [dict(type='stdout', data='hello\n', nextOffset=6),
                                  dict(type='stderr', data='error\n', nextOffset=6)]
                def ssh(argv, **kw):
                    kw['stdout'].write(b'hello\nerror\n' if source == 'remote' else b'')
                    return subprocess.CompletedProcess(argv, 0)
                output, errors = io.BytesIO(), io.BytesIO()
                stdout = io.TextIOWrapper(output, write_through=True)
                stderr = io.TextIOWrapper(errors, write_through=True)
                self.addCleanup(stdout.close)
                self.addCleanup(stderr.close)
                with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                     patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                     patch.object(misc.subprocess, 'run', side_effect=ssh), \
                     patch.object(runs, '_echo', return_value=False) if source == 'broken-output' else contextlib.nullcontext(), \
                     contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(misc.logs('run-x', True), 7)
                self.assertEqual(self.path.read_bytes(), b'hello\nerror\n')
                self.assertIn(b'hello\n', output.getvalue())
                self.assertIn(b'error\n', output.getvalue() + errors.getvalue())
                code, text, err = self.invoke(wait=True)
                self.assertEqual((code, text), (7, 'run-x: failed exit=7\n'))
                if source == 'remote':
                    self.assertIn('this output is incomplete', err)
                else:
                    self.assertEqual(err, '')
                code, text, _ = self.invoke(wait=True)
                self.assertEqual((code, text), (7, 'run-x: failed exit=7\n'))

    def test_settled_log_read_or_wait_then_wait_is_quiet(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()
        self.streams()
        for reader in ('logs', 'follow', 'wait'):
            with self.subTest(reader=reader):
                Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                code, output, _ = self.invoke(wait=reader == 'wait', follow=reader == 'follow')
                self.assertEqual(code, 7 if reader == 'wait' else 0)
                self.assertIn('hello\nerror\n', output)
                self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_settlement_catchup_preserves_a_failed_stderr_echo(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        def history(box, cmd, which, offset, **kw):
            data = 'hello\nlate\n' if which == 'stdout' else 'error\n'
            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        frames = [dict(type='stdout', data='hello\n', nextOffset=6),
                  dict(type='stderr', data='error\n', nextOffset=6), dict(type='exit', exitCode=7)]
        output, errors = io.BytesIO(), io.BytesIO()
        stdout = io.TextIOWrapper(output, write_through=True)
        stderr = io.TextIOWrapper(errors, write_through=True)
        self.addCleanup(stdout.close)
        self.addCleanup(stderr.close)
        echo = runs._echo
        with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
             patch.object(api, 'cmd_attach', return_value=iter(frames)), \
             patch.object(runs, '_echo', side_effect=lambda stream, data: False if data == b'error\n' else echo(stream, data)), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(misc.logs('run-x', True), 7)
        self.assertEqual(output.getvalue(), b'hello\nerror\nlate\nrun-x: exit=7\n')
        self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_real_broken_stdout_pipe_leaves_failure_unread_after_settlement(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        def history(box, cmd, which, offset, **kw):
            data = 'hello\nlate\n' if which == 'stdout' else 'error\n'
            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        frames = [dict(type='stdout', data='hello\n', nextOffset=6),
                  dict(type='stderr', data='error\n', nextOffset=6), dict(type='exit', exitCode=7)]
        reader, writer = os.pipe()
        os.close(reader)
        with os.fdopen(writer, 'wb', buffering=0) as sink:
            broken = io.TextIOWrapper(sink, write_through=True)
            with broken, patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                 patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                 contextlib.redirect_stdout(broken), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.logs('run-x', True), 7)
        self.assertEqual(self.invoke(wait=True), (7, 'hello\nerror\nlate\nrun-x: failed exit=7\n', ''))
        self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_active_wait_reports_recovered_failure_once(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        self.streams()
        with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
             patch.object(api, 'cmd_attach', return_value=iter([dict(type='exit', exitCode=7)])):
            self.assertEqual(self.invoke(wait=True), (7, 'hello\nerror\nrun-x: failed exit=7\n', ''))
        self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_active_wait_failure_tail_is_bounded_and_echoing_follow_does_not_repeat_it(self):
        content = 'old output\n' * 2000 + 'actual failure\n'
        for mode, follow, exit_code in (('bg', False, 7), ('bg', False, 0), ('bg', True, 7),
                                         ('bg', True, 0), ('fg', False, 7)):
            with self.subTest(mode=mode, follow=follow, exit_code=exit_code):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,mode=? WHERE run_id='run-x'", (mode,))
                self.con.commit()
                self.path.write_bytes(b'')
                common.offsets_path(self.path).unlink(missing_ok=True)
                Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                frames = [dict(type='stdout', data=content, nextOffset=len(content)),
                          dict(type='exit', exitCode=exit_code)]
                stdout = io.TextIOWrapper(io.BytesIO(), write_through=True)
                stderr = io.TextIOWrapper(io.BytesIO(), write_through=True)
                with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                        patch.object(api, 'cmd_attach', return_value=iter(frames)), stdout, stderr, \
                        contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = misc.logs('run-x', True) if follow else misc.wait('run-x', None)
                    output, errors = stdout.buffer.getvalue().decode(), stderr.buffer.getvalue().decode()
                self.assertEqual(code, exit_code)
                self.assertEqual(errors, '')
                expected = content if follow else content[-16384:] if mode == 'bg' and exit_code else ''
                label = 'failed ' if mode == 'bg' and not follow and exit_code else ''
                self.assertEqual(output, expected + f'run-x: {label}exit={exit_code}\n')
                if mode == 'bg' and exit_code:
                    self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_wait_for_holder_reports_failure_tail_once_on_both_exit_paths(self):
        from test_wait_lock import Clock
        for stuck in (False, True):
            with self.subTest(stuck=stuck):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                self.con.commit()
                self.path.write_bytes(b'hello\nerror\n')
                common.atomic_write_json(common.offsets_path(self.path),
                                         dict(stdoutOffset=6, stderrOffset=6, logBytes=12))
                Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                self.streams()
                def settle(_):
                    if not stuck:
                        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
                        self.con.commit()
                clock = Clock(on_sleep=settle)
                ended = dict(running=False, status='exited', exitCode=7) if stuck else None
                with common.file_lock('box-bx_a', timeout=0), \
                        patch.object(misc, '_refresh_running_ttl'), patch.object(runs, '_ended', return_value=ended), \
                        patch.object(misc.time, 'sleep', clock.sleep), patch.object(misc, 'now', clock.now), \
                        patch.object(runs, 'now', clock.now):
                    code, output, errors = self.invoke(wait=True)
                self.assertEqual((code, output), (7, 'hello\nerror\nrun-x: failed exit=7\n'))
                self.assertEqual('looks stuck' in errors, stuck)

    def test_active_wait_prints_failure_before_dependency_hint(self):
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        frames = [dict(type='stderr', data='actual failure\n', nextOffset=15), dict(type='exit', exitCode=7)]
        output = io.StringIO()
        with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                patch.object(runs, 'box_deps_hint', return_value='dependency hint'), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(misc.wait('run-x', None), 7)
        self.assertEqual(output.getvalue(), 'actual failure\noffbox: dependency hint\nrun-x: failed exit=7\n')

    def test_partial_delivery_and_broken_pipe_preserve_unread_failure(self):
        self.path.write_text('hello\nerror\n')
        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()
        for broken in (False, True):
            with self.subTest(broken=broken):
                Path(str(self.path) + '.delivered').unlink(missing_ok=True)
                output = io.StringIO()
                if broken:
                    output.close()
                with contextlib.redirect_stdout(output):
                    misc._tail(self.path, 0, True, limit=6)
                with patch.object(misc, '_catch_up_log', return_value='complete'):
                    expected = ('hello\n' if broken else '') + 'error\n'
                    self.assertEqual(self.invoke(wait=True), (7, expected + 'run-x: failed exit=7\n', ''))
                    self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_replaced_shorter_log_does_not_reuse_an_out_of_range_delivery(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()
        self.path.write_text('old output\n' * 20)
        with patch.object(misc, '_catch_up_log', return_value='complete'):
            self.assertIn('old output', self.invoke(wait=True)[1])
            self.path.write_text('new error\n')
            self.assertEqual(self.invoke(wait=True), (7, 'new error\nrun-x: failed exit=7\n', ''))
            self.assertEqual(self.invoke(wait=True), (7, 'run-x: failed exit=7\n', ''))

    def test_fallback_ssh_failure_leaves_empty_log_and_warns(self):
        self.box_get.return_value = dict(state='running')
        with patch.object(misc.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 1)):
            self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.path.read_bytes(), b'')
        self.assertFalse(list(self.path.parent.glob('*.remote.*')))

    def test_stopped_and_deleted_boxes_are_not_accessed_over_ssh(self):
        for box in (None, dict(state='archived')):
            with self.subTest(box=box):
                self.box_get.return_value = box
                with patch.object(misc.subprocess, 'run', side_effect=AssertionError('no ssh')):
                    self.assertEqual(self.invoke()[0], 1)

    def test_empty_log_fallback_can_read_a_busy_box(self):
        self.box_get.return_value = dict(state='running')
        def ssh(argv, **kw):
            kw['stdout'].write(b'retained output\n')
            return subprocess.CompletedProcess(argv, 0)
        with common.file_lock('box-bx_a', timeout=0), patch.object(misc.subprocess, 'run', side_effect=ssh):
            code, out, err = self.invoke()
        self.assertEqual((code, out), (0, 'retained output\n'))
        self.assertIn('no stream checkpoint', err)

    def test_foreground_empty_log_keeps_existing_behavior(self):
        self.con.execute("UPDATE runs SET mode='fg' WHERE run_id='run-x'")
        self.con.commit()
        self.assertEqual(self.invoke(), (0, '', ''))
        self.box_get.assert_not_called()


class BackgroundStartTests(Isolated):
    def test_quick_command_has_local_file_before_detach_then_fills_at_settlement(self):
        self.box('bx', member=True)
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'echo hello'])
        runner = runs.Runner(a, self.me)
        def start(box, command, **kwargs):
            self.assertTrue(runner.log_path.exists())
            return dict(processId=7, commandId='cmd_a')
        with patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')), \
                patch.object(pool, 'acquire', return_value=dict(box_id='bx', remote_dir='w/r', size='large')), \
                patch.object(runs.Runner, '_prepare_box', return_value=None), patch.object(runs, '_ttl_keeper'), \
                patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), patch.object(lease, 'ensure_ttl'), \
                patch.object(api, 'get', return_value=dict(state='running')), patch.object(api, 'cmd_start', side_effect=start), \
                patch.object(runs, 'settle_docker'), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runs._run_remote(a, runner), 0)
            def history(box, cmd, which, offset, **kw):
                data = 'hello\n' if which == 'stdout' else 'error\n'
                return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
            with patch.object(api, 'history_logs', side_effect=history):
                runs.finish(runner.run_id, 3)
                self.assertEqual(misc.logs(runner.run_id, False), 0)
            self.assertEqual(runner.log_path.read_text(),
                             'hello\nerror\n\noffbox: box pressure unavailable · host boxes ?→? running\n')
