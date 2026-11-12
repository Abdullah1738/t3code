"""Dropped push connections retry before any command starts, including after a box stops."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, lease, pool, runs, ssh_sync
from offbox_lib.common import OffboxError
from test_box_owned_files import DENIED
from test_capacity import Isolated


class SyncRetryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='offbox-retry-test-')
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.src, self.remote = self.base / 'src', self.base / 'remote'
        self.src.mkdir()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        subprocess.run(['git', '-C', str(self.src), 'init', '-q', '--template='], check=True)
        (self.src / 'a.txt').write_text('a\n')
        self.config = self.base / 'config'
        self.write_endpoint('old.example', 22)
        self.stack.enter_context(patch.object(ssh_sync, 'cfg_path', return_value=self.config))
        self.stack.enter_context(patch.object(ssh_sync, 'RETRY_PAUSES', (0, 0, 0)))
        self.close = self.stack.enter_context(patch.object(ssh_sync, 'close_master'))
        self.setup = self.stack.enter_context(patch.object(ssh_sync, 'setup'))
        self.state = self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'ready'}))
        self.log = self.stack.enter_context(patch.object(ssh_sync, 'log'))
        clock = self.stack.enter_context(patch.object(ssh_sync, 'time', wraps=ssh_sync.time))
        self.sleep = clock.sleep
        self.sleep.return_value = None
        self.stderr = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stderr(self.stderr))
        self.real_run = subprocess.run
        self.failures, self.rsyncs = [], []
        self.stack.enter_context(patch.object(ssh_sync.subprocess, 'run', side_effect=self.run_local))
        self.ssh = self.stack.enter_context(patch.object(ssh_sync, 'ssh', side_effect=self.ssh_local))

    def write_endpoint(self, host, port):
        self.config.write_text(f'Host testbox\n  HostName {host}\n  Port {port}\n')

    def run_local(self, cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            self.rsyncs.append((list(cmd), kwargs))
            if self.failures:
                failure = self.failures.pop(0)
                if isinstance(failure, Exception):
                    raise failure
                return subprocess.CompletedProcess(cmd, failure[0], '', failure[1])
            cmd = list(cmd)
            cmd[-1] = cmd[-1].removeprefix('testbox:')
        return self.real_run(cmd, **kwargs)

    def ssh_local(self, box, command, **kwargs):
        return self.real_run(['sh', '-c', command], capture_output=True, check=kwargs.get('check', False))

    def push(self):
        return ssh_sync.push('testbox', self.src, str(self.remote))

    def retry_lines(self):
        return [line for line in self.stderr.getvalue().splitlines() if line.startswith('offbox: rsync exit')]

    def test_broken_pipe_twice_then_success(self):
        self.failures = [(255, 'Broken pipe')] * 2
        self.push()
        self.assertEqual((self.remote / 'a.txt').read_text(), 'a\n')
        self.assertEqual(len(self.rsyncs), 3)
        self.assertEqual(self.retry_lines(), [
            'offbox: rsync exit 255 to testbox, retry 1/3 in 0s',
            'offbox: rsync exit 255 to testbox, retry 2/3 in 0s'])
        self.assertEqual(self.close.call_count, 2)
        self.assertEqual(self.setup.call_count, 2)
        self.assertEqual(self.state.call_count, 2)
        self.log.assert_any_call('push_retry testbox exit=255 try=2')

    def test_closed_connection_refreshes_endpoint_without_connect_text(self):
        self.failures = [(255, 'rsync: connection unexpectedly closed (248 bytes received so far) [sender]')]
        self.setup.side_effect = lambda box: self.write_endpoint('new.example', 19041)
        self.push()
        self.log.assert_any_call('push_retry testbox exit=255 try=1 endpoint=old.example:22 -> new.example:19041')
        self.assertEqual(len(self.rsyncs), 2)

    def test_connect_timeout_refreshes_before_retry(self):
        self.failures = [(255, 'ssh: connect to host 1.2.3.4 port 1: Operation timed out')]
        def refresh(box):
            self.assertEqual(len(self.rsyncs), 1)
            self.close.assert_called_once_with(box)
        self.setup.side_effect = refresh
        self.push()
        self.setup.assert_called_once_with('testbox')
        self.assertEqual(len(self.rsyncs), 2)

    def test_failed_refresh_or_master_close_does_not_prevent_retry(self):
        for failure in (OffboxError('offline'), OSError('offline'), subprocess.TimeoutExpired('ssh', 1)):
            with self.subTest(failure=failure):
                self.failures = [(255, 'Broken pipe')]
                self.setup.side_effect = self.close.side_effect = failure
                self.push()
        self.assertEqual(len(self.rsyncs), 6)

    def test_stopped_box_raises_before_sleep_even_when_refresh_fails(self):
        for state in ('archived', 'archiving', 'provisioning', 'error'):
            with self.subTest(state=state):
                self.failures = [(255, 'connection unexpectedly closed')]
                self.setup.side_effect = OffboxError('machine not running')
                self.state.return_value = {'state': state}
                before = len(self.rsyncs)
                with self.assertRaises(ssh_sync.BoxStoppedDuringPush) as cm:
                    self.push()
                self.assertEqual(cm.exception.box, 'testbox')
                self.assertEqual(len(self.rsyncs), before + 1)
                self.sleep.assert_not_called()
                self.log.assert_any_call('push_retry_box_not_running testbox')

    def test_unknown_state_keeps_connection_retry(self):
        for state in ({}, None, OffboxError('state unreadable')):
            with self.subTest(state=state):
                self.failures = [(255, 'Broken pipe')]
                self.state.side_effect = state if isinstance(state, Exception) else None
                self.state.return_value = state
                self.push()
        self.assertEqual(len(self.rsyncs), 6)

    def test_code_12_exhausts_three_retries(self):
        self.failures = [(12, 'connection unexpectedly closed')] * 4
        with self.assertRaisesRegex(OffboxError, r'failed \(12\)') as cm:
            self.push()
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(len(self.rsyncs), 4)
        self.assertEqual(len(self.retry_lines()), 3)
        self.assertEqual(self.setup.call_count, 3)

    def test_exhausted_255_keeps_error_and_uses_backoff_schedule(self):
        self.failures = [(255, 'Broken pipe')] * 4
        with patch.object(ssh_sync, 'RETRY_PAUSES', (5, 15, 45)):
            with self.assertRaisesRegex(OffboxError, r'failed \(255\): Broken pipe'):
                self.push()
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [5, 15, 45])
        self.assertEqual(len(self.rsyncs), 4)
        self.assertEqual(self.close.call_count, 3)
        self.assertEqual(self.setup.call_count, 3)

    def test_stop_on_final_attempt_still_requests_resume(self):
        for code in (255, 12):
            with self.subTest(code=code):
                self.failures = [(code, 'connection unexpectedly closed')] * 4
                self.state.side_effect = [{'state': 'ready'}] * 3 + [{'state': 'archived'}]
                self.setup.reset_mock()
                self.sleep.reset_mock()
                before = len(self.rsyncs)
                with self.assertRaises(ssh_sync.BoxStoppedDuringPush):
                    self.push()
                self.assertEqual(len(self.rsyncs), before + 4)
                self.assertEqual(self.setup.call_count, 3)
                self.assertEqual(self.sleep.call_count, 3)

    def test_cancellation_and_generic_partial_never_retry(self):
        for code in (20, 23):
            with self.subTest(code=code):
                self.failures = [(code, 'generic error')]
                before = len(self.rsyncs)
                with self.assertRaisesRegex(OffboxError, rf'failed \({code}\)'):
                    self.push()
                self.assertEqual(len(self.rsyncs), before + 1)
                self.setup.assert_not_called()
                self.close.assert_not_called()
                self.sleep.assert_not_called()

    def test_rsync_timeout_propagates_without_retry(self):
        self.failures = [subprocess.TimeoutExpired('rsync', 1)]
        with self.assertRaises(subprocess.TimeoutExpired):
            self.push()
        self.assertEqual(len(self.rsyncs), 1)
        self.setup.assert_not_called()

    def test_reclaimed_transfer_also_retries_connection_drop(self):
        self.failures = [(23, DENIED), (255, 'Broken pipe')]
        with patch.object(ssh_sync, '_reclaim', return_value=True) as reclaim:
            self.push()
        reclaim.assert_called_once_with('testbox', str(self.remote))
        self.setup.assert_called_once_with('testbox')
        self.assertEqual(len(self.rsyncs), 3)

    def test_tracked_ignored_pass_replays_its_file_list(self):
        (self.src / '.gitignore').write_text('a.txt\n')
        self.real_run(['git', '-C', str(self.src), 'add', '-f', 'a.txt'], check=True)
        self.failures = [(0, ''), (255, 'Broken pipe')]
        self.push()
        self.assertEqual((self.remote / 'a.txt').read_text(), 'a\n')
        self.assertEqual([kwargs['input'] for _, kwargs in self.rsyncs], [None, 'a.txt', 'a.txt'])

    def test_git_metadata_retries_into_same_staging_directory(self):
        self.remote.mkdir()
        self.failures = [(255, 'Broken pipe')]
        ssh_sync._push_git('testbox', self.src / '.git', str(self.remote), 30)
        self.assertTrue((self.remote / '.git/HEAD').is_file())
        self.assertEqual(len(self.rsyncs), 2)
        self.assertEqual(self.rsyncs[0][0], self.rsyncs[1][0])
        self.setup.assert_called_once_with('testbox')


class PushResumeTests(Isolated):
    def setUp(self):
        super().setUp()
        self.box('box', member=True)
        self.guard = MagicMock()
        self.row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='box'").fetchone(),
                        remote_dir='w/caller-abcdef', _guard=self.guard)
        self.stack.enter_context(patch.object(pool, 'acquire', return_value=self.row))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.Runner, '_check_box', return_value=None))
        self.stack.enter_context(patch.object(runs, 'new_checkout_hint'))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: boat called')))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}))
        self.resume = self.stack.enter_context(patch.object(lease, '_resume_confirmed', return_value=(None, False)))
        self.bring_up = self.stack.enter_context(patch.object(lease, '_bring_up_resumed', return_value={'type': 'large'}))
        self.put_file = self.stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.push = self.stack.enter_context(patch.object(ssh_sync, 'push'))
        self.stack.enter_context(patch.object(ssh_sync, 'tracked_secret_matches', return_value=[]))
        self.command = self.stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7}))
        self.log = self.stack.enter_context(patch.object(runs, 'log'))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def runner(self, *args):
        return runs.Runner(cli.build_parser().parse_args(['run', *args, '--', 'true']), self.me)

    def assert_resumed_start(self):
        self.push.side_effect = [ssh_sync.BoxStoppedDuringPush('box'), {}]
        rn = self.runner()
        row = rn.start()
        self.assertEqual(row['remote_dir'], 'w/caller-abcdef')
        self.assertIs(row['_guard'], self.guard)
        self.resume.assert_called_once_with(unittest.mock.ANY, 'box', common.RUN_TTL_S, None, retry=True)
        self.bring_up.assert_called_once()
        self.assertEqual(self.push.call_count, 2)
        self.assertEqual(self.put_file.call_count, 2)
        self.command.assert_called_once()
        self.assertTrue(rn.started)
        self.log.assert_called_once_with('push_box_stopped_resumed box')

    def test_stopped_during_push_resumes_once_then_starts_command(self):
        self.assert_resumed_start()

    def test_second_stop_is_infra_and_never_starts_command(self):
        self.push.side_effect = ssh_sync.BoxStoppedDuringPush('box')
        rn = self.runner()
        with self.assertRaisesRegex(OffboxError, 'box stopped during push') as cm:
            rn.start()
        self.assertEqual(cm.exception.code, 90)
        self.resume.assert_called_once()
        self.assertEqual(self.push.call_count, 2)
        self.command.assert_not_called()
        self.assertFalse(rn.started)

    def test_resume_failure_retains_error_and_does_not_push_or_start_again(self):
        self.push.side_effect = ssh_sync.BoxStoppedDuringPush('box')
        self.resume.side_effect = OffboxError('resume refused')
        with self.assertRaisesRegex(OffboxError, 'resume refused; box stopped during push') as cm:
            self.runner().start()
        self.assertEqual(cm.exception.code, 90)
        self.resume.assert_called_once()
        self.push.assert_called_once()
        self.command.assert_not_called()

    def test_failed_environment_upload_is_repeated_after_resume(self):
        self.put_file.side_effect = [OffboxError('ssh env upload failed'), None]
        self.assert_resumed_start()

    def test_live_box_recovered_push_repeats_failed_environment_upload(self):
        self.push.return_value = {}
        self.put_file.side_effect = [OffboxError('ssh box failed (255): Broken pipe'), None]
        self.runner().start()
        self.assertEqual(self.put_file.call_count, 2)
        self.push.assert_called_once()
        self.resume.assert_not_called()
        self.command.assert_called_once()

    def test_repeated_environment_failure_still_prevents_command(self):
        self.push.return_value = {}
        self.put_file.side_effect = [OffboxError('Broken pipe'), OffboxError('upload still failed')]
        with self.assertRaisesRegex(OffboxError, 'upload still failed') as cm:
            self.runner().start()
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(self.put_file.call_count, 2)
        self.command.assert_not_called()

    def test_no_sync_environment_failure_is_unchanged(self):
        self.put_file.side_effect = OffboxError('env upload failed')
        with self.assertRaisesRegex(OffboxError, 'env upload failed'):
            self.runner('--no-sync').start()
        self.put_file.assert_called_once()
        self.push.assert_not_called()
        self.command.assert_not_called()

    def test_retried_environment_dead_mount_sets_aside_box_and_replaces_it(self):
        self.assert_env_dead_mount_replaced([OffboxError('Broken pipe'),
                                            OffboxError('Transport endpoint is not connected'), None])

    def test_initial_environment_dead_mount_is_not_retried_on_same_box(self):
        self.assert_env_dead_mount_replaced([OffboxError('Transport endpoint is not connected'), None])

    def assert_env_dead_mount_replaced(self, uploads):
        self.box('replacement', member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='replacement'").fetchone(),
                   remote_dir='w/caller-abcdef', _guard=MagicMock())
        self.push.return_value = {}
        self.put_file.side_effect = uploads
        with patch.object(pool, 'acquire', side_effect=[self.row, row]), \
                patch.object(api, 'stop', return_value={}) as stop, patch.object(ssh_sync, 'close_master'):
            result = self.runner().start()
        self.assertEqual(result['box_id'], 'replacement')
        stop.assert_called_once_with('box')
        note = self.con.execute("SELECT note FROM leases WHERE box_id='box'").fetchone()[0]
        self.assertTrue(note.startswith('dead-mount:'))
        self.assertEqual(self.put_file.call_count, len(uploads))
        self.command.assert_called_once()
        self.assertEqual(self.command.call_args.args[0], 'replacement')


if __name__ == '__main__':
    unittest.main()
