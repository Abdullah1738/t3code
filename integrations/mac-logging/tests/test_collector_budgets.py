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
import toollog
from rollup import rollup


class CollectorBudgetTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start(); self.addCleanup(env.stop)

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson') for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def test_child_timeout_keeps_good_cache_and_measures_siblings(self):
        root = self.root/'big'; root.mkdir()
        for name in ('slow', 'fast'):
            (root/name).mkdir()
        db = root/'db.sqlite'; db.write_bytes(b'db metadata only')
        calls = []
        slow = [False]
        def run(command, **kwargs):
            calls.append(command[-1])
            self.assertLessEqual(kwargs['timeout'], 20)
            self.assertNotEqual(command[-1], str(root))
            self.assertNotEqual(command[-1], str(db))
            if slow[0] and command[-1] == str(root/'slow'):
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return SimpleNamespace(returncode=0, stdout='10\t'+command[-1], stderr='')
        with patch.object(jobs.time, 'time', return_value=100):
            jobs.directory_inventory([root], run, split_roots=[root])
        slow[0] = True
        with patch.object(jobs.time, 'time', return_value=3700):
            jobs.directory_inventory([root], run, split_roots=[root])
        state = jobs.read_state('disk-inventory')
        child = state['children'][str(root)]['slow']
        self.assertEqual((child['bytes'], child['at'], child['ageS']), (10*1024, 100, 3600))
        expected_file = db.stat().st_blocks*512
        self.assertEqual(state['sizes'][str(root)], 20*1024+expected_file)
        source = [r for r in self.rows('disk.inventory.source') if r['props'].get('child') == 'slow'][-1]
        self.assertEqual(source['props']['failure'], 'timeout')
        self.assertEqual(source['props']['ageS'], 3600)
        self.assertTrue(source['props']['cached'])
        summary = self.rows('disk.inventory')[-1]['props']
        self.assertEqual((summary['rootsOk'], summary['rootsPartial'], summary['rootsTimeout']), (0, 1, 1))
        self.assertIn(str(root), state['partials'])
        if os.environ.get('COLLECTOR_SHOW_EVIDENCE') == '1':
            print(json.dumps(source, separators=(',', ':')))
            print(json.dumps(self.rows('disk.inventory')[-1], separators=(',', ':')))

    def test_root_budget_rotates_unattempted_roots_first(self):
        roots = [self.root/str(i) for i in range(7)]
        for root in roots: root.mkdir()
        clock, calls = [0], []
        def run(command, **kwargs):
            calls.append(command[-1]); clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(jobs.time, 'time', return_value=100):
            jobs.directory_inventory(roots, run)
        self.assertLessEqual(clock[0], 300)
        calls.clear()
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(jobs.time, 'time', return_value=3700):
            jobs.directory_inventory(roots, run)
        self.assertEqual(calls[:2], [str(roots[5]), str(roots[6])])
        self.assertLessEqual(clock[0], 600)

    def test_unified_backlog_advances_in_two_hour_chunks_without_skipping(self):
        jobs.save_state('crashes', {'unified': 100, 'rollupDay': '1969-12-31'})
        calls = []
        def reader(since, until): calls.append((since, until)); return {}
        self.assertTrue(collector.collect(30000, [], reader))
        self.assertEqual(calls, [(100, 7300)])
        self.assertEqual(jobs.read_state('crashes')['unified'], 7300)
        self.assertTrue(collector.collect(30000, [], reader))
        self.assertEqual(calls[-1], (7300, 14500))

    def test_children_without_a_good_total_rotate_after_timeout(self):
        root = self.root/'big'; root.mkdir()
        children = [root/str(i) for i in range(7)]
        for child in children: child.mkdir()
        clock, calls = [0], []
        def run(command, **kwargs):
            calls.append(command[-1]); clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        for now in (100, 3700):
            with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(jobs.time, 'time', return_value=now):
                jobs.directory_inventory([root], run, split_roots=[root])
        self.assertEqual(calls[:3], [str(c) for c in children[:3]])
        self.assertEqual(calls[3:6], [str(c) for c in children[3:6]])
        self.assertLessEqual(clock[0], 120)
        self.assertEqual(jobs.read_state('disk-inventory')['sizes'], {})

    def test_real_sleeping_log_command_keeps_committed_cursor(self):
        jobs.save_state('crashes', {'unified': 100})
        def run(command, **kwargs):
            self.assertEqual(command[:2], ['/usr/bin/log', 'show'])
            self.assertEqual(kwargs['timeout'], 60)
            kwargs['timeout'] = 0.05
            return subprocess.run([sys.executable, '-c', 'import time; time.sleep(20)'], **kwargs)
        self.assertFalse(collector.collect(30000, [], lambda a, b: collector.unified(a, b, run)))
        self.assertEqual(jobs.read_state('crashes')['unified'], 100)
        source = self.rows('crash.source')[-1]['props']
        self.assertEqual((source['failure'], source['windowS']), ('timeout', 7200))

    def test_child_permission_partial_and_removal_summary(self):
        root = self.root/'big'; root.mkdir()
        child = root/'directory'; child.mkdir()
        def partial(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout='10\t'+command[-1], stderr='du: entry: Permission denied')
        jobs.directory_inventory([root], partial, split_roots=[root])
        summary = self.rows('disk.inventory')[-1]
        self.assertTrue(summary['ok'])
        self.assertEqual((summary['props']['rootsPartial'], summary['props']['rootsDenied']), (1, 1))
        child.rmdir()
        with patch.object(subprocess, 'run') as run:
            jobs.directory_inventory([root], run, split_roots=[root])
            run.assert_not_called()
        state = jobs.read_state('disk-inventory')
        self.assertEqual(state['children'][str(root)], {})
        self.assertEqual(state['sizes'][str(root)], 0)
        self.assertEqual(self.rows('disk.inventory')[-1]['props']['rootsOk'], 1)

    def test_malformed_child_cache_does_not_supply_fake_sizes(self):
        root = self.root/'big'; root.mkdir(); (root/'slow').mkdir()
        for old in (None, [], {'bytes': 'bad', 'at': 100, 'attemptedAt': []},
                    {'bytes': 1024, 'at': 100000000000}, {'bytes': -1, 'at': 100}):
            with self.subTest(cache=old):
                jobs.save_state('disk-inventory', dict(children={str(root): {'slow': old}}, attemptedAt={str(root): 'bad'}))
                def run(command, **kwargs): raise subprocess.TimeoutExpired(command, kwargs['timeout'])
                jobs.directory_inventory([root], run, split_roots=[root])
                state = jobs.read_state('disk-inventory')
                self.assertNotIn(str(root), state['sizes'])
                self.assertFalse(self.rows('disk.inventory.source')[-1]['props']['cached'])

    def test_cached_age_advances_even_when_root_cannot_get_scan_budget(self):
        roots = [self.root/str(i) for i in range(6)]
        for root in roots: root.mkdir()
        big = roots[-1]
        jobs.save_state('disk-inventory', dict(attemptedAt={str(big): 100},
                        children={str(big): {'cached': dict(bytes=1024, at=100, ageS=0)}}))
        clock = [0]
        def run(command, **kwargs):
            clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(jobs.time, 'time', return_value=3700):
            jobs.directory_inventory(roots, run, split_roots=[big])
        self.assertEqual(jobs.read_state('disk-inventory')['children'][str(big)]['cached']['ageS'], 3600)

    def test_unified_first_failure_retries_same_start_and_logs_window(self):
        calls = []
        def reader(since, until):
            calls.append((since, until))
            raise subprocess.TimeoutExpired('log', 60)
        self.assertFalse(collector.collect(10000, [], reader))
        self.assertFalse(collector.collect(20000, [], reader))
        self.assertEqual(calls, [(6400, 10000), (6400, 13600)])
        source = self.rows('crash.source')[-1]
        self.assertEqual(source['props']['windowS'], 7200)
        self.assertGreaterEqual(source['props']['elapsedMs'], 0)
        self.assertNotIn('unified', jobs.read_state('crashes'))
        if os.environ.get('COLLECTOR_SHOW_EVIDENCE') == '1': print(json.dumps(source, separators=(',', ':')))

    def test_direct_unified_reader_caps_query_and_ignores_boundary_overlap(self):
        seen = []
        def run(command, **kwargs):
            seen.append(command)
            self.assertLessEqual(kwargs['timeout'], 90)
            def stamp(at): return dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat()
            return SimpleNamespace(returncode=0, stdout=json.dumps([
                dict(timestamp=stamp(100), eventMessage='=== system boot'),
                dict(timestamp=stamp(7300), eventMessage='=== system boot'),
                dict(timestamp=stamp(7301), eventMessage='=== system boot')]), stderr='')
        counts = collector.unified(100, 30000, run)
        self.assertEqual(sum(counts.values()), 1)
        command = seen[0]
        start = command[command.index('--start')+1]
        end = command[command.index('--end')+1]
        self.assertLessEqual((dt.datetime.fromisoformat(end)-dt.datetime.fromisoformat(start)).total_seconds(), 7201)

    def test_inventory_mix_reaches_daily_rollup(self):
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        for _ in range(2):
            toollog.emit('disk', 'perf', 'disk.inventory', now=now, props=dict(
                rootsOk=2, rootsPartial=1, rootsTimeout=1, rootsDenied=3, scanMs=42))
        summary = rollup('2026-11-13')['diskInventory']
        self.assertEqual(summary, dict(scans=2, rootsOk=4, rootsPartial=2, rootsTimeout=2, rootsDenied=6, scanMs=84))


if __name__ == '__main__': unittest.main()
