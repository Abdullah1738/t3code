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
    def test_hints_and_actual_pnpm_line_agree(self):
        for manager, workflow, pin, active, source in (
            ('pnpm@11.7.0', 'env:\n  PNPM_VERSION: 10\n', '11.7.0', '11.7.0', 'packageManager'),
            (None, 'env:\n  PNPM_VERSION: 10.26.2\n', '10.26.2', '10.26.2', 'ci PNPM_VERSION'),
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
            'env:\n  PNPM_VERSION: 10\nsteps:\n  - uses: pnpm/action-setup@v4\n    with: {version: "${{ env.PNPM_VERSION }}"}\n',
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
