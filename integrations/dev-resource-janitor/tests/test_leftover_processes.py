import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from janitor_test_safety import JanitorTestCase
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
OPAQUE_RELATIVE_TOKENS = [
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY=',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY==',
    'wJalrXUtnFEMI_K7MDENG/bPxRfiCYEXAMPLEKEY',
    'wJalrXUtnFEMI-K7MDENG/bPxRfiCYEXAMPLEKEY',
    'AbC+/012' * 5,
    'abcdefghijklmnopqrst/uvwxyzabcdefghijklm',
    '0123456789abcdef/0123456789abcdef/01234567',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature/opaque',
    'project/packages/server/scripts/serve',
]


class ProcessTests(JanitorTestCase):
    def test_mcp_summary_counts_rss_parent_chains_and_unknown_verdict(self):
        def row(pid, ppid, args, rss):
            return dict(pid=pid, ppid=ppid, start='old', tty='??', args=args, rss_kib=rss)
        rows = {r['pid']: r for r in (
            row(1, 0, '/sbin/launchd', 1), row(10, 1, '/bin/codex app-server', 100),
            row(11, 1, '/bin/claude --session-id private', 100), row(12, 1, '/bin/opencode serve', 100),
            row(13, 10, '/bin/sh wrapper.sh', 1), row(14, 1, '/bin/unrelated', 1),
            row(20, 13, 'cua-driver mcp --token secret-value', 1024),
            row(21, 11, 'node /private/path/perplexity-mcp/server.js', 2048),
            row(22, 12, 'node /private/path/dia-agent-bridge/server.js', 4096),
            row(23, 1, 'node /private/path/other-mcp/server.js', 512),
            row(24, 14, 'cua-driver mcp', 256))}
        report = lp.detect(rows, {}, {}, ROSTER, inspect=lambda r: DETAILS, resolve=lambda b: None)
        summary = report['mcp_summary']
        self.assertEqual(summary['families'], {
            'cua-driver': dict(count=2, rss_kib=1280, rss_unavailable=0),
            'perplexity': dict(count=1, rss_kib=2048, rss_unavailable=0),
            'dia-bridge': dict(count=1, rss_kib=4096, rss_unavailable=0),
            'other-mcp': dict(count=1, rss_kib=512, rss_unavailable=0)})
        self.assertEqual(summary['parent_kinds'], {kind: 1 for kind in
            ('codex-app-server', 'claude-cli', 'opencode-serve', 'ppid-1', 'other')})
        self.assertEqual(summary['keep_reasons'], {'unknown_owner': 4, 'unproven_process': 1})
        self.assertEqual(summary['unknown_owner'], 4)
        self.assertEqual(summary['verdict'], 'unverified')
        self.assertTrue(summary['report_only'])
        self.assertEqual(summary['candidates'], 0)
        for private in ('secret-value', '/private/path', 'wrapper.sh', 'session-id', 'command'):
            self.assertNotIn(private, json.dumps(summary))
        print('MCP_SUMMARY_SAMPLE=' + json.dumps(summary, sort_keys=True))

    def test_summary_failure_clean_budget_and_liveness_matrix(self):
        rows = lp.parse_ps(PS)
        rows[91129]['args'] = 'cua-driver mcp'
        for label, kwargs, verdict, reason in (
                ('protected', {'keep': ['cua-driver']}, 'clean', 'keep_file'),
                ('unknown', {'resolve': lambda b: None}, 'unverified', 'unknown_owner'),
                ('failure', {'inspect': lambda r: (_ for _ in ()).throw(RuntimeError('password=private'))},
                 'unverified', 'observation_unavailable'),
                ('budget', {'deadline': -1}, 'unverified', 'observation_budget_exhausted'),
                ('liveness', {'roster': {**ROSTER, 'complete': False, 'problems': ['private']}},
                 'unverified', 'liveness_unavailable')):
            params = dict(rows=rows, memory={}, labels={}, roster=ROSTER,
                          inspect=lambda r: DETAILS, resolve=lambda b: None)
            params.update(kwargs)
            with self.subTest(label=label):
                report = lp.detect(**params)
                summary = report['mcp_summary']
                self.assertEqual(summary['verdict'], verdict)
                self.assertEqual(summary['keep_reasons'], {reason: 1})
                self.assertEqual(summary['observation_unavailable'], int(label == 'failure'))
                self.assertEqual(summary['families']['cua-driver']['rss_unavailable'], 1)
                self.assertNotIn('private', json.dumps(summary))
        self.assertEqual(lp.detect({}, {}, {}, ROSTER)['mcp_summary']['verdict'], 'clean')

    def test_summary_protected_services_and_verified_candidates_keep_existing_labels(self):
        for command, reason, count in (
                ('cua-driver serve --port 8800', 'shared_service', 0),
                ('cua-driver mcp', None, 1)):
            rows = lp.parse_ps(PS)
            rows[91129].update(args=command, rss_kib=1024)
            report = self.detect(rows=rows)
            summary = report['mcp_summary']
            self.assertEqual(summary['families']['cua-driver']['count'], 1)
            self.assertEqual(summary['keep_reasons'], {reason: 1} if reason else {})
            self.assertEqual(summary['candidates'], count)
            self.assertEqual(len(report['candidates']), count)
            self.assertEqual(summary['verdict'], 'clean')

    def test_summary_family_command_forms_do_not_count_dia_guard_or_flag_mentions(self):
        forms = [
            ('/usr/bin/cua-driver mcp', 'cua-driver'),
            ('cua-driver serve --port 8800', 'cua-driver'),
            ('node /package/perplexity-mcp/dist/index.js', 'perplexity'),
            ('node /package/@perplexity-ai/mcp-server/dist/index.js', 'perplexity'),
            ('node --max-semi-space-size=1 /package/dia-agent-bridge/src/server.js', 'dia-bridge'),
            ('node /package/dia-mcp/dist/index.js', 'dia-bridge'),
            ('node /package/dia-agent-bridge/src/log-launcher.js guard', None),
            ('node /package/dia-agent-bridge/src/guard.js', None),
            ('node ordinary.js --name perplexity-mcp', None),
            ('node ordinary.js --note "cua-driver mcp"', None),
            ('node /package/other-mcp/server.js', 'other-mcp'),
            ('npx -y @example/mcp-server', 'other-mcp'),
            ('"unterminated', None),
        ]
        for command, expected in forms:
            with self.subTest(command=command):
                self.assertEqual(lp.mcp_family(command), expected)

    def test_inventory_failure_summary_is_explicit_and_has_no_exception_text(self):
        with patch.object(lp, 'processes', side_effect=RuntimeError('secret-value')):
            report = lp.scan(ROSTER)
        summary = report['mcp_summary']
        self.assertFalse(summary['ok'])
        self.assertTrue(summary['report_only'])
        self.assertEqual(summary['verdict'], 'unverified')
        self.assertEqual(summary['reason'], 'process_inventory_unavailable')
        self.assertNotIn('secret-value', json.dumps(summary))
        self.assertIn('inventory', report['phase_ms'])

    def test_verdict_matrix_for_every_keep_reason(self):
        clean = ['tty', 'launchd_registered', 'application', 'shared_service', 'keep_file',
                 'owner_deleted', 'owner_has_work_or_not_ended', 'connected_client', 'idle_grace']
        unverified = ['unknown_owner', 'observation_unavailable: RuntimeError: private',
                      'observation_budget_exhausted', 'liveness_unavailable', 'unproven_process',
                      'memory_unavailable', 'parent_chain_incomplete', 'changed_before_report']
        for reasons, verdict in ((clean, 'clean'), (unverified, 'unverified')):
            for reason in reasons:
                with self.subTest(reason=reason):
                    inventory = [dict(mcp_family='cua-driver', parent_kind='other', rss_kib=1024,
                                      candidate=False, keep_reason=reason)]
                    report = dict(inventory=inventory, problems=[], owner_calls=lp.owner_call_summary({}))
                    summary = lp.mcp_summary(report)
                    self.assertEqual(summary['verdict'], verdict)
                    self.assertEqual(summary['keep_reasons'], {reason.split(':', 1)[0]: 1})
                    self.assertNotIn('private', json.dumps(summary))

    def test_incomplete_final_observations_are_unverified_in_detect(self):
        rows = lp.parse_ps(PS)
        rows[91129]['args'] = 'cua-driver mcp'
        for mode in ('memory_unavailable', 'parent_chain_incomplete', 'changed_before_report'):
            params = dict(rows=rows, memory=lp.parse_top(TOP), labels={}, roster=ROSTER,
                          inspect=lambda row: copy.deepcopy(DETAILS), resolve=lambda b: copy.deepcopy(OWNER),
                          refresh=lambda pid: {pid: {**rows[pid], 'start': 'changed'}},
                          refresh_roster=lambda: ROSTER, now=1794787200)
            if mode == 'memory_unavailable':
                params['memory'] = {}
            elif mode == 'parent_chain_incomplete':
                params['rows'] = {91129: rows[91129]}
            with self.subTest(mode=mode):
                report = lp.detect(**params)
                self.assertEqual(report['inventory'][0]['keep_reason'], mode)
                self.assertEqual(report['mcp_summary']['verdict'], 'unverified')
                self.assertEqual(report['candidates'], [])

    def test_existing_ps_call_carries_rss_without_using_it_as_identity(self):
        raw = PS.replace('?? /', '?? 4096 /')
        with patch.object(lp, 'run', return_value=raw) as run:
            rows = lp.processes()
        self.assertIn('rss=', run.call_args.args[0][-1])
        self.assertEqual(rows[91129]['rss_kib'], 4096)
        report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER,
                           inspect=lambda r: copy.deepcopy(DETAILS), resolve=lambda b: copy.deepcopy(OWNER),
                           refresh=lambda pid: {pid: {**rows[pid], 'rss_kib': 8192}},
                           refresh_roster=lambda: ROSTER, now=1794787200)
        self.assertEqual(len(report['candidates']), 1)
        self.assertTrue(report['report_only'])

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
            './project/packages/server/scripts/serve',
            'project/.cache/scripts/development-server',
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

    def test_ambiguous_relative_tokens_still_redact(self):
        for token in OPAQUE_RELATIVE_TOKENS:
            for quote in ('', '"', "'"):
                with self.subTest(token=token, quote=quote):
                    self.assertEqual(lp.redact(f'node tool.js {quote}{token}{quote}'),
                                     f'node tool.js {quote}[REDACTED]{quote}')

    def test_saved_report_redacts_ambiguous_tokens_in_inventory_and_ancestors(self):
        import dev_janitor
        for token in OPAQUE_RELATIVE_TOKENS:
            for quote in ('', '"', "'"):
                with self.subTest(token=token, quote=quote):
                    rows = lp.parse_ps(PS)
                    child = rows[91129]
                    child.update(ppid=10, tty='ttys001', args=f'node tool.js {quote}{token}{quote}')
                    rows[10] = dict(pid=10, ppid=1, start=child['start'], tty='ttys001',
                                    args=f'/bin/sh -c "node tool.js {quote}{token}{quote}"')
                    report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER)
                    item = report['inventory'][0]
                    self.assertEqual(item['command'], f'node tool.js {quote}[REDACTED]{quote}')
                    self.assertEqual(item['parent_chain'][0]['command'],
                                     f'/bin/sh -c "node tool.js {quote}[REDACTED]{quote}"')
                    with tempfile.TemporaryDirectory() as tmp, \
                            patch.object(dev_janitor, 'LOG_DIR', tmp), \
                            patch.object(dev_janitor, 'LAST', str(Path(tmp) / 'last.json')), \
                            patch.object(dev_janitor, 'AUDIT', str(Path(tmp) / 'audit.jsonl')):
                        dev_janitor.record_report(dict(ts=1, liveness_unavailable=None, processes=report))
                        for name in ('last.json', 'audit.jsonl'):
                            saved = (Path(tmp) / name).read_text()
                            self.assertNotIn(token, saved)
                            if name == 'last.json':
                                self.assertIn('[REDACTED]', saved)

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
        responses = [{'thread': OWNER['thread']}, {'thread': OWNER['thread']},
                     {'threads': [{'threadId': 'owne0'}, {'threadId': 'owne1'},
                                  {'threadId': 'owner', **OWNER['recovery']}], 'nextCursor': 'owner'}]
        with patch.object(lp, 'control', side_effect=responses) as api, \
                patch.object(lp, 'RECOVERY_PAGE_LIMIT', 3):
            result = lp.owner({'CLAUDE_CODE_SESSION_ID': 'native'})
            self.assertEqual(result['thread'], OWNER['thread'])
            self.assertEqual(result['recovery']['heldWork'], False)
            self.assertTrue(lp.owner_clear(result, ROSTER))
            self.assertEqual(parse_qs(urlsplit(api.call_args_list[2].args[0]).query),
                             {'active': ['false'], 'cursor': ['owne'], 'limit': [str(lp.RECOVERY_PAGE_LIMIT)]})
        self.assertIn('driver=claudeAgent', api.call_args_list[0].args[0])
        self.assertIn('&view=owner', api.call_args_list[0].args[0])

    def test_owner_absent_from_recovery_page_stays_unknown_and_keeps_process(self):
        pages = [[], [{'threadId': f'other-{i}'} for i in range(lp.RECOVERY_PAGE_LIMIT)]]
        for entries in pages:
            responses = [(200, {'ok': True, **body}) for body in (
                {'thread': OWNER['thread']}, {'thread': OWNER['thread']},
                {'threads': entries, 'nextCursor': 'more-threads'})]
            with self.subTest(rows=len(entries)), patch.object(lp.active_sessions, '_control_get',
                    side_effect=responses * 2) as api:
                self.assertIsNone(lp.owner(DETAILS['binding']))
                report = lp.detect(lp.parse_ps(PS), lp.parse_top(TOP), {}, ROSTER,
                                   inspect=lambda row: DETAILS)
                self.assertEqual(report['candidates'], [])
                self.assertEqual(report['inventory'][0]['keep_reason'], 'unknown_owner')
                self.assertEqual(api.call_count, 6)
                self.assertEqual(parse_qs(urlsplit(api.call_args.args[0]).query),
                                 {'active': ['false'], 'cursor': ['owne'],
                                  'limit': [str(lp.RECOVERY_PAGE_LIMIT)]})

    def test_recovery_timeout_or_failure_keeps_process(self):
        for status, body in ((0, 'timed out'), (503, None)):
            responses = [(200, {'ok': True, 'thread': OWNER['thread']})] * 2 + [(status, body)]
            with self.subTest(status=status), patch.object(lp.active_sessions, '_control_get',
                    side_effect=responses):
                report = lp.detect(lp.parse_ps(PS), lp.parse_top(TOP), {}, ROSTER,
                                   inspect=lambda row: DETAILS)
                self.assertEqual(report['candidates'], [])
                self.assertTrue(report['inventory'][0]['keep_reason'].startswith('observation_unavailable:'))
                self.assertEqual(report['owner_calls']['recovery']['failures'], {str(status): 1})

    def test_owner_view_keep_matrix_never_reads_detail_or_recovery(self):
        forms = [
            ({'state': 'running', 'status': 'completed'}, 'owner_has_work_or_not_ended'),
            ({'state': 'idle', 'status': 'running'}, 'owner_has_work_or_not_ended'),
            ({'state': 'idle', 'status': 'queued'}, 'owner_has_work_or_not_ended'),
            ({'status': 'completed'}, 'owner_has_work_or_not_ended'),
            ({'state': 'idle'}, 'owner_has_work_or_not_ended'),
            ({'state': None, 'status': None}, 'owner_has_work_or_not_ended'),
            ({'state': 'idle', 'status': 'completed', 'deleted': True}, 'owner_deleted'),
            ({'state': 'running', 'status': 'running', 'deleted': True}, 'owner_deleted'),
        ]
        for view, reason in forms:
            with self.subTest(view=view), patch.object(lp.active_sessions, '_control_get',
                    return_value=(200, {'ok': True, 'thread': {'threadId': 'owner', **view}})) as api:
                report = lp.detect(lp.parse_ps(PS), lp.parse_top(TOP), {}, ROSTER,
                                   inspect=lambda row: DETAILS)
                self.assertEqual(report['candidates'], [])
                self.assertEqual(report['inventory'][0]['owner'], 'owner')
                self.assertEqual(report['inventory'][0]['keep_reason'], reason)
                self.assertEqual(api.call_count, 1)
                self.assertEqual(report['owner_calls']['by_native']['count'], 1)
                self.assertEqual(report['owner_calls']['detail']['count'], 0)
                self.assertEqual(report['owner_calls']['recovery']['count'], 0)

    def test_owner_view_urls_for_both_native_drivers(self):
        for key, driver in lp.NATIVE_KEYS.items():
            with self.subTest(key=key), patch.object(lp, 'control', return_value={
                    'thread': {'threadId': 'owner', 'state': 'running'}}) as api:
                lp.owner({key: 'native/id:%'})
                self.assertEqual(api.call_args.args[0],
                    '/threads/by-native/native%2Fid%3A%25?driver=' + driver + '&view=owner')

    def test_owner_view_conflicting_bindings_stay_unknown(self):
        for deleted in (False, True):
            view = {'threadId': 'owner', 'state': 'running', 'deleted': deleted}
            forms = [
                ({'CLAUDE_CODE_SESSION_ID': 'a', 'T3_THREAD_ID': 'other'}, [view]),
                ({'CLAUDE_CODE_SESSION_ID': 'a', 'CODEX_THREAD_ID': 'b'},
                 [view, {**view, 'threadId': 'other'}]),
                ({'T3_THREAD_ID': 'owner', 'ROBOB_THREAD_ID': 'other'}, []),
            ]
            for binding, views in forms:
                with self.subTest(binding=binding, deleted=deleted), patch.object(lp, 'control',
                        side_effect=[{'thread': v} for v in views]) as api:
                    self.assertIsNone(lp.owner(binding))
                    self.assertEqual(api.call_count, len(views))

    def test_idle_terminal_view_still_requires_full_clear_proof(self):
        for status in sorted(lp.TERMINAL):
            for held in (False, True):
                own = copy.deepcopy(OWNER)
                own['thread']['status'] = status
                own['recovery']['heldWork'] = held
                responses = [(200, {'ok': True, **body}) for body in (
                    {'thread': own['thread']}, {'thread': own['thread']},
                    {'threads': [{'threadId': 'owner', **own['recovery']}]})]
                rows = lp.parse_ps(PS)
                with self.subTest(status=status, held=held), patch.object(lp.active_sessions, '_control_get',
                        side_effect=responses * 2) as api:
                    report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER,
                        inspect=lambda row: DETAILS, refresh=lambda pid: {pid: rows[pid]},
                        refresh_roster=lambda: ROSTER)
                    self.assertEqual(len(report['candidates']), 0 if held else 1)
                    self.assertEqual(api.call_count, 3 if held else 6)
                    for call in api.call_args_list:
                        self.assertEqual(call.kwargs, {'timeout': lp.OWNER_CALL_TIMEOUT})

    def test_final_recheck_keep_marker_cannot_match_clear_owner(self):
        for view in ({'state': 'running'}, {'deleted': True}):
            responses = [{'thread': OWNER['thread']}, {'thread': OWNER['thread']},
                         {'threads': [{'threadId': 'owner', **OWNER['recovery']}]},
                         {'thread': {**OWNER['thread'], **view}}]
            rows = lp.parse_ps(PS)
            with self.subTest(view=view), patch.object(lp, 'control', side_effect=responses) as api:
                report = lp.detect(rows, lp.parse_top(TOP), {}, ROSTER,
                    inspect=lambda row: DETAILS, refresh=lambda pid: {pid: rows[pid]},
                    refresh_roster=lambda: ROSTER)
                self.assertEqual(report['candidates'], [])
                self.assertEqual(report['inventory'][0]['keep_reason'], 'changed_before_report')
                self.assertEqual(api.call_count, 4)

    def test_owner_call_counts_percentiles_and_failure_statuses(self):
        idle = {'ok': True, 'thread': OWNER['thread']}
        script = iter([
            (10, 200, {'ok': True, 'thread': {'threadId': 'owner', 'state': 'running'}}),
            (20, 200, idle), (100, 503, None),
            (30, 200, idle), (200, 200, idle), (1000, 0, None),
            (40, 404, None), (50, 200, {'ok': False}),
            (60, 200, idle), (300, 200, idle), (2000, 200, {'ok': True, 'threads': []}),
            (70, 200, idle), (400, 200, idle),
            (3000, 200, {'ok': True, 'threads': [{'threadId': 'owner', **OWNER['recovery']}]}),
        ])
        clock = [0]
        def api(path, timeout):
            duration, status, body = next(script)
            clock[0] += duration / 1000
            return status, body
        rows = {pid: {'pid': pid, 'ppid': 1, 'start': 'old', 'tty': '??',
                      'args': 'python3 -m http.server'} for pid in range(20, 27)}
        with patch.object(lp.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(lp.active_sessions, '_control_get', side_effect=api):
            report = lp.detect(rows, {}, {}, ROSTER, keep=[DETAILS['cwd']],
                inspect=lambda row: {**DETAILS, 'binding': {'CODEX_THREAD_ID': str(row['pid'])}})
        self.assertEqual(report['owner_calls'], {
            'by_native': dict(count=7, p50_ms=40, p95_ms=70, max_ms=70,
                              failures={'404': 1, '200': 1}),
            'detail': dict(count=4, p50_ms=200, p95_ms=400, max_ms=400, failures={'503': 1}),
            'recovery': dict(count=3, p50_ms=2000, p95_ms=3000, max_ms=3000, failures={'0': 1}),
        })
        self.assertEqual(report['mcp_summary']['owner_calls'], report['owner_calls'])
        self.assertEqual(report['phase_ms']['owner_recovery'], 6000)
        self.assertEqual(report['candidates'], [])

    def test_owner_call_metrics_are_per_scan_and_include_only_actual_cached_calls(self):
        rows = {pid: {'pid': pid, 'ppid': 1, 'start': 'old', 'tty': '??',
                      'args': 'python3 -m http.server'} for pid in (20, 30)}
        with patch.object(lp.active_sessions, '_control_get', return_value=(200, {
                'ok': True, 'thread': {'threadId': 'owner', 'state': 'running'}})) as api:
            for _ in range(2):
                report = lp.detect(rows, {}, {}, ROSTER, inspect=lambda row: DETAILS)
                self.assertEqual(report['checked'], 2)
                self.assertEqual(report['owner_calls']['by_native']['count'], 1)
            self.assertEqual(api.call_count, 2)

    def test_owner_call_exception_is_counted_as_status_zero(self):
        with patch.object(lp.active_sessions, '_control_get', side_effect=OSError('unavailable')), \
                patch.object(lp.time, 'monotonic', side_effect=[0, .025]):
            report = lp.detect(lp.parse_ps(PS), {}, {}, ROSTER, inspect=lambda row: DETAILS)
        self.assertEqual(report['owner_calls']['by_native'],
                         dict(count=1, p50_ms=25, p95_ms=25, max_ms=25, failures={'0': 1}))
        self.assertEqual(report['candidates'], [])

    def test_scan_uses_budget_constant_and_keeps_empty_metrics_on_inventory_failure(self):
        with patch.object(lp, 'processes', return_value={}), \
                patch.object(lp, 'launch_services', return_value={}), \
                patch.object(lp, 'run', return_value=TOP), \
                patch.object(lp, 'cwd_inventory', return_value={}), \
                patch.object(lp, 'detect', return_value={}) as detect, \
                patch.object(lp.time, 'monotonic', return_value=100), \
                patch.object(lp, 'OBSERVATION_BUDGET', 321):
            lp.scan(ROSTER, cursor=42)
            self.assertEqual(detect.call_args.kwargs['deadline'], 421)
            self.assertEqual(detect.call_args.kwargs['cursor'], 42)
        with patch.object(lp, 'processes', side_effect=RuntimeError):
            report = lp.scan(ROSTER)
        self.assertEqual(report['owner_calls'], {kind: dict(count=0, p50_ms=None,
                         p95_ms=None, max_ms=None, failures={}) for kind in lp.OWNER_ENDPOINTS})

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

    def test_signal_primitive_is_only_in_opt_in_stop_and_deletion_stays_forbidden(self):
        import ast
        tree = ast.parse(Path(lp.__file__).read_text())
        forbidden = {'kill', 'killpg', 'unlink', 'remove', 'rmdir', 'rmtree'}
        stop = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'stop_xcode_builds')
        send_default = stop.args.kw_defaults[stop.args.kwonlyargs.index(
            next(arg for arg in stop.args.kwonlyargs if arg.arg == 'send'))]
        self.assertIsInstance(send_default, ast.Attribute)
        self.assertEqual(ast.unparse(send_default), 'os.kill')
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node is not send_default:
                self.assertNotIn(node.attr, forbidden)


if __name__ == '__main__':
    unittest.main()
