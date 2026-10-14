"""Items manifest parsing for the commerce CLI's Talabat lanes.

Canonical JSON (a bare list of rows or {"items": [...]}), one flow Item per
row, rows preserved one-to-one — the same menu item with distinct notes or
choices stays a distinct line and nothing is collapsed:

    [{"item_id": 157740044, "quantity": 1, "note": "No onions please",
      "choices": [{"choice_id": 549025015, "quantity": 1}]},
     {"item_id": 157740044, "quantity": 2, "note": "", "choices": []}]

item_id is a positive int (number or numeric string) for restaurants and a
UUID string for mart/shops. Notes are exact Unicode with no local length
cap (control characters are rejected; the server governs real limits).
Choices are restaurant-only and must reference option ids the live menu
exposes. sub_choice_ids selects immediate children of that option, each once.
No invented count/quantity/spending ceilings: provider schema and
exact readback validation govern.
"""
import re

import talabat_http_checkout as h
from talabat_http_orders import TalabatError
from talabat_restaurant_cart import validate_item_note


ITEM_KEYS = frozenset({'item_id', 'itemId', 'id', 'quantity', 'qty', 'note',
                       'special_request', 'specialRequest', 'item_note', 'choices'})
CHOICE_KEYS = frozenset({'choice_id', 'choiceId', 'id', 'quantity', 'qty',
                         'sub_choice_ids', 'subChoiceIds'})
UUID_RE = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')


def _fail(code):
    raise TalabatError(code)


def _pick(row, *keys):
    present = [key for key in keys if key in row]
    if len(present) > 1:
        _fail('BASKET_ALIAS_AMBIGUOUS')
    return row[present[0]] if present else None


def _parse_choices(raw, *, vertical):
    if raw is None:
        return ()
    if type(raw) is not list:
        _fail('FOOD_ITEM_CHOICES_INVALID')
    if raw and vertical != 'restaurants':
        _fail('CHOICES_GROCERY_UNSUPPORTED')
    choices = []
    for row in raw:
        if type(row) is not dict or set(row) - CHOICE_KEYS:
            _fail('FOOD_ITEM_CHOICES_INVALID')
        choice_id = _pick(row, 'choice_id', 'choiceId', 'id')
        if type(choice_id) is str and re.fullmatch(r'[1-9][0-9]{0,18}', choice_id):
            choice_id = int(choice_id)
        if type(choice_id) is not int or isinstance(choice_id, bool) or not 0 < choice_id < 2**63:
            _fail('FOOD_ITEM_CHOICES_INVALID')
        quantity = _pick(row, 'quantity', 'qty')
        if quantity is None and not any(k in row for k in ('quantity', 'qty')):
            quantity = 1
        if type(quantity) is not int or isinstance(quantity, bool) or quantity < 1:
            _fail('FOOD_ITEM_CHOICES_INVALID')
        subs = _pick(row, 'sub_choice_ids', 'subChoiceIds')
        if not any(k in row for k in ('sub_choice_ids', 'subChoiceIds')):
            subs = []
        if type(subs) is not list:
            _fail('FOOD_ITEM_CHOICES_INVALID')
        if any(type(s) is not int or not 0 < s < 2**63 for s in subs):
            _fail('FOOD_ITEM_CHOICES_INVALID')
        if len(set(subs)) != len(subs):
            _fail('FOOD_SUBCHOICE_DUPLICATED_IN_LINE')
        choices.append((choice_id, quantity, tuple(sorted(subs))))
    if len({cid for cid, _quantity, _subs in choices}) != len(choices):
        _fail('FOOD_CHOICE_DUPLICATED_IN_LINE')
    return tuple(choices)


def _parse_item_id(raw, *, vertical):
    if vertical == 'restaurants':
        if type(raw) is str and re.fullmatch(r'[1-9][0-9]{0,18}', raw):
            raw = int(raw)
        if type(raw) is not int or isinstance(raw, bool) or not 0 < raw < 2**63:
            _fail('BASKET_ITEM_ID_INVALID')
        return raw
    if type(raw) is not str or not UUID_RE.fullmatch(raw.strip().lower()):
        _fail('BASKET_ITEM_ID_INVALID')
    return raw.strip().lower()


def parse_items(data, *, vertical):
    """Raw decoded JSON (list of rows or {"items": [...]}) -> tuple[Item].

    One output Item per input row, in order. Raises TalabatError with stable
    BASKET_*/FOOD_* codes on shape violations.
    """
    if vertical not in ('restaurants', 'mart', 'shops'):
        _fail('INVALID_COMMERCE_VERTICAL')
    rows = data.get('items') if type(data) is dict else data
    if type(data) is dict and (set(data) - {'items'} or type(rows) not in (list, tuple)):
        _fail('BASKET_SHAPE_INVALID')
    if type(rows) not in (list, tuple) or not rows:
        _fail('BASKET_EMPTY')
    items = []
    for row in rows:
        if type(row) is not dict or set(row) - ITEM_KEYS:
            _fail('BASKET_ROW_INVALID')
        item_id = _parse_item_id(_pick(row, 'item_id', 'itemId', 'id'), vertical=vertical)
        quantity = _pick(row, 'quantity', 'qty')
        if quantity is None and not any(k in row for k in ('quantity', 'qty')):
            quantity = 1
        if type(quantity) is not int or isinstance(quantity, bool) or quantity < 1:
            # Absent quantity defaults to 1; explicit null is a shape error.
            _fail('BASKET_QUANTITY_INVALID')
        note = _pick(row, 'note', 'special_request', 'specialRequest', 'item_note')
        if note is None and not any(k in row for k in ('note', 'special_request',
                                                       'specialRequest', 'item_note')):
            note = ''
        if type(note) is not str:
            # Absent note defaults to ''; an explicit null is a shape error.
            _fail('ITEM_NOTE_INVALID')
        validate_item_note(note)
        if note and vertical != 'restaurants':
            _fail('ITEM_NOTES_RESTAURANTS_ONLY')
        choices = _parse_choices(row.get('choices'), vertical=vertical)
        items.append(h.Item(item_id, quantity, note, choices))
    return tuple(items)
