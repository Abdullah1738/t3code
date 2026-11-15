"""Transport failures must not masquerade as the customer's exit code."""
import json
import signal
import subprocess
from pathlib import Path
from unittest.mock import patch, Mock

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd
REAL_PROBE = boatd.command_probe
REAL_RUN = subprocess.run
REAL_POPEN = subprocess.Popen


class ExecLoss(Base):
    def command(self, *, retry=0, prior=False):
        b = self.box()
        p = self.cmd(b, status='running' if prior else 'queued', retry=retry)
        self.con.execute('UPDATE commands SET run_id=? WHERE box_id=? AND pid=?', ('run-fixture', b, p))
        return b, p

    def execute(self, b, p, *, error=None, rc=1, text='', view=None):
        def process(args, **kw):
            if args[0] != 'incus':
                return REAL_POPEN(args, **kw)
            if 'stdout' in kw:
                kw['stderr'].write(text.encode())
            return Mock(wait=Mock(return_value=rc))
        with patch.object(boatd, 'load_cfg'), patch.object(boatd, 'admit', return_value=0), \
             patch.object(boatd, 'ct_exec', side_effect=error), \
             patch.object(boatd, 'disk_preflight', return_value=0), \
             patch.object(boatd.subprocess, 'Popen', side_effect=process), \
             patch.object(boatd, 'snapshot'), patch.object(boatd, 'prune_snaps'), \
             patch.object(boatd, 'recover_probe', return_value=view or self.clean()), \
             patch.object(boatd, 'command_probe', return_value=view or self.clean()):
            boatd.run_cmd(b, p)
        return dict(self.status(b, p))

    def clean(self, rc=None):
        return dict(readable=True, pids=[], box_rc=rc)

    def events(self, name):
        return [json.loads(l) for f in (self.tmp/'shared-logs').glob('*.ndjson')
                for l in f.read_text().splitlines() if json.loads(l)['name'] == name]

    def test_script_write_before_first_spawn_is_safe_infra_not_interrupted(self):
        b,p = self.command(retry=1)
        r = self.execute(b,p,error=boatd.Fail(500,'incus_failed','Incus is shutting down'))
        self.assertEqual((r['status'], r['exit_code'], r['attempt']), ('exited',90,1))
        self.assertIn('nothing ran, safe to retry', (boatd.cmd_dir(b)/f'{p}.err').read_text())
        self.assertEqual(boatd.read_result(b,p,1)['reason'], 'before_spawn')
        self.assertFalse(self.f.spawned)

    def test_29bd_replacement_preserves_original_start_and_both_invocations(self):
        b,p = self.command(prior=True)
        started = 1794636298.0  # 06:04:58Z, not the replacement's 06:08:17Z.
        self.con.execute('UPDATE commands SET started_at=? WHERE box_id=? AND pid=?',(started,b,p))
        (boatd.cmd_dir(b)/f'{p}.out').write_text('base-1 preflight 135s\n')
        r = self.execute(b,p,error=boatd.Fail(500,'incus_failed','Incus is shutting down'))
        self.assertEqual((r['status'],r['started_at']), ('interrupted',started))
        res = boatd.read_result(b,p,1)
        self.assertEqual(res['status'],'interrupted')
        self.assertEqual(res['interruption']['cause'],'incus_unavailable')
        self.assertEqual(res['interruption']['phase'],'running')
        self.assertEqual(res['invocations'][0]['previous_started_at'],started)

    def test_incus_rejects_wrapper_exec_before_guest_marker(self):
        b,p=self.command()
        r=self.execute(b,p,text='Error: exec /usr/local/sbin/boatd-wrap: no such file or directory')
        self.assertEqual((r['status'],r['exit_code']),('exited',90))
        self.assertIn('nothing ran, safe to retry',(boatd.cmd_dir(b)/f'{p}.err').read_text())

    def test_existing_box_receives_current_wrapper_without_evaluating_command(self):
        b,p=self.command()
        guest=self.tmp/'guest/run/boatd'
        marker=self.tmp/'must-not-exist'
        command=f"echo 'quoted input' $(touch {marker})\n" + '#' * 200000
        self.con.execute('UPDATE commands SET command=? WHERE box_id=? AND pid=?',(command,b,p))
        def transfer(box, text, input=None, **kwargs):
            if input is None:
                return subprocess.CompletedProcess([],0,b'',b'')
            text=text.replace('/run/boatd',str(guest))
            return REAL_RUN(['bash','-c',text],input=input,capture_output=True,check=True)
        self.execute(b,p,rc=0,error=transfer)
        self.assertEqual((guest/f'{p}.sh').read_text(),command)
        expected=boatd.SELF.with_name('boatd-wrap').read_text().replace('/run/boatd',str(guest))
        self.assertEqual((guest/f'{p}.1.boatd-wrap').read_text(),expected)
        self.assertFalse(marker.exists())

    def test_existing_output_is_prior_start_evidence_even_if_db_is_queued(self):
        b,p = self.command()
        (boatd.cmd_dir(b)/f'{p}.err').write_text('offbox-command-started: run-fixture\n')
        r = self.execute(b,p,error=RuntimeError('Incus is shutting down'))
        self.assertEqual(r['status'],'interrupted')

    def test_guest_start_marker_is_prior_start_evidence(self):
        b,p = self.command()
        view=self.clean();view['marker']={'pid':10,'time':1794636298,'cgroup_joined':True}
        r=self.execute(b,p,error=RuntimeError('Incus is shutting down'),view=view)
        self.assertEqual(r['status'],'interrupted')
        self.assertEqual(boatd.read_result(b,p,1)['started_at'],1794636298)

    def test_48d3_uses_box_sigpipe_and_logs_interruption(self):
        b,p = self.command()
        r=self.execute(b,p,text='Error: Lost connection to the event listener: websocket: close 1006: unexpected EOF',view=self.clean(141))
        self.assertEqual((r['status'],r['exit_code']),('interrupted',None))
        info=json.loads(r['metrics'])['interruption']
        self.assertEqual((info['box_rc'],info['cleanup'],info['leftover_killed']),(141,'clean',0))
        ev=self.events('run.interrupted')[0]['props']
        self.assertEqual({k:ev[k] for k in ('cause','phase','attempt','retry','leftoverKilled','boxRc')},
                         dict(cause='exec_stream_lost',phase='running',attempt=1,retry=False,leftoverKilled=0,boxRc=141))
        self.assertEqual(len(self.events('run.exec_stream_lost')),1)

    def test_60dc_stays_held_then_reconciles_actual_zero_or_one(self):
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_fixture{rc}');p=self.cmd(b,status='queued')
                self.con.execute('UPDATE commands SET run_id=? WHERE box_id=? AND pid=?',(f'run-{rc}',b,p))
                r=self.execute(b,p,text='websocket: close 1006 unexpected EOF',view=dict(readable=True,pids=[123,124],box_rc=None))
                self.assertEqual((r['status'],r['ended_at']),('running',None))
                self.assertTrue(boatd.cmd_status_json(self.con,b,p)['running'])
                self.assertEqual(json.loads(r['metrics'])['interruption']['stream_state'],'reattached')
                with patch.object(boatd,'command_probe',return_value=self.clean(rc)):
                    self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'finalized')
                self.assertEqual((self.status(b,p)['status'], self.status(b,p)['exit_code']),('exited',rc))
        self.assertEqual(len(self.events('run.reattached')),2)

    def test_stream_gone_empty_group_is_interrupted(self):
        b,p=self.command()
        self.assertEqual(self.execute(b,p,text='websocket: close 1006')['status'],'interrupted')

    def test_real_non_signal_exit_after_stream_loss_is_preserved(self):
        b,p=self.command()
        r=self.execute(b,p,text='websocket: close 1006',view=self.clean(200))
        self.assertEqual((r['status'],r['exit_code']),('exited',200))

    def test_unavailable_or_unverified_group_holds_box(self):
        for view in (dict(reason='incus_unavailable'),dict(readable=True,pids=None,box_rc=None,reason='cgroup_unverified')):
            with self.subTest(view=view):
                b=self.box('bx_'+view['reason']);p=self.cmd(b,status='queued')
                r=self.execute(b,p,text='websocket: close 1006',view=view)
                self.assertEqual((r['status'],r['exit_code']),('running',None))
                self.assertEqual(json.loads(r['metrics'])['interruption']['reason'],view['reason'])
                self.assertTrue(boatd.cmd_status_json(self.con,b,p)['running'])

    def test_retry_once_and_second_interruption_finishes(self):
        b,p=self.command(retry=1)
        r=self.execute(b,p,text='websocket: close 1006',view=self.clean(141))
        self.assertEqual((r['status'],r['attempt']),('queued',2))
        self.assertEqual(self.f.spawned,[(b,p,2)])
        self.f.active_units.clear()
        self.con.execute("UPDATE commands SET status='running' WHERE box_id=? AND pid=?",(b,p))
        r=self.execute(b,p,text='websocket: close 1006',view=self.clean(141))
        self.assertEqual((r['status'],r['attempt']),('interrupted',2))
        self.assertEqual(len(self.f.spawned),1)

    def test_plain_test_failure_remains_exit_one(self):
        b,p=self.command()
        r=self.execute(b,p,rc=1,text='assertion failed\n')
        self.assertEqual((r['status'],r['exit_code']),('exited',1))
        self.assertFalse(self.events('run.interrupted'))

    def test_command_eof_error_is_not_incus_stream_loss(self):
        self.assertFalse(boatd.stream_failure('bash: unexpected EOF while looking for matching quote'))
        self.assertFalse(boatd.stream_failure('application failed to connect to test database'))

    def test_runner_unit_signal_is_interruption(self):
        b,p=self.command()
        r=self.execute(b,p,rc=-signal.SIGKILL)
        self.assertEqual(r['status'],'interrupted')
        self.assertEqual(self.events('run.interrupted')[0]['props']['cause'],'runner_restart')

    def test_unavailable_probe_has_injected_bounded_clock(self):
        clock=[0]
        def pause(n): clock[0]+=n
        with patch.object(boatd,'command_probe',return_value={'reason':'incus_unavailable'}) as probe:
            out=boatd.recover_probe({},clock=lambda:clock[0],pause=pause)
        self.assertEqual(out['reason'],'incus_unavailable')
        self.assertEqual(clock[0],boatd.EXEC_RECOVERY_SECONDS)
        self.assertLessEqual(probe.call_count,boatd.EXEC_RECOVERY_SECONDS+1)

    def test_unknown_restart_rechecks_surviving_command_before_cleanup(self):
        b,p=self.command(prior=True)
        with patch.object(boatd,'command_probe',return_value={'reason':'incus_unavailable'}):
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'following')
        with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[101215],box_rc=None)), \
             patch.object(boatd,'cleanup_run') as cleanup:
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'following')
            cleanup.assert_not_called()
        self.assertEqual(json.loads(self.status(b,p)['metrics'])['interruption']['stream_state'],'reattached')

    def test_recovery_between_restart_probes_never_kills_a_survivor(self):
        b,p=self.command(prior=True)
        views=[dict(reason='incus_unavailable'),dict(readable=True,pids=[101215],box_rc=None)]
        with patch.object(boatd,'command_probe',side_effect=views),patch.object(boatd,'cleanup_run') as cleanup:
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'following')
            cleanup.assert_not_called()
        self.assertEqual(self.status(b,p)['status'],'running')

    def test_replacement_preflight_rejection_follows_original_start(self):
        b,p=self.command(prior=True)
        started=self.status(b,p)['started_at']
        view=dict(readable=True,pids=[101215],box_rc=None)
        with patch.object(boatd,'load_cfg'),patch.object(boatd,'disk_preflight',return_value=90), \
             patch.object(boatd,'recover_probe',return_value=view),patch.object(boatd,'command_probe',return_value=view):
            boatd.run_cmd(b,p)
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['started_at']),('running',started))

    def test_failed_retry_dispatch_does_not_wait_for_a_never_created_group(self):
        b,p=self.command()
        self.con.execute('UPDATE commands SET attempt=2 WHERE box_id=? AND pid=?',(b,p))
        with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=None,box_rc=None)):
            boatd.drop_cmd(self.con,b,p,'systemd-run refused before spawn')
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['attempt']),('interrupted',2))

    def test_terminal_result_survives_unknown_kill_then_cleanup(self):
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_killhold{rc}');p=self.cmd(b)
                ended=boatd.now()
                self.con.execute("UPDATE commands SET status='exited',exit_code=?,ended_at=? WHERE box_id=? AND pid=?",(rc,ended,b,p))
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    boatd.kill_cmd(self.con,b,p)
                self.assertTrue(boatd.cmd_status_json(self.con,b,p)['running'])
                saved=boatd.read_result(b,p,1)['held_result']
                self.assertEqual(saved['exit_code'],rc)
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='clean',leftover_killed=0,remaining=0)):
                    boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',rc,ended))

    def test_kill_intent_preserves_terminal_file_before_database_commit(self):
        cases=[('exited',0,None),('exited',1,None),('lost',None,None),('interrupted',None,{'cleanup':'clean'})]
        for index,(status,rc,info) in enumerate(cases):
            with self.subTest(status=status,rc=rc):
                b=self.box(f'bx_terminal{index}');p=self.cmd(b)
                res=dict(attempt=1,status=status,exit_code=rc,started_at=100,ended_at=110,interruption=info)
                boatd.write_json(boatd.result_path(b,p),res)
                (boatd.cmd_dir(b)/f'{p}.kill').write_text('kill')
                boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['started_at'],row['ended_at']),(status,rc,100,110))

    def test_delayed_kill_uses_same_terminal_result_matrix(self):
        callbacks=[]
        class CapturedThread:
            def __init__(self, *, target, **kwargs): callbacks.append(target)
            def start(self): pass
        cases=[('exited',0,None),('exited',1,None),('lost',None,None),('interrupted',None,{'cleanup':'clean'})]
        for index,(status,rc,info) in enumerate(cases):
            with self.subTest(status=status,rc=rc):
                b=self.box(f'bx_callback{index}');p=self.cmd(b)
                res=dict(attempt=1,status=status,exit_code=rc,started_at=100,ended_at=110,interruption=info)
                boatd.write_json(boatd.result_path(b,p),res)
                with patch.object(boatd.threading,'Thread',CapturedThread),patch.object(boatd,'run_processes',return_value=[]):
                    boatd.kill_cmd(self.con,b,p)
                with patch.object(boatd.time,'sleep'),patch.object(boatd.subprocess,'run'):
                    callbacks.pop()()
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['started_at'],row['ended_at']),(status,rc,100,110))

    def test_delayed_unknown_cleanup_holds_completion_during_file_db_gap(self):
        callbacks=[]
        class CapturedThread:
            def __init__(self, *, target, **kwargs): callbacks.append(target)
            def start(self): pass
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_callbackhold{rc}');p=self.cmd(b)
                self.con.execute('UPDATE commands SET run_id=? WHERE box_id=? AND pid=?',('run-held',b,p))
                with patch.object(boatd.threading,'Thread',CapturedThread),patch.object(boatd,'run_processes',return_value=[]):
                    boatd.kill_cmd(self.con,b,p)
                result=dict(attempt=1,status='exited',exit_code=rc,started_at=100,ended_at=110)
                boatd.write_json(boatd.result_path(b,p),result)
                self.con.execute("UPDATE commands SET status='exited',exit_code=? WHERE box_id=? AND pid=?",(rc,b,p))
                with patch.object(boatd.time,'sleep'),patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    callbacks.pop()()
                self.assertEqual(boatd.held_runs(self.con,b),['run-held'])
                self.assertEqual(boatd.read_result(b,p,1)['held_result'],result)
                with self.assertRaises(boatd.Fail):
                    boatd.start_cmd(self.con,b,dict(command='true',detached=True))
                boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',rc,110))

    def test_lost_kill_preserves_terminal_database_without_receipt(self):
        callbacks=[]
        class CapturedThread:
            def __init__(self, *, target, **kwargs): callbacks.append(target)
            def start(self): pass
        cases=[('exited',0,None),('exited',1,None),('lost',None,None),('interrupted',None,{'cleanup':'clean'})]
        for index,(status,rc,info) in enumerate(cases):
            with self.subTest(status=status,rc=rc):
                b=self.box(f'bx_dbonly{index}');p=self.cmd(b)
                with patch.object(boatd.threading,'Thread',CapturedThread),patch.object(boatd,'run_processes',return_value=[]):
                    boatd.kill_cmd(self.con,b,p,lost=True)
                self.con.execute('UPDATE commands SET status=?,exit_code=?,started_at=100,ended_at=110,metrics=? WHERE box_id=? AND pid=?',
                                 (status,rc,json.dumps({'interruption':info}),b,p))
                with patch.object(boatd.time,'sleep'),patch.object(boatd.subprocess,'run'):
                    callbacks.pop()()
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['started_at'],row['ended_at']),(status,rc,100,110))

    def test_runner_known_cleanup_lost_kill_preserves_observed_zero_or_one(self):
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_runnerlost{rc}');p=self.cmd(b,status='queued')
                def process(args, **kwargs):
                    (boatd.cmd_dir(b)/f'{p}.kill').write_text('lost')
                    return Mock(wait=Mock(return_value=rc))
                with patch.object(boatd,'load_cfg'),patch.object(boatd,'admit',return_value=0), \
                     patch.object(boatd,'ct_exec'),patch.object(boatd,'disk_preflight',return_value=0), \
                     patch.object(boatd.subprocess,'Popen',side_effect=process):
                    boatd.run_cmd(b,p)
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code']),('exited',rc))

    def test_late_attempt_one_result_cannot_overwrite_current_attempt_two(self):
        b,p=self.command()
        self.con.execute('UPDATE commands SET attempt=2 WHERE box_id=? AND pid=?',(b,p))
        current=self.status(b,p)
        stale=dict(attempt=1,status='exited',exit_code=1,started_at=100,ended_at=110)
        self.assertEqual(boatd.record_command_result(self.con,current,stale,{},'finalized'),'following')
        self.assertEqual(self.status(b,p)['status'],'queued')
        self.assertIsNone(boatd.read_result(b,p,1))
        self.assertEqual(boatd.restore_kill_result(self.con,current,stale,dict(cleanup='clean'))[0],'following')
        self.assertEqual(self.status(b,p)['status'],'queued')

    def test_pending_kill_receipt_fences_and_recovers_a_failed_database_commit(self):
        for recover in ('startup','reaper'):
            with self.subTest(recover=recover):
                b=self.box('bx_gap'+recover);p=self.cmd(b)
                ended=boatd.now()
                self.con.execute("UPDATE commands SET run_id='run-gap',status='exited',exit_code=1,ended_at=? WHERE box_id=? AND pid=?",(ended,b,p))
                con=self.con
                class InterruptedCommit:
                    def execute(self,sql,*args):
                        if sql.startswith('UPDATE commands SET status='):
                            raise OSError('daemon stopped in file/DB gap')
                        return con.execute(sql,*args)
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    with self.assertRaises(OSError):
                        boatd.kill_cmd(InterruptedCommit(),b,p)
                self.assertEqual(self.status(b,p)['status'],'exited')
                self.assertEqual(boatd.held_runs(self.con,b),['run-gap'])
                with self.assertRaises(boatd.Fail):
                    boatd.start_cmd(self.con,b,dict(command='true',detached=True))
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    (boatd.reconcile if recover=='startup' else boatd.reap_once)(self.con)
                self.assertEqual(self.status(b,p)['status'],'running')
                boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',1,ended))
                self.assertEqual(boatd.held_runs(self.con,b),[])

    def test_stale_restart_poll_cannot_erase_a_just_committed_exit(self):
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_stalepoll{rc}');p=self.cmd(b)
                stale=self.status(b,p)
                result=dict(attempt=1,status='exited',exit_code=rc,started_at=100,ended_at=110)
                def ended_unit(unit):
                    boatd.record_command_result(self.con,self.status(b,p),result,{},'finalized')
                    return False
                with patch.object(boatd,'unit_active',side_effect=ended_unit), \
                     patch.object(boatd,'command_probe',return_value={'reason':'incus_unavailable'}):
                    self.assertEqual(boatd.settle_cmd(self.con,stale),'finalized')
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',rc,110))
                self.assertEqual(boatd.read_result(b,p,1),result)

    def test_kill_rechecks_admitted_row_instead_of_certifying_stale_queue(self):
        b,p=self.command()
        stale=self.status(b,p)
        self.con.execute("UPDATE commands SET status='running',started_at=? WHERE box_id=? AND pid=?",(boatd.now(),b,p))
        (boatd.cmd_dir(b)/f'{p}.kill').write_text('kill')
        with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=2)) as cleanup:
            self.assertEqual(boatd.settle_cmd(self.con,stale),'following')
        self.assertEqual(cleanup.call_args.args[0]['status'],'running')
        self.assertEqual(boatd.held_runs(self.con,b),['run-fixture'])
        with self.assertRaises(boatd.Fail):
            boatd.start_cmd(self.con,b,dict(command='true',detached=True))

    def test_kill_intent_fences_before_first_probe_and_recovers_without_receipt(self):
        for mode in ('startup','reaper'):
            with self.subTest(mode=mode):
                b=self.box('bx_intent'+mode);p=self.cmd(b)
                ended=boatd.now()
                self.con.execute("UPDATE commands SET run_id='run-intent',status='exited',exit_code=0,ended_at=? WHERE box_id=? AND pid=?",(ended,b,p))
                def unavailable(row):
                    self.assertEqual(boatd.held_runs(self.con,b),['run-intent'])
                    with self.assertRaises(boatd.Fail):
                        boatd.start_cmd(self.con,b,dict(command='true',detached=True))
                    raise OSError('daemon stopped before first cleanup receipt')
                with patch.object(boatd,'cleanup_run',side_effect=unavailable):
                    with self.assertRaises(OSError):
                        boatd.kill_cmd(self.con,b,p,lost=True)
                self.assertIsNone(boatd.read_result(b,p,1))
                (boatd.cmd_dir(b)/f'{p}.kill').unlink()
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='clean',leftover_killed=0,remaining=0)) as cleanup:
                    (boatd.reconcile if mode=='startup' else boatd.reap_once)(self.con)
                    cleanup.assert_called_once()
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',0,ended))
                self.assertEqual(boatd.held_runs(self.con,b),[])

    def test_durable_kill_of_queued_command_prevents_dispatch_without_kill_file(self):
        b,p=self.command()
        (boatd.cmd_dir(b)/f'{p}.err').write_text(boatd.offbox_disk_space.MARKER +
            json.dumps(dict(phase='attempt',attempt=1)) + '\noffbox-server: waiting for earlier runs in the queue\n')
        boatd.stage_kill(self.con,b,p,False)
        r=self.execute(b,p,rc=0)
        self.assertEqual((r['status'],r['exit_code']),('exited',143))
        self.assertEqual(boatd.held_runs(self.con,b),[])

    def test_queued_kill_start_evidence_matrix(self):
        marker=boatd.offbox_disk_space.MARKER + json.dumps(dict(phase='attempt',attempt=1))+'\n'
        cases=[
            ('empty',{},True),
            ('earlier_queue',{'err':marker+'offbox-server: waiting for earlier runs in the queue\n'},True),
            ('memory_queue',{'err':marker+'offbox-server: waiting for memory (this kind peaks ~1 GB)\n'},True),
            ('stdout',{'out':'setup started\n'},False),
            ('stderr',{'err':'setup started\n'},False),
            ('history',{'history':True},False),
            ('receipt',{'receipt':True},False),
            ('missing_logs',{'missing':True},False),
            ('running',{'running':True},False),
            ('retry_old_output',{'attempt':2,'out':'old attempt started\n','err':'old error\n'},True),
        ]
        for name,fixture,never_started in cases:
            with self.subTest(name=name):
                b=self.box('bx_evidence_'+name);p=self.cmd(b,status='running' if fixture.get('running') else 'queued',attempt=fixture.get('attempt',1))
                for ext in ('out','err'):
                    (boatd.cmd_dir(b)/f'{p}.{ext}').write_text(fixture.get(ext,''))
                if fixture.get('missing'):
                    (boatd.cmd_dir(b)/f'{p}.err').unlink()
                if fixture.get('history'):
                    (boatd.cmd_dir(b)/f'{p}.1.invocations.json').write_text('[]')
                if fixture.get('receipt'):
                    boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='running'))
                boatd.stage_kill(self.con,b,p,False)
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    action=boatd.settle_cmd(self.con,self.status(b,p))
                self.assertEqual(action,'killed' if never_started else 'following')
                self.assertEqual(self.status(b,p)['exit_code'],143 if never_started else None)

    def test_recovered_queued_kill_cannot_dispatch_a_delayed_runner(self):
        b,p=self.command()
        boatd.stage_kill(self.con,b,p,False)
        self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'killed')
        with patch.object(boatd,'load_cfg'),patch.object(boatd,'ct_exec') as guest, \
             patch.object(boatd.subprocess,'Popen') as process:
            boatd.run_cmd(b,p)
        guest.assert_not_called()
        process.assert_not_called()
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',143))

    def test_admission_update_cannot_revive_a_kill_settled_after_its_first_read(self):
        b,p=self.command()
        def available():
            boatd.stage_kill(self.con,b,p,False)
            boatd.settle_cmd(self.con,self.status(b,p))
            return 2**60
        with patch.object(boatd,'mem_available',side_effect=available):
            with open(boatd.cmd_dir(b)/f'{p}.err','ab') as err:
                boatd._admit(self.con,b,p,'fixture',err)
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',143))

    def test_kill_preserves_guest_receipt_observed_while_cleanup_unknown(self):
        for rc in (0,1,141,200):
            with self.subTest(rc=rc):
                b=self.box(f'bx_knownrc{rc}');p=self.cmd(b)
                c=self.status(b,p)
                res=dict(attempt=1,started_at=c['started_at'],interruption=boatd.interruption(c,'exec_stream_lost'))
                with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=None,box_rc=rc,reason='cgroup_unverified')):
                    boatd.settle_transport(self.con,c,res)
                ended=boatd.read_result(b,p,1)['interruption']['box_rc_at']
                boatd.stage_kill(self.con,b,p,False)
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='clean',leftover_killed=0,remaining=0)):
                    boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),
                                 ('interrupted' if rc==141 else 'exited',None if rc==141 else rc,ended))

    def test_stale_attempt_cannot_probe_or_kill_current_attempt_group(self):
        b,p=self.command(prior=True)
        stale=self.status(b,p)
        self.con.execute('UPDATE commands SET attempt=2 WHERE box_id=? AND pid=?',(b,p))
        with patch.object(boatd,'command_probe') as probe,patch.object(boatd,'cleanup_run') as cleanup:
            info=boatd.interruption(stale,'exec_stream_lost')
            info['box_rc']=141
            result=dict(attempt=1,interruption=info)
            self.assertEqual(boatd.settle_transport(self.con,stale,result),'following')
            self.assertEqual(boatd.save_interruption(self.con,stale,result['interruption']),'following')
        probe.assert_not_called()
        cleanup.assert_not_called()
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['attempt']),('running',2))

    def test_cancel_during_script_upload_prevents_exec_dispatch(self):
        b,p=self.command(prior=True)
        def upload(*args,**kwargs):
            boatd.stage_kill(self.con,b,p,False)
            return subprocess.CompletedProcess([],0)
        with patch.object(boatd,'load_cfg'),patch.object(boatd,'disk_preflight',return_value=0), \
             patch.object(boatd,'ct_exec',side_effect=upload),patch.object(boatd.subprocess,'Popen') as process, \
             patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
            boatd.run_cmd(b,p)
        process.assert_not_called()
        self.assertEqual(boatd.held_runs(self.con,b),['run-fixture'])

    def test_kill_preserves_new_guest_receipt_first_seen_by_cleanup(self):
        for rc in (0,1,141,200):
            with self.subTest(rc=rc):
                b=self.box(f'bx_newrc{rc}');p=self.cmd(b)
                c=self.status(b,p)
                res=dict(attempt=1,started_at=c['started_at'],interruption=boatd.interruption(c,'exec_stream_lost'))
                boatd.settle_transport(self.con,c,res,view=dict(readable=True,pids=[10],box_rc=None))
                boatd.stage_kill(self.con,b,p,False)
                with patch.object(boatd,'command_probe',return_value=self.clean(rc)):
                    boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code']),('interrupted' if rc==141 else 'exited',None if rc==141 else rc))
                if rc==141:
                    self.assertEqual(self.events('run.interrupted')[-1]['props']['boxRc'],141)

    def test_pending_kill_keeps_saved_result_before_late_conflicting_observation(self):
        b,p=self.command(prior=True)
        original=dict(attempt=1,status='exited',exit_code=1,started_at=100,ended_at=110)
        boatd.record_command_result(self.con,self.status(b,p),original,{},'finalized')
        boatd.stage_kill(self.con,b,p,False)
        with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
            boatd.settle_cmd(self.con,self.status(b,p))
        later=dict(attempt=1,status='exited',exit_code=0,started_at=100,ended_at=120)
        boatd.record_command_result(self.con,self.status(b,p),later,{},'finalized')
        row=self.status(b,p)
        self.assertEqual((row['exit_code'],row['ended_at']),(1,110))

    def test_synthetic_kill_fallback_does_not_override_late_actual_completion(self):
        b,p=self.command(prior=True)
        boatd.stage_kill(self.con,b,p,False)
        boatd.settle_cmd(self.con,self.status(b,p))
        actual=dict(attempt=1,status='exited',exit_code=0,started_at=100,ended_at=110)
        boatd.record_command_result(self.con,self.status(b,p),actual,{},'finalized')
        self.assertEqual(self.status(b,p)['exit_code'],0)

    def test_cleanup_keeps_first_guest_receipt_timestamp(self):
        b,p=self.command(prior=True)
        info=boatd.interruption(self.status(b,p),'exec_stream_lost')
        info.update(box_rc=1,box_rc_at=100)
        boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='running',interruption=info))
        self.con.execute('UPDATE commands SET metrics=? WHERE box_id=? AND pid=?',(json.dumps({'interruption':info}),b,p))
        boatd.stage_kill(self.con,b,p,False)
        cleanup=dict(cleanup='clean',leftover_killed=0,remaining=0,box_rc=1,box_rc_at=200)
        with patch.object(boatd,'cleanup_run',return_value=cleanup):
            boatd.settle_cmd(self.con,self.status(b,p))
        row=self.status(b,p)
        self.assertEqual((row['exit_code'],row['ended_at']),(1,100))
        self.assertEqual(json.loads(row['metrics'])['interruption']['box_rc_at'],100)

    def test_host_launch_failure_never_dispatched_is_safe_to_retry(self):
        b,p=self.command(retry=1)
        with patch.object(boatd,'load_cfg'),patch.object(boatd,'admit',return_value=0), \
             patch.object(boatd,'disk_preflight',return_value=0),patch.object(boatd,'ct_exec'), \
             patch.object(boatd.subprocess,'Popen',side_effect=FileNotFoundError('incus missing')):
            boatd.run_cmd(b,p)
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',90))
        self.assertIn('nothing ran, safe to retry',(boatd.cmd_dir(b)/f'{p}.err').read_text())

    def test_durable_guest_receipt_precedes_late_conflicting_host_completion(self):
        b,p=self.command(prior=True)
        info=boatd.interruption(self.status(b,p),'exec_stream_lost')
        info.update(box_rc=1,box_rc_at=100)
        boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='running',interruption=info))
        self.con.execute('UPDATE commands SET metrics=? WHERE box_id=? AND pid=?',(json.dumps({'interruption':info}),b,p))
        boatd.stage_kill(self.con,b,p,False)
        late=dict(attempt=1,status='exited',exit_code=0,ended_at=120)
        boatd.record_command_result(self.con,self.status(b,p),late,{},'finalized')
        self.assertEqual((self.status(b,p)['exit_code'],self.status(b,p)['ended_at']),(1,100))

    def test_ordinary_reconcile_keeps_first_guest_receipt_time(self):
        b,p=self.command(prior=True)
        info=boatd.interruption(self.status(b,p),'exec_stream_lost')
        info.update(box_rc=1,box_rc_at=100)
        boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='running',interruption=info))
        with patch.object(boatd,'command_probe',return_value=self.clean(1)),patch.object(boatd,'now',return_value=200):
            boatd.settle_cmd(self.con,self.status(b,p))
        self.assertEqual((self.status(b,p)['exit_code'],self.status(b,p)['ended_at']),(1,100))

    def test_kill_result_evidence_precedence_matrix(self):
        actual=lambda rc,t:dict(attempt=1,status='exited',exit_code=rc,ended_at=t)
        guest=dict(attempt=1,status='running',interruption=dict(box_rc=1,box_rc_at=100))
        synthetic=dict(actual(143,90),signal='SIGTERM',synthetic_kill=True)
        unknown=dict(attempt=1,status='running')
        fresh=dict(box_rc=0,box_rc_at=200)
        cases=[
            ('saved_exit',actual(1,110),actual(0,120),{},None,1,110),
            ('saved_guest',guest,actual(0,120),{},None,1,100),
            ('synthetic_then_real',synthetic,actual(0,120),{},None,0,120),
            ('unknown_then_real',unknown,actual(1,120),{},None,1,120),
            ('fresh_guest',unknown,actual(1,120),fresh,None,0,200),
            ('saved_before_fresh',guest,actual(0,120),fresh,None,1,100),
            ('saved_before_row',guest,actual(0,120),{},actual(0,110),1,100),
            ('row_before_incoming',unknown,actual(1,120),{},actual(0,110),0,110),
            ('synthetic_only',synthetic,unknown,{},None,143,90),
        ]
        for name,current,incoming,receipt,row_result,rc,ended in cases:
            with self.subTest(name=name):
                b=self.box('bx_precedence_'+name);p=self.cmd(b)
                boatd.write_json(boatd.result_path(b,p),current)
                if row_result:
                    self.con.execute("UPDATE commands SET status='exited',exit_code=?,ended_at=? WHERE box_id=? AND pid=?",
                                     (row_result['exit_code'],row_result['ended_at'],b,p))
                boatd.stage_kill(self.con,b,p,False)
                cleanup=dict(cleanup='clean',leftover_killed=0,remaining=0,**receipt)
                with patch.object(boatd,'cleanup_run',return_value=cleanup):
                    boatd.record_command_result(self.con,self.status(b,p),incoming,{},'finalized')
                self.assertEqual((self.status(b,p)['exit_code'],self.status(b,p)['ended_at']),(rc,ended))

    def test_signal_receipt_time_survives_result_write_then_sql_failure(self):
        b,p=self.command(prior=True)
        c=self.status(b,p)
        info=boatd.interruption(c,'exec_stream_lost')
        info.update(box_rc=141,box_rc_at=100)
        result=dict(attempt=1,status='interrupted',exit_code=None,started_at=50,ended_at=100,interruption=info)
        con=self.con
        class InterruptedCommit:
            def execute(self,sql,*args):
                if sql.startswith('UPDATE commands SET status='):
                    raise OSError('daemon stopped after receipt')
                return con.execute(sql,*args)
        with self.assertRaises(OSError):
            boatd.record_command_result(InterruptedCommit(),c,result,{'interruption':info},'following')
        self.assertIsNone(self.status(b,p)['metrics'])
        with patch.object(boatd,'now',return_value=200),patch.object(boatd,'command_probe',return_value=self.clean(141)):
            boatd.settle_cmd(self.con,self.status(b,p))
        self.assertEqual(self.status(b,p)['ended_at'],100)
        self.assertEqual(json.loads(self.status(b,p)['metrics'])['interruption']['box_rc_at'],100)

    def test_runner_unknown_kill_retains_observed_exit_until_cleanup(self):
        for rc in (0,1):
            with self.subTest(rc=rc):
                b=self.box(f'bx_runnerhold{rc}');p=self.cmd(b,status='queued')
                def process(args, **kwargs):
                    (boatd.cmd_dir(b)/f'{p}.kill').write_text('kill')
                    return Mock(wait=Mock(return_value=rc))
                with patch.object(boatd,'load_cfg'),patch.object(boatd,'admit',return_value=0), \
                     patch.object(boatd,'ct_exec'),patch.object(boatd,'disk_preflight',return_value=0), \
                     patch.object(boatd.subprocess,'Popen',side_effect=process), \
                     patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
                    boatd.run_cmd(b,p)
                res=boatd.read_result(b,p,1)
                self.assertEqual(res['held_result']['exit_code'],rc)
                with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='clean',leftover_killed=0,remaining=0)):
                    boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual((row['status'],row['exit_code'],row['ended_at']),('exited',rc,res['held_result']['ended_at']))

    def test_kill_intent_is_retried_before_reattachment_even_if_unit_active(self):
        b,p=self.command(prior=True)
        c=self.status(b,p)
        boatd.write_json(boatd.result_path(b,p),dict(attempt=1,status='running',interruption=boatd.interruption(c,'exec_stream_lost')))
        (boatd.cmd_dir(b)/f'{p}.kill').write_text('kill')
        self.f.active_units.add(boatd.unit_name(b,p,1))
        with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='unknown',leftover_killed=None,remaining=None)):
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'following')
        self.assertEqual(boatd.box_json(self.con,boatd.box_row(self.con,b))['heldRuns'],['run-fixture'])
        with patch.object(boatd,'cleanup_run',return_value=dict(cleanup='stopped',leftover_killed=2,remaining=0)) as cleanup:
            self.assertEqual(boatd.settle_cmd(self.con,self.status(b,p)),'killed')
            cleanup.assert_called_once()
        self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',143))

    def test_new_attempt_does_not_reclassify_old_stream_error_as_its_test_failure(self):
        b,p=self.command(retry=1)
        self.execute(b,p,text='websocket: close 1006',view=self.clean(141))
        r=self.execute(b,p,rc=1,text='ordinary assertion failed')
        self.assertEqual((r['status'],r['exit_code'],r['attempt']),('exited',1,2))

    def test_observed_receipt_survives_unknown_cleanup_then_container_stop(self):
        for rc, expected in ((0,'exited'),(1,'exited'),(141,'interrupted')):
            with self.subTest(rc=rc):
                b=self.box(f'bx_receipt{rc}');p=self.cmd(b)
                res=dict(attempt=1,started_at=self.status(b,p)['started_at'],interruption=boatd.interruption(self.status(b,p),'exec_stream_lost'))
                with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=None,box_rc=rc,reason='cgroup_unverified')):
                    self.assertEqual(boatd.settle_transport(self.con,self.status(b,p),res),'following')
                with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[],box_rc=None,stopped=True)):
                    boatd.settle_cmd(self.con,self.status(b,p))
                row=self.status(b,p)
                self.assertEqual(row['status'],expected)
                self.assertEqual(json.loads(row['metrics'])['interruption']['box_rc'],rc)
                self.assertEqual(row['exit_code'],rc if expected=='exited' else None)

    def test_cleanup_counts_only_confirmed_stops_and_unknown_is_not_zero(self):
        b,p=self.command()
        cg=self.tmp/'cgroup';cg.mkdir();(cg/'boatd').mkdir();(cg/'boatd'/str(p)).mkdir()
        with patch.object(boatd,'cg_path',return_value=cg), \
             patch.object(boatd,'run_processes',return_value=[]):
            result=boatd.cleanup_run(self.status(b,p),dict(readable=True,pids=[10,11,12]))
        self.assertEqual((result['cleanup'],result['leftover_killed']),('stopped',3))
        result=boatd.cleanup_run(self.status(b,p),dict(readable=True,pids=None))
        self.assertEqual((result['cleanup'],result['leftover_killed']),('unknown',None))

    def test_settled_kill_reaches_leftovers_and_empty_reports_clean(self):
        b,p=self.command()
        self.con.execute("UPDATE commands SET status='exited',exit_code=1 WHERE box_id=? AND pid=?",(b,p))
        for cleanup in (dict(cleanup='stopped',leftover_killed=3,remaining=0),dict(cleanup='clean',leftover_killed=0,remaining=0)):
            with patch.object(boatd,'cleanup_run',return_value=cleanup):
                self.assertEqual(boatd.kill_cmd(self.con,b,p),cleanup)
                self.assertEqual(boatd.cmd_status_json(self.con,b,p)['cleanup'],cleanup)

    def test_missing_group_never_means_clean_and_nested_members_are_counted(self):
        b,p=self.command()
        with patch.object(boatd,'cg_path',return_value=self.tmp/'cg'):
            self.assertIsNone(boatd.run_processes(b,p))
            cg=self.tmp/'cg/boatd'/str(p);cg.mkdir(parents=True)
            (cg/'cgroup.procs').write_text('10\n')
            (cg/'child').mkdir();(cg/'child/cgroup.procs').write_text('11\n12\n')
            self.assertEqual(boatd.run_processes(b,p),[10,11,12])

    def test_failed_join_flag_overrides_an_empty_directory(self):
        b,p=self.command()
        root=self.tmp/'proc/42/root/run/boatd';root.mkdir(parents=True)
        (root/f'{p}.1.started').write_text(json.dumps(dict(pid=10,time=100,cgroup_joined=False)))
        answer=subprocess.CompletedProcess([],0,json.dumps(dict(status='Running',pid=42)).encode())
        with patch.object(boatd,'PROC_ROOT',self.tmp/'proc'),patch.object(boatd,'incus',return_value=answer), \
             patch.object(boatd,'run_processes',return_value=[]):
            view=REAL_PROBE(self.status(b,p))
        self.assertIsNone(view['pids'])
        self.assertEqual(view['reason'],'cgroup_unverified')

    def test_missing_join_marker_cannot_certify_an_empty_group(self):
        b,p=self.command()
        (self.tmp/'proc/42/root/run/boatd').mkdir(parents=True)
        answer=subprocess.CompletedProcess([],0,json.dumps(dict(status='Running',pid=42)).encode())
        with patch.object(boatd,'PROC_ROOT',self.tmp/'proc'),patch.object(boatd,'incus',return_value=answer), \
             patch.object(boatd,'run_processes',return_value=[]):
            view=REAL_PROBE(self.status(b,p))
        self.assertIsNone(view['pids'])
        self.assertEqual(view['reason'],'cgroup_unverified')

    def test_join_evidence_shapes_require_current_attempt_and_real_pid(self):
        b,p=self.command()
        root=self.tmp/'proc/42/root/run/boatd';root.mkdir(parents=True)
        answer=subprocess.CompletedProcess([],0,json.dumps(dict(status='Running',pid=42)).encode())
        cases=[([],False),({},False),({'cgroup_joined':True},False),
               (dict(pid=10,time=100,attempt=2,cgroup_joined=True),False),
               (dict(pid=0,time=100,attempt=1,cgroup_joined=True),False),
               (dict(pid=10,time=100,attempt=1,cgroup_joined=False),False),
               (dict(pid=10,time=100,attempt=1,cgroup_joined=True),True)]
        for marker,known in cases:
            with self.subTest(marker=marker):
                (root/f'{p}.1.started').write_text(json.dumps(marker))
                with patch.object(boatd,'PROC_ROOT',self.tmp/'proc'),patch.object(boatd,'incus',return_value=answer), \
                     patch.object(boatd,'run_processes',return_value=[]):
                    view=REAL_PROBE(self.status(b,p))
                self.assertEqual(view['pids'],[] if known else None)

    def test_legacy_members_can_be_stopped_without_claiming_entire_run_is_clean(self):
        b,p=self.command()
        cg=self.tmp/'cg';(cg/'boatd'/str(p)).mkdir(parents=True)
        view=dict(readable=True,pids=[10,11],box_rc=141,join_verified=False)
        with patch.object(boatd,'cg_path',return_value=cg),patch.object(boatd,'run_processes',return_value=[]):
            result=boatd.cleanup_run(self.status(b,p),view)
        self.assertEqual((result['cleanup'],result['leftover_killed'],result['remaining']),('unknown',2,None))
        self.con.execute('UPDATE commands SET metrics=? WHERE box_id=? AND pid=?',
                         (json.dumps({'kill':result}),b,p))
        later=boatd.cleanup_run(self.status(b,p),dict(readable=True,pids=[],stopped=True))
        self.assertEqual((later['cleanup'],later['leftover_killed'],later['remaining']),('stopped',2,0))

    def test_startup_recovers_historically_settled_60dc_in_place(self):
        b,p=self.command()
        self.con.execute("UPDATE commands SET status='exited',exit_code=1,ended_at=? WHERE box_id=? AND pid=?",(boatd.now(),b,p))
        (boatd.cmd_dir(b)/f'{p}.err').write_text('Error: Lost connection to the event listener: websocket: close 1006')
        with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=[101215],box_rc=None)):
            out=boatd.reconcile(self.con)
        self.assertEqual(out['following'],1)
        self.assertEqual(self.status(b,p)['status'],'running')
        self.assertFalse(self.f.spawned)

    def test_reattached_box_rejects_new_user_run_but_keeps_control_commands(self):
        b,p=self.command()
        self.execute(b,p,text='websocket: close 1006',view=dict(readable=True,pids=[101215],box_rc=None))
        box=boatd.box_json(self.con,boatd.box_row(self.con,b))
        self.assertEqual(box['heldRuns'],['run-fixture'])
        with self.assertRaises(boatd.Fail) as cm:
            boatd.start_cmd(self.con,b,dict(command='echo must-not-run',detached=True))
        self.assertEqual(cm.exception.code,'box_held')
        control=boatd.start_cmd(self.con,b,dict(command='ps',detached=False))
        self.assertIsNotNone(control['processId'])
        self.assertEqual(self.status(b,p)['status'],'running')

    def test_startup_repair_does_not_reuse_prior_attempts_stream_error(self):
        for boundary in (False,True):
            with self.subTest(boundary=boundary):
                b=self.box(f'bx_prior{int(boundary)}');p=self.cmd(b,attempt=2)
                self.con.execute("UPDATE commands SET status='exited',exit_code=1,ended_at=? WHERE box_id=? AND pid=?",(boatd.now(),b,p))
                text='Error: websocket: close 1006\n'
                if boundary:
                    text+='offbox-server: the server restarted while this run was going (attempt 1 is lost); it is queued again as attempt 2\n'
                text+='ordinary assertion failed\n'
                (boatd.cmd_dir(b)/f'{p}.err').write_text(text)
                with patch.object(boatd,'command_probe',return_value=dict(readable=True,pids=None,box_rc=None)):
                    boatd.reconcile(self.con)
                self.assertEqual((self.status(b,p)['status'],self.status(b,p)['exit_code']),('exited',1))
