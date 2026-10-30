"""Shared paths, state DB, locking, logging for offbox."""

from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import json
import os
import secrets
import sqlite3
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path.home()
STATE = HOME / ".local/share/offbox"
DB_PATH = STATE / "offbox.db"
LOG_PATH = STATE / "offbox.log"
LOGS_DIR = STATE / "logs"
LOCKS_DIR = STATE / "locks"
SSH_DIR = STATE / "ssh"
CM_DIR = STATE / "cm"
KEY_PATH = STATE / "id_ed25519"
EXEMPTIONS = STATE / "exemptions.json"
CAP_PATH = STATE / "cap.json"
LOCAL_SEM = STATE / "local.sem"
SKILL_DIR = HOME / ".config/opencode/skills/remote-compute"
TEMPLATES_DIR = SKILL_DIR / "templates"
TZ = ZoneInfo("Asia/Dubai")

EXIT_INFRA = 90
EXIT_CAP = 91
EXIT_BUSY = 92                 # every pool box stayed busy for the whole queue wait; nothing ran, retry

IDLE_STOP_S = 20 * 60          # a lease with no run for this long is stopped (boat ttl + reaper)
RUN_TTL_S = 30 * 60            # ttl while a run is in progress, refreshed every TTL_REFRESH_S
TTL_REFRESH_S = 10 * 60
ARCHIVED_DELETE_S = 7 * 86400  # delete a lease 7 days after its thread is archived
UNUSED_DELETE_S = 30 * 86400   # delete an unpinned lease unused for 30 days
BASES_SOFT_LIMIT = 50
SIZES = ("small", "default", "large", "xlarge")
TEMPLATES = ("crpko-go", "crpko-node", "crpko-harness", "generic")
TOO_BIG_NOTE = "too-big:"        # leases.note prefix: a stopped box whose disk outgrew its machine size


def now() -> float:
    return time.time()


def iso(ts: float | None) -> str:
    if not ts:
        return "-"
    return dt.datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d %H:%M")


def iso_ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def ago(ts: float | None) -> str:
    if not ts:
        return "-"
    s = max(0, now() - ts)
    if s < 120:
        return f"{int(s)}s"
    if s < 7200:
        return f"{int(s // 60)}m"
    if s < 172800:
        return f"{s / 3600:.1f}h"
    return f"{s / 86400:.1f}d"


def month_key(ts: float | None = None) -> str:
    return dt.datetime.fromtimestamp(ts or now(), dt.timezone.utc).strftime("%Y-%m")


def month_start_utc() -> str:
    d = dt.datetime.now(dt.timezone.utc)
    return d.strftime("%Y-%m-01T00:00:00Z")


def ensure_dirs() -> None:
    for d in (STATE, LOGS_DIR, LOCKS_DIR, SSH_DIR, CM_DIR):
        d.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    os.chmod(CM_DIR, 0o700)


def log(msg: str) -> None:
    ensure_dirs()
    stamp = dt.datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a") as f:
        f.write(f"{stamp} [{os.getpid()}] {msg}\n")


def say(msg: str) -> None:
    """Progress line for the human/agent, always on stderr so stdout stays the command's."""
    print(f"offbox: {msg}", file=sys.stderr, flush=True)


def warn_loud(msg: str) -> None:
    bar = "!" * 78
    print(f"\n{bar}\noffbox WARNING: {msg}\n{bar}\n", file=sys.stderr, flush=True)


class OffboxError(Exception):
    """Raised for failures; code 90 = infra (fallback allowed), 91 = cap, 92 = pool busy, 2 = usage."""

    def __init__(self, msg: str, code: int = EXIT_INFRA, started: bool = False):
        super().__init__(msg)
        self.code = code
        self.started = started   # True once the remote command may have started (no local fallback then)


def die(msg: str, code: int = 2):
    print(f"offbox: {msg}", file=sys.stderr)
    sys.exit(code)


def new_id(prefix: str) -> str:
    return f"{prefix}-{dt.datetime.now(TZ).strftime('%m%d-%H%M%S')}-{secrets.token_hex(2)}"


SCHEMA = """
CREATE TABLE IF NOT EXISTS leases (
  box_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,            -- thread id or local:<repo root>
  thread_id TEXT, session_id TEXT, thread_title TEXT, manager_thread TEXT,
  repo_root TEXT NOT NULL, repo_key TEXT NOT NULL, remote_dir TEXT NOT NULL,
  size TEXT, source TEXT,          -- base:<key> | template:<name> | fresh
  state TEXT NOT NULL DEFAULT 'running',   -- running | stopped | deleted | released
  created_at REAL, last_used_at REAL, archive_after REAL,
  pinned_until REAL, thread_gone_since REAL,
  ssh_ready_at REAL, deleted_at REAL, note TEXT
);
CREATE INDEX IF NOT EXISTS leases_owner ON leases(owner, repo_root, state);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, box_id TEXT, owner TEXT, session_id TEXT, thread_id TEXT,
  repo_root TEXT, cwd TEXT, cmd TEXT, size TEXT, mode TEXT,   -- fg | bg | local
  process_id INTEGER, command_id TEXT,
  status TEXT,                     -- starting | running | done | failed | killed | lost | infra
  exit_code INTEGER, start_at REAL, end_at REAL,
  sync_s REAL, setup_s REAL, sent_bytes INTEGER, log_path TEXT, error TEXT,
  pulls TEXT, rel_cwd TEXT, remote_dir TEXT, local_cwd TEXT
);
CREATE INDEX IF NOT EXISTS runs_box ON runs(box_id, status);
CREATE TABLE IF NOT EXISTS bases (
  name TEXT PRIMARY KEY,           -- <repo_key>:<name>
  repo_key TEXT, short TEXT, box_id TEXT, from_box TEXT, size TEXT, remote_dir TEXT,
  is_default INTEGER DEFAULT 0, note TEXT, created_at REAL, created_by TEXT, size_bytes INTEGER
);
CREATE TABLE IF NOT EXISTS templates (
  name TEXT PRIMARY KEY, box_id TEXT, size TEXT, built_at REAL, recipe_sha TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS box_usage (      -- usage of boxes we deleted, per month (API 404s after delete)
  box_id TEXT, month TEXT, dollars REAL, seconds INTEGER, recorded_at REAL,
  PRIMARY KEY (box_id, month)
);
CREATE TABLE IF NOT EXISTS events (ts REAL, box_id TEXT, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, ts REAL);
"""


def db() -> sqlite3.Connection:
    ensure_dirs()
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    have = {r[1] for r in con.execute("PRAGMA table_info(runs)")}
    for col in ("pulls TEXT", "rel_cwd TEXT", "remote_dir TEXT", "local_cwd TEXT", "docker INTEGER"):
        if col.split()[0] not in have:
            con.execute(f"ALTER TABLE runs ADD COLUMN {col}")
    return con


def event(con, box_id: str | None, kind: str, detail: str = "") -> None:
    con.execute("INSERT INTO events VALUES (?,?,?,?)", (now(), box_id, kind, detail[:2000]))
    con.commit()
    log(f"{kind} {box_id or '-'} {detail[:300]}")


def kv_get(con, k: str, max_age: float | None = None):
    r = con.execute("SELECT v, ts FROM kv WHERE k=?", (k,)).fetchone()
    if not r:
        return None
    if max_age is not None and now() - (r["ts"] or 0) > max_age:
        return None
    try:
        return json.loads(r["v"])
    except Exception:  # noqa: BLE001
        return None


def kv_set(con, k: str, v) -> None:
    con.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?)", (k, json.dumps(v), now()))
    con.commit()


@contextlib.contextmanager
def file_lock(name: str, timeout: float = 600):
    """Exclusive inter-process lock (fcntl) on locks/<name>.lock."""
    ensure_dirs()
    path = LOCKS_DIR / (name.replace("/", "_")[:180] + ".lock")
    f = open(path, "a+")
    deadline = now() + timeout
    while True:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if now() > deadline:
                f.close()
                raise OffboxError(f"timed out waiting for lock {name}")
            time.sleep(0.3)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def atomic_write_json(path: Path, data) -> None:
    ensure_dirs()
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return default
