"""Native Noon cookie-session maintenance; no invented refresh grant or login.

Only verified whoami/customer GETs are dispatched. Response cookies are journaled in Keychain before
parsing and published after exact account/Home validation. Existing capture items
are read-only; consumers must use this module's verified overlay.

Cross-surface peer adoption (adopt_peer_session) and authorized capture import
(publish_capture_import) publish externally supplied cookies the same way:
live exercise, exact pinned-account and saved-Home validation, rotation
stability, single-flight lock on the target key only. Neither invents a
refresh grant, writes donor/native state, or retries a rejected request.
"""
import argparse
import copy
from contextlib import contextmanager
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
import fcntl
import hashlib
from http.cookies import SimpleCookie, CookieError
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import noon_http_orders as native
from noon_checkout import project_home, fingerprint, CheckoutError

SESSION_MAP = {'main': 'noon', 'supermall': 'noon', 'minutes': 'minutes', 'nownow': 'nownow'}
# One exercising surface per shared session key, for cross-surface recovery.
KEY_SURFACES = {'noon': 'main', 'minutes': 'minutes', 'nownow': 'nownow'}
WHOAMI = 'https://api-app-st.noon.com/_vs/st/st-whoami-api/whoami'
IDENTITY = 'https://api-app.noon.com/_svc/mp-identity-api/customer/get'
NOWNOW_TEMPLATE = 'GET api-app-fd.noon.com/_svc/mp-shop-api-ctnoon/v2/content/search'
LOCK_ROOT = Path.home() / '.local/state/app-api-cli'
MAX_COOKIE_BYTES = 65536
AUTH_COOKIES = frozenset({'_natnetidv2', '_nrtnetid'})
OMIT = {'host', 'content-length', 'accept-encoding', 'connection', 'if-none-match',
        'if-modified-since', 'sentry-trace', 'baggage'}


class AuthError(Exception):
    """Fixed local codes only; transport details and upstream bodies stay private."""


def safe_code(exc):
    if isinstance(exc, (AuthError, native.NoonError, CheckoutError)):
        value = str(exc)
        if re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', value):
            return value
    return 'AUTH_OPERATION_FAILED'


def _require(value, code):
    if not value:
        raise AuthError(code)


def session_key(service):
    _require(isinstance(service, str) and service in SESSION_MAP, 'INVALID_SERVICE')
    return SESSION_MAP[service]


def deadline_for(timeout=20, deadline=None):
    _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 60,
             'INVALID_TIMEOUT')
    own = time.monotonic() + timeout
    if deadline is not None:
        _require(type(deadline) in (int, float) and math.isfinite(deadline), 'INVALID_DEADLINE')
        own = min(own, deadline)
    native.remaining(own)
    return own


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def cookie_pairs(value):
    _require(isinstance(value, str) and 0 < len(value) <= MAX_COOKIE_BYTES,
             'COOKIE_HEADER_INVALID')
    pairs = {}
    for part in value.split(';'):
        name, sep, val = part.strip().partition('=')
        _require(sep and re.fullmatch(r'[!#$%&\'*+.^_`|~0-9a-zA-Z-]+', name)
                 and name not in pairs and not any(ord(c) < 32 or ord(c) == 127 for c in val),
                 'COOKIE_HEADER_INVALID')
        pairs[name] = val
    return pairs


def credential_ref(headers):
    # Equality only. These observed cookie names are not assigned OAuth semantics.
    pairs = cookie_pairs(headers.get('cookie'))
    return digest({k: pairs[k] for k in AUTH_COOKIES if k in pairs})


def merge_cookies(headers, values):
    """Only domain-wide root cookies can enter the cross-vertical header overlay."""
    pairs = cookie_pairs(headers.get('cookie'))
    for raw in values:
        _require(isinstance(raw, str) and not any(c in raw for c in '\r\n'),
                 'COOKIE_RESPONSE_INVALID_RETAINED')
        cookie = SimpleCookie()
        try:
            cookie.load(raw)
        except CookieError:
            raise AuthError('COOKIE_RESPONSE_INVALID_RETAINED') from None
        _require(len(cookie) == 1, 'COOKIE_RESPONSE_INVALID_RETAINED')
        name, morsel = next(iter(cookie.items()))
        _require(morsel['domain'].lower().lstrip('.') == 'noon.com' and morsel['path'] == '/',
                 'COOKIE_SCOPE_UNSUPPORTED_RETAINED')
        expired = False
        try:
            if morsel['max-age']:
                expired = int(morsel['max-age']) <= 0
            elif morsel['expires']:
                expired = parsedate_to_datetime(morsel['expires']).timestamp() <= time.time()
        except (ValueError, TypeError, OverflowError):
            raise AuthError('COOKIE_RESPONSE_INVALID_RETAINED') from None
        if expired:
            pairs.pop(name, None)
        else:
            pairs[name] = morsel.value
    result = dict(headers)
    result['cookie'] = '; '.join(k + '=' + v for k, v in pairs.items())
    cookie_pairs(result['cookie'])
    return result


class KeychainStorage:
    def __init__(self):
        sys.path.insert(0, str(Path.home() / '.local/share/app-api-cli/capture'))
        from keychain import load, store
        self.load, self.store = load, store


@contextmanager
def session_lock(key, deadline, root=LOCK_ROOT):
    root = Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root / ('noon-auth-' + key + '.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        until = min(deadline, time.monotonic() + 5)
        while True:
            native.remaining(deadline)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                _require(time.monotonic() < until, 'AUTH_MAINTENANCE_BUSY')
                time.sleep(min(.025, max(0, until - time.monotonic())))
        yield
    finally:
        os.close(fd)


def whoami_wire(headers, deadline, retain):
    return _identity_read_wire(WHOAMI, headers, deadline, retain)


def customer_wire(headers, deadline, retain):
    """Native getCustomer, config shape368/defaultSubDomain=api-app; no body."""
    return _identity_read_wire(IDENTITY, headers, deadline, retain)


def _identity_read_wire(url, headers, deadline, retain):
    """Retain complete Set-Cookie headers even if body reading/parsing fails."""
    _require(url in {WHOAMI, IDENTITY}, 'ENDPOINT_DENIED')
    values = None
    try:
        request = urllib.request.Request(url, method='GET', headers={
            **headers, 'accept': 'application/json', 'accept-encoding': 'identity',
            'cache-control': 'no-cache'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), native.NoRedirect())
        try:
            with native.read_deadline(deadline) as left:
                try:
                    response = opener.open(request, timeout=left)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    code = response.code
                    values = tuple(response.headers.get_all('Set-Cookie', []))
                    _require(len(values) <= 100 and sum(len(x) for x in values) <= MAX_COOKIE_BYTES,
                             'COOKIE_RESPONSE_TOO_LARGE')
                    raw = response.read(native.MAX_BYTES + 1)
        finally:
            if values is not None and len(values) <= 100 and sum(len(x) for x in values) <= MAX_COOKIE_BYTES:
                # Local secure retention only. No extra network budget.
                retain(values, code)
        http_ok(code)
        with native.read_deadline(deadline):
            _require(len(raw) <= native.MAX_BYTES, 'RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            _require(isinstance(data, dict), 'SCHEMA_CHANGED')
        return data
    except (AuthError, native.NoonError):
        raise
    except Exception:
        raise AuthError('AUTH_READ_FAILED_NO_RETRY') from None


def http_ok(code):
    if not 200 <= code < 300:
        raise AuthError({401: 'AUTH_EXPIRED', 403: 'AUTH_FORBIDDEN', 429: 'RATE_LIMITED'}.get(
            code, 'AUTH_HTTP_ERROR'))


@dataclass(repr=False)
class AuthSnapshot:
    service: str
    account_ref: str = field(repr=False)
    address_ref: str = field(repr=False)
    checked_at: float
    _headers: dict = field(repr=False)
    _valid_until: float = field(repr=False)
    _used: bool = field(default=False, repr=False)

    def __repr__(self):
        return '<NoonAuthSnapshot private>'

    def read_headers(self):
        _require(time.monotonic() < self._valid_until, 'AUTH_SNAPSHOT_STALE')
        return dict(self._headers)

    def mutation_headers(self, service):
        _require(service == self.service, 'AUTH_SERVICE_MISMATCH')
        _require(not self._used, 'AUTH_SNAPSHOT_ALREADY_USED')
        headers = self.read_headers()
        self._used = True
        return headers


class NoonAuthLifecycle:
    def __init__(self, *, storage=None, transport=None, identity_transport=None, lock_root=LOCK_ROOT):
        self.storage = storage if storage is not None else KeychainStorage()
        self.transport = transport or whoami_wire
        self.identity_transport = identity_transport or customer_wire
        self.lock_root = lock_root

    def _load(self, name, deadline):
        try:
            with native.read_deadline(deadline):
                value = self.storage.load(name)
            _require(value is None or isinstance(value, dict), 'ACCOUNT_STORAGE_INVALID')
            return copy.deepcopy(value or {})
        except (AuthError, native.NoonError):
            raise
        except Exception:
            raise AuthError('ACCOUNT_STORAGE_UNAVAILABLE') from None

    def _write(self, key, state, deadline):
        try:
            with native.read_deadline(deadline):
                self.storage.store('noon-auth-lifecycle-' + key, copy.deepcopy(state))
        except Exception:
            raise AuthError('ACCOUNT_STORAGE_WRITE_FAILED_STOP') from None

    def _records(self, service, deadline, *, allow_native_change=False):
        key = session_key(service)
        saved = self._load(key, deadline)
        source = saved.get('templates', {}).get(NOWNOW_TEMPLATE, {}) if key == 'nownow' else saved
        headers = source.get('headers')
        _require(isinstance(headers, dict) and headers and all(isinstance(k, str) and isinstance(v, str)
                 and not any(c in v for c in '\r\n') for k, v in headers.items()), 'ACCOUNT_CAPTURE_REQUIRED')
        headers = {k.lower(): v for k, v in headers.items() if k.lower() not in OMIT}
        cookie_pairs(headers.get('cookie'))
        state = self._load('noon-auth-lifecycle-' + key, deadline)
        if state and not allow_native_change:
            _require(state.get('native_digest') == digest(headers), 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED')
        return key, headers, state

    def status(self, service, *, timeout=5):
        end = deadline_for(timeout)
        key, headers, state = self._records(service, end)
        phase = self._maintenance_phase(state)
        checked = state.get('checked_at')
        checked = checked if type(checked) in (int, float) and math.isfinite(checked) else None
        return {'ok': True, 'app': 'noon', 'service': service, 'session_key': key,
                'binding_present': bool(state.get('account_ref') and state.get('headers')), 'maintenance_state': phase,
                'last_verified_at': checked, 'expiry_known': False,
                'refresh_grant_verified': False, 'renewal_method': 'validated_response_cookies',
                'rejected_session_recovery_verified': False,
                'explicit_refresh_token_present': False, 'automatic_otp': False}

    @staticmethod
    def _maintenance_phase(state):
        pending = state.get('pending') or {}
        phase = pending.get('state', 'none')
        if phase not in {'none', 'read_in_flight', 'cookies_retained', 'candidate_retained'}:
            phase = 'unknown'
        if state.get('response_observations'):
            phase = 'conflicting_observations'
        return phase

    def key_survey(self, service, *, timeout=5):
        """Storage-only single-key survey fact for cross-surface recovery.

        Zero network, zero writes. Account references are local fingerprints,
        not credentials. A native capture that changed under a bound overlay
        is reported as a flag instead of an error so the caller can still see
        the rest of the surface state.
        """
        end = deadline_for(timeout)
        try:
            key, headers, state = self._records(service, end)
            native_changed = False
        except AuthError as exc:
            if str(exc) != 'NATIVE_SESSION_CHANGED_REBIND_REQUIRED':
                raise
            key, headers, state = self._records(service, end, allow_native_change=True)
            native_changed = True
        pending = state.get('pending') or {}
        checked = state.get('checked_at')
        checked = checked if type(checked) in (int, float) and math.isfinite(checked) else None
        return {'ok': True, 'app': 'noon', 'service': service, 'session_key': key,
                'capture_present': True, 'native_capture_changed': native_changed,
                'binding_present': bool(state.get('account_ref') and state.get('headers')),
                'account_ref': state.get('account_ref'),
                'maintenance_state': self._maintenance_phase(state),
                'last_verified_at': checked,
                'pending_material': bool(pending),
                'pending_state': pending.get('state'),
                'pending_http_status': pending.get('http_status'),
                'observation_material': bool(state.get('response_observations'))}

    def diagnose_readonly(self, service, *, timeout=30):
        """Two proven identity GETs, RAM-only cookie observations, zero storage writes.

        This never signs in, refreshes by a guessed grant, repairs pending state,
        or changes the native capture. A valid session is not renewal evidence.
        """
        end=deadline_for(timeout)
        key,native_headers,state=self._records(service,end)
        _require(state.get('account_ref') and state.get('headers'),'ACCOUNT_BINDING_REQUIRED')
        headers=copy.deepcopy(state['headers'])
        before=credential_ref(headers)
        evidence=[]
        def read(label,wire,expected_identity):
            observed={'label':label,'route':WHOAMI if label=='whoami' else IDENTITY,'method':'GET',
                      'status':None,'set_cookie_count':0,'auth_cookie_changed':False,
                      'account_verified':False,'home_verified':False}
            cookies=[]
            def retain(values,code):
                cookies.extend(values);observed['status']=code;observed['set_cookie_count']=len(values)
            try:
                data=wire(headers,end,retain)
                if expected_identity=='home':
                    self._check(data,headers,service,state['account_ref'])
                    observed.update(account_verified=True,home_verified=True)
                else:
                    _require(isinstance(data.get('customerCode'),str) and fingerprint(data['customerCode'])==state['account_ref'],
                             'ACCOUNT_IDENTITY_MISMATCH')
                    observed['account_verified']=True
            except Exception as exc:
                observed['error']=safe_code(exc)
            if cookies:
                try:
                    candidate=merge_cookies(headers,cookies)
                    observed['auth_cookie_changed']=credential_ref(candidate)!=before
                except Exception as exc:observed['cookie_scope_error']=safe_code(exc)
            evidence.append(observed)
            return observed
        who=read('whoami',self.transport,'home')
        # No rejected-request retry. Identity is a separate evidenced diagnostic
        # only when ordinary account/Home read succeeded and retained state agrees.
        if who['account_verified'] and who['home_verified'] and not who['auth_cookie_changed']:
            read('customer_get',self.identity_transport,'customer')
        rejected=any(x['status'] in (401,403) for x in evidence)
        changed=any(x['auth_cookie_changed'] for x in evidence)
        pending=bool(state.get('pending') or state.get('response_observations'))
        valid=all(x['account_verified'] for x in evidence)
        action=('supported_native_account_recovery' if rejected else
                'inspect_identity_read_failure' if not valid else
                'explicit_retained_cookie_reconciliation' if pending or changed else 'existing_session_valid')
        return {'ok':valid,'app':'noon','service':service,
            'read_only':True,'storage_writes':0,'login_or_otp_sent':False,'evidence':evidence,
            'pending_material_present':pending,'auth_cookie_rotation_observed':changed,
            'refresh_grant_verified':False,'rejected_session_recovery_verified':False,'action':action,
            'recovery_steps':([
                'If the original Noon app is still signed in, use an authorized supported native recapture; do not log out first.',
                'If the original app requires login: Account → Login/Sign up → existing account email → CONTINUE → legitimate email OTP/challenge.',
                'Do not sign out or invalidate an accepted session to manufacture expiry.',
                'After authorized native session acquisition, explicitly rebind the same pinned account; existing financial operations stay consumed.',
                'Rebind refuses pending/conflicting cookie material. Reconcile it first; if still rejected, no force-clear/reset is supported.',
                'Native session acquisition is a separate supported maintenance step; this diagnostic cannot extract app credentials.'
            ] if rejected else []),'native_recovery_evidence':{
                'shared_js_failure_handler':'f103864 ends Promise.reject; no account refresh dispatch',
                'native_cookie_transport_recovery':'unverified platform implementation',
                'AuthSessionModule':'startMastercardAuth is checkout authentication, not account renewal'},
            'mutation_retry':False}

    def _snapshot(self, service, state):
        return AuthSnapshot(service, state['account_ref'], state['address_ref'], state['checked_at'],
                            copy.deepcopy(state['headers']), time.monotonic() + 30)

    def _check(self, data, headers, service, expected):
        try:
            home = project_home(data, headers, service, checked_at=time.time())
        except CheckoutError as exc:
            raise AuthError(safe_code(exc)) from None
        _require(home.account_ref == expected, 'ACCOUNT_IDENTITY_MISMATCH')
        return home

    def _exchange(self, service, key, state, headers, end, *, transport=None):
        pending = {'state': 'read_in_flight', 'base_headers': copy.deepcopy(headers),
                   'operation_id': str(uuid.uuid4())}
        state['pending'] = pending
        self._write(key, state, end)

        def retain(values, code):
            _require(isinstance(values, (tuple, list)) and len(values) <= 100
                     and all(isinstance(v, str) for v in values)
                     and sum(len(v) for v in values) <= MAX_COOKIE_BYTES, 'COOKIE_RESPONSE_TOO_LARGE')
            pending.update(state='cookies_retained', set_cookies=list(values), http_status=code)
            self._write(key, state, time.monotonic() + 2)

        try:
            data = (transport or self.transport)(dict(headers), end, retain)
            native.remaining(end)
        except Exception as exc:
            raise AuthError(safe_code(exc)) from None
        _require(pending.get('state') == 'cookies_retained', 'TRANSPORT_RETENTION_REQUIRED')
        http_ok(pending['http_status'])
        candidate = merge_cookies(headers, pending['set_cookies'])
        pending.update(state='candidate_retained', headers=candidate)
        self._write(key, state, end)
        return data, candidate

    def _publish(self, service, key, state, data, headers, end):
        home = self._check(data, headers, service, state['account_ref'])
        # A changed cookie must be exercised, not validated using the old request.
        base = state['pending']['base_headers']
        if cookie_pairs(base['cookie']) != cookie_pairs(headers['cookie']):
            data, newest = self._exchange(service, key, state, headers, end)
            self._check(data, headers, service, state['account_ref'])
            _require(cookie_pairs(newest['cookie']) == cookie_pairs(headers['cookie']),
                     'COOKIE_ROTATION_UNSTABLE_RECONCILE_REQUIRED')
            headers = newest
        # Detect cooperating/out-of-lock capture changes before publication.
        _, _, stored = self._records(service, end)
        _require(stored == state, 'ACCOUNT_CHANGED_RECONCILE_REQUIRED')
        state.update(headers=headers, address_ref=home.address_ref, checked_at=time.time(),
                     generation=str(uuid.uuid4()), pending=None)
        self._write(key, state, end)
        return self._snapshot(service, state)

    def bind_existing(self, service, expected_account_ref, *, timeout=20):
        """Explicit initial pin from an independently accepted AccountHome reference."""
        _require(isinstance(expected_account_ref, str) and re.fullmatch(r'[a-f0-9]{64}', expected_account_ref),
                 'EXPECTED_ACCOUNT_REQUIRED')
        end = deadline_for(timeout)
        with session_lock(session_key(service), end, self.lock_root):
            key, headers, state = self._records(service, end)
            _require(not state, 'ACCOUNT_ALREADY_BOUND')
            state = {'native_digest': digest(headers), 'account_ref': expected_account_ref}
            data, candidate = self._exchange(service, key, state, headers, end)
            return self._publish(service, key, state, data, candidate, end)

    def rebind_existing(self, service, expected_account_ref, *, timeout=20):
        """Explicit adoption after parent-authorized native recapture, same account.

        A pending rotation must first be reconciled; this is never a force-clear.
        Failed adoption retains both the previous overlay and the new candidate.
        """
        _require(isinstance(expected_account_ref, str) and re.fullmatch(r'[a-f0-9]{64}', expected_account_ref),
                 'EXPECTED_ACCOUNT_REQUIRED')
        end = deadline_for(timeout)
        with session_lock(session_key(service), end, self.lock_root):
            key, headers, state = self._records(service, end, allow_native_change=True)
            _require(state.get('account_ref') == expected_account_ref, 'ACCOUNT_IDENTITY_MISMATCH')
            _require(not state.get('pending'), 'PENDING_AUTH_RECONCILE_REQUIRED')
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            state['native_digest'] = digest(headers)
            data, candidate = self._exchange(service, key, state, headers, end)
            return self._publish(service, key, state, data, candidate, end)

    def _supersede_rejected_pending(self, state, provenance):
        """Allow recovery to proceed past a confirmed 401 rejection only.

        The rejected material is kept as a bounded audit record in the Keychain
        state; it is never silently discarded and never blocks later
        maintenance the way conflicting concurrent observations do. Any other
        pending rotation (read in flight, a 2xx candidate, a 403 challenge)
        still requires explicit reconcile first.
        """
        pending = state.get('pending')
        if not pending:
            return
        _require(pending.get('state') == 'cookies_retained' and pending.get('http_status') == 401,
                 'PENDING_AUTH_RECONCILE_REQUIRED')
        rejections = state.setdefault('superseded_rejections', [])
        _require(len(rejections) < 8, 'SUPERSEDED_REJECTION_CAPACITY_STOP')
        rejections.append({**pending, 'superseded_by': provenance, 'superseded_at': time.time()})
        state['pending'] = None

    def adopt_peer_session(self, service, donor_service, *, timeout=30, deadline=None):
        """Adopt a bound same-account peer surface's auth cookies onto this surface.

        Donor cookies are only a candidate: a live whoami must authenticate as
        this surface's pinned account with the saved Home before publication,
        and a rotated response is re-exercised for stability. Only the donor's
        domain-wide AUTH_COOKIES are adopted; all other target headers stay.
        Donor state is never written and no refresh grant is inferred. The
        target's native capture pin is untouched, so a later native recapture
        still rebinds explicitly.
        """
        end = deadline_for(timeout, deadline)
        key = session_key(service)
        donor_key = session_key(donor_service)
        _require(donor_key != key, 'PEER_SESSION_KEY_UNSUPPORTED')
        with session_lock(key, end, self.lock_root):
            key, _, state = self._records(service, end)
            _require(state.get('account_ref') and state.get('headers'), 'ACCOUNT_BINDING_REQUIRED')
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            self._supersede_rejected_pending(state, 'peer_session_adoption')
            donor = self._load('noon-auth-lifecycle-' + donor_key, end)
            _require(donor.get('account_ref') and donor.get('headers'), 'PEER_SESSION_UNBOUND')
            _require(not donor.get('pending'), 'PEER_PENDING_RECONCILE_REQUIRED')
            _require(not donor.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            _require(donor['account_ref'] == state['account_ref'], 'PEER_ACCOUNT_MISMATCH')
            donor_pairs = cookie_pairs(donor['headers'].get('cookie'))
            fresh = {k: donor_pairs[k] for k in AUTH_COOKIES if k in donor_pairs}
            _require(fresh, 'PEER_AUTH_NOT_APPLICABLE')
            candidate = dict(state['headers'])
            pairs = cookie_pairs(candidate.get('cookie'))
            candidate['cookie'] = '; '.join(k + '=' + v for k, v in {**pairs, **fresh}.items())
            _require(credential_ref(candidate) != credential_ref(state['headers']), 'PEER_AUTH_NOT_APPLICABLE')
            data, headers = self._exchange(service, key, state, candidate, end)
            snapshot = self._publish(service, key, state, data, headers, end)
            return {'ok': True, 'app': 'noon', 'service': service, 'session_key': key,
                    'method': 'peer_session_adoption', 'donor_service': donor_service,
                    'donor_session_key': donor_key, 'account_ref': snapshot.account_ref,
                    'refresh_grant_verified': False, 'rejected_session_recovery_verified': False,
                    'automatic_otp': False, 'mutation_retry': False}

    def publish_capture_import(self, service, headers, expected_account_ref, *, timeout=30, deadline=None):
        """Publish parent-authorized recaptured material arriving outside native capture.

        The headers come from an authorized original-session export (browser,
        app capture pipeline writing elsewhere, capture file) and are only a
        candidate: a live whoami must authenticate as the pinned account with
        the saved Home before publication. Native capture accounts
        ('minutes'/'noon'/'nownow') are never written here; a native Keychain
        recapture rebinding stays rebind_existing's job. Importing identical
        auth cookies, or material for another account, is refused. A confirmed
        401 rejection may be superseded (retained as an observation), never
        discarded. No refresh grant is inferred.
        """
        _require(isinstance(expected_account_ref, str) and re.fullmatch(r'[a-f0-9]{64}', expected_account_ref),
                 'EXPECTED_ACCOUNT_REQUIRED')
        _require(isinstance(headers, dict) and headers
                 and all(isinstance(k, str) and k and isinstance(v, str)
                         and not any(c in k + v for c in '\r\n') for k, v in headers.items())
                 and sum(len(k) + len(v) for k, v in headers.items()) <= MAX_COOKIE_BYTES * 2,
                 'IMPORT_HEADERS_INVALID')
        headers = {k.lower(): v for k, v in headers.items() if k.lower() not in OMIT}
        _require(any(k in AUTH_COOKIES for k in cookie_pairs(headers.get('cookie'))),
                 'IMPORT_HEADERS_INVALID')
        end = deadline_for(timeout, deadline)
        key = session_key(service)
        with session_lock(key, end, self.lock_root):
            key, native_headers, state = self._records(service, end)
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            if state:
                _require(state.get('account_ref'), 'ACCOUNT_BINDING_REQUIRED')
                _require(state['account_ref'] == expected_account_ref, 'ACCOUNT_IDENTITY_MISMATCH')
                self._supersede_rejected_pending(state, 'capture_import')
                _require(credential_ref(headers) != credential_ref(state['headers']),
                         'IMPORT_UNCHANGED_AUTH_NOT_APPLICABLE')
            else:
                # Explicit first pin, exactly like bind_existing but with
                # externally supplied candidate headers.
                state = {'native_digest': digest(native_headers), 'account_ref': expected_account_ref}
            data, candidate = self._exchange(service, key, state, headers, end)
            snapshot = self._publish(service, key, state, data, candidate, end)
            return {'ok': True, 'app': 'noon', 'service': service, 'session_key': key,
                    'method': 'capture_import', 'account_ref': snapshot.account_ref,
                    'native_capture_unchanged': True, 'refresh_grant_verified': False,
                    'rejected_session_recovery_verified': False, 'automatic_otp': False,
                    'mutation_retry': False}

    def revalidate(self, service, *, timeout=20, deadline=None, rejected_ref=None):
        end = deadline_for(timeout, deadline)
        key = session_key(service)
        # Observe generation before locking so simultaneous expiry callers coalesce.
        _, _, observed = self._records(service, end)
        with session_lock(key, end, self.lock_root):
            key, _, state = self._records(service, end)
            _require(state.get('account_ref') and state.get('headers'), 'ACCOUNT_BINDING_REQUIRED')
            _require(not state.get('pending'), 'PENDING_AUTH_RECONCILE_REQUIRED')
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            recent = 0 <= time.time() - state.get('checked_at', 0) < 30
            changed = state.get('generation') != observed.get('generation')
            recovered = rejected_ref is not None and credential_ref(state['headers']) != rejected_ref
            if recent and (changed or recovered):
                return self._snapshot(service, state)
            old_headers = state['headers']
            try:
                data, candidate = self._exchange(service, key, state, old_headers, end)
            except AuthError as exc:
                pending = state.get('pending') or {}
                if str(exc) != 'AUTH_EXPIRED' or pending.get('state') != 'cookies_retained':
                    raise
                candidate = merge_cookies(old_headers, pending['set_cookies'])
                _require(credential_ref(candidate) != credential_ref(old_headers),
                         'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED')
                # Exactly one fresh-cookie identity read after a 401. No grant
                # endpoint is inferred and a second rejection is never replayed.
                data, newest = self._exchange(service, key, state, candidate, end)
                self._check(data, candidate, service, state['account_ref'])
                _require(cookie_pairs(newest['cookie']) == cookie_pairs(candidate['cookie']),
                         'COOKIE_ROTATION_UNSTABLE_RECONCILE_REQUIRED')
                candidate = newest
            return self._publish(service, key, state, data, candidate, end)

    def reconcile(self, service, *, timeout=20):
        """Revalidate retained cookie material. Never discard it or initiate login."""
        end = deadline_for(timeout)
        key = session_key(service)
        with session_lock(key, end, self.lock_root):
            key, _, state = self._records(service, end)
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            pending = state.get('pending') or {}
            _require(pending.get('state') in {'read_in_flight', 'cookies_retained', 'candidate_retained'},
                     'NO_RECONCILABLE_COOKIES_MANUAL_REQUIRED')
            _require(pending.get('http_status') != 403, 'AUTH_FORBIDDEN')
            headers = pending.get('headers') or merge_cookies(pending['base_headers'], pending.get('set_cookies', []))
            data, candidate = self._exchange(service, key, state, headers, end)
            return self._publish(service, key, state, data, candidate, end)

    def fresh_before_mutation(self, service, *, timeout=20, deadline=None):
        """Return one-use headers after live validation; caller sends its mutation once."""
        return self.revalidate(service, timeout=timeout, deadline=deadline)

    def revalidate_identity(self, service, *, timeout=20, deadline=None):
        """Explicit native customer read, then exact account/Home validation.

        This is maintenance, not a proven refresh grant. No fallback login, POST,
        or retry after identity rejection. Any response cookies remain retained.
        """
        end = deadline_for(timeout, deadline)
        key = session_key(service)
        with session_lock(key, end, self.lock_root):
            key, _, state = self._records(service, end)
            _require(state.get('account_ref') and state.get('headers'), 'ACCOUNT_BINDING_REQUIRED')
            _require(not state.get('pending'), 'PENDING_AUTH_RECONCILE_REQUIRED')
            _require(not state.get('response_observations'), 'CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            data, candidate = self._exchange(service, key, state, state['headers'], end,
                                              transport=self.identity_transport)
            customer = data.get('customerCode')
            _require(isinstance(customer, str) and 0 < len(customer) <= 256,
                     'ACCOUNT_SCHEMA_UNKNOWN')
            _require(fingerprint(customer) == state['account_ref'], 'ACCOUNT_IDENTITY_MISMATCH')
            # Home never comes from customer/get. Exercise its retained cookies
            # on whoami; only that independent response may publish the overlay.
            data, candidate = self._exchange(service, key, state, candidate, end)
            return self._publish(service, key, state, data, candidate, end)

    def retain_response_cookies(self, service, snapshot, values, *, response_url, http_status, timeout=5):
        """Securely retain cookies from an already completed native request.

        Call AFTER journaling the mutation's outcome. This never repeats that
        request and never validates/publishes credentials; explicit reconcile
        exercises the retained candidate using whoami. Values stay in Keychain.
        """
        end = deadline_for(timeout)
        key = session_key(service)
        _require(type(snapshot) is AuthSnapshot and snapshot.service == service,
                 'AUTH_SERVICE_MISMATCH')
        parsed = urllib.parse.urlsplit(response_url)
        _require(parsed.scheme == 'https' and parsed.netloc in {
            'api-app.noon.com', 'api-app-st.noon.com', 'api-app-instant.noon.com', 'api-app-fd.noon.com'}
            and not parsed.fragment, 'COOKIE_RESPONSE_ORIGIN_DENIED')
        _require(type(http_status) is int and 100 <= http_status <= 599,
                 'HTTP_STATUS_INVALID')
        _require(isinstance(values, (tuple, list)) and len(values) <= 100
                 and all(isinstance(v, str) for v in values)
                 and sum(len(v) for v in values) <= MAX_COOKIE_BYTES, 'COOKIE_RESPONSE_TOO_LARGE')
        if not values:
            return {'ok': True, 'retained': False}
        with session_lock(key, end, self.lock_root):
            key, _, state = self._records(service, end)
            # Preserve conflicting material as a separate bounded observation;
            # never overwrite an existing pending rotation with a late response.
            observations = state.setdefault('response_observations', [])
            _require(len(observations) < 8, 'COOKIE_OBSERVATION_CAPACITY_STOP')
            observation = {'base_headers': copy.deepcopy(snapshot._headers),
                           'set_cookies': list(values), 'http_status': http_status,
                           'state': 'cookies_retained', 'operation_id': str(uuid.uuid4())}
            same_base = state.get('headers') == snapshot._headers and state.get('account_ref') == snapshot.account_ref
            if state.get('pending') or not same_base or observations:
                observations.append(observation)
                self._write(key, state, end)
                raise AuthError('CONCURRENT_COOKIE_OBSERVATION_MANUAL_RECONCILE_REQUIRED')
            state['pending'] = observation
            self._write(key, state, end)
            return {'ok': True, 'retained': True, 'action': 'reconcile_retained_material'}

    def read_with_recovery(self, service, operation, *, read_only=False, timeout=30):
        """Only an explicitly read-only callback may be replayed, at most once."""
        _require(read_only is True, 'READ_ONLY_OPERATION_REQUIRED')
        end = deadline_for(timeout)
        snapshot = self.revalidate(service, deadline=end)
        rejected = credential_ref(snapshot.read_headers())
        for attempt in range(2):
            try:
                result = operation(snapshot.read_headers(), end)
                native.remaining(end)
                return result
            except Exception as exc:
                code = safe_code(exc)
                if code != 'AUTH_EXPIRED' or attempt:
                    raise AuthError(code) from None
            snapshot = self.revalidate(service, deadline=end, rejected_ref=rejected)
            _require(credential_ref(snapshot.read_headers()) != rejected,
                     'NO_FRESH_AUTH_MANUAL_RECOVERY_REQUIRED')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'revalidate', 'revalidate-identity', 'reconcile'))
    parser.add_argument('service', choices=tuple(SESSION_MAP))
    args = parser.parse_args(argv)
    try:
        manager = NoonAuthLifecycle()
        if args.command != 'status':
            getattr(manager, args.command.replace('-', '_'))(args.service)
        print(json.dumps(manager.status(args.service)))
        return 0
    except Exception as exc:
        print(json.dumps({'ok': False, 'app': 'noon', 'error': safe_code(exc),
                          'retry': False, 'automatic_otp': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
