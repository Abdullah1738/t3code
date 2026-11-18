"""Setup crashes exclude a box without touching its live work or replaying user commands."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import offbox_disk_space as disk
import toollog
from offbox_lib import api, box_disk, cli, common, lease, misc, native_crash, pool, runs, ssh_sync, unfit
from test_capacity import Isolated


def marker(reason='toolchain_unpack_crash'):
    return disk.MARKER + json.dumps(dict(phase='toolchain', infra_failure='native_crash', infra_reason=reason)) + '\n'


class SuspectTests(Isolated):
    def setUp(self):
        super().setUp()
        self.output = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('unexpected API call')))
        self.stack.enter_context(patch.object(ssh_sync, 'ssh', return_value=subprocess.CompletedProcess([], 1, b'', b'')))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state':'running'}))
        self.stop = self.stack.enter_context(patch.object(lease, 'stop_box', side_effect=AssertionError('must not stop')))
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_LOG_DIR=str(Path(self.tmp.name)/'tool-log')))
        self.me['repo_root'] = self.tmp.name

    def row(self, box):
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (box,)).fetchone()

    def events(self, kind):
        return [json.loads(r[0]) for r in self.con.execute('SELECT detail FROM events WHERE kind=?', (kind,))]

    def run_fixture(self, *, no_retry=False):
        for box in ('bxA', 'bxB'):
            self.box(box, member=True)
        rows = [dict(self.row(b), remote_dir='w/r') for b in ('bxA', 'bxB')]
        acquire = self.stack.enter_context(patch.object(pool, 'acquire', side_effect=rows))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.node_version, 'want', return_value=None))
        self.stack.enter_context(patch.object(runs.Runner, '_check_box', return_value=None))
        self.stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.stack.enter_context(patch.object(ssh_sync, 'push', return_value={}))
        start = self.stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7, 'commandId': 'c'}))
        def stream(rn):
            rn.log_path.write_text('offbox-command-started: run\n')
            return 0
        self.stack.enter_context(patch.object(runs.Runner, 'stream', stream))
        self.stack.enter_context(patch.object(runs, 'follow', return_value=runs._COMMAND_RUNNING))
        def stderr(box,command,which,offset=0,**kw):
            if which=='stdout': return dict(data='',done=True,nextOffset=0)
            row=self.con.execute('SELECT log_path FROM runs WHERE box_id=? ORDER BY rowid DESC',(box,)).fetchone()
            data=Path(row['log_path']).read_text() if row and row['log_path'] else ''
            return dict(data=data,done=True,nextOffset=len(data.encode()))
        self.stack.enter_context(patch.object(api,'history_logs',side_effect=stderr))
        self.a = cli.build_parser().parse_args(['run', *(['--no-retry'] if no_retry else []), '--', 'make check'])
        self.a.cmd, self.a.steps = ['make check'], []
        return acquire, start

    def crash_stream(self, reason, *, second=False, started=False):
        def stream(rn):
            if rn.box == 'bxA' or second:
                rn.log_path.write_text(marker(reason) + ('offbox-command-started: run\n' if started else ''))
                return 90
            rn.log_path.write_text('offbox-command-started: run\n')
            return 0
        return stream

    def test_native_reasons_retry_once_elsewhere_and_preserve_options(self):
        for reason in ('toolchain_unpack_crash', 'setup_native_crash', 'go_inventory_crash', 'future_native_reason'):
            with self.subTest(reason=reason):
                self.con.execute('DELETE FROM leases'); self.con.execute('DELETE FROM pool_members')
                self.con.execute('DELETE FROM runs'); self.con.execute('DELETE FROM kv'); self.con.execute('DELETE FROM events')
                acquire, start = self.run_fixture()
                self.a.template='generic'; self.a.base='warm'
                with patch.object(api, 'BACKEND', 'server'), patch.object(runs.Runner, 'stream', self.crash_stream(reason)):
                    self.assertEqual(runs.run_remote(self.a, self.me), 0)
                self.assertEqual(acquire.call_count, 2)
                self.assertIn('bxA', acquire.call_args.kwargs['exclude'])
                self.assertEqual(acquire.call_args.kwargs['template'], 'generic')
                self.assertEqual(acquire.call_args.kwargs['base'], 'warm')
                mark=unfit.get(self.con,'bxA')
                self.assertEqual(mark['reason'], reason)
                self.assertEqual(mark['source'], 'auto')
                self.assertEqual(mark['expires_at'] - mark['since'], 86400)
                moved=self.events('run_moved_off_suspect')[0]
                self.assertEqual((moved['from_box'],moved['to_box']),('bxA','bxB'))
                self.assertNotEqual(moved['old_run_id'],moved['new_run_id'])
                self.assertEqual(len(self.events('box_suspect_set')),1)
                self.stop.assert_not_called()

    def test_second_crash_marks_second_box_without_third_attempt(self):
        acquire, start=self.run_fixture()
        with patch.object(api,'BACKEND','server'), patch.object(runs.Runner,'stream', self.crash_stream('setup_native_crash', second=True)):
            with self.assertRaisesRegex(common.OffboxError, 'suspect box kept'):
                runs.run_remote(self.a,self.me)
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(start.call_count,2)
        self.assertEqual(len(self.events('box_suspect_set')),2)

    def test_after_started_native_marks_without_retry(self):
        acquire, _=self.run_fixture()
        with patch.object(api,'BACKEND','server'), patch.object(runs.Runner,'stream',self.crash_stream('setup_native_crash',started=True)):
            self.assertEqual(runs.run_remote(self.a,self.me),90)
        self.assertEqual(acquire.call_count,1)
        self.assertTrue(unfit.get(self.con,'bxA'))

    def test_started_native_exit_matrix_never_claims_nothing_ran(self):
        from itertools import product
        for reason,code,user_sig in product(('toolchain_unpack_crash','setup_native_crash','go_inventory_crash'),
                                            (0,1,90,139),(False,True)):
            with self.subTest(reason=reason,code=code,user_sig=user_sig):
                for table in ('runs','leases','pool_members','kv','events'):
                    self.con.execute('DELETE FROM '+table)
                acquire,start=self.run_fixture()
                def stream(rn):
                    rn.log_path.write_text(marker(reason)+'offbox-command-started: run\n'+
                                           ('SIGSEGV in user command\n' if user_sig else 'user output\n'))
                    return code
                buf=io.StringIO()
                with patch.object(api,'BACKEND','server'),patch.object(runs.Runner,'stream',stream), \
                     contextlib.redirect_stdout(buf),contextlib.redirect_stderr(buf):
                    self.assertEqual(runs.run_remote(self.a,self.me),code)
                self.assertEqual((acquire.call_count,start.call_count),(1,1))
                row=self.con.execute("SELECT * FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
                state=common.read_json(runs.LOGS_DIR/f"{row['run_id']}.state.json",{})
                after_start=code>=128 or code!=0 and user_sig
                self.assertEqual(state['infra_reason'],'native_crash_after_start' if after_start else reason if code==90 else None)
                if after_start: self.assertIn(native_crash.AFTER_START,buf.getvalue())
                self.assertNotIn('nothing ran',buf.getvalue().lower())
                self.assertTrue(unfit.get(self.con,'bxA'))

    def test_interleaved_frames_and_paginated_history_preserve_after_start_evidence(self):
        from itertools import product
        for marker_parts,split_signal,stream,page in product((1,2,30),(False,True),('stdout','stderr'),(32,4096)):
            with self.subTest(marker_parts=marker_parts,split_signal=split_signal,stream=stream,page=page):
                self.reset_late_fixture()
                path,_=self.late_row(status='running',code=None)
                frames=[]; streams={'stdout':'','stderr':''}
                def frame(which,data):
                    streams[which]+=data
                    frames.append(dict(type=which,data=data,nextOffset=len(streams[which])))
                frame('stderr',marker('go_inventory_crash')+'SIGSEGV during setup\n')
                started='offbox-command-started: run-late\n'
                width=max(1,len(started)//marker_parts)
                for at in range(0,len(started),width):
                    frame('stderr',started[at:at+width]); frame('stdout','noise\n')
                for data in (('SIG','SEGV\n') if split_signal else ('SIGSEGV\n',)):
                    frame(stream,data); frame('stderr' if stream=='stdout' else 'stdout','other stream\n')
                summary=dict(phase='result',attempt=1,record=dict(disk_space={},infra_failure=None,setup_native_crash=True))
                frame('stderr',disk.MARKER+json.dumps(summary)+'\n')
                frames.append(dict(type='exit',exitCode=1))
                def history(box,command,which,offset=0,**kw):
                    text=streams[which]
                    end=min(len(text),offset+page)
                    return dict(data=text[offset:end],nextOffset=end,done=end==len(text))
                with patch.object(api,'BACKEND','server'),patch.object(api,'cmd_attach',return_value=iter(frames)), \
                     patch.object(api,'history_logs',side_effect=history),patch.object(runs,'_ttl_keeper'), \
                     patch('offbox_lib.home_run_observation.observe'):
                    self.assertEqual(runs.follow('late-box',7,path,echo=False,run_id='run-late'),1)
                    # Repair must work even if a prior client saved a plain failure from the display log.
                    self.con.execute("UPDATE runs SET status='failed',exit_code=1 WHERE run_id='run-late'")
                    self.con.commit()
                    row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
                    current=native_crash.readback(row,1,path,report=True)
                self.assertEqual((current['status'],current['exit_code']),('infra',1))
                state=common.read_json(runs.LOGS_DIR/'run-late.state.json',{})
                self.assertEqual(state['infra_reason'],'native_crash_after_start')
                self.assertTrue(unfit.get(self.con,'late-box'))

    def test_confirmed_kill_during_native_readback_never_moves(self):
        for background in (False,True):
            for remote_code in (137,143):
                with self.subTest(background=background,remote_code=remote_code):
                    for table in ('runs','leases','pool_members','kv','events'):
                        self.con.execute('DELETE FROM '+table)
                    acquire,start=self.run_fixture()
                    self.a.bg=background
                    rid='run-cancelled'
                    if background: os.environ[runs.BACKGROUND_RUN_ENV]=rid
                    else: os.environ.pop(runs.BACKGROUND_RUN_ENV,None)
                    original=native_crash.before_start
                    def cancel(row,code,path):
                        with patch.object(api,'cmd_kill',return_value={}), \
                             patch.object(api,'cmd_status',return_value={'running':False,'status':'exited','exitCode':remote_code}), \
                             patch.object(misc,'_require_my_run'):
                            self.assertEqual(misc.kill_run(row['run_id']),0)
                        self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?',
                                                              (row['run_id'],)).fetchone()),('killed',143))
                        return original(row,code,path)
                    def follow(box,pid,path,**kw):
                        path.write_text(marker('setup_native_crash'))
                        return 90
                    with patch.object(api,'BACKEND','server'),patch.object(runs.home,'take_invocation_run',return_value=rid), \
                         patch.object(runs.Runner,'stream',self.crash_stream('setup_native_crash')), \
                         patch.object(native_crash,'before_start',side_effect=cancel), \
                         patch.object(runs,'follow',side_effect=follow):
                        self.assertEqual(runs.run_remote(self.a,self.me),143)
                    self.assertEqual(acquire.call_count,1)
                    self.assertEqual(start.call_count,1)
                    self.assertEqual(self.events('run_moved_off_suspect'),[])

    def test_incomplete_or_started_stderr_never_authorizes_retry(self):
        self.box('b')
        row={'box_id':'b','run_id':'r','command_id':'c'}
        path=runs.LOGS_DIR/'r.log'; path.write_text(marker())
        for value in (None, marker()+'offbox-command-started: r\n', 'unrelated'):
            with self.subTest(value=value), patch.object(runs,'complete_stderr',return_value=value):
                self.assertFalse(native_crash.before_start(row,90,path))

    def test_setup_fallback_matrix(self):
        self.box('b')
        for setup,code,expected,infra in ((True,0,True,None),(True,139,True,'native_crash_after_start'),(False,139,False,None)):
            rid=f'r{setup}{code}'; path=runs.LOGS_DIR/f'{rid}.log'; path.write_text('offbox-command-started: r\n')
            runs.save_run_state(rid,setup_native_crash=setup)
            unfit.clear(self.con,'b')
            native_crash.settle({'run_id':rid,'box_id':'b'},code,path,report=True)
            self.assertEqual(bool(unfit.get(self.con,'b')),expected)
            state=common.read_json(runs.LOGS_DIR/f'{rid}.state.json',{})
            self.assertEqual(state.get('infra_reason'),infra)
            self.assertEqual(runs.space_result(rid,code,path),code)
            self.assertEqual(common.read_json(runs.LOGS_DIR/f'{rid}.state.json',{}).get('infra_reason'),infra)
        self.assertIn(native_crash.AFTER_START,self.output.getvalue())

    def test_other_infra_does_not_mark(self):
        self.box('b')
        for reason in ('enospc','boot_timeout'):
            path=runs.LOGS_DIR/f'{reason}.log'
            path.write_text(disk.MARKER+json.dumps(dict(phase='toolchain',infra_failure=reason,infra_reason=reason)))
            self.assertFalse(native_crash.settle({'box_id':'b','run_id':reason},90,path))
        self.assertIsNone(unfit.get(self.con,'b'))

    def test_pool_full_and_not_full_and_expired_auto(self):
        self.box('b',member=True)
        for cap in ('1','2'):
            with patch.dict(os.environ,OFFBOX_POOL_SIZE=cap):
                unfit.set_mark(self.con,'b','crash',source='auto',run_id='r')
                self.assertEqual(pool.members(self.con,'repo'),[])
                rows,room=pool.candidates(self.con,'repo',None,None,self.me)
                self.assertEqual(rows,[]); self.assertTrue(room)
        mark=unfit.get(self.con,'b')
        with patch.object(common,'now',return_value=mark['expires_at']+1):
            self.assertEqual(len(pool.members(self.con,'repo')),1)
        self.assertIsNone(unfit.get(self.con,'b'))
        self.assertTrue(self.events('box_suspect_cleared')[-1]['expired'])

    def test_manual_mark_clear_survives_note_rewrite_live_run_untouched(self):
        self.box('b',member=True); self.busy('b')
        self.con.execute("UPDATE leases SET owner=? WHERE box_id='b'",(self.me['owner'],))
        unfit.command(self.me,'b','suspect','inspection')
        self.con.execute("UPDATE leases SET note='box-wedged: unconfirmed keeper TTL PATCH' WHERE box_id='b'")
        self.assertIsNone(unfit.get(self.con,'b')['expires_at'])
        unfit.set_mark(self.con,'b','crash',source='auto',run_id='r')
        self.assertEqual(unfit.get(self.con,'b')['source'],'manual')
        unfit.command(self.me,'b','clear')
        self.assertIsNone(unfit.get(self.con,'b'))
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-b'").fetchone()[0],'running')
        self.stop.assert_not_called()

    def test_skip_event_is_per_run_and_reaches_rollup_and_listing(self):
        self.box('b',member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('run-fixture','b','queued')")
        self.con.commit()
        unfit.set_mark(self.con,'b','native_crash')
        token=pool._PIN_SKIPS.set({'run':'run-fixture','boxes':set()})
        self.addCleanup(pool._PIN_SKIPS.reset,token)
        with contextlib.nullcontext():
            pool.members(self.con,'repo'); pool.members(self.con,'repo')
        self.assertEqual(len(self.events('box_skipped_suspect')),1)
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf): misc.run_events('run-fixture',True)
        self.assertEqual(json.loads(buf.getvalue())[0]['kind'],'box_skipped_suspect')
        files=list(toollog.directory().glob('*.ndjson'))
        self.assertTrue(any('box_skipped_suspect' in f.read_text() for f in files))

    def test_event_listing_resolves_exact_and_short_ids_without_settling_runs(self):
        self.box('b')
        self.con.executemany("INSERT INTO runs(run_id,box_id,status) VALUES (?,'b','running')",
                             [('prefix-run-fixture',),('run-fixture',)])
        for rid in ('prefix-run-fixture','run-fixture'):
            common.event(self.con,'b','fixture',json.dumps({'run_id':rid}))
        self.con.commit()
        with patch.object(misc,'_run_row',side_effect=AssertionError('must not settle')):
            for ident in ('run-fixture','fixture','prefix-run-fixture'):
                buf=io.StringIO()
                with contextlib.redirect_stdout(buf): misc.run_events(ident,True)
                rows=json.loads(buf.getvalue())
                self.assertEqual(len(rows),1)
                want='run-fixture' if ident=='run-fixture' else 'prefix-run-fixture'
                self.assertEqual(json.loads(rows[0]['detail'])['run_id'],want)
        self.assertEqual(self.con.execute("SELECT DISTINCT status FROM runs").fetchone()[0],'running')
        with patch.object(misc,'require_mine',side_effect=common.NotYours('wrong owner',code=2)):
            with self.assertRaises(common.NotYours): misc.run_events('run-fixture',True)

    def test_cli_and_status_surfaces(self):
        self.box('b',member=True); unfit.set_mark(self.con,'b','inspect')
        for argv in (['box','suspect','b','--reason','inspect'], ['box','clear','b'], ['ps'], ['doctor']):
            self.assertTrue(cli.parse_args(argv).sub)
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf): misc.list_leases(self.me,True,False)
        self.assertIn('suspect: inspect',buf.getvalue())

    def test_bg_retry_retains_public_id_and_archives_old_evidence(self):
        acquire,_=self.run_fixture()
        self.a.bg=True
        rid='run-bg'; os.environ[runs.BACKGROUND_RUN_ENV]=rid
        def follow(box,pid,path,**kw):
            path.write_text(marker('setup_native_crash') if box=='bxA' else 'offbox-command-started: run\n')
            return 90 if box=='bxA' else 0
        with patch.object(runs.home,'take_invocation_run',return_value=rid), patch.object(api,'BACKEND','server'), \
             patch.object(runs.Runner,'stream',self.crash_stream('setup_native_crash')), patch.object(runs,'follow',side_effect=follow):
            # Bypass the normal detach point to exercise both completed setup attempts.
            with patch.object(lease,'ensure_ttl',return_value=True):
                self.assertEqual(runs.run_remote(self.a,self.me),0)
        self.assertEqual(acquire.call_count,2)
        moved=self.events('run_moved_off_suspect')[0]
        self.assertEqual(moved['old_run_id'],moved['new_run_id'])

    def test_expiry_during_queue_snapshot_does_not_break_read_transaction(self):
        self.box('b',member=True)
        mark=unfit.set_mark(self.con,'b','crash',source='auto',run_id='r')
        with patch.object(common,'now',return_value=mark['expires_at']+1):
            pool.queue_state(self.con,'repo','queued')
        self.assertFalse(self.con.in_transaction)

    def test_no_retry_marks_but_does_not_move(self):
        acquire,_=self.run_fixture(no_retry=True)
        with patch.object(api,'BACKEND','server'), patch.object(runs.Runner,'stream',self.crash_stream('toolchain_unpack_crash')):
            with self.assertRaises(common.OffboxError): runs.run_remote(self.a,self.me)
        self.assertEqual(acquire.call_count,1)
        self.assertTrue(unfit.get(self.con,'bxA'))

    def test_structured_setup_marker_fallback_zero_and_sigsegv(self):
        self.box('b')
        for code in (0,1,139):
            rid=f'r-structured-{code}'; path=runs.LOGS_DIR/f'{rid}.log'
            path.write_text(marker('setup_native_crash')+'offbox-command-started: r\nSIGSEGV\n')
            native_crash.settle({'box_id':'b','run_id':rid},code,path)
            self.assertTrue(unfit.get(self.con,'b'))
            state=common.read_json(runs.LOGS_DIR/f'{rid}.state.json',{})
            self.assertEqual(state.get('infra_reason'), 'native_crash_after_start' if code else None)
            self.assertEqual(runs.space_result(rid,code,path),code)

    def test_authoritative_attempt_keeps_any_reason_and_ignores_earlier_crash(self):
        path=runs.LOGS_DIR/'attempt.log'
        for reason in ('setup_native_crash','go_inventory_crash'):
            record=dict(disk_space={},infra_failure='native_crash',infra_reason=reason)
            path.write_text(disk.MARKER+json.dumps(dict(phase='result',attempt=1,record=record))+'\n')
            self.assertEqual(disk.result(path,90)['infra_reason'],reason)
        path.write_text(disk.MARKER+json.dumps(dict(phase='attempt',attempt=1))+'\n'+marker()+
                        disk.MARKER+json.dumps(dict(phase='result',attempt=2,record=dict(disk_space={},infra_failure=None)))+'\n')
        self.assertIsNone(disk.result(path,90)['infra_failure'])

    def test_native_retry_budget_survives_reentry_after_acquisition_outage(self):
        acquire,start=self.run_fixture()
        rows=[dict(self.row(b),remote_dir='w/r') for b in ('bxA','bxB')]
        acquire.side_effect=[rows[0],common.OffboxError('temporary outage',outage=True),rows[1]]
        with patch.object(api,'BACKEND','server'), patch.object(runs.Runner,'stream',self.crash_stream('setup_native_crash',second=True)):
            with self.assertRaisesRegex(common.OffboxError,'temporary outage'):
                runs.run_remote(self.a,self.me)
            with self.assertRaisesRegex(common.OffboxError,'suspect box kept'):
                runs.run_remote(self.a,self.me)
        self.assertEqual(start.call_count,2)
        self.assertEqual(acquire.call_count,3)
        self.assertEqual(len(self.events('box_suspect_set')),2)

    def late_row(self, *, status='failed', code=139):
        self.box('late-box')
        path=runs.LOGS_DIR/'run-late.log'; path.write_text('')
        self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,exit_code,process_id,command_id,log_path,cmd) "
                         "VALUES ('run-late','late-box',?,'bg',?,7,'c',?,'make check')",(status,code,str(path)))
        def catchup(*args,**kw):
            path.write_text(marker('setup_native_crash')+'offbox-command-started: run-late\n')
            return 'complete'
        return path,catchup

    def test_late_home_history_reclassifies_an_already_failed_background_run(self):
        from offbox_lib import start_check
        path,catchup=self.late_row()
        with patch.object(api,'BACKEND','server'), patch.object(misc,'_catch_up_finished',side_effect=catchup):
            self.assertEqual(runs.finish('run-late',139,bookkeeping=False),139)
            self.assertEqual(runs.finish('run-late',139,bookkeeping=False),139)
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
        self.assertEqual(row['status'],'infra')
        self.assertEqual(row['exit_code'],139)
        self.assertEqual(unfit.get(self.con,'late-box')['reason'],'native_crash_after_start')
        self.assertEqual(common.read_json(runs.LOGS_DIR/'run-late.state.json',{})['infra_reason'],'native_crash_after_start')

    def test_late_recovery_preserves_confirmed_kill(self):
        from offbox_lib import start_check
        path,catchup=self.late_row(status='killed',code=143)
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
        with patch.object(misc,'_catch_up_finished',side_effect=catchup):
            start_check.settle(self.con,row,start_check.Result('started',143),'late receipt')
        current=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
        self.assertEqual((current['status'],current['exit_code']),('killed',143))
        self.assertIsNone(unfit.get(self.con,'late-box'))

    def test_terminal_logs_and_wait_classify_recovered_setup_evidence(self):
        for entry in ('logs','wait'):
            with self.subTest(entry=entry):
                self.con.execute('DELETE FROM runs'); self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM kv'); self.con.execute('DELETE FROM events')
                path,catchup=self.late_row()
                with patch.object(misc,'_catch_up_log',side_effect=catchup), \
                     patch.object(misc,'_require_my_run'), \
                     patch('offbox_lib.home_run_observation.notice'), \
                     patch.object(runs,'killed_result',return_value=None):
                    code=misc.logs('run-late',False) if entry=='logs' else misc.wait('run-late',None)
                self.assertEqual(code,90 if entry=='logs' else 139)
                row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
                self.assertEqual((row['status'],row['exit_code']),('infra',139))
                self.assertEqual(unfit.get(self.con,'late-box')['reason'],'native_crash_after_start')
                self.assertIn(native_crash.AFTER_START,self.output.getvalue())

    def test_readback_rechecks_a_kill_recorded_after_the_callers_snapshot(self):
        path,catchup=self.late_row()
        stale=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
        self.con.execute("UPDATE runs SET status='killed',exit_code=143 WHERE run_id='run-late'")
        catchup()
        current=native_crash.readback(stale,139,path,report=True)
        self.assertEqual((current['status'],current['exit_code']),('killed',143))
        self.assertIsNone(unfit.get(self.con,'late-box'))

    def reset_late_fixture(self):
        for table in ('runs','leases','kv','events'):
            self.con.execute('DELETE FROM '+table)
        (runs.LOGS_DIR/'run-late.state.json').unlink(missing_ok=True)

    def test_readback_database_failures_preserve_known_results_without_replay_advice(self):
        import sqlite3
        connect=common.db
        for phase in ('connect','SELECT','INSERT','UPDATE'):
            for code in (0,139):
                if phase=='UPDATE' and code==0: continue
                with self.subTest(phase=phase,code=code):
                    self.reset_late_fixture()
                    path,catchup=self.late_row(status='done' if code==0 else 'failed',code=code)
                    faults=[]
                    def fail():
                        faults.append(phase)
                        raise sqlite3.OperationalError('injected readback failure')
                    def broken():
                        if phase=='connect': fail()
                        con=connect(); execute=con.execute
                        def query(sql,*args):
                            if sql.startswith(phase): fail()
                            return execute(sql,*args)
                        con.execute=query
                        return con
                    err=io.StringIO()
                    with patch.object(common,'db',side_effect=broken),patch.object(misc,'_catch_up_log',side_effect=catchup), \
                         patch.object(misc,'_require_my_run'),patch.object(runs,'killed_result',return_value=None), \
                         patch('offbox_lib.home_run_observation.notice'),contextlib.redirect_stderr(err):
                        self.assertEqual(misc.wait('run-late',None),code)
                    self.assertTrue(faults)
                    self.assertIn('do not rerun the command',err.getvalue())
                    self.assertNotIn('nothing ran',err.getvalue())
                    self.assertEqual(self.con.execute("SELECT exit_code FROM runs WHERE run_id='run-late'").fetchone()[0],code)

    def test_setup_signal_keeps_wrapper_exit_when_step_tail_is_incomplete(self):
        for entry in ('finish','wait'):
            for code in (1,137,139,143):
                with self.subTest(entry=entry,code=code):
                    self.reset_late_fixture()
                    path,_=self.late_row(status='running',code=None)
                    self.con.execute("UPDATE runs SET step_count=2,known_exit_code=? WHERE run_id='run-late'",(code,))
                    path.write_text(marker('setup_native_crash')+'offbox-command-started: run-late\nSIGSEGV\noffbox step 1 rc=0: a\n')
                    if entry=='wait': self.con.execute("UPDATE runs SET status='infra' WHERE run_id='run-late'")
                    with patch.object(misc,'_catch_up_log',return_value='complete'),patch.object(misc,'_require_my_run'), \
                         patch.object(runs,'killed_result',return_value=None),patch('offbox_lib.home_run_observation.notice'):
                        result=runs.finish('run-late',code,bookkeeping=False) if entry=='finish' else misc.wait('run-late',None)
                    self.assertEqual(result,code)
                    row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
                    self.assertEqual((row['status'],row['exit_code']),('infra',code))
                    state=common.read_json(runs.LOGS_DIR/'run-late.state.json',{})
                    self.assertEqual(state['infra_reason'],'native_crash_after_start')
                    self.assertTrue(unfit.get(self.con,'late-box'))

    def test_sigsegv_text_before_command_start_is_not_a_user_crash(self):
        self.box('b')
        for code,user_sig in ((90,False),(1,False),(1,True)):
            with self.subTest(code=code,user_sig=user_sig):
                rid=f'signal-position-{code}-{user_sig}'
                path=runs.LOGS_DIR/f'{rid}.log'
                text=marker('setup_native_crash')+'SIGSEGV during setup\n'
                if code!=90: text+='offbox-command-started: run\n'+('SIGSEGV in user command\n' if user_sig else 'ordinary failure\n')
                path.write_text(text)
                native_crash.settle({'run_id':rid,'box_id':'b'},code,path)
                state=common.read_json(runs.LOGS_DIR/f'{rid}.state.json',{})
                self.assertEqual(state.get('infra_reason'),'setup_native_crash' if code==90 else
                                 'native_crash_after_start' if user_sig else None)

    def test_backend_routing_uses_only_parsed_box_or_event_target(self):
        from itertools import product
        owners={'bx_home':'server','bx_boat':'boat','run-home':'server','run-boat':'boat'}
        def known(backend,ident,*,suffix):
            return any(backend==owner and (name.endswith(ident) if suffix else name==ident) for name,owner in owners.items())
        with patch.object(common,'backend_pinned',return_value=None),patch.object(common,'home_config',return_value={}), \
             patch.object(common,'_known',side_effect=known):
            for first in ('boat','server'):
                with patch.object(common,'default_backend',return_value=first):
                    for target,action,option in product(('bx_home','bx_boat'),('suspect','clear','release-disk-full'),
                                                      ('--r','--re','--rea','--reas','--reaso','--reason')):
                        decoy='bx_boat' if target=='bx_home' else 'bx_home'
                        for form in ([option,decoy],[option+'='+decoy]):
                            for argv in (['box',*form,action,target],['box',action,*form,target],['box',action,target,*form]):
                                with self.subTest(argv=argv,first=first):
                                    self.assertEqual(common.entry_backend(argv),owners[target])
                    for target in ('run-home','run-boat','home','boat'):
                        want='server' if target.endswith('home') else 'boat'
                        for argv in (['events',target,'--json'],['events','--j',target],['events','--json','--',target]):
                            with self.subTest(argv=argv,first=first):
                                self.assertEqual(common.entry_backend(argv),want)

    def test_authoritative_setup_only_summary_is_sufficient_evidence(self):
        self.box('b')
        for code in (0,139):
            rid=f'summary-{code}'; path=runs.LOGS_DIR/f'{rid}.log'
            record=dict(disk_space={},infra_failure=None,setup_native_crash=True)
            path.write_text(disk.MARKER+json.dumps(dict(phase='result',attempt=1,record=record))+'\n')
            self.assertTrue(disk.result(path,code)['setup_native_crash'])
            native_crash.settle({'run_id':rid,'box_id':'b'},code,path)
            self.assertTrue(unfit.get(self.con,'b'))
            saved=common.read_json(runs.LOGS_DIR/f'{rid}.state.json',{})
            self.assertEqual(saved.get('infra_reason'),'native_crash_after_start' if code else None)

    def test_finish_preserves_setup_evidence_available_only_in_state(self):
        path,_=self.late_row()
        runs.save_run_state('run-late',setup_native_crash=True)
        self.assertEqual(runs.finish('run-late',139,catch_up=False,bookkeeping=False),139)
        state=common.read_json(runs.LOGS_DIR/'run-late.state.json',{})
        self.assertTrue(state['setup_native_crash'])
        self.assertEqual(state['infra_reason'],'native_crash_after_start')
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-late'").fetchone()[0],'infra')

    def test_expired_mark_race_returns_replacement_manual_hold(self):
        self.box('b')
        mark=unfit.set_mark(self.con,'b','old',source='auto',run_id='r')
        clear=unfit.clear
        def race(con,box,**kw):
            unfit.set_mark(con,box,'manual inspection')
            return clear(con,box,**kw)
        with patch.object(common,'now',return_value=mark['expires_at']+1),patch.object(unfit,'clear',side_effect=race):
            self.assertFalse(unfit.available(self.con,'b'))
        self.assertEqual(unfit.get(self.con,'b')['source'],'manual')

    def test_mark_and_event_roll_back_together_on_event_failure(self):
        import sqlite3
        self.box('b')
        self.con.execute("CREATE TEMP TRIGGER reject_set BEFORE INSERT ON events WHEN NEW.kind='box_suspect_set' "
                         "BEGIN SELECT RAISE(ABORT,'event failure'); END")
        with self.assertRaisesRegex(sqlite3.Error,'event failure'):
            unfit.set_mark(self.con,'b','crash',source='auto',run_id='r')
        self.assertIsNone(unfit.get(self.con,'b'))
        self.assertFalse(self.events('box_suspect_set'))
        self.con.execute('DROP TRIGGER reject_set')
        unfit.set_mark(self.con,'b','crash',source='auto',run_id='r')
        self.assertEqual(len(self.events('box_suspect_set')),1)
        self.con.execute("CREATE TEMP TRIGGER reject_clear BEFORE INSERT ON events WHEN NEW.kind='box_suspect_cleared' "
                         "BEGIN SELECT RAISE(ABORT,'event failure'); END")
        with self.assertRaisesRegex(sqlite3.Error,'event failure'): unfit.clear(self.con,'b')
        self.assertTrue(unfit.get(self.con,'b'))
        self.assertFalse(self.events('box_suspect_cleared'))

    def test_old_readback_never_reinstates_an_expired_or_cleared_mark(self):
        path,catchup=self.late_row()
        catchup()
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-late'").fetchone()
        for reason in ('clear','expire','manual'):
            with self.subTest(reason=reason):
                self.con.execute('DELETE FROM kv'); self.con.execute('DELETE FROM events')
                if reason=='manual': unfit.set_mark(self.con,'late-box','inspection')
                native_crash.readback(row,139,path)
                mark=unfit.get(self.con,'late-box')
                stamp=mark['since']
                if reason=='expire':
                    with patch.object(common,'now',return_value=stamp+86401):
                        self.assertIsNone(unfit.get(self.con,'late-box'))
                        native_crash.readback(row,139,path)
                else:
                    unfit.clear(self.con,'late-box')
                    native_crash.readback(row,139,path)
                self.assertIsNone(unfit.get(self.con,'late-box'))
                self.assertEqual(len(self.events('box_suspect_set')),1)
                unfit.set_mark(self.con,'late-box','new crash',source='auto',run_id='new-run')
                self.assertTrue(unfit.get(self.con,'late-box'))

    def test_pending_suspect_does_not_fence_a_new_allocation(self):
        from offbox_lib import allocation
        self.box('bad',state='stopped',member=True)
        common.kv_set(self.con,'resume_unanswered:bad','large')
        unfit.set_mark(self.con,'bad','inspection')
        self.assertFalse(allocation.abandoned_resumes(self.con,'repo'))
        with allocation.scope('repo'),allocation.guard():
            pass
        def create(*args):
            self.box('new',member=True)
            return dict(self.row('new'))
        with patch.dict(os.environ,OFFBOX_POOL_SIZE='1'),patch.object(lease,'acquire_private',side_effect=create) as send:
            got=pool.acquire(self.me,run_id='replacement')
            pool.release_guard(got)
        self.assertEqual(got['box_id'],'new')
        self.assertEqual(send.call_count,1)
        self.assertTrue(common.kv_get(self.con,'resume_unanswered:bad'))
        self.assertEqual(self.row('bad')['state'],'stopped')
        self.stop.assert_not_called()

    def test_pending_suspect_does_not_fence_a_healthy_resume(self):
        from offbox_lib import allocation
        self.box('bad',member=True); self.box('healthy',state='stopped',member=True)
        common.kv_set(self.con,'resume_unanswered:bad','large')
        unfit.set_mark(self.con,'bad','inspection')
        with allocation.scope('repo'),allocation.guard('healthy'):
            pass
        with patch.object(lease,'_reuse',side_effect=lambda c,r,*a,**kw:dict(r)) as reuse:
            got=pool.acquire(self.me)
            pool.release_guard(got)
        self.assertEqual(got['box_id'],'healthy')
        self.assertTrue(all(call.args[1]['box_id']=='healthy' for call in reuse.call_args_list))
        self.assertTrue(common.kv_get(self.con,'resume_unanswered:bad'))
        self.stop.assert_not_called()

    def test_pending_scan_reaches_healthy_peers_in_any_order(self):
        from itertools import chain, permutations, product
        orders=chain(permutations(('bad','healthy-a','healthy-b')),permutations(('bad','bad-b','healthy-a')))
        for order,cap in product(orders,(2,4)):
            with self.subTest(order=order,cap=cap):
                for table in ('leases','pool_members','kv','events','pool_callers'):
                    self.con.execute('DELETE FROM '+table)
                for box in order:
                    self.box(box,state='stopped',member=True)
                    common.kv_set(self.con,'resume_unanswered:'+box,'large')
                    self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?,'')",('resume_sender:'+box,))
                self.con.commit()
                for box in order:
                    if box.startswith('bad'): unfit.set_mark(self.con,box,'inspection')
                def ready(box,**kw):
                    self.assertFalse(box.startswith('bad'))
                    return dict(id=box,state='running',type='large',heldRuns=[])
                with patch.dict(os.environ,OFFBOX_BACKEND='server',OFFBOX_POOL_SIZE=str(cap)), \
                     patch.object(common,'_BACKEND','server'),patch.object(api,'BACKEND','server'), \
                     patch.object(api,'readiness_get',side_effect=ready) as read, \
                     patch.object(api,'resume',side_effect=AssertionError('already resumed')), \
                     patch.object(lease,'acquire_private',side_effect=AssertionError('use healthy peer')), \
                     patch.object(ssh_sync,'setup'),patch.object(ssh_sync,'wait_ssh'),patch.object(lease,'run_recipe'):
                    got=pool.acquire(self.me,run_id='replacement')
                    pool.release_guard(got)
                self.assertEqual(got['box_id'],next(box for box in order if not box.startswith('bad')))
                self.assertGreater(read.call_count,0)
                self.assertTrue(common.kv_get(self.con,'resume_unanswered:bad'))
                self.assertEqual(self.row('bad')['state'],'stopped')
                self.stop.assert_not_called()

    def test_free_text_reason_shapes_stay_out_of_metadata_and_argv_logs(self):
        from offbox_lib.redact import redact_argv
        shapes=['API_TOKEN=fake-secret-224', 'https://user:fake-pass@example.test/?token=fake-key',
                'line one\nAUTHORIZATION: Bearer fake-bearer-224','manual inspection','setup_native_crash']
        for reason in shapes:
            with self.subTest(reason=reason):
                props=toollog._props(dict(reason=reason,source='manual',trigger='manual',kind='suspect'),name='box_suspect_set')
                self.assertEqual(props['reason'],'setup_native_crash' if reason=='setup_native_crash' else 'other')
                self.assertEqual(props['reasonLength'],len(reason))
                for option in ('--reason','--r','--rea'):
                    for form in ([option,reason],[option+'='+reason]):
                        safe=redact_argv(['box','suspect','b',*form])
                        self.assertNotIn(reason,str(safe))
        for action in ('suspect','clear','release-disk-full'):
            for option in ('--r','--re','--rea','--reas','--reaso','--reason'):
                for form in ([option,shapes[0]],[option+'='+shapes[0]]):
                    for argv in (['box',*form,action,'b'],['box',action,*form,'b'],['box',action,'b',*form]):
                        with self.subTest(argv=argv):
                            self.assertEqual(cli.parse_args(argv).action,action)
                            self.assertNotIn(shapes[0],str(redact_argv(argv)))
        self.box('b'); unfit.set_mark(self.con,'b',shapes[0])
        self.assertEqual(unfit.get(self.con,'b')['reason'],shapes[0])
        logged=common.LOG_PATH.read_text()+''.join(p.read_text() for p in toollog.directory().glob('*.ndjson'))
        self.assertNotIn('fake-secret-224',logged)
