"""Narrow offline checks for filtering and no-loss cursor/outbox behavior."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('triage', Path(__file__).with_name('triage.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


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
        request = {'now': 2000, 'cursor': {'validity': 1, 'uid': 0}, 'initialized_at': 1000, 'seen': [], 'rules': []}
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
        request = {'now': 2000, 'cursor': {'validity': 7, 'uid': 999}, 'initialized_at': 1000,
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
        request = {'now': 2000, 'cursor': None, 'initialized_at': 1000, 'baseline': False,
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
        request = {'now': 2000, 'cursor': {'validity': 1, 'uid': 0}, 'initialized_at': 1000,
                   'seen': [], 'rules': []}
        processed = [(self.item(id=f'mail:a:1:{i}'), None) for i in (1, 2, 3)] + [TimeoutError()]
        with patch.object(t, 'load_module', return_value=type('Mail', (), {'connect': lambda *args: FakeImap()})), \
             patch.object(t, 'mail_record', side_effect=processed):
            result = t.mail_worker('icloud', request)
        self.assertEqual(result['cursor']['uid'], 3)
        self.assertEqual(len(result['items']), 3)
        self.assertIn('completed prefix', result['partial'])

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
                self.assertEqual(t.run(args), 0)
                model.assert_called_once()
            state = t.read_json(wd / 'cursor.json')
            self.assertEqual(state['cursors']['gmail']['uid'], 8)
            self.assertEqual(state['queue'], [])
            self.assertIn('outbox', state)
            self.assertEqual(t.read_json(Path(state['outbox']['batch']))['hits'][0]['id'], 'mail:a:1:1')


if __name__ == '__main__':
    unittest.main()
