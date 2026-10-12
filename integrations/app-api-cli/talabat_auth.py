"""Explicit Talabat account maintenance. Secrets stay in memory and Keychain."""
import argparse
import base64
import copy
from contextlib import contextmanager
import fcntl
import http.client
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Source checkouts deliberately use the deployed Security.framework adapter.
sys.path.insert(0, str(Path.home() / '.local/share/app-api-cli/capture'))
from keychain import load, store
from talabat_http_orders import (HOST, PROFILE, TalabatError, NoRedirect,
                                 read_deadline, remaining_time, verify_profile)

ACCOUNT = 'talabat-account'
PENDING = 'talabat-account-maintenance'
AAA = 'https://talabat.dh-auth.io/api/v5/oauth2/token'
OTP_REQUEST = HOST + '/customers/v1/AE/mobile-verification/otp-request'
OTP_LOGIN = HOST + '/customers/v1/oauth2/otp-login'
LOCK = Path.home() / '.local/state/app-api-cli/talabat-account.lock'
MAX_BYTES = 2_000_000
# Completed auth responses get one small local durability phase, even after the
# network budget expires. This does not extend the original validation budget.
RETENTION_SECONDS = 2
OMIT = {'authorization', 'cookie', 'host', 'content-length', 'accept-encoding',
        'connection', 'sentry-trace', 'baggage', 'x-menu-experiments',
        'x-requestid', 'x-primary-request-id', 'x-request-id', 'x-correlation-id',
        'x-captcha-token', 'x-captcha-token-hashkey', 'incognia-token',
        'if-none-match', 'if-modified-since', 'x-device',
        'x-refresh-token-created-at'}


def read_store(name):
    try:
        value = load(name)
    except Exception:
        raise TalabatError('ACCOUNT_STORAGE_UNAVAILABLE') from None
    if value is not None and not isinstance(value, dict):
        raise TalabatError('ACCOUNT_STORAGE_INVALID')
    return value or {}


def write_store(name, value):
    try:
        store(name, value)
    except Exception:
        raise TalabatError('ACCOUNT_STORAGE_WRITE_FAILED_STOP') from None


def new_deadline(timeout):
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 120):
        raise TalabatError('INVALID_TIMEOUT')
    return time.monotonic() + timeout


@contextmanager
def account_lock(timeout=5):
    LOCK.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        until = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise TalabatError('ACCOUNT_MAINTENANCE_BUSY') from None
                time.sleep(min(0.05, max(0, until - time.monotonic())))
        yield
    finally:
        os.close(fd)


def expiry(auth):
    try:
        part = auth['access_token'].split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        value = claims['exp']
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError()
        return value
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        raise TalabatError('ACCOUNT_TOKEN_INVALID') from None


def binding(saved):
    expected, auth = saved.get('expected_profile'), saved.get('auth')
    if (saved.get('account_verified') is not True or saved.get('country') != 'AE'
            or not isinstance(expected, dict) or not isinstance(auth, dict)
            or set(expected) != {'id', 'mobile_country_code', 'mobile_number'}
            or not all(re.fullmatch(r'[0-9]+', str(x)) for x in expected.values())
            or str(expected.get('mobile_country_code')) != '971'
            or str(auth.get('customerId')) != str(expected.get('id'))):
        raise TalabatError('ACCOUNT_IDENTITY_NOT_VERIFIED')
    headers = saved.get('headers')
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                               for k, v in headers.items()):
        raise TalabatError('ACCOUNT_HEADERS_INVALID')
    return saved


def native_headers(saved):
    headers = {k.lower(): v for k, v in saved['headers'].items() if k.lower() not in OMIT}
    headers.update({'accept': 'application/json', 'content-type': 'application/json',
                    'cache-control': 'no-cache', 'x-request-id': str(uuid.uuid4())})
    return headers


def _retain_raw(pending, code, raw, metadata, operation):
    """Persist opaque, bounded bytes before parsing; only Keychain, never logs."""
    with read_deadline(time.monotonic() + RETENTION_SECONDS):
        pending.update(state='raw_response_retained', http_status=code,
                       response_body_b64=base64.b64encode(raw).decode('ascii'),
                       response_metadata=metadata, response_operation=operation)
        write_store(PENDING, pending)


def wire(url, saved, deadline, body=None, extra=None, authenticated=False, pending=None):
    """Bounded exact-route transport. Never retry a mutation or log its response."""
    status_path = '/customers/v1/account-status'
    parsed = urllib.parse.urlsplit(url)
    status_ok = (parsed.scheme == 'https' and parsed.netloc == 'api.talabat.com'
                 and parsed.path == status_path and not parsed.fragment and body is None)
    allowed_get = url == HOST + PROFILE or status_ok
    allowed_post = url in {AAA, OTP_REQUEST, OTP_LOGIN}
    if not ((body is None and allowed_get) or (isinstance(body, dict) and allowed_post)):
        raise TalabatError('ENDPOINT_DENIED')
    headers = native_headers(saved)
    if extra:
        headers.update({k.lower(): v for k, v in extra.items()})
    if authenticated:
        if url != HOST + PROFILE:
            raise TalabatError('ENDPOINT_DENIED')
        headers['authorization'] = 'Bearer ' + saved['auth']['access_token']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        request = urllib.request.Request(url, headers=headers, method='POST' if body is not None else 'GET',
                                         data=json.dumps(body).encode() if body is not None else None)
        raw = None
        try:
            with read_deadline(deadline) as remaining:
                try:
                    response = opener.open(request, timeout=remaining)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    code = response.code
                    metadata = {k.lower(): v for k, v in response.headers.items()
                                if k.lower() in {'x-device', 'x-refresh-token-created-at'}}
                    raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise TalabatError('RESPONSE_TOO_LARGE')
        finally:
            # The original alarm has been restored before this runs. Its final
            # deadline check or close may have failed AFTER complete reception.
            if body is not None and pending is not None and raw is not None and len(raw) <= MAX_BYTES:
                _retain_raw(pending, code, raw, metadata,
                            'otp_request' if url == OTP_REQUEST else 'credentials')
        with read_deadline(deadline):
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise TalabatError('SCHEMA_CHANGED')
        return code, data, metadata
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError, TypeError):
        raise TalabatError('HTTP_EXCHANGE_FAILED_NO_RETRY') from None


def http_ok(code):
    if not 200 <= code < 300:
        raise TalabatError({400: 'AUTH_REQUEST_REJECTED', 401: 'AUTH_EXPIRED_RENEWAL_REQUIRED',
                            403: 'AUTH_FORBIDDEN', 429: 'RATE_LIMITED'}.get(code, 'HTTP_' + str(code)))


def validate(saved, deadline):
    remaining_time(deadline)
    binding(saved)
    if expiry(saved['auth']) <= time.time() + 30:
        raise TalabatError('AUTH_EXPIRED_RENEWAL_REQUIRED')
    code, data, _ = wire(HOST + PROFILE, saved, deadline, authenticated=True)
    http_ok(code)
    verify_profile(data, saved)
    remaining_time(deadline)


def status():
    saved = binding(read_store(ACCOUNT))
    expires = expiry(saved['auth'])
    pending = read_store(PENDING)
    refresh_auth = saved.get('refresh_auth') or {}
    renewal = saved.get('renewal') or {}
    return {'ok': True, 'app': 'talabat', 'account_verified': True,
            'expires_at': expires, 'expires_in_seconds': max(0, int(expires - time.time())),
            'expired': expires <= time.time() + 30,
            'refresh_material_present': bool(saved['auth'].get('refresh_token')
                                             and refresh_auth.get('client_secret')
                                             and renewal.get('device_token')),
            'refresh_verified': saved.get('refresh_verified') is True,
            'maintenance_state': pending.get('state', 'none'),
            'profile_verified_at': saved.get('profile_verified_at'),
            'automatic_otp': False}


def apk_constants(pool):
    """Read the two public 13.95.0 production constants, never persist APK text."""
    try:
        text = Path(pool).read_text()
        result = {}
        for name, offset in [('client_secret', '7c70'), ('captcha_hashkey', '55c70')]:
            found = re.search(r'^\[pp\+0x' + offset + r'\] String: (.*)$', text, re.M)
            value = json.loads(found[1].replace('\\?', '?')) if found else None
            if not isinstance(value, str) or not value:
                raise ValueError()
            result[name] = value
        return result
    except (OSError, ValueError, TypeError):
        raise TalabatError('PUBLIC_APK_CONSTANTS_UNAVAILABLE') from None


def _pending_allowed(pending):
    if pending.get('state') not in {None, 'published'}:
        raise TalabatError('PENDING_MAINTENANCE_RECONCILE_REQUIRED')


def login_request(pool, timeout=25):
    """Explicit existing-account SMS request; never invoked by reads or refresh."""
    deadline = new_deadline(timeout)
    with account_lock():
        _pending_allowed(read_store(PENDING))
        saved = binding(read_store(ACCOUNT))
        constants = apk_constants(pool)
        expected = saved['expected_profile']
        query = urllib.parse.urlencode({k: expected[k] for k in ('mobile_country_code', 'mobile_number')})
        code, data, _ = wire(HOST + '/customers/v1/account-status?' + query + '&country_code=AE',
                             saved, deadline)
        http_ok(code)
        if data.get('account_status') != 'CustomerExist':
            raise TalabatError('EXISTING_ACCOUNT_REQUIRED_NO_REGISTRATION')
        pending = {'state': 'otp_request_in_flight', 'kind': 'login', 'started_at': time.time(),
                   'expected_profile': copy.deepcopy(expected), 'base': saved,
                   'constants': constants, 'operation_id': str(uuid.uuid4())}
        write_store(PENDING, pending)
        body = {k: expected[k] for k in ('mobile_country_code', 'mobile_number')}
        body.update(channel='sms', source='OtpLogin')
        code, data, _ = wire(OTP_REQUEST, saved, deadline, body,
                             {'X-Captcha-Token-HashKey': constants['captcha_hashkey']}, pending=pending)
        return _retain_ticket(pending, code, data)


def _retain_ticket(pending, code, data):
    pending.update(state='otp_request_rejected', http_status=code)
    ticket = data.get('verification_ticket')
    if 200 <= code < 300 and isinstance(ticket, str) and ticket:
        pending.update(state='awaiting_sms', verification_ticket=ticket)
    write_store(PENDING, pending)
    http_ok(code)
    if pending['state'] != 'awaiting_sms':
        raise TalabatError('OTP_RESPONSE_SCHEMA_CHANGED_NO_RETRY')
    return {'ok': True, 'state': 'awaiting_sms', 'sms_requested': True, 'retry': False}


def fresh_sms(started):
    """Read only fresh inbound Talabat OTPs. No code is accepted on argv."""
    if not isinstance(started, (int, float)) or not 0 <= time.time() - started <= 600:
        raise TalabatError('NO_FRESH_PENDING_LOGIN')
    try:
        db = sqlite3.connect('file:' + str(Path.home() / 'Library/Messages/chat.db') + '?mode=ro', uri=True)
        try:
            rows = db.execute('SELECT m.text, h.id FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id '
                              'WHERE m.is_from_me=0 AND m.date>? ORDER BY m.date DESC LIMIT 100',
                              (int((started - 978307200) * 1e9),)).fetchall()
        finally:
            db.close()
    except sqlite3.Error:
        raise TalabatError('LOCAL_MESSAGES_UNAVAILABLE') from None
    codes = set()
    for text, sender in rows:
        if not isinstance(text, str) or not isinstance(sender, str) or sender.casefold() != 'talabat':
            continue
        match = re.search(r'your talabat verification code\s*:\s*(\d{6})\b', text, re.I)
        if match:
            codes.add(match[1])
    if len(codes) != 1:
        raise TalabatError('OTP_NOT_UNIQUELY_AVAILABLE')
    return codes.pop()


def _candidate(pending, auth, metadata):
    saved = copy.deepcopy(pending['base'])
    saved['auth'] = dict(auth) if pending['kind'] == 'login' else {**saved['auth'], **auth}
    saved['renewal'] = {**saved.get('renewal', {})}
    if metadata.get('x-device'):
        saved['renewal']['device_token'] = metadata['x-device']
    if metadata.get('x-refresh-token-created-at'):
        saved['renewal']['refresh_token_created_at'] = metadata['x-refresh-token-created-at']
    if pending['kind'] == 'login':
        # A new login must not inherit a previous login's device binding.
        saved['renewal'] = {'device_token': metadata.get('x-device'),
                            'refresh_token_created_at': metadata.get('x-refresh-token-created-at')}
        saved['refresh_auth'] = {'client_id': 'android', 'scope': '',
                                 'client_secret': pending['constants']['client_secret']}
    saved.update(captured_at=time.time(), source='original_apk_http_' + pending['kind'],
                 refresh_verified=pending['kind'] == 'refresh')
    saved['maintenance_operation_id'] = pending['operation_id']
    return saved


def _retain(pending, code, data, metadata):
    # Write the entire successful response to Keychain before interpreting it.
    # This also preserves a rotated token if profile validation or parsing fails.
    pending.update(state='response_retained', http_status=code, response_auth=data,
                   response_metadata=metadata)
    write_store(PENDING, pending)
    http_ok(code)
    if not isinstance(data.get('access_token'), str) or not data['access_token']:
        raise TalabatError('AUTH_RESPONSE_SCHEMA_CHANGED_RECONCILE_REQUIRED')
    pending['candidate'] = _candidate(pending, data, metadata)
    pending['state'] = 'candidate_retained'
    write_store(PENDING, pending)


def _publish(pending, deadline):
    saved = pending['candidate']
    active = read_store(ACCOUNT)
    if active.get('maintenance_operation_id') == pending['operation_id']:
        write_store(PENDING, {'state': 'published', 'kind': pending['kind'],
                              'operation_id': pending['operation_id']})
        return status()
    if active != pending['base']:
        raise TalabatError('ACCOUNT_CHANGED_RECONCILE_REQUIRED')
    validate(saved, deadline)
    if not isinstance(saved['auth'].get('refresh_token'), str) or not saved['auth']['refresh_token']:
        raise TalabatError('REFRESH_TOKEN_MISSING_CANDIDATE_RETAINED')
    if not saved.get('renewal', {}).get('device_token'):
        raise TalabatError('RENEWAL_DEVICE_HEADER_MISSING_CANDIDATE_RETAINED')
    saved['profile_verified_at'] = time.time()
    # All legitimate writers must hold account_lock. This second comparison
    # detects edits during validation, but is not an atomic Keychain CAS.
    if read_store(ACCOUNT) != pending['base']:
        raise TalabatError('ACCOUNT_CHANGED_RECONCILE_REQUIRED')
    remaining_time(deadline)
    write_store(ACCOUNT, saved)  # one atomic Security.framework item update
    write_store(PENDING, {'state': 'published', 'kind': pending['kind'],
                          'operation_id': pending['operation_id']})
    return status()


def login_complete(timeout=25):
    deadline = new_deadline(timeout)
    with account_lock():
        pending = read_store(PENDING)
        if pending.get('state') != 'awaiting_sms':
            raise TalabatError('NO_PENDING_SMS_LOGIN')
        code = fresh_sms(pending['started_at'])
        if read_store(ACCOUNT) != pending['base']:
            raise TalabatError('ACCOUNT_CHANGED_RECONCILE_REQUIRED')
        pending['state'] = 'otp_login_in_flight'
        write_store(PENDING, pending)
        status_code, data, metadata = wire(OTP_LOGIN, pending['base'], deadline,
                                          {'verification_ticket': pending['verification_ticket'],
                                            'verification_code': code}, pending=pending)
        _retain(pending, status_code, data, metadata)
        return _publish(pending, deadline)


def reconcile(timeout=15):
    """Only revalidate retained credentials. Never repeats an ambiguous POST."""
    deadline = new_deadline(timeout)
    with account_lock():
        pending = read_store(PENDING)
        if pending.get('state') == 'raw_response_retained':
            # Parse locally under this explicit reconciliation budget. No POST.
            try:
                with read_deadline(deadline):
                    raw = base64.b64decode(pending['response_body_b64'], validate=True)
                    if len(raw) > MAX_BYTES:
                        raise ValueError()
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise TalabatError('RETAINED_RESPONSE_INVALID_NO_RETRY') from None
            if pending.get('response_operation') == 'otp_request':
                return _retain_ticket(pending, pending['http_status'], data)
            _retain(pending, pending['http_status'], data, pending['response_metadata'])
        if pending.get('state') == 'response_retained':
            _retain(pending, pending['http_status'], pending['response_auth'], pending['response_metadata'])
        if pending.get('state') != 'candidate_retained':
            raise TalabatError('NO_RECONCILABLE_CANDIDATE_NO_RETRY')
        return _publish(pending, deadline)


def refresh(force=False, rejected_token=None, timeout=25, deadline=None):
    """One refresh grant, coalesced across processes; never requests an OTP."""
    own_deadline = new_deadline(timeout)
    deadline = own_deadline if deadline is None else min(own_deadline, deadline)
    remaining_time(deadline)
    observed = read_store(ACCOUNT).get('maintenance_operation_id')
    with account_lock(timeout=min(5, remaining_time(deadline))):
        remaining_time(deadline)
        pending = read_store(PENDING)
        if pending.get('state') == 'candidate_retained':
            return _publish(pending, deadline)
        _pending_allowed(pending)
        saved = binding(read_store(ACCOUNT))
        token_changed = rejected_token is not None and saved['auth'].get('access_token') != rejected_token
        concurrent_refresh = saved.get('maintenance_operation_id') != observed
        if (token_changed or concurrent_refresh or not force and rejected_token is None) and expiry(saved['auth']) > time.time() + 120:
            return {**status(), 'renewed': False}
        auth = saved['auth']
        client = saved.get('refresh_auth') or {}
        device = (saved.get('renewal') or {}).get('device_token')
        if not all(isinstance(x, str) and x for x in (auth.get('refresh_token'), client.get('client_secret'), device)):
            raise TalabatError('REFRESH_MATERIAL_MISSING_EXPLICIT_LOGIN_REQUIRED')
        pending = {'state': 'refresh_in_flight', 'kind': 'refresh', 'base': saved,
                   'started_at': time.time(), 'operation_id': str(uuid.uuid4())}
        remaining_time(deadline)
        write_store(PENDING, pending)
        code, data, metadata = wire(AAA, saved, deadline,
                                    {'client_id': 'android', 'client_secret': client['client_secret'],
                                     'grant_type': 'refresh_token', 'refresh_token': auth['refresh_token'], 'scope': ''},
                                    {'X-Device': device, 'X-Fp-Api-Key': 'android',
                                      'X-Global-Entity-ID': 'TB_AE', 'X-Device-Source': '6', 'AppBrand': '1'},
                                    pending=pending)
        _retain(pending, code, data, metadata)
        pending['candidate']['refreshed_at'] = time.time()
        write_store(PENDING, pending)
        return {**_publish(pending, deadline), 'renewed': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    refresh_parser = sub.add_parser('refresh')
    refresh_parser.add_argument('--force', action='store_true', help='one explicit rotation even if not near expiry')
    login = sub.add_parser('login')
    phases = login.add_mutually_exclusive_group(required=True)
    phases.add_argument('--request-sms', action='store_true', help='explicit authorization to request one SMS')
    phases.add_argument('--complete', action='store_true', help='read fresh local Messages OTP and log in once')
    phases.add_argument('--reconcile', action='store_true', help='validate retained candidate; no POST')
    login.add_argument('--apk-pool', help='13.95.0 production pp.txt, required for --request-sms')
    args = parser.parse_args(argv)
    try:
        if args.command == 'status':
            result = status()
        elif args.command == 'refresh':
            result = refresh(force=args.force)
        elif args.request_sms:
            if not args.apk_pool:
                raise TalabatError('PUBLIC_APK_POOL_REQUIRED')
            result = login_request(args.apk_pool)
        elif args.complete:
            result = login_complete()
        else:
            result = reconcile()
        print(json.dumps(result))
        return 0
    except TalabatError as exc:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': str(exc), 'retry': False}))
        return 1
    except Exception:
        print(json.dumps({'ok': False, 'app': 'talabat', 'error': 'MAINTENANCE_FAILED_NO_RETRY', 'retry': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
