"""Read-only account-verified noon Minutes and marketplace HTTP tracking.

Only verified native reads are allowed. Marketplace evidence is shipment-scoped;
bounded active/history pages never certify whole-order terminal completion.
"""
import datetime as dt
import html
import http.client
import json
import math
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'capture'))
from keychain import load

MAX_BYTES = 2_000_000
DUBAI = dt.timezone(dt.timedelta(hours=4))
WHOAMI = ('GET', 'api-app-st.noon.com', '/_vs/st/st-whoami-api/whoami')
ROUTES = {
    'minutes_list': ('POST', 'api-app-instant.noon.com', '/_svc/instant/order/list'),
    'minutes_track': ('POST', 'api-app-instant.noon.com', '/_svc/instant/order/track'),
    'marketplace_active': ('GET', 'api-app.noon.com', '/_svc/order-v2/orders/active'),
    'marketplace_history': ('GET', 'api-app.noon.com', '/_svc/order-v2/orders/history'),
}
MINUTES_STAGES = {'confirmed': 'placed', 'preparing': 'preparing',
                  'ready_for_pickup': 'preparing',
                  'picked_up': 'out for delivery',
                  'arrived_at_delivery': 'nearby', 'delivered': 'delivered'}
MARKETPLACE_STAGES = {'processing':'pending confirmation', 'confirmed':'placed',
                      'packed':'packed', 'shipped':'picked up', 'out_for_delivery':'out for delivery',
                      'delivered':'delivered', 'cancelled':'cancelled'}


def marketplace_stage(raw):
    # Formatting variants of the same provider enum, never substring matches.
    if not isinstance(raw,str) or not re.fullmatch(r'[A-Za-z_ -]{1,64}',raw):
        return 'unknown'
    return MARKETPLACE_STAGES.get(re.sub(r'[ -]+','_',raw.strip().lower()),'unknown')


def marketplace_active_stage(states):
    active=set(states)-{'delivered','cancelled'}
    if not active or 'unknown' in active:return 'unknown'
    ranks={'pending confirmation':0,'placed':1,'preparing':2,'packed':3,'picked up':4,'out for delivery':5}
    return min(active,key=lambda value:ranks.get(value,-1))


def marketplace_eta_minutes(text_value):
    match=re.fullmatch(r'Arriving (?:(\d+) Hr[s]?\s*)?(?:(\d+) Min[s]?)?',text_value or '',re.I)
    if match and any(match.groups()):
        minutes=int(match[1] or 0)*60+int(match[2] or 0)
        if 0<=minutes<2880:return minutes
    return None


def marketplace_eta(out):
    minutes=marketplace_eta_minutes(out.get('eta_text'))
    if minutes is not None:
        observed=dt.datetime.fromisoformat(out['checked_at'])
        if observed.tzinfo:
            out.update(eta=(observed+dt.timedelta(minutes=minutes)).isoformat(),
                       eta_relative_minutes=minutes,eta_observed_at=out['checked_at'],
                       eta_source='native_marketplace_countdown')
    return out
ORDER = re.compile(r'[A-Z0-9]{1,64}')
# Live-verified 2026-10-11: marketplace shipments are -S<digits> (packed+) and
# rocket orders bind a -U<digits> fulfillment unit until packing rebinds -S.
SHIPPABLE_SUFFIX = r'[SU][0-9]{1,6}'
SHIPMENT = re.compile(r'([A-Z0-9]{1,64})-' + SHIPPABLE_SUFFIX)
ITEM = re.compile(r'([A-Z0-9]{1,64})-[0-9]{1,6}')


class NoonError(Exception):
    pass


def remaining(deadline):
    value = deadline - time.monotonic()
    if not math.isfinite(value) or value <= 0:
        raise NoonError('NATIVE_READ_TIMEOUT')
    return value


def operation_deadline(timeout, deadline=None):
    """Create one budget, or inherit an unchanged absolute monotonic deadline."""
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise NoonError('INVALID_TIMEOUT')
    if deadline is None:
        return time.monotonic() + timeout
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise NoonError('INVALID_DEADLINE')
    remaining(deadline)
    return deadline


@contextmanager
def read_deadline(deadline):
    left = remaining(deadline)
    if threading.current_thread() is not threading.main_thread() or any(signal.getitimer(signal.ITIMER_REAL)):
        raise NoonError('NATIVE_DEADLINE_UNAVAILABLE')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(*_):
        raise NoonError('NATIVE_READ_TIMEOUT')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, left)
        yield left
        remaining(deadline)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def session(service):
    try:
        saved = load('minutes' if service == 'minutes' else 'noon')
    except Exception:
        raise NoonError('ACCOUNT_STORAGE_UNAVAILABLE') from None
    if not isinstance(saved, dict) or not isinstance(saved.get('headers'), dict) or not saved['headers']:
        raise NoonError('ACCOUNT_CAPTURE_REQUIRED')
    headers = saved['headers']
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise NoonError('ACCOUNT_HEADERS_INVALID')
    return {k.lower(): v for k, v in headers.items() if k.lower() not in {
        'host', 'content-length', 'accept-encoding', 'connection', 'if-none-match',
        'if-modified-since', 'baggage', 'sentry-trace'}}


def request(route, headers, deadline, payload=None, shipment=None, item=None):
    remaining(deadline)
    if route == 'whoami':
        method, host, path = WHOAMI
    elif route == 'marketplace_shipment':
        if not isinstance(shipment, str) or not SHIPMENT.fullmatch(shipment):
            raise NoonError('INVALID_SHIPMENT_ID')
        method, host, path = 'GET', 'api-app.noon.com', '/_svc/order-v2/track/shipment/' + shipment
    elif route == 'marketplace_item':
        if not isinstance(item, str) or not ITEM.fullmatch(item):
            raise NoonError('INVALID_ITEM_ID')
        method, host, path = 'GET', 'api-app.noon.com', '/_svc/order-v2/track/item/' + item
    elif route in ROUTES:
        method, host, path = ROUTES[route]
    else:
        raise NoonError('ENDPOINT_DENIED')
    if method == 'POST':
        if route == 'minutes_list':
            valid = (isinstance(payload, dict) and set(payload) == {'pageNr'}
                     and type(payload['pageNr']) is int and 1 <= payload['pageNr'] <= 100)
        else:
            valid = (isinstance(payload, dict) and set(payload) == {'order_nr'}
                     and isinstance(payload['order_nr'], str) and ORDER.fullmatch(payload['order_nr']))
        if not valid:
            raise NoonError('INVALID_READ_PAYLOAD')
    elif payload is not None:
        raise NoonError('INVALID_READ_PAYLOAD')
    h = dict(headers)
    h.update({'content-type': 'application/json', 'accept': 'application/json', 'accept-encoding': 'identity'})
    try:
        req = urllib.request.Request('https://' + host + path, headers=h, method=method,
                                     data=json.dumps(payload).encode() if payload is not None else None)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with read_deadline(deadline) as left:
            with opener.open(req, timeout=left) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise NoonError('RESPONSE_TOO_LARGE')
            if raw[:2] == b'\x1f\x8b':
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                raw = decoder.decompress(raw, MAX_BYTES + 1)
                if len(raw) > MAX_BYTES or decoder.unconsumed_tail:
                    raise NoonError('RESPONSE_TOO_LARGE')
                if not decoder.eof:
                    raise NoonError('NATIVE_READ_FAILED')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise NoonError('SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        raise NoonError({401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 404: 'ORDER_NOT_FOUND',
                         429: 'RATE_LIMITED'}.get(exc.code, 'HTTP_' + str(exc.code))) from None
    except TimeoutError:
        raise NoonError('NATIVE_READ_TIMEOUT') from None
    except (urllib.error.URLError, http.client.HTTPException, ValueError, OSError, zlib.error):
        raise NoonError('NATIVE_READ_FAILED') from None


def verify_home(data, headers):
    customer = data.get('customer')
    if not isinstance(customer, dict) or not customer.get('customerCode'):
        raise NoonError('AUTH_EXPIRED')
    experiences = data.get('experiences')
    if not isinstance(experiences, list) or not headers.get('x-addresscode') or not headers.get('x-addresskey'):
        raise NoonError('HOME_MISMATCH')
    for experience in experiences:
        a = experience.get('selectedAddress') if isinstance(experience, dict) else None
        if (isinstance(a, dict) and str(a.get('addressCode')) == headers['x-addresscode']
                and str(a.get('addressKey')) == headers['x-addresskey'] and 'banyan' in json.dumps(a).lower()):
            return
    raise NoonError('HOME_MISMATCH')


def verified_session(service, deadline):
    remaining(deadline)  # Do not touch storage after the shared budget expires.
    h = session(service)
    verify_home(request('whoami', h, deadline), h)
    return h


def text(value):
    if not isinstance(value, str):
        return None
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value))).strip()[:400] or None


def base(order, service, verified=False):
    return {'ok': True, 'app': 'noon', 'order': order, 'service': service,
            'source': 'native_order_api', 'status': 'unknown', 'eta': None,
            'eta_text': None, 'rider': None, 'account_verified': verified,
            'saved_home_verified': verified, 'identity_verified': True,
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def minutes_track(data, order):
    labels = data.get('csHelpLabels')
    raw = data.get('status')
    if (not isinstance(labels, dict) or labels.get('orderNumber') != order
            or not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw)):
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    out = base(order, 'minutes')
    out.update(status=MINUTES_STAGES.get(raw, 'unknown'), raw_status=raw,
               status_text=text(data.get('title')), eta_text=text(data.get('estimate')),
               coverage='exact_native_minutes_order; confirmed_preparing_ready_for_pickup_picked_up_arrived_at_delivery_delivered_verified')
    rider = data.get('rider')
    if isinstance(rider, dict) and rider.get('showRiderDetails') is True:
        out['rider'] = {k: rider[k] for k in ('name', 'phone')
                        if isinstance(rider.get(k), str) and rider[k]} or None
    # deliveryTime was 7 during the active order, but its unit has not been
    # independently verified. Preserve the explicit list window instead.
    return out


def minutes_list(data):
    rows = data.get('orders')
    if not isinstance(rows, list):
        raise NoonError('SCHEMA_CHANGED')
    out = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('orderNr'), str) or not ORDER.fullmatch(row['orderNr']):
            raise NoonError('SCHEMA_CHANGED')
        item = base(row['orderNr'], 'minutes')
        raw = row.get('statusCode')
        if not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
            raise NoonError('SCHEMA_CHANGED')
        item.update(status=MINUTES_STAGES.get(raw, 'unknown') if isinstance(raw, str) else 'unknown',
                    raw_status=raw if isinstance(raw, str) else None, placed_at=row.get('placedAt'),
                    eta_text=text(row.get('estimatedDeliveryText')), coverage='native_minutes_list_page')
        out.append(item)
    return out


def eta_window(placed_at, value):
    """Verified Minutes list display: time range is Dubai local, anchored to placement."""
    if not isinstance(placed_at, str) or not isinstance(value, str):
        return None
    match = re.fullmatch(r'Arrives between: (\d{2}:\d{2}) - (\d{2}:\d{2}) (AM|PM)', value)
    if not match:
        return None
    try:
        placed = dt.datetime.fromisoformat(placed_at)
        placed = placed.replace(tzinfo=DUBAI) if placed.tzinfo is None else placed.astimezone(DUBAI)
        start = dt.datetime.strptime(match[1] + ' ' + match[3], '%I:%M %p').time()
        end = dt.datetime.strptime(match[2] + ' ' + match[3], '%I:%M %p').time()
        first = dt.datetime.combine(placed.date(), start, DUBAI)
        last = dt.datetime.combine(placed.date(), end, DUBAI)
        if last < first or first < placed - dt.timedelta(minutes=5) or last > placed + dt.timedelta(hours=4):
            return None  # no guessing across noon/midnight or future scheduled days
        return {'start': first.isoformat(), 'end': last.isoformat()}
    except ValueError:
        return None


def marketplace_cards(data):
    rows = data.get('data')
    if not isinstance(rows, list):
        raise NoonError('SCHEMA_CHANGED')
    out = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('orderNr'), str) or not ORDER.fullmatch(row['orderNr']):
            raise NoonError('SCHEMA_CHANGED')
        order = row['orderNr']
        status = row.get('status') or {}
        if not isinstance(status, dict):
            raise NoonError('SCHEMA_CHANGED')
        raw = status.get('highStatusCode')
        if not isinstance(raw, str) or not re.fullmatch(r'[A-Za-z_ -]{1,64}', raw):
            raise NoonError('SCHEMA_CHANGED')
        shipment = row.get('shipmentNr')
        if shipment is not None and (not isinstance(shipment, str) or not SHIPMENT.fullmatch(shipment)
                                     or SHIPMENT.fullmatch(shipment)[1] != order):
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        items = row.get('items', [])
        delivery = row.get('delivery') or {}
        if not isinstance(items, list) or not isinstance(delivery, dict):
            raise NoonError('SCHEMA_CHANGED')
        item_ids = [i.get('itemNr') for i in items if isinstance(i, dict)]
        if row.get('itemNr') is not None:
            item_ids.append(row['itemNr'])
        if any(not isinstance(i, str) or not ITEM.fullmatch(i) or ITEM.fullmatch(i)[1] != order for i in item_ids):
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        item = base(order, 'marketplace')
        item.update(status=marketplace_stage(raw),
                    raw_status=raw, shipment_id=shipment,
                    item_ids=item_ids, item_id=row.get('itemNr'),
                    scope='item' if row.get('itemNr') else 'shipment',
                    eta_text=text(delivery.get('message')),
                    coverage='bounded_marketplace_cards; whole_order_completion_unverified')
        out.append(item)
    return out


def shipment_track(data, order, shipment):
    if data.get('orderNr') != order or data.get('shipmentNr') != shipment:
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    timeline = data.get('timeline')
    if not isinstance(timeline, list):
        raise NoonError('SCHEMA_CHANGED')
    # Future timeline nodes include "delivered" with status:null. Only an
    # attached current status object is evidence; never classify the node label.
    current = [x['status'] for x in timeline if isinstance(x, dict) and isinstance(x.get('status'), dict)]
    raws = {x.get('highStatusCode') for x in current if isinstance(x.get('highStatusCode'), str)}
    raw = next(iter(raws)) if len(raws) == 1 else None
    out = base(order, 'marketplace')
    out.update(shipment_id=shipment, scope='shipment', raw_status=raw,
                status=marketplace_stage(raw),
                eta_text=text(data.get('deliveryMessage')), coverage='exact_native_shipment; whole_order_completion_unverified')
    if len(raws) > 1:
        out['warnings'] = ['timeline_status_conflict']
    return marketplace_eta(out)


def item_track(data, order, item):
    if data.get('orderNr') != order or data.get('itemNr') != item:
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    timeline = data.get('timeline')
    if not isinstance(timeline, list):
        raise NoonError('SCHEMA_CHANGED')
    current = [x['status'] for x in timeline if isinstance(x, dict) and isinstance(x.get('status'), dict)]
    raws = {x.get('highStatusCode') for x in current if isinstance(x.get('highStatusCode'), str)}
    raw = next(iter(raws)) if len(raws) == 1 else None
    nested = data.get('item') or {}
    if not isinstance(nested, dict) or nested.get('itemNr') != item:
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    sid = nested.get('shipmentNr')
    if sid is not None and (not isinstance(sid, str) or not SHIPMENT.fullmatch(sid) or SHIPMENT.fullmatch(sid)[1] != order):
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    out = base(order, 'marketplace')
    out.update(item_id=item, shipment_id=sid, scope='item', raw_status=raw,
                status=marketplace_stage(raw), eta_text=text(data.get('deliveryMessage')),
                coverage='exact_native_item; whole_order_completion_unverified')
    if len(raws) > 1:
        out['warnings'] = ['timeline_status_conflict']
    return marketplace_eta(out)


class _Reads:
    """Accept each completed projection atomically, not the entire batch at once."""
    def __init__(self, deadline):
        self.deadline = deadline
        self.coverage = {'completed': [], 'failed': {}, 'skipped': {}}
        self.warnings = []

    def skip(self, key, code, prefix=None):
        self.coverage['skipped'][key] = code
        self.warn(prefix or key, code)

    def warn(self, prefix, code):
        warning = prefix + '_' + code.lower()
        if warning not in self.warnings:
            self.warnings.append(warning)

    def run(self, key, action, prefix=None, required=False):
        try:
            remaining(self.deadline)
        except NoonError as exc:
            self.skip(key, str(exc), prefix)
            if required:
                raise
            return None
        try:
            result = action()
            # The transport enforces this too. Keep this boundary so neither a
            # late response nor a failed projection replaces earlier evidence.
            remaining(self.deadline)
        except NoonError as exc:
            self.coverage['failed'][key] = str(exc)
            self.warn(prefix or key, str(exc))
            if required:
                raise
            return None
        self.coverage['completed'].append(key)
        return result

    def fail(self, default):
        errors = list(self.coverage['failed'].values()) + list(self.coverage['skipped'].values())
        raise NoonError(errors[0] if errors else default)

    def finish(self, out):
        out.update(partial=bool(self.coverage['failed'] or self.coverage['skipped']),
                   read_coverage=self.coverage)
        if self.warnings:
            out['warnings'] = self.warnings
        return out


def _marketplace_pages(h, reads):
    rows = []
    for route in ('marketplace_active', 'marketplace_history'):
        page = reads.run(route, lambda: marketplace_cards(request(route, h, reads.deadline)))
        if page is not None:
            rows.extend(page)
    return rows


def _merge_cards(rows, reads):
    """Deduplicate equal scoped IDs, without promoting conflicting snapshots."""
    merged, indexes = [], {}
    for row in rows:
        identity = row.get('item_id') if row['scope'] == 'item' else row.get('shipment_id')
        key = (row['order'], row['scope'], identity)
        if not identity or key not in indexes:
            indexes[key] = len(merged)
            merged.append(dict(row))
            continue
        old = merged[indexes[key]]
        old['item_ids'] = list(dict.fromkeys(old['item_ids'] + row['item_ids']))
        if (old['raw_status'], old['shipment_id']) != (row['raw_status'], row['shipment_id']):
            old.update(status='unknown', raw_status=None, eta_text=None)
            if old['shipment_id'] != row['shipment_id']:
                old['shipment_id'] = None
            old['warnings'] = ['card_status_conflict']
            reads.warn('card', 'STATUS_CONFLICT')
    return merged


def track(order, timeout=10, *, deadline=None):
    if not isinstance(order, str) or not ORDER.fullmatch(order):
        raise NoonError('INVALID_ORDER_ID')
    deadline = operation_deadline(timeout, deadline)
    reads = _Reads(deadline)
    if order.startswith('I'):
        h = reads.run('minutes_session', lambda: verified_session('minutes', deadline), required=True)
        out = reads.run('minutes_track', lambda: minutes_track(
            request('minutes_track', h, deadline, {'order_nr': order}), order), required=True)
        if out['status'] != 'delivered':
            rows = reads.run('minutes_list', lambda: minutes_list(
                request('minutes_list', h, deadline, {'pageNr': 1})), prefix='eta_enrichment')
            if rows is not None:
                matches = [r for r in rows if r['order'] == order]
                if len(matches) == 1:
                    row = matches[0]
                    out['eta_text'] = row['eta_text'] or out['eta_text']
                    window = eta_window(row['placed_at'], row['eta_text'])
                    if window:
                        out.update(eta=window['end'], eta_window=window, eta_source='native_minutes_list_window')
        out.update(account_verified=True, saved_home_verified=True)
    elif order.startswith('N'):
        h = reads.run('marketplace_session', lambda: verified_session('marketplace', deadline), required=True)
        rows = _marketplace_pages(h, reads)
        matches = _merge_cards([r for r in rows if r['order'] == order], reads)
        if not matches:
            reads.fail('ORDER_NOT_IN_FETCHED_PAGE')
        shipments = []
        detail_count = 0
        for card in matches:
            card.update(account_verified=True, saved_home_verified=True)
            sid = card['shipment_id']
            item_id = card.get('item_id')
            evidence = dict(card)
            if item_id or sid:
                key = ('marketplace_item:' + item_id) if item_id else ('marketplace_shipment:' + sid)
                if detail_count >= 4:
                    reads.skip(key, 'DETAIL_LIMIT', 'detail')
                    detail = None
                else:
                    detail_count += 1
                    detail = reads.run(key, lambda: (
                        item_track(request('marketplace_item', h, deadline, item=item_id), order, item_id)
                        if item_id else shipment_track(
                            request('marketplace_shipment', h, deadline, shipment=sid), order, sid)), prefix='detail')
                if detail is not None:
                    evidence = detail
                    # Detail omits inventory. Preserve the exact card membership
                    # for cross-scope reconciliation and item -> shipment dedupe.
                    evidence['item_ids'] = list(card['item_ids'])
                else:
                    code = reads.coverage['failed'].get(key) or reads.coverage['skipped'][key]
                    evidence['warnings'] = [*evidence.get('warnings', []), 'detail_' + code.lower()]
            evidence.update(account_verified=True, saved_home_verified=True)
            shipments.append(evidence)
        out = base(order, 'marketplace', True)
        states = {s['status'] for s in shipments}
        raws = {s.get('raw_status') for s in shipments}
        out['raw_status'] = next(iter(raws)) if len(raws)==1 else None
        # Can confirm an active stage exists, but cannot certify order terminality
        # from a bounded set of shipments. Parent retains shipment evidence.
        state = marketplace_active_stage(states)
        out.update(status=state if state not in {'delivered', 'cancelled'} else 'unknown',
                   shipments=shipments, items=matches, whole_order_complete=False,
                   eta_text=shipments[0]['eta_text'] if len(shipments) == 1 else None,
                   truncated=any(code == 'DETAIL_LIMIT' for code in reads.coverage['skipped'].values()),
                   coverage='bounded_marketplace_shipments; whole_order_completion_unverified')
        active=[s for s in shipments if s['status'] not in ('delivered','cancelled')]
        if active and all(s.get('eta') for s in active):
            out.update(eta=max(s['eta'] for s in active),eta_source='native_marketplace_countdown',
                       eta_observed_at=out['checked_at'])
    else:
        raise NoonError('UNSUPPORTED_NOON_VERTICAL')
    return reads.finish(out)


def orders(service='all', page=1, timeout=10):
    if service not in {'all', 'minutes', 'marketplace'} or type(page) is not int or not 1 <= page <= 100:
        raise NoonError('INVALID_ORDER_LIST_OPTIONS')
    if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 60:
        raise NoonError('INVALID_TIMEOUT')
    deadline = time.monotonic() + timeout
    reads = _Reads(deadline)
    out = {'ok': True, 'app': 'noon', 'source': 'native_order_api', 'orders': [], 'coverage': {}}
    if service in {'all', 'minutes'}:
        h = reads.run('minutes_session', lambda: verified_session('minutes', deadline))
        if h is not None:
            def minutes_page():
                data = request('minutes_list', h, deadline, {'pageNr': page})
                return minutes_list(data), data.get('totalPages')
            result = reads.run('minutes_list', minutes_page)
            if result is not None:
                rows, total_pages = result
                out['orders'].extend(rows)
                out['coverage']['minutes'] = {'page': page, 'total_pages': total_pages}
        else:
            reads.skip('minutes_list', 'SESSION_UNAVAILABLE')
    if service in {'all', 'marketplace'}:
        h = reads.run('marketplace_session', lambda: verified_session('marketplace', deadline))
        if h is not None:
            out['orders'].extend(_merge_cards(_marketplace_pages(h, reads), reads))
        else:
            for route in ('marketplace_active', 'marketplace_history'):
                reads.skip(route, 'SESSION_UNAVAILABLE')
        out['coverage']['marketplace'] = {
            'history_first_page_only': True, 'whole_order_completion_verified': False,
            'active_fetched': 'marketplace_active' in reads.coverage['completed'],
            'history_fetched': 'marketplace_history' in reads.coverage['completed']}
    if not any(route in reads.coverage['completed'] for route in (
            'minutes_list', 'marketplace_active', 'marketplace_history')):
        reads.fail('NATIVE_READ_FAILED')
    for row in out['orders']:
        row.update(account_verified=True, saved_home_verified=True)
    return reads.finish(out)
