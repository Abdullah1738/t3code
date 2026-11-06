"""Fail-closed admission for desktop calls and best-effort completion."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import urllib.error
import urllib.request


READ_ONLY_CUA = frozenset({
    "check_for_update", "clipboard_read", "get_accessibility_tree",
    "get_agent_cursor_state", "get_browser_state", "get_config",
    "get_cursor_position", "get_desktop_state", "get_recording_state",
    "get_screen_size", "get_session", "get_session_state", "get_window_state",
    "health_report", "list_apps", "list_sessions", "list_windows",
    "parse_visual_regions", "verify_state", "zoom",
})
CUA_NAME = re.compile(r"^mcp__(?:cua-driver|cua_driver)__(.+)$")
DESKTOP_JS = re.compile(r"@oai/sky|\bsky\b|SkyComputerUse|computeruse\.sock|nativePipe|launchServices")
NODE_REPL = "mcp__node_repl__js"
UNAVAILABLE = "Desktop lease check unavailable; the desktop action was blocked."
# The hook process has 10 s. The server can stall for several seconds under load (12:53 6 Nov:
# ~5-10 s SQLite waits), and 3 s denied a held lease; 8 s keeps a 2 s margin.
DEADLINE = 8
NO_LEASE = ("No desktop lease for this thread. Run the lease steps in the mac-computer-use-routing "
            "skill (t3ctl desktop-lease acquire) and wait until it says held. Server: ")


def matches(name):
    return isinstance(name, str) and (name == NODE_REPL or CUA_NAME.fullmatch(name) is not None)


def needs_lease(event):
    name, arguments = event.get("tool_name"), event.get("tool_input")
    if not isinstance(arguments, dict):
        return True
    if name == NODE_REPL:
        code = arguments.get("code")
        return not isinstance(code, str) or DESKTOP_JS.search(code) is not None
    match = CUA_NAME.fullmatch(name)
    tool = match.group(1) if match else ""
    if tool in READ_ONLY_CUA:
        return False
    if tool == "check_permissions":
        return arguments.get("prompt", False) is not False
    if tool == "browser_dialog":
        return arguments.get("action") != "inspect"
    if tool == "page":
        return arguments.get("action") not in ("get_text", "query_dom")
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post(control, path, payload):
    """Limit total elapsed time as well as the socket timeout, including slow bodies."""
    done = threading.Event()
    result = []

    def send():
        try:
            base, token = control()
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            request = urllib.request.Request(base + "/desktop-lease/" + path,
                                             json.dumps(payload).encode(), headers, method="POST")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            try:
                response = opener.open(request, timeout=DEADLINE)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.status
                raw = response.read(1024 * 1024 + 1)
            if path == "call-end" and status == 404:
                result.append((status, None))
                return
            if len(raw) > 1024 * 1024:
                raise ValueError("control-response-size")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("control-response")
            result.append((status, data))
        except Exception as error:
            result.append(error)
        finally:
            done.set()

    threading.Thread(target=send, daemon=True).start()
    if not done.wait(DEADLINE):
        raise TimeoutError("control-deadline")
    if isinstance(result[0], Exception):
        raise result[0]
    return result[0]


def valid_id(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


# Codex sends no PostToolUse for an MCP call that fails, so its admitted call row would stay open and the
# lease would stick in `stopping` (then quarantine). Admitted calls are tracked per native caller and any
# still open when the turn ends (Stop/SubagentStop/SessionEnd) are closed as failed.
TURN_END = frozenset({"Stop", "SubagentStop", "SessionEnd"})


def _pending_file(state_dir, native):
    key = hashlib.sha256(native.encode("utf-8")).hexdigest()[:32]
    return Path(state_dir) / "desktop-pending" / (key + ".json")


def _pending_update(state_dir, native, add=None, remove=None):
    """Best effort; a lost entry only means the server's own age limit applies, as before."""
    if state_dir is None or not native:
        return []
    path = _pending_file(state_dir, native)
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            with open(path, encoding="utf-8") as f:
                calls = [c for c in json.load(f) if isinstance(c, str)]
        except (FileNotFoundError, ValueError):
            calls = []
        if add and add not in calls:
            calls.append(add)
        if remove is not None:
            calls = [c for c in calls if c not in remove]
        fd, tmp = tempfile.mkstemp(prefix="pending-", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(calls[-64:], f)
        os.replace(tmp, path)
        return calls
    except OSError:
        return []


def _native_key(event, harness):
    session, agent = event.get("session_id"), event.get("agent_id")
    if harness == "codex":
        return agent if valid_id(agent) else session if valid_id(session) else None
    if not valid_id(session):
        return None
    return session + ("\x00" + agent if valid_id(agent) else "")


def flush(event, harness, control, state_dir):
    """Close this caller's still-open desktop calls as failed at turn end. Never raises."""
    try:
        native = _native_key(event, harness)
        pending = _pending_update(state_dir, native)
        closed = []
        for call_id in pending:
            try:
                status, _ = post(control, "call-end", {"toolUseId": call_id, "outcome": "failed"})
            except Exception:  # noqa: BLE001 - keep it for the next turn end
                continue
            if status in (200, 404):
                closed.append(call_id)
        if closed:
            _pending_update(state_dir, native, remove=closed)
        return ("desktop-flush" if closed else "desktop-flush-none"), None
    except Exception as error:  # noqa: BLE001
        return "desktop-end-error", type(error).__name__


def admit(event, harness, control, state_dir=None):
    if not needs_lease(event):
        return "allow", "", "desktop-read-only", None
    try:
        session, agent, call_id = event.get("session_id"), event.get("agent_id"), event.get("tool_use_id")
        if not valid_id(session) or not valid_id(call_id) or (agent is not None and not valid_id(agent)):
            raise ValueError("missing-desktop-identity")
        payload = {"driver": "claudeAgent" if harness == "claude" else "codex",
                   "nativeId": agent if harness == "codex" and agent else session,
                   "toolUseId": call_id}
        if harness == "claude" and agent:
            payload["agentId"] = agent
        status, data = post(control, "call-start", payload)
        if status == 200 and data.get("ok") is not False:
            _pending_update(state_dir, _native_key(event, harness), add=call_id)
            return "allow", "", "desktop-admitted", None
        if status == 409:
            error = data.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            if isinstance(message, str) and message:
                return "deny", NO_LEASE + message, "desktop-denied", None
        raise ValueError("control-response")
    except Exception as error:
        return "deny", UNAVAILABLE, "desktop-unavailable", type(error).__name__


def finish(event, harness, control, state_dir=None):
    try:
        if not needs_lease(event):
            return "desktop-read-only", None
        call_id = event.get("tool_use_id")
        if not valid_id(call_id):
            raise ValueError("missing-desktop-call")
        _pending_update(state_dir, _native_key(event, harness), remove=[call_id])
        response = event.get("tool_response")
        failed = event.get("hook_event_name") == "PostToolUseFailure" or (
            harness == "codex" and isinstance(response, dict) and
            (response.get("isError") is True or response.get("is_error") is True or
             bool(response.get("error"))))
        status, _ = post(control, "call-end", {"toolUseId": call_id,
                                               "outcome": "failed" if failed else "completed"})
        if status not in (200, 404):
            raise ValueError("control-response")
        return "desktop-end", None
    except Exception as error:
        return "desktop-end-error", type(error).__name__
