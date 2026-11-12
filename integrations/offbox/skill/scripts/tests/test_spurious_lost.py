"""Offline regressions for #770: boat's tracker is not proof the wrapper stopped."""
import contextlib
import io
import subprocess
from unittest.mock import patch

from test_capacity import Isolated
from offbox_lib import api, common, lease, misc, pool, reap, runs


class SpuriousLostTests(Isolated):
    def setUp(self):
        super().setUp()
        self.box('bx', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,mode,pulls,start_at,remote_dir) "
                         "VALUES ('run-t','bx','running',7,'bg','[]',900,'w/old')")
        self.con.commit()
        self.stack.enter_context(patch.object(api, 'cmd_status', return_value={'status': 'lost', 'running': False}))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-t'").fetchone()

    def test_2786_reaper_reads_existing_exit_file(self):
        for code in (0, 1):
            with self.subTest(code=code), patch.object(runs, 'recorded_exit', return_value=code):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
                self.con.commit()
                reap._check_unlocked(self.con, 'bx', 'running', False, [])
                self.assertEqual((self.row()['status'], self.row()['exit_code']),
                                 ('done' if code == 0 else 'failed', code))

    def test_2786_wait_corrects_existing_lost_row(self):
        for code in (0, 1):
            with self.subTest(code=code), patch.object(runs, 'recorded_exit', return_value=code), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.con.execute("UPDATE runs SET status='lost',exit_code=NULL,end_at=1000")
                self.con.commit()
                self.assertEqual(misc.wait('run-t', 45), code)
                self.assertEqual((self.row()['status'], self.row()['exit_code']),
                                 ('done' if code == 0 else 'failed', code))

    def test_pool_reclaim_uses_existing_exit_file(self):
        for code in (0, 1):
            with self.subTest(code=code), patch.object(runs, 'recorded_exit', return_value=code):
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
                self.con.commit()
                pool._refresh_background(self.con, 'repo')
                self.assertEqual((self.row()['status'], self.row()['exit_code']),
                                 ('done' if code == 0 else 'failed', code))

    def test_reaper_liveness_matrix(self):
        for alive, expected in [('alive', 'running'), ('gone', 'lost'), (None, 'running'), ('ended', 'running')]:
            with self.subTest(alive=alive), patch.object(runs, 'recorded_exit', return_value=None), \
                    patch.object(runs, 'remote_alive', return_value=alive):
                self.con.execute("UPDATE runs SET status='running',end_at=NULL")
                self.con.commit()
                reap._check_unlocked(self.con, 'bx', 'running', False, [])
                self.assertEqual(self.row()['status'], expected)
                self.assertIsNone(self.row()['exit_code'])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE kind='run_lost_spurious'").fetchone()[0], 1)

    def test_ssh_exit_read_failure_leaves_run_active(self):
        with patch.object(runs, 'recorded_exit', side_effect=common.OffboxError('SSH timeout')), \
                patch.object(runs, 'remote_alive') as alive:
            reap._check_unlocked(self.con, 'bx', 'running', False, [])
            pool._refresh_background(self.con, 'repo')
            self.assertEqual(self.row()['status'], 'running')
            alive.assert_not_called()

    def test_history_precedes_ssh(self):
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        with patch.object(api, 'history_get', return_value={'exitCode':1}), \
                patch.object(runs, 'recorded_exit') as read:
            self.assertEqual(runs.confirmed_lost('bx', 'run-t')['exitCode'], 1)
            read.assert_not_called()

    def test_wait_revives_lost_row_before_following(self):
        self.con.execute("UPDATE runs SET status='lost',end_at=1000")
        self.con.commit()
        def follow(*args, **kwargs):
            self.assertEqual(self.row()['status'], 'running')
            self.assertIsNone(self.row()['end_at'])
            return 3
        with patch.object(runs, 'recorded_exit', return_value=None), \
                patch.object(runs, 'remote_alive', return_value='alive'), \
                patch.object(runs, 'follow', side_effect=follow), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-t', 45), 3)
        self.assertEqual((self.row()['status'], self.row()['exit_code']), ('failed', 3))

    def test_logs_corrects_lost_row(self):
        self.con.execute("UPDATE runs SET status='lost',end_at=1000")
        self.con.commit()
        with patch.object(runs, 'recorded_exit', return_value=0):
            self.assertEqual(misc.logs('run-t', False), 0)
        self.assertEqual((self.row()['status'], self.row()['exit_code']), ('done', 0))

    def test_same_caller_same_dir_cannot_reuse_spuriously_lost_run(self):
        self.con.execute("INSERT INTO pool_callers(box_id,owner,repo_root,remote_dir) VALUES ('bx',?,?,'w/old')",
                         (self.me['owner'], self.me['repo_root']))
        self.con.commit()
        for status in ('running', 'lost'):
            with self.subTest(status=status):
                self.con.execute("UPDATE runs SET status=?,end_at=1000", (status,))
                self.con.commit()
                with patch.object(runs, 'recorded_exit', return_value=None), \
                        patch.object(runs, 'remote_alive', return_value='alive'), \
                        patch.object(lease, '_reuse') as reuse, patch.object(lease, 'acquire_private') as create, \
                        patch.dict('os.environ', {'OFFBOX_POOL_SIZE':'1'}), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(pool.PoolBusyError):
                        pool.acquire(self.me)
                    reuse.assert_not_called()
                    create.assert_not_called()
                self.assertEqual(lease.active_runs(self.con, 'bx'), 1)

    def test_follow_lost_waits_for_exit_and_honors_deadline(self):
        from test_wait_lock import Clock, FastEvent
        clock = Clock()
        class Tick(FastEvent):
            def wait(self, seconds):
                clock.t += seconds
                return self.is_set()
        log = common.LOGS_DIR / 'run-t.log'
        for code in (0, 1):
            with self.subTest(code=code), patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', clock.now), \
                    patch.object(api, 'cmd_attach', side_effect=OSError('lost stream')), \
                    patch.object(runs, 'recorded_exit', side_effect=[None, code]) as read, \
                    patch.object(runs, 'remote_alive', return_value='alive'):
                self.assertEqual(runs.follow('bx', 7, log, echo=False, run_id='run-t', stop_evt=Tick()), code)
                self.assertEqual(read.call_count, 2)
        with patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', clock.now), \
                patch.object(api, 'cmd_attach', side_effect=OSError('lost stream')), \
                patch.object(runs, 'recorded_exit', side_effect=common.OffboxError('SSH failed')):
            with self.assertRaises(common.OffboxError) as caught:
                runs.follow('bx', 7, log, echo=False, run_id='run-t', stop_evt=Tick(), until=clock.t+10)
            self.assertEqual(caught.exception.code, common.EXIT_WAIT_TIMEOUT)
            self.assertEqual(self.row()['status'], 'running')

    def test_wait_confirmed_gone_returns_90(self):
        from test_wait_lock import FastEvent
        with patch.object(runs, '_ttl_keeper'), patch.object(api, 'cmd_attach', side_effect=OSError('lost stream')), \
                patch.object(runs, 'recorded_exit', return_value=None), \
                patch.object(runs, 'remote_alive', return_value='gone'), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-t', 45), 90)
        self.assertEqual(self.row()['status'], 'lost')

    def test_recorded_exit_distinguishes_missing_from_failure(self):
        for rc, data, code in [(44,b'',None), (0,b'0\n',0), (0,b'1\n',1)]:
            with self.subTest(rc=rc,data=data), patch.object(runs.ssh_sync, 'ssh', return_value=subprocess.CompletedProcess([],rc,data)):
                self.assertEqual(runs.recorded_exit('bx','run-t'), code)
        for outcome in [subprocess.CompletedProcess([],255,b''), subprocess.CompletedProcess([],0,b'bad'), OSError('SSH failed')]:
            with self.subTest(outcome=outcome), patch.object(runs.ssh_sync,'ssh', **({'side_effect':outcome} if isinstance(outcome,Exception) else {'return_value':outcome})):
                with self.assertRaises(common.OffboxError):
                    runs.recorded_exit('bx','run-t')

    def test_remote_alive_protocol(self):
        for rc,data,expected in [(0,b'alive\n','alive'),(0,b'gone\n','gone'),(0,b'ended\n','ended'),(255,b'gone\n',None),(0,b'unknown\n',None)]:
            with self.subTest(rc=rc,data=data), patch.object(runs.ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],rc,data)):
                self.assertEqual(runs.remote_alive('bx','run-t'), expected)
        with patch.object(runs.ssh_sync,'ssh',side_effect=OSError('SSH failed')):
            self.assertIsNone(runs.remote_alive('bx','run-t'))

    def test_wrapper_writes_pid_before_script_and_prunes_it(self):
        import shlex
        script = shlex.split(runs.exit_recording_command('exit 3','run-t'))[2]
        self.assertLess(script.index('echo $$'),script.index('bash -lc'))
        self.assertIn('run-t.pid',script)
        self.assertIn('*.pid',script)

    def test_dry_reaper_does_not_write_lost_confirmation(self):
        for alive in ('alive','gone'):
            with patch.object(runs,'recorded_exit',return_value=None), patch.object(runs,'remote_alive',return_value=alive):
                reap._check_unlocked(self.con,'bx','running',True,[])
        self.assertEqual(self.row()['status'],'running')
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k LIKE 'lost_%'").fetchone())

    def test_confirmed_gone_frees_lease(self):
        with patch.object(runs,'recorded_exit',return_value=None), patch.object(runs,'remote_alive',return_value='gone'):
            reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual(lease.active_runs(self.con,'bx'),0)

    def test_lost_row_ssh_failure_remains_reserved(self):
        self.con.execute("UPDATE runs SET status='lost',end_at=1000")
        self.con.commit()
        self.assertEqual(lease.active_runs(self.con,'bx'),1)
        with patch.object(runs,'recorded_exit',side_effect=common.OffboxError('SSH failed')):
            pool._refresh_background(self.con,'repo')
        self.assertEqual(self.row()['status'],'running')
        self.assertEqual(lease.active_runs(self.con,'bx'),1)

    def test_real_shell_liveness_protocol(self):
        import os
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as home:
            base = Path(home)/'.offbox/exit'
            base.mkdir(parents=True)
            def ssh(box,command,**kwargs):
                return subprocess.run(['bash','-c',command],env={**os.environ,'HOME':home},capture_output=True,timeout=5)
            with patch.object(runs.ssh_sync,'ssh',side_effect=ssh):
                self.assertIsNone(runs.remote_alive('bx','run-t'))
                (base/'run-t.pid').write_text(str(os.getpid()))
                self.assertEqual(runs.remote_alive('bx','run-t'),'alive')
                (base/'run-t.rc').write_text('1\n')
                self.assertEqual(runs.remote_alive('bx','run-t'),'ended')
                self.assertEqual(runs.recorded_exit('bx','run-t'),1)
                (base/'run-t.rc').unlink()
                ended = subprocess.Popen(['true'])
                ended.wait()
                (base/'run-t.pid').write_text(str(ended.pid))
                self.assertEqual(runs.remote_alive('bx','run-t'),'gone')

    def test_lost_completion_catches_up_logs(self):
        with patch.object(runs,'recorded_exit',return_value=0):
            pool._refresh_background(self.con,'repo')
        misc._catch_up_finished.assert_called_with(self.con,'run-t')

    # Review matrix: kill delivery [failed, successful] x wrapper [alive, gone, ended, unknown];
    # history [available, 404, timeout] x SSH [saved rc, live, gone];
    # recovered rows [with pulls, without] x lock [free, held] x deadline [open, expired].
    def test_kill_lost_requires_remote_confirmation(self):
        for alive, expected in [('alive',1),(None,1),('gone',0)]:
            with self.subTest(alive=alive):
                self.con.execute("UPDATE runs SET status='running',end_at=NULL")
                self.con.commit()
                with patch.object(api,'cmd_kill',side_effect=common.OffboxError('kill timed out')), \
                        patch.object(runs,'recorded_exit',return_value=None), \
                        patch.object(runs,'remote_alive',return_value=alive), \
                        contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.kill_run('run-t'),expected)
                self.assertEqual(self.row()['status'],'running' if expected else 'killed')
                if expected:
                    self.assertEqual(lease.active_runs(self.con,'bx'),1)

    def test_history_errors_still_allow_saved_exit_and_never_prove_loss(self):
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        for error in [api.ApiError(404,'not_found','history expired'),common.OffboxError('history timed out')]:
            with self.subTest(error=error),patch.object(api,'history_get',side_effect=error), \
                    patch.object(runs,'recorded_exit',return_value=0):
                self.assertEqual(runs.confirmed_lost('bx','run-t')['exitCode'],0)
            with patch.object(api,'history_get',side_effect=error), \
                    patch.object(runs,'recorded_exit',return_value=None),patch.object(runs,'remote_alive',return_value='gone'):
                self.assertIsNone(runs.confirmed_lost('bx','run-t'))

    def test_recovered_pulls_finish_before_terminal_status_and_retry_on_interrupt(self):
        self.con.execute("UPDATE runs SET status='lost',end_at=1000,pulls='[\"out.txt\"]'")
        self.con.commit()
        def pull(*args,**kwargs):
            self.assertEqual(self.row()['status'],'lost')
            self.assertEqual(lease.active_runs(self.con,'bx'),1)
            raise KeyboardInterrupt()
        with patch.object(runs,'recorded_exit',return_value=0), patch.object(runs,'do_pulls',side_effect=pull):
            with self.assertRaises(KeyboardInterrupt):
                misc.wait('run-t',45)
        self.assertEqual(self.row()['status'],'lost')
        with patch.object(runs,'recorded_exit',return_value=0), patch.object(runs,'do_pulls') as pulls, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-t',45),0)
            pulls.assert_called_once()
        self.assertEqual(self.row()['status'],'done')

    def test_recovered_pull_is_bounded_by_wait_deadline(self):
        from test_wait_lock import Clock
        clock=Clock()
        self.con.execute("UPDATE runs SET status='lost',end_at=1000,pulls='[\"out.txt\"]',local_cwd='/tmp'")
        self.con.commit()
        def pull(*args,**kwargs):
            self.assertLessEqual(kwargs['timeout'],1)
            clock.t+=kwargs['timeout']
            return {'ok':True}
        with patch.object(runs,'now',clock.now), patch.object(misc,'now',clock.now), \
                patch.object(runs,'recorded_exit',return_value=0),patch.object(runs.ssh_sync,'pull',side_effect=pull):
            with self.assertRaises(common.OffboxError) as caught:
                misc.wait('run-t',1)
        self.assertEqual(caught.exception.code,common.EXIT_WAIT_TIMEOUT)
        self.assertEqual(clock.t,1001)
        self.assertEqual(self.row()['status'],'lost')
        self.assertEqual(lease.active_runs(self.con,'bx'),1)

    def test_held_lock_lost_row_waits_instead_of_returning_90(self):
        from test_wait_lock import Clock
        clock=Clock()
        self.con.execute("UPDATE runs SET status='lost',end_at=1000")
        self.con.commit()
        with common.file_lock('box-bx',timeout=0), patch.object(misc,'now',clock.now), \
                patch.object(runs,'now',clock.now),patch.object(misc,'time',clock.time), \
                patch.object(runs,'recorded_exit',return_value=None), \
                patch.object(runs,'remote_alive',return_value='alive'),contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError) as caught:
                misc.wait('run-t',1)
        self.assertEqual(caught.exception.code,common.EXIT_WAIT_TIMEOUT)
        self.assertEqual(lease.active_runs(self.con,'bx'),1)

    def test_stopped_lost_row_does_not_reserve_box(self):
        self.con.execute("UPDATE runs SET status='lost',end_at=1000")
        self.con.commit()
        reap._check_unlocked(self.con,'bx',api.STOPPED_STATES[0],False,[])
        self.assertEqual(lease.active_runs(self.con,'bx'),0)

    def test_history_timeout_leaves_budget_for_exit_file(self):
        from test_wait_lock import Clock
        clock=Clock()
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        def history(*args):
            clock.t+=api.left()
            raise common.OffboxError('history timeout')
        with patch.object(api,'time',clock.time),patch.object(runs,'now',clock.now), \
                patch.object(api,'history_get',side_effect=history), \
                patch.object(runs,'recorded_exit',return_value=0) as read:
            self.assertEqual(runs.confirmed_lost('bx','run-t',20)['exitCode'],0)
            self.assertGreater(read.call_args.kwargs['timeout'],0)
            self.assertLess(clock.t,1020)

    def test_kill_does_not_replace_log_owned_by_follower(self):
        log=common.LOGS_DIR/'run-t.log'
        log.write_bytes(b'prefix\n')
        self.con.execute("INSERT INTO kv(k,v) VALUES ('lost_checked:run-t','1')")
        self.con.commit()
        with common.file_lock('box-bx',timeout=0),open(log,'ab') as writer, \
                patch.object(api,'cmd_kill'),patch.object(api,'cmd_status',return_value={'running':False,'status':'exited','exitCode':143}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-t'),0)
            writer.write(b'last line\n')
            writer.flush()
            self.assertEqual(log.read_bytes(),b'prefix\nlast line\n')
        misc._catch_up_finished.assert_not_called()

    def test_revived_run_keeps_deadline_through_final_pull(self):
        from test_wait_lock import Clock
        clock=Clock()
        self.con.execute("UPDATE runs SET status='lost',end_at=1000,pulls='[\"out.txt\"]',local_cwd='/tmp'")
        self.con.commit()
        def pull(*args,**kwargs):
            self.assertLessEqual(kwargs['timeout'],1)
            clock.t+=kwargs['timeout']
            return {'ok':True}
        with patch.object(runs,'now',clock.now),patch.object(misc,'now',clock.now), \
                patch.object(runs,'recorded_exit',return_value=None),patch.object(runs,'remote_alive',return_value='alive'), \
                patch.object(runs,'follow',return_value=0),patch.object(runs.ssh_sync,'pull',side_effect=pull):
            with self.assertRaises(common.OffboxError) as caught:
                misc.wait('run-t',1)
        self.assertEqual(caught.exception.code,common.EXIT_WAIT_TIMEOUT)
        self.assertEqual(clock.t,1001)
        self.assertEqual(self.row()['status'],'running')
        self.assertEqual(lease.active_runs(self.con,'bx'),1)

    def test_recovered_wedge_is_quarantined_at_every_entry(self):
        from test_box_wedged import EVIDENCE
        for entry in ('wait','pool','reaper'):
            with self.subTest(entry=entry):
                self.con.execute("UPDATE runs SET status='lost',end_at=1000,command_id='cmd-t',error=NULL")
                self.con.execute("UPDATE leases SET note=NULL,state='running'")
                self.con.commit()
                with patch.object(api,'history_get',return_value={'exitCode':97}), \
                        patch.object(api,'history_logs',return_value={'data':EVIDENCE,'done':True}), \
                        patch.object(lease,'stop_box',return_value=True),contextlib.redirect_stderr(io.StringIO()), \
                        contextlib.redirect_stdout(io.StringIO()):
                    if entry=='wait':
                        self.assertEqual(misc.wait('run-t',45),90)
                    elif entry=='pool':
                        pool._refresh_background(self.con,'repo')
                    else:
                        reap._check_unlocked(self.con,'bx','running',False,[])
                self.assertEqual(self.row()['status'],'infra')
                note=self.con.execute("SELECT note FROM leases WHERE box_id='bx'").fetchone()[0]
                self.assertTrue(note.startswith('box-wedged:'))
                self.assertEqual(lease.active_runs(self.con,'bx'),0)
                self.assertNotIn('bx',[r['box_id'] for r in pool.candidates(self.con,'repo',None,None)[0]])
