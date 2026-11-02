#!/opt/homebrew/bin/python3
"""rcsim: registered Run Cloud simulators with heartbeats.

Every Run Cloud iOS simulator / Android emulator an agent uses goes through
rcsim. It creates the session, tags it with the owning Robob thread (and the
parent thread when the owner is a subagent), registers it locally, and sends
Abdullah the label and viewer link on Telegram. The owner heartbeats every
15 minutes; the monitor (LaunchAgent com.ardud.rcsim-monitor, every 60s)
steers threads that miss a heartbeat, deletes simulators whose thread is gone
and deletes simulators nobody keeps alive.

State: ~/.local/share/rcsim/rcsim.db (sqlite). Log: ~/.local/share/rcsim/monitor.log.
The signed viewer URL is a secret: never printed, only sent to Telegram.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path.home()
STATE_DIR = HOME / ".local/share/rcsim"
DB_PATH = STATE_DIR / "rcsim.db"
LOG_PATH = STATE_DIR / "monitor.log"
TOUCH_LOG = STATE_DIR / "touch.log"
LOCK_PATH = STATE_DIR / "monitor.lock"
RUNCLOUD = str(HOME / ".local/bin/runcloud")
# rcsim's own component credential first, the old shared file last.
CTL_CFGS = (HOME / ".robob/components/rcsim.json", HOME / ".robob/ardud-control.json")
OC_URL = "http://127.0.0.1:49374"
OC_PW = HOME / ".config/opencode-service/password"
BUN = str(HOME / ".bun/bin/bun")
TG_CLI = str(HOME / ".local/share/telegram-bridge/src/cli.ts")
TZ = ZoneInfo("Asia/Dubai")

HEARTBEAT_S = 15 * 60          # owners heartbeat at least this often
MISS_S = HEARTBEAT_S + 60       # 1 min slack before a miss counts
DELETE_S = 25 * 60              # no heartbeat for this long -> delete (10 min after the warning)
ORPHAN_GRACE_S = 15 * 60        # untagged sims found by the monitor get this long to be claimed
DEFAULT_HARD = "45m"
MAX_HARD_S = 75 * 60            # Run Cloud maximum
PLATFORMS = ("ios", "android")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
AUTO_PREFIX = "[Automated message from the rcsim monitor (run-cloud skill), not typed by Abdullah.]"


# ---------------------------------------------------------------- helpers

def now() -> float:
    return time.time()


def hhmm(ts: float | None) -> str:
    if not ts:
        return "?"
    return dt.datetime.fromtimestamp(ts, TZ).strftime("%H:%M")


def iso_ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def mins(seconds: float) -> str:
    return f"{int(seconds // 60)}m"


def log(msg: str) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a") as f:
        f.write(f"{stamp} {msg}\n")


def redact(obj):
    if isinstance(obj, dict):
        return {k: ("<redacted>" if k in ("url", "viewerUrl", "signedUrl") else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def parse_duration(s: str) -> int | None:
    m = re.fullmatch(r"(\d+)(s|m|h)", s.strip())
    if not m:
        return None
    return int(m.group(1)) * {"s": 1, "m": 60, "h": 3600}[m.group(2)]


def die(msg: str, code: int = 2) -> None:
    print(f"rcsim: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- storage

def db() -> sqlite3.Connection:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS sims (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          name TEXT,
          purpose TEXT,
          owner_thread TEXT,
          owner_ses TEXT,
          owner_title TEXT,
          manager_thread TEXT,
          handoff_to TEXT,
          created_at REAL,
          expires_at REAL,
          last_hb REAL,
          hb_by TEXT,
          warned_at REAL,
          warn_count INTEGER DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'active',
          released_at REAL,
          release_reason TEXT,
          source TEXT,
          launch_id TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
          ts REAL, sim_id TEXT, kind TEXT, detail TEXT
        );
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        """
    )
    return con


def event(con, sim_id: str, kind: str, detail: str = "") -> None:
    con.execute("INSERT INTO events VALUES (?,?,?,?)", (now(), sim_id, kind, detail))
    con.commit()


def get_row(con, sid: str):
    return con.execute("SELECT * FROM sims WHERE id=?", (sid,)).fetchone()


def resolve_id(con, partial: str) -> str:
    if UUID_RE.match(partial):
        return partial
    rows = con.execute("SELECT id FROM sims WHERE id LIKE ?", (partial + "%",)).fetchall()
    if len(rows) == 1:
        return rows[0]["id"]
    if not rows:
        die(f"no registered simulator matches '{partial}' (use the full id)")
    die(f"'{partial}' is ambiguous: " + ", ".join(r["id"] for r in rows))
    return ""


# ---------------------------------------------------------------- external calls

def rc(args: list[str], timeout: int = 240):
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    env["RCSIM_INTERNAL"] = "1"
    try:
        p = subprocess.run([RUNCLOUD, *args], env=env, stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, None, "", "timeout"
    data = None
    try:
        data = json.loads(p.stdout) if p.stdout.strip() else None
    except json.JSONDecodeError:
        pass
    return p.returncode, data, p.stdout, p.stderr


def ctl(method: str, path: str, body: dict | None = None, timeout: int = 15):
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


def q(tid: str) -> str:
    return urllib.parse.quote(tid, safe="")


def thread_get(tid: str):
    """-> ('ok'|'gone'|'unknown', thread dict|None)."""
    st, d = ctl("GET", "/threads/" + q(tid))
    if st == 200 and d.get("thread"):
        t = d["thread"]
        if t.get("archived"):
            return "gone", t
        return "ok", t
    if st == 404:
        return "gone", None
    return "unknown", None


def thread_send(tid: str, text: str, request_id: str, mode: str = "auto") -> str:
    st, d = ctl("POST", "/threads/" + q(tid) + "/send",
                {"text": text, "mode": mode, "clientRequestId": request_id[:120]})
    if st == 200:
        return d.get("delivery") or "sent"
    return f"failed({st}: {(d.get('error') or {}).get('message') if isinstance(d.get('error'), dict) else d.get('error')})"


def opencode_session(ses: str) -> dict | None:
    try:
        pw = OC_PW.read_text().strip()
    except OSError:
        return None
    import base64
    req = urllib.request.Request(f"{OC_URL}/api/session/{q(ses)}", headers={
        "Authorization": "Basic " + base64.b64encode(f"opencode:{pw}".encode()).decode()})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            d = json.load(r)
            return d.get("data") or d
    except urllib.error.HTTPError as e:
        return {"__missing__": True} if e.code == 404 else None
    except Exception:  # noqa: BLE001
        return None


def telegram(text: str, key: str, severity: str = "info") -> bool:
    env = dict(os.environ)
    env.pop("BUN_INSPECT", None)
    try:
        p = subprocess.run([BUN, TG_CLI, "notify", "--source", "run.cloud", "--severity", severity,
                            "--text", text[:4000], "--key", key[:200]],
                           env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=40)
        return p.returncode == 0
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- identity

# The harness env names the caller's native id; the driver says which home it belongs to. Order matters:
# CODEX_THREAD_ID is the concrete thread, CODEX_SESSION_ID is shared by a session's children.
ENV_DRIVERS = (
    ("CLAUDE_CODE_SESSION_ID", "claudeAgent"),
    ("CODEX_THREAD_ID", "codex"),
    ("OPENCODE_SESSION_ID", "opencode"),
)
# Pending/ambiguous/unavailable answers are held for a short burst only, so the next call asks again.
UNRESOLVED_TTL = 5


def caller_native() -> tuple[str | None, str | None]:
    for var, driver in ENV_DRIVERS:
        value = os.environ.get(var) or None
        if value:
            return value, driver
    return None, None


def identity_for(native: str, driver: str) -> dict:
    """C1's resolution for one native id: {resolution, robobThreadId, parentThreadId, executionKind, ...}.

    Every failure (control API down, bad token, unreadable config) comes back as "unavailable", never as
    an unowned caller. Rcsim refuses to create or claim on anything but "resolved".
    """
    st, d = ctl("GET", f"/identity/resolve?nativeId={q(native)}&driver={q(driver)}")
    if st == 200 and isinstance(d, dict) and isinstance(d.get("identity"), dict):
        ident = dict(d["identity"])
    else:
        ident = {"resolution": "unavailable", "robobThreadId": None, "parentThreadId": None,
                 "executionKind": None, "acceptsMessages": False, "candidates": []}
    ident.update(driver=driver, nativeId=native)
    return ident


def whoami(thread: str | None = None, manager: str | None = None, *, ignore_env: bool = False) -> dict:
    """The execution rcsim acts for: owner thread, its title, and its manager (parent) thread.

    The owner is the resolved execution (a Claude or Codex thread, a Claude child with its parent), not the
    shared native session. `resolution` says whether that is known. Anything but "resolved" has no owner.
    """
    native, driver = caller_native()
    me = {"ses": native, "driver": driver, "resolution": None, "executionKind": None,
          "thread": None, "title": None, "manager": None, "relationship": None}
    if driver == "claudeAgent":
        # A Claude shell carries only its session id, which its native children share. No --thread, RCSIM_THREAD
        # or C1 answer can name this one execution, so the check comes before every explicit and env branch. An
        # explicit --thread naming the parent would otherwise be trusted as this caller's owner.
        me["resolution"] = "unresolved"
        me["reason"] = "claude-shared-session"
        if thread or (os.environ.get("RCSIM_THREAD") or None):
            log("claude caller: an explicit or inherited thread is ignored, no owner is taken from a shared session")
        if manager:
            me["manager"] = None if manager == "none" else manager
        return me
    env_thread = None if ignore_env else (os.environ.get("RCSIM_THREAD") or None)
    explicit = thread or env_thread
    if native is not None and driver == "opencode" and explicit is None:
        # OpenCode path, unchanged: the session names the thread through the control API.
        st, d = ctl("GET", "/threads/by-native/" + q(native))
        if st == 200:
            t = d.get("thread") or {}
            me.update(thread=t.get("threadId"), title=t.get("title"), resolution="resolved")
            if t.get("relationshipToParent") == "subagent" and t.get("parentThreadId"):
                me.update(manager=t["parentThreadId"], relationship="subagent")
    elif native is not None and explicit is None:
        ident = identity_for(native, driver)
        me["resolution"] = ident.get("resolution")
        me["executionKind"] = ident.get("executionKind")
        if ident.get("resolution") == "resolved":
            me["thread"] = ident.get("robobThreadId")
            me["manager"] = ident.get("parentThreadId")
            if me["thread"]:
                state, t = thread_get(me["thread"])
                me["title"] = (t or {}).get("title")
            me["relationship"] = "subagent" if me["manager"] else None
    elif explicit is not None:
        # An explicit --thread names the owner the operator chose. It counts only when it is this execution or
        # one of its ancestors. RCSIM_THREAD is inherited shell state: it can never replace a resolved owner,
        # because an inherited parent id would hand the child's work (and its siblings') to the parent.
        state, t = thread_get(explicit)
        if state == "gone":
            die(f"thread {explicit} not found or archived")
        ident = identity_for(native, driver) if native is not None else None
        if thread is None and ident is not None and ident.get("resolution") == "resolved":
            # Inherited RCSIM_THREAD: keep the resolved execution as the owner and drop the env value.
            # An ancestor value is only informational here, so it is logged and ignored.
            if explicit != ident.get("robobThreadId"):
                log(f"RCSIM_THREAD ignored: the resolved execution owns this call, not the inherited {explicit}")
            return whoami(None, manager, ignore_env=True)
        if ident is not None and ident.get("resolution") == "resolved":
            allowed = {ident.get("robobThreadId"), ident.get("parentThreadId")} - {None}
            if explicit not in allowed:
                die(f"--thread {explicit} is not this session's thread or its parent")
        me.update(thread=explicit, title=(t or {}).get("title"),
                  resolution="resolved" if (ident is None or ident.get("resolution") == "resolved") else
                  ident.get("resolution"))
        if t and t.get("relationshipToParent") == "subagent" and t.get("parentThreadId"):
            me.update(manager=t["parentThreadId"], relationship="subagent")
    if manager:
        me["manager"] = None if manager == "none" else manager
    return me


def refuse_unresolved(me: dict, action: str) -> None:
    """Rcsim only acts for a resolved execution. Pending, ambiguous and unavailable never fall back to an
    unowned or shared-session owner."""
    if me.get("reason") == "claude-shared-session":
        die(f"{action} refused: a Claude shell shares its session id with its native children, so it can't be "
            f"told apart from them. Claude callers can't own simulators; use a Codex or OpenCode thread, or an "
            f"iMessage-driven one. Nothing was changed.")
    if me.get("resolution") != "resolved" or not me.get("thread"):
        die(f"{action} refused: this caller is not resolved to a Robob thread yet "
            f"(resolution={me.get('resolution') or 'none'}). Retry in a few seconds; nothing was created.")


def refuse_native_unproven(me: dict, action: str) -> None:
    """Explicit-id mutations (release by id, handoff, heartbeat by id) act on a named simulator. A plain operator
    shell has no native driver and keeps working. A native caller that isn't resolved to an execution must not
    change another execution's simulator, so it is refused the same way as --mine."""
    if me.get("driver") in ("claudeAgent", "codex") and (me.get("resolution") != "resolved" or not me.get("thread")):
        refuse_unresolved(me, action)


# ---------------------------------------------------------------- create / launch

def register(con, sess: dict, platform: str, me: dict, purpose: str | None, source: str,
             launch_id: str | None = None) -> None:
    created = iso_ts(sess.get("createdAt")) or now()
    con.execute(
        """INSERT OR REPLACE INTO sims (id, platform, name, purpose, owner_thread, owner_ses, owner_title,
               manager_thread, handoff_to, created_at, expires_at, last_hb, hb_by, warned_at, warn_count,
               state, released_at, release_reason, source, launch_id)
           VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL,0,'active',NULL,NULL,?,?)""",
        (sess["id"], platform, sess.get("displayName"), purpose, me.get("thread"), me.get("ses"),
         me.get("title"), me.get("manager"), created, iso_ts(sess.get("expiresAt")),
         now(), me.get("thread") or me.get("ses") or "cli", source, launch_id))
    con.commit()
    event(con, sess["id"], "register", f"source={source} owner={me.get('thread')} manager={me.get('manager')}")


def announce(sess: dict, platform: str, me: dict, purpose: str | None) -> bool:
    url = sess.get("url")
    lines = [f"Run Cloud {'iOS simulator' if platform == 'ios' else 'Android emulator'} up: {sess.get('displayName') or sess['id'][:8]}"]
    if me.get("title"):
        lines.append(f"Thread: {me['title']}")
    if purpose:
        lines.append(f"Purpose: {purpose}")
    lines.append(f"Id: {sess['id']}")
    lines.append(f"Hard stop: {hhmm(iso_ts(sess.get('expiresAt')))} (Dubai)")
    if url:
        lines.append(url)
    return telegram("\n".join(lines), f"rcsim:{sess['id']}:up")


def label_args(me: dict, purpose: str | None) -> list[str]:
    out = ["--label", "rcsim=1"]
    if me.get("thread"):
        out += ["--label", f"owner-thread={me['thread']}"]
    if me.get("ses"):
        out += ["--label", f"owner-ses={me['ses']}"]
    if me.get("manager"):
        out += ["--label", f"manager-thread={me['manager']}"]
    if purpose:
        out += ["--label", f"purpose={purpose[:120]}"]
    return out


def default_name(me: dict, platform: str) -> str:
    base = (me.get("title") or "agent").strip()
    base = re.sub(r"\s+", " ", base)[:40]
    return f"{base} [{platform}]"


def check_hard(h: str) -> str:
    s = parse_duration(h)
    if s is None or s < 60 or s > MAX_HARD_S:
        die("--hard-timeout must look like 30m / 1h and be between 1m and 75m (Run Cloud max)")
    return h


def print_created(sess: dict, platform: str, me: dict, notified: bool, as_json: bool) -> None:
    if as_json:
        out = redact(sess)
        out["rcsim"] = {"ownerThread": me.get("thread"), "managerThread": me.get("manager"),
                        "telegram": notified, "heartbeatEverySeconds": HEARTBEAT_S}
        print(json.dumps(out, indent=1))
        return
    exp = iso_ts(sess.get("expiresAt"))
    print(f"id: {sess['id']}")
    print(f"platform: {platform}  status: {sess.get('status')}  name: {sess.get('displayName')}")
    print(f"owner thread: {me.get('thread') or '(none: not running in a Robob thread)'}")
    if me.get("manager"):
        print(f"manager thread: {me['manager']}")
    print(f"hard stop: {hhmm(exp)} Dubai ({sess.get('expiresAt')})  telegram link sent: {'yes' if notified else 'NO'}")
    print(f"next heartbeat due by {hhmm(now() + HEARTBEAT_S)}: rcsim heartbeat {sess['id']}")
    print(f"release when done: rcsim release {sess['id']}")


def cmd_create(a) -> None:
    me = whoami(a.thread, a.manager)
    refuse_unresolved(me, "create")
    con = db()
    hard = check_hard(a.hard_timeout)
    args = [a.platform, "create", "--json", "--display-name", a.name or default_name(me, a.platform),
            "--hard-timeout", hard, "--inactivity-timeout", a.inactivity_timeout, *label_args(me, a.purpose)]
    if a.model:
        args += ["--model", a.model]
    if a.region:
        args += ["--region", a.region]
    if a.install:
        args += ["--install", a.install]
    if a.install_asset:
        args += ["--install-asset", a.install_asset]
    code, data, out, err = rc(args)
    if code != 0 or not isinstance(data, dict) or not data.get("id"):
        print(json.dumps(redact(data)) if data else (out + err).strip(), file=sys.stderr)
        die("runcloud create failed", 1)
    register(con, data, a.platform, me, a.purpose, "rcsim")
    notified = False if a.no_notify else announce(data, a.platform, me, a.purpose)
    print_created(data, a.platform, me, notified, a.json)


def cmd_launch(a) -> None:
    if bool(a.build) == bool(a.asset):
        die("pass exactly one of --build BUILD_ID or --asset ASSET_ID")
    me = whoami(a.thread, a.manager)
    refuse_unresolved(me, "launch")
    con = db()
    hard = check_hard(a.hard_timeout)
    key = a.idempotency_key or f"rcsim-{a.platform}-{a.build or a.asset}-{int(now())}"
    args = ["mobile", "launch", "--platform", a.platform, "--idempotency-key", key, "--json",
            "--display-name", a.name or default_name(me, a.platform), "--hard-timeout", hard,
            "--inactivity-timeout", a.inactivity_timeout, *label_args(me, a.purpose)]
    args += ["--build", a.build] if a.build else ["--asset", a.asset]
    if a.model:
        args += ["--model", a.model]
    if a.region:
        args += ["--region", a.region]
    code, data, out, err = rc(args, timeout=900)
    sess = (data or {}).get("session") if isinstance(data, dict) else None
    if code != 0 or not sess or not sess.get("id"):
        print(json.dumps(redact(data)) if data else (out + err).strip(), file=sys.stderr)
        die("runcloud mobile launch failed", 1)
    register(con, sess, a.platform, me, a.purpose, "rcsim", launch_id=data.get("id"))
    notified = False if a.no_notify else announce(sess, a.platform, me, a.purpose)
    print_created(sess, a.platform, me, notified, a.json)


# ---------------------------------------------------------------- lifecycle commands

def my_active(con, me: dict):
    """Simulators this execution owns. Matched on the exact owner thread: a Claude or Codex session id is
    shared by a session's children, so it never names one execution. Legacy rows that carry only an
    OpenCode session id still match that session, and only when this caller is that OpenCode session."""
    rows = con.execute("SELECT * FROM sims WHERE state='active'").fetchall()
    out = []
    for r in rows:
        if me.get("thread") and r["owner_thread"] == me["thread"]:
            out.append(r)
        elif (not r["owner_thread"] and me.get("driver") == "opencode" and me.get("ses")
              and r["owner_ses"] == me["ses"]):
            out.append(r)
    return out


def cmd_heartbeat(a) -> None:
    con = db()
    me = whoami(a.thread)
    if a.ids:
        refuse_native_unproven(me, "heartbeat")
    ids = [resolve_id(con, i) for i in a.ids] if a.ids else [r["id"] for r in my_active(con, me)]
    if not ids:
        die("no active simulators registered to this thread (pass ids explicitly)", 1)
    who = me.get("thread") or me.get("ses") or "cli"
    for sid in ids:
        row = get_row(con, sid)
        if not row or row["state"] != "active":
            print(f"{sid}: not active ({row['release_reason'] if row else 'unregistered'}); nothing to heartbeat")
            continue
        con.execute("UPDATE sims SET last_hb=?, hb_by=?, warned_at=NULL WHERE id=?", (now(), who, sid))
        con.commit()
        event(con, sid, "heartbeat", who)
        left = (row["expires_at"] or 0) - now()
        print(f"{sid}: heartbeat ok, next due by {hhmm(now() + HEARTBEAT_S)}; hard stop {hhmm(row['expires_at'])} ({mins(max(left, 0))} left)")


def release(con, row, reason: str) -> tuple[bool, str]:
    code, data, out, err = rc([row["platform"], "delete", row["id"], "--json"], timeout=120)
    gone = code == 0 or (isinstance(data, dict) and (data.get("error") or {}).get("httpStatus") == 404) \
        or "not found" in (out + err).lower()
    status = (data or {}).get("status") if isinstance(data, dict) else None
    if gone:
        con.execute("UPDATE sims SET state='released', released_at=?, release_reason=? WHERE id=?",
                    (now(), reason, row["id"]))
        con.commit()
        event(con, row["id"], "release", reason)
        return True, status or "released"
    return False, (json.dumps(redact(data)) if data else (out + err).strip())[:300]


def cmd_release(a) -> None:
    con = db()
    me = whoami(a.thread)
    if a.mine:
        # "Nothing to release" from an unresolved caller would hide its simulators behind a pending mapping.
        refuse_unresolved(me, "release --mine")
        rows = my_active(con, me)
    elif a.ids:
        refuse_native_unproven(me, "release")
        rows = [get_row(con, resolve_id(con, i)) for i in a.ids]
    else:
        die("pass ids or --mine")
    if not rows:
        print("nothing to release")
        return
    who = me.get("thread") or me.get("ses") or "cli"
    failed = False
    for i, row in enumerate(rows):
        if row is None:
            # unregistered id: try both platforms
            sid = a.ids[i]
            for plat in PLATFORMS:
                code, *_ = rc([plat, "delete", sid, "--json"])
                if code == 0:
                    print(f"{sid}: released (unregistered {plat})")
                    break
            else:
                print(f"{sid}: not found")
            continue
        if row["state"] != "active":
            print(f"{row['id']}: already {row['state']} ({row['release_reason']})")
            continue
        ok, info = release(con, row, f"released by {who}")
        failed |= not ok
        print(f"{row['id']}: {'released' if ok else 'DELETE FAILED: ' + info}")
    sys.exit(1 if failed else 0)


def cmd_claim(a) -> None:
    con = db()
    me = whoami(a.thread, a.manager)
    # Before any discovery or write: a pending, ambiguous or unavailable caller must not overwrite an owner or
    # register a simulator under a shared or missing identity.
    refuse_unresolved(me, "claim")
    for raw in a.ids:
        sid = resolve_id(con, raw)
        row = get_row(con, sid)
        if row is None:
            sess, plat = find_live(sid)
            if not sess:
                print(f"{sid}: no active Run Cloud session with that id")
                continue
            register(con, sess, plat, me, a.purpose, "claimed")
            print(f"{sid}: registered to this thread")
            continue
        if row["state"] != "active":
            print(f"{sid}: already {row['state']} ({row['release_reason']})")
            continue
        prev = row["owner_thread"]
        con.execute("""UPDATE sims SET owner_thread=?, owner_ses=?, owner_title=?, manager_thread=?,
                       handoff_to=NULL, last_hb=?, hb_by=?, warned_at=NULL, purpose=COALESCE(?, purpose),
                       source=CASE WHEN source='orphan' THEN 'claimed' ELSE source END
                       WHERE id=?""",
                    (me.get("thread"), me.get("ses"), me.get("title"), me.get("manager"), now(),
                     me.get("thread") or me.get("ses"), a.purpose, sid))
        con.commit()
        event(con, sid, "claim", f"from={prev} to={me.get('thread')}")
        print(f"{sid}: claimed (was {prev or 'unowned'}); heartbeat every 15 min, next by {hhmm(now() + HEARTBEAT_S)}")


def cmd_handoff(a) -> None:
    con = db()
    me = whoami(a.thread)
    refuse_native_unproven(me, "handoff")
    sid = resolve_id(con, a.id)
    row = get_row(con, sid)
    if not row or row["state"] != "active":
        die(f"{sid} is not an active registered simulator")
    state, t = thread_get(a.to)
    if state != "ok":
        die(f"target thread {a.to} is {state}")
    con.execute("UPDATE sims SET handoff_to=? WHERE id=?", (a.to, sid))
    con.commit()
    event(con, sid, "handoff", f"from={me.get('thread')} to={a.to}")
    note = f"\nNote from the previous owner: {a.note}" if a.note else ""
    text = (f"{AUTO_PREFIX}\nThread '{me.get('title') or me.get('thread') or 'unknown'}' is handing you Run Cloud "
            f"{row['platform']} simulator '{row['name']}' ({sid}). Load the run-cloud skill, then either "
            f"`rcsim claim {sid}` (you then heartbeat it every 15 min with `rcsim heartbeat`) or "
            f"`rcsim release {sid}` if you don't need it. It is billed per minute until released.{note}")
    delivery = thread_send(a.to, text, f"rcsim:{sid}:handoff:{a.to}:{int(now() // 60)}")
    print(f"{sid}: handoff to {a.to} pending ({delivery}). You stay responsible until it claims; rerun this command to ping it again.")


def cmd_link(a) -> None:
    con = db()
    sid = resolve_id(con, a.id)
    sess, plat = find_live(sid)
    if not sess:
        die(f"{sid} is not active")
    row = get_row(con, sid)
    me = {"title": row["owner_title"] if row else None}
    ok = telegram(
        f"Run Cloud {plat} viewer: {sess.get('displayName')}\n"
        + (f"Thread: {me['title']}\n" if me["title"] else "")
        + f"Hard stop: {hhmm(iso_ts(sess.get('expiresAt')))} (Dubai)\n{sess.get('url')}",
        f"rcsim:{sid}:link:{int(now())}")
    print("viewer link sent to Telegram" if ok else "telegram send failed")


def find_live(sid: str):
    for plat in PLATFORMS:
        code, data, *_ = rc([plat, "get", sid, "--json"], timeout=60)
        if code == 0 and isinstance(data, dict) and data.get("id") == sid:
            return (data if data.get("status") == "active" else None), plat
    return None, None


def cmd_list(a) -> None:
    con = db()
    sql = "SELECT * FROM sims" + ("" if a.all else " WHERE state='active'") + " ORDER BY created_at DESC"
    rows = con.execute(sql).fetchall()
    if a.json:
        print(json.dumps([dict(r) for r in rows], indent=1))
        return
    if not rows:
        print("no active registered simulators" if not a.all else "no simulators recorded")
        return
    t = now()
    for r in rows:
        hb = f"hb {mins(t - r['last_hb'])} ago" if r["last_hb"] else "no hb"
        extra = f" handoff->{r['handoff_to']}" if r["handoff_to"] else ""
        rel = f" [{r['state']}: {r['release_reason']}]" if r["state"] != "active" else ""
        print(f"{r['id']}  {r['platform']:<7} {r['name'] or '-'} | {hb} | stop {hhmm(r['expires_at'])}"
              f" | owner {r['owner_title'] or r['owner_thread'] or r['owner_ses'] or '-'}"
              f"{' | manager ' + r['manager_thread'] if r['manager_thread'] else ''}{extra}{rel}")


def cmd_whoami(a) -> None:
    print(json.dumps(whoami(a.thread), indent=1))


# ---------------------------------------------------------------- monitor

def fold_touches(con) -> None:
    """runcloud wrapper appends '<epoch> <uuid>' for every call that names a session: counts as a heartbeat."""
    if not TOUCH_LOG.exists():
        return
    tmp = TOUCH_LOG.with_suffix(".processing")
    try:
        os.replace(TOUCH_LOG, tmp)
    except OSError:
        return
    latest: dict[str, float] = {}
    for line in tmp.read_text(errors="ignore").splitlines():
        parts = line.split()
        if len(parts) >= 2 and UUID_RE.match(parts[1]):
            try:
                latest[parts[1]] = max(latest.get(parts[1], 0), float(parts[0]))
            except ValueError:
                pass
    tmp.unlink(missing_ok=True)
    for sid, ts in latest.items():
        con.execute("UPDATE sims SET last_hb=?, hb_by='interaction', warned_at=NULL "
                    "WHERE id=? AND state='active' AND (last_hb IS NULL OR last_hb < ?)", (ts, sid, ts))
    con.commit()


def describe(row) -> str:
    kind = "iOS simulator" if row["platform"] == "ios" else "Android emulator"
    return f"Run Cloud {kind} '{row['name']}' ({row['id']})"


def notify_threads(con, row, kind: str, body: str, owner_state: str, owner_thread: dict | None,
                   dry: bool) -> list[str]:
    """Message the owner (steer/wake) and the manager. Returns delivery notes."""
    notes = []
    targets = []
    manager_ok = bool(row["manager_thread"]) and thread_get(row["manager_thread"])[0] == "ok"
    # A finished subagent can't act on it; its manager (parent) gets the message instead.
    owner_is_done_subagent = (owner_thread or {}).get("relationshipToParent") == "subagent" and \
        (owner_thread or {}).get("state") not in ("running", "queued", "needs-input")
    if row["owner_thread"] and owner_state == "ok" and not (owner_is_done_subagent and manager_ok):
        targets.append(("owner", row["owner_thread"], body))
    if manager_ok:
        mbody = body + ("\n(You get this because your subagent owns this simulator."
                        " If that subagent is finished or stuck, claim it (`rcsim claim ID`) or release it yourself.)")
        targets.append(("manager", row["manager_thread"], mbody))
    if row["handoff_to"]:
        hstate, _ = thread_get(row["handoff_to"])
        if hstate == "ok":
            targets.append(("handoff", row["handoff_to"],
                            body + f"\n(This simulator was handed to you. Run `rcsim claim {row['id']}` to take it over,"
                                   f" or `rcsim release {row['id']}`.)"))
    for role, tid, text in targets:
        rid = f"rcsim:{row['id']}:{kind}:{role}:{row['warn_count']}"
        res = "dry-run" if dry else thread_send(tid, f"{AUTO_PREFIX}\n{text}", rid)
        notes.append(f"{role}={res}")
    return notes


def monitor(dry: bool = False) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    con = db()
    fold_touches(con)
    t = now()
    # Nothing registered: look for unregistered sessions every 5 min instead of every minute.
    active_n = con.execute("SELECT count(*) FROM sims WHERE state='active'").fetchone()[0]
    last_scan = float((con.execute("SELECT v FROM kv WHERE k='last_scan'").fetchone() or ["0"])[0])
    if active_n == 0 and t - last_scan < 290 and not dry:
        return
    con.execute("INSERT OR REPLACE INTO kv VALUES ('last_scan', ?)", (str(t),))
    con.commit()
    live: dict[str, dict] = {}
    for plat in PLATFORMS:
        code, data, out, err = rc([plat, "list", "--json"], timeout=90)
        if code != 0 or not isinstance(data, list):
            log(f"list {plat} failed rc={code}: {(err or out)[:200]}")
            return  # never act on partial data
        for s in data:
            if s.get("status") == "active":
                live[s["id"]] = dict(s, platform=plat)

    # 1. registered sims that are no longer live
    for row in con.execute("SELECT * FROM sims WHERE state='active'").fetchall():
        if row["id"] in live:
            continue
        exp = row["expires_at"] or 0
        reason = "hard timeout" if exp and t >= exp - 5 else "released outside rcsim"
        if not dry:
            con.execute("UPDATE sims SET state='released', released_at=?, release_reason=? WHERE id=?",
                        (t, reason, row["id"]))
            con.commit()
            event(con, row["id"], "gone", reason)
        log(f"{row['id']} no longer active ({reason})")

    # 2. live sims we don't know: adopt from tags, else orphan
    for sid, s in live.items():
        if get_row(con, sid):
            continue
        tags = s.get("tags") or {}
        me = {"thread": tags.get("owner-thread"), "ses": tags.get("owner-ses"),
              "manager": tags.get("manager-thread"), "title": None}
        if me["thread"]:
            st, th = thread_get(me["thread"])
            me["title"] = (th or {}).get("title")
        source = "adopted" if (me["thread"] or me["ses"] or me["manager"]) else "orphan"
        if dry:
            log(f"dry: would register {sid} as {source}")
            continue
        register(con, s, s["platform"], me, tags.get("purpose"), source)
        # adopted/orphan sims start their clock at creation, not now
        created = iso_ts(s.get("createdAt")) or t
        con.execute("UPDATE sims SET last_hb=? WHERE id=?", (created if source == "adopted" else t, sid))
        con.commit()
        log(f"registered {sid} as {source}")
        if source == "orphan":
            telegram(f"Unregistered Run Cloud {s['platform']} session '{s.get('displayName')}' ({sid}) is running. "
                     f"Deleting it at {hhmm(t + ORPHAN_GRACE_S)} unless an agent runs `rcsim claim {sid}`."
                     + (f"\n{s['url']}" if s.get("url") else ""),
                     f"rcsim:{sid}:orphan", "info")
        else:
            announce(s, s["platform"], me, tags.get("purpose"))

    # 3. enforce ownership + heartbeats
    for row in con.execute("SELECT * FROM sims WHERE state='active'").fetchall():
        sid = row["id"]
        if sid not in live:
            continue
        age = t - (row["last_hb"] or row["created_at"] or t)
        left = (row["expires_at"] or t) - t

        if row["source"] == "orphan" and not row["owner_thread"]:
            if age >= ORPHAN_GRACE_S:
                act_delete(con, row, "unregistered and unclaimed", None, "gone", dry)
            continue

        owner_state, owner_thread = ("none", None)
        if row["owner_thread"]:
            owner_state, owner_thread = thread_get(row["owner_thread"])
        elif row["owner_ses"]:
            owner_state = legacy_owner_state(row["owner_ses"])

        if owner_state == "gone":
            # a pending handoff target inherits it; otherwise delete right away
            if row["handoff_to"] and thread_get(row["handoff_to"])[0] == "ok":
                if not dry:
                    _, nt = thread_get(row["handoff_to"])
                    con.execute("UPDATE sims SET owner_thread=?, owner_title=?, owner_ses=NULL, handoff_to=NULL,"
                                " last_hb=?, warned_at=NULL WHERE id=?",
                                (row["handoff_to"], (nt or {}).get("title"), t, sid))
                    con.commit()
                    event(con, sid, "transfer", f"owner gone -> {row['handoff_to']}")
                    thread_send(row["handoff_to"], f"{AUTO_PREFIX}\nThe thread that handed you {describe(row)} is gone, "
                                f"so it is yours now. Heartbeat it every 15 min (`rcsim heartbeat {sid}`) or "
                                f"`rcsim release {sid}` if you don't need it.", f"rcsim:{sid}:transfer")
                log(f"{sid} owner gone, transferred to {row['handoff_to']}")
                continue
            act_delete(con, row, "owner thread is gone or archived", None, "gone", dry)
            continue

        if age >= DELETE_S and row["warned_at"]:
            act_delete(con, row, f"no heartbeat for {mins(age)}", owner_thread, owner_state, dry)
            continue

        if age >= MISS_S and not row["warned_at"]:
            body = (f"{describe(row)} owned by this thread missed its heartbeat (last one {mins(age)} ago; "
                    f"hard stop {hhmm(row['expires_at'])}, {mins(max(left, 0))} left). It is billed per minute.\n"
                    f"- Still using it: `rcsim heartbeat {sid}` now, then every 15 min.\n"
                    f"- Done with it: `rcsim release {sid}`.\n"
                    f"- Another thread took over: `rcsim handoff {sid} --to <threadId>`.\n"
                    f"Without a heartbeat it is deleted automatically at {hhmm(row['last_hb'] + DELETE_S)}.")
            notes = notify_threads(con, row, "miss", body, owner_state, owner_thread, dry)
            if not notes:
                telegram(f"{describe(row)} missed its heartbeat and its thread can't be reached "
                         f"(owner: {row['owner_title'] or row['owner_thread'] or row['owner_ses'] or 'unknown'}). "
                         f"Deleting at {hhmm(row['last_hb'] + DELETE_S)}.", f"rcsim:{sid}:miss:{int(row['last_hb'])}")
            if not dry:
                con.execute("UPDATE sims SET warned_at=?, warn_count=warn_count+1 WHERE id=?", (t, sid))
                con.commit()
                event(con, sid, "miss-warning", "; ".join(notes))
            log(f"{sid} missed heartbeat ({mins(age)}): {'; '.join(notes) or 'telegram only'}")
    con.execute("INSERT OR REPLACE INTO kv VALUES ('last_monitor', ?)", (str(t),))
    con.commit()


UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def legacy_owner_state(owner_ses: str) -> str:
    """Liveness for a row that names only a session (no owner thread).

    OpenCode session ids keep the OpenCode check. A Claude or Codex id is a UUID that OpenCode never knows:
    asking OpenCode would 404 and read as dead. Those are resolved through the identity map, and a UUID is
    only ever "ok" (resolved to a thread) or "unknown". It is never "gone" from a failed or pending lookup,
    so an unresolved UUID keeps its simulator.
    """
    if not UUID_RE.fullmatch(owner_ses):
        info = opencode_session(owner_ses)
        return "gone" if (info or {}).get("__missing__") else ("ok" if info else "unknown")
    for driver in ("claudeAgent", "codex"):
        ident = identity_for(owner_ses, driver)
        if ident.get("resolution") == "resolved" and ident.get("robobThreadId"):
            return "ok"
    return "unknown"


def act_delete(con, row, reason: str, owner_thread: dict | None, owner_state: str, dry: bool) -> None:
    if dry:
        log(f"dry: would delete {row['id']} ({reason})")
        return
    ok, info = release(con, row, f"monitor: {reason}")
    log(f"{row['id']} delete ({reason}): {'ok' if ok else 'FAILED ' + info}")
    if not ok:
        telegram(f"rcsim monitor could not delete {describe(row)}: {info}", f"rcsim:{row['id']}:delete-failed", "error")
        return
    telegram(f"Deleted {describe(row)}: {reason}. Owner: {row['owner_title'] or row['owner_thread'] or row['owner_ses'] or 'none'}.",
             f"rcsim:{row['id']}:deleted", "info")
    if owner_state == "ok" and (owner_thread or {}).get("state") in ("running", "queued"):
        thread_send(row["owner_thread"], f"{AUTO_PREFIX}\n{describe(row)} was deleted: {reason}. "
                    f"Create a new one with `rcsim create` if you still need a simulator.", f"rcsim:{row['id']}:deleted")


# ---------------------------------------------------------------- cli

def main() -> None:
    p = argparse.ArgumentParser(prog="rcsim", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    def common_create(sp):
        sp.add_argument("platform", choices=PLATFORMS)
        sp.add_argument("--name", help="display name / label shown in Telegram and the dashboard")
        sp.add_argument("--purpose", help="one line: what this simulator is for")
        sp.add_argument("--model", help="iphone|ipad (ios) or pixel (android)")
        sp.add_argument("--region")
        sp.add_argument("--hard-timeout", default=DEFAULT_HARD, help="max lifetime, <=75m (default 45m)")
        sp.add_argument("--inactivity-timeout", default="none",
                        help="viewer-enforced idle timeout (default none; heartbeats + hard timeout protect cost)")
        sp.add_argument("--thread", help="owner Robob thread id (default: this session's thread)")
        sp.add_argument("--manager", help="manager thread id (default: parent thread for subagents; 'none' to disable)")
        sp.add_argument("--no-notify", action="store_true", help="skip the Telegram link (rare)")
        sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("create", help="create a simulator/emulator session")
    common_create(sp)
    sp.add_argument("--install", help="app file to install (.app tar.gz/.zip for iOS sim, .apk)")
    sp.add_argument("--install-asset", help="Run Cloud asset id/name to install")
    sp.set_defaults(fn=cmd_create)

    sp = sub.add_parser("launch", help="create a session from an Xcode build or asset (runcloud mobile launch)")
    common_create(sp)
    sp.add_argument("--build", help="installable runcloud xcode build id")
    sp.add_argument("--asset", help="asset id")
    sp.add_argument("--idempotency-key")
    sp.set_defaults(fn=cmd_launch)

    sp = sub.add_parser("heartbeat", help="keep simulators alive (default: all owned by this thread)")
    sp.add_argument("ids", nargs="*")
    sp.add_argument("--thread")
    sp.set_defaults(fn=cmd_heartbeat)

    sp = sub.add_parser("release", help="delete simulators (stops billing)")
    sp.add_argument("ids", nargs="*")
    sp.add_argument("--mine", action="store_true", help="every active simulator owned by this thread")
    sp.add_argument("--thread")
    sp.set_defaults(fn=cmd_release)

    sp = sub.add_parser("claim", help="take ownership (new thread after a handoff, or an unregistered session)")
    sp.add_argument("ids", nargs="+")
    sp.add_argument("--purpose")
    sp.add_argument("--thread")
    sp.add_argument("--manager")
    sp.set_defaults(fn=cmd_claim)

    sp = sub.add_parser("handoff", help="ask another thread to claim a simulator (rerun to ping it again)")
    sp.add_argument("id")
    sp.add_argument("--to", required=True, help="target thread id")
    sp.add_argument("--note")
    sp.add_argument("--thread")
    sp.set_defaults(fn=cmd_handoff)

    sp = sub.add_parser("link", help="send the viewer link to Abdullah on Telegram again")
    sp.add_argument("id")
    sp.set_defaults(fn=cmd_link)

    sp = sub.add_parser("list", help="registered simulators")
    sp.add_argument("--all", action="store_true")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(fn=cmd_list)

    sp = sub.add_parser("whoami", help="show the owner/manager thread rcsim resolves for this shell")
    sp.add_argument("--thread")
    sp.set_defaults(fn=cmd_whoami)

    sp = sub.add_parser("monitor", help="one monitor pass (run by the LaunchAgent every 60s)")
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(fn=lambda a: monitor(a.dry_run))

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
