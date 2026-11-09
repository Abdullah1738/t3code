"""Recall hooks in the generated harness homes (Claude, Codex and codex-cu)."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[2] / "harness-homes"
spec = importlib.util.spec_from_file_location("recall_homes_generator", PACKAGE / "generate_homes.py")
gh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gh)

RECALL = "/recall_hook.py"
CLAUDE_EVENTS = {"UserPromptSubmit", "PreToolUse", "PreCompact", "SessionStart", "PostToolUse", "PostToolUseFailure"}
CODEX_EVENTS = {"UserPromptSubmit", "PreToolUse", "PreCompact", "PostCompact", "SessionStart", "PostToolUse"}


def recall_events(hooks: dict, harness: str) -> set[str]:
    found = set()
    for event, groups in hooks.items():
        for group in groups:
            for handler in group["hooks"]:
                if RECALL in handler["command"]:
                    assert handler["command"].endswith(f"--harness {harness}"), handler["command"]
                    assert handler["timeout"] == (4 if event == "PreToolUse" else 2)
                    found.add(event)
    return found


class RecallHomeTests(unittest.TestCase):
    """Recall's slice of the shared generator; the generator's own suite covers the rest."""

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

    def test_shared_recall_is_generated_and_stale_endpoints_are_replaced(self):
        self.assertIn("recall", {s["id"] for s in self.manifest["mcpServers"]})
        for name in ("codex", "codex-cu"):
            home = self.root / name
            home.mkdir(parents=True, exist_ok=True)
            (home / "config.toml").write_text('[mcp_servers.recall]\nurl = "http://127.0.0.1:18765/mcp"\n')
        claude = self.root / "claude"
        claude.mkdir(parents=True, exist_ok=True)
        (claude / ".claude.json").write_text(json.dumps({"mcpServers": {"recall": {"type": "http", "url": "x"}}}))
        self.assertEqual(self.invoke("generate")[0], 0)
        for name in ("codex", "codex-cu"):
            cfg = tomllib.loads((self.root / name / "config.toml").read_text())
            self.assertEqual(cfg["mcp_servers"]["recall"]["url"], "http://127.0.0.1:18765/mcp")
        recall = json.loads((claude / ".claude.json").read_text())["mcpServers"]["recall"]
        self.assertEqual(recall["type"], "http")
        self.assertEqual(recall["url"], "http://127.0.0.1:18765/mcp")
        self.assertEqual(self.invoke("check")[0], 0)

    def test_recall_hooks_reach_every_home_by_harness(self):
        self.assertEqual(self.invoke("generate")[0], 0)
        settings = json.loads((self.root / "claude" / "settings.json").read_text())
        self.assertEqual(recall_events(settings["hooks"], "claude"), CLAUDE_EVENTS)
        for name in ("codex", "codex-cu"):
            hooks = json.loads((self.root / name / "hooks.json").read_text())["hooks"]
            self.assertEqual(recall_events(hooks, "codex"), CODEX_EVENTS, name)
            self.assertTrue(tomllib.loads((self.root / name / "config.toml").read_text())["features"]["hooks"])
        self.assertEqual(self.invoke("check")[0], 0)
        rc, out, err = self.invoke("generate")
        self.assertEqual((rc, out, err), (0, "", ""))


if __name__ == "__main__":
    unittest.main()
