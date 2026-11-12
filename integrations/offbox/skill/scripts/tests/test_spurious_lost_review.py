"""Review regressions: exit publication races, stopped boxes and bounded marker setup.

State matrix:
- PID probe: alive / dead before rc / dead after rc publication; rc: absent / 0 / 1 / SSH error.
- Follow: live -> live / archived / deleted / unknown; history: no exit / saved 0 / saved 1 / unavailable.
- Startup: normal / hung mkdir / blocked PID write; command must only run after a successful marker write.
"""
import contextlib
import io
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from test_capacity import Isolated
from test_wait_lock import Clock, FastEvent
from offbox_lib import api, common, misc, runs, reap


class LostReviewFixture(Isolated):
    def setUp(self):
        super().setUp()
        self.box('bx', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,mode,pulls,start_at,remote_dir) "
                         "VALUES ('run-t','bx','running',7,'bg','[]',900,'w/old')")
        self.con.commit()
        self.stack.enter_context(patch.object(api,'cmd_status',return_value={'status':'lost','running':False}))
        self.stack.enter_context(patch.object(api,'get',return_value={'state':'running'}))
        self.stack.enter_context(patch.object(misc,'_catch_up_finished'))
        self.stack.enter_context(patch.object(misc,'_catch_up_log',return_value='complete'))
        self.stack.enter_context(patch('offbox_lib.lease.idle_ttl'))

    def row(self):
        return self.con.execute("SELECT * FROM runs WHERE run_id='run-t'").fetchone()


class LostReviewTests(LostReviewFixture):
    def test_exit_file_published_during_dead_pid_probe_is_collected(self):
        for code in (0, 1):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as home:
                base = Path(home)/'.offbox/exit'
                base.mkdir(parents=True)
                (base/'run-t.pid').write_text('123456')
                def ssh(box, command, **kwargs):
                    # The wrapper writes its exit after remote_alive's first test, just before kill -0 fails.
                    probe = f'kill() {{ printf "%s\\n" {code} > "$HOME/.offbox/exit/run-t.rc"; return 1; }}; '
                    return subprocess.run(['bash','-c',probe+command],env={**os.environ,'HOME':home},
                                          capture_output=True,timeout=5)
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
                self.con.execute("DELETE FROM kv WHERE k LIKE 'lost_%'")
                self.con.commit()
                with patch.object(runs.ssh_sync,'ssh',side_effect=ssh):
                    reap._check_unlocked(self.con,'bx','running',False,[])
                    self.assertEqual((self.row()['status'],self.row()['exit_code']),
                                     ('done' if code==0 else 'failed',code))
                    self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='lost_confirmed:run-t'").fetchone())
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(misc.wait('run-t',45),code)

    def test_dead_pid_second_exit_read_failure_remains_unknown(self):
        with patch.object(runs,'recorded_exit',side_effect=[None,common.OffboxError('SSH read failed')]), \
                patch.object(runs,'remote_alive',return_value='gone'):
            reap._check_unlocked(self.con,'bx','running',False,[])
        self.assertEqual(self.row()['status'],'running')
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='lost_confirmed:run-t'").fetchone())

    def test_follow_live_box_transition_to_stopped_or_deleted_settles(self):
        for final in ({'state':'archived'},None):
            with self.subTest(final=final):
                clock=Clock()
                class Tick(FastEvent):
                    def wait(self,seconds):
                        clock.t+=seconds
                        return self.is_set()
                with patch.object(runs,'now',clock.now),patch.object(misc,'now',clock.now), \
                        patch.object(runs,'QUIET_PROBE_S',1),patch.object(runs,'_ttl_keeper'), \
                        patch.object(api,'cmd_attach',side_effect=OSError('tracker lost')), \
                        patch.object(api,'get',side_effect=[{'state':'running'},final]) as state, \
                        patch.object(runs,'recorded_exit',side_effect=common.OffboxError('SSH unavailable')):
                    rc=runs.follow('bx',7,common.LOGS_DIR/'run-t.log',echo=False,run_id='run-t',
                                   stop_evt=Tick(),until=clock.t+5)
                self.assertIsNone(rc)
                self.assertGreaterEqual(state.call_count,2)
                self.assertLess(clock.t,1005)
                self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='lost_confirmed:run-t'").fetchone())
                self.con.execute("DELETE FROM kv WHERE k LIKE 'lost_%'")
                self.con.commit()

    def test_follow_stopped_box_returns_retained_history_exit_first(self):
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        for code in (0,1):
            with self.subTest(code=code),patch.object(runs,'_ttl_keeper'), \
                    patch.object(api,'cmd_attach',side_effect=OSError('tracker lost')), \
                    patch.object(api,'history_get',return_value={'exitCode':code}), \
                    patch.object(api,'get') as state,patch.object(runs,'recorded_exit') as read:
                self.assertEqual(runs.follow('bx',7,common.LOGS_DIR/'run-t.log',echo=False,
                                            run_id='run-t',stop_evt=FastEvent()),code)
                state.assert_not_called()
                read.assert_not_called()


class MarkerStartupTests(unittest.TestCase):
    def run_wrapper(self, home, *, hang_mkdir=False):
        home=Path(home)
        tools=home/'bin'
        tools.mkdir()
        (tools/'systemctl').write_text('#!/bin/bash\necho inactive\nexit 3\n')
        (tools/'systemctl').chmod(0o755)
        if hang_mkdir:
            (tools/'mkdir').write_text('#!/bin/bash\nexec /bin/sleep 30\n')
            (tools/'mkdir').chmod(0o755)
        script='echo PREAMBLE; echo USER_COMMAND'
        cmd=runs.exit_recording_command(script,'run-t')
        proc=subprocess.Popen(shlex.split(cmd),env={**os.environ,'HOME':str(home),'PATH':str(tools)+':'+os.environ['PATH']},
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        started=time.monotonic()
        try:
            stdout,stderr=proc.communicate(timeout=7)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid,signal.SIGKILL)
            proc.communicate()
            self.fail('wrapper blocked before reaching bounded preamble')
        return proc,stdout,stderr,time.monotonic()-started

    def test_hung_startup_directory_is_quarantined_without_running_command(self):
        with tempfile.TemporaryDirectory() as home:
            proc,out,err,elapsed=self.run_wrapper(home,hang_mkdir=True)
            self.assertEqual(proc.returncode,97,err)
            self.assertIn(b'offbox-box-wedged:',err)
            self.assertNotIn(b'PREAMBLE',out)
            self.assertNotIn(b'USER_COMMAND',out)
            self.assertLess(elapsed,6)

    def test_blocked_startup_pid_write_is_quarantined_without_running_command(self):
        with tempfile.TemporaryDirectory() as home:
            base=Path(home)/'.offbox/exit'
            base.mkdir(parents=True)
            os.mkfifo(base/'run-t.pid')
            proc,out,err,elapsed=self.run_wrapper(home)
            self.assertEqual(proc.returncode,97,err)
            self.assertIn(b'offbox-box-wedged:',err)
            self.assertNotIn(b'USER_COMMAND',out)
            self.assertLess(elapsed,6)

    def test_marker_contains_parent_wrapper_pid(self):
        with tempfile.TemporaryDirectory() as home:
            proc,out,err,_=self.run_wrapper(home)
            self.assertEqual(proc.returncode,0,err)
            self.assertEqual(int((Path(home)/'.offbox/exit/run-t.pid').read_text()),proc.pid)
            self.assertIn(b'USER_COMMAND',out)

class FollowSettlementTests(LostReviewFixture):
    def test_wait_transition_to_archived_or_deleted_returns_90(self):
        real_follow=runs.follow
        for final in ({'state':'archived'},None):
            with self.subTest(final=final):
                clock=Clock()
                class Tick(FastEvent):
                    def wait(self,seconds):
                        clock.t+=seconds
                        return self.is_set()
                def follow(*args,**kwargs):
                    return real_follow(*args,**kwargs,stop_evt=Tick())
                self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
                self.con.execute("DELETE FROM kv WHERE k LIKE 'lost_%'")
                self.con.commit()
                with patch.object(runs,'now',clock.now),patch.object(misc,'now',clock.now), \
                        patch.object(runs,'QUIET_PROBE_S',1),patch.object(runs,'_ttl_keeper'), \
                        patch.object(api,'cmd_attach',side_effect=OSError('tracker lost')), \
                        patch.object(api,'get',side_effect=[{'state':'running'},final]), \
                        patch.object(runs,'recorded_exit',side_effect=common.OffboxError('SSH unavailable')) as read, \
                        patch.object(runs,'follow',side_effect=follow),contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(misc.wait('run-t',5),90)
                    self.assertEqual(read.call_count,1)
                self.assertEqual(self.row()['status'],'lost')

    def test_unavailable_ssh_on_live_or_unknown_box_does_not_settle(self):
        for box in ({'state':'running'},common.OffboxError('API unavailable')):
            with self.subTest(box=box):
                clock=Clock()
                class Tick(FastEvent):
                    def wait(self,seconds):
                        clock.t+=seconds
                        return self.is_set()
                opts={'side_effect':box} if isinstance(box,Exception) else {'return_value':box}
                with patch.object(runs,'now',clock.now),patch.object(runs,'QUIET_PROBE_S',1), \
                        patch.object(runs,'_ttl_keeper'),patch.object(api,'cmd_attach',side_effect=OSError('tracker lost')), \
                        patch.object(api,'get',**opts), \
                        patch.object(runs,'recorded_exit',side_effect=common.OffboxError('SSH unavailable')):
                    with self.assertRaises(common.OffboxError) as caught:
                        runs.follow('bx',7,common.LOGS_DIR/'run-t.log',echo=False,run_id='run-t',
                                    stop_evt=Tick(),until=clock.t+5)
                self.assertEqual(caught.exception.code,common.EXIT_WAIT_TIMEOUT)
                self.assertEqual(self.row()['status'],'running')
                self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='lost_confirmed:run-t'").fetchone())

    def test_deleted_box_without_retained_history_settles(self):
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        with patch.object(runs,'_ttl_keeper'),patch.object(api,'cmd_attach',side_effect=OSError('tracker lost')), \
                patch.object(api,'history_get',side_effect=api.ApiError(404,'not_found','history expired')), \
                patch.object(api,'get',return_value=None),patch.object(runs,'recorded_exit') as read, \
                contextlib.redirect_stderr(io.StringIO()),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-t',5),90)
            read.assert_not_called()
        self.assertEqual(self.row()['status'],'lost')

    def test_history_transport_failure_on_stopped_box_remains_unknown(self):
        self.con.execute("UPDATE runs SET command_id='cmd-t'")
        self.con.commit()
        with patch.object(api,'history_get',side_effect=common.OffboxError('API timeout')), \
                patch.object(api,'get',return_value={'state':'archived'}):
            self.assertIsNone(runs.confirmed_lost('bx','run-t',check_box=True))
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='lost_confirmed:run-t'").fetchone())
