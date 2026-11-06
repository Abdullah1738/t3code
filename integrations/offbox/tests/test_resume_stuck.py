"""Resume retries and pool failover, with a fake boat and clock."""
import contextlib
import io
import os
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / 'tests'))
from offbox_lib import api, common, lease, pool  # noqa: E402
from test_capacity import Isolated  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def time(self):
        return self.t

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += max(seconds, 0.000001)


class ResumeStuckTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        self.resumes = []
        self.stack.enter_context(patch.object(api, 'time', self.clock))
        self.stack.enter_context(patch.object(lease, 'time', self.clock))
        self.stack.enter_context(patch.object(lease, 'now', self.clock.time))
        self.stack.enter_context(patch.object(api, 'resume', side_effect=self.resume))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'setup'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'wait_ssh'))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(lease, 'idle_for', return_value=0))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'cfg_path', lambda bid: Path('/nonexistent') / bid))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def resume(self, box_id, ttl, size=None):
        self.resumes.append((box_id, ttl, size, self.clock.t))
        return {}

    def row(self, box_id):
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (box_id,)).fetchone()

    def events(self, box_id, kind):
        return self.con.execute('SELECT * FROM events WHERE box_id=? AND kind=?', (box_id, kind)).fetchall()

    def state(self, box_id, state):
        return {'id': box_id, 'state': state, 'type': 'large'}

    def test_archived_then_live_after_resend(self):
        self.box('cold', 'stopped')

        def get(box_id):
            return self.state(box_id, 'idle' if len(self.resumes) >= 2 else 'archived')

        with patch.object(api, 'get', side_effect=get):
            got = lease._reuse(self.con, self.row('cold'), None)
        self.assertEqual(got['state'], 'running')
        self.assertEqual(len(self.resumes), 2)
        self.assertGreaterEqual(self.resumes[1][3] - self.resumes[0][3], lease.RESUME_STUCK_S)
        self.assertEqual(len(self.events('cold', 'resume_resent')), 1)
        self.assertEqual(len(self.events('cold', 'resume_stuck')), 0)

    def test_bare_502_on_archived_retry_caps_provisioning_then_creates_first(self):
        self.box('cold', 'stopped', used=200, member=True)
        self.box('sibling', 'stopped', used=100, member=True)
        new = {'box_id': 'new', 'state': 'running', 'size': 'large', 'source': 'fresh'}

        def resume(box_id, ttl, size=None):
            self.resume(box_id, ttl, size)
            if len(self.resumes) == 2:
                raise api.ApiError(502, 'http_502', '')
            return {}

        def get(box_id, **kwargs):
            if kwargs:
                self.assertIsNotNone(self.con.execute(
                    "SELECT v FROM kv WHERE k='resume_unanswered:cold'").fetchone())
            return self.state(box_id, 'provisioning' if len(self.resumes) >= 2 else 'archived')

        with patch.dict(os.environ, {'OFFBOX_RESUME_PROVISION_SECONDS': '4'}), \
                patch.object(api, 'resume', side_effect=resume), patch.object(api, 'get', side_effect=get), \
                patch.object(lease, 'acquire_private', return_value=new) as create, \
                patch.object(api, 'delete') as delete:
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'new')
            self.assertEqual([r[0] for r in self.resumes], ['cold', 'cold'])
            self.assertAlmostEqual(self.clock.t - self.resumes[1][3], 4)
            self.assertTrue(create.call_args.args[4])
            self.assertEqual(self.row('cold')['state'], 'resume_stalled')
            self.assertEqual(self.row('sibling')['state'], 'resume_stalled')
            delete.assert_not_called()
        finally:
            pool.release_guard(got)

    def test_unanswered_stopped_confirmation_spends_the_archived_retry(self):
        self.box('cold', 'stopped', member=True)
        new = {'box_id': 'new', 'state': 'running', 'size': 'large', 'source': 'fresh'}

        def resume(box_id, ttl, size=None):
            self.resume(box_id, ttl, size)
            if len(self.resumes) == 1:
                raise api.NetworkError('read timed out')
            return {}

        with patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS': '4'}), \
                patch.object(api, 'resume', side_effect=resume), \
                patch.object(api, 'get', side_effect=lambda bid, **kw: self.state(bid, 'archived')), \
                patch.object(lease, 'acquire_private', return_value=new):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'new')
            self.assertEqual(len(self.resumes), 2)
            self.assertEqual(len(self.events('cold', 'resume_stuck')), 1)
        finally:
            pool.release_guard(got)

    def test_unanswered_archived_retry_still_stopped_never_sends_third(self):
        self.box('cold', 'stopped', member=True)

        def resume(box_id, ttl, size=None):
            self.resume(box_id, ttl, size)
            if len(self.resumes) == 2:
                raise api.NetworkError('read timed out')
            return {}

        with patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS': '4'}), \
                patch.object(api, 'resume', side_effect=resume), \
                patch.object(api, 'get', side_effect=lambda bid, **kw: self.state(bid, 'archived')), \
                patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(lease.ResumeUnresolved):
                pool.acquire(self.me)
        self.assertEqual(len(self.resumes), 2)
        self.assertIsNotNone(self.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:cold'").fetchone())
        create.assert_not_called()

    def test_busy_queue_does_not_retry_archived_box_again_in_same_invocation(self):
        self.box('cold', 'stopped', member=True)
        self.box('busy', 'running', member=True)
        self.busy('busy')
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '190'}), \
                patch.object(pool, 'time', self.clock), patch.object(pool, '_refresh_background'), \
                patch.object(api, 'get', side_effect=lambda bid: self.state(bid, 'archived')), \
                patch.object(lease, 'acquire_private') as create:
            with self.assertRaises(pool.PoolBusyError):
                pool.acquire(self.me)
        self.assertEqual(len(self.resumes), 2)
        self.assertGreaterEqual(self.clock.t - self.resumes[0][3], 190)
        create.assert_not_called()

    def test_stuck_pool_box_is_skipped_and_next_stopped_box_used(self):
        self.box('stuck', 'stopped', used=200, member=True)
        self.box('free', 'stopped', used=100, member=True)

        def get(box_id):
            resumed = any(r[0] == box_id for r in self.resumes)
            return self.state(box_id, 'idle' if box_id == 'free' and resumed else 'archived')

        with patch.object(api, 'get', side_effect=get), \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('pool is full')):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'free')
            self.assertEqual(self.row('stuck')['state'], 'stopped')
            self.assertEqual([r[0] for r in self.resumes], ['stuck', 'stuck', 'free'])
            self.assertLess(self.clock.t - self.resumes[0][3], 2 * lease.RESUME_STUCK_S + 2)
            self.assertEqual(len(self.events('stuck', 'resume_resent')), 1)
            self.assertEqual(len(self.events('stuck', 'resume_stuck')), 1)
        finally:
            pool.release_guard(got)

    def test_stuck_box_under_cap_allows_a_new_pool_box(self):
        self.box('stuck', 'stopped', used=200, member=True)
        new = {'box_id': 'new', 'state': 'running', 'size': 'large', 'source': 'fresh'}
        with patch.object(api, 'get', side_effect=lambda bid: self.state(bid, 'archived')), \
                patch.object(lease, 'acquire_private', return_value=new.copy()) as create:
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'new')
            create.assert_called_once()
            self.assertEqual(self.row('stuck')['state'], 'stopped')
        finally:
            pool.release_guard(got)

    def test_slow_starting_box_is_never_resent_or_skipped(self):
        self.box('slow', 'stopped', member=True)
        t0 = self.clock.t

        def get(box_id):
            elapsed = self.clock.t - t0
            state = 'archived' if elapsed < 2 else 'resuming' if elapsed < 300 else 'running'
            return self.state(box_id, state)

        with patch.object(api, 'get', side_effect=get):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'slow')
            self.assertGreaterEqual(self.clock.t - t0, 300)
            self.assertEqual(len(self.resumes), 1)
            self.assertFalse(self.events('slow', 'resume_resent'))
            self.assertFalse(self.events('slow', 'resume_stuck'))
        finally:
            pool.release_guard(got)

    def test_direct_caller_errors_after_two_resumes_and_leaves_lease_stopped(self):
        # The local record can say running even though boat already archived it.
        self.box('stuck', 'running')
        with patch.object(api, 'get', side_effect=lambda bid: self.state(bid, 'archived')):
            with self.assertRaisesRegex(common.OffboxError, "boat didn't start stuck after two resumes; nothing ran, retry") as cm:
                lease._reuse(self.con, self.row('stuck'), None)
        self.assertEqual(cm.exception.code, common.EXIT_INFRA)
        self.assertEqual(self.row('stuck')['state'], 'stopped')
        self.assertEqual(len(self.resumes), 2)
        self.assertEqual(len(self.events('stuck', 'resume_stuck')), 1)
        self.assertLess(self.clock.t - self.resumes[0][3], 2 * lease.RESUME_STUCK_S + 2)
