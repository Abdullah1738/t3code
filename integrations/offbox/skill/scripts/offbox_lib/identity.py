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

from .common import HOME, db, kv_get, kv_set, log, now

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


# Robob's execution identity for a native id (C1, apps/server/src/ardud/identity). The caller's
# driver comes from the shell env the harness sets; OpenCode keeps its own path.
ENV_DRIVERS = (
    ("CLAUDE_CODE_SESSION_ID", "claudeAgent"),
    ("CODEX_THREAD_ID", "codex"),  # the concrete thread; CODEX_SESSION_ID is shared by children
    ("OPENCODE_SESSION_ID", "opencode"),
)
# A resolved answer is stable for an hour. An unresolved one (a new provider thread still pending its
# native id, or a control outage) is held only for a short burst, so the next attempt asks C1 again
# and picks the mapping up as soon as it lands (well inside the 60 s the card requires).
RESOLVED_TTL = 3600
UNRESOLVED_TTL = 5


def caller_native() -> tuple[str | None, str | None]:
    """(native id, driver) from the harness env, or (None, None).

    Claude in-process children share their parent's session id and the shell env
    carries no agent id (validation-integrations B8), so a Claude shell always
    resolves to the session's execution, never to a child.
    """
    for var, driver in ENV_DRIVERS:
        value = os.environ.get(var) or None
        if value:
            return value, driver
    return None, None


def identity_for(native: str, driver: str) -> dict:
    """C1's resolution for one native id. Resolved answers last an hour; anything else, a minute.

    A pending or unavailable answer is never reported as unowned: callers treat it as "not yet".
    """
    con = db()
    key = f"identity:{driver}:{native}"
    row = con.execute("SELECT v, ts FROM kv WHERE k=?", (key,)).fetchone()
    if row:
        try:
            cached = json.loads(row["v"])
        except Exception:  # noqa: BLE001
            cached = None
        age = now() - (row["ts"] or 0)
        if isinstance(cached, dict):
            if cached.get("resolution") == "resolved" and age <= RESOLVED_TTL:
                return cached
            if cached.get("resolution") != "resolved" and age <= UNRESOLVED_TTL:
                return cached
    st, d = ctl("GET", f"/identity/resolve?nativeId={q(native)}&driver={q(driver)}")
    if st == 200 and isinstance(d.get("identity"), dict):
        ident = dict(d["identity"])
    else:
        ident = {"resolution": "unavailable", "robobThreadId": None, "parentThreadId": None,
                 "executionKind": None, "acceptsMessages": False, "candidates": []}
    ident.update(driver=driver, nativeId=native)
    kv_set(con, key, ident)
    return ident


def _lookup_thread(ses: str) -> dict:
    """OpenCode session -> thread info, cached 1 h in kv (whoami costs ~1.5 s otherwise).

    OpenCode keeps its own parent lookup: C1 knows only Robob's native bindings.
    """
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


def _ancestors(thread_id: str) -> set[str]:
    """Every Robob thread above `thread_id`. The visited set stops a cycle; each hop is one read."""
    above: set[str] = set()
    visited = {thread_id}
    current = thread_id
    while True:
        status, data = thread_get(current)
        if status != "ok" or not data:
            break
        parent = data.get("parentThreadId")
        if not parent or parent in visited:
            break
        above.add(parent)
        visited.add(parent)
        current = parent
    return above


# offbox-person sets OFFBOX_THREAD=person:<slug> on purpose: a fixed owner for one person's leases, not a
# Robob thread. It comes from the wrapper, never from an agent shell, so it is not subject to the check.
PERSON_OWNER_PREFIX = "person:"


def _explicit_thread(resolved_thread: str | None) -> str | None:
    """OFFBOX_THREAD is an inherited shell value, so it only counts when it names the caller's
    own execution or one of its ancestors. An unrelated parent's value is ignored and logged."""
    explicit = os.environ.get("OFFBOX_THREAD") or None
    if explicit is None:
        return None
    if explicit.startswith(PERSON_OWNER_PREFIX):
        return explicit
    if resolved_thread is None:
        log("OFFBOX_THREAD ignored: the caller has no resolved Robob thread")
        return None
    if explicit == resolved_thread or explicit in _ancestors(resolved_thread):
        return explicit
    log(f"OFFBOX_THREAD ignored: {explicit} is not this execution or an ancestor")
    return None


def whoami(cwd: str | None = None) -> dict:
    root = repo_root(cwd)
    native, driver = caller_native()
    me = {"session": None, "thread": None, "title": None, "manager": None,
          "repo_root": str(root), "repo_key": repo_key(root), "driver": driver,
          "resolution": None, "executionKind": None, "acceptsMessages": None, "parent": None}
    if driver == "opencode":
        # OpenCode path, unchanged: the shell's session id names the thread.
        me["session"] = native
        me["thread"] = os.environ.get("OFFBOX_THREAD") or None
        if not me["thread"] and native:
            me.update({k: v for k, v in _lookup_thread(native).items() if v})
        me["resolution"] = "resolved" if me["thread"] else None
    elif native is None:
        # No native id at all (a wrapper or a plain shell): an explicit owner is still honoured as before.
        me["thread"] = os.environ.get("OFFBOX_THREAD") or None
    else:
        me["session"] = native
        ident = identity_for(native, driver)
        me["resolution"] = ident.get("resolution")
        me["executionKind"] = ident.get("executionKind")
        me["acceptsMessages"] = ident.get("acceptsMessages")
        # A Claude shell carries only its session id, which a native child shares with its parent. C1 answers a
        # bare Claude id with the parent's identity, so taking that answer would let a child own the parent's
        # leases. Claude callers therefore never take a resolved owner; they keep their own unresolved owner.
        if driver == "claudeAgent":
            log(f"claude caller {native[:8]}: no per-agent id in the shell, so no resolved owner is taken")
            me["resolution"] = "unresolved"
        elif ident.get("resolution") == "resolved":
            me["thread"] = ident.get("robobThreadId")
            me["manager"] = ident.get("parentThreadId")
            me["parent"] = ident.get("parentThreadId")
        else:
            # Not yet (pending), ambiguous or unavailable: never the unowned local owner.
            log(f"caller {driver} {native[:8]} unresolved: {ident.get('resolution')}")
        explicit = _explicit_thread(me["thread"])
        if explicit is not None:
            me["thread"] = explicit
    me["owner"] = me["thread"] or f"local:{root}"
    if driver not in (None, "opencode") and me["resolution"] != "resolved":
        # Unresolved native callers get their own owner, never the shared repo-wide local one,
        # so a pending child can't claim or release another caller's lease.
        me["owner"] = f"unresolved:{driver}:{native}"
    return me


def remote_dir_for(root: Path | str) -> str:
    """Remote checkout dir, relative to /home/user. Unique per repo path."""
    root = str(root)
    h = hashlib.sha1(root.encode()).hexdigest()[:6]
    base = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(root).name)[:40] or "repo"
    return f"w/{base}-{h}"
