"""Backup diagnostics with synthetic repos, credentials and process ancestry."""
import datetime as dt
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import jobs
import toollog
from rollup import rollup


class BackupDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        self.lock = self.root/'backup.lock'
        self.lock.mkdir()
        env = patch.dict(os.environ, {'HOME': str(self.root), 'TOOLLOG_DIR': str(self.logs),
                                      'RESTIC_PASSWORD': 'fixture-credential',
                                      'RESTIC_REPOSITORY': 'fixture-repository'}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.ps = {}
        self.snapshot = json.dumps([{'time': dt.datetime.fromtimestamp(
            time.time()-3600, dt.timezone.utc).isoformat(), 'paths': ['never-log-this-path']}])
        self.calls = []
        self.probe_error = None
        self.probe_rc = 0
        self.keychain_rc = 0
        runner = patch.object(jobs.subprocess, 'run', side_effect=self.run_command)
        runner.start()
        self.addCleanup(runner.stop)

    def run_command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == '/bin/ps':
            output = self.ps.get(int(args[2]), '')
            return subprocess.CompletedProcess(args, 0 if output else 1, output, '')
        if args[0] == '/usr/bin/security':
            return subprocess.CompletedProcess(args, self.keychain_rc, 'fixture-keychain-value\n', '')
        if self.probe_error:
            raise self.probe_error
        self.assertEqual(args[1:], ['--no-lock', 'snapshots', '--host', 'ardud-mac',
                                   '--tag', self.target_tag, '--latest', '1', '--json'])
        self.assertLessEqual(kwargs['timeout'], 3)
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertNotIn('RESTIC_PASSWORD_COMMAND', kwargs['env'])
        self.assertNotIn('RESTIC_PASSWORD_FILE', kwargs['env'])
        return subprocess.CompletedProcess(args, self.probe_rc, self.snapshot, 'discarded-stderr')

    def rows(self):
        return [json.loads(line) for path in self.logs.glob('*.ndjson') for line in path.read_text().splitlines()]

    def run_backup(self, target='memory', reason='lock_held', rc='', code=0, snapshot_at=0):
        self.target_tag = 'memory-live' if target == 'memory' else 'health-data'
        with patch.object(jobs.sys, 'stdin', io.StringIO('')):
            jobs.main(['backup', target, str(time.time()), str(rc), str(code), str(snapshot_at), reason, str(self.lock)])
        return self.rows()[-1]

    def test_live_holder_and_trigger_on_both_targets(self):
        child = subprocess.Popen(['/bin/sleep', '30'])
        self.addCleanup(lambda: (child.terminate(), child.wait()))
        (self.lock/'pid').write_text(str(child.pid))
        self.ps[child.pid] = '201 01:02:03 ?? /bin/bash /private/safe/memory_backup.sh'
        self.ps[201] = '1 1-02:03:04 ?? /opt/bin/python3 /private/safe/backup_control.py guard'
        self.ps[os.getppid()] = '1 00:03 ?? /bin/bash /private/safe/memory_backup.sh'
        for target in ('memory', 'health'):
            row = self.run_backup(target)
            props = row['props']
            self.assertEqual(props['skipReason'], 'lock_held')
            self.assertEqual(props['trigger'], 'launchd')
            self.assertEqual(props['lockHolderCmd'], 'bash memory_backup.sh')
            self.assertEqual(props['lockHolderPpid'], 201)
            self.assertEqual(props['lockHolderStartedAgoS'], 3723)
            self.assertEqual(props['lockHolderTrigger'], 'launchd')
            self.assertAlmostEqual(props['lastGoodSnapshotAgeS'], 3600, delta=5)
            self.assertIsNone(child.poll())

    def test_gone_holder_is_stale_and_unavailable_details_are_null(self):
        (self.lock/'pid').write_text('12345')
        with patch.object(jobs.os, 'kill', side_effect=ProcessLookupError):
            row = self.run_backup()
        self.assertFalse(row['ok'])
        self.assertEqual(row['props']['skipReason'], 'stale_lock')
        for key in ('lockHolderCmd', 'lockHolderPpid', 'lockHolderStartedAgoS'):
            self.assertIsNone(row['props'][key])
        self.assertEqual(row['error']['tag'], 'backup.skipped_stale_lock')

    def test_unreadable_holder_does_not_claim_stale(self):
        (self.lock/'pid').write_text('12345')
        with patch.object(jobs.os, 'kill', side_effect=PermissionError):
            row = self.run_backup()
        self.assertEqual(row['props']['skipReason'], 'lock_held')
        self.assertIsNone(row['props']['lockHolderCmd'])

    def test_probe_failures_emit_age_null_and_fixed_error_without_changing_outcome(self):
        cases = [(subprocess.TimeoutExpired('private-command', 3, stderr='private-output'), 'timeout'),
                 (OSError('private-repo-url'), 'unavailable')]
        for target in ('memory', 'health'):
            for error, tag in cases:
                self.probe_error = error
                row = self.run_backup(target, '', 0, snapshot_at=time.time())
                self.assertTrue(row['ok'])
                self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
                self.assertEqual(row['props']['lastGoodSnapshotError'], tag)
                self.assertLess(row['props']['snapshotAgeS'], 5)
                self.assertNotIn('private-', json.dumps(row))

    def test_snapshot_json_and_time_forms(self):
        cases = [('', 'parse'), ('null', 'parse'), ('{}', 'parse'), ('[]', 'no_snapshots'),
                 ('[{}]', 'parse'), ('[{"time":null}]', 'parse'),
                 *[(json.dumps([{'time': value}]), 'parse') for value in (
                     '2026-11-13T10:00:00', 'bad', '2026-11-13T10:00:00.Z',
                     '2026-11-13T10:00:00.1234567890Z', '2026-11-13T10:00:00.abcZ',
                     '2026-11-13T10:00:00+24:00', '2026-11-13T10:00:00+04:99',
                     '2026-11-13T10:00:00+0400', '2026-11-13T10:00:00Z extra',
                     '2026-13-13T10:00:00Z', '2026-11-13T25:00:00Z')]]
        for value, error in cases:
            with self.subTest(value=value):
                self.snapshot = value
                row = self.run_backup(reason='other', code=1)
                self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
                self.assertEqual(row['props']['lastGoodSnapshotError'], error)
        base = dt.datetime(2026, 11, 13, 10, tzinfo=dt.timezone.utc).timestamp()
        # Entire RFC3339Nano precision class, crossed with Z/zero/positive/negative
        # and non-whole-hour offsets. Ages must agree after microsecond truncation.
        for digits in range(10):
            fraction = '.'+'123456789'[:digits] if digits else ''
            micros = int('123456789'[:digits][:6].ljust(6, '0'))
            for clock, zone in [('10:00:00', 'Z'), ('10:00:00', '+00:00'),
                                ('14:00:00', '+04:00'), ('06:00:00', '-04:00'),
                                ('15:30:00', '+05:30')]:
                value = '2026-11-13T'+clock+fraction+zone
                for target in ('memory', 'health'):
                    with self.subTest(value=value, target=target), patch.object(jobs.time, 'time', return_value=base+7200):
                        self.snapshot = json.dumps([{'time': value}])
                        row = self.run_backup(target, reason='other')
                        self.assertAlmostEqual(row['props']['lastGoodSnapshotAgeS'], 7200-micros/1e6, delta=1e-5)
                        self.assertNotIn('lastGoodSnapshotError', row['props'])

    def test_probe_nonzero_and_missing_keychain_password(self):
        self.probe_rc = 1
        row = self.run_backup(reason='other')
        self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
        self.assertEqual(row['props']['lastGoodSnapshotError'], 'exit')
        os.environ.pop('RESTIC_PASSWORD')
        self.keychain_rc = 44
        self.calls.clear()
        row = self.run_backup(reason='other')
        self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
        self.assertEqual(row['props']['lastGoodSnapshotError'], 'password_unavailable')
        self.assertFalse(any('snapshots' in args for args, _ in self.calls))

    def test_admission_skip_uses_fixed_keychain_and_repository_fallbacks(self):
        os.environ.pop('RESTIC_PASSWORD')
        os.environ.pop('RESTIC_REPOSITORY')
        os.environ['RESTIC_PASSWORD_COMMAND'] = 'do-not-execute-this'
        os.environ['RESTIC_PASSWORD_FILE'] = str(self.root/'.robob/secrets/do-not-read')
        for target in ('memory', 'health'):
            row = self.run_backup(target, 'other')
            self.assertIsNotNone(row['props']['lastGoodSnapshotAgeS'])
            args, options = self.calls[-1]
            expected = ('/Volumes/ExternalSSD/memory-system-backup/restic/live' if target == 'memory'
                        else str(self.root/'.local/share/health-backup/restic'))
            self.assertEqual(options['env']['RESTIC_REPOSITORY'], expected)
            self.assertEqual(options['env']['RESTIC_PASSWORD'], 'fixture-keychain-value')
        self.assertEqual([args for args, _ in self.calls if args[0] == '/usr/bin/security'], [
            ['/usr/bin/security', 'find-generic-password', '-s', 'restic-memory-backup', '-w'],
            ['/usr/bin/security', 'find-generic-password', '-s', 'restic-health-backup', '-a', 'ardud', '-w']])

    def test_origin_and_elapsed_forms(self):
        cases = [('1 00:10 ?? /bin/bash /job/memory_backup.sh', 'launchd', 10),
                 ('1 02:10 ttys001 /bin/zsh -l', 'manual', 130),
                 ('1 1-02:03:04 ?? /bin/zsh /job/install.zsh', 'installer', 93784),
                 ('1 00:10 ?? /bin/zsh -f /job/install.zsh', 'installer', 10),
                 ('1 00:10 ?? /bin/bash -c exec /job/install-jobs.zsh', 'installer', 10),
                 ('1 03:04 ?? /bin/codex exec', 'agent', 184),
                 ('299 00:01 ?? /bin/bash /job/memory_backup.sh', 'unknown', 1)]
        for output, origin, age in cases:
            self.ps = {222: output}
            processes = jobs.backup_processes([222])
            self.assertEqual(processes[222]['age'], age)
            self.assertEqual(jobs.backup_origin(222, processes), origin)

    def test_run_trigger_forms_and_snapshot_age_keeps_growing_on_skips(self):
        for output, expected in [('1 00:01 ttys001 /bin/zsh -l', 'manual'),
                                 ('1 00:01 ?? /bin/zsh -f /job/install.zsh', 'installer'),
                                 ('1 00:01 ?? /bin/codex exec', 'unknown'), ('', 'unknown')]:
            self.ps = {os.getppid(): output}
            self.assertEqual(self.run_backup(reason='other')['props']['trigger'], expected)
        os.environ['XPC_SERVICE_NAME'] = 'com.abdullah.memory-backup'
        self.assertEqual(self.run_backup(reason='other')['props']['trigger'], 'launchd')
        now = time.time()
        with patch.object(jobs.time, 'time', return_value=now):
            first = self.run_backup(reason='other')['props']['lastGoodSnapshotAgeS']
        with patch.object(jobs.time, 'time', return_value=now+14400):
            second = self.run_backup(reason='other')['props']['lastGoodSnapshotAgeS']
        self.assertAlmostEqual(second-first, 14400)

    def test_no_secret_paths_or_restic_values_in_logs_or_rollup(self):
        values = {'RESTIC_PASSWORD': 'plausiblecredential', 'RESTIC_REPOSITORY': 's3:https://private.example/bucket',
                  'RESTIC_PASSWORD_COMMAND': 'customcredentialreader',
                  'RESTIC_PASSWORD_FILE': str(self.root/'.robob/secrets/ordinaryname'),
                  'RESTIC_CACHE_DIR': str(self.root/'.robob/secrets/cachevalue')}
        os.environ.update(values)
        (self.lock/'pid').write_text(str(os.getpid()))
        for arg in values.values():
            self.ps[os.getpid()] = '1 00:10 ?? /opt/bin/python3 '+arg+' ignored-secret'
            row = self.run_backup()
            self.assertEqual(row['props']['lockHolderCmd'], 'python3 [redacted]')
        # The sink also rejects raw commands supplied by future callers.
        for value in values.values():
            toollog.emit('backup', 'event', 'backup.run', props={'lockHolderCmd': value, 'trigger': value,
                         'lastGoodSnapshotError': value})
        result = rollup(dt.datetime.now(dt.timezone.utc).date().isoformat(), self.logs)
        encoded = json.dumps(self.rows())+json.dumps(result)
        for value in (*values.values(), str(self.root/'.robob/secrets'), 'ignored-secret', 'never-log-this-path'):
            self.assertNotIn(value, encoded)

    def test_rollup_counts_lines_per_target_and_excludes_healthy_skips_from_success(self):
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        for target in ('memory', 'health'):
            for skipped, ok in ((1, True), (1, False), (0, True), (0, False)):
                toollog.emit('backup', 'perf', 'backup.run', ok=ok, props=dict(target=target, skipped=skipped))
        result = rollup(day, self.logs)
        self.assertEqual(result['backup'], {'skipped_runs': {'memory': 2, 'health': 2, 'other': 0},
                                            'ok_runs': {'memory': 1, 'health': 1, 'other': 0}})


if __name__ == '__main__':
    unittest.main()
