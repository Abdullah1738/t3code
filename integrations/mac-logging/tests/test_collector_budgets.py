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
        env.start()
        self.addCleanup(env.stop)

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def good(self, command, **kwargs):
        return SimpleNamespace(returncode=0, stdout='10\t'+command[-1]+'\n', stderr='')

    def test_child_timeout_keeps_good_cache_and_measures_siblings(self):
        root = self.root/'big'
        root.mkdir()
        fast, slow = root/'fast', root/'slow'
        fast.mkdir()
        slow.mkdir()
        with patch.object(jobs.time, 'time', return_value=100):
            jobs.directory_inventory([root], self.good)
        def run(command, **kwargs):
            self.assertLessEqual(kwargs['timeout'], 60)
            if command[-1] == str(slow):
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return self.good(command, **kwargs)
        with patch.object(jobs.time, 'time', return_value=86500):
            jobs.directory_inventory([root], run)
        state = jobs.read_state('disk-inventory')
        cached = state['childState'][str(root)]
        self.assertEqual((cached[str(slow)]['bytes'], cached[str(slow)]['at']), (10*1024, 100))
        self.assertEqual(cached[str(fast)]['at'], 86500)
        self.assertEqual(state['sizes'][str(root)], 20*1024)
        self.assertIn(str(root), state['partials'])
        props = self.rows('disk.inventory')[-1]['props']
        self.assertEqual((props['rootsOk'], props['rootsPartial'], props['rootsTimeout'], props['rootsDenied']),
                         (0, 1, 1, 0))
        self.assertGreaterEqual(props['scanMs'], 0)

    def test_missing_du_permission_and_timeout_keep_last_good_sizes(self):
        cases = (
            ('missing-du', FileNotFoundError(errno.ENOENT, 'fixture', '/usr/bin/du'), 0, 0),
            ('no-filename', FileNotFoundError(errno.ENOENT, 'fixture'), 0, 0),
            ('permission', PermissionError(errno.EACCES, 'fixture', '/usr/bin/du'), 0, 1),
            ('timeout', subprocess.TimeoutExpired('du', 15), 1, 0),
        )
        for name, error, timed_out, denied in cases:
            with self.subTest(name=name):
                root = self.root/name
                root.mkdir()
                child = root/'child'
                child.mkdir()
                with patch.object(jobs.time, 'time', return_value=100):
                    jobs.directory_inventory([root], self.good)
                def run(command, **kwargs):
                    raise error
                with patch.object(jobs.time, 'time', return_value=86500):
                    jobs.directory_inventory([root], run)
                state = jobs.read_state('disk-inventory')
                self.assertEqual(state['sizes'][str(root)], 10*1024)
                self.assertEqual(state['childState'][str(root)][str(child)]['at'], 100)
                self.assertEqual(state['sourceErrors'], 1)
                self.assertIn(str(root), state['partials'])
                props = self.rows('disk.inventory')[-1]['props']
                self.assertEqual((props['rootsTimeout'], props['rootsDenied']), (timed_out, denied))
                child.rmdir()
                with patch('subprocess.run') as unused:
                    jobs.directory_inventory([root], unused)
                    unused.assert_not_called()
                state = jobs.read_state('disk-inventory')
                self.assertEqual(state['sizes'][str(root)], 0)
                self.assertNotIn(str(root), state['partials'])
                self.assertEqual(self.rows('disk.inventory')[-1]['props']['rootsOk'], 1)

    def test_listing_failure_counts_root_once_and_retains_cache(self):
        for name, error, expected in (
                ('timeout', jobs.SourceFailure('timeout', 'fixture'), (1, 0)),
                ('permission', PermissionError(errno.EACCES, 'fixture'), (0, 1))):
            with self.subTest(name=name):
                root = self.root/name
                root.mkdir()
                (root/'child').mkdir()
                jobs.directory_inventory([root], self.good)
                original = jobs.deadline_call
                def call(deadline, operation, *args, **kwargs):
                    if operation == jobs.os.scandir and args == (root,):
                        raise error
                    return original(deadline, operation, *args, **kwargs)
                with patch.object(jobs, 'deadline_call', side_effect=call):
                    jobs.directory_inventory([root], self.good)
                state = jobs.read_state('disk-inventory')
                self.assertEqual(state['sizes'][str(root)], 10*1024)
                props = self.rows('disk.inventory')[-1]['props']
                self.assertEqual((props['rootsTimeout'], props['rootsDenied']), expected)
                self.assertEqual(props['rootsPartial'], 1)

    def test_partial_permission_totals_and_removal_are_counted(self):
        root = self.root/'big'
        root.mkdir()
        children = [root/name for name in ('a', 'b')]
        for child in children:
            child.mkdir()
        def partial(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout='10\t'+command[-1]+'\n',
                                   stderr='du: entry: Permission denied')
        jobs.directory_inventory([root], partial)
        props = self.rows('disk.inventory')[-1]['props']
        self.assertEqual((props['rootsOk'], props['rootsPartial'], props['rootsTimeout'], props['rootsDenied']),
                         (0, 1, 0, 1))
        for child in children:
            child.rmdir()
        jobs.directory_inventory([root], self.good)
        props = self.rows('disk.inventory')[-1]['props']
        self.assertEqual((props['rootsOk'], props['rootsPartial'], props['rootsDenied']), (1, 0, 0))

    def test_malformed_child_cache_cannot_supply_a_total(self):
        root = self.root/'big'
        root.mkdir()
        child = root/'child'
        child.mkdir()
        for old in (None, [], {'bytes': 'bad', 'at': 100, 'attemptedAt': []},
                    {'bytes': 1024, 'at': 100000000000}, {'bytes': -1, 'at': 100}):
            with self.subTest(cache=old):
                jobs.save_state('disk-inventory', dict(duMode='links',
                    childState={str(root): {str(child): old}}, attemptedAt={str(root): 'bad'}))
                def run(command, **kwargs):
                    raise subprocess.TimeoutExpired(command, kwargs['timeout'])
                jobs.directory_inventory([root], run)
                state = jobs.read_state('disk-inventory')
                self.assertNotIn(str(root), state['sizes'])
                props = self.rows('disk.inventory')[-1]['props']
                self.assertEqual((props['rootsOk'], props['rootsPartial'], props['rootsTimeout']), (0, 1, 1))

    def test_inventory_mix_reaches_daily_rollup_without_counting_lock_skips(self):
        now = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        for _ in range(2):
            toollog.emit('disk', 'perf', 'disk.inventory', now=now, props=dict(
                rootsOk=2, rootsPartial=1, rootsTimeout=1, rootsDenied=3, scanMs=42))
        toollog.emit('disk', 'perf', 'disk.inventory', now=now,
                     props=dict(skipReason='deep_pass_running', rootsPartial=10))
        summary = rollup('2026-11-13')['diskInventory']
        self.assertEqual(summary, dict(scans=2, rootsOk=4, rootsPartial=2, rootsTimeout=2, rootsDenied=6, scanMs=84))


if __name__ == '__main__':
    unittest.main()
