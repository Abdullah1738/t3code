import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

INSTALL = Path(__file__).resolve().parents[1] / 'install.zsh'
BOOTSTRAP = INSTALL.parents[1] / 'offbox/server/bootstrap.zsh'

@unittest.skipUnless(shutil.which('zsh'), 'installer runs on the Mac with zsh')
class Tests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.bindir = self.root / 'bin'
        self.bindir.mkdir()
        self.local_tmp = self.root / 'tmp'
        self.local_tmp.mkdir()
        (self.root / '.local/share/offbox-person/moni').mkdir(parents=True)
        self.agent_dir = self.root / 'box/person/agent'
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / 'config.json').write_text('{}')
        self.code = self.agent_dir / 'code'
        self.env = {**os.environ, 'HOME': str(self.root),
                    'TMPDIR': str(self.local_tmp),
                    'PATH': str(self.bindir) + ':' + os.environ['PATH'],
                    'INSTALL_LOG': str(self.root / 'calls'),
                    'TAR_LOG': str(self.root / 'tar-calls'),
                    'BOX_HOME': str(self.root / 'box'),
                    'REAL_TAR': shutil.which('tar'), 'REAL_MV': shutil.which('mv')}
        self.fake('offbox', '''import json, os, subprocess, sys
with open(os.environ['INSTALL_LOG'], 'a') as log:
    log.write(json.dumps([os.environ['OFFBOX_THREAD'], os.environ['OFFBOX_BACKEND'], sys.argv[1:]]) + '\\n')
command = sys.argv[4]
if command.startswith('bash -s -- '):
    sys.stdin.buffer.read()
else:
    env = {**os.environ, 'HOME': os.environ['BOX_HOME']}
    sys.exit(subprocess.run(['sh', '-c', command], env=env).returncode)
''')
        self.fake('tar', '''import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
if '-cf' in args:
    with open(os.environ['TAR_LOG'], 'a') as log:
        log.write(json.dumps({'args': args, 'copyfile': os.environ.get('COPYFILE_DISABLE')}) + '\\n')
    # The producer is Mac bsdtar; allow the same test to run with GNU tar on Linux.
    args = [arg for arg in args if arg not in ('--no-xattrs', '--no-mac-metadata')]
    if os.environ.get('FAIL_PRODUCER'):
        # Real tar emits a valid archive for the first tree, then fails on the missing second tree.
        args[-1] = 'integrations/missing-src'
result = subprocess.run([os.environ['REAL_TAR'], *args]).returncode
if '-xf' in args and os.environ.get('FAIL_EXTRACT'):
    (Path(args[args.index('-C') + 1]) / 'partial.ts').write_bytes(b'partial extract')
    sys.exit(73)
sys.exit(result)
''')
        self.fake('mv', '''import os, subprocess, sys
from pathlib import Path
source = Path(sys.argv[1])
if os.environ.get('FAIL_PROMOTION') and source.name == 'code' and source.parent.name.startswith('code.new.'):
    sys.exit(74)
sys.exit(subprocess.run([os.environ['REAL_MV'], *sys.argv[1:]]).returncode)
''')

    def fake(self, name, body):
        path = self.bindir / name
        path.write_text('#!' + sys.executable + ' -I\n' + body)
        path.chmod(0o700)

    def install(self, **env):
        return subprocess.run(['zsh', '-f', str(INSTALL), 'bx_moni', '/usr/local/bin/bun'],
                              env={**self.env, **env}, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]

    def old_code(self):
        self.code.mkdir()
        (self.code / 'old-only.ts').write_bytes(b'old source\x00\xff')
        runner = self.code / 'integrations/moni-box-runner/src/runner.ts'
        runner.parent.mkdir(parents=True)
        runner.write_bytes(b'old runner')

    def snapshot(self):
        return {str(path.relative_to(self.code)): path.read_bytes() if path.is_file() else None
                for path in self.code.rglob('*')}

    def assert_clean_stage(self):
        self.assertEqual(list(self.agent_dir.glob('code.new.*')), [])
        self.assertEqual(list(self.local_tmp.iterdir()), [])
        self.assertEqual((self.agent_dir / 'config.json').read_text(), '{}')

    def test_valid_exact_box_install_uses_only_person_scoped_explicit_ssh(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('curl -fsS http://127.0.0.1:19466/livez', result.stdout)
        self.assertIn('boxLivezPort if overridden', result.stdout)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[:2] == ['person:moni', 'server'] and
                            call[2][:3] == ['ssh', 'bx_moni', '--'] for call in calls), calls)
        self.assertTrue((self.code / 'integrations/moni-box-runner/src/runner.ts').is_file())
        self.assertEqual(self.code.stat().st_mode & 0o777, 0o700)
        self.assert_clean_stage()

    def test_tar_disables_macos_metadata(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = [json.loads(line) for line in (self.root / 'tar-calls').read_text().splitlines()]
        self.assertIn('--no-xattrs', call['args'])
        self.assertIn('--no-mac-metadata', call['args'])
        self.assertEqual(call['copyfile'], '1')

    def test_failed_extract_preserves_existing_code_and_stops_setup(self):
        self.old_code()
        before = self.snapshot()
        result = self.install(FAIL_EXTRACT='1')
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.calls()), 1)
        self.assert_clean_stage()

    def test_failed_first_extract_leaves_no_code(self):
        result = self.install(FAIL_EXTRACT='1')
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertFalse(self.code.exists())
        self.assertEqual(len(self.calls()), 1)
        self.assert_clean_stage()

    def test_failed_producer_preserves_existing_code_and_never_calls_box(self):
        self.old_code()
        before = self.snapshot()
        result = self.install(FAIL_PRODUCER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.root / 'calls').exists())
        self.assert_clean_stage()

    def test_failed_first_producer_leaves_no_code_and_never_calls_box(self):
        result = self.install(FAIL_PRODUCER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.code.exists())
        self.assertFalse((self.root / 'calls').exists())
        self.assert_clean_stage()

    def test_successful_extract_replaces_existing_code(self):
        self.old_code()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.code / 'old-only.ts').exists())
        for source in ['moni-box-runner/src/runner.ts', 'moni-box-runner/src/stats.ts', 'spectrum-bridge/src/main.ts']:
            self.assertEqual((self.code / 'integrations' / source).read_bytes(),
                             (INSTALL.parents[1] / source).read_bytes())
        self.assertEqual(len(self.calls()), 2)
        self.assert_clean_stage()

    def test_failed_promotion_restores_existing_code(self):
        self.old_code()
        before = self.snapshot()
        result = self.install(FAIL_PROMOTION='1')
        self.assertEqual(result.returncode, 74, result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.calls()), 1)
        self.assert_clean_stage()

    def test_failed_first_promotion_leaves_no_code(self):
        result = self.install(FAIL_PROMOTION='1')
        self.assertEqual(result.returncode, 74, result.stderr)
        self.assertFalse(self.code.exists())
        self.assertEqual(len(self.calls()), 1)
        self.assert_clean_stage()

    def test_sibling_bootstrap_tar_disables_macos_metadata(self):
        # Run just the producer and discard its stream, never bootstrap a host.
        script = BOOTSTRAP.read_text()
        producer = script[script.index('      COPYFILE_DISABLE=1 tar'):].split('|', 1)[0]
        result = subprocess.run(['zsh', '-f', '-c', 'HERE=$1\n' + producer, 'test', str(BOOTSTRAP.parent)],
                                env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        call, = [json.loads(line) for line in (self.root / 'tar-calls').read_text().splitlines()]
        self.assertIn('--no-xattrs', call['args'])
        self.assertIn('--no-mac-metadata', call['args'])
        self.assertEqual(call['copyfile'], '1')

    def test_invalid_targets_never_invoke_offbox(self):
        for box, bun in [('owner;touch', '/bin/bun'), ('bx_moni', '/bin/bun;touch'), ('', '/bin/bun')]:
            result = subprocess.run(['zsh', '-f', str(INSTALL), box, bun], env=self.env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls').exists())

if __name__ == '__main__': unittest.main()
