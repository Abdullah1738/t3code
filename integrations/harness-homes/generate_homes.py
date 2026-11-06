#!/opt/homebrew/bin/python3
"""Generate Robob's Claude Code, Codex and Codex CU homes from one manifest.

generate  writes the homes; prints one line per file or link that changed.
check     verifies the homes against the manifest; exit 1 lists each failure.

Stdlib only. Never reads or writes the personal homes (~/.claude, ~/.codex,
/Volumes/ExternalSSD/codex). Auth lives in the instance environment, not here.
"""
from __future__ import annotations

import argparse
import hashlib
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
HOOK_EVENTS = ("PreToolUse", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStart",
               "SubagentStop", "Stop", "SessionStart", "SessionEnd")
CODEX_MODEL_KEYS = ("context_window", "max_context_window")
HARNESSES = ("claude", "codex", "codex-cu")
NODE_REPL = "node_repl"
PARITY_MANIFEST = "parity-manifest.json"


class HomeError(Exception):
    """A refusal or a bad input. Raised before any write happens."""


def expand(p: str) -> str:
    if p == "~" or p.startswith("~/"):
        return os.environ["HOME"] + p[1:]
    return p


def load_manifest() -> dict:
    return json.loads((PKG / "manifest.json").read_text(encoding="utf-8"))


def resolve_homes(manifest: dict, home_root: str | None) -> dict[str, str]:
    if home_root:
        root = expand(home_root)
        homes = {name: os.path.join(root, name) for name in HARNESSES}
    else:
        homes = {name: expand(manifest["homes"][name]) for name in HARNESSES}
    for home in homes.values():
        guard_home(home)
    resolved = {name: os.path.abspath(home) for name, home in homes.items()}
    real_homes = [os.path.realpath(home) for home in resolved.values()]
    for index, left in enumerate(real_homes):
        for right in real_homes[index + 1:]:
            if os.path.commonpath((left, right)) in (left, right):
                raise HomeError("harness homes must be distinct and non-overlapping")
    return resolved


def read_overlay(path: Path, *, require_content: bool = False) -> bytes:
    try:
        overlay = path.read_bytes()
    except OSError as exc:
        raise HomeError(f"required overlay missing or unreadable: {path} ({exc})") from exc
    if require_content and not re.sub(rb"<!--.*?-->", b"", overlay, flags=re.DOTALL).strip():
        raise HomeError(f"required overlay is empty: {path}")
    return overlay


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


def discover_skills(skill_roots: list[str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Return discovered skills and paths that could not be inspected."""
    found: list[tuple[str, str]] = []
    unreadable: list[str] = []

    def cannot_inspect(path: str, exc: OSError) -> None:
        unreadable.append(path)
        print(f"warning: cannot inspect skill path {path}: {exc}", file=sys.stderr)

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
            except FileNotFoundError:
                continue
            except OSError as exc:
                cannot_inspect(current, exc)
                continue
            is_skill = False
            subdirs = []
            for entry in entries:
                try:
                    if entry.name == "SKILL.md" and entry.is_file(follow_symlinks=True):
                        is_skill = True
                    elif entry.is_dir(follow_symlinks=True):
                        subdirs.append(entry.path)
                except FileNotFoundError:
                    continue
                except OSError as exc:
                    cannot_inspect(current if entry.name == "SKILL.md" else entry.path, exc)
            if is_skill and real not in seen_real:
                try:
                    name = skill_name(Path(current) / "SKILL.md")
                except FileNotFoundError:
                    name = None
                except OSError as exc:
                    cannot_inspect(current, exc)
                    name = None
                if name is not None:
                    seen_real.add(real)
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
    return sorted(found), unreadable


def skill_ops(skills_dir: str, skills: list[tuple[str, str]], roots: list[str],
              unreadable: list[str]) -> list[tuple]:
    """Plan the skills/ farm: ("unlink", path) or ("link", path, target). Writes nothing.

    Real directories and symlinks that point outside the skill roots are never touched.
    """
    desired = {name: path for name, path in skills}
    root_forms = {os.path.normpath(expand(r)) for r in roots} | {os.path.realpath(expand(r)) for r in roots}

    def into_root(target: str) -> bool:
        return any(target.startswith(r + os.sep) for r in root_forms)

    def cannot_inspect(target: str) -> bool:
        # Discovery follows symlinks once; a second root may alias an unreadable subtree.
        real_target = os.path.realpath(target)
        for path in unreadable:
            real_path = os.path.realpath(path)
            if (target == path or target.startswith(path + os.sep) or
                    real_target == real_path or real_target.startswith(real_path + os.sep)):
                return True
        return False

    if os.path.lexists(skills_dir) and not os.path.isdir(skills_dir):
        raise HomeError(f"{skills_dir} exists and is not a directory")
    ops: list[tuple] = []
    protected: set[str] = set()
    if os.path.isdir(skills_dir):
        for entry in sorted(os.listdir(skills_dir)):
            link = os.path.join(skills_dir, entry)
            if not os.path.islink(link):
                continue
            target = os.path.normpath(os.path.join(skills_dir, os.readlink(link)))
            if not into_root(target):
                continue
            if cannot_inspect(target):
                protected.add(link)
                continue
            if desired.get(entry) == target:
                continue
            ops.append(("unlink", link))  # gone or no longer discovered
    for name in sorted(desired):
        link = os.path.join(skills_dir, name)
        if link in protected:
            continue
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

def hooks_for_harness(hooks: list[dict], harness: str) -> list[dict]:
    # codex-cu is a Codex harness, so Codex-scoped hooks follow it as well.
    selector = "codex" if harness == "codex-cu" else harness
    return [hook for hook in hooks if hook.get("harness", selector) == selector]


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


def claude_settings_owned(manifest: dict, existing: dict | None = None) -> dict:
    c = manifest["claude"]
    permissions = (existing or {}).get("permissions", {})
    deny = permissions.get("deny", []) if isinstance(permissions, dict) else []
    if not isinstance(deny, list):
        raise HomeError("claude permissions.deny must be a list")
    # Keep user-supplied deny rules while explicitly disabling the CU tool names.
    deny = list(dict.fromkeys([*deny, "Computer", "mcp__node_repl"]))
    return {
        "autoMemoryEnabled": False,
        "autoDreamEnabled": False,
        "cleanupPeriodDays": c["cleanupPeriodDays"],
        "skipWebFetchPreflight": True,
        "skipDangerousModePermissionPrompt": True,
        "includeCoAuthoredBy": False,
        "permissions": {"deny": deny},
        "pluginConfigs": {CLAUDE_PLUGIN_KEY: {"options": {"instructionFiles": "claude-md-and-agents-md"}}},
        "env": {
            "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_ORG_MEMORY": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "BUN_INSPECT": "",
            "ANTHROPIC_BASE_URL": "http://127.0.0.1:20128",
            "ANTHROPIC_CUSTOM_HEADERS": "x-9router-token-saver: off",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW": c["autoCompactWindow"],
            "ENABLE_PROMPT_CACHING_1H": "1",
            "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS": "450000",
            "API_TIMEOUT_MS": "1800000",
            "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "900000",
            "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS": "900000",
            "CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS": "900000",
            "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": str(c["subagentDepth"]),
        },
        "hooks": claude_hooks(hooks_for_harness(manifest["hooks"], "claude")),
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


def codex_config(manifest: dict, codex_home: str, existing_state: dict | None,
                 harness: str = "codex") -> dict:
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
        # Async compaction stays off; 9router must support the OpenAI wire fields first.
        "model_providers": {
            "ninerouter": {
                "name": "OpenAI",
                "base_url": "http://127.0.0.1:20128/v1",
                "env_key": "NINEROUTER_KEY",
                "wire_api": "responses",
                "requires_openai_auth": False,
                "supports_websockets": False,
                "stream_idle_timeout_ms": 900000,
                # For this provider, Codex 0.166 needs a non-empty actor header for image_gen; the fixed placeholder is not a credential and 9router never forwards it upstream.
                "http_headers": {"x-9router-token-saver": "off",
                                 "x-openai-actor-authorization": "robob-9router-local"},
            }
        },
        "skills": {"max_context_tokens": 10000},
        "features": {
            "memories": False,
            "chronicle": False,
            "shell_snapshot": False,
            "computer_use": False,
            "goals": False,
            "hooks": True,
            "image_generation": True,
            "output_token_replay": True,
            "concurrent_reasoning_summaries": True,
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
        # No `enabled` key: Codex 0.166 has none, and the Computer Use service reads any other [agents]
        # key as a named role (AgentRoleToml), so `enabled = true` broke every native CU call.
        "agents": {"max_depth": manifest["claude"]["subagentDepth"]},
        "shell_environment_policy": {"inherit": "all", "set": {"PATH": path_value, "BUN_INSPECT": "", "OFFBOX_GATE": "1", "ROBOB_HARNESS": "codex"}},
        "mcp_servers": codex_mcp(manifest["mcpServers"]),
    }
    if harness == "codex-cu":
        spec = manifest["codexCu"]
        config["model"] = spec["model"]
        config["model_context_window"] = spec["contextWindow"]
        config["model_auto_compact_token_limit"] = spec["autoCompactTokenLimit"]
        config["model_reasoning_effort"] = "low"
        config["features"]["computer_use"] = True
        config["mcp_servers"][NODE_REPL] = {
            "command": "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
            "startup_timeout_sec": 30,
            "tool_timeout_sec": 120,
            "env": {
                "CODEX_HOME": codex_home,
                "NODE_REPL_NODE_PATH": "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
                "NODE_REPL_NODE_MODULE_DIRS": "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
                "NODE_REPL_TRUSTED_CODE_PATHS": "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
                "SKY_CUA_SERVICE_PATH": "/Volumes/ExternalSSD/codex/computer-use/Codex Computer Use.app",
                "NODE_REPL_DISABLE_ANALYTICS": "1",
                "BROWSER_USE_DISABLE_AMBIENT_NETWORK": "1",
            },
        }
    if hooks_for_harness(manifest["hooks"], harness):
        config["hooks"] = {"state": existing_state or {}}
    return config


def codex_hooks_json(hooks: list[dict]) -> dict:
    return {"hooks": claude_hooks(hooks)}


def models_json(vendor_path: Path, manifest: dict, *, cu: bool = False) -> bytes:
    data = json.loads(vendor_path.read_text(encoding="utf-8"))
    spec = manifest["codexModels"]
    extended = set(spec["extended"])
    found = set()
    cu_spec = manifest["codexCu"]
    upstream_terra = None
    for model in data["models"]:
        if model.get("slug") == cu_spec["model"]:
            upstream_terra = dict(model)
        if model.get("slug") in extended:
            found.add(model["slug"])
            for key in CODEX_MODEL_KEYS:
                model[key] = spec["contextWindow"]
            model["auto_compact_token_limit"] = spec["autoCompactTokenLimit"]
    missing = extended - found
    if missing:
        raise HomeError(f"catalog is missing extended slugs: {sorted(missing)}")
    if cu:
        if upstream_terra is None:
            raise HomeError(f"catalog is missing CU upstream slug: {cu_spec['model']}")
        if any(model.get("slug") == cu_spec["prefixedModel"] for model in data["models"]):
            raise HomeError(f"catalog already has CU prefixed slug: {cu_spec['prefixedModel']}")
        upstream_terra["slug"] = cu_spec["prefixedModel"]
        for key in CODEX_MODEL_KEYS:
            upstream_terra[key] = cu_spec["contextWindow"]
        upstream_terra["auto_compact_token_limit"] = cu_spec["autoCompactTokenLimit"]
        for model in data["models"]:
            if model.get("slug") == cu_spec["model"]:
                for key in CODEX_MODEL_KEYS:
                    model[key] = cu_spec["contextWindow"]
                model["auto_compact_token_limit"] = cu_spec["autoCompactTokenLimit"]
        data["models"].append(upstream_terra)
        # The Computer Use service bundles an older Codex config parser that requires base_instructions on
        # every catalog model (0.166 also accepts model_messages.instructions_template). Mirror the template
        # so native CU starts; Codex 0.166 still prefers the model_messages template when both are present.
        for model in data["models"]:
            template = (model.get("model_messages") or {}).get("instructions_template")
            if "base_instructions" not in model and isinstance(template, str) and template:
                model["base_instructions"] = template
    return json_bytes(data)


def validate_manifest(manifest: dict) -> None:
    ids = [s["id"] for s in manifest["mcpServers"]]
    if len(ids) != len(set(ids)):
        raise HomeError("duplicate mcpServers id in manifest")
    for s in manifest["mcpServers"]:
        if s["id"] == NODE_REPL:
            raise HomeError("node_repl is reserved for the codex-cu home")
        if s["id"] in RESERVED_IDS:
            raise HomeError(f"{s['id']} must not be in the manifest; Robob injects it per thread")
        if ("url" in s) == ("command" in s):
            raise HomeError(f"mcpServers.{s['id']} needs exactly one of url or command")
    for h in manifest["hooks"]:
        if "harnesses" in h:
            raise HomeError("hook harnesses is no longer supported; use harness")
        if "harness" in h and h["harness"] not in ("claude", "codex"):
            raise HomeError("hook harness must be claude or codex")
        if h["event"] not in HOOK_EVENTS:
            raise HomeError(f"unknown hook event {h['event']!r}")
        if h["event"] == "PostToolUseFailure" and h.get("harness") != "claude":
            raise HomeError("PostToolUseFailure is only supported by Claude")
        if not os.path.isabs(h["command"]):
            raise HomeError(f"hook command must be an absolute path: {h['command']}")


def build(manifest: dict, homes: dict[str, str]) -> dict:
    """Compute every generated file in memory. Reads only; writes nothing."""
    canonical_path = expand(manifest["instructions"]["canonical"])
    canonical = read_bytes(canonical_path)
    if canonical is None:
        raise HomeError(f"canonical AGENTS.md missing: {canonical_path}")
    overlays = {
        name: read_overlay(PKG / manifest["instructions"]["overlays"][name],
                           require_content=name == "codex-cu")
        for name in HARNESSES
    }

    claude = homes["claude"]
    settings_path = os.path.join(claude, "settings.json")
    old_settings = read_json_or_empty(settings_path)
    settings = deep_merge(old_settings, claude_settings_owned(manifest, old_settings),
                          replace=frozenset({"hooks"}))
    # Idle compaction uses the CLI default; an old override must not disable it.
    settings.pop("idleCompaction", None)

    claude_json_path = os.path.join(claude, ".claude.json")
    claude_json = read_json_or_empty(claude_json_path)
    claude_json["mcpServers"] = claude_mcp(manifest["mcpServers"])
    claude_json["hasCompletedOnboarding"] = True

    files = {
        settings_path: json_bytes(settings),
        claude_json_path: json_bytes(claude_json),
        os.path.join(claude, "CLAUDE.md"): f"@{canonical_path}\n@{os.path.join(claude, 'overlay.md')}\n".encode(),
        os.path.join(claude, "overlay.md"): overlays["claude"],
    }
    for name in ("codex", "codex-cu"):
        home = homes[name]
        existing_state = None
        config_path = os.path.join(home, "config.toml")
        if os.path.exists(config_path):
            try:
                prior = tomllib.loads(Path(config_path).read_text(encoding="utf-8"))
            except tomllib.TOMLDecodeError as exc:
                raise HomeError(f"{config_path} is not valid TOML ({exc}); fix or remove it") from exc
            existing_state = (prior.get("hooks") or {}).get("state")
        files[config_path] = toml_dump(codex_config(manifest, home, existing_state, name)).encode("utf-8")
        instructions = canonical + b"\n\n" + overlays["codex"]
        if name == "codex-cu":
            instructions += b"\n\n" + overlays["codex-cu"]
        files[os.path.join(home, "AGENTS.md")] = instructions
        files[os.path.join(home, "models.json")] = models_json(
            PKG / manifest["codexModels"]["catalogSource"], manifest, cu=name == "codex-cu")
        hooks = hooks_for_harness(manifest["hooks"], name)
        files[os.path.join(home, "hooks.json")] = json_bytes(codex_hooks_json(hooks))
    return files


def source_digest(path: str) -> dict:
    source = Path(path)
    try:
        return {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    except OSError as exc:
        raise HomeError(f"parity source missing or unreadable: {source} ({exc})") from exc


def parity_source(spec: str | dict) -> dict:
    if isinstance(spec, str):
        return source_digest(str((PKG / spec).resolve()))
    source = (PKG / spec["source"]).resolve()
    # The installed offbox skill is deployed to the shared skill root, unlike
    # harness-hooks and memory-system, which are siblings of harness-homes.
    return source_digest(str(source) if source.is_file() else expand(spec["installed"]))


def claude_owned_json(content: bytes) -> bytes:
    value = json.loads(content)
    owned = {key: value[key] for key in ("mcpServers", "hasCompletedOnboarding")}
    return json.dumps(owned, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def artifact_digest(path: str, content: bytes) -> dict:
    artifact = {"path": os.path.abspath(path)}
    if os.path.basename(path) == ".claude.json":
        content = claude_owned_json(content)
        artifact["format"] = "claude-owned-json"
    artifact["sha256"] = hashlib.sha256(content).hexdigest()
    return artifact


def parity_files(manifest: dict, homes: dict[str, str], skills: list[tuple[str, str]], expected_files: dict[str, bytes]) -> dict:
    """Metadata only; executable guards and skills stay at their shared sources."""
    canonical = source_digest(expand(manifest["instructions"]["canonical"]))
    catalog = [{"name": name, "source": path,
                "sha256": source_digest(str(Path(path) / "SKILL.md"))["sha256"]}
               for name, path in skills]
    guards = [{"id": name, "sources": [parity_source(path) for path in paths]}
              for name, paths in sorted(manifest.get("paritySources", {}).items())]
    files = {}
    for harness, home in homes.items():
        overlay_names = ["codex", "codex-cu"] if harness == "codex-cu" else [harness]
        value = {
            "schemaVersion": 1,
            "harness": harness,
            "generator": source_digest(str(PKG / "generate_homes.py")),
            "manifestSha256": hashlib.sha256(json_bytes(manifest)).hexdigest(),
            "artifacts": [artifact_digest(path, content)
                          for path, content in sorted(expected_files.items())
                          if os.path.dirname(path) == home],
            "skills": catalog,
            "mcpServers": manifest["mcpServers"],
            "runtimeMcpServers": ["t3-code"],
            "guards": guards,
            "hooks": hooks_for_harness(manifest["hooks"], harness),
            "instructions": {"canonical": canonical, "overlays": [
                source_digest(str(PKG / manifest["instructions"]["overlays"][name])) for name in overlay_names]},
            "compactSkillCatalog": {"required": False, "reason": "Native harnesses discover SKILL.md metadata from the shared skills symlink farm."},
        }
        files[os.path.join(home, PARITY_MANIFEST)] = json_bytes(value)
    return files


def plan_all(home_root: str | None) -> tuple[dict, dict, list, list, dict]:
    manifest = load_manifest()
    validate_manifest(manifest)
    homes = resolve_homes(manifest, home_root)
    skills, unreadable = discover_skills([expand(r) for r in manifest["skillRoots"]])
    files = build(manifest, homes)
    files.update(parity_files(manifest, homes, skills, files))
    for path, data in files.items():
        if SECRET_RE.search(data.decode("utf-8", errors="replace")):
            raise HomeError(f"refusing: secret-looking value in planned content for {path}; nothing written")
    return manifest, homes, skills, unreadable, files


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
    manifest, homes, skills, unreadable, files = plan_all(home_root)
    farms = [os.path.join(home, "skills") for home in homes.values()]
    guard_outputs([*homes.values(), *farms, *files])
    roots = [expand(r) for r in manifest["skillRoots"]]
    plans = {home: skill_ops(os.path.join(home, "skills"), skills, roots, unreadable) for home in homes.values()}
    guard_outputs([op[1] for plan in plans.values() for op in plan])
    writer = Writer(dry_run)
    for home in homes.values():
        writer.ensure_dir(home, dry_run)
    for path, data in files.items():
        mode = 0o644
        writer.file(path, data, mode)
    for home, plan in plans.items():
        writer.ensure_dir(os.path.join(home, "skills"), dry_run)
        for op in plan:
            if op[0] == "unlink":
                writer.unlink(op[1])
            else:
                writer.link(op[1], op[2])
    return 0


# ---------- check ----------

def check(home_root: str | None, *, json_output: bool = False) -> int:
    manifest, homes, skills, unreadable, files = plan_all(home_root)
    guard_outputs([*homes.values(), *(os.path.join(home, "skills") for home in homes.values()), *files])
    failures: list[str] = []
    if unreadable:
        failures.append("skills: could not inspect " + ", ".join(unreadable))

    # Compare complete owned structures, not just MCP IDs or the extended slugs.
    # build() incorporates the Claude foreign keys and each Codex trust state.
    claude_settings_path = os.path.join(homes["claude"], "settings.json")
    for path, expected in files.items():
        actual = read_bytes(path)
        if actual is None:
            failures.append(f"{path}: missing")
            continue
        try:
            if path.endswith(".json"):
                actual_value, expected_value = json.loads(actual), json.loads(expected)
            elif path.endswith(".toml"):
                actual_value = tomllib.loads(actual.decode("utf-8"))
                expected_value = tomllib.loads(expected.decode("utf-8"))
            else:
                actual_value, expected_value = actual, expected
            if actual_value != expected_value:
                if isinstance(actual_value, dict) and isinstance(expected_value, dict):
                    keys = sorted(key for key in actual_value.keys() | expected_value.keys()
                                  if actual_value.get(key) != expected_value.get(key))
                    failures.append(f"{path}: differs in {', '.join(keys)}")
                else:
                    failures.append(f"{path}: differs from expected content")
            if path == claude_settings_path:
                deny = actual_value.get("permissions", {}).get("deny", [])
                if not isinstance(deny, list) or any(rule not in deny for rule in ("Computer", "mcp__node_repl")):
                    failures.append(f"{path}: CU deny rules missing")
        except (ValueError, UnicodeDecodeError) as exc:
            failures.append(f"{path}: unreadable: {exc}")
        if SECRET_RE.search(actual.decode("utf-8", errors="replace")):
            failures.append(f"secret-looking value in {path}")

    desired = {name: path for name, path in skills}
    for label, home in homes.items():
        farm = os.path.join(home, "skills")
        links = [e for e in (os.listdir(farm) if os.path.isdir(farm) else []) if os.path.islink(os.path.join(farm, e))]
        if len(links) != len(desired):
            failures.append(f"{label} skills: {len(links)} symlinks, {len(desired)} discovered skills")
        for name, path in desired.items():
            link = os.path.join(farm, name)
            if not os.path.islink(link):
                failures.append(f"{label} skills: missing link {name}")
            elif not os.path.exists(link):
                failures.append(f"{label} skills: link {name} does not resolve")
            elif os.path.normpath(os.path.join(farm, os.readlink(link))) != path:
                failures.append(f"{label} skills: link {name} points at the wrong directory")

    if json_output:
        print(json.dumps({"schemaVersion": 1, "ok": not failures, "failures": failures,
                          "homes": [{"harness": name, "home": home,
                                     "parityManifestPath": os.path.join(home, PARITY_MANIFEST)}
                                    for name, home in homes.items()]}))
    else:
        for msg in failures:
            print(f"FAIL {msg}")
    if failures:
        return 1
    if not json_output:
        print("OK harness homes match the manifest")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    gen = sub.add_parser("generate", help="write the homes")
    gen.add_argument("--home-root", help="replaces ~/.robob/harness-homes (tests use this)")
    gen.add_argument("--dry-run", action="store_true", help="print what would change; write nothing")
    chk = sub.add_parser("check", help="verify the homes; exit 1 on failure")
    chk.add_argument("--home-root", help="replaces ~/.robob/harness-homes (tests use this)")
    chk.add_argument("--json", action="store_true", help="emit the existing check result as JSON")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "generate":
            return generate(args.home_root, args.dry_run)
        return check(args.home_root, json_output=args.json)
    except HomeError as exc:
        if args.cmd == "check" and args.json:
            print(json.dumps({"schemaVersion": 1, "ok": False, "failures": [str(exc)], "homes": []}))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
