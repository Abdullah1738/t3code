"""Run the box preamble against fake proc/sysctl state, without changing the host."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import runs, userns


class Fixture:
    def __init__(self, root, backend='boat', passes=True, clone='0'):
        self.root = Path(root)
        self.bins = self.root / 'bin'
        self.bins.mkdir()
        self.dropin = self.root / '99-offbox-userns.conf'
        self.boot = self.root / 'boot_id'
        self.boot.write_text('boot-one\n')
        self.restrict = self.root / 'restrict'
        self.restrict.write_text('1\n')
        if clone is not None:
            (self.root / 'clone').write_text(clone + '\n')
        self.calls = self.root / 'calls'
        self.calls.write_text('')
        for name in ('cat', 'mkdir', 'mv'):
            (self.bins / name).symlink_to('/bin/' + name)
        self.tool('sudo', '''#!/bin/bash
echo "sudo $*" >> "$FIX/calls"
[ "$1" = -n ] && [ -z "${FAIL_SUDO:-}" ] || exit 1
shift
export UNDER_SUDO=1
exec "$@"
''')
        self.tool('tee', '''#!/bin/bash
[ -z "${FAIL_TEE:-}" ] || exit 1
/bin/cat > "$1"
''')
        self.tool('sysctl', '''#!/bin/bash
case "$*" in
  '-n kernel.apparmor_restrict_unprivileged_userns') /bin/cat "$FIX/restrict" ;;
  '-n kernel.unprivileged_userns_clone') /bin/cat "$FIX/clone" ;;
  '-p '*)
    echo apply >> "$FIX/calls"
    [ "$UNDER_SUDO" = 1 ] && [ -z "${FAIL_SYSCTL:-}" ] || exit 1
    while read -r key eq value; do
      case "$key" in
        kernel.apparmor_restrict_unprivileged_userns) echo "$value" > "$FIX/restrict" ;;
        kernel.unprivileged_userns_clone) echo "$value" > "$FIX/clone" ;;
        *) exit 2 ;;
      esac
    done < "$2"
    ;;
  *) exit 2 ;;
esac
''')
        self.tool('unshare', '''#!/bin/bash
echo "probe $* sudo=${UNDER_SUDO:-0}" >> "$FIX/calls"
[ "$*" = '--user --map-root-user --net --mount true' ] || exit 2
[ -z "${UNDER_SUDO:-}" ] || exit 2
[ -z "${HANG_PROBE:-}" ] || exec /bin/sleep 30
exit "$PROBE_RC"
''')
        self.tool('timeout', f'''#!{sys.executable}
import subprocess, sys
args = sys.argv[1:]
assert args[:2] == ['-k', '0.1']
try:
    sys.exit(subprocess.run(args[3:], timeout=float(args[2])).returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
''')
        self.env = dict(HOME=str(self.root), PATH=str(self.bins), FIX=str(self.root),
                        PROBE_RC='0' if passes else '1')
        self.backend = backend

    def tool(self, name, content):
        p = self.bins / name
        p.write_text(content)
        p.chmod(0o755)

    def script(self):
        return self.rewrite(userns.setup(self.backend, 'bx_ours'))

    def rewrite(self, script):
        return script.replace('/etc/sysctl.d/99-offbox-userns.conf', str(self.dropin)).replace(
            '/proc/sys/kernel/random/boot_id', str(self.boot))

    def run(self, script=None):
        return subprocess.run(['/bin/bash', '-eu', '-o', 'pipefail', '-c',
                               script or (self.script() + '\necho USER_COMMAND\n')],
                              env=self.env, text=True, capture_output=True, timeout=8)

    def called(self, prefix):
        return [line for line in self.calls.read_text().splitlines() if line.startswith(prefix)]


class UsernsTests(unittest.TestCase):
    def test_boat_writes_and_applies_persistent_policy_idempotently(self):
        for clone in ('0', '1', None):
            with self.subTest(clone=clone), tempfile.TemporaryDirectory() as root:
                f = Fixture(root, clone=clone)
                p = f.run()
                self.assertEqual(p.returncode, 0, p.stderr)
                expected = 'kernel.apparmor_restrict_unprivileged_userns = 0\n'
                if clone is not None:
                    expected += 'kernel.unprivileged_userns_clone = 1\n'
                self.assertEqual(f.dropin.read_text(), expected)
                self.assertEqual(f.restrict.read_text().strip(), '0')
                before = f.dropin.stat().st_mtime_ns
                self.assertEqual(f.run().returncode, 0)
                self.assertEqual(f.dropin.stat().st_mtime_ns, before)
                self.assertEqual(len(f.called('apply')), 1)
                self.assertEqual(len(f.called('probe')), 1)

    def test_server_never_writes_sysctls_even_with_a_stale_dropin(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fixture(root, backend='server')
            f.dropin.write_text('leave this alone\n')
            p = f.run()
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertEqual(f.restrict.read_text().strip(), '1')
            self.assertEqual(f.dropin.read_text(), 'leave this alone\n')
            self.assertEqual(f.called('sudo'), [])

    def test_warnings_and_cached_probe_on_both_backends(self):
        for backend in ('boat', 'server'):
            for passes in (True, False):
                with self.subTest(backend=backend, passes=passes), tempfile.TemporaryDirectory() as root:
                    f = Fixture(root, backend=backend, passes=passes)
                    for _ in range(2):
                        p = f.run()
                        self.assertEqual(p.returncode, 0, p.stderr)
                        self.assertIn('USER_COMMAND', p.stdout)
                        if passes:
                            self.assertEqual(p.stderr, '')
                        else:
                            value = '0' if backend == 'boat' else '1'
                            self.assertEqual(p.stderr, f"offbox: warning: box bx_ours ({backend}) can't create user namespaces "
                                             f"(apparmor_restrict_unprivileged_userns={value}); rootless sandboxes will fail\n")
                    self.assertEqual(f.called('probe'), ['probe --user --map-root-user --net --mount true sudo=0'])

    def test_reboot_or_fork_invalidates_cache_and_boat_reapplies_policy(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fixture(root)
            f.run()
            f.boot.write_text('boot-two\n')
            f.restrict.write_text('1\n')
            self.assertEqual(f.run().returncode, 0)
            self.assertEqual(f.restrict.read_text().strip(), '0')
            self.assertEqual(len(f.called('apply')), 2)
            self.assertEqual(len(f.called('probe')), 2)
            f.run(f.script().replace('bx_ours', 'bx_fork'))
            self.assertEqual(len(f.called('probe')), 3)

    def test_host_fix_without_reboot_clears_cached_failure(self):
        with tempfile.TemporaryDirectory() as root:
            f = Fixture(root, backend='server', passes=False)
            self.assertIn('warning:', f.run().stderr)
            f.restrict.write_text('0\n')
            f.env['PROBE_RC'] = '0'
            self.assertEqual(f.run().stderr, '')
            self.assertEqual(f.called('sudo'), [])
            self.assertEqual(len(f.called('probe')), 2)

    def test_probe_timeout_and_setup_failures_only_warn(self):
        for backend in ('boat', 'server'):
            for failure in ('HANG_PROBE', 'FAIL_SUDO', 'FAIL_TEE', 'FAIL_SYSCTL'):
                with self.subTest(backend=backend, failure=failure), tempfile.TemporaryDirectory() as root:
                    f = Fixture(root, backend=backend, passes=False)
                    f.env[failure] = '1'
                    started = time.monotonic()
                    p = f.run()
                    self.assertLess(time.monotonic() - started, 3)
                    self.assertEqual(p.returncode, 0, p.stderr)
                    self.assertIn('USER_COMMAND', p.stdout)
                    self.assertEqual(len(p.stderr.splitlines()), 1, p.stderr)
                    self.assertIn('rootless sandboxes will fail', p.stderr)

    def test_preamble_runs_for_every_source_and_preserves_command_exit(self):
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as root:
                f = Fixture(root, backend=backend, passes=False)
                (f.root / 'w').mkdir()
                with patch.object(runs.api, 'BACKEND', backend), \
                     patch.object(runs, 'DOCKER_REPAIR', ':'), patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), \
                     patch.object(runs, 'CACHE_OWNER_REPAIR', ':'), patch.object(runs, 'WATCH_REPAIR', ':'), \
                     patch.object(runs, 'GO_REPAIR', ':'), patch.object(runs, 'repo_setup_block', return_value=':'), \
                     patch.object(runs.containers, 'script', return_value=':'), \
                     patch.object(runs.quint_tools, 'block', return_value=':'), \
                     patch.object(runs.node_tools, 'block', return_value=':'):
                    script = runs.remote_script('w', '.', ['echo USER_COMMAND; exit 7'], None, 'run-test', box_id='bx_ours')
                p = f.run(f.rewrite(script))
                self.assertEqual(p.returncode, 7, p.stderr)
                self.assertIn('USER_COMMAND', p.stdout)
                self.assertIn(f'box bx_ours ({backend})', p.stderr)


if __name__ == '__main__':
    unittest.main()
