from pathlib import Path
import copy
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import commerce_journal as j
import commerce_preorder_release as r
from commerce_preorder import IntentVault
from noon_checkout import fingerprint
from noon_nownow_checkout import Snapshot
from test.test_commerce_preorder import Store


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.p = patch.object(j, 'ROOT', Path(self.tmp.name) / 'commerce')
        self.p.start(); self.addCleanup(self.p.stop)
        self.flow = '10000000-0000-4000-8000-000000000001'
        self.account = fingerprint('customer')
        j.open_flow(flow_id=self.flow, app='noon', vertical='nownow', account_hash=self.account, scope_hash='2'*64)
        args = dict(request_hash='3'*64, cart_hash='4'*64, review_hash='5'*64, payable_minor=2670)
        j.consume(self.flow, 'subscription', kind='preauthorize', **args)
        self.vault = IntentVault(Store())
        self.intent = self.vault.retain(self.flow, secret='synthetic', review_hash='5'*64,
            cart_hash='4'*64, card_hash=fingerprint('token'), payable_minor=2670)
        j.observe(self.flow, 'subscription', outcome='PREORDER_INTENT_RECEIVED', evidence_hash=self.intent)
        j.consume(self.flow, 'complete', kind='prepay', payment_intent_hash=self.intent, **args)
        j.observe(self.flow, 'complete', outcome='CHALLENGE_REQUIRED', evidence_hash='6'*64)
        self.state = {'binding': j.binding(self.flow), 'card_hash': fingerprint('token'), 'card_last4': '9546'}
        self.data = dict(status='payment_failed', transaction_status='FAILED', error_code='19046',
            currency_code='AED', payment_method_code='cc_noonpay', is_cc_payment=True,
            customer_code='customer', id_token='token', cc_masked='xxxx9546',
            authorized_amount=0, captured_amount=0, reversed_amount=0, refunded_amount=0, amount=1)
        self.client = Mock()

    def release(self):
        self.client._call.return_value = Snapshot(self.data, {}, time.time())
        with patch.object(r, 'review_cart', return_value=(self.state, self.client, {'digest': '5'*64})):
            return r.release(self.flow, vault=self.vault)

    def test_release_retains_sends_and_reservation_but_frees_account(self):
        before = j.inspect(self.flow)
        result = self.release()
        self.assertEqual(result['state'], 'RELEASED')
        self.assertFalse(result['financial_send'])
        self.assertFalse(result['retry_allowed'])
        j.require_account_available('noon', self.account)
        after = j.inspect(self.flow)
        self.assertEqual(after['operations'], before['operations'])
        self.assertEqual(after['reserved_minor'], 2670)
        self.client._call.assert_called_once()
        self.assertEqual(self.client._call.call_args.args[:2], ('payment_status', {'clientSecret': 'synthetic'}))
        with self.assertRaises(j.JournalError): self.release()

    def test_ambiguous_or_conflicting_status_never_releases(self):
        mutations = [dict(status='payment_pending'), dict(transaction_status='CAPTURED'),
            dict(error_code='0'), dict(redirect_url='https://example.test'),
            dict(authorized_amount=1), dict(captured_amount=1), dict(captured_amount=None),
            dict(refunded_amount=1), dict(reversed_amount=1), dict(customer_code='other'),
            dict(id_token='other'), dict(cc_masked='xxxx2342'), dict(currency_code='USD'),
            dict(orderNr='NNEXISTING')]
        original = copy.deepcopy(self.data)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.data = {**original, **mutation}
                with self.assertRaises(Exception): self.release()
                self.assertEqual(j.inspect(self.flow)['state'], 'FENCED')
        self.data = dict(original); del self.data['authorized_amount']
        with self.assertRaises(Exception): self.release()

    def test_success_history_cannot_be_released(self):
        j.observe(self.flow, 'complete', outcome='PREORDER_PAYMENT_CONFIRMED', evidence_hash='7'*64)
        with self.assertRaises(j.JournalError): self.release()
        self.client._call.assert_not_called()

    def test_atomic_journal_rechecks_intent_and_history(self):
        with self.assertRaises(j.JournalError):
            j.release_failed_preorder(self.flow, evidence_hash='8'*64, intent_hash='9'*64)
        j.observe(self.flow, 'complete', outcome='PREORDER_PAYMENT_CONFIRMED', evidence_hash='7'*64)
        with self.assertRaises(j.JournalError):
            j.release_failed_preorder(self.flow, evidence_hash='8'*64, intent_hash=self.intent)

    def test_missing_exact_cart_stays_fenced(self):
        with patch.object(r, 'review_cart', side_effect=j.JournalError('EXACT_CART_MISSING')):
            with self.assertRaises(j.JournalError): r.release(self.flow, vault=self.vault)
        self.assertEqual(j.inspect(self.flow)['state'], 'FENCED')

    def test_unobserved_send_and_placement_are_never_released(self):
        with j._db() as db:
            db.execute("UPDATE operations SET state='MAY_HAVE_SENT' WHERE flow_id=? AND name='complete'", (self.flow,))
        with self.assertRaises(j.JournalError): self.release()
        with self.assertRaises(j.JournalError):
            j.release_failed_preorder(self.flow, evidence_hash='8'*64, intent_hash=self.intent)
        with j._db() as db:
            db.execute("UPDATE operations SET state='OBSERVED',kind='place' WHERE flow_id=? AND name='complete'", (self.flow,))
        with self.assertRaises(j.JournalError): self.release()
        with self.assertRaises(j.JournalError):
            j.release_failed_preorder(self.flow, evidence_hash='8'*64, intent_hash=self.intent)

    def test_cli_other_lanes_require_exact_order_reconciliation(self):
        import commerce_cli
        from types import SimpleNamespace
        for lane in ('food', 'main', 'supermall'):
            with self.subTest(lane=lane), patch.object(j, 'binding', return_value={'app': 'noon', 'vertical': lane}):
                with self.assertRaisesRegex(j.JournalError, 'RELEASE_EXACT_ORDER_RECONCILIATION_REQUIRED'):
                    commerce_cli.release_flow(SimpleNamespace(flow_id=self.flow))


class CartReviewTests(unittest.TestCase):
    def test_exact_cart_review_rejects_changed_session_amount_and_identity(self):
        from test import test_commerce_nownow_order as f
        import commerce_receipts
        import order_card
        from commerce_nownow import reader
        from commerce_nownow_capture import retain
        with tempfile.TemporaryDirectory() as temp, patch.object(j, 'ROOT', Path(temp).resolve()/'commerce'), \
                patch.object(commerce_receipts, 'ROOT', Path(temp).resolve()/'commerce'), \
                patch.object(order_card, 'LAST4', '2342'), patch.object(order_card, 'NETWORK', 'mastercard'):
            flow, wire = f.make_flow(f.happy_responses())
            flow.prepare_only()
            retain(flow)
            wire.responses['carts_recent'] = {'data': {'carts': [copy.deepcopy(wire.responses['cart_get']['data'])]}}
            client = reader(auth=f.FakeAuth())
            client._request = wire.request
            with patch.object(r, 'reader', return_value=client):
                before = len(wire.calls)
                r.review_cart(flow.flow_id, auth=f.FakeAuth())
                self.assertEqual([name for name, _ in wire.calls[before:]], ['home', 'carts_recent', 'payment_cards'])
                j.abandon(flow.flow_id)
                import commerce_cli
                import contextlib
                import io
                import json
                with patch.object(commerce_cli, 'CommerceAuth') as auth, contextlib.redirect_stdout(io.StringIO()) as output:
                    auth.return_value.noon = f.FakeAuth()
                    before = len(wire.calls)
                    rc = commerce_cli.main(['order', 'nownow', '--store-code', f.STORE,
                        '--product-code', f.PRODUCT, '--quantity', '1', '--prepare-only', '--resume-flow', flow.flow_id])
                self.assertEqual(rc, 0, output.getvalue())
                self.assertTrue(json.loads(output.getvalue())['released_cart_review_only'])
                self.assertEqual([name for name, _ in wire.calls[before:]], ['home', 'carts_recent', 'payment_cards'])
                row = wire.responses['carts_recent']['data']['carts'][0]
                for key, value in (('checkoutSessionCode', 'other'), ('orderTotal', 100),
                                   ('customerCode', 'other'), ('orderNr', 'NNEXISTING'),
                                   ('driverNotes', ''), ('addressVersion', 2)):
                    with self.subTest(key=key):
                        old = row.get(key); row[key] = value
                        with self.assertRaises(Exception): r.review_cart(flow.flow_id, auth=f.FakeAuth())
                        if old is None: row.pop(key)
                        else: row[key] = old
                for key, value in (('notes', 'new note'), ('modifiers', {'free-option': 1})):
                    with self.subTest(product_field=key):
                        item = row['products'][0]
                        old = item.get(key); item[key] = value
                        with self.assertRaisesRegex(j.JournalError, 'CART_CUSTOMIZATION_CHANGED'):
                            r.review_cart(flow.flow_id, auth=f.FakeAuth())
                        if old is None: item.pop(key)
                        else: item[key] = old
                row['notes'] = 'new basket note'
                with self.assertRaisesRegex(j.JournalError, 'CART_CUSTOMIZATION_CHANGED'):
                    r.review_cart(flow.flow_id, auth=f.FakeAuth())


if __name__ == '__main__':
    unittest.main()
