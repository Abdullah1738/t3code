"""Read-only notifier parser and helper-failure regression cases."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_triage import t


class HelperFailureTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.logs = self.root / 'logs'
        self.stack.enter_context(patch.dict(os.environ, {'ROBOB_TEST': '1', 'TOOLLOG_DIR': str(self.logs)}))
        self.stack.enter_context(patch.object(t, 'LIVE', self.root / 'live'))
        self.stack.enter_context(patch.object(t, 'BUN', shutil.which('bun') or t.BUN))
        self.stub = self.root / 'telegram-stub.ts'
        self.stack.enter_context(patch.dict(os.environ, {'ROBOB_WATCH_TELEGRAM_CLI': str(self.stub)}))
        cli = Path(__file__).resolve().parents[3] / 'telegram-bridge/src/cli.ts'
        # Parse actual argv without calling the bridge's socket/request code.
        self.stub.write_text('import { parseCommand } from ' + json.dumps(str(cli)) + ''';
try {
  const command = parseCommand(process.argv.slice(2));
  console.log(JSON.stringify({ stub: true, ...command }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
''')

    def rows(self):
        return [json.loads(line) for f in self.logs.glob('*.ndjson') for line in f.read_text().splitlines()]

    def pending(self, text=None):
        state = {}
        for now in (10000, 10300, 10600):
            due = t.track_health(state, {'outlook': 'TimeoutExpired'}, now)
        t.health_alert(state, due, now)
        if text is not None:
            state['health_pending']['text'] = text
        return state

    def test_option_value_shapes_pass_the_actual_bridge_parser(self):
        for text in (None, '- leading bullet', '--option-like text', 'plain text', 'quotes " and apostrophe\'\nnext line', 'value=equals'):
            with self.subTest(text=text):
                state = self.pending(text)
                expected = state['health_pending']['text']
                real_run = t.subprocess.run
                with patch.object(t.subprocess, 'run', wraps=real_run) as run:
                    result = t.send_health(state, ['outlook'], t.LIVE, 10600)
                self.assertEqual(result, {'health_alerts': ['outlook']})
                self.assertNotIn('health_pending', state)
                parsed = real_run(run.call_args.args[0], capture_output=True, text=True,
                                  env=run.call_args.kwargs['env'], timeout=4)
                self.assertEqual(parsed.returncode, 0, parsed.stderr)
                body = json.loads(parsed.stdout)['body']
                self.assertEqual(body['text'], expected)
                self.assertEqual(body['dedupeKey'], run.call_args.args[0][-1].split('=', 1)[1])

    def test_original_split_value_reproduces_the_exact_live_hash(self):
        out = t.run_helper('telegram-bridge', [str(t.BUN), str(self.stub), 'notify', '--source', 'Inbox triage',
                           '--severity', 'attention', '--text', '- outlook: down', '--key', 'fixture'],
                           text=True, capture_output=True, timeout=4)
        self.assertEqual(out.returncode, 1)
        self.assertEqual(t.stderr_cause(out.stderr), {'stderrClass': 'usage_error', 'stderrLines': 1,
                                                     'stderrHash': 'a3c728f67e312ef3'})
        self.assertNotIn('Invalid command arguments', json.dumps(self.rows()))

    def test_failed_helper_stderr_corpus_is_classified_without_raw_text(self):
        fixtures = json.loads((Path(__file__).resolve().parents[2] / 'test/stderr-fixtures.json').read_text())
        for fixture in fixtures:
            with self.subTest(fixture=fixture):
                stub = self.root / 'failure.py'
                stub.write_text('import sys\nsys.stderr.write(' + repr(fixture['stderr']) + ')\nsys.exit(1)\n')
                out = t.run_helper('telegram-bridge', [sys.executable, '-I', str(stub)], capture_output=True,
                                   text=True, timeout=4)
                self.assertEqual(out.returncode, 1)
                row = self.rows()[-1]
                self.assertEqual(row['props']['stderrClass'], fixture['class'])
                self.assertEqual(row['props']['stderrLines'], fixture['lines'])
        logs = json.dumps(self.rows())
        self.assertNotIn('PRIVATE', logs)
        self.assertNotIn(str(self.root), logs)
        self.assertTrue(all(set(row.get('props', {})) <= {'exitCode', 'stderrClass', 'stderrHash', 'stderrLines'}
                            for row in self.rows()))

    def test_health_failure_logs_once_per_status_then_recovery_and_new_episode(self):
        state = self.pending()
        self.stub.write_text('console.error("PRIVATE socket ECONNREFUSED"); process.exitCode=1;')
        key = state['health_pending']['key']
        for now in (10600, 10660, 10720):
            result = t.send_health(state, ['outlook'], t.LIVE, now)
            self.assertEqual(result, {'health_alert_error': 'telegram-bridge notify failed: connect'})
            state = json.loads(json.dumps(state))
            self.assertEqual(state['health_pending']['key'], key)

        def tags(tag):
            return [row for row in self.rows() if row.get('error', {}).get('tag') == tag]

        self.assertEqual(len(tags('helper.exit_failed')), 1)
        self.assertEqual(len(tags('health.delivery_failed')), 1)
        self.stub.write_text('console.error("PRIVATE authentication failed"); process.exitCode=1;')
        t.send_health(state, ['outlook'], t.LIVE, 10780)
        self.assertEqual(len(tags('health.delivery_failed')), 2)
        self.stub.write_text('console.log("{}");')
        self.assertEqual(t.send_health(state, ['outlook'], t.LIVE, 10840), {'health_alerts': ['outlook']})
        self.assertEqual(len([row for row in self.rows() if row['name'] == 'helper.recovered']), 1)
        self.assertEqual(state['health_delivery_failures'], {})
        self.assertEqual(t.send_health(state, [], t.LIVE, 10900), {})
        state['health_pending'] = {'text': 'new episode', 'key': 'new', 'sources': []}
        self.stub.write_text('console.error("PRIVATE authentication failed"); process.exitCode=1;')
        t.send_health(state, [], t.LIVE, 10960)
        self.assertEqual(len(tags('health.delivery_failed')), 3)
        for tag in ('helper.exit_failed', 'health.delivery_failed'):
            self.assertTrue(all(row['ids']['helper'] == 'telegram-bridge' for row in tags(tag)))
        self.assertNotIn('PRIVATE', json.dumps(state))
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_collection_failed_names_each_helper_and_final_source_counts(self):
        state = {'cursors': {}, 'initialized_at': 10000}
        for fast, total in (({}, 3), (None, 4)):
            with self.subTest(fast=fast), patch.object(t, 'ACCOUNTS', ('outlook', 'gmail')), \
                 patch.object(t, 'exclusions', return_value=([], {'outlook': [], 'gmail': []})), \
                 patch.object(t, 'run_mail', side_effect=RuntimeError('PRIVATE authentication failed')), \
                 patch.object(t, 'collect_whatsapp', side_effect=RuntimeError('PRIVATE database down')), \
                 patch.object(t, 'collect_imessage', return_value={'items': [], 'cursor': 0}):
                before = len(self.rows())
                results, errors = t.collect(state, 10600, [], [], fast=fast)
                self.assertEqual(set(results), {'imessage'})
                self.assertEqual(len(errors), total - 1)
                rows = self.rows()[before:]
                self.assertEqual(len(rows), total - 1)
                self.assertEqual({r['ids']['helper'] for r in rows}, {'mail-worker'} | ({'whatsapp'} if fast is None else set()))
                for row in rows:
                    self.assertEqual(row['error']['tag'], 'collection.failed')
                    self.assertEqual(row['props']['failedSources'], total - 1)
                    self.assertEqual(row['props']['totalSources'], total)
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_partial_collection_and_imessage_failure_keep_helper_attribution(self):
        state = {'cursors': {}, 'initialized_at': 10000}
        with patch.object(t, 'ACCOUNTS', ('outlook',)), \
             patch.object(t, 'exclusions', return_value=([], {'outlook': []})), \
             patch.object(t, 'run_mail', return_value={'items': [], 'cursor': 1, 'partial': 'PRIVATE timed out'}), \
             patch.object(t, 'collect_imessage', side_effect=PermissionError('PRIVATE permission denied')):
            results, errors = t.collect(state, 10600, [], [], fast={})
        self.assertEqual(set(results), {'outlook'})
        self.assertEqual(set(errors), {'outlook', 'imessage'})
        self.assertEqual({(r['ids']['helper'], r['error']['tag'], r['props']['stderrClass']) for r in self.rows()},
                         {('mail-worker', 'collection.partial', 'timeout'), ('imessage', 'collection.failed', 'permission')})
        self.assertTrue(all(r['props']['failedSources'] == r['props']['totalSources'] == 2 for r in self.rows()))
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_collection_exception_types_supply_causes_missing_from_messages(self):
        cases = (
            (json.JSONDecodeError('PRIVATE', 'PRIVATE', 0), 'json'),
            (TimeoutError('PRIVATE mail collector budget exceeded'), 'timeout'),
            (t.subprocess.TimeoutExpired(['PRIVATE'], 1), 'timeout'),
            (PermissionError('PRIVATE'), 'permission'),
            (FileNotFoundError('PRIVATE'), 'missing_file'),
            (ModuleNotFoundError('PRIVATE'), 'missing_file'),
            (ConnectionRefusedError('PRIVATE'), 'connect'),
            (ConnectionResetError('PRIVATE'), 'connect'),
            (RuntimeError('PRIVATE'), 'unknown'),
        )
        for error, expected in cases:
            with self.subTest(error=type(error).__name__), patch.object(t, 'ACCOUNTS', ()), \
                 patch.object(t, 'exclusions', return_value=([], {})), \
                 patch.object(t, 'collect_imessage', side_effect=error):
                t.collect({'cursors': {}, 'initialized_at': 10000}, 10600, [], [], fast={})
                self.assertEqual(self.rows()[-1]['props']['stderrClass'], expected)
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))


if __name__ == '__main__':
    unittest.main()
