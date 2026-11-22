"""Fail-closed admission for desktop calls and best-effort completion."""
import hashlib
import http.client
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import urlsplit


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
UNAVAILABLE = ("Desktop lease check unavailable; your lease may still be held. Retry this call once; "
               "if it fails again run `t3ctl desktop-lease status`.")
# Desktop PreToolUse hooks have 30 s; leave 6 s for startup, state and logging.
START_BUDGET = 24
START_ATTEMPT = 12
DEADLINE = 8
PENDING_LOCK_WAIT = 0.25
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


def _post_attempt(control, path, payload, timeout, timing):
    """Limit total elapsed time as well as the socket timeout, including slow bodies."""
    done = threading.Event()
    result = []

    def send():
        connection = None
        try:
            base, token = control()
            url = urlsplit(base + "/desktop-lease/" + path)
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
                raise ValueError("control-url")
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            client = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
            connection = client(url.hostname, url.port, timeout=timeout)
            timing["phase"] = "connect"
            started = time.monotonic()
            connection.connect()
            timing["connect_ms"] = round((time.monotonic() - started) * 1000, 3)
            timing["phase"] = "response"
            connection.request("POST", url.path, json.dumps(payload).encode(), headers)
            response = connection.getresponse()
            with response:
                status = response.status
                timing["status"] = status
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
            if connection:
                connection.close()
            done.set()

    threading.Thread(target=send, daemon=True).start()
    if not done.wait(timeout):
        raise TimeoutError("control-deadline")
    if isinstance(result[0], Exception):
        raise result[0]
    return result[0]


def post(control, path, payload, diagnostics=None, budget=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    started = time.monotonic()
    budget = budget if budget is not None else START_BUDGET if path == "call-start" else DEADLINE
    attempts = []
    diagnostics.update(phase="total", attempts=0, attempt_timings=attempts)
    try:
        for attempt in range(2 if path == "call-start" else 1):
            remaining = budget - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError("control-deadline")
            timeout = min(START_ATTEMPT, remaining) if path == "call-start" else remaining
            timing = {"phase": "total"}
            attempt_start = time.monotonic()
            diagnostics["attempts"] = attempt + 1
            try:
                return _post_attempt(control, path, payload, timeout, timing)
            except Exception as error:
                # Transport messages may contain URLs or credentials; retain only safe cause text.
                message = (str(error) or "control-deadline") if isinstance(error, (TimeoutError, ConnectionRefusedError)) else (
                    str(error) if isinstance(error, ValueError) and str(error).startswith("control-") else "control-error")
                diagnostics.update(error_message=message[:240])
                timing.update(error=type(error).__name__, error_message=message[:240])
                if not isinstance(error, TimeoutError) or attempt == 1 or path != "call-start" or timing.get("status") == 409:
                    raise
            finally:
                # A timed-out daemon must not mutate the logged snapshot after a later attempt.
                snapshot = {**timing, "ms": round((time.monotonic() - attempt_start) * 1000, 3)}
                if "connect_ms" in snapshot:
                    snapshot["response_ms"] = round(snapshot["ms"] - snapshot["connect_ms"], 3)
                attempts.append(snapshot)
                diagnostics["phase"] = snapshot["phase"]
    finally:
        diagnostics["total_ms"] = round((time.monotonic() - started) * 1000, 3)


def valid_id(value):
    return isinstance(value, str) and bool(value) and value == value.strip()


# Codex sends no PostToolUse for an MCP call that fails, so its admitted call row would stay open and the
# lease would stick in `stopping` (then quarantine). Admitted calls are tracked per native caller and any
# still open when the turn ends (Stop/SubagentStop/SessionEnd) are closed as failed.
# A completion whose reply was lost must retry its original outcome instead.
TURN_END = frozenset({"Stop", "SubagentStop", "SessionEnd"})


def _pending_file(state_dir, native):
    key = hashlib.sha256(native.encode("utf-8")).hexdigest()[:32]
    return Path(state_dir) / "desktop-pending" / (key + ".json")


# Milliseconds this process has spent waiting for pending-file locks; the
# engine reads the change across one hook call for its slow-row phase timings.
lock_wait_ms = 0.0


@contextlib.contextmanager
def _pending_lock(path):
    global lock_wait_ms
    # Lock a stable sidecar: locking the JSON inode would not survive atomic replacement.
    fd = os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    waited = time.monotonic()
    deadline = waited + PENDING_LOCK_WAIT
    try:
        try:
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("control-pending-lock")
                    time.sleep(min(0.01, remaining))
        finally:
            lock_wait_ms += (time.monotonic() - waited) * 1000
        yield
    finally:
        os.close(fd)


def _pending_update(state_dir, native, add=None, remove=None, outcome=None):
    """Best effort; a lost entry only means the server's own age limit applies, as before."""
    if state_dir is None or not native:
        return {}
    path = _pending_file(state_dir, native)
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with _pending_lock(path):
            try:
                with open(path, encoding="utf-8") as f:
                    saved = json.load(f)
                if isinstance(saved, list):
                    calls = {c: "failed" for c in saved if isinstance(c, str)}
                elif isinstance(saved, dict):
                    calls = {c: value for c, value in saved.items() if value in ("failed", "completed")}
                else:
                    calls = {}
            except (FileNotFoundError, ValueError):
                calls = {}
            if add:
                if outcome is None:
                    calls.setdefault(add, "failed")
                else:
                    calls[add] = outcome
            if remove is not None:
                calls = {c: value for c, value in calls.items() if c not in remove}
            fd, tmp = tempfile.mkstemp(prefix="pending-", dir=path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(dict(list(calls.items())[-64:]), f)
            os.replace(tmp, path)
            return calls
    except OSError:
        return {}


def _native_key(event, harness):
    session, agent = event.get("session_id"), event.get("agent_id")
    if harness == "codex":
        return agent if valid_id(agent) else session if valid_id(session) else None
    if not valid_id(session):
        return None
    return session + ("\x00" + agent if valid_id(agent) else "")


def flush(event, harness, control, state_dir):
    """Close unfinished calls and retry unacknowledged completions. Never raises."""
    try:
        native = _native_key(event, harness)
        pending = _pending_update(state_dir, native)
        closed = []
        deadline = time.monotonic() + DEADLINE
        for call_id, outcome in pending.items():
            if time.monotonic() >= deadline:
                break
            try:
                status, _ = post(control, "call-end", {"toolUseId": call_id, "outcome": outcome},
                                 budget=deadline - time.monotonic())
            except Exception:  # noqa: BLE001 - keep it for the next turn end
                continue
            if status in (200, 404):
                closed.append(call_id)
        if closed:
            _pending_update(state_dir, native, remove=closed)
        return ("desktop-flush" if closed else "desktop-flush-none"), None
    except Exception as error:  # noqa: BLE001
        return "desktop-end-error", type(error).__name__


def admit(event, harness, control, state_dir=None, diagnostics=None):
    if diagnostics is not None:
        diagnostics.update(phase="total", attempts=0)
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
        status, data = post(control, "call-start", payload, diagnostics)
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
        if diagnostics is not None and not diagnostics.get("error_message"):
            diagnostics["error_message"] = (str(error) if isinstance(error, ValueError) and
                                            str(error) in {"missing-desktop-identity", "control-response"}
                                            else "control-error")
        return "deny", UNAVAILABLE, "desktop-unavailable", type(error).__name__


def finish(event, harness, control, state_dir=None, diagnostics=None):
    if diagnostics is not None:
        diagnostics.update(phase="total", attempts=0)
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
        outcome = "failed" if failed else "completed"
        native = _native_key(event, harness)
        pending = _pending_update(state_dir, native, add=call_id, outcome=outcome)
        # Do not commit an outcome we could not save for a possible lost-reply retry.
        if state_dir is not None and native and pending.get(call_id) != outcome:
            raise ValueError("control-pending-unavailable")
        status, _ = post(control, "call-end", {"toolUseId": call_id, "outcome": outcome}, diagnostics)
        if status not in (200, 404):
            raise ValueError("control-response")
        _pending_update(state_dir, _native_key(event, harness), remove=[call_id])
        return "desktop-end", None
    except Exception as error:
        if diagnostics is not None and not diagnostics.get("error_message"):
            diagnostics["error_message"] = (str(error) if str(error) in {
                "missing-desktop-call", "control-pending-unavailable"} else "control-response")
        return "desktop-end-error", type(error).__name__
