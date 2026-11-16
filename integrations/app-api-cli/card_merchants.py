"""Merchant observations and checkout routes; card numbers never enter this store."""
import toollog
import datetime as dt
import json
import re
from pathlib import Path

import card_status as cs

ROUTES = Path(__file__).with_name('card_routes.json')
SEED = Path(__file__).with_name('merchant_seed_20261112.json')
REMINDER = ('After a payment-method change, pay or retry open invoices only within the existing payment '
            'authorization, and set a check for 24 h later; otherwise ask Abdullah before paying.')


def routes():
    try:
        data = json.loads(ROUTES.read_text())
        if (not isinstance(data, dict) or not isinstance(data['forbidden'], list)
                or not isinstance(data['other_owners'], dict) or not isinstance(data['merchants'], dict)):
            raise ValueError()
        cs._last4(data['default'])
        for last4 in [*data['forbidden'], *data['other_owners']]:
            cs._last4(last4)
        if not all(isinstance(owner, str) and owner.strip() for owner in data['other_owners'].values()):
            raise ValueError()
        for key, row in data['merchants'].items():
            if (not key.strip() or not isinstance(row, dict)
                    or ('any' in row and type(row['any']) is not bool)):
                raise ValueError()
            if not row.get('any', False):
                cs._last4(row['expected'])
            for field in ('expected', 'fallback'):
                if field in row:
                    cs._last4(row[field])
                    if row[field] in data['forbidden']:
                        raise ValueError()
            if not isinstance(row['aliases'], list) or not all(isinstance(a, str) for a in row['aliases']):
                raise ValueError()
        return data
    except (OSError, ValueError, KeyError, TypeError):
        raise cs.CardStatusError(f'checkout routes are unreadable or invalid: {ROUTES}')


def merchant_key(merchant, config=None):
    key = cs._text(merchant, 'merchant', required=True).casefold()
    config = routes() if config is None else config
    label = re.sub(r'[\W_]+', ' ', key).strip()
    for name, row in config['merchants'].items():
        if label in {re.sub(r'[\W_]+', ' ', a).strip() for a in [name, *row['aliases']]}:
            return name
    return key


def merchant_path():
    path = cs.state_path()
    return path.with_name(path.stem + '.merchants.json')


def date(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        raise cs.CardStatusError('date must be YYYY-MM-DD')
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise cs.CardStatusError('date must be a valid YYYY-MM-DD')
    return value


def load():
    try:
        book = json.loads(merchant_path().read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise cs.CardStatusError('merchant card file is unreadable or invalid')
    try:
        for key, row in book.items():
            if merchant_key(key) != key or merchant_key(row['merchant']) != key:
                raise ValueError()
            date(row['next_charge'])
            primaries, last4s = 0, set()
            for card in row['cards']:
                cs._last4(card['last4'])
                if card['role'] not in ('primary', 'backup') or card['last4'] in last4s:
                    raise ValueError()
                last4s.add(card['last4'])
                primaries += card['role'] == 'primary'
                cs._text(card['source'], 'source', required=True)
                date(card['seen'])
            if primaries > 1:
                raise ValueError()
            cs._text(row['source'], 'source', required=True)
            date(row['seen'])
        return book
    except (AttributeError, ValueError, TypeError, KeyError):
        raise cs.CardStatusError('merchant card file has an unexpected shape')


def _set(book, merchant, last4, role, source, seen, next_charge):
    key = merchant_key(merchant)
    merchant = cs._text(merchant, 'merchant', required=True)
    if last4 != 'none':
        cs._last4(last4)
    if role not in ('primary', 'backup'):
        raise cs.CardStatusError('role must be primary or backup')
    source = cs._text(source, 'source') or 'manual'
    seen = date(seen) or dt.date.today().isoformat()
    next_charge = date(next_charge)
    old = book.get(key, {})
    cards = old.get('cards', [])
    if last4 == 'none':
        cards = []
    else:
        # Replacing the primary means it is no longer saved unless explicitly
        # re-added as a backup. Promoting a backup must not duplicate it.
        cards = [c for c in cards if c['last4'] != last4 and not (role == 'primary' and c['role'] == 'primary')]
        cards.append({'last4': last4, 'role': role, 'source': source, 'seen': seen})
    row = {'merchant': old.get('merchant', merchant), 'cards': cards, 'source': source, 'seen': seen,
           'next_charge': next_charge if next_charge is not None else old.get('next_charge')}
    book[key] = row
    return {'key': key, **row}


def set_card(merchant, last4, *, role='primary', source=None, seen=None, next_charge=None):
    with cs._locked(cs.state_path()):
        book = load()
        row = _set(book, merchant, last4, role, source, seen, next_charge)
        cs._save(merchant_path(), book)
    return row


def remove_card(merchant, last4):
    cs._last4(last4)
    with cs._locked(cs.state_path()):
        book = load()
        key = merchant_key(merchant)
        if key not in book:
            raise cs.CardStatusError('merchant is not on record')
        book[key]['cards'] = [c for c in book[key]['cards'] if c['last4'] != last4]
        cs._save(merchant_path(), book)
    return {'key': key, **book[key]}


def seed():
    with cs._locked(cs.state_path()):
        book = load()
        existing = set(book)
        for row in json.loads(SEED.read_text()):
            if merchant_key(row['merchant']) not in existing:
                _set(book, **row, source='nightly 2026-11-12', seen='2026-11-12',
                     **({} if 'next_charge' in row else {'next_charge': None}))
        cs._save(merchant_path(), book)
    return list_merchants()


def list_merchants(*, dead=False):
    with cs._locked(cs.state_path()):
        if dead and (not merchant_path().is_file() or not cs.state_path().is_file()):
            raise cs.CardStatusError('merchant registry or card status file is missing; dead cards are unknown')
        book = load()
        statuses = cs._load(cs.state_path()) if dead else {}
        rows = []
        for key, row in sorted(book.items()):
            row = {'key': key, **row}
            if dead:
                row['dead_cards'] = [{'last4': c['last4'], 'state': statuses[c['last4']]['state']}
                                     for c in row['cards'] if statuses.get(c['last4'], {}).get('state')
                                     in ('cancelled', 'declined')]
                if not row['dead_cards']:
                    continue
            rows.append(row)
        return rows


def _assert_final(merchant, last4, *, fallback=False):
    cs._last4(last4)
    config = routes()
    key = merchant_key(merchant, config)
    if last4 in config['forbidden']:
        return False, f'card {last4} is forbidden; never use it'
    if last4 in config['other_owners']:
        return False, f"card {last4} belongs to {config['other_owners'][last4]}"
    status = cs.check(last4)
    if status['blocked']:
        return False, status['message']
    row = config['merchants'].get(key, {})
    if row.get('any', False):
        return True, f'{key}: final card {last4} matches'
    expected = row.get('expected', config['default'])
    if fallback and row.get('fallback'):
        expected = row['fallback']
    if last4 != expected:
        suffix = '; fallback requires --fallback after failure/decline and reconciliation' if row.get('fallback') == last4 else ''
        return False, f'{key}: expected card {expected}, saw {last4}{suffix}'
    return True, f'{key}: final card {last4} matches'


def assert_final(merchant, last4, *, fallback=False):
    ok = False
    try:
        ok, message = _assert_final(merchant, last4, fallback=fallback)
        return ok, message
    finally:
        try:
            toollog.emit('card_status', 'card.assert', kind='event' if ok else 'error', ok=ok,
                     props={'merchant': next((m for m in ('noon','amazon','uber','careem') if type(merchant) is str and m in merchant.lower()), 'other'), 'last4': last4, 'fallback': fallback},
                     error=None if ok else 'CARD_ASSERT_FINAL_REFUSED')
        except Exception:
            pass
