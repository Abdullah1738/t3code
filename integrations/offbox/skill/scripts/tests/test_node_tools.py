"""Shell-level repo tool precedence and fresh-checkout bootstrap regressions."""

import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs


class RepoToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.root = self.home / 'w/repo with spaces'
        (self.root / 'apps/server').mkdir(parents=True)
        self.global_bin = self.home / 'global'
        self.global_bin.mkdir()
        self.env = {'HOME': str(self.home), 'PATH': f'{self.global_bin}:/usr/bin:/bin'}
        self.manifest()

    def manifest(self, manager='pnpm@11.10.0', key='devDependencies'):
        (self.root / 'package.json').write_text(json.dumps({
            'packageManager': manager, key: {'vite-plus': 'x', 'tsc-rs': 'x'}}))

    def tool(self, directory, name, text):
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        path.write_text('#!/bin/bash\nprintf "%s\\n" ' + shlex.quote(text) + '\n')
        path.chmod(0o755)

    def run_script(self, command=None, *, steps=None, rel='.', node=''):
        with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.object(runs, 'LDCACHE_REPAIR', ':'), patch.object(runs, 'WATCH_REPAIR', ':'):
            script = runs.remote_script('w/repo with spaces', rel, command or [], None, 'r',
                                        steps=steps, node=node, repo_root=self.root)
        return subprocess.run([shutil.which('bash'), '-c', script], env=self.env, capture_output=True,
                              text=True, timeout=10, cwd=self.home)

    def test_repo_vp_shadows_global_and_tsc_rs_resolves_from_root_and_subdir(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        self.tool(self.root / 'node_modules/.bin', 'tsc-rs', 'repo-tsc')
        for command, rel, expected in ((['vp'], '.', 'repo\n'),
                                       (['cd apps/server && vp'], '.', 'repo\n'),
                                       (['tsc-rs', '--noEmit'], '.', 'repo-tsc\n'),
                                       (['vp'], 'apps/server', 'repo\n'),
                                       (['cd apps/server && tsc-rs --noEmit'], '.', 'repo-tsc\n')):
            with self.subTest(command=command, rel=rel):
                p = self.run_script(command, rel=rel)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(p.stdout, expected)

    def test_workspace_then_ancestor_then_root_then_inherited_bins(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        self.tool(self.root / 'apps/node_modules/.bin', 'vp', 'apps')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        p = self.run_script(['vp; cd apps && vp; cd server && vp; cd ../.. && vp'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['repo', 'apps', 'server', 'repo'])
        p = self.run_script(['cd apps/server && printf "%s" "$PATH"'])
        self.assertEqual(p.stdout.split(':'), [str(self.root.resolve() / f'{prefix}node_modules/.bin')
                                             for prefix in ('apps/server/', 'apps/', '')] + self.env['PATH'].split(':'))

    def test_non_js_repo_does_not_change_path(self):
        (self.root / 'package.json').unlink()
        self.tool(self.global_bin, 'vp', 'global')
        p = self.run_script(['printf "%s\\n" "$PATH"; cd apps/server; vp'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), [self.env['PATH'], 'global'])

    def test_node_selection_and_previously_hashed_global_vp(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.global_bin, 'node', 'global-node')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        selected = self.home / 'nvm/bin'
        self.tool(selected, 'node', 'selected-node')
        node = 'vp >/dev/null\nexport PATH=' + shlex.quote(str(selected)) + ':"$PATH"\nhash vp'
        p = self.run_script(['vp; node'], node=node)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['repo', 'selected-node'])

    def test_install_makes_absent_bin_paths_work_for_later_steps(self):
        self.tool(self.global_bin, 'vp', 'global')
        install = ('mkdir -p apps/server/node_modules/.bin; '
                   'printf \'#!/bin/bash\\nprintf "installed\\\\n"\\n\' > apps/server/node_modules/.bin/vp; '
                   'chmod +x apps/server/node_modules/.bin/vp')
        p = self.run_script(steps=['vp', install, 'cd apps/server && vp'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['global', 'installed'])
        self.assertIn('offbox step 3 rc=0', p.stderr)

    def test_install_replaces_previously_resolved_global_tool_in_same_command(self):
        self.tool(self.global_bin, 'vp', 'global')
        p = self.run_script(['vp; mkdir -p node_modules/.bin; '
                             'printf \'#!/bin/bash\\necho repo\\n\' > node_modules/.bin/vp; '
                             'chmod +x node_modules/.bin/vp; vp'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['global', 'repo'])

    def test_physical_cd_and_symlinked_workspace_use_repo_bins(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        (self.root / 'linked-server').symlink_to('apps/server', target_is_directory=True)
        for command in ('cd -P apps/server && vp', 'cd linked-server && vp', 'cd -L linked-server && vp'):
            with self.subTest(command=command):
                p = self.run_script([command])
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(p.stdout, 'server\n')

    def test_missing_repo_tool_hints_for_command_forms_and_steps(self):
        for command, steps in ((['vp', 'i'], None), (['CI=1 vp i'], None),
                                (['cd apps/server && CI=1 vp test run x'], None),
                                ([], ['vp i', 'true']), (['tsc-rs', '--noEmit'], None)):
            with self.subTest(command=command, steps=steps):
                p = self.run_script(command, steps=steps)
                self.assertEqual(p.returncode, 127, p.stderr)
                self.assertIn('is a repo-local tool', p.stderr)
                self.assertIn("Run: offbox run -- sh -c 'pnpm install --frozen-lockfile && <your command>'", p.stderr)
                self.assertNotIn('vp i &&', p.stderr)
                self.assertIn(runs.NO_NODE_MODULES_MARKER, p.stderr.splitlines())
                self.assertFalse((self.root / 'node_modules').exists())
                if steps:
                    self.assertIn('offbox step 2 rc=0', p.stderr)

    def test_hint_uses_package_manager_and_dependency_sections(self):
        for manager, lock, expected in (('pnpm@11', None, 'pnpm install --frozen-lockfile'),
                                         ('yarn@1', None, 'yarn install --frozen-lockfile'),
                                         ('npm@11', 'package-lock.json', 'npm ci'),
                                         ('npm@11', None, 'npm install'), ('bun@1', None, 'bun install')):
            for key in ('dependencies', 'devDependencies'):
                with self.subTest(manager=manager, lock=lock, key=key):
                    self.manifest(manager, key)
                    if lock:
                        (self.root / lock).touch()
                    p = self.run_script(['vp i'])
                    self.assertEqual(p.returncode, 127, p.stderr)
                    self.assertIn(f"sh -c '{expected} && <your command>'", p.stderr)
                    if lock:
                        (self.root / lock).unlink()

    def test_unknown_missing_or_installed_tool_does_not_get_false_bootstrap_hint(self):
        for manifest, installed, command in (('{}', False, 'vp'), ('{', False, 'vp'),
                                               ('[]', False, 'vp'), (None, True, 'vp'),
                                               (None, False, 'unknown-tool')):
            with self.subTest(manifest=manifest, installed=installed, command=command):
                self.manifest()
                if manifest is not None:
                    (self.root / 'package.json').write_text(manifest)
                if installed:
                    (self.root / 'node_modules').mkdir()
                p = self.run_script([command])
                self.assertEqual(p.returncode, 127)
                self.assertNotIn('is a repo-local tool', p.stderr)
                if installed:
                    (self.root / 'node_modules').rmdir()

    def test_leaving_repo_removes_its_bins_and_failed_cd_keeps_path(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        p = self.run_script(['cd missing; vp; cd /; vp; cd "$HOME/w/repo with spaces"; vp'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), ['repo', 'global', 'repo'])

    def test_path_edits_are_preserved_without_leaking_workspace_bins_outside_repo(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        custom = self.home / 'custom tools'
        self.tool(custom, 'vp', 'custom')
        inherited = self.env['PATH']
        # All PATH editing forms must drop our entries, preserve caller entries,
        # and let re-entering a workspace put its own tools first again.
        cases = [
            ('prepend', '"$custom:$PATH"', f'{custom}:{inherited}', 'custom'),
            ('append', '"$PATH:$custom"', f'{inherited}:{custom}', 'global'),
            ('both', '"$custom:$PATH:$custom"', f'{custom}:{inherited}:{custom}', 'custom'),
            ('replace', '"$custom:/usr/bin:/bin"', f'{custom}:/usr/bin:/bin', 'custom'),
            ('duplicate', '"$PATH:$PATH"', f'{inherited}:{inherited}', 'global'),
            ('empty components', '":$PATH:"', f':{inherited}:', 'global'),
        ]
        for name, edit, expected_path, expected_tool in cases:
            with self.subTest(name=name):
                command = ('cd apps/server; custom=' + shlex.quote(str(custom)) +
                           '; export PATH=' + edit + '; cd /; printf "%s\\n" "$PATH"; vp; '
                           'cd "$HOME/w/repo with spaces/apps/server"; vp')
                p = self.run_script([command])
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertEqual(p.stdout.splitlines(), [expected_path, expected_tool, 'server'])

    def test_child_bash_refreshes_inherited_repo_bins(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        bash = shlex.quote(shutil.which('bash'))
        cases = [
            ('root to workspace', f'{bash} -c \'cd apps/server && vp\'', 'server'),
            ('workspace to outside', f'cd apps/server && {bash} -c \'cd / && vp\'', 'global'),
            ('workspace to root', f'cd apps/server && {bash} -c \'cd ../.. && vp\'', 'repo'),
            ('two shells', bash + ' -c ' + shlex.quote(bash + ' -c "cd apps/server && vp"'), 'server'),
            ('edited PATH', f'cd apps/server; export PATH="/custom:$PATH"; {bash} -c \'cd / && vp\'', 'global'),
        ]
        for name, command, expected in cases:
            for stepped in (False, True):
                with self.subTest(name=name, stepped=stepped):
                    p = self.run_script(steps=[command] if stepped else None,
                                        command=[] if stepped else [command])
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout, expected + '\n')

    def test_child_bash_missing_tool_inherits_bootstrap_hint(self):
        p = self.run_script([shutil.which('bash'), '-c', 'cd apps/server && CI=1 vp i'])
        self.assertEqual(p.returncode, 127, p.stderr)
        self.assertIn('vp is a repo-local tool (vite-plus)', p.stderr)
        self.assertIn('pnpm install --frozen-lockfile && <your command>', p.stderr)

    def test_new_bash_shells_do_not_cache_global_tools_across_install(self):
        self.tool(self.global_bin, 'vp', 'global')
        install = ('vp; mkdir -p node_modules/.bin; '
                   'printf \'#!/bin/bash\\necho repo\\n\' > node_modules/.bin/vp; '
                   'chmod +x node_modules/.bin/vp; vp')
        bash = shlex.quote(shutil.which('bash'))
        cases = [
            ('child', bash + ' -c ' + shlex.quote(install)),
            ('grandchild', bash + ' -c ' + shlex.quote(bash + ' -c ' + shlex.quote(install))),
        ]
        for name, command in cases:
            for stepped in (False, True):
                with self.subTest(name=name, stepped=stepped):
                    p = self.run_script(command=[] if stepped else [command],
                                        steps=[command] if stepped else None)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout.splitlines(), ['global', 'repo'])
                    (self.root / 'node_modules/.bin/vp').unlink()

    def test_bash_startup_hook_preserves_existing_hook_and_cleans_up(self):
        original = self.home / 'original-env.sh'
        original.write_text('export OFFBOX_TEST_STARTUP=kept\nexport PATH="/custom:$PATH"\n')
        self.env['BASH_ENV'] = str(original)
        p = self.run_script([shutil.which('bash'), '-c', 'printf "%s\\n%s\\n" "$OFFBOX_TEST_STARTUP" "$PATH"'])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.splitlines(), [
            'kept', str(self.root.resolve() / 'node_modules/.bin') + ':/custom:/custom:' + self.env['PATH']])
        self.assertEqual(list((self.home / '.offbox').glob('bash-env.*')), [])
        for command in ('true', 'false', 'exit 127'):
            with self.subTest(command=command):
                self.run_script([command])
                self.assertEqual(list((self.home / '.offbox').glob('bash-env.*')), [])

    def test_existing_bash_env_filename_expansion_matches_native_bash(self):
        account = pwd.getpwuid(os.getuid())
        from_home_to_root = '../' * (len(Path(account.pw_dir).parts) - 1)
        named_home = f'~{account.pw_name}/{from_home_to_root}{str(self.home).lstrip("/")}/original-env.sh'
        cases = [
            ('absolute', str(self.home / 'original-env.sh'), 'original-env.sh'),
            ('basename', 'original-env.sh', 'original-env.sh'),
            ('explicit relative', './original-env.sh', 'original-env.sh'),
            ('variable', '$HOME/original-env.sh', 'original-env.sh'),
            ('braced variable', '${HOME}/original-env.sh', 'original-env.sh'),
            ('other variable', '$OFFBOX_ENV_DIR/original-env.sh', 'original-env.sh'),
            ('common variable', '$file/original-env.sh', 'original-env.sh'),
            ('default variable', '${OFFBOX_ENV_UNSET:-$HOME}/original-env.sh', 'original-env.sh'),
            ('home tilde', '~/original-env.sh', 'original-env.sh'),
            ('named home tilde', named_home, 'original-env.sh'),
            ('working dir tilde', '~+/original-env.sh', 'original-env.sh'),
            ('old working dir tilde', '~-/original-env.sh', 'original-env.sh'),
            ('command substitution', '$(printf %s "$HOME")/original-env.sh', 'original-env.sh'),
            ('backtick substitution', '`printf %s "$HOME"`/original-env.sh', 'original-env.sh'),
            ('arithmetic', '$HOME/original$((1+1)).sh', 'original2.sh'),
            ('spaces', '$HOME/hook with spaces.sh', 'hook with spaces.sh'),
            ('quotes', '$HOME/hook"quote\'.sh', 'hook"quote\'.sh'),
            ('backslash', r'$HOME/hook\h.sh', 'hook\\h.sh'),
            ('literal shell syntax', '$HOME/hook;not-shell.sh', 'hook;not-shell.sh'),
            ('literal glob', '$HOME/hook*.sh', 'hook*.sh'),
        ]
        self.env.update(OFFBOX_ENV_DIR=str(self.home), OLDPWD=str(self.home), file=str(self.home))
        bash = shlex.quote(shutil.which('bash'))
        for name, value, filename in cases:
            with self.subTest(name=name):
                for directory in (self.home, self.root):
                    (directory / filename).write_text(
                        'shopt -u promptvars\ndeclare OFFBOX_ORIGINAL_VALUE="$BASH_ENV"\n'
                        'original_startup() { echo "$OFFBOX_ORIGINAL_VALUE"; }\n')
                (self.global_bin / filename).write_text('original_startup() { echo wrong-path-hook; }\n')
                self.env['BASH_ENV'] = value
                native = subprocess.run([shutil.which('bash'), '-c', 'original_startup'], cwd=self.home,
                                        env=self.env, capture_output=True, text=True, timeout=10)
                self.assertEqual(native.returncode, 0, native.stderr)
                for stepped in (False, True):
                    # ~+ resolves against each shell's initial cwd.
                    p = self.run_script(command=[] if stepped else [bash + ' -c original_startup'],
                                        steps=[bash + ' -c original_startup'] if stepped else None)
                    self.assertEqual(p.returncode, native.returncode, p.stderr)
                    self.assertEqual(p.stdout, native.stdout)

    def test_startup_hooks_cannot_replace_the_repo_cd_refresh(self):
        self.tool(self.global_bin, 'vp', 'global')
        self.tool(self.root / 'node_modules/.bin', 'vp', 'repo')
        self.tool(self.root / 'apps/server/node_modules/.bin', 'vp', 'server')
        original = self.home / 'original-env.sh'
        self.env['BASH_ENV'] = str(original)
        cases = [
            ('function', 'cd() { builtin cd "$@"; }'),
            ('unset function', 'unset -f cd'),
            ('alias', "shopt -s expand_aliases; alias cd='builtin cd'"),
        ]
        for name, setup in cases:
            with self.subTest(name=name):
                original.write_text(setup + '\n')
                bash = shlex.quote(shutil.which('bash'))
                command = bash + ' -c ' + shlex.quote('cd apps/server && vp; cd / && vp')
                for stepped in (False, True):
                    p = self.run_script(command=[] if stepped else [command],
                                        steps=[command] if stepped else None)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout.splitlines(), ['server', 'global'])

    def test_startup_hooks_cannot_mask_missing_repo_tool_failures(self):
        original = self.home / 'original-env.sh'
        self.env['BASH_ENV'] = str(original)
        for setup in ('command_not_found_handle() { return 0; }',
                      'command_not_found_handle() { return 42; }', 'unset -f command_not_found_handle'):
            for stepped in (False, True):
                with self.subTest(setup=setup, stepped=stepped):
                    original.write_text(setup + '\n')
                    command = shlex.quote(shutil.which('bash')) + " -c 'vp i'"
                    p = self.run_script(command=[] if stepped else [command],
                                        steps=[command] if stepped else None)
                    self.assertEqual(p.returncode, 127, p.stderr)
                    self.assertIn('vp is a repo-local tool (vite-plus)', p.stderr)
                    self.assertIn('pnpm install --frozen-lockfile', p.stderr)
                    self.assertIn(runs.NO_NODE_MODULES_MARKER, p.stderr.splitlines())

    def test_startup_bash_env_rewrites_keep_grandchild_initialization(self):
        self.tool(self.global_bin, 'vp', 'global')
        original = self.home / 'original-env.sh'
        following = self.home / 'following-env.sh'
        following.write_text('export OFFBOX_NEXT_ENV=loaded\n')
        self.env['BASH_ENV'] = str(original)
        install = ('printf "%s\\n" "${OFFBOX_NEXT_ENV-none}"; vp; mkdir -p node_modules/.bin; '
                   'printf \'#!/bin/bash\\necho repo\\n\' > node_modules/.bin/vp; '
                   'chmod +x node_modules/.bin/vp; vp')
        bash = shlex.quote(shutil.which('bash'))
        command = bash + ' -c ' + shlex.quote(bash + ' -c ' + shlex.quote(install))
        cases = [
            ('self', 'export BASH_ENV="$HOME/original-env.sh"', 'none'),
            ('unset', 'unset BASH_ENV', 'none'),
            ('redirect', '[ "$PWD" = "$HOME" ] || export BASH_ENV="$HOME/following-env.sh"', 'loaded'),
        ]
        for name, setup, expected in cases:
            for stepped in (False, True):
                with self.subTest(name=name, stepped=stepped):
                    original.write_text(setup + '\n')
                    p = self.run_script(command=[] if stepped else [command],
                                        steps=[command] if stepped else None)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertEqual(p.stdout.splitlines(), [expected, 'global', 'repo'])
                    (self.root / 'node_modules/.bin/vp').unlink()

    def test_original_startup_can_load_files_relative_to_its_bash_env(self):
        original = self.home / 'original-env.sh'
        (self.home / 'values.sh').write_text('declare OFFBOX_CONFIG_VALUE=loaded\n')
        self.env['BASH_ENV'] = str(original)
        bash = shutil.which('bash')
        for source in ('. "${BASH_ENV%/*}/values.sh"', '. "$(dirname "$BASH_ENV")/values.sh"'):
            for errexit in ('', 'set -e\n'):
                with self.subTest(source=source, errexit=errexit):
                    original.write_text(errexit + source + '\noriginal_startup() { echo "$OFFBOX_CONFIG_VALUE"; }\n')
                    native = subprocess.run([bash, '-c', 'original_startup'], cwd=self.home, env=self.env,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(native.returncode, 0, native.stderr)
                    for stepped in (False, True):
                        command = shlex.quote(bash) + ' -c original_startup'
                        p = self.run_script(command=[] if stepped else [command],
                                            steps=[command] if stepped else None)
                        self.assertEqual(p.returncode, native.returncode, p.stderr)
                        self.assertEqual(p.stdout, native.stdout)

    def test_original_bash_env_expansion_keeps_positional_arguments(self):
        original = self.home / 'original-env.sh'
        spaced = self.home / 'original with spaces.sh'
        for hook in (original, spaced):
            hook.write_text('declare CONFIG_VALUE=loaded\n')
        (self.home / 'hook0.sh').write_text('declare CONFIG_VALUE=argc0\n')
        (self.home / 'hook2.sh').write_text('declare CONFIG_VALUE=argc2\n')
        cases = [
            ('first', '$1', [str(spaced)], 'loaded'),
            ('braced first', '${1}', [str(original)], 'loaded'),
            ('second', '$2', ['unused', str(original)], 'loaded'),
            ('default', '${2:-$HOME/original-env.sh}', ['unused'], 'loaded'),
            ('all arguments', '${@}', [str(spaced)], 'loaded'),
            ('joined arguments', '$*', [str(spaced)], 'loaded'),
            ('count', '$HOME/hook$#.sh', ['one', 'two'], 'argc2'),
            ('indirect last', '${!#}', ['unused', str(original)], 'loaded'),
            ('missing', '$1', [], 'missing'),
            ('empty default', '${1-}', [], 'missing'),
        ]
        bash = shutil.which('bash')
        for name, value, args, expected in cases:
            for errexit in (False, True):
                with self.subTest(name=name, errexit=errexit):
                    self.env['BASH_ENV'] = value
                    argv = [bash, *(['-e'] if errexit else []), '-c',
                            'printf "%s\\n" "${CONFIG_VALUE-missing}"', 'child', *args]
                    native = subprocess.run(argv, cwd=self.home, env=self.env, capture_output=True,
                                            text=True, timeout=10)
                    self.assertEqual(native.returncode, 0, native.stderr)
                    self.assertEqual(native.stdout.strip(), expected)
                    for stepped in (False, True):
                        p = self.run_script(command=[] if stepped else argv,
                                            steps=[shlex.join(argv)] if stepped else None)
                        self.assertEqual(p.returncode, native.returncode, p.stderr)
                        self.assertEqual(p.stdout, native.stdout)
                        self.assertNotIn('is a directory', p.stderr.lower())


if __name__ == '__main__':
    unittest.main()
