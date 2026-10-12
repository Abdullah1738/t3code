"""Native Careem account bootstrap/renewal, separate from guest catalog access.

Mutations run only through explicit bootstrap/refresh commands. No browser or
phone integration. Account material never appears in CLI output or argv.
"""
import argparse
import base64
from contextlib import contextmanager
import copy
import fcntl
import getpass
import hashlib
import http.client
import json
import math
from pathlib import Path
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).parent / 'capture'))
from keychain import load, store

ACCOUNT = 'careem-account'
ROUTES = {
    'profile': ('GET', 'https://identity.careem.com/userinfo'),
    'pow': ('GET', 'https://sagateway.careem-engineering.com/identity/guard/pow'),
    'login': ('POST', 'https://sagateway.careem-engineering.com/onboarder/login/customer/phone'),
    'otp': ('POST', 'https://sagateway.careem-engineering.com/identity/client/otp'),
    'verify': ('POST', 'https://sagateway.careem-engineering.com/identity/client/otp/verification'),
    'token': ('POST', 'https://identity.careem.com/token'),
}
HEADER_NAMES = {'authorization', 'provider-access-key', 'x-careem-device-id', 'agent',
                'user-agent', 'accept-language', 'x-careem-operating-system', 'version',
                'x-careem-session-id', 'x-careem-version', 'x-careem-userid'}
CHALLENGES = {'OTP', 'RETURNING_USER_CONFIRMATION', 'TRY_ANOTHER_WAY', 'PASSWORD',
              'CONFIRM_NAME', 'FULL_NAME', 'VERIFY_NAME', 'PHONE_NUMBER', 'BIOMETRIC', 'GOOGLE'}
# Moshi @Json names on the original26.39 enums, not Kotlin enum identifiers.
CHALLENGE_WIRE = {'otp': 'OTP', 'existing_user_confirmed': 'RETURNING_USER_CONFIRMATION',
                  'try_another_way': 'TRY_ANOTHER_WAY', 'password': 'PASSWORD',
                  'confirm_name': 'CONFIRM_NAME', 'full_name': 'FULL_NAME',
                  'verify_name': 'VERIFY_NAME', 'phone_number': 'PHONE_NUMBER',
                  'biometric': 'BIOMETRIC', 'google': 'GOOGLE'}
OPTION_WIRE = {'card': 'CARD', 'email': 'EMAIL', 'name': 'NAME', 'password': 'PASSWORD', 'pin': 'PIN'}
MAX_BYTES = 1_000_000


class AccountError(Exception):
    pass


def jwt_claims(token):
    try:
        part = token.split('.')[1]
        value = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (AttributeError, IndexError, ValueError, TypeError):
        raise AccountError('TOKEN_INVALID') from None


def expiry(token):
    try:
        value = float(jwt_claims(token)['exp'])
        if not math.isfinite(value):
            raise ValueError()
        return value
    except (KeyError, TypeError, ValueError):
        raise AccountError('TOKEN_INVALID') from None


def remaining(deadline):
    value = deadline - time.monotonic()
    if not math.isfinite(value) or value <= 0:
        raise AccountError('HTTP_TIMEOUT')
    return value


@contextmanager
def elapsed(deadline):
    left = remaining(deadline)
    if threading.current_thread() is not threading.main_thread() or any(signal.getitimer(signal.ITIMER_REAL)):
        raise AccountError('DEADLINE_UNAVAILABLE')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(*_):
        raise AccountError('HTTP_TIMEOUT')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, left)
        yield left
        remaining(deadline)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_request(route, headers, body=None, *, allow_mutation=False, timeout=12):
    if route not in ROUTES:
        raise AccountError('ENDPOINT_DENIED')
    method, url = ROUTES[route]
    if method == 'POST' and not allow_mutation:
        raise AccountError('AUTH_MUTATION_NOT_ENABLED')
    if method == 'GET' and body is not None:
        raise AccountError('INVALID_READ_PAYLOAD')
    return _transport(method, url, headers, body, route == 'token', time.monotonic()+timeout)


def _transport(method, url, headers, body, form, deadline):
    h = {k: v for k, v in headers.items() if k.lower() not in {'host', 'content-length', 'cookie', 'accept-encoding'}}
    h.update({'Accept': 'application/json', 'Accept-Encoding': 'identity'})
    payload = None
    if body is not None:
        h['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        payload = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    try:
        request = urllib.request.Request(url, headers=h, data=payload, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with elapsed(deadline) as left:
            try:
                response = opener.open(request, timeout=left)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                code = response.code
                raw = response.read(MAX_BYTES+1)
            if len(raw) > MAX_BYTES:
                raise AccountError('RESPONSE_TOO_LARGE')
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise AccountError('SCHEMA_CHANGED')
        return code, data
    except AccountError:
        raise
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
        raise AccountError('HTTP_FAILED') from None


def guest_context():
    """Read guest/client material in memory only; never renew or write it."""
    try:
        saved = load('careem') or {}
        template = saved['templates']['GET identity.careem.com/userinfo']
        if template['method'] != 'GET' or template['url'] != ROUTES['profile'][1]:
            raise ValueError()
        headers = {k.lower(): v for k, v in template['headers'].items() if k.lower() in HEADER_NAMES}
        basic = saved['refresh_auth']['authorization']
        if not basic.startswith('Basic '):
            raise ValueError()
        client_id, client_secret = base64.b64decode(basic[6:], validate=True).decode().split(':', 1)
        bearer = headers['authorization']
        if not bearer.startswith('Bearer ') or not client_id or not client_secret:
            raise ValueError()
        if jwt_claims(bearer[7:]).get('kind') != 'GUEST':
            raise ValueError()
        if jwt_claims(bearer[7:]).get('azp') != client_id:
            raise ValueError()
        if expiry(bearer[7:]) <= time.time()+30:
            raise AccountError('GUEST_CONTEXT_EXPIRED_NO_AUTORENEW')
        if not headers.get('provider-access-key') or not headers.get('x-careem-device-id'):
            raise ValueError()
        return {'headers': headers, 'basic': basic, 'client_id': client_id,
                'client_secret': client_secret, 'device_id': headers['x-careem-device-id']}
    except AccountError:
        raise
    except Exception:
        raise AccountError('CLIENT_CONTEXT_UNAVAILABLE') from None


def challenge(data):
    """Return explicit server challenge names only, never raw error/PII."""
    if not isinstance(data, dict):
        return None
    extra = data.get('additional_information')
    if not isinstance(extra, dict):
        return None
    wire = extra.get('challenge')
    name = CHALLENGE_WIRE.get(wire) if isinstance(wire, str) else None
    if name is None:
        return None
    details = extra.get('challenge_details') or []
    options = [OPTION_WIRE[d['challenge_name']] for d in details if isinstance(d, dict)
               and isinstance(d.get('challenge_name'), str)
               and d['challenge_name'] in OPTION_WIRE] if isinstance(details, list) else []
    return {'stage': 'challenge', 'challenge': name, 'options': options}


def error_summary(code, data):
    """One-shot diagnostics: fixed schema paths/types and allowlisted enums only."""
    if not isinstance(data, dict):
        return {'http_status': code, 'body_type': type(data).__name__}
    extra = data.get('additional_information')
    summary = {'http_status': code, 'body_type': 'dict',
               'known_top_level_fields': [k for k in ('error', 'error_description', 'additional_information', 'token') if k in data],
               'additional_information_type': type(extra).__name__,
               'parsed_challenge': challenge(data)}
    if isinstance(extra, dict):
        summary['known_additional_fields'] = [k for k in ('error_code', 'challenge', 'challenge_details') if k in extra]
        value = extra.get('challenge')
        summary['challenge_type'] = type(value).__name__
        if isinstance(value, str):
            summary['recognized_wire_challenge'] = value if value in CHALLENGE_WIRE else None
        details = extra.get('challenge_details')
        summary['challenge_details_type'] = type(details).__name__
        if isinstance(details, list):
            summary['challenge_details_count'] = len(details)
            summary['offered_recognized_options'] = [OPTION_WIRE[d['challenge_name']] for d in details
                if isinstance(d, dict) and isinstance(d.get('challenge_name'), str) and d['challenge_name'] in OPTION_WIRE]
    return summary


def solve_pow(config, timeout=4):
    """SDK SHA-1(version:complexity:timestamp:seed:counter), bounded locally."""
    try:
        version, difficulty, timestamp, seed = (config[k] for k in ['version', 'complexity', 'timestamp', 'seed'])
        if (config.get('algorithm') != 'SHA-1' or type(version) is not int or version != 1
                or type(difficulty) is not int or not 0 <= difficulty <= 6
                or type(timestamp) is not int or not isinstance(seed, str) or not seed or len(seed)>2048):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise AccountError('POW_CONTRACT_UNSUPPORTED') from None
    deadline = time.monotonic()+timeout
    prefix = f'{version}:{difficulty}:{timestamp}:{seed}:'.encode()
    counter = 0
    while True:
        if counter % 1024 == 0:
            remaining(deadline)
        if hashlib.sha1(prefix + str(counter).encode()).hexdigest().startswith('0'*difficulty):
            return f'pow:{seed}:{counter}'
        counter += 1


def verify_customer(token, expected_phone, headers, timeout=12):
    claims = jwt_claims(token)
    if claims.get('kind') != 'CUSTOMER' or expiry(token) <= time.time()+30:
        raise AccountError('CUSTOMER_TOKEN_REQUIRED')
    h = dict(headers)
    h.pop('x-careem-userid', None)
    h['authorization'] = 'Bearer ' + token
    code, profile = http_request('profile', h, timeout=timeout)
    if code != 200 or profile.get('kind') != 'CUSTOMER':
        raise AccountError('CUSTOMER_PROFILE_UNVERIFIED')
    phone = re.sub(r'[^0-9]', '', str(profile.get('phone_number', '')))
    if phone != expected_phone.lstrip('+') or not profile.get('sub'):
        raise AccountError('ACCOUNT_IDENTITY_MISMATCH')
    if str(claims.get('sub', '')) != str(profile['sub']):
        raise AccountError('ACCOUNT_IDENTITY_MISMATCH')
    return {'sub': str(profile['sub']), 'phone_number': '+' + phone}


class Bootstrap:
    """Stateful one-process flow; pending secrets never leave memory."""
    def __init__(self, phone, *, mutate=False):
        if not re.fullmatch(r'\+971[0-9]{9}', phone):
            raise AccountError('INVALID_OWNER_PHONE')
        self.context = guest_context()
        self.phone, self.mutate = phone, mutate
        self.body = {'phone_number': phone, 'device_id': self.context['device_id'].lower(),
                     'biometric_setup_available': False, 'secret_key_available': False}
        self.pending, self.tokens = None, None
        # Legacy name: this is a consumed-attempt latch, NOT SMS dispatch proof.
        self.otp_sent = False
        self.otp_result = None
        self.otp_expires = 0
        self.otp_attempted = False
        self.last_challenge = None
        self.card_attempted = False

    def login(self, *, diagnose_only=False):
        # A fresh negotiation invalidates previous challenge/verification state,
        # even when it fails or is diagnostic-only. Never reset attempt latches.
        self.pending, self.tokens, self.last_challenge = None, None, None
        self.otp_expires = 0
        h = dict(self.context['headers'])
        h['authorization'] = self.context['basic']
        h['x-idp-client-id'] = self.context['client_id']
        h['Device'] = self.context['device_id']
        code, data = http_request('login', h, self.body, allow_mutation=self.mutate)
        if diagnose_only:
            return error_summary(code, data)  # no OTP/exchange/publication, even on success
        if code in (400, 401, 403):
            result = challenge(data)
            if result:
                self.pending = data
                self.last_challenge = result['challenge']
                return result
        if code != 200 or not isinstance(data.get('token'), str) or not data['token']:
            raise AccountError('LOGIN_HTTP_' + str(code))
        # Only an actual successful onboarder proof may reach token exchange.
        form = {'grant_type': 'urn:careem:oauth2:grant_type:proof', 'token': data['token'],
                'device_id': self.context['device_id'], 'client_id': self.context['client_id'],
                'client_secret': self.context['client_secret']}
        code, tokens = http_request('token', {'Authorization': self.context['basic'],
            'User-Agent': self.context['headers'].get('user-agent', '')}, form, allow_mutation=self.mutate)
        if code != 200 or not isinstance(tokens.get('access_token'), str) or not isinstance(tokens.get('refresh_token'), str):
            raise AccountError('TOKEN_EXCHANGE_FAILED')
        identity = verify_customer(tokens['access_token'], self.phone, self.context['headers'])
        self.tokens = tokens
        self.pending = None
        self.identity = identity
        return {'stage': 'verified_customer', 'account_verified': True, 'expires_at': expiry(tokens['access_token'])}

    def request_otp(self):
        if self.last_challenge != 'OTP' or self.otp_sent:
            raise AccountError('OTP_STAGE_INVALID_OR_ALREADY_SENT')
        if not self.mutate:
            raise AccountError('AUTH_MUTATION_NOT_ENABLED')
        code, config = http_request('pow', self.context['headers'])
        if code != 200:
            raise AccountError('POW_UNAVAILABLE')
        guard = solve_pow(config)
        body = {'client_id': self.context['client_id'], 'identifier': self.phone,
                'type': 'SMS', 'locale': 'en', 'multiTimeUse': False, 'guard': guard}
        # Mark before send: an ambiguous timeout must not cause duplicate OTP.
        self.otp_sent = True
        started = time.monotonic()
        self.otp_result = {'stage': 'otp_request_outcome_unknown',
                           'acceptance_verified': False, 'delivery_verified': False}
        code, data = http_request('otp', self.context['headers'], body, allow_mutation=True)
        fields = ('retry_in', 'expires_in', 'otp_length')
        self.otp_result = {'stage': 'otp_response_unverified', 'http_status': code,
            'acceptance_verified': False, 'delivery_verified': False,
            'diagnostic': error_summary(code, data),
            'response_field_types': {k: type(data[k]).__name__ for k in fields if k in data}
                if isinstance(data, dict) else {}}
        if (code != 202 or not isinstance(data, dict)
                or any(k in data for k in ('error', 'error_description', 'additional_information'))
                or any(type(data.get(k)) is not int for k in fields)):
            raise AccountError('OTP_REQUEST_FAILED_OR_CHALLENGE_REQUIRED')
        if (not 0 <= data['retry_in'] <= 2**31-1 or not 1 <= data['expires_in'] <= 3600
                or not 4 <= data['otp_length'] <= 8):
            raise AccountError('OTP_RESPONSE_UNVERIFIED')
        # Conservatively include network time; a slow response cannot extend TTL.
        self.otp_expires = started+data['expires_in']
        self.otp_length = data['otp_length']
        self.otp_result = {'stage': 'otp_request_accepted', 'http_status': code,
            'acceptance_verified': True, 'delivery_verified': False,
            **{k: data[k] for k in fields}}
        # Retry metadata is diagnostic only; the one-attempt latch stays set.
        return dict(self.otp_result)

    def verify_otp(self, code):
        if (self.last_challenge != 'OTP' or not self.otp_sent or self.otp_attempted
                or time.monotonic() >= self.otp_expires
                or not re.fullmatch(r'[0-9]{'+str(getattr(self, 'otp_length', 0))+r'}', code)):
            raise AccountError('OTP_STAGE_INVALID_OR_EXPIRED')
        self.otp_attempted = True
        status, data = http_request('verify', self.context['headers'],
            {'client_id': self.context['client_id'], 'identifier': self.phone, 'code': code},
            allow_mutation=self.mutate)
        if status != 200 or not isinstance(data.get('id'), str) or not data['id']:
            raise AccountError('OTP_VERIFICATION_FAILED')
        self.body['otp'] = data['id']  # server verification ID, not SMS digits
        return self.login()

    def confirm_existing_user(self):
        if self.last_challenge != 'RETURNING_USER_CONFIRMATION':
            raise AccountError('CHALLENGE_STAGE_INVALID')
        self.body['existing_user_confirmed'] = True
        return self.login()

    def answer_challenge(self, kind, value):
        state = challenge(self.pending or {})
        if not state or state['challenge'] != 'TRY_ANOTHER_WAY' or kind not in state['options']:
            raise AccountError('CHALLENGE_NOT_OFFERED')
        if self.card_attempted or kind != 'CARD' or not re.fullmatch(r'[0-9]{4}', value):
            raise AccountError('CHALLENGE_AUTOMATION_UNVERIFIED')
        self.card_attempted = True
        self.body['card_verification'] = value
        return self.login()

    def publish(self):
        if not self.mutate or not self.tokens or self.pending is not None:
            raise AccountError('ACCOUNT_NOT_VERIFIED')
        # Reconfirm before persistence; publisher never targets the guest entry.
        identity = verify_customer(self.tokens['access_token'], self.phone, self.context['headers'])
        value = {'version': 1, 'account_verified': True, 'identity': identity,
                 'auth': self.tokens, 'client': self.context, 'verified_at': time.time()}
        value['client'] = copy.deepcopy(self.context)
        value['client']['headers'].pop('authorization', None)
        value['client']['headers'].pop('x-careem-userid', None)
        store(ACCOUNT, value)
        return {'ok': True, 'stage': 'account_saved', 'account_verified': True,
                'expires_at': expiry(self.tokens['access_token'])}


def account():
    try:
        value = load(ACCOUNT)
        if not isinstance(value, dict) or value.get('account_verified') is not True:
            raise AccountError('ACCOUNT_CAPTURE_REQUIRED')
        auth, identity = value['auth'], value['identity']
        claims = jwt_claims(auth['access_token'])
        if claims.get('kind') != 'CUSTOMER' or str(claims.get('sub')) != identity['sub']:
            raise AccountError('ACCOUNT_IDENTITY_MISMATCH')
        if expiry(auth['access_token']) <= time.time()+30:
            raise AccountError('AUTH_EXPIRED_RENEWAL_REQUIRED')
        return value
    except AccountError:
        raise
    except Exception:
        raise AccountError('ACCOUNT_STORAGE_INVALID') from None


def refresh(*, mutate=False):
    if not mutate:
        raise AccountError('AUTH_MUTATION_NOT_ENABLED')
    # Expiry is permitted here, but identity/client provenance remains required.
    value = load(ACCOUNT)
    if not isinstance(value, dict) or value.get('account_verified') is not True:
        raise AccountError('ACCOUNT_CAPTURE_REQUIRED')
    try:
        c, identity = value['client'], value['identity']
        old = value.get('renewal_pending') or value['auth']
        if jwt_claims(old['access_token']).get('kind') != 'CUSTOMER':
            raise AccountError('CUSTOMER_TOKEN_REQUIRED')
        form = {'grant_type': 'refresh_token', 'response_type': 'token',
                'refresh_token': old['refresh_token'], 'client_id': c['client_id'],
                'client_secret': c['client_secret']}
    except (KeyError, TypeError):
        raise AccountError('ACCOUNT_STORAGE_INVALID') from None
    status, tokens = http_request('token', {'Authorization': c['basic'],
        'User-Agent': c['headers'].get('user-agent', '')}, form, allow_mutation=True)
    if status != 200 or not isinstance(tokens.get('access_token'), str):
        raise AccountError('ACCOUNT_REFRESH_FAILED')
    candidate = {**old, **tokens}
    claims = jwt_claims(candidate['access_token'])
    if (claims.get('kind') != 'CUSTOMER' or str(claims.get('sub')) != identity['sub']
            or not candidate.get('refresh_token') or expiry(candidate['access_token']) <= time.time()+30):
        raise AccountError('CUSTOMER_TOKEN_REQUIRED')
    # Preserve rotation privately if profile validation cannot finish, without
    # presenting the unverified candidate as usable account material.
    pending = copy.deepcopy(value)
    pending['renewal_pending'] = candidate
    store(ACCOUNT, pending)
    verify_customer(candidate['access_token'], identity['phone_number'], c['headers'])
    pending.update(auth=candidate, verified_at=time.time())
    pending.pop('renewal_pending', None)
    store(ACCOUNT, pending)
    return {'ok': True, 'account_verified': True, 'expires_at': expiry(candidate['access_token'])}


@contextmanager
def auth_lock():
    path = Path.home()/'.local/state/careem-account/auth.lock'
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AccountError('ACCOUNT_AUTH_BUSY') from None
        yield


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['status', 'bootstrap', 'refresh', 'probe-login'])
    p.add_argument('--execute', action='store_true', help='explicitly enable native auth mutations')
    args = p.parse_args()
    try:
        if args.command == 'status':
            value = account()
            result = {'ok': True, 'account_verified': True, 'expires_at': expiry(value['auth']['access_token'])}
        elif not args.execute:
            result = {'ok': False, 'error': 'AUTH_MUTATION_NOT_ENABLED',
                      'next': 'Use --execute for a separately authorized native auth operation.'}
        else:
            with auth_lock():
                if args.command == 'refresh':
                    result = refresh(mutate=True)
                elif args.command == 'probe-login':
                    flow = Bootstrap(getpass.getpass('Owner phone (+971...): '), mutate=True)
                    result = {'ok': False, 'diagnostic': flow.login(diagnose_only=True)}
                else:
                    flow = Bootstrap(getpass.getpass('Owner phone (+971...): '), mutate=True)
                    result = flow.login()
                    for _ in range(5):
                        if result['stage'] == 'verified_customer':
                            result = flow.publish()
                            break
                        if result.get('challenge') == 'OTP' and not flow.otp_sent:
                            flow.request_otp()
                            result = flow.verify_otp(getpass.getpass('Careem SMS code: '))
                        elif result.get('challenge') == 'RETURNING_USER_CONFIRMATION':
                            if getpass.getpass('Confirm this is the existing owner account (yes): ').lower() != 'yes':
                                result = {'ok': False, 'error': 'EXISTING_ACCOUNT_CONFIRMATION_PENDING'}
                                break
                            result = flow.confirm_existing_user()
                        elif result.get('challenge') == 'TRY_ANOTHER_WAY' and 'CARD' in result.get('options', []):
                            result = flow.answer_challenge('CARD', getpass.getpass('Offered Careem card verification (last four): '))
                        else:
                            result = {'ok': False, **result, 'error': 'ADDITIONAL_CHALLENGE_PENDING'}
                            break
                    else:
                        result = {'ok': False, 'error': 'CHALLENGE_LIMIT_REACHED'}
        print(json.dumps(result))
        return 0 if result.get('ok') else 1
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc) if isinstance(exc, AccountError) else 'ACCOUNT_AUTH_FAILED'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
