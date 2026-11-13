"""Install hints and remote activation share the same repository pin policy."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import package_manager, pnpm_version, runs


class PackageManagerPinTests(unittest.TestCase):
    def test_ci_env_reference_scopes_and_forms(self):
        action = '  - uses: pnpm/action-setup@v4\n    with: {version: "${{ env.PNPM_VERSION }}"}\n'
        job = 'jobs:\n  test:\n    steps:\n' + ''.join('    ' + line for line in action.splitlines(keepends=True))
        cases = [
            ('workflow env', 'env:\n  PNPM_VERSION: 10\n' + job, '10'),
            ('workflow env after jobs', job + 'env:\n  PNPM_VERSION: 10\n', '10'),
            ('inline workflow env', 'env: {PNPM_VERSION: 10}\n' + job, '10'),
            ('job env', job + '    env: {PNPM_VERSION: 11.7.0}\n', '11.7.0'),
            ('step env after with', 'steps:\n' + action + '    env: {PNPM_VERSION: 10}\n', '10'),
            ('step env before uses', 'steps:\n  - env: {PNPM_VERSION: 10}\n    uses: pnpm/action-setup@v4\n'
             '    with: {version: "${{ env.PNPM_VERSION }}"}\n', '10'),
            ('named with before uses', 'env: {PNPM_VERSION: 10}\nsteps:\n  - name: Install pnpm\n'
             '    with: {version: "${{ env.PNPM_VERSION }}"}\n    uses: pnpm/action-setup@v4\n', '10'),
            ('flow step', 'steps:\n  - {with: {version: "${{ env.PNPM_VERSION }}"}, '
             'uses: pnpm/action-setup@v4, env: {PNPM_VERSION: 10}}\n', '10'),
            ('indentless sequence', 'env: {PNPM_VERSION: 10}\nsteps:\n' +
             ''.join(line[2:] for line in action.splitlines(keepends=True)), '10'),
            ('same pin in nested scopes', 'env: {PNPM_VERSION: 10}\n' +
             job + '    env: {PNPM_VERSION: 10}\n', '10'),
            ('matrix item anchor is harmless', 'env: {PNPM_VERSION: 10}\n' + job +
             '    strategy:\n      matrix:\n        include:\n          - &linux {os: ubuntu-latest}\n', '10'),
            ('missing env', 'steps:\n' + action, None),
            ('sibling step env', 'steps:\n  - run: echo other\n    env: {PNPM_VERSION: 10}\n' + action, None),
            ('following sibling step env', 'steps:\n' + action +
             '  - run: echo other\n    env: {PNPM_VERSION: 10}\n', None),
            ('sibling job env', 'jobs:\n  other:\n    env: {PNPM_VERSION: 10}\n    steps: []\n' + job[6:], None),
            ('conflicting job env', 'env: {PNPM_VERSION: 10}\n' + job +
             '    env: {PNPM_VERSION: 11}\n', None),
            ('dynamic job override', 'env: {PNPM_VERSION: 10}\n' + job +
             '    env: {PNPM_VERSION: "${{ matrix.pnpm }}"}\n', None),
            ('dynamic step override', 'env: {PNPM_VERSION: 10}\nsteps:\n' + action +
             '    env: {PNPM_VERSION: "${{ inputs.pnpm }}"}\n', None),
            ('dynamic env mapping', 'env: {PNPM_VERSION: 10}\nsteps:\n' + action +
             '    env: ${{ inputs.env }}\n', None),
        ]
        for expression in ('${{ env.PNPM_VERSION }}', '${{env.PNPM_VERSION}}',
                           "${{ env['PNPM_VERSION'] }}", '${{ env["PNPM_VERSION"] }}'):
            for quote in ('', "'", '"'):
                if quote and quote in expression:
                    continue
                cases.append((f'expression {quote}{expression}{quote}', 'env: {PNPM_VERSION: 10}\nsteps:\n'
                              '  - uses: pnpm/action-setup@v4\n    with:\n      version: ' +
                              quote + expression + quote + '\n', '10'))
        for expression in ('env.OTHER_VERSION', "env.PNPM_VERSION || '11'", 'matrix.pnpm',
                           "format('{0}', env.PNPM_VERSION)"):
            cases.append((expression, 'env: {PNPM_VERSION: 10}\nsteps:\n' +
                          action.replace('env.PNPM_VERSION', expression), None))
        for gap in (' ', '  ', '   ', '    '):
            indent = ' ' * (3 + len(gap))
            setup = '  -' + gap + 'uses: pnpm/action-setup@v4\n' + indent + 'with:\n' + indent + \
                    '  version: ${{ env.PNPM_VERSION }}\n'
            cases.append((f'{len(gap)} spaces after dash: sibling env',
                          'steps:\n  - run: echo other\n    env: {PNPM_VERSION: 10}\n' + setup, None))
            cases.append((f'{len(gap)} spaces after dash: own env',
                          'steps:\n' + setup + indent + 'env: {PNPM_VERSION: 10}\n', '10'))
        for scope, indent in (('workflow', ''), ('job', '    '), ('step', '        ')):
            for key in ('env', "'env'", '"env"'):
                for value in ('{PNPM_VERSION: 11}', '\n' + indent + '  PNPM_VERSION: 11'):
                    override = indent + '? ' + key + '\n' + indent + ': ' + value + '\n'
                    workflow = 'env: {PNPM_VERSION: 10}\n' + job
                    cases.append((f'explicit {scope} {key}: {"block" if value.startswith(chr(10)) else "flow"}',
                                  workflow + override, None))
        cases.extend([
            ('explicit env entry', 'env:\n  ? PNPM_VERSION\n  : 10\n' + job, None),
            ('standalone explicit key', 'env: {PNPM_VERSION: 10}\nsteps:\n' + action +
             '    ?\n      env\n    : {PNPM_VERSION: 11}\n', None),
            ('explicit first step key', 'env: {PNPM_VERSION: 10}\nsteps:\n  - ? env\n'
             '    : {PNPM_VERSION: 11}\n    uses: pnpm/action-setup@v4\n'
             '    with: {version: "${{ env.PNPM_VERSION }}"}\n', None),
            ('explicit key in shell scalar is opaque', 'env: {PNPM_VERSION: 10}\nsteps:\n'
             '  - run: |\n      ? env\n      : {PNPM_VERSION: 11}\n' + action, '10'),
        ])
        for key in ('!!str env', '&env-key env', '*env-key'):
            cases.append((f'decorated job key {key}', 'env: {PNPM_VERSION: 10}\n' + job +
                          '    ' + key + ': {PNPM_VERSION: 11}\n', None))
        for key in ('<<', "'<<'", '"<<"'):
            cases.append((f'job merge key {key}', 'env: {PNPM_VERSION: 10}\n' + job +
                          '    ' + key + ': {env: {PNPM_VERSION: 11}}\n', None))
            cases.append((f'env merge key {key}', 'env: {PNPM_VERSION: 10}\n' + job +
                          '    env:\n      OTHER: ignored\n      ' + key + ': {PNPM_VERSION: 11}\n', None))
            for decoration in ('&merge-key', '!!merge', '&merge-key !!merge', '!!merge &merge-key',
                               '!<tag:yaml.org,2002:merge>'):
                for value in ('{env: {PNPM_VERSION: 11}}', '\n      env: {PNPM_VERSION: 11}'):
                    cases.append((f'decorated merge {decoration} {key}: '
                                  f'{"block" if value.startswith(chr(10)) else "flow"}',
                                  'env: {PNPM_VERSION: 10}\n' + job +
                                  '    ' + decoration + ' ' + key + ': ' + value + '\n', None))
        for label, workflow, pin in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(workflow)
                selection = pnpm_version.want(root, root)
                self.assertEqual(selection, (pin, 'ci PNPM_VERSION') if pin else
                                 ('', 'ambiguous CI pnpm version'))
                self.assertEqual(package_manager.install_command(root),
                                 f'corepack pnpm@{pin} install --frozen-lockfile' if pin else '<repo-install>')
                if not pin:
                    result = subprocess.run(['bash', '-c', pnpm_version.block(selection) + '\necho COMMAND_MARKER'],
                                            env={'HOME': tmp, 'PATH': '/usr/bin:/bin'},
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 99, label)
                    self.assertNotIn('COMMAND_MARKER', result.stdout, label)

    def test_ci_env_reference_does_not_cross_workflows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
            workflows = root / '.github/workflows'
            workflows.mkdir(parents=True)
            (workflows / 'a.yml').write_text('env: {PNPM_VERSION: 10}\n')
            (workflows / 'b.yml').write_text('steps:\n  - uses: pnpm/action-setup@v4\n'
                                           '    with: {version: "${{ env.PNPM_VERSION }}"}\n')
            self.assertEqual(pnpm_version.want(root, root), ('', 'ambiguous CI pnpm version'))

    def test_hints_and_actual_pnpm_line_agree(self):
        for manager, workflow, pin, active, source in (
            ('pnpm@11.7.0', 'env:\n  PNPM_VERSION: 10\n', '11.7.0', '11.7.0', 'packageManager'),
            (None, 'env:\n  PNPM_VERSION: 10.26.2\n', '10.26.2', '10.26.2', 'ci PNPM_VERSION'),
            (None, "env:\n  PNPM_VERSION: '10'\njobs:\n  test:\n    steps:\n"
             "      - uses: pnpm/action-setup@v2\n        with:\n          version: ${{ env.PNPM_VERSION }}\n",
             '10', '10.26.2', 'ci PNPM_VERSION'),
            (None, 'steps:\n  - uses: pnpm/action-setup@v4\n    with: {version: 10.26.2}\n',
             '10.26.2', '10.26.2', 'ci pnpm/action-setup'),
            (None, '', '10', '10.26.2', 'lockfile 9.0'),
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'package.json').write_text(json.dumps({'packageManager': manager}))
                (root / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n")
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(workflow)
                selection = pnpm_version.want(root, root)
                self.assertEqual(selection, (pin, source))
                command = f'corepack pnpm@{pin} install --frozen-lockfile'
                self.assertEqual(package_manager.install_command(root), command)
                self.assertIn(command, runs.missing_deps_hint(root))
                hint = io.StringIO()
                with contextlib.redirect_stderr(hint):
                    runs.new_checkout_hint({'_new_checkout': True, 'box_id': 'fixture'}, root)
                self.assertIn(command, hint.getvalue())
                bindir = root / 'bin'
                bindir.mkdir()
                (bindir / 'node').symlink_to(Path(shutil.which('node')).resolve())
                (bindir / 'pnpm').write_text(f'#!/bin/sh\necho {active}\n')
                (bindir / 'pnpm').chmod(0o755)
                (bindir / 'curl').write_text('#!/bin/sh\necho download >> "$HOME/network"\nexit 18\n')
                (bindir / 'curl').chmod(0o755)
                result = subprocess.run(['bash', '-c', pnpm_version.block(selection) + '\necho COMMAND_MARKER'],
                                        env={'HOME': tmp, 'PATH': f'{bindir}:/usr/bin:/bin'},
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'offbox: pnpm v{active} ({source})', result.stderr)
                self.assertIn('COMMAND_MARKER', result.stdout)
                self.assertFalse((root / 'network').exists())

    def test_ambiguous_ci_defers_hint_and_stops_activation(self):
        for workflow in (
            'env:\n  PNPM_VERSION: 10\nsteps:\n  - uses: pnpm/action-setup@v4\n    with: {version: 11}\n',
            'env:\n  PNPM_VERSION: 10\nsteps:\n  - uses: pnpm/action-setup@v4\n    with: {version: "${{ matrix.pnpm }}"}\n',
        ):
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text(workflow)
                self.assertEqual(package_manager.install_command(root), '<repo-install>')
                selection = pnpm_version.want(root, root)
                self.assertEqual(selection, ('', 'ambiguous CI pnpm version'))
                result = subprocess.run(['bash', '-c', pnpm_version.block(selection) + '\necho COMMAND_MARKER'],
                                        env={'HOME': tmp, 'PATH': '/usr/bin:/bin'},
                                        capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 99)
                self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_non_numeric_package_manager_never_becomes_shell_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text(json.dumps({'packageManager': 'pnpm@$(unsafe)'}))
            self.assertEqual(package_manager.install_command(root), '<repo-install>')

    def test_malformed_manifest_does_not_fall_back_to_lockfile(self):
        for manifest in ('{invalid', '[]', 'null'):
            with self.subTest(manifest=manifest), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'package.json').write_text(manifest)
                (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
                self.assertEqual(package_manager.install_command(root), '<repo-install>')
                self.assertEqual(pnpm_version.want(root, root), ('', 'invalid package.json'))

    def test_descriptor_validation_is_shared_by_hints_and_activation(self):
        supported = ('10', '10.26', '10.26.2', '11.7.0', 'v10.26.2', '10.x', '10.*', '10.26.x',
                     '10.26.2+sha224.abcdef', '10.26.2+sha512.ab/c=')
        unsupported = ('10.0.0-rc.1', '10.0.0-beta', '10.0.0-rc.1+sha224.abcdef',
                       '10.26.2+build.1', 'latest', '^10', '10 || 11', '10; unsafe',
                       '10.x.2', '10.*.*', 'https://example.invalid/pnpm.tgz')
        for pin in supported + unsupported:
            for source in ('packageManager', 'ci'):
                with self.subTest(pin=pin, source=source), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
                    if source == 'packageManager':
                        (root / 'package.json').write_text(json.dumps({'packageManager': f'pnpm@{pin}'}))
                    else:
                        (root / '.github/workflows').mkdir(parents=True)
                        (root / '.github/workflows/ci.yml').write_text(
                            'steps:\n  - uses: pnpm/action-setup@v4\n    with:\n      version: ' + json.dumps(pin) + '\n')
                    # CI parsing deliberately accepts only literal numeric descriptors. Other forms defer.
                    accepted = pin in supported and (source == 'packageManager' or
                                                     package_manager.ci_pnpm_version(root) is not None)
                    hint = package_manager.install_command(root)
                    self.assertEqual(hint != '<repo-install>', accepted)
                    selection = pnpm_version.want(root, root)
                    block = pnpm_version.block(selection)
                    self.assertEqual('__offbox_pnpm_pin=' in block, accepted)
                    if accepted:
                        self.assertEqual(hint, f'corepack pnpm@{pin} install --frozen-lockfile')
                    else:
                        result = subprocess.run(['bash', '-c', block + '\necho COMMAND_MARKER'],
                                                env={'HOME': tmp, 'PATH': '/usr/bin:/bin'},
                                                capture_output=True, text=True, timeout=15)
                        self.assertEqual(result.returncode, 99)
                        self.assertNotIn('COMMAND_MARKER', result.stdout)


if __name__ == '__main__':
    unittest.main()
