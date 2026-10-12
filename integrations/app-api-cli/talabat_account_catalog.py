"""Profile-bound native catalog reads. No carts, checkout, address writes or cache.

Public API: run(mode, query='', *, branch=None, limit=10, page=1,
timeout=20, exact=False, open_only=False, raw=False, synonyms=False).
Runs on the main thread: the shared auth transport uses SIGALRM deadlines.
"""
import datetime as dt
import http.client
import json
import math
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

from talabat_http_orders import (TalabatError, NoRedirect, read_deadline,
                                 remaining_time, read_with_renewal)
from talabat_auth import native_headers, new_deadline

HOST = 'https://api.talabat.com'
ADDRESSES = 'https://userlocation.talabat.com/api/v2/user/addresses'
SEARCH = '/search/api/v3/vendor'
MENU = re.compile(r'/menubff/v4/branches/[1-9][0-9]{0,19}/menu')
BRANCH = re.compile(r'/grocery/v2/TB_AE/branches/[1-9][0-9]{0,19}')
PRODUCTS = re.compile(r'/grocery/v1/bff/ae/vendors/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/products/search')
MAX_BYTES = 4_000_000
MODES = {'menu', 'hours', 'mart', 'restaurants'}
FEE_SOURCE = 'native_account_catalog_not_checkout_quote'


def allowed(method, url):
    """Only established read endpoints; POST is search, never cart/checkout."""
    try:
        u = urllib.parse.urlsplit(url)
        if u.scheme != 'https' or u.fragment or u.username or u.password or u.port:
            return False
        if u.netloc == 'userlocation.talabat.com':
            return method == 'GET' and u.path == '/api/v2/user/addresses' and u.query == 'countryId=4'
        if u.netloc != 'api.talabat.com':
            return False
        if method == 'POST':
            return not u.query and (u.path == SEARCH or bool(PRODUCTS.fullmatch(u.path)))
        if method != 'GET':
            return False
        keys = [k for k, _ in urllib.parse.parse_qsl(u.query, keep_blank_values=True)]
        permitted = ({'branchId', 'areaId', 'latitude', 'longitude', 'countryId'} if MENU.fullmatch(u.path)
                     else {'areaId', 'lat', 'lon'} if BRANCH.fullmatch(u.path) else set())
        return bool(permitted) and len(keys) == len(set(keys)) and set(keys) == permitted
    except ValueError:
        return False


def wire(saved, deadline, path, *, params=None, body=None):
    url = (ADDRESSES if path == ADDRESSES else HOST + path)
    if params:
        url += '?' + urllib.parse.urlencode(params)
    method = 'GET' if body is None else 'POST'
    if not allowed(method, url):
        raise TalabatError('ENDPOINT_DENIED')
    headers = native_headers(saved)
    headers['authorization'] = 'Bearer ' + saved['auth']['access_token']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        request = urllib.request.Request(url, headers=headers, method=method,
                                        data=None if body is None else json.dumps(body, allow_nan=False).encode())
        with read_deadline(deadline) as remaining:
            with opener.open(request, timeout=remaining) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise TalabatError('RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get('hasserror') or data.get('has_error'):
                raise TalabatError('SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        raise TalabatError({401: 'AUTH_EXPIRED_RENEWAL_REQUIRED', 403: 'AUTH_FORBIDDEN',
                            429: 'RATE_LIMITED'}.get(exc.code, 'HTTP_' + str(exc.code))) from None
    except TimeoutError:
        raise TalabatError('NATIVE_READ_TIMEOUT') from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, TypeError):
        raise TalabatError('NATIVE_READ_FAILED') from None


def select_home(data, saved):
    """Reduce private addresses to in-memory location only; never first/default."""
    rows = data.get('result')
    if data.get('has_error') is not False or not isinstance(rows, list) or len(rows) > 100:
        raise TalabatError('ADDRESS_SCHEMA_CHANGED')
    homes = []
    for row in rows:
        if not isinstance(row, dict) or str(row.get('cust_id')) != str(saved['expected_profile']['id']):
            raise TalabatError('ADDRESS_OWNER_MISMATCH')
        name = re.sub(r'[^a-z0-9]', '', str(row.get('profile_name', '')).lower())
        if name in {'banyantreeresidenceshillside', 'banyantreeresidencehillside'}:
            homes.append(row)
    if len(homes) != 1:
        raise TalabatError('HOME_MISSING_OR_AMBIGUOUS')
    home = homes[0]
    if (str(home.get('suite', '')).strip() != '2104' or home.get('country') != 4
            or home.get('area_id') != 1308 or not isinstance(home.get('id'), str) or not home['id']):
        raise TalabatError('HOME_MISMATCH')
    lat, lon = home.get('latitude'), home.get('longitude')
    if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (lat, lon))
            or not 25.06 < lat < 25.10 or not 55.14 < lon < 55.18):
        raise TalabatError('HOME_LOCATION_INVALID')
    city = home.get('city_id')
    if isinstance(city, bool) or not isinstance(city, int) or city <= 0:
        raise TalabatError('HOME_LOCATION_INVALID')
    return {'latitude': lat, 'longitude': lon, 'area_id': home['area_id'], 'city_id': city}


class _Reader:
    def __init__(self, saved, deadline, catalog):
        self.saved, self.deadline, self.catalog = saved, deadline, catalog
        self.home = select_home(wire(saved, deadline, ADDRESSES, params={'countryId': 4}), saved)
        self.fallbacks = []
        self.fee_source = FEE_SOURCE

    def note(self, step, reason):
        self.fallbacks.append({'step': step, 'reason': reason})

    def menu_raw(self, branch):
        return wire(self.saved, self.deadline, f'/menubff/v4/branches/{branch}/menu', params={
            'branchId': branch, 'countryId': 4, 'areaId': self.home['area_id'],
            'latitude': self.home['latitude'], 'longitude': self.home['longitude']})

    def grocery_branch(self, branch):
        data = wire(self.saved, self.deadline, f'/grocery/v2/TB_AE/branches/{branch}', params={
            'areaId': self.home['area_id'], 'lat': self.home['latitude'], 'lon': self.home['longitude']})
        v = data.get('vendor')
        if (not isinstance(v, dict) or str(v.get('talabat_id')) != str(branch)
                or not PRODUCTS.fullmatch('/grocery/v1/bff/ae/vendors/' + str(v.get('global_id')) + '/products/search')):
            raise TalabatError('BRANCH_MISMATCH')
        return v

    def status(self, branch):
        try:
            data = self.menu_raw(branch)
        except TalabatError as exc:
            if str(exc) != 'HTTP_404':
                raise
            v = self.grocery_branch(branch)
            return {'id': branch, 'name': v.get('vendor_name'), 'status': 'unknown', 'status_code': None,
                    'status_description': 'Grocery live opening status unavailable.', 'eta': None,
                    'delivery_fee': v.get('delivery_fee'), 'minimum_order': v.get('minimum_order_value'),
                    'source': 'native_grocery_branch_status_unavailable', 'fee_source': FEE_SOURCE,
                    'area': None, 'status_cache_ttl_seconds': 0}
        vendor = data.get('vendor', {}).get('result', {}).get('restaurant', {})
        if str(vendor.get('bid')) != str(branch):
            raise TalabatError('BRANCH_MISMATCH')
        return {**self.catalog.branch_info(vendor, branch), 'fee_source': FEE_SOURCE,
                'status_cache_ttl_seconds': 0}

    def live_status(self, ids, workers=None):
        # Sequential intentionally: the auth/HTTP deadline uses main-thread SIGALRM.
        ids = list(dict.fromkeys(ids))
        if len(ids) > 8:
            self.note('status_check', 'Account path checks at most 8 branches sequentially; others remain unknown.')
        return {branch: self.status(branch) for branch in ids[:8]}

    def search_vendors(self, query, pages=1, start_page=1):
        vendors, total = [], None
        # One native page is a deliberate MVP coverage limit, not a no-results guarantee.
        data = wire(self.saved, self.deadline, SEARCH, body={
            **{k: self.home[k] for k in ('latitude', 'longitude', 'city_id')},
            'areaid': self.home['area_id'], 'country_id': 4, 'query': query.lower(),
            'vertical_ids': [0], 'filter_ids': [], 'filters': [], 'cuisine_id': 0,
            'collection_id': 0, 'page_number': start_page - 1})
        result = data.get('result')
        if not isinstance(result, dict) or not isinstance(result.get('vendors'), list):
            raise TalabatError('SCHEMA_CHANGED')
        if not result['vendors']:
            raise TalabatError('NATIVE_EMPTY_UNVERIFIED_NO_FALLBACK')
        for vendor in result['vendors']:
            if not isinstance(vendor, dict) or not re.fullmatch(r'[1-9][0-9]{0,19}', str(vendor.get('vendor_id'))):
                raise TalabatError('SCHEMA_CHANGED')
            vendors.append(self.catalog.vendor_row(vendor, 'native_account_search'))
        total = result.get('metadata', {}).get('counts', {}).get('total')
        self.note('coverage', 'One native restaurant page; at most 8 live branch checks; no web/guest fallback.')
        return vendors, total, 'native_account_search'

    def mart(self, query, limit, page):
        branch = self.catalog.MART_BRANCH
        v = self.grocery_branch(branch)
        data = wire(self.saved, self.deadline,
                    f"/grocery/v1/bff/ae/vendors/{v['global_id']}/products/search", body={
                        'config': 'Variation28', 'country_code': 'ae', 'language_code': 'en',
                        'is_darkstore': True, 'limit': limit, 'offset': (page - 1) * limit,
                        'query': query, 'customer_id': self.saved['expected_profile']['id'],
                        'filters': {'variant': 2, 'category_ids': []}, 'vertical_id': 1,
                        'branch_id': str(branch)})
        result = self.catalog.project_products(data, limit)
        result['store'] = {'id': branch, 'name': v.get('vendor_name'), 'status': 'unknown',
                           'status_description': 'Grocery live opening status unavailable.', 'eta': None,
                           'delivery_fee': v.get('delivery_fee'), 'minimum_order': v.get('minimum_order_value'),
                           'fee_source': FEE_SOURCE, 'source': 'native_account_grocery_branch'}
        return result


def run(mode, query='', *, branch=None, limit=10, page=1, timeout=20,
        exact=False, open_only=False, raw=False, synonyms=False):
    """One bounded profile+Home+catalog operation; at most one auth renewal total.

    Returns projections only. Raises TalabatError on unsupported modes, binding,
    transport, or dependency errors. No external cache and no fallback transport.
    """
    if mode not in MODES:
        raise TalabatError('ACCOUNT_MODE_UNSUPPORTED')
    if threading.current_thread() is not threading.main_thread():
        raise TalabatError('NATIVE_DEADLINE_UNAVAILABLE')
    if (type(limit) is not int or not 1 <= limit <= (5000 if mode == 'menu' else 100)
            or type(page) is not int or not 1 <= page <= 100
            or not isinstance(query, str) or len(query) > 200
            or (mode in {'restaurants', 'mart'} and not query.strip())
            or (mode in {'menu', 'hours'} and (type(branch) is not int or not 0 < branch < 10**20))):
        raise TalabatError('INVALID_CATALOG_ARGUMENT')
    deadline = new_deadline(timeout)
    import talabat_native as catalog

    def operation(saved, end):
        reader = _Reader(saved, end, catalog)
        if mode == 'menu':
            result = catalog.project_menu(reader.menu_raw(branch), branch, query, limit, synonyms=synonyms)
            result.pop('_all', None)
            result['restaurant']['fee_source'] = FEE_SOURCE
        elif mode == 'hours':
            result = {'restaurant': reader.status(branch), 'items': []}
        elif mode == 'mart':
            result = reader.mart(query, limit, page)
            if open_only:
                result['items'] = []
                reader.note('open_filter', 'Mart opening status is unknown; excluded by --open.')
        else:
            if raw and open_only:
                raise TalabatError('ACCOUNT_RAW_OPEN_UNSUPPORTED')
            result = catalog.mode_restaurants(reader, query, limit=limit, page=page,
                                              exact=exact, open_only=open_only, raw=raw)
        remaining_time(end)
        return {'ok': True, 'source': 'native_account_api', 'service': 'talabat-' + mode,
                'fetched_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'query': query, 'page': page,
                'location': {'name': 'Banyantree Residences Hillside', 'source': 'talabat_saved_address',
                             'country_id': 4, 'area_id': reader.home['area_id'], 'saved_address_verified': True},
                'account': {'authenticated': True, 'scope': 'verified_android_account',
                            'profile_verified': True, 'saved_address_verified': True, 'benefits_verified': False,
                            'benefits_context': 'Account bearer and saved Home verified; Pro entitlement and final fees unknown.'},
                'checkout_quote_verified': False, 'fallbacks': reader.fallbacks, **result,
                'notes': ['Catalog fees are not checkout quotes or verified Pro benefits.',
                          'Menu presence is not orderability. HTTP checkout remains unverified.']}

    try:
        return read_with_renewal(operation, deadline)
    except catalog.NativeError as exc:
        # Projection failures have the same public exception contract as reads.
        raise TalabatError(exc.code) from None
    except (KeyError, TypeError, AttributeError, IndexError):
        raise TalabatError('SCHEMA_CHANGED') from None
