import sys
import fcntl
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import talabat_ui_orders as ui


def node(text='', **kwargs):
    return ET.Element('node', {'package': 'com.talabat', 'bounds': '[0,0][100,100]',
                              'content-desc': text, **kwargs})


def screen(*texts):
    root = ET.Element('hierarchy')
    root.extend(node(t) for t in texts)
    return ET.tostring(root, encoding='unicode')


class UIOrdersTest(unittest.TestCase):
    def test_standalone_orders_screen_without_bottom_nav(self):
        root = ET.Element('hierarchy')
        root.extend([node('Orders'), node('All', selected='true')])
        self.assertTrue(ui.on_orders(ET.tostring(root)))
        self.assertFalse(ui.on_orders(screen('Orders', 'All')))

    def test_order_cards_do_not_borrow_status(self):
        root = ET.Element('hierarchy')
        for oid, state in [('123', 'Delivered'), ('456', 'Preparing your order'), ('789', 'will be delivered')]:
            card = node()
            card.extend(node(t) for t in (f'Order ID: {oid}', state, 'View details', 'private payment data'))
            root.append(card)
        result = ui.parse_orders(ET.tostring(root))
        self.assertEqual([r['status'] for r in result], ['delivered', 'preparing', 'unknown'])
        self.assertNotIn('private', str(result))

    def test_changed_card_grouping_fails_closed(self):
        root = node()
        root.extend(node(t) for t in ['Order ID: 123', 'Order ID: 456', 'Delivered', 'View details'])
        self.assertEqual(ui.parse_orders(ET.tostring(root)), [])

    def test_tracking_requires_exact_id_on_screen(self):
        top = screen('Order delivered', 'Your order from', 'private address')
        result = ui.parse_tracking(top, screen('Order #123'), screen('Order #123'), '123')
        self.assertEqual(result['status'], 'delivered')
        self.assertEqual(result['source'], 'android_ui')
        self.assertNotIn('private', str(result))
        for lower in [screen('Order #456'), screen('Order #1234'), screen('No ID'), screen('Order #123', 'Order #456')]:
            with self.assertRaisesRegex(ui.UIError, 'IDENTITY'):
                ui.parse_tracking(top, screen('Order #123'), lower, '123')
            with self.assertRaisesRegex(ui.UIError, 'IDENTITY'):
                ui.parse_tracking(top, lower, screen('Order #123'), '123')

    def test_conflict_future_and_address_never_prove_delivery(self):
        for texts in [('Order delivered', 'Order cancelled'), ('Delivered to',), ('Will be delivered',)]:
            self.assertEqual(ui.status(texts), ('unknown', None))

    def test_early_arrival_requires_completed_tracking_companions(self):
        texts = ('Arrived 13 mins early ..', '100%, Progress is',
                 'We beat the clock! Enjoy your order', 'Your order from')
        result = ui.parse_tracking(screen(*texts), screen('Order #123'), screen('Order #123'), '123')
        self.assertEqual(result['status'], 'delivered')
        for partial in [texts[:1], texts[:2], ('Arrives in 13 mins',) + texts[1:]]:
            result = ui.parse_tracking(screen('Your order from', *partial), screen('Order #123'), screen('Order #123'), '123')
            self.assertEqual(result['status'], 'unknown')
        for conflict in ['Order cancelled', 'Preparing your order']:
            self.assertEqual(ui.tracking_status((*texts, conflict)), ('unknown', None))

    def test_initial_unbound_header_is_discarded(self):
        stale = screen('Order delivered', 'Your order from')
        identity = screen('Your order from', 'Order #123')
        current = screen('Preparing your order', 'Your order from')
        phone = ui.Phone()
        with patch.object(phone, 'orders'), patch.object(phone, 'route'), \
             patch.object(phone, 'stable', return_value=stale), \
             patch.object(phone, 'identity', return_value=identity) as identify, \
             patch.object(phone, 'swipe', side_effect=[current, current]):
            result = phone.track('123')
        self.assertEqual(result['status'], 'preparing')
        self.assertEqual(identify.call_count, 2)

    def test_hold_prevents_all_phone_access(self):
        with tempfile.TemporaryDirectory() as temp:
            hold = Path(temp) / 'priority-hold'
            hold.write_text('different-task')
            with patch.object(ui, 'HOLD', hold), patch.object(ui, 'Phone') as phone:
                with self.assertRaisesRegex(ui.UIError, 'PHONE_BUSY'):
                    ui.run('track', '123')
                phone.assert_not_called()
            self.assertEqual(hold.read_text(), 'different-task')

    def test_shared_plan_lock_prevents_all_phone_access(self):
        with tempfile.TemporaryDirectory() as temp:
            hold = Path(temp) / 'priority-hold'
            with (hold.parent / 'jevrun.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(ui, 'HOLD', hold), patch.object(ui, 'Phone') as phone:
                    with self.assertRaisesRegex(ui.UIError, 'PHONE_BUSY'):
                        ui.run('orders')
                    phone.assert_not_called()

    def test_hidden_nodes_do_not_certify_completion(self):
        root = ET.Element('hierarchy')
        root.append(node('Order delivered', **{'visible-to-user': 'false'}))
        root.append(node('Your order from'))
        result = ui.parse_tracking(ET.tostring(root), screen('Order #123'), screen('Order #123'), '123')
        self.assertEqual(result['status'], 'unknown')

    def test_hold_appearing_mid_run_prevents_command(self):
        with tempfile.TemporaryDirectory() as temp:
            hold = Path(temp) / 'priority-hold'
            with patch.object(ui, 'HOLD', hold), patch.object(ui.subprocess, 'run') as adb:
                phone = ui.Phone()
                hold.write_text('new-owner')
                with self.assertRaisesRegex(ui.UIError, 'PHONE_BUSY'):
                    phone.adb('input', 'keyevent', 'KEYCODE_WAKEUP')
                adb.assert_not_called()

    def test_invalid_id_never_reaches_phone(self):
        with patch.object(ui, 'Phone') as phone:
            for oid in ['', '123&x=1', 'abc', '../123']:
                with self.assertRaisesRegex(ui.UIError, 'INVALID_ORDER_ID'):
                    ui.run('track', oid)
            phone.assert_not_called()


if __name__ == '__main__':
    unittest.main()
