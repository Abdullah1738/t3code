import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
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
        # Exported shell functions (including offbox's node/cd wrappers) override our fake binaries.
        self.env = dict(HOME=str(self.home), NVM_DIR=str(self.home / '.nvm'),
                        PATH=f'{self.brew}:/usr/bin:/bin',
                        ROBOB_REPO_NODE_HELPER=str(HELPER), ROBOB_REPO_NODE_PYTHON=sys.executable)
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
        r = subprocess.run([shell, '-c', command], cwd=cwd or self.repo, env=self.env,
                           text=True, capture_output=True, timeout=10)
        self.assertNotIn('repo-node:', r.stdout)
        return r

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

    def test_pins_preserve_blocker_prefix(self):
        (self.repo / '.nvmrc').write_text('22')
        self.pkg(packageManager='pnpm@10')
        self.pnpm()
        prefix = [self.home / rel for rel in [
            '.config/opencode/skills/remote-compute/scripts/blockers',
            '.local/share/harness-hooks/coord-blockers',
        ]]
        self.env['PATH'] = ':'.join(map(str, prefix)) + ':' + self.env['PATH']
        for shell in ['/bin/zsh', '/bin/bash']:
            with self.subTest(shell=shell):
                r = self.run_shell('node -v; pnpm -v; printf "%s\\n" "$PATH"', shell)
                self.assertEqual(r.returncode, 0, r.stderr)
                lines = r.stdout.splitlines()
                self.assertEqual(lines[:2], ['v22.23.2', '10.26.2'])
                self.assertEqual(lines[2].split(':')[:2], list(map(str, prefix)))
                r = self.run_shell('cd ' + shlex.quote(str(self.plain)) + '; cd ' + shlex.quote(str(self.repo)) + '; node -v; printf "%s\\n" "$PATH"', shell)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout.splitlines()[0], 'v22.23.2', r.stderr)
                self.assertEqual(r.stdout.splitlines()[1].split(':')[:2], list(map(str, prefix)))

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

    def test_interactive_startup_does_not_run_debug_refresh_for_each_command(self):
        (self.repo / '.nvmrc').write_text('22')
        zdot = self.home / 'zdot'
        zdot.mkdir()
        (zdot / '.zshenv').write_text(
            '. ' + shlex.quote(str(HELPER / 'init.sh')) + '\n'
            'startup_calls=0\n'
            'functions -c _repo_node_hook _startup_original_hook\n'
            '_repo_node_hook() { (( ++startup_calls )); _startup_original_hook; }\n')
        # Model command-heavy rc files such as nvm.sh, without timing assertions.
        for name in ['.zprofile', '.zshrc']:
            (zdot / name).write_text('PATH=' + shlex.quote(self.env['PATH']) + '\n' + ':\n' * 1000)
        for flags in ['-ic', '-ilc']:
            with self.subTest(flags=flags):
                r = subprocess.run(
                    ['/bin/zsh', flags, 'print -r -- $startup_calls; '
                     'node -v; cd ' + shlex.quote(str(self.repo)) + '; node -v'],
                    cwd=self.plain, env=dict(self.env, ZDOTDIR=str(zdot)),
                    text=True, capture_output=True, timeout=10)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout.splitlines(), ['0', 'v26.2.0', 'v22.23.2'], r.stderr)

    def test_interactive_startup_leaves_existing_debug_trap_untouched(self):
        for trap in ["trap ':' DEBUG", 'TRAPDEBUG() { return 0; }']:
            with self.subTest(trap=trap):
                r = subprocess.run(
                    ['/bin/zsh', '-fic', trap + '\noriginal=$(trap)\n. '
                     + shlex.quote(str(HELPER / 'init.sh'))
                     + '\n[[ "$(trap)" == "$original" ]]'],
                    cwd=self.plain, env=self.env, text=True, capture_output=True, timeout=10)
                self.assertEqual(r.returncode, 0, r.stderr)

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

    def test_previous_zsh_debug_outcomes_match_baseline(self):
        body = 'echo before; echo guarded; echo after'
        for status in [0, 1, 2, 7]:
            for strict in ['', 'set -e; ']:
                for shape in ['function', 'string-command', 'string-return']:
                    # A top-level return0 in a string trap ends the baseline shell, rather than blocking a command.
                    if shape == 'string-return' and status == 0:
                        continue
                    command = f'return {status}' if shape != 'string-command' else f'(exit {status})'
                    action = f'if [[ "$ZSH_DEBUG_CMD" == "echo guarded" ]]; then {command}; fi'
                    if shape == 'function':
                        before = strict + 'TRAPDEBUG() { ' + action + '; return 0; }'
                    else:
                        before = strict + 'trap ' + shlex.quote(action) + ' DEBUG'
                    with self.subTest(status=status, strict=strict, shape=shape):
                        baseline = subprocess.run(['/bin/zsh', '-c', before + '\n' + body], cwd=self.plain,
                                                  env=self.env, text=True, capture_output=True, timeout=10)
                        actual = self.run_shell(body, '/bin/zsh', self.plain, before=before)
                        self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                                         (baseline.returncode, baseline.stdout, baseline.stderr))
                        if status and shape in ['function', 'string-return']:
                            self.assertEqual(actual.returncode, status)
                            self.assertEqual(actual.stdout, 'before\n')

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
                        self.env['ROBOB_REPO_NODE_PYTHON'] = '/bin/false' if selector_fails else sys.executable
                        r = self.run_shell('node -v; echo survived', shell, before='set -eu; ' + functions)
                        expected = 'v26.2.0' if selector_fails else 'v22.23.2'
                        self.assertEqual(r.returncode, 0, r.stderr)
                        self.assertEqual(r.stdout.splitlines(), [expected, 'survived'], r.stderr)
        self.env['ROBOB_REPO_NODE_PYTHON'] = sys.executable

    def startup_shell(self, body, shell='/bin/bash', cwd=None, script=False, before=''):
        # zsh -f + source misses preexec calls between lines of a script loaded via zshenv.
        zdot = self.home / 'zdot'
        zdot.mkdir(exist_ok=True)
        (zdot / '.zshenv').write_text(before + '\n. ' + shlex.quote(str(HELPER / 'init.sh')) + '\n')
        env = dict(self.env, ZDOTDIR=str(zdot), BASH_ENV=str(HELPER / 'bash-env.sh'))
        if script:
            path = self.home / 'script.zsh'
            path.write_text('#!/bin/zsh\n' + body + '\n')
            args = [shell, str(path)]
        else:
            args = [shell, '-c', body]
        r = subprocess.run(args, cwd=cwd or self.plain, env=env, text=True,
                           capture_output=True, timeout=10)
        self.assertNotIn('repo-node:', r.stdout)
        return r

    def test_noninteractive_shells_load_safe_chain_and_keep_it_after_cd(self):
        hooks = self.home / '.safe-chain/scripts/init-posix.sh'
        hooks.parent.mkdir(parents=True)
        hooks.write_text('npm() { echo "guard:npm"; return 17; }; '
                         'python3() { echo "guard:python3"; return 17; }; '
                         'pip() { echo "guard:pip"; return 17; }\n')
        for shell in ['/bin/zsh', '/bin/bash']:
            with self.subTest(shell=shell):
                body = 'npm install example; cd ' + shlex.quote(str(self.repo)) + '; python3 -m pip install example; pip install example'
                r = self.startup_shell(body, shell)
                self.assertEqual(r.returncode, 17, r.stderr)
                self.assertEqual(r.stdout.splitlines(), ['guard:npm', 'guard:python3', 'guard:pip'])
                if shell == '/bin/bash':
                    nested = self.startup_shell('/bin/bash -c ' + shlex.quote(body), shell)
                    self.assertEqual(nested.returncode, 17, nested.stderr)
                    self.assertEqual(nested.stdout, r.stdout)

    def directory_cases(self):
        (self.repo / '.nvmrc').write_text('22')
        missing = self.home / 'missing'
        missing.mkdir()
        (missing / '.git').mkdir()
        (missing / '.nvmrc').write_text('22.23.4')
        unpinned = self.home / 'unpinned'
        unpinned.mkdir()
        (unpinned / '.git').mkdir()
        return [self.repo, missing, self.plain, unpinned]

    def test_bash_errexit_directory_matrix(self):
        for directory in self.directory_cases():
            for builtin in ['cd', 'pushd', 'popd']:
                with self.subTest(directory=directory.name, builtin=builtin):
                    target = shlex.quote(str(directory))
                    if builtin == 'popd':
                        commands = f'pushd {target} >/dev/null; pushd {shlex.quote(str(self.home))} >/dev/null; popd >/dev/null'
                    else:
                        commands = f'{builtin} {target} >/dev/null'
                    r = self.startup_shell('set -euo pipefail; ' + commands + '; printf reached')
                    self.assertEqual((r.returncode, r.stdout), (0, 'reached'), r.stderr)

    def test_bash_errexit_existing_user_wrappers(self):
        (self.repo / '.nvmrc').write_text('22')
        for builtin in ['cd', 'pushd', 'popd']:
            setup = f'{builtin}() {{ printf previous >&2; builtin {builtin} "$@"; }}; '
            commands = f'{builtin} {shlex.quote(str(self.repo))} >/dev/null'
            if builtin == 'popd':
                commands = f'builtin pushd {shlex.quote(str(self.repo))} >/dev/null; builtin pushd {shlex.quote(str(self.plain))} >/dev/null; popd >/dev/null'
            r = self.run_shell('set -euo pipefail; ' + commands + '; command -v node; printf reached',
                               '/bin/bash', self.plain, before=setup)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.splitlines(), [str(self.home / '.nvm/versions/node/v22.23.2/bin/node'), 'reached'])
            self.assertEqual(r.stderr, 'previous')

    def test_bash_previous_wrapper_receives_incoming_status(self):
        for builtin in ['cd', 'pushd', 'popd']:
            for incoming in [0, 1, 3]:
                with self.subTest(builtin=builtin, incoming=incoming):
                    before = f'{builtin}() {{ local incoming=$?; builtin {builtin} "$@" >/dev/null; return "$incoming"; }}'
                    commands = f'{builtin} {shlex.quote(str(self.plain))}' if builtin != 'popd' else 'popd'
                    setup = f'builtin pushd {shlex.quote(str(self.repo))} >/dev/null; ' if builtin == 'popd' else ''
                    r = self.run_shell(setup + f'(exit {incoming}); {commands}; printf "%s" "$?"',
                                       '/bin/bash', self.plain, before=before)
                    self.assertEqual((r.returncode, r.stdout), (0, str(incoming)), r.stderr)

    def test_refresh_failures_do_not_exit_strict_shells(self):
        for directory in self.directory_cases():
            for shell in ['/bin/bash', '/bin/zsh']:
                for selector in [sys.executable, '/bin/false', str(self.home / 'eval-fails')]:
                    with self.subTest(directory=directory.name, shell=shell, selector=selector):
                        self.exe(self.home / 'eval-fails', "printf 'false\\n'")
                        self.env['ROBOB_REPO_NODE_PYTHON'] = selector
                        body = 'set -euo pipefail; false || true; _repo_node_refresh; printf reached'
                        r = self.startup_shell(body, shell, directory)
                        self.assertEqual((r.returncode, r.stdout), (0, 'reached'), r.stderr)

    def test_bash_failed_directory_status(self):
        for builtin in ['cd', 'pushd', 'popd']:
            for conditional in [False, True]:
                commands = f'{builtin} {shlex.quote(str(self.home / "nonexistent"))}' if builtin != 'popd' else 'popd'
                if conditional:
                    commands = f'if {commands}; then exit 42; else printf "%s" "$?"; fi'
                body = 'set -e; ' + commands + '; printf reached'
                baseline = subprocess.run(['/bin/bash', '-c', body], cwd=self.plain,
                                          env=self.env, text=True, capture_output=True)
                r = self.startup_shell(body)
                self.assertEqual((r.returncode, r.stdout), (baseline.returncode, baseline.stdout), r.stderr)
                if not conditional:
                    self.assertNotEqual(r.returncode, 0)
                    self.assertEqual(r.stdout, '')

    def test_bash_upgrades_exported_old_wrappers_once(self):
        (self.repo / '.nvmrc').write_text('22')
        for previous in [False, True]:
            for builtin in ['cd', 'pushd', 'popd']:
                with self.subTest(previous=previous, builtin=builtin):
                    setup = ''
                    call = f'builtin {builtin}'
                    if previous:
                        setup = f'_repo_node_previous_{builtin}() {{ printf previous >&2; builtin {builtin} "$@"; }}; export -f _repo_node_previous_{builtin}; '
                        call = f'_repo_node_previous_{builtin}'
                    setup += f'{builtin}() {{ {call} "$@"; local rc=$?; [ "$rc" != 0 ] || _repo_node_refresh; return "$rc"; }}; export -f {builtin}; '
                    target = shlex.quote(str(self.repo))
                    commands = f'{builtin} {target} >/dev/null' if builtin != 'popd' else f'builtin pushd {target} >/dev/null; builtin pushd {shlex.quote(str(self.plain))} >/dev/null; popd >/dev/null'
                    child = f'set -euo pipefail; . {shlex.quote(str(HELPER / "init.sh"))}; {commands}; command -v node; printf reached'
                    # The grandchild inherits the repaired wrapper too: neither shell may wrap it again.
                    child = f'export -f {builtin}; /bin/bash -c ' + shlex.quote(child)
                    r = self.startup_shell(setup + '/bin/bash -c ' + shlex.quote(child))
                    self.assertEqual(r.returncode, 0, r.stderr)
                    self.assertEqual(r.stdout.splitlines(), [str(self.home / '.nvm/versions/node/v22.23.2/bin/node'), 'reached'])
                    self.assertEqual(r.stderr, 'previous' if previous else '')

    def test_zshenv_errexit_matrix(self):
        for directory in self.directory_cases():
            for script in [False, True]:
                for body in ['[[ -z x ]] && { exit 2; }\nprint reached\nexit 0',
                             'false || true\ncd ' + shlex.quote(str(directory)) + '\ncd /tmp\nprint reached']:
                    with self.subTest(directory=directory.name, script=script, body=body):
                        r = self.startup_shell('set -euo pipefail\n' + body, '/bin/zsh', directory, script)
                        self.assertEqual((r.returncode, r.stdout), (0, 'reached\n'), r.stderr)

    def test_zshenv_preserves_status_and_previous_trap(self):
        for script in [False, True]:
            for before in ['', 'TRAPDEBUG() { return 0; }', "trap ':' DEBUG"]:
                r = self.startup_shell('false\nprint $?\n(exit 3)\nprint $?', '/bin/zsh', script=script, before=before)
                self.assertEqual((r.returncode, r.stdout), (0, '1\n3\n'), r.stderr)
        # Each registered hook must be safe when invoked with a previous failure under errexit.
        for hook in ['chpwd', 'preexec', 'precmd']:
            r = self.startup_shell('set -e\nfalse || ' + f'for hook in "${{{hook}_functions[@]}}"; do "$hook"; done' + '\nprint reached', '/bin/zsh', script=True)
            self.assertEqual((r.returncode, r.stdout), (0, 'reached\n'), r.stderr)

    def test_zshenv_time_reached(self):
        source = HERE.parent / 'robob-watch/helpers/time-reached'
        helper = self.home / 'time-reached'
        # Test the hook fix with ordinary zsh startup as well as the deployed -f defence.
        for startup in ['#!/bin/zsh', '#!/bin/zsh -f']:
            helper.write_text(startup + '\n' + source.read_text().split('\n', 1)[1])
            helper.chmod(0o755)
            for at, expected in [('2099-11-20T10:00:00+04:00', ''), ('2000-11-01T10:00:00+04:00', 'x\n')]:
                with self.subTest(startup=startup, at=at):
                    r = self.startup_shell(shlex.quote(str(helper)) + ' ' + at + ' x', '/bin/zsh')
                    self.assertEqual((r.returncode, r.stdout), (0, expected), r.stderr)

    def test_watch_helpers_ignore_user_zshenv(self):
        zdot = self.home / 'hostile-startup'
        zdot.mkdir()
        (zdot / '.zshenv').write_text('print unexpected-startup; exit 73\n')
        card_node = self.home / 'card-node'
        self.exe(card_node, 'printf card-ok')
        env = dict(self.env, ZDOTDIR=str(zdot), WATCH_DIR=str(self.home), CARD_CHECK_NODE=str(card_node))
        helpers = HERE.parent / 'robob-watch/helpers'
        cases = [('time-reached', ['2099-11-20T10:00:00+04:00', 'x'], 0, ''),
                 ('output-changed', ['--', '/usr/bin/printf', 'value'], 0, ''),
                 ('wa-lock', ['/usr/bin/printf', 'lock-ok'], 0, 'lock-ok'),
                 ('card-check/card-check', ['--help'], 0, 'card-ok'),
                 ('wa', ['help'], 0, None), ('wa-session-sig', ['invalid'], 1, ''),
                 ('email-new-message', [], 1, ''), ('whatsapp-new-message', [], 1, '')]
        for name, args, status, output in cases:
            with self.subTest(helper=name):
                r = subprocess.run([str(helpers / name), *args], cwd=self.plain, env=env,
                                   text=True, capture_output=True, timeout=10)
                self.assertEqual(r.returncode, status, r.stderr)
                self.assertNotIn('unexpected-startup', r.stdout + r.stderr)
                self.assertNotIn('repo-node:', r.stdout)
                if output is not None:
                    self.assertEqual(r.stdout, output)

    def test_session_sig_sets_its_own_glob_options(self):
        db = self.home / 'Library/Application Support/whatscli/session.db'
        db.parent.mkdir(parents=True)
        with sqlite3.connect(db) as conn:
            conn.execute('CREATE TABLE whatsmeow_sender_keys (chat_id TEXT, sender_id TEXT, sender_key BLOB)')
            conn.execute('CREATE TABLE whatsmeow_lid_map (pn TEXT, lid TEXT)')
            conn.execute('CREATE TABLE whatsmeow_sessions (their_id TEXT, session BLOB)')
            for jid in ['123456789@g.us', '12345-67890@g.us']:
                conn.execute('INSERT INTO whatsmeow_sender_keys VALUES (?, ?, ?)', (jid, 'sender', bytes.fromhex('abcd')))
            conn.execute('INSERT INTO whatsmeow_sessions VALUES (?, ?)', ('123_foo', bytes.fromhex('abcd')))
        helper = HERE.parent / 'robob-watch/helpers/wa-session-sig'
        for jid, material in [('123456789@g.us', 'gsenderABCD'), ('12345-67890@g.us', 'gsenderABCD'),
                              ('123@s.whatsapp.net', '123_fooABCD'), ('123', '123_fooABCD'),
                              ('invalid@g.us', None), ('invalid', None), ('', None)]:
            with self.subTest(jid=jid):
                r = subprocess.run([str(helper), jid], cwd=self.plain, env=self.env,
                                   text=True, capture_output=True, timeout=10)
                expected = hashlib.sha256(material.encode()).hexdigest()[:16] + '\n' if material else ''
                self.assertEqual((r.returncode, r.stdout), (0 if material else 1, expected), r.stderr)
                self.assertNotIn('repo-node:', r.stdout)

    def test_warning_root_lookup_does_not_run_directory_hooks(self):
        (self.repo / '.nvmrc').write_text('22.23.4')
        for previous in ['chpwd() { print directory-changed; }',
                         'directory_changed() { print directory-changed; }; chpwd_functions=(directory_changed)']:
            for child in ['/bin/bash', '/bin/zsh']:
                with self.subTest(previous=previous, child=child):
                    body = child + ' -c ' + shlex.quote('printf mock-out')
                    r = self.startup_shell(body, '/bin/zsh', self.repo, before=previous)
                    self.assertEqual((r.returncode, r.stdout), (0, 'mock-out'), r.stderr)
                    self.assertEqual(r.stderr.count('repo-node:'), 1, r.stderr)

    def test_nested_child_warning_is_silent(self):
        self.exe(self.home / '.nvm/versions/node/v22.23.5/bin/node', 'echo v22.23.5')
        (self.repo / '.nvmrc').write_text('22.23.4')
        child_python = self.home / 'child.py'
        for outer in ['/bin/bash', '/bin/zsh']:
            for child in ['/bin/bash', '/bin/zsh']:
                for merged in [False, True]:
                    with self.subTest(outer=outer, child=child, merged=merged):
                        kwargs = 'stdout=subprocess.PIPE, stderr=subprocess.STDOUT' if merged else 'capture_output=True'
                        child_python.write_text('import subprocess\n' +
                            f'r = subprocess.run([{child!r}, "-c", "printf mock-out"], {kwargs}, text=True)\n' +
                            'assert r.returncode == 0, r\nassert r.stdout == "mock-out", r\nassert not r.stderr, r\nprint(r.stdout, end="")\n')
                        r = self.startup_shell('/usr/bin/python3 ' + shlex.quote(str(child_python)), outer, self.repo)
                        self.assertEqual((r.returncode, r.stdout), (0, 'mock-out'), r.stderr)
                        self.assertEqual(r.stderr.count('repo-node:'), 1, r.stderr)

    def test_different_warning_in_child_is_printed_once(self):
        _, missing, _, _ = self.directory_cases()
        (self.repo / '.nvmrc').write_text('22.23.4')
        for shell in ['/bin/bash', '/bin/zsh']:
            nested = shell + ' -c ' + shlex.quote('printf reached')
            body = 'cd ' + shlex.quote(str(missing)) + '; ' + nested
            r = self.startup_shell(shell + ' -c ' + shlex.quote(body), shell, self.repo)
            self.assertEqual((r.returncode, r.stdout), (0, 'reached'), r.stderr)
            # Same warning text, different repo: first shell in each repo warns once.
            self.assertEqual(r.stderr.count('repo-node:'), 2, r.stderr)

    def test_warning_identity_tracks_repo_and_text(self):
        (self.repo / '.nvmrc').write_text('22.23.4')
        subdir = self.repo / 'subdir'
        subdir.mkdir()
        for shell in ['/bin/bash', '/bin/zsh']:
            for pin, expected in [('22.23.4', 1), ('18.20.0', 2)]:
                (self.repo / '.nvmrc').write_text('22.23.4')
                child = 'cd ' + shlex.quote(str(subdir)) + '; printf reached'
                body = 'printf %s ' + shlex.quote(pin) + ' > .nvmrc; ' + shell + ' -c ' + shlex.quote(child)
                r = self.startup_shell(body, shell, self.repo)
                self.assertEqual((r.returncode, r.stdout), (0, 'reached'), r.stderr)
                self.assertEqual(r.stderr.count('repo-node:'), expected, r.stderr)

    def test_zshenv_directory_selects_pinned_node(self):
        (self.repo / '.nvmrc').write_text('22')
        r = self.startup_shell('set -euo pipefail\ncd ' + shlex.quote(str(self.repo)) + '\ncommand -v node', '/bin/zsh', script=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), str(self.home / '.nvm/versions/node/v22.23.2/bin/node'))

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
            payload = {dst.relative_to(home): data for dst, data, _ in changes}
            for name in ['shared-deps.sh', 'pnpm-bin/pnpm']:
                self.assertEqual(payload[Path('.local/libexec/repo-node-pin') / name],
                                 (HELPER / name).read_bytes())

    def test_preview_never_includes_unchanged_sentinel_secrets(self):
        sentinel = 'SENTINEL_CREDENTIAL_MUST_NOT_LEAVE_SHELL_FILE'
        secret_line = 'export API_CREDENTIAL=' + sentinel
        cases = [secret_line + '\n', secret_line, secret_line + '\n\n',
                 secret_line + '\n# >>> repo-node-pin (managed by local-helpers) >>>\nold setup\n# <<< repo-node-pin <<<\n' + secret_line + '\n']
        for original in cases:
            for flags in [[], ['--check']]:
                with self.subTest(original=original, flags=flags), tempfile.TemporaryDirectory() as tmp:
                    home = Path(tmp)
                    names = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc']
                    for name in names:
                        (home / name).write_text(original)
                    env = dict(os.environ, HOME=str(home), PYTHONDONTWRITEBYTECODE='1')
                    result = subprocess.run(['/usr/bin/python3', str(HERE / 'install-node-pin.py'), *flags],
                                            env=env, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 1 if flags else 0, result.stderr)
                    self.assertNotIn(sentinel, result.stdout + result.stderr)
                    self.assertNotIn('API_CREDENTIAL', result.stdout + result.stderr)
                    self.assertIn('+[ ! -r "$HOME/.local/libexec/repo-node-pin/init.sh" ]', result.stdout)
                    self.assertIn('init.sh', result.stdout)
                    for name in names:
                        self.assertEqual((home / name).read_text(), original)

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
                env = dict(os.environ, HOME=str(home))
                for key in ['BASH_ENV', 'ROBOB_REPO_PREVIOUS_BASH_ENV', 'ROBOB_REPO_NODE_HELPER',
                            'ROBOB_REPO_NODE_PYTHON', 'ZDOTDIR', '_REPO_NODE_WARNED']:
                    env.pop(key, None)
                r = subprocess.run(['/bin/bash', '-lc', 'echo "$LOGIN_PRESERVED"'], env=env,
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
