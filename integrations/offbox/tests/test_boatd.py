"""boatd (the offbox server): restart reconcile, persistent queue, tokens per owner, health, retention.

Runs anywhere: Incus, systemd, ZFS and /proc are replaced by fakes; SQLite and the HTTP handler are real."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import warnings
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

SERVER = Path(__file__).resolve().parents[1] / "server"
spec = importlib.util.spec_from_file_location("boatd", SERVER / "boatd.py")
boatd = importlib.util.module_from_spec(spec)
sys.modules["boatd"] = boatd
spec.loader.exec_module(boatd)
warnings.simplefilter("ignore", ResourceWarning)


class Fakes:
    """What the host would answer. Tests set the facts; boatd's own logic runs for real."""

    def __init__(self):
        self.calls = []            # incus argv tuples
        self.running = set()       # containers that run
        self.active_units = set()
        self.spawned = []          # (box, pid, attempt)
        self.spawn_error = None
        self.start_fails = set()   # box ids whose container refuses to start
        self.snapshots = {}        # ct name -> [{"name":..., "created_at":...}]
        self.sh = {}               # argv prefix tuple -> (rc, out)
        self.sh_calls = []

    def incus(self, *args, input=None, timeout=600, check=True):
        self.calls.append(args)
        rc, out = 0, b""
        if args[:1] == ("start",):
            bid = args[1].replace("-", "_")
            if bid in self.start_fails:
                rc = 1
            else:
                self.running.add(bid)
        elif args[:1] == ("stop",):
            self.running.discard(args[1].replace("-", "_"))
        elif args[:2] == ("snapshot", "create"):
            self.snapshots.setdefault(args[2], []).append({"name": args[3], "created_at": "2026-11-12T00:00:00Z"})
        elif args[:2] == ("snapshot", "delete"):
            self.snapshots[args[2]] = [s for s in self.snapshots.get(args[2], []) if s["name"] != args[3]]
        elif args[:1] == ("query",) and "/snapshots" in args[1]:
            name = args[1].split("/")[3]
            out = json.dumps(self.snapshots.get(name, [])).encode()
        elif args[:2] == ("config", "device"):
            out = b"ssh\n"
        p = subprocess.CompletedProcess(args, rc, out, b"refused" if rc else b"")
        if check and rc:
            raise boatd.Fail(500, "incus_failed", "refused")
        return p

    def _sh(self, args, timeout=20):
        self.sh_calls.append(tuple(args))
        for prefix, ans in self.sh.items():
            if tuple(args[:len(prefix)]) == prefix:
                return ans
        return 0, ""

    def spawn_runner(self, box_id, pid, attempt=1):
        if self.spawn_error:
            return self.spawn_error
        self.spawned.append((box_id, pid, attempt))
        self.active_units.add(boatd.unit_name(box_id, pid, attempt))
        return None


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="boatd-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.saved = {k: getattr(boatd, k) for k in (
            "VAR", "ETC", "CMDS", "DB_PATH", "ADMIT_LOCK", "incus", "_sh", "spawn_runner", "unit_active",
            "ct_running", "_wait_boot", "boot_id", "mem_available", "provision", "log")}
        self.addCleanup(lambda: [setattr(boatd, k, v) for k, v in self.saved.items()])
        boatd.VAR, boatd.ETC = self.tmp / "var", self.tmp / "etc"
        boatd.CMDS, boatd.DB_PATH, boatd.ADMIT_LOCK = boatd.VAR / "cmds", boatd.VAR / "boatd.db", boatd.VAR / "admit.lock"
        boatd.ETC.mkdir(parents=True)
        self.f = Fakes()
        boatd.incus, boatd._sh, boatd.spawn_runner = self.f.incus, self.f._sh, self.f.spawn_runner
        boatd.unit_active = lambda u: u in self.f.active_units
        boatd.ct_running = lambda b: b in self.f.running
        boatd._wait_boot = lambda *a, **k: None
        boatd.boot_id = lambda: "boot-2"
        boatd.log = lambda msg: None
        boatd.load_cfg()
        boatd.READY.clear()
        boatd._HEALTH.update(ts=0.0, v=None)
        boatd._ZPOOL = "offbox/incus"
        boatd.init_db()
        self.con = boatd.db()
        self.addCleanup(self.con.close)

    def box(self, bid="bx_aaaaaaaa", state="ready", owner="ardud", running=True, **kw):
        t = boatd.now()
        self.con.execute("INSERT INTO boxes (id, name, type, state, ttl, last_active, created_at, updated_at, ssh_port, "
                         "source, owner) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                         (bid, kw.get("name", bid), "default", state, 1200, t, t, t, kw.get("port", 22000), "image:x", owner))
        if running:
            self.f.running.add(bid)
        return bid

    def cmd(self, bid, pid=1001, status="running", retry=0, attempt=1, age=120):
        t = boatd.now() - age
        self.con.execute("INSERT INTO commands (box_id, pid, command_id, command, cwd, status, created_at, started_at, "
                         "kind, retry_interrupted, attempt, boot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                         (bid, pid, f"cmd_{pid}", "true", "/home/user", status, t,
                          t if status == "running" else None, "k", retry, attempt, "boot-1"))
        for ext in ("out", "err"):
            (boatd.cmd_dir(bid) / f"{pid}.{ext}").touch()
        return pid

    def status(self, bid, pid):
        return boatd.cmd_row(self.con, bid, pid)

    def state(self, bid):
        return self.con.execute("SELECT * FROM boxes WHERE id=?", (bid,)).fetchone()


class ReconcileRuns(Base):
    def test_unit_still_active_is_followed_and_untouched(self):
        b = self.box()
        p = self.cmd(b)
        self.f.active_units.add(boatd.unit_name(b, p))
        (boatd.cmd_dir(b) / f"{p}.out").write_bytes(b"half the output\n")
        out = boatd.reconcile(self.con)
        self.assertEqual(out["following"], 1)
        self.assertEqual(self.status(b, p)["status"], "running")
        self.assertEqual(self.f.spawned, [])
        self.assertEqual((boatd.cmd_dir(b) / f"{p}.out").read_bytes(), b"half the output\n")

    def test_finished_while_boatd_was_down_gets_its_real_exit_code_and_a_snapshot(self):
        b = self.box()
        p = self.cmd(b)
        boatd.write_json(boatd.result_path(b, p), {"attempt": 1, "status": "exited", "exit_code": 3, "signal": None,
                                                   "started_at": 100.0, "ended_at": 160.0, "boot_id": "boot-2"})
        out = boatd.reconcile(self.con)
        r = self.status(b, p)
        self.assertEqual(out["finalized"], 1)
        self.assertEqual((r["status"], r["exit_code"], r["ended_at"]), ("exited", 3, 160.0))
        snaps = self.con.execute("SELECT kind FROM snaps WHERE box_id=?", (b,)).fetchall()
        self.assertEqual([s["kind"] for s in snaps], ["auto"])
        self.assertEqual(self.f.spawned, [])

    def test_result_of_an_earlier_attempt_is_not_taken_for_this_one(self):
        b = self.box()
        p = self.cmd(b, attempt=2, retry=1)
        boatd.write_json(boatd.result_path(b, p), {"attempt": 1, "status": "exited", "exit_code": 0})
        boatd.reconcile(self.con)
        self.assertEqual(self.status(b, p)["status"], "interrupted")

    def test_unit_gone_no_result_is_interrupted_and_not_retried_by_default(self):
        b = self.box()
        p = self.cmd(b)
        out = boatd.reconcile(self.con)
        r = self.status(b, p)
        self.assertEqual(out["interrupted"], 1)
        self.assertEqual((r["status"], r["exit_code"], r["attempt"]), ("interrupted", None, 1))
        self.assertIsNotNone(r["ended_at"])
        self.assertEqual(self.f.spawned, [])
        self.assertIn("is not run again", (boatd.cmd_dir(b) / f"{p}.err").read_text())

    def test_retry_interrupted_queues_it_again_once_as_the_next_attempt_of_the_same_run(self):
        b = self.box(running=False)          # the host restarted: the container is down too
        p = self.cmd(b, retry=1)
        (boatd.cmd_dir(b) / f"{p}.out").write_bytes(b"attempt one output\n")
        out = boatd.reconcile(self.con)
        r = self.status(b, p)
        self.assertEqual(out["retry"], 1)
        self.assertEqual((r["status"], r["attempt"], r["started_at"], r["command_id"]), ("queued", 2, None, f"cmd_{p}"))
        self.assertEqual(self.f.spawned, [(b, p, 2)])
        self.assertIn(b, self.f.running, "its box was started before the runner")
        self.assertEqual((boatd.cmd_dir(b) / f"{p}.out").read_bytes(), b"attempt one output\n", "output kept")
        self.assertIn("queued again as attempt 2", (boatd.cmd_dir(b) / f"{p}.err").read_text())

    def test_a_run_already_retried_once_stays_interrupted(self):
        b = self.box()
        p = self.cmd(b, retry=1, attempt=2)
        out = boatd.reconcile(self.con)
        self.assertEqual(out["interrupted"], 1)
        self.assertEqual(self.status(b, p)["status"], "interrupted")
        self.assertEqual(self.f.spawned, [])

    def test_a_run_waiting_for_admission_is_still_queued_and_gets_a_runner_again(self):
        b = self.box(running=False)
        p = self.cmd(b, status="queued")
        out = boatd.reconcile(self.con)
        r = self.status(b, p)
        self.assertEqual(out["requeue"], 1)
        self.assertEqual((r["status"], r["attempt"]), ("queued", 1), "never started, so not an attempt")
        self.assertEqual(self.f.spawned, [(b, p, 1)])

    def test_queue_order_survives_the_retried_run_goes_before_later_ones(self):
        b = self.box()
        first = self.cmd(b, pid=1001, retry=1, age=300)
        second = self.cmd(b, pid=1002, status="queued", age=200)
        boatd.reconcile(self.con)
        self.assertEqual(self.f.spawned, [(b, first, 2), (b, second, 1)])
        head = self.con.execute("SELECT pid FROM commands WHERE status='queued' ORDER BY created_at, box_id, pid").fetchone()
        self.assertEqual(head["pid"], first)

    def test_a_run_that_was_being_killed_is_not_retried(self):
        b = self.box()
        p = self.cmd(b, retry=1)
        (boatd.cmd_dir(b) / f"{p}.kill").write_text("kill")
        out = boatd.reconcile(self.con)
        r = self.status(b, p)
        self.assertEqual(out["killed"], 1)
        self.assertEqual((r["status"], r["signal"]), ("exited", "SIGTERM"))
        self.assertEqual(self.f.spawned, [])

    def test_runs_of_a_box_that_does_not_come_back_are_dropped_not_left_queued(self):
        b = self.box(running=False)
        self.f.start_fails.add(b)
        p = self.cmd(b, retry=1)
        out = boatd.reconcile(self.con)
        self.assertEqual(out["boxes_failed"], 1)
        self.assertEqual(self.status(b, p)["status"], "interrupted")
        self.assertEqual(self.state(b)["state"], "archived")
        self.assertEqual(self.f.spawned, [])

    def test_runner_that_cannot_be_spawned_ends_the_run_instead_of_blocking_the_queue(self):
        b = self.box()
        p = self.cmd(b, status="queued")
        self.f.spawn_error = "systemd-run: no"
        boatd.reconcile(self.con)
        self.assertEqual(self.status(b, p)["status"], "interrupted")

    def test_reconcile_twice_changes_nothing_more(self):
        b = self.box(running=False)
        p = self.cmd(b, retry=1)
        boatd.reconcile(self.con)
        out = boatd.reconcile(self.con)
        self.assertEqual((out["retry"], out["following"]), (0, 1))
        self.assertEqual(self.status(b, p)["attempt"], 2)
        self.assertEqual(len(self.f.spawned), 1)

    def test_reaper_applies_the_same_rules_while_boatd_runs(self):
        b = self.box()
        p = self.cmd(b, retry=1)
        boatd.reap_once(self.con)
        self.assertEqual((self.status(b, p)["status"], self.status(b, p)["attempt"]), ("queued", 2))
        self.assertEqual(self.f.spawned, [(b, p, 2)])
        boatd.reap_once(self.con)
        self.assertEqual(len(self.f.spawned), 1, "the new unit is followed, not spawned again")


class ReconcileBoxes(Base):
    def test_live_boxes_are_started_stopped_stay_stopped(self):
        live = self.box("bx_live0000", running=False, port=22000)
        stopped = self.box("bx_stop0000", state="archived", running=False, port=22001)
        out = boatd.reconcile(self.con)
        self.assertEqual(out["boxes_started"], 1)
        self.assertIn(live, self.f.running)
        self.assertNotIn(stopped, self.f.running)
        self.assertEqual(self.state(live)["state"], "ready")
        self.assertEqual(self.state(stopped)["state"], "archived")
        self.assertFalse([c for c in self.f.calls if c[:2] == ("start", "bx-stop0000")])

    def test_a_new_box_clears_sshds_start_limit_before_restarting_it(self):
        # The base image has no host keys: sshd fails at first boot until systemd refuses to start it again.
        b = self.box()
        boatd._fresh_identity(b)
        cmd = [c for c in self.f.calls if c[:1] == ("exec",)][-1][-1]
        self.assertLess(cmd.index("ssh-keygen -A"), cmd.index("systemctl reset-failed ssh.service ssh.socket"))
        self.assertLess(cmd.index("systemctl reset-failed"), cmd.index("systemctl restart ssh"))

    def test_a_box_caught_resuming_is_brought_up(self):
        b = self.box(state="resuming", running=False)
        boatd.reconcile(self.con)
        self.assertEqual(self.state(b)["state"], "ready")
        self.assertIn(b, self.f.running)

    def test_half_created_box_is_removed_and_reported_as_an_error(self):
        b = self.box(state="provisioning", running=False)
        out = boatd.reconcile(self.con)
        self.assertIn(("delete", "bx-aaaaaaaa", "--force"), self.f.calls)
        self.assertEqual(self.state(b)["state"], "error")
        self.assertIn("interrupted by a server restart", self.state(b)["error"])
        self.assertIn(f"half-created box {b}", out["cleaned"])

    def test_a_stop_cut_short_is_finished_with_its_snapshot(self):
        b = self.box(state="stopping")
        boatd.reconcile(self.con)
        self.assertEqual(self.state(b)["state"], "archived")
        self.assertNotIn(b, self.f.running)
        self.assertEqual([s["kind"] for s in self.con.execute("SELECT kind FROM snaps WHERE box_id=?", (b,))], ["stop"])

    def test_half_made_saved_state_is_removed_and_the_previous_copy_kept(self):
        self.con.execute("INSERT INTO saved (owner, name, instance, status, pending_instance) VALUES "
                         "('ardud','warm','sv-old','pending','sv-new'), ('ardud','first',NULL,'pending','sv-first')")
        boatd.reconcile(self.con)
        rows = {r["name"]: r for r in self.con.execute("SELECT * FROM saved")}
        self.assertEqual((rows["warm"]["status"], rows["warm"]["instance"], rows["warm"]["pending_instance"]),
                         ("ready", "sv-old", None))
        self.assertEqual(rows["first"]["status"], "failed")
        deleted = [c[1] for c in self.f.calls if c[:1] == ("delete",)]
        self.assertEqual(sorted(deleted), ["sv-first", "sv-new"])
        self.assertNotIn("sv-old", deleted)

    def test_snapshot_records_follow_what_exists_adopt_and_drop_never_delete(self):
        b = self.box()
        self.con.execute("INSERT INTO snaps VALUES (?,?,?,?)", (b, "auto-ghost", "auto", 1.0))
        self.f.snapshots["bx-aaaaaaaa"] = [{"name": "auto-20261112T000000000", "created_at": "2026-11-12T00:00:00Z"}]
        boatd.reconcile(self.con)
        names = [r["name"] for r in self.con.execute("SELECT name FROM snaps WHERE box_id=?", (b,))]
        self.assertEqual(names, ["auto-20261112T000000000"])
        self.assertFalse([c for c in self.f.calls if c[:2] == ("snapshot", "delete")])


class Queue(Base):
    def admit_now(self, bid, pid):
        """One admission round for a queued run: True if it was let in."""
        done = {}

        def go():
            c2 = boatd.db()
            try:
                boatd.admit(c2, bid, pid, "k", open(os.devnull, "wb"))
                done["ok"] = True
            finally:
                c2.close()
        th = threading.Thread(target=go, daemon=True)
        th.start()
        th.join(1.0)
        if th.is_alive():
            (boatd.cmd_dir(bid) / f"{pid}.kill").write_text("kill")   # lets the waiting loop return
            th.join(5)
            (boatd.cmd_dir(bid) / f"{pid}.kill").unlink()
            return False
        return True

    def test_oldest_queued_run_is_admitted_first(self):
        boatd.mem_available = lambda: 500 * 2**30
        b = self.box()
        old = self.cmd(b, pid=1001, status="queued", age=100)
        new = self.cmd(b, pid=1002, status="queued", age=50)
        self.assertFalse(self.admit_now(b, new), "a later run waits behind an earlier one")
        self.assertEqual(self.status(b, new)["status"], "queued")
        self.assertTrue(self.admit_now(b, old))
        r = self.status(b, old)
        self.assertEqual((r["status"], r["boot_id"]), ("running", "boot-2"))
        self.assertTrue(self.admit_now(b, new))

    def test_max_running_holds_the_queue(self):
        boatd.mem_available = lambda: 500 * 2**30
        boatd.CFG["max_running"] = 1
        b = self.box()
        self.cmd(b, pid=1001, status="running")
        q = self.cmd(b, pid=1002, status="queued")
        self.assertFalse(self.admit_now(b, q))
        self.con.execute("UPDATE commands SET status='exited' WHERE pid=1001")
        self.assertTrue(self.admit_now(b, q))

    def test_no_memory_no_admission(self):
        boatd.mem_available = lambda: 1 * 2**30
        b = self.box()
        q = self.cmd(b, status="queued")
        self.assertFalse(self.admit_now(b, q))

    def test_retry_interrupted_must_be_asked_for(self):
        b = self.box()
        for body, want in (({"command": "true"}, 0), ({"command": "true", "retry_interrupted": True}, 1),
                           ({"command": "true", "retry_interrupted": "yes"}, 0)):
            out = boatd.start_cmd(self.con, b, body, "ardud")
            self.assertEqual(self.status(b, out["processId"])["retry_interrupted"], want)
            self.assertEqual(out["retryInterrupted"], bool(want))


class Tokens(Base):
    def test_token_is_stored_hashed_and_works_only_for_its_owner(self):
        tok = boatd.token_create(self.con, "moni", label="her mac client")
        self.assertTrue(tok.startswith("obx_"))
        self.assertEqual(boatd.token_auth(self.con, "Bearer " + tok), ("moni", False))
        self.assertIsNone(boatd.token_auth(self.con, "Bearer " + tok + "x"))
        self.assertIsNone(boatd.token_auth(self.con, ""))
        self.con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        for f in boatd.VAR.glob("boatd.db*"):
            self.assertNotIn(tok.encode(), f.read_bytes(), f"{f.name} holds the token in clear")

    def test_unknown_owner_is_refused(self):
        with self.assertRaises(boatd.Fail):
            boatd.token_create(self.con, "stranger")

    def test_revoke_by_id_and_by_owner(self):
        a = boatd.token_create(self.con, "ardud")
        b = boatd.token_create(self.con, "ardud")
        m = boatd.token_create(self.con, "moni")
        tid = self.con.execute("SELECT id FROM tokens WHERE hash=?", (boatd.token_hash(a),)).fetchone()[0]
        self.assertEqual(boatd.token_revoke(self.con, token_id=tid), 1)
        self.assertIsNone(boatd.token_auth(self.con, "Bearer " + a))
        self.assertIsNotNone(boatd.token_auth(self.con, "Bearer " + b))
        self.assertEqual(boatd.token_revoke(self.con, owner="ardud"), 1)
        self.assertIsNone(boatd.token_auth(self.con, "Bearer " + b))
        self.assertIsNotNone(boatd.token_auth(self.con, "Bearer " + m))

    def test_list_never_shows_a_token_or_its_hash(self):
        tok = boatd.token_create(self.con, "ardud")
        text = json.dumps(boatd.token_list(self.con))
        self.assertNotIn(tok, text)
        self.assertNotIn(boatd.token_hash(tok), text)

    def test_the_old_shared_token_becomes_ardud_s_and_the_clear_file_goes(self):
        (boatd.ETC / "token").write_text("old-shared-token\n")
        boatd.init_db()
        self.assertEqual(boatd.token_auth(self.con, "Bearer old-shared-token"), ("ardud", False))
        self.assertFalse((boatd.ETC / "token").exists())
        boatd.init_db()
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM tokens").fetchone()[0], 1)

    def test_first_version_database_migrates_boxes_and_saved_states_to_ardud(self):
        self.con.close()
        for f in boatd.VAR.glob("boatd.db*"):
            f.unlink()
        con = boatd.db()
        con.executescript(boatd.SCHEMA)        # the first version's tables: no owner anywhere
        con.execute("INSERT INTO boxes (id, name, type, state) VALUES ('bx_old00000','x','default','archived')")
        con.execute("INSERT INTO saved VALUES ('warm','sv-1','bx_old00000','default','ready',NULL,5,1.0,'s1')")
        con.close()
        boatd.init_db()
        self.con = boatd.db()
        self.assertEqual(self.con.execute("SELECT owner FROM boxes").fetchone()[0], "ardud")
        r = self.con.execute("SELECT * FROM saved").fetchone()
        self.assertEqual((r["owner"], r["name"], r["instance"], r["status"]), ("ardud", "warm", "sv-1", "ready"))
        boatd.init_db()                        # and again: nothing to do


class Http(Base):
    def setUp(self):
        super().setUp()
        boatd.provision = lambda bid, source, t: None     # the container side is not what this tests
        self.tok = {o: boatd.token_create(self.con, o) for o in ("ardud", "moni")}
        self.tok["admin"] = boatd.token_create(self.con, None, admin=True)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), boatd.Handler)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/api/v1"
        boatd.READY.set()
        self.addCleanup(boatd.READY.clear)

    def call(self, who, method, path, body=None, headers=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        if who:
            h["Authorization"] = "Bearer " + self.tok.get(who, who)
        req = urllib.request.Request(self.url + path, method=method, headers=h,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def make_box(self, who):
        st, d = self.call(who, "POST", "/sandboxes", {"type": "default", "name": f"{who}-box"})
        self.assertEqual(st, 200, d)
        bid = d["sandbox"]["id"]
        self.con.execute("UPDATE boxes SET state='ready' WHERE id=?", (bid,))
        self.f.running.add(bid)
        return bid

    def test_health_needs_no_token_and_carries_no_box_or_owner_data(self):
        self.make_box("moni")
        st, d = self.call(None, "GET", "/health")
        self.assertEqual(st, 200)
        self.assertEqual(sorted(d), ["boatd_uptime_s", "boot_id", "mdraid", "mode", "ok", "pool", "queue", "reasons",
                                     "running", "up", "uptime_s", "version"])
        self.assertNotIn("moni", json.dumps(d))
        self.assertNotIn("bx_", json.dumps(d))

    def test_no_token_bad_token_revoked_token(self):
        self.assertEqual(self.call(None, "GET", "/sandboxes")[0], 401)
        self.assertEqual(self.call("nonsense", "GET", "/sandboxes")[0], 401)
        boatd.token_revoke(self.con, owner="moni")
        self.assertEqual(self.call("moni", "GET", "/sandboxes")[0], 401)

    def test_a_token_sees_and_controls_only_its_owner_s_boxes_everything_else_is_404(self):
        hers = self.make_box("moni")
        his = self.make_box("ardud")
        self.assertEqual([b["id"] for b in self.call("moni", "GET", "/sandboxes")[1]["sandboxes"]], [hers])
        self.assertEqual([b["id"] for b in self.call("ardud", "GET", "/sandboxes")[1]["sandboxes"]], [his])
        self.assertEqual(self.call("moni", "GET", f"/sandboxes/{hers}")[0], 200)
        missing = self.call("ardud", "GET", "/sandboxes/bx_nothere0")
        for method, path, body, headers in (
                ("GET", f"/sandboxes/{hers}", None, None),
                ("PATCH", f"/sandboxes/{hers}", {"pinned": True, "name": "mine now"}, None),
                ("DELETE", f"/sandboxes/{hers}", None, {"X-Ascii-Confirm-Delete": hers}),
                ("POST", f"/sandboxes/{hers}/fork", {}, None),
                ("POST", f"/sandboxes/{hers}/resume", {}, None),
                ("POST", f"/sandboxes/{hers}/stop", {}, None),
                ("POST", f"/sandboxes/{hers}/sshkey", {"key": "ssh-ed25519 AAAA x"}, None),
                ("GET", f"/sandboxes/{hers}/usage", None, None),
                ("GET", f"/sandboxes/{hers}/snapshots", None, None),
                ("GET", f"/sandboxes/{hers}/snapshots/latest", None, None),
                ("POST", f"/sandboxes/{hers}/commands", {"command": "cat ~/person/secrets/*", "detached": True}, None),
                ("GET", f"/sandboxes/{hers}/commands/1001", None, None),
                ("DELETE", f"/sandboxes/{hers}/commands/1001", None, None),
                ("GET", f"/sandboxes/{hers}/commands/1001/stream", None, None),
                ("GET", f"/sandboxes/{hers}/command-history/cmd_x/logs", None, None),
                ("POST", "/saved-snapshots", {"name": "copy", "sandboxId": hers}, None)):
            st, d = self.call("ardud", method, path, body, headers)
            self.assertEqual((st, d.get("code")), (404, "sandbox_not_found"), f"{method} {path}")
            self.assertEqual(d.get("code"), missing[1].get("code"), "same answer as a box that does not exist")
        r = self.state(hers)
        self.assertEqual((r["state"], r["pinned"], r["name"], r["deleted_at"]), ("ready", 0, "moni-box", None))
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM commands").fetchone()[0], 0)
        self.assertEqual(self.f.spawned, [])

    def test_runs_and_their_output_are_the_owner_s_only(self):
        hers = self.make_box("moni")
        st, d = self.call("moni", "POST", f"/sandboxes/{hers}/commands", {"command": "true", "detached": True})
        self.assertEqual(st, 200, d)
        pid, cid = d["processId"], d["commandId"]
        (boatd.cmd_dir(hers) / f"{pid}.out").write_text("her output")
        self.assertEqual(self.call("moni", "GET", f"/sandboxes/{hers}/commands/{pid}")[1]["stdout"], "her output")
        self.assertEqual(self.call("ardud", "GET", f"/sandboxes/{hers}/commands/{pid}")[0], 404)
        self.assertEqual(self.call("ardud", "GET", f"/sandboxes/{hers}/command-history/{cid}/logs")[0], 404)

    def test_saved_states_are_per_owner_even_with_the_same_name(self):
        hers, his = self.make_box("moni"), self.make_box("ardud")
        self.assertEqual(self.call("moni", "POST", "/saved-snapshots", {"name": "base", "sandboxId": hers})[0], 200)
        self.assertEqual(self.call("ardud", "GET", "/saved-snapshots/base")[0], 404)
        self.assertEqual(self.call("ardud", "GET", "/saved-snapshots")[1]["snapshots"], [])
        self.assertEqual(self.call("ardud", "DELETE", "/saved-snapshots/base")[0], 404)
        self.assertEqual(self.call("ardud", "POST", "/saved-snapshots", {"name": "base", "sandboxId": his})[0], 200)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM saved WHERE name='base'").fetchone()[0], 2)
        # a box cannot be created from someone else's saved state
        self.con.execute("UPDATE saved SET status='ready', instance='sv-hers' WHERE owner='moni'")
        self.con.execute("DELETE FROM saved WHERE owner='ardud'")
        self.assertEqual(self.call("ardud", "POST", "/sandboxes", {"from": "base"})[0], 404)

    def test_idempotency_keys_do_not_cross_owners(self):
        a = self.call("ardud", "POST", "/sandboxes", {}, {"Idempotency-Key": "k1"})[1]["sandbox"]["id"]
        again = self.call("ardud", "POST", "/sandboxes", {}, {"Idempotency-Key": "k1"})[1]["sandbox"]["id"]
        m = self.call("moni", "POST", "/sandboxes", {}, {"Idempotency-Key": "k1"})[1]["sandbox"]["id"]
        self.assertEqual(a, again)
        self.assertNotEqual(a, m)
        self.assertEqual(self.state(m)["owner"], "moni")

    def test_stats_and_limits_are_scoped_admin_sees_all_and_only_admin_paths(self):
        hers, his = self.make_box("moni"), self.make_box("ardud")
        for bid, kind in ((hers, "her-kind"), (his, "his-kind")):
            self.con.execute("INSERT INTO commands (box_id, pid, status, ended_at, kind, metrics) VALUES (?,?,?,?,?,?)",
                             (bid, 1, "exited", boatd.now(), kind, json.dumps({"wall_s": 5})))
        mine = self.call("ardud", "GET", "/stats")[1]
        self.assertEqual([k["kind"] for k in mine["kinds"]], ["- his-kind"])
        self.assertEqual(mine["runs"], 1)
        self.assertEqual(self.call("moni", "GET", "/limits")[1]["activeSandboxes"], 1)
        st, allk = self.call("admin", "GET", "/admin/stats")
        self.assertEqual(st, 200)
        self.assertEqual(sorted(k["kind"] for k in allk["kinds"]), ["- her-kind", "- his-kind"])
        self.assertEqual(len(self.call("admin", "GET", "/admin/boxes")[1]["sandboxes"]), 2)
        self.assertEqual(self.call("ardud", "GET", "/admin/stats")[0], 404)
        self.assertEqual(self.call("ardud", "GET", "/admin/tokens")[0], 404)
        self.assertEqual(self.call("admin", "GET", "/sandboxes")[0], 403)
        self.assertEqual(self.call("admin", "GET", f"/sandboxes/{hers}")[0], 403)

    def test_admin_token_management_over_the_api(self):
        st, d = self.call("admin", "POST", "/admin/tokens", {"owner": "moni", "label": "second"})
        self.assertEqual(st, 200)
        self.assertEqual(self.call(d["token"], "GET", "/sandboxes")[0], 200)
        toks = self.call("admin", "GET", "/admin/tokens")[1]["tokens"]
        self.assertNotIn(d["token"], json.dumps(toks))
        tid = [t["id"] for t in toks if t["label"] == "second"][0]
        self.assertEqual(self.call("admin", "DELETE", f"/admin/tokens/{tid}")[1]["revoked"], 1)
        self.assertEqual(self.call(d["token"], "GET", "/sandboxes")[0], 401)

    def test_until_reconcile_is_done_only_health_answers(self):
        boatd.READY.clear()
        boatd.STATE["problem"] = "reconciling runs and boxes after start"
        st, d = self.call("ardud", "GET", "/sandboxes")
        self.assertEqual((st, d["code"]), (503, "server_not_ready"))
        st, h = self.call(None, "GET", "/health")
        self.assertEqual((st, h["ok"], h["mode"]), (200, False, "degraded"))
        self.assertIn("reconciling", " ".join(h["reasons"]))

    def test_stream_says_which_attempt_and_ends_an_interrupted_run_as_interrupted(self):
        b = self.make_box("ardud")
        p = self.cmd(b, status="running")
        (boatd.cmd_dir(b) / f"{p}.out").write_text("before the cut\n")
        boatd.reconcile(self.con)
        req = urllib.request.Request(self.url + f"/sandboxes/{b}/commands/{p}/stream?stdoutOffset=7",
                                     headers={"Authorization": "Bearer " + self.tok["ardud"]})
        with urllib.request.urlopen(req, timeout=10) as r:
            frames = [json.loads(line) for line in r.read().decode().splitlines() if line.strip()]
        self.assertEqual(frames[0]["type"], "hello")
        self.assertEqual((frames[0]["attempt"], frames[0]["bootId"]), (1, "boot-2"))
        out = "".join(f["data"] for f in frames if f["type"] == "stdout")
        self.assertEqual(out, "the cut\n", "resumes from the byte offset it was given")
        self.assertEqual((frames[-1]["type"], frames[-1]["status"], frames[-1]["exitCode"]), ("exit", "interrupted", None))


class HealthAndDegraded(Base):
    MD_OK = """Personalities : [raid1]
md1 : active raid1 nvme1n1p3[1] nvme0n1p3[0]
      157153280 blocks super 1.2 [2/2] [UU]

md0 : active raid1 nvme1n1p2[1] nvme0n1p2[0]
      2094080 blocks super 1.0 [2/2] [UU]

unused devices: <none>
"""

    def test_mdraid_states(self):
        self.assertEqual(boatd.mdraid_state(self.MD_OK), {"state": "ok", "arrays": {"md1": "[UU]", "md0": "[UU]"}})
        one = self.MD_OK.replace("[2/2] [UU]", "[2/1] [U_]", 1)
        self.assertEqual(boatd.mdraid_state(one)["state"], "degraded")
        self.assertEqual(boatd.mdraid_state(one)["arrays"]["md1"], "[U_]")
        self.assertEqual(boatd.mdraid_state("Personalities : \nunused devices: <none>\n"), {"state": "none", "arrays": {}})

    def test_healthy(self):
        self.f.sh[("zpool", "list")] = (0, "ONLINE")
        boatd.READY.set()
        b = self.box()
        self.cmd(b, pid=1, status="queued")
        self.cmd(b, pid=2, status="running")
        h = boatd.health(fresh=True)
        self.assertEqual((h["ok"], h["mode"], h["reasons"], h["pool"]), (True, "ok", [], {"name": "offbox", "state": "ONLINE"}))
        self.assertEqual((h["queue"], h["running"], h["boot_id"], h["version"]), (1, 1, "boot-2", boatd.VERSION))

    def test_degraded_mirror_still_serves_and_says_why(self):
        self.f.sh[("zpool", "list")] = (0, "DEGRADED")
        boatd.READY.set()
        h = boatd.health(fresh=True)
        self.assertEqual((h["ok"], h["mode"]), (True, "degraded"))
        self.assertEqual(h["reasons"], ["pool offbox is DEGRADED"])

    def test_pool_missing_is_a_clear_degraded_mode_not_a_crash(self):
        boatd.CFG["state_dataset"] = "offbox/boatd"
        self.f.sh[("zpool", "list")] = (1, "")
        self.f.sh[("zfs", "get")] = (1, "")
        prob = boatd.state_problem()
        self.assertEqual(prob, "state dataset offbox/boatd not found (pool offbox is MISSING)")
        boatd.STATE["problem"] = prob
        h = boatd.health(fresh=True)
        self.assertEqual((h["ok"], h["up"], h["mode"], h["queue"]), (False, True, "degraded", None))
        self.assertEqual(h["reasons"], [prob, "pool offbox is MISSING"])

    def test_state_is_only_accepted_on_its_dataset_mounted_in_place(self):
        boatd.CFG["state_dataset"] = "offbox/boatd"
        self.f.sh[("zfs", "get")] = (0, "no\t" + str(boatd.VAR))
        self.assertIn("is not mounted", boatd.state_problem())
        self.f.sh[("zfs", "get")] = (0, "yes\t/somewhere/else")
        self.assertIn("expected", boatd.state_problem())
        self.f.sh[("zfs", "get")] = (0, "yes\t" + str(boatd.VAR))
        self.assertIsNone(boatd.state_problem())
        boatd.CFG["state_dataset"] = ""
        self.assertIsNone(boatd.state_problem(), "no dataset configured (tests, a dev box): the directory is used as is")

    def test_incus_down_means_runs_cannot_be_accepted(self):
        self.f.sh[("zpool", "list")] = (0, "ONLINE")
        self.f.sh[("incus", "query")] = (1, "")
        boatd.READY.set()
        h = boatd.health(fresh=True)
        self.assertEqual((h["ok"], h["reasons"]), (False, ["incus is not answering"]))

    def test_startup_waits_for_the_pool_then_reconciles_then_opens(self):
        boatd.CFG["state_dataset"] = "offbox/boatd"
        answers = [(1, ""), (0, "yes\t" + str(boatd.VAR))]
        self.f.sh[("zpool", "list")] = (1, "")
        seen = []
        real_sh = self.f._sh

        def sh(args, timeout=20):
            if tuple(args[:2]) == ("zfs", "get"):
                return answers.pop(0) if len(answers) > 1 else answers[0]
            if tuple(args[:2]) == ("zpool", "import"):
                seen.append("import")
                return 0, ""
            return real_sh(args, timeout)
        boatd._sh = sh
        b = self.box(running=False)
        p = self.cmd(b, retry=1)
        slept = []
        real_sleep, real_thread = boatd.time.sleep, boatd.threading.Thread
        boatd.time.sleep = lambda s: slept.append(s)
        started = []

        class NoThread:
            def __init__(self, target=None, args=(), daemon=None):
                self.target, self.args = target, args

            def start(self):
                # reconcile's container starts run inline; the reaper and sampler loops are only recorded
                if self.target is boatd.loop:
                    started.append(self.args[2])
                else:
                    self.target(*self.args)

            def join(self, timeout=None):
                pass
        boatd.threading.Thread = NoThread
        try:
            boatd.startup()
        finally:
            boatd.time.sleep, boatd.threading.Thread = real_sleep, real_thread
        self.assertEqual(seen, ["import"], "asked for a plain import once while the pool was away")
        self.assertEqual(slept, [10])
        self.assertTrue(boatd.READY.is_set())
        self.assertEqual(boatd.STATE["reconcile"]["retry"], 1)
        self.assertEqual(self.status(b, p)["attempt"], 2)
        self.assertEqual(started, ["reaper", "sampler"])
        boatd.READY.clear()


class Retention(Base):
    def rows(self, spec):
        """spec: [(kind, age_days)] -> rows newest first."""
        t = 2_000_000_000.0
        rows = [{"name": f"{k}-{i}", "kind": k, "created_at": t - age * 86400} for i, (k, age) in enumerate(spec)]
        return sorted(rows, key=lambda r: -r["created_at"]), t

    def test_run_snapshots_keep_newest_20_plus_one_per_day_for_14_days(self):
        spec = [("auto", i * 0.01) for i in range(30)] + [("stop", d + 0.5) for d in range(1, 20)]
        rows, t = self.rows(spec)
        gone = set(boatd.snaps_to_prune(rows, boatd.RETENTION, t))
        kept = [r for r in rows if r["name"] not in gone]
        self.assertEqual(len([r for r in kept if r["kind"] == "auto"]), 20)
        self.assertEqual(len([r for r in kept if r["kind"] == "stop"]), 13, "one per day inside 14 days")

    def test_timer_snapshots_keep_their_own_counts_and_do_not_evict_run_snapshots(self):
        spec = [("hourly", i / 24) for i in range(60)] + [("daily", i) for i in range(40)] + \
               [("weekly", i * 7) for i in range(20)] + [("auto", 0.001), ("manual", 400)]
        rows, t = self.rows(spec)
        gone = set(boatd.snaps_to_prune(rows, boatd.RETENTION, t))
        kept = [r for r in rows if r["name"] not in gone]
        count = {k: len([r for r in kept if r["kind"] == k]) for k in ("hourly", "daily", "weekly", "auto", "manual")}
        self.assertEqual(count, {"hourly": 48, "daily": 30, "weekly": 12, "auto": 1, "manual": 1})
        oldest_hourly = max(r["created_at"] for r in rows if r["name"] in gone and r["kind"] == "hourly")
        newest_kept = min(r["created_at"] for r in kept if r["kind"] == "hourly")
        self.assertLess(oldest_hourly, newest_kept, "the oldest go first")

    def test_config_can_change_retention_in_one_place(self):
        (boatd.ETC / "config.json").write_text(json.dumps({"retention": {"person_hourly": 5}}))
        boatd.load_cfg()
        self.assertEqual(boatd.CFG["retention"]["person_hourly"], 5)
        self.assertEqual(boatd.CFG["retention"]["person_daily"], boatd.RETENTION["person_daily"])

    def test_rotate_snapshots_person_boxes_only_and_skips_unchanged_ones(self):
        hers = self.box("bx_hers0000", owner="moni", state="archived", running=False, port=22000)
        his = self.box("bx_his00000", owner="ardud", port=22001)
        out = boatd.snap_rotate(self.con, "hourly")
        self.assertEqual(out["snapshotted"], [hers])
        self.assertFalse(self.con.execute("SELECT 1 FROM snaps WHERE box_id=?", (his,)).fetchone())
        self.f.sh[("zfs", "get")] = (0, "0")                      # nothing written since that snapshot
        self.assertEqual(boatd.snap_rotate(self.con, "hourly"), {"kind": "hourly", "snapshotted": [], "unchanged": [hers]})
        self.f.sh[("zfs", "get")] = (0, "4096")
        time.sleep(0.01)                                          # snapshot names carry the time to the millisecond
        self.assertEqual(boatd.snap_rotate(self.con, "hourly")["snapshotted"], [hers])
        self.assertEqual(boatd.snap_rotate(self.con, "daily")["snapshotted"], [hers], "each kind has its own history")
        kinds = sorted(r["kind"] for r in self.con.execute("SELECT kind FROM snaps WHERE box_id=?", (hers,)))
        self.assertEqual(kinds, ["daily", "hourly", "hourly"])
        with self.assertRaises(boatd.Fail):
            boatd.snap_rotate(self.con, "yearly")


if __name__ == "__main__":
    unittest.main()
