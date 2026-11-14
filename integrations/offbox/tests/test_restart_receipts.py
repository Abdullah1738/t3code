"""Restart recovery with missing host runners and retained guest processes."""
import json
import os
from pathlib import Path
import subprocess
from unittest.mock import patch

if __package__:
    from .test_boatd import Base, boatd, SERVER
else:
    from test_boatd import Base, boatd, SERVER


class RestartReceipts(Base):
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
                with patch.object(boatd,'commands_busy',return_value=False):
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
        b=self.box(); p=self.cmd(b,status='queued')
        (boatd.cmd_dir(b)/f'{p}.out').write_text('offbox-command-started: run-old\n')
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
