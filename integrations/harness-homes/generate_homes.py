#!/opt/homebrew/bin/python3
"""Generate Robob's Claude Code and Codex homes from one non-secret manifest.

generate  writes both homes; prints one line per file or link that changed.
check     verifies both homes against the manifest; exit 1 lists each failure.

Stdlib only. Never reads or writes the personal homes (~/.claude, ~/.codex,
/Volumes/ExternalSSD/codex). Auth lives in the instance environment, not here.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import tomllib
from pathlib import Path

PKG = Path(__file__).resolve().parent
SECRET_RE = re.compile(r"(sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{10,}|ghp_[A-Za-z0-9]{10,})")
PERSONAL_HOMES = ("~/.claude", "~/.codex", "/Volumes/ExternalSSD/codex")
INLINE_KEYS = {"http_headers", "env", "set"}
CLAUDE_PLUGIN_KEY = "cc-plugin-agents-md@builtin"
RESERVED_IDS = {"t3-code"}  # Robob injects this per thread
HOOK_EVENTS = ("PreToolUse", "UserPromptSubmit", "PostToolUse", "SessionStart")
CODEX_MODEL_KEYS = ("context_window", "max_context_window")


class HomeError(Exception):
    """A refusal or a bad input. Raised before any write happens."""


def expand(p: str) -> str:
    if p == "~" or p.startswith("~/"):
        return os.environ["HOME"] + p[1:]
    return p


def load_manifest() -> dict:
    return json.loads((PKG / "manifest.json").read_text(encoding="utf-8"))


def resolve_homes(manifest: dict, home_root: str | None) -> tuple[str, str]:
    if home_root:
        root = expand(home_root)
        claude, codex = os.path.join(root, "claude"), os.path.join(root, "codex")
    else:
        claude = expand(manifest["homes"]["claude"])
        codex = expand(manifest["homes"]["codex"])
    for home in (claude, codex):
        guard_home(home)
    return os.path.abspath(claude), os.path.abspath(codex)


def guard_home(path: str) -> None:
    real = os.path.realpath(path)
    for p in PERSONAL_HOMES:
        forbidden = os.path.realpath(expand(p))
        if real == forbidden or real.startswith(forbidden + os.sep):
            raise HomeError(f"refusing home {path}: it is inside personal home {forbidden}")


def guard_outputs(paths: list[str]) -> None:
    """Refuse any output path whose existing ancestor (or itself, if a symlink) resolves
    into a personal home. Runs before any mutation, so a symlinked skills/ or home
    ancestor cannot leak writes or chmods into ~/.claude, ~/.codex or the external codex dir.
    """
    forbidden = [os.path.realpath(expand(p)) for p in PERSONAL_HOMES]
    for path in paths:
        probe = os.path.abspath(path)
        while True:
            if os.path.lexists(probe):
                real = os.path.realpath(probe)
                for f in forbidden:
                    if real == f or real.startswith(f + os.sep):
                        raise HomeError(f"refusing to write {path}: {probe} resolves into personal home {f}")
            parent = os.path.dirname(probe)
            if parent == probe:
                break
            probe = parent


def read_bytes(path: str) -> bytes | None:
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        return None


def read_json_or_empty(path: str) -> dict:
    data = read_bytes(path)
    if data is None or not data.strip():
        return {}
    try:
        value = json.loads(data)
    except json.JSONDecodeError as exc:
        raise HomeError(f"{path} is not valid JSON ({exc}); fix or remove it") from exc
    if not isinstance(value, dict):
        raise HomeError(f"{path} must hold a JSON object")
    return value


def json_bytes(value) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def deep_merge(base: dict, over: dict, replace: frozenset = frozenset()) -> dict:
    """Overlay generator-owned keys; keys not in `over` stay as they are."""
    out = dict(base)
    for key, value in over.items():
        if key in replace or not isinstance(value, dict) or not isinstance(out.get(key), dict):
            out[key] = value
        else:
            out[key] = deep_merge(out[key], value)
    return out


# ---------- skills ----------

def skill_name(skill_md: Path) -> str:
    lines = skill_md.read_text(encoding="utf-8", errors="replace").splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() == "---":
                break
            m = re.match(r"^name:\s*(.*?)\s*$", line)
            if m:
                value = m.group(1)
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                if value:
                    return value
    return skill_md.parent.name


def discover_skills(skill_roots: list[str]) -> list[tuple[str, str]]:
    """Return (name, skill_dir) for every directory holding SKILL.md, collision-checked."""
    found: list[tuple[str, str]] = []
    seen_real: set[str] = set()
    for root in skill_roots:
        if not os.path.isdir(root):
            raise HomeError(f"skill root missing: {root}")
        stack = [os.path.normpath(root)]
        visited: set[str] = set()
        while stack:
            current = stack.pop()
            real = os.path.realpath(current)
            if real in visited:
                continue
            visited.add(real)
            try:
                entries = sorted(os.scandir(current), key=lambda e: e.name)
            except OSError:
                continue
            is_skill = False
            subdirs = []
            for entry in entries:
                if entry.name == "SKILL.md" and entry.is_file(follow_symlinks=True):
                    is_skill = True
                elif entry.is_dir(follow_symlinks=True):
                    subdirs.append(entry.path)
            if is_skill and real not in seen_real:
                seen_real.add(real)
                name = skill_name(Path(current) / "SKILL.md")
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
                    raise HomeError(f"skill name {name!r} at {current} is not a safe link name")
                found.append((name, current))
            stack.extend(reversed(subdirs))
    by_name: dict[str, list[str]] = {}
    for name, path in found:
        by_name.setdefault(name, []).append(path)
    clashes = {n: p for n, p in by_name.items() if len(p) > 1}
    if clashes:
        lines = [f"  {name}: " + " and ".join(paths) for name, paths in sorted(clashes.items())]
        raise HomeError("skill name collision, nothing written:\n" + "\n".join(lines))
    return sorted(found)


def skill_ops(skills_dir: str, skills: list[tuple[str, str]], roots: list[str]) -> list[tuple]:
    """Plan the skills/ farm: ("unlink", path) or ("link", path, target). Writes nothing.

    Real directories and symlinks that point outside the skill roots are never touched.
    """
    desired = {name: path for name, path in skills}
    root_forms = {os.path.normpath(expand(r)) for r in roots} | {os.path.realpath(expand(r)) for r in roots}

    def into_root(target: str) -> bool:
        return any(target.startswith(r + os.sep) for r in root_forms)

    if os.path.lexists(skills_dir) and not os.path.isdir(skills_dir):
        raise HomeError(f"{skills_dir} exists and is not a directory")
    ops: list[tuple] = []
    if os.path.isdir(skills_dir):
        for entry in sorted(os.listdir(skills_dir)):
            link = os.path.join(skills_dir, entry)
            if not os.path.islink(link):
                continue
            target = os.path.normpath(os.path.join(skills_dir, os.readlink(link)))
            if not into_root(target):
                continue
            if desired.get(entry) == target:
                continue
            ops.append(("unlink", link))  # gone or no longer discovered
    for name in sorted(desired):
        link = os.path.join(skills_dir, name)
        if os.path.islink(link):
            if os.path.normpath(os.path.join(skills_dir, os.readlink(link))) == desired[name]:
                continue
            if any(op == ("unlink", link) for op in ops):
                ops.append(("link", link, desired[name]))
                continue
            raise HomeError(f"{link} is a symlink to another place; move it aside")
        if os.path.lexists(link):
            raise HomeError(f"{link} exists and is not a generated skill link; move it aside")
        ops.append(("link", link, desired[name]))
    return ops


# ---------- content builders ----------

def claude_hooks(hooks: list[dict]) -> dict:
    out: dict[str, list] = {}
    for hook in hooks:
        group: dict = {}
        if hook.get("matcher") is not None:
            group["matcher"] = hook["matcher"]
        group["hooks"] = [{"type": "command", "command": hook["command"], "timeout": hook["timeoutSec"]}]
        out.setdefault(hook["event"], []).append(group)
    return out


def claude_mcp(servers: list[dict]) -> dict:
    out = {}
    for s in servers:
        timeout_ms = s["toolTimeoutSec"] * 1000
        if "url" in s:
            out[s["id"]] = {"type": "http", "url": s["url"], "timeout": timeout_ms}
        else:
            entry = {"type": "stdio", "command": s["command"], "args": list(s["args"])}
            if s.get("env"):
                entry["env"] = dict(s["env"])
            entry["timeout"] = timeout_ms
            out[s["id"]] = entry
    return out


def claude_settings_owned(manifest: dict) -> dict:
    c = manifest["claude"]
    return {
        "autoMemoryEnabled": False,
        "autoDreamEnabled": False,
        "cleanupPeriodDays": c["cleanupPeriodDays"],
        "skipWebFetchPreflight": True,
        "skipDangerousModePermissionPrompt": True,
        "includeCoAuthoredBy": False,
        "pluginConfigs": {CLAUDE_PLUGIN_KEY: {"options": {"instructionFiles": "claude-md-and-agents-md"}}},
        "env": {
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_ORG_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:20128",
            "ANTHROPIC_CUSTOM_HEADERS": "x-9router-token-saver: off",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW": c["autoCompactWindow"],
            "API_TIMEOUT_MS": "1800000",
            "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "900000",
            "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS": "900000",
            "CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS": "900000",
            "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": str(c["subagentDepth"]),
        },
        "hooks": claude_hooks(manifest["hooks"]),
    }


def toml_key(key: str) -> str:
    return key if re.fullmatch(r"[A-Za-z0-9_]+", key) else json.dumps(key, ensure_ascii=False)


def toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        return "{ " + ", ".join(f"{toml_key(k)} = {toml_value(v)}" for k, v in value.items()) + " }"
    raise HomeError(f"unsupported TOML value: {value!r}")


def toml_dump(data: dict) -> str:
    lines: list[str] = []

    def emit(table: dict, path: list[str]) -> None:
        scalars, subtables = [], []
        for key, value in table.items():
            if isinstance(value, dict) and key not in INLINE_KEYS:
                subtables.append((key, value))
            else:
                scalars.append((key, value))
        if path:
            lines.append("[" + ".".join(toml_key(p) for p in path) + "]")
        for key, value in scalars:
            lines.append(f"{toml_key(key)} = {toml_value(value)}")
        if path:
            lines.append("")
        for key, value in subtables:
            emit(value, path + [key])

    emit(data, [])
    text = "\n".join(lines).rstrip() + "\n"
    if tomllib.loads(text) != data:
        raise HomeError("internal error: config.toml does not round-trip through tomllib")
    return text


def codex_mcp(servers: list[dict]) -> dict:
    out = {}
    for s in servers:
        entry: dict = {}
        if "url" in s:
            entry["url"] = s["url"]
        else:
            entry["command"] = s["command"]
            entry["args"] = list(s["args"])
            if s.get("env"):
                entry["env"] = dict(s["env"])
        entry["startup_timeout_sec"] = s["startupTimeoutSec"]
        entry["tool_timeout_sec"] = s["toolTimeoutSec"]
        out[s["id"]] = entry
    return out


def codex_config(manifest: dict, codex_home: str, existing_state: dict | None) -> dict:
    path_value = ":".join(list(manifest["shellPathPrefix"]) + list(manifest["shellPath"]))
    config = {
        "model": "gpt-6-astra",
        "model_provider": "ninerouter",
        "model_catalog_json": os.path.join(codex_home, "models.json"),
        "model_context_window": manifest["codexModels"]["contextWindow"],
        "model_auto_compact_token_limit": manifest["codexModels"]["autoCompactTokenLimit"],
        "model_auto_compact_token_limit_scope": "total",
        "approval_policy": "never",
        "sandbox_mode": "danger-full-access",
        "allow_login_shell": False,
        "check_for_update_on_startup": False,
        "web_search": "disabled",
        "mcp_oauth_credentials_store": "file",
        "project_doc_max_bytes": 65536,
        "notify": [],
        "model_providers": {
            "ninerouter": {
                "name": "9router",
                "base_url": "http://127.0.0.1:20128/v1",
                "env_key": "NINEROUTER_KEY",
                "wire_api": "responses",
                "requires_openai_auth": False,
                "supports_websockets": False,
                "stream_idle_timeout_ms": 900000,
                "http_headers": {"x-9router-token-saver": "off"},
            }
        },
        "skills": {"max_context_tokens": 10000},
        "features": {
            "memories": False,
            "chronicle": False,
            "shell_snapshot": False,
            "computer_use": False,
            "hooks": True,
            "subagent_default_context_limits": False,
        },
        "memories": {"generate_memories": False, "use_memories": False},
        "analytics": {"enabled": False},
        "feedback": {"enabled": False},
        "history": {"persistence": "none"},
        "otel": {
            "exporter": "none",
            "trace_exporter": "none",
            "metrics_exporter": "none",
            "log_user_prompt": False,
        },
        "agents": {"enabled": True, "max_depth": manifest["claude"]["subagentDepth"]},
        "shell_environment_policy": {"inherit": "all", "set": {"PATH": path_value}},
        "mcp_servers": codex_mcp(manifest["mcpServers"]),
    }
    if manifest["hooks"]:
        config["hooks"] = {"state": existing_state or {}}
    return config


def codex_hooks_json(hooks: list[dict]) -> dict:
    return {"hooks": claude_hooks(hooks)}


def models_json(vendor_path: Path, manifest: dict) -> bytes:
    data = json.loads(vendor_path.read_text(encoding="utf-8"))
    spec = manifest["codexModels"]
    extended = set(spec["extended"])
    found = set()
    for model in data["models"]:
        if model.get("slug") in extended:
            found.add(model["slug"])
            for key in CODEX_MODEL_KEYS:
                model[key] = spec["contextWindow"]
            model["auto_compact_token_limit"] = spec["autoCompactTokenLimit"]
    missing = extended - found
    if missing:
        raise HomeError(f"catalog is missing extended slugs: {sorted(missing)}")
    return json_bytes(data)


def validate_manifest(manifest: dict) -> None:
    ids = [s["id"] for s in manifest["mcpServers"]]
    if len(ids) != len(set(ids)):
        raise HomeError("duplicate mcpServers id in manifest")
    for s in manifest["mcpServers"]:
        if s["id"] in RESERVED_IDS:
            raise HomeError(f"{s['id']} must not be in the manifest; Robob injects it per thread")
        if ("url" in s) == ("command" in s):
            raise HomeError(f"mcpServers.{s['id']} needs exactly one of url or command")
    for h in manifest["hooks"]:
        if h["event"] not in HOOK_EVENTS:
            raise HomeError(f"unknown hook event {h['event']!r}")
        if not os.path.isabs(h["command"]):
            raise HomeError(f"hook command must be an absolute path: {h['command']}")


def build(manifest: dict, claude: str, codex: str, skills: list[tuple[str, str]]) -> dict:
    """Compute every generated file in memory. Reads only; writes nothing."""
    canonical_path = expand(manifest["instructions"]["canonical"])
    canonical = read_bytes(canonical_path)
    if canonical is None:
        raise HomeError(f"canonical AGENTS.md missing: {canonical_path}")
    overlay_claude = (PKG / manifest["instructions"]["overlays"]["claude"]).read_bytes()
    overlay_codex = (PKG / manifest["instructions"]["overlays"]["codex"]).read_bytes()

    settings_path = os.path.join(claude, "settings.json")
    settings = deep_merge(read_json_or_empty(settings_path), claude_settings_owned(manifest),
                          replace=frozenset({"hooks"}))

    claude_json_path = os.path.join(claude, ".claude.json")
    claude_json = read_json_or_empty(claude_json_path)
    claude_json["mcpServers"] = claude_mcp(manifest["mcpServers"])
    claude_json["hasCompletedOnboarding"] = True

    existing_state = None
    config_path = os.path.join(codex, "config.toml")
    if os.path.exists(config_path):
        try:
            prior = tomllib.loads(Path(config_path).read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as exc:
            raise HomeError(f"{config_path} is not valid TOML ({exc}); fix or remove it") from exc
        existing_state = (prior.get("hooks") or {}).get("state")

    files = {
        settings_path: json_bytes(settings),
        claude_json_path: json_bytes(claude_json),
        os.path.join(claude, "CLAUDE.md"): f"@{canonical_path}\n@{os.path.join(claude, 'overlay.md')}\n".encode(),
        os.path.join(claude, "overlay.md"): overlay_claude,
        config_path: toml_dump(codex_config(manifest, codex, existing_state)).encode("utf-8"),
        os.path.join(codex, "AGENTS.md"): canonical + b"\n\n" + overlay_codex,
        os.path.join(codex, "models.json"): models_json(PKG / manifest["codexModels"]["catalogSource"], manifest),
    }
    if manifest["hooks"]:
        files[os.path.join(codex, "hooks.json")] = json_bytes(codex_hooks_json(manifest["hooks"]))
    return files


def plan_all(home_root: str | None) -> tuple[dict, str, str, list[tuple[str, str]], dict]:
    manifest = load_manifest()
    validate_manifest(manifest)
    claude, codex = resolve_homes(manifest, home_root)
    skills = discover_skills([expand(r) for r in manifest["skillRoots"]])
    files = build(manifest, claude, codex, skills)
    for path, data in files.items():
        if SECRET_RE.search(data.decode("utf-8", errors="replace")):
            raise HomeError(f"refusing: secret-looking value in planned content for {path}; nothing written")
    return manifest, claude, codex, skills, files


# ---------- writing ----------

class Writer:
    def __init__(self, dry_run: bool):
        self.dry_run = dry_run

    def _say(self, verb: str, path: str) -> None:
        prefix = "would " if self.dry_run else ""
        print(f"{prefix}{verb} {path}")

    @staticmethod
    def ensure_dir(path: str, dry_run: bool) -> None:
        if dry_run:
            return
        os.makedirs(path, mode=0o700, exist_ok=True)
        os.chmod(path, 0o700)

    def file(self, path: str, data: bytes, mode: int = 0o644) -> None:
        if read_bytes(path) == data:
            return
        self._say("write", path)
        if self.dry_run:
            return
        parent = os.path.dirname(path)
        self.ensure_dir(parent, False)
        fd, tmp = tempfile.mkstemp(dir=parent, prefix=f".{os.path.basename(path)}.")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            if os.path.lexists(tmp):
                os.unlink(tmp)
            raise

    def link(self, link_path: str, target: str) -> None:
        self._say("link", link_path)
        if self.dry_run:
            return
        parent = os.path.dirname(link_path)
        self.ensure_dir(parent, False)
        tmp = os.path.join(parent, f".{os.path.basename(link_path)}.{os.getpid()}.tmp")
        if os.path.lexists(tmp):
            os.unlink(tmp)
        os.symlink(target, tmp)
        os.replace(tmp, link_path)

    def unlink(self, path: str) -> None:
        self._say("unlink", path)
        if not self.dry_run:
            os.unlink(path)


def generate(home_root: str | None, dry_run: bool) -> int:
    manifest, claude, codex, skills, files = plan_all(home_root)
    farms = [os.path.join(claude, "skills"), os.path.join(codex, "skills")]
    guard_outputs([claude, codex, *farms, *files])
    roots = [expand(r) for r in manifest["skillRoots"]]
    ops = skill_ops(farms[0], skills, roots)
    ops_codex = skill_ops(farms[1], skills, roots)
    guard_outputs([op[1] for op in ops + ops_codex])
    writer = Writer(dry_run)
    for home in (claude, codex):
        writer.ensure_dir(home, dry_run)
    for path, data in files.items():
        mode = 0o644
        writer.file(path, data, mode)
    for home, plan in ((claude, ops), (codex, ops_codex)):
        writer.ensure_dir(os.path.join(home, "skills"), dry_run)
        for op in plan:
            if op[0] == "unlink":
                writer.unlink(op[1])
            else:
                writer.link(op[1], op[2])
    return 0


# ---------- check ----------

def check(home_root: str | None) -> int:
    manifest = load_manifest()
    validate_manifest(manifest)
    claude, codex = resolve_homes(manifest, home_root)
    guard_outputs([claude, codex, os.path.join(claude, "skills"), os.path.join(codex, "skills")])
    failures: list[str] = []

    def fail(msg: str) -> None:
        failures.append(msg)

    want_ids = {s["id"] for s in manifest["mcpServers"]}
    canonical_path = expand(manifest["instructions"]["canonical"])

    # Claude
    settings = read_json_or_empty(os.path.join(claude, "settings.json"))
    if settings.get("autoMemoryEnabled") is not False:
        fail("claude settings.json: autoMemoryEnabled is not false")
    if settings.get("autoDreamEnabled") is not False:
        fail("claude settings.json: autoDreamEnabled is not false")
    env = settings.get("env", {})
    for key in ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_ORG_MEMORY"):
        if env.get(key) != "1":
            fail(f"claude settings.json: env.{key} is not \"1\"")
    claude_json = read_json_or_empty(os.path.join(claude, ".claude.json"))
    if set((claude_json.get("mcpServers") or {}).keys()) != want_ids:
        fail("claude .claude.json: mcpServers ids differ from manifest")
    claude_md = read_bytes(os.path.join(claude, "CLAUDE.md"))
    first = (claude_md or b"").decode("utf-8", errors="replace").splitlines()[:1]
    if first != [f"@{canonical_path}"]:
        fail("claude CLAUDE.md first line does not import the canonical AGENTS.md")
    if read_bytes(os.path.join(claude, "overlay.md")) != (PKG / manifest["instructions"]["overlays"]["claude"]).read_bytes():
        fail("claude overlay.md differs from the package overlay")

    # Codex
    try:
        config = tomllib.loads(Path(codex, "config.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        config = {}
        fail(f"codex config.toml unreadable: {exc}")
    feats = config.get("features", {})
    for key in ("memories", "chronicle"):
        if feats.get(key) is not False:
            fail(f"codex config.toml: features.{key} is not false")
    mem = config.get("memories", {})
    for key in ("generate_memories", "use_memories"):
        if mem.get(key) is not False:
            fail(f"codex config.toml: memories.{key} is not false")
    if config.get("approval_policy") != "never":
        fail("codex config.toml: approval_policy is not \"never\"")
    if config.get("sandbox_mode") != "danger-full-access":
        fail("codex config.toml: sandbox_mode is not \"danger-full-access\"")
    if set((config.get("mcp_servers") or {}).keys()) != want_ids:
        fail("codex config.toml: mcp_servers ids differ from manifest")
    agents_md = read_bytes(os.path.join(codex, "AGENTS.md"))
    canonical = read_bytes(canonical_path)
    if canonical is None:
        fail(f"canonical AGENTS.md missing: {canonical_path}")
    elif agents_md is None or not agents_md.startswith(canonical):
        fail("codex AGENTS.md does not start with the canonical AGENTS.md")
    try:
        models = json.loads(Path(codex, "models.json").read_text(encoding="utf-8"))
        by_slug = {m.get("slug"): m for m in models["models"]}
        for slug in manifest["codexModels"]["extended"]:
            model = by_slug.get(slug)
            if model is None:
                fail(f"codex models.json: missing {slug}")
                continue
            for key in CODEX_MODEL_KEYS:
                if model.get(key) != manifest["codexModels"]["contextWindow"]:
                    fail(f"codex models.json: {slug}.{key} is not the extended window")
            if model.get("auto_compact_token_limit") != manifest["codexModels"]["autoCompactTokenLimit"]:
                fail(f"codex models.json: {slug}.auto_compact_token_limit is wrong")
    except (OSError, ValueError, KeyError) as exc:
        fail(f"codex models.json unreadable: {exc}")
    if config.get("model_catalog_json") != os.path.join(codex, "models.json"):
        fail("codex config.toml: model_catalog_json does not point at the generated models.json")

    # Skills farms
    try:
        roots = [expand(r) for r in manifest["skillRoots"]]
        skills = discover_skills(roots)
    except HomeError as exc:
        skills = []
        fail(str(exc))
    desired = {name: path for name, path in skills}
    for home, label in ((claude, "claude"), (codex, "codex")):
        farm = os.path.join(home, "skills")
        links = [e for e in (os.listdir(farm) if os.path.isdir(farm) else []) if os.path.islink(os.path.join(farm, e))]
        if len(links) != len(desired):
            fail(f"{label} skills: {len(links)} symlinks, {len(desired)} discovered skills")
        for name, path in desired.items():
            link = os.path.join(farm, name)
            if not os.path.islink(link):
                fail(f"{label} skills: missing link {name}")
            elif not os.path.exists(link):
                fail(f"{label} skills: link {name} does not resolve")
            elif os.path.normpath(os.path.join(farm, os.readlink(link))) != path:
                fail(f"{label} skills: link {name} points at the wrong directory")

    # Secrets: nothing generated may hold a secret-looking value.
    scan = [
        os.path.join(claude, "settings.json"), os.path.join(claude, ".claude.json"),
        os.path.join(claude, "CLAUDE.md"), os.path.join(claude, "overlay.md"),
        os.path.join(codex, "config.toml"), os.path.join(codex, "AGENTS.md"),
        os.path.join(codex, "hooks.json"), os.path.join(codex, "models.json"),
        str(PKG / manifest["instructions"]["overlays"]["claude"]),
        str(PKG / manifest["instructions"]["overlays"]["codex"]),
    ]
    for path in scan:
        data = read_bytes(path)
        if data is not None and SECRET_RE.search(data.decode("utf-8", errors="replace")):
            fail(f"secret-looking value in {path}")

    for msg in failures:
        print(f"FAIL {msg}")
    if failures:
        return 1
    print("OK harness homes match the manifest")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    gen = sub.add_parser("generate", help="write both homes")
    gen.add_argument("--home-root", help="replaces ~/.robob/harness-homes (tests use this)")
    gen.add_argument("--dry-run", action="store_true", help="print what would change; write nothing")
    chk = sub.add_parser("check", help="verify both homes; exit 1 on failure")
    chk.add_argument("--home-root", help="replaces ~/.robob/harness-homes (tests use this)")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "generate":
            return generate(args.home_root, args.dry_run)
        return check(args.home_root)
    except HomeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
