"""Bounded clone-only SOCKS capture; never changes the phone's global proxy."""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time
from probe_window import adb, BASE, CONF, HOLD, SERIAL
from phone_guard import held as phone_held

CAREEM = os.environ.get('CAPTURE_APP') == 'careem'
PORT = '18091' if CAREEM else '18090'
PACKAGE = 'com.careem.capture' if CAREEM else 'com.talabat.capture'
MARKER = 'files/capture-enabled'


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    if not 5 <= seconds <= 120: raise SystemExit('Use 5–120 seconds')
    held = lambda: phone_held() and not SERIAL.startswith('emulator-')
    if held(): raise SystemExit('Priority phone hold')
    def phone(*args):
        if held(): raise SystemExit('Priority phone hold')
        return adb(*args)
    proxy = None
    def interrupt(*_): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        proxy = subprocess.Popen([
            str(Path.home()/'.local/bin/mitmdump'), '-q', '--mode', 'socks5',
            '--listen-host', '127.0.0.1', '-p', PORT, '--set', f'confdir={CONF}',
            '--set', 'connection_strategy=lazy', '--set', 'termlog_verbosity=error',
            '--set', 'flow_detail=0',
            '-s', str(BASE/('careem_metadata.py' if CAREEM else 'metadata_only.py'))],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        time.sleep(.6)
        if proxy.poll() is not None: raise RuntimeError('Proxy failed to start')
        if held(): raise SystemExit('Priority phone hold')
        phone('reverse', f'tcp:{PORT}', f'tcp:{PORT}')
        phone('shell', 'run-as', PACKAGE, 'mkdir', '-p', 'files')
        phone('shell', 'run-as', PACKAGE, 'touch', MARKER)
        print(json.dumps({'event': 'ready', 'seconds': seconds, 'scope': 'clone_only'}), flush=True)
        lines = queue.Queue()
        def read_lines():
            for line in proxy.stdout: lines.put(line)
        threading.Thread(target=read_lines, daemon=True).start()
        end = time.monotonic()+seconds
        while time.monotonic() < end and proxy.poll() is None and not held():
            try:
                obj = json.loads(lines.get(timeout=.3))
                if obj.get('event') in ['request','response','tls_failed','keychain_saved','keychain_error','write_blocked']:
                    print(json.dumps(obj), flush=True)
            except (queue.Empty, ValueError): pass
    finally:
        # The shared-phone hold forbids even cleanup commands. Keep cleanup pending
        # off-device and resume only when the priority task has released the phone.
        while held():
            print(json.dumps({'event':'cleanup_deferred','reason':'priority_hold'}),flush=True)
            time.sleep(60)
        for args in [('shell','run-as',PACKAGE,'rm','-f',MARKER),
                     ('reverse','--remove',f'tcp:{PORT}')]:
            while held(): time.sleep(60)
            try: phone(*args)
            except Exception: pass
        if proxy is not None:
            proxy.terminate()
            try: proxy.wait(timeout=5)
            except subprocess.TimeoutExpired: proxy.kill(); proxy.wait()
        print(json.dumps({'event':'restored','scope':'clone_only','global_proxy_changed':False}),flush=True)


if __name__ == '__main__': main()
