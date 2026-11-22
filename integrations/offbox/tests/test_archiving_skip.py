"""A box stuck in 'archiving' must not stall its repository pool (card #95, 28 Oct).

Fake api only: no boat calls. The pool lock is held by pool._acquire while it runs lease._reuse, so an
archiving member must be skipped without any wait there.
"""
import contextlib
import io
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, common, lease, pool  # noqa: E402
if __package__:
    from .client_fixtures import Isolated, FakeClock
else:
    from client_fixtures import Isolated, FakeClock


class FakeBoats:
    """Answers api.get from a script: box id -> list of states returned in order (last one repeats)."""

    def __init__(self, states):
        self.states = {bid: list(seq) for bid, seq in states.items()}
        self.calls = []

    def get(self, box_id):
        self.calls.append(box_id)
        seq = self.states[box_id]
        st = seq.pop(0) if len(seq) > 1 else seq[0]
        return {'id': box_id, 'state': st, 'type': 'large'}


class ArchivingSkipTests(Isolated):
    def setUp(self):
        super().setUp()
        # Keep the fixture's pool at cap 2 with both members listed; no ssh, no ttl calls.
        self.stack.enter_context(patch.object(lease, '_bring_up', return_value={}))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(lease, 'idle_for', return_value=0))
        self.stack.enter_context(patch('offbox_lib.ssh_sync.cfg_path', lambda bid: Path('/nonexistent/' + bid)))

    def row(self, bid):
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone()

    def test_stopping_at_cap_keeps_queueing_until_a_peer_is_free(self):
        self.stopping_at_cap()

    def test_own_stopping_box_at_cap_keeps_queueing_until_a_peer_is_free(self):
        self.stopping_at_cap(own=True)

    def stopping_at_cap(self, own=False):
        self.box('cold', 'stopped', member=True)
        if own:
            self.con.execute("UPDATE leases SET owner=?, repo_root=? WHERE box_id='cold'",
                             (self.me['owner'], self.me['repo_root']))
            self.con.commit()
        self.box('busy', 'running', member=True)
        self.busy('busy')
        clock = FakeClock()
        boats = FakeBoats({'cold': ['stopping'], 'busy': ['idle']})
        err = io.StringIO()

        def free_peer(seconds):
            clock.sleep(seconds)
            self.con.execute("UPDATE runs SET status='done' WHERE box_id='busy'")
            self.con.commit()

        clock.time.sleep = free_peer
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '10'}), \
                patch.object(pool, 'time', clock.time), patch.object(pool, '_refresh_background'), \
                patch.object(api, 'get', side_effect=boats.get), patch.object(api, 'resume') as resume, \
                patch.object(api, 'wait_state', side_effect=AssertionError('must queue, not wait inline')), \
                patch.object(lease, 'acquire_private') as create, contextlib.redirect_stderr(err):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'busy')
            self.assertGreater(clock.t, 1000)
            self.assertIn('queued for a repo pool box', err.getvalue())
            self.assertEqual(err.getvalue().count('cold is stopping; skipping it for now'), 1)
            self.assertEqual(self.row('cold')['state'], 'stopped')
            resume.assert_not_called()
            create.assert_not_called()
        finally:
            pool.release_guard(got)

    def test_stopping_under_cap_is_skipped_and_a_fresh_box_created(self):
        self.box('cold', 'stopped', member=True)
        new = {'box_id': 'new', 'state': 'running', 'size': 'large', 'source': 'fresh'}
        with patch.object(api, 'get', return_value={'state': 'stopping', 'type': 'large'}), \
                patch.object(api, 'resume') as resume, \
                patch.object(api, 'wait_state', side_effect=AssertionError('must not wait inline')), \
                patch.object(lease, 'acquire_private', return_value=new) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'new')
            create.assert_called_once()
            resume.assert_not_called()
            self.assertEqual(self.row('cold')['state'], 'stopped')
        finally:
            pool.release_guard(got)

    def test_real_resume_500_at_cap_keeps_its_error(self):
        self.box('cold', 'stopped', member=True)
        error = api.ApiError(500, 'resume_failed', 'provider failure')
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), \
                patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(api, 'resume', side_effect=error) as resume, \
                patch.object(lease, 'acquire_private') as create, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(api.ApiError) as caught:
                pool.acquire(self.me)
        self.assertIs(caught.exception, error)
        self.assertEqual(caught.exception.code, common.EXIT_INFRA)
        resume.assert_called_once()
        create.assert_not_called()

    def test_unknown_state_at_cap_is_still_an_infrastructure_error(self):
        self.box('cold', 'stopped', member=True)
        with patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), \
                patch.object(api, 'get', return_value={'state': 'unknown', 'type': 'large'}), \
                patch.object(api, 'resume') as resume, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(common.OffboxError, 'unexpected state unknown') as caught:
                pool.acquire(self.me)
        self.assertEqual(caught.exception.code, common.EXIT_INFRA)
        resume.assert_not_called()

    def test_resume_stuck_still_skips_to_the_next_stopped_member(self):
        self.box('stuck', 'stopped', used=200, member=True)
        self.box('cold', 'stopped', used=100, member=True)
        clock = FakeClock()
        boats = FakeBoats({'stuck': ['archived'], 'cold': ['archived']})

        def bring_up(box_id, *, on_state=None, **kwargs):
            if box_id == 'stuck':
                for _ in range(3):
                    on_state({'state': 'archived'})
                    clock.sleep(lease.RESUME_STUCK_S)
            return {'type': 'large'}

        with patch.object(lease, 'now', side_effect=lambda: clock.t), \
                patch.object(api, 'get', side_effect=boats.get), \
                patch.object(api, 'resume', return_value={}) as resume, \
                patch.object(lease, '_bring_up', side_effect=bring_up), \
                patch.object(lease, 'acquire_private') as create, \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'cold')
            self.assertEqual([call.args[0] for call in resume.call_args_list], ['stuck', 'stuck', 'cold'])
            self.assertEqual(self.row('stuck')['state'], 'stopped')
            self.assertEqual(self.con.execute(
                "SELECT COUNT(*) FROM events WHERE box_id='stuck' AND kind='resume_stuck'").fetchone()[0], 1)
            create.assert_not_called()
        finally:
            pool.release_guard(got)

    def test_direct_stopping_has_retry_message_and_keeps_infrastructure_exit(self):
        self.box('cold', 'stopped')
        self.con.execute("UPDATE leases SET owner=?, repo_root=? WHERE box_id='cold'",
                         (self.me['owner'], self.me['repo_root']))
        self.con.commit()
        with patch.object(lease, 'db', return_value=self.con), \
                patch.object(api, 'get', return_value={'state': 'stopping', 'type': 'large'}), \
                patch.object(api, 'resume') as resume, \
                patch.object(api, 'wait_state', side_effect=AssertionError('must not wait inline')):
            with self.assertRaisesRegex(lease.ArchivingSkip, 'cold is stopping; retry in a moment') as caught:
                lease.acquire_private(self.me)
        self.assertEqual(caught.exception.code, common.EXIT_INFRA)
        resume.assert_not_called()

    def test_archiving_first_candidate_is_skipped_and_next_free_box_used_without_waiting(self):
        # 'arch' is the most recently used running member, so it sorts first and is picked first.
        self.box('arch', 'running', used=200, member=True)
        self.box('free', 'running', used=100, member=True)
        boats = FakeBoats({'arch': ['archiving'], 'free': ['idle']})
        err = io.StringIO()
        with patch.object(api, 'get', side_effect=boats.get), \
                patch.object(api, 'wait_state', side_effect=AssertionError('pool must not wait on archiving')), \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('free box exists; no create')), \
                contextlib.redirect_stderr(err):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'free')
            self.assertIn('skipping pool box arch', err.getvalue())
            self.assertEqual(boats.calls, ['arch', 'free'])
        finally:
            pool.release_guard(got)

    def test_all_members_archiving_under_cap_creates_a_box_as_before(self):
        # One member, cap 2: the archiving box is skipped and the pool still has room to create.
        self.box('arch', 'running', used=200, member=True)
        boats = FakeBoats({'arch': ['archiving']})
        new = {'box_id': 'bx_new', 'state': 'running', 'size': 'large', 'source': 'fresh'}
        with patch.object(api, 'get', side_effect=boats.get), \
                patch.object(api, 'wait_state', side_effect=AssertionError('pool must not wait on archiving')), \
                patch.object(lease, 'acquire_private', return_value=dict(new)) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me)
        try:
            create.assert_called_once()
            self.assertEqual(got['box_id'], 'bx_new')
        finally:
            pool.release_guard(got)

    def test_archiving_to_idle_is_usable_and_does_not_hang(self):
        # Direct (non-pool) caller: the wait accepts a live state, so archiving -> idle resumes at once.
        self.box('arch', 'running', used=200)
        boats = FakeBoats({'arch': ['archiving', 'archiving', 'idle']})
        t0 = time.monotonic()
        with patch.object(api, 'get', side_effect=boats.get), patch.object(api.time, 'sleep') as sleep, \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con, self.row('arch'), None)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual(got['box_id'], 'arch')
        self.assertEqual(got['state'], 'running')
        self.assertLessEqual(sleep.call_count, 2)

    def test_pool_path_never_waits_while_holding_the_lock(self):
        # Pool callers skip archiving boxes outright: no wait of any length under the pool lock.
        self.box('arch', 'running', used=200, member=True)
        boats = FakeBoats({'arch': ['archiving']})
        with self.assertRaises(lease.ArchivingSkip):
            with patch.object(api, 'get', side_effect=boats.get), \
                    patch.object(api, 'wait_state', side_effect=AssertionError('no wait on pool path')):
                lease._reuse(self.con, self.row('arch'), None, skip_archiving=True)

    def test_direct_wait_is_bounded_when_box_never_settles(self):
        self.box('arch', 'running', used=200)
        boats = FakeBoats({'arch': ['archiving']})
        seen = {}

        def fake_wait(box_id, want, timeout=600, poll=0.7):
            seen['timeout'], seen['want'] = timeout, want
            raise api.OffboxError(f'box {box_id} stuck in archiving after {int(timeout)}s')

        with patch.object(api, 'get', side_effect=boats.get), patch.object(api, 'wait_state', side_effect=fake_wait), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(api.OffboxError):
                lease._reuse(self.con, self.row('arch'), None)
        self.assertLessEqual(seen['timeout'], 120)
        self.assertIn('archived', seen['want'])
        self.assertIn('idle', seen['want'])


    def test_archiving_stopped_member_does_not_use_up_the_stopped_try(self):
        # Review round 1: two stopped members, the first still archiving, the second archived and healthy.
        self.box('arch', 'stopped', used=200, member=True)
        self.box('cold', 'stopped', used=100, member=True)
        boats = FakeBoats({'arch': ['archiving'], 'cold': ['archived']})
        with patch.object(api, 'get', side_effect=boats.get), \
                patch.object(api, 'wait_state', side_effect=AssertionError('pool must not wait on archiving')), \
                patch.object(api, 'resume', return_value={}) as resume, \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('pool is full; no create')), \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me)
        try:
            self.assertEqual(got['box_id'], 'cold')
            self.assertEqual(resume.call_args.args[0], 'cold')
        finally:
            pool.release_guard(got)

    def test_pool_resize_starts_the_stop_and_moves_on_without_waiting(self):
        # Review round 1: a live large box picked for --size xlarge must not wait for its stop under the pool lock.
        self.box('big', 'running', used=200, member=True)
        self.box('cold', 'stopped', used=100, member=True)
        boats = FakeBoats({'big': ['idle'], 'cold': ['archived']})
        with patch.object(api, 'get', side_effect=boats.get), \
                patch.object(api, 'wait_state', side_effect=AssertionError('no wait under the pool lock')), \
                patch.object(api, 'stop', return_value={}) as stop, \
                patch.object(api, 'resume', return_value={}) as resume, \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('pool is full; no create')), \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me, size='xlarge')
        try:
            stop.assert_called_once_with('big')
            self.assertEqual(got['box_id'], 'cold')
            self.assertEqual(resume.call_args.args[2], 'xlarge')
            self.assertEqual(self.row('big')['state'], 'stopped')  # a later pass resumes it once archived
        finally:
            pool.release_guard(got)

    def test_direct_archiving_to_idle_still_grows_to_the_requested_size(self):
        # Review round 1: archiving -> idle on a large box with --size xlarge stops and resumes it at xlarge.
        self.box('arch', 'running', used=200)
        boats = FakeBoats({'arch': ['archiving', 'archiving', 'idle', 'archived']})
        with patch.object(api, 'get', side_effect=boats.get), patch.object(api.time, 'sleep'), \
                patch.object(api, 'stop', return_value={}) as stop, \
                patch.object(api, 'resume', return_value={}) as resume, \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con, self.row('arch'), 'xlarge')
        stop.assert_called_once_with('arch')
        self.assertEqual(resume.call_args.args[2], 'xlarge')
        self.assertEqual(got['size'], 'xlarge')

    def direct_resize_with_stuck_stop(self, after_stop):
        """archiving -> idle on a large box with --size xlarge, then the resize stop never reaches archived."""
        self.box('arch', 'running', used=200)
        boats = FakeBoats({'arch': ['archiving', after_stop]})
        timeouts = []

        def fake_wait(box_id, want, timeout=600, poll=0.7):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                return {'id': box_id, 'state': 'idle', 'type': 'large'}
            raise api.OffboxError(f'box {box_id} stuck in {after_stop} after {int(timeout)}s')

        with patch.object(api, 'get', side_effect=boats.get), patch.object(api, 'wait_state', side_effect=fake_wait), \
                patch.object(api, 'stop', return_value={}) as stop, \
                patch.object(api, 'resume', side_effect=AssertionError('no resume of an unstopped box')), \
                patch.object(lease, '_bring_up', side_effect=AssertionError('no undersized box')), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(api.OffboxError) as raised:
                lease._reuse(self.con, self.row('arch'), 'xlarge')
        stop.assert_called_once_with('arch')
        self.assertEqual(len(timeouts), 2)
        self.assertTrue(all(t <= lease.ARCHIVING_WAIT_S for t in timeouts), timeouts)
        return raised.exception

    def test_direct_resize_stop_that_bounces_back_to_idle_is_bounded_and_refused(self):
        # Review round 2: the second stop transition is bounded too, and an idle large box isn't handed out.
        err = self.direct_resize_with_stuck_stop('idle')
        self.assertIn('instead of stopping to grow to xlarge', str(err))
        self.assertEqual(self.row('arch')['state'], 'running')
        self.assertEqual(self.row('arch')['size'], 'large')

    def test_direct_resize_stop_stuck_in_archiving_is_bounded_and_left_stopping(self):
        err = self.direct_resize_with_stuck_stop('archiving')
        self.assertIn('stuck in archiving', str(err))
        self.assertEqual(self.row('arch')['state'], 'stopped')  # the next caller resumes it once archived


if __name__ == '__main__':
    unittest.main()
