import sys
from pathlib import Path
import time
import unittest
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


if __name__ == '__main__':
    unittest.main()
