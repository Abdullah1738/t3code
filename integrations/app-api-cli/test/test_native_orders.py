import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native_orders as orders
import order_tracker as tracker


class NativeOrdersTest(unittest.TestCase):
    def test_exact_identity_and_no_payment_leak(self):
        data = {'status': 'delivered', 'csHelpLabels': {'orderNumber': 'I123'},
                'rider': {'name': 'Rider', 'showRiderDetails': False,
                          'postOrderTipDetails': {'paymentToken': 'secret'}}}
        result = orders.minutes_track(data, 'I123')
        self.assertEqual(result['status'], 'delivered')
        self.assertIsNone(result['rider'])
        self.assertNotIn('secret', str(result))
        with self.assertRaises(orders.OrderError):
            orders.minutes_track(data, 'I456')

    def test_unknown_and_future_text_never_delivered(self):
        for value in ['delivery expected', 'will be delivered', 'new_enum', None]:
            self.assertEqual(orders.stage(value), 'unknown')

    def test_guest_fails_without_network(self):
        with patch.object(orders, 'request') as request:
            for app in ('talabat', 'careem'):
                with self.assertRaisesRegex(orders.OrderError, 'GUEST'):
                    orders.track(app, '123')
            request.assert_not_called()

    def test_native_success_skips_fallback(self):
        native = orders.minutes_track({'status': 'delivered',
                                      'csHelpLabels': {'orderNumber': 'I123'}}, 'I123')
        with patch.object(orders, 'track', return_value=native), \
             patch.object(tracker, 'mail_evidence') as mail, patch.object(tracker, 'run') as adb:
            result = tracker.fetch({'app': 'noon', 'order': 'I123'}, {}, 100)
        self.assertEqual(result['status'], 'delivered')
        mail.assert_not_called()
        adb.assert_not_called()

    def test_stage_changes_deduplicate(self):
        state = {'primed': True, 'status': 'placed'}
        cfg = {'registered_at': tracker.stamp(100)}
        result = {'status': 'preparing', 'errors': []}
        first = tracker.transition(result, state, cfg, 101)
        self.assertEqual(first[0]['kind'], 'stage_change')
        self.assertEqual(tracker.transition(result, state, cfg, 102), [])

    def test_partial_marketplace_never_certifies_delivered(self):
        with patch.object(orders, 'orders', return_value={'orders': [
                {'order': 'N123', 'status': 'delivered'}]}):
            self.assertEqual(orders.track('noon', 'N123')['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
