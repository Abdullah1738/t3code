"""The pool lock covers only choosing a box (31 Oct, edge-api: a 900 s resume under the pool lock failed every other
caller with exit 90 "timed out waiting for lock pool-..."). Offline: no boat calls."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import threading
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, capacity, cli, common, lease, pool, runs  # noqa: E402
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

        def claim(con, me, row, run_id):
            seen_lock_free.append(pool_lock_free())

            def other():
                try:
                    second['row'] = pool.acquire(dict(self.me, owner='other'))
                except pool.PoolBusyError as e:
                    second['error'] = e
            th = threading.Thread(target=other)
            th.start()
            th.join(10)
            return real_claim(con, me, row, run_id)

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


if __name__ == '__main__':
    unittest.main()
