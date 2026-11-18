"""The janitor's active set: Robob threads plus OpenCode sessions, and "incomplete" whenever a source is missing.

Cursor walks are mocked below; the HTTP stub retains the old single-page server contract
to cover compatibility and incomplete-source behavior.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from janitor_test_safety import JanitorTestCase
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

SCRIPTS = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import active_sessions as active  # noqa: E402


class Stub:
    """Serves the control API (`threads`, `total`) and the OpenCode active list on one loopback port."""

    def __init__(self, threads, total=None, control_ok=True, opencode=None, opencode_ok=True, projects=None,
                 projects_ok=True, honor_filters=False):
        self.projects = projects or []
        self.projects_ok = projects_ok
        self.threads = threads
        self.total = len(threads) if total is None else total
        self.control_ok = control_ok
        self.opencode = opencode or {}
        self.opencode_ok = opencode_ok
        # honor_filters: answer the thread query the way the server does (active, creationSource, updatedSince
        # narrow the list). Otherwise every query gets the same list, which is what the older tests were written for.
        self.honor_filters = honor_filters
        # Per-query failures: a 503 on just the native (creationSource) or just the active (active=true) query.
        self.native_fail = False
        self.active_fail = False
        # Report this total instead of the matched count, to simulate a truncated result (more than one page).
        # override_kind picks which query it applies to: "native" (creationSource) or "active" (active=true).
        self.total_override = None
        self.override_kind = None
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
                    if stub.native_fail and "creationSource" in q:
                        return self._send(503, {"ok": False})
                    if stub.active_fail and q.get("active", [""])[0] == "true":
                        return self._send(503, {"ok": False})
                    if stub.honor_filters:
                        matched = stub.filtered(q)
                        total = len(matched)
                        # total_override is scoped to one query kind, so a test can truncate (a) or (b) alone.
                        if stub.total_override is not None and stub.override_for(q):
                            total = stub.total_override
                        return self._send(200, {"ok": True, "total": total, "threads": matched[:limit]})
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
                if url.path.startswith("/api/session/"):
                    return self._send(200, {"data": {"directory": "/work/service"}})
                return self._send(404, {})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def override_for(self, q):
        """Whether total_override applies to this query: the native one carries creationSource, the active one
        carries active=true."""
        if self.override_kind == "native":
            return "creationSource" in q
        if self.override_kind == "active":
            return q.get("active", [""])[0] == "true"
        return False

    def filtered(self, q):
        """The threads the server would list for these query params: the server's filters, applied in order."""
        out = list(self.threads)
        if q.get("active", [""])[0] == "true":
            out = [t for t in out if t.get("state") not in (None, "idle")]
        states = q.get("state", [""])[0]
        if states:
            out = [t for t in out if t.get("state") in states.split(",")]
        cs = q.get("creationSource", [""])[0]
        if cs:
            wanted = cs.split(",")
            out = [t for t in out if t.get("creationSource") in wanted]
        since = q.get("updatedSince", [""])[0]
        if since:
            out = [t for t in out if t.get("updatedAtMs", 0) > int(since)]
        return out

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def thread(i):
    return {"threadId": f"thread-{i:04d}", "state": "running", "worktreePath": f"/work/t{i}"}


class ActiveSetTests(JanitorTestCase):
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
        self.stub = stub
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

    def test_runless_native_children_are_read_by_their_own_query_not_the_active_one(self):
        # `active=true` is built from runs and pending requests, so a native child with neither is missing from it.
        # The janitor reads those children with a second query (provider and mcp, inside the 48-hour window).
        stub = self.serve(threads=[thread(1)], opencode={"ses_a": True})
        active.snapshot()
        queries = [r for r in stub.requests if "/threads" in r]
        self.assertEqual(len(queries), 2, queries)
        self.assertTrue(any("active=true" in r for r in queries), queries)
        self.assertTrue(any(parse_qs(urlparse(r).query).get("creationSource") == ["provider"]
                            for r in queries), queries)

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


NOW_MS = 1_800_000_000_000  # a fixed clock, so the native window's cut is exact


class TwoQueryActiveSetTests(JanitorTestCase):
    """Both the non-idle and recent provider/MCP queries must be complete."""

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
        self.stub = stub
        self.cfg.write_text(json.dumps({"url": stub.base, "token": "test-token"}))
        self.cfg.chmod(0o600)
        patch.object(active, "OC_SERVICE_URL", stub.base).start()
        self.addCleanup(patch.stopall)
        return stub

    def read_snapshot(self):
        # The real snapshot, with the clock pinned so the native window is exact.
        with patch.object(active.time, "time", return_value=NOW_MS / 1000):
            return active.snapshot()

    def test_both_queries_send_the_exact_params(self):
        stub = self.serve(threads=[], honor_filters=True)
        self.read_snapshot()
        active_q = [r for r in stub.requests if "active=true" in r]
        native_q = [r for r in stub.requests if "creationSource" in parse_qs(urlparse(r).query)]
        self.assertEqual(len(active_q), 1, stub.requests)
        self.assertEqual(len(native_q), 1, stub.requests)
        self.assertEqual(parse_qs(urlparse(active_q[0]).query),
                         {"active": ["true"], "includeSubagents": ["true"], "limit": ["500"]})
        # The window: updatedSince = now - 48 h, to within a minute (the test pins the clock, so it is exact).
        params = parse_qs(urlparse(native_q[0]).query)
        self.assertEqual(params.pop("creationSource"), ["provider"])
        since = int(params.pop("updatedSince")[0])
        self.assertEqual(params, {"includeSubagents": ["true"], "limit": ["500"]})
        self.assertAlmostEqual(since, NOW_MS - 48 * 3600 * 1000, delta=60_000)

    def test_native_window_is_forty_eight_hours(self):
        self.assertEqual(active.NATIVE_WINDOW_MS, 48 * 3600 * 1000)
        self.assertEqual(active.NATIVE_TIMEOUT, 60)

    def test_running_app_thread_and_idle_native_child_are_both_in_use(self):
        running = {"threadId": "thread-app-run", "state": "running", "worktreePath": "/work/app",
                   "creationSource": "web", "updatedAtMs": NOW_MS}
        idle_native = {"threadId": "thread-native-idle", "state": "idle", "worktreePath": "/work/native",
                       "creationSource": "provider", "relationshipToParent": "subagent",
                       "updatedAtMs": NOW_MS - 3600_000}
        self.serve(threads=[running, idle_native], honor_filters=True, opencode={})
        snap = self.read_snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(set(snap["threads"]), {"thread-app-run", "thread-native-idle"})
        self.assertTrue(active.in_use(snap["threads"]["thread-app-run"]))
        self.assertTrue(active.in_use(snap["threads"]["thread-native-idle"]))

    def test_recent_idle_delegate_protects_its_expo_process(self):
        import dev_janitor

        delegate = {"threadId": "delegate", "state": "idle", "worktreePath": "/work/app/task",
                    "creationSource": "mcp", "relationshipToParent": "subagent",
                    "updatedAtMs": NOW_MS - 3600_000}
        self.serve(threads=[delegate], honor_filters=True, opencode={})
        process = {"pid": 1111, "ppid": 1, "age_s": 9000, "rss_mb": 1, "cmd": "expo start"}
        with patch.object(active.time, "time", return_value=NOW_MS / 1000), \
                patch.object(dev_janitor.leftover_processes, "scan", return_value={}), \
                patch.object(dev_janitor, "procs", return_value=[process]), \
                patch.object(dev_janitor, "cwd_of", return_value="/work/app"), \
                patch.object(dev_janitor, "keep_list", return_value=[]), \
                patch.object(dev_janitor, "sh", return_value=(1, "", "")):
            snap = active.snapshot()
            result = dev_janitor.scan()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(snap["workspaces"], {})
        expo = next(r for r in result["resources"] if r["id"] == "expo:1111")
        self.assertFalse(expo["candidate"])
        self.assertTrue(any("usage_history_unavailable" in reason for reason in expo["keep_reasons"]))

    def test_mcp_query_truncation_fails_closed(self):
        delegates = [{"threadId": f"delegate-{i}", "state": "idle", "creationSource": "mcp",
                      "relationshipToParent": "subagent", "worktreePath": f"/w/{i}",
                      "updatedAtMs": NOW_MS - 1000} for i in range(501)]
        self.serve(threads=delegates, honor_filters=True, opencode={})
        snap = self.read_snapshot()
        self.assertTrue(snap["complete"])
        self.assertEqual(snap["threads"], {})

    def test_twenty_six_thousand_thread_server_is_complete(self):
        # The bug: the old single full-list query said "26140 threads, only 500 returned" and kept everything. Here
        # 26,000 threads exist, 95 are non-idle, and 40 provider-native children were updated in the window. Each
        # query is complete on its own, so the snapshot is complete, and it covers exactly the 135 that matter.
        live = [{"threadId": f"live-{i}", "state": "running", "worktreePath": f"/work/live{i}",
                 "creationSource": "web", "updatedAtMs": NOW_MS} for i in range(95)]
        native = [{"threadId": f"native-{i}", "state": "idle", "worktreePath": f"/work/native{i}",
                   "creationSource": "provider", "relationshipToParent": "subagent",
                   "updatedAtMs": NOW_MS - 3600_000} for i in range(40)]
        # 25,865 old idle app threads that neither query returns (they are idle, and outside the native window).
        old_idle = [{"threadId": f"old-{i}", "state": "idle", "worktreePath": f"/work/old{i}",
                     "creationSource": "web", "updatedAtMs": NOW_MS - 10 * 24 * 3600 * 1000}
                    for i in range(25_865)]
        self.serve(threads=live + native + old_idle, honor_filters=True, opencode={})
        snap = self.read_snapshot()
        self.assertTrue(snap["complete"], snap["problems"])
        self.assertEqual(len(snap["threads"]), 135)
        self.assertEqual(len(snap["workspaces"]), 135)

    def test_truncated_native_query_is_incomplete(self):
        # (b) has more threads in the window than one page holds: incomplete, not a partial list.
        native = [{"threadId": f"native-{i}", "state": "idle", "creationSource": "provider",
                   "relationshipToParent": "subagent", "worktreePath": f"/w/{i}",
                   "updatedAtMs": NOW_MS - 1000} for i in range(500)]
        self.serve(threads=native, honor_filters=True, opencode={})
        # The native window holds more than one page: the native query reports 620 and returns 500.
        self.stub.total_override = 620
        self.stub.override_kind = "native"
        snap = self.read_snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("native" in p and "truncated" in p for p in snap["problems"]), snap["problems"])

    def test_truncated_active_query_is_incomplete(self):
        live = [{"threadId": f"live-{i}", "state": "running", "worktreePath": f"/w/{i}",
                 "creationSource": "web", "updatedAtMs": NOW_MS} for i in range(500)]
        self.serve(threads=live, honor_filters=True, opencode={})
        self.stub.total_override = 620
        self.stub.override_kind = "active"
        snap = self.read_snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("active" in p and "truncated" in p for p in snap["problems"]), snap["problems"])

    def test_native_query_error_is_incomplete(self):
        live = [{"threadId": "live-1", "state": "running", "worktreePath": "/w/1",
                 "creationSource": "web", "updatedAtMs": NOW_MS}]
        self.serve(threads=live, honor_filters=True, opencode={}, control_ok=True)
        self.stub.native_fail = True
        snap = self.read_snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("native" in p for p in snap["problems"]), snap["problems"])

    def test_active_query_error_is_incomplete(self):
        native = [{"threadId": "native-1", "state": "idle", "worktreePath": "/w/n",
                   "creationSource": "provider", "relationshipToParent": "subagent",
                   "updatedAtMs": NOW_MS}]
        self.serve(threads=native, honor_filters=True, opencode={})
        self.stub.active_fail = True
        snap = self.read_snapshot()
        self.assertFalse(snap["complete"])
        self.assertTrue(any("active" in p for p in snap["problems"]), snap["problems"])


class RootWorkspaceTests(JanitorTestCase):
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
        self.assertEqual(native, {"ses_a": "/work/service", "thread:thread-root": "/Users/x/repo"})
        self.assertEqual(len([r for r in stub.requests if "/projects" in r]), 1, stub.requests)

    def test_snapshot_reads_each_source_once(self):
        # The workspaces come from the same read as the threads, so /projects is asked for once per snapshot.
        root = {"threadId": "thread-root", "state": "running", "worktreePath": None, "projectId": "proj-1"}
        stub = self.serve(threads=[root], opencode={}, projects=[{"projectId": "proj-1", "workspaceRoot": "/r"}])
        active.snapshot()
        projects_reads = [r for r in stub.requests if "/projects" in r]
        self.assertEqual(len(projects_reads), 1, stub.requests)


class JanitorKeepsEverythingTests(JanitorTestCase):
    """An incomplete active set must keep every resource and every worktree, never reap."""

    def setUp(self):
        patch.object(active.time, 'sleep').start()
        self.addCleanup(patch.stopall)

    def test_dev_janitor_scan_keeps_every_resource_when_the_snapshot_is_incomplete(self):
        import dev_janitor
        resources = [{"id": "sim:1", "kind": "simulator", "age_s": 99999, "tokens": ["x"]}]
        with patch.object(dev_janitor.active_sessions, "snapshot", return_value={"complete": False, "threads": {}, "workspaces": {}, "opencode": set(), "problems": ["down"]}), \
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
        with patch.object(worktree_reaper.active_sessions, "snapshot", return_value={
                "complete": False, "threads": {}, "opencode": set(), "problems": ["down"]}):
            with self.assertRaises(RuntimeError):
                worktree_reaper.running_dirs()

    def test_worktree_of_a_running_claude_thread_is_protected(self):
        import worktree_reaper
        # running_dirs reads the workspaces from the one complete snapshot. The snapshot is patched so the test
        # stays off the live control API and checks only that the claude workspace is protected.
        complete = {"complete": True, "opencode": set(), "threads": {}, "problems": [],
                    "workspaces": {"thread-claude": "/work/claude-task"}}
        with patch.object(worktree_reaper.active_sessions, "snapshot", return_value=complete):
            dirs = worktree_reaper.running_dirs()
        self.assertIn("/work/claude-task", dirs)

    def test_running_dirs_takes_one_snapshot_and_keeps_its_workspaces(self):
        # The reaper must not read the sources a second time for the workspaces. One snapshot gives both the
        # opencode directories and the workspaces, and a later failure can't empty the protected set.
        import worktree_reaper
        complete = {"complete": True, "opencode": set(), "threads": {}, "problems": [],
                    "workspaces": {"thread-root": "/Users/x/repo"}}
        with patch.object(worktree_reaper.active_sessions, "snapshot", return_value=complete) as snap:
            dirs = worktree_reaper.running_dirs()
        self.assertEqual(snap.call_count, 1)
        self.assertIn("/Users/x/repo", dirs)

    def test_incomplete_snapshot_makes_running_dirs_raise_not_protect_nothing(self):
        import worktree_reaper
        incomplete = {"complete": False, "opencode": set(), "threads": {}, "workspaces": {},
                      "problems": ["control api projects: status 503"]}
        with patch.object(worktree_reaper.active_sessions, "snapshot", return_value=incomplete):
            with self.assertRaises(RuntimeError):
                worktree_reaper.running_dirs()

    def test_reaper_removes_nothing_when_the_recheck_snapshot_fails(self):
        # The first read is healthy and the worktree is stale, so it reaches the re-check right before removal. The
        # re-check's read fails: main() must remove nothing and report an error.
        import contextlib
        import io
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
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack, \
                contextlib.redirect_stdout(io.StringIO()):
            stack.enter_context(patch.object(wr, "LOG_DIR", tmp))
            stack.enter_context(patch.object(wr, "STATUS", os.path.join(tmp, "status.json")))
            stack.enter_context(patch.object(wr, "AUDIT", os.path.join(tmp, "audit.jsonl")))
            stack.enter_context(patch.object(wr.active_sessions, "snapshot", side_effect=[healthy, failing, failing]))
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




class ControlPaginationTests(JanitorTestCase):
    query = '/threads?projectId=p&includeSubagents=true&limit=500&updatedSince=10'

    def row(self, tid, updated='2026-11-01T00:00:00Z', **fields):
        return dict(threadId=tid, state='idle', updatedAt=updated, **fields)

    def page(self, ids=(), total=None, cursor=None):
        rows = [self.row(tid) if isinstance(tid, str) else tid for tid in ids]
        return 200, dict(ok=True, threads=rows, total=len(rows) if total is None else total, nextCursor=cursor)

    def read(self, pages, **kwargs):
        with patch.object(active, '_control_get', side_effect=pages) as api:
            result = active._control_threads(self.query, 60, 'test', **kwargs)
        return result, api

    def test_three_pages_and_catch_up_merge_in_full(self):
        stats = {}
        with patch.object(active.time, 'time', return_value=NOW_MS / 1000):
            (rows, error), api = self.read([self.page(['a'], 3, 'a&+'), self.page(['b'], 3, 'b'),
                                          self.page(['c'], 3), self.page()], stats=stats)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b', 'c'})
        params = [parse_qs(urlparse(c.args[0]).query) for c in api.call_args_list]
        self.assertEqual(params[1]['cursor'], ['a&+'])
        self.assertEqual(params[2]['cursor'], ['b'])
        self.assertNotIn('cursor', params[3])
        self.assertEqual(params[3]['updatedSince'], [str(NOW_MS - 5000)])
        for q in params:
            self.assertEqual(q['limit'], ['500'])
            self.assertEqual(q['projectId'], ['p'])
            self.assertEqual(q['includeSubagents'], ['true'])
        self.assertTrue(all(c.args[1] == 60 for c in api.call_args_list))
        self.assertEqual({k: stats[k] for k in ('pages', 'rows', 'catch_up_rows', 'unique_rows', 'total')},
                         dict(pages=4, rows=3, catch_up_rows=0, unique_rows=3, total=3))

    def test_mid_walk_update_is_recovered_and_later_row_wins(self):
        newer = self.row('a', '2026-11-15T00:00:00Z')
        moved = self.row('moved', '2026-11-15T00:00:00Z')
        (rows, error), _ = self.read([self.page(['a'], 3, 'a'), self.page(['b'], 3),
                                    self.page([newer], 2, 'catch'), self.page([moved], 2)])
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b', 'moved'})
        self.assertEqual(rows['a'], newer)

    def test_duplicate_walk_rows_keep_newest_and_catch_up_can_add_extra_ids(self):
        newer = self.row('a', '2026-11-02T00:00:00Z')
        (rows, error), _ = self.read([self.page([newer], 2, 'one'), self.page(['a', 'b'], 2),
                                    self.page(['new'])])
        self.assertIsNone(error)
        self.assertEqual(rows['a'], newer)
        self.assertEqual(set(rows), {'a', 'b', 'new'})

    def test_short_after_catch_up_returns_no_partial_map(self):
        stats = {}
        (rows, error), _ = self.read([self.page(['a'], 3), self.page(['b']),
                                    self.page(['a'], 3), self.page(['b'])], stats=stats)
        self.assertIsNone(rows)
        self.assertIn('short by 1 after retry', error)
        self.assertTrue(stats['retried'])

    def test_growing_total_is_covered_by_catch_up(self):
        stats = {}
        (rows, error), _ = self.read([self.page(['a'], 2, 'next'), self.page(['b'], 3),
                                    self.page(['new'])], stats=stats)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b', 'new'})
        self.assertEqual(stats['totals'], dict(first=2, last=3, min=2, max=3))
        self.assertFalse(stats['retried'])

    def test_shrinking_total_after_archival_is_not_a_gap(self):
        for first_rows, first_total, last_total in [(['a'], 3, 2), (['a', 'archived'], 3, 2)]:
            with self.subTest(first_rows=first_rows):
                stats = {}
                (rows, error), _ = self.read([self.page(first_rows, first_total, 'next'),
                                            self.page(['b'], last_total), self.page()], stats=stats)
                self.assertIsNone(error)
                self.assertGreaterEqual(len(rows), last_total)
                self.assertEqual(stats['totals'], dict(first=3, last=2, min=2, max=3))
                self.assertFalse(stats['retried'])

    def test_real_gap_retries_from_scratch_then_fails(self):
        stats = {}
        (rows, error), api = self.read([self.page(['a'], 2), self.page(),
                                      self.page(['a'], 2), self.page()], stats=stats)
        self.assertIsNone(rows)
        self.assertEqual(error, 'control api test: short by 1 after retry')
        self.assertEqual(api.call_count, 4)
        self.assertTrue(stats['retried'])

    def test_retry_closes_gap_and_uses_a_new_catch_up_window(self):
        stats = {}
        with patch.object(active.time, 'time', side_effect=[100, 110]):
            (rows, error), api = self.read([self.page(['a'], 2), self.page(),
                                          self.page(['a'], 2, 'next'), self.page(['b'], 2),
                                          self.page()], stats=stats)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b'})
        self.assertTrue(stats['retried'])
        self.assertNotIn('cursor', parse_qs(urlparse(api.call_args_list[2].args[0]).query))
        self.assertEqual(parse_qs(urlparse(api.call_args_list[1].args[0]).query)['updatedSince'], ['95000'])
        self.assertEqual(parse_qs(urlparse(api.call_args_list[-1].args[0]).query)['updatedSince'], ['105000'])

    def test_catch_up_total_churn_uses_last_total(self):
        for last_rows, last_total, expected in [(['new'], 3, {'a', 'b', 'new'}), ([], 1, {'a', 'b'})]:
            with self.subTest(last_total=last_total):
                stats = {}
                (rows, error), _ = self.read([self.page(['a'], 2), self.page(['a', 'b'], 2, 'next'),
                                            self.page(last_rows, last_total)], stats=stats)
                self.assertIsNone(error)
                self.assertEqual(set(rows), expected)
                self.assertEqual(stats['catch_up_unique_rows'], len(expected))
                self.assertEqual(stats['catch_up_totals'], dict(first=2, last=last_total,
                                                              min=min(2, last_total), max=max(2, last_total)))
                self.assertFalse(stats['retried'])

    def test_retry_keeps_request_and_deadline_budgets_and_discards_first_partial_map(self):
        with patch.object(active, 'CONTROL_MAX_PAGES', 2):
            (rows, error), api = self.read([self.page(['a'], 2), self.page()])
        self.assertIsNone(rows)
        self.assertIn('page cap', error)
        self.assertEqual(api.call_count, 2)
        # The second attempt cannot fill its own gap with a discarded first-attempt row.
        (rows, error), _ = self.read([self.page(['a'], 2), self.page(),
                                    self.page(['b'], 2), self.page()])
        self.assertIsNone(rows)
        self.assertIn('short by 1 after retry', error)
        with patch.object(active.time, 'monotonic', side_effect=[0, 0, 0, 0, 0, 0, 181, 182]):
            (rows, error), api = self.read([self.page(['a'], 2), self.page()])
        self.assertIsNone(rows)
        self.assertIn('deadline exceeded', error)
        self.assertEqual(api.call_count, 2)

    def test_oscillating_totals_use_last_main_total_and_log_extrema(self):
        stats = {}
        (rows, error), _ = self.read([self.page(['a'], 2, 'one'), self.page(['b'], 4, 'two'),
                                    self.page(['c'], 3), self.page()], stats=stats)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b', 'c'})
        self.assertEqual(stats['totals'], dict(first=2, last=3, min=2, max=4))
        self.assertFalse(stats['retried'])

    def test_new_id_cannot_mask_incomplete_catch_up_and_retry_recovers_moving_row(self):
        ids = [f'A{i:03}' for i in range(500)]
        # B jumps ahead of the main cursor, then both B and C precede the catch-up cursor.
        incomplete = [self.page(ids, 501, 'walk'), self.page([], 501),
                      self.page(['C'] + ids[:499], 502, 'catch-up'), self.page(ids[499:], 502)]
        for closes_gap in (False, True):
            with self.subTest(closes_gap=closes_gap):
                updated_b = self.row('B', '2026-11-15T00:00:00Z', worktreePath='/new')
                retry = ([self.page(['B', 'C'] + ids[:498], 502, 'retry'),
                          self.page(ids[498:], 502), self.page([updated_b])] if closes_gap else incomplete)
                stats = {}
                (rows, error), api = self.read(incomplete + retry, stats=stats)
                self.assertTrue(stats['retried'])
                if closes_gap:
                    self.assertIsNone(error)
                    self.assertEqual(set(rows), set(ids) | {'B', 'C'})
                    self.assertEqual(rows['B']['worktreePath'], '/new')
                    self.assertEqual(api.call_count, 7)
                else:
                    self.assertIsNone(rows)
                    self.assertIn('catch-up short by 1 after retry', error)
                    self.assertEqual(stats['failure_phase'], 'catch-up')
                    self.assertEqual(stats['catch_up_unique_rows'], 501)
                    self.assertEqual(api.call_count, 8)

    def test_complete_main_cannot_hide_missing_or_duplicate_catch_up_ids(self):
        for fresh in (['a'], ['a', 'a']):
            with self.subTest(fresh=fresh):
                attempt = [self.page(['a', 'b'], 2), self.page(fresh, 2)]
                stats = {}
                (rows, error), api = self.read(attempt * 2, stats=stats)
                self.assertIsNone(rows)
                self.assertIn('catch-up short by 1 after retry', error)
                self.assertEqual(stats['unique_rows'], 2)
                self.assertEqual(stats['catch_up_unique_rows'], 1)
                self.assertTrue(stats['retried'])
                self.assertEqual(api.call_count, 4)

    def test_short_catch_up_retry_keeps_shared_budgets(self):
        pages = [self.page(['a', 'b'], 2), self.page(['a'], 2)]
        with patch.object(active, 'CONTROL_MAX_PAGES', 2):
            (rows, error), api = self.read(pages)
        self.assertIsNone(rows)
        self.assertIn('page cap exceeded', error)
        self.assertEqual(api.call_count, 2)
        with patch.object(active.time, 'monotonic', side_effect=[0, 0, 0, 0, 0, 0, 181, 182]):
            (rows, error), api = self.read(pages)
        self.assertIsNone(rows)
        self.assertIn('deadline exceeded', error)
        self.assertEqual(api.call_count, 2)

    def test_legacy_server_behavior(self):
        cases = [(['a'], 2, '2 threads, only 1 returned (truncated)'),
                 (['a'], 1, None), (['a', 'a'], 2, 'duplicate thread ids'),
                 (['a'], 0, 'malformed roster')]
        for ids, total, expected in cases:
            with self.subTest(ids=ids, total=total):
                status, body = self.page(ids, total)
                del body['nextCursor']
                (rows, error), api = self.read([(status, body)])
                self.assertEqual(api.call_count, 1)
                if expected:
                    self.assertIsNone(rows)
                    self.assertEqual(error, 'control api test: ' + expected)
                else:
                    self.assertEqual(set(rows), {'a'})
                    self.assertIsNone(error)

    def test_failed_and_malformed_pages_never_return_partial_roster_in_either_pass(self):
        invalid = [
            ((503, None), 'status 503'), ((0, 'timed out'), 'timed out'),
            ((200, []), 'malformed response'), ((200, {'ok': False}), 'malformed response'),
            ((200, {'ok': True, 'threads': {}, 'total': 2}), 'unreadable thread list'),
            ((200, {'ok': True, 'threads': [], 'total': True}), 'unreadable thread list'),
            ((200, {'ok': True, 'threads': [], 'total': -1}), 'unreadable thread list'),
            (self.page([{'threadId': '', 'state': 'idle'}], 2), 'malformed roster'),
            (self.page([dict(threadId='b', state='unknown')], 2), 'malformed roster'),
            (self.page([dict(threadId='b', state=[])], 2), 'malformed roster'),
            (self.page([dict(threadId='b', state='idle')], 2), 'updatedAt unavailable'),
            (self.page([self.row('b', 'invalid')], 2), 'updatedAt unavailable'),
            (self.page([self.row('b', '2026-11-01')], 2), 'updatedAt unavailable'),
            ((200, dict(ok=True, threads=[], total=2)), 'nextCursor missing during traversal'),
        ]
        for pass_name in ('walk', 'catch-up'):
            for bad, expected in invalid:
                with self.subTest(pass_name=pass_name, bad=bad):
                    prefix = [] if pass_name == 'walk' else [self.page(['z'])]
                    (rows, error), _ = self.read(prefix + [self.page(['a'], 2, 'next'), bad])
                    self.assertIsNone(rows)
                    self.assertIn(expected, error)

    def test_cursor_shapes_and_repeats_fail_closed_in_either_pass(self):
        for phase in ('walk', 'catch-up'):
            for cursor in ('repeat', '', 1, False, [], {}):
                with self.subTest(phase=phase, cursor=cursor):
                    prefix = [] if phase == 'walk' else [self.page(['z'])]
                    pages = prefix + [self.page(['a'], 2, 'repeat'), self.page(['b'], 2, cursor)]
                    (rows, error), _ = self.read(pages)
                    self.assertIsNone(rows)
                    self.assertIn('repeated cursor' if cursor == 'repeat' else 'invalid nextCursor', error)

    def test_page_budget_covers_catch_up_and_never_sends_page_401(self):
        pages = [self.page([str(i)], 400, str(i)) for i in range(400)]
        (rows, error), api = self.read(pages)
        self.assertIsNone(rows)
        self.assertIn('page cap exceeded (400)', error)
        self.assertEqual(api.call_count, 400)
        with patch.object(active, 'CONTROL_MAX_PAGES', 2):
            (rows, error), api = self.read([self.page(['a']), self.page(['b'], 2, 'next')])
        self.assertIsNone(rows)
        self.assertIn('page cap', error)
        self.assertEqual(api.call_count, 2)

    def test_deadline_before_page_after_slow_page_and_during_catch_up(self):
        for ticks, pages, expected_calls in [([0, 181], [], 0),
                                            ([0, 0, 181], [self.page(['a'])], 1),
                                            ([0, 0, 0, 181], [self.page(['a'])], 1),
                                            ([0, 0, 0, 0, 181], [self.page(['a']), self.page()], 2)]:
            with self.subTest(ticks=ticks), patch.object(active.time, 'monotonic', side_effect=ticks + [182]):
                (rows, error), api = self.read(pages)
            self.assertIsNone(rows)
            self.assertIn('traversal deadline exceeded', error)
            self.assertEqual(api.call_count, expected_calls)
        with patch.object(active.time, 'monotonic', side_effect=[0, 2, 3]):
            (rows, error), _ = self.read([], traversal_timeout=1)
        self.assertIsNone(rows)
        self.assertIn('deadline', error)

    def test_legacy_catch_up_is_incomplete(self):
        for page, expected in [((200, dict(ok=True, threads=[], total=0)), 'nextCursor missing')]:
            with self.subTest(page=page):
                (rows, error), _ = self.read([self.page(['a']), page])
                self.assertIsNone(rows)
                self.assertIn(expected, error)

    def test_project_history_pages_both_listings_and_records_archival_activity(self):
        archived = self.row('c', worktreePath='/tree', archivedAt='2026-11-14T00:00:00Z')
        stats = {}
        pages = [self.page(['a'], 2, 'live'), self.page(['b'], 2), self.page(),
                 self.page([archived], 2, 'archive'), self.page(['d'], 2), self.page()]
        with patch.object(active, '_control_get', side_effect=pages) as api:
            paths, error = active.project_activity('p', '/root', 10, stats=stats)
        self.assertIsNone(error)
        import datetime
        self.assertEqual(paths['/tree'], datetime.datetime(2026, 11, 14, tzinfo=datetime.timezone.utc).timestamp())
        self.assertEqual(set(paths), {'/tree', '/root'})
        queries = [parse_qs(urlparse(c.args[0]).query) for c in api.call_args_list]
        self.assertEqual(queries[1]['cursor'], ['live'])
        self.assertEqual(queries[4]['cursor'], ['archive'])
        self.assertTrue(all(q.get('archived') == ['true'] for q in queries[3:]))
        self.assertEqual({k: stats[k] for k in ('pages', 'rows', 'archived_rows', 'catch_up_rows')},
                         dict(pages=6, rows=4, archived_rows=2, catch_up_rows=0))

    def test_active_and_native_callers_paginate_without_changing_request_timeouts(self):
        pages = [self.page(['a'], 2, 'active'), self.page(['b'], 2), self.page(),
                 self.page(['c'], 2, 'native'), self.page(['d'], 2), self.page()]
        with patch.object(active, '_control_get', side_effect=pages) as api:
            rows, error = active.robob_active(timeout=7, now_ms=NOW_MS)
        self.assertIsNone(error)
        self.assertEqual(set(rows), {'a', 'b', 'c', 'd'})
        queries = [parse_qs(urlparse(c.args[0]).query) for c in api.call_args_list]
        self.assertTrue(all(q['active'] == ['true'] for q in queries[:3]))
        self.assertTrue(all(q['creationSource'] == ['provider'] for q in queries[3:]))
        self.assertEqual([c.args[1] for c in api.call_args_list], [7, 7, 7, 60, 60, 60])

    def test_reaper_status_records_project_metrics_and_exact_failures(self):
        import contextlib
        import io
        import worktree_reaper as reaper
        for failed in (False, True):
            with self.subTest(failed=failed):
                history = reaper.Activity({}, {'p': '/repo'}, {}, None)
                history.commons = {'p': '/repo.git'}
                pages = ([self.page(['a'], 2, 'next'), (503, None)] if failed else
                         [self.page(['a']), self.page(), self.page(), self.page()])
                with patch.object(reaper, 'running_dirs', return_value=set()), \
                        patch.object(reaper, 'session_activity', return_value=history), \
                        patch.object(reaper, 'process_cwds', return_value=[]), \
                        patch.object(reaper, 'keep_list', return_value=[]), \
                        patch.object(reaper, 'discover', return_value=['/repo.git']), \
                        patch.object(reaper, 'worktrees', return_value=([
                            dict(main=True, common='/repo.git', worktree='/repo')], None)), \
                        patch.object(active, '_control_get', side_effect=pages), \
                        patch.object(sys, 'argv', ['reaper', '--dry-run']), \
                        contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(reaper.main(), 0)
                status = json.loads(out.getvalue())
                metrics = status['project_history_stats']['p']
                self.assertEqual(metrics['pages'], 2 if failed else 4)
                self.assertEqual(metrics['rows'], 1)
                self.assertEqual(metrics['common'], '/repo.git')
                if failed:
                    reason = 'control api history p archived=False: status 503'
                    self.assertEqual(status['activity_history_unavailable'], {'/repo.git': reason})
                    self.assertEqual(metrics['error'], reason)
                    self.assertEqual(status['repo_outcomes']['/repo.git']['history_error'], reason)
                else:
                    self.assertEqual(status['activity_history_unavailable'], {})
                    self.assertEqual(status['repo_outcomes']['/repo.git']['kept'], {'main_worktree': 1})
                self.assertEqual(status['removed'], [])

    def test_project_failure_keeps_exact_reason_and_statistics(self):
        stats = {}
        with patch.object(active, '_control_get', side_effect=[self.page(['a'], 2, 'next'), (503, None)]):
            paths, error = active.project_activity('p', '/root', 10, stats=stats)
        self.assertIsNone(paths)
        self.assertIn('status 503', error)
        self.assertEqual(stats['error'], error)
        self.assertEqual(stats['pages'], 2)
        self.assertEqual(stats['rows'], 1)
        self.assertIn('seconds', stats)


if __name__ == "__main__":
    unittest.main()
