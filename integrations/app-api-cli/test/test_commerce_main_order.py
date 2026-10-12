"""Synthetic fixtures + captured-contract bodies; never live requests."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_journal as j
import commerce_main_order as c
import noon_marketplace_checkout as market
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint

FIXTURE = json.loads((Path(__file__).parent / 'fixture_main_e2e_chain.json').read_text())
HEADERS = {'x-addresscode': '487167e42d7ffb2992c46fb1df0b3a90',
           'x-addresskey': '487167e42d7ffb2992c46fb1df0b3a90-1',
           'cookie': 'synthetic-secret'}
ADDRESS_REF = fingerprint(HEADERS['x-addresscode'], HEADERS['x-addresskey'])
SKU = 'Z0B9474A290818B862A38Z'
OFFER = 'a42fa0b0583a448f'
ORDER = 'NAEIA0042714780'


class FakeAuth:
    def __init__(self):
        self.retained = []

    def status(self, service, **_):
        return {'maintenance_state': 'none'}

    def revalidate(self, service, *, deadline=None, **_):
        assert service == 'main'
        return AuthSnapshot('main', fingerprint('synthetic-account'), ADDRESS_REF,
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


def cart_state(*, empty=False, offer=OFFER, sku=SKU, quantity=2):
    if empty:
        return {'apiVersion': 2, 'version': 3, 'count': 0, 'offers': [], 'items': []}
    item = {'offerCode': offer, 'skuConfig': sku, 'quantity': quantity,
            'quantityMin': quantity, 'quantityMax': 10, 'variantKey': '',
            'isSelectedForCheckout': True}
    return {'apiVersion': 2, 'version': 3, 'count': quantity, 'offers': [dict(item)],
            'items': [dict(item)]}


def session_state(*, total=19.8, quantity=2, address=HEADERS['x-addresskey'],
                  silent=True, card_default=True, credits=False):
    cards = [{'id': '<secret>', 'type': 'MASTERCARD', 'mask': '52287301xxxx5542',
              'isSelected': card_default, 'isDefault': card_default},
             {'id': '<secret>', 'type': 'VISA', 'mask': '419649xxxxxx9963',
              'isSelected': False, 'isDefault': False}]
    return {'version': 3, 'addressKey': address, 'addressCode': HEADERS['x-addresscode'],
            'useCredits': credits, 'walletAmount': 0.0, 'total': total, 'subtotal': total,
            'orderPaymentAmount': total, 'paymentAmount': total,
            'paymentMethods': [{'code': 'google_pay', 'status': 'available', 'cards': []},
                               {'code': 'cc_noonpay', 'status': 'active', 'cards': cards}],
            'deliveryOptions': {
                'silent_delivery': {'status': 'active' if silent else 'available'},
                'receiver_phone_code': {'status': 'available'}},
            'shipments': [{'id': OFFER + '-0', 'items': [
                {'offerCode': OFFER, 'skuConfig': SKU, 'quantity': quantity,
                 'unitPrice': '9.90', 'brand': 'Maxi Nutrition'}],
                'promises': [{'isSelected': True, 'message': 'Get it Tomorrow'}]}]}


def order_detail_state(order=ORDER):
    return {'orderNr': order, 'itemGroups': [
        {'orderNr': order, 'itemNr': order + '-1', 'shipmentNr': order + '-S1',
         'subStatus': {'highStatusCode': 'confirmed'},
         'items': [{'itemNr': order + '-1', 'shipmentNr': order + '-S1', 'quantity': 2}]}],
        'invoice': {'sections': [{'entries': [{'title': 'x'}, {'title': 'x'}]}]}}


def happy_responses(**overrides):
    responses = {
        'cart': [cart_state(empty=True), cart_state()],
        'add': FIXTURE['add_resp'],
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


def make_flow(responses, *, quantity=2, search=None):
    harness = Harness(responses)
    flow = c.MainOrderFlow(sku_config=SKU, quantity=quantity, auth=FakeAuth(),
                           request=harness.request)
    return flow, harness


class CapturedContractTests(unittest.TestCase):
    def test_place_body_is_bare_total_and_response_is_bare_order(self):
        self.assertEqual(FIXTURE['place_req'], {'total': 19.8})
        self.assertEqual(FIXTURE['place_resp'], ORDER)
        op = market.operation('main', 'place', total=19.8)
        self.assertEqual(json.loads(op.body), FIXTURE['place_req'])
        self.assertTrue(op.mutation)

    def test_session_body_matches_capture(self):
        self.assertEqual(FIXTURE['session_req'], {'shouldUpdateSession': True})

    def test_add_maps_offer_path_with_quantity(self):
        self.assertIn('cart-v1/cart/item/a42fa0b0583a448f/2', FIXTURE['add_path'])
        self.assertIn('showCart', FIXTURE['add_path'])

    def test_search_hit_resolves_offer_and_minimum_quantity(self):
        hit = FIXTURE['search']['hits'][0]
        self.assertEqual(hit['sku_config'], SKU)
        self.assertEqual(hit['offer_code'], OFFER)
        self.assertTrue(c._truthy(hit['is_buyable']))
        self.assertEqual(c._positive_int(hit['stock_minimum_quantity']), 2)

    def test_paid_success_signal_is_success_with_shipments_and_total(self):
        status = FIXTURE['status_success']
        self.assertEqual(status['status'], 'success')
        self.assertEqual(status['total'], '19.80')
        self.assertTrue(status['shipments'])
        self.assertIsNone(status['paymentError'])
        pending = FIXTURE['status_pending']
        self.assertEqual(pending['status'], 'pending')

    def test_captured_session_verifies_lane_guards(self):
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

    def test_fixture_hygiene_never_stores_card_secrets(self):
        def walk(node):
            if isinstance(node, dict):
                is_card = 'mask' in node or 'ccMasked' in node
                for key, value in node.items():
                    if key in ('paymentToken', 'clientSecret'):
                        self.assertEqual(value, '<secret>', key)
                    if key == 'id' and is_card:
                        self.assertEqual(value, '<secret>', key)
                    walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)
        walk(FIXTURE)


class ResolveOfferTests(unittest.TestCase):
    def test_resolve_exact_buyable_hit(self):
        case = {'hits': [FIXTURE['search']['hits'][0], {'sku_config': 'OTHER'}]}
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve(case)()):
            resolved = c.resolve_offer(HEADERS, SKU, timeout=5)
        self.assertEqual(resolved['offer'], OFFER)
        self.assertEqual(resolved['stock_minimum_quantity'], 2)

    def test_resolve_refuses_unbuyable_or_absent(self):
        not_buyable = {'hits': [dict(FIXTURE['search']['hits'][0], is_buyable=False)]}
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(not_buyable)()):
            with self.assertRaisesRegex(j.JournalError, 'CATALOG_ITEM_UNAVAILABLE'):
                c.resolve_offer(HEADERS, SKU, timeout=5)
        with patch.object(c.urllib.request, 'build_opener', return_value=patched_resolve({'hits': []})()):
            with self.assertRaisesRegex(j.JournalError, 'CATALOG_ITEM_UNAVAILABLE'):
                c.resolve_offer(HEADERS, SKU, timeout=5)


class LaneTests(unittest.TestCase):
    def run_lane(self, responses, *, quantity=2):
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
            tracking = flow.verify_tracking()
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
                             ['cart', 'add', 'cart', 'session', 'place', 'order_status',
                              'order_detail'])
            add_path = next(path for name, path in paths if name == 'add')
            self.assertIn('cart-v1/cart/item/a42fa0b0583a448f/2', add_path)
            place_body = next(body for name, _, body in harness.calls if name == 'place')
            self.assertEqual(place_body, {'total': 19.8})
            session_body = next(body for name, _, body in harness.calls if name == 'session')
            self.assertEqual(session_body, {'shouldUpdateSession': True})
            self.assertEqual(review['total_minor'], 1980)
            self.assertEqual(flow.review['payable_minor'], 1980)

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
        responses = happy_responses()
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses, quantity=1)
            with patch.object(c, 'active_marketplace_orders', return_value=[]), \
                    patch.object(c.urllib.request, 'build_opener',
                                 return_value=patched_resolve(FIXTURE['search'])()):
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

    def test_prior_paid_active_order_surfaces_and_proceeds(self):
        responses = happy_responses(cart=[cart_state(empty=True)])
        flow, harness = make_flow(responses)
        active = [{'order': ORDER, 'raw_status': 'confirmed'}]
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
        del responses['add']
        responses['cart'] = [cart_state()]
        harness = Harness(responses)
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            resumed = c.MainOrderFlow.resume_active(first.flow_id, sku_config=SKU,
                                                    quantity=2, auth=FakeAuth(),
                                                    request=harness.request)
        self.assertEqual(resumed.offer, OFFER)
        resumed.checkout_session()
        resumed.review_session()
        placed = resumed.place()
        self.assertEqual(placed['order'], ORDER)
        names = [name for name, _, _ in harness.calls]
        self.assertNotIn('add', names)
        self.assertEqual(names, ['cart', 'session', 'place'])

    def test_resume_refuses_flow_older_than_24h(self):
        first = self.prepare_partial_flow()
        with patch.object(j, 'flow_created_at', return_value=time.time() - 25 * 3600):
            with self.assertRaisesRegex(j.JournalError, 'EXPIRED_24H'):
                c.MainOrderFlow.resume_active(first.flow_id, sku_config=SKU, quantity=2,
                                              auth=FakeAuth(), request=Harness({}).request)

    def test_resume_refuses_foreign_basket(self):
        first = self.prepare_partial_flow()
        harness = Harness({'cart': [cart_state(offer='deadbeef00000000')]})
        with patch.object(c.urllib.request, 'build_opener',
                          return_value=patched_resolve(FIXTURE['search'])()):
            with self.assertRaisesRegex(j.JournalError, 'RESUME_MANIFEST_MISMATCH'):
                c.MainOrderFlow.resume_active(first.flow_id, sku_config=SKU, quantity=2,
                                              auth=FakeAuth(), request=harness.request)


class CompletionTests(unittest.TestCase):
    def test_paid_order_completes_journal_with_tracker(self):
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
                flow.verify_tracking()
                state = j.inspect(flow.flow_id)
                self.assertEqual(state['state'], 'ACTIVE')
                self.assertEqual(state['order_id'], ORDER)
                self.assertEqual(state['reserved_minor'], 1980)
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
                    result = sp.CompletedProcess([], 0)
                    with patch.object(c.subprocess, 'run', return_value=result):
                        registration = flow.register_tracker('test label')
                    self.assertTrue(registration['registered'])
                j.complete(flow.flow_id)
                self.assertEqual(j.inspect(flow.flow_id)['state'], 'COMPLETE')


if __name__ == '__main__':
    unittest.main()
