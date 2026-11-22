"""A post-queue box timeout retains the grant while the home control plane recovers."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import allocation, api, common, home, lease, outage, pool
from test_home_backend import BoxReadinessFailover

REAL_REACHABLE = home.slow_read_reachable


class HomeBoxSlow(unittest.TestCase):
    def setUp(self):
        self.f = BoxReadinessFailover()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.stack = self.f.stack
        self.clock = self.f.clock
        self.stack.enter_context(patch.object(home, "time", self.clock.time))
        self.stack.enter_context(patch.object(lease, "time", self.clock.time))
        self.stack.enter_context(patch.object(home, "tcp_connects", return_value=True))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        token = home.QUEUE_WAIT.set(0)
        self.addCleanup(lambda: home.QUEUE_WAIT.reset(token))
        self.stack.enter_context(patch.object(home, "slow_read_reachable", return_value=True))
        self.stack.enter_context(patch.object(home, "say"))
        # A long home queue is reachable only when Boat cannot take this ordinary run.
        self.stack.enter_context(patch.object(home, "boat_can_take", return_value=False))

    def warm_ssh_row(self):
        self.f.box("homebox", member=True)
        cfg = Path(self.f.tmp.name) / "ssh-cache"
        cfg.touch()
        self.stack.enter_context(patch.object(lease.ssh_sync, "cfg_path", return_value=cfg))
        self.stack.enter_context(patch.object(lease.ssh_sync, "ssh_base", return_value=["ssh"]))
        self.stack.enter_context(patch.object(lease.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr=b"")))
        self.stack.enter_context(patch.object(lease, "ensure_ttl"))
        return self.f.con.execute("SELECT * FROM leases WHERE box_id='homebox'").fetchone()

    def test_slow_read_after_acceptance_can_cross_the_queue_deadline(self):
        for accepted, began in ((False, 39), (True, 0), (True, 39)):
            self.clock.t = 1000
            reads = []
            def opening(request, timeout):
                self.assertTrue(request.full_url.endswith("/sandboxes/homebox"))
                reads.append(timeout)
                if len(reads) == 1:
                    self.clock.sleep(timeout)
                    raise TimeoutError("sandbox read timed out")
                return io.BytesIO(b'{"sandbox":{"id":"homebox","state":"running"}}')
            with self.subTest(accepted=accepted, began=began), \
                    patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="40"), allocation.queue() as queue, \
                    patch.object(api, "get", self.f.status_get), patch.object(api, "_own_box"), \
                    patch.object(api, "_key", return_value="fixture"), patch.object(api, "_open", side_effect=opening), \
                    home.wait_budget():
                self.clock.sleep(began)
                with outage.accepted_machine() if accepted else contextlib.nullcontext():
                    if accepted:
                        self.assertEqual(lease._readiness_get("homebox")["id"], "homebox")
                    else:
                        with self.assertRaises(pool.PoolBusyError):
                            lease._readiness_get("homebox")
                self.assertEqual(queue["end"], 1040)
                self.assertEqual(len(reads), 2 if accepted else 1)
                self.assertEqual(self.clock.t, 1000 + began + 5)

    def test_accepted_slow_read_keeps_caller_and_api_bounds(self):
        for kind in ("explicit", "api"):
            self.clock.t = 1000
            reads = []
            def opening(request, timeout):
                reads.append(timeout)
                self.clock.sleep(timeout)
                raise TimeoutError("sandbox read timed out")
            with self.subTest(kind=kind), patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="40"), \
                    allocation.queue(), patch.object(api, "get", self.f.status_get), \
                    patch.object(api, "_own_box"), patch.object(api, "_key", return_value="fixture"), \
                    patch.object(api, "_open", side_effect=opening), home.wait_budget():
                self.clock.sleep(39)
                with outage.accepted_machine(), api.budget(8) if kind == "api" else contextlib.nullcontext():
                    with self.assertRaises(api.BudgetExpired):
                        lease._readiness_get("homebox", deadline=1047 if kind == "explicit" else None)
                self.assertEqual(self.clock.t, 1047)
                self.assertEqual(reads, [5, 3])

    def test_warm_ssh_two_transport_timeouts_keep_home_box_after_healthy_preflight(self):
        self.warm_ssh_row()
        reads = []
        def opening(request, timeout):
            self.assertTrue(request.full_url.endswith("/sandboxes/homebox"))
            reads.append(timeout)
            if len(reads) <= 2:
                self.clock.sleep(timeout)
                raise TimeoutError("sandbox read timed out")
            return io.BytesIO(json.dumps({"sandbox": {"id": "homebox", "state": "running", "type": "large", "heldRuns": []}}).encode())
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="5000", OFFBOX_POOL_SIZE="1"), \
                patch.object(api, "get", self.f.status_get), patch.object(api, "_key", return_value="fixture"), \
                patch.object(api, "_open", side_effect=opening), \
                patch.object(home, "recover_slow_read", wraps=home.recover_slow_read) as recovery:
            got, output = self.f.run_cmd("--remote", "--", "go", "test", "./...")
        self.assertIsInstance(got, dict, output)
        pool.release_guard(got)
        self.assertEqual(got["box_id"], "homebox")
        recovery.assert_called_once()
        self.assertEqual(len(reads), 3)
        self.assertAlmostEqual(reads[0], api.HOME_START_TIMEOUT_S)
        self.assertAlmostEqual(reads[1], home.slow_probe_seconds())
        self.assertLess(self.clock.t - 1000, home.slow_down_seconds())
        self.assertEqual(self.f.execs, [])
        self.assertFalse(common.HOME_FAILURES.exists())
        self.assertTrue(api.probe_backend.called, "the authenticated home preflight must succeed first")

    def test_warm_ssh_http_and_connection_refusals_remain_hard(self):
        row = self.warm_ssh_row()
        for error in (api.ApiError(500, "internal", "read refused"), api.NetworkError("connection refused")):
            with self.subTest(error=type(error).__name__), patch.object(api, "get", side_effect=error) as read, \
                    patch.object(lease, "_check_held") as check_held, home.wait_budget():
                began = self.clock.t
                with self.assertRaises(type(error)) as caught:
                    lease._reuse(self.f.con, row, None)
                self.assertIs(caught.exception, error)
                self.assertEqual(home.failure_class(str(error)), "hard")
                self.assertEqual(self.clock.t, began)
                read.assert_called_once()
                check_held.assert_not_called()

    def test_queued_41_min_timeout_keeps_the_same_box_and_grant(self):
        for sighting, seconds in (("9eaf", 2460), ("e0c7", 2460), ("70a7", 2460), ("d15b", 2545)):
            with self.subTest(sighting=sighting):
                self.f.con.execute("DELETE FROM runs")
                self.f.con.execute("DELETE FROM leases")
                self.f.con.execute("DELETE FROM pool_members")
                self.f.box("homebox", member=True)
                self.f.busy("homebox")
                began = self.clock.t
                self.clock.on_sleep = lambda t: self.f.con.execute("UPDATE runs SET status='done'") if t >= began + seconds else None
                calls = []
                def read(box, **kwargs):
                    calls.append((box, kwargs.get("deadline"), self.clock.t))
                    if len(calls) == 1:
                        self.clock.sleep(5)
                        raise api.NetworkError("deadline passed during GET /sandboxes/homebox: urlopen error timed out")
                    return {"id": box, "state": "running", "type": "large"}
                with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="5000", OFFBOX_POOL_SIZE="1"), \
                        patch.object(api, "get", side_effect=read), patch.object(lease, "ensure_ttl"), \
                        patch.object(lease, "_bring_up", return_value={"state": "running"}), \
                        patch.object(lease, "_bring_up_resumed", side_effect=AssertionError("no resume needed")), \
                        patch.object(lease, "acquire_private", side_effect=AssertionError("keep selected box")), \
                        home.wait_budget(), contextlib.redirect_stderr(io.StringIO()):
                    got = pool.acquire(self.f.me)
                pool.release_guard(got)
                self.assertEqual(got["box_id"], "homebox")
                self.assertEqual([call[0] for call in calls], ["homebox", "homebox"])
                self.assertGreaterEqual(calls[0][2] - began, seconds)
                self.assertAlmostEqual(calls[1][1] - calls[1][2], 15)
                self.assertGreaterEqual(home.QUEUE_WAIT.get(), seconds)
                self.assertEqual(self.f.execs, [])
                self.assertFalse(common.HOME_FAILURES.exists())

    def test_two_timeouts_then_ready_use_shared_wait_without_reallocation(self):
        with patch.object(api, "readiness_get", side_effect=api.NetworkError("read timed out")), \
                patch.object(api, "get", side_effect=[api.NetworkError("read timed out"), {"state": "running"}]) as read, \
                home.wait_budget():
            self.assertEqual(lease._readiness_get("homebox"), {"state": "running"})
        self.assertEqual(read.call_count, 2)
        self.assertGreater(self.clock.t, 1000)

    def test_slow_bound_records_class_and_original_queue_wait(self):
        queue = dict(wait=86400, end=self.clock.t + 86400, queue_wait_s=2545)
        token = allocation._QUEUE.set(queue)
        self.addCleanup(lambda: allocation._QUEUE.reset(token))
        with patch.object(api, "readiness_get", side_effect=api.NetworkError("read timed out")), \
                patch.object(api, "get", side_effect=api.NetworkError("read timed out")), \
                patch.object(home, "tcp_connects", return_value=True), home.wait_budget():
            with self.assertRaises(home.StartWaitFailed) as caught:
                lease._readiness_get("homebox")
        self.assertLessEqual(self.clock.t, 1300)
        home.record_failure(str(caught.exception), "run-queued")
        row = json.loads(common.HOME_FAILURES.read_text())
        self.assertEqual((row["class"], row["queue_wait_s"], row["run"]), ("slow", 2545, "run-queued"))

    def test_hard_refusal_and_client_budget_do_not_enter_slow_retry(self):
        for error in (api.NetworkError("connection refused"), api.BudgetExpired("queue/client deadline expired")):
            with self.subTest(error=type(error).__name__), patch.object(api, "readiness_get", side_effect=error), \
                    patch.object(api, "get", side_effect=AssertionError("hard/client deadline must not retry")):
                with self.assertRaises(type(error)):
                    lease._readiness_get("homebox")
        with patch.object(api, "readiness_get", side_effect=api.NetworkError("read timed out")), \
                patch.object(home, "slow_read_reachable", return_value=False), \
                patch.object(api, "get", side_effect=AssertionError("hard reachability must not retry")):
            with self.assertRaises(api.NetworkError):
                lease._readiness_get("homebox")

    def test_peer_offline_and_boot_change_are_hard_while_unknown_peer_can_wait(self):
        cases = [(False, {"peer_online": True}, {"ok": True, "boot_id": "boot-a"}, False),
                 (True, {"peer_online": False}, {"ok": True, "boot_id": "boot-a"}, False),
                 (True, {"peer_online": True}, {"ok": True, "boot_id": "boot-b"}, False),
                 (True, {"peer_online": None}, "no answer (TimeoutError)", True),
                 (True, {"peer_online": True}, {"ok": False, "reasons": ["incus broken"]}, False)]
        for tcp, peer, health, expected in cases:
            with self.subTest(tcp=tcp, peer=peer, health=health), \
                    patch.object(home, "tcp_connects", return_value=tcp), \
                    patch("home_monitor.tailnet_facts", return_value=peer), \
                    patch.object(home, "_health", return_value=health), \
                    patch.object(common, "home_state", return_value={"state": "home_slow", "boot_id": "boot-a"}):
                self.assertEqual(REAL_REACHABLE(), expected)

    def test_queued_read_health_response_forms_preserve_hard_failures(self):
        cases = [("HTTP 500", "health answered HTTP 500", False),
                 ("HTTP 503", "health answered HTTP 503", False),
                 ("HTTP 401", "health answered HTTP 401", False),
                 ("invalid JSON", "no answer (JSONDecodeError)", False),
                 ("refused", "no answer (ConnectionRefusedError)", False),
                 ("no config", "no home server configured", False),
                 ("empty", "", False), ("null", None, False), ("array", [], False),
                 ("timeout", "no answer (TimeoutError)", True),
                 ("ready", {"ok": True, "boot_id": "boot-a"}, True),
                 ("starting", {"ok": False, "starting": True, "phase": "reconcile"}, True),
                 ("not ok", {"ok": False, "reasons": ["incus failed"]}, False),
                 ("reboot", {"ok": True, "boot_id": "boot-b"}, False)]
        for label, response, retry in cases:
            self.clock.t = 1000
            error = api.NetworkError("deadline passed during GET /sandboxes/homebox: timed out")
            with self.subTest(response=label), home.wait_budget(), \
                    patch.object(home, "slow_read_reachable", side_effect=REAL_REACHABLE), \
                    patch("home_monitor.tailnet_facts", return_value={"peer_online": True}), \
                    patch.object(common, "home_state", return_value={"state": "home_slow", "boot_id": "boot-a"}), \
                    patch.object(home, "_health", return_value=response), \
                    patch.object(api, "readiness_get", side_effect=error), \
                    patch.object(api, "get", return_value={"state": "running"}) as read:
                if retry:
                    self.assertEqual(lease._readiness_get("homebox"), {"state": "running"})
                    read.assert_called_once()
                else:
                    with self.assertRaises(api.NetworkError) as caught:
                        lease._readiness_get("homebox")
                    self.assertIs(caught.exception, error)
                    self.assertEqual(home.failure_class(str(caught.exception)), "hard")
                    read.assert_not_called()
                self.assertEqual(self.clock.t, 1000, "classification must not spend the slow grace on a refusal")

    def test_pending_resume_keeps_queue_deadline_and_marker_on_slow_read(self):
        self.f.box("homebox", "stopped", member=True)
        self.f.con.execute("INSERT INTO kv VALUES ('resume_unanswered:homebox','',?)", (self.clock.t,))
        queue = dict(wait=10, end=self.clock.t + 10)
        token = allocation._QUEUE.set(queue)
        self.addCleanup(lambda: allocation._QUEUE.reset(token))
        def initial(*args, **kwargs):
            self.clock.sleep(5)
            raise api.NetworkError("GET timed out")
        def retry(*args, deadline):
            self.clock.sleep(max(0, deadline - self.clock.t))
            raise api.NetworkError("GET timed out")
        with patch.object(api, "readiness_get", side_effect=initial), \
                patch.object(api, "get", side_effect=retry), patch.object(api, "resume") as resume, home.wait_budget():
            with self.assertRaises(pool.PoolBusyError) as caught:
                lease._resume_under_guard(self.f.con, "homebox", 120, None, pending=True)
        self.assertFalse(caught.exception.outage)
        self.assertLessEqual(self.clock.t, 1010.01)
        self.assertIsNotNone(self.f.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:homebox'").fetchone())
        resume.assert_not_called()

    def test_slow_retry_honors_explicit_api_and_inherited_home_deadlines(self):
        for kind in ("explicit", "api", "home", "episode", "sleep"):
            self.clock.t = 1000
            def read(*args, deadline):
                if kind != "sleep":
                    self.clock.sleep(max(0, deadline - self.clock.t))
                raise api.NetworkError("GET timed out")
            budget = api.budget(8) if kind == "api" else contextlib.nullcontext()
            with self.subTest(kind=kind), budget, \
                    patch.object(api, "readiness_get", side_effect=api.NetworkError("GET timed out")), \
                    patch.object(api, "get", side_effect=read), \
                    home.wait_budget(1008 if kind == "home" else None):
                if kind == "episode":
                    home.begin_transient(began=408)
                expected = home.StartWaitFailed if kind in ("home", "episode") else api.BudgetExpired
                with self.assertRaises(expected) as caught:
                    lease._readiness_get("homebox", deadline=1008 if kind in ("explicit", "sleep") else None)
            self.assertLessEqual(self.clock.t, 1008.01)
            if kind not in ("home", "episode"):
                self.assertFalse(caught.exception.outage)

    def test_queued_http_refusal_retains_wait_seconds_without_network_recovery(self):
        self.f.box("homebox", member=True)
        self.f.busy("homebox")
        began = self.clock.t
        def free(t):
            if t >= began + 2545:
                self.clock.t = began + 2545
                self.clock.on_sleep = None
                self.f.con.execute("UPDATE runs SET status='done'")
        self.clock.on_sleep = free
        refusal = api.ApiError(503, "server_not_ready", "reconcile")
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="5000", OFFBOX_POOL_SIZE="1"), \
                patch.object(api, "get", side_effect=refusal), \
                patch.object(home, "recover_slow_read", side_effect=AssertionError("HTTP is not a transport timeout")):
            with self.assertRaises(common.OffboxError):
                with contextlib.redirect_stderr(io.StringIO()):
                    pool.acquire(self.f.me)
        home.record_failure(str(refusal), "run-queued-http")
        row = json.loads(common.HOME_FAILURES.read_text())
        self.assertEqual(row["queue_wait_s"], 2545)

    def test_provisioning_propagates_queue_expiry_without_losing_resume_marker(self):
        self.f.box("homebox", "stopped", member=True)
        self.f.con.execute("INSERT INTO kv VALUES ('resume_unanswered:homebox','',?)", (self.clock.t,))
        token = allocation._QUEUE.set(dict(wait=10, end=self.clock.t + 10))
        self.addCleanup(lambda: allocation._QUEUE.reset(token))
        reads = []
        def read(box, *, deadline):
            reads.append(box)
            self.clock.sleep(max(0, deadline - self.clock.t))
            raise api.NetworkError("GET timed out")
        with patch.object(api, "get", side_effect=read), patch.object(api, "resume") as resume, home.wait_budget():
            with self.assertRaises(pool.PoolBusyError) as caught:
                lease._wait_unanswered_resume(self.f.con, "homebox")
        self.assertFalse(caught.exception.outage)
        self.assertLessEqual(self.clock.t, 1010.01)
        self.assertEqual(reads, ["homebox", "homebox"])
        self.assertIsNotNone(self.f.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:homebox'").fetchone())
        resume.assert_not_called()

    def test_startup_during_recovered_read_does_not_extend_caller_deadline(self):
        for kind in ("explicit", "queue", "api", "home", "episode"):
            self.clock.t = 1000
            seen = []
            starting = api.ApiError(503, "server_starting", "starting")
            starting.starting, starting.phase = True, "reconcile"
            def request(*args, **kwargs):
                deadline = kwargs.get("deadline", args[8] if len(args) > 8 else None)
                seen.append(deadline)
                if len(seen) == 2:
                    raise starting
                self.clock.sleep(max(0, deadline - self.clock.t))
                raise api.NetworkError("GET timed out")
            def health(timeout):
                return {"ok": self.clock.t >= 1025, "starting": self.clock.t < 1025, "phase": "reconcile"}
            token = allocation._QUEUE.set(dict(wait=30, end=1030) if kind == "queue" else None)
            try:
                budget = api.budget(30) if kind == "api" else contextlib.nullcontext()
                def sleep(seconds):
                    self.assertGreater(seconds, 0, "expired read must not spin on zero-length sleeps")
                    self.clock.sleep(seconds)
                with self.subTest(kind=kind), budget, patch.object(api, "get", self.f.status_get), \
                        patch.object(api, "_own_box"), patch.object(api, "_request", side_effect=request), \
                        patch.object(home, "_health", side_effect=health), \
                        patch.object(self.clock.time, "sleep", side_effect=sleep), \
                        home.wait_budget(1030 if kind == "home" else None):
                    if kind == "episode":
                        home.begin_transient(began=430)
                    with self.assertRaises((api.BudgetExpired, pool.PoolBusyError, home.StartWaitFailed)) as caught:
                        lease._readiness_get("homebox", deadline=1030 if kind == "explicit" else None)
                self.assertEqual(caught.exception.outage, kind in ("home", "episode"))
                self.assertLessEqual(self.clock.t, 1030.01)
                self.assertLessEqual(seen[-1], 1030)
            finally:
                allocation._QUEUE.reset(token)

    def test_recovered_read_does_not_shorten_outer_api_budget(self):
        seen = []
        starting = api.ApiError(503, "server_starting", "starting")
        starting.starting, starting.phase = True, "reconcile"
        def request(*args, **kwargs):
            seen.append(args)
            if len(seen) == 1:
                self.clock.sleep(5)
                raise api.NetworkError("GET timed out")
            if len(seen) == 2:
                raise starting
            return {"sandbox": {"state": "running"}}
        def health(timeout):
            return {"ok": self.clock.t >= 1025, "starting": self.clock.t < 1025, "phase": "reconcile"}
        with patch.object(api, "get", self.f.status_get), patch.object(api, "_own_box"), \
                patch.object(home, "_health", side_effect=health), api.budget(300), home.wait_budget():
            before = api._DEADLINE
            with patch.object(api, "_request", side_effect=request):
                self.assertEqual(lease._readiness_get("homebox", deadline=1030), {"state": "running"})
            self.assertGreaterEqual(api._DEADLINE, before)
            self.clock.sleep(6)
            with patch.object(api, "_key", return_value="fixture"), \
                    patch.object(api, "_open", return_value=io.BytesIO(b"{}")):
                self.assertEqual(api.call("GET", "/limits"), {})
            again = []
            def next_request(*args, **kwargs):
                again.append(args)
                if len(again) == 1:
                    self.clock.sleep(5)
                    raise api.NetworkError("GET timed out")
                return {"sandbox": {"state": "running"}}
            with patch.object(api, "_request", side_effect=next_request):
                self.assertEqual(lease._readiness_get("homebox"), {"state": "running"})
            self.assertEqual(len(again), 2, "a prior successful read must not leave its deadline in the next read")

    def test_repeated_startup_refusals_keep_the_captured_home_episode_bound(self):
        for kind in ("home", "episode"):
            self.clock.t = 1000
            seen = []
            starting = api.ApiError(503, "server_starting", "starting")
            starting.starting, starting.phase = True, "reconcile"
            def request(*args, **kwargs):
                seen.append(args)
                if len(seen) in (2, 3):
                    raise starting
                deadline = kwargs.get("deadline", args[8] if len(args) > 8 else None)
                self.clock.sleep(max(0, deadline - self.clock.t))
                raise api.NetworkError("GET timed out")
            def health(timeout):
                ready_at = 1025 if len(seen) < 3 else 1040
                return {"ok": self.clock.t >= ready_at, "starting": self.clock.t < ready_at, "phase": "reconcile"}
            with self.subTest(kind=kind), patch.object(api, "get", self.f.status_get), \
                    patch.object(api, "_own_box"), patch.object(api, "_request", side_effect=request), \
                    patch.object(home, "_health", side_effect=health), \
                    home.wait_budget(1030 if kind == "home" else None):
                if kind == "episode":
                    home.begin_transient(began=430)
                with self.assertRaises(home.StartWaitFailed):
                    lease._readiness_get("homebox")
                self.assertLessEqual(self.clock.t, 1030.01)

    def test_retained_provision_deadline_remains_a_non_outage_budget(self):
        self.f.box("homebox", "stopped", member=True)
        self.f.con.execute("INSERT INTO kv VALUES ('resume_unanswered:homebox','',?)", (self.clock.t,))
        self.f.con.execute("INSERT INTO kv VALUES ('resume_provision:homebox','1008',?)", (self.clock.t,))
        token = allocation._QUEUE.set(dict(wait=10, end=1010))
        self.addCleanup(lambda: allocation._QUEUE.reset(token))
        reads = []
        def read(box, *, deadline):
            reads.append(box)
            self.clock.sleep(max(0, deadline - self.clock.t))
            raise api.NetworkError("GET timed out")
        with patch.object(api, "get", side_effect=read), home.wait_budget():
            with self.assertRaises(api.BudgetExpired) as caught:
                lease._wait_unanswered_resume(self.f.con, "homebox")
        self.assertFalse(caught.exception.outage)
        self.assertLessEqual(self.clock.t, 1008.01)
        self.assertEqual(reads, ["homebox", "homebox"])
        self.assertIsNotNone(self.f.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:homebox'").fetchone())


if __name__ == "__main__":
    unittest.main()
