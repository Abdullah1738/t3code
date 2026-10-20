"""Shared offbox monitor/shim helpers; never log responses or credentials."""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = Path.home()
STATE = Path(os.environ.get("OFFBOX_STATE_DIR", HOME / ".local/share/offbox"))
PREFIX = "[Automated message from the offbox monitor (remote-compute skill), not typed by Abdullah.]"
_CACHE = {}


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def mode():
    override = os.environ.get("OFFBOX_GATE_MODE")
    if override in ("off", "observe", "enforce"):
        return override
    cfg = read_json(os.environ.get("OFFBOX_GATE_CONFIG", HOME / ".config/opencode/offbox-gate.json"), {})
    return cfg.get("mode", "observe") if isinstance(cfg, dict) else "observe"


def request(method, url, auth, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        "Authorization": auth, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return error.code, {}
    except (OSError, ValueError):
        return 0, {}


def ctl(method, path, body=None):
    cfg = read_json(HOME / ".robob/ardud-control.json", {})
    if not isinstance(cfg, dict) or not cfg.get("url") or not cfg.get("token"):
        return 0, {}
    return request(method, cfg["url"].rstrip("/") + "/api/ardud/control" + path,
                   "Bearer " + cfg["token"], body)


def oc(method, session, suffix="", body=None):
    try:
        password = (HOME / ".config/opencode-service/password").read_text().strip()
    except OSError:
        return 0, {}
    auth = "Basic " + base64.b64encode(("opencode:" + password).encode()).decode()
    url = "http://127.0.0.1:49374/api/session/" + urllib.parse.quote(session, safe="") + suffix
    return request(method, url, auth, body)


def cached(key, fn):
    now = time.time()
    item = _CACHE.get(key)
    if item and item[0] > now:
        return item[1]
    value = fn()
    _CACHE[key] = (now + (300 if value else 30), value)
    if len(_CACHE) > 2000:
        _CACHE.pop(next(iter(_CACHE)))
    return value


def parent_session(session):
    def lookup():
        status, data = oc("GET", session)
        if status != 200 or not isinstance(data, dict):
            return None
        info = data.get("data") or data
        return info.get("parentID")
    return cached(("parent", session), lookup)


def live_exemption(session, now=None):
    now = time.time() if now is None else now
    entries = read_json(STATE / "exemptions.json", [])
    if not isinstance(entries, list):
        return False
    live = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        expiry = entry.get("expires_at")
        try:
            expires = float(expiry)
        except (TypeError, ValueError):
            try:
                expires = dt.datetime.fromisoformat(str(expiry).replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
        if expires > now and entry.get("session_id"):
            live.add(entry["session_id"])
    if session in live:
        return True
    return bool(live and parent_session(session) in live)


def thread_for(session):
    def lookup():
        status, data = ctl("GET", "/threads/by-native/" + urllib.parse.quote(session, safe=""))
        return data.get("thread") if status == 200 and isinstance(data, dict) else None
    return cached(("thread", session), lookup)


def thread_send(thread, text, request_id):
    status, _ = ctl("POST", "/threads/" + urllib.parse.quote(thread, safe="") + "/send",
                    {"text": text, "mode": "auto", "clientRequestId": request_id[:120]})
    return 200 <= status < 300


def steer(session, text, request_id, include_parent=False):
    thread = thread_for(session) or {}
    tid = thread.get("threadId")
    parent = parent_session(session)
    native_child = bool(parent or thread.get("relationshipToParent") == "subagent")
    delivered = bool(not native_child and tid and thread_send(tid, text, request_id))
    if not delivered:
        status, _ = oc("POST", session, "/prompt", {"text": text, "delivery": "steer"})
        delivered = 200 <= status < 300
    if include_parent:
        manager = thread.get("parentThreadId")
        parent_text = text.replace(PREFIX, PREFIX + "\nFYI for the parent/manager of this session.", 1)
        if parent:
            steer(parent, parent_text, request_id + ":parent", include_parent=False)
        elif manager and manager != tid:
            thread_send(manager, parent_text, request_id + ":parent")
    return delivered


def run(args, timeout=10):
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=timeout, env=env)
        return result.stdout if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def telegram(session):
    # Fixed payload for this stable key: the bridge rejects changed retry text.
    text = (PREFIX + "\nSession " + session + " has kept heavy local work running for at least 15 minutes "
            "after a pressure warning. It has been nudged and background-throttled. "
            "Load the remote-compute skill and move heavy work to offbox run -- <cmd>, "
            "or use offbox local --reason ... if it truly must stay local.")
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    try:
        result = subprocess.run([
            str(HOME / ".bun/bin/bun"), str(HOME / ".local/share/telegram-bridge/src/cli.ts"),
            "notify", "--source", "offbox monitor", "--severity", "attention", "--text", text,
            "--key", "offbox-monitor:" + session], stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=40, env=env)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
