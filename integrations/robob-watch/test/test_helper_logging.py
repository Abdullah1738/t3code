"""Exercise real shell and Python helper boundaries without external services."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1] / 'helpers'
spec = importlib.util.spec_from_file_location('helper_log_fixture', HELPERS / 'toollog.py')
log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(log)


class HelperLoggingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, ROBOB_TEST='1', WATCH_ID='fixture', TOOLLOG_DIR=str(self.root / 'logs'))

    def rows(self):
        return [json.loads(line) for p in (self.root / 'logs').glob('*.ndjson') for line in p.read_text().splitlines()]

    def test_real_shell_helper_success_and_failure_preserve_stdout_and_exit(self):
        good = subprocess.run(['/bin/zsh', str(HELPERS / 'time-reached'), '2000-01-01T00:00:00+00:00', 'PRIVATE_TEXT'], env=self.env, capture_output=True, text=True)
        bad = subprocess.run(['/bin/zsh', str(HELPERS / 'time-reached'), 'PRIVATE_INVALID_DATE'], env=self.env, capture_output=True, text=True)
        self.assertEqual((good.returncode, good.stdout), (0, 'PRIVATE_TEXT\n'))
        self.assertNotEqual(bad.returncode, 0)
        rows = self.rows()
        self.assertEqual([row['name'] for row in rows], ['helper.run', 'helper.run'])
        self.assertEqual([row['ok'] for row in rows], [True, False])
        self.assertEqual([row['props']['exitCode'] for row in rows], [0, bad.returncode])
        self.assertTrue(all(row['ids']['helper'] == 'time-reached' for row in rows))
        self.assertNotIn('PRIVATE', json.dumps(rows))

    def test_main_wrapper_preserves_return_values_and_exceptions(self):
        def failure():
            raise SystemExit('PRIVATE_FAILURE')
        with patch.dict(os.environ, self.env):
            self.assertEqual(log.helper_main('fixture', lambda: 7), 7)
            with self.assertRaisesRegex(SystemExit, 'PRIVATE_FAILURE'):
                log.helper_main('fixture', failure)
        self.assertEqual([row['props']['exitCode'] for row in self.rows()], [7, 1])
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))

    def test_python_helper_main_emits_success_and_failure_without_payload(self):
        for args in (['health'], ['unknown-private-command']):
            subprocess.run([sys.executable, str(HELPERS / 'wa-db'), *args], env=dict(self.env, WACLI_STORE_DIR=str(self.root / 'store')), capture_output=True)
        rows = self.rows()
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['ids']['helper'] == 'wa-db' for row in rows))
        self.assertNotIn('private', json.dumps(rows))

    def test_shell_retention_cap_privacy_and_failed_sink(self):
        directory = self.root / 'logs'
        directory.mkdir()
        old = directory / '2000-01-01.ndjson'
        old.write_text('old')
        program = 'source "$1" fixture; exit "$2"'
        def run(code, **env):
            return subprocess.run(['/bin/zsh', '-f', '-c', program, 'fixture', str(HELPERS / 'toollog.zsh'), str(code)],
                                  env=dict(self.env, WATCH_ID='PRIVATE 123456', **env), capture_output=True)
        self.assertEqual(run(0).returncode, 0)
        self.assertFalse(old.exists())
        self.assertNotIn('PRIVATE', json.dumps(self.rows()))
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        path = directory / (day + '.ndjson')
        cap = 50 * 1024 * 1024 + 1
        with path.open('r+b') as target:
            target.truncate(cap)
        for code in (0, 0, 7):
            self.assertEqual(run(code).returncode, code)
        with path.open('rb') as source:
            source.seek(cap)
            tail = source.read().decode()
        self.assertEqual(tail.count('"name":"log.cap"'), 1)
        self.assertEqual(tail.count('"name":"helper.run"'), 1)
        self.assertIn('"exitCode":7', tail)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(run(7, TOOLLOG_DIR='/dev/null/blocked').returncode, 7)

    def test_cli_drops_invalid_arguments_and_io_failures(self):
        for args in ([], ['--bad', 'PRIVATE_VALUE'], ['--helper', 'fixture', '--duration-ms', '2', '--exit-code', '7']):
            result = subprocess.run([sys.executable, str(HELPERS / 'toollog.py'), *args], env=dict(self.env, TOOLLOG_DIR='/dev/null/blocked'), capture_output=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))


if __name__ == '__main__':
    unittest.main()
