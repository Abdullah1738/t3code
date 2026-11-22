import copy
from contextlib import contextmanager
import datetime as dt
import fcntl
import io
import json
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
        self.assertTrue(all(call.kwargs['timeout'] == 2 for call in run.call_args_list))
        for rc, err, missing in [(1, '', True), (1, 'permission denied', False), (2, '', False)]:
            run = lambda *a, **kw: subprocess.CompletedProcess(a, rc, '', err)
            if missing:
                self.assertIsNone(m.Host(run).process(20))
            else:
                with self.assertRaises(OSError):
                    m.Host(run).process(20)

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
