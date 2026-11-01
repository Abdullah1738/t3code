"""The janitor's active set: Robob threads plus OpenCode sessions, and "incomplete" whenever a source is missing.

The control API has no cursor: it returns the newest `limit` threads (max 500) and reports the full count in
`total`. So a result larger than one page is truncated, and truncated means incomplete (keep everything).
Both sources are stubbed over real HTTP sockets.
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

SCRIPTS = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import active_sessions as active  # noqa: E402


class Stub:
    """Serves the control API (`threads`, `total`) and the OpenCode active list on one loopback port."""

    def __init__(self, threads, total=None, control_ok=True, opencode=None, opencode_ok=True):
        self.threads = threads
        self.total = len(threads) if total is None else total
        self.control_ok = control_ok
        self.opencode = opencode or {}
        self.opencode_ok = opencode_ok
        self.requests = []
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
                stub.requests.append(self.path)
                if url.path == "/api/ardud/control/threads":
                    if not stub.control_ok:
                        return self._send(503, {"ok": False})
                    if self.headers.get("Authorization") != "Bearer test-token":
                        return self._send(401, {"ok": False})
                    q = parse_qs(url.query)
                    limit = int(q.get("limit", ["50"])[0])
                    return self._send(200, {"ok": True, "total": stub.total,
                                            "threads": stub.threads[:limit]})
                if url.path == "/api/session/active":
                    if not stub.opencode_ok:
                        return self._send(500, {"error": "down"})
                    return self._send(200, {"data": {sid: {} for sid in stub.opencode}})
                return self._send(404, {})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def thread(i):
    return {"threadId": f"thread-{i:04d}", "state": "running", "worktreePath": f"/work/t{i}"}


class ActiveSetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Path(self.tmp.name) / "rcsim.json"
        self.cfg.write_text(json.dumps({"url": "", "token": "test-token"}))
        self.cfg.chmod(0o600)
        self.patches = [patch.dict(os.environ, {"ROBOB_CONTROL_CONFIG": str(self.cfg)}),
                        patch.object(active, "CONTROL_CFGS", (str(self.cfg),)),
                        patch.object(active, "PASSWORD_FILE", os.path.join(self.tmp.name, "no-password"))]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def serve(self, **kwargs):
        stub = Stub(**kwargs)
        self.addCleanup(stub.close)
        # Point both clients at the stub, and write the control credential with the stub's URL.
        self.cfg.write_text(json.dumps({"url": stub.base, "token": "test-token"}))
        self.cfg.chmod(0o600)
        patch.object(active, "OC_SERVICE_URL", stub.base).start()
        self.addCleanup(patch.stopall)
        return stub

    def test_both_sources_complete_gives_a_complete_union(self):
        self.serve(threads=[thread(1), thread(2)], opencode={"ses_a": True})
        snap = active.snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(set(snap["threads"]), {"thread-0001", "thread-0002"})
        self.assertEqual(snap["opencode"], {"ses_a"})

    def test_more_than_five_hundred_active_threads_is_truncated_and_incomplete(self):
        # 620 active threads: the API returns the newest 500 and reports 620 in total. Without a cursor the
        # missing 120 can't be read, so the snapshot must say incomplete (the reapers then keep everything).
        stub = self.serve(threads=[thread(i) for i in range(500)], total=620, opencode={"ses_a": True})
        snap = active.snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("truncated" in p for p in snap["problems"]), snap["problems"])
        self.assertTrue(any("limit=500" in r for r in stub.requests))

    def test_active_query_includes_subagent_threads(self):
        # The control API drops subagent threads unless asked. A live subagent that owns a worktree must still be
        # in the active set, or the reaper would remove it.
        stub = self.serve(threads=[thread(1)], opencode={})
        active.snapshot()
        self.assertTrue(any("includeSubagents=true" in r for r in stub.requests), stub.requests)

    def test_exactly_one_full_page_with_matching_total_is_complete(self):
        self.serve(threads=[thread(i) for i in range(500)], total=500)
        snap = active.snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(len(snap["threads"]), 500)

    def test_control_api_down_makes_the_snapshot_incomplete_even_with_opencode_up(self):
        self.serve(threads=[], control_ok=False, opencode={"ses_a": True})
        snap = active.snapshot()
        self.assertFalse(snap["complete"])
        self.assertEqual(snap["opencode"], {"ses_a"})

    def test_opencode_down_makes_the_snapshot_incomplete_even_with_robob_up(self):
        self.serve(threads=[thread(1)], opencode_ok=False)
        snap = active.snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("opencode-service" in p for p in snap["problems"]), snap["problems"])

    def test_missing_credential_is_incomplete_not_empty(self):
        self.serve(threads=[thread(1)])
        self.cfg.unlink()
        snap = active.snapshot()
        self.assertFalse(snap["complete"])

    def test_loose_credential_file_is_incomplete(self):
        self.serve(threads=[thread(1)])
        self.cfg.chmod(0o644)
        snap = active.snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("chmod 600" in p for p in snap["problems"]), snap["problems"])

    def test_back_compat_opencode_only_helper_keeps_its_shape(self):
        self.serve(threads=[], opencode={"ses_x": True})
        ids, err = active.active_session_ids()
        self.assertIsNone(err)
        self.assertEqual(ids, {"ses_x"})


class JanitorKeepsEverythingTests(unittest.TestCase):
    """An incomplete active set must keep every resource and every worktree, never reap."""

    def test_dev_janitor_scan_keeps_every_resource_when_the_snapshot_is_incomplete(self):
        import dev_janitor
        resources = [{"id": "sim:1", "kind": "simulator", "age_s": 99999, "tokens": ["x"]}]
        with patch.object(dev_janitor, "running_sessions", return_value=(None, {}, "control api: down")), \
                patch.object(dev_janitor, "procs", return_value=[]), \
                patch.object(dev_janitor, "keep_list", return_value=[]), \
                patch.object(dev_janitor, "session_evidence", return_value=({}, {})), \
                patch("subprocess.run") as run:
            run.return_value.returncode = 1
            run.return_value.stdout = ""
            run.return_value.stderr = ""
            with patch.object(dev_janitor, "sh", return_value=(1, "", "")):
                state = dev_janitor.scan()
        self.assertEqual(state["candidates"], [], "nothing may be a candidate on an incomplete active set")

    def test_worktree_reaper_refuses_to_run_on_an_incomplete_active_set(self):
        import worktree_reaper
        with patch.object(worktree_reaper, "snapshot", return_value={
                "complete": False, "threads": {}, "opencode": set(), "problems": ["down"]}):
            with self.assertRaises(RuntimeError):
                worktree_reaper.running_dirs(None)

    def test_worktree_of_a_running_claude_thread_is_protected(self):
        import worktree_reaper
        import sqlite3
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE session_v2 (id TEXT, directory TEXT)")
        with patch.object(worktree_reaper, "snapshot", return_value={
                "complete": True, "opencode": set(),
                "threads": {"t1": {"threadId": "t1", "worktreePath": "/work/claude-task"}}, "problems": []}):
            dirs = worktree_reaper.running_dirs(con)
        self.assertIn("/work/claude-task", dirs)


if __name__ == "__main__":
    unittest.main()
