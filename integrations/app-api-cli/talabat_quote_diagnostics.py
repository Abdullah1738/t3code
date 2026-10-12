"""Bounded, allowlisted quote diagnostics; never persist raw account payloads."""
import hashlib
import json
import math
import re

MAX_ROWS = 100
MAX_BYTES = 24000


def _hash(value):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def _money(value):
    if value is None or type(value) is bool:
        return value
    if type(value) in (int, float) and abs(value) <= 100000000 and math.isfinite(value):
        return value
    if type(value) is str and re.fullmatch(r'(?:AED\s*)?-?[0-9]{1,9}(?:\.[0-9]{1,8})?', value):
        return value
    return '<redacted-invalid-money>'


def _enum(value):
    return value if type(value) is str and re.fullmatch(r'[A-Za-z][A-Za-z_]{0,63}', value) else '<invalid-type>'


def _quantity(value):
    return value if type(value) is int and 0 <= value < 10**12 else None


def _rows(value, project):
    return [project(x) if type(x) is dict else None for x in value[:MAX_ROWS]] if type(value) is list else None


def build(data, error_code, exception_type):
    """Retain raw monetary/charge fields only. IDs and free text become hashes.

    Everything else (address, phone, tokens, URLs, payment config, arbitrary
    exception messages) is omitted by construction, not a secret-key denylist.
    The original body digest allows correlation without retaining credentials.
    """
    checkout = data.get('checkout') if type(data) is dict else None
    checkout = checkout if type(checkout) is dict else {}
    cart = checkout.get('cart')
    summary = checkout.get('paymentSummary')
    items = cart.get('items') if type(cart) is dict else None
    charges = summary.get('items') if type(summary) is dict else None
    result = {
        'error_code': error_code, 'exception_type': exception_type,
        'response_sha256': _hash(data),
        'quote': {
            'amount': _money(checkout.get('amount')),
            'discountsTotal': _money(checkout.get('discountsTotal')),
            'items': _rows(items, lambda row: {
                'identity_sha256': _hash([row.get('id'), row.get('itemGuid')]),
                'quantity': _quantity(row.get('quantity')),
                'price': _money(row.get('price')), 'total': _money(row.get('total')),
                'choices_sha256': _hash(row.get('choicesString')),
                'note_sha256': _hash(row.get('specialRequest'))}),
            'charges': _rows(charges, lambda row: {
                'type': _enum(row.get('type')), 'amount': _money(row.get('amount')),
                'value': _money(row.get('value'))}),
            'item_count': len(items) if type(items) is list else None,
            'charge_count': len(charges) if type(charges) is list else None,
        },
    }
    # Large baskets retain amounts/charge types and the full-body digest; never
    # let diagnostics break receipt persistence or loosen the purchase parser.
    if len(json.dumps(result).encode()) > MAX_BYTES:
        result['quote']['items'] = None
    return result


def valid(value):
    """Revalidate at the durable receipt boundary, including on restart."""
    try:
        if type(value) is not dict or set(value) != {'error_code', 'exception_type', 'response_sha256', 'quote'}:
            return False
        if (type(value['error_code']) is not str or not re.fullmatch(r'[A-Z][A-Z0-9_]{1,99}', value['error_code'])
                or value['exception_type'] not in {'TalabatError', 'KeyError', 'ValueError', 'TypeError',
                    'IndexError', 'AttributeError', 'OverflowError', 'RuntimeError', 'Exception'}):
            return False
        is_hash = lambda x: type(x) is str and re.fullmatch(r'[0-9a-f]{64}', x) is not None
        q = value['quote']
        if not is_hash(value['response_sha256']) or type(q) is not dict or set(q) != {
                'amount', 'discountsTotal', 'items', 'charges', 'item_count', 'charge_count'}:
            return False
        for key in ('amount', 'discountsTotal'):
            if q[key] != _money(q[key]):
                return False
        for key in ('item_count', 'charge_count'):
            if q[key] is not None and (type(q[key]) is not int or not 0 <= q[key] <= 2000000):
                return False
        for key, fields in (('items', {'identity_sha256', 'quantity', 'price', 'total', 'choices_sha256', 'note_sha256'}),
                            ('charges', {'type', 'amount', 'value'})):
            rows = q[key]
            if rows is None:
                continue
            if type(rows) is not list or len(rows) > MAX_ROWS:
                return False
            for row in rows:
                if row is None:
                    continue
                if type(row) is not dict or set(row) != fields:
                    return False
                if key == 'items':
                    if (not all(is_hash(row[k]) for k in ('identity_sha256', 'choices_sha256', 'note_sha256'))
                            or row['quantity'] != _quantity(row['quantity'])):
                        return False
                    money = ('price', 'total')
                else:
                    if row['type'] != _enum(row['type']):
                        return False
                    money = ('amount', 'value')
                if any(row[k] != _money(row[k]) for k in money):
                    return False
        return len(json.dumps(value, allow_nan=False).encode()) <= MAX_BYTES
    except (KeyError, TypeError, ValueError, OverflowError):
        return False
