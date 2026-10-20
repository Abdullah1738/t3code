"""Authenticated read-only NowNow catalog, using the app's captured endpoint."""
import argparse
import json
import time
from urllib.parse import urlencode, urlsplit
from native import load, get, verify_home, base, NativeError
from common import item_matches, money
from catalog_schema import image

HOST = 'api-app-fd.noon.com'
PATH = '/_svc/mp-shop-api-ctnoon/v2/content/search'
TEMPLATE = 'GET ' + HOST + PATH


def status_fields(store):
    op = store.get('operationality') or {}
    code = op.get('operationalStatusCode')
    operational = op.get('isOperational')
    schedule = op.get('schedule') or {}
    scheduling = store.get('schedulingInfo') or {}
    # Slots also exist for open stores: their presence alone is not scheduled-only.
    scheduled = scheduling.get('title', '').lower().startswith('schedule your order')
    if operational is True and code in ('open', 'always_open') and not scheduled:
        status = 'open'
    elif code == 'closed' or operational is False:
        status = 'closed'
    elif scheduled:
        status = 'scheduled_only'
    else:
        status = 'unknown'
    return {'status': status, 'is_open': status == 'open',
            'status_source': 'native_store.operationality', 'status_code': code,
            'status_message': op.get('operationalMsg'),
            'status_description': ('Open now' if status == 'open' else op.get('operationalMsg') or status) + ('; scheduled delivery only' if scheduled and status != 'open' else ''),
            'opens_at': schedule.get('activatesAt'), 'timezone': 'Asia/Dubai',
            'scheduled_only': scheduled and status != 'open',
            'scheduling_available': bool(scheduling.get('slots')),
            'delivery_mode': 'now' if status == 'open' else 'scheduled_only' if scheduled else 'unavailable' if status == 'closed' else 'unknown',
            'delivery_message': scheduling.get('title')}


def parse_results(data, query, open_only=False):
    if not isinstance(data.get('results'), list):
        raise NativeError('SCHEMA_CHANGED', 'NowNow catalog results schema changed.')
    stores = []
    for row in data['results']:
        s = row.get('storeDetails')
        if not isinstance(s, dict) or not s.get('storeCode'):
            continue
        status = status_fields(s)
        if open_only and not status['is_open']:
            continue
        items = []
        seen = set()
        for p in row.get('products') or []:
            name = p.get('name') or ''
            pid = p.get('productCode')
            if not pid or pid in seen or not item_matches(query, name):
                continue
            price = money(p.get('discountedPrice') if p.get('discountedPrice') is not None else p.get('price'))
            if price is None:
                continue
            seen.add(pid)
            items.append({'id': pid, 'name': name, 'price': price, 'currency': 'AED',
                          'image_url': image(p.get('images'), 'https://f.nooncdn.com/nownow/'),
                          'description': p.get('productDesc'),
                          'buyable': False if p.get('isOos') is True else None,
                          'size': ' '.join(str(v) for v in [p.get('size'), p.get('sizeUnit')] if v),
                          'availability': 'out_of_stock' if p.get('isOos') is True else 'available' if p.get('isOos') is False else 'unknown'})
        if items:
            stores.append({'store_id': s['storeCode'], 'store': s.get('name'), 'area': s.get('areaName'),
                           **status, 'eta': str(s['estimatedDeliveryTime'])+' mins' if status['is_open'] and s.get('estimatedDeliveryTime') else None,
                           'delivery_fee': money(s.get('deliveryFee')), 'items': items})
    return stores


def search(query, limit=10, page=1, timeout=20, open_only=False):
    if not query.strip() or not 1 <= limit <= 100 or page < 1:
        raise NativeError('USAGE', 'Provide a query, limit 1–100 and page >= 1.')
    t = (load('nownow') or {}).get('templates', {}).get(TEMPLATE)
    if not t:
        raise NativeError('NATIVE_CAPTURE_REQUIRED', 'Capture a NowNow search from the logged-in phone.')
    u = urlsplit(t['url'])
    if (u.scheme, u.hostname, u.path, t.get('method')) != ('https', HOST, PATH, 'GET'):
        raise NativeError('NATIVE_CAPTURE_REQUIRED', 'NowNow capture is not a verified search request.')
    headers = {k: v for k, v in t['headers'].items() if k.lower() not in
               ('accept-encoding', 'content-length', 'host', 'connection', 'sentry-trace', 'baggage')}
    location = verify_home(headers, timeout)
    params = {'q': query, 'type': 'grouped_product', 'limit': limit, 'page': page, 'f[collapse_by_merchant]': 1}
    data = get('https://' + HOST + PATH + '?' + urlencode(params), headers, timeout)
    result = base('noon-nownow', query, location)
    result.update(stores=parse_results(data, query, open_only),
                  page=page, pages=data.get('nbPages'), open_only=open_only,
                  scope='one native result page; up to 10 matching products per store; merchant-collapsed',
                  truncated=(data.get('nbPages') or 0) > page,
                  notes=['Open filter retains only explicitly operational immediate-delivery stores on the fetched page.',
                         'Closed stores can offer scheduled delivery; opens_at is local Asia/Dubai time.',
                         'Store status and product stock are distinct; neither guarantees checkout.'])
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('query'); p.add_argument('--limit', type=int, default=10)
    p.add_argument('--page', type=int, default=1); p.add_argument('--timeout', type=int, default=20)
    p.add_argument('--open', action='store_true')
    o = p.parse_args(); start = time.monotonic()
    try:
        d = search(o.query, o.limit, o.page, o.timeout, o.open)
        d['elapsed_seconds'] = round(time.monotonic()-start, 2)
        print(json.dumps(d))
    except NativeError as e:
        print(json.dumps({'ok': False, 'error': {'code': e.code, 'message': e.message}}))
        raise SystemExit(1)
