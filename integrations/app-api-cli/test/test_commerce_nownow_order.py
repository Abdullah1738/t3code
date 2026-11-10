"""Synthetic fixtures + captured-contract bodies; never live requests."""
import copy
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import commerce_journal as j
import commerce_nownow_order as c
import noon_nownow_checkout as native
from noon_auth_lifecycle import AuthSnapshot
from noon_checkout import fingerprint

FIXTURE = json.loads((Path(__file__).parent / 'fixture_nownow_e2e_chain.json').read_text())
HEADERS = {'x-addresscode': '487167e42d7ffb2992c46fb1df0b3a90',
           'x-addresskey': '487167e42d7ffb2992c46fb1df0b3a90-1',
           'cookie': 'synthetic-secret'}
ADDRESS_REF = fingerprint(HEADERS['x-addresscode'], HEADERS['x-addresskey'])
STORE = 'SPNNYSAKBB'
PRODUCT = 'P4372707388695472A'
SYNTHETIC_ORDER = 'NNGAANNTEST01'
SYNTHETIC_TOKEN = '9876543210'


class FakeAuth:
    def __init__(self):
        self.retained = []

    def status(self, service, **_):
        return {'maintenance_state': 'none'}

    def revalidate(self, service, *, deadline=None, **_):
        assert service == 'nownow'
        return AuthSnapshot('nownow', fingerprint('synthetic-account'), ADDRESS_REF,
                            time.time(), dict(HEADERS), time.monotonic() + 60)

    reconcile = revalidate

    def retain_response_cookies(self, service, snapshot, values, **_):
        self.retained.append((service, tuple(values)))
        return True


def nn_state(*, session='S-SESSION-1', store=STORE, product=PRODUCT, qty=1.0,
             subtotal=2050, delivery=645, service_fee=450, total=None, payment=False,
             quiet=False, address=HEADERS['x-addresscode'], tip=0, discount=0):
    total = subtotal + delivery + service_fee + tip - discount if total is None else total

    def aed(minor):
        return round(minor / 100, 2)

    return {'data': {'checkoutSessionCode': session, 'channelCode': 'noon',
                     'paymentMethodCode': 'prepaid' if payment else None,
                     'creditCardMask': '52287301xxxx2342' if payment else None,
                     'hasPaymentSubscription': payment, 'addressCode': address,
                     'addressVersion': 1, 'storeCode': store,
                     'storeInfo': {'storeCode': store, 'nameEn': 'Spinneys'},
                     'orderSubtotal': aed(subtotal), 'orderSubtotalDiscounted': aed(subtotal),
                     'orderDiscount': aed(discount), 'orderRiderTip': aed(tip),
                     'orderDeliveryFee': aed(delivery), 'orderHandlingFee': 0.0,
                     'orderServiceFee': aed(service_fee), 'orderSmallOrderFee': 0.0,
                     'orderCashFee': 0.0, 'orderTotal': aed(total), 'orderWalletAmount': 0.0,
                     'orderPaymentAmount': aed(total), 'totalQuantity': int(qty),
                     'currencyCode': 'AED', 'driverNotes': native.QUIET_NOTE if quiet else '',
                     'notes': '', 'customerCode': 'synthetic-account',
                     'isVerifyDeviceRequired': False, 'checkoutWarningPopup': None,
                     'vipSingleCheckoutInfo': {'isAddedToCart': False},
                     'prepaidPaymentMisc': {'isCvvRequired': False, 'prepaidPaymentMethodCode': 'cc_noonpay'},
                     'deliveryPreference': {'dont_ring_the_bell': quiet,
                                            'leave_it_at_my_door': quiet},
                     'products': [{'productCode': product, 'qty': qty, 'price': aed(subtotal),
                                   'name': 'Grenade Protein Shake, White Chocolate',
                                   'maxQty': None, 'productTypeCode': 'non_weighable',
                                   'modifiers': []}]}}


def place_state(order=SYNTHETIC_ORDER):
    return {'data': {'session': None, 'order': {
        'orderNr': order, 'orderRef': '2981', 'orderStatusCode': 'pending_acceptance',
        'storeStatusCode': 'pending_acceptance', 'logisticsStatusCode': 'not_initiated',
        'customerStatusCode': 'placed', 'orderSubtotal': 20.5, 'orderDeliveryFee': 6.45,
        'orderServiceFee': 4.5, 'orderTotal': 31.45, 'orderPaymentAmount': 31.45,
        'orderWalletAmount': 0.0, 'paymentMethodCode': 'prepaid',
        'creditCardMask': '52287301xxxx2342',
        'prepaidPaymentMisc': {'isCvvRequired': False, 'prepaidPaymentMethodCode': 'cc_noonpay'},
        'products': [{'productCode': PRODUCT, 'qty': 1.0}]}}}


class Harness:
    """Serves scripted responses per native operation; records every send."""

    def __init__(self, responses):
        self.responses = dict(responses)
        self.calls = []

    def request(self, operation, headers, deadline, payload, *, response_observer, order=None):
        self.calls.append((operation, copy.deepcopy(payload)))
        if operation == 'order_detail' and operation not in self.responses:
            row = copy.deepcopy(self.responses['cart_get']['data'])
            row.update(orderNr=SYNTHETIC_ORDER, orderStatusCode='pending_acceptance', paymentClientSecret=None,
                       failedErrorMsg=None, orderRefunds=0, orderIssuedCredit=0,
                       deliveryPreferenceInfo=[{'code': k, 'choice': True} for k in c.QUIET_FLAGS])
            response = {'data': row}
        else:
            response = self.responses[operation]
        if isinstance(response, Exception):
            raise response
        _, url = native.endpoint(operation, payload, order)
        response_observer(native.ResponseObservation(url, 200, ()))
        return copy.deepcopy(response)


def happy_responses(**overrides):
    responses = {
        'home': {'data': {'active': []}},
        'carts_recent': {'data': {'carts': []}},
        'payment_cards': {'data': [{'id': int(SYNTHETIC_TOKEN), 'ccMasked': '52287301xxxx2342',
                                    'ccType': 'MASTERCARD', 'isDefault': True,
                                    'isDeleted': False}]},
        'payment_subscription_list': {'data': [{'paymentToken': SYNTHETIC_TOKEN},
                                               {'paymentToken': 'uuid-shaped-token'}]},
        'cart_create': nn_state(),
        'cart_validate': nn_state(),
        'payment': nn_state(payment=True),
        'delivery_preference': nn_state(payment=True, quiet=True),
        'instructions': nn_state(payment=True, quiet=True),
        'cart_get': nn_state(payment=True, quiet=True),
        'place': place_state(),
        'track': FIXTURE['tracking_placed'],
    }
    responses.update(overrides)
    return responses


def make_flow(responses, **kwargs):
    harness = Harness(responses)
    flow = c.NowNowOrderFlow(store_code=kwargs.pop('store', STORE),
                             product_code=kwargs.pop('product', PRODUCT),
                             quantity=kwargs.pop('quantity', 1), auth=FakeAuth())
    flow.client._request = harness.request
    return flow, harness


class FixtureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for module in (j, c.receipts):
            p = patch.object(module, 'ROOT', Path(temp.name) / 'commerce')
            p.start()
            self.addCleanup(p.stop)


class CapturedContractTests(unittest.TestCase):
    """The lane replays the exact bodies/paths captured on NNGAANNWEFJMZW8A."""

    def test_live_cart_decimal_string_quantities_preserve_exact_manifest(self):
        self.assertEqual(c._wire_manifest([
            {'productCode': 'P54166252613A', 'qty': '2.0'},
            {'productCode': 'P60539021472A', 'qty': '1.0'}]),
            [('P54166252613A', 2), ('P60539021472A', 1)])
        self.assertEqual(c._wire_manifest([
            {'productCode': 'P54166252613A', 'qty': Decimal('2.0')},
            {'productCode': 'P60539021472A', 'qty': Decimal('1.0')}]),
            [('P54166252613A', 2), ('P60539021472A', 1)])
        for value in (True, 0, -1, '0.0', '-1.0', '1.5', 'NaN', 'Infinity',
                      '1e2', ' 1 ', 1.5, float('inf'), Decimal('NaN'),
                      Decimal('Infinity'), Decimal('1.5'), Decimal('0')):
            with self.subTest(value=value):
                self.assertIsNone(c._wire_qty(value))

    def test_live_cart_string_zero_wallet_passes_exact_review(self):
        flow = object.__new__(c.NowNowOrderFlow)
        flow.session_code = 'S-SESSION-1'
        flow.store_code = STORE
        flow.items = [{'product_code': PRODUCT, 'quantity': 1}]
        flow.snapshot = FakeAuth().revalidate('nownow')
        row = nn_state()['data']
        row['orderWalletAmount'] = '0.0'
        self.assertEqual(flow._guard_state(row)['total_minor'], 3145)
        row['orderWalletAmount'] = '0.01'
        with self.assertRaisesRegex(j.JournalError, 'NOWNOW_FEE_ARITHMETIC_OR_EXTRAS'):
            flow._guard_state(row)

    def test_edit_payment_body_matches_capture(self):
        card = native.SavedCard(SYNTHETIC_TOKEN, '52287301xxxx2342', 'MASTERCARD')
        body = native.payment_payload(FIXTURE['edit_payment_req']['sessionCode'], card)
        expected = dict(FIXTURE['edit_payment_req'], paymentToken=SYNTHETIC_TOKEN)
        self.assertEqual(body, expected)

    def test_place_body_binds_session_total(self):
        body = native.place_payload(FIXTURE['place_req']['sessionCode'], 3145)
        self.assertEqual(body, FIXTURE['place_req'])
        self.assertEqual(body['total'], FIXTURE['captured_total'])

    def test_quiet_preference_is_one_call_with_both_flags(self):
        captured = FIXTURE['correct_preference_req']
        self.assertEqual(set(captured), {'sessionCode', 'deliveryPreference'})
        self.assertEqual(captured['deliveryPreference'],
                         {'leave_it_at_my_door': True, 'dont_ring_the_bell': True})

    def test_routes_match_captured_paths(self):
        expect = {
            'cart_create': 'v1/session/create', 'product_edit': 'v1/session/edit-product',
            'cart_validate': 'v1/session/validate', 'payment': 'v1/session/edit-payment',
            'delivery_preference': 'v1/session/set-delivery-preference',
            'place': 'v1/order/place-order',
            'payment_subscription_list': 'v1/payment/subscription/list',
            'home': 'v1/order/homepage',
        }
        for operation, suffix in expect.items():
            self.assertIn(suffix, native.ROUTES[operation][1])

    def test_captured_create_and_validate_shapes_project(self):
        projection = native.project_cart(FIXTURE['validate_resp'], session_code=None,
                                         store_code=STORE)
        self.assertEqual(projection['session_code'],
                         FIXTURE['validate_resp']['data']['checkoutSessionCode'])
        self.assertEqual(projection['orderTotal_minor'], 3145)
        self.assertEqual(projection['orderPaymentAmount_minor'], 3145)

    def test_captured_tracking_poll_projects_placed_then_preparing(self):
        for key in ('tracking_placed', 'tracking_preparing'):
            row = FIXTURE[key]['data']
            self.assertTrue(native.seam.safe_text(row['status']))
        self.assertIn('cancel_order', {a['actionCode']
                                      for a in FIXTURE['tracking_placed']['data']['needHelpActions']})

    def test_fixture_hygiene_never_stores_card_secrets(self):
        def walk(node):
            if isinstance(node, dict):
                for key, value in node.items():
                    if key in ('paymentToken', 'id', 'clientSecret'):
                        self.assertEqual(value, '<secret>', key)
                    walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)
        walk(FIXTURE)


class GuardTests(FixtureTests):
    def test_active_order_blocks_before_any_write(self):
        flow, harness = make_flow(happy_responses(
            home={'data': {'active': [{'orderNr': SYNTHETIC_ORDER, 'status': 'placed'}]}}))
        with self.assertRaisesRegex(j.JournalError, 'ACTIVE_ORDER_PRESENT'):
            flow.guard()
        self.assertEqual([x[0] for x in harness.calls], ['home'])

    def test_existing_store_cart_blocks_adoption(self):
        carts = {'data': {'carts': [nn_state()['data']]}}
        flow, harness = make_flow(happy_responses(carts_recent=carts))
        with self.assertRaisesRegex(j.JournalError, 'STORE_CART_PRESENT'):
            flow.guard()
        self.assertEqual([x[0] for x in harness.calls], ['home', 'carts_recent'])

    def test_card_token_not_in_subscription_list_refused(self):
        flow, _ = make_flow(happy_responses(
            payment_subscription_list={'data': [{'paymentToken': 'other'}]}))
        flow.guard()
        self.assertFalse(c.corroborate_token(flow.client, flow.card))

    def test_ambiguous_saved_card_refused(self):
        cards = {'data': [{'id': 1111111111, 'ccMasked': '52287301xxxx2342',
                           'ccType': 'MASTERCARD', 'isDefault': True, 'isDeleted': False},
                          {'id': 2222222222, 'ccMasked': '111122xxxxxx2342',
                           'ccType': 'MASTERCARD', 'isDefault': False, 'isDeleted': False}]}
        flow, _ = make_flow(happy_responses(payment_cards=cards))
        with self.assertRaisesRegex(j.JournalError, 'SAVED_CARD_NOT_UNIQUE'):
            flow.guard()


class BankFixtureTests(FixtureTests):
    def setUp(self):
        super().setUp()
        p = patch('commerce_food_capture.find_bank_capture', return_value={'source_id': 123, 'source': 'msgs'})
        p.start()
        self.addCleanup(p.stop)


class LaneTests(BankFixtureTests):
    def test_prepare_sets_exact_quiet_note_before_fresh_review(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses())
            prepared = flow.prepare_only()
            calls = [op for op, _ in harness.calls]
            self.assertEqual([body for op, body in harness.calls if op == 'instructions'],
                             [{'sessionCode': 'S-SESSION-1', 'driverNotes': native.QUIET_NOTE}])
            self.assertLess(calls.index('instructions'), calls.index('cart_get'))
            self.assertTrue(prepared['prepared_only'])
            self.assertNotIn('place', calls)

    def test_fresh_readback_missing_quiet_note_blocks_place(self):
        responses = happy_responses()
        responses['cart_get']['data']['driverNotes'] = ''
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            with self.assertRaisesRegex(j.JournalError, 'NOWNOW_QUIET_NOTE_MISMATCH'):
                flow.prepare_only()
            self.assertNotIn('place', [op for op, _ in harness.calls])

    def run_to_place(self, responses, *, quantity=1):
        flow, harness = make_flow(responses, quantity=quantity)
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow.guard()
            flow.create_session()
            if quantity > 1:
                flow.set_quantity()
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
            return flow, harness, review, placed

    def test_full_lane_order_and_single_quiet_call(self):
        flow, harness, review, placed = self.run_to_place(happy_responses())
        self.assertEqual(placed['order'], SYNTHETIC_ORDER)
        self.assertEqual([x[0] for x in harness.calls],
                         ['home', 'carts_recent', 'payment_cards', 'payment_subscription_list',
                          'cart_create', 'cart_validate', 'payment', 'delivery_preference',
                          'cart_get', 'cart_get', 'place', 'track', 'order_detail'])
        preference = [p for op, p in harness.calls if op == 'delivery_preference']
        self.assertEqual(len(preference), 1)
        self.assertEqual(preference[0]['deliveryPreference'],
                         {'leave_it_at_my_door': True, 'dont_ring_the_bell': True})
        place_body = next(body for op, body in harness.calls if op == 'place')
        self.assertEqual(place_body, {'sessionCode': 'S-SESSION-1', 'total': 31.45})
        self.assertEqual(review['total_minor'], 3145)
        self.assertEqual(flow.review['payable_minor'], 3145)

    def test_quantity_two_sends_absolute_edit_product(self):
        responses = happy_responses()
        responses['cart_create'] = nn_state(qty=1.0)
        responses['product_edit'] = nn_state(qty=2.0, subtotal=2000)
        responses['cart_validate'] = nn_state(qty=2.0, subtotal=2000)
        responses['payment'] = nn_state(payment=True, qty=2.0, subtotal=2000)
        responses['delivery_preference'] = nn_state(payment=True, quiet=True, qty=2.0,
                                                    subtotal=2000)
        responses['cart_get'] = nn_state(payment=True, quiet=True, qty=2.0, subtotal=2000)
        flow, harness, review, placed = self.run_to_place(responses, quantity=2)
        edit = [p for op, p in harness.calls if op == 'product_edit']
        self.assertEqual(edit, [{'sessionCode': 'S-SESSION-1', 'productCode': PRODUCT,
                                 'qty': 2, 'notes': None, 'modifiers': {}}])
        self.assertEqual(review['total_minor'], 2000 + 645 + 450)

    def test_fee_arithmetic_anomaly_refused_before_place(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses(
                cart_validate=nn_state(total=3300),
                payment=nn_state(payment=True, total=3300)))
            flow.guard()
            flow.create_session()
            flow.validate()
            with self.assertRaisesRegex(j.JournalError, 'FEE_ARITHMETIC_OR_EXTRAS'):
                flow.guard_validated()
            self.assertNotIn('place', [x[0] for x in harness.calls])

    def test_tip_or_wallet_never_placed(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses(cart_validate=nn_state(tip=300)))
            flow.guard()
            flow.create_session()
            flow.validate()
            with self.assertRaisesRegex(j.JournalError, 'FEE_ARITHMETIC_OR_EXTRAS'):
                flow.guard_validated()
            self.assertNotIn('place', [x[0] for x in harness.calls])

    def test_wrong_address_refused_before_place(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses(cart_validate=nn_state(address='OTHER')))
            flow.guard()
            flow.create_session()
            flow.validate()
            with self.assertRaisesRegex(j.JournalError, 'ADDRESS_BINDING_MISMATCH'):
                flow.guard_validated()

    def test_payment_readback_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses(payment=nn_state(payment=False)))
            flow.guard()
            flow.create_session()
            flow.validate()
            flow.guard_validated()
            with self.assertRaisesRegex(j.JournalError, 'PAYMENT_READBACK_MISMATCH'):
                flow.select_saved_card()

    def test_quiet_readback_lost_before_place_refused(self):
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses(cart_get=nn_state(payment=True, quiet=False)))
            flow.guard()
            flow.create_session()
            flow.validate()
            flow.guard_validated()
            flow.select_saved_card()
            flow.quiet_delivery()
            flow.pre_place_read()
            with self.assertRaisesRegex(j.JournalError, 'QUIET_PREFERENCE_NOT_ACTIVE'):
                flow.review_final()
            self.assertNotIn('place', [x[0] for x in harness.calls])


class ResumeTests(BankFixtureTests):
    def prepare_partial_flow(self):
        """Run guard..quiet_delivery, then simulate a restart before place."""
        temp = tempfile.mkdtemp()
        root = patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce')
        receipts_root = patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce')
        root.start()
        receipts_root.start()
        self.addCleanup(root.stop)
        self.addCleanup(receipts_root.stop)
        flow, harness = make_flow(happy_responses())
        flow.guard()
        flow.create_session()
        flow.validate()
        flow.guard_validated()
        flow.select_saved_card()
        flow.quiet_delivery()
        return flow

    def test_resume_does_not_resend_consumed_steps(self):
        first = self.prepare_partial_flow()
        flow_id = first.flow_id
        second_responses = dict(happy_responses())
        del second_responses['cart_create']
        del second_responses['payment']
        harness = Harness(second_responses)
        resumed = c.NowNowOrderFlow.resume_active(flow_id, store_code=STORE,
                                                  product_code=PRODUCT, quantity=1,
                                                  auth=FakeAuth(), request=harness.request)
        self.assertIn('cart_get', [x[0] for x in harness.calls])
        self.assertIn('payment_cards', [x[0] for x in harness.calls])
        self.assertNotIn('cart_create', [x[0] for x in harness.calls])
        self.assertNotIn('payment', [x[0] for x in harness.calls])
        resumed.pre_place_read()
        resumed.review_final()
        placed = resumed.place()
        self.assertEqual(placed['order'], SYNTHETIC_ORDER)
        tracking = resumed.poll_tracking(sleep=lambda _: None)
        resumed.confirm_paid(tracking)
        self.assertEqual(j.inspect(flow_id)['state'], 'ACTIVE')
        self.assertEqual(j.inspect(flow_id)['order_id'], SYNTHETIC_ORDER)

    def test_resume_refuses_flow_older_than_24h(self):
        first = self.prepare_partial_flow()
        with patch.object(j, 'flow_created_at', return_value=time.time() - 25 * 3600):
            with self.assertRaisesRegex(j.JournalError, 'EXPIRED_24H'):
                c.NowNowOrderFlow.resume_active(first.flow_id, store_code=STORE,
                                                product_code=PRODUCT, quantity=1, auth=FakeAuth())

    def test_resume_refuses_foreign_manifest(self):
        first = self.prepare_partial_flow()
        with self.assertRaisesRegex(j.JournalError, 'SCOPE_MISMATCH|MANIFEST'):
            c.NowNowOrderFlow.resume_active(first.flow_id, store_code=STORE,
                                            product_code='POTHER0000000000A', quantity=1,
                                            auth=FakeAuth())


class CompletionTests(BankFixtureTests):
    def test_paid_order_completes_journal_with_tracker(self):
        temp = tempfile.mkdtemp()
        with patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(happy_responses())
            flow.guard()
            flow.create_session()
            flow.validate()
            flow.guard_validated()
            flow.select_saved_card()
            flow.quiet_delivery()
            flow.pre_place_read()
            flow.review_final()
            flow.place()
            tracking = flow.poll_tracking(sleep=lambda _: None)
            flow.confirm_paid(tracking)
            state = j.inspect(flow.flow_id)
            self.assertEqual(state['state'], 'ACTIVE')
            self.assertEqual(state['order_id'], SYNTHETIC_ORDER)
            self.assertEqual(state['reserved_minor'], 3145)
            with self.assertRaises(j.JournalError):
                j.complete(flow.flow_id)
            name = f"order-noon-{SYNTHETIC_ORDER.lower()}"
            with patch.object(c, 'WATCH_ORDERS', Path(temp).resolve() / 'orders'), \
                    patch.object(c, 'WATCH_WATCHERS', Path(temp).resolve() / 'watchers'), \
                    patch.object(c, 'WATCH_BIN', '/nonexistent/order-watch'):
                (Path(temp).resolve() / 'orders').mkdir()
                (Path(temp).resolve() / 'watchers' / name).mkdir(parents=True)
                (Path(temp).resolve() / 'orders' / f'{name}.json').write_text(json.dumps(
                    {'order': SYNTHETIC_ORDER, 'active': True}))
                (Path(temp).resolve() / 'watchers' / name / 'watcher.json').write_text(json.dumps({'ok': 1}))
                import subprocess as sp
                result = sp.CompletedProcess([], 0, stdout=json.dumps({'moni_notified': 'skipped', 'tracker_id': name, 'watcher_registered': True, 'delivery_card': {'status': 'sent'}}).encode())
                with patch.object(c.subprocess, 'run', return_value=result):
                    registration = flow.register_tracker('test label')
                self.assertTrue(registration['registered'])
            j.complete(flow.flow_id)
            self.assertEqual(j.inspect(flow.flow_id)['state'], 'COMPLETE')


class TransportEdgeTests(unittest.TestCase):
    def test_homepage_null_active_means_no_active_orders(self):
        import noon_nownow_checkout as transport
        client = transport.NowNowCheckout(
            __import__('noon_checkout').AccountHome(
                'nownow', fingerprint('a'), ADDRESS_REF, time.time()),
            header_provider=lambda *a: dict(HEADERS),
            response_cookies=lambda *a, **k: True)
        seen = []

        def request(op, headers, deadline, payload, *, response_observer, order=None):
            method, url = transport.endpoint(op, payload, order)
            response_observer(transport.ResponseObservation(url, 200, ()))
            return {'data': {'active': None, 'cart': None}}

        client._request = request
        projection = client.home().projection
        self.assertEqual(projection['active_orders'], [])


class CheckoutNoticeTests(unittest.TestCase):
    def member_row(self):
        row = nn_state(subtotal=1475, delivery=600, service_fee=600)['data']
        row['vipSingleCheckoutInfo'] = None
        row['membershipInfo'] = {
            'hasMembership': True, 'orderValue': 14.75, 'applyMinOrder': 50.0,
            'applyAfter': 35.25, 'isMovExceeded': False,
            'membershipSaving': 0.0, 'isAutoApplied': None}
        return row

    def test_existing_member_without_upsell_or_savings(self):
        c.guard_checkout_notices(self.member_row())
        c.guard_checkout_notices(nn_state()['data'])

    def test_member_prepare_reviews_exact_total_without_financial_send(self):
        responses = happy_responses()
        row = self.member_row()
        row.update(paymentMethodCode='prepaid', creditCardMask='52287301xxxx2342',
                   deliveryPreference={code: True for code in c.QUIET_FLAGS},
                   driverNotes=native.QUIET_NOTE)
        responses['cart_get'] = {'data': row}
        with tempfile.TemporaryDirectory() as temp, \
                patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
            flow, harness = make_flow(responses)
            prepared = flow.prepare_only()
            self.assertEqual(prepared['review']['total_minor'], 2675)
            flow.payment_guard()
            self.assertFalse({'place', 'payment_subscription', 'payment_complete'} &
                             {op for op, _ in harness.calls})

    def test_unknown_or_paid_membership_and_warning_refuse(self):
        mutations = [
            lambda r: r.update(checkoutWarningPopup={'title': 'Accept terms'}),
            lambda r: r.pop('checkoutWarningPopup'),
            lambda r: r.pop('vipSingleCheckoutInfo'),
            lambda r: r.update(vipSingleCheckoutInfo={'isAddedToCart': True}),
            lambda r: r.update(vipSingleCheckoutInfo={}),
            lambda r: r.update(membershipInfo=None),
        ]
        for key, value in [('hasMembership', False), ('membershipSaving', 6),
                           ('orderValue', 15), ('applyAfter', 0), ('isMovExceeded', True),
                           ('isAutoApplied', True), ('extraCharge', 24.99),
                           ('orderValue', '14.75'), ('membershipSaving', False)]:
            mutations.append(lambda r, k=key, v=value: r['membershipInfo'].update({k: v}))
        for mutate in mutations:
            row = self.member_row()
            mutate(row)
            with self.subTest(row=row), self.assertRaises(j.JournalError):
                c.guard_checkout_notices(row)

    def test_prepare_and_payment_paths_share_notice_guard(self):
        for vip in (None, {'isAddedToCart': True}):
            responses = happy_responses()
            row = responses['cart_get']['data']
            row['vipSingleCheckoutInfo'] = vip
            with tempfile.TemporaryDirectory() as temp, \
                    patch.object(j, 'ROOT', Path(temp).resolve() / 'commerce'), \
                    patch.object(c.receipts, 'ROOT', Path(temp).resolve() / 'commerce'):
                flow, harness = make_flow(responses)
                with self.assertRaisesRegex(j.JournalError, 'NOWNOW_MEMBERSHIP_'):
                    flow.prepare_only()
                self.assertFalse({'place', 'payment_subscription', 'payment_complete'} &
                                 {op for op, _ in harness.calls})
        row = self.member_row()
        row['prepaidPaymentMisc']['isCvvRequired'] = True
        flow = object.__new__(c.NowNowOrderFlow)
        flow.current = native.Snapshot({'data': row}, {}, time.time())
        flow.flow_id = 'fixture'
        with patch.object(j, 'preorder_status', return_value={'payment_confirmed': False}):
            with self.assertRaisesRegex(j.JournalError, 'NOWNOW_CVV_VERIFICATION_REQUIRED'):
                flow.payment_guard()
            row['vipSingleCheckoutInfo'] = {'isAddedToCart': True}
            loader = unittest.mock.Mock()
            with self.assertRaisesRegex(j.JournalError, 'NOWNOW_MEMBERSHIP_PURCHASE_REQUIRES_APPROVAL'):
                flow.prepare_payment(cvv_loader=loader)
            loader.assert_not_called()


if __name__ == '__main__':
    unittest.main()
