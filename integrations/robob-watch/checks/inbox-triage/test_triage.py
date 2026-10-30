"""Narrow offline checks for filtering and no-loss cursor/outbox behavior."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
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

    def test_a_slow_collection_leaves_the_classifier_only_what_fits_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': 1000, 'cursors': {}, 'queue': [self.item()]})
            args = types.SimpleNamespace(dry_run_hours=None, report=None)
            # Collection took 43.5 s, so the call would have to answer by second 44: no whole second left.
            ticks = [1000.0, 1043.5]
            def clock():
                return ticks.pop(0) if len(ticks) > 1 else ticks[0]
            with patch.dict(t.os.environ, {'WATCH_DIR': str(wd), 'WATCH_RUN': 'test'}), \
                 patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                 patch.object(t, 'collect', return_value=({}, {})), patch.object(t, 'build_context', return_value={}), \
                 patch.object(t, 'handled', return_value=({}, {})), patch.object(t.time, 'time', side_effect=clock), \
                 patch.object(t, 'classify', side_effect=AssertionError('no time left to call it')) as model, patch('builtins.print'):
                self.assertEqual(t.run(args), 0)
            model.assert_not_called()
            state = t.read_json(wd / 'cursor.json')
            self.assertEqual(t.read_json(Path(state['outbox']['batch']))['hits'][0]['reason'], 'Classifier unavailable; manually review')
        # With 6 s left the call gets a 6 s timer, not the usual 20, re-firing each second after.
        with patch.object(t, 'classify', return_value=([], {})), patch.object(t.signal, 'setitimer') as timer:
            t.classify_batch([self.item()], {}, 6)
        self.assertEqual(timer.call_args_list[0].args, (t.signal.ITIMER_REAL, 6, 1))
        self.assertEqual(timer.call_args_list[-1].args, (t.signal.ITIMER_REAL, 0))

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
        with patch.object(t, 'classify', side_effect=stubborn):
            hits, meta = t.classify_batch([self.item()], {}, 1)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(meta['classifier_error'], 'TimeoutError')
        self.assertEqual(hits[0]['reason'], 'Classifier unavailable; manually review')
        self.assertEqual(t.signal.getitimer(t.signal.ITIMER_REAL), (0.0, 0.0))

    def test_a_deadline_firing_right_after_the_timer_is_set_is_still_caught(self):
        real = t.signal.setitimer
        calls = []
        def slow_to_return(which, seconds, interval=0.0):
            calls.append(seconds)
            real(which, seconds, interval)
            if len(calls) == 1:
                time.sleep(3)  # descheduled between arming and the call; the deadline (1 s) cuts this short
        with patch.object(t.signal, 'setitimer', side_effect=slow_to_return), \
             patch.object(t, 'classify', side_effect=AssertionError('the deadline came first')):
            hits, meta = t.classify_batch([self.item()], {}, 1)
        self.assertEqual(meta['classifier_error'], 'TimeoutError')
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

        def search(query, since, until=None, source=None, n=20, deadline=None):
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
                        patch.object(self.mc.charges, 'search', search),
                        patch.object(self.mc.charges, 'show', lambda row, deadline=None: row['text']),
                        patch.object(self.mc.charges, 'owner_texts', lambda since, until, deadline=None: []),
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
                 patch.object(t, 'collect', return_value=({}, {})) as collect, patch('builtins.print'):
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
                 patch.object(t, 'collect', return_value=({}, {})), patch.object(t, 'build_context', return_value={}), \
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
                 patch.object(t, 'handled', return_value=({}, {})), patch('builtins.print'):
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
                                                   'amount_aed': 123.45, 'minutes_ago': 19, 'sent_at': 3861.0}],
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
        with patch.object(t, 'handled', return_value=({}, {})):
            self.assertEqual(t.replay_outbox(state, wd, 'second'), event)


class SourceHealthTests(unittest.TestCase):
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
        t.track_health(state, {}, later + 300)
        self.assertIn('outlook', state['source_health'])
        t.track_health(state, {}, later + t.HEALTH_REALERT)
        self.assertNotIn('outlook', state['source_health'])

    def tick(self, state, wd, errors, now):
        due = t.track_health(state, errors, now)
        t.health_alert(state, due, now)
        return t.send_health(state, due, wd, now)

    def test_a_live_run_sends_one_alert_and_retries_exactly_that_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            bad = {'outlook': 'IMAP auth failed', 'gmail': 'timeout'}
            state, _ = self.runs([bad] * 2)
            # The first send may have reached the bridge before it timed out.
            lost = t.subprocess.TimeoutExpired('bun', 4)
            sent = types.SimpleNamespace(returncode=0, stdout='', stderr='')
            with patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', side_effect=[lost, sent]) as run:
                self.assertTrue(self.tick(state, wd, bad, 10_600)['health_alert_error'].startswith('TimeoutExpired'))
                self.assertNotIn('alerted_at', state['source_health']['gmail'])
                # The next run counts another failure, but resends the same text under the same key.
                self.assertEqual(self.tick(state, wd, bad, 10_900), {'health_alerts': ['gmail', 'outlook']})
                self.assertEqual(self.tick(state, wd, bad, 11_200), {})
            first, second = (c.args[0] for c in run.call_args_list)
            self.assertEqual(first, second)
            self.assertEqual(first[2:4], ['notify', '--source'])
            self.assertEqual(first[first.index('--severity') + 1], 'attention')
            text = first[first.index('--text') + 1]
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
            with patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', side_effect=[down, down, sent, sent]) as run:
                self.assertIn('health_alert_error', self.tick(state, wd, both, 10_600))
                self.assertIn('health_alert_error', self.tick(state, wd, both, 10_900))
                # gmail is due now too, but the pending outlook alert goes out unchanged.
                self.assertEqual(self.tick(state, wd, both, 11_200), {'health_alerts': ['outlook']})
                self.assertEqual(self.tick(state, wd, both, 11_500), {'health_alerts': ['gmail']})
                self.assertEqual(self.tick(state, wd, both, 11_800), {})
            keys = [c.args[0][c.args[0].index('--key') + 1] for c in run.call_args_list]
            self.assertEqual(len(set(keys[:3])), 1)
            self.assertNotEqual(keys[2], keys[3])
            self.assertNotIn('gmail', run.call_args_list[2].args[0][run.call_args_list[2].args[0].index('--text') + 1])

    def test_an_alert_the_bridge_never_takes_is_dropped_after_six_hours(self):
        with tempfile.TemporaryDirectory() as tmp:
            wd = Path(tmp)
            state, _ = self.runs([{'outlook': 'x'}] * 2)
            down = types.SimpleNamespace(returncode=1, stdout='', stderr='409')
            with patch.object(t, 'LIVE', wd), patch.object(t.subprocess, 'run', return_value=down) as run:
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


if __name__ == '__main__':
    unittest.main()
