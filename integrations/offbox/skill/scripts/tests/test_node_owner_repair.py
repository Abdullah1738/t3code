"""Exercise the ownership repair with real GNU find/chown in a private Linux tree."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from offbox_lib import runs


class NodeOwnerScriptTests(unittest.TestCase):
    def test_repair_is_in_remote_preamble_before_docker_hook(self):
        script = runs.remote_script('w', '.', ['node --version'], None, 'test')
        self.assertIn(runs.NODE_OWNER_REPAIR, script)
        self.assertLess(script.index(runs.NODE_OWNER_REPAIR), script.index(runs.DOCKER_REPAIR))
        result = subprocess.run(['bash', '-n'], input=script, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipUnless(sys.platform == 'linux', 'requires GNU ownership tools on a Linux box')
class NodeOwnerRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.addCleanup(self.restore_owner)
        self.local = self.root / 'usr/local'
        for name in ('bin', 'lib/node_modules/npm', 'include/node', 'share/doc/node', 'share/man/man1'):
            (self.local / name).mkdir(parents=True, exist_ok=True)
        for name in ('bin/node', 'lib/node_modules/npm/cli.js', 'include/node/node.h',
                     'share/doc/node/README', 'share/man/man1/node.1', 'LICENSE', 'README.md', 'CHANGELOG.md'):
            (self.local / name).touch()
        (self.local / 'bin/npm').symlink_to('../lib/node_modules/npm/cli.js')
        self.env = clean_env(PATH='/usr/bin:/bin', HOME=str(self.root))
        self.script = runs.NODE_OWNER_REPAIR.replace('/usr/local', str(self.local))
        self.chown(1001, self.local, recursive=True)

    def chown(self, uid, path, recursive=False):
        subprocess.run(['sudo', '-n', 'chown', '--no-dereference', *(['-R'] if recursive else []),
                        str(uid), str(path)], check=True, capture_output=True)

    def restore_owner(self):
        self.chown(os.getuid(), self.root, recursive=True)

    def run_repair(self):
        return subprocess.run(['bash', '-eu', '-c', self.script + '\necho USER_COMMAND'],
                              env=self.env, text=True, capture_output=True, timeout=10)

    def test_repairs_once_and_preserves_user_files_and_unrelated_paths(self):
        user_file = self.local / 'lib/node_modules/npm/user-file'
        self.chown(os.getuid(), user_file.parent)
        user_file.touch()
        self.chown(1001, user_file.parent)
        unrelated = self.local / 'bin/other-tool'
        self.chown(os.getuid(), unrelated.parent)
        unrelated.touch()
        self.chown(1001, unrelated)
        self.chown(1001, unrelated.parent)
        outside = self.root / 'outside'
        outside.touch()
        self.chown(1001, outside)
        link = self.local / 'lib/node_modules/npm/outside-link'
        self.chown(os.getuid(), link.parent)
        link.symlink_to(outside)
        self.chown(1001, link)
        self.chown(1001, link.parent)

        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, f'offbox: repaired {self.local} ownership (Node archive uid 1001 -> root)\n')
        self.assertEqual(user_file.stat().st_uid, os.getuid())
        self.assertEqual(unrelated.stat().st_uid, 1001)
        self.assertEqual(outside.stat().st_uid, 1001)
        self.assertEqual(self.local.stat().st_uid, 1001, '/usr/local itself is outside the repair allowlist')
        for name in ('bin', 'lib', 'include', 'share', 'bin/node', 'bin/npm', 'lib/node_modules',
                     'lib/node_modules/npm/cli.js', 'include/node/node.h', 'share/doc/node/README',
                     'share/man/man1/node.1', 'LICENSE', 'README.md', 'CHANGELOG.md'):
            with self.subTest(path=name):
                self.assertEqual((self.local / name).lstat().st_uid, 0)
        self.assertEqual(link.lstat().st_uid, 0)
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')

    def test_root_owned_bin_costs_one_stat_and_no_sudo(self):
        self.chown(0, self.local / 'bin')
        bins = self.root / 'shims'
        bins.mkdir()
        calls = self.root / 'stat-calls'
        stat = bins / 'stat'
        stat.write_text(f'#!/bin/bash\necho called >> "{calls}"\nexec /usr/bin/stat "$@"\n')
        stat.chmod(0o755)
        sudo = bins / 'sudo'
        sudo.write_text('#!/bin/bash\necho UNEXPECTED_SUDO >&2\nexit 1\n')
        sudo.chmod(0o755)
        self.env['PATH'] = f'{bins}:/usr/bin:/bin'
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual(calls.read_text(), 'called\n')
        self.assertEqual((self.local / 'bin/node').stat().st_uid, 1001)

    def test_missing_node_is_silent(self):
        self.chown(os.getuid(), self.local / 'bin')
        (self.local / 'bin/node').unlink()
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual((self.local / 'lib/node_modules').stat().st_uid, 1001)

    def test_non_archive_owner_is_untouched(self):
        self.chown(os.getuid(), self.local, recursive=True)
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual((self.local / 'bin/node').stat().st_uid, os.getuid())

    def test_sudo_failure_is_silent_and_never_blocks_command(self):
        bins = self.root / 'shims'
        bins.mkdir()
        sudo = bins / 'sudo'
        sudo.write_text('#!/bin/bash\nexit 1\n')
        sudo.chmod(0o755)
        self.env['PATH'] = f'{bins}:/usr/bin:/bin'
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'USER_COMMAND\n')
        self.assertEqual(result.stderr, '')

    def test_partial_failure_leaves_bin_nonroot_and_retries(self):
        bins = self.root / 'shims'
        bins.mkdir()
        calls = self.root / 'sudo-calls'
        sudo = bins / 'sudo'
        sudo.write_text(f'''#!/bin/bash
echo called >> "{calls}"
[ "$(wc -l < "{calls}")" -ne 2 ] || exit 1
exec /usr/bin/sudo "$@"
''')
        sudo.chmod(0o755)
        self.env['PATH'] = f'{bins}:/usr/bin:/bin'
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        self.assertEqual((self.local / 'bin/node').stat().st_uid, 0)
        self.assertEqual((self.local / 'bin').stat().st_uid, 1001)
        self.env['PATH'] = '/usr/bin:/bin'
        result = self.run_repair()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('repaired ', result.stderr)
        self.assertEqual((self.local / 'bin').stat().st_uid, 0)

    def test_symlinked_ancestors_are_rejected_before_any_chown(self):
        for relative in ('', 'bin', 'lib', 'include', 'share', 'share/doc', 'share/man', 'share/man/man1'):
            with self.subTest(ancestor=relative):
                ancestor = self.local / relative
                outside = self.root / 'outside-tree'
                subprocess.run(['sudo', '-n', 'mv', '-T', str(ancestor), str(outside)], check=True)
                subprocess.run(['sudo', '-n', 'ln', '-s', str(outside), str(ancestor)], check=True)
                self.chown(1001, ancestor)
                try:
                    result = self.run_repair()
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, '')
                    self.assertEqual((self.local / 'bin/node').stat().st_uid, 1001)
                    for path in outside.rglob('*'):
                        self.assertEqual(path.lstat().st_uid, 1001, str(path))
                finally:
                    subprocess.run(['sudo', '-n', 'rm', '--', str(ancestor)], check=True)
                    subprocess.run(['sudo', '-n', 'mv', '-T', str(outside), str(ancestor)], check=True)


if __name__ == '__main__':
    unittest.main()
