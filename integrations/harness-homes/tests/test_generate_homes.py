"""Tests for generate_homes.py. Every path lives in a temp dir; HOME is pointed there too."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

PKG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG))
import generate_homes as gh  # noqa: E402


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class HarnessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-test-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.skill_root = self.home / ".config/opencode/skills"
        self.canonical = self.home / ".config/opencode/AGENTS.md"
        write(self.canonical, "# Canonical rules\nkeep this\n")
        self.make_skill("alpha", "alpha")
        self.make_skill("cat/beta", None, name="beta")
        self.make_skill("cat/deep/gamma", "gamma")
        self.root = self.tmp / "homes"
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        self.manifest_patch = mock.patch.object(gh, "expand", gh.expand)
        self.manifest_patch.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.manifest_patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_skill(self, rel: str, _unused, name: str | None = None) -> None:
        """Create a skill dir; `name` sets the frontmatter name, else the dir name is used."""
        d = self.skill_root / rel
        d.mkdir(parents=True, exist_ok=True)
        name_line = f"name: {name}\n" if name else ""
        write(d / "SKILL.md", f"---\n{name_line}description: test\n---\nbody\n")

    def manifest(self) -> dict:
        m = json.loads((PKG / "manifest.json").read_text(encoding="utf-8"))
        m["skillRoots"] = [str(self.skill_root)]
        m["instructions"]["canonical"] = str(self.canonical)
        return m

    def run_gen(self, manifest: dict | None = None, extra: list[str] | None = None) -> str:
        """Run generate with a patched manifest; return stdout."""
        with mock.patch.object(gh, "load_manifest", return_value=manifest or self.manifest()):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gh.main(["generate", "--home-root", str(self.root)] + (extra or []))
            self.assertEqual(rc, 0, out.getvalue())
            return out.getvalue()

    def run_check(self, manifest: dict | None = None) -> tuple[int, str]:
        with mock.patch.object(gh, "load_manifest", return_value=manifest or self.manifest()):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gh.main(["check", "--home-root", str(self.root)])
            return rc, out.getvalue()

    @property
    def claude(self) -> Path:
        return self.root / "claude"

    @property
    def codex(self) -> Path:
        return self.root / "codex"


class GenerateTests(HarnessTestCase):
    def test_full_generate_writes_every_file_with_exact_values(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "matcher": "Bash", "command": "/usr/bin/true", "timeoutSec": 5}]
        self.run_gen(m)

        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertIs(settings["autoMemoryEnabled"], False)
        self.assertIs(settings["autoDreamEnabled"], False)
        self.assertEqual(settings["cleanupPeriodDays"], 36500)
        self.assertEqual(settings["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1")
        self.assertEqual(settings["env"]["CLAUDE_CODE_DISABLE_ORG_MEMORY"], "1")
        self.assertEqual(settings["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:20128")
        self.assertEqual(settings["env"]["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "500000")
        self.assertEqual(settings["env"]["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"], "1000000")
        self.assertEqual(settings["pluginConfigs"]["cc-plugin-agents-md@builtin"]["options"]["instructionFiles"],
                         "claude-md-and-agents-md")
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", settings["env"])
        self.assertEqual(settings["hooks"], {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "/usr/bin/true", "timeout": 5}]}]})

        cj = json.loads((self.claude / ".claude.json").read_text())
        self.assertIs(cj["hasCompletedOnboarding"], True)
        self.assertEqual(cj["mcpServers"]["perplexity"]["timeout"], 660000)
        self.assertEqual(cj["mcpServers"]["betterstack"], {"type": "http", "url": "https://mcp.betterstack.com",
                                                           "timeout": 120000})
        self.assertEqual(sorted(cj["mcpServers"]), sorted(s["id"] for s in m["mcpServers"]))
        self.assertNotIn("t3-code", cj["mcpServers"])

        self.assertEqual((self.claude / "CLAUDE.md").read_text(),
                         f"@{self.canonical}\n@{self.claude / 'overlay.md'}\n")
        self.assertEqual((self.claude / "overlay.md").read_bytes(), (PKG / "overlays/claude.md").read_bytes())

        cfg = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(cfg["model"], "gpt-6-astra")
        self.assertEqual(cfg["model_context_window"], 872000)
        self.assertEqual(cfg["model_auto_compact_token_limit"], 450000)
        self.assertEqual(cfg["approval_policy"], "never")
        self.assertEqual(cfg["sandbox_mode"], "danger-full-access")
        self.assertEqual(cfg["features"]["memories"], False)
        self.assertEqual(cfg["features"]["chronicle"], False)
        self.assertEqual(cfg["memories"], {"generate_memories": False, "use_memories": False})
        self.assertEqual(cfg["model_providers"]["ninerouter"]["http_headers"],
                         {"x-9router-token-saver": "off"})
        self.assertEqual(cfg["mcp_servers"]["cua-driver"]["args"], ["mcp"])
        self.assertEqual(cfg["mcp_servers"]["perplexity"]["tool_timeout_sec"], 660)
        self.assertEqual(cfg["mcp_servers"]["dia"]["env"], {"DIA_CDP_ENDPOINT": "http://127.0.0.1:9222"})
        self.assertEqual(cfg["notify"], [])
        self.assertEqual(cfg["shell_environment_policy"]["set"]["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
        self.assertEqual(cfg["agents"]["max_depth"], 1000000)
        self.assertEqual(cfg["history"], {"persistence": "none"})

        hooks = json.loads((self.codex / "hooks.json").read_text())
        self.assertEqual(hooks, {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "/usr/bin/true", "timeout": 5}]}]}})

        agents = (self.codex / "AGENTS.md").read_bytes()
        self.assertEqual(agents, self.canonical.read_bytes() + b"\n\n" + (PKG / "overlays/codex.md").read_bytes())

        models = json.loads((self.codex / "models.json").read_text())
        by_slug = {x["slug"]: x for x in models["models"]}
        for slug in ("gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"):
            self.assertEqual(by_slug[slug]["context_window"], 872000)
            self.assertEqual(by_slug[slug]["max_context_window"], 872000)
            self.assertEqual(by_slug[slug]["auto_compact_token_limit"], 450000)

        self.assertEqual(sorted(os.listdir(self.claude / "skills")), ["alpha", "beta", "gamma"])
        self.assertEqual(sorted(os.listdir(self.codex / "skills")), ["alpha", "beta", "gamma"])
        self.assertTrue(os.path.islink(self.claude / "skills/beta"))
        self.assertEqual(os.path.realpath(self.claude / "skills/gamma"),
                         os.path.realpath(self.skill_root / "cat/deep/gamma"))

    def test_modes_are_restrictive(self) -> None:
        self.run_gen()
        self.assertEqual(os.stat(self.claude).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.claude / "settings.json").st_mode & 0o777, 0o644)
        self.assertEqual(os.stat(self.codex / "config.toml").st_mode & 0o777, 0o644)

    def test_second_generate_prints_nothing_and_keeps_mtimes(self) -> None:
        self.run_gen()
        before = {}
        for p in list(self.claude.rglob("*")) + list(self.codex.rglob("*")):
            before[str(p)] = os.lstat(p).st_mtime_ns
        out = self.run_gen()
        self.assertEqual(out, "")
        for path, mtime in before.items():
            self.assertEqual(os.lstat(path).st_mtime_ns, mtime, path)

    def test_foreign_keys_survive_in_claude_json_and_settings(self) -> None:
        self.claude.mkdir(parents=True)
        (self.claude / ".claude.json").write_text(json.dumps({
            "oauthAccount": {"accountUuid": "keep-me"},
            "projects": {"/x": {"allowedTools": []}},
            "mcpServers": {"stale": {"type": "stdio", "command": "old"}},
        }))
        (self.claude / "settings.json").write_text(json.dumps({
            "theme": "dark",
            "env": {"MY_OWN": "1", "DISABLE_TELEMETRY": "0"},
            "permissions": {"allow": ["Read"]},
        }))
        self.run_gen()
        cj = json.loads((self.claude / ".claude.json").read_text())
        self.assertEqual(cj["oauthAccount"], {"accountUuid": "keep-me"})
        self.assertEqual(cj["projects"], {"/x": {"allowedTools": []}})
        self.assertNotIn("stale", cj["mcpServers"])
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["theme"], "dark")
        self.assertEqual(settings["permissions"], {"allow": ["Read"]})
        self.assertEqual(settings["env"]["MY_OWN"], "1")
        self.assertEqual(settings["env"]["DISABLE_TELEMETRY"], "1")

    def test_name_collision_stops_and_writes_nothing(self) -> None:
        self.make_skill("dup/one", None, name="alpha")
        with self.assertRaises(gh.HomeError) as ctx:
            gh.discover_skills([str(self.skill_root)])
        message = str(ctx.exception)
        self.assertIn(str(self.skill_root / "alpha"), message)
        self.assertIn(str(self.skill_root / "dup/one"), message)
        self.assertEqual(self.run_gen_expect_error(), 1)
        self.assertFalse(self.root.exists())

    def run_gen_expect_error(self) -> int:
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()):
                return gh.main(["generate", "--home-root", str(self.root)])

    def test_removed_skill_link_is_removed_and_foreign_link_stays(self) -> None:
        self.run_gen()
        shutil.rmtree(self.skill_root / "alpha")
        foreign_target = self.tmp / "elsewhere"
        foreign_target.mkdir()
        os.symlink(foreign_target, self.claude / "skills/foreign")
        self.run_gen()
        self.assertFalse(os.path.lexists(self.claude / "skills/alpha"))
        self.assertTrue(os.path.islink(self.claude / "skills/foreign"))
        self.assertTrue(os.path.islink(self.claude / "skills/beta"))

    def test_real_directory_in_skills_is_never_removed(self) -> None:
        self.run_gen()
        real = self.claude / "skills/alpha"
        os.unlink(real)
        real.mkdir()
        (real / "keep.txt").write_text("mine")
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertEqual((real / "keep.txt").read_text(), "mine")

    def test_models_json_untouched_for_unlisted_entries(self) -> None:
        self.run_gen()
        raw = json.loads((PKG / "vendor/codex-models-0.166.0.json").read_text())
        generated = json.loads((self.codex / "models.json").read_text())
        extended = {"gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"}
        others_raw = [m for m in raw["models"] if m["slug"] not in extended]
        others_gen = [m for m in generated["models"] if m["slug"] not in extended]
        self.assertTrue(others_raw)
        self.assertEqual(others_raw, others_gen)

    def test_models_json_refuses_missing_slug(self) -> None:
        m = self.manifest()
        m["codexModels"]["extended"] = m["codexModels"]["extended"] + ["gpt-no-such"]
        with self.assertRaises(gh.HomeError):
            gh.models_json(PKG / m["codexModels"]["catalogSource"], m)

    def test_check_passes_after_generate(self) -> None:
        self.run_gen()
        rc, out = self.run_check()
        self.assertEqual(rc, 0, out)
        self.assertIn("OK", out)

    def test_check_fails_when_memory_switched_on(self) -> None:
        self.run_gen()
        p = self.claude / "settings.json"
        settings = json.loads(p.read_text())
        settings["autoMemoryEnabled"] = True
        p.write_text(json.dumps(settings))
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("autoMemoryEnabled", out)

    def test_check_fails_when_memories_table_deleted(self) -> None:
        self.run_gen()
        p = self.codex / "config.toml"
        text = p.read_text()
        start = text.index("[memories]")
        end = text.index("\n[", start + 1) if "\n[" in text[start + 1:] else len(text)
        p.write_text(text[:start] + text[end:].lstrip("\n"))
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("memories", out)

    def test_check_fails_on_secret_in_overlay(self) -> None:
        overlay = self.tmp / "claude-overlay.md"
        overlay.write_text("token sk-abcdefghijklmnop here\n")
        m = self.manifest()
        m["instructions"]["overlays"]["claude"] = str(overlay)  # absolute: never touch the package file
        self.run_gen(m)
        with mock.patch.object(gh, "load_manifest", return_value=m):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["check", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertIn("secret-looking", out.getvalue())

    def test_hooks_list_yields_claude_block_and_hooks_json(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "matcher": None, "command": "/bin/echo", "timeoutSec": 3}]
        self.run_gen(m)
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["hooks"], {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "/bin/echo", "timeout": 3}]}]})
        self.assertTrue((self.codex / "hooks.json").exists())

    def test_no_hooks_leaves_empty_claude_hooks_and_no_codex_hooks(self) -> None:
        self.run_gen()
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["hooks"], {})
        self.assertFalse((self.codex / "hooks.json").exists())
        cfg = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertNotIn("hooks", cfg)

    def test_home_root_pointing_at_personal_claude_is_refused(self) -> None:
        personal = self.home / ".claude"
        personal.mkdir()
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with self.assertRaises(gh.HomeError):
                gh.resolve_homes(self.manifest(), str(personal))
            with contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["generate", "--home-root", str(personal)])
        self.assertEqual(rc, 1)
        self.assertFalse((personal / "settings.json").exists())

    def test_home_root_inside_personal_codex_is_refused(self) -> None:
        with self.assertRaises(gh.HomeError):
            gh.guard_home(str(self.home / ".codex/robob"))

    def test_skills_dir_is_never_a_real_directory_target_for_foreign_links(self) -> None:
        self.run_gen()
        self.assertEqual(gh.skill_ops(str(self.claude / "skills"),
                                      gh.discover_skills([str(self.skill_root)]),
                                      [str(self.skill_root)]), [])

    def test_codex_config_keeps_existing_hook_trust_state(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "matcher": None, "command": "/bin/echo", "timeoutSec": 3}]
        self.codex.mkdir(parents=True)
        (self.codex / "config.toml").write_text(
            '[hooks.state."abc"]\ntrusted_hash = "sha256:xyz"\n')
        self.run_gen(m)
        cfg = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(cfg["hooks"]["state"], {"abc": {"trusted_hash": "sha256:xyz"}})

    def test_dry_run_writes_nothing(self) -> None:
        out = self.run_gen(extra=["--dry-run"])
        self.assertIn("would write", out)
        self.assertFalse(self.root.exists())


if __name__ == "__main__":
    unittest.main()
