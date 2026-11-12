"""Installer failure/signal paths with a fixture HOME and fake launchctl."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]


class BackupInstall(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.loaded = self.root / 'loaded'
        self.calls = self.root / 'calls'
        self.plist = self.root / 'Library/LaunchAgents/com.abdullah.memory-backup.plist'
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(plistlib.dumps({'Label': 'com.abdullah.memory-backup'}))
        self.loaded.touch()
        cmd = self.root / 'launchctl'
        cmd.write_text('''#!/usr/bin/python3
import os, pathlib, signal, subprocess, sys
root = pathlib.Path(os.environ['FIXTURE'])
loaded = root / 'loaded'
op = sys.argv[1]
with open(root / 'calls', 'a') as f:
    f.write(op + '\\n')
if op == 'print':
    if not loaded.exists(): sys.exit(113)
    print('state = waiting')
    if os.environ.get('RUNNING'): print('pid = 12345')
elif op == 'bootout':
    if os.environ.get('DELAY_UNLOAD'):
        subprocess.Popen(['/usr/bin/python3', '-c',
                         'import pathlib,time,sys; time.sleep(0.3); pathlib.Path(sys.argv[1]).unlink()', str(loaded)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        loaded.unlink()
    if os.environ.get('INTERRUPT'): os.kill(os.getppid(), int(os.environ['INTERRUPT']))
    if os.environ.get('FAIL_BOOTOUT'): sys.exit(1)
elif op == 'bootstrap':
    fail = root / 'fail-bootstrap'
    if fail.exists():
        fail.unlink()
        sys.exit(1)
    assert pathlib.Path(sys.argv[-1]).exists()
    loaded.touch()
else: raise AssertionError(sys.argv)
''')
        cmd.chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.root), 'FIXTURE': str(self.root),
                    'PATH': str(self.root) + os.pathsep + os.environ['PATH']}

    def run_install(self, *args, **env):
        return subprocess.run(['/bin/bash', str(PACKAGE / 'scripts/install_launchagent.sh'), *args],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=15)

    def test_install_and_repeat(self):
        for _ in range(2):
            result = self.run_install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(self.loaded.exists())
        config = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(config['ProcessType'], 'Interactive')
        self.assertEqual(config['StartInterval'], 14400)
        self.assertFalse(config['RunAtLoad'])
        self.assertEqual(config['ProgramArguments'], ['/usr/bin/caffeinate', '-i', '/bin/bash',
                         str(self.root / '.local/share/memory-system/scripts/memory_backup.sh')])
        for key, filename in [('StandardOutPath', 'backup.out.log'), ('StandardErrorPath', 'backup.err.log')]:
            self.assertEqual(config[key], str(self.root / '.local/share/memory-system/logs' / filename))
        self.assertEqual(self.calls.read_text().count('bootout'), 1)

    def test_unchanged_running_backup_is_left_alone(self):
        self.assertEqual(self.run_install().returncode, 0)
        before = self.plist.read_bytes()
        self.assertEqual(self.run_install(RUNNING='1').returncode, 0)
        self.assertEqual(self.plist.read_bytes(), before)
        self.assertEqual(self.calls.read_text().count('bootout'), 1)

    def test_unchanged_unloaded_backup_is_bootstrapped(self):
        self.assertEqual(self.run_install().returncode, 0)
        self.loaded.unlink()
        self.assertEqual(self.run_install().returncode, 0)
        self.assertTrue(self.loaded.exists())
        self.assertEqual(self.calls.read_text().count('bootout'), 1)
        self.assertEqual(self.calls.read_text().count('bootstrap'), 2)

    def test_unloaded_installs_without_bootout(self):
        self.loaded.unlink()
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('bootout', self.calls.read_text())
        self.assertTrue(self.loaded.exists())

    def test_bootstrap_failure_restores_job(self):
        (self.root / 'fail-bootstrap').touch()
        self.assertNotEqual(self.run_install().returncode, 0)
        self.assertTrue(self.loaded.exists())
        self.assertEqual(self.calls.read_text().count('bootstrap'), 2)

    def test_bootout_error_after_unloading_restores_job(self):
        self.assertNotEqual(self.run_install(FAIL_BOOTOUT='1').returncode, 0)
        self.assertTrue(self.loaded.exists())

    def test_signals_after_unloading_restore_job(self):
        for delayed in ('', '1'):
            for sig in (1, 2, 15):
                with self.subTest(signal=sig, delayed=delayed):
                    self.loaded.touch()
                    self.assertNotEqual(self.run_install(INTERRUPT=str(sig), DELAY_UNLOAD=delayed).returncode, 0)
                    self.assertTrue(self.loaded.exists())

    def test_running_backup_refused_before_mutation(self):
        before = self.plist.read_bytes()
        self.assertNotEqual(self.run_install(RUNNING='1').returncode, 0)
        self.assertTrue(self.loaded.exists())
        self.assertEqual(self.plist.read_bytes(), before)
        self.assertNotIn('bootout', self.calls.read_text())

    def test_dry_run_does_not_call_launchctl_or_write(self):
        before = self.plist.read_bytes()
        self.assertEqual(self.run_install('--dry-run').returncode, 0)
        self.assertEqual(self.plist.read_bytes(), before)
        self.assertFalse(self.calls.exists())
        self.assertFalse((self.root / '.local').exists())


if __name__ == '__main__':
    unittest.main()
