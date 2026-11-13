"""At-most-once handoff of a native payment redirect to a dedicated Dia window."""
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

import commerce_journal as j


def open_once(flow_id, intent_hash, url, *, opener=None):
    j._flow(flow_id)
    if not j._hash(intent_hash):
        j.fail('PAYMENT_REDIRECT_INTENT_INVALID')
    local = j.inspect(flow_id)
    if local['state'] not in ('ACTIVE', 'FENCED'):
        j.fail('PAYMENT_REDIRECT_FLOW_CLOSED')
    if not isinstance(url, str) or len(url) > 16000 or any(ord(c) < 33 for c in url):
        j.fail('PAYMENT_REDIRECT_URL_INVALID')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        j.fail('PAYMENT_REDIRECT_URL_INVALID')
    root = j.ROOT / 'redirect-attempts'
    root.mkdir(mode=0o700, exist_ok=True)
    j._stat(root, True)
    path = root / (flow_id + '.json')
    # Consume before browser I/O. A timeout/crash can mean the bank saw it;
    # an uncertain attempt must never be opened again automatically.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        j._stat(path)
        prior = json.loads(path.read_text())
        if prior.get('intent_hash') != intent_hash:
            j.fail('PAYMENT_REDIRECT_INTENT_CHANGED')
        if prior.get('opened') is not True:
            j.fail('PAYMENT_REDIRECT_OPEN_UNCONFIRMED_NO_RETRY')
        return {'attempted': True, 'reopened': False}
    with os.fdopen(fd, 'w') as out:
        json.dump({'intent_hash': intent_hash, 'url_hash': j.digest(url)}, out)
        out.flush()
        os.fsync(out.fileno())
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    try:
        opened = (opener or open_dia)(url)
    except Exception:
        opened = False
    if not opened:
        j.fail('PAYMENT_REDIRECT_OPEN_UNCONFIRMED_NO_RETRY')
    with path.open('w') as out:
        json.dump({'intent_hash': intent_hash, 'url_hash': j.digest(url), 'opened': True}, out)
        out.flush()
        os.fsync(out.fileno())
    return {'attempted': True, 'opened': True, 'reopened': False}


def open_dia(url):
    env = {k: v for k, v in os.environ.items()
           if k not in ('NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT')}
    result = subprocess.run(['node', str(Path(__file__).with_name('commerce_dia_redirect.mjs'))],
        input=json.dumps({'url': url}), text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=125, env=env)
    return result.returncode == 0 and json.loads(result.stdout).get('opened') is True
