"""Offline interleavings from #975: ordinary starts queue, abandoned sends stay fenced."""
import contextlib
import hashlib
import io
import itertools
import threading
import urllib.error
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import clean_env
from offbox_lib import allocation, api, capacity, cli, common, fallback, lease, outage, pool, runs
from test_capacity import Isolated
from test_exit_and_queue import FakeClock


class AllocationWaitTests(Isolated):
    def lock_name(self):
        return 'allocation-' + hashlib.sha256(b'repo').hexdigest()[:20]

    def test_subprocess_allocation_holder_releases_to_waiting_caller(self):
        path = common.LOCKS_DIR / (self.lock_name() + '.lock')
        path.parent.mkdir(parents=True, exist_ok=True)
        child = subprocess.Popen([sys.executable, '-c',
            'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); '
            'print("held",flush=True); sys.stdin.read()', str(path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.wait)
        self.addCleanup(child.stdout.close)
        self.assertEqual(child.stdout.readline().strip(), 'held')
        real = allocation.file_lock
        attempts = []
        @contextlib.contextmanager
        def lock(name, timeout):
            attempts.append(timeout)
            if len(attempts) == 2:
                child.stdin.close()
                child.wait(timeout=5)
            with real(name, timeout=timeout):
                yield
        err = io.StringIO()
        with allocation.scope('repo'), patch.object(pool, 'wait_seconds', return_value=5), \
                patch.object(allocation, 'LOCK_TAKE_S', .01), patch.object(allocation, 'file_lock', lock), \
                contextlib.redirect_stderr(err):
            with allocation.guard():
                pass
        self.assertGreaterEqual(len(attempts), 2)
        self.assertEqual(err.getvalue().count('waiting: another caller is starting a box for repo'), 1)
        self.assertNotIn('retry', err.getvalue())

    def test_boat_reexec_waits_for_home_callers_same_repository_lock(self):
        path = common.LOCKS_DIR / (self.lock_name() + '.lock')
        path.parent.mkdir(parents=True, exist_ok=True)
        holder = subprocess.Popen([sys.executable, '-c',
            'import fcntl,sys; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); '
            'print("home held",flush=True); sys.stdin.read()', str(path)],
            env=clean_env(OFFBOX_BACKEND='server'),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        code = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from offbox_lib import allocation, common
root = Path(sys.argv[2])
for name in ('STATE', 'LOGS_DIR', 'LOCKS_DIR', 'SSH_DIR', 'CM_DIR'):
    setattr(common, name, root / name)
common.DB_PATH = root / 'db.sqlite'
common.LOG_PATH = root / 'log'
allocation.LOCK_TAKE_S = .01
with allocation.scope('repo'), allocation.guard():
    print('landed on ' + common.backend(), flush=True)
"""
        try:
            self.assertEqual(holder.stdout.readline().strip(),'home held')
            waiter = subprocess.Popen([sys.executable, '-c', code,
                str(Path(__file__).resolve().parents[1]), self.tmp.name],
                env=clean_env(OFFBOX_BACKEND='boat', OFFBOX_POOL_WAIT_SECONDS='5'),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                status = waiter.stderr.readline()
                self.assertIn('waiting: another caller is starting a box for repo',status)
                holder.stdin.close()
                holder.wait(timeout=5)
                output, error = waiter.communicate(timeout=5)
                self.assertEqual(waiter.returncode,0,status+error)
                self.assertEqual(output.strip(),'landed on boat')
                self.assertNotIn('retry',status+error)
            finally:
                if not holder.stdin.closed:
                    holder.stdin.close()
                holder.wait(timeout=5)
                waiter.wait(timeout=5)
                waiter.stdout.close()
                waiter.stderr.close()
        finally:
            if not holder.stdin.closed:
                holder.stdin.close()
            holder.wait(timeout=5)
            holder.stdout.close()

    def test_home_waits_across_short_takes(self):
        clock, err = FakeClock(), io.StringIO()
        takes = []
        @contextlib.contextmanager
        def lock(name, timeout):
            takes.append(timeout)
            if len(takes) < 4:
                clock.t += timeout
                raise common.OffboxError('locked')
            yield
        with patch.dict(os.environ, {'OFFBOX_BACKEND':'server','OFFBOX_POOL_WAIT_SECONDS':'86400'}), \
                patch.object(allocation, 'time', clock.time), patch.object(allocation, 'file_lock', lock), \
                allocation.scope('repo'), contextlib.redirect_stderr(err):
            with allocation.guard():
                pass
        self.assertEqual(takes, [30, 30, 30, 30])
        self.assertEqual(clock.t, 1090)
        self.assertEqual(err.getvalue().count('waiting:'), 1)
        self.assertNotIn('retry', err.getvalue())

    def test_boat_allocation_timeout_is_busy_92(self):
        clock = FakeClock()
        @contextlib.contextmanager
        def lock(name, timeout):
            clock.t += timeout
            raise common.OffboxError('locked')
            yield
        with patch.dict(os.environ, {'OFFBOX_BACKEND':'boat','OFFBOX_POOL_WAIT_SECONDS':'3'}), \
                patch.object(allocation, 'time', clock.time), patch.object(allocation, 'file_lock', lock), \
                allocation.scope('repo'), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(pool.PoolBusyError) as cm:
                with allocation.guard():
                    self.fail('lock was never free')
        self.assertEqual(cm.exception.code, 92)
        self.assertIn('nothing ran', str(cm.exception))

    def test_nested_guard_does_not_take_its_own_lock(self):
        with allocation.scope('repo'), allocation.guard(), patch.object(allocation, 'file_lock') as lock:
            with allocation.guard():
                pass
        lock.assert_not_called()


class ResumeQueueTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.stack.enter_context(patch.object(pool, 'time', self.clock.time))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_BACKEND':'server','OFFBOX_POOL_WAIT_SECONDS':'12'}))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(pool, '_recheck_prune_holds', return_value=False))
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def marker(self, bid, sender=None, age=1):
        self.con.execute('INSERT OR REPLACE INTO kv VALUES (?,?,?)',
                         ('resume_unanswered:'+bid, 'xlarge', common.now()-age))
        if sender is not None:
            self.con.execute('INSERT OR REPLACE INTO kv VALUES (?,?,?)',
                             ('resume_sender:'+bid, str(sender), common.now()))
        self.con.commit()

    def row(self, bid):
        return dict(self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone())

    def take(self, **kw):
        row = pool.acquire(self.me, **kw)
        pool.release_guard(row)
        return row

    def test_live_resume_from_archived_queues_then_reuses_for_fg_and_bg(self):
        self.box('bx_0jngiwmr', 'stopped', member=True, size='xlarge')
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_POOL_SIZE':'1'}))
        for bg, initial in itertools.product((False, True), ('resume', 'stopping')):
            with self.subTest(bg=bg, initial=initial):
                phase = [initial]
                if initial == 'resume':
                    self.marker('bx_0jngiwmr', os.getpid())
                self.con.execute('DELETE FROM runs')
                self.con.commit()
                seen = []
                def sleep(seconds):
                    self.clock.t += seconds
                    if phase[0] == 'stopping':
                        self.marker('bx_0jngiwmr', os.getpid())
                        phase[0] = 'resume'
                        return
                    allocation.clear_resume(self.con, 'bx_0jngiwmr')
                    self.con.execute("UPDATE leases SET state='running' WHERE box_id='bx_0jngiwmr'")
                    self.con.commit()
                def start(rn):
                    self.con.execute("INSERT INTO runs(run_id,status,mode) VALUES (?,'starting',?)",
                                     (rn.run_id, 'bg' if bg else 'fg'))
                    self.con.commit()
                    row = pool.acquire(self.me, size='xlarge', run_id=rn.run_id)
                    rn.lease_row, rn.box, rn.started = row, row['box_id'], True
                    self.con.execute("UPDATE runs SET status='running',box_id=? WHERE run_id=?", (rn.box,rn.run_id))
                    self.con.commit()
                    seen.append(rn.box)
                args = cli.build_parser().parse_args(['run'] + (['--bg'] if bg else []) + ['--','go','test','./...'])
                with patch.object(self.clock.time, 'sleep', sleep), \
                        patch.object(lease, '_bring_up'), \
                        patch.object(lease, 'acquire_private') as create, patch.object(runs.Runner, 'start', start), \
                        patch.object(runs, 'follow', return_value=0), patch.object(runs, 'finish', return_value=0), \
                        patch.object(api, 'get', side_effect=lambda *a,**k: {'state':'stopping' if phase[0]=='stopping' else 'running', 'type':'xlarge'}), \
                        patch.object(lease, 'ensure_ttl'), \
                        patch.object(fallback, 'run_local') as local, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.cmd_run(args,self.me),0,self.err.getvalue())
                self.assertEqual(seen,['bx_0jngiwmr'])
                self.assertEqual(self.con.execute('SELECT status FROM runs').fetchone()[0], 'running')
                create.assert_not_called()
                local.assert_not_called()

    def test_real_inflight_sender_and_two_callers_use_other_boxes(self):
        self.box('cold', 'stopped', member=True)
        self.box('peer', member=True)
        self.box('peer2', member=True)
        entered, release = threading.Event(), threading.Event()
        errors = []
        def resume(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError('sender was never released')
        def sender():
            try:
                with contextlib.closing(common.db()) as con, common.file_lock('box-cold'), allocation.scope('repo'):
                    lease._resume_confirmed(con, 'cold', 1200, 'large')
            except BaseException as e:
                errors.append(e)
                entered.set()
        with patch.object(api, 'resume', side_effect=resume), \
                patch.object(lease, '_reuse', side_effect=lambda c,r,*a,**k:dict(r)):
            thread = threading.Thread(target=sender)
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(allocation.resume_inflight(self.con, 'cold'))
                first = pool.acquire(self.me)
                try:
                    second = pool.acquire(dict(self.me, owner='worker-c', repo_root='/checkout/c'))
                    try:
                        self.assertEqual({first['box_id'], second['box_id']}, {'peer', 'peer2'})
                    finally:
                        pool.release_guard(second)
                finally:
                    pool.release_guard(first)
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertFalse(allocation.resume_inflight(self.con, 'cold'))

    def test_single_bg_caller_during_growers_own_stop_and_resume(self):
        self.box('grow', 'running', member=True)
        original = self.row('grow')
        entered, release, grown = threading.Event(), threading.Event(), threading.Event()
        errors = []
        def resume(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError('grower was never released')
            grown.set()
        def grower():
            try:
                with contextlib.closing(common.db()) as con, common.file_lock('box-grow'), allocation.scope('repo'):
                    lease._reuse(con, original, 'xlarge')
            except BaseException as e:
                errors.append(e)
                entered.set()
        def sleep(seconds):
            self.clock.t += seconds
            release.set()
            thread.join(5)
            self.assertFalse(thread.is_alive())
        def start(rn):
            self.con.execute("INSERT INTO runs(run_id,status,mode) VALUES (?,'starting','bg')", (rn.run_id,))
            self.con.commit()
            row = pool.acquire(self.me, size='xlarge', run_id=rn.run_id)
            rn.lease_row, rn.box, rn.started = row, row['box_id'], True
            self.con.execute("UPDATE runs SET status='running',box_id=? WHERE run_id=?", (rn.box,rn.run_id))
            self.con.commit()
        args = cli.build_parser().parse_args(['run','--bg','--','go','test','./...'])
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE':'1'}), \
                patch.object(api, 'get', side_effect=lambda *a,**k: {'state':'running', 'type':'xlarge' if grown.is_set() else 'large'}), \
                patch.object(api, 'stop') as stop, patch.object(api, 'resume', side_effect=resume) as send, \
                patch.object(api, 'wait_state', return_value={'state':'archived','type':'large'}), \
                patch.object(lease, '_bring_up_resumed', return_value={'state':'running','type':'xlarge'}), \
                patch.object(lease, '_bring_up'), patch.object(lease, 'ensure_ttl'), \
                patch.object(lease.ssh_sync, 'close_master'), patch.object(self.clock.time, 'sleep', sleep), \
                patch.object(runs.Runner, 'start', start), patch.object(fallback, 'run_local') as local, \
                contextlib.redirect_stdout(io.StringIO()):
            thread = threading.Thread(target=grower)
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(allocation.resume_inflight(self.con, 'grow'))
                self.assertEqual(cli.cmd_run(args, self.me), 0, self.err.getvalue())
            finally:
                release.set()
                thread.join(5)
            stop.assert_called_once()
            send.assert_called_once()
            local.assert_not_called()
        self.assertEqual(errors, [])
        self.assertEqual(self.row('grow')['size'], 'xlarge')
        self.assertEqual(self.con.execute('SELECT status FROM runs').fetchone()[0], 'running')

    def test_pending_resume_observed_stopping_queues_without_second_send(self):
        self.box('cold', 'stopped', member=True)
        self.marker('cold', 99999999)
        for state in ('stopping', 'archiving'):
            with self.subTest(state=state), patch.dict(os.environ, {'OFFBOX_POOL_SIZE':'1'}), \
                    patch.object(api, 'get', return_value={'state':state,'type':'large'}), \
                    patch.object(api, 'resume') as resume:
                with self.assertRaises(pool.PoolBusyError) as cm:
                    self.take()
            self.assertEqual(cm.exception.code, 92)
            resume.assert_not_called()
            self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())

    def test_outer_reconcile_box_lock_is_busy_not_90(self):
        self.box('cold','stopped',member=True)
        self.box('peer',member=True)
        self.marker('cold', age=900)
        with common.file_lock('box-cold'), patch.object(lease,'_reuse',side_effect=lambda c,r,*a,**k:dict(r)):
            self.assertEqual(self.take()['box_id'],'peer')
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())

    def test_two_stale_selectors_choose_same_stopped_box_loser_uses_peer(self):
        self.box('cold','stopped',member=True)
        self.box('peer','stopped',member=True)
        real = pool.candidates
        def candidates(*a):
            rows, room = real(*a)
            return sorted(rows, key=lambda r:r['box_id']!='cold'),room
        with common.file_lock('box-cold'), patch.object(pool,'candidates',side_effect=candidates), \
                patch.object(lease,'_reuse',side_effect=lambda c,r,*a,**k:dict(r)):
            self.assertEqual(self.take()['box_id'],'peer')

    def test_archiving_skip_followed_by_live_marker_queues(self):
        self.box('cold','stopped',member=True)
        self.busy('cold')
        self.con.execute("UPDATE runs SET status='killed'")
        self.con.commit()
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE':'1'}):
            calls=[]
            def reuse(c,r,*a,**k):
                calls.append(r['box_id'])
                if len(calls)==1:
                    self.marker('cold',os.getpid())
                    raise lease.ArchivingSkip('cold is archiving; skipping',code=92)
                return dict(r)
            def sleep(s):
                self.clock.t += s
                allocation.clear_resume(self.con,'cold')
            with patch.object(lease,'_reuse',side_effect=reuse), patch.object(self.clock.time,'sleep',sleep):
                self.assertEqual(self.take()['box_id'],'cold')
        self.assertIn('is archiving; skipping',self.err.getvalue())
        self.assertEqual(len(calls),2)

    def test_dead_sender_reconciles_without_blind_resume(self):
        self.box('cold','stopped',member=True)
        self.marker('cold',99999999)
        with patch.object(api,'get',return_value={'state':'running','type':'xlarge'}), \
                patch.object(api,'resume') as resume, patch.object(lease,'_bring_up'), \
                patch.object(lease,'ensure_ttl'):
            self.assertEqual(self.take()['box_id'],'cold')
        resume.assert_not_called()
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())

    def test_live_sibling_does_not_fence_resume_but_dead_sibling_does(self):
        self.box('cold','stopped',member=True)
        self.box('peer','stopped',member=True)
        for sender, blocked in ((os.getpid(),False),(99999999,True)):
            self.marker('cold',sender)
            with allocation.scope('repo'), patch.object(api,'resume') as resume:
                if blocked:
                    with self.assertRaises(allocation.Unresolved):
                        lease._resume_confirmed(self.con,'peer',1200,'large')
                    resume.assert_not_called()
                else:
                    lease._resume_confirmed(self.con,'peer',1200,'large')
                    resume.assert_called_once()

    def test_reused_pid_and_unreadable_identity_remain_fenced(self):
        self.box('cold', 'stopped', member=True)
        self.box('peer', 'stopped', member=True)
        from offbox_lib import misc
        for age, began, inflight in ((86400, common.now(), False),
                                    (86400, None, False), (1, None, True),
                                    (1, common.now()-10, True)):
            with self.subTest(age=age, began=began):
                self.marker('cold', os.getpid(), age=age)
                with patch.object(misc, '_pid_started_at', return_value=began), \
                        allocation.scope('repo'), patch.object(api, 'resume') as resume:
                    self.assertEqual(allocation.resume_inflight(self.con,'cold'), inflight)
                    if not inflight:
                        with self.assertRaises(allocation.Unresolved):
                            lease._resume_confirmed(self.con,'peer',1200,'large')
                        resume.assert_not_called()
                    else:
                        lease._resume_confirmed(self.con,'peer',1200,'large')
                        resume.assert_called_once()

    def test_locked_abandoned_sibling_with_stale_running_peer_queues(self):
        self.box('pending', 'stopped', member=True)
        self.box('peer', 'running', member=True)
        self.marker('pending', 99999999)
        for actual in ('archived','stopping','running'):
            with self.subTest(actual=actual), common.file_lock('box-pending'), \
                    patch.object(api,'get',return_value={'state':actual,'type':'large'}), \
                    patch.object(api,'resume') as resume, patch.object(lease,'_bring_up'), \
                    patch.object(lease,'ensure_ttl'):
                if actual == 'running':
                    self.assertEqual(self.take()['box_id'],'peer')
                else:
                    with self.assertRaises(pool.PoolBusyError) as cm:
                        self.take()
                    self.assertEqual(cm.exception.code,92)
                resume.assert_not_called()

    def test_legacy_marker_grace_and_expired_marker(self):
        self.box('cold','stopped',member=True)
        for age,expected in ((1,True),(901,False)):
            self.marker('cold',age=age)
            self.assertEqual(allocation.resume_inflight(self.con,'cold'),expected)

    def test_queued_caller_base_start_keeps_remaining_budget(self):
        self.box('busy',member=True,source='base:repo:seed')
        self.busy('busy')
        lock = common.file_lock('allocation-'+hashlib.sha256(b'repo').hexdigest()[:20])
        lock.__enter__()
        self.addCleanup(lock.__exit__,None,None,None)
        observed=[]
        def create(*a):
            observed.append(allocation._QUEUE.get()['end'] - self.clock.t)
            with allocation.guard():
                self.fail('allocation lock is held')
        def sleep(s):
            self.clock.t += s
            if self.clock.t >= 1006:
                self.con.execute('DELETE FROM pool_members')
                self.con.commit()
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1'}), patch.object(self.clock.time,'sleep',sleep), \
                patch.object(lease,'acquire_private',side_effect=create):
            with self.assertRaises(pool.PoolBusyError) as cm:
                self.take(base='repo:seed')
        self.assertEqual(cm.exception.code,92)
        self.assertLessEqual(max(observed),6)
        self.assertLessEqual(self.clock.t,1012)
        self.assertEqual(self.err.getvalue().count('waiting: another caller is starting a box for repo'),1)

    def test_stopping_then_inflight_resume_is_busy_until_ready(self):
        self.box('cold','stopped',member=True)
        with patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1'}):
            phase=['stopping']
            def get(*a,**k):
                return {'state':phase[0],'type':'xlarge'}
            def sleep(s):
                self.clock.t += s
                if phase[0]=='stopping':
                    self.marker('cold',os.getpid())
                    phase[0]='archived'
                else:
                    allocation.clear_resume(self.con,'cold')
                    phase[0]='running'
            with patch.object(api,'get',side_effect=get),patch.object(self.clock.time,'sleep',sleep), \
                    patch.object(lease,'_bring_up'),patch.object(lease,'ensure_ttl'),patch.object(api,'resume') as resume:
                self.assertEqual(self.take()['size'],'xlarge')
            resume.assert_not_called()
        self.assertIn('is stopping; skipping',self.err.getvalue())

    def test_resize_intent_survives_grower_skip_and_smaller_caller(self):
        self.box('grow','running',member=True)
        row=self.row('grow')
        with patch.object(api,'get',return_value={'state':'running','type':'large'}), \
                patch.object(api,'stop'),patch.object(lease.ssh_sync,'close_master'):
            with self.assertRaises(lease.ArchivingSkip):
                lease._reuse(self.con,row,'xlarge',skip_archiving=True)
        row=self.row('grow')
        with patch.object(api,'get',return_value={'state':'archived','type':'large'}), \
                patch.object(lease,'_resume_confirmed',return_value=(None,False)) as resume, \
                patch.object(lease,'_bring_up_resumed',return_value={'state':'running','type':'xlarge'}):
            self.assertEqual(lease._reuse(self.con,row,'large',skip_archiving=True)['size'],'xlarge')
        self.assertEqual(resume.call_args.args[3],'xlarge')
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='resize_size:grow'").fetchone())

    def test_satisfied_grow_intent_clears_on_all_reuse_returns(self):
        self.box('grow','stopped',member=True)
        for path in ('recovery','ssh','normal'):
            with self.subTest(path=path), contextlib.ExitStack() as stack:
                allocation.clear_resume(self.con,'grow')
                self.con.execute("UPDATE leases SET state=?,size=? WHERE box_id='grow'",
                                 ('running' if path=='ssh' else 'stopped','xlarge' if path=='ssh' else 'large'))
                self.con.execute("INSERT OR REPLACE INTO kv VALUES ('resize_size:grow','xlarge',0)")
                self.con.commit()
                if path=='recovery':
                    self.marker('grow',99999999)
                stack.enter_context(patch.object(api,'get',return_value={'state':'running' if path=='recovery' else 'archived','type':'large'}))
                stack.enter_context(patch.object(lease,'_bring_up_resumed',return_value={'state':'running','type':'xlarge'}))
                stack.enter_context(patch.object(lease,'ensure_ttl'))
                send=stack.enter_context(patch.object(api,'resume'))
                if path=='ssh':
                    stack.enter_context(patch.object(lease.ssh_sync,'cfg_path',return_value=Path(self.tmp.name)))
                    stack.enter_context(patch.object(lease.subprocess,'run',return_value=subprocess.CompletedProcess([],0)))
                self.assertEqual(lease._reuse(self.con,self.row('grow'),'large',skip_archiving=True)['size'],'xlarge')
                self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='resize_size:grow'").fetchone())
                if path in ('recovery','ssh'):
                    send.assert_not_called()
            self.con.execute("UPDATE leases SET state='stopped' WHERE box_id='grow'")
            self.con.commit()
            with patch.object(api,'get',return_value={'state':'archived','type':'xlarge'}), \
                    patch.object(lease,'_resume_confirmed',return_value=(None,False)) as resume, \
                    patch.object(lease,'_bring_up_resumed',return_value={'state':'running','type':'large'}):
                self.assertEqual(lease._reuse(self.con,self.row('grow'),'large')['size'],'large')
                self.assertEqual(resume.call_args.args[3],'large')

    def test_create_sibling_fence_after_selection_queues_without_local_fallback(self):
        for flags in ([], ['--bg'], ['--no-fallback']):
            with self.subTest(flags=flags):
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM kv')
                self.con.commit()
                def create(*args):
                    self.box('late', 'stopped')
                    self.marker('late', 99999999)
                    with allocation.guard():
                        self.fail('abandoned sibling should fence this send')
                args = cli.build_parser().parse_args(['run']+flags+['--','go','test','./...'])
                with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'0'}), \
                        patch.object(lease,'acquire_private',side_effect=create), \
                        patch.object(runs,'run_remote',side_effect=lambda *a:pool.acquire(self.me)), \
                        patch.object(fallback,'run_local') as local:
                    self.assertEqual(cli.cmd_run(args,self.me),92)
                    local.assert_not_called()
                self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0],0)

    def test_callers_own_create_uncertainty_still_fails(self):
        with patch.object(lease, 'acquire_private', side_effect=allocation.Unresolved('own create was unanswered')):
            with self.assertRaises(allocation.Unresolved) as cm:
                self.take()
        self.assertEqual(cm.exception.code,90)
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0],0)

    def test_transport_reservation_cannot_spend_past_queue_deadline(self):
        self.clock.time.time=lambda:self.clock.t
        for operation in ('create','fork','resume'):
            with self.subTest(operation=operation):
                self.con.execute('DELETE FROM kv')
                self.con.execute('DELETE FROM start_requests')
                self.con.commit()
                self.clock.t=1000
                reserve=capacity.reserve
                def delayed(*args):
                    rid=reserve(*args)
                    self.clock.t += 2
                    return rid
                with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'600'}), \
                        patch.object(api,'time',self.clock.time), patch.object(api,'_key',return_value='fake'), \
                        allocation.scope('repo'), allocation.queue(), \
                        patch.object(capacity,'reserve',side_effect=delayed), patch.object(api,'_open') as send:
                    self.clock.t=1599
                    start={'create':lambda:api.create('large',1200,'name','key'),
                           'fork':lambda:api.fork('source',1200,'key','large'),
                           'resume':lambda:api.resume('source',1200,'large')}[operation]
                    with self.assertRaises(pool.PoolBusyError) as cm:
                        start()
                    self.assertEqual(cm.exception.code,92)
                    send.assert_not_called()
                self.assertEqual([r[0] for r in self.con.execute('SELECT outcome FROM start_requests')],['not_sent'])
                self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='create_unanswered:repo'").fetchone())

    def test_transport_retry_pause_respects_queue_and_own_uncertainty(self):
        self.clock.time.time=lambda:self.clock.t
        for operation, ambiguous in itertools.product(('create','fork','resume'),(False,True)):
            with self.subTest(operation=operation,ambiguous=ambiguous):
                self.con.execute('DELETE FROM kv')
                self.con.execute('DELETE FROM start_requests')
                self.con.commit()
                self.clock.t=1000
                def fail(*a,**k):
                    if ambiguous:
                        raise TimeoutError('unanswered')
                    if operation=='resume':
                        raise urllib.error.HTTPError('https://invalid.test',502,'retry',{},
                            io.BytesIO(b'{"code":"sandbox_direct_failed","message":"connect ECONNREFUSED"}'))
                    raise urllib.error.HTTPError('https://invalid.test',409,'retry',{},
                        io.BytesIO(b'{"code":"ssh_host_key_unavailable"}'))
                with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'600'}), \
                        patch.object(api,'time',self.clock.time),patch.object(api,'_key',return_value='fake'), \
                        allocation.scope('repo'),allocation.queue(),patch.object(api,'_open',side_effect=fail) as send:
                    self.clock.t=1599
                    start={'create':lambda:api.create('large',1200,'name','key'),
                           'fork':lambda:api.fork('source',1200,'key','large'),
                           'resume':lambda:api.resume('source',1200,'large')}[operation]
                    expected=api.NetworkError if ambiguous and operation=='resume' else allocation.Unresolved if ambiguous else pool.PoolBusyError
                    with self.assertRaises(expected):
                        start()
                    self.assertEqual(send.call_count,1)
                retained=self.con.execute("SELECT 1 FROM kv WHERE k='create_unanswered:repo'").fetchone()
                self.assertEqual(bool(retained),ambiguous and operation!='resume')

    def test_archived_bring_up_retry_preserves_contention_types(self):
        self.box('cold','stopped',member=True)
        for error in (allocation.Busy('held'),allocation.Fenced('sibling unresolved'),lease.ResumeUnresolved('own unknown')):
            with self.subTest(error=type(error).__name__):
                def retry(**kw):
                    raise error
                def bring_up(*a,**kw):
                    self.clock.t += lease.RESUME_STUCK_S + 1
                    kw['on_state']({'state':'archived'})
                with patch.object(lease,'now',side_effect=lambda:self.clock.t), \
                        patch.object(lease,'_bring_up',side_effect=bring_up):
                    with self.assertRaises(type(error)) as cm:
                        lease._bring_up_resumed(self.con,'cold',None,False,retry)
                if isinstance(error,(allocation.Busy,allocation.Fenced)):
                    self.assertIs(cm.exception,error)

    def test_deferred_archived_retry_keeps_two_send_bound(self):
        self.box('cold','stopped',member=True)
        bring_calls=[]
        name='allocation-'+hashlib.sha256(b'repo').hexdigest()[:20]
        def bring_up(*a,**kw):
            bring_calls.append(True)
            self.clock.t += lease.RESUME_STUCK_S+1
            if len(bring_calls)==1:
                with common.file_lock(name):
                    kw['on_state']({'state':'archived'})
            else:
                kw['on_state']({'state':'archived'})
            return {'state':'running','type':'large'}
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE':'1','OFFBOX_POOL_WAIT_SECONDS':'400'}), \
                patch.object(lease,'now',side_effect=lambda:self.clock.t), \
                patch.object(api,'get',return_value={'state':'archived','type':'large'}), \
                patch.object(api,'resume') as resume,patch.object(lease,'_bring_up',side_effect=bring_up):
            with self.assertRaises(pool.PoolBusyError):
                self.take()
        self.assertEqual(resume.call_count,2)

    def test_owned_grow_status_timeout_crossing_affinity_cutoff_queues(self):
        self.box('owned','running',member=True)
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'],self.me['repo_root'],'owned','w/owned'))
        self.con.commit()
        self.clock.time.time=lambda:self.clock.t
        stopped, timed_out, sent = [], [], []
        def get(*a,**k):
            if not stopped:
                return {'state':'running','type':'large'}
            if not timed_out and self.clock.t >= 1058:
                self.assertLessEqual(api.left(),2)
                self.clock.t += 2.1
                timed_out.append(True)
                raise api.NetworkError('status response exceeded affinity budget')
            return {'state':'archived' if timed_out else 'stopping','type':'large'}
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'86400','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(lease,'time',self.clock.time),patch.object(api,'time',self.clock.time), \
                patch.object(api,'get',side_effect=get),patch.object(api,'stop',side_effect=lambda *a:stopped.append(True)), \
                patch.object(api,'resume',side_effect=lambda *a:sent.append(self.clock.t)), \
                patch.object(lease,'_bring_up_resumed',return_value={'state':'running','type':'xlarge'}), \
                patch.object(lease.ssh_sync,'close_master'):
            self.assertEqual(self.take(size='xlarge')['box_id'],'owned')
        self.assertEqual(timed_out,[True])
        self.assertEqual(len(sent),1)
        self.assertGreater(sent[0],1060)
        self.assertLess(self.clock.t,1070)

    def test_pending_confirmation_cannot_open_retry_past_queue_deadline(self):
        self.box('cold','stopped',member=True)
        self.marker('cold',99999999)
        self.clock.time.time=lambda:self.clock.t
        def get(*a,**k):
            return {'state':'stopping' if self.clock.t < 1598 else 'archived','type':'large'}
        with patch.dict(os.environ, {'OFFBOX_BACKEND':'boat','OFFBOX_POOL_WAIT_SECONDS':'600','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(lease,'time',self.clock.time),patch.object(api,'time',self.clock.time), \
                patch.object(api,'get',side_effect=get),patch.object(api,'resume') as resume:
            with self.assertRaises(pool.PoolBusyError) as cm:
                self.take()
        self.assertEqual(cm.exception.code,92)
        self.assertGreaterEqual(self.clock.t,1598)
        self.assertLessEqual(self.clock.t,1600)
        resume.assert_not_called()
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())

    def test_free_allocation_lock_after_queue_expiry_cannot_send(self):
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'2'}), allocation.scope('repo'), \
                allocation.queue(), patch.object(api,'_call') as send:
            self.clock.t += 3
            with self.assertRaises(pool.PoolBusyError) as cm:
                api.create('large',1200,'name','key')
        self.assertEqual(cm.exception.code,92)
        send.assert_not_called()

    def test_owned_resize_waits_past_affinity_in_home_queue(self):
        self.box('owned','running',member=True)
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'],self.me['repo_root'],'owned','w/owned'))
        self.con.commit()
        phase=['running']
        size=['large']
        def get(*a,**k):
            return {'state':phase[0],'type':size[0]}
        def stop(*a):
            phase[0]='stopping'
        def sleep(seconds):
            self.clock.t += seconds
            if self.clock.t >= 1062:
                phase[0]='archived'
        def resume(*a):
            phase[0],size[0]='running','xlarge'
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'86400','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(api,'get',side_effect=get),patch.object(api,'stop',side_effect=stop) as stopping, \
                patch.object(api,'resume',side_effect=resume) as send, \
                patch.object(api,'wait_state',side_effect=AssertionError('pooled stop must yield to queue')), \
                patch.object(lease,'_bring_up_resumed',return_value={'state':'running','type':'xlarge'}), \
                patch.object(lease.ssh_sync,'close_master'),patch.object(self.clock.time,'sleep',sleep):
            self.assertEqual(self.take(size='xlarge')['size'],'xlarge')
        self.assertGreaterEqual(self.clock.t,1062)
        self.assertLess(self.clock.t,1070)
        stopping.assert_called_once()
        send.assert_called_once()

    def test_pending_grow_precedes_ssh_shortcut_for_smaller_callers(self):
        self.box('grow','running',member=True)
        self.con.execute("INSERT INTO kv VALUES ('resize_size:grow','xlarge',0)")
        self.con.commit()
        row=self.row('grow')
        for requested in (None,'large'):
            with self.subTest(requested=requested), \
                    patch.object(lease.ssh_sync,'cfg_path',return_value=Path(self.tmp.name)), \
                    patch.object(lease.subprocess,'run') as ssh_check, \
                    patch.object(api,'get',return_value={'state':'running','type':'large'}), \
                    patch.object(api,'stop',side_effect=api.NetworkError('stop failed')) as stop:
                with self.assertRaises(api.NetworkError):
                    lease._reuse(self.con,row,requested,skip_archiving=True)
                stop.assert_called_once()
                ssh_check.assert_not_called()

    def test_contention_paths_never_fall_back_heavy_command(self):
        self.box('cold','stopped',member=True)
        for path in ('resume','box-lock','allocation','stopping'):
            for flags in ([],['--bg'],['--no-fallback']):
                with self.subTest(path=path,flags=flags), contextlib.ExitStack() as stack:
                    self.con.execute('DELETE FROM kv')
                    self.con.commit()
                    stack.enter_context(patch.dict(os.environ,{'OFFBOX_POOL_SIZE':'1','OFFBOX_POOL_WAIT_SECONDS':'2'}))
                    if path=='resume':
                        self.marker('cold',os.getpid())
                    elif path=='box-lock':
                        self.marker('cold',age=900)
                        stack.enter_context(common.file_lock('box-cold'))
                    elif path=='allocation':
                        stack.enter_context(common.file_lock('allocation-'+hashlib.sha256(b'repo').hexdigest()[:20]))
                        stack.enter_context(patch.object(api,'get',return_value={'state':'archived','type':'large'}))
                    else:
                        stack.enter_context(patch.object(api,'get',return_value={'state':'stopping','type':'large'}))
                    args=cli.build_parser().parse_args(['run']+flags+['--','go','test','./...'])
                    stack.enter_context(patch.object(runs,'run_remote',side_effect=lambda *a:pool.acquire(self.me)))
                    local=stack.enter_context(patch.object(fallback,'run_local'))
                    infra=stack.enter_context(patch.object(fallback,'note_infra_failure'))
                    self.assertEqual(cli.cmd_run(args,self.me),92)
                    local.assert_not_called()
                    infra.assert_not_called()
        self.assertIn('Heavy command NOT run locally',self.err.getvalue())
