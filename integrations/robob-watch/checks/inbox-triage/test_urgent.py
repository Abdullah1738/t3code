"""Offline outage delivery and reference-matched withdrawal checks."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

from test_triage import t


class UrgentTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.wd = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.now = time.time()
        self.health_log, self.notify_log = self.wd / 'health-log', self.wd / 'notify-log'
        self.bridge, self.telegram = self.wd / 'bridge.py', self.wd / 'telegram.py'
        self.bridge.write_text('''import os, sys, time
from pathlib import Path
assert 'BUN_INSPECT' not in os.environ
with Path(os.environ['HEALTH_LOG']).open('a') as f: f.write('health\\n')
if os.environ.get('HEALTH_HANG'): time.sleep(10)
print(os.environ['HEALTH_JSON'])
sys.exit(int(os.environ.get('HEALTH_EXIT', '0')))
''')
        self.telegram.write_text('''import json, os, sys
from pathlib import Path
assert 'BUN_INSPECT' not in os.environ
with Path(os.environ['NOTIFY_LOG']).open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
print('private token should never be logged', file=sys.stderr)
sys.exit(int(os.environ.get('NOTIFY_EXIT', '0')))
''')
        self.stack.enter_context(patch.dict(os.environ, {
            'WATCH_DIR': str(self.wd), 'WATCH_RUN': 'first', 'ROBOB_TEST': '1',
            'INBOX_TRIAGE_SPECTRUM_CLI': str(self.bridge), 'ROBOB_WATCH_TELEGRAM_CLI': str(self.telegram),
            'HEALTH_LOG': str(self.health_log), 'NOTIFY_LOG': str(self.notify_log),
            'HEALTH_JSON': '{"ready":true,"openchamberConnected":false}', 'BUN_INSPECT': 'must-be-scrubbed',
        }))
        for key in ('HEALTH_EXIT', 'HEALTH_HANG', 'NOTIFY_EXIT'):
            os.environ.pop(key, None)
        for name, value in (('BUN', Path(sys.executable)), ('LIVE', self.wd), ('DATA', self.wd / 'data')):
            self.stack.enter_context(patch.object(t, name, value))
        for name, value in (('active_watchers', []), ('noise_rules', []), ('charge_checks', ({}, set(), None)),
                            ('charges_raised', None), ('handled', ({}, {})), ('build_context', {})):
            self.stack.enter_context(patch.object(t, name, return_value=value))
        t.atomic(self.wd / 'cursor.json', {'initialized_at': self.now - 600, 'cursors': {}, 'queue': []})

    def item(self, **kw):
        return {'id': 'mail:gmail:1:12', 'source': 'email', 'sender': 'TikTok <security@tiktok.com>',
                'subject': 'New login to TikTok', 'preview': 'New device detected. Verification code 123456',
                'ts': self.now - 60, **kw}

    def calls(self):
        return [json.loads(line) for line in self.notify_log.read_text().splitlines()] if self.notify_log.exists() else []

    def run_items(self, items, dry=False, classify_ids=None):
        result = {'gmail': {'cursor': {'validity': 1, 'uid': 12}, 'items': items, 'scanned': len(items), 'drops': {}}}
        hits = [{'id': i['id'], 'reason': 'Please review this activity', 'urgency': 'today'} for i in items
                if classify_ids is None or i['id'] in classify_ids]
        output = io.StringIO()
        with patch.object(t, 'collect', return_value=(result, {})), \
             patch.object(t, 'classify', return_value=(hits, {'cost_usd': 0})), contextlib.redirect_stdout(output):
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=1 if dry else None, report=None)), 0)
        state = t.read_json(self.wd / 'cursor.json')
        report = json.loads(output.getvalue()) if dry else t.read_json(
            Path(state['outbox']['batch']) if state.get('outbox') else max(list((self.wd / 'data/batches').glob('*.json')) + list((self.wd / 'diagnostics/batches').glob('*.json')), key=lambda p: p.stat().st_mtime))
        return state, report, output.getvalue()

    def test_down_delivers_once_marks_batch_and_replay_and_later_run(self):
        hit = self.item(sender='TikTok ' + 's' * 200, subject='New login ' + 'x' * 200)
        state, report, event = self.run_items([hit])
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        key = 'inbox-triage:urgent:' + hashlib.sha256(hit['id'].encode()).hexdigest()[:16]
        self.assertEqual(calls[0][calls[0].index('--key') + 1], key)
        text = calls[0][calls[0].index('--text') + 1]
        self.assertLessEqual(len(text), 300)
        self.assertNotIn('123456', text)
        self.assertIn('Please review this activity', text)
        self.assertIn('telegram_sent_at', report['hits'][0])
        self.assertEqual(event, '')  # no raw event for the runner to send to Telegram a second time
        followup = t.event_text('batch.json', report['hits'], {})
        self.assertIn('already sent to Telegram at ', followup)
        self.assertIn("Dubai; don't alert again, follow up only if something changed", followup)
        self.assertIn(hit['id'], state['telegram_sent'])
        self.assertIn('chat_down', report)
        self.run_items([hit])
        self.assertEqual(len(self.calls()), 1)
        (self.wd / '.run-ok').write_text('first')
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        _, _, event = self.run_items([])
        self.assertIn('already sent to Telegram at ', event)
        self.assertEqual(len(self.calls()), 1)

    def test_health_timeout_is_down_and_bounded(self):
        os.environ['HEALTH_HANG'] = '1'
        start = time.monotonic()
        _, report, _ = self.run_items([self.item()])
        self.assertLess(time.monotonic() - start, 5)
        self.assertIn('timed out', report['chat_down'])
        self.assertEqual(len(self.calls()), 1)

    def test_up_does_not_notify_and_nonurgent_never_probes(self):
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        self.run_items([self.item()])
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.health_log.read_text().splitlines(), ['health'])
        (self.wd / '.run-ok').write_text('first')
        self.run_items([self.item(subject='Appointment confirmation', preview='Confirmed', sender='clinic')])
        self.assertEqual(self.health_log.read_text().splitlines(), ['health'])

    def test_notify_failure_is_logged_and_does_not_block_batch_or_mark_sent(self):
        os.environ['NOTIFY_EXIT'] = '1'
        state, report, _ = self.run_items([self.item()])
        self.assertEqual(state['telegram_sent'], {})
        self.assertNotIn('telegram_sent_at', report['hits'][0])
        log = (self.wd / 'data/runs.jsonl').read_text()
        self.assertIn('urgent_alert_error', log)
        self.assertNotIn('private token', log)
        os.environ['NOTIFY_EXIT'] = '0'
        self.run_items([self.item()])
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.calls()[0], self.calls()[1])

    def test_lost_response_retry_keeps_text_even_if_reason_changes(self):
        os.environ['NOTIFY_EXIT'] = '1'
        state, report, _ = self.run_items([self.item()])
        report['hits'][0]['reason'] = 'Security: a different status after the attempt'
        state['queue'][0]['reason'] = report['hits'][0]['reason']
        t.atomic(self.wd / 'cursor.json', state)
        os.environ['NOTIFY_EXIT'] = '0'
        state, _, _ = self.run_items([])
        self.assertEqual(self.calls()[0], self.calls()[1])
        self.assertEqual(state['telegram_pending'], {})

    def test_pending_payload_survives_48_hours_and_changed_reason(self):
        hit = self.item()
        text = 'Original immutable notification'
        state = {'telegram_pending': {hit['id']: {'text': text, 'at': self.now - 49 * 3600}}}
        report = {'hits': [{**hit, 'reason': 'Security: reason changed'}]}
        t.urgent_alerts(state, report, self.wd, self.now)
        call = self.calls()[0]
        self.assertEqual(call[call.index('--text') + 1], text)

    def test_deferred_security_alert_retries_after_otp_expires(self):
        os.environ['NOTIFY_EXIT'] = '1'
        hit = self.item()
        self.run_items([hit])
        os.environ['NOTIFY_EXIT'] = '0'
        with patch.object(t.time, 'time', return_value=self.now + 360):
            state, report, _ = self.run_items([])
        self.assertEqual(len(self.calls()), 2)
        self.assertEqual(self.calls()[0], self.calls()[1])
        self.assertIn(hit['id'], state['telegram_sent'])
        self.assertIn('telegram_sent_at', report['hits'][0])

    def test_deferred_security_followup_survives_otp_expiry_without_resending(self):
        self.run_items([self.item()])
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        with patch.object(t.time, 'time', return_value=self.now + 360):
            state, report, event = self.run_items([])
        self.assertEqual(len(self.calls()), 1)
        self.assertIn('already sent to Telegram', event)
        self.assertIn('telegram_sent_at', report['hits'][0])

    def test_down_continues_collecting_new_alerts_without_an_outbox(self):
        _, _, event = self.run_items([self.item(id='first')])
        self.assertEqual(event, '')
        state, _, event = self.run_items([self.item(id='second')])
        self.assertEqual(event, '')
        self.assertEqual(len(self.calls()), 2)
        self.assertNotIn('outbox', state)
        self.assertEqual({i['id'] for i in state['queue']}, {'first', 'second'})
        self.assertEqual(len(self.health_log.read_text().splitlines()), 2)

    def test_unavailable_bridge_cannot_trigger_runner_fallback(self):
        os.environ['HEALTH_EXIT'] = '1'
        state, report, event = self.run_items([self.item()])
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(event, '')
        self.assertNotIn('outbox', state)
        self.assertTrue(report['deferred_for_chat'])

    def test_replay_notified_when_chat_went_down_after_batch_created(self):
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        self.run_items([self.item()])
        os.environ['HEALTH_JSON'] = '{"ready":false,"openchamberConnected":false}'
        _, report, event = self.run_items([])
        self.assertEqual(len(self.calls()), 1)
        self.assertIn('telegram_sent_at', report['hits'][0])
        self.assertEqual(event, '')
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        _, _, event = self.run_items([])
        self.assertIn('already sent', event)

    def test_dry_and_scratch_only_record_would_send(self):
        _, report, _ = self.run_items([self.item()], dry=True)
        self.assertEqual(report['telegram_would_send'], [self.item()['id']])
        self.assertEqual(self.calls(), [])
        with patch.object(t, 'LIVE', self.wd / 'other-live'):
            state, report, _ = self.run_items([self.item()])
        self.assertEqual(report['telegram_would_send'], [self.item()['id']])
        self.assertEqual(state['telegram_sent'], {})
        self.assertEqual(self.calls(), [])

    def test_sent_state_pruned_and_test_guard_never_calls_real_telegram(self):
        state = {'telegram_sent': {'old': self.now - 49 * 3600, 'recent': self.now - 100}}
        report = {'hits': [{**self.item(), 'reason': 'Security: review'}]}
        del os.environ['ROBOB_WATCH_TELEGRAM_CLI']
        with patch.object(t, 'TELEGRAM_CLI', self.wd / 'must-not-run'):
            result = t.urgent_alerts(state, report, self.wd, self.now)
        self.assertNotIn('old', state['telegram_sent'])
        self.assertIn('recent', state['telegram_sent'])
        self.assertIn('refused: test run', str(result))
        self.assertEqual(self.calls(), [])

    def test_invalid_health_is_down_without_echoing_private_output(self):
        for data in ('private-token', '[]', '{}', '{"ready":false,"openchamberConnected":true}'):
            with self.subTest(data=data):
                os.environ['HEALTH_JSON'] = data
                down, why = t.chat_down()
                self.assertTrue(down)
                self.assertNotIn('private-token', why)
        os.environ['HEALTH_EXIT'] = '1'
        self.assertTrue(t.chat_down()[0])

    def test_probe_only_once_for_multiple_urgent_kinds(self):
        self.run_items([self.item(id='one'), self.item(id='two')])
        self.assertEqual(self.health_log.read_text().splitlines(), ['health'])
        self.assertEqual(len(self.calls()), 2)

    def test_withdrawal_uses_status_not_selected_by_classifier_while_chat_up(self):
        os.environ['HEALTH_JSON'] = '{"ready":true,"openchamberConnected":true}'
        pending = self.item(id='pending', sender='BTSE', subject='Withdrawal pending',
                            preview='TRX reference 20261108039187', ts=self.now - 90)
        complete = {**pending, 'id': 'completed', 'subject': 'Withdrawal Completed', 'ts': self.now - 30}
        with patch.object(t, 'load_module', side_effect=AssertionError('status is in collected items')):
            _, report, event = self.run_items([pending, complete], classify_ids={'pending'})
        self.assertEqual(report['hits'][0]['latest_status']['status'], 'Completed')
        self.assertEqual(report['hits'][0]['latest_status']['id'], 'completed')
        self.assertIn('latest status for ref 20261108039187: Completed', event)
        self.assertEqual(self.calls(), [])


class WithdrawalTests(unittest.TestCase):
    def hit(self, **kw):
        return {'id': 'pending', 'source': 'email', 'sender': 'BTSE <support@btse.com>',
                'subject': 'Withdrawal pending', 'preview': '311.88 TRX ref 20261108039187',
                'ts': 1000, 'reason': 'Withdrawal needs review', **kw}

    def test_newer_terminal_same_ref_in_batch(self):
        hit = self.hit()
        complete = self.hit(id='complete', subject='Withdrawal Completed', ts=1200)
        with patch.object(t, 'load_module', side_effect=AssertionError('must use batch')):
            t.withdrawal_statuses([hit], [hit, complete], 1500)
        self.assertEqual(hit['latest_status'], {'status': 'Completed', 'at': t.stamp(1200), 'id': 'complete'})
        self.assertIn('latest status for ref 20261108039187: Completed at 04:20', hit['reason'])

    def test_statuses_reference_forms_and_newest_match(self):
        for ref in ('20261108039187', '0x' + 'a1' * 32, 'AB' * 32):
            for status in ('Completed', 'Success', 'Successful', 'Failed', 'Cancelled', 'Rejected'):
                with self.subTest(ref=ref, status=status):
                    hit = self.hit(preview='TRX reference ' + ref)
                    rows = [self.hit(id='wrong', preview='TRX ref 20261108039999', subject='Completed', ts=1400),
                            self.hit(id='old', preview='TRX ref ' + ref, subject='Failed', ts=900),
                            self.hit(id='match', preview='TRX ref ' + ref, subject=status, ts=1200)]
                    t.withdrawal_statuses([hit], rows, 1500)
                    self.assertEqual(hit['latest_status']['status'], status)
                    self.assertEqual(hit['latest_status']['id'], 'match')

    def test_latest_pending_cannot_borrow_older_completed_status(self):
        hit = self.hit()
        rows = [self.hit(id='completed', subject='Withdrawal Completed', ts=1200),
                self.hit(id='pending-again', subject='Withdrawal pending', ts=1400)]
        with patch.object(t, 'load_module', side_effect=OSError):
            t.withdrawal_statuses([hit], rows, 1500)
        self.assertEqual(hit['latest_status'], 'not checked')

    def test_replay_drops_stale_status_reason_when_lookup_unavailable(self):
        hit = self.hit(reason='Review; latest status for ref 20261108039187: Completed at 04:20')
        with patch.object(t, 'load_module', side_effect=OSError):
            t.withdrawal_statuses([hit], [], 1500)
        self.assertEqual(hit['latest_status'], 'not checked')
        self.assertEqual(hit['reason'], 'Review')

    def test_terminal_status_context_table(self):
        # Status phrase class: direction, grammar, punctuation, and unrelated/conditional outcomes.
        cases = [
            ('Withdrawal Completed', '', 'Completed'),
            ('Withdrawal: Completed', '', 'Completed'),
            ('Withdrawal - Failed', '', 'Failed'),
            ('Successful TRX withdrawal', '', 'Successful'),
            ('Withdrawal update', 'Your withdrawal has been successfully completed', 'Completed'),
            ('Withdrawal update', 'Status: Success', 'Success'),
            ('Withdrawal update', 'Withdrawal request was rejected', 'Rejected'),
            ('Withdrawal pending', 'Identity verification successful; withdrawal pending processing', None),
            ('Withdrawal pending', 'Login successful. Your withdrawal is pending', None),
            ('Withdrawal pending', 'Password reset completed; waiting for withdrawal', None),
            ('Withdrawal pending', 'Withdrawal verification completed; request pending', None),
            ('Withdrawal pending', 'Successful withdrawal verification; withdrawal pending processing', None),
            ('Withdrawal pending', 'Successful withdrawal confirmation; withdrawal pending processing', None),
            ('Withdrawal pending', 'Completed withdrawal authentication; withdrawal pending processing', None),
            ('Withdrawal pending', 'Successful withdrawal address validation; still pending', None),
            ('Withdrawal pending', 'Successful withdrawal identity verification; still pending', None),
            ('Withdrawal pending', 'Completed withdrawal request confirmation; still pending', None),
            ('Withdrawal pending', 'Withdrawal has not completed', None),
            ('Withdrawal pending', 'If withdrawal completed, check your wallet', None),
            ('Withdrawal pending', 'Once your withdrawal is completed you will receive a notice', None),
        ]
        for subject, preview, expected in cases:
            with self.subTest(subject=subject, preview=preview):
                self.assertEqual(t.withdrawal_terminal_status({'subject': subject, 'preview': preview}), expected)

    def test_archive_search_is_same_ref_email_last_day_and_bounded(self):
        hit = self.hit()
        row = {**self.hit(id='archive', subject='Withdrawal Completed', ts=1200), 'snippet': hit['preview']}
        search = Mock(return_value=[row])
        mc = types.SimpleNamespace(charges=types.SimpleNamespace(search=search, show=Mock(return_value='Withdrawal Completed ref 20261108039187')))
        start = time.time()
        with patch.object(t, 'load_module', return_value=mc):
            t.withdrawal_statuses([hit], [hit], 1500)
        self.assertEqual(hit['latest_status']['id'], 'archive')
        self.assertEqual(search.call_args.args, ('"20261108039187"', '1969-12-31'))
        self.assertEqual(search.call_args.kwargs['source'], 'email')
        self.assertLessEqual(search.call_args.kwargs['deadline'], start + 3.1)
        self.assertEqual(mc.charges.show.call_args.kwargs['deadline'], search.call_args.kwargs['deadline'])

    def test_archive_unavailable_missing_reference_and_negated_status(self):
        for preview in ('TRX ref 20261108039187', 'TRX no reference'):
            hit = self.hit(preview=preview)
            with patch.object(t, 'load_module', side_effect=OSError):
                t.withdrawal_statuses([hit], [], 1500)
            self.assertEqual(hit['latest_status'], 'not checked')
        hit = self.hit()
        with patch.object(t, 'load_module', side_effect=OSError):
            t.withdrawal_statuses([hit], [self.hit(id='not-done', subject='Withdrawal not completed', ts=1200)], 1500)
        self.assertEqual(hit['latest_status'], 'not checked')


class KindTests(unittest.TestCase):
    def test_urgent_input_forms(self):
        for text in ('New login', 'New sign-in', 'New sign in', 'new device', 'login attempt',
                     'password changed', '2FA disabled', 'two-factor disabled', 'two factor authentication disabled'):
            with self.subTest(text=text):
                self.assertEqual(t.urgent_kind({'subject': text.upper()}), 'security')
        self.assertEqual(t.urgent_kind({'reason': 'Security: rotate token'}), 'security')
        for sender in ('BTSE', 'binance.com', 'OKX', 'Bybit', 'Kraken', 'Coinbase'):
            with self.subTest(sender=sender):
                self.assertEqual(t.urgent_kind({'sender': sender, 'subject': 'Withdrawal pending'}), 'withdrawal')
        self.assertIsNone(t.urgent_kind({'subject': 'Cash withdrawal from ATM'}))
        self.assertEqual(t.urgent_kind({'charge_question': 'unexplained'}), 'card')
        for text in ('decline', 'declined', 'card transaction alert'):
            self.assertEqual(t.urgent_kind({'preview': text}), 'card')
        for source in ('whatsapp', 'imessage', 'sms'):
            for text in ('at your door', 'outside', 'arrived', 'no answer'):
                self.assertEqual(t.urgent_kind({'source': source, 'sender': 'Careem driver', 'preview': text}), 'driver')
        self.assertIsNone(t.urgent_kind({'source': 'email', 'sender': 'noon', 'preview': 'arrived'}))
        self.assertIsNone(t.urgent_kind({'source': 'whatsapp', 'sender': 'friend', 'preview': 'outside'}))
