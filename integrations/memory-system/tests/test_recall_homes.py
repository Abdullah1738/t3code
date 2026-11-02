"""Recall home generation: isolated homes and Codex's recorded trust oracle."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / "harness-homes"
spec = importlib.util.spec_from_file_location("recall_homes_generator", PACKAGE / "generate_homes.py")
gh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gh)

# Captured from the local Codex 0.144.1 app-server hooks/list for this manifest;
# unlike the generator, this fixture does not derive the hash under test.
ORACLE_HASH = {
    "UserPromptSubmit": "sha256:8e1c6c971643e10743eb0e66ad72bfd41604d81b695acba1a786543097f494dd",
    "PostToolUse": "sha256:142a148b5dc091dbeb7dbd33f3ac2cd410fe2f1781b7381d286896f657f25b6e",
    "SubagentStart": "sha256:cf651b4c22a5fce355e3c6d631acdd72209689bbaf6dd3ee463841194db02f4e",
}
LABEL = {"UserPromptSubmit": "user_prompt_submit", "PostToolUse": "post_tool_use", "SubagentStart": "subagent_start",
         "Stop": "stop", "SubagentStop": "subagent_stop", "SessionEnd": "session_end"}


class RecallHomeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="recall-home-test-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "homes"
        self.skill = self.base / "skills"
        self.skill.mkdir()
        canonical = self.base / "AGENTS.md"
        canonical.write_text("# Fixture\n")
        self.manifest = json.loads((PACKAGE / "manifest.json").read_text())
        self.manifest["skillRoots"] = [str(self.skill)]
        self.manifest["instructions"]["canonical"] = str(canonical)
        patch = mock.patch.object(gh, "load_manifest", return_value=self.manifest)
        patch.start()
        self.addCleanup(patch.stop)

    def invoke(self, *args):
        output = io.StringIO()
        error = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            rc = gh.main([*args, "--home-root", str(self.root)])
        return rc, output.getvalue(), error.getvalue()

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def seed_trust(self, home, event=None, disabled=False, bad_hash=False):
        path = home / "config.toml"
        config = tomllib.loads(path.read_text())
        groups = json.loads((home / "hooks.json").read_text())["hooks"]
        state = config.setdefault("hooks", {}).setdefault("state", {})
        for name, label in LABEL.items():
            if event is not None and name != event:
                continue
            command = next(h["command"] for h in self.manifest["hooks"]
                           if h["harness"] == "codex" and h["event"] == name)
            indices = [(i, j) for i, group in enumerate(groups[name])
                       for j, handler in enumerate(group["hooks"]) if handler.get("command") == command]
            self.assertEqual(len(indices), 1)
            i, j = indices[0]
            key = f"{os.path.realpath(home / 'hooks.json')}:{label}:{i}:{j}"
            wanted = groups[name][i]
            identity = {"event_name": label, "hooks": [{**wanted["hooks"][j], "async": False}]}
            if "matcher" in wanted:
                identity["matcher"] = wanted["matcher"]
            derived = "sha256:" + hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False,
                                                             separators=(",", ":")).encode()).hexdigest()
            state[key] = {"trusted_hash": "sha256:invalid" if bad_hash else ORACLE_HASH.get(name, derived)}
            if disabled:
                state[key]["enabled"] = False
        path.write_text(gh.toml_dump(config))

    def seed_all_trust(self):
        for name in ("codex", "codex-cu"):
            self.seed_trust(self.root / name)

    def test_unscoped_recall_is_not_generated_or_kept(self):
        home = self.root / "codex-cu"
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.toml").write_text('[mcp_servers.recall]\nurl = "http://127.0.0.1:18765/mcp"\n')
        self.assertEqual(self.invoke("generate")[0], 0)
        cfg = tomllib.loads((home / "config.toml").read_text())
        self.assertNotIn("recall", cfg.get("mcp_servers", {}))
        claude = json.loads((self.root / "claude" / ".claude.json").read_text())
        self.assertNotIn("recall", claude.get("mcpServers", {}))

    def test_preserves_foreign_config_and_hooks_idempotently(self):
        claude = self.root / "claude"
        codex = self.root / "codex"
        extra = self.root / "codex-cu"
        guard = {"matcher": "Bash", "hooks": [{"type": "command", "command": "/bin/guard", "timeout": 7}]}
        mixed = {"matcher": ".*", "hooks": [
            {"type": "command", "command": "/bin/other", "timeout": 9},
            {"type": "command", "command": self.manifest["hooks"][1]["command"], "timeout": 2},
        ]}
        self.write_json(claude / "settings.json", {"hooks": {"PreToolUse": [guard], "PostToolUse": [mixed]}})
        for home in (codex, extra):
            self.write_json(home / "hooks.json", {"description": "keep", "hooks": {
                "PreToolUse": [guard], "PostToolUse": [guard]}})
            (home / "config.toml").write_text(
                '[custom]\nmessage = "keep"\ndate = 2026-11-01\nratio = 1.5\n[features]\ncomputer_use = true\n'
                '[hooks.state."foreign"]\ntrusted_hash = "foreign-hash"\n'
                '[[hooks.PreToolUse]]\nmatcher = "Bash"\n'
                '[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/bin/inline"\n')
        rc, _, err = self.invoke("generate")
        self.assertEqual(rc, 0, err)
        claude_hooks = json.loads((claude / "settings.json").read_text())["hooks"]
        self.assertEqual(claude_hooks["PreToolUse"], [guard])
        self.assertEqual(claude_hooks["PostToolUse"][0]["hooks"][0], mixed["hooks"][0])
        self.assertEqual(claude_hooks["PostToolUse"][0]["hooks"][1]["timeout"], 15)
        for home in (codex, extra):
            cfg = tomllib.loads((home / "config.toml").read_text())
            self.assertEqual(cfg["custom"]["message"], "keep")
            self.assertEqual(str(cfg["custom"]["date"]), "2026-11-01")
            self.assertEqual(cfg["custom"]["ratio"], 1.5)
            self.assertEqual(cfg["hooks"]["state"]["foreign"]["trusted_hash"], "foreign-hash")
            self.assertEqual(cfg["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "/bin/inline")
            self.assertEqual(json.loads((home / "hooks.json").read_text())["hooks"]["PreToolUse"], [guard])
        self.assertIs(tomllib.loads((extra / "config.toml").read_text())["features"]["computer_use"], True)
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        rc, out, err = self.invoke("generate")
        self.assertEqual((rc, out, err), (0, "", ""))
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        self.seed_all_trust()
        self.assertEqual(self.invoke("check")[0], 0)
        self.assertEqual(self.invoke("generate")[0], 0)
        self.assertEqual(self.invoke("check")[0], 0)

    def test_check_requires_all_codex_trust_and_detects_changed_disabled_or_moved_hooks(self):
        self.assertEqual(self.invoke("generate")[0], 0)
        rc, out, _ = self.invoke("check")
        self.assertEqual(rc, 1)
        self.assertIn("not trusted", out)
        self.seed_all_trust()
        self.assertEqual(self.invoke("check")[0], 0)
        home = self.root / "codex-cu"
        self.seed_trust(home, "PostToolUse", disabled=True)
        rc, out, _ = self.invoke("check")
        self.assertEqual(rc, 1)
        self.assertIn("disabled", out)
        self.seed_trust(home, "PostToolUse", bad_hash=True)
        self.assertIn("not trusted", self.invoke("check")[1])
        self.seed_trust(home, "PostToolUse")
        path = home / "hooks.json"
        obj = json.loads(path.read_text())
        obj["hooks"]["PostToolUse"].insert(0, {"hooks": [{"type": "command", "command": "/bin/foreign"}]})
        path.write_text(json.dumps(obj))
        self.assertIn("not trusted", self.invoke("check")[1])
        self.seed_trust(home, "PostToolUse")
        self.assertEqual(self.invoke("check")[0], 0)
        cfg = home / "config.toml"
        config = tomllib.loads(cfg.read_text())
        config["features"]["hooks"] = False
        cfg.write_text(gh.toml_dump(config))
        self.assertIn("features.hooks", self.invoke("check")[1])

    def test_check_rejects_missing_modified_and_disabled_claude_hooks(self):
        self.assertEqual(self.invoke("generate")[0], 0)
        self.seed_all_trust()
        path = self.root / "claude/settings.json"
        original = json.loads(path.read_text())
        settings = json.loads(path.read_text())
        del settings["hooks"]["PostToolUseFailure"]
        path.write_text(json.dumps(settings))
        self.assertIn("PostToolUseFailure", self.invoke("check")[1])
        settings = json.loads(json.dumps(original))
        settings["hooks"]["PostToolUse"][0]["matcher"] = "Write"
        path.write_text(json.dumps(settings))
        self.assertIn("definition differs", self.invoke("check")[1])
        settings = json.loads(json.dumps(original))
        settings["disableAllHooks"] = True
        path.write_text(json.dumps(settings))
        self.assertIn("disableAllHooks", self.invoke("check")[1])

    def test_unsafe_shared_matcher_and_duplicate_are_refused_before_writing(self):
        path = self.root / "claude/settings.json"
        handler = {"type": "command", "command": self.manifest["hooks"][1]["command"], "timeout": 15}
        self.write_json(path, {"hooks": {"PostToolUse": [{"matcher": "Bash", "hooks": [handler,
                         {"type": "command", "command": "/bin/guard"}]}]}})
        before = path.read_bytes()
        rc, _, err = self.invoke("generate")
        self.assertEqual(rc, 1)
        self.assertIn("matcher shared", err)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.root / "codex/config.toml").exists())
        self.write_json(path, {"hooks": {"PostToolUse": [{"matcher": ".*", "hooks": [handler, handler]}]}})
        self.assertIn("duplicate owned", self.invoke("generate")[2])

    def test_conflicting_codex_config_shape_is_refused_before_writing(self):
        path = self.root / "codex-cu/config.toml"
        path.parent.mkdir(parents=True)
        path.write_text('features = "keep"\n')
        rc, _, err = self.invoke("generate")
        self.assertEqual(rc, 1)
        self.assertIn("cannot merge table with non-table", err)
        self.assertEqual(path.read_text(), 'features = "keep"\n')
        self.assertFalse((self.root / "claude/settings.json").exists())

    def test_check_rejects_foreign_definition_that_breaks_the_entire_codex_file(self):
        self.assertEqual(self.invoke("generate")[0], 0)
        self.seed_all_trust()
        path = self.root / "codex-cu/hooks.json"
        hooks = json.loads(path.read_text())
        hooks["hooks"]["PreToolUse"] = [{"hooks": [{"type": "future-unknown"}]}]
        path.write_text(json.dumps(hooks))
        rc, out, _ = self.invoke("check")
        self.assertEqual(rc, 1)
        self.assertIn("cannot verify foreign", out)

    def test_conflicting_recall_command_is_not_duplicated_or_silently_replaced(self):
        path = self.root / "claude/settings.json"
        command = self.manifest["hooks"][1]["command"] + " --unknown-flag"
        self.write_json(path, {"hooks": {"PostToolUse": [{"matcher": ".*", "hooks": [
            {"type": "command", "command": command, "timeout": 15}]}]}})
        before = path.read_bytes()
        rc, _, err = self.invoke("generate")
        self.assertEqual(rc, 1)
        self.assertIn("conflicting recall command", err)
        self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
