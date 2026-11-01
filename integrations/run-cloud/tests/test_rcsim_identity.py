"""rcsim identity: owner = the resolved Robob execution, never the shared native session.

Checks: an unresolved caller is refused before any Run Cloud API call; --mine matches the exact owner; a UUID's
liveness goes through the identity map and never through OpenCode's 404. The Robob control API is a stub on a
real HTTP socket; the Run Cloud CLI is a recording fake, so "no API call" is provable.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
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
            patch.object(rcsim, "STATE_DIR", root / "state"),
            patch.object(rcsim, "DB_PATH", root / "state" / "rcsim.db"),
            patch.object(rcsim, "CTL_CFGS", (cfg, root / "none.json")),
            patch.object(rcsim, "RUNCLOUD", str(fake)),
            patch.object(rcsim, "OC_PW", root / "no-password"),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def api_calls(self):
        return self.api_log.read_text().splitlines() if self.api_log.exists() else []

    def shell(self, **env):
        return patch.dict(os.environ, env, clear=True)

    # --- identity

    def test_claude_shell_resolves_to_its_robob_execution(self):
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            me = rcsim.whoami()
        self.assertEqual(me["resolution"], "resolved")
        self.assertEqual(me["thread"], CHILD)
        self.assertEqual(me["manager"], PARENT)
        self.assertEqual(me["driver"], "claudeAgent")

    def test_inherited_rcsim_thread_of_an_unrelated_thread_is_ignored(self):
        other = "thread-unrelated"
        self.stub.threads[other] = {"threadId": other, "title": "Other", "parentThreadId": None,
                                    "relationshipToParent": None}
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(CHILD, PARENT, "app-managed-child")
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID, RCSIM_THREAD=other):
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

    def test_mine_refuses_an_unresolved_caller(self):
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = {
            "resolution": "ambiguous", "robobThreadId": None, "parentThreadId": None, "executionKind": None,
            "acceptsMessages": False, "candidates": ["a", "b"]}
        with self.shell(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID):
            args = type("A", (), {"mine": True, "ids": [], "thread": None})()
            with self.assertRaises(SystemExit):
                rcsim.cmd_release(args)
        self.assertEqual(self.api_calls(), [])

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
