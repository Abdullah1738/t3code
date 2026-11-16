"""Full pools queue source changes without deleting their old disks."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import toollog
from offbox_lib import common, lease, misc, pool
from test_capacity import Isolated
from test_exit_and_queue import FakeClock
from test_pool_lock import pool_lock_free


class PoolRecycleTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_TOOL_LOG_DIR': str(Path(self.tmp.name)/'tools')}))
        self.box('old', member=True, used=common.now()-100)
        self.box('busy', member=True)
        self.busy('busy')
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(pool, '_recheck_prune_holds'))
        self.stack.enter_context(patch.object(lease, 'delete_box', side_effect=AssertionError('never delete')))
        self.stack.enter_context(patch.object(lease.api, 'delete', side_effect=AssertionError('never delete')))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def events(self, kind):
        return [json.loads(r[0]) for r in self.con.execute(
            'SELECT detail FROM events WHERE kind=? ORDER BY rowid', (kind,))]

    def reset_recycle(self):
        self.con.execute("DELETE FROM leases WHERE box_id='new'")
        self.con.execute("DELETE FROM pool_members WHERE box_id='new'")
        self.con.execute('DELETE FROM pool_callers')
        self.con.execute('DELETE FROM pool_cap_callers')
        self.con.execute('DELETE FROM events')
        self.con.execute("UPDATE leases SET state='running',note=NULL WHERE box_id='old'")
        self.con.execute("INSERT OR REPLACE INTO pool_members VALUES ('old','repo')")
        self.con.commit()

    def create(self, me, size, template, base, fresh):
        self.assertTrue(pool_lock_free())
        self.assertEqual(pool._pending(self.con, 'repo'), 1)
        self.assertFalse(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
        self.assertTrue(self.con.execute("SELECT note FROM leases WHERE box_id='old'").fetchone()[0].startswith('recycled:'))
        self.box('new', source=pool._source('repo', template, base, fresh))
        return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())

    def stop(self, con, bid, reason, **kwargs):
        self.assertTrue(pool_lock_free())
        self.assertTrue(kwargs['locked'])
        with self.assertRaises(common.OffboxError):
            with common.file_lock('box-'+bid, timeout=0):
                pass
        con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (bid,))
        con.commit()
        return True

    def test_template_recycles_idle_member_and_reserves_source(self):
        with patch.object(lease, 'stop_box', side_effect=self.stop) as stop, \
                patch.object(lease, 'acquire_private', side_effect=self.create) as create:
            got = pool.acquire(self.me, template='generic', run_id='request')
            pool.release_guard(got)
        self.assertEqual(got['box_id'], 'new')
        stop.assert_called_once()
        create.assert_called_once()
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)
        rows = self.events('pool_recycle')
        self.assertEqual([r['result'] for r in rows], ['detached', 'created'])
        for row in rows:
            self.assertEqual((row['run_id'], row['pool_key'], row['needed_source'], row['box_id']),
                             ('request', 'repo', 'template:generic', 'old'))
            self.assertEqual((row['source'], row['size'], row['state_before']),
                             ('template:crpko-go', 'large', 'running'))
            self.assertGreaterEqual(row['age_seconds'], 100)
            self.assertEqual(row['run_count'], 0)
            self.assertGreaterEqual(row['wait_seconds'], 0)
        self.assertEqual(rows[-1]['new_box_id'], 'new')

    def test_all_busy_queues_with_position_then_recycles(self):
        self.busy('old')
        clock = FakeClock()
        original_sleep = clock.time.sleep
        observed = []
        def free(seconds):
            state = pool.queue_state(self.con, 'repo', 'request', source='template:generic')
            observed.append((state['busy'], state['place']))
            self.con.execute("UPDATE runs SET status='done' WHERE box_id='old'")
            self.con.commit()
            original_sleep(seconds)
        clock.time.sleep = free
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '10'}), \
                patch.object(pool, 'time', clock.time), patch.object(lease, 'stop_box', side_effect=self.stop), \
                patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic', run_id='request')
            pool.release_guard(got)
        self.assertEqual(observed, [(2, 1)])
        waits = self.events('pool_recycle_wait')
        self.assertEqual(len(waits), 1)
        self.assertEqual((waits[0]['busy'], waits[0]['idle'], waits[0]['serving']), (2, 0, 0))

    def test_base_recycles_stopped_member_without_stop(self):
        self.con.execute("UPDATE leases SET state='stopped' WHERE box_id='old'")
        self.con.commit()
        with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, base='tools')
            pool.release_guard(got)
        stop.assert_not_called()
        self.assertEqual(self.events('pool_recycle')[0]['needed_source'], 'base:repo:tools')

    def test_recycled_marker_prevents_adoption_even_with_room(self):
        self.con.execute("UPDATE leases SET note='recycled: pool slot for template:generic' WHERE box_id='old'")
        self.con.execute("DELETE FROM pool_members WHERE box_id='old'")
        self.con.commit()
        self.assertNotIn('old', [r['box_id'] for r in pool.candidates(self.con, 'repo', None, None, self.me)[0]])

    def test_protected_members_are_never_recycled(self):
        for form in ('pin', 'own_pin', 'legacy_pin', 'hold', 'base', 'template', 'locked', 'pin_locked',
                     'unanswered', 'provisioning', 'deleting', 'start_unknown', 'unconfirmed_lost'):
            with self.subTest(form=form), contextlib.ExitStack() as held:
                self.con.execute('DELETE FROM kv')
                self.con.execute('DELETE FROM bases')
                self.con.execute('DELETE FROM templates')
                self.con.execute('DELETE FROM prune_holds')
                self.con.execute("DELETE FROM runs WHERE box_id='old'")
                self.con.execute("UPDATE leases SET pinned_until=NULL WHERE box_id='old'")
                if form in ('pin', 'own_pin', 'legacy_pin'):
                    self.con.execute("UPDATE leases SET pinned_until=? WHERE box_id='old'", (common.now()+1000,))
                    if form != 'legacy_pin':
                        common.kv_set(self.con, 'pin_owner:old', self.me['owner'] if form == 'own_pin' else 'other')
                elif form == 'hold':
                    self.con.execute("INSERT INTO prune_holds(box_id,run_id,created_at) VALUES ('old','cleanup',1)")
                elif form in ('base', 'template'):
                    self.con.execute(f"INSERT INTO {form}s(name,box_id) VALUES ('protected','old')")
                elif form in ('locked', 'pin_locked'):
                    held.enter_context(common.file_lock(('box-' if form == 'locked' else 'pin-')+'old', timeout=0))
                elif form in ('unanswered', 'provisioning', 'deleting'):
                    prefix = dict(unanswered='resume_unanswered:', provisioning='resume_provision:', deleting='delete_pending:')[form]
                    common.kv_set(self.con, prefix+'old', {})
                else:
                    self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('uncertain','old',?)",
                                     ('infra' if form == 'start_unknown' else 'lost',))
                    if form == 'start_unknown':
                        common.kv_set(self.con, 'start_unknown:uncertain', {})
                self.con.commit()
                with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private') as create, \
                        patch.object(pool, '_reconcile_pinned'):
                    with self.assertRaises(pool.PoolBusyError):
                        pool.acquire(self.me, template='generic')
                stop.assert_not_called()
                create.assert_not_called()
                self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
                self.assertFalse(self.events('pool_recycle'))

    def test_stopped_then_lru_is_recycled(self):
        self.con.execute("UPDATE runs SET status='done'")
        self.con.execute("UPDATE leases SET state='stopped',last_used_at=? WHERE box_id='old'", (common.now(),))
        self.con.commit()
        with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        stop.assert_not_called()
        self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='busy'").fetchone())

    def test_failed_stop_keeps_disk_detached_and_create_succeeds(self):
        with patch.object(lease, 'stop_box', side_effect=common.OffboxError('stop unavailable')), \
                patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        self.assertEqual(got['box_id'], 'new')
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)
        failure = [r for r in self.events('pool_recycle') if r['result'] == 'stop_failed']
        self.assertEqual(failure[0]['error'], 'stop unavailable')
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], 'running')
        self.assertNotIn('old', [r['box_id'] for r in pool.candidates(self.con, 'repo', None, None, self.me)[0]])
        with common.file_lock('box-old', timeout=0), common.file_lock('pin-old', timeout=0):
            pass

    def test_failed_create_releases_pending_slot_but_not_recycled_disk(self):
        with patch.object(lease, 'stop_box', side_effect=self.stop), \
                patch.object(lease, 'acquire_private', side_effect=common.OffboxError('create unavailable')):
            with self.assertRaisesRegex(common.OffboxError, 'create unavailable'):
                pool.acquire(self.me, template='generic')
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)
        self.assertFalse(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
        with common.file_lock('box-old', timeout=0), common.file_lock('pin-old', timeout=0):
            pass

    def test_older_waiter_gets_its_compatible_member(self):
        self.con.execute("INSERT INTO pool_waiters(pool_key,token,pid,source,queued_at) "
                         "VALUES ('repo','older',?,'template:crpko-go',?)", (os.getpid(), common.now()-10))
        self.con.commit()
        with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(pool.PoolBusyError):
                pool.acquire(self.me, template='generic')
        stop.assert_not_called()
        create.assert_not_called()
        with patch.object(lease, '_reuse', side_effect=lambda c,r,s,**kw: dict(r)):
            with common.db() as con:
                # The first waiter's normal selection still sees its original warm box.
                self.assertFalse(pool._older(con, 'repo', 'older', pool.members(con, 'repo')[0]))
            self.con.execute("DELETE FROM pool_waiters")
            self.con.commit()
            got = pool.acquire(self.me, template='crpko-go')
            pool.release_guard(got)
        self.assertEqual(got['box_id'], 'old')

    def test_same_source_waiter_queues_behind_pending_recycle(self):
        make = self.create
        second_pid = os.getpid() + 1
        def create(*args):
            # Real callers have distinct client PIDs; failed callers clear only their own pending rows.
            with patch.object(pool.os, 'getpid', return_value=second_pid), patch.object(pool, '_alive', return_value=True), \
                    patch.object(lease, 'acquire_private', side_effect=AssertionError('second create')):
                with self.assertRaises(pool.PoolBusyError):
                    pool.acquire(dict(self.me, owner='second'), template='generic')
            self.assertEqual(len(self.events('pool_recycle')), 1)
            return make(*args)
        with patch.object(lease, 'stop_box', side_effect=self.stop) as stop, \
                patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        stop.assert_called_once()

    def test_recycle_events_reach_tool_logs_and_rollup(self):
        logs = Path(self.tmp.name)/'tools'
        with patch.dict(os.environ, {'OFFBOX_TOOL_LOG_DIR': str(logs)}), \
                patch.object(lease, 'stop_box', side_effect=self.stop), \
                patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic', run_id='request')
            pool.release_guard(got)
            rollup = toollog.rollup()
        rows = [json.loads(line) for path in logs.glob('*.ndjson') for line in path.read_text().splitlines()]
        recycled = [r for r in rows if r['name'] == 'pool_recycle']
        self.assertEqual(rollup['countsByName']['pool_recycle'], 2)
        self.assertEqual(recycled[-1]['ids'], dict(run='request', box='old', newBox='new'))
        self.assertEqual(recycled[-1]['props']['repo'], toollog.repo_id('repo'))
        for field in ('source', 'fromSource', 'size', 'stateBefore', 'result', 'ageSeconds', 'runCount', 'waitSeconds',
                      'deficit', 'members_before', 'cap'):
            self.assertIn(field, recycled[-1]['props'])

    def test_pin_published_at_box_guard_boundary_is_rechecked(self):
        real_lock = pool.file_lock
        @contextlib.contextmanager
        def publish(name, *args, **kwargs):
            with real_lock(name, *args, **kwargs):
                if name == 'box-old':
                    self.con.execute("UPDATE leases SET pinned_until=? WHERE box_id='old'", (common.now()+1000,))
                    self.con.commit()
                yield
        with patch.object(pool, 'file_lock', side_effect=publish), patch.object(lease, 'stop_box') as stop, \
                patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(pool.PoolBusyError):
                pool.acquire(self.me, template='generic')
        stop.assert_not_called()
        create.assert_not_called()

    def test_pin_guard_stays_held_until_stop_finishes(self):
        def stop(con, bid, reason, **kwargs):
            with self.assertRaises(common.OffboxError):
                with common.file_lock('pin-'+bid, timeout=0):
                    pass
            return self.stop(con, bid, reason, **kwargs)
        with patch.object(lease, 'stop_box', side_effect=stop), patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)

    def test_expired_pin_is_recyclable(self):
        self.con.execute("UPDATE leases SET pinned_until=? WHERE box_id='old'", (common.now()-1,))
        self.con.commit()
        with patch.object(lease, 'stop_box', side_effect=self.stop), patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        self.assertLess(lease.pinned_until(self.con, 'old'), common.now())

    def test_lru_among_equal_states(self):
        self.con.execute("UPDATE runs SET status='done'")
        self.con.execute("UPDATE leases SET last_used_at=? WHERE box_id='busy'", (common.now(),))
        self.con.commit()
        with patch.object(lease, 'stop_box', side_effect=self.stop), patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='busy'").fetchone())

    def test_cap_drop_recycles_only_when_enough_idle_members_exist(self):
        self.box('surplus', member=True)
        self.busy('surplus')
        with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(pool.PoolBusyError):
                pool.acquire(self.me, template='generic')
        stop.assert_not_called()
        create.assert_not_called()
        self.assertFalse(self.events('pool_recycle'))
        self.con.execute("UPDATE runs SET status='done' WHERE box_id='surplus'")
        self.con.commit()
        with patch.object(lease, 'stop_box', side_effect=self.stop) as stop, \
                patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        self.assertEqual(stop.call_count, 2)
        self.assertEqual(len(pool.members(self.con, 'repo')), 2)

    def test_not_full_pool_creates_without_recycling(self):
        self.con.execute("DELETE FROM pool_members WHERE box_id='busy'")
        self.con.commit()
        def create(*args):
            self.box('new', source='template:generic')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())
        with patch.object(lease, 'stop_box') as stop, patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        stop.assert_not_called()
        self.assertFalse(self.events('pool_recycle'))

    def test_twelve_members_at_cap_eight_queue_until_five_slots_can_be_recycled(self):
        for i in range(10):
            self.box(f'extra-{i}', member=True, state='stopped')
            if i >= 3:
                self.busy(f'extra-{i}')
        self.assertEqual(len(pool.members(self.con, 'repo')), 12)
        clock = FakeClock()
        original_sleep = clock.time.sleep
        observed = []

        def free(seconds):
            state = pool.queue_state(self.con, 'repo', 'over-cap', source='template:generic')
            observed.append((state['total'], state['cap'], state['place']))
            self.assertFalse(self.events('pool_recycle'))
            self.assertEqual(pool._pending(self.con, 'repo'), 0)
            self.con.execute("UPDATE runs SET status='done' WHERE box_id='extra-3'")
            self.con.commit()
            original_sleep(seconds)

        def create(*args):
            self.assertEqual(len(pool.members(self.con, 'repo')), 7)
            self.assertEqual(pool.pool_cap(self.con, 'repo'), 8)
            return self.create(*args)

        clock.time.sleep = free
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '8', 'OFFBOX_POOL_WAIT_SECONDS': '10'}), \
                patch.object(pool, 'time', clock.time), patch.object(lease, 'stop_box', side_effect=self.stop) as stop, \
                patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, template='generic', run_id='over-cap')
            pool.release_guard(got)
            self.assertEqual(len(pool.members(self.con, 'repo')), 8)
        self.assertEqual(observed, [(12, 8, 1)])
        self.assertEqual(stop.call_count, 1)
        detached = [r for r in self.events('pool_recycle') if r['result'] == 'detached']
        self.assertEqual(len(detached), 5)
        self.assertEqual({r['box_id'] for r in detached}, {'old', 'extra-0', 'extra-1', 'extra-2', 'extra-3'})
        for event in detached:
            self.assertEqual((event['run_id'], event['deficit'], event['members_before'], event['cap']),
                             ('over-cap', 5, 12, 8))
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)

    def test_idle_resume_stalled_members_do_not_consume_slots_or_get_reused(self):
        self.con.execute("UPDATE leases SET state='resume_stalled' WHERE box_id='old'")
        for i in range(10):
            self.box(f'stalled-{i}', member=True, state='resume_stalled')
        self.con.commit()
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_members').fetchone()[0], 12)
        self.assertEqual(len(pool.members(self.con, 'repo')), 1)

        def create(*args):
            self.assertTrue(pool_lock_free())
            self.assertEqual(pool._pending(self.con, 'repo'), 1)
            self.box('new', source='base:repo:tools')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())

        with patch.object(lease, 'stop_box') as stop, patch.object(lease, '_reuse') as reuse, \
                patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, base='tools')
            pool.release_guard(got)
        self.assertEqual(got['box_id'], 'new')
        stop.assert_not_called()
        reuse.assert_not_called()
        self.assertFalse(self.events('pool_recycle'))

    def test_recycled_marker_stays_excluded_in_full_and_nonfull_pools(self):
        self.con.execute("UPDATE leases SET note='recycled: prior source' WHERE box_id='old'")
        self.box('third')
        self.con.execute("INSERT INTO pool_cap_callers(token,pool_key,pid,cap) VALUES ('cap','repo',?,2)", (os.getpid(),))
        self.con.commit()
        for full in (False, True):
            with self.subTest(full=full):
                self.con.execute('DELETE FROM pool_members')
                self.con.execute("INSERT INTO pool_members VALUES ('old','repo')")
                if full:
                    self.con.execute("INSERT INTO pool_members VALUES ('third','repo')")
                self.con.execute("INSERT INTO pool_members VALUES ('busy','repo')")
                self.con.commit()
                self.assertEqual(pool._room(self.con, 'repo'), not full)
                self.assertNotIn('old', [r['box_id'] for r in pool.members(self.con, 'repo')])
                self.assertNotIn('old', [r['box_id'] for r in pool.candidates(self.con, 'repo', None, None, self.me)[0]])

    def test_retained_disk_is_visible_without_promising_pool_reuse(self):
        self.con.execute("UPDATE leases SET state='stopped',note='recycled: pool slot for template:generic' WHERE box_id='old'")
        self.con.commit()
        old = self.con.execute("SELECT * FROM leases WHERE box_id='old'").fetchone()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me, True, False)
            misc._release_one(self.con, old, False, self.me)
            with patch.object(lease.api, 'limits', return_value={}), \
                    patch.object(lease.api, 'list_boxes', return_value=[dict(id='old', state='archived', type='large')]):
                misc.status(self.me)
        self.assertIn('recycled: pool slot for template:generic', out.getvalue())
        self.assertIn('detached from the repository pool', out.getvalue())
        self.assertIn('detached [recycled: pool slot for template:generic]', out.getvalue())
        self.assertNotIn('next offbox run resumes it', out.getvalue())

    def test_missing_box_stop_settles_without_reentering_pin_guard(self):
        real_lock = lease.file_lock
        pin_calls = []
        def lock(name, *args, **kwargs):
            if name == 'pin-old':
                pin_calls.append(name)
                kwargs['timeout'] = 0
            return real_lock(name, *args, **kwargs)
        with patch.object(lease, 'file_lock', side_effect=lock), \
                patch.object(lease.api, 'stop', side_effect=lease.api.ApiError(404, 'not_found', 'not found')), \
                patch.object(lease.api, 'get', return_value=None), \
                patch.object(lease, 'keep_images'), patch.object(lease.ssh_sync, 'close_master'), \
                patch.object(lease, 'acquire_private', side_effect=self.create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        self.assertEqual(pin_calls, [])
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], 'deleted')
        self.assertNotIn('stop_failed', [r['result'] for r in self.events('pool_recycle')])

    def test_stop_response_and_confirmation_matrix(self):
        # A 404 may race a state read; transport failure is never proof that the disk disappeared.
        confirmations = [('gone', None, True), ('archived', {'state': 'archived'}, True),
                         *[(state, {'state': state}, False) for state in
                           ('ready', 'idle', 'running', 'starting', 'archiving', 'error', 'unknown')],
                         ('missing-state', {}, False),
                         ('transport-error', common.OffboxError('get unavailable'), False),
                         ('api-error', lease.api.ApiError(503, 'unavailable', 'get unavailable'), False)]
        real_lock = lease.file_lock
        def lock(name, *args, **kwargs):
            if name == 'pin-old':
                raise AssertionError('pin lock reacquired')
            return real_lock(name, *args, **kwargs)
        for status, (form, response, confirmed) in ((status, case) for status in (200, 404, 500)
                                                  for case in confirmations):
            with self.subTest(status=status, confirmation=form):
                self.reset_recycle()
                run_id = f'stop-{status}-{form}'
                stop_error = None if status == 200 else lease.api.ApiError(status, 'stop_failed', 'stop unavailable')
                failed = status == 500 or (status == 404 and not confirmed)
                state = 'stopped' if status == 200 else 'deleted' if confirmed and status == 404 else 'running'
                with contextlib.ExitStack() as held:
                    held.enter_context(patch.object(lease, 'file_lock', side_effect=lock))
                    held.enter_context(patch.object(lease.api, 'stop', side_effect=stop_error))
                    held.enter_context(patch.object(lease.api, 'get', side_effect=response if isinstance(response, Exception) else None,
                                                    return_value=response))
                    held.enter_context(patch.object(lease, 'keep_images'))
                    held.enter_context(patch.object(lease.ssh_sync, 'close_master'))
                    held.enter_context(patch.object(lease, 'acquire_private', side_effect=self.create))
                    got = pool.acquire(self.me, template='generic', run_id=run_id)
                    pool.release_guard(got)
                self.assertEqual(got['box_id'], 'new')
                self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], state)
                events = self.events('pool_recycle')
                expected = ['detached', 'stop_failed', 'created'] if failed else ['detached', 'created']
                self.assertEqual([r['result'] for r in events], expected)
                self.assertFalse(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
                self.assertEqual(pool._pending(self.con, 'repo'), 0)
                self.assertEqual(events[-1]['new_box_id'], 'new')
                rows = [json.loads(line) for path in (Path(self.tmp.name)/'tools').glob('*.ndjson')
                        for line in path.read_text().splitlines()]
                analytics = [r for r in rows if r['name'] == 'pool_recycle' and r['ids']['run'] == run_id]
                self.assertEqual([r['props']['result'] for r in analytics], expected)
                self.assertEqual([r['ok'] for r in analytics], [True, False, True] if failed else [True, True])
                if failed:
                    self.assertTrue(events[1]['error'])
                    self.assertEqual(events[1]['error_class'], 'OffboxError' if status == 404 else 'ApiError')
                    self.assertEqual(analytics[1]['props']['errorClass'], events[1]['error_class'])
                    self.assertEqual(analytics[1]['error']['tag'], 'recycle_stop_failed')
                    if status == 404:
                        self.assertIn('not confirmed', events[1]['error'])
                with common.file_lock('box-old', timeout=0), common.file_lock('pin-old', timeout=0):
                    pass

    def test_cap_increase_before_recycle_creates_without_detaching(self):
        recycle = pool._recycle_slot
        def increase(*args):
            self.con.execute("INSERT INTO pool_cap_callers(token,pool_key,pid,cap) VALUES ('larger','repo',?,?)",
                             (os.getpid(), limit))
            self.con.commit()
            return recycle(*args)
        def create(*args):
            self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
            self.box('new', source='template:generic')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())
        for limit in (3, 4):
            with self.subTest(cap=limit):
                self.reset_recycle()
                with patch.object(pool, '_recycle_slot', side_effect=increase), patch.object(lease, 'stop_box') as stop, \
                        patch.object(lease, 'acquire_private', side_effect=create):
                    got = pool.acquire(self.me, template='generic')
                    pool.release_guard(got)
                stop.assert_not_called()
                self.assertEqual(pool.pool_cap(self.con, 'repo'), limit)
                self.assertFalse(self.events('pool_recycle'))

    def test_cap_publication_at_box_guard_boundary_is_rechecked(self):
        real_lock = pool.file_lock
        @contextlib.contextmanager
        def increase(name, *args, **kwargs):
            with real_lock(name, *args, **kwargs):
                if name == 'box-old':
                    self.con.execute("INSERT INTO pool_cap_callers(token,pool_key,pid,cap) VALUES ('larger','repo',?,3)",
                                     (os.getpid(),))
                    self.con.commit()
                yield
        def create(*args):
            self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
            self.box('new', source='template:generic')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())
        with patch.object(pool, 'file_lock', side_effect=increase), patch.object(lease, 'stop_box') as stop, \
                patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        stop.assert_not_called()
        self.assertFalse(self.events('pool_recycle'))

    def test_failed_pending_create_at_guard_boundary_frees_room_without_recycle(self):
        self.con.execute("DELETE FROM pool_members WHERE box_id='busy'")
        self.con.execute("INSERT INTO pool_pending VALUES ('other','repo',?,?,'template:other')", (os.getpid(), common.now()))
        self.con.commit()
        real_lock = pool.file_lock
        @contextlib.contextmanager
        def fail_pending(name, *args, **kwargs):
            with real_lock(name, *args, **kwargs):
                if name == 'box-old':
                    self.con.execute("DELETE FROM pool_pending WHERE token='other'")
                    self.con.commit()
                yield
        def create(*args):
            self.assertTrue(self.con.execute("SELECT 1 FROM pool_members WHERE box_id='old'").fetchone())
            self.assertEqual(pool._pending(self.con, 'repo'), 1)
            self.box('new', source='template:generic')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())
        with patch.object(pool, 'file_lock', side_effect=fail_pending), patch.object(lease, 'stop_box') as stop, \
                patch.object(lease, 'acquire_private', side_effect=create):
            got = pool.acquire(self.me, template='generic')
            pool.release_guard(got)
        stop.assert_not_called()
        self.assertFalse(self.events('pool_recycle'))

    def test_long_stop_error_remains_complete_valid_local_json(self):
        for reason in ('short', 'x'*1999, 'x'*2000, 'x'*2001, 'x'*3000, '\u03a9"\\\n'*1000):
            with self.subTest(length=len(reason)):
                self.reset_recycle()
                with patch.object(lease, 'stop_box', side_effect=common.OffboxError(reason)), \
                        patch.object(lease, 'acquire_private', side_effect=self.create):
                    got = pool.acquire(self.me, template='generic')
                    pool.release_guard(got)
                errors = [row for row in self.events('pool_recycle') if row['result'] == 'stop_failed']
                self.assertEqual(errors[0]['error'], reason)
                raw = ''.join(p.read_text() for p in (Path(self.tmp.name)/'tools').glob('*.ndjson'))
                self.assertNotIn(reason, raw)
                self.assertIn('recycle_stop_failed', raw)
