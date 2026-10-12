"""CLI basket input, without product, quantity or spending policy limits.

Merchant adapters validate their own identifiers and customization contracts.
This layer only rejects malformed or ambiguous input before account access.
"""
import json
import sys
from pathlib import Path


class BasketInputError(ValueError):
    pass


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BasketInputError('BASKET_JSON_DUPLICATE_KEY')
        result[key] = value
    return result


def _constant(value):
    raise BasketInputError('BASKET_JSON_NONFINITE_NUMBER')


def read_items(path):
    """Read an array, or {"items": [...]}; never silently ignore extra keys."""
    try:
        text = sys.stdin.read() if path == '-' else Path(path).expanduser().read_text(encoding='utf-8')
        data = json.loads(text, object_pairs_hook=_object, parse_constant=_constant)
    except BasketInputError:
        raise
    except (OSError, UnicodeError, ValueError, TypeError):
        raise BasketInputError('BASKET_JSON_UNREADABLE_OR_INVALID') from None
    if isinstance(data, dict):
        if set(data) != {'items'}:
            raise BasketInputError('BASKET_JSON_OBJECT_REQUIRES_ONLY_ITEMS')
        data = data['items']
    if not isinstance(data, list) or not data or any(not isinstance(row, dict) for row in data):
        raise BasketInputError('BASKET_ITEMS_REQUIRED')
    return data


def input_items(args, *, id_argument, id_key, quantity_key='quantity', note_key=None):
    """Normalize legacy one-line flags or a manifest, refusing mixed sources."""
    path = getattr(args, 'items_file', None)
    identifier = getattr(args, id_argument, None)
    quantity = getattr(args, 'quantity', None)
    note = getattr(args, 'item_note', '')
    if path is not None:
        if identifier is not None or quantity is not None or note:
            raise BasketInputError('BASKET_FILE_AND_SINGLE_ITEM_FLAGS_CONFLICT')
        return read_items(path)
    if identifier is None:
        raise BasketInputError('BASKET_ITEMS_REQUIRED')
    quantity = 1 if quantity is None else quantity
    if type(quantity) is not int or quantity <= 0:
        raise BasketInputError('BASKET_QUANTITY_INVALID')
    row = {id_key: identifier, quantity_key: quantity}
    if note_key is not None:
        row[note_key] = note
    return [row]
