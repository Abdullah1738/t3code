"""Shared Claude/Codex policy. Offbox/coord errors fail open; desktop admission
fails closed and local live-DB denials need no control service or identity.
No harness SDK is required.
"""
from __future__ import annotations

import datetime
from contextlib import closing
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

import desktop_lease
import statev2_guard
import rootwide_search_guard


HOME = Path.home()
BETTERSTACK_REASON = "Better Stack is restricted to CRPKO work. Open the relevant CRPKO project before using this MCP."
COORD_REASON = "coord Haiku lane: this changes dev or reads a secret; hand the exact command to your Opus lead, who runs it under a coord claim."
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
    "offbox-observe", "offbox-exempt", "offbox-unavailable", "offbox-unresolved", "coord-unresolved", "hook-error",
    "approved-sha256", "non-member", "excluded", "coord-haiku", "non-haiku", "database-direct", "secret-read",
    "aws-mutation", "clickhouse-http-write", "terraform-mutation", "coord-control", "github-write", "deploy-script",
    "force-push", "session-export-error", "adapter-error", "ambiguous-native-identity", "missing-native-identity",
    "native-check-unavailable", "desktop-read-only", "desktop-admitted", "desktop-denied",
    "desktop-unavailable", "desktop-end", "desktop-end-error", "desktop-flush", "desktop-flush-none",
    "live-database-read", "live-database-script", "live-database-script-unresolved", "live-database-unavailable",
    "rootwide-search",
}
_LOG_ERRORS = {
    "session-export-error", "adapter-error", "ambiguous-native-identity", "missing-native-identity",
    "identity-unavailable", "identity-pending", "identity-ambiguous", "coord-unresolved", "TimeoutExpired",
    "ValueError", "TypeError", "OSError", "RuntimeError", "PermissionError", "FileNotFoundError",
    "TimeoutError", "HTTPError", "URLError", "JSONDecodeError", "CalledProcessError",
}


def _log_enum(value, allowed):
    return value if isinstance(value, str) and value in allowed else None if value is None else "other"


def _log(**record):
    try:
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
            "identity_source": _log_enum(record.get("identity_source"), {"cache", "control"}),
            "cause": record.get("cause")[:240] if record.get("rule") == "live-database-script-unresolved" and isinstance(record.get("cause"), str) else None,
            "audit_error": audit_error,
        }
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
    if harness == "codex":
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


def _exit_trap_update(path, before, identity, pin):
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
        values = {COMMAND_IDENTITY_ENV: identity or "", "HARNESS_COORD_APPROVED": pin or "",
                  "AGENT_GUARD_APPROVED": pin or ""}
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
def _command_with_context(command, identity, pin):
    """Scope exports to this execution without losing shell cwd changes."""
    name = "__harness_hook_" + secrets.token_hex(8)
    values = {COMMAND_IDENTITY_ENV: identity or "", "HARNESS_COORD_APPROVED": pin or "",
              "AGENT_GUARD_APPROVED": pin or ""}
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
        shlex.quote(identity or "") + " " + shlex.quote(pin or "") + ")\n" +
        "if [ -n \"$" + install + "\" ]; then eval \"$" + install + "\"; fi\nfi\n"
    )
    return ("{\n" + snapshot + "\n".join(setup) + "\n" + body + "\n" + status + "=$?\n" + bind_exit + "\n" + "\n".join(cleanup) +
            "\nunset " + " ".join(scratch) + "\neval 'unset " + status + "; (exit '" + '"$' + status + '"' + "')' && :\n}")


_IDENTITY_BINDING_TTL = 30 * 60
_CLAUDE_IDENTITY_TTL = 12 * 60 * 60
_IDENTITY_LOOKUP_BUDGET = 4.5
_IDENTITY_CALL_TIMEOUT = 3.0


def _identity_transport_error(error):
    if isinstance(error, urllib.error.HTTPError):
        return 500 <= error.code < 600
    return isinstance(error, (TimeoutError, ConnectionError, urllib.error.URLError))


def _lookup_identity(path, harness):
    # Leave room for the 3s classifier and 1.5s lineage walk in the 10s hook.
    deadline = time.monotonic() + _IDENTITY_LOOKUP_BUDGET
    for attempt in range(2):
        try:
            return _get(path, deadline=min(deadline, time.monotonic() + _IDENTITY_CALL_TIMEOUT),
                        timeout=_IDENTITY_CALL_TIMEOUT)
        except Exception as error:
            if attempt or not _identity_transport_error(error) or time.monotonic() >= deadline:
                raise


def resolve_identity(event, harness, *, fresh=False):
    """Resolve exact hook identity; cache binding-only lookups for 30 minutes.

    Claude children need the hook's agent_id. A shell with only the session id
    identifies the parent, not necessarily the shell's executing child.
    During transport outages Claude can reuse a binding for 12h, but never its
    model for a fresh policy check. Authoritative misses invalidate the binding.
    """
    native, agent, driver = _native(event, harness)
    if not isinstance(native, str) or not native or (agent is not None and not isinstance(agent, str)):
        return {"resolution": "unavailable"}
    try:
        base, _ = _control()
        instance = os.environ.get("HARNESS_HOOKS_PROVIDER_INSTANCE", "")
        key = hashlib.sha256(json.dumps([base, driver, instance, native, agent], separators=(",", ":")).encode()).hexdigest()
        cache_file = _state() / "identity" / (key + ".json")
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
        params = {"nativeId": native, "driver": driver}
        if agent:
            params["agentId"] = agent
        if instance:
            params["instance"] = instance
        try:
            resolved = _lookup_identity("/identity/resolve?" + urllib.parse.urlencode(params), harness).get("identity")
        except Exception as error:
            fallback_age = time.time() - at if type(at) in (int, float) else float("inf")
            if harness == "claude" and _identity_transport_error(error) and valid_cache and 0 <= fallback_age < _CLAUDE_IDENTITY_TTL:
                binding = {**identity, "identity_source": "cache"}
                binding.pop("model", None)
                return binding
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
        if identity.get("resolution") == "resolved" and identity.get("robobThreadId"):
            try:
                cache_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix="identity-", dir=cache_file.parent)
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as f:
                        json.dump({"at": time.time(), "identity": identity}, f)
                    os.replace(tmp, cache_file)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
            except OSError:
                pass
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


# Port of coord-guard's bounded lexer. It intentionally does not evaluate shell.
def _parse(source):
    commands, substitutions, words, word, here = [], [], [], "", []
    active = False
    i, n = 0, len(source)

    def substitution(index, opening, closing):
        index += len(opening)
        start, depth, quote = index, 1, ""
        while index < n:
            c = source[index]
            if c == "\\":
                index += 2
                continue
            if quote:
                if c == quote:
                    quote = ""
            elif c in "'\"":
                quote = c
            else:
                if opening == "$(" and c == "(":
                    depth += 1
                if c == closing:
                    depth -= 1
                    if not depth:
                        break
            index += 1
        substitutions.append(source[start:index])
        return index + 1

    def flush():
        nonlocal word, active
        if active:
            words.append(word)
        word, active = "", False

    def end():
        nonlocal words
        flush()
        if words:
            commands.append(words)
        words = []

    while i < n:
        c = source[i]
        if c == "\\":
            if i + 1 < n and source[i + 1] != "\n":
                word += source[i + 1]
                active = True
            i += 2
        elif c in "'\"":
            quote, i, active = c, i + 1, True
            while i < n and source[i] != quote:
                if quote == '"' and source.startswith("$(", i):
                    i = substitution(i, "$(", ")")
                    word += "<substitution>"
                elif quote == '"' and source[i] == "`":
                    i = substitution(i, "`", "`")
                    word += "<substitution>"
                elif quote == '"' and source[i] == "\\" and i + 1 < n and source[i + 1] in '"\\$`\n':
                    i += 1
                    if source[i] != "\n":
                        word += source[i]
                    i += 1
                else:
                    word += source[i]
                    i += 1
            i += 1
        elif source.startswith("$(", i) or c == "`":
            opening, closing = ("$(", ")") if c == "$" else ("`", "`")
            i = substitution(i, opening, closing)
            word += "<substitution>"
            active = True
        elif c == "#" and not active:
            i = source.find("\n", i)
            if i < 0:
                break
        elif c == "\n":
            end()
            i += 1
            for target, tabs, expand in here:
                body = []
                while i < n:
                    j = source.find("\n", i)
                    if j < 0:
                        j = n
                    line, i = source[i:j], j + 1
                    if (line.lstrip("\t") if tabs else line) == target:
                        break
                    body.append(line)
                previous = commands[-1] if commands else []
                if re.fullmatch(r"(ba|z|da|k)?sh", os.path.basename(previous[0] if previous else "")):
                    substitutions.append("\n".join(body))
                elif expand:
                    substitutions.extend(_parse("\n".join(body))[1])
            here = []
        elif c.isspace():
            flush()
            i += 1
        elif c in ";&|(){}":
            end()
            i += 1
        elif c in "<>":
            flush()
            m = re.match(r"<<-|<<<|<<|>>|[<>]&?|&>", source[i:])
            op = m.group(0)
            i += len(op)
            while i < n and source[i] in " \t":
                i += 1
            target = re.match(r"(?:'([^']*)'|\"([^\"]*)\"|([^\s;&|<>]+))", source[i:])
            if target:
                if op in ("<<", "<<-"):
                    here.append((next(x for x in target.groups() if x is not None), op == "<<-", target.group(3) is not None))
                else:
                    substitutions.extend(_parse(target.group(0))[1])
                i += len(target.group(0))
        else:
            word += c
            active = True
            i += 1
    end()
    return commands, substitutions


_ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
_SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
_SKIP_VALUE = {"--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--cli-connect-timeout", "--cli-read-timeout", "--color", "--repo", "-R", "--hostname", "-C", "-c", "--git-dir", "--work-tree", "--as", "--env", "-chdir"}


def _unwrap(source):
    a = list(source)
    while a:
        if _ASSIGN.match(a[0]) or a[0] in {"if", "then", "else", "elif", "do", "while", "until", "!"}:
            a.pop(0)
            continue
        b = os.path.basename(a[0])
        if b in {"command", "exec", "nohup"}:
            a.pop(0)
            while a and a[0].startswith("-"):
                a.pop(0)
        elif b == "env":
            a.pop(0)
            while a and (a[0].startswith("-") or _ASSIGN.match(a[0])):
                opt = a.pop(0)
                if opt in {"-u", "--unset", "-C", "--chdir"} and a:
                    a.pop(0)
        elif b == "sudo":
            a.pop(0)
            while a and a[0].startswith("-"):
                opt = a.pop(0)
                if opt in {"-u", "-g", "-h"} and a:
                    a.pop(0)
        elif b == "timeout":
            a.pop(0)
            while a and a[0].startswith("-"):
                opt = a.pop(0)
                if opt in {"-s", "--signal", "-k", "--kill-after"} and a:
                    a.pop(0)
            if a:
                a.pop(0)
        else:
            break
    return a


def _positional(args):
    out, i = [], 0
    while i < len(args):
        if args[i] in _SKIP_VALUE:
            i += 2
        else:
            if not args[i].startswith("-"):
                out.append(args[i])
            i += 1
    return out


def classify_coord(source, depth=0):
    """Return the original coord-guard rule or None; never log arguments."""
    if depth > 12:
        return None
    commands, subs = _parse(source)
    for sub in subs:
        hit = classify_coord(sub, depth + 1)
        if hit:
            return hit
    for words in commands:
        a = _unwrap(words)
        if not a:
            continue
        binary, args = os.path.basename(a[0]), a[1:]
        p = _positional(args)
        first, second = (p + ["", ""])[:2]
        if binary in _SHELLS:
            if any(re.fullmatch(r"-[a-z]*n[a-z]*", x) for x in args):
                continue
            index = next((i for i, x in enumerate(args) if re.fullmatch(r"-[a-z]*c[a-z]*", x)), None)
            if index is not None:
                hit = classify_coord(args[index + 1] if index + 1 < len(args) else "", depth + 1)
                if hit:
                    return hit
                continue
        if binary == "eval":
            hit = classify_coord(" ".join(args), depth + 1)
            if hit:
                return hit
        if binary == "offbox" and first in {"ssh", "run"} and "--" in args:
            rest = args[args.index("--") + 1:]
            hit = classify_coord(rest[0] if len(rest) == 1 else " ".join(shlex.quote(x) for x in rest), depth + 1)
            if hit:
                return hit
        if binary in {"psql", "pg_dump", "pg_restore", "fdbcli", "clickhouse-client"}:
            return "database-direct"
        if binary == "aws":
            if (first == "logs" and second in {"start-query", "stop-query", "start-live-tail"}) or (first == "athena" and second in {"start-query-execution", "stop-query-execution"}):
                continue
            if first == "rds-data" or (first == "secretsmanager" and second == "get-secret-value") or (first == "ssm" and re.fullmatch(r"get-parameters?(?:-by-path)?", second) and "--with-decryption" in args):
                return "secret-read"
            if re.match(r"^(?:run|start|stop|create|delete|put|update|modify|register|deregister|attach|detach|send|invoke|tag|untag)(?:-|$)", second) or second == "execute-command":
                return "aws-mutation"
        if binary in {"curl", "wget"} and any(re.search(r":\b(?:8123|8443)(?:\b|/)", x) for x in args) and any(re.match(r"^(?:POST|--(?:data(?:-raw|-binary|-urlencode)?|json|post-data|post-file)(?:=|$)|-d|--request=POST|-XPOST)", x) for x in args):
            return "clickhouse-http-write"
        if binary == "terraform" and (first in {"apply", "destroy", "import"} or (first == "state" and second in {"push", "mv", "rm", "replace-provider"})):
            return "terraform-mutation"
        if binary == "coord" and first in {"claim", "release", "reconcile", "qa", "pause", "resume", "drain"}:
            return "coord-control"
        if binary == "gh" and ((first == "pr" and second == "merge") or (first == "workflow" and second == "run") or (first == "release" and second == "create") or (first == "api" and any(re.fullmatch(r"(?:-X|--method=)(?:POST|PUT|PATCH|DELETE)", x, re.I) or (x in {"-X", "--method"} and i + 1 < len(args) and re.fullmatch(r"POST|PUT|PATCH|DELETE", args[i + 1], re.I)) for i, x in enumerate(args)))):
            return "github-write"
        if binary == "npm" and first == "run" and re.match(r"^(deploy|runbook):", second):
            return "deploy-script"
        interpreter = bool(re.fullmatch(r"python[23]?|node|bun", binary))
        inline = interpreter and any(x in {"-e", "--eval", "-p", "--print", "-c", "--check", "--test"} for x in args)
        executable = "" if inline else first if binary in _SHELLS or interpreter else a[0]
        if re.search(r"(?:^|/)scripts/(?:deploy-[^/]+|runbooks/[^/]+)", executable):
            return "deploy-script"
        if binary == "git" and first == "push" and any(re.match(r"^(?:--force(?:-with-lease)?(?:=|$)|-f$)", x) for x in args):
            return "force-push"
    return None


def _allow_file():
    return Path(os.environ.get("HARNESS_HOOKS_COORD_ALLOW", str(HOME / ".config/opencode/agent-guard-allow.json")))


def _hash_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _resolve_path(cwd, path):
    if path.startswith("~/"):
        path = str(HOME) + path[1:]
    return os.path.abspath(os.path.join(cwd, path))


def approval(command, cwd):
    """Exact single invocation and pinned script/input, as in coord runtime.ts."""
    try:
        commands, subs = _parse(command)
        if len(commands) != 1 or subs:
            return None
        raw = commands[0]
        args = _unwrap(raw)
        if len(args) != len(raw):
            return None
        if args and re.fullmatch(r"(?:.*/)?(?:zsh|bash|sh)", args[0]):
            args.pop(0)
        if not args or "$" in args[0] or args[0].startswith("-") or len(args) > 3:
            return None
        path = _resolve_path(cwd, args[0])
        entries = _read_json(_allow_file(), {}).get("scripts", [])
        entry = next((e for e in entries if e.get("path") == path and e.get("sha256") == _hash_file(path)), None)
        if not entry:
            return None
        input_path = _resolve_path(cwd, args[1] if len(args) > 1 else "replica-health.sql")
        input_hash = _hash_file(input_path)
        if not any(i.get("path") == input_path and i.get("sha256") == input_hash for i in entry.get("inputs", [])):
            return None
        return json.dumps({"path": path, "sha256": entry["sha256"], "input": input_path, "inputSha256": input_hash}, separators=(",", ":"))
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def approval_valid(value):
    try:
        a = json.loads(value)
        entries = _read_json(_allow_file(), {}).get("scripts", [])
        return any(e.get("path") == a["path"] and e.get("sha256") == a["sha256"] == _hash_file(a["path"]) and any(i.get("path") == a["input"] and i.get("sha256") == a["inputSha256"] == _hash_file(a["input"]) for i in e.get("inputs", [])) for e in entries)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False


def _thread_key(value):
    return re.sub(r"^(?:ardud-control:thread:|mcp:)", "", value or "")


def _coord_state(identity, *, lineage=None):
    if identity.get("resolution") != "resolved" or not identity.get("robobThreadId"):
        raise ValueError("identity-unresolved")
    config = _read_json(os.environ.get("HARNESS_HOOKS_COORD_CONFIG", str(HOME / ".config/opencode/agent-guard.json")))
    if not isinstance(config, dict) or config.get("mode") not in {"enforce", "observe"}:
        raise ValueError("coord-config-unresolved")
    model = identity.get("model")
    model = model.get("model") or model.get("id") if isinstance(model, dict) else model
    if not isinstance(model, str) or not model:
        raise ValueError("model-unresolved")
    nodes = lineage() if lineage else _lineage(identity)
    db_path = os.environ.get("HARNESS_HOOKS_COORD_DB", str(HOME / ".local/share/coord/data/coord.db"))
    db_file = Path(db_path).absolute()
    uri = db_file.as_uri() + "?mode=ro"
    query = "SELECT id, thread_id FROM actors WHERE kind='thread' AND (thread_id LIKE 'ardud-control:thread:%' OR thread_id LIKE 'mcp:%')"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
            actors = db.execute(query).fetchall()
    except sqlite3.OperationalError:
        # A checkpointed WAL db may not have sidecars and may live in a
        # non-writable directory. Only trust a stable sidecar-free snapshot.
        before = db_file.stat()
        if Path(str(db_file) + "-wal").exists():
            raise
        with closing(sqlite3.connect(uri + "&immutable=1", uri=True, timeout=1)) as db:
            actors = db.execute(query).fetchall()
        after = db_file.stat()
        if Path(str(db_file) + "-wal").exists() or (before.st_ino, before.st_mtime_ns, before.st_size) != (after.st_ino, after.st_mtime_ns, after.st_size):
            raise ValueError("coord-snapshot-changed")
    exclusions = config.get("exclude") or {}
    node_keys = {_thread_key(n.get("threadId")) for n in nodes}
    matched = [(actor, thread) for actor, thread in actors if _thread_key(thread) in node_keys]
    if not matched:
        return config, False, "non-member"
    # Find the nearest actor root; a nested actor is not captured by an
    # otherwise independent actor above it. Exclusions still cover the path
    # all the way to the true root, just as in the OpenCode runtime.
    nearest = next(_thread_key(node.get("threadId")) for node in nodes
                   if any(_thread_key(thread) == _thread_key(node.get("threadId")) for _, thread in matched))
    matched = [(actor, thread) for actor, thread in matched if _thread_key(thread) == nearest]
    if identity.get("nativeSessionId") in exclusions.get("sessions", []) or any(n.get("nativeSessionId") in exclusions.get("sessions", []) for n in nodes if n.get("nativeSessionId")):
        return config, False, "excluded"
    for actor, thread in matched:
        if actor in exclusions.get("actors", []) or any(_thread_key(x) == _thread_key(thread) for x in exclusions.get("threads", [])):
            return config, False, "excluded"
    return config, "claude-haiku" in model, "coord-haiku" if "claude-haiku" in model else "non-haiku"


def decide_coord(command, identity, cwd, *, approved=False, approval_allowed=True, lineage=None):
    """Shim-facing decision. `approved` must come from approval_valid per invocation.

    A direct executable MCP tool does not accept the shell-input rewrite needed
    to pass its pin to the shim, so callers can disable hook-side approval.
    """
    try:
        config, guarded, membership = _coord_state(identity, lineage=lineage)
        hit = classify_coord(command)
        allowed_pin = approved or (approval_allowed and bool(approval(command, cwd)))
        deny = bool(hit and guarded and not allowed_pin and config["mode"] == "enforce")
        rule = "approved-sha256" if allowed_pin else hit if guarded and hit else membership
        return {"decision": "deny" if deny else "allow", "reason": COORD_REASON if deny else "", "context": {"rule": rule, "guarded": guarded}}
    except Exception:
        return {"decision": "allow", "reason": "", "context": {"rule": "coord-unresolved"}}


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
    start = time.monotonic()
    command = None
    pin = None
    identity = {}
    error_type = None
    log_tool = None
    binding_only = False
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
                    decision, reason, rule, error_type = desktop_lease.admit(event, harness, _control, _state())
                else:
                    rule, error_type = desktop_lease.finish(event, harness, _control, _state())
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
            try:
                root = rootwide_search_guard.classify(command, command_cwd)
            except Exception as error:
                # A search-parser failure must not disable the independent DB,
                # offbox or coord policies later in this hook.
                error_type = type(error).__name__
                root = None
            if root:
                result = {"decision": "deny", "reason": rootwide_search_guard.reason(root, command_cwd),
                          "context": {"rule": "rootwide-search"}}
                return result
            # The live DB rule is independent of native identity and offbox/coord
            # availability, so a service outage cannot disable this local check.
            try:
                hit, cause = statev2_guard.classify_detail(command, command_cwd)
            except Exception as error:
                error_type = type(error).__name__
                result = {"decision": "deny", "reason": "Live database guard unavailable; this shell command was NOT run. Retry after the guard is available; do not bypass it.",
                          "context": {"rule": "live-database-unavailable"}}
                return result
            if hit:
                reason = statev2_guard.UNRESOLVED_REASON if hit == "live-database-script-unresolved" else statev2_guard.REASON
                context = {"rule": hit}
                if hit == "live-database-script-unresolved" and cause:
                    reason = ("statev2 guard: this command was NOT run. Could not check an explicit script invocation: "
                              f"{cause}. Resolved workdir: {command_cwd}. Run the script by a literal path, write scripts "
                              "with apply_patch rather than a heredoc in the same command, or split the steps; do not bypass the guard.")
                    context["cause"] = cause
                result = {"decision": "deny", "reason": reason, "context": context}
                return result
        native, _, _ = _native(event, harness)
        if native:
            # Ordinary Claude shell calls only need a binding to sign. Model
            # policy and shims still refresh rather than trusting a cached model.
            shell_command = _command(event)
            binding_only = (harness == "claude" and kind == "PreToolUse" and
                            _shell_input_field(event, harness) and shell_command and
                            not classify_coord(shell_command))
            if binding_only and not tool.startswith("mcp__"):
                inp = event["tool_input"]
                shell_cwd = inp.get("workdir") or inp.get("cwd") or cwd or os.getcwd()
                binding_only = not approval(shell_command, shell_cwd)
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
                # A matched MCP server may be remote: a local script pin cannot
                # authorize code at the server's potentially different path.
                approval_allowed = bool(shell_field and not tool.startswith("mcp__"))
                cwd = inp.get("workdir") or inp.get("cwd") or cwd or os.getcwd()
                mode = _offbox_mode()
                if mode != "off":
                    try:
                        verdict = _classify_offbox(command, cwd)
                        if verdict["heavy"]:
                            cap = _read_json(_offbox_state() / "cap.json", {})
                            available = _offbox_available() and not (isinstance(cap, dict) and cap.get("capped") is True)
                            if mode == "enforce" and available and identity.get("resolution") != "resolved":
                                raise ValueError("identity-unresolved")
                            exempt = _exempt(identity, lineage=lineage) if mode == "enforce" and available else False
                            if mode == "enforce" and available and not exempt:
                                result = {"decision": "deny", "reason": _offbox_denial(verdict), "context": {"rule": verdict["rule"]}}
                            else:
                                result["context"]["rule"] = "offbox-observe" if mode == "observe" else "offbox-exempt" if exempt else "offbox-unavailable"
                    except Exception as error:
                        error_type = type(error).__name__
                        result["context"].update(rule="offbox-unresolved")
                if result["decision"] != "deny":
                    # The model was refreshed with this event's identity and
                    # is never taken from stdin or an older cached binding.
                    coord = (decide_coord(command, identity, cwd, approval_allowed=approval_allowed, lineage=lineage)
                             if not binding_only else {"decision": "allow", "reason": "", "context": {"rule": "no-policy"}})
                    if coord["context"].get("rule") == "coord-unresolved" and not error_type:
                        error_type = "coord-unresolved"
                    if coord["decision"] == "deny":
                        result = coord
                    elif coord["context"].get("guarded"):
                        pin = approval(command, cwd) if approval_allowed else None
                        result = coord
                    elif result["context"]["rule"] == "no-policy":
                        result = coord
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
                        if token or pin or any(os.environ.get(k) for k in (COMMAND_IDENTITY_ENV, "AGENT_GUARD_APPROVED", "HARNESS_COORD_APPROVED")):
                            updated = dict(inp)
                            updated[shell_field] = _command_with_context(command, token, pin)
                            result["context"]["updatedInput"] = updated
                    except Exception as error:
                        error_type = type(error).__name__
    except Exception as error:
        error_type = type(error).__name__
        result = {"decision": "allow", "reason": "", "context": {"rule": "hook-error"}}
    finally:
        _log(harness=harness, event=event.get("hook_event_name") if isinstance(event, dict) else None,
             tool=log_tool or (event.get("tool_name") if isinstance(event, dict) else None),
             robobThreadId=identity.get("robobThreadId"), decision=result["decision"], rule=result["context"].get("rule"),
             identity_source=identity.get("identity_source"), cause=result["context"].get("cause"),
             command=command, ms=round((time.monotonic() - start) * 1000, 3), error=error_type)
    return result


if __name__ == "__main__" and len(sys.argv) == 6 and sys.argv[1] == "--bind-exit":
    _exit_trap_update(*sys.argv[2:])
