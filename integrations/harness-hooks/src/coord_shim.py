#!/usr/bin/env python3
"""PATH backstop for coordination guards; the Bash hook remains authoritative."""

import os
from pathlib import Path
import shlex
import sys
import time


BINARIES = {"aws", "psql", "fdbcli", "clickhouse-client", "terraform"}
REASON = "coord Haiku lane: this changes dev or reads a secret; hand the exact command to your Opus lead, who runs it under a coord claim."
HOME = Path.home()
LOCAL_BLOCKERS = Path(__file__).resolve().parent.parent / "coord-blockers"
INSTALLED_BLOCKERS = HOME / ".local/share/harness-hooks/coord-blockers"
LEGACY_BLOCKERS = HOME / ".config/opencode/scripts/coord-guard/blockers"


def _canonical(path):
    return os.path.realpath(os.fspath(path))


def _inside(path, directory):
    path, directory = _canonical(path), _canonical(directory)
    return path == directory or path.startswith(directory + os.sep)


def _blocker(candidate, directories, binary):
    if any(_inside(candidate, directory) for directory in directories):
        return True
    # A PATH entry can itself contain a symlink to one of the shims.
    target = _canonical(candidate)
    return any(target == _canonical(directory / binary) for directory in directories)


def _paths():
    return os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep)


def _legacy_path(binary):
    # The original shim knows only its old blocker directory. Remove the new
    # one before invoking it, otherwise its real-binary search recurses here.
    directories = (LOCAL_BLOCKERS, INSTALLED_BLOCKERS)
    paths = [path for path in _paths()
             if not _blocker(Path(path or ".") / binary, directories, binary)]
    if os.environ.get("AGENT_GUARD_SESSION") and not any(_canonical(p or ".") == _canonical(LEGACY_BLOCKERS) for p in paths):
        # The original shim passes PATH to its child; retain its backstop for
        # later nested commands even if only the new directory was present.
        paths.insert(0, str(LEGACY_BLOCKERS))
    return os.pathsep.join(paths)


def _real_binary(binary):
    directories = (LOCAL_BLOCKERS, INSTALLED_BLOCKERS, LEGACY_BLOCKERS)
    for path in _paths():
        candidate = Path(path or ".") / binary
        if _blocker(candidate, directories, binary):
            continue
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _warn(rule):
    # Never include command arguments or exception messages in diagnostics.
    print("coord guard: " + rule + "; allowing due to guard error", file=sys.stderr)


def _log_error(rule, harness=None, binary=None):
    try:
        source = os.environ.get("HARNESS_HOOKS_SRC")
        if source:
            sys.path.insert(0, source)
        import engine
        engine._log(harness=harness, event="shim", tool=binary,
                    decision="allow", rule=rule, error=rule)
    except Exception:
        pass


def _native():
    claude = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    codex = os.environ.get("CODEX_THREAD_ID", "")
    if claude and codex:
        # In nested CLIs both variables can be inherited; neither proves which
        # process owns the current call. Never attribute it to a guessed sibling.
        return None, None, "ambiguous-native-identity"
    if codex:
        return "codex", codex, None
    if claude:
        return "claude", claude, None
    marker = os.environ.get("ROBOB_HARNESS")
    if marker in ("claude", "codex"):
        return marker, None, "missing-native-identity"
    return None, None, None


def _check(binary, args, harness, native_id, event=None, *, ignore_pin=False):
    started = time.monotonic()
    # Tests can substitute an engine without touching a live configuration.
    source = os.environ.get("HARNESS_HOOKS_SRC")
    if source:
        sys.path.insert(0, source)
    import engine

    # Env-file approval is shared between sibling calls. The accepted token
    # comes only from this command's hook rewrite and is inherited by that
    # command's descendants, not installed by SessionStart.
    identity = engine.resolve_identity(event or {"session_id": native_id}, harness, fresh=True)
    pin = os.environ.get("HARNESS_COORD_APPROVED")
    if pin is None and not os.environ.get("AGENT_GUARD_SESSION"):
        # Older hook rewrites use the legacy spelling for one command.
        pin = os.environ.get("AGENT_GUARD_APPROVED", "")
    if ignore_pin:
        pin = None
    approved = bool(pin and engine.approval_valid(pin))
    command = shlex.join([binary, *args])
    result = engine.decide_coord(command, identity, os.getcwd(), approved=approved)
    if result.get("decision") not in ("allow", "deny") or not isinstance(result.get("context"), dict):
        raise ValueError("invalid coord result")
    try:
        engine._log(harness=harness, event="shim", tool=binary,
                    robobThreadId=identity.get("robobThreadId"), decision=result["decision"],
                    rule=result["context"].get("rule"),
                    error="coord-unresolved" if result["context"].get("rule") == "coord-unresolved" else None,
                    ms=round((time.monotonic() - started) * 1000, 3))
    except Exception:
        _warn("audit unavailable")
    if result["context"].get("rule") == "coord-unresolved":
        _warn("native identity or policy unresolved")
    if result["decision"] == "deny":
        print(result.get("reason") or REASON, file=sys.stderr)
        return False, approved
    return True, approved


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in BINARIES:
        print("coord guard: invalid wrapper invocation", file=sys.stderr)
        return 2
    binary, args = sys.argv[1], sys.argv[2:]
    harness, native_id, native_error = _native()
    context = None
    if os.environ.get("HARNESS_HOOKS_COMMAND_IDENTITY"):
        try:
            source = os.environ.get("HARNESS_HOOKS_SRC")
            if source:
                sys.path.insert(0, source)
            import engine
            context = engine.command_identity_from_env()
        except Exception:
            # A missing/broken hook installation must not block commands.
            pass
    if context:
        harness, event = context
        native_id, native_error = event.get("session_id"), None
    env = os.environ.copy()
    env.pop("BUN_INSPECT", None)
    if os.environ.get("HARNESS_HOOKS_COMMAND_IDENTITY") and not context:
        # Do not pass damaged or mismatched context on to nested wrappers.
        env.pop("HARNESS_HOOKS_COMMAND_IDENTITY", None)
        env.pop("AGENT_GUARD_APPROVED", None)
        env.pop("HARNESS_COORD_APPROVED", None)

    if native_error:
        _warn(native_error)
        _log_error(native_error, harness, binary)
        env.pop("AGENT_GUARD_SESSION", None)
        env.pop("AGENT_GUARD_APPROVED", None)
        env.pop("HARNESS_COORD_APPROVED", None)
    elif harness:
        try:
            invalid_context = bool(os.environ.get("HARNESS_HOOKS_COMMAND_IDENTITY") and not context)
            allowed, approved = _check(binary, args, harness, native_id, context[1] if context else None,
                                       ignore_pin=invalid_context)
            if not allowed:
                return 3
            # A stale OpenCode marker must not be carried into a native child.
            env.pop("AGENT_GUARD_SESSION", None)
            if not approved:
                env.pop("AGENT_GUARD_APPROVED", None)
                env.pop("HARNESS_COORD_APPROVED", None)
        except Exception:
            _warn("native check unavailable")
            _log_error("native-check-unavailable", harness, binary)
            env.pop("AGENT_GUARD_SESSION", None)
            env.pop("AGENT_GUARD_APPROVED", None)
            env.pop("HARNESS_COORD_APPROVED", None)
    elif os.environ.get("AGENT_GUARD_SESSION") or os.environ.get("OPENCODE_SESSION_ID"):
        bun = HOME / ".bun/bin/bun"
        shim = HOME / ".config/opencode/scripts/coord-guard/shim.ts"
        if os.access(bun, os.X_OK) and shim.is_file():
            env["PATH"] = _legacy_path(binary)
            try:
                os.execve(str(bun), [str(bun), str(shim), binary, *args], env)
            except OSError:
                pass
        _warn("OpenCode shim unavailable")

    real = _real_binary(binary)
    if not real:
        print(binary + ": command not found", file=sys.stderr)
        return 127
    try:
        os.execve(real, [real, *args], env)
    except OSError:
        print(binary + ": could not execute", file=sys.stderr)
        return 126


if __name__ == "__main__":
    sys.exit(main())
