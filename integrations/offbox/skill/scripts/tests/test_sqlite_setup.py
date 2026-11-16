"""Provision real shell fixtures through the same SQLite script used by templates and restored bases."""
import hashlib
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, bases, runs
from tests._env import clean_env

TEMPLATES = Path(__file__).resolve().parents[2] / 'templates'
SOURCE = (TEMPLATES / 'tools/sqlite.sh').read_text()
FETCH = (TEMPLATES / 'tools/fetch.sh').read_text() + '\n'
CHECKSUM = '555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f'
CLI = '#!/bin/bash\necho "$*" >> "$FIX/probes"\nexit 0\n'


class Fixture:
    def __init__(self, root, state='missing', failure=''):
        self.root = Path(root)
        self.cli = self.root / 'usr/bin/sqlite3'
        self.cli.parent.mkdir(parents=True)
        self.legacy = self.root / 'opt/homebrew/opt/sqlite/bin/sqlite3'
        self.legacy.parent.mkdir(parents=True)
        self.bins = self.root / 'bin'
        self.bins.mkdir()
        if state != 'missing':
            self.cli.write_text(CLI if state == 'healthy' else '#!/bin/bash\nexit 1\n')
            self.cli.chmod(0o755)
        self.tool('sudo', '[ "$1" = -n ] && shift\nexec "$@"')
        self.tool('uname', 'echo x86_64')
        self.tool('apt-get', 'echo "apt $*" >> "$FIX/calls"\n[ "$FAIL" != apt ]')
        self.tool('curl', 'echo curl >> "$FIX/calls"\n[ "$FAIL" != curl ] || exit 22\n'
                  'cp "$FIX/tools.zip" "${@: -1}"')
        self.tool('dpkg-divert', 'echo divert >> "$FIX/calls"\n'
                  '[ ! -e "$FIX/usr/bin/sqlite3" ] || mv "$FIX/usr/bin/sqlite3" "$FIX/usr/bin/sqlite3.distrib"')
        archive = self.root / 'tools.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('sqlite3', CLI)
        checksum = hashlib.sha3_256(archive.read_bytes()).hexdigest()
        source = SOURCE.replace(CHECKSUM, checksum if failure != 'checksum' else '0' * 64)
        for path in ('/usr/bin/sqlite3', '/usr/local/lib/offbox', '/opt/homebrew/opt/sqlite/bin/sqlite3'):
            source = source.replace(path, str(self.root) + path)
        self.script = FETCH + source
        self.env = clean_env(FIX=str(self.root), FAIL=failure, HOME=str(self.root),
                             OFFBOX_BOX_ID='saved-base-box', PATH=f'{self.bins}:/usr/bin:/bin')

    def tool(self, name, text):
        p = self.bins / name
        p.write_text('#!/bin/bash\n' + text + '\n')
        p.chmod(0o755)

    def run(self, script=None):
        return subprocess.run(['bash', '-c', script or self.script], env=self.env,
                              capture_output=True, text=True, timeout=30)

    def calls(self):
        p = self.root / 'calls'
        return p.read_text() if p.exists() else ''


class SqliteSetupTests(unittest.TestCase):
    def test_missing_or_incompatible_cli_is_installed_once_and_then_quiet(self):
        for state in ('missing', 'old'):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as root:
                fx = Fixture(root, state)
                result = fx.run()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('apt install -y -qq --no-install-recommends sqlite3', fx.calls())
                self.assertIn('curl\ndivert', fx.calls())
                action = 'installed missing' if state == 'missing' else 'upgraded'
                self.assertEqual(result.stderr, f'offbox: {action} sqlite3 on saved-base-box\n')
                self.assertTrue(fx.cli.is_symlink())
                calls = fx.calls()
                result = fx.run()
                self.assertEqual((result.returncode, result.stderr, fx.calls()), (0, '', calls))
                probes = (Path(root) / 'probes').read_text()
                self.assertIn('-safe -noinit -json -readonly -- :memory: select 1', probes)
                self.assertIn('-safe -noinit -- :memory: select 1', probes)

    def test_healthy_box_never_touches_apt_or_downloads(self):
        with tempfile.TemporaryDirectory() as root:
            fx = Fixture(root, 'healthy')
            result = fx.run()
            self.assertEqual((result.returncode, result.stderr, fx.calls()), (0, '', ''))

    def test_home_image_asset_loads_sibling_fetch_helper(self):
        with tempfile.TemporaryDirectory() as root:
            fx = Fixture(root)
            asset = Path(root) / 'offbox-sqlite.sh'
            asset.write_text(fx.script.removeprefix(FETCH))
            (Path(root) / 'fetch.sh').write_text(FETCH)
            result = fx.run('bash ' + shlex.quote(str(asset)))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(fx.cli.is_symlink())

    def test_install_and_checksum_failures_stop_before_diversion(self):
        for failure in ('apt', 'curl', 'checksum'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                fx = Fixture(root, 'old', failure)
                result = fx.run()
                self.assertNotEqual(result.returncode, 0)
                if failure == 'curl':
                    self.assertEqual(result.returncode, 98)
                    self.assertIn('offbox: download failed (curl exit 22)', result.stderr)
                self.assertNotIn('divert', fx.calls())
                self.assertFalse(fx.cli.is_symlink())

    def test_only_known_legacy_link_is_removed(self):
        for kind in ('legacy', 'custom', 'regular', 'missing'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                fx = Fixture(root, 'healthy')
                if kind in ('legacy', 'custom'):
                    fx.legacy.symlink_to(fx.cli if kind == 'legacy' else '/custom/sqlite3')
                elif kind == 'regular':
                    fx.legacy.write_text('custom')
                result = fx.run()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(os.path.lexists(fx.legacy), kind in ('custom', 'regular'))

    def test_saved_base_setup_failure_prevents_user_command_on_both_backends(self):
        for backend in ('server', 'boat'):
            for failure in ('', 'apt'):
                with self.subTest(backend=backend, failure=failure), tempfile.TemporaryDirectory() as root:
                    fx = Fixture(root, failure=failure)
                    (Path(root) / 'repo').mkdir()
                    setup = 'bash -c ' + shlex.quote(fx.script) + ' || exit 97'
                    with patch.object(api, 'BACKEND', backend), patch.multiple(
                        runs, SQLITE_SETUP=setup, DOCKER_REPAIR=':', LDCACHE_REPAIR=':',
                        CACHE_OWNER_REPAIR=':', WATCH_REPAIR=':', GO_REPAIR=':',
                    ), patch.object(runs.userns, 'setup', return_value=':'), \
                            patch.object(runs.containers, 'script', return_value=':'), \
                            patch.object(runs.resources, 'wrap', side_effect=lambda cmd, _: cmd), \
                            patch.object(runs.node_tools, 'block', return_value=':'), \
                            patch.object(runs.java_version, 'block', return_value=':'):
                        script = runs.remote_script('repo', '.', ['echo USER_COMMAND'], None, 'r-sqlite',
                                                    template='base:repo:old', repo_root=Path(root))
                    # This suite isolates provisioning from the disk probe's independent host metrics.
                    script = script.replace('__obprobe() {', '__obprobe_real() {')
                    script = '__obprobe() { return 0; }\n' + script
                    result = fx.run(script)
                    self.assertEqual(result.returncode, 97 if failure else 0, result.stderr)
                    self.assertEqual('USER_COMMAND' in result.stdout, not failure)
                    self.assertEqual(fx.cli.exists(), not failure)

    def test_every_template_fails_when_required_sqlite_install_fails(self):
        for name in ('generic', 'crpko-node', 'crpko-go', 'crpko-harness'):
            with self.subTest(template=name), tempfile.TemporaryDirectory() as root:
                fx = Fixture(root, failure='apt')
                with patch.object(bases, 'TEMPLATES_DIR', TEMPLATES):
                    recipe, _ = bases.recipe(name)
                self.assertIn(shlex.quote(FETCH + SOURCE), recipe)
                recipe = recipe.replace(shlex.quote(FETCH + SOURCE), shlex.quote(fx.script), 1)
                result = fx.run(recipe)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('curl', fx.calls())


if __name__ == '__main__':
    unittest.main()
