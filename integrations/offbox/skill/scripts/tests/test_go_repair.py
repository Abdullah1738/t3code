"""Exercise the actual remote preamble against fake toolchains, without boat or sudo."""
import os
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from unittest.mock import patch
from offbox_lib import runs
from offbox_lib.runs import GO_REPAIR, remote_script


class RepairFixture:
    """Run the real bash with filesystem-local stand-ins for Linux utilities."""
    def __init__(self, home):
        self.home = Path(home)
        self.local = self.home / 'usr/local'
        self.local.mkdir(parents=True)
        self.root = self.local / 'go'
        self.bins = self.home / 'bin'
        self.bins.mkdir()
        self.calls = self.home / 'calls'
        self.toolchain(self.root)
        self.script = GO_REPAIR.replace('/usr/local', str(self.local)).replace(
            '/tmp/offbox-go-repair.lock', str(self.home / 'repair.lock')) + '\necho USER_COMMAND\n'
        self.env = clean_env(HOME=str(self.home), PATH=f'{self.bins}:/usr/bin:/bin:/usr/sbin:/sbin',
                        FAKE_GOROOT=str(self.root), CALLS=str(self.calls), FIXTURE=str(self.home))
        self.tool('go', '#!/bin/bash\nexec "$FAKE_GOROOT/bin/go" "$@"\n')
        self.tool('sudo', '#!/bin/bash\nshift; exec "$@"\n')
        self.tool('stat', f'''#!{sys.executable}
import os, sys
st = os.stat(sys.argv[-1])
print(str(st.st_dev)+':'+str(st.st_ino))
''')
        # The production inventory uses GNU find/sha256sum; macOS does not ship them.
        self.tool('find', f'''#!{sys.executable}
import os, stat, sys
if os.environ.get('FAIL_INVENTORY'): sys.exit(1)
for base, dirs, files in os.walk('.'):
    for name in dirs + files:
        path = os.path.join(base, name)
        if path == './.offbox-manifest': continue
        st = os.lstat(path)
        if stat.S_ISDIR(st.st_mode): continue
        kind = 'l' if stat.S_ISLNK(st.st_mode) else 'f'
        target = os.readlink(path) if kind == 'l' else ''
        sys.stdout.buffer.write((path[2:]+'\\t'+kind+'\\t'+str(st.st_size)+'\\t'+target+'\\0').encode())
''')
        self.tool('sha256sum', f'''#!{sys.executable}
import hashlib, sys
print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()+'  -')
''')
        self.tool('flock', f'''#!{sys.executable}
import fcntl, sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX)
''')
        self.tool('curl', f'''#!{sys.executable}
import os, pathlib, sys, time
with open(os.environ['CALLS'], 'a') as f: f.write('download\\n')
time.sleep(float(os.environ.get('DOWNLOAD_DELAY', '0')))
if os.environ.get('FAIL_DOWNLOAD'): sys.exit(1)
pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_text('archive')
''')
        self.tool('tar', f'''#!{sys.executable}
import os, pathlib, shutil, sys
dest = pathlib.Path(sys.argv[sys.argv.index('-C')+1]) / 'go'
shutil.copytree(pathlib.Path(os.environ['FIXTURE']) / 'archive', dest)
''')
        # macOS mv has no -T; enforce its no-nesting semantics without touching the host.
        self.tool('mv', f'''#!{sys.executable}
import os, pathlib, signal, sys
args = [a for a in sys.argv[1:] if a not in ('-T', '--')]
src, dst = map(pathlib.Path, args)
with open(os.environ['CALLS'], 'a') as f: f.write('move '+str(src)+' -> '+str(dst)+'\\n')
if '-T' not in sys.argv or dst.exists() or dst.is_symlink(): sys.exit(1)
install = src.name == 'go' and src.parent.name.startswith('.offbox-go.')
if os.environ.get('FAIL_INSTALL') and install: sys.exit(1)
if os.environ.get('FAIL_ROLLBACK') and src.name == 'old': sys.exit(1)
os.rename(src, dst)
if os.environ.get('COLLIDE') and dst.name == 'old':
    src.mkdir(); (src / 'other-install').touch()
if (os.environ.get('SIGNAL_BACKUP') and dst.name == 'old') or (os.environ.get('SIGNAL_INSTALL') and install):
    os.kill(os.getppid(), signal.SIGTERM)
''')
        self.toolchain(self.home / 'archive', manifest=False)

    def tool(self, name, body):
        path = self.bins / name
        path.write_text(body)
        path.chmod(0o755)

    def toolchain(self, root, manifest=True):
        (root / 'src/unsafe').mkdir(parents=True)
        (root / 'src/unsafe/unsafe.go').write_text('package unsafe\n')
        (root / 'VERSION').write_text('go1.26.9\n')
        (root / 'bin').mkdir()
        go = root / 'bin/go'
        go.write_text('''#!/bin/bash
case "$*" in
  'env GOROOT') printf '%s\\n' "$FAKE_GOROOT";;
  version) echo 'go version go1.26.9 linux/amd64';;
  'list std'|'build std')
    [ -s "$GOROOT/src/unsafe/unsafe.go" ] || exit 1
    [ ! -e "$GOROOT/go" ] || exit 1
    [ ! -f "$GOROOT/invalid" ] || exit 1
    if [ "$*" = 'build std' ]; then
      [ -z "$GOFLAGS" ] || exit 1
      [ ! -f "$GOROOT/build-invalid" ] || exit 1
    fi
    if [ -n "$FAIL_POST_SWAP" ] && [ "$GOROOT" = "$FAKE_GOROOT" ]; then exit 1; fi
    echo unsafe;;
  *) exit 1;;
esac
''')
        go.chmod(0o755)
        if manifest:
            self.write_manifest(root)

    def write_manifest(self, root):
        records = []
        for path in root.rglob('*'):
            if path == root / '.offbox-manifest' or (path.is_dir() and not path.is_symlink()):
                continue
            kind = 'l' if path.is_symlink() else 'f'
            target = os.readlink(path) if kind == 'l' else ''
            records.append(f'{path.relative_to(root)}\t{kind}\t{path.lstat().st_size}\t{target}\0'.encode())
        digest = hashlib.sha256(b''.join(sorted(records))).hexdigest()
        version = (root / 'VERSION').read_text().splitlines()[0]
        (root / '.offbox-manifest').write_text(f'offbox-go-tree-v1 {version} {digest}  -\n')

    def run(self, **env):
        return subprocess.run(['bash', '-c', self.script], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=15)

    def fault_inventory(self, tool, failure, at=1):
        original = self.bins / tool
        real = self.bins / (tool + '-real')
        if original.exists():
            original.rename(real)
        else:
            real = Path('/usr/bin') / tool
        self.tool(tool, f'''#!/bin/bash
count=0
[ ! -f "$FIXTURE/{tool}-count" ] || read -r count < "$FIXTURE/{tool}-count"
count=$((count+1))
echo "$count" > "$FIXTURE/{tool}-count"
if [ "$count" -ge {at} ]; then
  {failure}
fi
exec "{real}" "$@"
''')

    def state(self, result):
        log = self.home / 'run-fixture.log'
        log.write_text(result.stderr)
        with patch.object(runs, 'LOGS_DIR', self.home):
            runs.save_run_state('run-fixture', box_id='bx_fixture')
            runs.space_result('run-fixture', result.returncode, log)
        return json.loads((self.home / 'run-fixture.state.json').read_text())

    def broken(self):
        (self.root / 'src/unsafe/unsafe.go').unlink()
        (self.root / 'go').mkdir()

    def assert_clean(self, test):
        test.assertTrue((self.root / 'src/unsafe/unsafe.go').is_file())
        test.assertFalse((self.root / 'go').exists())
        test.assertEqual(list(self.local.glob('.offbox-go.*')), [])


class GoSwapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = RepairFixture(self.tmp.name)

    def test_half_swapped_tree_repairs_before_user_command(self):
        self.fx.broken()
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.fx.assert_clean(self)
        self.assertIn('USER_COMMAND', result.stdout)
        self.assertIn('broken', result.stderr)
        self.assertEqual(self.fx.calls.read_text().count('download'), 1)

    def test_missing_unsafe_alone_triggers_repair(self):
        (self.fx.root / 'src/unsafe/unsafe.go').unlink()
        self.assertEqual(self.fx.run().returncode, 0)
        self.fx.assert_clean(self)

    def test_nested_go_alone_triggers_repair(self):
        (self.fx.root / 'go').mkdir()
        self.assertEqual(self.fx.run().returncode, 0)
        self.fx.assert_clean(self)

    def test_concurrent_repairs_recheck_under_lock(self):
        self.fx.broken()
        env = dict(self.fx.env, DOWNLOAD_DELAY='0.15')
        first = subprocess.Popen(['bash', '-c', self.fx.script], env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        second = subprocess.Popen(['bash', '-c', self.fx.script], env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        results = [(proc, proc.communicate(timeout=15)) for proc in (first, second)]
        for proc, (out, err) in results:
            self.assertEqual(proc.returncode, 0, err)
            self.assertIn('USER_COMMAND', out)
        self.fx.assert_clean(self)
        self.assertEqual(self.fx.calls.read_text().count('download'), 1)

    def test_failed_install_rolls_back(self):
        self.fx.broken()
        result = self.fx.run(FAIL_INSTALL='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertNotIn('USER_COMMAND', result.stdout)
        self.assertTrue((self.fx.root / 'go').is_dir())
        self.assertIn('rollback', result.stderr)

    def test_destination_collision_retains_unowned_tree_and_backup(self):
        self.fx.broken()
        result = self.fx.run(COLLIDE='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertTrue((self.fx.root / 'other-install').is_file())
        backups = list(self.fx.local.glob('.offbox-go.*/old'))
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / 'VERSION').is_file())
        self.assertIn('destination changed', result.stderr)

    def test_signal_during_swap_rolls_back(self):
        for flag in ('SIGNAL_BACKUP', 'SIGNAL_INSTALL'):
            with self.subTest(flag=flag):
                self.fx.broken()
                result = self.fx.run(**{flag: '1'})
                self.assertEqual(result.returncode, 97, result.stderr)
                self.assertTrue((self.fx.root / 'go').is_dir())
                self.assertIn('rollback', result.stderr)
                (self.fx.root / 'go').rmdir()
                (self.fx.root / 'src/unsafe/unsafe.go').write_text('package unsafe')

    def test_failed_rollback_retains_backup(self):
        self.fx.broken()
        result = self.fx.run(FAIL_POST_SWAP='1', FAIL_ROLLBACK='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertEqual(len(list(self.fx.local.glob('.offbox-go.*/old/VERSION'))), 1)
        self.assertIn('rollback failed', result.stderr)

    def test_failed_post_swap_check_rolls_back(self):
        self.fx.broken()
        result = self.fx.run(FAIL_POST_SWAP='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertTrue((self.fx.root / 'go').is_dir())
        self.assertNotIn('USER_COMMAND', result.stdout)
        self.assertIn('verification', result.stderr)

    def test_invalid_archive_never_moves_live_tree(self):
        self.fx.broken()
        (self.fx.home / 'archive/invalid').touch()
        result = self.fx.run()
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertNotIn('move ', self.fx.calls.read_text())
        self.assertTrue((self.fx.root / 'go').is_dir())

    def test_failed_download_preserves_live_tree_and_backup(self):
        self.fx.broken()
        backup = self.fx.local / '.offbox-go.abc123'
        backup.mkdir()
        (backup / 'valuable').touch()
        result = self.fx.run(FAIL_DOWNLOAD='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertTrue((backup / 'valuable').exists())
        self.assertNotIn('USER_COMMAND', result.stdout)

    def test_stale_backups_cleaned_only_after_current_tree_verified(self):
        for name in ('.offbox-go.abc123', '.offbox-go.def456'):
            (self.fx.local / name).mkdir()
        outside = self.fx.home / 'keep'
        outside.mkdir()
        (outside / 'important').touch()
        (self.fx.local / '.offbox-go.link12').symlink_to(outside)
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((outside / 'important').exists())
        self.assertTrue((self.fx.local / '.offbox-go.link12').is_symlink())
        self.assertFalse((self.fx.local / '.offbox-go.abc123').exists())

    def test_alternate_goroot_does_not_discard_managed_backups(self):
        self.fx.broken()
        backup = self.fx.local / '.offbox-go.abc123'
        backup.mkdir()
        self.fx.toolchain(backup / 'old')
        alternate = self.fx.home / 'alternate'
        self.fx.toolchain(alternate)
        self.fx.env['FAKE_GOROOT'] = str(alternate)
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((backup / 'old/VERSION').is_file())

    def test_interrupted_swap_restores_backup_when_goroot_absent(self):
        backup = self.fx.local / '.offbox-go.abc123'
        backup.mkdir()
        self.fx.root.rename(backup / 'old')
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.fx.assert_clean(self)

    def test_missing_binary_uses_managed_version_to_repair(self):
        (self.fx.root / 'bin/go').unlink()
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.fx.assert_clean(self)

    def test_generated_script_has_valid_bash_syntax(self):
        script = remote_script('w/test', '.', ['go vet std'], None, 'test')
        result = subprocess.run(['bash', '-n'], input=script, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_healthy_tree_needs_no_download_or_moves(self):
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.fx.calls.exists())

    def test_stray_older_release_file_is_mixed_and_repaired(self):
        stray = self.fx.root / 'src/cmd/cgo/ast_go118.go'
        stray.parent.mkdir(parents=True)
        stray.write_text('//go:build ignore\npackage main\n')
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('replacing mixed', result.stderr)
        self.assertFalse(stray.exists())
        self.assertTrue((self.fx.root / '.offbox-manifest').is_file())
        self.assertIn('USER_COMMAND', result.stdout)
        again = self.fx.run()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.fx.calls.read_text().count('download'), 1)

    def test_missing_manifest_requires_official_reinstall_not_adoption(self):
        (self.fx.root / '.offbox-manifest').unlink()
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('replacing mixed', result.stderr)
        self.assertEqual(self.fx.calls.read_text().count('download'), 1)

    def test_manifest_detects_same_file_count_with_different_path(self):
        (self.fx.root / 'src/unsafe/extra.go').write_text('old')
        self.fx.write_manifest(self.fx.root)
        (self.fx.root / 'src/unsafe/extra.go').rename(self.fx.root / 'src/unsafe/other.go')
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('replacing mixed', result.stderr)
        self.assertFalse((self.fx.root / 'src/unsafe/other.go').exists())

    def test_repair_reports_old_tree_state(self):
        (self.fx.root / '.offbox-manifest').unlink()
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('old tree manifest=missing', result.stderr)
        self.assertIn('old-release-files=no', result.stderr)
        self.assertIn('version_written=', result.stderr)
        self.assertIn('manifest_written=', result.stderr)

        extra = tempfile.TemporaryDirectory()
        self.addCleanup(extra.cleanup)
        self.fx = RepairFixture(extra.name)
        (self.fx.root / 'src/unsafe/extra.go').write_text('old')
        self.fx.write_manifest(self.fx.root)
        (self.fx.root / 'src/unsafe/extra.go').rename(self.fx.root / 'src/unsafe/other.go')
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('old tree manifest=mismatch', result.stderr)

        marks = tempfile.TemporaryDirectory()
        self.addCleanup(marks.cleanup)
        self.fx = RepairFixture(marks.name)
        (self.fx.root / 'src/strconv').mkdir(parents=True, exist_ok=True)
        (self.fx.root / 'src/strconv/ctoa.go').write_text('package strconv\n')
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('old-release-files=yes', result.stderr)
        self.assertIn('replacing mixed', result.stderr)
        self.assertFalse((self.fx.root / 'src/strconv/ctoa.go').exists())

    def test_healthy_tree_prints_no_old_tree_line(self):
        result = self.fx.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('old tree', result.stderr)

    def test_manifest_detects_changed_size_and_stray_symlink(self):
        for change in ('size', 'symlink'):
            with self.subTest(change=change):
                if change == 'size':
                    (self.fx.root / 'src/unsafe/unsafe.go').write_text('package unsafe\n// changed\n')
                else:
                    (self.fx.root / 'old-tool').symlink_to('bin/go')
                result = self.fx.run()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('replacing mixed', result.stderr)

    def test_inventory_failure_fails_closed(self):
        result = self.fx.run(FAIL_INVENTORY='1')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertNotIn('USER_COMMAND', result.stdout)

    def test_signal_inventory_is_infra_without_reinstall(self):
        for tool in ('find', 'sort', 'sha256sum'):
            for sig, rc in (('SEGV', 139), ('ABRT', 134)):
                for needs_go in (0, 1):
                    with self.subTest(tool=tool, sig=sig, needs_go=needs_go), tempfile.TemporaryDirectory() as home:
                        fx = RepairFixture(home)
                        fx.fault_inventory(tool, f'echo "*** stack smashing detected ***: terminated" >&2; kill -{sig} $$')
                        fx.tool('curl', '#!/bin/bash\necho UNEXPECTED_DOWNLOAD >&2\nexit 99\n')
                        fx.script = f'_offbox_needs_go={needs_go}\nulimit -c 0\n' + fx.script
                        stamp = (fx.root / '.offbox-manifest').read_bytes()
                        result = fx.run()
                        self.assertEqual(result.returncode, 90 if needs_go else 0, result.stderr)
                        self.assertEqual('USER_COMMAND' in result.stdout, not needs_go)
                        self.assertNotIn('replacing', result.stderr)
                        self.assertNotIn('mismatch', result.stderr)
                        self.assertNotIn('UNEXPECTED_DOWNLOAD', result.stderr)
                        self.assertFalse(fx.calls.exists())
                        self.assertEqual((fx.root / '.offbox-manifest').read_bytes(), stamp)
                        self.assertIn('Go check: cannot inventory', result.stderr)
                        self.assertIn(f'box-health: native-crash tool={tool} rc={rc} stage=go-inventory', result.stderr)
                        self.assertIn('box-health: native-crash signature=stack-smashing stage=go-inventory', result.stderr)
                        state = fx.state(result)
                        self.assertEqual(state['wrapper_exit_code'], result.returncode)
                        self.assertEqual(state['infra_failure'], 'native_crash' if needs_go else None)
                        self.assertEqual(state['infra_reason'], 'go_inventory_crash' if needs_go else None)
                        self.assertEqual(state['box_id'], 'bx_fixture')
                        if needs_go:
                            self.assertIsNone(state['command_exit_code'])
                        else:
                            self.assertIn("continuing because this run doesn't use Go", result.stderr)

    def test_non_signal_inventory_error_never_reinstalls(self):
        self.fx.fault_inventory('find', 'exit 1')
        result = self.fx.run()
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertIn('cannot inventory', result.stderr)
        self.assertIn('find rc=1 sort rc=0 sha256sum rc=0', result.stderr)
        self.assertNotIn('box-health:', result.stderr)
        self.assertNotIn('replacing', result.stderr)
        self.assertFalse(self.fx.calls.exists())
        self.assertIsNone(self.fx.state(result)['infra_failure'])

    def test_overlay_cleanup_rechecks_manifest_before_repair(self):
        for change, expected in (('overlay-only', 0), ('changed-size', 0), ('missing-stamp', 0),
                                 ('unreadable-before', 97), ('unreadable-after', 97), ('crashed-after', 90)):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as home:
                fx = RepairFixture(home)
                runtime = fx.root / 'src/runtime'
                runtime.mkdir()
                overlay = runtime / 'traceexp.go'
                overlay.write_text('old')
                if change == 'changed-size':
                    (fx.root / 'src/unsafe/unsafe.go').write_text('package unsafe\n// changed\n')
                elif change == 'missing-stamp':
                    (fx.root / '.offbox-manifest').unlink()
                elif change.startswith('unreadable-') or change == 'crashed-after':
                    fx.fault_inventory('sort', 'kill -SEGV $$' if change == 'crashed-after' else 'exit 1',
                                       at=1 if change == 'unreadable-before' else 2)
                repair = change in ('changed-size', 'missing-stamp')
                if not repair:
                    fx.tool('curl', '#!/bin/bash\necho UNEXPECTED_DOWNLOAD >&2\nexit 99\n')
                result = fx.run()
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual('USER_COMMAND' in result.stdout, expected == 0)
                self.assertEqual(overlay.exists(), change == 'unreadable-before')
                self.assertEqual('replacing mixed' in result.stderr, repair)
                self.assertNotIn('UNEXPECTED_DOWNLOAD', result.stderr)
                if not repair:
                    self.assertFalse(fx.calls.exists())
                if change == 'overlay-only':
                    self.assertNotIn('old tree', result.stderr)
                if expected:
                    self.assertIn('cannot inventory', result.stderr)
                    self.assertEqual(fx.state(result)['infra_reason'], 'go_inventory_crash' if expected == 90 else None)

    def test_unreadable_tree_overrides_other_repair_reasons(self):
        self.fx.broken()
        runtime = self.fx.root / 'src/runtime'
        runtime.mkdir()
        overlay = runtime / 'traceexp.go'
        overlay.write_text('old')
        self.fx.fault_inventory('find', 'exit 1')
        result = self.fx.run()
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertIn('old tree manifest=unreadable', result.stderr)
        self.assertNotIn('replacing', result.stderr)
        self.assertFalse(self.fx.calls.exists())
        self.assertTrue(overlay.exists())
        self.assertTrue((self.fx.root / 'go').is_dir())

    def test_staged_and_post_swap_inventory_failures_preserve_tree(self):
        # Inventory 1 reads the old tree; 2 stamps the archive; 3 verifies it;
        # 4 verifies the installed tree. Both pre-swap failures and rollback matter.
        for at in (2, 3, 4):
            for failure, expected in (('kill -SEGV $$', 90), ('exit 1', 97)):
                with self.subTest(at=at, failure=failure), tempfile.TemporaryDirectory() as home:
                    fx = RepairFixture(home)
                    fx.broken()
                    fx.fault_inventory('sort', failure, at=at)
                    fx.script = 'ulimit -c 0\n' + fx.script
                    result = fx.run()
                    self.assertEqual(result.returncode, expected, result.stderr)
                    self.assertNotIn('USER_COMMAND', result.stdout)
                    self.assertIn('cannot inventory', result.stderr)
                    self.assertIn('inventory unreadable', result.stderr)
                    self.assertNotIn('archive verification failed', result.stderr)
                    self.assertTrue((fx.root / 'go').is_dir())
                    if at < 4:
                        self.assertNotIn('move ', fx.calls.read_text())
                    else:
                        self.assertIn('rollback to previous GOROOT', result.stderr)
                    state = fx.state(result)
                    self.assertEqual(state['infra_reason'], 'go_inventory_crash' if expected == 90 else None)

    def test_archive_must_compile_std_even_when_go_list_would_pass(self):
        self.fx.broken()
        (self.fx.home / 'archive/build-invalid').touch()
        result = self.fx.run(GOFLAGS='-bad-user-flag')
        self.assertEqual(result.returncode, 97, result.stderr)
        self.assertIn('archive verification failed', result.stderr)
        self.assertNotIn('move ', self.fx.calls.read_text())


class GoRepairTests(unittest.TestCase):
    def run_case(self, version, stale=True, sudo_ok=True, has_go=True, mixed=False):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / 'go root'
            runtime = root / 'src/runtime'
            runtime.mkdir(parents=True)
            (root / 'src/unsafe').mkdir()
            (root / 'src/unsafe/unsafe.go').write_text('package unsafe')
            (root / 'VERSION').write_text(version + '\ntime stamp\n')
            leftover = runtime / 'traceexp.go'
            if stale:
                leftover.write_text('old source')
            current = runtime / 'tracebuf.go'
            current.write_text('current source')
            if mixed:
                (root / 'src/strconv').mkdir()
                (root / 'src/strconv/ctoa.go').write_text('old source')
            bins = home / 'bin'
            bins.mkdir()
            flock = bins / 'flock'
            flock.write_text('#!/bin/bash\nexit 0\n')
            flock.chmod(0o755)
            # Never allow a regression in a guard to reach the network or a real toolchain.
            for name in ('curl', 'tar', 'mv', 'mktemp'):
                tool = bins / name
                tool.write_text('#!/bin/bash\necho UNEXPECTED_REINSTALL >&2\nexit 99\n')
                tool.chmod(0o755)
            if has_go:
                go = bins / 'go'
                go.write_text('#!/bin/bash\n[ "$GOTOOLCHAIN" = local ] || exit 1\nprintf "%s\\n" "$FAKE_GOROOT"\n')
                go.chmod(0o755)
                (root / 'bin').mkdir()
                (root / 'bin/go').write_text(go.read_text())
                (root / 'bin/go').chmod(0o755)
            sudo = bins / 'sudo'
            sudo.write_text('#!/bin/bash\n' + ('shift; exec "$@"\n' if sudo_ok else 'exit 1\n'))
            sudo.chmod(0o755)
            (home / 'w').mkdir()
            (home / 'w/go.mod').write_text('module repair-fixture\n')
            env = clean_env(HOME=tmp, PATH=f'{bins}:/usr/bin:/bin', FAKE_GOROOT=str(root))
            with patch.object(runs, 'DOCKER_REPAIR', ':'), patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), \
                    patch.object(runs.userns, 'setup', return_value=':'):
                script = remote_script('w', '.', ['echo USER_COMMAND'], None, 'test', repo_root=home / 'w')
            script = script.replace(
                '/tmp/offbox-go-repair.lock', str(home / 'repair.lock')).replace('/usr/local', str(home / 'usr/local'))
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            return result, leftover.exists(), current.read_text()

    def test_new_go_removes_only_known_leftover_before_command(self):
        for version in ('go1.25', 'go1.25.0', 'go1.26.9', 'go1.26rc1', 'go2.0.0'):
            with self.subTest(version=version):
                result, exists, current = self.run_case(version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(exists)
                self.assertEqual(current, 'current source')
                self.assertIn('USER_COMMAND', result.stdout)
                self.assertIn('removing stale', result.stderr)

    def test_old_unknown_or_missing_go_is_untouched(self):
        for version, has_go in (('go1.24.9', True), ('unknown', True), ('go1.26.9', False)):
            with self.subTest(version=version, has_go=has_go):
                result, exists, _ = self.run_case(version, has_go=has_go)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(exists)
                self.assertNotIn('removing stale', result.stderr)

    def test_clean_go_needs_no_sudo(self):
        result, exists, _ = self.run_case('go1.26.9', stale=False, sudo_ok=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(exists)

    def test_failed_repair_does_not_run_user_command(self):
        result, exists, _ = self.run_case('go1.26.9', sudo_ok=False)
        self.assertEqual(result.returncode, 97)
        self.assertTrue(exists)
        self.assertNotIn('USER_COMMAND', result.stdout)

    def test_mixed_tree_outside_managed_goroot_fails_closed(self):
        result, _, _ = self.run_case('go1.26.9', stale=False, mixed=True)
        self.assertEqual(result.returncode, 97)
        self.assertNotIn('USER_COMMAND', result.stdout)
        self.assertNotIn('UNEXPECTED_REINSTALL', result.stderr)

    def test_older_toolchain_does_not_apply_126_obsolete_file_rule(self):
        result, _, _ = self.run_case('go1.25.0', stale=False, mixed=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_template_replaces_goroot_even_for_matching_dirty_version(self):
        recipe = (Path(__file__).resolve().parents[2] / 'templates/crpko-go.sh').read_text()
        self.assertIn('if [ -f /usr/local/go/src/runtime/traceexp.go ] ||', recipe)
        self.assertLess(recipe.index('sudo rm -rf /usr/local/go'), recipe.index('sudo tar -C /usr/local'))


if __name__ == '__main__':
    unittest.main()


class NonGoRepairTests(unittest.TestCase):
    def test_failed_download_and_timeout_respect_command_needs(self):
        for curl_code in (22, 28):
            for manifest, cmd, go in (('', 'pnpm install && vp test run x.test.ts', False),
                                      ('', 'corepack pnpm@11.7.0 install && vp test run x.test.ts', False),
                                      ('go.mod', 'pnpm install && vp test run x.test.ts', True),
                                      ('go.work', 'pnpm install && vp test run x.test.ts', True),
                                      ('sub/go.mod', 'uv run --directory sub node --test x.test.mjs', True),
                                      ('', 'go test ./pkg', True),
                                      ('', 'uv run go test ./pkg', True),
                                      ('', 'uv run --no-group python go version', True),
                                      ('', 'uv run --only-group python go version', True),
                                      ('', 'uv run --unknown-option python go version', True),
                                      ('', 'node -v\ngo test ./pkg', True),
                                      ('', 'test "$(go env GOOS)" = linux', True),
                                      ('', 'python3 -V # check\ngo version', True),
                                      ('', 'true&&(go version);', True),
                                      ('', 'pnpm exec /usr/local/go/bin/go version', True)):
                with self.subTest(curl=curl_code, manifest=manifest, cmd=cmd), tempfile.TemporaryDirectory() as home:
                    fx = RepairFixture(home)
                    fx.broken()
                    repo = Path(home) / 'w/repo'
                    repo.mkdir(parents=True)
                    (repo / 'package.json').write_text('{"devDependencies":{"vite-plus":"1"}}')
                    if manifest:
                        (repo / manifest).parent.mkdir(parents=True, exist_ok=True)
                        (repo / manifest).touch()
                    fx.tool('curl', f'#!/bin/bash\nexit {curl_code}\n')
                    fx.tool('pnpm', '#!/bin/bash\necho INSTALL_RAN\n')
                    fx.tool('corepack', '#!/bin/bash\nexec "${1%%@*}" "${@:2}"\n')
                    fx.tool('vp', '#!/bin/bash\necho USER_COMMAND\nexit 3\n')
                    repair = GO_REPAIR.replace('/usr/local', str(fx.local)).replace(
                        '/tmp/offbox-go-repair.lock', str(fx.home / 'repair.lock'))
                    with patch.object(runs, 'GO_REPAIR', repair), patch.object(runs, 'DOCKER_REPAIR', ':'), \
                         patch.multiple(runs, LDCACHE_REPAIR=':', SQLITE_SETUP=':'), patch.object(runs, 'WATCH_REPAIR', ':'), \
                         patch.object(runs.userns, 'setup', return_value=':'), \
             patch.object(runs.containers, 'script', return_value=':'), \
                         patch.object(runs.node_tools, 'block', return_value=':'):
                        fx.script = remote_script('w/repo', '.', [cmd], None, 'test', repo_root=repo)
                    result = fx.run()
                    self.assertEqual(result.returncode, 97 if go else 3, result.stderr)
                    self.assertEqual('USER_COMMAND' in result.stdout, not go)
                    self.assertEqual(runs.SETUP_FAILED_MARKER in result.stderr, go)
                    self.assertNotIn(runs.NO_NODE_MODULES_MARKER, result.stderr)
                    if not go:
                        self.assertIn("offbox: Go repair failed (official archive download failed); continuing because this run doesn't use Go", result.stderr)

    def test_remote_wrapper_keeps_inventory_crash_exit(self):
        for needs_go in (False, True):
            with self.subTest(needs_go=needs_go), tempfile.TemporaryDirectory() as home:
                fx = RepairFixture(home)
                fx.fault_inventory('sort', 'kill -ABRT $$')
                repo = Path(home) / 'w/repo'
                repo.mkdir(parents=True)
                if needs_go:
                    (repo / 'go.mod').touch()
                repair = GO_REPAIR.replace('/usr/local', str(fx.local)).replace(
                    '/tmp/offbox-go-repair.lock', str(fx.home / 'repair.lock'))
                with patch.multiple(runs, GO_REPAIR=repair, DOCKER_REPAIR=':', LDCACHE_REPAIR=':',
                                    SQLITE_SETUP=':', WATCH_REPAIR=':'), \
                     patch.object(runs.userns, 'setup', return_value=':'), \
                     patch.object(runs.containers, 'script', return_value=':'), \
                     patch.object(runs.node_tools, 'block', return_value=':'):
                    fx.script = 'ulimit -c 0\n' + remote_script(
                        'w/repo', '.', ['echo USER_COMMAND'], None, 'test', repo_root=repo)
                result = fx.run()
                self.assertEqual(result.returncode, 90 if needs_go else 0, result.stderr)
                self.assertEqual('USER_COMMAND' in result.stdout, not needs_go)
                self.assertNotIn('offbox-setup-failed', result.stderr)
                self.assertEqual(fx.state(result)['infra_failure'], 'native_crash' if needs_go else None)

    def test_archive_curl_has_stall_only_bounds(self):
        script = remote_script('w/repo', '.', ['go test ./pkg'], None, 'test')
        curl = next(line for line in script.splitlines() if 'curl -fsSL --retry 3' in line)
        self.assertIn('--connect-timeout 20 --speed-limit 10240 --speed-time 60 --max-time 900', curl)
        self.assertIn('https://go.dev/dl/${_offbox_version}.linux-', curl)
