"""Guest-only Careem renewal. Secrets stay in memory and macOS Keychain."""
import argparse
import base64
import copy
import fcntl
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent / 'capture'))
from keychain import load, store


class AuthError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def claims(token):
    try:
        part = token.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except Exception:
        raise AuthError('INVALID_TOKEN') from None


def bearer(saved):
    for template in saved.get('templates', {}).values():
        for key, value in template.get('headers', {}).items():
            if key.lower() == 'authorization' and value.startswith('Bearer '):
                return value[7:]
    raise AuthError('NATIVE_CAPTURE_REQUIRED')


def request(url, headers, timeout, data=None):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(urllib.request.Request(url, headers=headers, data=data), timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise AuthError('AUTH_HTTP_' + str(error.code)) from None
    except (OSError, ValueError):
        raise AuthError('AUTH_NETWORK_OR_RESPONSE_ERROR') from None


def validate(saved, token, timeout):
    c = claims(token)
    if c.get('kind') != 'GUEST' or c.get('exp', 0) <= time.time() + 60:
        raise AuthError('FRESH_GUEST_TOKEN_REQUIRED')
    template = saved.get('templates', {}).get('GET appengine.careemapis.com/v1/page/quik-search-listing')
    if not template:
        raise AuthError('NATIVE_CAPTURE_REQUIRED')
    u = urllib.parse.urlsplit(template['url'])
    if u.scheme != 'https' or u.netloc != 'appengine.careemapis.com' or u.path != '/v1/page/quik-search-listing':
        raise AuthError('ENDPOINT_DENIED')
    headers = {k: v for k, v in template['headers'].items() if k.lower() not in
               {'authorization', 'host', 'content-length', 'accept-encoding', 'if-none-match', 'if-modified-since'}}
    headers['Authorization'] = 'Bearer ' + token
    result = request(template['url'], headers, timeout)
    if not isinstance(result, dict) or 'body' not in result or result.get('metadata', {}).get('page_error_count', 0):
        raise AuthError('AUTH_CATALOG_VALIDATION_FAILED')


def refresh(rejected_token=None, timeout=15):
    """Rotate once under flock; concurrent 401 callers reuse the winning rotation."""
    if rejected_token is None:
        rejected_token = bearer(load('careem') or {})
    directory = Path.home() / '.local/state/careem-auth'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / 'refresh.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, 'w') as lock:
        deadline = time.monotonic() + 35
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise AuthError('AUTH_REFRESH_BUSY') from None
                time.sleep(0.05)
        saved = load('careem') or {}
        current = bearer(saved)
        if rejected_token is not None and current != rejected_token and claims(current).get('exp', 0) > time.time() + 60:
            return saved
        auth = saved.get('refresh_auth', {})
        previous = saved.get('refresh_bootstrap', {})
        if not auth.get('authorization') or not previous.get('refresh_token'):
            raise AuthError('AUTH_REFRESH_BOOTSTRAP_REQUIRED')
        if claims(previous.get('access_token', '')).get('kind') != 'GUEST':
            raise AuthError('GUEST_ONLY')
        fields = {'grant_type': 'refresh_token', 'refresh_token': previous['refresh_token']}
        fields.update(auth.get('fields', {}))
        headers = {'Authorization': auth['authorization'], 'Content-Type': 'application/x-www-form-urlencoded'}
        if auth.get('agent'):
            headers['User-Agent'] = auth['agent']
        result = request('https://identity.careem.com/token', headers, timeout,
                         urllib.parse.urlencode(fields).encode())
        if not isinstance(result, dict) or not isinstance(result.get('access_token'), str):
            raise AuthError('AUTH_INVALID_RESPONSE')
        token = result['access_token']
        c = claims(token)
        if c.get('kind') != 'GUEST' or c.get('exp', 0) <= time.time() + 60:
            raise AuthError('FRESH_GUEST_TOKEN_REQUIRED')
        updated = copy.deepcopy(saved)
        updated['refresh_bootstrap'] = {**previous, **result}
        # Preserve rotated renewal material even if catalog validation is temporarily down.
        # Catalog headers remain unchanged until the fresh guest token passes a live read.
        store('careem', updated)
        validate(saved, token, timeout)
        for template in updated.get('templates', {}).values():
            for key in list(template.get('headers', {})):
                if key.lower() == 'authorization' and template['headers'][key].startswith('Bearer '):
                    template['headers'][key] = 'Bearer ' + token
        updated['auth_refreshed_at'] = int(time.time())
        store('careem', updated)
        return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['refresh', 'status'])
    args = parser.parse_args()
    try:
        saved = refresh() if args.command == 'refresh' else load('careem') or {}
        c = claims(bearer(saved))
        print(json.dumps({'ok': True, 'scope': c.get('kind'), 'expires_at': c.get('exp'),
                          'expires_in': max(0, int(c.get('exp', 0) - time.time())),
                          'renewal_ready': bool(saved.get('refresh_auth') and saved.get('refresh_bootstrap', {}).get('refresh_token'))}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, AuthError) else 'AUTH_STORAGE_OR_INTERNAL_ERROR'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
