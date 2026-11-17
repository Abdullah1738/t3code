"""Pinned shared pool disks survive release and backend reconciliation."""
import contextlib
import io
import sqlite3
import sys
import threading
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, bases, cli, common, identity, lease, misc, pool, reap
from test_capacity import Isolated


class PinTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
        self.stack.enter_context(patch.object(bases, 'keep_pin_saved', return_value=True))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.stack.enter_context(patch.object(lease, 'now', return_value=1000))
        self.stack.enter_context(patch.object(reap, 'now', return_value=1000))
        self.stack.enter_context(patch.object(bases, 'now', return_value=1000))
        self.stack.enter_context(patch.object(pool, 'now', return_value=1000))

    def pinned(self, state='stopped'):
        self.box('bx_kept', state, member=True)
        self.con.execute("UPDATE leases SET pinned_until=87400 WHERE box_id='bx_kept'")
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'], self.me['repo_root'], 'bx_kept', 'w/mine'))
        self.con.commit()
        return dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx_kept'").fetchone())

    def assert_kept(self, state='stopped'):
        row = self.con.execute("SELECT * FROM leases WHERE box_id='bx_kept'").fetchone()
        self.assertEqual((row['state'], row['pinned_until'], row['deleted_at']), (state, 87400, None))

    def test_other_worker_cannot_release_delete_a_pinned_pool_box(self):
        self.pinned()
        with patch.object(api, 'delete', return_value={}) as delete, \
                patch.object(lease, 'release_hold_if_worker_gone'), \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'):
            with self.assertRaisesRegex(common.OffboxError, 'pinned'):
                misc.release(dict(self.me, owner='other-worker'), 'bx_kept', False, True)
        delete.assert_not_called()
        self.assert_kept()

    def test_pin_setter_and_expiry_are_named_to_another_thread(self):
        self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        self.con.commit()
        owner_a = dict(self.me, owner='thread:A')
        owner_b = dict(self.me, owner='thread:B')
        for me in (owner_a, owner_b):
            self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                             (me['owner'], me['repo_root'], 'bx_kept', 'w/mine'))
        self.con.commit()
        with contextlib.redirect_stdout(io.StringIO()):
            bases.keep(owner_a, 1)
        with patch.object(lease, 'release_hold_if_worker_gone'), patch.object(api, 'delete') as delete:
            with self.assertRaisesRegex(common.OffboxError, 'thread:A') as refusal:
                misc.release(owner_b, 'bx_kept', False, True)
        self.assertIn(common.iso(87400), str(refusal.exception))
        delete.assert_not_called()
        for days in (0, 0.5, 2):
            with self.subTest(other_thread_days=days):
                with self.assertRaisesRegex(common.OffboxError, 'thread:A'):
                    bases.keep(owner_b, days)
        self.assert_kept()
        with contextlib.redirect_stdout(io.StringIO()):
            bases.keep(owner_a, 0)
        self.assertIsNone(self.con.execute('SELECT pinned_until FROM leases').fetchone()[0])
        with patch.object(api, 'delete', return_value={}) as delete, \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'):
            misc._release_one(self.con, dict(self.con.execute('SELECT * FROM leases').fetchone()), True)
        delete.assert_called_once_with('bx_kept')

    def test_invalid_pin_durations_do_not_change_a_pin(self):
        self.pinned()
        for days in (-1, float('inf'), float('-inf'), float('nan'), 1e308, 1e12):
            with self.subTest(days=days), self.assertRaises(common.OffboxError):
                bases.keep(self.me, days)
            self.assert_kept()

    def test_positive_keep_cannot_shorten_or_adopt_an_active_legacy_pin(self):
        self.pinned()
        for days in (0.5, 1, 2):
            with self.subTest(days=days), self.assertRaisesRegex(common.OffboxError, 'setter.*unknown'):
                bases.keep(self.me, days)
            self.assert_kept()
            self.assertIsNone(common.kv_get(self.con, 'pin_owner:bx_kept'))
        self.con.execute("UPDATE leases SET pinned_until=1000")
        self.con.commit()
        with contextlib.redirect_stdout(io.StringIO()):
            bases.keep(self.me, 1)
        self.assert_kept()
        self.assertEqual(common.kv_get(self.con, 'pin_owner:bx_kept'), self.me['owner'])

    def test_lost_delete_response_fences_keep_and_reuse_until_delete_confirmed(self):
        self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        self.con.commit()
        with patch.object(api, 'delete', side_effect=api.NetworkError('response lost')), \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'):
            with self.assertRaises(common.OffboxError):
                lease.delete_box(self.con, 'bx_kept', 'release --delete')
        with contextlib.closing(common.db()) as restarted:
            self.assertIsNotNone(restarted.execute("SELECT v FROM kv WHERE k='delete_pending:bx_kept'").fetchone())
        with self.assertRaisesRegex(common.OffboxError, 'deletion.*unresolved'):
            bases.keep(self.me, 1)
        row = dict(self.con.execute('SELECT * FROM leases').fetchone())
        with patch.object(api, 'get', return_value={'state': 'archived'}) as get:
            with self.assertRaisesRegex(common.OffboxError, 'deletion.*unresolved'):
                lease._reuse(self.con, row, None)
        get.assert_not_called()
        with patch.object(api, 'delete', return_value={}), patch('offbox_lib.spend.record_final_usage'), \
                patch.object(lease.ssh_sync, 'close_master'):
            lease.delete_box(self.con, 'bx_kept', 'release --delete retry')
        self.assertIsNone(self.con.execute("SELECT v FROM kv WHERE k='delete_pending:bx_kept'").fetchone())
        self.assertEqual(self.con.execute('SELECT state FROM leases').fetchone()[0], 'deleted')

    def test_warm_handoff_skips_a_peer_with_unresolved_deletion(self):
        self.pinned('running')
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        common.kv_set(self.con, 'delete_pending:bx_kept', 'release --delete')
        with patch.object(lease, 'ensure_ttl', return_value=True), \
                patch.object(api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(lease.ssh_sync, 'ssh', return_value=SimpleNamespace(returncode=0)):
            got = pool.try_warm(dict(self.me, owner='new-worker'), 'large', None, set(), None)
            try:
                self.assertIsNone(got)
            finally:
                pool.release_guard(got)

    def test_pin_setter_clears_original_box_after_pool_reassignment_via_cli(self):
        self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        self.con.commit()
        with contextlib.redirect_stdout(io.StringIO()):
            bases.keep(self.me, 1)
        self.box('bx_next', member=True)
        self.con.execute("UPDATE pool_callers SET box_id='bx_next' WHERE owner=?", (self.me['owner'],))
        self.con.commit()
        for me, code in ((dict(self.me, owner='other-worker'), 2), (self.me, 0)):
            with self.subTest(owner=me['owner']), patch.object(identity, 'whoami', return_value=me), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(['keep', '--box', 'bx_kept', '--days', '0']), code)
        self.assertIsNone(self.con.execute("SELECT pinned_until FROM leases WHERE box_id='bx_kept'").fetchone()[0])
        self.assertEqual(self.con.execute('SELECT box_id FROM pool_callers').fetchone()[0], 'bx_next')

    def test_explicit_pin_box_uses_owning_backend_during_failover(self):
        self.pinned()
        with sqlite3.connect(common.db_path_for('server')) as home:
            self.con.backup(home)
        with sqlite3.connect(common.db_path_for('boat')) as boat:
            boat.executescript(common.SCHEMA)
            boat.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir) "
                         "VALUES ('bx_other','worker','/r','r','w/r')")
        with patch.object(common, 'home_config', return_value={'url': 'http://home'}), \
                patch.object(common, 'backend_pinned', return_value=None), \
                patch.object(common, 'default_backend', return_value='boat'):
            cases = [
                (['keep', '--box', 'bx_kept', '--days', '0'], 'server'),
                (['keep', '--box=bx_kept', '--days=0'], 'server'),
                (['keep', '--bo', 'bx_kept', '--d', '0'], 'server'),
                (['keep', '--b=bx_kept', '--days', '0'], 'server'),
                (['keep', '--box', 'bx_other', '--box=bx_kept', '--days', '0'], 'server'),
                (['keep', '--box=bx_other', '--box', 'bx_kept', '--days', '0'], 'server'),
                (['keep', '--box=bx_kept', '--box', 'bx_other', '--days', '0'], 'boat'),
            ]
            for argv, backend in cases:
                with self.subTest(argv=argv):
                    self.assertEqual(common.entry_backend(argv), backend)

    def test_central_delete_guard_rechecks_pin_after_selection(self):
        self.box('bx_kept', 'stopped')
        stale = dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx_kept'").fetchone())
        self.con.execute("UPDATE leases SET pinned_until=87400 WHERE box_id='bx_kept'")
        self.con.commit()
        with patch.object(api, 'delete', return_value={}) as delete, \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'):
            with self.assertRaisesRegex(common.OffboxError, 'pinned'):
                misc._release_one(self.con, stale, True)
        delete.assert_not_called()
        self.assert_kept()

    def test_expired_pin_can_be_deleted(self):
        self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=1000 WHERE box_id='bx_kept'")
        self.con.commit()
        with patch.object(api, 'delete', return_value={}) as delete, \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'):
            lease.delete_box(self.con, 'bx_kept', 'release --delete')
        delete.assert_called_once_with('bx_kept')
        self.assertEqual(self.con.execute("SELECT state FROM leases").fetchone()[0], 'deleted')

    def test_keep_on_home_lease_writes_only_home_database(self):
        self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        self.con.commit()
        home_path = common.db_path_for('server')
        boat_path = common.db_path_for('boat')
        with sqlite3.connect(boat_path) as boat:
            boat.executescript(common.SCHEMA)
        with sqlite3.connect(home_path) as home:
            self.con.backup(home)
        with patch.object(common, '_BACKEND', 'server'), patch.object(common, 'DB_PATH', home_path), \
                contextlib.redirect_stdout(io.StringIO()):
            bases.keep(self.me, 1)
        with sqlite3.connect(f'file:{home_path}?mode=ro', uri=True) as home:
            self.assertEqual(home.execute("SELECT pinned_until FROM leases").fetchone()[0], 87400)
            self.assertEqual(home.execute("SELECT kind FROM events").fetchone()[0], 'keep')
        with sqlite3.connect(f'file:{boat_path}?mode=ro', uri=True) as boat:
            self.assertEqual(boat.execute('SELECT COUNT(*) FROM leases').fetchone()[0], 0)
            self.assertEqual(boat.execute('SELECT COUNT(*) FROM events').fetchone()[0], 0)

    def test_keep_does_not_acknowledge_pin_while_delete_is_in_flight(self):
        row = self.pinned()
        self.con.execute("UPDATE leases SET pinned_until=NULL")
        self.con.commit()
        deleting, finish_delete, selected, kept = (threading.Event() for _ in range(4))
        errors = []

        def delete_api(_bid):
            deleting.set()
            if not finish_delete.wait(3):
                raise AssertionError('test did not finish deletion')
            return {}

        def delete_worker():
            with contextlib.closing(common.db()) as con:
                lease.delete_box(con, 'bx_kept', 'release --delete')

        def keep_worker():
            with contextlib.closing(common.db()) as con:
                def caller(_me):
                    selected.set()
                    return con, row
                with patch.object(bases, '_caller_lease', side_effect=caller):
                    try:
                        bases.keep(self.me, 1)
                        kept.set()
                    except common.OffboxError as error:
                        errors.append(str(error))

        with patch.object(api, 'delete', side_effect=delete_api), \
                patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'), \
                contextlib.redirect_stdout(io.StringIO()):
            deleting_thread = threading.Thread(target=delete_worker)
            keeping_thread = threading.Thread(target=keep_worker)
            deleting_thread.start()
            try:
                self.assertTrue(deleting.wait(3))
                keeping_thread.start()
                self.assertTrue(selected.wait(3))
                self.assertFalse(kept.is_set())
            finally:
                finish_delete.set()
                deleting_thread.join(3)
                if keeping_thread.ident is not None:
                    keeping_thread.join(3)
        self.assertFalse(deleting_thread.is_alive())
        self.assertFalse(keeping_thread.is_alive())
        self.assertFalse(kept.is_set())
        self.assertTrue(errors, 'keep must report that deletion won the race')
        self.assertEqual(self.con.execute('SELECT state, pinned_until FROM leases').fetchone()[:], ('deleted', None))

    def test_reaper_preserves_pinned_missing_expired_old_and_recipe_boxes(self):
        cases = [
            ('stopped', None),
            ('stopped', {'id': 'bx_kept', 'state': 'archived', 'dataExpiredAt': '2026-11-12T22:00:00Z'}),
            ('stopped', {'id': 'bx_kept', 'state': 'archived'}),
            ('quarantined', None),
            ('quarantined', {'id': 'bx_kept', 'state': 'archived'}),
            ('bringing_up', None),
            ('bringing_up', {'id': 'bx_kept', 'state': 'archived'}),
        ]
        self.pinned()
        for state, box in cases:
            for dry in (False, True):
                with self.subTest(state=state, box=box, dry=dry):
                    self.con.execute("UPDATE leases SET state=?, deleted_at=NULL, last_used_at=?, thread_gone_since=? WHERE box_id='bx_kept'",
                                     (state, -40 * 86400, -10 * 86400))
                    self.con.commit()
                    with patch.object(api, 'list_boxes', return_value=[box] if box else []), \
                            patch.object(api, 'get', return_value=box), patch.object(api, 'delete', return_value={}) as delete, \
                            patch.object(lease, 'release_if_confirmed', return_value=True), \
                            patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'), \
                            patch.object(bases, 'upkeep'), patch.object(reap, 'thread_get', return_value=('gone', None)):
                        actions = reap._reap(self.con, dry, [])
                    delete.assert_not_called()
                    self.assert_kept(state)
                    self.assertFalse(any(x.startswith(('delete ', 'forget ', 'would delete ', 'would forget '))
                                         for x in actions), actions)

    def test_pool_does_not_replace_own_pinned_box_after_transient_404(self):
        self.pinned()
        common.kv_set(self.con, 'pin_owner:bx_kept', self.me['owner'])
        for result in (None, {'state': 'error'}, {'state': 'cancelled'},
                       {'state': 'archived', 'dataExpiredAt': '2026-11-12T22:00:00Z'}):
            with self.subTest(result=result), patch.object(api, 'get', return_value=result), \
                    patch.object(lease, 'acquire_private', return_value={'box_id': 'bx_new', 'size': 'large'}) as create:
                with self.assertRaisesRegex(common.OffboxError, 'pinned') as refusal:
                    got = pool.acquire(self.me)
                    pool.release_guard(got)
                self.assertEqual(refusal.exception.code, 2)
                create.assert_not_called()
                self.assert_kept()

    def test_reuse_retains_pin_on_missing_error_cancelled_expired_and_timeout(self):
        row = self.pinned()
        for result in (None, {'state': 'error'}, {'state': 'cancelled'},
                       {'state': 'archived', 'dataExpiredAt': '2026-11-12T22:00:00Z'},
                       api.NetworkError('timeout')):
            with self.subTest(result=result):
                self.con.execute("UPDATE leases SET state='stopped', deleted_at=NULL WHERE box_id='bx_kept'")
                self.con.commit()
                with patch.object(api, 'get', **({'side_effect': result} if isinstance(result, Exception)
                                                else {'return_value': result})):
                    with self.assertRaises(common.OffboxError):
                        lease._reuse(self.con, row, None)
                self.assert_kept()

    def test_expiry_during_resume_keeps_pinned_lease(self):
        row = self.pinned()
        with patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(api, 'resume', side_effect=api.ApiError(409, 'snapshot_data_expired', 'gone')):
            with self.assertRaisesRegex(common.OffboxError, 'pinned'):
                lease._reuse(self.con, row, None)
        self.assert_kept()

    def test_pinned_archived_disk_is_resumed(self):
        row = self.pinned()
        with patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(lease, '_resume_confirmed', return_value=(True, False)) as resume, \
                patch.object(lease, '_bring_up_resumed', return_value={'type': 'large'}), \
                patch.object(lease, '_resumed_row', side_effect=lambda c, b, *_a: dict(c.execute(
                    'SELECT * FROM leases WHERE box_id=?', (b,)).fetchone())):
            got = lease._reuse(self.con, row, None)
        self.assertEqual(got['box_id'], 'bx_kept')
        resume.assert_called_once()
        self.assert_kept('running')

    def test_pinned_base_cannot_be_removed(self):
        self.pinned()
        self.con.execute("INSERT INTO bases(name,box_id,repo_key,token_owner) VALUES ('repo:default','bx_kept','repo','ardud')")
        self.con.commit()
        with patch.object(api, 'delete') as delete, patch.object(api, 'delete_saved') as delete_saved:
            with self.assertRaisesRegex(common.OffboxError, 'pinned'):
                bases.rm_base(self.me, 'default')
        delete.assert_not_called()
        delete_saved.assert_not_called()
        self.assertEqual(self.con.execute('SELECT count(*) FROM bases').fetchone()[0], 1)

    def test_stop_is_refused_before_404_and_does_not_forget_pin(self):
        self.pinned()
        with patch.object(api, 'stop', side_effect=api.ApiError(404, 'not_found', 'missing')) as stop, \
                patch.object(api, 'get', return_value=None):
            with self.assertRaisesRegex(lease.PinnedLeaseError, 'pinned'):
                lease.stop_box(self.con, 'bx_kept', 'release', images=False)
        stop.assert_not_called()
        self.assert_kept()

    def test_deleted_pinned_box_notice_names_deletion_event(self):
        self.pinned()
        self.con.execute("UPDATE leases SET state='deleted', deleted_at=900 WHERE box_id='bx_kept'")
        self.con.execute("INSERT INTO events VALUES (900,'bx_kept','delete','release --delete op=None')")
        self.con.commit()
        self.box('bx_new', member=True)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            pool._claim(self.con, self.me, {'box_id': 'bx_new'}, None)
        self.assertIn('was pinned', err.getvalue())
        self.assertIn('release --delete op=None', err.getvalue())
        self.assertIn('delete at', err.getvalue())
