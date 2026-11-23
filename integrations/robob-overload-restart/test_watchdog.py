import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace


SOURCE = Path(__file__).parent


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        spec = importlib.util.spec_from_file_location('watchdog', SOURCE / 'robob-overload-restart.py')
        self.m = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {
            'HOME': str(self.root), 'ROBOB_OVERLOAD_STATE': str(self.state),
            'ROBOB_OVERLOAD_HOME': str(self.root), 'ROBOB_OVERLOAD_PROBE_TIMEOUT': '0.25',
            'ROBOB_OVERLOAD_NOTIFY_DELAY': '0.01', 'ROBOB_OVERLOAD_DEADLINE': '1.5',
        }, clear=True):
            spec.loader.exec_module(self.m)
        m = self.m
        m.time = SimpleNamespace(time=lambda: 1795132800.0, monotonic=time.monotonic, sleep=time.sleep,
                                 mktime=time.mktime, strptime=time.strptime)
        m.PROBE_SLOW = 0.2
        self.userdata = self.root / 'disk/userdata'
        self.userdata.mkdir(parents=True)
        self.link = self.root / 'userdata'
        self.link.symlink_to(self.userdata, target_is_directory=True)
        m.USERDATA = str(self.link)
        m.SSD_PROBE = str(self.userdata / 'runtime.json')
        Path(m.SSD_PROBE).write_text('{}')
        m.EXECUTABLE = str(self.root / 'app')
        Path(m.EXECUTABLE).write_text('binary')
        m.MAC_SSD_MARKER = self.root / 'marker'
        m.HOLD = self.root / 'hold.json'
        m.HOLD_CLI = str(self.root / 'hold-cli')
        m.BUN = sys.executable
        m.TELEGRAM = str(self.root / 'notify.py')
        fake = '''import json, os, sys
from pathlib import Path
root = Path(os.environ['HOME'])
if 'notify' in sys.argv:
    p = root / 'attempts.json'
    rows = json.loads(p.read_text()) if p.exists() else []
    rows.append(sys.argv[1:])
    p.write_text(json.dumps(rows))
    if len(rows) <= int(os.environ.get('ROBOB_OVERLOAD_FAIL_SENDS', '0')):
        print('fake unavailable', file=sys.stderr)
        sys.exit(7)
    with (root / 'accepted.ndjson').open('a') as f:
        f.write(json.dumps(sys.argv[1:]) + '\\n')
else:
    p = root / 'hold.json'
    if sys.argv[1] == 'start':
        p.write_text(json.dumps({'by': 'overload-restart', 'pid': int(sys.argv[-1]), 'beatAt': 0}))
    else:
        p.unlink(missing_ok=True)
    with (root / 'holds.ndjson').open('a') as f:
        f.write(json.dumps(sys.argv[1:]) + '\\n')
'''
        Path(m.HOLD_CLI).write_text('#!' + sys.executable + '\n' + fake)
        Path(m.HOLD_CLI).chmod(0o700)
        Path(m.TELEGRAM).write_text(fake)
        m.processes = lambda timeout=20: {999999: (1, 'captured-start', m.EXECUTABLE)}
        self.addCleanup(patch.stopall)
        patch.object(m.os, 'getloadavg', return_value=(0, 0, 0)).start()
        patch.object(m.os, 'cpu_count', return_value=8).start()
        self.tmux_session = m.tmux_session
        m.tmux_session = lambda socket, name, details=None: False
        m.building = lambda: []
        self.opened = self.root / 'opened'
        self.quit = self.root / 'quit'
        m.server_started = lambda: (202, m.time.time()) if self.opened.exists() else (101, m.time.time() - 8000)
        m.survivors = lambda owned: {}
        m.port_listening = lambda: self.opened.exists()
        m.deep_health = lambda: ('healthy', 'healthy', {'roundTrip': {'status': 'ok'}})
        real_run = m.run

        def fake_run(args, timeout, **kw):
            if args[0] == m.TMUX:
                return subprocess.CompletedProcess(args, 1, '', 'no server running')
            if args[0] == '/usr/bin/osascript':
                self.quit.write_text('quit')
                return subprocess.CompletedProcess(args, 0, '', '')
            if args[:2] == ['/bin/zsh', '-f']:
                self.opened.touch()
                return subprocess.CompletedProcess(args, 0, '', '')
            if args[0] in (m.HOLD_CLI, m.BUN):
                return real_run(args, timeout, **kw)
            raise AssertionError('unexpected real command: ' + repr(args))

        m.run = fake_run
        self.quiet = contextlib.redirect_stdout(io.StringIO())
        self.quiet.__enter__()
        self.addCleanup(self.quiet.__exit__, None, None, None)

    def rows(self):
        return [json.loads(s) for s in self.m.LOG.read_text().splitlines()] if self.m.LOG.exists() else []

    def accepted(self):
        p = self.root / 'accepted.ndjson'
        return [json.loads(s) for s in p.read_text().splitlines()] if p.exists() else []

    def assert_result(self, event, reason=None):
        rows = [r for r in self.rows() if r['event'] in ('restart.done', 'restart.failed')]
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]['event'], event)
        if reason:
            self.assertEqual(rows[0]['reason'], reason)
        sent = self.accepted()
        self.assertEqual(len(sent), 1, sent)
        self.assertEqual(sent[0][sent[0].index('--key') + 1], 'robob-overload-restart:cycle:result')
        self.assertFalse(self.m.HOLD.exists())
        return rows[0], sent[0]

    def fifo(self, path):
        path.unlink(missing_ok=True)
        os.mkfifo(path)

    def health_report(self, stalls1s=0, stalls5s=0, worst=0, connection='ok'):
        summary = f'stalled: {stalls1s} stalls >=1s in 10 min ({stalls5s} >=5s); round trip timeout; rss 2.09 GB'
        return {'verdict': 'stalled', 'summary': summary,
                'connection': {'status': connection, 'ms': 615},
                'roundTrip': {'status': 'timeout', 'ms': 8008},
                'lag': {'status': 'complete', 'stalls1s': stalls1s, 'stalls5s': stalls5s, 'worstMs': worst}}

    def sample_checks(self, reports, dry=True):
        self.m.DRY = dry
        now = getattr(self, 'next_check', self.m.time.time())
        with patch.object(self.m, 'preflight', return_value=None), \
                patch.object(self.m, 'hold_live', return_value=None), \
                patch.object(self.m.time, 'sleep'):
            for i, report in enumerate(reports):
                with patch.object(self.m.time, 'time', return_value=now + i * 300), \
                        patch.object(self.m, 'deep_health', return_value=(
                            report.get('verdict', 'stalled'), report.get('summary', ''), report)):
                    self.m.check()
        self.next_check = now + len(reports) * 300
        return [r for r in self.rows() if r['event'] == 'check']

    def triggered(self):
        return any(r['event'] in ('dry.trigger', 'trigger') for r in self.rows())

    def test_roundtrip_only_four_checks_do_not_restart(self):
        with patch.object(self.m.os, 'getloadavg', return_value=(56.6, 0, 0)):
            rows = self.sample_checks([self.health_report()] * 4)
        self.assertFalse(self.triggered())
        self.assertTrue(all(r['rawVerdict'] == 'stalled' and r['effectiveVerdict'] == 'slow-roundtrip' for r in rows))
        self.assertTrue(all(r['evidence']['source'] == 'lag' and r['rule'] is None for r in rows))
        self.assertTrue(all(r['stallSource'] == 'lag' for r in rows))
        checks = self.m.read_json(self.m.STATE, {})['checks']
        self.assertEqual([r['effectiveVerdict'] for r in checks], ['slow-roundtrip'] * 4)

    def test_real_five_second_stalls_restart(self):
        self.sample_checks([self.health_report(1, 1, 5000)] * 4)
        self.assertTrue(self.triggered())

    def test_three_one_second_stalls_count_but_do_not_outweigh_agents(self):
        report = self.health_report(3, 0, 1000)
        with patch.object(self.m, 'cost', return_value=dict(treeProcesses=2, agentProcesses=1,
                                                         runningTurns=None, runningSubagents=None)):
            rows = self.sample_checks([report] * 4)
        self.assertEqual(rows[-1]['effectiveVerdict'], 'stalled')
        self.assertEqual(rows[-1]['held'], 'agents running (1), stall not hard')

    def test_slow_roundtrips_are_neither_healthy_nor_stalled_in_long_rule(self):
        report = self.health_report(1, 1, 5000)
        rows = self.sample_checks([report, self.health_report()] * 4)
        self.assertTrue(self.triggered())
        self.assertEqual(rows[-1]['rule'], 'at most one healthy check in 8 (4 stalled)')

    def test_retry_recovery_does_not_count_as_connection_failure(self):
        failed = self.health_report(connection='timeout')
        with patch.object(self.m, 'preflight', return_value=None), \
                patch.object(self.m, 'hold_live', return_value=None), patch.object(self.m.time, 'sleep'), \
                patch.object(self.m, 'deep_health', side_effect=[('stalled', '', failed),
                    ('stalled', self.health_report()['summary'], self.health_report())]):
            self.m.check()
        check = self.m.read_json(self.m.STATE, {})['checks'][-1]
        self.assertEqual(check['effectiveVerdict'], 'slow-roundtrip')
        self.assertFalse(check['connectionFailed'])

    def test_soft_retry_does_not_make_entire_connection_run_hard(self):
        failed = self.health_report(connection='timeout')
        now = self.m.time.time()
        self.m.write_json(self.m.STATE, {'checks': [dict(at=now - 300 * i, effectiveVerdict='stalled',
                              connectionFailed=True) for i in (3, 2, 1)]})
        with patch.object(self.m, 'preflight', return_value=None), \
                patch.object(self.m, 'hold_live', return_value=None), patch.object(self.m.time, 'sleep'), \
                patch.object(self.m.os, 'getloadavg', return_value=(172.6, 0, 0)), \
                patch.object(self.m, 'deep_health', side_effect=[('stalled', '', self.health_report(1, 1, 5000)),
                                                               ('stalled', '', failed)]):
            self.m.check()
        row = next(r for r in self.rows() if r['event'] == 'check')
        self.assertFalse(row['hardStall'])
        self.assertEqual(row['held'], 'host load 172.6 > 16')

    def test_connection_timeout_four_checks_restarts_even_under_load_with_agents(self):
        report = self.health_report(connection='timeout')
        report.pop('lag')
        report['summary'] = 'connection timeout'
        with patch.object(self.m.os, 'getloadavg', return_value=(172.6, 0, 0)), \
                patch.object(self.m, 'cost', return_value=dict(treeProcesses=710, agentProcesses=8,
                                                            runningTurns=None, runningSubagents=None)):
            rows = self.sample_checks([report] * 4)
        self.assertTrue(self.triggered())
        self.assertTrue(rows[-1]['hardStall'])

    def test_high_load_holds_and_preserves_history(self):
        with patch.object(self.m.os, 'getloadavg', return_value=(16.1, 0, 0)):
            rows = self.sample_checks([self.health_report(1, 1, 5000)] * 4)
        self.assertFalse(self.triggered())
        self.assertEqual(rows[-1]['held'], 'host load 16.1 > 16')
        self.assertTrue(rows[-1]['rule'])
        self.assertEqual(len(self.m.read_json(self.m.STATE, {})['checks']), 4)
        self.sample_checks([self.health_report(1, 1, 5000)])
        self.assertTrue(self.triggered())

    def test_hard_loop_stall_bypasses_load_and_agent_holds(self):
        with patch.object(self.m.os, 'getloadavg', return_value=(172.6, 0, 0)), \
                patch.object(self.m, 'cost', return_value=dict(treeProcesses=710, agentProcesses=8,
                                                            runningTurns=None, runningSubagents=None)):
            rows = self.sample_checks([self.health_report(1, 1, 30000)] * 4)
        self.assertTrue(self.triggered())
        self.assertTrue(rows[-1]['hardStall'])

    def test_agents_running_soft_stall_holds(self):
        with patch.object(self.m, 'cost', return_value=dict(treeProcesses=710, agentProcesses=8,
                                                         runningTurns=None, runningSubagents=None)):
            rows = self.sample_checks([self.health_report(1, 1, 5000)] * 4)
        self.assertFalse(self.triggered())
        self.assertEqual(rows[-1]['held'], 'agents running (8), stall not hard')

    def test_agents_running_two_five_second_stalls_restart_and_log_cost(self):
        table = {1: (0, 'other', '/bin/launchd'), 999999: (1, 'app', self.m.EXECUTABLE),
                 1000000: (999999, 'agent', '/opt/bin/codex'), 1000001: (999999, 'shell', '/bin/zsh'),
                 1000002: (1, 'unrelated-agent', '/opt/bin/claude')}
        with patch.object(self.m, 'processes', return_value=table), \
                patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')), \
                patch.object(self.m, 'notify', return_value=True) as notify:
            rows = self.sample_checks([self.health_report(2, 2, 5000)] * 4, dry=False)
        self.assertTrue(self.triggered())
        expected = dict(treeProcesses=3, agentProcesses=1, runningTurns=None, runningSubagents=None)
        self.assertTrue(all(r['cost'] == expected for r in rows))
        self.assertEqual(self.m.read_json(self.m.STATE, {})['lastRestart']['cost'], expected)
        self.assertEqual(next(r for r in self.rows() if r['event'] == 'trigger')['cost'], expected)
        self.assertIn('would stop 1 agent processes, 3 tree processes', notify.call_args.args[1])

    def test_unknown_stall_counts_do_not_count(self):
        report = self.health_report()
        report['lag'] = {'stalls1s': None, 'stalls5s': 'bad'}
        rows = self.sample_checks([report] * 8)
        self.assertFalse(self.triggered())
        self.assertTrue(all(r['effectiveVerdict'] == 'unknown' for r in rows))

    def test_missing_counts_do_not_count(self):
        rows = self.sample_checks([{'verdict': 'stalled', 'connection': {'status': 'ok'}}] * 8)
        self.assertFalse(self.triggered())
        self.assertTrue(all(r['effectiveVerdict'] == 'unknown' for r in rows))
        self.assertTrue(all(r['stallSource'] is None for r in rows))

    def test_summary_fallback_is_logged_and_cannot_supply_hard_duration(self):
        report = self.health_report(1, 1, 30000)
        del report['lag']
        report['summary'] = 'stalled: 1 stalls >=1s in 10 min (1 >=5s), worst 30.0s at 2026-11-21T06:47:00Z; round trip timeout'
        with patch.object(self.m.os, 'getloadavg', return_value=(172.6, 0, 0)):
            rows = self.sample_checks([report] * 4)
        self.assertFalse(self.triggered())
        self.assertFalse(rows[-1]['hardStall'])
        self.assertTrue(all(r['stallSource'] == 'summary' for r in rows))

    def test_stall_configuration_overrides(self):
        spec = importlib.util.spec_from_file_location('configured_watchdog', SOURCE / 'robob-overload-restart.py')
        configured = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'ROBOB_OVERLOAD_STALL_5S': '2', 'ROBOB_OVERLOAD_STALL_1S': '4',
                                    'ROBOB_OVERLOAD_LOAD_FACTOR': '3'}):
            spec.loader.exec_module(configured)
        self.assertEqual(configured.effective_verdict('stalled', self.health_report(1, 1, 5000)), 'slow-roundtrip')
        self.assertEqual(configured.effective_verdict('stalled', self.health_report(2, 2, 5000)), 'stalled')
        self.assertEqual(configured.effective_verdict('stalled', self.health_report(4, 0, 1000)), 'stalled')
        self.assertEqual(configured.effective_verdict('stalled', self.health_report(1, 1, 30000)), 'stalled')
        self.assertEqual(configured.LOAD_FACTOR, 3)

    def test_load_at_threshold_does_not_hold(self):
        with patch.object(self.m.os, 'getloadavg', return_value=(16, 0, 0)):
            self.sample_checks([self.health_report(1, 1, 5000)] * 4)
        self.assertTrue(self.triggered())

    def test_unavailable_agent_inventory_holds_soft_stall(self):
        with patch.object(self.m, 'cost', return_value=dict(treeProcesses=4, agentProcesses=None,
                                                         runningTurns=None, runningSubagents=None)):
            rows = self.sample_checks([self.health_report(1, 1, 5000)] * 4)
        self.assertFalse(self.triggered())
        self.assertEqual(rows[-1]['held'], 'agent process cost unavailable')

    def test_legacy_raw_history_cannot_trigger(self):
        now = self.m.time.time()
        self.m.write_json(self.m.STATE, {'checks': [dict(at=now - 300 * i, verdict='stalled') for i in (3, 2, 1)]})
        self.sample_checks([self.health_report(1, 1, 5000)])
        self.assertFalse(self.triggered())

    def test_effective_verdict_input_matrix(self):
        cases = [(0, 0, 'slow-roundtrip'), (2, 0, 'slow-roundtrip'), (3, 0, 'stalled'),
                 (1, 1, 'stalled'), (None, 0, 'unknown'), ('3', 0, 'unknown'),
                 (True, 0, 'unknown'), (-1, 0, 'unknown'), (1.5, 0, 'unknown'),
                 (float('nan'), 0, 'unknown'), (float('inf'), 0, 'unknown'), (0, 1, 'unknown')]
        for one, five, expected in cases:
            with self.subTest(one=one, five=five):
                report = self.health_report(one, five)
                self.assertEqual(self.m.effective_verdict('stalled', report), expected)
        for status in ('error', 'failed', 'timeout'):
            with self.subTest(status=status):
                self.assertEqual(self.m.effective_verdict('unknown', {'connection': {'status': status}}), 'stalled')
        for status in ('skipped', 'unknown', None):
            self.assertEqual(self.m.effective_verdict('stalled', {'connection': {'status': status}}), 'unknown')
        report = self.health_report(1, 1, 5000)
        del report['lag']
        self.assertEqual(self.m.effective_verdict('stalled', report), 'stalled')
        self.assertEqual(self.m.stall_evidence(report)['source'], 'summary')
        report['lag'] = {'stalls1s': 0, 'stalls5s': 0}
        self.assertEqual(self.m.effective_verdict('stalled', report), 'slow-roundtrip')
        report['lag'] = {'stalls1s': 1}
        self.assertEqual(self.m.effective_verdict('stalled', report), 'unknown')
        for summary in (None, {}, '', 'stalled: unavailable'):
            self.assertEqual(self.m.effective_verdict('stalled', {'summary': summary}), 'unknown')

    def test_node_provider_script_matrix(self):
        for command, expected in (
            ('/bin/node /lib/@anthropic-ai/claude-code/cli.js --print hello', True),
            ('node /lib/@openai/codex/bin/codex.js app-server', True),
            ('node /bin/cursor-agent --print hello', True),
            ('node /lib/opencode-ai/bin/opencode serve', True),
            ('node /lib/@xai-official/grok/dist/index.js', True),
            ("node /lib/@anthropic-ai/claude-code/cli.js --print Abdullah's prompt", True),
            ('node /lib/@openai/codex/bin/codex.js --prompt "unfinished', True),
            ('node --no-warnings /lib/@openai/codex/bin/codex.js app-server', True),
            ('node --enable-source-maps --inspect=127.0.0.1:9229 /bin/codex', True),
            ('node --require /app/setup.js --import=/app/hook.mjs /bin/claude', True),
            ('node -r /app/setup.js --conditions fixture /bin/codex', True),
            ('node -- /bin/codex', True),
            ('node "/path with spaces/@anthropic-ai/claude-code/cli.js" --print hello', True),
            ('node /path with spaces/@anthropic-ai/claude-code/cli.js', None),
            ('node --future-option /bin/codex', None),
            ('node --require', None), ('node', None), ('node "unterminated', None),
            ('node /app/server.js codex', False), ('node -e "codex"', None),
            ('node --eval="require(\'codex\')"', None), ('node --print "codex"', None),
            ('node /repo/codex/test.js', False),
        ):
            with self.subTest(command=command):
                self.assertEqual(self.m.node_provider(command), expected)

    def test_cost_counts_descendants_and_bounds_node_argv_probe(self):
        table = {999999: (1, 'app', self.m.EXECUTABLE)}
        for pid, command in enumerate(('claude', 'codex', 'opencode', 'cursor-agent', 'grok', 'node', 'node'), 1000000):
            table[pid] = (999999, 'child', '/bin/' + command)
        out = '1000005 node /lib/@openai/codex/bin/codex.js app-server\n1000006 node /app/server.js\n'
        with patch.object(self.m, 'processes', return_value=table) as processes, \
                patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, out, '')) as run:
            self.assertEqual(self.m.cost(), dict(treeProcesses=8, agentProcesses=6, runningTurns=None, runningSubagents=None))
        self.assertEqual(processes.call_args.kwargs, {'timeout': 5})
        self.assertEqual(run.call_args.args[1], 5)
        with patch.object(self.m, 'processes', side_effect=subprocess.TimeoutExpired('ps', 5)):
            self.assertIsNone(self.m.cost()['agentProcesses'])

    def test_ambiguous_node_inventory_never_counts_as_no_agents(self):
        table = {999999: (1, 'app', self.m.EXECUTABLE),
                 1000000: (999999, 'node', '/bin/node')}
        cases = ('', '1000000 node --future-option /bin/codex\n',
                 '1000000 node "unterminated\n', '1000001 node /app/server.js\n',
                 '1000000 node /app/server.js\n1000000 node /app/server.js\n',
                 'garbled output\n')
        for output in cases:
            with self.subTest(output=output), patch.object(self.m, 'processes', return_value=table), \
                    patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                self.assertEqual(self.m.cost()['treeProcesses'], 2)
                self.assertIsNone(self.m.cost()['agentProcesses'])

    def test_node_option_value_spaces_never_hide_providers(self):
        script = '/lib/@anthropic-ai/claude-code/cli.js'
        cases = (
            ('node --require /Users/ardud/Library/Application Support/preload.js ' + script, None),
            ('node --require=/Users/ardud/Library/Application Support/preload.js ' + script, None),
            ('node -r /Users/ardud/Library/Application Support/preload.js ' + script, None),
            ('node --import /path with spaces/hook.mjs ' + script, None),
            ('node --title=App title.cjs ' + script, None),
            ('node --title App title.cjs ' + script, None),
            ('node --require "/Users/ardud/Library/Application Support/preload.js" ' + script, True),
            ('node --require=/app/preload.js ' + script, True),
            ('node --require /app/preload.js /app/server.js', None),
            ('node --import=/app/hook.mjs /app/server.js', None),
        )
        table = {999999: (1, 'app', self.m.EXECUTABLE), 1000000: (999999, 'node', '/bin/node')}
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(self.m.node_provider(command), expected)
                output = '1000000 ' + command + '\n'
                with patch.object(self.m, 'processes', return_value=table), \
                        patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')):
                    self.assertEqual(self.m.cost()['agentProcesses'], 1 if expected else None)

    def test_summary_count_token_matrix(self):
        cases = [('0', '0', 'slow-roundtrip'), ('3', '0', 'stalled'), ('1', '1', 'stalled'),
                 ('003', '0', 'stalled'), ('-3', '0', 'unknown'), ('+3', '0', 'unknown'),
                 ('1.5', '0', 'unknown'), ('1e3', '0', 'unknown'), ('1,003', '0', 'unknown'),
                 ('NaN', '0', 'unknown'), ('inf', '0', 'unknown'), ('bad3', '0', 'unknown'),
                 ('3', '-1', 'unknown'), ('3', '+1', 'unknown'), ('3', '1.5', 'unknown'),
                 ('3', '', 'unknown'), ('0', '1', 'unknown')]
        for one, five, expected in cases:
            with self.subTest(one=one, five=five):
                summary = f'stalled: {one} stalls >=1s in 10 min ({five} >=5s); round trip timeout'
                report = {'connection': {'status': 'ok'}, 'summary': summary}
                self.assertEqual(self.m.effective_verdict('stalled', report), expected)
        for suffix in ('bad', '.5', ' extra'):
            report = {'connection': {'status': 'ok'},
                      'summary': 'stalled: 3 stalls >=1s in 10 min (0 >=5s)' + suffix}
            self.assertEqual(self.m.effective_verdict('stalled', report), 'unknown')

    def test_a_fifo_ssd_holds_check_before_health_or_quit(self):
        self.fifo(Path(self.m.SSD_PROBE))
        self.m.deep_health = lambda: self.fail('health must not run after unsafe preflight')
        start = time.monotonic()
        self.assertEqual(self.m.check(), 0)
        self.assertLess(time.monotonic() - start, 2)
        self.assertFalse(self.quit.exists())
        self.assertEqual(len(self.accepted()), 1)
        self.assertEqual([r['reason'] for r in self.rows() if r['event'] == 'held'], ['ssd:timeout'])
        self.assertIn('stages', self.rows()[-1])
        self.assertIn('rule', self.rows()[-1])

    def test_b_marker_even_when_stale_holds(self):
        self.m.MAC_SSD_MARKER.touch()
        os.utime(self.m.MAC_SSD_MARKER, (1, 1))
        self.m.check()
        self.assertFalse(self.quit.exists())
        self.assertEqual(len(self.accepted()), 1)
        self.assertEqual([r['reason'] for r in self.rows() if r['event'] == 'held'], ['mac-ssd-marker'])

    def test_c_fifo_readiness_supervisor_kills_and_releases(self):
        fifo = self.root / 'readiness.fifo'
        os.mkfifo(fifo)
        pidfile = self.root / 'readiness.pid'
        self.m.HEALTH.write_text('import os\nfrom pathlib import Path\nPath(' + repr(str(pidfile)) +
                                ').write_text(str(os.getpid()))\nopen(' + repr(str(fifo)) + ').read()')
        self.m.NODE = sys.executable
        # Restore the actual timed child command, not a mocked sleep or signal alarm.
        self.m.deep_health = lambda: self.m.run([sys.executable, str(self.m.HEALTH)], 90)
        start = time.monotonic()
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assertLess(time.monotonic() - start, 4)
        self.assertTrue(self.quit.exists())
        self.assertTrue(self.opened.exists())
        self.assert_result('restart.failed', 'deadline')
        self.assertTrue(any(r['event'] == 'restart.probe' for r in self.rows()))
        self.assertTrue(any(r['event'] == 'hold.released' for r in self.rows()))
        probe_pid = int(pidfile.read_text())
        proc = Path('/proc') / str(probe_pid) / 'status'
        if proc.exists():
            self.assertIn('Z (zombie)', proc.read_text())
        else:
            with self.assertRaises(ProcessLookupError):
                os.kill(probe_pid, 0)

    def test_d_notify_retries_same_key_until_one_acceptance(self):
        self.m.ENV['ROBOB_OVERLOAD_FAIL_SENDS'] = '2'
        self.assertEqual(self.m.restart('cycle'), 0)
        self.assert_result('restart.done')
        rows = [r for r in self.rows() if r['event'].startswith('notify.')]
        self.assertEqual([r['event'] for r in rows], ['notify.failed', 'notify.failed', 'notify.sent'])
        self.assertEqual(len({r['key'] for r in rows}), 1)
        self.assertEqual([r['rc'] for r in rows], [7, 7, 0])

    def test_e_happy_path(self):
        self.assertEqual(self.m.restart('cycle'), 0)
        row, sent = self.assert_result('restart.done')
        self.assertEqual(row['newServerPid'], 202)
        self.assertEqual(sent[sent.index('--severity') + 1], 'info')
        probes = [r for r in self.rows() if r['event'] == 'restart.probe']
        self.assertEqual(probes[-1]['outcome'], 'ready')
        for field in ('ms', 'elapsed', 'holdAge'):
            self.assertIn(field, probes[-1])

    def test_f_each_standing_limit_refuses_both_entrypoints(self):
        cases = ('disabled', 'live-install-hold', 'install-session', 'restart-session',
                 'building', 'server-start-unreadable', 'server-up-under-two-hours', 'last-restart-under-two-hours')
        for name in cases:
            with self.subTest(name=name):
                with contextlib.ExitStack() as stack:
                    if name == 'disabled':
                        (self.state / 'disabled').touch()
                        stack.callback((self.state / 'disabled').unlink)
                    elif name == 'live-install-hold':
                        stack.enter_context(patch.object(self.m, 'hold_live', lambda: 'other-installer'))
                    elif name.endswith('-session'):
                        socket = name.split('-')[0]
                        stack.enter_context(patch.object(self.m, 'tmux_session', lambda s, n, details=None: s == socket))
                    elif name == 'building':
                        stack.enter_context(patch.object(self.m, 'building', lambda: ['release-2026 fake']))
                    elif name == 'server-start-unreadable':
                        stack.enter_context(patch.object(self.m, 'server_started', lambda: (None, None)))
                    elif name == 'server-up-under-two-hours':
                        stack.enter_context(patch.object(self.m, 'server_started', lambda: (101, self.m.time.time() - 60)))
                    elif name == 'last-restart-under-two-hours':
                        self.m.write_json(self.m.STATE, {'lastRestartAt': self.m.time.time() - 60})
                    self.m.check()
                    self.assertEqual(self.m.restart(name.replace('-', '')), 1)
                    self.assertFalse(self.quit.exists())
                    self.assertFalse((self.root / 'holds.ndjson').exists())
                self.m.STATE.unlink(missing_ok=True)

    def test_expiry_stops_checks_but_supervisor_and_worker_finish(self):
        self.m.EXPIRES = '2000-01-01T00:00:00+00:00'
        with patch.object(self.m, 'deep_health', side_effect=AssertionError('expired check ran health')):
            self.assertEqual(self.m.check(), 0)
        self.assertEqual([r['event'] for r in self.rows()], ['expired'])
        self.assertFalse(self.quit.exists())
        self.assertFalse(self.m.STATE.exists())
        self.assertEqual(self.accepted(), [])
        # The real worker runs under the supervisor, through fake quit/open/readiness.
        self.assertEqual(self.m.restart('cycle'), 0)
        self.assert_result('restart.done')
        self.assertTrue(self.quit.exists())
        self.assertTrue(self.opened.exists())

    def test_expired_restart_still_refuses_disabled(self):
        self.m.EXPIRES = '2000-01-01T00:00:00+00:00'
        (self.state / 'disabled').touch()
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assert_result('restart.failed', 'disabled')
        self.assertEqual(self.m.restart_worker()['reason'], 'disabled')
        self.assertFalse(self.quit.exists())
        self.assertFalse((self.root / 'holds.ndjson').exists())

    def test_status_names_check_expiry_scope(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(self.m.status(), 0)
        status = json.loads(output.getvalue())
        self.assertEqual(status['expires'], self.m.EXPIRES)
        self.assertEqual(status['expiresScope'], 'check')

    def test_qf_install_pane_matrix(self):
        now = self.m.time.time()
        cases = [
            ('node-old', 'install14', '0', 'node', 7200, True),
            ('unnumbered', 'install', '0', 'node', 7200, True),
            ('dead', 'install14', '1', 'node', 12, False),
            ('other-session', 'foo', '0', 'node', 12, False),
            ('suffix', 'install14extra', '0', 'node', 12, False),
            ('negative-number', 'install-1', '0', 'node', 12, False),
            ('future', 'install14', '0', 'zsh', -10, True),
        ]
        for shell in ('zsh', '-zsh', 'bash', 'sh', 'login'):
            for age, held in ((600, True), (1800, True), (1801, False), (7200, False)):
                cases.append((f'{shell}-{age}', 'install14', '0', shell, age, held))
        for label, name, dead, command, age, held in cases:
            with self.subTest(label=label):
                output = f'{name}\t{dead}\t{command}\t{int(now - age)}\n'
                with patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')) as run:
                    details = {}
                    self.assertEqual(self.m.limits({}, details=details),
                                     'restart-or-install-session' if held else None)
                    args, timeout = run.call_args.args
                    self.assertEqual(args, [self.m.TMUX, '-L', 'qf-install', 'list-panes', '-a', '-F',
                                           '#{session_name}\t#{pane_dead}\t#{pane_current_command}\t#{session_activity}'])
                    self.assertEqual(timeout, 10)
                    if held:
                        self.assertIn(f'qf-install/{name} cmd={command} idle=', details['detail'])
                    else:
                        self.assertEqual(details, {})

    def test_qf_multiple_panes_do_not_hide_active_install(self):
        now = int(self.m.time.time())
        output = f'install14\t0\tzsh\t{now - 7200}\ninstall14\t0\tnode\t{now - 7200}\n'
        with patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')):
            details = {}
            self.assertTrue(self.m.qf_install_active(details))
        self.assertEqual(details['detail'], 'qf-install/install14 cmd=node idle=7200s')

    def test_qf_probe_failure_matrix(self):
        cases = [
            (1, '', '', False),
            (1, '', 'no server running on /tmp/qf-install', False),
            (2, '', 'error connecting to /tmp/qf-install', False),
            (2, 'no server running', '', False),
            (2, '', 'permission denied', True),
            (127, '', 'exec failed', True),
            (0, 'install14\t0\tzsh\tinvalid\n', '', True),
            (0, 'install14\t0\n', '', True),
            (0, 'install14\tunknown\tnode\t0\n', '', True),
        ]
        for rc, stdout, stderr, held in cases:
            with self.subTest(rc=rc, stdout=stdout, stderr=stderr):
                with patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], rc, stdout, stderr)):
                    details = {}
                    self.assertEqual(self.m.qf_install_active(details), held)
                if held:
                    self.assertIn('probe-failed', details['detail'])
                else:
                    self.assertEqual(details, {})
        for error in (subprocess.TimeoutExpired('tmux', 10), OSError('fake tmux failure')):
            with self.subTest(error=type(error).__name__), patch.object(self.m, 'run', side_effect=error):
                details = {}
                self.assertEqual(self.m.limits({}, details=details), 'restart-or-install-session')
                self.assertIn('probe-failed ' + type(error).__name__, details['detail'])

    def test_qf_configuration_overrides(self):
        spec = importlib.util.spec_from_file_location('configured_watchdog', SOURCE / 'robob-overload-restart.py')
        configured = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'ROBOB_OVERLOAD_QF_SOCKET': 'test-install',
                                    'ROBOB_OVERLOAD_QF_SESSION_RE': r'^fixture\d*$',
                                    'ROBOB_OVERLOAD_QF_IDLE_SEC': '42'}):
            spec.loader.exec_module(configured)
        now = int(time.time())
        for age, held in ((10, True), (600, False)):
            with self.subTest(age=age):
                output = f'fixture2\t0\tzsh\t{now - age}\n'
                with patch.object(configured, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')) as run:
                    self.assertEqual(configured.qf_install_active(), held)
                self.assertEqual(run.call_args.args[0][2], 'test-install')

    def test_session_details_reach_check_and_restart_refusal(self):
        for source in ('qf', 'install', 'restart'):
            with self.subTest(source=source), contextlib.ExitStack() as stack:
                self.m.LOG.unlink(missing_ok=True)
                self.m.STATE.unlink(missing_ok=True)
                if source == 'qf':
                    expected = 'qf-install/install14 cmd=node idle=12s'
                    output = f'install14\t0\tnode\t{int(self.m.time.time() - 12)}\n'
                    stack.enter_context(patch.object(self.m, 'run', return_value=subprocess.CompletedProcess([], 0, output, '')))
                else:
                    expected = f'{source}/robob-{source}'
                    stack.enter_context(patch.object(self.m, 'tmux_session', self.tmux_session))
                    def run(args, timeout):
                        return subprocess.CompletedProcess(args, 0 if args[2] == source else 1, '', '')
                    stack.enter_context(patch.object(self.m, 'run', run))
                # Avoid the fake probe intercepting notification commands.
                stack.enter_context(patch.object(self.m, 'notify', return_value=True))
                self.assertEqual(self.m.check(), 0)
                row = next(r for r in self.rows() if r['event'] == 'check')
                self.assertEqual(row['held'], 'restart-or-install-session')
                self.assertEqual(row['detail'], expected)
                self.assertEqual(self.m.restart(source), 1)
                row = next(r for r in self.rows() if r['event'] == 'restart.failed')
                self.assertEqual(row['reason'], 'restart-or-install-session')
                self.assertEqual(row['detail'], expected)
                self.assertFalse(self.quit.exists())

    def test_qf_worker_recheck_logs_and_returns_detail(self):
        calls = []
        def active(details=None):
            calls.append(1)
            if len(calls) == 1:
                return False
            details['detail'] = 'qf-install/install14 cmd=node idle=12s'
            return True
        with patch.object(self.m, 'qf_install_active', active):
            self.assertEqual(self.m.restart('cycle'), 1)
        row, _ = self.assert_result('restart.failed', 'restart-or-install-session')
        self.assertEqual(row['detail'], 'qf-install/install14 cmd=node idle=12s')
        held = next(r for r in self.rows() if r['event'] == 'held')
        self.assertEqual(held['detail'], row['detail'])
        self.assertFalse(self.quit.exists())

    def test_existing_tmux_probe_failures_have_detail_and_hold(self):
        for result in (subprocess.CompletedProcess([], 2, '', 'failure'),
                       subprocess.TimeoutExpired('tmux', 10), OSError('failure')):
            with self.subTest(result=type(result).__name__):
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch.object(self.m, 'run', **kwargs):
                    details = {}
                    self.assertTrue(self.tmux_session('install', 'robob-install', details))
                    self.assertIn('install/robob-install probe-failed', details['detail'])

    def test_g_worker_exception_releases_and_reports_once(self):
        def explode():
            raise RuntimeError('mid-restart')
        self.m.restart_worker = explode
        self.assertEqual(self.m.restart('cycle'), 1)
        row, sent = self.assert_result('restart.failed')
        self.assertIn('RuntimeError', row['reason'])
        self.assertTrue(sent[sent.index('--text') + 1].startswith('ROBOB IS DOWN'))

    def test_failed_or_slow_dependency_refuses(self):
        for name in ('ssd', 'app-executable', 'userdata'):
            with self.subTest(name=name):
                path = {'ssd': Path(self.m.SSD_PROBE), 'app-executable': Path(self.m.EXECUTABLE), 'userdata': self.link}[name]
                destination = path.with_name(path.name + '.saved')
                path.rename(destination)
                try:
                    self.assertEqual(self.m.preflight(), name + ':error')
                finally:
                    destination.rename(path)
        self.m.PROBE_SLOW = 0
        self.assertEqual(self.m.preflight(), 'ssd:slow')

    def test_read_only_probe_has_no_hold_quit_or_notice(self):
        self.assertEqual(self.m.probe(), 0)
        self.assertFalse(self.quit.exists())
        self.assertFalse((self.root / 'holds.ndjson').exists())
        self.assertEqual(self.accepted(), [])

    def test_worker_killed_still_has_result(self):
        self.m.restart_worker = lambda: os.kill(os.getpid(), signal.SIGKILL)
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assert_result('restart.failed')

    def test_supervisor_term_during_worker_cleanup(self):
        def stop_parent():
            os.kill(os.getppid(), signal.SIGTERM)
            with open(self.root / 'jam', 'r'):
                pass
        os.mkfifo(self.root / 'jam')
        self.m.restart_worker = stop_parent
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assert_result('restart.failed')

    def test_watchdog_parent_never_opens_dependency_paths(self):
        parent = os.getpid()
        original = io.open
        dependencies = [str(self.userdata), self.m.EXECUTABLE, str(self.link)]
        def guarded_open(file, *args, **kw):
            if os.getpid() == parent and any(str(file).startswith(p) for p in dependencies):
                raise AssertionError('parent opened dependency ' + str(file))
            return original(file, *args, **kw)
        with patch('io.open', guarded_open):
            self.assertEqual(self.m.restart('cycle'), 0)
        self.assert_result('restart.done')

    def test_replaying_completed_stamp_does_not_duplicate_result(self):
        self.assertEqual(self.m.restart('cycle'), 0)
        self.m.write_json(self.m.STATE, {})
        self.m.restart('cycle')
        self.assert_result('restart.done')
        self.assertEqual(len((self.root / 'holds.ndjson').read_text().splitlines()), 2)

    def test_refusal_after_hold_still_releases_and_sends_one_result(self):
        calls = []
        def preflight():
            calls.append(1)
            return 'mac-ssd-marker' if len(calls) > 1 else None
        self.m.preflight = preflight
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assert_result('restart.failed', 'mac-ssd-marker')
        self.assertFalse(self.quit.exists())

    def test_command_exec_and_fifo_open_are_timed_outside_child(self):
        fifo = self.root / 'command.fifo'
        os.mkfifo(fifo)
        # The command's interpreter opens the FIFO; run owns the hard timeout.
        command = [sys.executable, '-c', 'open(' + repr(str(fifo)) + ').read()']
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.m.run(command, 0.2)
        self.assertLess(time.monotonic() - start, 1.5)

    def test_overload_rule_matrix_and_trigger_failure_result(self):
        cases = (
            ('four-stalled', ['stalled'] * 4, True),
            ('mixed-eight', ['stalled', 'unknown'] * 4, True),
            ('one-healthy', ['healthy', 'stalled', 'unknown', 'stalled', 'unknown', 'stalled', 'unknown', 'stalled'], True),
            ('two-healthy', ['healthy', 'degraded', 'stalled', 'unknown', 'stalled', 'stalled', 'unknown', 'stalled'], False),
            ('three-stalled', ['unknown'] * 4 + ['stalled'] * 3 + ['unknown'], False),
            ('gap-breaks', ['stalled'] * 4, False),
        )
        for name, verdicts, triggers in cases:
            with self.subTest(name=name), patch.object(self.m, 'preflight', lambda: None), \
                    patch.object(self.m.time, 'sleep', lambda _: None):
                self.m.LOG.unlink(missing_ok=True)
                step = 500 if name == 'gap-breaks' else 300
                now = self.m.time.time()
                checks = [{'at': now - step * (len(verdicts) - i - 1), 'verdict': v, 'effectiveVerdict': v}
                          for i, v in enumerate(verdicts[:-1])]
                self.m.write_json(self.m.STATE, {'checks': checks})
                self.m.deep_health = lambda: (verdicts[-1], verdicts[-1], self.health_report(1, 1, 5000))
                prior_run = self.m.run
                def fail_tmux(args, timeout):
                    if args[0] == self.m.TMUX:
                        return subprocess.CompletedProcess(args, 1, '', 'fake trigger refused')
                    return prior_run(args, timeout)
                with patch.object(self.m, 'run', fail_tmux):
                    self.m.check()
                row = next(r for r in self.rows() if r['event'] == 'check')
                self.assertEqual(bool(row['rule']), triggers, row)
                self.assertIn('connection', row['stages'])
                self.assertEqual(any(r['event'] == 'restart.failed' for r in self.rows()), triggers)
                for receipt in self.state.glob('result-*.json'):
                    receipt.unlink()

    def test_reserved_cycle_consumes_cooldown_once(self):
        stamp = 'reserved'
        self.m.write_json(self.m.STATE, {'lastRestartAt': self.m.time.time(),
                                       'lastRestart': {'stamp': stamp}})
        self.m.tmux_session = lambda socket, name, details=None: socket == 'restart'
        self.assertEqual(self.m.restart(stamp), 0)
        self.assertTrue(self.m.read_json(self.m.STATE, {})['lastRestart']['consumed'])
        self.assertEqual(self.m.restart('differentcycle'), 1)
        self.assertEqual(len((self.root / 'holds.ndjson').read_text().splitlines()), 2)

    def test_overlapping_same_stamp_cannot_finalize_or_delete_worker_result(self):
        original = self.m.restart_worker
        def contender():
            result = self.state / 'restart-cycle.json'
            result.write_text('{"sentinel": true}')
            rc = self.m.restart('cycle')
            if rc != 1 or not result.exists() or self.accepted():
                raise AssertionError('duplicate finalized an active cycle')
            return original()
        self.m.restart_worker = contender
        self.assertEqual(self.m.restart('cycle'), 0)
        self.assert_result('restart.done')
        self.assertTrue(any(r['event'] == 'restart.duplicate' for r in self.rows()))

    def test_tmux_timeout_after_supervisor_started_leaves_result_to_owner(self):
        ready_r, ready_w = os.pipe()
        release_r, release_w = os.pipe()
        done_r, done_w = os.pipe()
        for fd in (ready_r, ready_w, release_r, release_w, done_r, done_w):
            self.addCleanup(os.close, fd)
        self.m.RESTART_DEADLINE = 5
        original_worker = self.m.restart_worker
        supervisor = None
        def gated_worker():
            os.write(ready_w, b'R')
            os.read(release_r, 1)
            return original_worker()
        self.m.restart_worker = gated_worker
        real_run = self.m.run
        def launch_then_timeout(args, timeout):
            nonlocal supervisor
            if args[0] != self.m.TMUX or args[3] != 'new-session':
                return real_run(args, timeout)
            stamp = self.m.read_json(self.m.STATE, {})['lastRestart']['stamp']
            supervisor = os.fork()
            if supervisor == 0:
                try:
                    rc = self.m.restart(stamp)
                    os.write(done_w, str(rc).encode())
                finally:
                    os._exit(0)
            if not select.select([ready_r], [], [], 3)[0]:
                raise AssertionError('supervisor never reached worker')
            os.read(ready_r, 1)
            raise subprocess.TimeoutExpired(args, timeout)
        self.m.run = launch_then_timeout
        now = self.m.time.time()
        self.m.write_json(self.m.STATE, {'checks': [{'at': now - step * 300, 'verdict': 'stalled', 'effectiveVerdict': 'stalled'}
                                                   for step in (3, 2, 1)]})
        report = self.health_report(1, 1, 5000)
        report['roundTrip'] = {'status': 'ok', 'ms': 12}
        self.m.deep_health = lambda: ('stalled', 'stalled', report)
        # The check's 20-second retry is unrelated to the race; preserve actual worker waits.
        with patch.object(self.m.time, 'sleep', lambda _: None):
            self.assertEqual(self.m.check(), 1)
        self.assertFalse(any(r['event'] in ('restart.done', 'restart.failed') for r in self.rows()))
        self.assertEqual(self.accepted(), [])
        os.write(release_w, b'G')
        self.assertTrue(select.select([done_r], [], [], 4)[0], 'supervisor did not finish')
        self.assertEqual(os.read(done_r, 1), b'0')
        os.waitpid(supervisor, 0)
        terminal = [r for r in self.rows() if r['event'] in ('restart.done', 'restart.failed')]
        self.assertEqual([r['event'] for r in terminal], ['restart.done'])
        self.assertEqual(len(self.accepted()), 1)
        self.assertFalse(self.m.HOLD.exists())

    def test_trigger_failure_claim_before_late_supervisor_prevents_quit(self):
        self.assertEqual(self.m.terminal('cycle', self.m.failed('trigger-timeout')), 1)
        self.assertEqual(self.m.restart('cycle'), 1)
        self.assert_result('restart.failed', 'trigger-timeout')
        self.assertFalse(self.quit.exists())
        self.assertFalse((self.root / 'holds.ndjson').exists())

    def test_term_between_fork_and_child_group_setup_cannot_reach_quit(self):
        ready_r, ready_w = os.pipe()
        self.addCleanup(os.close, ready_r)
        self.addCleanup(os.close, ready_w)
        jam = self.root / 'before-group.fifo'
        os.mkfifo(jam)
        actual = os.setpgid
        worker = []
        def pause_child(pid, group):
            if pid == 0:
                os.write(ready_w, b'R')
                with open(jam):
                    pass
            else:
                worker.append(pid)
                if not select.select([ready_r], [], [], 3)[0]:
                    raise AssertionError('worker never reached group setup')
                os.read(ready_r, 1)
                os.kill(os.getpid(), signal.SIGTERM)
            return actual(pid, group)
        with patch.object(self.m.os, 'setpgid', pause_child):
            self.assertEqual(self.m.restart('cycle'), 1)
        row, _ = self.assert_result('restart.failed')
        self.assertIn('supervisor-signal', row['reason'])
        self.assertFalse(self.quit.exists())
        self.assertFalse(self.opened.exists())
        # Unblock would permit quit if the supervisor had only killed a nonexistent group.
        fd = os.open(jam, os.O_RDWR | os.O_NONBLOCK)
        os.close(fd)
        proc = Path('/proc') / str(worker[0]) / 'status'
        if proc.exists():
            self.assertIn('Z (zombie)', proc.read_text())
        else:
            with self.assertRaises(ProcessLookupError):
                os.kill(worker[0], 0)


class InstallerTests(unittest.TestCase):
    def test_install_stays_disabled_and_uses_nonexec_zsh_entry(self):
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, HOME=temp)
            env['PATH'] = temp + ':/usr/bin:/bin'
            forbidden = Path(temp) / 'launchctl'
            forbidden.write_text('#!/bin/sh\necho invoked > "$HOME/loaded"\nexit 88\n')
            forbidden.chmod(0o700)
            result = subprocess.run(['/bin/zsh', '-f', str(SOURCE / 'install.zsh')],
                                    env=env, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((Path(temp) / 'loaded').exists())
            self.assertTrue((Path(temp) / '.local/state/robob-overload-restart/disabled').exists())
            install = Path(temp) / '.local/share/robob-overload-restart'
            plist = plistlib.loads((Path(temp) / 'Library/LaunchAgents/com.ardud.robob-overload-restart.plist').read_bytes())
            self.assertEqual(plist['ProgramArguments'], ['/bin/zsh', '-f', str(install / 'launchd-entry.zsh'), 'check'])
            self.assertEqual(plist['StartInterval'], 300)
            self.assertNotIn('exec ', (install / 'launchd-entry.zsh').read_text())
            for filename in ('client.mjs', 'deep-health.mjs'):
                self.assertEqual((install / 'control' / filename).read_bytes(),
                                 (SOURCE / '../../apps/server/src/ardud/control' / filename).read_bytes())
            userdata = Path(temp) / 'disk/userdata'
            userdata.mkdir(parents=True)
            (userdata / 'server-runtime.json').write_text('{}')
            link = Path(temp) / 'userdata'
            link.symlink_to(userdata)
            app = Path(temp) / 'Robob.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            (app / 'Contents/MacOS/Robob').write_text('binary')
            env.update(ROBOB_OVERLOAD_APP=str(app), ROBOB_OVERLOAD_USERDATA=str(link))
            probe = subprocess.run(['/bin/zsh', '-f', str(install / 'launchd-entry.zsh'), 'probe'],
                                   env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(probe.returncode, 0, probe.stderr)
            self.assertEqual(json.loads(probe.stdout.splitlines()[-1])['outcome'], 'ok')
            self.assertFalse((Path(temp) / 'loaded').exists())


if __name__ == '__main__':
    unittest.main()
