"""Detached runs retain output at settlement and never silently pass with an empty log."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
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
                                                                 env=dict(os.environ, HOME=str(home)), **kw)
                        code, out, err = self.invoke()
                    self.assertEqual((code, out), (0, remote.read_text()))
                    self.assertEqual(self.path.read_bytes(), remote.read_bytes())
                    self.assertIsNone(common.checkpoint(self.path))
                    self.assertIn('no stream checkpoint', err)
                    remote.unlink()

    def test_stuck_empty_page_falls_back_without_looping(self):
        self.history.side_effect = lambda *a, **kw: dict(data='', nextOffset=0, size=6, done=False)
        code, out, err = self.invoke()
        self.assertEqual((code, out), (1, ''))
        self.assertIn('no output recorded', err)
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

    def test_follow_delivers_settlement_output_once_and_wait_stays_quiet(self):
        for caller in ('follow', 'wait', 'direct_follow'):
            for source, live_prefix in (('history', ''), ('history', 'live\n'), ('remote', ''), ('empty', '')):
                for exit_code in (0, 7):
                    with self.subTest(caller=caller, source=source, live_prefix=live_prefix, exit_code=exit_code):
                        self.path.unlink(missing_ok=True)
                        common.offsets_path(self.path).unlink(missing_ok=True)
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
                        expected = (content if caller != 'wait' else '') + f'run-x: exit={exit_code}\n'
                        self.assertEqual(out_bytes.getvalue().decode(), expected)
                        if source == 'empty':
                            self.assertIn('no output on record', err.getvalue())

    def test_fallback_ssh_failure_leaves_empty_log_and_warns(self):
        self.box_get.return_value = dict(state='running')
        with patch.object(misc.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 1)):
            self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.path.read_bytes(), b'')
        self.assertFalse(list(self.path.parent.glob('*.remote.*')))

    def test_stopped_deleted_and_busy_boxes_are_not_accessed_over_ssh(self):
        for box in (None, dict(state='archived'), dict(state='running')):
            with self.subTest(box=box):
                self.box_get.return_value = box
                guard = common.file_lock('box-bx_a', timeout=0) if box and box['state']=='running' else contextlib.nullcontext()
                with guard, patch.object(misc.subprocess, 'run', side_effect=AssertionError('no ssh')):
                    self.assertEqual(self.invoke()[0], 1)

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
            self.assertEqual(runner.log_path.read_bytes(), b'hello\nerror\n')
