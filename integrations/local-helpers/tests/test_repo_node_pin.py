import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parents[1]
HELPER = HERE / 'libexec/repo-node-pin'
spec = importlib.util.spec_from_file_location('selector', HELPER / 'select.py')
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)


class SelectionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.repo = self.home / 'repo'
        self.repo.mkdir()
        (self.repo / '.git').mkdir()
        self.plain = self.home / 'plain'
        self.plain.mkdir()
        self.brew = self.home / 'brew/bin'
        self.brew.mkdir(parents=True)
        self.exe(self.brew / 'node', 'if [ "$1" = -v ]; then echo v26.2.0; else exec /bin/sh "$@"; fi')
        self.exe(self.brew / 'pnpm', 'echo 11.10.0')
        self.env = dict(os.environ, HOME=str(self.home), NVM_DIR=str(self.home / '.nvm'),
                        PATH=f'{self.brew}:/usr/bin:/bin',
                        ROBOB_REPO_NODE_HELPER=str(HELPER), ROBOB_REPO_NODE_PYTHON='/opt/homebrew/bin/python3')
        for key in ['BASH_ENV', 'ROBOB_REPO_PREVIOUS_BASH_ENV', 'COREPACK_HOME']:
            self.env.pop(key, None)
        for v in ['22.13.1', '22.23.2', '24.21.0', '26.2.0']:
            root = self.home / f'.nvm/versions/node/v{v}'
            # Fake Node prints its version, or executes our fake pnpm script.
            self.exe(root / 'bin/node', f'if [ "$1" = -v ]; then echo v{v}; else exec /bin/sh "$@"; fi')

    def exe(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o755)

    def pkg(self, **fields):
        (self.repo / 'package.json').write_text(json.dumps(fields))

    def pnpm(self, v='10.26.2', cache=True):
        root = self.home / (f'.cache/node/corepack/v1/pnpm/{v}' if cache else '.nvm/versions/node/v22.23.2/lib/node_modules/pnpm')
        root.mkdir(parents=True, exist_ok=True)
        (root / 'package.json').write_text(json.dumps({'name': 'pnpm', 'version': v, 'bin': {'pnpm': 'bin/pnpm.cjs'}}))
        self.exe(root / 'bin/pnpm.cjs', f'echo {v}')

    def run_shell(self, body, shell='/bin/zsh', cwd=None, before=''):
        command = before + '\n. ' + shlex.quote(str(HELPER / 'init.sh')) + '\n' + body
        return subprocess.run([shell, '-c', command], cwd=cwd or self.repo, env=self.env,
                              text=True, capture_output=True, timeout=10)

    def test_fallback_and_pnpm_cache_before_homebrew(self):
        (self.repo / '.nvmrc').write_text('v20\n')
        self.pkg(engines={'node': '^20.19.0 || >=22.12.0 <23'})
        (self.repo / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
        self.pnpm()
        for shell in ['/bin/zsh', '/bin/bash']:
            with self.subTest(shell=shell):
                r = self.run_shell('node -v; pnpm -v; false; echo $?', shell)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout.splitlines(), ['v22.23.2', '10.26.2', '1'])
                self.assertEqual(len(r.stderr.splitlines()), 1, r.stderr)
                self.assertIn('v20 unavailable', r.stderr)

    def test_no_pin_is_unchanged(self):
        for shell in ['/bin/zsh', '/bin/bash']:
            r = self.run_shell('printf "%s\\n" "$PATH"; node -v; pnpm -v', shell, self.plain)
            self.assertEqual(r.stdout.splitlines(), [self.env['PATH'], 'v26.2.0', '11.10.0'])
            self.assertEqual(r.stderr, '')

    def test_package_manager_selects_major_from_installed_package(self):
        self.pkg(packageManager='pnpm@10.2.0+sha512.deadbeef')
        self.pnpm(cache=False)
        r = self.run_shell('pnpm -v')
        self.assertEqual(r.stdout.strip(), '10.26.2', r.stderr)

    def test_missing_node_warns_once_without_install(self):
        (self.repo / '.node-version').write_text('18.20.0')
        r = self.run_shell('node -v; :; :')
        self.assertEqual(r.stdout.strip(), 'v26.2.0')
        self.assertEqual(len(r.stderr.splitlines()), 1)
        self.assertIn("nvm install '18.20.0'", r.stderr)

    def test_missing_pnpm_blocks_incompatible_binary(self):
        self.pkg(packageManager='pnpm@10.26.2')
        r = self.run_shell('pnpm -v')
        self.assertEqual(r.returncode, 127)
        self.assertNotIn('11.10.0', r.stdout)
        self.assertIn('corepack prepare pnpm@10 --activate', r.stderr)

    def test_directory_switch_and_snapshot_restore(self):
        (self.repo / '.nvmrc').write_text('22')
        self.pkg(packageManager='pnpm@10')
        self.pnpm()
        for shell in ['/bin/zsh', '/bin/bash']:
            r = self.run_shell(f'cd {shlex.quote(str(self.repo))} && node -v; pnpm -v; cd {shlex.quote(str(self.plain))}; node -v; pnpm -v', shell, self.plain)
            self.assertEqual(r.stdout.splitlines(), ['v22.23.2', '10.26.2', 'v26.2.0', '11.10.0'], r.stderr)
        r = self.run_shell(f'PATH={shlex.quote(self.env["PATH"])}; node -v')
        self.assertEqual(r.stdout.strip(), 'v22.23.2', r.stderr)

    def test_safe_chain_wrapper_survives(self):
        self.pkg(packageManager='pnpm@10')
        self.pnpm()
        r = self.run_shell('pnpm -v', before='wrapSafeChainCommand() { echo wrapped; command "$@"; }; pnpm() { wrapSafeChainCommand pnpm "$@"; }')
        self.assertEqual(r.stdout.splitlines(), ['wrapped', '10.26.2'], r.stderr)

    def test_git_boundary_and_nearest_pin(self):
        (self.home / '.nvmrc').write_text('26')
        r = self.run_shell('node -v')
        self.assertEqual(r.stdout.strip(), 'v26.2.0')
        (self.repo / '.node-version').write_text('22.13.1')
        child = self.repo / 'child'
        child.mkdir()
        r = self.run_shell('node -v', cwd=child)
        self.assertEqual(r.stdout.strip(), 'v22.13.1')

    def test_local_alias_forms(self):
        alias = self.home / '.nvm/alias/default'
        alias.parent.mkdir(parents=True)
        alias.write_text('node\n')
        for pin, expected in [('node', 'v26.2.0'), ('stable', 'v26.2.0'), ('default', 'v26.2.0'), ('lts/jod', 'v22.23.2'), ('lts/*', 'v24.21.0')]:
            with self.subTest(pin=pin):
                (self.repo / '.nvmrc').write_text(pin + '\n# comment\n')
                r = self.run_shell('node -v')
                self.assertEqual(r.stdout.strip(), expected, r.stderr)

    def test_pin_intersects_engines(self):
        (self.repo / '.nvmrc').write_text('22')
        self.pkg(engines={'node': '>=22.13 <22.20'})
        r = self.run_shell('node -v')
        self.assertEqual(r.stdout.strip(), 'v22.13.1', r.stderr)

    def test_child_shell_restores_unpinned_path(self):
        (self.repo / '.nvmrc').write_text('22')
        r = self.run_shell('/bin/bash -c ' + shlex.quote('cd ' + shlex.quote(str(self.plain)) + '; node -v'))
        self.assertEqual(r.stdout.strip(), 'v26.2.0', r.stderr)

    def test_generated_shell_entry_points(self):
        spec = importlib.util.spec_from_file_location('installer', HERE / 'install-node-pin.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        for dst, data, mode in installer.plan(self.home):
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            dst.chmod(mode)
        (self.repo / '.nvmrc').write_text('22')
        for shell, args in [('/bin/zsh', []), ('/bin/zsh', ['-l']), ('/bin/zsh', ['-i']), ('/bin/bash', ['-l']), ('/bin/bash', ['-i'])]:
            with self.subTest(shell=shell, args=args):
                r = subprocess.run([shell, *args, '-c', 'node -v'], cwd=self.repo, env=self.env,
                                   text=True, capture_output=True, timeout=10)
                self.assertEqual(r.stdout.strip(), 'v22.23.2', r.stderr)

    def test_lock_v9_accepts_cached_pnpm9_when_no10(self):
        (self.repo / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
        self.pnpm('9.15.9')
        r = self.run_shell('pnpm -v')
        self.assertEqual(r.stdout.strip(), '9.15.9', r.stderr)

    def test_path_positions_restore_exactly(self):
        nodebin = self.home / '.nvm/versions/node/v22.23.2/bin'
        for entries in [[str(nodebin), self.env['PATH']], [self.env['PATH'], str(nodebin)], [self.env['PATH'], str(nodebin), str(nodebin)]]:
            for shell in ['/bin/zsh', '/bin/bash']:
                with self.subTest(entries=entries, shell=shell):
                    original = ':'.join(entries)
                    self.env['PATH'] = original
                    (self.repo / '.nvmrc').write_text('22')
                    r = self.run_shell('cd ' + shlex.quote(str(self.plain)) + '; printf "%s\\n" "$PATH"', shell)
                    self.assertEqual(r.stdout.strip(), original, r.stderr)
        self.env['PATH'] = f'{self.brew}:/usr/bin:/bin'

    def test_ancestor_inputs_are_independent(self):
        child = self.repo / 'child'
        child.mkdir()
        for file_at_root, file_in_child in [('.nvmrc', 'package.json'), ('package.json', '.nvmrc')]:
            for p in [self.repo / '.nvmrc', self.repo / 'package.json', child / '.nvmrc', child / 'package.json']:
                if p.exists(): p.unlink()
            for parent, name in [(self.repo, file_at_root), (child, file_in_child)]:
                (parent / name).write_text('22' if name == '.nvmrc' else json.dumps({'engines': {'node': '<22.20'}}))
            r = self.run_shell('node -v', cwd=child)
            self.assertEqual(r.stdout.strip(), 'v22.13.1', r.stderr)

    def test_existing_debug_trap_survives(self):
        (self.repo / '.nvmrc').write_text('22')
        for shell in ['/bin/zsh', '/bin/bash']:
            for action in ["trap ':' DEBUG", "trap 'echo existing-debug >&2' DEBUG"]:
                with self.subTest(shell=shell, action=action):
                    r = self.run_shell('cd ' + shlex.quote(str(self.repo)) + '; node -v; echo marker', shell, self.plain, before=action)
                    self.assertEqual(r.returncode, 0, r.stderr)
                    self.assertEqual(r.stdout.splitlines(), ['v22.23.2', 'marker'], r.stderr)
                    if 'echo' in action:
                        self.assertTrue(r.stderr.rstrip().endswith('existing-debug'), r.stderr)

    def test_shell_quote_handles_repo_text(self):
        self.pkg(engines={'node': "$(touch /tmp/not-executed); 'bad\nvalue"})
        r = self.run_shell('node -v')
        self.assertEqual(r.stdout.strip(), 'v26.2.0', r.stderr)
        self.assertIn('unsupported Node pin', r.stderr)

    def test_existing_bash_directory_functions_survive(self):
        (self.repo / '.nvmrc').write_text('22')
        r = self.run_shell('cd ' + shlex.quote(str(self.repo)) + '; node -v', '/bin/bash', self.plain,
                           before='cd() { echo previous-cd; builtin cd "$@"; }')
        self.assertEqual(r.stdout.splitlines(), ['previous-cd', 'v22.23.2'], r.stderr)

    def test_snapshot_with_existing_node_entries_restores_exact_path(self):
        (self.repo / '.nvmrc').write_text('22')
        nodebin = str(self.home / '.nvm/versions/node/v22.23.2/bin')
        for copies in [0, 1, 2]:
            original = ':'.join([f'{self.brew}:/usr/bin:/bin', *([nodebin] * copies)])
            self.env['PATH'] = original
            r = self.run_shell('PATH=' + shlex.quote(original) + '; node -v; cd ' + shlex.quote(str(self.plain)) + '; printf "%s\\n" "$PATH"')
            self.assertEqual(r.stdout.splitlines(), ['v22.23.2', original], r.stderr)

    def test_unavailable_and_unknown_alias_fall_back_to_engines(self):
        self.pkg(engines={'node': '22'})
        for pin in ['lts/argon', 'lts/boron', 'lts/carbon', 'lts/dubnium', 'lts/erbium', 'lts/fermium', 'lts/gallium', 'lts/hydrogen', 'lts/unknown', 'custom-unknown']:
            with self.subTest(pin=pin):
                (self.repo / '.nvmrc').write_text(pin)
                r = self.run_shell('node -v')
                self.assertEqual(r.stdout.strip(), 'v22.23.2', r.stderr)
                self.assertEqual(len(r.stderr.splitlines()), 1, r.stderr)
                self.assertIn('engines.node', r.stderr)

    def test_blank_pin_forms_fall_back_to_engines(self):
        self.pkg(engines={'node': '22'})
        for filename in ['.nvmrc', '.node-version']:
            for pin in ['', '  ', '\n', '# comment\n', '  # comment\n\n  ']:
                with self.subTest(filename=filename, pin=pin):
                    (self.repo / filename).write_text(pin)
                    r = self.run_shell('node -v')
                    self.assertEqual(r.stdout.strip(), 'v22.23.2', r.stderr)
                    (self.repo / filename).unlink()

    def test_exported_directory_functions_in_nested_children(self):
        (self.repo / '.nvmrc').write_text('22')
        commands = 'cd ' + shlex.quote(str(self.repo)) + '; node -v; pushd ' + shlex.quote(str(self.plain)) + ' >/dev/null; node -v; popd >/dev/null; node -v'
        for exported in ['cd', 'pushd', 'popd', 'cd pushd popd']:
            for depth in [1, 2]:
                with self.subTest(exported=exported, depth=depth):
                    child = commands
                    for _ in range(depth):
                        child = '/bin/bash -c ' + shlex.quote(child)
                    before = 'cd() { builtin cd "$@"; }; pushd() { builtin pushd "$@"; }; popd() { builtin popd "$@"; }; export -f ' + exported
                    r = self.run_shell(child, '/bin/bash', self.plain, before=before)
                    self.assertEqual(r.returncode, 0, r.stderr)
                    self.assertEqual(r.stdout.splitlines(), ['v22.23.2', 'v26.2.0', 'v22.23.2'], r.stderr)

    def test_errexit_startup_lookup_and_selector_failures(self):
        (self.repo / '.nvmrc').write_text('22')
        for shell in ['/bin/bash', '/opt/homebrew/bin/bash', '/bin/zsh']:
            if not Path(shell).exists(): continue
            for functions in ['', 'cd() { builtin cd "$@"; }']:
                for selector_fails in [False, True]:
                    with self.subTest(shell=shell, functions=functions, selector_fails=selector_fails):
                        self.env['ROBOB_REPO_NODE_PYTHON'] = '/bin/false' if selector_fails else '/opt/homebrew/bin/python3'
                        r = self.run_shell('node -v; echo survived', shell, before='set -eu; ' + functions)
                        expected = 'v26.2.0' if selector_fails else 'v22.23.2'
                        self.assertEqual(r.returncode, 0, r.stderr)
                        self.assertEqual(r.stdout.splitlines(), [expected, 'survived'], r.stderr)
        self.env['ROBOB_REPO_NODE_PYTHON'] = '/opt/homebrew/bin/python3'

    def test_range_forms(self):
        rows = [('22', '22.23.2', True), ('v22.13.1', '22.23.2', False),
                ('^20.19.0 || >=22.12.0 <23', '22.23.2', True),
                ('^20.19.0 || >=22.12.0 <23', '24.21.0', False),
                ('~22.13', '22.14.0', False), ('22.x', '22.23.2', True),
                ('22.12 - 22.23', '22.23.2', True), ('>= 22.12 < 23', '22.23.2', True),
                ('^0.2.3', '0.3.0', False), ('*', '26.2.0', True)]
        for spec, v, expected in rows:
            with self.subTest(spec=spec, version=v):
                self.assertEqual(selector.satisfies(selector.version(v), spec), expected)

class InstallPlanTest(unittest.TestCase):
    def test_preview_preserves_shell_content_and_is_idempotent(self):
        spec = importlib.util.spec_from_file_location('installer', HERE / 'install-node-pin.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            original = 'export PATH=/custom:$PATH\n# existing setup\n'
            (home / '.zshrc').write_text(original)
            changes = installer.plan(home)
            shell = next(data.decode() for dst, data, _ in changes if dst.name == '.zshrc')
            self.assertTrue(shell.startswith(original))
            self.assertEqual(shell.count(installer.BEGIN), 1)
            self.assertEqual(installer.updated(shell), shell)
            self.assertEqual((home / '.zshrc').read_text(), original)
            self.assertEqual(len(changes), 9)

    def test_existing_bash_login_entry_is_preserved(self):
        spec = importlib.util.spec_from_file_location('installer', HERE / 'install-node-pin.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        for name in ['.profile', '.bash_login', '.bash_profile']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                home = Path(tmp)
                (home / name).write_text('export LOGIN_PRESERVED=yes\n')
                changes = installer.plan(home)
                for dst, data, mode in changes:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.write_bytes(data)
                    dst.chmod(mode)
                self.assertEqual((home / '.bash_profile').exists(), name == '.bash_profile')
                r = subprocess.run(['/bin/bash', '-lc', 'echo "$LOGIN_PRESERVED"'], env=dict(os.environ, HOME=str(home)),
                                   text=True, capture_output=True, timeout=10)
                self.assertEqual(r.stdout.strip(), 'yes', r.stderr)

    def test_preview_rejects_partial_managed_block(self):
        spec = importlib.util.spec_from_file_location('installer', HERE / 'install-node-pin.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with self.assertRaises(ValueError):
            installer.updated(installer.BEGIN + '\n')


if __name__ == '__main__':
    unittest.main()
