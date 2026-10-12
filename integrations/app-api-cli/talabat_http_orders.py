"""Talabat HTTP tracking with one bounded token renewal; no OTP or order mutations."""
import base64
from contextlib import contextmanager
import datetime as dt
import http.client
import json
import math
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'capture'))
from keychain import load

HOST = 'https://api.talabat.com'
PROFILE = '/customers/v1/profile'
TRACKING = '/order-tracking/v4/order-tracking/'
MAX_BYTES = 2_000_000
# Only independently verified native enums. New states stay unknown, not guessed.
STAGES = {'order_delivered': 'delivered', 'order_almostready': 'preparing',
          'order_delivering': 'out for delivery', 'order_preparing': 'preparing',
          'order_confirming': 'placed'}
# order_confirmingdelayed (the unpaid-zombie shape) deliberately stays unmapped.
ACTIVE = {'preparing', 'out for delivery'}


class TalabatError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def remaining_time(deadline):
    remaining = deadline - time.monotonic()
    if not math.isfinite(remaining) or remaining <= 0:
        raise TalabatError('NATIVE_READ_TIMEOUT')
    return remaining


@contextmanager
def read_deadline(deadline):
    # These CLI/tracker entry points run on the main thread. Socket timeouts
    # alone do not bound drip-fed headers/bodies. Never replace another caller's
    # timer or silently downgrade to an unbounded read in a threaded caller.
    remaining = remaining_time(deadline)
    if threading.current_thread() is not threading.main_thread() or any(signal.getitimer(signal.ITIMER_REAL)):
        raise TalabatError('NATIVE_DEADLINE_UNAVAILABLE')
    previous = signal.getsignal(signal.SIGALRM)

    def expired(_signum, _frame):
        raise TalabatError('NATIVE_READ_TIMEOUT')

    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, remaining)
        yield remaining
        remaining_time(deadline)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def account(allow_expired=False):
    try:
        saved = load('talabat-account') or {}
    except Exception:
        raise TalabatError('ACCOUNT_STORAGE_UNAVAILABLE') from None
    if not isinstance(saved, dict):
        raise TalabatError('ACCOUNT_STORAGE_INVALID')
    auth = saved.get('auth') or {}
    expected = saved.get('expected_profile') or {}
    if not isinstance(auth, dict) or not isinstance(expected, dict):
        raise TalabatError('ACCOUNT_STORAGE_INVALID')
    if not isinstance(auth.get('access_token'), str) or not auth['access_token']:
        raise TalabatError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY')
    if saved.get('account_verified') is not True or set(expected) != {'id', 'mobile_country_code', 'mobile_number'}:
        raise TalabatError('ACCOUNT_IDENTITY_NOT_VERIFIED')
    if (not all(re.fullmatch(r'[0-9]+', str(expected[k] or '')) for k in expected)
            or str(expected['mobile_country_code']) != '971'):
        raise TalabatError('ACCOUNT_IDENTITY_NOT_VERIFIED')
    if str(expected['id']) != str(auth.get('customerId')) or saved.get('country') != 'AE':
        raise TalabatError('ACCOUNT_IDENTITY_MISMATCH')
    try:
        part = auth['access_token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        expires = claims['exp']
        if isinstance(expires, bool) or not isinstance(expires, (float, int)):
            raise ValueError()
    except (IndexError, KeyError, ValueError, TypeError):
        raise TalabatError('ACCOUNT_TOKEN_INVALID') from None
    if not math.isfinite(expires):
        raise TalabatError('ACCOUNT_TOKEN_INVALID')
    headers = saved.get('headers')
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                               for k, v in headers.items()):
        raise TalabatError('ACCOUNT_HEADERS_INVALID')
    # The OTP endpoint's expires_in is an absolute epoch, NOT a TTL.
    # JWT decoding only controls renewal; live profile verifies the actual account.
    if not allow_expired and expires <= time.time() + 30:
        raise TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
    return saved


def request(path, saved, deadline):
    if path != PROFILE and not re.fullmatch(re.escape(TRACKING) + r'[0-9]{1,20}', path):
        raise TalabatError('ENDPOINT_DENIED')
    remaining_time(deadline)
    headers = {k: v for k, v in (saved.get('headers') or {}).items() if k.lower() not in {
        'authorization', 'cookie', 'host', 'content-length', 'accept-encoding', 'connection',
        'if-none-match', 'if-modified-since', 'sentry-trace', 'baggage', 'x-menu-experiments'}}
    headers.update({'Authorization': 'Bearer ' + saved['auth']['access_token'],
                    'Accept': 'application/json', 'Cache-Control': 'no-cache',
                    'X-Request-ID': str(uuid.uuid4())})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        req = urllib.request.Request(HOST + path, headers=headers, method='GET')
        with read_deadline(deadline) as remaining:
            with opener.open(req, timeout=remaining) as response:
                raw = response.read(MAX_BYTES + 1)
            remaining_time(deadline)
            if len(raw) > MAX_BYTES:
                raise TalabatError('RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise TalabatError('SCHEMA_CHANGED')
        return data
    except urllib.error.HTTPError as exc:
        exc.close()
        raise TalabatError({401: 'AUTH_EXPIRED_RENEWAL_REQUIRED', 403: 'AUTH_FORBIDDEN',
                            404: 'ORDER_NOT_FOUND', 429: 'RATE_LIMITED'}.get(exc.code, 'HTTP_' + str(exc.code))) from None
    except TimeoutError:
        raise TalabatError('NATIVE_READ_TIMEOUT') from None
    except (urllib.error.URLError, http.client.HTTPException, ValueError, OSError):
        raise TalabatError('NATIVE_READ_FAILED') from None


def verify_profile(data, saved):
    expected = saved['expected_profile']
    if not all(data.get(k) == v for k, v in expected.items()):
        raise TalabatError('ACCOUNT_IDENTITY_MISMATCH')


def read_with_renewal(operation, deadline):
    """Retry the entire profile+read once, only on local expiry or HTTP 401.

    Capture the rejected credential from the SAME snapshot as the read. A newer
    credential can then be reused by maintenance's cross-process coalescing.
    No outer caller should add another renewal retry.
    """
    from talabat_auth import expiry, refresh
    for attempt in range(2):
        remaining_time(deadline)
        saved = account(allow_expired=True)
        try:
            if expiry(saved['auth']) <= time.time() + 30:
                raise TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
            verify_profile(request(PROFILE, saved, deadline), saved)
            result = operation(saved, deadline)
            remaining_time(deadline)
            return result
        except TalabatError as exc:
            if str(exc) != 'AUTH_EXPIRED_RENEWAL_REQUIRED' or attempt:
                raise
        refresh(rejected_token=saved['auth']['access_token'],
                timeout=min(120, remaining_time(deadline)), deadline=deadline)
        remaining_time(deadline)


def _props(value):
    return value.get('properties', {}) if isinstance(value, dict) and isinstance(value.get('properties', {}), dict) else {}


def _data(value):
    return value.get('data', {}) if isinstance(value, dict) and isinstance(value.get('data', {}), dict) else {}


def _safe_text(value):
    if isinstance(value, str) and 0 < len(value) <= 180 and all(ord(c) >= 32 for c in value):
        return value
    return None


def _shown(props):
    # Unknown visibility controls fail closed, rather than treating "false" as false.
    return (all(props.get(k, False) is False for k in ('hidden', 'offstage'))
            and all(props.get(k, True) is True for k in ('visible', 'show_rider_details', 'showRiderDetails')))


def visible_details(data, order, stage):
    """Inspect only instantiated, layout-referenced cells. Never search templates."""
    empty = {'eta_text': None, 'eta_source': None, 'status_text': None, 'status_text_source': None, 'rider': None}
    if stage not in ACTIVE:
        return empty
    layouts, widgets = data.get('layouts'), data.get('widgets')
    if not isinstance(layouts, list) or not isinstance(widgets, dict):
        return empty
    referenced = {key for layout in layouts if isinstance(layout, dict) and layout.get('name') == 'body'
                  for key in (layout.get('column') if isinstance(layout.get('column'), list) else []) if isinstance(key, str)}
    header_key = 'header_with_lifecycle_order_component'
    header = widgets.get(header_key, {})
    if (header_key not in referenced or not isinstance(header, dict)
            or header.get('type') != 'Stack' or not _shown(header)):
        return empty
    children = _data(header).get('children', [])
    matches = []
    if not isinstance(children, list):
        return empty
    # Inspect the entire size-bounded response before claiming uniqueness. A
    # duplicate beyond an arbitrary prefix must still suppress projection.
    for i, child in enumerate(children):
        if not isinstance(child, dict) or child.get('type') != 'FluidComponent' or not _shown(child):
            continue
        component = _data(child).get('component')
        props = _props(component)
        container = _props(props.get('order_container'))
        cells = container.get('cells')
        if not _shown(props) or not _shown(container) or container.get('title_offstage') is not False or not isinstance(cells, list):
            continue
        for j, cell in enumerate(cells):
            p = _props(cell)
            if (isinstance(cell, dict) and cell.get('template_id') == 'active-order-item-v2'
                    and str(p.get('tracking_key')) == order and _shown(p)):
                matches.append((p, f'widgets.{header_key}.data.children[{i}].data.component.properties.order_container.properties.cells[{j}].properties'))
    # No exact visible active order => no rider fallback, even if rider_info exists.
    if len(matches) != 1:
        return empty
    cell, source = matches[0]
    title = _safe_text(cell.get('title'))
    eta = title if title and re.fullmatch(r'Arrives (?:in|within) [0-9]{1,3}(?:-[0-9]{1,3})? mins?', title) else None
    subtitle = _safe_text(cell.get('sub_title'))
    result = {**empty, 'eta_text': eta, 'eta_source': source + '.title' if eta else None,
              'status_text': subtitle, 'status_text_source': source + '.sub_title' if subtitle else None}
    key = 'tlb_app_bff_passthrough'
    widget = widgets.get(key, {})
    if (key not in referenced or not isinstance(widget, dict)
            or widget.get('type') != 'FluidComponent' or not _shown(widget)):
        return result
    component = _data(widget).get('component')
    props = _props(component)
    children = props.get('children')
    if not _shown(props) or not isinstance(children, list):
        return result
    riders = []
    for i, child in enumerate(children):
        p = _props(child)
        if (isinstance(child, dict) and child.get('template_id') == 'rider_info' and _shown(p)
                and p.get('has_text') is True and p.get('has_contact_bottom_sheet') is True
                and p.get('text') == 'is your delivery hero for today'):
            name = _safe_text(p.get('title'))
            if name:
                riders.append({'name': name, 'source': f'widgets.{key}.data.component.properties.children[{i}].properties.title',
                               'visibility_source': 'instantiated_rider_info_on_exact_active_order'})
    if len(riders) == 1:
        result['rider'] = riders[0]
    return result


def project(data, order):
    attrs = data.get('common_tracking_event_attributes')
    if (data.get('type') != 'OrderTrackingScreen' or not isinstance(attrs, dict)
            or str(attrs.get('order_id')) != order):
        raise TalabatError('ORDER_MISMATCH_OR_SCHEMA_CHANGED')
    raw = attrs.get('delivery_status')
    if not isinstance(raw, str) or not re.fullmatch(r'[a-z_]{1,64}', raw):
        raise TalabatError('SCHEMA_CHANGED')
    stage = STAGES.get(raw, 'unknown')
    details = visible_details(data, order, stage)
    stage_source = 'common_tracking_event_attributes.delivery_status'
    if stage == 'out for delivery' and details['status_text'] == 'Your order is nearby':
        stage = 'nearby'
        stage_source = details['status_text_source']
    return {'ok': True, 'app': 'talabat', 'order': order, 'source': 'native_order_api',
            'status': stage, 'raw_status': raw, 'status_source': stage_source,
            'account_verified': True, 'identity_verified': True,
            'eta': None, **details,
            'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
            'coverage': 'verified_preparing_out_for_delivery_nearby_delivered; display_eta_only_no_absolute_timezone; instantiated_rider_name_only'}


def track(order, timeout=10):
    if not isinstance(order, str) or not re.fullmatch(r'[0-9]{1,20}', order):
        raise TalabatError('INVALID_ORDER_ID')
    from talabat_auth import new_deadline
    deadline = new_deadline(timeout)
    return read_with_renewal(lambda saved, end: project(request(TRACKING + order, saved, end), order), deadline)
