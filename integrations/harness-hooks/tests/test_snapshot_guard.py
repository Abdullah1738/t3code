from contextlib import ExitStack
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG / "src"))
import engine
import snapshot_guard


class SnapshotGuardTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.home = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.root = self.home / ".local/share/harness-hooks"
        for name in snapshot_guard.FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PKG / name, target)
        self.helper = self.root / "bin/live-db-snapshot"
        self.helper.chmod(0o700)
        snapshot_guard.install_pin(self.root)
        self.stack.enter_context(patch.object(Path, "home", return_value=self.home))
        self.stack.enter_context(patch.dict(os.environ, {"HARNESS_HOOKS_STATE_DIR": str(self.home / "state"),
            "TOOLLOG_ROOT": str(self.home / "logs"), "HARNESS_HOOKS_OFFBOX_MODE": "off"}))
        self.command = shlex.join([str(self.helper), "--card", "card-fixture", "--ask", "q1", "--db", str(self.home / ".local/share/opencode/opencode.db")])

    def decide(self, command, harness="codex"):
        return engine.decide({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": str(self.home), "tool_input": {"command": command}}, harness)

    def test_exact_helper_and_symlink_allowed_for_native_harnesses(self):
        for harness in ("codex", "claude"):
            result = self.decide(self.command, harness)
            self.assertEqual(result["decision"], "allow")
            self.assertEqual(result["context"]["rule"], "live-database-snapshot")
        link = self.home / "live-db-snapshot"
        link.symlink_to(self.helper)
        self.assertTrue(snapshot_guard.exact_invocation(self.command.replace(str(self.helper), str(link)), str(self.home)))
        with patch.dict(os.environ, {"PATH": str(self.helper.parent)}):
            self.assertEqual(self.decide(self.command.replace(str(self.helper), "live-db-snapshot"))["decision"], "allow")
        self.assertTrue(snapshot_guard.exact_invocation(self.command + " --out-parent '/tmp/output folder'", str(self.home)))

    def test_compound_requests_stay_denied(self):
        for suffix in ("; cat x", " | tee x", " && cat x", " $(echo x)", " `echo x`", " > x", "\ncat x", " &", " < x"):
            with self.subTest(suffix=suffix):
                result = self.decide(self.command + suffix)
                self.assertEqual(result["decision"], "deny")
                self.assertTrue(result["context"]["rule"].startswith("live-database"))
        for prefix in ("env ", "command ", "X=1 ", "sudo "):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.decide(prefix + self.command)["decision"], "deny")

    def test_renamed_missing_pin_and_changed_hash_denied(self):
        renamed = self.home / "renamed"
        shutil.copyfile(self.helper, renamed)
        self.assertEqual(self.decide(self.command.replace(str(self.helper), str(renamed)))["decision"], "deny")
        for name in snapshot_guard.FILES:
            with self.subTest(file=name):
                file = self.root / name
                original = file.read_bytes()
                file.write_bytes(original + b"\n# changed\n")
                self.assertEqual(self.decide(self.command)["decision"], "deny")
                file.write_bytes(original)
        (self.root / "snapshot-pin.json").unlink()
        self.assertEqual(self.decide(self.command)["decision"], "deny")

    def test_copy_stays_denied(self):
        result = self.decide("cp -c ~/.local/share/opencode/opencode.db /tmp/copy.sqlite")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["context"]["rule"], "live-database-read")

    def test_only_known_options_once(self):
        for suffix in (" --db /other", " --unknown x", " --board", " --out-parent=x"):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.decide(self.command + suffix)["decision"], "deny")

    def test_unrelated_options_without_a_live_database_keep_their_policy(self):
        with patch.object(engine, "_offbox_mode", return_value="off"):
            self.assertEqual(self.decide("other-tool --card x --ask q1 --db /tmp/fixture.sqlite")["decision"], "allow")


if __name__ == "__main__":
    unittest.main()
