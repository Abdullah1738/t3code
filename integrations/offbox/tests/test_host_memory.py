"""Admission, hand-back and host-setup proofs using a real copied SQLite DB and fixture cgroups."""
from contextlib import ExitStack
import ast
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import shlex
import sqlite3
import re
import time
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, boatd, SERVER
else:
    from test_boatd import Base, boatd, SERVER

spec = importlib.util.spec_from_file_location('host_memory_setup', SERVER/'host-memory-setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
mem = boatd.boatd_memory
REAL_MEMINFO = mem.meminfo
G = 2**30


class HostMemory(Base):
    def test_meminfo_and_committed_shmem_budget(self):
        p = self.tmp/'meminfo'
        p.write_text('MemTotal: 96468992 kB\nMemAvailable: 73400320 kB\nShmem: 52428800 kB\n'
                     'AnonPages: 26214400 kB\nSUnreclaim: 8388608 kB\nCommitted_AS: 209715200 kB\n')
        info = REAL_MEMINFO(p)
        c = mem.capacity(info, info['MemAvailable'], 12*G, 2*G)
        self.assertEqual(c['shmem'], 50*G)
        self.assertEqual(c['committed_bytes'], 83*G)
        self.assertLess(c['free_bytes'], 0)
        # Virtual commitment is diagnostic only: reserving address space must not serialize healthy runs.
        info.update(Shmem=0, AnonPages=G, SUnreclaim=G)
        self.assertGreater(mem.capacity(info, 70*G, 12*G, 2*G)['free_bytes'], 50*G)

    def test_headroom_outlives_sixty_seconds_and_shmem_is_not_growth_credit(self):
        b = self.box()
        self.cmd(b, age=7200)
        cg = self.tmp/'cg';cg.mkdir();(cg/'memory.stat').write_text(f'anon {G}\nshmem {20*G}\n')
        with patch.object(boatd, 'cg_path', return_value=cg), patch.object(boatd, 'usual_peak', return_value=6*G):
            self.assertEqual(boatd.admitted_bytes(self.con), 5*G)
            # Two commands sharing a box don't promise its whole-box prediction twice.
            self.cmd(b, pid=1002, age=0)
            self.assertEqual(boatd.admitted_bytes(self.con), 5*G)
            (cg/'memory.stat').unlink()
            self.assertEqual(boatd.admitted_bytes(self.con), 6*G)

    def test_shmem_pressure_queues_and_emits_decision_even_with_no_running_commands(self):
        b = self.box();pid = self.cmd(b, status='queued')
        info = dict(MemTotal=92*G, Shmem=55*G, AnonPages=20*G, SUnreclaim=8*G)
        with patch.object(mem, 'meminfo', return_value=info), patch.object(boatd, 'mem_available', return_value=70*G), \
                patch.object(boatd.time, 'sleep', side_effect=RuntimeError('queued')):
            with self.assertRaisesRegex(RuntimeError, 'queued'):
                boatd.admit(self.con,b,pid,'k',io.BytesIO())
        self.assertEqual(self.status(b,pid)['status'],'queued')
        events=[json.loads(l) for f in (self.tmp/'shared-logs').glob('*.ndjson') for l in f.read_text().splitlines()]
        decision=next(e for e in events if e['name']=='admit.decision' and e['kind']=='event')
        self.assertEqual(decision['props']['decision'],'queue')
        self.assertEqual(decision['props']['shmem'],55*G)
        for key in ('mem_available','admitted_bytes','committed_bytes','reserve'):
            self.assertIn(key,decision['props'])

    def test_payload_lookup_works_during_rolling_migration(self):
        cg=self.tmp/'cg';cg.mkdir();legacy=cg/'lxc.payload.bx-test';legacy.mkdir()
        self.assertEqual(mem.payload_path(cg,'bx-test'),legacy)
        nested=cg/mem.PARENT/legacy.name;nested.mkdir(parents=True)
        self.assertEqual(mem.payload_path(cg,'bx-test'),nested)

    def test_parent_budget_counts_current_charge_and_running_headroom(self):
        parent=boatd.CG_ROOT/mem.PARENT;parent.mkdir()
        (parent/'memory.stat').write_text('')
        for high,hard,current,promised,expected in [
                ('max','max',50,2,None), ('max',56,50,2,4),
                (48,56,40,6,2), (48,56,50,0,-2)]:
            with self.subTest(high=high,hard=hard,current=current,promised=promised):
                for key,value in [('high',high),('max',hard),('current',current)]:
                    (parent/('memory.'+key)).write_text(str(value*G if isinstance(value,int) else value))
                actual=mem.payload_capacity(boatd.CG_ROOT,promised*G)
                self.assertEqual(actual['payload_free'],expected*G if expected is not None else None)

    def test_parent_pressure_queues_with_available_host_memory_and_malformed_limit_fails_closed(self):
        b=self.box();pid=self.cmd(b,status='queued')
        parent=boatd.CG_ROOT/mem.PARENT;parent.mkdir()
        (parent/'memory.stat').write_text('')
        for key,value in [('current',50*G),('max',56*G),('high','max')]:
            (parent/('memory.'+key)).write_text(str(value))
        for limit in (str(56*G),'unreadable'):
            with self.subTest(limit=limit), patch.object(boatd,'predicted_peak',return_value=8*G), \
                    patch.object(boatd,'mem_available',return_value=70*G), \
                    patch.object(boatd.time,'sleep',side_effect=RuntimeError('queued')):
                (parent/'memory.max').write_text(limit)
                with self.assertRaisesRegex(RuntimeError,'queued'):
                    boatd.admit(self.con,b,pid,'k',io.BytesIO())
                self.assertEqual(self.status(b,pid)['status'],'queued')

    def test_idle_clean_file_cache_does_not_pin_admission_but_shmem_and_dirty_cache_do(self):
        parent=boatd.CG_ROOT/mem.PARENT;parent.mkdir()
        for key,value in [('current',47*G),('max',56*G),('high',48*G)]:
            (parent/('memory.'+key)).write_text(str(value))
        for stats,credit in [({'file':45,'inactive_file':45},45),
                             ({'file':45,'inactive_file':45,'shmem':20},25),
                             ({'file':45,'inactive_file':45,'file_dirty':3,'file_writeback':2,'file_mapped':4},36),
                             ({'file':45,'active_file':45},45),
                             ({'file':45,'inactive_file':0},0),
                             ({'file':45,'inactive_file':45,'shmem':45},0)]:
            with self.subTest(stats=stats):
                (parent/'memory.stat').write_text(''.join(f'{k} {v*G}\n' for k,v in stats.items()))
                self.assertEqual(mem.payload_capacity(boatd.CG_ROOT,0)['payload_reclaimable'],credit*G)
        (parent/'memory.stat').write_text(f'file {45*G}\ninactive_file {45*G}\n')
        b=self.box();pid=self.cmd(b,status='queued')
        with patch.object(boatd,'mem_available',return_value=70*G),patch.object(boatd,'predicted_peak',return_value=4*G):
            boatd.admit(self.con,b,pid,'k',io.BytesIO())
        self.assertEqual(self.status(b,pid)['status'],'running')

    def test_box_start_holds_shared_setup_lifecycle_fence(self):
        import fcntl
        def execute(*args,**kwargs):
            with (boatd.VAR/'memory-lifecycle.lock').open('a') as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return subprocess.CompletedProcess(args,0,b'',b'')
        with patch.object(boatd.subprocess,'run',side_effect=execute):
            self.saved['incus']('start','bx-fixture')

    def test_tmp_cleanup_fences_active_queued_unknown_person_and_pinned(self):
        b=self.box(name='offbox repo | repository pool');pid=self.cmd(b)
        self.con.execute("UPDATE commands SET run_id='run-a'")
        def cleanup(con,c,result):
            with boatd.box_memory_lock(b):boatd.free_idle_tmp(con,c,result)
        result=dict(status='exited',ended_at=boatd.now())
        with patch.object(boatd,'run_processes',return_value=[]), patch.object(boatd,'ct_exec') as execute:
            for state in ('queued','running'):
                self.cmd(b,pid=1002,status=state)
                cleanup(self.con,self.status(b,pid),result);execute.assert_not_called()
                self.con.execute('DELETE FROM commands WHERE pid=1002')
            for field,value in [('pinned',1),('owner','moni'),('name','personal workspace')]:
                self.con.execute(f'UPDATE boxes SET {field}=?',(value,))
                cleanup(self.con,self.status(b,pid),result);execute.assert_not_called()
                self.con.execute("UPDATE boxes SET pinned=0,owner='ardud',name='offbox repo | repository pool'")
            with patch.object(boatd,'run_processes',return_value=None):
                cleanup(self.con,self.status(b,pid),result);execute.assert_not_called()

    def test_terminal_row_is_published_only_after_cleanup_and_new_dispatch_is_locked(self):
        b=self.box(name='offbox repo | repository pool');pid=self.cmd(b)
        self.con.execute("UPDATE commands SET run_id='run-a'")
        c=self.status(b,pid)
        def execute(box,command,**kw):
            self.assertEqual(self.status(b,pid)['status'],'running')
            import fcntl
            with open(boatd.VAR/'memory-locks'/b,'a') as lk:
                with self.assertRaises(BlockingIOError):fcntl.flock(lk,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertIn("'/tmp','/dev/shm'",shlex.split(command)[-1])
            self.assertIn('keep_prefixes',command)
            return subprocess.CompletedProcess([],0,b'{"bytes": 1234}',b'')
        with patch.object(boatd,'run_processes',return_value=[]),patch.object(boatd,'ct_exec',side_effect=execute):
            boatd._write_command_result(self.con,c,dict(status='exited',exit_code=0,ended_at=boatd.now()),{})
        self.assertEqual(self.status(b,pid)['status'],'exited')
        with patch.object(boatd, 'ct_exec') as again:
            with boatd.box_memory_lock(b):
                boatd.free_idle_tmp(self.con, self.status(b,pid), dict(status='exited'))
            again.assert_not_called()

    def test_confirmed_terminal_settlement_cleans_despite_its_old_hold(self):
        b=self.box(name='offbox repo | repository pool');pid=self.cmd(b)
        held={'interruption':{'stream_state':'reattached','cleanup':'unknown'}}
        self.con.execute("UPDATE commands SET run_id='run-a',metrics=?",(json.dumps(held),))
        self.assertEqual(boatd.held_runs(self.con,b),['run-a'])
        result=dict(status='exited',exit_code=0,ended_at=boatd.now())
        with patch.object(boatd,'run_processes',return_value=[]), \
                patch.object(boatd,'ct_exec',return_value=subprocess.CompletedProcess([],0,b'{"bytes": 1024}',b'')) as execute:
            boatd._write_command_result(self.con,self.status(b,pid),result,{})
        execute.assert_called_once()
        self.assertEqual(boatd.held_runs(self.con,b),[])

    @unittest.skipUnless(sys.platform == 'linux', 'fd mount identities require Linux /proc')
    def test_guest_reaper_preserves_offbox_paths_and_live_held_shmem(self):
        disk=boatd.offbox_disk_space
        root=self.tmp/'shm';root.mkdir();(root/'ordinary').write_bytes(b'x'*8192)
        (root/'offbox-go-repair.lock').touch();(root/'offbox-run').mkdir();(root/'offbox-run'/'receipt').write_text('keep')
        (root/'held').write_text('in use')
        cutoff=time.time()+1
        with patch.object(disk,'held_paths',return_value={str(root/'held')}):
            freed=disk.reap(root,os.getuid(),[],finished_before=cutoff,keep_prefixes=('offbox-','.offbox'),emit=lambda item:None)
        self.assertGreater(freed,0);self.assertFalse((root/'ordinary').exists())
        for name in ('held','offbox-go-repair.lock','offbox-run/receipt'):self.assertTrue((root/name).exists())

    @unittest.skipUnless(sys.platform == 'linux', 'fd mount identities require Linux /proc')
    def test_copied_db_simulation_frees_finished_tmp_and_admits_next_run(self):
        b=self.box(name='offbox simulation | repository pool');pid=self.cmd(b)
        self.con.execute("UPDATE commands SET run_id='simulation'")
        copied=sqlite3.connect(self.tmp/'copied.db',isolation_level=None)
        self.addCleanup(copied.close);self.con.backup(copied);copied.row_factory=sqlite3.Row
        tmp=self.tmp/'guest-tmp';shm=self.tmp/'guest-shm';proc=self.tmp/'guest-proc'
        for path in (tmp,shm,proc):path.mkdir()
        (tmp/'fill').write_bytes(b'x'*1024*1024);(shm/'fill').write_bytes(b'x'*1024*1024)
        (tmp/'offbox-run').mkdir();(tmp/'offbox-run'/'receipt').write_text('retained')
        def guest(box,command,**unused):
            source=shlex.split(command)[-1]
            source=source.replace("('/tmp','/dev/shm')",repr((str(tmp),str(shm))))
            source=source.replace("Path('/proc')",'Path('+repr(str(proc))+')')
            source=source.replace("pwd.getpwnam('user').pw_uid",'os.getuid()')
            return subprocess.run([sys.executable,'-I','-c',source],capture_output=True,timeout=20)
        with patch.object(boatd,'run_processes',return_value=[]),patch.object(boatd,'ct_exec',side_effect=guest):
            boatd._write_command_result(copied,boatd.cmd_row(copied,b,pid),
                dict(status='exited',exit_code=0,ended_at=time.time()+1),{})
        self.assertFalse((tmp/'fill').exists());self.assertFalse((shm/'fill').exists())
        self.assertTrue((tmp/'offbox-run'/'receipt').exists())
        copied.execute("INSERT INTO commands(box_id,pid,command_id,command,status,created_at,kind) "
                       "VALUES (?,1002,'next','true','queued',?,'k')",(b,boatd.now()))
        with patch.object(boatd,'mem_available',return_value=40*G):
            boatd.admit(copied,b,1002,'k',io.BytesIO())
        self.assertEqual(boatd.cmd_row(copied,b,1002)['status'],'running')


class HostSetup(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='host-setup-test-')
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def test_standalone_isolated_cli(self):
        result = subprocess.run([sys.executable, '-I', str(SERVER/'host-memory-setup.py'), '--help'],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_bootstrap_and_vm_stage_server_local_import_dependencies(self):
        dependencies={alias.name+'.py' for node in ast.walk(ast.parse((SERVER/'boatd.py').read_text()))
                      if isinstance(node,ast.Import) for alias in node.names if (SERVER/(alias.name+'.py')).is_file()}
        vm=ast.parse((SERVER/'home/vmtest/run.py').read_text())
        files=next(ast.literal_eval(node.value) for node in vm.body if isinstance(node,ast.Assign)
                   and any(isinstance(t,ast.Name) and t.id=='HOST_FILES' for t in node.targets))
        bootstrap=(SERVER/'bootstrap.zsh').read_text()
        bootstrap_files=re.search(r'\$HERE/\{([^}]*boatd\.py[^}]*)\}',bootstrap)[1].split(',')
        for route,files in [('vm',files),('bootstrap',bootstrap_files)]:
            with self.subTest(route=route):
                self.assertTrue(dependencies <= set(files),dependencies-set(files))

    def fixture(self,boatd_running=False):
        host=setup.Host(Path(tempfile.mkdtemp(dir=self.tmp,prefix='host-')))
        host.write('/sys/fs/cgroup/cgroup.controllers','cpu memory io pids\n')
        host.write('/proc/meminfo','MemTotal: 96468992 kB\n')
        host.write('/sys/module/zfs/parameters/zfs_arc_max',str(16*G))
        profile={'config':{'raw.lxc':'lxc.mount.entry = tmpfs tmp tmpfs size=8G 0 0'}}
        instances=[{'name':'bx-aaaaaaaa','config':{'raw.lxc':'# scratch disk v1'}},
                   {'name':'sv-aabbccddeeff','config':{}}, {'name':'bx-bbbbbbbb','config':{}}]
        calls=[]
        def command(args):
            calls.append(args)
            if args[:2]==['incus','query']:
                return json.dumps(instances if 'instances' in args[2] else profile)
            if args[:2]==['systemctl','show']:
                service=args[2];pid=100+setup.SERVICES.index(service)
                if service=='boatd.service' and not boatd_running:pid=0
                if '--value' in args:return str(pid)
                group=f'/system.slice/{service}' if pid else ''
                return f'MainPID={pid}\nControlGroup={group}\nMemoryMin='+str(minimum[service])+'\n'
            if args[:3]==['incus','profile','set']:
                profile['config']['raw.lxc']=args[-1].split('=',1)[1]
            elif args[:3]==['incus','config','set']:
                next(x for x in instances if x['name']==args[3])['config']['raw.lxc']=args[-1].split('=',1)[1]
            elif args[:3]==['systemctl','set-property','--runtime']:
                if args[3]==mem.PARENT:
                    for item in args[4:]:
                        key,value=item.split('=');name={'MemoryMax':'memory.max','MemoryHigh':'memory.high','MemorySwapMax':'memory.swap.max'}[key]
                        host.write('/sys/fs/cgroup/offbox.slice/'+name,value+'\n')
                else:minimum[args[3]]=134217728
            return ''
        minimum={s:0 for s in setup.SERVICES}
        for i in range(4):host.write(f'/proc/{100+i}/oom_score_adj','0\n')
        host.command=command
        return host,calls,profile,instances

    def test_dry_run_check_apply_and_idempotency(self):
        host,calls,profile,instances=self.fixture()
        plan=host.inspect()
        self.assertEqual((plan['hard'],plan['high']),(56*G,48*G))
        self.assertEqual(len(plan['changes']),7)
        self.assertFalse(any(a[1] in ('set','start','set-property') for a in calls))
        with patch.object(setup,'Host',return_value=host),patch('sys.stdout',new=io.StringIO()):
            self.assertEqual(setup.main(['--dry-run']),0)
            self.assertEqual(setup.main(['--check']),1)
            self.assertEqual(setup.main(['--apply']),0)
            self.assertEqual(setup.main(['--check']),0)
        self.assertIn('lxc.mount.entry',profile['config']['raw.lxc'])
        self.assertIn('# scratch disk v1',instances[0]['config']['raw.lxc'])
        first=(host.path('/var/lib/boatd/host-memory-before.json')).read_bytes()
        host.apply(host.inspect())
        self.assertEqual(first,(host.path('/var/lib/boatd/host-memory-before.json')).read_bytes())
        self.assertFalse(any(a[1] in ('restart','stop') for a in calls))

    def test_legacy_payloads_must_be_drained_and_foreign_placement_is_rejected(self):
        host,calls,profile,instances=self.fixture()
        host.path('/sys/fs/cgroup/lxc.payload.bx-aaaaaaaa').mkdir(parents=True)
        plan=host.inspect()
        with self.assertRaisesRegex(ValueError,'drain and stop'):host.apply(plan)
        self.assertIsNone(host.read('/var/lib/boatd/host-memory-before.json'))
        profile['config']['raw.lxc']='lxc.cgroup.dir = foreign'
        with self.assertRaisesRegex(ValueError,'foreign cgroup placement'):host.inspect()

    def test_rolling_readback_does_not_call_throttled_usage_misconfiguration(self):
        host,calls,_,_=self.fixture();host.apply(host.inspect())
        host.write('/sys/fs/cgroup/offbox.slice/memory.current',str(50*G))
        self.assertEqual(host.inspect()['legacy_payloads'],[])
        self.assertEqual(host.inspect()['runtime_drift'],[])
        with self.assertRaisesRegex(ValueError,'require 0 < high < hard'):
            host.inspect(80*G,70*G)

    def test_lowering_either_limit_requires_usage_below_it(self):
        host,_,_,_=self.fixture();host.apply(host.inspect())
        for current,hard,high,blocked in [(50,49,48,True),(49,49,48,True),
                                           (50,52,48,False),(45,56,44,True),(50,56,48,False)]:
            with self.subTest(current=current,hard=hard,high=high):
                host.write('/sys/fs/cgroup/offbox.slice/memory.current',str(current*G))
                plan=host.inspect(hard*G,high*G)
                self.assertEqual(bool(plan['legacy_payloads']),blocked)
                if blocked:
                    with self.assertRaisesRegex(ValueError,'drain and stop'):host.apply(plan)

    def test_stopped_daemon_can_be_configured_during_a_drained_maintenance_window(self):
        host,_,_,_=self.fixture(boatd_running=True)
        original=host.command
        def stopped(args):
            value=original(args)
            if args[:3]==['systemctl','show','boatd.service']:
                if '--value' in args:return '0'
                return value.replace('MainPID=101','MainPID=0').replace('ControlGroup=/system.slice/boatd.service','ControlGroup=')
            return value
        host.command=stopped
        host.apply(host.inspect())
        self.assertEqual(host.inspect()['runtime_drift'],[])
        self.assertIsNone(host.read('/proc/0/oom_score_adj'))

    def test_live_daemon_or_payload_requires_a_maintenance_drain(self):
        host,_,_,_=self.fixture(boatd_running=True)
        with self.assertRaisesRegex(ValueError,'stop boatd'):host.apply(host.inspect())
        host,_,_,_=self.fixture()
        host.path('/sys/fs/cgroup/offbox.slice/lxc.payload.bx-fixture').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError,'drain and stop all payloads'):host.apply(host.inspect())

    def test_apply_rechecks_before_mutation_and_before_limit_write_under_exclusive_fence(self):
        import fcntl
        for injected in ('late_legacy','late_usage','during_reload'):
            with self.subTest(injected=injected):
                host,calls,_,_=self.fixture();host.apply(host.inspect())
                calls.clear()
                host.write('/sys/fs/cgroup/offbox.slice/memory.current',str(47*G))
                plan=host.inspect(49*G,48*G)
                if injected=='late_legacy':host.path('/sys/fs/cgroup/lxc.payload.bx-late').mkdir()
                if injected=='late_usage':host.write('/sys/fs/cgroup/offbox.slice/memory.current',str(50*G))
                original=host.command
                def command(args):
                    if args[:2]==['systemctl','daemon-reload']:
                        with host.path('/var/lib/boatd/memory-lifecycle.lock').open('a') as lock:
                            with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
                        host.write('/sys/fs/cgroup/offbox.slice/memory.current',str(50*G))
                    return original(args)
                host.command=command
                with self.assertRaisesRegex(ValueError,'drain and stop'):host.apply(plan)
                self.assertFalse(any(a[:4]==['systemctl','set-property','--runtime',mem.PARENT] for a in calls))

    def test_autosized_arc_uses_actual_ceiling(self):
        host,_,_,_=self.fixture();host.write('/sys/module/zfs/parameters/zfs_arc_max','0')
        host.write('/proc/spl/kstat/zfs/arcstats','header\nname type data\nc_max 4 '+str(16*G)+'\n')
        self.assertEqual(host.inspect()['hard'],56*G)

    def test_memory_controller_is_required_before_any_change(self):
        host,_,_,_=self.fixture()
        host.write('/sys/fs/cgroup/cgroup.controllers','cpu io\n')
        with self.assertRaisesRegex(ValueError,'cgroup v2 memory controller'):
            host.inspect()
        self.assertIsNone(host.read('/var/lib/boatd/host-memory-before.json'))
