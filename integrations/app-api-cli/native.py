"""Read-only native noon search using the logged-in phone session held in macOS Keychain.

Sections (all authenticated, saved Home verified via whoami on every call):
  noon        noon.com / supermall marketplace search, with delivery estimate and Rocket flag
  minutes     noon Minutes quick-commerce search (warehouse scoped to saved Home)
  food        noon Food restaurant + dish search (api-app-fd)
  food-menu   noon Food outlet menu (by outlet code)
  food-match  noon Food outlets whose menu item names match EVERY term
"""
import argparse
import concurrent.futures as cf
import datetime
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent/'capture'))
sys.path.insert(0, str(Path(__file__).parent))
from keychain import load
from common import clean_name, money, eta_range, item_matches, relevance

ALLOWED = {
    ('api-app.noon.com', '/_svc/catalog/api/v3/u/search'),
    ('api-app-instant.noon.com', '/_svc/catalog/search'),
    ('api-app-st.noon.com', '/_vs/st/st-whoami-api/whoami'),
    ('api-app-fd.noon.com', '/_svc/mp-food-api-catalog/api/suggestions'),
    ('api-app-fd.noon.com', '/_svc/mp-shop-api-ctnoon/v2/content/search'),
}
ALLOWED_POST = {('api-app-fd.noon.com', '/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details')}
FOOD_IMG = 'https://f.nooncdn.com/'


class NativeError(Exception):
    def __init__(self, code, message): self.code, self.message = code, message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None


def call(url, headers, timeout, body=None):
    u = urllib.parse.urlsplit(url)
    ok = ALLOWED_POST if body is not None else ALLOWED
    if u.scheme != 'https' or u.port or u.username or u.password or (u.hostname, u.path) not in ok:
        raise NativeError('ENDPOINT_DENIED', 'Native transport only permits verified search, menu and identity reads.')
    # No environment proxy, redirects, logging, disk cookie jar or raw response output.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    h = dict(headers)
    if body is not None:
        h['content-type'] = 'application/json'
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers=h, method='POST' if body is not None else 'GET',
                                         data=json.dumps(body).encode() if body is not None else None)
            with opener.open(req, timeout=timeout) as r:
                raw = r.read()
            if raw[:2] == b'\x1f\x8b':
                raw = gzip.decompress(raw)
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt == 0:
                time.sleep(1.2)
                continue
            raise NativeError('AUTH_EXPIRED' if e.code in [401, 403] else f'HTTP_{e.code}',
                              'Native API rejected the request. Re-capture the logged-in phone search session.') from None
        except Exception:
            if attempt == 0:
                continue
            raise NativeError('NATIVE_NETWORK_ERROR', 'Native API request failed or timed out.') from None


def get(url, headers, timeout):
    return call(url, headers, timeout)


def session(mode):
    saved = load('minutes' if mode == 'minutes' else 'noon')
    if not saved:
        raise NativeError('NATIVE_CAPTURE_REQUIRED', 'No native session in Keychain. Capture a search from the logged-in phone first, or use --web.')
    headers = {k: v for k, v in saved['headers'].items() if k.lower() not in [
        'accept-encoding', 'content-length', 'host', 'connection', 'sentry-trace', 'baggage']}
    return saved, headers


def verify_home(headers, timeout):
    identity = get('https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami', headers, timeout)
    if not identity.get('customer', {}).get('customerCode'):
        raise NativeError('AUTH_EXPIRED', 'The captured native login is no longer authenticated. Capture it again from the phone.')
    addresses = [e.get('selectedAddress') or {} for e in identity.get('experiences', [])]
    matching = [a for a in addresses if
                str(a.get('addressCode')) == headers.get('x-addresscode') and
                str(a.get('addressKey')) == headers.get('x-addresskey') and
                'banyan' in json.dumps(a).lower()]
    if not matching:
        raise NativeError('HOME_MISMATCH', 'Captured native address is not verified as saved Banyantree. Select saved Home in the app and capture again.')
    a = matching[0]
    return {'name': 'BanyanTree Hillside - Flat 2104', 'source': 'captured_saved_address', 'saved_address_verified': True,
            'latitude': a.get('lat') / 1e7 if a.get('lat') else None, 'longitude': a.get('lng') / 1e7 if a.get('lng') else None}


def base(mode, query, location):
    return {'ok': True, 'source': 'native_android_api', 'service': mode, 'query': query,
            'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'account': {'authenticated': True, 'scope': 'captured_android_session',
                        'benefits_context': 'native_session; checkout-only benefits not calculated'},
            'location': location, 'fallbacks': []}


def strip_html(s):
    return re.sub(r'<[^>]*>', '', str(s or '')).strip() or None


def search(mode, query, limit, page, timeout, rocket=False):
    saved, headers = session(mode)
    location = verify_home(headers, timeout)
    if mode == 'noon':
        headers = dict(headers, **{'x-mp': 'noon', 'x-experience': 'rocket' if rocket else 'ecom'})
    u = urllib.parse.urlsplit(saved['url'])
    expected = ('api-app-instant.noon.com', '/_svc/catalog/search') if mode == 'minutes' else ('api-app.noon.com', '/_svc/catalog/api/v3/u/search')
    if (u.hostname, u.path) != expected:
        raise NativeError('NATIVE_CAPTURE_REQUIRED', 'Keychain entry is not a verified product-search request. Capture a submitted search again.')
    params = {'q': query, 'page': page, 'rows' if mode == 'minutes' else 'limit': limit if not rocket else max(limit * 3, 30), 'productsOnly': '1'}
    data = get(urllib.parse.urlunsplit(('https', u.netloc, u.path, urllib.parse.urlencode(params), '')), headers, timeout)
    if not isinstance(data.get('hits'), list):
        raise NativeError('SCHEMA_CHANGED', 'The native search response format changed.')
    rows = []
    for p in data['hits']:
        name = p.get('title') or p.get('name') or ''
        brand = p.get('brand') or ''
        if brand and not name.lower().startswith(brand.lower()): name = brand + ' ' + name
        sale = next((p[k] for k in ['offerPrice', 'offer_price', 'salePrice', 'sale_price'] if p.get(k) is not None), None)
        regular = p.get('price')
        flags = p.get('flags') or []
        is_rocket = isinstance(flags, list) and 'rocket' in flags
        rk = p.get('rocket') if is_rocket and isinstance(p.get('rocket'), dict) else {}
        from catalog_schema import image
        row = {'id': p.get('sku'), 'name': clean_name(name), 'size': p.get('sizeInfo', p.get('size_info')),
               'image_url': image(p, 'https://f.nooncdn.com/p/'),
               'price': money(sale if sale is not None else regular), 'regular_price': money(regular), 'currency': 'AED',
               'buyable': p.get('isBuyable', p.get('is_buyable')),
               'max_quantity': p.get('maxQty', p.get('max_qty')),
               'unavailable_reason': p.get('notBuyableReason', p.get('not_buyable_reason')),
               'seller': p.get('store_name')}
        if mode == 'noon':
            row.update(sku_config=p.get('sku_config'), offer_code=p.get('offer_code'),
                       is_rocket=is_rocket, eta=strip_html(p.get('estimated_delivery_date')),
                       rocket_eta=strip_html(rk.get('estimation_text')) if rk else None,
                       rocket_price=money(rk.get('sale_price') or rk.get('price')) if rk else None,
                       express='fbn' in flags or 'rocket' in flags, rating=(p.get('product_rating') or {}).get('value'))
        else:
            row['eta'] = None
        rows.append(row)
    fetched_count = len(rows)
    rows = [r for r in rows if item_matches(query, r['name'])]
    if rocket:
        rows = [r for r in rows if r.get('is_rocket')]
    result = base(mode, query, location)
    result.update({'items': rows[:limit], 'total': data.get('nbHits'), 'pages': data.get('nbPages'), 'page': page,
                   'fetched_count': fetched_count, 'unrelated_removed': fetched_count-len(rows),
                   'warehouse': data.get('whCode'),
                   'notes': ['Credentials read from macOS Keychain at runtime. Phone, browser and proxy are not needed.',
                             'max_quantity is an order cap, not remaining stock.'] +
                            (['eta is the per-offer delivery estimate; rocket_eta is the ~1 hr noon Rocket option when offered.'] if mode == 'noon' else
                             ['Minutes search does not include an ETA; null is intentional, not a current delivery estimate.'])})
    return result


# ----------------------------------------------------------------------------- food

def food_headers():
    _, headers = session('noon')
    h = dict(headers)
    h.update({'x-mp': 'food', 'x-experience': 'food'})
    return h


def outlet_row(o):
    from catalog_schema import image
    d = o.get('delivery') or {}
    status = o.get('operatingStatusCode')
    return {'id': o.get('outletCode'), 'name': clean_name(o.get('name')), 'cuisines': ', '.join(o.get('cuisines') or []),
            'rating': (o.get('rating') or {}).get('score'), 'status': 'open' if status == 'open' else (status or 'unknown'),
            'status_message': o.get('operatingMsg') or None,
            'eta': (d.get('time') + ' mins') if d.get('time') else None, 'delivery_fee': money(d.get('fee')),
            'delivery_fee_before_discount': money(d.get('originalFee')), 'min_order': money(d.get('minOrder')),
            'distance_km': money((o.get('distance') or 0) / 1000) if o.get('distance') else None,
            'offer': o.get('tag') or None, 'fee_source': 'native_account_search',
            'dishes': [{'id': x.get('itemCode'), 'name': clean_name(x.get('name')), 'price': money(x.get('price')),
                        'image_url': image(x, 'https://f.nooncdn.com/food_production/'),
                        'discount_price': money(x.get('discountPrice'))} for x in o.get('dishes') or []]}


def food_search(query, timeout, headers=None):
    headers = headers or food_headers()
    d = get('https://api-app-fd.noon.com/_svc/mp-food-api-catalog/api/suggestions?' + urllib.parse.urlencode({'q': query}), headers, timeout)
    if not isinstance(d.get('data'), list):
        raise NativeError('SCHEMA_CHANGED', 'noon Food search response changed.')
    out, seen = [], set()
    for x in d['data']:
        cands = [x] if x.get('type') == 'outlet' else [o for m in x.get('modules', []) for o in m.get('outlets', [])]
        for o in cands:
            if o.get('outletCode') and o['outletCode'] not in seen:
                seen.add(o['outletCode']); out.append(outlet_row(o))
    return out


def food_menu_raw(code, headers, timeout):
    d = call('https://api-app-fd.noon.com/_svc/mp-food-api-mpnoon/consumer/restaurant/outlet/details',
             headers, timeout, body={'outletCode': code, 'addressCode': headers.get('x-addresscode')})
    data = d.get('data') if isinstance(d, dict) else None
    if not isinstance(data, dict) or data.get('outletCode') != code:
        raise NativeError('SCHEMA_CHANGED', 'noon Food menu response changed or outlet mismatch.')
    menu = data.get('menu') or {}
    cats = {}
    for c in menu.get('categories') or []:
        if c.get('categoryType') == 'trending':
            continue
        for i in c.get('items') or []:
            cats.setdefault(i, clean_name(c.get('name')))
    items = []
    option_items = {i.get('itemCode'): i for i in menu.get('items') or []}
    modifiers = {g.get('modifierCode'): g for g in menu.get('modifiers') or []}

    def choices(codes, ancestors=()):
        groups = []
        for code in codes or []:
            if not isinstance(code, str) or code in ancestors or code not in modifiers:
                raise NativeError('SCHEMA_CHANGED', 'Invalid Food modifier reference.')
            group = modifiers[code]
            options = []
            for option in group.get('options') or []:
                item = option_items.get(option.get('itemCode'))
                if not item:
                    raise NativeError('SCHEMA_CHANGED', 'Missing Food option item.')
                options.append({'id': item['itemCode'], 'name': clean_name(item.get('name')),
                                'price': money(option.get('price')),
                                'available': not item.get('isOos'),
                                'default_quantity': option.get('defaultValue'),
                                'groups': choices(item.get('modifiers'), (*ancestors, code))})
            groups.append({'id': code, 'name': clean_name(group.get('name')),
                           'min': group.get('minTotalOptions'), 'max': group.get('maxTotalOptions'),
                           'max_per_option': group.get('maxSingleOption'),
                           'available': not group.get('isOos'), 'options': options})
        return groups
    for i in menu.get('items') or []:
        if i.get('itemType') not in (None, 'main'):
            continue
        from catalog_schema import image
        items.append({'id': i.get('itemCode'), 'name': clean_name(i.get('name')), 'description': (i.get('itemDesc') or '').strip(),
                       'image_url': image(i, 'https://f.nooncdn.com/food_production/'),
                      'category': cats.get(i.get('itemCode')) or None, 'price': money(i.get('price')),
                      'discount_price': money(i.get('discountPrice')) if i.get('discountPrice') not in (None, i.get('price')) else None,
                      'available': not i.get('isOos'), 'currency': 'AED',
                      'note_type': i.get('noteType'), 'max_quantity': i.get('maxQty'),
                      'choice_groups': choices(i.get('modifiers'))})
    status = data.get('operatingStatusCode')
    info = {'id': code, 'name': clean_name(data.get('name')), 'address': data.get('address'),
            'status': 'open' if status == 'open' and data.get('isAcceptingOrders') else ('not_accepting_orders' if status == 'open' else (status or 'unknown')),
            'status_message': strip_html(data.get('formattedOperatingStatusMsg')) or data.get('closeMsg') or None,
            'eta': (data.get('minutesToDeliver') + ' mins') if data.get('minutesToDeliver') else None,
            'delivery_fee': money(data.get('deliveryFee')), 'serviceable': data.get('isServiceable'),
            'distance': data.get('customerDistance'), 'rating': data.get('ratingScore'),
            'offers': [strip_html((x.get('generated') or {}).get('displayMessage')) for x in data.get('discounts') or []][:3],
            'source': 'native_account_outlet'}
    return info, items


def food_mode(mode, terms, limit, timeout, open_only=False, item_query=''):
    _, h0 = session('noon')
    location = verify_home(h0, timeout)
    headers = food_headers()
    query = ' '.join(terms)
    result = base('noon-' + mode, query, location)
    if mode == 'food':
        rows = food_search(query, timeout, headers)
        for r in rows:
            r['relevance'] = relevance(query, r['name'], r['cuisines'])
            r['dishes'] = [x for x in r['dishes'] if item_matches(query, x['name']) or relevance(query, x['name']) >= 2][:3]
        if open_only:
            rows = [r for r in rows if r['status'] == 'open']
        rows = [r for r in rows if r['relevance'] > 0 or r['dishes']]
        rows.sort(key=lambda r: (r['status'] != 'open', -(r['relevance'] > 0), (eta_range(r['eta']) or (999,))[0]))
        result.update(items=rows[:limit], fetched=len(rows))
    elif mode == 'food-menu':
        info, items = food_menu_raw(query, headers, timeout)
        if item_query:
            named = [dict(i, matched_on='name') for i in items if item_matches(item_query, i['name'], i['category'] or '')]
            ids = {i['id'] for i in named}
            desc = [dict(i, matched_on='description') for i in items if i['id'] not in ids and item_query.casefold() in i['description'].casefold()]
            items = named + desc
        result.update(restaurant=info, items=items[:limit], matching_items=len(items))
    else:
        cands, seen = [], set()
        for t in terms:
            for r in food_search(t, timeout, headers):
                if r['id'] not in seen:
                    seen.add(r['id']); cands.append(r)
        if open_only:
            cands = [r for r in cands if r['status'] == 'open']

        def one(r):
            try:
                return r, food_menu_raw(r['id'], headers, timeout)
            except NativeError:
                return r, None
        with cf.ThreadPoolExecutor(6) as ex:
            res = list(ex.map(one, cands))
        out, failed = [], 0
        for r, m in res:
            if not m:
                failed += 1; continue
            info, items = m
            if open_only and info['status'] != 'open':
                continue
            hits = {}
            for term in terms:
                found = [i for i in items if i['available'] and item_matches(term, i['name'])]
                named = [i for i in found if item_matches(term, i['name'], '')]
                pool = named or found
                if not pool:
                    break
                pool.sort(key=lambda i: i['price'] or 0)
                hits[term] = [{k: i[k] for k in ('id', 'name', 'price', 'discount_price', 'category', 'image_url', 'description')} for i in pool[:3]]
            else:
                out.append({'id': r['id'], 'name': info['name'] or r['name'], 'address': info['address'], 'status': info['status'],
                            'eta': info['eta'] or r['eta'], 'delivery_fee': info['delivery_fee'], 'rating': r['rating'],
                            'distance': info['distance'], 'offer': r['offer'], 'matches': hits})
        if cands and failed == len(cands):
            raise NativeError('MENUS_UNAVAILABLE', 'All candidate menus failed; no-match cannot be determined.')
        out.sort(key=lambda r: (r['status'] != 'open', (eta_range(r['eta']) or (999,))[0], -(r['rating'] or 0)))
        result.update(items=out[:limit], terms=terms, candidates_checked=len(cands), menus_failed=failed)
    result['notes'] = ['noon Food via the logged-in account (fees reflect the account, incl. noon One/VIP where shown).',
                       'Menu presence is not orderability.']
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['noon', 'minutes', 'doctor', 'food', 'food-menu', 'food-match'])
    p.add_argument('query', nargs='*', default=[])
    p.add_argument('--limit', type=int, default=10); p.add_argument('--page', type=int, default=1); p.add_argument('--timeout', type=int, default=20)
    p.add_argument('--open', dest='open_only', action='store_true'); p.add_argument('--rocket', action='store_true')
    p.add_argument('--query', dest='item_query', default='')
    o = p.parse_args(); start = time.monotonic()
    terms = [t.strip() for t in o.query if t.strip()]
    try:
        if o.mode == 'doctor':
            result = {'ok': True, 'native_credentials': {m: bool(load(m)) for m in ['noon', 'minutes', 'talabat', 'careem']},
                      'talabat_native': 'guest_catalog_verified_account_login_pending'}
        else:
            if not terms or not 1 <= o.limit <= 5000 or not 1 <= o.page <= 100 or not 5 <= o.timeout <= 60:
                raise NativeError('USAGE', 'Invalid query, limit, page or timeout.')
            if o.mode in ('noon', 'minutes'):
                result = search(o.mode, ' '.join(terms), min(o.limit, 100), o.page, o.timeout, rocket=o.rocket)
            else:
                result = food_mode(o.mode, terms, o.limit, o.timeout, o.open_only, o.item_query)
        result['elapsed_ms'] = round((time.monotonic() - start) * 1000); print(json.dumps(result, ensure_ascii=False))
    except NativeError as e:
        print(json.dumps({'ok': False, 'error': {'code': e.code, 'message': e.message}})); return 1
    except Exception:
        print(json.dumps({'ok': False, 'error': {'code': 'KEYCHAIN_ERROR', 'message': 'Could not read the native Keychain entry. No credentials were printed.'}})); return 1
    return 0


if __name__ == '__main__': sys.exit(main())
