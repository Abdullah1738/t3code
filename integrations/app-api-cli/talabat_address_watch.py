"""robob-watch check: new Talabat orders must go home, otherwise wake the owner."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time

CLI = Path.home() / '.local/bin/talabat-search'
STATE = 'talabat-address-state.json'
MAX_DETAILS = 3


class ReadError(Exception):
    pass


def read_cli(*args, timeout=14):
    try:
        result = subprocess.run([str(CLI), *args, '--json', '--timeout', str(timeout)],
                                text=True, capture_output=True, timeout=timeout + 3)
        data = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise ReadError('ORDER_READ_UNAVAILABLE') from None
    if not isinstance(data, dict) or result.returncode or data.get('ok') is not True:
        error = data.get('error') if isinstance(data, dict) else None
        raise ReadError(error if isinstance(error, str) and re.fullmatch(r'[A-Z_0-9]{1,90}', error)
                        else 'ORDER_READ_UNAVAILABLE')
    if data.get('account_verified') is not True:
        raise ReadError('ORDER_ACCOUNT_UNVERIFIED')
    return data


def address_event(result, branch=None):
    address = result.get('delivery_address') or {}
    label = (address.get('label') + ': ') if address.get('label') else ''
    merchant = f' ({branch})' if branch else ''
    return (f"Talabat order {result['order']}{merchant} is going to {label}{address.get('text')}, not home. "
            f"Status: {result.get('status', 'unknown')}. Expected Banyantree Residences Hillside, flat 2104.")


def failed(record, error, now):
    record.setdefault('failed_since', now)
    record['failures'] = record.get('failures', 0) + 1
    record['last_error'] = error
    persistent = record['failures'] >= 3 and now - record['failed_since'] >= 300
    record['retry_at'] = now + (300 if persistent else 60)
    if persistent and not record.get('failure_alerted'):
        record['failure_alerted'] = True
        return True
    return False


def recovered(record):
    for key in ('failed_since', 'failures', 'last_error', 'retry_at', 'failure_alerted'):
        record.pop(key, None)


def tick(state, now, read=read_cli):
    """No old-order alerts on bootstrap; unread new orders survive failed reads."""
    events = []
    health = state.setdefault('health', {})
    rows = None
    if now >= health.get('retry_at', 0):
        try:
            listing = read('orders', '--pages', '5', '--limit', '375')
            rows = listing.get('orders')
            if (not isinstance(rows, list) or any(not isinstance(row, dict)
                    or not re.fullmatch(r'[0-9]{1,20}', str(row.get('order', ''))) for row in rows)):
                raise ReadError('ORDER_LIST_SCHEMA_CHANGED')
            recovered(health)
            health['last_success_at'] = now
        except ReadError as exc:
            if failed(health, str(exc), now):
                events.append(f'Talabat address monitor cannot read orders for at least five minutes ({exc}). '
                              'Delivery addresses are unchecked until access recovers. Repair the read-only account session; do not request OTP automatically.')
    if rows is not None:
        if 'orders' not in state:
            state['orders'] = {row['order']: {'result': 'baseline', 'first_seen_at': now}
                               for row in rows if row.get('status') in ('delivered', 'cancelled')
                               or row.get('raw_status') == 'Cancelled'}
            state['baseline_at'] = now
            # Existing active orders are checked on the next real tick, not swallowed by prime.
            for row in rows:
                state['orders'].setdefault(row['order'], {'first_seen_at': now, 'branch': row.get('branch_name')})
            return events
        for row in rows:
            state['orders'].setdefault(row['order'], {'first_seen_at': now, 'branch': row.get('branch_name')})
    if health.get('failures'):
        # One account outage alert, not a duplicate error for every pending order.
        return events
    count = 0
    for order, record in state.get('orders', {}).items():
        if record.get('result') or now < record.get('retry_at', 0):
            continue
        if count >= MAX_DETAILS:
            break
        count += 1
        try:
            detail = read('order', order, timeout=8)
            if detail.get('order') != order:
                raise ReadError('ORDER_ID_MISMATCH')
            if type(detail.get('is_home')) is not bool or not detail.get('delivery_address'):
                raise ReadError('ORDER_ADDRESS_UNVERIFIED')
            recovered(record)
            record.update(result='home' if detail['is_home'] else 'not_home', checked_at=now,
                          delivery_address=detail['delivery_address'], status=detail.get('status'))
            if not detail['is_home']:
                events.append(address_event(detail, record.get('branch')))
        except ReadError as exc:
            if failed(record, str(exc), now):
                events.append(f'Talabat order {order}: delivery address still cannot be verified after five minutes ({exc}). '
                              'Check this exact order; do not assume it went home.')
    return events


def save(path, state):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as f:
        os.chmod(temporary, 0o600)
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(path)


def run(directory, run_id, read=read_cli, now=None):
    path = directory / STATE
    state = json.loads(path.read_text()) if path.exists() else {}
    outbox = state.get('outbox')
    ack = (directory / '.run-ok').read_text().strip() if (directory / '.run-ok').exists() else None
    if outbox and outbox['run'] != ack:
        # The prior check was killed before robob-watch durably queued its event.
        outbox['run'] = run_id
        save(path, state)
        return outbox['event']
    state.pop('outbox', None)
    event = '\n'.join(tick(state, time.time() if now is None else now, read))
    if event:
        state['outbox'] = {'run': run_id, 'event': event}
    save(path, state)
    return event


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', metavar='ORDER_ID', help='read one order; no state changes or notification')
    args = parser.parse_args(argv)
    if args.dry_run:
        result = read_cli('order', args.dry_run, timeout=20)
        print(json.dumps({'dry_run': True, 'order': result['order'], 'status': result.get('status'),
                          'delivery_address': result.get('delivery_address'), 'is_home': result.get('is_home'),
                          'would_alert': result.get('is_home') is False,
                          'event': address_event(result) if result.get('is_home') is False else None}, indent=2))
        return 0
    if not os.environ.get('WATCH_DIR'):
        parser.error('run via robob-watch, or use --dry-run ORDER_ID')
    directory = Path(os.environ['WATCH_DIR'])
    with (directory / 'address-check.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        # robob-watch test uses a scratch state directory without WATCH_RUN.
        event = run(directory, os.environ.get('WATCH_RUN', f'test-{time.time_ns()}'))
        if event:
            print(event, flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never emit arbitrary subprocess exceptions or raw account payloads.
        import sys
        print('TALABAT_ADDRESS_CHECK_FAILED', file=sys.stderr)
        raise SystemExit(1)
