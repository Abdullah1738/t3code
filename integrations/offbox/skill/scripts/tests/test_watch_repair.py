"""Exercise the remote watch repair with fake Linux state and commands, without sudo or Boat."""
import os
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs


# macOS has no timeout. Kill the stub client on expiry just as the Linux command does.
TIMEOUT = f'''#!{sys.executable}
import subprocess, sys
args = sys.argv[1:]
if args[:1] == ['--foreground']: args = args[1:]
if args[:2] == ['-s', 'KILL']: args = args[2:]
try:
    sys.exit(subprocess.run(args[1:], timeout=float(args[0])).returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
'''


class Fixture:
    def __init__(self, tmp, watches=8192, instances=128, watchman=None):
        self.root = Path(tmp)
        self.bins = self.root / 'bin'
        self.proc = self.root / 'proc'
        for d in (self.bins, self.proc):
            d.mkdir()
        self.config = self.root / '90-offbox-inotify.conf'
        self.calls = self.root / 'calls'
        self.calls.touch()
        for name, value in [('max_user_watches', watches), ('max_user_instances', instances)]:
            (self.proc / name).write_text(f'{value}\n')
        # Keep PATH isolated, so a real host watchman or sysctl cannot be reached.
        (self.bins / 'cat').symlink_to('/bin/cat')
        (self.bins / 'python3').symlink_to(sys.executable)
        self.tool('sudo', '''#!/bin/bash
echo "sudo $*" >> "$FIX/calls"
[ "$1" = -n ] || exit 2
[ -z "${FAIL_SUDO:-}" ] || { echo 'sudo: denied' >&2; exit 1; }
shift
exec "$@"
''')
        self.tool('sysctl', '''#!/bin/bash
[ -z "${FAIL_SYSCTL:-}" ] || exit 1
setting=${3#fs.inotify.}
printf '%s\n' "${setting#*=}" > "$OFFBOX_INOTIFY_PROC_DIR/${setting%=*}"
''')
        self.tool('tee', '''#!/bin/bash
[ -z "${FAIL_TEE:-}" ] || exit 1
/bin/cat > "$1"
''')
        self.tool('timeout', TIMEOUT)
        if watchman is not None:
            self.tool('watchman', '''#!/bin/bash
echo "watchman $*" >> "$FIX/calls"
if [ "$1" = watch-list ]; then
  [ -z "${HANG_WATCH:-}" ] || exec /bin/sleep 30
  printf '%s\n' "$WATCH_OUTPUT" >&"${WATCH_FD:-1}"
  exit "${WATCH_RC:-0}"
fi
[ -z "${FAIL_SHUTDOWN:-}" ]
''')
        self.script = runs.WATCH_REPAIR.replace('/etc/sysctl.d/90-offbox-inotify.conf', str(self.config))
        self.env = dict(os.environ, PATH=str(self.bins), FIX=str(self.root),
                        OFFBOX_INOTIFY_PROC_DIR=str(self.proc), WATCH_OUTPUT=watchman or '')

    def tool(self, name, body):
        path = self.bins / name
        path.write_text(body)
        path.chmod(0o755)

    def run(self, script=None):
        return subprocess.run(['/bin/bash', '-eu', '-o', 'pipefail', '-c', script or self.script],
                              env=self.env, capture_output=True, text=True, timeout=20)

    def called(self):
        return self.calls.read_text().splitlines()


class WatchRepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_limits_are_floors_and_persistence_is_idempotent(self):
        cases = [(8192, 128), (524287, 1023), (524288, 1024), (1048576, 2048),
                 (1048576, 128), (8192, 2048)]
        for watches, instances in cases:
            with self.subTest(watches=watches, instances=instances), tempfile.TemporaryDirectory() as tmp:
                fx = Fixture(tmp, watches, instances)
                expected = {'max_user_watches': max(watches, 524288),
                            'max_user_instances': max(instances, 1024)}
                result = fx.run()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
                for name, value in expected.items():
                    self.assertEqual(int((fx.proc / name).read_text()), value)
                self.assertEqual(fx.config.read_text(), ''.join(f'fs.inotify.{k}={v}\n' for k, v in expected.items()))
                calls = fx.called()
                sysctls = [c for c in calls if c.startswith('sudo -n sysctl')]
                self.assertEqual(len(sysctls), (watches < 524288) + (instances < 1024))
                result = fx.run()
                self.assertEqual((result.returncode, result.stderr, fx.called()), (0, '', calls))

    def test_different_persistent_file_is_replaced(self):
        fx = Fixture(self.tmp.name, watches=524288, instances=1024)
        fx.config.write_text('fs.inotify.max_user_watches=8192\n')
        result = fx.run()
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertEqual(fx.called(), [f'sudo -n tee {fx.config}'])
        self.assertIn('fs.inotify.max_user_instances=1024\n', fx.config.read_text())

    def test_each_sudo_failure_warns_once_and_never_fails(self):
        for failure in ('FAIL_SUDO', 'FAIL_SYSCTL', 'FAIL_TEE'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                fx = Fixture(tmp)
                fx.env[failure] = '1'
                result = fx.run()
                self.assertEqual((result.returncode, result.stdout), (0, ''))
                self.assertEqual(result.stderr.splitlines(), ['offbox: inotify limit repair failed (sudo -n); continuing'])

    def test_without_watchman_no_watch_command_is_attempted(self):
        fx = Fixture(self.tmp.name)
        fx.tool('timeout', '#!/bin/bash\necho unexpected-timeout >&2; exit 1\n')
        result = fx.run()
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertFalse(any('watchman' in c for c in fx.called()))

    def test_poison_on_stdout_or_stderr_restarts_even_after_nonzero_exit(self):
        cases = [('Watchman needs your help! inotify-add-watch', '1', '0'),
                 ('{"error":"poisoned by inotify"}', '2', '1'),
                 ('{\n  "error": "Watchman needs your help!",\n  "version": "1"\n}', '1', '0'),
                 ('watchman: poison condition\n{"roots":[]}', '2', '1'),
                 ('{"roots":[]}\nwatchman: poisoned', '2', '1')]
        for output, fd, rc in cases:
            with self.subTest(output=output), tempfile.TemporaryDirectory() as tmp:
                fx = Fixture(tmp, watchman=output)
                fx.env.update(WATCH_FD=fd, WATCH_RC=rc)
                result = fx.run()
                self.assertEqual((result.returncode, result.stdout), (0, ''))
                self.assertEqual(result.stderr.splitlines(), ['offbox: watchman was poisoned (inotify limit); restarted it'])
                self.assertEqual([c for c in fx.called() if c.startswith('watchman')],
                                 ['watchman watch-list', 'watchman shutdown-server'])

    def test_healthy_or_unrelated_error_does_not_restart(self):
        healthy = [json.dumps({'roots': ['/home/user/w/' + name]}) for name in
                   ['repo', 'poison-abcdef', 'poisoned-abcdef', 'Watchman needs your help', 'poison-"error"']]
        healthy += [json.dumps({'roots': ['/home/user/w/poison-abcdef']}, indent=2),
                    'watchman: warning\n{"roots":["/home/user/w/poison-abcdef"]}',
                    '{"roots":["/home/user/w/poison-abcdef"]}\nwatchman: warning']
        for output, rc in [(s, '0') for s in healthy] + [('cannot connect', '1')]:
            with self.subTest(output=output), tempfile.TemporaryDirectory() as tmp:
                fx = Fixture(tmp, watchman=output)
                fx.env['WATCH_RC'] = rc
                result = fx.run()
                self.assertEqual((result.returncode, result.stderr), (0, ''))
                self.assertEqual([c for c in fx.called() if c.startswith('watchman')], ['watchman watch-list'])

    def test_shutdown_failure_does_not_fail_or_claim_restart(self):
        fx = Fixture(self.tmp.name, watchman='poison')
        fx.env['FAIL_SHUTDOWN'] = '1'
        result = fx.run()
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertIn('watchman shutdown-server', fx.called())

    def test_hanging_watch_list_is_bounded_and_run_continues(self):
        fx = Fixture(self.tmp.name, watchman='healthy')
        fx.env['HANG_WATCH'] = '1'
        result = fx.run(fx.script + '\necho USER_COMMAND\nexit 3\n')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, 'USER_COMMAND\n', ''))
        self.assertNotIn('watchman shutdown-server', fx.called())

    def test_missing_or_invalid_proc_values_are_silent(self):
        fx = Fixture(self.tmp.name)
        (fx.proc / 'max_user_watches').unlink()
        (fx.proc / 'max_user_instances').write_text('invalid\n')
        result = fx.run()
        self.assertEqual((result.returncode, result.stdout, result.stderr, fx.called()), (0, '', '', []))

    def test_remote_script_repairs_before_cd_and_preserves_user_exit(self):
        fx = Fixture(self.tmp.name, watchman='poison')
        fx.env.update(HOME=str(fx.root), FAIL_SUDO='1')
        (fx.root / 'w/repo').mkdir(parents=True)
        fx.tool('rm', '#!/bin/bash\nexit 0\n')
        fx.tool('watchman', '''#!/bin/bash
echo "watchman $*" >> "$FIX/calls"
[ "$PWD" != "$HOME/w/repo" ] || exit 1
[ "$1" != watch-list ] || echo poison
''')
        with patch.object(runs, 'WATCH_REPAIR', fx.script), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                patch.object(runs, 'LDCACHE_REPAIR', ':'), patch.object(runs, 'GO_REPAIR', ':'), \
                patch.object(runs.userns, 'setup', return_value=':'):
            script = runs.remote_script('w/repo', '.', ['echo USER_COMMAND; exit 3'], None, 'watch-test')
        result = fx.run(script)
        self.assertEqual((result.returncode, result.stdout), (3, 'USER_COMMAND\n'))
        self.assertIn('watchman shutdown-server', fx.called())
        self.assertIn('offbox-command-started: watch-test', result.stderr)


if __name__ == '__main__':
    unittest.main()
