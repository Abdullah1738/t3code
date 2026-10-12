import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('install_cli', Path(__file__).parents[1] / 'install-cli.py')
install = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install)


class InstallCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / '.local/share/app-api-cli'
        self.root.mkdir(parents=True)
        python = self.home / '.local/share/uv/tools/mitmproxy/bin/python'
        python.parent.mkdir(parents=True)
        python.touch()
        for module in (*install.COMMANDS.values(), *install.HELPERS):
            (self.root / module).touch()
        self.target = self.home / '.local/bin'
        self.target.mkdir(parents=True)

    def run_install(self):
        with patch.object(install, 'HOME', self.home), patch('builtins.print'):
            install.main()

    def test_managed_install_is_repeatable_and_forwards_arguments(self):
        self.run_install()
        first = {p.name: p.read_text() for p in self.target.iterdir()}
        self.run_install()
        self.assertEqual(first, {p.name: p.read_text() for p in self.target.iterdir()})
        for name, module in install.COMMANDS.items():
            text = (self.target / name).read_text()
            self.assertIn(install.MARKER, text)
            self.assertIn(f'/app-api-cli/{module}" "$@"', text)
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o755)

    def test_unmanaged_or_symlink_collision_preserves_every_launcher(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                path = self.target / 'amazon-orders'
                if symlink:
                    path.symlink_to(self.root / 'amazon_email_orders.py')
                else:
                    path.write_text('original unmanaged command\n')
                with self.assertRaisesRegex(SystemExit, 'unmanaged'):
                    self.run_install()
                self.assertFalse((self.target / 'talabat-auth').exists())
                self.assertEqual(path.is_symlink(), symlink)
                if not symlink:
                    self.assertEqual(path.read_text(), 'original unmanaged command\n')
                path.unlink()

    def test_missing_deployed_module_writes_nothing(self):
        (self.root / 'amazon_email_orders.py').unlink()
        with self.assertRaisesRegex(SystemExit, 'Deploy'):
            self.run_install()
        self.assertEqual(list(self.target.iterdir()), [])

    def test_browser_launcher_does_not_replace_email_launcher(self):
        self.run_install()
        self.assertIn('amazon_email_orders.py', (self.target / 'amazon-orders').read_text())
        self.assertIn('amazon_dia_cli.py', (self.target / 'amazon-browser-orders').read_text())

    def test_missing_browser_helper_writes_nothing(self):
        for module in install.HELPERS:
            with self.subTest(module=module):
                path = self.root / module
                path.unlink()
                with self.assertRaisesRegex(SystemExit, 'Deploy'):
                    self.run_install()
                self.assertEqual(list(self.target.iterdir()), [])
                path.touch()


if __name__ == '__main__':
    unittest.main()
