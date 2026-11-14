"""Match delivery totals against the bank parser owned by money-cases."""
import datetime as dt
from decimal import Decimal, InvalidOperation
import importlib.util
import os
from pathlib import Path
import re
import sys
import time


FIELDS = ('bank_amount', 'bank_card_last4', 'bank_msg_id', 'bank_charged_at')


def load_charges():
    path = Path(os.environ.get('ORDER_WATCH_CHARGES',
                '~/.local/share/robob-watch/watchers/money-cases/charges.py')).expanduser()
    # charges imports its sibling order_lookup; keep that import path local to loading.
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location('_order_watch_bank_charges', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None
    finally:
        sys.path.pop(0)


def money(amount):
    return f'AED {amount:,.2f}'


def find(cfg, total, claimed_ids, charges, deadline):
    store = cfg.get('app')
    if store not in {'noon', 'careem', 'amazon', 'talabat'} or total <= 0:
        return None, None
    try:
        placed = dt.datetime.fromisoformat(cfg['placed_at'].replace('Z', '+00:00'))
        if placed.tzinfo is None:
            return None, None
    except (KeyError, ValueError, TypeError, AttributeError):
        return None, None
    start, end = placed - dt.timedelta(minutes=10), placed + dt.timedelta(hours=24)
    claimed = {str(value) for value in claimed_ids}
    merchant_token = re.compile(rf'(?<![a-z0-9]){re.escape(store)}(?![a-z0-9])', re.I)
    try:
        if time.time() >= deadline:
            raise charges.Lookup('bank lookup out of time')
        # msgs date filters cover whole days; verify the exact window on each row.
        rows = charges.search(store, since=charges.day(start), until=charges.day(end + dt.timedelta(days=1)),
                              n=20, deadline=deadline)
        matches, seen, reads = [], set(), 0
        for row in rows[:20]:
            if time.time() >= deadline:
                raise charges.Lookup('bank lookup out of time')
            sender, msg_id = str(row.get('sender') or ''), str(row.get('id') or '')
            if not msg_id or msg_id in claimed or msg_id in seen or row.get('from_me') \
                    or not charges.BANKS.search(sender):
                continue
            seen.add(msg_id)
            ts = row.get('ts')
            if not isinstance(ts, (int, float)) or not start.timestamp() <= ts <= end.timestamp():
                continue
            if reads >= 6:
                break
            reads += 1
            body = charges.show(row, deadline=deadline)
            if row.get('source') not in {'email', 'mail'}:
                body = charges.alert_text(body)
            charge = charges.parse(body, sender)
            if not charge or charge.get('kind') != 'charge' or charge.get('currency') != 'AED' \
                    or not merchant_token.search(str(charge.get('merchant') or '')):
                continue
            try:
                amount = Decimal(charge['amount'])
            except (KeyError, InvalidOperation, TypeError, ValueError):
                continue
            if not amount.is_finite() or amount <= 0 or abs(amount - total) > total * Decimal('0.02'):
                continue
            fields = dict(zip(FIELDS, (money(amount), charge['card'], msg_id,
                          charges.iso(dt.datetime.fromtimestamp(ts, dt.timezone.utc)))))
            matches.append(((abs(amount - total), abs(ts - placed.timestamp())), fields))
        if time.time() >= deadline:
            raise charges.Lookup('bank lookup out of time')
        matches.sort(key=lambda match: match[0])
        if not matches or (len(matches) > 1 and matches[0][0] == matches[1][0]):
            return None, None
        return matches[0][1], None
    except charges.Lookup as exc:
        return None, str(exc)[:200]
