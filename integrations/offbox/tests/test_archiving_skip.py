"""A box stuck in 'archiving' must not stall its repository pool (card #95, 28 Oct).

Fake api only: no boat calls. The pool lock is held by pool._acquire while it runs lease._reuse, so an
archiving member must be skipped without any wait there.
"""
import contextlib
import io
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / 'tests'))
from offbox_lib import api, lease, pool  # noqa: E402
from test_capacity import Isolated  # noqa: E402


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


if __name__ == '__main__':
    unittest.main()
