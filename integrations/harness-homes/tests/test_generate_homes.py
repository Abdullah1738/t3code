"""Tests for generate_homes.py. Every path lives in a temp dir; HOME is pointed there too."""
from __future__ import annotations

import contextlib
import errno
import hashlib
import io
import json
import os
import re
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
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-test-", dir=PKG))
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.skill_root = self.home / ".config/opencode/skills"
        self.canonical = self.home / ".config/opencode/AGENTS.md"
        write(self.canonical, "# Canonical rules\nkeep this\n")
        self.make_skill("alpha", "alpha")
        self.make_skill("cat/beta", None, name="beta")
        self.make_skill("cat/deep/gamma", "gamma")
        self.root = self.tmp / "homes"
        self.codex_overlay = self.tmp / "codex.md"
        write(self.codex_overlay, "# Shared Codex fixture\nShared instructions.\n")
        self.cu_overlay = self.tmp / "codex-cu-draft.md"
        write(self.cu_overlay, "# CU draft fixture\nUse the desktop lease.\n")
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
        m["instructions"]["overlays"]["codex"] = str(self.codex_overlay)
        m["instructions"]["overlays"]["codex-cu"] = str(self.cu_overlay)
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

    @property
    def codex_cu(self) -> Path:
        return self.root / "codex-cu"


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
        self.assertEqual(settings["env"]["ENABLE_PROMPT_CACHING_1H"], "1")
        self.assertEqual(settings["env"]["CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS"], "450000")
        self.assertNotIn("idleCompaction", settings)
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
                         {"x-9router-token-saver": "off", "x-openai-actor-authorization": "robob-9router-local"})
        self.assertEqual(cfg["mcp_servers"]["cua-driver"]["args"], ["mcp"])
        self.assertEqual(cfg["mcp_servers"]["recall"]["url"], "http://127.0.0.1:18765/mcp")
        self.assertEqual(cfg["mcp_servers"]["perplexity"]["tool_timeout_sec"], 660)
        self.assertEqual(cfg["mcp_servers"]["dia"]["env"], {"DIA_CDP_ENDPOINT": "http://127.0.0.1:9222"})
        self.assertEqual(cfg["notify"], [])
        self.assertEqual(cfg["shell_environment_policy"]["set"]["PATH"],
                          ":".join(m["shellPathPrefix"] + m["shellPath"]))
        self.assertEqual(cfg["shell_environment_policy"]["set"]["BUN_INSPECT"], "")
        self.assertEqual(cfg["shell_environment_policy"]["set"]["OFFBOX_GATE"], "1")
        self.assertEqual(cfg["agents"]["max_depth"], 1000000)
        # Computer Use parses every other [agents] key as a role table; a boolean there breaks it.
        self.assertEqual(set(cfg["agents"]), {"max_depth"})
        self.assertEqual(cfg["history"], {"persistence": "none"})

        hooks = json.loads((self.codex / "hooks.json").read_text())
        self.assertEqual(hooks, {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "/usr/bin/true", "timeout": 5}]}]}})

        agents = (self.codex / "AGENTS.md").read_bytes()
        self.assertEqual(agents, self.canonical.read_bytes() + b"\n\n" + self.codex_overlay.read_bytes())

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

    def test_openai_named_provider_and_compaction_flags_apply_to_both_codex_homes(self) -> None:
        self.run_gen()
        for home in (self.codex, self.codex_cu):
            with self.subTest(home=home.name):
                cfg = tomllib.loads((home / "config.toml").read_text())
                self.assertEqual(cfg["model_provider"], "ninerouter")
                provider = cfg["model_providers"]["ninerouter"]
                self.assertEqual(provider["name"], "OpenAI")
                self.assertEqual(provider["base_url"], "http://127.0.0.1:20128/v1")
                self.assertIs(provider["requires_openai_auth"], False)
                self.assertEqual(provider["http_headers"]["x-openai-actor-authorization"], "robob-9router-local")
                self.assertNotIn("capabilities", provider)
                self.assertEqual(cfg["model_auto_compact_token_limit"], 450000)
                self.assertEqual(cfg["model_auto_compact_token_limit_scope"], "total")
                self.assertIs(cfg["features"]["output_token_replay"], True)
                self.assertIs(cfg["features"]["concurrent_reasoning_summaries"], True)
                self.assertNotIn("async_compaction", cfg["features"])
                self.assertIs(cfg["features"]["image_generation"], True)

    def test_check_detects_compaction_setting_drift(self) -> None:
        self.run_gen()
        p = self.claude / "settings.json"
        settings = json.loads(p.read_text())
        settings["env"]["CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS"] = "200000"
        p.write_text(json.dumps(settings))
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("settings.json", out)
        self.run_gen()
        p = self.codex_cu / "config.toml"
        p.write_text(p.read_text().replace('name = "OpenAI"', 'name = "9router"'))
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("codex-cu/config.toml", out)

    def test_check_detects_image_generation_setting_drift(self) -> None:
        self.run_gen()
        p = self.codex_cu / "config.toml"
        cfg = tomllib.loads(p.read_text())
        del cfg["features"]["image_generation"]
        p.write_text(gh.toml_dump(cfg))
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("codex-cu/config.toml", out)

    def test_check_detects_actor_header_drift_in_both_codex_homes(self) -> None:
        for home in (self.codex, self.codex_cu):
            with self.subTest(home=home.name):
                self.run_gen()
                p = home / "config.toml"
                cfg = tomllib.loads(p.read_text())
                del cfg["model_providers"]["ninerouter"]["http_headers"]["x-openai-actor-authorization"]
                p.write_text(gh.toml_dump(cfg))
                rc, out = self.run_check()
                self.assertEqual(rc, 1)
                self.assertIn(f"{home.name}/config.toml", out)

    def test_existing_idle_compaction_override_is_detected_and_removed(self) -> None:
        self.run_gen()
        p = self.claude / "settings.json"
        settings = json.loads(p.read_text())
        settings["idleCompaction"] = False
        settings["theme"] = "dark"
        p.write_text(json.dumps(settings))
        rc, out = self.run_check()
        self.assertEqual(rc, 1, out)
        self.run_gen()
        settings = json.loads(p.read_text())
        self.assertNotIn("idleCompaction", settings)
        self.assertEqual(settings["theme"], "dark")
        rc, out = self.run_check()
        self.assertEqual(rc, 0, out)

    def test_modes_are_restrictive(self) -> None:
        self.run_gen()
        self.assertEqual(os.stat(self.claude).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.claude / "settings.json").st_mode & 0o777, 0o644)
        self.assertEqual(os.stat(self.codex / "config.toml").st_mode & 0o777, 0o644)

    def test_second_generate_prints_nothing_and_keeps_mtimes(self) -> None:
        self.run_gen()
        before = {}
        for p in list(self.claude.rglob("*")) + list(self.codex.rglob("*")) + list(self.codex_cu.rglob("*")):
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
        self.assertEqual(settings["permissions"], {"allow": ["Read"], "deny": ["Computer", "mcp__node_repl"]})
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

    def test_unreadable_symlinked_skill_keeps_farm_links(self) -> None:
        target = self.tmp / "external-skill"
        write(target / "SKILL.md", "---\nname: privacy-guard\n---\nbody\n")
        source = self.skill_root / "external"
        source.symlink_to(target, target_is_directory=True)
        self.run_gen()
        real_scandir = os.scandir

        def scandir(path):
            if os.fspath(path) == str(source):
                raise PermissionError(13, "Permission denied", str(path))
            return real_scandir(path)

        errors = io.StringIO()
        with mock.patch.object(gh.os, "scandir", side_effect=scandir):
            with contextlib.redirect_stderr(errors):
                output = self.run_gen()
                rc, check_output = self.run_check()
        for home in (self.claude, self.codex, self.codex_cu):
            link = home / "skills/privacy-guard"
            self.assertTrue(link.is_symlink(), str(link))
            self.assertEqual(os.readlink(link), str(source))
            self.assertNotIn(f"unlink {link}", output)
        self.assertEqual(rc, 1, check_output)
        self.assertIn("could not inspect", check_output)
        self.assertEqual(len(errors.getvalue().splitlines()), 2)  # one per invocation
        self.assertIn(str(source), errors.getvalue())

    def test_dangling_symlinked_skill_is_unlinked(self) -> None:
        target = self.tmp / "external-skill"
        write(target / "SKILL.md", "---\nname: privacy-guard\n---\nbody\n")
        source = self.skill_root / "external"
        source.symlink_to(target, target_is_directory=True)
        self.run_gen()
        shutil.rmtree(target)
        self.assertTrue(source.is_symlink())
        self.run_gen()
        for home in (self.claude, self.codex, self.codex_cu):
            self.assertFalse(os.path.lexists(home / "skills/privacy-guard"))

    def test_entry_stat_error_preserves_existing_link(self) -> None:
        target = self.tmp / "external-skill"
        write(target / "SKILL.md", "---\nname: privacy-guard\n---\nbody\n")
        source = self.skill_root / "external"
        source.symlink_to(target, target_is_directory=True)
        self.run_gen()
        real_scandir = os.scandir

        def scandir(path):
            entries = real_scandir(path)
            if os.fspath(path) != str(self.skill_root):
                return entries
            class UnreadableEntry:
                name = "external"
                path = str(source)
                def is_dir(self, *, follow_symlinks=True):
                    raise OSError(errno.EIO, "I/O error", self.path)
            with entries:
                return [UnreadableEntry() if entry.name == "external" else entry for entry in entries]

        with mock.patch.object(gh.os, "scandir", side_effect=scandir):
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.run_gen()
        self.assertEqual(len(errors.getvalue().splitlines()), 1)
        for home in (self.claude, self.codex, self.codex_cu):
            self.assertEqual(os.readlink(home / "skills/privacy-guard"), str(source))

    def test_unreadable_directory_protects_nested_farm_links_only(self) -> None:
        self.run_gen()
        shutil.rmtree(self.skill_root / "alpha")
        real_scandir = os.scandir
        parent = self.skill_root / "cat"

        def scandir(path):
            if os.fspath(path) == str(parent):
                raise PermissionError(errno.EACCES, "Permission denied", str(path))
            return real_scandir(path)

        with mock.patch.object(gh.os, "scandir", side_effect=scandir):
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.run_gen()
        self.assertEqual(len(errors.getvalue().splitlines()), 1)
        for home in (self.claude, self.codex, self.codex_cu):
            self.assertTrue((home / "skills/beta").is_symlink())
            self.assertTrue((home / "skills/gamma").is_symlink())
            self.assertFalse(os.path.lexists(home / "skills/alpha"))

    def test_unreadable_skill_keeps_link_even_when_name_is_reused(self) -> None:
        self.run_gen()
        self.make_skill("cat/other", None, name="alpha")
        real_scandir = os.scandir

        def scandir(path):
            if os.fspath(path) == str(self.skill_root / "alpha"):
                raise PermissionError(errno.EACCES, "Permission denied", str(path))
            return real_scandir(path)

        with mock.patch.object(gh.os, "scandir", side_effect=scandir):
            with contextlib.redirect_stderr(io.StringIO()):
                self.run_gen()
        for home in (self.claude, self.codex, self.codex_cu):
            self.assertEqual(os.readlink(home / "skills/alpha"), str(self.skill_root / "alpha"))

    def test_skill_name_read_errors_do_not_hide_discoverable_children(self) -> None:
        self.make_skill("alpha/child", None)
        self.run_gen()
        real_skill_name = gh.skill_name

        def skill_name(path):
            if path == self.skill_root / "alpha/SKILL.md":
                raise FileNotFoundError(errno.ENOENT, "gone", str(path))
            return real_skill_name(path)

        with mock.patch.object(gh, "skill_name", side_effect=skill_name):
            self.run_gen()
        for home in (self.claude, self.codex, self.codex_cu):
            self.assertFalse(os.path.lexists(home / "skills/alpha"))
            self.assertTrue((home / "skills/child").is_symlink())

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

    def test_secret_in_overlay_refuses_generate_and_writes_nothing(self) -> None:
        overlay = self.tmp / "claude-overlay.md"
        overlay.write_text("token sk-abcdefghijklmnop here\n")
        m = self.manifest()
        m["instructions"]["overlays"]["claude"] = str(overlay)  # absolute: never touch the package file
        with mock.patch.object(gh, "load_manifest", return_value=m):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertIn("secret-looking", err.getvalue())
        self.assertFalse(self.root.exists(), "no home directory may be created on refusal")
        self.assertFalse((self.claude / "overlay.md").exists())
        self.assertFalse((self.codex / "AGENTS.md").exists())

    def test_secret_in_already_generated_file_fails_check(self) -> None:
        self.run_gen()
        p = self.codex / "AGENTS.md"
        p.write_text(p.read_text() + "\nleak sk-abcdefghijklmnop\n")
        rc, out = self.run_check()
        self.assertEqual(rc, 1)
        self.assertIn("secret-looking", out)

    def test_symlinked_claude_skills_farm_into_personal_home_writes_nothing(self) -> None:
        personal_skills = self.home / ".claude/skills"
        personal_skills.mkdir(parents=True)
        (personal_skills / "keep.txt").write_text("personal")
        mode_before = os.stat(personal_skills).st_mode
        self.claude.mkdir(parents=True)
        os.symlink(personal_skills, self.claude / "skills")
        err = io.StringIO()
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(err):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertIn("personal home", err.getvalue())
        self.assertEqual(sorted(os.listdir(personal_skills)), ["keep.txt"])
        self.assertEqual(os.stat(personal_skills).st_mode, mode_before)
        self.assertFalse((self.claude / "settings.json").exists())

    def test_symlinked_codex_skills_farm_into_personal_home_writes_nothing(self) -> None:
        personal_skills = self.home / ".codex/skills"
        personal_skills.mkdir(parents=True)
        self.codex.mkdir(parents=True)
        os.symlink(personal_skills, self.codex / "skills")
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertEqual(os.listdir(personal_skills), [])
        self.assertFalse((self.codex / "config.toml").exists())

    def test_symlinked_home_ancestor_into_personal_home_writes_nothing(self) -> None:
        personal = self.home / ".codex"
        personal.mkdir(parents=True)
        self.root.mkdir(parents=True)
        os.symlink(personal, self.root / "codex")  # <root>/codex -> ~/.codex
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertEqual(os.listdir(personal), [])
        self.assertFalse((self.root / "claude").exists())

    def test_hooks_list_yields_claude_block_and_hooks_json(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "matcher": None, "command": "/bin/echo", "timeoutSec": 3}]
        self.run_gen(m)
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["hooks"], {"PreToolUse": [{"hooks": [
            {"type": "command", "command": "/bin/echo", "timeout": 3}]}]})
        self.assertTrue((self.codex / "hooks.json").exists())

    def test_no_hooks_leaves_empty_blocks_in_both_codex_homes(self) -> None:
        m = self.manifest()
        m["hooks"] = []
        self.run_gen(m)
        settings = json.loads((self.claude / "settings.json").read_text())
        self.assertEqual(settings["hooks"], {})
        self.assertEqual(json.loads((self.codex / "hooks.json").read_text()), {"hooks": {}})
        self.assertEqual(json.loads((self.codex_cu / "hooks.json").read_text()), {"hooks": {}})
        cfg = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertNotIn("hooks", cfg)

    def test_hooks_are_selected_by_harness(self) -> None:
        m = self.manifest()
        self.run_gen(m)
        all_claude = json.loads((self.claude / "settings.json").read_text())["hooks"]
        all_codex = json.loads((self.codex / "hooks.json").read_text())["hooks"]
        self.assertEqual(all_codex, json.loads((self.codex_cu / "hooks.json").read_text())["hooks"])

        def split(hooks: dict, recall: bool) -> dict:
            out = {}
            for event, groups in hooks.items():
                kept = [g for g in groups if ("/recall_hook.py" in g["hooks"][0]["command"]) == recall]
                if kept:
                    out[event] = kept
            return out

        claude_hooks, codex_hooks = split(all_claude, False), split(all_codex, False)
        self.assertEqual(set(claude_hooks), {"PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart"})
        # Codex has no PostToolUseFailure; turn-end hooks close desktop calls that failed without PostToolUse.
        self.assertEqual(set(codex_hooks), {"PreToolUse", "PostToolUse", "Stop", "SubagentStop", "SessionEnd"})
        claude_recall, codex_recall = split(all_claude, True), split(all_codex, True)
        self.assertEqual(set(claude_recall), {"UserPromptSubmit", "PostToolUse", "PostToolUseFailure",
                                              "SubagentStart", "Stop", "SubagentStop", "SessionEnd"})
        self.assertEqual(set(codex_recall), {"UserPromptSubmit", "PostToolUse", "SubagentStart",
                                             "Stop", "SubagentStop", "SessionEnd"})
        for hooks, harness in ((claude_recall, "claude"), (codex_recall, "codex")):
            for groups in hooks.values():
                self.assertTrue(all(g["hooks"][0]["command"].endswith(f"--harness {harness}") for g in groups))
        for groups in claude_hooks.values():
            for group in groups:
                self.assertIn("/claude.py", group["hooks"][0]["command"])
        for groups in codex_hooks.values():
            for group in groups:
                self.assertIn("/codex.py", group["hooks"][0]["command"])
        for groups in (claude_hooks["PreToolUse"], codex_hooks["PreToolUse"]):
            patterns = [re.compile(group["matcher"]) for group in groups]
            for tool in ("Bash", "bash", "shell", "exec_command", "shell_command", "mcp__betterstack__monitor", "mcp__example__exec_command",
                         "mcp__example__shell_command", "mcp__example__shell", "mcp__example__bash"):
                self.assertTrue(any(pattern.fullmatch(tool) for pattern in patterns), tool)
            self.assertFalse(any(pattern.fullmatch("mcp__example__apply_patch") for pattern in patterns))
        for hooks in (claude_hooks, codex_hooks):
            for event in ("PreToolUse", "PostToolUse"):
                patterns = [re.compile(group["matcher"]) for group in hooks[event]]
                for tool in ("mcp__cua-driver__click", "mcp__cua_driver__click", "mcp__node_repl__js"):
                    self.assertTrue(any(pattern.fullmatch(tool) for pattern in patterns), (event, tool))
        self.assertEqual(claude_hooks["PostToolUseFailure"][0]["matcher"],
                         codex_hooks["PostToolUse"][0]["matcher"])

    def test_post_tool_use_failure_rejects_codex_and_unscoped_hooks(self) -> None:
        m = self.manifest()
        for harness in ("codex", None):
            hook = {"event": "PostToolUseFailure", "command": "/bin/echo", "timeoutSec": 3}
            if harness:
                hook["harness"] = harness
            m["hooks"] = [hook]
            with self.assertRaises(gh.HomeError):
                gh.validate_manifest(m)

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
        skills, unreadable = gh.discover_skills([str(self.skill_root)])
        self.assertEqual(gh.skill_ops(str(self.claude / "skills"),
                                      skills, [str(self.skill_root)], unreadable), [])

    def test_codex_config_keeps_existing_hook_trust_state(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "matcher": None, "command": "/bin/echo", "timeoutSec": 3}]
        self.codex.mkdir(parents=True)
        (self.codex / "config.toml").write_text(
            '[hooks.state."abc"]\ntrusted_hash = "sha256:xyz"\n')
        self.run_gen(m)
        cfg = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(cfg["hooks"]["state"], {"abc": {"trusted_hash": "sha256:xyz"}})

    def test_codex_cu_shared_home_and_native_config(self) -> None:
        m = self.manifest()
        m["hooks"] = [
            {"event": "PreToolUse", "matcher": "Bash", "command": "/bin/echo", "timeoutSec": 3},
            {"event": "SessionStart", "command": "/usr/bin/true", "timeoutSec": 4, "harness": "codex"},
            {"event": "PostToolUse", "command": "/bin/echo", "timeoutSec": 5, "harness": "claude"},
        ]
        self.run_gen(m)
        base = tomllib.loads((self.codex / "config.toml").read_text())
        cu = tomllib.loads((self.codex_cu / "config.toml").read_text())
        self.assertEqual(cu.pop("model"), "gpt-6.1-terra")
        self.assertEqual(cu.pop("model_context_window"), 1050000)
        self.assertEqual(cu.pop("model_auto_compact_token_limit"), 450000)
        self.assertEqual(cu.pop("model_reasoning_effort"), "low")
        self.assertEqual(cu.pop("model_catalog_json"), str(self.codex_cu / "models.json"))
        self.assertIs(cu["features"].pop("computer_use"), True)
        node = cu["mcp_servers"].pop("node_repl")
        self.assertEqual(node, {
            "command": "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
            "startup_timeout_sec": 30,
            "tool_timeout_sec": 120,
            "env": {
                "CODEX_HOME": str(self.codex_cu),
                "NODE_REPL_NODE_PATH": "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
                "NODE_REPL_NODE_MODULE_DIRS": "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
                "NODE_REPL_TRUSTED_CODE_PATHS": "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
                "SKY_CUA_SERVICE_PATH": "/Volumes/ExternalSSD/codex/computer-use/Codex Computer Use.app",
                "NODE_REPL_DISABLE_ANALYTICS": "1",
                "BROWSER_USE_DISABLE_AMBIENT_NETWORK": "1",
            },
        })
        self.assertEqual(base.pop("model"), "gpt-6-astra")
        self.assertEqual(base.pop("model_context_window"), 872000)
        self.assertEqual(base.pop("model_auto_compact_token_limit"), 450000)
        self.assertEqual(base.pop("model_catalog_json"), str(self.codex / "models.json"))
        self.assertIs(base["features"].pop("computer_use"), False)
        self.assertNotIn("node_repl", base["mcp_servers"])
        self.assertEqual(cu.pop("computer_use"), {"default_app_access": "allow"})
        self.assertEqual(cu, base)
        self.assertEqual(cu["notify"], [])
        self.assertEqual(cu["analytics"], {"enabled": False})
        self.assertEqual(cu["feedback"], {"enabled": False})
        self.assertEqual(json.loads((self.codex / "hooks.json").read_text()),
                         json.loads((self.codex_cu / "hooks.json").read_text()))
        self.assertEqual(set(json.loads((self.codex_cu / "hooks.json").read_text())["hooks"]),
                         {"PreToolUse", "SessionStart"})
        self.assertEqual(set(json.loads((self.claude / "settings.json").read_text())["hooks"]),
                         {"PreToolUse", "PostToolUse"})
        self.assertNotIn("node_repl", json.loads((self.claude / ".claude.json").read_text())["mcpServers"])
        self.assertIn("Computer", json.loads((self.claude / "settings.json").read_text())["permissions"]["deny"])
        for farm in (self.claude / "skills", self.codex / "skills", self.codex_cu / "skills"):
            self.assertEqual({p.name: os.readlink(p) for p in farm.iterdir()},
                             {"alpha": str(self.skill_root / "alpha"),
                              "beta": str(self.skill_root / "cat/beta"),
                              "gamma": str(self.skill_root / "cat/deep/gamma")})
        self.assertEqual((self.codex_cu / "AGENTS.md").read_bytes(),
                         self.canonical.read_bytes() + b"\n\n" + self.codex_overlay.read_bytes()
                         + b"\n\n" + self.cu_overlay.read_bytes())
        rc, output = self.run_check(m)
        self.assertEqual(rc, 0, output)

    def test_only_cu_home_allows_every_app_for_computer_use(self) -> None:
        self.run_gen(self.manifest())
        cu = tomllib.loads((self.codex_cu / "config.toml").read_text())
        plain = tomllib.loads((self.codex / "config.toml").read_text())
        self.assertEqual(cu["computer_use"], {"default_app_access": "allow"})
        self.assertNotIn("computer_use", plain)

    def test_cu_catalog_carries_base_instructions_for_the_computer_use_service(self) -> None:
        self.run_gen(self.manifest())
        models = json.loads((self.codex_cu / "models.json").read_text())["models"]
        self.assertTrue(models)
        for model in models:
            template = (model.get("model_messages") or {}).get("instructions_template")
            if template:
                self.assertEqual(model["base_instructions"], template)

    def test_cu_catalog_extends_original_terra_without_losing_metadata(self) -> None:
        self.run_gen()
        upstream = json.loads((PKG / "vendor/codex-models-0.166.0.json").read_text())
        plain = json.loads((self.codex / "models.json").read_text())
        cu = json.loads((self.codex_cu / "models.json").read_text())
        cu_models = {m["slug"]: m for m in cu["models"]}
        original = next(m for m in upstream["models"] if m["slug"] == "gpt-6.1-terra")
        expected_terra = dict(original, slug="cx/gpt-6.1-terra", context_window=1050000,
                              max_context_window=1050000, auto_compact_token_limit=450000,
                              base_instructions=original["model_messages"]["instructions_template"])
        self.assertEqual(cu_models.pop("cx/gpt-6.1-terra"), expected_terra)
        self.assertEqual(cu_models.pop("gpt-6.1-terra"), dict(expected_terra, slug="gpt-6.1-terra"))
        with_base = lambda m: dict(m, base_instructions=m["model_messages"]["instructions_template"])
        self.assertEqual(cu_models, {m["slug"]: with_base(m) for m in plain["models"] if m["slug"] != "gpt-6.1-terra"})
        self.assertNotIn("cx/gpt-6.1-terra", {m["slug"] for m in plain["models"]})
        self.assertEqual([m for m in cu["models"] if m["slug"] not in {"gpt-6.1-terra", "cx/gpt-6.1-terra"}],
                         [with_base(m) for m in plain["models"] if m["slug"] != "gpt-6.1-terra"])
        self.assertTrue(all("base_instructions" not in m for m in plain["models"]))

    def test_check_detects_parity_isolation_analytics_and_catalog_drift(self) -> None:
        cases = (
            ("shared MCP", self.codex_cu, "config.toml", "tool_timeout_sec = 660", "tool_timeout_sec = 661"),
            ("CU analytics", self.codex_cu, "config.toml", 'NODE_REPL_DISABLE_ANALYTICS = "1"', 'NODE_REPL_DISABLE_ANALYTICS = "0"'),
            ("CU feature", self.codex_cu, "config.toml", "computer_use = true", "computer_use = false"),
            ("plain feature", self.codex, "config.toml", "computer_use = false", "computer_use = true"),
            ("plain injection", self.codex, "config.toml", "[mcp_servers.dia]", "[mcp_servers.node_repl]\ncommand = \"bad\"\n[mcp_servers.dia]"),
            ("CU catalog", self.codex_cu, "models.json", '"tool_mode": "code_mode_only"', '"tool_mode": "bad"'),
            ("CU hooks", self.codex_cu, "hooks.json", '"PreToolUse"', '"PostToolUse"'),
            ("Claude deny", self.claude, "settings.json", '"Computer"', '"Other"'),
            ("Claude MCP", self.claude, ".claude.json", '"https://mcp.betterstack.com"', '"http://example.invalid"'),
            ("CU shared instructions", self.codex_cu, "AGENTS.md", "Shared instructions.", "Lost instructions."),
            ("CU instructions", self.codex_cu, "AGENTS.md", "desktop lease", "no lease"),
        )
        for description, home, filename, original, corrupted in cases:
            with self.subTest(description=description):
                self.run_gen()
                path = home / filename
                text = path.read_text()
                self.assertIn(original, text)
                path.write_text(text.replace(original, corrupted, 1))
                rc, output = self.run_check()
                self.assertEqual(rc, 1, output)
                self.assertIn(filename, output)

    def test_hooks_are_selected_by_harness_not_command_name(self) -> None:
        m = self.manifest()
        m["hooks"] = [
            {"event": "PreToolUse", "command": "/bin/echo", "timeoutSec": 1},
            {"event": "SessionStart", "command": "/bin/echo", "timeoutSec": 2, "harness": "codex"},
            {"event": "UserPromptSubmit", "command": "/bin/echo", "timeoutSec": 3, "harness": "claude"},
        ]
        self.run_gen(m)
        self.assertEqual(set(json.loads((self.claude / "settings.json").read_text())["hooks"]),
                         {"PreToolUse", "UserPromptSubmit"})
        self.assertEqual(set(json.loads((self.codex / "hooks.json").read_text())["hooks"]),
                         {"PreToolUse", "SessionStart"})
        self.assertEqual(set(json.loads((self.codex_cu / "hooks.json").read_text())["hooks"]),
                         {"PreToolUse", "SessionStart"})
        self.assertEqual(self.run_check(m)[0], 0)
        for bad in ("unknown", "codex-cu", ["codex"], None, True, {}):
            with self.subTest(bad=bad):
                m["hooks"][0]["harness"] = bad
                with self.assertRaises(gh.HomeError):
                    gh.validate_manifest(m)
        del m["hooks"][0]["harness"]
        m["hooks"][0]["harnesses"] = ["codex"]
        with self.assertRaises(gh.HomeError):
            gh.validate_manifest(m)

    def test_missing_or_blank_cu_overlay_fails_before_any_write(self) -> None:
        m = self.manifest()
        for contents in (None, " \n<!-- draft -->\n"):
            with self.subTest(contents=contents):
                if contents is None:
                    self.cu_overlay.unlink()
                else:
                    self.cu_overlay.write_text(contents)
                with mock.patch.object(gh, "load_manifest", return_value=m):
                    with contextlib.redirect_stderr(io.StringIO()) as errors:
                        rc = gh.main(["generate", "--home-root", str(self.root)])
                self.assertEqual(rc, 1)
                self.assertIn("overlay", errors.getvalue())
                self.assertFalse(self.root.exists())

    def test_manifest_cu_overlay_is_used_by_generate_and_check(self) -> None:
        m = self.manifest()
        self.run_gen(m)
        self.assertEqual(self.run_check(m)[0], 0)
        self.cu_overlay.write_text("# Changed CU fixture\n")
        rc, output = self.run_check(m)
        self.assertEqual(rc, 1, output)
        self.assertIn("AGENTS.md", output)
        self.run_gen(m)
        self.assertEqual(self.run_check(m)[0], 0)

    def test_packaged_cu_overlay_builds_without_override(self) -> None:
        m = self.manifest()
        m["instructions"]["overlays"]["codex-cu"] = "overlays/codex-cu.md"
        self.run_gen(m)
        self.assertEqual((self.codex_cu / "AGENTS.md").read_bytes(),
                         self.canonical.read_bytes() + b"\n\n" + self.codex_overlay.read_bytes()
                         + b"\n\n" + (PKG / "overlays/codex-cu.md").read_bytes())
        self.assertEqual(self.run_check(m)[0], 0)

    def test_shared_codex_overlay_changes_require_both_homes_to_regenerate(self) -> None:
        self.run_gen()
        self.codex_overlay.write_text("# Changed shared Codex instructions\n")
        rc, output = self.run_check()
        self.assertEqual(rc, 1, output)
        self.assertIn(str(self.codex / "AGENTS.md"), output)
        self.assertIn(str(self.codex_cu / "AGENTS.md"), output)
        self.run_gen()
        self.assertEqual(self.run_check()[0], 0)

    def test_cu_symlink_into_personal_home_refuses_all_writes(self) -> None:
        personal = self.home / ".codex/skills"
        personal.mkdir(parents=True)
        self.codex_cu.mkdir(parents=True)
        os.symlink(personal, self.codex_cu / "skills")
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()):
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertEqual(os.listdir(personal), [])
        self.assertFalse((self.codex / "config.toml").exists())

    def test_manifest_refuses_node_repl_as_shared_mcp(self) -> None:
        m = self.manifest()
        m["mcpServers"].append({"id": "node_repl", "command": "/bin/echo", "args": [],
                                "toolTimeoutSec": 1, "startupTimeoutSec": 1})
        with self.assertRaises(gh.HomeError):
            gh.validate_manifest(m)

    def test_cu_hook_trust_is_independent_per_home(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "command": "/bin/echo", "timeoutSec": 3}]
        self.codex.mkdir(parents=True)
        self.codex_cu.mkdir(parents=True)
        (self.codex / "config.toml").write_text('[hooks.state."normal"]\ntrusted_hash = "sha256:one"\n')
        (self.codex_cu / "config.toml").write_text('[hooks.state."cu"]\ntrusted_hash = "sha256:two"\n')
        self.run_gen(m)
        base = tomllib.loads((self.codex / "config.toml").read_text())
        cu = tomllib.loads((self.codex_cu / "config.toml").read_text())
        self.assertEqual(base["hooks"]["state"], {"normal": {"trusted_hash": "sha256:one"}})
        self.assertEqual(cu["hooks"]["state"], {"cu": {"trusted_hash": "sha256:two"}})

    def test_removed_hooks_are_cleared_from_both_homes(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "command": "/bin/echo", "timeoutSec": 3}]
        self.run_gen(m)
        m["hooks"] = []
        self.run_gen(m)
        for home in (self.codex, self.codex_cu):
            self.assertEqual(json.loads((home / "hooks.json").read_text()), {"hooks": {}})
        self.assertEqual(self.run_check(m)[0], 0)

    def test_rescoping_hook_removes_it_from_both_codex_homes(self) -> None:
        m = self.manifest()
        m["hooks"] = [{"event": "PreToolUse", "command": "/bin/echo", "timeoutSec": 3,
                       "harness": "codex"}]
        self.run_gen(m)
        m["hooks"][0]["harness"] = "claude"
        self.run_gen(m)
        self.assertIn("PreToolUse", json.loads((self.claude / "settings.json").read_text())["hooks"])
        for home in (self.codex, self.codex_cu):
            self.assertEqual(json.loads((home / "hooks.json").read_text()), {"hooks": {}})
            self.assertNotIn("hooks", tomllib.loads((home / "config.toml").read_text()))
        self.assertEqual(self.run_check(m)[0], 0)

    def test_secret_in_cu_overlay_refuses_all_writes(self) -> None:
        self.cu_overlay.write_text("draft sk-abcdefghijklmnop\n")
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                rc = gh.main(["generate", "--home-root", str(self.root)])
        self.assertEqual(rc, 1)
        self.assertIn("secret-looking", errors.getvalue())
        self.assertFalse(self.root.exists())

    def test_check_fails_if_only_claude_node_repl_deny_is_removed(self) -> None:
        self.run_gen()
        path = self.claude / "settings.json"
        settings = json.loads(path.read_text())
        settings["permissions"]["deny"].remove("mcp__node_repl")
        path.write_text(json.dumps(settings))
        rc, output = self.run_check()
        self.assertEqual(rc, 1, output)
        self.assertIn("CU deny rules missing", output)

    def test_dry_run_writes_nothing(self) -> None:
        out = self.run_gen(extra=["--dry-run"])
        self.assertIn("would write", out)
        self.assertFalse(self.root.exists())


class ParityTests(HarnessTestCase):
    def json_check(self):
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh.main(["check", "--home-root", str(self.root), "--json"])
        return rc, json.loads(out.getvalue())

    def test_parity_inventory_and_machine_readable_existing_check(self):
        self.run_gen()
        rc, result = self.json_check()
        self.assertEqual(rc, 0, result)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["failures"], [])
        for entry in result["homes"]:
            home = Path(entry["home"])
            parity = json.loads(Path(entry["parityManifestPath"]).read_text())
            self.assertEqual(parity["harness"], entry["harness"])
            self.assertEqual(parity["schemaVersion"], 1)
            self.assertEqual({skill["name"] for skill in parity["skills"]}, {"alpha", "beta", "gamma"})
            for skill in parity["skills"]:
                self.assertEqual(os.readlink(home / "skills" / skill["name"]), skill["source"])
                self.assertEqual(hashlib.sha256((Path(skill["source"]) / "SKILL.md").read_bytes()).hexdigest(), skill["sha256"])
            self.assertEqual({server["id"] for server in parity["mcpServers"]},
                             {server["id"] for server in self.manifest()["mcpServers"]})
            self.assertIn("recall", {server["id"] for server in parity["mcpServers"]})
            self.assertEqual(parity["runtimeMcpServers"], ["t3-code"])
            self.assertEqual({guard["id"] for guard in parity["guards"]},
                             {"hook-adapters", "live-database", "offbox", "betterstack-scope", "coord-haiku", "desktop-lease", "recall"})
            self.assertFalse(parity["compactSkillCatalog"]["required"])
            self.assertEqual(parity["instructions"]["canonical"]["path"], str(self.canonical))
            self.assertFalse((home / "src").exists())
            expected_names = {"settings.json", ".claude.json", "CLAUDE.md", "overlay.md"} if home.name == "claude" else {"config.toml", "hooks.json", "AGENTS.md", "models.json"}
            self.assertEqual({Path(artifact["path"]).name for artifact in parity["artifacts"]}, expected_names)
            for artifact in parity["artifacts"]:
                self.assertTrue(Path(artifact["path"]).is_absolute())
                self.assertEqual(Path(artifact["path"]).parent, home)
                content = Path(artifact["path"]).read_bytes()
                if Path(artifact["path"]).name == ".claude.json":
                    self.assertEqual(artifact["format"], "claude-owned-json")
                    content = gh.claude_owned_json(content)
                else:
                    self.assertNotIn("format", artifact)
                self.assertEqual(artifact["sha256"], hashlib.sha256(content).hexdigest())

    def test_artifact_digests_use_expected_not_tampered_output_bytes(self):
        self.run_gen()
        for home, name, change in [
            (self.claude, "settings.json", lambda text: text.replace("Bash|bash|shell|exec_command|shell_command", "NeverMatches")),
            (self.claude, ".claude.json", lambda text: text.replace("http://127.0.0.1:18765/mcp", "http://127.0.0.1:9/mcp")),
            (self.codex, "hooks.json", lambda text: text.replace("Bash|bash|shell|exec_command|shell_command", "NeverMatches")),
            (self.codex, "config.toml", lambda text: text.replace("http://127.0.0.1:18765/mcp", "http://127.0.0.1:9/mcp")),
            (self.codex_cu, "AGENTS.md", lambda text: text + "\nEdited instructions\n"),
            (self.codex_cu, "models.json", lambda text: text.replace('"models":', '"edited":')),
        ]:
            with self.subTest(home=home.name, file=name):
                path = home / name
                original = path.read_bytes()
                path.write_text(change(original.decode()))
                with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
                    _, _, _, _, planned = gh.plan_all(str(self.root))
                parity = json.loads(planned[str(home / gh.PARITY_MANIFEST)])
                artifact = next(artifact for artifact in parity["artifacts"] if artifact["path"] == str(path))
                expected_bytes = gh.claude_owned_json(original) if name == ".claude.json" else original
                actual_bytes = gh.claude_owned_json(path.read_bytes()) if name == ".claude.json" else path.read_bytes()
                self.assertEqual(artifact["sha256"], hashlib.sha256(expected_bytes).hexdigest())
                self.assertNotEqual(artifact["sha256"], hashlib.sha256(actual_bytes).hexdigest())
                self.assertEqual(self.json_check()[0], 1)
                path.write_bytes(original)

    def test_claude_runtime_fields_do_not_change_owned_artifact_or_check(self):
        self.run_gen()
        path = self.claude / ".claude.json"
        parity_path = self.claude / gh.PARITY_MANIFEST
        parity_before = parity_path.read_bytes()
        value = json.loads(path.read_bytes())
        value.update(projects={"/tmp/example": {"lastCost": 1.25}}, numStartups=42, runtimeField="日常")
        path.write_text(json.dumps(value, ensure_ascii=False))
        self.assertEqual(self.json_check()[0], 0)
        self.assertEqual(parity_path.read_bytes(), parity_before)
        self.run_gen()
        self.assertEqual(json.loads(path.read_bytes())["runtimeField"], "日常")
        self.assertEqual(parity_path.read_bytes(), parity_before)
        value["mcpServers"]["recall"]["url"] = "http://127.0.0.1:9/mcp"
        path.write_text(json.dumps(value))
        self.assertEqual(self.json_check()[0], 1)

    def test_claude_owned_json_is_sorted_compact_utf8(self):
        content = b'{"runtime":42,"mcpServers":{"z":{"b":2,"a":"\\u65e5"},"a":{}},"hasCompletedOnboarding":true}'
        expected = '{"hasCompletedOnboarding":true,"mcpServers":{"a":{},"z":{"a":"日","b":2}}}'.encode("utf-8")
        self.assertEqual(gh.claude_owned_json(content), expected)

    def test_all_roots_and_new_skills_change_inventory_without_fixed_count(self):
        second = self.tmp / "second-root"
        write(second / "delta/SKILL.md", "---\nname: delta\n---\nnew\n")
        alias = self.tmp / "skill-root-alias"
        alias.symlink_to(self.skill_root, target_is_directory=True)
        manifest = self.manifest()
        manifest["skillRoots"].extend([str(second), str(alias)])
        self.run_gen(manifest)
        for home in (self.claude, self.codex, self.codex_cu):
            parity = json.loads((home / gh.PARITY_MANIFEST).read_text())
            self.assertEqual({skill["name"] for skill in parity["skills"]}, {"alpha", "beta", "gamma", "delta"})
            self.assertEqual(os.readlink(home / "skills/delta"), str(second / "delta"))
        self.assertEqual(self.run_check(manifest)[0], 0)

    def test_check_detects_stale_source_inventory_and_tampering_without_writes(self):
        self.run_gen()
        path = self.codex / gh.PARITY_MANIFEST
        before = path.read_bytes()
        write(self.skill_root / "alpha/SKILL.md", "---\nname: alpha\n---\nupdated body\n")
        rc, result = self.json_check()
        self.assertEqual(rc, 1)
        self.assertFalse(result["ok"])
        self.assertTrue(any(gh.PARITY_MANIFEST in failure for failure in result["failures"]))
        self.assertEqual(path.read_bytes(), before)
        self.run_gen()
        parity = json.loads(path.read_text())
        parity["guards"] = []
        path.write_text(json.dumps(parity))
        self.assertEqual(self.json_check()[0], 1)

    def test_installed_offbox_layout_uses_shared_skill_not_an_extra_copy(self):
        installed = self.tmp / "installed/remote-compute/scripts/classify.py"
        write(installed, "# installed fixture\n")
        digest = gh.parity_source({"source": "missing-source.py", "installed": str(installed)})
        self.assertEqual(digest["path"], str(installed))
        self.assertEqual(digest["sha256"], hashlib.sha256(installed.read_bytes()).hexdigest())

    def test_json_check_reports_unreadable_required_source_without_writes(self):
        manifest = self.manifest()
        manifest["paritySources"]["live-database"] = ["missing-guard.py"]
        with mock.patch.object(gh, "load_manifest", return_value=manifest):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh.main(["check", "--home-root", str(self.root), "--json"])
        result = json.loads(out.getvalue())
        self.assertEqual(rc, 1)
        self.assertFalse(result["ok"])
        self.assertIn("missing-guard.py", result["failures"][0])
        self.assertFalse(self.root.exists())


def opencode_entry(server: dict) -> dict:
    """The OpenCode `mcp` form of a manifest server."""
    if "url" in server:
        return {"type": "remote", "url": server["url"], "enabled": True}
    entry = {"type": "local", "command": [server["command"], *server["args"]], "enabled": True}
    if server.get("env"):
        entry["environment"] = dict(server["env"])
    return entry


class McpParityTests(HarnessTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.oc_path = self.home / ".config/opencode/opencode.jsonc"
        self.mcp = {s["id"]: opencode_entry(s) for s in self.manifest()["mcpServers"]}
        self.write_oc()

    def write_oc(self, mcp: dict | None = None, *, raw: str | None = None) -> None:
        if raw is None:
            body = json.dumps({"$schema": "https://opencode.ai/config.json",
                               "mcp": self.mcp if mcp is None else mcp}, indent=2)
            # Real-world JSONC: comments everywhere and trailing commas.
            body = body.replace('"mcp": {', '// MCP servers live here\n  "mcp": { /* block\n comment */', 1)
            body = body.replace("\n  }\n}", ",\n  },\n}\n// trailing comment")
            raw = body
        write(self.oc_path, raw)

    def check(self, manifest: dict | None = None, json_output: bool = False) -> tuple[int, str]:
        args = ["check", "--home-root", str(self.root), "--opencode-config", str(self.oc_path)]
        with mock.patch.object(gh, "load_manifest", return_value=manifest or self.manifest()):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh.main(args + (["--json"] if json_output else []))
        return rc, out.getvalue()

    def diff(self, manifest: dict | None = None) -> tuple[int, dict]:
        with mock.patch.object(gh, "load_manifest", return_value=manifest or self.manifest()):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh.main(["mcp-diff", "--json", "--opencode-config", str(self.oc_path)])
        return rc, json.loads(out.getvalue())

    def gen(self) -> tuple[str, str]:
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                rc = gh.main(["generate", "--home-root", str(self.root), "--opencode-config", str(self.oc_path)])
        self.assertEqual(rc, 0, err.getvalue())
        return out.getvalue(), err.getvalue()

    def test_manifest_declares_parity_against_opencode_config(self) -> None:
        manifest = self.manifest()
        self.assertEqual(manifest["mcpParity"], {"opencodeConfig": "~/.config/opencode/opencode.jsonc", "ignore": []})
        gh.validate_manifest(manifest)

    def test_matching_sets_pass_check_and_diff(self) -> None:
        _, err = self.gen()
        self.assertEqual(err, "")
        rc, out = self.check()
        self.assertEqual(rc, 0, out)
        rc, result = self.check(json_output=True)
        self.assertEqual(rc, 0, result)
        self.assertEqual(json.loads(result)["failures"], [])
        rc, diff = self.diff()
        self.assertEqual(rc, 0, diff)
        self.assertEqual({row["id"] for row in diff["servers"]}, set(self.mcp))
        self.assertTrue(all(row["status"] == "ok" for row in diff["servers"]))

    def test_opencode_only_server_fails_check(self) -> None:
        self.mcp["newthing"] = {"type": "local", "command": ["/bin/newthing"], "enabled": True}
        self.write_oc()
        self.gen()
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("mcp parity: opencode has newthing, native manifest lacks it", out)
        rc, diff = self.diff()
        self.assertEqual(rc, 1)
        self.assertEqual(next(r for r in diff["servers"] if r["id"] == "newthing")["status"], "opencode-only")

    def test_native_only_server_fails_check_json(self) -> None:
        del self.mcp["inbody"]
        self.write_oc()
        self.gen()
        rc, out = self.check(json_output=True)
        result = json.loads(out)
        self.assertEqual(rc, 1)
        self.assertFalse(result["ok"])
        self.assertIn("mcp parity: native manifest has inbody, opencode lacks it", result["failures"])

    def test_disabled_opencode_entry_counts_as_absent(self) -> None:
        self.mcp["inbody"]["enabled"] = False
        self.mcp["oldthing"] = {"type": "remote", "url": "https://old.example/mcp", "enabled": False}
        self.write_oc()
        self.gen()
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("native manifest has inbody, opencode lacks it (disabled in opencode)", out)
        self.assertNotIn("oldthing", out)
        manifest = self.manifest()
        manifest["mcpServers"] = [s for s in manifest["mcpServers"] if s["id"] != "inbody"]
        self.run_gen(manifest)
        self.assertEqual(self.check(manifest)[0], 0)

    def test_missing_enabled_key_means_enabled(self) -> None:
        self.mcp["recall"].pop("enabled")
        self.mcp["extra"] = {"type": "remote", "url": "https://x.example/mcp"}
        self.write_oc()
        self.gen()
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("opencode has extra", out)
        self.assertNotIn("recall", out)

    def test_ignore_list_is_honored_on_both_sides(self) -> None:
        self.mcp["opencode-only-tool"] = {"type": "local", "command": ["/bin/tool"], "enabled": True}
        del self.mcp["flighty"]
        self.write_oc()
        manifest = self.manifest()
        manifest["mcpParity"]["ignore"] = ["opencode-only-tool", "flighty"]
        self.run_gen(manifest)
        rc, out = self.check(manifest)
        self.assertEqual(rc, 0, out)
        rc, diff = self.diff(manifest)
        self.assertEqual(rc, 0, diff)
        statuses = {row["id"]: row["status"] for row in diff["servers"]}
        self.assertEqual(statuses["opencode-only-tool"], "ignored")
        self.assertEqual(statuses["flighty"], "ignored")

    def test_url_transport_command_and_args_mismatches_are_reported(self) -> None:
        self.mcp["recall"]["url"] = "http://127.0.0.1:9999/mcp"
        self.mcp["betterstack"] = {"type": "local", "command": ["/bin/betterstack"], "enabled": True}
        self.mcp["inbody"]["command"] = ["/usr/local/bin/inbody-mcp"]
        self.mcp["cua-driver"]["command"] = [self.mcp["cua-driver"]["command"][0], "serve"]
        self.write_oc()
        self.gen()
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("mcp parity: recall url differs (opencode http://127.0.0.1:9999/mcp, "
                      "native http://127.0.0.1:18765/mcp)", out)
        self.assertIn("mcp parity: betterstack transport differs (opencode command, native url)", out)
        self.assertIn("mcp parity: inbody command differs (opencode /usr/local/bin/inbody-mcp, "
                      "native /Users/ardud/bin/inbody-mcp)", out)
        self.assertIn('cua-driver args differ (opencode ["serve"], native ["mcp"])', out)
        rc, diff = self.diff()
        self.assertEqual(next(r for r in diff["servers"] if r["id"] == "recall")["status"], "mismatch")

    def test_env_key_drift_is_reported_without_values(self) -> None:
        self.mcp["dia"]["environment"] = {"OTHER": "sk-abcdefghijklmnop"}
        self.write_oc()
        rc, diff = self.diff()
        self.assertEqual(rc, 1)
        text = json.dumps(diff)
        self.assertIn("dia env keys differ", text)
        self.assertNotIn("sk-abcdefghijklmnop", text)

    def test_unparseable_config_fails_check_but_not_generate(self) -> None:
        self.write_oc(raw='{"mcp": {"recall": {"url": "http://x" "oops"}}}')
        out, err = self.gen()
        self.assertIn("warning: mcp parity: cannot parse opencode config", err)
        self.assertTrue((self.claude / ".claude.json").exists())
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("mcp parity: cannot parse opencode config", out)
        rc, result = self.check(json_output=True)
        self.assertEqual(rc, 1)
        self.assertTrue(any("cannot parse" in f for f in json.loads(result)["failures"]))

    def test_missing_config_fails_closed(self) -> None:
        self.oc_path.unlink()
        _, err = self.gen()
        self.assertIn("warning: mcp parity: cannot read opencode config", err)
        rc, out = self.check()
        self.assertEqual(rc, 1)
        self.assertIn("mcp parity: cannot read opencode config", out)
        rc, diff = self.diff()
        self.assertEqual(rc, 1)
        self.assertFalse(diff["ok"])

    def test_generate_warns_on_drift_and_still_writes(self) -> None:
        del self.mcp["dia"]
        self.write_oc()
        _, err = self.gen()
        self.assertIn("warning: mcp parity: native manifest has dia, opencode lacks it", err)
        self.assertIn("dia", json.loads((self.claude / ".claude.json").read_text())["mcpServers"])

    def test_configured_homes_use_manifest_path_and_home_root_runs_skip_parity(self) -> None:
        # A --home-root run without --opencode-config (tests, harness-cli canary) never compares.
        self.oc_path.unlink()
        self.run_gen()
        self.assertEqual(self.run_check()[0], 0)
        # The configured homes use mcpParity.opencodeConfig, expanded under HOME.
        manifest = self.manifest()
        self.write_oc()
        self.assertEqual(gh.opencode_config_path(manifest, None), str(self.oc_path))
        self.assertTrue(gh.parity_applies(manifest, None, None))
        self.assertFalse(gh.parity_applies(manifest, str(self.root), None))
        del manifest["mcpParity"]
        self.assertFalse(gh.parity_applies(manifest, None, None))

    def test_human_diff_lists_both_sides(self) -> None:
        self.mcp["recall"]["url"] = "http://127.0.0.1:1/mcp"
        self.write_oc()
        with mock.patch.object(gh, "load_manifest", return_value=self.manifest()):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                rc = gh.main(["mcp-diff", "--opencode-config", str(self.oc_path)])
        text = out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("MISMATCH      recall", text)
        self.assertIn("opencode  url http://127.0.0.1:1/mcp", text)
        self.assertIn("native    url http://127.0.0.1:18765/mcp", text)
        self.assertIn("DRIFT 1 mcp parity failure(s)", text)

    def test_invalid_parity_block_is_refused(self) -> None:
        manifest = self.manifest()
        manifest["mcpParity"]["ignore"] = "recall"
        with self.assertRaises(gh.HomeError):
            gh.validate_manifest(manifest)


class JsoncTests(unittest.TestCase):
    def test_slashes_inside_strings_are_kept(self) -> None:
        text = '''{
          // a comment with "quotes" and https://x
          "url": "https://mcp.example.com//path", /* inline */ "glob": "a/*b*/c",
          "esc": "quote \\" // not a comment",
          "list": [1, 2, 3,],
          "obj": {"a": 1,
            // trailing comment before brace
          },
        }'''
        self.assertEqual(gh.loads_jsonc(text), {
            "url": "https://mcp.example.com//path", "glob": "a/*b*/c",
            "esc": 'quote " // not a comment', "list": [1, 2, 3], "obj": {"a": 1}})

    def test_comma_inside_string_before_brace_is_kept(self) -> None:
        self.assertEqual(gh.loads_jsonc('{"a": ",}", "b": [",]"],}'), {"a": ",}", "b": [",]"]})

    def test_bom_and_trailing_backslash_escape(self) -> None:
        self.assertEqual(gh.loads_jsonc('\ufeff{"p": "C:\\\\dir\\\\", // c\n}'), {"p": "C:\\dir\\"})

    def test_errors(self) -> None:
        for bad in ('{"a": 1 /* never closed', '{"a": "never closed', '{"a" 1}', ""):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                gh.loads_jsonc(bad)

    def test_live_style_opencode_block_parses(self) -> None:
        text = '''{
          "$schema": "https://opencode.ai/config.json",
          "mcp": {
            // Recall: search over past sessions
            "recall": {"type": "remote", "url": "http://127.0.0.1:18765/mcp", "enabled": true},
            "dia": {"type": "local", "command": ["/node", "/srv.js"], "environment": {"K": "v"}, "enabled": true},
          },
        }'''
        mcp = gh.loads_jsonc(text)["mcp"]
        self.assertEqual(gh.opencode_mcp_view(mcp["recall"]), {"kind": "url", "url": "http://127.0.0.1:18765/mcp", "enabled": True})
        self.assertEqual(gh.opencode_mcp_view(mcp["dia"]), {"kind": "command", "command": "/node", "args": ["/srv.js"],
                                                            "envKeys": ["K"], "enabled": True})


if __name__ == "__main__":
    unittest.main()
