"""Focused multi-item basket tests for the four noon lanes (synthetic only).

Covers the items= constructors, pre-auth validation codes, per-item add
operations with digest-suffixed journal names, aggregate multi-shipment
review, prepare_only() (fresh + resumed, no financial send) and resume with
items=. Single-item behaviour stays covered by the per-lane test modules.
"""
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import commerce_journal as j
import commerce_minutes as cmin
import commerce_main_order as cmain
import commerce_supermall_order as csup
import commerce_nownow_order as cnow

from test.test_commerce_main_order import (
    FakeAuth as MainAuth, Harness as MainHarness, patched_resolve as main_resolve,
    cart_state as main_cart, session_state as main_session, FIXTURE as MAIN_FIXTURE,
    SKU as MAIN_SKU, OFFER as MAIN_OFFER, ORDER as MAIN_ORDER)
from test.test_commerce_supermall_order import (
    FakeAuth as SuperAuth, Harness as SuperHarness, patched_resolve as super_resolve,
    cart_state as super_cart, session_state as super_session, FIXTURE as SUPER_FIXTURE,
    SKU as SUPER_SKU, OFFER as SUPER_OFFER, ORDER as SUPER_ORDER)
from test.test_commerce_nownow_order import (
    FakeAuth as NowAuth, Harness as NowHarness, nn_state, place_state,
    happy_responses as now_happy, STORE, PRODUCT, SYNTHETIC_ORDER)
from test.test_noon_minutes_checkout import (
    Harness as MinHarness, HEADERS as MIN_HEADERS, fixture as min_fixture)
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint


def rooted(temp):
    return Path(temp).resolve() / 'commerce'


class MinutesMultiBasketTests(unittest.TestCase):
    """items= alias, conflict detection, multi-line prepare_only with real
    quiet codes, merchant qtyMax enforcement and consumed-skip re-prepare."""

    def setUp(self):
        p=patch.object(cmin.options,'read_options',return_value={'groups':[]})
        p.start();self.addCleanup(p.stop)

    def make_auth(self):
        class Auth:
            def _snap(self):
                return AuthSnapshot('minutes', fingerprint('account'),
                                    fingerprint(MIN_HEADERS['x-addresscode'],
                                                MIN_HEADERS['x-addresskey']),
                                    time.time(), dict(MIN_HEADERS), time.monotonic() + 30)
            def fresh_before_mutation(self, *a, **k):
                return self._snap()
            def status(self, *a):
                return {'maintenance_state': 'none'}
            def retain_response_cookies(self, *a, **k):
                return True
        return Auth()

    def multi_wire(self, *, quiet=True, bar_qty=3, bar_qty_max=10):
        data = min_fixture()
        shake = data['items'][0]
        shake['qty'] = 2
        bar = {'sku': 'SYNTHETIC_BAR', 'qty': bar_qty, 'title': 'White choc bar',
               'price': 6.0, 'offerPrice': 6.0, 'qtyMax': bar_qty_max,
               'selectedModifiers': {}, 'isFreebie': False, 'itemCode': 'SYNTHETIC_BAR'}
        data['items'] = [shake, bar]
        data['deliveryPreferences'] = [
            {'code': 'dont_ring_the_bell', 'value': quiet, 'title': 'Do not ring bell'},
            {'code': 'leave_it_at_my_door', 'value': quiet, 'title': 'Leave at door'}]
        subtotal = 12.5 * 2 + 6.0 * bar_qty
        total = subtotal + 8.0
        data.update({'orderSubtotal': subtotal, 'orderTotal': total,
                     'orderPaymentAmount': total,
                     'orderDeliveryFee': 8.0, 'orderServiceFee': 0.0,
                     'orderSmallOrderFee': 0.0, 'orderGiftBagFee': 0.0,
                     'orderPaymentFee': 0.0, 'orderCodFee': 0.0,
                     'orderBulkyOrderFee': 0.0, 'orderConvenienceFee': 0.0,
                     'orderLateNightFee': 0.0})
        data['orderSummary'] = [
            {'entries': [{'title': 'Subtotal', 'value': f'AED {subtotal:.2f}'},
                         {'title': 'Delivery fee', 'value': 'AED 8.00'}]},
            {'entries': [{'title': 'Total', 'value': f'<b>AED {total:.2f}</b>'}]}]
        return data

    def empty_wire(self):
        data = self.multi_wire()
        data['items'] = []
        data.update({'orderSubtotal': 0, 'orderTotal': 0, 'orderPaymentAmount': 0,
                     'orderDeliveryFee': 0.0})
        return data

    def card_wire(self):
        return {'data': [{'id': 'synthetic-payment-token', 'ccMasked': 'xxxx 2342',
                          'ccType': 'mastercard', 'isDefault': True, 'isDeleted': False}]}

    def test_items_alias_matches_skus_scope(self):
        rows = [{'sku': 'SYNTHETIC_SHAKE', 'qty': 2}, {'sku': 'SYNTHETIC_BAR', 'qty': 3}]
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmin.receipts, 'ROOT', rooted(temp)):
            fa = cmin.MinutesFlow(skus=rows, auth=self.make_auth())
            fb = cmin.MinutesFlow(items=rows, auth=self.make_auth())
        self.assertEqual(fa.skus, fb.skus)
        self.assertEqual(fa.scope_hash, fb.scope_hash)

    def test_items_and_skus_conflict_fails_before_auth(self):
        with self.assertRaisesRegex(j.JournalError, 'MINUTES_ITEMS_CONFLICT'):
            cmin.MinutesFlow(skus=[{'sku': 'S', 'qty': 1}],
                             items=[{'sku': 'S', 'qty': 1}], auth=None)

    def test_multi_prepare_only_and_reprepare_skips_consumed(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmin.receipts, 'ROOT', rooted(temp)):
            harness = MinHarness([
                self.empty_wire(),          # session_get
                self.multi_wire(quiet=False),  # sync readback (codes present, unset)
                self.multi_wire(quiet=True),   # instructions readback
                self.multi_wire(quiet=True),   # final independent session read
                self.card_wire(),              # approve payment_cards
                self.multi_wire(quiet=True),   # repeated preparation re-reads
                self.card_wire(),              # second prepare_only approve read
            ])
            flow = cmin.MinutesFlow(
                items=[{'sku': 'SYNTHETIC_SHAKE', 'qty': 2},
                       {'sku': 'SYNTHETIC_BAR', 'qty': 3}],
                auth=self.make_auth())
            flow.client._request = harness.request
            prepared = flow.prepare_only()
            self.assertTrue(prepared['prepared_only'])
            self.assertEqual([x[0] for x in harness.calls],
                              ['session_get', 'sync', 'instructions', 'session_get', 'payment_cards'])
            self.assertEqual(prepared['review']['payable_minor'], 5100)
            self.assertEqual(len(prepared['readback']['lines']), 2)
            state = j.inspect(flow.flow_id)
            self.assertEqual(state['state'], 'ACTIVE')
            names = {x['name'] for x in state['operations']}
            self.assertTrue({'session_get', 'sync', 'instructions'} <= names)
            self.assertEqual(len([name for name in names if name.startswith('session_readback_')]), 1)
            self.assertNotIn('place', [x[0] for x in harness.calls])
            # Re-prepare: only fresh session/card reads, no sync or instructions replay.
            again = flow.prepare_only()
            self.assertEqual([x[0] for x in harness.calls][-1], 'payment_cards')
            self.assertEqual([x[0] for x in harness.calls].count('sync'), 1)
            self.assertEqual([x[0] for x in harness.calls].count('session_get'), 3)
            self.assertEqual(again['review']['payable_minor'], 5100)
            self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')

    def test_merchant_qty_max_enforced_in_review(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmin.receipts, 'ROOT', rooted(temp)):
            harness = MinHarness([
                self.empty_wire(),
                self.multi_wire(quiet=False, bar_qty=3, bar_qty_max=2),
                self.multi_wire(quiet=True, bar_qty=3, bar_qty_max=2),
                self.multi_wire(quiet=True, bar_qty=3, bar_qty_max=2),
                self.card_wire(),
            ])
            flow = cmin.MinutesFlow(
                items=[{'sku': 'SYNTHETIC_SHAKE', 'qty': 2},
                       {'sku': 'SYNTHETIC_BAR', 'qty': 3}],
                auth=self.make_auth())
            flow.client._request = harness.request
            with self.assertRaisesRegex(cmin.m.MinutesError, 'MERCHANT_QTY_MAX_EXCEEDED'):
                flow.prepare_only()
            self.assertNotIn('place', [x[0] for x in harness.calls])

    def test_final_readback_changed_basket_blocks_preparation(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmin.receipts, 'ROOT', rooted(temp)):
            harness = MinHarness([
                self.empty_wire(), self.multi_wire(quiet=False),
                self.multi_wire(), self.multi_wire(bar_qty=4), self.card_wire()])
            flow = cmin.MinutesFlow(
                items=[{'sku': 'SYNTHETIC_SHAKE', 'qty': 2},
                       {'sku': 'SYNTHETIC_BAR', 'qty': 3}], auth=self.make_auth())
            flow.client._request = harness.request
            with self.assertRaisesRegex(cmin.m.MinutesError, 'MANIFEST_MISMATCH'):
                flow.prepare_only()
            self.assertNotIn('place', [x[0] for x in harness.calls])
            self.assertIsNone(flow.review)

    def test_changed_pre_place_snapshot_cannot_be_paid(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmin.receipts, 'ROOT', rooted(temp)):
            harness = MinHarness([
                self.empty_wire(), self.multi_wire(quiet=False), self.multi_wire(),
                self.multi_wire(), self.card_wire(),
                self.multi_wire(bar_qty=4), self.card_wire()])
            flow = cmin.MinutesFlow(
                items=[{'sku': 'SYNTHETIC_SHAKE', 'qty': 2},
                       {'sku': 'SYNTHETIC_BAR', 'qty': 3}], auth=self.make_auth())
            flow.client._request = harness.request
            flow.prepare_only()
            with self.assertRaisesRegex(cmin.m.MinutesError, 'MANIFEST_MISMATCH'):
                flow.place()
            self.assertNotIn('place', [x[0] for x in harness.calls])
            self.assertFalse(any(x['kind'] in ('place', 'payment')
                                 for x in j.inspect(flow.flow_id)['operations']))


class NowNowMultiBasketTests(unittest.TestCase):
    """items= form, pre-auth validation, two-product single-session lane with
    one edit per extra line, and multi prepare_only without a place send."""

    PRODUCT2 = 'P4372707388695472B'

    def multi_nn(self, **kw):
        base = nn_state(**kw)
        data = base['data']
        subtotal = kw.pop('subtotal', 2050 + 3000)
        delivery = kw.pop('delivery', 645)
        service = kw.pop('service_fee', 450)
        total = subtotal + delivery + service

        def aed(minor):
            return round(minor / 100, 2)
        data['products'] = [
            {'productCode': PRODUCT, 'qty': 1.0, 'price': 20.50,
             'name': 'Grenade Protein Shake, White Chocolate', 'maxQty': None,
             'productTypeCode': 'non_weighable', 'modifiers': []},
            {'productCode': self.PRODUCT2, 'qty': 2.0, 'price': 15.00,
             'name': 'Grenade Protein Bar', 'maxQty': None,
             'productTypeCode': 'non_weighable', 'modifiers': []}]
        data.update({'orderSubtotal': aed(subtotal), 'orderSubtotalDiscounted': aed(subtotal),
                     'orderDeliveryFee': aed(delivery), 'orderServiceFee': aed(service),
                     'orderTotal': aed(total), 'orderPaymentAmount': aed(total),
                     'totalQuantity': 3})
        return base

    def multi_place(self):
        state = place_state()
        order = state['data']['order']
        order.update({'orderSubtotal': 50.5, 'orderTotal': 61.45,
                      'orderPaymentAmount': 61.45,
                      'products': [{'productCode': PRODUCT, 'qty': 1.0},
                                   {'productCode': self.PRODUCT2, 'qty': 2.0}]})
        return state

    def multi_responses(self):
        responses = dict(now_happy(
            cart_create=nn_state(),
            cart_validate=self.multi_nn(),
            payment=self.multi_nn(payment=True),
            delivery_preference=self.multi_nn(payment=True, quiet=True),
            instructions=self.multi_nn(payment=True, quiet=True),
            cart_get=self.multi_nn(payment=True, quiet=True),
            place=self.multi_place()))
        responses['product_edit'] = self.multi_nn()
        return responses

    def test_validation_codes_fail_before_auth(self):
        cases = [
            ({'items': [{'product_code': PRODUCT, 'quantity': 1}],
              'product_code': PRODUCT, 'quantity': 1}, 'NOWNOW_ITEMS_CONFLICT'),
            ({'items': [{'product_code': PRODUCT, 'quantity': 1},
                        {'product_code': PRODUCT, 'quantity': 2}]}, 'NOWNOW_DUPLICATE_PRODUCT'),
            ({'items': [{'product_code': PRODUCT, 'quantity': 0}]}, 'NOWNOW_QUANTITY_INVALID'),
            ({'items': [{'product_code': PRODUCT, 'quantity': 1, 'rogue': 1}]},
             'NOWNOW_ITEM_ROW_INVALID'),
            ({'items': []}, 'NOWNOW_ITEMS_REQUIRED'),
        ]
        for kwargs, code in cases:
            with self.assertRaisesRegex(j.JournalError, code):
                cnow.NowNowOrderFlow(store_code=STORE, auth=None, request=None, **kwargs)

    def test_multi_items_lane_single_place_send(self):
        responses = self.multi_responses()
        harness = NowHarness(responses)
        flow = cnow.NowNowOrderFlow(store_code=STORE,
                                    items=[{'product_code': PRODUCT, 'quantity': 1},
                                           {'product_code': self.PRODUCT2, 'quantity': 2}],
                                    auth=NowAuth())
        flow.client._request = harness.request
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cnow.receipts, 'ROOT', rooted(temp)):
            flow.guard()
            flow.create_session()
            flow.apply_items()
            flow.validate()
            flow.guard_validated()
            flow.select_saved_card()
            flow.quiet_delivery()
            flow.pre_place_read()
            review = flow.review_final()
            placed = flow.place()
            tracking = flow.poll_tracking(sleep=lambda _: None)
            paid = flow.confirm_paid(tracking)
        self.assertTrue(paid['paid'])
        edits = [p for op, p in harness.calls if op == 'product_edit']
        self.assertEqual(edits, [{'sessionCode': 'S-SESSION-1',
                                  'productCode': self.PRODUCT2, 'qty': 2,
                                  'notes': None, 'modifiers': {}}])
        self.assertEqual(review['total_minor'], 6145)
        self.assertEqual(review['products'], [[PRODUCT, 1], [self.PRODUCT2, 2]])
        place_bodies = [p for op, p in harness.calls if op == 'place']
        self.assertEqual(len(place_bodies), 1)
        self.assertEqual(place_bodies[0], {'sessionCode': 'S-SESSION-1', 'total': 61.45})
        self.assertEqual(placed['order'], SYNTHETIC_ORDER)

    def test_multi_prepare_only_stops_before_place(self):
        responses = self.multi_responses()
        del responses['place']
        del responses['track']
        harness = NowHarness(responses)
        flow = cnow.NowNowOrderFlow(store_code=STORE,
                                    items=[{'product_code': PRODUCT, 'quantity': 1},
                                           {'product_code': self.PRODUCT2, 'quantity': 2}],
                                    auth=NowAuth())
        flow.client._request = harness.request
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cnow.receipts, 'ROOT', rooted(temp)):
            prepared = flow.prepare_only()
            state = j.inspect(flow.flow_id)
            self.assertEqual(state['state'], 'ACTIVE')
            self.assertFalse(any(x['kind'] == 'place' for x in state['operations']))
        self.assertTrue(prepared['prepared_only'])
        self.assertEqual([x[0] for x in harness.calls],
                         ['home', 'payment_cards', 'payment_subscription_list',
                          'carts_recent', 'cart_create', 'product_edit', 'cart_validate',
                           'payment', 'delivery_preference', 'instructions', 'cart_get'])
        self.assertEqual(prepared['readback']['product_count'], 2)
        self.assertEqual(prepared['review']['total_minor'], 6145)

    def test_multi_resume_adopts_cart_without_resending(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cnow.receipts, 'ROOT', rooted(temp)):
            first_harness = NowHarness(self.multi_responses())
            first = cnow.NowNowOrderFlow(store_code=STORE,
                                         items=[{'product_code': PRODUCT, 'quantity': 1},
                                                {'product_code': self.PRODUCT2, 'quantity': 2}],
                                         auth=NowAuth())
            first.client._request = first_harness.request
            first.guard()
            first.create_session()
            first.apply_items()
            first.validate()
            first.guard_validated()
            first.select_saved_card()
            first.quiet_delivery()
            responses = self.multi_responses()
            del responses['cart_create']
            del responses['payment']
            del responses['delivery_preference']
            del responses['product_edit']
            harness = NowHarness(responses)
            resumed = cnow.NowNowOrderFlow.resume_active(
                first.flow_id, store_code=STORE,
                items=[{'product_code': PRODUCT, 'quantity': 1},
                       {'product_code': self.PRODUCT2, 'quantity': 2}],
                auth=NowAuth(), request=harness.request)
            names = [x[0] for x in harness.calls]
            self.assertIn('cart_get', names)
            self.assertIn('payment_cards', names)
            for consumed_op in ('cart_create', 'payment', 'delivery_preference',
                                'product_edit'):
                self.assertNotIn(consumed_op, names)
            prepared = resumed.prepare_only()
            self.assertTrue(prepared['prepared_only'])
            self.assertEqual(prepared['review']['total_minor'], 6145)
            self.assertNotIn('place', [x[0] for x in harness.calls])


MAIN_SKU2 = 'Z0B9474A290818B862Z'
MAIN_OFFER2 = 'b42fa0b0583a448f'


def main_multi_search():
    case = copy.deepcopy(MAIN_FIXTURE['search'])
    case['hits'].append({'brand': 'Quest', 'is_buyable': True,
                         'name': 'Quest Bar Chocolate Chip 60g',
                         'offer_code': MAIN_OFFER2, 'price': 29.0, 'sale_price': 25.0,
                         'sku': MAIN_SKU2, 'sku_config': MAIN_SKU2,
                         'stock_minimum_quantity': 1})
    return case


def main_multi_cart():
    def row(offer, sku, quantity):
        return {'offerCode': offer, 'skuConfig': sku, 'quantity': quantity,
                'quantityMin': quantity, 'quantityMax': 10, 'variantKey': '',
                'isSelectedForCheckout': True}
    return {'apiVersion': 2, 'version': 3, 'count': 3,
            'offers': [row(MAIN_OFFER, MAIN_SKU, 2), row(MAIN_OFFER2, MAIN_SKU2, 1)],
            'items': [row(MAIN_OFFER, MAIN_SKU, 2), row(MAIN_OFFER2, MAIN_SKU2, 1)]}


def main_multi_session(**kw):
    base = main_session(total=44.8, quantity=2, **kw)
    base['subtotal'] = 44.8
    base['shipments'] = [
        {'id': MAIN_OFFER + '-0', 'items': [
            {'offerCode': MAIN_OFFER, 'skuConfig': MAIN_SKU, 'quantity': 2,
             'unitPrice': '9.90', 'brand': 'Maxi Nutrition'}],
         'promises': [{'isSelected': True, 'message': 'Get it Tomorrow'}]},
        {'id': MAIN_OFFER2 + '-0', 'items': [
            {'offerCode': MAIN_OFFER2, 'skuConfig': MAIN_SKU2, 'quantity': 1,
             'unitPrice': '25.00', 'brand': 'Quest'}],
         'promises': [{'isSelected': True, 'message': 'Get it Day After'}]}]
    return base


def main_multi_status():
    status = copy.deepcopy(MAIN_FIXTURE['status_success'])
    status['shipments'] = [
        {'items': [{'quantity': 2, 'skuConfig': MAIN_SKU, 'unitPrice': '9.90'}],
         'promises': [{'isSelected': True}]},
        {'items': [{'quantity': 1, 'skuConfig': MAIN_SKU2, 'unitPrice': '25.00'}],
         'promises': [{'isSelected': True}]}]
    status['total'] = '44.80'
    return status


MAIN_ITEMS = [{'sku_config': MAIN_SKU, 'quantity': 2},
              {'sku_config': MAIN_SKU2, 'quantity': 1}]


class MainMultiBasketTests(unittest.TestCase):

    def make_flow(self, responses):
        harness = MainHarness(responses)
        flow = cmain.MainOrderFlow(items=MAIN_ITEMS, auth=MainAuth(),
                                   request=harness.request)
        return flow, harness

    def test_validation_codes_fail_before_auth(self):
        cases = [
            ({'sku_config': MAIN_SKU, 'quantity': 2,
              'items': [{'sku_config': MAIN_SKU, 'quantity': 1}]},
             'MAIN_ITEMS_CONFLICT'),
            ({'items': [{'sku_config': MAIN_SKU, 'quantity': 2},
                        {'sku_config': MAIN_SKU, 'quantity': 1}]},
             'MAIN_DUPLICATE_SKU_CONFIG'),
            ({'items': [{'sku_config': MAIN_SKU, 'quantity': 0}]},
             'MAIN_QUANTITY_INVALID'),
            ({'items': []}, 'MAIN_ITEMS_REQUIRED'),
        ]
        for kwargs, code in cases:
            with self.assertRaisesRegex(j.JournalError, code):
                cmain.MainOrderFlow(auth=None, request=None, **kwargs)

    def test_full_multi_lane_aggregates_shipments(self):
        responses = {'cart': [main_cart(empty=True), main_multi_cart()],
                     'add': [MAIN_FIXTURE['add_resp'], MAIN_FIXTURE['add_resp']],
                     'session': main_multi_session(),
                     'place': MAIN_ORDER,
                     'order_status': main_multi_status()}
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmain.receipts, 'ROOT', rooted(temp)):
            flow, harness = self.make_flow(responses)
            with patch.object(cmain.urllib.request, 'build_opener',
                              return_value=main_resolve(main_multi_search())()), \
                    patch.object(cmain, 'active_marketplace_orders', return_value=[]):
                guard = flow.guard()
                self.assertEqual(len(guard['items']), 2)
                flow.add()
                flow.checkout_session()
                review = flow.review_session()
                placed = flow.place()
                paid = flow.await_success(sleep=lambda _: None)
                flow.confirm_paid()
            self.assertTrue(paid['paid'])
            self.assertEqual([name for name, _, _ in harness.calls],
                             ['cart', 'add', 'add', 'cart', 'session', 'place',
                              'order_status'])
            add_bodies = [body for name, _, body in harness.calls if name == 'add']
            self.assertEqual(len(add_bodies), 2)
            place_body = next(body for name, _, body in harness.calls if name == 'place')
            self.assertEqual(place_body, {'total': 44.8})
            self.assertEqual(review['items'], [[MAIN_SKU, 2], [MAIN_SKU2, 1]])
            self.assertEqual(review['subtotal_minor'], 4480)
            self.assertEqual(review['fees_minor'], 0)
            self.assertEqual(review['total_minor'], 4480)
            self.assertEqual(review['shipments'], 2)
            self.assertEqual(flow.review['payable_minor'], 4480)
            self.assertEqual(placed['order'], MAIN_ORDER)

    def test_multi_prepare_only_then_resume_regets_basket(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(cmain.receipts, 'ROOT', rooted(temp)):
            responses = {'cart': [main_cart(empty=True), main_multi_cart(),
                                  main_multi_cart()],
                         'add': [MAIN_FIXTURE['add_resp'], MAIN_FIXTURE['add_resp']],
                         'session': main_multi_session()}
            flow, harness = self.make_flow(responses)
            with patch.object(cmain.urllib.request, 'build_opener',
                              return_value=main_resolve(main_multi_search())()), \
                    patch.object(cmain, 'active_marketplace_orders', return_value=[]):
                prepared = flow.prepare_only()
            self.assertTrue(prepared['prepared_only'])
            names = [name for name, _, _ in harness.calls]
            self.assertEqual(names, ['cart', 'add', 'add', 'cart', 'cart', 'session'])
            adds = [x['name'] for x in j.inspect(flow.flow_id)['operations']
                    if x['name'].startswith('add_')]
            self.assertEqual(len(adds), 2)
            self.assertEqual(prepared['review']['total_minor'], 4480)
            self.assertEqual(len(prepared['readback']['items']), 2)
            self.assertFalse(any(x['kind'] == 'place'
                                 for x in j.inspect(flow.flow_id)['operations']))
            # Resume with the same items: no re-adds, fresh re-GET, re-frozen review.
            # Resume adoption + prepare_only adopt + fresh re-GET = 3 cart reads.
            responses2 = {'cart': [main_multi_cart(), main_multi_cart(),
                                   main_multi_cart()],
                          'session': main_multi_session()}
            harness2 = MainHarness(responses2)
            with patch.object(cmain.urllib.request, 'build_opener',
                              return_value=main_resolve(main_multi_search())()), \
                    patch.object(cmain, 'active_marketplace_orders', return_value=[]):
                resumed = cmain.MainOrderFlow.resume_active(
                    flow.flow_id, items=MAIN_ITEMS, auth=MainAuth(),
                    request=harness2.request)
                prepared2 = resumed.prepare_only()
            names2 = [name for name, _, _ in harness2.calls]
            self.assertNotIn('add', names2)
            self.assertEqual(names2, ['cart', 'cart', 'cart', 'session'])
            self.assertEqual(prepared2['review']['total_minor'], 4480)


SUPER_SKU2 = 'ZC3D2FE430033CA47B9Z'
SUPER_OFFER2 = 'bbb9dcee08bdd46c'


def super_multi_search():
    case = copy.deepcopy(SUPER_FIXTURE['search'])
    second = copy.deepcopy(case['hits'][0])
    second.update({'name': 'Quest Bar Chocolate Chip 60g x2',
                   'offer_code': SUPER_OFFER2, 'price': 30.0, 'sale_price': 24.0,
                   'sku': SUPER_SKU2, 'sku_config': SUPER_SKU2,
                   'stock_minimum_quantity': 1})
    second['rocket'].update({'offer_code': SUPER_OFFER2, 'price': 30.0,
                             'sale_price': 24.0, 'sku_config': SUPER_SKU2})
    case['hits'].append(second)
    return case


def super_multi_cart():
    def row(offer, sku, quantity):
        return {'offerCode': offer, 'skuConfig': sku, 'quantity': quantity,
                'quantityMin': quantity, 'quantityMax': 3, 'variantKey': '',
                'isSelectedForCheckout': True}
    return {'apiVersion': 2, 'version': 3, 'count': 3,
            'offers': [row(SUPER_OFFER, SUPER_SKU, 1), row(SUPER_OFFER2, SUPER_SKU2, 2)],
            'items': [row(SUPER_OFFER, SUPER_SKU, 1), row(SUPER_OFFER2, SUPER_SKU2, 2)]}


def super_multi_session(**kw):
    base = super_session(total=49.49, subtotal=41.0, **kw)
    promises_late = [{'isSelected': True, 'message': '<normal>Get in <b>2 hr</b></normal>',
                      'deliveryDate': '2026-10-11T02:15:00',
                      'analytics': {'tag': 'rocket'}},
                     {'isSelected': False, 'message': 'Get it tomorrow',
                      'deliveryDate': '2026-10-11T18:00:00', 'analytics': {'tag': 'ndd'}}]
    base['shipments'] = [
        {'id': SUPER_OFFER + '-0', 'isRocket': True, 'isSlotBased': False,
         'items': [{'offerCode': SUPER_OFFER, 'skuConfig': SUPER_SKU, 'quantity': 1,
                    'unitPrice': '17.00', 'brand': 'Quest', 'flags': ['rocket']}],
         'promises': super_session()['shipments'][0]['promises']},
        {'id': SUPER_OFFER2 + '-0', 'isRocket': True, 'isSlotBased': False,
         'items': [{'offerCode': SUPER_OFFER2, 'skuConfig': SUPER_SKU2, 'quantity': 2,
                    'unitPrice': '12.00', 'brand': 'Quest', 'flags': ['rocket']}],
         'promises': promises_late}]
    return base


def super_multi_status():
    status = copy.deepcopy(SUPER_FIXTURE['status_success'])
    status['shipments'] = [
        {'items': [{'quantity': 1, 'skuConfig': SUPER_SKU, 'unitPrice': '17.00'}],
         'promises': [{'isSelected': True, 'message': 'x'}]},
        {'items': [{'quantity': 2, 'skuConfig': SUPER_SKU2, 'unitPrice': '12.00'}],
         'promises': [{'isSelected': True, 'message': 'y'}]}]
    status['total'] = '49.49'
    return status


SUPER_ITEMS = [{'sku_config': SUPER_SKU, 'quantity': 1},
               {'sku_config': SUPER_SKU2, 'quantity': 2}]


class SupermallMultiBasketTests(unittest.TestCase):

    def make_flow(self, responses):
        harness = SuperHarness(responses)
        flow = csup.SupermallOrderFlow(items=SUPER_ITEMS, auth=SuperAuth(),
                                       request=harness.request)
        return flow, harness

    def test_validation_codes_fail_before_auth(self):
        cases = [
            ({'sku_config': SUPER_SKU, 'quantity': 1,
              'items': [{'sku_config': SUPER_SKU, 'quantity': 1}]},
             'SUPERMALL_ITEMS_CONFLICT'),
            ({'items': [{'sku_config': SUPER_SKU, 'quantity': 1},
                        {'sku_config': SUPER_SKU, 'quantity': 2}]},
             'SUPERMALL_DUPLICATE_SKU_CONFIG'),
            ({'items': [{'sku_config': SUPER_SKU, 'quantity': 0}]},
             'SUPERMALL_QUANTITY_INVALID'),
        ]
        for kwargs, code in cases:
            with self.assertRaisesRegex(j.JournalError, code):
                csup.SupermallOrderFlow(auth=None, request=None, **kwargs)

    def test_full_multi_lane_eta_is_max_promise(self):
        responses = {'cart': [super_cart(empty=True), super_multi_cart()],
                     'add_rocket': [SUPER_FIXTURE['add_resp'], SUPER_FIXTURE['add_resp']],
                     'session': super_multi_session(),
                     'place': SUPER_ORDER,
                     'order_status': super_multi_status()}
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(csup.receipts, 'ROOT', rooted(temp)):
            flow, harness = self.make_flow(responses)
            with patch.object(csup.urllib.request, 'build_opener',
                              return_value=super_resolve(super_multi_search())()), \
                    patch.object(csup, 'active_marketplace_orders', return_value=[]):
                guard = flow.guard()
                self.assertEqual(len(guard['items']), 2)
                flow.add()
                flow.checkout_session()
                review = flow.review_session()
                placed = flow.place()
                paid = flow.await_success(sleep=lambda _: None)
                flow.confirm_paid()
            self.assertTrue(paid['paid'])
            self.assertEqual([name for name, _, _ in harness.calls],
                             ['cart', 'add_rocket', 'add_rocket', 'cart', 'session',
                              'place', 'order_status'])
            place_body = next(body for name, _, body in harness.calls if name == 'place')
            self.assertEqual(place_body, {'total': 49.49})
            self.assertEqual(review['items'], [[SUPER_SKU, 1], [SUPER_SKU2, 2]])
            self.assertEqual(review['subtotal_minor'], 4100)
            self.assertEqual(review['fees_minor'], 849)
            self.assertEqual(review['total_minor'], 4949)
            self.assertEqual(review['shipments'], 2)
            self.assertEqual(review['eta'], '2026-10-11T02:15:00+04:00')
            self.assertEqual(flow.review['payable_minor'], 4949)
            self.assertEqual(placed['order'], SUPER_ORDER)

    def test_multi_prepare_only_and_resume(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', rooted(temp)), \
                patch.object(csup.receipts, 'ROOT', rooted(temp)):
            responses = {'cart': [super_cart(empty=True), super_multi_cart(),
                                  super_multi_cart()],
                         'add_rocket': [SUPER_FIXTURE['add_resp'],
                                        SUPER_FIXTURE['add_resp']],
                         'session': super_multi_session()}
            flow, harness = self.make_flow(responses)
            with patch.object(csup.urllib.request, 'build_opener',
                              return_value=super_resolve(super_multi_search())()), \
                    patch.object(csup, 'active_marketplace_orders', return_value=[]):
                prepared = flow.prepare_only()
            names = [name for name, _, _ in harness.calls]
            self.assertEqual(names,
                             ['cart', 'add_rocket', 'add_rocket', 'cart', 'cart', 'session'])
            rocket_adds = [x['name'] for x in j.inspect(flow.flow_id)['operations']
                           if x['name'].startswith('add_rocket_')]
            self.assertEqual(len(rocket_adds), 2)
            self.assertEqual(prepared['readback']['eta'], '2026-10-11T02:15:00+04:00')
            self.assertEqual(prepared['readback']['shipments'], 2)
            responses2 = {'cart': [super_multi_cart(), super_multi_cart(),
                                   super_multi_cart()],
                          'session': super_multi_session()}
            harness2 = SuperHarness(responses2)
            with patch.object(csup.urllib.request, 'build_opener',
                              return_value=super_resolve(super_multi_search())()), \
                    patch.object(csup, 'active_marketplace_orders', return_value=[]):
                resumed = csup.SupermallOrderFlow.resume_active(
                    flow.flow_id, items=SUPER_ITEMS, auth=SuperAuth(),
                    request=harness2.request)
                prepared2 = resumed.prepare_only()
            names2 = [name for name, _, _ in harness2.calls]
            self.assertNotIn('add_rocket', names2)
            self.assertEqual(names2, ['cart', 'cart', 'cart', 'session'])
            self.assertEqual(prepared2['review']['total_minor'], 4949)


if __name__ == '__main__':
    unittest.main()
