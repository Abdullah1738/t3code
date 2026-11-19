import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from guard import Guard, Runtime, fresh, read_json, write_json
from toollog import clean

BASE = 1794967200000


class GuardTests(unittest.TestCase):
    def rig(self, state=None, succeeds=True):
        self.events, self.actions, self.alerts = [], [], []
        def action(value):
            self.actions.append(value)
            return succeeds
        def notify(text, key):
            self.alerts.append((text, key))
            return True
        return Guard(state=state, event=lambda name, **props: self.events.append((name, props)), action=action, notify=notify)

    def test_absent_bootstraps_immediately_with_backoff_and_one_transition(self):
        guard = self.rig(succeeds=False)
        for seconds in (0, 1, 14, 15, 30, 45, 60):
            guard.step(BASE + seconds * 1000, 'absent', 'refused')
        self.assertEqual(self.actions, ['bootstrap'] * 3)
        self.assertEqual([name for name, _ in self.events].count('listener.down'), 1)
        self.assertEqual(guard.state['nextActionMs'], BASE + 105000)

    def test_loaded_refusal_kicks_only_after_sixty_seconds(self):
        guard = self.rig()
        for seconds in (0, 59, 60, 61):
            guard.step(BASE + seconds * 1000, 'loaded', 'refused')
        self.assertEqual(self.actions, ['kickstart'])

    def test_unknown_launchd_with_open_tcp_never_opens_down_window(self):
        guard = self.rig()
        for seconds in (0, 15, 120, 180):
            guard.step(BASE + seconds * 1000, 'unknown', 'open', dict(status='failed', startedAtMs=BASE))
        guard.step(BASE + 195000, 'loaded', 'open')
        self.assertEqual([name for name, _ in self.events], ['listener.state_unknown', 'listener.state_resolved'])
        self.assertEqual(self.events[1][1]['unknownMs'], 195000)
        self.assertNotIn('downSinceMs', guard.state)
        self.assertEqual(self.actions, [])
        self.assertEqual(self.alerts, [])

    def test_failed_marker_age_class(self):
        cases = [({}, False), ({'startedAtMs': BASE - 10822586}, False),
                 ({'startedAtMs': BASE - 300000}, False), ({'startedAtMs': BASE - 299999}, True),
                 ({'startedAtMs': BASE}, True), ({'startedAtMs': BASE + 1}, False),
                 ({'startedAtMs': 'bad'}, False), ({'startedAtMs': True}, False),
                 ({'startedAtMs': float('nan')}, False), ({'startedAtMs': float('inf')}, False),
                 ({'startedAtMs': BASE - 600000, 'finishedAtMs': BASE - 1}, True),
                 ({'startedAtMs': BASE - 1, 'finishedAtMs': BASE + 1}, True),
                 ({'startedAtMs': BASE, 'finishedAtMs': BASE - 1}, False),
                 ({'startedAtMs': BASE - 1, 'finishedAtMs': 'bad'}, False)]
        for fields, recent in cases:
            for job in ('loaded', 'absent', 'unknown'):
                with self.subTest(fields=fields, job=job):
                    guard = self.rig()
                    guard.step(BASE, job, 'refused', dict(status='failed', **fields))
                    self.assertEqual(guard.state['cause'], 'deploy_failed' if recent else 'listener_refused')
                    down = next(props for name, props in self.events if name == 'listener.down')
                    self.assertEqual(down['listener'], 'refused')

    def test_tcp_recovery_closes_down_even_when_launchd_unknown(self):
        guard = self.rig()
        guard.step(BASE, 'loaded', 'refused')
        guard.step(BASE + 15000, 'unknown', 'open')
        self.assertNotIn('downSinceMs', guard.state)
        up = next(props for name, props in self.events if name == 'listener.up')
        self.assertEqual(up['downMs'], 15000)
        self.assertEqual(up['listener'], 'open')
        self.assertEqual(up['downListener'], 'refused')

    def test_legacy_unknown_window_does_not_become_retroactively_confirmed(self):
        guard = self.rig(dict(downSinceMs=BASE - 600000, cause='deploy_failed', alerted=True))
        guard.step(BASE, 'loaded', 'refused')
        self.assertEqual(guard.state['downSinceMs'], BASE)
        self.assertEqual(guard.state['downListener'], 'refused')
        self.assertEqual(guard.state['cause'], 'listener_refused')
        self.assertEqual(self.alerts, [])
        self.assertEqual([name for name, _ in self.events], ['listener.up', 'listener.down'])
        self.assertEqual(self.events[0][1]['downListener'], 'unknown')

    def test_refusal_clock_restarts_after_timeout_and_unknown_job_does_not_heal(self):
        guard = self.rig()
        for seconds, listener in ((0, 'refused'), (59, 'unreachable'), (60, 'refused'), (119, 'refused')):
            guard.step(BASE + seconds * 1000, 'loaded', listener)
        self.assertEqual(self.actions, [])
        guard.step(BASE + 120000, 'loaded', 'refused')
        self.assertEqual(self.actions, ['kickstart'])
        guard = self.rig()
        guard.step(BASE, 'unknown', 'refused')
        guard.step(BASE + 180000, 'unknown', 'refused')
        guard.step(BASE + 200000, 'absent', 'open')
        self.assertEqual(self.actions, [])

    def test_marker_input_class(self):
        cases = [(None, False), ({}, False), ({'status': 'running', 'startedAtMs': BASE}, True),
                 ({'status': 'failed', 'startedAtMs': BASE}, False),
                 ({'startedAtMs': BASE}, False), ({'status': 'running', 'startedAtMs': BASE + 1}, False),
                 ({'status': 'running', 'startedAtMs': BASE - 299999}, True),
                 ({'status': 'running', 'startedAtMs': BASE - 300000}, False),
                 ({'status': 'running', 'startedAtMs': 'bad'}, False),
                 ({'status': 'running', 'startedAtMs': True}, False)]
        for marker, blocks in cases:
            with self.subTest(marker=marker):
                self.assertEqual(fresh(marker, BASE), blocks)
                guard = self.rig()
                guard.step(BASE, 'absent', 'refused', marker)
                self.assertEqual(self.actions, [] if blocks else ['bootstrap'])

    def test_alert_once_persists_across_restart_and_recovery_uses_same_prefix(self):
        guard = self.rig()
        for seconds in (0, 119, 120, 135):
            guard.step(BASE + seconds * 1000, 'absent', 'refused', dict(status='running', startedAtMs=BASE))
        self.assertEqual(len(self.alerts), 1)
        state = json.loads(json.dumps(guard.state))
        prior_key = self.alerts[0][1]
        guard = self.rig(state)
        guard.step(BASE + 150000, 'absent', 'refused')
        self.assertEqual(self.alerts, [])
        guard.step(BASE + 165000, 'loaded', 'open')
        guard.step(BASE + 180000, 'loaded', 'open')
        self.assertEqual([name for name, _ in self.events].count('listener.up'), 1)
        self.assertEqual(self.alerts[0][1], prior_key + ':recovered')
        self.assertEqual(self.events[-1][1]['downMs'], 165000)

    def test_alert_delivery_failure_retries_stable_key(self):
        guard = self.rig()
        calls = []
        guard.notify = lambda text, key: calls.append(key) or len(calls) > 1
        for seconds in (0, 120, 135, 150):
            guard.step(BASE + seconds * 1000, 'unknown', 'refused')
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])

    def test_deferred_lock_does_not_consume_retry(self):
        guard = self.rig(succeeds=None)
        guard.step(BASE, 'absent', 'refused')
        self.assertEqual(guard.state['attempts'], 0)
        self.assertNotIn('lastAction', guard.state)

    def test_expired_lock_caps_a_refreshed_running_marker(self):
        for age, repairs in ((299999, False), (300000, True), (300001, True)):
            with self.subTest(age=age):
                guard = self.rig()
                guard.step(BASE, 'absent', 'refused', dict(status='running', startedAtMs=BASE), age)
                self.assertEqual(self.actions, ['bootstrap'] if repairs else [])


class RuntimeTests(unittest.TestCase):
    def test_replacement_acquisition_immediately_before_retirement_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(clock=lambda: BASE)
            runtime.marker = Path(directory) / 'deploy.json'
            runtime.observe = lambda: ('absent', 'refused')
            calls = []
            runtime.command = lambda args: calls.append(args) or 0
            lock = Path(str(runtime.marker) + '.lock')
            lock.mkdir()
            write_json(lock / 'owner.json', dict(pid=os.getpid(), script='old-installer', acquisitionId='old'))
            os.utime(lock / 'owner.json', ns=((BASE - 300000) * 1000000,) * 2)
            write_json(runtime.marker, dict(status='running', startedAtMs=BASE - 300000))
            replacement = dict(pid=os.getpid(), script='new-installer', acquisitionId='new')
            marker = dict(status='running', startedAtMs=BASE, **replacement)
            rename = Path.rename
            def interleave(source, target):
                if source == lock:
                    (lock / 'owner.json').unlink()
                    lock.rmdir()
                    lock.mkdir()
                    write_json(lock / 'owner.json', replacement)
                    write_json(runtime.marker, marker)
                return rename(source, target)
            with patch.object(Path, 'rename', interleave), patch('guard.emit') as event:
                self.assertIsNone(runtime.act('bootstrap'))
            self.assertEqual(calls, [])
            self.assertEqual(read_json(runtime.marker), marker)
            self.assertEqual(read_json(lock / 'owner.json'), replacement)
            event.assert_not_called()

    def test_deploy_lock_and_marker_coordinate_with_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime()
            runtime.marker = Path(directory) / 'deploy.json'
            runtime.observe = lambda: ('absent', 'refused')
            calls = []
            runtime.command = lambda args: calls.append(args) or 0
            write_json(runtime.marker, dict(status='running', startedAtMs=__import__('time').time() * 1000))
            self.assertIsNone(runtime.act('bootstrap'))
            self.assertEqual(calls, [])
            write_json(runtime.marker, dict(status='failed', startedAtMs=BASE))
            with patch('guard.emit'):
                self.assertTrue(runtime.act('bootstrap'))
            self.assertEqual(calls[0][0], 'bootstrap')
            self.assertEqual(read_json(runtime.marker)['script'], '9router-guard')
            runtime.settle('loaded', 'open')
            self.assertFalse(runtime.marker.exists())
            self.assertFalse(Path(str(runtime.marker) + '.lock').exists())

    def test_abandoned_lock_reclaimed_only_after_confirmed_dead_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime()
            runtime.marker = Path(directory) / 'deploy.json'
            lock = Path(str(runtime.marker) + '.lock')
            lock.mkdir()
            write_json(lock / 'owner.json', dict(pid=os.getpid(), script='installer'))
            write_json(runtime.marker, dict(status='failed', startedAtMs=BASE))
            with runtime.slot() as allowed:
                self.assertFalse(allowed)
            with patch('guard.os.kill', side_effect=ProcessLookupError):
                with runtime.slot() as allowed:
                    self.assertTrue(allowed)

    def test_lock_owner_class_is_overridden_after_five_minutes(self):
        owners = [
            ('alive', dict(pid=os.getpid()), None),
            ('reused_pid', dict(pid=424242), None),
            ('permission_denied', dict(pid=424242), PermissionError),
            ('dead', dict(pid=424242), ProcessLookupError),
            ('missing_file', None, None),
            ('missing_pid', {}, None),
            ('string_pid', dict(pid='424242'), None),
            ('bool_pid', dict(pid=True), None),
            ('zero_pid', dict(pid=0), None),
            ('negative_pid', dict(pid=-1), None),
            ('out_of_range_pid', dict(pid=2 ** 100), OverflowError),
        ]
        for name, owner, error in owners:
            for age in (299999, 300000, 300001):
                with self.subTest(owner=name, age=age), tempfile.TemporaryDirectory() as directory:
                    runtime = Runtime(clock=lambda: BASE)
                    runtime.marker = Path(directory) / 'deploy.json'
                    runtime.observe = lambda: ('absent', 'refused')
                    calls = []
                    runtime.command = lambda args: calls.append(args) or 0
                    lock = Path(str(runtime.marker) + '.lock')
                    lock.mkdir()
                    target = lock
                    if owner is not None:
                        target = lock / 'owner.json'
                        write_json(target, owner)
                    os.utime(target, ns=((BASE - age) * 1000000,) * 2)
                    # A later action may refresh this marker; acquisition still caps deferral.
                    write_json(runtime.marker, dict(status='running', startedAtMs=BASE))
                    self.assertEqual(round(runtime.lock_age_ms()), age)
                    with patch('guard.emit') as event, patch('guard.os.kill', side_effect=error):
                        result = runtime.act('bootstrap')
                    if age < 300000:
                        self.assertIsNone(result)
                        self.assertEqual(calls, [])
                        event.assert_not_called()
                    else:
                        self.assertTrue(result)
                        self.assertEqual(calls[0][0], 'bootstrap')
                        first = event.call_args_list[0]
                        self.assertEqual(first.args, ('guard', 'guard.lock_override'))
                        pid = (owner or {}).get('pid')
                        self.assertEqual(first.kwargs['props'], dict(
                            ownerPid=pid if type(pid) is int and pid > 0 else 'unknown', lockAgeMs=age))
                        self.assertFalse(lock.exists())
                        self.assertEqual(read_json(runtime.marker)['script'], '9router-guard')

    def test_owner_file_age_is_not_reset_by_marker_directory_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(clock=lambda: BASE)
            runtime.marker = Path(directory) / 'deploy.json'
            lock = Path(str(runtime.marker) + '.lock')
            lock.mkdir()
            owner = lock / 'owner.json'
            write_json(owner, dict(pid=os.getpid()))
            os.utime(owner, ns=((BASE - 300000) * 1000000,) * 2)
            write_json(lock / 'marker.json', dict(status='running', startedAtMs=BASE))
            self.assertEqual(runtime.lock_age_ms(), 300000)

    def test_settle_does_not_erase_an_installers_marker_or_owned_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime()
            runtime.marker = Path(directory) / 'deploy.json'
            marker = dict(pid=os.getpid(), script='install-launchagent.sh', status='running',
                          startedAtMs=__import__('time').time() * 1000)
            write_json(runtime.marker, marker)
            lock = Path(str(runtime.marker) + '.lock')
            lock.mkdir()
            write_json(lock / 'owner.json', dict(pid=os.getpid(), script='install-launchagent.sh'))
            runtime.settle('loaded', 'open')
            self.assertEqual(read_json(runtime.marker), marker)
            self.assertTrue(lock.exists())

    def test_alert_invokes_local_bridge_without_inspector(self):
        runtime = Runtime()
        with patch.dict(os.environ, BUN_INSPECT='must-not-propagate'), patch('guard.emit'), patch('guard.subprocess.run') as run:
            run.return_value.returncode = 0
            self.assertTrue(runtime.notify('down', '9router-down:fixture'))
            args, options = run.call_args
            self.assertIn('--source', args[0])
            self.assertNotIn('BUN_INSPECT', options['env'])

    def test_transition_metadata_survives_allowlist(self):
        row = clean(dict(name='listener.up', component='guard', kind='event', props=dict(downSince='2026-11-18T02:22:40.000Z', downMs=120000, cause='job_missing')), dt.datetime.now(dt.timezone.utc))
        self.assertEqual(row['props']['downMs'], 120000)
        self.assertIn('downSince', row['props'])
        props = dict(listener='open', downListener='refused', unknownSince='2026-11-18T02:22:40.000Z', unknownMs=120000)
        row = clean(dict(name='listener.state_resolved', component='guard', kind='event', props=props), dt.datetime.now(dt.timezone.utc))
        self.assertEqual(row['props'], props)
        for pid in (424242, 'unknown'):
            row = clean(dict(name='guard.lock_override', component='guard', kind='event',
                             props=dict(ownerPid=pid, lockAgeMs=300000)), dt.datetime.now(dt.timezone.utc))
            self.assertEqual(row['props'], dict(ownerPid=pid, lockAgeMs=300000))

    def test_real_tcp_process_sigterm_down_alert_and_heal(self):
        # A Linux launchd-like harness owns a real listener; every PID is captured here.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reservation = socket.socket()
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
            reservation.close()
            script = ('import socket,pathlib,sys\n'
                      's=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)\n'
                      's.bind(("127.0.0.1",int(sys.argv[1])));s.listen()\n'
                      'print("ready",flush=True)\n'
                      'while True:\n c,a=s.accept();c.close()\n')
            child = None
            def start():
                nonlocal child
                if child is not None:
                    child.stdout.close()
                child = subprocess.Popen([sys.executable, '-I', '-c', script, str(port)], stdout=subprocess.PIPE)
                import select
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(child.stdout.readline(), b'ready\n')
            def observe():
                loaded = child is not None and child.poll() is None
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.5):
                        listener = 'open'
                except ConnectionRefusedError:
                    listener = 'refused'
                return ('loaded' if loaded else 'absent'), listener
            runtime = Runtime()
            runtime.marker = root / 'deploy.json'
            runtime.observe = observe
            attempts = []
            def command(args):
                attempts.append(args[0])
                if len(attempts) < 5:
                    return 5
                start()
                return 0
            runtime.command = command
            events, alerts = [], []
            guard = Guard(event=lambda name, **props: events.append(dict(name=name, props=props)), action=runtime.act,
                          notify=lambda text, key: alerts.append(key) or True)
            try:
                start()
                guard.step(BASE, *observe())
                child.send_signal(signal.SIGTERM)
                child.wait(timeout=5)
                with patch('guard.emit'):
                    for seconds in (0, 15, 45, 105, 120, 225):
                        guard.step(BASE + seconds * 1000, *observe(), read_json(runtime.marker))
                    guard.step(BASE + 240000, *observe())
                self.assertEqual(attempts, ['bootstrap'] * 5)
                self.assertEqual([row['name'] for row in events].count('listener.down'), 1)
                self.assertEqual([row['name'] for row in events].count('listener.up'), 1)
                self.assertEqual(len(alerts), 2)  # One outage alert plus one recovery.
                self.assertTrue(alerts[1].startswith(alerts[0] + ':'))
                print('GUARD_SIMULATION ' + json.dumps(dict(events=events, alerts=alerts, attempts=attempts)))
            finally:
                if child is not None and child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)
                if child is not None:
                    child.stdout.close()


if __name__ == '__main__':
    unittest.main()
