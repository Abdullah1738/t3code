"""Careem clone capture: metadata stdout; selected read templates only in Keychain."""
import json
import re
import sys
import time
import socket
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from mitmproxy import http
sys.path.insert(0, str(Path(__file__).resolve().parent))
from keychain import store, load as keychain_load
from metadata_only import emit, log_path as base_log_path, schema

DOMAINS = ('careem.com','careemapis.com','careemdash.com','careem-engineering.com')
DENY = re.compile(r'/(?:cart|checkout|payments?|cards?|bookings?|orders?)(?:/|$)|place.?order|add.to.cart|/rides/[^/]+/(?:cancel|rating|tip)(?:/|$)', re.I)
READ = re.compile(r'search|menu|/merchant/nearest$|/merchant/[^/]+/info$|/userinfo$', re.I)


def log_path(path):
    path = re.sub(r'(/identity/device/)[^/]+', r'\1{identifier}', path)
    return re.sub(r'(?<=/)[+0-9][0-9-]{6,}(?=/|$)','{identifier}',base_log_path(path))


def careem_host(host):
    return any(host == d or host.endswith('.'+d) for d in DOMAINS) if host else False


def tls_clienthello(data):
    host = data.client_hello.sni
    if not careem_host(host):
        data.ignore_connection = True
        return
    # The phone prefers IPv6 destinations that the Mac cannot route (errno 65).
    # Resolve the observed TLS hostname locally instead of reusing that phone IP.
    address = data.context.server.address
    if address and ':' in address[0]:
        try:
            data.context.server.address = (socket.gethostbyname(host), address[1])
            data.context.server.sni = host
            emit('request', host=host, path='[TLS route]', method='CONNECT', ipv6_rerouted=True)
        except OSError:
            pass


def tls_failed_client(data):
    if careem_host(data.conn.sni): emit('tls_failed',host=data.conn.sni,kind='tls_failure')


def request(flow):
    u = urlsplit(flow.request.pretty_url)
    if not careem_host(u.hostname): return
    if DENY.search(u.path) or (flow.request.method in ('PUT','PATCH','DELETE')) or (
        flow.request.method == 'POST' and re.search(r'/rides(?:/|$)',u.path) and not re.fullmatch(r'/v[12]/rides/estimate',u.path)):
        flow.response = http.Response.make(409,b'Read-only capture window',{'content-type':'text/plain'})
        emit('write_blocked',host=u.hostname,path=log_path(u.path))
        return
    flow.metadata['careem_url'] = flow.request.pretty_url
    flow.metadata['careem_read'] = bool(READ.search(u.path)) and (flow.request.method == 'GET' or (flow.request.method == 'POST' and any(x in u.path for x in ('estimate','search'))))
    body_keys = []
    try:
        d=json.loads(flow.request.content or b'null')
        if isinstance(d,dict): body_keys=list(d)
    except Exception: pass
    emit('request',host=u.hostname,path=log_path(u.path),method=flow.request.method,
         query_keys=list(parse_qs(u.query)),header_names=sorted(flow.request.headers.keys()),body_keys=body_keys)


def response(flow):
    if 'careem_url' not in flow.metadata: return
    u=urlsplit(flow.metadata['careem_url'])
    emit('response',host=u.hostname,path=log_path(u.path),status=flow.response.status_code)
    if not flow.metadata['careem_read'] or flow.response.status_code != 200: return
    try:
        d=json.loads(flow.response.content)
        saved=keychain_load('careem') or {'templates':{}}
        saved['templates'][flow.request.method+' '+u.hostname+u.path]={
            'captured_at':time.time(),'url':flow.metadata['careem_url'],
            'method':flow.request.method,'headers':dict(flow.request.headers),
            'body':flow.request.get_text(strict=False),'response':d}
        store('careem',saved)
        # Save values only in Keychain; inspect schema explicitly later to avoid
        # repeating large component trees on every native home refresh.
        emit('keychain_saved',account='careem',path=log_path(u.path),
             response_type=type(d).__name__,keys=list(d)[:30] if isinstance(d,dict) else [])
    except Exception: emit('keychain_error',account='careem')


def error(flow):
    if 'careem_url' not in flow.metadata: return
    u=urlsplit(flow.metadata['careem_url'])
    text=str(flow.error or '').lower()
    kind='timeout' if 'timeout' in text else 'certificate' if 'certificate' in text else 'upstream_failure'
    markers=[x for x in ('http/2','http2','reset','refused','closed','disconnect','tls','protocol','unreachable','stream',
                        'killed','crashed','unknown','destination','resolve','hostname','server','address',
                        'connect','socks','eof','alpn','handshake','invalid','cancel','certificate',
                        'http','response','received','client','peer','unexpected','empty','route','host','errno','permission','operation') if x in text]
    emit('response',host=u.hostname,path=log_path(u.path),status=None,error_kind=kind,error_markers=markers,
         error_length=len(text),errno=re.findall(r'errno (\d+)',text))
