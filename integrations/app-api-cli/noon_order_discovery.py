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


def scan_lane(state, lane, rows, now, registered):
    ids = sorted({row['order'] for row in rows})
    old = state.setdefault(lane, {'seen': ids, 'pending': {}})
    pending = old['pending']
    for order in set(ids) - set(old['seen']):
        pending.setdefault(order, 0)
    old['seen'] = sorted(set(old['seen']) | set(ids))
    events = []
    for order, last in list(pending.items()):
        if registered(order):
            del pending[order]
        elif now - last >= 600:
            events.append({'order': order, 'service': lane})
            pending[order] = now
    return events


def registered(order):
    name = 'order-noon-' + order.lower()
    try:
        cfg = json.loads((Path.home()/'.local/state/order-tracker/orders'/(name+'.json')).read_text())
        watcher = Path.home()/'.local/share/robob-watch/watchers'/name/'watcher.json'
        return cfg.get('order') == order and cfg.get('watcher') == name and watcher.is_file()
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
