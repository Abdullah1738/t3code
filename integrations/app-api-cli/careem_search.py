"""Read-only Careem catalog searches. Credentials never leave Keychain.

Every mode uses native guest appengine GETs first:
  quik        quik-search-listing (+ shops-merchant-home 1038071 for ETA/fee)
  food        food-search
  menu        food-menu
  menu-match  food-search candidates -> food-menu, every term must match an item name
  shops       global-search category=shops (all Shops merchants, grouped)
  electronics same as shops, results filtered to items whose names match the query
The logged-in phone UI (careem_ui.py) is only an automatic fallback for Shops when
the API fails, and the fallback is announced in `fallbacks`.
"""
import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from catalog_schema import image, normalize, download
import os

if __name__ == '__main__':
    sys.modules['careem_search'] = sys.modules[__name__]

sys.path.insert(0, str(Path(__file__).resolve().parent / 'capture'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from keychain import load
from common import HOME_LAT, HOME_LNG, HOME_NAME, clean_name, money, eta_range, item_matches, relevance

HOME = (HOME_LAT, HOME_LNG)
HOST = 'appengine.careemapis.com'
QUIK_MERCHANT, QUIK_BRAND = '1038071', '1012099'
PAGES = {'quik': 'quik-search-listing', 'food': 'food-search', 'menu': 'food-menu',
         'global': 'global-search', 'merchant': 'shops-merchant-home'}
TEMPLATE = {'quik': 'quik-search-listing', 'food': 'food-search', 'menu': 'food-menu',
            'global': 'quik-search-listing', 'merchant': 'quik-search-listing'}
ELECTRONICS = re.compile(r'\b(?:charg\w*|cables?|usb\w*|lightning|adapters?|earbuds?|earphones?|headphones?|headsets?|'
                         r'airpods?|speakers?|power ?banks?|phones?|iphone\w*|smartphones?|samsung|ipad\w*|tablet|'
                         r'laptops?|keyboards?|mouse|smart ?watch\w*|batter(?:y|ies)|bulbs?|led|hdmi|wireless|'
                         r'bluetooth|cameras?|tv|consoles?|playstation|nintendo|xbox|gaming|memory|sd card|'
                         r'routers?|wifi|plugs?|extension|sockets?|holders?|mounts?|type-?c)\b', re.I)


class SearchError(Exception):
    pass


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def text(value):
    if isinstance(value, dict):
        value = value.get('text', '')
    return re.sub(r'<[^>]*>', '', str(value or ''))


def price(value):
    found = re.search(r'\d+(?:\.\d+)?', text(value).replace(',', ''))
    return money(found.group()) if found else None


class Catalog:
    def __init__(self, timeout=20):
        self.templates = (load('careem') or {}).get('templates', {})
        self.timeout = timeout

    def fetch(self, mode, query=None, params=None, _retried=False):
        path = '/v1/page/' + PAGES[mode]
        template = self.templates.get('GET ' + HOST + '/v1/page/' + TEMPLATE[mode])
        if not template:
            raise SearchError('NATIVE_CAPTURE_REQUIRED')
        if params is None:
            params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(template['url']).query, keep_blank_values=True))
            params['restaurant_id' if mode == 'menu' else 'query'] = query
        headers = {k: v for k, v in template['headers'].items() if k.lower() not in {
            'accept-encoding', 'host', 'content-length', 'if-modified-since',
            'if-none-match', 'baggage', 'sentry-trace'}}
        lat, lng = map(str, HOME)
        headers.update({'lat': lat, 'lng': lng, 'x-careem-delivery-location': lat + ',' + lng,
                        'x-careem-user-location': lat + ',' + lng})
        # All network calls are GETs to the captured appengine page routes above.
        request = urllib.request.Request('https://' + HOST + path + '?' + urllib.parse.urlencode(params), headers=headers)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=self.timeout) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 401 and not _retried:
                from careem_auth import AuthError, refresh
                rejected = next((v[7:] for k, v in headers.items()
                                 if k.lower() == 'authorization' and v.startswith('Bearer ')), None)
                try:
                    self.templates = refresh(rejected_token=rejected, timeout=self.timeout)['templates']
                except AuthError as auth_error:
                    raise SearchError(str(auth_error)) from None
                return self.fetch(mode, query, params, _retried=True)
            raise SearchError('AUTH_EXPIRED' if error.code in (401, 403) else 'HTTP_' + str(error.code)) from None
        except (OSError, ValueError):
            raise SearchError('NETWORK_OR_RESPONSE_ERROR') from None
        if not isinstance(data, dict) or 'body' not in data:
            raise SearchError('UNEXPECTED_RESPONSE')
        if data.get('metadata', {}).get('page_error_count', 0):
            raise SearchError('CATALOG_PAGE_ERROR')
        return data

    def merchant_info(self, merchant_id, brand_id=''):
        d = self.fetch('merchant', params={'merchant_id': merchant_id, 'restaurant_id': merchant_id, 'brand_id': brand_id})
        info = {'eta': None, 'delivery_fee': None, 'delivery_fee_careem_plus': None, 'area': None}
        for n in walk(d.get('body', {})):
            if n.get('id') == 'shops-merchant-header-info-table-content':
                for cell in n.get('cells', []):
                    label = text(cell.get('label'))
                    if label == 'Delivery Time':
                        info['eta'] = text(cell.get('text'))
                    elif label == 'Delivery Fee':
                        info['delivery_fee'] = price(cell.get('text'))
                        tag = (cell.get('tag') or {})
                        if tag.get('icon') == 'CareemPlus' or 'plus' in str(tag.get('background_color', '')).lower():
                            info['delivery_fee_careem_plus'] = 0.0 if 'free' in str(tag.get('text', '')).lower() else None
        for n in walk(d.get('header', {})):
            if n.get('id') == 'merchant-info':
                info['area'] = text(n.get('body')) or None
        return info


def attributes(node):
    return node.get('event_configuration', {}).get('entity', {}).get('attributes', {})


def products(data):
    result, seen = [], set()
    for node in walk(data.get('body', {})):
        a = attributes(node)
        item_id = a.get('item_id')
        if not item_id or str(item_id) in seen or 'item_price' not in a:
            continue
        seen.add(str(item_id))
        fields = {n.get('id'): text(n.get('text')) for n in walk(node.get('root', {})) if n.get('type') == 'text'}
        result.append({'id': str(item_id), 'name': clean_name(a.get('item_name')), 'price': money(a['item_price']),
                       'image_url': next((u for n in walk(node) if (u := image(n))), None),
                       'original_price': price(fields.get('info-price-cnt-original')),
                       'size': fields.get('info-box-cnt-text-desc'), 'currency': 'AED',
                       'available': bool(a['item_availability']) if 'item_availability' in a else None,
                       'merchant_id': str(a.get('merchant_id', ''))})
    return result


def restaurants(data):
    result, seen = [], set()
    for node in walk(data.get('body', {})):
        a = attributes(node)
        merchant_id = str(a.get('merchant_id', ''))
        if not a.get('merchant_name') or 'item_name' in a or not merchant_id or merchant_id in seen:
            continue
        content = node.get('trailing_content', node)
        if not content.get('title'):
            continue
        seen.add(merchant_id)
        avail, busy = a.get('merchant_availability'), a.get('is_busy')
        result.append({'id': merchant_id, 'name': clean_name(content.get('title')), 'brand_id': a.get('brand_id'),
                       'image_url': image(node.get('leading_content', {})),
                       'eta': content.get('eta'), 'delivery_fee': price(content.get('delivery', {}).get('end')),
                       'fee_source': 'native_guest_search', 'currency': 'AED',
                       'rating': (content.get('user_rating') or {}).get('value'),
                       'status': 'busy' if busy else 'open' if avail else 'closed' if avail is False else 'unknown',
                       'available': avail, 'busy': busy, 'promotion': a.get('offer_text') or None})
    return result


def menu(data):
    result, seen = [], set()
    for section in walk(data.get('body', {})):
        if not isinstance(section.get('items'), list):
            continue
        category = clean_name(section.get('header', {}).get('title'))
        for item in section['items']:
            if item.get('id') in seen or 'price' not in item:
                continue
            seen.add(item.get('id'))
            a = attributes(item)
            result.append({'id': item.get('id'), 'name': clean_name(text(item.get('header'))),
                           'description': text(item.get('description')).strip(), 'category': category,
                           'image_url': image(item),
                           'price': price(item.get('price')), 'original_price': price(item.get('original_price')),
                           'currency': 'AED', 'available': a.get('item_availability'),
                           'customisable': bool(item.get('item_details', {}).get('groups'))})
    config = data.get('header', {}).get('configuration', {})
    fee = next((price(n['text']) for n in walk(data.get('header', {}))
                if text(n.get('label')) == 'Delivery Fee' and 'text' in n), None)
    return result, {'id': config.get('id'), 'name': clean_name(config.get('title')),
                    'eta': config.get('subtitle'), 'delivery_fee': fee, 'currency': 'AED'}


def shop_groups(data):
    """Global-search Shops carousels: one group per merchant with its matching items."""
    groups = []
    for c in data.get('body', {}).get('content', []):
        if c.get('type') != 'item-card-carousel-v3' or 'shops' not in str(c.get('id')):
            continue
        h = c.get('header', {})
        a = attributes(h)
        items = []
        for card in c.get('content', []):
            ia = attributes(card)
            if not ia.get('item_id'):
                continue
            items.append({'id': str(ia['item_id']), 'name': clean_name(ia.get('item_name')),
                          'price': money(ia.get('item_price')), 'discount': money(ia.get('item_discount')) or None,
                          'available': ia.get('item_availability'), 'currency': 'AED',
                          'image_url': next((u for n in walk(card) if (u := image(n))), None)})
        deeplink = str(a.get('destination_deeplink', ''))
        btype = re.search(r'business_type=([a-z_\-]+)', deeplink)
        groups.append({'merchant_id': str(a.get('merchant_id') or h.get('id')), 'store': clean_name(h.get('title')),
                       'brand_id': a.get('brand_id'), 'business_type': btype.group(1) if btype else None,
                       'eta': h.get('eta'), 'distance_km': money((a.get('distance') or 0) / 1000) if a.get('distance') else None,
                       'rating': a.get('merchant_rating'),
                       'status': 'open' if a.get('merchant_availability') else 'closed' if a.get('merchant_availability') is False else 'unknown',
                       'items': items})
    return groups


def run_shops(catalog, query, limit, electronics, timeout, fallbacks, open_only=False):
    try:
        data = catalog.fetch('global', params={'q': query, 'global_search_category': 'shops', 'is_filtered_search': 'true'})
        groups = shop_groups(data)
    except SearchError as e:
        if os.environ.get('APP_SEARCH_NO_UI') == '1':
            raise
        fallbacks.append({'step': 'shops_search', 'reason': f'API {e}; used logged-in phone UI'})
        from careem_ui import search_shops
        r = search_shops(query, limit, timeout)
        r['results'] = [i for i in r.get('results', []) if item_matches(query, i['name']) and (not electronics or ELECTRONICS.search(i['name']))]
        if open_only:
            raise SearchError('OPEN_STATUS_UNVERIFIED: UI fallback does not expose verified open status')
        r['fallbacks'] = fallbacks
        return r
    words = query
    for g in groups:
        for i in g['items']:
            i['query_match'] = bool(item_matches(words, i['name']))
            i['electronics'] = bool(ELECTRONICS.search(i['name']))
        keep = [i for i in g['items'] if i['query_match'] and (not electronics or i['electronics'])]
        g['unmatched_items'] = len(g['items']) - len(keep)
        g['items'] = keep
    groups = [g for g in groups if g['items'] and (not open_only or g['status'] == 'open')]

    def fee(g):
        try:
            return g, catalog.merchant_info(g['merchant_id'], g.get('brand_id') or '')
        except SearchError:
            return g, None
    with cf.ThreadPoolExecutor(8) as ex:
        for g, info in ex.map(fee, groups):
            g['delivery_fee'] = info['delivery_fee'] if info else None
            g['delivery_fee_careem_plus'] = info['delivery_fee_careem_plus'] if info else None
            g['area'] = info['area'] if info else None
            g['fee_source'] = 'native_guest_merchant_home' if info else None
            if info and info['eta']:
                g['search_eta'] = g['eta']
                g['eta'] = info['eta']
                g['eta_source'] = 'native_guest_merchant_home'
    for g in groups:
        g['cheapest'] = min((i['price'] for i in g['items'] if i['price']), default=None)
    groups.sort(key=lambda g: (g['status'] != 'open', (eta_range(g['eta']) or (999,))[0], g['cheapest'] or 1e9))
    return {'source': 'native_android_api', 'stores': groups[:limit], 'stores_with_matches': len(groups),
            'note': 'Irrelevant Careem matches (query_match:false) are removed and counted in unmatched_items.'}


def run_menu_match(catalog, terms, limit, open_only):
    cands, seen = [], set()
    for q in terms:
        try:
            for r in restaurants(catalog.fetch('food', q)):
                if r['id'] not in seen:
                    seen.add(r['id']); cands.append(r)
        except SearchError:
            raise SearchError('SEARCH_UNAVAILABLE: a menu-match candidate search failed') from None

    def one(r):
        try:
            return r, menu(catalog.fetch('menu', r['id']))
        except SearchError:
            return r, None
    with cf.ThreadPoolExecutor(10) as ex:
        res = list(ex.map(one, cands))
    out, failed = [], 0
    for r, m in res:
        if m is None:
            failed += 1
            continue
        items, info = m
        if open_only and r['status'] != 'open':
            continue
        hits = {}
        for term in terms:
            found = [i for i in items if i.get('available') is not False and item_matches(term, i['name'])]
            named = [i for i in found if item_matches(term, i['name'], '')]
            pool = named or found
            if not pool:
                break
            pool.sort(key=lambda i: (not i['price'], i['price'] or 0))
            hits[term] = [{k: i[k] for k in ('id', 'name', 'price', 'category', 'image_url', 'description')} for i in pool[:3]]
        else:
            out.append({**r, 'eta': info.get('eta') or r['eta'], 'delivery_fee': info.get('delivery_fee') if info.get('delivery_fee') is not None else r['delivery_fee'],
                        'fee_source': 'native_guest_menu' if info.get('delivery_fee') is not None else r['fee_source'],
                        'eta_source': 'native_guest_menu' if info.get('eta') else 'native_guest_search',
                        'matches': hits})
    if cands and failed == len(cands):
        raise SearchError('MENUS_UNAVAILABLE: all candidate menu requests failed')
    out.sort(key=lambda r: (r['status'] != 'open', (eta_range(r['eta']) or (999,))[0], -(r['rating'] or 0)))
    return {'results': out[:limit], 'candidates_checked': len(cands), 'menus_failed': failed, 'terms': terms,
            'limits': 'Candidates come from the first Food search page per term (~20 restaurants each).'}


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ('orders', 'track'):
        from native_orders import main as order_main
        return order_main(['careem', *sys.argv[1:]])
    class JsonParser(argparse.ArgumentParser):
        def error(self, message):
            print(json.dumps({'error': 'USAGE', 'message': message}))
            raise SystemExit(2)
    parser = JsonParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=['quik', 'food', 'menu', 'menu-match', 'shops', 'electronics'])
    parser.add_argument('query', nargs='+', help='Search text, restaurant ID/name for menu, or several item terms for menu-match')
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--query', dest='item_query', default='', help='Filter menu item names/descriptions')
    parser.add_argument('--open', dest='open_only', action='store_true', help='Only restaurants currently open (food/menu-match)')
    parser.add_argument('--json', action='store_true', help='JSON is always emitted')
    parser.add_argument('--images-dir', help='Download returned item images')
    parser.add_argument('--ui', action='store_true', help='Force the logged-in phone UI for shops')
    parser.add_argument('--require-account', action='store_true')
    args = parser.parse_args()
    terms = [t.strip() for t in args.query if t.strip()]
    query = ' '.join(terms)
    args.limit = args.limit if args.limit is not None else (1000 if args.mode == 'menu' else 10)
    if not 1 <= args.limit <= 1000 or not 1 <= args.timeout <= 90 or not query:
        parser.error('Use a nonempty query, limit 1–1000 and timeout 1–90')
    start = time.monotonic()
    fallbacks = []
    try:
        if args.require_account and not (args.mode in ('shops', 'electronics') and args.ui):
            raise SearchError('LOGIN_REQUIRED')
        catalog = Catalog(args.timeout)
        base = {'source': 'native_android_api', 'account': {'authenticated': False, 'pricing': 'guest'},
                'location': {'name': HOME_NAME, 'lat': HOME[0], 'lng': HOME[1],
                             'scope': 'saved_home_pin_coordinates', 'saved_address_verified': False},
                'currency': 'AED'}
        if args.mode in ('shops', 'electronics'):
            if args.ui:
                from careem_ui import search_shops
                result = search_shops(query, args.limit, args.timeout)
            else:
                result = {**base, **run_shops(catalog, query, args.limit, args.mode == 'electronics', args.timeout, fallbacks, args.open_only)}
        elif args.mode == 'menu-match':
            result = {**base, **run_menu_match(catalog, terms, args.limit, args.open_only)}
        else:
            if args.mode == 'menu' and not query.isdecimal():
                found = [r for r in restaurants(catalog.fetch('food', query)) if r['name'].casefold() == query.casefold()]
                if len(found) != 1:
                    raise SearchError('RESTAURANT_ID_REQUIRED: use food search and select a branch ID')
                query = found[0]['id']
            data = catalog.fetch(args.mode, query)
            result = dict(base)
            if args.mode == 'food':
                items = restaurants(data)
                for r in items:
                    r['relevance'] = relevance(query, r['name'])
                if args.open_only:
                    items = [r for r in items if r['status'] == 'open']
                result['dishes'] = [d for d in products(data) if relevance(query, d['name']) or item_matches(query, d['name'])][:args.limit]
                dish_merchants = {d['merchant_id'] for d in result['dishes']}
                items = [r for r in items if r['relevance'] > 0 or r['id'] in dish_merchants]
                items.sort(key=lambda r: (r['status'] != 'open', -r['relevance'], (eta_range(r['eta']) or (999,))[0]))
            elif args.mode == 'menu':
                items, result['restaurant'] = menu(data)
                if args.item_query:
                    q = args.item_query
                    named = [i for i in items if item_matches(q, i['name'], i['category'])]
                    desc = [i for i in items if i not in named and q.casefold() in i['description'].casefold()]
                    for i in named:
                        i['matched_on'] = 'name'
                    for i in desc:
                        i['matched_on'] = 'description'
                    items = named + desc
            else:
                items = products(data)
                for i in items:
                    i['query_match'] = bool(item_matches(query, i['name']))
                items = [i for i in items if i['query_match']]
                result['merchant_id'] = QUIK_MERCHANT
                try:
                    info = catalog.merchant_info(QUIK_MERCHANT, QUIK_BRAND)
                    result['store'] = {'name': 'Careem Quik', 'eta': info['eta'], 'delivery_fee': info['delivery_fee'],
                                       'delivery_fee_careem_plus': info['delivery_fee_careem_plus'],
                                       'area': info['area'], 'source': 'native_guest_merchant_home'}
                except SearchError as e:
                    fallbacks.append({'step': 'quik_eta_fee', 'reason': f'merchant home {e}'})
            result['results'] = items[:args.limit]
            result['fetched_count'] = len(items)
            result['truncated'] = len(items) > args.limit or any(n.get('next_page_url') for n in walk(data.get('body', {})))
            result['pagination'] = 'first_api_page' if args.mode != 'menu' else 'full_menu'
        result.setdefault('fallbacks', fallbacks)
        result.update({'mode': args.mode, 'query': query, 'elapsed_seconds': round(time.monotonic() - start, 2)})
        result = normalize(result)
        if args.images_dir:
            download(result, args.images_dir)
        print(json.dumps(result, ensure_ascii=False))
    except SearchError as error:
        print(json.dumps({'error': str(error), 'mode': args.mode}))
        return 1
    except Exception:
        # Request objects and Keychain values must never appear in tracebacks.
        print(json.dumps({'error': 'SEARCH_FAILED', 'mode': args.mode}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
