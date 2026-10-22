"""Synthetic fixtures + captured-contract bodies; never live requests."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_journal as j
import commerce_supermall_order as c
import noon_marketplace_checkout as market
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint

FIXTURE = json.loads((Path(__file__).parent / 'fixture_supermall_e2e_chain.json').read_text())
HEADERS = {'x-addresscode': '487167e42d7ffb2992c46fb1df0b3a90',
           'x-addresskey': '487167e42d7ffb2992c46fb1df0b3a90-1',
           'cookie': 'synthetic-secret'}
ADDRESS_REF = fingerprint(HEADERS['x-addresscode'], HEADERS['x-addresskey'])
SKU = 'ZC3D2FE430033CA47B932Z'
OFFER = 'aaa9dcee08bdd46c'
ORDER = 'NAEIA0000960441'


class FakeAuth:
    def __init__(self):
        self.retained = []

    def status(self, service, **_):
        return {'maintenance_state': 'none'}

    def revalidate(self, service, *, deadline=None, **_):
        assert service == 'supermall'
        return AuthSnapshot('supermall', fingerprint('synthetic-account'), ADDRESS_REF,
                            time.time(), dict(HEADERS), time.monotonic() + 60)

    reconcile = revalidate

    def retain_response_cookies(self, service, snapshot, values, **_):
        self.retained.append((service, tuple(values)))
        return True


class Harness:
    """Serves scripted responses per marketplace operation; records every send."""

    def __init__(self, responses):
        self.responses = dict(responses)
        self.calls = []

    def request(self, op, headers, deadline, *, response_observer):
        self.calls.append((op.name, op.path, json.loads(op.body) if op.body else None))
        queue = self.responses[op.name]
        response = queue.pop(0) if isinstance(queue, list) else queue
        if isinstance(response, Exception):
            raise response
        response_observer(market.ResponseObservation('https://' + op.host + op.path, 200, ()))
        return copy.deepcopy(response)


def cart_state(*, empty=False, offer=OFFER, sku=SKU, quantity=1):
    if empty:
        return {'apiVersion': 2, 'version': 3, 'count': 0, 'offers': [], 'items': []}
    item = {'offerCode': offer, 'skuConfig': sku, 'quantity': quantity,
            'quantityMin': quantity, 'quantityMax': 3, 'variantKey': '',
            'isSelectedForCheckout': True}
    return {'apiVersion': 2, 'version': 3, 'count': quantity, 'offers': [dict(item)],
            'items': [dict(item)]}


def session_state(*, total=25.49, subtotal=17.0, quantity=1, address=HEADERS['x-addresskey'],
                  silent=True, card_default=True, credits=False, is_rocket=True,
                  delivery_date='2026-10-11T00:37:00', unit_price='17.00'):
    cards = [{'id': '<secret>', 'type': 'MASTERCARD', 'mask': '52287301xxxx5542',
              'isSelected': card_default, 'isDefault': card_default},
             {'id': '<secret>', 'type': 'VISA', 'mask': '419649xxxxxx9963',
              'isSelected': False, 'isDefault': False}]
    promises = [{'isSelected': True, 'message': '<normal>Get in <b>1 hr 8 mins</b></normal>',
                 'deliveryDate': delivery_date, 'analytics': {'tag': 'rocket'}},
                {'isSelected': False, 'message': 'Get it tomorrow',
                 'deliveryDate': '2026-10-11T18:00:00', 'analytics': {'tag': 'ndd'}}]
    if not is_rocket:
        promises = [dict(promises[0], analytics={'tag': 'ndd'}, delivery_date=None)]
    return {'version': 3, 'addressKey': address, 'addressCode': HEADERS['x-addresscode'],
            'useCredits': credits, 'walletAmount': 0.0, 'total': total, 'subtotal': subtotal,
            'orderPaymentAmount': total, 'paymentAmount': total,
            'paymentMethods': [{'code': 'google_pay', 'status': 'available', 'cards': []},
                               {'code': 'cc_noonpay', 'status': 'active', 'cards': cards}],
            'deliveryOptions': {
                'silent_delivery': {'status': 'active' if silent else 'available'},
                'receiver_phone_code': {'status': 'available'}},
            'shipments': [{'id': OFFER + '-0', 'isRocket': is_rocket,
                           'isSlotBased': False,
                           'items': [{'offerCode': OFFER, 'skuConfig': SKU, 'quantity': quantity,
                                      'unitPrice': unit_price, 'brand': 'Quest',
                                      'flags': ['rocket', 'quick_atc']}],
                           'promises': promises}]}


def order_detail_state(order=ORDER):
    """Live rocket order-v2 manifest shape (NAEIA0000960441, packed state).

    The group carries shipmentNr with a null group-level itemNr; item rows
    hold both ids. Invoice reconciles two 'Subtotal (1 item)' rows.
    """
    return {'orderNr': order, 'createdAt': '2026-10-10T23:30:07+04:00', 'itemGroups': [
        {'orderNr': order, 'itemNr': None, 'shipmentNr': order + '-S1',
         'subStatus': {'highStatusCode': 'packed'},
         'items': [{'itemNr': order + '-1', 'shipmentNr': order + '-S1', 'quantity': 1,
                    'skuConfig': SKU, 'offerCode': OFFER}]}],
        'invoice': {'sections': [
            {'title': 'Order details',
             'entries': [{'title': 'Subtotal (1 item)'}, {'title': 'x'}],
             'groups': [{'entries': [{'title': 'Subtotal (1 item)'}]}]},
            {'title': '', 'entries': [{'title': '<strong>Total paid</strong>'}],
             'groups': [{'entries': [{'title': 'x'}]}]}]},
        'shippingAddress': {'addressCode': HEADERS['x-addresscode']},
        'trackActions': {}, 'shippingPreferences': {}, 'metadata': {'isAgent': False},
        'payment': {'paymentMethodCode': 'cc_noonpay'}}


def happy_responses(**overrides):
    responses = {
        'cart': [cart_state(empty=True), cart_state()],
        'add_rocket': FIXTURE['add_resp'],
        'session': session_state(),
        'place': ORDER,
        'order_status': FIXTURE['status_success'],
        'order_detail': order_detail_state(),
    }
    responses.update(overrides)
    return responses


def patched_resolve(monkey_case):
    """Patch the catalog search fetch with a scripted response."""
    case = monkey_case
    class FakeResponse:
        code = 200

        def read(self, *_):
            return json.dumps(case).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    class FakeOpener:
        def open(self, request, timeout=None):
            return FakeResponse()

    return FakeOpener


def make_flow(responses, *, quantity=1, search=None):
    harness = Harness(responses)
    flow = c.SupermallOrderFlow(sku_config=SKU, quantity=quantity, auth=FakeAuth(),
                                request=harness.request)
    return flow, harness


class CapturedContractTests(unittest.TestCase):
    def test_rocket_add_is_quick_atc_route_with_deselect_flags(self):
        self.assertEqual(FIXTURE['add_path'],
                         '/_svc/cart-v1/cart/item/aaa9dcee08bdd46c/1?showCart')
        self.assertEqual(FIXTURE['add_req'],
                         {'isFouponSelected': False, 'isInstallationSelected': False})
        op = market.operation('main', 'add_rocket', offer=OFFER, quantity=1)
        self.assertEqual(op.path, '/_svc/cart-v1/cart/item/aaa9dcee08bdd46c/1?showCart')
        self.assertEqual(json.loads(op.body), FIXTURE['add_req'])
        self.assertTrue(op.mutation)

    def test_place_body_is_bare_total_and_response_is_bare_order(self):
        self.assertEqual(FIXTURE['place_req'], {'total': 25.49})
        self.assertEqual(FIXTURE['place_resp'], ORDER)
        op = market.operation('main', 'place', total=25.49)
        self.assertEqual(json.loads(op.body), FIXTURE['place_req'])
        self.assertTrue(op.mutation)

    def test_session_body_matches_capture(self):
        self.assertEqual(FIXTURE['session_req'], {'shouldUpdateSession': True})

    def test_search_hit_is_buyable_rocket_offer(self):
        hit = FIXTURE['search']['hits'][0]
        self.assertEqual(hit['sku_config'], SKU)
        self.assertEqual(hit['offer_code'], OFFER)
        self.assertTrue(c._truthy(hit['is_buyable']))
        self.assertIn('rocket', hit['flags'])
        self.assertTrue(c._is_rocket_hit(hit))

    def test_paid_success_signal_is_success_with_shipments_and_total(self):
        status = FIXTURE['status_success']
        self.assertEqual(status['status'], 'success')
        self.assertEqual(status['total'], '25.49')
        self.assertTrue(status['shipments'])
        self.assertIsNone(status['paymentError'])
        pending = FIXTURE['status_pending']
        self.assertEqual(pending['status'], 'pending')
        self.assertIsNone(pending.get('shipments'))

    def test_captured_session_verifies_rocket_guards(self):
        data = FIXTURE['session_resp']
        self.assertEqual(data['deliveryOptions']['silent_delivery']['status'], 'active')
        self.assertFalse(data['useCredits'])
        self.assertEqual(data['addressKey'], HEADERS['x-addresskey'])
        cc = next(m for m in data['paymentMethods'] if m['code'] == 'cc_noonpay')
        self.assertEqual(cc['status'], 'active')
        default = [card for card in cc['cards']
                   if card['mask'].endswith('5542') and card['isDefault'] is True
                   and card['isSelected'] is True]
        self.assertEqual(len(default), 1)
        shipment = data['shipments'][0]
        self.assertIs(shipment['isRocket'], True)
        self.assertIs(shipment['isSlotBased'], False)
        selected = [p for p in shipment['promises'] if p['isSelected']]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]['deliveryDate'], '2026-10-11T00:37:00')
        self.assertEqual(selected[0]['analytics']['tag'], 'rocket')
        self.assertEqual(data['subtotal'], 17.0)
        self.assertEqual(data['total'], data['orderPaymentAmount'])

    def test_fixture_hygiene_never_stores_card_secrets(self):
        def walk(node):
            if isinstance(node, dict):
                is_card = 'mask' in node or 'ccMasked' in node
                for key, value in node.items():
                    if key in ('paymentToken', 'clientSecret'):
                        self.assertIn(value, ('<secret>', None), key)
                    if key == 'id' and is_card:
                        self.assertEqual(value, '<secret>', key)
                    walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)
        walk(FIXTURE)


class ResolveOfferTests(unittest.TestCase):
    def test_exact_variant_uses_rocket_catalog_experience(self):
        hit = FIXTURE['search']['hits'][0]
        class Opener:
            def open(self, request, timeout=None):
                selected = hit if request.get_header('X-experience') == 'rocket' else dict(hit, sku_config='SIBLING')
                return patched_resolve({'hits': [selected]})().open(request, timeout)
        with patch.object(c.urllib.request, 'build_opener', return_value=Opener()):
            self.assertEqual(c.resolve_rocket_offer(HEADERS, SKU)['offer'], OFFER)

    def test_nested_rocket_promotion_is_not_the_selected_offer(self):
        hit = dict(FIXTURE['search']['hits'][0], flags=['fbn', 'nano'],
                   rocket={'estimation_text': 'GET IN 1 HR', 'offer_code': 'OTHER'})
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve({'hits': [hit]})()):
            with self.assertRaisesRegex(j.JournalError, 'ITEM_NOT_ROCKET') as error:
                c.resolve_rocket_offer(HEADERS, SKU)
        self.assertEqual(error.exception.details, {'sku_config': SKU})

    def test_missing_sku_error_names_the_item(self):
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve({'hits': []})()):
            with self.assertRaises(j.JournalError) as error:
                c.resolve_rocket_offer(HEADERS, SKU)
        self.assertEqual(error.exception.details, {'sku_config': SKU})

    def test_resolve_exact_buyable_rocket_hit(self):
        case = {'hits': [FIXTURE['search']['hits'][0], {'sku_config': 'OTHER'}]}
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve(case)()):
            resolved = c.resolve_rocket_offer(HEADERS, SKU, timeout=5)
        self.assertEqual(resolved['offer'], OFFER)
        self.assertEqual(resolved['stock_minimum_quantity'], 1)

    def test_resolve_refuses_non_rocket_hit(self):
        hit = dict(FIXTURE['search']['hits'][0], flags=['quick_atc', 'nano'])
        hit.pop('rocket')
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve({'hits': [hit]})()):
            with self.assertRaisesRegex(j.JournalError, 'ITEM_NOT_ROCKET'):
                c.resolve_rocket_offer(HEADERS, SKU, timeout=5)

    def test_resolve_refuses_unbuyable_or_absent(self):
        not_buyable = {'hits': [dict(FIXTURE['search']['hits'][0], is_buyable=False)]}
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(not_buyable)()):
            with self.assertRaisesRegex(j.JournalError, 'CATALOG_ITEM_UNAVAILABLE'):
                c.resolve_rocket_offer(HEADERS, SKU, timeout=5)
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve({'hits': []})()):
            with self.assertRaisesRegex(j.JournalError, 'CATALOG_ITEM_UNAVAILABLE'):
                c.resolve_rocket_offer(HEADERS, SKU, timeout=5)


class LaneTests(unittest.TestCase):
    def run_lane(self, responses, *, quantity=1):
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            flow, harness = make_flow(responses, quantity=quantity)
            with patch.object(c, 'active_marketplace_orders', return_value=[]):
                guard = flow.guard()
            self.assertEqual(guard['offer'], OFFER)
            flow.add()
            flow.checkout_session()
            review = flow.review_session()
            placed = flow.place()
            paid = flow.await_success(sleep=lambda _: None)
            flow.confirm_paid()
            tracking = flow.verify_tracking(sleep=lambda _: None)
            return flow, harness, review, placed, paid, tracking

    def test_full_lane_order_and_bodies(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness, review, placed, paid, tracking = self.run_lane(happy_responses())
            self.assertEqual(placed['order'], ORDER)
            self.assertTrue(paid['paid'])
            paths = [(name, path) for name, path, _ in harness.calls]
            self.assertEqual([name for name, _ in paths],
                             ['cart', 'add_rocket', 'cart', 'session', 'place', 'order_status',
                              'order_detail'])
            add_path = next(path for name, path in paths if name == 'add_rocket')
            self.assertEqual(add_path, '/_svc/cart-v1/cart/item/aaa9dcee08bdd46c/1?showCart')
            place_body = next(body for name, _, body in harness.calls if name == 'place')
            self.assertEqual(place_body, {'total': 25.49})
            session_body = next(body for name, _, body in harness.calls if name == 'session')
            self.assertEqual(session_body, {'shouldUpdateSession': True})
            self.assertEqual(review['total_minor'], 2549)
            self.assertEqual(review['fees_minor'], 849)
            self.assertEqual(review['isRocket'], True)
            self.assertEqual(review['eta'], '2026-10-11T00:37:00+04:00')
            self.assertEqual(flow.review['payable_minor'], 2549)

    def test_payment_error_is_failure_never_retry(self):
        error = dict(FIXTURE['status_success'], status='pending',
                     paymentError='card_declined')
        responses = happy_responses(order_status=error)
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            with self.assertRaisesRegex(j.JournalError, 'PAYMENT_ERROR_NO_RETRY'):
                self.run_lane(responses)

    def test_silent_delivery_inactive_refused_before_place(self):
        responses = happy_responses(session=session_state(silent=False))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            with self.assertRaisesRegex(j.JournalError, 'SILENT_DELIVERY_NOT_ACTIVE'):
                flow.review_session()
            self.assertNotIn('place', [name for name, _, _ in harness.calls])

    def test_default_card_not_selected_refused(self):
        responses = happy_responses(session=session_state(card_default=False))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            with self.assertRaisesRegex(j.JournalError, 'DEFAULT_CARD_NOT_SELECTED'):
                flow.review_session()

    def test_non_rocket_shipment_refused(self):
        responses = happy_responses(session=session_state(is_rocket=False))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            with self.assertRaisesRegex(j.JournalError, 'ROCKET_SHIPMENT_REQUIRED'):
                flow.review_session()
            self.assertNotIn('place', [name for name, _, _ in harness.calls])

    def test_relative_promise_delivery_date_refused(self):
        responses = happy_responses(session=session_state(delivery_date='tomorrow'))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            with self.assertRaisesRegex(j.JournalError, 'PROMISE_DELIVERY_DATE_REQUIRED'):
                flow.review_session()

    def test_fee_breaks_arithmetic_refused(self):
        responses = happy_responses(session=session_state(subtotal=19.0))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            # Multi-item aggregate review: subtotal must equal the exact unit
            # price sum, so a drugged subtotal fails the more precise check
            # before the total/fees equality is evaluated.
            with self.assertRaisesRegex(j.JournalError, 'SUBTOTAL_ARITHMETIC_MISMATCH'):
                flow.review_session()

    def test_address_binding_mismatch_refused(self):
        responses = happy_responses(session=session_state(address='OTHER-KEY'))
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            flow.add()
            flow.checkout_session()
            with self.assertRaisesRegex(j.JournalError, 'ADDRESS_BINDING_MISMATCH'):
                flow.review_session()

    def test_quantity_below_stock_minimum_refused(self):
        minimum = dict(FIXTURE['search']['hits'][0], stock_minimum_quantity=2)
        case = {'hits': [minimum]}
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve(case)()):
            flow, harness = make_flow(happy_responses(), quantity=1)
            with patch.object(c, 'active_marketplace_orders', return_value=[]):
                with self.assertRaisesRegex(j.JournalError, 'QUANTITY_BELOW_STOCK_MINIMUM'):
                    flow.guard()

    def test_active_pending_order_blocks_before_any_write(self):
        responses = happy_responses(order_status=FIXTURE['status_pending'])
        flow, harness = make_flow(responses)
        active = [{'order': ORDER, 'raw_status': 'in_progress'}]
        with patch.object(c, 'active_marketplace_orders', return_value=active):
            with self.assertRaisesRegex(j.JournalError, 'ACTIVE_ORDER_PRESENT'):
                flow.guard()
        self.assertEqual([name for name, _, _ in harness.calls], ['cart', 'order_status'])

    def test_prior_paid_active_rocket_order_surfaces_and_proceeds(self):
        responses = happy_responses(cart=[cart_state(empty=True)])
        flow, harness = make_flow(responses)
        active = [{'order': ORDER, 'raw_status': 'out_for_delivery'}]
        with patch.object(c, 'active_marketplace_orders', return_value=active), \
                patch.object(c.urllib.request, 'build_opener',
                             return_value=patched_resolve(FIXTURE['search'])()):
            guard = flow.guard()
        self.assertEqual(guard['active_orders'], 1)
        self.assertEqual(guard['prior_orders_paid'], [{'order': ORDER, 'status': 'success'}])
        self.assertEqual([name for name, _, _ in harness.calls], ['cart', 'order_status'])

    def test_nonempty_basket_never_replaced(self):
        responses = happy_responses(cart=[cart_state()])
        flow, harness = make_flow(responses)
        with patch.object(c, 'active_marketplace_orders', return_value=[]):
            with self.assertRaisesRegex(j.JournalError, 'MUST_NOT_BE_REPLACED'):
                flow.guard()
        self.assertEqual([name for name, _, _ in harness.calls], ['cart'])

    def test_added_manifest_mismatch_fences(self):
        responses = happy_responses(cart=[cart_state(empty=True), cart_state(offer='deadbeef00000000')])
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
                flow.guard()
            with self.assertRaisesRegex(j.JournalError, 'EXACT_ADDED_MANIFEST_MISMATCH'):
                flow.add()


class ResumeTests(unittest.TestCase):
    def prepare_partial_flow(self):
        temp = tempfile.mkdtemp()
        roots = (patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'),
                 patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'))
        for root in roots:
            root.start()
            self.addCleanup(root.stop)
        flow, harness = make_flow(happy_responses())
        with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                patch.object(c.urllib.request, 'build_opener',
                             return_value=patched_resolve(FIXTURE['search'])()):
            flow.guard()
        flow.add()
        return flow

    def test_resume_rebuilds_and_places_without_re_add(self):
        first = self.prepare_partial_flow()
        responses = dict(happy_responses())
        del responses['add_rocket']
        responses['cart'] = [cart_state()]
        harness = Harness(responses)
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            resumed = c.SupermallOrderFlow.resume_active(first.flow_id, sku_config=SKU,
                                                         quantity=1, auth=FakeAuth(),
                                                         request=harness.request)
        self.assertEqual(resumed.offer, OFFER)
        resumed.checkout_session()
        resumed.review_session()
        placed = resumed.place()
        self.assertEqual(placed['order'], ORDER)
        names = [name for name, _, _ in harness.calls]
        self.assertNotIn('add_rocket', names)
        self.assertEqual(names, ['cart', 'session', 'place'])

    def test_resume_refuses_flow_older_than_24h(self):
        first = self.prepare_partial_flow()
        with patch.object(j, 'flow_created_at', return_value=time.time() - 25 * 3600):
            with self.assertRaisesRegex(j.JournalError, 'EXPIRED_24H'):
                c.SupermallOrderFlow.resume_active(first.flow_id, sku_config=SKU, quantity=1,
                                                   auth=FakeAuth(), request=Harness({}).request)

    def test_resume_refuses_foreign_basket(self):
        first = self.prepare_partial_flow()
        harness = Harness({'cart': [cart_state(offer='deadbeef00000000')]})
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            with self.assertRaisesRegex(j.JournalError, 'RESUME_MANIFEST_MISMATCH'):
                c.SupermallOrderFlow.resume_active(first.flow_id, sku_config=SKU, quantity=1,
                                                   auth=FakeAuth(), request=harness.request)


class CompletionTests(unittest.TestCase):
    def test_paid_order_completes_journal_with_tracker_and_eta(self):
        temp = tempfile.mkdtemp()
        with patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            with patch.object(c.urllib.request, 'build_opener',
                              return_value=patched_resolve(FIXTURE['search'])()):
                flow, harness = make_flow(happy_responses())
                with patch.object(c, 'active_marketplace_orders', return_value=[]):
                    flow.guard()
                flow.add()
                flow.checkout_session()
                flow.review_session()
                flow.place()
                paid = flow.await_success(sleep=lambda _: None)
                self.assertTrue(paid['paid'])
                flow.confirm_paid()
                flow.verify_tracking(sleep=lambda _: None)
                state = j.inspect(flow.flow_id)
                self.assertEqual(state['state'], 'ACTIVE')
                self.assertEqual(state['order_id'], ORDER)
                self.assertEqual(state['reserved_minor'], 2549)
                with self.assertRaises(j.JournalError):
                    j.complete(flow.flow_id)
                name = f"order-noon-{ORDER.lower()}"
                with patch.object(c, 'WATCH_ORDERS', Path(temp).resolve() / 'orders'), \
                        patch.object(c, 'WATCH_WATCHERS', Path(temp).resolve() / 'watchers'), \
                        patch.object(c, 'WATCH_BIN', '/nonexistent/order-watch'):
                    (Path(temp).resolve() / 'orders').mkdir()
                    (Path(temp).resolve() / 'watchers' / name).mkdir(parents=True)
                    (Path(temp).resolve() / 'orders' / f'{name}.json').write_text(json.dumps(
                        {'order': ORDER, 'active': True}))
                    (Path(temp).resolve() / 'watchers' / name / 'watcher.json').write_text(
                        json.dumps({'ok': 1}))
                    import subprocess as sp
                    commands = []

                    def fake_run(command, **kwargs):
                        commands.append(command)
                        return sp.CompletedProcess([], 0)

                    with patch.object(c.subprocess, 'run', side_effect=fake_run):
                        registration = flow.register_tracker('test label', eta=flow.review['eta'])
                    self.assertTrue(registration['registered'])
                    self.assertIn('--eta', commands[0])
                    self.assertIn('2026-10-11T00:37:00+04:00', commands[0])
                j.complete(flow.flow_id)
                self.assertEqual(j.inspect(flow.flow_id)['state'], 'COMPLETE')

    def test_resume_paid_finishes_read_only(self):
        temp = tempfile.mkdtemp()
        first = None
        journal_root = patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce')
        receipts_root = patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce')
        journal_root.start()
        self.addCleanup(journal_root.stop)
        receipts_root.start()
        self.addCleanup(receipts_root.stop)
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            flow, harness = make_flow(happy_responses())
            with patch.object(c, 'active_marketplace_orders', return_value=[]):
                flow.guard()
            flow.add()
            flow.checkout_session()
            flow.review_session()
            flow.place()
            flow.await_success(sleep=lambda _: None)
            flow.confirm_paid()
            first = flow.flow_id
        name = f"order-noon-{ORDER.lower()}"
        harness = Harness({'order_detail': order_detail_state()})
        with patch.object(c, 'WATCH_ORDERS', Path(temp).resolve() / 'orders'), \
                patch.object(c, 'WATCH_WATCHERS', Path(temp).resolve() / 'watchers'), \
                patch.object(c, 'WATCH_BIN', '/nonexistent/order-watch'), \
                patch.object(c.subprocess, 'run',
                             return_value=__import__('subprocess').CompletedProcess([], 0)):
            (Path(temp).resolve() / 'orders').mkdir()
            (Path(temp).resolve() / 'watchers' / name).mkdir(parents=True)
            (Path(temp).resolve() / 'orders' / f'{name}.json').write_text(json.dumps(
                {'order': ORDER, 'active': True}))
            (Path(temp).resolve() / 'watchers' / name / 'watcher.json').write_text(
                json.dumps({'ok': 1}))
            result = c.SupermallOrderFlow.resume_paid(first, label='resumed label',
                                                      auth=FakeAuth(), request=harness.request)
        self.assertTrue(result['ok'])
        self.assertEqual(result['order'], ORDER)
        self.assertEqual([name_ for name_, _, _ in harness.calls], ['order_detail'])
        self.assertEqual(j.inspect(first)['state'], 'COMPLETE')


if __name__ == '__main__':
    unittest.main()
