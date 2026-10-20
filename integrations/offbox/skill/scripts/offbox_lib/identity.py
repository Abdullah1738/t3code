"""Caller identity (session -> Robob thread), repo root, Robob control API and Telegram. Adapted from rcsim.py."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .common import HOME, db, kv_get, kv_set, log

# offbox's own component credential first, the old shared file last.
CTL_CFGS = (HOME / ".robob/components/offbox.json", HOME / ".robob/ardud-control.json")
OC_URL = "http://127.0.0.1:49374"
OC_PW = HOME / ".config/opencode-service/password"
BUN = str(HOME / ".bun/bin/bun")
TG_CLI = str(HOME / ".local/share/telegram-bridge/src/cli.ts")


def ctl(method: str, path: str, body: dict | None = None, timeout: int = 10):
    """Robob control API. Returns (http_status, json); status 0 = unreachable."""
    cfg_file = next((p for p in CTL_CFGS if p.exists()), CTL_CFGS[0])
    try:
        if cfg_file.stat().st_mode & 0o077:
            raise PermissionError(f"{cfg_file} must be chmod 600")
        cfg = json.loads(cfg_file.read_text())
    except Exception as e:  # noqa: BLE001
        return 0, {"error": f"control config unreadable: {e}"}
    url = cfg["url"].rstrip("/") + "/api/ardud/control" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:  # noqa: BLE001
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def thread_get(tid: str):
    """-> ('ok'|'gone'|'unknown', thread dict|None)."""
    st, d = ctl("GET", "/threads/" + q(tid))
    if st == 200 and d.get("thread"):
        t = d["thread"]
        return ("gone" if t.get("archived") else "ok"), t
    if st == 404:
        return "gone", None
    return "unknown", None


def opencode_session(ses: str) -> dict | None:
    try:
        pw = OC_PW.read_text().strip()
    except OSError:
        return None
    req = urllib.request.Request(f"{OC_URL}/api/session/{q(ses)}", headers={
        "Authorization": "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.load(r)
            return d.get("data") or d
    except Exception:  # noqa: BLE001
        return None


def telegram(text: str, key: str, severity: str = "info") -> bool:
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    try:
        p = subprocess.run([BUN, TG_CLI, "notify", "--source", "offbox", "--severity", severity,
                            "--text", text[:4000], "--key", key[:200]],
                           env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=40)
        ok = p.returncode == 0
    except Exception:  # noqa: BLE001
        ok = False
    log(f"telegram key={key} ok={ok}")
    return ok


def _lookup_thread(ses: str) -> dict:
    """Session -> thread info, cached 1 h in kv (whoami costs ~1.5 s otherwise)."""
    con = db()
    ck = f"whoami:{ses}"
    cached = kv_get(con, ck, max_age=3600)
    if cached:
        return cached
    me = {"thread": None, "title": None, "manager": None}
    st, d = ctl("GET", "/threads/by-native/" + q(ses))
    t = d.get("thread") if st == 200 else None
    if t:
        me["thread"] = t.get("threadId")
        me["title"] = t.get("title")
        if t.get("relationshipToParent") == "subagent" and t.get("parentThreadId"):
            me["manager"] = t["parentThreadId"]
    if not me["manager"]:
        info = opencode_session(ses) or {}
        pid = info.get("parentID")
        if pid:
            st2, d2 = ctl("GET", "/threads/by-native/" + q(pid))
            if st2 == 200 and d2.get("thread"):
                me["manager"] = d2["thread"]["threadId"]
    if me["thread"] or st in (200, 404):
        kv_set(con, ck, me)
    return me


def repo_root(cwd: str | None = None) -> Path:
    cwd = cwd or os.getcwd()
    try:
        p = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return Path(p.stdout.strip()).resolve()
    except Exception:  # noqa: BLE001
        pass
    return Path(cwd).resolve()


def repo_key(root: Path) -> str:
    """Stable short name for a repo: basename of the origin URL (or dir) + 6-char hash of the path."""
    name = root.name
    try:
        p = subprocess.run(["git", "config", "--get", "remote.origin.url"], cwd=root, capture_output=True,
                           text=True, timeout=5)
        url = p.stdout.strip()
        if url:
            name = re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1].split(":")[-1]) or name
    except Exception:  # noqa: BLE001
        pass
    name = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")[:40] or "repo"
    return name


def whoami(cwd: str | None = None) -> dict:
    ses = os.environ.get("OPENCODE_SESSION_ID") or None
    root = repo_root(cwd)
    me = {"session": ses, "thread": os.environ.get("OFFBOX_THREAD") or None, "title": None, "manager": None,
          "repo_root": str(root), "repo_key": repo_key(root)}
    if not me["thread"] and ses:
        me.update({k: v for k, v in _lookup_thread(ses).items() if v})
    me["owner"] = me["thread"] or f"local:{root}"
    return me


def remote_dir_for(root: Path | str) -> str:
    """Remote checkout dir, relative to /home/user. Unique per repo path."""
    root = str(root)
    h = hashlib.sha1(root.encode()).hexdigest()[:6]
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(root).name)[:40] or "repo"
    return f"w/{base}-{h}"
