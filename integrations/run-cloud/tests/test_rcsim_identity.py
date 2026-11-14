"""rcsim identity: owner = the resolved Robob execution, never the shared native session.

Checks: an unresolved caller is refused before any Run Cloud API call; --mine matches the exact owner; a UUID's
liveness goes through the identity map and never through OpenCode's 404. The Robob control API is a stub on a
real HTTP socket; the Run Cloud CLI is a recording fake, so "no API call" is provable.
"""
import contextlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import call, patch
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(ROOT))
import rcsim  # noqa: E402

PARENT = "thread-parent"
CHILD = "thread-child"
CLAUDE_UUID = "11111111-2222-3333-4444-555555555555"
CODEX_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa"


class StubControl:
    def __init__(self):
        self.identities = {}
        self.threads = {
            PARENT: {"threadId": PARENT, "title": "Parent", "parentThreadId": None, "relationshipToParent": None},
            CHILD: {"threadId": CHILD, "title": "Child", "parentThreadId": PARENT, "relationshipToParent": "subagent"},
        }
        self.calls = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                url = urlparse(self.path)
                stub.calls.append(("GET", url.path))
                if self.headers.get("Authorization") != "Bearer test-token":
                    return self._send(401, {"ok": False})
                if url.path == "/api/ardud/control/identity/resolve":
                    q = parse_qs(url.query)
                    key = (q.get("nativeId", [""])[0], q.get("driver", [""])[0])
                    ident = stub.identities.get(key) or {
                        "resolution": "unavailable", "robobThreadId": None, "parentThreadId": None,
                        "executionKind": None, "acceptsMessages": False, "candidates": []}
                    return self._send(200, {"ok": True, "identity": ident})
                if url.path.startswith("/api/ardud/control/threads/"):
                    tid = url.path.rsplit("/", 1)[1]
                    if tid in stub.threads:
                        return self._send(200, {"ok": True, "thread": stub.threads[tid]})
                    return self._send(404, {"ok": False})
                return self._send(404, {"ok": False})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def resolved(thread, parent=None, kind="top-level"):
    return {"resolution": "resolved", "robobThreadId": thread, "parentThreadId": parent,
            "executionKind": kind, "acceptsMessages": True, "candidates": []}


class RcsimIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.stub = StubControl()
        self.addCleanup(self.stub.close)
        cfg = root / "rcsim.json"
        cfg.write_text(json.dumps({"url": self.stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        # A fake Run Cloud CLI that records every call. Nothing else in these tests may reach it.
        self.api_log = root / "runcloud.calls"
        fake = root / "runcloud"
        fake.write_text("#!/bin/sh\necho \"$@\" >> " + str(self.api_log) + "\necho '{}'\n")
        fake.chmod(0o755)
        self.patches = [
            patch.object(rcsim.time, "sleep"),
            patch.object(rcsim, "STATE_DIR", root / "state"),
            patch.object(rcsim, "DB_PATH", root / "state" / "rcsim.db"),
            patch.object(rcsim, "CTL_CFGS", (cfg, root / "none.json")),
            patch.object(rcsim, "RUNCLOUD", str(fake)),
            patch.object(rcsim, "OC_PW", root / "no-password"),
            patch.object(rcsim, "LOG_PATH", root / "state" / "monitor.log"),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.log_root = root / "logs"
        self.env = patch.dict(os.environ, {"TOOLLOG_ROOT": str(self.log_root)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def api_calls(self):
        return self.api_log.read_text().splitlines() if self.api_log.exists() else []

    def shell(self, **env):
        return patch.dict(os.environ, {"TOOLLOG_ROOT": str(self.log_root), **env}, clear=True)

    def create_args(self, **overrides):
        return SimpleNamespace(**{"thread": None, "manager": None, "platform": "ios", "name": None,
                                  "purpose": None, "model": None, "region": None, "hard_timeout": "45m",
                                  "inactivity_timeout": "none", "install": None, "install_asset": None,
                                  "json": False, **overrides})

    def fake_ctl(self, answers):
        answers = iter(answers)

        def lookup(method, path, **kwargs):
            if path.startswith(("/identity/resolve", "/threads/by-native/")):
                return next(answers)
            tid = path.rsplit("/", 1)[-1]
            return (200, {"thread": self.stub.threads[tid]}) if tid in self.stub.threads else (404, {})

        return patch.object(rcsim, "ctl", side_effect=lookup)

    def assert_refused(self, command, args, code, *messages):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.object(rcsim, "rc") as run_cloud:
            with self.assertRaises(SystemExit) as refused:
                command(args)
        self.assertEqual(refused.exception.code, code)
        for message in messages:
            self.assertIn(message, stderr.getvalue())
        run_cloud.assert_not_called()

    def identity_calls(self, ctl):
        return [c for c in ctl.call_args_list
                if c.args[1].startswith(("/identity/resolve", "/threads/by-native/"))]

    def log_events(self):
        return [json.loads(line) for path in self.log_root.rglob("*.ndjson")
                for line in path.read_text().splitlines() if json.loads(line)["name"].startswith("identity.")]

    def test_opencode_unreachable_retries_then_refuses_create(self):
        with self.shell(OPENCODE_SESSION_ID="ses_test"), self.fake_ctl([(0, {"error": "timed out"})] * 4) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(), 3, "control API (127.0.0.1:3773)",
                                "server problem, not your session mapping", "Nothing was changed")
        self.assertEqual(len(self.identity_calls(ctl)), 4)
        self.assertEqual(rcsim.time.sleep.call_args_list, [call(5), call(10), call(20)])

    def test_opencode_recovers_and_creates_for_resolved_thread(self):
        answers = [(0, {"error": "timed out"}), (200, {"thread": self.stub.threads[CHILD]})]
        with self.shell(OPENCODE_SESSION_ID="ses_test"), self.fake_ctl(answers) as ctl, \
                patch.object(rcsim, "rc", return_value=(0, {"id": "sim-new"}, "", "")), \
                contextlib.redirect_stdout(io.StringIO()):
            rcsim.cmd_create(self.create_args())
        con = rcsim.db()
        self.addCleanup(con.close)
        self.assertEqual(rcsim.get_row(con, "sim-new")["owner_thread"], CHILD)
        self.assertEqual(len(self.identity_calls(ctl)), 2)
        self.assertEqual(rcsim.time.sleep.call_args_list, [call(5)])

    def test_opencode_not_mapped_is_not_retried(self):
        with self.shell(OPENCODE_SESSION_ID="ses_test"), self.fake_ctl([(404, {})]) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(), 2, "not-mapped", "isn't mapped")
        self.assertEqual(len(self.identity_calls(ctl)), 1)
        rcsim.time.sleep.assert_not_called()

    def test_explicit_thread_does_not_bypass_unreachable_identity(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), self.fake_ctl([(0, {"error": "offline"})] * 4) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(thread=PARENT), 3, "control API")
        self.assertEqual(len(self.identity_calls(ctl)), 4)

    def test_whoami_unreachable_answers_without_retry(self):
        for env in ({"OPENCODE_SESSION_ID": "ses_test"}, {"CODEX_THREAD_ID": CODEX_UUID}):
            with self.subTest(env=env), self.shell(**env), self.fake_ctl([(0, {"error": "offline"})]) as ctl, \
                    contextlib.redirect_stdout(io.StringIO()) as stdout:
                rcsim.cmd_whoami(SimpleNamespace(thread=None))
            me = json.loads(stdout.getvalue())
            self.assertEqual(me["resolution"], "unavailable")
            self.assertEqual(me["reason"], "control-api-unreachable")
            self.assertEqual(me["detail"], "offline")
            self.assertEqual(len(self.identity_calls(ctl)), 1)
        rcsim.time.sleep.assert_not_called()

    def test_codex_unreachable_retries_then_refuses_create(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), self.fake_ctl([(0, {"error": "offline"})] * 4) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(), 3, "control API")
        self.assertEqual(len(self.identity_calls(ctl)), 4)

    def test_codex_release_by_id_recovers_pending_identity(self):
        con = self._seed_shared_session_sims()
        self.addCleanup(con.close)
        answers = [(200, {"identity": {"resolution": "unavailable"}})] * 2 + [(200, {"identity": resolved(CHILD)})]
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), self.fake_ctl(answers) as ctl, \
                patch.object(rcsim, "rc", return_value=(0, {"status": "deleted"}, "", "")) as run_cloud, \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as done:
            rcsim.cmd_release(SimpleNamespace(thread=None, mine=False, ids=["sim-child-a"]))
        self.assertEqual(done.exception.code, 0)
        row = rcsim.get_row(con, "sim-child-a")
        self.assertEqual(row["state"], "released")
        self.assertEqual(row["release_reason"], f"released by {CHILD}")
        run_cloud.assert_called_once_with(["ios", "delete", "sim-child-a", "--json"], timeout=120)
        self.assertEqual(len(self.identity_calls(ctl)), 3)

    def test_codex_heartbeat_by_id_pending_refuses_with_billing_message(self):
        for resolution in ("unavailable", "pending"):
            with self.subTest(resolution=resolution), self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                    self.fake_ctl([(200, {"identity": {"resolution": resolution}})] * 4) as ctl:
                self.assert_refused(rcsim.cmd_heartbeat, SimpleNamespace(thread=None, ids=["sim-child-a"]), 3,
                                    "hasn't mapped", "after ~35 s of retries", "simulator keeps billing")
            self.assertEqual(len(self.identity_calls(ctl)), 4)
        self.assertTrue(all(e["props"]["reason"] == "identity-pending" for e in self.log_events()))

    def test_codex_ambiguous_identity_is_not_retried(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                self.fake_ctl([(200, {"identity": {"resolution": "ambiguous"}})]) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(), 2, "resolution=ambiguous")
        self.assertEqual(len(self.identity_calls(ctl)), 1)
        rcsim.time.sleep.assert_not_called()

    def test_identity_logs_have_attempts_status_and_no_credentials(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                self.fake_ctl([(0, {"error": "Bearer test-token http://secret@host/path"})] * 4):
            self.assert_refused(rcsim.cmd_create, self.create_args(), 3, "control API")
        events = self.log_events()
        lookups = [e for e in events if e["name"] == "identity.resolve"]
        self.assertEqual(len(lookups), 4)
        for attempt, e in enumerate(lookups, 1):
            self.assertEqual(e["kind"], "error")
            self.assertGreaterEqual(e["durationMs"], 0)
            self.assertEqual(e["props"], {"driver": "codex", "route": "identity", "httpStatus": 0,
                                        "resolution": "unavailable", "reason": "control-api-unreachable",
                                        "attempt": attempt, "command": "create"})
            self.assertEqual(e["error"]["tag"], "control-api-unreachable")
        refusals = [e for e in events if e["name"] == "identity.refused"]
        self.assertEqual(len(refusals), 1)
        self.assertEqual(refusals[0]["props"], {"command": "create", "resolution": "unavailable",
                                              "reason": "control-api-unreachable", "attempts": 4,
                                              "exitCode": 3, "waitedMs": 35000})
        # httpStatus is required metadata; URLs and bearer values must never reach the events.
        serialized = json.dumps(events)
        self.assertNotIn("test-token", serialized)
        self.assertNotIn("http://", serialized)
        self.assertNotIn("Bearer", serialized)

    def test_identity_lookups_use_eight_second_timeout(self):
        for env in ({"OPENCODE_SESSION_ID": "ses_test"}, {"CODEX_THREAD_ID": CODEX_UUID}):
            with self.subTest(env=env), self.shell(**env), self.fake_ctl([(0, {"error": "offline"})]) as ctl:
                rcsim.whoami()
            self.assertEqual(self.identity_calls(ctl)[0].kwargs, {"timeout": 8})

    def test_all_identity_guarded_commands_retry_before_mutation(self):
        con = self._seed_shared_session_sims()
        self.addCleanup(con.close)
        before = self._snapshot_db(con)
        cases = [
            (rcsim.cmd_create, self.create_args()),
            (rcsim.cmd_launch, self.create_args(build="b1", asset=None, idempotency_key="test-key")),
            (rcsim.cmd_claim, self._claim_args(["sim-child-a"])),
            (rcsim.cmd_release, SimpleNamespace(thread=None, mine=True, ids=[])),
            (rcsim.cmd_release, SimpleNamespace(thread=None, mine=False, ids=["sim-child-a"])),
            (rcsim.cmd_heartbeat, SimpleNamespace(thread=None, ids=["sim-child-a"])),
            (rcsim.cmd_handoff, SimpleNamespace(thread=None, id="sim-child-a", to=PARENT, note=None)),
        ]
        for command, args in cases:
            with self.subTest(command=command.__name__, args=args), self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                    self.fake_ctl([(0, {"error": "offline"})] * 4) as ctl, \
                    patch.object(rcsim, "thread_send") as send:
                self.assert_refused(command, args, 3, "control API")
            self.assertEqual(len(self.identity_calls(ctl)), 4)
            self.assertEqual(self._snapshot_db(con), before)
            send.assert_not_called()

    def test_http_failures_retry_only_outages_for_both_routes(self):
        for env in ({"OPENCODE_SESSION_ID": "ses_test"}, {"CODEX_THREAD_ID": CODEX_UUID}):
            for status, attempts, exit_code in ((0, 4, 3), (500, 4, 3), (503, 4, 3),
                                                (404, 1, 2), (401, 1, 2), (403, 1, 2)):
                with self.subTest(env=env, status=status), self.shell(**env), \
                        self.fake_ctl([(status, {"error": "offline"})] * attempts) as ctl:
                    self.assert_refused(rcsim.cmd_create, self.create_args(), exit_code)
                self.assertEqual(len(self.identity_calls(ctl)), attempts)

    def test_recovered_identity_still_rejects_an_unrelated_explicit_thread(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                self.fake_ctl([(0, {"error": "offline"}), (200, {"identity": resolved(CHILD)})]) as ctl:
            self.assert_refused(rcsim.cmd_create, self.create_args(thread=PARENT), 2,
                                "is not this session's thread or its parent")
        self.assertEqual(len(self.identity_calls(ctl)), 2)

    def test_identity_logs_include_by_native_recovery_without_private_detail(self):
        with self.shell(OPENCODE_SESSION_ID="ses_test"), \
                self.fake_ctl([(503, {"error": "Bearer test-token https://secret@host/path"}),
                               (200, {"thread": self.stub.threads[CHILD]})]):
            me = rcsim.whoami(retry_unavailable=True, command="create")
        self.assertEqual(me["thread"], CHILD)
        events = self.log_events()
        self.assertEqual([e["kind"] for e in events], ["error", "perf"])
        self.assertEqual([e["props"]["attempt"] for e in events], [1, 2])
        self.assertEqual([e["props"]["httpStatus"] for e in events], [503, 200])
        self.assertTrue(all(e["props"]["route"] == "by-native" for e in events))
        self.assertNotIn("detail", json.dumps(events))
        self.assertNotIn("test-token", json.dumps(events))

    def test_identity_logging_failure_does_not_change_resolution_or_refusal(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), self.fake_ctl([(0, {"error": "offline"})] * 4), \
                patch.object(rcsim.toollog, "emit", side_effect=OSError("log unavailable")):
            me = rcsim.whoami(retry_unavailable=True)
            with self.assertRaises(SystemExit) as refused, contextlib.redirect_stderr(io.StringIO()):
                rcsim.refuse_native_unproven(me, "release")
        self.assertEqual(refused.exception.code, 3)

    def test_whoami_detail_redacts_bearer_tokens_and_urls(self):
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                self.fake_ctl([(0, {"error": "timed out Bearer test-token https://user:pass@host/path"})]):
            me = rcsim.whoami()
        self.assertIn("timed out", me["detail"])
        for secret in ("test-token", "user:pass", "https://"):
            self.assertNotIn(secret, me["detail"])

    # --- identity

    def test_claude_shell_has_no_resolved_owner_even_when_c1_answers(self):
        # C1 answers a bare Claude id with the parent's identity, which a native child shares. So a Claude shell
        # never becomes a resolved owner: create, claim and release --mine refuse it.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            me = rcsim.whoami()
        self.assertEqual(me["resolution"], "unresolved")
        self.assertIsNone(me["thread"])
        self.assertEqual(me["driver"], "claudeAgent")

    def test_inherited_rcsim_thread_of_an_unrelated_thread_is_ignored(self):
        # The unrelated-value rule, on a provable Codex caller (a Claude shell has no resolved owner at all).
        other = "thread-unrelated"
        self.stub.threads[other] = {"threadId": other, "title": "Other", "parentThreadId": None,
                                    "relationshipToParent": None}
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CODEX_THREAD_ID=CODEX_UUID, RCSIM_THREAD=other):
            me = rcsim.whoami()
        self.assertEqual(me["thread"], CHILD)

    def test_unresolved_create_is_refused_before_any_run_cloud_call(self):
        # The default stub answer for an unknown id is "unavailable": the create must not reach Run Cloud.
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                patch.object(rcsim, "check_hard", return_value="45m"):
            args = type("A", (), {"thread": None, "manager": None, "platform": "ios", "name": None,
                                  "purpose": None, "model": None, "region": None, "hard_timeout": "45m",
                                  "inactivity_timeout": "none", "install": None, "install_asset": None,
                                  "no_notify": True, "json": False})()
            with self.assertRaises(SystemExit) as refused:
                rcsim.cmd_create(args)
        self.assertNotEqual(refused.exception.code, 0)
        self.assertEqual(self.api_calls(), [], "no Run Cloud call may happen for an unresolved caller")

    def test_unresolved_launch_is_refused_before_any_run_cloud_call(self):
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = {
            "resolution": "pending", "robobThreadId": None, "parentThreadId": None, "executionKind": None,
            "acceptsMessages": False, "candidates": []}
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            args = type("A", (), {"thread": None, "manager": None, "platform": "android", "name": None,
                                  "purpose": None, "model": None, "region": None, "hard_timeout": "45m",
                                  "inactivity_timeout": "none", "build": "b1", "asset": None,
                                  "idempotency_key": None, "no_notify": True, "json": False})()
            with self.assertRaises(SystemExit):
                rcsim.cmd_launch(args)
        self.assertEqual(self.api_calls(), [])

    def test_mine_matches_the_exact_owner_not_the_shared_session(self):
        con = rcsim.db()
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-child','ios',?,?,'active',1,1,'rcsim')", (CHILD, CLAUDE_UUID))
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-parent','ios',?,?,'active',1,1,'rcsim')", (PARENT, CLAUDE_UUID))
        con.commit()
        child = {"thread": CHILD, "ses": CLAUDE_UUID, "driver": "claudeAgent", "resolution": "resolved"}
        mine = [r["id"] for r in rcsim.my_active(con, child)]
        self.assertEqual(mine, ["sim-child"], "a child must not release its parent's or sibling's simulator")

    def test_inherited_parent_rcsim_thread_never_releases_the_parents_simulators(self):
        # A resolved child inherits RCSIM_THREAD naming its parent. The owner must stay the exact child, so
        # `release --mine` releases only the child's simulator, never the parent's or a sibling's.
        con = rcsim.db()
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-child','ios',?,?,'active',1,1,'rcsim')", (CHILD, CLAUDE_UUID))
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-parent','ios',?,?,'active',1,1,'rcsim')", (PARENT, CLAUDE_UUID))
        con.commit()
        # A provable Codex caller: the inherited-parent rule, not the Claude rule, is under test here.
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CODEX_THREAD_ID=CODEX_UUID, RCSIM_THREAD=PARENT):
            me = rcsim.whoami()
            self.assertEqual(me["thread"], CHILD, "the owner is the resolved child, not the inherited parent")
            self.assertEqual(me["manager"], PARENT, "the parent is kept as the manager, not the owner")
            mine = [r["id"] for r in rcsim.my_active(con, me)]
        self.assertEqual(mine, ["sim-child"])

    def _claim_args(self, ids):
        return type("A", (), {"thread": None, "manager": None, "ids": ids, "purpose": None})()

    def test_claim_refuses_unresolved_callers_without_touching_rows_or_run_cloud(self):
        # Pending, ambiguous and unavailable callers must not overwrite an owner, nor call Run Cloud to discover one.
        con = rcsim.db()
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-owned','ios',?,?,'active',1,1,'rcsim')", (PARENT, CLAUDE_UUID))
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-orphan','ios',NULL,NULL,'active',1,1,'orphan')")
        con.commit()
        before = [tuple(r) for r in con.execute("SELECT id, owner_thread, owner_ses, state FROM sims ORDER BY id")]
        for resolution in ("pending", "ambiguous", "unavailable"):
            self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = {
                "resolution": resolution, "robobThreadId": None, "parentThreadId": None,
                "executionKind": None, "acceptsMessages": False, "candidates": []}
            with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID), \
                    patch.object(rcsim, "find_live", return_value=({"id": "sim-new"}, "ios")) as live:
                with self.assertRaises(SystemExit):
                    rcsim.cmd_claim(self._claim_args(["sim-owned", "sim-orphan", "sim-new"]))
            live.assert_not_called()
        after = [tuple(r) for r in con.execute("SELECT id, owner_thread, owner_ses, state FROM sims ORDER BY id")]
        self.assertEqual(after, before, "an unresolved claim must not change any owner")
        self.assertEqual(self.api_calls(), [], "an unresolved claim must not call Run Cloud")

    def test_mine_refuses_an_unresolved_caller(self):
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = {
            "resolution": "ambiguous", "robobThreadId": None, "parentThreadId": None, "executionKind": None,
            "acceptsMessages": False, "candidates": ["a", "b"]}
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            args = type("A", (), {"mine": True, "ids": [], "thread": None})()
            with self.assertRaises(SystemExit):
                rcsim.cmd_release(args)
        self.assertEqual(self.api_calls(), [])

    # --- shared Claude session: a parent and two native children present the same session id

    def _seed_shared_session_sims(self):
        con = rcsim.db()
        for sid, owner in (("sim-parent", PARENT), ("sim-child-a", CHILD), ("sim-child-b", "thread-child-b")):
            con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                        "VALUES (?,'ios',?,?,'active',1,1,'rcsim')", (sid, owner, CLAUDE_UUID))
        con.commit()
        return con

    def _snapshot_db(self, con):
        return [tuple(r) for r in con.execute("SELECT id, owner_thread, owner_ses, state, handoff_to, last_hb, hb_by "
                                              "FROM sims ORDER BY id")]

    def _shared_session_callers(self):
        # Three callers that all present CLAUDE_UUID: the parent shell and two children. Each one names the parent
        # through --thread or RCSIM_THREAD, which is the path that used to pass the owner check.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(PARENT, None, "top-level")
        # A real, reachable handoff target: the only thing that can stop a handoff is the guard under test.
        self.stub.threads["thread-elsewhere"] = {"threadId": "thread-elsewhere", "title": "Elsewhere",
                                                 "parentThreadId": None, "relationshipToParent": None}
        for label, thread_env in (("parent", PARENT), ("child-a", PARENT), ("child-b", PARENT)):
            yield label, thread_env

    def test_shared_session_callers_cannot_release_mine_with_a_named_parent(self):
        con = self._seed_shared_session_sims()
        before = self._snapshot_db(con)
        for label, thread in self._shared_session_callers():
            with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID, RCSIM_THREAD=thread), \
                    patch.object(rcsim, "rc") as run_cloud:
                args = type("A", (), {"mine": True, "ids": [], "thread": thread})()
                with self.assertRaises(SystemExit, msg=label):
                    rcsim.cmd_release(args)
                run_cloud.assert_not_called()
        self.assertEqual(self._snapshot_db(con), before, "a shared session must not release any simulator")
        self.assertEqual(self.api_calls(), [])

    def test_shared_session_callers_cannot_release_or_hand_off_by_id(self):
        con = self._seed_shared_session_sims()
        before = self._snapshot_db(con)
        for label, thread in self._shared_session_callers():
            with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID, RCSIM_THREAD=thread), \
                    patch.object(rcsim, "rc") as run_cloud:
                release_args = type("A", (), {"mine": False, "ids": ["sim-child-a"], "thread": thread})()
                with self.assertRaises(SystemExit, msg=f"{label} release"):
                    rcsim.cmd_release(release_args)
                handoff_args = type("A", (), {"id": "sim-child-b", "to": "thread-elsewhere", "note": None,
                                              "thread": thread})()
                with self.assertRaises(SystemExit, msg=f"{label} handoff"):
                    rcsim.cmd_handoff(handoff_args)
                run_cloud.assert_not_called()
        self.assertEqual(self._snapshot_db(con), before, "a shared session must not change any owner or handoff")
        self.assertEqual(self.api_calls(), [])

    def test_shared_session_callers_cannot_claim_create_or_launch(self):
        con = self._seed_shared_session_sims()
        con.execute("INSERT INTO sims (id, platform, owner_thread, owner_ses, state, created_at, last_hb, source) "
                    "VALUES ('sim-orphan','ios',NULL,NULL,'active',1,1,'orphan')")
        con.commit()
        before = self._snapshot_db(con)
        for label, thread in self._shared_session_callers():
            with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID, RCSIM_THREAD=thread), \
                    patch.object(rcsim, "find_live", return_value=({"id": "sim-new"}, "ios")) as live, \
                    patch.object(rcsim, "check_hard", return_value="45m"):
                claim_args = type("A", (), {"thread": thread, "manager": None, "ids": ["sim-orphan", "sim-new"],
                                            "purpose": None})()
                with self.assertRaises(SystemExit, msg=f"{label} claim"):
                    rcsim.cmd_claim(claim_args)
                live.assert_not_called()
                create_args = type("A", (), {"thread": thread, "manager": None, "platform": "ios", "name": None,
                                             "purpose": None, "model": None, "region": None,
                                             "hard_timeout": "45m", "inactivity_timeout": "none", "install": None,
                                             "install_asset": None, "no_notify": True, "json": False})()
                with self.assertRaises(SystemExit, msg=f"{label} create"):
                    rcsim.cmd_create(create_args)
                launch_args = type("A", (), {"thread": thread, "manager": None, "platform": "android",
                                             "name": None, "purpose": None, "model": None, "region": None,
                                             "hard_timeout": "45m", "inactivity_timeout": "none", "build": "b1",
                                             "asset": None, "idempotency_key": None, "no_notify": True,
                                             "json": False})()
                with self.assertRaises(SystemExit, msg=f"{label} launch"):
                    rcsim.cmd_launch(launch_args)
        self.assertEqual(self._snapshot_db(con), before, "a shared session must not claim or register anything")
        self.assertEqual(self.api_calls(), [], "a shared session must not reach Run Cloud")

    def test_shared_session_callers_cannot_heartbeat_another_execution_by_id(self):
        con = self._seed_shared_session_sims()
        before = self._snapshot_db(con)
        for label, thread in self._shared_session_callers():
            with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID, RCSIM_THREAD=thread):
                args = type("A", (), {"ids": ["sim-child-b"], "thread": thread})()
                with self.assertRaises(SystemExit, msg=label):
                    rcsim.cmd_heartbeat(args)
        self.assertEqual(self._snapshot_db(con), before, "a shared session must not refresh another's simulator")

    def test_claude_shell_is_refused_even_when_the_explicit_thread_is_the_parent(self):
        # whoami(--thread parent) must not come back resolved: the shared session can't name the owner.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(PARENT, None, "top-level")
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            me = rcsim.whoami(PARENT)
        self.assertEqual(me["resolution"], "unresolved")
        self.assertIsNone(me["thread"])
        self.assertEqual(me["reason"], "claude-shared-session")

    def test_provable_codex_child_can_still_release_its_own_simulator(self):
        # The gate must not block a provable owner: a resolved Codex child releases its own simulator.
        con = self._seed_shared_session_sims()
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CODEX_THREAD_ID=CODEX_UUID), \
                patch.object(rcsim, "rc", return_value=(0, {"status": "deleted"}, "", "")) as run_cloud:
            args = type("A", (), {"mine": True, "ids": [], "thread": None})()
            with self.assertRaises(SystemExit) as done:
                rcsim.cmd_release(args)
        self.assertEqual(done.exception.code, 0)
        mine_released = [r["id"] for r in con.execute("SELECT id FROM sims WHERE state='released'")]
        self.assertEqual(mine_released, ["sim-child-a"], "only the child's own simulator is released")
        self.assertEqual(run_cloud.call_count, 1)

    # --- liveness

    def test_uuid_owner_liveness_uses_the_identity_map_never_opencode(self):
        opencode_calls = []

        def fake_session(ses):
            opencode_calls.append(ses)
            return {"__missing__": True}  # the real OpenCode answer for a UUID: 404, which reads as dead

        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(CHILD, PARENT, "app-managed-child")
        with patch.object(rcsim, "opencode_session", side_effect=fake_session):
            self.assertEqual(rcsim.legacy_owner_state(CLAUDE_UUID), "ok")
        self.assertEqual(opencode_calls, [], "a UUID must never be looked up in OpenCode")

    def test_unresolved_uuid_owner_is_unknown_not_gone(self):
        # A failed or pending lookup must keep the simulator. Only a real "gone" deletes it.
        with patch.object(rcsim, "opencode_session", return_value={"__missing__": True}) as oc:
            self.assertEqual(rcsim.legacy_owner_state("99999999-8888-7777-6666-555555555555"), "unknown")
        oc.assert_not_called()

    def test_opencode_session_liveness_keeps_the_old_path(self):
        with patch.object(rcsim, "opencode_session", return_value={"__missing__": True}):
            self.assertEqual(rcsim.legacy_owner_state("ses_abc"), "gone")
        with patch.object(rcsim, "opencode_session", return_value={"id": "ses_abc"}):
            self.assertEqual(rcsim.legacy_owner_state("ses_abc"), "ok")


if __name__ == "__main__":
    unittest.main()
