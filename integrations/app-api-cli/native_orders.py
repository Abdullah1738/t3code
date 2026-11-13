"""Read-only order projections. Never expose raw responses or payment metadata.

Noon routes were found in the installed APK and replay-verified on 2026-10-04.
Talabat tracking uses a separately verified account; catalog credentials remain guests.
Careem order credentials are not yet captured.
Talabat --ui is an explicit opt-in to the separate original-phone UI reader.
"""
import argparse
import datetime as dt
import gzip
import json
import re
import subprocess
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


def orders(app, service='all', page=1, timeout=10, pages=1, limit=20, with_addresses=False):
    if app == 'talabat':
        from talabat_http_list import list_orders
        from talabat_http_orders import TalabatError
        try:
            return list_orders(page=page - 1, pages=pages, limit=limit, timeout=timeout,
                               **({'with_addresses': True} if with_addresses else {}))
        except TalabatError as exc:
            raise OrderError(str(exc)) from None
    if app != 'noon':
        raise OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY')
    from noon_http_orders import orders as noon_orders, NoonError
    try:
        if service in {'food', 'nownow'}:
            if page != 1:
                raise OrderError(service.upper() + '_PAGINATION_NOT_VERIFIED')
            from noon_vertical_reads import food_orders, nownow_orders
            return (food_orders if service == 'food' else nownow_orders)(timeout)
        return noon_orders(service, page, timeout)
    except NoonError as exc:
        raise OrderError(str(exc)) from None


def track(app, order, timeout=10):
    if not re.fullmatch(r'[A-Za-z0-9]{1,64}', order):
        raise OrderError('INVALID_ORDER_ID')
    if app == 'talabat':
        from talabat_http_orders import track as talabat_track, TalabatError
        try:
            return talabat_track(order, timeout)
        except TalabatError as exc:
            raise OrderError(str(exc)) from None
    if app != 'noon':
        raise OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY')
    from noon_http_orders import track as noon_track, NoonError
    try:
        if order.startswith('F'):
            from noon_vertical_reads import track as vertical_track
            return vertical_track(order, 'food', timeout)
        if order.startswith('NN'):
            from noon_vertical_reads import track as vertical_track
            return vertical_track(order, 'nownow', timeout)
        if order.startswith('N'):
            return noon_marketplace_track(order, timeout)
        return noon_track(order, timeout)
    except NoonError as exc:
        raise OrderError(str(exc)) from None


def _noon_manifest_conflict(scoped, manifest):
    """Every observed identity and explicit current state must agree."""
    from noon_http_orders import marketplace_stage
    item_shipments = {item['item_id']: item['shipment_id'] for item in manifest['items']}
    shipment_ids = set(item_shipments.values())
    records = [scoped, *scoped.get('items', []), *scoped.get('shipments', [])]
    for part in records:
        if (part.get('status') not in (None, 'unknown', 'delivered')
                or (part.get('raw_status') is not None and marketplace_stage(part['raw_status'])!='delivered')
                or {'card_status_conflict', 'timeline_status_conflict'}.intersection(part.get('warnings', []))):
            return True
        observed_items = set(part.get('item_ids') or [])
        if part.get('item_id'):
            observed_items.add(part['item_id'])
        sid = part.get('shipment_id')
        if (not observed_items <= item_shipments.keys()
                or (sid and sid not in shipment_ids)
                or (sid and any(item_shipments[iid] != sid for iid in observed_items))):
            return True
    return False


def noon_marketplace_track(order, timeout):
    """Preserve scoped evidence; whole delivery needs a reconciled full manifest."""
    import noon_http_orders as core
    import noon_vertical_reads as vertical
    deadline = core.operation_deadline(timeout)
    scoped = manifest = None
    failures = []
    try:
        core.remaining(deadline)
        scoped = core.track(order, timeout, deadline=deadline)
    except core.NoonError as exc:
        failures.append('scoped_' + str(exc))
    try:
        core.remaining(deadline)
        candidate = vertical.track(order, 'marketplace', timeout, deadline=deadline)
        # Accept manifest proof only within the original budget, including the
        # return boundary. A late manifest must not erase earlier scoped reads.
        core.remaining(deadline)
        manifest = candidate
    except core.NoonError as exc:
        failures.append('manifest_' + str(exc))
    if scoped is None and manifest is None:
        raise core.NoonError('MARKETPLACE_READS_FAILED')
    out = dict(scoped or manifest)
    out.setdefault('whole_order_complete', False)
    if manifest:
        out.update({k: manifest[k] for k in ('manifest_complete', 'manifest_source',
                   'manifest_item_count', 'observed_item_count') if k in manifest})
        out['manifest_items'] = manifest.get('items', [])
        parts = list(out.get('shipments', []))
        known = {(p.get('scope'), p.get('item_id'), p.get('shipment_id')) for p in parts}
        for item in manifest.get('items', []):
            key = (item.get('scope'), item.get('item_id'), item.get('shipment_id'))
            if key not in known:
                parts.append(item)
                known.add(key)
        out['shipments'] = parts
        out['status']=core.marketplace_active_stage(p.get('status','unknown') for p in parts)
        raw_states={p.get('raw_status') for p in parts}
        out['raw_status']=next(iter(raw_states)) if len(raw_states)==1 else None
        active=[p for p in parts if p.get('status') not in ('delivered','cancelled')]
        estimates=[]
        for part in active:
            candidates=[p['eta'] for p in parts if p.get('eta') and (
                p is part or part.get('item_id') and p.get('item_id')==part['item_id']
                or part.get('shipment_id') and p.get('shipment_id')==part['shipment_id'])]
            if not candidates:break
            estimates.append(max(candidates))
        if not active or len(estimates)!=len(active):
            out.update(eta=None,eta_text=None,eta_source=None)
            out.pop('eta_relative_minutes',None)
        else:
            out['eta']=max(estimates)
        if (manifest.get('manifest_complete') is True and manifest.get('whole_order_complete') is True
                and manifest.get('status')=='cancelled'):
            # Full exact cancellation is authoritative over cached processing cards.
            out.update(status='cancelled',raw_status='cancelled',whole_order_complete=True,scope='order',
                       eta=None,eta_text=None,eta_source=None,rider=None,coverage=manifest['coverage'],
                       terminal_evidence=manifest['terminal_evidence'])
        if (manifest.get('manifest_complete') is True and manifest.get('whole_order_complete') is True
                and manifest.get('status') == 'delivered'):
            if _noon_manifest_conflict(scoped or {}, manifest):
                failures.append('MANIFEST_SCOPED_EVIDENCE_CONFLICT')
                out.update(status='unknown', whole_order_complete=False)
            else:
                out.update(status='delivered', whole_order_complete=True, scope='order',
                           eta=None, eta_text=None, eta_source=None, rider=None,
                           coverage=manifest['coverage'])
    out['warnings'] = list(dict.fromkeys(out.get('warnings', []) + failures))
    out['partial'] = bool(out.get('partial') or failures)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', choices=['noon', 'talabat', 'careem'])
    parser.add_argument('command', choices=['orders', 'track'])
    parser.add_argument('order', nargs='?')
    parser.add_argument('--minutes', action='store_true')
    parser.add_argument('--service', choices=['all', 'minutes', 'marketplace', 'food', 'nownow'], default='all')
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--pages', type=int, default=1, help='Talabat HTTP listing: bounded page count (1..5)')
    parser.add_argument('--limit', type=int, default=20, help='Talabat HTTP listing: maximum rows (1..375)')
    parser.add_argument('--with-addresses', action='store_true', help='Talabat listing: include exact delivery addresses')
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--ui', action='store_true', help='Talabat only: opt-in original-phone UI read; takes the UI lock')
    args = parser.parse_args(argv)
    if args.timeout is None:
        args.timeout = 45 if args.ui else 10
    max_timeout = 60 if args.ui else 30
    if not 1 <= args.page <= 100 or not 1 <= args.timeout <= max_timeout:
        parser.error(f'page must be 1..100 and timeout 1..{max_timeout}')
    if not 1 <= args.pages <= 5 or not 1 <= args.limit <= 375:
        parser.error('pages must be 1..5 and limit 1..375')
    if (args.pages != 1 or args.limit != 20) and (args.app != 'talabat' or args.command != 'orders' or args.ui):
        parser.error('--pages/--limit apply only to Talabat HTTP orders')
    if args.with_addresses and (args.app != 'talabat' or args.command != 'orders' or args.ui):
        parser.error('--with-addresses applies only to Talabat HTTP orders')
    if args.command == 'track' and not args.order:
        parser.error('track requires an order ID')
    if args.ui:
        if args.app != 'talabat' or args.page != 1 or args.minutes or args.service != 'all':
            parser.error('--ui supports Talabat visible orders or tracking only')
        cmd = [str(Path.home() / '.local/android/venv/bin/python'),
               str(Path(__file__).with_name('talabat_ui_orders.py')), args.command]
        if args.order:
            cmd.append(args.order)
        cmd += ['--timeout', str(args.timeout)]
        try:
            child = subprocess.run(cmd, capture_output=True, text=True, timeout=args.timeout + 5)
            result = json.loads(child.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            result = {'ok': False, 'app': args.app, 'order': args.order, 'source': 'android_ui',
                      'status': 'unknown', 'error': 'UI_WORKER_FAILED', 'eta': None, 'rider': None}
        print(json.dumps(result, indent=2))
        return 0 if result.get('ok') else 1
    try:
        result = (track(args.app, args.order, args.timeout) if args.command == 'track' else
                  orders(args.app, 'minutes' if args.minutes else args.service, args.page, args.timeout,
                         args.pages, args.limit, args.with_addresses))
    except OrderError as exc:
        result = {'ok': False, 'app': args.app, 'order': args.order, 'status': 'unknown',
                  'error': str(exc), 'eta': None, 'rider': None}
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
