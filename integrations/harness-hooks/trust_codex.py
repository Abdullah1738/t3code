#!/opt/homebrew/bin/python3
"""Trust the hooks reported by a Codex binary for one explicitly supplied home."""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import math
import os
import selectors
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path


class TrustError(Exception):
    pass


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _toml_string(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(_toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{_toml_string(key)} = {_toml_value(item)}" for key, item in value.items()
        ) + " }"
    raise TrustError("unsupported value in existing hook state")


def _table_header(line: str) -> tuple[str, ...] | None:
    """Decode a single TOML table header, including quoted dotted keys."""
    if not line.lstrip().startswith("["):
        return None
    try:
        current = tomllib.loads(line)
    except tomllib.TOMLDecodeError:
        return None
    path = []
    while isinstance(current, dict) and len(current) == 1:
        key, current = next(iter(current.items()))
        path.append(key)
        if isinstance(current, list):
            if len(current) != 1:
                return None
            current = current[0]
    return tuple(path) if current == {} else None


def _same(left: object, right: object) -> bool:
    # NaN is a valid TOML value but is not equal to itself.
    if isinstance(left, float) and isinstance(right, float):
        return (math.isnan(left) and math.isnan(right)) or left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same(left[k], right[k]) for k in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def updated_config(original: bytes, declarations: dict[str, str]) -> bytes:
    """Replace only the hook-state tables; retain all other config text verbatim."""
    try:
        text = original.decode("utf-8")
        before = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise TrustError("config.toml is not valid UTF-8 TOML") from exc

    expected = copy.deepcopy(before)
    hooks = expected.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise TrustError("config.toml hooks is not a table")
    state = hooks.setdefault("state", {})
    if not isinstance(state, dict):
        raise TrustError("config.toml hooks.state is not a table")
    for key, current_hash in declarations.items():
        entry = state.setdefault(key, {})
        if not isinstance(entry, dict):
            raise TrustError("config.toml has an invalid hook state entry")
        entry["enabled"] = True
        entry["trusted_hash"] = current_hash

    if _same(expected, before):
        return original

    kept = []
    removing = False
    for line in text.splitlines(keepends=True):
        header = _table_header(line)
        if header is not None:
            removing = header[:2] == ("hooks", "state")
        if not removing:
            kept.append(line)
        elif line.lstrip().startswith("#") or not line.strip():
            # Keep comments and spacing even when replacing the state table.
            kept.append(line)

    rebuilt = "".join(kept)
    newline = "\r\n" if "\r\n" in text else "\n"
    if rebuilt and not rebuilt.endswith("\n"):
        rebuilt += newline
    for key, entry in state.items():
        if not isinstance(entry, dict):
            raise TrustError("config.toml has an invalid hook state entry")
        rebuilt += f"[hooks.state.{_toml_string(key)}]{newline}"
        for field, value in entry.items():
            rebuilt += f"{_toml_string(field)} = {_toml_value(value)}{newline}"

    # Reject inline/dotted layouts we cannot safely remove, and any accidental
    # interpretation of a multiline string as a table header, before writing.
    try:
        after = tomllib.loads(rebuilt)
    except tomllib.TOMLDecodeError as exc:
        raise TrustError("cannot preserve this config.toml hook-state layout") from exc
    if not _same(after, expected):
        raise TrustError("cannot preserve config.toml while updating hook state")
    return rebuilt.encode("utf-8")


def _atomic_replace(path: Path, data: bytes, mode: int) -> None:
    fd, name = tempfile.mkstemp(prefix=".config.toml.trust-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class AppServer:
    def __init__(self, binary: Path, home: Path, temp_dir: str):
        env = {
            "HOME": str(home),
            "CODEX_HOME": str(home),
            "PATH": os.environ.get("PATH", os.defpath),
            "TMPDIR": temp_dir,
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_STATE_HOME": str(home / ".local/state"),
        }
        for name in ("LANG", "LC_ALL", "LC_CTYPE"):
            if name in os.environ:
                env[name] = os.environ[name]
        self.process = subprocess.Popen(
            [str(binary), "app-server"], cwd=home, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        self.buffer = b""
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def __enter__(self) -> "AppServer":
        return self

    def __exit__(self, *_: object) -> None:
        self.selector.close()
        try:
            if self.process.stdin:
                try:
                    self.process.stdin.close()
                except BrokenPipeError:
                    pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired as exc:
                        raise TrustError("could not stop owned app-server") from exc
        finally:
            if self.process.stdout:
                self.process.stdout.close()

    def send(self, message: dict) -> None:
        assert self.process.stdin is not None
        # Codex's transport uses newline-delimited UTF-8 JSON, not LSP framing.
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", **message}) + "\n").encode("utf-8"))
        self.process.stdin.flush()

    def request(self, request_id: int, method: str, params: dict) -> object:
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + 30
        while True:
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self.selector.select(remaining):
                    raise TrustError(f"app-server timed out during {method}")
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise TrustError(f"app-server exited during {method}")
                self.buffer += chunk
                if len(self.buffer) > 16 * 1024 * 1024:
                    raise TrustError("app-server response exceeded size limit")
            line, self.buffer = self.buffer.split(b"\n", 1)
            try:
                message = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise TrustError("app-server sent invalid JSON") from exc
            if not isinstance(message, dict):
                raise TrustError("app-server sent an invalid message")
            if "method" in message:
                if "id" in message:
                    self.send({"id": message["id"], "error": {"code": -32601, "message": "Unsupported"}})
                continue
            if message.get("id") == request_id:
                if "error" in message or "result" not in message:
                    raise TrustError(f"app-server rejected {method}")
                return message["result"]


def list_hooks(binary: Path, home: Path, temp_dir: str) -> dict[str, dict]:
    with AppServer(binary, home, temp_dir) as server:
        server.request(1, "initialize", {
            "clientInfo": {"name": "harness-hook-trust", "version": "1.0"},
            "capabilities": {"experimentalApi": True},
        })
        server.send({"method": "initialized", "params": {}})
        result = server.request(2, "hooks/list", {"cwds": [str(home)]})

    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise TrustError("hooks/list returned an invalid result")
    entries = result["data"]
    if not entries or any(not isinstance(entry, dict) for entry in entries):
        raise TrustError("hooks/list returned an invalid cwd list")
    hooks = {}
    for listing in entries:
        if listing.get("cwd") != str(home) or listing.get("errors") != [] or not isinstance(listing.get("hooks"), list):
            raise TrustError("hooks/list returned the wrong cwd, errors, or an invalid hook list")
        for hook in listing["hooks"]:
            if not isinstance(hook, dict):
                raise TrustError("hooks/list returned an invalid hook")
            key, current_hash = hook.get("key"), hook.get("currentHash")
            if not isinstance(key, str) or not key or not isinstance(current_hash, str) or not current_hash:
                raise TrustError("hooks/list returned a hook without its key or currentHash")
            if hook.get("trustStatus") not in ("trusted", "untrusted", "modified"):
                raise TrustError("hooks/list returned a hook that cannot be provisioned as trusted")
            if key in hooks:
                raise TrustError("hooks/list returned duplicate hook keys")
            hooks[key] = hook
    if not hooks:
        raise TrustError("hooks/list returned no hooks; refusing vacuous trust")
    return hooks


def trust(binary: Path, home: Path) -> int:
    config = home / "config.toml"
    if not home.is_dir() or not config.is_file() or config.is_symlink():
        raise TrustError("home and a non-symlink config.toml must already exist")
    original = config.read_bytes()
    mode = stat.S_IMODE(config.stat().st_mode)

    # The list is authoritative only when this home actually opted into hooks.
    # Refuse to trust a partial/disabled declaration set.
    try:
        settings = tomllib.loads(original.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise TrustError("config.toml is not valid UTF-8 TOML") from exc
    features = settings.get("features")
    if not isinstance(features, dict) or features.get("hooks") is not True:
        raise TrustError("config.toml must explicitly enable features.hooks")

    with tempfile.TemporaryDirectory(prefix="codex-hook-trust-") as temp_dir:
        before = list_hooks(binary, home, temp_dir)
        declarations = {key: hook["currentHash"] for key, hook in before.items()}
        updated = updated_config(original, declarations)
        if config.is_symlink() or config.read_bytes() != original:
            raise TrustError("config.toml changed during enumeration; refusing to overwrite")
        if updated != original:
            _atomic_replace(config, updated, mode)
        try:
            after = list_hooks(binary, home, temp_dir)
            if set(after) != set(declarations) or any(
                hook["currentHash"] != declarations[key]
                or hook.get("trustStatus") != "trusted"
                or hook.get("enabled") is not True
                for key, hook in after.items()
            ):
                raise TrustError("hook list changed, or a hook is not enabled and trusted")
        except BaseException:
            # Never overwrite a concurrent edit when undoing a failed verification.
            if updated != original and not config.is_symlink() and config.read_bytes() == updated:
                _atomic_replace(config, original, mode)
            raise
    print(f"Trusted and verified {len(declarations)} Codex hook(s).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("codex_binary", help="path to the Codex executable")
    parser.add_argument("codex_home", help="path to the Codex home to provision")
    args = parser.parse_args(argv)
    try:
        binary = Path(args.codex_binary).expanduser().resolve(strict=True)
        home = Path(args.codex_home).expanduser().resolve(strict=True)
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise TrustError("Codex binary is not an executable file")
        return trust(binary, home)
    except (TrustError, OSError) as exc:
        # OSError strings may contain paths but never include file contents or credentials.
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
