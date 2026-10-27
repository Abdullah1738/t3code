"""Native Minutes checkout transport, using caller-owned auth and send journal.

Wire contracts are decoded from the Android InstantSessionService and
InstantCheckoutService. Session operations are POSTs and require explicit
before_send and receipt hooks, including session/get. Response cookies go only
to the caller's RAM callback, after the outcome receipt attempt. There are no
implicit cart edits, auth refreshes, retries, or automatic payment continuations.
"""
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import html
import http.client
import json
import re
import time
import urllib.error
import urllib.request
import urllib.parse
import zlib

import noon_http_orders as tracking
from noon_checkout import AccountHome, fingerprint


HOST = 'api-app-instant.noon.com'
MAX_BYTES = 2_000_000
QUIET_NOTE = "Leave at door. Don't ring bell. Don't call."
ROUTES = {
    'catalog_search': ('GET', HOST, '/_svc/catalog/search'),
    'session_get': ('POST', HOST, '/_svc/instant/session/get'),
    'sync': ('POST', HOST, '/_svc/instant/session/sync'),
    'instructions': ('POST', HOST, '/_svc/instant/session/delivery-instructions/set'),
    'payment': ('POST', HOST, '/_svc/instant/session/payment/set-method'),
    'place': ('POST', HOST, '/_svc/instant/order/place'),
    'order_get': ('POST', HOST, '/_svc/instant/order/get'),
    'order_get_active': ('POST', HOST, '/_svc/instant/order/get-active'),
    'track': ('POST', HOST, '/_svc/instant/order/track'),
    'orders': ('POST', HOST, '/_svc/instant/order/list'),
    'payment_config': ('GET', HOST, '/_svc/mp-payment-public/config'),
    'payment_cards': ('GET', 'api-app.noon.com', '/_svc/customer-v1/customer/paymentcards'),
    'payment_complete': ('POST', 'api-app-st.noon.com', '/_svc/mp-payment-api-public/paymentintent/complete'),
    'payment_status': ('POST', 'api-app-st.noon.com', '/_svc/mp-payment-api-public/paymentintent/status'),
}
WRITES = frozenset({'session_get', 'sync', 'instructions', 'payment', 'place', 'payment_complete'})
IDENTIFIER = re.compile(r'[A-Za-z0-9_.:-]{1,180}')


class MinutesError(Exception):
    def __init__(self, code, *, may_have_sent=False, receipt=None, outcome_journaled=False):
        if not isinstance(code, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code):
            code = 'REQUEST_FAILED'
        self.code = code
        self.may_have_sent = may_have_sent
        # Allowlisted recovery evidence only; cookies travel solely via callbacks.
        self.receipt = receipt
        self.outcome_journaled = outcome_journaled
        super().__init__(code)


def require(condition, code):
    if not condition:
        raise MinutesError(code)


def ident(value):
    require(isinstance(value, str) and bool(IDENTIFIER.fullmatch(value)), 'INVALID_IDENTIFIER')
    return value


def amount_minor(value):
    """Noon display/checkout money is in major currency units, never binary math."""
    require(type(value) in (int, float, str, Decimal), 'INVALID_AMOUNT')
    try:
        number = Decimal(str(value))
        require(number.is_finite() and abs(number) <= 1_000_000, 'INVALID_AMOUNT')
        minor = number * 100
        require(minor == minor.to_integral_value(), 'INVALID_AMOUNT_PRECISION')
        return int(minor)
    except (InvalidOperation, ValueError, OverflowError):
        raise MinutesError('INVALID_AMOUNT') from None


def wire_amount(minor):
    require(type(minor) is int and minor >= 0, 'INVALID_AMOUNT')
    return minor // 100 if minor % 100 == 0 else minor / 100


def safe_text(value, limit=500):
    if value is None:
        return None
    require(isinstance(value, str) and len(value) <= 4000, 'TEXT_SCHEMA_CHANGED')
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value))).strip()[:limit]


def _duplicate_free(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, 'DUPLICATE_JSON_KEY')
        out[key] = value
    return out


def decode_response(raw):
    require(len(raw) <= MAX_BYTES, 'RESPONSE_TOO_LARGE')
    if raw[:2] == b'\x1f\x8b':
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(raw, MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES and not decoder.unconsumed_tail, 'RESPONSE_TOO_LARGE')
        require(decoder.eof and not decoder.unused_data, 'INVALID_GZIP')
    try:
        data = json.loads(raw, object_pairs_hook=_duplicate_free, parse_float=Decimal,
                          parse_constant=lambda _: (_ for _ in ()).throw(MinutesError('INVALID_JSON_NUMBER')))
    except (ValueError, RecursionError, UnicodeError):
        raise MinutesError('INVALID_JSON') from None
    require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
    return data


def _headers(headers):
    require(isinstance(headers, dict) and 0 < len(headers) <= 100, 'INVALID_HEADERS')
    out = {}
    for key, value in headers.items():
        require(isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9-]{1,100}', key)
                and isinstance(value, str) and len(value) <= 16000
                and not any(ord(c) < 32 or ord(c) == 127 for c in value), 'INVALID_HEADERS')
        key = key.lower()
        require(key not in out, 'DUPLICATE_HEADER')
        out[key] = value
    for key in ('host', 'content-length', 'accept-encoding', 'connection', 'if-none-match',
                'if-modified-since', 'sentry-trace', 'baggage'):
        out.pop(key, None)
    out.update({'accept': 'application/json', 'content-type': 'application/json', 'accept-encoding': 'identity'})
    return out


def _json(payload):
    try:
        encoded = json.dumps(payload, allow_nan=False, sort_keys=True, separators=(',', ':')).encode()
    except (TypeError, ValueError, RecursionError):
        raise MinutesError('INVALID_PAYLOAD') from None
    require(len(encoded) <= 100_000, 'PAYLOAD_TOO_LARGE')
    return encoded


@dataclass(frozen=True)
class ResponseObservation:
    """RAM-only metadata captured before reading or interpreting a response body."""
    response_url: str = field(repr=False)
    http_status: int
    set_cookies: tuple = field(repr=False)


def _observe_response(response, observer):
    observation = ResponseObservation(response.geturl(), response.code,
                                      tuple(response.headers.get_all('Set-Cookie', [])))
    try:
        observer(observation)
    except Exception:
        raise MinutesError('RESPONSE_OBSERVATION_FAILED') from None


def native_request(route, headers, deadline, payload, *, response_observer, query=None):
    """One request; response_observer(observation) runs before read/decode/errors.

    The observer must capture metadata in RAM, not retain auth yet: mutation
    outcomes must be journaled first. It receives every repeated Set-Cookie field
    verbatim (never comma-split), the actual response URL and HTTP status, including
    HTTPError responses. No response means no observation. Exceptions are redacted.
    """
    require(route in ROUTES, 'ENDPOINT_DENIED')
    require(callable(response_observer), 'RESPONSE_OBSERVER_REQUIRED')
    method, host, path = ROUTES[route]
    if query is not None:
        require(route == 'catalog_search' and payload is None and isinstance(query,dict)
                and set(query) == {'q', 'page', 'rows', 'productsOnly'}
                and isinstance(query['q'], str) and 0 < len(query['q']) <= 200
                and query['page'] == 1 and query['rows'] == 50 and query['productsOnly'] == '1',
                'INVALID_CATALOG_QUERY')
        path += '?' + urllib.parse.urlencode(query)
    encoded = _json(payload) if payload is not None else None
    req = urllib.request.Request('https://' + host + path, headers=_headers(headers),
                                 method=method, data=encoded)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), tracking.NoRedirect())
    try:
        with tracking.read_deadline(deadline) as left:
            with opener.open(req, timeout=left) as response:
                _observe_response(response, response_observer)
                data = decode_response(response.read(MAX_BYTES + 1))
        return data
    except urllib.error.HTTPError as exc:
        try:
            _observe_response(exc, response_observer)
            code = exc.code
        finally:
            exc.close()
        raise MinutesError({401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 429: 'RATE_LIMITED',
                            404: 'NOT_FOUND'}.get(code, 'HTTP_' + str(code))) from None
    except tracking.NoonError:
        raise MinutesError('REQUEST_TIMEOUT') from None
    except MinutesError:
        raise
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException, zlib.error):
        raise MinutesError('REQUEST_FAILED') from None


def _application_ok(data):
    require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
    require(data.get('success') is not False and not data.get('error') and not data.get('errors')
            and not data.get('error_modal'), 'APPLICATION_REJECTED')


def sku_line(sku, quantity, *, modifiers=(), atc_source=None, deal_code=None):
    require(type(quantity) is int and 0 <= quantity, 'INVALID_QUANTITY')
    require(isinstance(modifiers, (tuple, list)) and len(modifiers) <= 30, 'INVALID_MODIFIERS')
    out = {'sku': ident(sku), 'qty': quantity, 'modifiers': [ident(x) for x in modifiers]}
    require(len(out['modifiers']) == len(set(out['modifiers'])), 'DUPLICATE_MODIFIER')
    if atc_source is not None:
        out['atcSource'] = ident(atc_source)
    if deal_code is not None:
        require(quantity == 1, 'DEAL_QUANTITY_MUST_BE_ONE')
        out['dealCode'] = ident(deal_code)
    return out


def _skus(lines):
    require(isinstance(lines, (tuple, list)), 'INVALID_LINES')
    out, seen = [], set()
    for row in lines:
        require(isinstance(row, dict) and {'sku', 'qty', 'modifiers'} <= set(row)
                and set(row) <= {'sku', 'qty', 'modifiers', 'atcSource', 'dealCode'}, 'INVALID_LINE')
        item = sku_line(row['sku'], row['qty'], modifiers=row['modifiers'],
                        atc_source=row.get('atcSource'), deal_code=row.get('dealCode'))
        key = (item['sku'], tuple(sorted(item['modifiers'])), item.get('dealCode'))
        require(key not in seen, 'DUPLICATE_LINE')
        seen.add(key)
        out.append(item)
    return out


def _bundles(bundles):
    require(isinstance(bundles, (tuple, list)) and len(bundles) <= 20, 'INVALID_BUNDLES')
    out = []
    for bundle in bundles:
        require(isinstance(bundle, dict) and set(bundle) == {'campaign', 'items', 'qty'}, 'INVALID_BUNDLE')
        require(type(bundle['qty']) is int and bundle['qty'] >= 0, 'INVALID_QUANTITY')
        require(isinstance(bundle['items'], list) and 0 < len(bundle['items']) <= 30, 'INVALID_BUNDLE_ITEMS')
        items = []
        for item in bundle['items']:
            require(isinstance(item, dict) and set(item) == {'code', 'sku', 'modifiers'}, 'INVALID_BUNDLE_ITEM')
            line = sku_line(item['sku'], 1, modifiers=item['modifiers'])
            items.append({'code': ident(item['code']), 'sku': line['sku'], 'modifiers': line['modifiers']})
        out.append({'campaign': ident(bundle['campaign']), 'items': items, 'qty': bundle['qty']})
    require(len({_json(b).decode() for b in out}) == len(out), 'DUPLICATE_BUNDLE')
    return out


def delivery_preferences(data):
    """Response is [{code,value,...}], request is {code:value}; no guessed codes."""
    require(isinstance(data, list) and len(data) <= 30, 'PREFERENCES_SCHEMA_CHANGED')
    out = []
    for pref in data:
        require(isinstance(pref, dict) and type(pref.get('value')) is bool, 'PREFERENCES_SCHEMA_CHANGED')
        out.append({'code': ident(pref.get('code')), 'value': pref['value'],
                    'title': safe_text(pref.get('title'))})
    require(len({p['code'] for p in out}) == len(out), 'DUPLICATE_PREFERENCE')
    return out


def project_summary(data):
    """Preserve every display entry. HTML fee labels do not imply numeric amounts."""
    require(isinstance(data, list) and len(data) <= 40, 'SUMMARY_SCHEMA_CHANGED')
    out = []
    for group in data:
        require(isinstance(group, dict) and isinstance(group.get('entries'), list)
                and len(group['entries']) <= 40, 'SUMMARY_SCHEMA_CHANGED')
        for entry in group['entries']:
            require(isinstance(entry, dict), 'SUMMARY_SCHEMA_CHANGED')
            out.append({'title': safe_text(entry.get('title')), 'value': safe_text(entry.get('value'))})
    return out


def _optional_amount(data, key):
    return amount_minor(data[key]) if data.get(key) is not None else None


def project_session(data):
    _application_ok(data)
    require(isinstance(data.get('items'), list), 'ITEMS_SCHEMA_CHANGED')
    lines = []
    for row in data['items']:
        require(isinstance(row, dict), 'ITEMS_SCHEMA_CHANGED')
        require(type(row.get('qty')) is int and 0 <= row['qty'], 'QUANTITY_SCHEMA_CHANGED')
        line = {'sku': ident(row.get('sku')), 'quantity': row['qty'], 'title': safe_text(row.get('title')),
                'item_code': row.get('itemCode'), 'cart_line_type': row.get('cartLineType'),
                'deal_code': row.get('dealCode'), 'is_freebie': row.get('isFreebie'),
                'price_minor': _optional_amount(row, 'price'),
                'offer_price_minor': _optional_amount(row, 'offerPrice'),
                'sale_price_minor': _optional_amount(row, 'salePrice'),
                'qty_max': row.get('qtyMax')}
        for key in ('item_code', 'cart_line_type', 'deal_code'):
            if line[key] is not None:
                ident(line[key])
        selected = row.get('selectedModifiers', {})
        if (selected is None and row.get('isCustomizable') in (None, False)
                and not row.get('nameCustomizationParent') and not row.get('fileCode')):
            selected = {}
        require(isinstance(selected, dict) and len(selected) <= 30, 'MODIFIERS_SCHEMA_CHANGED')
        modifiers = []
        for values in selected.values():
            require(isinstance(values, list), 'MODIFIERS_SCHEMA_CHANGED')
            modifiers.extend(ident(v) for v in values)
        require(len(modifiers) <= 30, 'MODIFIERS_SCHEMA_CHANGED')
        line['modifiers'] = modifiers
        # Bundles and special line kinds remain explicit; never drop them from review.
        line['bundle_present'] = row.get('bundle') is not None
        require(line['is_freebie'] is None or type(line['is_freebie']) is bool, 'ITEMS_SCHEMA_CHANGED')
        require(line['qty_max'] is None or type(line['qty_max']) is int, 'ITEMS_SCHEMA_CHANGED')
        lines.append(line)
    mask = data.get('creditCardMask')
    last4 = re.search(r'(\d{4})$', mask).group(1) if isinstance(mask, str) and re.search(r'(\d{4})$', mask) else None
    payment = {'method': data.get('paymentMethodCode'), 'last4': last4,
               'network': data.get('ccType'), 'token_ref': fingerprint(str(data['paymentToken'])) if data.get('paymentToken') else None,
               'wallet_minor': _optional_amount(data, 'walletAmount'),
               'charge_minor': _optional_amount(data, 'orderPaymentAmount'),
               'cvv_required': data.get('isCvvRequired'), 'verify_device': data.get('verifyDevice'),
               'emi_selected': data.get('idEmiPlan') not in (None, '', 0)}
    for key in ('method', 'network'):
        if payment[key] is not None:
            ident(payment[key])
    for key in ('cvv_required', 'verify_device'):
        require(payment[key] is None or type(payment[key]) is bool, 'PAYMENT_SCHEMA_CHANGED')
    total = _optional_amount(data, 'orderTotal')
    subtotal = _optional_amount(data, 'orderSubtotal')
    require(data.get('currencyCode') in (None, 'AED', 'aed'), 'CURRENCY_MISMATCH')
    require(data.get('isShutdown') is None or type(data['isShutdown']) is bool, 'SESSION_SCHEMA_CHANGED')
    return {'service': 'minutes', 'currency': data.get('currencyCode'), 'lines': lines,
            'subtotal_minor': subtotal, 'total_minor': total,
            'summary': project_summary(data['orderSummary']) if 'orderSummary' in data else None,
            'summary_v2': project_summary(data['orderSummaryRows']) if 'orderSummaryRows' in data else None,
            'payment': payment,
            'delivery_preferences': delivery_preferences(data['deliveryPreferences']) if 'deliveryPreferences' in data else None,
            'driver_notes': safe_text(data.get('driverNotes')),
            'is_shutdown': data.get('isShutdown'), 'bundle_oos_present': bool(data.get('bundleOOS')),
            'warehouse_binding': 'selected_address_headers; warehouse_not_in_sync_body',
            'offer_binding': 'server_selected_sku_offer; offer_code_not_in_sync_body',
            'amounts_source': 'instant_session_major_currency_units',
            'complete_fee_arithmetic_verified': False}


@dataclass(frozen=True)
class SavedCard:
    token: str = field(repr=False)
    mask: str = field(repr=False)
    network: str

    def validate(self):
        require(isinstance(self.token, str) and 0 < len(self.token) <= 1000
                and self.token.strip() == self.token, 'INVALID_CARD_TOKEN')
        require(isinstance(self.mask, str) and len(self.mask) <= 40
                and bool(re.fullmatch(r'[0-9xX*• .-]*5542', self.mask))
                and len(re.sub(r'\D', '', self.mask)) <= 12
                and bool(re.search(r'[xX*•]', self.mask)), 'CARD_MISMATCH')
        require(isinstance(self.network, str) and self.network.lower() == 'mastercard', 'CARD_MISMATCH')


def project_cards(data):
    _application_ok(data)
    rows = data.get('data')
    require(isinstance(rows, list) and len(rows) <= 100, 'CARDS_SCHEMA_CHANGED')
    out = []
    for row in rows:
        require(isinstance(row, dict), 'CARDS_SCHEMA_CHANGED')
        mask = row.get('ccMasked')
        last4 = re.search(r'(\d{4})$', mask).group(1) if isinstance(mask, str) and re.search(r'(\d{4})$', mask) else None
        network = row.get('ccType')
        require(network is None or isinstance(network, str) and bool(IDENTIFIER.fullmatch(network)), 'CARDS_SCHEMA_CHANGED')
        require(all(row.get(k) is None or type(row[k]) is bool for k in ('isDefault', 'isDeleted')), 'CARDS_SCHEMA_CHANGED')
        out.append({'last4': last4, 'network': network.lower() if network else None,
                    'is_default': row.get('isDefault'), 'is_deleted': row.get('isDeleted'),
                    'card_ref': fingerprint(str(row['id'])) if row.get('id') else None})
    return out


def saved_card_5542(data):
    """Select the unique live nondeleted Mastercard, never another default card."""
    projected = project_cards(data)
    matches = [row for row, p in zip(data['data'], projected)
               if p['last4'] == '5542' and p['network'] == 'mastercard' and p['is_deleted'] is False]
    require(len(matches) == 1, 'SAVED_CARD_NOT_UNIQUE')
    row = matches[0]
    card = SavedCard(row.get('id'), row.get('ccMasked'), row.get('ccType'))
    card.validate()
    return card


@dataclass(frozen=True)
class Snapshot:
    """Private wire body is RAM-only; persist only projection, never this object."""
    wire: dict = field(repr=False)
    projection: dict
    observed_at: float

    def selected_card(self):
        card = SavedCard(self.wire.get('paymentToken'), self.wire.get('creditCardMask'), self.wire.get('ccType'))
        card.validate()
        return card


def project_place(data):
    require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
    order = data.get('order_nr')
    require(order is None or isinstance(order, str) and bool(re.fullmatch(r'I[A-Z0-9]{1,63}', order)), 'ORDER_SCHEMA_CHANGED')
    success = data.get('success')
    require(success is None or type(success) is bool, 'RESPONSE_SCHEMA_CHANGED')
    return {'order': order, 'accepted': success is True and order is not None and not data.get('error_modal'),
            'state': 'order_created_payment_unconfirmed' if success is True and order and not data.get('error_modal') else 'reconcile_required',
            'error_modal_present': bool(data.get('error_modal')), 'resend_allowed': False}


def project_order_get(data, order):
    _application_ok(data)
    # The caller binds orderNr in the request. If the response echoes identity,
    # enforce it. An absent echo is reported; exact tracking supplies confirmation.
    echoed = data.get('orderNr', data.get('order_nr'))
    require(echoed is None or echoed == order, 'ORDER_MISMATCH')
    status = data.get('statusCode')
    require(isinstance(status, str) and re.fullmatch(r'[a-z_]{1,64}', status), 'ORDER_STATUS_SCHEMA_CHANGED')
    require(data.get('isPaymentSubscriptionUsed') is None
            or type(data['isPaymentSubscriptionUsed']) is bool, 'PAYMENT_SCHEMA_CHANGED')
    return {'order': order, 'raw_status': status, 'identity_echoed': echoed == order,
            'payment_intent_present': bool(data.get('paymentIntentToken')),
            'payment_error_present': bool(data.get('paymentErrorMsg')),
            'payment_subscription_used': data.get('isPaymentSubscriptionUsed'),
            'state': ('payment_action_required' if status == 'pending' and data.get('paymentIntentToken')
                      else 'confirmed' if status == 'confirmed' else status), 'resend_allowed': False}


def project_payment(data, order):
    _application_ok(data)
    status = data.get('status')
    require(isinstance(status, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', status), 'PAYMENT_STATUS_SCHEMA_CHANGED')
    return {'order': order, 'payment_status': status,
            'redirect_required': bool(data.get('redirect_url')),
            'state': 'human_payment_challenge' if data.get('redirect_url') else 'exact_order_readback_required',
            'resend_allowed': False}


def project_payment_status(data, order, total_minor):
    """paymentintent/status projection; paid needs the exact captured terminal
    triple: payment_confirmed + CAPTURED + authorized==captured==total, error 0."""
    _application_ok(data)
    require(type(total_minor) is int and total_minor > 0, 'INVALID_AMOUNT')
    status = data.get('status')
    require(isinstance(status, str) and re.fullmatch(r'[a-z0-9_]{1,64}', status), 'PAYMENT_STATUS_SCHEMA_CHANGED')
    txn = data.get('transaction_status')
    require(txn is None or (isinstance(txn, str) and re.fullmatch(r'[A-Z0-9_]{1,64}', txn)),
            'PAYMENT_STATUS_SCHEMA_CHANGED')
    reference = data.get('reference')
    require(reference is None or reference == order, 'PAYMENT_REFERENCE_MISMATCH')
    error_code = data.get('error_code')
    require(error_code is None or isinstance(error_code, str), 'PAYMENT_STATUS_SCHEMA_CHANGED')
    failure = data.get('is_3ds_failure')
    require(failure is None or type(failure) is bool, 'PAYMENT_STATUS_SCHEMA_CHANGED')
    authorized = _optional_amount(data, 'authorized_amount')
    captured = _optional_amount(data, 'captured_amount')
    paid = (status == 'payment_confirmed' and txn == 'CAPTURED' and error_code == '0'
            and authorized is not None and captured == authorized == total_minor)
    failed = status in ('payment_failed', 'payment_error') or failure is True
    return {'order': order, 'payment_status': status, 'transaction_status': txn,
            'authorized_minor': authorized, 'captured_minor': captured,
            'error_code': error_code, 'is_3ds_failure': failure,
            'paid': paid, 'redirect_required': bool(data.get('redirect_url')),
            'state': 'paid' if paid else 'payment_failed' if failed else 'payment_in_progress',
            'resend_allowed': False}


def project_active(data):
    """order/get-active readback; any active order stops a new place attempt."""
    _application_ok(data)
    rows = data.get('activeOrders')
    require(isinstance(rows, list) and len(rows) <= 20, 'ACTIVE_SCHEMA_CHANGED')
    out = []
    for row in rows:
        require(isinstance(row, dict), 'ACTIVE_SCHEMA_CHANGED')
        order = row.get('orderNr')
        require(isinstance(order, str) and bool(re.fullmatch(r'I[A-Z0-9]{1,63}', order)),
                'ACTIVE_ORDER_SCHEMA_CHANGED')
        status = row.get('statusCode')
        require(status is None or (isinstance(status, str)
                and re.fullmatch(r'[a-z_]{1,64}', status)), 'ACTIVE_STATUS_SCHEMA_CHANGED')
        out.append({'order': order, 'raw_status': status,
                    'payment_intent_present': bool(row.get('paymentIntentToken'))})
    return {'active': out, 'count': len(out), 'resend_allowed': False}


def review_manifest(lines, expected_skus, *, mismatch='MANIFEST_MISMATCH'):
    """Only explicitly flagged, zero-priced, unrequested gifts may be additional."""
    expected_skus = _skus(expected_skus)
    requested = {x['sku'] for x in expected_skus}
    normal, gifts = [], []
    for row in lines:
        require(not row['bundle_present'] and not row['deal_code']
                and row['cart_line_type'] in (None, 'normal'), 'SPECIAL_LINES_REQUIRE_REVIEW')
        if row['is_freebie'] is True:
            prices = [row[k] for k in ('price_minor', 'offer_price_minor', 'sale_price_minor')]
            require(row['sku'] not in requested and row['quantity'] > 0
                    and row['price_minor'] == 0 and all(x in (None, 0) for x in prices)
                    and not row['modifiers'], 'SPECIAL_LINES_REQUIRE_REVIEW')
            gifts.append(row)
        else:
            normal.append(row)
    actual = sorted((x['sku'], x['quantity'], tuple(sorted(x['modifiers']))) for x in normal)
    expected = sorted((x['sku'], x['qty'], tuple(sorted(x['modifiers']))) for x in expected_skus)
    require(actual == expected and bool(actual), mismatch)
    return normal, gifts


def review_snapshot(snapshot, *, expected_skus, expected_total_minor, required_preferences, card,
                    allow_cvv=False):
    """Check exact review bindings. Parent still reviews all displayed fee rows.

    Preference codes must come from the observed response with known meanings.
    No remote revision, idempotency key, or caller-invented warehouse field exists
    in the decoded order/place body.
    """
    require(isinstance(snapshot, Snapshot) and 0 <= time.time() - snapshot.observed_at <= 60, 'STALE_SESSION')
    require(isinstance(card, SavedCard), 'INVALID_CARD')
    card.validate()
    p = snapshot.projection
    require(p['currency'] in ('AED', 'aed') and p['total_minor'] == expected_total_minor, 'TOTAL_MISMATCH')
    require((p['summary'] is not None or p['summary_v2'] is not None)
            and p['subtotal_minor'] is not None, 'SUMMARY_REQUIRED')
    require(not p['bundle_oos_present'] and p['is_shutdown'] is False, 'CART_NOT_ORDERABLE')
    normal, _ = review_manifest(p['lines'], expected_skus)
    # Merchant per-line cap from the observed cart; None means the server caps silently.
    # Noon gives automatically added gifts qtyMax=0 (not customer-addable).
    for row in normal:
        require(row['qty_max'] is None or row['quantity'] <= row['qty_max'],
                'MERCHANT_QTY_MAX_EXCEEDED')
    payment = p['payment']
    require(payment['method'] == 'cc_noonpay' and payment['last4'] == '5542'
            and str(payment['network']).lower() == 'mastercard' and payment['token_ref'] == fingerprint(card.token)
            and payment['wallet_minor'] == 0 and payment['charge_minor'] == expected_total_minor
            and not payment['emi_selected'], 'PAYMENT_MISMATCH')
    # noon asks for CVV on some carts; complete(cvv=...) encrypts it, so allow_cvv
    # lets the caller accept that ask. verifyDevice challenges are never accepted.
    cvv_ok = payment['cvv_required'] is False or (allow_cvv and payment['cvv_required'] is True)
    require(cvv_ok and payment['verify_device'] is False, 'PAYMENT_CHALLENGE_REQUIRED')
    require(isinstance(required_preferences, (tuple, list)) and p['delivery_preferences'] is not None, 'PREFERENCES_REQUIRED')
    selected = {x['code']: x['value'] for x in p['delivery_preferences']}
    require(all(ident(code) in selected and selected[code] is True for code in required_preferences), 'QUIET_PREFERENCE_MISMATCH')
    require(p['driver_notes'] == QUIET_NOTE, 'QUIET_NOTES_MISMATCH')
    return hashlib.sha256(_json(p)).hexdigest()


class MinutesCheckout:
    """Sequential client with caller-owned verified headers, AccountHome and auth.

    before_send(operation, body_sha256) must durably consume the parent's exact
    intent and mark MAY_HAVE_SENT before returning True. Exceptions and False
    prevent dispatch. A callback success is not evidence of server idempotency.

    receipt(record) is required for mutations and must durably store the minimal
    receipt AND journal its outcome before returning exactly True. On failure the
    consumed send remains unknown; MinutesError.receipt permits local recovery.
    Receipt keys: service, operation, request_sha256, request_url, http_status,
    outcome, error_code, order_id, projection_sha256, evidence_hash. Outcomes are
    RESPONSE_RECEIVED, ORDER_ID_RECEIVED, UNKNOWN or CHALLENGE_REQUIRED; a received
    payment response does not prove payment success. The receipt has no raw body.
    response_cookies(operation, values, *, response_url, http_status,
    outcome_journaled) is required for all calls and must acknowledge with True.
    Values are RAM-only. For mutations, call auth.retain_response_cookies ONLY when
    outcome_journaled is True; otherwise hold in RAM until the journal is repaired.
    Reads have outcome_journaled=False and do not require a mutation journal.

    request(route, headers, deadline, payload, *, response_observer) must invoke
    the observer before body read/decode or HTTP errors, as native_request does.
    header_provider(operation, deadline), when supplied, returns fresh verified
    headers before each reservation; its address must match account_home. The
    trusted caller binds those headers to the same account and auth snapshot.
    Parse/receipt/cookie failures and unknown/challenge outcomes fence later writes
    on this instance. The durable journal must enforce that fence across restart.
    """
    def __init__(self, headers, account_home, *, request=native_request,
                 header_provider=None, receipt=None, response_cookies=None, home_provider=None):
        self._headers = _headers(headers)
        self._home = account_home
        self._request = request
        self._header_provider = header_provider
        self._home_provider = home_provider
        self._receipt = receipt
        self._response_cookies = response_cookies
        self._mutation_fenced = False
        self._last_response = None  # RAM only; exact received data for reconciliation

    def _call(self, route, payload, timeout, before_send=None, *, project=None, order_id=None):
        require(route in ROUTES, 'ENDPOINT_DENIED')
        mutation = route in WRITES
        if mutation:
            require(not self._mutation_fenced, 'MUTATION_FENCED')
            require(callable(before_send), 'SEND_JOURNAL_REQUIRED')
            require(callable(self._receipt), 'RESPONSE_RECEIPT_REQUIRED')
        require(callable(self._response_cookies), 'RESPONSE_COOKIES_REQUIRED')
        try:
            deadline = tracking.operation_deadline(timeout)
        except tracking.NoonError:
            raise MinutesError('INVALID_TIMEOUT') from None
        # A long basket can take over 120 s before its first write. With a
        # home_provider, refresh the verified home first, never accepting a move.
        if self._home_provider and isinstance(self._home, AccountHome) and time.time() - self._home.checked_at > 90:
            fresh = self._home_provider(deadline)
            require(isinstance(fresh, AccountHome) and fresh.service == 'minutes'
                    and fresh.account_ref == self._home.account_ref
                    and fresh.address_ref == self._home.address_ref, 'VERIFIED_ACCOUNT_CHANGED')
            self._home = fresh
        require(isinstance(self._home, AccountHome) and self._home.service == 'minutes'
                and 0 <= time.time() - self._home.checked_at <= 120, 'VERIFIED_ACCOUNT_REQUIRED')
        try:
            headers = _headers(self._header_provider(route, deadline)) if self._header_provider else dict(self._headers)
        except Exception:
            raise MinutesError('AUTH_HEADERS_FAILED') from None
        require(all(headers.get(k) for k in ('x-addresscode', 'x-addresskey')), 'ADDRESS_BINDING_MISMATCH')
        require(self._home.address_ref == fingerprint(headers['x-addresscode'],
                                                      headers['x-addresskey']), 'ADDRESS_BINDING_MISMATCH')
        body = _json(payload) if payload is not None else b''
        # Detach arguments before the journal callback to bind the exact sent body.
        payload = json.loads(body) if payload is not None else None
        digest = hashlib.sha256(body).hexdigest()
        sent = False
        if mutation:
            try:
                accepted = before_send(route, digest)
            except Exception:
                raise MinutesError('SEND_RESERVATION_FAILED') from None
            require(accepted is True, 'SEND_RESERVATION_DENIED')
            sent = True
            self._mutation_fenced = True
        observations = []
        expected_url = 'https://' + ROUTES[route][1] + ROUTES[route][2]

        def observe(observation):
            require(type(observation) is ResponseObservation, 'RESPONSE_OBSERVATION_INVALID')
            observations.append(observation)
            require(len(observations) == 1, 'MULTIPLE_RESPONSES_DENIED')
            require(observation.response_url == expected_url, 'RESPONSE_URL_MISMATCH')
            require(type(observation.http_status) is int and 100 <= observation.http_status <= 599,
                    'HTTP_STATUS_INVALID')
            require(isinstance(observation.set_cookies, tuple)
                    and all(isinstance(v, str) for v in observation.set_cookies), 'RESPONSE_COOKIES_INVALID')

        data = result = error = None
        projection_sha256 = None
        try:
            tracking.remaining(deadline)
            data = self._request(route, headers, deadline, payload, response_observer=observe)
            self._last_response = (route, data)
            tracking.remaining(deadline)
            require(len(observations) == 1, 'RESPONSE_OBSERVATION_REQUIRED')
            require(200 <= observations[0].http_status < 300, 'HTTP_RESPONSE_REJECTED')
            require(isinstance(data, dict), 'RESPONSE_SCHEMA_CHANGED')
            result = project(data) if project else data
            if mutation:
                projection = result.projection if isinstance(result, Snapshot) else result
                projection_sha256 = hashlib.sha256(_json(projection)).hexdigest()
        except MinutesError as exc:
            error = exc.code
        except tracking.NoonError:
            error = 'REQUEST_TIMEOUT'
        except Exception:
            error = 'REQUEST_FAILED'

        record, journaled = None, False
        if mutation:
            record = self._response_receipt(route, digest, observations, data, result, error,
                                            order_id, projection_sha256)
            try:
                # Detach so a sink cannot rewrite the outcome used by the fence.
                journaled = self._receipt(json.loads(_json(record))) is True
            except Exception:
                pass
            if not journaled:
                error = 'RESPONSE_RECEIPT_FAILED'

        # This runs even when decode, projection or the receipt failed. A failed
        # receipt does NOT authorize an auth write, but must not lose rotation.
        for observation in observations:
            try:
                acknowledged = self._response_cookies(route, observation.set_cookies,
                    response_url=observation.response_url, http_status=observation.http_status,
                    outcome_journaled=journaled)
                require(acknowledged is True, 'RESPONSE_COOKIES_FAILED')
            except Exception:
                self._mutation_fenced = True
                error = error if error == 'RESPONSE_RECEIPT_FAILED' else 'RESPONSE_COOKIES_FAILED'
        if error:
            raise MinutesError(error, may_have_sent=sent, receipt=record,
                               outcome_journaled=journaled) from None
        if mutation and record['outcome'] not in ('UNKNOWN', 'CHALLENGE_REQUIRED'):
            self._mutation_fenced = False
        return result

    @staticmethod
    def _response_receipt(route, digest, observations, data, result, error, order_id, projection_sha256):
        projection = result.projection if isinstance(result, Snapshot) else result
        outcome = 'UNKNOWN' if error else 'RESPONSE_RECEIVED'
        if route == 'place':
            candidate = data.get('order_nr') if isinstance(data, dict) else None
            order_id = candidate if isinstance(candidate, str) and re.fullmatch(r'I[A-Z0-9]{1,63}', candidate) else None
            if not error:
                outcome = 'ORDER_ID_RECEIVED' if projection['accepted'] else 'UNKNOWN'
        if route == 'payment_complete' and not error and projection['redirect_required']:
            outcome = 'CHALLENGE_REQUIRED'
        record = {'service': 'minutes', 'operation': route, 'request_sha256': digest,
                  'request_url': 'https://' + ROUTES[route][1] + ROUTES[route][2],
                  'http_status': observations[0].http_status if observations else None,
                  'outcome': outcome, 'error_code': error, 'order_id': order_id,
                  'projection_sha256': projection_sha256}
        record['evidence_hash'] = hashlib.sha256(_json(record)).hexdigest()
        return record

    def _session(self, route, payload, timeout, before_send):
        return self._call(route, payload, timeout, before_send,
                          project=lambda data: Snapshot(data, project_session(data), time.time()))

    def get_session(self, *, refresh=None, before_send, timeout=12):
        require(refresh is None or type(refresh) is bool, 'INVALID_REFRESH')
        return self._session('session_get', {} if refresh is None else {'refresh': refresh}, timeout, before_send)

    def sync(self, *, skus, bundles, refresh, before_send, timeout=12):
        """Full manifest, not a delta. Caller must preserve all unowned cart lines."""
        require(type(refresh) is bool, 'INVALID_REFRESH')
        payload = {'skus': _skus(skus), 'bundles': _bundles(bundles), 'refresh': refresh}
        return self._session('sync', payload, timeout, before_send)

    def set_delivery_instructions(self, *, preferences, driver_notes, save, before_send, timeout=12):
        require(isinstance(preferences, dict) and len(preferences) <= 30 and type(save) is bool, 'INVALID_PREFERENCES')
        prefs = {ident(k): v for k, v in preferences.items()}
        require(all(type(v) is bool for v in prefs.values()), 'INVALID_PREFERENCES')
        require(isinstance(driver_notes, str) and 0 < len(driver_notes) <= 500, 'INVALID_DRIVER_NOTES')
        return self._session('instructions', {'deliveryPreferences': prefs, 'driverNotes': driver_notes, 'save': save}, timeout, before_send)

    def set_payment_method(self, *, card, before_send, timeout=12):
        require(isinstance(card, SavedCard), 'INVALID_CARD')
        card.validate()
        return self._session('payment', {'paymentMethodCode': 'cc_noonpay', 'paymentToken': card.token,
            'creditCardMask': card.mask, 'walletAmount': 0, 'idEmiPlan': None}, timeout, before_send)

    def place_order(self, *, total_minor, before_send, timeout=12):
        require(type(total_minor) is int and total_minor > 0, 'INVALID_AMOUNT')
        return self._call('place', {'total': wire_amount(total_minor)}, timeout, before_send,
                          project=project_place)

    def order_status(self, order, *, timeout=12):
        self._order(order)
        data = self._call('order_get', {'orderNr': order}, timeout)
        return Snapshot(data, project_order_get(data, order), time.time())

    def active_orders(self, *, timeout=12):
        """order/get-active readback; request body is exactly {} as captured."""
        data = self._call('order_get_active', {}, timeout)
        return Snapshot(data, project_active(data), time.time())

    def payment_config(self, *, timeout=12):
        data = self._call('payment_config', None, timeout)
        _application_ok(data)
        # Config contains payment encryption material; callers may use it in RAM.
        return Snapshot(data, {'service': 'minutes', 'payment_config_received': True}, time.time())

    def payment_cards(self, *, timeout=12):
        data = self._call('payment_cards', None, timeout)
        _application_ok(data)
        # Raw card identifiers stay in this private RAM-only snapshot.
        return Snapshot(data, {'service': 'minutes', 'cards': project_cards(data)}, time.time())

    def complete_payment(self, *, order, client_secret, card, provider_code,
                         cvv_encryption, before_send, timeout=12, optional_fields=None):
        """Explicit continuation of an existing intent, never another order/place.

        cvv_encryption is the native encryption result supplied in RAM. Plain CVV
        is not accepted. None is the decoded no-CVV path. 3DS is returned as a
        private redirect URL in Snapshot.wire for parent handling.
        """
        self._order(order)
        require(isinstance(card, SavedCard), 'INVALID_CARD')
        card.validate()
        require(isinstance(client_secret, str) and 0 < len(client_secret) <= 2000, 'INVALID_PAYMENT_INTENT')
        require(provider_code in ('NOON_PAY', 'ADYEN', 'CHECKOUT'), 'INVALID_PAYMENT_PROVIDER')
        require(cvv_encryption is None or isinstance(cvv_encryption, dict)
                and set(cvv_encryption) == {'encCvv', 'publicKeyName'}
                and all(isinstance(v, str) and 0 < len(v) <= 16000 for v in cvv_encryption.values()),
                'ENCRYPTED_CVV_REQUIRED')
        # Shape 39043. Undefined optional JS members are omitted by JSON.stringify.
        payload = {'clientSecret': client_secret, 'paymentMethodCode': 'cc_noonpay',
                    'idCustomerToken': card.token, 'cvvEncryption': cvv_encryption,
                    'paymentProviderCode': provider_code}
        # Preserve explicit nulls from the observed native caller. Only absent
        # (undefined) optional values are omitted; no EMI/wallet/token branches.
        if optional_fields is not None:
            require(type(optional_fields) is dict and set(optional_fields) <= {
                'applePayToken','googlePayToken','installments','paymentType','adcbTokenCode',
                'idEmiPlan','tenorMonth'} and all(v is None for v in optional_fields.values()),
                'OPTIONAL_PAYMENT_BRANCH_UNSUPPORTED')
            payload.update(optional_fields)
        return self._call('payment_complete', payload, timeout, before_send, order_id=order,
                          project=lambda data: Snapshot(data, project_payment(data, order), time.time()))

    def payment_status(self, *, order, client_secret, timeout=12):
        self._order(order)
        require(isinstance(client_secret, str) and 0 < len(client_secret) <= 2000, 'INVALID_PAYMENT_INTENT')
        data = self._call('payment_status', {'clientSecret': client_secret}, timeout)
        return Snapshot(data, project_payment(data, order), time.time())

    def payment_intent_status(self, *, order, client_secret, total_minor, timeout=12):
        """Captured paid-signal readback for the 3DS wait loop."""
        self._order(order)
        require(isinstance(client_secret, str) and 0 < len(client_secret) <= 2000, 'INVALID_PAYMENT_INTENT')
        data = self._call('payment_status', {'clientSecret': client_secret}, timeout)
        return Snapshot(data, project_payment_status(data, order, total_minor), time.time())

    @staticmethod
    def _order(order):
        require(isinstance(order, str) and bool(re.fullmatch(r'I[A-Z0-9]{1,63}', order)), 'INVALID_ORDER_ID')

    def track(self, order, *, timeout=12):
        """Exact existing tracking projection with bounded first-page ETA enrichment."""
        self._order(order)
        start = time.monotonic()
        data = self._call('track', {'order_nr': order}, timeout)
        _application_ok(data)
        try:
            out = tracking.minutes_track(data, order)
        except tracking.NoonError:
            raise MinutesError('ORDER_MISMATCH_OR_SCHEMA_CHANGED') from None
        out.update(account_verified=True, saved_home_verified=True)
        if out['status'] != 'delivered':
            try:
                left = timeout - (time.monotonic() - start)
                require(left > 0, 'REQUEST_TIMEOUT')
                page = self._call('orders', {'pageNr': 1}, left)
                _application_ok(page)
                rows = tracking.minutes_list(page)
                matches = [r for r in rows if r['order'] == order]
                if len(matches) == 1:
                    row = matches[0]
                    out['eta_text'] = row['eta_text'] or out['eta_text']
                    window = tracking.eta_window(row['placed_at'], row['eta_text'])
                    if window:
                        out.update(eta=window['end'], eta_window=window, eta_source='native_minutes_list_window')
            except (MinutesError, tracking.NoonError):
                out['warnings'] = ['eta_enrichment_unavailable']
        return out

    def orders(self, *, page=1, timeout=12):
        require(type(page) is int and 1 <= page <= 100, 'INVALID_PAGE')
        data = self._call('orders', {'pageNr': page}, timeout)
        _application_ok(data)
        try:
            rows = tracking.minutes_list(data)
        except tracking.NoonError:
            raise MinutesError('ORDER_LIST_SCHEMA_CHANGED') from None
        return {'orders': rows, 'page': page, 'total_pages': data.get('totalPages'),
                'complete_history': False, 'resend_allowed': False}
