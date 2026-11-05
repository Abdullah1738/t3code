"""Shell/source parity vectors; database path strings are never opened."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine
import statev2_guard as guard


class LiveDatabaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="live-db-guard-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "HARNESS_HOOKS_STATE_DIR": str(self.root / "state")})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_direct_live_read_vectors(self):
        commands = [
            "sqlite3 ~/.robob/userdata/statev2.sqlite 'select 1'",
            "sqlite3 'file:/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite?mode=ro' 'select 1'",
            "sqlite3 ~/.robob/userdata/statev2.sqlite 'VACUUM INTO /tmp/copy.sqlite'",
            "python3 -c \"import sqlite3; sqlite3.connect('/Users/ardud/.robob/userdata/statev2.sqlite')\"",
            "node -e \"new Database(process.env.HOME+'/.robob/userdata/statev2.sqlite')\"",
            "bun run -e \"new Database('/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite')\"",
            "cp ~/.robob/userdata/statev2.sqlite /tmp/copy.sqlite",
            "rsync ~/.robob/userdata/*.sqlite /tmp/",
            "cat $HOME/.robob/userdata/statev2.sqlite-wal",
            "sqlite3 ~/.local/share/opencode/opencode.db 'select 1'",
            "bash -c 'sqlite3 ~/.robob/userdata/statev2.sqlite \"select 1\"'",
            'sh -c "python3 -c \'sqlite3.connect(\"/Users/ardud/.local/share/opencode/opencode.db\")\'"',
            "python3.14 -c \"sqlite3.connect(str(Path.home()/'.local/share'/'opencode'/'opencode.db'))\"",
            "node -e \"new Database('/Volumes/ExternalSSD/opencode-data/opencode.db')\"",
            "python3 - <<'PY'\nimport sqlite3\nsqlite3.connect(str(Path.home()/'.robob'/'userdata'/'statev2.sqlite'))\nPY",
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-read")

    def test_metadata_copies_and_source_paths_are_allowed(self):
        source = self.root / "statev2-guard.ts"
        source.write_text("const live = '/Users/ardud/.robob/userdata/statev2.sqlite';")
        for command in [
            "ls -lh ~/.robob/userdata/statev2.sqlite", "stat ~/.local/share/opencode/opencode.db",
            "du -h ~/.robob/userdata/statev2.sqlite", "lsof ~/.robob/userdata/statev2.sqlite",
            "sqlite3 /tmp/isolated/statev2.sqlite 'select 1'",
            "sqlite3 /tmp/isolated/opencode.db 'select 1'",
            f"cat {source}",
            "node integrations/harness-hooks/src/engine.py",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))

    def test_relative_names_in_live_directory(self):
        self.assertEqual(guard.classify("sqlite3 statev2.sqlite 'select 1'", "/Users/ardud/.robob/userdata"), "live-database-read")
        self.assertEqual(guard.classify("sqlite3 opencode.db 'select 1'", "/Users/ardud/.local/share/opencode"), "live-database-read")

    def test_home_expansion_aliases_and_backup_commands(self):
        live = self.root / ".robob/userdata/statev2.sqlite"
        alias = self.root / "alias.sqlite"
        alias.symlink_to(live)
        for command in [f"sqlite3 {alias} 'select 1'", "sqlite3 ./alias.sqlite 'select 1'",
                        "cp alias.sqlite backup.sqlite", f"dd if=/Users/ardud/.robob/userdata/statev2.sqlite of={self.root}/copy.sqlite",
                        "sqlite3 ${HOME}/.robob/userdata/statev2.sqlite 'select 1'",
                        "sqlite3 $HOME/.local/share/opencode/opencode.db 'select 1'",
                        "sqlite3 /tmp/copy.sqlite '.backup /Users/ardud/.robob/userdata/statev2.sqlite'",
                        "cp /tmp/copy.sqlite ~/.robob/userdata/statev2.sqlite"]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-read")
        self.assertFalse(live.exists())

    def test_script_vectors_and_bounded_source_inspection(self):
        for name, source in [
            ("measure.py", "sqlite3.connect(str(Path.home()/'.robob'/'userdata'/'statev2.sqlite'))"),
            ("analyze.mjs", "new Database('/Users/ardud/.local/share/opencode/opencode.db')"),
            ("spaced probe.py", "db = '/Volumes/ExternalSSD/robob-data/userdata/statev2.sqlite'"),
        ]:
            (self.root / name).write_text(source)
        for command in ["python3 measure.py", "uv run python3 measure.py", "node analyze.mjs", "./measure.py", "bash -c 'python3 measure.py'", 'python3 "spaced probe.py"']:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script")
        (self.root / "copy.py").write_text("sqlite3.connect('/tmp/isolated/statev2.sqlite')")
        (self.root / "large.py").write_text(" " * (guard.MAX_SOURCE_BYTES + 1))
        self.assertIsNone(guard.classify("python3 copy.py", str(self.root)))
        self.assertIsNone(guard.classify("cat measure.py", str(self.root)))
        self.assertIsNone(guard.classify("python3 missing.py", str(self.root)))
        self.assertIsNone(guard.classify("python3 large.py", str(self.root)))
        (self.root / "linked.py").symlink_to("/Users/ardud/.robob/userdata/statev2.sqlite")
        with patch.object(Path, "open", side_effect=AssertionError("must not read database symlink")):
            self.assertEqual(guard.classify("python3 linked.py", str(self.root)), "live-database-script")

    def test_policy_runs_before_identity_offbox_or_coord_and_does_not_log_sql(self):
        command = "sqlite3 ~/.robob/userdata/statev2.sqlite 'select private_sql'"
        for harness in ("claude", "codex"):
            for tool in ("Bash", "bash", "shell", "exec_command", "shell_command", "mcp__test__exec_command", "mcp__test__shell"):
                with self.subTest(harness=harness, tool=tool), patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")), patch.object(engine, "_classify_offbox", side_effect=AssertionError("classifier called")):
                    event = {"hook_event_name": "PreToolUse", "session_id": "fixture", "cwd": str(self.root),
                             "tool_name": tool, "tool_input": {"cmd" if "exec_command" in tool else "command": command}}
                    result = engine.decide(event, harness)
                    self.assertEqual(result["decision"], "deny")
                    self.assertEqual(result["context"]["rule"], "live-database-read")
                    run = subprocess.run([sys.executable, str(SRC / f"{harness}.py")], input=json.dumps(event),
                                         capture_output=True, text=True, check=True, timeout=5)
                    output = json.loads(run.stdout)["hookSpecificOutput"]
                    self.assertEqual(output["permissionDecision"], "deny")
                    self.assertNotIn("private_sql", output["permissionDecisionReason"])
        audit = (self.root / "state/decisions.jsonl").read_text()
        self.assertNotIn("private_sql", audit)
        self.assertEqual({json.loads(line)["rule"] for line in audit.splitlines()}, {"live-database-read"})

    def test_script_cwd_changes_wrappers_and_subshells(self):
        sub = self.root / "sub"
        sub.mkdir()
        (sub / "probe.py").write_text("sqlite3.connect('/Users/ardud/.robob/userdata/statev2.sqlite')")
        (sub / "safe.py").write_text("print('safe')")
        (self.root / "probe.py").write_text("print('root safe')")
        for command in [
            "cd sub && python3 probe.py", "cd sub; node probe.py", "cd sub\npython3 probe.py",
            "(cd sub && python3 probe.py)", "(cd sub && python3 probe.py); npm test",
            "bash -lc 'cd sub && python3 probe.py'", "env X=1 bash -c 'cd sub; python3 probe.py'",
            "command python3 sub/probe.py", "cd sub && env X=1 python3 probe.py",
            "cd sub && uv run python3 probe.py", "uv run --directory sub python3 probe.py",
            "env --chdir sub python3 probe.py", "{ cd sub; python3 probe.py; }",
            "bash -c '(cd sub && python3 probe.py)'", "cd sub && ./probe.py",
        ]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script")
        for command in [
            "cd sub && python3 safe.py", "(cd sub && python3 safe.py); python3 probe.py",
            "bash -lc 'cd sub && python3 safe.py'", "cd sub && uv run python3 safe.py",
            "env --chdir sub python3 safe.py; python3 probe.py",
            "env --chdir sub bash -c 'python3 safe.py'; python3 probe.py",
            "cd sub && cd .. && python3 probe.py", "{ cd sub; python3 safe.py; }",
        ]:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))

    def test_unresolved_cwd_denies_explicit_scripts_not_unrelated_binaries(self):
        for command in [
            'cd "$TARGET" && python3 probe.py', 'cd "$(pwd)" && node probe.mjs',
            "cd sub || python3 probe.py", "pushd sub; python3 probe.py",
            'bash -lc \'cd "$TARGET"; python3 probe.py\'',
            "if true; then cd sub; fi; python3 probe.py",
        ]:
            with self.subTest(command=command):
                self.assertEqual(guard.classify(command, str(self.root)), "live-database-script-unresolved")
        for command in ['cd "$TARGET" && npm test', "npm run missing-script", "missing-tool", 'cd "$TARGET" && python3 --version']:
            with self.subTest(command=command):
                self.assertIsNone(guard.classify(command, str(self.root)))
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "fixture",
                 "cwd": str(self.root), "tool_input": {"command": 'cd "$TARGET" && python3 probe.py'}}
        with patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")):
            result = engine.decide(event, "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["reason"], guard.UNRESOLVED_REASON)

    def test_unexpected_local_guard_error_never_allows_a_shell(self):
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "fixture",
                 "cwd": str(self.root), "tool_input": {"command": "python3 probe.py"}}
        with patch.object(guard, "classify", side_effect=RuntimeError("private error")), patch.object(engine, "resolve_identity", side_effect=AssertionError("identity called")):
            result = engine.decide(event, "claude")
        self.assertEqual(result["decision"], "deny")
        self.assertEqual(result["context"]["rule"], "live-database-unavailable")
        self.assertNotIn("private error", result["reason"])
        self.assertNotIn("private error", (self.root / "state/decisions.jsonl").read_text())


if __name__ == "__main__":
    unittest.main()
