"""Installed restart boundary and install exclusion, without live watchdog calls."""
import json
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import patch

import test_mac_guard as shared

m, proc, ROBOB = shared.m, shared.proc, shared.ROBOB


class InstallHoldTests(unittest.TestCase):
    def test_pane_matrix(self):
        now = shared.NOW
        cases = [
            ('install 0 python3 1', True),
            ('install14 0 zsh '+str(now-60), True),
            ('install14 0 zsh '+str(now-1800), True),
            ('install14 0 zsh '+str(now-1801), False),
            ('install14 0 /bin/bash '+str(now-3600), False),
            ('install14 0 -zsh '+str(now-3600), False),
            ('install14 0 python3 '+str(now-3600), True),
            ('install14 1 python3 '+str(now), False),
            ('installx 0 python3 '+str(now), False),
            ('preinstall14 0 python3 '+str(now), False),
            ('install14-extra 0 python3 '+str(now), False),
            ('install14 0 zsh unknown', True),
            ('install14 broken', True),
            ('other 0 python3 1\ninstall22 0 python3 1', True),
            ('', False),
        ]
        for text, held in cases:
            with self.subTest(pane=text):
                calls = []
                def run(argv, **kw):
                    calls.append((argv, kw))
                    return subprocess.CompletedProcess(argv, 0, text, '')
                self.assertEqual(bool(m.qf_install_hold(run, now)), held)
                argv, kw = calls[0]
                self.assertEqual(argv[:6], [m.TMUX, '-L', 'qf-install', 'list-panes', '-a', '-F'])
                self.assertEqual(argv[6], '#{session_name} #{pane_dead} #{pane_current_command} #{session_activity}')
                self.assertEqual(kw['timeout'], 5)

    def test_failed_probe_holds_but_absent_server_does_not(self):
        cases = [(1, 'no server running on /private/tmp/tmux-501/qf-install', False),
                 (1, 'error connecting to /tmp/tmux-501/qf-install (No such file or directory)', False),
                 (1, 'permission denied', True), (1, '', True), (2, 'broken', True)]
        for rc, err, held in cases:
            with self.subTest(rc=rc, err=err):
                self.assertEqual(bool(m.qf_install_hold(lambda *a, **kw: subprocess.CompletedProcess(a, rc, '', err))), held)
        for error in (OSError('no tmux'), subprocess.TimeoutExpired('tmux', 5)):
            with self.subTest(error=error), patch.object(m.subprocess, 'run', side_effect=error) as run:
                self.assertTrue(m.qf_install_hold(run))


class WatchdogTests(unittest.TestCase):
    setUp = shared.GuardTests.setUp
    tick = shared.GuardTests.tick
    effects = shared.GuardTests.effects
    events_named = shared.GuardTests.events_named
    restart_guard = shared.GuardTests.restart_guard

    def installed(self):
        script = self.root/'installed/robob-overload-restart.py'
        script.parent.mkdir(exist_ok=True)
        script.write_text('''
def server_started(): return (1, 1)
def hold_live(): return None
def tmux_session(socket, name): return False
def building(): return []
''')
        (script.parent/'launchd-entry.zsh').touch()
        self.addCleanup(patch.stopall)
        patch.object(m, 'OVERLOAD_SCRIPT', script).start()
        patch.object(m, 'OVERLOAD_STATE', self.root/'watchdog-state').start()
        return script

    def test_installed_preflight_does_not_need_launchagent(self):
        self.installed()
        with patch.object(m, 'qf_install_hold', return_value=None):
            checks = m.overload_checks()
        self.assertEqual(checks, dict(pid=1, started=1, hold=None, restart=False, install=False, building=[]))

    def test_missing_and_disabled_skip_once_and_persist_hourly_limit(self):
        for missing in ('script', 'entry', 'disabled'):
            with self.subTest(missing=missing):
                case = WatchdogTests()
                case.setUp()
                try:
                    script = case.installed()
                    if missing == 'script':
                        script.unlink()
                    elif missing == 'entry':
                        (script.parent/'launchd-entry.zsh').unlink()
                    else:
                        m.OVERLOAD_STATE.mkdir()
                        (m.OVERLOAD_STATE/'disabled').touch()
                    case.host.checks = m.overload_checks()
                    case.tick([proc(1, ROBOB)], {1: 25})
                    event = case.events_named('robob_restart')[-1]
                    self.assertEqual(event['result'], 'skipped')
                    self.assertIn('disabled' if missing == 'disabled' else 'missing', event['detail'])
                    self.assertEqual(case.guard.saved['lastRestartAt'], shared.NOW)
                    case.restart_guard()
                    case.tick([proc(1, ROBOB)], {1: 26})
                    self.assertFalse(case.effects('restart'))
                    self.assertFalse(case.effects('signal'))
                    self.assertEqual(len(case.effects('notify')), 1)
                    self.assertEqual(len(case.effects('worker')), 1)
                    self.assertFalse(case.effects('steer'))
                finally:
                    case.doCleanups()

    def test_qf_hold_detail_reaches_event_and_responder(self):
        self.installed()
        with patch.object(m, 'qf_install_hold', return_value='qf-install active install14'):
            self.host.checks = m.overload_checks()
        self.tick([proc(1, ROBOB)], {1: 25})
        self.assertFalse(self.effects('restart'))
        event = self.events_named('robob_restart')[-1]
        self.assertEqual(event['reason'], 'tmux_session')
        self.assertEqual(event['detail'], 'qf-install active install14')
        self.assertIn(event['detail'], self.effects('notify')[0][2])
        self.assertEqual(shared.toollog.safe_fields(event, 'macguard.robob_restart')['detail'], event['detail'])

    def test_refusal_receipt_after_detached_launch_alerts_responder_once(self):
        for reason in ('expired', 'disabled', 'live-install-hold', 'restart-or-install-session', 'preflight failed'):
            with self.subTest(reason=reason):
                case = WatchdogTests()
                case.setUp()
                try:
                    case.installed()
                    case.tick([proc(1, ROBOB)], {1: 25})
                    pending = case.guard.saved['restartPending']
                    self.assertTrue(pending['stamp'].isalnum())
                    m.OVERLOAD_STATE.mkdir()
                    (m.OVERLOAD_STATE/('result-'+pending['stamp']+'.json')).write_text(json.dumps(dict(ok=False, reason=reason)))
                    case.host.restart_result = m.Host().restart_result
                    case.restart_guard()
                    case.tick([proc(1, ROBOB)], {1: 26})
                    event = next(e for e in case.events_named('robob_restart') if e.get('reason') == 'watchdog_refused')
                    self.assertEqual(event['result'], 'skipped')
                    self.assertEqual(event['detail'], reason)
                    case.tick([proc(1, ROBOB)], {1: 27})
                    self.assertEqual(len(case.effects('restart')), 1)
                    self.assertFalse(case.effects('signal'))
                    refused = [e for e in case.effects('notify') if 'refused:' in e[1]]
                    self.assertEqual(len(refused), 1)
                    self.assertEqual(len(case.effects('notify')), 1)
                    self.assertEqual(len(case.effects('worker')), 1)
                    self.assertFalse(case.effects('steer'))
                    self.assertEqual(case.guard.saved['lastRestartAt'], shared.NOW)
                    self.assertNotIn('restartPending', case.guard.saved)
                finally:
                    case.doCleanups()

    def test_nonzero_exit_without_receipt_is_a_refusal(self):
        self.installed()
        self.tick([proc(1, ROBOB)], {1: 25})
        pending = self.guard.saved['restartPending']
        Path(pending['log']).with_suffix('.exit').write_text('7')
        self.host.restart_result = m.Host().restart_result
        self.tick([proc(1, ROBOB)], {1: 26})
        self.assertEqual(self.guard.saved['lastRestartFailure'], 'watchdog exit 7 without result')
        self.assertTrue(self.effects('worker'))

    def test_restart_responder_reconciles_during_cooldown(self):
        for failure in ('missing', 'disabled', 'refused', 'launch'):
            for accepted in (False, True):
                with self.subTest(failure=failure, accepted=accepted):
                    case = WatchdogTests()
                    case.setUp()
                    try:
                        case.installed()
                        if failure in ('missing', 'disabled'):
                            case.host.checks = dict(unavailable=failure)
                        elif failure == 'refused':
                            case.tick([proc(1, ROBOB)], {1: 25})
                            case.host.restart_result = lambda pending: dict(ok=False, reason='expired')
                        create = case.host.worker_create
                        def fail_create(launch):
                            if accepted:
                                create(launch)
                            raise m.ProbeError('creation not confirmed')
                        with patch.object(case.host, 'worker_create', side_effect=fail_create), \
                             patch.object(case.host, 'restart', wraps=case.host.restart,
                                          side_effect=m.ProbeError('launch unknown') if failure == 'launch' else None):
                            case.tick([proc(1, ROBOB)], {1: 26})
                        launch = case.guard.worker['launch']
                        attempted_at = case.guard.saved['lastRestartAt']
                        case.restart_guard()
                        with patch.object(case.host, 'worker_create', wraps=create) as retry:
                            case.tick([proc(1, ROBOB)], {1: 27})
                        if accepted:
                            retry.assert_not_called()
                        else:
                            retry.assert_called_once_with(launch)
                        self.assertEqual(case.host.lookups, [launch['clientRequestId']])
                        self.assertFalse(case.guard.worker.get('launchUnknown'))
                        self.assertEqual(len(case.effects('worker')), 1)
                        self.assertEqual(len(case.effects('notify')), 1)
                        self.assertEqual(case.guard.saved['lastRestartAt'], attempted_at)
                        case.tick([proc(1, ROBOB)], {1: 28})
                        self.assertEqual(len(case.effects('worker')), 1)
                        self.assertEqual(len(case.effects('notify')), 1)
                    finally:
                        case.doCleanups()

    def test_restart_responder_lookup_failure_respects_shared_backoff_table(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                case = WatchdogTests()
                case.setUp()
                try:
                    case.host.checks = dict(unavailable='disabled')
                    with patch.object(case.host, 'worker_create', side_effect=m.ProbeError('timeout')):
                        case.tick([proc(1, ROBOB)], {1: 25})
                    launch = case.guard.worker['launch']
                    jobs = []
                    if asynchronous:
                        def submit(fn):
                            future = shared.Future()
                            jobs.append((fn, future))
                            return future
                        case.guard.worker_submit = submit
                    with patch.object(case.host, 'worker_lookup', side_effect=m.WorkerControlError('timeout')) as lookup, \
                         patch.object(case.host, 'worker_create') as create:
                        case.tick([], {})
                        if asynchronous:
                            self.assertEqual(len(jobs), 1)
                            jobs[0][1].set_result(jobs[0][0]())
                            case.tick([], {})
                            self.assertEqual(len(jobs), 1)
                        lookup.assert_called_once_with(launch['clientRequestId'])
                        create.assert_not_called()
                    self.assertTrue(case.guard.worker['launchUnknown'])
                    self.assertEqual(case.guard.worker['launch'], launch)
                    self.assertEqual(case.guard.worker['nextReconcileAt'], case.now)
                finally:
                    case.doCleanups()

    def test_receipt_and_exit_matrix(self):
        self.installed()
        m.OVERLOAD_STATE.mkdir()
        receipt = m.OVERLOAD_STATE/'result-abc123.json'
        log = self.root/'restart.log'
        exit_path = log.with_suffix('.exit')
        # Receipt, detached exit, verdict, reason fragment.
        cases = [
            (None, None, None, None),
            (None, '0', False, 'exit 0 without result'),
            (None, '7', False, 'exit 7 without result'),
            (None, 'bad', False, 'unreadable watchdog exit'),
            (True, None, None, None),
            (True, '0', True, None),
            (True, '7', False, 'exit 7 after success receipt'),
            (True, 'bad', False, 'unreadable watchdog exit'),
            (False, None, False, 'disabled'),
            (False, '0', False, 'disabled'),
            (False, '7', False, 'disabled'),
            (False, 'bad', False, 'disabled'),
        ]
        for ok, code, verdict, reason in cases:
            with self.subTest(receipt=ok, exit=code):
                receipt.unlink(missing_ok=True)
                exit_path.unlink(missing_ok=True)
                if ok is not None:
                    receipt.write_text(json.dumps(dict(ok=ok, reason=None if ok else 'disabled')))
                if code is not None:
                    exit_path.write_text(code)
                result = m.Host().restart_result(dict(stamp='abc123', log=str(log)))
                if verdict is None:
                    self.assertIsNone(result)
                else:
                    self.assertIs(result['ok'], verdict)
                    if reason:
                        self.assertIn(reason, result['reason'])

    def test_existing_responder_delivery_failure_matrix(self):
        for failure in ('missing', 'disabled', 'refused', 'launch'):
            for delivery in ('status', 'send_before_accept', 'send_after_accept'):
                with self.subTest(failure=failure, delivery=delivery):
                    case = WatchdogTests()
                    case.setUp()
                    try:
                        case.installed()
                        case.guard.worker = dict(threadId='existing-responder', startedAt=shared.NOW)
                        m.write_json(case.guard.state/'worker.json', case.guard.worker)
                        if failure in ('missing', 'disabled'):
                            case.host.checks = dict(unavailable=failure)
                        elif failure == 'refused':
                            case.tick([proc(1, ROBOB)], {1: 25})
                            case.host.restart_result = lambda pending: dict(ok=False, reason='expired')
                        send = case.host.worker_send
                        def fail_send(*args, **kwargs):
                            if delivery == 'send_after_accept':
                                send(*args, **kwargs)
                            raise m.ProbeError('send uncertain')
                        with patch.object(case.host, 'worker_status', wraps=case.host.worker_status,
                                          side_effect=m.ProbeError('status unavailable') if delivery == 'status' else None), \
                             patch.object(case.host, 'worker_send', wraps=send,
                                          side_effect=None if delivery == 'status' else fail_send), \
                             patch.object(case.host, 'restart', wraps=case.host.restart,
                                          side_effect=m.ProbeError('launch unknown') if failure == 'launch' else None):
                            case.tick([proc(1, ROBOB)], {1: 26})
                        report = case.guard.saved['restartResponder']
                        case.restart_guard()
                        with patch.object(case.host, 'worker_send', wraps=send) as retry:
                            case.tick([proc(1, ROBOB)], {1: 27})
                        retry.assert_called_once_with('existing-responder', report['evidence']+'\n'+report['summary'],
                                                      report['requestId'])
                        self.assertNotIn('restartResponder', case.guard.saved)
                        case.tick([proc(1, ROBOB)], {1: 28})
                        self.assertEqual(len(case.effects('steer')), 1)
                        self.assertEqual(len(case.effects('notify')), 1)
                        self.assertFalse(case.effects('worker'))
                        self.assertFalse(case.effects('signal'))
                    finally:
                        case.doCleanups()

    def test_restart_responder_retry_survives_calm_and_respects_pause(self):
        self.installed()
        self.host.checks = dict(unavailable='disabled')
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('not accepted')):
            self.tick([proc(1, ROBOB)], {1: 25})
        launch = self.guard.worker['launch']
        self.restart_guard()
        paused = self.guard.state/'paused'
        paused.touch()
        with patch.object(self.host, 'worker_create', wraps=self.host.worker_create) as retry:
            self.tick([], {})
            retry.assert_not_called()
            paused.unlink()
            self.tick([], {})
        retry.assert_called_once_with(launch)
        self.assertEqual(self.host.lookups, [launch['clientRequestId']])
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('notify')), 1)
        self.assertFalse(self.effects('restart'))

    def test_uncertain_delivery_stays_bound_when_worker_finishes(self):
        # Operation, initial acceptance, target's terminal status at retry.
        cases = [(operation, accepted, status) for operation in ('create', 'send')
                 for accepted in (False, True) for status in (None, 'completed', 'failed', 'cancelled', 'interrupted')]
        for operation, accepted, status in cases:
            with self.subTest(operation=operation, accepted=accepted, status=status):
                case = WatchdogTests()
                case.setUp()
                try:
                    case.installed()
                    case.host.checks = dict(unavailable='disabled')
                    if operation == 'send':
                        case.guard.worker = dict(threadId='original-responder', startedAt=shared.NOW)
                        m.write_json(case.guard.state/'worker.json', case.guard.worker)
                    original = getattr(case.host, 'worker_'+operation)
                    def uncertain(*args, **kwargs):
                        if accepted:
                            original(*args, **kwargs)
                        raise m.ProbeError('acknowledgment lost')
                    with patch.object(case.host, 'worker_'+operation, side_effect=uncertain) as first:
                        case.tick([proc(1, ROBOB)], {1: 25})
                    initial_call = first.call_args
                    if status:
                        case.host.worker = dict(state='idle', status=status)
                    case.restart_guard()
                    with patch.object(case.host, 'worker_'+operation, wraps=original) as retry:
                        case.tick([proc(1, ROBOB)], {1: 26})
                    self.assertEqual(retry.call_args_list, [] if operation == 'create' and accepted else [initial_call])
                    self.assertNotIn('restartResponder', case.guard.saved)
                    case.tick([proc(1, ROBOB)], {1: 27})
                    self.assertEqual(len(case.effects('notify')), 1)
                    self.assertEqual(len(case.effects('worker')), int(operation == 'create'))
                    self.assertEqual(len(case.effects('steer')), int(operation == 'send'))
                    self.assertFalse(case.effects('signal'))
                finally:
                    case.doCleanups()

    def test_restart_responder_persisted_before_refusal_notification(self):
        self.installed()
        self.tick([proc(1, ROBOB)], {1: 25})
        self.host.restart_result = lambda pending: dict(ok=False, reason='expired')
        with patch.object(self.host, 'notify', side_effect=RuntimeError('guard interrupted')):
            with self.assertRaises(RuntimeError):
                self.tick([proc(1, ROBOB)], {1: 26})
        self.restart_guard()
        self.assertNotIn('restartPending', self.guard.saved)
        self.assertIn('restartResponder', self.guard.saved)
        self.tick([], {})
        self.assertNotIn('restartResponder', self.guard.saved)
        self.assertEqual(len(self.effects('worker')), 1)

    def test_launch_binding_survives_interruption_before_worker_file(self):
        self.installed()
        self.host.checks = dict(unavailable='disabled')
        write = m.write_json
        def interrupt(path, value):
            if path == self.guard.state/'worker.json' and value.get('launchUnknown'):
                raise RuntimeError('interrupted before worker file')
            write(path, value)
        with patch.object(m, 'write_json', side_effect=interrupt):
            with self.assertRaises(RuntimeError):
                self.tick([proc(1, ROBOB)], {1: 25})
        self.restart_guard()
        launch = self.guard.saved['restartResponder']['launch']
        self.now += 30
        with patch.object(self.host, 'worker_create', side_effect=m.ProbeError('acknowledgment unknown')) as first:
            self.tick([], {})
        first.assert_called_once_with(launch)
        self.restart_guard()
        self.assertTrue(self.guard.worker['launchUnknown'])
        self.assertEqual(self.guard.worker['launch'], launch)
        self.tick([], {})
        self.assertNotIn('restartResponder', self.guard.saved)
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertFalse([e for e in self.effects('steer') if 'Robob restart skipped: disabled' in e[2]])

    def test_responder_send_uses_persisted_request_id(self):
        calls = []
        def run(argv, **kw):
            calls.append((argv, kw))
            return subprocess.CompletedProcess(argv, 0, '', '')
        m.Host(run).worker_send('responder-thread', 'restart skipped: disabled', 'incident123')
        self.assertEqual(calls[0][0], [m.T3CTL, 'send', 'responder-thread', 'restart skipped: disabled',
                                       '--request-id', 'incident123'])
        self.assertEqual(calls[0][1]['timeout'], 5)

    def test_success_receipt_waits_for_exit_and_nonzero_alerts_once(self):
        self.installed()
        self.tick([proc(1, ROBOB)], {1: 25})
        pending = self.guard.saved['restartPending']
        m.OVERLOAD_STATE.mkdir()
        (m.OVERLOAD_STATE/('result-'+pending['stamp']+'.json')).write_text(json.dumps(dict(ok=True)))
        self.host.restart_result = m.Host().restart_result
        self.tick([proc(1, ROBOB)], {1: 26})
        self.assertIn('restartPending', self.guard.saved)
        self.assertFalse(self.effects('worker'))
        self.assertFalse(self.effects('notify'))
        Path(pending['log']).with_suffix('.exit').write_text('7')
        self.restart_guard()
        self.tick([proc(1, ROBOB)], {1: 27})
        event = next(e for e in self.events_named('robob_restart') if e.get('reason') == 'watchdog_refused')
        self.assertIn('exit 7 after success receipt', event['detail'])
        self.assertNotIn('restartPending', self.guard.saved)
        self.tick([proc(1, ROBOB)], {1: 28})
        self.assertEqual(len(self.effects('worker')), 1)
        self.assertEqual(len(self.effects('notify')), 1)
        self.assertEqual(len(self.effects('restart')), 1)
        self.assertFalse(self.effects('signal'))

    def test_disabled_between_preflight_and_launch_never_starts_tmux(self):
        self.installed()
        m.OVERLOAD_STATE.mkdir()
        (m.OVERLOAD_STATE/'disabled').touch()
        calls = []
        with self.assertRaises(m.ProbeError):
            m.Host(lambda *a, **kw: calls.append(a)).restart(self.root/'restart.log', 'abc123')
        self.assertFalse(calls)

    def test_detached_command_keeps_exit_code_without_tee(self):
        self.installed()
        calls = []
        def run(argv, **kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, '', '')
        log = self.root/'restart with spaces.log'
        m.Host(run).restart(log, 'abc123')
        outer = shlex.split(calls[0][7])
        self.assertEqual(outer[:3], ['/bin/zsh', '-f', '-c'])
        command = outer[3]
        self.assertIn('export ROBOB_OVERLOAD_HOME='+shlex.quote(str(m.OVERLOAD_SCRIPT.parent)), command)
        self.assertIn('ROBOB_OVERLOAD_STATE='+shlex.quote(str(m.OVERLOAD_STATE)), command)
        self.assertIn('restart abc123', command)
        self.assertIn(shlex.quote(str(log)), command)
        self.assertNotIn('tee', command)
        # Run only the exit-capture shell, substituting a simulated refused entry.
        call = '/bin/zsh -f '+shlex.quote(str(m.OVERLOAD_SCRIPT.parent/'launchd-entry.zsh'))+' restart abc123'
        fake = self.root/'fake-entry.sh'
        fake.write_text('test "$ROBOB_OVERLOAD_HOME" = '+shlex.quote(str(m.OVERLOAD_SCRIPT.parent))+' || exit 90\n'
                        'test "$ROBOB_OVERLOAD_STATE" = '+shlex.quote(str(m.OVERLOAD_STATE))+' || exit 91\nexit 7\n')
        with patch.dict('os.environ', ROBOB_OVERLOAD_HOME='/obsolete', ROBOB_OVERLOAD_STATE='/obsolete'):
            result = subprocess.run(['/bin/sh', '-c', command.replace(call, '/bin/sh '+shlex.quote(str(fake)))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(log.with_suffix('.exit').read_text(), '7')

    def test_package_has_no_obsolete_watchdog_path(self):
        self.assertEqual(m.OVERLOAD_SCRIPT, Path.home()/'.local/share/robob-overload-restart/robob-overload-restart.py')
        obsolete = 'board-artifacts/'+'main-thread-'+'overload'
        for path in shared.HERE.rglob('*'):
            if path.suffix in ('.py', '.md'):
                with self.subTest(path=path):
                    self.assertNotIn(obsolete, path.read_text())
