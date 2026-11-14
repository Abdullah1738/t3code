"""Config recovery tests use temporary files and a fake OpenCode HTTP service."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.parse

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import config_drift as drift
import location_reaper as reaper


class ConfigDrift(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.config = self.home / ".config/opencode"
        self.config.mkdir(parents=True)
        self.file = self.config / "opencode.jsonc"
        self.file.write_text('{"model":"one"}')
        self.logs = self.root / "logs"
        self.service_log = self.root / "service.log"
        self.service_log.write_text("Events were dropped\nnormal\n")
        self.other = self.root / "project"
        self.other.mkdir()
        self.loaded = [str(self.other), str(self.home)]
        self.active = {}
        self.sid_dir = {"ses_home": str(self.home), "ses_other": str(self.other)}
        self.pending = {}
        self.evictions = []
        self.calls = []
        self.fail = None
        self.unsupported = False
        self.global_calls = 0
        self.on_forms = None
        self.stale = set(self.loaded)
        self.last = {}
        self.keep = set()
        self.api_patch = mock.patch.object(reaper, "api", side_effect=self.api)
        self.api_patch.start()
        self.addCleanup(self.api_patch.stop)
        snapshot = mock.patch.object(reaper, "last_activity_by_dir",
                                     side_effect=lambda: (self.last.copy(), self.sid_dir.copy()))
        snapshot.start()
        self.addCleanup(snapshot.stop)

    def entries(self, directory):
        return [{"type": "document", "path": str(self.file),
                 "info": {"model": "stale"} if directory in self.stale else json.loads(self.file.read_text())}]

    def api(self, method, path):
        route, _, query = path.partition("?")
        directory = urllib.parse.parse_qs(query).get("location[directory]", [None])[0]
        self.calls.append((method, route, directory))
        if method == "GET":
            if route == "/api/debug/location":
                return 200, [{"directory": d} for d in self.loaded]
            if route == "/api/session/active":
                return 200, {"data": self.active.copy()}
            if route == "/api/config":
                return 200, self.entries(directory)
            if route in ("/api/form", "/api/permission/request", "/api/shell"):
                if route == "/api/form" and self.on_forms:
                    self.on_forms()
                return 200, {"data": self.pending.get((route, directory), [])}
        if method == "DELETE" and route == "/api/debug/location":
            if directory not in self.loaded:  # fresh reference probe cleanup
                return 204, None
            if self.unsupported:
                raise urllib.error.HTTPError("http://fake", 405, "unsupported", {}, None)
            self.evictions.append(directory)
            if self.fail:
                raise self.fail
            self.stale.discard(directory)
            return 204, None
        if method == "POST" and route == "/api/location/reload":
            self.global_calls += 1
            self.stale.clear()
            return 204, None
        raise AssertionError((method, path))

    def run_pass(self, now=10000, dry_run=False):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = drift.run(self.loaded, self.last, self.sid_dir, self.keep,
                               logs=self.logs, home=self.home, config=self.config,
                               service_log=self.service_log, now=now, dry_run=dry_run)
        self.output = output.getvalue()
        return result

    def state(self):
        return json.loads((self.logs / "config_drift_state.json").read_text())

    def test_unchanged_hash_has_no_second_reload(self):
        first = self.run_pass()
        self.assertEqual(first["reloaded"], 2)
        self.assertEqual(self.evictions, [str(self.home), str(self.other)])
        self.evictions.clear()
        second = self.run_pass(now=10301)
        self.assertEqual(second["unchanged"], 2)
        self.assertEqual(self.evictions, [])

    def test_changed_hash_reloads_once_per_location(self):
        self.run_pass()
        self.evictions.clear()
        self.file.write_text('{"model":"two"}')
        self.assertEqual(self.run_pass(now=10301)["reloaded"], 2)
        self.assertEqual(self.run_pass(now=10602)["reloaded"], 0)
        self.assertEqual(len(self.evictions), 2)

    def test_ambiguous_plugin_refresh_stays_uncertain(self):
        self.stale.clear()
        self.fail = TimeoutError()
        self.run_pass()
        self.fail = None
        result = self.run_pass(now=10301)
        self.assertEqual(result["failed"], 2)
        self.assertEqual(len(self.evictions), 2)
        self.assertTrue(all(row.get("reason") == "uncertain-eviction"
                            for row in result["decisions"] if row["action"] == "failed"))

    def test_busy_location_deferred_until_idle(self):
        self.active = {"ses_home": {}}
        st = self.run_pass()
        self.assertEqual(st["deferred_busy"], 1)
        self.assertEqual(self.evictions, [str(self.other)])
        self.active.clear()
        self.assertEqual(self.run_pass(now=10301)["reloaded"], 1)
        self.assertEqual(self.evictions, [str(self.other), str(self.home)])

    def test_pending_forms_permissions_and_shells_defer(self):
        for route in ("/api/form", "/api/permission/request", "/api/shell"):
            with self.subTest(route=route):
                self.pending = {(route, d): [{"id": "pending"}] for d in self.loaded}
                self.assertEqual(self.run_pass()["deferred_busy"], 2)
                self.assertEqual(self.evictions, [])

    def test_recent_and_keep_rules(self):
        self.last = {str(self.home): 10000 * 1000}
        self.keep = {str(self.other)}
        self.assertEqual(self.run_pass()["deferred_busy"], 2)
        self.assertEqual(self.evictions, [])

    def test_session_starting_during_safety_probes_defers(self):
        self.on_forms = lambda: self.active.update({"ses_home": {}})
        self.run_pass()
        self.assertNotIn(str(self.home), self.evictions)

    def test_new_queued_work_in_final_snapshot_defers(self):
        with mock.patch.object(reaper, "last_activity_by_dir",
                               return_value=({d: 10000000 for d in self.loaded}, self.sid_dir)):
            self.assertEqual(self.run_pass()["deferred_busy"], 2)
        self.assertEqual(self.evictions, [])

    def test_malformed_safety_response_fails_closed(self):
        original = self.api
        def malformed(method, path):
            if path.startswith("/api/permission/request"):
                return 200, {"unexpected": []}
            return original(method, path)
        with mock.patch.object(reaper, "api", side_effect=malformed):
            self.assertEqual(self.run_pass()["failed"], 2)
        self.assertEqual(self.evictions, [])

    def test_active_mapping_failure_fails_closed(self):
        self.active = {"unknown": {}}
        with mock.patch.object(reaper, "running_dirs", return_value=(set(), ["unknown"])):
            self.assertEqual(self.run_pass()["deferred_busy"], 2)
        self.assertEqual(self.evictions, [])

    def test_failure_retries_next_cadence_without_tight_loop(self):
        self.fail = urllib.error.HTTPError("http://fake", 500, "failed", {}, None)
        self.assertEqual(self.run_pass()["failed"], 2)
        self.assertIn('"action": "failed"', self.output)
        self.assertEqual(len(self.evictions), 2)
        self.run_pass(now=10001)
        self.assertEqual(len(self.evictions), 2)
        self.fail = None
        self.assertEqual(self.run_pass(now=10301)["reloaded"], 2)
        self.assertEqual(self.run_pass(now=10602)["reloaded"], 0)

    def test_ambiguous_eviction_is_reconciled_without_repeat(self):
        self.fail = TimeoutError()
        self.run_pass()
        # The request applied but its response was lost.
        self.stale.clear()
        self.fail = None
        self.assertEqual(self.run_pass(now=10301)["reconciled"], 2)
        self.assertEqual(len(self.evictions), 2)

    def test_global_fallback_blocks_any_active_session(self):
        self.unsupported = True
        self.active = {"ses_other": {}}
        self.run_pass()
        self.assertEqual(self.global_calls, 0)

    def test_global_fallback_checks_all_forms_and_shells(self):
        self.unsupported = True
        for route in ("/api/form", "/api/permission/request", "/api/shell"):
            with self.subTest(route=route):
                self.pending = {(route, str(self.other)): [{}]}
                self.run_pass()
                self.assertEqual(self.global_calls, 0)

    def test_global_fallback_once_and_ten_minute_cooldown(self):
        self.unsupported = True
        self.assertEqual(self.run_pass()["reloaded"], 1)
        self.run_pass(now=10301)
        self.assertEqual(self.global_calls, 1)
        self.file.write_text('{"model":"two"}')
        self.run_pass(now=10302)
        self.assertEqual(self.global_calls, 1)
        self.run_pass(now=10603)
        self.assertEqual(self.global_calls, 2)

    def test_404_never_triggers_global_reload(self):
        self.fail = urllib.error.HTTPError("http://fake", 404, "gone", {}, None)
        self.run_pass()
        self.assertEqual(self.global_calls, 0)

    def test_dry_run_has_no_mutations_or_state_writes(self):
        st = self.run_pass(dry_run=True)
        self.assertEqual(st["would_reload"], 2)
        self.assertFalse(self.logs.exists())
        self.assertFalse(any(m != "GET" for m, _, _ in self.calls))

    def test_dropped_log_cursor_append_truncate_rotate_partial(self):
        self.run_pass()
        self.assertEqual(self.state()["dropped_events_total"], 1)
        with self.service_log.open("a") as f:
            f.write("Events were dropped\nEvents were dropped")
        self.assertEqual(self.run_pass()["dropped_events_new"], 1)
        with self.service_log.open("a") as f:
            f.write("\n")
        self.assertEqual(self.run_pass()["dropped_events_new"], 1)
        self.service_log.write_text("Events were dropped\n")
        self.assertEqual(self.run_pass()["dropped_events_new"], 1)
        self.service_log.rename(self.root / "rotated.log")
        self.service_log.write_text("Events were dropped\n")
        self.assertEqual(self.run_pass()["dropped_events_new"], 1)

    def test_plugin_project_and_symlink_inputs_change_hash(self):
        self.run_pass()
        plugin = self.config / "plugin"
        plugin.mkdir()
        target = self.root / "outside.ts"
        target.write_text("one")
        (plugin / "test.ts").symlink_to(target)
        self.assertEqual(self.run_pass(now=10301)["reloaded"], 2)
        target.write_text("two")
        self.assertEqual(self.run_pass(now=10602)["reloaded"], 2)
        self.evictions.clear()
        (self.other / "opencode.json").write_text("{}")
        self.assertEqual(self.run_pass(now=10903)["reloaded"], 1)
        self.assertEqual(self.evictions, [str(self.other)])

    def test_compatibility_skills_are_hashed_but_transcripts_are_not(self):
        self.run_pass()
        transcript = self.home / ".claude/projects/session.jsonl"
        transcript.parent.mkdir(parents=True)
        transcript.write_text("new turn")
        self.assertEqual(self.run_pass(now=10301)["reloaded"], 0)
        skill = self.home / ".claude/skills/test/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("skill")
        self.assertEqual(self.run_pass(now=10602)["reloaded"], 2)

    def test_input_creation_deletion_and_ignored_trees(self):
        for relative, changes in [("opencode.json", True), ("opencode.jsonc", True),
                                  (".opencode/plugin/a.ts", True), (".agents/skills/x/SKILL.md", True),
                                  (".claude/skills/x/SKILL.md", True),
                                  (".opencode/node_modules/x/index.js", False),
                                  (".opencode/.git/HEAD", False)]:
            with self.subTest(relative=relative):
                p = self.other / relative
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("one")
                before = drift.content_hash(drift.inputs(self.other, self.home, self.config))
                p.write_text("two")
                after = drift.content_hash(drift.inputs(self.other, self.home, self.config))
                self.assertEqual(before != after, changes)
                p.unlink()
                deleted = drift.content_hash(drift.inputs(self.other, self.home, self.config))
                self.assertEqual(after != deleted, changes)

    def test_corrupt_state_fails_closed(self):
        self.logs.mkdir()
        (self.logs / "config_drift_state.json").write_text("broken")
        self.assertEqual(self.run_pass()["state"], "error")
        self.assertEqual(self.evictions, [])

    def test_workspace_ref_is_never_evicted_with_directory_only_query(self):
        with contextlib.redirect_stdout(io.StringIO()):
            st = drift.run([{"directory": str(self.home), "workspaceID": "workspace-one"}],
                           {}, {}, set(), logs=self.logs, home=self.home, config=self.config,
                           service_log=self.service_log, now=10000)
        self.assertEqual(st["deferred_busy"], 1)
        self.assertEqual(self.evictions, [])

    def test_running_dirs_rejects_malformed_active_response(self):
        with mock.patch.object(reaper, "api", return_value=(200, {})):
            with self.assertRaises(ValueError):
                reaper.running_dirs({})

    def test_concurrent_run_does_not_mutate_or_overwrite_status(self):
        import fcntl
        self.logs.mkdir()
        with (self.logs / "config_drift.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_pass()["state"], "locked")
        self.assertEqual(self.evictions, [])
        self.assertFalse((self.logs / "config_drift_last.json").exists())

    def test_state_contains_hashes_without_resolved_secrets(self):
        self.file.write_text('{"token":"secret-value"}')
        self.run_pass()
        self.assertNotIn("secret-value", (self.logs / "config_drift_state.json").read_text())
        self.assertNotIn("secret-value", self.output)


if __name__ == "__main__":
    unittest.main()
