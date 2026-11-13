import datetime as dt
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


class BigRootTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root / 'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.big = self.root / 'big'
        self.big.mkdir()
        roots = patch.object(jobs, 'BIG_ROOTS', {self.big}, create=True)
        roots.start()
        self.addCleanup(roots.stop)

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def test_slow_child_preserves_named_partial_and_does_not_reuse_old_total(self):
        for child in ('fast', 'slow'):
            (self.big / child).mkdir()
        jobs.save_state('disk-inventory', dict(at=1, sizes={str(self.big): 999999}))
        def run(cmd, **kwargs):
            if cmd[-1].endswith('/slow'):
                raise subprocess.TimeoutExpired(cmd, kwargs['timeout'], output='private')
            return SimpleNamespace(returncode=0, stdout='42\t'+cmd[-1], stderr='')
        jobs.directory_inventory([self.big], run)
        state = jobs.read_state('disk-inventory')
        self.assertEqual(state['sizes'][str(self.big)], 42*1024)
        self.assertTrue(state['partials'][str(self.big)]['partial'])
        root = [r for r in self.rows('disk.inventory.source') if r['props']['source'] == str(self.big)][-1]
        self.assertFalse(root['ok'])
        self.assertEqual(root['props']['failure'], 'partial')
        self.assertEqual(root['props']['failedCount'], 1)
        child = [r for r in self.rows('disk.inventory.source') if r['props']['source'].endswith('/slow')][0]
        self.assertEqual(child['props']['failure'], 'timeout')
        self.assertNotIn('private', json.dumps(self.rows('disk.inventory.source')))

    def test_no_readable_children_is_error_even_with_old_total(self):
        (self.big/'slow').mkdir()
        jobs.save_state('disk-inventory', dict(at=1, sizes={str(self.big): 999999}))
        def run(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw['timeout'])
        jobs.directory_inventory([self.big], run)
        state = jobs.read_state('disk-inventory')
        self.assertNotIn(str(self.big), state['sizes'])
        self.assertEqual(state['sourceErrors'], 1)
        self.assertFalse(self.rows('disk.inventory.source')[-1]['ok'])

    def test_complete_and_empty_big_root(self):
        def run(cmd, **kw):
            return SimpleNamespace(returncode=0, stdout='42\t'+cmd[-1], stderr='')
        jobs.directory_inventory([self.big], run)
        self.assertEqual(jobs.read_state('disk-inventory')['sizes'][str(self.big)], 0)
        for child in ('a', 'b'):
            (self.big/child).mkdir()
        jobs.directory_inventory([self.big], run)
        self.assertEqual(jobs.read_state('disk-inventory')['sizes'][str(self.big)], 84*1024)
        self.assertTrue(self.rows('disk.inventory.source')[-1]['ok'])

    def test_partial_coverage_cannot_become_a_grower(self):
        for value, partial in [(1, True), (100, False), (200, True), (300, False), (400, False)]:
            jobs.save_state('disk-inventory', dict(at=10000, sizes={str(self.big): value},
                partials={str(self.big): {'partial': True}} if partial else {}))
            with patch.object(jobs.time, 'time', return_value=10000):
                jobs.disk_sample(self.root, self.root/'missing', volumes=(self.root,self.root), paths=[])
            self.assertEqual(self.rows('disk.sample')[-1]['props']['count'], int(value == 400))

    def test_all_slow_roots_share_collectors_five_minute_budget(self):
        roots = []
        for i in range(9):
            root = self.root/str(i)
            root.mkdir()
            roots.append(root)
        for i in range(100):
            (self.big/str(i)).mkdir()
        clock, budgets = [0], []
        def run(cmd, **kw):
            budgets.append(kw['timeout'])
            clock[0] += kw['timeout']
            raise subprocess.TimeoutExpired(cmd, kw['timeout'])
        inventory = jobs.directory_inventory
        collect = collector.collect
        def probe():
            clock[0] += 80
        def crashes(**kw):
            return collect(10000, [], lambda a,b: collector.unified(a,b,run), **kw)
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collector, 'disk_wait'), \
             patch.object(collector, 'disk_tooling_probe', side_effect=probe), \
             patch.object(collector, 'directory_inventory', side_effect=lambda **kw: inventory([self.big]+roots, run, **kw)), \
             patch.object(collector, 'collect', side_effect=crashes):
            collector.main()
        self.assertLessEqual(clock[0], 300)
        self.assertTrue(all(b <= 60 for b in budgets))
        self.assertEqual(jobs.read_state('disk-inventory')['sourceErrors'], 10)

    def test_listing_failure_forms_keep_completed_children(self):
        failures = [PermissionError(13, 'Permission denied'),
                    OSError(5, 'Input/output error'), FileNotFoundError(2, 'No such file')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                class Entries:
                    def __enter__(inner):
                        return inner
                    def __exit__(inner, *args):
                        return False
                    def __iter__(inner):
                        yield SimpleNamespace(path=str(self.big/'fast'))
                        raise failure
                def run(cmd, **kw):
                    return SimpleNamespace(returncode=0, stdout='42\t'+cmd[-1], stderr='')
                with patch.object(jobs.os, 'scandir', return_value=Entries()):
                    jobs.directory_inventory([self.big], run)
                state = jobs.read_state('disk-inventory')
                self.assertEqual(state['sizes'][str(self.big)], 42*1024)
                self.assertTrue(state['partials'][str(self.big)]['partial'])
                self.assertEqual(state['children'][str(self.big)][str(self.big/'fast')], 42*1024)
                self.assertEqual(state['sourceErrors'], 1)
                error = [r for r in self.rows('disk.inventory.source')
                         if r['props'].get('failure') not in (None, 'partial')][-1]
                self.assertEqual(error['props']['failure'],
                                 'permission' if isinstance(failure, PermissionError) else 'exit')

    def test_slow_report_source_does_not_starve_later_sources(self):
        roots = [self.root/'reports0', self.root/'reports1', self.root/'reports2']
        clock, calls = [0], []
        for root in roots:
            root.mkdir()
        (roots[1]/'Finder.crash').write_text('private')
        os.utime(roots[1]/'Finder.crash', (9990,9990))
        reports = collector.reports
        def read(root, since, until, deadline=None, completed=None, stats=None):
            calls.append((root, deadline))
            if root == roots[0]:
                clock[0] = 6
                raise jobs.SourceFailure('timeout', 'report budget exhausted')
            return reports(root, since, until, deadline, completed, stats)
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collector, 'reports', side_effect=read):
            self.assertFalse(collector.collect(10000, roots, lambda a,b: {}, deadline=65))
        state = jobs.read_state('crashes')
        self.assertNotIn('reports0', state)
        self.assertEqual(state['reports1'], 10000)
        self.assertEqual(state['reports2'], 10000)
        self.assertGreater(calls[1][1], clock[0])
        self.assertEqual(self.rows('crash.observed')[-1]['props']['process'], 'Finder')

    def test_capped_window_skipped_time_and_exact_retry_then_cursor_progress(self):
        now = dt.datetime(2026,11,13,12,tzinfo=dt.timezone.utc).timestamp()
        jobs.save_state('crashes', {'unified': now-86400})
        windows = []
        def fail(a,b):
            windows.append((a,b))
            raise subprocess.TimeoutExpired('log',60)
        self.assertFalse(collector.collect(now, [], fail))
        self.assertEqual(jobs.read_state('crashes')['unified'], now-86400)
        row = self.rows('crash.source')[-1]
        self.assertEqual(row['props']['windowS'], 3600)
        self.assertEqual(row['props']['skippedS'], 82800)
        self.assertEqual(row['props']['windowEnd'], now)
        def success(a,b):
            windows.append((a,b))
            return {}
        self.assertTrue(collector.collect(now+7200, [], success))
        self.assertEqual(windows[0], windows[1])
        self.assertEqual(jobs.read_state('crashes')['unified'], now)
        self.assertTrue(collector.collect(now+10800, [], success))
        self.assertEqual(jobs.read_state('crashes')['unified'], now+10800)
        row = self.rows('crash.source')[-1]
        self.assertEqual(row['props']['skippedS'], 7200)
        self.assertEqual(row['props']['windowS'], 3600)

    def test_direct_unified_call_is_also_capped(self):
        commands = []
        def run(cmd, **kw):
            commands.append(cmd)
            return SimpleNamespace(returncode=0, stdout='[]', stderr='')
        collector.unified(0, 10000, run)
        cmd = commands[0]
        self.assertEqual(cmd[cmd.index('--start')+1], '1970-01-01 01:46:40')
