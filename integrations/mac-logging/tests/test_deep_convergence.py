import copy
import json
import os
from pathlib import Path
import plistlib
import select
import signal
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_deep_inventory as support

jobs = support.jobs
deep = support.deep


class ConvergenceTests(unittest.TestCase):
    setUp = support.DeepInventoryTests.setUp
    roots = support.DeepInventoryTests.roots
    runner = support.DeepInventoryTests.runner
    rows = support.DeepInventoryTests.rows

    def test_daily_real_shape_45_minutes_cannot_converge_but_90_can(self):
        counts = [('wt',66), ('t3code-wt',281), ('board-wt',932),
                  ('coord-wt',129), ('crpko-devops/tmp',3091)]
        roots = [Path('/Volumes/ExternalSSD')/name for name,_ in counts]
        topology = {root:[root/('%04d'%i) for i in range(count)] for root,(_,count) in zip(roots,counts)}
        giants = set()
        for root in roots[:4]:
            for child in topology[root][::20]:
                giants.add(child)
                topology[child] = [child/('part%d'%i) for i in range(3)]
        def cost(p):
            if p in giants:
                return 700
            if p.parent in giants:
                return .5
            return 3.4 if p.parent == roots[2] else .034 if p.parent == roots[4] else 1.5
        def listing(path,deadline):
            return [SimpleNamespace(path=str(p),is_dir=lambda **kw:True) for p in topology[Path(path)]],True
        stored = {}
        def read(name):
            return copy.deepcopy(stored.get(name,{}))
        def save(name,value):
            stored[name] = value
        evidence = {}
        for budget in (2700,5400):
            stored.clear()
            with patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(budget))), \
                 patch.object(jobs,'inventory_listing',side_effect=listing), \
                 patch.object(jobs.os,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR,st_blocks=0)), \
                 patch.object(jobs,'read_state',side_effect=read),patch.object(jobs,'save_state',side_effect=save), \
                 patch.object(jobs,'emit'),patch.object(deep,'emit'):
                self.clock[0] = 0
                results = []
                for night in range(3):
                    start = self.clock[0]
                    calls = []
                    before = jobs.read_state('disk-inventory').get('childState', {})
                    known = {key for cache in before.values() for key, v in cache.items() if jobs.inventory_has_timeout(v)}
                    deep.run_pass(roots, self.runner(cost,calls), budget=budget)
                    duration = self.clock[0]-start
                    state = jobs.read_state('disk-inventory')
                    complete = sum(not jobs.inventory_needs_measurement(v,self.now+self.clock[0],root=root_key)
                                   for root_key, cache in state['childState'].items() for v in cache.values())
                    results.append(dict(passNumber=night+1, seconds=duration, complete=complete,
                                        remaining=sum(count for _,count in counts)-complete))
                    self.assertLessEqual(duration,budget+.001)
                    # No raw retry of a known timeout. All its later work is parts.
                    for giant in giants:
                        raw = [cmd for cmd,_ in calls if str(giant) in cmd[2:]]
                        self.assertLessEqual(len(raw),0 if str(giant) in known else 4)
                        self.assertLessEqual(sum(len(cmd)==3 for cmd in raw),0 if str(giant) in known else 3)
                        spent = sum(min(cost(Path(key)),timeout) for cmd,timeout in calls
                                    for key in cmd[2:] if Path(key).parent == giant)
                        self.assertLessEqual(spent,600)
                    if not state['partials']:
                        break
                    self.clock[0] = (night+1)*86400
                evidence[str(budget)] = results
                if budget == 2700:
                    self.assertTrue(state['partials'], '45 min passes cannot fit discovery and refresh within the freshness window')
                else:
                    self.assertFalse(state['partials'])
                    self.assertEqual(complete,4499)
                    self.assertLessEqual(len(results),3)
        print('CONVERGENCE',json.dumps(evidence,sort_keys=True))

    def heavy_daily_shape(self, giant_count, part_seconds=350):
        counts=[('wt',66),('t3code-wt',281),('board-wt',932),
                ('coord-wt',129),('crpko-devops/tmp',3091)]
        roots=[Path('/Volumes/ExternalSSD')/name for name,_ in counts]
        topology={root:[root/('%04d'%i) for i in range(count)] for root,(_,count) in zip(roots,counts)}
        candidates=[p for root in roots[:4] for p in topology[root][::20]]
        # Spread the feasible pair between roots; the stress case uses the
        # entire approximately-five-percent population.
        giants=set(candidates[::max(1,len(candidates)//giant_count)][:giant_count])
        for child in giants:
            topology[child]=[child/('part%d'%i) for i in range(3)]
        def cost(path):
            if path in giants:
                return 3*part_seconds
            if path.parent in giants:
                return part_seconds
            return 3.4 if path.parent==roots[2] else .034 if path.parent==roots[4] else 1.5
        def listing(path,deadline):
            return [SimpleNamespace(path=str(p),is_dir=lambda **kw:True) for p in topology[Path(path)]],True
        stored={}
        evidence=[]
        with patch.object(jobs,'inventory_listing',side_effect=listing), \
             patch.object(jobs.os,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR,st_blocks=0)), \
             patch.object(jobs,'read_state',side_effect=lambda name:copy.deepcopy(stored.get(name,{}))), \
             patch.object(jobs,'save_state',side_effect=lambda name,value:stored.update({name:value})), \
             patch.object(jobs,'emit'),patch.object(deep,'emit'):
            for night in range(3):
                self.clock[0]=night*86400
                start=self.clock[0]
                known={key for cache in stored.get('disk-inventory',{}).get('childState',{}).values()
                       for key,v in cache.items() if jobs.inventory_has_timeout(v)}
                calls=[]
                deep.run_pass(roots,self.runner(cost,calls),budget=5400)
                self.assertLessEqual(self.clock[0]-start,5400)
                state=stored['disk-inventory']
                for giant in giants:
                    part_time=sum(min(cost(Path(key)),timeout) for cmd,timeout in calls
                                  for key in cmd[2:] if Path(key).parent==giant)
                    self.assertLessEqual(part_time,600)
                    if str(giant) in known:
                        self.assertFalse(any(str(giant) in cmd[2:] for cmd,_ in calls))
                previous_parts={key:v.get('at') for cache in stored.get('previous',{}).values()
                                for parent in cache.values() for key,v in parent.get('parts',{}).items()}
                parts_measured=sum(v.get('at')!=previous_parts.get(key) and jobs.number(v.get('at'))
                                   for cache in state['childState'].values() for parent in cache.values()
                                   for key,v in parent.get('parts',{}).items())
                complete=0
                ordinary_remaining={}
                for root in roots:
                    cache=state['childState'][str(root)]
                    ordinary_remaining[root.name]=sum(jobs.inventory_needs_measurement(cache.get(str(p)),self.now+self.clock[0],root=root)
                        for p in topology[root] if p not in giants)
                for root_key, cache in state['childState'].items():
                    for value in cache.values():
                        complete+=not jobs.inventory_needs_measurement(value,self.now+self.clock[0],root=root_key)
                        if 'parts' in value:
                            if value.get('partial') is False:
                                self.assertEqual(value['partsDone'],value['partsTotal'])
                                self.assertEqual(value['at'],min(v['at'] for v in value['parts'].values()))
                                self.assertLess(self.now+self.clock[0]-value['at'],jobs.INVENTORY_PARTS_FRESH_S)
                            else:
                                self.assertNotIn('bytes',value)
                evidence.append(dict(night=night+1,seconds=self.clock[0]-start,complete=complete,
                                     remaining=4499-complete,partsMeasured=parts_measured,
                                     ordinaryRemaining=ordinary_remaining))
                stored['previous']=copy.deepcopy(state['childState'])
        print('HEAVY_CONVERGENCE',json.dumps(dict(giants=len(giants),partSeconds=part_seconds,passes=evidence)))
        return state,evidence,len(giants)

    def test_full_shape_with_two_1050_second_children_completes_in_three_nights(self):
        state,evidence,giants=self.heavy_daily_shape(2)
        self.assertEqual(giants,2)
        self.assertFalse(state['partials'])
        self.assertEqual(evidence[-1]['remaining'],0)
        # Three ordinary sweeps cost <11,950 s. Two 1,050 s giants
        # plus at most 500 s of truncated attempts each leave >1,150 s
        # of the 16,200 s budget for discovery overhead; three do not fit
        # that conservative allocation.
        ordinary=932*3.4+(66+281+129)*1.5+3091*.034-3.4-1.5
        available=3*5400-3*ordinary
        self.assertEqual(int(available/(1050+500)),2)

    def test_full_shape_five_percent_630_second_children_is_capacity_limited(self):
        state,evidence,giants=self.heavy_daily_shape(72,part_seconds=210)
        self.assertEqual(giants,72)
        self.assertGreater(giants*3*210,3*5400)
        self.assertTrue(state['partials'])
        self.assertGreater(evidence[-1]['remaining'],0)
        self.assertTrue(all(row['partsMeasured']>0 for row in evidence))
        self.assertTrue(all(remaining==0 for remaining in evidence[-1]['ordinaryRemaining'].values()))

    def test_parts_checkpoint_kill_and_resume_without_early_total(self):
        root = self.roots([('parts',1)])[0]
        child = root/'0000'
        for name in ('a','b','c'):
            (child/name).mkdir()
        key = str(child)
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            key:dict(timeouts=2,lastTimeoutS=60,lastTimeoutAt=self.now,attemptedAt=self.now,partial=True)}}))
        normal = self.runner(lambda p:1)
        calls = []
        def killed(command,**kwargs):
            calls.append(command[-1])
            if len(calls) == 2:
                raise SystemExit('simulated kill after first parts checkpoint')
            return normal(command,**kwargs)
        with self.assertRaises(SystemExit):
            deep.run_pass([root],killed)
        saved = jobs.read_state('disk-inventory')['childState'][str(root)][key]
        self.assertEqual(saved['partsDone'],1)
        self.assertEqual(saved['partsTotal'],3)
        self.assertNotIn('bytes',saved)
        self.assertTrue(saved['partial'])
        saved_part = copy.deepcopy(saved['parts'][str(child/'a')])
        self.clock[0] += 3600
        calls = []
        deep.run_pass([root],self.runner(lambda p:1,calls))
        final = jobs.read_state('disk-inventory')['childState'][str(root)][key]
        self.assertEqual(final['parts'][str(child/'a')],saved_part)
        self.assertNotIn(str(child/'a'),[key for cmd,_ in calls for key in cmd[2:]])
        self.assertEqual(final['partsDone'],3)
        self.assertEqual(final['bytes'],3072+((child.stat().st_blocks*512+1023)//1024)*1024)
        self.assertFalse(final['partial'])
        self.assertEqual(final['timeouts'],2)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['partsMeasured'],2)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenMeasured'],1)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['bytesMeasured'],final['bytes'])

    def test_three_350_second_parts_converge_on_daily_passes(self):
        root=self.roots([('daily-parts',1)])[0]
        child=root/'0000'
        for name in ('a','b','c'):
            (child/name).mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(child):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
        for night in range(3):
            self.clock[0]=night*86400
            started=self.clock[0]
            calls=[]
            deep.run_pass([root],self.runner(lambda p:350,calls),budget=5400)
            self.assertLessEqual(self.clock[0]-started,600)
            value=jobs.read_state('disk-inventory')['childState'][str(root)][str(child)]
            if night<2:
                self.assertTrue(value['partial'])
                self.assertNotIn('bytes',value)
            else:
                self.assertFalse(value['partial'])
                self.assertEqual(value['partsDone'],3)
                self.assertEqual(value['at'],min(v['at'] for v in value['parts'].values()))
                self.assertFalse(jobs.read_state('disk-inventory')['partials'])
        self.clock[0]=value['at']-self.now+jobs.INVENTORY_PARTS_FRESH_S
        jobs.directory_inventory([root],lambda *a,**kw:self.fail('parts expiry belongs to deep scan'))
        expired=jobs.read_state('disk-inventory')['childState'][str(root)][str(child)]
        self.assertTrue(expired['partial'])
        self.assertNotIn('bytes',expired)
        self.assertEqual(expired['partsDone'],2)
        self.assertEqual(expired['partsTotal'],3)

    def test_parts_freshness_boundary_is_explicit_and_ordinary_entries_stay_daily(self):
        root=self.roots([('freshness',1)])[0]
        child=str(root/'0000')
        entry=SimpleNamespace(path=child)
        for age,expected in ((86400-1,False),(86400,False),(259200-1,False),
                             (259200,True),(259200+1,True)):
            with self.subTest(age=age):
                at=self.now-age
                value=dict(bytes=1024,at=at,attemptedAt=at,partial=False,
                           parts={},partsDone=0,partsTotal=0)
                self.assertEqual(jobs.inventory_needs_measurement(value,self.now),expected)
                self.assertEqual(jobs.inventory_status({child:value},[entry],True,self.now)[1]['partial'],expected)
                if expected:
                    self.assertNotIn('bytes',value)
                    self.assertTrue(value['partial'])
                else:
                    self.assertEqual(value['at'],at)
                self.assertTrue(jobs.inventory_deep_owned(value,self.now))
                ordinary=dict(bytes=1024,at=at,attemptedAt=at,partial=False)
                self.assertEqual(jobs.inventory_needs_measurement(ordinary,self.now),age>=86400)

    def test_daily_parts_cost_matrix(self):
        cases=((1,599,1),(1,600,1),(2,350,2),(3,210,2),(3,350,3),(4,200,2))
        for count,cost,expected_night in cases:
            with self.subTest(count=count,cost=cost):
                root=self.roots([('cost-%d-%d'%(count,cost),1)])[0]
                child=root/'0000'
                for i in range(count):
                    (child/str(i)).mkdir()
                jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
                    str(child):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
                for night in range(expected_night):
                    self.clock[0]=night*86400
                    started=self.clock[0]
                    deep.run_pass([root],self.runner(lambda p:cost),budget=5400)
                    self.assertLessEqual(self.clock[0]-started,600)
                    value=jobs.read_state('disk-inventory')['childState'][str(root)][str(child)]
                    self.assertEqual(value['partial'],night+1<expected_night)
                    if value['partial']:
                        self.assertNotIn('bytes',value)

    def test_legacy_file_parts_markers_keep_ordinary_freshness_and_ownership(self):
        for is_directory in (False,True,None):
            for parts in ({},{'part':dict(bytes=1024,at=self.now,partial=False)}):
                with self.subTest(is_directory=is_directory,parts=bool(parts)):
                    value=dict(bytes=1024,at=self.now-90000,attemptedAt=0,partial=False,
                               parts=copy.deepcopy(parts),partsDone=len(parts),partsTotal=len(parts))
                    if is_directory is not None:
                        value['isDirectory']=is_directory
                    self.assertEqual(jobs.inventory_needs_measurement(value,self.now),is_directory is False)
                    self.assertEqual(jobs.inventory_deep_owned(value,self.now),is_directory is not False)
                    cache={'child':value}
                    jobs.inventory_clean_cache(cache,self.now)
                    if is_directory is False:
                        self.assertNotIn('parts',cache['child'])
                        self.assertNotIn('partsDone',cache['child'])
                        self.assertNotIn('partsTotal',cache['child'])
                        self.assertEqual(cache['child']['at'],self.now-90000)

    def test_hourly_rechecks_parts_expiry_after_peer_work_before_saving(self):
        roots=self.roots([('a-parts',1),('b-slow',1)])[0:2]
        child=roots[0]/'0000'
        (child/'part').mkdir()
        at=self.now-jobs.INVENTORY_PARTS_FRESH_S+1
        parent=dict(bytes=1024,at=at,attemptedAt=0,partial=False,isDirectory=True,
                    parts={str(child/'part'):dict(bytes=1024,at=at,attemptedAt=0,partial=False)},
                    partsDone=1,partsTotal=1)
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{str(child):parent}}))
        jobs.directory_inventory(roots,self.runner(lambda p:2))
        state=jobs.read_state('disk-inventory')
        value=state['childState'][str(roots[0])][str(child)]
        self.assertTrue(value['partial'])
        self.assertNotIn('bytes',value)
        self.assertEqual(value['partsDone'],0)
        self.assertEqual(value['partsTotal'],1)
        self.assertNotIn(str(roots[0]),state['sizes'])
        self.assertFalse(state['children'][str(roots[0])])
        self.assertTrue(state['partials'][str(roots[0])]['partial'])

    def test_ordinary_refresh_precedes_expiry_during_a_parts_turn(self):
        roots=self.roots([('a-ordinary',1),('b-parts',1)])
        child=roots[1]/'0000'
        (child/'part').mkdir()
        ordinary=str(roots[0]/'0000')
        jobs.save_state('disk-inventory',dict(duMode='links',childState={
            str(roots[0]):{ordinary:dict(bytes=1024,at=self.now-86400+10,partial=False)},
            str(roots[1]):{str(child):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:600 if p.name=='part' else 1,calls),budget=600)
        state=jobs.read_state('disk-inventory')
        self.assertEqual(calls[0][0][-1],ordinary)
        self.assertNotIn(str(roots[0]),state['partials'])
        self.assertTrue(state['childState'][str(roots[1])][str(child)]['partial'])

    def test_new_timeout_cannot_take_second_early_part_before_ordinary_peer(self):
        for count in (1,130):
            with self.subTest(batch=count>1):
                roots=self.roots([('a-known-%d'%count,1),('b-new-%d'%count,count),('c-ordinary-%d'%count,1)])
                for root in roots[:2]:
                    (root/'0000'/'part').mkdir()
                jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
                    str(roots[0]/'0000'):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
                (roots[1]/'0000'/'part2').mkdir()
                self.clock[0]=0
                calls=[]
                deep.run_pass(roots,self.runner(lambda p:350 if p.name.startswith('part') else 700
                    if p==roots[1]/'0000' else 1,calls),budget=1200)
                keys=[key for cmd,_ in calls for key in cmd[2:]]
                ordinary_index=keys.index(str(roots[2]/'0000'))
                for root in roots[:2]:
                    self.assertLessEqual(sum(Path(key).parent==root/'0000' for key in keys[:ordinary_index]),1)
                self.assertNotIn(str(roots[1]/'0000'/'part2'),keys)
                state=jobs.read_state('disk-inventory')
                value=state['childState'][str(roots[1])][str(roots[1]/'0000')]
                self.assertEqual((value['partsDone'],value['partsTotal']),(1,2))
                self.assertTrue(value['partial'])
                self.assertNotIn('bytes',value)
                self.assertNotIn(str(roots[2]),state['partials'])

    def test_budget_truncated_probe_does_not_classify_an_ordinary_child_as_slow(self):
        for allowance in (.01,1,14.999,15):
            with self.subTest(allowance=allowance):
                root=self.roots([('probe-%s'%allowance,1)])[0]
                child=str(root/'0000')
                cache={child:dict(bytes=1024,at=self.now-90000,attemptedAt=0,partial=False)}
                self.clock[0]=0
                jobs.big_root_inventory(root,self.runner(lambda p:20),allowance,cache,deep=True,max_batches=1)
                self.assertFalse(cache[child].get('timeouts'))
                self.assertFalse(cache[child].get('probeTimeouts'))
                self.assertFalse(jobs.inventory_deep_owned(cache[child],self.now+self.clock[0]))

    def test_background_runner_reports_effective_probe_allowance_before_cleanup(self):
        for seconds_left,child_seconds,stopped,full in ((15,20,False,False),(15.5,14.75,False,False),
                                                       (16,20,False,True),(30,20,False,True),
                                                       (30,20,True,False)):
            with self.subTest(seconds_left=seconds_left,stopped=stopped):
                root=self.roots([('runner-%s-%s'%(seconds_left,stopped),1)])[0]
                child=str(root/'0000')
                self.clock[0]=0
                killed=[False]
                def communicate(timeout):
                    if killed[0]:
                        return '', ''
                    self.clock[0]+=timeout
                    if self.clock[0]>=child_seconds:
                        return '1\t'+child+'\n', ''
                    raise subprocess.TimeoutExpired('du',timeout)
                process=SimpleNamespace(pid=12345,communicate=communicate,returncode=0)
                def kill(*args):
                    killed[0]=True
                    self.clock[0]+=.5
                runner=deep.BackgroundDu(lambda:stopped and self.clock[0]>0,self.now+seconds_left,42)
                with patch.object(deep.subprocess,'Popen',return_value=process),patch.object(deep.os,'killpg',side_effect=kill):
                    cache={child:dict(elapsedMs=1000, partial=True)}
                    jobs.big_root_inventory(root,runner,seconds_left,cache,deep=True,max_batches=1)
                self.assertFalse(cache[child].get('timeouts'))
                self.assertEqual(cache[child].get('probeTimeouts',0),int(full))
                self.assertEqual(jobs.inventory_deep_owned(cache[child],self.now+self.clock[0]),full)

    def test_batch_timeout_isolates_and_measures_cheap_singles(self):
        root = self.roots([('batch',130)])[0]
        calls = []
        first = [True]
        normal = self.runner(lambda p:.01,calls)
        def run(command,**kwargs):
            if first[0]:
                first[0] = False
                calls.append((command,kwargs['timeout']))
                self.clock[0] += kwargs['timeout']
                raise subprocess.TimeoutExpired(command,kwargs['timeout'])
            return normal(command,**kwargs)
        jobs.save_state('disk-inventory', dict(duMode='links', childState={str(root): {
            str(p): dict(partial=True, elapsedMs=10) for p in root.iterdir()}}))
        deep.run_pass([root],run)
        state = jobs.read_state('disk-inventory')
        self.assertFalse(state['partials'])
        self.assertFalse(state['childState'][str(root)][str(root/'0000')].get('timeouts'))
        singles = [cmd[-1] for cmd,_ in calls if len(cmd)==3]
        self.assertTrue(all(str(root/('%04d'%i)) in singles for i in range(128)))
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['timeouts'],1)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['secondsInTimeouts'],60)

    def test_hourly_ownership_and_old_format_matrix(self):
        root = self.roots([('hourly',6)])[0]
        old = dict(bytes=1024,at=self.now,attemptedAt=1,partial=False)
        forms = [dict(partial=True,parts={},partsDone=0,partsTotal=2),
                 dict(partial=True,timeouts=1,lastTimeoutAt=self.now),
                 dict(bytes=1024,at=self.now-90000,partial=False,timeouts=1,lastTimeoutAt=self.now),
                 old,dict(partial=True,parts={'x':dict(bytes=1024,at=self.now,partial=False)}),
                 dict(bytes=1024,at=self.now-90000,partial=False,parts={},partsTotal=0)]
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(root/('%04d'%i)):copy.deepcopy(v) for i,v in enumerate(forms)}}))
        jobs.directory_inventory([root],lambda *a,**kw:self.fail('deep-owned children must not run hourly'))
        cache = jobs.read_state('disk-inventory')['childState'][str(root)]
        self.assertEqual(cache[str(root/'0003')],old)
        for i in (0,1,2,4,5):
            self.assertTrue(jobs.inventory_deep_owned(cache[str(root/('%04d'%i))],self.now))
        self.assertTrue(jobs.read_state('disk-inventory')['partials'])

    def test_parts_cap_and_fairness_cursor_survive_next_pass(self):
        roots = self.roots([('a',1),('b',1)])
        child = roots[0]/'0000'
        (child/'blocked').mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
            str(child):dict(timeouts=2,lastTimeoutS=60,partial=True,lastTimeoutAt=self.now)}}))
        calls = []
        deep.run_pass(roots,self.runner(lambda p:700 if p.name=='blocked' else 1,calls),budget=600)
        value = jobs.read_state('disk-inventory')['childState'][str(roots[0])][str(child)]
        self.assertNotIn('bytes',value)
        self.assertEqual(value['parts']['%s/blocked'%child]['timeouts'],1)
        self.assertEqual(jobs.read_state('disk-inventory')['deepNextRoot'],str(roots[1]))
        self.clock[0] += 1
        calls = []
        deep.run_pass(roots,self.runner(lambda p:700 if p.name=='blocked' else 1,calls),budget=601)
        self.assertEqual(calls[0][0][-1],str(roots[1]/'0000'))
        self.assertLessEqual(sum(t for cmd,t in calls if cmd[-1]==str(child/'blocked')),600)

    def test_native_parts_empty_directory_files_links_and_denied_listing(self):
        root = self.roots([('native',1)])[0]
        child = root/'0000'
        (child/'file').write_bytes(b'x'*8192)
        os.link(child/'file',child/'hardlink')
        (child/'link').symlink_to(child/'file')
        (child/'empty').mkdir()
        original = support.jobs.time
        # Actual commands need real deadlines rather than the fixture's clock.
        with patch.object(original,'monotonic',side_effect=None,return_value=0):
            expected,_,_ = jobs.du_total(child,subprocess.run,10)
            cache = {str(child):dict(timeouts=2,lastTimeoutS=60,partial=True)}
            entries,listed = jobs.inventory_listing(root,10)
            work = {}
            for _ in range(10):
                if not jobs.inventory_parts(entries[0],subprocess.run,10,cache,None,entries,listed,None,work):
                    break
        self.assertFalse(cache[str(child)]['partial'])
        self.assertEqual(cache[str(child)]['bytes'],expected)
        with patch.object(jobs,'inventory_listing',return_value=([],False)):
            jobs.inventory_parts(entries[0],self.runner(lambda p:1),100,cache,None,entries,True,None,{})
        self.assertTrue(cache[str(child)]['partial'])
        self.assertNotIn('bytes',cache[str(child)])

    def test_sigkill_retains_the_last_parts_checkpoint(self):
        root = self.roots([('sigkill',1)])[0]
        child = root/'0000'
        for name in ('a','b'):
            (child/name).mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(child):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
        script = '''
import signal,sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
import jobs,deep_inventory
jobs.time.time=lambda:1000000
def run(command,**kwargs):
    if command[-1].endswith('/b'):
        print('blocked',flush=True)
        signal.pause()
    return SimpleNamespace(returncode=0,stdout='1\\t'+command[-1]+'\\n',stderr='')
deep_inventory.run_pass([Path(sys.argv[2])],run,budget=30)
'''
        process = subprocess.Popen([sys.executable,'-I','-c',script,str(Path(jobs.__file__).parent),str(root)],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            readable,_,_ = select.select([process.stdout],[],[],10)
            self.assertTrue(readable,'child did not reach its second part')
            self.assertEqual(process.stdout.readline().strip(),'blocked')
            os.kill(process.pid,signal.SIGKILL)
            process.communicate(timeout=10)
            saved = jobs.read_state('disk-inventory')['childState'][str(root)][str(child)]
            self.assertEqual(saved['partsDone'],1)
            self.assertNotIn('bytes',saved)
            calls=[]
            deep.run_pass([root],self.runner(lambda p:1,calls))
            self.assertEqual([cmd[-1] for cmd,_ in calls],[str(child/'b')])
            self.assertFalse(jobs.read_state('disk-inventory')['partials'])
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=10)

    def test_cheap_batches_keep_moving_and_yield_after_four(self):
        roots = [self.root/'a',self.root/'b']
        def listing(path,deadline):
            count = 1024 if path==roots[0] else 1
            return [SimpleNamespace(path=str(path/('%04d'%i)),is_dir=lambda **kw:True)
                    for i in range(count)],True
        calls=[]
        with patch.object(jobs,'inventory_listing',side_effect=listing):
            deep.run_pass(roots,self.runner(lambda p:.01,calls))
        self.assertEqual([Path(cmd[-1]).parent for cmd,_ in calls[:5]],[roots[0]]*4+[roots[1]])
        self.assertFalse(jobs.read_state('disk-inventory')['partials'])

    def test_schedule_and_progress_log_fields(self):
        schedule = Path(deep.__file__).parent/'launchd/com.abdullah.mac-deep-inventory.plist'
        plist = plistlib.loads(schedule.read_bytes())
        self.assertEqual(plist['Nice'],10)
        self.assertEqual(plist['ProcessType'],'Standard')
        self.assertNotIn('LowPriorityIO',plist)
        root=self.roots([('logs',1)])[0]
        deep.run_pass([root],self.runner(lambda p:.01))
        end=self.rows('disk.deep.end')[-1]['props']
        for field in ('timeouts','secondsInTimeouts','childrenDescended','partsMeasured'):
            self.assertEqual(end[field],0)
        self.assertEqual(end['spawnPolicy'],'nice-10-utility')
        self.assertEqual(self.rows('disk.deep.root')[-1]['props']['childrenWithPartsInProgress'],0)
        self.assertEqual(end['partsFreshnessS'],jobs.INVENTORY_PARTS_FRESH_S)

    def test_root_due_to_expire_during_peer_work_is_refreshed_first(self):
        roots=self.roots([('a',1),('b',1)])
        child=str(roots[0]/'0000')
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
            child:dict(bytes=1024,at=self.now-86400+1,attemptedAt=0,partial=False)}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:2,calls))
        self.assertEqual([cmd[-1] for cmd,_ in calls],[child,str(roots[1]/'0000')])
        self.assertFalse(jobs.read_state('disk-inventory')['partials'])

    def test_complete_parts_clear_the_old_parent_permission_hint(self):
        root=self.roots([('permission-hint',1)])[0]
        child=str(root/'0000')
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            child:dict(bytes=4096,at=self.now,attemptedAt=0,partial=True,deniedCount=3,limited=True)}}))
        deep.run_pass([root],self.runner(lambda p:.01))
        state=jobs.read_state('disk-inventory')
        self.assertEqual(state['childState'][str(root)][child]['deniedCount'],0)
        self.assertFalse(state['partials'])

    def test_timeout_at_each_command_boundary_descends_in_the_same_pass(self):
        root=self.roots([('boundary',4)])[0]
        for index in range(4):
            (root/('%04d'%index)/'part').mkdir()
        for index in range(4):
            with self.subTest(command=index+1), patch.dict(os.environ,TOOLLOG_DIR=str(self.logs/str(index))):
                slow=root/('%04d'%index)
                deep.run_pass([root],self.runner(lambda p:70 if p==slow else 1))
                state=jobs.read_state('disk-inventory')
                self.assertFalse(state['partials'])
                self.assertIn('parts',state['childState'][str(root)][str(slow)])

    def test_parts_parent_crossing_freshness_after_completion_gets_another_turn(self):
        roots=self.roots([('a',1),('b',1)])
        child=roots[0]/'0000'
        (child/'a').mkdir()
        (child/'b').mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
            str(child):dict(partial=True,timeouts=2,parts={str(child/'a'):
                dict(bytes=1024,at=self.now-259200+1,attemptedAt=0,partial=False)})}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:2 if p.parent==roots[1] else .1,calls))
        state=jobs.read_state('disk-inventory')
        self.assertFalse(state['partials'])
        self.assertEqual([cmd[-1] for cmd,_ in calls],
                         [str(child/'b'),str(roots[1]/'0000'),str(child/'a')])

    def test_parts_expiring_during_same_root_sibling_work_are_requeued(self):
        root=self.roots([('same-root-expiry',2)])[0]
        first,second=root/'0000',root/'0001'
        for path in (first/'a',first/'b',second/'part'):
            path.mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(first):dict(timeouts=2,lastTimeoutS=60,partial=True,parts={str(first/'a'):
                dict(bytes=1024,at=self.now-jobs.INVENTORY_PARTS_FRESH_S+1,partial=False)}),
            str(second):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
        calls=[]
        deep.run_pass([root],self.runner(lambda p:2 if p==second/'part' else .1,calls),budget=5400)
        self.assertEqual([cmd[-1] for cmd,_ in calls],
                         [str(first/'b'),str(second/'part'),str(first/'a')])
        state=jobs.read_state('disk-inventory')
        self.assertFalse(state['partials'])
        self.assertEqual(state['childState'][str(root)][str(first)]['partsDone'],2)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],0)
        self.assertAlmostEqual(self.clock[0],2.2)

    def test_same_root_expiry_preserves_failed_part_and_budget_guards(self):
        for failure in ('io','cap','listing'):
            with self.subTest(failure=failure):
                self.clock[0]=0
                root=self.roots([('same-root-'+failure,2)])[0]
                first,second=root/'0000',root/'0001'
                for path in (first/'a',first/'b',second/'part'):
                    path.mkdir()
                jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
                    str(first):dict(timeouts=2,lastTimeoutS=60,partial=True,parts={str(first/'a'):
                        dict(bytes=1024,at=self.now-jobs.INVENTORY_PARTS_FRESH_S+1,partial=False)}),
                    str(second):dict(timeouts=2,lastTimeoutS=60,partial=True)}}))
                calls=[]
                normal=self.runner(lambda p:2 if p==second/'part' else 700
                                   if failure=='cap' and p==first/'a' else .1,calls)
                def run(command,**kwargs):
                    result=normal(command,**kwargs)
                    if failure=='io' and command[-1]==str(first/'a'):
                        return SimpleNamespace(returncode=1,stdout=result.stdout,stderr='du: Input/output error')
                    return result
                original=jobs.inventory_listing
                listings=[]
                def listing(path,deadline):
                    if Path(path)==first:
                        listings.append(path)
                        if len(listings)>2:
                            self.fail('a failed or capped refresh must not spin')
                        if failure=='listing' and len(listings)==2:
                            return [],False
                    return original(path,deadline)
                with patch.object(jobs,'inventory_listing',side_effect=listing):
                    deep.run_pass([root],run,budget=5400)
                value=jobs.read_state('disk-inventory')['childState'][str(root)][str(first)]
                self.assertTrue(value['partial'])
                self.assertNotIn('bytes',value)
                self.assertEqual(sum(cmd[-1]==str(first/'a') for cmd,_ in calls),int(failure!='listing'))
                self.assertLessEqual(self.clock[0]-2,600.000001)
                self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],1)
