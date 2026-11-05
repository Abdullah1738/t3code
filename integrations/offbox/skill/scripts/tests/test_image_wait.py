"""Exercise the actual image-wait preamble with hung tools, without Docker or root."""
import os
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import cli, runs
from test_capacity import Isolated


TIMEOUT = r'''#!/usr/bin/env python3
import os, signal, subprocess, sys
args = sys.argv[1:]
if args[:1] == ['-k']:
    args = args[2:]
seconds = float(args.pop(0).removesuffix('s'))
p = subprocess.Popen(args, start_new_session=True)
try:
    sys.exit(p.wait(timeout=seconds))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    sys.exit(124)
'''

DOCKER = r'''#!/bin/bash
echo "docker $*" >> "$CALLS"
case "$1 $2" in
  'info ') [ "$HANG" = info ] && exec sleep 30; exit 0 ;;
  'image inspect') [ "$HANG" = inspect ] && exec sleep 30; [ "$PRESENT" = 1 ] && exit 0; exit 1 ;;
  'load ') [ "$HANG" = load ] && exec sleep 30; cat >/dev/null; exit 0 ;;
esac
exit 1
'''


class ImageWaitFixture:
    def __init__(self, tmp, hang=''):
        self.root = Path(tmp)
        self.bins = self.root / 'bin'
        self.bins.mkdir()
        self.archive = self.root / 'saved.tar.zst'
        self.archive.write_bytes(b'archive')
        Path(str(self.archive) + '.tags').write_text('image:latest\n')
        self.ready = self.root / 'ready'
        self.calls = self.root / 'calls'
        self.tool('timeout', TIMEOUT)
        self.tool('sudo', '#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n')
        self.tool('flock', '#!/bin/bash\necho "flock $*" >> "$CALLS"\n'
                           '[ "$FLOCK_TIMEOUT" = 1 ] && exit 1\n'
                           '[ "$HANG" = flock ] && exec sleep 30\nexit 0\n')
        self.tool('docker', DOCKER)
        self.tool('zstd', '#!/bin/bash\necho zstd >> "$CALLS"\n'
                          '[ "$HANG" = zstd ] && exec sleep 30\nprintf image\n')
        self.env = dict(os.environ, PATH=f'{self.bins}:/usr/bin:/bin', CALLS=str(self.calls),
                        HANG=hang, PRESENT='0', FLOCK_TIMEOUT='0', OFFBOX_IMAGE_WAIT_SECONDS='1')

    def tool(self, name, script):
        path = self.bins / name
        path.write_text(script)
        path.chmod(0o755)

    def script(self):
        return (runs.IMAGE_WAIT.replace('/home/user/.offbox/images/saved.tar.zst', str(self.archive))
                .replace('/run/offbox-image-restore.lock', str(self.root / 'lock'))
                .replace('/run/offbox-images-ready', str(self.ready))
                .replace('/var/tmp/offbox-image-restore.log', str(self.root / 'restore.log')))

    def run(self):
        return subprocess.run(['bash', '-c', self.script() + '\necho USER_COMMAND\nexit 7\n'],
                              env=self.env, capture_output=True, text=True, timeout=8)

    def invoked(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []


class ImageWaitTests(unittest.TestCase):
    def test_each_stalled_stage_is_bounded_and_user_command_still_runs(self):
        for stage in ('flock', 'info', 'inspect', 'zstd', 'load'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as d:
                fx = ImageWaitFixture(d, stage)
                start = time.monotonic()
                result = fx.run()
                self.assertLess(time.monotonic() - start, 5, stage)
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertIn('USER_COMMAND', result.stdout)
                self.assertIn('kept docker images still loading after 1s; continuing without waiting', result.stderr)
                self.assertFalse(fx.ready.exists(), stage)

    def test_fast_missing_image_loads_before_user_command(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            result = fx.run()
            self.assertEqual(result.returncode, 7, result.stderr)
            self.assertIn('loading kept docker images', result.stderr)
            self.assertNotIn('continuing without waiting', result.stderr)
            self.assertTrue(fx.ready.exists())
            self.assertIn('docker load', fx.invoked())
            self.assertIn('zstd', fx.invoked())

    def test_ready_or_no_archive_skips_every_tool(self):
        for condition in ('ready', 'no_archive'):
            with self.subTest(condition=condition), tempfile.TemporaryDirectory() as d:
                fx = ImageWaitFixture(d)
                if condition == 'ready':
                    fx.ready.touch()
                else:
                    fx.archive.unlink()
                result = fx.run()
                self.assertEqual(result.returncode, 7)
                self.assertEqual(fx.invoked(), [])
                self.assertEqual(result.stderr, '')

    def test_existing_tags_and_absent_tags(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.env['PRESENT'] = '1'
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertTrue(fx.ready.exists())
            self.assertNotIn('docker load', fx.invoked())
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            Path(str(fx.archive) + '.tags').unlink()
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertTrue(fx.ready.exists())
            self.assertIn('docker load', fx.invoked())

    def test_failing_sudo_still_runs_command(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.tool('sudo', '#!/bin/bash\nexit 1\n')
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertIn('USER_COMMAND', result.stdout)
            self.assertIn('could not restore kept docker images', result.stderr)
            self.assertFalse(fx.ready.exists())

    def test_busy_boot_restore_times_out_without_running_load(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.env['FLOCK_TIMEOUT'] = '1'
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertIn('kept docker images still loading after 1s; continuing without waiting', result.stderr)
            self.assertFalse(fx.ready.exists())
            self.assertNotIn('docker load', fx.invoked())

    def test_ready_after_lock_recheck_does_not_reload(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.tool('flock', '#!/bin/bash\ntouch "$READY"\nexit 0\n')
            fx.env['READY'] = str(fx.ready)
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertTrue(fx.ready.exists())
            self.assertEqual(fx.invoked(), [])

    def test_docker_failure_does_not_mark_images_ready(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.tool('docker', '#!/bin/bash\n[ "$1" = info ] && exit 0\nexit 1\n')
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertFalse(fx.ready.exists())
            self.assertIn('could not restore kept docker images', result.stderr)

    def test_failed_load_does_not_mark_images_ready(self):
        with tempfile.TemporaryDirectory() as d:
            fx = ImageWaitFixture(d)
            fx.tool('zstd', '#!/bin/bash\nexit 1\n')
            result = fx.run()
            self.assertEqual(result.returncode, 7)
            self.assertFalse(fx.ready.exists())
            self.assertIn('could not restore kept docker images', result.stderr)

    def test_preamble_only_waits_when_selected(self):
        no_docker = runs.remote_script('w', '.', ['make check'], None, 'r', wait_images=False)
        docker = runs.remote_script('w', '.', ['docker', 'compose', 'up'], None, 'r', wait_images=True)
        self.assertNotIn(runs.IMAGE_WAIT, no_docker)
        self.assertIn(runs.IMAGE_WAIT, docker)
        self.assertLess(docker.index(runs.LDCACHE_REPAIR), docker.index(runs.IMAGE_WAIT))
        self.assertLess(docker.index(runs.IMAGE_WAIT), docker.index('cd "$HOME/w"'))

    def test_client_wait_limit_is_validated_and_rendered(self):
        for value, expected in [('2', 2), ('180', 180), ('0', 180), ('-1', 180),
                                ('99999', 180), ('1; echo injected', 180), ('', 180)]:
            with self.subTest(value=value), patch.dict(os.environ, {'OFFBOX_IMAGE_WAIT_SECONDS': value}):
                seconds = runs.image_wait_seconds()
                self.assertEqual(seconds, expected)
                script = runs.remote_script('w', '.', ['docker'], None, 'r', wait_images=True, image_wait=seconds)
                self.assertIn(f'OFFBOX_IMAGE_WAIT_SECONDS={expected}\n', script)

    def test_selection_reuses_docker_and_manifest_detection(self):
        with tempfile.TemporaryDirectory() as d:
            safe = ('true', 'go version', 'false', 'pwd')
            possible = ('docker compose up', 'podman run image', 'DOCKER_HOST=x go test ./pkg',
                        'make check', 'bash scripts/check.sh', 'python3 test.py', 'npm test', 'go test ./pkg',
                        'go vet ./pkg', 'go build ./pkg', 'go list ./pkg', 'go env GOPATH',
                        'go env -w GOFLAGS=-toolexec=./wrapper', 'gofmt -r x -l file.go',
                        'go test -exec ./wrapper ./pkg', 'go test -exec=./wrapper ./pkg',
                        'go test ./pkg; docker ps', 'go test $(cat args)', 'go test ./pkg 2>&1',
                        'true; ./script', 'true && go test ./pkg')
            # Wildcards and redirection are deliberately treated as opaque rather than assuming safety.
            for cmd in safe:
                with self.subTest(cmd=cmd):
                    self.assertFalse(runs.needs_image_wait(cmd, d))
            for cmd in possible:
                with self.subTest(cmd=cmd):
                    self.assertTrue(runs.needs_image_wait(cmd, d))
            Path(d, 'go.mod').write_text('require github.com/testcontainers/testcontainers-go v0.1\n')
            self.assertTrue(runs.needs_image_wait('go test ./...', d))


class RunnerImageSelectionTests(Isolated):
    def test_real_start_uses_whole_command_and_correct_remote_preamble(self):
        self.box('bxA', member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='bxA'").fetchone(), remote_dir='w/r')
        root = Path(self.tmp.name) / 'repo'
        root.mkdir()
        self.me['repo_root'] = str(root)
        cases = [(['--', 'true'], False), (['--', 'make', 'check'], True),
                 (['--', 'docker', 'ps'], True),
                 (['--step', 'true', '--step', 'echo ' + 'x' * 4000 + '; docker ps'], True)]
        with contextlib.redirect_stderr(io.StringIO()), \
             patch.object(runs.pool, 'acquire', return_value=row), \
             patch.object(runs.Runner, '_prepare_box'), \
             patch.object(runs.api, 'cmd_start', return_value={'processId': 7}), \
             patch.object(runs.lease, 'touch'), patch.object(runs.node_version, 'want', return_value=None):
            for argv, expected in cases:
                with self.subTest(argv=argv[0:3]):
                    args = cli.build_parser().parse_args(['run', *argv])
                    args.steps = getattr(args, 'step', None)
                    if args.cmd and args.cmd[0] == '--':
                        args.cmd = args.cmd[1:]
                    runner = runs.Runner(args, self.me)
                    with patch.object(runs, 'remote_script', wraps=runs.remote_script) as build:
                        runner.start()
                    self.assertEqual(build.call_args.kwargs['wait_images'], expected)
                    self.assertEqual(self.con.execute('SELECT docker FROM runs WHERE run_id=?',
                                                       (runner.run_id,)).fetchone()[0], int(expected))


if __name__ == '__main__':
    unittest.main()
