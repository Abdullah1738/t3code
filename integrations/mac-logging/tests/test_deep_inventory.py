import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import deep_inventory as deep
import jobs


class DeepInventoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.clock = [0.0]
        self.now = 1000000
        for name, value in [('time', lambda: self.now+self.clock[0]), ('monotonic', lambda: self.clock[0])]:
            clock = patch.object(jobs.time, name, side_effect=value)
            clock.start()
            self.addCleanup(clock.stop)

    def roots(self, counts):
        roots = []
        for name, count in counts:
            root = self.root/name
            root.mkdir(parents=True)
            for i in range(count):
                (root/('%04d'%i)).mkdir()
            roots.append(root)
        return roots

    def runner(self, cost, calls=None):
        def run(command, **kwargs):
            if calls is not None:
                calls.append((command, kwargs['timeout']))
            elapsed, rows = 0, []
            for key in command[2:]:
                duration = cost(Path(key))
                if elapsed+duration > kwargs['timeout']:
                    self.clock[0] += kwargs['timeout']
                    raise subprocess.TimeoutExpired(command, kwargs['timeout'], output=''.join(rows).encode())
                elapsed += duration
                rows.append('1\t'+key+'\n')
            self.clock[0] += elapsed
            return SimpleNamespace(returncode=0, stdout=''.join(rows), stderr='')
        return run

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson') for r in map(json.loads, p.read_text().splitlines())
                if r['name'] == name]

    def test_table_shaped_roots_complete_or_leave_exact_remaining_within_budget(self):
        roots = self.roots([('wt',60),('t3code-wt',252),('board-wt',917),('coord-wt',129),('crpko-devops/tmp',3071)])
        total = sum(len(list(root.iterdir())) for root in roots)
        for slow in (False, True):
            with self.subTest(slow=slow), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(slow))):
                self.clock[0] = 0
                calls = []
                if slow:
                    for root in roots:
                        for child in root.iterdir():
                            (child/'blocked').touch()
                deep.run_pass(roots, self.runner(lambda p: 700 if slow else .034, calls), budget=2700)
                state = jobs.read_state('disk-inventory')
                measured = sum('bytes' in v for cache in state['childState'].values() for v in cache.values())
                end = [r for p in (self.logs/str(slow)).glob('*.ndjson')
                    for r in map(json.loads,p.read_text().splitlines()) if r['name']=='disk.deep.end']
                props = end[-1]['props']
                self.assertLessEqual(self.clock[0],2700)
                self.assertEqual(props['childrenRemaining'],total-measured)
                self.assertEqual(props['childrenMeasured'],measured)
                self.assertEqual(props['bytesMeasured'],measured*1024)
                self.assertTrue(all(timeout<=600 for _,timeout in calls))
                if slow:
                    self.assertEqual(props['stopReason'],'budget')
                    self.assertEqual(measured,0)
                    self.assertFalse(state['sizes'])
                else:
                    self.assertEqual(measured,total)
                    self.assertEqual(props['stopReason'],'done')
                    self.assertFalse(state['partials'])
                    self.assertLess(len(calls),110)

    def test_hourly_reuses_fresh_deep_entries_unchanged_until_24_hours(self):
        roots = self.roots([('wt',4),('t3code-wt',130),('board-wt',150),('coord-wt',129)])
        jobs.save_state('disk-inventory',dict(duMode='links',extra='preserve',childState={str(roots[0]):{
            str(roots[0]/'0000'):dict(attemptedAt=0,limited=True,slow=True)}}))
        deep.run_pass(roots,self.runner(lambda p:.034))
        before = jobs.read_state('disk-inventory')
        self.assertFalse(before['childState'][str(roots[0])][str(roots[0]/'0000')].get('limited'))
        finished = self.clock[0]
        for delta in (1,3600,86300):
            self.clock[0] = finished+delta
            jobs.directory_inventory(roots,lambda *a,**kw:self.fail('fresh child must not run du'))
            after = jobs.read_state('disk-inventory')
            self.assertEqual(before['childState'],after['childState'])
            self.assertFalse(after['partials'])
            self.assertEqual(after['extra'],'preserve')
        self.clock[0] = finished+86401
        calls = []
        jobs.directory_inventory(roots,self.runner(lambda p: .01,calls))
        self.assertTrue(calls)

    def test_checkpoint_survives_mid_pass_kill_and_resume(self):
        roots = self.roots([('kill',3)])
        good = self.runner(lambda p:1)
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            if len(calls)==2:
                raise SystemExit('simulated kill')
            return good(command,**kwargs)
        with self.assertRaises(SystemExit):
            deep.run_pass(roots,run)
        state = jobs.read_state('disk-inventory')
        first = str(roots[0]/'0000')
        saved = copy.deepcopy(state['childState'][str(roots[0])][first])
        self.assertEqual(saved['bytes'],1024)
        self.assertTrue(state['partials'][str(roots[0])]['partial'])
        deep.run_pass(roots,good)
        state = jobs.read_state('disk-inventory')
        self.assertEqual(state['childState'][str(roots[0])][first],saved)
        self.assertFalse(state['partials'])
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],0)

    def test_partial_and_limited_selection_and_stale_order(self):
        roots = self.roots([('selection',7)])
        root = roots[0]
        forms = [dict(bytes=1024,at=self.now,partial=False),
                 dict(bytes=1024,at=self.now,partial=True),
                 dict(bytes=1024,at=self.now,partial=False,limited=True),
                 dict(bytes=1024,at=self.now-86401,partial=False),
                 dict(bytes=1024,at=self.now-86400,partial=False),
                 dict(attemptedAt=1),dict(bytes=1024,at=self.now+1,partial=False)]
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
            str(root/('%04d'%i)):dict(v,attemptedAt=v.get('attemptedAt',0)) for i,v in enumerate(forms)}}))
        calls=[]
        deep.run_pass(roots,self.runner(lambda p:1,calls))
        selected=[Path(c[-1]).name for c,_ in calls]
        self.assertEqual(selected,['0006','0005','0003','0004','0001'])
        self.assertIn('parts',jobs.read_state('disk-inventory')['childState'][str(root)][str(root/'0002')])
        self.assertFalse(jobs.read_state('disk-inventory')['partials'])

    def test_timeout_and_permission_partial_never_total_as_complete(self):
        root = self.roots([('partial',3)])[0]
        calls=[]
        (root/'0000'/'blocked').touch()
        normal=self.runner(lambda p:700 if p.name in ('0000','blocked') else 1,calls)
        def run(command,**kwargs):
            if command[-1].endswith('0001'):
                self.clock[0]+=1
                return SimpleNamespace(returncode=1,stdout='2\t'+command[-1]+'\n',stderr='du: private: Permission denied')
            return normal(command,**kwargs)
        deep.run_pass([root],run)
        state=jobs.read_state('disk-inventory')
        self.assertTrue(state['partials'][str(root)]['partial'])
        self.assertEqual(state['sizes'][str(root)],3*1024)
        self.assertNotIn('bytes',state['childState'][str(root)][str(root/'0000')])
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],2)
        self.assertEqual(self.rows('disk.deep.root')[-1]['props']['completedCount'],1)

    def test_hourly_skips_inventory_while_deep_holds_lock_but_collects_crashes(self):
        root=self.roots([('lock',1)])[0]
        jobs.save_state('disk-inventory',dict(duMode='links',sizes={str(root):1024},partials={},
            childState={str(root): {str(root/'0000'): dict(bytes=1024, at=self.now, partial=False)}}))
        with jobs.inventory_lock() as acquired:
            self.assertIsNot(acquired,False)
            with patch.object(collector,'collect') as crash, patch.object(collector,'disk_wait'), \
                 patch.object(collector,'disk_tooling_probe'), patch.object(jobs,'DIRECTORY_ROOTS',[root]), \
                 patch.object(jobs,'du_total',side_effect=AssertionError('locked du')):
                collector.main()
                crash.assert_called_once()
            before=jobs.read_state('disk-inventory')
            deep.run_pass([root],lambda *a,**kw:self.fail('busy deep must exit'))
            self.assertEqual(jobs.read_state('disk-inventory'),before)
        props=self.rows('disk.inventory')[-1]['props']
        self.assertEqual(props['skipReason'],'deep_pass_running')
        self.assertEqual(props['bytes'],1024)
        self.assertEqual(props['rootsComplete'],1)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['skipReason'],'lock_held')

    def test_graceful_stop_checkpoints_current_batch(self):
        root=self.roots([('stop',130)])[0]
        killed=[False]
        normal=self.runner(lambda p:.01)
        def run(command,**kwargs):
            result=normal(command,**kwargs)
            killed[0]=True
            return result
        deep.run_pass([root],run,stopped=lambda:killed[0])
        self.assertEqual(len(jobs.read_state('disk-inventory')['childState'][str(root)]),128)
        end=self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['stopReason'],'killed')
        self.assertEqual(end['childrenRemaining'],2)

    def test_one_oversized_child_does_not_hide_other_roots_or_repeat_in_same_pass(self):
        roots=self.roots([('a-slow',1),('b-slow',1),('c-fast',130)])
        calls=[]
        for root in roots[:2]:
            (root/'0000'/'blocked').touch()
        deep.run_pass(roots,self.runner(lambda p:700 if any(root in p.parents for root in roots[:2]) else .034,calls))
        self.assertEqual(sum(len(command)-2 for command,_ in calls),138)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],2)
        self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenPartial'],2)
        self.assertLess(self.clock[0],2700)
        self.assertEqual(jobs.read_state('disk-inventory')['sizes'][str(roots[2])],130*1024)

    def test_limited_hint_clears_only_on_complete_measurement(self):
        root=self.roots([('hints',1)])[0]
        child=str(root/'0000')
        (root/'0000'/'leaf').touch()
        cases=[('complete',0,'1\t'+child+'\n','',False),
               ('permission',1,'1\t'+child+'\n','du: child: Permission denied',True),
               ('operation',1,'1\t'+child+'\n','du: child: Operation not permitted',True),
               ('io',1,'1\t'+child+'\n','du: child: Input/output error',True),
               ('io-zero',0,'1\t'+child+'\n','du: child: Input/output error',True),
               ('parse',0,'bad\t'+child+'\n','',True),
               ('timeout',None,'','',True)]
        for name,code,output,stderr,keep in cases:
            with self.subTest(name=name):
                jobs.save_state('disk-inventory',dict(duMode='links',childState={str(root):{
                    child:dict(bytes=4096,at=self.now,attemptedAt=0,partial=True,slow=True,limited=True)}}))
                def run(command,**kwargs):
                    if code is None:
                        raise subprocess.TimeoutExpired(command,kwargs['timeout'])
                    return SimpleNamespace(returncode=code,stdout=output.replace(child,command[-1]),stderr=stderr)
                deep.run_pass([root],run)
                value=jobs.read_state('disk-inventory')['childState'][str(root)][child]
                self.assertEqual(value.get('limited',False),keep)
                self.assertEqual(value.get('slow',False),keep)
                self.assertEqual(value['partial'],keep)

    def test_finished_batch_stderr_matrix_preserves_last_good_on_io_errors(self):
        root=self.roots([('batch-errors',128)])[0]
        cases=[(0,'',False,False),
               (0,'du: child: Permission denied',True,False),
               (1,'du: child: Permission denied',True,False),
               (1,'du: child: Operation not permitted',True,False),
               (0,'du: child: Input/output error',True,True),
               (1,'du: child: Input/output error',True,True),
               (0,'du: child: Permission denied\ndu: child: Input/output error',True,True)]
        for code,stderr,partial,failed in cases:
            with self.subTest(code=code,stderr=stderr):
                cache={str(child):dict(bytes=4096,at=self.now-86400,attemptedAt=0,partial=False)
                       for child in root.iterdir()}
                original=copy.deepcopy(cache)
                def run(command,**kwargs):
                    return SimpleNamespace(returncode=code,stdout=''.join('1\t'+key+'\n' for key in command[2:]),stderr=stderr)
                _,status,_=jobs.big_root_inventory(root,run,600,cache,deep=True,max_batches=1)
                self.assertEqual(bool(status['failedCount']),failed)
                self.assertEqual(status['partial'],partial)
                if failed:
                    self.assertEqual(status['completedCount'],0)
                    self.assertEqual({key:(v['bytes'],v['at']) for key,v in cache.items()},
                                     {key:(v['bytes'],v['at']) for key,v in original.items()})
                else:
                    self.assertEqual(status['completedCount'],128)
                    self.assertTrue(all(v['partial']==partial for v in cache.values()))

    def test_persistent_bad_batch_child_does_not_hide_127_healthy_peers(self):
        root=self.roots([('isolate',128)])[0]
        bad=str(root/'0064')
        calls=[]
        def run(command,**kwargs):
            keys=command[2:]
            calls.append(keys)
            self.clock[0]+=.034*len(keys)
            return SimpleNamespace(returncode=0,stdout=''.join('1\t'+key+'\n' for key in keys),
                                   stderr='du: child: Input/output error' if bad in keys else '')
        for _ in range(2):
            deep.run_pass([root],run)
            state=jobs.read_state('disk-inventory')
            cache=state['childState'][str(root)]
            self.assertTrue(all(cache[str(child)]['bytes']==1024 and not cache[str(child)]['partial']
                                for child in root.iterdir() if str(child)!=bad))
            self.assertNotIn('bytes',cache[bad])
            self.assertTrue(cache[bad]['partial'])
            self.assertEqual(self.rows('disk.deep.end')[-1]['props']['childrenRemaining'],1)
            self.clock[0]+=3600
        self.assertEqual(sum(len(keys)>1 for keys in calls),1)
        self.assertTrue(any(keys==[bad] for keys in calls))
        self.assertTrue(any(r['props'].get('source')==bad and not r.get('ok')
                            for r in self.rows('disk.inventory.source')))

    def test_normalizing_untouched_future_entry_is_not_a_partial_attempt(self):
        roots=self.roots([('a-first',1),('z-future',1)])
        jobs.save_state('disk-inventory',dict(duMode='links',childState={str(roots[1]):{
            str(roots[1]/'0000'):dict(bytes=1024,at=self.now+86400,partial=False)}}))
        deep.run_pass(roots,self.runner(lambda p:1),budget=1)
        end=self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['childrenMeasured'],1)
        self.assertEqual(end['childrenPartial'],0)
        self.assertEqual(end['childrenRemaining'],1)

    def test_unreaped_kernel_child_cleanup_is_bounded_and_retains_rows(self):
        stream=Mock()
        process=SimpleNamespace(pid=12345,stdout=stream,stderr=stream)
        def communicate(**kwargs):
            self.clock[0]+=kwargs['timeout']
            raise subprocess.TimeoutExpired('du',kwargs['timeout'],output=b'1\t/fixture/child\n')
        process.communicate=Mock(side_effect=communicate)
        with patch.object(deep.subprocess,'Popen',return_value=process),patch.object(deep.os,'killpg'):
            runner=deep.BackgroundDu(lambda:False,self.now+2,42)
            with self.assertRaises(subprocess.TimeoutExpired) as error:
                runner(['/usr/bin/du','-skl','/fixture/child'],timeout=600,text=True)
        self.assertEqual(error.exception.stdout,b'1\t/fixture/child\n')
        self.assertLessEqual(self.clock[0],2)
        self.assertTrue(all('timeout' in call.kwargs for call in process.communicate.call_args_list))
        self.assertTrue(stream.close.called)

    def test_actual_root_priority_without_touching_the_ssd(self):
        roots=[Path('/fixture/other')]+[Path('/Volumes/ExternalSSD')/name
              for name in reversed(deep.SLOW_ROOTS)]
        def listing(path,deadline):
            return [SimpleNamespace(path=str(path/'child'),is_dir=lambda **kw:True)],True
        calls=[]
        with patch.object(jobs,'inventory_listing',side_effect=listing):
            deep.run_pass(roots,self.runner(lambda p:1,calls))
        self.assertEqual([str(Path(command[-1]).parent) for command,_ in calls],
                         [str(Path('/Volumes/ExternalSSD')/name) for name in deep.SLOW_ROOTS]+['/fixture/other'])

    def test_unavailable_listing_is_explicit_and_untouched_stale_roots_stay_partial(self):
        roots=self.roots([('a-slow',1),('b-unknown',1),('z-stale',1)])
        jobs.save_state('disk-inventory',dict(duMode='links',at=self.now,sizes={str(roots[2]):1024},
            childState={str(roots[2]):{str(roots[2]/'0000'):dict(bytes=1024,at=self.now-86400,partial=False)}}))
        (roots[0]/'0000'/'blocked').touch()
        original=jobs.inventory_listing
        with patch.object(jobs,'inventory_listing',side_effect=lambda p,d:([],False) if p==roots[1] else original(p,d)):
            deep.run_pass(roots,self.runner(lambda p:700),budget=600)
        state=jobs.read_state('disk-inventory')
        self.assertNotIn(str(roots[1]),state['sizes'])
        self.assertTrue(state['partials'][str(roots[1])]['partial'])
        self.assertTrue(state['partials'][str(roots[2])]['partial'])
        end=self.rows('disk.deep.end')[-1]['props']
        self.assertEqual(end['rootsPartial'],1)
        self.assertEqual(end['childrenRemaining'],2)

    def test_background_du_wraps_priority_and_kills_owned_group_retaining_rows(self):
        # communicate's timeout is bounded and the group PID came from this spawn.
        process=SimpleNamespace(pid=12345,returncode=0)
        killed=[False]
        def communicate(**kwargs):
            if not killed[0]:
                killed[0]=True
                raise subprocess.TimeoutExpired('fixture',1)
            return '1\t/fixture/child\n',''
        process.communicate=communicate
        with patch.object(deep.subprocess,'Popen',return_value=process) as popen, \
             patch.object(deep.os,'killpg') as kill:
            runner=deep.BackgroundDu(lambda:killed[0],self.now+2700,42)
            with self.assertRaises(subprocess.TimeoutExpired) as error:
                runner(['/usr/bin/du','-skl','/fixture/child'],timeout=600,text=True)
            self.assertEqual(error.exception.stdout,'1\t/fixture/child\n')
            self.assertEqual(popen.call_args.args[0][:8],['/usr/bin/nice','-n','10','/usr/sbin/taskpolicy','-c','utility','-d','throttle'])
            self.assertEqual(popen.call_args.kwargs['pass_fds'],(42,))
            kill.assert_called_once_with(12345,signal.SIGKILL)


class BackgroundProcessTests(unittest.TestCase):
    def test_real_timeout_reaps_du_group_and_preserves_completed_stdout(self):
        popen=subprocess.Popen
        processes=[]
        def spawn(command,**kwargs):
            process=popen(command[8:],**kwargs)
            processes.append(process)
            return process
        with tempfile.TemporaryDirectory() as directory:
            with (Path(directory)/'lock').open('w') as lock, patch.object(deep.subprocess,'Popen',side_effect=spawn):
                runner=deep.BackgroundDu(lambda:False,deep.time.time()+10,lock.fileno())
                command=[sys.executable,'-c','import signal; print("1\\t/fixture/child",flush=True); signal.pause()']
                with self.assertRaises(subprocess.TimeoutExpired) as error:
                    runner(command,timeout=1,text=True)
                self.assertIn('/fixture/child',error.exception.stdout)
                self.assertEqual(processes[0].poll(),-signal.SIGKILL)
