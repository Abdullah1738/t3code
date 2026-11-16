"""Date-only Marketplace proof, refreshed independently of the check budget."""
import datetime as dt
import fcntl
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import time

MARKETPLACE_REFRESH_AFTER = 600


def empty():
    return {'version': 1, 'walked_at': None, 'complete': False, 'orders': {}}


def load(data):
    from order_lookup import moment
    try:
        obj = json.loads((Path(data) / 'marketplace-placements.json').read_text())
        if (obj.get('version') != 1 or type(obj.get('complete')) is not bool
                or not isinstance(obj.get('orders'), dict)):
            raise ValueError()
        if obj.get('walked_at') is not None:
            moment(obj['walked_at'])
        orders = {}
        for oid, row in obj['orders'].items():
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', oid) or type(row.get('delivered')) is not bool:
                raise ValueError()
            orders[oid] = {'createdAt': moment(row['createdAt']).isoformat(), 'delivered': row['delivered']}
        return {**empty(), 'walked_at': obj.get('walked_at'), 'complete': obj['complete'], 'orders': orders}, None
    except FileNotFoundError:
        return empty(), 'snapshot_missing'
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return empty(), 'snapshot_corrupt'


def lane(snapshot, cache, reason=None):
    from order_lookup import moment, terminal, projection
    start = time.monotonic()
    rows, holds = [], set()
    known = {r['order']: r for r in cache if r.get('service') == 'marketplace' and terminal(r)}
    missing = False
    for oid, entry in snapshot['orders'].items():
        if entry['delivered']:
            if oid in known:
                rows.append(projection(known[oid]))
            else:
                missing = True
        else:
            holds.add(entry['createdAt'])
    complete = snapshot['complete'] and snapshot['walked_at'] is not None and not missing and reason is None
    age = max(0, int((dt.datetime.now(dt.timezone.utc) - moment(snapshot['walked_at'])).total_seconds())) \
        if snapshot['walked_at'] else None
    return rows, {'exhaustive': complete, 'covered_from': None, 'limit': None,
        'pages': 0, 'fetched': 0, 'cached': len(rows), 'ms': round((time.monotonic() - start) * 1000),
        'coverage_cleared_rows': 0, 'hold_times': sorted(holds), 'walked_at': snapshot['walked_at'],
        'hold_count': len(holds), 'placements_known': len(snapshot['orders']),
        'placements_total': len(snapshot['orders']), 'snapshot_age_s': age,
        'stop_reason': reason or ('end_of_history' if complete else
                                  'placement_unknown' if missing else 'snapshot_incomplete')}


def refresh(data, root, budget=120):
    from order_lookup import load_cache, moment, projection
    from state_json import write_json
    from toollog import emit
    data = Path(data)
    data.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    stats = dict(orders_total=0, known=0, delivered=0, fetched=0, pages=0, ms=0, result='busy')
    with (data / 'marketplace-refresh.lock').open('a') as refresh_lock:
        try:
            fcntl.flock(refresh_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit('money-cases', 'marketplace.refresh', kind='perf', duration_ms=0, ok=True, props=stats)
            return stats
        snapshot, reset_reason = load(data)
        orders = snapshot['orders']
        seen, cursors, page_ids, delivered_rows = set(), set(), set(), {}
        walked_at = dt.datetime.now(dt.timezone.utc).isoformat()
        full, detail_error = False, False
        end = started + budget
        network_end = end - min(1, budget / 10)
        retained_details = {r['order'] for r in load_cache(data / 'order-details.json')
                            if r['service'] == 'marketplace'}
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)

        def timeout(*_):
            raise TimeoutError()
        # Native readers own SIGALRM and reject an enclosing timer. Each GET is
        # bounded by the remaining walk budget; reserve the final second for storage.
        try:
            sys.path.insert(0, str(root))
            import native_orders
            from noon_order_details import details
            cursor, page = None, 1
            while time.monotonic() < network_end:
                stats['result'] = 'list_error'
                result = native_orders.orders('noon', service='marketplace', page=page,
                    timeout=min(60, max(0.001, network_end - time.monotonic())), **({'cursor': cursor} if cursor else {}))
                if not result.get('ok') or result.get('partial'):
                    break
                stats['pages'] += 1
                coverage = (result.get('coverage') or {}).get('marketplace') or {}
                if (coverage.get('paging_verified') is not True or coverage.get('page') != page
                        or coverage.get('default_page_only') is True or coverage.get('history_first_page_only') is True):
                    stats['result'] = 'invalid_paging'
                    break
                listed = result['orders']
                identities = {(o['order'], o.get('item_id'), o.get('shipment_id')) for o in listed}
                # Status changes do not establish cursor progress. Reject a replay
                # before it can authorize pruning orders absent from these pages.
                if page > 1 and listed and not identities - page_ids:
                    stats['result'] = 'invalid_paging'
                    break
                page_ids.update(identities)
                for order in listed:
                    if time.monotonic() >= network_end:
                        raise TimeoutError()
                    oid = order['order']
                    if oid in seen:
                        continue
                    seen.add(oid)
                    old = orders.get(oid)
                    if old and old['delivered'] and oid in retained_details:
                        continue
                    try:
                        stats['result'] = 'detail_error'
                        stats['fetched'] += 1
                        detail = details(oid, 'marketplace', timeout=min(60, max(0.001, network_end - time.monotonic())))
                        if (detail.get('ok') is not True or detail.get('account_verified') is not True
                                or detail.get('order') != oid):
                            raise ValueError()
                        created = moment(detail.get('placed_at')).isoformat()
                        delivered = detail.get('whole_order_complete') is True and detail.get('status') == 'delivered'
                        if delivered:
                            delivered_rows[oid] = projection({**detail, 'service': 'marketplace',
                                'placed_at': old['createdAt'] if old else created, 'raw_status': 'delivered'})
                        orders[oid] = {'createdAt': old['createdAt'] if old else created,
                                       'delivered': delivered or bool(old and old['delivered'])}
                    except TimeoutError:
                        raise
                    except Exception:
                        detail_error = True
                if coverage.get('exhaustive') is True:
                    full = True
                    stats['result'] = 'placement_unknown' if detail_error or not seen <= orders.keys() else 'end_of_history'
                    break
                nxt = coverage.get('next_cursor')
                if not isinstance(nxt, str) or not nxt or nxt in cursors:
                    stats['result'] = 'invalid_paging'
                    break
                cursors.add(nxt)
                cursor, page = nxt, page + 1
            else:
                stats['result'] = 'budget'
        except TimeoutError:
            stats['result'] = 'budget'
        except Exception:
            stats['result'] = 'list_error'
        # Never hold the cache lock across network reads. A check can replace its
        # receipt cache meanwhile, so merge against its latest value under the lock.
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, end - time.monotonic()))
        try:
            with (data / 'order-details.lock').open('a') as cache_lock:
                while True:
                    try:
                        fcntl.flock(cache_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        time.sleep(min(0.05, max(0.001, end - time.monotonic())))
                cache_path = data / 'order-details.json'
                cache = {(r['service'], r['order']): r for r in load_cache(cache_path)}
                cache.update({('marketplace', oid): row for oid, row in delivered_rows.items()})
                write_json(cache_path, list(cache.values()))
                if full and not detail_error and seen <= orders.keys():
                    snapshot['orders'] = {oid: orders[oid] for oid in seen if oid in orders}
                    snapshot['walked_at'] = walked_at
                    snapshot['complete'] = True
                write_json(data / 'marketplace-placements.json', snapshot)
        except TimeoutError:
            stats['result'] = 'cache_busy'
        except OSError:
            stats['result'] = 'store_error'
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            if previous_timer[0]:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])
        stats.update(orders_total=len(seen), known=sum(oid in orders for oid in seen),
                     delivered=sum(orders[oid]['delivered'] for oid in seen if oid in orders),
                     ms=round((time.monotonic() - started) * 1000))
        emit('money-cases', 'marketplace.refresh', kind='perf', duration_ms=stats['ms'],
                     ok=stats['result'] == 'end_of_history', props={**stats, 'snapshot_error': reset_reason or 'none'})
        return stats


def refresh_status(data):
    if os.environ.get('MONEY_CASES_REFRESH_DISABLED') == '1':
        return 'skipped'
    snapshot, _ = load(data)
    if snapshot['walked_at']:
        from order_lookup import moment
        if time.time() - moment(snapshot['walked_at']).timestamp() < MARKETPLACE_REFRESH_AFTER:
            return 'fresh'
    try:
        Path(data).mkdir(parents=True, exist_ok=True)
        with (Path(data) / 'marketplace-refresh.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return 'started'
    except BlockingIOError:
        return 'busy'
    except OSError:
        return 'skipped'


def launch_refresh(data):
    python = Path(os.environ.get('MONEY_CASES_ORDER_PYTHON', '~/.local/share/uv/tools/mitmproxy/bin/python')).expanduser()
    subprocess.Popen([str(python), '-I', '-B', str(Path(__file__).with_name('order_lookup.py')),
                      'refresh-marketplace', '--data', str(data)], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True)
