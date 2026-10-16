"""Native Talabat cart/checkout operations for parent-managed HTTP lifecycles.

All private context stays in RAM. The parent supplies fresh credentials and a
durable before-send journal; this module never refreshes auth or retries a write.
Shops/Mart use grocery carts; basic restaurant items use food cart v2. No cleanup,
fallback payment, saved-preference write, browser, SDK or challenge callback.
"""
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
import hashlib
from http.client import HTTPException
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib

import talabat_auth as auth
import talabat_checkout as shared
import talabat_http_orders as orders
import talabat_menu_choices as menu_choices
import talabat_place_contract as place_contract
import talabat_quote as quote_contract
import talabat_quote_diagnostics as quote_diagnostics
import talabat_payment_route as route_contract
import talabat_restaurant_cart as restaurant
from talabat_restaurant_cart import validate_item_note, note_matches

API = 'https://api.talabat.com'
MAX_BYTES = 2_000_000
MAX_AGE = 120
MAX_POLL_COUNT = 180
MAX_POLL_SECONDS = 300
PAYMENT_KEYS = ('eTransId', 'orderId', 'payment', 'paymentMode', 'remainingAmount',
                'secondaryPayment', 'cardToken', 'tokenizedCvv', 'keepCard',
                'binNumber', 'pu', 'method', 'applePay', 'googlePay', 'bnpl',
                'paymentScenario', 'countryId')


def fail(code):
    raise orders.TalabatError(code)


def quote_failure_diagnostic(data, exc):
    # TalabatError contains our static parser codes. Never surface arbitrary
    # exception text (it can include raw response values or account material).
    code = str(exc) if isinstance(exc, orders.TalabatError) else ''
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,99}', code):
        code = 'UNEXPECTED_QUOTE_PARSE_ERROR'
    kind = type(exc).__name__
    if kind not in {'TalabatError', 'KeyError', 'ValueError', 'TypeError', 'IndexError',
                    'AttributeError', 'OverflowError', 'RuntimeError'}:
        kind = 'Exception'
    return quote_diagnostics.build(data, code, kind)


def _json(value):
    try:
        result = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError, OverflowError):
        fail('CHECKOUT_JSON_INVALID')
    if len(result) > MAX_BYTES:
        fail('CHECKOUT_JSON_TOO_LARGE')
    return result


def _copy(value):
    return json.loads(_json(value))


def _id(value):
    return type(value) is str and bool(value.strip()) and shared._identifier(value)


def _positive(value):
    return type(value) is int and 0 < value < 10**20


def minor(value):
    """AED major-unit value -> exact fils, without rounding/coercing booleans."""
    if type(value) not in (str, int, float) or not re.fullmatch(r'[0-9]{1,6}(?:\.[0-9]{1,2})?', str(value)):
        fail('AMOUNT_INVALID')
    try:
        return int(Decimal(str(value)) * 100)
    except (InvalidOperation, ValueError, OverflowError):
        fail('AMOUNT_INVALID')


def major(value):
    if type(value) is not int or not 0 <= value <= 100_000_000:
        fail('AMOUNT_INVALID')
    return format(Decimal(value) / 100, '.2f')


def _display_minor(value):
    text = quote_contract._display_money(value)
    if text is None:
        fail('ITEM_PRICE_UNSUPPORTED')
    return minor(text)


def _flow(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        fail('FLOW_ID_INVALID')
    if type(value) is not str or str(parsed) != value or parsed.version != 4:
        fail('FLOW_ID_INVALID')
    return value


@dataclass(frozen=True)
class Store:
    vertical: str
    branch_id: int
    vertical_id: int
    migrated: bool
    vendor_id: str | None = field(default=None, repr=False)
    chain_id: int | None = field(default=None, repr=False)

    def __post_init__(self):
        if (self.vertical not in ('shops', 'mart', 'restaurants') or not _positive(self.branch_id)
                or type(self.vertical_id) is not int or not 0 <= self.vertical_id <= 20
                or type(self.migrated) is not bool):
            fail('STORE_INVALID')
        if self.vertical != 'restaurants' and (not _id(self.vendor_id) or not _positive(self.chain_id)):
            fail('GROCERY_STORE_IDENTITY_REQUIRED')
        if self.vertical == 'restaurants' and (self.vertical_id != 0 or self.migrated is not False):
            fail('RESTAURANT_MIGRATED_ROUTE_UNSUPPORTED')


def grocery_store(data, branch_id, vertical):
    vendor = data.get('vendor') if type(data) is dict else None
    if (vertical not in ('shops', 'mart') or type(vendor) is not dict
            or type(vendor.get('talabat_id')) is not int or vendor['talabat_id'] != branch_id
            or type(vendor.get('is_dark_store')) is not bool
            or type(vendor.get('is_migrated')) is not bool
            or vendor['is_dark_store'] is not (vertical == 'mart')):
        fail('GROCERY_STORE_BINDING_INVALID')
    return Store(vertical, branch_id, vendor.get('vertical_type'),
                 vendor['is_migrated'] or vendor['is_dark_store'],
                 vendor.get('global_id'), vendor.get('chain_id'))


@dataclass(frozen=True)
class Item:
    """Resolved catalog identity per requested line; no weightables or upsell.

    choices is ((choice_id, quantity, sub_choice_ids), ...) from the observed
    native contract (restaurants only). Lines with the same item_id stay
    distinct when note or choices differ; identical lines are normalized to
    one line with summed quantity because the server cannot represent them.
    """
    item_id: str | int
    quantity: int
    note: str = field(default='', repr=False)
    choices: tuple = field(default=(), repr=False)

    def __post_init__(self):
        validate_item_note(self.note)
        for choice in self.choices:
            if (type(choice) is not tuple or len(choice) != 3
                    or type(choice[0]) is not int or isinstance(choice[0], bool)
                    or not 0 < choice[0] < 2**63
                    or type(choice[1]) is not int or isinstance(choice[1], bool) or choice[1] < 1
                    or type(choice[2]) is not tuple
                    or any(type(s) is not int or isinstance(s, bool) or not 0 < s < 2**63 for s in choice[2])):
                fail('FOOD_ITEM_CHOICES_INVALID')


def _choices_key(item):
    return tuple(sorted((c[0], c[1], tuple(sorted(c[2]))) for c in item.choices))


def _items(store, items):
    """Validate and normalize the manifest. No arbitrary line/quantity caps:
    one line per distinct (item_id, note, choices); identical lines merge by
    summed quantity (the server aggregates them and cannot echo duplicates).
    """
    if type(items) is not tuple or not items:
        fail('ITEM_MANIFEST_REQUIRED')
    merged = {}
    order = []
    for item in items:
        if type(item) is not Item:
            fail('BASIC_ITEM_MANIFEST_INVALID')
        valid_id = (_positive(item.item_id) if store.vertical == 'restaurants' else
                    type(item.item_id) is str and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', item.item_id))
        if not valid_id or type(item.quantity) is not int or item.quantity < 1:
            fail('BASIC_ITEM_MANIFEST_INVALID')
        if (item.note or item.choices) and store.vertical != 'restaurants':
            fail('ITEM_NOTES_RESTAURANTS_ONLY' if item.note else 'CHOICES_GROCERY_UNSUPPORTED')
        key = (item.item_id, item.note, _choices_key(item))
        if key not in merged:
            merged[key] = item
            order.append(key)
        else:
            previous = merged[key]
            merged[key] = Item(item.item_id, previous.quantity + item.quantity, item.note, item.choices)
    return tuple(merged[key] for key in order)


def _address(home):
    keys = quote_contract.ADDRESS_KEYS
    if (type(home) is not dict or any(k not in home for k in keys)
            or home.get('suite') != '2104' or type(home.get('country')) is not int
            or home['country'] != 4 or home.get('country_code') != '971'
            or type(home.get('area_id')) is not int or home['area_id'] != 1308
            or type(home.get('type')) is not int or not _id(home.get('id'))
            or not shared._number(home.get('latitude'), 25.06, 25.10)
            or not shared._number(home.get('longitude'), 55.14, 55.18)
            or any(type(home[k]) is not str for k in keys if k not in ('country', 'area_id', 'type', 'latitude', 'longitude'))):
        fail('SAVED_HOME_INVALID')
    address = {k: home[k] for k in keys}
    address.update(country=home['country_code'], latitude=float(home['latitude']), longitude=float(home['longitude']))
    return address


def cart_body(store, home, items):
    items = _items(store, items)
    _address(home)
    if store.vertical == 'restaurants':
        # f1dea8/f1e1b8; Rider is the native delivery-mode literal, not Delivery.
        # choices rows are the OBSERVED native payload (2026-10-11 capture):
        # choiceId is the chosen option id from ich[], with its own quantity
        # and immediate child option ids (Latea capture, 2026-10-14).
        return {'branchId': store.branch_id, 'countryId': 4, 'areaId': home['area_id'],
                'deliveryInformation': {'deliveryMode': 'Rider', 'latitude': float(home['latitude']),
                                        'longitude': float(home['longitude'])},
                'items': [{'menuItemId': x.item_id, 'quantity': x.quantity, 'specialRequest': x.note,
                           'choices': [{'choiceId': c[0], 'quantity': c[1], 'subChoiceIds': list(c[2])}
                                       for c in x.choices],
                           'isFromUpsell': False} for x in items],
                'hasOutstandingPayments': False}
    return {'dh_vendor_id': store.vendor_id, 'branch_id': str(store.branch_id),
            'chain_id': str(store.chain_id), 'global_entity_id': 'TB_AE',
            'items': [{'product_id': x.item_id, 'quantity': x.quantity, 'increment_weight': None} for x in items],
            'lat': float(home['latitude']), 'lon': float(home['longitude']),
            'campaign_progress_required': True, 'has_outstanding_payments': False}


@dataclass(frozen=True, repr=False)
class Cart:
    store: Store
    cart_id: str
    items: tuple
    route_amount_minor: int | None
    subtotal_minor: int | None
    observed_at: float
    raw_digest: str
    quote_item_ids: tuple
    # Grocery carts below the Mov campaign minimum quote fine but are refused
    # at placeOrder with a generic 400; surfaced so callers fail fast.
    below_minimum: bool = False
    # Server-generated choicesString per line, aligned with items and
    # quote_item_ids ('' for lines without choices / grocery lines).
    line_choice_labels: tuple = ()
    # Per-line undiscounted minor (item original price*qty + choice original
    # prices) for restaurants, aligned with items; () when catalog prices are
    # unknown (then the quote falls back to the legacy row-sum identity).
    line_undiscounted: tuple = ()


def _line_undiscounted(store, items, choice_catalog, item_prices):
    """Catalog-truth undiscounted value per line, or () when unknowable.

    Live CCX quotes with a cart-level discount return NET row totals
    (total != price*qty), so the only exact merchant-truth anchor is the
    live menu/choices catalog: item original price + choice original prices.
    """
    if store.vertical != 'restaurants' or type(item_prices) is not dict:
        return ()
    result = []
    for x in items:
        base = item_prices.get(x.item_id)
        if type(base) is not int or base < 0:
            return ()
        line = base * x.quantity
        for cid, cqty, subs in x.choices:
            # No choices means no choice catalog is needed. Requiring one for
            # plain items discarded their menu-price anchor and made net CCX
            # totals fail the legacy unit-price-times-quantity check.
            if type(choice_catalog) is not dict:
                return ()
            choice = choice_catalog.get(cid)
            if type(choice) is not dict or type(choice.get('original_price_minor')) is not int:
                return ()
            # Choice quantity is per item, just like specialRequest; every
            # unit on a multi-quantity line carries the same customization.
            line += choice['original_price_minor'] * cqty * x.quantity
            for sub_id in subs:
                child = choice.get('sub_choices', {}).get(sub_id)
                if type(child) is not dict or type(child.get('original_price_minor')) is not int:
                    return ()
                line += child['original_price_minor'] * x.quantity
        result.append(line)
    return tuple(result)


def parse_cart(data, store, items, *, choice_catalog=None, item_prices=None, now=None):
    items = _items(store, items)
    food = store.vertical == 'restaurants'
    cart = data.get('cart') if food and type(data) is dict else data
    if type(cart) is not dict or type(cart.get('items')) is not list:
        fail('CART_RESPONSE_INVALID')
    identity = cart.get('id')
    if food:
        # Native food parser takes int? id; ccx path stringifies that identity.
        if not _positive(identity):
            fail('FOOD_CART_ID_INVALID')
        identity = str(identity)
    elif not _id(identity):
        fail('GROCERY_CART_ID_INVALID')
    rows = cart['items']
    if len(rows) != len(items):
        fail('CART_ITEMS_CHANGED')
    remaining = list(items)
    row_of_item = {}
    for row in rows:
        if type(row) is not dict:
            fail('CART_ITEMS_CHANGED')
        item_id = row.get('menuItemId' if food else 'product_id')
        if ((food and not _positive(item_id)) or (not food and not _id(item_id))
                or type(row.get('quantity')) is not int):
            fail('CART_ITEMS_CHANGED')
        hit = None
        reasons = set()
        for index, item in enumerate(remaining):
            if item.item_id != item_id or item.quantity != row['quantity']:
                continue
            if not note_matches(row.get('specialRequest'), item.note):
                reasons.add('note')
                continue
            if food:
                if restaurant.choices_echo_matches(row, item.choices, choice_catalog):
                    hit = index
                    break
                reasons.add('choices')
            else:
                hit = index
                break
        if hit is None:
            if reasons == {'note'}:
                fail('FOOD_ITEM_NOTE_MISMATCH')
            if reasons == {'choices'}:
                fail('FOOD_CHOICE_ECHO_MISMATCH')
            fail('CART_ITEMS_CHANGED')
        item = remaining.pop(hit)
        if food:
            line_id = row.get('id')
            if not _positive(line_id):
                fail('CART_ITEMS_CHANGED')
            row_of_item[item] = (str(line_id), row.get('choicesString') or '')
        else:
            if (type(row.get('free_quantity', 0)) is not int or row.get('free_quantity', 0) != 0
                    or row.get('increment_weight') is not None):
                fail('GROCERY_WEIGHT_OR_FREE_ITEMS_UNSUPPORTED')
            row_of_item[item] = (item_id, '')
    quote_ids = tuple((item.item_id, row_of_item[item][0]) for item in items)
    labels = tuple(row_of_item[item][1] for item in items)
    if len({x[1] for x in quote_ids}) != len(quote_ids):
        fail('CART_ITEM_IDENTITY_AMBIGUOUS')
    if 'branch_id' in cart and (type(cart['branch_id']) not in (str, int) or str(cart['branch_id']) != str(store.branch_id)):
        fail('CART_BRANCH_MISMATCH')
    amount = cart.get('totalValue' if food else 'total')
    if not food and amount is not None and type(amount) not in (int, float):
        fail('GROCERY_TOTAL_TYPE_INVALID')
    subtotal = None if food else minor(cart.get('subtotal_after_discount'))
    progress = cart.get('campaign_progress') if type(cart.get('campaign_progress')) is dict else {}
    permanent = progress.get('permanent') if type(progress.get('permanent')) is dict else {}
    below_minimum = permanent.get('view_state') == 'below_threshold'
    return Cart(store, identity, items, None if amount is None else minor(amount), subtotal,
                time.monotonic() if now is None else now, hashlib.sha256(_json(data)).hexdigest(), tuple(quote_ids),
                below_minimum, labels, _line_undiscounted(store, items, choice_catalog, item_prices))


@dataclass(frozen=True, repr=False)
class CardSelection:
    event: bytes
    features: bytes
    global_features: bytes


def select_payment(config, saved_card):
    """Explicit saved5542 Talabat route; preserve async instrument and intervals."""
    shared.select_card({'data': [saved_card]})
    if type(config) is not dict or type(config.get('paymentMethods')) is not list:
        fail('PAYMENT_CONFIG_INVALID')
    matches = []
    for row in config['paymentMethods']:
        if type(row) is not dict:
            fail('PAYMENT_CONFIG_INVALID')
        events = row.get('events')
        event = events.get('payment') if type(events) is dict else None
        card = event.get('card') if type(event) is dict else None
        if type(card) is dict and card.get('cardId') == saved_card['tokenId']:
            matches.append(row)
    if len(matches) != 1:
        fail('EXACT_SAVED5542_ROUTE_NOT_UNIQUE')
    row = matches[0]; events = row['events']; event = events['payment']
    if row.get('isEnabled') is not True or row.get('paymentMode') is not None:
        fail('PAYMENT_MODE_OR_ENABLED_UNSUPPORTED')
    if not isinstance(row.get('title'), str) or not re.search(r'(?<![0-9])5542(?![0-9])', row['title']):
        fail('SAVED5542_TITLE_MISMATCH')
    if set(events) - {'prePayment', 'selected', 'payment', 'postPayment'}:
        fail('PAYMENT_EVENTS_UNSUPPORTED')
    for key in ('prePayment', 'selected', 'postPayment'):
        if events.get(key) is not None:
            fail('PAYMENT_CVV_REQUIRED' if key == 'prePayment' and type(events[key]) is dict and events[key].get('name') == 'ForceCVV'
                 else 'PAYMENT_PRECHECK_OR_WALLET_UNSUPPORTED')
    if (set(event) - route_contract.EVENT_KEYS or event.get('platform') != 'talabat'
            or event.get('platformType') not in ('sync', 'async')):
        fail('PAYMENT_PLATFORM_BRANCH_UNSUPPORTED')
    method, card = event.get('method'), event.get('card')
    if (type(method) is not dict or set(method) != route_contract.METHOD_KEYS
            or type(method['paymentMethod']) is not int or method['paymentMethod'] != 2
            or type(method['addTPayMethod']) is not int or method['addTPayMethod'] != 7
            or not all(_id(method[k]) for k in ('paymentMethodName', 'addTPayMethodName'))
            or type(card) is not dict or not route_contract.CARD_KEYS <= set(card)
            or set(card) - route_contract.CARD_KEYS - {'paymentProvider'}
            or ('paymentProvider' in card and type(card['paymentProvider']) is not int)
            or not all(_id(card[k]) for k in route_contract.CARD_KEYS)
            or not re.fullmatch(r'[0-9]{6,8}', card['binNumber'])):
        fail('PAYMENT_METHOD_OR_CARD_INVALID')
    routing = event.get('routingCriteria')
    if routing is not None and (type(routing) is not dict or set(routing) != {'pu'} or not _id(routing['pu'])):
        fail('PAYMENT_ROUTING_INVALID')
    if event['platformType'] == 'async':
        polling_intervals(event.get('paymentStatusPullingInterval'))
        if not _id(event.get('instrumentId')):
            fail('ASYNC_SAVED_CARD_INSTRUMENT_REQUIRED')
    elif event.get('instrumentId') is not None or event.get('paymentStatusPullingInterval') is not None:
        fail('SYNC_INSTRUMENT_OR_POLLING_UNSUPPORTED')
    features, global_features = row.get('supportedFeatures'), config.get('supportedFeatures')
    if (type(features) is not dict or set(features) != quote_contract.CARD_FEATURES
            or type(global_features) is not dict or set(global_features) != {'paySupportsTPro'}
            or any(type(v) is not bool for v in (*features.values(), *global_features.values()))):
        fail('PAYMENT_FEATURES_UNSUPPORTED')
    mapped = {k: event.get(k) for k in route_contract.EVENT_KEYS}
    # Actual config additionally returns paymentProvider:int. The complete
    # native GEg parser/serializer reads/emits only these three card fields;
    # provider is not top-level FDg.method and must not be forwarded there.
    mapped['card'] = {k: card[k] for k in route_contract.CARD_KEYS}
    return CardSelection(_json(mapped), _json(features), _json(global_features))


def polling_intervals(value):
    """Native seconds -> truncated milliseconds; caps are local read budgets."""
    if (type(value) is not list or not 1 <= len(value) <= MAX_POLL_COUNT
            or any(type(x) not in (int, float) or not math.isfinite(x)
                   or not 0.001 <= x <= 60 for x in value)
            or sum(value) > MAX_POLL_SECONDS):
        fail('PAYMENT_POLL_INTERVALS_INVALID')
    # GHg multiplies each double by 1000, truncates, then constructs Duration
    # from milliseconds. Preserve the original list in KEg JSON independently.
    return tuple(int(x * 1000) / 1000 for x in value)


def quiet_ids(container, *, require_selected=False):
    choices = shared.instruction_choices(container)
    by_title = {x.title: x for x in choices}
    if len(by_title) != len(choices) or set(by_title) - quote_contract.PRESET_LABELS:
        fail('QUIET_CONTROLS_UNSUPPORTED')
    needed = {'Leave at my door', "Don't ring doorbell", 'Call on arrival'}
    if not needed <= set(by_title) or not all(by_title[x].enabled for x in needed):
        fail('QUIET_CONTROLS_UNAVAILABLE')
    selected = {'Leave at my door', "Don't ring doorbell"}
    if require_selected and {x.title for x in choices if x.selected} != selected:
        fail('QUIET_CONTROLS_READBACK_MISMATCH')
    return tuple(x.id for x in choices if x.title in selected)


def prepare_body(store, home, *, selection=None, features=None, instructions=None):
    address = _address(home)
    if selection is None:
        if type(features) is not dict or set(features) != {'paySupportsTPro'} or type(features['paySupportsTPro']) is not bool:
            fail('INITIAL_FEATURES_REQUIRED')
        feature_map, method, card = features, None, None
    else:
        if type(selection) is not CardSelection:
            fail('CARD_SELECTION_REQUIRED')
        event = json.loads(selection.event)
        method, card = event['method'], event['card']
        feature_map = {**json.loads(selection.global_features), **json.loads(selection.features)}
    body = {'countryCode': 'AE', 'deviceLatitude': float(home['latitude']),
            'deviceLongitude': float(home['longitude']),
            'paymentMethod': None if method is None else method['paymentMethod'],
            'addTPayMethod': None if method is None else method['addTPayMethod'],
            'riderTipAmount': None, 'isCustomRiderTip': None, 'saveRiderTipForLater': False,
            'proSubscribeChecked': False, 'walletBalance': None, 'isMigrated': store.migrated,
            'branchId': store.branch_id, 'verticalId': store.vertical_id,
            'binNumber': None if card is None else card['binNumber'], 'hasDues': None,
            **feature_map, 'selectedAddressId': home['id'], 'addressV2': address, 'quickCheckout': False}
    if card is not None:
        body['cardFingerPrint'] = card['cardFingerPrint']
    if instructions is not None:
        body['deliveryInstructions'] = list(quiet_ids(instructions))
    return body


@dataclass(frozen=True, repr=False)
class Quote:
    cart: Cart
    amount_minor: int
    currency: str
    body: bytes
    response: bytes
    home: bytes
    selection: CardSelection | None
    observed_at: float
    instruction_ids: tuple


def parse_quote(data, cart, home, body, selection, *, now=None):
    checkout = data.get('checkout') if type(data) is dict else None
    country = data.get('branchInfo', {}).get('country') if type(data) is dict and type(data.get('branchInfo')) is dict else None
    if (type(checkout) is not dict or type(country) is not dict or country.get('currencyCode') != 'AED'
            or type(country.get('id')) is not int or country['id'] != 4
            or type(checkout.get('branchId')) is not int or checkout['branchId'] != cart.store.branch_id
            or type(data.get('tracking')) is not dict
            or data['tracking'].get('cartId') != (str(cart.cart_id) if cart.store.vertical == 'restaurants' else cart.cart_id)):
        fail('QUOTE_CART_BRANCH_CURRENCY_MISMATCH')
    address = checkout.get('address')
    if (type(address) is not dict or type(address.get('areaId')) is not int or address['areaId'] != home['area_id']
            or any(type(address.get(k)) not in (int, float) or address[k] != home[k] for k in ('latitude', 'longitude'))
            or type(address.get('description')) is not str or not re.search(r'(?<!\w)2104(?!\w)', address['description'])):
        fail('QUOTE_HOME_MISMATCH')
    rows = checkout.get('cart', {}).get('items') if type(checkout.get('cart')) is dict else None
    if type(rows) is not list or len(rows) != len(cart.items):
        fail('QUOTE_ITEM_MANIFEST_MISMATCH')
    # Per-line mapping via native line ids: duplicate menu items with distinct
    # notes/choices are distinct lines. Quote choicesString is compared to the
    # server-generated cart echo label, never to a locally formatted guess.
    line_of = {line_id: (item, label) for (_item_id, line_id), item, label
               in zip(cart.quote_item_ids, cart.items, cart.line_choice_labels)}
    # Catalog-truth undiscounted per line, aligned with cart.items; () disables.
    undiscounted = cart.line_undiscounted if len(cart.line_undiscounted) == len(cart.items) else ()
    seen = set(); item_total = 0
    for row in rows:
        if type(row) is not dict:
            fail('QUOTE_ITEM_MANIFEST_MISMATCH')
        item_id = row.get('id' if cart.store.vertical == 'restaurants' else 'itemGuid')
        if type(item_id) is int and cart.store.vertical == 'restaurants':
            item_id = str(item_id)
        if type(item_id) is not str or item_id in seen or item_id not in line_of:
            fail('QUOTE_ITEM_MANIFEST_MISMATCH')
        item, label = line_of[item_id]
        if (type(row.get('quantity')) is not int or row['quantity'] != item.quantity
                or row.get('choicesString') not in ((None, '') if not label else (label,))):
            fail('QUOTE_ITEM_MANIFEST_MISMATCH')
        if not note_matches(row.get('specialRequest'), item.note):
            fail('QUOTE_ITEM_NOTE_MISMATCH')
        seen.add(item_id)
        price, total = _display_minor(row.get('price')), _display_minor(row.get('total'))
        if cart.store.vertical == 'restaurants' and undiscounted:
            # Live coupon-discounted carts return NET row totals: total may be
            # below price*qty (cart-level discount) or above it (choices are
            # included in total but not in the per-unit price display). Exact
            # merchant truth is the catalog-undiscounted bound per line.
            bound = undiscounted[cart.items.index(item)]
            if (total > bound or (not item.choices and
                    price * item.quantity not in (bound, total))):
                fail('QUOTE_ITEM_PRICE_MISMATCH')
        elif price * row['quantity'] != total:
            fail('QUOTE_ITEM_PRICE_MISMATCH')
        item_total += total
    summary = checkout.get('paymentSummary')
    charges = summary.get('items') if type(summary) is dict else None
    if type(charges) is not list or any(type(x) is not dict for x in charges):
        fail('QUOTE_CHARGES_INVALID')
    amounts = {}
    for charge in charges:
        kind = charge.get('type')
        # Live CCX: grocery promo, pro booster, and Right Bite's offer Coupon
        # are positive discount amounts, subtracted exactly once. The latter
        # also returns a distinct SmallOrderFee (2026-10-11, AED 25.60 quote).
        bucket = 'Discount' if kind in ('GroceryDiscountType', 'AutoAppliedDiscount', 'Coupon') else kind
        if bucket not in ('SubTotal', 'DeliveryFee', 'ServiceFee', 'SmallOrderFee',
                          'Total', 'Discount', 'Tip', 'Tax') or bucket in amounts:
            fail('QUOTE_CHARGE_TYPE_UNSUPPORTED')
        raw = charge.get('amount') if charge.get('amount') is not None else charge.get('value')
        amounts[bucket] = minor(charge.get('amount')) if charge.get('amount') is not None else _display_minor(raw)
    amount = minor(checkout.get('amount'))
    if not {'SubTotal', 'Total'} <= amounts.keys():
        fail('QUOTE_AMOUNT_RECONCILIATION_FAILED')
    discount = amounts.get('Discount', 0)
    gross = sum(v for k, v in amounts.items() if k not in ('Total', 'Discount'))
    if cart.store.vertical == 'restaurants':
        # Two OBSERVED row shapes, both exact:
        # - undiscounted rows (no cart-level discount): rows sum to SubTotal;
        # - net rows (cart-level coupon, 2026-10-11 live ZeroFat): SubTotal is
        #   the catalog-undiscounted sum and rows sum to SubTotal - discount.
        # With catalog prices, SubTotal itself is anchored to merchant truth.
        subtotal_ok = (sum(undiscounted) == amounts['SubTotal'] if undiscounted
                       else amounts['SubTotal'] == item_total)
        rows_ok = item_total in (amounts['SubTotal'], amounts['SubTotal'] - discount)
        # The food cart's totalValue is stateful: the discounted item value
        # before any quote, the full payable once the server has quoted.
        route_ok = cart.route_amount_minor in (item_total, amounts['SubTotal'] - discount, amount)
        reconciled = subtotal_ok and rows_ok and route_ok
    else:
        # Grocery rows are already discounted per line.
        reconciled = (amounts['SubTotal'] - discount == item_total
                      and (cart.subtotal_minor is None or cart.subtotal_minor == item_total))
    if (amount <= 0 or amounts['Total'] != amount
            or amounts.get('Tip', 0) != 0 or amounts.get('Tax', 0) != 0
            or not 0 <= discount <= amounts['SubTotal']
            or not reconciled
            or gross - discount != amount):
        fail('QUOTE_AMOUNT_RECONCILIATION_FAILED')
    if checkout.get('subscription') is not None:
        fail('QUOTE_SUBSCRIPTION_UNSUPPORTED')
    tip = checkout.get('riderTips')
    if tip is not None and (type(tip) is not dict or type(tip.get('options')) is not list
                           or any(type(x) is not dict or x.get('isSelected') is not False for x in tip['options'])):
        fail('QUOTE_TIP_UNSUPPORTED')
    instructions = quiet_ids(checkout.get('deliveryInstructions'), require_selected='deliveryInstructions' in body)
    if 'deliveryInstructions' in body and list(instructions) != body['deliveryInstructions']:
        fail('QUIET_CONTROL_IDS_CHANGED')
    expected_body = prepare_body(cart.store, home, selection=selection,
                                features=None if selection else {'paySupportsTPro': body.get('paySupportsTPro')},
                                instructions=checkout['deliveryInstructions'] if 'deliveryInstructions' in body else None)
    if not quote_contract._same_json(body, expected_body):
        fail('QUOTE_REQUEST_BINDING_MISMATCH')
    return Quote(cart, amount, 'AED', _json(body), _json(data), _json(home), selection,
                 time.monotonic() if now is None else now, instructions)


def place_body(quote):
    if type(quote) is not Quote or quote.selection is None:
        fail('SELECTED_CARD_QUOTE_REQUIRED')
    prepared = json.loads(quote.body)
    if prepared.get('deliveryInstructions') != list(quote.instruction_ids):
        fail('QUIET_SELECTED_QUOTE_REQUIRED')
    event = json.loads(quote.selection.event)
    body = {k: prepared[k] for k in ('countryCode', 'paymentMethod', 'addTPayMethod', 'binNumber',
            'isMigrated', 'branchId', 'verticalId', 'selectedAddressId', 'addressV2', 'cardFingerPrint')}
    body.update(allowDuplicateOrder=False, riderTipAmount=None, isCustomRiderTip=None,
                saveRiderTipForLater=False, proSubscribeChecked=False, cardTokenId=event['card']['cardId'],
                proPlanId=None, priorityLevel='', quickCheckout=False, flow=None,
                deliveryInstructions=list(quote.instruction_ids), saveDeliveryInstructionsForLater=False)
    return body


def payment_body(observation, quote):
    """17-field FDg branch with deliberately empty optional tokenization state.

    New-card/pretokenized/SDK/wallet/fallback state is never created by this
    client. keepCard/method/cardToken/pu are consequently null, not copied from
    the saved-card event. The selected event is the effective event here.
    """
    place_body(quote)
    if (type(observation) is not place_contract.PlaceObservation
            or observation.state != 'PAYMENT_PENDING' or observation.redirect_url
            or not place_contract._order_id(observation.order_id) or not _id(observation.transaction_id)
            or observation.balance_amount is None
            or minor(observation.balance_amount) not in (0, quote.amount_minor)):
        fail('PAYMENT_PLACE_AMOUNT_OR_IDENTITY_MISMATCH')
    body = dict.fromkeys(PAYMENT_KEYS)
    # Native QHg/FDg sends the returned balance, including zero. The approved
    # quote remains the journal's full financial reservation; zero is not paid.
    body.update(eTransId=observation.transaction_id, orderId=observation.order_id,
                 payment=json.loads(quote.selection.event), remainingAmount=float(major(minor(observation.balance_amount))),
                 paymentScenario='deliveryOrder', countryId=4)
    return body


@dataclass(frozen=True, repr=False)
class PaymentResult:
    state: str
    reason: str
    order_id: str
    transaction_id: str
    payment_id: str | None = None
    metadata: str | None = None


def parse_payment(status, data, observation, *, platform_type):
    """POST result is pending on async, never inferred successful from HTTP200."""
    if platform_type not in ('sync', 'async'):
        fail('PAYMENT_PLATFORM_TYPE_REQUIRED')
    state, reason = 'PAYMENT_UNKNOWN', 'RESPONSE_INVALID_NO_RETRY'
    payment_id = metadata = None
    if type(data) is dict and type(status) is int and status in (200, 201, 202, 422):
        strings = ('paymentId', 'metadata', 'redirectUrl', 'hyperPayCheckoutId')
        maps = ('error', 'fallback', 'benefitPayConfig')
        if (all(data.get(k) is None or (type(data[k]) is str and len(data[k]) <= 8192
                                      and all(ord(c) >= 32 for c in data[k])) for k in strings)
                and all(data.get(k) is None or type(data[k]) is dict for k in maps)):
            if data.get('fallback') is not None:
                state, reason = 'PAYMENT_BLOCKED', 'FALLBACK_NOT_FOLLOWED'
            # PHg explicitly skips null AND empty redirect strings. Async has
            # no supported POST redirect callback here: any supplied String
            # (including empty) is an unresolved continuation, not readiness.
            elif (data.get('redirectUrl') is not None if platform_type == 'async' else bool(data.get('redirectUrl'))):
                state, reason = 'CHALLENGE_REQUIRED', 'REDIRECT_NOT_FOLLOWED'
            elif data.get('hyperPayCheckoutId') is not None or data.get('benefitPayConfig') is not None:
                state, reason = 'PAYMENT_BLOCKED', 'SDK_BRANCH_NOT_SUPPORTED'
            elif data.get('error') is not None:
                state, reason = 'PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_ASSUMED'
            elif 200 <= status < 300 and set(data) <= set(strings + maps):
                payment_id, metadata = data.get('paymentId'), data.get('metadata')
                state, reason = (('PAYMENT_PENDING', 'TALABAT_ASYNC_STATUS_REQUIRED') if platform_type == 'async'
                                 else ('PAYMENT_REPORTED_SUCCESS', 'TALABAT_SYNC_NORMAL_RETURN'))
    return PaymentResult(state, reason, observation.order_id, observation.transaction_id, payment_id, metadata)


@dataclass(frozen=True, repr=False)
class AsyncPaymentContext:
    """Private exact-request readback inputs; contains no card/auth material.

    Parent may persist this allowlisted identity record for GET-only recovery.
    It cannot authorize a place/payment retry. Do not log or print its fields.
    """
    order_id: str
    transaction_id: str
    acceptance_id: str
    intervals: tuple
    account_binding: str
    payment_id: str | None = None
    metadata: str | None = None


def async_context(observation, selection, acceptance_id, payment, *, account_binding):
    if (type(observation) is not place_contract.PlaceObservation
            or observation.state != 'PAYMENT_PENDING' or observation.redirect_url
            or not place_contract._order_id(observation.order_id) or not _id(observation.transaction_id)
            or type(payment) is not PaymentResult or payment.order_id != observation.order_id
            or payment.transaction_id != observation.transaction_id
            or payment.state not in ('PAYMENT_PENDING', 'PAYMENT_UNKNOWN')):
        fail('ASYNC_READBACK_IDENTITY_OR_STATE_INVALID')
    event = json.loads(selection.event)
    if event.get('platform') != 'talabat' or event.get('platformType') != 'async':
        fail('ASYNC_ROUTE_REQUIRED')
    return AsyncPaymentContext(observation.order_id, observation.transaction_id, _flow(acceptance_id),
                               polling_intervals(event['paymentStatusPullingInterval']),
                               account_binding,
                               payment.payment_id, payment.metadata)


def payment_status_params(context):
    if (type(context) is not AsyncPaymentContext or not place_contract._order_id(context.order_id)
            or not _id(context.transaction_id) or type(context.intervals) is not tuple
            or type(context.account_binding) is not str
            or not re.fullmatch(r'[0-9a-f]{64}', context.account_binding)):
        fail('ASYNC_READBACK_CONTEXT_INVALID')
    _flow(context.acceptance_id)
    polling_intervals(list(context.intervals))
    params = {'isRedirectionInitiated': 'false', 'encryptedTransactionId': context.transaction_id,
              'scenario': 'deliveryOrder', 'subscription': 'false'}
    for key, value in (('metadata', context.metadata), ('paymentId', context.payment_id)):
        if value is not None:
            if type(value) is not str or len(value) > 8192 or any(ord(c) < 32 for c in value):
                fail('ASYNC_READBACK_CONTEXT_INVALID')
            params[key] = value
    return params


def parse_async_status(status, data, context):
    """Exact GET association supplies identity; bEg does not echo IDs."""
    payment_status_params(context)
    state, reason = 'PAYMENT_UNKNOWN', 'STATUS_READ_FAILED_NO_RETRY'
    if status in (200, 422) and type(status) is int and type(data) is dict:
        if (set(data) <= {'status', 'error', 'errors', 'fallback', 'redirectUrl', 'hyperPayCheckoutId'}
                and all(data.get(k) is None or type(data[k]) is str for k in ('status', 'redirectUrl', 'hyperPayCheckoutId'))
                and all(data.get(k) is None or type(data[k]) is dict for k in ('error', 'errors', 'fallback'))):
            signal = data['status'].strip().lower() if data.get('status') is not None else None
            errors = [data[k] for k in ('error', 'errors') if data.get(k) is not None]
            if data.get('fallback') is not None:
                state, reason = 'PAYMENT_BLOCKED', 'FALLBACK_NOT_FOLLOWED'
            # A supplied continuation must not hide behind an empty string.
            # Native redirection with no URL throws; never turn it into success.
            elif data.get('redirectUrl') is not None or signal == 'redirection':
                state, reason = 'CHALLENGE_REQUIRED', 'REDIRECT_NOT_FOLLOWED'
            elif data.get('hyperPayCheckoutId') is not None:
                state, reason = 'PAYMENT_BLOCKED', 'SDK_BRANCH_NOT_SUPPORTED'
            elif errors or signal == 'error':
                state, reason = 'PAYMENT_ERROR_REPORTED', 'NO_ROLLBACK_OR_RETRY_ASSUMED'
                # Native v2 now returns Error plus duplicate error/errors maps.
                # Recognize only the observed processor diagnostic, never expose
                # arbitrary exception text or treat a decline as no-charge proof.
                if signal == 'error' and errors and all(error.get('exception') ==
                        '20051 - Insufficient funds, please try again with another card.' for error in errors):
                    reason = 'PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY'
            elif status == 200 and signal == 'success':
                state, reason = 'PAYMENT_REPORTED_SUCCESS', 'EXACT_TRANSACTION_ASYNC_STATUS_SUCCESS'
            elif status == 200 and (signal is None or signal == 'pending'):
                state, reason = 'PAYMENT_PENDING', 'ASYNC_STATUS_PENDING'
            else:
                reason = 'ASYNC_STATUS_LITERAL_UNSUPPORTED'
    return PaymentResult(state, reason, context.order_id, context.transaction_id, context.payment_id, context.metadata)


def _retain(receipt, record):
    """Trusted private parent sink; never echoes values or exception details."""
    try:
        if not callable(receipt) or receipt(record) is not True:
            fail('RECEIPT_NOT_DURABLE')
    except Exception:
        _park_failed_receipt(record)
        fail('RECEIPT_PERSIST_FAILED_NO_MUTATION_RETRY')


def _park_failed_receipt(record):
    """Durably park a receipt that could not enter the store.

    A mutation whose response cannot be journaled must not lose its evidence:
    the order/transaction identities in the response are the only way to
    settle the flow later. Write a sidecar JSON next to the journal (mode
    0600, best-effort) before the caller aborts. Never raises into the
    abort path; never echoes values in the exception.
    """
    try:
        import json as _json
        import commerce_journal as _journal
        root = os.path.join(str(_journal.ROOT), 'pending')
        os.makedirs(root, exist_ok=True)
        flow_id = record.get('flow_id') or 'unknown'
        operation = record.get('operation') or 'unknown'
        stamp = time.strftime('%Y%m%dT%H%M%S')
        path = os.path.join(root, '%s.%s.%s.json' % (flow_id, operation, stamp))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as fh:
            fh.write(_json.dumps(record, default=str))
    except Exception:
        pass


class AsyncPaymentPoller:
    """Bounded GET-only continuation, also usable after parent-journal recovery.

    Sleeps the next native interval before each GET. Separate deadline from
    precharge quote freshness. No refresh, callback, fallback or financial send.
    """
    def __init__(self, saved, context, *, receipt, next_index=0, timeout=120):
        self.saved = _copy(saved)
        auth.binding(self.saved)
        self.params = payment_status_params(context)
        if context.account_binding != hashlib.sha256(str(self.saved['expected_profile']['id']).encode()).hexdigest():
            fail('ASYNC_READBACK_ACCOUNT_MISMATCH')
        if type(next_index) is not int or not 0 <= next_index <= len(context.intervals) or not callable(receipt):
            fail('ASYNC_POLL_RECOVERY_INVALID')
        self.context, self.receipt, self.next_index = context, receipt, next_index
        self.deadline = auth.new_deadline(timeout)
        orders.verify_profile(orders.request(orders.PROFILE, self.saved, self.deadline), self.saved)
        self.result = PaymentResult('PAYMENT_PENDING', 'ASYNC_STATUS_NOT_READ', context.order_id, context.transaction_id,
                                    context.payment_id, context.metadata)
        self.stopped = False

    def poll(self, *, max_reads=90):
        if type(max_reads) is not int or not 1 <= max_reads <= MAX_POLL_COUNT:
            fail('ASYNC_POLL_BUDGET_INVALID')
        if self.stopped:
            return self.result
        for _ in range(max_reads):
            if self.next_index == len(self.context.intervals):
                self.result = PaymentResult('PAYMENT_PENDING', 'ASYNC_POLL_SCHEDULE_EXHAUSTED', self.context.order_id,
                                            self.context.transaction_id, self.context.payment_id, self.context.metadata)
                break
            delay = self.context.intervals[self.next_index]
            if self.deadline - time.monotonic() <= delay:
                self.result = PaymentResult('PAYMENT_PENDING', 'ASYNC_POLL_DEADLINE_REACHED', self.context.order_id,
                                            self.context.transaction_id, self.context.payment_id, self.context.metadata)
                break
            if auth.expiry(self.saved['auth']) <= time.time() + delay + 1:
                self.result = PaymentResult('PAYMENT_PENDING', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED', self.context.order_id,
                                            self.context.transaction_id, self.context.payment_id, self.context.metadata)
                break
            time.sleep(delay)
            response = _wire(self.saved, min(self.deadline, time.monotonic() + 10), 'GET',
                             '/pay/v2/payment/status', params=self.params,
                             headers={'x-acceptance-request-id': self.context.acceptance_id})
            self.next_index += 1
            self.result = parse_async_status(response.status, response.data, self.context)
            if response.status == 401:
                self.result = PaymentResult('PAYMENT_UNKNOWN', 'ASYNC_READ_AUTH_RENEWAL_REQUIRED', self.context.order_id,
                                            self.context.transaction_id, self.context.payment_id, self.context.metadata)
            # Commit exact identities, response signal and cursor before another
            # GET. Exception leaves the observed result/cursor available in RAM.
            self.stopped = self.result.state != 'PAYMENT_PENDING'
            try:
                _retain(self.receipt, {'operation': 'payment_status', 'context': self.context,
                                      'result': self.result, 'next_index': self.next_index,
                                      'http_status': response.status})
            except orders.TalabatError:
                self.stopped = True
                raise
            if self.stopped:
                break
        return self.result


@dataclass(frozen=True, repr=False)
class WireResponse:
    status: int | None
    data: dict | None


def _decode_response(raw, encoding):
    """Bounded UTF-8 JSON, rejecting ambiguous keys and non-finite numbers."""
    if len(raw) > MAX_BYTES or type(encoding) is not str:
        raise ValueError('RESPONSE_ENCODING_OR_SIZE_INVALID')
    encoding = encoding.strip().lower()
    if encoding == 'gzip':
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(raw, MAX_BYTES + 1)
        if (len(raw) > MAX_BYTES or decoder.unconsumed_tail or not decoder.eof
                or decoder.unused_data):
            raise ValueError('RESPONSE_GZIP_INVALID_OR_TOO_LARGE')
    elif encoding not in ('', 'identity'):
        raise ValueError('RESPONSE_ENCODING_UNSUPPORTED')

    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                raise ValueError('DUPLICATE_JSON_KEY')
            result[key] = value
        return result

    def constant(_value):
        raise ValueError('NONFINITE_JSON_NUMBER')

    def floating(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('NONFINITE_JSON_NUMBER')
        return number

    data = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=constant, parse_float=floating)
    if type(data) is not dict:
        raise ValueError('JSON_OBJECT_REQUIRED')
    return data


def _wire(saved, deadline, method, path, *, host=API, params=None, body=None, headers=None):
    """Internal single transmission. Never follows redirects or refreshes auth."""
    native = auth.native_headers(saved)
    deny = {'authorization', 'cookie', 'host', 'content-length', 'x-request-id', 'x-acceptance-request-id',
            'x-api-key', 'x-customer-id', 'x-platform', 'x-user-flow', 'accept-encoding'}
    native = {k: v for k, v in native.items() if k.lower() not in deny}
    native.update({'authorization': 'Bearer ' + saved['auth']['access_token'], 'content-type': 'application/json',
                   'cache-control': 'no-cache', 'accept-encoding': 'gzip', **(headers or {})})
    url = host + path + ('?' + urllib.parse.urlencode(params) if params else '')
    request = urllib.request.Request(url, method=method, headers=native, data=None if body is None else _json(body))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), orders.NoRedirect())
    status = None
    try:
        with orders.read_deadline(deadline) as remaining:
            try:
                response = opener.open(request, timeout=remaining)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                status = response.code
                encoding = response.headers.get('Content-Encoding', '')
                raw = response.read(MAX_BYTES + 1)
            return WireResponse(status, _decode_response(raw, encoding))
    except (urllib.error.URLError, HTTPException, OSError, ValueError, TypeError,
            RecursionError, zlib.error, orders.TalabatError):
        return WireResponse(status, None)


class Checkout:
    """One parent-owned flow. Persist identity/digest/phase before every mutation.

    journal(record) must durably consume the operation before returning exactly
    True. The callback is a trusted parent integration, not server idempotency.
    journal records contain hashes and the exact payment_order_id for payment.
    receipt(record) separately retains typed
    received IDs/status/context in the parent's private durable journal, before
    financial continuation or another status GET. Never log that private record.
    After process loss the parent must restore its fence, never start over.
    """
    def __init__(self, saved, *, flow_id, journal, receipt, timeout=45, fresh_account=None):
        self.saved = _copy(saved)
        auth.binding(self.saved)
        self.flow_id = _flow(flow_id)
        self.journal = journal
        self.receipt = receipt
        self.fresh_account = fresh_account
        self._receipt_failed = False
        self._mutation_unknown = False
        self._last_response = None  # private RAM for exact response reconciliation
        self.payment_result = None
        self.payment_poller = None
        self.deadline = auth.new_deadline(timeout)
        self.created_at = time.monotonic()
        self.consumed = set()
        self.cart = None
        self.restaurant_cart = None
        self.quote = None
        self.selection = None
        self.config = None
        self.config_amount_minor = None
        self.placed = None
        self._place_quote = None
        self._verticals_key = None
        # Choice-id truth from live menu reads (populated by
        # verify_restaurant_items); used for exact cart echo validation.
        self._choice_catalog = None
        self._item_prices = None
        self.home = self.card = None
        if not callable(journal) or not callable(receipt):
            fail('PARENT_DURABLE_JOURNAL_REQUIRED')
        self._fresh()
        orders.verify_profile(orders.request(orders.PROFILE, self.saved, self.deadline), self.saved)
        self.home = shared.select_home(self._read('/api/v2/user/addresses', host=shared.ADDRESS_API, params={'countryId': 4}), self.saved)
        self.card = shared.select_card(self._read('/pay/v1/cards', params={'countryId': 4}))
        _address(self.home)

    def _fresh(self):
        orders.remaining_time(self.deadline)
        if time.monotonic() - self.created_at >= MAX_AGE:
            fail('CHECKOUT_CONTEXT_STALE')
        if auth.expiry(self.saved.get('auth', {})) <= time.time() + 30:
            fail('AUTH_EXPIRED_RENEW_BEFORE_NEW_MUTATION')

    def _read(self, path, **kwargs):
        self._fresh()
        result = _wire(self.saved, self.deadline, 'GET', path, **kwargs)
        if result.status != 200 or result.data is None:
            fail({401: 'AUTH_EXPIRED_RENEWAL_REQUIRED', 403: 'AUTH_FORBIDDEN', 429: 'RATE_LIMITED'}.get(result.status, 'CHECKOUT_READ_FAILED'))
        return result.data

    def _mutate(self, operation, path, body, *, headers=None):
        # Renewal/validation belongs before consuming this operation. A supplied
        # provider returns a one-use, profile-verified account snapshot; it never
        # receives a mutation callback and therefore cannot replay this request.
        if self.fresh_account is not None:
            if not callable(self.fresh_account):
                fail('FRESH_ACCOUNT_PROVIDER_INVALID')
            fresh = self.fresh_account()
            auth.binding(fresh)
            if fresh['expected_profile'] != self.saved['expected_profile']:
                fail('FRESH_ACCOUNT_IDENTITY_CHANGED')
            self.saved = _copy(fresh)
        self._fresh()
        if self._receipt_failed:
            fail('RECEIPT_PERSIST_FAILED_NO_MUTATION_RETRY')
        if self._mutation_unknown:
            fail('PREVIOUS_MUTATION_UNKNOWN_NO_CONTINUATION')
        if 'place' in self.consumed and operation not in ('place', 'payment'):
            fail('CHECKOUT_ALREADY_SUBMITTED')
        if operation in self.consumed:
            fail('OPERATION_ALREADY_CONSUMED_NO_RETRY')
        encoded = _json(body)
        record = {'version': 1, 'app': 'talabat', 'flow_id': self.flow_id, 'operation': operation,
                  'account_binding': hashlib.sha256(str(self.saved['expected_profile']['id']).encode()).hexdigest(),
                  'request_sha256': hashlib.sha256(path.encode() + b'\0' + encoded).hexdigest(),
                  'state': 'MAY_HAVE_SENT'}
        if self.cart is not None:
            record['cart_binding'] = hashlib.sha256(self.cart.cart_id.encode()).hexdigest()
        if operation in ('place', 'payment'):
            reviewed = self._place_quote if operation == 'payment' else self.quote
            record.update(currency='AED', payable_minor=reviewed.amount_minor,
                          review_sha256=project_quote(reviewed)['quote_digest'])
        if operation == 'payment':
            if self.placed is None or not place_contract._order_id(self.placed.order_id):
                fail('EXACT_PAYMENT_ORDER_ID_REQUIRED')
            record['payment_order_id'] = self.placed.order_id
        self.consumed.add(operation)
        try:
            if self.journal(record) is not True:
                fail('PARENT_JOURNAL_NOT_DURABLE')
        except orders.TalabatError:
            raise
        except Exception as e:
            # Surface the parent's exact refusal for diagnosis; operation stays consumed.
            fail('PARENT_JOURNAL_FAILED_OPERATION_CONSUMED:' + str(e)[:160])
        # Deadline/auth failure after journal consumption must not restore intent.
        self._fresh()
        response = _wire(self.saved, self.deadline, 'POST', path, body=body,
                         headers={'x-request-id': self.flow_id, **(headers or {})})
        self._last_response = (operation, response)
        return response

    def _received(self, record):
        try:
            _retain(self.receipt, {'flow_id': self.flow_id, **record})
        except orders.TalabatError:
            self._receipt_failed = True
            raise

    def _unknown_preparation(self, operation, status):
        self._mutation_unknown = True
        self.quote = None
        self._received({'operation': operation, 'state': 'SUBMISSION_UNKNOWN',
                        'reason': 'RESPONSE_INVALID_OR_UNAVAILABLE_NO_RETRY', 'http_status': status})
        fail('PREPARATION_SUBMISSION_UNKNOWN_NO_CONTINUATION')

    def _failed_quote(self, operation, result, exc):
        # CCX quote can update checkout/cart state but cannot place or pay.
        # Terminate this flow, retaining exact diagnostics and consumed ops;
        # the parent atomically releases only a proven pre-financial history.
        self._mutation_unknown = True
        self.quote = None
        diagnostic = quote_failure_diagnostic(result.data, exc)
        self._received({'operation': operation, 'state': 'PREPARATION_FAILED',
                        'reason': diagnostic['error_code'], 'http_status': result.status,
                        'diagnostic': diagnostic})
        fail('PREPARATION_FAILED:' + operation + ':' + diagnostic['error_code'])

    def resolve_grocery(self, branch_id, vertical):
        if not _positive(branch_id):
            fail('BRANCH_ID_INVALID')
        return grocery_store(self._read(f'/grocery/v2/TB_AE/branches/{branch_id}', params={
            'areaId': self.home['area_id'], 'lat': self.home['latitude'], 'lon': self.home['longitude']}), branch_id, vertical)

    def resolve_restaurant(self, branch_id):
        if not _positive(branch_id):
            fail('BRANCH_ID_INVALID')
        data = self._read(f'/menubff/v4/branches/{branch_id}/menu', params={
            'branchId': branch_id, 'countryId': 4, 'areaId': self.home['area_id'],
            'latitude': self.home['latitude'], 'longitude': self.home['longitude']})
        try:
            restaurant = data['vendor']['result']['restaurant']
            if type(restaurant['bid']) is not int or restaurant['bid'] != branch_id:
                fail('RESTAURANT_BRANCH_MISMATCH')
        except (KeyError, TypeError):
            fail('RESTAURANT_BRANCH_SCHEMA_INVALID')
        return Store('restaurants', branch_id, 0, False)

    def verify_restaurant_items(self, branch_id, items):
        """Read-only pre-mutation truth pass for a restaurant manifest.

        One menubff v4 walk proves every item id exists and flags
        customization honestly; one menubff v3 choices read per customized
        item proves each requested choice option and its section bounds.
        Populates the readback choice catalog. Returns the Store.
        """
        if not _positive(branch_id):
            fail('BRANCH_ID_INVALID')
        items = _items(Store('restaurants', branch_id, 0, False), items)
        data = self._read(f'/menubff/v4/branches/{branch_id}/menu', params={
            'branchId': branch_id, 'countryId': 4, 'areaId': self.home['area_id'],
            'latitude': self.home['latitude'], 'longitude': self.home['longitude']})
        try:
            vendor = data['vendor']['result']['restaurant']
            if type(vendor['bid']) is not int or vendor['bid'] != branch_id:
                fail('RESTAURANT_BRANCH_MISMATCH')
        except (KeyError, TypeError):
            fail('RESTAURANT_BRANCH_SCHEMA_INVALID')
        index = menu_choices.parse_menu(data)
        for item in items:
            entry = index.get(item.item_id)
            if entry is None:
                fail('MENU_ITEM_UNKNOWN')
            if item.choices and not entry.customizable:
                fail('MENU_ITEM_NOT_CUSTOMIZABLE')
        catalog = {}
        for menu_id in sorted({x.item_id for x in items if index.get(x.item_id).customizable}):
            item_choices = menu_choices.fetch_item_choices(self, branch_id, menu_id)
            for item in items:
                if item.item_id == menu_id:
                    menu_choices.validate_line_choices(item_choices, item.choices)
            catalog.update(menu_choices.choice_catalog(item_choices))
        if catalog:
            self._choice_catalog = {**(self._choice_catalog or {}), **catalog}
        # Original (undiscounted) menu prices anchor CCX SubTotal to merchant
        # truth; items without a usable original price simply disable that
        # anchor (e.g. create-your-own rows priced through choices only).
        prices = {entry.item_id: entry.original_price_minor for entry in index.entries.values()
                  if type(entry.original_price_minor) is int and entry.original_price_minor >= 0}
        if prices:
            self._item_prices = {**(self._item_prices or {}), **prices}
        return Store('restaurants', branch_id, 0, False)

    def _cart_query(self, store):
        return {'branch_id': store.branch_id, 'dh_vendor_id': store.vendor_id, 'chain_id': store.chain_id,
                'global_entity_id': 'TB_AE', 'lat': self.home['latitude'], 'lon': self.home['longitude'],
                'campaign_progress_required': 'true', 'has_outstanding_payments': 'false'}

    def _grocery_headers(self, key):
        if type(key) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{16}', key):
            fail('PUBLIC_VERTICALS_KEY_REQUIRED')
        return {'x-api-key': key, 'x-customer-id': str(self.saved['expected_profile']['id']),
                'x-platform': 'android', 'x-tpro-deals-enabled': 'true', 'x-weightables-enabled': 'true'}

    def create_cart(self, store, items, *, verticals_key=None):
        if 'create_cart' in self.consumed:
            fail('OPERATION_ALREADY_CONSUMED_NO_RETRY')
        body = cart_body(store, self.home, items)
        headers = None
        if store.vertical != 'restaurants':
            headers = self._grocery_headers(verticals_key)
            before = self._read('/grocery/v2/cart', params=self._cart_query(store), headers=headers)
            if (type(before.get('items')) is not list or before['items']
                    or minor(before.get('subtotal_after_discount')) != 0):
                fail('EXISTING_GROCERY_CART_MUST_NOT_BE_REPLACED')
        result = self._mutate('create_cart', '/cart/v2' if store.vertical == 'restaurants' else '/grocery/v2/cart', body, headers=headers)
        try:
            if result.status not in (200, 201) or result.data is None:
                fail('CART_SUBMISSION_UNKNOWN_NO_RETRY')
            parsed = parse_cart(result.data, store, items, choice_catalog=self._choice_catalog,
                                item_prices=self._item_prices)
            restaurant_cart=None
            if store.vertical=='restaurants':
                restaurant_cart=restaurant.project_cart(result.data,cart_id=parsed.cart_id,
                    branch_id=store.branch_id,items=items,choice_catalog=self._choice_catalog)
        except Exception:
            self._unknown_preparation('create_cart', result.status)
        self._received({'operation': 'create_cart', 'state': 'SUCCEEDED', 'http_status': result.status,
                        'cart_id': parsed.cart_id, 'cart_binding': hashlib.sha256(parsed.cart_id.encode()).hexdigest()})
        self.cart = parsed
        self.restaurant_cart = restaurant_cart
        self._verticals_key = verticals_key
        return self.cart

    def read_owned_cart(self, allowed_food_totals=()):
        if self.cart is None:
            fail('OWNED_CART_REQUIRED')
        if self.cart.store.vertical == 'restaurants':
            if self.restaurant_cart is None:fail('OWNED_FOOD_CART_REQUIRED')
            return restaurant.read_owned_cart(self._read,self.restaurant_cart,
                allowed_totals=tuple(allowed_food_totals),choice_catalog=self._choice_catalog)
        data = self._read('/grocery/v2/cart', params=self._cart_query(self.cart.store),
                          headers=self._grocery_headers(self._verticals_key))
        current = parse_cart(data, self.cart.store, self.cart.items)
        if (current.cart_id != self.cart.cart_id or current.subtotal_minor != self.cart.subtotal_minor
                or current.route_amount_minor != self.cart.route_amount_minor):
            fail('OWNED_CART_CHANGED')
        return current

    def payment_config(self, amount_minor=None):
        if 'place' in self.consumed:
            fail('CHECKOUT_ALREADY_SUBMITTED')
        if self.cart is None:
            fail('OWNED_CART_REQUIRED')
        amount = self.cart.route_amount_minor if amount_minor is None else amount_minor
        # Native checkout's missing-route totalAmount fallback is "0.0". It is
        # initial configuration context only; a final selected quote must match.
        if amount is None:
            amount = 0
        if type(amount) is not int or amount < 0:
            fail('PAYMENT_CONFIG_AMOUNT_INVALID')
        self.config = self.selection = self.quote = None
        self.config_amount_minor = None
        data = self._read('/pay/v2/payments', params={'scenario': 'deliveryOrder', 'amount': major(amount),
                          'countryId': 4, 'branchId': self.cart.store.branch_id},
                          headers={'x-acceptance-request-id': self.flow_id})
        features = data.get('supportedFeatures')
        if type(features) is not dict or set(features) != {'paySupportsTPro'} or type(features['paySupportsTPro']) is not bool:
            fail('PAYMENT_CONFIG_FEATURES_UNSUPPORTED')
        self.config = _copy(data)
        self.selection = None
        self.config_amount_minor = amount
        return {'config_received': True, 'amount_context_minor': amount}

    def prepare(self, *, selected=True, quiet_from=None, phase=None):
        if 'place' in self.consumed:
            fail('CHECKOUT_ALREADY_SUBMITTED')
        if self.cart is None or self.config is None:
            fail('OWNED_CART_AND_PAYMENT_CONFIG_REQUIRED')
        if type(selected) is not bool:
            fail('QUOTE_SELECTION_INVALID')
        selection = select_payment(self.config, self.card) if selected else None
        self.selection = selection
        instructions = None
        if quiet_from is not None:
            if type(quiet_from) is not Quote or quiet_from.cart is not self.cart:
                fail('QUIET_SOURCE_QUOTE_MISMATCH')
            instructions = json.loads(quiet_from.response)['checkout']['deliveryInstructions']
        body = prepare_body(self.cart.store, self.home, selection=selection,
                            features=self.config['supportedFeatures'], instructions=instructions)
        default_phase = 'quote_' + ('selected' if selected else 'initial') + ('_quiet' if instructions else '')
        if phase is not None and (phase != 'quote_final_quiet' or not selected or instructions is None):
            fail('QUOTE_PHASE_INVALID')
        phase = phase or default_phase
        self.quote = None
        result = self._mutate(phase, '/ccx/v1/checkout/' + urllib.parse.quote(self.cart.cart_id, safe=''), body)
        try:
            if result.status != 200 or result.data is None:
                fail('QUOTE_RESPONSE_INVALID_OR_UNAVAILABLE')
            parsed = parse_quote(result.data, self.cart, self.home, body, selection)
        except Exception as exc:
            self._failed_quote(phase, result, exc)
        self._received({'operation': phase, 'state': 'SUCCEEDED', 'http_status': result.status,
                        'cart_binding': hashlib.sha256(self.cart.cart_id.encode()).hexdigest(),
                        'currency': parsed.currency, 'payable_minor': parsed.amount_minor,
                        'review_sha256': project_quote(parsed)['quote_digest']})
        self.quote = parsed
        return self.quote

    def submit_place(self, *, approved_amount_minor, approved_quote_digest):
        if 'place' in self.consumed:
            fail('OPERATION_ALREADY_CONSUMED_NO_RETRY')
        quote = self.quote
        if (type(quote) is not Quote or type(approved_amount_minor) is not int
                or approved_amount_minor != quote.amount_minor or self.config_amount_minor != quote.amount_minor
                or self.selection != quote.selection or time.monotonic() - quote.observed_at >= MAX_AGE):
            fail('FRESH_EXACT_AMOUNT_CARD_QUOTE_REQUIRED')
        if (type(approved_quote_digest) is not str
                or approved_quote_digest != project_quote(quote)['quote_digest']):
            fail('EXACT_QUOTE_APPROVAL_REQUIRED')
        # Restaurants: the CCX line-id mapping (quote row id == str(food cart
        # line id), i.e. cart_id+1) was verified live 2026-10-11 against a
        # real CalculEat quote; parse_quote re-verifies the correspondence on
        # every quote, so no blanket refusal is needed here anymore.
        body = place_body(quote)
        self.read_owned_cart(allowed_food_totals=(quote.amount_minor,))
        result = self._mutate('place', '/ccx/v1/checkout/' + urllib.parse.quote(quote.cart.cart_id, safe='') + '/placeOrder', body)
        self.placed = place_contract.parse_response(result.status, result.data)
        self._place_quote = quote
        # Preserve known IDs even on malformed balance/challenge responses.
        receipt_observation = place_contract.PlaceObservation(self.placed.state, self.placed.reason,
            self.placed.order_id, self.placed.transaction_id, self.placed.balance_amount)
        self._received({'operation': 'place', 'observation': receipt_observation, 'http_status': result.status})
        return self.placed

    def submit_payment(self):
        if 'payment' in self.consumed:
            fail('OPERATION_ALREADY_CONSUMED_NO_RETRY')
        if self.placed is None or self._place_quote is None:
            fail('RECEIVED_PLACE_IDENTITIES_REQUIRED')
        body = payment_body(self.placed, self._place_quote)
        result = self._mutate('payment', '/pay/v1/payments', body,
                              headers={'x-acceptance-request-id': self.flow_id})
        platform_type = json.loads(self._place_quote.selection.event)['platformType']
        self.payment_result = parse_payment(result.status, result.data, self.placed, platform_type=platform_type)
        context = None
        if platform_type == 'async' and self.payment_result.state in ('PAYMENT_PENDING', 'PAYMENT_UNKNOWN'):
            context = async_context(self.placed, self._place_quote.selection, self.flow_id, self.payment_result,
                account_binding=hashlib.sha256(str(self.saved['expected_profile']['id']).encode()).hexdigest())
        self._received({'operation': 'payment', 'result': self.payment_result,
                        'context': context, 'next_index': 0, 'http_status': result.status})
        if context is not None:
            self.payment_poller = AsyncPaymentPoller(self.saved, context, receipt=self.receipt)
        return self.payment_result

    def poll_payment(self, *, max_reads=90):
        if self._receipt_failed:
            fail('RECEIPT_PERSIST_FAILED_NO_MUTATION_RETRY')
        if self.payment_poller is None:
            fail('ASYNC_PAYMENT_READBACK_NOT_AVAILABLE')
        self.payment_result = self.payment_poller.poll(max_reads=max_reads)
        return self.payment_result

    def track(self, *, timeout=10):
        if self.placed is None or not place_contract._order_id(self.placed.order_id):
            fail('EXACT_RETURNED_ORDER_ID_REQUIRED')
        # Existing exact-ID native projector, with no renewal in this flow.
        deadline = auth.new_deadline(timeout)
        if auth.expiry(self.saved['auth']) <= time.time() + 1:
            fail('AUTH_EXPIRED_RENEWAL_REQUIRED')
        order_id = self.placed.order_id
        data = orders.request(orders.TRACKING + order_id, self.saved, deadline)
        return orders.project(data, order_id)


def project_quote(quote):
    """Safe display for the parent's exact amount approval; private IDs omitted."""
    if type(quote) is not Quote:
        fail('QUOTE_REQUIRED')
    review = {'app': 'talabat', 'vertical': quote.cart.store.vertical, 'branch_id': quote.cart.store.branch_id,
            'currency': quote.currency, 'payable_minor': quote.amount_minor,
            'item_rows': len(quote.cart.items), 'quantity': sum(x.quantity for x in quote.cart.items),
            'home': 'Banyantree 2104', 'card_last4': '5542' if quote.selection else None,
            'quiet_selected': json.loads(quote.body).get('deliveryInstructions') == list(quote.instruction_ids),
            'tip': False, 'subscription': False, 'wallet': False, 'save_preferences': False,
            'payment_platform_type': None if quote.selection is None else json.loads(quote.selection.event)['platformType'],
            'quote_digest': hashlib.sha256(quote.body + b'\0' + quote.response + b'\0' +
                (b'' if quote.selection is None else quote.selection.event)).hexdigest()}
    if any(x.note for x in quote.cart.items):
        review['item_notes'] = [{'item_id':x.item_id, 'quantity':x.quantity, 'note':x.note}
                                for x in quote.cart.items if x.note]
    if any(x.choices for x in quote.cart.items):
        review['item_choices'] = [{'item_id':x.item_id, 'quantity':x.quantity, 'note':x.note,
                                   'choices':[{'choice_id':c[0], 'quantity':c[1],
                                               'sub_choice_ids':list(c[2])} for c in x.choices],
                                   'choices_label':quote.cart.line_choice_labels[index]}
                                  for index,x in enumerate(quote.cart.items) if x.choices]
    return review
