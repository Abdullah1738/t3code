import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import importlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import order_card
import noon_minutes_checkout
import commerce_nownow_order
from noon_minutes_checkout import MinutesError
from commerce_journal import JournalError


def noon_row(token, mask, deleted=False):
    return {'id': token, 'ccMasked': mask, 'ccType': 'visa', 'isDeleted': deleted,
            'isDefault': True, 'isSelected': True}


class OrderCardTests(unittest.TestCase):
    def test_default_is_9546_and_env_override_is_validated(self):
        self.assertEqual(order_card.LAST4, '9546')
        self.assertEqual(order_card.CVV_ACCOUNT, 'MashreqNoon.card_cvc')
        self.assertEqual(order_card.NETWORK, 'visa')
        with patch.dict(os.environ, {'COMMERCE_CARD_LAST4': '2342'}):
            importlib.reload(order_card)
            self.assertEqual(order_card.LAST4, '2342')
            self.assertEqual(order_card.CVV_ACCOUNT, 'Marriott.card_cvc')
            self.assertEqual(order_card.NETWORK, 'mastercard')
        for bad in ('1234', '5542', 'abcd', '12345', ''):
            with self.subTest(value=bad), patch.dict(os.environ, {'COMMERCE_CARD_LAST4': bad}):
                with self.assertRaisesRegex(RuntimeError, 'ORDER_CARD_CONFIG_INVALID'):
                    importlib.reload(order_card)
        self.addCleanup(lambda: (os.environ.pop('COMMERCE_CARD_LAST4', None), importlib.reload(order_card)))
        os.environ.pop('COMMERCE_CARD_LAST4', None)
        importlib.reload(order_card)
        self.assertEqual(order_card.LAST4, '9546')
        self.assertEqual(order_card.CVV_ACCOUNT, 'MashreqNoon.card_cvc')
        self.assertEqual(order_card.NETWORK, 'visa')


class NoonSelectionTests(unittest.TestCase):
    def test_noon_minutes_picks_9546_not_5542(self):
        data = {'data': [noon_row('1111111111', '52287301xxxx5542'), noon_row('2222222222', '52287301xxxx9546')]}
        self.assertEqual(noon_minutes_checkout.saved_order_card(data).token, '2222222222')

    def test_noon_minutes_refuses_a_lone_5542_card(self):
        data = {'data': [noon_row(1111111111, '52287301xxxx5542')]}
        with self.assertRaisesRegex(MinutesError, 'SAVED_CARD_NOT_UNIQUE'):
            noon_minutes_checkout.saved_order_card(data)

    def test_nownow_picks_9546_not_5542(self):
        client = SimpleNamespace(payment_cards=lambda timeout=25: SimpleNamespace(wire={
            'data': [noon_row(1111111111, '52287301xxxx5542'), noon_row(2222222222, '52287301xxxx9546')]}))
        self.assertEqual(commerce_nownow_order.saved_card(client).token, '2222222222')

    def test_nownow_refuses_a_lone_5542_card(self):
        client = SimpleNamespace(payment_cards=lambda timeout=25: SimpleNamespace(wire={
            'data': [noon_row(1111111111, '52287301xxxx5542')]}))
        with self.assertRaisesRegex(JournalError, 'NOWNOW_SAVED_CARD_NOT_UNIQUE'):
            commerce_nownow_order.saved_card(client)


if __name__ == '__main__':
    unittest.main()
