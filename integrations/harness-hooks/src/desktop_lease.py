"""Fail-closed admission for desktop calls and best-effort completion."""
import json
import re
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
                response = opener.open(request, timeout=3)
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
    if not done.wait(3):
        raise TimeoutError("control-deadline")
    if isinstance(result[0], Exception):
        raise result[0]
    return result[0]


def valid_id(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


def admit(event, harness, control):
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
            return "allow", "", "desktop-admitted", None
        if status == 409:
            error = data.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            if isinstance(message, str) and message:
                return "deny", NO_LEASE + message, "desktop-denied", None
        raise ValueError("control-response")
    except Exception as error:
        return "deny", UNAVAILABLE, "desktop-unavailable", type(error).__name__


def finish(event, harness, control):
    try:
        if not needs_lease(event):
            return "desktop-read-only", None
        call_id = event.get("tool_use_id")
        if not valid_id(call_id):
            raise ValueError("missing-desktop-call")
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
