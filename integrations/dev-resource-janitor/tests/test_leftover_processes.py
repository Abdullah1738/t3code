import copy
import json
from pathlib import Path
import sys
import tempfile
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

    def test_uri_userinfo_shape_matrix(self):
        forms = [
            ('postgres://user:p7@db/app', 'postgres://[REDACTED]@db/app'),
            ('postgresql://user:p7@db/app', 'postgresql://[REDACTED]@db/app'),
            ('redis://user:p7@cache/0', 'redis://[REDACTED]@cache/0'),
            ('rediss://user:p7@cache/0', 'rediss://[REDACTED]@cache/0'),
            ('mysql://user:p7@db/app', 'mysql://[REDACTED]@db/app'),
            ('mongodb://user:p7@db/app', 'mongodb://[REDACTED]@db/app'),
            ('mongodb+srv://user:p7@db/app', 'mongodb+srv://[REDACTED]@db/app'),
            ('PoStGrEsQl://user:p7@db/app', 'PoStGrEsQl://[REDACTED]@db/app'),
            ('http://user:p7@host/path', 'http://[REDACTED]@host/path'),
            ('https://user:p7@host/path', 'https://[REDACTED]@host/path'),
            ('ftp://user:p7@host/path', 'ftp://[REDACTED]@host/path'),
            ('custom-v1.2://user:p7@host/path', 'custom-v1.2://[REDACTED]@host/path'),
            ('redis://:p7@cache/0', 'redis://[REDACTED]@cache/0'),
            ('redis://p7@cache/0', 'redis://[REDACTED]@cache/0'),
            ('postgres://user:p%37@db/app', 'postgres://[REDACTED]@db/app'),
            ("postgres://user:p'7@db/app", 'postgres://[REDACTED]@db/app'),
            ('postgres://user:p"7@db/app', 'postgres://[REDACTED]@db/app'),
            ("postgres://user:p!$&'()*+,;=7@db/app", 'postgres://[REDACTED]@db/app'),
            ('postgres://user:p@7@db/app', 'postgres://[REDACTED]@db/app'),
            ('postgres://user:p7@[::1]:5432/app', 'postgres://[REDACTED]@[::1]:5432/app'),
            ('postgres://db/app/user@item', 'postgres://db/app/user@item'),
            ('postgres://db?name=user@item', 'postgres://db?name=user@item'),
            ('postgres://db#user@item', 'postgres://db#user@item'),
        ]
        for source, expected in forms:
            for quote in ('', '"', "'"):
                with self.subTest(source=source, quote=quote):
                    command = f'node tool.js --dsn={quote}{source}{quote}'
                    self.assertEqual(lp.redact(command), f'node tool.js --dsn={quote}{expected}{quote}')

    def test_command_path_shape_matrix(self):
        paths = [
            '/Users/ardud/.local/share/foo/serve.py',
            '/opt/homebrew/Cellar/python@3.13/3.13.7/Frameworks/Python.framework/Versions/3.13/bin/python3.13',
            '~/projects/long-project-directory/scripts/serve.py',
            './projects/long-project-directory/scripts/serve.py',
            'node_modules/.bin/long-development-server',
            'project/packages/server/scripts/serve',
            'scripts/' + 'long-script-name-' * 3 + '.py',
            'a+b/long-module-directory/development-entrypoint.js',
            'project/a+b/scripts/development-entrypoint.js',
            'project/scripts/development+entrypoint.js',
        ]
        for path in paths:
            for quote in ('', '"', "'"):
                with self.subTest(path=path, quote=quote):
                    command = f'python3 {quote}{path}{quote} serve'
                    self.assertEqual(lp.redact(command), command)
        command = 'python3 -m http.server 8461 --directory /Users/ardud/.local/share/foo/public'
        self.assertEqual(lp.redact(command), command)

    def test_opaque_tokens_still_redact(self):
        tokens = ['0123456789abcdef' * 2 + '01234567',
                  'AbC012xy' * 5, 'AbC+/012' * 5,
                  'a' * 33 + '/bcdefg',
                  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature']
        for token in tokens:
            for quote in ('', '"', "'"):
                with self.subTest(token=token, quote=quote):
                    self.assertEqual(lp.redact(f'node tool.js {quote}{token}{quote}'),
                                     f'node tool.js {quote}[REDACTED]{quote}')

    def test_explicit_credentials_win_over_path_shape(self):
        values = ['a' * 40, '/Users/ardud/.local/share/credential-file',
                  '~/secrets/credential-file', './secrets/credential-file',
                  'node_modules/.bin/credential-file']
        for value in values:
            for flag in ('--token', '--password', '--key', '--auth'):
                for separator in ('=', ' '):
                    for quote in ('', '"', "'"):
                        with self.subTest(value=value, flag=flag, separator=separator, quote=quote):
                            redacted = lp.redact(f'node tool.js {flag}{separator}{quote}{value}{quote}')
                            self.assertNotIn(value, redacted)
                            self.assertIn('[REDACTED]', redacted)
        for prefix in ('sk-', 'ghp_', 'github_pat_', 'xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-'):
            for base in ('/tmp/', '~/secrets/', './secrets/', 'project/secrets/',
                         '/tmp/backup_', '~/secrets/backup_', './secrets/backup_',
                         'project/secrets/backup_', '/tmp/backup-', '/tmp/backup.'):
                with self.subTest(prefix=prefix, base=base):
                    self.assertEqual(lp.redact(f'node {base}{prefix}abc123/file.js'),
                                     f'node {base}[REDACTED]/file.js')

    def test_shell_delimiters_cannot_extend_a_path_exemption(self):
        token = '0123456789abcdef' * 2 + '01234567'
        for delimiter in (';', ';;', '&', '&&', '|', '||', '(', ')', '<', '>', '>>',
                          '`', '{', '}', '\n'):
            for quote in ('', '"', "'"):
                with self.subTest(delimiter=delimiter, quote=quote):
                    command = f'sh -c {quote}/usr/bin/node{delimiter}{token}{quote}'
                    self.assertEqual(lp.redact(command),
                                     f'sh -c {quote}/usr/bin/node{delimiter}[REDACTED]{quote}')

    def test_saved_report_redacts_non_http_userinfo_in_kept_process_and_ancestors(self):
        import dev_janitor
        for scheme in ('postgres', 'postgresql', 'redis', 'rediss', 'mysql', 'mongodb'):
            with self.subTest(scheme=scheme):
                rows = lp.parse_ps(PS)
                child = rows[91129]
                child.update(ppid=10, tty='ttys001', args=f'node tool.js {scheme}://child:p7@db:123/app')
                rows[10] = dict(pid=10, ppid=1, start=child['start'], tty='ttys001',
                                args=f'/bin/sh -c "node tool.js {scheme}://parent:q8@other/app"')
                report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER)
                item = report['inventory'][0]
                self.assertEqual(item['keep_reason'], 'tty')
                self.assertEqual(report['candidates'], [])
                self.assertIn(f'{scheme}://[REDACTED]@db:123/app', item['command'])
                self.assertIn(f'{scheme}://[REDACTED]@other/app', item['parent_chain'][0]['command'])
                with tempfile.TemporaryDirectory() as tmp, \
                        patch.object(dev_janitor, 'LOG_DIR', tmp), \
                        patch.object(dev_janitor, 'LAST', str(Path(tmp) / 'last.json')), \
                        patch.object(dev_janitor, 'AUDIT', str(Path(tmp) / 'audit.jsonl')):
                    dev_janitor.record_report(dict(ts=1, liveness_unavailable=None, processes=report))
                    saved = (Path(tmp) / 'last.json').read_text()
                for secret in ('child', 'parent:q8', 'p7', 'q8'):
                    self.assertNotIn(secret, saved)

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
