"""Native Main and Supermall transport, with parent-owned mutation journalling.

This module never renews auth, retries a send or persists upstream responses.
Headers are supplied by the auth lifecycle owner. ``before_send`` must durably
reserve the exact operation before allowing it onto the wire. Place and payment
are separate operations; an order number alone is not payment confirmation.
"""
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import http.client
import json
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

import noon_http_orders as core
import noon_vertical_reads as tracking


EXPERIENCES = {'main': 'ecom', 'supermall': 'rocket'}
HOST = 'api-app.noon.com'
PAYMENT_HOST = 'api-app-st.noon.com'
CART = '/_svc/cart-v1/cart'
CHECKOUT = '/_svc/checkout-v2/session/'
ORDER = '/_svc/checkout-v2/order/'
PAYMENT = '/_svc/mp-payment-api-public/paymentintent/'
MAX_BYTES = 2_000_000
ID = re.compile(r'[A-Za-z0-9_:.~-]{1,256}')
ORDER_ID = re.compile(r'N[A-Z0-9]{1,63}')
# Source: Hermes HBC a213ec477e181c8e4b9ccb4fa85b13a064559c8c4ad93c3869f1200d12f487f3.
# getSalesExperience + global API headers: lines 1645496, 3754366–3754421.
# Supermall URL -> rocket: 3759315–3759358; PDP UI share: 4704592–4704661.
CONTRACT = {
    'main': {'marketplace': 'noon', 'experience': 'ecom', 'mp': 'noon',
             'cart_read': 'live_http_200_empty', 'purchase': 'not_live_validated'},
    'supermall': {'marketplace': 'rocket', 'experience': 'rocket', 'mp': 'noon',
                  'cart_read': 'live_http_200_empty', 'purchase': 'not_live_validated'},
    'cart_storage_isolation': 'unverified_with_populated_carts',
}


class MarketplaceError(Exception):
    def __init__(self, code, *, http_status=None, may_have_sent=False,
                 receipt=None, outcome_journaled=False):
        if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code):
            code = 'REQUEST_FAILED'
        self.code = code
        self.http_status = http_status
        self.may_have_sent = may_have_sent
        self.receipt = receipt
        self.outcome_journaled = outcome_journaled
        super().__init__(code)


def _id(value, *, blank=False):
    if blank and value == '':
        return value
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise MarketplaceError('INVALID_REFERENCE')
    return value


def _order(value):
    if not isinstance(value, str) or not ORDER_ID.fullmatch(value) or value.startswith('NN'):
        raise MarketplaceError('INVALID_MARKETPLACE_ORDER')
    return value


def _bool(value):
    if type(value) is not bool:
        raise MarketplaceError('INVALID_BOOLEAN')
    return value


def _quantity(value):
    if type(value) is not int or not 1 <= value:
        raise MarketplaceError('INVALID_QUANTITY')
    return value


def fils(value):
    if type(value) not in (int, float, str, Decimal):
        raise MarketplaceError('INVALID_AMOUNT')
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount > 1_000_000:
            raise ValueError
        result = amount * 100
        if result != result.to_integral_value():
            raise ValueError
        return int(result)
    except (InvalidOperation, ValueError, OverflowError):
        raise MarketplaceError('INVALID_AMOUNT') from None


def _json(value):
    try:
        return json.dumps(value, allow_nan=False, sort_keys=True, separators=(',', ':')).encode()
    except (ValueError, TypeError, OverflowError, UnicodeError, RecursionError):
        raise MarketplaceError('INVALID_JSON') from None


def fingerprint(value):
    """Local equality reference, never a server revision/idempotency token."""
    return hashlib.sha256(_json(value)).hexdigest()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate')
        result[key] = value
    return result


def decode(raw):
    try:
        if len(raw) > MAX_BYTES:
            raise MarketplaceError('RESPONSE_TOO_LARGE')
        if raw[:2] == b'\x1f\x8b':
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            raw = decoder.decompress(raw, MAX_BYTES + 1)
            if len(raw) > MAX_BYTES or decoder.unconsumed_tail:
                raise MarketplaceError('RESPONSE_TOO_LARGE')
            if not decoder.eof or decoder.unused_data:
                raise ValueError('gzip')
        def invalid(_):
            raise ValueError('constant')
        def finite(value):
            number = float(value)
            if not math.isfinite(number):
                raise ValueError('overflow')
            return number
        return json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=_unique,
                          parse_constant=invalid, parse_float=finite)
    except MarketplaceError:
        raise
    except (ValueError, UnicodeError, zlib.error, RecursionError, OverflowError):
        raise MarketplaceError('INVALID_RESPONSE') from None


@dataclass(frozen=True, repr=False)
class Operation:
    service: str
    name: str
    method: str
    host: str
    path: str = field(repr=False)
    body: bytes | None = field(default=None, repr=False)
    mutation: bool = False
    order_id: str | None = None

    @property
    def digest(self):
        return fingerprint([self.service, self.name, self.method, self.host,
                            self.path, self.body.decode() if self.body else None, self.order_id])

    def __repr__(self):
        return f'Operation(service={self.service!r}, name={self.name!r}, mutation={self.mutation!r})'


def operation(service, name, **args):
    """Build only mapped native requests. No arbitrary endpoint or payload seam."""
    if service not in EXPERIENCES:
        raise MarketplaceError('INVALID_SERVICE')
    method, host, payload, mutation = 'POST', HOST, None, True
    order_id = None
    if name == 'cart':
        # Native false dismiss => undefined, serialized as absent, not false/0.
        method, mutation = 'GET', False
        page = _bool(args.pop('is_page_cart', False))
        path = CART + '?isPageCart=' + str(page).lower()
    elif name in ('add', 'quantity'):
        offer, qty = _id(args.pop('offer')), _quantity(args.pop('quantity'))
        page = _bool(args.pop('is_page_cart', False))
        path = CART + '/item/' + urllib.parse.quote(offer, safe='') + '/' + str(qty)
        if name == 'add':
            path += '?showCart&isPageCart=' + str(page).lower()
            store = args.pop('store_code', None)
            # Rocket product tile supplies {storeCode}; no invented SKU body.
            payload = {'storeCode': _id(store)} if store is not None else None
        else:
            method = 'PUT'
            path += '?showCart=true&isPageCart=' + str(page).lower()
            variant = args.pop('variant_key', None)
            if page:
                path += '&variantKey=' + urllib.parse.quote(_id(variant, blank=True), safe='')
            elif variant is not None:
                raise MarketplaceError('VARIANT_REQUIRES_PAGE_CART')
    elif name == 'add_rocket':
        # Rocket quick-add (captured live 2026-10-10, paid order NAEIA0000960441):
        # PDP quick_atc posts ?showCart with the two explicit deselect flags;
        # no isPageCart and no storeCode on this route.
        offer, qty = _id(args.pop('offer')), _quantity(args.pop('quantity'))
        path = CART + '/item/' + urllib.parse.quote(offer, safe='') + '/' + str(qty) + '?showCart'
        payload = {'isFouponSelected': False, 'isInstallationSelected': False}
    elif name == 'select':
        path = CART + '/select-for-checkout'
        offers = args.pop('offers')
        if not isinstance(offers, list) or not offers or len(offers) > 200:
            raise MarketplaceError('INVALID_SELECTION')
        rows, seen = [], set()
        for row in offers:
            if not isinstance(row, dict) or set(row) != {'offerCode', 'variantKey', 'isSelected'}:
                raise MarketplaceError('INVALID_SELECTION')
            offer, variant = _id(row['offerCode']), _id(row['variantKey'], blank=True)
            if (offer, variant) in seen:
                raise MarketplaceError('DUPLICATE_OFFER')
            seen.add((offer, variant))
            rows.append({'offerCode': offer, 'variantKey': variant, 'isSelected': _bool(row['isSelected'])})
        payload = {'offers': rows}
    elif name == 'session':
        path = CHECKOUT + 'session'
        update = args.pop('should_update_session', None)
        payload = {} if update is None else {'shouldUpdateSession': _bool(update)}
    elif name == 'address':
        path, payload = CHECKOUT + 'set-address', {'addressKey': _id(args.pop('address_key'))}
    elif name == 'payment_method':
        path = CHECKOUT + 'set-payment-method'
        mask = args.pop('card_mask')
        if not isinstance(mask, str) or len(mask) > 64 or not mask.endswith('5542') or '\n' in mask or '\r' in mask:
            raise MarketplaceError('SAVED_CARD_MISMATCH')
        payload = {'paymentMethodCode': 'cc_noonpay', 'cardToken': _id(args.pop('card_token')), 'cardMask': mask}
        section = args.pop('card_section_code', None)
        if section is not None:
            payload['cardSectionCode'] = _id(section)
    elif name == 'delivery_option':
        path = CHECKOUT + 'set-delivery-option'
        payload = {'code': _id(args.pop('code')), 'active': _bool(args.pop('active')),
                   'shouldSaveSelection': _bool(args.pop('save', False))}
        receiver = args.pop('receiver_phone_code', None)
        if receiver is not None:
            payload['receiverPhoneCode'] = _id(receiver)
    elif name == 'place':
        path = ORDER + 'place-order'
        total = args.pop('total')
        fils(total)
        if type(total) not in (int, float):
            raise MarketplaceError('TOTAL_MUST_BE_NATIVE_NUMBER')
        payload = {'total': total}
    elif name == 'order_status':
        method, mutation = 'GET', False
        order_id = _order(args.pop('order'))
        path = ORDER + 'order-status?order_nr=' + order_id
    elif name == 'order_detail':
        method, mutation = 'GET', False
        order_id = _order(args.pop('order'))
        path = '/_svc/order-v2/order/' + order_id
    elif name == 'payment_config':
        method, host, mutation = 'GET', PAYMENT_HOST, False
        path = '/_svc/mp-payment-api-public/config'
    elif name in ('payment_complete', 'payment_status'):
        host = PAYMENT_HOST
        order_id = _order(args.pop('order'))  # Local binding; status body stays {clientSecret}.
        secret = args.pop('client_secret')
        if not isinstance(secret, str) or not 1 <= len(secret) <= 4096 or any(ord(c) < 32 for c in secret):
            raise MarketplaceError('INVALID_PAYMENT_REFERENCE')
        payload = {'clientSecret': secret}
        path = PAYMENT + ('complete' if name == 'payment_complete' else 'status')
        mutation = name == 'payment_complete'
        if mutation:
            payload.update(orderNumber=order_id, paymentMethodCode='cc_noonpay',
                           idCustomerToken=_id(args.pop('card_token')))
            encrypted = args.pop('cvv_encryption', None)
            if encrypted is not None:
                if not isinstance(encrypted, dict) or set(encrypted) != {'encCvv', 'publicKeyName'}:
                    raise MarketplaceError('INVALID_CVV_ENCRYPTION')
                if any(not isinstance(v, str) or not v or len(v) > 8192 or any(ord(c)<32 for c in v)
                       for v in encrypted.values()):
                    raise MarketplaceError('INVALID_CVV_ENCRYPTION')
                payload['cvvEncryption'] = dict(encrypted)
            provider = args.pop('payment_provider_code', None)
            if provider is not None:
                payload['paymentProviderCode'] = _id(provider)
    else:
        raise MarketplaceError('UNMAPPED_OPERATION')
    if args:
        raise MarketplaceError('UNMAPPED_ARGUMENT')
    return Operation(service, name, method, host, path, _json(payload) if payload is not None else None,
                     mutation, order_id)


@dataclass(repr=False)
class Response:
    """RAM-only response. ``data`` can contain payment secrets; never serialize it."""
    operation: Operation
    http_status: int
    data: object = field(repr=False)
    observed_at: float = field(default_factory=time.time)

    def __repr__(self):
        return f'Response(operation={self.operation!r}, http_status={self.http_status})'

    @property
    def digest(self):
        return fingerprint([self.operation.service, self.operation.name, self.data])

    def summary(self):
        out = {'service': self.operation.service, 'operation': self.operation.name,
               'http_status': self.http_status, 'observed_at': self.observed_at,
               'digest': self.digest, 'purchase_confirmed': False}
        if self.operation.name == 'place':
            out.update(order=_order(self.data), state='order_number_received_payment_unconfirmed')
        elif self.operation.name in ('order_status', 'payment_complete', 'payment_status'):
            out.update(outcome(self.operation.name, self.data))
            out['order'] = self.operation.order_id
        elif self.operation.name == 'cart':
            out.update(cart_projection(self.data))
        elif self.operation.name == 'order_detail':
            order = self.operation.path.rsplit('/', 1)[1]
            out.update(tracking.manifest_projection(self.data, order))
            out['service'] = self.operation.service
            out['experience_provenance'] = 'caller_bound; detail_endpoint_is_shared'
        elif isinstance(self.data, dict):
            out['response_keys'] = sorted(self.data)
            out['checkout_projection_complete'] = False
        return out


def outcome(name, data):
    if not isinstance(data, dict):
        raise MarketplaceError('RESPONSE_SCHEMA_CHANGED')
    raw = data.get('status')
    state = 'unknown'
    if name == 'order_status':
        if raw == 'pending':
            state = 'payment_completion_required' if data.get('clientSecret') else 'pending'
        elif raw == 'failed':
            state = 'failed'
    else:
        state = {'payment_pending': 'pending', 'payment_ready_to_redirect': 'challenge_required',
                  'payment_confirmed': 'payment_confirmed', 'payment_failed': 'failed',
                  'payment_cancelled': 'cancelled'}.get(raw, 'unknown') if isinstance(raw, str) else 'unknown'
    return {'state': state, 'raw_status': raw if isinstance(raw, str) and re.fullmatch(r'[a-z_]{1,64}', raw) else None,
            'has_client_secret': bool(data.get('clientSecret')),
            'has_redirect': bool(data.get('redirect_url')), 'resend_allowed': False}


def cart_projection(data):
    if not isinstance(data, dict) or not isinstance(data.get('items'), list) or not isinstance(data.get('offers'), list):
        raise MarketplaceError('CART_SCHEMA_CHANGED')
    rows = []
    raw_rows=data['items']
    if 'groups' in data:
        from noon_marketplace_native_shape import _flatten
        raw_rows=[row for _,_,row in _flatten(data,'groups','SCHEMA_CART_ROWS')]
    for row in raw_rows:
        if not isinstance(row, dict):
            raise MarketplaceError('CART_SCHEMA_CHANGED')
        # Native display fields only; seller/fulfillment identity is not inferred
        # from a title or the fact that both experiences use this cart namespace.
        entry = {k: row[k] for k in ('offerCode', 'variantKey', 'quantity', 'isSelectedForCheckout') if k in row}
        for k in ('offerCode', 'variantKey'):
            if k in entry:
                _id(entry[k], blank=k == 'variantKey')
        if 'quantity' in entry:
            _quantity(entry['quantity'])
        if 'isSelectedForCheckout' in entry:
            _bool(entry['isSelectedForCheckout'])
        entry['identity_digest'] = fingerprint(row)
        rows.append(entry)
    count = data.get('count')
    if type(count) is not int or count < 0:
        raise MarketplaceError('CART_SCHEMA_CHANGED')
    return {'count': count, 'items': rows, 'empty': count == 0 and not rows and not data['offers'],
            'has_rocket_tab': isinstance(data.get('rocketTab'), dict),
            'populated_manifest_live_validated': False}


def selection_payload(cart, changes):
    """Apply explicit selection changes to the full returned selectable inventory."""
    try:
        rows = cart['partialCheckout']['selectableOffers']
    except (KeyError, TypeError):
        raise MarketplaceError('PARTIAL_CHECKOUT_UNAVAILABLE') from None
    if not isinstance(rows, list) or not isinstance(changes, dict):
        raise MarketplaceError('INVALID_SELECTION')
    result, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise MarketplaceError('INVALID_SELECTION')
        key = (_id(row.get('offerCode')), _id(row.get('variantKey'), blank=True))
        if key in seen:
            raise MarketplaceError('DUPLICATE_OFFER')
        seen.add(key)
        result.append({'offerCode': key[0], 'variantKey': key[1],
                       'isSelected': _bool(changes[key] if key in changes else row.get('isSelected'))})
    if set(changes) - seen:
        raise MarketplaceError('SELECTION_OFFER_NOT_FOUND')
    return result


def assert_preserved(before, after, changed=()):
    """Check complete returned item inventories; never auto-clear or roll back."""
    def inventory(data):
        rows = data.get('items')
        if 'groups' in data:
            from noon_marketplace_native_shape import _flatten
            rows=[row for _,_,row in _flatten(data,'groups','SCHEMA_CART_ROWS')]
        if not isinstance(rows, list):
            raise MarketplaceError('CART_SCHEMA_CHANGED')
        out = {}
        for row in rows:
            if not isinstance(row, dict):
                raise MarketplaceError('CART_SCHEMA_CHANGED')
            key = (_id(row.get('offerCode')), _id(row.get('variantKey', ''), blank=True))
            if key in out:
                raise MarketplaceError('DUPLICATE_OFFER')
            out[key] = _quantity(row.get('quantity'))
        return out
    left, right, permitted = inventory(before), inventory(after), set(changed)
    if {k:v for k,v in left.items() if k not in permitted} != {k:v for k,v in right.items() if k not in permitted}:
        raise MarketplaceError('OWNER_BASKET_CHANGED')
    return True


def _headers(headers, service):
    if not isinstance(headers, dict) or not 0 < len(headers) <= 100:
        raise MarketplaceError('ACCOUNT_HEADERS_REQUIRED')
    cleaned = {}
    for key, value in headers.items():
        if (not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,100}', key)
                or not isinstance(value, str) or len(value) > 16000
                or any(ord(c) < 32 or ord(c) == 127 for c in value)):
            raise MarketplaceError('INVALID_HEADERS')
        if key.lower() in cleaned:
            raise MarketplaceError('DUPLICATE_HEADER')
        cleaned[key.lower()] = value
    for key in ('host', 'content-length', 'connection', 'if-none-match', 'if-modified-since',
                'accept-encoding', 'baggage', 'sentry-trace'):
        cleaned.pop(key, None)
    cleaned.update({'x-mp': 'noon', 'x-experience': EXPERIENCES[service],
                    'accept': 'application/json', 'content-type': 'application/json', 'accept-encoding': 'identity'})
    return cleaned


@dataclass(frozen=True)
class ResponseObservation:
    """RAM-only response metadata, captured before body read or status handling."""
    response_url: str = field(repr=False)
    http_status: int
    set_cookies: tuple = field(repr=False)


def _observe_response(response, observer):
    observer(ResponseObservation(response.geturl(), response.code,
                                 tuple(response.headers.get_all('Set-Cookie', []))))


def _http_error(status):
    return {401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 429: 'RATE_LIMITED'}.get(status, 'HTTP_' + str(status))


def _response_error(op, response, deadline):
    code = _http_error(response.code)
    if op.name == 'order_status' and response.code == 400:
        # Checkout records can disappear while order-v2 still has a paid,
        # undelivered order. Recognize only the observed error, never a generic
        # 400/404. Decode bounded gzip/JSON in RAM; don't retain upstream bodies.
        try:
            with core.read_deadline(deadline):
                data = decode(response.read(MAX_BYTES + 1))
            error = data.get('error') if isinstance(data, dict) else None
            if (isinstance(error, dict) and type(error.get('code')) is int
                    and error['code'] == 404 and error.get('message') == 'Order not found'):
                return 'CHECKOUT_ORDER_NOT_FOUND'
        except (MarketplaceError, core.NoonError, OSError, http.client.HTTPException):
            pass
    return code


def native_request(op, headers, deadline, *, response_observer):
    """One send. Observe every repeated Set-Cookie verbatim before decode/errors.

    The observer captures in RAM only. The client journals mutation receipts before
    invoking the caller's auth-retention hook, including on parse and HTTP errors.
    """
    req = urllib.request.Request('https://' + op.host + op.path,
                                 headers=_headers(headers, op.service), method=op.method, data=op.body)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), core.NoRedirect())
    try:
        with core.read_deadline(deadline) as left:
            with opener.open(req, timeout=left) as response:
                _observe_response(response, response_observer)
                if not 200 <= response.code < 300:
                    raise MarketplaceError(_http_error(response.code), http_status=response.code)
                return decode(response.read(MAX_BYTES + 1))
    except urllib.error.HTTPError as exc:
        try:
            _observe_response(exc, response_observer)
            code = _response_error(op, exc, deadline)
        finally:
            exc.close()
        raise MarketplaceError(code, http_status=exc.code) from None


class MarketplaceClient:
    """Sequential, one-account/experience client; all durable state is caller-owned.

    header_provider(operation, deadline) is REQUIRED on every call; it must check
    the current account/auth/address snapshot and return fresh verified headers.
    before_send(metadata) must atomically consume the exact durable intent and mark
    MAY_HAVE_SENT, then return exactly True. receipt(record) must durably store the
    allowlisted receipt AND journal the outcome before acknowledging with True.
    response_cookies(operation_name, values, *, response_url, http_status,
    outcome_journaled) must return True. For mutations it may retain auth durably
    only when outcome_journaled=True; otherwise retain rotation in RAM for repair.

    request(operation, headers, deadline, *, response_observer) is injectable and
    must observe before reading/decoding, including HTTPError. No retries occur.
    Mutation digests, placement and each order's payment are consumed at most once
    per instance. Unknown/receipt/cookie/challenge failures fence later writes;
    the parent journal enforces these constraints across restarts. Fresh review,
    cart preservation and purchase authorization remain before_send obligations.
    """
    def __init__(self, service, *, header_provider, before_send=None, receipt=None,
                 response_cookies=None, request=native_request):
        if service not in EXPERIENCES:
            raise MarketplaceError('INVALID_SERVICE')
        if not callable(header_provider):
            raise MarketplaceError('HEADER_PROVIDER_REQUIRED')
        self.service = service
        self._header_provider, self._before_send = header_provider, before_send
        self._receipt, self._response_cookies, self._request = receipt, response_cookies, request
        self._mutation_fenced = False
        self._consumed = set()
        self._placed_order = None
        self._payment_bindings = {}  # order -> (secret hash, observed_at), RAM only
        self._lock = threading.Lock()
        self._last_response = None  # RAM only; never serialize raw payment data.

    def __repr__(self):
        return f'MarketplaceClient(service={self.service!r})'

    def call(self, name, *, timeout=20, deadline=None, **args):
        if not self._lock.acquire(blocking=False):
            raise MarketplaceError('CLIENT_BUSY')
        try:
            return self._call(name, timeout=timeout, deadline=deadline, **args)
        finally:
            self._lock.release()

    def _call(self, name, *, timeout, deadline, **args):
        try:
            op = operation(self.service, name, **args)
        except KeyError:
            raise MarketplaceError('MISSING_ARGUMENT') from None
        key = ('place' if name == 'place' else ('payment', op.order_id)
               if name == 'payment_complete' else op.digest)
        if op.mutation:
            if self._mutation_fenced:
                raise MarketplaceError('MUTATION_FENCED')
            if key in self._consumed:
                raise MarketplaceError('MUTATION_ALREADY_CONSUMED')
            if not callable(self._before_send):
                raise MarketplaceError('PARENT_JOURNAL_REQUIRED')
            if not callable(self._receipt):
                raise MarketplaceError('RESPONSE_RECEIPT_REQUIRED')
        if not callable(self._response_cookies):
            raise MarketplaceError('RESPONSE_COOKIES_REQUIRED')
        if name in ('payment_complete', 'payment_status'):
            secret = json.loads(op.body)['clientSecret']
            binding = self._payment_bindings.get(op.order_id)
            if (binding is None or binding[0] != fingerprint(secret)
                    or not 0 <= time.time() - binding[1] <= 60
                    or self._placed_order is not None and self._placed_order != op.order_id):
                raise MarketplaceError('PAYMENT_ORDER_BINDING_REQUIRED')
        if name == 'order_status':
            self._payment_bindings.pop(op.order_id, None)
        try:
            end = core.operation_deadline(timeout, deadline)
            headers = _headers(self._header_provider(op, end), self.service)
            core.remaining(end)
        except Exception:
            raise MarketplaceError('AUTH_HEADERS_FAILED') from None
        sent = False
        if op.mutation:
            # Fence before invoking the reservation: a throwing callback may have
            # already consumed its durable intent. Only an explicit denial resets.
            self._mutation_fenced = True
            try:
                accepted = self._before_send({'service': op.service, 'operation': name,
                    'request_digest': op.digest, 'order_id': op.order_id})
            except Exception:
                raise MarketplaceError('PARENT_JOURNAL_RESERVATION_FAILED') from None
            if accepted is not True:
                self._mutation_fenced = False
                raise MarketplaceError('PARENT_JOURNAL_RESERVATION_DENIED')
            self._consumed.add(key)
            sent = True
        observations = []
        expected_url = 'https://' + op.host + op.path

        def observe(value):
            if type(value) is not ResponseObservation:
                raise MarketplaceError('RESPONSE_OBSERVATION_INVALID')
            observations.append(value)
            if len(observations) != 1:
                raise MarketplaceError('MULTIPLE_RESPONSES_DENIED')
            if value.response_url != expected_url:
                raise MarketplaceError('RESPONSE_URL_MISMATCH')
            if type(value.http_status) is not int or not 100 <= value.http_status <= 599:
                raise MarketplaceError('HTTP_STATUS_INVALID')
            if not isinstance(value.set_cookies, tuple) or not all(isinstance(v, str) for v in value.set_cookies):
                raise MarketplaceError('RESPONSE_COOKIES_INVALID')

        data = error = result = None
        try:
            core.remaining(end)
            data = self._request(op, headers, end, response_observer=observe)
            self._last_response = (op, data)
            core.remaining(end)
            if len(observations) != 1:
                raise MarketplaceError('RESPONSE_OBSERVATION_REQUIRED')
            status = observations[0].http_status
            if not 200 <= status < 300:
                raise MarketplaceError(_http_error(status))
            if name == 'place':
                _order(data)  # Native response.data itself, never an orderNr envelope.
            elif not isinstance(data, dict):
                raise MarketplaceError('RESPONSE_SCHEMA_CHANGED')
            if isinstance(data, dict):
                if data.get('error') or data.get('errors') or data.get('error_modal') or data.get('success') is False:
                    raise MarketplaceError('APPLICATION_ERROR')
                if op.order_id:
                    for field_name in ('orderNumber', 'orderNr', 'order_nr'):
                        if field_name in data and data[field_name] != op.order_id:
                            raise MarketplaceError('ORDER_MISMATCH')
            fingerprint(data)  # Reject noncanonical injected data before receipt/cookie processing.
            result = Response(op, status, data)
        except MarketplaceError as exc:
            error = exc.code
        except Exception:
            error = 'TRANSPORT_OUTCOME_UNKNOWN' if sent else 'READ_FAILED'

        record, journaled = None, False
        if op.mutation:
            record = self._response_receipt(op, observations, data, error)
            try:
                journaled = self._receipt(json.loads(_json(record))) is True
            except Exception:
                pass
            if not journaled:
                error = 'RESPONSE_RECEIPT_FAILED'
        # Rotation is delivered even on decode/status/receipt failures. The flag
        # distinguishes journaled outcomes from RAM-only repair observations.
        for observation in observations:
            try:
                accepted = self._response_cookies(name, observation.set_cookies,
                    response_url=observation.response_url, http_status=observation.http_status,
                    outcome_journaled=journaled)
                if accepted is not True:
                    raise MarketplaceError('RESPONSE_COOKIES_FAILED')
            except Exception:
                self._mutation_fenced = True
                if error != 'RESPONSE_RECEIPT_FAILED':
                    error = 'RESPONSE_COOKIES_FAILED'
        if error:
            raise MarketplaceError(error, http_status=observations[0].http_status if observations else None,
                                   may_have_sent=sent, receipt=record, outcome_journaled=journaled) from None
        if name == 'place':
            self._placed_order = data
        if name == 'order_status':
            # Supersede previous status snapshots even when the secret disappears.
            self._payment_bindings.pop(op.order_id, None)
            secret = data.get('clientSecret')
            if (data.get('status') == 'pending' and isinstance(secret, str)
                    and 1 <= len(secret) <= 4096 and not any(ord(c) < 32 for c in secret)):
                digest = fingerprint(secret)
                if any(v[0] == digest and k != op.order_id for k, v in self._payment_bindings.items()):
                    self._mutation_fenced = True
                    raise MarketplaceError('PAYMENT_ORDER_MISMATCH')
                self._payment_bindings[op.order_id] = (digest, time.time())
        if op.mutation and record['outcome'] not in ('UNKNOWN', 'CHALLENGE_REQUIRED'):
            self._mutation_fenced = False
        return result

    @staticmethod
    def _response_receipt(op, observations, data, error):
        state, order_id = ('UNKNOWN' if error else 'RESPONSE_RECEIVED'), op.order_id
        if op.name == 'place':
            try:
                order_id = _order(data)
            except MarketplaceError:
                order_id = None
            if not error:
                state = 'ORDER_ID_RECEIVED'
        if op.name == 'payment_complete' and not error:
            payment = outcome(op.name, data)
            if payment['has_redirect'] or payment['state'] == 'challenge_required':
                state = 'CHALLENGE_REQUIRED'
            elif payment['state'] in ('unknown', 'failed', 'cancelled'):
                state = 'UNKNOWN'
        record = {'service': op.service, 'operation': op.name, 'request_sha256': op.digest,
                  'request_url': 'https://' + op.host + op.path,
                  'http_status': observations[0].http_status if observations else None,
                  'outcome': state, 'error_code': error, 'order_id': order_id,
                  'projection_sha256': fingerprint(data) if not error else None}
        record['evidence_hash'] = fingerprint(record)
        return record

    def cart(self, **kwargs):
        return self.call('cart', **kwargs)

    def session(self, **kwargs):
        return self.call('session', **kwargs)

    def order_status(self, order, **kwargs):
        return self.call('order_status', order=order, **kwargs)

    def track(self, order, **kwargs):
        return self.call('order_detail', order=order, **kwargs).summary()
