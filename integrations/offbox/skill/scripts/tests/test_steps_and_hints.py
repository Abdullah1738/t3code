"""Offline tests: --step runs, step summary, trailing-grep hint, box setup failure (exit 97) mapped to infra 90."""
import contextlib
import io
import json
import os
import shlex
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests._env import clean_env
from offbox_lib import cli, lease, misc, runs  # noqa: E402
from offbox_lib.common import EXIT_INFRA, OffboxError  # noqa: E402
from offbox_lib.runs import GO_STD_GLITCH  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from tests.test_command_usage import REPORTER_ARGVS


class GoStdGlitchMatcherTests(unittest.TestCase):

    def test_go_std_glitch_matcher(self):
        for line in ('internal/abi/abi.go:9:2: package unsafe is not in std (/usr/local/go/src/unsafe)',
                     'package internal/fmtsort is not in std (/usr/local/go/src/internal/fmtsort)',
                     'build constraints exclude all Go files in /usr/local/go/src/internal/syscall/execenv'):
            with self.subTest(line=line):
                self.assertIsNotNone(GO_STD_GLITCH.search(line))
        for line in ('package risk-liquidation/internal/x is not in std '
                     '(/usr/local/go/src/risk-liquidation/internal/x)', 'FAIL TestX'):
            with self.subTest(line=line):
                self.assertIsNone(GO_STD_GLITCH.search(line))


def fake_start(self):
    self.box, self.pid, self.started = 'bx_fake', 7, True
    return {'box_id': 'bx_fake'}


class StepScriptTests(unittest.TestCase):

    def run_steps(self, steps):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / 'w/repo/sub').mkdir(parents=True)
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs.userns, 'setup', return_value=':'):
                script = runs.remote_script('w/repo', 'sub', [], None, 'run-test', steps=steps)
            env = {'HOME': home, 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
            p = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            return p.returncode, p.stdout, p.stderr

    def test_script_has_one_marker_per_step_and_pipefail(self):
        with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs.userns, 'setup', return_value=':'):
            script = runs.remote_script('w/repo', '.', [], None, 'r', steps=['true', 'false | cat'])
        self.assertEqual(script.count('offbox step '), 2)
        self.assertEqual(script.count('set -o pipefail'), 2)

    def test_all_pass_exits_zero_and_reports_each_step(self):
        rc, _, err = self.run_steps(['true', 'echo hi'])
        self.assertEqual(rc, 0)
        self.assertIn('offbox step 1 rc=0: true', err)
        self.assertIn('offbox step 2 rc=0: echo hi', err)

    def test_keeps_going_and_returns_first_nonzero(self):
        rc, out, err = self.run_steps(['false', 'echo second', 'exit 4'])
        self.assertEqual(rc, 1)
        self.assertIn('offbox step 1 rc=1: false', err)
        self.assertIn('offbox step 2 rc=0: echo second', err)
        self.assertIn('offbox step 3 rc=4: exit 4', err)
        self.assertIn('second', out)

    def test_pipe_failure_inside_step_counts(self):
        rc, _, err = self.run_steps(['false | cat', 'true'])
        self.assertEqual(rc, 1)
        self.assertIn('offbox step 1 rc=1', err)

    def test_step_cannot_exit_the_wrapper_early(self):
        rc, _, err = self.run_steps(['exit 2', 'echo still-running'])
        self.assertEqual(rc, 2)
        self.assertIn('offbox step 2 rc=0', err)

    def test_step_killing_its_shell_cannot_pass(self):
        for sig in ('TERM', 'KILL'):
            with self.subTest(sig=sig):
                p = subprocess.run(['bash', '-c', runs.steps_block([
                    f"bash -c 'kill -{sig} \"$PPID\"'", 'echo should-not-run'])],
                    capture_output=True, text=True, timeout=5)
                self.assertNotEqual(p.returncode, 0)
                self.assertNotIn('offbox step 2 rc=', p.stderr)

    def test_failed_result_write_cannot_pass(self):
        p = subprocess.run(['bash', '-c', 'exec 2>&-; ' + runs.steps_block(['true'])],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
        self.assertNotEqual(p.returncode, 0)


def with_dependencies(text):
    manifest = json.loads(text)
    manifest.setdefault('devDependencies', {})['fixture'] = '1'
    return json.dumps(manifest)


class MissingDepsTests(unittest.TestCase):

    def test_non_js_reporters_do_not_get_either_hint(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'package.json').write_text('{"dependencies":{"vitest":"1"}}')
            for argv in REPORTER_ARGVS:
                with self.subTest(argv=argv), patch.object(runs.api, 'BACKEND', 'boat'):
                    usage = runs.command_usage.inspect(root, '.', argv)
                    script = runs.remote_script('w/repo', '.', argv, None, 'r', repo_root=root, usage=usage)
                    trap = next(line for line in script.splitlines() if line.startswith('trap '))
                    self.assertIn('[ 0 = 1 ]', trap)
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root, usage)
                    self.assertEqual(err.getvalue(), '')
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                       runs.command_usage.inspect(root, '.', ['npm', 'test']))
            self.assertIn('node_modules missing on new box B', err.getvalue())

    def test_exit_127_tail_keeps_failure_and_never_advises_install(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home) / 'w/repo'
            root.mkdir(parents=True)
            (root / 'package.json').write_text('{"dependencies":{"vitest":"1"}}')
            with patch.object(runs.api, 'BACKEND', 'boat'):
                script = runs.remote_script('w/repo', '.', ['npm', 'test'], None, 'r', repo_root=root)
            trap = next(line for line in script.splitlines() if line.startswith('trap '))
            self.assertIn('[ 1 = 1 ]', trap)
            for output in ('rg: command not found', 'bash: line 1: vitest: command not found', ''):
                with self.subTest(output=output):
                    tail = ('__obprobe() { :; }; __obsw=; __offbox_command_started=1; ' + trap + '\n'
                            + 'printf "%s\\n" ' + shlex.quote(output) + ' >&2; exit 127')
                    p = subprocess.run(['bash', '-c', tail], env=clean_env(HOME=home),
                                       capture_output=True, text=True, timeout=10)
                    self.assertEqual(p.returncode, 127)
                    self.assertEqual(p.stderr.count('offbox: exit 127:'), 1)
                    self.assertIn(output, p.stderr)
                    self.assertNotIn(runs.NO_NODE_MODULES_MARKER, p.stderr)
                    self.assertNotIn('install', p.stderr)

    def test_install_selection(self):
        cases = [
            ({'pnpm-lock.yaml'}, 'pnpm@11.7.0', 'corepack pnpm@11.7.0 install --frozen-lockfile'),
            ({'yarn.lock'}, 'pnpm@10.18.0', 'corepack pnpm@10.18.0 install --frozen-lockfile'),
            ({'pnpm-lock.yaml'}, 'yarn@1.22.22', 'corepack yarn@1.22.22 install --frozen-lockfile'),
            ({'pnpm-lock.yaml'}, 'yarn@4.9.2', 'corepack yarn@4.9.2 install --immutable'),
            ({'pnpm-lock.yaml'}, 'bun@1.3.0', 'bun install --frozen-lockfile'),
            ({'pnpm-lock.yaml', 'package-lock.json'}, 'npm@11.0.0', 'npm ci'),
            ({'pnpm-lock.yaml'}, 'npm@11.0.0', 'npm ci'),
            ({'pnpm-lock.yaml', 'bun.lock', 'yarn.lock', 'package-lock.json'}, None, 'corepack pnpm@10 install --frozen-lockfile'),
            ({'bun.lock', 'yarn.lock', 'package-lock.json'}, None, 'corepack yarn install --frozen-lockfile'),
            ({'bun.lockb'}, None, 'bun install --frozen-lockfile'),
            ({'bun.lock'}, None, 'bun install --frozen-lockfile'),
            ({'yarn.lock', 'package-lock.json'}, None, 'corepack yarn install --frozen-lockfile'),
            ({'package-lock.json'}, None, 'npm ci'),
            ({'npm-shrinkwrap.json'}, None, 'npm ci'),
            (set(), None, 'npm install'),
            ({'pnpm-lock.yaml'}, 'unknown@1', 'corepack pnpm@10 install --frozen-lockfile'),
            ({'package-lock.json'}, '', 'npm ci'),
        ]
        for files, manager, install in cases:
            with self.subTest(files=files, manager=manager), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'package.json').write_text(with_dependencies(json.dumps({'packageManager': manager})))
                for name in files:
                    (root / name).write_text("lockfileVersion: '9.0'\n" if name == 'pnpm-lock.yaml' else '')
                hint = runs.missing_deps_hint(root)
                self.assertIn(f"offbox run -- '{install} && <command>'", hint)
                self.assertIn('offbox save --default', hint)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(f'with {install} &&', err.getvalue())

    def test_package_manager_pin_suffixes_keep_precedence(self):
        for suffix in ('', '-rc.53', '+sha224.abcdef', '-rc.53+sha224.abcdef'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                pin = 'yarn@4.0.0' + suffix
                (root / 'package.json').write_text(with_dependencies(json.dumps({'packageManager': pin})))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                expected = f'corepack {pin} install --immutable'
                self.assertIn(expected, runs.missing_deps_hint(root))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(expected, err.getvalue())

    def test_ci_action_mapping_order_and_quotes(self):
        for quote in ('', "'", '"'):
            for with_first in (False, True):
                for named in (False, True):
                    with self.subTest(quote=quote, with_first=with_first, named=named), tempfile.TemporaryDirectory() as d:
                        root = Path(d)
                        (root / '.github/workflows').mkdir(parents=True)
                        uses = f'    uses: {quote}pnpm/action-setup@v4{quote} # setup\n'
                        settings = '    with:\n      version: "10.18.0" # pin\n'
                        block = settings + uses if with_first else uses + settings
                        if named:
                            block = '  - name: Setup pnpm\n' + block
                        else:
                            block = '  - ' + block.lstrip()
                        (root / '.github/workflows/ci.yml').write_text('steps:\n' + block)
                        (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                        self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_ci_action_with_nonstandard_child_indent(self):
        for spaces in (6, 8):
            with self.subTest(spaces=spaces), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with:\n' + ' ' * spaces + 'version: 10.18.0\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_block_scalar_text_cannot_invent_ci_pins(self):
        for style in ('|', '>', '|-', '>+', '|2'):
            for fake in ("PNPM_VERSION: '26'", "- uses: pnpm/action-setup@v4\n    with:\n      version: 26"):
                with self.subTest(style=style, fake=fake), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    body = '\n'.join('      ' + line for line in fake.splitlines())
                    workflow = 'steps:\n  - run: ' + style + '\n' + body + '\n  - uses: pnpm/action-setup@v4\n    with:\n      version: 10\n'
                    (root / '.github/workflows/ci.yml').write_text(workflow)
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    self.assertIn('corepack pnpm@10 install', runs.missing_deps_hint(root))

    def test_npm_and_bun_pins_are_printed_in_both_hints(self):
        for pin in ('npm@10.8.2', 'bun@1.3.0'):
            with self.subTest(pin=pin), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'package.json').write_text(with_dependencies(json.dumps({'packageManager': pin})))
                manager, version = pin.split('@')
                self.assertIn(f'Use {manager} {version} from package.json', runs.missing_deps_hint(root))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(f'Use {manager} {version} from package.json', err.getvalue())

    def test_ci_inline_mapping_and_step_spacing(self):
        for spacing in (1, 3):
            for inline in (False, True):
                for quote in ('', "'", '"'):
                    with self.subTest(spacing=spacing, inline=inline, quote=quote), tempfile.TemporaryDirectory() as d:
                        root = Path(d)
                        (root / '.github/workflows').mkdir(parents=True)
                        indent = ' ' * (3 + spacing)
                        uses = '  -' + ' ' * spacing + f'uses: {quote}pnpm/action-setup@v4{quote}\n'
                        settings = (indent + 'with: { version: "10.18.0" }\n' if inline else
                                    indent + 'with:\n' + indent + '  version: 10.18.0\n')
                        (root / '.github/workflows/ci.yml').write_text('steps:\n' + uses + settings)
                        (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                        self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_explicit_url_descriptor_keeps_manager_and_requests_inspection(self):
        for manager in ('yarn', 'pnpm', 'npm', 'bun'):
            with self.subTest(manager=manager), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'package.json').write_text(with_dependencies(json.dumps({
                    'packageManager': manager + '@https://example.invalid/manager.js#sha224.abcdef'})))
                (root / ('yarn.lock' if manager == 'pnpm' else 'pnpm-lock.yaml')).touch()
                hint = runs.missing_deps_hint(root)
                self.assertIn(f'packageManager declares {manager} with a non-numeric descriptor', hint)
                self.assertIn('<repo-install>' if manager == 'pnpm' else
                              f"{'corepack ' if manager == 'yarn' else ''}{manager} ", hint)
                self.assertNotIn('https://', hint)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(f'packageManager declares {manager} with a non-numeric descriptor', err.getvalue())

    def test_multiline_quoted_shell_content_is_not_config(self):
        for quote in ("'", '"'):
            for real in (False, True):
                with self.subTest(quote=quote, real=real), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    workflow = 'steps:\n  - run: ' + quote + 'echo\n      PNPM_VERSION: 26\n      - uses: pnpm/action-setup@v4\n        with: {version: 26}\n      echo done' + quote + '\n'
                    if real:
                        workflow += '  - uses: pnpm/action-setup@v4\n    with: {version: 10.18.0}\n'
                    (root / '.github/workflows/ci.yml').write_text(workflow)
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    hint = runs.missing_deps_hint(root)
                    self.assertNotIn('pnpm@26', hint)
                    self.assertIn('corepack pnpm@10.18.0 install' if real else 'corepack pnpm@10 install', hint)

    def test_flow_mapping_version_with_other_keys_and_nested_values(self):
        for fields in ('version: 10.18.0, run_install: false',
                       'run_install: false, version: "10.18.0"',
                       '"version": 10.18.0, options: {fake: 1, version: 26}',
                       "options: {fake: 1, version: 26}, version: '10.18.0'",
                       'options: "fake, version: 26", version: 10.18.0'):
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with: {' + fields + '}\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_scalar_name_with_variable_dash_spacing_preserves_sibling_keys(self):
        for spacing in (1, 3):
            for style in ('|', '>-'):
                with self.subTest(spacing=spacing, style=style), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    indent = ' ' * (3 + spacing)
                    workflow = ('steps:\n  -' + ' ' * spacing + 'name: ' + style + '\n' + indent + '  Setup pnpm\n' +
                                indent + 'uses: pnpm/action-setup@v4\n' + indent + 'with: {version: 10.18.0}\n')
                    (root / '.github/workflows/ci.yml').write_text(workflow)
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_all_scalar_key_styles_and_plain_continuations_are_opaque(self):
        for key in ('run', "'run'", '"run"'):
            for value in ('|', 'echo first', '"echo first', '{command: "echo first'):
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    close = '      end"}\n' if value.startswith('{') else '      end"\n' if value.startswith('"') else ''
                    workflow = ('steps:\n  - ' + key + ': ' + value + '\n      PNPM_VERSION: 26\n' + close +
                                '  - uses: pnpm/action-setup@v4\n    with: {version: 10.18.0}\n')
                    (root / '.github/workflows/ci.yml').write_text(workflow)
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_flow_trailing_comment_does_not_change_fields(self):
        for comment in ('# ${{ env.PNPM_VERSION }}', '# {version: 26}', '# }}}', '# "{quoted}"'):
            with self.subTest(comment=comment), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with: {version: 10.18.0} ' + comment + '\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_literal_config_keys_can_be_quoted(self):
        for quote in ("'", '"'):
            with self.subTest(quote=quote), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                workflow = ('steps:\n  - ' + quote + 'uses' + quote + ': pnpm/action-setup@v4\n    ' +
                            quote + 'with' + quote + ':\n      ' + quote + 'version' + quote + ': 10.18.0\n')
                (root / '.github/workflows/ci.yml').write_text(workflow)
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))
                (root / '.github/workflows/ci.yml').write_text('env:\n  ' + quote + 'PNPM_VERSION' + quote + ': 10.18.0\n')
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_multiline_flow_comments_remain_outside_values(self):
        for contents in ('version: 10.18.0 # literal CI pin',
                         'version: 10.18.0 # } fake close',
                         'version: 10.18.0, # {, version: 26',
                         'options: "# quoted,version: 26",\n      version: 10.18.0 # pin'):
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with: {\n      ' + contents + '\n    }\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_scalar_body_can_start_after_the_key_line(self):
        for value in ('|\n        PNPM_VERSION: 26',
                      '>-\n        PNPM_VERSION: 26',
                      'echo first\n        PNPM_VERSION: 26',
                      '"echo first\n        PNPM_VERSION: 26\n        done"',
                      "'echo first\n        PNPM_VERSION: 26\n        done'",
                      '{command: "echo first\n        PNPM_VERSION: 26\n        done"}'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - run:\n      ' + value + '\n  - uses: pnpm/action-setup@v4\n    with: {version: 10.18.0}\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_quotes_in_plain_scalars_cannot_keep_comment_pins(self):
        for quote in ("'", '"'):
            for real_pin in (False, True):
                with self.subTest(quote=quote, real_pin=real_pin), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    value = f'pnpm{quote}s-home'
                    comment = f'# user{quote}s cache, version: 26,'
                    fields = '      dest: ' + value + (',' if real_pin else '') + ' ' + comment + '\n'
                    if real_pin:
                        fields += '      version: 10.18.0\n'
                    (root / '.github/workflows/ci.yml').write_text(
                        'steps:\n  - uses: pnpm/action-setup@v4\n    with: {\n' + fields + '    }\n')
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    hint = runs.missing_deps_hint(root)
                    self.assertNotIn('pnpm@26', hint)
                    self.assertIn('corepack pnpm@10.18.0 install' if real_pin else 'corepack pnpm@10 install', hint)

    def test_colon_in_plain_scalar_is_not_a_quote_boundary(self):
        for quote in ("'", '"'):
            for real_pin in (False, True):
                with self.subTest(quote=quote, real_pin=real_pin), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    field = f'      dest: pnpm:{quote}s-home' + (',' if real_pin else '') + f' # user{quote}s cache, version: 26,\n'
                    if real_pin:
                        field += '      version: 10.18.0\n'
                    (root / '.github/workflows/ci.yml').write_text(
                        'steps:\n  - uses: pnpm/action-setup@v4\n    with: {\n' + field + '    }\n')
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    hint = runs.missing_deps_hint(root)
                    self.assertNotIn('pnpm@26', hint)
                    self.assertIn('corepack pnpm@10.18.0 install' if real_pin else 'corepack pnpm@10 install', hint)

    def test_compact_quoted_key_value_mapping_retains_version(self):
        for quote in ("'", '"'):
            with self.subTest(quote=quote), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with: {' + quote + 'version' + quote + ':' + quote + '10.18.0' + quote + '}\n')
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_vite_plus_repo_installs_with_its_manager_not_vp(self):
        for pin, command in ((None, 'npm install'), ('pnpm@11.7.0', 'corepack pnpm@11.7.0 install --frozen-lockfile'),
                             ('yarn@4.9.2', 'corepack yarn@4.9.2 install --immutable')):
            with self.subTest(pin=pin), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / 'package.json').write_text(with_dependencies(json.dumps({
                    'packageManager': pin, 'devDependencies': {'vite-plus': '1.0.0'}})))
                self.assertIn(f"offbox run -- '{command} &&", runs.missing_deps_hint(root))
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(f'with {command} &&', err.getvalue())
                self.assertNotIn('vp i &&', err.getvalue())

    def test_ci_pnpm_pin_and_node_engine_in_both_hints(self):
        workflows = [
            "env:\n  PNPM_VERSION: '10'\n",
            'env:\n  PNPM_VERSION: "10" # CI pin\n',
            "steps:\n  - uses: pnpm/action-setup@v4\n    with:\n      version: 10.18.0\n",
            "steps:\n  - name: Setup pnpm\n    uses: pnpm/action-setup@v4\n    with:\n      version: 10.18.0\n",
        ]
        for workflow in workflows:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yaml').write_text(workflow)
                (root / 'package.json').write_text(with_dependencies(json.dumps({'engines': {'node': '^20.19.0 || >=22.12.0 <23'}})))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                hint = runs.missing_deps_hint(root)
                pin = '10.18.0' if '10.18.0' in workflow else '10'
                self.assertIn(f'corepack pnpm@{pin} install --frozen-lockfile', hint)
                self.assertIn('Use Node matching package.json engines', hint)
                ranges, _ = runs.node_version.want(root, root)
                installed = [20000000, 22023002, 26002000]
                selected = max(v for v in installed if any(lo <= v < hi for lo, hi in ranges))
                self.assertEqual(selected, 22023002)
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                self.assertIn(f'corepack pnpm@{pin} install --frozen-lockfile', err.getvalue())
                (root / 'package.json').write_text(with_dependencies('{"packageManager":"pnpm@11.7.0"}'))
                self.assertIn('corepack pnpm@11.7.0 ', runs.missing_deps_hint(root))

    def test_ci_setup_expressions_defer_both_hints(self):
        expressions = ('matrix.pnpm', 'env.OTHER_VERSION',
                       'inputs.pnpm', 'needs.setup.outputs.pnpm')
        for expression in expressions:
            for layout in ('block', 'flow', 'quoted-flow'):
                with self.subTest(expression=expression, layout=layout), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    value = '${{ ' + expression + ' }}'
                    settings = {
                        'block': f'    with:\n      version: {value}\n',
                        'flow': f'    with: {{version: "{value}", run_install: false}}\n',
                        'quoted-flow': f'    "with": {{run_install: false, \'version\': \'{value}\'}}\n',
                    }[layout]
                    workflow = ("env:\n  PNPM_VERSION: '10'\njobs:\n  checks:\n    strategy:\n      matrix:\n        pnpm: [11]\n"
                                '    steps:\n      - uses: pnpm/action-setup@v4\n' +
                                ''.join('    ' + line for line in settings.splitlines(keepends=True)))
                    (root / '.github/workflows/ci.yml').write_text(workflow)
                    (root / 'package.json').write_text(with_dependencies('{}'))
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    log = root / 'run.log'
                    log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                    for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                        self.assertIn('<repo-install>', hint)
                        self.assertIn('CI pnpm version is ambiguous', hint)
                        self.assertIn('inspect', hint)
                        self.assertNotIn('corepack pnpm', hint)
                    # A repository-owned pin still outranks dynamic CI configuration.
                    (root / 'package.json').write_text(with_dependencies('{"packageManager":"pnpm@10.18.0"}'))
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                    for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                        self.assertIn('corepack pnpm@10.18.0 install', hint)
                        self.assertNotIn('CI pnpm version is ambiguous', hint)

    def test_ci_expressions_and_conflicting_versions_need_inspection(self):
        for workflow, inspect in (
            ("env:\n  PNPM_VERSION: '${{ matrix.pnpm }}'\n", True),
            ("steps:\n  # uses: pnpm/action-setup@v4\n  - uses: other/action@v1\n    with:\n      version: 26\n", False),
            ("steps:\n  - run: echo uses: pnpm/action-setup@v4\n    with:\n      version: 26\n", False),
            ("env:\n  PNPM_VERSION: '10'\njobs:\n  checks:\n    env:\n      PNPM_VERSION: '11'\n", True),
            ("steps:\n  - uses: pnpm/action-setup@v4\n    with:\n      version: ${{ env.PNPM_VERSION }}\n  - uses: actions/setup-node@v4\n    with:\n      version: 26\n", True),
        ):
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(workflow)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>' if inspect else 'corepack pnpm@10 install', hint)
                    self.assertEqual('CI pnpm version is ambiguous' in hint, inspect)
                    self.assertEqual('pnpm@' in hint, not inspect)

    def test_ci_expression_in_another_workflow_blocks_literal_selection(self):
        for dynamic in ("version: ${{ matrix.pnpm }}", "version: nightly", "version:"):
            with self.subTest(dynamic=dynamic), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text("env:\n  PNPM_VERSION: '10'\n")
                (root / '.github/workflows/check.yaml').write_text(
                    'steps:\n  - uses: pnpm/action-setup@v4\n    with:\n      ' + dynamic + '\n')
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertIn('<repo-install>', hint)
                    self.assertNotIn('corepack pnpm', hint)
                # The repo bootstrap cannot hide an unresolved version requirement.
                (root / 'package.json').write_text(with_dependencies('{"devDependencies":{"vite-plus":"1.0.0"}}'))
                self.assertIn('<repo-install>', runs.box_deps_hint(root, log))

    def test_flow_setup_steps_and_inline_env_keep_unresolved_candidates(self):
        cases = (
            "  - {uses: pnpm/action-setup@v4, with: {version: '${{ matrix.pnpm }}'}}\n",
            "  - {\n      uses: pnpm/action-setup@v4, # setup\n      with: {version: '${{ matrix.pnpm }}'}\n    }\n",
            "  - {'with': {run_install: false, version: '${{ inputs.pnpm }}'}, \"uses\": 'pnpm/action-setup@v4'}\n",
            "  - env: {PNPM_VERSION: '${{ matrix.pnpm }}', OTHER: ignored}\n    uses: pnpm/action-setup@v4\n    with: {version: '${{ env.PNPM_VERSION }}'}\n",
            "  - {env: {PNPM_VERSION: '${{ matrix.pnpm }}'}, uses: pnpm/action-setup@v4, with: {version: '10'}}\n",
            "  - {uses: pnpm/action-setup@v4, env: {'PNPM_VERSION': '${{ matrix.pnpm }}'}, with: {version: '10'}}\n",
        )
        for steps in cases:
            with self.subTest(steps=steps), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    "env:\n  PNPM_VERSION: '10'\nsteps:\n" + steps)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>', hint)
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertNotIn('corepack pnpm', hint)
                # The same flow shape must preserve literal pins when no candidate is dynamic.
                workflow = (root / '.github/workflows/ci.yml').read_text()
                workflow = workflow.replace('${{ matrix.pnpm }}', '10').replace('${{ inputs.pnpm }}', '10')
                workflow = workflow.replace('${{ env.PNPM_VERSION }}', '10')
                (root / '.github/workflows/ci.yml').write_text(workflow)
                self.assertIn('corepack pnpm@10 install', runs.box_deps_hint(root, log))

    def test_dynamic_env_and_setup_mapping_require_inspection(self):
        for settings in ('env: ${{ matrix.env }}', 'with: ${{ inputs.setup }}'):
            for quote in ('', "'", '"'):
                with self.subTest(settings=settings, quote=quote), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    key, value = settings.split(': ', 1)
                    (root / '.github/workflows/ci.yml').write_text(
                        "env:\n  PNPM_VERSION: '10'\nsteps:\n  - uses: pnpm/action-setup@v4\n    " +
                        key + ': ' + quote + value + quote + '\n')
                    (root / 'package.json').write_text(with_dependencies('{}'))
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    log = root / 'run.log'
                    log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                    for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                        self.assertIn('<repo-install>', hint)
                        self.assertIn('CI pnpm version is ambiguous', hint)
                        self.assertNotIn('corepack pnpm', hint)

    def test_inline_job_env_override_defers_both_hints(self):
        for key in ('env', "'env'", '"env"'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    "env:\n  PNPM_VERSION: '10'\njobs:\n  checks:\n    " + key +
                    ": {PNPM_VERSION: '${{ matrix.pnpm }}'}\n    strategy:\n      matrix:\n        pnpm: [11]\n"
                    "    steps:\n      - run: corepack pnpm@${{ env.PNPM_VERSION }} install --frozen-lockfile\n")
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>', hint)
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertNotIn('corepack pnpm', hint)

    def test_unresolved_mapping_containers_do_not_hide_candidates(self):
        cases = (
            "  -\n    uses: pnpm/action-setup@v4\n    with:\n      version: ${{ matrix.pnpm }}\n",
            "  - # separate dash\n    # action\n    uses: pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n",
            "  - uses: pnpm/action-setup@v4\n    with:\n      ${{ inputs.setup }}\n",
            "  - uses: pnpm/action-setup@v4\n    env:\n      ${{ matrix.env }}\n    with: {version: '10'}\n",
            "  - uses: pnpm/action-setup@v4\n    with: &setup\n      version: ${{ matrix.pnpm }}\n",
            "  - uses: pnpm/action-setup@v4\n    env: &local-env\n      PNPM_VERSION: ${{ matrix.pnpm }}\n    with: {version: '10'}\n",
            "  - uses: pnpm/action-setup@v4\n    with: *setup\n",
            "  - uses: pnpm/action-setup@v4\n    env: *local-env\n    with: {version: '10'}\n",
            "  - uses: pnpm/action-setup@v4\n    with:\n      *setup\n",
            "  - uses: pnpm/action-setup@v4\n    env:\n      *local-env\n    with: {version: '10'}\n",
            "  - uses: pnpm/action-setup@v4\n    with:\n      &setup\n      version: ${{ matrix.pnpm }}\n",
            "  - uses: pnpm/action-setup@v4\n    env:\n      &local-env\n      PNPM_VERSION: ${{ matrix.pnpm }}\n    with: {version: '10'}\n",
            "  - uses: pnpm/action-setup@v4\n    with: &setup {version: '${{ matrix.pnpm }}'}\n",
            "  - uses: pnpm/action-setup@v4\n    env: &local-env {PNPM_VERSION: '${{ matrix.pnpm }}'}\n",
        )
        for steps in cases:
            with self.subTest(steps=steps), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(
                    "env:\n  PNPM_VERSION: '10'\nsteps:\n" + steps)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>', hint)
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertNotIn('corepack pnpm', hint)

    def test_standalone_dash_keeps_literal_setup_version(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / '.github/workflows').mkdir(parents=True)
            (root / '.github/workflows/ci.yml').write_text(
                'steps:\n  -\n    uses: pnpm/action-setup@v4\n    with: {version: 10.18.0}\n')
            (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
            self.assertIn('corepack pnpm@10.18.0 install', runs.missing_deps_hint(root))

    def test_complex_step_containers_require_inspection(self):
        containers = (
            "steps: [{uses: pnpm/action-setup@v4, with: {version: '${{ matrix.pnpm }}'}}]\n",
            "steps:\n  - &setup {uses: pnpm/action-setup@v4, with: {version: '${{ matrix.pnpm }}'}}\n",
            "steps: [\n  {uses: pnpm/action-setup@v4, with: {version: '${{ matrix.pnpm }}'}}\n]\n",
            "steps:\n  - *setup\n",
            "steps: ${{ inputs.steps }}\n",
            "jobs: {checks: {steps: [{uses: pnpm/action-setup@v4, with: {version: '${{ matrix.pnpm }}'}}]}}\n",
        )
        for container in containers:
            with self.subTest(container=container), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text("env:\n  PNPM_VERSION: '10'\n" + container)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>', hint)
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertNotIn('corepack pnpm', hint)

    def test_next_line_scalar_mapping_headers_require_inspection(self):
        for key in ('env', 'with'):
            for value in ('|\n        ${{ inputs.setup }}', '>\n        ${{ inputs.setup }}',
                          '>-\n        ${{ inputs.setup }}', "'${{ inputs.setup }}'", 'null'):
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as d:
                    root = Path(d)
                    (root / '.github/workflows').mkdir(parents=True)
                    (root / '.github/workflows/ci.yml').write_text(
                        "env:\n  PNPM_VERSION: '10'\nsteps:\n  - uses: pnpm/action-setup@v4\n    " +
                        key + ':\n      ' + value + '\n')
                    (root / 'package.json').write_text(with_dependencies('{}'))
                    (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                    log = root / 'run.log'
                    log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err):
                        runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                    for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                        self.assertIn('<repo-install>', hint)
                        self.assertIn('CI pnpm version is ambiguous', hint)
                        self.assertNotIn('corepack pnpm', hint)

    def test_nested_flow_jobs_and_decorated_actions_require_inspection(self):
        cases = (
            "jobs: {checks: {env: {PNPM_VERSION: '11'}, steps: [{run: pnpm install}]}}\n",
            "jobs:\n  checks: &job {env: {PNPM_VERSION: '11'}, steps: [{run: pnpm install}]}\n",
            "jobs: {checks: {steps: '${{ inputs.steps }}'}}\n",
            "jobs:\n  checks: &job {steps: '${{ inputs.steps }}'}\n",
            "steps:\n  - uses: &setup pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n",
            "steps:\n  - uses: >-\n      pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n",
            "steps:\n  - uses:\n      >-\n        pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n",
            "steps:\n  - uses: *setup\n    with: {version: '${{ matrix.pnpm }}'}\n",
            'steps:\n  - uses: "pnpm/action-setup@\\\n      v4"\n    with: {version: \'${{ matrix.pnpm }}\'}\n',
            'steps:\n  - uses: "pnpm\\/action-setup@v4"\n    with: {version: \'${{ matrix.pnpm }}\'}\n',
            'steps:\n  - uses: "pnpm/action-setup\\u0040v4"\n    with: {version: \'${{ matrix.pnpm }}\'}\n',
            "steps:\n  -\n      run: echo ok\n  - uses: pnpm/action-setup@v4\n    with: {version: '${{ matrix.pnpm }}'}\n",
            'steps:\n  - uses: pnpm/action-setup@v4\n    with: {"versi\\u006fn": "${{ matrix.pnpm }}"}\n',
            'jobs: {checks: {"e\\u006ev": {PNPM_VERSION: 11}, steps: [{run: echo ok}]}}\n',
            'jobs: {checks: {"ste\\u0070s": [{uses: pnpm/action-setup@v4, with: {version: "${{ matrix.pnpm }}"}}]}}\n',
            'jobs: {checks: {steps: [{"u\\u0073es": pnpm/action-setup@v4, with: {version: "${{ matrix.pnpm }}"}}]}}\n',
            'jobs: {checks: {steps: [{env: {"PNPM_VER\\u0053ION": 11}, run: "corepack pnpm@${{ env.PNPM_VERSION }} install"}]}}\n',
            'jobs: {checks: {steps: [{env: {PNPM_VERSION: 11}, run: "corepack pnpm@${{ env.PNPM_VERSION }} install"}]}}\n',
            'jobs: {checks: {steps: [{env: "${{ inputs.env }}", run: "corepack pnpm@${{ env.PNPM_VERSION }} install"}]}}\n',
            'jobs: {checks: {steps: [{env: {? "PNPM_VER\\u0053ION": 11}, run: echo ok}]}}\n',
            'jobs: {checks: {? env: {PNPM_VERSION: 11}, steps: [{run: echo ok}]}}\n',
            'steps:\n  - uses: pnpm/action-setup@v4\n    with: {? version: "${{ matrix.pnpm }}"}\n',
            'steps:\n  - env: {? PNPM_VERSION: 11}\n    run: echo ok\n',
            'steps:\n  - {? uses: pnpm/action-setup@v4, with: {version: "${{ matrix.pnpm }}"}}\n',
        )
        for config in cases:
            with self.subTest(config=config), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text("env:\n  PNPM_VERSION: '10'\n" + config)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('<repo-install>', hint)
                    self.assertIn('CI pnpm version is ambiguous', hint)
                    self.assertNotIn('corepack pnpm', hint)

    def test_comments_shell_text_and_matrix_anchors_do_not_create_ambiguity(self):
        cases = (
            "# example {uses: pnpm/action-setup@v4}\n",
            "steps:\n  - run: echo 'pnpm/action-setup@v4 {version=11}'\n",
            "jobs:\n  checks:\n    strategy:\n      matrix:\n        include:\n          - &linux {os: ubuntu-latest}\n    steps:\n      - run: echo ok\n",
            "jobs:\n  checks:\n    steps:\n      - uses: pnpm/action-setup@v4\n        with: {version: '10'}\n    strategy:\n      matrix:\n        include:\n          - &linux {os: ubuntu-latest}\n",
            'jobs:\n  checks:\n    outputs: {example: "pnpm/action-setup@v4"}\n    steps:\n      - run: echo ok\n',
            'jobs: {checks: {outputs: {example: "pnpm/action-setup@v4"}, steps: [{run: echo ok}]}}\n',
            'jobs: {checks: {steps: [{env: {OTHER: "PNPM_VERSION"}, run: echo ok}]}}\n',
            "jobs:\n  checks:\n    strategy:\n      matrix:\n        steps:\n          - &linux {os: ubuntu-latest}\n    steps:\n      - run: echo ok\n",
            "jobs:\n  checks:\n    steps:\n      - run: echo ok\n    strategy:\n      matrix:\n        steps:\n          - &linux {os: ubuntu-latest}\n",
            "jobs:\n  checks:\n    strategy:\n      matrix:\n        env: [development, production]\n    steps:\n      - run: echo ok\n",
            "jobs:\n  checks:\n    steps:\n      - run: echo ok\n    strategy:\n      matrix:\n        env: [development, production]\n",
        )
        for config in cases:
            with self.subTest(config=config), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text("env:\n  PNPM_VERSION: '10'\n" + config)
                (root / 'package.json').write_text(with_dependencies('{}'))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                log = root / 'run.log'
                log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'B'}, root,
                                           runs.command_usage.inspect(root, '.', ['node']))
                for hint in (err.getvalue(), runs.box_deps_hint(root, log)):
                    self.assertIn('corepack pnpm@10 install', hint)
                    self.assertNotIn('CI pnpm version is ambiguous', hint)

    def test_modern_yarn_lock_without_package_manager(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'yarn.lock').write_text('__metadata:\n  version: 8\n')
            self.assertIn('corepack yarn install --immutable', runs.missing_deps_hint(root))

    def test_marker_is_required_even_when_local_deps_are_absent(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'package.json').write_text('{"packageManager":"bun@1.3.0"}')
            log = root / 'run.log'
            for text in ('FAIL\n', 'echo OFFBOX_NO_NODE_MODULES\n', 'OFFBOX_NO_NODE_MODULES extra\n'):
                log.write_text(text)
                self.assertEqual(runs.box_deps_hint(root, log), '')
            self.assertEqual(runs.box_deps_hint(root, None), '')
            self.assertEqual(runs.box_deps_hint(root, root / 'missing.log'), '')
            (root / 'node_modules').mkdir()
            log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
            self.assertIn('bun install', runs.box_deps_hint(root, log))

    def test_bad_manifest_does_not_hide_remote_exit(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            log = root / 'run.log'
            log.write_text(runs.NO_NODE_MODULES_MARKER + '\n')
            (root / 'package-lock.json').touch()
            for manifest in ('{', '[]', '{"packageManager":42}'):
                (root / 'package.json').write_text(manifest)
                self.assertIn('npm ci', runs.box_deps_hint(root, log))

    def test_box_marker_uses_repo_root_and_preserves_exit(self):
        for code in (0, 1, 127, 254):
            for state in ('absent', 'present', 'no-package', 'nested-only', 'symlink'):
                with self.subTest(code=code, state=state), tempfile.TemporaryDirectory() as home:
                    root = Path(home) / 'w/repo'
                    (root / 'sub').mkdir(parents=True)
                    if state != 'no-package':
                        (root / 'package.json').write_text('{"devDependencies":{"vitest":"1"}}')
                    if state == 'present':
                        (root / 'node_modules').mkdir()
                    elif state == 'nested-only':
                        (root / 'sub/node_modules').mkdir()
                    elif state == 'symlink':
                        (root / 'node_modules').symlink_to(root / 'sub', target_is_directory=True)
                    with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                            patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs.userns, 'setup', return_value=':'):
                        script = runs.remote_script('w/repo', 'sub', [f'node -e \"process.exit({code})\"; cd /; exit {code}'], None, 'r', repo_root=root)
                    p = subprocess.run(['bash', '-c', script], env=clean_env(HOME=home),
                                       capture_output=True, text=True, timeout=10)
                    self.assertEqual(p.returncode, code)
                    self.assertEqual(p.stderr.splitlines().count(runs.NO_NODE_MODULES_MARKER),
                                     int(code not in (0, 127) and state in ('absent', 'nested-only')))

    def test_steps_print_one_marker_even_if_last_step_passes(self):
        with tempfile.TemporaryDirectory() as home:
            root = Path(home) / 'w/repo'
            root.mkdir(parents=True)
            (root / 'package.json').write_text('{"devDependencies":{"vitest":"1"}}')
            with patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                    patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs.userns, 'setup', return_value=':'):
                script = runs.remote_script('w/repo', '.', [], None, 'r', steps=['node -e \"process.exit(127)\"', 'true'], repo_root=root)
            p = subprocess.run(['bash', '-c', script], env=clean_env(HOME=home),
                               capture_output=True, text=True, timeout=10)
            self.assertEqual(p.returncode, 127)
            self.assertEqual(p.stderr.splitlines().count(runs.NO_NODE_MODULES_MARKER), 0)
            self.assertIn('offbox: exit 127:', p.stderr)

    def test_report_exit_hint_and_silent_cases(self):
        with tempfile.TemporaryDirectory() as d:
            hint = runs.missing_deps_hint(Path(d))
        for code, steps, marker, where, expected in (
                (1, None, True, 'remote', True), (127, None, True, 'remote', False),
                (127, [(1, 1)], True, 'remote', False),
                (254, None, True, 'remote', True), (2, None, True, 'remote', True),
                (0, [(1, 127)], True, 'remote', False), (None, [(1, 127)], True, 'remote', False),
                (0, None, True, 'remote', False), (None, None, True, 'remote', False),
                (127, None, False, 'remote', False), (1, None, True, 'local', False)):
            with self.subTest(code=code, steps=steps, marker=marker, where=where):
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    runs.report_exit('vitest', code, steps, len(steps or []), where=where,
                                     deps_hint=hint if marker else '')
                lines = err.getvalue().splitlines()
                self.assertEqual(sum(hint in line for line in lines), int(expected))
                if expected:
                    self.assertEqual(lines[-2], 'offbox: ' + hint)
                if code is not None:
                    self.assertEqual(lines[-1], f'offbox: {where} exit {code}')


class SummaryAndHintTests(unittest.TestCase):

    def test_summary_counts_and_first_failure(self):
        s = runs.steps_summary([(1, 0), (2, 1), (3, 0), (4, 2)], 4)
        self.assertEqual(s, 'offbox steps: 2 ok, 2 failed (step 2 rc=1, step 4 rc=2)')

    def test_completeness_requires_each_planned_number(self):
        cases = [([], 2), ([(1, 0), (1, 0)], 1), ([(0, 0), (3, 0)], 2),
                 ([(1, 0), (3, 0)], 1), ([(2, 0), (1, 0)], 0)]
        for results, missing in cases:
            with self.subTest(results=results):
                self.assertEqual(runs.missing_step_count(results, 2), missing)

    def test_summary_mentions_steps_not_run(self):
        self.assertEqual(runs.steps_summary([(1, 0)], 3), 'offbox steps: 1 ok, 0 failed, 2 not run')

    def test_command_restart_marker_discards_prior_step_results(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / 'run.log'
            log.write_text('offbox step 1 rc=0: a\noffbox step 2 rc=0: b\n'
                           + runs.COMMAND_STARTED_MARKER + ' run-retry\noffbox step 1 rc=0: a\n')
            self.assertEqual(runs.step_results(log, "run-retry"), [(1, 0)])
            self.assertIsNone(runs.steps_exit(log, 2, "run-retry"))

    def test_grep_hint_only_for_exit_1_from_trailing_grep(self):
        self.assertTrue(runs.last_stage_is_grep('go test ./... 2>&1 | tee /tmp/l | tail -40; grep -c FAIL /tmp/l'))
        self.assertTrue(runs.last_stage_is_grep('go test ./... | grep FAIL'))
        self.assertFalse(runs.last_stage_is_grep('go test ./... | tail -5'))
        self.assertFalse(runs.last_stage_is_grep('grep FAIL /tmp/l; go test ./...'))

    def test_report_exit_prints_grep_hint_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('go test ./... 2>&1 | tee /tmp/l | tail -40; grep -c FAIL /tmp/l', 1)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: exit 1 may be from the trailing grep (no match) or an earlier stage. '
                                    'Use --step for each command.')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_report_exit_prints_step_summary_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 1, [(1, 0), (2, 1)], 2)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=1)')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_setup_marker_detected_in_log(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / 'run.log'
            log.write_text('offbox: Go repair: cannot acquire repair lock\noffbox-setup-failed\n')
            self.assertTrue(runs.setup_failed(log))
            log.write_text('FAIL TestX\n')
            self.assertFalse(runs.setup_failed(log))



class CliStepTests(Isolated):

    def run_cli(self, argv, code, log_text='', recorded=None, *, setup_history=False):
        a = cli.build_parser().parse_args(['run'] + argv)

        def start(rn):
            nonlocal log_text
            result = fake_start(rn)
            if callable(log_text):
                log_text = log_text(rn)
            if setup_history:
                rn.register_pending()
                rn.record(box_id=rn.box, process_id=rn.pid, command_id='setup-command', status='running')
            return result

        def fake_follow(box, pid, log_path, echo=True, run_id=None, start_offsets=(0, 0)):
            if log_path:
                Path(log_path).write_text(log_text)
            return code

        err = io.StringIO()
        with patch.object(runs.Runner, 'start', start), patch.object(runs, 'follow', fake_follow), \
                patch.object(runs.api, 'history_logs', side_effect=lambda *args, **kwargs: dict(data=log_text, done=True)), \
                patch.object(runs.lease, 'idle_ttl'), \
                patch.object(runs, 'recorded_exit', return_value=recorded), contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, err.getvalue().strip().splitlines()

    def test_step_and_trailing_cmd_is_an_error(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = cli.cmd_run(cli.build_parser().parse_args(['run', '--step', 'true', '--', 'echo', 'x']), self.me)
        self.assertEqual(rc, 2)
        self.assertIn('either --step', err.getvalue())

    def test_steps_summary_and_exit_line(self):
        log = 'offbox step 1 rc=0: go vet ./...\noffbox step 2 rc=1: go test ./...\n'
        rc, lines = self.run_cli(['--step', 'go vet ./...', '--step', 'go test ./...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertEqual(lines[-2], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=1)')
        self.assertEqual(lines[-1], 'offbox: remote exit 1')

    def test_foreground_zero_without_step_result_is_incomplete(self):
        rc, lines = self.run_cli(['--step', 'terraform test'], 0)
        self.assertEqual(rc, 90)
        self.assertIn('offbox: steps incomplete: got 0 of 1 step results; remote exit unknown', lines)
        self.assertNotIn('offbox: remote exit 0', lines)

    def test_quint_setup_failure_keeps_99_without_step_markers(self):
        event = 'offbox-quint: {"attempt":"result","result":"failed","duration_s":1,"trigger":"command"}\n'
        rc, lines = self.run_cli(['--step', 'quint --version'], 99, event)
        self.assertEqual(rc, 99, lines)
        self.assertFalse(any('steps incomplete' in line for line in lines), lines)
        # A command cannot evade missing-step handling by printing setup text.
        rc, _ = self.run_cli(['--step', 'quint --version'], 99,
                             lambda rn: f'offbox-command-started: {rn.run_id} [n={rn.protocol_nonce}]\n' + event,
                             setup_history=True)
        self.assertEqual(rc, 90)

    def test_foreground_complete_steps_keep_zero(self):
        rc, lines = self.run_cli(['--step', 'true'], 0, 'offbox step 1 rc=0: true\n')
        self.assertEqual(rc, 0)
        self.assertEqual(lines[-1], 'offbox: remote exit 0')

    def test_missing_deps_hint_from_probes_log(self):
        # Crpko #3816: probes.log, cf1569-a3 on bx_yy9mjenc after an install on another box.
        log = ('offbox: reusing repository pool box bx_yy9mjenc (xlarge)\n'
               'bash: line 1: ./node_modules/.bin/vitest: No such file or directory\n')
        root = Path(self.tmp.name)
        self.me['repo_root'] = str(root)
        (root / 'package.json').write_text('{"packageManager":"pnpm@11.10.0"}')
        (root / 'node_modules').mkdir()  # Local deps must not suppress box evidence.
        for code in (1, 127, 254):
            with self.subTest(code=code):
                rc, lines = self.run_cli(['./node_modules/.bin/vitest'], code,
                                         log + runs.NO_NODE_MODULES_MARKER + '\n')
                self.assertEqual(rc, code)
                self.assertEqual(any("corepack pnpm@11.10.0 install --frozen-lockfile && <command>" in line for line in lines), code != 127)
                self.assertEqual(lines[-1], f'offbox: remote exit {code}')
        rc, lines = self.run_cli(['./node_modules/.bin/vitest'], 127, log)
        self.assertEqual(lines, ['offbox: remote exit 127'])

    def test_background_completion_and_settled_wait_show_hint(self):
        root = Path(self.tmp.name)
        (root / 'package.json').write_text('{"packageManager":"bun@1.3.0"}')
        log = runs.LOGS_DIR / 'bg.log'
        row = dict(run_id='bg', mode='bg', box_id='B', repo_root=str(root), pulls='[]', exit_code=127,
                   status='failed', error=None)
        cases = [(1, '', True), (127, '', False), (254, '', True), (0, '', False),
                 (None, '', False), (None, 'offbox step 1 rc=0: vitest\n', False),
                 (None, 'offbox step 1 rc=127: vitest\n', False),
                 (0, 'offbox step 1 rc=1: pnpm test\n', True)]
        for code, steps, failed in cases:
            row['exit_code'] = code
            for marked in (True, False):
                log.write_text(steps + (runs.NO_NODE_MODULES_MARKER + '\n' if marked else 'vitest: not found\n'))
                for settled in (True, False):
                    with self.subTest(code=code, steps=steps, marked=marked, settled=settled):
                        err, out = io.StringIO(), io.StringIO()
                        with patch.object(misc, '_catch_up_log'), patch.object(misc, '_incomplete_log'), \
                                patch.object(runs, 'finish', side_effect=lambda rid, code, **kw: code), patch.object(runs, 'go_std_glitch'), \
                                patch.object(runs, 'settle_box_wedged', return_value=None), \
                                contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                            rc = misc._settled(row) if settled else misc._finalize(row, code, log)
                        self.assertEqual(rc, 90 if code is None else code)
                        self.assertEqual('bun install' in err.getvalue(), marked and failed)
                        self.assertIn(f'exit={code}', out.getvalue())

    def test_background_legacy_run_without_repo_and_marker_keeps_exit(self):
        row = dict(run_id='legacy', mode='bg', box_id='B', repo_root=None, pulls='[]', exit_code=127,
                   status='failed', error=None)
        err, out = io.StringIO(), io.StringIO()
        with patch.object(misc, '_catch_up_log', return_value='complete'), patch.object(misc, '_incomplete_log'), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            self.assertEqual(misc._settled(row), 127)
        self.assertEqual(err.getvalue(), 'offbox: legacy settled with no output on record\n')
        self.assertIn('exit=127', out.getvalue())

    def glitch_events(self):
        return self.con.execute("SELECT box_id, detail FROM events WHERE kind='go_std_glitch'").fetchall()

    def test_go_std_glitch_prints_hint_and_records_event(self):
        log = 'internal/abi/abi.go:9:2: package unsafe is not in std (/usr/local/go/src/unsafe)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertTrue(any('not your code' in x for x in lines))
        self.assertEqual(lines[-1], 'offbox: remote exit 1')
        rows = self.glitch_events()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], 'bx_fake')
        self.assertIn('unknown', rows[0][1])

    def test_go_std_glitch_reports_seconds_after_resume(self):
        self.con.execute("INSERT INTO events VALUES (?,?,?,?)", (time.time() - 90, 'bx_fake', 'lease_resume', ''))
        self.con.commit()
        log = 'package internal/fmtsort is not in std (/usr/local/go/src/internal/fmtsort)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, log)
        self.assertEqual(rc, 1)
        self.assertRegex(self.glitch_events()[0][1], r'\d+s after resume')

    def test_no_glitch_hint_on_success_or_other_failures(self):
        std_log = 'package unsafe is not in std (/usr/local/go/src/unsafe)\n'
        rc, lines = self.run_cli(['go', 'vet', './...'], 0, std_log)
        self.assertEqual(rc, 0)
        self.assertFalse(any('not your code' in x for x in lines))
        rc, lines = self.run_cli(['go', 'test', './...'], 1, '--- FAIL TestX\n')
        self.assertFalse(any('not your code' in x for x in lines))
        user_log = 'package risk-liquidation/internal/x is not in std (/usr/local/go/src/risk-liquidation/internal/x)\n'
        rc, lines = self.run_cli(['go', 'test', './...'], 1, user_log)
        self.assertFalse(any('not your code' in x for x in lines))
        self.assertEqual(self.glitch_events(), [])

    def test_plain_cmd_still_has_no_step_summary(self):
        rc, lines = self.run_cli(['go', 'test', './...'], 0)
        self.assertEqual(rc, 0)
        self.assertFalse(any('offbox steps' in x for x in lines))

    def test_lost_step_run_with_every_step_reported_takes_steps_code(self):
        steps = ['--step', 'a', '--step', 'b']
        rc, lines = self.run_cli(steps, None, 'offbox step 1 rc=0: a\noffbox step 2 rc=0: b\n')
        self.assertEqual(rc, 0)
        self.assertEqual(lines[-1], 'offbox: remote exit 0')
        rc, lines = self.run_cli(steps, None, 'offbox step 1 rc=0: a\noffbox step 2 rc=3: b\n')
        self.assertEqual(rc, 3)

    def test_lost_step_run_with_missing_step_line_stays_90(self):
        rc, lines = self.run_cli(['--step', 'a', '--step', 'b'], None, 'offbox step 1 rc=0: a\n')
        self.assertEqual(rc, 90)
        self.assertTrue(any('remote exit unknown' in ln for ln in lines))

    def test_setup_97_maps_to_infra_90(self):
        rc, lines = self.run_cli(['--no-fallback', 'go', 'test', './...'], 97,
                                 'offbox: Go repair: lock\noffbox-setup-failed\n', setup_history=True)
        self.assertEqual(rc, 90)
        self.assertIn('offbox: box setup failed (exit 97), not your command', lines)

    def test_user_97_without_marker_stays_97(self):
        rc, lines = self.run_cli(['go', 'test', './...'], 97, 'FAIL\n')
        self.assertEqual(rc, 97)
        self.assertEqual(lines[-1], 'offbox: remote exit 97')

    def test_repo_setup_98_maps_to_infra_90(self):
        rc, lines = self.run_cli(['--no-fallback', '--step', 'java -version'], 98,
                                 'offbox-repo-setup-failed\n', setup_history=True)
        self.assertEqual(rc, 90)
        self.assertIn('offbox: repo toolchain setup failed (exit 98), not your command', lines)

    def test_user_98_without_marker_stays_98(self):
        rc, lines = self.run_cli(['--step', 'exit 98'], 98, 'offbox step 1 rc=98: exit 98\n')
        self.assertEqual(rc, 98)
        self.assertEqual(lines[-1], 'offbox: remote exit 98')

    def test_setup_failure_error_is_infra_code(self):
        self.assertEqual(OffboxError('x', code=EXIT_INFRA).code, 90)


class TypecheckSizeTests(unittest.TestCase):

    def repo(self, with_package=True):
        d = tempfile.TemporaryDirectory()
        if with_package:
            Path(d.name, 'package.json').write_text('{}')
        return d

    def test_typecheck_gets_xlarge(self):
        with self.repo() as r:
            self.assertEqual(lease.typecheck_size('cd apps/server && vp run typecheck', r, None), 'xlarge')
            self.assertEqual(lease.typecheck_size('npx tsc --noEmit -p apps/server', r, None), 'xlarge')

    def test_explicit_size_wins(self):
        with self.repo() as r:
            self.assertEqual(lease.typecheck_size('cd apps/server && vp run typecheck', r, 'large'), 'large')

    def test_non_typecheck_keeps_default(self):
        with self.repo() as r:
            self.assertIsNone(lease.typecheck_size('vp test run src/x', r, None))

    def test_no_package_json_keeps_default(self):
        with self.repo(with_package=False) as r:
            self.assertIsNone(lease.typecheck_size('npx tsc --noEmit', r, None))


class AutoSizeTests(Isolated):

    def ident(self, d, key="repo"):
        return {'repo_root': d, 'repo_key': key}

    def size(self, cmd, d, key='repo', explicit=None):
        return lease.auto_size(self.con, cmd, self.ident(d, key), explicit)[0]

    def test_ordinary_runs_take_the_template_size(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'package.json').write_text('{}')
            for cmd in ('npm ci', 'npx jest', 'go test ./...', 'uv run pytest -q tests', 'make test',
                        'docker run --rm alpine true'):
                self.assertIsNone(self.size(cmd, d), cmd)

    def test_explicit_size_wins(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.size('docker compose up -d', d, explicit='large'), 'large')
            self.assertEqual(self.size('docker compose up -d', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('go test ./...', d, explicit='default'), 'default')

    def test_explicit_xlarge_without_a_reason_runs_on_large(self):
        with tempfile.TemporaryDirectory() as d:
            got, why = lease.auto_size(self.con, 'uv sync --frozen && uv run pytest -q tests', self.ident(d), 'xlarge')
            self.assertEqual(got, 'large')
            self.assertIn('OFFBOX_ALLOW_XLARGE=1', why)
            with patch.dict(os.environ, {'OFFBOX_ALLOW_XLARGE': '1'}):
                self.assertEqual(self.size('uv run pytest -q tests', d, explicit='xlarge'), 'xlarge')
            Path(d, 'package.json').write_text('{}')
            self.assertEqual(self.size('npx tsc --noEmit', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('docker build -t x .', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('make test-integration', d, explicit='xlarge'), 'large')
            Path(d, 'compose.yaml').write_text('services: {}\n')
            self.assertEqual(self.size('make test-integration', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('go test ./...', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('uv run pytest -q tests', d, explicit='xlarge'), 'xlarge')
            for narrow in ('go test -run TestParse ./internal/parser', 'pytest tests/test_parser.py::test_one',
                           'pytest tests/test_parser.py', 'uv run pytest -q tests/parser_test.py',
                           './gradlew help', 'npx vitest run src/a.test.ts'):
                self.assertEqual(self.size(narrow, d, explicit='xlarge'), 'large', narrow)

    def test_explicit_xlarge_kept_for_js_suites_in_testcontainers_repo(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'package.json').write_text('{"devDependencies":{"testcontainers":"^10"}}')
            for cmd in ('npx vitest run', 'pnpm test', 'vp test run', 'npm run test', 'node --test scripts/'):
                self.assertEqual(self.size(cmd, d, explicit='xlarge'), 'xlarge', cmd)
            self.assertEqual(self.size('npx eslint .', d, explicit='xlarge'), 'large')

    def test_explicit_xlarge_kept_after_same_kind_oom_on_large(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'uv run pytest -n auto tests', 'large')
            self.assertEqual(self.size('uv run pytest -q tests/x', d, explicit='xlarge'), 'xlarge')
            self.assertEqual(self.size('go test ./pkg', d, explicit='xlarge'), 'large')

    def test_container_stacks_get_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self.size('docker compose up -d && ./health.sh', d), 'xlarge')
            self.assertEqual(self.size('localstack start -d', d), 'xlarge')
            self.assertEqual(self.size('bash tmp/hc-005/check.sh', d, key='crpko-integration-harness'), 'xlarge')

    def test_whole_suite_in_testcontainers_repo_gets_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'go.mod').write_text('module x\nrequire github.com/testcontainers/testcontainers-go v0.1\n')
            self.assertEqual(self.size('go test ./...', d), 'xlarge')
            self.assertIsNone(self.size('go test -run TestX ./internal/pkg', d))
            self.assertIsNone(self.size('go vet ./internal/a ./internal/b', d))

    def test_typecheck_still_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, 'package.json').write_text('{}')
            self.assertEqual(self.size('npx tsc --noEmit -p apps/server', d), 'xlarge')

    def oom(self, d, cmd, size, age=3600, key='repo', box='bx_o'):
        self.con.execute("INSERT OR IGNORE INTO leases(box_id,owner,repo_root,repo_key,remote_dir) VALUES (?,'o',?,?,'r')",
                         (box, d, key))
        self.con.execute("INSERT INTO runs(run_id,box_id,size,exit_code,start_at,cmd) VALUES (?,?,?,137,?,?)",
                         (f'r{time.time_ns()}', box, size, time.time() - age, cmd))
        self.con.commit()

    def test_recent_oom_bumps_the_same_kind_one_size(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'npx vitest run', 'large')
            self.assertEqual(self.size('npx vitest run src/x', d), 'xlarge')
            self.assertIsNone(self.size('npx vitest run', d, key='other'))
            self.assertIsNone(self.size('go test -run TestX ./internal/pkg', d))

    def test_oom_on_default_box_bumps_to_large_not_xlarge(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'timeout 1800 uv run pytest -n auto -q tests', 'default')
            self.assertEqual(self.size('uv run pytest -q tests/test_a.py', d), 'large')

    def test_old_oom_is_forgotten_after_three_days(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'npx vitest run', 'large', age=4 * 86400)
            self.assertIsNone(self.size('npx vitest run', d))

    def test_install_before_the_job_does_not_match_every_command(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'pnpm i --frozen-lockfile ; cd apps/server && vp run typecheck', 'large')
            self.assertIsNone(self.size('pnpm i --frozen-lockfile ; vp test run apps/web', d))
            self.oom(d, 'npm ci', 'large')
            self.assertEqual(self.size('npm ci', d), 'xlarge')

    def test_command_kinds(self):
        k = lease.command_kinds
        self.assertEqual(k('timeout 1800 uv run pytest -n auto -q tests'), {'pytest'})
        self.assertEqual(k('GOFLAGS=-mod=mod go vet ./...'), {'vet'})
        self.assertEqual(k('cd apps && npx tsc --noEmit ; npx vp test run x'), {'tsc', 'test'})
        self.assertEqual(k('make test-integration'), {'make test-integration'})
        self.assertNotEqual(k('make type'), k('make test'))
        self.assertEqual(k('uv sync --frozen'), {'install'})
        self.assertEqual(k('set -o pipefail; uv run pytest tests'), {'pytest'})
        self.assertEqual(k('set -o pipefail; go vet ./pkg'), {'vet'})
        self.assertEqual(k('uv run --with y pytest tests'), {'pytest'})
        self.assertEqual(k('nice -n 10 go test ./...'), {'test'})
        self.assertEqual(k('timeout --signal=KILL 1800 uv run pytest -q'), {'pytest'})
        self.assertEqual(k("bash -c 'cd core && GOTOOLCHAIN=local go test -race ./...'"), {'test'})
        self.assertEqual(k("npx -y -p node@22 -p npm@10 -c 'node --version'"), {'node'})
        self.assertEqual(k('timeout 30m uv run pytest tests'), {'pytest'})
        self.assertEqual(k('npx vitest@3 run src/a.test.ts'), {'vitest'})
        self.assertEqual(k('npx --yes pnpm@11.10.0 install --frozen-lockfile'), {'install'})
        self.assertEqual(k('xvfb-run -a pytest -q tests/a.py'), {'pytest'})
        self.assertEqual(k('make -C backend test'), {'make test'})
        self.assertNotEqual(k('make -C backend test'), k('make -C backend lint'))
        self.assertEqual(k('exec uv run pytest tests'), {'pytest'})
        self.assertEqual(k('bash -lc "exec go test ./pkg"'), {'test'})

    def test_exec_wrapped_oom_still_bumps_the_same_job(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'exec uv run pytest tests', 'large')
            self.assertEqual(self.size('uv run pytest -q tests/x', d), 'xlarge')

    def test_shell_setup_shared_with_an_oom_does_not_bump_other_jobs(self):
        with tempfile.TemporaryDirectory() as d:
            self.oom(d, 'set -o pipefail; uv run pytest tests', 'large')
            self.assertIsNone(self.size('set -o pipefail; go vet ./pkg', d))
            self.assertEqual(self.size('uv run --with y pytest tests', d), 'xlarge')


class ExitHintTests(unittest.TestCase):

    def test_command_not_found_event_uses_received_tail(self):
        row = dict(run_id='r', box_id='B', exit_code=127, mode='bg', end_at=2, start_at=1,
                   process_id=None, wrapper_pid=None)
        for text, name in (('rg: command not found\n', 'rg'),
                           ('bash: line 1: vitest: command not found\n', 'vitest'),
                           ('rg: command not found\ntee: command not found\n', 'rg'),
                           ('\n'.join(['old: command not found'] + ['line'] * 201), None),
                           ('', None)):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as d:
                logs = Path(d)
                (logs / 'r.log').write_text(text)
                with patch.object(runs, 'LOGS_DIR', logs), patch.object(runs, 'event') as event, \
                        patch.object(runs, 'db') as db, patch('toollog.emit'):
                    runs.emit_terminal(row)
                event.assert_called_once_with(db.return_value, 'B', 'command_not_found',
                                              json.dumps({'run': 'r', 'name': name}))

    def test_command_not_found_event_remains_json_at_storage_limit(self):
        row = dict(run_id='r', box_id='B', exit_code=127, mode='bg', end_at=2, start_at=1,
                   process_id=None, wrapper_pid=None)
        for length, expected in ((256, 'x' * 256), (257, None), (2100, None)):
            with self.subTest(length=length), tempfile.TemporaryDirectory() as d:
                logs = Path(d)
                (logs / 'r.log').write_text('x' * length + ': command not found\n')
                con = sqlite3.connect(':memory:')
                con.execute('CREATE TABLE events (ts REAL, box TEXT, kind TEXT, detail TEXT)')
                stored = []
                def record(*args):
                    runs.common.event(*args)
                    stored.append(con.execute('SELECT detail FROM events').fetchone()[0])
                with patch.object(runs, 'LOGS_DIR', logs), patch.object(runs, 'event', side_effect=record), \
                        patch.object(runs, 'db', return_value=con), patch.object(runs.common, 'log'), patch('toollog.emit'):
                    runs.emit_terminal(row)
                self.assertEqual([json.loads(detail) for detail in stored], [{'run': 'r', 'name': expected}])

    def test_137_prints_memory_hint_before_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 137)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[-2], 'offbox: exit 137 = the box killed the command for memory. Rerun with --size xlarge.')
        self.assertEqual(lines[-1], 'offbox: remote exit 137')

    def test_137_in_steps_prints_summary_hint_then_exit_line(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 137, [(1, 0), (2, 137)], 2)
        lines = err.getvalue().strip().splitlines()
        self.assertEqual(lines[0], 'offbox: offbox steps: 1 ok, 1 failed (step 2 rc=137)')
        self.assertEqual(lines[1], 'offbox: exit 137 = the box killed the command for memory. Rerun with --size xlarge.')
        self.assertEqual(lines[-1], 'offbox: remote exit 137')

    def test_plain_failure_has_no_memory_hint(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            runs.report_exit('', 1)
        self.assertNotIn('killed the command for memory', err.getvalue())


if __name__ == '__main__':
    unittest.main()
