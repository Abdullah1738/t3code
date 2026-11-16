"""Shared Claude/Codex policy. Offbox errors fail open; desktop admission
fails closed and local live-DB denials need no control service or identity.
No harness SDK is required.
"""
from __future__ import annotations

import datetime
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import random
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

import card_mask
import desktop_lease
import statev2_guard
import snapshot_guard
import quint_verify_guard
import rootwide_search_guard
import phone_adb_guard


import toollog

GATE_LIGHT_SAMPLE = 20


def _tool_log(**fields):
    try:
        props = fields.get("props", {})
        if (fields.get("kind") == "perf" and fields.get("ok") is True
                and props.get("decision") == "allowed" and props.get("commandClass") == "light"):
            if not random.random() < 1 / GATE_LIGHT_SAMPLE:
                return
            props["sample"] = GATE_LIGHT_SAMPLE
        from offbox_toollog import emit
        if props.get("harness") == "claude":
            props["harness"] = "claudeAgent"
        emit("gate", "gate.decision", **fields)
    except Exception:
        pass


HOME = Path.home()
BETTERSTACK_REASON = "Better Stack is restricted to CRPKO work. Open the relevant CRPKO project before using this MCP."
CRPKO_ROOTS = [
    "/Users/ardud/CrpkoArchitectureBroker", "/Volumes/ExternalSSD/CrpkoArchitectureBroker",
    "/Users/ardud/crpko-devops", "/Volumes/ExternalSSD/crpko-devops",
    "/Users/ardud/crpko-web-prototype", "/Users/ardud/crpko-mobile-prototype",
    "/Users/ardud/crpko-review", "/Users/ardud/crpko-worktrees",
    "/Users/ardud/crypko-frontend", "/Users/ardud/backoffice-core",
    "/Users/ardud/backoffice-frontend", "/Users/ardud/clickhouse-ingestor",
    "/Users/ardud/compliance-kyc", "/Users/ardud/custody-transfer", "/Users/ardud/edge-api",
    "/Users/ardud/foundationdb-explorer", "/Users/ardud/market-data-mock", "/Users/ardud/registry",
    "/Users/ardud/reporting", "/Users/ardud/rewards", "/Users/ardud/risk-liquidation",
    "/Users/ardud/trading-core", "/Users/ardud/venue-router-adapters-mock", "/Users/ardud/ws-gateway",
]


def _state():
    return Path(os.environ.get("HARNESS_HOOKS_STATE_DIR", str(HOME / ".local/state/harness-hooks")))


# The JSONL file is an audit trail, not a transcript. Untrusted event, tool,
# identity and classifier fields can themselves contain an entire command.
_LOG_EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "shim", "Stop", "SubagentStop", "SessionEnd"}
_LOG_TOOLS = {"Bash", "shell", "apply_patch", "aws", "psql", "fdbcli", "clickhouse-client", "terraform", "docker", "desktop-cua", "desktop-node-repl", "desktop-flush"}
_LOG_RULES = {
    "go-test", "go-build", "tsc-project", "eslint-repo", "pkg-run-check", "pkg-check-bare",
    "pytest", "js-test", "vp-test", "bun-test", "pkg-test", "pkg-run-test", "pkg-install", "yarn-bare",
    "docker-run", "docker-container-run", "docker-build", "docker-buildx-build", "docker-compose-up", "docker-compose-v1",
    "gradle", "cargo", "make-test", "forge-test", "anvil", "no-policy", "non-pre-tool", "betterstack-scope",
    "offbox-observe", "offbox-exempt", "offbox-unavailable", "offbox-unresolved", "hook-error",
    "session-export-error", "adapter-error", "ambiguous-native-identity", "missing-native-identity",
    "native-check-unavailable", "desktop-read-only", "desktop-admitted", "desktop-denied",
    "desktop-unavailable", "desktop-end", "desktop-end-error", "desktop-flush", "desktop-flush-none",
    "live-database-read", "live-database-script", "live-database-script-unresolved", "live-database-unavailable",
    "live-database-snapshot",
    "rootwide-search", "quint-verify", "card-mask",
    "phone-adb-state", "phone-adb-forward", "phone-adb-state-unleased", "phone-adb-forward-unleased", "phone-adb-unavailable",
}
_LOG_ERRORS = {
    "phone-lock-unavailable",
    "session-export-error", "adapter-error", "ambiguous-native-identity", "missing-native-identity",
    "identity-unavailable", "identity-pending", "identity-ambiguous", "TimeoutExpired",
    "ValueError", "TypeError", "OSError", "RuntimeError", "PermissionError", "FileNotFoundError",
    "TimeoutError", "ConnectionRefusedError", "HTTPError", "URLError", "JSONDecodeError", "CalledProcessError",
}


def _log_enum(value, allowed):
    return value if isinstance(value, str) and value in allowed else None if value is None else "other"


def _log(**record):
    try:
        rule = _log_enum(record.get("rule"), _LOG_RULES) or "no-policy"
        guard = ("statev2" if rule.startswith("live-database") else "betterstack-scope" if rule == "betterstack-scope"
                 else "phone-adb" if rule.startswith("phone-adb") else "quint-verify" if rule == "quint-verify" else "rootwide-search" if rule == "rootwide-search" else "offbox-gate" if rule.startswith("offbox") or rule in {
                     "go-test", "go-build", "tsc-project", "eslint-repo", "pkg-run-check", "pkg-check-bare",
                     "pytest", "js-test", "vp-test", "bun-test", "pkg-test", "pkg-run-test", "pkg-install", "yarn-bare",
                     "docker-run", "docker-container-run", "docker-build", "docker-buildx-build", "docker-compose-up", "docker-compose-v1",
                     "gradle", "cargo", "make-test", "forge-test", "anvil"}
                 else "desktop-lease" if rule.startswith("desktop") else "shell")
        harness = record.get("harness")
        if harness == "codex" and Path(os.environ.get("CODEX_HOME", "")).name == "codex-cu":
            harness = "codex-cu"
        decision = "denied" if record.get("decision") == "deny" else "rewritten" if record.get("rewritten") else "allowed"
        toollog.hook(harness, guard, decision, rule, record.get("ms", 0), record.get("command"),
                     _log_enum(record.get("error"), _LOG_ERRORS),
                     ids={"threadId": record.get("robobThreadId"), "sessionId": record.get("sessionId"),
                          "nativeAgentId": record.get("nativeAgentId"),
                          "cardNumber": record.get("cardNumber")}, cwd=record.get("cwd"), matched=record.get("matchedRoot"),
                     identity_source=_log_enum(record.get("identity_source"), {"cache", "control", "negative-cache"}))
        path = _state()
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        thread_id = record.get("robobThreadId")
        command = record.get("command")
        command_hmac = None
        audit_error = None
        if isinstance(command, str) and command:
            try:
                command_hmac = hmac.new(_command_identity_key(create=True), command.encode("utf-8"), hashlib.sha256).hexdigest()
            except UnicodeError:
                audit_error = "command-encoding-error"
            except (OSError, ValueError):
                # A damaged or inaccessible key must not change a policy decision.
                audit_error = "command-key-unavailable"
        row = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "event": _log_enum(record.get("event"), _LOG_EVENTS),
            "harness": _log_enum(record.get("harness"), {"claude", "codex"}),
            "tool": _log_enum(record.get("tool"), _LOG_TOOLS),
            "robobThreadId_sha256": hashlib.sha256(thread_id.encode("utf-8")).hexdigest() if isinstance(thread_id, str) and thread_id else None,
            "rule": _log_enum(record.get("rule"), _LOG_RULES),
            "decision": _log_enum(record.get("decision", "allow"), {"allow", "deny"}),
            "cmd_hmac_sha256": command_hmac,
            "cmd": None,
            "ms": record.get("ms") if type(record.get("ms")) in (int, float) else 0,
            "error": _log_enum(record.get("error"), _LOG_ERRORS),
            "identity_source": _log_enum(record.get("identity_source"), {"cache", "control", "negative-cache"}),
            "cause": record.get("cause")[:240] if record.get("rule") == "live-database-script-unresolved" and isinstance(record.get("cause"), str) else None,
            "audit_error": audit_error,
        }
        if guard == "desktop-lease":
            row.update(record.get("desktop_timing") or {})
            call_id = record.get("toolUseId")
            if isinstance(call_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", call_id):
                row["toolUseId"] = call_id
        fd = os.open(path / "decisions.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    except (OSError, UnicodeError):
        pass


def log_event_error(harness, event, rule, error):
    """Record an adapter-side failure even when there is no usable event."""
    _log(harness=harness, event=event, decision="allow", rule=rule, error=error)


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _control():
    override = os.environ.get("HARNESS_HOOKS_CONTROL_URL")
    token_file = Path(os.environ.get("HARNESS_HOOKS_TOKEN_FILE", str(HOME / ".robob/components/harness-hooks.json")))
    # Never send a real component credential to an overridden test endpoint
    # unless its credential file is also explicitly supplied.
    credentials = {}
    token_missing = False
    if not override or os.environ.get("HARNESS_HOOKS_TOKEN_FILE"):
        try:
            if token_file.stat().st_mode & 0o077:
                raise PermissionError("component credential permissions")
            credentials = _read_json(token_file, {})
        except FileNotFoundError:
            if not override:
                token_missing = True
    if token_missing:
        raise ValueError("control-credential-unavailable")
    if not isinstance(credentials, dict):
        credentials = {}
    base = override or credentials.get("url")
    if not isinstance(base, str) or not base:
        raise ValueError("control-unavailable")
    if not override and (not isinstance(credentials.get("token"), str) or not credentials["token"]):
        raise ValueError("control-credential-unavailable")
    # Component URLs normally include /api/ardud/control; localhost test servers
    # can supply either the host root or the full prefix.
    base = base.rstrip("/")
    if not urllib.parse.urlsplit(base).path:
        base += "/api/ardud/control"
    return base, credentials.get("token")


def _get(path, *, deadline=None, timeout=1.2):
    # urlopen's timeout bounds each socket read, not the total response; a
    # slow streaming control response could otherwise exhaust the hook's 10s.
    deadline = deadline if deadline is not None else time.monotonic() + timeout
    done = threading.Event()
    result = []

    def request():
        try:
            result.append((True, _get_unbounded(path, deadline, timeout=timeout)))
        except Exception as error:
            result.append((False, error))
        finally:
            done.set()

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("control-deadline")
    threading.Thread(target=request, daemon=True).start()
    if not done.wait(remaining):
        raise TimeoutError("control-deadline")
    success, value = result[0]
    if not success:
        raise value
    return value


def _get_unbounded(path, deadline, *, timeout=1.2):
    base, token = _control()
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(base + path, headers=headers)
    try:
        timeout = timeout if deadline is None else min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise TimeoutError("control-deadline")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise
    if not isinstance(data, dict) or data.get("ok") is False:
        raise ValueError("control-response")
    return data


def _native(event, harness):
    session = event.get("session_id")
    agent = event.get("agent_id")
    if harness in {"codex", "codex-cu"}:
        # The hook inherits the app-server's environment, not the tool shell's.
        # Only payload IDs identify the executing agent; shim fallbacks pass
        # CODEX_THREAD_ID explicitly as their synthetic event's session_id.
        return agent or session, None, "codex"
    return session, agent or None, "claudeAgent"


COMMAND_IDENTITY_ENV = "HARNESS_HOOKS_COMMAND_IDENTITY"


def _command_identity_key(*, create=False):
    """Publish a complete private key atomically when concurrent hooks first run."""
    directory = _state()
    path = directory / "command-identity.key"
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not path.exists():
            fd, tmp = tempfile.mkstemp(prefix="command-key-", dir=directory)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(secrets.token_bytes(32))
                try:
                    os.link(tmp, path)
                except FileExistsError:
                    pass
            finally:
                os.unlink(tmp)
    with open(path, "rb") as f:
        info = os.fstat(f.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError("command-key-permissions")
        key = f.read(33)
    if len(key) != 32:
        raise ValueError("command-key-invalid")
    return key


def _command_identity(event, harness):
    """Carry only native lookup inputs, never a cached model or exemption."""
    native, agent, _ = _native(event, harness)
    if not isinstance(native, str) or not native or "\x00" in native:
        return None
    if agent is not None and (not isinstance(agent, str) or not agent or "\x00" in agent):
        return None
    session = event.get("session_id")
    if not isinstance(session, str) or not session or "\x00" in session:
        return None
    data = {"v": 1, "harness": harness, "session": session,
            "native": native, "agent": agent,
            "instance": os.environ.get("HARNESS_HOOKS_PROVIDER_INSTANCE", "")}
    raw = json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(_command_identity_key(create=True), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return encoded + "." + signature


def command_identity_from_env():
    """Return (harness, lookup event), or None for missing/invalid context.

    The MAC catches damaged or accidentally inherited context, not a hostile
    same-user process. The hook scopes it to the command and its descendants.
    """
    try:
        value = os.environ.get(COMMAND_IDENTITY_ENV, "")
        if not value or len(value) > 16384:
            return None
        encoded, signature = value.split(".")
        expected = hmac.new(_command_identity_key(), encoded.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("v") != 1 or data.get("harness") not in ("claude", "codex"):
            return None
        harness = data["harness"]
        session, native, agent = data.get("session"), data.get("native"), data.get("agent")
        if not all(isinstance(x, str) and x and "\x00" not in x for x in (session, native)):
            return None
        if agent is not None and (not isinstance(agent, str) or not agent or "\x00" in agent):
            return None
        if data.get("instance") != os.environ.get("HARNESS_HOOKS_PROVIDER_INSTANCE", ""):
            return None
        if harness == "claude":
            current = os.environ.get("CLAUDE_CODE_SESSION_ID")
            if native != session or (current and current != session):
                return None
            event = {"session_id": session, "agent_id": agent}
        else:
            current = os.environ.get("CODEX_THREAD_ID")
            if current and current not in (session, native):
                return None
            # Codex's agent_id is the concrete native thread and outranks a
            # possibly parent-bound CODEX_THREAD_ID in resolve_identity.
            event = {"session_id": session, "agent_id": native}
        return harness, event
    except (OSError, ValueError, TypeError, UnicodeError):
        return None


def _command_needs_eval(command):
    """Heredocs need an EOF boundary before the wrapper's cleanup commands."""
    # Over-approximate: a heredoc body is not shell syntax, and punctuation
    # can join `<<` to other operators. Missing it can consume our cleanup.
    return "<<" in command


def _exit_trap_argument(snapshot):
    """Read the shell-quoted action from the first `trap` record, if EXIT."""
    prefix = "trap -- "
    if not snapshot.startswith(prefix):
        return None
    pos, quote = len(prefix), None
    start = pos
    while pos < len(snapshot):
        char = snapshot[pos]
        if quote == "'":
            if char == "'":
                quote = None
        elif quote in ('"', "ansi"):
            if char == "\\":
                pos += 1
            elif char == ('"' if quote == '"' else "'"):
                quote = None
        elif char == "\\":
            pos += 1
        elif char == "$" and snapshot[pos:pos + 2] == "$'":
            quote = "ansi"
            pos += 1
        elif char in ("'", '"'):
            quote = char
        elif char.isspace():
            break
        pos += 1
    if quote is not None or not snapshot.startswith(" EXIT\n", pos):
        return None
    return snapshot[start:pos]


def _exit_trap_update(path, before, identity):
    """Bind a changed EXIT trap to its registration context."""
    trap_file = Path(path)
    try:
        current = trap_file.read_text(encoding="utf-8")
        previous = Path(before).read_text(encoding="utf-8")
        function_file = Path(path + ".function")
        old_function_file = Path(before + ".function")
        function = function_file.read_text(encoding="utf-8") if function_file.exists() else ""
        old_function = old_function_file.read_text(encoding="utf-8") if old_function_file.exists() else ""
        variable = "__harness_exit_" + secrets.token_hex(8)
        values = {COMMAND_IDENTITY_ENV: identity or ""}
        exports = "; ".join("export " + k + "=" + shlex.quote(v) for k, v in values.items())
        if function:
            if function == old_function:
                return
            # zsh's TRAPEXIT is a function, not a `trap --` record. Copy it
            # before replacing it, and pass the signal argument and status on.
            saved = variable + "_function"
            sys.stdout.write("functions -c TRAPEXIT " + saved + "\nTRAPEXIT() {\nlocal " + variable +
                             "=$?; " + exports + "; (exit \"$" + variable + "\") && :; " +
                             saved + ' "$@"\n}\n')
            return
        argument = _exit_trap_argument(current)
        if argument is None or argument == _exit_trap_argument(previous):
            return
        # Let the shell decode its own trap representation, then splice the
        # action into the trap itself: an eval adds an extra ERR boundary.
        action_var = variable + "_action"
        prefix = variable + "=$?; " + exports + "; (exit \"$" + variable + "\") && :\n"
        sys.stdout.write(action_var + "=" + argument + "\ntrap -- " + shlex.quote(prefix) +
                         '"$' + action_var + '" EXIT\nunset ' + action_var + "\n")
    finally:
        for filename in (path, before, path + ".function", before + ".function"):
            try:
                Path(filename).unlink()
            except FileNotFoundError:
                pass


# The wrapper assumes a fresh top-level shell for each tool call. An existing
# ERR trap can fire twice; a top-level return skips cleanup only by ending the shell.
def _command_with_context(command, identity):
    """Scope exports to this execution without losing shell cwd changes."""
    name = "__harness_hook_" + secrets.token_hex(8)
    values = {COMMAND_IDENTITY_ENV: identity or ""}
    setup, cleanup, scratch = [], [], []
    for index, (key, value) in enumerate(values.items()):
        present, previous = name + "_p" + str(index), name + "_v" + str(index)
        scratch.extend([present, previous])
        setup.extend([present + "=${" + key + "+x}", previous + "=${" + key + "-}",
                      "export " + key + "=" + shlex.quote(value)])
        cleanup.append('if [ "${' + present + '-}" = x ]; then export ' + key + '="${' + previous + '-}"; else unset ' + key + "; fi")
    status = name + "_status"
    trap_file, before, install = (name + "_trapfile", name + "_before", name + "_install")
    scratch.extend([trap_file, before, install])
    # A group runs the original in the current shell (including positional
    # parameters, functions and cwd). eval preserves a heredoc's EOF boundary.
    # Restore inherited context before this shell can run another command.
    body = "eval " + shlex.quote(command) if _command_needs_eval(command) else command
    # zsh inherits TRAPEXIT in command substitutions, so clear it in the
    # helper subshells without changing the caller's handler.
    snapshot = (
        trap_file + "=$(trap - EXIT; mktemp \"${TMPDIR:-/tmp}/harness-exit.XXXXXXXX\")\n" +
        before + "=\"$" + trap_file + ".before\"\n" +
        "if [ -n \"$" + trap_file + "\" ]; then\ntrap > \"$" + before + "\"\n" +
        "if [ -n \"${ZSH_VERSION-}\" ]; then functions TRAPEXIT > \"$" + before + ".function\" || :; fi\nfi\n"
    )
    bind_exit = (
        "if [ -n \"$" + trap_file + "\" ]; then\ntrap > \"$" + trap_file + "\"\n" +
        "if [ -n \"${ZSH_VERSION-}\" ]; then functions TRAPEXIT > \"$" + trap_file + ".function\" || :; fi\n" +
        install + "=$(trap - EXIT; " + shlex.quote(sys.executable) + " " + shlex.quote(os.path.abspath(__file__)) +
        " --bind-exit \"$" + trap_file + "\" \"$" + before + "\" " +
        shlex.quote(identity or "") + ")\n" +
        "if [ -n \"$" + install + "\" ]; then eval \"$" + install + "\"; fi\nfi\n"
    )
    return ("{\n" + snapshot + "\n".join(setup) + "\n" + body + "\n" + status + "=$?\n" + bind_exit + "\n" + "\n".join(cleanup) +
            "\nunset " + " ".join(scratch) + "\neval 'unset " + status + "; (exit '" + '"$' + status + '"' + "')' && :\n}")


_IDENTITY_BINDING_TTL = 30 * 60
_IDENTITY_FALLBACK_TTL = 12 * 60 * 60
_IDENTITY_UNAVAILABLE_TTL = 30
_IDENTITY_LOOKUP_BUDGET = 4.5
_IDENTITY_CALL_TIMEOUT = 3.0


def _identity_transport_error(error):
    if isinstance(error, urllib.error.HTTPError):
        return 500 <= error.code < 600
    return isinstance(error, (TimeoutError, ConnectionError, urllib.error.URLError))


def _lookup_identity(path, harness, *, retry=True):
    # Leave room for the 3s classifier and 1.5s lineage walk in the 10s hook.
    deadline = time.monotonic() + _IDENTITY_LOOKUP_BUDGET
    for attempt in range(2):
        try:
            return _get(path, deadline=min(deadline, time.monotonic() + _IDENTITY_CALL_TIMEOUT),
                        timeout=_IDENTITY_CALL_TIMEOUT)
        except Exception as error:
            if not retry or attempt or not _identity_transport_error(error) or time.monotonic() >= deadline:
                raise


def _write_identity_state(path, value):
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="identity-", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(value, f)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    except OSError:
        pass


def resolve_identity(event, harness, *, fresh=False):
    """Resolve exact hook identity; cache binding-only lookups for 30 minutes.

    Claude children need the hook's agent_id. A shell with only the session id
    identifies the parent, not necessarily the shell's executing child.
    During transport outages native hooks can reuse a binding for 12h, but never
    its model for a fresh policy check. Authoritative misses invalidate the binding.
    """
    native, agent, driver = _native(event, harness)
    if not isinstance(native, str) or not native or (agent is not None and not isinstance(agent, str)):
        return {"resolution": "unavailable"}
    try:
        base, _ = _control()
        instance = os.environ.get("HARNESS_HOOKS_PROVIDER_INSTANCE", "")
        key = hashlib.sha256(json.dumps([base, driver, instance, native, agent], separators=(",", ":")).encode()).hexdigest()
        cache_file = _state() / "identity" / (key + ".json")
        unavailable_file = cache_file.with_suffix(".unavailable")
        cached = _read_json(cache_file, {})
        at = cached.get("at") if isinstance(cached, dict) else None
        age = time.time() - at if type(at) in (int, float) else float("inf")
        identity = cached.get("identity") if isinstance(cached, dict) else None
        valid_cache = (isinstance(identity, dict) and identity.get("resolution") == "resolved" and
                       bool(identity.get("robobThreadId")) and identity.get("nativeSessionId") == native and
                       identity.get("nativeAgentId") == agent and identity.get("driver") in (None, driver) and
                       (not instance or identity.get("providerInstanceId") in (None, instance)))
        if not fresh and 0 <= age < _IDENTITY_BINDING_TTL and valid_cache:
            binding = {**identity, "identity_source": "cache"}
            # Binding stability does not imply model-policy stability.
            if age >= 60:
                binding.pop("model", None)
            return binding
        fallback_cache = harness in {"claude", "codex", "codex-cu"} and valid_cache and 0 <= age < _IDENTITY_FALLBACK_TTL
        unavailable = _read_json(unavailable_file, {})
        failed_at = unavailable.get("at") if isinstance(unavailable, dict) else None
        if not fallback_cache and type(failed_at) in (int, float) and 0 <= time.time() - failed_at < _IDENTITY_UNAVAILABLE_TTL:
            return {"resolution": "unavailable", "identity_source": "negative-cache"}
        params = {"nativeId": native, "driver": driver}
        if agent:
            params["agentId"] = agent
        if instance:
            params["instance"] = instance
        try:
            resolved = _lookup_identity("/identity/resolve?" + urllib.parse.urlencode(params), harness,
                                        retry=not fallback_cache).get("identity")
        except Exception as error:
            fallback_age = time.time() - at if type(at) in (int, float) else float("inf")
            if _identity_transport_error(error):
                if fallback_cache and 0 <= fallback_age < _IDENTITY_FALLBACK_TTL:
                    binding = {**identity, "identity_source": "cache"}
                    binding.pop("model", None)
                    return binding
                _write_identity_state(unavailable_file, {"at": time.time()})
            raise
        if not isinstance(resolved, dict):
            raise ValueError("identity-response")
        identity = dict(resolved)
        if identity.get("resolution") == "resolved":
            identity.setdefault("nativeSessionId", native)
            identity.setdefault("nativeAgentId", agent)
            if identity["nativeSessionId"] != native or identity["nativeAgentId"] != agent:
                raise ValueError("identity-native-mismatch")
        if identity.get("resolution") == "resolved" and identity.get("driver") not in (None, driver):
            raise ValueError("identity-driver-mismatch")
        if identity.get("resolution") == "resolved" and instance and identity.get("providerInstanceId") not in (None, instance):
            raise ValueError("identity-instance-mismatch")
        try:
            unavailable_file.unlink(missing_ok=True)
        except OSError:
            pass
        if identity.get("resolution") == "resolved" and identity.get("robobThreadId"):
            _write_identity_state(cache_file, {"at": time.time(), "identity": identity})
        else:
            cache_file.unlink(missing_ok=True)
        return {**identity, "identity_source": "control"}
    except Exception:
        return {"resolution": "unavailable"}


_LINEAGE_MAX_PARENTS = 64
_LINEAGE_TIMEOUT = 1.5


def _lineage(identity, *, deadline=None):
    """Return self and proven parents, never root or sibling guesses."""
    if identity.get("resolution") != "resolved" or not identity.get("robobThreadId"):
        raise ValueError("identity-unresolved")
    nodes = [{"threadId": identity["robobThreadId"],
              "nativeSessionId": identity.get("nativeSessionId") if not identity.get("nativeAgentId") else None}]
    seen = {identity["robobThreadId"]}
    parent = identity.get("parentThreadId")
    native = identity.get("nativeSessionId")
    agent = identity.get("nativeAgentId")
    instance = identity.get("providerInstanceId")
    driver = identity.get("driver")
    native_chain = driver == "claudeAgent" and bool(agent)
    owner_agent = identity.get("parentNativeAgentId")
    native_owner_thread = identity.get("nativeOwnerThreadId")
    if native_chain and (not isinstance(native, str) or not native or
                         not isinstance(instance, str) or not instance or
                         not isinstance(native_owner_thread, str) or not native_owner_thread or
                         "parentNativeAgentId" not in identity):
        raise ValueError("lineage-native-unresolved")
    seen_agents = {agent} if native_chain else set()
    deadline = deadline if deadline is not None else time.monotonic() + _LINEAGE_TIMEOUT
    while parent:
        if len(seen) > _LINEAGE_MAX_PARENTS or time.monotonic() >= deadline:
            raise ValueError("lineage-limit")
        if not isinstance(parent, str) or parent in seen:
            raise ValueError("lineage-cycle")
        seen.add(parent)
        if native_chain and owner_agent is not None:
            if not isinstance(owner_agent, str) or not owner_agent or owner_agent in seen_agents:
                raise ValueError("lineage-native-cycle")
            seen_agents.add(owner_agent)
            params = {"nativeId": native, "driver": driver, "instance": instance, "agentId": owner_agent}
            owner = _get("/identity/resolve?" + urllib.parse.urlencode(params), deadline=deadline).get("identity")
            if (not isinstance(owner, dict) or owner.get("resolution") != "resolved" or
                owner.get("robobThreadId") != parent or owner.get("driver") != driver or
                owner.get("providerInstanceId") != instance or owner.get("nativeSessionId") != native or
                owner.get("nativeAgentId") != owner_agent or owner.get("nativeOwnerThreadId") != native_owner_thread or
                "parentNativeAgentId" not in owner):
                raise ValueError("lineage-native-unresolved")
            data = {"threadId": parent, "nativeSessionId": None,
                    "parentThreadId": owner.get("parentThreadId")}
            owner_agent = owner.get("parentNativeAgentId")
        else:
            if native_chain and parent != native_owner_thread:
                raise ValueError("lineage-native-unresolved")
            native_chain = False
            data = _get("/threads/" + urllib.parse.quote(parent, safe=""), deadline=deadline).get("thread")
        if not isinstance(data, dict) or data.get("threadId") != parent:
            raise ValueError("lineage-unresolved")
        nodes.append(data)
        parent = data.get("parentThreadId")
    if native_chain:
        raise ValueError("lineage-native-unresolved")
    return nodes


def _offbox_mode():
    mode = os.environ.get("OFFBOX_GATE_MODE")
    if mode in ("off", "observe", "enforce"):
        return mode
    config = _read_json(os.environ.get("OFFBOX_GATE_CONFIG", str(HOME / ".config/opencode/offbox-gate.json")), {})
    mode = config.get("mode") if isinstance(config, dict) else None
    return mode if mode in ("off", "enforce") else "observe"


def _offbox_state():
    return Path(os.environ.get("OFFBOX_STATE_DIR", str(HOME / ".local/share/offbox")))


def _expires(value):
    if not value:
        return float("inf")
    try:
        return float(value)
    except (TypeError, ValueError):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError):
            return 0


def _exempt(identity, *, lineage=None):
    entries = _read_json(_offbox_state() / "exemptions.json", [])
    if not isinstance(entries, list):
        return False
    entries = [entry for entry in entries if isinstance(entry, dict) and
               (entry.get("thread_id") or entry.get("session_id")) and
               _expires(entry.get("expires_at")) > time.time()]
    if not entries:
        return False
    nodes = lineage() if lineage else _lineage(identity)
    for entry in entries:
        # If a record carries a thread, its native session can be shared by
        # siblings and is not independent authority.
        if entry.get("thread_id"):
            if any(n.get("threadId") == entry["thread_id"] for n in nodes):
                return True
        elif entry.get("session_id") and any(n.get("nativeSessionId") == entry["session_id"] for n in nodes):
            return True
    return False


def _classify_offbox(command, cwd):
    classifier = os.environ.get("HARNESS_HOOKS_CLASSIFIER", str(HOME / ".config/opencode/skills/remote-compute/scripts/classify.py"))
    result = subprocess.run([sys.executable, classifier, "--batch"], input=json.dumps({"cmd": command, "cwd": cwd}) + "\n", capture_output=True, text=True, timeout=3, check=True)
    lines = result.stdout.splitlines()
    verdict = json.loads(lines[0]) if len(lines) == 1 else None
    if not isinstance(verdict, dict) or not isinstance(verdict.get("heavy"), bool) or verdict.get("error"):
        raise ValueError("classifier-response")
    if verdict["heavy"] and not all(isinstance(verdict.get(k), str) and verdict[k] for k in ("why", "rule", "rewrite")):
        raise ValueError("classifier-response")
    return verdict


def _offbox_available():
    override = os.environ.get("HARNESS_HOOKS_OFFBOX_BIN")
    bins = [Path(override)] if override else [HOME / ".local/bin/offbox", HOME / ".config/opencode/skills/remote-compute/scripts/offbox.py"]
    return any(p.exists() for p in bins)


def _offbox_denial(v):
    return "\n".join([
        "offbox gate: this command was NOT run on the Mac (owner rule 2026-10-13, remote-compute skill).",
        f"Why: {v['why']} [rule {v['rule']}].",
        "Run it on a boat.dev box instead (same repo dir, output streams back, same exit code):",
        "  " + v["rewrite"],
        "Narrow single tests stay local (go test -run X ./pkg, jest path/file.test.ts, pytest path::test).",
        'Only if it truly must run here (e.g. needs local creds/devices): offbox local --reason "<why>" [--ttl 2h], then rerun.',
    ])


def _betterstack_directory(cwd):
    if not isinstance(cwd, str) or not cwd:
        return False
    for root in CRPKO_ROOTS:
        if cwd == root or cwd.startswith(root + "/") or cwd.startswith(root + "-"):
            return True
    return False


def _command(event):
    tool = event.get("tool_name", "")
    value = event.get("tool_input")
    if not isinstance(tool, str) or not isinstance(value, dict):
        return None
    if tool in {"Bash", "bash", "shell", "exec_command", "shell_command"}:
        command = value.get("command") or value.get("cmd")
    elif re.fullmatch(r"mcp__.+?__(?:exec_command|shell_command|shell|bash)", tool):
        command = value.get("command") or value.get("cmd")
    else:
        return None
    return command if isinstance(command, str) and command else None


def _shell_input_field(event, harness):
    """Only rewrite an unambiguous shell string, using its original field."""
    tool, value = event.get("tool_name", ""), event.get("tool_input")
    if not isinstance(tool, str) or not isinstance(value, dict):
        return None
    if tool in {"Bash", "bash", "shell", "exec_command", "shell_command"} or re.fullmatch(r"mcp__.+?__(?:exec_command|shell_command|shell|bash)", tool):
        fields = [field for field in ("command", "cmd") if field in value]
        if len(fields) == 1 and isinstance(value[fields[0]], str):
            return fields[0]
    return None


def decide(event, harness):
    """Return {decision, reason, context}; JSONL-log every call, including failures."""
    desktop_timing = {}
    start = time.monotonic()
    command = None
    identity = {}
    error_type = None
    log_tool = None
    binding_only = False
    cwd = None
    matched_root = None
    result = {"decision": "allow", "reason": "", "context": {"rule": "no-policy"}}
    lineage_nodes = None
    lineage_deadline = None

    def lineage():
        nonlocal lineage_nodes, lineage_deadline
        if lineage_nodes is None:
            if lineage_deadline is None:
                lineage_deadline = time.monotonic() + _LINEAGE_TIMEOUT
            lineage_nodes = _lineage(identity, deadline=lineage_deadline)
        return lineage_nodes

    try:
        if not isinstance(event, dict) or harness not in {"claude", "codex"}:
            raise ValueError("invalid-event")
        tool, cwd = event.get("tool_name", ""), event.get("cwd")
        kind = event.get("hook_event_name")
        if desktop_lease.matches(tool) and kind in {"PreToolUse", "PostToolUse", "PostToolUseFailure"}:
            log_tool = "desktop-node-repl" if tool == desktop_lease.NODE_REPL else "desktop-cua"
            # This policy must not enter the general engine's fail-open identity path.
            try:
                if kind == "PreToolUse":
                    decision, reason, rule, error_type = desktop_lease.admit(event, harness, _control, _state(), desktop_timing)
                else:
                    rule, error_type = desktop_lease.finish(event, harness, _control, _state(), desktop_timing)
                    decision, reason = "allow", ""
                result = {"decision": decision, "reason": reason, "context": {"rule": rule}}
            except Exception as error:
                error_type = type(error).__name__
                result = {"decision": "deny" if kind == "PreToolUse" else "allow",
                          "reason": desktop_lease.UNAVAILABLE if kind == "PreToolUse" else "",
                          "context": {"rule": "desktop-unavailable"}}
            return result
        if kind in desktop_lease.TURN_END:
            log_tool = "desktop-flush"
            rule, error_type = desktop_lease.flush(event, harness, _control, _state())
            result = {"decision": "allow", "reason": "", "context": {"rule": rule}}
            return result
        command = _command(event) if kind == "PreToolUse" else None
        if command:
            inp = event.get("tool_input", {})
            command_cwd = inp.get("workdir") or inp.get("cwd") or cwd or os.getcwd()
            cwd = command_cwd
            try:
                phone = phone_adb_guard.classify(command)
            except Exception:
                # A phone-parser failure must not bypass the independent
                # search, database or offbox guards below.
                phone = {"matched": False, "reason": None, "rule": "phone-adb-unavailable", "error": "phone-lock-unavailable"}
            if phone['reason']:
                error_type = phone['error']
                result = {"decision": "deny", "reason": phone['reason'], "context": {"rule": phone['rule']}}
                return result
            if phone['matched'] or phone['error']:
                # Admission continues through the independent guards. Keep a
                # separate phone decision so unleased calls remain countable.
                _log(harness=harness, event=kind, tool=tool, command=command, cwd=cwd,
                     rule=phone['rule'], decision="allow", error=phone['error'])
            if quint_verify_guard.classify(command, command_cwd):
                result = {"decision": "deny", "reason": quint_verify_guard.REASON,
                          "context": {"rule": "quint-verify"}}
                return result
            try:
                root = rootwide_search_guard.classify(command, command_cwd)
            except Exception as error:
                # A search-parser failure must not disable the independent DB,
                # offbox policy later in this hook.
                error_type = type(error).__name__
                root = None
            if root:
                matched_root = root
                result = {"decision": "deny", "reason": rootwide_search_guard.reason(root, command_cwd),
                          "context": {"rule": "rootwide-search"}}
                return result
            # The live DB rule is independent of native identity and offbox
            # availability, so a service outage cannot disable this local check.
            try:
                if snapshot_guard.exact_invocation(command, command_cwd):
                    result = {"decision": "allow", "reason": "",
                              "context": {"rule": "live-database-snapshot"}}
                    return result
                hit, cause = statev2_guard.classify_detail(command, command_cwd)
                if not hit and snapshot_guard.snapshot_attempt(command, command_cwd):
                    hit, cause = "live-database-snapshot", "Snapshot requests require the exact installed, pinned helper invocation."
            except Exception as error:
                error_type = type(error).__name__
                result = {"decision": "deny", "reason": "Live database guard unavailable; this shell command was NOT run. Retry after the guard is available; do not bypass it.",
                          "context": {"rule": "live-database-unavailable"}}
                return result
            if hit:
                reason = statev2_guard.refusal_reason(hit, cause, command_cwd)
                context = {"rule": hit}
                if cause:
                    context["cause"] = cause
                result = {"decision": "deny", "reason": reason, "context": context}
                return result
        if kind == "PostToolUse":
            result["context"]["rule"] = "non-pre-tool"
            return result
        native, _, _ = _native(event, harness)
        if native:
            # Shell calls need only the binding used to sign command context.
            binding_only = (kind == "PreToolUse" and
                            _shell_input_field(event, harness) and _command(event))
            identity = resolve_identity(event, harness, fresh=not binding_only)
            if identity.get("resolution") != "resolved":
                error_type = "identity-" + str(identity.get("resolution", "unavailable"))
        if event.get("hook_event_name") != "PreToolUse":
            result["context"]["rule"] = "non-pre-tool"
        elif isinstance(tool, str) and (tool.startswith("mcp__betterstack__") or tool.startswith("betterstack_")):
            result = {"decision": "allow" if _betterstack_directory(cwd) else "deny", "reason": "" if _betterstack_directory(cwd) else BETTERSTACK_REASON, "context": {"rule": "betterstack-scope"}}
        else:
            command = _command(event)
            if command:
                inp = event.get("tool_input", {})
                shell_field = _shell_input_field(event, harness)
                cwd = inp.get("workdir") or inp.get("cwd") or cwd or os.getcwd()
                mode = _offbox_mode()
                if mode == "off":
                    _tool_log(ok=True, props={"harness": harness, "decision": "allowed", "commandClass": "unknown"})
                if mode != "off":
                    try:
                        started = time.monotonic()
                        verdict = _classify_offbox(command, cwd)
                        gate_decision = "allowed"
                        if verdict["heavy"]:
                            cap = _read_json(_offbox_state() / "cap.json", {})
                            available = _offbox_available() and not (isinstance(cap, dict) and cap.get("capped") is True)
                            if mode == "enforce" and available and identity.get("resolution") != "resolved":
                                raise ValueError("identity-unresolved")
                            exempt = _exempt(identity, lineage=lineage) if mode == "enforce" and available else False
                            if mode == "enforce" and available and not exempt:
                                gate_decision = "denied"
                                result = {"decision": "deny", "reason": _offbox_denial(verdict), "context": {"rule": verdict["rule"]}}
                            else:
                                gate_decision = "local-override" if exempt else "allowed"
                                result["context"]["rule"] = "offbox-observe" if mode == "observe" else "offbox-exempt" if exempt else "offbox-unavailable"
                        _tool_log(kind="perf", ok=True, duration_ms=(time.monotonic()-started)*1000,
                                  props={"harness": harness, "decision": gate_decision,
                                         "commandClass": verdict.get("class", "heavy") if verdict["heavy"] else "light"})
                    except Exception as error:
                        error_type = type(error).__name__
                        result["context"].update(rule="offbox-unresolved")
                        _tool_log(kind="error", ok=False, tag="gate_failed",
                                  props={"harness": harness, "decision": "allowed", "commandClass": "unknown"})
                if result["decision"] != "deny" and shell_field:
                    # Always refresh or clear this execution's context, even if
                    # the service is unavailable. Inherited tokens must not
                    # attribute a later nested hook call to its parent/sibling.
                    try:
                        token = None
                        if identity.get("resolution") == "resolved":
                            try:
                                token = _command_identity(event, harness)
                            except Exception as error:
                                error_type = type(error).__name__
                        if token or os.environ.get(COMMAND_IDENTITY_ENV):
                            updated = dict(inp)
                            updated[shell_field] = _command_with_context(command, token)
                            result["context"]["updatedInput"] = updated
                    except Exception as error:
                        error_type = type(error).__name__
    except Exception as error:
        error_type = type(error).__name__
        result = {"decision": "allow", "reason": "", "context": {"rule": "hook-error"}}
    finally:
        if (isinstance(event, dict) and event.get("hook_event_name") == "PostToolUse"
                and (harness == "claude" or str(event.get("tool_name", "")).startswith("mcp__"))):
            try:
                masked, changed = card_mask.mask_value(event.get("tool_response"))
                if changed:
                    result["context"]["updatedToolOutput"] = masked
                    result["context"]["rule"] = "card-mask"
            except Exception as error:
                # Fail open: retain the original result and never log its contents.
                result["context"]["rule"] = "card-mask"
                error_type = type(error).__name__
        _log(harness=harness, event=event.get("hook_event_name") if isinstance(event, dict) else None,
             tool=log_tool or (event.get("tool_name") if isinstance(event, dict) else None),
             robobThreadId=identity.get("robobThreadId"), decision=result["decision"], rule=result["context"].get("rule"),
             identity_source=identity.get("identity_source"), cause=result["context"].get("cause"), desktop_timing=desktop_timing,
             toolUseId=event.get("tool_use_id") if isinstance(event, dict) else None,
             sessionId=_native(event, harness)[0] if isinstance(event, dict) else None,
             nativeAgentId=event.get("agent_id") if harness == "claude" and isinstance(event, dict) else None,
             cardNumber=identity.get("cardNumber"), cwd=cwd, matchedRoot=matched_root,
             command=command, rewritten="updatedInput" in result["context"] or "updatedToolOutput" in result["context"], ms=round((time.monotonic() - start) * 1000, 3), error=error_type)
    return result


if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "--bind-exit":
    _exit_trap_update(*sys.argv[2:])
