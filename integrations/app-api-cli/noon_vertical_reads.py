"""Additional verified native reads; no account, cart or order mutations.

Food and NowNow tracking are exact-order. Marketplace completion requires the
exact full-detail inventory to reconcile with its independent invoice count.
"""
import http.client
import datetime as dt
import json
import re
import urllib.error
import urllib.request
import zlib

import noon_http_orders as core

NoonError = core.NoonError
FOOD_ORDER = re.compile(r'F[A-Z0-9]{1,63}')
NOWNOW_ORDER = re.compile(r'NN[A-Z0-9]{1,62}')
MARKETPLACE_ORDER = re.compile(r'N(?!N)[A-Z0-9]{1,63}')
NOWNOW_STAGES = {'delivered': 'delivered', 'canceled': 'cancelled'}


def _deadline(timeout, deadline=None):
    return core.operation_deadline(timeout, deadline)


def _headers(service, deadline):
    with core.read_deadline(deadline):
        if service == 'nownow':
            try:
                saved = core.load('nownow')
                headers = saved['templates']['GET api-app-fd.noon.com/_svc/mp-shop-api-ctnoon/v2/content/search']['headers']
            except NoonError:
                raise
            except Exception:
                raise NoonError('ACCOUNT_CAPTURE_REQUIRED') from None
            if not isinstance(headers, dict) or not headers or not all(
                    isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
                raise NoonError('ACCOUNT_HEADERS_INVALID')
            headers = {k.lower(): v for k, v in headers.items() if k.lower() not in {
                'host', 'content-length', 'accept-encoding', 'connection', 'if-none-match',
                'if-modified-since', 'baggage', 'sentry-trace'}}
        else:
            headers = core.session('marketplace')
    if service == 'food':
        headers.update({'x-mp': 'food', 'x-experience': 'food'})
    core.verify_home(core.request('whoami', headers, deadline), headers)
    if service == 'nownow':
        # NNMPBaseUrl.getUrl: selected address key, first '-' replaced by ':'.
        headers['x-address-key'] = headers['x-addresskey'].replace('-', ':', 1)
    return headers


def _read(route, headers, deadline, order=None):
    """Literal read allowlist; arbitrary URLs, payloads and redirects forbidden."""
    body = None
    if route == 'marketplace_manifest' and isinstance(order, str) and MARKETPLACE_ORDER.fullmatch(order):
        host, path = 'api-app.noon.com', '/_svc/order-v2/order/' + order
    elif route == 'food_track' and isinstance(order, str) and FOOD_ORDER.fullmatch(order):
        host, path = 'api-app-fd.noon.com', '/_svc/mp-food-api-mpnoon/order/tracking/' + order + '/info'
    elif route == 'food_orders' and order is None:
        host, path = 'api-app-fd.noon.com', '/_svc/mp-food-api-mpnoon/order/orders'
        body = b'{}'
    elif route in ('nownow_track', 'nownow_detail') and isinstance(order, str) and NOWNOW_ORDER.fullmatch(order):
        host = 'api-app-fd.noon.com'
        path = '/_svc/mp-shop-api-mpnoon/v1/order/'
        if route == 'nownow_track':
            path += 'tracking/' + order
        else:
            path += 'details'
            body = json.dumps({'orderNr': order}).encode()
    elif route == 'nownow_orders' and order is None:
        host, path = 'api-app-fd.noon.com', '/_svc/mp-shop-api-mpnoon/v1/order/history'
        body = b'{}'
    else:
        raise NoonError('ENDPOINT_OR_ORDER_DENIED')
    headers = dict(headers)
    headers.update({'content-type': 'application/json', 'accept': 'application/json', 'accept-encoding': 'identity'})
    try:
        req = urllib.request.Request('https://' + host + path, headers=headers,
                                     method='POST' if body is not None else 'GET', data=body)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), core.NoRedirect())
        with core.read_deadline(deadline) as left:
            with opener.open(req, timeout=left) as response:
                raw = response.read(core.MAX_BYTES + 1)
            if len(raw) > core.MAX_BYTES:
                raise NoonError('RESPONSE_TOO_LARGE')
            if raw[:2] == b'\x1f\x8b':
                decoder = zlib.decompressobj(31)
                raw = decoder.decompress(raw, core.MAX_BYTES + 1)
                if len(raw) > core.MAX_BYTES or decoder.unconsumed_tail:
                    raise NoonError('RESPONSE_TOO_LARGE')
                if not decoder.eof:
                    raise NoonError('NATIVE_READ_FAILED')
            data = json.loads(raw, object_pairs_hook=_unique_object)
            if not isinstance(data, dict):
                raise NoonError('SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        raise NoonError({401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 404: 'ORDER_NOT_FOUND',
                         429: 'RATE_LIMITED'}.get(code, 'HTTP_' + str(code))) from None
    except TimeoutError:
        raise NoonError('NATIVE_READ_TIMEOUT') from None
    except (urllib.error.URLError, http.client.HTTPException, ValueError, OSError, zlib.error):
        raise NoonError('NATIVE_READ_FAILED') from None


def _unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise NoonError('DUPLICATE_JSON_KEY')
        out[key] = value
    return out


def _food_data(data):
    if data.get('status') != 'success' or not isinstance(data.get('data'), dict):
        raise NoonError('SCHEMA_CHANGED')
    return data['data']


def food_projection(data, order):
    row = _food_data(data)
    raw = row.get('status')
    if row.get('orderNr') != order or not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    out = core.base(order, 'food')
    out.update(raw_status=raw, status={'delivered': 'delivered', 'delivering': 'out for delivery',
                                     'picked_up': 'picked up'}.get(raw, 'unknown'),
               scope='order', status_text=core.text(row.get('statusLabel')),
               coverage='exact_native_food_order; delivered_delivering_picked_up_verified')
    estimate = row.get('estimate')
    if isinstance(estimate, dict):
        window = estimate.get('time')
        timestamp = estimate.get('timestamp')
        if isinstance(window, str) and isinstance(timestamp, str):
            match = re.fullmatch(r'(\d{2}:\d{2} [AP]M) - (\d{2}:\d{2} [AP]M)', window)
            if match:
                try:
                    anchor = dt.datetime.fromisoformat(timestamp)
                    anchor = anchor.replace(tzinfo=core.DUBAI) if anchor.tzinfo is None else anchor.astimezone(core.DUBAI)
                    start = dt.datetime.combine(anchor.date(), dt.datetime.strptime(match[1], '%I:%M %p').time(), core.DUBAI)
                    end = dt.datetime.combine(anchor.date(), dt.datetime.strptime(match[2], '%I:%M %p').time(), core.DUBAI)
                    if end < start:
                        end += dt.timedelta(days=1)
                    if start == anchor and dt.timedelta(0) <= end-start <= dt.timedelta(hours=4):
                        out.update(eta=end.isoformat(), eta_text=window,
                                   eta_window={'start': start.isoformat(), 'end': end.isoformat()},
                                   eta_source='native_food_tracking_estimate')
                except ValueError:
                    pass
    # Delivered responses still include driver contact and coordinates. No
    # display-consent gate or active ETA contract has been verified: omit both.
    return out


def manifest_projection(data, order):
    if data.get('orderNr') != order:
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    groups = data.get('itemGroups')
    if not isinstance(groups, list) or not groups:
        raise NoonError('INCOMPLETE_MANIFEST')
    items, seen = [], set()
    for group in groups:
        if not isinstance(group, dict) or group.get('orderNr') != order:
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        if not {'itemNr', 'shipmentNr', 'items', 'subStatus'} <= set(group):
            raise NoonError('INCOMPLETE_MANIFEST')
        rows = group.get('items')
        status = group.get('subStatus')
        if not isinstance(rows, list) or not rows or not isinstance(status, dict):
            raise NoonError('INCOMPLETE_MANIFEST')
        raw = status.get('highStatusCode')
        if not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
            raise NoonError('SCHEMA_CHANGED')
        for row in rows:
            if not isinstance(row, dict):
                raise NoonError('INCOMPLETE_MANIFEST')
            item, shipment, qty = row.get('itemNr'), row.get('shipmentNr'), row.get('quantity')
            if (not isinstance(item, str) or not core.ITEM.fullmatch(item)
                    or core.ITEM.fullmatch(item)[1] != order or item in seen
                    or (shipment is not None and (not isinstance(shipment, str)
                        or not core.SHIPMENT.fullmatch(shipment) or core.SHIPMENT.fullmatch(shipment)[1] != order))
                    or type(qty) is not int or qty < 1):
                raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
            group_shipment = group.get('shipmentNr')
            # Rocket (supermall) orders bind the shipment at the group level
            # while a fresh item row may omit it, and vice versa: inherit the
            # present side instead of failing the whole order. Both set but
            # different stays a mismatch, and an inherited id from another
            # order is rejected above.
            if shipment is None and group_shipment is not None:
                if (not isinstance(group_shipment, str) or not core.SHIPMENT.fullmatch(group_shipment)
                        or core.SHIPMENT.fullmatch(group_shipment)[1] != order):
                    raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
                shipment = group_shipment
            elif shipment is not None and group_shipment not in (None, shipment):
                raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
            if group.get('itemNr') not in (None, item):
                raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
            for key in ('status', 'subStatus'):
                if key in row and (not isinstance(row[key], dict) or row[key].get('highStatusCode') != raw):
                    raise NoonError('CONFLICTING_ITEM_STATUS')
            for key in ('statusCode', 'highStatusCode', 'orderStatusCode'):
                if key in row and row[key] != raw:
                    raise NoonError('CONFLICTING_ITEM_STATUS')
            seen.add(item)
            items.append({'item_id': item, 'shipment_id': shipment, 'quantity': qty,
                          'raw_status': raw, 'status': core.MARKETPLACE_STAGES.get(raw, 'unknown'), 'scope': 'item'})
    count = _invoice_count(data.get('invoice'))
    # Quantity >1 and bundles have not been live-verified: require both unit and
    # line counts to reconcile, rather than choosing an unverified interpretation.
    complete = (count is not None and count == len(items) == sum(i['quantity'] for i in items)
                and _full_detail_shape(data)
                and all(i['shipment_id'] for i in items if i['raw_status'] == 'delivered')
                and not any(row.get('virtualBundleCode') for g in groups for row in g['items']))
    delivered = complete and all(i['status'] == 'delivered' for i in items)
    out = core.base(order, 'marketplace')
    out.update(items=items, manifest_source='native_order_detail_item_groups',
               manifest_complete=bool(complete), whole_order_complete=bool(delivered),
               status='delivered' if delivered else 'unknown', scope='order',
               manifest_item_count=count, observed_item_count=len(items),
               coverage='exact_order_detail_inventory; invoice_count_reconciled' if complete
                        else 'exact_order_detail_inventory; incomplete_or_unverified_count_contract')
    return out


def _invoice_count(invoice):
    if not isinstance(invoice, dict) or not isinstance(invoice.get('sections'), list) or not invoice['sections']:
        return None
    counts = []
    for section in invoice['sections']:
        if not isinstance(section, dict) or not isinstance(section.get('entries'), list) or not isinstance(section.get('groups'), list):
            return None
        entries = list(section['entries'])
        for group in section['groups']:
            if not isinstance(group, dict) or not isinstance(group.get('entries'), list):
                return None
            entries.extend(group['entries'])
        for entry in entries:
            if not isinstance(entry, dict):
                return None
            title = entry.get('title')
            if not isinstance(title, str) or not title.startswith('Subtotal'):
                continue
            match = re.fullmatch(r'Subtotal \(([1-9][0-9]{0,5}) items?\)', title)
            if not match:
                return None
            counts.append(int(match[1]))
    return counts[0] if len(counts) >= 2 and len(set(counts)) == 1 else None


def _full_detail_shape(data):
    required = {'orderNr', 'createdAt', 'invoice', 'shippingAddress', 'itemGroups',
                'trackActions', 'shippingPreferences', 'metadata', 'payment'}
    if (not required <= set(data) or not isinstance(data['createdAt'], str)
            or not data['createdAt'] or any(not isinstance(data[k], dict) for k in
                ('invoice', 'shippingAddress', 'trackActions', 'shippingPreferences', 'metadata', 'payment'))):
        return False
    # Exact order-detail is not paginated. Any newly exposed continuation or
    # truncation signal makes this contract unverified, even if counts match.
    for obj in (data, data['metadata']):
        if any(re.search(r'page(?!RefreshSec)|pagination|cursor|hasMore|partial|truncat|complete|total|count', k, re.I)
               for k in obj):
            return False
    return True


def _nownow_data(data):
    if not isinstance(data.get('data'), dict) or data.get('status') not in (None, 'success'):
        raise NoonError('SCHEMA_CHANGED')
    return data['data']


def nownow_projection(detail, tracking, order):
    row, state = _nownow_data(detail), _nownow_data(tracking)
    if row.get('orderNr') != order:
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    if state.get('orderNr') not in (None, order):
        raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    raw = row.get('orderStatusCode')
    if not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
        raise NoonError('SCHEMA_CHANGED')
    agreement = all(value == raw for value in (row.get('logisticsStatusCode'),
                    row.get('customerStatusCode'), state.get('status'), state.get('orderStatusCode')))
    out = core.base(order, 'nownow')
    out.update(raw_status=raw, status=NOWNOW_STAGES.get(raw, 'unknown') if agreement else 'unknown',
               scope='order', status_agreement=agreement,
               coverage='exact_native_nownow_detail_and_tracking; delivered_canceled_verified')
    return out


def track(order, service, timeout=10, *, deadline=None):
    deadline = _deadline(timeout, deadline)
    valid = isinstance(order, str) and ((service == 'food' and FOOD_ORDER.fullmatch(order))
            or (service == 'marketplace' and MARKETPLACE_ORDER.fullmatch(order))
            or (service == 'nownow' and NOWNOW_ORDER.fullmatch(order)))
    if not valid:
        raise NoonError('UNSUPPORTED_VERTICAL_OR_INVALID_ORDER')
    headers = _headers(service, deadline)
    if service == 'nownow':
        detail = _read('nownow_detail', headers, deadline, order)
        # Tracking does not echo orderNr. Exact-ID detail is mandatory and its
        # three current status fields must agree with the tracking resource.
        if _nownow_data(detail).get('orderNr') != order:
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        out = nownow_projection(detail, _read('nownow_track', headers, deadline, order), order)
    else:
        data = _read('food_track' if service == 'food' else 'marketplace_manifest', headers, deadline, order)
        out = food_projection(data, order) if service == 'food' else manifest_projection(data, order)
    out.update(account_verified=True, saved_home_verified=True)
    core.remaining(deadline)
    return out


def food_orders(timeout=10):
    deadline = _deadline(timeout)
    headers = _headers('food', deadline)
    data = _food_data(_read('food_orders', headers, deadline))
    if not isinstance(data.get('orders'), list):
        raise NoonError('SCHEMA_CHANGED')
    rows, seen = [], set()
    for row in data['orders']:
        if not isinstance(row, dict):
            raise NoonError('SCHEMA_CHANGED')
        order, raw = row.get('orderNr'), row.get('orderStatusCode')
        if (not isinstance(order, str) or not FOOD_ORDER.fullmatch(order) or order in seen
                or not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw)):
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        seen.add(order)
        out = core.base(order, 'food', True)
        delivered = raw == 'delivered' and row.get('isDelivered') is True and row.get('logisticsStatusCode') == 'delivered'
        out.update(raw_status=raw, status='delivered' if delivered else 'unknown', scope='order',
                   coverage='native_food_default_list_page')
        rows.append(out)
    core.remaining(deadline)
    return {'ok': True, 'app': 'noon', 'source': 'native_order_api', 'orders': rows,
            'coverage': {'food': {'default_page_only': True, 'exhaustive': False,
                                  'reported_pages': data.get('pages') if type(data.get('pages')) is int else None}}}


def nownow_orders(timeout=10):
    deadline = _deadline(timeout)
    headers = _headers('nownow', deadline)
    data = _nownow_data(_read('nownow_orders', headers, deadline))
    if not isinstance(data.get('orders'), list):
        raise NoonError('SCHEMA_CHANGED')
    rows, seen = [], set()
    for row in data['orders']:
        if not isinstance(row, dict):
            raise NoonError('SCHEMA_CHANGED')
        order = row.get('orderNr')
        if not isinstance(order, str) or not NOWNOW_ORDER.fullmatch(order) or order in seen:
            raise NoonError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
        seen.add(order)
        raw = row.get('orderStatusCode')
        if not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
            raise NoonError('SCHEMA_CHANGED')
        agreement = row.get('logisticsStatusCode') == raw == row.get('customerStatusCode')
        out = core.base(order, 'nownow', True)
        out.update(raw_status=raw, status=NOWNOW_STAGES.get(raw, 'unknown') if agreement else 'unknown',
                   scope='order', coverage='native_nownow_default_list_page')
        rows.append(out)
    core.remaining(deadline)
    return {'ok': True, 'app': 'noon', 'source': 'native_order_api', 'orders': rows,
            'coverage': {'nownow': {'default_page_only': True, 'exhaustive': False,
                                  'reported_pages': data.get('pages') if type(data.get('pages')) is int else None}}}
