"""Read-only account history discovery for orders placed outside commerce.

The watcher wakes a registrar; it never purchases or interprets a history row as
whole-order delivery proof. Failed lanes keep their previous baseline.
"""
import toollog
import datetime as dt
import fcntl
import json
import os
import time
from pathlib import Path

import noon_http_orders as core
import noon_vertical_reads as verticals


LANE_FAILURE_LIMIT_S = 2 * 60 * 60


def log_run(root, record):
    path = root/'noon-discovery-runs.jsonl'
    with path.open('a') as log:
        log.write(json.dumps(record) + '\n')
    lines = path.read_text().splitlines(keepends=True)
    if len(lines) > 2500:
        temp = path.with_suffix('.tmp')
        temp.write_text(''.join(lines[-2000:]))
        temp.replace(path)


def unplaced(lane, row):
    raw = row.get('raw_status')
    if lane == 'food':
        return raw == 'failed'
    if lane == 'nownow':
        return verticals.NOWNOW_STAGES.get(raw) == 'cancelled'
    # Marketplace cancellation is shipment/item-scoped, not a non-placed order.
    return False


def scan_lane(state, lane, rows, now, registered, *, can_fire=True):
    ids = sorted({row['order'] for row in rows})
    ignored = set(ids) - {row['order'] for row in rows if not unplaced(lane, row)}
    old = state.setdefault(lane, {'seen': ids, 'pending': {}})
    pending = old['pending']
    gave_up = old.setdefault('gave_up', [])
    for order in set(ids) - set(old['seen']) - ignored - set(gave_up):
        pending.setdefault(order, {'last_fire': 0, 'fires': 0})
    old['seen'] = sorted(set(old['seen']) | set(ids))
    events = []
    for order, attempt in list(pending.items()):
        if order in ignored or order in gave_up or registered(order):
            del pending[order]
            continue
        if not can_fire:
            continue
        if isinstance(attempt, (int, float)):
            # Legacy state has no fire count; retain its retry deadline.
            attempt = pending[order] = {'last_fire': attempt, 'fires': 0}
        if now - attempt['last_fire'] >= 600:
            event = {'order': order, 'service': lane}
            if attempt['fires'] >= 6:
                event['persistent'] = True
                gave_up.append(order)
                del pending[order]
            else:
                attempt.update(last_fire=now, fires=attempt['fires'] + 1)
            events.append(event)
    return events


def registered(order):
    name = 'order-noon-' + order.lower()
    try:
        cfg = json.loads((Path.home()/'.local/state/order-tracker/orders'/(name+'.json')).read_text())
        watcher = Path.home()/'.local/share/robob-watch/watchers'/name/'watcher.json'
        archive = Path.home()/'.local/share/robob-watch/archive'
        return (cfg.get('order') == order and cfg.get('watcher') == name
                and (watcher.is_file() or any(path.is_dir() for path in archive.glob(name+'-*'))))
    except (OSError, ValueError):
        return False


@toollog.entrypoint('order-watch', 'noon-discovery')
def main():
    root = Path(os.environ['WATCH_DIR'])
    root.mkdir(parents=True, exist_ok=True)
    with (root/'noon-discovery.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # Registration's prime check can overlap the runner's tick.
        started = time.monotonic()
        path = root/'noon-discovery.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        events, errors = [], {}
        lanes = state.setdefault('lanes', {})
        run_lanes = {}
        history = {}
        readers = {'minutes': lambda: core.orders('minutes', timeout=20),
                   'marketplace': lambda: core.orders('marketplace', timeout=20),
                   'food': lambda: verticals.food_orders(timeout=20),
                   'nownow': lambda: verticals.nownow_orders(timeout=20)}
        for lane, read in readers.items():
            health = lanes.setdefault(lane, {'ok_at': None, 'fail_count': 0, 'failing_since': None})
            lane_started = time.monotonic()
            try:
                result = read()
                if result.get('partial') or not result.get('ok'):
                    raise core.NoonError('PARTIAL_HISTORY_READ')
                history[lane] = result['orders']
            except core.NoonError as exc:
                errors[lane] = str(exc)
                health.update(fail_count=health['fail_count'] + 1,
                              failing_since=health['failing_since'] or dt.datetime.now(dt.timezone.utc).isoformat(),
                              last_error=str(exc), rows=0)
            else:
                health.update(ok_at=dt.datetime.now(dt.timezone.utc).isoformat(), fail_count=0,
                              failing_since=None, last_error=None, rows=len(result['orders']))
            health['last_ms'] = round((time.monotonic() - lane_started) * 1000)
            run_lanes[lane] = {'ok': lane not in errors, 'ms': health['last_ms'],
                               'rows': health['rows'], 'error': health['last_error']}
        checked_at = dt.datetime.now(dt.timezone.utc)
        state['checked_at'] = checked_at.isoformat()
        state['errors'] = errors
        failing_since = {lane: lanes[lane]['failing_since'] for lane in errors}
        failed = len(errors) == len(readers) or any(
            (checked_at - dt.datetime.fromisoformat(since)).total_seconds() >= LANE_FAILURE_LIMIT_S
            for since in failing_since.values())
        # The runner discards failed-check stdout; only deliverable events spend retries.
        for lane in readers:
            if lane in history or lane in state:
                events.extend(scan_lane(state, lane, history.get(lane, []), time.time(), registered,
                                        can_fire=not failed))
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(state, indent=2))
        temp.replace(path)
        log_run(root, {'at': state['checked_at'], 'total_ms': round((time.monotonic() - started) * 1000),
                       'lanes': run_lanes, 'events': len(events), 'exit': int(failed)})
        if events:
            print('New noon account orders (read-only discovery): ' + json.dumps(events))
        if failed:
            raise SystemExit('Noon discovery incomplete: ' + json.dumps(errors)
                             + '; failing_since: ' + json.dumps(failing_since))


if __name__ == '__main__':
    main()
