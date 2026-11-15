"""Shared sandbox, including Python subprocesses launched by the shell tests."""
import atexit
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


TESTS = Path(__file__).resolve().parent
LIVE_LOGS = (Path('/Users/ardud/.local/share/dev-janitor'),
             Path(os.environ.get('DEV_JANITOR_TEST_REAL_HOME', str(Path.home()))) / '.local/share/dev-janitor')
REAL_TELEGRAM = '/Users/ardud/.local/share/telegram-bridge/src/cli.ts'


def inside(path, root):
    return path == root or root in path.parents


def assert_safe_environment(env):
    for key in ('HOME', 'DEV_JANITOR_LOG_DIR', 'DEV_JANITOR_WATCH_STATE', 'DEV_JANITOR_TELEGRAM_CMD'):
        value = env.get(key)
        if not value or not inside(Path(value).resolve(), Path(tempfile.gettempdir()).resolve()):
            raise AssertionError(f'{key} must point into the test sandbox')
    log_dir = Path(env['DEV_JANITOR_LOG_DIR']).resolve()
    if any(inside(log_dir, root.resolve()) for root in LIVE_LOGS):
        raise AssertionError('tests cannot use the live janitor audit directory')


if 'DEV_JANITOR_TEST_SANDBOX' not in os.environ:
    sandbox = tempfile.TemporaryDirectory(prefix='janitor-tests-')
    atexit.register(sandbox.cleanup)
    root = Path(sandbox.name)
    (root / 'home').mkdir()
    fake = root / 'fake-telegram'
    fake.write_text(f'#!{sys.executable}\n' + """
import json, os, sys
with open(os.environ['DEV_JANITOR_TEST_SENDS'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
""")
    fake.chmod(0o755)
    # sitecustomize applies the same guards in fresh Python interpreters, where mocks do not survive.
    bootstrap = root / 'bootstrap'
    bootstrap.mkdir()
    (bootstrap / 'sitecustomize.py').write_text(
        f'import sys\nsys.path.insert(0, {str(TESTS)!r})\nimport janitor_test_safety\n')
    os.environ.update({
        'DEV_JANITOR_TEST_REAL_HOME': str(Path.home()),
        'DEV_JANITOR_TEST_SANDBOX': str(root),
        'HOME': str(root / 'home'),
        'DEV_JANITOR_LOG_DIR': str(root / 'logs'),
        'DEV_JANITOR_WATCH_STATE': str(root / 'logs/hourly'),
        'DEV_JANITOR_TELEGRAM_CMD': str(fake),
        'DEV_JANITOR_TEST_SENDS': str(root / 'telegram.jsonl'),
        'PYTHONPATH': str(bootstrap) + os.pathsep + os.environ.get('PYTHONPATH', ''),
        'PYTHONDONTWRITEBYTECODE': '1',
    })

assert_safe_environment(os.environ)


def guard(event, args):
    if event == 'subprocess.Popen':
        executable, argv, cwd, env = args
        assert_safe_environment(os.environ if env is None else env)
        if any(REAL_TELEGRAM in str(arg) for arg in argv):
            raise AssertionError('tests cannot execute the real Telegram CLI')
    elif event == 'open' and not isinstance(args[0], int):
        path = Path(os.fsdecode(args[0])).resolve()
        if any(inside(path, root.resolve()) for root in LIVE_LOGS):
            raise AssertionError('tests cannot open the live janitor audit directory')


sys.addaudithook(guard)


class JanitorTestCase(unittest.TestCase):
    def _callSetUp(self):
        assert_safe_environment(os.environ)
        super()._callSetUp()
        assert_safe_environment(os.environ)
