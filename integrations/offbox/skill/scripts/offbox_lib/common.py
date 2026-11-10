"""Shared paths, state DB, locking, logging for offbox."""

from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import json
import os
import random
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
EXIT_LOCAL = 93               # local state failure; never automatic local fallback
EXIT_WAIT_TIMEOUT = 124        # `offbox wait --timeout` ran out; the run keeps going on its box

IDLE_STOP_S = 20 * 60          # a lease with no run for this long is stopped (boat ttl + reaper)
RUN_TTL_S = 30 * 60            # ttl while a run is in progress, refreshed every TTL_REFRESH_S
# With RUN_TTL_S an attached box survives a ~25 min boat API outage (refresh well inside the 30 min deadline).
TTL_REFRESH_S = 5 * 60
TTL_RETRY_S = 30                # retry soon after a failed refresh
ARCHIVED_DELETE_S = 7 * 86400  # delete a lease 7 days after its thread is archived
UNUSED_DELETE_S = 30 * 86400   # delete an unpinned lease unused for 30 days
BASES_SOFT_LIMIT = 50
DATA_KEEP_S = 14 * 86400       # boat deletes a stopped box's data this long after its last stop
KEEPALIVE_S = 12 * 86400       # resume + stop a box that must survive, once it has been stopped this long
SIZES = ("small", "default", "large", "xlarge")
TEMPLATES = ("crpko-go", "crpko-node", "crpko-harness", "generic")
TOO_BIG_NOTE = "too-big:"        # leases.note prefix: a stopped box whose disk outgrew its machine size
DEAD_MOUNT_NOTE = "dead-mount:"  # leases.note prefix: a box whose home filesystem died (ENOTCONN); stopped, out of the pool


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


def silence(stream) -> None:
    """Point a dead output descriptor at /dev/null. Bytes a failed flush left in the buffer would otherwise be flushed
    again at interpreter shutdown, where the closed pipe raises and replaces the process's exit code."""
    try:
        fd = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(fd, stream.fileno())
        finally:
            os.close(fd)
    except (OSError, ValueError, AttributeError):
        pass


def _emit(text: str) -> None:
    # The caller's pipe can close first (tool timeout, | head), or its redirect target can vanish (EIO); progress lines
    # are best effort and must never turn into an exception, least of all inside a signal handler or an error report.
    try:
        print(text, file=sys.stderr, flush=True)
    except (OSError, ValueError):
        silence(sys.stderr)


def out(text: str) -> None:
    """A result line on stdout (`<run>: exit=N`). Like _emit: a dead stdout must not turn into a crash that replaces the
    exit code the caller is waiting for."""
    try:
        print(text, flush=True)
    except (OSError, ValueError):
        silence(sys.stdout)


def say(msg: str) -> None:
    """Progress line for the human/agent, always on stderr so stdout stays the command's."""
    _emit(f"offbox: {msg}")


def warn_loud(msg: str) -> None:
    bar = "!" * 78
    _emit(f"\n{bar}\noffbox WARNING: {msg}\n{bar}\n")


class OffboxError(Exception):
    """Raised for failures; code 90 = infra (fallback allowed), 91 = cap, 92 = pool busy, 93 = local state (no fallback), 2 = usage."""

    def __init__(self, msg: str, code: int = EXIT_INFRA, started: bool = False, outage: bool = False):
        super().__init__(msg)
        self.code = code
        self.started = started   # True once the remote command may have started (no local fallback then)
        self.outage = outage     # boat.dev's own API was unreachable (Cloudflare 52x or no answer)


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


CAPACITY_SCHEMA = """
        CREATE TABLE IF NOT EXISTS start_requests (
          id INTEGER PRIMARY KEY, ts REAL NOT NULL, operation TEXT, box_id TEXT,
          outcome TEXT NOT NULL DEFAULT 'reserved', legacy_event INTEGER UNIQUE
        );
        CREATE INDEX IF NOT EXISTS start_requests_ts ON start_requests(ts);
        CREATE INDEX IF NOT EXISTS start_requests_box_ts ON start_requests(box_id,ts);
        CREATE TABLE IF NOT EXISTS pool_members (box_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS pool_members_key ON pool_members(pool_key);
        CREATE TABLE IF NOT EXISTS pool_callers (
          owner TEXT, repo_root TEXT, box_id TEXT, remote_dir TEXT,
          PRIMARY KEY(owner, repo_root)
        );
        -- A pool box being created: its slot is claimed under the pool lock, the box is made after it (pool._pending).
        CREATE TABLE IF NOT EXISTS pool_pending (
          token TEXT PRIMARY KEY, pool_key TEXT NOT NULL, pid INTEGER, created_at REAL NOT NULL, source TEXT
        );
        -- A box with a prune worker that is not confirmed finished must not be handed to anyone: it can still
        -- rename a checkout a later run has reused. Cleared only when the worker is confirmed gone.
        CREATE TABLE IF NOT EXISTS prune_holds (
          box_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at REAL NOT NULL
        );
"""


SCHEMA_VERSION = 1
DB_TIMEOUT = 30


class StateConnection(sqlite3.Connection):
    last_statement = "connect"

    def execute(self, sql, parameters=(), /):
        self.last_statement = " ".join(sql.split())[:100]
        try:
            return super().execute(sql, parameters)
        except sqlite3.Error as error:
            error.add_note(f"local state SQL: {self.last_statement}")
            raise


@contextlib.contextmanager
def write(con):
    """Reserve the writer before reading state; callers keep external work outside this scope."""
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise


def busy(error):
    return isinstance(error, sqlite3.OperationalError) and (
        getattr(error, 'sqlite_errorcode', 0) & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
        or any(word in str(error).lower() for word in ('locked', 'busy')))


def db_retry(operation):
    for attempt in range(3):
        try:
            return operation()
        except sqlite3.OperationalError as error:
            if not busy(error) or attempt == 2:
                raise
            time.sleep(random.uniform(.03, .1) * (attempt + 1))


def local_error(error, *, run_id=None, started=False):
    notes = "; ".join(getattr(error, '__notes__', []))
    label = "local state DB busy" if busy(error) else (
        "local state DB error" if isinstance(error, sqlite3.Error) else "local error")
    action = (f"command may have run; do not rerun it; read its result with: offbox wait {run_id}"
              if started else "nothing ran, safe to retry")
    prefix = f"{run_id}: " if run_id else ""
    return OffboxError(f"{prefix}{label} ({notes or str(error)}); {action}", code=EXIT_LOCAL, started=started)


def ensure_schema(con):
    if getattr(con, 'schema_ready', False):
        return
    if con.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
        # journal_mode is persistent. Do this only on upgrade, outside the migration transaction.
        con.execute("PRAGMA journal_mode=WAL")
        with write(con):
            # Another process may have completed the upgrade while we waited for the writer.
            if con.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
                _migrate(con)
                con.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    if isinstance(con, StateConnection):
        con.schema_ready = True


def _migrate(con):
    # executescript commits an existing transaction, so run each statement under our migration lock.
    for statement in (SCHEMA + CAPACITY_SCHEMA).split(';'):
        if statement.strip():
            con.execute(statement)
    have = {r[1] for r in con.execute("PRAGMA table_info(runs)")}
    for col in ("pulls TEXT", "rel_cwd TEXT", "remote_dir TEXT", "local_cwd TEXT", "docker INTEGER",
                "client_pid INTEGER"):
        if col.split()[0] not in have:
            con.execute(f"ALTER TABLE runs ADD COLUMN {col}")
    # saved: boat saved-snapshot name (kept for good); expired_at: boat deleted the stopped box's data.
    for table in ("templates", "bases"):
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for col in ("saved TEXT", "expired_at REAL"):
            if col.split()[0] not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {col}")

    have = {r[1] for r in con.execute("PRAGMA table_info(pool_pending)")}
    if 'source' not in have:
        con.execute("ALTER TABLE pool_pending ADD COLUMN source TEXT")
    con.execute("""INSERT OR IGNORE INTO start_requests(ts,operation,box_id,outcome,legacy_event)
        SELECT e.ts, e.kind, e.box_id, 'legacy', e.rowid FROM events e
        WHERE e.ts>? AND e.kind IN ('lease_new','lease_resume','base_save','template_build_start')
        AND NOT EXISTS (SELECT 1 FROM start_requests s WHERE s.legacy_event IS NULL
          AND s.box_id=e.box_id AND s.ts BETWEEN e.ts-1800 AND e.ts+1)""", (now()-86400,))
    con.execute("INSERT OR REPLACE INTO kv VALUES ('legacy_start_rowid',?,?)",
                (str(con.execute('SELECT COALESCE(MAX(rowid),0) FROM events').fetchone()[0]), now()))


def db() -> sqlite3.Connection:
    ensure_dirs()
    # Standalone writes commit immediately. Only read/modify/write units use write(), never network work.
    con = sqlite3.connect(DB_PATH, timeout=DB_TIMEOUT, isolation_level=None, factory=StateConnection)
    con.row_factory = sqlite3.Row
    try:
        db_retry(lambda: ensure_schema(con))
    except BaseException:
        con.close()
        raise
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


def offsets_path(log_path: Path) -> Path:
    return Path(str(log_path) + ".offsets")


def checkpoint(log_path: Path | None) -> dict | None:
    """The last committed checkpoint of a local log (remote stream offsets and the log length they match), or None
    when there is no log or the run never committed one. Shared by `runs` (writer) and `misc` (takeover reader)."""
    if not log_path:
        return None
    d = read_json(offsets_path(Path(log_path)), None)
    if not isinstance(d, dict) or d.get("logBytes") is None:
        return None
    return {"stdoutOffset": int(d.get("stdoutOffset") or 0), "stderrOffset": int(d.get("stderrOffset") or 0),
            "logBytes": int(d["logBytes"])}


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
