import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("shadow_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class ShadowCheckTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.root = self.base / "scratch"
        self.root.mkdir()
        self.state = self.base / "watch"
        self.state.mkdir()

    def touch(self, name, text="raise RuntimeError('must never run')"):
        path = self.root / name
        path.write_text(text)
        return path

    def run_check(self, run):
        return check.check(self.state, check.scan([self.root]), run)

    def test_import_forms_and_metadata_without_loading_files(self):
        names = ["inspect.py", "queue.py", "queue.pyc", "pytest.py", "conftest.py",
                 "requests.py", "yaml.py", "typing_extensions.py", "sitecustomize.py",
                 "usercustomize.py", "random" + importlib.machinery.EXTENSION_SUFFIXES[0]]
        for name in names:
            self.touch(name)
        package = self.root / "logging"
        package.mkdir()
        (package / "__init__.py").write_text("raise RuntimeError('package must never run')")
        namespace = self.root / "email"
        namespace.mkdir()
        self.touch("harmless_scratch.py")
        (self.root / "__pycache__").mkdir()
        (self.root / "__pycache__" / "inspect.cpython-315.pyc").write_bytes(b"not imported")
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with patch.object(Path, "read_text", side_effect=AssertionError("read scratch content")):
            report = check.scan([self.root, alias, self.base / "absent"])
        self.assertEqual({Path(f["path"]).name for f in report["findings"]}, set(names) | {"logging"})
        self.assertEqual(len(report["roots"]), 2)
        self.assertEqual(report["roots"][0]["namespace_candidates"], [str(namespace.resolve())])
        for item in report["findings"]:
            stat = Path(item["path"]).stat()
            self.assertEqual(item["size"], stat.st_size)
            self.assertTrue(item["mtime_utc"].endswith("+00:00"))

    def test_baseline_replay_ack_and_new_file(self):
        self.touch("inspect.py")
        self.assertEqual(self.run_check("r0"), "")
        self.touch("queue.py")
        first = self.run_check("r1")
        self.assertIn("queue.py", first)
        self.assertNotIn("inspect.py", first)
        self.assertEqual(self.run_check("r2"), first)
        (self.state / ".run-ok").write_text("r2\n")
        self.assertEqual(self.run_check("r3"), "")
        self.touch("requests.py")
        self.assertIn("requests.py", self.run_check("r4"))
        self.assertTrue((self.root / "queue.py").exists())

    def test_runner_acceptance_and_crash_windows(self):
        cases = [
            ("no-runner-state", None, None, None, True),
            ("unchanged-fires", 7, {"fires": 7}, None, True),
            ("old-delivery", 7, {"fires": 7, "last_fire_at": "2026-11-12T12:00:00Z"}, None, True),
            ("check-failed", 7, {"fires": 7, "consecutive_failures": 5}, None, True),
            ("unrelated-pending", 7, {"fires": 7, "pending": {"event": "another event"}}, None, True),
            ("unrelated-batch", 7, {"fires": 7, "batch": {"events": ["another event"]}}, None, True),
            ("accepted-batch-before-ack", 7, {"fires": 7, "batch": {"events": ["MATCH"]}}, None, False),
            ("stale-ack", 7, {"fires": 7}, "older-run", True),
            ("accepted-ack", 7, {"fires": 7}, "r1", False),
            ("accepted-before-ack", 7, {"fires": 7, "pending": {"event": "MATCH"}}, None, False),
            ("first-delivery-before-ack", None, {"fires": 1, "last_fire_at": "2026-11-13T00:01:00Z"}, None, False),
            ("delivered-before-ack", 7, {"fires": 8, "last_fire_at": "2026-11-13T00:01:00Z"}, None, False),
        ]
        for name, initial_fires, runner_after, ack, replay in cases:
            with self.subTest(name=name):
                watch_dir = self.base / name
                watch_dir.mkdir()
                root = watch_dir / "scratch"
                root.mkdir()
                runner_file = watch_dir / "state.json"
                if initial_fires is not None:
                    runner_file.write_text(json.dumps({"fires": initial_fires}))
                self.assertEqual(check.check(watch_dir, check.scan([root]), "r0"), "")
                (root / "queue.py").write_text("must never execute")
                first = check.check(watch_dir, check.scan([root]), "r1")
                self.assertIn("queue.py", first)
                if runner_after is not None:
                    if name == "accepted-before-ack":
                        runner_after["pending"]["event"] = first
                    if runner_after.get("batch") and runner_after["batch"]["events"] == ["MATCH"]:
                        runner_after["batch"]["events"] = [first]
                    runner_file.write_text(json.dumps(runner_after))
                if ack is not None:
                    (watch_dir / ".run-ok").write_text(ack)
                self.assertEqual(check.check(watch_dir, check.scan([root]), "r2"), first if replay else "")
                if replay:
                    (watch_dir / ".run-ok").write_text("r2")
                self.assertEqual(check.check(watch_dir, check.scan([root]), "r3"), "")
                # Acceptance of the old batch must not swallow a later finding.
                (root / "requests.py").write_text("must never execute")
                next_event = check.check(watch_dir, check.scan([root]), "r4")
                self.assertIn("requests.py", next_event)
                self.assertNotIn("queue.py", next_event)

    def test_delivery_after_replayed_output_without_ack(self):
        runner_file = self.state / "state.json"
        runner_file.write_text(json.dumps({"fires": 3}))
        self.assertEqual(self.run_check("r0"), "")
        self.touch("queue.py")
        first = self.run_check("r1")
        self.assertEqual(self.run_check("r2"), first)
        runner_file.write_text(json.dumps({"fires": 4, "last_fire_at": "2026-11-13T00:01:00Z"}))
        self.assertEqual(self.run_check("r3"), "")
        self.assertEqual(self.run_check("r4"), "")

    def test_invalid_runner_state_does_not_advance_outbox(self):
        self.assertEqual(self.run_check("r0"), "")
        self.touch("queue.py")
        first = self.run_check("r1")
        outbox = (self.state / "shadow-seen.json").read_bytes()
        for runner in ["not json", "[]", '{"fires": "1"}', '{"fires": true}', '{"fires": -1}']:
            with self.subTest(runner=runner):
                (self.state / "state.json").write_text(runner)
                with self.assertRaises(ValueError):
                    self.run_check("r2")
                self.assertEqual((self.state / "shadow-seen.json").read_bytes(), outbox)
        (self.state / "state.json").write_text('{"fires": 0}')
        self.assertEqual(self.run_check("r3"), first)

    def test_legacy_outbox_without_counter_needs_acceptance_evidence(self):
        self.assertEqual(self.run_check("r0"), "")
        self.touch("queue.py")
        first = self.run_check("r1")
        path = self.state / "shadow-seen.json"
        outbox = json.loads(path.read_text())
        del outbox["pending"]["fires"]
        path.write_text(json.dumps(outbox))
        runner_file = self.state / "state.json"
        runner_file.write_text('{"fires": 7}')
        self.assertEqual(self.run_check("r2"), first)
        runner_file.write_text(json.dumps({"fires": 7, "pending": {"event": first}}))
        self.assertEqual(self.run_check("r3"), "")

    def test_changed_file_alerts_again_and_unreadable_root_does_not_advance(self):
        self.assertEqual(self.run_check("r0"), "")
        file = self.touch("inspect.py")
        self.assertIn("inspect.py", self.run_check("r1"))
        (self.state / ".run-ok").write_text("r1")
        self.assertEqual(self.run_check("r2"), "")
        file.write_text("different scratch")
        self.assertIn("inspect.py", self.run_check("r3"))
        before = (self.state / "shadow-seen.json").read_bytes()
        with patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                self.run_check("r4")
        self.assertEqual((self.state / "shadow-seen.json").read_bytes(), before)

    def test_large_batches_escape_paths_and_drain_without_drops(self):
        self.assertEqual(self.run_check("r0"), "")
        roots = []
        for i in range(40):
            root = self.base / (f"root-{i:02}-" + "x" * 70 + "\n")
            root.mkdir()
            (root / "inspect.py").write_text("never import")
            roots.append(root)
        report = check.scan(roots)
        events = []
        for i in range(10):
            event = check.check(self.state, report, f"r{i}")
            if not event:
                break
            self.assertLessEqual(len(event), 4000)
            self.assertIn("\\n", event)
            events.append(event)
            (self.state / ".run-ok").write_text(f"r{i}")
        state = json.loads((self.state / "shadow-seen.json").read_text())
        self.assertGreater(len(events), 1)
        self.assertEqual(len(state["seen"]), 40)
        self.assertNotIn("pending", state)

    def test_report_cli_never_writes_state_or_executes_shadow(self):
        self.touch("inspect.py")
        result = subprocess.run([sys.executable, "-I", "-B", str(SPEC.origin),
                                 "--report", "--root", str(self.root)],
                                cwd=self.base, capture_output=True, text=True, check=True)
        report = json.loads(result.stdout)
        self.assertEqual(report["findings"][0]["name"], "inspect")
        self.assertEqual(list(self.state.iterdir()), [])

    def test_symlink_names_are_kept_and_no_target_content_is_read(self):
        target = self.touch("private-data", "not Python; must not be opened")
        for name in ["inspect.py", "queue.py"]:
            (self.root / name).symlink_to(target)
        report = check.scan([self.root])
        self.assertEqual([Path(f["path"]).name for f in report["findings"]],
                         ["inspect.py", "queue.py"])
        self.assertNotEqual(report["findings"][0]["key"], report["findings"][1]["key"])

    def test_default_roots_include_environment_temp_and_both_repos(self):
        with patch.dict(os.environ, {"TMPDIR": str(self.root)}):
            roots = check.default_roots()
        self.assertIn(self.root, roots)
        for root in ["/tmp", "/private/tmp", "/Volumes/ExternalSSD/tmp",
                     "/Volumes/ExternalSSD/t3code-fork/tmp",
                     "/Volumes/ExternalSSD/crpko-devops/tmp"]:
            self.assertIn(Path(root), roots)

    def test_runner_without_tmpdir_still_scans_darwin_temp_root(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.dict(os.confstr_names, {"CS_DARWIN_USER_TEMP_DIR": 123}), \
                patch.object(os, "confstr", return_value=str(self.root)):
            self.assertIn(self.root, check.default_roots())

    def test_manual_test_entry_point_does_not_require_watch_run(self):
        env = dict(os.environ, WATCH_DIR=str(self.state))
        env.pop("WATCH_RUN", None)
        result = subprocess.run([sys.executable, "-I", "-B", str(SPEC.origin),
                                 "--root", str(self.root)], cwd=self.base,
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads((self.state / "shadow-seen.json").read_text()), {"seen": []})


if __name__ == "__main__":
    unittest.main()
