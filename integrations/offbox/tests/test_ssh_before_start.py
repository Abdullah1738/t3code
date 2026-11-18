"""A disconnected pre-start transfer retains its pool guard and its public run."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill' / 'scripts'))
from offbox_lib import api, bases, cli, common, fallback, home, lease, pool, prepare, runs, ssh_outage, ssh_sync
if __package__:
    from .client_fixtures import Isolated, FakeClock
else:
    from client_fixtures import Isolated, FakeClock

CONNECT = 'ssh: connect to host 100.75.104.72 port 22066: Operation timed out'


class SshBeforeStartTests(Isolated):
    def setUp(self):
        super().setUp()
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('unexpected API call')))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.home_probe = self.stack.enter_context(patch.object(ssh_sync, 'probe_home', return_value=(None, None)))
        self.stack.enter_context(patch.object(runs.prune, 'run', return_value=runs.prune.Result()))
        self.stack.enter_context(patch.object(runs.box_disk, 'measure', return_value={}))
        self.stack.enter_context(patch.object(runs.quint_tools, 'ensure_archive'))
        self.stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.stack.enter_context(patch.object(ssh_sync, 'tracked_secret_matches', return_value=[]))
        self.stack.enter_context(patch.object(runs, 'new_checkout_hint'))
        self.stack.enter_context(patch.object(runs.node_version, 'want', return_value=None))
        self.stack.enter_context(patch.object(runs, '_seed_candidates', return_value=[]))
        self.stack.enter_context(patch.object(fallback, 'note_infra_failure'))
        self.stack.enter_context(patch.object(ssh_outage, 'tailnet', return_value={'up': True, 'detail': 'running'}))
        self.clock = FakeClock()
        self.stack.enter_context(patch.object(ssh_outage, 'time', self.clock.time))
        self.stack.enter_context(patch.object(runs, 'time', self.clock.time))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_OUTAGE_WAIT_SECONDS': '20'}))
        self.command = self.stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7}))
        self.box('same', member=True)
        self.guard = None

        def acquire(*args, **kwargs):
            self.guard = common.file_lock('box-same', timeout=0)
            self.guard.__enter__()
            row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='same'").fetchone())
            return dict(row, _guard=self.guard)
        self.real_acquire = pool.acquire
        self.acquire = self.stack.enter_context(patch.object(pool, 'acquire', side_effect=acquire))
        self.real_push = ssh_sync.push
        self.push = self.stack.enter_context(patch.object(ssh_sync, 'push'))
        self.probe = self.stack.enter_context(patch.object(ssh_outage, 'reachable'))

    def fail_push(self, *args, **kwargs):
        ssh_outage.classify(args[0], 255, CONNECT)

    def run_case(self, flags=('--bg',), command=('true',)):
        args = cli.parse_args(['run', *flags, '--', *command])
        # Use the acknowledged detached-client path; do not spawn another interpreter.
        if args.bg:
            self.stack.enter_context(patch.object(runs, '_background', side_effect=runs._run_attempt))
        return cli.cmd_run(args, self.me)

    def test_retry_keeps_the_same_guard_and_box_until_command_starts(self):
        pushed = []
        def push(box, *args, **kwargs):
            pushed.append(box)
            if len(pushed) == 1:
                self.fail_push(box)
            return {}
        def probe(box, timeout):
            self.assertEqual(box, 'same')
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-same', timeout=0):
                    pass
            return (self.probe.call_count == 2, 'box_ssh_unreachable')
        self.push.side_effect = push
        self.probe.side_effect = probe
        self.stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
        self.assertEqual(self.run_case(), 0, self.err.getvalue())
        self.assertEqual(pushed, ['same', 'same'])
        self.assertEqual(self.acquire.call_count, 1)
        self.home_probe.assert_called_once()
        self.command.assert_called_once()
        self.assertEqual(self.command.call_args.args[0], 'same')
        self.assertIn('holding the box', self.err.getvalue())
        self.assertIn('retrying preparation on the same box', self.err.getvalue())
        self.assertIn('outcome=retried', common.LOG_PATH.read_text())
        with common.file_lock('box-same', timeout=0):
            pass

    def test_give_up_records_reason_exit_and_nothing_ran_for_both_causes(self):
        for reason in ('tailnet_down', 'box_ssh_unreachable'):
            with self.subTest(reason=reason):
                self.push.side_effect = self.fail_push
                self.probe.return_value = False, reason
                self.command.reset_mock()
                self.assertEqual(self.run_case(), 90)
                row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
                state = json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())
                self.assertEqual(row['exit_code'], 90)
                self.assertTrue(state['infra_failure'], self.err.getvalue())
                self.assertEqual(state['infra_reason'], 'ssh_unreachable_before_start:' + reason)
                self.assertEqual(state['resources']['reason'], 'not_started')
                self.command.assert_not_called()
                self.assertIn('nothing ran', self.err.getvalue())
                self.assertIn('waited 20s', self.err.getvalue())
                self.assertIn('a plain remote retry is safe', self.err.getvalue())
                runs.space_result(row['run_id'], 90)
                self.assertEqual(json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())['infra_reason'],
                                 'ssh_unreachable_before_start:' + reason)
                self.assertIn('outcome=gave_up', common.LOG_PATH.read_text())

    def test_small_foreground_still_falls_back_without_waiting(self):
        self.push.side_effect = self.fail_push
        with patch.object(fallback, 'run_local', return_value=0) as local:
            self.assertEqual(self.run_case(flags=()), 0)
        local.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_not_called()

    def test_connect_failure_around_preparation_expiry_keeps_box_and_reason(self):
        self.clock.time.time = lambda: self.clock.t
        for module in (api, lease, prepare):
            self.stack.enter_context(patch.object(module, 'time', self.clock.time))
        acquire = self.acquire.side_effect
        self.acquire.side_effect = lambda *args, **kwargs: dict(acquire(*args, **kwargs),
                                                               _prepare_end=self.clock.t + 5)
        for phase, seconds in (('check', 5), ('push', 3600)):
            for offset in (-1, 0, 1):
                for recover in (True, False):
                    with self.subTest(phase=phase, offset=offset, recover=recover), contextlib.ExitStack() as stack:
                        self.acquire.reset_mock()
                        self.command.reset_mock()
                        self.push.reset_mock(side_effect=True)
                        self.push.return_value = {}
                        self.probe.reset_mock(side_effect=True)
                        attempts = []
                        def operation(*args, **kwargs):
                            attempts.append('same')
                            if len(attempts) == 1:
                                self.clock.sleep(seconds + offset)
                                self.fail_push('same')
                            return {} if phase == 'push' else None
                        if phase == 'check':
                            stack.enter_context(patch.object(runs.Runner, '_check_box', side_effect=operation))
                        else:
                            self.push.side_effect = operation
                        def reachable(box, timeout):
                            self.assertEqual(box, 'same')
                            with self.assertRaises(common.OffboxError):
                                with common.file_lock('box-same', timeout=0):
                                    pass
                            return recover, 'box_ssh_unreachable'
                        self.probe.side_effect = reachable
                        stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
                        self.assertEqual(self.run_case(), 0 if recover else 90,
                                         self.err.getvalue())
                        self.acquire.assert_called_once()
                        self.assertGreater(self.probe.call_count, 0)
                        self.assertEqual(attempts, ['same', 'same'] if recover else ['same'])
                        if recover:
                            self.command.assert_called_once()
                            self.assertEqual(self.command.call_args.args[0], 'same')
                        else:
                            self.command.assert_not_called()
                            row = self.con.execute('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').fetchone()
                            state = json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())
                            self.assertTrue(state['infra_failure'])
                            self.assertEqual(state['infra_reason'],
                                             'ssh_unreachable_before_start:box_ssh_unreachable')

    def test_foreground_remote_no_fallback_and_heavy_wait(self):
        for flags, command in ((('--remote',), ('true',)), (('--no-fallback',), ('true',)),
                               ((), ('make', 'test'))):
            with self.subTest(flags=flags, command=command):
                self.push.side_effect = self.fail_push
                self.probe.return_value = False, 'box_ssh_unreachable'
                self.assertEqual(self.run_case(flags, command), 90)
                self.assertGreater(self.probe.call_count, 0)
                self.probe.reset_mock()

    def test_no_sync_upload_recovers_on_the_same_box(self):
        for transport, failed_file in (('inline', 'env'), ('file', 'env'), ('file', 'command')):
            with self.subTest(transport=transport, failed_file=failed_file):
                script = 'true\n' * (1 if transport == 'inline' else runs.COMMAND_INLINE_MAX // 5 + 1)
                uploaded, failed = [], False
                def upload(box, path, *args, **kwargs):
                    nonlocal failed
                    kind = 'command' if '/.offbox/cmd/' in path else 'env'
                    uploaded.append((box, kind))
                    if kind == failed_file and not failed:
                        failed = True
                        raise ssh_outage.SshUnreachable(box, CONNECT, reason='tailnet_down')
                self.probe.return_value = True, 'box_ssh_unreachable'
                self.acquire.reset_mock()
                self.command.reset_mock()
                self.probe.reset_mock()
                with patch.object(ssh_sync, 'put_file', side_effect=upload), \
                        patch.object(runs, 'remote_script', return_value=script), \
                        patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
                    self.assertEqual(self.run_case(flags=('--bg', '--no-sync')), 0, self.err.getvalue())
                expected = ['env', 'env']
                if transport == 'file':
                    expected = (['env', 'env', 'command'] if failed_file == 'env'
                                else ['env', 'command', 'env', 'command'])
                self.assertEqual(uploaded, [('same', kind) for kind in expected])
                self.push.assert_not_called()
                self.assertEqual(self.acquire.call_count, 1)
                self.assertEqual(self.probe.call_count, 1)
                self.command.assert_called_once()

    def test_ssh_handshake_retries_are_paced_and_hold_progress_is_throttled(self):
        self.push.side_effect = self.fail_push
        self.probe.return_value = True, 'box_ssh_unreachable'
        with patch.dict(os.environ, {'OFFBOX_OUTAGE_WAIT_SECONDS': '125'}):
            self.assertEqual(self.run_case(), 90)
        self.assertEqual(self.probe.call_count, 13)
        self.assertEqual(self.err.getvalue().count('holding the box'), 3)
        self.assertEqual(self.acquire.call_count, 1)
        self.command.assert_not_called()

    def acquisition_fixture(self, *, recover):
        cfg = Path(self.tmp.name) / 'ssh_config'
        cfg.write_text('Host same\n HostName 100.75.1.1\n Port 22066\n')
        self.stack.enter_context(patch.object(ssh_sync, 'cfg_path', return_value=cfg))
        self.stack.enter_context(patch.object(lease, '_readiness_get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(lease, 'idle_for', return_value=1800))
        self.stack.enter_context(patch.object(pool, 'acquire', wraps=self.real_acquire))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(lease, 'cap_check'))
        self.push.return_value = {}
        self.probe.side_effect = lambda *args: (self.probe.call_count >= 2 and recover, 'box_ssh_unreachable')
        real_run = subprocess.run
        attempts = []
        def run(argv, **kwargs):
            if argv[0] != 'ssh':
                return real_run(argv, **kwargs)
            attempts.append(argv)
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-same', timeout=0):
                    pass
            code = 0 if recover and len(attempts) > 1 else 255
            return subprocess.CompletedProcess(argv, code, b'', b'' if code == 0 else CONNECT.encode())
        self.stack.enter_context(patch.object(subprocess, 'run', side_effect=run))
        return attempts

    def test_acquisition_cached_ssh_holds_guard_and_does_not_reenter_the_queue(self):
        attempts = self.acquisition_fixture(recover=True)
        self.stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
        with patch.object(pool, '_acquire_logged', wraps=pool._acquire_logged) as queued:
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        self.assertEqual(len(attempts), 2)
        queued.assert_called_once()
        self.command.assert_called_once()
        self.assertEqual(self.command.call_args.args[0], 'same')
        with common.file_lock('box-same', timeout=0):
            pass

    def test_acquisition_ssh_giveup_keeps_the_error_reason_and_terminal_exit(self):
        self.acquisition_fixture(recover=False)
        with patch.object(pool, '_acquire_logged', wraps=pool._acquire_logged) as queued:
            self.assertEqual(self.run_case(flags=('--no-fallback',)), 90, self.err.getvalue())
        queued.assert_called_once()
        self.assertGreater(self.probe.call_count, 0)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        state = json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())
        self.assertEqual(state['exit_code'], 90)
        self.assertTrue(state['infra_failure'])
        self.assertEqual(state['infra_reason'], 'ssh_unreachable_before_start:box_ssh_unreachable')
        self.command.assert_not_called()
        with common.file_lock('box-same', timeout=0):
            pass

    def test_ssh_pause_credits_failed_attempt_without_resetting_prior_stall(self):
        for module in (lease, prepare):
            self.stack.enter_context(patch.object(module, 'time', self.clock.time))
        self.stack.enter_context(patch.object(home, 'active', return_value=True))
        with prepare.guard('same') as budget:
            watch = lease._ResumeWatch(self.con, 'same')
            watch.observe({'state': 'resuming'})
            self.clock.sleep(50)
            self.clock.sleep(10)  # Time in the failed SSH attempt.
            end = budget.end
            with prepare.pause_for_home_start(extra_seconds=10):
                self.clock.sleep(120)
            self.assertEqual(budget.end, end + 130)
            self.assertEqual(watch.remaining(), 40)
            self.clock.sleep(39)
            watch.check()
            self.clock.sleep(1)
            with self.assertRaises(lease.ResumeNoProgress):
                watch.check()

    def test_starting_box_keeps_resume_watchdog_and_ssh_recovery_under_guard(self):
        self.clock.time.time = lambda: self.clock.t
        for recover in (True, False):
            with self.subTest(recover=recover), contextlib.ExitStack() as stack:
                for module in (api, lease, prepare):
                    stack.enter_context(patch.object(module, 'time', self.clock.time))
                stack.enter_context(patch.object(home, 'active', return_value=True))
                stack.enter_context(patch.object(ssh_sync, 'cfg_path', return_value=Path(self.tmp.name) / 'missing'))
                stack.enter_context(patch.object(lease, '_readiness_get', return_value={'state': 'resuming'}))
                stack.enter_context(patch.object(ssh_sync, 'setup'))
                stack.enter_context(patch.dict(os.environ, {'OFFBOX_OUTAGE_WAIT_SECONDS': '125'}))
                stack.enter_context(patch.object(api, 'wait_state', return_value={'state': 'running'}))
                bring_up = stack.enter_context(patch.object(lease, '_bring_up_resumed', wraps=lease._bring_up_resumed))
                attempts = []
                def readiness(box):
                    attempts.append(box)
                    with self.assertRaises(common.OffboxError):
                        with common.file_lock('box-same', timeout=0):
                            pass
                    if len(attempts) == 1:
                        self.clock.sleep(10)
                        raise ssh_outage.SshUnreachable(box, CONNECT, reason='box_ssh_unreachable')
                stack.enter_context(patch.object(ssh_sync, 'wait_ssh', side_effect=readiness))
                def reachable(*args):
                    return recover and self.probe.call_count == 12, 'box_ssh_unreachable'
                self.probe.reset_mock()
                self.probe.side_effect = reachable
                row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='same'").fetchone())
                with common.file_lock('box-same', timeout=0), prepare.guard('same'), ssh_outage.recovery(enabled=True):
                    if recover:
                        self.assertEqual(lease._reuse(self.con, row, None)['box_id'], 'same')
                    else:
                        with self.assertRaises(ssh_outage.SshUnreachable) as raised:
                            lease._reuse(self.con, row, None)
                        self.assertEqual(raised.exception.waited_s, 125)
                    watch = bring_up.call_args.kwargs['watch']
                    self.assertEqual(watch.remaining(), 90)
                bring_up.assert_called_once()
                self.assertEqual(attempts, ['same', 'same'] if recover else ['same'])
                self.assertFalse(self.con.execute("SELECT 1 FROM events WHERE kind='resume_stuck'").fetchone())
                self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='same'").fetchone()[0], 'running')

    def test_acquisition_cached_ssh_still_resumes_a_confirmed_stopped_box(self):
        attempts = self.acquisition_fixture(recover=False)
        with patch.object(api, 'get', return_value={'state': 'archived'}), \
                patch.object(lease, '_readiness_get', return_value={'state': 'archived'}), \
                patch.object(lease, '_resume_confirmed', return_value=({'state': 'running'}, False)) as resume, \
                patch.object(lease, '_bring_up_resumed', return_value={'state': 'running'}), \
                patch.object(runs.Runner, '_check_box', return_value=None), \
                patch.object(ssh_sync, 'close_master'), \
                patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        self.assertEqual(len(attempts), 1)
        resume.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_called_once()

    def test_acquisition_endpoint_selection_still_resumes_a_confirmed_stopped_box(self):
        attempts = self.acquisition_fixture(recover=False)
        ssh_sync.cfg_path('same').write_text('Host same\n HostName 100.75.1.1\n Port 22066\n# offbox-home-ports 22067 22066\n')
        with patch.dict(ssh_sync._HOME_PORTS, {}, clear=True), \
                patch.object(api, 'get', return_value={'state': 'archived'}), \
                patch.object(lease, '_readiness_get', return_value={'state': 'archived'}), \
                patch.object(lease, '_resume_confirmed', return_value=({'state': 'running'}, False)) as resume, \
                patch.object(lease, '_bring_up_resumed', return_value={'state': 'running'}), \
                patch.object(runs.Runner, '_check_box', return_value=None), \
                patch.object(ssh_sync, 'close_master'), \
                patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        self.assertEqual(len(attempts), 2)
        resume.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_called_once()

    def test_replacement_ssh_giveup_preserves_final_metadata(self):
        self.stack.enter_context(patch.object(pool, 'acquire', wraps=self.real_acquire))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(lease, 'cap_check'))
        self.stack.enter_context(patch.object(lease, '_reuse', side_effect=lease.ResumeProvisionStalled('old resume stalled')))
        error = ssh_outage.SshUnreachable('replacement', CONNECT, reason='box_ssh_unreachable')
        def create(*args, **kwargs):
            with common.file_lock('box-replacement', timeout=0):
                if not ssh_outage.wait_for_connection(error):
                    raise error
            self.fail('unreachable replacement was accepted')
        def probe(*args):
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-replacement', timeout=0):
                    pass
            return False, 'box_ssh_unreachable'
        self.probe.side_effect = probe
        with patch.object(lease, 'acquire_private', side_effect=create) as created:
            self.assertEqual(self.run_case(), 90, self.err.getvalue())
        created.assert_called_once()
        self.command.assert_not_called()
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC, rowid DESC LIMIT 1').fetchone()
        state = json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())
        self.assertEqual(state['box_id'], 'replacement')
        self.assertEqual(state['exit_code'], 90)
        self.assertTrue(state['infra_failure'])
        self.assertEqual(state['infra_reason'], 'ssh_unreachable_before_start:box_ssh_unreachable')
        self.assertIn('a plain remote retry is safe', self.err.getvalue())
        self.assertNotIn("can't fall back to a local background run", self.err.getvalue())

    def test_bringup_ssh_readiness_waits_with_the_selected_guard(self):
        self.stack.enter_context(patch.object(api, 'wait_state', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(ssh_sync, 'setup'))
        ready = self.stack.enter_context(patch.object(ssh_sync, 'wait_ssh', side_effect=[
            ssh_outage.SshUnreachable('same', CONNECT, reason='tailnet_down'), None]))
        self.probe.return_value = True, 'box_ssh_unreachable'
        with common.file_lock('box-same', timeout=0), ssh_outage.recovery(enabled=True):
            lease._bring_up('same')
        self.assertEqual(ready.call_count, 2)
        self.assertEqual(self.probe.call_count, 1)

    def test_multiple_connect_failures_share_one_window(self):
        self.push.side_effect = self.fail_push
        def probe(*args):
            self.clock.sleep(5)
            return True, 'box_ssh_unreachable'
        self.probe.side_effect = probe
        start = self.clock.t
        self.assertEqual(self.run_case(), 90)
        self.assertEqual(self.clock.t-start, 20)
        self.assertEqual(self.acquire.call_count, 1)
        self.command.assert_not_called()

    def test_stopped_box_still_resumes_before_retrying_push(self):
        def push(box, *args, **kwargs):
            if self.push.call_count == 1:
                return ssh_sync._run_rsync(box, ['rsync'], 10)
            return {}
        self.push.side_effect = push
        with patch.object(ssh_sync, '_progress_args', return_value=()), \
                patch.object(ssh_sync, '_watch_rsync', return_value=subprocess.CompletedProcess([], 255, '', CONNECT)), \
                patch.object(ssh_sync, '_refresh_master'), patch.object(api, 'get', return_value={'state': 'archived'}), \
                patch.object(lease, '_reuse', return_value={'box_id': 'same'}) as resume, \
                patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        resume.assert_called_once()
        self.assertEqual(resume.call_args.args[1]['box_id'], 'same')
        self.assertEqual(self.push.call_count, 2)
        self.acquire.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_called_once()

    def test_real_push_seed_probe_reconciles_stopped_box_before_waiting(self):
        self.con.execute("UPDATE leases SET remote_dir='w/review-abcdef' WHERE box_id='same'")
        self.con.commit()
        config = Path(self.tmp.name) / 'ssh_config'
        config.write_text('Host same\n HostName 100.75.1.1\n Port 22066\n')
        self.push.side_effect = self.real_push
        self.probe.return_value = False, 'box_ssh_unreachable'
        real_run = subprocess.run
        attempts = []
        def run(argv, **kwargs):
            if argv[0] != 'ssh':
                return real_run(argv, **kwargs)
            attempts.append(argv)
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-same', timeout=0):
                    pass
            return subprocess.CompletedProcess(argv, 255 if len(attempts) == 1 else 0,
                b'existing\n', CONNECT.encode() if len(attempts) == 1 else b'')
        with patch.object(ssh_sync, 'cfg_path', return_value=config), \
                patch.object(subprocess, 'run', side_effect=run), \
                patch.object(ssh_sync, '_progress_args', return_value=()), \
                patch.object(ssh_sync, '_watch_rsync', return_value=subprocess.CompletedProcess([], 0, '', '')) as transfer, \
                patch.object(api, 'get', return_value={'state': 'archived'}) as state, \
                patch.object(lease, '_reuse', return_value={'box_id': 'same'}) as resume, \
                patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        resume.assert_called_once()
        self.assertGreaterEqual(state.call_count, 1)
        self.assertEqual(self.push.call_count, 2)
        self.assertGreaterEqual(len(attempts), 2)
        transfer.assert_called_once()
        self.acquire.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_called_once()

    def test_preparation_probes_reconcile_stopped_box_before_waiting(self):
        self.probe.return_value = False, 'box_ssh_unreachable'
        self.push.return_value = {}
        for phase in ('before_push', 'after_push'):
            with self.subTest(phase=phase), contextlib.ExitStack() as stack:
                self.command.reset_mock()
                self.push.reset_mock()
                error = ssh_outage.SshUnreachable('same', CONNECT, reason='box_ssh_unreachable')
                if phase == 'before_push':
                    stack.enter_context(patch.object(ssh_sync, 'probe_home', side_effect=[error, (None, None)]))
                else:
                    stack.enter_context(patch.object(runs.box_disk, 'measure', side_effect=[error, {}]))
                stack.enter_context(patch.object(api, 'get', return_value={'state': 'archived'}))
                resume = stack.enter_context(patch.object(lease, '_reuse', return_value={'box_id': 'same'}))
                stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
                self.assertEqual(self.run_case(), 0, self.err.getvalue())
                resume.assert_called_once()
                self.push.assert_called_once()
                self.command.assert_called_once()
                self.probe.assert_not_called()

    def test_push_endpoint_selection_still_resumes_a_confirmed_stopped_box(self):
        config = Path(self.tmp.name) / 'ssh_config'
        config.write_text('Host same\n HostName 100.75.1.1\n Port 22066\n# offbox-home-ports 22067 22066\n')
        def push(box, *args, **kwargs):
            if self.push.call_count == 1:
                return ssh_sync._run_rsync(box, ['rsync', '-e', 'ssh'], 10)
            return {}
        self.push.side_effect = push
        with patch.object(ssh_sync, 'cfg_path', return_value=config), patch.dict(ssh_sync._HOME_PORTS, {}, clear=True), \
                patch.object(ssh_sync, '_progress_args', return_value=()), \
                patch.object(ssh_sync, '_watch_rsync') as transfer, \
                patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 255, b'', CONNECT.encode())), \
                patch.object(api, 'get', return_value={'state': 'archived'}), \
                patch.object(lease, '_reuse', return_value={'box_id': 'same'}) as resume, \
                patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING):
            self.assertEqual(self.run_case(), 0, self.err.getvalue())
        resume.assert_called_once()
        transfer.assert_not_called()
        self.assertEqual(self.push.call_count, 2)
        self.acquire.assert_called_once()
        self.probe.assert_not_called()
        self.command.assert_called_once()

    def test_acquisition_upload_bootstrap_and_relocation_recover_or_give_up_under_guard(self):
        for stage in ('bootstrap', 'recipe_script', 'recipe_uploads', 'base_relocation'):
            for recover in (True, False):
                with self.subTest(stage=stage, recover=recover), contextlib.ExitStack() as stack:
                    self.con.execute("UPDATE runs SET status='done', exit_code=0 WHERE status='running'")
                    self.con.commit()
                    self.command.reset_mock()
                    attempts = []
                    result = subprocess.CompletedProcess([], 0, b'', b'')
                    def operation(*args, **kwargs):
                        if stage == 'recipe_script' and args[1] != '/home/user/.offbox/recipe.sh':
                            return None
                        attempts.append(args[1] if stage == 'recipe_uploads' else args[0])
                        with self.assertRaises(common.OffboxError):
                            with common.file_lock('box-same', timeout=0):
                                pass
                        if not recover or len(attempts) == 1:
                            raise ssh_outage.SshUnreachable('same', CONNECT, reason='box_ssh_unreachable')
                        return result
                    def acquire(*args, **kwargs):
                        guard = common.file_lock('box-same', timeout=0)
                        guard.__enter__()
                        try:
                            source = 'fresh' if stage == 'bootstrap' else 'base:old' if stage == 'base_relocation' else 'recipe:generic'
                            row = lease._create_row(self.con, self.me, 'same', source,
                                'w/old' if stage == 'base_relocation' else None, 'large', common.now(), box_held=True)
                            return dict(row, _guard=guard)
                        except BaseException:
                            guard.__exit__(None, None, None)
                            raise
                    def probe(*args):
                        with self.assertRaises(common.OffboxError):
                            with common.file_lock('box-same', timeout=0):
                                pass
                        return recover, 'box_ssh_unreachable'
                    self.probe.side_effect = probe
                    self.push.return_value = {}
                    stack.enter_context(patch.object(pool, 'acquire', side_effect=acquire))
                    stack.enter_context(patch.object(api, 'wait_state', return_value={'state': 'running'}))
                    stack.enter_context(patch.object(api, 'rename'))
                    stack.enter_context(patch.object(ssh_sync, 'setup'))
                    stack.enter_context(patch.object(ssh_sync, 'wait_ssh'))
                    stack.enter_context(patch.object(bases, 'recipe', return_value=('echo ready', 'sha')))
                    stack.enter_context(patch.object(lease, '_follow_bounded', return_value=0))
                    retire = stack.enter_context(patch.object(lease, '_retire_recipe_box'))
                    stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
                    if stage in ('bootstrap', 'base_relocation'):
                        stack.enter_context(patch.object(ssh_sync, 'ssh', side_effect=operation))
                    elif stage == 'recipe_script':
                        stack.enter_context(patch.object(ssh_sync, 'put_file', side_effect=operation))
                    stack.enter_context(patch.object(bases, 'template_uploads',
                        side_effect=operation if stage == 'recipe_uploads' else None))
                    self.assertEqual(self.run_case(), 0 if recover else 90, self.err.getvalue())
                    self.assertEqual(attempts, ['same', 'same'] if recover else ['same'])
                    retire.assert_not_called()
                    if recover:
                        self.assertEqual(self.command.call_count, 2 if stage.startswith('recipe') else 1)
                    else:
                        self.command.assert_not_called()
                        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC, rowid DESC LIMIT 1').fetchone()
                        state = json.loads((common.LOGS_DIR / (row['run_id'] + '.state.json')).read_text())
                        self.assertEqual(state['exit_code'], 90)
                        self.assertTrue(state['infra_failure'])
                        self.assertEqual(state['infra_reason'], 'ssh_unreachable_before_start:box_ssh_unreachable')
                    with common.file_lock('box-same', timeout=0):
                        pass


class ClassificationTests(Isolated):
    def test_wait_eligibility_accepts_partial_run_arguments(self):
        cases = [({}, True), ({'cmd': []}, True), ({'cmd': ['true']}, False),
                 ({'cmd': ['make', 'test']}, True)]
        cases += [({'cmd': ['true'], flag: True}, True) for flag in ('bg', 'remote', 'no_fallback')]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                args = SimpleNamespace(**fields)
                error = common.OffboxError('unreachable', outage=True)
                self.assertEqual(cli._pre_start_wait_applies(args, error), expected)
                self.assertEqual(cli._outage_wait_applies(args, error), expected)
                error.started = True
                self.assertFalse(cli._pre_start_wait_applies(args, error))

    def test_connect_forms_and_exit_codes(self):
        forms = [f'ssh: connect to host host port 22: {s}' for s in (
            'Operation timed out', 'Connection timed out', 'Connection refused', 'No route to host',
            'Network is unreachable')]
        forms += ['ssh: Could not resolve hostname host: Name or service not known',
                  'Connection closed by 100.75.1.1 port 22',
                  'Connection closed by UNKNOWN port 65535',
                  'Connection timed out during banner exchange',
                  'Connection to 100.75.1.1 port 22 timed out',
                  'Connection to UNKNOWN port 65535 timed out',
                  'Connection to fd7a:115c:a1e0::1 port 22066 timed out',
                  'kex_exchange_identification: read: Connection reset by peer']
        for text in forms:
            for rsync, code in ((False, 255), (True, 255), (True, 12)):
                for up, reason in ((True, 'box_ssh_unreachable'), (False, 'tailnet_down')):
                    with self.subTest(text=text, code=code, up=up), patch.object(ssh_outage, 'tailnet',
                            return_value={'up': up, 'detail': 'status'}):
                        with self.assertRaises(ssh_outage.SshUnreachable) as raised:
                            ssh_outage.classify('box', code, text, rsync=rsync)
                        self.assertEqual(raised.exception.reason, reason)
                        self.assertFalse(raised.exception.started)
                        self.assertFalse(raised.exception.outage)
        for code in (1, 2, 23):
            ssh_outage.classify('box', code, CONNECT, rsync=True)

    def test_auth_host_key_and_command_failures_keep_existing_behavior(self):
        for text in ('Permission denied (publickey)', 'REMOTE HOST IDENTIFICATION HAS CHANGED',
                     'Host key verification failed', 'command exited 255', 'Broken pipe',
                     'Permission denied (publickey)\n' + CONNECT):
            with self.subTest(text=text), patch.object(ssh_sync, 'ssh_base', return_value=['ssh']), \
                    patch.object(api, 'BACKEND', 'boat'), patch.object(subprocess, 'run',
                        return_value=subprocess.CompletedProcess([], 255, b'', text.encode())):
                with self.assertRaises(common.OffboxError) as raised:
                    ssh_sync.ssh('box', 'true', check=True)
                self.assertNotIsInstance(raised.exception, ssh_outage.SshUnreachable)
                self.assertEqual(ssh_sync.ssh('box', 'true').returncode, 255)

    def test_rsync_connect_failure_preserves_state_check_and_endpoint_refresh(self):
        for code in (12, 255):
            with self.subTest(code=code), patch.object(ssh_sync, '_progress_args', return_value=()), \
                    patch.object(api, 'BACKEND', 'boat'), patch.object(ssh_sync, '_watch_rsync',
                        return_value=subprocess.CompletedProcess([], code, '', CONNECT)), \
                    patch.object(ssh_sync, '_refresh_master') as refresh, \
                    patch.object(api, 'get', return_value={'state': 'running'}) as state, \
                    patch.object(ssh_outage, 'tailnet', return_value={'up': True, 'detail': 'status'}), \
                    ssh_outage.pre_start():
                with self.assertRaises(ssh_outage.SshUnreachable):
                    ssh_sync._run_rsync('box', ['rsync'], 10)
                refresh.assert_called_once()
                state.assert_called_once()

    def test_home_endpoint_probes_do_not_hide_connect_failures_or_auth(self):
        config = Path(self.tmp.name) / 'config'
        config.write_text('Host box\n HostName 100.75.1.1\n Port 22066\n# offbox-home-ports 22067 22066\n')
        for errors, transient in (((CONNECT, CONNECT), True),
                                  (('Permission denied (publickey)', CONNECT), False),
                                  ((CONNECT, 'Permission denied (publickey)'), False)):
            with self.subTest(errors=errors), patch.object(ssh_sync, 'cfg_path', return_value=config), \
                    patch.object(api, 'BACKEND', 'server'), patch.dict(ssh_sync._HOME_PORTS, {}, clear=True), \
                    patch.object(subprocess, 'run', side_effect=[
                        subprocess.CompletedProcess([], 255, b'', e.encode()) for e in errors]), \
                    patch.object(ssh_outage, 'tailnet', return_value={'up': True, 'detail': 'status'}), \
                    ssh_outage.pre_start():
                with self.assertRaises(common.OffboxError) as raised:
                    ssh_sync.ssh_base('box')
                self.assertEqual(isinstance(raised.exception, ssh_outage.SshUnreachable), transient)

    def test_unchecked_probes_classify_only_inside_pre_start(self):
        with patch.object(ssh_sync, 'ssh_base', return_value=['ssh']), patch.object(subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 255, b'', CONNECT.encode())), \
                patch.object(ssh_outage, 'tailnet', return_value={'up': True, 'detail': 'status'}):
            self.assertEqual(ssh_sync.ssh('box', 'true').returncode, 255)
            with ssh_outage.pre_start(), self.assertRaises(ssh_outage.SshUnreachable):
                ssh_sync.ssh('box', 'true')

    def test_reachability_checks_monitor_and_the_selected_ssh_endpoint(self):
        cfg = self.tmp.name + '/config'
        Path(cfg).write_text('Host box\n HostName 100.75.1.1\n Port 22066\n')
        with patch.object(ssh_sync, 'cfg_path', return_value=Path(cfg)), \
                patch.dict(ssh_sync._HOME_PORTS, {'box': (Path(cfg).read_text(), 22067)}), \
                patch.object(ssh_outage, 'tailnet', return_value={'up': False, 'detail': 'status'}) as facts, \
                patch.object(ssh_outage.socket, 'create_connection') as connect:
            self.assertEqual(ssh_outage.reachable('box', 2), (False, 'tailnet_down'))
            connect.assert_not_called()
            facts.return_value = {'up': True, 'detail': 'status'}
            self.assertTrue(ssh_outage.reachable('box', 2)[0])
            self.assertEqual(connect.call_args.args[0], ('100.75.1.1', 22067))
            connect.return_value.close.assert_called_once()
            connect.reset_mock()
            connect.side_effect = [OSError('old proxy refused'), connect.return_value]
            self.assertTrue(ssh_outage.reachable('box', 2)[0])
            self.assertEqual([c.args[0][1] for c in connect.call_args_list], [22067, 22066])
            self.assertNotIn('box', ssh_sync._HOME_PORTS)
            connect.side_effect = OSError('refused')
            self.assertEqual(ssh_outage.reachable('box', 2), (False, 'box_ssh_unreachable'))
