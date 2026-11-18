"""Exact Bun selection and remote installation."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import bun_version as bun, common, lease, runs


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#!/bin/bash\n' + text)
    path.chmod(0o755)


class PickerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repo'
        self.cwd = self.root / 'sub/deep'
        self.cwd.mkdir(parents=True)

    def write(self, path, text):
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def pkg(self, path='package.json', **data):
        self.write(path, json.dumps(data))

    def want(self, words=('bun test',), **kwargs):
        return bun.want(self.root, self.cwd, words, **kwargs)

    def test_source_precedence(self):
        self.pkg(packageManager='bun@1.2.3+sha512.abc')
        self.write('.bun-version', 'v1.3.4\n\t')
        self.assertEqual(self.want(mac='1.4.1', env='1.5.6'), bun.Choice('1.5.6', 'env'))
        self.assertEqual(self.want(mac='1.4.1'), bun.Choice('1.3.4', '.bun-version'))
        (self.root / '.bun-version').unlink()
        self.assertEqual(self.want(mac='1.4.1'), bun.Choice('1.2.3', 'packageManager'))
        (self.root / 'package.json').unlink()
        self.assertEqual(self.want(mac='1.4.1'), bun.Choice('1.4.1', 'mac'))
        self.assertEqual(self.want(), bun.Choice(common.OFFBOX_BUN_DEFAULT, 'default'))

    def test_parent_walk_and_priority(self):
        (self.root.parent / '.bun-version').write_text('9.9.9')
        self.write('.bun-version', '1.2.3')
        self.pkg('sub/deep/package.json', packageManager='bun@2.3.4')
        self.assertEqual(self.want().wanted, '1.2.3')
        self.write('sub/.bun-version', '3.4.5')
        self.assertEqual(self.want().wanted, '3.4.5')
        (self.root / 'sub/.bun-version').unlink()
        (self.root / '.bun-version').unlink()
        self.pkg(packageManager='bun@4.5.6')
        self.assertEqual(self.want().wanted, '2.3.4')
        (self.root / 'sub/deep/package.json').unlink()
        (self.root / 'package.json').unlink()
        self.assertEqual(self.want(mac='1.4.1').source, 'mac')

    def test_usage_class(self):
        for text, expected in [('bunx tsc', True), ('bun test', True), ('bun --version && echo ok', True),
                               ('/a/bin/bun test', True), ('"bunx" tsc', True), ('bash -c "bun test"', True),
                               ('./node_modules/.bin/bun test', True), ('~/tools/bunx tsc', True),
                               ('tools/bun test', True), ('echo bun', True), ('echo "bun"', True),
                               ('npm install @types/bun', False), ('npm install @types/bunx', False),
                               ('npm install bun@1.4.1', False), ('echo bun:test', False),
                               ('cat /tmp/bun/log', False), ('cat ./bun/test.ts', False),
                               ('echo https://example.test/bun', False), ('echo $bun', False),
                               ('echo $(bun --version)', True), ('echo `bun --version`', True),
                               ('bundle test', False), ('bun-test', False), ('echo bun.lock', False),
                               ('echo bunx.js', False), ('python3 tests.py', False)]:
            with self.subTest(text=text):
                self.assertEqual(self.want(words=[text]) is not None, expected)
        self.write('.bun-version', '1.4.1')
        self.pkg(packageManager='bun@1.4.1')
        self.assertIsNone(self.want(words=['true'], env='invalid'))
        self.assertEqual(bun.block(None), '')
        for name in ('bun.lock', 'bun.lockb'):
            self.write(name, '')
            self.assertIsNotNone(self.want(words=['true']))
            (self.root / name).unlink()
        (self.root.parent / 'bun.lock').touch()
        self.assertIsNone(self.want(words=['true']))

    def test_parameter_expansion_forms_are_not_tool_words(self):
        for value in ('$bun', '$bunx', '${bun}', '${bunx}', '${#bun}', '${!bun}',
                      '${bun[0]}', '${array[bun]}', '${bun:-fallback}', '${bun:=fallback}',
                      '${bun:+alternate}', '${bun:?error}', '${bun:1:2}', '${bun#prefix}',
                      '${bun%%suffix}', '${bun/from/to}', '${bun^^}', '${!bun@}',
                      'bun=value', 'BUN=bun'):
            with self.subTest(value=value):
                self.assertIsNone(self.want(words=['printf "%s\\n" "' + value + '"']))

    def test_invalid_pins_warn_and_fall_through(self):
        for text in ('1.4', '^1.4.1', '1.4.x', 'latest', '1.4.1-beta', '1.4.1\n1.4.2', ' 1.4.1', '01.4.1'):
            with self.subTest(pin=text):
                self.write('.bun-version', text)
                choice = self.want(mac='1.4.1')
                self.assertEqual(choice.source, 'mac')
                self.assertEqual(len(choice.warnings), 1)
                self.assertIn('.bun-version', choice.warnings[0])
        (self.root / '.bun-version').unlink()
        for text in ('{bad', '[]', '"text"'):
            self.write('package.json', text)
            choice = self.want(mac='1.4.1')
            self.assertEqual(choice.source, 'mac')
            self.assertEqual(len(choice.warnings), 1)
            self.assertIn('package.json', choice.warnings[0])
        for pin in ('bun@^1.4.1', 'bun@1.4', 'bun@v1.4.1', 'bun@1.4.1-beta', 'bun@1.4.1+other', 42):
            self.pkg(packageManager=pin)
            choice = self.want(mac='1.4.1')
            self.assertEqual(choice.source, 'mac')
            self.assertEqual(len(choice.warnings), 1)
        self.pkg(packageManager='bun@1.4.2')
        self.assertEqual(self.want(env='v1.4.3').wanted, '1.4.2')
        self.write('sub/package.json', '{bad')
        self.assertEqual(self.want().wanted, '1.4.2')

    def test_engines_warn_only(self):
        for spec, warning in [('>=1.4.2', 'outside'), ('>=1.4.0 <2', None), ('^1.4.1', None),
                              ('~1.3.0', 'outside'), ('>=2 <1', 'outside'), ('junk', 'cannot parse'),
                              (42, 'cannot parse')]:
            with self.subTest(spec=spec):
                self.pkg(engines={'bun': spec})
                choice = self.want(mac='1.4.1')
                self.assertEqual(choice.wanted, '1.4.1')
                self.assertEqual(choice.source, 'mac')
                if warning:
                    self.assertEqual(len(choice.warnings), 1)
                    self.assertIn(warning, choice.warnings[0])
                else:
                    self.assertEqual(choice.warnings, ())

    def test_mac_probe_is_direct_and_bounded(self):
        with patch.object(bun.shutil, 'which', return_value='/real/bin/bun'), \
             patch.object(bun.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '1.4.1\n')) as run:
            self.assertEqual(bun.mac_version(), '1.4.1')
            run.assert_called_once_with(['/real/bin/bun', '--version'], capture_output=True, text=True, timeout=3)
        for failure in (OSError('missing'), subprocess.TimeoutExpired('bun', 3)):
            with patch.object(bun.shutil, 'which', return_value='/bin/bun'), \
                 patch.object(bun.subprocess, 'run', side_effect=failure):
                self.assertIsNone(bun.mac_version())
        with patch.object(bun.shutil, 'which', return_value=None):
            self.assertIsNone(bun.mac_version())


@unittest.skipUnless(shutil.which('flock') and shutil.which('unzip'), 'Linux installer needs flock and unzip')
class BlockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.bin = self.home / 'tools'
        self.bin.mkdir()
        self.cache = self.home / '.bun-versions/1.4.1/bin'
        self.archive = self.home / 'release.zip'
        self.release()
        executable(self.bin / 'uname', 'echo "${FAKE_ARCH:-x86_64}"\n')
        executable(self.bin / 'curl', '''echo "$*" >> "$HOME/downloads"
[ "${FAIL_DOWNLOAD:-0}" != 1 ] || exit 22
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then cp "$HOME/release.zip" "$2"; exit; fi
  shift
done
exit 2
''')
        self.env = {'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin'}

    def release(self, version='1.4.1', arch='x64'):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr(f'bun-linux-{arch}/bun', f'#!/bin/bash\necho {version}\n')

    def run_block(self, box='1.4.4', steps=None, **env):
        if box:
            executable(self.bin / 'bun', f'echo {box}\n')
        script = bun.block(bun.Choice('1.4.1', 'mac'))
        script += '\n' + (runs.steps_block(steps) if steps else 'bun --version; bunx --version')
        return subprocess.run(['bash', '-c', script], env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def assert_choice(self, result, had, used):
        self.assertEqual(result.returncode, 0, result.stderr)
        state = bun.result(result.stderr)
        self.assertIsNotNone(state, result.stderr)
        self.assertEqual({k: v for k, v in state.items() if k != 'install_s'},
                         dict(wanted='1.4.1', source='mac', box_had=had, used=used))
        if used == 'installed':
            self.assertIsInstance(state['install_s'], float)
            self.assertGreaterEqual(state['install_s'], 0)
            self.assertIn(f"installed in {state['install_s']:.1f}s)", result.stderr)
        else:
            self.assertIsNone(state['install_s'])
            self.assertIn(f'offbox: bun 1.4.1 (from mac; box had {had}; {used})', result.stderr)
        self.assertEqual(result.stderr.count('offbox: bun '), 1)

    def test_box_exact_match_no_download_and_pins_bunx(self):
        executable(self.bin / 'bunx', 'echo WRONG\n')
        result = self.run_block(box='1.4.1')
        self.assert_choice(result, '1.4.1', 'box')
        self.assertEqual(result.stdout.splitlines(), ['1.4.1', '1.4.1'])
        self.assertFalse((self.home / 'downloads').exists())

    def test_newer_older_missing_install(self):
        for box in ('1.4.4', '1.3.14', None):
            with self.subTest(box=box):
                if self.cache.parent.exists():
                    shutil.rmtree(self.cache.parent)
                if (self.bin / 'bun').exists():
                    (self.bin / 'bun').unlink()
                self.assert_choice(self.run_block(box=box), box or 'none', 'installed')
                self.assertTrue((self.cache / 'bunx').is_symlink())

    def test_cached_version_all_steps(self):
        executable(self.cache / 'bun', 'echo 1.4.1\n')
        result = self.run_block(steps=['bun --version', 'cd /; bunx --version'])
        self.assert_choice(result, '1.4.4', 'cached')
        self.assertFalse((self.home / 'downloads').exists())
        self.assertEqual(result.stdout.splitlines(), ['1.4.1', '1.4.1'])

    def test_arm64_release(self):
        self.release(arch='aarch64')
        self.assert_choice(self.run_block(FAKE_ARCH='aarch64'), '1.4.4', 'installed')
        self.assertIn('bun-linux-aarch64.zip', (self.home / 'downloads').read_text())

    def test_failed_download_stops_and_never_publishes(self):
        result = self.run_block(FAIL_DOWNLOAD='1')
        self.assertEqual(result.returncode, 99, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertIn('bun 1.4.1: install failed (https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-x64.zip)', result.stderr)
        self.assertFalse(self.cache.exists())
        self.assertEqual(list((self.home / '.bun-versions').glob('.stage.*')), [])

    def test_failed_step_setup_retains_exit_99(self):
        result = self.run_block(steps=['bun --version', 'bunx --version'], FAIL_DOWNLOAD='1')
        self.assertEqual(result.returncode, 99, result.stderr)
        log = self.home / 'run.log'
        log.write_text(result.stderr)
        row = dict(run_id='test', step_count=2, command_id=None, known_exit_code=99)
        self.assertEqual(runs.settled_steps_code(row, result.returncode, log_path=log,
                                                catch_up=False, report=False), 99)
        self.assertEqual(runs.step_results(log), [])

    def test_bad_archive_and_wrong_version_do_not_publish(self):
        for bad in ('corrupt', 'wrong version'):
            with self.subTest(bad=bad):
                if bad == 'corrupt':
                    self.archive.write_text('bad zip')
                else:
                    self.release(version='1.4.4')
                result = self.run_block()
                self.assertEqual(result.returncode, 99)
                self.assertFalse(self.cache.exists())
                self.assertEqual(result.stdout, '')

    def test_invalid_cache_replaced_after_verification(self):
        executable(self.cache / 'bun', 'echo 1.3.14\n')
        self.assert_choice(self.run_block(), '1.4.4', 'installed')

    def test_fresh_bootstrap_download_helper_survives_sqlite_child(self):
        templates = self.home / 'templates'
        (templates / 'tools').mkdir(parents=True)
        source = Path(bun.__file__).resolve().parents[2] / 'templates'
        (templates / 'tools/fetch.sh').write_text((source / 'tools/fetch.sh').read_text())
        (templates / 'tools/sqlite.sh').write_text(':\n')
        (templates / 'common-env.sh').write_text((source / 'common-env.sh').read_text().replace('/home/user', str(self.home)))
        executable(self.bin / 'sudo', 'exit 0\n')
        executable(self.bin / 'git', 'exit 0\n')
        results = []

        def ssh(box, command, *, input, timeout):
            result = subprocess.run(['bash', '-s'], input=input, env=self.env, capture_output=True, timeout=30)
            results.append(result)
            return result

        with patch.object(lease, 'TEMPLATES_DIR', templates), patch.object(lease.ssh_sync, 'ssh', side_effect=ssh):
            lease.bootstrap_fresh('fake-box')
            lease.bootstrap_fresh('fake-box')
        for result in results:
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((self.home / '.bun/bin/bun').resolve(), self.cache / 'bun')
        self.assertEqual((self.home / '.bun/bin/bunx').resolve(), self.cache / 'bun')
        self.assertEqual(len((self.home / 'downloads').read_text().splitlines()), 1)


class IntegrationTests(unittest.TestCase):
    def test_state_json_retains_bun_choice(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'run-test.log'
            log.write_text('offbox: bun 1.4.1 (from mac; box had 1.4.4; installed in 3.1s)\n')
            with patch.object(runs, 'LOGS_DIR', Path(tmp)), patch.object(common, 'LOCKS_DIR', Path(tmp)), \
                    patch.object(common, 'ensure_dirs'):
                runs.space_result('run-test', 0, log)
            state = json.loads((Path(tmp) / 'run-test.state.json').read_text())
            self.assertEqual(state['bun'], dict(wanted='1.4.1', source='mac', box_had='1.4.4', used='installed', install_s=3.1))

    def test_step_setup_evidence_must_belong_to_final_attempt(self):
        failed = 'offbox: toolchain unavailable: bun 1.4.1: install failed; nothing ran (exit 99)\n'
        started = runs.COMMAND_STARTED_MARKER + ' test\n'
        retry = ('offbox-server: the server restarted while this run was going (attempt 1 is lost); '
                 'it is queued again as attempt 2\n')
        self.assertIsNotNone(runs.STEP_RETRY.fullmatch(retry.strip()))
        cases = [(failed, 99), ('', None), (started + failed, None),
                 (failed + retry, None), (failed + retry + failed, 99)]
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'run.log'
            for text, expected in cases:
                with self.subTest(text=text):
                    log.write_text(text)
                    row = dict(run_id='test', step_count=2, command_id=None, known_exit_code=99)
                    self.assertEqual(runs.settled_steps_code(row, 99, log_path=log,
                                                            catch_up=False, report=False), expected)

    def test_log_result_reuse_has_null_install_time(self):
        for used in ('box', 'cached'):
            with self.subTest(used=used):
                state = bun.result(f'offbox: bun 1.4.1 (from mac; box had 1.4.1; {used})\n')
                self.assertEqual(state['used'], used)
                self.assertIsNone(state['install_s'])

    def test_template_default_matches_client(self):
        path = Path(bun.__file__).resolve().parents[2] / 'templates/common-env.sh'
        self.assertIn('OFFBOX_BUN_DEFAULT=' + common.OFFBOX_BUN_DEFAULT, path.read_text())


if __name__ == '__main__':
    unittest.main()
