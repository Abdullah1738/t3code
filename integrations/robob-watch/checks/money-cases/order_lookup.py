"""Bounded read-only order lookup through the installed app-api readers."""
import multiprocessing
from multiprocessing.connection import wait
import datetime as dt
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

LANES = ('minutes', 'marketplace', 'food', 'nownow')
SAME_TIME = dt.timedelta(minutes=15)
BINDING_LIMIT = 'ORDER_LIST_HOST_BINDING_UNVERIFIED'
CACHE_FIELDS = ('service', 'order', 'total', 'currency', 'placed_at', 'status', 'raw_status', 'cached_at', 'whole_order_complete')
TERMINAL = {'delivered', 'cancelled', 'canceled', 'failed'}


class OutOfTime(ValueError):
    """The caller had no budget to start a lookup."""


class SourceLimit(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def moment(value, service=None):
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        if service != 'minutes':
            raise ValueError('order time missing zone')
        parsed = parsed.replace(tzinfo=ZoneInfo('Asia/Dubai'))
    return parsed


def terminal(row):
    if row.get('service') == 'marketplace':
        return row.get('whole_order_complete') is True and row.get('status') == 'delivered'
    return any(row.get(k) in TERMINAL for k in ('status', 'raw_status'))


def projection(row):
    if row.get('service') not in LANES or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', str(row.get('order', ''))):
        raise ValueError('invalid order')
    if not Decimal(str(row.get('total'))).is_finite() or not re.fullmatch('[A-Z]{3}', str(row.get('currency', ''))):
        raise ValueError('invalid total')
    placed = moment(row.get('placed_at'), row['service']).isoformat()
    cached_at = moment(row['cached_at']).isoformat() if row.get('cached_at') else None
    return {**{k: row.get(k) for k in CACHE_FIELDS}, 'placed_at': placed, 'cached_at': cached_at,
            'status': row.get('status') if row.get('status') in TERMINAL else None,
            'raw_status': row.get('raw_status') if row.get('raw_status') in TERMINAL else None}


def load_cache(path):
    try:
        rows = json.loads(path.read_text())
        return [projection(row) for row in rows if terminal(row)] if isinstance(rows, list) else []
    except (OSError, ValueError, TypeError, AttributeError, InvalidOperation):
        return []


def read(app, deadline=None, since=None, cache_path=None):
    from state_json import write_json
    remaining = 10 if deadline is None else min(10, deadline - time.time() - 0.1)
    if remaining < 1:
        raise OutOfTime('order lookup out of time')
    python = Path(os.environ.get('MONEY_CASES_ORDER_PYTHON', '~/.local/share/uv/tools/mitmproxy/bin/python')).expanduser()
    root = Path(os.environ.get('MONEY_CASES_APP_API', '~/.local/share/app-api-cli')).expanduser()
    cache_path = Path(cache_path) if cache_path else Path(os.environ.get(
        'MONEY_CASES_DIR', '~/Documents/assistant/money-cases')).expanduser() / 'order-details.json'
    cache = load_cache(cache_path) if app == 'noon' else []
    try:
        # Readers log by default. Their diagnostics are disposable: only our sanitized
        # lane metrics leave this sandbox. They never write the live app state/logs.
        with tempfile.TemporaryDirectory(prefix='money-orders-') as scratch:
            env = {**os.environ, 'ROBOB_TOOL_LOG_DIR': scratch}
            result = subprocess.run([str(python), '-I', '-B', str(Path(__file__).resolve()), app, str(root),
                                     str(time.time() + remaining - 0.5)],
                                    input=json.dumps({'since': since.isoformat() if since else None, 'cache': cache}),
                                    capture_output=True, text=True, timeout=remaining, env=env)
        if result.returncode:
            raise ValueError('order lookup unavailable')
        result = json.loads(result.stdout)
        if isinstance(result, dict) and result.get('limit') == BINDING_LIMIT:
            raise SourceLimit(BINDING_LIMIT)
        if (not isinstance(result, dict) or not isinstance(result.get('orders'), list)
                or type(result.get('complete')) is not bool):
            raise ValueError('invalid orders')
        if app == 'noon':
            merged = {(r['service'], r['order']): r for r in cache}
            for row in result['orders']:
                row = projection(row)
                key = row['service'], row['order']
                merged.pop(key, None)
                if terminal(row):
                    merged[key] = {**row, 'cached_at': dt.datetime.now(dt.timezone.utc).isoformat()}
            try:
                write_json(cache_path, sorted(merged.values(), key=lambda r: moment(r['placed_at']))[-1000:])
            except OSError:
                pass  # Cache availability never changes the evidence returned by the reader.
        return result
    except SourceLimit:
        raise
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError) as e:
        raise ValueError('order lookup unavailable') from e


def lane_process(connection, service, root, deadline, since, cache):
    try:
        connection.send(native('noon', root, deadline, since, cache, services=(service,)))
    except Exception:
        pass
    finally:
        connection.close()


def parallel_lanes(root, deadline, since, cache):
    # The installed readers require main-thread signal deadlines. Fork before
    # importing them: each lane gets its own main thread and the same time slice.
    started = time.monotonic()
    context = multiprocessing.get_context('fork')
    end = min(deadline, time.time() + 8) if deadline is not None else time.time() + 8
    children, connections, results = [], [], []
    try:
        for service in LANES:
            receive, send = context.Pipe(duplex=False)
            process = context.Process(target=lane_process, args=(send, service, root, end - 0.2, since, cache), daemon=True)
            process.start()
            send.close()
            children.append(process)
            connections.append(receive)
        while connections and end > time.time():
            ready = wait(connections, timeout=max(0, end - time.time()))
            for connection in ready:
                try:
                    results.append(connection.recv())
                except EOFError:
                    pass
                connections.remove(connection)
                connection.close()
    finally:
        for connection in connections:
            connection.close()
        for process in children:
            if process.is_alive():
                process.terminate()
            process.join(timeout=0.05)
    lanes = {name: {'exhaustive': False, 'covered_from': None, 'limit': None,
                    'fetched': 0, 'cached': 0, 'pages': 0, 'ms': round((time.monotonic() - started) * 1000)}
             for name in LANES}
    rows = []
    for result in results:
        rows.extend(result['orders'])
        lanes.update(result['lanes'])
    return {'orders': rows, 'complete': all(l['exhaustive'] for l in lanes.values()), 'lanes': lanes}


def native(app, root, deadline=None, since=None, cache=None, services=None):
    sys.path.insert(0, root)
    if app == 'careem':
        import careem_http_orders
        try:
            return careem_http_orders.orders()
        except Exception as exc:
            if str(exc) == BINDING_LIMIT:
                return {'limit': BINDING_LIMIT}
            raise ValueError('order lookup unavailable') from None
    if services is None:
        return parallel_lanes(root, deadline, since, cache)
    end = time.monotonic() + (8 if deadline is None else max(0, min(8, deadline - time.time())))
    import native_orders
    from noon_order_details import details
    since = moment(since) if since is not None else None
    known = {(r['service'], r['order']): r for r in (cache or [])}
    def read_lane(service):
        start = time.monotonic()
        lane_end = end
        rows = []
        lane = {'exhaustive': False, 'covered_from': None, 'limit': None,
                'fetched': 0, 'cached': 0, 'pages': 0, 'ms': 0}
        previous, seen, page, broken, unordered = None, set(), 1, False, False
        cursor, page_ids, cursors = None, set(), set()
        try:
            while lane_end - time.monotonic() > 0.05:
                result = native_orders.orders('noon', service=service, page=page,
                                              timeout=lane_end - time.monotonic(),
                                              **({'cursor': cursor} if cursor is not None else {}))
                if time.monotonic() >= lane_end or not result.get('ok') or result.get('partial'):
                    break
                lane['pages'] += 1
                coverage = (result.get('coverage') or {}).get(service) or {}
                paging = (service == 'minutes' or (coverage.get('paging_verified') is True
                          and coverage.get('default_page_only') is not True
                          and coverage.get('history_first_page_only') is not True))
                page_verified = (not paging or (coverage.get('page') == page and
                                 (service == 'marketplace' or (type(coverage.get('total_pages')) is int
                                  and coverage['total_pages'] >= page))))
                before = set(seen)
                listed = result['orders']
                if not isinstance(listed, list):
                    raise ValueError('invalid list')
                identities = {(o['order'], o.get('item_id'), o.get('shipment_id')) for o in listed}
                # Repeated identities can carry changed statuses that invalidate
                # retained matches. Reconcile them before stopping pagination.
                repeated_page = page > 1 and bool(listed) and not identities - page_ids
                page_ids.update(identities)
                page_done = True
                shipment_cancellations = {o.get('order') for o in listed if isinstance(o, dict)
                                          and any(o.get(k) in ('cancelled', 'canceled', 'failed')
                                                  for k in ('status', 'raw_status'))}
                unsettled = {o['order'] for o in listed
                             if o.get('status') != 'delivered' or o.get('raw_status') != 'delivered'}
                for order in listed:
                    oid = order['order']
                    if service == 'marketplace' and oid in shipment_cancellations:
                        broken = True
                        lane['covered_from'] = None
                        rows[:] = [row for row in rows if row['order'] != oid]
                        continue
                    if oid in seen:
                        if service == 'marketplace' and oid in before and oid in unsettled:
                            # A later scoped card can invalidate earlier terminal
                            # evidence. Do not retain its total as a positive match.
                            broken = True
                            rows[:] = [row for row in rows if row['order'] != oid]
                        continue
                    seen.add(oid)
                    try:
                        list_time = (moment(order['placed_at'], service) if service == 'minutes' or
                                     (paging and coverage.get('ordered_by_placed_at') is True) else None)
                        older = since is not None and list_time is not None and list_time < since - SAME_TIME
                        if older:
                            placed = list_time
                        else:
                            if lane_end - time.monotonic() <= 0.05:
                                page_done = False
                                if list_time is None:
                                    lane['covered_from'] = None
                                break
                            row = known.get((service, oid))
                            if row is not None and terminal(row) and (
                                    (service != 'marketplace' and terminal(order)) or
                                    (service == 'marketplace' and oid not in unsettled)):
                                row = projection(row)
                                lane['cached'] += 1
                            else:
                                lane['fetched'] += 1
                                detail = details(oid, service, timeout=lane_end - time.monotonic())
                                if time.monotonic() >= lane_end:
                                    page_done = False
                                    if list_time is None:
                                        lane['covered_from'] = None
                                    break
                                if (detail.get('ok') is not True or detail.get('account_verified') is not True
                                        or detail.get('order') != oid):
                                    raise ValueError('unverified detail')
                                row = projection({**detail, 'service': service,
                                                  'placed_at': list_time.isoformat() if list_time else detail.get('placed_at'),
                                                  'status': detail.get('status') if service == 'marketplace' else order.get('status'),
                                                  'raw_status': order.get('raw_status')})
                                if service == 'marketplace' and oid in unsettled:
                                    row['whole_order_complete'] = False
                            # Current list status takes precedence over a cached terminal status.
                            row = {**row, 'status': row.get('status') if service == 'marketplace' else order.get('status'),
                                   'raw_status': order.get('raw_status')}
                            placed = moment(row['placed_at'])
                            rows.append(row)
                        if service != 'marketplace' and previous is not None and placed > previous:
                            unordered = True
                        previous = placed
                        if service != 'marketplace' and not broken and not unordered and page_verified:
                            lane['covered_from'] = placed.isoformat()
                    except Exception:
                        # Preserve earlier proof and later positive evidence, never bridge a gap.
                        broken = True
                        # Marketplace lists active shipments before history. An unread
                        # row without a known time can be newer than the verified prefix.
                        try:
                            gap_time = moment(order.get('placed_at'), service)
                            if previous is None or gap_time > previous:
                                lane['covered_from'] = None
                        except (ValueError, TypeError):
                            lane['covered_from'] = None
                if unordered:
                    lane['covered_from'] = None
                if not page_done or broken or unordered or repeated_page:
                    break
                if paging and service != 'marketplace':
                    pages = coverage.get('total_pages')
                    valid = type(pages) is int and pages >= page and coverage.get('page') == page
                    lane['exhaustive'] = valid and page == pages and (page == 1 or bool(seen - before))
                    if not valid or lane['exhaustive'] or (since and previous and previous < since - SAME_TIME):
                        break
                    # An empty or repeated page cannot advance proof of history.
                    if not listed or not (seen - before):
                        break
                    page += 1
                elif paging:
                    if not page_verified:
                        break
                    lane['exhaustive'] = coverage.get('exhaustive') is True
                    nxt = coverage.get('next_cursor')
                    if lane['exhaustive'] or not isinstance(nxt, str) or not nxt or nxt in cursors:
                        break
                    cursors.add(nxt)
                    cursor = nxt
                    page += 1
                else:
                    lane['exhaustive'] = coverage.get('exhaustive') is True
                    # Older installed readers still expose only the default page.
                    if not lane['exhaustive'] and (since is None or previous is None or previous >= since):
                        lane['limit'] = 'page-1 history only'
                    break
        except Exception:
            pass
        lane['ms'] = round((time.monotonic() - start) * 1000)
        return rows, lane

    results = [read_lane(service) for service in services]
    rows = [row for lane_rows, lane in results for row in lane_rows]
    lanes = {service: lane for service, (lane_rows, lane) in zip(services, results)}
    return {'orders': rows, 'complete': all(l['exhaustive'] for l in lanes.values()), 'lanes': lanes}


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(native(sys.argv[1], sys.argv[2], float(sys.argv[3]), **payload)))
    except Exception:
        sys.exit(1)
