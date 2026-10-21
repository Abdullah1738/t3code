"""Bounded read-only Talabat order history. No lazy-load or action URLs followed."""
import argparse
import datetime as dt
from http.client import HTTPException
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import talabat_auth as auth
import talabat_http_orders as http

PATH = '/vendor-list/v1/orders/country/4'
# The existing verified Home pin is a search context, not address verification.
HOME = {'latitude': '25.0778251', 'longitude': '55.1569039'}
PAGE_SIZE = 75
MAX_PAGES = 5
STAGES = {'Delivered': 'delivered', 'Preparing': 'preparing', 'Delivering': 'out for delivery'}


def page_request(saved, page, deadline):
    if type(page) is not int or not 0 <= page <= 999:
        raise http.TalabatError('INVALID_PAGE')
    query = urllib.parse.urlencode({**HOME, 'page_number': page, 'page_size': PAGE_SIZE})
    headers = auth.native_headers(saved)
    headers['authorization'] = 'Bearer ' + saved['auth']['access_token']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), http.NoRedirect())
    try:
        req = urllib.request.Request(http.HOST + PATH + '?' + query, headers=headers, method='GET')
        with http.read_deadline(deadline) as remaining:
            with opener.open(req, timeout=remaining) as response:
                raw = response.read(http.MAX_BYTES + 1)
            if len(raw) > http.MAX_BYTES:
                raise http.TalabatError('RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise http.TalabatError('ORDER_LIST_SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        auth.http_ok(exc.code)
        raise http.TalabatError('UNEXPECTED_HTTP_STATUS') from None
    except TimeoutError:
        raise http.TalabatError('NATIVE_READ_TIMEOUT') from None
    except (urllib.error.URLError, HTTPException, ValueError, OSError):
        raise http.TalabatError('NATIVE_READ_FAILED') from None


def _text(value):
    if not isinstance(value, str) or len(value) > 160 or any(ord(c) < 32 for c in value):
        return None
    return value


def project_order(row):
    if not isinstance(row, dict):
        raise http.TalabatError('ORDER_LIST_SCHEMA_CHANGED')
    order = row.get('id')
    if isinstance(order, bool) or not isinstance(order, (str, int)) or not re.fullmatch(r'[0-9]{1,20}', str(order)):
        raise http.TalabatError('ORDER_LIST_SCHEMA_CHANGED')
    raw = row.get('status')
    if not isinstance(raw, str) or not re.fullmatch(r'[A-Za-z_ -]{1,64}', raw):
        raise http.TalabatError('ORDER_LIST_SCHEMA_CHANGED')
    # Native delivery_date is timezone-qualified. Keep its native meaning: it is
    # not an authoritative place timestamp and must not be used as one.
    native_date = row.get('delivery_date')
    dated = None
    if type(native_date) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} [A-Za-z0-9+:-]+', native_date):
        try:dated = dt.datetime.strptime(native_date.rsplit(' ', 1)[0], '%Y-%m-%d %H:%M:%S %z').isoformat()
        except ValueError:pass
    branch = row.get('branch_id')
    return {'order': str(order), 'status': STAGES.get(raw, 'unknown'), 'raw_status': raw,
            'branch_id':branch if type(branch) is int and branch > 0 else None,
            'native_delivery_date':dated,
            'branch_name': _text(row.get('branch_name')), 'chain_name': _text(row.get('chain_name')),
            'source': 'native_order_list_api', 'eta': None, 'rider': None,
            'delivery_address': None, 'is_home': None, 'home_match_reason': 'detail_read_required'}


def list_orders(page=0, pages=1, limit=20, timeout=20, with_addresses=False):
    """Read at most five 75-row pages; disclose all pagination/output bounds.

    One automatic refresh grant on expiry/401, never OTP. The complete profile
    and pagination sequence retries from scratch within the original deadline.
    """
    if type(page) is not int or not 0 <= page <= 999:
        raise http.TalabatError('INVALID_PAGE')
    if type(pages) is not int or not 1 <= pages <= MAX_PAGES or page + pages > 1000:
        raise http.TalabatError('INVALID_PAGE_BOUND')
    if type(limit) is not int or not 1 <= limit <= MAX_PAGES * PAGE_SIZE:
        raise http.TalabatError('INVALID_LIMIT')
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 120):
        raise http.TalabatError('INVALID_TIMEOUT')
    deadline = time.monotonic() + timeout
    def operation(saved, end):
        result = _list_orders(saved, end, page, pages, limit)
        if with_addresses:
            for row in result['orders']:
                try:
                    detail = http.project(http.request(http.TRACKING + row['order'], saved, end), row['order'])
                    row.update({key: detail[key] for key in ('delivery_address', 'is_home', 'home_match_reason')})
                except http.TalabatError as exc:
                    if str(exc) in ('AUTH_EXPIRED_RENEWAL_REQUIRED', 'AUTH_FORBIDDEN', 'ACCOUNT_IDENTITY_MISMATCH'):
                        raise
                    row['delivery_address_error'] = str(exc)
        return result
    return http.read_with_renewal(operation, deadline)


def _list_orders(saved, deadline, page, pages, limit, *, stop_at=None):
    orders, seen, totals = [], set(), []
    rows_fetched = pages_fetched = duplicates = 0
    is_last = False
    for index in range(page, page + pages):
        data = page_request(saved, index, deadline)
        rows, last, total = data.get('orders'), data.get('is_last_page'), data.get('total_orders')
        if (not isinstance(rows, list) or len(rows) > PAGE_SIZE or type(last) is not bool
                or type(total) is not int or total < 0 or total < len(rows)):
            raise http.TalabatError('ORDER_LIST_SCHEMA_CHANGED')
        pages_fetched += 1
        rows_fetched += len(rows)
        totals.append(total)
        is_last = last
        for row in rows:
            result = project_order(row)
            if result['order'] in seen:
                duplicates += 1
                continue
            seen.add(result['order'])
            if len(orders) < limit:
                orders.append(result)
        if is_last or len(orders) >= limit or (stop_at is not None and stop_at in seen):
            break
        if not rows:
            raise http.TalabatError('ORDER_LIST_PAGINATION_STALLED')
    http.remaining_time(deadline)
    changed = len(set(totals)) > 1 or duplicates > 0
    complete = page == 0 and is_last and len(orders) == totals[-1] and not changed
    return {'ok': True, 'app': 'talabat', 'source': 'native_order_list_api',
            'account_verified': True, 'identity_verified': True, 'orders': orders,
            'truncated': not complete, 'total_orders': totals[-1],
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
            'pagination': {'first_page': page, 'page_size': PAGE_SIZE,
                           'pages_requested': pages, 'pages_fetched': pages_fetched,
                           'rows_fetched': rows_fetched, 'output_limit': limit,
                           'is_last_page': is_last, 'earlier_pages_omitted': page > 0,
                           'output_truncated': len(seen) > len(orders),
                           'duplicates_omitted': duplicates, 'snapshot_changed': changed,
                           'next_page': None if is_last else page + pages_fetched},
             'coverage': 'bounded_native_order_history; delivered_preparing_delivering_verified; other_statuses_eta_rider_unverified'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--page', type=int, default=0, help='zero-based native page')
    parser.add_argument('--pages', type=int, default=1, help='1 to 5 pages')
    parser.add_argument('--limit', type=int, default=20, help='1 to 375 projected rows')
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--with-addresses', action='store_true', help='read exact-order addresses within the same timeout')
    args = parser.parse_args(argv)
    try:
        print(json.dumps(list_orders(**vars(args))))
        return 0
    except http.TalabatError as exc:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': str(exc)}))
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': 'NATIVE_READ_FAILED'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
