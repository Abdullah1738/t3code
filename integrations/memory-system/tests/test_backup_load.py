"""Load and recovery tests use only synthetic databases and owned processes."""
import contextlib
import ctypes
import io
import json
import os
from pathlib import Path
import plistlib
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE / 'src'))
import backup_control as control
import backup_replica as replica
import run_limited as limited

SQLITE = Path('/opt/homebrew/opt/sqlite/bin/sqlite3')


class BackupLoad(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='backup-load-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.status = self.root / 'status.json'
        self.previous = dict(ts=123, ok=True, last_success_ts=int(time.time()), last_snapshot='abc')
        self.status.write_text(json.dumps(self.previous))
        self.env = mock.patch.dict(os.environ, MEMORY_BACKUP_LOAD_OVERRIDE='0.1',
                                   MEMORY_BACKUP_UPTIME_OVERRIDE='86400')
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_admission_preserves_success_and_never_defers_overdue(self):
        for load, uptime, age, deferred, reason in [
            ('5', '86400', 0, True, 'load 5.0/core'),
            ('0.1', '86400', 0, False, ''),
            ('0.1', '10', 0, True, 'boot grace'),
            ('5', '86400', 19 * 3600, True, 'load 5.0/core'),
            ('5', '86400', 20 * 3600, False, ''),
            ('5', '86400', 23 * 3600, False, ''),
            ('5', '86400', 24 * 3600, False, ''),
            ('5', '10', 86401, False, ''),
            ('5', '86400', None, False, ''),
        ]:
            with self.subTest(load=load, uptime=uptime, age=age):
                before = {**self.previous, 'last_success_ts': int(time.time()) - age if age is not None else None}
                self.status.write_text(json.dumps(before))
                with mock.patch.dict(os.environ, MEMORY_BACKUP_LOAD_OVERRIDE=load, MEMORY_BACKUP_UPTIME_OVERRIDE=uptime):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(control.defer(self.status), deferred)
                after = json.loads(self.status.read_text())
                for key, value in before.items():
                    self.assertEqual(after[key], value)
                if deferred:
                    self.assertIn('deferred: ' + reason, output.getvalue())
                    self.assertEqual(after['deferred_count'], 1)
                    self.assertGreater(after['last_deferred_ts'], 0)

    def run_backup(self, **overrides):
        home = self.root / 'home'
        package = home / '.local/share/memory-system'
        for directory in ('src', 'scripts', 'data', 'logs', 'bin'):
            (package / directory).mkdir(parents=True, exist_ok=True)
        for name in ('backup_control.py', 'backup_replica.py', 'redact_lock.py'):
            shutil.copyfile(PACKAGE / 'src' / name, package / 'src' / name)
        if not (package / 'src/run_limited.py').exists():
            shutil.copyfile(PACKAGE / 'src/run_limited.py', package / 'src/run_limited.py')
        shutil.copyfile(PACKAGE / 'scripts/memory_backup.sh', package / 'scripts/memory_backup.sh')
        status = package / 'logs/backup_last.json'
        if not status.exists():
            status.write_text(json.dumps(self.previous))
        env = {**os.environ, 'HOME': str(home), 'MEMORY_BACKUP_STAGE': str(self.root / 'stage'),
               'MEMORY_BACKUP_REPO_ROOT': str(self.root / 'repo'), 'MEMORY_BACKUP_MIN_FREE_GB': '0',
               **overrides}
        env.pop('BASH_ENV', None)
        result = subprocess.run(['/bin/bash', str(package / 'scripts/memory_backup.sh')],
                                env=env, capture_output=True, text=True, timeout=15)
        return result, json.loads(status.read_text()), '\n'.join(p.read_text() for p in (package / 'logs').glob('backup-*.log'))

    def test_shell_defers_and_overdue_enters_backup(self):
        result, status, log = self.run_backup(MEMORY_BACKUP_LOAD_OVERRIDE='5')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(status['last_success_ts'], self.previous['last_success_ts'])
        self.assertIn('deferred: load 5.0/core', log)
        result, status, log = self.run_backup(MEMORY_BACKUP_LOAD_OVERRIDE='0.1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(status['stage'], 'repo')
        result, status, log = self.run_backup(MEMORY_BACKUP_LOAD_OVERRIDE='5', MEMORY_BACKUP_MAX_DEFER_S='0')
        self.assertEqual(status['stage'], 'repo')
        self.assertIn('deferral bypassed', log)

    def test_shell_cap_is_failed_with_marker_and_error(self):
        self.run_backup(MEMORY_BACKUP_LOAD_OVERRIDE='0.1')
        package = self.root / 'home/.local/share/memory-system'
        (self.root / 'repo/live').mkdir(parents=True)
        (self.root / 'repo/live/config').touch()
        with sqlite3.connect(package / 'data/memory.db') as conn:
            conn.execute('create table episodic_events(id integer primary key)')
            conn.execute('insert into episodic_events values (1)')
        conn.close()
        shutil.copyfile(PACKAGE / 'src/run_limited.py', package / 'src/fixture_runner.py')
        for code in (124, 125):
            (package / 'src/run_limited.py').write_text(f'from fixture_runner import *\nif __name__ == "__main__": raise SystemExit({code})\n')
            result, status, log = self.run_backup(MEMORY_BACKUP_LOAD_OVERRIDE='0.1')
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((self.root / 'stage/.catchup-needed').exists())
            self.assertIn(f'rc={code}', status['last_error'])
            self.assertTrue(all(line.split('FAIL [replica] ')[-1].strip() for line in log.splitlines() if 'FAIL [replica]' in line))

    def test_guard_rejects_concurrent_and_legacy_holder(self):
        lock = self.root / 'lock'
        ready = self.root / 'ready'
        command = [sys.executable, str(PACKAGE / 'src/backup_control.py'), 'guard', str(lock)]
        first = subprocess.Popen([*command, sys.executable, '-c',
                                  'import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(2)', str(ready)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(ready.exists())
            result = subprocess.run([*command, '/usr/bin/false'], capture_output=True, text=True, timeout=1)
            self.assertEqual(result.returncode, 0)
            self.assertIn('already running', result.stdout)
            self.assertEqual(first.wait(timeout=5), 0)
            self.assertFalse(lock.exists())
            legacy = subprocess.Popen(['/bin/bash', '-c', 'exec -a memory_backup.sh /bin/sleep 20'])
            self.addCleanup(lambda: legacy.poll() is None and legacy.terminate())
            lock.mkdir()
            (lock / 'pid').write_text(str(legacy.pid))
            result = subprocess.run([*command, '/usr/bin/false'], capture_output=True, text=True, timeout=1)
            self.assertIn('already running', result.stdout)
            legacy.terminate()
            legacy.wait(timeout=5)
        finally:
            if first.poll() is None:
                first.terminate()
            first.communicate(timeout=5)

    def test_unrelated_reused_pid_does_not_block_backup(self):
        lock = self.root / 'lock'
        lock.mkdir()
        (lock / 'pid').write_text(str(os.getpid()))
        result = subprocess.run([sys.executable, str(PACKAGE / 'src/backup_control.py'),
                                 'guard', str(lock), '/usr/bin/false'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn('already running', result.stdout)
        self.assertFalse(lock.exists())

    def test_guard_signal_stops_fenced_descendants(self):
        lock = self.root / 'lock'
        pids = self.root / 'pids'
        fixture = self.root / 'child.py'
        fixture.write_text('import os,pathlib,subprocess,sys,time\n'
                           'os.fstat(int(os.environ["MEMORY_BACKUP_LOCK_FD"]))\n'
                           'child=subprocess.Popen([sys.executable,"-c","import os,time; os.setsid(); time.sleep(120)"])\n'
                           'pathlib.Path(sys.argv[1]).write_text(f"{os.getpid()} {child.pid}")\n'
                           'time.sleep(120)\n')
        child = subprocess.Popen([sys.executable, str(PACKAGE / 'src/backup_control.py'), 'guard', str(lock),
                                  sys.executable, str(PACKAGE / 'src/redact_lock.py'), '/bin/bash', '-c',
                                  'exec "$@"', 'memory_backup.sh', sys.executable, str(fixture), str(pids)],
                                 env={**os.environ, 'MEMORY_ROOT': str(self.root)},
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not pids.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(pids.exists())
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 130, out + err)
            self.assertFalse(lock.exists())
            for pid in map(int, pids.read_text().split()):
                state = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
                self.assertTrue(not state or state.startswith('Z'), state)
        finally:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=10)

    def setup_replica(self):
        self.src = self.root / 'source.sqlite'
        self.dst = self.root / 'replica.sqlite'
        for path, count in [(self.src, 7), (self.dst, 1)]:
            with contextlib.closing(sqlite3.connect(path)) as conn:
                conn.execute('create table events(id integer primary key)')
                conn.executemany('insert into events values (?)', [(n,) for n in range(count)])
                conn.commit()
        self.sync = self.root / 'sync'
        self.sync.write_text('#!' + sys.executable + '\nimport sqlite3,sys\nsrc,dst=sys.argv[-2:]\na=sqlite3.connect(src);b=sqlite3.connect(dst);a.backup(b);b.close();a.close()\n')
        self.sync.chmod(0o755)
        self.wal = Path(str(self.dst) + '-wal')

    def replicate(self, **kw):
        return replica.replicate(self.src, self.dst, self.sync, kw.get('sqlite', SQLITE),
                                 kw.get('runner', PACKAGE / 'src/run_limited.py'), 5,
                                 'select max(id) from events', '6')

    def test_reseed_triggers(self):
        self.setup_replica()
        for trigger in ('wal', 'marker', 'age'):
            with self.subTest(trigger=trigger):
                marker = self.root / '.catchup-needed'
                marker.unlink(missing_ok=True)
                if trigger == 'wal':
                    self.wal.write_bytes(b'bad stale wal' * 10)
                if trigger == 'marker':
                    marker.touch()
                if trigger == 'age':
                    os.utime(self.dst, (1, 1))
                with mock.patch.dict(os.environ, MEMORY_BACKUP_REPLICA_WAL_MAX_GB='0.00000001'):
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        self.assertEqual(self.replicate(), 0, out.getvalue())
                self.assertIn('reseeded (reason:', out.getvalue())
                self.assertFalse(self.wal.exists())
                with contextlib.closing(sqlite3.connect(self.dst)) as conn:
                    self.assertEqual(conn.execute('select count(*) from events').fetchone()[0], 7)

    def test_failed_quick_check_keeps_old_copy_and_sidecars(self):
        self.setup_replica()
        self.wal.write_bytes(b'stale')
        (self.root / '.catchup-needed').touch()
        before = self.dst.read_bytes()
        fake = self.root / 'sqlite'
        fake.write_text('#!/bin/sh\necho broken\n')
        fake.chmod(0o755)
        self.assertEqual(self.replicate(sqlite=fake), 1)
        self.assertEqual(self.dst.read_bytes(), before)
        self.assertEqual(self.wal.read_bytes(), b'stale')

    def test_live_holder_blocks_reseed(self):
        self.setup_replica()
        (self.root / '.catchup-needed').touch()
        before = self.dst.read_bytes()
        for suffix in ('', '-wal', '-shm', '.next', '.next-wal', '.next-shm'):
            with self.subTest(held=suffix):
                held = Path(str(self.dst) + suffix)
                if suffix:
                    held.write_bytes(b'holder fixture')
                snapshot = {p: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
                with held.open('rb'):
                    self.assertEqual(self.replicate(), 1)
                self.assertEqual({p: p.read_bytes() for p in snapshot}, snapshot)
                self.assertEqual(self.dst.read_bytes(), before)
                if suffix:
                    held.unlink()

    def test_reseed_with_insufficient_high_water_mark_keeps_old_copy(self):
        self.setup_replica()
        (self.root / '.catchup-needed').touch()
        before = self.dst.read_bytes()
        self.assertEqual(replica.replicate(self.src, self.dst, self.sync, SQLITE,
                                          PACKAGE / 'src/run_limited.py', 5,
                                          'select max(id) from events', '99'), 1)
        self.assertEqual(self.dst.read_bytes(), before)

    def test_low_space_fallback_and_cap_markers(self):
        self.setup_replica()
        (self.root / '.catchup-needed').touch()
        self.wal.write_bytes(b'stale')
        with mock.patch.object(replica.shutil, 'disk_usage', return_value=type('Space', (), {'free': 0})()):
            self.assertEqual(self.replicate(), 0)
        self.assertFalse(self.wal.exists())
        runner = self.root / 'runner.py'
        for code in (124, 125, 9):
            with self.subTest(code=code):
                marker = self.root / '.catchup-needed'
                marker.unlink(missing_ok=True)
                runner.write_text(f'raise SystemExit({code})\n')
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(self.replicate(runner=runner), code if code in (124, 125) else 1)
                self.assertEqual(marker.exists(), code in (124, 125))
                self.assertTrue(out.getvalue().strip())
                if code == 124:
                    self.assertIn('killed at cap', out.getvalue())
                if code == 9:
                    self.assertIn('rc=9 elapsed_s=', out.getvalue())

    def test_low_space_sync_failure_preserves_committed_wal_rows(self):
        self.setup_replica()
        conn = sqlite3.connect(self.dst)
        conn.execute('pragma journal_mode=wal')
        conn.execute('pragma wal_autocheckpoint=0')
        conn.execute('insert into events values (100)')
        conn.commit()
        main, wal = self.dst.read_bytes(), self.wal.read_bytes()
        conn.close()
        self.dst.write_bytes(main)
        self.wal.write_bytes(wal)
        self.assertGreater(len(wal), 0)
        (self.root / '.catchup-needed').touch()
        self.sync.write_text('#!/bin/sh\nexit 9\n')
        with mock.patch.object(replica.shutil, 'disk_usage', return_value=type('Space', (), {'free': 0})()):
            self.assertEqual(self.replicate(), 1)
        with contextlib.closing(sqlite3.connect(self.dst)) as conn:
            self.assertEqual(conn.execute('select id from events order by id').fetchall(), [(0,), (100,)])

    def test_priority_change_races_with_exit_or_pid_reuse(self):
        alive = limited.ProcessInfo(99, 0, 99, 'S', 123, None, 'sleep')
        cases = {
            'zombie': limited.ProcessInfo(99, 0, 99, 'Z', 123, None, 'sleep'),
            'reused': limited.ProcessInfo(99, 0, 99, 'S', 124, None, 'other'),
            'gone': None,
        }
        for case, after in cases.items():
            with self.subTest(case=case), mock.patch.dict(os.environ, MEMORY_BACKUP_LOAD_OVERRIDE='5'):
                tree = mock.Mock()
                tree.refresh.return_value = [alive]
                throttle = limited.LoadThrottle(tree, 1)
                with mock.patch.object(limited, 'process_table', side_effect=[{99: alive}, {99: after} if after else {}]), \
                     mock.patch.object(limited.subprocess, 'run', return_value=subprocess.CompletedProcess([], 70, '', 'No such process')):
                    throttle.sample(time.monotonic())

    def test_plist_preserves_live_keys_except_priority(self):
        config = plistlib.loads((PACKAGE / 'scripts/com.abdullah.memory-backup.plist').read_bytes())
        self.assertEqual(config['ProcessType'], 'Standard')
        self.assertEqual(set(config), {'Label', 'ProgramArguments', 'EnvironmentVariables', 'Nice', 'ProcessType',
                                      'RunAtLoad', 'StandardOutPath', 'StandardErrorPath', 'StartInterval'})
        self.assertEqual(config['StartInterval'], 14400)
        self.assertEqual(config['StartInterval'], control.LAUNCH_INTERVAL_S)
        self.assertEqual(config['Nice'], 10)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS priority control')
    def test_extra_time_under_load_is_bounded(self):
        result = subprocess.run([sys.executable, str(PACKAGE / 'src/run_limited.py'),
                                 '--seconds', '.3', '--max-seconds-under-load', '.3', '--load-aware',
                                 '--background', '--', '/bin/sleep', '20'],
                                env={**os.environ, 'MEMORY_BACKUP_LOAD_OVERRIDE': '5',
                                     'MEMORY_BACKUP_LOAD_INTERVAL_S': '.1'},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn('demoted_seconds=', result.stderr)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS priority control')
    def test_load_demotes_then_promotes_sleep_and_extends_cap(self):
        load = self.root / 'load'
        load.write_text('5')
        env = {**os.environ, 'MEMORY_BACKUP_LOAD_FILE': str(load), 'MEMORY_BACKUP_LOAD_INTERVAL_S': '.1'}
        child = subprocess.Popen([sys.executable, str(PACKAGE / 'src/run_limited.py'),
                                  '--seconds', '1', '--max-seconds-under-load', '3', '--load-aware',
                                  '--background', '--', '/bin/sleep', '2'],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = child.stderr.readline()
            self.assertIn('demoted load', line)
            def await_flag(expected):
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    descendants = [p for p in limited.process_table().values() if p.ppid == child.pid]
                    for member in descendants:
                        bsd = limited.DarwinBsdInfo()
                        limited.LIBPROC.proc_pidinfo(member.pid, 13, 1, ctypes.byref(bsd), ctypes.sizeof(bsd))
                        if bool(bsd.flags & 0x10000) == expected:
                            return
                    time.sleep(.01)
                self.fail(f'child external background flag did not become {expected}')
            await_flag(True)
            # A demoted second is discounted from the ordinary one-second cap.
            time.sleep(1.2)
            temporary = load.with_suffix('.tmp')
            temporary.write_text('0.1')
            temporary.replace(load)
            self.assertIn('promoted load', child.stderr.readline())
            await_flag(False)
            out, err = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, err)
            self.assertIn('demoted_seconds=', err)
        finally:
            if child.poll() is None:
                child.terminate()
                child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
