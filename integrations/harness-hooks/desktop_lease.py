#!/usr/bin/env python3
"""PreToolUse desktop lease guard. See README.md before wiring this hook."""

import json
import os
import re
import stat
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


PREFIX = "/api/ardud/control"
MAX_INPUT = 1024 * 1024
MAX_RESPONSE = 1024 * 1024
TIMEOUT_SECONDS = 3

# An unknown cua-driver operation is an action, not a new implicit permission.
READ_ONLY_CUA = frozenset({
    "check_for_update", "clipboard_read", "get_accessibility_tree",
    "get_agent_cursor_state", "get_browser_state", "get_config",
    "get_cursor_position", "get_desktop_state", "get_recording_state",
    "get_screen_size", "get_session", "get_session_state", "get_window_state",
    "health_report", "list_apps", "list_sessions", "list_windows",
    "parse_visual_regions", "verify_state", "zoom",
})

MCP_NAME = re.compile(r"^mcp__([A-Za-z0-9_-]+)__(.+)$")
QUALIFIED_NAME = re.compile(r"^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_]+)$")

# Only primitives and operators are accepted without a lease. No identifiers,
# property access, brackets, templates, or invocation of existing REPL state.
# This is deliberately much smaller than ordinary JavaScript, not a JS parser.
PURE_TOKEN = re.compile(
    r"\s+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|"
    r"(?:true|false|null)(?![A-Za-z0-9_$])|"
    r"'(?:[^'\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*'|"
    r'"(?:[^"\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*"|'
    r"[+\-*/%!?<>&|^~():,;]"
)


class GuardError(Exception):
    pass


def nonempty(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


def is_pure_literal_expression(source):
    if not isinstance(source, str) or not source.strip():
        return False
    pos = 0
    while pos < len(source):
        match = PURE_TOKEN.match(source, pos)
        if match is None:
            return False
        pos = match.end()
    return True


def tool_parts(name):
    match = MCP_NAME.fullmatch(name) or QUALIFIED_NAME.fullmatch(name)
    if not match:
        return None, None
    return match.group(1).replace("-", "_").lower(), match.group(2)


def needs_lease(event):
    if not isinstance(event, dict) or event.get("hook_event_name") != "PreToolUse":
        raise GuardError("Invalid PreToolUse event.")
    name = event.get("tool_name")
    if not nonempty(name):
        raise GuardError("Missing tool name.")
    server, tool = tool_parts(name)
    arguments = event.get("tool_input")
    if server == "cua_driver":
        if not isinstance(arguments, dict):
            return True
        if tool in READ_ONLY_CUA:
            return False
        if tool == "check_permissions":
            return arguments.get("prompt", False) is not False
        if tool == "browser_dialog":
            return arguments.get("action") != "inspect"
        if tool == "page":
            return arguments.get("action") not in ("get_text", "query_dom")
        return True
    if server == "node_repl":
        if tool == "js" and isinstance(arguments, dict):
            return not is_pure_literal_expression(arguments.get("code"))
        return True
    return False


def control_config():
    url = os.environ.get("T3_CONTROL_URL")
    token = os.environ.get("T3_CONTROL_TOKEN")
    named = os.environ.get("T3_CONTROL_TOKEN_FILE")
    home = Path.home()
    paths = [Path(named)] if named else [
        home / ".robob/components/t3ctl.json", home / ".robob/ardud-control.json",
    ]
    if not url or not token:
        for path in paths:
            try:
                info = path.stat()
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                    raise GuardError("Control credential has unsafe permissions.")
                with path.open(encoding="utf-8") as f:
                    stored = json.load(f)
            except FileNotFoundError:
                if named:
                    raise GuardError("Control credential is unavailable.") from None
                continue
            if not isinstance(stored, dict):
                raise GuardError("Invalid control credential.")
            url = url or stored.get("url")
            token = token or stored.get("token")
            break
    if not nonempty(url) or not nonempty(token):
        raise GuardError("Control credential is unavailable.")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment):
        raise GuardError("Invalid control URL.")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise GuardError("A remote control URL must use HTTPS.")
    return url.rstrip("/"), token


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(base, token, method, path, data=None):
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    body = None
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data, separators=(",", ":")).encode()
    request = urllib.request.Request(base + PREFIX + path, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise GuardError("Control API refused the request.")
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise GuardError("Control API response is too large.")
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("ok") is False:
        raise GuardError("Invalid control API response.")
    return value


def resolve_caller(event, base, token):
    # This is a proposed per-call C1 interface, not the existing by-native route:
    # a native session ID alone can be shared by a parent and native subagents.
    proof = os.environ.get("T3_HOOK_IDENTITY_PROOF")
    native_id = event.get("session_id")
    call_id = event.get("tool_use_id")
    agent_id = event.get("agent_id")
    if not nonempty(proof) or not nonempty(native_id) or not nonempty(call_id):
        raise GuardError("Verified per-call identity is unavailable.")
    if agent_id is not None and not nonempty(agent_id):
        raise GuardError("Invalid agent identity.")
    response = request_json(base, token, "POST", "/hook-identity/resolve", {
        "proof": proof, "nativeSessionId": native_id, "toolUseId": call_id,
        "agentId": agent_id,
    })
    caller = response.get("caller")
    if (not isinstance(caller, dict) or caller.get("verified") is not True or
            caller.get("nativeSessionId") != native_id or caller.get("toolUseId") != call_id or
            "agentId" not in caller or caller["agentId"] != agent_id or
            not nonempty(caller.get("threadId")) or not nonempty(caller.get("rootThreadId"))):
        raise GuardError("Caller identity was not verified for this tool call.")
    return caller


def valid_timestamp(value):
    if not nonempty(value):
        return False
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return timestamp.tzinfo is not None


def check_lease(event):
    base, token = control_config()
    caller = resolve_caller(event, base, token)
    status = request_json(base, token, "GET", "/desktop-lease")
    lease = status.get("lease")
    if (not isinstance(status.get("queue"), list) or not isinstance(lease, dict) or
            lease.get("state") != "held" or
            lease.get("childThreadId") != caller["threadId"] or
            lease.get("rootThreadId") != caller["rootThreadId"] or
            not nonempty(lease.get("taskId")) or not nonempty(lease.get("scope")) or
            lease.get("mode") not in ("native", "cua-driver") or
            not valid_timestamp(lease.get("acquiredAt")) or
            not valid_timestamp(lease.get("heartbeatAt"))):
        raise GuardError("No held desktop lease for the verified caller.")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, separators=(",", ":")))


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise GuardError("Hook input is too large.")
        event = json.loads(raw)
        if needs_lease(event):
            check_lease(event)
    except GuardError as error:
        deny(str(error))
    except Exception:
        # Do not leak credentials, code, private paths, or HTTP bodies.
        deny("Desktop lease check unavailable; the tool call was blocked.")


if __name__ == "__main__":
    main()
