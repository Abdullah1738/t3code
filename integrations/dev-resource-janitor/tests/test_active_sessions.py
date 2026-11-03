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

    def __init__(self, threads, total=None, control_ok=True, opencode=None, opencode_ok=True, projects=None,
                 projects_ok=True):
        self.projects = projects or []
        self.projects_ok = projects_ok
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
                if url.path == "/api/ardud/control/projects":
                    if not stub.control_ok or not stub.projects_ok:
                        return self._send(503, {"ok": False})
                    return self._send(200, {"ok": True, "projects": stub.projects})
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

    def test_active_query_reads_the_full_list_so_runless_native_threads_are_covered(self):
        # `active=true` is built from runs and pending requests, so a native child with neither is missing from it.
        # The janitor reads the full thread list instead and decides activity itself.
        stub = self.serve(threads=[thread(1)], opencode={"ses_a": True})
        active.snapshot()
        queries = [r for r in stub.requests if "/threads" in r]
        self.assertTrue(queries, stub.requests)
        self.assertFalse(any("active=true" in r for r in queries), queries)

    def test_runless_native_child_is_kept_as_in_use(self):
        # A native child that is idle (no run, no pending request) can still own a worktree: it counts as in use.
        native = {"threadId": "thread-native-runless", "state": "idle", "worktreePath": "/work/native",
                  "relationshipToParent": "subagent", "creationSource": "provider"}
        self.serve(threads=[native], opencode={})
        snap = active.snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertIn("thread-native-runless", snap["threads"])
        self.assertTrue(active.in_use(snap["threads"]["thread-native-runless"]))

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


class RootWorkspaceTests(unittest.TestCase):
    """A thread on a project's root workspace has worktreePath null. Its checkout is still in use."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Path(self.tmp.name) / "rcsim.json"
        self.cfg.write_text(json.dumps({"url": "", "token": "test-token"}))
        self.cfg.chmod(0o600)
        self.patches = [patch.object(active, "CONTROL_CFGS", (str(self.cfg),)),
                        patch.object(active, "PASSWORD_FILE", os.path.join(self.tmp.name, "no-password"))]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def serve(self, **kwargs):
        stub = Stub(**kwargs)
        self.addCleanup(stub.close)
        self.cfg.write_text(json.dumps({"url": stub.base, "token": "test-token"}))
        self.cfg.chmod(0o600)
        patch.object(active, "OC_SERVICE_URL", stub.base).start()
        self.addCleanup(patch.stopall)
        return stub

    def test_root_workspace_thread_protects_its_project_root(self):
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-1"}
        self.serve(threads=[root], opencode={}, projects=[{"projectId": "proj-1", "workspaceRoot": "/Users/x/repo"}])
        snap = active.snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(snap["workspaces"], {"thread-root": "/Users/x/repo"})

    def test_unresolvable_project_fails_closed(self):
        # The thread's project is missing from /projects: its workspace is unknown, so the set is not complete.
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-gone"}
        self.serve(threads=[root], opencode={}, projects=[])
        snap = active.snapshot()
        self.assertFalse(snap["complete"], "an in-use thread whose workspace is unknown must not be reaped against")
        self.assertTrue(any("workspace" in p for p in snap["problems"]), snap["problems"])

    def test_failed_projects_read_makes_the_whole_snapshot_incomplete(self):
        # Threads answer in full, but /projects fails. Protecting only the worktree paths would leave a root
        # workspace unprotected, so the whole snapshot is incomplete, not just that one thread.
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-1"}
        worktree = {"threadId": "thread-wt", "state": "running", "worktreePath": "/work/wt"}
        self.serve(threads=[root, worktree], opencode={}, projects_ok=False)
        snap = active.snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("projects" in p for p in snap["problems"]), snap["problems"])

    def test_janitor_running_sessions_reads_workspaces_from_the_same_snapshot(self):
        import dev_janitor
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-1"}
        stub = self.serve(threads=[root], opencode={"ses_a": True},
                          projects=[{"projectId": "proj-1", "workspaceRoot": "/Users/x/repo"}])
        ids, native, err = dev_janitor.running_sessions()
        self.assertIsNone(err)
        self.assertEqual(ids, {"ses_a"})
        self.assertEqual(native, {"thread-root": "/Users/x/repo"})
        self.assertEqual(len([r for r in stub.requests if "/projects" in r]), 1, stub.requests)

    def test_snapshot_reads_each_source_once(self):
        # The workspaces come from the same read as the threads, so /projects is asked for once per snapshot.
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-1"}
        stub = self.serve(threads=[root], opencode={}, projects=[{"projectId": "proj-1", "workspaceRoot": "/r"}])
        active.snapshot()
        projects_reads = [r for r in stub.requests if "/projects" in r]
        self.assertEqual(len(projects_reads), 1, stub.requests)


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
        # running_dirs reads the workspaces from the one complete snapshot. The snapshot is patched so the test
        # stays off the live control API and checks only that the claude workspace is protected.
        complete = {"complete": True, "opencode": set(), "threads": {}, "problems": [],
                    "workspaces": {"thread-claude": "/work/claude-task"}}
        with patch.object(worktree_reaper, "snapshot", return_value=complete):
            dirs = worktree_reaper.running_dirs(con)
        self.assertIn("/work/claude-task", dirs)

    def test_running_dirs_takes_one_snapshot_and_keeps_its_workspaces(self):
        # The reaper must not read the sources a second time for the workspaces. One snapshot gives both the
        # opencode directories and the workspaces, and a later failure can't empty the protected set.
        import worktree_reaper
        import sqlite3
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE session_v2 (id TEXT, directory TEXT)")
        complete = {"complete": True, "opencode": set(), "threads": {}, "problems": [],
                    "workspaces": {"thread-root": "/Users/x/repo"}}
        with patch.object(worktree_reaper, "snapshot", return_value=complete) as snap:
            dirs = worktree_reaper.running_dirs(con)
        self.assertEqual(snap.call_count, 1)
        self.assertIn("/Users/x/repo", dirs)

    def test_incomplete_snapshot_makes_running_dirs_raise_not_protect_nothing(self):
        import worktree_reaper
        import sqlite3
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE session_v2 (id TEXT, directory TEXT)")
        incomplete = {"complete": False, "opencode": set(), "threads": {}, "workspaces": {},
                      "problems": ["control api projects: status 503"]}
        with patch.object(worktree_reaper, "snapshot", return_value=incomplete):
            with self.assertRaises(RuntimeError):
                worktree_reaper.running_dirs(con)

    def test_reaper_removes_nothing_when_the_recheck_snapshot_fails(self):
        # The first read is healthy and the worktree is stale, so it reaches the re-check right before removal. The
        # re-check's read fails: main() must remove nothing and report an error.
        import contextlib
        import io
        import sqlite3
        import worktree_reaper as wr
        healthy = {"complete": True, "opencode": set(), "threads": {}, "problems": [],
                   "workspaces": {"thread-root": "/Users/x/repo"}}
        failing = {"complete": False, "opencode": set(), "threads": {}, "workspaces": {},
                   "problems": ["control api projects: status 503"]}
        candidate = {"path": "/work/stale", "common": "/work/common.git", "head": "abc123",
                     "branch": "refs/heads/old", "reasons": [], "last_commit": 0, "last_commit_days": 90,
                     "last_session_days": None, "created_days": 90, "ignored_keep": []}
        worktree = {"main": False, "common": "/work/common.git", "worktree": "/work/stale", "HEAD": "abc123",
                    "branch": "refs/heads/old"}
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE session_v2 (id TEXT, directory TEXT)")
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack, \
                contextlib.redirect_stdout(io.StringIO()):
            stack.enter_context(patch.object(wr, "LOG_DIR", tmp))
            stack.enter_context(patch.object(wr, "STATUS", os.path.join(tmp, "status.json")))
            stack.enter_context(patch.object(wr, "AUDIT", os.path.join(tmp, "audit.jsonl")))
            stack.enter_context(patch.object(wr.sqlite3, "connect", return_value=db))
            stack.enter_context(patch.object(wr, "snapshot", side_effect=[healthy, failing]))
            stack.enter_context(patch.object(wr, "session_activity", return_value={}))
            stack.enter_context(patch.object(wr, "process_cwds", return_value=[]))
            stack.enter_context(patch.object(wr, "keep_list", return_value=[]))
            stack.enter_context(patch.object(wr, "discover", return_value=["/work/common.git"]))
            stack.enter_context(patch.object(wr, "worktrees", return_value=([worktree], None)))
            stack.enter_context(patch.object(wr, "evaluate", return_value=candidate))
            git = stack.enter_context(patch.object(wr, "git", return_value=(0, "", "")))
            archive = stack.enter_context(patch.object(wr, "archive_ignored", return_value={}))
            stack.enter_context(patch.object(sys, "argv", ["worktree_reaper.py"]))
            code = wr.main()
            with open(os.path.join(tmp, "status.json")) as f:
                status = json.load(f)
        self.assertEqual(code, 1)
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["removed"], [])
        self.assertFalse(any("remove" in call.args[0] for call in git.call_args_list), git.call_args_list)
        archive.assert_not_called()




if __name__ == "__main__":
    unittest.main()
