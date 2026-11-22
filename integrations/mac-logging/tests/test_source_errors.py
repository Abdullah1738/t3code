import datetime as dt
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs
import toollog


class SourceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root / 'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        probes = patch.object(jobs, 'storage_probes', return_value={})
        probes.start()
        self.addCleanup(probes.stop)

    def rows(self, name):
        return [row for path in self.logs.glob('*.ndjson')
                for row in map(json.loads, path.read_text().splitlines()) if row['name'] == name]

    def test_du_total_and_failure_forms(self):
        cases = [
            (0, '42\t{root}\n', '', None, False, 0),
            (1, '42\t{root}\n', 'du: {root}/denied: Operation not permitted\n'
             'du: {root}/other: Permission denied', None, True, 2),
            (1, '', 'du: {root}: Operation not permitted\nprivate second line', 'permission', False, 0),
            (1, '42\t{root}\n', 'du: {root}: Input/output error', 'exit', False, 0),
            (0, '', '', 'missing-total', False, 0),
            (0, 'private contents', '', 'parse', False, 0),
            (0, '-1\t{root}\n', '', 'parse', False, 0),
            (0, '42\t/some-other-root\n', '', 'missing-total', False, 0),
        ]
        for i, (rc, output, stderr, failure, partial, denied) in enumerate(cases):
            with self.subTest(i=i):
                root = self.root / str(i)
                root.mkdir()
                child=root/'child'
                child.mkdir()
                run = lambda *a, **kw: SimpleNamespace(returncode=rc,
                    stdout=output.format(root=child), stderr=stderr.format(root=child))
                jobs.directory_inventory([root], run)
                state = jobs.read_state('disk-inventory')
                summary = self.rows('disk.inventory')[-1]
                self.assertEqual(summary['ok'], failure is None)
                self.assertEqual(state['sourceErrors'], int(failure is not None))
                if failure is None:
                    self.assertEqual(state['sizes'][str(root)], 42*1024)
                if partial:
                    row = self.rows('disk.inventory.source')[-1]
                    self.assertEqual(row['kind'], 'event')
                    self.assertTrue(row['props']['partial'])
                    self.assertEqual(row['props']['deniedCount'], denied)
                    self.assertEqual(row['props']['bytes'], 42*1024)
                if failure:
                    row = [r for r in self.rows('disk.inventory.source') if r['props']['source']==str(child)][-1]
                    self.assertEqual(row['props']['source'], str(child))
                    self.assertEqual(row['props']['failure'], failure)
                    self.assertEqual(row['props']['exitCode'], rc)
                    self.assertGreaterEqual(row['props']['elapsedMs'], 0)
                self.assertNotIn('private', json.dumps(self.rows('disk.inventory.source')))

    def test_du_timeout_discards_unfinished_total_and_records_stderr(self):
        def run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, kwargs['timeout'],
                output=b'99\tignored', stderr=b'du: denied: Permission denied\nprivate contents')
        jobs.directory_inventory([self.root], run)
        row = self.rows('disk.inventory.source')[0]
        self.assertEqual(row['props']['failure'], 'timeout')
        self.assertIsNone(row['props']['exitCode'])
        self.assertEqual(row['error']['message'], 'du: denied: Permission denied')
        self.assertEqual(jobs.read_state('disk-inventory')['sizes'], {})

    def test_missing_skipped_and_overall_budget_caps_each_call(self):
        clock = [0]
        calls = []
        roots = []
        for i in range(7):
            root = self.root / str(i)
            root.mkdir()
            (root/'child').mkdir()
            roots.append(root)
        def run(cmd, **kwargs):
            budget = kwargs['timeout']
            calls.append(budget)
            clock[0] += budget
            raise subprocess.TimeoutExpired(cmd, budget)
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]):
            jobs.directory_inventory([self.root/'missing'] + roots, run)
        self.assertLessEqual(sum(calls), 300)
        self.assertLessEqual(max(calls), 60)
        rows = [r for r in self.rows('disk.inventory.source') if r['props']['source'] in set(map(str,roots))]
        self.assertEqual(len(rows), len(roots))
        self.assertTrue(all(row['props']['failure'] == 'partial' for row in rows))
        self.assertEqual(jobs.read_state('disk-inventory')['sourceErrors'], len(roots))

    def test_crash_unified_command_failure_forms_and_cursor(self):
        cases = [
            ('timeout', subprocess.TimeoutExpired('log', 60, stderr=b'log: busy\nprivate'), 'log: busy'),
            ('exit', SimpleNamespace(returncode=65, stdout='private', stderr='log: failed\nprivate'), 'log: failed'),
            ('permission', SimpleNamespace(returncode=1, stdout='', stderr='log: Operation not permitted'), 'log: Operation not permitted'),
            ('parse', SimpleNamespace(returncode=0, stdout='private broken JSON', stderr=''), 'invalid unified log data'),
            ('parse', SimpleNamespace(returncode=0, stdout='{}', stderr=''), 'invalid unified log data'),
        ]
        now = dt.datetime(2026, 11, 13, 12, tzinfo=dt.timezone.utc).timestamp()
        for failure, result, message in cases:
            with self.subTest(failure=failure, message=message):
                def run(*args, **kwargs):
                    if isinstance(result, Exception):
                        raise result
                    return result
                self.assertFalse(collector.collect(now, [], lambda a,b: collector.unified(a,b,run)))
                row = self.rows('crash.source')[-1]
                self.assertEqual(row['props']['source'], 'unified')
                self.assertEqual(row['props']['failure'], failure)
                self.assertEqual(row['props']['exitCode'], getattr(result, 'returncode', None))
                self.assertGreaterEqual(row['props']['elapsedMs'], 0)
                self.assertEqual(row['error']['message'], message)
                self.assertNotIn('unified', jobs.read_state('crashes'))
                self.assertNotIn('private', json.dumps(self.rows('crash.source')))

    def test_unreadable_report_directory_has_own_error_and_keeps_cursor(self):
        original = Path.iterdir
        def iterdir(path):
            if path == self.root:
                raise PermissionError(errno.EACCES, 'Permission denied', str(path))
            return original(path)
        with patch.object(Path, 'iterdir', iterdir):
            self.assertFalse(collector.collect(200, [self.root], lambda a,b: {}))
        row = self.rows('crash.source')[0]
        self.assertEqual(row['props']['source'], str(self.root))
        self.assertEqual(row['props']['failure'], 'permission')
        self.assertIsNone(row['props']['exitCode'])
        self.assertIn('Permission denied', row['error']['message'])
        self.assertNotIn('reports0', jobs.read_state('crashes'))
        self.assertEqual(jobs.read_state('crashes')['unified'], 200)

    def test_sample_inventory_state_does_not_change_own_success(self):
        for state in ({}, dict(at=1, sizes={}, sourceErrors=13),
                      dict(at=9999, sizes={}, sourceErrors=2)):
            with self.subTest(state=state), patch.object(jobs.time, 'time', return_value=10000):
                jobs.save_state('disk-inventory', state)
                jobs.disk_sample(self.root, self.root/'tmp', volumes=(self.root, self.root), paths=[])
                row = self.rows('disk.sample')[-1]
                self.assertTrue(row['ok'])
                self.assertEqual(row['props']['inventorySourceErrors'], state.get('sourceErrors', 0))
                self.assertEqual(row['props']['inventoryStale'], not state or state['at'] == 1)
                self.assertEqual(row['props']['inventoryAgeS'], 10000-state['at'] if state else None)
        with patch.object(jobs.os, 'statvfs', side_effect=OSError('failed')):
            jobs.disk_sample(self.root, self.root/'tmp', paths=[])
        self.assertFalse(self.rows('disk.sample')[-1]['ok'])

    def test_source_messages_are_bounded_redacted_and_opt_in(self):
        for name in ('disk.inventory.source', 'crash.source'):
            toollog.emit('disk', 'error', name, error_tag='source.failed',
                         error_message='  du: '+('x'*400)+'\nprivate contents')
            row = self.rows(name)[-1]
            self.assertEqual(len(row['error']['message']), 300)
            toollog.emit('disk', 'error', name, error_tag='source.failed',
                         error_message='password=do-not-log')
            self.assertNotIn('do-not-log', self.rows(name)[-1]['error']['message'])
        toollog.emit('backup', 'error', 'backup.run', error_tag='backup.failed', error_message='private contents')
        self.assertEqual(self.rows('backup.run')[0]['error']['message'], 'backup.failed')

    def test_sample_existing_file_stat_failure_is_not_hidden(self):
        denied = self.root/'denied.db'
        original = Path.stat
        def stat(path, *args, **kwargs):
            if path == denied:
                raise PermissionError(errno.EACCES, 'Permission denied', str(path))
            return original(path, *args, **kwargs)
        with patch.object(Path, 'stat', stat):
            jobs.disk_sample(self.root, self.root/'tmp', volumes=(self.root, self.root),
                             paths=[denied, self.root/'optional-missing-wal'])
        row = self.rows('disk.sample')[-1]
        self.assertFalse(row['ok'])
        self.assertEqual(row['props']['sourceErrors'], 1)
