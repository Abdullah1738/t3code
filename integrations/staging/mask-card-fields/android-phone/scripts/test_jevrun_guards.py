"""Offline regression checks: never connect to or mutate the phone."""
import ast
import pathlib
import re
import unittest
import tempfile
import os
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import phonelock
from unittest.mock import patch

source = pathlib.Path(__file__).with_name('jevrun.py').read_text()
tree = ast.parse(source)
nodes = [n for n in tree.body if
         isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ('BLOCK', 'RID_BLOCK') for t in n.targets)
         or isinstance(n, ast.FunctionDef) and n.name in ('blocked', 'priority_check', 'obscured', 'state_matches', 'tap_match', 'talabat_chip_state', 'click', 'phone_call')]
scope = {'re': re, 'os': os, 'sys': sys, 'phonelock': phonelock}
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<guards>', 'exec'), scope)


class Guards(unittest.TestCase):
    def test_visual_chip_unknown_and_unselected(self):
        class SolidImage:
            width = 1080
            color = (255, 255, 255)
            def convert(self, mode): return self
            def crop(self, bounds): return self
            def getdata(self): return [self.color] * 2500
            def paste(self, color, bounds): self.color = (128, 128, 128)
        image = SolidImage()
        self.assertIs(scope['talabat_chip_state'](image, [45,812,331,1038]), False)
        self.assertIsNone(scope['talabat_chip_state'](image, [45,812,331,900]))
        image.paste('gray', (0,0,1080,2392))
        self.assertIsNone(scope['talabat_chip_state'](image, [45,812,331,1038]))

    def test_quantity_plus_is_not_add_more_icon(self):
        icon = {'label': 'plus', 'rid': ''}
        quantity = {'label': 'Plus', 'rid': ''}
        self.assertIs(scope['tap_match']([icon, quantity], 'Plus'), quantity)
        self.assertIsNone(scope['tap_match']([icon], 'id=plus'))

    def test_obscured_amazon_button(self):
        sheet = {'rid': 'appcx_bottom_sheet', 'bounds': [0, 1980, 1080, 2200]}
        self.assertTrue(scope['obscured']({'rid': 'add-to-cart-button', 'x': 540, 'y': 2047}, [sheet]))
        self.assertFalse(scope['obscured']({'rid': 'add-to-cart-button', 'x': 540, 'y': 1600}, [sheet]))

    def test_unknown_chip_state_never_passes(self):
        self.assertFalse(scope['state_matches']({'sel': False, 'checked': False}, False))
        self.assertTrue(scope['state_matches']({'checkable': True, 'checked': False}, False))
        self.assertFalse(scope['state_matches']({'checkable': True, 'checked': True}, False))

    def test_empty_hold_and_other_owner_yield(self):
        with tempfile.TemporaryDirectory() as tmp:
            hold = pathlib.Path(tmp) / 'priority-hold'
            original = phonelock.HOLD
            phonelock.HOLD = hold
            self.addCleanup(setattr, phonelock, 'HOLD', original)
            for contents, owner in [('', ''), ('someone-else', ''), ('someone-else', 'me')]:
                hold.write_text(contents)
                with patch.dict(os.environ, {'PHONE_HOLD_OWNER': owner}):
                    with self.assertRaises(SystemExit) as exc:
                        scope['priority_check']()
                    self.assertEqual(exc.exception.code, 5)
            hold.write_text('me')
            with patch.dict(os.environ, {'PHONE_HOLD_OWNER': 'me'}):
                scope['priority_check']()

    def test_commit_buttons_blocked(self):
        for label in ['Place order', 'AED 20 • Place Order', 'Yalla!', 'Buy Now',
                      'Pay AED 20', 'Pay ؎ 17.55', 'Place your order', 'REQUEST A CHAUFFEUR', 'Order Now', 'Join noon One', 'Subscribe',
                      'Cancel Order', 'Send', 'Send message', 'Submit return', 'Log out']:
            with self.subTest(label=label):
                self.assertTrue(scope['blocked'](label))

    def test_uber_commit_buttons_blocked(self):
        for label in ['Choose Lux', 'Choose Comfort', 'Unconfirm trip', 'Cancel trip', 'Add a tip', 'Book trip', 'Confirm', 'Request Lux']:
            with self.subTest(label=label):
                self.assertTrue(scope['blocked'](label))
        for rid in ['order_selection_request_button', 'ub__smart_trip_cancel_action_button', 'ub__sobriety_confirm_button', 'button_next']:
            with self.subTest(rid=rid):
                self.assertTrue(scope['RID_BLOCK'].search(rid))

    def test_cancelled_card_row_blocked(self):
        # 5542 was cancelled 29 Oct 2026; its payment row must never be tapped.
        for label in ['Pay with, ***5542', 'Pay with ***5542']:
            with self.subTest(label=label):
                self.assertTrue(scope['blocked'](label))

    def test_navigation_allowed(self):
        for label in ['Pay with, ***2342', 'Confirm pick-up', 'Orders',
                      'Checkout', 'View cart', 'No, thanks', 'Add item', 'Where to?', 'Wallet', 'Lux details', 'Remove payment method', 'Lux,Fare AED 75.65', 'Clear location text']:
            with self.subTest(label=label):
                self.assertFalse(scope['blocked'](label))

    def test_claim_taken_during_screen_read_refuses_click(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            patches = []
            for name, value in [('LOCK_DIR', pathlib.Path(tmp)), ('HOLD', pathlib.Path(tmp)/'priority-hold'),
                                ('LEASE', pathlib.Path(tmp)/'lease.json')]:
                p = patch.object(phonelock, name, value); p.start(); patches.append(p)
            try:
                device = Mock()
                def screen():
                    phonelock.acquire('other', 'qa')
                    return []
                local = dict(scope, d=device, elements=screen)
                functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ('click', 'phone_call')]
                exec(compile(ast.Module(body=functions, type_ignores=[]), '<race>', 'exec'), local)
                with self.assertRaises(SystemExit) as exc:
                    local['click'](dict(label='Continue', rid='continue', x=1, y=2))
                self.assertEqual(exc.exception.code, 5)
                device.click.assert_not_called()
            finally:
                for p in reversed(patches): p.stop()


if __name__ == '__main__':
    unittest.main()
