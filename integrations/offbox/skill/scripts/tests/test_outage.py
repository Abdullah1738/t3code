"""Offline tests: boat.dev API outages (Cloudflare 52x) wait before a start, keep runs attached, and stay quiet on
a closed pipe. No boat calls: urlopen, the Keychain key and api's retry sleeps are patched in every test."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, capacity, cli, common, fallback, home, lease, misc, outage, pool, runs  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402
import toollog  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_exit_and_queue import FakeClock  # noqa: E402


def http_error(code):
    return urllib.error.HTTPError("https://boat.dev/api/v1/x", code, "x", {}, io.BytesIO(b""))


def cf(code):
    """A urlopen side effect that answers every call with a fresh HTTP error."""
    def fn(*a, **k):
        raise http_error(code)
    return fn


class OutageBase(Isolated):
    def setUp(self):
        super().setUp()
        self.urlopen = self.stack.enter_context(patch("urllib.request.urlopen", side_effect=OSError("offline")))
        self.stack.enter_context(patch.object(api, "_key", return_value="k"))
        self.stack.enter_context(patch.object(api.time, "sleep"))
        self.clock = FakeClock()
        self.stack.enter_context(patch.object(outage, "time", self.clock.time))
        self.stack.enter_context(patch.object(outage, "now", lambda: self.clock.t))
        self.stack.enter_context(patch.object(common, "now", lambda: self.clock.t))
        self.stack.enter_context(patch.object(api, "_DEADLINE", None))


class ApiOutageTests(OutageBase):
    def test_cloudflare_525_is_an_outage_error(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError) as cm:
            api.get("bx")
        e = cm.exception
        self.assertTrue(e.outage)
        self.assertIn("Cloudflare could not reach boat.dev", str(e))

    def test_plain_500_is_not_an_outage(self):
        self.urlopen.side_effect = cf(500)
        with self.assertRaises(api.ApiError) as cm:
            api.get("bx")
        self.assertFalse(cm.exception.outage)

    def test_network_error_is_an_outage(self):
        with self.assertRaises(OffboxError) as cm:
            api.get("bx")
        self.assertTrue(cm.exception.outage)

    def test_start_post_is_not_resent_on_not_delivered_cloudflare(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.cmd_start("bx", "true")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_resume_is_sent_once_on_525(self):
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.resume("bx", 1200)
        self.assertEqual(self.urlopen.call_count, 1)

    def test_create_and_fork_are_sent_once_on_not_delivered_cloudflare(self):
        # create/fork carry an Idempotency-Key, which the generic 5xx retry would otherwise resend five times.
        for code in api.CF_NOT_DELIVERED:
            for start in (lambda: api.create("large", 1200, "n", "idem-1"),
                          lambda: api.fork("bx", 1200, "idem-2")):
                self.urlopen.reset_mock()
                self.urlopen.side_effect = cf(code)
                with self.assertRaises(api.ApiError):
                    start()
                self.assertEqual(self.urlopen.call_count, 1, f"HTTP {code} resent a start")

    def test_create_500_still_retries_on_its_idempotency_key(self):
        # Not a Cloudflare not-delivered answer: the existing idempotent retry stays.
        self.urlopen.side_effect = cf(500)
        with self.assertRaises(api.ApiError):
            api.create("large", 1200, "n", "idem-3")
        self.assertGreater(self.urlopen.call_count, 1)

    def test_probe_525_is_one_send(self):
        self.urlopen.side_effect = cf(525)
        self.assertEqual(api.probe(), "HTTP 525")
        self.assertEqual(self.urlopen.call_count, 1)

    def test_probe_500_means_boat_answered(self):
        self.urlopen.side_effect = cf(500)
        self.assertIsNone(api.probe())

    def test_probe_network_error_is_no_answer(self):
        self.assertEqual(api.probe(), "no answer")


class StartRefusalTests(OutageBase):
    def start_with(self, err):
        rn = runs.Runner(cli.build_parser().parse_args(["run", "--", "go", "test", "./..."]), self.me)
        rn.a.steps = []
        row = {"box_id": "bx", "remote_dir": "w/r", "size": "large"}
        with patch.object(runs.pool, "acquire", return_value=row), patch.object(runs, '_ttl_keeper'), \
                patch.object(runs.ssh_sync, "put_file"), patch.object(runs.ssh_sync, "push", return_value={}), \
                patch.object(runs.ssh_sync, "tracked_secret_matches", return_value=[]), \
                patch.object(runs.ssh_sync, "probe_home", return_value=(None, None)), \
                patch.object(api, "cmd_start", side_effect=err), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                rn.start()
        return rn, cm.exception

    def test_cloudflare_521_to_526_is_not_started(self):
        rn, _ = self.start_with(api.ApiError(525, "http_525", ""))
        self.assertFalse(rn.started)

    def test_524_and_520_stay_started(self):
        rn, _ = self.start_with(api.ApiError(524, "http_524", ""))
        self.assertTrue(rn.started)
        rn, _ = self.start_with(api.ApiError(520, "http_520", ""))
        self.assertTrue(rn.started)


class OutageStateTests(OutageBase):
    def test_wait_until_up_returns_true_when_boat_answers(self):
        with patch.object(outage.api, "probe", side_effect=["HTTP 525", None]), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertTrue(outage.wait_until_up("HTTP 525", 600))
        self.assertIn("boat.dev is back", err.getvalue())

    def test_wait_until_up_gives_up_after_budget(self):
        probe = patch.object(outage.api, "probe", return_value="HTTP 525")
        with probe as p, contextlib.redirect_stderr(io.StringIO()):
            start = self.clock.t
            self.assertFalse(outage.wait_until_up("HTTP 525", 60))
        self.assertEqual(p.call_count, 3)
        self.assertLessEqual(self.clock.t - start, 60)

    def test_zero_budget_does_not_probe(self):
        with patch.object(outage.api, "probe") as p, contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(outage.wait_until_up("HTTP 525", 0))
        p.assert_not_called()

    def test_note_down_keeps_first_since_and_note_up_clears(self):
        first = outage.note_down("HTTP 525")
        self.clock.t += 60
        second = outage.note_down("HTTP 525")
        self.assertEqual(first, second)
        self.assertIsNotNone(outage.current())
        with contextlib.redirect_stderr(io.StringIO()):
            outage.note_up()
        self.assertIsNone(outage.current())


class CmdRunOutageTests(OutageBase):
    def run_cli(self, argv, side_effect, wait=None, fallback_rc=0):
        a = cli.build_parser().parse_args(["run", "--"] + argv)
        err = io.StringIO()
        with patch.object(runs, "run_remote", side_effect=side_effect) as rr, \
                patch.object(outage, "wait_until_up", return_value=wait) as w, \
                patch.object(fallback, "run_local", return_value=fallback_rc) as loc, \
                patch.object(fallback, "note_infra_failure"), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, rr, w, loc, err.getvalue()

    def test_outage_then_recovery_runs_again(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"],
                                       [OffboxError("down", outage=True), 0], wait=True)
        self.assertEqual(rc, 0)
        self.assertEqual(rr.call_count, 2)

    def test_outage_past_the_window_fails_with_boat_down(self):
        rc, rr, w, _, err = self.run_cli(["make", "test"], OffboxError("down", outage=True), wait=False)
        self.assertEqual(rc, 90)
        self.assertIn("boat.dev is down", err)

    def test_outage_after_start_does_not_wait(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"], OffboxError("down", outage=True, started=True), wait=True)
        self.assertEqual(rc, 90)
        w.assert_not_called()

    def test_plain_error_does_not_wait(self):
        rc, rr, w, _, _ = self.run_cli(["make", "test"], OffboxError("boom"), wait=True)
        self.assertEqual(rc, 90)
        w.assert_not_called()

    def test_small_command_falls_back_without_waiting(self):
        rc, rr, w, loc, _ = self.run_cli(["echo", "ok"], OffboxError("down", outage=True), wait=True)
        w.assert_not_called()
        loc.assert_called_once()


class QueuedOutageTests(OutageBase):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(pool, 'time', self.clock.time))
        self.stack.enter_context(patch.object(cli, 'time', self.clock.time))
        self.stack.enter_context(patch.object(pool, 'now', lambda: self.clock.t))
        self.stack.enter_context(patch.object(pool, 'at_home', return_value=True))
        self.stack.enter_context(patch.object(home, 'active', return_value=True))
        self.stack.enter_context(patch.object(home, 'base_needs_home', return_value=True))
        self.stack.enter_context(patch.object(home, 'before_run'))
        self.stack.enter_context(patch.object(home, 'may_fail_over', return_value=False))
        self.stack.enter_context(patch.object(common, 'person', return_value=None))
        self.stack.enter_context(patch.object(home, 'wait_seconds', return_value=600))
        self.stack.enter_context(patch.object(lease, 'cap_check'))
        self.real_refresh = pool._refresh_background
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS='86400'))
        for bid in ('one', 'two'):
            self.box(bid, member=True, source='base:repo:seed')
            self.busy(bid)
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.real_emit = toollog.emit
        self.events = self.stack.enter_context(patch('toollog.emit'))
        self.args = cli.build_parser().parse_args(['run', '--base', 'repo:seed', '--remote', '--', 'make', 'test'])

    def run_queued(self, *, timeout=False, pre_queue=False, blips=1, queue_wait=86400,
                   free_on_recovery=False, startup_blip=False, registration_delay=0, stay_down=False,
                   lock_delay=0, startup_down=False, deadline_error=None, selection_delay=0, resume_startup=False,
                   lock_wait_until=0, capacity_after_recovery=False, quick_capacity_retry=False,
                   healthy_probe_seconds=0, release_after=900, busy_background_locks=False):
        start = self.clock.t
        snapshots = []
        recovered = False
        siblings = False
        failed = 0
        real_acquire = pool._acquire
        real_schema = capacity.schema
        delayed = False
        real_lock = pool.file_lock
        lock_delayed = False
        real_candidates = pool.candidates
        selection_delayed = False

        def candidates(*args, **kwargs):
            nonlocal selection_delayed
            if recovered and not selection_delayed:
                selection_delayed = True
                self.clock.sleep(selection_delay)
            return real_candidates(*args, **kwargs)

        def reuse(con, row, *args, **kwargs):
            if resume_startup:
                why = home.wait_while_starting('starting incus', 'run-A', box=row['box_id'],
                    read=lambda *a: {'ok': False, 'starting': True},
                    clock=lambda: self.clock.t, sleep=self.clock.sleep)
                if why:
                    raise home.StartWaitFailed(why, 'run-A', row['box_id'])
            return dict(row)

        @contextlib.contextmanager
        def lock(name, **kwargs):
            nonlocal lock_delayed
            if busy_background_locks and name.startswith('box-') and self.con.execute(
                    "SELECT 1 FROM runs WHERE box_id=? AND mode='bg' AND status='running'", (name[4:],)).fetchone():
                raise OffboxError('background run holds its box lock')
            if recovered and name == pool.lock_name('repo') and self.clock.t < start + lock_wait_until:
                self.clock.sleep(min(kwargs.get('timeout', 600), start + lock_wait_until - self.clock.t))
                if self.clock.t < start + lock_wait_until:
                    raise OffboxError('pool lock busy')
            with real_lock(name, **kwargs):
                if recovered and not lock_delayed and name == pool.lock_name('repo'):
                    lock_delayed = True
                    self.clock.sleep(lock_delay)
                yield

        def probe(*args, **kwargs):
            if startup_down:
                why = home.wait_while_starting('starting incus', 'run-A',
                    read=lambda *a: {'ok': False, 'starting': True},
                    clock=lambda: self.clock.t, sleep=self.clock.sleep)
                if why:
                    raise home.StartWaitFailed(why, 'run-A')
            return 'no answer'

        def schema(con, **kwargs):
            nonlocal delayed
            if recovered and not delayed:
                delayed = True
                self.clock.sleep(registration_delay)
            return real_schema(con, **kwargs)

        def acquire(con, *args, **kwargs):
            queue = allocation._QUEUE.get()
            row = dict(con.execute("SELECT * FROM pool_waiters WHERE run_id='run-A'").fetchone())
            self.assertEqual(con.execute("SELECT count(*) FROM pool_waiters WHERE run_id='run-A'").fetchone()[0], 1)
            self.assertEqual(con.execute("SELECT count(*) FROM pool_cap_callers WHERE run_id='run-A'").fetchone()[0], 1)
            state = pool.queue_state(con, 'repo', 'run-A', token=row['token'], source='base:repo:seed')
            snapshots.append((row, dict(queue), state, outage.allocation_left()))
            if recovered and capacity_after_recovery:
                raise api.BoatAtCapacity()
            return real_acquire(con, *args, **kwargs)

        def preflight():
            nonlocal failed
            if startup_blip and failed == 1 and self.clock.t >= start + 700:
                failed += 1
                why = home.wait_while_starting('starting incus', 'run-A', read=lambda *a: {'ok': True},
                                               clock=lambda: self.clock.t, sleep=self.clock.sleep)
                if why:
                    raise home.StartWaitFailed(why, 'run-A')
            if failed < blips and (failed == 0 or self.clock.t >= start + 700):
                failed += 1
                raise OffboxError('home offbox server not reachable (no answer)', outage=True, run_id='run-A')
            if recovered:
                self.clock.sleep(healthy_probe_seconds)

        def sleep(seconds):
            nonlocal siblings
            self.clock.sleep(seconds)
            if not siblings:
                siblings = True
                for index, name in enumerate(('B', 'C'), 1):
                    self.con.execute("INSERT INTO pool_waiters(pool_key,token,pid,run_id,queued_at,source) "
                                     "VALUES ('repo',?,?,?,?,'base:repo:seed')",
                                     (name, os.getpid(), 'run-'+name, self.clock.t + index))
                self.con.commit()
            if recovered:
                if timeout:
                    self.clock.t = start + queue_wait
                    if deadline_error is not None:
                        raise deadline_error
                elif self.clock.t >= start + release_after:
                    self.con.execute("DELETE FROM runs WHERE run_id='run-one'")
                    self.con.commit()

        def recover(*args, **kwargs):
            nonlocal recovered
            self.assertEqual(self.con.execute("SELECT count(*) FROM pool_waiters WHERE run_id='run-A'").fetchone()[0], 0)
            self.clock.sleep(15)
            if free_on_recovery:
                self.con.execute("DELETE FROM runs WHERE run_id='run-one'")
                self.con.commit()
            recovered = True
            return True

        attempts = 0
        def remote(*args):
            nonlocal attempts
            attempts += 1
            if pre_queue and attempts == 1:
                preflight()
            row = pool.acquire(self.me, base='repo:seed', run_id='run-A')
            pool.release_guard(row)
            return 0

        with contextlib.ExitStack() as stack:
            if quick_capacity_retry:
                def capacity_retry(*args):
                    self.clock.sleep(3)
                    return True, None
                stack.enter_context(patch.object(outage, 'wait_for_capacity', side_effect=capacity_retry))
            stack.enter_context(patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS=str(queue_wait)))
            stack.enter_context(patch.object(capacity, 'schema', side_effect=schema))
            stack.enter_context(patch.object(pool, 'file_lock', side_effect=lock))
            stack.enter_context(patch.object(pool, 'candidates', side_effect=candidates))
            stack.enter_context(patch.object(pool, '_acquire', side_effect=acquire))
            stack.enter_context(patch.object(home, 'preflight_reason', side_effect=None if pre_queue else preflight,
                                            return_value=None))
            stack.enter_context(patch.object(self.clock.time, 'sleep', side_effect=sleep))
            if not stay_down:
                stack.enter_context(patch.object(outage, 'wait_until_up', side_effect=recover))
            stack.enter_context(patch.object(api, 'probe', side_effect=probe))
            stack.enter_context(patch.object(runs, 'run_remote', side_effect=remote))
            stack.enter_context(patch.object(pool, '_reuse_prepared', side_effect=reuse))
            code = cli.cmd_run(self.args, self.me)
        return code, snapshots, start

    def test_api_blip_restores_fifo_timestamp_token_and_deadline(self):
        code, snapshots, start = self.run_queued()
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(len(snapshots), 2)
        first, resumed = snapshots
        self.assertEqual(resumed[0]['queued_at'], first[0]['queued_at'])
        self.assertEqual(resumed[0]['token'], first[0]['token'])
        self.assertEqual((resumed[2]['place'], resumed[2]['waiting']), (1, 3))
        self.assertEqual((resumed[1]['end'], resumed[1]['wait']), (start + 86400, 86400))
        self.assertGreater(resumed[3], 0)
        self.assertLessEqual(resumed[3], 585)
        progress = [line for line in self.err.getvalue().splitlines() if 'still queued' in line]
        self.assertTrue(any('of 24h00m' in line and '#1 of 3' in line for line in progress))
        self.assertFalse(any('of 585s' in line for line in progress))
        events = [c for c in self.events.call_args_list if c.args[:2] == ('pool', 'run.queue_resumed')]
        self.assertEqual(len(events), 1)
        props = events[0].kwargs['props']
        self.assertEqual((props['placeBefore'], props['placeAfter'], props['deadlineKept']), (1, 1, True))
        self.assertEqual(props['outageS'], 15)
        self.assertEqual(props['waitedMs'], 31000)
        self.assertEqual(self.con.execute("SELECT count(*) FROM pool_waiters WHERE run_id='run-A'").fetchone()[0], 0)

    def test_second_blip_after_long_healthy_queue_keeps_the_same_place_and_deadline(self):
        code, snapshots, start = self.run_queued(blips=2)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(len(snapshots), 3)
        first = snapshots[0]
        for row, queue, state, left in snapshots[1:]:
            self.assertEqual((row['token'], row['queued_at']), (first[0]['token'], first[0]['queued_at']))
            self.assertEqual((state['place'], state['waiting']), (1, 3))
            self.assertEqual(queue['end'], start + 86400)
            self.assertGreater(left, 0)
        self.assertEqual(sum(c.args[:2] == ('pool', 'run.queue_resumed') for c in self.events.call_args_list), 2)

    def test_real_queue_deadline_after_recovery_exits_92(self):
        code, snapshots, start = self.run_queued(timeout=True)
        self.assertEqual(code, 92)
        self.assertEqual(self.clock.t, start + 86400)
        self.assertEqual(snapshots[-1][1]['end'], start + 86400)
        self.assertIn('queue timed out', self.err.getvalue())
        self.assertNotIn('server is down', self.err.getvalue())

    def test_queue_expiring_during_outage_cannot_take_a_newly_free_box(self):
        code, snapshots, start = self.run_queued(queue_wait=20, free_on_recovery=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 31)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(self.con.execute("SELECT count(*) FROM pool_waiters WHERE run_id='run-A'").fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT count(*) FROM pool_cap_callers WHERE run_id='run-A'").fetchone()[0], 0)

    def test_startup_after_long_healthy_queue_uses_unspent_home_budget(self):
        code, snapshots, start = self.run_queued(startup_blip=True)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(snapshots[-1][1]['end'], start + 86400)
        self.assertIn('home offbox server is starting', self.err.getvalue())

    def test_queue_expiring_during_registration_cannot_select_a_box(self):
        code, snapshots, start = self.run_queued(queue_wait=40, free_on_recovery=True, registration_delay=10)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 41)

    def test_queue_deadline_bounds_the_real_outage_recovery_wait(self):
        code, snapshots, start = self.run_queued(queue_wait=20, stay_down=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 20)

    def test_queue_expiring_while_taking_pool_lock_cannot_select_a_box(self):
        code, snapshots, start = self.run_queued(queue_wait=40, free_on_recovery=True, lock_delay=9)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 40)

    def test_startup_in_recovery_probe_cannot_extend_the_queue_deadline(self):
        code, snapshots, start = self.run_queued(queue_wait=40, stay_down=True, startup_down=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 40)

    def test_local_failure_at_queue_deadline_keeps_its_exit_code(self):
        code, snapshots, start = self.run_queued(timeout=True,
            deadline_error=OffboxError('local state unavailable', code=common.EXIT_LOCAL))
        self.assertEqual(code, common.EXIT_LOCAL, self.err.getvalue())

    def test_slow_candidate_selection_cannot_reserve_after_queue_deadline(self):
        code, snapshots, start = self.run_queued(queue_wait=40, free_on_recovery=True, selection_delay=10)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 41)

    def test_startup_refusal_of_identified_box_before_acceptance_keeps_queue_deadline(self):
        code, snapshots, start = self.run_queued(queue_wait=40, free_on_recovery=True, resume_startup=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 40)

    def test_accepted_machine_startup_keeps_its_own_budget_past_queue_end(self):
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS='40'), allocation.queue():
            self.clock.sleep(39)
            with outage.accepted_machine():
                why = home.wait_while_starting('starting incus', 'run-A', box='one',
                    read=lambda *a: {'ok': True}, clock=lambda: self.clock.t, sleep=self.clock.sleep)
        self.assertIsNone(why)
        self.assertEqual(self.clock.t, 1044)

    def test_healthy_pool_lock_wait_does_not_spend_api_recovery_budget(self):
        code, snapshots, start = self.run_queued(free_on_recovery=True, lock_wait_until=900)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 900)

    def test_post_create_rename_retains_machine_acceptance(self):
        def bring_up(*args, **kwargs):
            with outage.accepted_machine():
                self.clock.sleep(6)
        def rename(*args):
            why = home.wait_while_starting('starting incus', 'run-A', box='new',
                read=lambda *a: {'ok': True}, clock=lambda: self.clock.t, sleep=self.clock.sleep)
            if why:
                raise home.StartWaitFailed(why, 'run-A', 'new')
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS='5'), allocation.queue(), \
                patch.object(lease, '_bring_up', side_effect=bring_up), patch.object(api, 'rename', side_effect=rename):
            row = lease._create_row(self.con, self.me, 'new', 'base:repo:seed', None, 'large', 1000)
        self.assertEqual(row['box_id'], 'new')
        self.assertEqual(self.clock.t, 1011)

    def test_prepared_box_claim_retains_machine_acceptance(self):
        def check_home(**kwargs):
            why = home.wait_while_starting('starting incus', 'run-A',
                read=lambda *a: {'ok': True}, clock=lambda: self.clock.t, sleep=self.clock.sleep)
            if why:
                raise home.StartWaitFailed(why, 'run-A')
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS='5'), allocation.queue() as queue, \
                patch.object(pool.prepare, 'guard', return_value=contextlib.nullcontext()), \
                patch.object(pool.prepare, 'phase', return_value=contextlib.nullcontext()):
            self.clock.sleep(6)
            with pool._pool_lock('repo', queue['end'], queue['wait'], prepare_end=1100, check_home=check_home):
                self.assertTrue(outage.machine_accepted())
        self.assertEqual(self.clock.t, 1011)

    def test_accepted_setup_failure_keeps_its_infrastructure_error(self):
        def bring_up(*args, **kwargs):
            self.clock.sleep(6)
        def rename(*args):
            why = home.wait_while_starting('starting incus', 'run-A', box='new',
                read=lambda *a: {'ok': False, 'starting': True},
                clock=lambda: self.clock.t, sleep=self.clock.sleep)
            if why:
                raise home.StartWaitFailed(why, 'run-A', 'new')
        def remote(*args):
            return pool.acquire(self.me, base='repo:seed', run_id='run-A')
        def acquire(*args, **kwargs):
            return lease._create_row(self.con, self.me, 'new', 'base:repo:seed', None, 'large', 1000)
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS='5'), \
                patch.object(lease, '_bring_up', side_effect=bring_up), patch.object(api, 'rename', side_effect=rename), \
                patch.object(pool, '_acquire', side_effect=acquire), \
                patch.object(runs, 'run_remote', side_effect=remote):
            code = cli.cmd_run(self.args, self.me)
        self.assertEqual(code, common.EXIT_HOME_DOWN, self.err.getvalue())
        self.assertEqual(self.clock.t, 1606)

    def test_affinity_wait_does_not_spend_api_recovery_budget(self):
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'], self.me['repo_root'], 'one', 'w/own'))
        self.con.commit()
        with patch.dict(os.environ, OFFBOX_OUTAGE_WAIT_SECONDS='25'):
            code, snapshots, start = self.run_queued()
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(snapshots[-1][1]['end'], start + 86400)

    def test_capacity_retry_sleep_cannot_extend_the_retained_queue_deadline(self):
        code, snapshots, start = self.run_queued(queue_wait=40, capacity_after_recovery=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 40)

    def test_capacity_round_spacing_cannot_extend_the_retained_queue_deadline(self):
        code, snapshots, start = self.run_queued(queue_wait=40, capacity_after_recovery=True, quick_capacity_retry=True)
        self.assertEqual(code, 92, self.err.getvalue())
        self.assertEqual(self.clock.t, start + 40)

    def test_resume_event_fields_survive_persistence(self):
        logdir = Path(self.tmp.name) / 'tool-logs'
        with patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(logdir)), patch('toollog.emit', wraps=self.real_emit):
            code, snapshots, start = self.run_queued()
        self.assertEqual(code, 0, self.err.getvalue())
        records = [json.loads(line) for path in logdir.glob('*.ndjson') for line in path.read_text().splitlines()]
        resumed = [row for row in records if row['name'] == 'run.queue_resumed']
        self.assertEqual(len(resumed), 1)
        self.assertEqual(resumed[0]['ids'], {'run': 'run-A'})
        self.assertEqual(resumed[0]['props'], dict(outageS=15, waitedMs=31000, placeBefore=1, placeAfter=1,
                                                 deadlineKept=True))

    def test_healthy_probe_latency_does_not_accumulate_into_queue_timeout(self):
        code, snapshots, start = self.run_queued(healthy_probe_seconds=6, release_after=4000)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertGreaterEqual(self.clock.t, start + 4000)
        self.assertEqual(snapshots[-1][1]['end'], start + 86400)

    def test_failed_background_status_polls_keep_the_recovery_budget_bounded(self):
        self.con.execute("UPDATE runs SET mode='bg',process_id=1,command_id='fixture'")
        self.con.commit()
        self.clock.time.time = lambda: self.clock.t
        def timeout(*args, **kwargs):
            self.clock.sleep(min(6, kwargs['timeout']))
            raise TimeoutError('status poll timed out')
        with patch.object(pool, '_refresh_background', self.real_refresh), \
                patch.object(runs, 'reconcile_lost'), patch.object(api, 'time', self.clock.time), \
                patch.object(api, '_open', side_effect=timeout), \
                patch.dict(os.environ, OFFBOX_OUTAGE_WAIT_SECONDS='120'):
            code, snapshots, start = self.run_queued(release_after=4000)
        self.assertEqual(code, common.EXIT_HOME_DOWN, self.err.getvalue())
        self.assertLess(self.clock.t, start + 400)

    def test_failed_api_time_is_not_refunded_by_later_healthy_passes(self):
        self.clock.time.time = lambda: self.clock.t
        for failure in ('network', 'http'):
            with self.subTest(failure=failure):
                self.clock.t = 1000
                calls = 0
                def request(*args, **kwargs):
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        self.clock.sleep(6)
                        if failure == 'http':
                            raise http_error(500)
                        raise TimeoutError('no answer')
                    return io.BytesIO(b'{"running":true}')
                with patch.object(api, 'time', self.clock.time), patch.object(api, '_open', side_effect=request), \
                        allocation.scope('repo'), outage.allocation_budget(120):
                    self.assertTrue(api.cmd_status('one', 1, retries=1)['running'])
                    outage.queue_progress()
                    self.assertEqual(outage.allocation_left(), 112.5)
                    self.clock.sleep(10)
                    outage.queue_progress()
                    self.assertEqual(outage.allocation_left(), 112.5)

    def test_busy_background_box_locks_are_healthy_queue_contention(self):
        self.con.execute("UPDATE runs SET mode='bg',process_id=1,command_id='fixture'")
        self.con.commit()
        with patch.object(pool, '_refresh_background', self.real_refresh):
            code, snapshots, start = self.run_queued(healthy_probe_seconds=6, release_after=4000,
                                                      busy_background_locks=True)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertGreaterEqual(self.clock.t, start + 4000)

    def test_outage_before_registration_starts_a_fresh_full_queue_wait(self):
        code, snapshots, start = self.run_queued(pre_queue=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0][1]['end'], start + 15 + 86400)
        self.assertIn('will wait up to 24h00m', self.err.getvalue())
        self.assertFalse(any(c.args[:2] == ('pool', 'run.queue_resumed') for c in self.events.call_args_list))

    def test_queue_sleep_preserves_budget_but_api_work_still_expires(self):
        self.clock.time.time = lambda: self.clock.t
        with patch.object(api, 'time', self.clock.time), allocation.scope('repo'), \
                outage.allocation_budget(10), patch.object(api.urllib.request, 'urlopen',
                    return_value=io.BytesIO(b'{"sandbox":{"id":"one"}}')) as send:
            self.clock.sleep(3)
            with outage.queue_idle():
                self.clock.sleep(900)
            self.assertEqual(api.get('one')['id'], 'one')
            self.assertLessEqual(send.call_args.kwargs['timeout'], 7)
            self.clock.sleep(8)
            with self.assertRaises(OffboxError):
                api.get('one')
            self.assertEqual(send.call_count, 1)


class TtlKeeperTests(OutageBase):
    class Evt:
        def __init__(self, stop_after=3):
            self.waits, self.stop_after = [], stop_after

        def wait(self, t):
            self.waits.append(t)
            return len(self.waits) >= self.stop_after

    def test_retry_after_failed_get_then_refresh(self):
        evt = self.Evt()
        with patch.object(runs.lease, "ensure_ttl", return_value=True), \
                patch.object(runs.api, "get", side_effect=[OffboxError("down"), {}, {}]), \
                contextlib.redirect_stderr(io.StringIO()):
            runs._ttl_keeper("bx", evt)
        self.assertEqual(evt.waits, [runs.TTL_RETRY_S, runs.TTL_REFRESH_S, runs.TTL_REFRESH_S])

    def test_failed_refresh_retries_soon(self):
        evt = self.Evt(stop_after=1)
        with patch.object(runs.lease, "ensure_ttl", return_value=False), \
                patch.object(runs.api, "get", return_value={}), \
                contextlib.redirect_stderr(io.StringIO()):
            runs._ttl_keeper("bx", evt)
        self.assertEqual(evt.waits, [runs.TTL_RETRY_S])

    def test_ttl_window_survives_a_25_minute_outage(self):
        self.assertGreaterEqual(common.RUN_TTL_S - common.TTL_REFRESH_S, 25 * 60)

    def test_ensure_ttl_far_deadline_skips_patch(self):
        with patch.object(lease.api, "set_ttl") as st:
            from datetime import datetime, timezone
            import time as real_time
            # lease.now is real time (only outage/common.now is faked), so build the deadline from real time.
            iso_z = datetime.fromtimestamp(real_time.time() + 7200, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.assertTrue(lease.ensure_ttl("bx", 1800, {"archiveAfter": iso_z}))
            st.assert_not_called()

    def test_ensure_ttl_patch_ok_is_true(self):
        with patch.object(lease.api, "set_ttl", return_value={}):
            self.assertTrue(lease.ensure_ttl("bx", 1800, {}))

    def test_ensure_ttl_patch_failure_is_false(self):
        with patch.object(lease.api, "set_ttl", side_effect=OffboxError("down")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(lease.ensure_ttl("bx", 1800, {}))


class BrokenPipeTests(Isolated):
    def test_say_and_warn_loud_ignore_closed_stderr(self):
        class Closed(io.StringIO):
            def write(self, s):
                raise BrokenPipeError()

            def flush(self):
                raise BrokenPipeError()
        with patch.object(sys, "stderr", Closed()):
            common.say("hello")
            common.warn_loud("careful")

    def test_follow_echo_stops_on_closed_stdout_but_log_keeps_output(self):
        class ClosedBuffer:
            def write(self, b):
                raise BrokenPipeError()

            def flush(self):
                pass

        class ClosedOut:
            buffer = ClosedBuffer()

            def flush(self):
                pass

        frames = iter([{"type": "stdout", "data": "a\n", "nextOffset": 2},
                       {"type": "stdout", "data": "b\n", "nextOffset": 4},
                       {"type": "exit", "exitCode": 3}])
        with tempfile.TemporaryDirectory() as d, \
                patch.object(sys, "stdout", ClosedOut()), \
                patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", return_value=frames), \
                patch.object(runs.lease, "ensure_ttl"), patch.object(runs.api, "get", return_value={}):
            log = Path(d) / "run.log"
            rc = runs.follow("bx", 1, log, echo=True, run_id="r")
            self.assertEqual(rc, 3)
            self.assertEqual(log.read_bytes(), b"a\nb\n")


CLOSED_PIPE_CHILD = r'''
import os, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from unittest.mock import patch
from offbox_lib import runs
frames = iter([{"type": "stdout", "data": "x" * 65536 + "\n", "nextOffset": 65537},
               {"type": "stdout", "data": "tail\n", "nextOffset": 65542},
               {"type": "exit", "exitCode": 3}])
r, w = os.pipe()
os.close(r)  # the reader is gone: the first echo write raises BrokenPipeError
os.dup2(w, 1)
os.close(w)
with patch.object(runs, "_ttl_keeper", return_value=None), \
        patch.object(runs.api, "cmd_attach", return_value=frames), \
        patch.object(runs.lease, "ensure_ttl"), patch.object(runs.api, "get", return_value={}):
    rc = runs.follow("bx", 1, Path(sys.argv[2]), echo=True, run_id="r")
sys.stdout.write("")  # what the caller's own code does before exiting
sys.exit(rc)
'''


class HealthyStreamClearsOutageTests(OutageBase):
    def test_outage_then_healthy_output_then_disconnect_reattaches(self):
        # One brief 525, then the stream recovers and runs an hour. A later ordinary socket timeout must reattach
        # normally, not fail as "API was down for 1800s" from the earlier outage's start.
        clock = {"t": 1000.0}
        attaches = []

        def attach(box, pid, o, e, timeout=90, deadline=None):
            attaches.append(clock["t"])
            if len(attaches) == 1:
                clock["t"] += 5
                raise api.ApiError(525, "http_525", "")
            if len(attaches) == 2:
                # healthy stream: frames for an hour, then a socket timeout mid-run
                def frames():
                    yield {"type": "stdout", "data": "ok\n", "nextOffset": 3}
                    clock["t"] += 3600
                    raise OSError("timed out")
                return frames()
            return iter([{"type": "exit", "exitCode": 0}])

        def status(box, pid, timeout=60, retries=2, deadline=None):
            return {"running": True, "status": "running"}

        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=attach), \
                patch.object(runs.api, "cmd_status", side_effect=status), \
                patch.object(runs, "now", lambda: clock["t"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = runs.follow("bx", 1, None, echo=False, stop_evt=FollowOutageTests.Evt())
        self.assertEqual(rc, 0)
        self.assertEqual(len(attaches), 3)


class StatusConnectRetryTests(OutageBase):
    def test_status_inside_the_window_sends_a_52x_once_through_the_real_call(self):
        # Real api.cmd_status -> api.call (no cmd_status mock). A not-delivered 525 must not get connect retries
        # or their sleeps once the outage window is what bounds the request.
        import time as real_time
        self.urlopen.side_effect = cf(525)
        # api deadlines are real time.time(): an outage window that started now has its whole length left.
        with self.assertRaises(api.ApiError):
            api.cmd_status("bx", 1, timeout=60, retries=0, deadline=real_time.time() + runs.OUTAGE_FOLLOW_S)
        self.assertEqual(self.urlopen.call_count, 1)

    def test_status_without_absolute_end_still_bounded_by_connect_retries_only_when_asked(self):
        # Documents the reason for the deadline: no deadline keeps the connect retries (5 extra sends).
        self.urlopen.side_effect = cf(525)
        with self.assertRaises(api.ApiError):
            api.cmd_status("bx", 1, timeout=60, retries=0)
        self.assertGreater(self.urlopen.call_count, 1)


class FollowTimeoutClockTests(OutageBase):
    """follow -> real api.cmd_attach/cmd_status -> real api.call, with only the socket faked: every socket attempt
    hangs for the timeout urllib was given, then fails the way a silent boat does. The 30-minute outage bound must
    hold on that clock, not only on mocked cmd_status results."""

    def run_follow(self, attach_timeout_s, status_timeout_s, until=None):
        clock = {"t": 1000.0, "first_fail": None}

        def fake_urlopen(req, timeout=None):
            # urllib gives the socket its timeout; a silent boat burns all of it before failing.
            clock["t"] += min(float(timeout), attach_timeout_s if "/stream" in req.full_url else status_timeout_s)
            if clock["first_fail"] is None:
                clock["first_fail"] = clock["t"]
            raise OSError("timed out")

        self.urlopen.side_effect = fake_urlopen
        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "time", types.SimpleNamespace(
                    time=lambda: clock["t"], sleep=lambda s: clock.__setitem__("t", clock["t"] + s))), \
                patch.object(runs, "now", lambda: clock["t"]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                runs.follow("bx", 1, None, echo=False, stop_evt=FollowOutageTests.Evt(), until=until)
        return clock, cm.exception

    def test_slow_timeouts_hold_the_30_minute_bound(self):
        clock, e = self.run_follow(attach_timeout_s=90, status_timeout_s=60)
        outage_s = clock["t"] - clock["first_fail"]
        self.assertIn("lost the output stream", str(e))
        self.assertLessEqual(outage_s, runs.OUTAGE_FOLLOW_S + 150)  # one slow attach past the window at most
        self.assertGreater(outage_s, runs.OUTAGE_FOLLOW_S - 150)    # and the window is actually used

    def test_fast_attach_slow_status_holds_the_30_minute_bound(self):
        clock, e = self.run_follow(attach_timeout_s=1, status_timeout_s=60)
        outage_s = clock["t"] - clock["first_fail"]
        self.assertIn("lost the output stream", str(e))
        self.assertLessEqual(outage_s, runs.OUTAGE_FOLLOW_S + 150)
        self.assertGreater(outage_s, runs.OUTAGE_FOLLOW_S - 150)

    def test_until_still_exits_124_during_an_outage(self):
        # The caller's --timeout keeps its own exit (124, the run keeps going) even while boat is down.
        start = 1000.0
        clock, e = self.run_follow(attach_timeout_s=90, status_timeout_s=60, until=start + 600)
        self.assertEqual(e.code, common.EXIT_WAIT_TIMEOUT)
        self.assertTrue(e.started)
        self.assertLessEqual(clock["t"], start + 600 + 90)

    def test_fast_failures_hold_the_30_minute_bound(self):
        clock, e = self.run_follow(attach_timeout_s=1, status_timeout_s=1)
        outage_s = clock["t"] - clock["first_fail"]
        self.assertIn("lost the output stream", str(e))
        self.assertLessEqual(outage_s, runs.OUTAGE_FOLLOW_S + 150)
        self.assertGreater(outage_s, runs.OUTAGE_FOLLOW_S - 150)


class ClosedStderrSubprocessTests(Isolated):
    def test_say_then_exit_code_survives_a_closed_stderr_pipe(self):
        code = (
            "import os, sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "from offbox_lib import common\n"
            "r, w = os.pipe(); os.close(r); os.dup2(w, 2); os.close(w)\n"
            "common.say('hello'); common.warn_loud('careful')\n"
            "sys.exit(3)\n"
        )
        import subprocess
        scripts = str(Path(__file__).resolve().parents[1])
        p = subprocess.run([sys.executable, "-W", "ignore", "-c", code, scripts], capture_output=True, timeout=60)
        self.assertEqual(p.returncode, 3, p.stderr.decode(errors="replace")[-500:])
        self.assertNotIn(b"BrokenPipeError", p.stderr)


class ClosedPipeSubprocessTests(Isolated):
    def test_exit_code_survives_a_closed_stdout_pipe(self):
        # A real closed pipe: the interpreter's shutdown flush must not raise and replace the remote exit code.
        import subprocess
        scripts = str(Path(__file__).resolve().parents[1])
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, "-W", "ignore", "-c", CLOSED_PIPE_CHILD, scripts,
                                str(Path(d) / "run.log")], capture_output=True, timeout=60)
            self.assertEqual(p.returncode, 3, p.stderr.decode(errors="replace")[-500:])
            self.assertNotIn(b"BrokenPipeError", p.stderr)
            self.assertEqual((Path(d) / "run.log").read_bytes()[:5], b"xxxxx")


class FollowOutageTests(OutageBase):
    class Evt:
        def is_set(self):
            return False

        def wait(self, t):
            return False

        def set(self):
            pass

    def follow(self, status_error, attach_error=None):
        if attach_error is None:
            attach_error = api.ApiError(525, "http_525", "")
        clock_calls = {"n": 0}

        def fake_now():
            clock_calls["n"] += 10
            return 1000.0 + clock_calls["n"]
        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=attach_error) as att, \
                patch.object(runs.api, "cmd_status", side_effect=status_error), \
                patch.object(runs, "now", fake_now), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                runs.follow("bx", 1, None, echo=False, stop_evt=self.Evt())
        return att, cm.exception

    def test_follow_rides_out_an_outage(self):
        att, e = self.follow(api.ApiError(525, "http_525", ""))
        self.assertGreater(att.call_count, 25)
        self.assertIn("lost the output stream", str(e))
        self.assertTrue(e.started)

    def test_outage_window_holds_on_a_slow_request_clock(self):
        # Each attach hangs 90 s and each status 60 s before failing (the reported slow-timeout pattern). The
        # 30-minute outage window must end the follow near 30 min of wall clock, not after the 21-failure count.
        clock = {"t": 1000.0, "first_fail": None}

        # Each request hangs for its whole timeout, then fails: the fake clock advances by the timeout it was given.
        # The outage window opens at the first failure, so the first attach's own 90 s is before it.
        def slow_attach(*a, **k):
            clock["t"] += min(90.0, k.get("timeout", 90))
            if clock["first_fail"] is None:
                clock["first_fail"] = clock["t"]
            raise api.ApiError(525, "http_525", "")

        def slow_status(*a, **k):
            clock["t"] += min(60.0, k.get("timeout", 60))
            raise api.ApiError(525, "http_525", "")

        def fake_now():
            return clock["t"]

        with patch.object(runs, "_ttl_keeper", return_value=None), \
                patch.object(runs.api, "cmd_attach", side_effect=slow_attach) as att, \
                patch.object(runs.api, "cmd_status", side_effect=slow_status), \
                patch.object(runs, "now", fake_now), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(OffboxError) as cm:
                runs.follow("bx", 1, None, echo=False, stop_evt=self.Evt())
        outage_s = clock["t"] - clock["first_fail"]
        self.assertIn("lost the output stream", str(cm.exception))
        self.assertLessEqual(outage_s, runs.OUTAGE_FOLLOW_S + 2)  # holds to within one second of the window
        self.assertGreater(outage_s, runs.OUTAGE_FOLLOW_S - 120)  # and it does use the window, not gives up early
        self.assertGreater(att.call_count, 5)

    def test_follow_gives_up_after_21_non_outage_failures(self):
        att, e = self.follow(OffboxError("x"), attach_error=OffboxError("x"))
        self.assertEqual(att.call_count, 21)


class StatusTests(OutageBase):
    def test_status_is_bounded_and_says_when_boat_is_down(self):
        calls = []

        def limits():
            calls.append(api.left())
            raise OffboxError("boat API unreachable")

        def boxes(*a, **k):
            calls.append(api.left())
            raise OffboxError("boat API unreachable")
        outage.note_down("HTTP 525")
        out = io.StringIO()
        with patch.object(misc.api, "limits", side_effect=limits), \
                patch.object(misc.api, "list_boxes", side_effect=boxes), \
                contextlib.redirect_stdout(out):
            misc.status({"owner": "w", "repo_root": "/r"})
        text = out.getvalue()
        self.assertIn("account: boat API unreachable", text)
        self.assertIn("boxes: boat API unreachable", text)
        self.assertIn("boat.dev: DOWN since", text)
        self.assertEqual(len(calls), 2)
        for left in calls:
            self.assertIsNotNone(left)
            self.assertLessEqual(left, misc.STATUS_CALL_S)


if __name__ == "__main__":
    unittest.main()
