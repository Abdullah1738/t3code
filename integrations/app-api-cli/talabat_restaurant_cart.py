"""Exact existing restaurant-cart read contract; no built-in HTTP transport.

Native 13.95.0: 0x21bd7d4 builds /cart/v1/{cartId}; 0x21bd950
adds hasOutstandingPayments to the GET query, and 0x21bd9cc selects GET
(cid-0xff8 -> 0x26979e4/0x2697cc4/0x2697e70 -> 0xc7e34c).
0xf1dcbc sends the response to the same 0x21b4b50 parser as cart/v2.

Food-cart line IDs and CCX IDs are separate server fields. This module never
turns a stringified food-cart ID into an asserted CCX correspondence.

Customization (observed 2026-10-11 capture, ZeroFat 717327): the cart echo
carries choices as a plain int id list plus choicesDetails rows
(id/quantity/itemChoiceSectionId/localeNames). Manifest lines are identified
per line — the same menu item with distinct notes or choices is two lines —
and identical lines are merged by quantity because the server aggregates
them and cannot echo duplicates.
"""
from dataclasses import dataclass
from decimal import Decimal
import re

from talabat_http_orders import TalabatError


CCX_MAPPING_BLOCKER = 'RESTAURANT_CCX_ITEM_ID_MAPPING_UNVERIFIED'
# No local item-note length cap: checkout.cart.specialRequests.specialRequest
# .characterLimit is the ORDER-LEVEL field and is not evidence of an item
# specialRequest bound. Exact echo validation governs; merchant/server errors
# are surfaced, never pre-truncated locally.


def _fail(code):
    raise TalabatError(code)


def _positive(value):
    return type(value) is int and 0 < value < 2**63


def validate_item_note(value):
    """Preserve exact Unicode text; reject controls. No arbitrary length cap.

    The observed checkout.specialRequests.characterLimit belongs to the
    order-level field, so no item-note maximum is asserted locally. Server or
    merchant refusals surface verbatim; nothing is silently trimmed.
    """
    if (type(value) is not str
            or any(not c.isprintable() and c != '\n' for c in value)):
        _fail('ITEM_NOTE_INVALID')
    return value


def note_matches(observed, expected):
    # Native empty notes may be omitted/null. A requested note must echo exactly.
    return observed in (None, '') if expected == '' else type(observed) is str and observed == expected


def _notes(notes, manifest):
    if type(notes) is not tuple:
        _fail('FOOD_ITEM_NOTES_INVALID')
    result = {}
    for pair in notes:
        if (type(pair) is not tuple or len(pair) != 2 or not _positive(pair[0])
                or pair[0] not in manifest or pair[0] in result):
            _fail('FOOD_ITEM_NOTES_INVALID')
        result[pair[0]] = validate_item_note(pair[1])
    return result


def _cart_id(value):
    # The parent stores the native positive int as a decimal route string.
    if type(value) is str and re.fullmatch(r'[1-9][0-9]{0,18}', value):
        value = int(value)
    if not _positive(value):
        _fail('FOOD_CART_ID_INVALID')
    return value


def existing_cart_request(cart_id):
    """Known basic/non-group GET, without telemetry, experimental routing or body.

    Optional native payment-summary counters/flow are omitted on their null
    branches. The parent supplies account headers and enforces cart ownership.
    """
    return {'method': 'GET', 'path': f'/cart/v1/{_cart_id(cart_id)}',
             'params': {'hasOutstandingPayments': 'false'}, 'body': None}


def contract():
    """Public executable capability description; never chooses a live cart."""
    return {'method':'GET','path':'/cart/v1/{exact_owned_cart_id}',
        'query':{'hasOutstandingPayments':'false'},'body':None,
        'identity_fields':['cart.id','branchInfo.restaurant.branchId','cart.items[].menuItemId',
                            'cart.items[].id','cart.items[].quantity','cart.items[].specialRequest',
                            'cart.items[].choices','cart.items[].choicesDetails'],
        'customization':'exact per-item notes and catalog-backed choices supported',
        'ccx_correspondence_verified':True,'blocker':None,
        'verified':'2026-10-11 live capture: choices echo is int id list + choicesDetails '
                   '(id/quantity/itemChoiceSectionId/localeNames); CCX row id == cart_id+1',
        'mutation':False,'adopt_existing_cart':False}


def _line_of(item):
    """Item-like object or legacy (menu_item_id, quantity) pair -> line tuple."""
    if type(item) is tuple and len(item) == 2:
        return (item[0], item[1], None, ())
    if type(item) is tuple and len(item) == 4:
        return item
    choices = tuple((c[0], c[1], tuple(c[2])) for c in getattr(item, 'choices', ()) or ())
    return (item.item_id, item.quantity, getattr(item, 'note', '') or '', choices)


def _manifest(items, item_notes=()):
    """Normalize to per-line (menu_item_id, quantity, note, choices) rows.

    One line per distinct (id, note, choices); identical rows merge by summed
    quantity. Legacy item_notes pairs supply notes for plain (id, quantity)
    manifests and must agree with notes carried by Item-like rows.
    """
    if type(items) is not tuple or not items:
        _fail('FOOD_ITEM_MANIFEST_INVALID')
    raw = [_line_of(item) for item in items]
    notes = _notes(item_notes, {r[0] for r in raw}) if item_notes else {}
    lines = {}
    order = []
    for item_id, quantity, note, choices in raw:
        if not _positive(item_id) or type(quantity) is not int or quantity < 1:
            _fail('FOOD_ITEM_MANIFEST_INVALID')
        if note is None:
            if item_id not in notes:
                note = ''
            else:
                note = notes[item_id]
        elif item_id in notes and notes[item_id] != note:
            _fail('FOOD_ITEM_NOTES_INVALID')
        validate_item_note(note)
        for choice in choices:
            if (type(choice) is not tuple or len(choice) != 3 or not _positive(choice[0])
                    or type(choice[1]) is not int or choice[1] < 1 or type(choice[2]) is not tuple
                    or any(not _positive(s) for s in choice[2])):
                _fail('FOOD_ITEM_CHOICES_INVALID')
        if len({c[0] for c in choices}) != len(choices):
            _fail('FOOD_CHOICE_DUPLICATED_IN_LINE')
        key = (item_id, note, tuple(sorted((c[0], c[1]) for c in choices)))
        if key in lines:
            previous = lines[key]
            lines[key] = (item_id, previous[1] + quantity, note, choices)
        else:
            lines[key] = (item_id, quantity, note, choices)
            order.append(key)
    return [lines[key] for key in order]


def choices_echo(row):
    """Structurally validate one cart echo row's choices fields.

    Returns (choice_id list, {id: details row}, choicesString). The echo must
    carry the plain int id list and matching details rows; ids without a
    detail row (or the reverse) are corrupt, not a different item.
    """
    ids = row.get('choices')
    details = row.get('choicesDetails')
    if ids is None:
        ids = []
    if details is None:
        details = []
    if type(ids) is not list or any(not _positive(x) for x in ids):
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    if len(set(ids)) != len(ids) or type(details) is not list:
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    per = {}
    for detail in details:
        if (type(detail) is not dict or not _positive(detail.get('id'))
                or type(detail.get('quantity')) is not int or detail['quantity'] < 1
                or detail['id'] in per):
            _fail('FOOD_CART_ECHO_CHOICES_INVALID')
        per[detail['id']] = detail
    if set(per) != set(ids):
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    label = row.get('choicesString')
    if type(label) is not str and label is not None:
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    if ids and label in (None, ''):
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    if not ids and label not in (None, ''):
        _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    return ids, per, label


def choices_echo_matches(row, expected_choices, catalog=None):
    """Exact comparison of one echo row against one line's expected choices.

    Identity mismatches (different id set or quantities) return False so the
    caller can try another requested line; structurally corrupt echoes and
    catalog contradictions (wrong section or en name) fail hard.
    """
    ids, per, _label = choices_echo(row)
    expected = {c[0]: c[1] for c in expected_choices}
    if expected != {cid: detail['quantity'] for cid, detail in per.items()}:
        return False
    if catalog is not None:
        for cid, detail in per.items():
            info = catalog.get(cid)
            if info is None or detail.get('itemChoiceSectionId') != info['section_id']:
                _fail('FOOD_CART_ECHO_CHOICES_INVALID')
            names = detail.get('localeNames')
            en = None
            if type(names) is list:
                for name in names:
                    if type(name) is dict and name.get('locale') == 'en':
                        en = name.get('value')
            if en != info['name']:
                _fail('FOOD_CART_ECHO_CHOICES_INVALID')
    return True


def _amount(value):
    if value is None:
        return None
    if (type(value) not in (int, float, str)
            or not re.fullmatch(r'[0-9]{1,6}(?:\.[0-9]{1,2})?', str(value))):
        _fail('FOOD_CART_TOTAL_INVALID')
    return int(Decimal(str(value)) * 100)


@dataclass(frozen=True, repr=False)
class RestaurantCart:
    cart_id: str
    branch_id: int
    # menuItemId, native cart-line id, quantity. No CCX identity implied.
    lines: tuple
    total_minor: int | None
    # Nonempty (menuItemId, exact note) pairs, sorted (display identity).
    item_notes: tuple = ()
    # Sorted (line_id, ((choice_id, quantity, sub_choice_ids), ...)) rows.
    line_choices: tuple = ()
    # Sorted (line_id, exact note) rows; only nonempty notes. Per-line binding
    # disambiguates duplicate menu ids whose notes differ.
    line_notes: tuple = ()


def project_cart(data, *, cart_id, branch_id, items, item_notes=(), choice_catalog=None):
    """Validate one owned response against an exact catalog manifest.

    items is a tuple of Item-like rows (item_id/quantity/note/choices) or
    legacy (menu_item_id, quantity) pairs. Lines are matched per identity —
    the same menu item with distinct notes or choices is two lines. Branch
    identity is the native response branchInfo.restaurant.branchId.
    """
    manifest = _manifest(items, item_notes)
    identity = _cart_id(cart_id)
    if not _positive(branch_id):
        _fail('FOOD_BRANCH_ID_INVALID')
    cart = data.get('cart') if type(data) is dict else None
    info = data.get('branchInfo') if type(data) is dict else None
    restaurant = info.get('restaurant') if type(info) is dict else None
    if (type(restaurant) is not dict
            or type(restaurant.get('branchId')) is not int
            or restaurant['branchId'] != branch_id):
        _fail('FOOD_CART_BRANCH_MISMATCH')
    if (type(cart) is not dict or type(cart.get('id')) is not int
            or cart['id'] != identity or type(cart.get('items')) is not list):
        _fail('FOOD_CART_IDENTITY_OR_SCHEMA_INVALID')
    for flag in ('isGroupOrder', 'isGroupOrderLocked', 'isOrderPlaced'):
        if flag in cart and cart[flag] is not False:
            _fail('FOOD_CART_GROUP_OR_PLACED_UNSUPPORTED')
    rows = cart['items']
    if len(rows) != len(manifest):
        _fail('FOOD_CART_ITEMS_CHANGED')
    remaining = list(manifest)
    matched = {}
    seen_lines = set()
    for row in rows:
        if type(row) is not dict:
            _fail('FOOD_CART_ITEMS_CHANGED')
        menu_id, line_id, quantity = row.get('menuItemId'), row.get('id'), row.get('quantity')
        if (not _positive(menu_id) or not _positive(line_id) or line_id in seen_lines
                or type(quantity) is not int):
            _fail('FOOD_CART_ITEMS_CHANGED')
        if row.get('isFromUpsell') is True:
            _fail('FOOD_CUSTOMISATION_UNSUPPORTED')
        hit = None
        reasons = set()
        for index, (want_id, want_qty, want_note, want_choices) in enumerate(remaining):
            if want_id != menu_id or quantity != want_qty:
                continue
            if not note_matches(row.get('specialRequest'), want_note):
                reasons.add('note')
                continue
            if choices_echo_matches(row, want_choices, choice_catalog):
                hit = index
                break
            reasons.add('choices')
        if hit is None:
            if reasons == {'note'}:
                _fail('FOOD_ITEM_NOTE_MISMATCH')
            if reasons == {'choices'}:
                _fail('FOOD_CHOICE_ECHO_MISMATCH')
            _fail('FOOD_CART_ITEMS_CHANGED')
        matched[line_id] = remaining.pop(hit) + (line_id,)
        seen_lines.add(line_id)
    lines = tuple(sorted((menu_id, line_id, quantity)
                         for line_id, (menu_id, quantity, _note, _choices, line_id2) in matched.items()))
    line_choices = tuple(sorted((line_id, choices)
                                for line_id, (_m, _q, _note, choices, line_id2) in matched.items() if choices))
    line_notes = tuple(sorted((line_id, note)
                              for line_id, (_m, _q, note, _c, line_id2) in matched.items() if note))
    notes = tuple(sorted({(menu_id, note) for menu_id, _q, note, _c, _l in matched.values() if note}))
    return RestaurantCart(str(identity), branch_id, lines,
                          _amount(cart.get('totalValue')),
                          notes, line_choices, line_notes)


def read_owned_cart(get_json, owned, allowed_totals=(), choice_catalog=None):
    """One injected GET for an already-projected owned cart, with exact readback.

    get_json(path, *, params) is the parent's existing authenticated GET-only
    caller. It owns HTTP status/auth/deadline checks. No retry or discovery.
    """
    if type(owned) is not RestaurantCart or not callable(get_json):
        _fail('OWNED_FOOD_CART_REQUIRED')
    # Revalidate even directly constructed dataclasses before delivering a call.
    try:
        note_by_line = dict(owned.line_notes or ())
        choice_by_line = dict(owned.line_choices or ())
        manifest = tuple((menu_id, quantity, note_by_line.get(line_id, ''),
                          choice_by_line.get(line_id, ()))
                         for menu_id, line_id, quantity in sorted(owned.lines))
        expected_notes = tuple(sorted({(menu_id, note) for menu_id, _q, note, _c in manifest if note}))
        if owned.item_notes != expected_notes:
            _fail('OWNED_FOOD_CART_REQUIRED')
        seed = {'branchInfo': {'restaurant': {'branchId': owned.branch_id}},
                'cart': {'id': _cart_id(owned.cart_id), 'items': [
                    _seed_row(menu_id, line_id, quantity, note, choices, choice_catalog)
                    for (menu_id, quantity, note, choices), (menu_id, line_id, quantity) in zip(
                        manifest, sorted(owned.lines))]}}
        checked = project_cart(seed, cart_id=owned.cart_id, branch_id=owned.branch_id,
                               items=manifest, choice_catalog=choice_catalog)
    except (TypeError, ValueError):
        _fail('OWNED_FOOD_CART_REQUIRED')
    if (type(owned.lines) is not tuple or checked.lines != owned.lines
            or checked.item_notes != owned.item_notes
            or checked.line_choices != owned.line_choices or checked.line_notes != owned.line_notes
            or (owned.total_minor is not None and
                (type(owned.total_minor) is not int or not 0 <= owned.total_minor <= 99_999_999))):
        _fail('OWNED_FOOD_CART_REQUIRED')
    request = existing_cart_request(owned.cart_id)
    data = get_json(request['path'], params=request['params'])
    current = project_cart(data, cart_id=owned.cart_id, branch_id=owned.branch_id,
                           items=manifest, choice_catalog=choice_catalog)
    # The server rewrites the food cart's totalValue to the full payable once
    # a CCX quote exists (item value minus booster plus delivery/service).
    # Cart identity is the id + line set; the total may move to a quoted amount.
    allowed = {owned.total_minor, *allowed_totals}
    if (current.cart_id != owned.cart_id or current.lines != owned.lines
            or current.item_notes != owned.item_notes or current.line_choices != owned.line_choices
            or current.line_notes != owned.line_notes
            or current.total_minor not in allowed):
        _fail('OWNED_FOOD_CART_CHANGED')
    return current


def _seed_row(menu_id, line_id, quantity, note, choices, catalog):
    details = []
    for choice_id, choice_quantity, _subs in choices:
        info = (catalog or {}).get(choice_id)
        details.append({'id': choice_id, 'quantity': choice_quantity,
                        'itemChoiceSectionId': info['section_id'] if info else 0,
                        'localeNames': [{'locale': 'en', 'value': info['name']}] if info else []})
    row = {'menuItemId': menu_id, 'id': line_id, 'quantity': quantity,
           'specialRequest': note, 'choices': [c[0] for c in choices],
           'choicesDetails': details}
    if details:
        # The synthetic label only needs to be nonempty when choices exist;
        # it is never compared against live text without a catalog.
        names = [d['localeNames'][0]['value'] for d in details if d['localeNames']]
        row['choicesString'] = ', '.join(names if names else [str(c) for c in row['choices']])
    return row
