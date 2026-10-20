import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import talabat_address_watch as watch


def listing(*orders, status='delivered'):
    return {'ok': True, 'account_verified': True,
            'orders': [{'order': order, 'status': status, 'branch_name': 'Test restaurant'} for order in orders]}


def detail(order, home):
    return {'ok': True, 'account_verified': True, 'order': order, 'status': 'preparing', 'is_home': home,
            'delivery_address': {'label': 'Apartment' if home else 'Work', 'text': 'Synthetic destination'}}


class WatchTest(unittest.TestCase):
    def test_bootstrap_quiet_and_new_office_once_home_silent(self):
        state = {}
        read = Mock(return_value=listing('1'))
        self.assertEqual(watch.tick(state, 1000, read), [])
        read.assert_called_once()
        read = Mock(side_effect=[listing('3', '2', '1'), detail('3', False), detail('2', True)])
        events = watch.tick(state, 1060, read)
        self.assertEqual(len(events), 1)
        self.assertIn('order 3', events[0])
        self.assertIn('not home', events[0])
        self.assertEqual(state['orders']['2']['result'], 'home')
        read = Mock(return_value=listing('3', '2', '1'))
        self.assertEqual(watch.tick(state, 1120, read), [])
        read.assert_called_once()

    def test_active_order_on_bootstrap_is_checked_after_prime(self):
        state = {}
        self.assertEqual(watch.tick(state, 1000, Mock(return_value=listing('1', status='preparing'))), [])
        events = watch.tick(state, 1060, Mock(side_effect=[listing('1'), detail('1', False)]))
        self.assertEqual(len(events), 1)

    def test_old_cancelled_native_enum_is_baselined_even_if_stage_unknown(self):
        state = {}
        history = listing('1', status='unknown')
        history['orders'][0]['raw_status'] = 'Cancelled'
        self.assertEqual(watch.tick(state, 1000, Mock(return_value=history)), [])
        self.assertEqual(state['orders']['1']['result'], 'baseline')

    def test_auth_outage_alerts_once_and_recovers_without_losing_new_orders(self):
        state = {}
        watch.tick(state, 1000, Mock(return_value=listing('1')))
        read = Mock(side_effect=watch.ReadError('AUTH_FORBIDDEN'))
        self.assertEqual(watch.tick(state, 1060, read), [])
        self.assertEqual(watch.tick(state, 1120, read), [])
        self.assertEqual(len(watch.tick(state, 1360, read)), 1)
        self.assertEqual(watch.tick(state, 1660, read), [])
        self.assertEqual(watch.tick(state, 1960, read), [])
        events = watch.tick(state, 2260, Mock(side_effect=[listing('2', '1'), detail('2', False)]))
        self.assertEqual(len(events), 1)
        self.assertIn('order 2', events[0])
        self.assertNotIn('failures', state['health'])

    def test_unknown_address_retried_and_alerted_without_claiming_not_home(self):
        state = {}
        watch.tick(state, 1000, Mock(return_value=listing('1')))
        read = Mock(side_effect=lambda *args, **kw: listing('2', '1') if args[0] == 'orders' else detail('2', None))
        self.assertEqual(watch.tick(state, 1060, read), [])
        self.assertEqual(watch.tick(state, 1120, read), [])
        events = watch.tick(state, 1360, read)
        self.assertEqual(len(events), 1)
        self.assertIn('cannot be verified', events[0])
        self.assertNotIn('not home', events[0])
        self.assertEqual(watch.tick(state, 1660, read), [])
        events = watch.tick(state, 1960, Mock(side_effect=[listing('1'), detail('2', False)]))
        self.assertEqual(len(events), 1)  # retained even if missing from later list page

    def test_detail_work_is_bounded_and_remaining_orders_stay_pending(self):
        state = {}
        watch.tick(state, 1000, Mock(return_value=listing('1')))
        read = Mock(side_effect=lambda *args, **kw: listing('5', '4', '3', '2', '1')
                    if args[0] == 'orders' else detail(args[1], True))
        self.assertEqual(watch.tick(state, 1060, read), [])
        self.assertEqual(read.call_count, 4)
        self.assertNotIn('result', state['orders']['2'])
        self.assertEqual(watch.tick(state, 1120, read), [])
        self.assertEqual(state['orders']['2']['result'], 'home')

    def test_outbox_replays_until_runner_ack_then_dedupes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            watch.run(path, 'prime', Mock(return_value=listing('1')), now=1000)
            event = watch.run(path, 'first', Mock(side_effect=[listing('2', '1'), detail('2', False)]), now=1060)
            self.assertTrue(event)
            read = Mock(side_effect=AssertionError('must replay before network'))
            self.assertEqual(watch.run(path, 'retry', read, now=1120), event)
            read.assert_not_called()
            (path / '.run-ok').write_text('retry\n')
            self.assertEqual(watch.run(path, 'next', Mock(return_value=listing('2', '1')), now=1180), '')
            self.assertNotIn('outbox', json.loads((path / watch.STATE).read_text()))

    def test_cli_errors_sanitized_and_account_binding_required(self):
        for response, code, expected in [(json.dumps({'ok': True}), 0, 'ORDER_ACCOUNT_UNVERIFIED'),
                                         (json.dumps({'ok': False, 'error': 'secret credential text'}), 1, 'ORDER_READ_UNAVAILABLE')]:
            with self.subTest(expected=expected), patch.object(watch.subprocess, 'run', return_value=Mock(stdout=response, returncode=code)):
                with self.assertRaisesRegex(watch.ReadError, expected):
                    watch.read_cli('orders')
