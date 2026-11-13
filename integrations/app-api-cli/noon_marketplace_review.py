"""Pure Main/Supermall financial review. No transport or account access.

Paths in EvidenceShape are explicit caller-evidenced response paths, not a Noon
schema invented by this module. Missing paths fail closed with the semantic field
name. A shape is trusted adapter configuration, never supplied by the server.
"""
import order_card
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re


class ReviewError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(ok, code):
    if not ok:
        raise ReviewError(code)


def digest(value):
    try:
        raw = json.dumps(value, allow_nan=False, sort_keys=True,
                         separators=(',', ':')).encode()
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise ReviewError('INVALID_REVIEW_JSON') from None
    return hashlib.sha256(raw).hexdigest()


def text(value, code, *, blank=False):
    require(isinstance(value, str) and (blank or bool(value.strip()))
            and len(value) <= 512 and not any(ord(c) < 32 for c in value), code)
    return value


def minor(value):
    require(type(value) in (int, float, str, Decimal), 'INVALID_AMOUNT')
    try:
        amount = Decimal(str(value)) * 100
        require(amount.is_finite() and amount >= 0
                and amount == amount.to_integral_value(), 'INVALID_AMOUNT')
        return int(amount)
    except (InvalidOperation, ValueError, OverflowError):
        raise ReviewError('INVALID_AMOUNT') from None


@dataclass(frozen=True)
class Field:
    """Exact path relative to the documented object, plus static/live anchor.

    '*' traverses every array element (for complete shipment inventories).
    No default/absent value, aliases, coercion or callable extraction is allowed.
    """
    path: tuple
    evidence: str

    def __post_init__(self):
        require(type(self.path) is tuple and all(type(p) in (str, int) for p in self.path),
                'INVALID_EVIDENCE_PATH')
        text(self.evidence, 'EVIDENCE_ANCHOR_REQUIRED')


@dataclass(frozen=True)
class EvidenceShape:
    fields: tuple
    evidence_id: str

    def __post_init__(self):
        require(type(self.fields) is tuple, 'INVALID_EVIDENCE_SHAPE')
        names = []
        for item in self.fields:
            require(type(item) is tuple and len(item) == 2 and isinstance(item[1], Field),
                    'INVALID_EVIDENCE_SHAPE')
            require(isinstance(item[0], str) and re.fullmatch('[a-z_]+', item[0]),
                    'INVALID_EVIDENCE_SHAPE')
            names.append(item[0])
        require(len(names) == len(set(names)), 'DUPLICATE_EVIDENCE_FIELD')
        text(self.evidence_id, 'EVIDENCE_ANCHOR_REQUIRED')

    def get(self, name, obj):
        spec = dict(self.fields).get(name)
        require(spec is not None, 'UNSUPPORTED_' + name.upper())

        def walk(value, parts):
            if not parts:
                return value
            key, *rest = parts
            if key == '*':
                require(type(value) is list, 'SCHEMA_' + name.upper())
                out = []
                for row in value:
                    result = walk(row, rest)
                    out.extend(result if type(result) is list else [result])
                return out
            require((type(value) is dict and type(key) is str and key in value)
                    or (type(value) is list and type(key) is int and 0 <= key < len(value)),
                    'SCHEMA_' + name.upper())
            return walk(value[key], rest)

        return walk(obj, spec.path)


@dataclass(frozen=True)
class Context:
    """Caller-owned acquisition metadata; timestamps are not server revisions."""
    service: str
    account_ref: str
    address_ref: str
    cart_hash: str
    session_hash: str
    cart_observed_at: float
    session_observed_at: float
    now: float
    max_age: float = 120


@dataclass(frozen=True)
class QuietOption:
    semantic: str
    code: str
    active: bool
    evidence: str


@dataclass(frozen=True)
class Item:
    offer: str
    variant: str
    quantity: int
    seller: str
    fulfillment: str
    line_minor: int


@dataclass(frozen=True)
class Review:
    digest: str
    payable_minor: int
    cart_hash: str
    session_hash: str
    account_ref: str
    address_ref: str
    observed_at: float
    expires_at: float
    service: str
    items: tuple
    fees: tuple
    bindings: tuple = field(repr=False)
    validated_context: Context = field(repr=False)


def _fresh(value, ctx, code):
    require(type(value) in (int, float) and math.isfinite(value)
            and 0 <= ctx.now - value <= ctx.max_age, code)


def _rows(shape, key, data):
    value = shape.get(key, data)
    require(type(value) is list and len(value) <= 1000
            and all(type(row) is dict for row in value), 'SCHEMA_' + key.upper())
    return value


def _item(shape, prefix, row):
    get = lambda key: shape.get(prefix + '_' + key, row)
    qty = get('quantity')
    require(type(qty) is int and 1 <= qty <= 999, 'INVALID_ITEM_QUANTITY')
    line=(minor(get('unit_amount'))*qty if prefix+'_unit_amount' in dict(shape.fields)
          else minor(get('line_amount')))
    return Item(text(get('offer'), 'INVALID_OFFER'), text(get('variant'), 'INVALID_VARIANT', blank=True),
                 qty, text(get('seller'), 'INVALID_SELLER'),
                text(get('fulfillment'), 'INVALID_FULFILLMENT'), line)


def _inventory(items, code):
    result = {}
    for item in items:
        key = (item.offer, item.variant)
        require(key not in result, code)
        result[key] = item
    return result


def review(cart_data, session_data, expected_manifest, home, card, *, context,
           shape=None, expected_fees=(), quiet_options=()):
    """Return immutable validated review or ReviewError(code).

    expected_manifest: nonempty sequence of Item (amounts already minor units).
    home: internal {account_ref,address_ref,address_code,address_key,title,
      street_address,lat,lng,observed_at}; coordinates use whoami integer units.
    card: internal {token,mask,card_type,observed_at} from fresh saved-card read.
    expected_fees: exact ((native_fee_code, minor_amount), ...) inventory.
    quiet_options: three evidenced QuietOption mappings for leave_at_door,
      no_bell,no_call. These are INTERNAL semantic names, never wire flags.
    context hashes must be captured with the corresponding native responses.
    The function performs no I/O and does not grant purchase authorization.
    """
    ctx = context
    require(type(ctx) is Context and ctx.service in ('main', 'supermall'), 'INVALID_REVIEW_CONTEXT')
    require(type(ctx.now) in (int, float) and math.isfinite(ctx.now)
            and type(ctx.max_age) in (int, float) and 0 < ctx.max_age <= 120, 'INVALID_REVIEW_TIME')
    for ref in (ctx.account_ref, ctx.address_ref):
        require(isinstance(ref, str) and re.fullmatch('[a-f0-9]{64}', ref), 'INVALID_CONTEXT_REFERENCE')
    _fresh(ctx.cart_observed_at, ctx, 'STALE_CART')
    _fresh(ctx.session_observed_at, ctx, 'STALE_SESSION')
    require(type(cart_data) is dict and type(session_data) is dict, 'INVALID_REVIEW_DATA')
    cart_hash, session_hash = digest(cart_data), digest(session_data)
    require(cart_hash == ctx.cart_hash, 'CART_SNAPSHOT_CHANGED')
    require(session_hash == ctx.session_hash, 'SESSION_SNAPSHOT_CHANGED')
    if shape is None:
        from noon_marketplace_native_shape import NATIVE_SHAPE
        shape=NATIVE_SHAPE
    require(type(shape) is EvidenceShape, 'INVALID_EVIDENCE_SHAPE')
    require(type(expected_manifest) in (tuple, list) and 0 < len(expected_manifest)
            and all(type(i) is Item for i in expected_manifest), 'INVALID_EXPECTED_MANIFEST')
    for item in expected_manifest:
        for value in (item.offer, item.seller, item.fulfillment):
            text(value, 'INVALID_EXPECTED_MANIFEST')
        text(item.variant, 'INVALID_EXPECTED_MANIFEST', blank=True)
        require(type(item.quantity) is int and item.quantity >= 1
                and type(item.line_minor) is int and item.line_minor >= 0,
                'INVALID_EXPECTED_MANIFEST')
    expected = _inventory(expected_manifest, 'DUPLICATE_EXPECTED_OFFER')
    selected = []
    all_keys = set()
    for row in _rows(shape, 'cart_rows', cart_data):
        item = _item(shape, 'cart', row)
        key = (item.offer, item.variant)
        require(key not in all_keys, 'DUPLICATE_CART_OFFER')
        all_keys.add(key)
        flag = shape.get('cart_selected', row)
        require(type(flag) is bool, 'SCHEMA_CART_SELECTED')
        if flag:
            selected.append(item)
    require(_inventory(selected, 'DUPLICATE_CART_OFFER') == expected, 'SELECTED_CART_MANIFEST_MISMATCH')
    session_items = [_item(shape, 'session', row) for row in _rows(shape, 'session_rows', session_data)]
    require(_inventory(session_items, 'DUPLICATE_SESSION_OFFER') == expected, 'SESSION_MANIFEST_MISMATCH')

    require(type(home) is dict, 'INVALID_HOME')
    _fresh(home.get('observed_at'), ctx, 'STALE_HOME')
    require(home.get('account_ref') == ctx.account_ref and home.get('address_ref') == ctx.address_ref,
            'HOME_CONTEXT_MISMATCH')
    title = text(home.get('title'), 'INVALID_HOME') + ' ' + text(home.get('street_address'), 'INVALID_HOME')
    compact = re.sub('[^a-z0-9]', '', title.lower())
    require('banyantree' in compact and 'hillside' in compact and re.search(r'\b2104\b', title)
            and type(home.get('lat')) is int and type(home.get('lng')) is int
            and (home['lat'], home['lng']) == (250778251, 551569039), 'HOME_2104_MISMATCH')
    require(shape.get('address_code',session_data)==text(home.get('address_code'),'INVALID_HOME'),'SESSION_HOME_MISMATCH')
    native_shape=shape.evidence_id.startswith('HBC:')
    if native_shape:
        # Native session identifies addressCode; its addressKey lives in the
        # separately verified address inventory, not a fabricated session echo.
        from noon_checkout import fingerprint as home_fingerprint
        require(home_fingerprint(home['address_code'],text(home.get('address_key'),'INVALID_HOME'))==ctx.address_ref,
                'SESSION_HOME_MISMATCH')
    else:
        require(shape.get('address_key',session_data)==text(home.get('address_key'),'INVALID_HOME'),'SESSION_HOME_MISMATCH')

    require(type(card) is dict, 'INVALID_SAVED_CARD')
    _fresh(card.get('observed_at'), ctx, 'STALE_CARD')
    mask = text(card.get('mask'), 'INVALID_SAVED_CARD')
    require(re.fullmatch(r'[0-9xX*• .\-]*' + order_card.LAST4, mask) is not None
            and bool(re.search(r'[xX*•]',mask)) and len(re.sub(r'\D','',mask))<=12, 'SAVED_CARD_LAST4_MISMATCH')
    token = text(card.get('token'), 'INVALID_SAVED_CARD')
    card_type = text(card.get('card_type'), 'INVALID_SAVED_CARD')
    require(card_type.lower()==order_card.NETWORK,'SAVED_CARD_TYPE_MISMATCH')
    if native_shape:
        from noon_marketplace_card import extract_selected_card,CardError
        try:selected=extract_selected_card(session_data)
        except CardError as exc:raise ReviewError(exc.code) from None
        method,selected_token,selected_mask,selected_type=selected.payment_method,selected.token,selected.mask,selected.network
    else:
        method,selected_token,selected_mask,selected_type=(shape.get(k,session_data) for k in
            ('payment_method','card_token','card_mask','card_type'))
    require(method == ('cc_noonpay' if native_shape else 'cc'), 'SAVED_CARD_METHOD_MISMATCH')
    require(selected_token == token, 'SAVED_CARD_TOKEN_MISMATCH')
    require(selected_mask == mask, 'SAVED_CARD_MASK_MISMATCH')
    require(str(selected_type).lower() == card_type.lower(), 'SAVED_CARD_TYPE_MISMATCH')

    require(shape.get('currency', session_data) == 'AED', 'CURRENCY_MISMATCH')
    subtotal = minor(shape.get('subtotal', session_data))
    require(subtotal == sum(i.line_minor for i in expected.values()), 'SUBTOTAL_MISMATCH')
    require(type(expected_fees) in (tuple, list), 'INVALID_EXPECTED_FEES')
    fee_expectation = {}
    for pair in expected_fees:
        require(type(pair) in (tuple, list) and len(pair) == 2, 'INVALID_EXPECTED_FEES')
        code, amount = pair
        text(code, 'INVALID_EXPECTED_FEES')
        require(code not in fee_expectation and type(amount) is int and amount >= 0,
                'INVALID_EXPECTED_FEES')
        fee_expectation[code] = amount
    fees = {}
    for row in _rows(shape, 'fee_rows', session_data):
        code = text(shape.get('fee_code', row), 'INVALID_FEE_CODE')
        require(code not in fees, 'DUPLICATE_FEE')
        fees[code] = minor(shape.get('fee_amount', row))
    require(fees == fee_expectation, 'FEE_INVENTORY_MISMATCH')
    # Discounts cannot silently finance an extra, subscription or wallet spend.
    require(minor(shape.get('discount', session_data)) == 0, 'UNAPPROVED_DISCOUNT')
    require(minor(shape.get('tip', session_data)) == 0, 'UNAPPROVED_TIP')
    require(minor(shape.get('wallet', session_data)) == 0, 'UNAPPROVED_WALLET')
    require(shape.get('subscription', session_data) is False, 'UNAPPROVED_SUBSCRIPTION')
    require(shape.get('extras', session_data) == [], 'UNAPPROVED_EXTRAS')
    payable = minor(shape.get('payable', session_data))
    require(payable == subtotal + sum(fees.values()) and payable > 0, 'PAYABLE_MISMATCH')

    require(type(quiet_options) in (tuple, list) and len(quiet_options) == 3
            and all(type(q) is QuietOption for q in quiet_options), 'UNSUPPORTED_QUIET_OPTION_SEMANTICS')
    require({q.semantic for q in quiet_options} == {'leave_at_door', 'no_bell', 'no_call'},
            'UNSUPPORTED_QUIET_OPTION_SEMANTICS')
    options = {}
    for row in _rows(shape, 'delivery_options', session_data):
        code = text(shape.get('option_code', row), 'INVALID_DELIVERY_OPTION')
        active = shape.get('option_active', row)
        require(type(active) is bool and code not in options, 'INVALID_DELIVERY_OPTION')
        options[code] = active
    quiet = []
    for option in quiet_options:
        text(option.evidence, 'QUIET_EVIDENCE_REQUIRED')
        text(option.code, 'INVALID_DELIVERY_OPTION')
        require(type(option.active) is bool, 'INVALID_DELIVERY_OPTION')
        require(option.code in options and options[option.code] is option.active, 'QUIET_DELIVERY_MISMATCH')
        quiet.append((option.semantic, option.code, option.active, option.evidence))
    note = shape.get('delivery_note', session_data)
    require(note == "Leave at door. Don't ring bell. Don't call.", 'QUIET_NOTE_MISMATCH')
    observed_at = min(ctx.cart_observed_at, ctx.session_observed_at, home['observed_at'], card['observed_at'])
    items = tuple(sorted(expected.values(), key=lambda i: (i.offer, i.variant)))
    fees = tuple(sorted(fees.items()))
    bindings = (('card_token_hash', digest(token)), ('card_type', card_type),
                ('home_hash', digest(home)), ('card_hash', digest(card)),
                ('shape_hash', digest([(k, f.path, f.evidence) for k, f in shape.fields])),
                ('shape_id', shape.evidence_id), ('quiet', tuple(sorted(quiet))))
    review_hash = digest({'service': ctx.service, 'account': ctx.account_ref, 'home': ctx.address_ref,
        'cart': cart_hash, 'session': session_hash, 'payable_minor': payable,
        'items': [tuple(vars(i).values()) for i in items], 'fees': fees, 'bindings': bindings,
        'observed_at': observed_at, 'expires_at': observed_at + ctx.max_age})
    return Review(review_hash, payable, cart_hash, session_hash, ctx.account_ref, ctx.address_ref,
                  observed_at, observed_at + ctx.max_age, ctx.service, items, fees, bindings, ctx)
