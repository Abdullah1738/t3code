"""Native NowNow HTTP operations; caller-owned auth, review and durable journal.

Routes/builders are decoded from the fresh Android HBC. This transport does not
authorize a purchase, review its cost, or own an existing cart. The parent binds
every send to its reviewed intent. No retries, host aliases or server CAS fields.
"""
from dataclasses import dataclass, field
import copy
import hashlib
import http.client
import json
import re
import time
import urllib.error
import urllib.request
import zlib

import noon_http_orders as tracking
import noon_vertical_reads as vertical
import noon_minutes_checkout as seam
from noon_checkout import AccountHome, fingerprint


NowNowError = seam.MinutesError
ResponseObservation = seam.ResponseObservation
SavedCard = seam.SavedCard
require = seam.require
ident = seam.ident
HOST = 'api-app-fd.noon.com'
PREFIX = '/_svc/mp-shop-api-mpnoon/v1/order/'
MP_BASE = 'https://' + HOST + '/_svc/mp-shop-api-mpnoon/'
PAYMENT_BASE = 'https://api-app-st.noon.com/_svc/mp-payment-api-public/'
QUIET_NOTE = seam.QUIET_NOTE
WRITES = frozenset({'cart_get', 'cart_create', 'cart_validate', 'product_edit', 'instructions', 'delivery_preference',
                    'payment', 'place', 'payment_complete', 'payment_subscription'})
ROUTES = {
    'cart_get': ('POST', MP_BASE + 'v1/session/active', {'storeCode'}),
    'carts_recent': ('POST', MP_BASE + 'v1/session/recent', set()),
    'cart_create': ('POST', MP_BASE + 'v1/session/create', {'productCode', 'storeCode', 'modifiers'}),
    'cart_validate': ('POST', MP_BASE + 'v1/session/validate', {'sessionCode'}),
    'product_edit': ('POST', MP_BASE + 'v1/session/edit-product',
                     {'sessionCode', 'productCode', 'qty', 'notes', 'modifiers'}),
    'instructions': ('POST', MP_BASE + 'v1/session/add-notes', {'sessionCode', 'driverNotes'}),
    'delivery_preference': ('POST', MP_BASE + 'v1/session/set-delivery-preference',
                            {'sessionCode', 'deliveryPreference'}),
    'payment': ('POST', MP_BASE + 'v1/session/edit-payment', {'sessionCode', 'paymentMethodCode',
                'creditCardMask', 'paymentToken', 'prepaid_payment_method_code', 'walletAmount'}),
    'place': ('POST', MP_BASE + 'v1/order/place-order', {'sessionCode', 'total'}),
    'payment_subscription': ('POST', MP_BASE + 'v1/payment/subscription/create',
                             {'addressCode', 'addressVersion', 'paymentToken'}),
    'payment_config': ('GET', PAYMENT_BASE + 'config', None),
    'payment_complete': ('POST', PAYMENT_BASE + 'paymentintent/complete',
                         {'clientSecret', 'cvvEncryption', 'paymentMethodCode', 'idCustomerToken'}),
    'payment_status': ('POST', PAYMENT_BASE + 'paymentintent/status', {'clientSecret'}),
    # Captured 2026-10-10 on paid order NNGAANNWEFJMZW8A: the saved-card token
    # for edit-payment is corroborated by the account payment-token list, and
    # the active-order guard read is the order homepage (active[]).
    'payment_subscription_list': ('POST', MP_BASE + 'v1/payment/subscription/list', set()),
    'payment_cards': ('GET', 'https://api-app.noon.com/_svc/customer-v1/customer/paymentcards', None),
    'home': ('GET', MP_BASE + 'v1/order/homepage', None),
}


def order_id(value):
    require(isinstance(value, str) and bool(vertical.NOWNOW_ORDER.fullmatch(value)),
            'INVALID_ORDER_ID')
    return value


def endpoint(operation, payload, order=None):
    """Fixed evidenced routes only; no arbitrary URL/body-key escape hatch."""
    if operation in ROUTES:
        method, url, keys = ROUTES[operation]
        require(payload is None if keys is None else type(payload) is dict and set(payload) == keys,
                'INVALID_PAYLOAD')
        require(order is None or operation in ('payment_complete', 'payment_status', 'payment_subscription'),
                'INVALID_ORDER_ID')
        if order is not None:
            order_id(order)
        return method, url
    if operation == 'order_detail':
        order_id(order)
        require(payload == {'orderNr': order}, 'INVALID_PAYLOAD')
        return 'POST', 'https://' + HOST + PREFIX + 'details'
    if operation == 'track':
        order_id(order)
        require(payload is None, 'INVALID_PAYLOAD')
        return 'GET', 'https://' + HOST + PREFIX + 'tracking/' + order
    if operation == 'orders':
        require(order is None and type(payload) is dict and not payload, 'INVALID_PAYLOAD')
        return 'POST', 'https://' + HOST + PREFIX + 'history'
    raise NowNowError('ENDPOINT_DENIED')


def _headers(headers):
    out = seam._headers(headers)
    require(all(out.get(k) for k in ('x-addresscode', 'x-addresskey')),
            'ADDRESS_BINDING_MISMATCH')
    # Accepted NNMPBaseUrl read contract replaces the FIRST hyphen only.
    out['x-address-key'] = out['x-addresskey'].replace('-', ':', 1)
    return out


def native_request(operation, headers, deadline, payload, *, response_observer, order=None):
    """One dispatch; preserve repeated Set-Cookie before body reads or errors."""
    method, url = endpoint(operation, payload, order)
    require(callable(response_observer), 'RESPONSE_OBSERVER_REQUIRED')
    request = urllib.request.Request(url, headers=_headers(headers), method=method,
        data=seam._json(payload) if payload is not None else None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), tracking.NoRedirect())
    try:
        with tracking.read_deadline(deadline) as left:
            with opener.open(request, timeout=left) as response:
                seam._observe_response(response, response_observer)
                return seam.decode_response(response.read(seam.MAX_BYTES + 1))
    except urllib.error.HTTPError as exc:
        try:
            seam._observe_response(exc, response_observer)
            code = exc.code
        finally:
            exc.close()
        raise NowNowError({401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 404: 'NOT_FOUND',
                           429: 'RATE_LIMITED'}.get(code, 'HTTP_' + str(code))) from None
    except tracking.NoonError:
        raise NowNowError('REQUEST_TIMEOUT') from None
    except NowNowError:
        raise
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException, zlib.error):
        raise NowNowError('REQUEST_FAILED') from None


@dataclass(frozen=True)
class Snapshot:
    """Raw response is private RAM-only state; only projection is persistable."""
    wire: dict = field(repr=False)
    projection: dict
    observed_at: float


def _data(data):
    require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
    seam._application_ok(data)
    try:
        return vertical._nownow_data(data)
    except tracking.NoonError:
        raise NowNowError('RESPONSE_SCHEMA_CHANGED') from None


def project_order(data, order):
    row = _data(data)
    require(row.get('orderNr') == order, 'ORDER_MISMATCH')
    status = row.get('orderStatusCode')
    require(isinstance(status, str) and re.fullmatch(r'[a-z_]{1,64}', status),
            'ORDER_STATUS_SCHEMA_CHANGED')
    return {'service': 'nownow', 'order': order, 'raw_status': status,
            'state': 'exact_tracking_required', 'resend_allowed': False}


def project_cart(data, *, session_code=None, store_code=None, allow_empty=False):
    seam._application_ok(data)
    require(data.get('status') in (None, 'success'), 'APPLICATION_REJECTED')
    row = data.get('data')
    if row is None and allow_empty:
        return {'service': 'nownow', 'empty': True, 'complete_review': False}
    require(isinstance(row, dict), 'CART_SCHEMA_CHANGED')
    session = ident(row.get('checkoutSessionCode'))
    require(session_code is None or session == session_code, 'SESSION_MISMATCH')
    store = row.get('storeInfo')
    require(isinstance(store, dict), 'STORE_SCHEMA_CHANGED')
    store = ident(store.get('storeCode'))
    require(store_code is None or store == store_code, 'STORE_MISMATCH')
    products = row.get('products')
    require(isinstance(products, list), 'PRODUCTS_SCHEMA_CHANGED')
    result = {'service': 'nownow', 'empty': False, 'session_code': session,
              'store_code': store, 'product_count': len(products), 'complete_review': False,
              'driver_notes': seam.safe_text(row.get('driverNotes'))}
    for field in ('orderTotal', 'orderPaymentAmount', 'orderWalletAmount'):
        result[field + '_minor'] = seam.amount_minor(row[field]) if row.get(field) is not None else None
    return result


def project_place(data):
    # Captured NNGAANNWEFJMZW8A: data.order carries orderNr/orderRef/status/fees.
    row = _data(data)
    inner = row.get('order')
    require(isinstance(inner, dict), 'PLACE_SCHEMA_CHANGED')
    order = order_id(inner.get('orderNr'))
    return {'service': 'nownow', 'order': order, 'state': 'order_id_received_payment_unconfirmed',
            'resend_allowed': False}


def merge_validated_basket(current, validated, *, session_code, store_code=None):
    """f129876 @959..1012: fresh top-level fields replace current basket fields.

    Inputs are unwrapped basket rows, held only in RAM. Check each row's required
    cart identity/products schema before merging; stale fields must not disguise
    malformed validation evidence. Nested objects are replaced, not recursively
    merged. The parent owns full financial schema and review of the result.
    """
    session_code = ident(session_code)
    previous = project_cart({'data': current}, session_code=session_code, store_code=store_code)
    project_cart({'data': validated}, session_code=session_code, store_code=previous['store_code'])
    return copy.deepcopy({**current, **validated})


def project_created_cart(data, store_code):
    # f114226 only consumes checkoutSessionCode from create's response. Do not
    # require the full active-session schema from this separate endpoint.
    row = _data(data)
    session = ident(row.get('checkoutSessionCode'))
    store = row.get('storeInfo')
    if store is not None:
        require(isinstance(store, dict) and store.get('storeCode') == store_code, 'STORE_MISMATCH')
    return {'service': 'nownow', 'session_code': session, 'requested_store_code': store_code,
            'store_identity_echoed': store is not None, 'state': 'active_cart_readback_required',
            'complete_review': False}


def modifiers_payload(value):
    # f30147/f62048/f105523: modifierCode -> selected modifierOptionCode[].
    require(type(value) is dict and len(value) <= 30, 'INVALID_MODIFIERS')
    result = {}
    for code, options in value.items():
        require(type(options) is list and len(options) <= 50, 'INVALID_MODIFIERS')
        result[ident(code)] = [ident(option) for option in options]
        require(len(set(result[code])) == len(options), 'DUPLICATE_MODIFIER')
    return result


def project_orders(data):
    rows = _data(data).get('orders')
    require(isinstance(rows, list) and len(rows) <= 500, 'ORDER_LIST_SCHEMA_CHANGED')
    out, seen = [], set()
    for row in rows:
        require(isinstance(row, dict), 'ORDER_LIST_SCHEMA_CHANGED')
        order = order_id(row.get('orderNr'))
        require(order not in seen, 'DUPLICATE_ORDER_ID')
        seen.add(order)
        raw = row.get('orderStatusCode')
        require(isinstance(raw, str) and re.fullmatch(r'[a-z_]{1,64}', raw),
                'ORDER_STATUS_SCHEMA_CHANGED')
        agrees = row.get('logisticsStatusCode') == raw == row.get('customerStatusCode')
        out.append({'order': order, 'raw_status': raw, 'status_agreement': agrees,
                    'status': vertical.NOWNOW_STAGES.get(raw, 'unknown') if agrees else 'unknown'})
    return {'service': 'nownow', 'orders': out, 'complete_history': False,
            'coverage': 'native_default_page_only', 'resend_allowed': False}


def payment_payload(session_code, card):
    """Native caller 5726514–5726544: prepaid wrapper, not Minutes' method body."""
    require(isinstance(card, SavedCard), 'INVALID_CARD')
    card.validate()
    return {'sessionCode': ident(session_code), 'paymentMethodCode': 'prepaid',
            'prepaid_payment_method_code': 'cc_noonpay', 'paymentToken': card.token,
            'creditCardMask': card.mask, 'walletAmount': 0}


def place_payload(session_code, order_payment_minor):
    """Caller 5727154 binds total to orderPaymentAmount, NOT orderTotal."""
    require(type(order_payment_minor) is int and order_payment_minor > 0, 'INVALID_AMOUNT')
    return {'sessionCode': ident(session_code), 'total': seam.wire_amount(order_payment_minor)}


def payment_complete_payload(client_secret, card, cvv_encryption):
    """Caller 6270587: exactly four keys; encryption supplied by the parent."""
    require(isinstance(card, SavedCard), 'INVALID_CARD')
    card.validate()
    require(isinstance(client_secret, str) and 0 < len(client_secret) <= 2000,
            'INVALID_PAYMENT_INTENT')
    require(type(cvv_encryption) is dict and set(cvv_encryption) == {'encCvv', 'publicKeyName'}
            and all(isinstance(v, str) and 0 < len(v) <= 16000 for v in cvv_encryption.values()),
            'ENCRYPTED_CVV_REQUIRED')
    return {'clientSecret': client_secret, 'cvvEncryption': dict(cvv_encryption),
            'paymentMethodCode': 'cc_noonpay', 'idCustomerToken': card.token}


class NowNowCheckout:
    """Injected transport with fresh headers and the Minutes journal convention.

    header_provider(operation, deadline) is mandatory and trusted to bind the same
    verified account. before_send(operation, body_sha256) must durably consume the
    exact intent and mark MAY_HAVE_SENT before returning exactly True. receipt
    must durably record the outcome before returning True. Neither is server CAS.

    request(operation, headers, deadline, payload, *, response_observer, order)
    must observe response headers BEFORE decode. Cookies are held in RAM here and
    delivered via response_cookies(operation, values, *, response_url, http_status,
    outcome_journaled), AFTER the outcome receipt attempt, including failures.
    False/exception from either sink fences writes. Parent retains failed-outcome
    cookies in RAM until journal repair; never persist raw Snapshot or headers.

    Cart snapshots deliberately do not certify a manifest, price or quiet delivery.
    The parent must review raw RAM-only wire data and verify mutation readbacks.
    """
    def __init__(self, account_home, *, header_provider, request=native_request,
                 receipt=None, response_cookies=None):
        require(callable(header_provider), 'FRESH_HEADER_PROVIDER_REQUIRED')
        require(callable(request), 'TRANSPORT_REQUIRED')
        self._home = account_home
        self._header_provider = header_provider
        self._request = request
        self._receipt = receipt
        self._response_cookies = response_cookies
        self._mutation_fenced = False
        self._last_response = None
        self._pending_observations = []
        self._placed_sessions = set()
        self._validated_sessions = set()
        self._completed_intents = set()

    def _call(self, operation, payload, timeout, before_send=None, *, order=None, project=None):
        _, url = endpoint(operation, payload, order)
        mutation = operation in WRITES
        if mutation:
            require(not self._mutation_fenced, 'MUTATION_FENCED')
            require(callable(before_send), 'SEND_JOURNAL_REQUIRED')
            require(callable(self._receipt), 'RESPONSE_RECEIPT_REQUIRED')
        require(callable(self._response_cookies), 'RESPONSE_COOKIES_REQUIRED')
        try:
            deadline = tracking.operation_deadline(timeout)
        except tracking.NoonError:
            raise NowNowError('INVALID_TIMEOUT') from None
        require(isinstance(self._home, AccountHome) and self._home.service == 'nownow'
                and 0 <= time.time() - self._home.checked_at <= 120, 'VERIFIED_ACCOUNT_REQUIRED')
        try:
            headers = _headers(self._header_provider(operation, deadline))
        except Exception:
            raise NowNowError('AUTH_HEADERS_FAILED') from None
        require(self._home.address_ref == fingerprint(headers['x-addresscode'], headers['x-addresskey']),
                'ADDRESS_BINDING_MISMATCH')
        if operation == 'payment_subscription':
            require(payload['addressCode'] == headers['x-addresscode'], 'ADDRESS_BINDING_MISMATCH')
        body = seam._json(payload) if payload is not None else b''
        payload = json.loads(body) if payload is not None else None
        digest = hashlib.sha256(body).hexdigest()
        sent = False
        if mutation:
            try:
                reserved = before_send(operation, digest)
            except Exception:
                raise NowNowError('SEND_RESERVATION_FAILED') from None
            require(reserved is True, 'SEND_RESERVATION_DENIED')
            sent = self._mutation_fenced = True
        observations = []

        def observe(value):
            require(type(value) is ResponseObservation, 'RESPONSE_OBSERVATION_INVALID')
            # Retain even a mismatched observation, before validation can fail.
            observations.append(value)
            self._pending_observations.append((operation, value))
            require(len(observations) == 1, 'MULTIPLE_RESPONSES_DENIED')
            require(value.response_url == url, 'RESPONSE_URL_MISMATCH')
            require(type(value.http_status) is int and 100 <= value.http_status <= 599,
                    'HTTP_STATUS_INVALID')
            require(isinstance(value.set_cookies, tuple)
                    and all(isinstance(v, str) for v in value.set_cookies), 'RESPONSE_COOKIES_INVALID')

        data = result = error = None
        projection_hash = None
        try:
            tracking.remaining(deadline)
            data = self._request(operation, headers, deadline, payload,
                                 response_observer=observe, order=order)
            self._last_response = (operation, data)
            tracking.remaining(deadline)
            require(len(observations) == 1, 'RESPONSE_OBSERVATION_REQUIRED')
            require(200 <= observations[0].http_status < 300, 'HTTP_RESPONSE_REJECTED')
            require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
            result = project(data) if project else data
            if mutation:
                require(project is not None, 'MUTATION_PROJECTION_REQUIRED')
                projection = result.projection if isinstance(result, Snapshot) else result
                projection_hash = hashlib.sha256(seam._json(projection)).hexdigest()
        except NowNowError as exc:
            error = exc.code
        except tracking.NoonError:
            error = 'REQUEST_TIMEOUT'
        except Exception:
            error = 'REQUEST_FAILED'

        record, journaled = None, False
        if mutation:
            projection = result.projection if isinstance(result, Snapshot) else result
            outcome = 'UNKNOWN' if error else 'RESPONSE_RECEIVED'
            received_order = order
            if operation == 'place':
                row = data.get('data') if isinstance(data, dict) else None
                inner = row.get('order') if isinstance(row, dict) else None
                candidate = inner.get('orderNr') if isinstance(inner, dict) else None
                if isinstance(candidate, str) and vertical.NOWNOW_ORDER.fullmatch(candidate):
                    received_order = candidate
                if not error:
                    outcome = 'ORDER_ID_RECEIVED'
            if operation == 'payment_complete' and not error and projection['redirect_required']:
                outcome = 'CHALLENGE_REQUIRED'
            record = {'service': 'nownow', 'operation': operation, 'request_sha256': digest,
                      'request_url': url, 'http_status': observations[0].http_status if observations else None,
                      'outcome': outcome, 'error_code': error, 'order_id': received_order,
                      'projection_sha256': projection_hash}
            record['evidence_hash'] = hashlib.sha256(seam._json(record)).hexdigest()
            try:
                journaled = self._receipt(json.loads(seam._json(record))) is True
            except Exception:
                pass
            if not journaled:
                error = 'RESPONSE_RECEIPT_FAILED'
        for observation in observations:
            try:
                acknowledged = self._response_cookies(operation, observation.set_cookies,
                    response_url=observation.response_url, http_status=observation.http_status,
                    outcome_journaled=journaled)
                require(acknowledged is True, 'RESPONSE_COOKIES_FAILED')
                self._pending_observations.remove((operation, observation))
            except Exception:
                self._mutation_fenced = True
                error = error if error == 'RESPONSE_RECEIPT_FAILED' else 'RESPONSE_COOKIES_FAILED'
        if error:
            if mutation:
                self._mutation_fenced = True
            raise NowNowError(error, may_have_sent=sent, receipt=record,
                              outcome_journaled=journaled) from None
        if mutation and record['outcome'] not in ('UNKNOWN', 'CHALLENGE_REQUIRED'):
            self._mutation_fenced = False
        return result

    def order_status(self, order, *, timeout=12):
        order_id(order)
        return self._call('order_detail', {'orderNr': order}, timeout, order=order,
            project=lambda data: Snapshot(data, project_order(data, order), time.time()))

    def track(self, order, *, timeout=12):
        order_id(order)
        start = time.monotonic()
        detail = self.order_status(order, timeout=timeout)
        left = timeout - (time.monotonic() - start)
        require(left > 0, 'REQUEST_TIMEOUT')
        state = self._call('track', None, left, order=order)
        _data(state)
        try:
            result = vertical.nownow_projection(detail.wire, state, order)
        except tracking.NoonError:
            raise NowNowError('ORDER_MISMATCH_OR_SCHEMA_CHANGED') from None
        result.update(account_verified=True, saved_home_verified=True)
        return result

    def tracking(self, order, *, timeout=12):
        """Raw v1/order/tracking/{orderNr} projection (captured poll read).

        Statuses seen live on NNGAANNWEFJMZW8A: placed (pending_acceptance,
        needHelpActions incl. cancel_order) -> preparing (pending_approval,
        estimate "02:20PM - 02:35PM", then rider assigned in description).
        """
        order_id(order)
        def project(data):
            row = _data(data)
            status = row.get('status')
            require(isinstance(status, str) and re.fullmatch(r'[a-z_]{1,64}', status),
                    'TRACKING_SCHEMA_CHANGED')
            actions = row.get('needHelpActions')
            require(actions is None or isinstance(actions, list) and len(actions) <= 20,
                    'TRACKING_SCHEMA_CHANGED')
            address = row.get('address')
            require(address is None or isinstance(address, dict), 'TRACKING_SCHEMA_CHANGED')
            codes = sorted({entry.get('actionCode') for entry in actions or []
                            if isinstance(entry, dict)
                            and isinstance(entry.get('actionCode'), str)
                            and re.fullmatch(r'[a-z_]{1,64}', entry['actionCode'])})
            return Snapshot(data, {'service': 'nownow', 'order': order, 'status': status,
                                   'order_status_code': row.get('orderStatusCode'),
                                   'title': seam.safe_text(row.get('title')),
                                   'description': seam.safe_text(row.get('description')),
                                   'estimate': seam.safe_text(row.get('estimate')),
                                   'rider_present': isinstance(row.get('rider'), dict),
                                   'need_help_actions': codes,
                                   'address_text': seam.safe_text(address.get('description'))
                                   if isinstance(address, dict) else None}, time.time())
        return self._call('track', None, timeout, order=order, project=project)

    def orders(self, *, timeout=12):
        return self._call('orders', {}, timeout, project=project_orders)

    def get_cart(self, store_code, *, before_send, timeout=12):
        store_code = ident(store_code)
        return self._call('cart_get', {'storeCode': store_code}, timeout, before_send,
            project=lambda data: Snapshot(data, project_cart(data, store_code=store_code,
                                                           allow_empty=True), time.time()))

    def recent_carts(self, *, timeout=12):
        def project(data):
            carts = _data(data).get('carts')
            require(isinstance(carts, list) and len(carts) <= 100, 'CARTS_SCHEMA_CHANGED')
            return Snapshot(data, {'service': 'nownow', 'carts': [project_cart({'data': row})
                            for row in carts], 'complete_history': False}, time.time())
        return self._call('carts_recent', {}, timeout, project=project)

    def _session(self, operation, payload, timeout, before_send, *, store_code=None):
        return self._call(operation, payload, timeout, before_send,
            project=lambda data: Snapshot(data, project_cart(data,
                session_code=payload.get('sessionCode'), store_code=store_code), time.time()))

    def create_cart(self, *, store_code, product_code, modifiers, before_send, timeout=12):
        """Native first-product create. Parent must preserve existing store carts."""
        payload = {'storeCode': ident(store_code), 'productCode': ident(product_code),
                   'modifiers': modifiers_payload(modifiers)}
        return self._call('cart_create', payload, timeout, before_send,
            project=lambda data: Snapshot(data, project_created_cart(data, store_code), time.time()))

    def validate_cart(self, session_code, *, before_send, store_code=None, timeout=12):
        """One native validation attempt; response is the same-session readback.

        f114242 sends only sessionCode. validateBasket(true)'s boolean toggles
        local place_order loading state; it is not a wire parameter. Parent owns
        durable replay prevention across instances and fresh controller review.
        """
        session_code = ident(session_code)
        if store_code is not None:
            store_code = ident(store_code)
        require(session_code not in self._validated_sessions, 'VALIDATE_ALREADY_ATTEMPTED')
        require(callable(before_send), 'SEND_JOURNAL_REQUIRED')
        def reserve(operation, digest):
            accepted = before_send(operation, digest)
            if accepted is True:
                self._validated_sessions.add(session_code)
            return accepted
        return self._session('cart_validate', {'sessionCode': session_code}, timeout, reserve,
                             store_code=store_code)

    def add_product(self, *, session_code, product_code, quantity, modifiers, notes,
                    before_send, timeout=12):
        """Native edit-product with absolute target qty; never an increment/retry."""
        require(type(quantity) is int and 1 <= quantity, 'INVALID_QUANTITY')
        require(notes is None or isinstance(notes, str), 'INVALID_NOTES')
        payload = {'sessionCode': ident(session_code), 'productCode': ident(product_code),
                   'qty': quantity, 'notes': notes, 'modifiers': modifiers_payload(modifiers)}
        return self._session('product_edit', payload, timeout, before_send)

    def set_quiet_notes(self, *, session_code, before_send, timeout=12):
        return self._session('instructions', {'sessionCode': ident(session_code),
                          'driverNotes': QUIET_NOTE}, timeout, before_send)

    def set_delivery_preference(self, *, session_code, preferences, before_send, timeout=12):
        """Full code:value map from observed options (f81091), preserving others.

        Known icons evidence leavedoor/dontring; no dontcall code is invented.
        Null means disabled in the native UI and must be preserved, not enabled.
        """
        require(type(preferences) is dict and 0 < len(preferences) <= 30, 'INVALID_PREFERENCES')
        prefs = {ident(k): v for k, v in preferences.items()}
        require(all(v is None or type(v) is bool for v in prefs.values()), 'INVALID_PREFERENCES')
        return self._session('delivery_preference', {'sessionCode': ident(session_code),
                             'deliveryPreference': prefs}, timeout, before_send)

    def set_payment_method(self, *, session_code, card, before_send, timeout=12):
        return self._session('payment', payment_payload(session_code, card), timeout, before_send)

    def place_order(self, *, session_code, order_payment_minor, before_send, timeout=12):
        ident(session_code)
        require(session_code not in self._placed_sessions, 'PLACE_ALREADY_ATTEMPTED')
        payload = place_payload(session_code, order_payment_minor)
        def reserve(operation, digest):
            accepted = before_send(operation, digest)
            if accepted is True:
                self._placed_sessions.add(session_code)
            return accepted
        require(callable(before_send), 'SEND_JOURNAL_REQUIRED')
        return self._call('place', payload, timeout, reserve,
            project=lambda data: Snapshot(data, project_place(data), time.time()))

    def payment_config(self, *, timeout=12):
        def project(data):
            seam._application_ok(data)
            return Snapshot(data, {'service': 'nownow', 'payment_config_received': True}, time.time())
        return self._call('payment_config', None, timeout, project=project)

    def payment_cards(self, *, timeout=12):
        """Account saved cards (customer-v1). Tokens stay in RAM-only wire."""
        def project(data):
            return Snapshot(data, {'service': 'nownow', 'cards': seam.project_cards(data)}, time.time())
        return self._call('payment_cards', None, timeout, project=project)

    def payment_subscription_list(self, *, timeout=12):
        """Saved payment-token list; only fingerprints leave this projection."""
        def project(data):
            seam._application_ok(data)
            rows = data.get('data')
            require(isinstance(rows, list) and len(rows) <= 100, 'PAYMENT_TOKENS_SCHEMA_CHANGED')
            refs = []
            for row in rows:
                require(isinstance(row, dict) and set(row) <= {'paymentToken'}
                        and isinstance(row.get('paymentToken'), str)
                        and 0 < len(row['paymentToken']) <= 200, 'PAYMENT_TOKENS_SCHEMA_CHANGED')
                refs.append(fingerprint(row['paymentToken']))
            return Snapshot(data, {'service': 'nownow', 'token_refs': refs,
                                   'token_count': len(refs)}, time.time())
        return self._call('payment_subscription_list', {}, timeout, project=project)

    def home(self, *, timeout=12):
        """Order homepage readback; the coordinator checks journal attribution."""
        def project(data):
            row = _data(data)
            active = row.get('active')
            # Live 2026-10-10: active is null when no order is in flight.
            require(active is None or isinstance(active, list) and len(active) <= 50,
                    'HOMEPAGE_SCHEMA_CHANGED')
            out = []
            for entry in active or []:
                require(isinstance(entry, dict), 'HOMEPAGE_SCHEMA_CHANGED')
                out.append({'order': order_id(entry.get('orderNr')),
                            'status': entry.get('status') if isinstance(entry.get('status'), str)
                                      and re.fullmatch(r'[a-z_]{1,64}', entry.get('status')) else None})
            return Snapshot(data, {'service': 'nownow', 'active_orders': out}, time.time())
        return self._call('home', None, timeout, project=project)

    def create_payment_subscription(self, *, address_code, address_version, card,
                                    before_send, timeout=12):
        """Native intent creation before completion; response secret stays in RAM.

        This is a real payment subscription operation, never an implicit part of
        place_order. Parent must authorize this specific intent and address.
        """
        require(isinstance(card, SavedCard), 'INVALID_CARD')
        card.validate()
        require(type(address_version) is int and address_version >= 0, 'INVALID_ADDRESS_VERSION')
        payload = {'addressCode': ident(address_code), 'addressVersion': address_version,
                   'paymentToken': card.token}
        def project(data):
            seam._application_ok(data)
            require(data.get('status') in (None, 'success') and isinstance(data.get('data'), str)
                    and 0 < len(data['data']) <= 2000, 'PAYMENT_INTENT_SCHEMA_CHANGED')
            return Snapshot(data, {'service': 'nownow', 'payment_intent_present': True,
                                   'state': 'payment_continuation_required'}, time.time())
        return self._call('payment_subscription', payload, timeout, before_send, project=project)

    def complete_payment(self, *, order, client_secret, card, cvv_encryption, before_send, timeout=12,
                         session_code=None):
        # Native subscription intents can precede place. A local session binding
        # supports that branch without inserting it into the payment wire body.
        if order is None:
            ident(session_code)
        else:
            order_id(order)
        payload = payment_complete_payload(client_secret, card, cvv_encryption)
        intent_ref = fingerprint(client_secret)
        require(intent_ref not in self._completed_intents, 'PAYMENT_ALREADY_ATTEMPTED')
        require(callable(before_send), 'SEND_JOURNAL_REQUIRED')
        def reserve(operation, digest):
            accepted = before_send(operation, digest)
            if accepted is True:
                self._completed_intents.add(intent_ref)
            return accepted
        return self._call('payment_complete', payload, timeout, reserve, order=order,
            project=lambda data: Snapshot(data, seam.project_payment(data, order), time.time()))

    def payment_status(self, *, order, client_secret, timeout=12, session_code=None):
        if order is None:
            ident(session_code)
        else:
            order_id(order)
        require(isinstance(client_secret, str) and 0 < len(client_secret) <= 2000,
                'INVALID_PAYMENT_INTENT')
        return self._call('payment_status', {'clientSecret': client_secret}, timeout, order=order,
            project=lambda data: Snapshot(data, seam.project_payment(data, order), time.time()))
