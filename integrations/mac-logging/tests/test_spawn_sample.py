import ctypes as c
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from host_native import Native,BsdInfo,TaskInfo,ThreadInfo
from spawn_sample import SpawnSampler,Monitor,bucket,offbox_class
from spawn_schema import fields
import host,status,rollup,toollog
from overload_io import Dispatcher

class Fake:
    def __init__(self):
        self.rows={1:dict(pid=1,ppid=0,start=(1,0),comm='parent',status=2)}
        self.cpu=0;self.argv_calls=[];self.thread_calls=[]
    def pids(self,*args):return list(self.rows)
    def bsd(self,pid):
        if pid not in self.rows:raise OSError()
        return self.rows[pid].copy()
    def argv(self,pid):
        self.argv_calls.append(pid)
        return ['python3','/a/offbox.py','wait','run-1122-000001-abcdef12']
    def task(self,pid):return dict(cpuNs=self.cpu,rssBytes=100,running=1)
    def threads(self,pid,deadline,clock):
        self.thread_calls.append(pid);return [(1,4,4)],True
    def child(self,pid=2,start=2,ppid=1):
        self.rows[pid]=dict(pid=pid,ppid=ppid,start=(start,0),comm='child',status=2)

class SpawnTests(unittest.TestCase):
    def setUp(self):
        self.now=0;self.n=Fake();self.s=SpawnSampler(self.n,clock=lambda:self.now,cpu=lambda:0,epoch=0)
    def test_wrap_reuse(self):
        self.n.child(99999);self.s.tick();self.now=5;del self.n.rows[99999];self.n.child(2,3)
        r=self.s.tick();self.assertEqual((r['births'],r['exits']),(1,1))
        self.now=10;self.n.child(2,4);r=self.s.tick()
        self.assertEqual((r['births'],r['exits']),(1,1));self.assertEqual(self.n.argv_calls.count(2),2)
    def test_parent_exit_and_reuse(self):
        self.s.tick();self.now=5;self.n.child();del self.n.rows[1]
        r=self.s.tick();self.assertEqual(r['parents'][0]['parent_start'],(1,0))
        self.n.child(1,100,0);self.n.child(3,3);self.now=10
        r=self.s.tick();self.assertIsNone(next(p for p in r['parents'] if p['ppid']==1)['parent_start'])
    def test_unreadable_not_exit(self):
        self.s.tick();original=self.n.bsd
        self.n.bsd=lambda pid:(_ for _ in ()).throw(OSError())
        self.now=5;self.assertEqual(self.s.tick()['exits'],0)
        self.n.bsd=original;self.now=10;self.assertEqual(self.s.tick()['births'],0)
    def test_budget_and_guard(self):
        original=self.n.bsd
        def slow(pid):self.now+=2;return original(pid)
        self.n.bsd=slow;r=self.s.tick()
        self.assertTrue(r['partial']);self.assertIn('cpu_offbox_budget',r['partialReasons'])
        self.assertTrue(self.s.threads_enabled);self.assertEqual(self.s.thread_limit,300)
        self.assertEqual(r['runnable']['covered'],0)
        self.s.tick();self.assertEqual(self.s.thread_limit,150);self.assertEqual(self.s.interval,5)
    def test_failed_inventory_cost_and_guard(self):
        def fail(*args):self.now+=1.6;raise OSError('unavailable')
        self.n.pids=fail
        m=Monitor(self.s,clock=lambda:self.now)
        first=self.s.tick();m.results.append(first)
        self.assertAlmostEqual(first['wallMs'],1600)
        self.assertTrue(self.s.threads_enabled);self.assertEqual(self.s.thread_limit,300)
        self.assertEqual(self.s.interval,5)
        second=self.s.tick();m.results.append(second)
        self.assertAlmostEqual(second['wallMs'],1600)
        self.assertEqual(self.s.thread_limit,300);self.assertEqual(self.s.interval,15)
        self.now=60;p=m.report()
        self.assertAlmostEqual(p['wallMs'],3200)
        self.assertIn('inventory_unavailable',p['partialReasons'])
    def test_slow_tick_is_not_projected_to_whole_minute(self):
        for wall in (.126,.378,.9):
            self.assertIsNone(self.s.record_cost(wall,.03))
        self.assertEqual(self.s.thread_limit,300);self.assertEqual(self.s.interval,5)
    def test_guard_reduces_to_minimal_pass_before_cadence(self):
        limits=[]
        for _ in range(8):
            for _ in range(2):self.s.record_cost(1.6,.03,thread_wall_ms=self.s.thread_limit)
            limits.append(self.s.thread_limit)
        self.assertEqual(limits,[150,75,37,18,9,4,2,1]);self.assertEqual(self.s.interval,5)
        self.s.record_cost(1.6,.03,thread_wall_ms=1)
        action=self.s.record_cost(1.6,.03,thread_wall_ms=1)
        self.assertEqual((self.s.thread_limit,self.s.interval),(1,15))
        self.assertEqual(action['reason'],'tick_wall');self.assertTrue(self.s.threads_enabled)
    def test_smaller_pass_prioritizes_runnable_then_cpu_gain(self):
        self.n.child(2);self.n.child(3);cpu={1:0,2:0,3:0}
        self.n.task=lambda pid:dict(cpuNs=cpu[pid],rssBytes=1,running=int(pid==2))
        self.s.tick();self.now=5;cpu.update({1:1_000_000_000,3:2_000_000_000})
        self.s.thread_limit=2;self.n.thread_calls=[];r=self.s.tick()
        self.assertEqual(self.n.thread_calls,[2,3]);self.assertEqual(r['runnable']['covered'],2)
        self.assertEqual(r['runnable']['total'],3);self.assertTrue(r['partial'])
        self.assertEqual(r['runnable']['runnable_low_cpu'],1)
    def test_thread_soft_budget_retains_completed_minimal_pass(self):
        self.n.child(2)
        def read(pid,deadline,clock):self.now+=.06;return [(1,4,4)],False
        self.n.threads=read
        for at in (0,5):
            self.now=at;r=self.s.tick()
            self.assertEqual(r['runnable']['covered'],1)
            self.assertEqual(r['runnable']['buckets']['pri<=4'],1)
            self.assertIsNotNone(r['runnable']['runnable_low_cpu'])
            self.assertIn('threads_budget',r['partialReasons'])
    def test_zero_requires_complete_identity_and_cpu_coverage(self):
        # A partial measured pass is useful; an unmeasured remainder cannot
        # establish that there were no runnable candidates anywhere.
        cases=[('empty',[],set(),set(),set(),0),
               ('sleeping',[1,2],set(),set(),set(),0),
               ('one_identity_unreadable',[1,2],{2},set(),set(),None),
               ('all_identities_unreadable',[1,2],{1,2},set(),set(),None),
               ('one_task_unreadable',[1,2],set(),{2},set(),1),
               ('measured_subset',[1,2],{2},set(),{1},1)]
        for name,pids,bsd_unreadable,task_unreadable,running,expected in cases:
            with self.subTest(case=name):
                self.setUp();self.n.child(2)
                bsd=self.n.bsd
                self.n.pids=lambda *args:pids
                def read_bsd(pid):
                    if pid in bsd_unreadable:raise OSError()
                    return bsd(pid)
                def read_task(pid):
                    if pid in task_unreadable:raise OSError()
                    return dict(cpuNs=0,rssBytes=1,running=int(pid in running))
                self.n.bsd=read_bsd;self.n.task=read_task
                r=self.s.tick();result=r['runnable']
                if expected is None:
                    self.assertIsNone(result['buckets']);self.assertIsNone(result['runnable_low_cpu'])
                else:
                    self.assertEqual(result['buckets']['pri<=4'],expected)
                    self.assertIsNotNone(result['runnable_low_cpu'])
                if bsd_unreadable or task_unreadable:self.assertTrue(r['partial'])
    def test_slow_details_reserve_thread_pass(self):
        for stage in ('cpu','argv'):
            with self.subTest(stage=stage):
                self.setUp();self.n.child(2);reads=[]
                if stage=='cpu':
                    def read(pid):
                        reads.append(pid);self.now+=.08
                        return dict(cpuNs=0,rssBytes=1,running=0)
                    self.n.task=read
                else:
                    def read(pid):reads.append(pid);self.now+=.08;return ['other']
                    self.n.argv=read
                r=self.s.tick()
                self.assertEqual(reads,[1]);self.assertTrue(r['partial'])
                self.assertGreater(r['runnable']['covered'],0)
                self.assertIsNotNone(r['runnable']['buckets'])
                self.assertEqual(self.s.interval,5)
                if stage=='cpu':
                    self.assertEqual(r['runnable']['candidateCoverage'],1)
                    self.assertEqual(r['runnable']['cpuUnknown'],1)
                    self.assertIn('cpu_offbox_budget',r['partialReasons'])
    def test_slow_cpu_cannot_starve_new_argv(self):
        def task(pid):
            self.now+=.08
            return dict(cpuNs=0,rssBytes=1,running=1)
        def argv(pid):
            self.n.argv_calls.append(pid)
            return ['codex','app-server'] if pid==1 else ['python3','/a/offbox.py','wait']
        self.n.task=task;self.n.argv=argv
        for i,at in enumerate((0,5,10)):
            self.now=at;self.n.child(i+2,i+2);r=self.s.tick()
            self.assertEqual(len(self.s.labels),len(self.n.rows))
            self.assertEqual(self.s.labels[(1,(1,0))]['family'],'codex app-server')
            self.assertEqual(r['offbox']['wait']['count'],i+1)
            self.assertEqual(r['offbox']['argv-pending']['count'],0)
    def test_phase_costs_and_actual_minute_guard(self):
        original=self.n.bsd
        def bsd(pid):self.now+=.001;return original(pid)
        self.n.bsd=bsd;r=self.s.tick()
        self.assertAlmostEqual(sum(v['wallMs'] for v in r['phaseCosts'].values()),r['wallMs'])
        self.assertGreater(r['phaseCosts']['threads']['wallMs'],0)
        m=Monitor(self.s,clock=lambda:self.now);r['wallMs']=1600;m.results.append(r)
        self.now=60;p=m.report()
        self.assertEqual(p['guardActions'],[])
        self.assertEqual(p['threadLimit'],300);self.assertTrue(p['threadsEnabled'])
        safe=toollog.safe_fields(p,'host.spawn_sample')
        self.assertEqual(safe['phaseCosts'],p['phaseCosts'])
        self.assertEqual(safe['guardActions'],p['guardActions'])
    def test_no_native_read_starts_after_deadline(self):
        for stage in ('task','argv','threads'):
            with self.subTest(stage=stage):
                self.setUp();calls=[];original=self.n.bsd
                def bsd(pid):calls.append(self.now);return original(pid)
                self.n.bsd=bsd
                if stage=='task':
                    def read(pid):self.now=1.6;return dict(cpuNs=0,rssBytes=0,running=1)
                    self.n.task=read
                elif stage=='argv':
                    def read(pid):self.now=1.6;return ['python3','offbox.py','wait']
                    self.n.argv=read
                else:
                    def read(pid,deadline,clock):self.now=1.6;return [(1,4,4)],True
                    self.n.threads=read
                p=self.s.tick()
                self.assertTrue(p['partial']);self.assertTrue(all(at<1.5 for at in calls))
                self.assertEqual(p['runnable']['covered'],0)
    def test_pid_inventory_deadline_between_queries(self):
        from types import SimpleNamespace
        calls=[];n=Native.__new__(Native)
        def read(buf,size):calls.append(buf);self.now=1.6;return 100
        n.proc=SimpleNamespace(proc_listallpids=read)
        with self.assertRaises(TimeoutError):n.pids(1.5,lambda:self.now)
        self.assertEqual(calls,[None])
    def test_durable_context_name_redaction(self):
        for value,expected in [('node','node'),('token=private','[redacted]'),('password=private','[redacted]'),('/private/path','[redacted]')]:
            with self.subTest(value=value),tempfile.TemporaryDirectory() as root:
                d=Dispatcher(lambda *args:True,directory=root)
                d.latest_spawn=dict(top_spawners=[dict(parent_comm=value,child_comms_top3=[dict(comm=value,births=1)])],runnable=dict(top=[dict(comm=value)]))
                with patch('overload_io.evaluate',return_value=({},[dict(event=dict(phase='onset'))])):
                    d.tick({},0)
                state,actions=d.queue.get_nowait();d.process(state,actions)
                # Inspect the first durable write, before successful logging
                # removes the outbox, to prove it never contains raw names.
                seen=[]
                with patch('overload_io.save',side_effect=lambda path,v:seen.append(json.loads(json.dumps(v)))):
                    d.process({},actions)
                sample=seen[0]['outbox'][0]['event']['spawn']
                self.assertEqual(sample['top_spawners'][0]['parent_comm'],expected)
                self.assertEqual(sample['top_spawners'][0]['child_comms_top3'][0]['comm'],expected)
                self.assertEqual(sample['runnable']['top'][0]['comm'],expected)
    def test_bucket_edges(self):
        cases=[(-1,'pri<=4'),(0,'pri<=4'),(4,'pri<=4'),(5,'5-19'),(19,'5-19'),(20,'20-31'),(31,'20-31'),(32,'32-46'),(46,'32-46'),(47,'47+'),(127,'47+')]
        for p,b in cases:
            with self.subTest(priority=p):self.assertEqual(bucket(p),b)
    def test_low_cpu_and_offbox(self):
        self.assertEqual(self.s.tick()['runnable']['cpuUnknown'],1)
        self.now=5;self.n.cpu=20_000_000;r=self.s.tick()
        self.assertEqual(r['runnable']['runnable_low_cpu'],1)
        self.assertEqual(r['offbox']['wait']['cpuDeltaNs'],20_000_000)
        self.assertEqual(r['offbox']['wait']['distinctRunIds'],1)
        self.now=10;self.n.cpu=45_000_000
        self.assertEqual(self.s.tick()['runnable']['runnable_low_cpu'],0);self.assertEqual(self.n.argv_calls,[1])
    def test_unreadable_argv_and_task(self):
        self.n.argv=lambda pid:(_ for _ in ()).throw(OSError())
        self.n.task=lambda pid:(_ for _ in ()).throw(OSError())
        r=self.s.tick()['offbox']['argv-unreadable']
        self.assertEqual((r['count'],r['metricsUnreadable'],r['cpuUnknown']),(1,1,1))
    def test_cold_argv_census_prioritizes_birth_parents(self):
        for pid in range(2,102):self.n.child(pid)
        self.n.child(9998);self.n.rows[9998]['comm']='unresolved'
        def argv(pid):
            return ['codex','app-server'] if pid==9998 else ['other']
        self.n.argv=argv
        m=Monitor(self.s,clock=lambda:self.now)
        m.results.append(self.s.tick())
        self.assertNotIn((9998,(2,0)),self.s.labels)
        self.now=5;self.n.child(10001,3,9998);m.results.append(self.s.tick())
        self.now=60;p=m.report()
        actor=next(p for p in p['top_spawners'] if p['ppid']==9998)
        self.assertEqual(actor['family'],'codex app-server')
    def test_offbox_forms(self):
        cases=[(['python3','/x/offbox.py','wait'],'wait'),
               (['/usr/bin/python3.12','offbox.py','run'],'run'),
               (['python3','-Iu','/x/offbox.py','run'],'run'),
               (['python3','-W','offbox.py','/x/offbox.py','_bg-queue'],'_bg-queue'),
               (['python3','-Woffbox.py','/x/offbox.py','wait'],'wait'),
               (['python3','-X','offbox.py','/x/offbox.py','wait'],'wait'),
               (['python3','-Xoffbox.py','/x/offbox.py','wait'],'wait'),
               (['python3','--check-hash-based-pycs','always','/x/offbox.py','wait'],'wait'),
               (['python3','--check-hash-based-pycs=never','/x/offbox.py','wait'],'wait'),
               (['python3','--','/x/offbox.py','logs'],'other'),
               (['python3','offbox.py','-m','offbox.py'],'other'),
               (['python3','-m','offbox.py','wait'],None),
               (['python3','-moffbox.py','wait'],None),
               (['python3','-Im','offbox.py','wait'],None),
               (['python3','-Imoffbox.py','wait'],None),
               (['python3','-Wignore','-moffbox.py','wait'],None),
               (['python3','-X','dev','-m','offbox.py','wait'],None),
               (['python3','-m','x','offbox.py','wait'],None),
               (['python3','-c','pass','offbox.py','wait'],None),
               (['python3','-Iucpass','offbox.py','wait'],None),
               (['python3','-','offbox.py','wait'],None),
               (['python3','-m'],None),
               (['python3','-W'],None),
               (['python3','--bad-option','offbox.py','wait'],None),
               (['zsh','-c','offbox.py wait'],None),
               (['python3','/x/offbox.py.other','wait'],None),
               (['python3','/x/fake.py','offbox.py','wait'],None)]
        for argv,kind in cases:
            with self.subTest(argv=argv):self.assertEqual(offbox_class(argv)[0],kind)
    def test_module_forms_do_not_stop_monitor_ticks(self):
        from types import SimpleNamespace
        for options in (['-moffbox.py'],['-m','offbox.py'],['-Imoffbox.py'],['-Im','offbox.py']):
            with self.subTest(options=options):
                self.setUp()
                self.n.argv=lambda pid:['python3',*options,'wait'] if pid==1 else ['python3','/x/offbox.py','wait']
                m=Monitor(self.s,clock=lambda:self.now)
                def advance(delay):
                    self.now+=5
                    if len(m.results)==1:self.n.child()
                stop=SimpleNamespace(is_set=lambda:len(m.results)>=2,wait=advance)
                m.loop(stop)
                self.assertEqual(len(m.results),2)
                self.assertEqual(m.results[0]['offbox']['wait']['count'],0)
                self.assertEqual(m.results[1]['offbox']['wait']['count'],1)
                self.assertEqual(m.results[1]['births'],1)
                self.now=60;self.assertEqual(m.report()['ticks'],2)
    def test_cap_sleeping(self):
        for pid in range(2,402):self.n.child(pid)
        r=self.s.tick();self.assertEqual(len(self.n.thread_calls),300)
        self.assertTrue(r['partial']);self.assertEqual(r['runnable']['total'],401)
        self.n.task=lambda pid:dict(cpuNs=0,rssBytes=0,running=0)
        self.now=5;self.assertEqual(self.s.tick()['runnable']['total'],0)
    def test_no_fork_summary_writer(self):
        m=Monitor(self.s,clock=lambda:self.now)
        with patch.object(os,'fork',side_effect=AssertionError('fork')),patch.object(os,'posix_spawn',side_effect=AssertionError('spawn')),patch.object(subprocess,'Popen',side_effect=AssertionError('Popen')),patch.object(subprocess,'run',side_effect=AssertionError('run')):
            m.results.append(self.s.tick());self.n.child();self.now=5;m.results.append(self.s.tick());self.now=60
            p=m.report();self.assertEqual(p['births_per_min'],1);self.assertTrue(p['lower_bound'])
            with tempfile.TemporaryDirectory() as root,patch.dict(os.environ,TOOLLOG_DIR=root):
                host.write_sample('host.spawn_sample',p)
                rows=[json.loads(l) for f in Path(root).glob('*.ndjson') for l in f.read_text().splitlines()]
                self.assertEqual(rows[0]['props']['top_spawners'][0]['births'],1)
                self.assertEqual(rows[0]['props']['runnable']['buckets']['pri<=4'],2)
        self.assertFalse(m.results)
    def test_stalled_native(self):
        m=Monitor(self.s,clock=lambda:self.now);entered=threading.Event();release=threading.Event();stop=threading.Event()
        def pids(*args):entered.set();release.wait();return []
        self.n.pids=pids;worker=threading.Thread(target=m.loop,args=(stop,),daemon=True);worker.start()
        try:
            self.assertTrue(entered.wait(1));self.now=60;p=m.report()
            self.assertTrue(p['partial']);self.assertIn('native_call_in_flight',p['partialReasons']);self.assertIsNone(p['runnable'])
        finally:stop.set();release.set();worker.join(1)
    def test_native_abi(self):
        self.assertEqual(c.sizeof(BsdInfo),136);self.assertEqual(BsdInfo.startSec.offset,120);self.assertEqual(c.sizeof(TaskInfo),96)
        n=Native.__new__(Native)
        def info(pid,flavor,arg,target,size):
            if flavor==3:
                v=c.cast(target,c.POINTER(BsdInfo)).contents;v.pid=pid;v.startSec=20;v.startUsec=30;v.ppid=1;v.comm=b'node'
            elif flavor==4:
                v=c.cast(target,c.POINTER(TaskInfo)).contents;v.totalUser=2**40;v.totalSystem=3;v.resident=100;v.numrunning=1
            elif flavor==6:target[0]=5;return 8
            elif flavor==5:
                v=c.cast(target,c.POINTER(ThreadInfo)).contents;v.runState=1;v.curpri=4;v.priority=20
            return size
        from types import SimpleNamespace
        n.proc=SimpleNamespace(proc_pidinfo=info)
        self.assertEqual(n.bsd(9)['start'],(20,30));self.assertEqual(n.task(9)['cpuNs'],2**40+3)
        self.assertEqual(n.threads(9,10,lambda:0),([(1,4,20)],True))
    def test_schema_status_rollup(self):
        m=Monitor(self.s,clock=lambda:self.now);m.results.append(self.s.tick());self.now=60;p=m.report()
        p['private']='secret';p['top_spawners']=[dict(ppid=1,parent_comm='token=private',births=1)]
        safe=fields(p);self.assertNotIn('private',json.dumps(safe))
        with tempfile.TemporaryDirectory() as root:
            row=dict(tool='mac',kind='event',name='host.spawn_sample',ts='2026-11-22T00:01:00Z',ok=True,props=safe)
            Path(root,'2026-11-22.ndjson').write_text(json.dumps(row)+'\n')
            self.assertEqual(status.report('2026-11-22T00:02:00Z',root)['spawnSample']['ageMin'],1)
            self.assertEqual(rollup.rollup('2026-11-22',root)['spawnSample']['births_per_min'],0)
            self.assertEqual(toollog.safe_fields(dict(spawn=safe),'host.overload')['spawn'],safe)

if __name__=='__main__':unittest.main()
