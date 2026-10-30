#!/usr/bin/env python3
"""Shared saved-card status: remember a declined card across agents.

Every money path (commerce orders, Uber, app checkouts) runs
`card-status check <last4>` first. A decline that happened in the last 12 hours
refuses the card until Abdullah says it is fine again (`card-status ok`).
Only the last four digits of a card are ever stored.

State: ${CARD_STATUS_FILE:-~/.local/state/card-status.json}, one record per
last4: {state: declined|ok, reason, source, at (epoch), note[, recorded_at, events]}.
For a decline, `at` is when it happened and `recorded_at` when it was written.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
import re
import sys
import tempfile
import time
from pathlib import Path

BLOCK_SECONDS = 12 * 3600
EXIT_BLOCKED = 3
EXIT_USAGE = 2
DUBAI = dt.timezone(dt.timedelta(hours=4))
TEXT_LIMIT = 200
EVENT_LIMIT = 50
STATES = ('declined', 'ok', 'cancelled')
# Anything shaped like a full card number: 13-19 digits, optionally split by
# single spaces or dashes. Flow UUIDs and short order ids never match.
_FULL_NUMBER = re.compile(r'(?<![\w-])[0-9](?:[ -]?[0-9]){12,18}(?![\w-])')


class CardStatusError(ValueError):
    pass


def state_path():
    override = os.environ.get('CARD_STATUS_FILE')
    return Path(override).expanduser() if override else Path.home() / '.local/state/card-status.json'


def _last4(value):
    if type(value) is not str or re.fullmatch(r'[0-9]{4}', value) is None:
        raise CardStatusError('card must be exactly the last 4 digits (never the full number)')
    return value


def _text(value, field, *, required=False):
    text = ' '.join(str(value).split()) if value is not None else ''
    if not text:
        if required:
            raise CardStatusError(f'{field} is required')
        return None
    if len(text) > TEXT_LIMIT:
        raise CardStatusError(f'{field} is longer than {TEXT_LIMIT} characters')
    if any(ord(ch) < 32 for ch in text):
        raise CardStatusError(f'{field} contains control characters')
    if _FULL_NUMBER.search(text):
        raise CardStatusError(f'{field} looks like it holds a full card number; store only the last 4 digits')
    return text


def _valid_record(record):
    return (type(record) is dict and record.get('state') in STATES
            and type(record.get('at')) in (int, float)
            and (record.get('recorded_at') is None or type(record['recorded_at']) in (int, float))
            and all(record.get(k) is None or type(record[k]) is str for k in ('reason', 'source', 'note'))
            and (record.get('events') is None or (type(record['events']) is list
                                                  and all(type(e) is str for e in record['events']))))


def _load(path):
    try:
        raw = path.read_text()
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError) as exc:
        raise CardStatusError(f'card status file {path} is unreadable ({type(exc).__name__})')
    try:
        data = json.loads(raw)
    except ValueError:
        raise CardStatusError(f'card status file {path} is not valid JSON')
    if type(data) is not dict or not all(re.fullmatch(r'[0-9]{4}', k) and _valid_record(v)
                                         for k, v in data.items()):
        raise CardStatusError(f'card status file {path} has an unexpected shape')
    return data


@contextlib.contextmanager
def _locked(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path.with_name(path.name + '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _save(path, data):
    fd, tmp = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(data, out, indent=2, sort_keys=True)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _dubai(at, *, with_date=False):
    stamp = dt.datetime.fromtimestamp(at, DUBAI)
    return stamp.strftime('%Y-%m-%d %H:%M' if with_date else '%H:%M')


def _public(last4, record):
    if not record:
        return {'card_last4': last4, 'state': None, 'reason': None, 'source': None,
                'at': None, 'at_dubai': None, 'recorded_at': None, 'note': None}
    return {'card_last4': last4, 'state': record['state'], 'reason': record.get('reason'),
            'source': record.get('source'), 'at': record['at'],
            'at_dubai': dt.datetime.fromtimestamp(record['at'], DUBAI).isoformat(),
            'recorded_at': record.get('recorded_at'), 'note': record.get('note')}


def _recorded_later(record):
    recorded = record.get('recorded_at')
    if recorded is None or recorded - record['at'] < 60:
        return ''
    return f", recorded {_dubai(recorded, with_date=True)}"


def declined_message(last4, record):
    return (f"card {last4} declined at {_dubai(record['at'])} Dubai{_recorded_later(record)} "
            f"({record.get('reason') or 'no reason given'}, {record.get('source') or 'manual'}). "
            f"Ask Abdullah before trying it again; clear with: card-status ok {last4}")


def cancelled_message(last4, record):
    return (f"Card {last4} was cancelled ({record.get('reason') or 'no reason given'}). "
            f"Ask Abdullah for the new card; clear only with: card-status replace {last4}")


def check(last4, *, now=None):
    """Status for one card. Blocked when cancelled (no time limit), or when the last record is a decline under 12h old.

    An unreadable state file blocks too: a broken record must not read as ok.
    """
    last4 = _last4(last4)
    now = time.time() if now is None else now
    path = state_path()
    try:
        data = _load(path)
    except CardStatusError as exc:
        return {**_public(last4, None), 'blocked': True, 'error': 'CARD_STATUS_UNREADABLE',
                'message': (f'{exc}. Refusing card {last4} until the file is fixed or moved aside; '
                            f'ask Abdullah before using the card.')}
    record = data.get(last4)
    result = {**_public(last4, record), 'blocked': False, 'error': None}
    if record is None:
        result['message'] = f'card {last4}: no decline on record'
    elif record['state'] == 'cancelled':
        result.update(blocked=True, error='CARD_CANCELLED', message=cancelled_message(last4, record))
    elif record['state'] == 'declined' and now - record['at'] < BLOCK_SECONDS:
        result.update(blocked=True, error='CARD_RECENTLY_DECLINED', message=declined_message(last4, record))
    elif record['state'] == 'declined':
        result['message'] = (f"card {last4} last declined at {_dubai(record['at'], with_date=True)} Dubai, "
                             f'more than 12h ago{_recorded_later(record)}')
    else:
        note = f" ({record['note']})" if record.get('note') else ''
        result['message'] = f"card {last4} ok since {_dubai(record['at'], with_date=True)} Dubai{note}"
    return result


def _occurred(occurred_at, recorded):
    """When the decline happened, never later than now. Unusable input means now."""
    if type(occurred_at) not in (int, float) or not math.isfinite(occurred_at) or occurred_at <= 0:
        return recorded
    return min(math.ceil(occurred_at), recorded)


def record_declined(last4, *, reason, source=None, event=None, not_before=None, occurred_at=None, now=None):
    """Record a decline. The same event (order/flow id) is recorded only once.

    `not_before` is when the failed attempt started; a card record written
    after it wins, so a late re-read of an old failure never re-blocks a card
    that was cleared since.

    `occurred_at` is when the decline really happened, for a late re-read of an
    old flow. The record's `at` (and so the 12h block) starts then, clamped to
    now; a decline older than the current record does not replace it. Without
    it the decline is taken to have happened now.
    """
    last4 = _last4(last4)
    reason = _text(reason, 'reason', required=True)
    source = _text(source, 'source') or 'manual'
    event = _text(event, 'event')
    recorded = int(time.time() if now is None else now)
    stamp = recorded if occurred_at is None else _occurred(occurred_at, recorded)
    path = state_path()
    with _locked(path):
        try:
            data = _load(path)
        except CardStatusError:
            # A decline must still be recorded; keep the broken file for review.
            with contextlib.suppress(OSError):
                os.replace(path, path.with_name(f'{path.name}.corrupt-{int(time.time())}'))
            data = {}
        previous = data.get(last4) or {}
        events = list(previous.get('events') or [])
        if event is not None and event in events:
            return {**_public(last4, previous), 'recorded': False, 'duplicate_event': event}
        if event is not None:
            events = (events + [event])[-EVENT_LIMIT:]
        if previous.get('state') == 'cancelled':
            # A cancelled card stays cancelled; a late decline only adds its event.
            record = {**previous, 'events': events} if events else previous
            data[last4] = record
            _save(path, data)
            return {**_public(last4, record), 'recorded': False, 'cancelled': True}
        if previous and ((not_before is not None and previous['at'] > not_before)
                         or (occurred_at is not None and previous['at'] > stamp)):
            return {**_public(last4, previous), 'recorded': False, 'superseded': True}
        record = {'state': 'declined', 'reason': reason, 'source': source, 'at': stamp,
                  'recorded_at': recorded, 'note': None}
        if events:
            record['events'] = events
        data[last4] = record
        _save(path, data)
    return {**_public(last4, record), 'recorded': True}


def _write_state(last4, *, state, reason, source, note, now):
    last4 = _last4(last4)
    path = state_path()
    with _locked(path):
        data = _load(path)
        previous = data.get(last4) or {}
        record = {'state': state, 'reason': reason, 'source': source,
                  'at': int(time.time() if now is None else now), 'note': note}
        if previous.get('events'):
            record['events'] = previous['events']
        data[last4] = record
        _save(path, data)
    return {**_public(last4, record), 'recorded': True}


def record_cancelled(last4, *, reason, source=None, now=None):
    """Permanent block: the card stays refused until `record_replaced`."""
    return _write_state(last4, state='cancelled', reason=_text(reason, 'reason', required=True),
                        source=_text(source, 'source'), note=None, now=now)


def record_replaced(last4, *, note=None, source=None, now=None):
    note = _text(note, 'note')
    return _write_state(last4, state='ok', reason=None, source=_text(source, 'source'),
                        note=f'replaced: {note}' if note else 'replaced', now=now)


def record_ok(last4, *, note=None, source=None, now=None):
    last4 = _last4(last4)
    note = _text(note, 'note')
    source = _text(source, 'source')
    path = state_path()
    with _locked(path):
        data = _load(path)
        if (data.get(last4) or {}).get('state') == 'cancelled':
            raise CardStatusError(f'card {last4} is cancelled; use card-status replace {last4}')
        previous = data.get(last4) or {}
        record = {'state': 'ok', 'reason': None, 'source': source,
                  'at': int(time.time() if now is None else now), 'note': note}
        if previous.get('events'):
            record['events'] = previous['events']
        data[last4] = record
        _save(path, data)
    return {**_public(last4, record), 'recorded': True}


def list_cards(*, now=None):
    data = _load(state_path())
    return [check(last4, now=now) for last4 in sorted(data)]


def main(argv=None):
    parser = argparse.ArgumentParser(prog='card-status', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    declined = commands.add_parser('declined', help='record a declined card (last 4 digits only)')
    declined.add_argument('last4')
    declined.add_argument('--reason', required=True)
    declined.add_argument('--source', help='who saw it, e.g. "uber" or "commerce talabat <order>"')
    declined.add_argument('--event', help='failed order/ride/flow id; the same event is recorded once')
    ok = commands.add_parser('ok', help='mark a card usable again (only when Abdullah says so)')
    ok.add_argument('last4')
    ok.add_argument('--note')
    ok.add_argument('--source')
    cancel = commands.add_parser('cancel', help='permanently refuse a cancelled card until it is replaced')
    cancel.add_argument('last4')
    cancel.add_argument('--reason', required=True)
    cancel.add_argument('--source')
    replace = commands.add_parser('replace', help='clear a cancelled card after its replacement (owner says so)')
    replace.add_argument('last4')
    replace.add_argument('--note')
    replace.add_argument('--source')
    check_cmd = commands.add_parser('check', help='exit 3 when the card is cancelled or was declined in the last 12h')
    check_cmd.add_argument('last4')
    check_cmd.add_argument('--json', action='store_true')
    list_cmd = commands.add_parser('list')
    list_cmd.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'check':
            result = check(args.last4)
            print(json.dumps(result) if args.json else result['message'])
            return EXIT_BLOCKED if result['blocked'] else 0
        if args.command == 'list':
            rows = list_cards()
            if args.json:
                print(json.dumps(rows))
            else:
                for row in rows:
                    print(row['message'])
                if not rows:
                    print('no cards on record')
            return 0
        if args.command == 'declined':
            result = record_declined(args.last4, reason=args.reason, source=args.source, event=args.event)
        elif args.command == 'cancel':
            result = record_cancelled(args.last4, reason=args.reason, source=args.source)
        elif args.command == 'replace':
            result = record_replaced(args.last4, note=args.note, source=args.source)
        else:
            result = record_ok(args.last4, note=args.note, source=args.source)
        print(json.dumps(result))
        return 0
    except CardStatusError as exc:
        print(f'card-status: {exc}', file=sys.stderr)
        return EXIT_USAGE


if __name__ == '__main__':
    sys.exit(main())
