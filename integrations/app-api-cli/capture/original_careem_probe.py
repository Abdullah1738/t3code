"""One bounded TLS observation of the original app; no APK/data/CA changes."""
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
from phone_guard import check, held, SERIAL
from probe_window import BASE, CONF


def phone(*args):
    check()
    return subprocess.run(['adb', '-s', SERIAL, *args], capture_output=True,
                          text=True, timeout=15)


def main():
    check()
    previous = phone('shell', 'settings', 'get', 'global', 'http_proxy').stdout.strip()
    if previous not in (':0', 'null', ''):
        raise SystemExit('Existing proxy; not changing it')
    proxy = None
    try:
        proxy = subprocess.Popen([
            str(Path.home()/'.local/bin/mitmdump'), '-q', '-p', '18092',
            '--listen-host', '127.0.0.1', '--set', f'confdir={CONF}',
            '--set', 'connection_strategy=lazy', '--set', 'termlog_verbosity=error',
            '--set', 'flow_detail=0', '--set',
            r'allow_hosts=^(.+\.)?(careem\.com|careemapis\.com|careemdash\.com|careem-engineering\.com)(:\d+)?$',
            '-s', str(BASE/'careem_metadata.py')], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True)
        time.sleep(.7)
        if proxy.poll() is not None:
            raise RuntimeError('Proxy failed to start')
        phone('reverse', 'tcp:18092', 'tcp:18092').check_returncode()
        phone('shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:18092').check_returncode()
        phone('shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c',
              'android.intent.category.LAUNCHER', '-n',
              'com.careem.acma/com.careem.superapp.OnboardingActivityDefaultIcon').check_returncode()
        lines = queue.Queue()
        def drain():
            for line in proxy.stdout:
                lines.put(line)
        threading.Thread(target=drain, daemon=True).start()
        end = time.monotonic()+20
        events = 0
        while time.monotonic() < end and not held():
            try:
                obj = json.loads(lines.get(timeout=.3))
                if obj.get('event') in ('request', 'response', 'tls_failed', 'keychain_saved'):
                    print(json.dumps(obj), flush=True)
                    events += 1
            except (queue.Empty, ValueError):
                pass
        print(json.dumps({'observed_events': events}))
    finally:
        while held():
            time.sleep(60)
        phone('shell', 'settings', 'put', 'global', 'http_proxy', ':0')
        phone('reverse', '--remove', 'tcp:18092')
        if proxy is not None:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()
        print(json.dumps({'http_proxy': phone('shell', 'settings', 'get', 'global', 'http_proxy').stdout.strip(),
                          'reverse_removed': '18092' not in phone('reverse', '--list').stdout}))


if __name__ == '__main__':
    main()
