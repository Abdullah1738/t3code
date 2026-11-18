import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

INSTALL = Path(__file__).resolve().parents[1] / 'install.zsh'

@unittest.skipUnless(shutil.which('zsh'), 'installer runs on the Mac with zsh')
class Tests(unittest.TestCase):
    def test_valid_exact_box_install_uses_only_person_scoped_explicit_ssh(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); bindir = root / 'bin'; bindir.mkdir()
            (root / '.local/share/offbox-person/moni').mkdir(parents=True)
            fake = bindir / 'offbox'
            fake.write_text('#!/bin/sh\nprintf "%s:%s:%s\\n" "$OFFBOX_THREAD" "$OFFBOX_BACKEND" "$*" >> "$INSTALL_LOG"\ncat >/dev/null\n')
            fake.chmod(0o700)
            env = {**os.environ, 'HOME': td, 'PATH': str(bindir) + ':' + os.environ['PATH'], 'INSTALL_LOG': str(root / 'calls')}
            result = subprocess.run(['zsh', '-f', str(INSTALL), 'bx_moni', '/usr/local/bin/bun'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = (root / 'calls').read_text().splitlines()
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(line.startswith('person:moni:server:ssh bx_moni -- ') for line in calls), calls)

    def test_invalid_targets_never_invoke_offbox(self):
        for box, bun in [('owner;touch', '/bin/bun'), ('bx_moni', '/bin/bun;touch'), ('', '/bin/bun')]:
            result = subprocess.run(['zsh', '-f', str(INSTALL), box, bun], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__': unittest.main()
