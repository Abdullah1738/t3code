"""Run app-api-cli fixture tests without credentials, network, or live log writes."""
import os
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ['COMMERCE_CARD_LAST4'] = '2342'

base = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(base), str(base / 'test')]
keychain = types.ModuleType('keychain')
def unavailable(*args, **kwargs):
    raise AssertionError('Fixture tests must not access credentials or network')
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
def guarded_connect(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        unavailable()
    return _connect(sock, address)
def guarded_connect_ex(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6):
        unavailable()
    return _connect_ex(sock, address)

# These exact child programs only exercise output limits and process cleanup.
_FIXTURE_CHILD = 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(60)'
_FIXTURE_PROGRAMS = {
    'print("ok")', 'print("x"*10000)', 'import time; time.sleep(60)',
    'import sys; print("private",file=sys.stderr); sys.exit(2)',
    'import os; print(os.environ.get("NODE_OPTIONS", "clean")); print(os.environ.get("PRIVATE_FIXTURE", "clean"))',
    'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); time.sleep(60)',
    'import os,subprocess,sys; ' + f'p=subprocess.Popen([sys.executable,"-c",{_FIXTURE_CHILD!r}],stdout=subprocess.PIPE); ' +
        'p.stdout.readline(); print(p.pid,flush=True); os._exit(0)',
}
_popen = subprocess.Popen

def guarded_popen(command, *args, **kwargs):
    state = os.environ.get('CARD_STATUS_FILE')
    if (not kwargs.get('shell') and command == [sys.executable, str(base / 'card_status.py'),
            'merchant', 'set', 'boat.dev', '7572'] and state
            and Path(state).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())):
        return _popen(command, *args, **kwargs)
    if (not kwargs.get('shell') and isinstance(command, (list, tuple)) and len(command) == 3
            and command[0] == sys.executable and command[1] == '-c'
            and command[2] in _FIXTURE_PROGRAMS):
        return _popen(command, *args, **kwargs)
    unavailable()

keychain.load = keychain.store = unavailable
sys.modules['keychain'] = keychain
package = types.ModuleType('test')
package.__path__ = [str(base / 'test')]
sys.modules['test'] = package
import toollog

if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as temp, \
            patch.object(toollog, 'root', return_value=Path(temp) / 'logs'), \
            patch.object(socket.socket, 'connect', guarded_connect), \
            patch.object(socket.socket, 'connect_ex', guarded_connect_ex), \
            patch.object(subprocess, 'Popen', guarded_popen):
        suite = (unittest.defaultTestLoader.loadTestsFromNames(sys.argv[1:]) if len(sys.argv) > 1 else
                 unittest.defaultTestLoader.loadTestsFromNames([
                 'test_toollog', 'test_toollog_lanes', 'test_commerce_minutes',
                 'test_commerce_nownow_order', 'test_commerce_main_order',
                 'test_commerce_supermall_order', 'test_commerce_food',
                 'test_noon_food_financial', 'test_commerce_journal', 'test_commerce_flow',
                 'test_commerce_preorder', 'test_commerce_preorder_journal',
                 'test_commerce_preorder_redirect', 'test_commerce_preorder_release',
                 'test_commerce_marketplace', 'test_marketplace_payment', 'test_order_tracker',
                 'test_order_watch_notice.AddNoticeTests', 'test_card_merchants',
                 'test_card_status.CardStatusModuleTests', 'test_careem_http_orders',
                 'test_amazon_email_orders', 'test_amazon_dia_cli', 'test_noon_vertical_reads',
                 'test_noon_http_orders', 'test_noon_order_details', 'test_noon_auth_lifecycle',
             ]))
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        raise SystemExit(not result.wasSuccessful())
