"""Noon checkout research boundary: known GETs and pure, fail-closed safety seams.

The dataclasses below are an INTERNAL contract, not an inferred Noon wire schema.
No checkout/cart/payment/cancellation write can be dispatched by this module.
Tracking modules remain independent and unchanged. See NOON-CHECKOUT.md.
"""
import order_card
from dataclasses import asdict, dataclass, field, replace
import hashlib
import json
import math
import re
import time

import noon_http_orders as tracking


SERVICES = frozenset({'minutes', 'main', 'supermall', 'nownow'})
QUIET_NOTE = "Leave at door. Don't ring bell. Don't call."
HOME_PIN = (250778251, 551569039)  # whoami integer coordinate units, not degrees
_HASH = re.compile(r'[a-f0-9]{64}')


class CheckoutError(Exception):
    """Only bounded error codes, never upstream payloads or credentials."""


def _require(condition, code):
    if not condition:
        raise CheckoutError(code)


def _service(value):
    _require(isinstance(value, str) and value in SERVICES, 'INVALID_SERVICE')
    return value


def _text(value):
    return (isinstance(value, str) and 0 < len(value) <= 256 and bool(value.strip())
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def _integer(value, minimum=0):
    return type(value) is int and value >= minimum


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _hash(value):
    return isinstance(value, str) and bool(_HASH.fullmatch(value))


def _safe_error(exc):
    code = str(exc)
    return code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code) else 'ACCOUNT_READ_FAILED'


def fingerprint(*parts):
    """Opaque local equality binding; not authorization or remote idempotency."""
    _require(parts and all(_text(p) for p in parts), 'INVALID_REFERENCE')
    return hashlib.sha256(json.dumps(parts, separators=(',', ':')).encode()).hexdigest()


@dataclass(frozen=True)
class AccountHome:
    service: str
    account_ref: str = field(repr=False)
    address_ref: str = field(repr=False)
    checked_at: float


def project_home(data, headers, service, *, checked_at):
    """Project observed whoami schema without exposing address/customer/phone IDs.

    Tracking's saved-address check is reused and then strengthened for checkout:
    exact selected header binding, BanyanTree Hillside/2104 and known saved pin.
    This does NOT prove an unobserved cart uses that address.
    """
    _service(service)
    _require(isinstance(data, dict) and isinstance(headers, dict), 'HOME_SCHEMA_UNKNOWN')
    _require(_finite(checked_at), 'INVALID_TIME')
    _require(all(_text(headers.get(k)) for k in ('x-addresscode', 'x-addresskey')),
             'HOME_MISMATCH')
    try:
        tracking.verify_home(data, headers)
    except tracking.NoonError as exc:
        raise CheckoutError(_safe_error(exc)) from None
    customer = data['customer'].get('customerCode')
    _require(_text(customer), 'ACCOUNT_SCHEMA_UNKNOWN')
    matches = [e.get('selectedAddress') for e in data['experiences']
               if isinstance(e, dict) and isinstance(e.get('selectedAddress'), dict)
               and e['selectedAddress'].get('addressCode') == headers['x-addresscode']
               and e['selectedAddress'].get('addressKey') == headers['x-addresskey']]
    _require(bool(matches), 'HOME_MISMATCH')
    for address in matches:
        title = ' '.join(address.get(k, '') for k in ('addressTitle', 'streetAddress')
                         if isinstance(address.get(k), str)).lower()
        compact = re.sub(r'[^a-z0-9]', '', title)
        _require('banyantree' in compact and 'hillside' in compact
                 and re.search(r'\b2104\b', title) is not None, 'HOME_MISMATCH')
        _require(type(address.get('lat')) is int and type(address.get('lng')) is int
                 and (address['lat'], address['lng']) == HOME_PIN, 'HOME_PIN_MISMATCH')
    return AccountHome(service, fingerprint(customer),
                       fingerprint(headers['x-addresscode'], headers['x-addresskey']), checked_at)


def _load_headers(service):
    """Load existing auth in memory only. No refresh, login, cookie export or writes."""
    if service != 'nownow':
        return tracking.session('minutes' if service == 'minutes' else 'marketplace')
    try:
        saved = tracking.load('nownow')
        headers = saved['templates'][
            'GET api-app-fd.noon.com/_svc/mp-shop-api-ctnoon/v2/content/search']['headers']
        _require(isinstance(headers, dict) and headers, 'ACCOUNT_CAPTURE_REQUIRED')
        _require(all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()),
                 'ACCOUNT_HEADERS_INVALID')
    except CheckoutError:
        raise
    except Exception:
        raise CheckoutError('ACCOUNT_CAPTURE_REQUIRED') from None
    return {k.lower(): v for k, v in headers.items() if k.lower() not in {
        'host', 'content-length', 'accept-encoding', 'connection', 'if-none-match',
        'if-modified-since', 'baggage', 'sentry-trace'}}


class ReadOnlyCheckout:
    """Narrow transport seam. Only previously verified whoami GET is enabled.

    No arbitrary route, payload, method, redirect, write toggle or auto-retry.
    main/supermall share only the existing account loader, NOT a checkout adapter.
    """

    def __init__(self, *, headers_loader=None, whoami_get=None):
        self._headers_loader = headers_loader or _load_headers
        self._whoami_get = whoami_get or (
            lambda headers, deadline: tracking.request('whoami', headers, deadline))

    def account_home(self, service, *, timeout=12):
        _service(service)
        try:
            deadline = tracking.operation_deadline(timeout)
            with tracking.read_deadline(deadline):
                headers = self._headers_loader(service)
            data = self._whoami_get(headers, deadline)
            tracking.remaining(deadline)
            return project_home(data, headers, service, checked_at=time.time())
        except tracking.NoonError as exc:
            raise CheckoutError(_safe_error(exc)) from None
        except CheckoutError:
            raise
        except Exception:
            raise CheckoutError('ACCOUNT_READ_FAILED') from None

    def cart(self, service):
        _service(service)
        raise CheckoutError('CART_READ_CONTRACT_NOT_VERIFIED')

    def quote(self, service):
        _service(service)
        raise CheckoutError('QUOTE_READ_CONTRACT_NOT_VERIFIED')

    def mutate(self, service, operation, **_):
        _service(service)
        raise CheckoutError('CHECKOUT_MUTATIONS_DISABLED')


@dataclass(frozen=True)
class Product:
    service: str
    merchant_ref: str
    fulfillment_ref: str
    sku: str
    offer_ref: str


@dataclass(frozen=True)
class Line:
    product: Product
    quantity: int
    unit_minor: int
    total_minor: int


@dataclass(frozen=True)
class Quiet:
    # selected / unsupported / unknown / unselected; unsupported needs evidence
    leave_at_door: str
    dont_ring_bell: str
    dont_call: str
    note_supported: bool | None
    note: str | None
    inventory_complete: bool
    evidence_ref: str


@dataclass(frozen=True)
class Payment:
    method: str
    last4: str
    network: str
    selected_card_ref: str = field(repr=False)
    credits_minor: int
    card_charge_minor: int
    challenge: str  # none / cvv / 3ds / unknown; credentials never belong here


@dataclass(frozen=True)
class Quote:
    """Future verified adapter projection. Never pass an upstream dict as this.

    All opaque refs are one-way fingerprints. Amounts are integer AED fils.
    Adjustments cover ALL extra charges/discounts/tax not already in line totals.
    A local digest is not a server quote lock, even when server_revision is known.
    """
    service: str
    account_ref: str = field(repr=False)
    address_ref: str = field(repr=False)
    cart_ref: str = field(repr=False)
    server_revision: str = field(repr=False)
    observed_at: float
    expires_at: float
    currency: str
    items: tuple[Line, ...]
    items_complete: bool
    adjustments: tuple[tuple[str, int], ...]
    totals_complete: bool
    total_minor: int
    payment: Payment
    quiet: Quiet
    delivery_ref: str
    delivery_complete: bool


def _validate_line(line, service):
    _require(type(line) is Line and type(line.product) is Product, 'INVALID_LINE')
    p = line.product
    _require(p.service == service, 'CROSS_SERVICE_CART')
    _require(all(_text(v) for v in (p.merchant_ref, p.fulfillment_ref, p.sku, p.offer_ref)),
             'PRODUCT_IDENTITY_INCOMPLETE')
    _require(_integer(line.quantity, 1), 'INVALID_QUANTITY')
    _require(_integer(line.unit_minor) and _integer(line.total_minor), 'INVALID_PRICE')
    _require(line.total_minor == line.quantity * line.unit_minor, 'LINE_TOTAL_MISMATCH')


def validate_quote(quote, home, expected_items, *, now, max_age=60):
    """Pure local validation, not permission to submit. No missing-value defaults."""
    _require(type(quote) is Quote and type(home) is AccountHome, 'INVALID_QUOTE')
    _service(quote.service)
    _require(_finite(now) and _finite(max_age) and 0 < max_age <= 120, 'INVALID_TIME')
    _require(_finite(quote.observed_at) and _finite(quote.expires_at)
             and quote.observed_at <= now < quote.expires_at
             and now - quote.observed_at <= max_age
             and quote.expires_at - quote.observed_at <= 120, 'QUOTE_EXPIRED_OR_INVALID')
    _require(_finite(home.checked_at) and 0 <= now - home.checked_at <= max_age,
             'HOME_READ_STALE')
    _require(home.service == quote.service, 'CROSS_SERVICE_CART')
    _require(all(_hash(v) for v in (home.account_ref, home.address_ref, quote.account_ref,
                                   quote.address_ref, quote.cart_ref, quote.server_revision)),
             'BINDING_INCOMPLETE')
    _require(quote.account_ref == home.account_ref and quote.address_ref == home.address_ref,
             'ACCOUNT_OR_HOME_MISMATCH')
    _require(type(quote.items) is tuple and 0 < len(quote.items)
             and quote.items_complete is True, 'CART_MANIFEST_INCOMPLETE')
    _require(type(expected_items) is tuple and 0 < len(expected_items),
             'EXPECTED_ITEMS_REQUIRED')
    for line in quote.items + expected_items:
        _validate_line(line, quote.service)
    _require(len({l.product for l in quote.items}) == len(quote.items)
             and len({l.product for l in expected_items}) == len(expected_items), 'DUPLICATE_PRODUCT')
    _require(set(quote.items) == set(expected_items), 'CART_ITEMS_OR_PRICES_CHANGED')
    if quote.service in ('minutes', 'nownow'):
        _require(len({(l.product.merchant_ref, l.product.fulfillment_ref)
                      for l in quote.items}) == 1, 'MIXED_STORE_CART')
    _require(quote.currency == 'AED' and _integer(quote.total_minor, 1), 'INVALID_TOTAL')
    _require(quote.totals_complete is True and type(quote.adjustments) is tuple
             and len(quote.adjustments) <= 100,
             'TOTALS_INCOMPLETE')
    seen = set()
    for adjustment in quote.adjustments:
        _require(type(adjustment) is tuple and len(adjustment) == 2, 'INVALID_ADJUSTMENT')
        name, value = adjustment
        _require(_text(name) and name not in seen and type(value) is int,
                 'INVALID_ADJUSTMENT')
        seen.add(name)
    _require(sum(l.total_minor for l in quote.items) + sum(v for _, v in quote.adjustments)
             == quote.total_minor, 'FINAL_TOTAL_MISMATCH')
    pay = quote.payment
    _require(type(pay) is Payment and pay.method == 'saved_card' and pay.last4 == order_card.LAST4
             and pay.network == 'mastercard' and _hash(pay.selected_card_ref), 'CARD_MISMATCH')
    _require(type(pay.credits_minor) is int and pay.credits_minor == 0
             and _integer(pay.card_charge_minor) and pay.card_charge_minor == quote.total_minor,
             'PAYMENT_ALLOCATION_MISMATCH')
    _require(pay.challenge == 'none', 'PAYMENT_CHALLENGE_REQUIRES_PARENT')
    quiet = quote.quiet
    _require(type(quiet) is Quiet and quiet.inventory_complete is True
             and _hash(quiet.evidence_ref), 'QUIET_CONTROLS_UNKNOWN')
    flags = (quiet.leave_at_door, quiet.dont_ring_bell, quiet.dont_call)
    _require(all(f in ('selected', 'unsupported') for f in flags), 'QUIET_TOGGLE_NOT_VERIFIED')
    _require(type(quiet.note_supported) is bool, 'QUIET_NOTE_SUPPORT_UNKNOWN')
    if quiet.note_supported:
        _require(quiet.note == QUIET_NOTE, 'QUIET_NOTE_MISMATCH')
    else:
        _require(quiet.note is None and all(f == 'selected' for f in flags),
                 'QUIET_INSTRUCTIONS_UNREPRESENTABLE')
    _require(quote.delivery_complete is True and _hash(quote.delivery_ref),
             'DELIVERY_SELECTION_UNKNOWN')


def quote_digest(quote):
    _require(type(quote) is Quote, 'INVALID_QUOTE')
    try:
        return hashlib.sha256(json.dumps(asdict(quote), sort_keys=True, separators=(',', ':'),
                                         allow_nan=False).encode()).hexdigest()
    except (TypeError, ValueError):
        raise CheckoutError('INVALID_QUOTE') from None


@dataclass(frozen=True)
class Binding:
    digest: str
    service: str
    total_minor: int


def bind_quote(quote, home, expected_items, *, now):
    validate_quote(quote, home, expected_items, now=now)
    return Binding(quote_digest(quote), quote.service, quote.total_minor)


def verify_binding(binding, fresh_quote, home, expected_items, *, now):
    validate_quote(fresh_quote, home, expected_items, now=now)
    _require(type(binding) is Binding and binding == Binding(
        quote_digest(fresh_quote), fresh_quote.service, fresh_quote.total_minor), 'QUOTE_CHANGED')
    return True


@dataclass(frozen=True)
class Attempt:
    """Pure parent journal seam, NOT persistence, remote idempotency, or a sender.

    Parent must durably reserve one owner intent across all processes before any
    send. Restart/missing journal is unknown, never permission for another send.
    """
    intent_ref: str
    binding: Binding
    state: str = 'reserved'
    order_ref: str | None = None


def reserve_attempt(intent_ref, binding):
    _require(_hash(intent_ref) and type(binding) is Binding and _hash(binding.digest)
             and isinstance(binding.service, str) and binding.service in SERVICES
             and _integer(binding.total_minor, 1), 'INVALID_ATTEMPT')
    return Attempt(intent_ref, binding)


def mark_dispatched(attempt):
    _require(type(attempt) is Attempt and attempt.state == 'reserved', 'NO_BLIND_RETRY')
    return replace(attempt, state='reconcile_required')


def reconcile_attempt(attempt, *, matched_intent_ref, matched_digest, order_refs):
    """Exact projected matching only. Empty history is NOT proof of no order."""
    _require(type(attempt) is Attempt and attempt.state == 'reconcile_required', 'INVALID_ATTEMPT_STATE')
    _require(matched_intent_ref == attempt.intent_ref and matched_digest == attempt.binding.digest,
             'RECONCILE_IDENTITY_MISMATCH')
    _require(type(order_refs) is tuple and all(_hash(v) for v in order_refs), 'INVALID_RECONCILE_EVIDENCE')
    if len(order_refs) == 1:
        return replace(attempt, state='confirmed', order_ref=order_refs[0])
    return replace(attempt, state='reconcile_required')


def cancellation_eligibility(service):
    _service(service)
    return {'service': service, 'eligible': None, 'executable': False,
            'reason': 'EXACT_ORDER_CANCELLATION_CONTRACT_NOT_VERIFIED'}


def readiness(service):
    _service(service)
    return {'service': service, 'ready_to_order': False, 'mutations_enabled': False,
            'account_read': 'verified_whoami_get', 'cart_read': 'not_enabled',
            'missing': ['cart_namespace_and_complete_manifest', 'checkout_wire_schema',
                        'saved_home_on_cart', 'selected_order_card_and_payment_challenge',
                        'quiet_controls_and_text_readback', 'all_prices_fees_and_final_total',
                        'server_quote_binding_and_expiry', 'server_idempotency_and_reconcile',
                        'exact_order_cancellation_eligibility']}
