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


class _BackgroundOutputFixture(Isolated):
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


class BackgroundOutputTests(_BackgroundOutputFixture):
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
                Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                    Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                    self.assertEqual(code, 0)
                    self.assertTrue(out.startswith(remote.read_text()))
                    self.assertIn('stderr for this run could not be fetched', out)
                    self.assertTrue(misc._shown_log(self.path).read_bytes().startswith(remote.read_bytes()))
                    self.assertEqual(common.checkpoint(self.path), None if history_error else
                                     dict(stdoutOffset=0, stderrOffset=0, logBytes=0))
                    self.assertIn('box copy', err)
                    remote.unlink()

    def test_remote_log_pid_namespace_matrix(self):
        home = Path(self.tmp.name) / 'remote-home'
        for process_id, wrapper_pid, log_pid in ((1001, None, 1001), (None, 4242, 4242),
                                                 (4242, None, 4242), (1001, 4242, 4242),
                                                 (1001, 1002, 1002), (None, None, None)):
            for history_error in (False, True):
                with self.subTest(process_id=process_id, wrapper_pid=wrapper_pid, history_error=history_error):
                    self.path.unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                    self.assertTrue(out.startswith(remote.read_text()) if remote else out == '')
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
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith('output without history id\n'))
        self.assertIn('history unavailable', err)
        self.history.assert_not_called()

    def test_settlement_paths_create_log_without_a_follower(self):
        self.box('bx_a', member=True)
        for caller in ('finish', 'reaper', 'pool', 'receipt'):
            for exit_code in (0, 3):
                with self.subTest(caller=caller, exit_code=exit_code):
                    self.path.unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                    Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                        Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                        Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                        Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                        if source == 'remote':
                            content = misc._shown_log(self.path).read_text()
                            self.assertIn('hello\nerror\n', content)
                            self.assertIn('stderr for this run could not be fetched', content)
                        self.assertEqual(misc._shown_log(self.path).read_text(), content)
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
                Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
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
                self.assertTrue(misc._shown_log(self.path).read_bytes().startswith(b'hello\nerror\n'))
                if source == 'remote':
                    self.assertIn(b'stderr for this run', misc._shown_log(self.path).read_bytes())
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
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith('retained output\n'))
        self.assertIn('stderr for this run could not be fetched', out)
        self.assertIn('offbox: remote exit 0', out)
        self.assertIn('box copy', err)

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
                             'hello\nerror\n\noffbox: box pressure unavailable · host boxes ?→? running\n'
                             'offbox: remote exit 3\n')

class BackgroundStreamRecoveryTests(_BackgroundOutputFixture):
    def setUp(self):
        super().setUp()
        self.box_get.return_value = dict(state='running')

    def copy(self, argv, **kwargs):
        kwargs['stdout'].write(b'out1\nout2\nout3\n')
        return subprocess.CompletedProcess(argv, 0, stderr=b'.ascii/processes/7.log\n')

    def test_delayed_history_replaces_stdout_copy_for_logs_and_wait(self):
        for wait in (False, True):
            with self.subTest(wait=wait):
                self.path.unlink(missing_ok=True)
                Path(str(self.path) + '.remote.json').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view').unlink(missing_ok=True)
                Path(str(self.path) + '.remote.view.delivered').unlink(missing_ok=True)
                common.offsets_path(self.path).unlink(missing_ok=True)
                self.history.side_effect = self.empty
                with patch.object(misc.subprocess, 'run', side_effect=self.copy):
                    first = self.invoke()
                self.assertIn('out1', first[1])
                self.assertIn('stderr for this run could not be fetched', misc._shown_log(self.path).read_text())
                def history(box, cmd, which, offset, **kw):
                    data = 'out1\nout2\nout3\n' if which == 'stdout' else 'error\n'
                    return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
                self.history.side_effect = history
                code, out, err = self.invoke(wait=wait)
                self.assertEqual(code, 0)
                self.assertEqual(self.path.read_bytes(), b'out1\nout2\nout3\nerror\n')
                self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=15, stderrOffset=6, logBytes=21))
                self.assertNotIn('incomplete', err)
                self.assertFalse(Path(str(self.path) + '.remote.json').exists())

    def test_unavailable_history_names_copy_reason_and_missing_stream(self):
        self.history.side_effect = common.OffboxError('history 404')
        with patch.object(misc.subprocess, 'run', side_effect=self.copy), patch.object(misc.toollog, 'emit') as emit:
            code, out, err = self.invoke()
            self.assertEqual(code, 0)
            self.assertIn('out1\nout2\nout3', out)
            self.assertIn('stderr for this run could not be fetched (history 404); output shows stdout only', out)
            self.assertIn('box copy .ascii/processes/7.log; history: history 404', err)
            self.assertIn('offbox: remote exit 0', out)
            self.assertIn('box pressure unavailable', out)
            emit.assert_called_once()
            self.assertEqual(emit.call_args.args, ('run', 'run.log_stream_missing'))
            self.assertEqual(emit.call_args.kwargs['props'], dict(stream='stderr', backend='boat', reason='history_unavailable'))
        self.box_get.return_value = dict(state='archived')
        with patch.object(misc.subprocess, 'run', side_effect=AssertionError('no new SSH')):
            self.assertIn('out1', self.invoke()[1])

    def test_settle_logs_original_history_result_before_copy_and_ttl(self):
        self.box('bx_a', member=True)
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        self.history.side_effect = common.OffboxError('empty retained page')
        def copy(*args, **kwargs):
            events = list(self.con.execute("SELECT kind, detail FROM events"))
            self.assertTrue(any(e[0] == 'log_catchup_result' and 'empty retained page' in e[1] for e in events))
            return self.copy(*args, **kwargs)
        def ttl(*args):
            self.assertIn('out1', misc._shown_log(self.path).read_text())
            self.assertIn('stderr for this run', misc._shown_log(self.path).read_text())
        with patch.object(misc.subprocess, 'run', side_effect=copy), patch.object(lease, 'idle_ttl', side_effect=ttl) as idle:
            runs.finish('run-x', 3)
        idle.assert_called_once()
        self.assertIn('remote exit 3', misc._shown_log(self.path).read_text())

    def test_empty_history_does_not_discard_the_saved_copy(self):
        with patch.object(misc.subprocess, 'run', side_effect=self.copy):
            self.invoke()
        second = self.invoke()
        self.assertIn('out1', second[1])
        self.assertIn('history empty', second[2])
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=0, stderrOffset=0, logBytes=0))

    def test_real_legacy_log_still_has_no_checkpoint(self):
        self.path.write_bytes(b'legacy\n')
        self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:no checkpoint')
        self.history.assert_not_called()

    def test_boat_wrapper_copy_keeps_both_streams_and_exit(self):
        home = Path(self.tmp.name) / 'wrapper-home'
        home.mkdir()
        script = 'for i in 1 2 3; do echo out$i; echo err$i >&2; done; exit 3'
        command = runs.exit_recording_command(script, 'run-wrapper')
        result = subprocess.run(['bash', '-c', command], env=clean_env(HOME=str(home)),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 3, result.stderr)
        copy = ((home / '.offbox/out/run-wrapper.stdout').read_text() +
                (home / '.offbox/out/run-wrapper.stderr').read_text())
        self.assertCountEqual(copy.splitlines(), ['out1', 'err1', 'out2', 'err2', 'out3', 'err3'])
        self.assertEqual(result.stdout, 'out1\nout2\nout3\n')
        self.assertIn('err1\nerr2\nerr3\n', result.stderr)
        self.assertEqual((home / '.offbox/exit/run-wrapper.rc').read_text(), '3\n')

    def test_home_wrapper_keeps_separate_streams(self):
        home = Path(self.tmp.name) / 'wrapper-home'
        home.mkdir()
        with patch.object(api, 'BACKEND', 'server'):
            command = runs.exit_recording_command('echo out; echo err >&2; exit 3', 'run-home')
        result = subprocess.run(['bash', '-c', command], env=clean_env(HOME=str(home)),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, 'out\n')
        self.assertIn('err\n', result.stderr)
        self.assertFalse((home / '.offbox/out').exists())

    def test_history_diagnostics_alone_do_not_hide_stdout_copy(self):
        with patch.object(misc.subprocess, 'run', side_effect=self.copy):
            self.invoke()
        def history(box, cmd, which, offset, **kw):
            data = '' if which == 'stdout' else 'wrapper diagnostics\n' * 10
            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        result = self.invoke()
        self.assertIn('out1\nout2\nout3', result[1])
        self.assertIn('history behind box copy', result[2])
        self.assertEqual(self.path.read_bytes(), b'')

    def test_interrupted_sidecar_publication_never_changes_legacy_bytes(self):
        self.path.write_bytes(b'legacy bytes\n')
        common.atomic_write_json(Path(str(self.path) + '.remote.json'),
                                 dict(bytes=10000, source='stale copy', merged=False))
        self.assertEqual(misc._catch_up_log(self.row()), 'incomplete:no checkpoint')
        self.assertEqual(self.path.read_bytes(), b'legacy bytes\n')

    def test_completed_history_publication_retires_leftover_sidecar_marker(self):
        with patch.object(misc.subprocess, 'run', side_effect=self.copy):
            self.invoke()
        self.path.write_bytes(b'out1\nout2\nout3\nerror\n')
        common.atomic_write_json(common.offsets_path(self.path), dict(stdoutOffset=15, stderrOffset=6, logBytes=21))
        def history(box, cmd, which, offset, **kw):
            data = 'out1\nout2\nout3\n' if which == 'stdout' else 'error\n'
            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        inode = self.path.stat().st_ino
        self.assertEqual(misc._catch_up_log(self.row()), 'complete')
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertEqual(misc._shown_log(self.path), self.path)
        self.assertEqual(self.path.read_bytes(), b'out1\nout2\nout3\nerror\n')

    def test_late_sidecar_reader_cannot_skip_recovered_stderr(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()
        with patch.object(misc.subprocess, 'run', side_effect=self.copy):
            misc._catch_up_log(self.row())
        view = misc._shown_log(self.path)
        def history(box, cmd, which, offset, **kw):
            data = 'out1\nout2\nout3\n' if which == 'stdout' else 'error\n'
            return dict(data=data[offset:], nextOffset=len(data), size=len(data), done=True)
        parent = self
        class Reader(io.StringIO):
            def write(self, value):
                if misc._shown_log(parent.path) == view:
                    parent.history.side_effect = history
                    parent.assertEqual(misc._catch_up_log(parent.row()), 'caught_up')
                return super().write(value)
        with contextlib.redirect_stdout(Reader()):
            misc._tail(view, 0, True)
        self.assertTrue(Path(str(view) + '.delivered').exists())
        self.assertIn('error\n', self.invoke(wait=True)[1])

    def test_background_descendant_does_not_hold_the_exit_receipt(self):
        home = Path(self.tmp.name) / 'descendant-home'
        home.mkdir()
        script = 'sleep 60 & echo $! > "$HOME/child.pid"; exit 7'
        command = runs.exit_recording_command(script, 'run-descendant')
        proc = subprocess.Popen(['bash', '-c', command], env=clean_env(HOME=str(home)),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertEqual(proc.wait(timeout=10), 7)
            self.assertEqual((home / '.offbox/exit/run-descendant.rc').read_text(), '7\n')
        finally:
            if (home / 'child.pid').exists():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(int((home / 'child.pid').read_text()), 15)
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_active_follow_footer_uses_settled_exit(self):
        runs.save_run_state('run-x', resources=runs.resources.unavailable('boat'))
        self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        self.streams()
        with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                patch.object(api, 'cmd_attach', return_value=iter([dict(type='exit', exitCode=7)])):
            self.assertEqual(self.invoke(wait=True)[0], 7)
        self.assertIn('offbox: remote exit 7', self.path.read_text())
        self.assertNotIn('remote exit None', self.path.read_text())

    def test_merged_history_diagnostics_do_not_compensate_for_missing_stdout(self):
        stdout, stderr = b'out1\nout2\nout3\n', b'error\n'
        def copy(argv, **kw):
            kw['stdout'].write(stdout + stderr)
            return subprocess.CompletedProcess(argv, 0, stderr=b'streams 15 6\n')
        with patch.object(misc.subprocess, 'run', side_effect=copy):
            self.invoke()
        def history(box, cmd, which, offset, **kw):
            data = b'' if which == 'stdout' else b'offbox evidence wrapper pid=123456789\n' + stderr
            return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        result = self.invoke()
        self.assertIn('out1', result[1])
        self.assertIn('history behind box copy', result[2])
        def complete(box, cmd, which, offset, **kw):
            data = stdout if which == 'stdout' else b'offbox evidence wrapper pid=123456789\n' + stderr
            chunk = data[offset:offset + 2]
            return dict(data=chunk.decode(), nextOffset=offset + len(chunk), size=len(data),
                        done=offset + len(chunk) == len(data))
        self.history.side_effect = complete
        self.assertEqual(self.invoke()[2], '')
        self.assertIn(b'error', self.path.read_bytes())
        self.assertIsNotNone(common.checkpoint(self.path))

    def test_recovered_steps_and_disk_evidence_use_raw_sidecar(self):
        raw = b'offbox step 1 rc=7: check\n'
        def copy(argv, **kw):
            kw['stdout'].write(raw)
            return subprocess.CompletedProcess(argv, 0, stderr=b'streams 0 ' + str(len(raw)).encode() + b'\n')
        with patch.object(misc.subprocess, 'run', side_effect=copy):
            self.invoke()
        self.con.execute("UPDATE runs SET step_count=1,status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()
        self.assertEqual(runs.settled_steps_code(self.row(), 7, catch_up=False), 7)
        Path(str(self.path) + '.remote').write_bytes(b'write failed: No space left on device\n')
        runs.space_result('run-x', 1)
        self.assertEqual(common.read_json(self.path.with_suffix('.state.json'), {})['infra_failure'], 'enospc')

    def test_unknown_fallback_exit_is_named_unknown(self):
        self.con.execute("UPDATE runs SET status='lost',exit_code=NULL WHERE run_id='run-x'")
        self.con.commit()
        with patch.object(misc.subprocess, 'run', side_effect=self.copy):
            misc._catch_up_log(self.row())
        self.assertIn('remote exit unknown', misc._shown_log(self.path).read_text())
        self.assertNotIn('remote exit None', misc._shown_log(self.path).read_text())

    def test_remote_split_copy_is_read_with_both_stream_lengths(self):
        home = Path(self.tmp.name) / 'split-home'
        folder = home / '.offbox/out'
        folder.mkdir(parents=True)
        (folder / 'run-x.stdout').write_bytes(b'hello\n')
        (folder / 'run-x.stderr').write_bytes(b'error\n')
        real_run = subprocess.run
        def ssh(argv, **kw):
            return real_run(['bash', '-c', argv[-1]], env=clean_env(HOME=str(home)), **kw)
        with patch.object(ssh_sync, 'ssh_base', return_value=['ssh']), \
                patch.object(misc.subprocess, 'run', side_effect=ssh):
            result = self.invoke()
        self.assertIn('hello\nerror\n', result[1])
        meta = misc._remote_copy(self.path)
        self.assertEqual(meta['lengths'], [6, 6])
        self.assertTrue(meta['merged'])
        self.assertNotIn('stderr for this run', result[1])

    def test_initial_pid_diagnostic_still_fetches_the_box_copy(self):
        def history(box, cmd, which, offset, **kw):
            data = b'' if which == 'stdout' else b'offbox evidence wrapper pid=123456789\n'
            return dict(data=data[offset:].decode(), nextOffset=len(data), size=len(data), done=True)
        self.history.side_effect = history
        with patch.object(misc.subprocess, 'run', side_effect=self.copy), patch.object(misc.toollog, 'emit') as emit:
            result = self.invoke()
        self.assertIn('out1\nout2\nout3', result[1])
        self.assertIn('stderr for this run', result[1])
        self.assertIn('box copy', result[2])
        self.assertEqual(emit.call_args.args, ('run', 'run.log_stream_missing'))

    def test_first_recovered_disk_failure_is_classified_before_run_end(self):
        self.box('bx_a', member=True)
        for bookkeeping in (False, True):
            with self.subTest(bookkeeping=bookkeeping):
                for path in self.path.parent.glob('run-x.log*'):
                    path.unlink()
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                self.con.commit()
                def copy(argv, **kw):
                    kw['stdout'].write(b'write failed: No space left on device\n')
                    return subprocess.CompletedProcess(argv, 0, stderr=b'.ascii/processes/7.log\n')
                with patch.object(misc.subprocess, 'run', side_effect=copy):
                    runs.finish('run-x', 1, bookkeeping=bookkeeping)
                self.assertEqual(self.row()['status'], 'infra')
                saved = common.read_json(self.path.with_suffix('.state.json'), {})
                self.assertEqual(saved['infra_failure'], 'enospc')
                if bookkeeping:
                    detail = self.con.execute("SELECT detail FROM events WHERE kind='run_end'").fetchone()[0]
                    self.assertIn('status=infra', detail)

    def test_checkpointed_diagnostics_reserve_time_for_box_recovery(self):
        for budget in (None, 10):
            with self.subTest(budget=budget):
                for path in self.path.parent.glob('run-x.log*'):
                    path.unlink()
                prefix = b'offbox evidence wrapper pid=123456789\n'
                self.path.write_bytes(prefix)
                common.atomic_write_json(common.offsets_path(self.path),
                                         dict(stdoutOffset=0, stderrOffset=len(prefix), logBytes=len(prefix)))
                clock = [1000.0]
                def timeout(*args, **kw):
                    clock[0] = kw['deadline']
                    raise common.OffboxError('history request timed out')
                self.history.side_effect = timeout
                with patch.object(misc.time, 'time', side_effect=lambda: clock[0]), \
                        patch.object(misc.subprocess, 'run', side_effect=self.copy) as ssh:
                    result = (misc._catch_up_log(self.row()) if budget is None else
                              misc._catch_up_log(self.row(), budget=budget))
                ssh.assert_called_once()
                self.assertIn('box copy', result)
                self.assertIn('out1', misc._shown_log(self.path).read_text())


class PartialHistoryReviewTests(_BackgroundOutputFixture):
    def setUp(self):
        super().setUp()
        self.box_get.return_value = dict(state='running')
        self.con.execute("UPDATE runs SET status='failed',exit_code=7 WHERE run_id='run-x'")
        self.con.commit()

    def reset_log(self, prefix):
        for path in self.path.parent.glob('run-x.log*'):
            path.unlink()
        self.path.write_bytes(prefix)
        common.atomic_write_json(common.offsets_path(self.path),
                                 dict(stdoutOffset=len(prefix), stderrOffset=0, logBytes=len(prefix)))

    def test_checkpointed_partial_history_recovers_with_ssh_budget(self):
        for failure in ('error', 'no_progress', 'timeout'):
            for budget in (None, 10):
                for verified in (False, True):
                    with self.subTest(failure=failure, budget=budget, verified=verified):
                        self.reset_log(b'out1\n')
                        clock = [1000.0]
                        stdout, stderr = b'out1\n', b'actual failure\n'
                        def history(box, cmd, which, offset, **kw):
                            if which == 'stdout':
                                return dict(data='', nextOffset=offset, size=offset, done=True)
                            if failure == 'timeout':
                                clock[0] = kw['deadline']
                                raise common.OffboxError('stderr timeout')
                            if failure == 'error':
                                raise common.OffboxError('stderr temporarily unavailable')
                            return dict(data='', nextOffset=offset, size=100, done=False)
                        self.history.side_effect = history
                        def copy(argv, **kw):
                            kw['stdout'].write(stdout + stderr if verified else stdout)
                            meta = f'streams {len(stdout)} {len(stderr)}\n'.encode() if verified else b'.ascii/processes/7.log\n'
                            return subprocess.CompletedProcess(argv, 0, stderr=meta)
                        with patch.object(misc.time, 'time', side_effect=lambda: clock[0]), \
                                patch.object(misc.subprocess, 'run', side_effect=copy) as ssh, \
                                patch.object(misc.toollog, 'emit') as emit:
                            result = (misc._catch_up_log(self.row()) if budget is None else
                                      misc._catch_up_log(self.row(), budget=budget))
                        ssh.assert_called_once()
                        self.assertGreater(ssh.call_args.kwargs['timeout'], 0)
                        shown = misc._shown_log(self.path).read_bytes()
                        self.assertIn('box copy', result)
                        self.assertIn(b'out1\n', shown)
                        if verified:
                            self.assertIn(stderr, shown)
                            self.assertNotIn(b'output shows stdout only', shown)
                        else:
                            self.assertIn(b'stderr for this run could not be fetched', shown)
                            emit.assert_called_once()
                            self.assertEqual(emit.call_args.args, ('run', 'run.log_stream_missing'))
                        self.assertEqual(self.path.read_bytes(), stdout)

    def test_follow_switch_to_remote_copy_uses_its_own_delivery_position(self):
        for prefix_stream, prefix in (('stderr', b'offbox evidence wrapper pid=123456789\n'),
                                      ('stdout', b'FIRST-OUTPUT-LINE\n')):
            with self.subTest(prefix_stream=prefix_stream):
                self.reset_log(b'')
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-x'")
                self.con.commit()
                raw = b'FIRST-OUTPUT-LINE\nactual failure\n'
                def retained(argv, **kw):
                    kw['stdout'].write(raw)
                    return subprocess.CompletedProcess(argv, 0,
                        stderr=f'streams {len(b"FIRST-OUTPUT-LINE\n")} {len(b"actual failure\n")}\n'.encode())
                self.history.side_effect = common.OffboxError('history unavailable')
                frames = [dict(type=prefix_stream, data=prefix.decode(), nextOffset=len(prefix)),
                          dict(type='exit', exitCode=7)]
                output_bytes, errors_bytes = io.BytesIO(), io.BytesIO()
                output = io.TextIOWrapper(output_bytes, write_through=True)
                errors = io.TextIOWrapper(errors_bytes, write_through=True)
                self.addCleanup(output.close)
                self.addCleanup(errors.close)
                with patch.object(runs, '_ttl_keeper'), patch.object(misc, '_refresh_running_ttl'), \
                        patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                        patch.object(misc.subprocess, 'run', side_effect=retained), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    code = misc.logs('run-x', True)
                self.assertEqual(code, 7)
                self.assertIn(raw, output_bytes.getvalue())
                view = misc._shown_log(self.path)
                self.assertNotEqual(view, self.path)
                self.assertEqual(common.delivered_bytes(view), view.stat().st_size)
                self.assertEqual(common.delivered_bytes(self.path), len(prefix))
                self.assertNotIn('actual failure', self.invoke(wait=True)[1])

    def test_settled_sidecar_cursor_and_full_log_reads_stay_independent(self):
        prefix = b'offbox evidence wrapper pid=123456789\n'
        self.reset_log(prefix)
        raw = b'FIRST-OUTPUT-LINE\nactual failure\n'
        view = Path(str(self.path) + '.remote.view')
        Path(str(self.path) + '.remote').write_bytes(raw)
        view.write_bytes(raw)
        common.atomic_write_json(Path(str(self.path) + '.remote.json'),
                                 dict(source='fixture', merged=True, exit_code=7))
        common.record_delivery(view, len(b'FIRST-OUTPUT-LINE\n'))
        self.history.side_effect = common.OffboxError('history unavailable')
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc._settled(self.row(), echo=True, pos=len(prefix)), 7)
        self.assertNotIn('FIRST-OUTPUT-LINE', output.getvalue())
        self.assertIn('actual failure\n', output.getvalue())
        # Explicit logs still starts at zero, regardless of either delivery cursor.
        self.assertIn(raw.decode(), self.invoke()[1])

    def test_tail_reads_only_the_file_its_position_and_limit_describe(self):
        self.reset_log(b'ABCDEF')
        raw = Path(str(self.path) + '.remote')
        view = Path(str(self.path) + '.remote.view')
        raw.write_bytes(b'other output\n')
        view.write_bytes(b'other output\n')
        common.atomic_write_json(Path(str(self.path) + '.remote.json'), dict(source='fixture', merged=True))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(misc._tail(self.path, 2, True, limit=4), 4)
        self.assertEqual(output.getvalue(), 'CD')
        self.assertEqual(common.delivered_bytes(self.path), 4)
        self.assertEqual(common.delivered_bytes(view), 0)

    def test_late_history_preserves_delivery_from_a_mixed_live_prefix(self):
        stdout, stderr = b'out1\nout2\nout3\n', b'err1\nerr2\nerr3\n'
        for prefix in (b'err1\nout1\n', b'out1\nerr1\n', b'out1\nerr1\nout2\nerr2\n'):
            for reader in ('wait', 'follow', 'late-reader'):
                for verified in (False, True):
                    with self.subTest(prefix=prefix, reader=reader, verified=verified):
                        self.reset_log(prefix)
                        count = prefix.count(b'out') * len(b'out1\n')
                        common.atomic_write_json(common.offsets_path(self.path),
                            dict(stdoutOffset=count, stderrOffset=count, logBytes=len(prefix)))
                        with contextlib.redirect_stdout(io.StringIO()):
                            misc._tail(self.path, 0, True)
                        self.history.side_effect = common.OffboxError('history unavailable')
                        def copy(argv, **kw):
                            kw['stdout'].write(stdout + stderr if verified else stdout)
                            source = f'streams {len(stdout)} {len(stderr)}\n'.encode() if verified else b'process log\n'
                            return subprocess.CompletedProcess(argv, 0, stderr=source)
                        with patch.object(misc.subprocess, 'run', side_effect=copy):
                            self.assertIn('box copy', misc._catch_up_log(self.row()))
                        self.assertEqual(common.delivered_bytes(misc._shown_log(self.path)), 0)
                        def history(box, cmd, which, offset, **kw):
                            data = stdout if which == 'stdout' else stderr
                            nxt = min(len(data), offset + (3 if reader == 'late-reader' else len(data)))
                            return dict(data=data[offset:nxt].decode(), nextOffset=nxt, size=len(data), done=nxt == len(data))
                        self.history.side_effect = history
                        output = io.StringIO()
                        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                            if reader == 'follow':
                                self.assertEqual(misc._settled(self.row(), echo=True, pos=len(prefix)), 7)
                            else:
                                if reader == 'late-reader':
                                    self.assertIn(misc._catch_up_log(self.row()), ('caught_up', 'complete'))
                                    common.record_delivery(self.path, len(prefix))
                                self.assertEqual(misc.wait('run-x', None), 7)
                        unread = stdout[count:] + stderr[count:]
                        self.assertIn(unread.decode(), output.getvalue())
                        self.assertNotIn('incomplete', output.getvalue())
                        self.assertEqual(self.path.read_bytes(), prefix + unread)
                        self.assertEqual(common.delivered_bytes(self.path), len(prefix + unread))
                        self.assertNotIn('out3', self.invoke(wait=True)[1])

    def test_live_reader_with_retained_copy_waits_for_both_history_streams(self):
        prefix = b'err1\nout1\n'
        self.reset_log(prefix)
        common.atomic_write_json(common.offsets_path(self.path),
                                 dict(stdoutOffset=5, stderrOffset=5, logBytes=len(prefix)))
        self.history.side_effect = common.OffboxError('history unavailable')
        def copy(argv, **kw):
            kw['stdout'].write(b'out1\nout2\nerr1\nerr2\n')
            return subprocess.CompletedProcess(argv, 0, stderr=b'streams 10 10\n')
        with patch.object(misc.subprocess, 'run', side_effect=copy):
            misc._catch_up_log(self.row())
        checkpoint = common.offsets_path(self.path).read_bytes()
        def history(box, cmd, which, offset, **kw):
            if which == 'stderr':
                raise common.OffboxError('stderr unavailable')
            return dict(data='out1\nout2\n', nextOffset=10, size=10, done=True)
        self.history.side_effect = history
        stale = dict(self.row(), status='running', exit_code=None)
        self.assertIn('incomplete:', misc._catch_up_log(stale, live=True))
        self.assertEqual(self.path.read_bytes(), prefix)
        self.assertEqual(common.offsets_path(self.path).read_bytes(), checkpoint)
