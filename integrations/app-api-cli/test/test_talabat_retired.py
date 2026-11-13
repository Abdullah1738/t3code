"""Talabat retired by the owner 2026-11-07: every Talabat entry point refuses."""
import os as _os, tempfile as _tempfile
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import io
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import basket
import commerce_cli as cli
import optimizer
import talabat_auth
import talabat_retired

ROOT = Path(__file__).resolve().parent.parent


class CommerceRefusalTests(unittest.TestCase):
    def run_cli(self, argv):
        boom = AssertionError('must not run')
        with patch.object(cli, 'purchase_talabat', side_effect=boom), \
             patch.object(cli, 'talabat_discovery', side_effect=boom), \
             patch.object(cli, 'card_preflight', side_effect=boom), \
             patch.object(cli, 'track_exact', side_effect=boom), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            code = cli.main(argv)
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def test_every_talabat_command_refuses_before_any_work(self):
        for argv in (['order', 'talabat', '--branch', '1', '--item', '1'],
                     ['test-talabat-shops', '--branch', '1', '--item', '1'],
                     ['menu', 'talabat', '--branch', '1'],
                     ['choices', 'talabat', '--branch', '1', '--item', '1'],
                     ['auth', 'talabat', 'mart'],
                     ['track-exact', 'talabat', 'mart', '1']):
            with self.subTest(argv=argv):
                try:
                    code, row = self.run_cli(argv)
                except SystemExit as e:  # argparse shape differs; refusal must still not run work
                    self.fail(f'argparse rejected {argv}: {e}')
                self.assertEqual(code, talabat_retired.EXIT)
                self.assertEqual(row['error'], 'TALABAT_RETIRED')
                self.assertFalse(row['financial_send'])
                self.assertIn('2026-11-07', row['message'])

    def test_requested_ignores_other_apps(self):
        from argparse import Namespace
        self.assertFalse(talabat_retired.requested(Namespace(command='order', order_command='minutes')))
        self.assertFalse(talabat_retired.requested(Namespace(command='auth', app='noon')))


class SearchRefusalTests(unittest.TestCase):
    def test_basket_refuses_talabat(self):
        with self.assertRaisesRegex(ValueError, 'TALABAT_RETIRED'):
            basket.run('talabat', 'mart', ['milk', 'eggs'])

    def test_optimizer_never_searches_talabat(self):
        self.assertNotIn('talabat', {app for app, _ in optimizer.SOURCES})

    def test_talabat_auth_cli_refuses(self):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(talabat_auth.main(['status']), talabat_retired.EXIT)
        self.assertEqual(json.loads(out.getvalue())['error'], 'TALABAT_RETIRED')

    @unittest.skipUnless(shutil.which('node'), 'node not on PATH')
    def test_search_cli_refuses_talabat_modes(self):
        for argv in (['talabat', 'sushi', '--json'], ['talabat', 'orders', '--json'],
                     ['menu', '717327', '--json'], ['groceries', 'milk', '--json']):
            with self.subTest(argv=argv):
                p = subprocess.run([shutil.which('node'), str(ROOT / 'search.mjs'), *argv],
                                   capture_output=True, text=True, timeout=30)
                self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
                self.assertEqual(json.loads(p.stdout)['error']['code'], 'TALABAT_RETIRED')


if __name__ == '__main__':
    unittest.main()
