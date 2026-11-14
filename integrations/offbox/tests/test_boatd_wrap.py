"""The guest wrapper keeps a large command in a file across the uid drop."""
import os
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
