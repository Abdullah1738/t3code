"""Offline tests: boat's per-size supply outage (cooldown, resume/create one size smaller, pool skip, reaper)."""
import contextlib
import datetime as dt
import io
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, bases, capacity, common, lease, pool, reap
from offbox_lib.common import OffboxError
from test_capacity import Isolated

SUPPLY_MSG = "supply for size xlarge is over, try later or another type of VM"


def iso_utc(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class Clock:
    """Fake api.time: time() and sleep() move one shared clock."""

    def __init__(self, t: float):
        self.t = t

    def time(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


class WaitStateSupply(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api.time, "sleep", lambda s: None))

    def box_state(self, state, error=None, updated=None):
        return {"id": "bx_s", "state": state, "error": error, "updatedAt": updated, "type": "xlarge"}

    def test_fresh_supply_error_trips_on_first_poll(self):
        t = time.time()
        s = self.box_state("archived", SUPPLY_MSG, iso_utc(t + 1))
        with patch.object(api, "get", return_value=s):
            with self.assertRaises(api.SupplyOut) as cm:
                api.wait_state("bx_s", api.LIVE_STATES, timeout=60, since=t)
        e = cm.exception
        self.assertEqual(e.size, "xlarge")
        self.assertIsInstance(e, capacity.CapacityError)
        self.assertEqual(e.code, 90)
        self.assertIsNotNone(capacity.supply_until("xlarge"))

    def test_error_written_before_this_attempt_is_ignored(self):
        t = time.time()
        s = self.box_state("archived", SUPPLY_MSG, iso_utc(t - 600))
        with patch.object(api, "get", side_effect=[s, self.box_state("idle")]):
            got = api.wait_state("bx_s", api.LIVE_STATES, timeout=60, since=t)
        self.assertEqual(got["state"], "idle")
        self.assertIsNone(capacity.supply_until("xlarge"))

    def test_stale_message_waits_out_the_grace_period(self):
        clock = Clock(1_000_000.0)
        s = self.box_state("archived", SUPPLY_MSG, iso_utc(clock.t))
        with patch.object(api, "time", clock):
            with patch.object(api, "get", side_effect=lambda _b: s):
                with self.assertRaises(api.SupplyOut):
                    api.wait_state("bx_s", api.LIVE_STATES, timeout=900, since=clock.t, stale_error=SUPPLY_MSG)
        self.assertGreaterEqual(clock.t - 1_000_000.0, api.SUPPLY_STALE_GRACE_S)

    def test_stale_message_returns_when_box_comes_back_within_grace(self):
        clock = Clock(1_000_000.0)

        def fake_get(_b):
            if clock.t - 1_000_000.0 < 60:
                return self.box_state("archived", SUPPLY_MSG, iso_utc(clock.t))
            return self.box_state("idle")
        with patch.object(api, "time", clock), patch.object(api, "get", side_effect=fake_get):
            got = api.wait_state("bx_s", api.LIVE_STATES, timeout=900, since=clock.t, stale_error=SUPPLY_MSG)
        self.assertEqual(got["state"], "idle")
        self.assertIsNone(capacity.supply_until("xlarge"))

    def test_cancelled_box_with_supply_error_raises_supply_out(self):
        s = {"id": "bx_c", "state": "cancelled", "error": "supply for size large is over, try later", "type": "large"}
        with patch.object(api, "get", return_value=s):
            with self.assertRaises(api.SupplyOut) as cm:
                api.wait_state("bx_c", api.LIVE_STATES, timeout=60)
        self.assertEqual(cm.exception.size, "large")
        self.assertEqual(cm.exception.code, 90)


class CooldownStore(Isolated):
    def test_cooldown_expires(self):
        capacity.supply_out("xlarge", "bx_1", SUPPLY_MSG)
        self.assertIsNotNone(capacity.supply_until("xlarge"))
        later = time.time() + 700
        with patch.object(capacity, "now", return_value=later):
            self.assertIsNone(capacity.supply_until("xlarge"))
            self.assertEqual(capacity.supply_status(), {})

    def test_cooldown_seconds_is_clamped(self):
        with patch.dict(os.environ, {"OFFBOX_SUPPLY_COOLDOWN_SECONDS": "5"}):
            self.assertEqual(capacity.supply_cooldown_s(), 60)
        with patch.dict(os.environ, {"OFFBOX_SUPPLY_COOLDOWN_SECONDS": "99999"}):
            self.assertEqual(capacity.supply_cooldown_s(), 3600)


class ResumeAndCreate(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api.time, "sleep", lambda s: None))
        capacity.supply_out("xlarge", None, SUPPLY_MSG)

    def stopped_harness(self, state="stopped", size="xlarge"):
        self.box("bx_h", state=state, size=size, source="template:crpko-harness")
        return self.con.execute("SELECT * FROM leases WHERE box_id='bx_h'").fetchone()

    def test_stopped_box_resumes_one_size_smaller(self):
        row = self.stopped_harness()
        err = io_err = None
        buf = io.StringIO()
        with patch.object(api, "get", return_value={"id": "bx_h", "state": "archived", "type": "xlarge"}), \
                patch.object(api, "resume", return_value={}) as resume, \
                patch.object(lease, "_bring_up", return_value={}), \
                contextlib.redirect_stderr(buf):
            got = lease._reuse(self.con, row, None)
        self.assertEqual(resume.call_args[0][2], "large")
        self.assertIn("resuming stopped lease bx_h (large)", buf.getvalue())
        self.assertIn("resuming bx_h as large", buf.getvalue())
        self.assertEqual(got["size"], "large")

    def test_explicit_size_waits_instead_of_downsizing(self):
        row = self.stopped_harness()
        with patch.object(api, "get", return_value={"id": "bx_h", "state": "archived", "type": "xlarge"}), \
                patch.object(api, "resume", return_value={}) as resume:
            with self.assertRaises(api.SupplyOut) as cm:
                lease._reuse(self.con, row, "xlarge")
        self.assertFalse(cm.exception.tried)
        resume.assert_not_called()

    def test_shrink_refused_while_old_size_is_out_raises(self):
        row = self.stopped_harness()
        refused = api.ApiError(409, "shrink_refused", "disk does not fit the smaller size")
        with patch.object(api, "get", return_value={"id": "bx_h", "state": "archived", "type": "xlarge"}), \
                patch.object(api, "resume", side_effect=refused) as resume:
            with self.assertRaises(api.SupplyOut) as cm:
                lease._reuse(self.con, row, None)
        self.assertEqual(resume.call_count, 1)
        self.assertEqual(cm.exception.size, "xlarge")
        self.assertTrue(cm.exception.tried)

    def test_new_box_is_created_one_size_smaller(self):
        me = dict(self.me, title="t")
        with patch.object(api, "create", return_value={"id": "bx_new"}) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            lease._new_box(self.con, me, None, "crpko-harness", None, False)
        self.assertEqual(create.call_args[0][0], "large")

    def test_pool_queues_with_no_xlarge_when_both_members_are_stopped_xlarge(self):
        self.box("bx_a", state="stopped", member=True, size="xlarge", source="template:crpko-harness")
        self.box("bx_b", state="stopped", member=True, size="xlarge", source="template:crpko-harness")
        with patch.object(lease, "_reuse") as reuse, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(capacity.CapacityError) as cm:
                pool.acquire(self.me, "xlarge")
        reuse.assert_not_called()
        self.assertIn("no xlarge machines", str(cm.exception))

    def test_pool_moves_on_after_a_tried_supply_out(self):
        self.con.execute("DELETE FROM kv WHERE k=?", (capacity.SUPPLY_KV,))
        self.con.commit()
        self.box("bx_a", state="stopped", member=True, size="large", source="template:crpko-go")
        self.box("bx_b", state="stopped", member=True, size="large", source="template:crpko-go")
        ok = {"box_id": "bx_b", "remote_dir": "w/x", "size": "large", "state": "running", "repo_key": "repo",
              "repo_root": "/checkout/repo"}

        def fake_reuse(con, row, size, skip_archiving=False):
            if row["box_id"] == "bx_a":
                raise api.SupplyOut("large", "bx_a", SUPPLY_MSG, tried=True)
            return dict(ok)
        with patch.object(lease, "_reuse", side_effect=fake_reuse), \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me, None)
        self.assertEqual(got["box_id"], "bx_b")


class ReaperNoBox(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, "list_boxes", return_value=[]))
        self.stack.enter_context(patch.object(bases, "upkeep", return_value=None))

    def run_row(self, rid, pid=None, start_at=None, box=None, status="starting"):
        self.con.execute("INSERT INTO runs(run_id, mode, status, start_at, client_pid, box_id, owner) "
                         "VALUES (?,?,?,?,?,?,?)", (rid, "fg", status, start_at if start_at else time.time(),
                                                    pid, box, "worker"))
        self.con.commit()

    def status_of(self, rid):
        return self.con.execute("SELECT status, error FROM runs WHERE run_id=?", (rid,)).fetchone()

    def test_dead_client_no_box_run_is_marked_lost(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.run_row("run-dead", pid=p.pid, start_at=time.time() - 60)
        actions = reap._reap(self.con, False, [])
        row = self.status_of("run-dead")
        self.assertEqual(row["status"], "lost")
        self.assertEqual(row["error"], "client ended before it got a box")
        self.assertTrue(any("mark no-box run run-dead lost" in a for a in actions))

    def test_live_client_untouched(self):
        self.run_row("run-live", pid=os.getpid(), start_at=time.time())
        reap._reap(self.con, False, [])
        self.assertEqual(self.status_of("run-live")["status"], "starting")

    def test_no_client_pid_keeps_two_hour_rule(self):
        self.run_row("run-old", pid=None, start_at=time.time() - 600)
        reap._reap(self.con, False, [])
        self.assertEqual(self.status_of("run-old")["status"], "starting")

    def test_boxed_run_with_dead_client_is_untouched(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.run_row("run-boxed", pid=p.pid, start_at=time.time() - 60, box="bx_1")
        reap._reap(self.con, False, [])
        self.assertEqual(self.status_of("run-boxed")["status"], "starting")

    def test_dry_run_writes_nothing(self):
        p = subprocess.Popen([sys.executable, "-c", "pass"])
        p.wait()
        self.run_row("run-dry", pid=p.pid, start_at=time.time() - 60)
        actions = reap._reap(self.con, True, [])
        self.assertEqual(self.status_of("run-dry")["status"], "starting")
        self.assertTrue(any("would mark no-box run run-dry lost" in a for a in actions))


if __name__ == "__main__":
    unittest.main()
