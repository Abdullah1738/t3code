"""Run a copied deploy script against temporary paths and inert service stubs."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

INTEGRATIONS = Path(__file__).resolve().parents[2]


@unittest.skipUnless(shutil.which('zsh'), 'deploy script requires zsh')
class ExportDeployTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.home_fixture = self.root / 'fixture-home'
        self.script = self.root / 'deploy.zsh'
        # Keep the real HOME untouched; the copy can only write our fixture.
        self.script.write_text((INTEGRATIONS / 'deploy.zsh').read_text().replace('$HOME', str(self.home_fixture)))
        self.scripts = self.root / 'memory-system/scripts'
        self.scripts.mkdir(parents=True)
        self.name = 'com.abdullah.opencode-readonly.plist'
        shutil.copyfile(INTEGRATIONS / 'memory-system/scripts' / self.name, self.scripts / self.name)
        (self.scripts / 'recall').write_text('#!/bin/sh\nexit 0\n')
        (self.scripts / 'install_launchagent.sh').write_text('#!/bin/bash\nexit 0\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, body in (
            ('rsync', 'exit 0'),
            ('launchctl', 'echo unexpected launchctl >&2; exit 99'),
        ):
            path = self.bin / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        self.installed = self.home_fixture / 'Library/LaunchAgents' / self.name

    def run_deploy(self, *args):
        result = subprocess.run(['zsh', '-f', str(self.script), 'memory-system', *args],
                                env={**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH']},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_missing_changed_and_matching_plist_and_dry_run(self):
        output = self.run_deploy('--dry-run')
        self.assertIn('missing or differs', output)
        self.assertIn('bootstrap separately', output)
        self.assertFalse(self.installed.exists())
        output = self.run_deploy()
        self.assertIn('bootstrap/reload requires a separate', output)
        self.assertEqual(self.installed.read_bytes(), (self.scripts / self.name).read_bytes())
        self.assertEqual(self.installed.stat().st_mode & 0o777, 0o644)
        self.assertNotIn('missing or differs', self.run_deploy('--dry-run'))
        self.installed.write_text('drift')
        self.assertIn('missing or differs', self.run_deploy('--dry-run'))
        self.assertEqual(self.installed.read_text(), 'drift')

    def test_launchd_configuration_uses_homebrew_and_recovers_after_crash(self):
        with (self.scripts / self.name).open('rb') as stream:
            config = plistlib.load(stream)
        self.assertTrue(config['KeepAlive'])
        self.assertTrue(config['RunAtLoad'])
        self.assertEqual(config['ProcessType'], 'Interactive')
        self.assertNotIn('LowPriorityIO', config)
        self.assertIn('/opt/homebrew/bin/python3', config['ProgramArguments'])
        self.assertNotIn('/usr/bin/python3', config['ProgramArguments'])
        self.assertEqual(config['ThrottleInterval'], 30)
        for key in ('StandardOutPath', 'StandardErrorPath'):
            self.assertTrue(config[key].endswith('/memory-system/logs/native-export.log'))


if __name__ == '__main__':
    unittest.main()
