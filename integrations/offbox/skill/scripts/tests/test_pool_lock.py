"""The pool lock covers only choosing a box (31 Oct, edge-api: a 900 s resume under the pool lock failed every other
caller with exit 90 "timed out waiting for lock pool-..."). Offline: no boat calls."""
import contextlib
import contextvars
import io
import os
from pathlib import Path
import subprocess
import sqlite3
import threading
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, capacity, cli, common, lease, pool, prune, runs  # noqa: E402
from test_exit_and_queue import FakeClock
from test_capacity import Isolated  # noqa: E402


def pool_lock_free() -> bool:
    try:
        with common.file_lock(pool.lock_name('repo'), timeout=0):
            return True
    except common.OffboxError:
        return False


def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, '-c', 'pass'])
    p.wait()
    return p.pid


class PoolLockTests(Isolated):
    def pending(self, pid, source=None, age=0):
        self.con.execute("INSERT INTO pool_pending VALUES (?,?,?,?,?)",
                         ('create-x', 'repo', pid, common.now() - age, source))
        self.con.commit()

    def new_box(self, bid='bx_new'):
        def make(me, size, template, base, fresh):
            self.con.execute("""INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,last_used_at,source)
                VALUES (?,'pool:repo','/checkout/repo','repo','w/x','running','large',1,'template:crpko-go')""", (bid,))
            self.con.commit()
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id=?", (bid,)).fetchone())
        return make

    def test_resume_runs_without_the_pool_lock(self):
        self.box('cold', 'stopped', member=True)
        seen = []

        def reuse(c, r, s, **kw):
            seen.append(pool_lock_free())
            return dict(r)
        with patch.object(lease, '_reuse', side_effect=reuse), patch.object(lease, 'acquire_private') as new, \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(seen, [True])
        self.assertEqual(row['box_id'], 'cold')
        new.assert_not_called()

    def test_create_runs_without_the_pool_lock_and_holds_a_slot(self):
        seen = []
        make = self.new_box()

        def create(me, size, template, base, fresh):
            seen.append((pool_lock_free(), pool._pending(self.con, 'repo')))
            return make(me, size, template, base, fresh)
        with patch.object(lease, 'acquire_private', side_effect=create):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(seen, [(True, 1)])
        self.assertEqual(row['box_id'], 'bx_new')
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM pool_pending").fetchone()[0], 0)

    def test_failed_create_frees_its_slot(self):
        with patch.object(lease, 'acquire_private', side_effect=common.OffboxError('boat API 500')):
            with self.assertRaises(common.OffboxError) as cm:
                pool.acquire(self.me)
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM pool_pending").fetchone()[0], 0)

    def test_pending_create_counts_toward_the_cap(self):
        self.box('one', member=True)
        self.busy('one')
        self.pending(os.getpid())
        with patch.object(lease, 'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(pool.PoolBusyError) as cm:
                pool.acquire(self.me)
        self.assertEqual(cm.exception.code, 92)
        new.assert_not_called()

    def test_dead_or_old_pending_slot_is_dropped(self):
        for pid, age in ((dead_pid(), 0), (os.getpid(), pool.PENDING_MAX_S + 1)):
            self.con.execute("DELETE FROM pool_pending")
            self.box('one', member=True)
            self.busy('one')
            self.pending(pid, age=age)
            with patch.object(lease, 'acquire_private', side_effect=self.new_box('bx_' + str(age))) as new:
                row = pool.acquire(self.me)
                pool.release_guard(row)
            new.assert_called_once()
            self.con.execute("DELETE FROM runs")
            self.con.execute("DELETE FROM leases")
            self.con.execute("DELETE FROM pool_members")
            self.con.commit()

    def test_pool_lock_wait_timeout_is_92_not_infra(self):
        self.box('idle', member=True)
        with common.file_lock(pool.lock_name('repo')), patch.object(lease, '_reuse') as reuse, \
                patch.object(lease, 'acquire_private') as new:
            with self.assertRaises(pool.PoolBusyError) as cm:
                pool.acquire(self.me)
        e = cm.exception
        self.assertEqual(e.code, 92)
        self.assertIsInstance(e, capacity.CapacityError)
        self.assertFalse(e.started)
        self.assertIn('Nothing ran', str(e))
        self.assertIn('retry', str(e))
        self.assertNotIn('timed out waiting for lock', str(e))
        reuse.assert_not_called()
        new.assert_not_called()

    def test_cli_pool_lock_timeout_returns_92_without_infra_alert(self):
        self.box('idle', member=True)
        a = cli.build_parser().parse_args(['run', '--no-fallback', '--', 'go', 'test', './...'])
        err = io.StringIO()
        with common.file_lock(pool.lock_name('repo')), \
                patch.object(runs.Runner, 'start', side_effect=lambda: pool.acquire(self.me)), \
                patch('offbox_lib.fallback.note_infra_failure') as infra, contextlib.redirect_stderr(err):
            self.assertEqual(cli.cmd_run(a, self.me), 92)
        infra.assert_not_called()
        self.assertIn('exit 92', err.getvalue())

    def test_fresh_waits_for_a_fresh_box_another_caller_is_creating(self):
        self.box('a', member=True)
        self.busy('a')
        self.pending(os.getpid(), source='fresh')
        with patch.object(lease, 'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(pool.PoolBusyError) as cm:
                pool.acquire(self.me, fresh=True)
        self.assertEqual(cm.exception.code, 92)
        new.assert_not_called()

    def test_box_being_resumed_counts_as_a_member(self):
        # A legacy (non-member) box picked for a resume joins the pool when picked, so a parallel creator sees it.
        self.box('legacy', 'stopped')
        seen = []

        def reuse(c, r, s, **kw):
            seen.append(len(pool.members(self.con, 'repo')))
            return dict(r)
        with patch.object(lease, '_reuse', side_effect=reuse), contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(seen, [1])

    def test_next_box_tried_after_a_resume_failure_without_retrying_the_first(self):
        self.box('bad', 'stopped', member=True, used=500)
        self.box('good', 'stopped', member=True, used=100)
        tried = []

        def reuse(c, r, s, **kw):
            tried.append(r['box_id'])
            if r['box_id'] == 'bad':
                raise common.OffboxError('box bad stuck in archived after 900s')
            return dict(r)
        with patch.object(lease, '_reuse', side_effect=reuse), patch.object(lease, 'acquire_private') as new, \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(tried, ['bad', 'good'])
        new.assert_not_called()

    def test_new_box_cannot_be_claimed_while_creator_is_bringing_it_up(self):
        """Another caller can see the creator's row as running during bring-up; it must not adopt that box."""
        ids = iter(['bx_new', 'bx_second'])
        second = {}

        def new_box(con, me, size, template, base, fresh):
            return {'id': next(ids)}, 'fresh', None, 'large'

        def bring_up(bid, **kw):
            if bid == 'bx_new' and not second:
                second['row'] = pool.acquire(dict(self.me, owner='second'))
            return {'state': 'running', 'type': 'large'}

        with patch.object(lease, '_new_box', side_effect=new_box), \
                patch.object(lease, '_bring_up', side_effect=bring_up), \
                patch.object(lease, 'ensure_ttl'), patch.object(lease.api, 'rename'), \
                patch.object(lease.api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(lease.api, 'call', side_effect=AssertionError('network forbidden')), \
                contextlib.redirect_stderr(io.StringIO()):
            creator = pool.acquire(self.me)
            try:
                self.assertEqual(creator['box_id'], 'bx_new')
                self.assertEqual(second['row']['box_id'], 'bx_second')
            finally:
                pool.release_guard(second.get('row'))
                pool.release_guard(creator)

    def test_pending_handoff_is_under_the_pool_lock(self):
        """Creator-to-member handoff runs under the pool lock: a concurrent selection can't read between its steps."""
        second = {}

        def creator(me, size, template, base, fresh):
            return self.new_box('bx_a')(me, size, template, base, fresh)

        real_claim = pool._claim
        seen_lock_free = []

        def claim(con, me, row, run_id, **kwargs):
            seen_lock_free.append(pool_lock_free())

            def other():
                try:
                    second['row'] = pool.acquire(dict(self.me, owner='other'))
                except pool.PoolBusyError as e:
                    second['error'] = e
            th = threading.Thread(target=other)
            th.start()
            th.join(10)
            return real_claim(con, me, row, run_id, **kwargs)

        with patch.object(lease, 'acquire_private', side_effect=creator), \
                patch.object(pool, '_claim', side_effect=claim), \
                patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
        try:
            self.assertEqual(seen_lock_free, [False])
            self.assertIsInstance(second.get('error'), pool.PoolBusyError)
            self.assertNotIn('row', second)
            self.assertEqual([r['box_id'] for r in pool.members(self.con, 'repo')], ['bx_a'])
        finally:
            pool.release_guard(row)

    def test_queue_snapshot_counts_create_once_through_member_handoff(self):
        for run_id in (None, 'starting-run'):
            with self.subTest(run_id=run_id):
                for table in ('leases', 'pool_members', 'pool_callers', 'runs'):
                    self.con.execute('DELETE FROM ' + table)
                if run_id:
                    self.con.execute("INSERT INTO runs(run_id,status) VALUES (?,'starting')", (run_id,))
                self.con.commit()
                observer = common.db()
                self.addCleanup(observer.close)
                real_claim, observations, lines = pool._claim, [], []

                def snapshot(phase):
                    # The observer only reads while the creator has a write transaction open.
                    state = pool._queue_snapshot(observer, 'repo', None, 'template:crpko-go', None)
                    observations.append((phase, state['busy'], state['pending'], state['total'], state['cap']))
                    lines.append(pool._queue_line(state))

                def claim(con, me, row, run_id, **kwargs):
                    snapshot('before claim')
                    def trace(sql):
                        if sql.startswith('DELETE FROM pool_pending'):
                            snapshot('before slot removal')
                        elif sql == 'COMMIT':
                            snapshot('before commit')
                    con.set_trace_callback(trace)
                    try:
                        real_claim(con, me, row, run_id, **kwargs)
                    finally:
                        con.set_trace_callback(None)
                    # The review's exact interleaving: a full progress read immediately after _claim returns.
                    state = pool.queue_state(observer, 'repo', source='template:crpko-go')
                    observations.append(('after claim', state['busy'], state['pending'], state['total'], state['cap']))
                    lines.append(pool._queue_line(state))

                with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), \
                        patch.object(lease, 'acquire_private', side_effect=self.new_box()), \
                        patch.object(pool, '_claim', side_effect=claim):
                    row = pool.acquire(self.me, run_id=run_id)
                try:
                    self.assertEqual(observations, [
                        ('before claim', 0, 1, 0, 1),
                        ('before slot removal', 0, 1, 0, 1),
                        ('before commit', 0, 1, 0, 1),
                        ('after claim', 1, 0, 1, 1),
                    ])
                    for line in lines:
                        self.assertNotIn('cap fell', line)
                        self.assertNotIn('surplus', line)
                finally:
                    pool.release_guard(row)

    def test_failed_claim_rolls_back_member_adoption_and_preserves_create_slot(self):
        self.box('created')
        self.pending(os.getpid())
        self.con.execute("INSERT INTO runs(run_id,status) VALUES ('starting-run','starting')")
        self.con.execute("""CREATE TRIGGER reject_claim BEFORE INSERT ON pool_callers BEGIN
            SELECT RAISE(ABORT, 'claim failed'); END""")
        self.con.commit()
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='created'").fetchone())
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'claim failed'):
            pool._claim(self.con, self.me, row, 'starting-run', pending_token='create-x')
        observer = common.db()
        try:
            self.assertEqual(observer.execute('SELECT COUNT(*) FROM pool_members').fetchone()[0], 0)
            self.assertEqual(observer.execute('SELECT token FROM pool_pending').fetchone()[0], 'create-x')
            self.assertEqual(observer.execute("SELECT box_id FROM runs WHERE run_id='starting-run'").fetchone()[0], None)
        finally:
            observer.close()

    def test_pooled_recipe_creation_runs_with_creator_box_lock_held(self):
        """Integration through pool.acquire: a pool-created recipe box runs its recipe under the lock the creator
        already holds (flock is not reentrant). Only boat and ssh are faked; _bring_up and file_lock run for real."""
        from offbox_lib import bases
        errors, retired = [], []
        row = None

        with patch.object(lease, '_new_box', return_value=({'id': 'recipe_box'}, 'recipe:crpko-node', None, 'large')), \
                patch.object(api, 'wait_state', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(lease.ssh_sync, 'setup'), patch.object(lease.ssh_sync, 'wait_ssh'), \
                patch.object(bases, 'recipe', return_value=('true', 'sha')) as recipe, \
                patch.object(lease.ssh_sync, 'put_file'), patch.object(bases, 'template_uploads'), \
                patch.object(api, 'cmd_start', return_value={'processId': 9}), \
                patch.object(lease, '_follow_bounded', return_value=0), patch.object(api, 'rename'), \
                patch.object(lease, '_retire_recipe_box', side_effect=lambda *a, **k: retired.append(a) or True), \
                patch.object(api, 'call', side_effect=AssertionError('network forbidden')), \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                row = pool.acquire(self.me)
            except common.OffboxError as e:
                errors.append((e.code, str(e)))
            finally:
                pool.release_guard(row)
        self.assertEqual(errors, [])
        self.assertEqual(retired, [])
        recipe.assert_called_once_with('crpko-node')
        self.assertEqual(row['box_id'], 'recipe_box')
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_pending').fetchone()[0], 0)


class PruneQueueTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no boat calls')))
        self.stack.enter_context(patch.object(prune.ssh_sync, 'ssh', side_effect=AssertionError('offline: no SSH')))

    def hold(self, bid, key='repo'):
        self.box(bid, used=common.now(), member=True)
        self.con.execute('UPDATE leases SET repo_key=? WHERE box_id=?', (key, bid))
        self.con.execute('UPDATE pool_members SET pool_key=? WHERE box_id=?', (key, bid))
        self.con.execute('INSERT INTO prune_holds VALUES (?,?,?)', (bid, 'prune-' + bid, common.now() - 200))
        self.con.commit()

    def test_full_four_box_queue_recovers_held_box_on_one_recheck(self):
        for bid in ('held1', 'held2', 'held3'):
            self.hold(bid)
        self.box('busy', member=True)
        self.busy('busy')
        calls = []
        def gone(con, bid, rid, budget):
            self.assertTrue(pool_lock_free(), 'worker probe must not hold the pool lock')
            calls.append(bid)
            if bid == 'held3':
                con.execute('DELETE FROM prune_holds WHERE box_id=?', (bid,))
                con.commit()
                return True
            return False
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '4'}), \
                patch.object(api, 'get', return_value={'state': 'running'}), \
                patch.object(prune, 'recheck', side_effect=gone), \
                patch.object(lease, '_reuse', side_effect=lambda con, row, size, **kw: dict(row)), \
                patch.object(lease, 'acquire_private') as new, contextlib.redirect_stderr(io.StringIO()):
            state = pool.queue_state(self.con, 'repo')
            self.assertEqual((state['busy'], state['cap'], state['held']), (1, 4, 3))
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(row['box_id'], 'held3')
        self.assertEqual(calls, ['held3', 'held2'])
        new.assert_not_called()

    def test_rechecks_throttled_across_callers_per_box_and_pool(self):
        self.hold('one')
        self.hold('two')
        self.hold('other', key='other-repo')
        t = common.now()
        with patch.object(api, 'get', return_value={'state': 'running'}), \
                patch.object(prune, 'recheck', return_value=False) as probe:
            for age, count in ((0, 2), (1, 2), (59, 2), (60, 4), (61, 4), (120, 6)):
                with self.subTest(age=age), patch.object(pool, 'now', return_value=t + age):
                    self.assertFalse(pool._recheck_prune_holds(self.con, 'repo'))
                    self.assertEqual(probe.call_count, count)
        self.assertNotIn('other', [call.args[1] for call in probe.call_args_list])

    def test_concurrent_caller_cannot_repeat_probe(self):
        self.hold('one')
        seen = []
        def probe(*args):
            seen.append(pool._recheck_prune_holds(self.con, 'repo'))
            return False
        with patch.object(api, 'get', return_value={'state': 'idle'}), \
                patch.object(prune, 'recheck', side_effect=probe) as worker:
            self.assertFalse(pool._recheck_prune_holds(self.con, 'repo'))
        self.assertEqual(seen, [False])
        worker.assert_called_once()

    def test_queued_acquire_does_not_repeat_ssh_probes(self):
        for bid in ('one', 'two', 'three'):
            self.hold(bid)
        self.box('busy', member=True)
        self.busy('busy')
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '4', 'OFFBOX_POOL_WAIT_SECONDS': '65'}), \
                patch.object(pool.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(pool.time, 'sleep', side_effect=sleep), \
                patch.object(prune, 'recheck', return_value=False) as probe, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(pool.PoolBusyError):
                pool.acquire(self.me)
        self.assertIn('1 busy + 3 idle that can', err.getvalue())
        self.assertIn('3 held by checkout cleanup; #1 of 1', err.getvalue())
        self.assertEqual(probe.call_count, 2)

    def test_active_run_with_hold_counted_once_as_busy(self):
        self.hold('held-busy')
        self.busy('held-busy')
        state = pool.queue_state(self.con, 'repo')
        self.assertEqual((state['busy'], state['held']), (1, 0))



class FairQueueTests(Isolated):
    new_box = PoolLockTests.new_box
    def waiter(self, token='older', source=None, size=None, pid=None, cap=2, run_id=None):
        self.con.execute("INSERT INTO pool_waiters(pool_key,token,pid,run_id,queued_at,source,size) "
                         "VALUES (?,?,?,?,?,?,?)",
                         (pool._queue_key('repo'), token, pid or os.getpid(), run_id, common.now() - 10, source, size))
        self.con.execute("INSERT INTO pool_cap_callers(token,pool_key,pid,run_id,cap) VALUES (?,?,?,?,?)",
                         (token, pool._queue_key('repo'), pid or os.getpid(), run_id, cap))
        self.con.commit()

    def test_newer_poll_yields_next_free_box_to_oldest(self):
        self.box('next', member=True)
        self.box('busy', member=True)
        self.busy('busy')
        self.waiter()
        clock, granted = FakeClock(), []
        def sleep(seconds):
            clock.t += seconds
            if not granted:
                granted.append(pool._acquire(self.con, dict(self.me, owner='old'), None, None, None, False,
                                              None, waiter='older'))
        clock.time.sleep = sleep
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '4'}), patch.object(pool, 'time', clock.time), \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)), \
                patch.object(lease, 'acquire_private') as create, contextlib.redirect_stderr(io.StringIO()):
            try:
                with self.assertRaises(pool.PoolBusyError):
                    pool.acquire(self.me)
                self.assertEqual([r['box_id'] for r in granted], ['next'])
                create.assert_not_called()
            finally:
                for row in granted:
                    pool.release_guard(row)

    def test_incompatible_older_source_does_not_block_free_box(self):
        for source in ('template:other', 'base:repo:saved', 'fresh'):
            with self.subTest(source=source):
                self.con.execute('DELETE FROM pool_waiters')
                self.con.execute('DELETE FROM pool_cap_callers')
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.commit()
                self.box('free', member=True, source='recipe:crpko-go')
                self.waiter(source=source)
                with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
                    row = pool.acquire(self.me, template='crpko-go')
                    pool.release_guard(row)
                self.assertEqual(row['box_id'], 'free')

    def test_smaller_box_still_belongs_to_older_larger_request(self):
        self.box('small', member=True, size='default')
        self.waiter(size='xlarge', source='template:crpko-go')
        self.assertTrue(pool._older(self.con, 'repo', None, pool.members(self.con, 'repo')[0]))

    def test_dead_waiter_dropped_from_line_and_cap(self):
        self.waiter(pid=dead_pid(), cap=12)
        state = pool.queue_state(self.con, 'repo')
        self.assertEqual((state['waiting'], state['cap']), (0, 4))
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)

    def test_newer_raised_cap_gives_oldest_extra_create_slot(self):
        for bid in ('one', 'two'):
            self.box(bid, member=True)
            self.busy(bid)
        self.waiter()
        clock, granted, observed = FakeClock(), [], []
        def sleep(seconds):
            clock.t += seconds
            if not granted:
                with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '2'}):
                    observed.append(pool.pool_cap(self.con, 'repo'))
                    granted.append(pool._acquire(self.con, dict(self.me, owner='old'), None, None, None,
                                                  False, None, waiter='older'))
        clock.time.sleep = sleep
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '3', 'OFFBOX_POOL_WAIT_SECONDS': '4'}), \
                patch.object(pool, 'time', clock.time), \
                patch.object(lease, 'acquire_private', side_effect=self.new_box()) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            try:
                with self.assertRaises(pool.PoolBusyError):
                    pool.acquire(self.me)
                self.assertEqual(observed, [3])
                self.assertEqual(granted[0]['box_id'], 'bx_new')
                create.assert_called_once()
            finally:
                for row in granted:
                    pool.release_guard(row)

    def test_cap_falls_back_when_raised_waiter_leaves(self):
        self.waiter(cap=12)
        self.assertEqual(pool.pool_cap(self.con, 'repo'), 12)
        self.con.execute("DELETE FROM pool_cap_callers WHERE token='older'")
        self.con.commit()
        self.assertEqual(pool.pool_cap(self.con, 'repo'), 4)
        self.assertEqual(self.con.execute("SELECT cap FROM pool_caps WHERE pool_key='repo'").fetchone()[0], 4)

    def test_detached_holder_keeps_cap_until_run_finishes(self):
        self.box('holder', member=True)
        self.busy('holder')
        self.waiter(cap=12, pid=dead_pid(), run_id='run-holder')
        self.con.execute("UPDATE pool_cap_callers SET granted=1")
        self.con.commit()
        self.assertEqual(pool.pool_cap(self.con, 'repo'), 12)
        self.con.execute("UPDATE runs SET status='done'")
        self.con.commit()
        self.assertEqual(pool.pool_cap(self.con, 'repo'), 4)

    def test_waiter_cleaned_on_grant_and_error_and_interrupt(self):
        for error in (None, common.OffboxError('create failed'), KeyboardInterrupt()):
            with self.subTest(error=error), patch.object(lease, 'acquire_private',
                    side_effect=error if error else self.new_box()):
                if error:
                    with self.assertRaises(type(error)):
                        pool.acquire(self.me, fresh=True)
                else:
                    row = pool.acquire(self.me)
                    pool.release_guard(row)
                self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)
                self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_cap_callers').fetchone()[0], 0)
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.commit()

    def test_failed_create_rejoins_queue_before_sleeping(self):
        clock, checks = FakeClock(), []
        def sleep(seconds):
            clock.t += seconds
            self.box('available', member=True)
            old = self.con.execute('SELECT token,reserved FROM pool_waiters').fetchone()
            checks.append(old['reserved'])
            self.assertEqual(old['reserved'], 0)
            with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '0'}), \
                    patch.object(lease, 'acquire_private') as create, \
                    patch.object(allocation, '_QUEUE', contextvars.ContextVar('newer_queue', default=None)):
                with self.assertRaises(pool.PoolBusyError):
                    pool.acquire(dict(self.me, owner='newer'))
                create.assert_not_called()
        clock.time.sleep = sleep
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '10'}), patch.object(pool, 'time', clock.time), \
                patch.object(lease, 'acquire_private', side_effect=api.SupplyOut('large', None, 'supply out')), \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)), \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(checks, [0])
        self.assertEqual(row['box_id'], 'available')

    def test_holder_status_matrix_matches_active_runs_and_releases_only_its_contribution(self):
        self.box('holder', member=True)
        cases = [
            ('starting', None, None, True), ('running', None, None, True),
            ('lost', None, None, True), ('lost', 0, None, False),
            ('lost', None, 'lost_confirmed', False), ('done', 0, None, False),
            ('infra', None, None, False), ('infra', None, 'start_unknown', True),
        ]
        for status, code, marker, held in cases:
            with self.subTest(status=status, code=code, marker=marker):
                self.con.execute('DELETE FROM pool_waiters')
                self.con.execute('DELETE FROM pool_cap_callers')
                self.con.execute('DELETE FROM runs')
                self.con.execute('DELETE FROM kv')
                self.con.execute("INSERT INTO runs(run_id,box_id,status,exit_code) VALUES ('run-holder','holder',?,?)",
                                 (status, code))
                if marker:
                    self.con.execute('INSERT INTO kv(k,v) VALUES (?,?)', (marker + ':run-holder', 'fenced'))
                self.con.commit()
                self.waiter(cap=12, pid=dead_pid(), run_id='run-holder')
                self.con.execute('UPDATE pool_cap_callers SET granted=1')
                self.con.commit()
                state = pool.queue_state(self.con, 'repo')
                self.assertEqual(bool(lease.active_runs(self.con, 'holder')), held)
                self.assertEqual((state['cap'], state['busy']), (12 if held else 4, int(held)))
                if held:
                    self.con.execute("UPDATE runs SET status='running',exit_code=NULL WHERE run_id='run-holder'")
                    self.con.commit()
                    self.assertEqual(pool.pool_cap(self.con, 'repo'), 12)
        self.con.execute("DELETE FROM kv")
        self.con.execute("UPDATE runs SET status='done' WHERE run_id='run-holder'")
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('next-run','holder','running')")
        self.con.commit()
        self.assertEqual(pool.pool_cap(self.con, 'repo'), 4)

    def test_pending_resume_does_not_block_unrelated_compatible_box(self):
        for older_source in ('template:a', 'template:c', None):
            with self.subTest(older_source=older_source):
                self.con.execute('DELETE FROM pool_waiters')
                self.con.execute('DELETE FROM pool_cap_callers')
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.execute('DELETE FROM kv')
                self.con.commit()
                self.box('unanswered', member=True, source='template:a')
                self.box('ready', member=True, source='template:b')
                self.con.execute("INSERT INTO kv VALUES (?,?,?)", ('resume_unanswered:unanswered', 'large', common.now() - 3600))
                self.con.commit()
                if older_source:
                    self.waiter(source=older_source)
                with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)) as reuse, \
                        patch.object(lease, 'acquire_private') as create:
                    row = pool.acquire(self.me, template='b')
                    pool.release_guard(row)
                self.assertEqual(row['box_id'], 'ready')
                self.assertEqual([c.args[1]['box_id'] for c in reuse.call_args_list], ['ready'])
                create.assert_not_called()

    def test_failed_reuse_restores_order_before_releasing_box_guard(self):
        cases = [('normal', 'skip'), ('normal', 'none'), ('recovery', 'none'), ('recovery', 'stopped')]
        for path, result in cases:
            with self.subTest(path=path, result=result):
                for table in ('pool_waiters', 'pool_cap_callers', 'pool_members', 'pool_callers', 'leases', 'kv'):
                    self.con.execute('DELETE FROM ' + table)
                self.con.commit()
                self.box('first', member=True, used=200)
                self.box('second', member=True, used=100)
                if path == 'recovery':
                    self.con.execute("INSERT INTO kv VALUES (?,?,?)", ('resume_unanswered:first', 'large', common.now() - 3600))
                    self.con.commit()
                real_lock, checked, failed = common.file_lock, [], []
                @contextlib.contextmanager
                def lock(name, timeout=600):
                    with real_lock(name, timeout=timeout):
                        try:
                            yield
                        finally:
                            if name == 'box-first' and failed and not checked:
                                checked.append(True)
                                waiter = self.con.execute('SELECT reserved FROM pool_waiters').fetchone()
                                self.assertEqual(waiter['reserved'], 0)
                                with self.assertRaises(pool.PoolBusyError):
                                    pool.acquire(dict(self.me, owner='newer'))
                def reuse(con, row, size, **kwargs):
                    if row['box_id'] == 'first' and not failed:
                        failed.append(True)
                        if path == 'recovery':
                            con.execute("DELETE FROM kv WHERE k='resume_unanswered:first'")
                            con.commit()
                        if result == 'skip':
                            raise lease.ArchivingSkip('archiving')
                        if result == 'stopped':
                            raise lease.ResumeStopped('stopped')
                        return None
                    return dict(row)
                with patch.object(pool, 'file_lock', lock), patch.object(lease, '_reuse', side_effect=reuse), \
                        contextlib.redirect_stderr(io.StringIO()):
                    row = pool.acquire(self.me)
                    pool.release_guard(row)
                self.assertEqual(checked, [True])

    def test_unusable_alternatives_do_not_suppress_pending_recovery(self):
        for kind in ('excluded', 'stopped', 'undersized', 'locked'):
            with self.subTest(kind=kind):
                for table in ('pool_waiters', 'pool_cap_callers', 'pool_members', 'pool_callers', 'leases', 'kv'):
                    self.con.execute('DELETE FROM ' + table)
                self.con.commit()
                self.box('pending', member=True, source='template:a')
                self.box('other', state='stopped' if kind == 'stopped' else 'running', member=True,
                         size='default' if kind == 'undersized' else 'large', source='template:b')
                self.con.execute("INSERT INTO kv VALUES (?,?,?)", ('resume_unanswered:pending', 'large', common.now() - 3600))
                self.con.commit()
                guard = common.file_lock('box-other', timeout=0) if kind == 'locked' else contextlib.nullcontext()
                def recover(con, row, size, **kwargs):
                    self.assertEqual(row['box_id'], 'pending')
                    raise lease.ResumeProvisionStalled('provisioning stalled')
                with guard, patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '3'}), \
                        patch.object(lease, '_reuse', side_effect=recover) as reuse, \
                        patch.object(lease, 'acquire_private', side_effect=self.new_box('replacement')) as create, \
                        contextlib.redirect_stderr(io.StringIO()):
                    row = pool.acquire(self.me, template='b', size='xlarge' if kind == 'undersized' else None,
                                       exclude={'other'} if kind == 'excluded' else None)
                    pool.release_guard(row)
                self.assertEqual(row['box_id'], 'replacement')
                reuse.assert_called_once()
                self.assertEqual(create.call_args.args[2], 'b')

    def test_home_owner_queues_and_cap_contributions_are_separate(self):
        for current, older in [('', 'person:moni'), ('person:moni', '')]:
            with self.subTest(current=current, older=older):
                for table in ('pool_waiters', 'pool_cap_callers', 'pool_members', 'pool_callers', 'leases'):
                    self.con.execute('DELETE FROM ' + table)
                self.con.commit()
                with patch.dict(os.environ, {'OFFBOX_BACKEND': 'server', 'OFFBOX_THREAD': older}):
                    self.waiter(cap=64)
                    self.assertEqual(pool.pool_cap(self.con, 'repo'), 64)
                with patch.dict(os.environ, {'OFFBOX_BACKEND': 'server', 'OFFBOX_THREAD': current}):
                    self.box('free', member=True)
                    self.con.execute('UPDATE leases SET token_owner=?', (common.token_owner(),))
                    self.con.commit()
                    self.assertEqual(pool.queue_state(self.con, 'repo')['waiting'], 0)
                    self.assertEqual(pool.pool_cap(self.con, 'repo'), 8)
                    with patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)), \
                            contextlib.redirect_stderr(io.StringIO()):
                        row = pool.acquire(self.me)
                        pool.release_guard(row)
                    self.assertEqual(row['box_id'], 'free')

    def test_warm_relocation_yields_to_existing_waiter(self):
        self.box('warm', member=True)
        self.waiter()
        with patch.object(api, 'call', side_effect=AssertionError('no network')):
            self.assertIsNone(pool.try_warm(self.me, 'large', None, set(), 'mine'))


class PrePoolLockDatabase(Isolated):
    """1 Nov: #217 added pool_pending.source only inside CREATE TABLE IF NOT EXISTS, so the live offbox.db kept its
    4-column table and every pooled create failed with exit 90 "table pool_pending has 4 columns but 5 values"."""

    def old_table(self):
        self.con.executescript("""DROP TABLE pool_pending;
            CREATE TABLE pool_pending (
              token TEXT PRIMARY KEY, pool_key TEXT NOT NULL, pid INTEGER, created_at REAL NOT NULL
            );""")

    def cols(self):
        return [r[1] for r in self.con.execute("PRAGMA table_info(pool_pending)")]

    def test_old_database_gets_queue_tables_without_changing_pending_rows(self):
        for table in ('pool_waiters', 'pool_cap_callers', 'pool_caps'):
            self.con.execute('DROP TABLE ' + table)
        self.old_table()
        self.con.execute("INSERT INTO pool_pending VALUES ('retained','repo',1,1)")
        self.con.commit()
        capacity.schema(self.con)
        capacity.schema(self.con)
        for table in ('pool_waiters', 'pool_cap_callers', 'pool_caps'):
            self.assertEqual(self.con.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0], 0)
        self.assertEqual(tuple(self.con.execute('SELECT * FROM pool_pending').fetchone()),
                         ('retained', 'repo', 1, 1, None))

    def test_schema_adds_source_to_an_old_pool_pending(self):
        self.old_table()
        self.con.execute("INSERT INTO pool_pending VALUES ('create-old','repo',1,1)")
        self.con.commit()
        capacity.schema(self.con)
        capacity.schema(self.con)  # a second run (every offbox call runs it) changes nothing
        self.assertEqual(self.cols(), ['token', 'pool_key', 'pid', 'created_at', 'source'])
        self.assertEqual([tuple(r) for r in self.con.execute("SELECT * FROM pool_pending")],
                         [('create-old', 'repo', 1, 1.0, None)])

    def test_fresh_pool_box_is_created_on_an_old_database(self):
        self.old_table()
        self.box('one', member=True)
        self.busy('one')
        seen = []
        make = PoolLockTests.new_box(self)

        def create(me, size, template, base, fresh):
            seen.append([tuple(r)[1:2] + tuple(r)[4:] for r in self.con.execute("SELECT * FROM pool_pending")])
            return make(me, size, template, base, fresh)
        with patch.object(lease, 'acquire_private', side_effect=create), contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me, fresh=True)
            pool.release_guard(row)
        self.assertEqual(row['box_id'], 'bx_new')
        self.assertEqual(seen, [[('repo', 'fresh')]])
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM pool_pending").fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
