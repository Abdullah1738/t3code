"""A failed home resume retires only that candidate; pins reserve pool state for their owner."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated
from offbox_lib import api, common, home, lease, misc, pool

REASON = '500 boot_timeout: old did not finish booting sshd in 120s'


class BootPinsTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_BACKEND': 'server'}))
        self.stack.enter_context(patch.object(common, '_BACKEND', 'server'))
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(home, 'may_fail_over', return_value=True))
        self.resumed = False
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.send = self.stack.enter_context(patch.object(api, '_call', return_value={'sandbox': {'id': 'new'}}))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'setup'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'wait_ssh'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(lease, 'run_recipe'))

    def pin(self, bid='old', owner='A', expired=False):
        self.con.execute('UPDATE leases SET pinned_until=? WHERE box_id=?',
                         (common.now() + (-60 if expired else 3600), bid))
        if owner is not None:
            common.kv_set(self.con, 'pin_owner:' + bid, owner)
        self.con.commit()

    def row(self, bid='old'):
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone()

    def take(self, **kwargs):
        got = pool.acquire(self.me, **kwargs)
        pool.release_guard(got)
        return got

    def states(self, bid, **kwargs):
        if bid == 'old':
            return {'id': bid, 'state': 'archived', 'type': 'large', 'error': REASON if self.resumed else None,
                    'updatedAt': '2099-01-01T00:00:00Z'}
        return {'id': bid, 'state': 'running', 'type': 'large'}

    def assert_set_aside(self):
        row = self.row()
        self.assertEqual(row['state'], 'resume_stalled')
        self.assertIn(REASON, row['note'])
        self.assertTrue(lease.boot_dead(self.con, 'old'))
        self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='resume_boot_timeout'").fetchone()[0], 1)
        self.assertFalse(common.HOME_FAILURES.exists())
        self.assertIn('120s', self.err.getvalue())
        self.assertNotIn('not reachable', self.err.getvalue())

    def test_pool_replaces_failed_resume_and_next_run_skips_it(self):
        self.box('old', 'stopped', member=True)
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)) as resume, \
                patch.object(api, 'delete') as delete:
            got = self.take(template='crpko-go', size='large')
            self.assertEqual(got['box_id'], 'new')
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()
        self.assertEqual(resume.call_count, 1)
        delete.assert_not_called()
        self.assertEqual((got['source'].replace('recipe:', 'template:'), got['size']), ('template:crpko-go', 'large'))

    def test_private_replaces_failed_resume_and_next_run_skips_it(self):
        self.box('old', 'stopped')
        self.con.execute('UPDATE leases SET owner=?,repo_root=?', (self.me['owner'], self.me['repo_root']))
        self.con.commit()
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)) as resume:
            self.assertEqual(lease.acquire_private(self.me)['box_id'], 'new')
            self.assertEqual(lease.acquire_private(self.me)['box_id'], 'new')
        self.assert_set_aside()
        self.assertEqual(resume.call_count, 1)

    def test_rowless_marker_survives_later_local_import(self):
        error = api.BoxBootFailed('old', 'archived', REASON, 500, 'boot_timeout')
        lease._set_aside_boot(self.con, 'old', error)
        self.assertTrue(lease.boot_dead(self.con, 'old'))
        self.box('old', 'stopped', member=True)
        self.assertEqual(pool.candidates(self.con, 'repo', None, None, self.me)[0], [])
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)) as resume:
            self.assertEqual(self.take()['box_id'], 'new')
        resume.assert_not_called()

    def test_failed_own_pin_is_retained_without_remote_mutation(self):
        self.box('old', 'stopped', member=True)
        self.pin(owner=self.me['owner'])
        until = lease.pinned_until(self.con, 'old')
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)), \
                patch.object(api, 'delete') as delete, patch.object(api, 'stop') as stop:
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()
        self.assertEqual(lease.pinned_until(self.con, 'old'), until)
        self.assertEqual(common.kv_get(self.con, 'pin_owner:old'), self.me['owner'])
        delete.assert_not_called()
        stop.assert_not_called()

    def test_direct_box_start_error_uses_another_home_box(self):
        for code in ('boot_timeout', 'incus_failed', 'port_in_use'):
            with self.subTest(code=code):
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.execute('DELETE FROM pool_callers')
                self.con.execute('DELETE FROM kv')
                self.box('old', 'stopped', member=True)
                with patch.object(api, 'readiness_get', side_effect=self.states), \
                        patch.object(api, 'resume', side_effect=api.ApiError(500, code, 'full server reason 120s')):
                    self.assertEqual(self.take()['box_id'], 'new')
                self.assertIn('full server reason 120s', lease.boot_dead(self.con, 'old'))

    def test_unhealthy_server_does_not_set_box_aside(self):
        self.box('old', 'stopped', member=True)
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)), \
                patch.object(home, 'probe', return_value='HTTP 503'), patch.object(home, 'may_fail_over', return_value=True):
            with self.assertRaises(lease.ResumeUnresolved) as caught:
                self.take()
        self.assertTrue(home.unreachable(caught.exception))
        self.assertFalse(lease.boot_dead(self.con, 'old'))

    def test_pin_owner_expiry_legacy_and_unproven_matrix(self):
        self.box('old', member=True)
        self.box('free', 'stopped', member=True)
        for owner, expired, caller, expected in (
            ('A', False, {'owner': 'B'}, 'free'),
            ('A', False, {'owner': 'A'}, 'old'),
            ('A', True, {'owner': 'B'}, 'old'),
            (None, False, {'owner': 'A'}, 'free'),
            ('A', False, None, 'free'),
            ('A', False, {'owner': 'A', 'proven': False}, 'free'),
        ):
            with self.subTest(owner=owner, expired=expired, caller=caller):
                self.con.execute("DELETE FROM kv WHERE k='pin_owner:old'")
                self.pin(owner=owner, expired=expired)
                with patch.object(pool, 'pool_cap', return_value=2):
                    rows, room = pool.candidates(self.con, 'repo', None, None, caller)
                self.assertEqual(rows[0]['box_id'], expected)
                self.assertFalse(room)  # pins still consume capacity
                self.assertEqual(len(pool.members(self.con, 'repo')), 2)

    def test_only_foreign_pin_queues_and_records_one_event_per_acquire(self):
        self.box('old', member=True)
        self.pin()
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), patch.object(lease, '_reuse') as reuse, \
                patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)) as resume:
            with self.assertRaises(pool.PoolBusyError):
                self.take()
        reuse.assert_not_called()
        resume.assert_not_called()
        self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='pool_skip_pinned'").fetchone()[0], 1)

    def test_warm_handoff_requires_pin_boot_and_remote_hold_checks_together(self):
        self.box('old', member=True)
        cases=[('free',None,False,False,True),
               ('own_pin',self.me['owner'],False,False,True),
               ('own_pin_held',self.me['owner'],False,True,False),
               ('foreign_pin','another-thread',False,False,False),
               ('boot_dead',None,True,False,False),
               ('held',None,False,True,False)]
        for name,owner,dead,held,expected in cases:
            with self.subTest(name=name):
                self.con.execute('UPDATE leases SET pinned_until=NULL')
                self.con.execute("DELETE FROM kv WHERE k IN ('pin_owner:old','boot_dead:old')")
                if owner:
                    self.pin(owner=owner)
                if dead:
                    common.kv_set(self.con,'boot_dead:old','boot-dead fixture')
                self.con.commit()
                peer=dict(state='running',type='large',heldRuns=['run-still-alive'] if held else [])
                with patch.object(lease,'ensure_ttl',return_value=True),patch.object(api,'get',return_value=peer), \
                     patch.object(lease.ssh_sync,'ssh',return_value=SimpleNamespace(returncode=0)), \
                     patch.object(pool,'_claim') as claim:
                    got=pool.try_warm(self.me,'large',None,set(),None)
                    try:
                        self.assertEqual(got is not None,expected)
                        self.assertEqual(claim.call_count,int(expected))
                    finally:
                        pool.release_guard(got)

    def test_running_member_beats_own_archived_member(self):
        self.box('old', 'stopped', member=True)
        self.box('warm', member=True)
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'], self.me['repo_root'], 'old', 'w/own'))
        self.con.commit()
        with patch.object(lease, '_reuse', side_effect=lambda c, r, *a, **kw: dict(r)):
            self.assertEqual(self.take()['box_id'], 'warm')

    def test_release_names_foreign_pin_but_keeps_own_wording(self):
        self.box('old', 'stopped')
        for owner in ('A', self.me['owner'], None):
            with self.subTest(owner=owner):
                self.con.execute("DELETE FROM kv WHERE k='pin_owner:old'")
                self.pin(owner=owner)
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    misc.release(self.me, 'old', False, False)
                self.assertEqual('next offbox run resumes it' in out.getvalue(), owner == self.me['owner'])
                if owner != self.me['owner']:
                    self.assertIn('pinned by ' + (owner or 'an unknown thread'), out.getvalue())

    def test_status_and_list_explain_set_aside(self):
        self.box('old', 'stopped')
        lease._set_aside_boot(self.con, 'old', api.BoxBootFailed('old', 'archived', REASON, 500, 'boot_timeout'))
        with patch.object(api, 'list_boxes', return_value=[self.states('old')]), patch.object(api, 'limits', return_value={}):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                misc.status(self.me)
                misc.list_leases(self.me, True, False)
        self.assertEqual(out.getvalue().count(REASON), 2)

    def test_pending_resume_terminal_error_does_not_wait_or_resend(self):
        self.box('old', 'stopped', member=True)
        self.resumed = True
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:old','large',?)", (common.now() - 301,))
        self.con.commit()
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)) as resume:
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()
        resume.assert_not_called()

    def test_confirmed_starting_resume_terminal_error_is_set_aside(self):
        self.resumed = True
        self.box('old', 'stopped', member=True)
        with patch.object(api, 'readiness_get', side_effect=self.states), \
                patch.object(lease, '_resume_confirmed', return_value=({'state': 'starting'}, False)):
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()

    def test_replacement_preserves_explicit_saved_base(self):
        self.box('old', 'stopped', member=True, source='base:repo:seed')
        self.con.execute("INSERT INTO bases(name,repo_key,box_id,size,saved) VALUES ('repo:seed','repo','seed-box','large','snapshot')")
        self.con.commit()
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume', side_effect=lambda *a, **kw: setattr(self, 'resumed', True)):
            got = self.take(base='seed', size='large')
        self.assertEqual((got['source'], got['size']), ('base:repo:seed', 'large'))
        self.assert_set_aside()

    def test_foreign_pin_is_skipped_once_for_same_run_reacquire(self):
        self.box('old', member=True)
        self.box('free', 'stopped', member=True)
        self.pin()
        with patch.object(lease, '_reuse', side_effect=lambda c, r, *a, **kw: dict(r)):
            self.assertEqual(self.take(run_id='same-run')['box_id'], 'free')
            self.pin(owner='C')
            self.assertEqual(self.take(run_id='same-run')['box_id'], 'free')
            self.pin(owner='A')
            got = pool.acquire(dict(self.me, owner='A'))
            pool.release_guard(got)
            self.assertEqual(got['box_id'], 'old')
        self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE kind='pool_skip_pinned'").fetchone()[0], 1)

    def test_existing_terminal_boot_reason_is_never_resumed_again(self):
        self.box('old', 'stopped', member=True)
        self.resumed = True
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume') as resume:
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()
        resume.assert_not_called()

    def test_boat_boot_error_keeps_existing_policy(self):
        self.box('old', 'stopped')
        error = api.ApiError(500, 'boot_timeout', 'Boat failed')
        with patch.object(home, 'active', return_value=False), patch.object(lease, '_reuse_available', side_effect=error):
            with self.assertRaises(api.ApiError) as caught:
                lease._reuse(self.con, self.row(), None)
        self.assertIs(caught.exception, error)
        self.assertFalse(lease.boot_dead(self.con, 'old'))

    def test_foreign_pending_resume_is_observed_without_taking_pinned_disk(self):
        self.box('old', 'stopped', member=True)
        self.pin()
        self.resumed = True
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:old','large',?)", (common.now() - 301,))
        self.con.commit()
        until = lease.pinned_until(self.con, 'old')
        with patch.object(api, 'readiness_get', side_effect=self.states), patch.object(api, 'resume') as resume, \
                patch.object(api, 'delete') as delete, patch.object(api, 'stop') as stop:
            self.assertEqual(self.take()['box_id'], 'new')
        self.assert_set_aside()
        self.assertEqual(lease.pinned_until(self.con, 'old'), until)
        self.assertEqual(common.kv_get(self.con, 'pin_owner:old'), 'A')
        resume.assert_not_called()
        delete.assert_not_called()
        stop.assert_not_called()

    def test_live_foreign_pending_resume_no_longer_fences_new_capacity(self):
        self.box('old', member=True)
        self.pin()
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:old','large',?)", (common.now() - 301,))
        self.con.commit()
        with patch.object(api, 'readiness_get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(api, 'resume') as resume:
            self.assertEqual(self.take()['box_id'], 'new')
        self.assertIsNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:old'").fetchone())
        resume.assert_not_called()
        self.assertEqual(lease.foreign_pin(self.con, 'old', self.me)[0], 'A')

    def test_fifo_ignores_a_waiter_that_cannot_use_the_pin(self):
        self.box('old', member=True)
        self.pin()
        self.con.execute("INSERT INTO runs(run_id,owner,status) VALUES ('earlier','B','starting')")
        self.con.execute("INSERT INTO pool_waiters(pool_key,token,pid,run_id,queued_at) VALUES (?,'first',?,'earlier',?)",
                         (pool._queue_key('repo'), os.getpid(), common.now()))
        self.con.commit()
        self.assertFalse(pool._older(self.con, 'repo', 'second', self.row()))
        self.con.execute("UPDATE runs SET owner='A' WHERE run_id='earlier'")
        self.con.commit()
        self.assertTrue(pool._older(self.con, 'repo', 'second', self.row()))

    def test_pending_pin_published_while_locking_is_not_taken(self):
        self.box('old', 'stopped', member=True)
        self.box('warm', member=True)
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:old','large',?)", (common.now() - 301,))
        self.con.commit()
        original = pool.file_lock
        published = False

        @contextlib.contextmanager
        def locking(name, *args, **kwargs):
            nonlocal published
            with original(name, *args, **kwargs):
                if name == 'box-old' and not published:
                    self.pin()
                    published = True
                yield

        with patch.object(pool, 'file_lock', side_effect=locking), \
                patch.object(lease, '_reuse', side_effect=lambda c, r, *a, **kw: dict(r)) as reuse:
            self.assertEqual(self.take()['box_id'], 'warm')
        self.assertTrue(published)
        self.assertEqual([c.args[1]['box_id'] for c in reuse.call_args_list], ['warm'])
        self.assertEqual(common.kv_get(self.con, 'pin_owner:old'), 'A')

    def test_pinned_reconciliation_transients_allow_ready_peer(self):
        from offbox_lib import allocation
        self.box('old', 'stopped', member=True)
        self.box('warm', member=True)
        self.pin()
        for error in (allocation.Busy('starter busy'), allocation.Fenced('retained create'),
                      lease.ArchivingSkip('stopping', code=92), lease.ResumeStopped('archived', code=92)):
            with self.subTest(error=type(error).__name__):
                self.con.execute("INSERT OR REPLACE INTO kv VALUES ('resume_unanswered:old','large',?)", (common.now() - 301,))
                self.con.commit()
                with patch.object(lease, '_resume_confirmed', side_effect=error), \
                        patch.object(lease, '_reuse', side_effect=lambda c, r, *a, **kw: dict(r)) as reuse:
                    self.assertEqual(self.take()['box_id'], 'warm')
                self.assertTrue(all(c.args[1]['box_id'] == 'warm' for c in reuse.call_args_list))
                self.assertEqual(common.kv_get(self.con, 'pin_owner:old'), 'A')

    def test_terminal_server_reason_forms(self):
        for reason, expected in (
            ('500 boot_timeout: sshd in 120s', True),
            ('500 boot_timeout', True),
            ('500 boot_timeout sshd in 120s', True),
            ('500 incus_failed: proxy failed', True),
            ('500 port_in_use', True),
            ('5000 boot_timeout', False),
            ('400 boot_timeout: bad input', False),
            ('500 unrelated: old error', False),
            (None, False),
        ):
            with self.subTest(reason=reason):
                failure = api.box_boot_failure('old', {'state': 'archived', 'error': reason})
                self.assertEqual(failure is not None, expected)
                if failure:
                    self.assertEqual(failure.reason, reason)
