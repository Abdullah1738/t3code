import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import leftover_processes as lp

PS = '''    1     0 Sat Nov 14 01:00:00 2026 ?? /sbin/launchd
91129     1 Thu Nov 12 14:23:13 2026 ?? /opt/python/Python.app/Contents/MacOS/Python -m http.server 8765 --password topsecret
'''
TOP = '''PID COMMAND MEM CMPRS
91129 Python 17M 15M
'''
ROSTER = dict(complete=True, threads={}, opencode=set(), problems=[])
OWNER = {'thread': {'threadId': 'owner', 'state': 'idle', 'status': 'completed', 'settled': True,
                    'activeRunId': None, 'pendingRequests': [], 'updatedAt': '2026-11-12T00:00:00Z'},
         'recovery': {'pendingRequests': [], 'runtime': 'present', 'heldWork': False,
                      'run': {'status': 'completed'}, 'children': []}}
DETAILS = dict(cwd='/private/tmp/benchmark-deleted', cwd_exists=False,
               listeners=['192.168.1.209:8765'], tcp_states=['LISTEN'],
               binding={'CLAUDE_CODE_SESSION_ID': 'native-owner'})


class ProcessTests(unittest.TestCase):
    def detect(self, rows=None, roster=None, owner=None, details=None, **kwargs):
        rows = lp.parse_ps(PS) if rows is None else rows
        return lp.detect(rows, lp.parse_top(TOP), {}, ROSTER if roster is None else roster,
                         inspect=lambda row: copy.deepcopy(DETAILS if details is None else details),
                         resolve=lambda binding: copy.deepcopy(OWNER if owner is None else owner),
                         refresh=lambda pid: {pid: rows[pid]}, refresh_roster=lambda: ROSTER,
                         now=1794787200, **kwargs)

    def test_a_settled_owner_deleted_cwd_http_server_is_one_report_only_candidate(self):
        report = self.detect()
        self.assertEqual([r['pid'] for r in report['candidates']], [91129])
        candidate = report['candidates'][0]
        self.assertEqual(candidate['memory'], {'mem': '17M', 'cmprs': '15M'})
        self.assertIn('deleted_cwd', candidate['evidence'])
        self.assertEqual(candidate['parent_chain'][0]['pid'], 1)
        self.assertNotIn('topsecret', json.dumps(report))
        self.assertTrue(report['report_only'])

    def test_b_live_owner_is_kept(self):
        own = copy.deepcopy(OWNER)
        own['thread']['state'] = 'running'
        self.assertEqual(self.detect(owner=own)['candidates'], [])

    def test_c_unmapped_cua_stdio_child_is_unknown_and_kept(self):
        rows = lp.parse_ps(PS.replace('/opt/python/Python.app/Contents/MacOS/Python -m http.server 8765 --password topsecret', 'cua-driver mcp'))
        report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER, inspect=lambda r: DETAILS,
                           resolve=lambda b: None)
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['inventory'][0]['keep_reason'], 'unknown_owner')

    def test_d_truncation_has_no_candidates_and_names_reason(self):
        roster = {**ROSTER, 'complete': False, 'problems': ['native roster truncated 500/900']}
        report = self.detect(roster=roster)
        self.assertEqual(report['candidates'], [])
        self.assertIn('truncated', report['problems'][0])

    def test_e_ppid_one_node_with_tty_is_kept(self):
        rows = lp.parse_ps(PS.replace('?? /opt/python/Python.app/Contents/MacOS/Python -m http.server 8765 --password topsecret', 'ttys001 node /tmp/server.js'))
        report = self.detect(rows=rows)
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['inventory'][0]['keep_reason'], 'tty')

    def test_owner_held_work_children_queue_and_missing_fields_keep(self):
        forms = [('heldWork', True), ('runtime', 'unknown'), ('children', [{'status': 'running'}]),
                 ('run', {'status': 'queued'}), ('pendingRequests', [{'id': 'q'}])]
        for key, value in forms:
            with self.subTest(key=key):
                own = copy.deepcopy(OWNER)
                own['recovery'][key] = value
                self.assertEqual(self.detect(owner=own)['candidates'], [])
        own = copy.deepcopy(OWNER)
        del own['thread']['activeRunId']
        self.assertEqual(self.detect(owner=own)['candidates'], [])

    def test_connected_clients_and_keep_file_keep(self):
        self.assertEqual(self.detect(details={**DETAILS, 'tcp_states': ['LISTEN', 'ESTABLISHED']})['candidates'], [])
        self.assertEqual(self.detect(keep=[DETAILS['cwd']])['candidates'], [])

    def test_service_app_and_queue_keep_list(self):
        commands = ['cua-driver serve', 'codex app-server', 'opencode serve',
                    'node /Applications/Robob.app/Contents/helper.js',
                    'node /Applications/Dia.app/Contents/helper.js', 'node telegram/worker.js',
                    'python3 offbox.py _bg-queue', 'node /Applications/Other.app/Contents/main.js']
        for command in commands:
            with self.subTest(command=command):
                row = {'pid': 20, 'ppid': 1, 'args': command, 'tty': '??'}
                self.assertIsNotNone(lp.keep_reason(row, [], {}, []))
        self.assertEqual(lp.keep_reason({'pid': 20, 'args': 'python job.py', 'tty': '??'}, [], {20: 'service'}, []), 'launchd_registered')

    def test_fresh_identity_owner_cwd_and_roster_must_match(self):
        rows = lp.parse_ps(PS)
        base = dict(rows=rows, memory=lp.parse_top(TOP), labels={}, roster=ROSTER,
                    inspect=lambda r: DETAILS, resolve=lambda b: OWNER,
                    refresh=lambda pid: {pid: {**rows[pid], 'start': 'new start'}},
                    refresh_roster=lambda: ROSTER)
        self.assertEqual(lp.detect(**base)['candidates'], [])
        base['refresh'] = lambda pid: {pid: rows[pid]}
        base['refresh_roster'] = lambda: {**ROSTER, 'complete': False, 'problems': ['API down']}
        report = lp.detect(**base)
        self.assertEqual(report['candidates'], [])
        self.assertIn('API down', report['problems'][0])

    def test_mcp_idle_grace_is_owner_activity_not_process_age(self):
        rows = lp.parse_ps(PS.replace('/opt/python/Python.app/Contents/MacOS/Python -m http.server 8765 --password topsecret', 'cua-driver mcp'))
        own = copy.deepcopy(OWNER)
        own['thread']['updatedAt'] = '2026-11-16T00:00:00Z'
        self.assertEqual(self.detect(rows=rows, owner=own)['candidates'], [])
        self.assertEqual(len(self.detect(rows=rows)['candidates']), 1)

    def test_command_redaction_forms(self):
        for form in ['--password abc', '--password="abc def"', "--password 'abc def'", '--api-key=abc',
                     '--key abc', 'API_TOKEN=abc', 'https://user:abc@site/', '?token=abc',
                     'Bearer abc', 'Authorization: Bearer abc', 'Authorization: Basic abc', 'Proxy-Authorization: Bearer abc', '{"api_key":"abc"}', '{"password": "abc def"}', 'sk-abc', 'ghp_abc', 'a' * 48]:
            with self.subTest(form=form):
                self.assertNotIn('abc', lp.redact(form))
                self.assertNotIn('a' * 48, lp.redact(form))

    def test_temporary_server_command_class(self):
        forms = {
            'python3 -m http.server 8765': True,
            'python3 -m package.serve': True,
            'python3 -m package.server': True,
            'python3 -m application.observer': False,
            'python3 -m package.preserve': False,
            'python3 -m myserver': False,
            'python3 -c "print(1)" -m http.server': False,
            'python3 script.py -m http.server': False,
            'python3 -- -m http.server': False,
            'python3 -W -m http.server': False,
            'python3 -X dev -m http.server': True,
            'python3 -I -B -m http.server': True,
            'python3 -Wignore -m http.server': True,
            'python3 -m tool -m http.server': False,
            'npx serve .': True,
            'node /project/node_modules/.bin/vite --host': True,
            'node /project/node_modules/next/dist/bin/next dev': True,
            'node /project/node_modules/next/dist/bin/next start': False,
            'python3 observer.py --note vite': False,
            'node observer.js --name "next dev"': False,
        }
        for command, expected in forms.items():
            with self.subTest(command=command):
                self.assertEqual(lp.temporary(command), expected)

    def test_supported_mcp_command_forms(self):
        for command in ('cua-driver mcp', 'node /skills/dia-agent-bridge/src/server.js',
                        'node /node_modules/@perplexity-ai/mcp-server/dist/index.js'):
            with self.subTest(command=command):
                self.assertTrue(lp.mcp(command))

    def test_owner_binding_and_recovery_api_shapes(self):
        responses = [{'thread': {'threadId': 'owner'}}, {'thread': OWNER['thread']},
                     {'threads': [{'threadId': 'owner', **OWNER['recovery']}], 'nextCursor': None}]
        with patch.object(lp, 'control', side_effect=responses) as api:
            result = lp.owner({'CLAUDE_CODE_SESSION_ID': 'native'})
            self.assertEqual(result['thread'], OWNER['thread'])
            self.assertEqual(result['recovery']['heldWork'], False)
        self.assertIn('driver=claudeAgent', api.call_args_list[0].args[0])
        self.assertIn('active=false', api.call_args_list[2].args[0])

    def test_observation_budget_keeps_remaining_processes(self):
        rows = lp.parse_ps(PS)
        with patch.object(lp.time, 'monotonic', return_value=100):
            report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER, deadline=99)
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['inventory'][0]['keep_reason'], 'observation_budget_exhausted')

    def test_likely_shapes_first_then_pid_cursor_rotation(self):
        rows = {pid: {'pid': pid, 'ppid': 10, 'start': 'old', 'tty': '??', 'args': 'cua-driver mcp'}
                for pid in (20, 30, 40, 50, 60)}
        rows[40]['ppid'] = 1
        rows[50]['args'] = 'python3 -m http.server'
        with patch.object(lp.os.path, 'exists', return_value=False):
            ordered, ranks = lp.ordered_processes(rows, 0, {60: '/deleted'})
        self.assertEqual([r['pid'] for r in ordered], [40, 50, 60, 20, 30])
        self.assertEqual(ranks, {40: 0, 50: 0, 60: 0, 20: 1, 30: 1})
        with patch.object(lp.os.path, 'exists', return_value=True):
            ordered, _ = lp.ordered_processes(rows, 0, {60: '/private/tmp/server'})
        self.assertEqual([r['pid'] for r in ordered[:3]], [40, 50, 60])

    def test_rotation_advances_past_checked_processes_and_budget_counts_are_exact(self):
        rows = {pid: {'pid': pid, 'ppid': 10, 'start': 'old', 'tty': '??', 'args': 'cua-driver mcp'}
                for pid in (20, 30, 40)}
        for cursor, expected in ((0, 20), (20, 30), (30, 40), (40, 20)):
            clock = [0]
            def inspect(row):
                clock[0] = 2
                return DETAILS
            with self.subTest(cursor=cursor), patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]):
                report = lp.detect(rows, {}, {}, ROSTER, inspect=inspect, resolve=lambda b: None,
                                   deadline=1, cursor=cursor)
            self.assertEqual(report['next_cursor'], {'priority': 1, 'pid': expected})
            self.assertEqual(report['checked'], 1)
            self.assertEqual(report['skipped'], 2)
            self.assertEqual(report['budget_skipped'], 2)
            self.assertEqual(report['candidates'], [])

    def test_urgent_checks_cannot_starve_later_urgent_or_ordinary_entries(self):
        rows = {pid: {'pid': pid, 'ppid': 10, 'start': 'old', 'tty': '??', 'args': 'cua-driver mcp'}
                for pid in (20, 30, 40, 50)}
        for pid in (20, 40, 50):
            rows[pid]['ppid'] = 1
        cursor, runs = 0, []
        for _ in range(4):
            clock, checked = [0], []
            def inspect(row):
                checked.append(row['pid'])
                clock[0] += 1
                return DETAILS
            with patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]):
                report = lp.detect(rows, {}, {}, ROSTER, inspect=inspect, resolve=lambda b: None,
                                   deadline=2, cursor=cursor)
            runs.append(checked)
            cursor = report['next_cursor']
        self.assertEqual(runs, [[20, 40], [50, 30], [20, 40], [50, 30]])

    def test_process_module_has_no_signal_or_delete_primitives(self):
        import ast
        tree = ast.parse(Path(lp.__file__).read_text())
        forbidden = {'kill', 'killpg', 'unlink', 'remove', 'rmdir', 'rmtree'}
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, forbidden)


if __name__ == '__main__':
    unittest.main()
