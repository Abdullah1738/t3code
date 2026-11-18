import copy
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_deep_inventory as support

jobs, deep = support.jobs, support.deep


class ProbeTests(unittest.TestCase):
    setUp = support.DeepInventoryTests.setUp
    roots = support.DeepInventoryTests.roots
    runner = support.DeepInventoryTests.runner
    rows = support.DeepInventoryTests.rows

    def test_probe_cost_matrix_and_command_caps(self):
        cases = [({}, [], 60), ({'elapsedMs': 12000}, [50000], 18),
                 ({}, [9000, 16000, 13000], 60), ({'elapsedMs': 1000}, [], 15),
                 ({'elapsedMs': 900000}, [], 120), ({}, [900000], 60),
                 ({'lastProbeS': 15}, [], 60), ({'lastProbeS': 100}, [], 120)]
        cases += [({'lastProbeS': v}, [], expected) for v, expected in
                  ((0, 60), (30, 60), (40, 80), (60, 120), (600, 120))]
        cases += [({'elapsedMs': v}, [], expected) for v, expected in
                  ((0, 15), (10000, 15), (40000, 60), (80000, 120), (float('nan'), 60), (True, 60))]
        cases += [({'elapsedMs': 1000, 'lastProbeS': v}, [], expected) for v, expected in
                  ((15, 30), (30, 60), (60, 120))]
        root = self.roots([('caps', 1)])[0]
        child = str(root/'0000')
        for value, samples, expected in cases:
            with self.subTest(value=value, samples=samples):
                self.assertEqual(jobs.inventory_probe_allowance(value, samples), expected)
        for cap, remaining, expected in [(600, 1000, 120), (75, 1000, 75), (600, 7, 7)]:
            with self.subTest(cap=cap, remaining=remaining), patch.object(jobs, 'DEEP_CHILD_CAP_S', cap):
                self.clock[0] = 0
                calls = []
                cache = {child: dict(elapsedMs=900000, partial=True)}
                jobs.big_root_inventory(root, self.runner(lambda p: 1000, calls), remaining,
                                        cache, deep=True, max_batches=1)
                self.assertEqual(calls[0][1], expected)
                self.assertFalse(cache[child].get('parts'))
                self.assertNotIn('bytes', cache[child])

    def test_batch_admission_uses_batch_deadline_instead_of_child_allowance(self):
        root = self.roots([('batch-deadline', 128)])[0]
        cache = {str(p): dict(partial=True, elapsedMs=3400) for p in root.iterdir()}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 3.4, calls), 1000,
                                cache, deep=True, max_batches=1)
        self.assertEqual(calls[0][1], 60)
        self.assertEqual(len(calls[0][0])-2, 8)
        events = [r for r in self.rows('disk.inventory.source') if 'cpuS' in r['props']]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['props']['completedCount'], 8)
        self.assertAlmostEqual(events[0]['props']['elapsedMs'], 27200)

    def test_finished_batch_with_missing_rows_logs_attempt_cost_once(self):
        root = self.roots([('missing-rows', 128)])[0]
        for code, stderr, printed in ((0, '', 0), (0, '', 127),
                                      (0, 'du: child: Permission denied', 127),
                                      (1, 'du: child: Permission denied', 127)):
            with self.subTest(code=code, stderr=stderr, printed=printed):
                cache = {str(p): dict(partial=True, elapsedMs=1) for p in root.iterdir()}
                metrics = dict(timeouts=0, secondsInTimeouts=0)
                before = len(self.rows('disk.inventory.source'))
                counter = [0]
                def usage(who):
                    counter[0] += .25
                    return SimpleNamespace(ru_utime=counter[0], ru_stime=counter[0])
                def run(command, **kwargs):
                    self.assertEqual(len(command)-2, 128)
                    self.clock[0] += 2
                    return SimpleNamespace(returncode=code, stderr=stderr,
                        stdout=''.join('1\t'+key+'\n' for key in command[2:2+printed]))
                with patch.object(jobs.resource, 'getrusage', side_effect=usage):
                    _, status, _ = jobs.big_root_inventory(root, run, self.clock[0]+1000,
                        cache, deep=True, max_batches=1, metrics=metrics)
                events = [r for r in self.rows('disk.inventory.source')[before:] if 'cpuS' in r['props']]
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['props']['failure'], 'missing-total')
                self.assertEqual(events[0]['props']['allowanceS'], 60)
                self.assertEqual(events[0]['props']['elapsedMs'], 2000)
                self.assertEqual(events[0]['props']['cpuS'], .5)
                self.assertEqual(metrics['cpuSecondsDu'], .5)
                self.assertEqual(metrics['wallSecondsDu'], 2)
                self.assertEqual(status['completedCount'], printed)
                self.assertTrue(status['partial'])

    def test_known_cost_short_attempt_gets_only_one_retry_per_pass(self):
        root = self.roots([('one-retry', 1)])[0]
        child = str(root/'0000')
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(root): {
            child: dict(partial=True, elapsedMs=1000)}}))
        calls = []
        deep.run_pass([root], self.runner(lambda p: 50, calls))
        self.assertEqual([timeout for cmd, timeout in calls], [15, 30])
        end = self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['probeTimeouts'], 2)
        self.assertEqual(end['secondsWasted'], 45)
        self.assertEqual(end['firstAttempts'], 0)
        self.assertEqual(end['childrenDescended'], 0)

    def test_first_timeout_descends_and_logs_child_cpu_not_parent_cpu(self):
        root = self.roots([('first-timeout', 1)])[0]
        child = root/'0000'
        (child/'part').touch()
        counter = [0]
        def usage(who):
            counter[0] += .25
            return SimpleNamespace(ru_utime=counter[0], ru_stime=counter[0])
        with patch.object(jobs.resource, 'getrusage', side_effect=usage), \
             patch.object(deep.os, 'getloadavg', side_effect=lambda: (2+self.clock[0]/10, 0, 0)):
            deep.run_pass([root], self.runner(lambda p: 70 if p == child else 5))
        end = self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['firstAttempts'], 1)
        self.assertEqual(end['firstAttemptTimeouts'], 1)
        self.assertEqual(end['childrenDescended'], 1)
        self.assertEqual(end['secondsWasted'], 60)
        self.assertEqual(end['wallSecondsDu'], 65)
        self.assertEqual(end['cpuSecondsDu'], 1)
        self.assertEqual(end['loadAvg1Start'], 2)
        self.assertEqual(end['loadAvg1End'], 8.5)
        self.assertEqual(end['loadAvg1Max'], 8.5)
        events = [row for row in self.rows('disk.inventory.source') if 'cpuS' in row['props']]
        self.assertEqual(len(events), 2)
        for row, allowance, elapsed in zip(events, (60, 600), (60000, 5000)):
            props = row['props']
            self.assertEqual(props['allowanceS'], allowance)
            self.assertEqual(props['elapsedMs'], elapsed)
            self.assertEqual(props['cpuS'], .5)
            self.assertLessEqual(props['cpuS'], props['elapsedMs']/1000+.01)
        self.assertFalse(jobs.read_state('disk-inventory')['partials'])

    def test_child_cpu_measurement_with_a_real_reaped_process(self):
        measurement = {}
        with patch.object(jobs.time, 'monotonic', side_effect=time.perf_counter):
            result = jobs.inventory_du(subprocess.run,
                [os.sys.executable, '-I', '-c', 'sum(i*i for i in range(100000))'],
                measurement, timeout=10, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertGreater(measurement['cpuS'], 0)
        self.assertLessEqual(measurement['cpuS'], measurement['elapsedMs']/1000+.01)

    def test_short_probe_escalates_without_timeout_lane_or_descent(self):
        root = self.roots([('escalate', 1)])[0]
        child = str(root/'0000')
        cache, calls = {child: dict(partial=True, elapsedMs=1000)}, []
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 1000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][1], 15)
        self.assertEqual(cache[child]['probeTimeouts'], 1)
        self.assertFalse(jobs.inventory_has_timeout(cache[child]))
        self.assertNotIn('parts', cache[child])
        calls.clear()
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 1000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][0][-1], child)
        self.assertGreaterEqual(calls[0][1], 30)
        self.assertFalse(cache[child]['partial'])
        self.assertEqual(cache[child]['elapsedMs'], 20000)
        self.assertNotIn('lastProbeS', cache[child])
        self.clock[0] += 86400
        calls.clear()
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), self.clock[0]+1000,
                                cache, deep=True)
        self.assertEqual([timeout for command, timeout in calls], [30])
        self.assertFalse(cache[child]['partial'])
        self.assertEqual(cache[child]['elapsedMs'], 20000)

    def test_unknown_cost_ignores_root_median(self):
        root = self.roots([('median', 3)])[0]
        cache = {str(root/'0000'): dict(bytes=1024, at=self.now, partial=False, elapsedMs=10000)}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 12, calls), 1000, cache, deep=True)
        self.assertEqual([timeout for cmd, timeout in calls], [60, 60])

    def test_legacy_conversion_is_once_and_real_timeout_still_descends(self):
        root = self.roots([('legacy', 1)])[0]
        child = root/'0000'
        (child/'part').mkdir()
        key = str(child)
        cache = {key: dict(timeouts=1, lastTimeoutAt=self.now, partial=True)}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 1000, calls), 2000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][1], 60)
        self.assertEqual(cache[key]['probeTimeouts'], 1)
        self.assertEqual(cache[key]['lastTimeoutS'], 60)
        self.assertEqual(cache[key]['timeouts'], 1)
        jobs.inventory_migrate_probe(cache[key])
        self.assertEqual(cache[key]['timeouts'], 1)
        jobs.big_root_inventory(root, self.runner(lambda p: 1), 2000, cache, deep=True)
        self.assertIn('parts', cache[key])
        self.assertFalse(cache[key]['partial'])

    def test_hourly_policy_and_successful_timing_survive_partial_refresh(self):
        root = self.roots([('hourly', 1)])[0]
        key = str(root/'0000')
        cache = {key: dict(bytes=1024, at=self.now-90000, partial=False, elapsedMs=42000)}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 200, cache)
        self.assertEqual(calls[0][1], 15)
        self.assertTrue(cache[key]['slow'])
        self.assertEqual(cache[key]['elapsedMs'], 42000)
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 200, cache)
        self.assertEqual(calls[-1][1], 60)
        self.assertEqual(cache[key]['elapsedMs'], 20000)

    def test_refresh_result_class_preserves_successful_cost_or_denied_estimate(self):
        root = self.roots([('refresh-results', 1)])[0]
        key = str(root/'0000')
        cases = [('denied-total', 1, True, 'Permission denied', 2000, False, True, 1024),
                 ('denied-empty', 1, False, 'Permission denied', None, False, True, 0),
                 ('io-total', 1, True, 'Input/output error', 20000, True, False, 1024),
                 ('io-empty', 1, False, 'Input/output error', 20000, True, False, 1024),
                 ('other-exit', 2, True, '', 20000, True, False, 1024)]
        for label, code, total, error, cost, partial, estimate, size in cases:
            with self.subTest(label=label):
                cache = {key: dict(bytes=1024, at=self.now+self.clock[0]-90000,
                                   partial=False, elapsedMs=20000)}
                def run(cmd, **kwargs):
                    self.clock[0] += 2
                    return SimpleNamespace(returncode=code, stdout='1\t'+key+'\n' if total else '',
                                           stderr='du: '+key+': '+error if error else '')
                _, status, _ = jobs.big_root_inventory(root, run, self.clock[0]+200, cache)
                self.assertEqual(cache[key].get('elapsedMs'), cost)
                self.assertEqual(cache[key]['lastAttemptMs'], 2000)
                self.assertEqual(cache[key]['partial'], partial)
                self.assertEqual(bool(cache[key].get('estimate')), estimate)
                self.assertEqual(status['completeWithDenied'], estimate)
                self.assertEqual(cache[key]['bytes'], size)

    def test_probe_logs_and_total_timeout_metrics_survive_allowlist(self):
        root = self.roots([('metrics', 1)])[0]
        deep.run_pass([root], self.runner(lambda p: 20))
        end = self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['probeTimeouts'], 0)
        self.assertEqual(end['secondsInProbeTimeouts'], 0)
        self.assertEqual(end['timeouts'], 0)
        self.assertEqual(end['secondsInTimeouts'], 0)
        self.assertEqual(end['probeAllowanceMedianS'], 60)
        self.assertEqual(end['childrenDescended'], 0)
        self.assertEqual(end['childrenRemaining'], 0)
        self.assertEqual(end['firstAttempts'], 1)
        self.assertEqual(end['firstAttemptTimeouts'], 0)
        self.assertEqual(end['secondsWasted'], 0)
        self.assertEqual(end['wallSecondsDu'], 20)
        source = self.rows('disk.inventory.source')[-1]['props']
        self.assertEqual(source['allowanceS'], 60)
        self.assertEqual(source['elapsedMs'], 20000)
        self.assertLessEqual(source['cpuS'], 20.01)
        for field in ('loadAvg1Start', 'loadAvg1End', 'loadAvg1Max', 'cpuSecondsDu'):
            self.assertIsInstance(end[field], (int, float))
        self.assertGreaterEqual(end['loadAvg1Max'], end['loadAvg1End'])

    def test_locked_hourly_summary_recomputes_freshness_boundaries(self):
        # Every cache shape goes through the public collector with a real flock.
        for shape, root, window in (
                ('ordinary', Path('/Volumes/ExternalSSD/wt'), 172800),
                ('ordinary', self.root/'hourly', 86400),
                ('parts', Path('/Volumes/ExternalSSD/wt'), 259200),
                ('old-part', Path('/Volumes/ExternalSSD/wt'), 259200),
                ('old-parent', Path('/Volumes/ExternalSSD/wt'), 259200)):
            for delta in (-1, 0, 1):
                with self.subTest(shape=shape, root=root, delta=delta):
                    at = self.now-window-delta
                    value = dict(bytes=1024, at=at, partial=False)
                    if shape != 'ordinary':
                        value.update(isDirectory=True, partsDone=1, partsTotal=1,
                            parts={str(root/'child'/'part'): dict(bytes=1024,
                                at=self.now if shape == 'old-parent' else at, partial=False)})
                        if shape == 'old-part':
                            value['at'] = self.now
                    state = dict(duMode='links', sizes={str(root): 1024}, partials={},
                                 childState={str(root): {str(root/'child'): value}})
                    jobs.save_state('disk-inventory', state)
                    before = jobs.read_state('disk-inventory')
                    with jobs.inventory_lock(), \
                         patch.object(jobs, 'save_state', side_effect=AssertionError('locked write')), \
                         patch.object(jobs, 'inventory_listing', side_effect=AssertionError('locked listing')):
                        jobs.directory_inventory([root], lambda *a, **k: self.fail('locked du'))
                    self.assertEqual(jobs.read_state('disk-inventory'), before)
                    summary = self.rows('disk.inventory')[-1]['props']
                    event = self.rows('disk.inventory.root')[-1]['props']
                    self.assertEqual(summary['skipReason'], 'deep_pass_running')
                    self.assertEqual(summary['rootsComplete'], int(delta < 0))
                    self.assertEqual(summary['rootsPartial'], int(delta >= 0))
                    self.assertEqual(event['partial'], delta >= 0)
                    self.assertEqual(summary['bytes'], 0 if shape != 'ordinary' and delta >= 0 else 1024)

    def test_locked_hourly_summary_requires_a_known_complete_cache(self):
        root = Path('/Volumes/ExternalSSD/wt')
        key = str(root)
        good = {str(root/'child'): dict(bytes=1024, at=self.now, partial=False)}
        for label, size, cache, partials, mode, complete, total in (
                ('missing-cache', 1024, {}, {}, 'links', False, 0),
                ('empty-root', 0, {}, {}, 'links', True, 0),
                ('saved-partial', 1024, good, {key: dict(partial=True)}, 'links', False, 1024),
                ('legacy-mode', 1024, good, {}, None, False, 0)):
            with self.subTest(label=label):
                state = dict(duMode=mode, sizes={key: size}, partials=partials, childState={key: cache})
                with jobs.inventory_lock(), patch.object(jobs, 'read_state', return_value=copy.deepcopy(state)), \
                     patch.object(jobs, 'save_state', side_effect=AssertionError('locked write')):
                    jobs.directory_inventory([root], lambda *a, **k: self.fail('locked du'))
                summary = self.rows('disk.inventory')[-1]['props']
                event = self.rows('disk.inventory.root')[-1]['props']
                self.assertEqual(summary['rootsComplete'], int(complete))
                self.assertEqual(summary['rootsPartial'], int(not complete))
                self.assertEqual(summary['bytes'], total)
                self.assertEqual(event['partial'], not complete)

    def test_locked_hourly_summary_keeps_invalid_children_unmeasured(self):
        root = Path('/Volumes/ExternalSSD/wt')
        key, child = str(root), str(root/'child')
        forms = [dict(bytes=1024, at=self.now+1, partial=False),
                 dict(bytes=1024, partial=False),
                 dict(bytes=1024, at='invalid', partial=False),
                 dict(at=self.now, partial=False),
                 dict(bytes='invalid', at=self.now, partial=False),
                 dict(bytes=-1, at=self.now, partial=False),
                 dict(bytes=float('nan'), at=self.now, partial=False), None]
        for value in forms:
            with self.subTest(value=value):
                state = dict(duMode='links', sizes={key: 1024}, partials={},
                             childState={key: {child: value}})
                with jobs.inventory_lock(), patch.object(jobs, 'read_state', return_value=copy.deepcopy(state)), \
                     patch.object(jobs, 'save_state', side_effect=AssertionError('locked write')):
                    jobs.directory_inventory([root], lambda *a, **k: self.fail('locked du'))
                summary = self.rows('disk.inventory')[-1]['props']
                event = self.rows('disk.inventory.root')[-1]['props']
                self.assertEqual(summary['rootsComplete'], 0)
                self.assertEqual(summary['rootsPartial'], 1)
                self.assertEqual(summary['bytes'], 0)
                self.assertTrue(event['partial'])
                self.assertEqual(event['unmeasuredCount'], 1)

    def test_locked_hourly_summary_keeps_invalid_parts_unmeasured_recursively(self):
        root = Path('/Volumes/ExternalSSD/wt')
        key, child = str(root), str(root/'child')
        forms = [dict(bytes=1024, at=self.now+1, partial=False),
                 dict(bytes=1024, partial=False),
                 dict(bytes=1024, at='invalid', partial=False),
                 dict(at=self.now, partial=False),
                 dict(bytes='invalid', at=self.now, partial=False),
                 dict(bytes=-1, at=self.now, partial=False),
                 dict(bytes=float('nan'), at=self.now, partial=False), None]
        for depth in (1, 2):
            for bad in forms:
                with self.subTest(depth=depth, bad=bad):
                    value = bad
                    for level in range(depth):
                        value = dict(bytes=1024, at=self.now, partial=False, isDirectory=True,
                                     partsTotal=1, partsDone=1, parts={child+'/part%d'%level: value})
                    state = dict(duMode='links', sizes={key: 1024}, partials={},
                                 childState={key: {child: value}})
                    with jobs.inventory_lock(), patch.object(jobs, 'read_state', return_value=copy.deepcopy(state)), \
                         patch.object(jobs, 'save_state', side_effect=AssertionError('locked write')):
                        jobs.directory_inventory([root], lambda *a, **k: self.fail('locked du'))
                    summary = self.rows('disk.inventory')[-1]['props']
                    event = self.rows('disk.inventory.root')[-1]['props']
                    self.assertEqual(summary['rootsComplete'], 0)
                    self.assertEqual(summary['rootsPartial'], 1)
                    self.assertEqual(summary['bytes'], 0)
                    self.assertTrue(event['partial'])
                    self.assertEqual(event['unmeasuredCount'], 1)

    def test_locked_hourly_summary_checks_saved_part_membership(self):
        root = Path('/Volumes/ExternalSSD/wt')
        key, child = str(root), str(root/'child')
        good = dict(bytes=1024, at=self.now, partial=False)
        for total, members, complete in ((1, 0, False), (2, 1, False), (0, 1, False),
                                          ('invalid', 1, False), (1, 1, True), (0, 0, True),
                                          (None, 1, True)):
            with self.subTest(total=total, members=members):
                parent = dict(good, isDirectory=True, partsDone=members,
                              parts={child+'/part': dict(good)} if members else {})
                if total is not None:
                    parent['partsTotal'] = total
                state = dict(duMode='links', sizes={key: 1024}, partials={},
                             childState={key: {child: parent}})
                with jobs.inventory_lock(), patch.object(jobs, 'read_state', return_value=copy.deepcopy(state)), \
                     patch.object(jobs, 'save_state', side_effect=AssertionError('locked write')):
                    jobs.directory_inventory([root], lambda *a, **k: self.fail('locked du'))
                summary = self.rows('disk.inventory')[-1]['props']
                event = self.rows('disk.inventory.root')[-1]['props']
                self.assertEqual(summary['rootsComplete'], int(complete))
                self.assertEqual(summary['rootsPartial'], int(not complete))
                self.assertEqual(summary['bytes'], 1024 if complete else 0)
                self.assertEqual(event['partial'], not complete)

    def test_night_one_shape_four_daily_passes_with_hourly_freshness_checks(self):
        self.run_night_shape()

    def test_busy_night_four_passes_with_legacy_probes(self):
        self.run_night_shape(slowdown=2.5)

    def run_night_shape(self, slowdown=1):
        counts = [('wt', 66), ('t3code-wt', 281), ('board-wt', 932),
                  ('coord-wt', 129), ('crpko-devops/tmp', 3091)]
        roots = [Path('/Volumes/ExternalSSD')/name for name, count in counts]
        topology = {root: [root/('%04d'%i) for i in range(count)]
                    for root, (_, count) in zip(roots, counts)}
        # Giants are additional children; ordinary cost and population stay intact.
        giants = {roots[0]/'giant', roots[3]/'giant'}
        for child in giants:
            topology[child.parent].append(child)
            topology[child] = [child/('part%d'%i) for i in range(3)]
        def cost(path):
            if path in giants:
                return 1050*slowdown
            if path.parent in giants:
                return 350*slowdown
            if path.parent == roots[1]:
                return (9+7*int(path.name)/280)*slowdown
            return (3.4 if path.parent == roots[2] else .034 if path.parent == roots[4] else 1.5)*slowdown
        def listing(path, deadline):
            return [SimpleNamespace(path=str(p), is_dir=lambda **kw: True)
                    for p in topology[Path(path)]], True
        stored, evidence, completed_roots, hourly, coverage_failures = {}, [], set(), [], []
        active_refresh_gaps = []
        if slowdown != 1:
            stored['disk-inventory'] = dict(duMode='links', childState={str(roots[1]): {
                str(p): dict(partial=True, probeTimeouts=1, lastProbeS=15, lastTimeoutS=15)
                for p in topology[roots[1]][::2]}})
        ordinary_kills, unique_ordinary = {}, set()
        ordinary_count = sum(count for _, count in counts)
        full_sweep_night = None

        end = {}
        def log(component, kind, name, **kwargs):
            if name == 'disk.deep.end':
                end.update(kwargs['props'])
            if name == 'disk.deep.root' and not kwargs['props']['partial']:
                completed_roots.add(kwargs['props']['source'])
        def observe(at, state, during_pass=False):
            events = {}
            def hourly_log(component, kind, name, **kwargs):
                if name == 'disk.inventory.root':
                    events[kwargs['props']['source']] = kwargs['props']
                elif name == 'disk.inventory':
                    events['summary'] = kwargs['props']
            with patch.object(jobs.time, 'time', return_value=at), \
                 patch.object(jobs, 'read_state', side_effect=lambda n: copy.deepcopy(state)), \
                 patch.object(jobs, 'save_state', side_effect=AssertionError('locked hourly write')), \
                 patch.object(jobs, 'inventory_listing', side_effect=AssertionError('locked hourly listing')), \
                 patch.object(jobs, 'emit', side_effect=hourly_log), jobs.inventory_lock():
                jobs.directory_inventory(roots, lambda *a, **k: self.fail('locked hourly du'))
            self.assertEqual(events['summary']['skipReason'], 'deep_pass_running')
            self.assertEqual(set(events)-{'summary'}, set(map(str, roots)))
            partial_roots = [str(root) for root in roots if events[str(root)]['partial']]
            self.assertEqual(events['summary']['rootsComplete'], len(roots)-len(partial_roots))
            self.assertEqual(events['summary']['rootsPartial'], len(partial_roots))
            for root in roots:
                cache = copy.deepcopy(state['childState'][str(root)])
                if root not in {p.parent for p in giants}:
                    expected_partial = any(
                        value.get('partial') is not False or 'bytes' not in value
                        or not isinstance(value.get('at'), (int, float))
                        or value['at'] > at or at-value['at'] >= 48*3600
                        for value in (cache.get(str(p), {}) for p in topology[root]))
                    self.assertEqual(str(root) in partial_roots, expected_partial)
                if str(root) in partial_roots:
                    if root not in {p.parent for p in giants}:
                        expired = {key: value for key, value in cache.items()
                                   if jobs.inventory_needs_measurement(value, at, root=root)}
                        gaps = active_refresh_gaps if during_pass else coverage_failures
                        gaps.append(dict(root=str(root), at=at, expired=len(expired),
                            oldestAt=min((v.get('at', 0) for v in expired.values()), default=0),
                            firstExpiry=min((v.get('at', 0)+jobs.INVENTORY_DEEP_FRESH_S
                                             for v in expired.values()), default=0)))
                for child in giants:
                    if child.parent == root and jobs.inventory_needs_measurement(cache.get(str(child)), at, root=root):
                        self.assertIn(str(root), partial_roots)
            hourly.append(dict(at=at, partialRoots=partial_roots))
        with patch.object(jobs, 'inventory_listing', side_effect=listing), \
             patch.object(jobs.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR, st_blocks=0)), \
             patch.object(jobs, 'read_state', side_effect=lambda n: copy.deepcopy(stored.get(n, {}))), \
             patch.object(jobs, 'save_state', side_effect=lambda n, v: stored.update({n: copy.deepcopy(v)})), \
             patch.object(jobs, 'emit'), patch.object(deep, 'emit', side_effect=log):
            for night in range(12 if slowdown != 1 else 4):
                self.clock[0] = night*86400
                start, calls = self.clock[0], []
                gap_start = len(active_refresh_gaps)
                breakdown = {name: dict(count=0, seconds=0) for name in ('probe', 'realChild', 'batch', 'parts')}
                batch_deadlines = []
                ordinary_waste = [0]
                run_du = self.runner(cost, calls)
                def run(command, **kwargs):
                    command_started = self.clock[0]
                    try:
                        return run_du(command, **kwargs)
                    except subprocess.TimeoutExpired as exc:
                        if not any(Path(p) in giants or Path(p).parent in giants for p in command[2:]):
                            ordinary_waste[0] += self.clock[0]-command_started
                            # A pass-budget cutoff rotates without declaring slowness.
                            if kwargs['timeout']+1e-6 >= 60:
                                output = exc.stdout or b''
                                if isinstance(output, bytes):
                                    output = output.decode()
                                done = {row.split('\t', 1)[1] for row in output.splitlines()}
                                child = next(p for p in command[2:] if p not in done)
                                ordinary_kills[child] = ordinary_kills.get(child, 0)+1
                                if slowdown != 1:
                                    self.assertEqual(len(command), 3, 'batch killed an ordinary child')
                                    self.assertGreater(cost(Path(child)), 60)
                                    self.assertEqual(kwargs['timeout'], 60)
                        name = ('parts' if Path(command[-1]).parent in giants else 'batch' if len(command) > 3
                                else 'probe' if kwargs['timeout'] < 60 else 'realChild')
                        if name == 'batch':
                            batch_deadlines.append(dict(root=str(Path(command[2]).parent),
                                first=Path(command[2]).name, last=Path(command[-1]).name, children=len(command)-2,
                                expectedSeconds=round(sum(cost(Path(p)) for p in command[2:]), 3),
                                allowanceS=kwargs['timeout']))
                        breakdown[name]['count'] += 1
                        breakdown[name]['seconds'] += self.clock[0]-command_started
                        raise
                    finally:
                        # An hourly collector during du sees the last persisted
                        # checkpoint, not the still-running command's future rows.
                        hour = self.now+night*86400+3600
                        if (night >= 2 or slowdown != 1) and start <= self.clock[0]-3600 and not any(r['at'] == hour for r in hourly):
                            observe(hour, stored['disk-inventory'], during_pass=True)
                deep.run_pass(roots, run, budget=5400)
                state = stored['disk-inventory']
                if slowdown == 1:
                    for gap in active_refresh_gaps[gap_start:]:
                        self.assertNotIn(gap['root'], state['partials'],
                                         'an active refresh gap must close by this pass end')
                        self.assertTrue(all(not jobs.inventory_needs_measurement(
                            value, self.now+self.clock[0], root=gap['root'])
                            for value in state['childState'][gap['root']].values()))
                self.assertLessEqual(self.clock[0]-start, 5400.001)
                self.assertTrue(all(timeout <= 600 for cmd, timeout in calls))
                # Cache-complete means actual, fresh measurements, never a killed prefix.
                for cache in state['childState'].values():
                    for value in cache.values():
                        if value.get('partial') is False:
                            self.assertIn('bytes', value)
                        if value.get('parts') and value.get('partial') is False:
                            self.assertEqual(value['partsDone'], 3)
                unique_ordinary.update(key for cache in state['childState'].values() for key, value in cache.items()
                    if Path(key) not in giants and value.get('partial') is False and 'bytes' in value)
                if len(unique_ordinary) == ordinary_count and full_sweep_night is None:
                    full_sweep_night = night+1
                evidence.append(dict(night=night+1, seconds=round(self.clock[0]-start, 3),
                    cumulativeUniqueOrdinary=len(unique_ordinary),
                    measured=end['childrenMeasured'], secondsWasted=round(end['secondsWasted'], 3),
                    nonGiantSecondsWasted=round(ordinary_waste[0], 3),
                    ordinaryRootsComplete=sum(str(root) not in state['partials']
                        for root in roots if root not in {p.parent for p in giants}),
                    remaining=end['childrenRemaining'], timeouts=end['timeouts'],
                    secondsInTimeouts=round(end['secondsInTimeouts'], 3),
                    batchDeadlines=batch_deadlines, timeoutBreakdown=breakdown, probeTimeouts=end['probeTimeouts'], rootsComplete=len(roots)-len(state['partials']),
                    giantsComplete=all(not state['childState'][str(p.parent)].get(str(p), {}).get('partial', True) for p in giants),
                    ordinaryRemaining=sum(jobs.inventory_needs_measurement(state['childState'][str(root)].get(str(p)),
                        self.now+self.clock[0], root=root) for root in roots for p in topology[root] if p not in giants),
                    giantParts={str(child): {key: value.get('at') for key, value in
                        state['childState'][str(child.parent)].get(str(child), {}).get('parts', {}).items()}
                        for child in sorted(giants)}))
                self.assertAlmostEqual(sum(v['seconds'] for v in breakdown.values()), end['secondsWasted'])
                if night >= 1:
                    for root in roots:
                        if root not in {p.parent for p in giants} and str(root) in state['partials']:
                            coverage_failures.append(dict(night=night+1, root=str(root), at=self.now+self.clock[0]))
                if night >= 2 or slowdown != 1:
                    for hour in range(1, 25):
                        at = self.now+night*86400+hour*3600
                        if at < self.now+self.clock[0]:
                            continue
                        observe(at, state)
                if night >= 3 and full_sweep_night is not None:
                    break
        print('BUSY_NIGHTS' if slowdown != 1 else 'NIGHT_ONE_PROBES', json.dumps(evidence[:4], sort_keys=True))
        print('NIGHT_ONE_COVERAGE', json.dumps(dict(rootsCompleted=sorted(completed_roots),
              finalPartialRoots=sorted(state['partials']), hourly=hourly, ordinaryFailures=coverage_failures,
              activeRefreshGaps=active_refresh_gaps)))
        ordinary_s = sum(cost(p) for root in roots for p in topology[root] if p not in giants)
        if slowdown != 1:
            print('BUSY_CAPACITY', json.dumps(dict(ordinarySeconds=ordinary_s, twoNightBudget=10800,
                t3codeSeconds=sum(cost(p) for p in topology[roots[1]]),
                hourlySamples=len(hourly), coverageFailures=len(coverage_failures),
                fullOrdinarySweepNight=full_sweep_night, ordinaryChildren=ordinary_count,
                minimumNights=math.ceil(ordinary_s/5400),
                sweepCoverage=[row['cumulativeUniqueOrdinary'] for row in evidence])))
            self.assertGreater(ordinary_s, 2*5400)
            self.assertIsNotNone(full_sweep_night, 'report if a complete unique sweep never finishes')
            self.assertTrue(all(row['nonGiantSecondsWasted'] < .1*5400 for row in evidence[1:]))
            self.assertTrue(all(count <= 1 for count in ordinary_kills.values()))
            return
        print('NORMAL_CAPACITY', json.dumps(dict(ordinarySeconds=ordinary_s, fullOrdinarySweepNight=full_sweep_night, minimumNights=math.ceil(ordinary_s/5400))))
        self.assertFalse(coverage_failures, '48 h ordinary steady state must hold; do not widen the window')
        self.assertTrue(evidence[2]['giantsComplete'])
        self.assertEqual(evidence[2]['rootsComplete'], len(roots))
        self.assertTrue(all(row['secondsInTimeouts'] < .15*5400 for row in evidence[1:]))
        self.assertEqual(completed_roots, set(map(str, roots)))
        for child in giants:
            self.assertFalse(state['childState'][str(child.parent)][str(child)]['partial'])
        self.assertGreater(ordinary_s, 5400)

    def test_budget_and_stop_truncation_preserve_probe_escalation(self):
        for cutoff in (0, 1, 7, 14.999, 30, 59.999):
            for stopped in (False, True):
                with self.subTest(cutoff=cutoff, stopped=stopped):
                    root = self.roots([('truncated-%s-%s'%(cutoff, stopped), 1)])[0]
                    key = str(root/'0000')
                    cache = {key: dict(partial=True, probeTimeouts=2, lastProbeS=30, lastTimeoutS=30)}
                    self.clock[0] = 0
                    def interrupted(command, **kwargs):
                        self.clock[0] += cutoff
                        raise subprocess.TimeoutExpired(command, cutoff)
                    jobs.big_root_inventory(root, interrupted, 1000 if stopped else cutoff,
                                            cache, deep=True, max_batches=1)
                    self.assertGreaterEqual(jobs.inventory_probe_allowance(cache[key], []), 60)
                    self.assertFalse(jobs.inventory_has_timeout(cache[key]))
                    self.assertNotIn('bytes', cache[key])

    def test_interrupted_batch_keeps_bytes_without_learning_timeout_as_success_cost(self):
        root = self.roots([('batch-timing', 128)])[0]
        first, second = str(root/'0000'), str(root/'0001')
        for prior in (None, 1000):
            with self.subTest(prior=prior):
                self.clock[0] = 0
                cache = {str(p): dict(bytes=2048, at=self.now-90000, partial=False,
                                     **({'elapsedMs': prior} if prior is not None else {}))
                         for p in root.iterdir()}
                if prior is None:
                    cache[str(root/'0127')]['elapsedMs'] = 1
                def interrupted(command, **kwargs):
                    self.clock[0] += kwargs['timeout']
                    raise subprocess.TimeoutExpired(command, kwargs['timeout'], output='1\t'+first+'\n')
                jobs.big_root_inventory(root, interrupted, 1000, cache, deep=True, max_batches=1)
                self.assertEqual(cache[first]['bytes'], 1024)
                self.assertFalse(cache[first]['partial'])
                self.assertEqual(cache[first].get('elapsedMs'), prior)
                self.assertEqual(cache[second]['bytes'], 2048)
                self.assertTrue(cache[second]['partial'])
                self.assertEqual(jobs.inventory_probe_allowance({}, [v['elapsedMs'] for v in cache.values()
                    if jobs.number(v.get('elapsedMs'))]), 60)

    def test_timeout_with_every_batch_row_keeps_totals_and_counts_timeout(self):
        root = self.roots([('all-rows', 128)])[0]
        cache = {str(p): dict(partial=True, elapsedMs=1) for p in root.iterdir()}
        metrics = dict(timeouts=0, secondsInTimeouts=0)
        def interrupted(command, **kwargs):
            self.clock[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(command, kwargs['timeout'],
                output=''.join('1\t'+key+'\n' for key in command[2:]))
        total, status, children = jobs.big_root_inventory(root, interrupted, 1000, cache,
            deep=True, max_batches=1, metrics=metrics)
        self.assertEqual(total, 128*1024)
        self.assertFalse(status['partial'])
        self.assertEqual(len(children), 128)
        self.assertEqual(metrics['timeouts'], 1)
        self.assertEqual(metrics['secondsInTimeouts'], 60)
        self.assertTrue(all(v['elapsedMs'] == 1 for v in cache.values()))
        event = [r for r in self.rows('disk.inventory.source') if r['props'].get('failure') == 'timeout'][-1]
        self.assertEqual(event['props']['allowanceS'], 60)

    def test_freshness_scope_and_boundaries_keep_real_age(self):
        for root in [*map(Path, sorted(jobs.DEEP_ROOTS)), Path('/fixture/small'),
                     Path('/Volumes/ExternalSSD/t3code-wt/sibling'), Path('/Volumes/ExternalSSD/caches')]:
            window = 48*3600 if str(root) in jobs.DEEP_ROOTS else 24*3600
            for age in (window-1, window, window+1):
                with self.subTest(root=str(root), age=age):
                    key = str(root/'child')
                    value = dict(bytes=1024, at=self.now-age, partial=False)
                    cache = {key: value}
                    entries = [SimpleNamespace(path=key)]
                    self.assertEqual(jobs.inventory_needs_measurement(value, self.now, root=root), age >= window)
                    total, status, children = jobs.inventory_status(cache, entries, True, self.now, root=root)
                    self.assertEqual(status['partial'], age >= window)
                    self.assertEqual(status['ageS'], age)
                    self.assertEqual(value['at'], self.now-age)
                    self.assertEqual(bool(jobs.inventory_refresh_entries(entries, cache, self.now, root=root)), age >= window)
            parts_value = dict(bytes=1024, at=self.now-48*3600, partial=False, parts={})
            self.assertFalse(jobs.inventory_needs_measurement(parts_value, self.now, root=root))
            self.assertTrue(jobs.inventory_needs_measurement(parts_value, self.now+24*3600, root=root))

    def test_legacy_probe_with_hourly_hints_stays_in_ordinary_discovery(self):
        for hints, descends in (({}, False), ({'slow': True}, False),
                                ({'slow': True, 'limited': True}, True)):
            with self.subTest(hints=hints):
                root = self.roots([('mixed-%s'%len(hints), 1)])[0]
                child = root/'0000'
                (child/'part').mkdir()
                cache = {str(child): dict(timeouts=1, partial=True, **hints)}
                calls = []
                jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 1000,
                                        cache, deep=True, max_batches=1)
                self.assertEqual(calls[0][0][-1], str(child/'part') if descends else str(child))
                self.assertEqual(calls[0][1], 600 if descends else 60)
                self.assertEqual('parts' in cache[str(child)], descends)

    def test_one_early_part_attempt_per_root_before_ordinary_peer(self):
        roots = self.roots([('a-parts', 2), ('b-parts', 2), ('c-ordinary', 1)])
        child_state = {}
        for root in roots[:2]:
            child_state[str(root)] = {}
            for child in root.iterdir():
                (child/'part').touch()
                child_state[str(root)][str(child)] = dict(timeouts=1, lastTimeoutS=60, partial=True)
        jobs.save_state('disk-inventory', dict(duMode='links', childState=child_state))
        calls = []
        deep.run_pass(roots, self.runner(lambda p: 2 if p.name == 'part' else 1, calls))
        keys = [cmd[-1] for cmd, timeout in calls]
        ordinary_index = keys.index(str(roots[2]/'0000'))
        early = keys[:ordinary_index]
        self.assertEqual(early, [str(root/'0000'/'part') for root in roots[:2]])
        self.assertFalse(jobs.read_state('disk-inventory')['partials'])

    def test_parts_defer_known_cost_without_timeout_or_fake_completion(self):
        root = self.roots([('part-costs', 3)])[0]
        keys = [str(root/('%04d'%i)) for i in range(3)]
        for source in ('own', 'sibling', 'unknown', 'deleted-sibling'):
            with self.subTest(source=source):
                self.clock[0] = 0
                cache = {keys[0]: dict(bytes=1024, at=self.now, partial=False, elapsedMs=350000)}
                if source == 'own':
                    cache[keys[1]] = dict(partial=True, elapsedMs=350000)
                if source in ('unknown', 'deleted-sibling'):
                    cache = {} if source == 'unknown' else {
                        str(root/'deleted'): dict(bytes=1024, at=self.now, partial=False, elapsedMs=900000)}
                attempted, calls = set(), []
                metrics = dict(timeouts=0, secondsInTimeouts=0)
                # A cheaper part can still fit after a deferred expensive one.
                cache[keys[2]] = dict(partial=True, elapsedMs=100000)
                if source == 'sibling':
                    cache[keys[2]]['elapsedMs'] = 350000
                _, status, _ = jobs.big_root_inventory(root, self.runner(lambda p: 100, calls),
                    250, cache, deep=True, parts_mode=True, attempted=attempted, metrics=metrics)
                self.assertTrue(status['partial'])
                self.assertEqual(metrics['timeouts'], 0)
                self.assertEqual(metrics['secondsInTimeouts'], 0)
                if source in ('own', 'sibling'):
                    self.assertFalse(any(keys[1] in cmd[2:] for cmd, timeout in calls))
                    self.assertNotIn('bytes', cache.get(keys[1], {}))
                    self.assertIn(keys[1], attempted)
                else:
                    self.assertTrue(any(keys[0] in cmd[2:] for cmd, timeout in calls))
                if source == 'own':
                    self.assertTrue(any(keys[2] in cmd[2:] for cmd, timeout in calls))

    def test_parts_cost_admission_boundary(self):
        root = self.roots([('part-boundary', 1)])[0]
        key = str(root/'0000')
        for left in (249.999, 250, 350, 350.001):
            with self.subTest(left=left):
                self.clock[0] = 0
                cache = {key: dict(partial=True, elapsedMs=350000)}
                calls = []
                _, status, _ = jobs.big_root_inventory(root, self.runner(lambda p: 350, calls),
                    left, cache, deep=True, parts_mode=True, attempted=set())
                self.assertEqual(bool(calls), left >= 350)
                self.assertEqual(status['partial'], left < 350)
                self.assertEqual('bytes' in cache[key], left >= 350)

    def test_known_part_cost_bounds_batches_as_well_as_single_attempts(self):
        root = self.roots([('part-batch-cost', 128)])[0]
        cache = {str(p): dict(partial=True, elapsedMs=350000) for p in root.iterdir()}
        attempted, calls = set(), []
        metrics = dict(timeouts=0, secondsInTimeouts=0)
        run = self.runner(lambda p: 350, calls)
        jobs.big_root_inventory(root, run, 600, cache, deep=True, parts_mode=True,
                                attempted=attempted, metrics=metrics, max_batches=1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0][0]), 3)
        self.assertEqual(self.clock[0], 350)
        jobs.big_root_inventory(root, run, 600, cache, deep=True, parts_mode=True,
                                attempted=attempted, metrics=metrics)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(attempted), 128)
        self.assertEqual(sum('bytes' in v for v in cache.values()), 1)
        self.assertEqual(metrics['timeouts'], 0)

    def test_unknown_part_cost_can_still_timeout_without_fabricated_progress(self):
        root = self.roots([('unknown-part-cost', 1)])[0]
        cache, calls = {}, []
        metrics = dict(timeouts=0, secondsInTimeouts=0)
        _, status, _ = jobs.big_root_inventory(root, self.runner(lambda p: 350, calls), 250,
            cache, deep=True, parts_mode=True, attempted=set(), metrics=metrics)
        self.assertEqual(calls[0][1], 250)
        self.assertEqual(metrics['timeouts'], 1)
        self.assertEqual(metrics['secondsInTimeouts'], 250)
        self.assertTrue(status['partial'])
        self.assertNotIn('bytes', cache[str(root/'0000')])
