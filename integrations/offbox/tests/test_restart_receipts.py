"""Restart recovery with missing host runners and retained guest processes."""
import json
import contextlib
import os
from pathlib import Path
import subprocess
import fcntl
import select
import threading
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, boatd, SERVER
else:
    from test_boatd import Base, boatd, SERVER


class RestartReceipts(Base):
    def test_fresh_guest_probe_separates_run_id_and_fence_mode(self):
        for run_id in (None, 'run-fixture'):
            for fence in (False, True):
                with self.subTest(run_id=run_id, fence=fence):
                    b = self.box(bid=f'bx_fresh_{bool(run_id)}_{fence}')
                    p = self.cmd(b, status='queued')
                    self.con.execute('UPDATE commands SET run_id=? WHERE box_id=?', (run_id, b))
                    root = self.tmp / b
                    root.mkdir()
                    def execute(box, command, **kw):
                        return subprocess.run(['bash', '-c', command.replace('/run/boatd', str(root))],
                                              capture_output=True, check=True, timeout=10)
                    with patch.object(boatd, 'ct_exec', side_effect=execute), \
                            patch.object(boatd, 'command_probe', return_value={'pids': []}):
                        result = boatd.guest_command(self.status(b, p), fence=fence)
                    self.assertEqual(result['state'], 'gone' if fence else 'absent')
                    self.assertEqual((root / f'{p}.receipt/fenced').exists(), fence)

    def test_interrupted_output_commit_resumes_without_duplicating_published_bytes(self):
        for cut in ('journal', 'partial-write', 'before-cursor', 'after-cursor'):
            for streams in ('out', 'err', 'both'):
                for writer in ('none', 'note', 'file'):
                    with self.subTest(cut=cut,streams=streams,writer=writer):
                        b=self.box(bid='bx_output_'+cut.replace('-','_')+'_'+streams+'_'+writer); p=self.cmd(b)
                        c=self.status(b,p); d=boatd.cmd_dir(b)
                        payloads={'out':b'once\n', 'err':b'warning\n'}
                        payloads={name:(data if streams in (name,'both') else b'') for name,data in payloads.items()}
                        for name in payloads: (d/f'{p}.{name}').write_bytes(b'host prefix\n')
                        cursor=d/f'{p}.cursor.json'; pending=d/f'{p}.output-pending.json'
                        write_json=boatd.write_json; path_open=Path.open
                        def checkpoint(path,value):
                            if cut=='before-cursor' and path==cursor: raise SystemExit('follower died')
                            write_json(path,value)
                            if (cut=='journal' and path==pending) or (cut=='after-cursor' and path==cursor):
                                raise SystemExit('follower died')
                        class PartialWrite:
                            def __init__(self,file): self.file=file
                            def __enter__(self): return self
                            def __exit__(self,*args): self.file.close()
                            def seek(self,*args): return self.file.seek(*args)
                            def write(self,data):
                                self.file.write(data[:2]); self.file.flush()
                                raise SystemExit('follower died during write')
                        def opening(path,*args,**kwargs):
                            file=path_open(path,*args,**kwargs)
                            return PartialWrite(file) if cut=='partial-write' and args and args[0]=='r+b' else file
                        with self.guest_files(b,p,code=7) as receipt:
                            for name,data in payloads.items(): (receipt/name).write_bytes(data)
                            with patch.object(boatd,'write_json',side_effect=checkpoint), patch.object(Path,'open',opening):
                                with self.assertRaises(SystemExit): boatd.guest_command(c)
                            # These prefixes may already be visible to #217's host-offset reader.
                            seen={name:(d/f'{p}.{name}').read_bytes() for name in payloads}
                            note=b'\noffbox-server: cleanup remains unknown\n' if writer!='none' else b''
                            if writer=='note':
                                boatd._note(b,p,'cleanup remains unknown')
                            elif writer=='file':
                                with (d/f'{p}.err').open('ab') as stream:
                                    boatd.write_stderr(b,p,note,stream)
                            published={name:(d/f'{p}.{name}').read_bytes() for name in payloads}
                            boatd.guest_command(c)
                            boatd.guest_command(c)
                        for name,data in payloads.items():
                            output=(d/f'{p}.{name}').read_bytes()
                            expected=b'host prefix\n'+data+(note if name=='err' else b'')
                            self.assertEqual(output,expected)
                            self.assertTrue(output.startswith(seen[name]))
                            self.assertTrue(output.startswith(published[name]))
                            self.assertEqual(published[name]+output[len(published[name]):],expected)
                        self.assertEqual(json.loads(cursor.read_text()),[len(payloads['out']),len(payloads['err'])])
                        self.assertFalse(pending.exists())

    def test_shared_protection_retains_unsettled_rows_and_cached_live_guests(self):
        for status in ('queued', 'running'):
            with self.subTest(status=status):
                b=self.box(bid='bx_unsettled_'+status); p=self.cmd(b,status=status)
                self.con.execute('INSERT INTO meta VALUES (?,?)', (f'holder_gone:{b}:{p}:1','old proof'))
                snapshot=boatd.box_protection(self.con,b)
                self.assertTrue(snapshot['holds'])
                with self.assertRaisesRegex(boatd.Fail,'box_held'):
                    boatd.queue_cmd(self.con,b,dict(command='true',detached=True),None)
        b=self.box(bid='bx_cached_live'); p=self.cmd(b,status='exited')
        self.con.execute('INSERT INTO meta VALUES (?,?)', (f'holder_gone:{b}:{p}:1','old proof'))
        with patch.object(boatd,'_cg_pids',return_value=[129844]):
            snapshot=boatd.box_protection(self.con,b)
            self.assertTrue(snapshot['holds'])
            with self.assertRaisesRegex(boatd.Fail,'box_held'):
                boatd.require_unprotected(self.con,b,reuse=True)
        with patch.object(boatd,'commands_busy',side_effect=boatd.Fail(503,'incus_failed','shutting down')):
            with self.assertRaises(boatd.Fail):
                boatd.box_protection(self.con,b)
        self.assertEqual(self.status(b,p)['status'],'exited')

    def test_exit_first_observed_by_kill_drain_beats_only_the_synthetic_fallback(self):
        for code in (0,7,141,143):
            for held in (False,True):
                with self.subTest(code=code,held=held):
                    b=self.box(bid=f'bx_late_receipt_{code}_{held}'); p=self.cmd(b)
                    boatd.write_json(boatd.cmd_dir(b)/f'{p}.context.json', {})
                    if held:
                        boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='exited',exit_code=23,
                                         started_at=100,ended_at=110,guest_owned=True))
                    boatd.stage_kill(self.con,b,p,False)
                    with self.guest_files(b,p) as receipt:
                        (receipt/'out').write_bytes(b'last output\n')
                        def cleanup(c):
                            (receipt/'exit').write_text(str(code))
                            return dict(cleanup='clean',leftover_killed=0,remaining=0)
                        with patch.object(boatd,'cleanup_run',side_effect=cleanup):
                            boatd.restore_kill_result(self.con,self.status(b,p),{})
                    row=self.status(b,p)
                    saved=boatd.read_result(b,p,1)
                    self.assertEqual((row['status'],row['exit_code']),('exited',23 if held else code))
                    self.assertFalse(saved.get('synthetic_kill'))
                    self.assertFalse(json.loads(row['metrics']).get('kill_synthetic'))
                    self.assertEqual((boatd.cmd_dir(b)/f'{p}.out').read_bytes(),b'last output\n')
                    if held: self.assertEqual(row['ended_at'],110)

    def test_guest_probe_holds_result_lock_through_cursor_checkpoint(self):
        b=self.box(); p=self.cmd(b); c=dict(self.status(b,p))
        entered,release=threading.Event(),threading.Event()
        errors=[]
        def execute(*args,**kwargs):
            entered.set()
            if not release.wait(10): raise AssertionError('probe was not released')
            return subprocess.CompletedProcess([],0,b'{"state":"alive","stdout":"b25jZQ=="}')
        def probe():
            try: boatd.guest_command(c)
            except BaseException as error: errors.append(error)
        with patch.object(boatd,'ct_exec',side_effect=execute):
            thread=threading.Thread(target=probe); thread.start()
            try:
                self.assertTrue(entered.wait(10),'probe did not start')
                with (boatd.cmd_dir(b)/f'{p}.settle.lock').open('a') as owner:
                    with self.assertRaises(BlockingIOError): fcntl.flock(owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:
                release.set(); thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[])
        self.assertEqual((boatd.cmd_dir(b)/f'{p}.out').read_bytes(),b'once')
        self.assertEqual(json.loads((boatd.cmd_dir(b)/f'{p}.cursor.json').read_text()),[4,0])
        boatd.stage_kill(self.con,b,p,False)
        boatd.restore_kill_result(self.con,self.status(b,p),{})
        with patch.object(boatd,'guest_command',side_effect=AssertionError('probe after exit')):
            boatd.follow_guest(self.con,c)

    def test_legacy_receipts_hold_unknown_cleanup_and_stop_signal_leftovers(self):
        for direct in (False,True):
            for code in (0,7,141,143):
                for pids in (None,[],[129844]):
                    with self.subTest(direct=direct,code=code,pids=pids):
                        b=self.box(bid=f'bx_legacy_cleanup_{direct}_{code}_{pids}'); p=self.cmd(b)
                        view=dict(readable=True,pids=pids,box_rc=code,marker={'pid':42},join_verified=pids is not None)
                        self.f.guests[b,p]={'state':'exited','exit_code':code,'legacy':True} if direct else {'state':'gone'}
                        cleanup=dict(cleanup='unknown' if pids is None else 'stopped' if pids else 'clean',
                                     leftover_killed=None if pids is None else len(pids),remaining=None if pids is None else 0)
                        with patch.object(boatd,'command_probe',return_value=view), \
                                patch.object(boatd,'_cg_pids',return_value=pids or []), \
                                patch.object(boatd,'cleanup_run',return_value=cleanup) as clean:
                            boatd.settle_cmd(self.con,self.status(b,p))
                        waiting=pids is None or (pids and code < 128)
                        if waiting:
                            self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('running',None))
                            self.assertTrue(boatd.commands_busy(self.con,b))
                            self.assertTrue(boatd.held_runs(self.con,b))
                            with patch.object(boatd,'command_probe',return_value={**view,'pids':[]}), \
                                    patch.object(boatd,'cleanup_run',return_value=dict(cleanup='clean',leftover_killed=0,remaining=0)):
                                boatd.settle_cmd(self.con,self.status(b,p))
                        elif pids and code > 128:
                            clean.assert_called_once()
                        row=self.status(b,p)
                        self.assertEqual((row['status'],row['exit_code']),
                                         ('interrupted',94) if code > 128 else ('exited',code))

    @contextlib.contextmanager
    def guest_files(self, box, pid, *, alive=False, code=None):
        root = self.tmp / box
        receipt = root / f'{pid}.receipt'
        receipt.mkdir(parents=True)
        if alive:
            ticks = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]
            (receipt / 'pid').write_text(f'{os.getpid()} {ticks}')
        if code is not None:
            (receipt / 'exit').write_text(str(code))
        def execute(box, command, **kw):
            return subprocess.run(['bash', '-c', command.replace('/run/boatd', str(root))],
                                  input=kw.get('input'), capture_output=True, check=True, timeout=10)
        with patch.object(boatd, 'ct_exec', side_effect=execute):
            yield receipt

    def test_missing_follower_is_replaced_after_spawn_failure_or_follower_death(self):
        for failed_spawn in (False, True):
            with self.subTest(failed_spawn=failed_spawn):
                b = self.box(bid=f'bx_follower_{failed_spawn}'); p = self.cmd(b)
                with self.guest_files(b, p, alive=True) as receipt:
                    (receipt / 'out').write_bytes(b'before restart\n')
                    self.f.spawn_error = 'systemd unavailable' if failed_spawn else None
                    if failed_spawn:
                        with self.assertRaises(boatd.Fail): boatd.settle_cmd(self.con, self.status(b, p))
                    else:
                        self.assertEqual(boatd.settle_cmd(self.con, self.status(b, p)), 'reattached')
                    self.f.spawn_error = None
                    self.f.active_units.clear()
                    # Include an old interruption field so a modern result cannot enter legacy recovery.
                    saved = boatd.read_result(b, p, 1)
                    saved['interruption'] = json.loads(self.status(b, p)['metrics'])['interruption']
                    boatd.write_json(boatd.result_path(b, p), saved)
                    (receipt / 'out').write_bytes(b'before restart\nafter follower loss\n')
                    self.assertEqual(boatd.settle_cmd(self.con, self.status(b, p)), 'reattached')
                    self.assertTrue(self.f.active_units)
                    self.f.active_units.clear()
                    (receipt / 'out').write_bytes(b'before restart\nafter follower loss\nfinished\n')
                    (receipt / 'exit').write_text('7')
                    self.assertEqual(boatd.settle_cmd(self.con, self.status(b, p)), 'exited-while-down')
                self.assertEqual(self.status(b, p)['exit_code'], 7)
                self.assertEqual((boatd.cmd_dir(b) / f'{p}.out').read_bytes(),
                                 b'before restart\nafter follower loss\nfinished\n')
                self.assertFalse([c for c in self.f.calls if c[0] == 'exec' and 'nohup' in c[-1]])

    def test_gone_and_exited_commands_drain_all_retained_stdout_and_stderr(self):
        for code in (None, 7):
            with self.subTest(code=code):
                b = self.box(bid=f'bx_drain_{code}'); p = self.cmd(b)
                output, error = b'x' * (2 * 262144 + 91), b'e' * (3 * 262144 + 17)
                with self.guest_files(b, p, code=code) as receipt:
                    (receipt / 'out').write_bytes(output)
                    (receipt / 'err').write_bytes(error)
                    # Either the reaper or an existing follower must finish the same drain.
                    if code is None:
                        boatd.settle_cmd(self.con, self.status(b, p))
                    else:
                        boatd.follow_guest(self.con, self.status(b, p))
                self.assertEqual(self.status(b, p)['exit_code'], 94 if code is None else code)
                self.assertEqual((boatd.cmd_dir(b) / f'{p}.out').read_bytes(), output)
                self.assertTrue((boatd.cmd_dir(b) / f'{p}.err').read_bytes().startswith(error))

    def test_kill_drains_output_and_keeps_a_real_exit_that_arrived_first(self):
        for code in (None, 0, 7):
            with self.subTest(code=code):
                b = self.box(bid=f'bx_kill_drain_{code}'); p = self.cmd(b)
                boatd.write_json(boatd.cmd_dir(b) / f'{p}.context.json', {})
                output, error = b'x' * 300000, b'e' * 600000
                with self.guest_files(b, p, code=code) as receipt:
                    (receipt / 'out').write_bytes(output)
                    (receipt / 'err').write_bytes(error)
                    boatd.stage_kill(self.con, b, p, False)
                    cleanup = dict(cleanup='clean', leftover_killed=0, remaining=0, box_rc=code)
                    with patch.object(boatd, 'cleanup_run', return_value=cleanup):
                        boatd.follow_guest(self.con, self.status(b, p))
                self.assertEqual(self.status(b, p)['exit_code'], 143 if code is None else code)
                self.assertEqual((boatd.cmd_dir(b) / f'{p}.out').read_bytes(), output)
                self.assertEqual((boatd.cmd_dir(b) / f'{p}.err').read_bytes(), error)

    def test_kill_drain_incus_error_keeps_the_row_until_output_can_be_read(self):
        b = self.box(); p = self.cmd(b)
        boatd.write_json(boatd.cmd_dir(b) / f'{p}.context.json', {})
        boatd.stage_kill(self.con, b, p, False)
        cleanup = dict(cleanup='clean', leftover_killed=0, remaining=0)
        with patch.object(boatd, 'cleanup_run', return_value=cleanup):
            with patch.object(boatd, 'ct_exec', side_effect=boatd.Fail(500, 'incus_failed', 'Incus is shutting down')):
                with self.assertRaises(boatd.Fail): boatd.follow_guest(self.con, self.status(b, p))
            self.assertEqual((self.status(b, p)['status'], self.status(b, p)['exit_code']), ('running', None))
            self.assertTrue(boatd.commands_busy(self.con, b))
            with self.guest_files(b, p) as receipt:
                (receipt / 'out').write_bytes(b'last output\n')
                boatd.follow_guest(self.con, self.status(b, p))
        self.assertEqual(self.status(b, p)['exit_code'], 143)
        self.assertEqual((boatd.cmd_dir(b) / f'{p}.out').read_bytes(), b'last output\n')

    def test_legacy_signal_receipts_keep_transport_interruption_classification(self):
        for direct_client_receipt in (False, True):
            for code in (0, 7, 141, 143):
                with self.subTest(client=direct_client_receipt, code=code):
                    b = self.box(bid=f'bx_legacy_{direct_client_receipt}_{code}'); p = self.cmd(b)
                    view = dict(readable=True, pids=[], box_rc=code, marker={'pid':42, 'cgroup_joined':True})
                    self.f.guests[b, p] = {'state':'exited', 'exit_code':code, 'legacy':True} if direct_client_receipt else {'state':'gone'}
                    with patch.object(boatd, 'command_probe', return_value=view):
                        boatd.settle_cmd(self.con, self.status(b, p))
                    row = self.status(b, p)
                    self.assertEqual((row['status'], row['exit_code']),
                                     ('interrupted', 94) if code in (141, 143) else ('exited', code))
                    if code in (141, 143):
                        info = json.loads(row['metrics'])['interruption']
                        self.assertEqual((info['box_rc'], info['cleanup'], info['retry']), (code, 'clean', False))
        # A detached wrapper's own receipt is independent of an Incus stream's signal exit.
        b = self.box(bid='bx_modern_sigpipe'); p = self.cmd(b)
        self.f.guests[b, p] = {'state':'exited', 'exit_code':141}
        boatd.settle_cmd(self.con, self.status(b, p))
        self.assertEqual((self.status(b, p)['status'], self.status(b, p)['exit_code']), ('exited', 141))

    def test_wrapper_killed_after_claim_releases_initialization_ownership(self):
        root=self.tmp/'guest-crashed-init'; root.mkdir()
        os.mkfifo(root/'gate')
        wrapper=(SERVER/'boatd-wrap').read_text().replace('/run/boatd/',str(root)+'/')
        wrapper=wrapper.replace('mkdir -m 700 "$receipt" || exit 98',
                                'mkdir -m 700 "$receipt" || exit 98\necho initializing\nread -r gate < '+str(root/'gate'))
        process=subprocess.Popen(['bash','-c',wrapper,'boatd-wrap','1001',str(root)],
                                 stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        self.addCleanup(process.stdout.close)
        self.addCleanup(process.stderr.close)
        self.assertTrue(select.select([process.stdout],[],[],10)[0],'wrapper never claimed receipt')
        self.assertEqual(process.stdout.readline(),b'initializing\n')
        process.kill(); process.wait(timeout=10)
        self.assertFalse((root/'1001.receipt/pid').exists())
        b=self.box(); p=self.cmd(b,retry=1)
        def guest_exec(box,command,**kw):
            return subprocess.run(['bash','-c',command.replace('/run/boatd',str(root))],capture_output=True,check=True,timeout=10)
        with patch.object(boatd,'ct_exec',side_effect=guest_exec):
            self.assertEqual(boatd.reconcile(self.con)['interrupted'],1)
        self.assertEqual(self.status(b,p)['exit_code'],94)
        self.assertEqual(self.f.spawned,[])

    def test_abandoned_initialization_receipts_settle_without_blocking_reconcile(self):
        for i, marker in enumerate((None, '', '123', '123 bad-ticks', 'not-a-pid 123', '2147483647 123', 'pid.tmp')):
            with self.subTest(marker=marker):
                root=self.tmp/f'guest-init-{i}'; root.mkdir()
                receipt=root/'1001.receipt'; receipt.mkdir()
                if marker is not None:
                    (receipt/('pid.tmp' if marker=='pid.tmp' else 'pid')).write_text('123' if marker=='pid.tmp' else marker)
                b=self.box(bid=f'bx_init{i}'); p=self.cmd(b,retry=1)
                def guest_exec(box,command,**kw):
                    command=command.replace('/run/boatd',str(root))
                    return subprocess.run(['bash','-c',command],input=kw.get('input'),capture_output=True,check=True,timeout=10)
                with patch.object(boatd,'ct_exec',side_effect=guest_exec), patch.object(boatd,'_cg_pids',return_value=[]):
                    self.assertEqual(boatd.reconcile(self.con)['interrupted'],1)
                    self.assertEqual(boatd.reconcile(self.con)['interrupted'],0)
                self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('interrupted',94))
                self.assertEqual(self.f.spawned,[])

    def test_live_initialization_owner_is_not_settled_until_it_disappears(self):
        for receipt_created in (False,True):
            with self.subTest(receipt_created=receipt_created):
                root=self.tmp/f'guest-initializing-{receipt_created}'; root.mkdir()
                if receipt_created: (root/'1001.receipt').mkdir()
                b=self.box(bid=f'bx_init_live{receipt_created}'); p=self.cmd(b,retry=1)
                def guest_exec(box,command,**kw):
                    return subprocess.run(['bash','-c',command.replace('/run/boatd',str(root))],
                                          input=kw.get('input'),capture_output=True,check=True,timeout=10)
                with (root/'1001.lock').open('w') as owner, patch.object(boatd,'ct_exec',side_effect=guest_exec):
                    fcntl.flock(owner,fcntl.LOCK_EX)
                    with self.assertRaises(boatd.Fail): boatd.reconcile(self.con)
                    self.assertEqual(self.status(b,p)['status'],'running')
                    # A settled row cannot hide a live initializer before its receipt directory exists.
                    self.con.execute("UPDATE commands SET status='exited',exit_code=1 WHERE box_id=?",(b,))
                    self.assertTrue(boatd.commands_busy(self.con,b))
                    self.con.execute("UPDATE commands SET status='running',exit_code=NULL WHERE box_id=?",(b,))
                    fcntl.flock(owner,fcntl.LOCK_UN)
                    self.assertEqual(boatd.reconcile(self.con)['interrupted'],1)
                self.assertEqual(self.status(b,p)['exit_code'],94)

    def test_live_children_retaining_the_lock_are_reattached_when_wrapper_pid_is_gone(self):
        b=self.box(); p=self.cmd(b,retry=1)
        command_dir=self.tmp/'cgroup'/'boatd'/str(p); command_dir.mkdir(parents=True)
        (command_dir/'cgroup.procs').write_text('129844\n')
        with patch.object(boatd,'cg_path',return_value=command_dir.parents[1]), \
                patch.object(boatd,'ct_exec',return_value=subprocess.CompletedProcess([],0,b'{"state":"unknown"}')):
            self.assertEqual(boatd.reconcile(self.con)['reattached'],1)
        self.assertEqual(self.status(b,p)['status'],'running')
        self.assertEqual(self.status(b,p)['attempt'],1)


    def test_new_command_updates_old_box_wrapper_atomically_before_launch(self):
        b=self.box(); p=self.cmd(b,status='queued')
        def admit(con,bid,pid,*args):
            con.execute("UPDATE commands SET status='running',started_at=? WHERE box_id=? AND pid=?",(boatd.now(),bid,pid))
            return 0
        def complete(con,c,**kw): boatd.record_guest(con,c,{'state':'exited','exit_code':0})
        with patch.object(boatd,'guest_command',return_value={'state':'absent'}), \
                patch.object(boatd,'admit',side_effect=admit), patch.object(boatd,'ct_exec') as execute, \
                patch.object(boatd,'follow_guest',side_effect=complete):
            boatd.run_cmd(b,p)
        calls=execute.call_args_list
        update=next(i for i,c in enumerate(calls) if '.boatd-wrap-' in c.args[1])
        launch=next(i for i,c in enumerate(calls) if 'nohup' in c.args[1])
        self.assertLess(update,launch)
        self.assertIn('mv -f',calls[update].args[1])
        self.assertEqual(calls[update].kwargs['input'],(SERVER/'boatd-wrap').read_bytes())
        metrics=json.loads(self.status(b,p)['metrics'])
        self.assertEqual(metrics['host_boxes'],{'start':1,'end':1})

    def test_pool_run_rechecks_all_command_kinds_under_transaction(self):
        for i,(status,sync) in enumerate((('queued',0),('running',0),('queued',1),('running',1))):
            with self.subTest(status=status,sync=sync):
                b=self.box(bid=f'bx_race{i}'); p=self.cmd(b,status=status)
                self.con.execute('UPDATE commands SET sync=? WHERE box_id=? AND pid=?',(sync,b,p))
                with patch.object(boatd,'commands_busy',return_value=False), \
                        patch.object(boatd,'require_unprotected',return_value={}):
                    with self.assertRaises(boatd.Fail) as error:
                        boatd.start_cmd(self.con,b,{'command':'true','detached':True,'meta':{'run_id':'new-run'}})
                self.assertEqual(error.exception.code,'commands_busy')
                self.assertFalse(self.con.in_transaction)

    def test_bookkeeping_failure_after_launch_never_records_failed_to_start(self):
        b=self.box(); p=self.cmd(b,status='queued')
        def admit(con,bid,pid,*args):
            con.execute("UPDATE commands SET status='running',started_at=? WHERE box_id=? AND pid=?",(boatd.now(),bid,pid))
            return 0
        with patch.object(boatd,'guest_command',return_value={'state':'absent'}), \
                patch.object(boatd,'admit',side_effect=admit), patch.object(boatd,'ct_exec'), \
                patch.object(boatd,'follow_guest',side_effect=RuntimeError('bookkeeping unavailable')):
            with self.assertRaisesRegex(RuntimeError,'bookkeeping unavailable'): boatd.run_cmd(b,p)
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('running',None))
        self.assertFalse(boatd.result_path(b,p).exists())

    def test_live_guest_is_reattached_and_records_its_real_exit(self):
        b = self.box()
        p = self.cmd(b, retry=1)
        self.f.guests[b,p] = {'state':'alive'}
        summary = boatd.reconcile(self.con)
        self.assertEqual(summary['reattached'], 1)
        self.assertEqual(self.status(b,p)['attempt'], 1)
        self.assertTrue(boatd.commands_busy(self.con,b))
        self.assertFalse([c for c in self.f.calls if c[0]=='exec' and 'nohup' in c[-1]])
        self.f.guests[b,p] = {'state':'exited','exit_code':7}
        boatd.follow_guest(self.con,self.status(b,p))
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',7))
        self.assertFalse(boatd.commands_busy(self.con,b))

    def test_exit_written_while_down_and_gone_are_distinct(self):
        for pid, result, expected in ((1001,{'state':'exited','exit_code':23},('exited',23)),
                                     (1002,{'state':'gone'},('interrupted',94))):
            b = self.box(bid=f'bx_{pid}')
            self.cmd(b,pid=pid,retry=1)
            self.f.guests[b,pid] = result
            boatd.reconcile(self.con)
            self.assertEqual((self.status(b,pid)['status'],self.status(b,pid)['exit_code']), expected)
            self.assertEqual(self.f.spawned,[])
        text=(boatd.cmd_dir(b)/f'{pid}.err').read_text()
        self.assertIn(boatd.iso(boatd.STARTED),text)
        self.assertEqual(text.count('nothing was re-run'),1)
        events=[json.loads(line) for path in (self.tmp/'shared-logs').glob('*.ndjson')
                for line in path.read_text().splitlines() if json.loads(line)['name']=='reconcile.command']
        self.assertEqual({e['props']['outcome'] for e in events},{'gone','exited-while-down'})

    def test_incus_shutdown_does_not_settle_or_respawn(self):
        b=self.box(); p=self.cmd(b,retry=1)
        with patch.object(boatd,'incus',side_effect=boatd.Fail(500,'incus_failed','Incus is shutting down')):
            with self.assertRaises(boatd.Fail): boatd.reconcile(self.con)
            boatd.reap_once(self.con)
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('running',None))
        self.assertTrue(boatd.commands_busy(self.con,b))
        self.assertEqual(self.f.spawned,[])

    def test_queued_row_with_guest_receipt_is_not_readmitted(self):
        b=self.box(); p=self.cmd(b,status='queued')
        self.f.guests[b,p]={'state':'alive'}
        summary=boatd.reconcile(self.con)
        self.assertEqual((summary['reattached'],summary['requeue']),(1,0))
        with patch.object(boatd,'follow_guest') as follow, patch.object(boatd,'admit') as admit:
            boatd.run_cmd(b,p)
        follow.assert_called_once(); admit.assert_not_called()

    def test_settled_row_with_live_cgroup_still_blocks_pool(self):
        b=self.box(); p=self.cmd(b,status='exited')
        with patch.object(boatd,'_cg_pids',return_value=[42]):
            self.assertTrue(boatd.commands_busy(self.con,b))

    def test_started_marker_alone_prevents_queued_readmission(self):
        for ext in ('out', 'err'):
            for nonce in (None, '1234567890abcdef'):
                with self.subTest(stream=ext, nonce=nonce):
                    b=self.box(bid=f'bx_start_{ext}_{bool(nonce)}'); p=self.cmd(b,status='queued')
                    self.con.execute('UPDATE commands SET run_id=?,protocol_nonce=? WHERE box_id=? AND pid=?',
                                     ('run-old',nonce,b,p))
                    token=f' [n={nonce}]' if nonce else ''
                    (boatd.cmd_dir(b)/f'{p}.{ext}').write_text(f'offbox-command-started: run-old{token}\n')
                    boatd.reconcile(self.con)
                    self.assertEqual(self.status(b,p)['exit_code'],94)
                    self.assertEqual(self.f.spawned,[])
                    with patch.object(boatd,'ct_exec',return_value=subprocess.CompletedProcess([],0,b'{"busy":true}')):
                        self.assertTrue(boatd.commands_busy(self.con,b))

    def test_fake_restart_while_real_wrapper_is_alive_executes_only_once(self):
        # Real shell/PID/exit receipts, fake Incus and systemd. No home daemon is touched.
        if not Path('/proc/self/stat').exists(): self.skipTest('Linux guest PID receipts')
        root=self.tmp/'guest'; root.mkdir()
        for name in ('ready','gate'): os.mkfifo(root/name)
        wrapper=(SERVER/'boatd-wrap').read_text().replace('/run/boatd/',str(root)+'/')
        wrapper=wrapper.replace('/sys/fs/cgroup',str(root/'no-cgroup'))
        wrapper=wrapper.replace('chown 1000:1000','true').replace('setpriv --reuid=1000 --regid=1000 --init-groups -- ','')
        (root/'1001.sh').write_text(f'echo once >> {root}/executions; echo ready > {root}/ready; read x < {root}/gate; echo done; exit 17\n')
        proc=subprocess.Popen(['bash','-c',wrapper,'boatd-wrap','1001',str(root)],stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: proc.kill() if proc.poll() is None else None)
        with (root/'ready').open() as f: self.assertEqual(f.readline(),'ready\n')
        b=self.box(); p=self.cmd(b,retry=1)
        def guest_exec(box,command,**kw):
            command=command.replace('/run/boatd',str(root)).replace('/home/user/.offbox/exit',str(root/'legacy'))
            return subprocess.run(['bash','-c',command],input=kw.get('input'),capture_output=True,check=True,timeout=10)
        with patch.object(boatd,'ct_exec',side_effect=guest_exec):
            self.assertEqual(boatd.reconcile(self.con)['reattached'],1)
            duplicate=subprocess.run(['bash','-c',wrapper,'boatd-wrap','1001',str(root)],capture_output=True,timeout=10)
            self.assertEqual(duplicate.returncode,98)
            self.assertTrue(boatd.commands_busy(self.con,b))
            with (root/'gate').open('w') as f: f.write('finish\n')
            self.assertEqual(proc.wait(timeout=10),17)
            boatd.follow_guest(self.con,self.status(b,p))
            self.assertEqual(self.status(b,p)['exit_code'],17)
            self.assertFalse(boatd.commands_busy(self.con,b))
            # A launch whose response was lost may arrive after reconciliation. Its claim is fenced.
            self.cmd(b,pid=1002,retry=1)
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,1002)),'interrupted')
            late=subprocess.run(['bash','-c',wrapper,'boatd-wrap','1002',str(root)],capture_output=True,timeout=10)
            self.assertEqual(late.returncode,98)
            self.assertEqual(self.status(b,1002)['exit_code'],94)
        self.assertEqual((root/'executions').read_text(),'once\n')
        self.assertEqual((boatd.cmd_dir(b)/f'{p}.out').read_text(),'done\n')
