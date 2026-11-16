"""Narrow offline checks for filtering and no-loss cursor/outbox behavior."""
import copy
import datetime as dt
import importlib.util
import imaplib
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import tempfile
import time
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('triage', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class ChargeDryRunReadOnly(unittest.TestCase):
    def test_default_money_cases_data_is_unchanged(self):
        fixtures = t.load_module('money_cases_read_only_fixtures',
                                 Path(__file__).resolve().parents[1] / 'money-cases' / 'test_cases.py')
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as tmp:
                with fixtures.screen_sources(Path(tmp), corrupt) as fixture:
                    data, text, charged, now, server, orders, calls = fixture
                    item = {'id': 'imsg:dry-charge', 'source': 'imessage', 'sender': 'EmiratesNBD',
                            'subject': '', 'preview': text, 'ts': charged.timestamp()}
                    before = fixtures.data_snapshot(data)
                    with patch.object(t, 'MONEY_CASES', Path(fixtures.mc.__file__)):
                        reasons, held, error = t.charge_checks([item], now.timestamp(), dry=True)
                    self.assertIsNone(error)
                    self.assertEqual(held, set())
                    self.assertIn('charge_check', item)
                    self.assertEqual(fixtures.data_snapshot(data), before)
                    self.assertTrue(orders)
                    self.assertTrue(calls.read_text().strip())
                    self.assertTrue(any(path.endswith('/messages') for path, _, _ in server.calls))


@contextlib.contextmanager
def parsed_notifiers(root):
    """Use each bridge's real parser, recording delivery without opening its socket."""
    calls = root / 'deliveries.ndjson'
    env = {'ROBOB_TEST': '1', 'TOOLLOG_DIR': str(root / 'logs'), 'TEST_DELIVERIES': str(calls)}
    for channel, variable, bridge in (('telegram', 'ROBOB_WATCH_TELEGRAM_CLI', 'telegram-bridge'),
                                      ('imessage', 'INBOX_TRIAGE_SPECTRUM_CLI', 'spectrum-bridge')):
        cli = Path(__file__).resolve().parents[3] / bridge / 'src/cli.ts'
        stub = root / f'{channel}.ts'
        stub.write_text('import { parseCommand } from ' + json.dumps(str(cli)) + ";\n" +
                        'import { appendFileSync } from "node:fs";\n' +
                        'const command = parseCommand(process.argv.slice(2));\n' +
                        'appendFileSync(process.env.TEST_DELIVERIES, JSON.stringify(command) + "\\n");\n')
        env[variable] = str(stub)
    with patch.dict(os.environ, env), patch.object(t, 'BUN', shutil.which('bun') or t.BUN):
        yield calls


class NotifierParserTests(unittest.TestCase):
    def test_health_and_item_text_reaches_real_parsers_intact_once(self):
        texts = ('- outlook: down', '-- outlook: down', '-', '--', '--key=mail text',
                 'Bank debit: AED 12.00 at Example', '- first\n-- second=value')
        for text in texts:
            for kind in ('health', 'telegram', 'imessage'):
                with self.subTest(text=text, kind=kind), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    with parsed_notifiers(root) as calls, patch.object(t, 'LIVE', root):
                        if kind == 'health':
                            state = {'health_pending': {'text': text, 'key': '--health-key', 'sources': []}}
                            self.assertEqual(t.send_health(state, [], root, 10600), {'health_alerts': []})
                            self.assertEqual(t.send_health(state, [], root, 10900), {})
                        else:
                            with patch.object(t, 'owner_route', return_value='fixture-session'), \
                                 patch.object(t, 'imessage_status', side_effect=[None, ('sent', 1, 'fixture')]):
                                self.assertEqual(t.send_urgent('item', text, kind, 10600), 10600)
                                self.assertEqual(t.send_urgent('item', text, kind, 10900), 10600)
                        delivered = [json.loads(line) for line in calls.read_text().splitlines()]
                        self.assertEqual(len(delivered), 1)
                        self.assertEqual(delivered[0]['body']['text'], text)
                        if kind == 'health':
                            self.assertEqual(delivered[0]['body']['dedupeKey'], '--health-key')


class ExclusionTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.logs = self.root / 'logs'
        self.stack.enter_context(patch.dict(os.environ, {'TOOLLOG_DIR': str(self.logs),
                                                        'WATCH_ID': 'inbox-triage', 'ROBOB_TEST': '1'}))
        self.watcher = {'id': 'fixture-watcher', '_dir': str(self.root), '_healthy': True,
                        'check': 'bash check.sh'}

    def seen(self, account, query, folder='Inbox'):
        key = hashlib.sha256(f'{account}|{folder}|{query}'.encode()).hexdigest()[:16]
        (self.root / f'mail-{key}.seen').write_text('exact-message-id\n')

    def errors(self):
        rows = [json.loads(line) for p in self.logs.glob('*.ndjson') for line in p.read_text().splitlines()]
        return [row for row in rows if row.get('error', {}).get('tag') == 'watcher.command_invalid']

    def test_multiline_quoted_script_and_query_preserve_exact_exclusions(self):
        query = 'from example.test\nor subject booking'
        (self.root / 'check.sh').write_text(
            "# The owner's watcher\npython3 -c '\nprint(\"fixture\")\n'\n"
            f"email-new-message gmail '{query}'\n"
            "printf 'finished'\nwhatsapp-new-message '123@s.whatsapp.net'\n")
        self.seen('gmail', query)
        jids, seen = t.exclusions([self.watcher], {})
        self.assertEqual(jids, {'123@s.whatsapp.net'})
        self.assertEqual(seen['gmail'], {'exact-message-id'})
        self.assertEqual(self.errors(), [])

    def test_command_boundaries_comments_and_mailbox_defaults(self):
        commands = (
            "email-new-message gmail 'from example.test'",
            "email-new-message gmail 'from example.test' Inbox",
            "email-new-message gmail 'from example.test'\nprintf done",
            "email-new-message gmail 'from example.test' # owner's comment\nprintf done",
            "# owner's comment\nemail-new-message gmail 'from example.test'\n# another's comment",
            "email-new-message gmail 'from example.test' && printf done",
            "email-new-message gmail 'from example.test' ; printf done",
            "email-new-message gmail 'from example.test' || printf failed",
        )
        self.seen('gmail', 'from example.test')
        for command in commands:
            with self.subTest(command=command):
                self.watcher['check'] = command
                _, seen = t.exclusions([self.watcher], {})
                self.assertEqual(seen['gmail'], {'exact-message-id'})
        self.assertEqual(self.errors(), [])

    def test_broken_command_logs_once_per_watcher_and_change_across_runs(self):
        script = self.root / 'check.sh'
        script.write_text("printf 'private-unclosed\n")
        self.watcher['check'] = "email-new-message gmail 'from example.test'"
        self.seen('gmail', 'from example.test')
        state = {}
        _, seen = t.exclusions([self.watcher], state)
        self.assertEqual(seen['gmail'], {'exact-message-id'})
        self.assertEqual(len(self.errors()), 1)
        # Re-load the same state a new process receives on the next tick.
        t.atomic(self.root / 'cursor.json', state)
        state = t.read_json(self.root / 'cursor.json')
        t.exclusions([self.watcher], state)
        self.assertEqual(len(self.errors()), 1)
        script.write_text("printf 'private-changed\n")
        t.exclusions([self.watcher], state)
        self.assertEqual(len(self.errors()), 2)
        self.watcher['check'] += '\nprintf changed'
        t.exclusions([self.watcher], state)
        self.assertEqual(len(self.errors()), 3)
        other = dict(self.watcher, id='other-watcher')
        t.exclusions([self.watcher, other], state)
        self.assertEqual([row['ids']['watcher'] for row in self.errors()],
                         ['fixture-watcher'] * 3 + ['other-watcher'])
        for private in ('private-unclosed', 'private-changed', 'from example.test'):
            self.assertNotIn(private, json.dumps(self.errors()))
            self.assertNotIn(private, json.dumps(state))

    def test_shell_hash_and_escape_forms_keep_the_exact_query(self):
        queries = (
            (r'subject\ booking#123', 'subject booking#123'),
            (r'subject\ booking\#123', 'subject booking#123'),
            ("'subject booking#123'", 'subject booking#123'),
            ('"subject booking#123"', 'subject booking#123'),
            ("subject\\ booking'#123'", 'subject booking#123'),
            ("'subject #123'", 'subject #123'),
            ('"subject #123"', 'subject #123'),
            (r'subject\ \#123', 'subject #123'),
            ("'subject booking' # owner's comment", 'subject booking'),
            ("'subject booking'\t# owner's comment", 'subject booking'),
            ("'subject booking' ;# owner's comment", 'subject booking'),
            ("'subject booking'\n# owner's comment", 'subject booking'),
            ("'subject booking'\\\n#123", 'subject booking#123'),
            ("\\\n'subject booking'", 'subject booking'),
            ("'subject booking\\\n#123'", 'subject booking\\\n#123'),
            ('"subject booking\\\n#123"', 'subject booking#123'),
        )
        for shell_query, query in queries:
            with self.subTest(shell_query=shell_query):
                for path in self.root.glob('mail-*.seen'):
                    path.unlink()
                self.seen('gmail', query)
                self.watcher['check'] = 'email-new-message gmail ' + shell_query
                _, seen = t.exclusions([self.watcher], {})
                self.assertEqual(seen['gmail'], {'exact-message-id'})
        self.assertEqual(self.errors(), [])

    def test_recovery_clears_failure_and_unhealthy_watcher_is_ignored(self):
        self.watcher['check'] = "printf 'broken"
        state = {}
        t.exclusions([dict(self.watcher, _healthy=False)], state)
        self.assertEqual(self.errors(), [])
        t.exclusions([self.watcher], state)
        self.watcher['check'] = 'printf fixed'
        t.exclusions([self.watcher], state)
        self.assertNotIn(self.watcher['id'], state['watcher_command_invalid'])
        self.assertEqual(len(self.errors()), 1)

    def test_exact_seen_ids_only_and_all_existing_whatsapp_jid_forms(self):
        self.watcher['check'] = (
            "email-new-message gmail 'from example.test' Sent\n"
            "# email-new-message gmail 'from example.test'\n"
            "whatsapp-new-message '123@s.whatsapp.net'\n"
            "whatsapp-new-message '456@lid'\nwhatsapp-new-message '789@g.us'")
        self.seen('gmail', 'from example.test')
        self.seen('gmail', 'from example.test', 'Sent')
        jids, seen = t.exclusions([self.watcher], {})
        self.assertEqual(jids, {'123@s.whatsapp.net', '456@lid', '789@g.us'})
        self.assertEqual(seen, {a: set() for a in t.ACCOUNTS})
        self.assertEqual(self.errors(), [])


class TriageTests(unittest.TestCase):
    def item(self, **kwargs):
        return dict({'id': 'mail:a:1:1', 'source': 'email', 'sender': 'Booking <booking@cars.example>',
                     'subject': 'Confirmation 10001', 'preview': 'Thanks for your booking', 'ts': 1000}, **kwargs)

    def test_bulk_filter_preserves_real_confirmation(self):
        self.assertIsNone(t.prefilter(self.item(list_unsubscribe=True), 1100, []))
        self.assertEqual(t.prefilter(self.item(subject='Weekly news', list_unsubscribe=True), 1100, []), 'bulk')

    def test_cliq_stale_otp_and_noise(self):
        self.assertEqual(t.prefilter(self.item(sender='Zoho Cliq'), 1100, []), 'cliq')
        self.assertEqual(t.prefilter(self.item(subject='Your verification code 123456'), 1400, []), 'stale_otp')
        self.assertNotIn('123456', t.clean('Your OTP is 123456'))
        rules = [{'source': 'email', 'field': 'sender', 'contains': 'spam@example', 'reason': 'test'}]
        self.assertEqual(t.prefilter(self.item(sender='spam@example.com'), 1100, rules), 'learned_noise')
        self.assertIsNone(t.prefilter(self.item(), 1100, rules))

    def test_preview_strips_hidden_padding_and_tracking_urls(self):
        value = t.clean('Hello' + '\u200c ' * 400 + 'real receipt https://example.com/' + 'x' * 500)
        self.assertIn('real receipt', value)
        self.assertLess(len(value), 50)

    def test_otp_context_redacts_across_subject_body_and_attachments(self):
        for subject, text in [('Your verification code', '123456'), ('123456', 'Your verification code')]:
            with self.subTest(subject=subject):
                raw = ('From: bank@example.com\r\nSubject: ' + subject + '\r\nContent-Type: text/plain\r\n\r\n' + text).encode()
                record = (1, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0])
                request = {'seen': [], 'rules': []}
                with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
                    item, reason = t.mail_record(None, None, 'icloud', 1, record, 0, 1100, request)
                self.assertIsNone(reason)
                self.assertNotIn('123456', json.dumps(item))
        item = self.item(subject='Your OTP', preview='123456', attachments=['code-654321.txt'])
        t.redact_item(item)
        self.assertNotIn('123456', json.dumps(item))
        self.assertNotIn('654321', json.dumps(item))

    def test_fetch_missing_uid_cannot_advance_cursor(self):
        class FakeImap:
            def select(self, *a, **kw): return 'OK', [b'2']
            def response(self, key): return key, [b'1' if key == 'UIDVALIDITY' else b'3']
            def uid(self, operation, *args):
                if operation == 'SEARCH': return 'OK', [b'1 2']
                return 'OK', [(b'1 (UID 1)', b''), (b'2 (BODY[HEADER]', b'')]
            def shutdown(self): pass
        request = {'credential': 'fixture', 'now': 2000, 'cursor': {'validity': 1, 'uid': 0}, 'initialized_at': 1000, 'seen': [], 'rules': []}
        before = copy.deepcopy(request)
        with patch.object(t, 'load_module', return_value=type('Mail', (), {'connect': lambda *args: FakeImap()})):
            with self.assertRaisesRegex(ValueError, 'missing UID'):
                t.mail_worker('icloud', request)
        self.assertEqual(request, before)

    def test_fetch_omission_requires_confirmed_expunge(self):
        for present in (b'2', b''):
            with self.subTest(present=present):
                imap = types.SimpleNamespace(uid=lambda operation, *args: ('OK', [(b'1 (UID 1)', b'body')]) if operation == 'FETCH' else ('OK', [present]))
                if present:
                    with self.assertRaisesRegex(ValueError, 'still in INBOX'):
                        t.fetch_verified(imap, [1, 2], '(UID BODY.PEEK[])')
                else:
                    self.assertEqual([r[0] for r in t.fetch_verified(imap, [1, 2], '(UID BODY.PEEK[])')], [1])

    def test_fetch_rejects_duplicate_and_unexpected_uids(self):
        for uids in ([1, 1], [1, 3]):
            imap = types.SimpleNamespace(uid=lambda *args: ('OK', [(f'1 (UID {u})'.encode(), b'body') for u in uids]))
            with self.assertRaisesRegex(ValueError, 'duplicate or unexpected'):
                t.fetch_verified(imap, [1, 2], '(UID BODY.PEEK[])')

    def test_holding_replies_filtered_but_new_details_survive(self):
        self.assertEqual(t.prefilter(self.item(source='whatsapp', preview='Let me Check availibility and Price'), 1100, []), 'holding_reply')
        self.assertEqual(t.prefilter(self.item(source='whatsapp', preview='Will let u know'), 1100, []), 'holding_reply')
        self.assertIsNone(t.prefilter(self.item(source='whatsapp', preview='Let me check availability. The price is EUR 262.'), 1100, []))

    def test_unacked_event_replays_and_acked_does_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            state = {'outbox': {'run': 'old', 'event': 'review this'}}
            self.assertEqual(t.replay_outbox(state, wd, 'new'), 'review this')
            self.assertEqual(t.read_json(wd / 'cursor.json')['outbox']['run'], 'new')
            (wd / '.run-ok').write_text('new')
            self.assertIsNone(t.replay_outbox(state, wd, 'third'))
            self.assertNotIn('outbox', state)

    def test_changed_uidvalidity_rescans_since_install(self):
        class FakeImap:
            def select(self, *a, **kw): return 'OK', [b'1']
            def response(self, key): return key, [b'8' if key == 'UIDVALIDITY' else b'5']
            def uid(self, operation, *args):
                if operation == 'SEARCH':
                    self.search = args
                    return 'OK', [b'']
                raise AssertionError(operation)
            def shutdown(self): pass
        imap = FakeImap()
        mail = type('Mail', (), {'connect': lambda *args: imap})
        request = {'credential': 'fixture', 'now': 2000, 'cursor': {'validity': 7, 'uid': 999}, 'initialized_at': 1000,
                   'seen': [], 'rules': []}
        with patch.object(t, 'load_module', return_value=mail):
            result = t.mail_worker('icloud', request)
        self.assertEqual(imap.search[0], 'SINCE')
        self.assertEqual(result['cursor'], {'validity': 8, 'uid': 4})

    def test_failed_baseline_source_recovers_from_install_time(self):
        class FakeImap:
            def select(self, *a, **kw): return 'OK', [b'1']
            def response(self, key): return key, [b'8' if key == 'UIDVALIDITY' else b'5']
            def uid(self, operation, *args):
                self.search = args
                return 'OK', [b'']
            def shutdown(self): pass
        imap = FakeImap()
        request = {'credential': 'fixture', 'now': 2000, 'cursor': None, 'initialized_at': 1000, 'baseline': False,
                   'seen': [], 'rules': []}
        with patch.object(t, 'load_module', return_value=type('Mail', (), {'connect': lambda *args: imap})):
            t.mail_worker('icloud', request)
        self.assertEqual(imap.search[0], 'SINCE')

    def test_partial_mail_timeout_advances_only_completed_prefix(self):
        class FakeImap:
            def select(self, *a, **kw): return 'OK', [b'4']
            def response(self, key): return key, [b'1' if key == 'UIDVALIDITY' else b'5']
            def uid(self, operation, *args):
                if operation == 'SEARCH': return 'OK', [b'1 2 3 4']
                return 'OK', [(f'{uid} (UID {uid})'.encode(), b'') for uid in range(1, 5)]
            def shutdown(self): pass
        request = {'credential': 'fixture', 'now': 2000, 'cursor': {'validity': 1, 'uid': 0}, 'initialized_at': 1000,
                   'seen': [], 'rules': []}
        for error, transient in (
            (TimeoutError(), True),
            (imaplib.IMAP4.abort('socket error: Connection reset by peer'), True),
            (imaplib.IMAP4.abort('socket error: Connection refused'), True),
            (imaplib.IMAP4.abort('TLS handshake timed out'), True),
            (imaplib.IMAP4.abort('Temporary failure in name resolution'), True),
            (imaplib.IMAP4.abort('LOGIN failed'), False),
            (ValueError('parse error'), False),
        ):
            with self.subTest(error=repr(error)):
                processed = [(self.item(id=f'mail:a:1:{i}'), None) for i in (1, 2, 3)] + [error]
                with patch.object(t, 'load_module', return_value=type('Mail', (), {'connect': lambda *args: FakeImap()})), \
                     patch.object(t, 'mail_record', side_effect=processed):
                    result = t.mail_worker('icloud', request)
                self.assertEqual(result['cursor']['uid'], 3)
                self.assertEqual(len(result['items']), 3)
                self.assertIn('completed prefix', result['partial'])
                self.assertEqual(t.transient_error(result['partial']), transient)

    def test_empty_classifier_result_commits_cursor_without_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000,
                                         'cursors': {'icloud': {'validity': 1, 'uid': 1}}, 'queue': []})
            result = {'icloud': {'cursor': {'validity': 1, 'uid': 2}, 'items': [self.item()], 'drops': {}, 'scanned': 1}}
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=(result, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'classify', return_value=([], {'cost_usd': 0.0001})) as model:
                self.assertEqual(t.run(args), 0)
                model.assert_called_once()
            state = t.read_json(wd / 'cursor.json')
            self.assertEqual(state['cursors']['icloud']['uid'], 2)
            self.assertEqual(state['queue'], [])
            self.assertNotIn('outbox', state)

    def test_classifier_failure_preserves_event_and_failed_source_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000,
                                         'cursors': {'gmail': {'validity': 1, 'uid': 8}}, 'queue': [self.item()]})
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=({}, {'gmail': 'timeout'})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'classify', side_effect=TimeoutError) as model, patch('builtins.print'):
                self.assertEqual(t.run(args), 1)
                self.assertEqual(model.call_count, 2)
            state = t.read_json(wd / 'cursor.json')
            self.assertEqual(state['cursors']['gmail']['uid'], 8)
            self.assertEqual(state['queue'], [])
            self.assertIn('outbox', state)
            self.assertEqual(t.read_json(Path(state['outbox']['batch']))['hits'][0]['id'], 'mail:a:1:1')

    def test_a_slow_collection_leaves_the_classifier_only_what_fits_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': [self.item()]})
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            # Collection exhausted the minimum useful classification window.
            ticks = [1000.0, 1043.5]
            def clock():
                return ticks.pop(0) if len(ticks) > 1 else ticks[0]
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=({'gmail': {'cursor': {}, 'items': [], 'drops': {}, 'scanned': 0}}, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'handled', return_value=({}, {})), patch.object(t.time, 'time', side_effect=clock), \
                 patch.object(t, 'classify', side_effect=AssertionError('no time left to call it')) as model, patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            model.assert_not_called()
            state = t.read_json(wd / 'cursor.json')
            self.assertNotIn('outbox', state)
            self.assertEqual([i['id'] for i in state['queue']], ['mail:a:1:1'])
        with patch.object(t, 'classify') as model:
            hits, meta = t.classify_batch([self.item()], {}, 6)
        model.assert_not_called()
        self.assertEqual(hits, [])
        self.assertTrue(meta['classifier_deferred'])
        self.assertEqual(meta['classifier_budget_ms'], 6000)

    def test_the_deadline_survives_code_that_swallows_timeouts(self):
        # socket.create_connection catches OSError (TimeoutError is one) and tries the next
        # address; the deadline must still end the call within the budget.
        def stubborn(items, context):
            started = time.monotonic()
            while time.monotonic() - started < 10:
                try:
                    time.sleep(0.05)
                except OSError:
                    pass
                except Exception:
                    pass
            raise AssertionError('the deadline never stopped the call')
        started = time.monotonic()
        with patch.object(t, 'CLASSIFIER_MIN_SECONDS', 0), patch.object(t, 'classify', side_effect=stubborn):
            hits, meta = t.classify_batch([self.item()], {}, 2)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn('deadline', meta['classifier_error'])
        self.assertEqual(hits[0]['reason'], 'Classifier unavailable; manually review')
        self.assertEqual(t.signal.getitimer(t.signal.ITIMER_REAL), (0.0, 0.0))

    def test_a_deadline_firing_right_after_the_timer_is_set_is_still_caught(self):
        real = t.signal.setitimer
        calls = []
        def slow_to_return(which, seconds, interval=0.0):
            calls.append(seconds)
            real(which, seconds, interval)
            if len(calls) == 1:
                time.sleep(1.5)  # descheduled between arming and the call; macOS fires a 1 s timer at ~1.15 s
        with patch.object(t, 'CLASSIFIER_MIN_SECONDS', 0), patch.object(t.signal, 'setitimer', side_effect=slow_to_return), \
             patch.object(t, 'classify', side_effect=AssertionError('the deadline came first')):
            hits, meta = t.classify_batch([self.item()], {}, 2)
        self.assertIn('deadline', meta['classifier_error'])
        self.assertEqual(hits[0]['reason'], 'Classifier unavailable; manually review')
        self.assertEqual(t.signal.getitimer(t.signal.ITIMER_REAL), (0.0, 0.0))
        self.assertIs(t.signal.getsignal(t.signal.SIGALRM), t.signal.SIG_DFL)

    def test_the_classifier_sees_which_payments_each_message_came_after(self):
        sent = {}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
        def urlopen(req, timeout):
            sent.update(json.loads(json.loads(req.data)['messages'][1]['content']))
            return Response()
        # A prompt 60 s old and a payment 40 s old both round to "1 min ago"; only exact times
        # can tell the prompt came first.
        work = {'live_work': {'open_payments': [{'ref': 'p1', 'sent_at': 2000.0}, {'ref': 'p2', 'sent_at': 900.0},
                                                {'ref': 'p3'}], 'phone_task': {'running': False}}}
        items = [self.item(id='before', ts=1980), self.item(id='after', ts=2010), self.item(id='none', ts=None)]
        with patch.object(t.urllib.request, 'urlopen', side_effect=urlopen), \
             patch.object(t.json, 'load', return_value={'choices': [{'message': {'content': '{"hits":[]}'}}]}), \
             patch.object(Path, 'read_text', return_value='key'):
            t.classify(items, work)
            self.assertEqual([i['after_payments'] for i in sent['items']], [['p2'], ['p1', 'p2'], []])
            t.classify(items, {'live_work': {'open_payments': 'unavailable: RuntimeError: busy'}})
            self.assertEqual([i['after_payments'] for i in sent['items']], [[], [], []])

    def test_answered_chats_are_dropped_before_and_after_classifying(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': []})
            chat = [self.item(id=f'imsg:{n}', source='imessage', ts=1_800_000_000) for n in (1, 2, 3)]
            result = {'imessage': {'cursor': 3, 'items': chat, 'drops': {}, 'scanned': 3}}
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            hits = [{'id': i, 'reason': 'r', 'urgency': 'today'} for i in ('imsg:2', 'imsg:3')]
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=(result, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'handled', side_effect=[({'imsg:1': 'answered'}, {}), ({'imsg:3': 'robob_chat'}, {})]) as handled, \
                 patch.object(t, 'classify', return_value=(hits, {'cost_usd': 0})) as model, patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            self.assertEqual([i['id'] for i in model.call_args[0][0]], ['imsg:2', 'imsg:3'])
            self.assertEqual([h['id'] for h in handled.call_args[0][0]], ['imsg:2', 'imsg:3'])
            state = t.read_json(wd / 'cursor.json')
            batch = t.read_json(Path(state['outbox']['batch']))
            self.assertEqual([h['id'] for h in batch['hits']], ['imsg:2'])
            self.assertEqual((batch['dropped']['answered'], batch['dropped']['robob_chat']), (1, 1))
            self.assertNotIn('imsg:3', state['outbox']['event'])


class ChargeTests(unittest.TestCase):
    """Card alerts go through money-cases before the classifier (owner rule, nightly 2026-10-24)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.mc = t.load_module('test_money_cases', t.MONEY_CASES)
        self.now = 1_800_000_000.0
        self.rows = []

        def search(query, since, until=None, source=None, n=20, deadline=None, **_options):
            # Terms are AND'ed; "a OR b" is one term, as in msgs search.
            groups, prev = [], 'OR'
            for tok in query.split(' '):
                if tok == 'OR':
                    prev = 'OR'
                    continue
                if prev != 'OR' or not groups:
                    groups.append([])
                groups[-1].append(tok.strip('"').lower())
                prev = tok
            return [r for r in self.rows if (source is None or r['source'] == source)
                    and all(any(w in r['text'].lower() for w in g) for g in groups)]
        self.patches = [patch.object(self.mc, 'DATA', self.tmp / 'money'),
                        patch.object(t, 'chat_down', return_value=(False, '')),
                        patch.object(self.mc.charges, 'search', search),
                        patch.object(self.mc.charges, 'show', lambda row, deadline=None, **_options: row['text']),
                        patch.object(self.mc.charges, 'owner_texts', lambda since, until, deadline=None, **_options: []),
                        patch.object(t, 'load_module', return_value=self.mc)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def alert(self, n, amount, merchant, age):
        return {'id': f'imsg:{n}', 'source': 'imessage', 'sender': 'EmiratesNBD', 'subject': '', 'ts': self.now - age,
                'preview': f'Purchase of EUR {amount} with Credit Card ending 1111 at {merchant}, Amsterdam. Avl Cr. Limit'}

    def run_triage(self, items, hits=()):
        wd = self.tmp / 'wd'
        wd.mkdir(exist_ok=True)
        if not (wd / 'cursor.json').exists():
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': []})
        result = {'imessage': {'cursor': 9, 'items': items, 'drops': {}, 'scanned': len(items)}}
        args = types.SimpleNamespace(dry_run_hours=None, report=None)
        with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
             patch.object(t.time, 'time', return_value=self.now), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(t, 'collect', return_value=(result, {})), patch.object(t, 'build_context', return_value={}), \
             patch.object(t, 'handled', return_value=({}, {})), \
             patch.object(t, 'classify', return_value=(list(hits), {'cost_usd': 0})) as model, patch('builtins.print'):
            self.assertEqual(t.run(args), 0)
        return model, t.read_json(wd / 'cursor.json'), [json.loads(l) for l in (wd / 'diagnostics' / 'runs.jsonl').read_text().splitlines()]

    def questions(self):
        # Test runs aren't the live watcher, so they keep a copy of the money books in their folder.
        return {q['amount']: q for q in self.mc.load_questions(self.tmp / 'wd' / 'scratch-money')['questions']}

    def renewal(self, last4='5542', source='email'):
        return {'id': 'mail:renewal:1' if source == 'email' else 'imsg:123', 'source': source,
                'sender': 'ElevenLabs <billing@elevenlabs.io>', 'subject': 'Subscription renewal',
                'preview': 'Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 '
                           f'using card ending in {last4}', 'ts': self.now - 60, 'list_unsubscribe': True}

    def check_dead_renewal(self, source):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        item = self.renewal(source=source)
        model, state, runs = self.run_triage([item])
        cases = self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases']
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]['id'], 'renewal-elevenlabs-2026-11-11')
        self.assertEqual(cases[0]['history'][0]['source'], item['id'])
        model.assert_not_called()
        self.assertEqual(state['queue'], [])
        self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
        self.assertEqual(self.mc.load(self.mc.DATA)['cases'], [])

    def test_dead_card_renewal_mail_is_a_case_and_dropped_before_classifier(self):
        self.check_dead_renewal('email')

    def test_dead_card_renewal_sms_is_a_case_and_dropped_before_classifier(self):
        self.check_dead_renewal('imessage')

    def test_duplicate_renewals_are_handled_in_batch_on_replay_and_after_closure(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        items = [self.renewal(source='email'), self.renewal(source='imessage')]
        model, state, runs = self.run_triage(items)
        model.assert_not_called()
        self.assertEqual(state['queue'], [])
        self.assertEqual(runs[-1]['dropped']['renewal_case'], 2)
        data = self.tmp / 'wd' / 'scratch-money'
        self.assertEqual(len(self.mc.load(data)['cases']), 1)
        for closed in (False, True):
            with self.subTest(closed=closed):
                if closed:
                    self.mc.close(data, 'renewal-elevenlabs-2026-11-11', 'moved card')
                model, _, runs = self.run_triage(items)
                model.assert_not_called()
                self.assertEqual(runs[-1]['dropped']['renewal_case'], 2)
                self.assertEqual(len(self.mc.load(data)['cases']), 1)
        self.assertEqual(self.mc.load(data)['cases'][0]['status'], 'closed')

    def test_live_card_renewal_passes_through_without_a_case(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        item = self.renewal('2342')
        model, _, runs = self.run_triage([item])
        self.assertEqual(model.call_args[0][0][0]['id'], item['id'])
        self.assertNotIn('renewal_case', runs[-1]['dropped'])
        self.assertEqual(self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases'], [])
        rows = self.mc.load_subscriptions(self.tmp / 'wd' / 'scratch-money')['subscriptions']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['last4'], '2342')

    def test_registered_charge_is_explained_and_rolls_only_scratch_books(self):
        due = t.dt.datetime.fromtimestamp(self.now, self.mc.TZ).date().isoformat()
        self.mc.sub_change(self.mc.DATA, 'acme', dict(merchant='Acme', last4='1111', amount='100',
                           currency='EUR', cadence='monthly', next_renewal=due), 'add')
        item = self.alert(90, '100', 'Acme', 600)
        reasons, held, error = t.charge_checks([item], self.now, False, wd=self.tmp / 'subs')
        self.assertIsNone(error)
        self.assertEqual(reasons, {item['id']: 'charge_explained'})
        self.assertFalse(held)
        self.assertEqual(self.mc.load_subscriptions(self.mc.DATA)['subscriptions'][0]['next_renewal'], due)
        row = self.mc.load_subscriptions(self.tmp / 'subs' / 'scratch-money')['subscriptions'][0]
        self.assertEqual(row['next_renewal'], self.mc.sub_next(due, 'monthly'))

    def test_registered_merchant_with_wrong_amount_still_reaches_classifier(self):
        due = t.dt.datetime.fromtimestamp(self.now, self.mc.TZ).date().isoformat()
        self.mc.sub_change(self.mc.DATA, 'acme', dict(merchant='Acme', last4='1111', amount='100',
                           currency='EUR', cadence='monthly', next_renewal=due), 'add')
        item = self.alert(91, '200', 'Acme', 600)
        model, _, runs = self.run_triage([item])
        self.assertEqual(model.call_args[0][0][0]['id'], item['id'])
        self.assertNotIn('charge_explained', runs[-1]['dropped'])

    def test_dry_charge_matching_does_not_roll_live_register(self):
        due = t.dt.datetime.fromtimestamp(self.now, self.mc.TZ).date().isoformat()
        self.mc.sub_change(self.mc.DATA, 'acme', dict(merchant='Acme', last4='1111', amount='100',
                           currency='EUR', cadence='monthly', next_renewal=due), 'add')
        before = (self.mc.DATA / 'subscriptions.json').read_bytes()
        reasons, _, error = t.charge_checks([self.alert(92, '100', 'Acme', 600)], self.now, True, wd=self.tmp / 'dry-subs')
        self.assertIsNone(error)
        self.assertEqual(reasons, {'imsg:92': 'charge_explained'})
        self.assertEqual((self.mc.DATA / 'subscriptions.json').read_bytes(), before)

    def test_generic_renewals_from_different_sender_domains_create_separate_cases(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        items = []
        for vendor in ('elevenlabs', 'acme'):
            item = self.renewal()
            item.update(id='mail:' + vendor, sender=f'"Notifications@Work" <billing@notifications.{vendor}.example>',
                        preview='Your monthly subscription will renew on 11 Nov 2026 for USD 118.80 '
                                'using card ending in 5542')
            items.append(item)
        model, _, runs = self.run_triage(items)
        model.assert_not_called()
        self.assertEqual(runs[-1]['dropped']['renewal_case'], 2)
        cases = self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases']
        self.assertEqual({c['merchant'] for c in cases},
                         {'notifications.elevenlabs.example', 'notifications.acme.example'})

    def test_sender_wording_changes_and_domain_punctuation_do_not_reopen_or_merge_cases(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        model, _, _ = self.run_triage([self.renewal()])
        model.assert_not_called()
        data = self.tmp / 'wd' / 'scratch-money'
        self.mc.close(data, 'renewal-elevenlabs-2026-11-11', 'cancelled')
        item = self.renewal()
        item.update(id='mail:generic', preview=item['preview'].replace('ElevenLabs Pro plan', 'subscription'))
        model, _, runs = self.run_triage([item])
        model.assert_not_called()
        self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
        self.assertEqual(len(self.mc.load(data)['cases']), 1)
        for n, domain in enumerate(('notifications.elevenlabs.io', 'notifications-elevenlabs.io')):
            item = self.renewal()
            item.update(id=f'mail:domain-{n}', sender=f'billing@{domain}',
                        preview=item['preview'].replace('ElevenLabs Pro plan', 'subscription'))
            model, _, runs = self.run_triage([item])
            model.assert_not_called()
            self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
            newest = self.mc.load(data)['cases'][-1]
            self.assertEqual(newest['renewal_identity'], domain)
            self.assertEqual(newest['status'], 'open')
            self.mc.close(data, newest['id'], 'cancelled')
        self.assertEqual(len(self.mc.load(data)['cases']), 3)

    def test_generic_email_and_named_sms_reuse_closed_case_in_either_arrival_order(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        for email_first in (False, True):
            with self.subTest(email_first=email_first):
                root = self.tmp / ('email-first' if email_first else 'sms-first')
                root.mkdir()
                email, sms = self.renewal(), self.renewal(source='imessage')
                email['preview'] = email['preview'].replace('ElevenLabs Pro plan', 'subscription')
                sms['sender'] = 'ElevenLabs'
                items = (email, sms) if email_first else (sms, email)
                with patch.object(self, 'tmp', root):
                    model, _, _ = self.run_triage([items[0]])
                    model.assert_not_called()
                    data = root / 'wd' / 'scratch-money'
                    case = self.mc.load(data)['cases'][0]
                    self.mc.close(data, case['id'], 'cancelled')
                    model, _, runs = self.run_triage([items[1]])
                    model.assert_not_called()
                    self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
                    self.assertEqual(len(self.mc.load(data)['cases']), 1)
                    self.assertEqual(self.mc.load(data)['cases'][0]['status'], 'closed')

    def test_sms_first_cannot_absorb_multiple_email_domains(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        sms = self.renewal(source='imessage')
        sms['sender'] = 'ElevenLabs'
        self.run_triage([sms])
        data = self.tmp / 'wd' / 'scratch-money'
        self.mc.close(data, 'renewal-elevenlabs-2026-11-11', 'cancelled')
        for n, domain in enumerate(('elevenlabs.io', 'alerts.elevenlabs.example')):
            item = self.renewal()
            item.update(id=f'mail:identity-{n}', sender='billing@' + domain,
                        preview=item['preview'].replace('ElevenLabs Pro plan', 'subscription'))
            model, _, runs = self.run_triage([item])
            model.assert_not_called()
            self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
        cases = self.mc.load(data)['cases']
        self.assertEqual({c['renewal_identity']: c['status'] for c in cases},
                         {'elevenlabs.io': 'closed', 'alerts.elevenlabs.example': 'open'})

    def test_dotted_sms_merchant_binds_its_email_and_stays_closed_after_other_domain(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        sms = self.renewal(source='imessage')
        sms.update(sender='Boat.dev', preview=sms['preview'].replace('ElevenLabs Pro', 'Boat.dev Pro'))
        self.run_triage([sms])
        data = self.tmp / 'wd' / 'scratch-money'
        self.mc.close(data, 'renewal-boat-dev-2026-11-11', 'cancelled')
        for n, domain in enumerate(('boat.dev', 'boatdev.com', 'boat.dev')):
            item = self.renewal()
            item.update(id=f'mail:dotted-{n}', sender='billing@' + domain,
                        preview=item['preview'].replace('ElevenLabs Pro plan', 'subscription'))
            model, _, runs = self.run_triage([item])
            model.assert_not_called()
            self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)
        cases = self.mc.load(data)['cases']
        self.assertEqual({c['renewal_identity']: c['status'] for c in cases},
                         {'boat.dev': 'closed', 'boatdev.com': 'open'})

    def test_one_off_notices_stay_unhandled_with_billing_subject_markers(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        for subject in ('Next billing date', 'Next billing date: 11 Nov 2026'):
            for purpose in ('hotel reservation', 'flight booking', 'payment plan', 'installment'):
                with self.subTest(subject=subject, purpose=purpose):
                    item = self.renewal()
                    item.update(subject=subject, list_unsubscribe=False, preview='You will be charged USD 118.80 on 11 Nov 2026 '
                                f'for your {purpose} using card ending in 5542.')
                    model, _, runs = self.run_triage([item])
                    self.assertEqual(model.call_args[0][0][0]['id'], item['id'])
                    self.assertNotIn('renewal_case', runs[-1]['dropped'])
        self.assertEqual(self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases'], [])

    def test_cancelled_renewals_and_one_off_charges_pass_through_without_cases(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        texts = [
            'Your subscription renewal on 11 Nov 2026 for USD 118.80 using card ending in 5542 has been cancelled.',
            'You will be charged USD 118.80 on 11 Nov 2026 for your hotel reservation using card ending in 5542.',
            "Your ElevenLabs Pro plan doesn't auto-renew on 11 Nov 2026 for USD 118.80 using card ending in 5542.",
            'Your ElevenLabs Pro plan doesn’t auto-renew on 11 Nov 2026 for USD 118.80 using card ending in 5542.',
            'Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 using card ending in 5542. Auto-renewal is currently off.',
            'Your ElevenLabs Pro subscription will not be charged USD 118.80 on 11 Nov 2026 using card ending in 5542.',
        ]
        for text in texts:
            with self.subTest(text=text):
                item = self.renewal()
                item.update(subject='Next billing date: 11 Nov 2026', list_unsubscribe=False, preview=text)
                model, _, runs = self.run_triage([item])
                self.assertEqual(model.call_args[0][0][0]['id'], item['id'])
                self.assertNotIn('renewal_case', runs[-1]['dropped'])
                self.assertEqual(self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases'], [])

    def test_full_message_rejection_survives_queueing_for_email_and_sms(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        for source in ('email', 'imessage'):
            with self.subTest(source=source):
                item = self.renewal(source=source)
                item.update(subject='Confirmation', list_unsubscribe=False, renewal_notice=None)
                model, _, runs = self.run_triage([item])
                self.assertEqual(model.call_args[0][0][0]['id'], item['id'])
                self.assertNotIn('renewal_case', runs[-1]['dropped'])
                self.assertEqual(self.mc.load(self.tmp / 'wd' / 'scratch-money')['cases'], [])

    def test_dry_renewal_tracking_uses_its_own_scratch_books_even_at_live_path(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        before = (self.mc.DATA / 'cards.json').read_bytes()
        wd = self.tmp / 'dry'
        with patch.object(t, 'LIVE', wd):
            reasons, error = t.renewal_checks([self.renewal()], self.now, True, wd=wd)
        self.assertIsNone(error)
        self.assertEqual(reasons, {'mail:renewal:1': 'renewal_case'})
        self.assertEqual(self.mc.load(self.mc.DATA)['cases'], [])
        self.assertEqual((self.mc.DATA / 'cards.json').read_bytes(), before)
        self.assertEqual(len(self.mc.load(wd / 'scratch-renewals')['cases']), 1)

    def test_dry_runs_track_renewals_after_fast_or_slow_collection(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        for delay in (0, 25, 100):
            with self.subTest(delay=delay):
                wd = self.tmp / f'dry-{delay}'
                clock = [self.now]
                def collect(*args):
                    clock[0] += delay
                    return {'mail': {'cursor': {}, 'items': [self.renewal()], 'drops': {}, 'scanned': 1}}, {}
                args = types.SimpleNamespace(dry_run_hours=2, report=str(wd / 'report.json'))
                with patch.dict(t.os.environ, {'WATCH_DIR': str(wd)}), \
                     patch.object(t.time, 'time', side_effect=lambda: clock[0]), \
                     patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                     patch.object(t, 'collect', side_effect=collect), patch.object(t, 'build_context', return_value={}), \
                     patch.object(t, 'handled', return_value=({}, {})), \
                     patch.object(t, 'classify') as model, patch('builtins.print'):
                    self.assertEqual(t.run(args), 0)
                model.assert_not_called()
                report = t.read_json(wd / 'report.json')
                self.assertEqual(report['dropped']['renewal_case'], 1)
                self.assertNotIn('charge_check_errors', report)
                self.assertEqual(len(self.mc.load(wd / 'scratch-renewals')['cases']), 1)
        self.assertEqual(self.mc.load(self.mc.DATA)['cases'], [])

    def test_renewal_tracking_stops_when_budget_is_spent(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        reasons, error = t.renewal_checks([self.renewal()], self.now, False,
                                        deadline=time.time() - 1, wd=self.tmp / 'expired')
        self.assertEqual(reasons, {})
        self.assertIn('out of time', error)
        self.assertEqual(self.mc.load(self.tmp / 'expired' / 'scratch-money')['cases'], [])

    def test_failed_renewal_write_keeps_the_item_queued_for_the_next_tick(self):
        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
        with patch.object(self.mc, 'renewal_case', side_effect=self.mc.CheckTimeout('renewal tracking out of time')):
            model, state, runs = self.run_triage([self.renewal()])
        model.assert_not_called()
        self.assertEqual([i['id'] for i in state['queue']], ['mail:renewal:1'])
        self.assertIn('renewal tracking out of time', runs[-1]['charge_check_errors'])
        model, state, runs = self.run_triage([])
        model.assert_not_called()
        self.assertEqual(state['queue'], [])
        self.assertEqual(runs[-1]['dropped']['renewal_case'], 1)

    def test_explained_waiting_held_and_unexplained_alerts(self):
        self.rows = [{'id': 1, 'source': 'email', 'from_me': 0, 'ts': self.now - 30, 'sender': 'Globex <r@globex.example>',
                      'subject': 'Your Globex receipt', 'text': 'Your globex receipt. Total EUR 20.00'},
                     {'id': 2, 'source': 'imessage', 'from_me': 0, 'ts': self.now - 90 * 86400, 'sender': 'EmiratesNBD',
                      'subject': '', 'text': 'Purchase of EUR 9.00 with Credit Card ending 1111 at initech * PENDING, '
                                             'Amsterdam. Avl Cr. Limit'}]
        items = [self.alert(1, '20.00', 'GLOBEX', 600), self.alert(2, '30.00', 'INITECH * PENDING', 600),
                 self.alert(3, '40.00', 'HOOLI', 60), self.alert(4, '50.00', 'UMBRELLA', 600)]
        model, state, runs = self.run_triage(items, [{'id': 'imsg:4', 'reason': 'unknown charge', 'urgency': 'today'}])
        sent = model.call_args[0][0]
        self.assertEqual([i['id'] for i in sent], ['imsg:4'])
        self.assertIn('money-cases q-', sent[0]['charge_check'])
        self.assertEqual([i['id'] for i in state['queue']], ['imsg:3'])
        self.assertEqual(runs[-1]['held_for_receipt'], 1)
        self.assertEqual((runs[-1]['dropped']['charge_explained'], runs[-1]['dropped']['charge_wait']), (1, 1))
        qs = self.questions()
        self.assertEqual((qs['20.00']['status'], qs['30.00']['wait_until'] is not None, qs['50.00']['passed'],
                          qs['40.00']['passed']), ('closed', True, True, False))
        self.assertEqual(self.mc.load_questions()['questions'], [])

    def test_delegated_purchase_is_explained_before_the_classifier(self):
        self.mc.note_purchase(self.mc.DATA, 'CHATGPT', '1920', 'EUR', '1111', 'owner', 'thread:purchase',
                              'invoice-4', now=dt.datetime.fromtimestamp(self.now - 660, self.mc.TZ))
        item = self.alert(77, '1920.00', 'CHATGPT', 600)
        model, state, runs = self.run_triage([item])
        model.assert_not_called()
        self.assertEqual(state['queue'], [])
        self.assertEqual(runs[-1]['dropped']['charge_explained'], 1)

    def test_an_unexplained_charge_goes_on_even_when_the_classifier_skips_it(self):
        model, state, runs = self.run_triage([self.alert(4, '50.00', 'UMBRELLA', 600)])
        self.assertEqual(runs[-1]['hits'], 1)
        self.assertTrue(self.questions()['50.00']['passed'])

    def test_a_held_alert_goes_on_once_it_settles_and_a_bank_copy_isnt_sent_twice(self):
        first = self.alert(3, '40.00', 'HOOLI', 60)
        model, state, _ = self.run_triage([first])
        self.assertFalse(model.called)
        self.now += t.CHARGE_SETTLE
        copy = {**self.alert(5, '40.00', 'HOOLI', 60), 'id': 'mail:icloud:1:5', 'source': 'email',
                'sender': 'alert@emiratesnbd.com'}
        model, state, runs = self.run_triage([copy])
        self.assertEqual([i['id'] for i in model.call_args[0][0]], ['imsg:3'])
        self.assertEqual(state['queue'], [])
        self.assertEqual(runs[-1]['dropped']['charge_asked'], 1)

    def test_money_cases_failing_leaves_alerts_to_the_classifier(self):
        with patch.object(t, 'load_module', side_effect=SyntaxError('broken')):
            model, state, runs = self.run_triage([self.alert(1, '20.00', 'GLOBEX', 60)])
        self.assertEqual([i['id'] for i in model.call_args[0][0]], ['imsg:1'])
        self.assertIn('SyntaxError', runs[-1]['charge_check_errors'])

    def test_the_banks_sms_and_email_in_one_run_go_on_once(self):
        sms = self.alert(1, '50.00', 'UMBRELLA', 600)
        mail = {**self.alert(2, '50.00', 'UMBRELLA', 590), 'id': 'mail:icloud:1:2', 'source': 'email',
                'sender': 'alert@emiratesnbd.com'}
        model, state, runs = self.run_triage([sms, mail])
        self.assertEqual([i['id'] for i in model.call_args[0][0]], ['imsg:1'])
        self.assertEqual(runs[-1]['dropped']['charge_asked'], 1)

    def test_a_decline_after_the_receipt_budget_is_spent_still_reaches_him(self):
        decline = {'id': 'imsg:9', 'source': 'imessage', 'sender': 'EmiratesNBD', 'subject': '', 'ts': self.now - 60,
                   'preview': 'Transaction of AED 120.00 on your Card 1111 at GLOBEX was declined'}
        # A deadline already in the past means the receipt budget is spent.
        reasons, held, error = t.charge_checks([decline], self.now, False, self.now - 1)
        self.assertEqual((reasons, held), ({}, set()))
        self.assertIsNotNone(decline.get('charge_question'))
        self.assertNotIn(t.UNCHECKED, error or '')

    def test_alerts_the_budget_never_reached_wait_unless_they_are_old(self):
        items = [self.alert(1, '20.00', 'GLOBEX', 60), self.alert(2, '30.00', 'INITECH', 2 * t.CHARGE_STALL)]
        with patch.object(t, 'late', return_value=True):
            reasons, held, error = t.charge_checks(items, self.now, False, self.now)
        self.assertEqual((reasons, held, error), ({}, {'imsg:1'}, t.UNCHECKED))
        self.assertEqual(t.charge_checks(items, self.now, True, None)[1], set())


ROBOB = '+19362300565'
MONI = '+971500000001'
BOB = '+971500000002'


def chat_db(path, messages, chats):
    """Minimal chat.db: messages are (rowid, chat_id, sender or None for the owner, seconds, reaction[, extra
    columns]). A chat with more than one member is a group."""
    import sqlite3
    c = sqlite3.connect(path)
    c.executescript('''
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, subject TEXT,
            handle_id INTEGER, is_from_me INTEGER, date INTEGER, associated_message_type INTEGER DEFAULT 0,
            is_system_message INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_spam INTEGER DEFAULT 0,
            date_retracted INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 1,
            error INTEGER DEFAULT 0, thread_originator_guid TEXT, associated_message_guid TEXT);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, style INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    ''')
    handles = {}
    def handle(address):
        if address not in handles:
            handles[address] = c.execute('INSERT INTO handle (id) VALUES (?)', (address,)).lastrowid
        return handles[address]
    for chat_id, members in chats.items():
        c.execute('INSERT INTO chat VALUES (?, ?, ?, ?)', (chat_id, f'chat{chat_id}', '', 43 if len(members) > 1 else 45))
        for address in members:
            c.execute('INSERT INTO chat_handle_join VALUES (?, ?)', (chat_id, handle(address)))
    for rowid, chat_id, sender, seconds, reaction, *extra in messages:
        date = int((seconds - t.APPLE_EPOCH) * 1e9)
        c.execute('INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type) VALUES (?,?,?,?,?,?,?)',
                  (rowid, f'g{rowid}', f'text {rowid}', handle(sender) if sender else 0, int(sender is None), date, reaction))
        for column, value in (extra[0] if extra else {}).items():
            c.execute(f'UPDATE message SET {column}=? WHERE ROWID=?', (value, rowid))
        c.execute('INSERT INTO chat_message_join VALUES (?, ?, ?)', (chat_id, rowid, date))
    c.commit()
    c.close()


class ChatFollowUpTests(unittest.TestCase):
    """Chats Robob is in, and messages already answered, never reach the owner."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name)
        (home / 'Library/Messages').mkdir(parents=True)
        (home / '.config/spectrum-bridge').mkdir(parents=True)
        (home / '.config/spectrum-bridge/config.json').write_text(json.dumps({'sendblueNumber': ROBOB}))
        (home / 'data').mkdir()
        (home / 'data/settings.json').write_text(json.dumps({}))
        self.home = home
        self.patches = [patch.object(t, 'HOME', home), patch.object(t, 'DATA', home / 'data')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def imsg(self, rowid, ts):
        return {'id': f'imsg:{rowid}', 'source': 'imessage', 'ts': ts}

    def test_robob_lines_come_from_the_bridge_and_settings(self):
        self.assertEqual(t.robob_lines({'robob_lines': ['+1 (555) 010-0000', 'Bot@Example.com']}),
                         {ROBOB, '+15550100000', 'bot@example.com'})
        (self.home / '.config/spectrum-bridge/config.json').unlink()
        self.assertEqual(t.robob_lines({}), set())

    def test_group_with_a_robob_line_is_dropped_and_others_stay(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db',
                [(1, 10, MONI, now - 60, 0), (2, 20, BOB, now - 50, 0), (3, 30, ROBOB, now - 40, 0)],
                {10: [MONI, ROBOB], 20: [BOB], 30: [ROBOB]})
        config = {'excluded_imessage_chat_ids': [], 'excluded_imessage_identifiers': []}
        with patch.object(t, 'settings', return_value=config):
            result = t.collect_imessage(0, now)
        self.assertEqual([i['id'] for i in result['items']], ['imsg:2'])
        self.assertEqual(result['drops'], {'robob_chat': 2})
        self.assertEqual(result['dropped'], [['imsg:1', 'robob_chat'], ['imsg:3', 'robob_chat']])

    def test_imessage_answered_later_by_the_owner_or_a_robob_tapback(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db', [
            (1, 10, MONI, now - 300, 0), (2, 10, None, now - 200, 0),       # he replied after it
            (3, 20, BOB, now - 300, 0), (4, 20, ROBOB, now - 100, 2006, {'associated_message_guid': 'p:0/g3'}),  # Robob tapped it
            (5, 30, MONI, now - 300, 0), (6, 30, MONI, now - 100, 0),       # only her again
            (7, 40, None, now - 400, 0), (8, 40, BOB, now - 300, 0),        # his text came before it
        ], {10: [MONI], 20: [BOB, ROBOB], 30: [MONI], 40: [BOB]})
        items = [self.imsg(1, now - 300), self.imsg(3, now - 300), self.imsg(5, now - 300), self.imsg(8, now - 300)]
        self.assertEqual(t.answered(items), ({'imsg:1', 'imsg:3'}, {}))

    def test_group_answers_must_target_the_message_and_failed_or_withdrawn_ones_never_count(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db', [
            # Group: he swipe-replied to Bob, not to Moni's question; then to Moni's other message.
            (1, 10, MONI, now - 300, 0), (2, 10, BOB, now - 290, 0),
            (3, 10, None, now - 280, 0, {'thread_originator_guid': 'g2'}),
            (4, 10, MONI, now - 270, 0), (5, 10, None, now - 260, 0, {'thread_originator_guid': 'g4'}),
            (6, 10, MONI, now - 250, 0), (7, 10, None, now - 240, 2001, {'associated_message_guid': 'p:0/g6'}),
            # Direct chats: a failed send, an unsent one, a retracted one and a removed tapback.
            (11, 21, BOB, now - 300, 0), (12, 21, None, now - 200, 0, {'error': 4, 'is_sent': 0}),
            (13, 22, BOB, now - 300, 0), (14, 22, None, now - 200, 0, {'is_sent': 0}),
            (15, 23, BOB, now - 300, 0), (16, 23, None, now - 200, 0, {'date_retracted': 1}),
            (17, 24, BOB, now - 300, 0), (18, 24, None, now - 200, 3001, {'associated_message_guid': 'p:0/g17'}),
        ], {10: [MONI, BOB], 21: [BOB], 22: [BOB], 23: [BOB], 24: [BOB]})
        items = [self.imsg(n, now - 300) for n in (1, 4, 6, 11, 13, 15, 17)]
        self.assertEqual(t.answered(items), ({'imsg:4', 'imsg:6'}, {}))

    def wa_db(self, rows):
        import sqlite3
        (self.home / '.wacli').mkdir()
        c = sqlite3.connect(self.home / '.wacli/wacli.db')
        c.execute('CREATE TABLE messages (rowid INTEGER PRIMARY KEY, chat_jid TEXT, msg_id TEXT, ts INTEGER, from_me INTEGER, '
                  'quoted_msg_id TEXT, reaction_to_id TEXT, reaction_emoji TEXT, revoked INTEGER DEFAULT 0, deleted_at INTEGER)')
        for rowid, jid, ts, from_me, *extra in rows:
            c.execute('INSERT INTO messages (rowid, chat_jid, msg_id, ts, from_me) VALUES (?,?,?,?,?)', (rowid, jid, f'w{rowid}', ts, from_me))
            for column, value in (extra[0] if extra else {}).items():
                c.execute(f'UPDATE messages SET {column}=? WHERE rowid=?', (value, rowid))
        c.commit()
        c.close()

    def test_whatsapp_answered_later_by_the_owner(self):
        self.wa_db([
            (1, 'a@s.whatsapp.net', 100, 0), (2, 'a@lid', 100, 1),     # same second, later row, other id
            (3, 'b@s.whatsapp.net', 100, 0), (4, 'b@s.whatsapp.net', 90, 1),
            (5, 'c@s.whatsapp.net', 100, 0), (6, 'c@s.whatsapp.net', 120, 1, {'revoked': 1}),
            (7, 'd@s.whatsapp.net', 100, 0), (8, 'd@s.whatsapp.net', 120, 1, {'reaction_to_id': 'w7', 'reaction_emoji': ''}),
            # Group: a reply to someone else doesn't answer her; a quote or a reaction on hers does.
            (10, 'g@g.us', 100, 0), (11, 'g@g.us', 101, 0), (12, 'g@g.us', 120, 1, {'quoted_msg_id': 'w11'}),
            (13, 'g@g.us', 130, 1, {'quoted_msg_id': 'w14'}), (14, 'g@g.us', 100, 0),
            (15, 'g@g.us', 100, 0), (16, 'g@g.us', 140, 1, {'reaction_to_id': 'w15', 'reaction_emoji': '👍'})])
        wa = types.SimpleNamespace(resolve=lambda con, jid: [jid, jid.replace('@s.whatsapp.net', '@lid')])
        items = [{'id': f'wa:{n}', 'source': 'whatsapp', 'ts': 100, 'chat_jid': jid, 'message_id': f'w{n}'}
                 for n, jid in ((1, 'a@s.whatsapp.net'), (3, 'b@s.whatsapp.net'), (5, 'c@s.whatsapp.net'),
                                (7, 'd@s.whatsapp.net'), (10, 'g@g.us'), (14, 'g@g.us'), (15, 'g@g.us'))]
        with patch.object(t, 'load_module', return_value=wa):
            self.assertEqual(t.answered(items), ({'wa:1', 'wa:14', 'wa:15'}, {}))

    def test_unreadable_store_answers_nothing(self):
        done, errors = t.answered([self.imsg(1, 0)])
        self.assertEqual(done, set())
        self.assertIn('imessage', errors)

    def test_unreadable_settings_drop_nothing_instead_of_stopping_the_check(self):
        chat_db(self.home / 'Library/Messages/chat.db', [(1, 10, MONI, 0, 0)], {10: [MONI, ROBOB]})
        for broken in ('{not json', None):
            path = self.home / 'data/settings.json'
            path.unlink(missing_ok=True)
            if broken is None:
                path.mkdir()
            else:
                path.write_text(broken)
            reasons, errors = t.handled([self.imsg(1, 0)])
            self.assertEqual(reasons, {})
            self.assertIn('imessage', errors)
            if broken is None:
                path.rmdir()

    def test_replayed_wake_drops_hits_answered_since(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db',
                [(1, 10, MONI, now - 300, 0), (2, 20, BOB, now - 300, 0), (3, 10, None, now - 10, 0)],
                {10: [MONI], 20: [BOB]})
        wd = self.home / 'watch'
        batch = self.home / 'batch.json'
        hits = [{**self.imsg(n, now - 300), 'urgency': 'today', 'sender': 's', 'subject': '', 'preview': 'p', 'reason': 'r'} for n in (1, 2)]
        t.atomic(batch, {'hits': hits, 'source_errors': {}})
        state = {'outbox': {'run': 'old', 'event': t.event_text(batch, hits, {}), 'batch': str(batch)}}
        event = t.replay_outbox(state, wd, 'new')
        self.assertIn('imsg:2', event)
        self.assertNotIn('imsg:1', event)
        self.assertEqual(t.read_json(batch)['handled_before_wake'], {'imsg:1': 'answered'})
        self.assertEqual(t.read_json(wd / 'cursor.json')['outbox']['event'], event)
        # Once he has answered everything, the wake is dropped instead of replayed.
        import sqlite3
        c = sqlite3.connect(self.home / 'Library/Messages/chat.db')
        c.execute('INSERT INTO message (ROWID, guid, handle_id, is_from_me, date) VALUES (4, ?, 0, 1, ?)', ('g4', int((now - t.APPLE_EPOCH) * 1e9)))
        c.execute('INSERT INTO chat_message_join VALUES (20, 4, ?)', (int((now - t.APPLE_EPOCH) * 1e9),))
        c.commit()
        c.close()
        self.assertIsNone(t.replay_outbox(state, wd, 'third'))
        self.assertNotIn('outbox', t.read_json(wd / 'cursor.json'))

    def test_a_slow_replay_that_clears_its_batch_leaves_collection_to_the_next_run(self):
        wd = self.home / 'watch'
        batch = self.home / 'batch.json'
        hits = [{**self.imsg(1, 1000), 'urgency': 'today', 'sender': 's', 'subject': '', 'preview': 'p', 'reason': 'r'}]
        t.atomic(batch, {'hits': hits, 'source_errors': {}})
        args = types.SimpleNamespace(dry_run_hours=None, report=None)
        for took, collects in ((40.0, False), (1.0, True)):
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': [],
                                          'outbox': {'run': 'old', 'event': 'e', 'batch': str(batch)}})
            ticks = [5000.0, 5000.0 + took]
            def clock():
                return ticks.pop(0) if len(ticks) > 1 else ticks[0]
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'new'}), \
                 patch.object(t, 'handled', return_value=({'imsg:1': 'answered'}, {})), \
                 patch.object(t.time, 'time', side_effect=clock), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=({'gmail': {'cursor': {}, 'items': [], 'drops': {}, 'scanned': 0}}, {})) as collect, patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            self.assertEqual(collect.called, collects)
            self.assertNotIn('outbox', t.read_json(wd / 'cursor.json'))
        logged = [json.loads(line) for line in (wd / 'diagnostics/runs.jsonl').read_text().splitlines()]
        self.assertTrue(logged[0]['collect_deferred'])

    def test_follow_up_checks_stop_at_their_deadline_and_keep_the_rest(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db',
                [(1, 10, MONI, now - 300, 0), (2, 20, BOB, now - 300, 0), (3, 30, ROBOB, now - 300, 0)],
                {10: [MONI, ROBOB], 20: [BOB], 30: [MONI]})
        items = [self.imsg(n, now - 300) for n in (1, 2, 3)]
        # A slow store takes its time per item; past the deadline nothing more is checked or dropped.
        ticks = iter([0, 0, 100, 100, 100, 100])
        with patch.object(t.time, 'time', side_effect=lambda: next(ticks, 100)):
            reasons, errors = t.handled(items, 50)
        self.assertEqual(reasons, {'imsg:1': 'robob_chat'})
        self.assertEqual(errors, {'imessage': t.UNCHECKED})
        wa = [{'id': 'wa:1', 'source': 'whatsapp', 'ts': now, 'chat_jid': 'x@s.whatsapp.net'}]
        lookups = types.SimpleNamespace(resolve=lambda *_: self.fail('no store read after the deadline'))
        with patch.object(t, 'load_module', return_value=lookups), \
             patch.object(t, 'db', return_value=sqlite3.connect(':memory:')), patch.object(t.time, 'time', return_value=100):
            self.assertEqual(t.answered(wa, 50), (set(), {'whatsapp': t.UNCHECKED}))

    def test_a_run_stops_its_follow_up_checks_in_time_for_the_runner(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': [TriageTests.item(None)]})
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            calls = []
            def handled(items, deadline=None):
                calls.append(deadline)
                return {}, {}
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=({'gmail': {'cursor': {}, 'items': [], 'drops': {}, 'scanned': 0}}, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'handled', side_effect=handled), patch.object(t.time, 'time', return_value=1000.0), \
                 patch.object(t, 'classify', return_value=([], {})), patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
        self.assertEqual(calls, [1000 + t.EARLY_BY, 1000 + t.LATE_BY])
        # Slowest case: the last item starts just before LATE_BY and waits out a locked store.
        self.assertLess(t.LATE_BY + 7 + 3, 60)
        self.assertLess(t.EARLY_BY, t.CLASSIFY_BY)

    def test_candidates_queued_or_waiting_to_wake_are_dropped_once_their_chat_has_robob(self):
        now = 1_800_000_000
        # Robob joined Moni's group after her message was queued; Bob's chat stays without him.
        chat_db(self.home / 'Library/Messages/chat.db',
                [(1, 10, MONI, now - 300, 0), (2, 20, BOB, now - 300, 0), (3, 30, ROBOB, now - 300, 0)],
                {10: [MONI, ROBOB], 20: [BOB], 30: [MONI]})
        items = [self.imsg(n, now - 300) for n in (1, 2, 3)]
        self.assertEqual(t.handled(items), ({'imsg:1': 'robob_chat', 'imsg:3': 'robob_chat'}, {}))
        wd = self.home / 'watch'
        batch = self.home / 'batch.json'
        hits = [{**i, 'urgency': 'today', 'sender': 's', 'subject': '', 'preview': 'p', 'reason': 'r'} for i in items]
        t.atomic(batch, {'hits': hits, 'source_errors': {}})
        state = {'outbox': {'run': 'old', 'event': t.event_text(batch, hits, {}), 'batch': str(batch)}}
        event = t.replay_outbox(state, wd, 'new')
        self.assertIn('imsg:2', event)
        self.assertNotIn('imsg:1', event)
        self.assertEqual(t.read_json(batch)['handled_before_wake'], {'imsg:1': 'robob_chat', 'imsg:3': 'robob_chat'})

    def test_a_replay_keeps_exactly_its_window(self):
        now = 1_800_000_000
        chat_db(self.home / 'Library/Messages/chat.db',
                [(1, 20, BOB, now - 10 * 3600, 0), (2, 20, BOB, now - 4 * 3600, 0), (3, 20, BOB, now - 600, 0)],
                {20: [BOB]})
        config = {'excluded_imessage_chat_ids': [], 'excluded_imessage_identifiers': []}
        with patch.object(t, 'settings', return_value=config):
            hour = t.collect_imessage(0, now, since=now - 3600)
            twelve = t.collect_imessage(0, now, since=now - 12 * 3600)
            live = t.collect_imessage(0, now)
        self.assertEqual([i['id'] for i in hour['items']], ['imsg:3'])
        self.assertEqual(hour['drops'], {'before_window': 2})
        self.assertEqual([i['id'] for i in twelve['items']], ['imsg:1', 'imsg:2', 'imsg:3'])
        self.assertEqual([i['id'] for i in live['items']], ['imsg:2', 'imsg:3'])
        self.assertEqual(live['drops'], {'history_backfill': 1})

    def test_a_wake_whose_batch_was_trimmed_before_a_crash_is_rebuilt_from_the_batch(self):
        wd = self.home / 'watch'
        batch = self.home / 'batch.json'
        hits = [{**self.imsg(n, 0), 'urgency': 'today', 'sender': 's', 'subject': '', 'preview': 'p', 'reason': 'r'} for n in (1, 2)]
        stale = t.event_text(batch, hits, {})
        # The last run removed imsg:1 from the batch, then died before saving the cursor.
        t.atomic(batch, {'hits': hits[1:], 'source_errors': {}, 'handled_before_wake': {'imsg:1': 'answered'}})
        with patch.object(t, 'handled', return_value=({}, {})):
            event = t.replay_outbox({'outbox': {'run': 'old', 'event': stale, 'batch': str(batch)}}, wd, 'new')
            self.assertIn('imsg:2', event)
            self.assertNotIn('imsg:1', event)
            t.atomic(batch, {'hits': [], 'source_errors': {}})
            state = {'outbox': {'run': 'old', 'event': stale, 'batch': str(batch)}}
            self.assertIsNone(t.replay_outbox(state, wd, 'new'))
            self.assertNotIn('outbox', t.read_json(wd / 'cursor.json'))


class ReplayTests(unittest.TestCase):
    def test_a_replay_reads_its_whole_window_and_says_where_it_stopped(self):
        def pages(sizes):
            def collect_page(cursor):
                start = cursor or 0
                size = sizes[min(start // t.PAGE, len(sizes) - 1)]
                return {'items': [{'id': f'x:{start + 1}'}], 'cursor': start + size, 'drops': {'own': 1},
                        'dropped': [[f'x:{start + 2}', 'own']], 'scanned': size}
            return collect_page
        total = t.replay_pages(pages([t.PAGE, t.PAGE, 3]))
        self.assertEqual((total['scanned'], total['cursor'], total['drops']), (2 * t.PAGE + 3, 2 * t.PAGE + 3, {'own': 3}))
        self.assertEqual(len(total['items']), 3)
        self.assertNotIn('partial', total)
        with patch.object(t, 'REPLAY_PAGES', 2):
            total = t.replay_pages(pages([t.PAGE]))
        self.assertIn('not read', total['partial'])

    def test_a_dry_run_lists_every_dropped_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'replay.json'
            item = {'id': 'wa:9', 'source': 'whatsapp', 'ts': 1_800_000_000, 'sender': 'Bob', 'subject': '', 'preview': 'thanks'}
            result = {'whatsapp': {'cursor': 9, 'items': [item], 'drops': {'own': 1}, 'dropped': [['wa:8', 'own']], 'scanned': 2},
                      'mail': {'cursor': {}, 'items': [], 'drops': {'bulk': 1}, 'dropped': [['mail:a:1:5', 'bulk']], 'scanned': 1}}
            args = types.SimpleNamespace(dry_run_hours=1, report=str(report))
            with patch.dict(t.os.environ, {'WATCH_DIR': tmp}), patch.object(t, 'active_watchers', return_value=[]), \
                 patch.object(t, 'noise_rules', return_value=[]), patch.object(t, 'collect', return_value=(result, {})), \
                 patch.object(t, 'handled', return_value=({}, {})), patch.object(t, 'build_context', return_value={}), patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            self.assertEqual(sorted(map(tuple, t.read_json(report)['dropped_ids'])),
                             [('mail:a:1:5', 'bulk'), ('wa:8', 'own'), ('wa:9', 'greeting')])

    def test_a_dry_run_classifies_every_candidate_a_batch_at_a_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'replay.json'
            items = [{'id': f'wa:{n}', 'source': 'whatsapp', 'ts': 1_800_000_000, 'sender': 'Bob', 'subject': '',
                      'preview': f'can you send the invoice {n}'} for n in range(t.MAX_BATCH + 1)]
            result = {'whatsapp': {'cursor': 99, 'items': items, 'drops': {}, 'dropped': [], 'scanned': len(items)}}
            def classify(batch, context):
                return [{'id': batch[-1]['id'], 'reason': 'r', 'urgency': 'today'}], {'model': 'm', 'input_tokens': 1, 'output_tokens': 1, 'cost_usd': 0.5}
            args = types.SimpleNamespace(dry_run_hours=1, report=str(report))
            with patch.dict(t.os.environ, {'WATCH_DIR': tmp}), patch.object(t, 'active_watchers', return_value=[]), \
                 patch.object(t, 'noise_rules', return_value=[]), patch.object(t, 'collect', return_value=(result, {})), \
                 patch.object(t, 'handled', return_value=({}, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'classify', side_effect=classify) as model, patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            self.assertEqual([len(call[0][0]) for call in model.call_args_list], [t.MAX_BATCH, 1])
            out = t.read_json(report)
            self.assertEqual(out['candidate_count'], t.MAX_BATCH + 1)
            self.assertEqual([h['id'] for h in out['hits']], [f'wa:{t.MAX_BATCH - 1}', f'wa:{t.MAX_BATCH}'])
            self.assertEqual((out['usage']['input_tokens'], out['usage']['cost_usd']), (2, 1.0))


class LiveWorkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lock = Path(self.tmp.name)
        patcher = patch.object(t, 'PHONE_LOCK', self.lock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def commerce(self, stdout, code=0):
        return patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(stdout=stdout, stderr='', returncode=code))

    def test_open_payments_and_a_running_phone_task_reach_the_classifier(self):
        flow = {'flow_id': 'f1', 'app': 'noon', 'vertical': 'supermall', 'state': 'PLACED', 'order_id': None,
                'amount_minor': 12345, 'sent_seconds_ago': 1140}
        (self.lock / 'priority-hold').write_text('owner')
        now = (self.lock / 'priority-hold').stat().st_mtime + 600
        with self.commerce(json.dumps({'ok': True, 'open': [flow], 'financial_send': False})) as run, \
             patch.object(t.time, 'time', return_value=5000.0):
            work = t.live_work(now)
        self.assertEqual(run.call_args.args[0][1:], ['open-flows', '--minutes', '60'])
        # sent_at errs late by the second commerce rounds away.
        self.assertEqual(work, {'open_payments': [{'ref': 'p1', 'app': 'noon', 'vertical': 'supermall', 'state': 'PLACED',
                                                   'amount_aed': 123.45, 'minutes_ago': 19, 'sent_at': 3861.0, 'flow_id': 'f1', 'order_id': None}],
                                'phone_task': {'running': True, 'minutes': 10}})
        self.assertEqual(t.work_line(work), 'In flight: noon supermall payment AED 123.45 (19 min ago); a phone task has run for 10 min.')

    def test_nothing_in_flight_adds_no_line(self):
        with self.commerce(json.dumps({'ok': True, 'open': []})):
            work = t.live_work(1000)
        self.assertEqual(work, {'open_payments': [], 'phone_task': {'running': False}})
        self.assertIsNone(t.work_line(work))
        self.assertEqual(t.event_text('b.json', [], {}, work), 'Inbox triage: 0 candidate(s). Read full batch: b.json')

    def test_an_unreadable_journal_says_so_instead_of_looking_empty(self):
        cases = [(self.commerce(json.dumps({'ok': False, 'error': 'JOURNAL_BUSY_OR_UNAVAILABLE'}), 1), 'JOURNAL_BUSY_OR_UNAVAILABLE'),
                 (patch.object(t.subprocess, 'run', side_effect=t.subprocess.TimeoutExpired('commerce', 3)), 'TimeoutExpired'),
                 (self.commerce('not json', 1), 'JSONDecodeError')]
        for side, reason in cases:
            with side:
                work = t.live_work(1000)
            self.assertTrue(work['open_payments'].startswith('unavailable: '), work)
            self.assertIn(reason, work['open_payments'])
            self.assertIn('check order work before saying a bank prompt is not ours', t.work_line(work))

    def test_the_wake_and_batch_carry_live_work_and_a_replay_keeps_it(self):
        work = {'open_payments': [{'app': 'talabat', 'vertical': 'mart', 'state': 'PLACED', 'amount_aed': None, 'minutes_ago': 3}],
                'phone_task': {'running': False}}
        item = TriageTests.item(None, subject='A payment on your card needs your confirmation')
        wd = Path(self.tmp.name) / 'watch'
        t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': []})
        result = {'icloud': {'cursor': {'validity': 1, 'uid': 2}, 'items': [item], 'drops': {}, 'scanned': 1}}
        args = types.SimpleNamespace(dry_run_hours=None, report=None)
        with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'first'}), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(t, 'collect', return_value=(result, {})), patch.object(t, 'handled', return_value=({}, {})), \
             patch.object(t, 'build_context', return_value={'live_work': work}), \
             patch.object(t, 'classify', return_value=([{'id': item['id'], 'reason': 'ours', 'urgency': 'now'}], {})), \
             patch('builtins.print') as printed:
            self.assertEqual(t.run(args), 0)
        event = printed.call_args.args[0]
        self.assertIn('In flight: talabat mart payment (3 min ago).', event)
        state = t.read_json(wd / 'cursor.json')
        self.assertEqual(t.read_json(Path(state['outbox']['batch']))['live_work'], work)
        with patch.object(t, 'handled', return_value=({}, {})), patch.object(t, 'live_work', return_value=work):
            self.assertEqual(t.replay_outbox(state, wd, 'second'), event)


class DegradedRunTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.wd = Path(tmp.name)
        self.args = types.SimpleNamespace(dry_run_hours=None, report=None)
        self.initial = {'version': 1, 'initialized_at': 1000,
                        'cursors': {'outlook': {'validity': 1, 'uid': 7}, 'gmail': {'validity': 1, 'uid': 2}}, 'queue': [], 'pending': {}}
        t.atomic(self.wd / 'cursor.json', self.initial)
        for name, value in [('active_watchers', []), ('noise_rules', []), ('build_context', {}),
                            ('handled', ({}, {})), ('live_work', {}), ('classify', ([], {}))]:
            mocked = patch.object(t, name, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def run_check(self, run_id='degraded', fast=False):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'WATCH_DIR': str(self.wd), 'WATCH_RUN': run_id}), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = t.run_fast(self.args) if fast else t.run(self.args)
        return code, out.getvalue(), err.getvalue()

    def good(self):
        return {'cursor': {'validity': 1, 'uid': 3}, 'items': [TriageTests.item(None)], 'drops': {}, 'scanned': 1}

    def test_timeout_in_real_collect_keeps_failed_cursor_and_advances_healthy_sources(self):
        def mail(account, request):
            if account == 'outlook':
                raise t.subprocess.TimeoutExpired('mail-worker', 19)
            return self.good()
        chat = {'cursor': 42, 'items': [], 'drops': {}, 'scanned': 0}
        with patch.object(t, 'run_mail', side_effect=mail), \
             patch.object(t, 'collect_whatsapp', return_value=chat), patch.object(t, 'collect_imessage', return_value=chat):
            code, out, err = self.run_check()
        self.assertEqual(code, 0)
        self.assertEqual(out, '')
        self.assertIn('inbox-triage degraded: outlook: TimeoutExpired', err)
        state = t.read_json(self.wd / 'cursor.json')
        self.assertEqual(state['cursors']['outlook'], self.initial['cursors']['outlook'])
        self.assertEqual(state['cursors']['gmail']['uid'], 3)
        self.assertEqual(state['cursors']['imessage'], 42)

    def test_all_sources_failed_or_nothing_read_is_failure(self):
        for errors in ({s: 'TimeoutError' for s in (*t.ACCOUNTS, 'imessage', 'whatsapp')}, {}):
            with self.subTest(errors=errors), patch.object(t, 'collect', return_value=({}, errors)):
                code, out, err = self.run_check()
                self.assertEqual(code, 1)
                self.assertIn('source failure:', err)

    def test_acked_outbox_is_cleared_before_empty_degraded_run_ack(self):
        self.initial['outbox'] = {'run': 'old', 'event': 'already queued'}
        t.atomic(self.wd / 'cursor.json', self.initial)
        (self.wd / '.run-ok').write_text('old')
        result = {'gmail': {**self.good(), 'items': []}}
        with patch.object(t, 'collect', return_value=(result, {'outlook': 'TimeoutError'})):
            code, out, err = self.run_check()
            self.assertEqual((code, out), (0, ''))
            self.assertNotIn('outbox', t.read_json(self.wd / 'cursor.json'))
            # Simulate runner ackRun on a successful empty check, then another tick.
            (self.wd / '.run-ok').write_text('degraded')
            self.assertEqual(self.run_check('next')[:2], (0, ''))

    def test_unacked_outbox_replays_before_collection_and_is_not_lost(self):
        self.initial['outbox'] = {'run': 'old', 'event': 'pending event'}
        t.atomic(self.wd / 'cursor.json', self.initial)
        with patch.object(t, 'collect', return_value=({'gmail': self.good()}, {'outlook': 'TimeoutError'})) as collect:
            self.assertEqual(self.run_check()[:2], (0, 'pending event\n'))
            collect.assert_not_called()
            state = t.read_json(self.wd / 'cursor.json')
            self.assertEqual(state['outbox']['run'], 'degraded')
            (self.wd / '.run-ok').write_text('degraded')
            self.assertEqual(self.run_check('next')[:2], (0, ''))
            self.assertNotIn('outbox', t.read_json(self.wd / 'cursor.json'))

    def test_fastpath_partial_and_total_source_failures(self):
        # fastpath.py is a classifier; triage.py --fast-only owns its exit status.
        for results, expected in (({'gmail': {**self.good(), 'items': []}}, 0), ({}, 1)):
            with self.subTest(expected=expected), patch.object(t, 'collect', return_value=(results, {'outlook': 'TimeoutError'})):
                code, _, err = self.run_check(fast=True)
                self.assertEqual(code, expected)
                self.assertIn('degraded:' if expected == 0 else 'source failure:', err)

    def test_twenty_fastpath_outlook_timeouts_deliver_one_parsed_notice(self):
        data = self.wd / 'data'
        data.mkdir()
        normal = self.wd / 'inbox-triage'
        normal.mkdir()
        fast = self.wd / 'inbox-triage-fastpath'
        fast.mkdir()
        self.wd = fast
        t.atomic(fast / 'cursor.json', self.initial)
        clock = [10000]

        def mail(account, request):
            if account == 'outlook':
                raise t.subprocess.TimeoutExpired(['python3', 'triage.py', '--mail-worker'], 19)
            return {**self.good(), 'items': []}
        chat = {'cursor': 42, 'items': [], 'drops': {}, 'scanned': 0}
        with parsed_notifiers(data) as calls, patch.object(t, 'LIVE', normal), patch.object(t, 'DATA', data), \
             patch.object(t, 'money_books', return_value=data / 'money'), \
             patch.object(t.time, 'time', side_effect=lambda: clock[0]), \
             patch.object(t, 'run_mail', side_effect=mail), \
             patch.object(t, 'collect_whatsapp', return_value=chat), patch.object(t, 'collect_imessage', return_value=chat):
            for n in range(20):
                clock[0] = 10000 + n * 300
                code, out, err = self.run_check(f'replay-{n}', fast=True)
                self.assertEqual((code, out), (0, ''), err)
                self.assertIn('inbox-triage-fastpath degraded: outlook: TimeoutExpired', err)
            delivered = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertEqual(len(delivered), 1)
            self.assertTrue(delivered[0]['body']['text'].startswith('- outlook: 3 run(s)'))
            state = t.read_json(fast / 'cursor.json')
            self.assertNotIn('health_pending', state)
            self.assertEqual(state['source_health']['outlook']['alerted_at'], 10600)
            self.assertEqual(state['cursors']['outlook'], self.initial['cursors']['outlook'])
            self.assertEqual(state['cursors']['gmail']['uid'], 3)
            rows = [json.loads(line) for f in (data / 'logs').glob('*.ndjson') for line in f.read_text().splitlines()]
            for tag in ('health.delivery_failed', 'tg.cli.arguments'):
                self.assertEqual(sum(row.get('error', {}).get('tag') == tag for row in rows), 0, tag)
            print('Outlook replay: runs=20 degraded_notices=1 health.delivery_failed=0 tg.cli.arguments=0')


class SourceHealthTests(unittest.TestCase):
    # Card #14: these tests mock subprocess.run, but a test run still needs the Telegram stub override to send.
    def stub_telegram(self):
        return patch.dict('os.environ', {'ROBOB_WATCH_TELEGRAM_CLI': '/nonexistent/telegram-stub.ts'})

    def runs(self, errors_per_run, start=10_000, step=300):
        state, due = {}, []
        for n, errors in enumerate(errors_per_run):
            due.append(t.track_health(state, errors, start + n * step))
        return state, due

    def test_three_failed_runs_in_a_row_are_due_once(self):
        state, due = self.runs([{'outlook': 'RuntimeError: timeout'}] * 3 + [{'outlook': 'x'}])
        self.assertEqual(due[:3], [[], [], ['outlook']])
        self.assertEqual(state['source_health']['outlook']['streak'], 4)
        # Until it is marked sent it stays due, so a lost alert is retried next run.
        self.assertEqual(due[3], ['outlook'])

    def test_a_flapping_source_is_due_at_five_failures_in_an_hour(self):
        ok, bad = {}, {'gmail': 'TimeoutExpired: worker'}
        state, due = self.runs([bad, ok, bad, ok, bad, ok, bad, ok, bad])
        self.assertEqual([d for d in due if d], [['gmail']])
        self.assertEqual(due[-1], ['gmail'])
        # Spread over more than an hour it never adds up.
        _, due = self.runs([bad, ok, ok, ok] * 6)
        self.assertFalse(any(due))

    def test_after_an_alert_it_waits_six_hours_and_a_recovered_source_starts_over(self):
        state, bad = {}, {'outlook': 'x'}
        now = 50_000
        for n in range(3):
            due = t.track_health(state, bad, now + n * 300)
        self.assertEqual(due, ['outlook'])
        state['source_health']['outlook'].update(alerted_at=now + 600, alerts=1)
        self.assertEqual(t.track_health(state, bad, now + 900), [])
        self.assertEqual(t.track_health(state, bad, now + 600 + t.HEALTH_REALERT), ['outlook'])
        # It recovers; once the hour and the quiet period pass its entry goes.
        later = now + 600 + t.HEALTH_REALERT
        state['source_health']['outlook']['alerted_at'] = later
        self.assertEqual(t.track_health(state, {}, later + 300), ['outlook'])
        t.health_alert(state, ['outlook'], later + 300)
        with self.stub_telegram(), patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)):
            t.send_health(state, ['outlook'], t.LIVE, later + 300)
        t.track_health(state, {}, later + t.HEALTH_REALERT)
        self.assertNotIn('outlook', state['source_health'])

    def test_transient_outage_notices_escalation_and_recovery_are_once_each(self):
        state = {'read_sources': ['gmail']}
        wd = Path('/fixture/live')
        bad = {'outlook': 'TimeoutExpired: mail worker'}
        sent = types.SimpleNamespace(returncode=0, stdout='', stderr='')
        with patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', return_value=sent) as run:
            for n in range(20):
                self.tick(state, wd, bad, 10_000 + n * 300)
            self.assertEqual(run.call_count, 1)
            first = run.call_args.args[0]
            text = next(v.split('=', 1)[1] for v in first if v.startswith('--text='))
            self.assertIn('outlook', text)
            self.assertIn('provider/network', text)
            self.assertIn('Other sources are still being read', text)
            self.assertIn('cursor holds', text)
            for n in range(5):
                self.tick(state, wd, bad, 10_000 + t.HEALTH_TRANSIENT_ESCALATE + n * 300)
            self.assertEqual(run.call_count, 2)
            escalation = run.call_args.args[0]
            self.assertIn('outlook still failing after 180 min', next(v.split('=', 1)[1] for v in escalation if v.startswith('--text=')))
            self.assertIn('--severity=attention', escalation)
            self.tick(state, wd, bad, 10_000 + t.HEALTH_REALERT + 900)
            self.assertEqual(run.call_count, 2)
            self.tick(state, wd, {}, 10_000 + t.HEALTH_REALERT + 1200)
            self.assertEqual(run.call_count, 3)
            recovery = run.call_args.args[0]
            self.assertIn('outlook reading again after', next(v.split('=', 1)[1] for v in recovery if v.startswith('--text=')))
            self.tick(state, wd, {}, 10_000 + t.HEALTH_REALERT + 1500)
            self.assertEqual(run.call_count, 3)

    def test_delivered_notices_keep_six_hour_cooldown_across_flapping(self):
        for error in ('TimeoutExpired: worker', 'IMAP auth failed'):
            with self.subTest(error=error):
                state = {}
                bad = {'outlook': error}
                with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
                    for n in range(12):
                        errors = bad if n < 3 or n % 2 == 0 else {}
                        self.tick(state, t.LIVE, errors, 10_000 + n * 300)
                    # These sends succeeded; one outage and one recovery, no repeat at five/hour.
                    self.assertEqual(run.call_count, 2)
                    texts = [next(v.split('=', 1)[1] for v in c.args[0] if v.startswith('--text=')) for c in run.call_args_list]
                    self.assertNotIn('reading again', texts[0])
                    self.assertIn('outlook reading again', texts[1])
                    self.assertEqual(state['source_health']['outlook']['last_notice_at'], 10_600)
                    self.tick(state, t.LIVE, {}, 10_600 + t.HEALTH_REALERT - 1)
                    self.assertIn('outlook', state['source_health'])
                    self.tick(state, t.LIVE, {}, 10_600 + t.HEALTH_REALERT)
                    self.assertNotIn('outlook', state['source_health'])
                    for n in range(3):
                        self.tick(state, t.LIVE, bad, 10_600 + t.HEALTH_REALERT + n * 300)
                    self.assertEqual(run.call_count, 3)

    def test_cooldown_does_not_delay_escalation_of_a_new_continuous_outage(self):
        state = {}
        bad = {'outlook': 'TimeoutExpired'}
        with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            for now in (10_000, 10_300, 10_600):
                self.tick(state, t.LIVE, bad, now)
            self.tick(state, t.LIVE, {}, 10_900)
            for now in (11_200, 11_500, 11_800):
                self.tick(state, t.LIVE, bad, now)
            self.assertEqual(run.call_count, 2)
            self.tick(state, t.LIVE, bad, 11_200 + t.HEALTH_TRANSIENT_ESCALATE)
            self.assertEqual(run.call_count, 3)
            args = run.call_args.args[0]
            self.assertIn('outlook still failing after 180 min', next(v.split('=', 1)[1] for v in args if v.startswith('--text=')))
            self.tick(state, t.LIVE, bad, 11_200 + t.HEALTH_TRANSIENT_ESCALATE + 300)
            self.assertEqual(run.call_count, 3)
            self.tick(state, t.LIVE, {}, 11_200 + t.HEALTH_TRANSIENT_ESCALATE + 600)
            self.assertEqual(run.call_count, 4)
            self.tick(state, t.LIVE, {}, 11_200 + t.HEALTH_TRANSIENT_ESCALATE + 900)
            self.assertEqual(run.call_count, 4)

    def test_recovery_retry_cannot_suppress_the_next_outage_notice(self):
        state = {'read_sources': ['gmail']}
        bad = {'outlook': 'TimeoutError'}
        sent = types.SimpleNamespace(returncode=0)
        failed = types.SimpleNamespace(returncode=1, stderr='bridge down', stdout='')
        with patch.object(t.subprocess, 'run', return_value=sent) as run:
            for now in (10_000, 10_300, 10_600):
                self.tick(state, t.LIVE, bad, now)
            self.assertEqual(run.call_count, 1)
            with patch.object(t.subprocess, 'run', return_value=failed):
                self.tick(state, t.LIVE, {}, 10_900)
            pending = copy.deepcopy(state['health_pending'])
            self.tick(state, t.LIVE, bad, 11_200)
            self.assertEqual(state['source_health']['outlook']['since'], 11_200)
            args = run.call_args.args[0]
            self.assertEqual(next(v.split('=', 1)[1] for v in args if v.startswith('--key=')), pending['key'])
            self.assertEqual(next(v.split('=', 1)[1] for v in args if v.startswith('--text=')), pending['text'])
            self.tick(state, t.LIVE, bad, 11_500)
            self.tick(state, t.LIVE, bad, 11_800)
            self.assertEqual(run.call_count, 2)  # recovery retries do not erase the outage cooldown
            later = 10_600 + t.HEALTH_REALERT
            self.tick(state, t.LIVE, {}, later)
            for now in (later + 300, later + 600, later + 900):
                self.tick(state, t.LIVE, bad, now)
            self.assertEqual(run.call_count, 3)
            self.assertNotIn('reading again', next(v.split('=', 1)[1] for v in run.call_args.args[0] if v.startswith('--text=')))

    def test_outage_notice_retry_after_health_window_still_has_one_recovery(self):
        state = {}
        bad = {'outlook': 'TimeoutExpired'}
        sent = types.SimpleNamespace(returncode=0)
        failed = types.SimpleNamespace(returncode=1, stderr='bridge down', stdout='')
        with patch.object(t.subprocess, 'run', return_value=failed):
            for now in (10_000, 10_300, 10_600):
                self.tick(state, t.LIVE, bad, now)
            original = copy.deepcopy(state['health_pending'])
            self.tick(state, t.LIVE, {}, 10_900)
            self.tick(state, t.LIVE, {}, 14_500)
        self.assertIn('outlook', state['source_health'])
        with patch.object(t.subprocess, 'run', return_value=sent) as run:
            self.tick(state, t.LIVE, {}, 14_800)
            args = run.call_args.args[0]
            self.assertEqual(next(v.split('=', 1)[1] for v in args if v.startswith('--key=')), original['key'])
            self.assertEqual(next(v.split('=', 1)[1] for v in args if v.startswith('--text=')), original['text'])
            self.tick(state, t.LIVE, {}, 15_100)
            self.assertEqual(run.call_count, 2)
            args = run.call_args.args[0]
            self.assertIn('outlook reading again after 15 min', next(v.split('=', 1)[1] for v in args if v.startswith('--text=')))
            self.tick(state, t.LIVE, {}, 15_400)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(state['source_health']['outlook']['last_notice_at'], 14_800)
            self.tick(state, t.LIVE, {}, 14_800 + t.HEALTH_REALERT)
            self.assertNotIn('outlook', state['source_health'])

    def test_legacy_recovered_state_keeps_cooldown_then_allows_a_new_notice(self):
        for extra in ({}, {'recovered_at': 9000}, {'escalated_at': 8500}):
            with self.subTest(extra=extra):
                state = {'source_health': {'outlook': {'streak': 0, 'since': 8000, 'fails': [],
                         'alerted_at': 8600, 'alerts': 1, **extra}}}
                with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
                    for now in (10_000, 10_300, 10_600):
                        self.tick(state, t.LIVE, {'outlook': 'TimeoutError'}, now)
                    self.assertEqual(run.call_count, 0)
                    self.assertEqual(state['source_health']['outlook']['since'], 10_000)
                    self.assertEqual(state['source_health']['outlook']['last_notice_at'], 8600)
                    self.assertNotIn('escalated_at', state['source_health']['outlook'])
                    self.tick(state, t.LIVE, {}, 10_900)
                    for now in (30_300, 30_600, 30_900):
                        self.tick(state, t.LIVE, {'outlook': 'TimeoutError'}, now)
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(state['source_health']['outlook']['alerted_at'], 30_900)

    def test_legacy_escalation_is_the_last_notice_across_upgrade_and_recovery(self):
        for newest in (10_800, 15_000):
            with self.subTest(newest=newest):
                state = {'source_health': {'outlook': {
                    'since': 0, 'streak': 75, 'fails': [21_000, 21_300, 21_600, 21_900],
                    'alerted_at': 600, 'escalated_at': 10_800, 'notified_since': 0,
                    'last_error': 'TimeoutExpired', 'transient': True,
                    **({'last_notice_at': newest} if newest > 10_800 else {})}}}
                with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
                    self.tick(state, t.LIVE, {}, 22_200)  # upgrade and recovery at 06:10
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(state['source_health']['outlook']['last_notice_at'], newest)
                    self.tick(state, t.LIVE, {'outlook': 'TimeoutExpired'}, 22_500)
                    self.assertEqual(run.call_count, 1)  # five/hour cannot bypass the escalation cooldown
                    self.tick(state, t.LIVE, {}, 22_800)
                    self.tick(state, t.LIVE, {}, newest + t.HEALTH_REALERT - 1)
                    self.assertIn('outlook', state['source_health'])
                    self.tick(state, t.LIVE, {}, newest + t.HEALTH_REALERT)
                    self.assertNotIn('outlook', state['source_health'])

    def test_old_outage_delivery_during_new_failure_still_gets_recovery(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                state = {}
                bad = {'outlook': 'TimeoutError'}
                failed = types.SimpleNamespace(returncode=1, stderr='bridge down', stdout='')
                with patch.object(t.subprocess, 'run', return_value=failed):
                    for now in (10_000, 10_300, 10_600):
                        self.tick(state, t.LIVE, bad, now)
                    if legacy:
                        state['health_pending'].pop('notices')
                    original = copy.deepcopy(state['health_pending'])
                    self.tick(state, t.LIVE, {}, 10_900)
                with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
                    self.tick(state, t.LIVE, bad, 11_200)
                    self.assertNotIn('alerted_at', state['source_health']['outlook'])
                    self.assertEqual(next(v.split('=', 1)[1] for v in run.call_args.args[0] if v.startswith('--key=')), original['key'])
                    self.tick(state, t.LIVE, {}, 11_500)
                    self.assertEqual(run.call_count, 2)
                    args = run.call_args.args[0]
                    self.assertIn('outlook reading again after', next(v.split('=', 1)[1] for v in args if v.startswith('--text=')))
                    self.tick(state, t.LIVE, {}, 11_800)
                    self.assertEqual(run.call_count, 2)

    def test_old_escalation_delivery_still_sets_cooldown_and_recovery_obligation(self):
        # This outage's initial notice was suppressed by the previous outage's cooldown.
        state = {'source_health': {'outlook': {'streak': 4, 'since': 11_000, 'fails': [21_800],
                    'transient': True, 'last_notice_at': 10_600, 'last_error': 'TimeoutError'}},
                 'health_pending': {'key': 'old-escalation', 'text': 'outlook still failing',
                    'sources': ['outlook'], 'at': 21_800,
                    'notices': {'outlook': {'kind': 'escalation', 'since': 11_000}}}}
        with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1, stderr='bridge down', stdout='')):
            self.tick(state, t.LIVE, {}, 22_100)
        with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            self.tick(state, t.LIVE, {'outlook': 'TimeoutError'}, 22_400)
            self.assertEqual(state['source_health']['outlook']['last_notice_at'], 22_400)
            self.assertNotIn('escalated_at', state['source_health']['outlook'])
            self.tick(state, t.LIVE, {}, 22_700)
            self.assertEqual(run.call_count, 2)
            args = run.call_args.args[0]
            self.assertIn('outlook reading again', next(v.split('=', 1)[1] for v in args if v.startswith('--text=')))
            self.tick(state, t.LIVE, {'outlook': 'TimeoutError'}, 23_000)
            self.assertEqual(run.call_count, 2)

    def test_error_classes(self):
        for error in ('TimeoutExpired', 'TimeoutError', 'timed out after 10s', 'time budget; completed prefix saved', 'TLS handshake stalled', 'SSL handshake failure',
                      'Connection reset by peer', 'connection refused', 'ConnectionResetError', 'ConnectionRefusedError', 'ECONNRESET', 'ECONNREFUSED',
                      'Temporary failure in name resolution', 'temporary DNS failure', 'EAI_AGAIN'):
            with self.subTest(error=error):
                self.assertTrue(t.transient_error(error))
        for error in ('IMAP auth expired', 'OAuth invalid_grant', 'login failed', 'credentials missing',
                      'parse error', 'auth timeout', 'ValueError: malformed mail', 'certificate verify failed'):
            with self.subTest(error=error):
                self.assertFalse(t.transient_error(error))

    def test_persistent_auth_alerts_on_third_run(self):
        state = {}
        with patch.object(t.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            for n in range(2):
                self.tick(state, t.LIVE, {'outlook': 'OAuth credentials expired'}, 10_000 + n * 300)
            run.assert_not_called()
            self.tick(state, t.LIVE, {'outlook': 'OAuth credentials expired'}, 10_600)
            self.assertEqual(run.call_count, 1)
            self.assertNotIn('provider/network', run.call_args.args[0])

    def test_a_test_run_never_calls_the_live_telegram_cli(self):
        # Card #14: even in the live directory, a test-marked run refuses the Telegram notify and never spawns it.
        state = {'health_pending': {'text': 'outlook down', 'key': 'k', 'sources': ['outlook']}}
        env = {k: v for k, v in os.environ.items() if k not in ('ROBOB_WATCH_TELEGRAM_CLI', 'NODE_ENV', 'PYTEST_CURRENT_TEST')}
        env['ROBOB_TEST'] = '1'
        with patch.dict('os.environ', env, clear=True), patch.object(t.subprocess, 'run') as run:
            out = t.send_health(state, ['outlook'], t.LIVE, 0)
        run.assert_not_called()
        self.assertIn('refused: test run', out.get('health_alert_error', ''))
        self.assertIn('health_pending', state)

    def tick(self, state, wd, errors, now):
        due = t.track_health(state, errors, now)
        t.health_alert(state, due, now)
        with self.stub_telegram():
            return t.send_health(state, due, wd, now)

    def test_a_live_run_sends_one_alert_and_retries_exactly_that_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            bad = {'outlook': 'IMAP auth failed', 'gmail': 'timeout'}
            state, _ = self.runs([bad] * 2)
            # The first send may have reached the bridge before it timed out.
            lost = t.subprocess.TimeoutExpired('bun', 4)
            sent = types.SimpleNamespace(returncode=0, stdout='', stderr='')
            with self.stub_telegram(), patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', side_effect=[lost, sent]) as run:
                self.assertEqual(self.tick(state, wd, bad, 10_600)['health_alert_error'], 'telegram-bridge notify failed: timeout')
                self.assertNotIn('alerted_at', state['source_health']['gmail'])
                # The next run counts another failure, but resends the same text under the same key.
                self.assertEqual(self.tick(state, wd, bad, 10_900), {'health_alerts': ['gmail', 'outlook']})
                self.assertEqual(self.tick(state, wd, bad, 11_200), {})
            first, second = (c.args[0] for c in run.call_args_list)
            self.assertEqual(first, second)
            self.assertEqual(first[2:4], ['notify', '--source=Inbox triage'])
            self.assertEqual(next(v.split('=', 1)[1] for v in first if v.startswith('--severity=')), 'attention')
            text = next(v.split('=', 1)[1] for v in first if v.startswith('--text='))
            self.assertIn('- outlook: 3 run(s) in a row, 3 in the last hour. Last error: IMAP auth failed', text)
            self.assertIn('- gmail:', text)
            self.assertEqual(state['source_health']['outlook']['alerted_at'], 10_900)
            self.assertEqual(state['source_health']['outlook']['streak'], 5)
            self.assertNotIn('health_pending', state)
            self.assertNotIn('BUN_INSPECT', run.call_args.kwargs['env'])

    def test_a_source_falling_due_during_a_retry_waits_for_its_own_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            state, _ = self.runs([{'outlook': 'x'}] * 2)
            down = types.SimpleNamespace(returncode=1, stdout='', stderr='bridge down')
            sent = types.SimpleNamespace(returncode=0, stdout='', stderr='')
            both = {'outlook': 'x', 'gmail': 'y'}
            with self.stub_telegram(), patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', side_effect=[down, down, sent, sent]) as run:
                self.assertIn('health_alert_error', self.tick(state, wd, both, 10_600))
                self.assertIn('health_alert_error', self.tick(state, wd, both, 10_900))
                # gmail is due now too, but the pending outlook alert goes out unchanged.
                self.assertEqual(self.tick(state, wd, both, 11_200), {'health_alerts': ['outlook']})
                self.assertEqual(self.tick(state, wd, both, 11_500), {'health_alerts': ['gmail']})
                self.assertEqual(self.tick(state, wd, both, 11_800), {})
            keys = [next(v.split('=', 1)[1] for v in c.args[0] if v.startswith('--key=')) for c in run.call_args_list]
            self.assertEqual(len(set(keys[:3])), 1)
            self.assertNotEqual(keys[2], keys[3])
            self.assertNotIn('gmail', next(v.split('=', 1)[1] for v in run.call_args_list[2].args[0] if v.startswith('--text=')))

    def test_an_alert_the_bridge_never_takes_is_dropped_after_six_hours(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            state, _ = self.runs([{'outlook': 'x'}] * 2)
            down = types.SimpleNamespace(returncode=1, stdout='', stderr='409')
            with self.stub_telegram(), patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', return_value=down) as run:
                self.tick(state, wd, {'outlook': 'x'}, 10_600)
                first = state['health_pending']['key']
                self.tick(state, wd, {'outlook': 'x'}, 10_600 + t.HEALTH_REALERT)
            self.assertNotEqual(state['health_pending']['key'], first)
            self.assertEqual(run.call_count, 2)

    def test_scratch_runs_never_send(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, _ = self.runs([{'outlook': 'x'}] * 2)
            with patch.object(t.subprocess, 'run') as run:
                self.assertEqual(self.tick(state, Path(tmp), {'outlook': 'x'}, 20_000), {'health_alerts_skipped': ['outlook']})
            run.assert_not_called()

    def test_runs_that_wake_on_other_sources_still_count_the_failing_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': []})
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            for n in range(3):
                item = TriageTests.item(None, id=f'mail:a:1:{n}')
                result = {'icloud': {'cursor': {'validity': 1, 'uid': n}, 'items': [item], 'drops': {}, 'scanned': 1}}
                with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': f'run-{n}'}), \
                     patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                     patch.object(t, 'collect', return_value=(result, {'outlook': 'RuntimeError: timeout'})), \
                     patch.object(t, 'handled', return_value=({}, {})), patch.object(t, 'build_context', return_value={}), \
                     patch.object(t, 'classify', return_value=([{'id': item['id'], 'reason': 'r', 'urgency': 'today'}], {})), \
                     patch('builtins.print'):
                    self.assertEqual(t.run(args), 0)
                t.atomic(wd / '.run-ok', {})
                state = t.read_json(wd / 'cursor.json')
                state.pop('outbox', None)
                t.atomic(wd / 'cursor.json', state)
            logs = [json.loads(line) for line in (wd / 'diagnostics/runs.jsonl').read_text().splitlines()]
            self.assertEqual([log.get('health_alerts_skipped') for log in logs], [None, None, ['outlook']])
            self.assertEqual(t.read_json(wd / 'cursor.json')['source_health']['outlook']['streak'], 3)

    def prefs_context(self, prefs):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        (home / 'data').mkdir()
        (home / 'data/prefs.md').write_text(prefs)
        with patch.object(t, 'HOME', home), patch.object(t, 'DATA', home / 'data'):
            return t.build_context([], [], time.time())

    def test_context_keeps_middle_rules(self):
        rules = [f'- rule {i:03d} ' + 'x' * 180 for i in range(50)]
        rules[29] = '- MIDDLE RULE marker'
        prefs = '\n'.join(rules)
        self.assertGreater(len(prefs), 8000)
        context = self.prefs_context(prefs)['preferences']
        self.assertIn('MIDDLE RULE marker', context)
        self.assertIn('- MIDDLE RULE marker\n', context)

    def test_context_trims_only_past_limit(self):
        prefs = 'FIRST LINE\n' + 'y' * 20000 + '\nLAST LINE'
        context = self.prefs_context(prefs)['preferences']
        self.assertIn('FIRST LINE', context)
        self.assertIn('LAST LINE', context)
        self.assertLessEqual(len(context), t.PREFS_LIMIT + 100)

    def test_system_mentions_security_rotation(self):
        self.assertIn('Security:', t.SYSTEM)


class ActivityLogBytes(unittest.TestCase):
    def test_a_bad_byte_in_the_activity_log_does_not_break_context(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / 'Documents/assistant/inbox-triage').mkdir(parents=True)
            (home / 'Documents/assistant/inbox-triage/prefs.md').write_text('rules')
            day = time.strftime('%Y-%m-%d', time.gmtime())
            (home / 'Documents/assistant/activity-log.md').write_bytes(
                f'- {day} 10:00 \u00b7 hookah bowl \u00b7 split on '.encode() + b'\x85' + b' only\n')
            with patch.object(t, 'HOME', home), patch.object(t, 'DATA', home / 'Documents/assistant/inbox-triage'), \
                    patch.object(t, 'live_work', return_value={}):
                ctx = t.build_context([{'sender': 'hookah', 'subject': 'bowl', 'preview': 'hookah bowl'}], [], time.time())
        self.assertIn('hookah bowl', ctx['recent_activity_newest_first'])




class PaymentNotices(unittest.TestCase):
    def setUp(self):
        self.mc = t.load_module('triage_money_cases', t.MONEY_CASES)
        self.when = t.dt.datetime(2026, 11, 7, 21, 5, tzinfo=t.DUBAI)

    def test_bank_deadline_wording_and_dates(self):
        rows = [
            ('Wio', 'Your autopay of AED 3,532.73 failed; repay before midnight', '2026-11-07T23:59:00+04:00'),
            ('EmiratesNBD', 'Payment due by 08/11/2026 at 9 PM: AED 3,532.73', '2026-11-08T21:00:00+04:00'),
            ('Mashreq', 'Pay by 8 November 2026 at 21:00 to avoid interest. AED 3,532.73', '2026-11-08T21:00:00+04:00'),
            ('ADCB', 'Pay by 2026-11-08 at 9:30 pm to avoid a late fee. AED 3,532.73', '2026-11-08T21:30:00+04:00'),
            ('FAB', 'Payment due by tomorrow 22:00. AED 3,532.73', '2026-11-08T22:00:00+04:00'),
            ('American Express', 'Pay by Friday to avoid interest. USD 3,532.73', '2026-11-13T23:59:00+04:00'),
        ]
        for sender, text, due in rows:
            with self.subTest(sender=sender):
                n = self.mc.payments.parse(text, sender, self.when)
                self.assertEqual(n['kind'], 'payment_deadline')
                self.assertEqual(n['deadline'], due)
                self.assertEqual(n['amount'], '3532.73')

    def test_promos_declines_negation_and_ambiguous_amounts(self):
        rows = [
            ('Shop', 'Pay before Friday to get 20% off; Wio AED 100.00'),
            ('Wio', 'Pay before Friday to get 20% off; AED 100.00'),
            ('Wio', 'Payment not received AED 100.00'),
            ('Wio', 'Autopay of AED 100.00 failed'),
            ('Wio', 'Payment received AED 100.00 for your savings account'),
            ('Wio', 'Payment received AED 100.00 for your current account'),
            ('Wio', 'Autopay was not successful AED 100.00'),
            ('Wio', 'Payment failed for purchase at SHOP AED 100.00'),
            ('Wio', 'Payment due by tonight: balance AED 200.00, minimum AED 100.00'),
            ('Wio', 'Autopay scheduled at some point: AED 100.00'),
        ]
        for sender, text in rows:
            with self.subTest(text=text):
                self.assertIsNone(self.mc.payments.parse(text, sender, self.when))

    def test_wio_is_tracked_before_classifier_and_dry_run_writes_nothing(self):
        item = {'id': 'mail:wio:1', 'source': 'email', 'sender': 'Wio', 'subject': 'Autopay failed',
                'preview': 'Your autopay of AED 3,532.73 failed; repay before midnight',
                'ts': self.when.timestamp(), 'list_unsubscribe': True}
        self.assertIsNone(t.prefilter(item, self.when.timestamp(), []))
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            with patch.object(self.mc, 'DATA', wd / 'no-live-book'), patch.object(t, 'load_module', return_value=self.mc):
                reasons, error = t.payment_checks([item], self.when.timestamp(), True, wd=wd)
                self.assertEqual(reasons, {})
                self.assertIsNone(error)
                self.assertFalse((wd / 'scratch-money').exists())
                for source in ('mail:wio:1', 'imsg:2'):
                    reasons, error = t.payment_checks([{**item, 'id': source}], self.when.timestamp(), False,
                                                      deadline=time.time() + 3, wd=wd)
                    self.assertEqual(reasons[source], 'payment_deadline_tracked')
                    self.assertIsNone(error)
                self.assertEqual(len(self.mc.load(wd / 'scratch-money')['cases']), 1)

    def test_success_notice_closes_both_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            with patch.object(self.mc, 'DATA', wd / 'no-live-book'), patch.object(t, 'load_module', return_value=self.mc):
                items = [{'id': str(i), 'source': 'email', 'sender': 'Wio', 'subject': '', 'preview': text,
                          'ts': self.when.timestamp() + i * 60} for i, text in enumerate((
                              'Autopay of AED 3,532.73 due tonight at 21:00',
                              'Autopay of AED 3,532.73 failed; repay before midnight',
                              'Autopay successful AED 3,532.73'))]
                reasons, error = t.payment_checks(items, self.when.timestamp() + 180, False, time.time() + 3, wd)
                self.assertEqual(len(reasons), 3)
                self.assertIsNone(error)
                self.assertEqual({c['status'] for c in self.mc.load(wd / 'scratch-money')['cases']}, {'closed'})

    def test_full_mail_deadline_survives_long_preview_and_bulk_header(self):
        raw = ('From: Wio <alerts@wio.io>\r\nSubject: Account notice\r\n'
               'List-Unsubscribe: <mailto:leave@wio.io>\r\nContent-Type: text/plain\r\n\r\n' +
               'Important account information. ' * 20 +
               'Your autopay of AED 3,532.73 failed; repay before midnight').encode()
        record = (1, '07-Nov-2026 21:05:00 +0400', raw.split(b'\r\n\r\n')[0])
        with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
            item, reason = t.mail_record(None, None, 'icloud', 1, record, 0, self.when.timestamp(), {'seen': [], 'rules': []})
        self.assertIsNone(reason)
        self.assertNotIn('midnight', item['preview'])
        self.assertEqual(item['payment_notice']['deadline'], '2026-11-07T23:59:00+04:00')

    def test_full_mail_renewal_survives_long_preview_and_bulk_header(self):
        raw = ('From: ElevenLabs <billing@elevenlabs.io>\r\nSubject: Your subscription\r\n'
               'List-Unsubscribe: <mailto:leave@elevenlabs.io>\r\nContent-Type: text/plain\r\n\r\n' +
               'Important account information. ' * 20 +
               'Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 using card ending in 5542').encode()
        record = (1, '07-Nov-2026 21:05:00 +0400', raw.split(b'\r\n\r\n')[0])
        with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
            item, reason = t.mail_record(None, None, 'icloud', 1, record, 0, self.when.timestamp(), {'seen': [], 'rules': []})
        self.assertIsNone(reason)
        self.assertNotIn('5542', item['preview'])
        self.assertEqual(item['renewal_notice']['last4'], '5542')
        self.assertEqual(item['renewal_notice']['merchant'], 'ElevenLabs')

    def renewal_mail(self, body, subject='Confirmation', header=''):
        raw = (f'From: ElevenLabs <billing@elevenlabs.io>\r\nSubject: {subject}\r\n' + header +
               'Content-Type: text/plain\r\n\r\n' + body).encode()
        record = (1, '07-Nov-2026 21:05:00 +0400', raw.split(b'\r\n\r\n')[0])
        with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]) as fetch:
            result = t.mail_record(None, None, 'icloud', 1, record, 0, self.when.timestamp(), {'seen': [], 'rules': []})
        fetch.assert_called_once()
        return result

    def test_bulk_and_promo_headers_cannot_hide_a_renewal_in_the_body(self):
        body = ('Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 '
                'using card ending in 5542')
        rows = [
            ('Update your payment method', 'List-Unsubscribe: <mailto:leave@elevenlabs.io>\r\n'),
            ('Account notice', 'Precedence: bulk\r\n'),
            ('Account notice', 'Precedence: list\r\n'),
            ('Account notice', 'Precedence: junk\r\n'),
            ('Special offer', ''),
        ]
        for subject, header in rows:
            with self.subTest(subject=subject, header=header):
                item, reason = self.renewal_mail(body, subject, header)
                self.assertIsNone(reason)
                self.assertEqual(item['renewal_notice']['date'], '2026-11-11')
        item, reason = self.renewal_mail('Here is our weekly newsletter.', 'Account notice', 'Precedence: bulk\r\n')
        self.assertEqual(reason, 'bulk')
        self.assertIsNone(item['renewal_notice'])

    def test_bulk_renewals_with_instructions_conditions_and_cancelled_cards_still_open_cases(self):
        first = ('Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 '
                 'using card ending in 5542. ')
        rows = [
            ('Auto-renew can be disabled in Settings', True),
            ('To cancel, ensure auto-renewal is disabled in Settings', True),
            ('Please ensure auto-renewal is disabled in Settings to cancel', True),
            ('Please make sure your subscription is cancelled to stop billing', True),
            ('Please ensure your subscription is cancelled and auto-renewal is disabled in Settings to stop billing', True),
            ('Please make sure your subscription is cancelled and auto-renewal is disabled', True),
            ('Please ensure your subscription is cancelled, and auto-renewal is disabled in Settings', True),
            ('You can turn off auto-renewal in Settings', True),
            ('If the renewal payment fails, your subscription will be cancelled', True),
            ('Your subscription will be cancelled if the renewal payment fails', True),
            ('Your subscription is disabled if the renewal payment fails', True),
            ('If the renewal payment fails, your subscription is disabled', True),
            ('Your subscription is disabled automatically, if the renewal payment fails', True),
            ('Your subscription is disabled temporarily, if payment fails', True),
            ('Your card is cancelled; update your payment method before renewal', True),
            ('Your card has been deactivated; update it before your subscription renews', True),
            ('Your subscription is cancelled', False),
            ('Auto-renewal has been disabled', False),
            ('Auto-renewal is currently off', False),
            ('Your subscription has been cancelled, contact support if this was a mistake', False),
            ('Your subscription has been cancelled, and contact support if this was a mistake', False),
            ('Your subscription has been cancelled, please contact support if this was a mistake', False),
            ('Your subscription has been cancelled; contact support if this was a mistake', False),
            ('Your subscription has been cancelled, email us if you need help', False),
            ('Your subscription has been cancelled, reach out if this was a mistake', False),
            ('Please note: your subscription is cancelled', False),
            ('Please be advised: auto-renewal is disabled', False),
            ('We have cancelled your subscription', False),
            ('They have deactivated your membership', False),
            ('We have not cancelled your subscription', True),
            ('You will not be charged', False),
            ('You will not be charged if payment fails', True),
            ('Your card is cancelled, and your subscription has been cancelled', False),
            ('Your card is cancelled and your subscription is disabled', False),
            ('Your card is cancelled, and your subscription is active', True),
            ('You can contact support because your subscription has been cancelled', False),
            ('You may visit Settings because auto-renewal is disabled', False),
            ('If you need help, you can contact support because your subscription has been cancelled', False),
            ('Unless you can log in, contact support because auto-renewal has been disabled', False),
        ]
        for suffix, active in rows:
            for padding in ('', 'Additional account information. ' * 20):
                with self.subTest(suffix=suffix, long_body=bool(padding)), tempfile.TemporaryDirectory() as tmp:
                    item, reason = self.renewal_mail(first + padding + suffix, 'Account notice',
                                                   'List-Unsubscribe: <mailto:leave@elevenlabs.io>\r\n')
                    self.assertEqual(reason, None if active else 'bulk')
                    wd = Path(tmp)
                    with patch.object(self.mc, 'DATA', wd / 'money'), patch.object(t, 'load_module', return_value=self.mc):
                        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
                        reasons, error = t.renewal_checks([item] if reason is None else [], self.when.timestamp(), False, wd=wd)
                        self.assertIsNone(error)
                        self.assertEqual(reasons, {item['id']: 'renewal_case'} if active else {})
                        self.assertEqual(len(self.mc.load(wd / 'scratch-money')['cases']), int(active))
                        self.assertEqual(self.mc.load(self.mc.DATA)['cases'], [])

    def test_timed_no_charge_bulk_mail_tracks_renewals_but_unqualified_negation_does_not(self):
        first = ('Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 '
                 'using card ending in 5542. ')
        rows = [
            ('You will not be charged until your renewal date', True),
            ('You will not be charged before this date', True),
            ('You will not be billed again until then', True),
            ("You won't be charged until then", True),
            ('You won’t be charged before your renewal date', True),
            ('You will not be debited again before this date', True),
            ('You will not be charged USD 118.80 before your renewal date', True),
            ('You will not be billed prior to your renewal date', True),
            ('Until then, you will not be charged', True),
            ('Until your renewal date, you will not be charged', True),
            ('Before contacting support, please note that you will not be charged again', False),
            ('Before updating your card, please note that you will not be billed again', False),
            ('Until you contact support, please note that you will not be charged again', False),
            ('Before the renewal date, contact support, please note that you will not be charged again', False),
            ('You will not be charged again, before contacting support please read our help page', False),
            ('You will not be billed again, before updating your card read our instructions', False),
            ('You will not be debited, until you contact support please read the FAQ', False),
            ('You will not be charged before contacting support please read the FAQ', False),
            ('You will not be charged again, before tomorrow please read our help page', False),
            ('You will not be billed again, until next month please contact support', False),
            ('You will not be debited, before your renewal date update your card', False),
            ('You will not be charged again, before tomorrow', True),
            ('You will not be charged until your renewal date, please read our help page', True),
            ('You will not be charged until your next billing cycle', True),
            ('You will not be billed before the next renewal date', True),
            ('You will not be billed again until next month', True),
            ('You will not be charged', False),
            ('You will not be billed again', False),
            ('Your subscription is cancelled before this date', False),
            ('Auto-renewal is disabled until then', False),
            ('You will not be charged and your subscription is cancelled before this date', False),
        ]
        for suffix, active in rows:
            for padding in ('', 'Additional account information. ' * 20):
                with self.subTest(suffix=suffix, long_body=bool(padding)), tempfile.TemporaryDirectory() as tmp:
                    item, reason = self.renewal_mail(first + padding + suffix, 'Account notice',
                                                   'List-Unsubscribe: <mailto:leave@elevenlabs.io>\r\n')
                    self.assertEqual(reason, None if active else 'bulk')
                    wd = Path(tmp)
                    with patch.object(self.mc, 'DATA', wd / 'money'), patch.object(t, 'load_module', return_value=self.mc):
                        self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
                        reasons, error = t.renewal_checks([item] if reason is None else [], self.when.timestamp(), False, wd=wd)
                        self.assertIsNone(error)
                        self.assertEqual(reasons, {item['id']: 'renewal_case'} if active else {})
                        cases = self.mc.load(wd / 'scratch-money')['cases']
                        self.assertEqual(len(cases), int(active))
                        if active:
                            self.assertEqual(cases[0]['deadline'], '2026-11-11')
                        self.assertEqual(self.mc.load(self.mc.DATA)['cases'], [])

    def test_full_body_cancellation_or_ambiguity_cannot_be_overruled_by_preview(self):
        first = ('Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 '
                 'using card ending in 5542. ')
        tails = ['Your subscription is cancelled.', 'The other amount is USD 100.00.',
                 'The other card is ending in 2342.']
        for tail in tails:
            with self.subTest(tail=tail), tempfile.TemporaryDirectory() as tmp:
                item, reason = self.renewal_mail(first + 'Additional account details. ' * 20 + tail)
                self.assertIsNone(reason)
                self.assertIsNone(item['renewal_notice'])
                self.assertNotIn(tail, item['preview'])
                self.assertIsNotNone(self.mc.renewal(item['preview'], item['sender']))
                wd = Path(tmp)
                with patch.object(self.mc, 'DATA', wd / 'money'), patch.object(t, 'load_module', return_value=self.mc):
                    self.mc.card_dead(self.mc.DATA, '5542', 'cancelled')
                    reasons, error = t.renewal_checks([item], self.when.timestamp(), False, wd=wd)
                    self.assertIsNone(error)
                    self.assertEqual(reasons, {})
                    self.assertEqual(self.mc.load(wd / 'scratch-money')['cases'], [])

    def test_failure_cause_never_replaces_repayment_clause(self):
        for cause in ('due to insufficient funds', 'due to account restrictions', 'because the account is blocked'):
            for separator in ('; ', '. ', ' '):
                text = f'Autopay of AED 3,532.73 failed {cause}{separator}Please repay before midnight'
                with self.subTest(cause=cause, separator=separator):
                    notice = self.mc.payments.parse(text, 'Wio', self.when)
                    self.assertEqual(notice['deadline'], '2026-11-07T23:59:00+04:00')

    def test_success_and_future_wording_matrix(self):
        rows = [
            ('Autopay of AED 100.00 will be debited on 8 November 2026 at 18:00.', 'autopay_expected', '2026-11-08T18:00:00+04:00'),
            ('Autopay of AED 100.00 will be processed on Friday at 18:00.', 'autopay_expected', '2026-11-13T18:00:00+04:00'),
            ('Your payment of AED 100.00 is due on 8 November 2026 at 18:00.', 'payment_deadline', '2026-11-08T18:00:00+04:00'),
            ('Autopay of AED 100.00 has been successfully completed.', 'payment_success', None),
            ('Payment of AED 100.00 has been successfully received.', 'payment_success', None),
            ('Autopay of AED 100.00 was successfully debited.', 'payment_success', None),
            ('Autopay of AED 100.00 is scheduled today at 21:00. We will notify you if payment is successful.', 'autopay_expected', '2026-11-07T21:00:00+04:00'),
        ]
        for text, kind, deadline in rows:
            with self.subTest(text=text):
                notice = self.mc.payments.parse(text, 'Wio', self.when)
                self.assertIsNotNone(notice)
                self.assertEqual((notice['kind'], notice['deadline']), (kind, deadline))

    def test_decline_and_nonconfirmation_wording_matrix(self):
        rows = [
            'Payment of AED 100 at X with your Wio debit card ending with 1234 was declined',
            'Your card payment of AED 100.00 to Netflix failed.',
            'Payment of AED 100.00 at Netflix failed; pay by midnight',
            'Check whether payment is successful in the app AED 100.00',
            'We will notify you if payment is successful AED 100.00',
            'Payment received AED 100.00 has been reversed.',
            'Payment received AED 100.00 has been returned.',
            'Payment received AED 100.00 has been cancelled.',
            'Payment has not been received AED 100.00',
        ]
        for text in rows:
            with self.subTest(text=text):
                self.assertIsNone(self.mc.payments.parse(text, 'Wio', self.when))

    def test_failure_timestamps_are_not_repayment_deadlines(self):
        for when in ('today at 20:00', 'tonight at 20:00', 'on 7 November 2026 at 20:00'):
            for suffix, expected in (('', None), (' Your payment is due by midnight.', '2026-11-07T23:59:00+04:00'),
                                     (' Please repay before midnight.', '2026-11-07T23:59:00+04:00')):
                text = f'Autopay of AED 100.00 failed {when} due to insufficient funds.' + suffix
                with self.subTest(when=when, suffix=suffix):
                    result = self.mc.payments.parse(text, 'Wio', self.when)
                    self.assertEqual(result['deadline'] if result else None, expected)

    def test_all_autopay_aliases_share_conditional_guard(self):
        aliases = ('autopay', 'auto-pay', 'auto pay', 'autodebit', 'auto-debit', 'auto debit',
                   'automaticdebit', 'automatic-debit', 'automatic debit', 'automatic payment')
        for alias in aliases:
            with self.subTest(alias=alias, conditional=False):
                confirmed = self.mc.payments.parse(f'Your {alias} of AED 100.00 was successful.', 'Wio', self.when)
                self.assertEqual(confirmed['kind'], 'payment_success')
            for condition in ('if', 'whether', 'when', 'once', 'until', 'hope'):
                with self.subTest(alias=alias, conditional=condition):
                    text = f'We will notify you {condition} your {alias} of AED 100.00 is successful.'
                    self.assertIsNone(self.mc.payments.parse(text, 'Wio', self.when))
                    scheduled = f'Your {alias} of AED 100.00 is scheduled today at 21:00. ' + text
                    self.assertEqual(self.mc.payments.parse(scheduled, 'Wio', self.when)['kind'], 'autopay_expected')



class PaymentSettlementTests(unittest.TestCase):
    def payment(self, **changes):
        return {'flow_id': 'flow1', 'order_id': 'NNTEST1', 'card_last4': '9546',
                'sent_at': 1000, 'amount_aed': 26.75, **changes}

    def test_terminal_and_zero_flows_never_reach_in_flight(self):
        cases = [dict(state='ACTIVE', financial_send=False, sent_seconds_ago=None),
                 dict(state='FENCED', amount_minor=0), dict(in_flight=False),
                 *[dict(state=s) for s in ('COMPLETE', 'RELEASED', 'OWNER_ATTESTED_UNCHARGED', 'REJECTED_DUPLICATE')]]
        for change in cases:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp:
                flow = {'app':'noon', 'vertical':'nownow', 'state':'ACTIVE', 'amount_minor':2675,
                        'financial_send':True, 'sent_seconds_ago':30, **change}
                answer = types.SimpleNamespace(stdout=json.dumps({'ok':True,'open':[flow]}), returncode=0, stderr='')
                with patch.object(t.subprocess, 'run', return_value=answer), patch.object(t, 'PHONE_LOCK', Path(temp)):
                    work = t.live_work(2000)
                self.assertEqual(work['open_payments'], [])
                self.assertIsNone(t.work_line(work))

    def test_evidence_class_matches_and_persists_only_exact_settlements(self):
        cases = [
            ('purchase', 'imessage', 'Mashreq', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon', 1100, True),
            ('receipt', 'email', 'orders@noon.com', 'Order NNTEST1 receipt', 1100, True),
            ('other_card', 'imessage', 'Mashreq', 'Purchase AED 26.75 at noon using card 2342', 1100, False),
            ('other_amount', 'imessage', 'Mashreq', 'Purchase AED 267.50 at noon using card 9546', 1100, False),
            ('other_merchant', 'imessage', 'Mashreq', 'Purchase AED 26.75 at cafe using card 9546', 1100, False),
            ('older', 'imessage', 'Mashreq', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon', 999, False),
            ('approval', 'imessage', 'Mashreq', 'Approve purchase AED 26.75 at noon card 9546', 1100, False),
            ('failed', 'imessage', 'Mashreq', 'Purchase declined AED 26.75 at noon card 9546', 1100, False),
            ('otp', 'imessage', 'Mashreq', 'OTP for purchase AED 26.75 at noon card 9546', 1100, False),
            ('foreign_receipt', 'email', 'orders@other.com', 'Order NNTEST1 receipt', 1100, False),
            ('substring_order', 'email', 'orders@noon.com', 'Order NNTEST12 receipt', 1100, False),
            ('noon_card_other_shop', 'imessage', 'Mashreq', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at ACME', 1100, False),
            ('noon_card_noon_shop', 'imessage', 'Mashreq', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon.com', 1100, True),
            ('enbd_noon_shop', 'imessage', 'EmiratesNBD', 'Purchase of AED 26.75 with Credit Card ending 9546 at noon, Dubai.', 1100, True),
            ('similar_merchant', 'imessage', 'Mashreq', 'Your Card ending with 9546 was used for a purchase of AED26.75 at noon cafe', 1100, False),
            ('failed_email', 'email', 'orders@noon.com', 'Payment failed for order NNTEST1', 1100, False),
            ('failed_receipt', 'email', 'orders@noon.com', 'Receipt: payment failed for order NNTEST1', 1100, False),
            ('pending_receipt', 'email', 'orders@noon.com', 'Receipt: payment pending for order NNTEST1', 1100, False),
            ('cancelled_receipt', 'email', 'orders@noon.com', 'Receipt: cancelled order NNTEST1', 1100, False),
            ('unpaid_receipt', 'email', 'orders@noon.com', 'Receipt: order NNTEST1 not paid', 1100, False),
            ('plain_order_mail', 'email', 'orders@noon.com', 'Order NNTEST1 update', 1100, False),
            ('positive_receipt', 'email', 'orders@noon.com', 'Payment received for order NNTEST1', 1100, True),
            ('mashreq_email', 'email', 'MashreqAlerts@mashreq.com', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon.com', 1100, True),
            ('mashreq_native_merchant', 'email', 'MashreqAlerts@mashreq.com', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at Noon 80038888 AE on 09-NOV-2026 05:48 PM.', 1100, True),
            ('foreign_bank_email', 'email', 'MashreqAlerts@other.com', 'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon.com', 1100, False),
            ('declined_receipt', 'email', 'orders@noon.com', 'Receipt: payment declined for NNTEST1', 1100, False),
            ('refund_receipt', 'email', 'orders@noon.com', 'Receipt: order NNTEST1 refunded', 1100, False),
            ('reversed_receipt', 'email', 'orders@noon.com', 'Receipt: payment reversed for NNTEST1', 1100, False),
            ('unpaid_literal_receipt', 'email', 'orders@noon.com', 'Receipt: order NNTEST1 unpaid', 1100, False),
        ]
        for name, source, sender, text, at, expected in cases:
            with self.subTest(name=name):
                work = {'open_payments':[self.payment()]}; state = {}
                item = {'id':'evidence', 'source':source, 'sender':sender, 'subject':text, 'preview':'', 'ts':at}
                t.settle_work(work, [item], state)
                self.assertEqual(not work['open_payments'], expected)
                work = {'open_payments':[self.payment()]}
                t.settle_work(work, [], state)
                self.assertEqual(not work['open_payments'], expected)
                self.assertNotIn(text, json.dumps(state))

    def test_same_amount_is_ambiguous(self):
        work = {'open_payments':[self.payment(), self.payment(flow_id='flow2')]}
        t.settle_work(work, [{'id':'sms','source':'imessage','sender':'Mashreq',
             'preview':'Your Mashreq noon Card ending with 9546 was used for a purchase of AED26.75 at noon','ts':1100}], {})
        self.assertEqual(len(work['open_payments']), 2)

    def test_reopened_payment_invalidates_old_settlement_and_old_evidence(self):
        state = {}
        item = {'id':'sms', 'source':'imessage', 'sender':'Mashreq', 'ts':1100,
                'preview':'Your Card ending with 9546 was used for a purchase of AED26.75 at noon.com'}
        t.settle_work({'open_payments':[self.payment()]}, [item], state)
        self.assertIn('flow1', state['settled_payments'])
        reopened = self.payment(sent_at=1200, settlement_epoch=1200)
        work = {'open_payments':[reopened]}
        t.settle_work(work, [item], state)
        self.assertEqual(work['open_payments'], [reopened])
        self.assertNotIn('flow1', state['settled_payments'])
        t.settle_work(work, [{**item, 'id':'new', 'ts':1300}], state)
        self.assertEqual(work['open_payments'], [])
        self.assertEqual(state['settled_payments']['flow1']['epoch'], 1200)

    def test_held_and_previously_queued_evidence_settles_without_classifier_readiness(self):
        for initially_queued in (False, True):
            with self.subTest(initially_queued=initially_queued), tempfile.TemporaryDirectory() as temp:
                wd = Path(temp)
                item = {'id':'imsg:1','source':'imessage','sender':'Mashreq','ts':1100,'subject':'',
                        'preview':'Your Card ending with 9546 was used for a purchase of AED26.75 at noon.com'}
                t.atomic(wd/'cursor.json', {'version':1,'initialized_at':1000,'cursors':{},
                    'queue':[item] if initially_queued else []})
                first = {'imessage':{'cursor':1,'items':[] if initially_queued else [item],'drops':{},'scanned':1}}
                args = types.SimpleNamespace(dry_run_hours=None, report=None)
                with patch.dict(t.os.environ, {'WATCH_DIR':str(wd), 'WATCH_RUN':'test'}), \
                        patch.object(t,'active_watchers',return_value=[]), patch.object(t,'noise_rules',return_value=[]), \
                        patch.object(t,'collect',side_effect=[(first,{}), ({'imessage': {**first['imessage'], 'items': []}}, {})]), \
                        patch.object(t,'handled',return_value=({},{})), \
                        patch.object(t,'payment_checks',return_value=({},None)), \
                        patch.object(t,'renewal_checks',return_value=({},None)), \
                        patch.object(t,'charge_checks',return_value=({}, {'imsg:1'},None)), \
                        patch.object(t,'build_context',side_effect=lambda *_: {'live_work':{'open_payments':[self.payment()]}}), \
                        patch.object(t,'classify_batch') as classify, patch('builtins.print'):
                    self.assertEqual(t.run(args),0)
                    state = t.read_json(wd/'cursor.json')
                    self.assertIn('flow1', state['settled_payments'])
                    self.assertEqual(t.run(args),0)
                    self.assertIn('flow1', t.read_json(wd/'cursor.json')['settled_payments'])
                    classify.assert_not_called()

    def test_replayed_outbox_uses_current_terminal_payment_state(self):
        with tempfile.TemporaryDirectory() as temp:
            wd = Path(temp); batch = wd/'batch.json'
            hit = {'id':'email:1','source':'email','sender':'orders@noon.com', 'subject':'Receipt',
                   'preview':'Order NNTEST1','ts':1100,'reason':'receipt','urgency':'info'}
            t.atomic(batch, {'hits':[hit], 'live_work':{'open_payments':[self.payment()]}})
            state = {'outbox':{'run':'first','batch':str(batch),'event':'In flight: stale payment'},'queue':[]}
            with patch.object(t,'handled',return_value=({},{})), \
                    patch.object(t,'live_work',return_value={'open_payments':[]}), \
                    patch.object(t,'withdrawal_statuses'), patch.object(t,'urgent_alerts',return_value={}):
                event = t.replay_outbox(state,wd,'second')
            self.assertNotIn('In flight:',event)
            self.assertEqual(t.read_json(batch)['live_work']['open_payments'],[])


if __name__ == '__main__':
    unittest.main()
