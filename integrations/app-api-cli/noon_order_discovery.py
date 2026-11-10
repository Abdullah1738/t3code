"""Read-only account history discovery for orders placed outside commerce.

The watcher wakes a registrar; it never purchases or interprets a history row as
whole-order delivery proof. Failed lanes keep their previous baseline.
"""
import datetime as dt
import fcntl
import json
import os
import time
from pathlib import Path

import noon_http_orders as core
import noon_vertical_reads as verticals


def unplaced(lane, row):
    raw = row.get('raw_status')
    if lane == 'food':
        return raw == 'failed'
    if lane == 'nownow':
        return verticals.NOWNOW_STAGES.get(raw) == 'cancelled'
    # Marketplace cancellation is shipment/item-scoped, not a non-placed order.
    return False


def scan_lane(state, lane, rows, now, registered):
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


def main():
    root = Path(os.environ['WATCH_DIR'])
    root.mkdir(parents=True, exist_ok=True)
    with (root/'noon-discovery.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # Registration's prime check can overlap the runner's tick.
        path = root/'noon-discovery.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        events, errors = [], {}
        readers = {'minutes': lambda: core.orders('minutes', timeout=10),
                   'marketplace': lambda: core.orders('marketplace', timeout=10),
                   'food': lambda: verticals.food_orders(timeout=10),
                   'nownow': lambda: verticals.nownow_orders(timeout=10)}
        for lane, read in readers.items():
            try:
                result = read()
                if result.get('partial') or not result.get('ok'):
                    raise core.NoonError('PARTIAL_HISTORY_READ')
                events.extend(scan_lane(state, lane, result['orders'], time.time(), registered))
            except core.NoonError as exc:
                errors[lane] = str(exc)
                if lane in state:
                    events.extend(scan_lane(state, lane, [], time.time(), registered))
        state['checked_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        state['errors'] = errors
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(state, indent=2))
        temp.replace(path)
        if events:
            print('New noon account orders (read-only discovery): ' + json.dumps(events))
        if errors and not events:
            raise SystemExit('Noon discovery incomplete: ' + json.dumps(errors))


if __name__ == '__main__':
    main()
