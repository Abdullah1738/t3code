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
                    complete = sum(not jobs.inventory_needs_measurement(v,self.now+self.clock[0])
                                   for cache in state['childState'].values() for v in cache.values())
                    results.append(dict(passNumber=night+1, seconds=duration, complete=complete,
                                        remaining=sum(count for _,count in counts)-complete))
                    self.assertLessEqual(duration,budget+.001)
                    # No raw retry of a known timeout. All its later work is parts.
                    for giant in giants:
                        raw = [cmd for cmd,_ in calls if str(giant) in cmd[2:]]
                        self.assertLessEqual(len(raw),0 if str(giant) in known else 2)
                        self.assertLessEqual(sum(len(cmd)==3 for cmd in raw),0 if str(giant) in known else 1)
                        spent = sum(min(cost(Path(key)),timeout) for cmd,timeout in calls
                                    for key in cmd[2:] if Path(key).parent == giant)
                        self.assertLessEqual(spent,600)
                    if not state['partials']:
                        break
                    self.clock[0] = (night+1)*86400
                evidence[str(budget)] = results
                if budget == 2700:
                    self.assertTrue(state['partials'], '24 h expiry prevents accumulating a >45 min sweep across nights')
                else:
                    self.assertFalse(state['partials'])
                    self.assertEqual(complete,4499)
                    self.assertLessEqual(len(results),3)
        print('CONVERGENCE',json.dumps(evidence,sort_keys=True))

    def test_parts_checkpoint_kill_and_resume_without_early_total(self):
        root = self.roots([('parts',1)])[0]
        child = root/'0000'
        for name in ('a','b','c'):
            (child/name).mkdir()
        key = str(child)
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            key:dict(timeouts=2,lastTimeoutAt=self.now,attemptedAt=self.now,partial=True)}}))
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
        deep.run_pass([root],run)
        state = jobs.read_state('disk-inventory')
        self.assertFalse(state['partials'])
        self.assertFalse(state['childState'][str(root)][str(root/'0000')].get('timeouts'))
        singles = [cmd[-1] for cmd,_ in calls if len(cmd)==3]
        self.assertTrue(all(str(root/('%04d'%i)) in singles for i in range(128)))
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['timeouts'],1)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['secondsInTimeouts'],60)

    def test_hourly_ownership_and_old_format_matrix(self):
        root = self.roots([('hourly',5)])[0]
        old = dict(bytes=1024,at=self.now,attemptedAt=1,partial=False)
        forms = [dict(partial=True,parts={},partsDone=0,partsTotal=2),
                 dict(partial=True,timeouts=1,lastTimeoutAt=self.now),
                 dict(bytes=1024,at=self.now-90000,partial=False,timeouts=1,lastTimeoutAt=self.now),
                 old,dict(partial=True,parts={'x':dict(bytes=1024,at=self.now,partial=False)})]
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(root/('%04d'%i)):copy.deepcopy(v) for i,v in enumerate(forms)}}))
        jobs.directory_inventory([root],lambda *a,**kw:self.fail('deep-owned children must not run hourly'))
        cache = jobs.read_state('disk-inventory')['childState'][str(root)]
        self.assertEqual(cache[str(root/'0003')],old)
        for i in (0,1,2,4):
            self.assertTrue(jobs.inventory_deep_owned(cache[str(root/('%04d'%i))],self.now))
        self.assertTrue(jobs.read_state('disk-inventory')['partials'])

    def test_parts_cap_and_fairness_cursor_survive_next_pass(self):
        roots = self.roots([('a',1),('b',1)])
        child = roots[0]/'0000'
        (child/'blocked').mkdir()
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
            str(child):dict(timeouts=2,partial=True,lastTimeoutAt=self.now)}}))
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
            cache = {str(child):dict(timeouts=2,partial=True)}
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
            str(child):dict(timeouts=2,partial=True)}}))
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

    def test_root_crossing_freshness_during_peer_work_is_revisited(self):
        roots=self.roots([('a',1),('b',1)])
        child=str(roots[0]/'0000')
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[0]):{
            child:dict(bytes=1024,at=self.now-86400+1,attemptedAt=0,partial=False)}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:2,calls))
        self.assertEqual([cmd[-1] for cmd,_ in calls],[str(roots[1]/'0000'),child])
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
                deep.run_pass([root],self.runner(lambda p:20 if p==slow else 1))
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
                dict(bytes=1024,at=self.now-86400+1,attemptedAt=0,partial=False)})}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:2 if p.parent==roots[1] else .1,calls))
        state=jobs.read_state('disk-inventory')
        self.assertFalse(state['partials'])
        self.assertEqual([cmd[-1] for cmd,_ in calls],
                         [str(child/'b'),str(roots[1]/'0000'),str(child/'a')])
