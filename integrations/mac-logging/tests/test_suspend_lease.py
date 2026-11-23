import copy
from contextlib import contextmanager
import datetime as dt
import fcntl
import io
import json
import math
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import suspend_lease as m
import toollog
import status


def proc(pid=20, stat='S', start='Sun Nov 22 10:00:00 2026', comm='/bin/sleep', command='/bin/sleep 600'):
    return dict(pid=pid, ppid=1, stat=stat, start=start, comm=comm, command=command)


CREDENTIAL_COMMANDS = [
    ('short user', 'curl -u alice:EXAMPLE_ONLY https://example.invalid'),
    ('joined user', 'curl -ualice:EXAMPLE_ONLY https://example.invalid'),
    ('bundled user', 'curl -fsSLu alice:EXAMPLE_ONLY https://example.invalid'),
    ('long user', 'curl --user alice:EXAMPLE_ONLY https://example.invalid'),
    ('equals user', 'curl --user=alice:EXAMPLE_ONLY https://example.invalid'),
    ('proxy user', 'curl -Ualice:EXAMPLE_ONLY https://example.invalid'),
    ('long proxy user', 'curl --proxy-user=alice:EXAMPLE_ONLY https://example.invalid'),
    ('Basic header', 'curl -H "Authorization: Basic EXAMPLE_ONLY" https://example.invalid'),
    ('joined Basic header', 'curl -H"authorization:basic EXAMPLE_ONLY" https://example.invalid'),
    ('long Basic header', 'curl --header="AUTHORIZATION: Basic EXAMPLE_ONLY" https://example.invalid'),
    ('api-key space', 'tool --api-key EXAMPLE_ONLY'),
    ('api-key equals', 'tool --api-key=EXAMPLE_ONLY'),
    ('api_key', 'tool --api_key=EXAMPLE_ONLY'),
    ('URL userinfo', 'curl https://alice:EXAMPLE_ONLY@example.invalid'),
    ('cookie', 'curl -b sid=EXAMPLE_ONLY https://example.invalid'),
    ('bearer', 'curl -H "Authorization: Bearer EXAMPLE_ONLY" https://example.invalid'),
    ('after truncation', 'tool '+'x '*200+'--api-key EXAMPLE_ONLY'),
]


class Crash(BaseException):
    pass


class FakeHost:
    def __init__(self):
        self.live = {20: proc()}
        self.effects = []
        self.before_signal = lambda sig: None
        self.ignore = set()
        self.read_fail = 0
        self.notify_ok = True

    def process(self, pid):
        if self.read_fail:
            self.read_fail -= 1
            raise OSError('ps failed')
        self.effects.append(('read', pid))
        return copy.deepcopy(self.live.get(pid))

    def stopped(self):
        return [copy.deepcopy(p) for p in self.live.values() if p['stat'].startswith('T')]

    def signal(self, pid, sig):
        self.before_signal(sig)
        self.effects.append(('signal', pid, sig))
        if sig in self.ignore:
            return
        if sig == signal.SIGSTOP:
            self.live[pid]['stat'] = 'T'
        elif sig == signal.SIGCONT:
            self.live[pid]['stat'] = 'S'
        elif sig == signal.SIGKILL:
            self.live.pop(pid, None)

    def sleep(self, seconds):
        self.effects.append(('sleep', seconds))

    def owner(self, p):
        return 'com.abdullah.fixture'

    def notify(self, key, text):
        self.effects.append(('notify', key, text))
        return self.notify_ok


class FakeRun:
    def __init__(self, live):
        self.live = live
        self.calls = []
        self.timeout_calls = set()

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if len(self.calls) in self.timeout_calls:
            raise subprocess.TimeoutExpired(argv, kwargs['timeout'], output='private argv', stderr='private stderr')
        output = ''
        if argv[0] == '/bin/ps':
            if '-axo' in argv:
                output = '\n'.join(f"{p['pid']} {p['stat']} {p['start']} {p['command']}" for p in self.live.values())
            else:
                p = self.live.get(int(argv[argv.index('-p')+1]))
                if p:
                    output = (f"{p['pid']} {p['ppid']} {p['stat']} {p['start']} {p['comm']}"
                              if argv[-1].startswith('pid=') else f"{p['start']} {p['command']}")
        return subprocess.CompletedProcess(argv, 0, output, '')


class SuspendTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name)/'suspend.json'
        self.host = FakeHost()
        self.now = 1000
        self.events = []
        self.service = m.SuspendLease(self.path, self.host, lambda: self.now,
            lambda c, k, n, **kw: self.events.append((n, kw)))

    def stop(self, then='cont', deadline='10m'):
        return self.service.stop(20, deadline, then, 'load', 'test')

    def ledger(self):
        return json.loads(self.path.read_text())

    def signals(self):
        return [e[2] for e in self.host.effects if e[0] == 'signal']

    def test_durable_lease_before_stop_and_crash_before_signal(self):
        def crash(sig):
            self.assertEqual(self.ledger()['leases']['20']['deadline'], 1600)
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
            raise Crash()
        self.host.before_signal = crash
        with patch.object(m.os, 'fsync', wraps=os.fsync) as fsync:
            with self.assertRaises(Crash):
                self.stop()
            self.assertGreaterEqual(fsync.call_count, 2)
        self.now += 601
        self.service.sweep()
        self.assertEqual(self.signals(), [])
        self.assertEqual(self.ledger()['leases'], {})

    def test_stop_readback_and_resume(self):
        self.stop()
        self.assertEqual(self.host.live[20]['stat'], 'T')
        self.assertEqual(self.service.listing()[0]['timeLeftS'], 600)
        self.assertTrue(self.service.release(20, 'resume')['ok'])
        self.assertEqual(self.signals(), [signal.SIGSTOP, signal.SIGCONT])
        self.assertEqual(self.ledger()['leases'], {})
        for index, effect in enumerate(self.host.effects):
            if effect[0] == 'signal':
                self.assertEqual(self.host.effects[index+1][0], 'read')

    def test_credentials_redacted_before_lease_write_log_and_every_output(self):
        for form, command in CREDENTIAL_COMMANDS:
            with self.subTest(form=form):
                self.host.live = {20: proc(comm='/opt/tool', command=command)}
                def inspect_before_signal(sig):
                    self.assertNotIn('EXAMPLE_ONLY', self.path.read_text())
                self.host.before_signal = inspect_before_signal
                with patch('sys.stdout', new_callable=io.StringIO) as output:
                    self.assertEqual(m.main(['stop', '--pid', '20', '--deadline', '1m', '--then', 'cont',
                        '--reason', 'load', '--actor', 'test'], self.service), 0)
                    self.assertEqual(m.main(['list', '--json'], self.service), 0)
                    self.assertEqual(m.main(['list'], self.service), 0)
                    self.assertEqual(m.main(['sweep', '--json'], self.service), 0)
                exposed = json.dumps([self.events, self.service.listing()])+output.getvalue()+self.path.read_text()
                self.assertNotIn('EXAMPLE_ONLY', exposed)
                self.assertTrue(self.service.release(20, 'resume')['ok'])
                # Protection compares the fresh raw process, not persisted labels.
                self.assertEqual(self.host.live[20]['command'], command)

    def test_orphan_credentials_redacted_before_storage_alert_and_logger_boundary(self):
        self.host.owner = lambda p: p['command']
        for index, (form, command) in enumerate(CREDENTIAL_COMMANDS):
            with self.subTest(form=form):
                self.host.live = {20: proc(stat='T', comm='/opt/tool', command=command,
                    start=f'Sun Nov 22 10:00:{index:02d} 2026')}
                result = self.service.sweep()
                self.now += 600
                overdue = self.service.sweep()
                row = toollog.record('suspend', 'event', 'suspend.orphan', dt.datetime.now(dt.timezone.utc),
                                     props=dict(command=command, owner=command, comm=command))
                exposed = json.dumps([result, overdue, row, self.events, self.host.effects])+self.path.read_text()
                self.assertNotIn('EXAMPLE_ONLY', exposed)
                self.assertEqual(self.signals(), [])
                self.host.live = {}
                self.service.sweep()

    def test_old_ledger_is_scrubbed_before_list_or_sweep(self):
        for form, command in CREDENTIAL_COMMANDS:
            with self.subTest(form=form):
                p = proc(command=command)
                lease = dict(p, createdAt=self.now, deadline=self.now+600, then='cont', reason='load', actor='test')
                entry = dict(p, firstSeen=self.now, owner=command, overdue=False)
                self.path.write_text(json.dumps(dict(version=1, leases={'20': lease},
                    unowned={m.identity(p): entry}, alerts={})))
                with patch('sys.stdout', new_callable=io.StringIO) as output:
                    self.assertEqual(m.main(['list', '--json'], self.service), 0)
                self.assertNotIn('EXAMPLE_ONLY', output.getvalue()+self.path.read_text())
                self.assertEqual(self.signals(), [])

    def test_missing_redactor_does_not_expose_argv(self):
        self.host.live[20]['command'] = 'tool --api-key EXAMPLE_ONLY'
        with patch.object(m, 'command_label', return_value=None):
            lease = self.stop()
            self.assertEqual(lease['command'], '[redacted]')
            self.assertNotIn('EXAMPLE_ONLY', self.path.read_text()+json.dumps(self.events))
        with patch('cpu_labels.command_label', return_value=None):
            self.assertEqual(toollog.suspend_fields(dict(command='tool --api-key EXAMPLE_ONLY')),
                             dict(command='[redacted]'))

    def test_raw_argv_change_is_detected_even_if_redacted_labels_match(self):
        self.host.live[20]['command'] = 'tool --api-key EXAMPLE_ONLY'
        self.stop()
        self.host.effects.clear()
        def protection(p):
            self.host.live[20]['command'] = 'tool --api-key SECOND_ONLY'
            return False
        self.host.protected = protection
        self.assertFalse(self.service.release(20, 'resume')['ok'])
        self.assertEqual(self.signals(), [])

    def fail_stop_read(self, sig):
        if sig == signal.SIGSTOP:
            self.host.read_fail = 1

    def test_readback_failure_rolls_back_and_cli_fails(self):
        self.host.before_signal = self.fail_stop_read
        with patch('sys.stdout', new_callable=io.StringIO), patch('sys.stderr', new_callable=io.StringIO):
            rc = m.main(['stop', '--pid', '20', '--deadline', '10m', '--then', 'cont',
                         '--reason', 'load', '--actor', 'test'], self.service)
        self.assertEqual(rc, 1)
        self.assertEqual(self.signals(), [signal.SIGSTOP, signal.SIGCONT])
        self.assertEqual(self.ledger()['leases'], {})
        self.assertEqual(self.host.live[20]['stat'], 'S')
        self.assertIn('suspend.stop_failed', [n for n, _ in self.events])

    def test_failed_rollback_retains_recoverable_lease(self):
        self.host.ignore.add(signal.SIGCONT)
        self.host.before_signal = self.fail_stop_read
        with self.assertRaises(RuntimeError):
            self.stop()
        self.assertIn('20', self.ledger()['leases'])
        self.host.before_signal = lambda sig: None
        self.host.ignore.clear()
        self.now += 601
        self.service.sweep()
        self.assertEqual(self.ledger()['leases'], {})

    def test_external_stop_during_each_protection_lookup_is_never_adopted(self):
        for lookup in (1, 2):
            for stat in ('T', 'T+', 'Ts'):
                with self.subTest(lookup=lookup, stat=stat):
                    self.host.live = {20: proc()}
                    self.host.effects.clear()
                    calls = []
                    def protection(p):
                        calls.append(p)
                        if len(calls) == lookup:
                            self.host.live[20]['stat'] = stat
                        return False
                    self.host.protected = protection
                    with self.assertRaises((ValueError, RuntimeError)):
                        self.stop()
                    self.assertEqual(self.signals(), [])
                    self.assertEqual(self.host.live[20]['stat'], stat)
                    del self.host.protected
                    result = self.service.sweep()
                    self.assertEqual(result['leases'], [])
                    self.assertEqual(result['unowned'][0]['pid'], 20)
                    self.assertEqual(self.signals(), [])
                    self.host.live = {}
                    self.service.sweep()

    def test_refused_stop_does_not_send_rollback_cont(self):
        def denied(sig):
            raise PermissionError('not permitted')
        self.host.before_signal = denied
        with self.assertRaises(RuntimeError):
            self.stop()
        self.assertEqual(self.signals(), [])
        self.assertEqual(self.ledger()['leases'], {})
        self.assertEqual(self.events[-1][1]['props']['readBack'],
                         [dict(signal='SIGSTOP', stat='S', sent=False)])

    def test_deadline_forms_and_cap(self):
        for value, expected in [('1s', 1), ('10m', 600), ('60m', 3600), ('1h', 3600), ('3600s', 3600)]:
            with self.subTest(value=value):
                self.assertEqual(m.duration(value), expected)
        for value in [None, '', '0m', '-1m', '1.5m', '10', '61m', '3601s', '2h', '10M', ' 10m', '10m ']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                m.duration(value)
        with patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit) as caught:
            m.main(['stop', '--pid', '20', '--then', 'cont', '--actor', 'test', '--reason', 'load'], self.service)
        self.assertEqual(caught.exception.code, 2)
        self.assertEqual(self.signals(), [])

    def test_protected_matrix(self):
        cases = [proc(pid=1), proc(comm='launchd'), proc(comm='kernel_task'), proc(comm='WindowServer'),
            proc(comm='/System/Library/daemon'), proc(comm='/usr/libexec/daemon'),
            proc(comm='/usr/sbin/daemon'), proc(comm='/sbin/daemon'),
            proc(comm='/Applications/Robob.app/Contents/MacOS/Robob'),
            proc(comm='/Applications/Dia.app/Contents/MacOS/Dia'), proc(comm='codex'),
            proc(comm='codex-aarch64-apple-darwin'),
            proc(comm='node', command='node /workspace/apps/server/dist/bin.mjs'),
            proc(comm='node', command='node /opt/codex/bin/codex.js --dangerously-bypass-approvals-and-sandbox'),
            proc(comm='bun', command='bun /opt/opencode/bin/opencode serve'),
            proc(comm='python3.15', command='python3.15 /opt/gemini-cli/main.py'),
            proc(comm='sh', command="sh -c 'codex'"), proc(comm='node', command='node')]
        for p in cases:
            with self.subTest(p=p):
                self.host.live = {p['pid']: p}
                with self.assertRaisesRegex(ValueError, 'protected'):
                    self.service.stop(p['pid'], '1m', 'cont', 'load', 'test')
        self.assertEqual(self.signals(), [])

    def test_cua_driver_protection_in_stop_and_all_recovery_paths(self):
        for comm in ('cua-driver', '/opt/homebrew/bin/cua-driver', '/opt/cua-driver-helper', '/opt/cua-driver/worker'):
            with self.subTest(comm=comm):
                p = proc(comm=comm, command=comm+' mcp')
                self.host.live = {20: p}
                self.assertTrue(m.Host(Mock()).protected(p))
                with self.assertRaisesRegex(ValueError, 'protected'):
                    self.stop()
                self.assertEqual(self.signals(), [])
                p['stat'] = 'T'
                for action in ('resume', 'kill', 'sweep-cont', 'sweep-kill'):
                    with self.subTest(action=action):
                        lease = dict(p, createdAt=0, deadline=1, then='kill' if action.endswith('kill') else 'cont')
                        with self.service.locked() as state:
                            state['leases']['20'] = lease
                            self.service.save(state)
                        result = self.service.sweep()['actions'][0] if action.startswith('sweep') else self.service.release(20, action)
                        self.assertFalse(result['ok'])
                        self.assertEqual(self.signals(), [])
                with self.service.locked() as state:
                    state['leases'].clear()
                    self.service.save(state)

    def test_recovery_checks_raw_comm_even_when_saved_label_was_redacted(self):
        self.stop('kill')
        self.host.effects.clear()
        self.host.live[20]['comm'] = '/Users/owner/cua-driver/worker'
        self.assertFalse(self.service.release(20, 'kill')['ok'])
        self.assertEqual(self.signals(), [])

    def test_expired_cont_and_kill_grace(self):
        for action in ('cont', 'kill'):
            with self.subTest(action=action):
                self.host.live = {20: proc()}
                self.host.effects = []
                self.stop(action, '1m')
                self.now += 60
                result = self.service.sweep()
                self.assertTrue(result['actions'][0]['ok'])
                self.assertEqual(self.ledger()['leases'], {})
                if action == 'cont':
                    self.assertEqual(self.signals(), [signal.SIGSTOP, signal.SIGCONT])
                else:
                    self.assertEqual(self.signals(), [signal.SIGSTOP, signal.SIGTERM, signal.SIGKILL])
                    term = self.host.effects.index(('signal', 20, signal.SIGTERM))
                    kill = self.host.effects.index(('signal', 20, signal.SIGKILL))
                    self.assertIn(('sleep', 5), self.host.effects[term:kill])

    def test_kill_readback_failure_alert_dedup(self):
        self.stop('kill', '1s')
        self.host.ignore.add(signal.SIGKILL)
        self.now += 1
        for _ in range(3):
            self.assertFalse(self.service.sweep()['actions'][0]['ok'])
        self.assertEqual(len([e for e in self.host.effects if e[0] == 'notify']), 1)
        self.assertIn('20', self.ledger()['leases'])

    def test_reused_pid_never_signalled_in_every_action(self):
        for action in ('sweep', 'resume', 'kill'):
            with self.subTest(action=action):
                self.host.live = {20: proc()}
                self.stop()
                self.host.effects.clear()
                self.host.live[20]['start'] = 'Sun Nov 22 11:00:00 2026'
                self.now += 601
                self.service.sweep() if action == 'sweep' else self.service.release(20, action)
                self.assertEqual(self.signals(), [])
                self.assertEqual(self.ledger()['leases'], {})

    def test_unowned_logs_twice_alerts_once_never_signals(self):
        self.host.live[20]['stat'] = 'T'
        self.service.sweep()
        self.now += 599
        self.service.sweep()
        self.assertFalse([e for e in self.host.effects if e[0] == 'notify'])
        self.now += 1
        self.service.sweep()
        self.service.sweep()
        self.assertEqual(len([n for n, _ in self.events if n == 'suspend.orphan']), 2)
        self.assertEqual(len([e for e in self.host.effects if e[0] == 'notify']), 1)
        for action in ('resume', 'kill'):
            with self.assertRaises(ValueError):
                self.service.release(20, action)
        self.assertEqual(self.signals(), [])
        self.host.live = {}
        self.assertEqual(self.service.sweep()['unowned'], [])

    def test_alert_retry_exact_text_and_key(self):
        self.host.live[20]['stat'] = 'T'
        self.service.sweep()
        self.host.notify_ok = False
        self.now += 600
        self.service.sweep()
        self.now += 100
        self.host.notify_ok = True
        self.service.sweep()
        notices = [e for e in self.host.effects if e[0] == 'notify']
        self.assertEqual(len(notices), 2)
        self.assertEqual(notices[0], notices[1])

    def test_stop_sweep_share_exclusive_lock(self):
        attempted, finished = threading.Event(), threading.Event()
        failures = []
        class Sweeper(m.SuspendLease):
            @contextmanager
            def locked(inner):
                attempted.set()
                with super().locked() as state:
                    yield state
        sweeper = Sweeper(self.path, self.host, lambda: self.now, self.service.logger)
        def sweep():
            try:
                sweeper.sweep()
            except BaseException as exc:
                failures.append(exc)
            finally:
                finished.set()
        thread = threading.Thread(target=sweep)
        def during_stop(sig):
            thread.start()
            self.assertTrue(attempted.wait(2))
            with self.path.with_suffix('.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(finished.is_set())
            self.assertIn('20', self.ledger()['leases'])
        self.host.before_signal = during_stop
        self.stop()
        thread.join(3)
        self.assertTrue(finished.is_set())
        self.assertEqual(failures, [])
        self.assertIn('20', self.ledger()['leases'])
        self.assertEqual(self.ledger()['unowned'], {})

    def test_corrupt_ledger_refuses_signals(self):
        self.path.write_text('{oops')
        with self.assertRaises(ValueError):
            self.stop()
        self.assertEqual(self.signals(), [])

    def test_pid_reuse_between_term_and_kill(self):
        self.stop('kill', '1s')
        self.host.effects.clear()
        def grace(seconds):
            self.host.live[20] = proc(start='Sun Nov 22 11:00:00 2026')
        self.host.sleep = grace
        self.assertTrue(self.service.release(20, 'kill')['ok'])
        self.assertEqual(self.signals(), [signal.SIGTERM])

    def test_birth_or_exec_change_during_protection_never_signals(self):
        for field, value in [('start', 'Sun Nov 22 11:00:00 2026'),
                             ('comm', '/Applications/Robob.app/Contents/MacOS/Robob')]:
            with self.subTest(field=field):
                self.host.live = {20: proc()}
                self.stop()
                self.host.effects.clear()
                def protection(p):
                    self.host.live[20][field] = value
                    return False
                self.host.protected = protection
                self.service.release(20, 'resume')
                self.assertEqual(self.signals(), [])
                del self.host.protected
                self.host.live = {}
                self.service.sweep()

    def test_interrupted_manual_kill_keeps_killing_intent(self):
        self.stop('cont')
        self.host.ignore.add(signal.SIGKILL)
        self.assertFalse(self.service.release(20, 'kill')['ok'])
        self.host.ignore.clear()
        self.host.live[20]['stat'] = 'S'
        self.assertEqual(self.service.sweep()['actions'][0]['action'], 'kill')
        self.assertEqual(self.ledger()['leases'], {})

    def test_runtime_server_pid_is_protected_even_with_unfamiliar_argv(self):
        runtime = self.path.parent/m.PROTECTED['server_runtime']
        runtime.parent.mkdir(parents=True)
        runtime.write_text(json.dumps(dict(pid=20)))
        run = Mock(side_effect=[subprocess.CompletedProcess([], 0, '20 1 S Sun Nov 22 10:00:00 2026 node\n', ''),
            subprocess.CompletedProcess([], 0, 'Sun Nov 22 10:00:00 2026 node unknown-server.js\n', '')])
        with patch.object(Path, 'home', return_value=self.path.parent):
            self.assertTrue(m.protected(m.Host(run).process(20)))

    def test_integration_services_and_guard_are_protected(self):
        for label in ['com.abdullah.fixture', 'com.ardud.opencode-service', 'local.ardud.fixture']:
            with self.subTest(label=label):
                runner = lambda *a, **kw: subprocess.CompletedProcess([], 0, '30 0 '+label, '')
                host = m.Host(runner)
                host.process = lambda pid: proc(pid=30)
                self.assertTrue(host.protected(dict(proc(), ppid=30)))
        self.assertTrue(m.protected(proc(comm='python3', command='python3 /opt/mac_guard.py')))
        self.assertTrue(m.protected(proc(comm='python3', command='python3 /opt/suspend_lease.py sweep')))
        host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 1, '', 'unavailable'))
        with self.assertRaises(OSError):
            host.protected(proc())

    def test_build_below_provider_is_allowed_provider_is_protected(self):
        for p in [proc(pid=30, comm='codex', command='codex exec'),
                  proc(pid=30, comm='node', command='node /opt/codex/bin/codex.js')]:
            with self.subTest(parent=p):
                host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 0, '1 0 init', ''))
                host.process = lambda pid: p
                self.assertFalse(host.protected(dict(proc(), ppid=30)))
                self.assertTrue(host.protected(p))

    def test_provider_identity_and_service_ancestry_matrix(self):
        cases = [
            ('codex', 'codex exec', True),
            ('node', 'node /opt/codex/bin/codex.js exec', True),
            ('bun', 'bun /opt/opencode/bin/opencode serve', True),
            ('/opt/codex-aarch64-apple-darwin', '/opt/codex-aarch64-apple-darwin exec', True),
            ('node', 'node /opt/@openai/codex/bin/codex.js exec', True),
            ('node', 'node /opt/@anthropic-ai/claude-code/cli.js', True),
            ('node', 'node /opt/@google/gemini-cli/dist/index.js', True),
            ('node', 'node /opt/archive.js --provider codex', False),
            ('node', 'node /opt/archive.js /opt/codex/bin/codex.js', False),
            ('node', 'node /opt/archive.js --prompt "use codex"', False),
            ('node', 'node --eval "codex"', False),
            ('node', 'node /workspace/codex-project/monitor.js', False),
            ('/workspace/codex-tools/monitor', '/workspace/codex-tools/monitor', False),
            ('node', 'node /workspace/codex/monitor.js', False),
            ('node', 'node /workspace/@openai/codex/monitor.js', False),
            ('node', 'node /workspace/codex/bin/monitor.js', False),
            ('node', 'node /workspace/claude-code/monitor.js', False),
            ('node', 'node /workspace/opencode-work/monitor.js', False),
            ('node', 'node /workspace/unrelated/codex.js', False),
            ('codex-monitor', 'codex-monitor', False),
        ]
        for comm, command, provider in cases:
            for label in ('com.abdullah.fixture', 'com.ardud.fixture', 'local.ardud.fixture'):
                for labelled in (30, 40):
                    with self.subTest(command=command, label=label, labelled=labelled):
                        parent = dict(proc(pid=30, comm=comm, command=command), ppid=40)
                        self.assertEqual(m.provider_process(parent), provider)
                        runner = lambda *a, **kw: subprocess.CompletedProcess([], 0, f'{labelled} 0 {label}', '')
                        host = m.Host(runner)
                        host.process = lambda pid: {30: parent, 40: proc(pid=40)}[pid]
                        self.assertTrue(host.protected(dict(proc(), ppid=30)))
            with self.subTest(command=command, ancestor='Robob'):
                parent = dict(proc(pid=30, comm=comm, command=command), ppid=40)
                host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 0, '', ''))
                host.process = lambda pid: {30: parent, 40: dict(proc(pid=40), robobServer=True)}[pid]
                self.assertEqual(host.protected(dict(proc(), ppid=30)), not provider)

    def test_expected_birth_and_duplicate_stop_refused(self):
        with self.assertRaises(ValueError):
            self.service.stop(20, '1m', 'cont', 'load', 'test', expected_start='old birth')
        self.assertEqual(self.signals(), [])
        self.stop()
        deadline = self.ledger()['leases']['20']['deadline']
        with self.assertRaises(ValueError):
            self.stop()
        self.assertEqual(self.ledger()['leases']['20']['deadline'], deadline)

    def test_every_signal_respects_robob_provider_boundary(self):
        for provider in (False, True):
            for sig in (signal.SIGSTOP, signal.SIGCONT, signal.SIGTERM, signal.SIGKILL):
                with self.subTest(provider=provider, sig=sig):
                    rows = {20: dict(proc(), ppid=30),
                            30: dict(proc(pid=30, comm='codex' if provider else '/opt/chrome',
                                          command='codex exec' if provider else '/opt/chrome'), ppid=40),
                            40: dict(proc(pid=40), robobServer=True)}
                    host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 0, '', ''))
                    host.process = lambda pid: copy.deepcopy(rows.get(pid))
                    host.signal = Mock()
                    service = m.SuspendLease(self.path, host, lambda: self.now, lambda *a, **kw: None)
                    if provider:
                        service.send(rows[20], sig, [])
                        host.signal.assert_called_once_with(20, sig)
                    else:
                        with self.assertRaisesRegex(ValueError, 'protected process'):
                            service.send(rows[20], sig, [])
                        host.signal.assert_not_called()

    def test_lease_below_provider_proceeds_server_renderer_refused(self):
        for provider in (False, True):
            with self.subTest(provider=provider):
                job = dict(proc(), ppid=30)
                rows = {20: job,
                        30: dict(proc(pid=30, comm='codex' if provider else '/opt/chrome',
                                      command='codex exec' if provider else '/opt/chrome'), ppid=40),
                        40: dict(proc(pid=40), robobServer=True)}
                host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 0, '', ''))
                host.process = lambda pid: copy.deepcopy(rows.get(pid))
                def send(pid, sig):
                    rows[pid]['stat'] = 'T' if sig == signal.SIGSTOP else 'S'
                host.signal = Mock(side_effect=send)
                service = m.SuspendLease(self.path, host, lambda: self.now, lambda *a, **kw: None)
                if provider:
                    service.stop(20, '1m', 'cont', 'load', 'test')
                    self.assertIn('20', self.ledger()['leases'])
                    self.assertEqual(rows[20]['stat'], 'T')
                    self.assertTrue(service.release(20, 'resume')['ok'])
                else:
                    with self.assertRaisesRegex(ValueError, 'protected process'):
                        service.stop(20, '1m', 'cont', 'load', 'test')
                    host.signal.assert_not_called()

    def test_live_rebuild_regen_chain_below_claude_can_be_leased(self):
        app = '/Applications/Robob.app/Contents/MacOS/Robob'
        claude = '/Users/test/.robob/harness-cli/claude/current/bin/claude'
        entries = [
            (45313, 61049, 'node', 'node scripts/test-rebuild-start-paths-regen.mjs'),
            (61049, 60963, '/opt/python/Python.app/Contents/MacOS/Python', 'python3 probe.py'),
            (60963, 60962, 'node', 'node /opt/safe-chain/bin/safe-chain.js python3 probe.py'),
            (60962, 60787, '/bin/zsh', 'zsh -c job'),
            (60787, 62309, '/bin/zsh', 'zsh -l'),
            (62309, 80622, claude, claude),
            (80622, 80256, app, app + ' apps/server/dist/bin.mjs --bootstrap-fd 3'),
            (80256, 1, app, app),
        ]
        rows = {pid: dict(proc(pid=pid, comm=comm, command=command), ppid=ppid)
                for pid, ppid, comm, command in entries}
        rows[45313]['start'] = 'Mon Nov 23 03:18:44 2026'
        host = m.Host(lambda *a, **kw: subprocess.CompletedProcess([], 0, '', ''))
        host.process = lambda pid: copy.deepcopy(rows.get(pid))
        def send(pid, sig):
            rows[pid]['stat'] = 'T' if sig == signal.SIGSTOP else 'S'
        host.signal = Mock(side_effect=send)
        service = m.SuspendLease(self.path, host, lambda: self.now, lambda *a, **kw: None)
        service.stop(45313, '10m', 'cont', 'CPU-heavy agent test', 'critical responder',
                     expected_start=rows[45313]['start'])
        host.signal.assert_called_once_with(45313, signal.SIGSTOP)
        self.assertEqual(self.ledger()['leases']['45313']['deadline'], self.now + 600)
        self.assertEqual(rows[45313]['stat'], 'T')
        self.assertTrue(service.release(45313, 'resume')['ok'])
        self.assertEqual(host.signal.call_args.args, (45313, signal.SIGCONT))
        self.assertNotIn('45313', self.ledger()['leases'])

    def test_unknown_birth_retained_other_expired_lease_still_recovers(self):
        self.stop()
        self.host.live[21] = proc(pid=21)
        self.service.stop(21, '1s', 'cont', 'load', 'test')
        original = self.host.process
        def read(pid):
            if pid == 20:
                raise OSError('unavailable')
            return original(pid)
        self.host.process = read
        self.now += 601
        self.service.sweep()
        self.assertIn('20', self.ledger()['leases'])
        self.assertNotIn('21', self.ledger()['leases'])

    def test_parser_and_owner_lookup(self):
        raw = ' 49256 T Mon Nov 17 13:00:00 2026 /usr/bin/python3 /Users/a/export_opencode.py\n 2 S Mon Nov 17 13:00:00 2026 launchd\n'
        p = m.parse_stopped(raw)[0]
        self.assertEqual(p['start'], 'Mon Nov 17 13:00:00 2026')
        runner = lambda *a, **kw: subprocess.CompletedProcess(a, 0, 'PID Status Label\n49256 0 com.abdullah.opencode-readonly\n', '')
        self.assertEqual(m.Host(runner).owner(p), 'com.abdullah.opencode-readonly')

    def test_host_birth_and_missing_vs_error(self):
        run = Mock(side_effect=[subprocess.CompletedProcess([], 0, '20 1 T Sun Nov 22 10:00:00 2026 /bin/sleep\n', ''),
            subprocess.CompletedProcess([], 0, 'Sun Nov 22 10:00:00 2026 /bin/sleep 600\n', '')])
        self.assertEqual(m.Host(run).process(20), proc(stat='T'))
        self.assertTrue(all(call.kwargs['timeout'] == m.TIMEOUTS['ps'] for call in run.call_args_list))
        for rc, err, missing in [(1, '', True), (1, 'permission denied', False), (2, '', False)]:
            run = lambda *a, **kw: subprocess.CompletedProcess(a, rc, '', err)
            if missing:
                self.assertIsNone(m.Host(run).process(20))
            else:
                with self.assertRaises(OSError):
                    m.Host(run).process(20)

    def subprocess_host(self):
        run = FakeRun(self.host.live)
        host = m.Host(run)
        host.signal = self.host.signal
        self.service.host = host
        return host, run

    def cli(self, *args):
        with patch('sys.stdout', new_callable=io.StringIO), patch('sys.stderr', new_callable=io.StringIO):
            return m.main(list(args), self.service)

    def timeout_event(self, cmd, timeout):
        props = [kw['props'] for name, kw in self.events if name == 'suspend.error'
                 and kw['props']['result'] == 'TimeoutExpired'][-1]
        self.assertEqual(props['cmd'], cmd)
        self.assertEqual(props['timeoutS'], timeout)
        for key in ('timeoutS', 'elapsedMs', 'loadAvg1'):
            self.assertIn(type(props[key]), (int, float))
            self.assertTrue(math.isfinite(props[key]))
        self.assertGreaterEqual(props['elapsedMs'], 0)
        row = toollog.record('suspend', 'error', 'suspend.error', dt.datetime.now(dt.timezone.utc), props=props)
        for key in ('result', 'cmd', 'timeoutS', 'elapsedMs', 'loadAvg1'):
            self.assertEqual(row['props'][key], props[key])
        self.assertNotIn('private', json.dumps(row))
        return props

    def test_every_subprocess_uses_central_timeouts(self):
        host, run = self.subprocess_host()
        self.assertEqual(host.process(20), proc())
        self.assertEqual(host.stopped(), [])
        self.assertFalse(host.protected(proc()))
        self.assertEqual(host.owner(proc()), '/bin/sleep')
        self.assertTrue(host.notify('fixture', 'fixture'))
        self.assertEqual([kwargs['timeout'] for _, kwargs in run.calls],
                         [m.TIMEOUTS[key] for key in
                          ('ps', 'ps', 'ps', 'launchctl_list', 'owner_list', 'procinfo', 'notify')])
        self.assertEqual(self.signals(), [])

    def test_stopped_listing_retries_once_and_sweep_succeeds(self):
        _, run = self.subprocess_host()
        run.timeout_calls = {1}
        self.assertEqual(self.cli('sweep', '--json'), 0)
        self.assertEqual(len(run.calls), 2)
        self.assertTrue(all('-axo' in argv for argv, _ in run.calls))
        self.assertEqual(self.events[-1][0], 'suspend.sweep')
        self.assertFalse([name for name, _ in self.events if name == 'suspend.error'])
        self.assertEqual(self.signals(), [])

    def test_stopped_listing_two_timeouts_fail_with_context_and_no_signals(self):
        _, run = self.subprocess_host()
        run.timeout_calls = {1, 2}
        with patch.object(m.time, 'monotonic', side_effect=[10, 10.25, 11, 11.125]), \
                patch.object(m.os, 'getloadavg', return_value=(70.5, 60, 50)):
            self.assertEqual(self.cli('sweep', '--json'), 1)
        self.assertEqual(len(run.calls), 2)
        props = self.timeout_event('ps -axo', m.TIMEOUTS['ps'])
        self.assertEqual(props['elapsedMs'], 125)
        self.assertEqual(props['loadAvg1'], 70.5)
        self.assertEqual(self.signals(), [])

    def test_protection_list_timeout_refuses_stop_without_retry(self):
        _, run = self.subprocess_host()
        run.timeout_calls = {3}
        self.assertEqual(self.cli('stop', '--pid', '20', '--deadline', '1m', '--then', 'cont',
                                  '--reason', 'load', '--actor', 'test'), 1)
        self.assertEqual([argv for argv, _ in run.calls if argv[0] == '/bin/launchctl'],
                         [['/bin/launchctl', 'list']])
        self.timeout_event('launchctl list', m.TIMEOUTS['launchctl_list'])
        self.assertEqual(self.signals(), [])
        self.assertFalse(self.path.exists())

    def test_per_pid_ps_timeouts_do_not_retry_or_expose_pid(self):
        for call in (1, 2):
            with self.subTest(call=call):
                _, run = self.subprocess_host()
                run.timeout_calls = {call}
                with self.assertRaises(m.CommandTimeout) as caught:
                    self.service.host.process(20)
                self.assertEqual(len(run.calls), call)
                self.assertEqual(caught.exception.fields['cmd'], 'ps -p')
                self.assertIsNone(caught.exception.output)
                self.assertIsNone(caught.exception.stderr)

    def test_owner_timeouts_remain_best_effort_without_retry(self):
        for calls in ({1}, {2}, {1, 2}):
            with self.subTest(calls=calls):
                host, run = self.subprocess_host()
                run.timeout_calls = calls
                self.assertEqual(host.owner(proc()), '/bin/sleep')
                self.assertEqual(len(run.calls), 2)
                self.assertEqual([kwargs['timeout'] for _, kwargs in run.calls],
                                 [m.TIMEOUTS['owner_list'], m.TIMEOUTS['procinfo']])

    def test_listing_command_timeout_logs_context(self):
        self.stop()
        _, run = self.subprocess_host()
        run.timeout_calls = {2}
        self.assertEqual(self.cli('list', '--json'), 1)
        self.timeout_event('ps -p', m.TIMEOUTS['ps'])
        self.assertEqual(len(run.calls), 2)
        self.assertIn('20', self.ledger()['leases'])

    def test_sweep_identity_timeout_logs_context_and_keeps_lease(self):
        self.stop()
        self.host.effects.clear()
        _, run = self.subprocess_host()
        run.timeout_calls = {1}
        self.service.sweep()
        self.timeout_event('ps -p', m.TIMEOUTS['ps'])
        self.assertIn('20', self.ledger()['leases'])
        self.assertEqual(self.signals(), [])

    def test_release_timeout_logs_context_and_keeps_lease(self):
        self.stop()
        self.host.effects.clear()
        _, run = self.subprocess_host()
        run.timeout_calls = {1}
        self.assertEqual(self.cli('resume', '--pid', '20'), 1)
        self.timeout_event('ps -p', m.TIMEOUTS['ps'])
        self.assertIn('20', self.ledger()['leases'])
        self.assertEqual(self.signals(), [])

    def test_notification_timeout_logs_only_program_and_script_and_keeps_alert(self):
        self.host.live[20]['stat'] = 'T'
        self.service.sweep()
        self.now += 600
        host, run = self.subprocess_host()
        host.stopped = self.host.stopped
        run.timeout_calls = {1}
        self.assertEqual(self.cli('sweep', '--json'), 0)
        self.timeout_event('bun cli.ts', m.TIMEOUTS['notify'])
        self.assertEqual(len(run.calls), 1)
        self.assertFalse(next(iter(self.ledger()['alerts'].values()))['sent'])
        self.assertEqual(self.signals(), [])

    def test_plist_installer_status_and_event_payload(self):
        job = plistlib.loads((HERE/'launchd/com.abdullah.mac-suspend.plist').read_bytes())
        self.assertEqual(job['StartInterval'], 60)
        self.assertIn('sweep', job['ProgramArguments'])
        self.assertIn('com.abdullah.mac-suspend', status.LAUNCHD_LABELS)
        self.assertEqual(status.CADENCES['suspend.sweep']['gapHours'], .05)
        installer = (HERE/'install.zsh').read_text()
        self.assertIn('suspend_lease.py;', installer)
        self.assertIn('"$here/mac-suspend"', installer)
        self.stop()
        row = toollog.record('suspend', 'event', 'suspend.stop', dt.datetime.now(dt.timezone.utc), props=self.events[-1][1]['props'])
        self.assertEqual(row['props']['readBack'], [dict(signal='SIGSTOP', stat='T', sent=True)])
        self.assertEqual(row['props']['actor'], 'test')
        self.assertEqual(row['props']['start'], proc()['start'])
        self.assertEqual(toollog.safe_fields(dict(command='node --token=secret'), 'suspend.orphan')['command'], '[redacted]')

    def test_sweep_cadence_before_start_fresh_and_overdue(self):
        root = self.path.parent/'logs'
        root.mkdir()
        for at, expected in [('2026-11-21T23:59:00Z', 'PENDING'),
                             ('2026-11-22T00:01:00Z', 'OK'),
                             ('2026-11-22T00:04:00Z', 'SILENT')]:
            with self.subTest(at=at):
                self.assertEqual(status.report(at, root)['jobs']['suspend.sweep']['status'], expected)
        row = dict(tool='mac', kind='event', name='suspend.sweep', ts='2026-11-22T12:00:00Z', ok=True)
        (root/'2026-11-22.ndjson').write_text(json.dumps(row)+'\n')
        for at, expected in [('2026-11-22T12:01:00Z', 'OK'), ('2026-11-22T12:04:00Z', 'LATE')]:
            with self.subTest(at=at):
                self.assertEqual(status.report(at, root)['jobs']['suspend.sweep']['status'], expected)


if __name__ == '__main__':
    unittest.main()
