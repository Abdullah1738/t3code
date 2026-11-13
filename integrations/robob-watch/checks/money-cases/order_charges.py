"""Follow registered orders whose bank charge has not been observed, separately from unknown charges."""
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
import time


def registrations(root):
    rows = []
    for path in (root / 'orders').glob('*.json'):
        try:
            cfg = json.loads(path.read_text())
            amount = Decimal(str(cfg.get('amount')))
            placed = dt.datetime.fromisoformat(cfg['placed_at'].replace('Z', '+00:00'))
            if (cfg.get('order') and cfg.get('watcher') and placed.tzinfo and amount.is_finite() and amount > 0
                    and re.fullmatch(r'\d{4}', str(cfg.get('card_last4', '')))):
                rows.append(cfg)
        except (OSError, ValueError, KeyError, TypeError, InvalidOperation):
            continue
    return rows


def matching_charge(cfg, now, source, read, deadline, charges, peers=()):
    placed = dt.datetime.fromisoformat(cfg['placed_at'].replace('Z', '+00:00'))
    query = ' OR '.join('"' + value + '"' for value in charges.amounts(cfg))
    rows = source(query, since=charges.day(placed - dt.timedelta(minutes=5)),
                  until=charges.day(now + dt.timedelta(days=1)), n=60, deadline=deadline)
    expected = charges.words(cfg.get('merchant') or cfg['app'])
    for row in rows[:60]:
        if row.get('from_me') or row.get('source') not in ('email', 'mail', 'imessage', 'sms'):
            continue
        sender = str(row.get('sender') or '')
        if not charges.BANKS.search(sender):
            continue
        try:
            observed = dt.datetime.fromtimestamp(row['ts'], now.tzinfo) if isinstance(row.get('ts'), (float, int)) else dt.datetime.fromisoformat(str(row.get('at') or row.get('date')).replace('Z', '+00:00'))
        except (TypeError, ValueError):
            continue
        if not observed.tzinfo or not placed - dt.timedelta(minutes=5) <= observed <= min(now, placed + dt.timedelta(hours=36)):
            continue
        text = row.get('body') or row.get('text') or charges.alert_text(read(row, deadline=deadline))
        charge = charges.parse(text, sender)
        if (charge and charge['kind'] == 'charge' and charge['card'] == cfg['card_last4']
                and charge['currency'] == cfg.get('currency', 'AED')
                and Decimal(charge['amount']) == Decimal(cfg['amount'])
                and expected and set(expected) & set(charges.words(charge['merchant']))):
            competing = [other for other in peers if other['watcher'] != cfg['watcher']
                         and (not other.get('bank_confirmed_at') or
                              abs(dt.datetime.fromisoformat(other['bank_confirmed_at']) - observed) <= dt.timedelta(minutes=5))
                         and other.get('card_last4') == cfg['card_last4']
                         and Decimal(other['amount']) == Decimal(cfg['amount'])
                         and other.get('currency', 'AED') == cfg.get('currency', 'AED')
                         and set(charges.words(other.get('merchant') or other['app'])) & set(charges.words(charge['merchant']))
                         and dt.datetime.fromisoformat(other['placed_at'].replace('Z', '+00:00')) - dt.timedelta(minutes=5)
                         <= observed <= dt.datetime.fromisoformat(other['placed_at'].replace('Z', '+00:00')) + dt.timedelta(hours=36)]
            if competing:
                continue
            return {'source': ('mail:' if row['source'] in ('mail', 'email') else 'sms:') + str(row['id']),
                    'at': observed.isoformat()}
    return None
