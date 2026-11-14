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


class InventoryProgressTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root/'logs'))
        env.start()
        self.addCleanup(env.stop)

    def rows(self, name):
        return [r for p in (self.root/'logs').glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def test_external_shaped_roots_accumulate_and_small_roots_finish_first_run(self):
        roots = [self.root/('external%d' % i) for i in range(9)]
        small = [self.root/('small%d' % i) for i in range(4)]
        costs = {}
        # Observed classes: tiny metadata, ~3 s worktree, >15 s worktree,
        # and a child exceeding the chosen hourly 60 s ceiling.
        for i, root in enumerate(roots+small):
            root.mkdir()
            for n in range([5,7,9,11,13,15,17,19,20][i] if i < 9 else 2):
                child = root/str(n)
                child.mkdir()
                costs[str(child)] = (.005 if i >= 9 or n else (20 if i % 2 else 90))
            if i < 9:
                costs[str(root/'1')] = 3.4
        clock, now = [0], [10000]
        def run(cmd, **kw):
            child = cmd[-1]
            cost = costs[child]
            clock[0] += min(cost, kw['timeout'])
            if cost > kw['timeout']:
                raise subprocess.TimeoutExpired(cmd, kw['timeout'])
            return SimpleNamespace(returncode=0, stdout='42\t'+child+'\n', stderr='')
        with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(jobs.time, 'time', side_effect=lambda: now[0]):
            for hour in range(12):
                clock[0] = 0
                jobs.directory_inventory(roots+small, run, deadline=150)
                self.assertLessEqual(clock[0],150)
                state = jobs.read_state('disk-inventory')
                if hour == 0:
                    self.assertTrue(all(str(p) in state['sizes'] and str(p) not in state['partials'] for p in small))
                now[0] += 3600
        for root in roots:
            cache = state['childState'][str(root)]
            for child in root.iterdir():
                self.assertTrue('bytes' in cache.get(str(child),{}) or cache.get(str(child),{}).get('limited'),str(child))
            self.assertIn(str(root),state['sizes'])
        props = self.rows('disk.inventory')[-1]['props']
        self.assertEqual(props['duMode'],'links')
        self.assertGreaterEqual(props['rootsComplete'],4)
        self.assertGreater(props['rootsPartial'],0)
        self.assertGreater(props['childrenCached'],0)
        self.assertGreater(props['oldestChildAgeS'],0)
        root_rows = [r for r in self.rows('disk.inventory.source') if r['props']['source'] in set(map(str,roots))]
        self.assertTrue(all('unmeasuredCount' in r['props'] for r in root_rows))

    def test_retry_suffix_continues_into_current_window(self):
        jobs.save_state('crashes',dict(unified=9100,unifiedRetry=dict(windowStart=9100,windowEnd=10000,skippedS=0)))
        clock, calls = [0], []
        def reader(a,b):
            calls.append((a,b))
            clock[0] += 25*(b-a)/900
            return {}
        with patch.object(collector.time,'monotonic',side_effect=lambda: clock[0]):
            self.assertTrue(collector.collect(13600,[],reader,deadline=290))
        self.assertEqual((calls[0][0], calls[-1][1]), (9100, 13600))
        self.assertIn(10000, [a for a,b in calls])
        self.assertEqual([b for a,b in calls[:-1]], [a for a,b in calls[1:]])
        self.assertEqual(jobs.read_state('crashes')['unified'],13600)
        self.assertAlmostEqual(self.rows('crash.source')[-1]['props']['lagS'],125)

    def test_twelve_hours_slow_chunks_have_bounded_lag_and_exact_gaps(self):
        for cost in (30,60):
            with self.subTest(cost=cost),patch.dict(os.environ,TOOLLOG_DIR=str(self.root/str(cost))):
                jobs.save_state('crashes',dict(unified=6400))
                clock, covered = [0], []
                def reader(a,b):
                    remaining = min(60,135-clock[0])
                    clock[0] += min(cost,remaining)
                    if remaining < cost:
                        raise subprocess.TimeoutExpired('log',remaining)
                    covered.append((a,b))
                    return {}
                with patch.object(collector.time,'monotonic',side_effect=lambda: clock[0]):
                    for hour in range(12):
                        clock[0] = 0
                        now = 10000+hour*3600
                        collector.collect(now,[],reader,deadline=290)
                        self.assertLessEqual(clock[0],135)
                        state = jobs.read_state('crashes')
                        self.assertLessEqual(now-state['unified'],2*collector.UNIFIED_WINDOW_S)
                rows=[r for p in (self.root/str(cost)).glob('*.ndjson')
                      for r in map(json.loads,p.read_text().splitlines()) if r['name']=='crash.source']
                skipped=sum(r['props']['skippedS'] for r in rows)
                frontier=state.get('unifiedRetry',{}).get('windowStart',state['unified'])
                self.assertEqual(sum(b-a for a,b in covered)+skipped,frontier-6400)
                self.assertEqual(len(covered),len(set(covered)))
                self.assertTrue(all('lagS' in r['props'] for r in rows))

    def test_large_root_batches_retain_completed_timeout_rows_and_rotate_stall(self):
        root = self.root/'large'
        root.mkdir()
        paths = [root/('%03d' % i) for i in range(140)]
        for path in paths:
            path.mkdir()
        now, clock, calls, cache = [10000], [0], [], {}
        def run(cmd, **kw):
            requested = cmd[2:]
            self.assertLessEqual(len(requested),128)
            self.assertLessEqual(sum(len(os.fsencode(p))+1 for p in requested),32768)
            calls.append(requested)
            rows=[]
            for key in requested:
                if key == str(paths[2]):
                    clock[0] += kw['timeout']
                    raise subprocess.TimeoutExpired(cmd,kw['timeout'],output=(''.join(rows)+'999\t'+key).encode())
                rows.append('42\t'+key+'\n')
            return SimpleNamespace(returncode=0,stdout=''.join(rows),stderr='')
        with patch.object(jobs.time,'time',side_effect=lambda:now[0]), \
             patch.object(jobs.time,'monotonic',side_effect=lambda:clock[0]):
            for _ in range(6):
                clock[0]=0
                total,flags,children=jobs.big_root_inventory(root,run,90,cache)
                now[0]+=3600
        self.assertEqual(set(children),set(map(str,paths))-{str(paths[2])})
        self.assertTrue(cache[str(paths[2])]['limited'])
        self.assertEqual(total,139*42*1024)
        self.assertEqual(flags['unmeasuredCount'],1)
        self.assertEqual(flags['limitedCount'],1)
        self.assertTrue(flags['partial'])
        self.assertLess(len(calls),15)
        self.assertNotIn('bytes',cache[str(paths[2])])

    def test_deep_pass_entries_work_without_hourly_specific_fields(self):
        root=self.root/'shared'
        root.mkdir()
        child=root/'child'
        child.mkdir()
        cache={str(child):dict(bytes=1024,at=10000,attemptedAt=10000,partial=False)}
        with patch.object(jobs.time,'time',return_value=10001):
            total,flags,children=jobs.big_root_inventory(root,lambda *a,**k:self.fail('fresh cache should be used'),jobs.time.monotonic()+2,cache)
        self.assertEqual(total,1024)
        self.assertFalse(flags['partial'])
        self.assertEqual(flags['cachedCount'],1)

    def test_large_fast_root_uses_bounded_process_count(self):
        root=self.root/'many'
        root.mkdir()
        for i in range(1024):
            (root/str(i)).mkdir()
        calls=[]
        def run(cmd,**kw):
            calls.append(cmd)
            return SimpleNamespace(returncode=0,stderr='',stdout=''.join('1\t'+key+'\n' for key in cmd[2:]))
        total,flags,children=jobs.big_root_inventory(root,run,jobs.time.monotonic()+30,{})
        self.assertEqual(total,1024*1024)
        self.assertFalse(flags['partial'])
        self.assertEqual(len(children),1024)
        self.assertEqual(len(calls),8)

    def test_cached_partial_flag_survives_even_without_denied_count(self):
        root=self.root/'partial'
        root.mkdir()
        child=root/'child'
        child.mkdir()
        for partial in (False,True):
            for denied in (0,2):
                for limited in (False,True):
                    with self.subTest(partial=partial,denied=denied,limited=limited):
                        cache={str(child):dict(bytes=1024,at=10000,attemptedAt=10000,
                            partial=partial,deniedCount=denied,limited=limited)}
                        with patch.object(jobs.time,'time',return_value=10001):
                            total,flags,_=jobs.big_root_inventory(root,lambda *a,**k:self.fail('fresh cache'),jobs.time.monotonic()+2,cache)
                        self.assertEqual(total,1024)
                        self.assertEqual(flags['partial'],partial or bool(denied) or limited)

    def test_failed_child_type_lookup_does_not_abort_other_roots(self):
        bad,good=self.root/'bad',self.root/'good'
        bad.mkdir();good.mkdir()
        (good/'child').mkdir()
        entry=SimpleNamespace(path=str(bad/'child'),is_dir=lambda **kw: (_ for _ in ()).throw(OSError('fixture')))
        listing=jobs.inventory_listing
        def entries(path,deadline,source_failures=None):
            return ([entry],True) if path==bad else listing(path,deadline,source_failures)
        def run(cmd,**kw):
            return SimpleNamespace(returncode=0,stdout='1\t'+cmd[-1]+'\n',stderr='')
        with patch.object(jobs,'inventory_listing',side_effect=entries):
            jobs.directory_inventory([bad,good],run)
        state=jobs.read_state('disk-inventory')
        self.assertEqual(state['sizes'][str(good)],1024)
        self.assertTrue(state['partials'][str(bad)]['partial'])

    def test_unavailable_root_never_logs_a_zero_total(self):
        root=self.root/'unavailable'
        listing=jobs.inventory_listing
        with patch.object(jobs,'inventory_listing',side_effect=lambda p,d,f=None: ([],False) if p==root else listing(p,d,f)), \
             patch.object(jobs,'confirmed_absent',return_value=False):
            jobs.directory_inventory([root],lambda *a,**k:self.fail('unavailable'))
        rows=[r for r in self.rows('disk.inventory.source') if r['props']['source']==str(root)]
        self.assertTrue(rows)
        self.assertTrue(all('bytes' not in r['props'] for r in rows))
        self.assertNotIn(str(root),jobs.read_state('disk-inventory')['sizes'])

    def test_whole_hourly_run_keeps_crash_first_and_290_second_deadline(self):
        root=self.root/'inventory'
        root.mkdir()
        for i in range(20):
            (root/str(i)).mkdir()
        for cost in (30,60):
            with self.subTest(cost=cost),patch.dict(os.environ,TOOLLOG_DIR=str(self.root/('run%d'%cost))):
                clock,now,order=[0],[10000],[]
                jobs.save_state('crashes',dict(unified=6400))
                def log(a,b):
                    remaining=min(60,135-clock[0])
                    clock[0]+=min(cost,remaining)
                    if remaining<cost:
                        raise subprocess.TimeoutExpired('log',remaining)
                    return {}
                def du(cmd,**kw):
                    clock[0]+=kw['timeout']
                    raise subprocess.TimeoutExpired(cmd,kw['timeout'])
                collect=collector.collect
                inventory=jobs.directory_inventory
                def crashes(**kw):
                    order.append('crash')
                    return collect(now[0],[],log,**kw)
                def disk(**kw):
                    order.append('inventory')
                    return inventory([root],du,**kw)
                with patch.object(collector.time,'monotonic',side_effect=lambda:clock[0]), \
                     patch.object(jobs.time,'time',side_effect=lambda:now[0]), \
                     patch.object(collector,'collect',side_effect=crashes), \
                     patch.object(collector,'directory_inventory',side_effect=disk), \
                     patch.object(collector,'disk_wait'),patch.object(collector,'disk_tooling_probe'):
                    for _ in range(6):
                        clock[0]=0
                        collector.main()
                        self.assertLessEqual(clock[0],290)
                        self.assertEqual(order[-2:],['crash','inventory'])
                        now[0]+=3600

    def test_batch_stderr_matrix_never_promotes_incomplete_rows(self):
        root=self.root/'stderr'
        root.mkdir()
        for i in range(128):
            (root/str(i)).mkdir()
        first=str(root/'0')
        cases=[('',False),('du: x: Input/output error',True),
               ('du: x: Permission denied',True),('du: x: Operation not permitted',True),
               ('du: x: Permission denied\ndu: y: Input/output error',True)]
        for stderr,partial in cases:
            with self.subTest(stderr=stderr):
                cache={}
                def run(cmd,**kw):
                    raise subprocess.TimeoutExpired(cmd,kw['timeout'],output=('1\t'+first+'\n').encode(),stderr=stderr.encode())
                _,flags,_=jobs.big_root_inventory(root,run,jobs.time.monotonic()+30,cache)
                self.assertEqual(cache[first]['partial'],partial)
                if partial:
                    # A later pass completes the other rows. The uncertain
                    # completed row must still prevent a complete root.
                    cache.update({str(p):dict(bytes=1024,at=jobs.time.time(),attemptedAt=0,
                        partial=False,isDirectory=True) for p in root.iterdir() if str(p)!=first})
                    _,flags,_=jobs.big_root_inventory(root,run,jobs.time.monotonic()+30,cache)
                    self.assertTrue(flags['partial'])

    def test_setup_cost_does_not_prevent_full_extended_turn(self):
        root=self.root/'setup'
        root.mkdir()
        child=root/'child'
        child.mkdir()
        for overhead in (.004,.02,.2):
            for cached in (False,True):
                with self.subTest(overhead=overhead,cached=cached),patch.dict(os.environ,TOOLLOG_DIR=str(self.root/(str(overhead)+str(cached)))):
                    value=dict(slow=True,attemptedAt=0)
                    if cached:
                        value.update(bytes=1024,at=13600,partial=False)
                    jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{str(child):value}}))
                    clock,now,budgets=[0],[100000],[]
                    original=jobs.big_root_inventory
                    def setup(*args,**kw):
                        clock[0]+=overhead
                        return original(*args,**kw)
                    def run(cmd,**kw):
                        budgets.append(kw['timeout'])
                        clock[0]+=kw['timeout']
                        raise subprocess.TimeoutExpired(cmd,kw['timeout'])
                    with patch.object(jobs.time,'monotonic',side_effect=lambda:clock[0]), \
                         patch.object(jobs.time,'time',side_effect=lambda:now[0]), \
                         patch.object(jobs,'big_root_inventory',side_effect=setup):
                        jobs.directory_inventory([root],run,deadline=150)
                    self.assertIn(60,budgets)
                    self.assertTrue(jobs.read_state('disk-inventory')['childState'][str(root)][str(child)]['limited'])
                    self.assertLessEqual(clock[0],150)

    def test_interruption_in_fresh_query_does_not_replay_reported_gap(self):
        for interrupt_after in range(6):
            with self.subTest(interrupt_after=interrupt_after), \
                 patch.dict(os.environ,TOOLLOG_DIR=str(self.root/str(interrupt_after))):
                jobs.save_state('crashes',dict(unified=9100,unifiedRetry=dict(windowStart=9100,windowEnd=10000,skippedS=82800)))
                completed=[]
                def success(a,b):
                    completed.append((a,b))
                    return {}
                def interrupt(a,b):
                    if len(completed) == interrupt_after:
                        raise SystemExit('fresh query interrupted')
                    return success(a,b)
                with self.assertRaises(SystemExit):
                    collector.collect(17200,[],interrupt)
                state=jobs.read_state('crashes')
                self.assertEqual(state['unified'], completed[-1][1] if completed else 11800)
                if completed:
                    self.assertEqual(state['unifiedRetry'],dict(windowStart=completed[-1][1],windowEnd=17200,skippedS=0))
                collector.collect(17200,[],success)
                rows=[r for p in (self.root/str(interrupt_after)).glob('*.ndjson')
                      for r in map(json.loads,p.read_text().splitlines()) if r['name']=='crash.source']
                self.assertEqual([r['props']['skippedS'] for r in rows],[85500,0])
                self.assertEqual((completed[0][0], completed[-1][1]), (11800,17200))
                self.assertEqual([b for a,b in completed[:-1]], [a for a,b in completed[1:]])
                self.assertNotIn('unifiedRetry',jobs.read_state('crashes'))

    def test_limited_child_is_excluded_from_every_batch_position(self):
        root=self.root/'limited-batch'
        root.mkdir()
        for i in range(128):
            (root/('%03d'%i)).mkdir()
        limited=str(root/'064')
        cache={limited:dict(slow=True,limited=True,attemptedAt=0)}
        now,calls=[10000],[]
        def run(cmd,**kw):
            calls.append(cmd[2:])
            return SimpleNamespace(returncode=0,stderr='',stdout=''.join('1\t'+key+'\n' for key in cmd[2:]))
        with patch.object(jobs.time,'time',side_effect=lambda:now[0]):
            for _ in range(6):
                _,flags,children=jobs.big_root_inventory(root,run,jobs.time.monotonic()+30,cache)
                now[0]+=3600
        self.assertTrue(all(limited not in batch for batch in calls))
        self.assertEqual(len(children),127)
        self.assertEqual(flags['unmeasuredCount'],1)
        self.assertEqual(flags['limitedCount'],1)

    def test_stalled_root_stat_or_listing_preserves_healthy_root_share(self):
        original=jobs.deadline_call
        for source in ('stat','listing'):
            with self.subTest(source=source),patch.dict(os.environ,TOOLLOG_DIR=str(self.root/source)):
                bad,good=self.root/('bad-'+source),self.root/('good-'+source)
                bad.mkdir();good.mkdir()
                child=good/'child'
                child.mkdir()
                clock,calls=[0],[]
                def blocked(deadline,operation,*args,**kw):
                    match=(source=='stat' and getattr(operation,'__self__',None)==bad
                           or source=='listing' and operation==jobs.os.scandir and args[0]==bad)
                    if match:
                        clock[0]=deadline
                        raise jobs.SourceFailure('timeout','fixture stalled I/O')
                    return original(deadline,operation,*args,**kw)
                def run(cmd,**kw):
                    calls.append(cmd[-1])
                    return SimpleNamespace(returncode=0,stderr='',stdout='1\t'+cmd[-1]+'\n')
                with patch.object(jobs,'deadline_call',side_effect=blocked), \
                     patch.object(jobs.time,'monotonic',side_effect=lambda:clock[0]):
                    jobs.directory_inventory([bad,good],run,deadline=150)
                state=jobs.read_state('disk-inventory')
                self.assertIn(str(child),calls)
                self.assertEqual(state['sizes'][str(good)],1024)
                self.assertNotIn(str(good),state['partials'])
                self.assertNotIn(str(bad),state['sizes'])
                self.assertLessEqual(clock[0],150)

    def test_native_hardlink_totals_survive_batch_boundaries_refresh_and_deletion(self):
        size=1024*1024
        for placement in ('same_child','same_batch','cross_batch'):
            with self.subTest(placement=placement):
                root=self.root/placement
                root.mkdir()
                paths=[root/('%03d'%i) for i in range(129)]
                for path in paths:
                    path.mkdir()
                first=paths[0]
                second=first if placement=='same_child' else paths[1 if placement=='same_batch' else 128]
                data=first/'data'
                with data.open('wb') as stream:
                    stream.write(os.urandom(size))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.link(data,second/'alias')
                allocated=data.stat().st_blocks*512
                metadata=max(first.stat().st_blocks,second.stat().st_blocks)*512
                if not allocated or allocated <= metadata:
                    self.skipTest('filesystem reports no physical allocation for fixture data')
                cache={}
                total,flags,_=jobs.big_root_inventory(root,subprocess.run,jobs.time.monotonic()+30,cache)
                self.assertFalse(flags['partial'])
                self.assertGreaterEqual(cache[str(first)]['bytes'],allocated*(2 if first==second else 1))
                self.assertGreaterEqual(cache[str(second)]['bytes'],allocated*(2 if first==second else 1))
                self.assertGreaterEqual(sum(cache[str(p)]['bytes'] for p in {first,second}),2*allocated)
                first_bytes=cache[str(first)]['bytes']
                # Refreshing only the alias child must use exactly the same
                # accounting as its row in the multi-child command.
                cache[str(second)]['at']-=86400
                refreshed,flags,_=jobs.big_root_inventory(root,subprocess.run,jobs.time.monotonic()+30,cache)
                self.assertFalse(flags['partial'])
                self.assertEqual(refreshed,total)
                data.unlink()
                if first!=second:
                    first.rmdir()
                else:
                    cache[str(first)]['at']-=86400
                after,flags,_=jobs.big_root_inventory(root,subprocess.run,jobs.time.monotonic()+30,cache)
                self.assertFalse(flags['partial'])
                self.assertGreaterEqual(cache[str(second)]['bytes'],allocated)
                self.assertEqual(after,total-first_bytes if first!=second else total-allocated)

    def test_old_hardlink_accounting_migrates_without_reporting_growth(self):
        root=self.root/'migration'
        root.mkdir()
        child=root/'child'
        child.mkdir()
        now=jobs.time.time()
        jobs.save_state('disk-inventory',dict(at=now,sizes={str(root):1024},
            childState={str(root):{str(child):dict(bytes=1024,at=now,attemptedAt=now,partial=False)}}))
        calls=[]
        def run(cmd,**kw):
            calls.append(cmd)
            return SimpleNamespace(returncode=0,stderr='',stdout='2\t'+cmd[-1]+'\n')
        with patch.object(jobs,'DIRECTORY_ROOTS',[root]),patch.object(jobs,'storage_probes',return_value={}):
            jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
            jobs.directory_inventory([root],run)
            state=jobs.read_state('disk-inventory')
            self.assertEqual(state['duMode'],'links')
            self.assertEqual(state['sizes'][str(root)],2048)
            self.assertTrue(state['partials'][str(root)]['partial'])
            jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
            self.assertEqual(self.rows('disk.sample')[-1]['props']['count'],0)
            jobs.directory_inventory([root],lambda *a,**k:self.fail('fresh shared entries must be reused'))
            self.assertNotIn(str(root),jobs.read_state('disk-inventory')['partials'])
            jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[])
            self.assertEqual(self.rows('disk.sample')[-1]['props']['count'],0)
        self.assertEqual(len(calls),1)

    def test_mode_migration_blocks_root_and_drop_growth_even_if_sample_misses_transition(self):
        gb=1024**3
        for missed_transition in (False,True):
            with self.subTest(missed_transition=missed_transition),patch.dict(os.environ,TOOLLOG_DIR=str(self.root/('migration-logs'+str(missed_transition)))):
                root=self.root/('native-migration'+str(missed_transition))
                root.mkdir()
                paths=[root/('%03d'%i) for i in range(128)]
                for path in paths:
                    path.mkdir()
                data=paths[0]/'data'
                data.write_bytes(b'0123456789abcdef'*65536)
                os.link(data,paths[1]/'alias')
                legacy=subprocess.run(['/usr/bin/du','-sk',*map(str,paths)],capture_output=True,text=True,check=True)
                measured={key:int(size)*1024 for size,key in (line.split('\t',1) for line in legacy.stdout.splitlines())}
                now=jobs.time.time()
                jobs.save_state('disk-inventory',dict(at=now,sizes={str(root):sum(measured.values())},
                    children={str(root):measured},sourceErrors=0,partials={},
                    childState={str(root):{key:dict(bytes=size,at=now,attemptedAt=now,
                        partial=False,isDirectory=True) for key,size in measured.items()}}))
                statfile=self.root/('stat-file'+str(missed_transition))
                statfile.write_bytes(b'x'*100)
                free=[100]
                def statvfs(volume):
                    return SimpleNamespace(f_bavail=free[0]*gb,f_frsize=1)
                def sample():
                    jobs.disk_sample(self.root,self.root,volumes=(self.root,self.root),paths=[statfile])
                with patch.object(jobs,'DIRECTORY_ROOTS',[root]),patch.object(jobs,'BIG_ROOTS',{root}), \
                     patch.object(jobs,'storage_probes',return_value={}),patch.object(jobs.os,'statvfs',side_effect=statvfs):
                    sample()
                    jobs.directory_inventory([root])
                    if missed_transition:
                        jobs.directory_inventory([root])
                    free[0]=85
                    statfile.write_bytes(b'x'*200)
                    sample()
                rows=[r for p in (self.root/('migration-logs'+str(missed_transition))).glob('*.ndjson')
                      for r in map(json.loads,p.read_text().splitlines())]
                current=[r for r in rows if r['name']=='disk.sample'][-1]['props']
                self.assertEqual(current['count'],1)
                self.assertEqual(current['grower1Path'],str(statfile))
                self.assertNotEqual(current.get('topMover1Path'),str(root))
                drop=[r for r in rows if r['name']=='disk.drop' and r['props']['volume']=='internal'][-1]['props']
                self.assertNotIn('grower1Bytes',drop)
                self.assertFalse(drop['inventoryComplete'])
                state=jobs.read_state('disk')
                self.assertEqual(state['inventoryDuMode'],'links')
                self.assertEqual(state['freeInventory']['internalFreeGb']['duMode'],'links')
