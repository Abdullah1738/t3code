"""The guest wrapper keeps a large command in a file across the uid drop."""
import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


class WrapperTests(unittest.TestCase):
    def test_file_route_preserves_shell_arguments_environment_stdin_and_exit(self):
        wrapper = (Path(__file__).resolve().parents[1] / 'server/boatd-wrap').read_text()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            script = root / '7.sh'
            environment = root / 'environment'
            environment.write_text('CACHE_DIR="/cache space"\nPATH=/unwanted\n')
            # Model the privilege boundary without requiring uid 1000 or root on the test host.
            wrapper = wrapper.replace('/run/boatd/', str(root) + '/')
            wrapper = wrapper.replace('/etc/environment', str(environment))
            wrapper = wrapper.replace('chown 1000:1000', 'true')
            wrapper = wrapper.replace('setpriv --reuid=1000 --regid=1000 --init-groups -- ', '')
            for attempt, size in enumerate((0, 200000), 1):
                with self.subTest(size=size):
                    script.write_text('#' + 'x' * size + '\n' + '''
printf '%s\\n' "$0" "$#" "$PWD" "$CACHE_DIR" "$HOME" "${INHERITED-unset}"
if read -r line; then echo unexpected-stdin; exit 1; fi
exit 7
''')
                    p = subprocess.run(['bash', '-c', wrapper, 'boatd-wrap', '7', d, str(attempt)],
                        env={**os.environ, 'INHERITED': 'must be cleared'}, stdin=subprocess.DEVNULL,
                        capture_output=True, text=True, timeout=15)
                    self.assertEqual(p.returncode, 7, p.stderr)
                    self.assertEqual((root/f'7.{attempt}.rc').read_text().strip(), '7')
                    marker = json.loads((root/f'7.{attempt}.started').read_text())
                    self.assertGreater(marker['pid'], 0)
                    self.assertIs(type(marker['cgroup_joined']), bool)
                    self.assertEqual(p.stdout.splitlines(),
                                     ['/bin/bash', '0', str(root.resolve()), '/cache space', '/home/user', 'unset'])

    def test_unwritable_start_marker_prevents_user_command(self):
        wrapper=(Path(__file__).resolve().parents[1]/'server/boatd-wrap').read_text()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            wrapper=wrapper.replace('/run/boatd/',str(root)+'/')
            # An existing marker must retain its earlier evidence and refuse a replacement invocation.
            (root/'7.1.started').write_text('earlier-start-evidence')
            (root/'7.sh').write_text(f'touch {root}/must-not-run\n')
            p=subprocess.run(['bash','-c',wrapper,'boatd-wrap','7',d],capture_output=True,text=True,timeout=15)
            self.assertEqual(p.returncode,126)
            self.assertFalse((root/'must-not-run').exists())
            self.assertEqual((root/'7.1.started').read_text(),'earlier-start-evidence')
