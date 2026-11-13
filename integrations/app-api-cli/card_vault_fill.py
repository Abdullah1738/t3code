#!/usr/bin/env python3
"""Fill one focused card field after checking the exact purchase approval."""
import argparse
import json
import re
import subprocess
import sys

import owner_go


# Secrets enter the subprocess through stdin, never source code or its arguments.
CDP_FILL = r'''
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const timer = setTimeout(() => process.exit(2), 15000);
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const target = targets.find(t => t.id === input.target);
  if (!target || !/^wss?:\/\/(127\.0\.0\.1|localhost):9222\//.test(target.webSocketDebuggerUrl)) throw Error();
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
  ws.close(); clearTimeout(timer);
})().catch(() => { process.exitCode = 2; clearTimeout(timer); process.exit(2); });
'''


def fill(*, vendor, item, amount, currency, card, field, recurring=None,
         target=None, selector=None, runner=subprocess.run):
    owner_go.require(vendor=vendor, item=item, amount=amount, currency=currency, recurring=recurring)
    if field not in ('card_name', 'card_number', 'card_expiry', 'card_cvc') or not re.fullmatch(r'[A-Za-z0-9]+', card):
        raise ValueError('invalid card or field')
    if bool(target) != bool(selector):
        raise ValueError('Dia fill requires both --cdp-target and --selector')
    value = runner(['security', 'find-generic-password', '-s', 'robob-card', '-a', f'{card}.{field}', '-w'],
                   capture_output=True, text=True, timeout=20)
    if value.returncode or not value.stdout.strip():
        raise ValueError('Keychain read failed')
    secret = value.stdout.strip()
    if target:
        result = runner(['node', '-e', CDP_FILL], input=json.dumps(dict(target=target, selector=selector, value=secret)),
                        capture_output=True, text=True, timeout=20)
    else:
        result = runner(['ph', 'type', secret], capture_output=True, text=True, timeout=20)
    if result.returncode:
        # Tools may echo the input on failure. Never forward their diagnostics.
        raise ValueError('card fill failed')
    return {'ok': True, 'filled': field}


def main(argv=None):
    p = argparse.ArgumentParser(prog='card-vault-fill')
    for arg in ('vendor', 'item', 'amount', 'currency', 'card', 'field'):
        p.add_argument('--' + arg, required=True, type=int if arg == 'amount' else str)
    p.add_argument('--recurring')
    p.add_argument('--cdp-target', dest='target')
    p.add_argument('--selector')
    try:
        print(json.dumps(fill(**vars(p.parse_args(argv)))))
        return 0
    except owner_go.ApprovalError as exc:
        print(json.dumps({'ok': False, 'error': 'OWNER_GO_REQUIRED', 'reason': str(exc)}))
        return 4
    except (ValueError, OSError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'error': 'CARD_FILL_FAILED'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
