import ast
import json
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

from janitor_test_safety import JanitorTestCase, REAL_TELEGRAM, assert_safe_environment


class TestSandboxTests(JanitorTestCase):
    def test_every_test_module_uses_shared_sandbox(self):
        for path in Path(__file__).parent.glob('test_*.py'):
            self.assertIn('from janitor_test_safety import JanitorTestCase', path.read_text(), str(path))
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ClassDef):
                    self.assertFalse(any(isinstance(base, ast.Attribute) and base.attr == 'TestCase'
                                         for base in node.bases), str(path))
        assert_safe_environment(os.environ)

    def test_missing_overrides_and_live_paths_are_rejected(self):
        for key in ('HOME', 'DEV_JANITOR_LOG_DIR', 'DEV_JANITOR_WATCH_STATE', 'DEV_JANITOR_TELEGRAM_CMD'):
            with self.subTest(key=key):
                env = dict(os.environ)
                env.pop(key)
                with self.assertRaises(AssertionError):
                    assert_safe_environment(env)
        for key, value in [('DEV_JANITOR_LOG_DIR', '/Users/ardud/.local/share/dev-janitor'),
                           ('DEV_JANITOR_TELEGRAM_CMD', REAL_TELEGRAM)]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                assert_safe_environment({**os.environ, key: value})

    def test_guard_blocks_real_audit_and_telegram_before_access(self):
        with self.assertRaisesRegex(AssertionError, 'live janitor'):
            open('/Users/ardud/.local/share/dev-janitor/audit.jsonl', 'a')
        with self.assertRaisesRegex(AssertionError, 'real Telegram'):
            subprocess.run([sys.executable, REAL_TELEGRAM, 'notify'], check=True)
        with patch.dict(os.environ) as env:
            env.pop('DEV_JANITOR_TELEGRAM_CMD')
            with self.assertRaisesRegex(AssertionError, 'DEV_JANITOR_TELEGRAM_CMD'):
                subprocess.run([sys.executable, '-c', 'pass'], check=True)

    def test_child_interpreters_also_block_real_telegram(self):
        proc = subprocess.run([sys.executable, '-c',
                               'import os, subprocess; subprocess.run(["bun", os.environ["FORBIDDEN_CLI"]])'],
                              env={**os.environ, 'FORBIDDEN_CLI': REAL_TELEGRAM},
                              capture_output=True, text=True, timeout=5)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('tests cannot execute the real Telegram CLI', proc.stderr)

    def test_alert_subcommand_inherits_fake_and_audit_directory(self):
        scripts = Path(__file__).resolve().parents[1] / 'skill/scripts'
        proc = subprocess.run([sys.executable, str(scripts / 'janitor_watch.py'),
                               'alert', 'sandbox_guard', 'fake guard failure'],
                              capture_output=True, text=True, timeout=5)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, '', ''))
        audit = Path(os.environ['DEV_JANITOR_LOG_DIR']) / 'audit.jsonl'
        self.assertEqual(json.loads(audit.read_text().splitlines()[-1])['kind'], 'sandbox_guard')
        sends = Path(os.environ['DEV_JANITOR_TEST_SENDS'])
        self.assertIn('fake guard failure', sends.read_text())
