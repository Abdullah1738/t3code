"""Offline contract and failure-boundary tests; all records are synthetic."""
import hashlib
import io
import json
import time
import unittest
import urllib.error
from email.message import Message
from unittest.mock import Mock, patch

import noon_nownow_checkout as nn
from noon_checkout import AccountHome, fingerprint


HEADERS = {'cookie': 'synthetic=secret', 'x-addresscode': 'test-home',
           'x-addresskey': 'one-two-three'}
ORDER = 'NNTEST123'
DETAIL = {'status': 'success', 'data': {'orderNr': ORDER, 'orderStatusCode': 'delivered',
           'logisticsStatusCode': 'delivered', 'customerStatusCode': 'delivered'}}
STATE = {'status': 'success', 'data': {'status': 'delivered', 'orderStatusCode': 'delivered'}}
CART = {'status': 'success', 'data': {'checkoutSessionCode': 'session',
        'storeInfo': {'storeCode': 'store'}, 'products': [], 'orderTotal': 15,
        'orderPaymentAmount': 15, 'orderWalletAmount': 0, 'driverNotes': nn.QUIET_NOTE}}


class CheckoutTests(unittest.TestCase):
    def client(self, responses=None, cookies=None, receipt=None):
        responses = iter(responses or [DETAIL])
        self.calls, self.events = [], []

        def headers(operation, deadline):
            self.events.append('headers')
            return dict(HEADERS, cookie='fresh=' + str(len(self.events)))

        def request(operation, headers, deadline, payload, *, response_observer, order):
            self.events.append('send')
            self.calls.append((operation, headers, payload, order))
            _, url = nn.endpoint(operation, payload, order)
            response_observer(nn.ResponseObservation(url, 200, ('rotation=private',)))
            value = next(responses)
            if isinstance(value, Exception):
                raise value
            return value

        def cookie_sink(*args, **kwargs):
            self.events.append('cookies')
            self.cookie_args = (args, kwargs)
            return True

        home = AccountHome('nownow', 'account-ref',
            fingerprint(HEADERS['x-addresscode'], HEADERS['x-addresskey']), time.time())
        return nn.NowNowCheckout(home, header_provider=headers, request=request,
                                 receipt=receipt, response_cookies=cookies or cookie_sink)

    def test_exact_tracking_uses_fresh_headers_and_two_agreeing_resources(self):
        client = self.client([DETAIL, STATE])
        result = client.track(ORDER)
        self.assertEqual(result['status'], 'delivered')
        self.assertEqual([x[0] for x in self.calls], ['order_detail', 'track'])
        self.assertNotEqual(self.calls[0][1]['cookie'], self.calls[1][1]['cookie'])
        self.assertEqual(self.calls[0][1]['x-address-key'], 'one:two-three')
        self.assertNotIn('rotation', json.dumps(result))
        self.assertFalse(self.cookie_args[1]['outcome_journaled'])

    def test_detail_identity_mismatch_stops_second_request(self):
        client = self.client([{'data': dict(DETAIL['data'], orderNr='NNOTHER')}])
        with self.assertRaisesRegex(nn.NowNowError, 'ORDER_MISMATCH'):
            client.track(ORDER)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.events[-1], 'cookies')

    def test_conflicting_status_does_not_report_delivery(self):
        client = self.client([DETAIL, {'data': dict(STATE['data'], status='pending')}])
        self.assertEqual(client.track(ORDER)['status'], 'unknown')

    def test_failed_decode_still_hands_off_cookies(self):
        client = self.client([nn.NowNowError('INVALID_JSON')])
        with self.assertRaisesRegex(nn.NowNowError, 'INVALID_JSON'):
            client.order_status(ORDER)
        self.assertEqual(self.events, ['headers', 'send', 'cookies'])
        self.assertEqual(self.cookie_args[0][1], ('rotation=private',))

    def test_failed_cookie_sink_retains_ram_observation(self):
        client = self.client(cookies=lambda *a, **kw: False)
        with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_COOKIES_FAILED'):
            client.order_status(ORDER)
        self.assertEqual(len(client._pending_observations), 1)
        self.assertTrue(client._mutation_fenced)
        self.assertNotIn('private', repr(client._pending_observations))

    def test_native_mutations_dispatch_exact_bodies_and_journal_each(self):
        receipts = []
        client = self.client([CART] * 6 + [{'data': {'session': None, 'order': {'orderNr': ORDER}}},
                            {'status': 'PAYMENT_PENDING'}], receipt=lambda r: receipts.append(r) or True)
        before = Mock(return_value=True)
        card = nn.SavedCard('fake-token', 'xxxx 2342', 'mastercard')
        operations = [
            lambda: client.get_cart('store', before_send=before),
            lambda: client.create_cart(store_code='store', product_code='product', modifiers={}, before_send=before),
            lambda: client.add_product(session_code='session', product_code='product',
                                       quantity=2, modifiers={'flavor': ['vanilla']}, notes=None, before_send=before),
            lambda: client.set_quiet_notes(session_code='session', before_send=before),
            lambda: client.set_delivery_preference(session_code='session',
                preferences={'leavedoor': True, 'dontring': True, 'other': None}, before_send=before),
            lambda: client.set_payment_method(session_code='session', card=card, before_send=before),
            lambda: client.place_order(session_code='session', order_payment_minor=1500, before_send=before),
            lambda: client.complete_payment(order=ORDER, client_secret='fake-intent', card=card,
                cvv_encryption={'encCvv': 'fake-ciphertext', 'publicKeyName': 'fake-key'}, before_send=before),
        ]
        for operation in operations:
            operation()
        self.assertEqual(len(receipts), 8)
        self.assertEqual(before.call_count, 8)
        self.assertEqual(self.calls[2][2], {'sessionCode': 'session', 'productCode': 'product',
            'qty': 2, 'notes': None, 'modifiers': {'flavor': ['vanilla']}})
        self.assertEqual(self.calls[4][2]['deliveryPreference'],
                         {'leavedoor': True, 'dontring': True, 'other': None})
        self.assertEqual(receipts[6]['outcome'], 'ORDER_ID_RECEIVED')
        self.assertEqual(receipts[6]['order_id'], ORDER)
        self.assertEqual(receipts[7]['outcome'], 'RESPONSE_RECEIVED')
        self.assertTrue(all('fake-token' not in json.dumps(r) for r in receipts))
        with self.assertRaisesRegex(nn.NowNowError, 'PLACE_ALREADY_ATTEMPTED'):
            client.place_order(session_code='session', order_payment_minor=1500, before_send=before)
        with self.assertRaisesRegex(nn.NowNowError, 'PAYMENT_ALREADY_ATTEMPTED'):
            operations[-1]()

    def test_wrong_address_or_stale_home_prevents_request(self):
        client = self.client()
        client._home = AccountHome('nownow', 'account', 'other-address', time.time())
        with self.assertRaisesRegex(nn.NowNowError, 'ADDRESS_BINDING_MISMATCH'):
            client.order_status(ORDER)
        client._home = AccountHome('nownow', 'account', 'other-address', time.time() - 121)
        with self.assertRaisesRegex(nn.NowNowError, 'VERIFIED_ACCOUNT_REQUIRED'):
            client.order_status(ORDER)
        self.assertEqual(self.calls, [])

    def test_endpoint_has_no_arbitrary_body_or_order_escape(self):
        for operation, body, order in [
            ('order_detail', {'orderNr': ORDER, 'force': True}, ORDER),
            ('track', None, ORDER + '/elsewhere'),
            ('https://example.invalid', {}, None),
            ('orders', {'page': 2}, None),
        ]:
            with self.assertRaises(nn.NowNowError):
                nn.endpoint(operation, body, order)

    def test_mutation_journal_order_and_failed_receipt_recovery(self):
        # Fault-inject mutation classification onto a REAL read route to exercise
        # the dormant journal pipeline without inventing a mutation endpoint.
        receipts = []

        def receipt(record):
            self.events.append('receipt')
            receipts.append(record)
            return False

        client = self.client(receipt=receipt)

        def reserve(operation, digest):
            self.events.append('reserve')
            self.assertEqual(digest, hashlib.sha256(nn.seam._json({'orderNr': ORDER})).hexdigest())
            return True

        with patch.object(nn, 'WRITES', frozenset({'order_detail'})):
            with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_RECEIPT_FAILED') as ctx:
                client._call('order_detail', {'orderNr': ORDER}, 12, reserve, order=ORDER,
                             project=lambda data: nn.project_order(data, ORDER))
        self.assertEqual(self.events, ['headers', 'reserve', 'send', 'receipt', 'cookies'])
        self.assertTrue(ctx.exception.may_have_sent)
        self.assertFalse(ctx.exception.outcome_journaled)
        self.assertEqual(ctx.exception.receipt, receipts[0])
        self.assertEqual(receipts[0]['outcome'], 'RESPONSE_RECEIVED')
        self.assertNotIn('private', json.dumps(receipts))
        self.assertNotIn('cookie', json.dumps(receipts))
        self.assertTrue(client._mutation_fenced)

    def test_journal_denial_and_missing_receipt_prevent_dispatch(self):
        client = self.client(receipt=lambda record: True)
        with patch.object(nn, 'WRITES', frozenset({'order_detail'})):
            with self.assertRaisesRegex(nn.NowNowError, 'SEND_RESERVATION_DENIED'):
                client._call('order_detail', {'orderNr': ORDER}, 12, lambda *a: False, order=ORDER)
            client._receipt = None
            with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_RECEIPT_REQUIRED'):
                client._call('order_detail', {'orderNr': ORDER}, 12, lambda *a: True, order=ORDER)
        self.assertEqual(self.calls, [])

    def test_unknown_decode_outcome_is_journaled_before_cookie_retention(self):
        records = []

        def receipt(record):
            self.events.append('receipt')
            records.append(record)
            return True

        client = self.client([nn.NowNowError('INVALID_JSON')], receipt=receipt)
        with patch.object(nn, 'WRITES', frozenset({'order_detail'})):
            with self.assertRaisesRegex(nn.NowNowError, 'INVALID_JSON') as ctx:
                client._call('order_detail', {'orderNr': ORDER}, 12, lambda *a: True, order=ORDER)
            with self.assertRaisesRegex(nn.NowNowError, 'MUTATION_FENCED'):
                client._call('order_detail', {'orderNr': ORDER}, 12, lambda *a: True, order=ORDER)
        self.assertEqual(self.events, ['headers', 'send', 'receipt', 'cookies'])
        self.assertTrue(ctx.exception.outcome_journaled)
        self.assertTrue(self.cookie_args[1]['outcome_journaled'])
        self.assertEqual(records[0]['outcome'], 'UNKNOWN')
        self.assertEqual(records[0]['error_code'], 'INVALID_JSON')

    def test_transport_cannot_skip_response_observation(self):
        client = self.client()
        client._request = lambda *a, **kw: DETAIL
        with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_OBSERVATION_REQUIRED'):
            client.order_status(ORDER)

    def test_header_provider_failure_is_redacted_before_dispatch(self):
        client = self.client()
        client._header_provider = Mock(side_effect=RuntimeError('secret cookie'))
        with self.assertRaisesRegex(nn.NowNowError, '^AUTH_HEADERS_FAILED$'):
            client.order_status(ORDER)
        self.assertEqual(self.calls, [])

    def test_payment_payload_does_not_copy_minutes_provider_or_total_fields(self):
        card = nn.SavedCard('fake-token', 'xxxx 2342', 'mastercard')
        selected = nn.payment_payload('session', card)
        self.assertEqual(selected['paymentMethodCode'], 'prepaid')
        self.assertEqual(selected['prepaid_payment_method_code'], 'cc_noonpay')
        self.assertEqual(nn.place_payload('session', 1234), {'sessionCode': 'session', 'total': 12.34})
        completed = nn.payment_complete_payload('fake-intent', card,
            {'encCvv': 'fake-ciphertext', 'publicKeyName': 'key'})
        self.assertEqual(set(completed), {'clientSecret', 'cvvEncryption', 'paymentMethodCode', 'idCustomerToken'})
        with self.assertRaisesRegex(nn.NowNowError, 'ENCRYPTED_CVV_REQUIRED'):
            nn.payment_complete_payload('fake-intent', card, '123')

    def test_order_history_duplicates_rejected_and_coverage_bounded(self):
        result = nn.project_orders({'data': {'orders': [DETAIL['data']]}})
        self.assertFalse(result['complete_history'])
        with self.assertRaisesRegex(nn.NowNowError, 'DUPLICATE_ORDER_ID'):
            nn.project_orders({'data': {'orders': [DETAIL['data'], DETAIL['data']]}})

    def test_real_mutation_decode_failure_is_unknown_and_fences_retry(self):
        records = []
        client = self.client([nn.NowNowError('INVALID_JSON')], receipt=lambda r: records.append(r) or True)
        with self.assertRaisesRegex(nn.NowNowError, 'INVALID_JSON') as ctx:
            client.set_quiet_notes(session_code='session', before_send=lambda *a: True)
        self.assertTrue(ctx.exception.may_have_sent)
        self.assertEqual(records[0]['outcome'], 'UNKNOWN')
        self.assertTrue(self.cookie_args[1]['outcome_journaled'])
        with self.assertRaisesRegex(nn.NowNowError, 'MUTATION_FENCED'):
            client.set_quiet_notes(session_code='session', before_send=lambda *a: True)

    def test_cart_session_and_store_mismatch_are_not_success(self):
        for kwargs in ({'session_code': 'different'}, {'store_code': 'different'}):
            with self.assertRaises(nn.NowNowError):
                nn.project_cart(CART, **kwargs)

    def test_validate_once_journaled_same_session_readback_then_native_shallow_merge(self):
        records = []
        fresh = {'status': 'success', 'data': dict(CART['data'], orderPaymentAmount=17,
                 prepaidPaymentMisc={'isCvvRequired': True}, checkoutWarningPopup=None)}
        def receipt(record):
            self.events.append('receipt')
            records.append(record)
            return True
        client = self.client([fresh], receipt=receipt)
        def reserve(operation, digest):
            self.events.append('reserve')
            self.assertEqual(operation, 'cart_validate')
            self.assertEqual(digest, hashlib.sha256(nn.seam._json({'sessionCode': 'session'})).hexdigest())
            return True
        snap = client.validate_cart('session', store_code='store', before_send=reserve)
        self.assertEqual(self.events, ['headers', 'reserve', 'send', 'receipt', 'cookies'])
        self.assertEqual(self.calls[0][2], {'sessionCode': 'session'})
        self.assertEqual(snap.projection['orderPaymentAmount_minor'], 1700)
        self.assertFalse(snap.projection['complete_review'])
        self.assertEqual(records[0]['outcome'], 'RESPONSE_RECEIVED')
        self.assertTrue(self.cookie_args[1]['outcome_journaled'])
        current = dict(CART['data'], localOnly='preserved', checkoutWarningPopup={'old': True},
                       prepaidPaymentMisc={'isCvvRequired': False, 'stale': True})
        merged = nn.merge_validated_basket(current, snap.wire['data'], session_code='session')
        self.assertEqual(merged['localOnly'], 'preserved')
        self.assertEqual(merged['prepaidPaymentMisc'], {'isCvvRequired': True})
        self.assertIsNone(merged['checkoutWarningPopup'])
        merged['prepaidPaymentMisc']['isCvvRequired'] = False
        self.assertTrue(snap.wire['data']['prepaidPaymentMisc']['isCvvRequired'])
        with self.assertRaisesRegex(nn.NowNowError, 'VALIDATE_ALREADY_ATTEMPTED'):
            client.validate_cart('session', before_send=reserve)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(records), 1)

    def test_validate_unknown_or_wrong_identity_fences_all_writes_without_replay(self):
        cases = [({'status': 'success', 'data': {}}, 'INVALID_IDENTIFIER'),
                 ({'data': dict(CART['data'], products={})}, 'PRODUCTS_SCHEMA_CHANGED'),
                 ({'data': dict(CART['data'], checkoutSessionCode='other')}, 'SESSION_MISMATCH'),
                 ({'data': dict(CART['data'], storeInfo={'storeCode': 'other'})}, 'STORE_MISMATCH'),
                 (nn.NowNowError('REQUEST_TIMEOUT'), 'REQUEST_TIMEOUT')]
        for response, code in cases:
            with self.subTest(code=code):
                records = []
                client = self.client([response], receipt=lambda r: records.append(r) or True)
                with self.assertRaisesRegex(nn.NowNowError, code) as ctx:
                    client.validate_cart('session', store_code='store', before_send=lambda *a: True)
                self.assertTrue(ctx.exception.may_have_sent)
                self.assertEqual(records[0]['outcome'], 'UNKNOWN')
                self.assertTrue(client._mutation_fenced)
                with self.assertRaisesRegex(nn.NowNowError, 'VALIDATE_ALREADY_ATTEMPTED'):
                    client.validate_cart('session', before_send=lambda *a: True)
                with self.assertRaisesRegex(nn.NowNowError, 'MUTATION_FENCED'):
                    client.set_quiet_notes(session_code='session', before_send=lambda *a: True)
                self.assertEqual(len(self.calls), 1)

    def test_validation_denied_reservation_is_not_consumed_and_new_instance_needs_journal(self):
        client = self.client([CART], receipt=lambda r: True)
        with self.assertRaisesRegex(nn.NowNowError, 'SEND_RESERVATION_DENIED'):
            client.validate_cart('session', before_send=lambda *a: False)
        self.assertEqual(self.calls, [])
        client.validate_cart('session', before_send=lambda *a: True)
        client = self.client([CART], receipt=lambda r: True)
        with self.assertRaisesRegex(nn.NowNowError, 'SEND_RESERVATION_DENIED'):
            client.validate_cart('session', before_send=lambda *a: False)
        self.assertEqual(self.calls, [])

    def test_validation_receipt_failure_keeps_cookie_handoff_and_no_replay(self):
        client = self.client([CART], receipt=lambda r: False)
        with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_RECEIPT_FAILED'):
            client.validate_cart('session', before_send=lambda *a: True)
        self.assertFalse(self.cookie_args[1]['outcome_journaled'])
        with self.assertRaisesRegex(nn.NowNowError, 'VALIDATE_ALREADY_ATTEMPTED'):
            client.validate_cart('session', before_send=lambda *a: True)
        self.assertEqual(len(self.calls), 1)

    def test_merge_cannot_hide_malformed_or_cross_session_validation(self):
        for fresh in ({}, {'checkoutSessionCode': 'session'},
                      dict(CART['data'], checkoutSessionCode='other'),
                      dict(CART['data'], storeInfo={'storeCode': 'other'})):
            with self.assertRaises(nn.NowNowError):
                nn.merge_validated_basket(CART['data'], fresh, session_code='session')

    def test_challenge_keeps_private_url_and_fences_mutations(self):
        records = []
        client = self.client([{'status': 'REDIRECT_REQUIRED', 'redirect_url': 'https://challenge.invalid/private'}],
                             receipt=lambda r: records.append(r) or True)
        snap = client.complete_payment(order=ORDER, client_secret='private-intent',
            card=nn.SavedCard('fake-token', 'xxxx 2342', 'mastercard'),
            cvv_encryption={'encCvv': 'fake', 'publicKeyName': 'key'}, before_send=lambda *a: True)
        self.assertEqual(records[0]['outcome'], 'CHALLENGE_REQUIRED')
        self.assertTrue(client._mutation_fenced)
        self.assertNotIn('challenge.invalid', json.dumps(records) + repr(snap))

    def test_exact_production_route_literals(self):
        self.assertEqual(nn.MP_BASE, 'https://api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/')
        self.assertEqual(nn.PAYMENT_BASE, 'https://api-app-st.noon.com/_svc/mp-payment-api-public/')
        expected = {'cart_get': 'v1/session/active', 'cart_create': 'v1/session/create',
                    'cart_validate': 'v1/session/validate',
                    'product_edit': 'v1/session/edit-product', 'instructions': 'v1/session/add-notes',
                    'delivery_preference': 'v1/session/set-delivery-preference',
                    'payment': 'v1/session/edit-payment', 'place': 'v1/order/place-order'}
        for operation, suffix in expected.items():
            self.assertEqual(nn.ROUTES[operation][:2], ('POST', nn.MP_BASE + suffix))

    def test_subscription_secret_stays_private_and_address_is_bound(self):
        records = []
        client = self.client([{'status': 'success', 'data': 'private-intent'}],
                             receipt=lambda r: records.append(r) or True)
        card = nn.SavedCard('fake-token', 'xxxx 2342', 'mastercard')
        with self.assertRaisesRegex(nn.NowNowError, 'ADDRESS_BINDING_MISMATCH'):
            client.create_payment_subscription(address_code='other', address_version=1,
                card=card, before_send=lambda *a: True)
        snap = client.create_payment_subscription(address_code='test-home', address_version=1,
            card=card, before_send=lambda *a: True)
        self.assertEqual(snap.wire['data'], 'private-intent')
        self.assertNotIn('private-intent', repr(snap) + json.dumps(records))

    def test_create_response_only_requires_evidenced_session_identifier(self):
        client = self.client([{'data': {'checkoutSessionCode': 'session'}}], receipt=lambda r: True)
        snap = client.create_cart(store_code='store', product_code='product', modifiers={},
                                  before_send=lambda *a: True)
        self.assertEqual(snap.projection['state'], 'active_cart_readback_required')
        self.assertFalse(snap.projection['store_identity_echoed'])

    def test_preorder_payment_continuation_does_not_invent_wire_binding(self):
        client = self.client([{'status': 'PAYMENT_PENDING'}], receipt=lambda r: True)
        client.complete_payment(order=None, session_code='session', client_secret='intent',
            card=nn.SavedCard('fake-token', 'xxxx 2342', 'mastercard'),
            cvv_encryption={'encCvv': 'fake', 'publicKeyName': 'key'}, before_send=lambda *a: True)
        self.assertNotIn('sessionCode', self.calls[0][2])
        self.assertNotIn('orderNr', self.calls[0][2])

    def test_place_receipt_keeps_order_id_even_if_application_projection_fails(self):
        records = []
        client = self.client([{'success': False, 'data': {'session': None, 'order': {'orderNr': ORDER}}}],
                             receipt=lambda r: records.append(r) or True)
        with self.assertRaisesRegex(nn.NowNowError, 'APPLICATION_REJECTED'):
            client.place_order(session_code='session', order_payment_minor=1500,
                               before_send=lambda *a: True)
        self.assertEqual(records[0]['order_id'], ORDER)
        self.assertEqual(records[0]['outcome'], 'UNKNOWN')

    def test_real_place_receipt_failure_blocks_resend_and_hands_off_rotation(self):
        client = self.client([{'data': {'session': None, 'order': {'orderNr': ORDER}}}], receipt=lambda r: False)
        with self.assertRaisesRegex(nn.NowNowError, 'RESPONSE_RECEIPT_FAILED') as ctx:
            client.place_order(session_code='session', order_payment_minor=1500,
                               before_send=lambda *a: True)
        self.assertEqual(ctx.exception.receipt['order_id'], ORDER)
        self.assertFalse(self.cookie_args[1]['outcome_journaled'])
        with self.assertRaisesRegex(nn.NowNowError, 'PLACE_ALREADY_ATTEMPTED'):
            client.place_order(session_code='session', order_payment_minor=1500,
                               before_send=lambda *a: True)


class NativeTransportTests(unittest.TestCase):
    def test_validate_exact_wire_body_and_no_boolean_or_force_escape(self):
        body = {'sessionCode': 'session'}
        url = 'https://api-app-fd.noon.com/_svc/mp-shop-api-mpnoon/v1/session/validate'
        response = Mock()
        response.code, response.headers = 200, Message()
        response.geturl.return_value = url
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(CART).encode()
        opener = Mock()
        opener.open.return_value = response
        observations = []
        with patch.object(nn.urllib.request, 'build_opener', return_value=opener):
            result = nn.native_request('cart_validate', HEADERS, time.monotonic() + 10,
                                      body, response_observer=observations.append)
        sent = opener.open.call_args.args[0]
        self.assertEqual(sent.full_url, url)
        self.assertEqual(sent.get_method(), 'POST')
        self.assertEqual(json.loads(sent.data), body)
        self.assertEqual(result, CART)
        self.assertEqual(len(observations), 1)
        self.assertEqual(opener.open.call_count, 1)
        for key in ('force', 'validate', 'place_order', 'isPlaceOrder'):
            with self.assertRaisesRegex(nn.NowNowError, 'INVALID_PAYLOAD'):
                nn.endpoint('cart_validate', dict(body, **{key: True}))

    def test_cookies_observed_before_invalid_body_decode(self):
        events = []
        headers = Message()
        headers.add_header('Set-Cookie', 'a=1; Expires=Thu, 01 Jan 2027 00:00:00 GMT')
        headers.add_header('Set-Cookie', 'b=2')
        url = nn.endpoint('order_detail', {'orderNr': ORDER}, ORDER)[1]
        response = Mock()
        response.code, response.headers = 200, headers
        response.geturl.return_value = url
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.side_effect = lambda *a: events.append('read') or b'{invalid'
        opener = Mock()
        opener.open.return_value = response

        def observe(value):
            events.append('observe')
            self.assertEqual(len(value.set_cookies), 2)
            self.assertIn('Thu, 01', value.set_cookies[0])

        with patch.object(nn.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(nn.NowNowError, 'INVALID_JSON'):
                nn.native_request('order_detail', HEADERS, time.monotonic() + 10,
                    {'orderNr': ORDER}, response_observer=observe, order=ORDER)
        self.assertEqual(events, ['observe', 'read'])
        sent = opener.open.call_args.args[0]
        self.assertEqual(sent.full_url, url)
        self.assertNotIn('prodapi', sent.full_url)

    def test_http_error_preserves_rotation_and_redacts_exception(self):
        url = nn.endpoint('orders', {})[1]
        headers = Message()
        headers.add_header('Set-Cookie', 'rotation=secret')
        error = urllib.error.HTTPError(url, 401, 'secret server text', headers, io.BytesIO(b'secret'))
        opener = Mock()
        opener.open.side_effect = error
        observed = []
        with patch.object(nn.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(nn.NowNowError, '^AUTH_EXPIRED$'):
                nn.native_request('orders', HEADERS, time.monotonic() + 10, {},
                                  response_observer=observed.append)
        self.assertEqual(observed[0].set_cookies, ('rotation=secret',))
        self.assertEqual(observed[0].http_status, 401)


if __name__ == '__main__':
    unittest.main()
