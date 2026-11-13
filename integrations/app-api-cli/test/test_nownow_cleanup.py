import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import commerce_journal as j
import commerce_receipts
import commerce_nownow_cleanup as cleanup
import commerce_preorder_release as release
import commerce_nownow as reads
from commerce_nownow_capture import retain
import order_card
from test import test_commerce_nownow_order as f


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for mod, key, value in [(j, 'ROOT', Path(self.temp.name)/'commerce'),
            (commerce_receipts, 'ROOT', Path(self.temp.name)/'commerce'),
            (order_card, 'LAST4', '2342'), (order_card, 'NETWORK', 'mastercard')]:
            p = patch.object(mod, key, value); p.start(); self.addCleanup(p.stop)
        self.flow, self.wire = f.make_flow(f.happy_responses())
        self.flow.prepare_only()
        self.assertEqual(j.inspect(self.flow.flow_id)['reserved_minor'], 0)
        self.row = copy.deepcopy(self.wire.responses['cart_get']['data'])
        self.wire.responses['carts_recent'] = {'data': {'carts': [self.row]}}
        j.abandon(self.flow.flow_id)
        self.client = reads.reader(auth=f.FakeAuth()); self.client._request = self.wire.request
        for mod in (release, reads):
            p = patch.object(mod, 'reader', return_value=self.client); p.start(); self.addCleanup(p.stop)
        self.deletes = []

    def request(self, operation, headers, deadline, payload, **kw):
        if operation == 'cart_delete':
            self.deletes.append((operation, payload))
        self.wire.responses['cart_delete'] = {'status': 'success', 'data': None}
        self.wire.responses['cart_get'] = {'status': 'success', 'data': None}
        self.wire.responses['carts_recent'] = {'data': {'carts': []}}
        return self.wire.request(operation, headers, deadline, payload, **kw)

    def clear(self, request=None):
        return cleanup.clear_cart(self.flow.flow_id, auth=f.FakeAuth(), request=request or self.request)

    def test_clear_exact_session_and_independent_readback(self):
        result = self.clear()
        self.assertTrue(result['cart_empty']); self.assertFalse(result['financial_send'])
        self.assertEqual(self.deletes, [('cart_delete', {'sessionCode': self.row['checkoutSessionCode']})])
        self.assertEqual(j.inspect(result['cleanup_flow_id'])['state'], 'RELEASED')
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(len(self.deletes), 1)

    def test_open_flow_blocks_before_delete(self):
        j.open_flow(flow_id='10000000-0000-4000-8000-000000000099', app='noon', vertical='nownow',
                    account_hash=self.flow.account_hash, scope_hash='a'*64)
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(self.deletes, [])

    def test_changed_cart_blocks(self):
        self.row['products'][0]['qty'] = 9
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(self.deletes, [])

    def test_lost_response_never_retries(self):
        def lost(*a, **kw):
            self.deletes.append(a[0]); raise TimeoutError()
        with self.assertRaises(cleanup.CleanupUnverified) as failure: self.clear(lost)
        cleanup_id = failure.exception.details['cleanup_flow_id']
        self.assertTrue((j.ROOT/'nownow-cleanup'/(cleanup_id+'.json')).exists())
        with self.assertRaisesRegex(j.JournalError, 'CLEAR_EMPTY_READBACK_REQUIRED'): j.abandon(cleanup_id)
        with self.assertRaises(Exception): self.clear(lost)
        self.assertEqual(self.deletes, ['cart_delete'])
        with self.assertRaises(j.JournalError): j.require_account_available('noon', self.flow.account_hash)

    def test_ack_without_empty_readback_stays_blocked(self):
        def unchanged(*a, **kw):
            result = self.request(*a, **kw)
            self.wire.responses['carts_recent'] = {'data': {'carts': [self.row]}}
            return result
        with self.assertRaises(cleanup.CleanupUnverified): self.clear(unchanged)
        with self.assertRaises(Exception): self.clear()
        with self.assertRaises(j.JournalError): j.require_account_available('noon', self.flow.account_hash)
        with j._db() as db:
            cleanup_id = db.execute("SELECT flow_id FROM operations WHERE name='cart_delete'").fetchone()[0]
        with self.assertRaisesRegex(j.JournalError, 'CLEAR_EMPTY_READBACK_REQUIRED'): j.abandon(cleanup_id)

    def test_missing_data_is_not_empty(self):
        def missing(*a, **kw):
            result = self.request(*a, **kw)
            return {'status': 'success'} if a[0] == 'cart_get' else result
        with self.assertRaises(cleanup.CleanupUnverified): self.clear(missing)

    def test_unknown_source_operation_refuses(self):
        with j._db() as db:
            db.execute("UPDATE observations SET outcome='UNKNOWN' WHERE flow_id=? AND operation='cart_create'",
                       (self.flow.flow_id,))
        with self.assertRaisesRegex(Exception, 'UNRESOLVED_CART_HISTORY'): self.clear()
        self.assertEqual(self.deletes, [])

    def test_missing_active_order_field_refuses_before_delete(self):
        self.wire.responses['home'] = {'data': {}}
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(self.deletes, [])

    def test_missing_active_order_field_after_delete_stays_blocked(self):
        def changed(*a, **kw):
            result = self.request(*a, **kw)
            self.wire.responses['home'] = {'data': {}}
            return result
        with self.assertRaises(cleanup.CleanupUnverified): self.clear(changed)
        with self.assertRaises(j.JournalError): j.require_account_available('noon', self.flow.account_hash)

    def test_final_reader_receives_retained_home(self):
        self.clear()
        self.assertEqual(reads.reader.call_args.kwargs['expected_address'], self.flow.address_hash)

    def test_cli_dispatch(self):
        import commerce_cli
        with patch.object(cleanup, 'clear_cart', return_value={'ok': True}) as clear:
            self.assertEqual(commerce_cli.main(['clear-cart', 'nownow', '--flow', self.flow.flow_id]), 0)
            clear.assert_called_once_with(self.flow.flow_id)

    def test_cli_unexpected_error_has_safe_cause(self):
        import commerce_cli
        import contextlib
        import io
        import json
        with patch.object(cleanup, 'clear_cart', side_effect=FileNotFoundError('private-secret-path')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(commerce_cli.main(['clear-cart', 'nownow', '--flow', self.flow.flow_id]), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result['cause'], 'FileNotFoundError')
        self.assertIn('location', result)
        self.assertNotIn('private-secret-path', output.getvalue())

    def test_preparation_retains_review_without_financial_send(self):
        from commerce_nownow_capture import load
        self.assertEqual(load(self.flow.flow_id)['review'], self.flow.review)

class FailedVerificationTests(CleanupTests):
    def setUp(self):
        super().setUp()
        from commerce_preorder import IntentVault
        from test.test_commerce_preorder import Store
        from noon_checkout import fingerprint
        with j._db() as db:
            db.execute("UPDATE flows SET state='ACTIVE' WHERE id=?", (self.flow.flow_id,))
        args = dict(request_hash='a'*64, cart_hash=self.flow.cart_hash,
                    review_hash=self.flow.review['digest'], payable_minor=self.flow.review['payable_minor'])
        j.consume(self.flow.flow_id, 'subscription', kind='preauthorize', **args)
        self.vault = IntentVault(Store())
        intent = self.vault.retain(self.flow.flow_id, secret='synthetic',
            review_hash=args['review_hash'], cart_hash=args['cart_hash'],
            card_hash=fingerprint(self.flow.card.token), payable_minor=args['payable_minor'])
        j.observe(self.flow.flow_id, 'subscription', outcome='PREORDER_INTENT_RECEIVED', evidence_hash=intent)
        j.consume(self.flow.flow_id, 'complete', kind='prepay', payment_intent_hash=intent, **args)
        j.observe(self.flow.flow_id, 'complete', outcome='CHALLENGE_REQUIRED', evidence_hash='b'*64)
        j.release_failed_preorder(self.flow.flow_id, evidence_hash='c'*64, intent_hash=intent)
        self.wire.responses['payment_status'] = dict(status='payment_failed', transaction_status='FAILED',
            error_code='19046', currency_code='AED', payment_method_code='cc_noonpay', is_cc_payment=True,
            customer_code='synthetic-account', id_token=self.flow.card.token, cc_masked='xxxx2342',
            authorized_amount=0, captured_amount=0, reversed_amount=0, refunded_amount=0, amount=1)

    def clear(self, request=None):
        return cleanup.clear_cart(self.flow.flow_id, auth=f.FakeAuth(), request=request or self.request,
                                  vault=self.vault)

    def test_changed_payment_status_refuses(self):
        self.wire.responses['payment_status']['captured_amount'] = 1
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(self.deletes, [])


class LegacyCleanupTests(CleanupTests):
    def setUp(self):
        super().setUp()
        (j.ROOT/'nownow'/(self.flow.flow_id+'.json')).unlink()
        with j._db() as db:
            db.execute('UPDATE flows SET created_at=created_at-90000 WHERE id=?', (self.flow.flow_id,))

    def test_preparation_retains_review_without_financial_send(self):
        from commerce_nownow_capture import load
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_RETAINED_REVIEW_MISSING'):
            load(self.flow.flow_id)

    def test_changed_session_cannot_be_adopted(self):
        self.row['checkoutSessionCode'] = 'different-session'
        with self.assertRaisesRegex(Exception, 'LEGACY_CART_EVIDENCE_MISMATCH'): self.clear()
        self.assertEqual(self.deletes, [])

    def test_changed_total_cannot_be_adopted(self):
        self.row['orderTotal'] = 999
        with self.assertRaisesRegex(Exception, 'LEGACY_CART_EVIDENCE_MISMATCH'): self.clear()
        self.assertEqual(self.deletes, [])

    def test_changed_manifest_cannot_be_adopted(self):
        self.row['products'][0]['qty'] = 2
        with self.assertRaisesRegex(Exception, 'LEGACY_SCOPE_CHANGED'): self.clear()
        self.assertEqual(self.deletes, [])

    def test_expired_multi_item_restores_original_input_order(self):
        self.check_expired_multi_item(None)

    def test_expired_multi_item_with_empty_string_notes(self):
        self.check_expired_multi_item('')

    def check_expired_multi_item(self, notes):
        from commerce_nownow_order import NowNowOrderFlow
        items = [{'product_code': f.PRODUCT, 'quantity': 1, 'notes': notes},
                 {'product_code': 'P0000000000000000A', 'quantity': 1, 'notes': notes}]
        responses = f.happy_responses()
        for name in ('cart_validate', 'payment', 'delivery_preference', 'instructions', 'cart_get'):
            products = responses[name]['data']['products']
            products[0]['price'] = 10.25
            products.append({**products[0], 'productCode': items[1]['product_code']})
        responses['product_edit'] = copy.deepcopy(responses['cart_validate'])
        self.wire = f.Harness(responses)
        self.flow = NowNowOrderFlow(store_code=f.STORE, items=items, auth=f.FakeAuth())
        self.flow.client._request = self.wire.request
        self.flow.prepare_only()
        (j.ROOT/'nownow'/(self.flow.flow_id+'.json')).unlink()
        with j._db() as db:
            db.execute('UPDATE flows SET created_at=created_at-90000 WHERE id=?', (self.flow.flow_id,))
        j.abandon(self.flow.flow_id)
        self.row = copy.deepcopy(self.wire.responses['cart_get']['data'])
        self.row['products'].reverse()
        self.wire.responses['carts_recent'] = {'data': {'carts': [self.row]}}
        self.client._request = self.wire.request
        self.assertTrue(self.clear()['cart_empty'])
        from commerce_nownow_capture import load
        self.assertEqual([i['product_code'] for i in load(self.flow.flow_id)['items']],
                         [i['product_code'] for i in items])
        self.assertEqual([i['notes'] for i in load(self.flow.flow_id)['items']], [notes, notes])

    def test_missing_receipt_cannot_be_adopted(self):
        with j._db() as db:
            db.execute("UPDATE observations SET evidence_hash=? WHERE flow_id=? AND operation LIKE 'cart_get_%'",
                       ('a'*64, self.flow.flow_id))
        with self.assertRaisesRegex(Exception, 'LEGACY_CART_EVIDENCE_MISMATCH'): self.clear()
        self.assertEqual(self.deletes, [])

    def test_financial_history_cannot_use_legacy_recovery(self):
        with j._db() as db:
            db.execute("UPDATE operations SET kind='prepay' WHERE flow_id=? AND name='payment'", (self.flow.flow_id,))
        with self.assertRaises(Exception): self.clear()
        self.assertEqual(self.deletes, [])
