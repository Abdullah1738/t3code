"""No flow files, bodies, URLs with queries, cookies or auth values are logged."""
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from mitmproxy import http
sys.path.insert(0, str(Path(__file__).resolve().parent))
from keychain import store, load as keychain_load

READ_PATH = re.compile(r'(search|suggest|catalog|whoami|address/list|config|otp-channels|otp-request|oauth2|mobile-verification)', re.I)
TALABAT_READ = re.compile(r'^/(?:grocery/v2/TB_AE/branches/[0-9]+$|grocery/v1/bff/ae/vendors/[a-f0-9-]+/products/search$|search/api/v(?:1/verticals|3/vendor)$|menubff/v4/branches/[0-9]+/menu$|vendor-list/v1/pre-search$|api/v2/user/addresses$|customers/v1/profile$|api/v3/apps/address$|user/v1/address$)')

def log_path(path):
    if path.lower().startswith('/api/location/'): return '/api/Location/{lat}/{lon}/{country}'
    return re.sub(r'(?<=/)[A-Za-z0-9_.-]{32,}(?=/|$)', '{identifier}', path)

def schema(value, depth=0):
    """Types and field names only; never values, including error strings."""
    if depth >= 5: return type(value).__name__
    if isinstance(value, dict):
        return {k: schema(v, depth+1) for k, v in list(value.items())[:80]}
    if isinstance(value, list): return [schema(value[0], depth+1)] if value else []
    return type(value).__name__

def emit(event, **data):
    print(json.dumps({'event': event, **data}), flush=True)

def tls_clienthello(data):
    # SOCKS destinations are IPs; decide interception after seeing TLS SNI.
    # Leave analytics/Google and other SDKs on their original TLS connection.
    if not (data.client_hello.sni or '').endswith(('.talabat.com', '.noon.com')):
        data.ignore_connection = True

def tls_failed_client(data):
    if not (data.conn.sni or '').endswith(('.talabat.com', '.noon.com')): return
    # Error strings can contain URLs; classify instead of logging them.
    text = str(data.conn.error or '').lower()
    kind = 'untrusted_certificate' if any(x in text for x in ['certificate', 'unknown ca', 'alert']) else 'tls_failure'
    emit('tls_failed', host=data.conn.sni, kind=kind)

def request(flow: http.HTTPFlow):
    u = urlsplit(flow.request.pretty_url)
    if not u.hostname or not (u.hostname.endswith('.noon.com') or u.hostname.endswith('.talabat.com')):
        return
    flow.metadata['capture_url'] = flow.request.pretty_url
    # Reject writes during the brief capture window, before forwarding them.
    if re.search(r'(place.?order|/order/place|/payment(?:/|$)|/checkout|/cart(?:/|$)|session/sync|add-to-cart)', u.path, re.I):
        flow.response = http.Response.make(409, b'Read-only capture window', {'content-type': 'text/plain'})
        emit('write_blocked', host=u.hostname, path=log_path(u.path))
        return
    talabat_read = u.hostname.endswith('.talabat.com') and bool(TALABAT_READ.search(u.path)) and (
        flow.request.method == 'GET' or (flow.request.method == 'POST' and ('search' in u.path or u.path == '/api/v3/vendor')))
    nownow_read = (u.hostname == 'api-app-fd.noon.com' and
                   u.path == '/_svc/mp-shop-api-ctnoon/v2/content/search' and flow.request.method == 'GET')
    flow.metadata['nownow_read'] = nownow_read
    if not READ_PATH.search(u.path) and not u.hostname.endswith('.talabat.com') and not nownow_read:
        return
    flow.metadata['inspect_read'] = True
    flow.metadata['talabat_read'] = talabat_read
    auth_shape = {}
    for k, v in flow.request.headers.items():
        if k.lower() in ['authorization', 'cookie'] or re.search(r'(token|session|sign|key)', k, re.I):
            auth_shape[k.lower()] = {
                'present': bool(v),
                'kind': 'bearer' if v.lower().startswith('bearer ') else 'jwt' if len(v.split('.')) == 3 and v.startswith('eyJ') else 'opaque',
            }
    body_keys = []
    try:
        d = json.loads(flow.request.content or b'null')
        if isinstance(d, dict): body_keys = list(d)
    except Exception:
        pass
    emit('request', host=u.hostname, path=log_path(u.path), method=flow.request.method,
         query_keys=list(parse_qs(u.query)), header_names=sorted(flow.request.headers.keys()),
          auth_shape=auth_shape, body_keys=body_keys)

def error(flow: http.HTTPFlow):
    if not flow.metadata.get('inspect_read'): return
    text = str(flow.error or '').lower()
    u = urlsplit(flow.metadata.get('capture_url', flow.request.pretty_url))
    emit('response', host=u.hostname, path=log_path(u.path),
         status=None, error_kind='timeout' if 'timeout' in text else 'upstream_failure')

def response(flow: http.HTTPFlow):
    if not flow.metadata.get('inspect_read'): return
    keys = []
    try:
        d = json.loads(flow.response.content)
        if isinstance(d, dict): keys = list(d)
    except Exception:
        pass
    u = urlsplit(flow.metadata.get('capture_url', flow.request.pretty_url))
    emit('response', host=u.hostname, path=log_path(u.path),
          status=flow.response.status_code, keys=keys)
    if flow.metadata.get('nownow_read') and flow.response.status_code == 200:
        try:
            d = json.loads(flow.response.content)
            saved = keychain_load('nownow') or {'templates': {}}
            saved['templates'][flow.request.method+' '+u.hostname+u.path] = {
                'captured_at': time.time(), 'url': flow.metadata['capture_url'],
                'method': flow.request.method, 'headers': dict(flow.request.headers),
                'body': flow.request.get_text(strict=False), 'response': d,
            }
            store('nownow', saved)
            emit('keychain_saved', account='nownow', path=log_path(u.path), schema=schema(d))
        except Exception:
            emit('keychain_error', account='nownow')
    if flow.metadata.get('talabat_read') and flow.response.status_code == 200:
        try:
            d = json.loads(flow.response.content)
            saved = keychain_load('talabat') or {'templates': {}}
            saved['templates'][flow.request.method+' '+u.hostname+u.path] = {
                'captured_at': time.time(), 'url': flow.metadata['capture_url'],
                'method': flow.request.method, 'headers': dict(flow.request.headers),
                'body': flow.request.get_text(strict=False), 'response': d,
            }
            store('talabat', saved)
            emit('keychain_saved', service='app-api-cli.native', account='talabat', path=u.path,
                 schema=schema(d))
        except Exception:
            emit('keychain_error', account='talabat')
    if flow.response.status_code == 200 and u.path in ['/_svc/catalog/search','/_svc/catalog/api/v3/u/search'] and u.hostname in ['api-app-instant.noon.com','api-app.noon.com']:
        name = 'minutes' if 'instant' in u.hostname else 'noon' if 'noon.com' in u.hostname else 'talabat'
        try:
            store(name, {'captured_at': time.time(), 'url': flow.request.url,
                  'method': flow.request.method, 'headers': dict(flow.request.headers),
                  'body': flow.request.get_text(strict=False)})
            emit('keychain_saved', service='app-api-cli.native', account=name)
        except Exception:
            emit('keychain_error', account=name)
