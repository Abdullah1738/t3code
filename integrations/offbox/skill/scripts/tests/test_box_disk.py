"""A full pool box is cleaned or fenced before another user command can start."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import offbox_disk_space as disk
from offbox_lib import api, bases, box_disk, cli, common, fallback, lease, misc, pool, reap, runs, ssh_sync, start_check
from test_capacity import Isolated

_HTTP_CALL, _HTTP_GET = api.call, api.get


def space(tmp=4*disk.GIB, workspace=10*disk.GIB):
    return {key: dict(path=path, free_bytes=free, size_bytes=20*disk.GIB)
            for key, path, free in [('tmp', '/tmp', tmp), ('home', '/home/user', workspace),
                                    ('workspace', '/home/user/w/repo', workspace)]}


class BoxDiskTests(Isolated):
    def setUp(self):
        super().setUp()
        self.output = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline test reached API')))
        self.stack.enter_context(patch.object(box_disk, 'measure', return_value=space()))
        self.stack.enter_context(patch.object(box_disk, 'reclaim', return_value=space()))
        self.stack.enter_context(patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],1,b'',b'')))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.keep_ttl=self.stack.enter_context(patch.object(lease, 'ensure_ttl',return_value=True))
        self.stack.enter_context(patch.object(api,'get',return_value={'state':'running'}))
        self.stop = self.stack.enter_context(patch.object(lease, 'stop_box', return_value=True))
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
            self.assertEqual(which,'stderr')
            row=self.con.execute('SELECT log_path FROM runs WHERE box_id=? ORDER BY rowid DESC',(box,)).fetchone()
            data=Path(row['log_path']).read_text() if row and row['log_path'] else ''
            return dict(data=data,done=True,nextOffset=len(data.encode()))
        self.stack.enter_context(patch.object(api,'history_logs',side_effect=stderr))
        self.a = cli.build_parser().parse_args(['run', *(['--no-retry'] if no_retry else []), '--', 'make check'])
        self.a.cmd, self.a.steps = ['make check'], []
        return acquire, start

    def test_push_enospc_cleans_once_and_retries_same_box(self):
        acquire, start = self.run_fixture()
        error = common.OffboxError('rsync to bxA failed (23): mkdir "/home/user/w/r/packaging": No space left on device (28)')
        with patch.object(ssh_sync, 'push', side_effect=[error, {}]) as sync, \
             patch.object(box_disk, 'measure', return_value=space()), patch.object(box_disk.prune,'run') as prune:
            self.assertEqual(runs.run_remote(self.a, self.me), 0)
        self.assertEqual(box_disk.push_failure(error), ('workspace','/home/user/w/r/packaging'))
        self.assertEqual(acquire.call_count, 1)
        self.assertEqual(sync.call_count, 2)
        self.assertEqual(start.call_count, 1)
        prune.assert_called_once()
        self.assertEqual(self.events('box_disk_full')[0]['filesystem'], 'workspace')
        self.assertTrue(self.events('box_cleaned_disk_full')[0]['recovered'])

    def test_push_enospc_retires_and_moves_once(self):
        acquire, start = self.run_fixture()
        def sync(rn, *args):
            if rn.box == 'bxA':
                raise box_disk.Full('bxA','workspace',space(workspace=0))
        with patch.object(runs.Runner, '_sync_box', sync), \
             patch.object(box_disk, 'measure', side_effect=lambda box,*args:space(workspace=0) if box=='bxA' else space()), \
             patch.object(box_disk.prune,'run') as prune:
            self.assertEqual(runs.run_remote(self.a, self.me), 0)
        self.assertEqual(acquire.call_count, 2)
        self.assertEqual(start.call_count, 1)
        self.assertEqual(start.call_args.args[0], 'bxB')
        prune.assert_called_once()
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))
        self.assertIn('moved this run to another box', self.output.getvalue())

    def test_no_retry_marks_box_and_returns_90(self):
        acquire, start = self.run_fixture(no_retry=True)
        with patch.object(runs.Runner, '_sync_box', side_effect=box_disk.Full('bxA','tmp',space(tmp=4096))), \
             patch.object(box_disk, 'reclaim', return_value=space(tmp=4096)):
            with self.assertRaisesRegex(common.OffboxError, 'box marked disk_full') as caught:
                runs.run_remote(self.a, self.me)
        self.assertEqual(caught.exception.code, 90)
        self.assertEqual(acquire.call_count, 1)
        start.assert_not_called()
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))

    def test_picker_skips_marked_and_both_filesystems(self):
        for box in ('marked','home','tmp','ok'):
            self.box(box, member=True)
        box_disk.retire(self.con, 'marked', space(), 'tmp', stop=False)
        candidates, _ = pool.candidates(self.con, self.me['repo_key'], None, None, self.me)
        self.assertNotIn('marked', [r['box_id'] for r in candidates])
        with patch.object(box_disk, 'measure', side_effect=lambda b:space(workspace=0) if b=='home' else space(tmp=4096) if b=='tmp' else space()):
            self.assertFalse(box_disk.picker_ok(self.con, self.row('home')))
            self.assertFalse(box_disk.picker_ok(self.con, self.row('tmp')))
            self.assertTrue(box_disk.picker_ok(self.con, self.row('ok')))
        self.assertEqual(len(self.events('pool_skip_low_disk')), 2)
        self.assertEqual(len(pool.members(self.con, self.me['repo_key'])), 1)

    def test_measure_failure_does_not_fence_box(self):
        self.box('b',member=True)
        with patch.object(box_disk, 'measure', return_value={}):
            self.assertTrue(box_disk.picker_ok(self.con, self.row('b')))

    def test_release_restores_picker_eligibility(self):
        self.box('b',member=True)
        box_disk.retire(self.con,'b',space(tmp=0),'tmp',stop=False)
        args = cli.parse_args(['box','release-disk-full','b'])
        self.assertEqual(args.action,'release-disk-full')
        box_disk.release(self.me,'b')
        self.assertIsNone(self.row('b')['note'])
        self.assertTrue(box_disk.picker_ok(self.con,self.row('b')))

    def test_non_enospc_push_keeps_existing_failure(self):
        acquire, start = self.run_fixture()
        error=common.OffboxError('rsync failed (23): Permission denied (13)')
        with patch.object(runs.Runner,'_sync_box',side_effect=error), patch.object(box_disk.prune,'run') as prune:
            with self.assertRaisesRegex(common.OffboxError,'Permission denied'):
                runs.run_remote(self.a,self.me)
        self.assertIsNone(box_disk.push_failure(error))
        self.assertEqual(acquire.call_count,1)
        start.assert_not_called()
        prune.assert_not_called()
        self.assertFalse(self.events('box_disk_full'))

    def test_tmp_live_holder_kept_and_run_moves_without_dispatch(self):
        acquire,start=self.run_fixture()
        def sync(rn,*args):
            pass
        with patch.object(runs.Runner,'_sync_box',sync), \
             patch.object(box_disk,'measure',side_effect=lambda b,*a:space(tmp=4096) if b=='bxA' else space()), \
             patch.object(box_disk,'reclaim',return_value=space(tmp=4096)) as reclaim:
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        self.assertEqual(start.call_count,1)
        self.assertEqual(start.call_args.args[0],'bxB')
        self.assertEqual(acquire.call_count,2)
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))
        self.assertEqual(self.events('box_disk_full')[0]['filesystem'],'tmp')

    def test_detached_finish_reclaims_before_next_gate(self):
        self.box('b',member=True)
        self.busy('b')
        row=self.con.execute("SELECT * FROM runs WHERE box_id='b'").fetchone()
        free=[4096]
        def reclaim(con,box,**kw):
            self.assertIsNotNone(kw['finished_at'])
            free[0]=4*disk.GIB
            return space(tmp=free[0])
        with patch.object(box_disk,'reclaim',side_effect=reclaim) as cleaned, \
             patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
            runs.finish(row['run_id'],0,catch_up=False,bookkeeping=False)
            runs.finish(row['run_id'],0,catch_up=False)
        cleaned.assert_called_once()
        with patch.object(box_disk,'measure',return_value=space(tmp=free[0])):
            self.assertTrue(box_disk.picker_ok(self.con,self.row('b')))

    def test_actual_picker_moves_past_low_idle_box(self):
        self.box('bad', member=True, used=200)
        self.box('good', member=True, used=100)
        with patch.object(box_disk, 'measure', side_effect=lambda b,*a:space(tmp=4096) if b=='bad' else space()), \
             patch.object(lease, '_reuse', side_effect=lambda c,r,s,**kw:dict(r)):
            row=pool.acquire(self.me)
            try:
                self.assertEqual(row['box_id'],'good')
            finally:
                pool.release_guard(row)
        self.assertTrue(self.row('bad')['note'].startswith(box_disk.NOTE))
        self.assertEqual(len(self.events('pool_skip_low_disk')),1)

    def test_background_pre_command_retry_keeps_public_run_id(self):
        acquire,start=self.run_fixture()
        self.a.bg=True
        def sync(rn,*args):
            if rn.box=='bxA':
                raise box_disk.Full('bxA','tmp',space(tmp=4096))
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-disk-background'}), \
             patch.object(runs.Runner,'_sync_box',sync), \
             patch.object(box_disk,'reclaim',return_value=space(tmp=4096)), \
             patch.object(api,'get',return_value={'state':'running'}),patch.object(lease,'ensure_ttl',return_value=True):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(start.call_count,1)
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-disk-background'").fetchone()
        self.assertEqual(row['box_id'],'bxB')
        self.assertEqual(row['status'],'running')
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM runs').fetchone()[0],1)

    def test_disk_full_listing_and_status_show_both_filesystems(self):
        self.box('b',member=True)
        box_disk.retire(self.con,'b',space(tmp=4096),'tmp',stop=False)
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me,True,False)
        self.assertIn('disk_full',out.getvalue())
        self.assertIn('4096',out.getvalue())
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me,True,True)
        value=json.loads(out.getvalue())[0]
        self.assertTrue(value['disk_full'])
        self.assertEqual(value['disk_space']['tmp']['free_bytes'],4096)

    def test_background_guest_gate_retires_then_retries_without_starting_user_command(self):
        acquire,start=self.run_fixture()
        self.a.bg=True
        attempted=[]
        def admission(box,pid,path,**kw):
            attempted.append(box)
            if box=='bxA':
                path.write_text(disk.MARKER+json.dumps(dict(phase='gate',space=space(tmp=4096)))+'\n')
                return 90
            path.write_text('offbox-command-started: run-disk-gate\n')
            return runs._COMMAND_RUNNING
        def cleanup(*args,**kw):
            self.assertFalse([call for call in lifecycle.call_args_list if call.args[1] == 'handoff'])
            row=self.con.execute("SELECT * FROM runs WHERE run_id='run-disk-gate'").fetchone()
            self.assertEqual((row['status'],row['exit_code'],row['process_id']),('starting',None,None))
            with self.assertRaises(common.OffboxError) as timed_out:
                misc.wait('run-disk-gate',0)
            self.assertEqual(timed_out.exception.code,common.EXIT_WAIT_TIMEOUT)
            return space(tmp=4096)
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-disk-gate'}), \
             patch.object(runs.queue_lifecycle,'note',wraps=runs.queue_lifecycle.note) as lifecycle, \
             patch.object(runs,'follow',side_effect=admission), \
             patch.object(api,'get',return_value={'state':'running'}),patch.object(lease,'ensure_ttl',return_value=True), \
             patch.object(box_disk,'safe_to_stop',return_value=True), \
             patch.object(ssh_sync,'ssh',side_effect=AssertionError('retired box is stopped')) as receipt, \
             patch.object(box_disk,'reclaim',side_effect=cleanup):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        receipt.assert_not_called()
        self.stop.assert_called_once()
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(attempted,['bxA','bxB'])
        self.assertEqual(start.call_count,2)  # first wrapper exited at its disk gate, before the user marker
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-disk-gate'").fetchone()
        self.assertEqual((row['box_id'],row['status']),('bxB','running'))
        handoffs=[call for call in lifecycle.call_args_list if call.args[1] == 'handoff']
        self.assertEqual(len(handoffs),1)
        self.assertEqual(handoffs[0].args,('run-disk-gate','handoff','handoff'))
        self.assertEqual(handoffs[0].kwargs,dict(box_id='bxB',process_id=7))

    def _recovered_gate_case(self, backend, bg):
        acquire,start=self.run_fixture();self.a.bg=bg
        start.side_effect=[api.NetworkError('lost response'),{'processId':7,'commandId':'replacement'}]
        rid='run-recovered-gate'
        def catch_up(row,**kw):
            current=self.con.execute('SELECT * FROM runs WHERE run_id=?',(row['run_id'],)).fetchone()
            self.assertFalse(runs.terminal_result(runs.restore_run_state(current)))
            return 'n/a'
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:rid} if bg else {}), \
             patch.object(api,'BACKEND',backend),patch.object(start_check,'GRACE_S',0), \
             patch.object(start_check,'check',return_value=start_check.Result('started',90,1234)), \
             patch.object(misc,'_catch_up_log',side_effect=catch_up) as fetched, \
             patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],0,
                          json.dumps(dict(phase='gate',space=space(tmp=4096))).encode(),b'')) as receipt, \
             patch.object(box_disk,'reclaim',return_value=space(tmp=4096)), \
             patch.object(box_disk,'safe_to_stop',return_value=True):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        fetched.assert_called_once()
        self.assertEqual(sum(call.args[1].startswith('head -c 65536') for call in receipt.call_args_list),1)
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(start.call_count,2)
        self.assertEqual(len(self.events('box_disk_full')),1)
        self.assertIn('bxA',self.a._disk_exclude)
        row=self.con.execute("SELECT * FROM runs WHERE box_id='bxB'").fetchone()
        self.assertEqual((row['status'],row['exit_code']),('running',None) if bg else ('done',0))
        if bg:
            self.assertIsNone(runs.restore_run_state(row)['known_exit_code'])

    def test_background_recovered_gate_receipt_stays_pending_and_moves(self):
        self._recovered_gate_case('boat',True)

    def test_home_background_recovered_gate_receipt_moves(self):
        self._recovered_gate_case('server',True)

    def test_foreground_recovered_gate_receipt_moves(self):
        self._recovered_gate_case('boat',False)

    def test_home_foreground_recovered_gate_receipt_moves(self):
        self._recovered_gate_case('server',False)

    def _lost_gate_stream_case(self, backend, bg, partial=False):
        real_follow=runs.follow
        acquire,start=self.run_fixture();self.a.bg=bg
        gate=disk.MARKER+json.dumps(dict(phase='gate',space=space(tmp=4096)))+'\n'
        attaches=0
        class NoPause(runs.threading.Event):
            def wait(self,timeout=None):
                return self.is_set()
        def attach(box,*args,**kw):
            nonlocal attaches
            if box=='bxA':
                attaches+=1
                self.assertLessEqual(attaches,5,'attach kept replaying after the exit status')
                if partial:
                    def interrupted():
                        if args[2] == 0:
                            yield dict(type='stderr',data=gate)
                        raise api.NetworkError('attach lost after the gate record')
                    return interrupted()
                raise api.NetworkError('accepted start lost its attach stream')
            rid=self.con.execute("SELECT run_id FROM runs WHERE box_id='bxB'").fetchone()[0]
            return iter([dict(type='stderr',data=f'{runs.COMMAND_STARTED_MARKER} {rid}\n'),
                         dict(type='exit',exitCode=0)])
        def history(box,command,which,offset=0,**kw):
            if partial:
                raise common.OffboxError('retained history unavailable')
            data=gate if box=='bxA' and which=='stderr' else ''
            return dict(data=data[offset:],done=True,nextOffset=len(data))
        def catch_up(row,**kw):
            current=self.con.execute('SELECT * FROM runs WHERE run_id=?',(row['run_id'],)).fetchone()
            self.assertFalse(runs.terminal_result(runs.restore_run_state(current)))
            Path(row['log_path']).write_text(api.history_logs(row['box_id'],row['command_id'],'stderr')['data'])
            return 'complete'
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-lost-gate-stream'} if bg else {}), \
             patch.object(api,'BACKEND',backend), \
             patch.object(runs.Runner,'stream',lambda rn:real_follow(rn.box,rn.pid,rn.log_path,
                              echo=False,run_id=rn.run_id,stop_evt=NoPause())), \
             patch.object(runs,'follow',lambda *args,**kw:real_follow(*args,stop_evt=NoPause(),**kw)), \
             patch.object(api,'cmd_attach',side_effect=attach), \
             patch.object(api,'cmd_status',return_value=dict(status='exited',running=False,exitCode=90)), \
             patch.object(api,'history_logs',side_effect=history), \
             patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],0,
                          json.dumps(dict(phase='gate',space=space(tmp=4096))).encode(),b'')) as receipt, \
             patch.object(misc,'_catch_up_log',side_effect=catch_up) as fetched, \
             patch.object(box_disk,'reclaim',return_value=space(tmp=4096)), \
             patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        self.assertEqual(fetched.call_count,0 if partial else 1)
        receipt.assert_called_once()
        self.assertEqual(start.call_count,2)
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(len(self.events('box_disk_full')),1)
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))

    def test_boat_foreground_lost_gate_stream_moves(self):
        self._lost_gate_stream_case('boat',False)

    def test_home_foreground_lost_gate_stream_moves(self):
        self._lost_gate_stream_case('server',False)

    def test_boat_background_lost_gate_stream_moves(self):
        self._lost_gate_stream_case('boat',True)

    def test_home_background_lost_gate_stream_moves(self):
        self._lost_gate_stream_case('server',True)

    def test_boat_foreground_partial_gate_uses_receipt_when_history_unavailable(self):
        self._lost_gate_stream_case('boat',False,True)

    def test_home_foreground_partial_gate_uses_receipt_when_history_unavailable(self):
        self._lost_gate_stream_case('server',False,True)

    def test_boat_background_partial_gate_uses_receipt_when_history_unavailable(self):
        self._lost_gate_stream_case('boat',True,True)

    def test_home_background_partial_gate_uses_receipt_when_history_unavailable(self):
        self._lost_gate_stream_case('server',True,True)

    def test_user_start_evidence_overrides_even_a_valid_gate_receipt(self):
        rid='run-positive-start';path=runs.LOGS_DIR/f'{rid}.log'
        gate=disk.MARKER+json.dumps(dict(phase='gate',space=space(tmp=4096)))+'\n'
        row=dict(run_id=rid,box_id='b',command_id='c')
        proof=('tmp',None,space(tmp=4096))
        for location in ('local','complete_stderr','partial_stderr'):
            for receipt in (None,proof):
                with self.subTest(location=location,receipt=receipt is not None):
                    path.write_text(gate+(runs.COMMAND_STARTED_MARKER+' user\n' if location=='local' else ''))
                    page=dict(data=runs.COMMAND_STARTED_MARKER+' user\n',done=location=='complete_stderr')
                    with patch.object(api,'history_logs',return_value=page),patch.object(ssh_sync,'ssh') as ssh:
                        self.assertIsNone(runs.confirmed_disk_full(row,path,90,receipt))
                    ssh.assert_not_called()

    def _setup_enospc_case(self, backend, bg, code):
        acquire,start=self.run_fixture();self.a.bg=bg
        failed=[]
        def output(box,path):
            if box=='bxA':
                failed.append(box)
                marker=runs.SETUP_FAILED_MARKER if code==97 else runs.REPO_SETUP_FAILED_MARKER
                path.write_text(disk.MARKER+json.dumps(dict(phase='start',space=space(workspace=0)))+
                                '\nmkdir "/home/user/toolchain": No space left on device (28)\n'+marker+'\n')
                return code
            path.write_text(f'{runs.COMMAND_STARTED_MARKER} replacement\n')
            return runs._COMMAND_RUNNING if bg else 0
        def measure(box,*args,**kw):
            return space(workspace=0) if box=='bxA' and failed else space()
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-setup-full'} if bg else {}), \
             patch.object(api,'BACKEND',backend),patch.object(box_disk,'measure',side_effect=measure), \
             patch.object(runs.Runner,'stream',lambda rn:output(rn.box,rn.log_path)), \
             patch.object(runs,'follow',side_effect=lambda box,pid,path,**kw:output(box,path)), \
             patch.object(box_disk.prune,'run') as prune:
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        prune.assert_called_once()
        self.assertEqual(acquire.call_count,2)
        self.assertEqual(start.call_count,2)
        detail=self.events('box_disk_full')[0]
        self.assertEqual((detail['backend'],detail['filesystem'],detail['path']),
                         (backend,'workspace','/home/user/toolchain'))
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))
        self.assertEqual(failed,['bxA'])

    def test_boat_foreground_setup97_enospc_moves(self):
        self._setup_enospc_case('boat',False,97)

    def test_boat_foreground_setup98_enospc_moves(self):
        self._setup_enospc_case('boat',False,98)

    def test_boat_background_setup97_enospc_moves(self):
        self._setup_enospc_case('boat',True,97)

    def test_boat_background_setup98_enospc_moves(self):
        self._setup_enospc_case('boat',True,98)

    def test_home_foreground_setup97_enospc_moves(self):
        self._setup_enospc_case('server',False,97)

    def test_home_foreground_setup98_enospc_moves(self):
        self._setup_enospc_case('server',False,98)

    def test_home_background_setup97_enospc_moves(self):
        self._setup_enospc_case('server',True,97)

    def test_home_background_setup98_enospc_moves(self):
        self._setup_enospc_case('server',True,98)

    def test_setup_error_forms_and_user_command_boundary(self):
        path=runs.LOGS_DIR/'forms.log'
        cases=[
            ('No space left on device (28)','/home/user/pkg','workspace'),
            ('ENOSPC','/tmp/data','tmp'),
            ('os error 28','/tmp','tmp'),
            ('OSError: [Errno 28]','/home/user/pkg','workspace'),
            ('errno=28','/home/user/pkg','workspace'),
            ('errno: 28','/tmp/data','tmp'),
        ]
        for code in (1,90,97,98):
            for message,failed_path,fs in cases:
                for started in (False,True):
                    with self.subTest(code=code,message=message,started=started):
                        prefix=f'{runs.COMMAND_STARTED_MARKER} run\n' if started else ''
                        path.write_text(prefix+f'write "{failed_path}" failed: {message}\n')
                        failure=runs.pre_command_disk_full(path,code)
                        self.assertEqual(failure,None if started else (fs,failed_path,{}))
        for line in ('offbox: warning: ENOSPC', 'Permission denied (13)'):
            path.write_text(line+'\n')
            self.assertIsNone(runs.pre_command_disk_full(path,98))
        path.write_text('ENOSPC\n')
        self.assertIsNone(runs.pre_command_disk_full(path,0))

    def test_guest_gate_receipt_is_recoverable_and_next_start_clears_it(self):
        self.box('b',member=True);self.busy('b')
        home=Path(self.tmp.name)/'guest'
        receipt=home/'.offbox/exit/run-b.gate'
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-b'").fetchone()
        with patch.dict(os.environ,{'HOME':str(home),'OFFBOX_RUN_ID':'run-b'}), \
             patch.object(sys,'argv',['probe','start']), \
             patch.object(disk,'snapshot',return_value=space(tmp=4096)):
            with self.assertRaises(SystemExit) as gated:
                disk.probe()
        self.assertEqual(gated.exception.code,90)
        self.assertEqual(json.loads(receipt.read_text())['space']['tmp']['free_bytes'],4096)
        def ssh(box,command,**kw):
            return subprocess.run(['bash','-c',command],env=dict(os.environ,HOME=str(home)),
                                  capture_output=True,timeout=kw['timeout'])
        with patch.object(misc,'_catch_up_log',return_value='n/a'),patch.object(ssh_sync,'ssh',side_effect=ssh):
            runs.recover_admission_log(row,90)
        self.assertEqual(runs.pre_command_disk_full(runs.LOGS_DIR/'run-b.log',90),('tmp',None,space(tmp=4096)))
        with patch.dict(os.environ,{'HOME':str(home),'OFFBOX_RUN_ID':'run-b'}), \
             patch.object(sys,'argv',['probe','start']),patch.object(disk,'snapshot',return_value=space()):
            disk.probe()
        self.assertFalse(receipt.exists())

    def test_invalid_gate_receipt_cannot_authorize_retry(self):
        path=runs.LOGS_DIR/'run-invalid.log'
        row=dict(run_id='run-invalid',box_id='b',command_id=None)
        for record in ([],{},dict(phase='gate',space=None),dict(phase='gate',space={'tmp':'bad'}),
                       dict(phase='gate',space={'tmp':{'free_bytes':'0'}}),
                       dict(phase='gate',space={}),dict(phase='gate',space=space()),
                       dict(phase='gate',space=space(tmp=-1))):
            with self.subTest(record=record),patch.object(misc,'_catch_up_log',return_value='n/a'), \
                 patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],0,json.dumps(record).encode(),b'')):
                runs.recover_admission_log(row,90)
                self.assertFalse(path.exists())

    def test_setup_without_probe_measures_before_cleanup_event(self):
        self.box('b',member=True)
        with patch.object(box_disk,'measure',return_value=space()) as measured, \
             patch.object(box_disk.prune,'run'):
            healthy,after=box_disk.recover(self.con,'b','workspace',{},path='/home/user/toolchain')
        self.assertTrue(healthy)
        self.assertEqual(measured.call_count,2)
        self.assertEqual(self.events('box_disk_full')[0]['space'],space())

    def _interleaved_user_case(self, code):
        real_follow=runs.follow
        acquire,start=self.run_fixture()
        stderr=[runs.COMMAND_STARTED_MARKER[:15],runs.COMMAND_STARTED_MARKER[15:]+' user\nENOSPC\n'+
                runs.SETUP_FAILED_MARKER+'\n'+runs.REPO_SETUP_FAILED_MARKER+'\n']
        def frames(*args,**kw):
            yield dict(type='stderr',data=stderr[0])
            yield dict(type='stdout',data='interleaved stdout\n')
            yield dict(type='stderr',data=stderr[1])
            yield dict(type='exit',exitCode=code)
        with patch.object(runs.Runner,'stream',lambda rn:real_follow(rn.box,rn.pid,rn.log_path,
                          echo=False,run_id=rn.run_id)), \
             patch.object(api,'cmd_attach',side_effect=frames), \
             patch.object(api,'history_logs',return_value=dict(data=''.join(stderr),done=True)), \
             patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
            self.assertEqual(runs.run_remote(self.a,self.me),90)
        acquire.assert_called_once();start.assert_called_once()
        self.assertFalse(self.events('box_disk_full'))

    def test_interleaved_user_start_never_replays_exit1(self):
        self._interleaved_user_case(1)

    def test_interleaved_user_start_never_replays_setup97(self):
        self._interleaved_user_case(97)

    def test_interleaved_user_start_never_replays_setup98(self):
        self._interleaved_user_case(98)

    def test_setup_markers_after_user_start_never_allow_local_fallback(self):
        real_follow=runs.follow
        acquire,start=self.run_fixture()
        for code in (97,98):
            for split in (False,True):
                with self.subTest(code=code,split=split):
                    acquire.side_effect=None;acquire.return_value=dict(self.row('bxA'),remote_dir='w/r')
                    acquire.reset_mock();start.reset_mock()
                    stderr=(runs.COMMAND_STARTED_MARKER+' user\nENOSPC\n'+runs.SETUP_FAILED_MARKER+
                            '\n'+runs.REPO_SETUP_FAILED_MARKER+'\n')
                    def frames(*args,**kw):
                        yield dict(type='stderr',data=stderr[:15] if split else stderr)
                        if split:
                            yield dict(type='stdout',data='stdout\n')
                            yield dict(type='stderr',data=stderr[15:])
                        yield dict(type='exit',exitCode=code)
                    with patch.object(runs.Runner,'stream',lambda rn:real_follow(rn.box,rn.pid,rn.log_path,
                                      echo=False,run_id=rn.run_id)), \
                         patch.object(api,'cmd_attach',side_effect=frames), \
                         patch.object(api,'history_logs',return_value=dict(data=stderr,done=True)), \
                         patch.object(fallback,'allowed',return_value=True), \
                         patch.object(fallback,'run_local',return_value=0) as local, \
                         patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
                        self.assertEqual(cli._run_with_retries(self.a,self.me),90)
                    acquire.assert_called_once();start.assert_called_once();local.assert_not_called()
        self.assertFalse(self.events('box_disk_full'))

    def test_setup_fallback_requires_complete_stderr_without_user_start(self):
        acquire,start=self.run_fixture()
        for code,marker in ((97,runs.SETUP_FAILED_MARKER),(98,runs.REPO_SETUP_FAILED_MARKER)):
            for proof in ('complete','incomplete','unavailable'):
                with self.subTest(code=code,proof=proof):
                    acquire.side_effect=None;acquire.return_value=dict(self.row('bxA'),remote_dir='w/r')
                    acquire.reset_mock();start.reset_mock()
                    def stream(rn):
                        rn.log_path.write_text(marker+'\n')
                        return code
                    history=(common.OffboxError('unavailable') if proof=='unavailable' else
                             dict(data=marker+'\n',done=proof=='complete'))
                    with patch.object(runs.Runner,'stream',stream), \
                         patch.object(api,'history_logs',**({'side_effect':history} if isinstance(history,Exception)
                                                          else {'return_value':history})), \
                         patch.object(runs,'settle_box_wedged',return_value=None), \
                         patch.object(fallback,'allowed',return_value=True), \
                         patch.object(fallback,'run_local',return_value=0) as local, \
                         patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
                        self.assertEqual(cli._run_with_retries(self.a,self.me),0 if proof=='complete' else code)
                    self.assertEqual(local.call_count,int(proof=='complete'))
                    acquire.assert_called_once();start.assert_called_once()

    def test_complete_stderr_required_across_all_marker_partitions(self):
        path=runs.LOGS_DIR/'partitions.log'
        path.write_text('ENOSPC\n')
        marker=runs.COMMAND_STARTED_MARKER+' user\n'
        row=dict(run_id='user',box_id='b',command_id='c')
        for cut in range(1,len(marker)):
            pages=[dict(data=marker[:cut],done=False,nextOffset=cut),
                   dict(data=marker[cut:]+'ENOSPC\n',done=True)]
            with self.subTest(cut=cut),patch.object(api,'history_logs',side_effect=pages):
                self.assertIsNone(runs.confirmed_disk_full(row,path,1))
        for pages in ([dict(data='ENOSPC\n',done=False)],
                      [dict(data='x',done=False,nextOffset=n) for n in range(1,9)]):
            with self.subTest(incomplete=len(pages)),patch.object(api,'history_logs',side_effect=pages):
                self.assertIsNone(runs.confirmed_disk_full(row,path,1))
        with patch.object(api,'history_logs',side_effect=common.OffboxError('history unavailable')):
            self.assertIsNone(runs.confirmed_disk_full(row,path,1))
        self.assertIsNone(runs.confirmed_disk_full(dict(row,command_id=None),path,1))

    def test_background_cleanup_preserves_current_checkout_with_no_sync(self):
        acquire,start=self.run_fixture();self.a.bg=True;self.a.no_sync=True
        current='w/current-abcdef'
        acquire.side_effect=[dict(self.row('bxA'),remote_dir=current),dict(self.row('bxB'),remote_dir='w/other-123456')]
        self.con.execute("INSERT INTO runs(run_id,box_id,status,remote_dir,start_at) VALUES "
                         "('old','bxA','done',?,?)",(current,common.now()-4*86400))
        self.con.commit()
        def admission(box,pid,path,**kw):
            if box=='bxA':
                path.write_text('ENOSPC\n'+runs.REPO_SETUP_FAILED_MARKER+'\n')
                return 98
            return runs._COMMAND_RUNNING
        def prune(con,box,kept,**kw):
            self.assertEqual((box,kept),('bxA',current))
            self.assertNotIn(current,box_disk.prune.stale_dirs(con,box,kept))
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-warm-checkout'}), \
             patch.object(runs,'follow',side_effect=admission), \
             patch.object(box_disk.prune,'run',side_effect=prune) as cleaned, \
             patch.object(ssh_sync,'ssh',return_value=subprocess.CompletedProcess([],0,b'',b'')):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        cleaned.assert_called_once()
        self.assertEqual(start.call_count,2)

    def test_background_recovered_user_exit_90_is_not_retried(self):
        acquire,start=self.run_fixture();self.a.bg=True
        start.side_effect=api.NetworkError('lost response')
        rid='run-user-exit90'
        def catch_up(row,**kw):
            (runs.LOGS_DIR/f'{rid}.log').write_text(f'offbox-command-started: {rid}\n')
            return 'caught_up'
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:rid}), \
             patch.object(start_check,'GRACE_S',0), \
             patch.object(start_check,'check',return_value=start_check.Result('started',90,1234)), \
             patch.object(misc,'_catch_up_log',side_effect=catch_up), \
             patch.object(runs,'settle_docker'),patch.object(runs.resources,'finalize'):
            self.assertEqual(runs.run_remote(self.a,self.me),0)
        acquire.assert_called_once();start.assert_called_once()
        self.assertFalse(self.events('box_disk_full'))
        row=self.con.execute('SELECT * FROM runs WHERE run_id=?',(rid,)).fetchone()
        self.assertEqual((row['status'],row['exit_code']),('failed',90))

    def test_reaper_receipt_settlement_reclaims_tmp_once(self):
        self.box('b',member=True);self.busy('b')
        self.con.execute("UPDATE runs SET status='starting',start_at=?,mode='bg' WHERE run_id='run-b'",
                         (common.now()-3600,))
        self.con.execute("INSERT INTO kv(k,v) VALUES ('start_claim:run-b','claim-b')")
        self.con.commit()
        with patch.object(start_check,'check',return_value=start_check.Result('started',0,1234)), \
             patch.object(box_disk,'reclaim',return_value=space()) as reclaim, \
             patch.object(misc,'_catch_up_finished'),patch.object(runs.resources,'finalize'), \
             patch.object(runs,'settle_docker'):
            reap._check_stale_runs(self.con,'b',api.LIVE_STATES[0],False,[])
            runs.finish('run-b',0,catch_up=False,bookkeeping=False)
        reclaim.assert_called_once()
        self.assertIsNotNone(reclaim.call_args.kwargs['finished_at'])
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-b'").fetchone()
        self.assertEqual((row['status'],row['exit_code']),('done',0))

    def test_retry_archives_gate_and_offsets_before_replacement_user_failure(self):
        self.box('b',member=True);self.busy('b')
        self.con.execute("UPDATE runs SET client_pid=? WHERE run_id='run-b'",(os.getpid(),))
        self.con.commit()
        path=runs.LOGS_DIR/'run-b.log'
        gate=disk.MARKER+json.dumps(dict(phase='gate',space=space(tmp=4096)))+'\n'
        path.write_text(gate)
        common.offsets_path(path).write_text('{}')
        failure=box_disk.Full('b','tmp',space(tmp=4096));failure.run_id='run-b'
        runs.reset_disk_retry(failure)
        self.assertFalse(common.offsets_path(path).exists())
        self.assertEqual(next(path.parent.glob('run-b.log.disk-full-*')).read_text(),gate)
        path.write_text('offbox-command-started: run-b\nassertion failed\n')
        self.assertIsNone(disk.result(path,1)['infra_failure'])

    def test_mixed_disk_full_and_wedged_failure_returns_90(self):
        self.a=cli.build_parser().parse_args(['run','--','make check'])
        self.a.steps=[]
        full=box_disk.Full('full','tmp',space(tmp=4096))
        wedge=runs.BoxWedged('wedged','offbox-box-wedged: unavailable',True)
        with patch.object(runs,'_run_attempt',side_effect=[full,wedge]):
            with self.assertRaises(common.OffboxError) as caught:
                runs.run_remote(self.a,self.me)
        self.assertEqual(caught.exception.code,90)
        self.assertIn('replacement attempt',str(caught.exception))

    def test_background_no_retry_publishes_90_only_after_cleanup(self):
        acquire,start=self.run_fixture(no_retry=True);self.a.bg=True
        def admission(box,pid,path,**kw):
            path.write_text(disk.MARKER+json.dumps(dict(phase='gate',space=space(tmp=4096)))+'\n')
            return 90
        def cleanup(*args,**kw):
            row=self.con.execute("SELECT * FROM runs WHERE run_id='run-gate-no-retry'").fetchone()
            self.assertEqual((row['status'],row['exit_code']),('starting',None))
            return space(tmp=4096)
        with patch.dict(os.environ,{runs.BACKGROUND_RUN_ENV:'run-gate-no-retry'}), \
             patch.object(runs,'follow',side_effect=admission),patch.object(box_disk,'reclaim',side_effect=cleanup), \
             patch.object(ssh_sync,'ssh') as receipt:
            with self.assertRaises(common.OffboxError) as failure:
                runs.run_remote(self.a,self.me)
        self.assertEqual(failure.exception.code,90)
        receipt.assert_not_called()
        acquire.assert_called_once();start.assert_called_once()
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-gate-no-retry'").fetchone()
        self.assertEqual((row['status'],row['exit_code']),('infra',90))
        self.assertTrue(self.row('bxA')['note'].startswith(box_disk.NOTE))

    def test_handback_respects_expired_wait_deadline(self):
        self.box('b',member=True);self.busy('b')
        row=self.con.execute("SELECT * FROM runs WHERE box_id='b'").fetchone()
        with patch.object(box_disk,'reclaim') as reclaim,patch.object(runs.resources,'finalize'):
            runs.finish(row['run_id'],0,until=common.now()-1,catch_up=False,bookkeeping=False)
        reclaim.assert_not_called()

    def test_disk_full_pinned_retention_can_refresh_without_reentering_pool(self):
        self.box('b',member=True,state='stopped')
        box_disk.retire(self.con,'b',space(tmp=4096),'tmp',stop=False)
        with patch.object(lease,'_resume_confirmed') as resume, \
             patch.object(api,'wait_state'),patch.object(api,'stop'),patch.object(lease.capacity,'check'):
            lease.refresh_box(self.con,'b')
        resume.assert_called_once()
        self.assertFalse(pool.members(self.con,self.me['repo_key']))
        self.assertTrue(self.row('b')['note'].startswith(box_disk.NOTE))

    def test_reaper_schedules_pinned_disk_full_retention(self):
        self.box('b',member=True,state='stopped')
        self.con.execute('UPDATE leases SET pinned_until=? WHERE box_id=?',(common.now()+86400,'b'))
        self.con.commit()
        box_disk.retire(self.con,'b',space(tmp=4096),'tmp',stop=False)
        with patch.object(api,'list_boxes',return_value=[dict(id='b',state=api.STOPPED_STATES[0],
                           stoppedAt='2026-10-01T00:00:00Z')]), \
             patch.object(bases,'upkeep'),patch.object(lease,'refresh_box') as refresh, \
             patch.object(bases,'keep_pin_saved',return_value=True) as saved:
            reap.reap(False)
        refresh.assert_not_called()
        saved.assert_called_once()
        self.assertEqual(saved.call_args.args[1],'b')
        self.assertTrue(self.row('b')['note'].startswith(box_disk.NOTE))

    def test_lost_disk_full_retention_resume_does_not_starve_healthy_peer(self):
        self.box('bad', member=True, state='stopped')
        self.box('good', member=True)
        self.con.execute('UPDATE leases SET pinned_until=? WHERE box_id=?', (common.now()+86400, 'bad'))
        self.con.commit()
        common.kv_set(self.con, 'pin_owner:bad', self.me['owner'])
        box_disk.retire(self.con, 'bad', space(tmp=4096), 'tmp', stop=False)
        with patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS':'0'}), \
             patch.object(lease.capacity, 'check'), \
             patch.object(api, 'resume', side_effect=api.NetworkError('resume reply lost')):
            with self.assertRaises(lease.PinnedLeaseError):
                lease.refresh_box(self.con, 'bad')
        self.assertFalse(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:bad'").fetchone())
        def reuse(con, row, *args, **kwargs):
            self.assertEqual(row['box_id'], 'good', 'retired resumes must not enter dispatch selection')
            return dict(row)
        with patch.object(lease, '_reuse', side_effect=reuse) as reused:
            got = pool.acquire(self.me)
            pool.release_guard(got)
        self.assertEqual(got['box_id'], 'good')
        reused.assert_called_once()
        self.assertTrue(self.row('bad')['note'].startswith(box_disk.NOTE))

    def test_reaper_reconciles_retired_resume_without_resend_or_preparation(self):
        from offbox_lib import allocation
        self.box('bad', member=True, state='stopped')
        box_disk.retire(self.con, 'bad', space(tmp=4096), 'tmp', stop=False)
        for state in ('running', 'starting', 'unknown', 'stopped'):
            with self.subTest(state=state):
                common.kv_set(self.con, 'resume_unanswered:bad', '')
                self.con.execute("INSERT OR REPLACE INTO kv VALUES ('resume_sender:bad','',?)", (common.now(),))
                self.con.commit()
                def confirm(*args, **kwargs):
                    self.assertTrue(kwargs['pending'])
                    self.assertTrue(kwargs['confirm_only'])
                    if state == 'unknown':
                        raise lease.ResumeUnresolved('unreadable')
                    if state in ('running', 'stopped'):
                        allocation.clear_resume(self.con, 'bad')
                    if state == 'stopped':
                        raise lease.ResumeStopped('confirmed stopped')
                    return {'state':state}, False
                with patch.object(api, 'list_boxes', return_value=[dict(id='bad', state='running')]), \
                     patch.object(bases, 'upkeep'), patch.object(lease, '_resume_confirmed', side_effect=confirm) as observed, \
                     patch.object(api, 'resume') as send, patch.object(lease, '_bring_up') as prepare:
                    reap.reap(False)
                observed.assert_called_once()
                send.assert_not_called()
                prepare.assert_not_called()
                pending = self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:bad'").fetchone()
                self.assertEqual(bool(pending), state in ('starting', 'unknown'))
                self.assertTrue(self.row('bad')['note'].startswith(box_disk.NOTE))

    def test_retired_stopped_resume_settles_within_real_reaper_budget_after_grace(self):
        from offbox_lib import allocation
        from test_pool_affinity import Clock
        self.box('bad', member=True, state='stopped')
        box_disk.retire(self.con, 'bad', space(tmp=4096), 'tmp', stop=False)
        clock = Clock()
        clock.t = common.now()
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:bad','',?)", (clock.t,))
        self.con.execute("INSERT INTO kv VALUES ('resume_sender:bad','',?)", (clock.t,))
        self.con.commit()
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ))
            os.environ.pop('OFFBOX_RESUME_CONFIRM_SECONDS', None)
            for name in ('time', 'monotonic', 'sleep'):
                stack.enter_context(patch.object(time, name, getattr(clock.module, name)))
            stack.enter_context(patch.object(api, 'readiness_get', return_value={'state':'archived'}))
            stack.enter_context(patch.object(api, 'list_boxes', return_value=[dict(id='bad', state='archived')]))
            stack.enter_context(patch.object(bases, 'upkeep'))
            send = stack.enter_context(patch.object(api, 'resume'))
            prepare = stack.enter_context(patch.object(lease, '_bring_up'))
            reap.reap(False)
            self.assertTrue(allocation.abandoned_resumes(self.con, self.me['repo_key']))
            self.assertLess(clock.t - self.con.execute("SELECT ts FROM kv WHERE k='resume_unanswered:bad'").fetchone()[0], 3)
            clock.t += 120
            before = clock.t
            reap.reap(False)
            self.assertLess(clock.t - before, 3)
            self.assertFalse(allocation.abandoned_resumes(self.con, self.me['repo_key']))
            with allocation.scope(self.me['repo_key']), allocation.guard():
                pass
            for response in (api.NetworkError('unreadable'), {'state':'unknown'}, {'state':'provisioning'}):
                with self.subTest(response=str(response)):
                    self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:bad','',?)", (clock.t-121,))
                    self.con.execute("INSERT INTO kv VALUES ('resume_sender:bad','',?)", (clock.t-121,))
                    self.con.commit()
                    read = dict(side_effect=response) if isinstance(response, Exception) else dict(return_value=response)
                    with patch.object(api, 'readiness_get', **read):
                        reap.reap(False)
                    self.assertTrue(allocation.abandoned_resumes(self.con, self.me['repo_key']))
                    allocation.clear_resume(self.con, 'bad')
            send.assert_not_called()
            prepare.assert_not_called()
        self.assertTrue(self.row('bad')['note'].startswith(box_disk.NOTE))

    def test_retired_resume_http_observations_have_usable_budgets_on_both_backends(self):
        from offbox_lib import allocation
        from test_pool_affinity import Clock
        self.box('bad', member=True, state='stopped')
        box_disk.retire(self.con, 'bad', space(tmp=4096), 'tmp', stop=False)
        for backend in ('boat', 'server'):
            for latency in (0, .01, .04, .06, .1, .25, 1, 2.5, 4):
                with self.subTest(backend=backend, latency=latency), contextlib.ExitStack() as stack:
                    clock = Clock()
                    clock.t = common.now()
                    self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:bad','',?)", (clock.t-121,))
                    self.con.execute("INSERT INTO kv VALUES ('resume_sender:bad','',?)", (clock.t-121,))
                    self.con.commit()
                    timeouts = []
                    def observe(req, timeout):
                        self.assertEqual(req.method, 'GET')
                        self.assertTrue(req.full_url.endswith('/sandboxes/bad'))
                        timeouts.append(timeout)
                        if timeout < latency:
                            clock.t += timeout
                            raise TimeoutError('HTTP observation exceeded its budget')
                        clock.t += latency
                        return io.BytesIO(b'{"sandbox":{"id":"bad","state":"archived"}}')
                    stack.enter_context(patch.dict(os.environ, {'OFFBOX_BACKEND':backend}))
                    os.environ.pop('OFFBOX_RESUME_CONFIRM_SECONDS', None)
                    stack.enter_context(patch.object(common, '_BACKEND', backend))
                    stack.enter_context(patch.object(api, 'BACKEND', backend))
                    for name in ('time', 'monotonic', 'sleep'):
                        stack.enter_context(patch.object(time, name, getattr(clock.module, name)))
                    stack.enter_context(patch.object(api, 'call', _HTTP_CALL))
                    stack.enter_context(patch.object(api, 'get', _HTTP_GET))
                    stack.enter_context(patch.object(api, '_key', return_value='offline-fixture'))
                    stack.enter_context(patch.object(api, '_open', side_effect=observe))
                    stack.enter_context(patch.object(api, 'list_boxes', return_value=[dict(id='bad', state='archived')]))
                    stack.enter_context(patch.object(bases, 'upkeep'))
                    send = stack.enter_context(patch.object(api, 'resume'))
                    prepare = stack.enter_context(patch.object(lease, '_bring_up'))
                    before = clock.t
                    reap.reap(False)
                    self.assertEqual(len(timeouts), 2)
                    self.assertGreaterEqual(min(timeouts), latency)
                    self.assertLessEqual(clock.t-before, 10)
                    self.assertFalse(allocation.abandoned_resumes(self.con, self.me['repo_key']))
                    self.assertTrue(self.row('bad')['note'].startswith(box_disk.NOTE))
                    send.assert_not_called()
                    prepare.assert_not_called()

    def test_retired_reaper_skips_busy_allocation_lock_with_production_pool_wait(self):
        from test_pool_affinity import Clock
        boxes = ['bad'+str(i) for i in range(8)]
        for bid in boxes:
            self.box(bid, member=True, state='stopped')
            box_disk.retire(self.con, bid, space(tmp=4096), 'tmp', stop=False)
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), contextlib.ExitStack() as stack:
                clock = Clock()
                clock.t = common.now()
                for bid in boxes:
                    self.con.execute('INSERT INTO kv VALUES (?,?,?)', ('resume_unanswered:'+bid, '', clock.t-121))
                    self.con.execute('INSERT INTO kv VALUES (?,?,?)', ('resume_sender:'+bid, '', clock.t-121))
                self.con.commit()
                stack.enter_context(patch.dict(os.environ, {'OFFBOX_BACKEND':backend}))
                os.environ.pop('OFFBOX_POOL_WAIT_SECONDS', None)
                stack.enter_context(patch.object(common, '_BACKEND', backend))
                stack.enter_context(patch.object(api, 'BACKEND', backend))
                for name in ('time', 'monotonic', 'sleep'):
                    stack.enter_context(patch.object(time, name, getattr(clock.module, name)))
                read = stack.enter_context(patch.object(api, 'readiness_get', return_value={'state':'archived'}))
                stack.enter_context(patch.object(api, 'list_boxes', return_value=[dict(id=b, state='archived') for b in boxes]))
                stack.enter_context(patch.object(bases, 'upkeep'))
                name = 'allocation-' + hashlib.sha256(self.me['repo_key'].encode()).hexdigest()[:20]
                before = clock.t
                with common.file_lock(name, timeout=0):
                    reap.reap(False)
                self.assertLess(clock.t-before, 3)
                read.assert_not_called()
                self.assertEqual(self.con.execute("SELECT COUNT(*) FROM kv WHERE k LIKE 'resume_unanswered:%'").fetchone()[0], 8)
                # An immediately available allocation lock must still work with a positive pool wait.
                reap.reap(False)
                self.assertEqual(read.call_count, 16)
                self.assertFalse(self.con.execute("SELECT 1 FROM kv WHERE k LIKE 'resume_unanswered:%'").fetchone())

    def test_retired_reaper_stops_observing_later_boxes_after_maintenance_deadline(self):
        from test_pool_affinity import Clock
        clock = Clock()
        clock.t = common.now()
        for bid in ('first', 'later'):
            self.box(bid, member=True, state='stopped')
            box_disk.retire(self.con, bid, space(tmp=4096), 'tmp', stop=False)
            self.con.execute('INSERT INTO kv VALUES (?,?,?)', ('resume_unanswered:'+bid, '', clock.t-121))
            self.con.execute('INSERT INTO kv VALUES (?,?,?)', ('resume_sender:'+bid, '', clock.t-121))
        self.con.commit()
        def exhausted(*args, **kwargs):
            clock.t += 1
            return {'state':'archived'}
        with contextlib.ExitStack() as stack:
            for name in ('time', 'monotonic', 'sleep'):
                stack.enter_context(patch.object(time, name, getattr(clock.module, name)))
            stack.enter_context(patch.object(reap, 'REAP_BUDGET_S', 1))
            read = stack.enter_context(patch.object(api, 'readiness_get', side_effect=exhausted))
            stack.enter_context(patch.object(api, 'list_boxes', return_value=[dict(id=b, state='archived') for b in ('first', 'later')]))
            stack.enter_context(patch.object(bases, 'upkeep'))
            actions = reap.reap(False)
        read.assert_called_once()
        self.assertIn('defer retired resumes: maintenance budget exhausted', actions)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM kv WHERE k LIKE 'resume_unanswered:%'").fetchone()[0], 2)

    def test_admission_follow_preserves_chunks_and_stops_at_exact_start_marker(self):
        for chunks in [
                ['offbox-command-', 'started: r\n'],
                ['offbox-command-started: wrong\n', 'offbox-command-started: r\n'+'x'*8192]]:
            with self.subTest(chunks=len(chunks)):
                path=Path(self.tmp.name)/'admission.log'
                path.unlink(missing_ok=True)
                def frames(*args,**kw):
                    for chunk in chunks:
                        yield dict(type='stderr',data=chunk)
                    self.fail('admission kept following after the user start marker')
                with patch.object(api,'cmd_attach',side_effect=frames),patch.object(runs,'_ttl_keeper'):
                    result=runs.follow('b',7,path,echo=False,run_id='r',until_command_started=True)
                self.assertIs(result,runs._COMMAND_RUNNING)
                self.assertEqual(path.read_text(),''.join(chunks))

    def test_live_tmp_holder_retirement_never_stops_or_deletes_box(self):
        self.box('b',member=True)
        with patch.object(box_disk,'safe_to_stop',return_value=False), \
             patch.object(lease,'delete_box') as delete:
            box_disk.retire(self.con,'b',space(tmp=4096),'tmp')
        self.stop.assert_not_called()
        delete.assert_not_called()
        self.keep_ttl.assert_called_with('b',common.RUN_TTL_S,{'state':'running'})
        self.assertTrue(self.row('b')['note'].startswith(box_disk.NOTE))

    def test_reaper_renews_disk_full_live_holder_until_it_can_stop(self):
        self.box('b',member=True)
        box_disk.retire(self.con,'b',space(tmp=4096),'tmp',stop=False)
        for safe in (False,False,True):
            self.keep_ttl.reset_mock()
            with patch.object(api,'list_boxes',return_value=[dict(id='b',state=api.LIVE_STATES[0])]), \
                 patch.object(box_disk,'safe_to_stop',return_value=safe),patch.object(bases,'upkeep'):
                reap.reap(False)
            if safe:
                self.stop.assert_called_once()
                self.keep_ttl.assert_not_called()
            else:
                self.stop.assert_not_called()
                self.keep_ttl.assert_called_with('b',common.RUN_TTL_S,{'state':'running'})

    def test_same_box_retry_cannot_read_previous_attempt_receipt(self):
        self.box('b',member=True);self.busy('b')
        self.con.execute("UPDATE runs SET client_pid=? WHERE run_id='run-b'",(os.getpid(),))
        self.con.commit()
        home=Path(self.tmp.name)/'guest';receipt=home/'.offbox/exit/run-b.rc'
        receipt.parent.mkdir(parents=True);receipt.write_text('90\n')
        def ssh(box,cmd,**kw):
            cmd='pgrep() { return 0; }; '+cmd
            return subprocess.run(['bash','-c',cmd],env=dict(os.environ,HOME=str(home)),capture_output=True,
                                  check=kw.get('check',False),timeout=kw.get('timeout',5))
        failure=box_disk.Full('b','tmp',space());failure.run_id='run-b'
        with patch.object(ssh_sync,'ssh',side_effect=ssh):
            runs.reset_disk_retry(failure)
            runs.clear_disk_receipt(failure)
            result=start_check.check('b','run-b')
        self.assertFalse(receipt.exists())
        self.assertEqual((result.verdict,result.code),('started',None))
        self.assertNotEqual(start_check.claim_id(self.con,'run-b'),'run-b')

    def test_wait_follows_replacement_without_holding_previous_box_lock(self):
        self.box('a',member=True);self.box('b',member=True);self.busy('a')
        self.con.execute("UPDATE runs SET process_id=7,command_id='c',client_pid=?,log_path=? WHERE run_id='run-a'",
                         (os.getpid(),str(Path(self.tmp.name)/'LOGS_DIR/run-a.log')))
        self.con.commit()
        row=self.con.execute("SELECT * FROM runs WHERE run_id='run-a'").fetchone()
        held=set()
        @contextlib.contextmanager
        def lock(name,**kw):
            held.add(name)
            if name=='box-a':
                self.con.execute("UPDATE runs SET box_id='b' WHERE run_id='run-a'");self.con.commit()
            try:
                yield
            finally:
                held.remove(name)
        def takeover(current,*args,**kw):
            self.assertEqual(current['box_id'],'b')
            self.assertEqual(held,{'box-b'})
            return 0
        with patch.object(misc,'file_lock',side_effect=lock),patch.object(misc,'_refresh_running_ttl'), \
             patch.object(runs,'reconcile_lost'),patch.object(misc,'_replay_takeover',side_effect=takeover):
            self.assertEqual(misc._wait_locked(row,False,timeout=1),0)

    def test_disk_cleanup_keeps_unresolved_prune_hold(self):
        self.box('b',member=True)
        self.con.execute('INSERT INTO prune_holds VALUES (?,?,?)',('b','unresolved',common.now()))
        self.con.commit()
        with patch.object(ssh_sync,'ssh') as ssh:
            result=box_disk.prune.run(self.con,'b','w/current',force=True)
        ssh.assert_not_called()
        self.assertTrue(result.timed_out)
        self.assertEqual(self.con.execute('SELECT run_id FROM prune_holds').fetchone()[0],'unresolved')

    def test_unconfirmed_ttl_preserves_disk_full_reason_and_release_path(self):
        self.box('b',member=True)
        box_disk.retire(self.con,'b',space(tmp=4096),'tmp',stop=False)
        requests=Mock();requests.settled.is_set.return_value=False
        with patch.object(api,'RequestScope',return_value=requests),patch.object(runs.threading,'Thread'), \
             self.assertRaises(runs.TtlUnconfirmed):
            with runs._keep_ttl('b',common.now()):
                pass
        self.assertTrue(self.row('b')['note'].startswith(box_disk.NOTE))

    def test_error_spellings_and_paths(self):
        for text in ['No space left on device (28)','ENOSPC','[Errno 28]','errno=28','os error 28']:
            for code in [11,12,23]:
                with self.subTest(text=text,code=code):
                    self.assertEqual(box_disk.push_failure(f'rsync failed ({code}): mkdir "/tmp/foo": {text}'),('tmp','/tmp/foo'))


class DiskMeasureTests(unittest.TestCase):
    def test_claim_reader_protects_only_the_same_wrapper(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);proc=home/'proc'
            claim=home/'.offbox/claim/claim-live';claim.mkdir(parents=True)
            (claim/'pid').write_text('1234');(claim/'epoch').write_text('1000')
            process=proc/'1234';process.mkdir(parents=True)
            with patch.object(api,'BACKEND','server'):
                command=runs.exit_recording_command('true','run-current',claim_id='claim-live')
            command=b'\0'.join(p.encode() for p in shlex.split(command))+b'\0'
            for argv,expected in ((command,[dict(started_at=1000)]),
                                  (b'sleep\x0030\x00',[]),
                                  (b'bash\x00-c\x00.offbox/claim/claim-live-other/pid',[]),
                                  (b'tail\x00-f\x00/home/user/.offbox/claim/claim-live/pid.backup',[]),
                                  (b'tail\x00-f\x00/home/user/.offbox/claim/claim-live/pid',[]),
                                  *((command.replace(b'/claim-live/pid"',b'/claim-live/pid'+suffix.encode()+b'"'),[])
                                    for suffix in ('.backup','.old','_old','-old','/child','2')),
                                  *((command.replace(b'/claim-live/pid"',b'/claim-live/pid"'+suffix.encode()),[])
                                    for suffix in ('.backup','/child','"backup"')),
                                  (b'',[])):
                with self.subTest(argv=argv[:30]):
                    (process/'cmdline').write_bytes(argv)
                    live=box_disk.live_claims(home,proc)
                    self.assertEqual(live,expected)
                    self.assertEqual(min([2000]+[r['started_at'] for r in live]),1000 if expected else 2000)
            (process/'cmdline').unlink()
            self.assertEqual(box_disk.live_claims(home,proc),[])

    def test_claim_reader_errors_abort_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);claim=home/'.offbox/claim/claim-live';claim.mkdir(parents=True)
            (claim/'pid').write_text('1234');(claim/'epoch').write_text('1000')
            with patch.object(Path,'read_bytes',side_effect=PermissionError('proc unavailable')):
                with self.assertRaises(PermissionError):
                    box_disk.live_claims(home,home/'proc')

    def test_ssh_discovery_and_measurement_share_one_deadline(self):
        for elapsed,api_deadline in ((4.5,True),(5.0,True),(4.5,False),(5.0,False)):
            with self.subTest(discovery_seconds=elapsed,api_deadline=api_deadline), \
                 tempfile.TemporaryDirectory() as folder:
                config=Path(folder)/'config';config.write_text('# offbox-home-ports 2022 22\n')
                clock=[100.0];calls=[]
                def run(argv,**kw):
                    calls.append((argv,kw['timeout']))
                    if argv[-1]=='true':
                        clock[0]+=elapsed
                        return subprocess.CompletedProcess(argv,0,b'',b'')
                    clock[0]+=min(4.5,kw['timeout'])
                    raise subprocess.TimeoutExpired(argv,kw['timeout'])
                with patch.object(api,'BACKEND','server'),patch.object(api,'_DEADLINE',None), \
                     (contextlib.nullcontext() if api_deadline else patch.object(api,'left',return_value=None)), \
                     patch.object(ssh_sync,'cfg_path',return_value=config),patch.object(ssh_sync,'_HOME_PORTS',{}), \
                     patch.object(api.time,'time',side_effect=lambda:clock[0]), \
                     patch.object(ssh_sync.subprocess,'run',side_effect=run):
                    self.assertEqual(box_disk.measure('b'),{})
                self.assertLessEqual(clock[0]-100,5)
                self.assertEqual(len(calls),2 if elapsed<5 else 1)
                if elapsed<5:
                    self.assertEqual(calls[1][1],0.5)

    def test_workspace_probe_uses_checkout_mount_and_preserves_explicit_path(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder); explicit=home/'other';explicit.mkdir()
            def ssh(box,command,**kw):
                self.assertLessEqual(kw['timeout'],5)
                return subprocess.run([sys.executable,'-c',kw['input'].decode()],
                                      env=dict(os.environ,HOME=folder),capture_output=True,timeout=5)
            with patch.object(ssh_sync,'ssh',side_effect=ssh):
                self.assertEqual(box_disk.measure('b')['workspace']['path'],folder)
                (home/'w').mkdir()
                self.assertEqual(box_disk.measure('b')['workspace']['path'],str(home/'w'))
                self.assertEqual(box_disk.measure('b',str(explicit))['workspace']['path'],str(explicit))


@unittest.skipUnless(Path('/proc/self/fdinfo').is_dir(), 'guest reaper requires Linux procfs')
class ImmediateReapTests(unittest.TestCase):
    def test_actual_wrapper_claim_is_live_until_the_command_exits(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(api,'BACKEND','server'):
            home=Path(folder)
            command=runs.exit_recording_command("printf 'READY\\n'; read -r release",'run-live',claim_id='claim-live')
            p=subprocess.Popen(['bash','-c',command],env=dict(os.environ,HOME=folder),
                               stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                self.assertEqual(p.stdout.readline(),b'READY\n')
                self.assertEqual(len(box_disk.live_claims(home,Path('/proc'))),1)
                _,stderr=p.communicate(input=b'\n',timeout=10)
                self.assertEqual(p.returncode,0,stderr)
                self.assertEqual(box_disk.live_claims(home,Path('/proc')),[])
            finally:
                if p.poll() is None:
                    p.kill();p.communicate()

    def test_exited_files_reclaimed_immediately_but_live_and_recent_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'tmp'; root.mkdir()
            exited=root/'pytest-of-user'; exited.mkdir(); (exited/'data').write_bytes(b'x'*4096)
            finish=time.time()+0.01
            mountinfo=Path(folder)/'mountinfo'; mountinfo.write_text('')
            with patch.object(disk,'held_paths',return_value={str(exited/'data')}):
                self.assertEqual(disk.reap(root,os.getuid(),[],finished_before=finish,mountinfo=mountinfo),0)
                self.assertTrue(exited.exists())
            with patch.object(disk,'held_paths',return_value=set()):
                # The normal ten-minute sweep cannot touch a just-finished tree.
                disk.reap(root,os.getuid(),[],mountinfo=mountinfo)
                self.assertTrue(exited.exists())
                disk.reap(root,os.getuid(),[],finished_before=finish,mountinfo=mountinfo)
                self.assertFalse(exited.exists())

    def test_live_run_start_keeps_age_fence(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); candidate=root/'pytest-of-user'; candidate.mkdir()
            mountinfo=Path(folder)/'mountinfo'; mountinfo.write_text('')
            with patch.object(disk,'held_paths',return_value=set()):
                disk.reap(root,os.getuid(),[dict(started_at=time.time()-30)],finished_before=time.time()+1,mountinfo=mountinfo)
            self.assertTrue(candidate.exists())
