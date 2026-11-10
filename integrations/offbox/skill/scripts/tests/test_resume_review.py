"""Allocation-source, pending-resume rollout and outage regressions for card 463's review."""
import contextlib
import io
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated
from test_exit_and_queue import FakeClock
from offbox_lib import allocation, api, cli, fallback, lease, misc, outage, pool, runs


class ResumeRecoveryTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.clock.time.time = lambda: self.clock.t
        for mod in (lease, pool):
            self.stack.enter_context(patch.object(mod, 'time', self.clock.time))
        self.stack.enter_context(patch.object(allocation, 'now', lambda: self.clock.t))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_RESUME_PROVISION_SECONDS': '4'}))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def pending(self, bid, state='stopped'):
        self.box(bid, state, member=True)
        self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'resume_unanswered:{bid}', 'large', self.clock.t))
        self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'resume_provision:{bid}', str(self.clock.t + 4), self.clock.t))
        self.con.commit()

    def base(self, default=False):
        self.con.execute("INSERT INTO bases(name,repo_key,box_id,size,is_default,saved) "
                         "VALUES ('repo:seed','repo','seed-box','large',?,'seed-snapshot')", (int(default),))
        self.con.commit()

    def allocate(self, **kwargs):
        # Real acquire_private/_new_box/_create_row and API allocation guard, only transport/SSH are fake.
        with patch.object(api, '_call', return_value={'sandbox': {'id': 'new'}}) as send, \
                patch.object(lease, '_bring_up', return_value={'state': 'running', 'type': 'large'}):
            got = pool.acquire(self.me, **kwargs)
        pool.release_guard(got)
        return got, send

    def preserved_source(self, source, size=None, default=False, template=None):
        self.pending('old')
        if source.startswith('base:'):
            self.base(default)
        else:
            self.con.execute("INSERT INTO templates(name,box_id,size,saved) VALUES (?,'template-box','large','template-snapshot')",
                             (source.split(':')[1],))
            self.con.commit()
        with patch.object(api, 'get', return_value={'state': 'provisioning', 'type': 'large'}), \
                patch.object(api, 'resume') as resume, patch.object(api, 'delete') as delete:
            got, send = self.allocate(base='seed' if source.startswith('base:') and not default else None,
                                      template=template, size=size)
        self.assertEqual((got['source'], got['size']), (source, size or 'large'))
        body = send.call_args_list[0].args[2]
        self.assertIn('from', body)
        self.assertEqual(body['type'], size or 'large')
        resume.assert_not_called()
        delete.assert_not_called()
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], 'resume_stalled')
        self.assertIsNotNone(self.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:old'").fetchone())

    def test_stalled_resume_replacement_preserves_explicit_saved_base(self):
        self.preserved_source('base:repo:seed')

    def test_replacement_base_does_not_leave_different_source_pending_sibling_blocking(self):
        self.pending('sibling')
        self.preserved_source('base:repo:seed')
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='sibling'").fetchone()[0],
                         'resume_stalled')

    def test_stalled_resume_replacement_preserves_default_saved_base(self):
        self.preserved_source('base:repo:seed', default=True)

    def test_stalled_resume_replacement_preserves_explicit_template_and_size(self):
        self.preserved_source('template:crpko-harness', size='xlarge', template='crpko-harness')

    def test_stalled_resume_replacement_preserves_auto_template(self):
        with patch.object(lease, 'pick_template', return_value='crpko-go'):
            self.preserved_source('template:crpko-go')

    def test_release_delete_clears_markers_and_allows_real_replacement(self):
        self.pending('old')
        self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume','old','uncertain')",
                         (self.clock.t,))
        self.con.commit()
        with patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'), \
                patch.object(api, 'delete', return_value={}), contextlib.redirect_stdout(io.StringIO()):
            misc.release(self.me, 'old', False, True)
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 0)
        with patch.object(api, 'get') as get, patch.object(api, 'resume') as resume:
            got, _ = self.allocate()
        self.assertEqual(got['box_id'], 'new')
        get.assert_not_called()
        resume.assert_not_called()

    def test_failed_delete_retains_markers_and_blocks_replacement(self):
        self.pending('old')
        with patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'), \
                patch.object(api, 'delete', side_effect=api.NetworkError('offline')):
            with self.assertRaises(api.NetworkError):
                lease.delete_box(self.con, 'old', 'test')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 2)
        with allocation.scope('repo'), patch.object(api, '_call') as send:
            with self.assertRaises(allocation.Unresolved):
                api.create('large', 1200, 'new', 'key')
        send.assert_not_called()

    def test_missing_pending_box_is_settled_and_replaced(self):
        self.pending('old')
        with patch.object(api, 'get', return_value=None), patch.object(api, 'resume') as resume:
            got, _ = self.allocate()
        self.assertEqual(got['box_id'], 'new')
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], 'deleted')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 0)
        resume.assert_not_called()

    def test_expired_pending_box_is_settled_and_replaced(self):
        self.pending('old')
        with patch.object(api, 'get', return_value={'state': 'archived', 'dataExpiredAt': '2026-11-01'}):
            got, _ = self.allocate()
        self.assertEqual(got['box_id'], 'new')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 0)

    def test_pending_box_disappears_during_provisioning_and_is_replaced(self):
        self.pending('old')
        with patch.object(api, 'get', side_effect=[{'state': 'provisioning', 'type': 'large'}, None]):
            got, _ = self.allocate()
        self.assertEqual(got['box_id'], 'new')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 0)

    def test_deletion_settles_journal_so_it_cannot_be_recovered(self):
        self.pending('old')
        self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume','old','http_504')",
                         (self.clock.t - 1,))
        self.con.commit()
        with patch('offbox_lib.spend.record_final_usage'), patch.object(lease.ssh_sync, 'close_master'), \
                patch.object(api, 'delete', return_value={}):
            lease.delete_box(self.con, 'old', 'test')
        allocation.recover_resumes(self.con, 'repo')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%:old'").fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT outcome FROM start_requests WHERE box_id='old'").fetchone()[0], 'settled')

    def test_journal_only_two_box_rollout_has_one_cap_then_creates_without_resume(self):
        for outcome in ('uncertain', 'http_502', 'http_504', 'http_520', 'http_524'):
            with self.subTest(outcome=outcome):
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM kv')
                self.con.execute('DELETE FROM start_requests')
                self.con.execute('DELETE FROM events')
                self.con.execute('DELETE FROM pool_members')
                for bid in ('one', 'two'):
                    self.box(bid, 'stopped', member=True)
                    self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume',?,?)",
                                     (self.clock.t - 2, bid, outcome))
                self.con.commit()
                if not self.con.execute('SELECT 1 FROM bases').fetchone():
                    self.base(True)
                started = self.clock.t
                with patch.object(api, 'get', return_value={'state': 'provisioning', 'type': 'large'}), \
                        patch.object(api, 'resume') as resume, patch.object(api, 'delete') as delete:
                    got, _ = self.allocate()
                self.assertEqual((got['box_id'], got['source'], got['size']), ('new', 'base:repo:seed', 'large'))
                self.assertLessEqual(self.clock.t - started, 4)
                self.assertEqual([r[0] for r in self.con.execute("SELECT state FROM leases WHERE box_id<>'new'")],
                                 ['resume_stalled', 'resume_stalled'])
                self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_unanswered:%'").fetchone()[0], 2)
                resume.assert_not_called()
                delete.assert_not_called()

    def test_old_or_superseded_journal_is_not_reimported(self):
        self.box('old', 'stopped', member=True)
        self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume','old','uncertain')",
                         (self.clock.t - 901,))
        self.con.commit()
        allocation.recover_resumes(self.con, 'repo')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%'").fetchone()[0], 0)
        self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume','old','http_502')",
                         (self.clock.t - 2,))
        self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume','old','ok')",
                         (self.clock.t - 1,))
        self.con.commit()
        allocation.recover_resumes(self.con, 'repo')
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_%'").fetchone()[0], 0)


class BringUpOutageTests(Isolated):
    def test_running_box_outage_exhaustion_never_allocates_replacement(self):
        self.box('warm', 'running', member=True)
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        reads = [0]

        def get(*args, **kwargs):
            reads[0] += 1
            if reads[0] > 1:
                raise api.NetworkError('offline')
            return {'state': 'running', 'type': 'large'}

        def remote(a, me):
            got = pool.acquire(me)
            pool.release_guard(got)
            self.fail('command must not start during the outage')

        args = cli.build_parser().parse_args(['run', '--remote', '--', 'make', 'test'])
        with patch.dict(os.environ, {'OFFBOX_OUTAGE_WAIT_SECONDS': '60'}), \
                patch.object(cli, 'time', clock.time), patch.object(outage, 'time', clock.time), \
                patch.object(outage, 'now', lambda: clock.t), patch.object(api, 'get', side_effect=get), \
                patch.object(api, 'probe', return_value='no answer'), \
                patch('offbox_lib.localfirst.decide', return_value='test'), \
                patch.object(lease.ssh_sync, 'cfg_path', return_value=self.tmp_path()), \
                patch.object(lease, 'acquire_private') as create, patch.object(api, 'resume') as resume, \
                patch.object(runs, 'run_remote', side_effect=remote), patch.object(fallback, 'note_infra_failure'), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            rc = cli.cmd_run(args, self.me)
        self.assertEqual(rc, 90)
        self.assertEqual(clock.t, 1060)
        self.assertIn('boat.dev is down', err.getvalue())
        create.assert_not_called()
        resume.assert_not_called()

    def test_running_box_second_get_outage_waits_then_uses_same_box(self):
        for cause in (api.NetworkError('offline'), api.ApiError(525, 'http_525', '')):
            with self.subTest(cause=str(cause)):
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.box('warm', 'running', member=True)
                clock = FakeClock()
                clock.time.time = lambda: clock.t
                executed = []
                reads = [0]

                def get(*args, **kwargs):
                    reads[0] += 1
                    if reads[0] == 2:
                        raise cause
                    return {'state': 'running', 'type': 'large'}

                def remote(a, me):
                    got = pool.acquire(me)
                    pool.release_guard(got)
                    executed.append(got['box_id'])
                    return 0

                args = cli.build_parser().parse_args(['run', '--remote', '--', 'make', 'test'])
                with patch.object(cli, 'time', clock.time), patch.object(outage, 'time', clock.time), \
                        patch.object(outage, 'now', lambda: clock.t), patch.object(api, 'get', side_effect=get), \
                        patch.object(api, 'probe', return_value=None) as probe, \
                        patch('offbox_lib.localfirst.decide', return_value='test'), \
                        patch.object(lease.ssh_sync, 'cfg_path', return_value=self.tmp_path()), \
                        patch.object(lease.ssh_sync, 'setup'), patch.object(lease.ssh_sync, 'wait_ssh'), \
                        patch.object(lease, 'ensure_ttl'), patch.object(lease, 'acquire_private') as create, \
                        patch.object(api, 'resume') as resume, patch.object(runs, 'run_remote', side_effect=remote), \
                        patch.object(fallback, 'note_infra_failure'), contextlib.redirect_stderr(io.StringIO()) as err:
                    rc = cli.cmd_run(args, self.me)
                self.assertEqual((rc, executed), (0, ['warm']))
                self.assertEqual(clock.t, 1015)
                probe.assert_called_once()
                self.assertIn('boat.dev API is down', err.getvalue())
                if isinstance(cause, api.ApiError):
                    self.assertIn('HTTP 525', err.getvalue())
                create.assert_not_called()
                resume.assert_not_called()

    def tmp_path(self):
        from pathlib import Path
        return Path(self.tmp.name) / 'no-ssh-cfg'

    def test_wrapped_outage_keeps_started_status(self):
        from offbox_lib.common import OffboxError
        cause = OffboxError('lost after start', started=True, outage=True)
        error = lease.ResumeUnresolved('not ready', cause)
        self.assertTrue(error.started)
        self.assertTrue(error.outage)


class PersistentArchivedTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.clock.time.time = lambda: self.clock.t
        for mod in (api, lease, pool):
            self.stack.enter_context(patch.object(mod, 'time', self.clock.time))
        self.stack.enter_context(patch.object(lease, 'now', lambda: self.clock.t))
        self.stack.enter_context(patch.object(allocation, 'now', lambda: self.clock.t))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'setup'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'wait_ssh'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'cfg_path', return_value=Path(self.tmp.name) / 'no-cfg'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS': '4'}))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def pending(self, bid, journal=False):
        self.box(bid, 'stopped', member=True)
        if journal:
            self.con.execute("INSERT INTO start_requests(ts,operation,box_id,outcome) VALUES (?,'resume',?,'uncertain')",
                             (self.clock.t - 1, bid))
        else:
            self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'resume_unanswered:{bid}', 'large', self.clock.t))
        self.con.commit()

    def test_two_pending_archived_boxes_reconcile_then_single_retry_succeeds(self):
        self.pending('one', journal=True)
        self.pending('two', journal=True)
        sends = []

        def get(bid, **kwargs):
            return {'state': 'running' if bid in sends else 'archived', 'type': 'large'}

        with patch.object(api, 'get', side_effect=get), \
                patch.object(api, 'resume', side_effect=lambda bid, *args: sends.append(bid)), \
                patch.object(lease, 'acquire_private') as create:
            for _ in range(2):
                got = pool.acquire(self.me)
                pool.release_guard(got)
        self.assertEqual(len(sends), 1)
        self.assertEqual(got['box_id'], sends[0])
        self.assertLess(self.clock.t, 1009)
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'resume_unanswered:%'").fetchone()[0], 0)
        create.assert_not_called()

    def test_pending_acknowledged_retry_still_archived_uses_sibling_within_bound(self):
        for journal in (False, True):
            with self.subTest(journal=journal):
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.execute('DELETE FROM pool_callers')
                self.con.execute('DELETE FROM kv')
                self.con.execute('DELETE FROM start_requests')
                self.con.execute('DELETE FROM events')
                self.pending('cold', journal)
                self.box('sibling', 'stopped', member=True)
                sends = []
                started = self.clock.t

                def get(bid, **kwargs):
                    return {'state': 'running' if bid == 'sibling' and bid in sends else 'archived', 'type': 'large'}

                with patch.object(api, 'get', side_effect=get), \
                        patch.object(api, 'resume', side_effect=lambda bid, *args: sends.append(bid)), \
                        patch.object(lease, 'acquire_private') as create:
                    got = pool.acquire(self.me)
                    pool.release_guard(got)
                self.assertEqual(got['box_id'], 'sibling')
                self.assertEqual(sends, ['cold', 'sibling'])
                self.assertLess(self.clock.t - started, 4 + lease.RESUME_STUCK_S + 2)
                self.assertEqual(self.con.execute("SELECT count(*) FROM events WHERE box_id='cold' AND kind='resume_stuck'").fetchone()[0],
                                 1)
                create.assert_not_called()

    def test_direct_pending_retry_acknowledged_but_archived_is_bounded(self):
        self.pending('cold')
        row = self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone()
        with patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(api, 'resume', return_value={}) as resume:
            with self.assertRaisesRegex(lease.ResumeUnresolved, 'after two resumes'):
                lease._reuse(self.con, row, None)
        resume.assert_called_once()
        self.assertLess(self.clock.t, 1000 + 4 + lease.RESUME_STUCK_S + 2)

    def test_two_pending_archived_reconcile_before_any_retry_send(self):
        for bid in ('one', 'two'):
            self.pending(bid, journal=True)
        observations = set()
        sends = []

        def get(bid, **kwargs):
            if kwargs:
                observations.add(bid)
            return {'state': 'running' if bid in sends else 'archived', 'type': 'large'}

        def resume(bid, *args):
            self.assertEqual(observations, {'one', 'two'})
            sends.append(bid)

        with patch.object(api, 'get', side_effect=get), patch.object(api, 'resume', side_effect=resume):
            got = pool.acquire(self.me)
            pool.release_guard(got)
        self.assertEqual(len(sends), 1)
