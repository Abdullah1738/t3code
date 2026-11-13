#!/usr/bin/env python3
"""Append-only owner approval and open money-question ledger.

Quotes and source references are caller attestations, not authentication. No
command infers approval from an answer or from an agent's summary of a decision.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import uuid

UTC = dt.timezone.utc
MAX_AGE = dt.timedelta(hours=24)


class ApprovalError(ValueError):
    pass


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ApprovalError('nonempty text required')
    return value.strip()


def key(value):
    # Preserve punctuation and internal spacing: distinct SKUs must stay distinct.
    return text(value).casefold()


def timestamp(value):
    parsed = dt.datetime.fromisoformat(text(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ApprovalError('timestamp needs a timezone')
    return parsed.astimezone(UTC)


def terms(vendor, item, amount, currency=None, recurring=None):
    if type(amount) is not int or amount < 0:
        raise ApprovalError('amount must be a nonnegative integer in minor units')
    if currency is not None:
        currency = text(currency).upper()
        if not re.fullmatch(r'[A-Z]{3}', currency):
            raise ApprovalError('currency must be a three-letter code')
    if recurring not in (None, 'monthly', 'yearly', 'weekly', 'daily', 'hourly'):
        raise ApprovalError('invalid billing cadence')
    return dict(vendor=key(vendor), item=text(item), amount=amount,
                currency=currency, recurring=recurring)


class Ledger:
    def __init__(self, root=None):
        self.root = Path(root or Path.home() / '.local/state/owner-go')

    @contextmanager
    def events(self, write=False, missing_ok=True):
        if not self.root.exists() and not write:
            if not missing_ok:
                raise ApprovalError('ledger does not exist')
            yield []
            return
        if write:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.root / 'events.jsonl'
        if not path.exists() and not write:
            if not missing_ok:
                raise ApprovalError('ledger does not exist')
            yield []
            return
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND if write else os.O_RDONLY, 0o600)
        with os.fdopen(fd, 'a+' if write else 'r') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX if write else fcntl.LOCK_SH)
            stream.seek(0)
            try:
                rows = [json.loads(line) for line in stream if line.strip()]
                self.validate(rows)
            except (ValueError, TypeError, KeyError) as exc:
                raise ApprovalError('ledger unreadable; refusing approval') from exc
            yield (rows, stream) if write else rows

    @staticmethod
    def validate(rows):
        ids = set()
        for row in rows:
            if row['id'] in ids or row['kind'] not in ('record', 'ask', 'answer', 'revoke'):
                raise ApprovalError('invalid event')
            ids.add(row['id'])
            timestamp(row['logged_at'])
            timestamp(row['at'])
            if row['kind'] in ('record', 'ask'):
                terms(row['vendor'], row['item'], row['amount'], row['currency'], row['recurring'])
                text(row['currency'])
            if row['kind'] == 'record':
                text(row['quote']); text(row['source'])
                expires = timestamp(row['expires_at'])
                if not timestamp(row['at']) < expires <= timestamp(row['at']) + MAX_AGE:
                    raise ApprovalError('invalid approval lifetime')
            if row['kind'] == 'ask':
                text(row['thread'])
            if row['kind'] in ('answer', 'revoke'):
                text(row['target']); text(row['quote']); text(row['source'])

    @staticmethod
    def append(stream, kind, now, **data):
        row = dict(id=str(uuid.uuid4()), kind=kind, logged_at=now.isoformat(), **data)
        stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
        return row

    def record(self, *, vendor, item, amount, currency, quote, source, at,
               recurring=None, hours=24, now=None):
        now = now or dt.datetime.now(UTC)
        when = timestamp(at)
        if when > now or not 0 < hours <= 24:
            raise ApprovalError('future approval or lifetime outside 0..24 hours')
        data = terms(vendor, item, amount, currency, recurring)
        with self.events(True) as (_, stream):
            return self.append(stream, 'record', now, **data, quote=text(quote), source=text(source),
                               at=when.isoformat(), expires_at=(when + dt.timedelta(hours=hours)).isoformat())

    def verify(self, *, vendor, item, amount, currency=None, recurring=None, now=None):
        now = now or dt.datetime.now(UTC)
        wanted = terms(vendor, item, amount, currency, recurring)
        with self.events() as rows:
            revoked = {r['target'] for r in rows if r['kind'] == 'revoke'}
            candidates = [r for r in rows if r['kind'] == 'record' and r['id'] not in revoked
                          and r['vendor'] == wanted['vendor'] and r['item'] == wanted['item']]
            if not candidates:
                raise ApprovalError('no approval for this vendor and item')
            candidates = [r for r in candidates if timestamp(r['at']) <= now < timestamp(r['expires_at'])]
            if not candidates:
                raise ApprovalError('approval expired or not yet valid')
            candidates = [r for r in candidates if r['recurring'] == recurring]
            if not candidates:
                raise ApprovalError('billing cadence differs from approval')
            if currency is None and len({r['currency'] for r in candidates}) != 1:
                raise ApprovalError('currency ambiguous; supply --currency')
            candidates = [r for r in candidates if currency is None or r['currency'] == wanted['currency']]
            if not candidates:
                raise ApprovalError('currency differs from approval')
            candidates = [r for r in candidates if amount <= r['amount']]
            if not candidates:
                raise ApprovalError('amount exceeds approval')
            return candidates[-1]

    def ask(self, *, vendor, item, amount, thread, currency='AED', recurring=None, now=None):
        now = now or dt.datetime.now(UTC)
        data = terms(vendor, item, amount, currency, recurring)
        with self.events(True) as (rows, stream):
            closed = {r['target'] for r in rows if r['kind'] == 'answer'}
            for row in rows:
                if row['kind'] == 'ask' and row['id'] not in closed and all(row[k] == v for k, v in data.items()):
                    return row
            return self.append(stream, 'ask', now, **data, thread=text(thread), at=now.isoformat())

    def close(self, kind, target, *, quote, source, at, now=None):
        now = now or dt.datetime.now(UTC)
        when = timestamp(at)
        if when > now:
            raise ApprovalError('future answer or revocation')
        expected = 'ask' if kind == 'answer' else 'record'
        with self.events(True) as (rows, stream):
            original = next((r for r in rows if r['id'] == target and r['kind'] == expected), None)
            if original is None or when < timestamp(original['at']):
                raise ApprovalError('unknown target or answer predates it')
            if any(r['kind'] == kind and r['target'] == target for r in rows):
                raise ApprovalError('already closed')
            return self.append(stream, kind, now, target=target, quote=text(quote),
                               source=text(source), at=when.isoformat())

    def list(self, open_only=False):
        with self.events(missing_ok=False) as rows:
            closed = {r['target'] for r in rows if r['kind'] == 'answer'}
            return [r for r in rows if not open_only or r['kind'] == 'ask' and r['id'] not in closed]


def require(**kwargs):
    try:
        return Ledger().verify(**kwargs)
    except (ApprovalError, OSError, ValueError) as exc:
        raise ApprovalError(f'OWNER_GO_REQUIRED: {exc}') from exc


def commerce_item(binding):
    # scope_hash is built from the validated basket, merchant, home and card by
    # each lane. Display the same key during preparation; never accept a label
    # from the paying caller as a substitute for that binding.
    return f"commerce:{binding['app']}:{binding['vertical']}:{binding['scope_hash']}"


def main(argv=None):
    parser = argparse.ArgumentParser(prog='owner-go')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('record', 'verify', 'ask'):
        command = commands.add_parser(name)
        for arg in ('vendor', 'item', 'amount'):
            command.add_argument('--' + arg, required=True, type=int if arg == 'amount' else str)
        command.add_argument('--currency', required=name == 'record', default='AED' if name == 'ask' else None)
        command.add_argument('--recurring', choices=('monthly', 'yearly', 'weekly', 'daily', 'hourly'))
        if name == 'record':
            command.add_argument('--hours', type=float, default=24)
        if name == 'ask':
            command.add_argument('--thread', required=True)
    for name in ('answer', 'revoke'):
        command = commands.add_parser(name)
        command.add_argument('target')
    for name in ('record', 'answer', 'revoke'):
        command = commands.choices[name]
        for arg in ('quote', 'source', 'at'):
            command.add_argument('--' + arg, required=True)
    listing = commands.add_parser('list')
    listing.add_argument('--open', dest='open_only', action='store_true')
    listing.add_argument('--json', action='store_true')
    args = vars(parser.parse_args(argv))
    name = args.pop('command')
    try:
        ledger = Ledger()
        if name == 'list':
            args.pop('json')
            result = ledger.list(**args)
        elif name in ('answer', 'revoke'):
            result = ledger.close(name, **args)
        else:
            result = getattr(ledger, name)(**args)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({'ok': False, 'error': 'OWNER_GO_REQUIRED' if name == 'verify' else 'OWNER_GO_INVALID',
                          'reason': str(exc)}))
        return 4 if name == 'verify' else 2


if __name__ == '__main__':
    sys.exit(main())
