"""Caller identity through Robob's identity map (C1), against a stub control API on a real HTTP socket.

Covers: Claude and Codex env resolve by driver, an inherited OFFBOX_THREAD of an unrelated thread is ignored,
a pending answer resolves on retry within 60 s, and an unresolved caller never claims the shared local owner.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import bases, capacity, common, identity, lease, misc, pool  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402

PARENT = "thread-parent"
CHILD = "thread-child"
OTHER = "thread-unrelated"
CLAUDE_UUID = "11111111-2222-3333-4444-555555555555"
CODEX_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa"
PENDING_UUID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"


class StubControl:
    """A Robob control API on 127.0.0.1. `identities` maps (nativeId, driver) to the identity body."""

    def __init__(self):
        self.identities = {}
        self.threads = {
            PARENT: {"threadId": PARENT, "parentThreadId": None, "relationshipToParent": None},
            CHILD: {"threadId": CHILD, "parentThreadId": PARENT, "relationshipToParent": "subagent"},
            OTHER: {"threadId": OTHER, "parentThreadId": None, "relationshipToParent": None},
        }
        self.calls = []
        # Every POST /threads/<id>/send, as (thread id, body): the monitor's warning, recorded for assertions.
        self.sends = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep the test output quiet
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_POST(self):
                url = urlparse(self.path)
                if self.headers.get("Authorization") != "Bearer test-token":
                    return self._send(401, {"ok": False})
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                # /api/ardud/control/threads/<id>/send -> ['', 'api', 'ardud', 'control', 'threads', '<id>', 'send']
                parts = url.path.split("/")
                if len(parts) == 7 and parts[4] == "threads" and parts[6] == "send":
                    stub.sends.append((parts[5], body))
                    return self._send(200, {"ok": True})
                return self._send(404, {"ok": False})

            def do_GET(self):
                url = urlparse(self.path)
                stub.calls.append(("GET", url.path, url.query))
                if self.headers.get("Authorization") != "Bearer test-token":
                    return self._send(401, {"ok": False})
                if url.path == "/api/ardud/control/identity/resolve":
                    q = parse_qs(url.query)
                    key = (q.get("nativeId", [""])[0], q.get("driver", [""])[0])
                    if key in stub.identities:
                        return self._send(200, {"ok": True, "identity": stub.identities[key]})
                    return self._send(200, {"ok": True, "identity": {
                        "resolution": "unavailable", "robobThreadId": None, "parentThreadId": None,
                        "executionKind": None, "acceptsMessages": False, "candidates": []}})
                if url.path.startswith("/api/ardud/control/threads/"):
                    tid = url.path.rsplit("/", 1)[1]
                    if tid in stub.threads:
                        return self._send(200, {"ok": True, "thread": stub.threads[tid]})
                    return self._send(404, {"ok": False})
                return self._send(404, {"ok": False})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def resolved(thread, parent=None, kind="top-level", accepts=True, driver="claudeAgent"):
    return {"resolution": "resolved", "robobThreadId": thread, "parentThreadId": parent,
            "rootThreadId": PARENT, "executionKind": kind, "driver": driver, "acceptsMessages": accepts,
            "candidates": []}


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stub = StubControl()
        self.addCleanup(self.stub.close)
        root = Path(self.tmp.name)
        self.home = root / "home"
        cfg_dir = self.home / ".robob/components"
        cfg_dir.mkdir(parents=True)
        cfg = cfg_dir / "offbox.json"
        cfg.write_text(json.dumps({"url": self.stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        self.stack = [
            patch.object(common, "STATE", root / "STATE"),
            patch.object(common, "DB_PATH", root / "db.sqlite"),
            patch.object(common, "LOG_PATH", root / "log"),
            patch.object(identity, "CTL_CFGS", (cfg, root / "none.json")),
            patch.object(identity, "repo_root", return_value=root),
            patch.object(identity, "repo_key", return_value="repo"),
        ]
        for p in self.stack:
            p.start()
            self.addCleanup(p.stop)
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID",
                                 "OPENCODE_SESSION_ID", "OFFBOX_THREAD")}
        self.envp = patch.dict(os.environ, self.env, clear=True)
        self.envp.start()
        self.addCleanup(self.envp.stop)

    def who(self, **shell):
        with patch.dict(os.environ, shell):
            return identity.whoami(str(Path(self.tmp.name)))

    def test_claude_shell_asks_c1_by_driver_but_takes_no_resolved_owner(self):
        # C1 is queried with driver=claudeAgent, but a bare Claude id can't prove top-level, so the caller keeps
        # its own unresolved owner. No parent lease is taken.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(OTHER)
        me = self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        self.assertIsNone(me["thread"])
        self.assertEqual(me["owner"], f"unresolved:claudeAgent:{CLAUDE_UUID}")
        self.assertEqual(me["driver"], "claudeAgent")
        self.assertEqual(me["resolution"], "unresolved")
        self.assertTrue(any(c[2].endswith("driver=claudeAgent") for c in self.stub.calls
                            if c[1].endswith("/identity/resolve")))

    def test_codex_shell_prefers_the_concrete_thread_over_the_shared_session(self):
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(OTHER, driver="codex")
        me = self.who(CODEX_THREAD_ID=CODEX_UUID, CODEX_SESSION_ID="shared-session-id")
        self.assertEqual(me["driver"], "codex")
        self.assertEqual(me["thread"], OTHER)
        queried = [c[2] for c in self.stub.calls if c[1].endswith("/identity/resolve")]
        self.assertTrue(queried and all("shared-session-id" not in q for q in queried))

    def test_stale_inherited_offbox_thread_of_an_unrelated_thread_is_ignored(self):
        # A child shell inherits OFFBOX_THREAD from an unrelated parent: that value must not claim the work.
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(CHILD, PARENT, kind="app-managed-child", driver="codex")
        me = self.who(CODEX_THREAD_ID=CODEX_UUID, OFFBOX_THREAD=OTHER)
        self.assertEqual(me["thread"], CHILD)
        self.assertEqual(me["owner"], CHILD)

    def test_claude_shell_never_takes_the_parent_lease_on_a_shared_session_id(self):
        # C1 answers a bare Claude id with the parent's top-level identity, but a child shell shares that id.
        # The shell must not inherit the parent's owner: it gets its own unresolved owner, never the parent's.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(OTHER)
        me = self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        self.assertNotEqual(me["owner"], OTHER, "a Claude shell must not own the resolved thread's leases")
        self.assertEqual(me["owner"], f"unresolved:claudeAgent:{CLAUDE_UUID}")
        self.assertIsNone(me["thread"])

    def test_explicit_offbox_thread_matching_an_ancestor_is_honoured(self):
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(CHILD, PARENT, kind="app-managed-child", driver="codex")
        me = self.who(CODEX_THREAD_ID=CODEX_UUID, OFFBOX_THREAD=PARENT)
        self.assertEqual(me["thread"], PARENT)

    def age_identity_row(self, native, seconds):
        con = common.db()
        con.execute("UPDATE kv SET ts = ts - ? WHERE k = ?", (seconds, f"identity:codex:{native}"))
        con.commit()

    def test_pending_resolves_on_retry_within_sixty_seconds(self):
        pending = {"resolution": "pending", "robobThreadId": None, "parentThreadId": None,
                   "executionKind": None, "acceptsMessages": False, "candidates": []}
        self.stub.identities[(PENDING_UUID, "codex")] = pending
        first = self.who(CODEX_THREAD_ID=PENDING_UUID)
        self.assertEqual(first["resolution"], "pending")
        self.assertEqual(first["owner"], f"unresolved:codex:{PENDING_UUID}")
        # The mapping lands. The next attempt is a few seconds later (past the short burst cache, well
        # inside the 60 s ceiling), so it asks C1 again and resolves.
        self.stub.identities[(PENDING_UUID, "codex")] = resolved(OTHER, driver="codex")
        self.age_identity_row(PENDING_UUID, 10)
        second = self.who(CODEX_THREAD_ID=PENDING_UUID)
        self.assertEqual(second["resolution"], "resolved")
        self.assertEqual(second["thread"], OTHER)

    def test_pending_answer_is_not_cached_past_sixty_seconds(self):
        pending = {"resolution": "pending", "robobThreadId": None, "parentThreadId": None,
                   "executionKind": None, "acceptsMessages": False, "candidates": []}
        self.stub.identities[(PENDING_UUID, "codex")] = pending
        self.who(CODEX_THREAD_ID=PENDING_UUID)
        before = len(self.stub.calls)
        # Age the cached row past 60 s, then the next lookup must go back to the control API.
        con = common.db()
        con.execute("UPDATE kv SET ts = ts - 61 WHERE k = ?", (f"identity:codex:{PENDING_UUID}",))
        con.commit()
        self.who(CODEX_THREAD_ID=PENDING_UUID)
        self.assertGreater(len(self.stub.calls), before)

    def test_resolved_answer_is_cached_for_an_hour(self):
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(OTHER)
        self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        before = len(self.stub.calls)
        self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        self.assertEqual(len(self.stub.calls), before)

    def test_control_outage_is_unresolved_never_unowned(self):
        with patch.object(identity, "CTL_CFGS", (Path(self.tmp.name) / "missing.json",)):
            me = self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        self.assertNotEqual(me["resolution"], "resolved")
        self.assertIsNone(me["thread"])
        self.assertEqual(me["owner"], f"unresolved:claudeAgent:{CLAUDE_UUID}")

    def test_same_uuid_under_two_drivers_never_crosses(self):
        # The UUID is a Codex thread in one home. Under Claude it must not resolve through that answer.
        self.stub.identities[(CLAUDE_UUID, "codex")] = resolved(OTHER, driver="codex")
        codex = self.who(CODEX_THREAD_ID=CLAUDE_UUID)
        claude = self.who(CLAUDE_CODE_SESSION_ID=CLAUDE_UUID)
        self.assertEqual(codex["thread"], OTHER)
        self.assertIsNone(claude["thread"], "a Claude shell never takes a resolved owner")
        self.assertEqual(claude["resolution"], "unresolved")

    def test_opencode_shell_keeps_the_session_lookup(self):
        with patch.object(identity, "_lookup_thread", return_value={"thread": "thread-oc", "title": "t",
                                                                   "manager": None}) as lookup:
            me = self.who(OPENCODE_SESSION_ID="ses_abc")
        lookup.assert_called_once_with("ses_abc")
        self.assertEqual(me["thread"], "thread-oc")
        self.assertEqual(me["driver"], "opencode")
        self.assertEqual(me["owner"], "thread-oc")

    def test_local_first_run_carries_the_resolved_robob_thread_not_the_shell_value(self):
        from offbox_lib import localfirst

        class Args:
            env = []

        with patch.dict(os.environ, {"OFFBOX_ROBOB_THREAD": "stale-from-shell", "OPENCODE_SESSION_ID": "ses_x"}):
            env = localfirst.local_env(Args(), "run-x", "/nonexistent", None,
                                       {"robobThreadId": OTHER, "driver": "codex"})
        self.assertEqual(env["OFFBOX_ROBOB_THREAD"], OTHER)
        self.assertEqual(env["OFFBOX_NATIVE_DRIVER"], "codex")
        with patch.dict(os.environ, {"OFFBOX_ROBOB_THREAD": "stale-from-shell"}):
            unresolved = localfirst.local_env(Args(), "run-x", "/nonexistent", None, {"robobThreadId": None})
        self.assertNotIn("OFFBOX_ROBOB_THREAD", unresolved)


class SharedSessionOwnerTests(unittest.TestCase):
    """A Claude parent and two children share one session id. Their owner strings are the same, so they must not
    select, reuse, release or exempt each other's leases. Each check runs the real selector against a real row."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.repo = str(root)
        self.stub = StubControl()
        self.addCleanup(self.stub.close)
        cfg_dir = root / "home/.robob/components"
        cfg_dir.mkdir(parents=True)
        cfg = cfg_dir / "offbox.json"
        cfg.write_text(json.dumps({"url": self.stub.url, "token": "test-token"}))
        cfg.chmod(0o600)
        self.stack = [
            patch.object(common, "STATE", root / "STATE"),
            patch.object(common, "DB_PATH", root / "db.sqlite"),
            patch.object(common, "LOG_PATH", root / "log"),
            patch.object(common, "LOCKS_DIR", root / "locks"),
            patch.object(common, "EXEMPTIONS", root / "exemptions.json"),
            # misc and lease hold their own references to these names, so each one is pointed at the temp dir too.
            patch.object(misc, "EXEMPTIONS", root / "exemptions.json"),
            patch.object(misc, "CAP_PATH", root / "cap.json"),
            patch.object(identity, "CTL_CFGS", (cfg, root / "none.json")),
            patch.object(identity, "repo_root", return_value=root),
            patch.object(identity, "repo_key", return_value="repo"),
        ]
        for p in self.stack:
            p.start()
            self.addCleanup(p.stop)
        (root / "locks").mkdir(exist_ok=True)
        self.envp = patch.dict(os.environ, {k: v for k, v in os.environ.items()
                                            if k not in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID",
                                                         "CODEX_SESSION_ID", "OPENCODE_SESSION_ID",
                                                         "OFFBOX_THREAD")}, clear=True)
        self.envp.start()
        self.addCleanup(self.envp.stop)
        # The Claude session resolves (C1 answers the parent's identity). Both children and the parent see that answer.
        self.stub.identities[(CLAUDE_UUID, "claudeAgent")] = resolved(OTHER)

    def claude_caller(self):
        with patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": CLAUDE_UUID}):
            return identity.whoami(self.repo)

    def seed_rows(self):
        """A lease the parent's own resolved thread holds, and a legacy row under the old shared owner string."""
        con = common.db()
        capacity.schema(con)
        legacy_owner = f"unresolved:claudeAgent:{CLAUDE_UUID}"
        con.execute("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir, state, created_at, "
                    "last_used_at) VALUES ('box-resolved', ?, ?, 'repo', 'w/r', 'running', 1, 1)", (OTHER, self.repo))
        con.execute("INSERT INTO leases (box_id, owner, repo_root, repo_key, remote_dir, state, created_at, "
                    "last_used_at) VALUES ('box-legacy', ?, ?, 'repo', 'w/l', 'running', 1, 1)",
                    (legacy_owner, self.repo))
        con.execute("INSERT INTO pool_callers (owner, repo_root, box_id, remote_dir) VALUES (?, ?, 'box-legacy', 'w/l')",
                    (legacy_owner, self.repo))
        con.commit()
        return con

    def lease_state(self):
        con = common.db()
        return sorted(tuple(r) for r in con.execute("SELECT box_id, owner, state FROM leases ORDER BY box_id"))

    def test_claude_parent_and_children_are_all_unproven(self):
        # Three callers, one session: none may be treated as proven, and all share the same display owner.
        parent = self.claude_caller()
        child_a = self.claude_caller()
        child_b = self.claude_caller()
        for me in (parent, child_a, child_b):
            self.assertFalse(me["proven"], me)
            self.assertIsNone(me["thread"])
            self.assertEqual(me["owner"], f"unresolved:claudeAgent:{CLAUDE_UUID}")

    def test_every_claude_selector_refuses_and_changes_nothing(self):
        self.seed_rows()
        before = self.lease_state()
        me = self.claude_caller()
        cases = {
            "release --mine": lambda: misc.release(me, None, True, False),
            "release by id": lambda: misc.release(me, "box-legacy", False, False),
            "release (own lease)": lambda: misc.release(me, None, False, False),
            "list (own leases)": lambda: misc.list_leases(me, False, False),
            "ssh/ports/keep (resolve_box)": lambda: misc.resolve_box(me, None),
            "save/keep/base (caller lease)": lambda: bases._caller_lease(me),
            "local exemption": lambda: misc.local_exempt(me, "a reason long enough to pass", "2h", False, False),
            "run (acquire_private)": lambda: lease.acquire_private(me),
            "run (pooled acquire)": lambda: pool.acquire(me),
        }
        for label, call in cases.items():
            with self.subTest(selector=label), self.assertRaises(OffboxError) as refused:
                call()
            self.assertIn("can't be proven", str(refused.exception))
        self.assertEqual(self.lease_state(), before, "a refused selector must not change any lease")
        self.assertFalse((Path(self.tmp.name) / "exemptions.json").exists(), "no exemption may be written")

    def test_listing_every_lease_stays_read_only_for_an_unproven_caller(self):
        # `list --all` selects no owner, so it is read-only and allowed. It must not change anything.
        self.seed_rows()
        me = self.claude_caller()
        with patch("builtins.print"):
            misc.list_leases(me, True, False)
        self.assertEqual(len(self.lease_state()), 2)

    def test_a_resolved_codex_caller_still_selects_its_own_lease(self):
        # The positive control: the gate blocks only a caller that can't be proven.
        con = self.seed_rows()
        self.stub.identities[(CODEX_UUID, "codex")] = resolved(OTHER, driver="codex")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": CODEX_UUID}):
            me = identity.whoami(self.repo)
        self.assertTrue(me["proven"])
        self.assertEqual(me["owner"], OTHER)
        found = lease.find_lease(con, me["owner"], self.repo)
        self.assertIsNotNone(found)
        self.assertEqual(found["box_id"], "box-resolved")
        self.assertNotEqual(found["box_id"], "box-legacy", "a resolved caller never sees the shared legacy row")


if __name__ == "__main__":
    unittest.main()
