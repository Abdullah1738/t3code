"""Execute the real repair with fake ownership and sudo, without changing host ownership."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs


FAKE_TOOL = '''#!__PYTHON__
import json, os, sys
from pathlib import Path
fix = Path(os.environ['FIX'])
state = fix / 'owners.json'
owners = json.loads(state.read_text())
name, args = Path(sys.argv[0]).name, sys.argv[1:]
with (fix / (name + '.calls')).open('a') as f:
    f.write(json.dumps(args) + '\\n')
if name == 'find':
    root = Path(args[0])
    depth = int(args[args.index('-maxdepth') + 1]) if '-maxdepth' in args else float('inf')
    for entry, owner in owners.items():
        path = Path(entry)
        if path.is_relative_to(root) and len(path.relative_to(root).parts) <= depth:
            print(owner)
            break
else:
    if os.environ['SUDO_OK'] != '1':
        sys.exit(1)
    root = Path(args[-1])
    state.write_text(json.dumps({p: o for p, o in owners.items() if not Path(p).is_relative_to(root)}))
'''


class Fixture:
    def __init__(self, tmp):
        self.fix = Path(tmp)
        self.home = self.fix / 'home'
        self.home.mkdir()
        bins = self.fix / 'bin'
        bins.mkdir()
        for tool in ('find', 'sudo'):
            p = bins / tool
            p.write_text(FAKE_TOOL.replace('__PYTHON__', sys.executable))
            p.chmod(0o755)
        (self.fix / 'owners.json').write_text('{}')
        self.env = dict(os.environ, HOME=str(self.home), FIX=str(self.fix),
                        SUDO_OK='1', PATH=f'{bins}:/usr/bin:/bin')
        self.user = subprocess.check_output(['id', '-un'], text=True).strip()
        self.group = subprocess.check_output(['id', '-gn'], text=True).strip()

    def foreign(self, path, owner='root', leaf=False):
        p = self.home / path
        if leaf:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()
        else:
            p.mkdir(parents=True, exist_ok=True)
        state = self.fix / 'owners.json'
        owners = json.loads(state.read_text())
        owners[str(p)] = owner
        state.write_text(json.dumps(owners))

    def calls(self, tool):
        p = self.fix / (tool + '.calls')
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def run(self, script=None):
        if script is None:
            script = runs.CACHE_OWNER_REPAIR.replace('__OFFBOX_BOX__', 'bx_test')
            script += '\necho USER_COMMAND\nexit 3\n'
        return subprocess.run(['bash', '-c', script], env=self.env, text=True,
                              capture_output=True, timeout=30)


class CacheOwnerRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = Fixture(self.tmp.name)

    def test_clean_caches_are_quiet_without_sudo(self):
        for root in ('.npm', '.cache', '.local/share/pnpm', '.yarn'):
            (self.fx.home / root / 'warm').mkdir(parents=True)
        result = self.fx.run()
        self.assertEqual((result.returncode, result.stderr, self.fx.calls('sudo')), (3, '', []))
        self.assertEqual(result.stdout, 'USER_COMMAND\n')
        self.assertEqual(len(self.fx.calls('find')), 4)

    def test_foreign_owner_repairs_only_affected_cache_then_stays_quiet(self):
        for root, entry, owner in (
            ('.npm', '_cacache/content-v2/sha512/93/2b', 'root'),
            ('.cache', 'pip/http', '12345'),
            ('.local/share/pnpm', 'store/v10/files/ab', 'root'),
            ('.yarn', 'v6/package', 'root'),
        ):
            with self.subTest(root=root):
                before = len(self.fx.calls('sudo'))
                self.fx.foreign(f'{root}/{entry}', owner)
                result = self.fx.run()
                self.assertEqual((result.returncode, result.stdout), (3, 'USER_COMMAND\n'))
                self.assertEqual(result.stderr, f'offbox: gave {self.fx.home / root} back to '
                                 f'{self.fx.user} (foreign-owned entries left by an earlier run)\n')
                self.assertEqual(self.fx.calls('sudo')[before:], [[
                    '-n', 'chown', '-h', '-R', f'{self.fx.user}:{self.fx.group}',
                    '--', str(self.fx.home / root),
                ]])
                again = self.fx.run()
                self.assertEqual((again.returncode, again.stderr), (3, ''))
                self.assertEqual(len(self.fx.calls('sudo')), before + 1)

    def test_foreign_leaf_under_user_owned_ancestors_is_repaired(self):
        for path in ('.npm/_cacache/content-v2/sha512/93/2b/content',
                     '.local/share/pnpm/store/v10/files/ab/content',
                     '.cache/pip/http/a/b/c/d/e/content',
                     '.yarn/v6/package/node_modules/pkg/lib/content'):
            with self.subTest(path=path):
                before = len(self.fx.calls('sudo'))
                self.fx.foreign(path, leaf=True)
                result = self.fx.run()
                self.assertEqual((result.returncode, result.stdout), (3, 'USER_COMMAND\n'))
                self.assertIn('offbox: gave ', result.stderr)
                self.assertEqual(len(self.fx.calls('sudo')), before + 1)
                self.assertEqual(json.loads((self.fx.fix / 'owners.json').read_text()), {})

    def test_failed_sudo_warns_with_manual_command_and_preserves_command_exit(self):
        self.fx.env['SUDO_OK'] = '0'
        self.fx.foreign('.npm/_cacache', '12345')
        result = self.fx.run()
        self.assertEqual((result.returncode, result.stdout), (3, 'USER_COMMAND\n'))
        self.assertIn('has entries owned by 12345 and sudo -n chown failed', result.stderr)
        manual = shlex.split(result.stderr.split('; run: ', 1)[1])
        self.assertEqual(manual, ['offbox', 'ssh', 'bx_test', '--', 'sudo', 'chown', '-h', '-R',
                                  f'{self.fx.user}:{self.fx.group}', '--', str(self.fx.home / '.npm')])
        result = self.fx.run(runs.CACHE_OWNER_REPAIR.replace('__OFFBOX_BOX__', 'bx_test') + '\nexit 0')
        self.assertEqual(result.returncode, 0)

    def test_missing_cache_roots_are_not_scanned_or_created(self):
        result = self.fx.run()
        self.assertEqual((result.returncode, result.stderr), (3, ''))
        self.assertEqual((self.fx.calls('sudo'), self.fx.calls('find')), ([], []))
        self.assertEqual(list(self.fx.home.iterdir()), [])

    def test_symlinked_root_and_unlisted_paths_are_untouched(self):
        self.fx.foreign('checkout/node_modules/package')
        self.fx.foreign('outside')
        (self.fx.home / '.npm').symlink_to(self.fx.home / 'outside', target_is_directory=True)
        result = self.fx.run()
        self.assertEqual((result.returncode, result.stderr), (3, ''))
        self.assertEqual((self.fx.calls('sudo'), self.fx.calls('find')), ([], []))
        self.assertEqual(len(json.loads((self.fx.fix / 'owners.json').read_text())), 2)

    def test_remote_script_repairs_before_plain_and_step_commands(self):
        (self.fx.home / 'w/repo').mkdir(parents=True)
        for steps in (None, ['cat "$FIX/owners.json"', 'exit 7']):
            with self.subTest(steps=steps):
                self.fx.foreign('.npm/_cacache')
                with patch.multiple(runs, DOCKER_REPAIR=':', LDCACHE_REPAIR=':', GO_REPAIR=':'):
                    script = runs.remote_script('w/repo', '.', ['cat "$FIX/owners.json"; exit 7'],
                                                None, 'run-test', steps=steps, box_id='bx_test')
                result = self.fx.run(script)
                self.assertEqual(result.returncode, 7)
                self.assertIn('{}', result.stdout)
                self.assertIn('offbox: gave ', result.stderr)


if __name__ == '__main__':
    unittest.main()
