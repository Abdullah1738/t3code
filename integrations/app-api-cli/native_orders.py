"""Read-only order projections. Never expose raw responses or payment metadata.

Noon routes were found in the installed APK and replay-verified on 2026-10-04.
Talabat/Careem catalog credentials are guests: fail closed until account capture.
"""
import argparse
import datetime as dt
import gzip
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'capture'))
from keychain import load

ROUTES = {
    'minutes_list': ('POST', 'api-app-instant.noon.com', '/_svc/instant/order/list'),
    'minutes_track': ('POST', 'api-app-instant.noon.com', '/_svc/instant/order/track'),
    'noon_history': ('GET', 'api-app.noon.com', '/_svc/order-v2/orders/history'),
    'noon_active': ('GET', 'api-app.noon.com', '/_svc/order-v2/orders/active'),
}
STAGES = {'placed', 'preparing', 'picked up', 'out for delivery', 'delivered', 'cancelled'}


class OrderError(Exception):
    pass


def stage(value):
    # Exact allowlist: future delivery text and unknown enum values are not proof.
    value = str(value or '').lower().replace('_', ' ').replace('-', ' ')
    return value if value in STAGES else 'unknown'


def request(route, payload=None, timeout=10):
    method, host, path = ROUTES[route]
    if method == 'POST':
        expected = {'pageNr'} if route == 'minutes_list' else {'order_nr'}
        if not isinstance(payload, dict) or set(payload) != expected:
            raise OrderError('INVALID_READ_PAYLOAD')
    elif payload is not None:
        raise OrderError('INVALID_READ_PAYLOAD')
    saved = load('minutes' if route.startswith('minutes') else 'noon') or {}
    if not saved.get('headers'):
        raise OrderError('ACCOUNT_CAPTURE_REQUIRED')
    headers = {k: v for k, v in saved['headers'].items() if k.lower() not in {
        'host', 'content-length', 'accept-encoding', 'if-none-match',
        'if-modified-since', 'connection', 'baggage', 'sentry-trace'}}
    headers['content-type'] = 'application/json'

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request('https://' + host + path, headers=headers,
                                 method=method, data=json.dumps(payload).encode() if payload else None)
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
        data = json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)
        if not isinstance(data, dict):
            raise OrderError('SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        raise OrderError('AUTH_EXPIRED' if exc.code in (401, 403) else 'HTTP_' + str(exc.code)) from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise OrderError('NATIVE_READ_FAILED') from None


def base(order, service):
    return {'ok': True, 'app': 'noon', 'order': order, 'service': service,
            'source': 'native_order_api', 'status': 'unknown', 'eta': None,
            'rider': None, 'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()}


def minutes_track(data, order):
    labels = data.get('csHelpLabels') or {}
    if labels.get('orderNumber') != order or not isinstance(data.get('status'), str):
        raise OrderError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    out = base(order, 'minutes')
    out.update(status=stage(data['status']), raw_status=data['status'])
    # estimate is exposed separately until an active-order shape is verified.
    estimate = data.get('estimate')
    out['eta_text'] = estimate if isinstance(estimate, str) else None
    rider = data.get('rider') or {}
    if rider.get('showRiderDetails') is True:
        out['rider'] = {k: rider[k] for k in ('name', 'phone')
                        if isinstance(rider.get(k), str) and rider[k]}
        out['rider'] = out['rider'] or None
    out['coverage'] = 'verified_native_minutes_track; active_eta_schema_unverified'
    return out


def minutes_list(data):
    rows = data.get('orders')
    if not isinstance(rows, list):
        raise OrderError('SCHEMA_CHANGED')
    out = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('orderNr'), str):
            raise OrderError('SCHEMA_CHANGED')
        item = base(row['orderNr'], 'minutes')
        item.update(status=stage(row.get('statusCode')), raw_status=row.get('statusCode'),
                    placed_at=row.get('placedAt'), eta_text=row.get('estimatedDeliveryText'))
        out.append(item)
    return out


def marketplace_list(data):
    rows = data.get('data')
    if not isinstance(rows, list):
        raise OrderError('SCHEMA_CHANGED')
    out = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('orderNr'), str):
            raise OrderError('SCHEMA_CHANGED')
        item = base(row['orderNr'], 'marketplace')
        status = row.get('status') or {}
        if not isinstance(status, dict):
            raise OrderError('SCHEMA_CHANGED')
        item.update(status=stage(status.get('highStatusCode')), raw_status=status.get('highStatusCode'),
                    item_id=row.get('itemNr'), shipment_id=row.get('shipmentNr'))
        out.append(item)
    return out


def orders(app, service='all', page=1, timeout=10):
    if app != 'noon':
        raise OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY')
    result = {'ok': True, 'app': app, 'source': 'native_order_api', 'orders': [], 'coverage': {}}
    if service in ('all', 'minutes'):
        data = request('minutes_list', {'pageNr': page}, timeout)
        result['orders'].extend(minutes_list(data))
        result['coverage']['minutes'] = {'page': page, 'total_pages': data.get('totalPages')}
    if service in ('all', 'marketplace'):
        active = request('noon_active', timeout=timeout)
        history = request('noon_history', timeout=timeout)
        result['orders'].extend(marketplace_list(active) + marketplace_list(history))
        result['coverage']['marketplace'] = {'history_first_page_only': True,
                                             'has_more': (history.get('pagination') or {}).get('hasMore')}
    return result


def track(app, order, timeout=10):
    if not re.fullmatch(r'[A-Za-z0-9]{1,64}', order):
        raise OrderError('INVALID_ORDER_ID')
    if app != 'noon':
        raise OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY')
    if order.startswith('I'):
        return minutes_track(request('minutes_track', {'order_nr': order}, timeout), order)
    rows = orders(app, 'marketplace', timeout=timeout)['orders']
    matches = [r for r in rows if r['order'] == order]
    if not matches:
        raise OrderError('ORDER_NOT_IN_FETCHED_PAGE')
    out = base(order, 'marketplace')
    # A marketplace order can contain multiple shipments. Only unanimous status
    # certifies the whole order; one delivered item must never mark all delivered.
    states = {r['status'] for r in matches}
    out['status'] = next(iter(states)) if len(states) == 1 else 'unknown'
    out['items'] = matches
    out['coverage'] = 'marketplace_first_page_items_only; whole_order_completion_unverified'
    if out['status'] in {'delivered', 'cancelled'}:
        out['status'] = 'unknown'
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', choices=['noon', 'talabat', 'careem'])
    parser.add_argument('command', choices=['orders', 'track'])
    parser.add_argument('order', nargs='?')
    parser.add_argument('--minutes', action='store_true')
    parser.add_argument('--service', choices=['all', 'minutes', 'marketplace'], default='all')
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=10)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if not 1 <= args.page <= 100 or not 1 <= args.timeout <= 30:
        parser.error('page must be 1..100 and timeout 1..30')
    if args.command == 'track' and not args.order:
        parser.error('track requires an order ID')
    try:
        result = (track(args.app, args.order, args.timeout) if args.command == 'track' else
                  orders(args.app, 'minutes' if args.minutes else args.service, args.page, args.timeout))
    except OrderError as exc:
        result = {'ok': False, 'app': args.app, 'order': args.order, 'status': 'unknown',
                  'error': str(exc), 'eta': None, 'rider': None}
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
