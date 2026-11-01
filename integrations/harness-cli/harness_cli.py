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
  rotate-codex [--when-idle]  refresh the Codex provider once it is safe (standing OK only)
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


def load_manifest_minimums() -> dict:
    """Minimum CLI versions from the fork's model-manifest.json (driver + per-model)."""
    manifest_path = Path(os.environ.get(
        "HARNESS_CLI_MODEL_MANIFEST",
        str(Path(__file__).resolve().parents[2] / "apps" / "server" / "src" / "provider" / "model-manifest.json")))
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


def binary_version(binary: Path, tool: str) -> str:
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path(tempfile.gettempdir())),
           "LANG": "en_US.UTF-8"}
    proc = subprocess.run([str(binary), *TOOLS[tool]["version_flag"]], env=env, capture_output=True,
                          text=True, timeout=60)
    m = re.search(TOOLS[tool]["version_regex"], proc.stdout + proc.stderr, re.M)
    if not m:
        raise HarnessError(f"{tool} --version printed no version")
    return m.group(1)


# ---------- canary ----------

class Recorder:
    """A tiny localhost proxy that forwards to 9router and keeps every request body."""

    def __init__(self, upstream: str, key: str):
        if not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", upstream):
            raise HarnessError("canary proxy may only forward to a loopback 9router address")
        self.upstream = upstream
        self.key = key
        self.bodies: list[bytes] = []
        self.paths: list[str] = []
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
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in ("host", "content-length", "authorization", "x-api-key")}
                headers["x-api-key"] = recorder.key
                headers["authorization"] = f"Bearer {recorder.key}"
                req = urllib.request.Request(recorder.upstream + self.path, data=body, headers=headers,
                                             method="POST")
                try:
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        payload = resp.read()
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


def nine_router_key() -> str:
    key = os.environ.get("NINEROUTER_KEY", "")
    return key if key else "dummy"


def run_cli(binary: Path, args: list[str], *, env: dict, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary), *args], env=env, capture_output=True, text=True, timeout=timeout)


def make_throwaway_homes(work: Path) -> tuple[Path, Path]:
    """Generate both harness homes into a throwaway dir with the B1 generator."""
    gen = harness_homes_pkg() / "generate_homes.py"
    if not gen.is_file():
        raise HarnessError("harness-homes generator is not installed (card B1); cannot canary")
    env = dict(os.environ)
    env["HOME"] = str(work / "home")
    (work / "home").mkdir(parents=True, exist_ok=True)
    for sub in ("generate", "check"):
        proc = subprocess.run([python_bin(), str(gen), sub, "--home-root", str(work / "homes")], env=env,
                              capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise HarnessError(f"harness-homes {sub} failed on throwaway homes: "
                               f"{(proc.stdout + proc.stderr).strip().splitlines()[-1:]}")
    return work / "homes" / "claude", work / "homes" / "codex"


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


def canary_claude(binary: Path, version: str, work: Path, key_present: bool) -> dict:
    home = work / "claude-home"
    cdir = home / ".claude"
    homes_claude, _ = make_throwaway_homes(work / "gen")
    shutil.copytree(homes_claude, cdir, dirs_exist_ok=True)
    slug = "-" + str(work).replace("/", "-").lstrip("-")
    mem_dir = cdir / "projects" / slug / "memory"
    mem_dir.mkdir(parents=True, exist_ok=True)
    (mem_dir / "MEMORY.md").write_text(f"canary memory {CLAUDE_MEMORY_CANARY}\n", encoding="utf-8")
    recorder = Recorder(nine_router_url(), nine_router_key())
    base = recorder.start()
    results = {}
    try:
        env = claude_env(home, cdir, base)
        for model in MODEL_CANARIES["claude"]:
            routed = CLAUDE_MODEL_IDS.get(model, model)
            proc = run_cli(binary, ["-p", "Reply exactly OK.", "--model", routed, "--effort", "low",
                                    "--output-format", "text"], env=env, timeout=240)
            ok = proc.returncode == 0 and "OK" in proc.stdout
            results[model] = {"ok": ok, "stdoutLen": len(proc.stdout)}
        leaked = any(CLAUDE_MEMORY_CANARY.encode() in body for body in recorder.bodies)
        results["memoryCanaryLeaked"] = leaked
        results["memoryCanaryChecked"] = True
        results["requests"] = len(recorder.bodies)
    finally:
        recorder.stop()
    return results


def canary_codex(binary: Path, version: str, work: Path, key_present: bool) -> dict:
    home = work / "codex-home"
    chome = home / ".codex"
    _, homes_codex = make_throwaway_homes(work / "gen")
    shutil.copytree(homes_codex, chome, dirs_exist_ok=True)
    recorder = Recorder(nine_router_url(), nine_router_key())
    base = recorder.start()
    results = {}
    try:
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home), "CODEX_HOME": str(chome),
               "NINEROUTER_KEY": nine_router_key(), "NINEROUTER_BASE": base, "LANG": "en_US.UTF-8"}
        cfg = ["-c", f'model_providers.ninerouter.base_url="{base}/v1"']
        for model in MODEL_CANARIES["codex"]:
            proc = run_cli(binary, ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                                    "-m", model, *cfg, "Reply exactly OK."], env=env, timeout=240)
            ok = proc.returncode == 0 and "OK" in proc.stdout
            results[model] = {"ok": ok}
        made = [name for name in CODEX_MEMORY_DIRS if (chome / name).exists()]
        results["memoryArtifacts"] = made
        results["memoryPipelineRan"] = bool(made)
        results["memoryCanaryChecked"] = True
        results["requests"] = len(recorder.bodies)
    finally:
        recorder.stop()
    return results


def canary(tool: str, version: str) -> dict:
    if tool not in TOOLS:
        raise HarnessError(f"unknown tool {tool}")
    check_minimums(tool, version)
    binary = version_dir(tool, version) / "bin" / ("claude" if tool == "claude" else "codex")
    if not binary.is_file():
        raise HarnessError(f"{binary} not staged")
    if binary_version(binary, tool) != version:
        raise HarnessError(f"{binary} does not report {version}")
    work = Path(tempfile.mkdtemp(prefix=f"harness-cli-canary-{tool}-"))
    key_present = bool(os.environ.get("NINEROUTER_KEY"))
    try:
        if tool == "claude":
            result = canary_claude(binary, version, work, key_present)
            failed = [m for m in MODEL_CANARIES["claude"] if not result[m]["ok"]]
            memory_bad = result["memoryCanaryLeaked"]
        else:
            result = canary_codex(binary, version, work, key_present)
            failed = [m for m in MODEL_CANARIES["codex"] if not result[m]["ok"]]
            memory_bad = result["memoryPipelineRan"]
        passed = not failed and not memory_bad and result.get("requests", 0) > 0
        reason = []
        if failed:
            reason.append(f"model prompt failed: {', '.join(failed)}")
        if memory_bad:
            reason.append("memory-off canary failed (memory reached the model or the pipeline ran)")
        if result.get("requests", 0) == 0:
            reason.append("no request reached the recording proxy")
        digest = sha256_file(binary)
        write_record("canary", tool, version, "passed" if passed else "failed",
                     binarySha256=digest, canary=result, reasons=reason,
                     harnessHomes=harness_home_hashes(), keyPresent=key_present)
        return {"passed": passed, "reasons": reason, "result": result}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------- promote / rollback ----------

def swap_current(tool: str, version: str) -> None:
    link = current_link(tool)
    target = version_dir(tool, version)
    tmp = link.with_name(f".current.{os.getpid()}.tmp")
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(str(target), tmp)
    os.replace(tmp, link)  # atomic rename over the old symlink


def promote(tool: str, version: str) -> dict:
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
    swap_current(tool, version)
    slot["lastKnownGood"] = previous
    slot["current"] = version
    slot["candidate"] = None
    slot["promotedAt"] = now_iso()
    if tool == "codex":
        slot["rotationPending"] = True
        status = "promoted, rotation pending"
    else:
        slot["rotationPending"] = False
        status = "promoted"
    save_state(state)
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
    swap_current(tool, target)
    slot["current"] = target
    slot["lastKnownGood"] = previous
    slot["rotationPending"] = tool == "codex"
    save_state(state)
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
    memory_ok = canary_body.get("memoryCanaryChecked") is True and (
        canary_body.get("memoryCanaryLeaked") is False if tool == "claude"
        else canary_body.get("memoryPipelineRan") is False)
    return {
        "passed": found.get("result") == "passed" and memory_ok,
        "binarySha256": found.get("binarySha256"),
        "memoryCheckedAt": found.get("at") if memory_ok else None,
    }


# ---------- Codex rotation ----------

def rotate_codex(*, when_idle: bool, quiet_seconds: int = 300, checker=None, refresher=None,
                 sleep=time.sleep, clock=time.monotonic, max_wait_seconds: int = 1800) -> str:
    state = load_state()
    if not state["codex"].get("rotationPending"):
        return "no Codex rotation pending"
    if when_idle and not state.get("autoRotateCodex"):
        return "autoRotateCodex is off; Codex rotates only at the next Robob release (standing OK not recorded)"
    checker = checker or idle_snapshot
    try:
        idle_since = wait_for_idle(checker, quiet_seconds, sleep=sleep, clock=clock,
                                   max_wait_seconds=max_wait_seconds)
    except HarnessError as exc:
        return str(exc)
    refresher = refresher or refresh_codex_provider
    refresher()
    state["codex"]["rotationPending"] = False
    state["codex"]["rotatedAt"] = now_iso()
    save_state(state)
    write_record("rotate-codex", "codex", state["codex"].get("current"), "rotated",
                 idleSince=idle_since, harnessHomes=harness_home_hashes())
    return "Codex app-server refreshed onto the current binary"


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


def codex_busy(snapshot: dict) -> bool:
    """True when any Codex thread has a running run, held work or a pending request.

    The field names are the contract this job expects from card E7's recovery snapshot. E7 is
    not on ardud/main yet, so they are unverified: confirm them against E7 before the rotation
    is enabled. Until E7 ships the route is missing and rotation is skipped.
    """
    threads = snapshot.get("threads") or []
    for thread in threads:
        provider = (thread.get("provider") or thread.get("driver") or "").lower()
        if not provider.startswith("codex"):
            continue
        if thread.get("runningRun") or thread.get("heldWork") or thread.get("pendingRequest"):
            return True
    return False


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


def refresh_codex_provider() -> None:
    """WS RPC server.refreshProviders {instanceId}: re-probes the instance, no restart."""
    raise HarnessError("refreshProviders transport not wired in this build; rotation skipped")


# ---------- auto + before-release ----------

def notify(key: str, severity: str, text: str, source: str = "harness-cli") -> bool:
    """Send one Telegram notification. HARNESS_CLI_NOTIFY can stub it (tests use that)."""
    cmd = notify_cmd().split() + ["--source", source, "--severity", severity, "--text", text, "--key", key]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def notified_before(key: str) -> bool:
    if not records_path().exists():
        return False
    for line in records_path().read_text(encoding="utf-8").splitlines():
        if line.strip() and json.loads(line).get("notifyKey") == key:
            return True
    return False


def auto(*, dry: bool = False) -> dict:
    """The daily job: discover -> stage -> canary -> promote Claude; Codex stops at pending."""
    report = {"discover": discover()}
    outcome = {}
    for tool in TOOLS:
        slot = load_state()[tool]  # reread: discover just saved the candidate
        candidate = slot.get("candidate")
        if not candidate or candidate == slot.get("current"):
            outcome[tool] = "up to date"
            continue
        key = f"harness-cli:{tool}:{candidate}"
        if notified_before(key):
            outcome[tool] = f"{candidate} already handled"
            continue
        try:
            if not version_dir(tool, candidate).is_dir():
                stage(tool, candidate)
            verdict = canary(tool, candidate)
            if not verdict["passed"]:
                outcome[tool] = f"canary failed for {candidate}: {'; '.join(verdict['reasons'])}"
                notify_once(key, "error", f"Harness CLI canary failed: {tool} {candidate}. "
                            f"{'; '.join(verdict['reasons'])}. Current pin unchanged.")
                continue
            promoted = promote(tool, candidate)
            outcome[tool] = promoted["status"]
            notify_once(key, "info", f"Harness CLI: {tool} {candidate} {promoted['status']} "
                        f"(previous {promoted['previous']}).")
        except HarnessError as exc:
            outcome[tool] = f"stopped: {exc}"
            notify_once(key, "error", f"Harness CLI job stopped for {tool} {candidate}: {exc}")
    report["outcome"] = outcome
    return report


def notify_once(key: str, severity: str, text: str) -> None:
    if notified_before(key):
        return
    if notify(key, severity, text):
        append_record({"at": now_iso(), "action": "notify", "notifyKey": key, "text": text, "result": "sent"})


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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.before_release:
            print(json.dumps(before_release(), indent=2, sort_keys=True))
            return 0
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
