import datetime as dt
import errno
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import deep_inventory
import disk_budgets as budgets
import jobs
from rollup import rollup
from toollog import emit, safe_fields

NOW = dt.datetime(2026, 11, 17, 12, tzinfo=dt.timezone.utc)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.path = self.root/'offbox'
        self.path.mkdir()
        self.row = dict(path=str(self.path), owner_board='offbox', budget_gb=5, note='retention')

    def rows(self, name):
        return [r for p in sorted(self.logs.glob('*.ndjson')) for r in map(json.loads, p.read_text().splitlines())
                if r['name'] == name]

    def seed(self, size=7, age=0, partial=False, now=NOW, path=None):
        path = self.path if path is None else path
        value = dict(bytes=size*budgets.GB, at=now.timestamp()-age, partial=partial, isDirectory=True)
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(path.parent): {str(path):value}}))
        return value

    def sample(self, now=NOW, rows=None):
        # Sampling must never call du (or any other subprocess).
        with patch.object(subprocess, 'run', side_effect=AssertionError('hourly spawned a command')):
            budgets.sample([self.row] if rows is None else rows, now)
        return self.rows('disk.budget')[-1]['props']

    def test_seeded_config_and_parse(self):
        rows = budgets.load_budgets()
        self.assertEqual(len(rows), 10)
        limits = {r['path']: (r['owner_board'], r['budget_gb']) for r in rows}
        self.assertEqual(limits[str(Path.home()/'.robob')], ('mac', 60))
        self.assertEqual(limits[str(Path.home()/'.local/share/offbox')], ('offbox', 5))
        self.assertEqual(limits[str(Path.home()/'.robob/logs/tools/offbox')], ('offbox', .5))
        config = self.root/'budgets.json'
        config.write_text(json.dumps([self.row]))
        self.assertEqual(budgets.load_budgets(config), [self.row])

    def test_invalid_config_forms(self):
        config = self.root/'budgets.json'
        forms = [None, {}, [None], [dict(self.row, extra=True)]]
        for value in (True, False, 0, -1, '5', None, float('inf'), float('nan')):
            forms.append([dict(self.row, budget_gb=value)])
        for value in ('relative', '~other/path', '/a/../b', '/a\nb', ''):
            forms.append([dict(self.row, path=value)])
        for value in ('Offbox', 'off box', '', None):
            forms.append([dict(self.row, owner_board=value)])
        forms.extend([[dict(self.row, note=None)], [self.row, self.row]])
        for form in forms:
            with self.subTest(form=form):
                config.write_text(json.dumps(form))
                with self.assertRaises(ValueError):
                    budgets.load_budgets(config)

    def test_over_equal_and_under_emit_well_formed_events(self):
        for i, size in enumerate((7, 5, 3)):
            now = NOW+dt.timedelta(hours=i)
            self.seed(size, now=now)
            props = self.sample(now)
            self.assertEqual(props, dict(path=str(self.path), owner='offbox', sizeGb=size, budgetGb=5,
                                        overBy=max(0, size-5), sizeAgeS=0, source='inventory', status='ok'))
        self.assertFalse(self.rows('disk.budget.over'))

    def test_stale_future_partial_and_absent_cache(self):
        forms = [('old', 90000, False, 7, 90000), ('future', -1, False, None, None),
                 ('partial', 0, True, None, None)]
        for label, age, partial, size, reported_age in forms:
            with self.subTest(label=label), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/label)):
                self.seed(age=age, partial=partial)
                budgets.sample([self.row], NOW)
                state = jobs.read_state('disk-budget')[str(self.path)]['props']
                self.assertEqual((state['source'], state['sizeGb'], state['sizeAgeS']), ('stale', size, reported_age))
        jobs.save_state('disk-inventory', {})
        props = self.sample()
        self.assertEqual((props['source'], props['status'], props['sizeGb']), ('stale', 'unmeasured', None))

    def test_partial_refresh_retains_last_complete_size_and_age(self):
        self.seed()
        self.sample()
        self.seed(size=1, partial=True, now=NOW+dt.timedelta(hours=1))
        props = self.sample(NOW+dt.timedelta(hours=1))
        self.assertEqual((props['sizeGb'], props['sizeAgeS'], props['source']), (7, 3600, 'stale'))

    def test_missing_path_is_zero_but_unmounted_volume_is_unavailable(self):
        self.path.rmdir()
        props = self.sample()
        self.assertEqual((props['sizeGb'], props['source'], props['status']), (0, 'inventory', 'missing'))
        self.row['path'] = '/Volumes/ExternalSSD/no-such-budget-test'
        with patch.object(Path, 'is_mount', return_value=False):
            props = self.sample(NOW+dt.timedelta(hours=1))
        self.assertEqual((props['source'], props['sizeGb'], props['status']), ('stale', None, 'unavailable'))

    def test_absence_at_each_external_path_level_requires_backing_mount(self):
        path = Path('/Volumes/ExternalSSD/budget-test')
        for absent in (Path('/Volumes'), path.parent, path):
            for mounted in (False, True):
                with self.subTest(absent=absent, mounted=mounted):
                    def lstat(part):
                        if part == absent:
                            raise FileNotFoundError(errno.ENOENT, 'fixture missing', str(part))
                        return SimpleNamespace(st_mode=stat.S_IFDIR)
                    with patch.object(Path, 'lstat', lstat), patch.object(Path, 'is_mount', return_value=mounted):
                        self.assertEqual(budgets.path_status(path, jobs.time.monotonic()+1),
                                         'missing' if mounted else 'unavailable')

    def test_symlink_target_and_symlink_ancestor_excluded(self):
        target = self.root/'ssd'
        target.mkdir()
        (target/'nested').mkdir()
        link = self.path/'userdata'
        link.symlink_to(target, target_is_directory=True)
        for path in (link, link/'nested'):
            with self.subTest(path=path):
                self.seed(size=1000, path=path)
                row = dict(self.row, path=str(path))
                props = self.sample(rows=[row])
                self.assertEqual((props['status'], props['source'], props['sizeGb']), ('symlink', 'stale', None))
        calls = []
        budgets.deep_refresh([dict(self.row, path=str(link))], {}, lambda *a, **kw:calls.append(a),
                             jobs.time.monotonic()+10)
        self.assertFalse(calls)

    def test_robob_root_sum_excludes_userdata_cached_bytes(self):
        home = self.root/'home'
        robob = home/'.robob'
        robob.mkdir(parents=True)
        logs = robob/'logs'
        logs.mkdir()
        (robob/'userdata').symlink_to(self.path, target_is_directory=True)
        value = dict(at=NOW.timestamp()-60, partial=False, bytes=budgets.GB)
        state = dict(duMode='links', at=NOW.timestamp(), sizes={str(robob):1001*budgets.GB}, childState={
            str(robob):{str(logs): value, str(robob/'userdata'):dict(value, bytes=1000*budgets.GB)}})
        jobs.save_state('disk-inventory', state)
        with patch.object(Path, 'home', return_value=home):
            props = self.sample(rows=[dict(self.row, path=str(robob))])
        self.assertEqual((props['sizeGb'], props['sizeAgeS']), (1, 60))
        state['partials'] = {str(robob): {'partial':True}}
        self.assertIsNone(budgets.inventory_size(robob, state, NOW.timestamp()))

    def test_root_sum_uses_oldest_child_and_parts_cache(self):
        value = dict(at=NOW.timestamp()-120, partial=False, bytes=budgets.GB)
        state = dict(duMode='links', at=NOW.timestamp(), sizes={str(self.root):2*budgets.GB},
                     childState={str(self.root):{str(self.path):value,
                        str(self.root/'another'):dict(value, at=NOW.timestamp()-3600)}})
        self.assertEqual(budgets.inventory_size(self.root, state, NOW.timestamp())['at'], NOW.timestamp()-3600)
        nested = self.path/'logs'
        state['childState'][str(self.root)][str(self.path)] = dict(partial=True, parts={str(nested):value})
        self.assertEqual(budgets.inventory_size(nested, state, NOW.timestamp())['bytes'], budgets.GB)

    def test_root_freshness_preserves_child_measurement_policies(self):
        forms = [('ordinary', 24*3600-1, True), ('ordinary', 24*3600, False),
                 ('deep', 48*3600-1, True), ('deep', 48*3600, False),
                 ('parts', 24*3600-1, True), ('parts', 24*3600, True),
                 ('parts', 48*3600, True), ('parts', 72*3600-1, True),
                 ('parts', 72*3600, False)]
        for mode, age, fresh in forms:
            with self.subTest(mode=mode, age=age):
                child = dict(bytes=90*budgets.GB, at=NOW.timestamp()-age, partial=False)
                if mode == 'parts':
                    child.update(isDirectory=True, parts={str(self.path/'part'):dict(child)})
                recent = dict(bytes=10*budgets.GB, at=NOW.timestamp(), partial=False)
                state = dict(duMode='links', at=NOW.timestamp(), sizes={str(self.root):100*budgets.GB},
                             childState={str(self.root):{str(self.path):child, str(self.root/'recent'):recent}})
                with patch.object(jobs, 'DEEP_ROOTS', {str(self.root)} if mode == 'deep' else set()):
                    value = budgets.inventory_size(self.root, state, NOW.timestamp())
                self.assertEqual(value, dict(bytes=100*budgets.GB, at=NOW.timestamp()-age, fresh=fresh))

    def test_root_listing_freshness_is_separate_from_child_measurement_age(self):
        part = dict(bytes=100*budgets.GB, at=NOW.timestamp()-48*3600, partial=False)
        child = dict(part, isDirectory=True, parts={str(self.path/'part'):part})
        forms = [('recent', NOW.timestamp(), True), ('boundary_before', NOW.timestamp()-86400+1, True),
                 ('expired', NOW.timestamp()-86400, False), ('future', NOW.timestamp()+1, False),
                 ('missing', None, False), ('invalid', 'recent', False)]
        for name, listed_at, fresh in forms:
            with self.subTest(name=name):
                state = dict(duMode='links', at=listed_at, sizes={str(self.root):child['bytes']},
                             childState={str(self.root):{str(self.path):child}})
                value = budgets.inventory_size(self.root, state, NOW.timestamp())
                self.assertEqual(value, dict(bytes=100*budgets.GB, at=child['at'], fresh=fresh))

    def test_aged_root_parts_keep_hourly_streak_alert_and_rollup(self):
        for age_hours in (24, 48, 69):
            with self.subTest(age_hours=age_hours), patch.object(self, 'logs', self.logs/str(age_hours)), \
                 patch.dict(os.environ, TOOLLOG_DIR=str(self.logs)):
                measured_at = NOW.timestamp()-age_hours*3600
                part = dict(bytes=90*budgets.GB, at=measured_at, partial=False)
                child = dict(part, isDirectory=True, parts={str(self.path/'part'):part})
                row = dict(self.row, path=str(self.root), owner_board='mac', budget_gb=60)
                for hour in range(3):
                    now = NOW+dt.timedelta(hours=hour)
                    recent = dict(bytes=10*budgets.GB, at=now.timestamp(), partial=False)
                    state = dict(duMode='links', at=now.timestamp(), sizes={str(self.root):100*budgets.GB},
                                 childState={str(self.root):{str(self.path):child, str(self.root/'recent'):recent}})
                    jobs.save_state('disk-inventory', state)
                    props = self.sample(now, [row])
                    self.assertEqual((props['source'], props['status'], props['sizeGb'], props['sizeAgeS']),
                                     ('inventory', 'ok', 100, (age_hours+hour)*3600))
                self.assertEqual(jobs.read_state('disk-budget')[str(self.root)]['streak'], 3)
                alerts = self.rows('disk.budget.over')
                self.assertEqual(len(alerts), 1)
                self.assertEqual((alerts[0]['props']['owner'], alerts[0]['props']['overBy']), ('mac', 40))
                top = rollup(NOW.date().isoformat(), self.logs)['diskBudgets']['topOverBudget']
                self.assertEqual(len(top), 1)
                self.assertEqual((top[0]['path'], top[0]['sizeGb'], top[0]['overBy'], top[0]['sizeAgeS']),
                                 (str(self.root), 100, 40, (age_hours+2)*3600))

    def test_three_hour_streak_daily_dedupe_restart_gap_and_recovery(self):
        start = NOW.replace(hour=21)
        for i in range(7):
            now = start+dt.timedelta(hours=i)
            self.seed(now=now)
            self.sample(now)
            self.sample(now+dt.timedelta(minutes=10))
        self.assertEqual(len(self.rows('disk.budget')), 7)
        over = self.rows('disk.budget.over')
        self.assertEqual([r['ts'][:13] for r in over], ['2026-11-17T23', '2026-11-18T00'])
        self.assertTrue(all(r['props']['owner'] == 'offbox' for r in over))
        # Persisted state survives each invocation; a missed hour resets it.
        now = start+dt.timedelta(hours=9)
        self.seed(now=now)
        self.sample(now)
        self.assertEqual(jobs.read_state('disk-budget')[str(self.path)]['streak'], 1)
        for i, (age, size) in enumerate(((90000, 7), (0, 7), (0, 5), (0, 7)), start=10):
            now = start+dt.timedelta(hours=i)
            self.seed(size=size, age=age, now=now)
            self.sample(now)
            self.assertLessEqual(jobs.read_state('disk-budget')[str(self.path)]['streak'], 1)

    def test_emit_failure_retries_sample_and_alert_without_duplicate_samples(self):
        self.seed()
        with patch.object(budgets, 'emit', return_value=False):
            budgets.sample([self.row], NOW)
        self.assertFalse(jobs.read_state('disk-budget'))
        for i in range(2):
            self.seed(now=NOW+dt.timedelta(hours=i))
            self.sample(NOW+dt.timedelta(hours=i))
        now = NOW+dt.timedelta(hours=2)
        self.seed(now=now)
        real_emit = budgets.emit
        with patch.object(budgets, 'emit', side_effect=lambda c,k,n,**kw:
                          False if n == 'disk.budget.over' else real_emit(c,k,n,**kw)):
            budgets.sample([self.row], now)
        self.sample(now)
        self.assertEqual(len(self.rows('disk.budget')), 3)
        self.assertEqual(len(self.rows('disk.budget.over')), 1)

    def test_daily_extra_target_reuses_scanner_and_hourly_reuses_deep_size(self):
        payload = self.path/'payload'
        payload.write_bytes(b'payload')
        calls = []
        def run(command, **kwargs):
            calls.append((command, kwargs['timeout']))
            return SimpleNamespace(returncode=0, stderr='', stdout='7340032\t'+str(self.path)+'\n')
        with patch.object(jobs.time, 'time', return_value=NOW.timestamp()):
            budgets.deep_refresh([self.row], {}, run, jobs.time.monotonic()+600)
            budgets.deep_refresh([self.row], {}, run, jobs.time.monotonic()+600)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], ['/usr/bin/du', '-skl', str(self.path)])
        self.assertLessEqual(calls[0][1], jobs.DEEP_CHILD_CAP_S)
        props = self.sample()
        self.assertEqual((props['source'], props['sizeGb']), ('deep', 7))

    def test_daily_entry_point_measures_extra_targets_under_inventory_lock(self):
        def run(command, **kwargs):
            with jobs.inventory_lock() as acquired:
                self.assertIs(acquired, False)
            return SimpleNamespace(returncode=0, stderr='', stdout='1024\t'+str(self.path)+'\n')
        with patch.object(jobs, 'DIRECTORY_ROOTS', []), patch.object(budgets, 'load_budgets', return_value=[self.row]), \
             patch.object(jobs.time, 'time', return_value=NOW.timestamp()):
            deep_inventory.run_pass(run=run, budget=600)
        self.assertEqual(self.sample()['source'], 'deep')
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['stopReason'], 'done')

    def test_inventory_freshness_boundary_and_unavailable_metadata(self):
        for i, (age, source) in enumerate(((86399, 'inventory'), (86400, 'stale'))):
            now = NOW+dt.timedelta(hours=i)
            self.seed(age=age, now=now)
            self.assertEqual(self.sample(now)['source'], source)
        self.seed(now=NOW+dt.timedelta(hours=2))
        with patch.object(budgets, 'path_status', return_value='unavailable'):
            props = self.sample(NOW+dt.timedelta(hours=2))
        self.assertEqual((props['source'], props['sizeGb'], props['status']), ('stale', 7, 'unavailable'))

    def test_one_event_for_every_seeded_path_without_hourly_measurements(self):
        rows = budgets.load_budgets()
        children = {r['path']:dict(bytes=budgets.GB, at=NOW.timestamp(), partial=False) for r in rows}
        jobs.save_state('disk-inventory', dict(duMode='links', childState={'/fixture':children}))
        with patch.object(budgets, 'path_status', return_value='present'):
            self.sample(rows=rows)
        events = self.rows('disk.budget')
        self.assertEqual({r['props']['path'] for r in events}, set(children))
        self.assertEqual(len(events), 10)
        self.assertTrue(all(r['props']['sizeGb'] == 1 for r in events))

    def test_deep_never_duplicates_inventory_covered_paths_or_exceeds_budget(self):
        self.seed()
        fail = lambda *a, **kw:self.fail('covered/stopped target ran du')
        state = jobs.read_state('disk-inventory')
        budgets.deep_refresh([self.row], state, fail, jobs.time.monotonic()+20)
        budgets.deep_refresh([self.row], {}, fail, jobs.time.monotonic()-1)
        budgets.deep_refresh([self.row], {}, fail, jobs.time.monotonic()+20, stopped=lambda:True)

    def test_daily_timeout_does_not_become_zero_and_next_pass_resumes(self):
        def timeout(command, **kwargs):
            self.assertLessEqual(kwargs['timeout'], jobs.DEEP_CHILD_CAP_S)
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        budgets.deep_refresh([self.row], {}, timeout, jobs.time.monotonic()+10)
        props = self.sample()
        self.assertEqual((props['source'], props['sizeGb']), ('stale', None))
        self.assertIn(str(self.path), jobs.read_state('disk-budget-deep')['children'])
        def success(command, **kwargs):
            return SimpleNamespace(returncode=0, stderr='', stdout='1024\t'+str(self.path)+'\n')
        budgets.deep_refresh([self.row], {}, success, jobs.time.monotonic()+600)
        value = jobs.read_state('disk-budget-deep')['children'][str(self.path)]
        self.assertFalse(value['partial'])
        self.assertEqual(value['bytes'], 1024**2)

    def test_daily_decomposition_completes_all_five_parts_in_one_pass(self):
        for i in range(5):
            (self.path/str(i)).mkdir()
        clock, calls = [0], []
        def run(command, **kwargs):
            key = command[-1]
            calls.append(key)
            if key == str(self.path):
                clock[0] += kwargs['timeout']
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            clock[0] += 1
            return SimpleNamespace(returncode=0, stderr='', stdout='1024\t'+key+'\n')
        with patch.object(jobs.time, 'time', side_effect=lambda:NOW.timestamp()+clock[0]), \
             patch.object(jobs.time, 'monotonic', side_effect=lambda:clock[0]):
            budgets.deep_refresh([self.row], {}, run, 600)
        value = jobs.read_state('disk-budget-deep')['children'][str(self.path)]
        self.assertFalse(value['partial'])
        self.assertEqual(value['partsDone'], 5)
        self.assertEqual(len(calls), 6)
        self.assertLessEqual(clock[0], 600)
        props = self.sample(NOW+dt.timedelta(seconds=clock[0]))
        self.assertEqual(props['source'], 'deep')
        self.assertGreaterEqual(props['sizeGb'], 5*1024**2/budgets.GB)

    def test_decomposed_target_keeps_progress_at_cap_then_resumes_next_pass(self):
        for i in range(5):
            (self.path/str(i)).mkdir()
        clock, calls = [0], []
        value = dict(partial=True, timeouts=1, lastTimeoutS=60, isDirectory=True)
        jobs.save_state('disk-budget-deep', dict(duMode='links', children={str(self.path):value}))
        def run(command, **kwargs):
            calls.append((command[-1], kwargs['timeout']))
            if kwargs['timeout'] < 200:
                clock[0] += kwargs['timeout']
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            clock[0] += 200
            return SimpleNamespace(returncode=0, stderr='', stdout='1024\t'+command[-1]+'\n')
        with patch.object(jobs.time, 'time', side_effect=lambda:NOW.timestamp()+clock[0]), \
             patch.object(jobs.time, 'monotonic', side_effect=lambda:clock[0]):
            budgets.deep_refresh([self.row], {}, run, 5400)
            self.assertLessEqual(clock[0], 600)
            value = jobs.read_state('disk-budget-deep')['children'][str(self.path)]
            self.assertTrue(value['partial'])
            self.assertEqual(value['partsDone'], 3)
            self.assertNotIn('bytes', value)
            clock[0] = 86400
            budgets.deep_refresh([self.row], {}, run, clock[0]+5400)
        value = jobs.read_state('disk-budget-deep')['children'][str(self.path)]
        self.assertFalse(value['partial'])
        self.assertEqual(value['partsDone'], 5)
        self.assertEqual(len(calls), 5)

    def test_daily_freshness_lookahead_forms(self):
        for name, age, expected_calls in (('fresh', 3600, 0), ('expires_during_pass', 86340, 1),
                                           ('expired', 86401, 1)):
            with self.subTest(name=name), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/name)):
                value = dict(partial=False, bytes=budgets.GB, at=NOW.timestamp()-age, isDirectory=True)
                jobs.save_state('disk-budget-deep', dict(duMode='links', children={str(self.path):value}))
                calls = []
                def run(command, **kwargs):
                    calls.append(command)
                    return SimpleNamespace(returncode=0, stderr='', stdout='1024\t'+str(self.path)+'\n')
                with patch.object(jobs.time, 'time', return_value=NOW.timestamp()):
                    budgets.deep_refresh([self.row], {}, run, jobs.time.monotonic()+600)
                self.assertEqual(len(calls), expected_calls)
                budgets.sample([self.row], NOW+dt.timedelta(seconds=120))
                props = jobs.read_state('disk-budget')[str(self.path)]['props']
                self.assertEqual(props['source'], 'deep')

    def test_event_schema_rejects_nonfinite_unsafe_and_unknown_fields(self):
        props = safe_fields(dict(path='/a/password', owner='bad owner', sizeGb=float('nan'),
                                 budgetGb=True, source='du', overBy=-1, extra='x'), 'disk.budget')
        self.assertEqual(props, {})

    def test_collector_samples_after_inventory_even_on_inventory_failure(self):
        for failing in (False, True):
            order = []
            def inventory(**kwargs):
                order.append('inventory')
                if failing:
                    raise OSError('inventory unavailable')
            with self.subTest(failing=failing), patch.object(collector, 'missing_day'), \
                 patch.object(collector, 'collect'), patch.object(collector, 'disk_wait'), \
                 patch.object(collector, 'disk_tooling_probe'), \
                 patch.object(collector, 'directory_inventory', side_effect=inventory), \
                 patch.object(budgets, 'sample', side_effect=lambda:order.append('budget')):
                collector.main()
            self.assertEqual(order, ['inventory', 'budget'])

    def test_real_daily_du_then_hourly_event_from_persisted_cache(self):
        (self.path/'payload').write_bytes(b'X'*1024**2)
        measured = []
        def run(command, **kwargs):
            result = subprocess.run(command, **kwargs)
            measured.append(int(result.stdout.split('\t')[0])*1024)
            return result
        with patch.object(jobs.time, 'time', return_value=NOW.timestamp()):
            budgets.deep_refresh([self.row], {}, run, jobs.time.monotonic()+600)
        props = self.sample()
        self.assertEqual(len(measured), 1)
        self.assertGreaterEqual(measured[0], 1024**2)
        self.assertEqual(props['sizeGb'], measured[0]/budgets.GB)
        self.assertEqual((props['source'], props['owner']), ('deep', 'offbox'))

    def test_rollup_top_paths_and_growth_across_utc_days(self):
        for now, size in ((NOW-dt.timedelta(days=1), 6), (NOW, 9)):
            self.seed(size=size, now=now)
            self.sample(now)
        # Stale rows cannot be a growth baseline or replace a fresh reading.
        emit('disk', 'event', 'disk.budget', now=NOW+dt.timedelta(minutes=5),
             props=dict(self.rows('disk.budget')[-1]['props'], source='stale', sizeGb=99))
        result = rollup('2026-11-17', self.logs)['diskBudgets']
        self.assertEqual(result['pathsMeasured'], 1)
        top = result['topOverBudget'][0]
        self.assertEqual((top['sizeGb'], top['overBy'], top['growth24hGb'], top['growthWindowS']), (9, 4, 3, 86400))
        first = rollup('2026-11-16', self.logs)['diskBudgets']['topOverBudget'][0]
        self.assertIsNone(first['growth24hGb'])

    def test_growth_uses_measurement_ages_instead_of_repeated_event_times(self):
        forms = [('fresh', 0, 0, 86400), ('same_age', 3600, 3600, 86400),
                 ('old_baseline', 23*3600, 0, None), ('old_current', 0, 23*3600, None),
                 ('cached_same_measurement', 0, 86400, None)]
        for name, old_age, current_age, expected_window in forms:
            with self.subTest(name=name), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/name)):
                props = dict(path=str(self.path), owner='offbox', budgetGb=5, source='deep', status='ok')
                for now, size, age in ((NOW-dt.timedelta(days=1), 6, old_age), (NOW, 9, current_age)):
                    emit('disk', 'event', 'disk.budget', now=now,
                         props=dict(props, sizeGb=size, overBy=size-5, sizeAgeS=age))
                top = rollup('2026-11-17', self.logs/name)['diskBudgets']['topOverBudget'][0]
                self.assertEqual(top['growthWindowS'], expected_window)
                self.assertEqual(top['growth24hGb'], 3 if expected_window else None)
                self.assertEqual(top['sizeTs'], (NOW-dt.timedelta(seconds=current_age)).isoformat())

    def test_growth_history_covers_fresh_decomposed_measurement_ages(self):
        for age_hours in (0, 24, 48, 60, 71.99):
            with self.subTest(age_hours=age_hours), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(age_hours))):
                props = dict(path=str(self.path), owner='offbox', budgetGb=5, source='deep', status='ok')
                size_at = NOW-dt.timedelta(hours=age_hours)
                emit('disk', 'event', 'disk.budget', now=size_at-dt.timedelta(days=1),
                     props=dict(props, sizeGb=6, overBy=1, sizeAgeS=0))
                emit('disk', 'event', 'disk.budget', now=NOW,
                     props=dict(props, sizeGb=9, overBy=4, sizeAgeS=age_hours*3600))
                top = rollup('2026-11-17', self.logs/str(age_hours))['diskBudgets']['topOverBudget'][0]
                self.assertEqual((top['growth24hGb'], top['growthWindowS']), (3, 86400))


if __name__ == '__main__':
    unittest.main()
