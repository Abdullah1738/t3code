import copy
from email.message import Message
import gzip
import io
import json
import time
import unittest
import urllib.error
from unittest.mock import patch

import noon_marketplace_checkout as m


COOKIES = ('sid=synthetic-one; Path=/; Secure',
           'sid=synthetic-two; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/')


class Harness:
    def __init__(self, *, service='main', native=False):
        self.events, self.calls, self.receipts, self.cookies = [], [], [], []
        self.data = {}
        self.status = 200
        self.header_generation = 0
        self.client = m.MarketplaceClient(service, header_provider=self.headers,
            before_send=self.reserve, receipt=self.receipt, response_cookies=self.retain,
            request=m.native_request if native else self.request)

    def headers(self, op, deadline):
        self.events.append('headers')
        self.header_generation += 1
        return {'Cookie': 'synthetic=' + str(self.header_generation), 'X-Experience': 'wrong'}

    def reserve(self, record):
        self.events.append('reserve')
        return True

    def receipt(self, record):
        self.events.append('receipt')
        self.receipts.append(copy.deepcopy(record))
        return True

    def retain(self, name, cookies, **metadata):
        self.events.append('cookies')
        self.cookies.append((name, cookies, metadata))
        return True

    def request(self, op, headers, deadline, *, response_observer):
        self.events.append('wire')
        self.calls.append((op, dict(headers)))
        response_observer(m.ResponseObservation('https://' + op.host + op.path, self.status, COOKIES))
        if isinstance(self.data, Exception):
            raise self.data
        return copy.deepcopy(self.data)

    def bind(self, order='NTEST1', secret='synthetic-secret'):
        self.data = {'status': 'pending', 'clientSecret': secret}
        self.client.order_status(order)
        self.data = {'status': 'payment_confirmed'}


class WireResponse:
    def __init__(self, op, body, events, status=200):
        self.url = 'https://' + op.host + op.path
        self.code = status
        self.body, self.events = body, events
        self.headers = Message()
        for value in COOKIES:
            self.headers.add_header('Set-Cookie', value)

    def geturl(self):
        return self.url

    def read(self, limit):
        self.events.append('read')
        if isinstance(self.body, Exception):
            raise self.body
        return self.body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class MarketplaceTests(unittest.TestCase):
    def test_expired_checkout_order_has_specific_error_without_retaining_body(self):
        body = {'error': {'message': 'Order not found', 'code': 404},
                'private': 'must-not-be-retained'}
        for service in ('main', 'supermall'):
            for compressed in (False, True):
                with self.subTest(service=service, compressed=compressed):
                    h = Harness(service=service, native=True)
                    op = m.operation(service, 'order_status', order='NTEST1')
                    raw = json.dumps(body).encode()
                    response = WireResponse(op, raw, h.events, 400)
                    error = urllib.error.HTTPError(response.url, 400, 'Bad Request',
                        response.headers, io.BytesIO(gzip.compress(raw) if compressed else raw))
                    with patch.object(m.urllib.request, 'build_opener') as build:
                        build.return_value.open.side_effect = error
                        exc = self.assert_code('CHECKOUT_ORDER_NOT_FOUND',
                                               lambda: h.client.order_status('NTEST1'))
                        self.assertEqual(build.return_value.open.call_count, 1)
                    self.assertEqual(exc.http_status, 400)
                    self.assertFalse(exc.may_have_sent)
                    self.assertEqual(h.cookies[0][1], COOKIES)
                    self.assertEqual(h.receipts, [])
                    self.assertNotIn('must-not-be-retained', repr(vars(exc)))

    def test_other_http_errors_never_become_expired_checkout_evidence(self):
        missing = {'error': {'message': 'Order not found', 'code': 404}}
        cases = [('cart', {}, 400, missing), ('session', {}, 400, missing),
                 ('place', {'total': 1}, 400, missing),
                 ('order_status', {'order': 'NTEST1'}, 404, missing),
                 ('order_status', {'order': 'NTEST1'}, 400, {'error': {'code': 404}}),
                 ('order_status', {'order': 'NTEST1'}, 400,
                  {'error': {'message': 'Order not found', 'code': '404'}}),
                 ('order_status', {'order': 'NTEST1'}, 400, b'{broken'),
                 ('order_status', {'order': 'NTEST1'}, 400, b'x' * (m.MAX_BYTES + 1))]
        for name, args, status, body in cases:
            with self.subTest(name=name, status=status):
                h = Harness(native=True)
                op = m.operation('main', name, **args)
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                response = WireResponse(op, raw, h.events, status)
                with patch.object(m.urllib.request, 'build_opener') as build:
                    build.return_value.open.side_effect = urllib.error.HTTPError(
                        response.url, status, 'Bad Request', response.headers, io.BytesIO(raw))
                    self.assert_code('HTTP_' + str(status), lambda: h.client.call(name, **args))
                    self.assertEqual(build.return_value.open.call_count, 1)

    def test_populated_native_groups_are_not_discarded_for_top_level_empty_items(self):
        body={'count':1,'offers':[{'offerCode':'offer'}],'items':[],
              'groups':[{'items':[{'offerCode':'offer','variantKey':'','quantity':1,'isSelectedForCheckout':True}]}]}
        result=m.cart_projection(body)
        self.assertFalse(result['empty'])
        self.assertEqual(result['items'][0]['offerCode'],'offer')

    def assert_code(self, code, fn):
        with self.assertRaises(m.MarketplaceError) as raised:
            fn()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_native_route_and_body_contract(self):
        self.assertEqual(m.operation('main', 'cart').path, '/_svc/cart-v1/cart?isPageCart=false')
        add = m.operation('supermall', 'add', offer='offer:1', quantity=2, store_code='rocket-store')
        self.assertEqual(add.path, '/_svc/cart-v1/cart/item/offer%3A1/2?showCart&isPageCart=false')
        self.assertEqual(json.loads(add.body), {'storeCode': 'rocket-store'})
        qty = m.operation('main', 'quantity', offer='offer', quantity=2, is_page_cart=True, variant_key='')
        self.assertEqual(qty.method, 'PUT')
        self.assertEqual(qty.path, '/_svc/cart-v1/cart/item/offer/2?showCart=true&isPageCart=true&variantKey=')
        self.assertIsNone(qty.body)
        self.assertEqual(json.loads(m.operation('main', 'session', should_update_session=False).body),
                         {'shouldUpdateSession': False})
        self.assertTrue(m.operation('main', 'session').mutation)
        self.assertEqual(json.loads(m.operation('main', 'place', total=12.34).body), {'total': 12.34})
        pay = m.operation('main', 'payment_complete', order='NTEST1', client_secret='secret', card_token='token')
        self.assertEqual(pay.host, 'api-app-st.noon.com')
        self.assertEqual(json.loads(pay.body), {'orderNumber': 'NTEST1', 'clientSecret': 'secret',
                                                  'paymentMethodCode': 'cc_noonpay', 'idCustomerToken': 'token'})
        status = m.operation('main', 'payment_status', order='NTEST1', client_secret='secret')
        self.assertEqual(json.loads(status.body), {'clientSecret': 'secret'})
        self.assertFalse(status.mutation)

    def test_full_selection_preserves_other_rows(self):
        rows = [{'offerCode': 'a', 'variantKey': '', 'isSelected': False},
                {'offerCode': 'b', 'variantKey': 'v', 'isSelected': True}]
        result = m.selection_payload({'partialCheckout': {'selectableOffers': rows}}, {('a', ''): True})
        self.assertEqual(result[1], rows[1])
        self.assertTrue(result[0]['isSelected'])
        self.assertFalse(rows[0]['isSelected'])

    def test_fresh_headers_every_operation_and_experience_binding(self):
        for service, experience in [('main', 'ecom'), ('supermall', 'rocket')]:
            h = Harness(service=service)
            h.client.cart()
            h.client.cart()
            self.assertEqual([headers['cookie'] for _, headers in h.calls], ['synthetic=1', 'synthetic=2'])
            self.assertEqual(h.calls[0][1]['x-experience'], experience)
            self.assertEqual(h.calls[0][1]['x-mp'], 'noon')
            self.assertEqual(h.receipts, [])
            self.assertFalse(h.cookies[0][2]['outcome_journaled'])

    def test_stale_auth_prevents_reservation_and_wire(self):
        h = Harness()
        def stale(*_):
            raise RuntimeError('private stale snapshot')
        h.client._header_provider = stale
        self.assert_code('AUTH_HEADERS_FAILED', h.client.session)
        self.assertEqual(h.calls, [])
        self.assertNotIn('reserve', h.events)

    def test_stale_review_denial_prevents_wire(self):
        h = Harness()
        h.client._before_send = lambda _: False
        self.assert_code('PARENT_JOURNAL_RESERVATION_DENIED', h.client.session)
        self.assertEqual(h.calls, [])
        self.assertEqual(h.receipts, [])

    def test_missing_required_hooks(self):
        self.assert_code('HEADER_PROVIDER_REQUIRED', lambda: m.MarketplaceClient('main', header_provider=None))
        for attr, code in [('_receipt', 'RESPONSE_RECEIPT_REQUIRED'),
                           ('_before_send', 'PARENT_JOURNAL_REQUIRED'),
                           ('_response_cookies', 'RESPONSE_COOKIES_REQUIRED')]:
            h = Harness()
            setattr(h.client, attr, None)
            self.assert_code(code, h.client.session)
            self.assertEqual(h.calls, [])

    def test_mutation_receipt_precedes_cookie_retention(self):
        h = Harness()
        h.client.session()
        self.assertEqual(h.events, ['headers', 'reserve', 'wire', 'receipt', 'cookies'])
        self.assertEqual(h.cookies[0][1], COOKIES)
        self.assertTrue(h.cookies[0][2]['outcome_journaled'])
        receipt = dict(h.receipts[0])
        evidence_hash = receipt.pop('evidence_hash')
        self.assertEqual(evidence_hash, m.fingerprint(receipt))
        self.assertEqual(receipt['outcome'], 'RESPONSE_RECEIVED')
        self.assertNotIn('synthetic', json.dumps(receipt))

    def test_parse_status_and_read_failures_retain_rotation_after_receipt(self):
        cases = [(b'{broken', 200, 'INVALID_RESPONSE'),
                 (OSError('private transport error'), 200, 'TRANSPORT_OUTCOME_UNKNOWN'),
                 (b'{broken', 401, 'AUTH_EXPIRED'),
                 (b'{}', 403, 'AUTH_FORBIDDEN'), (b'{}', 429, 'RATE_LIMITED')]
        for body, status, code in cases:
            with self.subTest(status=status, code=code):
                h = Harness(native=True)
                op = m.operation('main', 'session')
                response = WireResponse(op, body, h.events, status)
                with patch.object(m.urllib.request, 'build_opener') as build:
                    if status >= 400:
                        build.return_value.open.side_effect = urllib.error.HTTPError(
                            response.url, status, 'private error', response.headers, io.BytesIO(b'bad'))
                    else:
                        build.return_value.open.return_value = response
                    exc = self.assert_code(code, h.client.session)
                    self.assertEqual(build.return_value.open.call_count, 1)
                self.assertEqual(h.events[-2:], ['receipt', 'cookies'])
                self.assertEqual(h.cookies[0][1], COOKIES)
                self.assertEqual(h.cookies[0][2]['http_status'], status)
                self.assertTrue(exc.may_have_sent)
                self.assertEqual(exc.receipt['outcome'], 'UNKNOWN')
                self.assert_code('MUTATION_FENCED', lambda: h.client.call('address', address_key='other'))

    def test_observer_runs_before_body_read_even_when_read_fails(self):
        op = m.operation('main', 'cart')
        events = []
        response = WireResponse(op, OSError('read'), events)
        def observe(value):
            events.append('observe')
            self.assertEqual(value.set_cookies, COOKIES)
        with patch.object(m.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = response
            with self.assertRaises(OSError):
                m.native_request(op, {'cookie': 'synthetic'}, time.monotonic() + 10, response_observer=observe)
        self.assertEqual(events, ['observe', 'read'])

    def test_bad_read_retains_cookies_without_mutation_receipt(self):
        h = Harness()
        h.data = m.MarketplaceError('INVALID_RESPONSE')
        self.assert_code('INVALID_RESPONSE', h.client.cart)
        self.assertEqual(h.receipts, [])
        self.assertEqual(h.cookies[0][1], COOKIES)
        self.assertFalse(h.cookies[0][2]['outcome_journaled'])

    def test_receipt_failure_delivers_ram_cookies_and_fences(self):
        h = Harness()
        def broken(record):
            h.events.append('receipt')
            raise RuntimeError('private sink failure')
        h.client._receipt = broken
        exc = self.assert_code('RESPONSE_RECEIPT_FAILED', h.client.session)
        self.assertEqual(h.events[-2:], ['receipt', 'cookies'])
        self.assertFalse(h.cookies[0][2]['outcome_journaled'])
        self.assertEqual(exc.receipt['outcome'], 'RESPONSE_RECEIVED')
        self.assert_code('MUTATION_FENCED', h.client.session)

    def test_cookie_failure_fences_after_durable_receipt(self):
        h = Harness()
        h.client._response_cookies = lambda *a, **kw: False
        exc = self.assert_code('RESPONSE_COOKIES_FAILED', h.client.session)
        self.assertTrue(exc.outcome_journaled)
        self.assert_code('MUTATION_FENCED', h.client.session)

    def test_no_response_unknown_receipt_and_no_retry(self):
        h = Harness()
        def timeout(*args, **kwargs):
            h.events.append('wire')
            raise TimeoutError('private timeout')
        h.client._request = timeout
        exc = self.assert_code('TRANSPORT_OUTCOME_UNKNOWN', h.client.session)
        self.assertIsNone(exc.receipt['http_status'])
        self.assertEqual(h.cookies, [])
        self.assert_code('MUTATION_FENCED', h.client.session)
        self.assertEqual(h.events.count('wire'), 1)

    def test_success_cannot_repeat_mutation_or_place_with_changed_total(self):
        h = Harness()
        h.client.session()
        self.assert_code('MUTATION_ALREADY_CONSUMED', h.client.session)
        h.data = 'NTEST1'
        result = h.client.call('place', total=12)
        self.assertEqual(result.summary()['order'], 'NTEST1')
        self.assertFalse(result.summary()['purchase_confirmed'])
        self.assertEqual(h.receipts[-1]['order_id'], 'NTEST1')
        self.assert_code('MUTATION_ALREADY_CONSUMED', lambda: h.client.call('place', total=13))
        self.assertEqual(len(h.calls), 2)

    def test_exact_scalar_place_order_id_only(self):
        for data in [{'orderNr': 'NTEST1'}, ['NTEST1'], 123, 'NNTEST1', 'NTEST1\n', 'ITEST1']:
            h = Harness()
            h.data = data
            exc = self.assert_code('INVALID_MARKETPLACE_ORDER', lambda: h.client.call('place', total=12))
            self.assertIsNone(exc.receipt['order_id'])
            self.assertEqual(exc.receipt['outcome'], 'UNKNOWN')
            self.assertEqual(h.cookies[0][1], COOKIES)

    def test_payment_requires_exact_order_secret_and_fresh_status(self):
        h = Harness()
        def pay(order='NTEST1', secret='synthetic-secret'):
            return h.client.call('payment_complete', order=order, client_secret=secret, card_token='token')
        self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', pay)
        h.bind()
        self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', lambda: pay('NTEST2'))
        self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', lambda: pay(secret='different'))
        with patch.object(m.time, 'time', return_value=time.time() + 61):
            self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', pay)
        response = pay()
        self.assertEqual(response.summary()['order'], 'NTEST1')
        self.assertEqual(h.receipts[-1]['order_id'], 'NTEST1')
        self.assert_code('MUTATION_ALREADY_CONSUMED', pay)

    def test_place_provenance_prevents_other_order_payment(self):
        h = Harness()
        h.data = 'NTEST1'
        h.client.call('place', total=12)
        h.bind('NTEST2')
        self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', lambda: h.client.call('payment_complete',
            order='NTEST2', client_secret='synthetic-secret', card_token='token'))

    def test_failed_status_supersedes_old_binding(self):
        h = Harness()
        h.bind()
        h.data = m.MarketplaceError('INVALID_RESPONSE')
        self.assert_code('INVALID_RESPONSE', lambda: h.client.order_status('NTEST1'))
        self.assert_code('PAYMENT_ORDER_BINDING_REQUIRED', lambda: h.client.call('payment_complete',
            order='NTEST1', client_secret='synthetic-secret', card_token='token'))

    def test_echo_mismatch_and_challenge_fence(self):
        h = Harness()
        h.bind()
        h.data = {'status': 'payment_confirmed', 'orderNumber': 'NTEST2'}
        self.assert_code('ORDER_MISMATCH', lambda: h.client.call('payment_complete', order='NTEST1',
            client_secret='synthetic-secret', card_token='token'))
        self.assert_code('MUTATION_FENCED', h.client.session)
        h = Harness()
        h.bind()
        h.data = {'status': 'payment_ready_to_redirect', 'redirect_url': 'https://synthetic.invalid/3ds'}
        h.client.call('payment_complete', order='NTEST1', client_secret='synthetic-secret', card_token='token')
        self.assertEqual(h.receipts[-1]['outcome'], 'CHALLENGE_REQUIRED')
        self.assert_code('MUTATION_FENCED', h.client.session)

    def test_missing_observation_fences_and_does_not_retry(self):
        h = Harness()
        h.client._request = lambda *a, **kw: {}
        self.assert_code('RESPONSE_OBSERVATION_REQUIRED', h.client.session)
        self.assert_code('MUTATION_FENCED', h.client.session)

    def test_malformed_payment_status_still_journals_and_retains(self):
        h = Harness()
        h.bind()
        h.data = {'status': ['unexpected']}
        result = h.client.call('payment_complete', order='NTEST1',
            client_secret='synthetic-secret', card_token='token')
        self.assertEqual(result.summary()['state'], 'unknown')
        self.assertEqual(h.receipts[-1]['outcome'], 'UNKNOWN')
        self.assertEqual(h.events[-2:], ['receipt', 'cookies'])
        self.assert_code('MUTATION_FENCED', h.client.session)

    def test_reservation_exception_and_reentrant_send_are_fenced(self):
        h = Harness()
        def reserve(record):
            self.assert_code('CLIENT_BUSY', h.client.session)
            raise RuntimeError('reservation may already be durable')
        h.client._before_send = reserve
        self.assert_code('PARENT_JOURNAL_RESERVATION_FAILED', h.client.session)
        self.assert_code('MUTATION_FENCED', h.client.session)
        self.assertEqual(h.calls, [])

    def test_strict_utf8_finite_duplicate_free_bounded_decode(self):
        for raw in [b'"\xff"', '"NTEST1"'.encode('utf-16'), b'{"x":1e999}',
                    b'{"x":NaN}', b'{"x":1,"x":2}', gzip.compress(b'{}') + b'trailer']:
            self.assert_code('INVALID_RESPONSE', lambda: m.decode(raw))
        self.assert_code('RESPONSE_TOO_LARGE', lambda: m.decode(gzip.compress(b' ' * (m.MAX_BYTES + 1))))
        self.assertEqual(m.decode(gzip.compress(b'"NTEST1"')), 'NTEST1')


if __name__ == '__main__':
    unittest.main()
