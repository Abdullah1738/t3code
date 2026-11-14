"""Failure classification and bounded status-file fallback, without real backups."""
import datetime as dt
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import jobs
import toollog
from rollup import rollup


class BackupFailureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        self.status = self.root/'backup_last.json'
        env = patch.dict(os.environ, {'HOME': str(self.root), 'TOOLLOG_DIR': str(self.logs),
                         'MAC_LOG_MEMORY_STATUS': str(self.status)}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.now = 1794630000
        self.start = self.now-11194
        for name, value in [('backup_processes', {}), ('backup_snapshot_age', (None, 'timeout'))]:
            mock = patch.object(jobs, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    def rows(self):
        return [json.loads(line) for path in self.logs.glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def write_status(self, **updates):
        value = dict(ts=self.now-3, ok=False, stage='replica', last_success_ts=self.now-93600)
        value.update(updates)
        self.status.write_text(json.dumps(value))

    def run_backup(self, target='memory', rc='-1', code=1, reason='', stage=None):
        before = len(self.rows())
        argv = ['backup', target, str(self.start), rc, str(code), '0', reason,
                str(self.root/'absent-lock'), '3.126', '18000', '3']
        if stage is not None:
            argv.append(stage)
        with patch.object(jobs.time, 'time', return_value=self.now), patch.object(jobs.sys, 'stdin', io.StringIO('')):
            jobs.main(argv)
        rows = self.rows()
        self.assertEqual(len(rows), before+1)
        self.assertEqual(rows[-1]['name'], 'backup.run')
        return rows[-1]

    def test_failure_stage_table(self):
        cases = [({}, 'replica'), ({'ts': self.start}, 'replica'),
                 ({'ts': self.start-1}, 'unknown'), ({'ok': True}, 'unknown'),
                 ({'stage': 'private-stage'}, 'other'), ({'stage': []}, 'other'),
                 ({'stage': 'unknown'}, 'other'),
                 ({'ts': '1794630000'}, 'unknown'), ({'ts': float('nan')}, 'unknown'),
                 ({'ts': float('inf')}, 'unknown'), ({'ts': True}, 'unknown')]
        cases += [({'stage': stage}, stage) for stage in
                  ('admission', 'stage', 'repo', 'disk', 'replica', 'verify', 'files',
                   'restic', 'vault', 'dropbox', 'manifest')]
        for target in ('memory', 'health'):
            for rc in ('', '-1'):
                for status, expected in cases:
                    with self.subTest(target=target, rc=rc, status=status):
                        self.write_status(**status)
                        row = self.run_backup(target, rc)
                        stage = expected if target == 'memory' else 'unknown'
                        self.assertFalse(row['ok'])
                        self.assertEqual(row['props']['skipped'], 0)
                        self.assertNotIn('skipReason', row['props'])
                        self.assertEqual(row['props']['failedStage'], stage)
                        self.assertEqual(row['props']['failReason'],
                                         {'repo': 'no_repo_access', 'vault': 'source_missing'}.get(stage, 'other'))
                        self.assertEqual(row['error']['tag'], 'backup.failed_'+stage)
                        self.assertNotIn('resticExitCode', row['props'])
        for stage, expected in [('vault', 'vault'), ('private-stage', 'other')]:
            row = self.run_backup('health', stage=stage)
            self.assertEqual(row['props']['failedStage'], expected)

    def test_explicit_skips_and_successful_no_restic_are_unchanged(self):
        self.write_status()
        for target in ('memory', 'health'):
            for reason in ('', 'other', 'lock_held', 'stale_lock', 'load_deferred', 'boot_grace',
                           'no_repo_access', 'password_unavailable', 'source_missing', 'dry_run'):
                with self.subTest(target=target, reason=reason):
                    row = self.run_backup(target, code=0, reason=reason)
                    self.assertEqual(row['props']['skipped'], 1)
                    self.assertEqual(row['props']['skipReason'], reason or 'other')
                    self.assertEqual(row['ok'], reason in ('load_deferred', 'boot_grace'))
                    self.assertNotIn('failedStage', row['props'])
                    self.assertNotIn('failReason', row['props'])
                    self.assertEqual(row['props']['loadPerCore'], 3.13)
                    self.assertEqual(row['props']['lastSuccessAgeS'], 18000)
                    self.assertEqual(row['props']['deferredCount'], 3)

    def test_optional_stage_cannot_replace_memory_status(self):
        cases = [('missing', None, 'unknown'), ('stale', {'ts': self.start-1}, 'unknown'),
                 ('malformed', '{', 'unknown'), ('not_failed', {'ok': True}, 'unknown'),
                 ('fresh_invalid_stage', {'stage': 'private-stage'}, 'other'),
                 ('fresh', {}, 'replica')]
        for target in ('memory', 'health'):
            for shape, status, expected in cases:
                for supplied in ('', 'repo', 'vault', 'unknown', 'private-stage'):
                    with self.subTest(target=target, shape=shape, supplied=supplied):
                        self.status.unlink(missing_ok=True)
                        if isinstance(status, dict):
                            self.write_status(**status)
                        elif status is not None:
                            self.status.write_text(status)
                        row = self.run_backup(target, stage=supplied)
                        stage = expected if target == 'memory' else (
                            'other' if supplied == 'private-stage' else supplied or 'unknown')
                        self.assertEqual(row['props']['failedStage'], stage)
                        self.assertEqual(row['props']['skipped'], 0)
                        self.assertEqual(row['error']['tag'], 'backup.failed_'+stage)

    def test_snapshot_source_and_fallback_for_every_probe_error(self):
        self.write_status()
        for target in ('memory', 'health'):
            for error in ('timeout', 'unavailable', 'password_unavailable', 'exit', 'parse', 'no_snapshots'):
                with self.subTest(target=target, error=error), patch.object(
                        jobs, 'backup_snapshot_age', return_value=(None, error)):
                    row = self.run_backup(target)
                    self.assertEqual(row['props']['lastGoodSnapshotError'], error)
                    if target == 'memory':
                        self.assertEqual(row['props']['lastGoodSnapshotAgeS'], 93600)
                        self.assertEqual(row['props']['lastGoodSnapshotSource'], 'status_file')
                    else:
                        self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
                        self.assertNotIn('lastGoodSnapshotSource', row['props'])
            with patch.object(jobs, 'backup_snapshot_age', return_value=(3600, None)):
                row = self.run_backup(target)
                self.assertEqual(row['props']['lastGoodSnapshotAgeS'], 3600)
                self.assertEqual(row['props']['lastGoodSnapshotSource'], 'restic')
                self.assertNotIn('lastGoodSnapshotError', row['props'])
        for stamp in (self.now, self.now-0.5):
            self.write_status(last_success_ts=stamp)
            self.assertEqual(self.run_backup()['props']['lastGoodSnapshotAgeS'], self.now-stamp)

    def test_fail_style_reasons_are_failures_only_on_nonzero_exit(self):
        self.write_status()
        for target in ('memory', 'health'):
            for rc in ('', '-1', '1', '0'):
                for reason in ('other', 'password_unavailable', 'no_repo_access', 'source_missing',
                               'private-unrecognized-reason'):
                    for code in (0, 1):
                        with self.subTest(target=target, rc=rc, reason=reason, code=code):
                            row = self.run_backup(target, rc=rc, code=code, reason=reason)
                            props = row['props']
                            normalized = 'other' if reason.startswith('private-') else reason
                            if code:
                                self.assertFalse(row['ok'])
                                self.assertEqual(props['skipped'], 0)
                                self.assertNotIn('skipReason', props)
                                self.assertEqual(props['failReason'], normalized)
                                self.assertEqual(props['failedStage'], 'replica' if target == 'memory' else 'unknown')
                                self.assertEqual(row['error']['tag'], 'backup.failed_'+props['failedStage'])
                            else:
                                self.assertEqual(props['skipped'], 1)
                                self.assertEqual(props['skipReason'], normalized)
                                self.assertNotIn('failReason', props)
                                self.assertNotIn('failedStage', props)
            for reason in ('lock_held', 'stale_lock', 'load_deferred', 'boot_grace'):
                row = self.run_backup(target, code=1, reason=reason)
                self.assertFalse(row['ok'])
                self.assertEqual(row['props']['skipped'], 1)
                self.assertEqual(row['props']['skipReason'], reason)
                self.assertNotIn('failedStage', row['props'])
                self.assertEqual(row['error']['tag'], 'backup.skipped_'+reason)

    def test_status_file_failures_never_drop_the_event(self):
        documents = [None, 'not JSON', '[]', 'null', '{}', '{"ts":', '\ud800',
                     ' '*1024**2, '{"last_success_ts":%s}' % (self.now-1)+' '*65536]
        documents += [json.dumps({'last_success_ts': value}) for value in
                      ('1794536537', -1, 0, None, True, [], {}, float('nan'),
                       float('inf'), float('-inf'), self.now+1, 10**400)]
        documents += ['{"ts":'+ '['*1000+'0'+']'*1000+'}']
        for target in ('memory', 'health'):
            for document in documents:
                with self.subTest(target=target, document=str(document)[:80]):
                    self.status.unlink(missing_ok=True)
                    if document is not None:
                        self.status.write_bytes(document.encode('utf-8', errors='surrogatepass'))
                    row = self.run_backup(target)
                    self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
                    self.assertEqual(row['props']['lastGoodSnapshotError'], 'timeout')
            self.status.unlink(missing_ok=True)
            self.status.mkdir()
            row = self.run_backup(target)
            self.assertIsNone(row['props']['lastGoodSnapshotAgeS'])
            self.status.rmdir()
        with patch.object(Path, 'open', side_effect=PermissionError):
            self.assertEqual(jobs.backup_status(), {})

    def test_fixed_home_default_and_status_size_boundary(self):
        default = self.root/'.local/share/memory-system/logs/backup_last.json'
        default.parent.mkdir(parents=True)
        with patch.dict(os.environ, {'MEMORY_BACKUP_LOGDIR': str(self.root/'ignored')}):
            os.environ.pop('MAC_LOG_MEMORY_STATUS')
            text = json.dumps(dict(ts=self.now, ok=False, stage='replica', last_success_ts=self.now-3600))
            default.write_text(text+' '*(65536-len(text)))
            row = self.run_backup()
            self.assertEqual(row['props']['failedStage'], 'replica')
            self.assertEqual(row['props']['lastGoodSnapshotAgeS'], 3600)

    def test_status_output_and_sink_cannot_leak(self):
        private = str(self.root/'.robob/secrets/ordinaryname')
        password = 'RESTIC_PASSWORD=x'
        self.write_status(message=private, last_error=password, last_snapshot='s3:https://private.example/repo')
        row = self.run_backup()
        self.assertEqual(row['props']['failedStage'], 'replica')
        toollog.emit('backup', 'error', 'backup.run', props=dict(
            failedStage=private, failReason=password, lastGoodSnapshotSource=private))
        encoded = json.dumps(self.rows())
        for secret in (private, password, 's3:https://private.example/repo'):
            self.assertNotIn(secret, encoded)

    def test_rollup_counts_each_run_once_including_flattened_fields(self):
        for target in ('memory', 'health', 'other'):
            for skipped, ok in ((0, False), (1, False), (1, True), (0, True)):
                toollog.emit('backup', 'perf' if ok else 'error', 'backup.run', ok=ok,
                             props=dict(target=target, skipped=skipped))
        result = rollup(dt.datetime.now(dt.timezone.utc).date().isoformat(), self.logs)
        self.assertEqual(result['backup'], dict(
            skipped_runs=dict.fromkeys(('memory', 'health', 'other'), 2),
            ok_runs=dict.fromkeys(('memory', 'health', 'other'), 1),
            failed_runs=dict.fromkeys(('memory', 'health', 'other'), 1)))
        self.assertEqual(sum(sum(counts.values()) for counts in result['backup'].values()), 12)
        flat = {'backup.%s.%s' % (key, target): count for key, counts in result['backup'].items()
                for target, count in counts.items()}
        self.assertEqual(toollog.safe_fields(flat), flat)


if __name__ == '__main__':
    unittest.main()
