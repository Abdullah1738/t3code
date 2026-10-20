"""Bounded proxy window with automatic rollback; all secret data stays in RAM.

This is a diagnostic, not part of the search CLI. Only run while phone is idle.
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

SERIAL = os.environ.get('CAPTURE_SERIAL', '002473611000997')
PORT = '18089'
KEYS = ['http_proxy', 'global_http_proxy_host', 'global_http_proxy_port',
        'global_http_proxy_exclusion_list', 'global_proxy_pac_url']
BASE = Path(__file__).resolve().parent
CONF = Path('/private/var/folders/vt/8qndzr_j44z70bh0rn2zyfkm0000gn/T/opencode/recon/mitmconf')
HOLD = Path.home()/'.local/share/phone-lock/priority-hold'

def adb(*args):
    r = subprocess.run(['adb', '-s', SERIAL, *args], capture_output=True, text=True, timeout=12)
    if r.returncode: raise RuntimeError('ADB operation failed')
    return r.stdout.strip()

def interrupted(*_): raise KeyboardInterrupt()

def restore_proxy(before):
    """Clear ConnectivityService's cached proxy before restoring settings rows.

    Deleting HTTP_PROXY alone is insufficient: Android's deprecated proxy loader
    returns without clearing mGlobalProxy when the value is empty.
    """
    failures = []
    try:
        adb('shell', 'settings', 'put', 'global', 'http_proxy', ':0')
        time.sleep(0.3)  # allow the settings observer to clear its in-memory proxy
    except Exception:
        failures.append('clear_cached_proxy')
    for k, v in before.items():
        if k == 'http_proxy' and v in ('null', '', ':0'):
            # Explicit owner rule: preserve :0, not a misleading null row.
            continue
        try:
            adb('shell', 'settings', 'delete', 'global', k) if v == 'null' else adb('shell', 'settings', 'put', 'global', k, "''" if v == '' else v)
        except Exception:
            failures.append(k)
    return failures

def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 75
    if not 5 <= seconds <= 120: raise SystemExit('Use a 5–120 second window')
    if HOLD.exists() and not SERIAL.startswith('emulator-'): raise SystemExit('Priority phone hold: capture not started')
    before = {k: adb('shell', 'settings', 'get', 'global', k) for k in KEYS}
    proxy = None
    signal.signal(signal.SIGTERM, interrupted)
    try:
        proxy = subprocess.Popen([
            str(Path.home()/'.local/bin/mitmdump'), '-q', '--listen-host', '127.0.0.1', '-p', PORT,
            '--set', f'confdir={CONF}', '--set', 'connection_strategy=lazy',
            '--set', 'termlog_verbosity=error', '--set', 'flow_detail=0',
            '--set', r'allow_hosts=^(.+\.)?(noon\.com|talabat\.com)(:\d+)?$',
            '-s', str(BASE/'metadata_only.py'),
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        time.sleep(1)
        if proxy.poll() is not None: raise RuntimeError('Proxy failed to start')
        adb('reverse', f'tcp:{PORT}', f'tcp:{PORT}')
        adb('shell', 'settings', 'put', 'global', 'http_proxy', f'127.0.0.1:{PORT}')
        print(json.dumps({'event': 'ready', 'seconds': seconds}), flush=True)
        end = time.monotonic() + seconds
        import select
        while time.monotonic() < end:
            if proxy.poll() is not None or HOLD.exists(): break
            ready, _, _ = select.select([proxy.stdout], [], [], min(0.5, end-time.monotonic()))
            if ready:
                line = proxy.stdout.readline()
                try:
                    obj = json.loads(line)
                    if obj.get('event') in ['request', 'response', 'write_blocked', 'tls_failed', 'keychain_saved', 'keychain_error']:
                        print(json.dumps(obj), flush=True)
                except Exception: pass
    finally:
        failures = restore_proxy(before)
        try:
            subprocess.run(['adb', '-s', SERIAL, 'reverse', '--remove', f'tcp:{PORT}'], capture_output=True, timeout=12)
        except Exception:
            failures.append('reverse_remove')
        if proxy is not None:
            proxy.terminate()
            try: proxy.wait(timeout=5)
            except subprocess.TimeoutExpired: proxy.kill(); proxy.wait()
        after = {k: adb('shell', 'settings', 'get', 'global', k) for k in KEYS}
        expected = {**before, 'http_proxy': ':0' if before['http_proxy'] in ('null', '', ':0') else before['http_proxy']}
        print(json.dumps({'event': 'restored', 'settings_match': after == expected,
                          'cleanup_failures': failures}), flush=True)

if __name__ == '__main__': main()
