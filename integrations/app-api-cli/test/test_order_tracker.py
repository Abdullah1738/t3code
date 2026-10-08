import sys
from pathlib import Path
import time
import unittest
import json
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import order_tracker as t


class TrackerTest(unittest.TestCase):
    def cfg(self):
        return {'app': 'talabat', 'order': '12345', 'placed_at': t.stamp(time.time()-3600),
                'registered_at': t.stamp(), 'eta': t.stamp(time.time()-600)}

    def result(self, status='unknown'):
        return {'status': status, 'errors': []}

    def test_delivery_promises_are_not_delivery(self):
        for text in ['Your order will be delivered today', 'Your order is not delivered',
                     'Free delivery when you order', 'Your rider has arrived at the restaurant']:
            self.assertNotEqual(t.classify(text), 'delivered')
        self.assertEqual(t.classify('Your order has been delivered'), 'delivered')

    def test_notification_identity_and_age(self):
        cfg = self.cfg()
        def dump(text, timestamp=None):
            return f'NotificationRecord(x: pkg=com.talabat id=1)\nwhen={int((timestamp or time.time())*1000)}\nandroid.text=String ({text})'
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg), [])
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg, True)[0]['confidence'], 'single_active_app_unconfirmed')
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered'), cfg)[0]['stage'], 'delivered')
        self.assertEqual(t.notifications(dump('Order 912345 has been delivered'), cfg), [])
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered', time.time()-7200), cfg), [])

    def test_baseline_delay_once_and_terminal(self):
        state, cfg = {}, self.cfg()
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result(), state, cfg, time.time())[0]['kind'], 'eta_elapsed')
        self.assertEqual(t.transition(self.result(), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result('delivered'), state, cfg, time.time())[0]['status'], 'delivered')
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(state['status'], 'delivered')

    def test_candidate_dedupe_does_not_confirm_delivery(self):
        state = {'primed': True, 'delay_sent': True}
        result = self.result()
        result['candidate'] = {'stage': 'delivered', 'evidence': 'App says delivered'}
        self.assertEqual(t.transition(result, state, self.cfg(), time.time())[0]['kind'], 'candidate')
        self.assertEqual(t.transition(result, state, self.cfg(), time.time()), [])
        self.assertNotEqual(state.get('status'), 'delivered')

    def receipt_cfg(self):
        return {'app': 'talabat', 'order': '3943292030', 'for': 'moni',
                'placed_at': '2026-10-08T11:48:46+04:00', 'registered_at': '2026-10-08T07:50:07+00:00',
                'eta': '2026-10-08T12:49:00+04:00'}

    def mailsearch(self, hits, ok=True):
        out = json.dumps({'status': {'gmail': {'ok': ok}}, 'hits': hits})
        return mock.patch.object(t.subprocess, 'run', return_value=mock.Mock(stdout=out, returncode=0))

    # Real 8 Oct 2026 receipt (order ID only inside the PDF attachment).
    REAL = {'account': 'gmail', 'folder': '[Gmail]/All Mail', 'uid': 265136, 'date': '2026-10-08 12:36',
            'from': 'Talabat <noreply@talabat.com>', 'subject': 'Your service charges Receipt'}

    def test_talabat_receipt_email_is_delivered(self):
        with self.mailsearch([self.REAL]) as run:
            proof, errors = t.talabat_receipt(self.receipt_cfg())
        query = run.call_args[0][0][-1]
        self.assertIn('"3943292030"', query)
        self.assertIn('subject:receipt', query)
        self.assertEqual((proof['stage'], proof['confidence'], errors), ('delivered', 'exact_order', []))
        self.assertTrue(proof['email_date'].startswith('2026-10-08T12:36'))

    def test_receipt_rejects_other_senders_subjects_and_older_mail(self):
        for hit in [dict(self.REAL, **{'from': 'Talabat <noreply@talabat.com.evil.io>'}),
                    dict(self.REAL, subject='Your PostPaid order was approved'),
                    dict(self.REAL, date='2026-10-07 13:28')]:
            with self.mailsearch([hit]):
                self.assertIsNone(t.talabat_receipt(self.receipt_cfg())[0])
        with self.mailsearch([], ok=False):
            self.assertEqual(t.talabat_receipt(self.receipt_cfg()), (None, ['receipt_email_unavailable:gmail']))

    def test_replay_8_oct_receipt_fires_delivered_before_eta(self):
        cfg = self.receipt_cfg()
        state = {'primed': True}
        at = t.epoch('2026-10-08T12:37:00+04:00')
        native = mock.patch('native_orders.track', side_effect=__import__('native_orders').OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY'))
        with native, self.mailsearch([self.REAL]), \
             mock.patch.object(t, 'mail_evidence', return_value=([], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])), \
             mock.patch.object(t, 'single_allowed', return_value=False):
            result = t.fetch(cfg, state, at)
            events = t.transition(result, state, cfg, at)
            self.assertEqual(result['status'], 'delivered')
            self.assertEqual(events, [{'kind': 'stage_change', 'status': 'delivered'}])
            # Cached receipt: no re-query, no duplicate event, no later eta_elapsed.
            later = at + 1800
            result = t.fetch(cfg, state, later)
            self.assertEqual(t.transition(result, state, cfg, later), [])


if __name__ == '__main__':
    unittest.main()
