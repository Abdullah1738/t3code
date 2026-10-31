"""Settle of interrupted Talabat mart cart flows with stable-cart adoption.

Covers commerce_talabat.settle_interrupted_cart end-to-end against the real
journal + receipts stores (tempfile roots): a prior released flow that owns the
account-stable cart id, an interrupted successor whose create_cart send hit the
wire but never persisted a receipt, adoption + settle, and a full resume to a
paid async order with exactly one placeOrder and one payment POST.
"""
import copy
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import commerce_journal as journal
import commerce_receipts as receipts
import talabat_http_checkout as h
from commerce_talabat import TalabatFlow, settle_interrupted_cart
from test.test_talabat_http_checkout import context

KEY = '0123456789abcdef'


class StubAuth:
    """Offline CommerceAuth surface: same saved account across flows."""

    def __init__(self, saved):
        self.saved = copy.deepcopy(saved)

    def fresh_before_mutation(self, app, vertical, timeout=25):
        return self

    def mutation_account(self, vertical, timeout=25):
        return copy.deepcopy(self.saved)


class SettleInterruptedCartTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # macOS /var is a system symlink; the store requires the exact real path.
        root = Path(self.temp.name).resolve() / 'commerce'
        for module in (journal, receipts):
            patcher = patch.object(module, 'ROOT', root)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.temp.cleanup)
        home, config, card, store, items, cart, parsed, quote = context('mart')
        event = config['paymentMethods'][0]['events']['payment']
        event.update(platformType='async', instrumentId='synthetic-private-instrument',
                     paymentStatusPullingInterval=[1.0] * 90)
        self.home, self.config, self.card = home, config, card
        self.store, self.items, self.cart, self.quote = store, items, cart, quote
        self.vendor = {'vendor': {'talabat_id': store.branch_id, 'is_dark_store': True,
                                  'is_migrated': False, 'vertical_type': 1,
                                  'global_id': 'synthetic-vendor', 'chain_id': 44}}
        self.saved = {'account_verified': True, 'country': 'AE', 'headers': {},
                      'auth': {'access_token': 'synthetic-secret', 'customerId': 77},
                      'expected_profile': {'id': 77, 'mobile_country_code': '971',
                                           'mobile_number': '500000000'}}
        self.auth = StubAuth(self.saved)
        from commerce_flow import account_hash
        self.account_hash = account_hash(self.saved)
        self.calls = []
        self.wire = patch.object(h, '_wire', side_effect=self._wire)
        self.wire.start()
        self.addCleanup(self.wire.stop)
        p = patch.object(h.auth, 'expiry', return_value=time.time() + 3600)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(h.orders, 'request', return_value=self.saved['expected_profile'])
        p.start()
        self.addCleanup(p.stop)

    def _wire(self, saved, deadline, method, path, **kwargs):
        self.calls.append((method, path))
        if path == '/api/v2/user/addresses':
            return h.WireResponse(200, {'has_error': False, 'result': [self.home]})
        if path == '/pay/v1/cards':
            return h.WireResponse(200, {'data': [self.card]})
        if path == '/pay/v2/payments':
            return h.WireResponse(200, self.config)
        if path.startswith('/grocery/v2/TB_AE/branches/'):
            return h.WireResponse(200, self.vendor)
        if path == '/grocery/v2/cart':
            if method == 'POST':
                return h.WireResponse(200, self.cart)
            if any(x == ('POST', '/grocery/v2/cart') for x in self.calls):
                return h.WireResponse(200, self.cart)
            return h.WireResponse(200, {'id': 'synthetic-new-empty', 'items': [],
                                        'subtotal_after_discount': 0})
        if path.startswith('/ccx/v1/checkout/'):
            if path.endswith('/placeOrder'):
                return h.WireResponse(200, {'placedOrder': {'orderId': '1234567890',
                    'transactionId': 'synthetic-transaction', 'balanceAmount': '35.00'}})
            return h.WireResponse(200, self.quote)
        if path == '/pay/v1/payments':
            return h.WireResponse(200, {'error': None, 'redirectUrl': None,
                                        'paymentId': 'synthetic-payment',
                                        'metadata': 'synthetic-metadata'})
        if path == '/pay/v2/payment/status':
            return h.WireResponse(200, {'status': 'success'})
        raise AssertionError('unrecognized wire path %s %s' % (method, path))

    def prior_released_flow(self):
        prior = TalabatFlow(vertical='mart', branch=self.store.branch_id, items=self.items,
                            auth=self.auth)
        review = prior.prepare(verticals_key=KEY)
        self.assertEqual(review['payable_minor'], 3500)
        journal.abandon(prior.flow_id)
        return prior

    def interrupted_successor(self):
        flow = str(uuid.uuid4())
        scope = journal.digest({'branch': self.store.branch_id, 'vertical': 'mart',
            'items': [(x.item_id, x.quantity) for x in self.items],
            'home': 'Banyantree2104', 'card': '2342', 'quiet': True, 'extras': False})
        binding = dict(flow_id=flow, app='talabat', vertical='mart',
                       account_hash=self.account_hash, scope_hash=scope)
        receipts.create(**binding)
        journal.open_flow(flow_id=flow, app='talabat', vertical='mart',
                          account_hash=self.account_hash, scope_hash=scope)
        journal.consume(flow, 'create_cart', kind='cart', request_hash='b' * 64)
        return flow

    def test_settle_interrupted_cart_adopts_stable_cart_and_resumes_to_paid(self):
        prior = self.prior_released_flow()
        flow = self.interrupted_successor()

        with self.assertRaisesRegex(journal.JournalError, 'SETTLE_INTENT_MISMATCH'):
            settle_interrupted_cart(flow, vertical='mart', branch=self.store.branch_id + 1,
                                    items=self.items, verticals_key=KEY, auth=self.auth)

        settled = settle_interrupted_cart(flow, vertical='mart', branch=self.store.branch_id,
                                          items=self.items, verticals_key=KEY, auth=self.auth)
        self.assertEqual(settled['state'], 'SETTLED')
        self.assertEqual(settled['adopted_from'], prior.flow_id)
        self.assertEqual(settled['cart_id'], 'synthetic-owned-cart')
        self.assertEqual(journal.cart_owner('talabat', self.account_hash,
                                           settled['cart_binding']), flow)

        resumed = TalabatFlow(vertical='mart', branch=self.store.branch_id, items=self.items,
                              flow_id=flow, auth=self.auth)
        review = resumed.resume_cart(verticals_key=KEY)
        self.assertEqual(review['payable_minor'], 3500)
        result = resumed.purchase()
        self.assertEqual(result['state'], 'PAYMENT_REPORTED_SUCCESS')
        self.assertEqual(len([x for x in self.calls if x[1].endswith('/placeOrder')]), 1)
        self.assertEqual(len([x for x in self.calls if x[1] == '/pay/v1/payments']), 1)
        state = journal.inspect(flow)
        self.assertEqual(state['state'], 'ACTIVE')
        self.assertEqual(state['order_id'], '1234567890')


    def refused_prior_flow(self):
        """Prior flow whose place POST was refused orderless (the live 400 shape):
        quotes + create_cart via prepare(), then a journal-level refused place,
        fenced, then the orderless release. Cart id stays 'synthetic-owned-cart'."""
        prior = TalabatFlow(vertical='mart', branch=self.store.branch_id, items=self.items,
                            auth=self.auth)
        review = prior.prepare(verticals_key=KEY)
        self.assertEqual(review['payable_minor'], 3500)
        binding = __import__('hashlib').sha256(b'synthetic-owned-cart').hexdigest()
        journal.consume(prior.flow_id, 'place', kind='place', request_hash='c' * 64,
                        cart_hash=binding, review_hash='d' * 64, payable_minor=3500)
        journal.observe(prior.flow_id, 'place', outcome='UNKNOWN', evidence_hash='f' * 64)
        self.assertEqual(journal.inspect(prior.flow_id)['state'], 'FENCED')
        journal.release_orderless(prior.flow_id, evidence_hash='1' * 64)
        self.assertEqual(journal.inspect(prior.flow_id)['state'], 'RELEASED')
        return prior

    def test_auto_adoption_from_orderless_refused_prior(self):
        prior = self.refused_prior_flow()
        # Live shape: the stable cart is emptied (POST items:[]) before a fresh
        # successor flow starts; the successor's create_cart then re-POSTs the
        # same account-stable cart id and adopts it at receipt time.
        self.calls.clear()
        successor = TalabatFlow(vertical='mart', branch=self.store.branch_id, items=self.items,
                                auth=self.auth)
        review = successor.prepare(verticals_key=KEY)
        self.assertEqual(review['payable_minor'], 3500)
        binding = __import__('hashlib').sha256(b'synthetic-owned-cart').hexdigest()
        self.assertEqual(journal.cart_owner('talabat', self.account_hash, binding),
                         successor.flow_id)
        result = successor.purchase()
        self.assertEqual(result['state'], 'PAYMENT_REPORTED_SUCCESS')
        self.assertEqual(len([x for x in self.calls if x[1].endswith('/placeOrder')]), 1)
        self.assertEqual(len([x for x in self.calls if x[1] == '/pay/v1/payments']), 1)
        state = journal.inspect(successor.flow_id)
        self.assertEqual(state['order_id'], '1234567890')

    def test_parse_cart_flags_below_minimum(self):
        below = copy.deepcopy(self.cart)
        below['campaign_progress'] = {'permanent': {'view_state': 'below_threshold'}}
        self.assertTrue(h.parse_cart(below, self.store, self.items).below_minimum)
        self.assertFalse(h.parse_cart(self.cart, self.store, self.items).below_minimum)

    def test_prepare_fails_fast_on_below_minimum_cart(self):
        self.cart = copy.deepcopy(self.cart)
        self.cart['campaign_progress'] = {'permanent': {'view_state': 'below_threshold'}}
        flow = TalabatFlow(vertical='mart', branch=self.store.branch_id, items=self.items,
                           auth=self.auth)
        with self.assertRaisesRegex(journal.JournalError, 'CART_BELOW_MINIMUM'):
            flow.prepare(verticals_key=KEY)

if __name__ == '__main__':
    unittest.main()