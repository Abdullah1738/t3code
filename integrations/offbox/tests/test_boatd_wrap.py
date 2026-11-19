"""The guest wrapper keeps a large command in a file across the uid drop."""
import os
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

if __package__:
    from .client_fixtures import command_block
else:
    from client_fixtures import command_block


class WrapperTests(unittest.TestCase):
    def test_user_pipeline_sigpipe_and_failures_keep_their_real_status(self):
        wrapper=(Path(__file__).resolve().parents[1]/'server/boatd-wrap').read_text()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            wrapper=wrapper.replace('/run/boatd/',str(root)+'/').replace('/sys/fs/cgroup',str(root/'no-cgroup'))
            wrapper=wrapper.replace('chown 1000:1000','true').replace('setpriv --reuid=1000 --regid=1000 --init-groups -- ','')
            cases=(('yes | head -n 1',0),('yes | head -n 1 | cat',0),
                   ('false | cat',1),('(exit 7) | head -n 1',7))
            for pid,(command,expected) in enumerate(cases,10):
                with self.subTest(command=command):
                    (root/f'{pid}.sh').write_text(command_block(command))
                    result=subprocess.run(['bash','-c',wrapper,'boatd-wrap',str(pid),d],stdin=subprocess.DEVNULL,capture_output=True,timeout=15)
                    self.assertEqual(result.returncode,expected,(root/f'{pid}.receipt/err').read_text())
                    self.assertEqual(int((root/f'{pid}.receipt/exit').read_text()),expected)

    def test_file_route_preserves_shell_arguments_environment_stdin_and_exit(self):
        wrapper = (Path(__file__).resolve().parents[1] / 'server/boatd-wrap').read_text()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            script = root / '7.sh'
            environment = root / 'environment'
            environment.write_text('CACHE_DIR="/cache space"\nPATH=/unwanted\n')
            # Model the privilege boundary without requiring uid 1000 or root on the test host.
            wrapper = wrapper.replace('/run/boatd/', str(root) + '/')
            wrapper = wrapper.replace('/sys/fs/cgroup', str(root / 'no-cgroup'))
            wrapper = wrapper.replace('/etc/environment', str(environment))
            wrapper = wrapper.replace('chown 1000:1000', 'true')
            wrapper = wrapper.replace('setpriv --reuid=1000 --regid=1000 --init-groups -- ', '')
            for pid, size in enumerate((0, 200000), 7):
                with self.subTest(size=size):
                    script = root / f'{pid}.sh'
                    script.write_text('#' + 'x' * size + '\n' + '''
printf '%s\\n' "$0" "$#" "$PWD" "$CACHE_DIR" "$HOME" "${INHERITED-unset}"
if read -r line; then echo unexpected-stdin; exit 1; fi
exit 7
''')
                    p = subprocess.run(['bash', '-c', wrapper, 'boatd-wrap', str(pid), d],
                        env={**os.environ, 'INHERITED': 'must be cleared'}, stdin=subprocess.DEVNULL,
                        capture_output=True, text=True, timeout=15)
                    self.assertEqual(p.returncode, 7, p.stderr)
                    self.assertEqual((root/f'{pid}.receipt/exit').read_text().strip(), '7')
                    self.assertEqual((root/f'{pid}.receipt/out').read_text().splitlines(),
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
