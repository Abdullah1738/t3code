import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import Mock, patch
from janitor_test_safety import JanitorTestCase
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import dev_janitor
import leftover_processes as lp
from test_leftover_processes import OWNER, ROSTER

HELPERS = {'cua': '/opt/cua-driver mcp',
           'perplexity': 'node /opt/node_modules/@perplexity-ai/mcp-server/dist/index.js',
           'dia': 'node --max-semi-space-size=1 /opt/dia-agent-bridge/src/server.js'}


class McpTests(JanitorTestCase):
    def setUp(self):
        self.now = 1794787200
        self.start = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - 300))
        self.row = dict(pid=42, ppid=1, start=self.start, tty='??', args=HELPERS['cua'], rss_kib=1024)
        self.rows = {1: dict(pid=1, ppid=0, start=self.start, tty='??', args='/sbin/launchd'), 42: self.row}
        self.binding = {'CODEX_THREAD_ID': 'native-owner'}

    def detect(self, **kwargs):
        options = dict(binding=lambda pid: copy.deepcopy(self.binding), resolve=lambda value: copy.deepcopy(OWNER), now=self.now)
        options.update(kwargs)
        return lp.detect_mcp_orphans(self.rows, ROSTER, {}, **options)

    def parent(self, args):
        self.row['ppid'] = 30
        self.rows[30] = dict(pid=30, ppid=1, start=self.start, tty='??', args=args, rss_kib=100)

    def test_exact_executable_entry_matrix(self):
        forms = [(args, key) for key, args in HELPERS.items()] + [
            ('node /opt/dia-agent-bridge/src/server.js', 'dia'),
            ('node --max-old-space-size=256 /opt/dia-agent-bridge/src/server.js', 'dia'),
            ('cua-driver serve', None), ('cua-driver screenshot --mode mcp', None),
            ('node /opt/dia-agent-bridge/src/log-launcher.js guard 0 9000 0', None),
            ('node /opt/dia-agent-bridge/src/server.js.bak', None),
            ('node /opt/not-perplexity-mcp/server.js', None),
            ('node -e "require(\'/opt/dia-agent-bridge/src/server.js\')"', None),
            ('node --require /opt/dia-agent-bridge/src/server.js /opt/other.js', None),
            ('node /opt/other.js /opt/dia-agent-bridge/src/server.js', None),
            ('/Applications/Dia.app/Contents/MacOS/Dia --mcp', None),
            ('(node)', None), ('node', None), ('node "unterminated', None)]
        for args, expected in forms:
            with self.subTest(args=args): self.assertEqual(lp.mcp_helper(args), expected)

    def test_every_helper_old_parentless_missing_or_ended_provider(self):
        for helper, args in HELPERS.items():
            for parent in [None, 'missing', 'claude', 'codex', 'opencode', '/Users/test/.robob/tools/claude']:
                with self.subTest(helper=helper, parent=parent):
                    self.setUp()
                    self.row['args'] = args
                    if parent == 'missing': self.row['ppid'] = 99
                    elif parent: self.parent(parent)
                    report = self.detect()
                    self.assertEqual(report['candidates'][0]['rule'], 'a' if parent in {None, 'missing'} else 'b')
                    self.assertEqual(report['counts'], {helper: 1})
                    self.assertEqual((report['rss_kib'], report['oldest_age_s']), (1024, 300))

    def test_every_helper_live_unknown_unsettled_held_queued_pending_owner_kept(self):
        forms = [None, {'thread': {'threadId': 'owner'}, 'keep_reason': 'owner_deleted'}]
        for area, key, value in [('thread', 'state', 'running'), ('thread', 'settled', False),
                                 ('recovery', 'heldWork', True), ('recovery', 'children', [{'status': 'queued'}]),
                                 ('thread', 'pendingRequests', [{'id': 'q'}])]:
            own = copy.deepcopy(OWNER)
            own[area][key] = value
            forms.append(own)
        for helper, args in HELPERS.items():
            for provider in [None, 'codex', 'claude', 'opencode']:
                for own in forms:
                    with self.subTest(helper=helper, provider=provider, own=own):
                        self.setUp()
                        self.row['args'] = args
                        if provider: self.parent(provider)
                        self.assertEqual(self.detect(resolve=lambda value: own)['candidates'], [])

    def test_every_helper_shared_services_apps_and_ancestors_kept(self):
        for helper, args in HELPERS.items():
            for service in ['codex app-server', 'opencode serve --port 49374', 'cua-driver serve',
                            'node /opt/robob/apps/server/dist/bin.mjs',
                            '/Applications/Robob.app/Contents/MacOS/Robob',
                            '/Applications/Dia.app/Contents/MacOS/Dia']:
                with self.subTest(helper=helper, service=service):
                    self.setUp()
                    self.row['args'] = args
                    self.parent(service)
                    self.assertEqual(self.detect()['candidates'], [])
                    self.rows[20] = {**self.rows.pop(30), 'pid': 20}
                    self.parent('claude')
                    self.rows[30]['ppid'] = 20
                    self.assertEqual(self.detect()['candidates'], [])

    def test_every_helper_young_tty_registered_keep_and_exiting_kept(self):
        for helper, args in HELPERS.items():
            for mode in ['young', 'tty', 'registered', 'ancestor_registered', 'keep', 'exiting']:
                with self.subTest(helper=helper, mode=mode):
                    self.setUp()
                    self.row['args'] = args
                    labels, keep = {}, []
                    if mode == 'young': self.row['start'] = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(self.now - 299))
                    elif mode == 'tty': self.row['tty'] = 'ttys001'
                    elif mode == 'registered': labels[42] = 'shared.mcp'
                    elif mode == 'ancestor_registered':
                        self.parent('claude')
                        labels[30] = 'shared.provider'
                    elif mode == 'keep': keep = ['42']
                    elif mode == 'exiting': self.row['rss_kib'] = 0
                    self.assertEqual(lp.detect_mcp_orphans(self.rows, ROSTER, labels, keep,
                        binding=lambda pid: self.binding, resolve=lambda value: OWNER, now=self.now)['candidates'], [])

    def test_parent_binding_unknown_conflict_fallback_and_live_outer_provider(self):
        self.parent('claude')
        other = copy.deepcopy(OWNER)
        other['thread']['threadId'] = 'another'
        self.assertEqual(self.detect(binding=lambda pid: self.binding if pid == 42 else None)['candidates'], [])
        self.assertEqual(self.detect(binding=lambda pid: {'T3_THREAD_ID': str(pid)},
                                     resolve=lambda b: OWNER if b['T3_THREAD_ID'] == '42' else other)['candidates'], [])
        self.assertEqual(len(self.detect(binding=lambda pid: None if pid == 42 else self.binding)['candidates']), 1)
        self.rows[20] = {**self.rows[30], 'pid': 20, 'args': 'codex'}
        self.rows[30]['ppid'] = 20
        self.assertEqual(self.detect(binding=lambda pid: None if pid == 20 else self.binding)['candidates'], [])
        self.rows[30]['ppid'] = 98
        self.assertEqual(self.detect()['candidates'], [])

    def test_errors_incomplete_roster_and_budget_keep(self):
        self.assertEqual(self.detect(binding=Mock(side_effect=OSError))['candidates'], [])
        self.assertEqual(self.detect(resolve=Mock(side_effect=RuntimeError))['candidates'], [])
        with patch.dict(ROSTER, complete=False): self.assertEqual(self.detect()['candidates'], [])
        self.assertEqual(self.detect(deadline=0)['candidates'], [])
        with patch.object(lp, 'cpu_processes', side_effect=ValueError):
            self.assertEqual(lp.scan_mcp_orphans(ROSTER)['candidates'], [])

    def reap(self, report=None, **kwargs):
        report = self.detect() if report is None else report
        defaults = dict(rescan=lambda pid: self.detect(target_pid=pid), observe=lambda: copy.deepcopy(self.rows), send=Mock(), pause=Mock())
        defaults.update(kwargs)
        return lp.reap_mcp_orphans(report, **defaults)

    def test_term_ten_seconds_kill_and_freed_rss(self):
        report, events = self.detect(), []
        def send(pid, sig):
            events.append((pid, sig.name))
            if sig == lp.signal.SIGKILL: del self.rows[42]
        actions = self.reap(report, send=send, pause=lambda seconds: events.append(seconds))
        self.assertEqual(events, [(42, 'SIGTERM'), 10, (42, 'SIGKILL'), 1])
        self.assertTrue(actions[0]['ok'])
        self.assertEqual(report['freed_rss_kib'], 1024)
        self.assertEqual(report['reaped_counts'], {'cua': 1})
        self.assertEqual(actions[0]['start'], self.start)

    def test_term_exit_needs_no_kill(self):
        send = Mock(side_effect=lambda pid, sig: self.rows.pop(pid))
        self.assertTrue(self.reap(send=send)[0]['ok'])
        self.assertEqual(send.call_count, 1)

    def test_identity_ownership_and_ancestor_change_before_each_signal(self):
        for phase in ['term', 'kill']:
            for change in ['start', 'args', 'ppid', 'tty', 'owner', 'ancestor']:
                with self.subTest(phase=phase, change=change):
                    self.setUp()
                    self.parent('claude')
                    report, send = self.detect(), Mock()
                    def mutate():
                        if change == 'owner': OWNER['thread']['state'] = 'running'
                        elif change == 'ancestor': self.rows[30]['start'] = 'reused'
                        else: self.row[change] = {'start': 'reused', 'args': 'node /other.js', 'ppid': 99, 'tty': 'ttys001'}[change]
                    with patch.dict(OWNER['thread']):
                        if phase == 'term': mutate()
                        self.reap(report, send=send, pause=lambda seconds: mutate())
                    self.assertEqual(send.call_count, 0 if phase == 'term' else 1)

    def test_pid_or_parent_reuse_after_api_read_not_signalled(self):
        for target in [42, 30]:
            with self.subTest(target=target):
                self.setUp()
                self.parent('claude')
                report, send = self.detect(), Mock()
                def observe():
                    rows = copy.deepcopy(self.rows)
                    rows[target]['start'] = 'reused'
                    return rows
                self.reap(report, rescan=lambda pid: report, observe=observe, send=send)
                send.assert_not_called()

    def test_flag_off_and_failed_report_do_not_signal(self):
        send = Mock()
        with patch.dict(os.environ, DEV_JANITOR_REAP_MCP_ORPHAN='0'):
            self.assertFalse(self.detect()['reap_enabled'])
            self.assertEqual(self.reap(send=send), [])
        report = self.detect()
        report['problems'] = ['incomplete']
        self.assertEqual(self.reap(report, send=send), [])
        send.assert_not_called()

    def test_exiting_ps_row_no_crash_or_match(self):
        with patch.object(lp, 'run', return_value=f'42 1 {self.start} ?? 0:00.00 0 (node)'):
            rows = lp.cpu_processes()
        self.assertEqual(lp.detect_mcp_orphans(rows, ROSTER, {})['inventory'], [])

    def test_redaction_audit_and_generic_scan_failure_report(self):
        self.row['args'] += ' --token secret-value'
        report = self.detect()
        self.assertNotIn('secret-value', json.dumps(report))
        state = {'processes': {'mcp_orphan': report}}
        with patch.object(lp, 'reap_mcp_orphans', return_value=[dict(pid=42, ok=True)]), patch.object(dev_janitor, 'audit') as audit:
            dev_janitor.reap_mcp_candidates(state)
        self.assertEqual(audit.call_args.args[0]['event'], 'mcp_orphan')
        with patch.object(lp, 'scan_mcp_orphans', return_value=report), patch.object(lp, 'processes', side_effect=RuntimeError):
            scan = lp.scan(ROSTER)
        self.assertEqual(lp.report_summary(scan)['mcp_orphan'], report)

    def test_hourly_success_and_failure_counts(self):
        import janitor_watch
        for ok in [True, False]:
            with self.subTest(ok=ok), tempfile.TemporaryDirectory() as temp:
                base, report = Path(temp), self.detect()
                scan = dict(ts=123, resources=[], candidates=[], liveness_unavailable=None,
                            processes={**lp.detect({}, {}, {}, ROSTER), 'mcp_orphan': report})
                def reap(state): state['processes']['mcp_orphan']['actions'] = [dict(pid=42, action='reap', ok=ok)]
                with (base / 'lock').open('a+') as lock, patch.object(janitor_watch, 'STATE_DIR', base), patch.object(dev_janitor, 'scan', return_value=scan), patch.object(dev_janitor, 'reap_mcp_candidates', side_effect=reap), patch.object(dev_janitor, 'record_report') as record, patch.object(dev_janitor, 'log_run') as log:
                    self.assertEqual(janitor_watch.worker(lock.fileno()), 0 if ok else 1)
                    self.assertEqual(record.call_args.args[0]['processes']['mcp_orphan']['actions'][0]['ok'], ok)
                    self.assertEqual(log.call_args.args[1:], (1, int(ok), ok))

    def test_shared_service_subcommand_argument_class(self):
        # Global option forms: split/equals values, short/long, repeated, flags,
        # and the option terminator. A service token always wins over bindings.
        forms = ['codex app-server', 'codex -c model="x" app-server',
                 'codex --config=model="x" app-server', 'codex --model x app-server',
                 'codex -m x app-server', 'codex --profile x app-server',
                 'codex -p x -c a=b -c c=d app-server', 'codex --offline app-server',
                 'codex -- app-server', '/Users/test/.robob/tools/codex -c x=y app-server',
                 'opencode --port 49374 serve', 'opencode --log-level debug serve']
        for command in forms:
            for depth in [1, 2]:
                with self.subTest(command=command, depth=depth):
                    self.setUp()
                    self.parent(command)
                    if depth == 2:
                        self.rows[20] = {**self.rows.pop(30), 'pid': 20}
                        self.parent('claude')
                        self.rows[30]['ppid'] = 20
                    self.assertEqual(self.detect()['candidates'], [])

    def test_ancestor_keep_entries_win_over_shared_directory_relaxation(self):
        self.parent('/Users/test/.robob/tools/claude')
        for keep in [['30'], ['/Users/test/.robob/tools/claude'], ['/Users/test/.robob']]:
            with self.subTest(keep=keep):
                self.assertEqual(self.detect(keep=keep)['candidates'], [])

    def test_first_owner_resumed_by_later_inventory_owner_is_rechecked_for_action(self):
        second = {**self.row, 'pid': 43}
        self.rows[43] = second
        owners = {'42': copy.deepcopy(OWNER), '43': copy.deepcopy(OWNER)}
        owners['43']['thread']['threadId'] = 'second'
        binding = lambda pid: {'T3_THREAD_ID': str(pid)}
        def census_resolve(value):
            if value['T3_THREAD_ID'] == '43': owners['42']['thread']['state'] = 'running'
            return copy.deepcopy(owners[value['T3_THREAD_ID']])
        report = self.detect(binding=binding, resolve=census_resolve)
        self.assertIn(42, [item['pid'] for item in report['candidates']])
        send = Mock()
        self.reap(report, send=send, rescan=lambda pid: self.detect(target_pid=pid, binding=binding,
            resolve=lambda value: copy.deepcopy(owners[value['T3_THREAD_ID']])))
        self.assertNotIn(42, [call.args[0] for call in send.call_args_list])

    def test_complete_roster_read_after_owner_queries_catches_resumed_work(self):
        self.parent('claude')
        resumed = copy.deepcopy(ROSTER)
        resumed['threads'] = {'owner': {'threadId': 'owner', 'state': 'running'}}
        for fresh in [resumed, {**ROSTER, 'complete': False}]:
            with self.subTest(roster=fresh):
                send = Mock()
                self.reap(send=send, rescan=lambda pid: self.detect(target_pid=pid, refresh_roster=lambda: fresh))
                send.assert_not_called()
        send = Mock()
        self.reap(send=send, rescan=lambda pid: self.detect(target_pid=pid, refresh_roster=Mock(side_effect=OSError)))
        send.assert_not_called()

    def test_targeted_scan_linear_owner_lookup_count(self):
        for count in [1, 3, 6]:
            with self.subTest(count=count):
                self.setUp()
                self.rows.update({pid: {**self.row, 'pid': pid} for pid in range(43, 42 + count)})
                report = self.detect()
                resolve = Mock(side_effect=lambda value: copy.deepcopy(OWNER))
                self.reap(report, rescan=lambda pid: self.detect(target_pid=pid, resolve=resolve))
                self.assertEqual(resolve.call_count, count * 2)

    def test_scan_production_targeted_roster_refresh_and_action_budget(self):
        with patch.object(lp, 'cpu_processes', return_value=self.rows), patch.object(lp, 'launch_services', return_value={}), patch.object(lp, 'detect_mcp_orphans', return_value={}) as detect:
            lp.scan_mcp_orphans(ROSTER, target_pid=42, refresh_roster=lambda: ROSTER, deadline=123)
        self.assertEqual(detect.call_args.kwargs['target_pid'], 42)
        self.assertEqual(detect.call_args.kwargs['deadline'], 123)
        report, send = self.detect(), Mock()
        with patch.object(lp.time, 'monotonic', side_effect=[0, lp.OBSERVATION_BUDGET + 1]):
            self.reap(report, send=send)
        send.assert_not_called()
