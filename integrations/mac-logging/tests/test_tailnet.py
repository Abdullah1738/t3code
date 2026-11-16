import fcntl
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import jobs
import tailnet
import toollog


class TailnetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), BUN_INSPECT='1')
        env.start()
        self.addCleanup(env.stop)
        self.now = 1794740400
        self.sent, self.calls = [], []
        self.state, self.online, self.pid = 'Running', True, '123\n'
        self.status_failure = self.notify_failure = self.pid_failure = None
        self.home_code = 0
        self.ips = ['100.1.1.1', 'fd00::1']
        self.raw = None

    def run_command(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[0] == tailnet.APP_CLI:
            self.assertEqual(argv, [tailnet.APP_CLI, 'status', '--json'])
            self.assertEqual(kw['timeout'], 5)
            if self.status_failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, 5)
            if self.status_failure == 'unavailable':
                raise FileNotFoundError('sensitive raw output')
            data = dict(BackendState=self.state, Self=dict(Online=self.online), TailscaleIPs=self.ips,
                        Peer={'secret': 'never logged'}, User={'name': 'private'})
            return subprocess.CompletedProcess(argv, 2 if self.status_failure == 'exit' else 0,
                                               self.raw if self.raw is not None else json.dumps(data), 'private stderr')
        if argv[0] == '/usr/bin/pgrep':
            self.assertEqual(argv, ['/usr/bin/pgrep', '-x', tailnet.EXTENSION])
            if self.pid_failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, 3)
            return subprocess.CompletedProcess(argv, 0 if self.pid else 1, self.pid)
        if argv[0] == '/usr/bin/nc':
            self.assertEqual(argv[1:4], ['-z', '-G', '3'])
            return subprocess.CompletedProcess(argv, self.home_code, '')
        self.assertEqual(argv[2], 'notify')
        self.assertNotIn('BUN_INSPECT', kw['env'])
        self.sent.append((argv[argv.index('--key')+1], argv[argv.index('--text')+1]))
        if self.notify_failure == 'timeout':
            raise subprocess.TimeoutExpired(argv, 10)
        return subprocess.CompletedProcess(argv, 1 if self.notify_failure else 0, '')

    def tick(self, **kw):
        props = tailnet.check(self.run_command, now=self.now, **kw)
        self.now += 60
        self.assertIsNotNone(props)
        return props

    def rows(self, name=None):
        rows = [json.loads(line) for path in self.root.glob('*.ndjson') for line in path.read_text().splitlines()]
        return [row for row in rows if name is None or row['name'] == name]

    def test_running_and_home_down_never_alert(self):
        for home in (0, 1):
            self.home_code = home
            for _ in range(4):
                props = self.tick()
            self.assertTrue(props['up'])
            self.assertEqual(props['homeReachable'], home == 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(len(self.rows('tailnet.state')), 1)
        self.assertEqual(len(self.rows('tailnet.sample')), 8)

    def test_stopped_threshold_dedupe_recovery_and_next_outage(self):
        self.tick()
        self.state = 'Stopped'
        self.tick(); self.tick()
        self.assertEqual(self.sent, [])
        self.tick()
        first = self.sent[0]
        self.assertIn('Stopped since 15:01 Dubai', first[1])
        for _ in range(7):
            self.tick()
        self.assertEqual(self.sent, [first])
        self.state = 'Running'
        self.tick(); self.tick()
        self.assertEqual(self.sent[1][1], 'Mac Tailscale back up after 10 min')
        self.assertEqual(len(self.sent), 2)
        self.state = 'Stopped'
        for _ in range(3):
            self.tick()
        self.assertEqual(len(self.sent), 3)
        self.assertNotEqual(self.sent[0][0], self.sent[2][0])

    def test_short_outage_resets_streak_and_has_no_recovery_notice(self):
        for state in ('Stopped', 'Stopped', 'Running', 'Stopped', 'Stopped', 'Running'):
            self.state = state
            self.tick()
        self.assertEqual(self.sent, [])

    def test_all_not_up_states_and_cli_failures(self):
        for state, online, failure in [
            ('Stopped', True, None), ('NeedsLogin', False, None),
            ('NeedsMachineAuth', False, None), ('Starting', True, None), ('NoState', None, None),
            ('Running', False, None), ('Running', None, None),
            ('Running', True, 'timeout'), ('Running', True, 'exit'), ('Running', True, 'unavailable')]:
            with self.subTest(state=state, online=online, failure=failure):
                jobs.save_state('tailnet', {})
                self.sent.clear()
                self.state, self.online, self.status_failure = state, online, failure
                for _ in range(3):
                    props = self.tick()
                self.assertFalse(props['up'])
                self.assertEqual(len(self.sent), 1)
                self.assertEqual(props['timedOut'], failure == 'timeout')

    def test_logged_out_status_can_omit_self_and_ips(self):
        for data in (dict(BackendState='NeedsLogin'), dict(BackendState='NeedsLogin', Self=None, TailscaleIPs=None)):
            with self.subTest(data=data):
                self.raw = json.dumps(data)
                props = self.tick()
                self.assertEqual(props['backendState'], 'NeedsLogin')
                self.assertEqual(props['tailscaleIPsCount'], 0)
                self.assertIsNone(props['statusError'])
                self.assertFalse(props['up'])

    def test_custom_threshold_and_probe_timeout(self):
        self.state = 'Stopped'
        for _ in range(3): self.tick(threshold=4)
        self.assertEqual(self.sent, [])
        self.tick(threshold=4)
        self.assertEqual(len(self.sent), 1)
        self.state = 'Running'
        original = self.run_command
        def run(argv, **kw):
            if argv[0] == '/usr/bin/nc':
                raise subprocess.TimeoutExpired(argv, kw['timeout'])
            return original(argv, **kw)
        props = tailnet.check(run, now=self.now)
        self.assertTrue(props['up'])
        self.assertFalse(props['homeReachable'])
        self.assertEqual(props['homeProbeError'], 'timeout')

    def test_status_shape_matrix(self):
        for raw in ('garbage', '[]', 'null', '{}', '{"BackendState":[]}',
                    '{"BackendState":"Running","Self":{"Online":"true"},"TailscaleIPs":[]}',
                    '{"BackendState":"new-state","Self":null,"TailscaleIPs":[]}',
                    '{"BackendState":"Running","Self":{"Online":true},"TailscaleIPs":42}'):
            with self.subTest(raw=raw):
                jobs.save_state('tailnet', {})
                self.raw = raw
                props = self.tick()
                self.assertFalse(props['up'])
                self.assertEqual(props['statusError'], 'parse')

    def test_pid_change_and_failure_are_evidence_only(self):
        self.tick()
        self.pid = '125\n124\n'
        self.tick()
        self.pid = '124\n125\n'
        self.tick()
        self.pid = ''
        self.tick()
        self.pid_failure = 'timeout'
        self.tick()
        self.assertEqual(len(self.rows('tailnet.extension')), 3)
        self.assertEqual(len(self.rows('tailnet.state')), 1)
        self.assertEqual(self.sent, [])

    def test_probe_only_running_and_host_config(self):
        self.state = 'Stopped'
        self.tick()
        self.assertFalse(any(argv[0] == '/usr/bin/nc' for argv, _ in self.calls))
        self.state, self.online = 'Running', False
        self.tick(probe_host='100.2.2.2', threshold=5)
        self.assertIn(['/usr/bin/nc', '-z', '-G', '3', '100.2.2.2', '22'], [a for a, _ in self.calls])

    def test_changing_outage_state_keeps_one_streak_and_frozen_retry(self):
        self.notify_failure = 'timeout'
        for state in ('Stopped', 'Starting', 'NeedsLogin', 'Stopped'):
            self.state = state
            self.tick()
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[0], self.sent[1])
        self.notify_failure = None
        self.tick()
        self.assertEqual(self.sent[0], self.sent[2])
        self.tick()
        self.assertEqual(len(self.sent), 3)

    def test_recovery_retry_is_frozen_and_not_duplicated(self):
        self.state = 'Stopped'
        for _ in range(3): self.tick()
        self.state = 'Running'
        self.notify_failure = 'exit'
        self.tick(); self.tick()
        self.assertEqual(self.sent[1], self.sent[2])
        self.notify_failure = None
        self.tick(); self.tick()
        self.assertEqual(self.sent[1], self.sent[3])
        self.assertEqual(len(self.sent), 4)

    def test_log_schema_retains_metrics_and_omits_raw_status(self):
        self.tick()
        row = self.rows('tailnet.sample')[0]
        self.assertEqual(row['props']['backendState'], 'Running')
        self.assertEqual(row['props']['selfOnline'], True)
        self.assertEqual(row['props']['tailscaleIPsCount'], 2)
        self.assertEqual(row['props']['extensionPid'], 123)
        self.assertIsNone(row['props']['outageStart'])
        self.assertEqual(row['tool'], 'mac')
        self.assertLess(len(json.dumps(row)), 2000)
        self.assertNotIn('private', str(self.rows()))
        self.assertNotIn('100.1.1.1', str(self.rows()))
        self.assertEqual(toollog.safe_fields({'text': 'private', 'Self': {'Online': True}}, 'tailnet.sample'), {})

    def test_lock_contention_and_state_failure_never_send(self):
        path = jobs.state_path('tailnet').with_suffix('.lock')
        with path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIsNone(tailnet.check(self.run_command))
        with patch.object(tailnet, 'save_state', side_effect=OSError):
            self.assertIsNone(tailnet.check(self.run_command))
        self.assertEqual(self.sent, [])

    def test_plist_and_installer_expose_minute_collector_path(self):
        plist = plistlib.loads((HERE/'launchd/com.abdullah.mac-tailnet.plist').read_bytes())
        self.assertEqual(plist['StartInterval'], 60)
        self.assertIn('collector.py" --tailnet', plist['ProgramArguments'][2])
        self.assertEqual(plist['ProgramArguments'][0], '/bin/zsh')
        self.assertIn('tailnet.py', (HERE/'install.zsh').read_text())


if __name__ == '__main__':
    unittest.main()
