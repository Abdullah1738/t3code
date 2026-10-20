"""Read-only Talabat catalog search. Native Android guest APIs first; credentials stay in Keychain.

Fallbacks are automatic and always announced in `fallbacks`:
- restaurant search: native returns transient empty pages (observed ~30% of cold
  calls, independent of query/headers). We retry, then use talabat.com's public
  search API. Status/ETA/fee for the final list come from the native live branch
  endpoint, so `open` is never taken from the stale web flag.
- grocery/pharmacy stores: talabat.com's public area listing (native vendor search
  only returns Mart for verticals other than food), products via native grocery API.
"""
import argparse
import concurrent.futures as cf
import copy
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent/'capture'))
# Preserve an explicit source PYTHONPATH for account adapters under development.
# Normal CLI execution already includes this directory; do not shadow source auth
# modules with older managed runtime copies when invoked via python -m.
if str(Path(__file__).parent) not in sys.path:
    sys.path.append(str(Path(__file__).parent))
from keychain import load
_catalog_import_path = sys.path[:]
from native import NativeError, NoRedirect
from talabat_transport import SharedState
from common import (HOME_LAT, HOME_LNG, HOME_NAME, clean_name, money, eta_range,
                    item_matches, relevance, area_from_branch)
# native.py prepends its runtime directory as a legacy import side effect.
# Restore caller precedence so explicit fork PYTHONPATH resolves matching auth.
sys.path[:] = _catalog_import_path
del _catalog_import_path

HOME = {'name': HOME_NAME, 'latitude': HOME_LAT, 'longitude': HOME_LNG, 'area_id': 1308,
        'area': 'Jumeirah Lakes Towers - JLT',
        'source': 'saved_home_pin_from_noon_account', 'saved_address_verified': False}
SEARCH = '/search/api/v3/vendor'
MENU = re.compile(r'^/menubff/v4/branches/[1-9][0-9]*/menu$')
CHOICES = re.compile(r'^/menubff/v3/branches/[1-9][0-9]*/menu/[1-9][0-9]*/choices$')
BRANCH = re.compile(r'^/grocery/v2/TB_AE/branches/[1-9][0-9]*$')
PRODUCTS = re.compile(r'^/grocery/v1/bff/ae/vendors/[a-f0-9-]{36}/products/search$')
WEB_SEARCH = 'https://www.talabat.com/nextSearchApi/v3/vendor'
WEB_LISTING = re.compile(r'^https://www\.talabat\.com/uae/(groceries|pharmacies|flowers)/1308/jumeirah-lakes-towers-jlt(\?page=[1-9][0-9]?)?$')
MART_BRANCH = 798285
STATUS = {0: 'open', 1: 'closed', 2: 'busy'}
WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'


def allowed(method, url):
    u = urllib.parse.urlsplit(url)
    if u.username or u.password or u.fragment or u.port or u.scheme != 'https':
        return False
    if u.hostname == 'www.talabat.com':
        return (method == 'POST' and url == WEB_SEARCH) or (method == 'GET' and bool(WEB_LISTING.match(url)))
    return (u.hostname == 'api.talabat.com' and
            ((method == 'POST' and (u.path == SEARCH or bool(PRODUCTS.fullmatch(u.path)))) or
             (method == 'GET' and (bool(MENU.fullmatch(u.path)) or bool(CHOICES.fullmatch(u.path))
                                   or bool(BRANCH.fullmatch(u.path))))))


def _open(req, timeout):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    return opener.open(req, timeout=timeout)


def request(template, timeout, *, path=None, params=None, body=None):
    state = SharedState()
    deadline = time.monotonic() + timeout
    u = urllib.parse.urlsplit(template['url'])
    url = urllib.parse.urlunsplit((u.scheme, u.netloc, path or u.path,
          urllib.parse.urlencode(params) if params is not None else u.query, u.fragment))
    method = template['method']
    if not allowed(method, url):
        raise NativeError('ENDPOINT_DENIED', 'Only verified Talabat catalog reads are allowed.')
    headers = {k: v for k, v in template['headers'].items() if k.lower() not in
               ['accept-encoding', 'content-length', 'host', 'connection', 'sentry-trace',
                'baggage', 'x-requestid', 'x-primary-request-id']}
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(4):
        try:
            with state.slot(bool(PRODUCTS.fullmatch(urllib.parse.urlsplit(url).path)), deadline):
                with _open(urllib.request.Request(url, headers=headers, data=data, method=method), state.remaining(deadline)) as r:
                    result = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                state.backoff(e.headers.get('Retry-After'), attempt)
            if e.code in (429, 502, 503) and attempt < 3:
                if e.code != 429:
                    state.pause(2**attempt, deadline)
                continue
            raise NativeError('AUTH_EXPIRED' if e.code in (401, 403) else 'RATE_LIMITED' if e.code == 429 else f'HTTP_{e.code}',
                              'Talabat rejected this catalog request.') from None
        except NativeError:
            raise
        except Exception:
            if attempt < 1:
                continue
            raise NativeError('NATIVE_NETWORK_ERROR', 'Talabat catalog request failed or timed out.') from None
    if not isinstance(result, dict) or result.get('hasserror'):
        raise NativeError('SCHEMA_CHANGED', 'Talabat returned an unexpected catalog response.')
    return result


def web_request(url, timeout, body=None):
    method = 'POST' if body is not None else 'GET'
    if not allowed(method, url):
        raise NativeError('ENDPOINT_DENIED', 'Only verified public Talabat web reads are allowed.')
    headers = {'User-Agent': WEB_UA, 'Accept-Language': 'en-US'}
    if body is not None:
        headers.update({'content-type': 'application/json', 'X-Device-Source': '0', 'appBrand': '1', 'sourceApp': 'web'})
    state, deadline = SharedState(), time.monotonic()+timeout
    for attempt in range(4):
        try:
            with state.slot(False, deadline):
                with _open(urllib.request.Request(url, headers=headers, method=method,
                           data=json.dumps(body).encode() if body is not None else None), state.remaining(deadline)) as r:
                    raw = r.read().decode('utf-8', 'replace')
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                state.backoff(e.headers.get('Retry-After'), attempt)
                if attempt < 3:
                    continue
            raise NativeError(f'WEB_HTTP_{e.code}', 'talabat.com rejected the public fallback request.') from None
        except NativeError:
            raise
        except Exception:
            raise NativeError('WEB_NETWORK_ERROR', 'talabat.com public fallback failed or timed out.') from None
    if body is not None:
        return json.loads(raw)
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', raw, re.S)
    if not m:
        raise NativeError('WEB_SCHEMA_CHANGED', 'talabat.com listing page changed.')
    return json.loads(m.group(1))['props']['pageProps']


def template_for(saved, predicate):
    found = [v for v in saved.get('templates', {}).values()
             if predicate(urllib.parse.urlsplit(v.get('url', '')).path)]
    if not found:
        raise NativeError('NATIVE_CAPTURE_REQUIRED', 'This native catalog request has not been captured.')
    return copy.deepcopy(max(found, key=lambda v: v.get('captured_at', 0)))


# ---------------------------------------------------------------- projections

def vendor_row(v, source):
    from catalog_schema import image
    name = clean_name(v.get('vendor_name', ''))
    slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    branch = v.get('branch_name')
    status_code = v.get('vendor_status')
    return {'id': v.get('vendor_id'), 'name': name, 'branch': branch,
            'image_url': image(v.get('vendor_image'), 'https://talabat.dhmedia.io/image/talabat/Restaurants/'),
            'area': area_from_branch(branch, name), 'chain_id': v.get('chain_id'),
            'cuisine': ', '.join(c.get('na', '') for c in v.get('cuisines', []) if c.get('na')),
            'rating': money(v.get('rating')), 'currency': 'AED',
            'distance_km': money(str(v.get('pickup_distance') or '').replace('km', '')) if v.get('pickup_distance') else None,
            'status_code': status_code, 'status': STATUS.get(status_code, 'unknown'),
            'status_source': source,
            'search_eta': v.get('time_estimation'), 'search_delivery_fee': money(v.get('delivery_charges')),
            'search_source': source, 'sponsored': bool(v.get('is_sponsored')),
            'offers': [t.get('label') for t in v.get('tags') or [] if t.get('label')],
            'url': f"https://www.talabat.com/uae/restaurant/{v.get('vendor_id')}/{slug}?aid=1308"}


def project_restaurants(data, query, limit, exact):
    """Kept for compatibility with older callers/tests."""
    result = data.get('result', {})
    vendors = result.get('vendors')
    if not isinstance(vendors, list):
        raise NativeError('SCHEMA_CHANGED', 'Talabat restaurant response changed.')
    rows = [vendor_row(v, 'native_search') for v in vendors
            if not exact or query.casefold() in v.get('vendor_name', '').casefold()]
    return {'items': rows[:limit], 'total': result.get('metadata', {}).get('counts', {}).get('total'),
            'has_more': result.get('metadata', {}).get('pagination', {}).get('has_more_pages')}


def project_menu(data, branch, query, limit, *, synonyms=False):
    from catalog_schema import image
    try:
        vendor = data['vendor']['result']['restaurant']
        sections = data['menu']['result']['menu']['menuSection']
    except (KeyError, TypeError):
        raise NativeError('SCHEMA_CHANGED', 'Talabat menu response changed.') from None
    if vendor.get('bid') != branch:
        raise NativeError('BRANCH_MISMATCH', 'Talabat returned a different restaurant branch.')
    if not isinstance(sections, list):
        raise NativeError('SCHEMA_CHANGED', 'Talabat menu sections changed.')
    rows, seen, all_items = [], set(), []
    for section in sections:
        cat = clean_name(section.get('nm'))
        for item in section.get('itm', []):
            if item.get('id') in seen:
                continue
            seen.add(item.get('id'))
            name, description = clean_name(item.get('nm', '')), (item.get('dsc') or '').strip()
            row = {'id': item.get('id'), 'name': name, 'description': description,
                   'image_url': image(item, 'https://images.deliveryhero.io/image/talabat/Menuitems/'),
                   'category': cat, 'price': money(item.get('pr')),
                   'regular_price': money(item.get('opr')) or None, 'currency': 'AED',
                   'availability': 'listed_on_native_menu'}
            all_items.append(row)
            if query:
                hit = item_matches(query, name, cat, synonyms) if synonyms else (
                    'name' if query.casefold() in name.casefold() else
                    'description' if query.casefold() in description.casefold() else None)
                if not hit:
                    continue
                row = {**row, 'matched_on': hit}
            rows.append(row)
    return {'restaurant': branch_info(vendor, branch),
            'total_menu_items': len(seen), 'matching_items': len(rows), 'items': rows[:limit],
            '_all': all_items}


def branch_info(vendor, branch):
    name = clean_name(vendor.get('na'))
    code = vendor.get('stt')
    return {'id': branch, 'name': name, 'branch': vendor.get('bna'),
            'area': vendor.get('an') or area_from_branch(vendor.get('bna'), name),
            'status_code': code, 'status': STATUS.get(code, 'unknown'),
            'status_description': vendor.get('status_description') or None,
            'eta': vendor.get('avd') or vendor.get('time_estimation'),
            'delivery_fee': money(vendor.get('dch')),
            'service_fee': {'percent': vendor.get('serviceFeesSetupValue'), 'min': money(vendor.get('serviceFeesCapMin')),
                            'max': money(vendor.get('serviceFeesCapMax'))} if vendor.get('serviceFeesType') else None,
            'talabat_pro_vendor': vendor.get('isTalabatPro'),
            'rating': money(vendor.get('rat')), 'opening_hours': vendor.get('timing'),
            'source': 'native_branch_live'}


def project_products(data, limit):
    from catalog_schema import image
    if not isinstance(data.get('products'), list):
        raise NativeError('SCHEMA_CHANGED', 'Talabat grocery response changed.')
    return {'items': [{'id': p.get('id'), 'name': clean_name(p.get('name')), 'description': p.get('description'),
             'size': p.get('net_contents_description'), 'price': money(p.get('price')),
             'image_url': image(p),
             'regular_price': money(p.get('original_price')), 'currency': 'AED',
             'buyable': p.get('is_available'), 'max_quantity': p.get('max_sales_quantity'),
             'stock_amount': p.get('stock_amount'), 'sponsored': p.get('is_sponsored')}
            for p in data['products'][:limit]], 'total': data.get('item_counts', {}).get('total')}


# ---------------------------------------------------------------- data access

class Talabat:
    def __init__(self, saved=None, timeout=20, native_only=False, force_web=False):
        self.use_shared_cache = saved is None
        self.saved = load('talabat') if saved is None else saved
        if not self.saved:
            raise NativeError('NATIVE_CAPTURE_REQUIRED', 'No Talabat catalog capture in Keychain.')
        self.timeout = timeout
        self.fallbacks = []
        self.native_only = native_only
        self.force_web = force_web
        self.state = SharedState()
        self.deadline = None

    def budget(self):
        return min(self.timeout, self.state.remaining(self.deadline)) if self.deadline else self.timeout

    def cached(self, key, ttl, fetch):
        if not self.use_shared_cache:
            return fetch()
        return self.state.cached(f'{HOME_LAT},{HOME_LNG}:{key}', ttl, fetch,
                                 self.deadline or time.monotonic()+self.timeout)

    def note(self, what, why):
        entry = {'step': what, 'reason': why}
        if entry not in self.fallbacks:
            self.fallbacks.append(entry)

    def native_page(self, query, page, vertical=0, tries=4):
        t = template_for(self.saved, lambda p: p == SEARCH)
        body = json.loads(t['body'])
        body.update(latitude=HOME_LAT, longitude=HOME_LNG, areaid=1308, query=query.lower(),
                    page_number=page - 1, vertical_ids=[vertical])
        last = None
        for attempt in range(tries):
            last = request(t, self.timeout, body=body).get('result', {})
            if not isinstance(last.get('vendors'), list):
                raise NativeError('SCHEMA_CHANGED', 'Talabat restaurant response changed.')
            if last['vendors'] or (last.get('metadata', {}).get('counts', {}).get('total') or 0) > 0:
                return last, attempt
            time.sleep(0.4 + 0.3 * attempt)
        return last, tries

    def web_page(self, query, page, limit=100):
        d = web_request(WEB_SEARCH, self.timeout, body={'latitude': HOME_LAT, 'longitude': HOME_LNG,
            'query': query, 'vertical_ids': [0], 'limit': limit, 'country_id': 4, 'page_number': page - 1})
        r = d.get('result') or {}
        if not isinstance(r.get('vendors'), list):
            raise NativeError('WEB_SCHEMA_CHANGED', 'talabat.com search response changed.')
        return r

    def dia_page(self, query, page):
        import subprocess, shutil
        node = shutil.which('node') or str(Path.home()/'.nvm/versions/node/v26.2.0/bin/node')
        try:
            out = subprocess.run([node, str(Path(__file__).parent/'dia_talabat.mjs'), query, str(page), str(HOME_LAT), str(HOME_LNG)],
                                 capture_output=True, text=True, timeout=45).stdout
            d = json.loads(out.strip().splitlines()[-1])
        except Exception:
            raise NativeError('DIA_FAILED', 'Dia Personal fallback could not run.') from None
        if d.get('error'):
            raise NativeError('DIA_' + str(d['error']), 'Dia Personal fallback failed.')
        return d

    def search_vendors(self, query, pages=1, start_page=1):
        """Return (vendors, total, source).

        Tier 1 native app API (retries its transient empty pages), tier 2 talabat.com
        public search, tier 3 the same web search inside Dia Personal. Every switch
        is recorded in self.fallbacks.
        """
        vendors, total, source = [], None, 'dia_web_search' if self.force_web else 'native_search'
        for page in range(start_page, start_page + pages):
            r, retries, why = None, 0, None
            if source == 'native_search':
                try:
                    r, retries = self.native_page(query, page)
                    if not r['vendors']:
                        why = 'native returned empty pages 4x'
                except NativeError as e:
                    why = f'native {e.code}'
                if r is not None and retries and r['vendors']:
                    self.note('restaurant_search', f'native returned an empty page; recovered after {retries} retr{"y" if retries == 1 else "ies"}')
            if r is None or not r['vendors']:
                if self.native_only:
                    raise NativeError('NATIVE_EMPTY_OR_FAILED', f'{why}; fallback disabled by --native. Empty native responses are not reliable proof of no matches.')
                r = None
                for name, fn in (('web_search', self.web_page), ('dia_web_search', self.dia_page)):
                    if source == 'dia_web_search' and name == 'web_search':
                        continue
                    try:
                        r = fn(query, page)
                        if page == 1 or source != name:
                            self.note('restaurant_search', f'{why}; used {name}')
                        source = name
                        break
                    except NativeError as e:
                        why = f'{why}; {name} {e.code}'
                if r is None:
                    if page == start_page:
                        raise NativeError('SEARCH_UNAVAILABLE', f'All Talabat search tiers failed: {why}.')
                    self.note('restaurant_search', f'stopped at page {page}: {why}')
                    break
            vendors += [vendor_row(v, source) for v in r['vendors']]
            total = r.get('metadata', {}).get('counts', {}).get('total', total)
            if not r.get('metadata', {}).get('pagination', {}).get('has_more_pages'):
                break
        return vendors, total, source

    def menu_raw(self, branch):
        t = template_for(self.saved, lambda p: bool(MENU.fullmatch(p)))
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(t['url']).query))
        params.update(branchId=branch, areaId=1308, latitude=HOME_LAT, longitude=HOME_LNG)
        return request(t, self.budget(), path=f'/menubff/v4/branches/{branch}/menu', params=params)

    def status(self, branch):
        def fetch():
            try:
                vendor = self.menu_raw(branch)['vendor']['result']['restaurant']
            except NativeError as e:
                if e.code != 'HTTP_404':
                    raise
                v = self.grocery_branch(branch)
                self.note('branch_status', 'Food menu returned 404; grocery identity verified, live opening status unavailable')
                return {'id': branch, 'name': v['vendor_name'], 'status': 'unknown',
                        'status_code': None, 'status_description': 'Live opening status unavailable for this grocery branch.',
                        'eta': None, 'delivery_fee': v.get('delivery_fee'),
                        'minimum_order': v.get('minimum_order_value'),
                        'min_order': v.get('minimum_order_value'),
                        'source': 'native_grocery_branch_status_unavailable',
                        'status_checked_at': time.time(), 'status_cache_ttl_seconds': 30}
            if str(vendor.get('bid')) != str(branch):
                raise NativeError('BRANCH_MISMATCH', 'Status response branch mismatch.')
            return {**branch_info(vendor, branch), 'status_checked_at': time.time(), 'status_cache_ttl_seconds': 30}
        result = self.cached(f'status:v2:{branch}', 30, fetch)
        if result.get('source') == 'native_grocery_branch_status_unavailable':
            self.note('branch_status', 'Food menu returned 404; grocery identity verified, live opening status unavailable')
        return result

    def menu(self, branch, query='', limit=1000, synonyms=False):
        return project_menu(self.menu_raw(branch), branch, query, limit, synonyms=synonyms)

    def live_status(self, ids, workers=6):
        def one(i):
            try:
                return i, self.status(i)
            except Exception:
                return i, None
        with cf.ThreadPoolExecutor(workers) as ex:
            return dict(ex.map(one, ids))

    def grocery_branch(self, branch):
        return self.cached(f'branch:{branch}', 60, lambda: self._grocery_branch(branch))

    def _grocery_branch(self, branch):
        b = template_for(self.saved, lambda p: bool(BRANCH.fullmatch(p)))
        info = request(b, self.budget(), path=f'/grocery/v2/TB_AE/branches/{branch}',
                       params={'areaId': 1308, 'lat': HOME_LAT, 'lon': HOME_LNG})
        v = info.get('vendor') or {}
        if str(v.get('talabat_id')) != str(branch) or not re.fullmatch(r'[a-f0-9-]{36}', str(v.get('global_id', ''))):
            raise NativeError('BRANCH_MISMATCH', 'Grocery branch response did not match the requested store.')
        return {k: v.get(k) for k in ('talabat_id', 'global_id', 'is_dark_store', 'vendor_name', 'delivery_fee', 'minimum_order_value')}

    def products(self, branch, query, limit=10, page=1, vertical=None):
        v = self.grocery_branch(branch)
        t = template_for(self.saved, lambda p: bool(PRODUCTS.fullmatch(p)))
        body = json.loads(t['body'])
        body.update(query=query, limit=limit, offset=(page - 1) * limit, branch_id=str(branch),
                    is_darkstore=bool(v.get('is_dark_store')) or branch == MART_BRANCH)
        if vertical is not None:
            body['vertical_id'] = vertical
        result = self.cached(f'products:{branch}:{query}:{limit}:{page}:{vertical}', 15,
            lambda: project_products(request(t, self.budget(), path=f"/grocery/v1/bff/ae/vendors/{v['global_id']}/products/search", body=body), limit))
        return v, result

    def store_listing(self, kind, pages=2):
        # Grocery express/mini branches can occur well beyond the first 60 tiles.
        pages = max(pages, 15) if kind == 'groceries' and pages != 1 else pages
        return self.cached(f'listing:v2:{kind}:{pages}', 120, lambda: self._store_listing(kind, pages))

    def _store_listing(self, kind, pages):
        rows = []
        for page in range(1, pages + 1):
            url = f'https://www.talabat.com/uae/{kind}/1308/jumeirah-lakes-towers-jlt' + (f'?page={page}' if page > 1 else '')
            try:
                pp = web_request(url, self.budget())
            except NativeError as e:
                if not rows:
                    raise
                self.note('store_list', f'Partial listing: stopped before page {page} ({e.code})')
                break
            for v in pp.get('vendors') or []:
                if v.get('verticalType') == 9:  # donations/charity tiles, not shops
                    continue
                rows.append({'id': v.get('branchId'), 'name': clean_name(v.get('name')), 'branch': v.get('branchName'),
                             'area': area_from_branch(v.get('branchName'), v.get('name')),
                             'vertical_type': v.get('verticalType'), 'is_darkstore': v.get('isDarkstore'),
                             'listing_status_code': v.get('statusCode'), 'listing_eta': v.get('avgDeliveryTime'),
                             'listing_fee': money(v.get('deliveryFee')), 'rating': money(v.get('rate')),
                             'cuisine': v.get('cuisineString')})
            md = pp.get('metadata') or {}
            if page * (md.get('size') or 20) >= (md.get('totalVendors') or 0):
                break
        return list({r['id']: r for r in rows}.values())


# ---------------------------------------------------------------- modes

def batch_products(terms, kind='groceries', *, timeout=8, stores=3, open_only=False, tb=None):
    """One discovery/status pass for every term; bounded, store-major searches.

    Completed cells survive deadline exhaustion. Mart is searched once and is
    included in groceries rather than duplicated in a second process.
    """
    tb = tb or Talabat(timeout=timeout)
    tb.deadline = time.monotonic()+timeout
    errors, listing = [], []
    if kind != 'mart':
        try:
            listing = tb.store_listing(kind, pages=1)
            tb.note('store_list', f'public {kind} JLT listing; one page, bounded candidates')
        except NativeError as e:
            errors.append({'stage':'discovery', 'error':e.code})
    if kind in ('mart', 'groceries'):
        listing = [{'id':MART_BRANCH, 'name':'talabat mart', 'area':'JLT'}] + [s for s in listing if s['id'] != MART_BRANCH]
    listing.sort(key=lambda s: (s['id'] != MART_BRANCH, s.get('listing_status_code', 0) != 0))
    candidates = listing[:stores]
    live = tb.live_status([s['id'] for s in candidates], workers=3)
    eligible = []
    for s in candidates:
        info = live.get(s['id'])
        if not info or info.get('status') == 'unknown':
            errors.append({'stage':'status', 'store_id':s['id'], 'error':'STATUS_UNAVAILABLE'})
        s.update(info or {'status':'unknown'})
        if not open_only or s['status'] == 'open':
            eligible.append(s)
    results = {term: [] for term in terms}
    completed = 0
    def one(s, term):
        try:
            _, data = tb.products(s['id'], term, limit=30)
            return s, term, data, None
        except NativeError as e:
            return s, term, None, e.code
    with cf.ThreadPoolExecutor(3) as pool:
        jobs = [pool.submit(one,s,term) for s in eligible for term in terms]
        for f in cf.as_completed(jobs):
            s, term, data, error = f.result()
            if error:
                errors.append({'stage':'products','store_id':s['id'],'term':term,'error':error})
                continue
            completed += 1
            results[term].append({'store_id':s['id'], 'store':s['name'], 'area':s.get('area'),
                'status':s['status'], 'eta':s.get('eta'), 'delivery_fee':s.get('delivery_fee'),
                'status_source':s.get('source', 'native_branch_live') if live.get(s['id']) else 'unknown',
                'status_checked_at':s.get('status_checked_at'), 'status_cache_ttl_seconds':30,
                'fee_source':'native_guest_branch', 'items':data['items']})
    coverage = {'candidate_stores':len(listing), 'stores_selected':len(candidates),
                'selected_stores':[{'store_id':s['id'], 'store':s['name'], 'status':s['status'],
                                    'completed_terms':[term for term,groups in results.items()
                                                       if any(g['store_id'] == s['id'] for g in groups)]}
                                   for s in candidates],
                'product_searches_planned':len(eligible)*len(terms), 'product_searches_completed':completed,
                'errors':errors, 'bounded':True, 'complete':not errors, 'listing_pages':1,
                'store_list_cache_ttl_seconds':120, 'status_cache_ttl_seconds':30,
                'product_cache_ttl_seconds':15}
    return {term:{'stores':groups, 'coverage':coverage, 'fallbacks':tb.fallbacks,
                  'location':HOME, 'account':{'authenticated':False,'scope':'captured_android_guest'}}
            for term,groups in results.items()}

def finalize_vendors(tb, vendors, query, *, open_only, limit, rank=True, dedupe=True, status_check=True):
    if rank:
        for v in vendors:
            v['relevance'] = relevance(query, v['name'], v['cuisine'])
        vendors = [v for v in vendors if v['relevance'] > 0]
    # One request per branch for live status/ETA/fee; parallel, ~0.6 s per wave.
    if status_check:
        vendors.sort(key=lambda v: -v.get('relevance', 0))
        check_n = max(limit * (8 if open_only else 4), 80 if open_only else 40)
        if len(vendors) > check_n:
            tb.note('status_check', f'live status checked for the {check_n} most relevant of {len(vendors)} results; rest dropped')
            vendors = vendors[:check_n]
        live = tb.live_status([v['id'] for v in vendors])
        for v in vendors:
            info = live.get(v['id'])
            if info:
                v.update(status_code=info['status_code'], status=info['status'], status_source='native_branch_live',
                         status_description=info['status_description'], eta=info['eta'],
                         delivery_fee=info['delivery_fee'], area=v.get('area') or info['area'],
                           fee_source=getattr(tb, 'fee_source', 'native_guest_branch'), eta_source='native_branch_live',
                           status_checked_at=info.get('status_checked_at'), status_cache_ttl_seconds=info.get('status_cache_ttl_seconds', 30))
            else:
                v.update(status='unknown', status_code=None, status_source=v['status_source'] + '_unverified', eta=v['search_eta'],
                         delivery_fee=v['search_delivery_fee'], fee_source=v['search_source'], eta_source=v['search_source'])
                tb.note('status_check', 'Some live branch checks failed; their status is unknown and they are excluded by --open')
    else:
        for v in vendors:
            v.update(eta=v['search_eta'], delivery_fee=v['search_delivery_fee'], fee_source=v['search_source'])
    if open_only:
        vendors = [v for v in vendors if v['status'] == 'open']
    if dedupe:
        best = {}
        for v in vendors:
            key = v.get('chain_id') or v['name'].casefold()
            cur = best.get(key)
            score = (v['status'] == 'open', -(v.get('distance_km') if v.get('distance_km') is not None else 99), -(eta_range(v.get('eta')) or (999,))[0])
            if cur is None or score > cur[0]:
                best[key] = (score, v)
        kept = {id(x[1]) for x in best.values()}
        dropped = len(vendors) - len(kept)
        vendors = [v for v in vendors if id(v) in kept]
    else:
        dropped = 0
    vendors.sort(key=lambda v: (v['status'] != 'open', -v.get('relevance', 0),
                                (eta_range(v.get('eta')) or (999,))[0], -(v.get('rating') or 0)))
    return vendors[:limit], dropped


def mode_restaurants(tb, query, *, limit, page, exact, open_only, raw):
    pages = 1 if raw else 4
    vendors, total, source = tb.search_vendors(query, pages=pages, start_page=page)
    if raw:
        return {'items': vendors[:limit], 'total': total, 'search_source': source}
    if exact:
        vendors = [v for v in vendors if query.casefold() in v['name'].casefold()]
    items, dropped = finalize_vendors(tb, vendors, query, open_only=open_only, limit=limit)
    for v in items:
        for k in ('chain_id',):
            v.pop(k, None)
    return {'items': items, 'total': total, 'search_source': source, 'fetched': len(vendors),
            'branches_deduped': dropped}


def mode_menu_match(tb, terms, *, limit, open_only, query_hint=None, pages=4):
    """Restaurants where EVERY term matches an item name (synonyms + menu section)."""
    seen, candidates, sources = set(), [], set()
    for q in [query_hint] if query_hint else terms:
        vendors, _, source = tb.search_vendors(q, pages=pages)
        sources.add(source)
        for v in vendors:
            if v['id'] not in seen:
                seen.add(v['id']); candidates.append(v)
    def fetch(v):
        try:
            return v, tb.menu_raw(v['id'])
        except Exception:
            return v, None
    with cf.ThreadPoolExecutor(6) as ex:
        menus = list(ex.map(fetch, candidates))
    rows, failed = [], 0
    for v, raw in menus:
        if raw is None:
            failed += 1
            continue
        m = project_menu(raw, v['id'], '', 5000)
        info = m['restaurant']
        if open_only and info['status'] != 'open':
            continue
        hits = {}
        for term in terms:
            found = [i for i in m['_all'] if item_matches(term, i['name'], i['category'])]
            named = [i for i in found if item_matches(term, i['name'], '', True)]
            pool = named or found
            if not pool:
                break
            pool.sort(key=lambda i: (i['price'] is None or i['price'] <= 0, i['price'] or 0))
            hits[term] = [{k: i[k] for k in ('id', 'name', 'price', 'category', 'image_url', 'description')} for i in pool[:3]]
        else:
            rows.append({'id': v['id'], 'name': info['name'] or v['name'], 'area': info['area'] or v['area'],
                         'chain_id': v.get('chain_id'), 'rating': v.get('rating') or info['rating'],
                         'status': info['status'], 'status_description': info['status_description'],
                         'eta': info['eta'], 'delivery_fee': info['delivery_fee'], 'fee_source': 'native_guest_branch',
                         'distance_km': v.get('distance_km'), 'matches': hits, 'url': v['url']})
    if candidates and failed == len(candidates):
        raise NativeError('MENUS_UNAVAILABLE', 'All candidate menus failed; no-match cannot be determined.')
    best = {}
    for r in rows:
        key = r.get('chain_id') or r['name'].casefold()
        score = (r['status'] == 'open', -(eta_range(r['eta']) or (999,))[0])
        if key not in best or score > best[key][0]:
            best[key] = (score, r)
    deduped = [x[1] for x in best.values()]
    deduped.sort(key=lambda r: (r['status'] != 'open', (eta_range(r['eta']) or (999,))[0], -(r['rating'] or 0)))
    for r in deduped:
        r.pop('chain_id', None)
    return {'items': deduped[:limit], 'terms': terms, 'candidates_checked': len(candidates),
            'menus_failed': failed, 'matches_before_dedupe': len(rows), 'search_source': '+'.join(sorted(sources))}


def mode_mart(tb, query, *, limit, page):
    v, result = tb.products(MART_BRANCH, query, limit, page)
    result['store'] = {'id': MART_BRANCH, 'name': clean_name(v.get('vendor_name')),
                       'delivery_fee': money(v.get('delivery_fee')), 'eta': None}
    try:
        info = tb.status(MART_BRANCH)
        result['store'].update(eta=info['eta'], status=info['status'], status_description=info['status_description'],
                               delivery_fee=info['delivery_fee'], source='native_branch_live',
                               status_checked_at=info.get('status_checked_at'), status_cache_ttl_seconds=30)
    except Exception:
        tb.note('mart_eta', 'live branch status unavailable')
    return result


def mode_stores(tb, kind, query, *, limit, stores, open_only, store_query=None):
    """Search products across grocery/pharmacy/flower stores delivering to JLT."""
    listing = tb.store_listing(kind, pages=3)
    tb.note('store_list', f'talabat.com public {kind} listing for JLT (native vendor search only returns Mart for this vertical)')
    if kind == 'groceries' and not any(s['id'] == MART_BRANCH for s in listing):
        listing.insert(0, {'id': MART_BRANCH, 'name': 'talabat mart', 'area': 'JLT', 'is_darkstore': True})
    if store_query:
        listing = [s for s in listing if store_query.casefold() in (str(s.get('name', '')) + ' ' + str(s.get('branch', ''))).casefold()]
    name_matches = [s for s in listing if query.casefold() in str(s.get('name', '')).casefold()]
    store_lookup = bool(name_matches) and not store_query
    if store_lookup:
        listing = name_matches
    # Bound status work BEFORE making network requests, not after checking the
    # entire area. Public flags only order candidates; they never certify open.
    listing.sort(key=lambda s: (s['id'] != MART_BRANCH, s.get('listing_status_code', 0) != 0))
    candidates = listing[:stores]
    live = tb.live_status([s['id'] for s in candidates])
    for s in candidates:
        info = live.get(s['id'])
        if info:
            s.update(status=info['status'], status_description=info['status_description'], eta=info['eta'],
                     delivery_fee=info['delivery_fee'], status_source=info.get('source', 'native_branch_live'),
                     minimum_order=info.get('minimum_order'),
                     status_checked_at=info.get('status_checked_at'), status_cache_ttl_seconds=30)
        else:
            s.update(status='unknown',
                     eta=s.get('listing_eta'), delivery_fee=s.get('listing_fee'), status_source='web_listing_unverified')
    pool = [s for s in candidates if not open_only or s['status'] == 'open']
    pool.sort(key=lambda s: (s['status'] != 'open', (eta_range(s.get('eta')) or (999,))[0]))
    pool = pool[:stores]

    def one(s):
        if store_lookup:
            return s, {'items': [], 'total': None}, None
        try:
            _, r = tb.products(s['id'], query, limit=limit)
            return s, r, None
        except NativeError as e:
            return s, None, e.code
    with cf.ThreadPoolExecutor(3) as ex:
        res = list(ex.map(one, pool))
    out, failed, errs = [], 0, {}
    for s, r, err in res:
        if err:
            failed += 1
            errs[err] = errs.get(err, 0) + 1
            continue
        items = [i for i in r['items'] if relevance(query, i['name']) >= 2]
        if not items and not store_lookup:
            continue
        out.append({'store_id': s['id'], 'store': s['name'], 'area': s.get('area'), 'status': s['status'],
                    'status_description': s.get('status_description'), 'eta': s.get('eta'),
                     'delivery_fee': s.get('delivery_fee'), 'status_source': s['status_source'],
                     'minimum_order': s.get('minimum_order'),
                     'min_order': s.get('minimum_order'),
                    'status_checked_at':s.get('status_checked_at'), 'status_cache_ttl_seconds':30,
                    'cheapest': min((i['price'] for i in items if i['price']), default=None),
                    'items': items[:limit], 'total_matches': r.get('total')})
    if pool and failed == len(pool):
        raise NativeError('STORES_UNAVAILABLE', 'All store product searches failed; no-match cannot be determined.')
    out.sort(key=lambda s: (s['status'] != 'open', (eta_range(s.get('eta')) or (999,))[0], s['cheapest'] or 1e9))
    return {'stores': out, 'stores_listed': len(listing), 'stores_checked': len(pool), 'stores_failed': failed,
            'stores_with_matches': len(out), 'store_errors': errs, 'vertical': kind,
            'coverage':{'bounded':True, 'status_checks':len(candidates),
                        'status_checks_failed':sum(not live.get(s['id']) or live[s['id']]['status'] == 'unknown' for s in candidates),
                        'store_list_cache_ttl_seconds':120, 'status_cache_ttl_seconds':30,
                        'product_cache_ttl_seconds':15}}


def run(mode, query='', *, branch=None, limit=10, page=1, timeout=20, exact=False,
         require_account=False, saved=None, open_only=False, terms=None, stores=12, raw=False, synonyms=False, native_only=False, force_web=False, store_query=None):
    if require_account:
        if force_web or saved is not None:
            raise NativeError('ACCOUNT_CONTEXT_CONFLICT', 'Account mode cannot use web or injected guest credentials.')
        if mode not in {'menu', 'hours', 'mart', 'restaurants'}:
            raise NativeError('ACCOUNT_MODE_UNSUPPORTED', 'Account mode supports native restaurants, menu, hours and Mart only; no store discovery fallback.')
        try:
            from talabat_account_catalog import run as account_run, TalabatError
        except ImportError:
            raise NativeError('ACCOUNT_CATALOG_DEPENDENCY_UNAVAILABLE', 'Matching account catalog/auth source or deployment is required; guest fallback is disabled.') from None
        try:
            return account_run(mode, query, branch=branch, limit=limit, page=page, timeout=timeout,
                               exact=exact, open_only=open_only, raw=raw, synonyms=synonyms)
        except TalabatError as e:
            raise NativeError(str(e), 'Verified account catalog read failed; no web or guest fallback was used.') from None
    tb = Talabat(saved, timeout, native_only=native_only, force_web=force_web)
    if native_only and mode in ('groceries', 'pharmacies', 'flowers'):
        raise NativeError('NATIVE_UNSUPPORTED', 'Store discovery requires the public web listing; --native disables it.')
    if mode == 'restaurants':
        result = mode_restaurants(tb, query, limit=limit, page=page, exact=exact, open_only=open_only, raw=raw)
    elif mode == 'hours':
        result = {'restaurant': tb.status(branch), 'items': []}
    elif mode == 'menu':
        result = tb.menu(branch, query, limit, synonyms=synonyms)
        result.pop('_all', None)
        if mode == 'hours':
            result['items'] = []
    elif mode == 'mart':
        result = mode_mart(tb, query, limit=limit, page=page)
    elif mode == 'menu-match':
        result = mode_menu_match(tb, terms or [], limit=limit, open_only=open_only)
    elif mode in ('groceries', 'pharmacies', 'flowers'):
        result = mode_stores(tb, mode, query, limit=limit, stores=stores, open_only=open_only, store_query=store_query)
    else:
        raise NativeError('USAGE', 'Unknown Talabat mode.')
    return {'ok': True, 'source': 'native_android_api', 'service': 'talabat-' + mode,
            'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'query': query if mode != 'menu-match' else ' + '.join(terms or []), 'page': page, 'location': HOME,
            'account': {'authenticated': False, 'scope': 'captured_android_guest',
                        'benefits_context': 'Guest prices, including possible new-customer promotions. Owner account/pro fees are not verified.'},
            'fallbacks': tb.fallbacks, **result,
            'notes': ['Status/ETA/fee come from the live native branch endpoint at Banyantree (status_source).',
                      'Menu presence is not orderability. No checkout totals are calculated.']}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['restaurants', 'menu', 'hours', 'mart', 'menu-match', 'groceries', 'pharmacies', 'flowers'])
    p.add_argument('query', nargs='*', default=[])
    p.add_argument('--branch', type=int)
    p.add_argument('--limit', type=int, default=10)
    p.add_argument('--page', type=int, default=1)
    p.add_argument('--timeout', type=int, default=20)
    p.add_argument('--stores', type=int, default=12)
    p.add_argument('--store', dest='store_query')
    p.add_argument('--exact', action='store_true')
    p.add_argument('--open', dest='open_only', action='store_true')
    p.add_argument('--raw', action='store_true')
    p.add_argument('--synonyms', action='store_true')
    p.add_argument('--require-account', action='store_true')
    p.add_argument('--native', action='store_true')
    p.add_argument('--web', action='store_true')
    o = p.parse_args(); start = time.monotonic()
    try:
        if not 1 <= o.limit <= (5000 if o.mode == 'menu' else 100) or not 1 <= o.page <= 100 or not 5 <= o.timeout <= 60 or not 1 <= o.stores <= 40:
            raise NativeError('USAGE', 'Invalid limit, page, stores or timeout.')
        if o.mode in ('menu', 'hours') and (not o.branch or o.branch < 1):
            raise NativeError('USAGE', 'Provide a positive branch ID.')
        terms = [t.strip() for t in o.query if t.strip()]
        if o.mode == 'menu-match' and len(terms) < 1:
            raise NativeError('USAGE', 'Provide one or more item terms, e.g. menu-match "sushi" "seaweed salad".')
        query = ' '.join(terms)
        if o.mode in ('restaurants', 'mart', 'groceries', 'pharmacies', 'flowers') and not query:
            raise NativeError('USAGE', 'Provide a search query.')
        d = run(o.mode, query, branch=o.branch, limit=o.limit, page=o.page, timeout=o.timeout, exact=o.exact,
                require_account=o.require_account, open_only=o.open_only, terms=terms, stores=o.stores,
                raw=o.raw, synonyms=o.synonyms, native_only=o.native, force_web=o.web, store_query=o.store_query)
        d['elapsed_ms'] = round(1000*(time.monotonic()-start))
        print(json.dumps(d, ensure_ascii=False)); return 0
    except NativeError as e:
        print(json.dumps({'ok': False, 'error': {'code': e.code, 'message': e.message}})); return 2 if e.code == 'USAGE' else 1
    except Exception:
        print(json.dumps({'ok': False, 'error': {'code': 'NATIVE_CAPTURE_INVALID', 'message': 'Could not use the Talabat Keychain capture. No credentials were printed.'}})); return 1


if __name__ == '__main__': sys.exit(main())
