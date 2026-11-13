"""Pin precedence and activation against a local registry fixture: no real downloads."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import pnpm_version, node_tools


class SelectionTests(unittest.TestCase):
    def test_precedence_corpus(self):
        cases = [
            ('pnpm@10.26.2', '10', '9.0', ('10.26.2', 'packageManager')),
            ('pnpm@11.7.0', '10', '9.0', ('11.7.0', 'packageManager')),
            ('pnpm@10.26.2+sha512.abcd', None, '9.0', ('10.26.2+sha512.abcd', 'packageManager')),
            (None, '10', '9.0', ('10', 'ci PNPM_VERSION')),
            (None, None, '9.0', ('10', 'lockfile 9.0')),
            (None, None, '6.0', ('8', 'lockfile 6.0')),
            (None, None, '5.4', ('7', 'lockfile 5.4')),
            (None, None, '12.0', ('', 'lockfile 12.0')),
            ('pnpm@11.7.0', '10', None, None),
        ]
        for manager, ci, lock, expected in cases:
            with self.subTest(manager=manager, ci=ci, lock=lock), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'package.json').write_text(json.dumps({'packageManager': manager}))
                if lock:
                    (root / 'pnpm-lock.yaml').write_text(f"lockfileVersion: '{lock}'\n")
                if ci:
                    (root / '.github/workflows').mkdir(parents=True)
                    (root / '.github/workflows/ci.yml').write_text(f"env:\n  PNPM_VERSION: '{ci}'\n")
                self.assertEqual(pnpm_version.want(root, root), expected)

    def test_action_versions_quotes_comments_and_extensions(self):
        for version in ('10', '10.26.2', '11.7.0'):
            for ext in ('yml', 'yaml'):
                for quote in ('', "'", '"'):
                    with self.subTest(version=version, ext=ext, quote=quote), tempfile.TemporaryDirectory() as tmp:
                        root = Path(tmp)
                        (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0')
                        (root / '.github/workflows').mkdir(parents=True)
                        (root / f'.github/workflows/ci.{ext}').write_text(
                            'steps:\n  - name: Install pnpm\n    uses: pnpm/action-setup@v4\n    with:\n'
                            f'      version: {quote}{version}{quote} # comment\n'
                            '  - uses: actions/setup-node@v4\n    with:\n      version: 24\n')
                        self.assertEqual(pnpm_version.want(root, root), (version, 'ci pnpm/action-setup'))

    def test_inline_ci_environment(self):
        for env in ('env: { PNPM_VERSION: 11.7.0 }', 'env: { NODE_VERSION: 22, PNPM_VERSION: \'11.7.0\' }'):
            with self.subTest(env=env), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                (root/'pnpm-lock.yaml').write_text('lockfileVersion: 9.0')
                (root/'.github/workflows').mkdir(parents=True)
                (root/'.github/workflows/ci.yml').write_text(env+'\n')
                self.assertEqual(pnpm_version.want(root,root),('11.7.0','ci PNPM_VERSION'))

    def test_ci_action_input_order_and_flow_mapping(self):
        for fields in (
            '    with:\n      version: 11.7.0\n    uses: pnpm/action-setup@v4',
            '    uses: pnpm/action-setup@v4\n    with: { version: 11.7.0 }',
            '    with: { version: \"11.7.0\", run_install: false }\n    uses: pnpm/action-setup@v4',
            '    uses: pnpm/action-setup@v4\n    with: { run_install: false, version: \'11.7.0\' }',
        ):
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0')
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text('steps:\n  - name: Install pnpm\n' + fields + '\n')
                self.assertEqual(pnpm_version.want(root, root), ('11.7.0', 'ci pnpm/action-setup'))

    def test_ci_step_label_shapes(self):
        for header in ('  - uses: pnpm/action-setup@v4',
                       '  - name: Install pnpm\n    uses: pnpm/action-setup@v4',
                       '  - id: pnpm\n    uses: pnpm/action-setup@v4',
                       '  - uses: pnpm/action-setup@v4\n    name: Install pnpm'):
            with self.subTest(header=header), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0')
                (root / '.github/workflows').mkdir(parents=True)
                (root / '.github/workflows/ci.yml').write_text('steps:\n' + header + '\n    with:\n      version: 11.7.0\n')
                self.assertEqual(pnpm_version.want(root, root), ('11.7.0', 'ci pnpm/action-setup'))


class ActivationTests(unittest.TestCase):
    def run_fixture(self, version='10.26.2', pin=None, failure='once', corrupt=False, warm=False, corepack_cache=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bindir = root / 'bin'; bindir.mkdir()
            node = Path(shutil.which('node')).resolve()
            (bindir / 'node').symlink_to(node)
            suffix = 'mjs' if version.startswith('11.') else 'cjs'
            data = f'console.log("{version}")'.encode()
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode='w:gz') as tar:
                info = tarfile.TarInfo(f'package/bin/pnpm.{suffix}'); info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            body = archive.getvalue()
            (root / 'pnpm.tgz').write_bytes(body + b'corrupt' if corrupt else body)
            integrity = 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()
            (root / 'meta.json').write_text(json.dumps({'version': version, 'dist': {'integrity': integrity}, 'bin': {'pnpm': f'bin/pnpm.{suffix}'}}))
            (root / 'index.json').write_text(json.dumps({'versions': {'12.18.0': {}, version: {}, '10.1.0': {}}}))
            curl = bindir / 'curl'
            curl.write_text('''#!/bin/bash
count=$(cat "$HOME/count" 2>/dev/null || echo 0); count=$((count+1)); echo "$count" > "$HOME/count"
case " $* " in *" --connect-timeout 20 --speed-limit 30720 --speed-time 60 --max-time 600 "*) ;; *) exit 88 ;; esac
if [ "$FAIL" = always ] || { [ "$FAIL" = once ] && [ "$count" = 1 ]; }; then exit 18; fi
while [ $# -gt 0 ]; do
 case "$1" in https://*) url=$1 ;; -o) shift; out=$1 ;; esac
 shift
done
case "$url" in */pnpm) src=index.json ;; *.tgz) src=pnpm.tgz ;; *) src=meta.json ;; esac
cp "$HOME/$src" "$out"
'''); curl.chmod(0o755)
            if warm in ('standalone', 'standalone-symlink'):
                executable = bindir / 'pnpm'
                if warm == 'standalone-symlink':
                    executable = root / 'standalone-pnpm'
                    (bindir / 'pnpm').symlink_to(executable)
                executable.write_text(f'#!/bin/sh\necho {version}\n'); executable.chmod(0o755)
            elif warm:
                corepack = warm in ('corepack', 'corepack-no-manifest')
                pkg = root / ('corepack/v1/pnpm/' + version if corepack else 'global-pnpm')
                if corepack_cache or not corepack:
                    (pkg / 'bin').mkdir(parents=True)
                    (pkg / 'package.json').write_text(json.dumps({'name':'pnpm','version':version,'bin':{'pnpm':f'bin/pnpm.{suffix}'}}))
                    executable = pkg / f'bin/pnpm.{suffix}'
                    executable.write_text('#!/usr/bin/env node\n' + data.decode()); executable.chmod(0o755)
                pnpm = bindir / 'pnpm'
                if corepack:
                    dispatcher = root / 'dispatcher/dist/pnpm.js'
                    (dispatcher.parent / 'lib').mkdir(parents=True)
                    if warm == 'corepack':
                        (dispatcher.parent.parent / 'package.json').write_text(json.dumps({'name':'corepack'}))
                    (dispatcher.parent / 'lib/corepack.cjs').write_text(
                        f'exports.runMain=()=>console.log(process.cwd().endsWith("/outside")?"11.7.0":"{version}")\n')
                    dispatcher.write_text('#!/usr/bin/env node\nrequire("./lib/corepack.cjs").runMain(["pnpm", ...process.argv.slice(2)]);\n')
                    dispatcher.chmod(0o755)
                    pnpm.symlink_to(dispatcher)
                else:
                    pnpm.symlink_to(executable)
            repo = root / 'repo'; (repo / 'apps/server/node_modules/.bin').mkdir(parents=True)
            (repo / 'node_modules/.bin').mkdir(parents=True)
            (repo / 'package.json').write_text('{}')
            for directory, wrong in ((repo, '10.0.0'), (repo / 'apps/server', '9.0.0')):
                executable = directory / 'node_modules/.bin/pnpm'
                executable.write_text(f'#!/bin/sh\necho {wrong}\n'); executable.chmod(0o755)
            script = (pnpm_version.block((pin or version, 'packageManager')) + '\n' + node_tools.block('repo') +
                      f'\ncd {shlex.quote(str(repo))}\necho COMMAND_MARKER\npnpm --version\ncd apps/server\npnpm --version\nbash -c \"pnpm --version\"')
            (root / 'outside').mkdir()
            script += '\ncd ' + shlex.quote(str(root / 'outside')) + '\npnpm --version\nfor i in {1..10}; do cd .; done\n'
            script += 'node -e \'if(process.env.PATH.split(":").filter(x=>x===process.env.__offbox_toolchain_bin).length!==1)process.exit(91)\''
            result = subprocess.run(['bash', '-c', script], env={'HOME': tmp, 'PATH': f'{bindir}:/usr/bin:/bin', 'FAIL': failure, 'COREPACK_HOME':str(root / 'corepack')},
                                    capture_output=True, text=True, timeout=15)
            count = int((root / 'count').read_text()) if (root / 'count').exists() else 0
            if result.returncode == 0:
                self.assertEqual(result.stdout.splitlines()[-4:], [version] * 4)
            if result.returncode == 0 and not warm:
                again = subprocess.run(['bash', '-c', script], env={'HOME': tmp, 'PATH': f'{bindir}:/usr/bin:/bin', 'FAIL': 'always', 'COREPACK_HOME':str(root / 'corepack')},
                                       capture_output=True, text=True, timeout=15)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertEqual(again.stdout.splitlines()[-4:], [version] * 4)
                self.assertEqual(int((root / 'count').read_text()), count)
            if result.returncode:
                self.assertFalse(list((root / '.offbox/toolchains/pnpm').glob('.stage.*')))
                self.assertFalse((root / '.offbox/toolchains/pnpm' / (pin or version)).exists())
            return result, count

    def test_partial_transfer_retry_and_major_resolution(self):
        result, count = self.run_fixture(pin='10')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('offbox: pnpm v10.26.2 (packageManager)', result.stderr)
        self.assertIn('COMMAND_MARKER', result.stdout)
        self.assertEqual(count, 4)

    def test_pnpm_11_mjs_entrypoint(self):
        result, count = self.run_fixture(version='11.7.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('offbox: pnpm v11.7.0', result.stderr)

    def test_retry_exhaustion_stops_before_command(self):
        result, count = self.run_fixture(failure='always')
        self.assertEqual(result.returncode, 99)
        self.assertEqual(count, 3)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_checksum_failure_stops_before_extract_and_command(self):
        result, _ = self.run_fixture(corrupt=True)
        self.assertEqual(result.returncode, 99)
        self.assertIn('checksum mismatch', result.stderr)
        self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_warm_corepack_uses_cached_cli_after_leaving_repo(self):
        for warm in ('corepack', 'corepack-no-manifest'):
            with self.subTest(warm=warm):
                result, count = self.run_fixture(warm=warm, failure='always')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(count, 0)

    def test_corepack_without_resolvable_cli_still_stops_offline(self):
        for warm in ('corepack', 'corepack-no-manifest'):
            with self.subTest(warm=warm):
                result, count = self.run_fixture(warm=warm, corepack_cache=False, failure='always')
                self.assertEqual(result.returncode, 99, result.stderr)
                self.assertEqual(count, 3)
                self.assertNotIn('COMMAND_MARKER', result.stdout)

    def test_warm_pin_has_no_network(self):
        result, count = self.run_fixture(warm=True, failure='always')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(count, 0)

    def test_matching_standalone_without_manifest_runs_offline(self):
        for warm in ('standalone', 'standalone-symlink'):
            for version, pin in (('10.26.2', '10.26.2'), ('10.26.2', '10'), ('11.7.0', '11.7.0')):
                with self.subTest(warm=warm, version=version, pin=pin):
                    result, count = self.run_fixture(version=version, pin=pin, warm=warm, failure='always')
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(count, 0)
                    self.assertIn('COMMAND_MARKER', result.stdout)
                    self.assertIn(f'offbox: pnpm v{version} (packageManager)', result.stderr)

    def test_mismatching_standalone_still_stops_offline(self):
        for warm in ('standalone', 'standalone-symlink'):
            with self.subTest(warm=warm):
                result, count = self.run_fixture(pin='11.7.0', warm=warm, failure='always')
                self.assertEqual(result.returncode, 99, result.stderr)
                self.assertEqual(count, 3)
                self.assertNotIn('COMMAND_MARKER', result.stdout)


if __name__ == '__main__':
    unittest.main()
