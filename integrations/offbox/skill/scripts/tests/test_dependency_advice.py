"""Execute generated Bash to distinguish command failures from missing JS dependencies."""
import contextlib
import io
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import command_usage, misc, runs


class DependencyAdviceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.root = self.home / 'w/repo'
        self.root.mkdir(parents=True)
        self.manifest(self.root)
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        for tool in ('vp', 'bun', 'pnpm', 'npm', 'npx', 'python3', 'go'):
            self.tool(tool, 'echo REAL_FAILURE >&2; exit 2')
        self.tool('corepack', 'tool=${1%%@*}; shift; exec "$tool" "$@"')
        self.tool('python3', 'echo "/usr/bin/python3: No module named pytest" >&2; exit 1')
        self.tool('node', 'echo v24.22.1; echo ERR_MODULE_NOT_FOUND >&2; exit 1')
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/x.sh').write_text('echo SHELL_FAILURE >&2; exit 1')

    def manifest(self, folder, content=None):
        (folder / 'package.json').write_text(json.dumps(content if content is not None else {'devDependencies': {'x': '1'}}))

    def tool(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/bash\n' + body + '\n')
        path.chmod(0o755)

    def run_command(self, cmd='', *, rel='.', steps=None, setup=':'):
        with patch.object(runs, 'GO_REPAIR', setup), patch.object(runs, 'DOCKER_REPAIR', ':'), \
             patch.object(runs, 'LDCACHE_REPAIR', ':'), patch.object(runs, 'WATCH_REPAIR', ':'), \
             patch.object(runs.userns, 'setup', return_value=':'), \
             patch.object(runs.containers, 'script', return_value=':'), \
             patch.object(runs.node_tools, 'block', return_value=':'):
            script = runs.remote_script('w/repo', rel, [cmd], None, 'test', steps=steps, repo_root=self.root)
        env = dict(os.environ, HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin')
        result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True, timeout=10)
        log = self.home / 'run.log'
        log.write_text(result.stdout + result.stderr)
        return result, runs.box_deps_hint(self.root, log)

    def assert_advice(self, result, hint, *, marker=False, install=''):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(runs.NO_NODE_MODULES_MARKER in result.stderr, marker, result.stderr)
        self.assertEqual(bool(hint), marker, hint)
        if install:
            self.assertIn(f"offbox: command exited {result.returncode} and node_modules is still missing; its own install step ({install}) didn't run or didn't finish. The failing line is above.", result.stderr)
        else:
            self.assertNotIn('its own install step', result.stderr)

    def test_setup_failure_never_suggests_js_install(self):
        result, hint = self.run_command('vp test run x.test.ts', setup='echo offbox-setup-failed >&2; exit 97')
        self.assertEqual(result.returncode, 97)
        self.assertNotIn(runs.COMMAND_STARTED_MARKER, result.stderr)
        self.assert_advice(result, hint)

    def test_real_js_failures_keep_marker_and_client_hint(self):
        for cmd in ('vp test run x.test.ts', 'node_modules/.bin/vitest run'):
            with self.subTest(cmd=cmd):
                result, hint = self.run_command(cmd)
                self.assert_advice(result, hint, marker=True)
                self.assertIn('Install deps and run the command in the same call', hint)

    def test_non_js_failures_keep_real_error_without_hint(self):
        for cmd in ('COMMERCE_CARD_LAST4=2342 PYTHONPATH=a:b python3 -m unittest mod',
                    'python3 -m pytest -q a_test.py b_test.py', 'bash scripts/x.sh', 'go test ./pkg',
                    'uv run --with pytest python -m pytest x', 'python3 -m unittest test.a'):
            with self.subTest(cmd=cmd):
                result, hint = self.run_command(cmd)
                self.assert_advice(result, hint)
                self.assertIn(runs.COMMAND_STARTED_MARKER, result.stderr)

    def test_non_js_failure_comments_and_redirections_keep_real_error(self):
        for command in ('python3 -m unittest discover -s x/tests -v', 'go test ./pkg', 'bash scripts/x.sh'):
            for suffix in (' # check', ' >output.log', ' 2>errors.log', ' 2>&1'):
                with self.subTest(command=command, suffix=suffix):
                    self.assert_advice(*self.run_command(command + suffix))

    def test_comment_and_redirection_edges_keep_non_js_advice_and_go_fence(self):
        self.tool('timeout', 'shift; exec "$@"')
        for command in ('timeout 30 >output.log python3 -m pytest',
                        'timeout 30 2>errors.log python3 -m pytest',
                        'python3 -m pytest # $(echo ignored)',
                        'python3 -m pytest # `echo ignored`'):
            with self.subTest(command=command):
                result, hint = self.run_command(command)
                self.assertEqual(result.returncode, 1)
                self.assert_advice(result, hint)
        setup = 'if [ "$_offbox_needs_go" = 1 ]; then echo offbox-setup-failed >&2; exit 97; fi'
        result, hint = self.run_command('python3 check.py https://example.test/#section; go test ./pkg', setup=setup)
        self.assertEqual(result.returncode, 97)
        self.assertNotIn(runs.COMMAND_STARTED_MARKER, result.stderr)
        self.assert_advice(result, hint)

    def test_nested_comment_and_non_bash_whitespace_repair_decisions(self):
        setup = 'if [ "$_offbox_needs_go" = 1 ]; then echo offbox-setup-failed >&2; exit 97; fi'
        for comment in ('$(echo ignored)', '`echo ignored`'):
            result, hint = self.run_command(f"bash -c 'python3 -m pytest # {comment}'", setup=setup)
            self.assertEqual(result.returncode, 1)
            self.assertIn(runs.COMMAND_STARTED_MARKER, result.stderr)
            self.assert_advice(result, hint)
        for separator in ('\u00a0', '\v', '\f', '\r', '\u2003'):
            with self.subTest(separator=repr(separator)):
                result, hint = self.run_command(f'echo word{separator}#suffix; go version', setup=setup)
                self.assertEqual(result.returncode, 97)
                self.assertNotIn(runs.COMMAND_STARTED_MARKER, result.stderr)
                self.assert_advice(result, hint)
        for command in ('bash -c "python3 -m pytest # $(go version)"',
                        'bash -c "python3 -m pytest # `go version`"'):
            result, hint = self.run_command(command, setup=setup)
            self.assertEqual(result.returncode, 97)
            self.assertNotIn(runs.COMMAND_STARTED_MARKER, result.stderr)
            self.assert_advice(result, hint)

    def test_subpackage_and_leading_cd_use_own_node_modules(self):
        sub = self.root / 'pkg'
        sub.mkdir()
        self.manifest(sub)
        self.tool('bun', '[ "$1" != install ] || exit 0; echo TYPE_ERROR >&2; exit 2')
        for rel, prefix in (('pkg', ''), ('.', 'cd pkg && '), ('.', 'cd -P pkg && '),
                            ('.', 'cd -L pkg && '), ('.', 'cd pkg\n'), ('.', 'bash -c "cd pkg && ')):
            for installed in (True, False):
                for install in (True, False):
                    with self.subTest(rel=rel, prefix=prefix, installed=installed, install=install):
                        modules = sub / 'node_modules'
                        if installed:
                            modules.mkdir(exist_ok=True)
                        elif modules.exists():
                            modules.rmdir()
                        cmd = prefix + ('bun install --frozen-lockfile && ' if install else '') + 'bun test x.test.ts'
                        if prefix.startswith('bash'):
                            cmd += '"'
                        result, hint = self.run_command(cmd, rel=rel)
                        self.assertEqual(result.returncode, 2)
                        self.assert_advice(result, hint, marker=not installed and not install,
                                           install='bun install' if not installed and install else '')

    def test_root_modules_also_suppress_subpackage_hint(self):
        sub = self.root / 'pkg'
        sub.mkdir()
        self.manifest(sub)
        (self.root / 'node_modules').mkdir()
        self.assert_advice(*self.run_command('cd pkg && bun test x'))

    def test_npm_directory_flags_after_subcommand_use_subpackage(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub)
        commands = ('npm test --prefix sub', 'npm run test --prefix=sub',
                    'npm --silent run test --prefix sub')
        for installed in (True, False):
            modules = sub / 'node_modules'
            if installed:
                modules.mkdir()
            else:
                modules.rmdir()
            for command in commands:
                with self.subTest(command=command, installed=installed):
                    self.assert_advice(*self.run_command(command), marker=not installed)

    def test_manager_directory_options_use_subpackage_dependencies(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub)
        self.tool('yarn', 'exit 2')
        forms = ('pnpm --dir sub', 'pnpm --dir=sub', 'pnpm -C sub', 'pnpm -Csub',
                 'yarn --cwd sub', 'bun --cwd sub', 'npm --prefix sub')
        for prefix in forms:
            for installed in (True, False):
                with self.subTest(prefix=prefix, installed=installed):
                    modules = sub / 'node_modules'
                    if installed:
                        modules.mkdir(exist_ok=True)
                    elif modules.exists():
                        modules.rmdir()
                    self.assert_advice(*self.run_command(prefix + ' test'), marker=not installed)
        self.manifest(sub, {})
        for prefix in forms:
            self.assert_advice(*self.run_command(prefix + ' test'))

    def test_own_install_covers_guard_failure_install_failure_and_steps(self):
        self.tool('node', 'echo v24.22.1')
        cases = [
            ('node -v && test "$(node -v)" = v0.0.0 && npm ci && npx jest x', None, 'npm ci'),
            ('pnpm install --frozen-lockfile && vp test run x.test.ts', None, 'pnpm install'),
            ('node -v\nnpm ci\nnpx jest x', None, 'npm ci'),
            ('false;\npnpm i', None, 'pnpm i'),
            ('npm --ignore-scripts ci && npx jest x', None, 'npm ci'),
            ('pnpm --filter @app/web install && pnpm test', None, 'pnpm install'),
            ('corepack pnpm@11.7.0 install && vp test run x', None, 'pnpm install'),
            ('', ['npm ci', 'npx jest x'], 'npm ci'),
            ('false; corepack npm ci', None, 'npm ci'),
            ('false || bun i', None, 'bun i'),
        ]
        for cmd, steps, install in cases:
            with self.subTest(cmd=cmd, steps=steps):
                result, hint = self.run_command(cmd, steps=steps)
                self.assert_advice(result, hint, install=install)
                if 'corepack' in cmd:
                    self.assertIn('REAL_FAILURE', result.stderr)

    def test_zero_dependency_packages_get_neither_hint(self):
        fields = ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')
        for manifest in ({}, {field: {} for field in fields}, {'devDependencies': {'x': '1'}}):
            with self.subTest(manifest=manifest):
                self.manifest(self.root, manifest)
                result, hint = self.run_command('node --test x.test.mjs')
                self.assert_advice(result, hint, marker=bool(manifest.get('devDependencies')))
                usage = command_usage.inspect(self.root, '.', ['node --test x.test.mjs'])
                out = io.StringIO()
                with contextlib.redirect_stderr(out):
                    runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
                self.assertEqual('node_modules missing on new box' in out.getvalue(), bool(manifest.get('devDependencies')))

    def test_new_box_advice_requires_js_deps_without_own_install(self):
        for cmd, expected in (('python3 -m pytest x', False), ('bash scripts/x.sh', False),
                              ('go test ./pkg', False), ('npm ci && npx jest x', False), ('vp test x', True)):
            with self.subTest(cmd=cmd):
                out = io.StringIO()
                usage = command_usage.inspect(self.root, '.', [cmd])
                with contextlib.redirect_stderr(out):
                    runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
                self.assertEqual(bool(out.getvalue()), expected)

    def test_subpackage_install_advice_preserves_callers_directory(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(self.root, {})
        self.manifest(sub)
        (sub / 'package-lock.json').touch()
        for rel, command, install in (
            ('.', 'cd sub && npm test', '(cd sub && npm ci)'),
            ('sub', 'npm test', 'npm ci'),
        ):
            with self.subTest(rel=rel):
                result, hint = self.run_command(command, rel=rel)
                self.assert_advice(result, hint, marker=True)
                self.assertIn(install + ' && <command>', hint)
                usage = command_usage.inspect(self.root, rel, [command])
                output = io.StringIO()
                with contextlib.redirect_stderr(output):
                    runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
                self.assertIn('with ' + install + ' &&', output.getvalue())

    def test_workspace_advice_keeps_root_package_manager(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub)
        (self.root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
        (self.root / 'pnpm-workspace.yaml').write_text('packages: [sub]')
        result, hint = self.run_command('bun test x', rel='sub')
        self.assert_advice(result, hint, marker=True)
        self.assertIn('(cd .. && corepack pnpm@10 install --frozen-lockfile) && <command>', hint)

    def test_env_prefixed_python_finished_wait_shows_real_failure(self):
        self.tool('python3', 'echo "ModuleNotFoundError: No module named keychain" >&2; echo "FAILED (errors=2)" >&2; exit 1')
        command = 'COMMERCE_CARD_LAST4=2342 PYTHONPATH=a:b:c python3 -m unittest mod'
        result, hint = self.run_command(command)
        self.assert_advice(result, hint)
        row = dict(run_id='run', mode='bg', box_id='B', repo_root=str(self.root), pulls='[]',
                   exit_code=1, status='failed', error=None)
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(misc, 'LOGS_DIR', self.home), patch.object(misc, '_run_row', return_value=row), \
             patch.object(misc, '_require_my_run'), patch.object(misc, '_catch_up_log'), \
             patch.object(misc, '_incomplete_log'), contextlib.redirect_stdout(output), \
             contextlib.redirect_stderr(errors):
            self.assertEqual(misc.wait('run', 50), 1)
        self.assertIn('ModuleNotFoundError: No module named keychain', output.getvalue())
        self.assertIn('FAILED (errors=2)', output.getvalue())
        self.assertIn('exit=1', output.getvalue())
        self.assertNotIn('install', errors.getvalue())

    def test_finished_failure_wait_bounds_replay_and_success_stays_quiet(self):
        log = self.home / 'run.log'
        log.write_text('earlier-noise' * 4000 + '\nModuleNotFoundError: keychain\n')
        row = dict(run_id='run', mode='bg', box_id='B', repo_root=str(self.root), pulls='[]',
                   exit_code=1, status='failed', error=None)
        for code in (0, 1):
            with self.subTest(code=code):
                row['exit_code'] = code
                output = io.StringIO()
                with patch.object(misc, 'LOGS_DIR', self.home), patch.object(misc, '_run_row', return_value=row), \
                     patch.object(misc, '_require_my_run'), patch.object(misc, '_catch_up_log'), \
                     patch.object(misc, '_incomplete_log'), contextlib.redirect_stdout(output):
                    self.assertEqual(misc.wait('run', 50), code)
                self.assertEqual('ModuleNotFoundError' in output.getvalue(), code == 1)
                self.assertLess(len(output.getvalue()), 16500)

    def assert_python_background_failure(self, command, body, failure):
        self.tool('python3', body)
        result, hint = self.run_command(command)
        self.assertEqual(result.returncode, 1)
        self.assert_advice(result, hint)
        row = dict(run_id='run', mode='bg', box_id='B', repo_root=str(self.root), pulls='[]',
                   exit_code=1, status='failed', error=None)
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(misc, 'LOGS_DIR', self.home), patch.object(misc, '_run_row', return_value=row), \
             patch.object(misc, '_require_my_run'), patch.object(misc, '_catch_up_log', return_value='complete'), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            self.assertEqual(misc.wait('run', 50), 1)
        text = output.getvalue() + errors.getvalue()
        self.assertIn(failure, text)
        self.assertNotIn(runs.NO_NODE_MODULES_MARKER, text)
        self.assertNotIn('pnpm install', text)
        self.assertNotIn('Install deps', text)

    def test_agent_tools_65_background_unittest_failure(self):
        self.assert_python_background_failure(
            'python3 -m unittest discover -s x/tests -v',
            'echo "Ran 225 tests in 41.975s" >&2; echo "FAILED (failures=153)" >&2; exit 1',
            'FAILED (failures=153)')

    def test_mac_upkeep_12_background_venv_pytest_failure(self):
        self.assert_python_background_failure(
            'python3 -m venv .venv && .venv/bin/pip install pytest && .venv/bin/python -m pytest x/tests',
            '''mkdir -p .venv/bin
printf '#!/bin/bash\\nexit 0\\n' > .venv/bin/pip
printf '#!/bin/bash\\necho "20 failed, 3 passed, 1 subtests passed in 0.10s"\\nexit 1\\n' > .venv/bin/python
chmod +x .venv/bin/pip .venv/bin/python''',
            '20 failed, 3 passed')

    def test_active_settlement_keeps_quiet_wait_and_resumes_follow_without_replay(self):
        log = self.home / 'run.log'
        prefix, failure = 'already followed\n', 'ModuleNotFoundError: keychain\n'
        log.write_text(prefix + failure)
        row = dict(run_id='run', mode='bg', box_id='B', repo_root=str(self.root), pulls='[]',
                   exit_code=1, status='failed', error=None)
        for echo, pos, expected in ((False, 0, ''), (False, len(prefix), ''),
                                    (True, len(prefix), failure), (True, log.stat().st_size, '')):
            with self.subTest(echo=echo, pos=pos):
                output = io.StringIO()
                with patch.object(misc, 'LOGS_DIR', self.home), \
                     patch.object(misc, '_catch_up_log', return_value='complete'), \
                     contextlib.redirect_stdout(output):
                    self.assertEqual(misc._settled(row, echo=echo, pos=pos), 1)
                self.assertEqual(output.getvalue(), expected + 'run: failed exit=1\n')

    def test_zero_dependency_subpackage_with_comment_gets_no_hint(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub, {})
        command = 'cd sub && node --test x.test.mjs # check'
        self.assert_advice(*self.run_command(command))
        output = io.StringIO()
        usage = command_usage.inspect(self.root, '.', [command])
        with contextlib.redirect_stderr(output):
            runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
        self.assertEqual(output.getvalue(), '')

    def test_uv_directory_zero_dependency_package_has_no_advice(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub, {})
        self.tool('uv', 'echo ERR_MODULE_NOT_FOUND >&2; exit 1')
        command = 'uv run --directory sub --no-project --offline node --test x.test.mjs'
        self.assert_advice(*self.run_command(command))
        output = io.StringIO()
        usage = command_usage.inspect(self.root, '.', [command])
        with contextlib.redirect_stderr(output):
            runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
        self.assertEqual(output.getvalue(), '')

    def test_subpackage_hint_is_copyable_with_spaces(self):
        sub = self.root / 'sub dir'
        sub.mkdir()
        self.manifest(self.root, {})
        self.manifest(sub)
        (sub / 'package-lock.json').touch()
        result, hint = self.run_command("cd 'sub dir' && npm test")
        self.assert_advice(result, hint, marker=True)
        example = hint.split('offbox run -- ', 1)[1].split('; offbox save', 1)[0]
        self.assertEqual(shlex.split(example), ["(cd 'sub dir' && npm ci) && <command>"])

    def test_workspace_hints_use_shared_pins_and_ci_deferral(self):
        sub = self.root / 'sub'
        sub.mkdir()
        self.manifest(sub)
        (self.root / 'pnpm-workspace.yaml').write_text('packages: [sub]')
        (self.root / 'pnpm-lock.yaml').touch()
        self.manifest(self.root, {'packageManager': 'pnpm@11.7.0', 'engines': {'node': '>=22'},
                                  'devDependencies': {'x': '1'}})
        workflows = self.root / '.github/workflows'
        workflows.mkdir(parents=True)
        (workflows / 'ci.yml').write_text("steps:\n  - uses: pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n")
        for pinned in (True, False):
            with self.subTest(pinned=pinned):
                if not pinned:
                    self.manifest(self.root, {'engines': {'node': '>=22'}, 'devDependencies': {'x': '1'}})
                result, hint = self.run_command('bun test x', rel='sub')
                self.assert_advice(result, hint, marker=True)
                self.assertIn('Use Node matching package.json engines', hint)
                output = io.StringIO()
                usage = command_usage.inspect(self.root, 'sub', ['bun test x'])
                with contextlib.redirect_stderr(output):
                    runs.new_checkout_hint({'box_id': 'B', '_new_checkout': True}, self.root, usage)
                for advice in (hint, output.getvalue()):
                    if pinned:
                        self.assertIn('(cd .. && corepack pnpm@11.7.0 install --frozen-lockfile)', advice)
                        self.assertNotIn('CI pnpm version is ambiguous', advice)
                    else:
                        self.assertIn('(cd .. && <repo-install>)', advice)
                        self.assertIn('CI pnpm version is ambiguous', advice)
                        self.assertNotIn('corepack pnpm', advice)
