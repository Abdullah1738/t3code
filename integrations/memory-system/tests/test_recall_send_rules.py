"""Outgoing iMessage rule corpus; --live probes only a two-rule temporary DB."""
import json
import importlib.util
import io
import os
import shlex
import signal
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
import recall_messages
from recall_engine import CheckEngine
from recall_local import preflight
from recall_rules import RuleIndex

CARD = "Card limit (owner): the ENBD Marriott cards 2342 and 2792 share one limit, and it can go to about AED -9,400. Never tell Abdullah the card is over its limit, maxed, needs paying down, or will or might be declined, and never move a payment to another card for that reason, unless ENBD has sent a real decline SMS; then quote it."
MONI = 'Moni\'s chat (owner): plain text only, no ** or * for emphasis (iMessage shows the asterisks). At most two short paragraphs under 600 characters, then offer "want the details?".'
FIXTURES = [
    ('card2792', '', "Heads up on card 2792: ... it's showing AED 958 over its limit. Anything else put on it will probably get declined until it's paid down.", 'deny'),
    ('both_maxed', '', 'your ENBD Marriott card is now AED 1,711 over its limit. 2342 and 2792 share the same limit, so both cards are maxed. A paydown to ENBD should clear it, otherwise the next Uber or noon charge will probably get declined.', 'deny'),
    ('might_decline', '', '2342 was showing about AED 1,700 over its limit earlier, so ENBD might decline it.', 'deny'),
    ('switch_card', '', "It's almost certainly 2342 being over its limit, even though ENBD didn't text a decline. Try it again with a different card in the app, like the ADCB or the Wio card.", 'deny'),
    ('decline_sms', '', "ENBD texted: 'Your card ending 2342 was declined for AED 50 at noon'. Want me to retry on 9546?", 'allow'),
    ('order_update', '', 'Your order is on its way and should arrive at 7.', 'allow'),
    ('moni_bold', 'moni', '**Roses** would look lovely there.', 'flag'),
    ('moni_long', 'moni', 'The roses should arrive tomorrow. ' * 22, 'flag'),
    ('moni_short', 'moni', 'The roses arrive tomorrow.', 'allow'),
]


class SendRulesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.index = RuleIndex(self.root / 'rules.db')
        self.card = self.index.remember(CARD, actions=['message'], source_session='owner')['id']
        self.moni = self.index.remember(MONI, actions=['message'], recipient='moni', source_session='owner')['id']
        self.flag = patch.dict(os.environ, RECALL_RULE_PREFLIGHT='1', RECALL_FACT_BLOCK_THRESHOLD='0.7',
                               ROBOB_IMESSAGE_CHAT_ROOT=str(self.root / 'imessage'))
        self.flag.start()
        self.addCleanup(self.flag.stop)

    def call(self, arguments, cwd=None, tool='mcp__t3_code__imessage_send'):
        return preflight(tool, arguments, str(cwd or self.root / 'imessage'), self.index.path)

    def test_corpus_selection_and_decision(self):
        for name, to, text, expected in FIXTURES:
            score = .9 if expected == 'deny' or name == 'moni_bold' else .6 if name == 'moni_long' else .05
            def decide(messages, facts):
                self.assertEqual(messages, [text])
                self.assertEqual([r['text'] for r in facts], [MONI if to else CARD])
                return {str(r['id']): score for r in facts}, 0
            with self.subTest(name=name), patch.object(recall_messages, 'contradiction', side_effect=decide) as model:
                selected, result = self.call({'text': text, **({'to': to} if to else {})})
                self.assertNotIn(self.moni, [r['id'] for r in selected] if not to else [])
                if name == 'order_update':
                    model.assert_not_called()
                else:
                    model.assert_called_once()
                self.assertEqual((result or {}).get('decision', 'allow'), 'deny' if score >= .7 else 'allow')
                self.assertEqual(bool((result or {}).get('note')), score == .6)

    def test_recipient_forms_never_use_body_as_routing(self):
        cases = [
            ({'to': 'moni'}, None, True), ({'to': ' MONI '}, None, True),
            ({}, self.root / 'imessage/chats/moni', True),
            ({}, self.root / 'imessage/chats/moni/project', True),
            ({}, None, False), ({'to': 'owner'}, self.root / 'imessage/chats/moni', False),
            ({'to': 'david'}, None, False), ({'to': 'monika'}, None, False),
            ({}, self.root / 'imessage/chats/group-moni', False),
            ({}, self.root / 'unrelated/moni', False),
        ]
        for args, cwd, matches in cases:
            with self.subTest(args=args, cwd=cwd), patch.object(recall_messages, 'contradiction',
                    side_effect=lambda m, f: ({str(r['id']): .9 for r in f}, 0)) as model:
                _, result = self.call({**args, 'text': 'Moni chose **Roses**.'}, cwd)
                checked = [f['id'] for call in model.call_args_list for f in call.args[1]]
                self.assertEqual(self.moni in checked, matches)
                self.assertEqual((result or {}).get('decision', 'allow'), 'deny' if matches else 'allow')

    def test_literal_code_mode_batches_keep_recipients_attached(self):
        for other in ('owner', 'david'):
            code = ('await tools.mcp__t3_code__imessage_send(' + json.dumps({'to': other, 'text': '**Roses**'}) + ');'
                    'await tools.mcp__t3_code__imessage_send(' + json.dumps({'to': 'moni', 'text': 'Arrives tomorrow.'}) + ');')
            def decide(messages, facts):
                self.assertEqual(messages, ['Arrives tomorrow.'])
                self.assertEqual([r['id'] for r in facts], [self.moni])
                return {str(self.moni): .05}, 0
            with self.subTest(other=other), patch.object(recall_messages, 'contradiction', side_effect=decide):
                _, result = self.call({'code': code}, tool='functions.exec')
                self.assertEqual(result['decision'], 'allow')
                self.assertIsNone(result['note'])
        code = 'await tools.mcp__t3_code__imessage_send(' + json.dumps({'to': 'moni', 'text': '**Roses**'}) + ')'
        with patch.object(recall_messages, 'contradiction', return_value=({str(self.moni): .9}, 0)):
            self.assertEqual(self.call({'code': code}, tool='functions.exec')[1]['decision'], 'deny')

    def test_wrapper_object_field_forms(self):
        cases = [
            ('{text: "to: \'moni\' **Roses**"}', False),
            ('{photo: "moni", text: "**Roses**"}', False),
            ('{to: "owner", text: "tools.imessage_send({to: \'moni\', text: \'**Roses**\'})"}', False),
            ('{to: "owner", /* to: "moni" */ text: "**Roses**"}', False),
            ('{to: "moni", text: "**Roses** in } a vase"}', True),
            ('{"to": "moni", "text": "**Roses**"}', True),
            ("{'to': 'moni', 'text': '**Roses**'}", True),
            ('{text: "**Roses**", nested: {to: "owner"}, to: "moni"}', True),
        ]
        for obj, matches in cases:
            with self.subTest(obj=obj), patch.object(recall_messages, 'contradiction',
                    side_effect=lambda m, f: ({str(r['id']): .9 for r in f}, 0)) as model:
                _, result = self.call({'code': 'await tools.imessage_send(' + obj + ')'}, tool='functions.exec')
                checked = [f['id'] for call in model.call_args_list for f in call.args[1]]
                self.assertEqual(self.moni in checked, matches)
                self.assertEqual((result or {}).get('decision', 'allow'), 'deny' if matches else 'allow')

    def test_cli_recipient_forms_direct_and_wrapped(self):
        cli = 'bun /fixture/spectrum-bridge/src/cli.ts send --session fixture '
        text = 'iMessage shows **Roses**.'
        body = self.root / 'body.txt'
        body.write_text(text)
        cases = [
            (cli + '--to moni --text ' + shlex.quote(text), None, True),
            (cli + '--to=moni --text=' + shlex.quote(text), None, True),
            (cli + '--to "moni" --body-file ' + shlex.quote(str(body)), None, True),
            (cli + '--text ' + shlex.quote(text), self.root / 'imessage/chats/moni', True),
            (cli + '--to owner --text ' + shlex.quote(text), self.root / 'imessage/chats/moni', False),
            (cli + '--to david --text ' + shlex.quote(text), None, False),
            (cli + '--text ' + shlex.quote('Moni says --to moni **Roses**.'), None, False),
            ('echo ' + shlex.quote(cli + '--to moni --text ' + shlex.quote(text)), None, False),
            ('zsh -c ' + shlex.quote(cli + '--to moni --text ' + shlex.quote(text)), None, True),
        ]
        for command, cwd, matches in cases:
            for wrapper in (False, True):
                args = {'cmd': command}
                if wrapper:
                    args = {'code': 'await tools.exec_command(' + json.dumps(args) + ')'}
                with self.subTest(command=command, wrapper=wrapper), patch.object(recall_messages, 'contradiction',
                        side_effect=lambda m, f: ({str(r['id']): .9 for r in f}, 0)) as model:
                    _, result = self.call(args, cwd, 'functions.exec' if wrapper else 'exec_command')
                    checked = [f['id'] for call in model.call_args_list for f in call.args[1]]
                    self.assertEqual(self.moni in checked, matches)
                    self.assertEqual((result or {}).get('decision', 'allow'), 'deny' if matches else 'allow')
        batch = cli + '--to owner --text ' + shlex.quote(text) + '; ' + cli + '--to moni --text "Arrives tomorrow."'
        with patch.object(recall_messages, 'contradiction', return_value=({str(self.moni): .05}, 0)) as model:
            self.assertEqual(self.call({'cmd': batch}, tool='exec_command')[1]['decision'], 'allow')
            self.assertEqual(model.call_args.args[0], ['Arrives tomorrow.'])

    def test_native_timer_keeps_timeout_note_for_large_batch(self):
        for number in range(400):
            self.index.remember(f'Fixture message instruction {number}.', actions=['message'])
        spec = importlib.util.spec_from_file_location('batch_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        release = threading.Event()
        self.addCleanup(release.set)
        code = ';'.join('await tools.imessage_send({to:"moni",text:"**Roses**"})' for _ in range(20))
        alarms = []
        def expired(*_):
            alarms.append(True)
            raise TimeoutError('native timer fired before the note')
        for harness in ('claude', 'codex'):
            output = io.StringIO()
            with self.subTest(harness=harness), patch.dict(os.environ, RECALL_RULES_DB=str(self.index.path),
                    RECALL_DECISION_LOG=str(self.root / 'decisions.jsonl')), \
                 patch.object(hook, 'config', return_value={'mode': 'on'}), patch.object(hook, 'log'), \
                 patch.object(recall_messages, 'contradiction', side_effect=lambda *a: release.wait(3)) as model, \
                 patch.object(self.index.__class__, 'search_facts', autospec=True,
                              side_effect=RuleIndex.search_facts) as search, redirect_stdout(output):
                old = signal.signal(signal.SIGALRM, expired)
                signal.setitimer(signal.ITIMER_REAL, 1.5)
                try:
                    hook.handle(harness, dict(hook_event_name='PreToolUse', session_id='fixture', tool_name='functions.exec',
                        tool_input={'code': code}, cwd=str(self.root / 'imessage')))
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, old)
                value = json.loads(output.getvalue())['hookSpecificOutput']
                self.assertIn(MONI, value['additionalContext'])
                self.assertEqual(model.call_count, 1)
                self.assertEqual(search.call_count, 1)
                self.assertEqual(alarms, [])

    def test_cli_normalization_preserves_original_shell_prohibitions(self):
        self.index.remember('Always push to main-dev, never main.', actions=['git.push'], source_session='owner')
        send = 'bun /fixture/spectrum-bridge/src/cli.ts send --to owner --text Done'
        for command in ('git push origin HEAD:main; ' + send, send + '; git push origin HEAD:main',
                        'git push origin HEAD:main-dev; ' + send):
            for wrapped in (False, True):
                args = {'cmd': command}
                if wrapped: args = {'code': 'await tools.exec_command(' + json.dumps(args) + ')'}
                with self.subTest(command=command, wrapped=wrapped), patch.object(recall_messages, 'contradiction') as model:
                    _, result = self.call(args, tool='functions.exec' if wrapped else 'exec_command')
                    self.assertEqual((result or {}).get('decision', 'allow'), 'allow' if 'HEAD:main-dev' in command else 'deny')
                    model.assert_not_called()

    def test_timeout_and_classifier_error_emit_cited_note(self):
        for error in (TimeoutError(), ValueError('bad score')):
            with self.subTest(error=type(error)), patch.object(recall_messages, 'contradiction', side_effect=error):
                _, result = self.call({'to': 'moni', 'text': '**Roses**'})
                self.assertEqual(result['decision'], 'allow')
                self.assertIsNone(result['p'])
                self.assertIn(MONI, result['note'])
                self.assertTrue(result['sources'])
        release = threading.Event()
        self.addCleanup(release.set)
        with patch.object(recall_messages, 'contradiction', side_effect=lambda *a: release.wait(3)):
            started = time.monotonic()
            _, result = self.call({'to': 'moni', 'text': '**Roses**'})
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertIn(MONI, result['note'])

    def test_default_flag_stays_off(self):
        with patch.dict(os.environ, RECALL_RULE_PREFLIGHT=''), patch.object(recall_messages, 'contradiction') as model:
            self.assertEqual(self.call({'to': 'moni', 'text': '**Roses**'}), ([], None))
            model.assert_not_called()

    def test_engine_and_both_native_hooks_deliver_the_decision(self):
        spec = importlib.util.spec_from_file_location('send_hook', ROOT / 'hooks/recall_hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        args = {'to': 'moni', 'text': '**Roses**'}
        with patch.dict(os.environ, RECALL_RULES_DB=str(self.index.path),
                        RECALL_DECISION_LOG=str(self.root / 'decisions.jsonl')):
            for probability in (.9, .6, .05, None):
                def decide(*_):
                    if probability is None:
                        raise TimeoutError()
                    return {str(self.moni): probability}, 0
                with self.subTest(probability=probability), patch.object(recall_messages, 'contradiction', side_effect=decide):
                    result = CheckEngine(rules_path=self.index.path).preflight(dict(trigger='tool',
                        tool='imessage_send', arguments=args, cwd=str(self.root / 'imessage')))[2]
                    self.assertEqual(result['decision'], 'deny' if probability == .9 else 'allow')
                    for harness in ('claude', 'codex'):
                        out = io.StringIO()
                        with redirect_stdout(out), patch.object(hook, 'config', return_value={'mode': 'on'}), \
                             patch.object(hook, 'log'), patch.object(hook, 'request', side_effect=AssertionError('unexpected remote check')):
                            hook.handle(harness, dict(hook_event_name='PreToolUse', session_id='fixture',
                                tool_name='mcp__t3_code__imessage_send', tool_input=args, cwd=str(self.root / 'imessage')))
                        value = json.loads(out.getvalue())['hookSpecificOutput'] if out.getvalue() else {}
                        self.assertEqual(value.get('permissionDecision'), 'deny' if probability == .9 else None)
                        self.assertEqual(bool(value.get('additionalContext')), probability is None or probability == .6)


def copy_rules(source, destination):
    """Read just the approved rows and their keys/sources, never migrate live data."""
    index = RuleIndex(destination)
    with closing(sqlite3.connect(Path(source).absolute().as_uri() + '?mode=ro', uri=True)) as src, \
         closing(index._connect()) as dst, dst:
        src.execute('PRAGMA query_only=ON')
        src.execute('BEGIN')
        for table, column in [('rules', 'id'), ('rule_sources', 'rule_id'), ('rule_keys', 'rule_id')]:
            cursor = src.execute(f'SELECT * FROM {table} WHERE {column} IN (4356,4357)')
            columns = [col[0] for col in cursor.description]
            for row in cursor.fetchall():
                dst.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES ({",".join("?" for _ in row)})', row)
        assert dst.execute('SELECT count(*) FROM rules').fetchone()[0] == 2
    return index


def live_probe(output, repeats=3):
    rows = []
    original = recall_messages.contradiction
    with tempfile.TemporaryDirectory() as tmp:
        index = copy_rules(Path.home() / '.local/share/memory-system/data/recall_rules.db', Path(tmp) / 'rules.db')
        cases = [(name, to, text, expected, 'explicit') for name, to, text, expected in FIXTURES]
        cases += [(name + '_implicit', '', text, expected, 'implicit')
                  for name, to, text, expected in FIXTURES if to == 'moni']
        for run in range(repeats):
            for name, to, text, expected, route in cases:
                row = dict(run=run + 1, fixture=name, expected=expected, scores=None, timed_out=False)
                def measure(messages, facts, row=row):
                    start = time.monotonic()
                    try:
                        scores, cost = original(messages, facts)
                        row['scores'] = scores
                        return scores, cost
                    except Exception as exc:
                        row.update(error=type(exc).__name__, timed_out=isinstance(exc, TimeoutError))
                        raise
                    finally:
                        row['classifier_ms'] = round((time.monotonic() - start) * 1000)
                args = {'text': text, **({'to': to} if to else {})}
                cwd = Path(tmp) / 'imessage'
                if route == 'implicit':
                    cwd = cwd / 'chats/moni'
                with patch.dict(os.environ, RECALL_RULE_PREFLIGHT='1', RECALL_FACT_BLOCK_THRESHOLD='0.7',
                                ROBOB_IMESSAGE_CHAT_ROOT=str(Path(tmp) / 'imessage')), \
                     patch.object(recall_messages, 'contradiction', side_effect=measure):
                    selected, result = preflight('mcp__t3_code__imessage_send', args, str(cwd), index.path)
                row.update(budget_hit=bool(result and result.get('routed') and result.get('p') is None),
                           selected=[r['id'] for r in selected], decision=(result or {}).get('decision', 'allow'),
                           note=bool((result or {}).get('note')), latency_ms=(result or {}).get('latency_ms'))
                rows.append(row)
                Path(output).write_text(json.dumps(rows, indent=2) + '\n')
                print(json.dumps(row), flush=True)
    return rows


if __name__ == '__main__':
    if '--live' in sys.argv:
        live_probe(sys.argv[sys.argv.index('--live') + 1])
    else:
        unittest.main()
