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
import deep_inventory
import jobs
from rollup import rollup


class InventoryLoggingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)/'ExternalSSD'/'board-wt'
        self.root.mkdir(parents=True)
        self.logs = Path(temp.name)/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.clock = 0
        for name, value in [('time', lambda: 1000000+self.clock), ('monotonic', lambda: self.clock)]:
            timer = patch.object(jobs.time, name, side_effect=value)
            timer.start()
            self.addCleanup(timer.stop)

    def rows(self, name=None):
        return [r for p in self.logs.glob('*.ndjson') for r in map(json.loads, p.read_text().splitlines())
                if name is None or r['name'] == name]

    def test_notable_boundaries_increases_decreases_new_and_zero(self):
        gib = 1024**3
        cases = [
            (10*gib, 10*gib+int(.99*gib), 0, False),
            (10*gib, 11*gib, 0, True),
            (10*gib, 10*gib-int(.99*gib), 0, False),
            (10*gib, 9*gib, 0, True),
            (100000, 119000, 0, False), (100000, 120000, 0, True),
            (100000, 81000, 0, False), (100000, 80000, 0, True),
            (None, int(.99*gib), 0, False), (None, gib, 0, True),
            (1000, 1000, 9900, False), (1000, 1000, 10000, True),
            (0, 0, 0, False), (0, 1, 0, True), (1, 0, 0, True),
        ]
        for old, size, elapsed, notable in cases:
            with self.subTest(old=old, size=size, elapsed=elapsed):
                before = len(self.rows())
                jobs.InventoryLog(self.root).child(str(self.root/'child'), size,
                    {} if old is None else dict(bytes=old), elapsed)
                self.assertEqual(len(self.rows())-before, int(notable))

    def fixture(self, errors=False):
        entries = [SimpleNamespace(path=str(self.root/('%04d'%i)), is_dir=lambda **kw: True)
                   for i in range(1000)]
        sizes = {e.path: 100*1024 for e in entries}
        cache = {key: dict(bytes=size, at=1, attemptedAt=1, partial=False) for key, size in sizes.items()}
        cache[entries[0].path]['bytes'] = 10*1024**3
        sizes[entries[0].path] = 11*1024**3
        sizes[entries[1].path] = 120*1024
        cache.pop(entries[2].path)
        sizes[entries[2].path] = 1024**3
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): cache}))
        def run(cmd, **kw):
            self.clock += .5
            return SimpleNamespace(returncode=0, stderr='', stdout=''.join(
                '%d\t%s\n' % (sizes[key]//1024, key) for key in cmd[2:]
                if not errors or key != entries[-1].path))
        return entries, run

    def test_hourly_thousand_children_three_notable_two_errors_exact_count(self):
        entries, run = self.fixture(errors=True)
        with patch.object(jobs, 'inventory_listing', return_value=(entries, True)):
            jobs.directory_inventory([self.root], run)
        rows = self.rows()
        sources = self.rows('disk.inventory.source')
        self.assertEqual(sum(r.get('ok') is True for r in sources), 3)
        self.assertEqual(sum(r['kind'] == 'error' for r in sources), 2)
        self.assertEqual({r['props']['failure'] for r in sources if r['kind'] == 'error'},
                         {'missing-total', 'partial'})
        self.assertEqual(len(self.rows('disk.inventory.root')), 1)
        self.assertEqual(len(rows), 7)  # Six detail events plus the existing run summary.
        props = self.rows('disk.inventory.root')[0]['props']
        self.assertEqual(props['root'], str(self.root))
        self.assertEqual(props['childrenMeasured'], 999)
        self.assertEqual(props['childrenCached'], 1000)
        self.assertEqual(props['childrenPartial'], 1)
        self.assertEqual(props['unmeasuredCount'], 0)
        self.assertTrue(props['partial'])
        state = jobs.read_state('disk-inventory')
        self.assertEqual(props['bytes'], sum(v['bytes'] for v in state['childState'][str(self.root)].values()))
        self.assertGreater(props['elapsedMs'], 0)
        self.assertIn(props['slowestChildPath'], {e.path for e in entries})

    def test_deep_thousand_children_one_root_across_multiple_turns(self):
        entries, run = self.fixture()
        with patch.object(jobs, 'inventory_listing', return_value=(entries, True)):
            deep_inventory.run_pass([self.root], run, budget=100)
        sources = self.rows('disk.inventory.source')
        attempts = [r for r in sources if 'cpuS' in r['props']]
        self.assertGreater(len(attempts), 0)
        self.assertEqual(sum(r['props'].get('completedCount', 1) for r in attempts), 1000)
        self.assertTrue(all(r['props']['allowanceS'] > 0 for r in attempts))
        self.assertEqual(len(self.rows('disk.inventory.root')), 1)
        self.assertEqual(len(self.rows('disk.deep.root')), 1)
        self.assertEqual(len(self.rows()), len(sources)+4)
        props = self.rows('disk.inventory.root')[0]['props']
        self.assertEqual(props['childrenMeasured'], 1000)
        self.assertEqual(props['childrenCached'], 1000)
        self.assertEqual(props['childrenPartial'], 0)
        self.assertFalse(props['partial'])

    def test_batch_timing_does_not_make_every_member_slow(self):
        entries, _ = self.fixture()
        cache = {}
        log = jobs.InventoryLog(self.root)
        def run(cmd, **kw):
            self.clock += len(cmd[2:])*.1
            return SimpleNamespace(returncode=0, stderr='', stdout=''.join('1\t'+key+'\n' for key in cmd[2:]))
        jobs.big_root_inventory(self.root, run, 200, cache, (entries, True), inventory_log=log)
        self.assertEqual(self.rows('disk.inventory.source'), [])
        self.assertAlmostEqual(log.slowest_ms, 100, places=5)

    def test_partial_and_limited_rows_survive_and_unknown_bytes_are_omitted(self):
        child = self.root/'child'
        child.mkdir()
        for deep in (False, True):
            with self.subTest(deep=deep), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(deep))):
                def denied(cmd, **kw):
                    return SimpleNamespace(returncode=1, stdout='42\t'+cmd[-1]+'\n',
                                           stderr='du: blocked: Permission denied')
                if deep:
                    deep_inventory.run_pass([self.root], denied, budget=20)
                else:
                    jobs.directory_inventory([self.root], denied)
                rows = [r for p in (self.logs/str(deep)).glob('*.ndjson')
                        for r in map(json.loads, p.read_text().splitlines())]
                partials = [r for r in rows if r['name'] == 'disk.inventory.source' and r['props']['source'] == str(child)]
                self.assertTrue(partials)
                self.assertTrue(all(r['props']['partial'] and r['props']['deniedCount'] == 1 for r in partials))
                root_props = next(r['props'] for r in rows if r['name'] == 'disk.inventory.root')
                self.assertEqual((root_props['deniedCount'], root_props['partialChildCount']), (1, 0))
        cache = {str(child): dict(partial=True, limited=True, attemptedAt=1)}
        total, status, _ = jobs.inventory_status(cache, [SimpleNamespace(path=str(child))], True, 1000000)
        jobs.InventoryLog(self.root).root_event(cache, total, status)
        props = self.rows('disk.inventory.root')[-1]['props']
        self.assertEqual(props['childrenPartial'], 1)
        self.assertEqual(props['unmeasuredCount'], 1)
        self.assertEqual((props['deniedCount'], props['partialChildCount']), (0, 1))
        self.assertNotIn('bytes', props)

    def test_nested_parts_share_root_summary_and_notable_filter(self):
        child = self.root/'giant'
        child.mkdir()
        for name in ('small', 'large'):
            (child/name).mkdir()
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): {
            str(child): dict(partial=True, timeouts=1, lastTimeoutS=60, attemptedAt=1)}}))
        def run(cmd, **kw):
            self.clock += .01
            return SimpleNamespace(returncode=0, stderr='', stdout=''.join(
                '%d\t%s\n' % (1024**2 if key.endswith('/large') else 1, key) for key in cmd[2:]))
        deep_inventory.run_pass([self.root], run, budget=100)
        sources = self.rows('disk.inventory.source')
        self.assertEqual({r['props']['source'] for r in sources},
                         {str(child/'large'), str(child/'small'), str(child)})
        self.assertEqual(len(self.rows('disk.inventory.root')), 1)
        self.assertEqual(self.rows('disk.inventory.root')[0]['props']['childrenMeasured'], 1)

    def test_parts_refresh_compares_size_before_expiry_discards_parent_total(self):
        child = self.root/'giant'
        child.mkdir()
        (child/'part').mkdir()
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): {
            str(child): dict(bytes=500*1024**2, at=1, partial=False, parts={}, isDirectory=True)}}))
        def run(cmd, **kw):
            return SimpleNamespace(returncode=0, stderr='', stdout=''.join(
                '%d\t%s\n' % (800*1024, key) for key in cmd[2:]))
        deep_inventory.run_pass([self.root], run, budget=100)
        self.assertEqual([r['props']['source'] for r in self.rows('disk.inventory.source')],
                         [str(child/'part'), str(child)])

    def test_parts_baseline_survives_multiple_turns(self):
        child = self.root/'giant'
        child.mkdir()
        parts = [child/('%04d'%i) for i in range(129)]
        for part in parts:
            part.mkdir()
        # Keep the exact 20% boundary independent of delayed directory-block
        # allocation between the fixture's stat and the scanner's later lstat.
        metadata = child.stat()
        own = ((metadata.st_blocks*512+1023)//1024)*1024
        for old, new, notable in [(1024, 1024, False), (500, 400, True),
                                  (500, 600, True), (500, 405, False)]:
            with self.subTest(old=old, new=new), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(new))):
                jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): {
                    str(child): dict(bytes=old*1024**2, at=1, partial=True, parts={}, isDirectory=True)}}))
                calls = []
                def run(cmd, **kw):
                    calls.append(cmd)
                    self.clock += .001
                    return SimpleNamespace(returncode=0, stderr='', stdout=''.join(
                        '%d\t%s\n' % ((new*1024**2-own)//1024 if key == str(parts[0]) else 0, key)
                        for key in cmd[2:]))
                with patch.object(jobs.os, 'lstat', return_value=metadata):
                    deep_inventory.run_pass([self.root], run, budget=100)
                rows = [r for p in (self.logs/str(new)).glob('*.ndjson')
                        for r in map(json.loads, p.read_text().splitlines())]
                self.assertEqual(sum(r['name'] == 'disk.inventory.source' and r['props']['source'] == str(child)
                                     and 'cpuS' not in r['props']
                                     for r in rows), int(notable))
                self.assertEqual(len(calls), 2)

    def test_failed_decomposed_file_keeps_slowest_timing(self):
        child = self.root/'file'
        child.touch()
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): {
            str(child): dict(partial=True, timeouts=1, lastTimeoutS=60, attemptedAt=1)}}))
        def run(cmd, **kw):
            self.clock += 40
            raise subprocess.TimeoutExpired(cmd, 40)
        deep_inventory.run_pass([self.root], run, budget=100)
        props = self.rows('disk.inventory.root')[0]['props']
        self.assertEqual(props['slowestChildMs'], 40000)
        self.assertEqual(props['slowestChildPath'], str(child))
        self.assertEqual(self.rows('disk.inventory.source')[0]['props']['elapsedMs'], 40000)

    def test_lock_skipped_runs_summarize_cached_roots_without_state_writes(self):
        for deep in (False, True):
            with self.subTest(deep=deep), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(deep))):
                cache = {str(self.root/'child'): dict(bytes=1024, at=999999, partial=False)}
                jobs.save_state('disk-inventory', dict(duMode='links', childState={str(self.root): cache}))
                before = jobs.read_state('disk-inventory')
                with jobs.inventory_lock():
                    if deep:
                        deep_inventory.run_pass([self.root], lambda *a, **k: self.fail('locked'))
                    else:
                        jobs.directory_inventory([self.root], lambda *a, **k: self.fail('locked'))
                self.assertEqual(jobs.read_state('disk-inventory'), before)
                rows = [r for p in (self.logs/str(deep)).glob('*.ndjson')
                        for r in map(json.loads, p.read_text().splitlines()) if r['name'] == 'disk.inventory.root']
                self.assertEqual(len(rows), 1)
                props = rows[0]['props']
                self.assertEqual(props['skipReason'], 'lock_held' if deep else 'deep_pass_running')
                self.assertEqual(props['childrenMeasured'], 0)
                self.assertEqual(props['childrenCached'], 1)
                self.assertEqual(props['bytes'], 1024)
                self.assertTrue(props['partial'])

    def test_rollup_intended_counts_and_unchanged_error_fields(self):
        entries, run = self.fixture(errors=True)
        with patch.object(jobs, 'inventory_listing', return_value=(entries, True)):
            jobs.directory_inventory([self.root], run)
        day = dt.datetime.now(dt.timezone.utc).date().isoformat()
        result = rollup(day, self.logs)
        self.assertEqual(result['total'], 7)
        self.assertEqual(result['countsByName'], {'disk.inventory.root': 1, 'disk.inventory.source': 5, 'disk.inventory': 1})
        self.assertEqual(result['countsByKind'], {'event': 4, 'error': 3})
        self.assertEqual(result['outcomes'], 6)
        self.assertEqual(result['okRate'], .5)
        self.assertEqual({e['tag']: e['count'] for e in result['topErrors']},
                         {'disk.source_unavailable': 2, 'disk.inventory_failed': 1})
        self.assertEqual(result['malformed'], 0)

    def test_logging_failure_does_not_interrupt_measurement(self):
        child = self.root/'child'
        child.mkdir()
        def run(cmd, **kw):
            return SimpleNamespace(returncode=0, stdout='1048576\t'+cmd[-1]+'\n', stderr='')
        with patch.object(jobs, 'emit', side_effect=OSError('fixture log write failed')):
            total, _, children = jobs.big_root_inventory(self.root, run, 10)
            jobs.InventoryLog(self.root).root_event({}, 0, dict(partial=False, unmeasuredCount=0))
        self.assertEqual(total, 1024**3)
        self.assertIn(str(child), children)
