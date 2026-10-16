"""Delayed merchant confirmation must wake once after 30 minutes."""
import unittest
from unittest.mock import patch

import order_tracker as t
import talabat_http_orders as http
from test.test_talabat_http_orders import screen


class ConfirmationDelayTest(unittest.TestCase):
    def fetch(self, state, age, raw='order_confirmingdelayed'):
        now = 10000
        cfg = {'app': 'talabat', 'order': '123', 'placed_at': t.stamp(now - age),
               'registered_at': t.stamp(now - age), 'eta': t.stamp(now + 3600)}
        with patch('native_orders.track', return_value=http.project(screen(status=raw), '123')), \
                patch.object(t, 'talabat_receipt', side_effect=AssertionError('no fallback')):
            result = t.fetch(cfg, state, now)
        return result, t.transition(result, state, cfg, now)

    def test_long_delayed_confirmation_wakes_despite_known_stage_and_future_eta(self):
        state = {'primed': True, 'status': 'placed'}
        result, events = self.fetch(state, 1801)
        self.assertEqual(result['raw_status'], 'order_confirmingdelayed')
        self.assertEqual(result['merchant_acceptance'], 'unconfirmed')
        problems = [e for e in events if e['kind'] == 'problem']
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]['stage'], 'merchant_confirmation_delayed')
        self.assertIn('payment', problems[0]['message'])
        self.assertEqual(self.fetch(state, 1900)[1], [])

    def test_short_delay_remains_visible_but_does_not_wake(self):
        result, events = self.fetch({'primed': True, 'status': 'placed'}, 1799)
        self.assertEqual(events, [])
        self.assertIn('not confirmed', result['status_text'])

    def test_overdue_at_registration_wakes_on_next_tick(self):
        state = {}
        self.assertEqual(self.fetch(state, 3600)[1], [])
        self.assertEqual([e['kind'] for e in self.fetch(state, 3660)[1]], ['problem'])

    def test_preparing_clears_current_problem(self):
        result, events = self.fetch({'primed': True, 'status': 'placed'}, 3600, 'order_preparing')
        self.assertNotIn('problem', result)
        self.assertEqual(events, [{'kind': 'stage_change', 'status': 'preparing'}])

    def test_exact_projection_never_silently_calls_delay_accepted(self):
        result = http.project(screen(status='order_confirmingdelayed'), '123')
        self.assertEqual(result['merchant_acceptance'], 'unconfirmed')
        self.assertIn('not confirmed', result['problem']['message'])

    def test_missing_placement_timestamp_uses_first_seen_without_inventing_age(self):
        state = {'primed': True, 'status': 'placed'}
        cfg = {'app': 'talabat', 'order': '123'}
        with patch('native_orders.track', side_effect=lambda *_args, **_kw:
                   http.project(screen(status='order_confirmingdelayed'), '123')):
            first = t.fetch(cfg, state, 10000)
            self.assertNotIn('problem', first)
            later = t.fetch(cfg, state, 11800)
            self.assertEqual(later['problem']['age_source'], 'first_observed_delay')
            self.assertEqual(later['problem']['pending_seconds'], 1800)

    def test_only_exact_delayed_enum_raises_merchant_problem(self):
        result, events = self.fetch({'primed': True, 'status': 'placed'}, 3600, 'order_confirming')
        self.assertNotIn('problem', result)
        self.assertEqual(events, [])


if __name__ == '__main__':
    unittest.main()
