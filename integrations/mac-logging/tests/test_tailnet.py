import fcntl
import datetime as dt
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
        self.second_code = 0
        self.probe_failure = None
        self.https_code, self.https_status, self.https_failure = 7, '000', None
        self.ips = ['100.1.1.1', 'fd00::1']
        self.raw = None

    def run_command(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[0] == tailnet.APP_CLI:
            self.assertEqual(argv, [tailnet.APP_CLI, 'status', '--json'])
            self.assertEqual(kw['timeout'], tailnet.STATUS_TIMEOUT)
            self.assertEqual(kw['timeout'], 15)
            if self.status_failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, tailnet.STATUS_TIMEOUT)
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
            self.assertEqual(argv[1:4], ['-z', '-G', '5'])
            self.assertEqual(kw['timeout'], tailnet.PROBE_TIMEOUT)
            if self.probe_failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, kw['timeout'])
            if self.probe_failure == 'unavailable':
                raise FileNotFoundError()
            return subprocess.CompletedProcess(argv, self.home_code if argv[4] == tailnet.PROBE_HOST else self.second_code, '')
        if argv[0] == '/usr/bin/curl':
            self.assertEqual(argv, ['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                                    '--max-time', '8', tailnet.SELF_HTTPS_URL])
            self.assertEqual(kw['timeout'], 9)
            if self.https_failure == 'timeout':
                raise subprocess.TimeoutExpired(argv, kw['timeout'])
            if self.https_failure == 'unavailable':
                raise FileNotFoundError()
            return subprocess.CompletedProcess(argv, self.https_code, self.https_status)
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
        self.tick(); self.tick(); self.tick()
        self.assertEqual(self.sent, [])
        self.tick()
        first = self.sent[0]
        self.assertIn('Stopped since 15:01 Dubai', first[1])
        for _ in range(7):
            self.tick()
        self.assertEqual(self.sent, [first])
        self.state = 'Running'
        self.tick(); self.tick()
        self.assertEqual(self.sent[1][1], 'Mac Tailscale back up after 11 min')
        self.assertEqual(len(self.sent), 2)
        self.state = 'Stopped'
        for _ in range(4):
            self.tick()
        self.assertEqual(len(self.sent), 3)
        self.assertNotEqual(self.sent[0][0], self.sent[2][0])

    def test_short_outage_resets_streak_and_has_no_recovery_notice(self):
        for state in ('Stopped', 'Stopped', 'Running', 'Stopped', 'Stopped', 'Running'):
            self.state = state
            self.tick()
        self.assertEqual(self.sent, [])

    def test_all_explicit_down_states(self):
        for state, online in [
            ('Stopped', True), ('NeedsLogin', False), ('NeedsMachineAuth', False),
            ('Starting', True), ('NoState', None), ('Running', False)]:
            with self.subTest(state=state, online=online):
                jobs.save_state('tailnet', {})
                self.sent.clear()
                self.state, self.online = state, online
                self.tick(); self.tick()
                self.assertEqual(self.sent, [])
                self.now += 60
                props = self.tick()
                self.assertEqual(props['outcome'], 'down')
                self.assertTrue(props['confirmedDown'])
                self.assertEqual(len(self.sent), 1)
                self.assertIn('Running (offline)' if state == 'Running' else state, self.sent[0][1])

    def test_cli_failures_with_reachable_peers_are_up(self):
        for failure in ('timeout', 'exit', 'unavailable'):
            with self.subTest(failure=failure):
                jobs.save_state('tailnet', {})
                self.status_failure = failure
                for _ in range(10):
                    props = self.tick()
                self.assertEqual(props['cliOutcome'], 'unknown')
                self.assertEqual(props['outcome'], 'up')
                self.assertEqual(props['confirmedBy'], 'home_tcp')
                self.assertEqual(props['statusError'], failure)
                self.assertFalse(props['confirmedDown'])
                self.assertEqual(props['notUpChecks'], 0)
                self.assertEqual(self.sent, [])

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
                    '{"BackendState":"Running"}',
                    '{"BackendState":"Running","Self":{"Online":null}}',
                    '{"BackendState":"Running","Self":{"Online":"true"},"TailscaleIPs":[]}',
                    '{"BackendState":"new-state","Self":null,"TailscaleIPs":[]}',
                    '{"BackendState":"Running","Self":{"Online":true},"TailscaleIPs":42}'):
            with self.subTest(raw=raw):
                jobs.save_state('tailnet', {})
                self.raw = raw
                props = self.tick()
                self.assertTrue(props['up'])
                self.assertEqual(props['cliOutcome'], 'unknown')
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
        self.assertIn(['/usr/bin/nc', '-z', '-G', '5', '100.2.2.2', '22'], [a for a, _ in self.calls])

    def test_changing_outage_state_keeps_one_streak_and_frozen_retry(self):
        self.notify_failure = 'timeout'
        for state in ('Stopped', 'Starting', 'NeedsLogin', 'Stopped', 'Stopped'):
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
        for _ in range(4): self.tick()
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

    def test_timeout_confirmed_down_requires_both_thresholds(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        start = self.now
        for at in (start, start+1, start+60, start+179, start+299):
            self.now = at
            props = self.tick()
            self.assertEqual(props['cliOutcome'], 'unknown')
            self.assertEqual(props['outcome'], 'down')
            self.assertTrue(props['confirmedDown'])
            self.assertEqual(self.sent, [])
        self.now = start+300
        self.tick(); self.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertIn('Mac Tailscale is unreachable (status CLI timing out) since', self.sent[0][1])
        self.assertNotIn('Unknown', self.sent[0][1])
        self.assertTrue(self.sent[0][0].startswith('mac-tailnet:unreachable:'))

    def test_wall_clock_does_not_replace_check_count(self):
        self.state = 'Stopped'
        self.tick()
        self.now += 600
        self.tick()
        self.assertEqual(self.sent, [])
        self.tick()
        self.assertEqual(len(self.sent), 1)

    def test_unknown_uses_five_checks_and_five_minutes(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        start = self.now
        for offset in (0, 45, 90, 135, 180):
            self.now = start+offset
            self.tick()
            self.assertEqual(self.sent, [])
        self.now = start+300
        self.tick()
        self.assertEqual(len(self.sent), 1)

    def test_samples_include_load_and_status_duration(self):
        with patch.object(tailnet.os, 'getloadavg', return_value=(195.25, 90, 45)):
            self.tick()
        props = self.rows('tailnet.sample')[0]['props']
        self.assertEqual(props['loadAvg1'], 195.25)
        self.assertGreaterEqual(props['statusDurationMs'], 0)
        self.assertEqual(props['statusDurationMs'], props['cliMs'])
        self.assertIsNone(props['confirmedBy'])

    def test_self_https_success_prevents_alert_and_preserves_cli_error(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        self.https_code, self.https_status = 0, '503'
        for _ in range(10):
            props = self.tick()
            self.assertTrue(props['up'])
            self.assertEqual(props['confirmedBy'], 'self_https')
            self.assertEqual(props['statusError'], 'timeout')
            self.assertEqual(props['notUpChecks'], 0)
        sample = self.rows('tailnet.sample')[-1]['props']
        self.assertEqual(sample['confirmedBy'], 'self_https')
        self.assertTrue(sample['selfHttpsReachable'])
        self.assertEqual(self.sent, [])

    def test_https_response_matrix(self):
        cases = [(0, str(code), True) for code in (100, 200, 204, 301, 401, 404, 503, 599)]
        cases += [(28, '200', True), (7, '000', False)]
        cases += [(0, value, False) for value in ('', '000', '99', '600', 'garbage', '200junk')]
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        for code, status, reachable in cases:
            with self.subTest(code=code, status=status):
                self.https_code, self.https_status = code, status
                props = self.tick()
                self.assertEqual(props['up'], reachable)
                self.assertEqual(props['selfHttpsReachable'], reachable)
                self.assertEqual(props['confirmedBy'], 'self_https' if reachable else None)

    def test_unknown_requires_check_count_even_after_five_minutes(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        start = self.now
        for offset in (0, 300, 360, 420):
            self.now = start+offset
            self.tick()
        self.assertEqual(self.sent, [])
        self.tick()
        self.assertEqual(len(self.sent), 1)
        for _ in range(5):
            self.tick()
        self.assertEqual(len(self.sent), 1)
        self.state, self.status_failure = 'Running', None
        self.tick(); self.tick()
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(len(self.rows('tailnet.alert')), 1)
        self.assertEqual(len(self.rows('tailnet.recovery')), 1)

    def test_probe_confirmed_tick_resets_unknown_streak(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        self.tick(); self.tick()
        self.home_code = 0
        props = self.tick()
        self.assertEqual(props['notUpChecks'], 0)
        self.assertIsNone(props['outageStart'])
        self.home_code = 1
        props = self.tick()
        self.assertEqual(props['notUpChecks'], 1)
        self.assertEqual(self.sent, [])

    def test_stopped_bunched_ticks_need_three_elapsed_minutes(self):
        self.state = 'Stopped'
        start = self.now
        for offset in (0, 60, 120):
            self.now = start+offset
            self.tick()
        self.assertEqual(self.sent, [])
        self.now = start+180
        self.tick()
        self.assertEqual(len(self.sent), 1)

    def test_all_four_thresholds_are_overridable(self):
        for failure in (None, 'timeout'):
            with self.subTest(failure=failure):
                jobs.save_state('tailnet', {})
                self.sent.clear()
                self.state, self.status_failure = 'Stopped', failure
                self.home_code = self.second_code = 1
                start = self.now
                opts = dict(threshold=2, threshold_seconds=30,
                            unknown_threshold=2, unknown_threshold_seconds=45)
                self.tick(**opts)
                self.now = start+29
                self.tick(**opts)
                self.assertEqual(self.sent, [])
                self.now = start+(45 if failure else 30)
                self.tick(**opts)
                self.assertEqual(len(self.sent), 1)

    def test_probe_source_changes_do_not_spam_state_events(self):
        self.status_failure = 'timeout'
        self.tick(); self.tick()
        self.home_code = 1
        props = self.tick()
        self.assertEqual(props['confirmedBy'], 'peer_tcp')
        self.second_code = 1
        self.https_code, self.https_status = 0, '200'
        self.tick(); self.tick()
        self.assertEqual(len(self.rows('tailnet.state')), 1)
        self.status_failure = None
        self.tick(); self.tick()
        self.assertEqual(len(self.rows('tailnet.state')), 2)
        self.status_failure = 'timeout'
        self.tick(); self.tick()
        self.assertEqual(len(self.rows('tailnet.state')), 3)

    def test_https_tool_failure_is_not_a_confirmed_outage(self):
        self.status_failure = 'timeout'
        self.home_code = self.second_code = 1
        self.https_failure = 'unavailable'
        for _ in range(10):
            props = self.tick()
        self.assertEqual(props['outcome'], 'unknown')
        self.assertEqual(props['notUpChecks'], 0)
        self.assertEqual(self.sent, [])

    def test_second_peer_success_is_enough_and_resets_streak(self):
        self.home_code = 1
        self.status_failure = 'timeout'
        for state, failure in [('Running', 'timeout'), ('Stopped', None),
                               ('Stopped', None), ('Running', 'timeout')]:
            self.state, self.status_failure = state, failure
            props = self.tick()
        self.assertEqual(props['outcome'], 'up')
        self.assertEqual(props['notUpChecks'], 0)
        self.assertFalse(props['confirmProbes'][tailnet.PROBE_HOST]['ok'])
        self.assertTrue(props['confirmProbes'][tailnet.CONFIRM_PROBES[1][0]]['ok'])
        self.assertEqual(self.sent, [])

    def test_cli_slow_rate_limit_survives_invocations(self):
        self.status_failure = 'timeout'
        start = self.now
        for _ in range(10):
            self.tick()
        rows = self.rows('tailnet.cli_slow')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['props']['suppressed'], 0)
        self.now = start+899
        self.tick()
        self.assertEqual(len(self.rows('tailnet.cli_slow')), 1)
        self.now = start+900
        self.tick()
        rows = self.rows('tailnet.cli_slow')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1]['props']['suppressed'], 10)
        self.assertEqual(self.sent, [])

    def test_missing_probe_tool_is_unknown_and_cannot_claim_recovery(self):
        self.state = 'Stopped'
        for _ in range(4): self.tick()
        self.assertEqual(len(self.sent), 1)
        self.status_failure = 'timeout'
        self.probe_failure = 'unavailable'
        for _ in range(10):
            props = self.tick()
        self.assertEqual(props['outcome'], 'unknown')
        self.assertFalse(props['confirmedDown'])
        self.assertEqual(props['notUpChecks'], 0)
        self.assertEqual(len(self.sent), 1)
        self.status_failure = self.probe_failure = None
        self.state = 'Running'
        self.tick()
        self.assertEqual(len(self.sent), 2)
        self.assertIn('back up', self.sent[1][1])

    def test_unavailable_probes_break_unalerted_streak(self):
        self.state = 'Stopped'
        self.tick(); self.tick()
        self.status_failure = 'timeout'
        self.probe_failure = 'unavailable'
        self.tick()
        self.status_failure = self.probe_failure = None
        props = self.tick()
        self.assertEqual(props['notUpChecks'], 1)
        self.assertEqual(self.sent, [])

    def test_timeout_probes_are_confirmed_failures(self):
        self.status_failure = self.probe_failure = 'timeout'
        self.https_failure = 'timeout'
        for _ in range(6): props = self.tick()
        self.assertTrue(props['confirmedDown'])
        self.assertTrue(all(p['error'] == 'timeout' for p in props['confirmProbes'].values()))
        self.assertEqual(len(self.sent), 1)

    def test_legacy_timeout_streak_and_queued_false_alert_are_dropped(self):
        jobs.save_state('tailnet', dict(outage=dict(start=self.now-600, checks=9, alertQueued=True,
                       key='mac-tailnet:timeout:1'), pending=[dict(kind='alert', key='old', text='timeout')]))
        self.state = 'Stopped'
        props = self.tick()
        self.assertEqual(props['notUpChecks'], 1)
        self.assertEqual(props['outageStart'], self.now-60)
        self.assertEqual(self.sent, [])

    def test_legacy_explicit_alert_retains_dedupe_and_recovery(self):
        key = 'mac-tailnet:Stopped:1'
        jobs.save_state('tailnet', dict(outage=dict(start=self.now-600, checks=9, alertQueued=True,
                       key=key), pending=[]))
        self.state = 'Stopped'
        self.tick()
        self.assertEqual(self.sent, [])
        self.state = 'Running'
        self.tick()
        self.assertEqual(self.sent[0][0], key+':recovery')

    def test_legacy_message_migration_matrix_independent_of_current_outage(self):
        # Each row is exercised for alert/recovery and absent/explicit/unknown
        # current outages: the queue can contain messages from older outages.
        cases = [
            ('Stopped', True),
            ('NeedsLogin', True),
            ('NeedsMachineAuth', True),
            ('NoState', True),
            ('Starting', True),
            ('Running (offline)', True),
            ('timeout', False),
            ('exit', False),
            ('parse', False),
            ('unavailable', False),
            ('Unknown', False),
        ]
        self.state, self.notify_failure = 'Stopped', 'exit'
        for label, keep in cases:
            for kind in ('alert', 'recovery'):
                for current in (None, 'Stopped', 'timeout'):
                    with self.subTest(label=label, kind=kind, current=current):
                        key = 'mac-tailnet:%s:1' % label
                        message = dict(kind=kind, key=key+(':recovery' if kind == 'recovery' else ''),
                                       text='Frozen '+label+' '+kind)
                        outage = (dict(start=self.now-600, checks=9, alertQueued=True,
                                       key='mac-tailnet:%s:2' % current) if current else None)
                        jobs.save_state('tailnet', dict(outage=outage, pending=[message]))
                        self.sent.clear()
                        self.tick()
                        self.assertEqual(jobs.read_state('tailnet')['pending'], [message] if keep else [])
                        self.assertEqual(self.sent, [(message['key'], message['text'])] if keep else [])

    def test_probe_logging_schema_and_metrics(self):
        self.status_failure = 'timeout'
        self.tick()
        props = self.rows('tailnet.sample')[0]['props']
        self.assertEqual(props['outcome'], 'up')
        self.assertFalse(props['confirmedDown'])
        self.assertGreaterEqual(props['cliMs'], 0)
        self.assertEqual(set(props['confirmProbes']), {p[0] for p in tailnet.CONFIRM_PROBES})
        for result in props['confirmProbes'].values():
            self.assertEqual(set(result), {'port', 'ok', 'error', 'ms'})
            self.assertGreaterEqual(result['ms'], 0)
        clean = toollog.safe_fields(dict(confirmProbes={
            '100.64.1.71': dict(port=53, ok=True, error=None, ms=1, text='secret'),
            'private': dict(text='secret')}), 'tailnet.sample')
        self.assertEqual(clean, dict(confirmProbes={'100.64.1.71': dict(port=53, ok=True, error=None, ms=1)}))

    def test_subprocess_budget_and_read_only_commands(self):
        self.status_failure = self.pid_failure = self.probe_failure = 'timeout'
        self.https_failure = 'timeout'
        for _ in range(6):
            self.calls.clear()
            self.tick()
            self.assertLessEqual(sum(kw['timeout'] for _, kw in self.calls), 49)
        self.assertEqual([a for a, _ in self.calls if a[0] == tailnet.APP_CLI],
                         [[tailnet.APP_CLI, 'status', '--json']])
        self.assertEqual([a[4:] for a, _ in self.calls if a[0] == '/usr/bin/nc'],
                         [[host, str(port)] for host, port in tailnet.CONFIRM_PROBES])

    def test_november_16_replay_has_zero_alerts(self):
        fixture = json.loads((HERE/'tests/fixtures/tailnet-2026-11-16.json').read_text())
        rows = fixture['samples']
        self.assertEqual(len(rows), 532)
        self.assertEqual(sum(r['statusError'] == 'timeout' for r in rows), 125)
        for row in rows:
            self.now = dt.datetime.fromisoformat(row['ts'].replace('Z', '+00:00')).timestamp()
            self.state, self.online = row['backendState'], row['selfOnline']
            self.status_failure = row['statusError']
            props = self.tick()
            self.assertEqual(props['outcome'], 'down' if row['selfOnline'] is False else 'up')
            if props['up']:
                self.assertEqual(props['notUpChecks'], 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.rows('tailnet.alert'), [])
        self.assertEqual(len(self.rows('tailnet.sample')), len(rows))
        self.assertGreater(len(self.rows('tailnet.cli_slow')), 0)

    def test_plist_and_installer_expose_minute_collector_path(self):
        plist = plistlib.loads((HERE/'launchd/com.abdullah.mac-tailnet.plist').read_bytes())
        self.assertEqual(plist['StartInterval'], 60)
        self.assertIn('collector.py" --tailnet', plist['ProgramArguments'][2])
        self.assertEqual(plist['ProgramArguments'][0], '/bin/zsh')
        self.assertIn('tailnet.py', (HERE/'install.zsh').read_text())


if __name__ == '__main__':
    unittest.main()
