"""The Docker start-hook repair in the run preamble, run with real bash against fake systemctl/sudo."""
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs
from offbox_lib.runs import DOCKER_REPAIR, remote_script

SKILL = Path(__file__).resolve().parents[2]
HOOK_SHA = '3957bbeea3293dc6223b6eb1f991310e2857bcff656ac46254311be0a41408d3'

FAKE_SYSTEMCTL = r'''#!/bin/bash
echo "$*" >> "$CALLS"
case "$1" in
  is-failed) grep -qx failed "$STATE" 2>/dev/null; exit $? ;;
  start)
    if [ -n "$HANG_START" ]; then exec sleep 1000; fi
    if [ -n "$START_FAILS" ]; then exit 1; fi
    echo active > "$STATE"; exit 0 ;;
  status) echo 'fake status' ;;
esac
exit 0
'''


# coreutils timeout (Linux boxes); this Mac has none, so the fixture always supplies this shim.
FAKE_TIMEOUT = r'''#!/usr/bin/env python3
import subprocess, sys
try:
    sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
'''


class DockerHookFixture:
    def __init__(self, home, dropin=True, failed=False, sudo_ok=True, start_fails=False, hang_start=False):
        self.home = Path(home)
        self.dropin = self.home / 'etc/systemd/system/docker.service.d'
        self.bindir = self.home / 'usr/local/bin'
        self.dropin.mkdir(parents=True)
        self.bindir.mkdir(parents=True)
        if dropin:
            # Same rewritten path as the script's grep pattern, so the match is exercised.
            (self.dropin / 'firewall.conf').write_text(
                f'[Service]\nExecStartPost={self.bindir}/sync-docker-firewall\n')
        self.state = self.home / 'state'
        self.state.write_text('failed\n' if failed else 'active\n')
        self.calls = self.home / 'calls'
        self.bins = self.home / 'bin'
        self.bins.mkdir()
        self.tool('systemctl', FAKE_SYSTEMCTL)
        self.tool('sudo', '#!/bin/bash\nshift; exec "$@"\n' if sudo_ok else '#!/bin/bash\nexit 1\n')
        self.tool('timeout', FAKE_TIMEOUT)
        self.script = DOCKER_REPAIR.replace('/etc/systemd/system/docker.service.d', str(self.dropin)).replace(
            '/usr/local/bin', str(self.bindir)) + '\necho USER_COMMAND\n'
        self.env = dict(os.environ, HOME=str(self.home), CALLS=str(self.calls), STATE=str(self.state),
                        PATH=f'{self.bins}:/usr/bin:/bin:/usr/sbin:/sbin')
        if start_fails:
            self.env['START_FAILS'] = '1'
        if hang_start:
            self.env['HANG_START'] = '1'
            self.env['OFFBOX_DOCKER_TIMEOUT'] = '1'

    def tool(self, name, body):
        path = self.bins / name
        path.write_text(body)
        path.chmod(0o755)

    def run(self):
        result = subprocess.run(['bash', '-c', self.script], env=self.env, capture_output=True, text=True, timeout=30)
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return result, calls

    def hook(self):
        return self.bindir / 'sync-docker-firewall'


class DockerHookTests(unittest.TestCase):
    def test_a_missing_hook_and_failed_docker_are_repaired(self):
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home, failed=True)
            result, calls = fx.run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(hashlib.sha256(fx.hook().read_bytes()).hexdigest(), HOOK_SHA)
            self.assertEqual(fx.hook().stat().st_mode & 0o777, 0o755)
            self.assertIn('reset-failed docker', calls)
            self.assertIn('start docker', calls)
            self.assertLess(calls.index('reset-failed docker'), calls.index('start docker'))
            self.assertIn('USER_COMMAND', result.stdout)
            self.assertIn('restoring boat docker hook', result.stderr)

    def test_b_present_hook_and_healthy_docker_are_untouched(self):
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home)
            fx.hook().write_text('#!/bin/bash\necho mine\n')
            fx.hook().chmod(0o755)
            before = fx.hook().read_bytes()
            result, calls = fx.run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(fx.hook().read_bytes(), before)
            self.assertEqual(calls, ['is-failed --quiet docker'])
            self.assertIn('USER_COMMAND', result.stdout)

    def test_c_no_dropin_means_no_systemctl_and_no_hook(self):
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home, dropin=False, failed=True)
            result, calls = fx.run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls, [])
            self.assertFalse(fx.hook().exists())
            self.assertIn('USER_COMMAND', result.stdout)

    def test_d_sudo_failure_is_not_fatal(self):
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home, failed=True, sudo_ok=False)
            result, _ = fx.run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(fx.hook().exists())
            self.assertIn('USER_COMMAND', result.stdout)
            self.assertIn('could not restore the docker hook', result.stderr)

    def test_e_docker_start_failure_is_not_fatal(self):
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home, failed=True, start_fails=True)
            result, _ = fx.run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('USER_COMMAND', result.stdout)
            self.assertIn('docker still fails to start', result.stderr)

    def test_h_hanging_docker_start_is_bounded_and_does_not_block_the_command(self):
        import time
        with tempfile.TemporaryDirectory() as home:
            fx = DockerHookFixture(home, failed=True, hang_start=True)
            started = time.monotonic()
            result, _ = fx.run()
            self.assertLess(time.monotonic() - started, 25, 'repair must give up on a stalled docker start')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('USER_COMMAND', result.stdout)
            self.assertIn('docker still fails to start (or timed out)', result.stderr)

    def test_f_vendored_hook_matches_boat_hash(self):
        data = (SKILL / 'templates' / 'boat-sync-docker-firewall').read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), HOOK_SHA)

    def test_g_repair_runs_before_wait_images(self):
        with patch.object(runs, 'GO_REPAIR', ':'):
            script = remote_script('w', '.', ['true'], None, 'r')
        self.assertIn(DOCKER_REPAIR, script)
        self.assertLess(script.index(DOCKER_REPAIR), script.index('offbox-wait-images'))
        with tempfile.TemporaryDirectory() as home:
            p = subprocess.run(['bash', '-n', '-c', script], env={'HOME': home, 'PATH': os.environ['PATH']},
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == '__main__':
    unittest.main()
