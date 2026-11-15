import copy
import json
from pathlib import Path
import stat
import subprocess
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
        cases = [({}, [], 15), ({'elapsedMs': 12000}, [50000], 18),
                 ({}, [9000, 16000, 13000], 26), ({'elapsedMs': 1000}, [], 15),
                 ({'elapsedMs': 900000}, [], 120), ({}, [900000], 120),
                 ({'lastProbeS': 15}, [], 30), ({'lastProbeS': 100}, [], 120)]
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

    def test_short_probe_escalates_without_timeout_lane_or_descent(self):
        root = self.roots([('escalate', 2)])[0]
        child = str(root/'0000')
        cache, calls = {}, []
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 1000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][1], 15)
        self.assertEqual(cache[child]['probeTimeouts'], 1)
        self.assertFalse(jobs.inventory_has_timeout(cache[child]))
        self.assertNotIn('parts', cache[child])
        cache[str(root/'0001')] = dict(bytes=1024, at=self.now-90000, partial=False)
        calls.clear()
        jobs.big_root_inventory(root, self.runner(lambda p: 20, calls), 1000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][0][-1], child)
        self.assertGreaterEqual(calls[0][1], 30)
        self.assertFalse(cache[child]['partial'])
        self.assertEqual(cache[child]['elapsedMs'], 20000)
        self.assertNotIn('lastProbeS', cache[child])

    def test_root_median_uses_cache_and_successes_in_current_turn(self):
        root = self.roots([('median', 3)])[0]
        cache = {str(root/'0000'): dict(bytes=1024, at=self.now, partial=False, elapsedMs=10000)}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 12, calls), 1000, cache, deep=True)
        self.assertEqual([timeout for cmd, timeout in calls], [20, 22])

    def test_legacy_conversion_is_once_and_real_timeout_still_descends(self):
        root = self.roots([('legacy', 1)])[0]
        child = root/'0000'
        (child/'part').mkdir()
        key = str(child)
        cache = {key: dict(timeouts=1, lastTimeoutAt=self.now, partial=True)}
        calls = []
        jobs.big_root_inventory(root, self.runner(lambda p: 1000, calls), 2000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[0][1], 30)
        self.assertEqual(cache[key]['probeTimeouts'], 2)
        self.assertNotIn('timeouts', cache[key])
        self.assertNotIn('parts', cache[key])
        jobs.inventory_migrate_probe(cache[key])
        self.assertEqual(cache[key]['probeTimeouts'], 2)
        jobs.big_root_inventory(root, self.runner(lambda p: 1000, calls), 2000, cache,
                                deep=True, max_batches=1)
        self.assertEqual(calls[-1][1], 60)
        self.assertEqual(cache[key]['timeouts'], 1)
        self.assertEqual(cache[key]['lastTimeoutS'], 60)
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
        self.clock[0] += 90000
        def denied(cmd, **kwargs):
            self.clock[0] += 2
            return SimpleNamespace(returncode=1, stdout='1\t'+key+'\n', stderr='du: Permission denied')
        jobs.big_root_inventory(root, denied, self.clock[0]+200, cache)
        self.assertEqual(cache[key]['elapsedMs'], 20000)
        self.assertTrue(cache[key]['partial'])

    def test_probe_logs_and_total_timeout_metrics_survive_allowlist(self):
        root = self.roots([('metrics', 1)])[0]
        deep.run_pass([root], self.runner(lambda p: 20))
        end = self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['probeTimeouts'], 1)
        self.assertEqual(end['secondsInProbeTimeouts'], 15)
        self.assertEqual(end['timeouts'], 1)
        self.assertEqual(end['secondsInTimeouts'], 15)
        self.assertEqual(end['probeAllowanceMedianS'], 22.5)
        self.assertEqual(end['childrenDescended'], 0)
        self.assertEqual(end['childrenRemaining'], 0)
        errors = [r for r in self.rows('disk.inventory.source') if r['props'].get('failure') == 'timeout']
        self.assertEqual(errors[0]['props']['allowanceS'], 15)

    def test_night_one_shape_four_daily_passes_with_hourly_freshness_checks(self):
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
                return 1050
            if path.parent in giants:
                return 350
            if path.parent == roots[1]:
                return 9+7*int(path.name)/280
            return 3.4 if path.parent == roots[2] else .034 if path.parent == roots[4] else 1.5
        def listing(path, deadline):
            return [SimpleNamespace(path=str(p), is_dir=lambda **kw: True)
                    for p in topology[Path(path)]], True
        stored, evidence, completed_roots, hourly, coverage_failures = {}, [], set(), [], []
        end = {}
        def log(component, kind, name, **kwargs):
            if name == 'disk.deep.end':
                end.update(kwargs['props'])
            if name == 'disk.deep.root' and not kwargs['props']['partial']:
                completed_roots.add(kwargs['props']['source'])
        def observe(at, state):
            partial_roots = []
            for root in roots:
                cache = copy.deepcopy(state['childState'][str(root)])
                entries, listed = listing(root, None)
                total, status, children = jobs.inventory_status(cache, entries, listed, at, root=root)
                if status['partial']:
                    partial_roots.append(str(root))
                    if root not in {p.parent for p in giants}:
                        coverage_failures.append(dict(root=str(root), at=at))
                for child in giants:
                    if child.parent == root and jobs.inventory_needs_measurement(cache.get(str(child)), at, root=root):
                        self.assertTrue(status['partial'])
            hourly.append(dict(at=at, partialRoots=partial_roots))
        with patch.object(jobs, 'inventory_listing', side_effect=listing), \
             patch.object(jobs.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR, st_blocks=0)), \
             patch.object(jobs, 'read_state', side_effect=lambda n: copy.deepcopy(stored.get(n, {}))), \
             patch.object(jobs, 'save_state', side_effect=lambda n, v: stored.update({n: copy.deepcopy(v)})), \
             patch.object(jobs, 'emit'), patch.object(deep, 'emit', side_effect=log):
            for night in range(4):
                self.clock[0] = night*86400
                start, calls = self.clock[0], []
                breakdown = {name: dict(count=0, seconds=0) for name in ('probe', 'realChild', 'batch', 'parts')}
                run_du = self.runner(cost, calls)
                def run(command, **kwargs):
                    command_started = self.clock[0]
                    try:
                        return run_du(command, **kwargs)
                    except subprocess.TimeoutExpired:
                        name = ('parts' if Path(command[-1]).parent in giants else 'batch' if len(command) > 3
                                else 'probe' if kwargs['timeout'] < 60 else 'realChild')
                        breakdown[name]['count'] += 1
                        breakdown[name]['seconds'] += self.clock[0]-command_started
                        raise
                    finally:
                        # An hourly collector during du sees the last persisted
                        # checkpoint, not the still-running command's future rows.
                        hour = self.now+night*86400+3600
                        if night >= 2 and start <= self.clock[0]-3600 and not any(r['at'] == hour for r in hourly):
                            observe(hour, stored['disk-inventory'])
                deep.run_pass(roots, run, budget=5400)
                state = stored['disk-inventory']
                self.assertLessEqual(self.clock[0]-start, 5400.001)
                self.assertTrue(all(timeout <= 600 for cmd, timeout in calls))
                # Cache-complete means actual, fresh measurements, never a killed prefix.
                for cache in state['childState'].values():
                    for value in cache.values():
                        if value.get('partial') is False:
                            self.assertIn('bytes', value)
                        if value.get('parts') and value.get('partial') is False:
                            self.assertEqual(value['partsDone'], 3)
                evidence.append(dict(night=night+1, seconds=round(self.clock[0]-start, 3),
                    remaining=end['childrenRemaining'], timeouts=end['timeouts'],
                    secondsInTimeouts=round(end['secondsInTimeouts'], 3),
                    timeoutBreakdown=breakdown, probeTimeouts=end['probeTimeouts'], rootsComplete=len(roots)-len(state['partials']),
                    giantsComplete=all(not state['childState'][str(p.parent)].get(str(p), {}).get('partial', True) for p in giants),
                    ordinaryRemaining=sum(jobs.inventory_needs_measurement(state['childState'][str(root)].get(str(p)),
                        self.now+self.clock[0], root=root) for root in roots for p in topology[root] if p not in giants),
                    giantParts={str(child): {key: value.get('at') for key, value in
                        state['childState'][str(child.parent)].get(str(child), {}).get('parts', {}).items()}
                        for child in sorted(giants)}))
                self.assertAlmostEqual(sum(v['seconds'] for v in breakdown.values()), end['secondsInTimeouts'])
                if night >= 1:
                    for root in roots:
                        if root not in {p.parent for p in giants} and str(root) in state['partials']:
                            coverage_failures.append(dict(night=night+1, root=str(root), at=self.now+self.clock[0]))
                if night >= 2:
                    for hour in range(1, 25):
                        at = self.now+night*86400+hour*3600
                        if at < self.now+self.clock[0]:
                            continue
                        observe(at, state)
        print('NIGHT_ONE_PROBES', json.dumps(evidence, sort_keys=True))
        print('NIGHT_ONE_COVERAGE', json.dumps(dict(rootsCompleted=sorted(completed_roots),
              finalPartialRoots=sorted(state['partials']), hourly=hourly, ordinaryFailures=coverage_failures)))
        self.assertFalse(coverage_failures, '48 h ordinary steady state must hold; do not widen the window')
        self.assertTrue(evidence[2]['giantsComplete'])
        self.assertTrue(all(row['secondsInTimeouts'] < .15*5400 for row in evidence[1:]))
        self.assertEqual(completed_roots, set(map(str, roots)))
        for child in giants:
            self.assertFalse(state['childState'][str(child.parent)][str(child)]['partial'])
        # Ordinary work requires more than one pass; the scoped window is 48 h.
        ordinary_s = sum(cost(p) for root in roots for p in topology[root] if p not in giants)
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
                    if jobs.number(v.get('elapsedMs'))]), 15)

    def test_timeout_with_every_batch_row_keeps_totals_and_counts_timeout(self):
        root = self.roots([('all-rows', 128)])[0]
        cache = {}
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
        self.assertTrue(all('elapsedMs' not in v for v in cache.values()))
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
                self.assertEqual(calls[0][1], 600 if descends else 30)
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
