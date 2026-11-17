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


class CollectorFairnessTests(unittest.TestCase):
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

    def test_bad_report_files_do_not_abort_source_or_leak_contents(self):
        root = self.root/'reports'
        root.mkdir()
        (root/'Bad.ips').write_bytes(b'\xff private header\n')
        # TextIO buffering used to decode the body beyond the valid JSON header.
        (root/'Valid.ips').write_bytes(b'{"app_name":"Finder","bug_type":"309"}\n\xff private body')
        for path in root.iterdir():
            os.utime(path, (9990,9990))
        self.assertTrue(collector.collect(10000, [root], lambda a,b: {}))
        state = jobs.read_state('crashes')
        self.assertEqual(state['reports0'], 10000)
        self.assertNotIn('reports0Pending', state)
        sources = [r for r in self.rows('crash.source') if r['props']['source'] == str(root)]
        self.assertEqual(sources[-1]['props']['unreadableCount'], 1)
        observed = self.rows('crash.observed')
        self.assertEqual({r['props']['process'] for r in observed}, {'Finder'})
        self.assertNotIn('private', json.dumps(sources+observed))
        self.assertTrue(collector.collect(10001, [root], lambda a,b: {}))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 1)

    def test_non_utf8_filename_is_safe_even_on_filesystems_that_refuse_it(self):
        root = self.root/'reports'
        root.mkdir()
        backing = root/'backing'
        backing.touch()
        os.utime(backing,(9990,9990))
        filename = root/os.fsdecode(b'Bad-\xff.crash')
        stat, listing = Path.stat, Path.iterdir
        def report_stat(path, *args, **kwargs):
            return stat(backing if path == filename else path,*args,**kwargs)
        def reports(path):
            return iter((filename,)) if path == root else listing(path)
        # The offbox shared filesystem refuses raw non-UTF8 names. Inject the
        # same surrogateescaped Path that os.listdir returns on local disks.
        with patch.object(Path,'stat',report_stat), patch.object(Path,'iterdir',reports):
            self.assertTrue(collector.collect(10000,[root],lambda a,b: {}))
        self.assertEqual(jobs.read_state('crashes')['reports0'],10000)
        self.assertEqual(self.rows('crash.observed')[-1]['props']['process'],'unknown')

    def test_file_failure_forms_are_skipped_without_logging_contents(self):
        root = self.root/'reports'
        root.mkdir()
        bad, good = root/'Bad.ips', root/'Good.crash'
        bad.write_text('{}')
        good.write_text('private')
        for path in (bad,good):
            os.utime(path,(9990,9990))
        failures = [PermissionError(13, 'private'), OSError(5, 'private'),
                    UnicodeDecodeError('utf8', b'\xff', 0, 1, 'private'),
                    ValueError('private'), TypeError('private')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                jobs.save_state('crashes', {})
                with patch.object(collector,'report_header',side_effect=failure):
                    self.assertTrue(collector.collect(10000,[root],lambda a,b: {}))
                source = [r for r in self.rows('crash.source') if r['props']['source'] == str(root)][-1]
                self.assertEqual(source['props']['unreadableCount'],1)
                self.assertNotIn('private',json.dumps(source))

    def inventory_roots(self):
        roots = [self.root/name for name in ('big','cache','ExternalSSD/wt','ExternalSSD/board-wt','ExternalSSD/caches')]
        for path in roots:
            path.mkdir(parents=True)
            (path/'child').mkdir()
        return roots

    def test_never_measured_roots_precede_fresh_roots_and_all_get_a_turn(self):
        roots = self.inventory_roots()
        jobs.save_state('disk-inventory',dict(at=9000,sizes={str(p):1024 for p in roots[:2]}))
        seen, clock, now = [], [0], [10000]
        def run(cmd, **kw):
            seen.append(str(Path(cmd[-1]).parent))
            clock[0] += .005
            return SimpleNamespace(returncode=0,stdout='42\t'+cmd[-1],stderr='')
        with patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
             patch.object(jobs.time,'time',side_effect=lambda: now[0]):
            for _ in roots:
                clock[0] = 0
                jobs.directory_inventory(roots,run,deadline=30)
                now[0] += 3600
        self.assertEqual(seen[0],str(roots[2]))
        self.assertEqual(set(seen),set(map(str,roots)))
        self.assertGreaterEqual(len(seen),len(roots))
        summaries = self.rows('disk.inventory.root')
        self.assertEqual(summaries[0]['props']['root'],str(roots[2]))
        self.assertEqual(len(summaries),len(roots)**2)

    def test_failed_unmeasured_root_cannot_starve_other_unmeasured_roots(self):
        roots = self.inventory_roots()
        seen, clock, now = [], [0], [10000]
        def run(cmd, **kw):
            seen.append(str(Path(cmd[-1]).parent))
            clock[0] += kw['timeout']
            raise subprocess.TimeoutExpired(cmd,kw['timeout'])
        with patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
             patch.object(jobs.time,'time',side_effect=lambda: now[0]):
            for _ in roots:
                clock[0] = 0
                jobs.directory_inventory(roots,run,deadline=30)
                now[0] += 3600
        self.assertEqual(set(seen),set(map(str,roots)))

    def test_child_attempts_rotate_and_keep_last_good_size_on_timeout(self):
        root = self.root/'big'
        root.mkdir()
        paths = [root/str(i) for i in range(4)]
        for path in paths:
            path.mkdir()
        now, clock, calls = [10000], [0], []
        fail = [False]
        def run(cmd, **kw):
            calls.append(cmd[-1])
            clock[0] += 15
            if fail[0]:
                raise subprocess.TimeoutExpired(cmd,kw['timeout'])
            return SimpleNamespace(returncode=0,stdout='42\t'+cmd[-1],stderr='')
        with patch.object(jobs,'BIG_ROOTS',{root}), \
             patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
             patch.object(jobs.time,'time',side_effect=lambda: now[0]):
            for _ in paths:
                clock[0] = 0
                jobs.directory_inventory([root],run,deadline=15)
                now[0] += 3600
            self.assertEqual(set(calls),set(map(str,paths)))
            self.assertEqual(len(calls),4)
            state = jobs.read_state('disk-inventory')
            self.assertEqual(state['sizes'][str(root)],4*42*1024)
            fail[0] = True
            now[0] += 86400
            clock[0] = 0
            jobs.directory_inventory([root],run,deadline=15)
        state = jobs.read_state('disk-inventory')
        self.assertEqual(state['sizes'][str(root)],4*42*1024)
        self.assertTrue(state['partials'][str(root)]['partial'])
        self.assertEqual(state['partials'][str(root)]['cachedCount'],4)
        self.assertGreater(state['partials'][str(root)]['ageS'],0)

    def test_setup_overhead_cannot_pin_first_failed_root(self):
        roots = self.inventory_roots()[:3]
        read_state = jobs.read_state
        for budget, overhead in ((30,.01),(45,2),(60,.2),(120,2)):
            with self.subTest(budget=budget,overhead=overhead), \
                 patch.dict(os.environ,TOOLLOG_DIR=str(self.logs/str(budget))):
                clock, now, full = [0], [10000], set()
                def read(name):
                    clock[0] += overhead
                    return read_state(name)
                calls = []
                def run(cmd, **kw):
                    calls.append(str(Path(cmd[-1]).parent))
                    if kw['timeout']+1e-6 >= 15:
                        full.add(str(Path(cmd[-1]).parent))
                    clock[0] += kw['timeout']
                    raise subprocess.TimeoutExpired(cmd,kw['timeout'])
                with patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
                     patch.object(jobs.time,'time',side_effect=lambda: now[0]), \
                     patch.object(jobs,'read_state',side_effect=read):
                    for _ in range(6):
                        clock[0], calls[:] = 0, []
                        jobs.directory_inventory(roots,run,deadline=budget)
                        self.assertLessEqual(clock[0],budget)
                        now[0] += 3600
                self.assertEqual(full,set(map(str,roots)))

    def test_expired_inventory_budget_does_not_rotate_unattempted_roots(self):
        roots = self.inventory_roots()
        with patch.object(jobs.time,'monotonic',return_value=1):
            jobs.directory_inventory(roots,lambda *a,**k: self.fail('must not run du'),deadline=1)
        self.assertEqual(set(jobs.read_state('disk-inventory')['attemptedAt'].values()),{0})

    def test_child_full_and_truncated_allowances_rotate_across_runs(self):
        root = self.root/'big'
        root.mkdir()
        paths = [root/str(i) for i in range(6)]
        for path in paths:
            path.mkdir()
        for cost in (10,10.1,14.9,15,15.1):
            with self.subTest(cost=cost), \
                 patch.dict(os.environ,TOOLLOG_DIR=str(self.logs/str(cost))):
                clock, now, calls = [0], [10000], []
                def run(cmd, **kw):
                    calls.append((cmd[-1],kw['timeout']))
                    clock[0] += min(cost,kw['timeout'])
                    if cost > kw['timeout']:
                        raise subprocess.TimeoutExpired(cmd,kw['timeout'])
                    return SimpleNamespace(returncode=0,stdout='42\t'+cmd[-1],stderr='')
                with patch.object(jobs,'BIG_ROOTS',{root}), \
                     patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
                     patch.object(jobs.time,'time',side_effect=lambda: now[0]):
                    for _ in range(6):
                        clock[0] = 0
                        jobs.directory_inventory([root],run,deadline=60)
                        self.assertLessEqual(clock[0],60)
                        now[0] += 3600
                self.assertEqual({path for path,timeout in calls if timeout == 15 or cost <= timeout},
                                 set(map(str,paths)))
                state = jobs.read_state('disk-inventory')
                if cost <= 15:
                    cached = state['childState'][str(root)]
                    self.assertTrue(all('bytes' in cached[str(path)] for path in paths))
                    self.assertEqual(state['sizes'][str(root)],6*42*1024)
                else:
                    self.assertEqual(state['sizes'][str(root)],6*42*1024)

    def test_thirty_second_calls_keep_up_for_six_hours(self):
        now, clock = 10000, [0]
        jobs.save_state('crashes',{'unified':now-3600,'rollupDay':'1969-12-31'})
        calls = []
        def reader(a,b):
            calls.append((a,b))
            clock[0] += 30
            return {}
        with patch.object(collector.time,'monotonic',side_effect=lambda: clock[0]):
            for _ in range(6):
                clock[0] = 0
                self.assertTrue(collector.collect(now,[],reader,deadline=290))
                self.assertEqual(jobs.read_state('crashes')['unified'],now)
                self.assertNotIn('unifiedRetry',jobs.read_state('crashes'))
                self.assertEqual(self.rows('crash.source')[-1]['props']['skippedS'],0)
                self.assertLessEqual(clock[0],135)
                now += 3600
        self.assertEqual(sum(b-a for a,b in calls),6*3600)

    def test_all_thirteen_configured_roots_get_measured_within_twelve_runs(self):
        roots = [self.root/str(i) for i in range(len(jobs.DIRECTORY_ROOTS))]
        self.assertEqual(len(roots),13)
        for root in roots:
            root.mkdir()
            (root/'child').mkdir()
        clock, now, calls = [0], [10000], []
        def run(cmd, **kw):
            cost = min(30,kw['timeout'])
            clock[0] += cost
            if cost < 30:
                raise subprocess.TimeoutExpired(cmd,kw['timeout'])
            calls.append(str(Path(cmd[-1]).parent))
            return SimpleNamespace(returncode=0,stdout='42\t'+cmd[-1],stderr='')
        with patch.object(jobs.time,'monotonic',side_effect=lambda: clock[0]), \
             patch.object(jobs.time,'time',side_effect=lambda: now[0]):
            for _ in range(12):
                clock[0] = 0
                jobs.directory_inventory(roots,run,deadline=120)
                self.assertLessEqual(clock[0],120)
                now[0] += 3600
        self.assertEqual(set(calls),set(map(str,roots)))
