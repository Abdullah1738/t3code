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

# Backend: "boat" = boat.dev, "server" = our own offbox server at home (boatd, integrations/offbox/server).
# One backend per process, chosen when the process starts (see backend()). With no home server configured the
# answer is always "boat" and nothing below changes anything: that is how offbox ran before the home server.
#   server.json          {"url": ".../api/v1", "disabled": false}  written by server/bootstrap.zsh client
#   backend-state.json   {"state": "home_up"|"home_down", ...}     written by the health monitor (home_monitor.py)
#   home-failures.jsonl  runs that could not reach home before they were accepted (read by the monitor)
#   backend              optional manual pin: a file holding "boat" or "server"
_HOME_STATE = Path(os.environ.get("OFFBOX_STATE_DIR") or STATE)   # the monitor's tests move these three files
BACKEND_PATH = _HOME_STATE / "backend"
SERVER_CFG = _HOME_STATE / "server.json"
BACKEND_STATE = _HOME_STATE / "backend-state.json"
HOME_FAILURES = _HOME_STATE / "home-failures.jsonl"
PERSON_PREFIX = "person:"          # OFFBOX_THREAD=person:<name>, set by offbox-person for someone's own box
DEFAULT_OWNER = "ardud"
_BACKEND: str | None = None        # set by select_backend(); None = decide from the files and the environment


def home_config() -> dict | None:
    """The home server's settings, or None when there is no home server to use (no file, unreadable, no url,
    or "disabled": true). None means: this is a Boat-only install."""
    try:
        c = json.loads(SERVER_CFG.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(c, dict) or not c.get("url") or c.get("disabled"):
        return None
    return c


def home_state() -> dict:
    """What the health monitor last wrote. A missing or unreadable file counts as home_up."""
    try:
        s = json.loads(BACKEND_STATE.read_text())
    except (OSError, ValueError):
        return {"state": "home_up"}
    return s if isinstance(s, dict) and s.get("state") in ("home_up", "home_down") else {"state": "home_up"}


def person() -> str | None:
    """The person this process works for (her own box, her own token), or None for ordinary work."""
    t = os.environ.get("OFFBOX_THREAD") or ""
    name = t[len(PERSON_PREFIX):] if t.startswith(PERSON_PREFIX) else ""
    return name if name and name.replace("-", "").replace("_", "").isalnum() else None


def token_owner() -> str:
    """Whose token this process uses on the home server: the person's for person-box work, else ours."""
    return person() or DEFAULT_OWNER


def backend_pinned() -> str | None:
    """A backend somebody chose on purpose (environment or the pin file); automatic choice and failover are off."""
    b = os.environ.get("OFFBOX_BACKEND") or ""
    if b not in ("server", "boat"):
        try:
            b = BACKEND_PATH.read_text().strip()
        except OSError:
            b = ""
    return b if b in ("server", "boat") else None


def default_backend() -> str:
    """Where a new process sends its work:
    - a pinned backend wins;
    - no home server configured: boat (exactly as before the home server existed);
    - person-box work: the home server, always. It never goes to Boat, up or down;
    - the monitor says home is down: boat; otherwise the home server."""
    pin = backend_pinned()
    if pin:
        return pin
    if home_config() is None:
        return "boat"
    if person():
        return "server"
    return "boat" if home_state().get("state") == "home_down" else "server"


def backend() -> str:
    return _BACKEND or default_backend()


def db_path_for(name: str) -> Path:
    """Leases, runs and bases belong to one backend (a box id means nothing on the other), so each has its own
    database. Boat keeps the file it always had."""
    return STATE / ("offbox.db" if name == "boat" else "offbox-home.db")


def select_backend(name: str) -> str:
    """Fix this process's backend. Call it before any other offbox_lib module is imported: api and capacity
    read the backend once, at import."""
    global _BACKEND, DB_PATH
    if name not in ("server", "boat"):
        raise ValueError(name)
    _BACKEND = name
    DB_PATH = db_path_for(name)
    return name


def entry_backend(argv: list[str]) -> str:
    """The backend for one `offbox ...` call. Without a home server: boat, with no lookups at all.
    Otherwise: spend is Boat's meter and stats is the home server's; a command that names a run or a box goes to
    the backend that run or box lives on; everything else follows default_backend()."""
    pin = backend_pinned()
    if pin:
        return pin
    if home_config() is None:
        return "boat"
    sub = next((x for x in argv if not x.startswith("-")), "")
    if sub == "spend":
        return "boat"
    if sub == "stats":
        return "server"
    first = default_backend()
    if sub in ("logs", "wait", "kill", "release", "ssh", "ports"):
        named = [x for x in argv if x.startswith(("run-", "bx_")) or (sub in ("logs", "wait", "kill") and x != sub
                                                                      and not x.startswith("-"))]
        for name in (first, "boat" if first == "server" else "server"):
            if any(_known(name, x) for x in named):
                return name
    return first


def _known(name: str, ident: str) -> bool:
    """Does this backend's database know the run or box? Read-only; a missing database knows nothing."""
    path = db_path_for(name)
    if not path.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            if ident.startswith("bx_"):
                return con.execute("SELECT 1 FROM leases WHERE box_id=?", (ident,)).fetchone() is not None
            return con.execute("SELECT 1 FROM runs WHERE run_id=? OR run_id LIKE ?",
                               (ident, f"%{ident}")).fetchone() is not None
        finally:
            con.close()
    except sqlite3.Error:
        return False


def standby() -> bool:
    """True when this process is on Boat only because the home server is configured but not usable right now."""
    return backend() == "boat" and home_config() is not None and backend_pinned() is None


DB_PATH = db_path_for(backend())

EXIT_INFRA = 90
EXIT_CAP = 91
EXIT_BUSY = 92                 # every pool box stayed busy for the whole queue wait; nothing ran, retry
EXIT_HOME_DOWN = 93            # person-box work while the home server is down: it waits, it never goes to Boat
EXIT_INTERRUPTED = 94          # the home server restarted under the run and the run was not run again
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
    """Raised for failures; code 90 = infra (fallback allowed), 91 = cap, 92 = pool busy, 2 = usage."""

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


def db() -> sqlite3.Connection:
    ensure_dirs()
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
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
