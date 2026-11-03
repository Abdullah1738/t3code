#!/opt/homebrew/bin/python3
"""Pinned, verified Claude Code and Codex CLIs for Robob.

Each tool lives under ~/.robob/harness-cli/<tool>/<version>/ (read-only, never
overwritten) and a `current` symlink per tool points at the version Robob's
claudeAgent / codex / codex-cu instances run as binaryPath. Promotion swaps that
symlink atomically; rollback points it back at lastKnownGood.

Commands:
  discover                  read-only `npm view` for both packages; record candidates
  stage <tool> <version>    npm pack (exempt, --min-release-age=0), sha512 check, extract read-only
  canary <tool> <version>   throwaway HOME + homes + 9router prompts + memory-off canary
  promote <tool> <version>  canary-gated atomic switch (Codex leaves rotation pending)
  rollback <tool>           current -> lastKnownGood
  rotate-codex [--when-idle]  report unsupported; keep the shared Codex runtimes pending
  status                    pins, rotation state, last records
  auto                      daily job: discover, stage, canary, promote Claude; Codex pending
  --before-release          discover + stage + canary both, print the pinned versions

Stdlib only. Never prints secrets: 9router's key is read from NINEROUTER_KEY and
only ever sent as a header to 127.0.0.1. Never edits ~/.npmrc, never touches the
personal homes (~/.claude, ~/.codex, /Volumes/ExternalSSD/codex).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from typing import Callable

# Every location is read at call time, never at import: tests and throwaway runs
# point these at temp dirs, and the live state stays untouched unless the
# environment says otherwise.
def root() -> Path:
    return Path(os.environ.get("HARNESS_CLI_HOME", Path.home() / ".robob" / "harness-cli"))


def harness_homes_pkg() -> Path:
    return Path(os.environ.get("HARNESS_HOMES_PKG", Path.home() / ".local" / "share" / "harness-homes"))


def npm_bin() -> str:
    return os.environ.get("HARNESS_CLI_NPM", "npm")


def python_bin() -> str:
    return os.environ.get("HARNESS_CLI_PYTHON", "/opt/homebrew/bin/python3")


def notify_cmd() -> str:
    return os.environ.get(
        "HARNESS_CLI_NOTIFY",
        "/Users/ardud/.bun/bin/bun /Users/ardud/.local/share/telegram-bridge/src/cli.ts notify")


def nine_router_url() -> str:
    return os.environ.get("HARNESS_CLI_9ROUTER", "http://127.0.0.1:20128")


def robob_plist() -> Path:
    return Path(os.environ.get(
        "HARNESS_CLI_ROBOB_PLIST", "/Applications/Robob.app/Contents/Info.plist"))


CONTROL_RECOVERY = "/api/ardud/control/recovery/snapshot"

TOOLS = {
    "claude": {
        "package": "@anthropic-ai/claude-code",
        "native": "@anthropic-ai/claude-code-darwin-arm64",
        "binary_in_native": "package/claude",
        "version_flag": ["--version"],
        "version_regex": r"^(\d+\.\d+\.\d+)",
        "minimum_model_key": "claudeAgent",
    },
    "codex": {
        "package": "@openai/codex",
        "native": "@openai/codex",  # darwin build is published as <v>-darwin-arm64
        "native_suffix": "-darwin-arm64",
        "binary_in_native": "package/vendor/aarch64-apple-darwin/bin/codex",
        "version_flag": ["--version"],
        "version_regex": r"codex-cli\s+(\d+\.\d+\.\d+)",
        "minimum_model_key": "codex",
    },
}

# DECISIONS 15: built-in memory must stay off in every Robob home.
CLAUDE_MEMORY_CANARY = "ROBOB-MEMCANARY-7f3a91"
CODEX_MEMORY_DIRS = ("memories", "memories_extensions", "memories_1.sqlite")
MODEL_CANARIES = {
    "claude": ["claude-opus-5-5", "claude-haiku-5-5"],
    "codex": ["gpt-6-astra", "gpt-6.1-sol"],
}
# Terra runs on its own home: Robob's codex-cu instance is the one that uses it, so its
# memory-off result has to be proven separately (card F1 routes Terra through codex-cu).
CODEX_CU_MODELS = ["gpt-6.1-terra"]
CLAUDE_MODEL_IDS = {
    "claude-opus-5-5": "cc/claude-opus-5-5",
    "claude-haiku-5-5": "cc/claude-haiku-5-5",
}
DEFAULT_TIMEOUT = 600


class HarnessError(Exception):
    """A refusal. Raised before the step mutates anything it can't undo."""


# ---------- paths, json, locking ----------

def tool_dir(tool: str) -> Path:
    return root() / tool


def version_dir(tool: str, version: str) -> Path:
    return tool_dir(tool) / version


def current_link(tool: str) -> Path:
    return tool_dir(tool) / "current"


def state_path() -> Path:
    return root() / "state.json"


def records_path() -> Path:
    return root() / "records.jsonl"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as exc:
        raise HarnessError(f"{path} is not valid JSON ({exc}); fix or move it aside") from exc


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def load_state() -> dict:
    state = read_json(state_path(), {})
    state.setdefault("autoRotateCodex", False)
    for tool in TOOLS:
        state.setdefault(tool, {"current": None, "candidate": None, "lastKnownGood": None,
                                "checkedAt": None, "rotationPending": False})
    return state


def save_state(state: dict) -> None:
    write_json_atomic(state_path(), state)


def append_record(record: dict) -> None:
    records_path().parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, sort_keys=True) + "\n"
    with open(records_path(), "a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_sri(path: Path) -> str:
    digest = hashlib.sha512()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return "sha512-" + base64.b64encode(digest.digest()).decode("ascii")


# ---------- version rules ----------

def parse_version(text: str) -> tuple[int, ...]:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", text.strip())
    if not m:
        raise HarnessError(f"not a plain semver: {text!r}")
    return tuple(int(x) for x in m.groups())


def model_manifest_path() -> Path:
    """Where the minimums come from. The installed job reads the copy install.zsh bundles next to
    this script, so it never depends on the fork tree. HARNESS_CLI_MODEL_MANIFEST overrides it."""
    override = os.environ.get("HARNESS_CLI_MODEL_MANIFEST")
    if override:
        return Path(override)
    bundled = Path(__file__).resolve().parent / "model-manifest.json"
    if bundled.is_file():
        return bundled
    return Path(__file__).resolve().parents[2] / "apps" / "server" / "src" / "provider" / "model-manifest.json"


def load_manifest_minimums() -> dict:
    """Minimum CLI versions from the model manifest (driver + per-model)."""
    manifest_path = model_manifest_path()
    if not manifest_path.is_file():
        raise HarnessError(f"model manifest not found at {manifest_path}; cannot check minimums")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    minimums = {"claude": None, "codex": None}
    for entry in data["compatibility"]:
        if entry["driver"] == "claudeAgent" and minimums["claude"] is None:
            minimums["claude"] = entry["recommendedRange"].lstrip(">=").strip()
        if entry["driver"] == "codex" and minimums["codex"] is None:
            minimums["codex"] = entry["recommendedRange"].lstrip(">=").strip()
    model_mins = {"claude": {}, "codex": {}}
    for provider, key in (("claudeAgent", "claude"), ("codex", "codex")):
        for model in data["providers"][provider]["models"]:
            adapter = model.get("adapter", {})
            for driver_key in ("claudeCode", "codex"):
                if driver_key in adapter and "minVersion" in adapter[driver_key]:
                    model_mins[key][model["slug"]] = adapter[driver_key]["minVersion"]
    return {"driver": minimums, "models": model_mins}


def check_minimums(tool: str, version: str, manifest: dict | None = None) -> None:
    manifest = manifest or load_manifest_minimums()
    got = parse_version(version)
    driver_min = manifest["driver"][tool] or "0.0.0"
    if got < parse_version(driver_min):
        raise HarnessError(f"{tool} {version} is below the driver minimum {driver_min}")
    for slug in MODEL_CANARIES[tool]:
        needed = manifest["models"][tool].get(slug)
        if needed and got < parse_version(needed):
            raise HarnessError(f"{tool} {version} is below {slug}'s minimum {needed}")


# ---------- npm ----------

def npm_env(cache: Path | None = None) -> dict:
    env = dict(os.environ)
    env["NPM_CONFIG_MIN_RELEASE_AGE"] = "0"  # exemption for these packages only; ~/.npmrc untouched
    if cache is not None:
        env["NPM_CONFIG_CACHE"] = str(cache)
    return env


def run(cmd: list[str], *, env: dict | None = None, cwd: Path | None = None,
        timeout: int = DEFAULT_TIMEOUT) -> str:
    proc = subprocess.run(cmd, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        raise HarnessError(f"{' '.join(cmd[:2])} failed ({proc.returncode}): {' | '.join(tail)}")
    return proc.stdout


def npm_view(spec: str, field: str | None = None) -> str:
    cmd = [npm_bin(), "view", spec] + ([field] if field else []) + ["--min-release-age=0"]
    return run(cmd, env=npm_env()).strip().strip("'\"")


def latest_version(tool: str) -> str:
    return npm_view(TOOLS[tool]["package"], "version")


def pack_spec(tool: str, version: str) -> str:
    """The npm spec of the native darwin arm64 package that holds the executable."""
    if tool == "codex":
        return f"@openai/codex@{version}-darwin-arm64"
    return f"{TOOLS['claude']['native']}@{version}"


def integrity_of(tool: str, version: str) -> str:
    return npm_view(pack_spec(tool, version), "dist.integrity")


# ---------- records ----------

def robob_build() -> str:
    try:
        import plistlib
        with open(robob_plist(), "rb") as handle:
            return str(plistlib.load(handle).get("CFBundleShortVersionString", "unknown"))
    except (OSError, ValueError):
        return "unknown"


def harness_home_hashes() -> dict:
    """Hashes of the generated config files. Only reads; missing files are reported as null."""
    homes = Path(os.environ.get("HARNESS_CLI_HOMES", Path.home() / ".robob" / "harness-homes"))
    names = {"claude": ["settings.json", ".claude.json", "CLAUDE.md"],
             "codex": ["config.toml", "AGENTS.md", "models.json"]}
    out = {}
    for home, files in names.items():
        for name in files:
            path = homes / home / name
            out[f"{home}/{name}"] = sha256_file(path) if path.is_file() else None
    return out


def write_record(action: str, tool: str, version: str, result: str, **extra) -> dict:
    record = {
        "at": now_iso(),
        "action": action,
        "tool": tool,
        "version": version,
        "binarySha256": extra.pop("binarySha256", None),
        "robobBuild": robob_build(),
        "harnessHomes": extra.pop("harnessHomes", None),
        "result": result,
    }
    record.update(extra)
    append_record(record)
    return record


# ---------- discover ----------

def discover(state: dict | None = None) -> dict:
    state = state or load_state()
    checked = now_iso()
    report = {}
    for tool in TOOLS:
        latest = latest_version(tool)
        slot = state[tool]
        slot["candidate"] = latest if latest != slot.get("current") else None
        slot["checkedAt"] = checked
        report[tool] = {"latest": latest, "current": slot.get("current"),
                        "lastKnownGood": slot.get("lastKnownGood")}
    save_state(state)
    return report


# ---------- stage ----------

def find_native_binary(extract_root: Path, tool: str) -> Path:
    rel = TOOLS[tool]["binary_in_native"]
    path = extract_root / rel
    if not path.is_file():
        raise HarnessError(f"{tool}: {rel} not in the package")
    return path


def safe_extract(tgz: Path, dest: Path) -> None:
    """Extract regular files only, under `package/`; refuse links, devices and traversal."""
    with tarfile.open(tgz, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            name = member.name
            if name.startswith("/") or ".." in Path(name).parts:
                raise HarnessError(f"unsafe path in tarball: {name}")
            if not (member.isreg() or member.isdir()):
                raise HarnessError(f"unexpected tar member type: {name}")
        archive.extractall(dest, members=members, filter="data")


def stage(tool: str, version: str, *, work_root: Path | None = None) -> dict:
    if tool not in TOOLS:
        raise HarnessError(f"unknown tool {tool}")
    check_minimums(tool, version)
    target = version_dir(tool, version)
    if target.exists():
        raise HarnessError(f"{target} already exists; a version dir is never overwritten")
    spec = pack_spec(tool, version)
    expected = integrity_of(tool, version)
    temp_root = Path(tempfile.mkdtemp(prefix=f"harness-cli-{tool}-{version}-", dir=work_root))
    try:
        cache = temp_root / "npm-cache"
        cache.mkdir()
        run([npm_bin(), "pack", spec, "--pack-destination", str(temp_root), "--cache", str(cache),
             "--min-release-age=0", "--silent"], env=npm_env(cache))
        tgzs = sorted(temp_root.glob("*.tgz"))
        if len(tgzs) != 1:
            raise HarnessError(f"npm pack produced {len(tgzs)} tarballs, expected 1")
        tgz = tgzs[0]
        actual = sha512_sri(tgz)
        if actual != expected:
            raise HarnessError(f"integrity mismatch for {spec}: npm says {expected}, tarball is {actual}")
        extract = temp_root / "x"
        extract.mkdir()
        safe_extract(tgz, extract)
        binary = find_native_binary(extract, tool)
        reported = binary_version(binary, tool)
        if reported != version:
            raise HarnessError(f"{tool} binary reports {reported}, expected {version}")
        # Build the final tree under temp_root, then rename it into place in one step, so a
        # version dir never appears half-written. The tree is read-only before the rename.
        final = temp_root / "final"
        bin_dir = final / "bin"
        bin_dir.mkdir(parents=True)
        final_bin = bin_dir / ("claude" if tool == "claude" else "codex")
        shutil.copy2(binary, final_bin)
        digest = sha256_file(final_bin)
        tool_dir(tool).mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise HarnessError(f"{target} appeared during staging; refusing to overwrite")
        # Rename while still writable (macOS needs write on the directory being moved), then lock
        # the tree read-only at its final place. The version dir never appears half-written.
        os.rename(final, target)
        for dirpath, dirs, files in os.walk(target, topdown=False):
            for name in files:
                full = Path(dirpath) / name
                os.chmod(full, 0o555 if full == target / "bin" / final_bin.name else 0o444)
            for name in dirs:
                os.chmod(Path(dirpath) / name, 0o555)
        os.chmod(target, 0o555)
        state = load_state()
        state[tool]["candidate"] = version
        save_state(state)
        result = {"tool": tool, "version": version, "dir": str(target),
                  "binary": str(target / "bin" / final_bin.name), "sha512": actual, "binarySha256": digest}
        write_record("stage", tool, version, "staged", binarySha256=digest, integrity=actual,
                     harnessHomes=harness_home_hashes())
        return result
    finally:
        remove_tree(temp_root)


def remove_tree(path: Path) -> None:
    """rmtree that first restores write bits, since staged trees are read-only."""
    if not path.exists():
        return
    for dirpath, dirs, files in os.walk(path):
        for name in dirs + files:
            full = os.path.join(dirpath, name)
            if not os.path.islink(full):
                os.chmod(full, stat.S_IRWXU)
        os.chmod(dirpath, stat.S_IRWXU)
    shutil.rmtree(path, ignore_errors=True)


def prepare_isolated_home(home: Path) -> None:
    """Create the disposable login keychain before a CLI can use a temporary HOME on macOS."""
    home.mkdir(parents=True, exist_ok=True)
    if sys.platform != "darwin":
        return
    keychain = home / "Library" / "Keychains" / "login.keychain-db"
    if keychain.is_file():
        return
    keychain.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(["/usr/bin/security", "create-keychain", "-p", "", str(keychain)],
                              env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
                              capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise HarnessError("could not create the disposable login keychain") from exc
    if proc.returncode != 0 or not keychain.is_file():
        raise HarnessError("could not create the disposable login keychain")


def require_isolated_home(env: dict) -> None:
    if sys.platform == "darwin":
        home = env.get("HOME")
        if not home or not (Path(home) / "Library" / "Keychains" / "login.keychain-db").is_file():
            raise HarnessError("refusing to start a CLI without its disposable login keychain")


def binary_version(binary: Path, tool: str) -> str:
    with tempfile.TemporaryDirectory(prefix="harness-cli-version-") as work:
        home = Path(work) / "home"
        prepare_isolated_home(home)
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "LANG": "en_US.UTF-8"}
        require_isolated_home(env)
        proc = subprocess.run([str(binary), *TOOLS[tool]["version_flag"]], env=env, capture_output=True,
                              text=True, timeout=60)
    m = re.search(TOOLS[tool]["version_regex"], proc.stdout + proc.stderr, re.M)
    if not m:
        raise HarnessError(f"{tool} --version printed no version")
    return m.group(1)


# ---------- canary ----------

class Recorder:
    """A tiny localhost proxy that forwards to 9router and records each upstream request.

    For every request it keeps the path, the non-secret headers the CLI sent (anthropic-beta,
    x-app and similar), and the parsed JSON body. The key itself is never recorded: the forwarded
    auth headers are replaced, and the recorded headers exclude them.
    """

    SECRET_HEADERS = ("authorization", "x-api-key", "cookie")

    def __init__(self, upstream: str, key: str):
        if not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", upstream):
            raise HarnessError("canary proxy may only forward to a loopback 9router address")
        self.upstream = upstream
        self.key = key
        self.bodies: list[bytes] = []
        self.paths: list[str] = []
        self.requests: list[dict] = []
        self.server = None
        self.thread = None

    def start(self) -> str:
        import http.server
        import threading
        import urllib.request
        recorder = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep test output clean
                pass

            def do_POST(self):
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length)
                recorder.bodies.append(body)
                recorder.paths.append(self.path)
                safe_headers = {k.lower(): v for k, v in self.headers.items()
                                if k.lower() == "anthropic-beta"}
                try:
                    parsed = json.loads(body.decode("utf-8")) if body else None
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parsed = None
                record = {"path": self.path, "headers": safe_headers, "body": parsed}
                recorder.requests.append(record)
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in ("host", "content-length", "authorization", "x-api-key")}
                if self.path.startswith("/v1/messages") and isinstance(parsed, dict) and any(
                        isinstance(msg, dict) and isinstance(msg.get("content"), list)
                        and any(isinstance(block, dict) and block.get("type") == "thinking"
                                for block in msg["content"])
                        for msg in parsed.get("messages", [])):
                    beta = next((k for k in headers if k.lower() == "anthropic-beta"), "anthropic-beta")
                    values = [v.strip() for v in headers.get(beta, "").split(",") if v.strip()]
                    if "thinking-binding-controls-2026-08-01" not in values:
                        values.append("thinking-binding-controls-2026-08-01")
                    headers[beta] = ",".join(values)
                    record["headers"]["anthropic-beta"] = headers[beta]
                headers["x-api-key"] = recorder.key
                headers["authorization"] = f"Bearer {recorder.key}"
                req = urllib.request.Request(recorder.upstream + self.path, data=body, headers=headers,
                                             method="POST")
                try:
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        payload = resp.read()
                        recorder.capture_response(payload, record)
                        self.send_response(resp.status)
                        for k, v in resp.headers.items():
                            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                                self.send_header(k, v)
                        self.send_header("content-length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                except Exception as exc:  # report, do not leak the key
                    msg = f"proxy upstream error: {type(exc).__name__}".encode()
                    self.send_response(502)
                    self.send_header("content-length", str(len(msg)))
                    self.end_headers()
                    self.wfile.write(msg)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    @staticmethod
    def thinking_blocks_from(payload: bytes) -> list[dict]:
        """Every thinking block the model returned, from a JSON reply or a server-sent-events stream.

        Anthropic's stream sends a content_block_start with the thinking block (type, thinking,
        signature) and thinking_delta / signature_delta events. Both forms are handled.
        """
        found: list[dict] = []
        text = payload.decode("utf-8", errors="replace")
        try:
            doc = json.loads(text)
            for block in (doc.get("content") or []) if isinstance(doc, dict) else []:
                if isinstance(block, dict) and block.get("type") == "thinking":
                    found.append({"thinking": block.get("thinking", ""), "signature": block.get("signature", "")})
            return found
        except json.JSONDecodeError:
            pass
        current: dict | None = None
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if event.get("type") == "content_block_start":
                block = event.get("content_block") or {}
                if block.get("type") == "thinking":
                    current = {"thinking": block.get("thinking", ""), "signature": block.get("signature", "")}
                    found.append(current)
                else:
                    current = None
            elif event.get("type") == "content_block_delta" and current is not None:
                delta = event.get("delta") or {}
                if delta.get("type") == "thinking_delta":
                    current["thinking"] += delta.get("thinking", "")
                elif delta.get("type") == "signature_delta":
                    current["signature"] += delta.get("signature", "")
            elif event.get("type") == "content_block_stop":
                current = None
        return found

    def capture_response(self, payload: bytes, record: dict) -> None:
        """Keep only the fields needed to verify the response; never persist the response body."""
        record["response_thinking"] = self.thinking_blocks_from(payload)
        docs = []
        try:
            docs.append(json.loads(payload))
        except (UnicodeDecodeError, json.JSONDecodeError):
            for line in payload.decode("utf-8", errors="replace").splitlines():
                if line.startswith("data:"):
                    try:
                        docs.append(json.loads(line[5:].strip()))
                    except json.JSONDecodeError:
                        pass
        transformations = []
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            # Anthropic exposes this on a message, not in its tool inputs or text.
            message = doc.get("message") if doc.get("type") == "message_start" else doc
            if isinstance(message, dict) and "input_transformations" in message:
                transformations.append(message["input_transformations"])
        record["response_transformations"] = transformations


def nine_router_key() -> str:
    key = os.environ.get("NINEROUTER_KEY", "")
    return key if key else "dummy"


def run_cli(binary: Path, args: list[str], *, env: dict, timeout: int = 300,
            cwd: Path | None = None) -> subprocess.CompletedProcess:
    """Run a CLI with an explicit cwd, so per-project state (memory) is the one the canary seeded."""
    require_isolated_home(env)
    return subprocess.run([str(binary), *args], env=env, capture_output=True, text=True,
                          timeout=timeout, cwd=str(cwd) if cwd else None)


def make_throwaway_homes(work: Path) -> tuple[Path, Path]:
    """Generate both harness homes with the real B1 generator, in a throwaway HOME.

    The manifest points at ~/.config/opencode (AGENTS.md and skills). The throwaway HOME gets
    read-only copies of those sources, so the generator runs unmodified and the canary tests
    the homes Robob would really use. Nothing under the real HOME is written.
    """
    gen = harness_homes_pkg() / "generate_homes.py"
    if not gen.is_file():
        raise HarnessError("harness-homes generator is not installed (card B1); cannot canary")
    fake_home = work / "home"
    prepare_isolated_home(fake_home)
    live_cfg = Path(os.environ.get("HARNESS_CLI_SOURCE_HOME", Path.home())) / ".config" / "opencode"
    dst_cfg = fake_home / ".config" / "opencode"
    if not (live_cfg / "AGENTS.md").is_file():
        raise HarnessError(f"instruction source missing: {live_cfg / 'AGENTS.md'}")
    dst_cfg.mkdir(parents=True, exist_ok=True)
    shutil.copy2(live_cfg / "AGENTS.md", dst_cfg / "AGENTS.md")
    skills_src = live_cfg / "skills"
    if skills_src.is_dir():
        # Copy the real skill directories (following links) so discovery sees the same set.
        shutil.copytree(skills_src, dst_cfg / "skills", symlinks=False, dirs_exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = str(fake_home)
    for sub in ("generate", "check"):
        proc = subprocess.run([python_bin(), str(gen), sub, "--home-root", str(work / "homes")], env=env,
                              capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-1:]
            raise HarnessError(f"harness-homes {sub} failed on throwaway homes: {tail}")
    return work / "homes" / "claude", work / "homes" / "codex"


def make_codex_cu_home(work: Path) -> Path:
    """The generated codex-cu home (Terra, computer use). Generated by the same B1 generator."""
    make_throwaway_homes(work)
    cu = work / "homes" / "codex-cu"
    if not (cu / "config.toml").is_file():
        raise HarnessError("harness-homes did not generate the codex-cu home")
    return cu


def claude_env(home: Path, config_dir: Path, base: str) -> dict:
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(home),
        "CLAUDE_CONFIG_DIR": str(config_dir),
        "ANTHROPIC_BASE_URL": base,
        "ANTHROPIC_API_KEY": nine_router_key(),
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "CLAUDE_CODE_DISABLE_ORG_MEMORY": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "LANG": "en_US.UTF-8",
    }


def claude_project_slug(project_dir: Path) -> str:
    """Claude Code replaces non-alphanumeric path characters in project directory names."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(project_dir.resolve()))


THINKING_CANARY_WORD = "ROBOB-THINK-4417"


def thinking_replay_check(first_turn: list[dict], second_turn: list[dict]) -> dict:
    """Require a matching signed block in turn two and explicit empty response transformations."""
    replies = [b for rec in first_turn for b in rec.get("response_thinking", [])
               if b.get("thinking") and b.get("signature")]
    matched = False
    reports = []
    observed = False
    for rec in second_turn:
        body = rec.get("body")
        if not isinstance(body, dict):
            continue
        for message in body.get("messages", []):
            if isinstance(message, dict) and message.get("role") == "assistant":
                content = message.get("content")
                if isinstance(content, list):
                    blocks = [b for b in content if isinstance(b, dict) and b.get("type") == "thinking"]
                    this_match = any(b.get("thinking") == r["thinking"] and b.get("signature") == r["signature"]
                                     for b in blocks for r in replies)
                    if this_match:
                        matched = True
                        transformations = rec.get("response_transformations") or []
                        observed = observed or bool(transformations)
                        reports.append(bool(transformations) and all(v == [] for v in transformations))
    return {"turn1ThinkingBlocks": len(replies), "thinkingReplayed": matched,
            "inputTransformationsObserved": observed, "inputTransformationsEmpty": bool(reports) and all(reports)}


def canary_claude(binary: Path, version: str, work: Path, key_present: bool) -> dict:
    """Run the real CLI: a memory-off check plus a two-turn Opus preserved-thinking check.

    Memory: the seed is written for the project dir the CLI runs in, and the marker must be absent
    from every request body. Thinking: turn 1 (one session) produces a thinking block; turn 2 (the
    same session) must send that block back with its signature, and must carry no
    input_transformations. A gateway that drops the thinking blocks fails promotion here.

    The context-management edits and the anthropic-beta header are recorded as informational
    diagnostics only; they never fail the canary.
    """
    home = work / "claude-home"
    cdir = home / ".claude"
    homes_claude, _ = make_throwaway_homes(work / "gen")
    shutil.copytree(homes_claude, cdir, dirs_exist_ok=True)
    project = work / "project"
    project.mkdir(parents=True, exist_ok=True)
    mem_dir = cdir / "projects" / claude_project_slug(project) / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    (mem_dir / "MEMORY.md").write_text(f"canary memory {CLAUDE_MEMORY_CANARY}\n", encoding="utf-8")
    recorder = Recorder(nine_router_url(), nine_router_key())
    base = recorder.start()
    results: dict = {}
    try:
        prepare_isolated_home(home)
        # Claude settings' env takes precedence over the process env; otherwise it bypasses the proxy.
        settings_path = cdir / "settings.json"
        settings = read_json(settings_path, {})
        settings.setdefault("env", {})["ANTHROPIC_BASE_URL"] = base
        write_json_atomic(settings_path, settings)
        env = claude_env(home, cdir, base)
        model = "claude-opus-5-5"
        routed = CLAUDE_MODEL_IDS[model]
        session_id = str(uuid_for(work))
        turn1 = run_cli(binary, ["-p", f"Remember the code {THINKING_CANARY_WORD}. Think it through briefly, "
                                 "then reply with the single word OK.", "--model", routed,
                                 "--effort", "high", "--session-id", session_id, "--output-format", "text"],
                        env=env, timeout=240, cwd=project)
        turn1_ok = turn1.returncode == 0 and "OK" in turn1.stdout
        first_turn = list(recorder.requests)
        boundary = len(first_turn)
        turn2 = run_cli(binary, ["-p", "What code did I ask you to remember? Reply with the code only.",
                                 "--model", routed, "--effort", "high", "--resume", session_id,
                                 "--output-format", "text"], env=env, timeout=240, cwd=project)
        turn2_ok = turn2.returncode == 0 and THINKING_CANARY_WORD in turn2.stdout
        results[model] = {"ok": turn1_ok and turn2_ok, "turn1Ok": turn1_ok, "turn2Ok": turn2_ok}
        # The recorder keeps every upstream request and the thinking blocks each reply returned.
        preserved = thinking_replay_check(first_turn, recorder.requests[boundary:])
        results["thinking"] = preserved
        results["thinkingCheckChecked"] = bool(first_turn and recorder.requests[boundary:])
        results["thinkingReplayed"] = preserved["thinkingReplayed"]
        results["inputTransformationsEmpty"] = preserved["inputTransformationsEmpty"]
        haiku = run_cli(binary, ["-p", "Reply exactly OK.", "--model", CLAUDE_MODEL_IDS["claude-haiku-5-5"],
                                  "--effort", "low", "--output-format", "text"], env=env, timeout=240, cwd=project)
        results["claude-haiku-5-5"] = {"ok": haiku.returncode == 0 and "OK" in haiku.stdout}
        # Informational diagnostics for the record (never promotion failures).
        results["diagnostics"] = {
            "contextManagement": [(r.get("body") or {}).get("context_management")
                                  for r in recorder.requests if isinstance(r.get("body"), dict)
                                  and "context_management" in r["body"]],
            "anthropicBeta": sorted({str(r.get("headers", {}).get("anthropic-beta"))
                                     for r in recorder.requests if r.get("headers", {}).get("anthropic-beta")}),
        }
        # The marker must be absent from every request body the CLI sent, and the seed must
        # have been there to be read (a seed the CLI never reads proves nothing).
        seed_present = (mem_dir / "MEMORY.md").is_file()
        leaked = any(CLAUDE_MEMORY_CANARY.encode() in body for body in recorder.bodies)
        results["memoryCanaryLeaked"] = leaked
        results["memoryCanaryChecked"] = seed_present and len(recorder.bodies) > 0
        results["requests"] = len(recorder.bodies)
    finally:
        recorder.stop()
    return results


def uuid_for(work: Path) -> str:
    """A stable session UUID for this canary run (derived from the disposable dir name)."""
    import uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(work)))


# Names the memory pipeline writes: the memories folder and its stores (memories_1.sqlite and
# -wal/-shm), the phase-2 consolidation files, and raw_memories. Codex's own thread state
# (state_*.sqlite, sessions, rollouts) never matches these prefixes.
CODEX_MEMORY_ARTIFACT_RE = re.compile(r"^(memories[^/]*|phase2[^/]*|raw_memories[^/]*|memory_summary\.md|MEMORY\.md)$")
CODEX_MEMORY_SECTION_MARKERS = (b"## Memory", b"<memories>", b"memory_summary", b"Memory Phase 2")
CODEX_MEMORY_SECTION_RE = re.compile(
    r"<\s*/?\s*memor(?:y|ies)(?:\s[^>]*)?>|^\s*#{1,6}\s+memor(?:y|ies)\b"
    r"|\b(?:memory_summary|memory phase 2|(?:old|older|prior|previous|saved|stored|persistent|user|retrieved|remembered)\s+memor(?:y|ies))\b",
    re.IGNORECASE | re.MULTILINE,
)


def codex_memory_artifacts(chome: Path) -> list[str]:
    """Every memory-pipeline file or folder under the Codex home, at any depth."""
    found = []
    for dirpath, dirs, files in os.walk(chome):
        for name in dirs + files:
            if CODEX_MEMORY_ARTIFACT_RE.match(name):
                found.append(os.path.relpath(os.path.join(dirpath, name), chome))
    return sorted(found)


def codex_memory_snapshot(chome: Path) -> dict[str, str]:
    """Account for the seeded files as well as all files created under memory directories."""
    snapshot = {}
    for dirpath, dirs, files in os.walk(chome):
        directory = Path(dirpath)
        inside_memory = any(CODEX_MEMORY_ARTIFACT_RE.match(part) for part in directory.relative_to(chome).parts)
        for name in dirs + files:
            path = directory / name
            if inside_memory or CODEX_MEMORY_ARTIFACT_RE.match(name):
                relative = str(path.relative_to(chome))
                if path.is_symlink():
                    raise HarnessError("memory fixture contains a symlink")
                snapshot[relative] = "directory" if path.is_dir() else sha256_file(path)
    return snapshot


def codex_memory_in_body(body, sentinel: str, instruction_text: str | None = None) -> tuple[bool, bool]:
    """Inspect decoded JSON strings, including nested Responses API input/content items."""
    sentinel_seen = False
    section_seen = False
    def visit(value):
        nonlocal sentinel_seen, section_seen
        if isinstance(value, str):
            sentinel_seen = sentinel_seen or sentinel in value
            # Known AGENTS.md text is not evidence of built-in memory injection. Still scan the
            # complete payload for the sentinel, and scan everything outside the exact copy.
            other = value.replace(instruction_text, "") if instruction_text else value
            section_seen = section_seen or bool(CODEX_MEMORY_SECTION_RE.search(other))
        elif isinstance(value, dict):
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
    visit(body)
    return sentinel_seen, section_seen


def run_codex_memory_probe(binary: Path, generated_home: Path, work: Path, models: list[str],
                           *, enable_memory: bool) -> dict:
    """Run Codex against a disposable copy of a generated home, with the memory check.

    Not ephemeral: Codex 0.166.0 disables the memory pipeline for ephemeral sessions, so an
    ephemeral run proves nothing about memory. The copy lives under `work` and CODEX_HOME points
    at it, so nothing is written to the generator's output or any personal home.

    enable_memory=True turns memory ON in the copy: the positive control. The detector must fire
    there, otherwise a "clean" result on the real home could just mean the detector is blind.
    """
    chome = work / "codex-home" / ".codex"
    shutil.copytree(generated_home, chome, dirs_exist_ok=True)
    if enable_memory:
        cfg_path = chome / "config.toml"
        text = cfg_path.read_text(encoding="utf-8")
        text = text.replace("generate_memories = false", "generate_memories = true")
        text = text.replace("use_memories = false", "use_memories = true")
        text = text.replace("memories = false", "memories = true")
        cfg_path.write_text(text, encoding="utf-8")
    # Seed both read-memory files and a completed, non-ephemeral rollout in the disposable home.
    sentinel = "ROBOB-CODEX-MEMORY-" + uuid.uuid4().hex
    memory_dir = chome / "memories"
    memory_dir.mkdir(parents=True, exist_ok=True)
    for name in ("MEMORY.md", "memory_summary.md", "raw_memories.md"):
        (memory_dir / name).write_text(f"Canary preference: {sentinel}\n", encoding="utf-8")
    baseline = codex_memory_snapshot(chome)
    # If the installed
    # Codex release does not process it, the enabled positive control fails closed.
    sessions = chome / "sessions" / "2025" / "01" / "01"
    sessions.mkdir(parents=True, exist_ok=True)
    rollout = sessions / "rollout-2025-01-01T00-00-00-00000000-0000-4000-8000-000000000001.jsonl"
    fixture = [
        {"timestamp": "2025-01-01T00:00:00Z", "type": "session_meta",
         "payload": {"id": "00000000-0000-4000-8000-000000000001", "timestamp": "2025-01-01T00:00:00Z",
                     "cwd": str(work), "originator": "codex_cli_rs", "cli_version": "0.166.0", "source": "cli"}},
        {"timestamp": "2025-01-01T00:00:01Z", "type": "response_item",
         "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Remember the fixture preference: blue."}]}},
        {"timestamp": "2025-01-01T00:00:02Z", "type": "response_item",
         "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "The fixture preference is blue."}]}},
    ]
    rollout.write_text("".join(json.dumps(event) + "\n" for event in fixture), encoding="utf-8")
    recorder = Recorder(nine_router_url(), nine_router_key())
    base = recorder.start()
    results: dict = {"positiveControl": enable_memory, "models": {}}
    try:
        prepare_isolated_home(work / "codex-home")
        instructions_path = chome / "AGENTS.md"
        instructions = instructions_path.read_text(encoding="utf-8") if instructions_path.is_file() else None
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work / "codex-home"),
               "CODEX_HOME": str(chome), "NINEROUTER_KEY": nine_router_key(),
               "NINEROUTER_BASE": base, "LANG": "en_US.UTF-8"}
        cfg = ["-c", f'model_providers.ninerouter.base_url="{base}/v1"']
        if enable_memory:
            cfg += ["-c", "memories.min_rollout_idle_hours=0", "-c", "memories.max_rollouts_per_startup=1"]
        for model in models:
            before = len(recorder.requests)
            proc = run_cli(binary, ["exec", "--skip-git-repo-check", "-s", "read-only",
                                    "-m", model, *cfg, "Reply exactly OK."], env=env, timeout=240,
                           cwd=work)
            ok = proc.returncode == 0 and "OK" in proc.stdout
            records = recorder.requests[before:]
            observations = [codex_memory_in_body(r.get("body"), sentinel, instructions) for r in records]
            sentinel_seen = any(item[0] for item in observations)
            section = any(item[1] for item in observations)
            bodies_decoded = all(isinstance(r.get("body"), dict) for r in records)
            results["models"][model] = {"ok": ok and bool(records) and bodies_decoded, "requests": len(records),
                                        "memorySentinelInRequest": sentinel_seen,
                                        "memorySectionInRequest": section}
        after = codex_memory_snapshot(chome)
        artifacts = sorted(path for path in set(baseline) | set(after) if baseline.get(path) != after.get(path))
        results["memoryBaseline"] = baseline
        results["memoryArtifacts"] = artifacts
        results["memoryPipelineRan"] = bool(artifacts)
        results["memorySentinelSeen"] = any(m.get("memorySentinelInRequest") for m in results["models"].values())
        results["memoryPromptSeen"] = any(m.get("memorySectionInRequest") for m in results["models"].values())
        results["requests"] = len(recorder.requests)
    finally:
        recorder.stop()
    return results


def canary_codex(binary: Path, version: str, work: Path, key_present: bool, *,
                 models: list[str] | None = None, generated_home: Path | None = None) -> dict:
    """The memory-off check on a generated Codex home, with a positive control first.

    The positive control (memory enabled on a copy) must show the detector firing. Only then does
    the real generated home count: no memory section in any request, no memory artifact on disk.
    """
    models = models or MODEL_CANARIES["codex"]
    if generated_home is None:
        _, generated_home = make_throwaway_homes(work / "gen")
    control_work = work / "control"
    control_work.mkdir(parents=True, exist_ok=True)
    control = run_codex_memory_probe(binary, generated_home, control_work, models[:1], enable_memory=True)
    detector_fires = control["memoryPipelineRan"] is True
    read_control_fires = control["memorySentinelSeen"] is True
    real_work = work / "real"
    real_work.mkdir(parents=True, exist_ok=True)
    real = run_codex_memory_probe(binary, generated_home, real_work, models, enable_memory=False)
    results = {
        "positiveControlFired": detector_fires,
        "readControlFired": read_control_fires,
        "positiveControlArtifacts": control["memoryArtifacts"],
        "models": real["models"],
        "memoryBaseline": real["memoryBaseline"],
        "memoryArtifacts": real["memoryArtifacts"],
        "memoryPipelineRan": real["memoryPipelineRan"],
        "memorySentinelSeen": real["memorySentinelSeen"],
        "memoryPromptSeen": real["memoryPromptSeen"],
        "memoryCanaryChecked": bool(detector_fires and read_control_fires and real["requests"] > 0),
        "requests": real["requests"],
    }
    return results


def canary(tool: str, version: str) -> dict:
    """Run the full canary and write one durable record for the outcome.

    Every outcome is recorded: a pass, a failed check, or an exception (generation, version,
    timeout, proxy). A failure record supersedes an older pass, so a stale pass can never
    authorize a promotion.
    """
    if tool not in TOOLS:
        raise HarnessError(f"unknown tool {tool}")
    binary = version_dir(tool, version) / "bin" / ("claude" if tool == "claude" else "codex")
    reasons: list[str] = []
    result: dict = {}
    digest = None
    try:
        check_minimums(tool, version)
        if not binary.is_file():
            raise HarnessError(f"{binary} not staged")
        digest = sha256_file(binary)
        if binary_version(binary, tool) != version:
            raise HarnessError(f"{binary} does not report {version}")
        key_present = bool(os.environ.get("NINEROUTER_KEY"))
        if tool == "claude":
            work = Path(tempfile.mkdtemp(prefix=f"harness-cli-canary-{tool}-"))
            try:
                result = canary_claude(binary, version, work, key_present)
            finally:
                remove_tree(work)
            models = MODEL_CANARIES["claude"]
            failed = [m for m in models if not result.get(m, {}).get("ok")]
            memory_fail = result.get("memoryCanaryLeaked") is True
            memory_checked = result.get("memoryCanaryChecked") is True
            requests = result.get("requests", 0)
            # Preserved thinking is a promotion gate: turn 2 must replay turn 1's thinking block with
            # its signature, and the gateway must not have rewritten the conversation.
            if not result.get("thinkingCheckChecked"):
                reasons.append("preserved-thinking check did not run (fewer than two turns)")
            elif not result.get("thinkingReplayed"):
                reasons.append("preserved thinking was not replayed in turn 2 (dropped or altered)")
            if result.get("thinkingCheckChecked") and not result.get("inputTransformationsEmpty"):
                reasons.append("turn 2 response did not confirm empty input_transformations")
        else:
            # Two homes: the plain Codex home (Astra, Sol) and the codex-cu home (Terra).
            plain_work = Path(tempfile.mkdtemp(prefix=f"harness-cli-canary-{tool}-"))
            cu_work = Path(tempfile.mkdtemp(prefix=f"harness-cli-canary-{tool}-cu-"))
            try:
                plain_home = make_throwaway_homes(plain_work / "gen")[1]
                cu_home = make_codex_cu_home(cu_work / "gen")
                import tomllib
                cu_config = tomllib.loads((cu_home / "config.toml").read_text(encoding="utf-8"))
                if (cu_config.get("model") != CODEX_CU_MODELS[0]
                        or (cu_config.get("features") or {}).get("computer_use") is not True
                        or not (cu_home / "models.json").is_file() or not (cu_home / "AGENTS.md").is_file()):
                    raise HarnessError("generated codex-cu home is missing Terra settings")
                plain = canary_codex(binary, version, plain_work, key_present,
                                     models=MODEL_CANARIES["codex"], generated_home=plain_home)
                cu = canary_codex(binary, version, cu_work, key_present,
                                  models=CODEX_CU_MODELS, generated_home=cu_home)
            finally:
                remove_tree(plain_work)
                remove_tree(cu_work)
            result = {**plain, **{f"cu:{k}": v for k, v in cu.items()}, "cu": cu}
            models = MODEL_CANARIES["codex"] + CODEX_CU_MODELS
            failed = [m for m in MODEL_CANARIES["codex"] if not plain.get("models", {}).get(m, {}).get("ok")]
            failed += [m for m in CODEX_CU_MODELS if not cu.get("models", {}).get(m, {}).get("ok")]
            memory_fail = (plain.get("memoryPipelineRan") or cu.get("memoryPipelineRan")
                           or plain.get("memorySentinelSeen") or cu.get("memorySentinelSeen")
                           or plain.get("memoryPromptSeen") or cu.get("memoryPromptSeen"))
            memory_checked = plain.get("memoryCanaryChecked") is True and cu.get("memoryCanaryChecked") is True
            requests = plain.get("requests", 0) + cu.get("requests", 0)
        if failed:
            reasons.append(f"model prompt failed: {', '.join(failed)}")
        if memory_fail:
            reasons.append("memory-off canary failed (memory reached the model or the pipeline ran)")
        if not memory_checked:
            reasons.append("memory-off check did not run")
        if requests == 0:
            reasons.append("no request reached the recording proxy")
    except HarnessError as exc:
        reasons.append(str(exc))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        reasons.append(f"canary error: {type(exc).__name__}")
    passed = not reasons
    write_record("canary", tool, version, "passed" if passed else "failed",
                 binarySha256=digest, canary=result, reasons=reasons,
                 harnessHomes=harness_home_hashes(), keyPresent=bool(os.environ.get("NINEROUTER_KEY")))
    return {"passed": passed, "reasons": reasons, "result": result}


# ---------- promote / rollback ----------

def swap_current(tool: str, version: str) -> None:
    link = current_link(tool)
    target = version_dir(tool, version)
    tmp = link.with_name(f".current.{os.getpid()}.tmp")
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(str(target), tmp)
    os.replace(tmp, link)  # atomic rename over the old symlink


def current_version_from_link(tool: str) -> str | None:
    link = current_link(tool)
    if not os.path.lexists(link):
        return None
    if not link.is_symlink():
        raise HarnessError(f"{link} is not a symlink; refusing pin transition")
    target = Path(os.path.abspath(link.parent / os.readlink(link)))
    if target.parent != tool_dir(tool).absolute():
        raise HarnessError(f"{link} points outside the tool directory; refusing pin transition")
    parse_version(target.name)
    return target.name


def apply_transition(state: dict, transition: dict) -> None:
    slot = state[transition["tool"]]
    slot["current"] = transition["to"]
    slot["lastKnownGood"] = transition["lastKnownGood"]
    slot["rotationPending"] = transition["tool"] == "codex"
    if transition["op"] == "promote":
        slot["candidate"] = None
        slot["promotedAt"] = transition["promotedAt"]
    notice = transition["notice"]
    if notice is not None:
        state.setdefault("pendingNotices", {}).setdefault(
            notice["key"], {"severity": notice["severity"], "text": notice["text"]})


def reconcile_transition() -> None:
    """Finish or cancel a journaled pin change. Caller holds StateLock."""
    state = load_state()
    transition = state.get("pendingTransition")
    if transition is None:
        return
    if not isinstance(transition, dict) or transition.get("op") not in ("promote", "rollback") \
            or transition.get("tool") not in TOOLS:
        raise HarnessError("invalid pending pin transition; refusing to continue")
    try:
        tool = transition["tool"]
        old, new = transition["from"], transition["to"]
        if old is not None:
            parse_version(old)
        parse_version(new)
        if old == new or transition["lastKnownGood"] != old:
            raise ValueError("invalid transition")
        notice = transition["notice"]
        if notice is not None and (not isinstance(notice, dict) or any(
                not isinstance(notice.get(k), str) or not notice[k] for k in ("key", "severity", "text"))):
            raise ValueError("invalid notice")
        if transition["op"] == "promote" and not isinstance(transition["promotedAt"], str):
            raise ValueError("invalid promotedAt")
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise HarnessError("invalid pending pin transition; refusing to continue") from exc
    actual = current_version_from_link(tool)
    if actual == new:
        apply_transition(state, transition)
        save_state(state)  # Keep the journal until the resulting state and outbox are durable.
    elif actual == old:
        if state[tool].get("current") != old:
            raise HarnessError("pending transition disagrees with state; refusing to continue")
    else:
        raise HarnessError("pending transition disagrees with current symlink; refusing to continue")
    del state["pendingTransition"]
    save_state(state)


def transition_current(state: dict, transition: dict) -> None:
    """Journal first, swap, commit state/outbox, then clear the journal under StateLock."""
    if state.get("pendingTransition") is not None:
        raise HarnessError("pending pin transition must be reconciled first")
    if current_version_from_link(transition["tool"]) != transition["from"]:
        raise HarnessError("current symlink disagrees with state; refusing pin transition")
    state["pendingTransition"] = transition
    save_state(state)
    swap_current(transition["tool"], transition["to"])
    apply_transition(state, transition)
    save_state(state)
    del state["pendingTransition"]
    save_state(state)


def promote(tool: str, version: str, *, queue_notice: bool = False) -> dict:
    if tool not in TOOLS:
        raise HarnessError(f"unknown tool {tool}")
    if not version_dir(tool, version).is_dir():
        raise HarnessError(f"{version} is not staged")
    state = load_state()
    slot = state[tool]
    previous = slot.get("current")
    if previous == version:
        return {"tool": tool, "version": version, "status": "already-current"}
    verdict = latest_canary(tool, version)
    if not verdict or not verdict.get("passed"):
        raise HarnessError(f"{tool} {version} has no passing canary; refusing to promote")
    if verdict.get("memoryCheckedAt") is None:
        raise HarnessError("canary record lacks the memory-off check")
    binary = version_dir(tool, version) / "bin" / ("claude" if tool == "claude" else "codex")
    if not binary.is_file() or not verdict.get("binarySha256") or sha256_file(binary) != verdict["binarySha256"]:
        raise HarnessError("staged binary differs from the canary record")
    if tool == "codex":
        status = "promoted, rotation pending"
    else:
        status = "promoted"
    notice = None
    if queue_notice:
        key = f"harness-cli:{tool}:{version}:promoted"
        notice = {"key": key, "severity": "info",
                  "text": f"Harness CLI: {tool} {version} {status} (previous {previous})."}
    transition_current(state, {"op": "promote", "tool": tool, "from": previous, "to": version,
                               "lastKnownGood": previous, "notice": notice, "promotedAt": now_iso()})
    digest = verdict.get("binarySha256")
    write_record("promote", tool, version, status, binarySha256=digest,
                 previous=previous, harnessHomes=harness_home_hashes())
    return {"tool": tool, "version": version, "previous": previous, "status": status}


def rollback(tool: str) -> dict:
    state = load_state()
    slot = state[tool]
    target = slot.get("lastKnownGood")
    if not target:
        raise HarnessError(f"{tool} has no lastKnownGood to roll back to")
    if not version_dir(tool, target).is_dir():
        raise HarnessError(f"lastKnownGood {target} is no longer on disk")
    previous = slot.get("current")
    transition_current(state, {"op": "rollback", "tool": tool, "from": previous, "to": target,
                               "lastKnownGood": previous, "notice": None})
    write_record("rollback", tool, target, "rolled back", previous=previous,
                 harnessHomes=harness_home_hashes())
    return {"tool": tool, "version": target, "previous": previous}


def latest_canary(tool: str, version: str) -> dict | None:
    """The most recent canary record for this exact tool/version, or None."""
    if not records_path().exists():
        return None
    found = None
    for line in records_path().read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("action") == "canary" and record.get("tool") == tool and record.get("version") == version:
            found = record
    if found is None:
        return None
    canary_body = found.get("canary") or {}
    # Same rule as canary(): a pass needs no reasons, the memory check ran, and it found nothing.
    memory_ok = canary_body.get("memoryCanaryChecked") is True and not (
        canary_body.get("memoryCanaryLeaked") is True if tool == "claude"
        else (canary_body.get("memoryPipelineRan") or canary_body.get("memoryPromptSeen")
              or canary_body.get("memorySentinelSeen")
              or (canary_body.get("cu") or {}).get("memoryPipelineRan")
              or (canary_body.get("cu") or {}).get("memorySentinelSeen")
              or (canary_body.get("cu") or {}).get("memoryPromptSeen")))
    if tool == "claude":
        checks_ok = (canary_body.get("thinkingCheckChecked") is True
                     and canary_body.get("thinkingReplayed") is True
                     and canary_body.get("inputTransformationsEmpty") is True)
    else:
        checks_ok = ((canary_body.get("cu") or {}).get("memoryCanaryChecked") is True
                     and canary_body.get("positiveControlFired") is True
                     and (canary_body.get("cu") or {}).get("positiveControlFired") is True
                     and canary_body.get("readControlFired") is True
                     and (canary_body.get("cu") or {}).get("readControlFired") is True)
    passed = found.get("result") == "passed" and not found.get("reasons") and memory_ok and checks_ok
    return {
        "passed": passed,
        "binarySha256": found.get("binarySha256"),
        "memoryCheckedAt": found.get("at") if passed else None,
    }


# ---------- Codex rotation ----------

def rotate_codex(*, when_idle: bool = True, quiet_seconds: int = 300, checker=None, refresher=None,
                 sleep=time.sleep, clock=time.monotonic, max_wait_seconds: int = 1800) -> str:
    """Leave rotation pending until both shared runtimes can be safely recreated and verified."""
    state = load_state()
    if not state["codex"].get("rotationPending"):
        return "no Codex rotation pending"
    if state.get("autoRotateCodex") is not True:
        return "autoRotateCodex is off; Codex rotates only at the next Robob release (standing OK not recorded)"
    # Refreshing a provider snapshot is not a runtime drain/recreation. Do not touch either
    # instance until both runtimes can be recreated and their launched versions verified.
    return "Codex runtime rotation is unsupported for codex and codex-cu; rotation remains pending"
def idle_snapshot() -> dict:
    """GET the recovery snapshot (card E7). Absent route = refuse to rotate."""
    token = control_token()
    url = os.environ.get("T3_CONTROL_URL", "http://127.0.0.1:3773").rstrip("/") + CONTROL_RECOVERY
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise HarnessError("recovery snapshot route is missing (card E7 not installed); not rotating")
        raise HarnessError(f"recovery snapshot failed: HTTP {exc.code}")
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise HarnessError(f"recovery snapshot unavailable ({type(exc).__name__}); not rotating")
    return body


def control_token() -> str:
    path = os.environ.get("T3_CONTROL_TOKEN_FILE") or str(Path.home() / ".robob" / "components" / "watchers.json")
    token = read_json(Path(path), {}).get("token", "")
    if not token:
        raise HarnessError("no component control token; not rotating")
    return token


SNAPSHOT_THREAD_FIELDS = ("threadId", "provider", "runningRun", "heldWork", "pendingRequest")
SNAPSHOT_PROVIDERS = {"codex", "codex-cu", "claudeagent", "opencode", "cursor", "grok", "antigravity", "pi", "muse"}


def codex_busy(snapshot: dict) -> bool:
    """True when any Codex thread has a running run, held work or a pending request.

    Fails closed: a snapshot without a `threads` list, or a thread missing any required field,
    raises HarnessError. An empty or changed response must never read as "idle". The field names
    are the contract this job expects from card E7's recovery snapshot, which is not on ardud/main
    yet, so they are unverified until E7 ships.
    """
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("threads"), list):
        raise HarnessError("recovery snapshot has no threads list; not rotating")
    busy = False
    for thread in snapshot["threads"]:
        if not isinstance(thread, dict) or any(f not in thread for f in SNAPSHOT_THREAD_FIELDS):
            raise HarnessError("recovery snapshot thread is missing required fields; not rotating")
        identity, provider = thread["threadId"], thread["provider"]
        if not isinstance(identity, str) or not identity.strip():
            raise HarnessError("recovery snapshot has invalid thread identity; not rotating")
        if not isinstance(provider, str) or provider.lower() not in SNAPSHOT_PROVIDERS:
            raise HarnessError("recovery snapshot has invalid provider identity; not rotating")
        if (thread["runningRun"] is not None and not isinstance(thread["runningRun"], dict)
                or type(thread["heldWork"]) is not bool
                or thread["pendingRequest"] is not None and not isinstance(thread["pendingRequest"], dict)):
            raise HarnessError("recovery snapshot has invalid work fields; not rotating")
        if provider.lower() not in ("codex", "codex-cu"):
            continue
        if thread["runningRun"] is not None or thread["heldWork"] or thread["pendingRequest"] is not None:
            busy = True
    return busy


def wait_for_idle(checker: Callable[[], dict], quiet_seconds: int, *, sleep=time.sleep,
                  clock=time.monotonic, poll_seconds: int = 30, max_wait_seconds: int = 1800) -> str:
    """Require no busy Codex thread for `quiet_seconds`. Never forces; gives up after max_wait.

    A busy Codex app-server is left alone: the run that found it busy just reports and exits,
    and the next daily run tries again.
    """
    started = clock()
    quiet_from = None
    while True:
        busy = codex_busy(checker())
        now = clock()
        if busy:
            quiet_from = None
        elif quiet_from is None:
            quiet_from = now
        if quiet_from is not None and now - quiet_from >= quiet_seconds:
            return now_iso()
        if now - started >= max_wait_seconds:
            raise HarnessError("Codex threads stayed busy; rotation skipped, retry next run")
        sleep(poll_seconds)


CODEX_INSTANCE_IDS = ("codex", "codex-cu")


class WsClient:
    """A minimal RFC 6455 client over a plain socket (ws:// to loopback only), stdlib only.

    Enough for Robob's RPC: the upgrade handshake, masked text frames out, unmasked frames in
    (server frames may span continuations), and close. Refuses anything that isn't loopback.
    """

    def __init__(self, url: str, headers: dict[str, str], timeout: float = 90.0):
        import urllib.parse
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "ws" or parsed.hostname not in ("127.0.0.1", "localhost"):
            raise HarnessError("refusing a non-loopback or non-ws control URL")
        self.host = parsed.hostname
        self.port = parsed.port or 80
        self.path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
        self.headers = headers
        self.timeout = timeout
        self.sock = None
        self.buffer = b""

    def __enter__(self):
        import base64
        import socket
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        lines = [f"GET {self.path} HTTP/1.1", f"Host: {self.host}:{self.port}", "Upgrade: websocket",
                 "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
        lines += [f"{k}: {v}" for k, v in self.headers.items()]
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise HarnessError("websocket closed during handshake")
            head += chunk
        header, _, rest = head.partition(b"\r\n\r\n")
        if not header.startswith(b"HTTP/1.1 101"):
            raise HarnessError("websocket upgrade refused")
        self.buffer = rest
        return self

    def __exit__(self, *exc):
        try:
            self.sock.close()
        except OSError:
            pass

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise HarnessError("websocket closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += n.to_bytes(2, "big")
        else:
            header.append(0x80 | 127)
            header += n.to_bytes(8, "big")
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + mask + masked)

    def recv_text(self) -> str:
        message = b""
        while True:
            b1, b2 = self._recv_exact(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = int.from_bytes(self._recv_exact(2), "big")
            elif n == 127:
                n = int.from_bytes(self._recv_exact(8), "big")
            payload = self._recv_exact(n) if n else b""
            if opcode == 0x8:  # close
                raise HarnessError("websocket closed by server")
            if opcode == 0x9:  # ping: answer with pong (masked, as clients must)
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if opcode in (0x1, 0x0):
                message += payload
                if fin:
                    return message.decode("utf-8")


def refresh_codex_provider(instance_id: str = "codex") -> None:
    """Ask Robob to re-probe a Codex instance: WS RPC server.refreshProviders {instanceId}.

    Same framing as catalog-guard's client: a Request frame with the bearer token; the reply is an
    Exit frame. Only Codex instance ids are accepted, and only a Success Exit counts as refreshed.
    This re-probes a snapshot only; it does not rotate the shared app-server.
    """
    import json as _json
    if instance_id not in CODEX_INSTANCE_IDS:
        raise HarnessError(f"refusing to refresh non-Codex instance {instance_id!r}")
    token = control_token()
    base = os.environ.get("T3_CONTROL_URL", "http://127.0.0.1:3773").rstrip("/")
    ws_url = base.replace("http", "ws", 1) + "/ws?orchestrationProtocol=2"
    request_id = os.urandom(6).hex()
    frame = _json.dumps({"_tag": "Request", "id": request_id, "tag": "server.refreshProviders",
                         "payload": {"instanceId": instance_id}, "headers": []})
    with WsClient(ws_url, {"authorization": f"Bearer {token}"}) as ws:
        ws.send_text(frame)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            msg = _json.loads(ws.recv_text())
            items = msg if isinstance(msg, list) else [msg]
            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("_tag") == "Ping":
                    ws.send_text(_json.dumps({"_tag": "Pong"}))
                    continue
                # Same as catalog-guard's client: the first Exit answers the one Request we sent.
                if item.get("_tag") == "Exit":
                    exit_ = item.get("exit") or {}
                    if exit_.get("_tag") != "Success":
                        raise HarnessError(f"server.refreshProviders failed: {exit_.get('_tag', 'unknown')}")
                    return
                if item.get("_tag") == "Defect":
                    raise HarnessError("server.refreshProviders defect")
    raise HarnessError("server.refreshProviders timed out")


# ---------- auto + before-release ----------

def notify(key: str, severity: str, text: str, source: str = "harness-cli") -> bool:
    """Send one Telegram notification. True only when the CLI exits 0 (the bridge accepted it).

    The Telegram CLI prints JSON and exits 1 on any failure, so the exit code is the signal.
    HARNESS_CLI_NOTIFY can stub it; tests use that.
    """
    cmd = notify_cmd().split() + ["--source", source, "--severity", severity, "--text", text, "--key", key]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def notified_before(key: str) -> bool:
    if not records_path().exists():
        return False
    for line in records_path().read_text(encoding="utf-8").splitlines():
        if line.strip() and json.loads(line).get("notifyKey") == key:
            return True
    return False


def auto(*, dry: bool = False) -> dict:
    """The daily job: discover -> stage -> canary -> promote Claude; Codex stops at pending.

    A candidate that fails is retried on the next run (the notice is deduplicated, the work is
    not). When Codex is pending and Abdullah's standing OK is recorded, it also tries the gated
    rotation; rotate_codex enforces the OK and the idle snapshot itself.
    """
    retry_pending_notices()
    report: dict = {"discover": discover()}
    outcome: dict = {}
    for tool in TOOLS:
        slot = load_state()[tool]  # reread: discover just saved the candidate
        candidate = slot.get("candidate")
        if not candidate or candidate == slot.get("current"):
            outcome[tool] = "up to date"
            continue
        key = f"harness-cli:{tool}:{candidate}"
        try:
            if not version_dir(tool, candidate).is_dir():
                stage(tool, candidate)
            verdict = canary(tool, candidate)
            if not verdict["passed"]:
                outcome[tool] = f"canary failed for {candidate}: {'; '.join(verdict['reasons'])}"
                notify_once(f"{key}:canary-failed", "error",
                            f"Harness CLI canary failed: {tool} {candidate}. "
                            f"{'; '.join(verdict['reasons'])}. Current pin unchanged.")
                continue
            promoted = promote(tool, candidate, queue_notice=True)
            outcome[tool] = promoted["status"]
            retry_pending_notices()
        except HarnessError as exc:
            outcome[tool] = f"stopped: {exc}"
            notify_once(f"{key}:stopped", "error", f"Harness CLI job stopped for {tool} {candidate}: {exc}")
    if load_state()["codex"].get("rotationPending"):
        report["codexRotation"] = rotate_codex(when_idle=True)
    report["outcome"] = outcome
    return report


def notify_once(key: str, severity: str, text: str) -> None:
    """Persist before attempting delivery, and retain failures for the next run."""
    if notified_before(key):
        return
    state = load_state()
    state.setdefault("pendingNotices", {}).setdefault(key, {"severity": severity, "text": text})
    save_state(state)
    retry_pending_notices()


def retry_pending_notices() -> None:
    state = load_state()
    pending = state.setdefault("pendingNotices", {})
    for key, notice in list(pending.items()):
        if notified_before(key) or notify(key, notice["severity"], notice["text"]):
            if not notified_before(key):
                append_record({"at": now_iso(), "action": "notify", "notifyKey": key,
                               "text": notice["text"], "result": "sent"})
            del pending[key]
            save_state(state)


def before_release() -> dict:
    """Discover, stage and canary both tools; print the pinned versions for the release."""
    report = discover()
    pins = {}
    for tool in TOOLS:
        candidate = report[tool]["latest"]
        if not version_dir(tool, candidate).is_dir():
            stage(tool, candidate)
        verdict = canary(tool, candidate)
        pins[tool] = {"version": candidate, "passed": verdict["passed"], "reasons": verdict["reasons"]}
    return pins


# ---------- status ----------

def status() -> dict:
    state = load_state()
    out = {}
    for tool in TOOLS:
        slot = state[tool]
        link = current_link(tool)
        resolved = os.path.realpath(link) if link.is_symlink() else None
        out[tool] = {"current": slot.get("current"), "resolved": resolved,
                     "lastKnownGood": slot.get("lastKnownGood"), "candidate": slot.get("candidate"),
                     "rotationPending": slot.get("rotationPending", False),
                     "checkedAt": slot.get("checkedAt")}
    out["autoRotateCodex"] = bool(state.get("autoRotateCodex"))
    return out


# ---------- CLI ----------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("discover")
    p = sub.add_parser("stage")
    p.add_argument("tool", choices=sorted(TOOLS))
    p.add_argument("version")
    p = sub.add_parser("canary")
    p.add_argument("tool", choices=sorted(TOOLS))
    p.add_argument("version")
    p = sub.add_parser("promote")
    p.add_argument("tool", choices=sorted(TOOLS))
    p.add_argument("version")
    p = sub.add_parser("rollback")
    p.add_argument("tool", choices=sorted(TOOLS))
    sub.add_parser("status")
    p = sub.add_parser("rotate-codex")
    p.add_argument("--when-idle", action="store_true")
    sub.add_parser("auto")
    parser.add_argument("--before-release", action="store_true",
                        help="discover + stage + canary both tools and print the pins")
    return parser


LOCKED_COMMANDS = {"discover", "stage", "canary", "promote", "rollback", "rotate-codex", "auto"}


class StateLock:
    """One advisory lock for every command that changes pins, state or records.

    Without it the daily job and a manual promote or rollback can interleave and leave `current`,
    `state.current` and `lastKnownGood` disagreeing. Read-only commands (status) take no lock.
    """

    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def __enter__(self):
        import fcntl
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "a+", encoding="utf-8")
        try:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.handle.close()
            raise HarnessError("another harness-cli job holds the lock; try again later") from exc
        return self

    def __exit__(self, *exc):
        import fcntl
        if self.handle:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            self.handle.close()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.before_release or args.cmd in LOCKED_COMMANDS:
        try:
            with StateLock(root() / "lock"):
                reconcile_transition()
                return _dispatch(args)
        except HarnessError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    try:
        return _dispatch(args)
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _dispatch(args) -> int:
    try:
        if args.before_release:
            pins = before_release()
            print(json.dumps(pins, indent=2, sort_keys=True))
            # A failed canary in either tool fails the release gate, so the release chain stops.
            return 0 if all(pin["passed"] for pin in pins.values()) else 1
        if args.cmd == "discover":
            print(json.dumps(discover(), indent=2, sort_keys=True))
        elif args.cmd == "stage":
            print(json.dumps(stage(args.tool, args.version), indent=2, sort_keys=True))
        elif args.cmd == "canary":
            verdict = canary(args.tool, args.version)
            print(json.dumps(verdict, indent=2, sort_keys=True))
            return 0 if verdict["passed"] else 1
        elif args.cmd == "promote":
            print(json.dumps(promote(args.tool, args.version), indent=2, sort_keys=True))
        elif args.cmd == "rollback":
            print(json.dumps(rollback(args.tool), indent=2, sort_keys=True))
        elif args.cmd == "status":
            print(json.dumps(status(), indent=2, sort_keys=True))
        elif args.cmd == "rotate-codex":
            print(rotate_codex(when_idle=args.when_idle))
        elif args.cmd == "auto":
            print(json.dumps(auto(), indent=2, sort_keys=True))
        else:
            build_parser().print_help()
            return 2
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
