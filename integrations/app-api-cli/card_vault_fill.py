#!/usr/bin/env python3
"""Fill one focused card field after checking the exact purchase approval."""
import argparse
import json
import os
import re
import subprocess
import sys
from time import perf_counter
import uuid
import xml.etree.ElementTree as ET

import owner_go
import toollog


# Secrets enter the subprocess through stdin, never source code or its arguments.
CDP_FILL = r'''
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const timer = setTimeout(() => process.exit(2), 15000);
(async () => {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw Error();
  const targets = await (await fetch(`http://127.0.0.1:${input.port}/json/list`, {redirect: 'error'})).json();
  const target = targets.find(t => t.id === input.target);
  const loopback = new RegExp('^wss?://(127\\.0\\.0\\.1|localhost):' + input.port + '/');
  if (!target || !loopback.test(target.webSocketDebuggerUrl)) throw Error();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    const listener = e => {
      const r = JSON.parse(e.data);
      if (r.id !== id) return;
      ws.removeEventListener('message', listener);
      r.error ? reject(Error()) : resolve(r.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({id, method, params}));
  });
  const focused = await send('Runtime.evaluate', {expression:
    `(() => { const e = document.querySelector(${JSON.stringify(input.selector)}); if (!e || e.disabled || e.readOnly || !['INPUT','TEXTAREA'].includes(e.tagName)) return false; e.focus(); e.select(); return document.activeElement === e; })()`, returnByValue: true});
  if (focused.exceptionDetails || focused.result?.value !== true) throw Error();
  await send('Input.insertText', {text: input.value});
  const filled = await send('Runtime.evaluate', {expression:
    `(() => { const e = document.querySelector(${JSON.stringify(input.selector)}); return !!e && document.activeElement === e && typeof e.value === 'string' && e.value.length > 0; })()`, returnByValue: true});
  if (filled.exceptionDetails || filled.result?.value !== true) throw Error();
  ws.close(); clearTimeout(timer);
})().catch(() => { process.exitCode = 2; clearTimeout(timer); process.exit(2); });
'''


class CardFillError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def phone_focused(runner, env):
    # ph ui drops the focused attribute; capture raw XML without forwarding text.
    result = runner(['ph', 'sh', 'uiautomator', 'dump', '/dev/tty'], env=env,
                    capture_output=True, text=True, timeout=20)
    try:
        xml = result.stdout[result.stdout.index('<hierarchy'):]
        root = ET.fromstring(xml[:xml.index('</hierarchy>') + len('</hierarchy>')])
        focused = [n for n in root.iter('node') if n.get('focused') == 'true']
        return (result.returncode == 0 and len(focused) == 1
                and focused[0].get('enabled') == 'true'
                and 'EditText' in focused[0].get('class', ''))
    except (ValueError, ET.ParseError):
        return False


def fill(*, vendor, item, amount, currency, card, field, recurring=None,
         target=None, selector=None, phone=False, cdp_port=None, runner=subprocess.run):
    start, code, ok, lease = perf_counter(), 'CARD_FILL_FAILED', False, None
    port = 9222 if cdp_port is None else cdp_port
    try:
        owner_go.require(vendor=vendor, item=item, amount=amount, currency=currency, recurring=recurring)
        if field not in ('card_name', 'card_number', 'card_expiry', 'card_cvc') or not re.fullmatch(r'[A-Za-z0-9]+', card):
            raise ValueError('invalid card or field')
        browser = (isinstance(target, str) and bool(target.strip())
                   and isinstance(selector, str) and bool(selector.strip()))
        if (phone and (target is not None or selector is not None or cdp_port is not None)
                or not phone and not browser):
            raise CardFillError('CARD_FILL_TARGET_REQUIRED')
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('invalid CDP port')
        if phone:
            owner = 'card-fill-' + uuid.uuid4().hex
            acquired = runner(['ph', 'lease', 'acquire', '--owner', owner,
                               '--purpose', 'card field fill', '--ttl', '2m'],
                              capture_output=True, text=True, timeout=20)
            if acquired.returncode:
                raise ValueError('phone lease unavailable')
            lease = owner
            env = {**os.environ, 'PH_LEASE_OWNER': owner}
            if not phone_focused(runner, env):
                raise CardFillError('CARD_FILL_NO_FOCUS')
        value = runner(['security', 'find-generic-password', '-s', 'robob-card', '-a', f'{card}.{field}', '-w'],
                       capture_output=True, text=True, timeout=20)
        if value.returncode or not value.stdout.strip():
            raise ValueError('Keychain read failed')
        secret = value.stdout.strip()
        if browser:
            result = runner(['node', '-e', CDP_FILL], input=json.dumps(dict(target=target, selector=selector, port=port, value=secret)),
                            capture_output=True, text=True, timeout=20)
        else:
            # ph type has no stdin option; this route is explicitly opted into.
            result = runner(['ph', 'type', secret], env=env, capture_output=True, text=True, timeout=20)
        if result.returncode:
            # Tools may echo the input on failure. Never forward their diagnostics.
            raise ValueError('card fill failed')
        ok = True
        return {'ok': True, 'filled': field}
    except owner_go.ApprovalError:
        code = 'OWNER_GO_REQUIRED'
        raise
    except CardFillError as exc:
        code = exc.code
        raise
    finally:
        if lease:
            try:
                runner(['ph', 'lease', 'release', '--owner', lease], capture_output=True, text=True, timeout=20)
            except (OSError, subprocess.SubprocessError):
                pass
        toollog.emit('card-vault-fill', 'card.fill', kind='perf' if ok else 'error', ok=ok,
                     duration_ms=(perf_counter() - start) * 1000, error=None if ok else code,
                     ids={'vendorId': vendor, 'cardId': card},
                     props={'route': 'phone' if phone else 'cdp' if target else 'unspecified',
                            'cdpPort': port if not phone and target else None, 'field': field,
                            'cardNickname': card, 'outcome': 'success' if ok else 'failure'})


def main(argv=None):
    p = argparse.ArgumentParser(prog='card-vault-fill')
    for arg in ('vendor', 'item', 'amount', 'currency', 'card', 'field'):
        p.add_argument('--' + arg, required=True, type=int if arg == 'amount' else str)
    p.add_argument('--recurring')
    p.add_argument('--cdp-target', dest='target')
    p.add_argument('--selector')
    p.add_argument('--phone', action='store_true')
    # None distinguishes an omitted default from an explicit port on --phone.
    p.add_argument('--cdp-port', type=int, help='loopback CDP port (default: 9222)')
    try:
        print(json.dumps(fill(**vars(p.parse_args(argv)))))
        return 0
    except owner_go.ApprovalError as exc:
        print(json.dumps({'ok': False, 'error': 'OWNER_GO_REQUIRED', 'reason': str(exc)}))
        return 4
    except CardFillError as exc:
        print(json.dumps({'ok': False, 'error': exc.code}))
        return 2
    except (ValueError, OSError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'error': 'CARD_FILL_FAILED'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
