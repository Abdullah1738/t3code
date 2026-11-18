#!/usr/bin/env python3
"""boatd: our own offbox server. Answers the boat.dev REST calls offbox makes (offbox_lib/api.py), backed by Incus
system containers on ZFS on one box at home. Every box is a container `bx-xxxxxxxx`; offbox sees id `bx_xxxxxxxx`.

  boatd.py serve                 HTTP API (tailnet only) + reaper (idle stop, snapshot retention) + metrics sampler
  boatd.py run <box> <pid>       one command, started by `serve` through systemd-run so it outlives boatd restarts
  boatd.py stats [--days N]      per-kind resource report over all owners (also GET /api/v1/admin/stats)
  boatd.py token create --owner X [--label L] | token create --admin | token list | token revoke --id N
                                 root only. `create` prints the new token once; only its hash is stored
  boatd.py box list | box chown <box> --owner X     root only: who owns which box
  boatd.py snap-rotate hourly|daily|weekly          timer: snapshot the person boxes and prune (see RETENTION)
  boatd.py health                what GET /api/v1/health answers
  boatd.py pin <box> [--off]

State (all of it on the ZFS pool, dataset `state_dataset` mounted at /var/lib/boatd, so an OS reinstall keeps it):
boatd.db (SQLite, WAL: boxes, runs, queue, hashed tokens), cmds/<box>/<pid>.{out,err,result.json,kill}.
Auth: Bearer tokens bound to an owner; a token sees only its owner's boxes, anything else answers 404. A separate
admin token opens /admin/* only. Config: /etc/boatd/config.json (see DEFAULTS).

Restarts are normal here (no UPS). Every start reconciles before the API answers anything but /health:
a run whose unit is still active is followed, one that finished while boatd was down is finalized from its result
file, one whose unit is gone with no result is `interrupted` (queued again once if it was submitted with
retry_interrupted), queued runs start by themselves, containers are brought to the state the database expects, and
half-created boxes and half-made saved states are cleaned up. Without its pool boatd serves /health only and says why.
Stdlib only (Python 3.12, Ubuntu 24.04)."""

from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shlex
import signal
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time
from contextlib import contextmanager
from functools import wraps
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import toollog
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skill/scripts"))
    import toollog

sys.path.insert(0, str(Path(__file__).resolve().parent))
import boatd_disk as disk
import boatd_tmp
import boatd_memory

try:
    import offbox_disk_space
    import offbox_protection
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skill/scripts"))
    import offbox_disk_space
    import offbox_protection

VAR = Path(os.environ.get("BOATD_VAR", "/var/lib/boatd"))
ETC = Path(os.environ.get("BOATD_ETC", "/etc/boatd"))
CMDS = VAR / "cmds"
DB_PATH = VAR / "boatd.db"
CG_ROOT = Path("/sys/fs/cgroup")
PROC_ROOT = Path('/proc')
SELF = Path(__file__).resolve()
_mgmt_config = SELF.with_name("offbox_mgmt_sshd_config")
if not _mgmt_config.is_file():
    _mgmt_config = SELF.parents[1] / "skill/templates/home/offbox_mgmt_sshd_config"
# Use the image's actual configuration, including when installed separately on the host.
MGMT_PORT = int(next(line.split()[1] for line in _mgmt_config.read_text().splitlines() if line.startswith("Port ")))
VERSION = "2.0"
STARTED = time.time()

# Snapshot retention, the one place for these numbers. Every run ends with a snapshot (kind auto; stop on a stop):
# the newest `run_keep` are kept plus the last one of each day for `run_daily_days` days. Boxes of the owners in
# `person_owners` also get timer snapshots (boatd-snap-{hourly,daily,weekly}.timer), newest N kept per kind.
RETENTION = {"run_keep": 20, "run_daily_days": 14, "person_hourly": 48, "person_daily": 30, "person_weekly": 12}
MAX_ATTEMPTS = 2                      # an interrupted run is queued again at most once
EXEC_RECOVERY_SECONDS = 10

DEFAULTS = {
    "listen": "127.0.0.1", "port": 8443,
    "ssh_host": "127.0.0.1",          # address offbox uses for box ssh (the server's tailnet IP)
    "ssh_port_base": 22000,
    "base_image": "offbox-base",
    "pool": "default",
    # Memory caps per boat size (OOM guard, not a reservation). CPU is shared: limits.cpu.priority by size.
    "sizes": {"small": {"mem": "8GiB", "prio": 3, "vcpu": 2},
              "default": {"mem": "16GiB", "prio": 5, "vcpu": 4},
              "large": {"mem": "24GiB", "prio": 6, "vcpu": 8},
              "xlarge": {"mem": "48GiB", "prio": 7, "vcpu": 16}},
    "mem_reserve_gb": 12,             # admission: keep this much host memory free
    "default_peak_gb": 4,             # admission: predicted peak for a kind with no history
    "retention": dict(RETENTION),
    "zpool": "offbox",
    "scratch_disk": True,             # new boxes only; keep lifecycle handling enabled on rollback
    "state_dataset": "",              # e.g. offbox/boatd: boatd refuses to keep state anywhere else (set by install-host.sh)
    "owners": ["ardud", "moni"], "default_owner": "ardud",
    "person_owners": ["moni"],        # their boxes get hourly/daily/weekly snapshots
    "max_running": 0,                 # optional hard cap, in addition to resource admission
    "cpu_pressure_limit": 0,          # host CPU some avg10 (%); 0 = off (the default until #219)
    "prune_unused_days": 30,          # stopped boxes untouched this long are deleted (not pinned, not saved)
    "sample_s": 10, "keep_samples_days": 90,
}
CFG: dict = {}

LIVE = ("ready", "running")
BOX_LOCKS = threading.local()
TS_FMT = "%Y-%m-%dT%H:%M:%S.%f"


def now() -> float:
    return time.time()


def iso(t: float | None) -> str | None:
    if t is None:
        return None
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime(TS_FMT)[:-3] + "Z"


def log(msg: str) -> None:
    sys.stderr.write(f"{iso(now())} {msg}\n")
    sys.stderr.flush()


def load_cfg() -> dict:
    c = dict(DEFAULTS)
    p = ETC / "config.json"
    if p.exists():
        c.update(json.loads(p.read_text()))
    c["retention"] = {**RETENTION, **(c.get("retention") or {})}
    DISK.clear()
    DISK.update(ts=0, value=None, boxes={}, write_at=0, write_error=None)
    CFG.clear()
    CFG.update(c)
    return c


# ---------------------------------------------------------------- db

SCHEMA = """
CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, name TEXT, type TEXT, state TEXT, error TEXT,
  ttl INTEGER, last_active REAL, created_at REAL, updated_at REAL, stopped_at REAL, ssh_port INTEGER,
  source TEXT, labels TEXT DEFAULT '{}', pinned INTEGER DEFAULT 0, deleted_at REAL);
CREATE TABLE IF NOT EXISTS idem (key TEXT PRIMARY KEY, box_id TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS commands (box_id TEXT, pid INTEGER, command_id TEXT, command TEXT, cwd TEXT,
  status TEXT, exit_code INTEGER, signal TEXT, created_at REAL, started_at REAL, ended_at REAL,
  queued_s REAL, kind TEXT, repo TEXT, run_id TEXT, metrics TEXT, PRIMARY KEY (box_id, pid));
CREATE INDEX IF NOT EXISTS commands_cid ON commands(command_id);
CREATE INDEX IF NOT EXISTS commands_kind ON commands(kind, ended_at);
CREATE TABLE IF NOT EXISTS saved (name TEXT PRIMARY KEY, instance TEXT, source TEXT, type TEXT,
  status TEXT, error TEXT, size_bytes INTEGER, created_at REAL, snapshot_id TEXT);
CREATE TABLE IF NOT EXISTS snaps (box_id TEXT, name TEXT, kind TEXT, created_at REAL, PRIMARY KEY (box_id, name));
CREATE TABLE IF NOT EXISTS samples (ts REAL, box_id TEXT, mem_bytes INTEGER, cpu_usec INTEGER, io_bytes INTEGER);
CREATE INDEX IF NOT EXISTS samples_box_ts ON samples(box_id, ts);
CREATE TABLE IF NOT EXISTS host_samples (ts REAL PRIMARY KEY, mem_avail INTEGER, mem_total INTEGER,
  cpu_busy REAL, psi_cpu REAL, psi_mem REAL, psi_io REAL, running_cmds INTEGER, queued_cmds INTEGER,
  live_boxes INTEGER, disk_free INTEGER);
"""


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    return con


SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, admin INTEGER DEFAULT 0,
  hash TEXT UNIQUE, label TEXT, created_at REAL, last_used_at REAL, revoked_at REAL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS incus_deletes (instance TEXT PRIMARY KEY, created_at REAL);
CREATE TABLE IF NOT EXISTS snapshot_pending (box_id TEXT, kind TEXT, generation TEXT NOT NULL DEFAULT '', PRIMARY KEY (box_id, kind));
"""
SAVED_V2 = """CREATE TABLE saved (owner TEXT, name TEXT, instance TEXT, source TEXT, type TEXT, status TEXT,
  error TEXT, size_bytes INTEGER, created_at REAL, snapshot_id TEXT, pending_instance TEXT,
  PRIMARY KEY (owner, name))"""


def _cols(con, table: str) -> set:
    return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}


def migrate(con) -> None:
    """Idempotent: owner columns, per-owner saved states, run attempts, hashed tokens."""
    con.executescript(SCHEMA_V2)
    if 'generation' not in _cols(con, 'snapshot_pending'):
        con.execute("ALTER TABLE snapshot_pending ADD COLUMN generation TEXT NOT NULL DEFAULT ''")
    if "start_error" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN start_error TEXT")
    con.execute("CREATE TABLE IF NOT EXISTS box_events (seq INTEGER PRIMARY KEY, ts REAL, box_id TEXT, action TEXT, detail TEXT)")
    con.execute('CREATE INDEX IF NOT EXISTS box_events_box_seq ON box_events(box_id,seq)')
    for column in ('pin_until REAL', 'pin_holder TEXT'):
        if column.split()[0] not in _cols(con, 'boxes'):
            con.execute('ALTER TABLE boxes ADD COLUMN ' + column)
    if 'holder' not in _cols(con, 'commands'):
        con.execute('ALTER TABLE commands ADD COLUMN holder TEXT')
    if "mgmt_ssh_port" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN mgmt_ssh_port INTEGER")
    if "provision_identity" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN provision_identity INTEGER NOT NULL DEFAULT 0")
    if "identity_pending" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN identity_pending INTEGER NOT NULL DEFAULT 0")
    owner = CFG.get("default_owner") or "ardud"
    if "owner" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN owner TEXT")
        con.execute("UPDATE boxes SET owner=? WHERE owner IS NULL", (owner,))
    have = _cols(con, "commands")
    for col in ("retry_interrupted INTEGER DEFAULT 0", "attempt INTEGER DEFAULT 1", "boot_id TEXT",
                "interrupted_at REAL", "sync INTEGER NOT NULL DEFAULT 0", "timeout_s REAL",
                "killed INTEGER NOT NULL DEFAULT 0"):
        if col.split()[0] not in have:
            con.execute(f"ALTER TABLE commands ADD COLUMN {col}")
    con.execute("CREATE INDEX IF NOT EXISTS commands_cpu_start ON commands(sync, started_at)")
    if "owner" not in _cols(con, "saved"):
        # Saved states were global by name; they become per owner. The one owner so far keeps all of them.
        con.execute("BEGIN IMMEDIATE")
        con.execute("ALTER TABLE saved RENAME TO saved_v1")
        con.execute(SAVED_V2)
        con.execute("INSERT INTO saved (owner, name, instance, source, type, status, error, size_bytes, created_at, "
                    "snapshot_id) SELECT ?, name, instance, source, type, status, error, size_bytes, created_at, "
                    "snapshot_id FROM saved_v1", (owner,))
        con.execute("DROP TABLE saved_v1")
        con.execute("COMMIT")
    # The single shared token of the first version becomes the default owner's token. Only its hash is kept.
    legacy = ETC / "token"
    try:
        tok = legacy.read_text().strip()
    except OSError:
        tok = ""
    if tok:
        con.execute("INSERT OR IGNORE INTO tokens (owner, admin, hash, label, created_at) VALUES (?,0,?,?,?)",
                    (owner, token_hash(tok), "migrated from /etc/boatd/token", now()))
        try:
            legacy.unlink()
        except OSError as e:
            log(f"could not remove the old plaintext token file: {e}")
        log(f"the old shared token is now {owner}'s token (stored hashed)")


def init_db() -> None:
    VAR.mkdir(parents=True, exist_ok=True)
    CMDS.mkdir(parents=True, exist_ok=True)
    os.chmod(VAR, 0o700)
    with db() as con:
        con.executescript(SCHEMA)
        migrate(con)
    os.chmod(DB_PATH, 0o600)


# ---------------------------------------------------------------- tokens

def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def token_create(con, owner: str | None, admin: bool = False, label: str = "") -> str:
    """Returns the new token. It is shown once by the caller and never stored or logged."""
    if not admin and owner not in CFG["owners"]:
        raise Fail(400, "unknown_owner", f"owner must be one of {', '.join(CFG['owners'])} (config.json \"owners\")")
    tok = "obx_" + secrets.token_urlsafe(32)
    con.execute("INSERT INTO tokens (owner, admin, hash, label, created_at) VALUES (?,?,?,?,?)",
                (None if admin else owner, 1 if admin else 0, token_hash(tok), label[:120], now()))
    return tok


def token_list(con) -> list[dict]:
    return [{"id": r["id"], "owner": r["owner"], "admin": bool(r["admin"]), "label": r["label"],
             "created": iso(r["created_at"]), "lastUsed": iso(r["last_used_at"]), "revoked": iso(r["revoked_at"])}
            for r in con.execute("SELECT * FROM tokens ORDER BY id")]


def token_revoke(con, token_id: int | None = None, owner: str | None = None) -> int:
    if token_id is not None:
        cur = con.execute("UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now(), token_id))
    else:
        cur = con.execute("UPDATE tokens SET revoked_at=? WHERE owner=? AND admin=0 AND revoked_at IS NULL",
                          (now(), owner))
    return cur.rowcount


def token_auth(con, header: str | None) -> tuple[str | None, bool] | None:
    """(owner, is_admin) for a live token, else None."""
    got = (header or "").removeprefix("Bearer ").strip()
    if not got:
        return None
    h = token_hash(got)
    r = con.execute("SELECT * FROM tokens WHERE hash=? AND revoked_at IS NULL", (h,)).fetchone()
    if not r or not hmac.compare_digest(r["hash"], h):
        return None
    if now() - (r["last_used_at"] or 0) > 300:
        con.execute("UPDATE tokens SET last_used_at=? WHERE id=?", (now(), r["id"]))
    return r["owner"], bool(r["admin"])


# ---------------------------------------------------------------- host state: pool, mdraid, boot

def boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return "unknown"


def host_uptime() -> float:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return 0.0


def _sh(args: list[str], timeout: float = 20) -> tuple[int, str]:
    try:
        if args[:1] == ['incus']:
            p = incus(*args[1:], timeout=timeout, check=False)
            return p.returncode, p.stdout.decode(errors='replace').strip()
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def pool_state() -> str:
    """ONLINE, DEGRADED, FAULTED, ... or MISSING when the pool is not imported."""
    rc, out = _sh(["zpool", "list", "-H", "-o", "health", CFG["zpool"]])
    return out.split()[0] if rc == 0 and out else "MISSING"


def mdraid_state(text: str | None = None) -> dict:
    """{"state": "ok"|"degraded"|"none", "arrays": {"md0": "[UU]"}} from /proc/mdstat."""
    if text is None:
        try:
            text = Path("/proc/mdstat").read_text()
        except OSError:
            text = ""
    arrays, cur = {}, None
    for line in text.splitlines():
        m = re.match(r"^(md\d+)\s*:", line)
        if m:
            cur = m.group(1)
            arrays[cur] = "inactive" if " inactive " in line else "?"
            continue
        m = re.search(r"\[([U_]+)\]\s*$", line)
        if cur and m and arrays.get(cur) != "inactive":
            arrays[cur] = f"[{m.group(1)}]"
            cur = None
    if not arrays:
        return {"state": "none", "arrays": {}}
    bad = any(v == "inactive" or "_" in v for v in arrays.values())
    return {"state": "degraded" if bad else "ok", "arrays": arrays}


def state_problem() -> str | None:
    """Why boatd must not touch its state directory right now, or None. With `state_dataset` set, the state lives
    on that ZFS dataset and nowhere else: writing a fresh database to the OS disk while the pool is away would
    fork history."""
    ds = CFG.get("state_dataset")
    if not ds:
        return None
    rc, out = _sh(["zfs", "get", "-H", "-o", "value", "mounted,mountpoint", ds])
    if rc != 0:
        return f"state dataset {ds} not found (pool {CFG['zpool']} is {pool_state()})"
    vals = out.split()
    if len(vals) < 2 or vals[0] != "yes":
        return f"state dataset {ds} is not mounted"
    if vals[1] != str(VAR):
        return f"state dataset {ds} is mounted at {vals[1]}, expected {VAR}"
    return None


VPN_FLAG = Path("/etc/offbox/vpn-enabled")   # written by home/mullvad.sh: this host's boxes only get out through Mullvad
VPN_GRACE_S = 120                            # the daemon changes relay by itself; shorter gaps are not an outage
_VPN = {"down_since": None}


def vpn_problem() -> str | None:
    """Why boxes have no internet right now, or None. Only on a host where the VPN is meant to be on: lockdown
    keeps everything in while the tunnel is down, so runs would be accepted here and then fail on every download."""
    if not VPN_FLAG.exists():
        return None
    rc, out = _sh(["mullvad", "status"], timeout=10)
    state = (out.strip().splitlines() or ["no answer"])[0].strip()
    if rc == 0 and state.startswith("Connected"):
        _VPN["down_since"] = None
        return None
    if _VPN["down_since"] is None:
        _VPN["down_since"] = now()
    if now() - _VPN["down_since"] < VPN_GRACE_S:
        return None
    return f"vpn tunnel is down ({state[:60]}); boxes have no internet"


READY = threading.Event()          # set once the state is there and the start-up reconcile has finished
STATE = {"problem": "starting", "reconcile": None, "boot": None, "phases": {}, "loops": {}}


def startup_status():
    problem = STATE["problem"] or ""
    starting = not READY.is_set() and (
        problem in ("starting", "waiting for incus", "reconciling runs and boxes after start")
        or bool(re.fullmatch(r"state dataset \S+ (?:not found \(pool \S+ is MISSING\)|is not mounted)", problem)))
    return {"starting": starting, "phase": problem if not READY.is_set() else "ready", "startedAt": STARTED}


def record_boot():
    keys = ("NRestarts", "ExecMainCode", "ExecMainStatus", "Result", "InvocationID")
    rc, out = _sh(["systemctl", "show", "boatd", *["--property=" + k for k in keys]], timeout=3)
    systemd = dict(line.split("=", 1) for line in out.splitlines() if "=" in line) if rc == 0 else {}
    STATE["boot"] = {"version": VERSION, "startedAt": STARTED, "hostUptimeS": host_uptime(),
                     "bootId": boot_id(), "invocationId": os.environ.get("INVOCATION_ID") or systemd.get("InvocationID"),
                     "exitStatus": os.environ.get("EXIT_STATUS"), "systemd": systemd}
    log("boot: " + json.dumps(STATE["boot"], sort_keys=True))

_HEALTH = {"ts": 0.0, "v": None}
_HEALTH_LOCK = threading.Lock()
_HEALTH_REFRESH = {"stage": "idle", "since": None, "timings": {}}


RESTART_PENDING = Path("/var/lib/offbox/restart-pending.json")


def restart_pending() -> dict:
    try:
        value = json.loads(RESTART_PENDING.read_text())
        services, since = value["services"], value["checkedAt"]
        if not isinstance(services, list) or not all(isinstance(s, str) and s for s in services):
            raise ValueError("invalid pending services")
        if not isinstance(since, str) or dt.datetime.fromisoformat(since).utcoffset() != dt.timedelta(0):
            raise ValueError("invalid UTC timestamp")
        return {"count": len(services), "since": since if services else None}
    except (OSError, ValueError, KeyError, TypeError):
        return {"count": 0, "since": None}


def health_stage_done(stage):
    elapsed = time.monotonic() - _HEALTH_REFRESH["since"]
    _HEALTH_REFRESH["timings"][stage] = round(elapsed * 1000, 1)
    if elapsed > 1:
        log(f"health-refresh stage={stage} ms={elapsed * 1000:.1f}")


def health_stage(stage, read):
    _HEALTH_REFRESH.update(stage=stage, since=time.monotonic())
    try:
        return read()
    finally:
        health_stage_done(stage)


def refresh_health(fresh: bool = False) -> dict:
    """Only refreshers serialize; request threads read the published snapshot without this lock."""
    loops = loop_health()
    with _HEALTH_LOCK:
        cached = _HEALTH["v"]
        if not fresh and cached and now() - _HEALTH["ts"] < 5:
            return cached
        reasons = []
        pool = health_stage("zpool", pool_state)
        md = mdraid_state()
        ok = READY.is_set()
        if not ok:
            reasons.append(STATE["problem"] or "starting")
        if pool != "ONLINE":
            reasons.append(f"pool {CFG['zpool']} is {pool}")
        if md["state"] == "degraded":
            reasons.append("mdraid degraded: " + ", ".join(f"{k} {v}" for k, v in sorted(md["arrays"].items())))
        status = startup_status()
        rc = 0 if status["starting"] else health_stage("incus", lambda: _sh(["incus", "query", "/1.0"], timeout=10))[0]
        if rc != 0:
            ok = False
            reasons.append("incus is not answering")
        vpn = None if status["starting"] else health_stage("mullvad", vpn_problem)
        if vpn:
            ok = False
            reasons.append(vpn)
        queue = running = None
        if READY.is_set():
            try:
                def counts():
                    con = db()
                    try:
                        return tuple(con.execute(f"SELECT COUNT(*) FROM commands WHERE status='{status}'").fetchone()[0]
                                     for status in ("queued", "running"))
                    finally:
                        con.close()
                queue, running = health_stage("sqlite", counts)
            except sqlite3.Error:
                ok = False
                reasons.append("state database is not readable")
        storage = {k: v for k, v in health_stage("disk", disk_state).items() if k != 'boxes'}
        if storage["level"] in ("full", "unknown"):
            ok = False
        if storage["disk_low"] or (storage["level"] == "unknown" and pool == 'ONLINE'):
            reasons.append("disk_" + storage["level"] + ": " + disk.description(storage))
        out = {"disk": storage, "disk_low": storage["disk_low"], "disk_full": storage["disk_full"], "ok": ok, "up": True, "mode": "ok" if not reasons else "degraded", "reasons": reasons,
               "pool": {"name": CFG["zpool"], "state": pool}, "mdraid": md, "queue": queue, "running": running,
               "boot_id": boot_id(), "uptime_s": int(host_uptime()), "boatd_uptime_s": int(now() - STARTED),
               "restartPending": restart_pending(),
               "version": VERSION, **status, "boot": STATE.get("boot"), "startupPhases": STATE.get("phases", {})}
        problems = [v["problem"] for v in loops.values() if v["stalled"]]
        out.update(loops=loops, degraded=bool(problems), problem="; ".join(problems) or None)
        if problems:
            out.update(mode="degraded", reasons=list(out.get("reasons", [])) + problems)
        _HEALTH.update(ts=now(), v=out)
        _HEALTH_REFRESH.update(stage="idle", since=None)
        return out


# Disk state also lives in memory and the root-disk tool log: SQLite can be unwritable
# precisely when this measurement matters most. Health never needs a successful DB write.
DISK = {"ts": 0, "value": None}


def disk_state(fresh=False, writer=False):
    if not CFG.get("state_dataset"):
        return {"level": "ok", "disk_low": False, "disk_full": False, "filesystems": []}
    if not fresh and DISK["value"] is not None and now() - DISK["ts"] < 5:
        if DISK.get('write_error') and not writer:
            return {**DISK['value'], 'level': 'full', 'disk_full': True, 'disk_low': True, 'write_ok': False}
        return DISK["value"]
    value = disk.sample(CFG["zpool"], VAR)
    for key in ('cleanup', 'snapshot_bytes_by_kind'):
        if key in DISK:
            value[key] = DISK[key]
    value.update(write_ok=bool(DISK.get('write_at')) and not DISK.get('write_error'), written_at=DISK.get('write_at', 0))
    if DISK.get('write_error') and not writer:
        value.update(level='full', disk_full=True, disk_low=True)
    DISK.update(ts=now(), value=value)
    return value


def pool_free(value):
    return next((r['free_bytes'] for r in value['filesystems'] if r['filesystem'] == CFG['zpool']), 0)


def disk_admit():
    value = disk_state()
    if value["level"] in ("full", "unknown"):
        raise Fail(503, "server_disk_low", disk.description(value), {"disk": {k: v for k, v in value.items() if k != 'boxes'}})


def snapshot_protected(con, pressure=True):
    # Unknown/interrupted results stay protected too, until their owner reconciles them.
    protected = {r['id'] for r in con.execute('SELECT id,pinned,state,owner FROM boxes')
                 if r['pinned'] or (pressure and (r['state'] not in ('ready','running','archived')
                                                or r['owner'] in (CFG.get('person_owners') or [])))}
    protected.update(r[0] for r in con.execute("SELECT DISTINCT box_id FROM commands WHERE status IS NULL OR status NOT IN ('exited','killed') OR (status='exited' AND exit_code IS NULL)"))
    protected.update(r[0] for r in con.execute("SELECT source FROM saved WHERE status IN ('ready','pending')"))
    return protected


def disk_maintenance(con, error=None):
    value = disk_state(fresh=True, writer=True)
    if not CFG.get("state_dataset"):
        return value
    toollog.emit("boatd", "disk.sample", ok=value["level"] != "unknown", props=value)
    if value["disk_low"]:
        log(f"disk_low: {disk.description(value)}")
        toollog.emit("boatd", "disk.warning", kind="error", ok=False, props=value, tag="server_disk_low")
    if con is None:
        if error is not None:
            DISK['write_error'] = str(error)
            value.update(level='full', disk_full=True, disk_low=True, write_ok=False)
        return value
    try:
        inventory_started = now()
        sizes, snaps = disk.inventory(zpool())
        previous = (DISK.get('boxes') or {})
        for bid, size in sizes.items():
            if previous.get(bid) != size:
                toollog.emit('boatd', 'disk.box_snapshots', ok=True, ids={'box': bid}, props=size)
        DISK['boxes'] = sizes
        value["boxes"] = sizes
        con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES ('disk',?)", (json.dumps(value),))
        DISK.update(write_error=None, write_at=now())
        value.update(write_ok=True, written_at=DISK['write_at'])
    except sqlite3.Error as e:
        DISK['write_error'] = str(e)
        value.update(level='full', disk_full=True, disk_low=True, write_ok=False)
        toollog.emit('boatd', 'disk.sample', kind='error', ok=False, props=value, tag='disk_state_write')
        return value
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        toollog.emit("boatd", "disk.sample", kind="error", ok=False, props={"error": str(e)[:200]}, tag="disk_inventory")
        return value
    with open(VAR / "disk.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return value
        state = con.execute("SELECT v FROM meta WHERE k='disk_cleanup'").fetchone()
        cleanup = json.loads(state[0]) if state else {}
        pool = next((r for r in value['filesystems'] if r['filesystem'] == CFG['zpool']), None)
        if pool and pool['free_bytes'] < pool['total_bytes'] * disk.WARN:
            cleanup['target_bytes'] = int(pool['total_bytes'] * disk.TARGET)
        if pool and pool['free_bytes'] >= cleanup.get('target_bytes', 0):
            cleanup['target_bytes'] = 0
        live = {(r['box'], r['name']) for r in snaps}
        # External recovery can prune while boatd is up. The live ZFS inventory
        # is authoritative; stale SQLite rows are not bytes available to reclaim.
        for old in con.execute('SELECT box_id,name,created_at FROM snaps').fetchall():
            if old['created_at'] < inventory_started and (old['box_id'], old['name']) not in live:
                con.execute('DELETE FROM snaps WHERE box_id=? AND name=?', (old['box_id'], old['name']))
                toollog.emit('boatd', 'snapshot.prune', ok=True, ids={'box': old['box_id']},
                             props={'snapshot': old['name'], 'bytes_freed': 0, 'reason': 'missing'})
        protected = snapshot_protected(con)
        missing_snapshots = {tuple(key) for key in cleanup.get('missing_snapshots', [])}
        missing_snapshots &= live
        eligible = [r for r in disk.candidates(snaps, protected)
                    if (r['box'], r['name']) not in missing_snapshots]
        # Count-retention uses the same pacing gate. Otherwise run completion or
        # personal timers could bypass sampler backpressure with a bulk delete.
        count_gone = set()
        for box in con.execute('SELECT id FROM boxes WHERE deleted_at IS NULL'):
            if box['id'] in snapshot_protected(con, pressure=False):
                continue
            rows = con.execute('SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC', (box['id'],)).fetchall()
            count_gone.update((box['id'], name) for name in snaps_to_prune(rows, CFG['retention'], now()))
        selected = {(r['box'], r['name']) for r in eligible}
        eligible += [r for r in snaps if (r['box'], r['name']) in count_gone and not r['clones']
                     and (r['box'], r['name']) not in selected and (r['box'], r['name']) not in missing_snapshots]
        oversized = {}
        for bid, usage in sizes.items():
            box = con.execute("SELECT 1 FROM boxes WHERE id=? AND name LIKE '%repository pool%' AND deleted_at IS NULL", (bid,)).fetchone()
            over = usage.get('snapshot_bytes', 0) - disk.SNAPSHOT_RATIO * usage.get('live_bytes', 0)
            if box and usage.get('live_bytes', 0) > 0 and over > 0 and bid not in protected:
                oversized[bid] = over
        # Tackle the boxes causing growth first, oldest history within each
        # budget tier. Small unrelated history must not consume the tick.
        eligible.sort(key=lambda r: (0 if r['box'] in oversized else 1,
                                     -oversized.get(r['box'], 0), r['created_at'], r['name']))
        attempts = 0
        for row in eligible:
            box = con.execute('SELECT name FROM boxes WHERE id=? AND deleted_at IS NULL', (row['box'],)).fetchone()
            if box is None:
                continue
            usage = sizes.get(row['box'], {})
            too_large = (box and 'repository pool' in (box['name'] or '') and usage.get('live_bytes', 0) > 0
                         and usage.get('snapshot_bytes', 0) > disk.SNAPSHOT_RATIO * usage['live_bytes'])
            need_pool = bool(pool and pool['free_bytes'] < cleanup.get('target_bytes', 0))
            count = (row['box'], row['name']) in count_gone
            reason = 'pool_pressure' if need_pool and row['box'] not in protected else 'box_snapshot_bytes' if too_large and row['box'] not in protected else 'count_retention' if count else None
            if reason is None:
                continue
            if row['box'] in snapshot_protected(con, pressure=reason != 'count_retention'):
                continue
            # The bound applies to actionable candidates, never to unrelated
            # under-budget boxes that happen to have older history.
            attempts += 1
            if attempts > 256:
                break
            if now() - cleanup.get('last_delete_at', 0) < disk.DELETE_GAP_S:
                hold = 'delete_gap'
                pressure = {}
            else:
                try:
                    pressure = disk.cleanup_pressure(CFG['zpool'])
                    hold = disk.yield_reason(pressure)
                except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                    pressure, hold = {}, 'pressure_unknown'
            if hold:
                toollog.emit('boatd', 'snapshot.yield', ok=True, ids={'box': row['box']},
                             props={'snapshot': row['name'], 'reason': hold, **pressure})
                break
            rc, clones = _sh(['zfs', 'get', '-Hp', '-o', 'value', 'clones', row['dataset']])
            if rc or clones.strip() != '-':
                continue
            before = pool_free(value)
            # Persist before dispatch, so another process/crash cannot issue a
            # burst while ZFS's asynchronously freed bytes are still pending.
            cleanup['last_delete_at'] = now()
            con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES ('disk_cleanup',?)", (json.dumps(cleanup),))
            try:
                result = incus('snapshot', 'delete', ct(row['box']), row['name'], timeout=120, check=False)
            finally:
                cleanup['last_delete_at'] = now()
                con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES ('disk_cleanup',?)", (json.dumps(cleanup),))
            missing = result.returncode != 0 and b'not found' in result.stderr.lower()
            if missing:
                missing_snapshots.add((row['box'], row['name']))
            if result.returncode and not missing:
                toollog.emit('boatd', 'snapshot.prune', kind='error', ok=False,
                             ids={'box': row['box']}, props={'snapshot': row['name'], 'reason': reason}, tag='snapshot_prune')
                break
            con.execute('DELETE FROM snaps WHERE box_id=? AND name=?', (row['box'], row['name']))
            value = disk_state(fresh=True)
            sizes, snaps = disk.inventory(zpool())
            value['boxes'] = sizes
            toollog.emit('boatd', 'snapshot.prune', ok=True, ids={'box': row['box']},
                         props={'snapshot': row['name'], 'bytes': row['bytes'],
                                'bytes_freed': 0 if missing else max(0, pool_free(value)-before),
                                'snapshot_bytes': sizes.get(row['box'], {}).get('snapshot_bytes'),
                                'reason': 'missing' if missing else reason})
            break
        cleanup['shortfall_bytes'] = max(0, cleanup.get('target_bytes', 0) - pool_free(value))
        cleanup['budget_shortfall_bytes'] = sum(max(0, int(u['snapshot_bytes'] - disk.SNAPSHOT_RATIO * u['live_bytes']))
            for bid, u in sizes.items() if u.get('live_bytes', 0) > 0 and con.execute(
                "SELECT 1 FROM boxes WHERE id=? AND name LIKE '%repository pool%' AND deleted_at IS NULL", (bid,)).fetchone())
        value['cleanup'] = {k: v for k, v in cleanup.items() if k not in ('last_delete_at', 'missing_snapshots')}
        cleanup['missing_snapshots'] = sorted(missing_snapshots)
        value['snapshot_bytes_by_kind'] = disk.kind_bytes(snaps)
        DISK.update(boxes=sizes, cleanup=value['cleanup'], snapshot_bytes_by_kind=value['snapshot_bytes_by_kind'])
        con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES ('disk_cleanup',?)", (json.dumps(cleanup),))
        con.execute("INSERT OR REPLACE INTO meta(k,v) VALUES ('disk',?)", (json.dumps(value),))
    return value


def health(fresh: bool = False) -> dict:
    if fresh:
        refresh_health(fresh=True)
    # A reference swap publishes a complete snapshot. No reader waits for the refresh lock or subprocesses.
    snapshot = dict(_HEALTH)
    cached = snapshot["v"]
    status = startup_status()
    out = dict(cached or {"ok": False, "up": True, "mode": "degraded", "reasons": ["starting"],
                          "pool": {"name": CFG["zpool"], "state": "UNKNOWN"}, "mdraid": {"state": "unknown", "arrays": {}},
                          "queue": None, "running": None, "version": VERSION,
                          "restartPending": {"count": 0, "since": None}, "boot": STATE.get("boot"),
                          "startupPhases": STATE.get("phases", {}), "loops": {}, "degraded": False, "problem": None})
    if not READY.is_set():
        reason = STATE["problem"] or "starting"
        out.update(ok=False, mode="degraded", reasons=[reason] + [r for r in out.get("reasons", []) if r != reason])
    age = max(0, now() - snapshot["ts"]) if cached else None
    refresh = dict(_HEALTH_REFRESH)
    out.update(host=host_pressure(), **status, boot_id=boot_id(), uptime_s=int(host_uptime()), boatd_uptime_s=int(now() - STARTED),
               snapshot_age_s=round(age, 1) if age is not None else None,
               refresh_stage=refresh["stage"],
               refresh_stage_ms=round((time.monotonic() - refresh["since"]) * 1000, 1)
               if refresh["since"] is not None else 0,
               refresh_timings_ms=dict(refresh["timings"]), startupPhases=dict(STATE.get("phases") or {}))
    return out


def refresh_health_forever():
    while True:
        try:
            refresh_health(fresh=True)
        except Exception:
            log(f"health-refresh failed stage={_HEALTH_REFRESH['stage']}: {traceback.format_exc()[-600:]}")
        time.sleep(5)


# ---------------------------------------------------------------- incus

class Fail(Exception):
    def __init__(self, status: int, code: str, message: str = "", details: dict | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message
        self.details = details or {}


_INCUS_LOCK = threading.Lock()
_INCUS_ACTIVE = {}
_INCUS_SLOW_UNTIL = 0.0
_PROXY_BUDGET = threading.local()


def incus_kind(args):
    # Only verbs go into analytics; exec scripts, keys and config values must never do so.
    count = 3 if args[0] == 'config' and args[1:2] == ('device',) else 2 if args[0] in ('config', 'snapshot') else 1
    return '.'.join(args[:count])


def maintenance_hold(exclude_box=None):
    with _INCUS_LOCK:
        if time.monotonic() < _INCUS_SLOW_UNTIL:
            return 'incus_slow'
    try:
        if json.loads((VAR / 'incus-slow.json').read_text())['until'] > now():
            return 'incus_slow'
    except (OSError, ValueError, KeyError, TypeError):
        pass
    con = db()
    try:
        if con.execute("SELECT 1 FROM boxes WHERE state IN ('provisioning','resuming') AND id != ? LIMIT 1",
                       (exclude_box or '',)).fetchone():
            return 'bring_up'
    finally:
        con.close()
    return None


def record_slow_incus(kind, elapsed):
    path = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=VAR, prefix='.incus-slow-', delete=False) as output:
            path = output.name
            json.dump({'until': now() + 30, 'command_kind': kind, 'duration_ms': elapsed}, output)
        os.replace(path, VAR / 'incus-slow.json')
    except OSError:
        log('incus latency cooldown could not be persisted')
    finally:
        if path:
            Path(path).unlink(missing_ok=True)


def deletion_hold():
    con = db()
    try:
        row = con.execute("SELECT v FROM meta WHERE k='disk_cleanup'").fetchone()
        state = json.loads(row[0]) if row else {}
        if now() - state.get('last_delete_at', 0) < disk.DELETE_GAP_S:
            return 'delete_gap'
        try:
            return disk.yield_reason(disk.cleanup_pressure(CFG['zpool']))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            return 'pressure_unknown'
    finally:
        con.close()


def record_delete_time():
    con = db()
    try:
        row = con.execute("SELECT v FROM meta WHERE k='disk_cleanup'").fetchone()
        state = json.loads(row[0]) if row else {}
        state['last_delete_at'] = now()
        con.execute("INSERT OR REPLACE INTO meta VALUES ('disk_cleanup',?)", (json.dumps(state),))
    finally:
        con.close()


def incus(*args, input: bytes | None = None, timeout: float = 600, check: bool = True,
          before_dispatch=None) -> subprocess.CompletedProcess:
    global _INCUS_SLOW_UNTIL
    kind = incus_kind(args)
    box = next(('bx_' + m[1] for x in args if (m := re.search(r'(?:^|/)bx-([a-z0-9]+)(?=$|/|\?)', x))), None)
    housekeeping = args[0] == 'delete' or args[:2] in (('snapshot', 'create'), ('snapshot', 'delete'))
    slot = storage_slot = None
    exclude = box if args[0] == 'delete' else None
    hold = maintenance_hold(exclude) if housekeeping else None
    if housekeeping and not hold:
        slot = open(VAR / 'incus-maintenance.lock', 'a')
        try:
            fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            hold = maintenance_hold(exclude)
        except BlockingIOError:
            hold = 'incus_busy'
    if args[0] == 'delete' and CFG.get('state_dataset') and not hold:
        storage_slot = open(VAR / 'disk.lock', 'a')
        try:
            fcntl.flock(storage_slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            hold = deletion_hold()
            if not hold:
                record_delete_time()
                hold = maintenance_hold(exclude)
        except BlockingIOError:
            hold = 'disk_busy'
    if not hold and before_dispatch:
        try:
            if not before_dispatch():
                hold = 'incus_busy'
        except BaseException:
            if slot:
                slot.close()
            if storage_slot:
                storage_slot.close()
            raise
    if hold:
        if slot:
            slot.close()
        if storage_slot:
            storage_slot.close()
        toollog.emit('boatd', 'incus_deferred', ids={'box': box}, props={'commandKind': kind, 'reason': hold})
        if check:
            raise Fail(503, 'incus_busy', f'{kind} deferred: {hold}')
        return subprocess.CompletedProcess(['incus', *args], 75, b'', f'deferred: {hold}'.encode())
    began = time.monotonic()
    token = object()
    with _INCUS_LOCK:
        _INCUS_ACTIVE[token] = {'kind': kind, 'box': box, 'since': began}
    outcome, code = 'error', None
    try:
        with boatd_memory.lifecycle_lock(VAR) if args[0] in ('start', 'init', 'copy') else contextlib.nullcontext():
            p = subprocess.run(["incus", *args], input=input, capture_output=True, timeout=timeout)
        code, outcome = p.returncode, 'ok' if not p.returncode else 'error'
        if check and p.returncode != 0:
            raise Fail(500, "incus_failed", f"incus {' '.join(args[:3])}: {p.stderr.decode(errors='replace')[-500:]}")
        return p
    except subprocess.TimeoutExpired as e:
        outcome = 'timeout'
        elapsed = round((time.monotonic() - began) * 1000, 1)
        with _INCUS_LOCK:
            busy = [{**v, 'elapsed_ms': round((time.monotonic()-v['since'])*1000, 1)}
                    for k, v in _INCUS_ACTIVE.items() if k is not token]
        facts = {'command_kind': kind, 'elapsed_ms': elapsed, 'timeout_s': timeout,
                 'busy': [{k: v for k, v in row.items() if k != 'since'} for row in busy[:8]],
                 'psi_io': psi('io'), 'psi_cpu': psi('cpu')}
        # Command recovery already handles TimeoutExpired, including check=False
        # probes. Only proxy preparation turns it into a box-start API failure.
        e.incus_details = facts
        raise
    finally:
        elapsed = (time.monotonic() - began) * 1000
        slow_mutation = args[0] not in ('query', 'list', 'exec', 'info') and (outcome == 'timeout' or elapsed >= 3000)
        with _INCUS_LOCK:
            _INCUS_ACTIVE.pop(token, None)
            if slow_mutation:
                _INCUS_SLOW_UNTIL = time.monotonic() + 30
        if slow_mutation:
            record_slow_incus(kind, elapsed)
        if storage_slot:
            try:
                record_delete_time()
            except sqlite3.Error:
                log('delete completion time could not be persisted; dispatch time remains recorded')
            finally:
                storage_slot.close()
        if slot:
            slot.close()
        toollog.emit('boatd', 'incus_call', kind='perf' if outcome == 'ok' else 'error',
                     duration_ms=elapsed, ok=outcome == 'ok', ids={'box': box},
                     props={'commandKind': kind, 'outcome': outcome, 'exitCode': code, 'timeoutSeconds': timeout},
                     tag='incus_slow' if outcome == 'timeout' else None)


def ct(box_id: str) -> str:
    return box_id.replace("_", "-")


def ct_state(box_id: str) -> dict:
    p = incus("query", f"/1.0/instances/{ct(box_id)}/state", check=False, timeout=30)
    if p.returncode != 0:
        return {}
    return json.loads(p.stdout or b"{}")


def ct_running(box_id: str) -> bool:
    return (ct_state(box_id).get("status") or "").lower() == "running"


def cg_path(box_id: str) -> Path:
    return boatd_memory.payload_path(CG_ROOT, ct(box_id))


def ct_exec(box_id: str, cmd: str, input: bytes | None = None, timeout: float = 120, user: int = 0,
            check: bool = True) -> subprocess.CompletedProcess:
    args = ["exec", ct(box_id)]
    if user:
        args += ["--user", str(user), "--group", str(user), "--env", "HOME=/home/user"]
    return incus(*args, "--", "bash", "-c", cmd, input=input, timeout=timeout, check=check)


def scratch():
    return boatd_tmp.Scratch(CFG, incus)


def check_instance_identity(box_id: str) -> None:
    p = incus('query', f'/1.0/instances/{ct(box_id)}', check=False, timeout=30)
    if p.returncode and not instance_missing(p):
        raise Fail(500, 'incus_failed', 'cannot confirm interrupted instance identity')
    if not p.returncode and json.loads(p.stdout).get('config', {}).get('user.offbox.provision') != box_id:
        raise Fail(500, 'instance_identity', 'refusing cleanup of an unlabelled interrupted instance')


def delete_instance(box_id: str, owner: str, require_identity: bool = False) -> None:
    with boatd_tmp.lock(box_id):
        if require_identity:
            check_instance_identity(box_id)
        deleted = incus('delete', ct(box_id), '--force', timeout=300, check=False)
        if deleted.returncode and not instance_missing(deleted):
            raise Fail(500, 'incus_failed', 'Incus did not confirm instance deletion')
        scratch().delete(box_id, owner)


def cleanup_provision(box_id: str, owner: str) -> None:
    con = db()
    try:
        with box_memory_lock(box_id):
            snapshot = require_unprotected(con, box_id)
            delete_instance(box_id, owner, require_identity=True)
            box_event(con, box_id, 'delete', 'failed provision cleanup', snapshot)
    finally:
        con.close()


# ---------------------------------------------------------------- boxes

def new_box_id(con) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    while True:
        bid = "bx_" + "".join(secrets.choice(alphabet) for _ in range(8))
        if not con.execute("SELECT 1 FROM boxes WHERE id=?", (bid,)).fetchone():
            return bid


def next_ssh_port(con) -> int:
    used = {p for r in con.execute("SELECT ssh_port, mgmt_ssh_port FROM boxes WHERE deleted_at IS NULL") for p in r if p}
    p = CFG["ssh_port_base"]
    while p in used:
        p += 1
    if p > 65535:
        raise Fail(503, "ssh_ports_exhausted", "no free SSH proxy port")
    return p


def size_of(t: str | None) -> str:
    t = t or "default"
    if t not in CFG["sizes"]:
        raise Fail(400, "invalid_type", f"unknown type {t}; one of {', '.join(CFG['sizes'])}")
    return t


def apply_size(box_id: str, t: str) -> None:
    s = CFG["sizes"][t]
    incus("config", "set", ct(box_id), f"limits.memory={s['mem']}", f"limits.cpu.priority={s['prio']}",
          "limits.memory.swap=false")


def box_row(con, box_id: str, owner: str | None = None):
    """owner=None is boatd itself; a request passes its token's owner, and someone else's box does not exist."""
    r = con.execute("SELECT * FROM boxes WHERE id=? AND deleted_at IS NULL", (box_id,)).fetchone()
    if not r or (owner is not None and r["owner"] != owner):
        raise Fail(404, "sandbox_not_found", f"no sandbox {box_id}")
    return r


def set_box(con, box_id: str, **kw) -> None:
    with box_transaction(con):
        _set_box(con, box_id, **kw)


@contextmanager
def box_transaction(con):
    own = not con.in_transaction
    if own:
        con.execute('BEGIN IMMEDIATE')
    try:
        yield
        if own:
            con.execute('COMMIT')
    except BaseException:
        if own:
            con.execute('ROLLBACK')
        raise


def _set_box(con, box_id, **kw):
    before = con.execute('SELECT state FROM boxes WHERE id=?', (box_id,)).fetchone()
    changed = 'state' in kw and before and before['state'] != kw['state']
    snapshot = box_protection(con, box_id, probe=False) if changed else None
    kw["updated_at"] = now()
    cols = ", ".join(f"{k}=?" for k in kw)
    con.execute(f"UPDATE boxes SET {cols} WHERE id=?", (*kw.values(), box_id))
    if changed:
        action = {'archived': 'archive', 'deleted': 'delete', 'resuming': 'resume',
                  'stopping': 'stop', 'error': 'health_fail'}.get(kw['state'], 'state_change')
        box_event(con, box_id, action, kw.get('error') or offbox_protection.caller().get('reason') or
                  f"{before['state']} -> {kw['state']}",
                  snapshot, state_before=before['state'], state_after=kw['state'])


def box_event(con, box_id, action, reason, snapshot=None, **fields):
    data = offbox_protection.envelope(action, reason, snapshot or box_protection(con, box_id, probe=False), **fields)
    detail = json.dumps(data, separators=(',', ':'))
    con.execute('INSERT INTO box_events(ts,box_id,action,detail) VALUES (?,?,?,?)', (now(), box_id, action, detail))
    log(detail)
    toollog.emit('boatd', 'box.' + action, ok=True, ids={'box': box_id, 'run': data['caller'].get('run_id')}, props=data)


def box_protection(con, box_id, *, probe=True, run_id=None):
    row = box_row(con, box_id)
    pin = bool(row['pinned']) and (row['pin_until'] is None or row['pin_until'] > now())
    holds, gone, resolved = [], False, []
    # An exited shell can leave children behind, including sync commands without run metadata.
    # Only a positive process probe retires an invocation from lifecycle protection.
    rows = con.execute('SELECT * FROM commands WHERE box_id=? ORDER BY pid DESC', (box_id,)).fetchall()
    for c in rows:
        if run_id and c['run_id'] != run_id:
            continue
        metrics = json.loads(c['metrics'] or '{}')
        cache_key = f"holder_gone:{box_id}:{c['pid']}:{c['attempt'] or 1}"
        if con.execute('SELECT 1 FROM meta WHERE k=?', (cache_key,)).fetchone():
            if run_id:
                gone = True
            continue
        never_dispatched = (c['status'] not in ('queued', 'running') and c['started_at'] is None and
                            (metrics.get('not_dispatched') is True or queue_loss_json(c)['notAdmitted']))
        proof = ({'stopped': True, 'reason': 'not_dispatched'} if never_dispatched else
                 command_probe(c) if probe and c['status'] != 'queued' else {})
        confirmed = (proof.get('stopped') is True or (proof.get('readable') is True and
                     proof.get('pids') == [] and (proof.get('join_verified') is True or proof.get('box_rc') is not None)))
        if run_id:
            gone = confirmed or gone
        if confirmed:
            resolved.append((cache_key, c, never_dispatched))
            continue
        holds.append(dict(run_id=c['run_id'], holder=c['holder'] or row['owner'],
                          state=c['status'], process_id=c['pid'], probe=proof))
    snapshot = dict(pin=dict(active=pin, until=iso(row['pin_until']), holder=row['pin_holder']), holds=holds,
                    confirmedGone=gone and not holds)
    for cache_key, c, never_dispatched in resolved:
        with box_transaction(con):
            inserted = con.execute('INSERT OR IGNORE INTO meta(k,v) VALUES (?,?)', (cache_key, 'probe')).rowcount
            if inserted:
                reason = 'command confirmed never dispatched' if never_dispatched else 'receipt/process probe confirmed holder gone'
                box_event(con, box_id, 'lease_free', reason, snapshot,
                          run_id=c['run_id'], holder=c['holder'], process_id=c['pid'])
    return snapshot


def require_unprotected(con, box_id, *, reuse=False):
    snapshot = box_protection(con, box_id)
    caller = offbox_protection.caller()
    override = caller.get('override') is True and caller.get('actor') == 'client:release'
    reason = offbox_protection.blocked(snapshot, holder=caller.get('holder'),
                                      automatic=not reuse and not override, reuse=reuse, override=override)
    if reason:
        box_event(con, box_id, 'protection_refused', reason, snapshot)
        raise Fail(409, 'box_held', f'{box_id} is {reason}; explicit release --override-protection required')
    return snapshot


def latest_snap(con, box_id: str):
    return con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC LIMIT 1", (box_id,)).fetchone()


def held_runs(con, box_id: str, *, exclude_pid=None) -> list[str]:
    held = []
    for c in con.execute("SELECT * FROM commands WHERE box_id=? AND (status='running' OR killed=1)", (box_id,)):
        if c['pid'] == exclude_pid:
            continue
        m = json.loads(c['metrics'] or '{}')
        info = m.get('interruption') or {}
        if (c['status'] == 'running' and (info.get('stream_state') in ('unknown', 'reattached') or info.get('cleanup') == 'unknown')) or \
                (m.get('kill') or {}).get('cleanup') == 'unknown' or \
                m.get('kill_request') or \
                (read_result(box_id, c['pid'], c['attempt'] or 1) or {}).get('kill_pending'):
            held.append(c['run_id'] or f"process-{c['pid']}")
    return held


def box_json(con, r) -> dict:
    s = CFG["sizes"].get(r["type"], CFG["sizes"]["default"])
    running = con.execute("SELECT COUNT(*) FROM commands WHERE box_id=? AND status IN ('queued','running')",
                          (r["id"],)).fetchone()[0]
    state = r["state"]
    if state == "ready" and running:
        state = "running"
    snap = latest_snap(con, r["id"])
    protection = box_protection(con, r['id'], probe=False)
    last_event = con.execute('SELECT detail FROM box_events WHERE box_id=? ORDER BY seq DESC LIMIT 1', (r['id'],)).fetchone()
    archive_after = None
    if state in LIVE and r["ttl"]:
        archive_after = iso((r["last_active"] or r["updated_at"]) + r["ttl"])
    return {
        "snapshotBytes": (DISK.get('boxes') or {}).get(r['id'], {}).get('snapshot_bytes'),
        'lastEvent': json.loads(last_event['detail']) if last_event else None,
        "id": r["id"], "name": r["name"], "state": state, "error": r["error"], "dataExpiredAt": None,
        'heldRuns': held_runs(con, r['id']),
        "stoppedAt": iso(r["stopped_at"]) if state == "archived" else None, "labels": json.loads(r["labels"] or "{}"),
        "health": "unhealthy" if r['start_error'] else "ok", "startError": json.loads(r['start_error']) if r['start_error'] else None,
        "type": r["type"], "vcpu": s["vcpu"], "memoryGB": int(re.sub(r"\D", "", s["mem"])),
        "billingMultiplier": 0, "machineProvider": "offbox-server",
        "sshEndpoint": f"{CFG['ssh_host']}:{r['ssh_port']}" if r["ssh_port"] else None,
        "owner": r["owner"],
        "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "archiveAfter": archive_after,
        "ttlSeconds": r["ttl"], "snapshots": True, "snapshotAvailable": snap is not None,
        "snapshotCompletedAt": iso(snap["created_at"]) if snap else None,
        "lastSnapshotStatus": "completed" if snap else None, "source": r["source"],
        "pinned": protection['pin']['active'],
        "protection": protection,
        "environment": "offbox-server",
    }


def _ensure_device(box_id, device, port, connect=None):
    began = time.monotonic()
    end = min(getattr(_PROXY_BUDGET, 'end', began + 180), began + 180)
    desired = {'listen': f"tcp:{CFG['ssh_host']}:{port}", 'connect': connect or 'tcp:127.0.0.1:22', 'bind': 'host'}
    slow_error = None
    for attempt, allowance in enumerate((30, 120), 1):
        operation = 'query'
        try:
            # A timed-out add may have committed in incusd after its CLI was killed.
            # Re-read before every attempt so retries cannot duplicate the device.
            config = json.loads(incus('query', f'/1.0/instances/{ct(box_id)}',
                                     timeout=max(.001, min(10, end-time.monotonic()))).stdout)
            current = config.get('devices', {}).get(device)
            if current and current.get('type') == 'proxy' and all(current.get(k) == v for k, v in desired.items()):
                return
            action = 'set' if current else 'add'
            values = [f'{k}={v}' for k, v in desired.items()]
            args = ('config', 'device', action, ct(box_id), device)
            if not current:
                args += ('proxy',)
            operation = 'config.device.' + action
            incus(*args, *values, timeout=max(.001, min(allowance, end-time.monotonic())))
            return
        except (Fail, subprocess.TimeoutExpired) as caught:
            if isinstance(caught, subprocess.TimeoutExpired):
                facts = getattr(caught, 'incus_details', {'command_kind': operation})
                error = Fail(503, 'incus_slow', f"{facts['command_kind']} on {box_id} exceeded {caught.timeout:g}s", facts)
                slow_error = error
            else:
                error = caught
            if error.code not in ('incus_slow', 'incus_failed'):
                raise
            # An earlier add can commit between our readback and the retry's add.
            # Reconcile nonzero exits too before taking the ordinary error path.
            try:
                config = json.loads(incus('query', f'/1.0/instances/{ct(box_id)}',
                                         timeout=max(.001, min(10, end-time.monotonic()))).stdout)
                current = config.get('devices', {}).get(device, {})
                if current.get('type') == 'proxy' and all(current.get(k) == v for k, v in desired.items()):
                    return
            except (Fail, subprocess.TimeoutExpired):
                pass
            if error.code == 'incus_failed' and slow_error is not None:
                error = slow_error
            if error.code != 'incus_slow':
                raise
            if attempt == 2 or time.monotonic() >= end:
                error.details.update(attempts=attempt, total_ms=round((time.monotonic()-began)*1000, 1))
                if error is caught:
                    raise
                raise error from caught
            toollog.emit('boatd', 'incus_retry', ids={'box': box_id},
                         props={'commandKind': error.details['command_kind'], 'attempt': attempt})


def _ensure_proxy(box_id: str, port: int) -> None:
    _ensure_device(box_id, 'ssh', port)


def _prepare_proxies(con, box_id):
    con.execute('BEGIN IMMEDIATE')
    try:
        port = box_row(con, box_id)['ssh_port']
        if port is None:
            port = next_ssh_port(con)
            con.execute('UPDATE boxes SET ssh_port=? WHERE id=?', (port, box_id))
        con.execute('COMMIT')
    except Exception:
        con.execute('ROLLBACK')
        raise
    # The shared ceiling leaves boot time inside the client's 300s resume wait.
    _PROXY_BUDGET.end = time.monotonic() + 180
    try:
        _ensure_proxy(box_id, port)
        _ensure_mgmt_proxy(con, box_id)
    finally:
        del _PROXY_BUDGET.end


def _ensure_mgmt_proxy(con, box_id: str) -> int:
    # Old boxes get a second proxy on demand; their stock SSH endpoint is never repointed.
    con.execute("BEGIN IMMEDIATE")
    try:
        port = box_row(con, box_id)["mgmt_ssh_port"]
        if port is None:
            port = next_ssh_port(con)
            con.execute("UPDATE boxes SET mgmt_ssh_port=? WHERE id=?", (port, box_id))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    _ensure_device(box_id, 'offbox-mgmt-ssh', port, f'tcp:127.0.0.1:{MGMT_PORT}')
    return port


def failed_start(con, box_id, error, *, provision=False, record=True):
    row = box_row(con, box_id)
    previous = json.loads(row['start_error'] or '{}')
    facts = {**previous, **error.details, 'class': error.code if record else previous.get('class', error.code),
             'provision': provision or previous.get('provision', False), 'cleanup': 'unknown'}
    changed = con.execute("UPDATE boxes SET state='stopping', stopped_at=NULL, error=?, start_error=?, updated_at=? "
                          "WHERE id=? AND (state IN ('provisioning','resuming') OR (state='stopping' AND ?))",
                          (str(error)[:500], json.dumps(facts), now(), box_id, provision))
    if not changed.rowcount:
        return
    if record:
        toollog.emit('boatd', 'box_start_failed', kind='error', ok=False, ids={'box': box_id},
                     props={'class': 'incus_slow', 'commandKind': facts.get('command_kind'), 'cleanup': 'unknown'},
                     duration_ms=facts.get('total_ms', facts.get('elapsed_ms')), tag='incus_slow')
    continue_failed_start(con, box_id)


def continue_failed_start(con, box_id):
    lock = boatd_tmp.lock(box_id)
    if not lock.acquire(blocking=False):
        return
    try:
        row = con.execute('SELECT state,start_error FROM boxes WHERE id=? AND deleted_at IS NULL', (box_id,)).fetchone()
        if not row or row['state'] != 'stopping' or not row['start_error']:
            return
        _failed_start(con, box_id)
    finally:
        lock.release()


def _failed_start(con, box_id):
    row = box_row(con, box_id)
    facts, error = json.loads(row['start_error']), row['error']
    facts['cleanup'] = 'unknown'
    # Keep the copied disk and its identity obligation. Ports are released only
    # after the instance is confirmed stopped and both local proxies are gone.
    try:
        if facts['provision']:
            check_instance_identity(box_id)
        incus('stop', ct(box_id), '--force', timeout=60, check=False)
        state = json.loads(incus('query', f'/1.0/instances/{ct(box_id)}/state', timeout=10).stdout)
        if state.get('status', '').lower() != 'stopped':
            raise Fail(503, 'incus_slow', 'cannot confirm instance stopped')
        config = json.loads(incus('query', f'/1.0/instances/{ct(box_id)}', timeout=10).stdout)
        for device in ('ssh', 'offbox-mgmt-ssh'):
            if device in config.get('devices', {}):
                incus('config', 'device', 'remove', ct(box_id), device, timeout=30)
        config = json.loads(incus('query', f'/1.0/instances/{ct(box_id)}', timeout=10).stdout)
        devices = config.get('expanded_devices', config.get('devices', {}))
        if any(device in devices for device in ('ssh', 'offbox-mgmt-ssh')):
            raise Fail(503, 'incus_slow', 'cannot confirm proxy removal')
        set_box(con, box_id, ssh_port=None, mgmt_ssh_port=None)
        facts['cleanup'] = 'stopped'
    except Exception as cleanup:
        log(f'slow start cleanup pending {box_id}: {cleanup}')
    set_box(con, box_id, state='archived' if facts['cleanup'] == 'stopped' else 'stopping',
            stopped_at=now() if facts['cleanup'] == 'stopped' else None,
            error=error, start_error=json.dumps(facts))


def _fresh_identity(box_id: str) -> None:
    """A copied box gets its own ssh host keys and hostname, and drops the source's authorized key list.
    The base image ships without host keys, so on a box's first boot sshd fails until systemd's start limit
    stops it: clear that (reset-failed) before the restart, or the restart is refused and sshd never comes up."""
    ct_exec(box_id, "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null 2>&1; "
                    f"hostnamectl set-hostname {ct(box_id)} 2>/dev/null || echo {ct(box_id)} > /etc/hostname; "
                    "systemctl reset-failed ssh.service ssh.socket sshd.service 2>/dev/null; "
                    "systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true; "
                    "systemctl is-active -q ssh.socket ssh.service sshd.service || systemctl start ssh.socket 2>/dev/null || true",
            timeout=60)
    ct_exec(box_id, "if test -f /etc/ssh/offbox_mgmt_sshd_config; then "
                    "systemctl reset-failed offbox-mgmt-ssh.service; systemctl restart offbox-mgmt-ssh.service; fi",
            timeout=60)


def _wait_boot(box_id: str, timeout: float = 120, ssh: bool = True) -> None:
    """Wait for systemd and management SSH; older images still use stock port 22."""
    end = now() + timeout
    probe = ("s=$(systemctl is-system-running 2>/dev/null); case $s in running|degraded) echo BOOTED;; esac; "
             f"p=22; test ! -f /etc/ssh/offbox_mgmt_sshd_config || p={MGMT_PORT}; "
             "ss -Hltn \"sport = :$p\" | grep -q . && echo SSHUP")
    while now() < end:
        out = ct_exec(box_id, probe, timeout=20, check=False).stdout.decode()
        if "BOOTED" in out and (not ssh or "SSHUP" in out):
            return
        time.sleep(0.5)
    raise Fail(500, "boot_timeout", f"{box_id} did not finish booting{' sshd' if ssh else ''} in {timeout}s")


def provision(box_id: str, source: tuple[str, str | None], t: str) -> None:
    """source: ("image", alias) | ("saved", instance) | ("box", box_id). Runs in a thread."""
    con = db()
    try:
        with lifecycle_lock(box_id), boatd_tmp.lock(box_id):
            try:
                # Keep the identity requirement after failed creation, later resumes and reaping.
                set_box(con, box_id, provision_identity=1, identity_pending=1)
                kind, ref = source
                name = ct(box_id)
                marker = ('-c', f'user.offbox.provision={box_id}')
                if kind == "image":
                    incus("init", ref, name, "-p", "default", "-p", "offbox", *marker, timeout=900)
                elif kind == "saved":
                    incus("copy", ref, name, "--instance-only", "-p", "default", "-p", "offbox", *marker, timeout=900)
                else:
                    incus("copy", ct(ref), name, "--instance-only", "-p", "default", "-p", "offbox", *marker, timeout=900)
                r = box_row(con, box_id)
                scratch().create(box_id, r['owner'])
                apply_size(box_id, t)
                r = box_row(con, box_id)
                _prepare_proxies(con, box_id)
                if box_row(con, box_id)['state'] != 'provisioning':
                    return
                scratch().start(box_id)
                _wait_boot(box_id, ssh=False)
                scratch().verify(box_id)
                _fresh_identity(box_id)
                set_box(con, box_id, identity_pending=0)
                _wait_boot(box_id)
                if con.execute("UPDATE boxes SET state='ready', last_active=?, updated_at=?, error=NULL, start_error=NULL "
                               "WHERE id=? AND state='provisioning'", (now(), now(), box_id)).rowcount:
                    log(f"box {box_id} ready ({kind} {ref} {t})")
            except Exception as e:  # noqa: BLE001
                log(f"provision {box_id} failed: {e}")
                if isinstance(e, Fail) and e.code == 'incus_slow':
                    failed_start(con, box_id, e, provision=True)
                    return
                try:
                    cleanup_provision(box_id, box_row(con, box_id)['owner'])
                except Exception as cleanup:
                    log(f'provision cleanup deferred for {box_id}: {cleanup}')
                    e = RuntimeError(f'{e}; cleanup deferred: {cleanup}')
                set_box(con, box_id, state="error", error=str(e)[:500])
    finally:
        con.close()


def create_box(con, body: dict, idem: str | None, owner: str, src_box: str | None = None) -> dict:
    if idem:
        idem = f"{owner}:{idem}"
        r = con.execute("SELECT box_id FROM idem WHERE key=?", (idem,)).fetchone()
        if r:
            return box_json(con, box_row(con, r["box_id"], owner))
    disk_admit()
    t = size_of(body.get("type") or (src_box and box_row(con, src_box, owner)["type"]))
    if src_box:
        box_row(con, src_box, owner)
        source = ("box", src_box)
        src_label = src_box
    elif body.get("from"):
        s = con.execute("SELECT * FROM saved WHERE owner=? AND name=?", (owner, body["from"])).fetchone()
        if not s or s["status"] != "ready":
            raise Fail(404, "snapshot_not_found", f"no ready saved snapshot {body['from']}")
        source = ("saved", s["instance"])
        src_label = "saved:" + body["from"]
    else:
        source = ("image", CFG["base_image"])
        src_label = "image:" + CFG["base_image"]
    bid = new_box_id(con)
    t0 = now()
    con.execute("BEGIN IMMEDIATE")
    con.execute("INSERT INTO boxes (id, name, type, state, ttl, last_active, created_at, updated_at, ssh_port, source, "
                "owner, provision_identity) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)", (bid, (body.get("name") or bid)[:120], t, "provisioning",
                                                          int(body.get("ttlSeconds") or 1200), t0, t0, t0,
                                                          next_ssh_port(con), src_label, owner))
    if idem:
        con.execute("INSERT INTO idem VALUES (?,?,?)", (idem, bid, t0))
    con.execute("COMMIT")
    threading.Thread(target=offbox_protection.bind(provision), args=(bid, source, t), daemon=True).start()
    return box_json(con, box_row(con, bid))


def queue_snapshot(con, box_id, kind):
    # Renew the request without changing its turn in the replay queue.
    con.execute('INSERT INTO snapshot_pending(box_id,kind,generation) VALUES (?,?,?) '
                'ON CONFLICT(box_id,kind) DO UPDATE SET generation=excluded.generation',
                (box_id, kind, secrets.token_hex(16)))


def snapshot(con, box_id: str, kind: str, *, before_dispatch=None) -> str | None:
    pending = con.execute('SELECT generation FROM snapshot_pending WHERE box_id=? AND kind=?', (box_id, kind)).fetchone()
    generation = pending[0] if pending else None
    if kind in RUN_KINDS:
        value = disk_maintenance(con)
        usage = (value.get('boxes') or DISK.get('boxes') or {}).get(box_id, {})
        box = con.execute('SELECT name FROM boxes WHERE id=?', (box_id,)).fetchone()
        over_budget = bool(box and 'repository pool' in (box['name'] or '') and usage.get('live_bytes', 0) > 0
                           and usage.get('snapshot_bytes', 0) > disk.SNAPSHOT_RATIO * usage['live_bytes'])
        if value['level'] in ('full', 'unknown') or (value.get('cleanup') or {}).get('shortfall_bytes', 0) or over_budget:
            toollog.emit('boatd', 'snapshot.skip', ok=True, ids={'box': box_id},
                         props={'snapshot': kind, 'bytes_freed': 0, 'reason': 'snapshot_budget' if over_budget else 'server_disk_low', 'disk': value})
            con.execute('DELETE FROM snapshot_pending WHERE box_id=? AND kind=? AND generation=?', (box_id, kind, generation))
            return None
    name = f"{kind}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')[:-3]}"
    dispatch = {'before_dispatch': before_dispatch} if before_dispatch else {}
    p = incus("snapshot", "create", ct(box_id), name, timeout=120, check=False, **dispatch)
    if p.returncode == 75:
        if not before_dispatch:
            queue_snapshot(con, box_id, kind)
        return None
    if p.returncode != 0:
        log(f"snapshot {box_id} {name} failed: {p.stderr.decode(errors='replace')[-300:]}")
        return None
    con.execute("INSERT OR REPLACE INTO snaps VALUES (?,?,?,?)", (box_id, name, kind, now()))
    con.execute('DELETE FROM snapshot_pending WHERE box_id=? AND kind=? AND generation=?', (box_id, kind, generation))
    return name


def drain_pending_snapshots(con):
    pending = con.execute("SELECT p.rowid AS request_id, p.* FROM snapshot_pending p JOIN boxes b ON b.id=p.box_id "
                          "WHERE b.deleted_at IS NULL AND b.state IN ('ready','running','archived') ORDER BY p.rowid LIMIT 1").fetchall()
    for row in pending:
        # Claim only an admitted dispatch: cooldown must preserve this turn.
        def claim():
            changed = con.execute('INSERT OR REPLACE INTO snapshot_pending SELECT box_id,kind,generation FROM snapshot_pending '
                                  'WHERE rowid=? AND generation=?', (row['request_id'], row['generation'])).rowcount > 0
            if changed:
                con.execute("INSERT OR REPLACE INTO meta VALUES ('incus_replay_next','deletes')")
            return changed
        try:
            if snapshot(con, row['box_id'], row['kind'], before_dispatch=claim):
                prune_snaps(con, row['box_id'])
        except Exception as error:  # noqa: BLE001
            log(f"snapshot replay deferred for {row['box_id']}: {error}")


RUN_KINDS = ("auto", "stop")
TIMER_KINDS = ("hourly", "daily", "weekly")


def snaps_to_prune(rows: list, ret: dict, t: float) -> list[str]:
    """rows: snaps of one box, newest first (name, kind, created_at). Names that retention lets go.
    Run snapshots (auto, stop): newest run_keep plus the last of each day for run_daily_days. Timer snapshots:
    newest person_<kind> of each kind. Any other kind is kept."""
    keep = set()
    runs = [r for r in rows if r["kind"] in RUN_KINDS]
    keep |= {r["name"] for r in runs[:ret["run_keep"]]}
    days: dict[str, str] = {}
    cutoff = t - ret["run_daily_days"] * 86400
    for r in runs:  # newest first: the first one seen on a day is that day's last
        day = iso(r["created_at"])[:10]
        if r["created_at"] >= cutoff and day not in days:
            days[day] = r["name"]
    keep |= set(days.values())
    for kind in TIMER_KINDS:
        keep |= {r["name"] for r in [x for x in rows if x["kind"] == kind][:ret[f"person_{kind}"]]}
    keep |= {r["name"] for r in rows if r["kind"] not in RUN_KINDS + TIMER_KINDS}
    return [r["name"] for r in rows if r["name"] not in keep]


def prune_snaps(con, box_id: str) -> None:
    if CFG.get('state_dataset'):
        disk_maintenance(con)
        return
    rows = con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC", (box_id,)).fetchall()
    gone = set(snaps_to_prune(rows, CFG["retention"], now()))
    for r in rows:
        if r["name"] not in gone:
            continue
        before = disk_state(fresh=True) if CFG.get('state_dataset') else None
        if CFG.get('state_dataset'):
            rc, clones = _sh(['zfs', 'get', '-Hp', '-o', 'value', 'clones',
                              f"{zpool()}/containers/{ct(box_id)}@snapshot-{r['name']}"])
            if rc or clones.strip() != '-':
                continue
        p = incus("snapshot", "delete", ct(box_id), r["name"], timeout=120, check=False)
        if p.returncode == 0 or b"not found" in p.stderr.lower():
            con.execute("DELETE FROM snaps WHERE box_id=? AND name=?", (box_id, r["name"]))
            toollog.emit('boatd', 'snapshot.prune', ok=True, ids={'box': box_id},
                         props={'snapshot': r['name'], 'reason': 'count_retention',
                                'bytes_freed': max(0, pool_free(disk_state(fresh=True)) - pool_free(before)) if before else 0})


def stop_box(con, box_id: str, why: str) -> None:
    token = offbox_protection.CALLER.set(offbox_protection.caller(reason=why))
    try:
        with box_memory_lock(box_id):
            require_unprotected(con, box_id)
            if box_row(con, box_id)['state'] == 'archived':
                return
            set_box(con, box_id, state='stopping', stopped_at=None)
        continue_stop(con, box_id, why)
    finally:
        offbox_protection.CALLER.reset(token)


def continue_stop(con, box_id: str, why: str) -> None:
    # Cancellation was already published; an old worker must not cancel a new resume.
    token = offbox_protection.CALLER.set(offbox_protection.caller(reason=why))
    try:
        with lifecycle_lock(box_id), boatd_tmp.lock(box_id):
            if box_row(con, box_id)['state'] != 'stopping':
                return
            with box_memory_lock(box_id):
                require_unprotected(con, box_id)
            settle_box_commands(con, box_id)
            with box_memory_lock(box_id):
                require_unprotected(con, box_id)
                _stop_box(con, box_id, why)
    finally:
        offbox_protection.CALLER.reset(token)


def _stop_box(con, box_id: str, why: str) -> None:
    r = box_row(con, box_id)
    if r['start_error']:
        if r['state'] == 'stopping':
            continue_failed_start(con, box_id)
        return
    if r["state"] == "archived":
        return
    set_box(con, box_id, state="stopping")
    if ct_running(box_id):
        incus("stop", ct(box_id), "--timeout", "60", timeout=120, check=False)
        if ct_running(box_id):
            incus("stop", ct(box_id), "--force", timeout=60)
    # Cleanup may touch another box or time out after a delete. Its persisted
    # pacing fence must survive, but cannot leave this stopped box in 'stopping'.
    try:
        snapshot(con, box_id, "stop")
        prune_snaps(con, box_id)
    except Exception as e:  # noqa: BLE001
        log(f"snapshot cleanup deferred for {box_id}: {e}")
        toollog.emit('boatd', 'snapshot.defer', kind='error', ok=False, ids={'box': box_id},
                     props={'snapshot': 'stop', 'reason': 'cleanup_failed', 'error': str(e)[:300]},
                     tag='snapshot_cleanup')
    set_box(con, box_id, state="archived", stopped_at=now())
    log(f"box {box_id} stopped ({why})")


def resume_box(con, box_id: str, body: dict) -> None:
    with lifecycle_lock(box_id), box_memory_lock(box_id):
        check_delete_fence(con, box_id)
        row = box_row(con, box_id)
        if row['state'] == 'stopping':
            if row['start_error']:
                failure = json.loads(row['start_error'])
                raise Fail(503, failure.get('class', 'incus_failed'), 'failed start cleanup is still pending', failure)
            raise Fail(409, 'sandbox_unavailable', f'{box_id} is stopping')
        require_unprotected(con, box_id, reuse=True)
        _resume_box(con, box_id, body)


def _resume_box(con, box_id, body):
    disk_admit()
    r = box_row(con, box_id)
    if r['start_error'] and r['state'] == 'stopping':
        failure = json.loads(r['start_error'])
        raise Fail(503, failure.get('class', 'incus_failed'), 'failed start cleanup is still pending', failure)
    if r['state'] == 'stopping':
        raise Fail(409, 'incus_busy', 'box stop is still pending')
    if body.get("ttlSeconds"):
        set_box(con, box_id, ttl=int(body["ttlSeconds"]))
    if body.get("type") and body["type"] != r["type"]:
        t = size_of(body["type"])
        set_box(con, box_id, type=t)
    if r["state"] in LIVE + ('provisioning', 'resuming'):
        set_box(con, box_id, last_active=now())
        return
    if not con.execute("UPDATE boxes SET state='resuming', error=NULL, last_active=?, updated_at=? WHERE id=? AND state=?",
                       (now(), now(), box_id, r['state'])).rowcount:
        return

    context = offbox_protection.caller()
    def go():
        offbox_protection.CALLER.set(context)
        c2 = db()
        failure = {}
        identity_pending = False
        try:
            with lifecycle_lock(box_id), boatd_tmp.lock(box_id):
                try:
                    if box_row(c2, box_id)['state'] != 'resuming':
                        return
                    check_delete_fence(c2, box_id)
                    row = box_row(c2, box_id)
                    failure = json.loads(row['start_error'] or '{}')
                    identity_pending = bool(row['identity_pending'])
                    apply_size(box_id, box_row(c2, box_id)["type"])
                    _prepare_proxies(c2, box_id)
                    if box_row(c2, box_id)['state'] != 'resuming':
                        return
                    if not ct_running(box_id):
                        scratch().start(box_id)
                    if identity_pending or failure.get('provision'):
                        _wait_boot(box_id, ssh=False)
                        _fresh_identity(box_id)
                        set_box(c2, box_id, identity_pending=0)
                    _wait_boot(box_id)
                    scratch().verify(box_id)
                    if c2.execute("UPDATE boxes SET state='ready', last_active=?, updated_at=?, error=NULL, start_error=NULL "
                                  "WHERE id=? AND state='resuming'", (now(), now(), box_id)).rowcount:
                        log(f"box {box_id} resumed")
                except Exception as e:  # noqa: BLE001
                    if isinstance(e, Fail) and e.code == 'incus_slow':
                        failed_start(c2, box_id, e)
                        return
                    if failure or identity_pending:
                        failure_error = e if isinstance(e, Fail) else Fail(500, 'incus_failed', str(e))
                        failed_start(c2, box_id, failure_error, provision=identity_pending, record=False)
                        return
                    with box_memory_lock(box_id):
                        if box_row(c2, box_id)['state'] != 'resuming':
                            return
                        protected = offbox_protection.blocked(box_protection(c2, box_id, probe=False))
                        set_box(c2, box_id, state='error' if protected else 'archived', error=str(e)[:500])
                    log(f"resume {box_id} failed: {e}")
        finally:
            c2.close()
    threading.Thread(target=go, daemon=True).start()


def delete_box(con, box_id: str, why: str | None = None) -> None:
    token = offbox_protection.CALLER.set(offbox_protection.caller(
        reason=why or offbox_protection.caller().get('reason') or 'API delete'))
    try:
        with lifecycle_lock(box_id):
            with box_memory_lock(box_id):
                require_unprotected(con, box_id)
                con.execute('INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)', ('delete_pending:' + box_id, '1'))
                if box_row(con, box_id)['state'] in LIVE + ('provisioning', 'resuming'):
                    set_box(con, box_id, state='stopping')
            settle_box_commands(con, box_id)
            with box_memory_lock(box_id):
                require_unprotected(con, box_id)
                _delete_box(con, box_id)
                con.execute('DELETE FROM meta WHERE k=?', ('delete_pending:' + box_id,))
    finally:
        offbox_protection.CALLER.reset(token)


def _delete_box(con, box_id: str) -> None:
    r = box_row(con, box_id)
    with boatd_tmp.lock(box_id):
        if r['provision_identity']:
            check_instance_identity(box_id)
        delete_instance(box_id, r['owner'], require_identity=bool(r['provision_identity']))
    con.execute("DELETE FROM snaps WHERE box_id=?", (box_id,))
    con.execute('DELETE FROM snapshot_pending WHERE box_id=?', (box_id,))
    set_box(con, box_id, state="deleted", deleted_at=now())
    log(f"box {box_id} deleted")


# ---------------------------------------------------------------- saved snapshots

def settle_box_commands(con, box_id):
    # Result writers acquire result -> box. Never wait for their result lock while holding the box lock.
    for c in con.execute("SELECT pid FROM commands WHERE box_id=? AND status IN ('queued','running')", (box_id,)).fetchall():
        kill_cmd(con, box_id, c['pid'], lost=True)


@contextmanager
def lifecycle_lock(box_id):
    path = VAR / 'lifecycle-locks'
    path.mkdir(exist_ok=True)
    with open(path / box_id, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def check_delete_fence(con, box_id):
    if con.execute('SELECT 1 FROM meta WHERE k=?', ('delete_pending:' + box_id,)).fetchone():
        raise Fail(409, 'sandbox_deleting', f'{box_id} deletion is pending; pin, resume and reuse are refused')

def saved_json(r) -> dict:
    return {"name": r["name"], "status": r["status"], "sourceSandboxId": r["source"], "snapshotId": r["snapshot_id"],
            "type": r["type"], "sizeBytes": r["size_bytes"], "createdAt": iso(r["created_at"]), "error": r["error"]}


def queue_saved_delete(con, instance):
    # Persist the obsolete copy before removing its last saved-state reference.
    con.execute('INSERT OR IGNORE INTO incus_deletes VALUES (?,?)', (instance, now()))


def drain_saved_deletes(con):
    for row in con.execute('SELECT d.rowid AS request_id, d.instance FROM incus_deletes d WHERE NOT EXISTS '
                           '(SELECT 1 FROM saved s WHERE s.instance=d.instance OR s.pending_instance=d.instance) '
                           'ORDER BY d.rowid LIMIT 1').fetchall():
        instance = row['instance']
        if con.execute('SELECT 1 FROM saved WHERE instance=? OR pending_instance=?', (instance, instance)).fetchone():
            continue
        def claim():
            changed = con.execute('INSERT OR REPLACE INTO incus_deletes SELECT instance,created_at FROM incus_deletes '
                                  'WHERE rowid=? AND NOT EXISTS (SELECT 1 FROM saved WHERE instance=? OR pending_instance=?)',
                                  (row['request_id'], instance, instance)).rowcount > 0
            if changed:
                con.execute("INSERT OR REPLACE INTO meta VALUES ('incus_replay_next','snapshots')")
            return changed
        try:
            result = incus('delete', instance, '--force', timeout=300, check=False, before_dispatch=claim)
            if result.returncode == 0 or instance_missing(result):
                con.execute('DELETE FROM incus_deletes WHERE instance=?', (instance,))
        except Exception as error:  # noqa: BLE001
            log(f'saved copy deletion still pending {instance}: {error}')


def drain_replays(con):
    # A repeatedly failing snapshot and its cooldown must leave deletion a turn,
    # including after restart. Deferred requests do not advance this priority.
    row = con.execute("SELECT v FROM meta WHERE k='incus_replay_next'").fetchone()
    drains = (drain_saved_deletes, drain_pending_snapshots) if row and row[0] == 'deletes' else (drain_pending_snapshots, drain_saved_deletes)
    for drain in drains:
        drain(con)


def save_box(con, box_id: str, name: str, owner: str) -> dict:
    r = box_row(con, box_id, owner)
    inst = "sv-" + hashlib.sha1(f"{owner}:{name}:{now()}".encode()).hexdigest()[:12]
    key = (owner, name)
    old = con.execute("SELECT * FROM saved WHERE owner=? AND name=?", key).fetchone()
    snap_id = secrets.token_hex(8)
    # pending_instance names the copy in progress, so a restart in the middle can remove exactly that.
    if old:
        con.execute("UPDATE saved SET status='pending', snapshot_id=?, pending_instance=? WHERE owner=? AND name=?",
                    (snap_id, inst, *key))
    else:
        con.execute("INSERT INTO saved (owner, name, instance, source, type, status, created_at, snapshot_id, "
                    "pending_instance) VALUES (?,?,?,?,?,?,?,?,?)",
                    (owner, name, None, box_id, r["type"], "pending", now(), snap_id, inst))

    def go():
        c2 = db()
        try:
            incus("copy", ct(box_id), inst, "--instance-only", "--stateless", timeout=900)
            scratch().detach_copy(inst)
            size = _instance_bytes(inst)
            prev = c2.execute("SELECT instance FROM saved WHERE owner=? AND name=?", key).fetchone()
            if prev and prev['instance'] and prev['instance'] != inst:
                queue_saved_delete(c2, prev['instance'])
            c2.execute("UPDATE saved SET instance=?, source=?, type=?, status='ready', error=NULL, size_bytes=?, "
                       "created_at=?, pending_instance=NULL WHERE owner=? AND name=?",
                       (inst, box_id, r["type"], size, now(), *key))
            drain_saved_deletes(c2)
            log(f"saved {owner}/{name} <- {box_id} as {inst}")
        except Exception as e:  # noqa: BLE001
            queue_saved_delete(c2, inst)
            st = "ready" if old and old["instance"] else "failed"
            c2.execute("UPDATE saved SET status=?, error=?, pending_instance=NULL WHERE owner=? AND name=?",
                       (st, str(e)[:500], *key))
            drain_saved_deletes(c2)
            log(f"save {owner}/{name} failed: {e}")
        finally:
            c2.close()
    threading.Thread(target=go, daemon=True).start()
    return saved_json(con.execute("SELECT * FROM saved WHERE owner=? AND name=?", key).fetchone())


def _instance_bytes(inst: str) -> int | None:
    p = subprocess.run(["zfs", "list", "-Hpo", "used", f"{zpool()}/containers/{inst}"], capture_output=True, text=True)
    try:
        return int(p.stdout.strip())
    except ValueError:
        return None


_ZPOOL = None


def zpool() -> str:
    global _ZPOOL
    if _ZPOOL is None:
        p = incus("storage", "get", CFG["pool"], "source", timeout=30, check=False)
        _ZPOOL = p.stdout.decode().strip() or f"{CFG['zpool']}/incus"
    return _ZPOOL


# ---------------------------------------------------------------- commands

def cmd_dir(box_id: str) -> Path:
    d = CMDS / box_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w") as f:
        f.write(json.dumps(obj))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def cmd_row(con, box_id: str, pid: int):
    r = con.execute("SELECT * FROM commands WHERE box_id=? AND pid=?", (box_id, pid)).fetchone()
    if not r:
        raise Fail(404, "command_not_found", f"no command {pid} on {box_id}")
    return r


def unit_name(box_id: str, pid: int, attempt: int = 1) -> str:
    base = f"boatd-cmd-{ct(box_id)}-{pid}"
    return base if (attempt or 1) <= 1 else f"{base}-a{attempt}"


def unit_active(unit: str) -> bool:
    return _sh(["systemctl", "is-active", unit])[1] in ("active", "activating", "deactivating")


def spawn_runner(box_id: str, pid: int, attempt: int = 1) -> str | None:
    """Start `boatd.py run` for one command in its own transient unit. Returns the error text, or None."""
    env = []
    for k in ("BOATD_VAR", "BOATD_ETC"):
        if os.environ.get(k):
            env += ["-E", f"{k}={os.environ[k]}"]
    p = subprocess.run(["systemd-run", "--unit", unit_name(box_id, pid, attempt), "--collect", "--quiet",
                        "-p", "KillMode=mixed", "-E", "HOME=/root", *env, "-p", "TimeoutStopSec=30",
                        sys.executable, str(SELF), "run", box_id, str(pid)], capture_output=True, text=True)
    return None if p.returncode == 0 else (p.stderr[-300:] or f"systemd-run exit {p.returncode}")


def result_path(box_id: str, pid: int) -> Path:
    return cmd_dir(box_id) / f"{pid}.result.json"


def read_result(box_id: str, pid: int, attempt: int) -> dict | None:
    """What the runner left when the command ended (written before the database update), for this attempt."""
    try:
        d = json.loads(result_path(box_id, pid).read_text())
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("attempt") == (attempt or 1) else None


@contextmanager
def runner_dispatch(*, blocking=True):
    # A queued row is published before systemd-run, including during restart reconciliation.
    # Admission may inspect unit absence only while nobody can be between those two steps.
    with open(VAR / "dispatch.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        yield True


def dispatching(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with runner_dispatch():
            return fn(*args, **kwargs)
    return wrapped


@contextmanager
def box_memory_lock(box_id):
    held = getattr(BOX_LOCKS, 'held', frozenset())
    if box_id in held:
        yield
        return
    path = VAR / 'memory-locks'
    path.mkdir(exist_ok=True)
    with open(path / box_id, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        BOX_LOCKS.held = held | {box_id}
        try:
            yield
        finally:
            BOX_LOCKS.held = held


@dispatching
def start_cmd(con, box_id: str, body: dict, owner: str | None = None) -> dict:
    with box_memory_lock(box_id):
        pid, cid, retry = queue_cmd(con, box_id, body, owner)
    set_box(con, box_id, last_active=now())
    d = cmd_dir(box_id)
    for ext in ("out", "err"):
        (d / f"{pid}.{ext}").touch()
    err = spawn_runner(box_id, pid, 1)
    if err:
        rc, state = _sh(['systemctl', 'is-active', unit_name(box_id, pid, 1)], timeout=2)
        current = cmd_row(con, box_id, pid)
        metrics = {'not_dispatched': current['started_at'] is None and
                   rc in (3, 4) and state in ('inactive', 'failed', 'unknown')}
        con.execute("UPDATE commands SET status='exited', exit_code=127, ended_at=?, metrics=? WHERE box_id=? AND pid=?",
                    (now(), json.dumps(metrics), box_id, pid))
        raise Fail(500, "spawn_failed", err)
    return {"ok": True, "processId": pid, "commandId": cid, "pid": pid, "attempt": 1, "retryInterrupted": bool(retry)}


def queue_cmd(con, box_id, body, owner):
    check_delete_fence(con, box_id)
    r = box_row(con, box_id, owner)
    if r["state"] not in LIVE:
        raise Fail(409, "machine_not_running", f"{box_id} is {r['state']}")
    command = body.get("command") or ""
    if not command:
        raise Fail(400, "invalid_command", "command is empty")
    guard_snapshot = require_unprotected(con, box_id, reuse=True) if body.get('detached') else None
    disk_admit()
    previous = con.execute("SELECT * FROM commands WHERE box_id=? AND run_id IS NOT NULL "
                           "AND status IN ('exited','lost','interrupted') ORDER BY ended_at DESC LIMIT 1", (box_id,)).fetchone()
    if previous:
        free_idle_tmp(con, previous, dict(status='exited', ended_at=previous['ended_at']))
    meta = body.get("meta") or {}
    con.execute("BEGIN IMMEDIATE")
    held = held_runs(con, box_id) if body.get('detached') else []
    if held:
        con.execute('ROLLBACK')
        raise Fail(409, 'box_held', f"{box_id} is held while checking {', '.join(held)}; nothing ran")
    pid = (con.execute("SELECT MAX(pid) FROM commands WHERE box_id=?", (box_id,)).fetchone()[0] or 1000) + 1
    cid = "cmd_" + secrets.token_hex(8)
    # retry_interrupted: if the host dies under this run, queue it again once (same id, next attempt). Only the
    # caller knows whether running it twice is safe, so the default is no.
    retry = 1 if body.get("retry_interrupted") is True else 0
    sync = not bool(body.get("detached"))
    timeout_s = int(body.get("timeoutSeconds") or 60) if sync else None
    con.execute("INSERT INTO commands (box_id, pid, command_id, command, cwd, status, created_at, kind, repo, run_id, "
                "retry_interrupted, attempt, sync, timeout_s, holder) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
                (box_id, pid, cid, command, body.get("cwd") or "/home/user", "queued", now(),
                 meta.get("kind") or guess_kind(command), meta.get("repo"), meta.get("run_id"), retry,
                 int(sync), timeout_s, offbox_protection.caller().get('holder')))
    if body.get('detached'):
        box_event(con, box_id, 'hand_out', 'command admitted', guard_snapshot, run_id=meta.get('run_id'))
    con.execute("COMMIT")
    return pid, cid, retry


def guess_kind(command: str) -> str:
    m = re.search(r"\bOFFBOX_KIND=([\w.:/-]+)", command)
    if m:
        return m.group(1)[:80]
    return "cmd:" + (command.split() or ["?"])[0][:40]


def tail(path: Path, n: int, start: int = 0) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, min(size, start), size - n))
            return f.read().decode(errors="replace")
    except OSError:
        return ""


def cmd_status_json(con, box_id: str, pid: int, tail_bytes: int = 4096) -> dict:
    r = cmd_row(con, box_id, pid)
    d = cmd_dir(box_id)
    running = r["status"] in ("queued", "running")
    return {"ok": True, "processId": pid, "commandId": r["command_id"], "running": running,
            "status": "running" if running else r["status"], "exitCode": r["exit_code"], "signal": r["signal"],
            "queued": r["status"] == "queued", "startedAt": iso(r["started_at"]), "endedAt": iso(r["ended_at"]),
            "receivedAt": iso(r["created_at"]), "timeoutSeconds": r["timeout_s"], "killed": bool(r["killed"]),
            "queuedMs": 0 if r["sync"] else max(0, r["queued_s"] if r["queued_s"] is not None else
                (r["started_at"] or r["ended_at"] or now()) - r["created_at"]) * 1000,
            "runMs": max(0, (r["ended_at"] or now()) - r["started_at"]) * 1000 if r["started_at"] else 0,
            "attempt": r["attempt"] or 1, "retryInterrupted": bool(r["retry_interrupted"]),
            "interruptedAt": iso(r["interrupted_at"]), "bootId": boot_id(), "serverStartedAt": iso(STARTED),
            "stdout": tail(d / f"{pid}.out", tail_bytes), "stderr": tail(d / f"{pid}.err", tail_bytes),
            "metrics": json.loads(r["metrics"]) if r["metrics"] else None,
            "interruption": json.loads(r['metrics'] or '{}').get('interruption'),
            "cleanup": json.loads(r['metrics'] or '{}').get('kill'),
            "reason": json.loads(r['metrics'] or '{}').get('start_failure'),
            **queue_loss_json(r)}


def queue_loss_json(row):
    reason = json.loads(row['metrics'] or '{}').get('queue_lost_reason')
    return {'notAdmitted': row['status'] == 'lost' and row['started_at'] is None and bool(reason),
            'queueLostReason': reason}


def _cg_pids(box_id: str, pid: int) -> list[int]:
    try:
        return [int(x) for x in (cg_path(box_id) / "boatd" / str(pid) / "cgroup.procs").read_text().split()]
    except (OSError, ValueError):
        return []


def run_processes(box_id: str, pid: int) -> list[int] | None:
    """Host PIDs from the entire delegated run cgroup; missing is not proof of clean."""
    path = cg_path(box_id) / "boatd" / str(pid)
    try:
        files = [path / "cgroup.procs", *path.glob("**/cgroup.procs")]
        return sorted({int(p) for f in files for p in f.read_text().split()})
    except (OSError, ValueError):
        return None


def instance_missing(response) -> bool:
    for value in (response.stdout, response.stderr):
        text = value.decode(errors='replace').strip() if isinstance(value, bytes) else (value or '').strip()
        if re.fullmatch(r'(?:Error: )?Instance not found', text, re.I):
            return True
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict) and data.get('type') == 'error' and data.get('error_code') == 404:
            return True
    return False


def command_probe(c) -> dict:
    """Inspect receipts without creating another exec session in the customer's box."""
    try:
        p = incus("query", f"/1.0/instances/{ct(c['box_id'])}/state", check=False, timeout=5)
        if p.returncode:
            if instance_missing(p):
                return {"readable": True, "pids": [], "box_rc": None, "stopped": True}
            return {"reason": "incus_unavailable"}
        state = json.loads(p.stdout)
        if not isinstance(state, dict):
            return {'reason': 'box_unreadable'}
        if state.get("status") == "Stopped":
            return {"readable": True, "pids": [], "box_rc": None, "stopped": True}
        init = int(state.get("pid") or 0)
        if init <= 0 or state.get("status") != "Running":
            return {"reason": "box_unreadable"}
        root = PROC_ROOT / str(init) / 'root'
        base = root / "run/boatd" / f"{c['pid']}.{c['attempt'] or 1}"
        marker = None
        try:
            marker = json.loads(Path(str(base) + ".started").read_text())
            if not isinstance(marker, dict):
                marker = {'invalid': True}
        except FileNotFoundError:
            pass
        rc = None
        receipts = [Path(str(base) + ".rc")]
        # Client receipts predate attempt-specific boatd receipts. Never reuse attempt 1's rc on retry.
        if c['run_id'] and (c['attempt'] or 1) == 1:
            receipts.append(root / "home/user/.offbox/exit" / (c['run_id'] + '.rc'))
        for f in receipts:
            try:
                value = int(f.read_text().strip())
                if not 0 <= value <= 255:
                    return {"reason": "invalid_receipt"}
                rc = value
                break
            except FileNotFoundError:
                pass
        pids = run_processes(c['box_id'], c['pid'])
        joined = bool(marker and marker.get('cgroup_joined') is True and
                      type(marker.get('pid')) is int and marker['pid'] > 0 and marker.get('attempt') == (c['attempt'] or 1))
        # Legacy groups still identify members we can follow or stop. Without join evidence, an empty
        # group cannot prove there are no children outside it.
        if not joined and not pids:
            pids = None
        return {"readable": True, "pids": pids, "box_rc": rc, "marker": marker,
                'join_verified': joined, "reason": "cgroup_unverified" if not joined or pids is None else None}
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return {"reason": "box_unreadable"}


def recover_probe(c, *, clock=None, pause=None) -> dict:
    clock, pause = clock or time.monotonic, pause or time.sleep
    end = clock() + EXEC_RECOVERY_SECONDS
    while True:
        view = command_probe(c)
        if view.get('readable') or clock() >= end:
            return view
        pause(min(1, max(0, end - clock())))


def cleanup_run(c, view=None, *, clock=None, pause=None) -> dict:
    view = command_probe(c) if view is None else view
    metrics = json.loads(c['metrics'] or '{}')
    previous = [metrics.get('kill') or {}]
    if (metrics.get('interruption') or {}).get('attempt') == (c['attempt'] or 1):
        previous.append(metrics['interruption'])
    prior = max((p['leftover_killed'] for p in previous if type(p.get('leftover_killed')) is int), default=0)
    def counted(result):
        if view.get('box_rc') is not None:
            result['box_rc'] = view['box_rc']
            previous_receipt = metrics.get('interruption') or {}
            result['box_rc_at'] = previous_receipt.get('box_rc_at') if previous_receipt.get('box_rc') == view['box_rc'] else None
            result['box_rc_at'] = result['box_rc_at'] or now()
        if prior:
            result['leftover_killed'] = prior + (result.get('leftover_killed') or 0)
            if result['cleanup'] == 'clean':
                result['cleanup'] = 'stopped'
        return result
    pids = view.get('pids')
    if not view.get('readable') or pids is None:
        return counted({"cleanup": "unknown", "leftover_killed": None, "remaining": None,
                        "reason": view.get('reason') or 'cgroup_unverified'})
    if not pids:
        return counted({"cleanup": "clean", "leftover_killed": 0, "remaining": 0})
    path = cg_path(c['box_id']) / 'boatd' / str(c['pid'])
    try:
        (path / 'cgroup.kill').write_text('1')
    except OSError:
        return counted({"cleanup": "unknown", "leftover_killed": None, "remaining": len(pids),
                        "reason": "cgroup_kill_failed"})
    clock, pause = clock or time.monotonic, pause or time.sleep
    end = clock() + 2
    while True:
        remaining = run_processes(c['box_id'], c['pid'])
        if remaining == []:
            if view.get('join_verified') is False:
                return counted({'cleanup': 'unknown', 'leftover_killed': len(pids), 'remaining': None,
                                'reason': 'cgroup_unverified'})
            return counted({"cleanup": "stopped", "leftover_killed": len(pids), "remaining": 0})
        if remaining is None or clock() >= end:
            return counted({"cleanup": "unknown", "leftover_killed": None,
                            "remaining": len(remaining) if remaining is not None else None,
                            "reason": "cleanup_unconfirmed"})
        pause(min(.1, max(0, end - clock())))


def interruption(c, cause, **props) -> dict:
    return dict(cause=cause, box_id=c['box_id'], phase='running' if c['started_at'] is not None else 'before_spawn', attempt=c['attempt'] or 1,
                retry=False, leftover_killed=None, box_rc=None, cleanup='unknown', **props)


_RESULT_LOCKS = threading.local()


@contextmanager
def result_lock(box_id, pid):
    key = (box_id, pid)
    held = getattr(_RESULT_LOCKS, 'held', None)
    if held is None:
        held = _RESULT_LOCKS.held = set()
    if key in held:
        yield
        return
    with open(cmd_dir(box_id) / f'{pid}.settle.lock', 'a') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        held.add(key)
        try:
            yield
        finally:
            held.remove(key)


def locked_command(fn):
    @wraps(fn)
    def locked(con, c, *args, **kwargs):
        with result_lock(c['box_id'], c['pid']):
            latest = cmd_row(con, c['box_id'], c['pid'])
            attempt = latest['attempt'] or 1
            evidence = [c, *args[:1], kwargs.get('result')]
            if any(isinstance(x, (dict, sqlite3.Row)) and (x['attempt'] or 1) != attempt
                   for x in evidence if x is not None and 'attempt' in x.keys()):
                return 'following'
            fresh = dict(latest)
            fresh['retry_interrupted'] = c['retry_interrupted']
            return fn(con, fresh, *args, **kwargs)
    return locked


def emit_interruption(c, info, retry=False):
    toollog.emit('boatd', 'run.interrupted', kind='error', ok=False,
                 ids={'box': c['box_id'], 'run': c['run_id']},
                 props={'cause': info.get('cause', 'boatd_restart'), 'phase': info.get('phase', 'running'),
                        'attempt': c['attempt'] or 1, 'retry': retry,
                        'leftoverKilled': info.get('leftover_killed'), 'boxRc': info.get('box_rc'),
                        'cleanup': info.get('cleanup'), 'reason': info.get('reason')})


@locked_command
def save_interruption(con, c, info, *, result=None, view=None, repair_legacy=False) -> str:
    """One interruption finalizer for runner failures, reconcile and dropped retries."""
    result = dict(result or {})
    view = command_probe(c) if view is None else view
    if view.get('box_rc') is None and info.get('box_rc') is not None:
        view = {**view, 'box_rc': info['box_rc']}
    if (view.get('pids') and view.get('box_rc') is None) or \
            (view.get('box_rc') is not None and not signal_exit(view['box_rc'])):
        result['interruption'] = info
        return settle_transport(con, c, result, view=view, repair_legacy=repair_legacy)
    cleanup = cleanup_run(c, view)
    if info.get('box_rc_at') is not None and info.get('box_rc') == cleanup.get('box_rc'):
        cleanup['box_rc_at'] = info['box_rc_at']
    info = {**info, **cleanup}
    retry = (cleanup['cleanup'] != 'unknown' and bool(c['retry_interrupted'])
             and (c['attempt'] or 1) < MAX_ATTEMPTS)
    info['retry'] = retry
    t = now()
    started = result.get('started_at') if result.get('started_at') is not None else c['started_at']
    result.update(attempt=c['attempt'] or 1, status='interrupted', interruption=info,
                  started_at=started, ended_at=info.get('box_rc_at') or t, boot_id=c['boot_id'])
    m = json.loads(c['metrics'] or '{}')
    m['interruption'] = info
    if result.get('host_boxes'):
        m['host_boxes'] = result['host_boxes']
    changes = dict(interrupted_at=t, started_at=started)
    if cleanup['cleanup'] == 'unknown':
        action = 'following'
        changes.update(status='running', exit_code=None, ended_at=None)
    elif retry:
        action = 'retry'
        changes.update(status='queued', attempt=(c['attempt'] or 1)+1, started_at=None, queued_s=None,
                       boot_id=None, exit_code=None, ended_at=None)
    else:
        action = 'interrupted'
    action = record_command_result(con, c, result, m, action, changes=changes,
                                   before_spawn=info['phase'] == 'before_spawn', repair_legacy=repair_legacy)
    if action == 'finalized':
        return action
    emit_interruption(c, info, action == 'retry')
    if action == 'retry':
        # Clients use this exact line as an attempt boundary even when the next wrapper emits no bytes.
        _note(c['box_id'], c['pid'], f"the server restarted while this run was going (attempt {c['attempt'] or 1} is lost); "
                                  f"it is queued again as attempt {(c['attempt'] or 1)+1}")
    elif action == 'interrupted':
        _note(c['box_id'], c['pid'], f"{info['cause']}: the command ran partly; it is not run again; check what it did before running it again")
    return action


def stream_failure(text: str) -> bool:
    text = text.lower()
    return any(s in text for s in ('lost connection to the event listener', 'websocket: close',
                                   'incus is shutting down', 'error: failed to connect to')) or \
           any(line.strip() == 'error: unexpected eof' for line in text.splitlines())


def signal_exit(rc) -> bool:
    return rc is not None and 128 < rc <= 128 + getattr(signal, 'SIGRTMAX', 64)


@locked_command
def settle_transport(con, c, res, *, view=None, repair_legacy=False) -> str:
    info = dict(res['interruption'])
    view = command_probe(c) if view is None else view
    rc = view.get('box_rc') if view.get('box_rc') is not None else info.get('box_rc')
    view = {**view, 'box_rc': rc}
    pids = view.get('pids')
    info['box_rc'] = rc
    if rc is not None:
        info.setdefault('box_rc_at', now())
    if signal_exit(rc):
        return save_interruption(con, c, info, result=res, view=view, repair_legacy=repair_legacy)
    if view.get('readable') and pids == []:
        if rc is None:
            return save_interruption(con, c, info, result=res, view=view, repair_legacy=repair_legacy)
        info.update(stream_state='ended', cleanup='clean', leftover_killed=0, reason=None,
                    message=f"exec stream dropped; in-box exit code {rc}")
        res.update(status='exited', exit_code=rc, ended_at=info.get('box_rc_at') or now(), interruption=info)
        m = json.loads(c['metrics'] or '{}')
        m['interruption'] = info
        if res.get('host_boxes'):
            m['host_boxes'] = res['host_boxes']
        action = record_command_result(con, c, res, m, 'finalized', repair_legacy=repair_legacy)
        if action == 'finalized' and (read_result(c['box_id'], c['pid'], c['attempt'] or 1) or {}).get('interruption') == info:
            _note(c['box_id'], c['pid'], info['message'])
        if action == 'finalized' and not view.get('stopped'):
            snapshot(con, c['box_id'], 'auto')
            prune_snaps(con, c['box_id'])
        return action
    state = 'reattached' if view.get('readable') and pids else 'unknown'
    first = info.get('stream_state') != state
    info.update(stream_state=state, reason=view.get('reason'))
    if state == 'reattached':
        info['message'] = f"exec stream to {c['box_id']} dropped; command still running in the box, re-attached"
    m = json.loads(c['metrics'] or '{}')
    m['interruption'] = info
    if res.get('host_boxes'):
        m['host_boxes'] = res['host_boxes']
    res.update(status='running', exit_code=None, interruption=info)
    res['ended_at'] = None
    action = record_command_result(con, c, res, m, 'following', repair_legacy=repair_legacy)
    if action == 'following' and first:
        if state == 'reattached':
            _note(c['box_id'], c['pid'], info['message'])
            toollog.emit('boatd', 'run.reattached', ids={'box': c['box_id'], 'run': c['run_id']},
                         props={'attempt': c['attempt'] or 1, 'cgroupProcessCount': len(pids)})
        else:
            _note(c['box_id'], c['pid'], f"exec state unknown ({view.get('reason')}); box held until it can be checked")
    return action


def terminal_result(res) -> bool:
    return res.get('status') in ('exited', 'lost') or (res.get('status') == 'interrupted' and
           (res.get('interruption') or {}).get('cleanup') in ('clean', 'stopped'))



def _write_command_result(con, c, result, metrics, changes=None):
    # A terminal row is the pool's hand-back signal. Cleanup finishes before it becomes visible.
    with box_memory_lock(c['box_id']):
        if terminal_result(result):
            free_idle_tmp(con, c, result)
        return _commit_command_result(con, c, result, metrics, changes)


def _commit_command_result(con, c, result, metrics, changes=None):
    updates = {k: result.get(k, c[k]) for k in ('status', 'started_at', 'ended_at', 'boot_id')}
    metrics = dict(metrics)
    metrics.pop('queue_lost_reason', None)
    if updates['status'] == 'lost' and updates['started_at'] is None and result.get('queue_lost_reason'):
        metrics['queue_lost_reason'] = result['queue_lost_reason']
    updates.update(exit_code=result.get('exit_code'), signal=result.get('signal'), metrics=json.dumps(metrics))
    updates.update(changes or {})
    columns = ', '.join(f'{k}=?' for k in updates)
    # Admission takes this same database write lock before reading held_runs. It cannot slip into the
    # receipt/row gap. If the commit is cut off, the durable pending receipt also fences admission.
    con.execute('BEGIN IMMEDIATE')
    try:
        write_json(result_path(c['box_id'], c['pid']), result)
        con.execute(f'UPDATE commands SET {columns} WHERE box_id=? AND pid=?',
                    (*updates.values(), c['box_id'], c['pid']))
        con.execute('COMMIT')
    except BaseException:
        con.execute('ROLLBACK')
        raise


def completion_evidence(candidate, c, cleanup):
    if not isinstance(candidate, dict):
        return None
    if terminal_result(candidate) and not candidate.get('synthetic_kill'):
        return dict(candidate)
    info = candidate.get('interruption') or {}
    rc = info.get('box_rc')
    if type(rc) is not int or not 0 <= rc <= 255:
        return None
    result = dict(candidate, attempt=c['attempt'] or 1, status='interrupted' if signal_exit(rc) else 'exited',
                  exit_code=None if signal_exit(rc) else rc, signal=None,
                  started_at=candidate.get('started_at', c['started_at']), ended_at=info.get('box_rc_at') or now())
    result.pop('synthetic_kill', None)
    if signal_exit(rc):
        result['interruption'] = {**info, **cleanup, 'retry': False, 'box_rc_at': result['ended_at']}
    return result


def _kill_result_locked(con, c, observed, cleanup, *, lost=False, metrics=None):
    current = read_result(c['box_id'], c['pid'], c['attempt'] or 1) or {}
    m = json.loads(c['metrics'] or '{}')
    m.update(metrics or {})
    request = m.get('kill_request') or {}
    lost = lost or request.get('lost', False)
    row_result = {k: c[k] for k in ('status', 'attempt', 'exit_code', 'signal', 'started_at', 'ended_at', 'boot_id')}
    row_result['interruption'] = m.get('interruption')
    row_result['synthetic_kill'] = m.get('kill_synthetic', False)
    receipt = {}
    if cleanup.get('box_rc') is not None and (m.get('interruption') or not signal_exit(cleanup['box_rc'])):
        receipt = dict(started_at=c['started_at'], interruption={**(m.get('interruption') or {}),
                       'box_rc': cleanup['box_rc'], 'box_rc_at': cleanup.get('box_rc_at') or now()})
    choices = (current.get('held_result'), request.get('held_result'), current, row_result,
               receipt, observed.get('held_result'), observed)
    saved, recognized_interruption = None, False
    for candidate in choices:
        saved = completion_evidence(candidate, c, cleanup)
        if saved is not None:
            recognized_interruption = saved['status'] == 'interrupted' and not terminal_result(candidate)
            break
    if saved is None:
        saved = next((dict(x) for x in choices if isinstance(x, dict) and terminal_result(x)), None)
    if recognized_interruption:
        emit_interruption(c, saved['interruption'])
    m['kill'] = cleanup
    changes = {'killed': 1} if 'killed' in c.keys() else {}
    if cleanup['cleanup'] == 'unknown':
        result = dict(current if not terminal_result(current) else {})
        result.update(attempt=c['attempt'] or 1, status='running', exit_code=None, signal=None,
                      ended_at=None, kill_pending=True)
        if saved:
            result['held_result'] = saved
            result['started_at'] = saved.get('started_at', c['started_at'])
        _write_command_result(con, c, result, m, changes)
        return 'following'
    result = saved or dict(attempt=c['attempt'] or 1, status='lost' if lost else 'exited', exit_code=143,
                           signal='SIGTERM', started_at=c['started_at'], ended_at=now(), boot_id=c['boot_id'], synthetic_kill=True)
    if result.get('interruption'):
        result['interruption'] = {**result['interruption'], 'retry': False}
        m['interruption'] = result['interruption']
    m.pop('kill_request', None)
    m['kill_synthetic'] = bool(result.get('synthetic_kill'))
    _write_command_result(con, c, result, m, changes)
    return 'killed'


def restore_kill_result(con, c, res, cleanup=None, *, lost=False):
    with result_lock(c['box_id'], c['pid']):
        latest = cmd_row(con, c['box_id'], c['pid'])
        if (latest['attempt'] or 1) != (res.get('attempt') or c['attempt'] or 1):
            return 'following', cleanup
        if cleanup is None:
            request = json.loads(latest['metrics'] or '{}').get('kill_request') or {}
            queue_loss = res.get('status') == 'lost' and res.get('started_at') is None and bool(res.get('queue_lost_reason'))
            before_spawn = queue_loss or (request.get('before_spawn') if request else
                                         latest['status'] == 'queued' and latest['started_at'] is None and not res)
            cleanup = dict(cleanup='clean', leftover_killed=0, remaining=0) if before_spawn else cleanup_run(latest)
        return _kill_result_locked(con, latest, res, cleanup, lost=lost), cleanup


def record_command_result(con, c, result, metrics, action, *, changes=None,
                          terminal_evidence=True, before_spawn=False, repair_legacy=False):
    if before_spawn and terminal_result(result) and action not in ('retry', 'requeue', 'following'):
        metrics = {**metrics, 'not_dispatched': True}
    with result_lock(c['box_id'], c['pid']):
        latest = dict(cmd_row(con, c['box_id'], c['pid']))
        if (latest['attempt'] or 1) != (result.get('attempt') or c['attempt'] or 1):
            return 'following'
        prior = read_result(c['box_id'], c['pid'], latest['attempt'] or 1) or {}
        kf = cmd_dir(c['box_id']) / f"{c['pid']}.kill"
        current_metrics = json.loads(latest['metrics'] or '{}')
        request = current_metrics.get('kill_request') or {}
        if kf.exists() or request or prior.get('kill_pending') or latest.get('killed') or (current_metrics.get('kill') or {}).get('cleanup') == 'unknown':
            cleanup = dict(cleanup='clean', leftover_killed=0, remaining=0) if before_spawn or request.get('before_spawn') else cleanup_run(latest)
            lost = kf.exists() and kf.read_text().strip() == 'lost'
            return _kill_result_locked(con, latest, result if terminal_evidence else {}, cleanup,
                                       lost=lost, metrics=metrics)
        if terminal_result(prior) and not repair_legacy:
            # A retry receipt is durable before its queued/attempt+1 DB transition. Replay that transition
            # once on recovery; the current-attempt guard prevents replay after the next attempt exists.
            if prior.get('status') == 'interrupted' and (prior.get('interruption') or {}).get('retry') is True and action in ('retry', 'following'):
                _write_command_result(con, latest, result, metrics, changes)
                return action
            if not terminal_result(result):
                metrics = json.loads(latest['metrics'] or '{}')
                metrics['host_boxes'] = prior.get('host_boxes')
                if prior.get('interruption'):
                    metrics['interruption'] = prior['interruption']
            _write_command_result(con, latest, prior, metrics)
            return 'finalized'
        _write_command_result(con, latest, result, metrics, changes)
        return action


def stage_kill(con, box_id, pid, lost):
    # Persist intent before any guest probe or signal. Admission and recovery use the same durable request
    # even if the daemon stops before creating the compatibility .kill file or saving a cleanup receipt.
    with result_lock(box_id, pid):
        con.execute('BEGIN IMMEDIATE')
        try:
            r = cmd_row(con, box_id, pid)
            res = read_result(box_id, pid, r['attempt'] or 1) or {}
            m = json.loads(r['metrics'] or '{}')
            attempt = r['attempt'] or 1
            history = (cmd_dir(box_id) / f'{pid}.{attempt}.invocations.json').exists()
            try:
                output = False
                if attempt == 1:
                    marker = (offbox_disk_space.MARKER + json.dumps(dict(phase='attempt', attempt=attempt))).encode()
                    queue_lines = (marker, b'offbox-server: waiting for earlier runs in the queue')
                    with open(cmd_dir(box_id) / f'{pid}.err', 'rb') as f:
                        # Queue refreshes can exceed the old 8 KiB total limit without a command starting.
                        output = (cmd_dir(box_id) / f'{pid}.out').stat().st_size > 0 or any(
                            len(line) > 8192 or (line.strip() and line.rstrip(b'\r\n') not in queue_lines and
                            not line.startswith((b'offbox-server: waiting for memory (',
                                                 b'offbox-server: waiting; position ')))
                            for line in iter(lambda: f.readline(8193), b''))
            except OSError:
                output = True
            request = m.get('kill_request') or dict(lost=lost, before_spawn=r['status'] == 'queued' and
                       r['started_at'] is None and not history and not output and not res)
            request['lost'] = request.get('lost', False) or lost
            row_result = {k: r[k] for k in ('status', 'attempt', 'exit_code', 'signal', 'started_at', 'ended_at', 'boot_id')}
            row_result['interruption'] = m.get('interruption')
            row_result['synthetic_kill'] = m.get('kill_synthetic', False)
            candidates = (res.get('held_result'), res, row_result)
            saved = next((result for x in candidates if (result := completion_evidence(
                         x, r, dict(cleanup='unknown', leftover_killed=None, remaining=None))) is not None), None)
            if saved is None:
                saved = next((x for x in candidates if isinstance(x, dict) and terminal_result(x)), None)
            if saved:
                request['held_result'] = saved
            m['kill_request'] = request
            con.execute('UPDATE commands SET killed=1,metrics=? WHERE box_id=? AND pid=?', (json.dumps(m), box_id, pid))
            con.execute('COMMIT')
        except BaseException:
            con.execute('ROLLBACK')
            raise
    return r, res


def kill_cmd(con, box_id: str, pid: int, lost: bool = False) -> dict:
    r, res = stage_kill(con, box_id, pid, lost)
    (cmd_dir(box_id) / f"{pid}.kill").write_text("lost" if lost else "kill")
    if r['status'] not in ('queued', 'running') or res.get('held_result'):
        _, cleanup = restore_kill_result(con, r, res, lost=lost)
        return cleanup
    for hp in run_processes(box_id, pid) or []:
        try:
            os.kill(hp, signal.SIGTERM)
        except OSError:
            pass

    def later():
        time.sleep(10)
        c2 = db()
        try:
            cur = cmd_row(c2, box_id, pid)
            if cur['status'] not in ('queued', 'running') and json.loads(cur['metrics'] or '{}').get('kill', {}).get('cleanup') in ('clean', 'stopped'):
                return
            current_result = read_result(box_id, pid, cur['attempt'] or 1) or {}
            _, cleanup = restore_kill_result(c2, cur, current_result, lost=lost)
            if cleanup is None:
                return
            if cleanup['cleanup'] == 'unknown':
                _note(box_id, pid, 'kill could not confirm cleanup; box remains held')
                return
            subprocess.run(["systemctl", "stop", unit_name(box_id, pid, r["attempt"])], capture_output=True)
        finally:
            c2.close()
    threading.Thread(target=later, daemon=True).start()
    pids = run_processes(box_id, pid)
    return {'cleanup': 'pending', 'leftover_killed': None, 'remaining': len(pids) if pids is not None else None}


# ---------------------------------------------------------------- runner (boatd.py run <box> <pid>)

def mem_available() -> int:
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def async_filter(con) -> str:
    # Old runners can see the pre-batch schema; all persisted commands there were detached.
    return "sync=0 AND " if "sync" in _cols(con, "commands") else ""


def predicted_peak(con, kind: str) -> int:
    rows = [json.loads(r[0]).get("box_mem_peak") or 0 for r in con.execute(
        f"SELECT metrics FROM commands WHERE {async_filter(con)}kind=? AND metrics IS NOT NULL ORDER BY ended_at DESC LIMIT 50", (kind,))]
    rows = sorted(x for x in rows if x)
    if len(rows) < 3:
        return int(CFG["default_peak_gb"] * 2**30)
    p95 = rows[min(len(rows) - 1, int(0.95 * len(rows)))]
    return int(p95 * 1.25)


def admitted_bytes(con) -> int:
    """Future anon growth for every running box; existing shmem remains charged to the host."""
    needs = {}
    for r in con.execute(f"SELECT box_id,kind FROM commands WHERE {async_filter(con)}status='running'"):
        needs[r['box_id']] = max(needs.get(r['box_id'], 0), predicted_peak(con, r['kind']))
    total = 0
    for box, need in needs.items():
        anon = boatd_memory.anon_bytes(cg_path(box))
        total += max(0, need - (int(anon) if anon is not None else 0))
    return total


ADMIT_LOCK = VAR / "admit.lock"


def last_admission(con) -> float | None:
    try:
        return con.execute("SELECT MAX(started_at) FROM commands WHERE sync=0").fetchone()[0]
    except sqlite3.OperationalError as error:
        if str(error) != 'no such column: sync':
            raise
        return con.execute("SELECT MAX(started_at) FROM commands").fetchone()[0]


def admission_cpu_limit() -> float | None:
    # A rollback must release existing waiters too, without restarting their runners.
    try:
        value = json.loads((ETC / "config.json").read_text()).get("cpu_pressure_limit", DEFAULTS["cpu_pressure_limit"])
    except FileNotFoundError:
        value = CFG["cpu_pressure_limit"]
    except (OSError, ValueError, AttributeError):
        return None
    try:
        limit = float(value)
    except (TypeError, ValueError):
        return None
    return limit if not isinstance(value, bool) and math.isfinite(limit) and 0 <= limit <= 100 else None


def admit(con, box_id: str, pid: int, kind: str, errf) -> float:
    with toollog.span("boatd", "run.queue", ids={"box": box_id}, props={"backend": "home"}, tag="queue_failed") as data:
        queued = _admit(con, box_id, pid, kind, errf)
        data["props"].update(queued=queued > 1, waitMs=queued*1000)
        return queued


def queue_head(con, box_id, pid):
    while True:
        head = con.execute(f"SELECT * FROM commands WHERE {async_filter(con)}status='queued' "
                           "ORDER BY created_at, box_id, pid LIMIT 1").fetchone()
        if head is None or (head['box_id'], head['pid']) == (box_id, pid):
            return head
        with runner_dispatch(blocking=False) as inspecting:
            if not inspecting:
                return head
            with result_lock(head['box_id'], head['pid']):
                current = dict(cmd_row(con, head['box_id'], head['pid']))
                if current['status'] != 'queued' or current.get('attempt') != head['attempt']:
                    continue
                if current.get('killed'):
                    reason = 'killed'
                elif (CMDS / head['box_id'] / f"{head['pid']}.kill").exists():
                    reason = 'kill_file'
                else:
                    rc, state = _sh(['systemctl', 'is-active', unit_name(
                        head['box_id'], head['pid'], head['attempt'] or 1)], timeout=2)
                    # A timeout, unavailable bus or unexpected response is unknown, not dead.
                    reason = 'unit_' + state if rc in (3, 4) and state in ('inactive', 'failed', 'unknown') else None
                if not reason:
                    return head
                if read_result(head['box_id'], head['pid'], head['attempt'] or 1):
                    # Receipts survive a crash before the matching DB commit. Recover that outcome first.
                    action = settle_cmd(con, current)
                    recovered = cmd_row(con, head['box_id'], head['pid'])
                    if action in ('requeue', 'retry'):
                        error = spawn_runner(head['box_id'], head['pid'], recovered['attempt'] or 1)
                        if error:
                            drop_cmd(con, head['box_id'], head['pid'], f'could not recover queued receipt: {error}')
                        recovered = cmd_row(con, head['box_id'], head['pid'])
                    if recovered['status'] == 'queued':
                        return recovered
                    continue
                metrics = json.loads(current['metrics'] or '{}')
                result = dict(attempt=current['attempt'] or 1, status='lost', exit_code=None,
                              started_at=current['started_at'], ended_at=now(), boot_id=current['boot_id'],
                              queue_lost_reason=reason)
                _write_command_result(con, current, result, metrics)
                _note(head['box_id'], head['pid'], f"queued runner lost ({reason}); command was not admitted")
                toollog.emit('boatd', 'run.queue.dead_head', ids={'box': head['box_id'], 'run': current['run_id']},
                             props={'pid': head['pid'], 'created_at': head['created_at'], 'reason': reason})


def _admit(con, box_id: str, pid: int, kind: str, errf) -> float:
    """Wait for this run's FIFO turn and host capacity. Returns seconds queued."""
    need = predicted_peak(con, kind)
    reserve = int(CFG["mem_reserve_gb"] * 2**30)
    t0 = now()
    last_reason, last_said = None, None
    last_decision = None
    while True:
        current = dict(cmd_row(con, box_id, pid))
        if current.get('killed') or current['status'] != 'queued' or (CMDS / box_id / f"{pid}.kill").exists() or json.loads(current['metrics'] or '{}').get('kill_request'):
            return now() - t0
        with open(ADMIT_LOCK, "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            head = queue_head(con, box_id, pid)
            # Recheck after the lock: cancellation/another waiter may have settled this row.
            current = dict(cmd_row(con, box_id, pid))
            if current.get('killed') or current['status'] != 'queued' or (CMDS / box_id / f"{pid}.kill").exists() or json.loads(current['metrics'] or '{}').get('kill_request'):
                return now() - t0
            try:
                info = boatd_memory.meminfo()
                promised = admitted_bytes(con)
                memory = boatd_memory.capacity(info, mem_available(), reserve, promised,
                                               boatd_memory.payload_capacity(CG_ROOT, promised))
            except (OSError, ValueError):
                memory = dict(mem_available=None, shmem=None, committed_bytes=None, committed_as=None,
                              admitted_bytes=None, reserve=reserve, free_bytes=0)
            free = memory['free_bytes']
            mine = head is None or (head['box_id'], head['pid']) == (box_id, pid)
            head_need = need if mine else predicted_peak(con, head['kind'])
            cap = int(CFG.get("max_running") or 0)
            running = con.execute(f"SELECT COUNT(*) FROM commands WHERE {async_filter(con)}status='running'").fetchone()[0]
            room = not cap or running < cap
            cpu_limit = admission_cpu_limit()
            cpu = psi("cpu") if cpu_limit is not None and cpu_limit > 0 else None
            cpu_known = cpu is not None and math.isfinite(cpu) and 0 <= cpu <= 100
            last_start = last_admission(con)
            # PSI is a moving average: let a new run show up before admitting its neighbour.
            cpu_room = cpu_limit == 0 or (cpu_limit is not None and cpu_known and cpu < cpu_limit and
                                        (last_start is None or now() - last_start >= 10))
            alone = running == 0
            decision = mine and room and free >= need and (cpu_room or alone)
            decision_state = (decision, mine, room, free >= need, cpu_room)
            if decision or decision_state != last_decision:
                toollog.emit('boatd', 'admit.decision', ids={'box': box_id, 'run': current['run_id']},
                             props={**memory, 'need_bytes': need, 'decision': 'admit' if decision else 'queue',
                                    'fifo': mine, 'room': room, 'cpu_room': cpu_room})
                last_decision = decision_state
            if decision:
                guard = " AND killed=0" if 'killed' in current else ""
                updated = con.execute("UPDATE commands SET status='running', started_at=?, queued_s=?, boot_id=? "
                            "WHERE box_id=? AND pid=? AND status='queued'" + guard,
                            (now(), now() - t0, boot_id(), box_id, pid))
                if updated.rowcount and alone and (free < need or not cpu_room):
                    errf.write(f"offbox-server: admitted alone: needs {need / 2**30:.2f} GiB, {max(0, free) / 2**30:.2f} GiB free\n".encode())
                    errf.flush()
                    toollog.emit('boatd', 'run.queue', ids={'box': box_id, 'run': current['run_id']},
                                 props={'backend': 'home', 'reason': 'admitted_alone', 'position': 1,
                                        'headNeedBytes': need, 'freeBytes': free, 'running': 0,
                                        'waitMs': (now() - t0) * 1000})
                return now() - t0
            queue = con.execute(f"SELECT box_id,pid FROM commands WHERE {async_filter(con)}status='queued' "
                                "ORDER BY created_at,box_id,pid").fetchall()
            position = next(i for i, row in enumerate(queue, 1) if (row['box_id'], row['pid']) == (box_id, pid))
            head_id = f"{head['box_id']}/{head['pid']}" if head else f"{box_id}/{pid}"
            if not room:
                reason, why = 'cap', f"max_running cap {running}/{cap}"
            elif free < head_need:
                reason = 'memory'
                why = f"head {head_id} needs {head_need / 2**30:.2f} GiB, {max(0, free) / 2**30:.2f} GiB free above reserve and running headroom"
            elif cpu_limit is None:
                reason, why = 'cpu_config', "a valid CPU admission setting"
            elif not cpu_known and cpu_limit > 0:
                reason, why = 'cpu_unknown', "a host CPU pressure reading"
            elif cpu_limit > 0 and cpu >= cpu_limit:
                reason, why = 'cpu', f"host CPU pressure ({cpu:.1f}%, limit {cpu_limit:g}%)"
            elif not cpu_room:
                reason, why = 'cpu_settle', "the previous run's CPU pressure to settle"
            else:
                reason, why = 'fifo', "the head's runner to admit"
            if not mine:
                why = f"behind {head_id} queued {max(0, now() - head['created_at']):.0f} s; " + why
            state = (reason, position, len(queue), head_id, head_need, cap, running if reason == 'cap' else None)
            waited = now() - t0
            if state != last_reason or last_said is None or now() - last_said >= 60:
                errf.write(f"offbox-server: waiting; position {position} of {len(queue)}; {why}; waited {waited:.0f} s\n".encode())
                errf.flush()
                toollog.emit('boatd', 'run.queue', ids={'box': box_id, 'run': current['run_id']},
                             props={'backend': 'home', 'queued': True, 'waitMs': waited * 1000,
                                    'reason': reason, 'position': position, 'total': len(queue),
                                    'head': head_id, 'headNeedBytes': head_need, 'freeBytes': free,
                                    'running': running, 'cap': cap})
                last_reason, last_said = state, now()
        time.sleep(2)


def read_cg(path: Path) -> dict:
    out = {}
    try:
        out["mem_peak"] = int((path / "memory.peak").read_text())
    except (OSError, ValueError):
        pass
    try:
        for line in (path / "cpu.stat").read_text().splitlines():
            k, v = line.split()
            if k in ("usage_usec", "user_usec", "system_usec"):
                out["cpu_" + k] = int(v)
    except (OSError, ValueError):
        pass
    try:
        rb = wb = 0
        for line in (path / "io.stat").read_text().splitlines():
            for kv in line.split()[1:]:
                k, _, v = kv.partition("=")
                if k == "rbytes":
                    rb += int(v)
                elif k == "wbytes":
                    wb += int(v)
        out["io_read"], out["io_write"] = rb, wb
    except (OSError, ValueError):
        pass
    try:
        out["pids_peak"] = int((path / "pids.peak").read_text())
    except (OSError, ValueError):
        pass
    try:
        for line in (path / "memory.pressure").read_text().splitlines():
            if line.startswith("full"):
                out["mem_stall_us"] = int(line.split("total=")[1])
    except (OSError, ValueError, IndexError):
        pass
    try:
        for line in (path / "memory.events").read_text().splitlines():
            k, v = line.split()
            if k == "oom_kill":
                out["oom_kills"] = int(v)
    except (OSError, ValueError):
        pass
    return out


def box_window(con, box_id: str, t0: float, t1: float) -> dict:
    """Whole-box numbers over the run (includes Docker containers the run started, which live outside its cgroup)."""
    rows = con.execute("SELECT * FROM samples WHERE box_id=? AND ts BETWEEN ? AND ? ORDER BY ts",
                       (box_id, t0 - 10, t1 + 10)).fetchall()
    if not rows:
        return {}
    return {"box_mem_peak": max(r["mem_bytes"] or 0 for r in rows),
            "box_cpu_s": round(((rows[-1]["cpu_usec"] or 0) - (rows[0]["cpu_usec"] or 0)) / 1e6, 1),
            "box_io_bytes": (rows[-1]["io_bytes"] or 0) - (rows[0]["io_bytes"] or 0)}


def running_box_count(con) -> int | None:
    # Existing state only: telemetry must never invoke Incus or wait for a sampler tick.
    try:
        return con.execute("SELECT COUNT(*) FROM boxes WHERE deleted_at IS NULL "
                           "AND state IN ('ready','running')").fetchone()[0]
    except Exception:
        toollog.emit('boatd', 'host_boxes.unavailable', kind='error', ok=False,
                     props={'reason': 'state_unavailable'})
        return None


def host_box_metrics(value) -> dict:
    try:
        host = (json.loads(value) if value else {}).get('host_boxes')
        if isinstance(host, dict):
            value = {k: host[k] if type(host.get(k)) is int and host[k] >= 0 else None for k in ('start', 'end')}
            value.update({k: host[k] for k in ('start_reason', 'end_reason') if isinstance(host.get(k), str)})
            return {'host_boxes': value}
    except Exception:
        pass
    return {'host_boxes': None}


def disk_preflight(con, row, errf):
    if not row['run_id']:
        return 0
    owner = con.execute('SELECT owner FROM boxes WHERE id=?', (row['box_id'],)).fetchone()
    if owner and owner['owner'] in CFG.get('person_owners', []):
        return 0
    # Hold the same lock as admission: the live-run snapshot remains valid throughout cleanup.
    with open(ADMIT_LOCK, 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        live = [dict(r) for r in con.execute(
            "SELECT run_id,COALESCE(started_at,created_at) AS started_at FROM commands "
            "WHERE box_id=? AND pid!=? AND status IN ('queued','running')",
            (row['box_id'], row['pid']))]
        context = dict(box_id=row['box_id'], run_id=row['run_id'], live=live)
        source = Path(offbox_disk_space.__file__).read_text()
        command = 'python3 -I -c ' + shlex.quote(source) + ' preflight ' + shlex.quote(json.dumps(context))
        probe = ct_exec(row['box_id'], command, timeout=120, check=False)
        for text in (probe.stdout, probe.stderr):
            if text:
                errf.write(text)
                for line in text.decode(errors='replace').splitlines():
                    log(f"{row['box_id']} {row['run_id']}: {line}")
        return probe.returncode


def free_idle_tmp(con, finishing, result):
    box = finishing['box_id']
    row = con.execute('SELECT * FROM boxes WHERE id=?', (box,)).fetchone()
    if not row or row['pinned'] or row['owner'] in CFG.get('person_owners', []) or 'pool' not in row['name']:
        return
    if not finishing['run_id'] or not finishing['started_at'] or result.get('reason') == 'before_spawn':
        return
    if con.execute("SELECT 1 FROM commands WHERE box_id=? AND pid!=? AND status IN ('queued','running') LIMIT 1",
                   (box, finishing['pid'])).fetchone() or held_runs(con, box, exclude_pid=finishing['pid']):
        return
    receipt = f"{finishing['pid']}/{finishing['attempt'] or 1}"
    key = 'tmp_freed:' + box
    prior = con.execute('SELECT v FROM meta WHERE k=?', (key,)).fetchone()
    if prior and prior['v'] == receipt:
        return
    if run_processes(box, finishing['pid']) != []:
        return
    # #198's fd-anchored reaper preserves foreign owners, mounted trees, sockets and live-held files.
    # Keep lock inodes as well as retained run scratch: a concurrent setup may be waiting on a lock.
    source = Path(offbox_disk_space.__file__).read_text().split("\nif __name__ == '__main__':")[0]
    source += "\nimport pwd\nroots=('/tmp','/dev/shm')\n"
    source += "def used():\n return sum((s.f_blocks-s.f_bfree)*s.f_frsize for root in roots for s in [os.statvfs(root)])\n"
    source += "before=used()\nremoved=0\n"
    source += "\nfor root in ('/tmp','/dev/shm'):\n removed += reap(root,pwd.getpwnam('user').pw_uid,[],finished_before=" + repr(
        result.get('ended_at') or now()) + ",keep_prefixes=('offbox-','.offbox'),emit=lambda item:None)\n"
    source += "print(json.dumps(dict(bytes=max(0,before-used()))))\n"
    try:
        p = ct_exec(box, 'python3 -I -c ' + shlex.quote(source), timeout=30, check=False)
        freed = json.loads(p.stdout) if p.returncode == 0 else None
        if not isinstance(freed, dict) or type(freed.get('bytes')) is not int or freed['bytes'] < 0:
            raise ValueError('tmp cleanup result unavailable')
        con.execute('INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)', (key, receipt))
        toollog.emit('boatd', 'box.tmp_freed', ids={'box': box, 'run': finishing['run_id']},
                     props=freed)
    except (OSError, ValueError, Fail, subprocess.SubprocessError):
        # A failed cleanup leaves allocations visible to admission; never turn an unknown run into idle.
        toollog.emit('boatd', 'box.tmp_free_failed', kind='error', ok=False, ids={'box': box},
                     props={'reason': 'cleanup_unavailable'})


def run_cmd(box_id: str, pid: int) -> int:
    load_cfg()
    con = db()
    r = cmd_row(con, box_id, pid)
    if r['status'] not in ('queued', 'running'):
        return 0
    attempt = r["attempt"] or 1
    d = cmd_dir(box_id)
    outf = open(d / f"{pid}.out", "ab", buffering=0)
    errf = open(d / f"{pid}.err", "ab", buffering=0)
    out_offset, err_offset = outf.tell(), errf.tell()
    # needrestart can invoke the same transient unit again. Admission is not a new user run.
    previous_start = r['started_at'] if r['status'] == 'running' else None
    history_path = d / f'{pid}.{attempt}.invocations.json'
    earlier = previous_start is not None or history_path.exists() or \
              (attempt == 1 and (out_offset > 0 or err_offset > 0))
    invocation_at = now()
    errf.write((offbox_disk_space.MARKER + json.dumps(dict(phase='attempt', attempt=attempt)) + '\n').encode())
    if previous_start is not None:
        queued = r['queued_s'] or 0
    elif r["sync"]:
        # Control commands must remain available while detached runs wait for host capacity.
        queued = 0
        con.execute("UPDATE commands SET status='running', started_at=?, queued_s=0, boot_id=? "
                    "WHERE box_id=? AND pid=?", (now(), boot_id(), box_id, pid))
    else:
        queued = admit(con, box_id, pid, r["kind"], errf)
    if cmd_row(con, box_id, pid)['status'] not in ('queued', 'running'):
        outf.close()
        errf.close()
        return 0
    code, sig = None, None
    t0 = now()
    t0 = previous_start if previous_start is not None else t0
    try:
        history = json.loads(history_path.read_text())
    except (OSError, ValueError):
        history = []
    history.append(dict(invoked_at=invocation_at, previous_started_at=previous_start,
                        previous_boot_id=r['boot_id'], boot_id=boot_id(), stdout_offset=out_offset, stderr_offset=err_offset))
    write_json(history_path, history)
    host_boxes = {"start": running_box_count(con), "end": None}
    if host_boxes['start'] is None:
        host_boxes['start_reason'] = 'state_unavailable'
    dispatched, failure = False, None
    incus_began, incus_code = None, None
    wrapper_path = f'/run/boatd/{pid}.{attempt}.boatd-wrap'
    try:
        if (d / f"{pid}.kill").exists() or cmd_row(con, box_id, pid)['killed'] or json.loads(cmd_row(con, box_id, pid)['metrics'] or '{}').get('kill_request'):
            code, sig = 143, "SIGTERM"
        elif disk_preflight(con, r, errf):
            code = 90
            if earlier:
                failure = 'replacement runner preflight rejected before dispatch'
        else:
            # Existing boxes and saved bases may still have an older installed wrapper. An immutable copy
            # per attempt provides receipts without replacing code used by another live command.
            wrapper = shlex.quote(SELF.with_name('boatd-wrap').read_text())
            ct_exec(box_id, f"mkdir -p /run/boatd && cat > /run/boatd/{pid}.sh && chmod 600 /run/boatd/{pid}.sh "
                    f"&& if ! test -e {wrapper_path}; then (set -C; printf %s {wrapper} > {wrapper_path}) "
                    f"&& chmod 700 {wrapper_path}; fi",
                    input=r["command"].encode(), timeout=60)
            # Starting the host client is the dispatch boundary. Kill intent and dispatch share the lock;
            # waiting for the command happens outside it so a live command can always be killed.
            with result_lock(box_id, pid):
                current = cmd_row(con, box_id, pid)
                if current['killed'] or current['status'] not in ('queued', 'running') or (d / f'{pid}.kill').exists():
                    p = None
                    code, sig = 143, 'SIGTERM'
                else:
                    incus_began = time.monotonic()
                    p = subprocess.Popen(["incus", "exec", ct(box_id), "--", wrapper_path, str(pid),
                                          r["cwd"] or "/home/user", str(attempt)],
                                         stdin=subprocess.DEVNULL, stdout=outf, stderr=errf)
                    dispatched = True
            if p is not None:
                code = p.wait()
                incus_code = code
            if code is not None and code < 0:
                sig, code = signal.Signals(-code).name, 128 - code
    except Exception as e:  # noqa: BLE001
        failure = str(e)
        code = 90
    finally:
        if incus_began is not None:
            toollog.emit('boatd', 'incus_call', kind='perf' if incus_code == 0 else 'error',
                         duration_ms=(time.monotonic()-incus_began)*1000, ok=incus_code == 0,
                         ids={'box': box_id}, props={'commandKind': 'exec', 'exitCode': incus_code,
                                                    'outcome': 'ok' if incus_code == 0 else 'error'})
    if failure and not dispatched and not earlier:
        evidence = command_probe(r)
        if evidence.get('marker') or evidence.get('box_rc') is not None or len(history) > 1:
            earlier = True
            t0 = (evidence.get('marker') or {}).get('time') or t0
    stderr = tail(d / f'{pid}.err', 8192, err_offset)
    if dispatched and code == 126 and 'boatd-wrap: start marker unavailable; command not dispatched' in stderr:
        view = command_probe(r)
        failure = 'wrapper start marker unavailable'
        if not earlier and view.get('readable') and not view.get('marker') and view.get('box_rc') is None:
            code, dispatched = 90, False
        else:
            earlier = True
            t0 = (view.get('marker') or {}).get('time') or t0
    if dispatched and code != 0 and not earlier:
        view = command_probe(r)
        if view.get('readable') and not view.get('pids') and view.get('marker') is None and view.get('box_rc') is None and \
                outf.tell() == out_offset and 'offbox-command-started:' not in stderr and \
                (wrapper_path in stderr or '/usr/local/sbin/boatd-wrap' in stderr) and any(s in stderr.lower() for s in (
                    'no such file or directory', 'executable file not found', 'permission denied')):
            # An explicit execve rejection plus no guest marker is positive proof of a pre-start failure.
            failure, code, dispatched = 'Incus could not execute boatd-wrap', 90, False
    requested = (d / f'{pid}.kill').exists() or cmd_row(con, box_id, pid)['killed'] or json.loads(cmd_row(con, box_id, pid)['metrics'] or '{}').get('kill_request')
    transport = not requested and code != 0 and (failure is not None or stream_failure(stderr) or
                              (dispatched and sig in ('SIGKILL', 'SIGTERM', 'SIGHUP')))
    if transport and (earlier or dispatched):
        c = dict(cmd_row(con, box_id, pid))
        cause = 'incus_unavailable' if 'shutting down' in (failure or stderr).lower() else \
                ('runner_restart' if sig else 'exec_stream_lost')
        info = interruption(c, cause)
        info['phase'] = 'running'
        why = 'Incus on the home server shut down' if cause == 'incus_unavailable' else cause.replace('_', ' ')
        info['message'] = f"{why} at {iso(now())}: the command ran partly; check what it did"
        res = dict(attempt=attempt, status='interrupted', exit_code=None, started_at=t0,
                   ended_at=now(), boot_id=r['boot_id'] or boot_id(), interruption=info,
                   invocations=history, host_boxes=host_boxes)
        view = recover_probe(c)
        if not view.get('readable'):
            host_boxes.update(end=None, end_reason=view.get('reason') or 'incus_unavailable')
        else:
            host_boxes['end'] = running_box_count(con)
            if host_boxes['end'] is None:
                host_boxes['end_reason'] = 'state_unavailable'
        toollog.emit('boatd', 'run.exec_stream_lost', kind='error', ok=False,
                     ids={'box': box_id, 'run': r['run_id']},
                     props={'incusRc': code, 'stderrTail': (failure or stderr)[-1000:],
                            'rcFilePresent': view.get('box_rc') is not None,
                            'cgroupProcessCount': len(view['pids']) if view.get('pids') is not None else None})
        # The earlier invocation might still be alive even though its replacement failed to dispatch.
        # Both paths inspect that command before deciding; neither removes a possibly live cgroup.
        with runner_dispatch():
            act = settle_transport(con, c, res, view=view)
            if act == 'retry':
                cur = cmd_row(con, box_id, pid)
                err = spawn_runner(box_id, pid, cur['attempt'])
                if err:
                    drop_cmd(con, box_id, pid, f'could not retry interrupted command: {err}')
        outf.close()
        errf.close()
        return 0
    if failure:
        errf.write(f"\noffbox-server: never started; nothing ran, safe to retry (before_spawn): {failure}\n".encode())
        toollog.emit('boatd', 'run.never_started', kind='error', ok=False,
                     ids={'box': box_id, 'run': r['run_id']}, props={'phase': 'before_spawn', 'attempt': attempt})
    t1 = now()
    host_boxes['end'] = running_box_count(con)
    if host_boxes['end'] is None:
        host_boxes['end_reason'] = 'state_unavailable'
    toollog.emit("boatd", "run.command", kind="perf" if code == 0 else "error", duration_ms=max(0, t1-t0)*1000,
                 ok=code == 0, ids={"box": box_id, "run": r["run_id"]},
                 props={"exitCode": code, "timeoutHit": code == 124, "attempt": attempt, "backend": "home"},
                 tag="command_failed" if code != 0 else None)
    observed = dispatched and failure is None and sig is None and not stream_failure(stderr)
    status = "lost" if code == 255 and not ct_running(box_id) else "exited"
    disk = offbox_disk_space.command_result(d / f'{pid}.out', d / f'{pid}.err', code,
                                            stdout_offset=out_offset, stderr_offset=err_offset)
    errf.write((offbox_disk_space.MARKER + json.dumps(
        dict(phase='result', attempt=attempt, record=disk)) + '\n').encode())
    result = dict(attempt=attempt, status=status, exit_code=code, signal=sig,
                  started_at=t0, ended_at=t1, boot_id=r['boot_id'] if earlier else boot_id(),
                  host_boxes=host_boxes, invocations=history, reason="before_spawn" if failure else None)
    m = read_cg(cg_path(box_id) / "boatd" / str(pid))
    m.update(box_window(con, box_id, t0, t1))
    m.update(disk)
    m["wall_s"] = round(t1 - t0, 2)
    m["queued_s"] = round(queued, 2)
    m["host_boxes"] = host_boxes
    if failure:
        m['start_failure'] = 'before_spawn'
    action = record_command_result(con, cmd_row(con, box_id, pid), result, m, 'finalized',
                                   terminal_evidence=observed, before_spawn=not earlier and not dispatched)
    if action == 'following':
        outf.close()
        errf.close()
        return 0
    # Retain the empty group with its start marker: a later kill must still be able to verify cleanup.
    con.execute("UPDATE boxes SET last_active=?, updated_at=? WHERE id=?", (now(), now(), box_id))
    try:
        ct_exec(box_id, f"rm -f /run/boatd/{pid}.sh {wrapper_path}", timeout=30, check=False)
    except (OSError, Fail, subprocess.SubprocessError):
        pass
    # Snapshot after every run, on the server. Instant on ZFS; retention trims old ones.
    if ct_running(box_id):
        snapshot(con, box_id, "auto")
        prune_snaps(con, box_id)
    outf.close()
    errf.close()
    return 0


# ---------------------------------------------------------------- reconcile (every start, and for orphans later)

def pending_kill_rows(con):
    # A killed run can still have a terminal row if the daemon died after saving its cleanup hold.
    return [c for c in con.execute("SELECT * FROM commands WHERE killed=1 AND status NOT IN ('queued','running')")
            if json.loads(c['metrics'] or '{}').get('kill_request') or
            (read_result(c['box_id'], c['pid'], c['attempt'] or 1) or {}).get('kill_pending')]

def _note(box_id: str, pid: int, text: str) -> None:
    try:
        with open(cmd_dir(box_id) / f"{pid}.err", "ab") as f:
            f.write(f"\noffbox-server: {text}\n".encode())
    except OSError:
        pass


@locked_command
def settle_cmd(con, c) -> str:
    """One command the database calls queued or running. Returns what was done:
    following   its unit is alive (boatd alone restarted): nothing to do, its output keeps landing in the files
    finalized   the unit ended while nobody recorded it: exit code from its result file, snapshot taken
    killed      it was being killed when its unit went away
    requeue     it never started: still queued, needs a runner again
    retry       it was running, the unit is gone with no result, and it may be retried: queued again, next attempt
    interrupted same, but not to be retried (or already retried once): final"""
    box_id, pid, attempt = c["box_id"], c["pid"], c["attempt"] or 1
    res = read_result(box_id, pid, attempt)
    kf = cmd_dir(box_id) / f'{pid}.kill'
    if kf.exists() or (res or {}).get('kill_pending') or json.loads(c['metrics'] or '{}').get('kill_request'):
        return restore_kill_result(con, c, res or {},
                                   lost=kf.exists() and kf.read_text().strip() == 'lost')[0]
    if unit_active(unit_name(box_id, pid, attempt)):
        return "following"
    t = now()
    if res:
        if res.get('status') == 'running' and res.get('interruption'):
            return settle_transport(con, c, res)
        if res.get('status') == 'interrupted':
            if (res.get('interruption') or {}).get('cleanup') == 'unknown':
                return settle_transport(con, c, res)
            return save_interruption(con, c, res.get('interruption') or interruption(c, 'boatd_restart'), result=res)
        m = json.loads(c['metrics']) if c['metrics'] else {"wall_s": round((res.get("ended_at") or t) - (res.get("started_at") or t), 2),
             "queued_s": c["queued_s"], "recovered": True, "host_boxes": res.get('host_boxes')}
        res.setdefault('status', 'exited')
        res['ended_at'] = res.get('ended_at') or t
        action = record_command_result(con, c, res, m, 'finalized')
        b = con.execute("SELECT state FROM boxes WHERE id=? AND deleted_at IS NULL", (box_id,)).fetchone()
        if action == 'finalized' and b:
            if b['state'] == 'resuming':
                queue_snapshot(con, box_id, 'auto')
            elif b['state'] in LIVE:
                snapshot(con, box_id, "auto")
                prune_snaps(con, box_id)
        return action
    if c["status"] == "queued":
        return "requeue"
    cause = 'host_restart' if c['boot_id'] != boot_id() else 'runner_restart'
    info = interruption(c, cause)
    view = command_probe(c)
    # A surviving exec is followed in place; no runner is dispatched for it.
    if view.get('pids') or view.get('box_rc') is not None:
        return settle_transport(con, c, {'attempt': attempt, 'started_at': c['started_at'],
                                        'interruption': info}, view=view)
    return save_interruption(con, c, info)


def drop_cmd(con, box_id: str, pid: int, why: str) -> None:
    _note(box_id, pid, why)
    c = cmd_row(con, box_id, pid)
    if c['status'] in ('queued', 'running'):
        info = interruption(c, 'boatd_restart')
        info['message'] = why
        # This is a failed redispatch, not permission to try dispatching again.
        c = dict(c)
        c['retry_interrupted'] = 0
        save_interruption(con, c, info, view=dict(readable=True, pids=[], box_rc=None))


def start_container(box_id: str) -> str | None:
    """Bring a box the database calls live back up (after a host restart). Returns the error text, or None."""
    c2 = db()
    failure = {}
    identity_pending = False
    try:
        r = box_row(c2, box_id)
        identity_pending = bool(r['identity_pending'])
        set_box(c2, box_id, state='resuming')
        failure = json.loads(r['start_error'] or '{}')
        if not ct_running(box_id):
            apply_size(box_id, r["type"])
            _prepare_proxies(c2, box_id)
            scratch().start(box_id)
        if identity_pending or failure.get('provision'):
            _wait_boot(box_id, ssh=False)
            _fresh_identity(box_id)
            set_box(c2, box_id, identity_pending=0)
        _wait_boot(box_id)
        scratch().verify(box_id)
        set_box(c2, box_id, state="ready", last_active=now(), error=None, start_error=None)
        return None
    except Exception as e:  # noqa: BLE001
        if isinstance(e, Fail) and e.code == 'incus_slow':
            failed_start(c2, box_id, e)
        elif failure or identity_pending:
            failure_error = e if isinstance(e, Fail) else Fail(500, 'incus_failed', str(e))
            failed_start(c2, box_id, failure_error, provision=identity_pending, record=False)
        else:
            protected = offbox_protection.blocked(box_protection(c2, box_id, probe=False))
            set_box(c2, box_id, state='error' if protected else 'archived', stopped_at=now(),
                    error=f"did not start after a server restart: {e}"[:500])
        return str(e)
    finally:
        c2.close()


def sync_snaps(con, box_id: str) -> tuple[int, int]:
    """Make the snaps table match what Incus has for this box: a snapshot taken just before a crash is adopted,
    a row whose snapshot never came to exist is dropped. Nothing is deleted from the pool here."""
    p = incus("query", f"/1.0/instances/{ct(box_id)}/snapshots?recursion=1", check=False, timeout=60)
    if p.returncode != 0:
        return 0, 0
    try:
        have = {s["name"]: s for s in json.loads(p.stdout or b"[]")}
    except (ValueError, TypeError, KeyError):
        return 0, 0
    rows = {r["name"] for r in con.execute("SELECT name FROM snaps WHERE box_id=?", (box_id,))}
    adopted = dropped = 0
    for name in set(have) - rows:
        kind = name.split("-", 1)[0]
        try:
            ts = dt.datetime.fromisoformat(str(have[name].get("created_at"))[:19] + "+00:00").timestamp()
        except ValueError:
            ts = now()
        con.execute("INSERT OR REPLACE INTO snaps VALUES (?,?,?,?)", (box_id, name, kind, ts))
        adopted += 1
    for name in rows - set(have):
        con.execute("DELETE FROM snaps WHERE box_id=? AND name=?", (box_id, name))
        dropped += 1
    return adopted, dropped


@dispatching
@offbox_protection.actor('restart')
def reconcile(con) -> dict:
    """Run at every boatd start, before the API answers. Brings database, systemd units and containers back in
    line after a boatd restart or a host crash. Safe to run twice."""
    out = {"following": 0, "finalized": 0, "killed": 0, "requeue": 0, "retry": 0, "interrupted": 0,
           "boxes_started": 0, "boxes_failed": 0, "cleaned": []}
    # Fence all restores before any startup cleanup can dispatch a deletion.
    con.execute("UPDATE boxes SET state='resuming' WHERE deleted_at IS NULL AND state IN ('ready','running')")
    boxes = {r["id"]: r for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall()}
    # 1. A box whose creation was cut short: nothing useful is in it. Remove the half-made container; the row
    # stays as an error so the client that asked for it gets a clear answer.
    for bid, r in boxes.items():
        if r["state"] == "provisioning":
            set_box(con, bid, provision_identity=1)
            try:
                cleanup_provision(bid, r['owner'])
                set_box(con, bid, state="error", error="creation was interrupted by a server restart; create it again")
                out["cleaned"].append(f"half-created box {bid}")
            except Exception as e:
                # An unsafe backing must not be erased, or block recovery of unrelated boxes.
                set_box(con, bid, state="error", error=f"creation interrupted; cleanup deferred: {e}"[:500])
                log(f'creation cleanup deferred for {bid}: {e}')
    # 2. Saved states whose copy was cut short: remove exactly that copy, keep the previous one.
    for sv in con.execute("SELECT * FROM saved WHERE status='pending'").fetchall():
        if sv["pending_instance"]:
            queue_saved_delete(con, sv['pending_instance'])
        con.execute("UPDATE saved SET status=?, error=?, pending_instance=NULL WHERE owner=? AND name=?",
                    ("ready" if sv["instance"] else "failed", "interrupted by a server restart; save again",
                     sv["owner"], sv["name"]))
        out["cleaned"].append(f"half-made saved state {sv['owner']}/{sv['name']}")
    # 3. Runs.
    spawn = []
    for c in [*con.execute("SELECT * FROM commands WHERE status IN ('queued','running') ORDER BY created_at, box_id, "
                          "pid").fetchall(), *pending_kill_rows(con)]:
        act = settle_cmd(con, c)
        out[act] += 1
        if act in ("requeue", "retry"):
            spawn.append((c["box_id"], c["pid"]))
    # Older boatd versions settled the Incus client's exit 1. Repair only that transport-error class.
    for c in con.execute("SELECT * FROM commands WHERE status='exited' AND killed=0 AND exit_code IN (1,125) AND ended_at > ?",
                         (now() - 3600,)).fetchall():
        if (cmd_dir(c['box_id']) / f"{c['pid']}.{c['attempt'] or 1}.invocations.json").exists():
            continue
        if (json.loads(c['metrics'] or '{}').get('interruption') or {}).get('stream_state') == 'ended':
            continue
        text = tail(cmd_dir(c['box_id']) / f"{c['pid']}.err", 8192)
        boundaries = [m.end() for m in re.finditer(
            r'(?m)^offbox-server: the server restarted while this run was going \(attempt \d+ is lost\); '
            r'it is queued again as attempt \d+\s*$', text)]
        if boundaries:
            text = text[boundaries[-1]:]
        elif (c['attempt'] or 1) > 1:
            continue
        if not stream_failure(text):
            continue
        c = dict(c)
        c['retry_interrupted'] = 0
        info = interruption(c, 'exec_stream_lost')
        info['phase'] = 'running'
        newer = con.execute('SELECT 1 FROM commands WHERE box_id=? AND created_at>? LIMIT 1',
                            (c['box_id'], c['created_at'])).fetchone()
        if newer:
            info['superseded'] = True
        act = settle_transport(con, c, {'attempt': c['attempt'] or 1, 'started_at': c['started_at'],
                                       'interruption': info}, repair_legacy=True)
        out[act] += 1
        if newer and act == 'following':
            _note(c['box_id'], c['pid'], 'old settled run still has unconfirmed processes; reported and box held')
            toollog.emit('boatd', 'run.orphaned', kind='error', ok=False,
                         ids={'box': c['box_id'], 'run': c['run_id']}, props={'superseded': True})
    # 4. Containers: what the database calls live runs; a stop that was under way is finished; stopped stays stopped.
    boxes = {r["id"]: r for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall()}
    want = [bid for bid, r in boxes.items() if r["state"] in LIVE + ("resuming",)]
    errs: dict[str, str | None] = {}
    threads = []
    for bid in want:
        th = threading.Thread(target=offbox_protection.bind(lambda b=bid: errs.__setitem__(b, start_container(b))), daemon=True)
        th.start()
        threads.append(th)
    end = now() + 420
    for th in threads:
        th.join(max(1.0, end - now()))
    for bid in want:
        if bid in errs and errs[bid] is None:
            out["boxes_started"] += 1
        else:
            out["boxes_failed"] += 1
            log(f"reconcile: box {bid} did not come back: {errs.get(bid, 'still starting')}")
    for bid, r in boxes.items():
        if r["state"] == "stopping":
            try:
                if r['start_error']:
                    continue_failed_start(con, bid)
                else:
                    continue_stop(con, bid, "finishing a stop cut short by a restart")
            except Exception as e:  # noqa: BLE001
                log(f"reconcile: stop {bid} failed: {e}")
            out["cleaned"].append(f"finished stop of {bid}")
    # 5. Runners for the runs that wait, oldest first (admission keeps that order).
    for bid, pid in spawn:
        c = cmd_row(con, bid, pid)
        if c["status"] != "queued":
            continue
        b = con.execute("SELECT state FROM boxes WHERE id=? AND deleted_at IS NULL", (bid,)).fetchone()
        if not b or b["state"] not in LIVE:
            drop_cmd(con, bid, pid, "its box did not come back after the server restarted; the run was dropped")
            out["interrupted"] += 1
            continue
        (cmd_dir(bid) / f"{pid}.result.json").unlink(missing_ok=True)
        err = spawn_runner(bid, pid, c["attempt"] or 1)
        if err:
            drop_cmd(con, bid, pid, f"could not be started again after the server restarted: {err}")
            out["interrupted"] += 1
    # 6. Snapshot records.
    adopted = dropped = 0
    for bid in boxes:
        a, d = sync_snaps(con, bid)
        adopted, dropped = adopted + a, dropped + d
    if adopted or dropped:
        out["cleaned"].append(f"snapshot records: {adopted} adopted, {dropped} dropped")
    drain_replays(con)
    return out


def snap_rotate(con, kind: str) -> dict:
    """Timer entry (boatd-snap-<kind>.timer): snapshot every person box that changed since its last snapshot of
    this kind, then prune by RETENTION. Her data stays on this server; these snapshots are its history."""
    if kind not in TIMER_KINDS:
        raise Fail(400, "invalid_kind", f"kind must be one of {', '.join(TIMER_KINDS)}")
    done, skipped = [], []
    owners = CFG.get("person_owners") or []
    for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL AND state != 'provisioning'").fetchall():
        if r["owner"] not in owners:
            continue
        last = con.execute("SELECT name FROM snaps WHERE box_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
                           (r["id"], kind)).fetchone()
        if last:
            rc, w = _sh(["zfs", "get", "-Hp", "-o", "value", f"written@snapshot-{last['name']}",
                         f"{zpool()}/containers/{ct(r['id'])}"])
            if rc == 0 and w == "0":
                skipped.append(r["id"])
                continue
        if snapshot(con, r["id"], kind):
            done.append(r["id"])
        prune_snaps(con, r["id"])
    return {"kind": kind, "snapshotted": done, "unchanged": skipped}


# ---------------------------------------------------------------- reaper + sampler

def ssh_sessions(box_id: str) -> int:
    """Guest and management SSH sessions keep a box warm, including offbox tunnels."""
    st = ct_state(box_id)
    p = st.get("pid")
    n = 0
    for f in ("tcp", "tcp6"):
        try:
            for line in Path(f"/proc/{p}/net/{f}").read_text().splitlines()[1:]:
                parts = line.split()
                if parts[1].rsplit(":", 1)[-1] in ("0016", f"{MGMT_PORT:04X}") and parts[3] == "01":
                    n += 1
        except (OSError, IndexError):
            pass
    return n


@toollog.observed("boatd", "reaper.pass", "reaper_failed")
@offbox_protection.actor('reaper/idle timer')
def reap_once(con) -> None:
    toollog.rollup_previous()
    toollog.rollup_today()
    t = now()
    for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall():
        bid = r["id"]
        if r['state'] == 'stopping' and r['start_error']:
            continue_failed_start(con, bid)
            continue
        if r['pinned'] and r['pin_until'] is not None and r['pin_until'] <= t:
            with box_memory_lock(bid):
                current = box_row(con, bid)
                if current['pinned'] and current['pin_until'] is not None and current['pin_until'] <= t:
                    with box_transaction(con):
                        set_box(con, bid, pinned=0)
                        box_event(con, bid, 'pin_expired', 'pin reached its expiry')
        if r["state"] in LIVE:
            busy = con.execute("SELECT COUNT(*) FROM commands WHERE box_id=? AND status IN ('queued','running')",
                               (bid,)).fetchone()[0]
            if busy or box_protection(con, bid, probe=False)['pin']['active'] or held_runs(con, bid) or ssh_sessions(bid):
                set_box(con, bid, last_active=t)
                continue
            if r["ttl"] and t > (r["last_active"] or r["updated_at"]) + r["ttl"]:
                try:
                    stop_box(con, bid, "idle ttl")
                    toollog.emit("boatd", "reaper.action", ok=True, ids={"box": bid}, props={"action": "stop"})
                except Exception as e:  # noqa: BLE001
                    toollog.emit("boatd", "reaper.action", kind="error", ok=False, ids={"box": bid}, props={"action": "stop"}, tag="reaper_stop")
                    log(f"idle stop {bid} failed: {e}")
        elif r["state"] == "archived" and not r["pinned"] and r["owner"] not in (CFG.get("person_owners") or []):
            # A person's box is never deleted for being unused: it is where her data lives.
            used = con.execute("SELECT 1 FROM saved WHERE source=? AND status='ready'", (bid,)).fetchone()
            if not used and t - (r["stopped_at"] or t) > CFG["prune_unused_days"] * 86400:
                try:
                    delete_box(con, bid, 'archived box exceeded unused retention')
                    toollog.emit("boatd", "reaper.action", ok=True, ids={"box": bid}, props={"action": "delete"})
                except Exception as e:  # noqa: BLE001
                    toollog.emit("boatd", "reaper.action", kind="error", ok=False, ids={"box": bid}, props={"action": "delete"}, tag="reaper_delete")
                    log(f"prune {bid} failed: {e}")
        elif r["state"] == "error" and t - (r["updated_at"] or t) > 86400:
            try:
                delete_box(con, bid, 'failed box exceeded one-day retention')
                toollog.emit("boatd", "reaper.action", ok=True, ids={"box": bid}, props={"action": "delete"})
            except Exception as e:  # noqa: BLE001
                toollog.emit("boatd", "reaper.action", kind="error", ok=False, ids={"box": bid}, props={"action": "delete"}, tag="reaper_delete")
                log(f"prune {bid} failed: {e}")
    # Commands whose runner went away without recording an exit: same rules as at start-up.
    for c in [*con.execute("SELECT * FROM commands WHERE status IN ('queued','running') AND created_at < ? AND "
                          "COALESCE(interrupted_at, 0) < ?", (t - 30, t - 30)).fetchall(), *pending_kill_rows(con)]:
        with runner_dispatch():
            act = settle_cmd(con, c)
            if act in ("requeue", "retry"):
                b = con.execute("SELECT state FROM boxes WHERE id=? AND deleted_at IS NULL", (c["box_id"],)).fetchone()
                cur = cmd_row(con, c["box_id"], c["pid"])
                if not b or b["state"] not in LIVE:
                    drop_cmd(con, c["box_id"], c["pid"], "its box is not running; the run was dropped")
                    continue
                if act == "requeue":
                    # A queued run without a runner: mark the respawn so it is not repeated every 15 s.
                    con.execute("UPDATE commands SET interrupted_at=? WHERE box_id=? AND pid=?", (t, c["box_id"], c["pid"]))
                err = spawn_runner(c["box_id"], c["pid"], cur["attempt"] or 1)
                if err:
                    drop_cmd(con, c["box_id"], c["pid"], f"could not be started again: {err}")
            if act != "following":
                log(f"run {c['box_id']}/{c['pid']}: {act}")
    con.execute("DELETE FROM samples WHERE ts < ?", (t - CFG["keep_samples_days"] * 86400,))
    con.execute("DELETE FROM host_samples WHERE ts < ?", (t - CFG["keep_samples_days"] * 86400,))
    con.execute("DELETE FROM idem WHERE ts < ?", (t - 86400,))
    drain_replays(con)


_prev_cpu = None


def host_cpu_busy() -> float | None:
    global _prev_cpu
    v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
    idle, total = v[3] + v[4], sum(v)
    prev, _prev_cpu = _prev_cpu, (idle, total)
    if not prev or total == prev[1]:
        return None
    return round(1 - (idle - prev[0]) / (total - prev[1]), 4)


def psi(kind: str) -> float | None:
    try:
        line = Path(f"/proc/pressure/{kind}").read_text().splitlines()[0]
        value = float(line.split("avg10=")[1].split()[0])
        return value if math.isfinite(value) and 0 <= value <= 100 else None
    except (OSError, IndexError, ValueError):
        return None


def host_pressure() -> dict:
    try:
        loadavg = [float(v) for v in Path("/proc/loadavg").read_text().split()[:3]]
        if len(loadavg) != 3 or any(not math.isfinite(v) or v < 0 for v in loadavg):
            loadavg = None
    except (OSError, ValueError):
        loadavg = None
    return {"loadavg": loadavg, "cores": os.cpu_count(),
            "cpu_some_avg10": psi("cpu"), "io_some_avg10": psi("io")}


def box_mem(box_id: str) -> int | None:
    """Memory a box can't give back: anon + shmem (page cache is reclaimable and would overstate needs)."""
    try:
        st = dict(line.split() for line in (cg_path(box_id) / "memory.stat").read_text().splitlines())
        return int(st.get("anon", 0)) + int(st.get("shmem", 0))
    except (OSError, ValueError):
        return None


def sample_once(con) -> None:
    disk_maintenance(con)
    if con is None:
        return
    t = now()
    live = 0
    for r in con.execute("SELECT id FROM boxes WHERE deleted_at IS NULL AND state IN ('ready','running')").fetchall():
        live += 1
        m = read_cg(cg_path(r["id"]))
        cur = box_mem(r["id"])
        if cur is None:
            continue
        con.execute("INSERT INTO samples VALUES (?,?,?,?,?)", (t, r["id"], cur, m.get("cpu_usage_usec"),
                                                             (m.get("io_read") or 0) + (m.get("io_write") or 0)))
    total = 0
    for line in open("/proc/meminfo"):
        if line.startswith("MemTotal:"):
            total = int(line.split()[1]) * 1024
    running = con.execute("SELECT COUNT(*) FROM commands WHERE status='running'").fetchone()[0]
    queued = con.execute("SELECT COUNT(*) FROM commands WHERE status='queued'").fetchone()[0]
    st = os.statvfs("/var/lib/incus")
    con.execute("INSERT OR REPLACE INTO host_samples VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (t, mem_available(), total, host_cpu_busy(), psi("cpu"), psi("memory"), psi("io"), running, queued,
                 live, st.f_bavail * st.f_frsize))


LOOP_LOCK = threading.RLock()
LOOP_THREADS = {}
LOOP_SPECS = {}


def loop_log(event, name, **fields):
    # Logging must survive the same disk failure as SQLite.
    try:
        log(json.dumps({"event": event, "loop": name, **fields}, sort_keys=True))
    except (SystemExit, KeyboardInterrupt):
        raise
    except BaseException:
        pass


def loop_state(name, every, stamp):
    return STATE["loops"].setdefault(name, {
        "every": every, "started_at": stamp, "last_ok": None, "last_error": None,
        "last_error_at": None, "consecutive_failures": 0, "passes": 0, "failure_since": None})


def loop(fn, every: float, name: str, *, clock=None, sleep=None) -> None:
    clock, sleep = clock or now, sleep or time.sleep
    error_key, reported_at, repeats = None, 0, 0
    while True:
        delay = every
        try:
            con = None
            try:
                try:
                    con = db()
                except sqlite3.Error as e:
                    if name == 'sampler':
                        disk_maintenance(None, error=e)
                    raise
                fn(con)
            finally:
                if con is not None:
                    con.close()
            stamp = clock()
            with LOOP_LOCK:
                state = loop_state(name, every, stamp)
                failures = state["consecutive_failures"]
                since = state["failure_since"]
                state.update(last_ok=stamp, consecutive_failures=0, passes=state["passes"] + 1, failure_since=None)
            if failures:
                duration = stamp - (since if since is not None else stamp)
                loop_log("loop.recovered", name, message=f"{name} recovered after {failures} failures, {duration:.1f} s",
                         failures=failures, duration_s=duration)
            error_key, repeats = None, 0
        except (SystemExit, KeyboardInterrupt):
            raise
        except BaseException as error:
            stamp = clock()
            text = f"{type(error).__name__}: {error}"
            with LOOP_LOCK:
                state = loop_state(name, every, stamp)
                failures = state["consecutive_failures"] + 1
                if state["failure_since"] is None:
                    state["failure_since"] = stamp
                state.update(last_error=text[:240], last_error_at=stamp, consecutive_failures=failures)
            delay = min(every * 2 ** min(failures, 16), 300)
            if text != error_key:
                loop_log("loop.failed", name, error=text[:240], traceback=traceback.format_exc(), failures=failures)
                error_key, reported_at, repeats = text, stamp, 0
            else:
                repeats += 1
                if stamp - reported_at >= 300:
                    loop_log("loop.failure_repeat", name, error=text[:240], repeats=repeats, failures=failures)
                    reported_at, repeats = stamp, 0
        try:
            sleep(delay)
        except (SystemExit, KeyboardInterrupt):
            raise
        except BaseException as error:
            loop_log("loop.sleep_failed", name, error=f"{type(error).__name__}: {error}"[:240])


def start_loop(fn, every, name):
    with LOOP_LOCK:
        LOOP_SPECS[name] = (fn, every)
        loop_state(name, every, now())
        thread = LOOP_THREADS.get(name)
        if thread is None or not thread.is_alive():
            thread = threading.Thread(target=loop, args=(fn, every, name), name=f"boatd-{name}", daemon=True)
            LOOP_THREADS[name] = thread
            thread.start()


def loop_health():
    result = {}
    with LOOP_LOCK:
        for name, (fn, every) in LOOP_SPECS.items():
            state = loop_state(name, every, now())
            thread = LOOP_THREADS.get(name)
            alive = thread is not None and thread.is_alive()
            age = max(0, now() - (state["last_ok"] if state["last_ok"] is not None else state["started_at"]))
            stalled = not alive or age > max(4 * every, 120)
            problem = f"{name} has not completed a pass for {int(age)} s ({state['last_error'] or ('thread dead' if not alive else 'no error recorded')})"
            if stalled and not state.get("stalled"):
                loop_log("loop.stalled", name, problem=problem, alive=alive, age_s=age)
            elif not stalled and state.get("stalled"):
                loop_log("loop.healthy", name, passes=state["passes"])
            state["stalled"] = stalled
            result[name] = dict(state, alive=alive, age_s=age, problem=problem if stalled else None)
            if not alive and READY.is_set():
                loop_log("loop.respawn", name)
                try:
                    start_loop(fn, every, name)
                except (SystemExit, KeyboardInterrupt):
                    raise
                except BaseException as error:
                    loop_log("loop.respawn_failed", name, error=f"{type(error).__name__}: {error}"[:240])
    return result


# ---------------------------------------------------------------- stats

def pct(xs: list[float], q: float):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def stats(con, days: float = 14, owner: str | None = None) -> dict:
    """owner=None: every owner's runs (admin). Otherwise that owner's runs; the host block has no per-owner data."""
    since = now() - days * 86400
    kinds: dict[str, list] = {}
    who = "" if owner is None else " AND b.owner=?"
    args = (since,) if owner is None else (since, owner)
    for r in con.execute("SELECT c.kind, c.repo, c.metrics, b.type FROM commands c JOIN boxes b ON b.id=c.box_id "
                         "WHERE c.ended_at > ? AND c.metrics IS NOT NULL" + who, args):
        kinds.setdefault(f"{r['repo'] or '-'} {r['kind']}", []).append((json.loads(r["metrics"]), r["type"]))
    out = []
    for k, rows in sorted(kinds.items(), key=lambda kv: -len(kv[1])):
        ms = [m for m, _ in rows]

        def col(f):
            return [f(m) for m in ms if f(m) is not None]
        cpu = col(lambda m: (m.get("box_cpu_s") or (m.get("cpu_usage_usec") or 0) / 1e6) or None)
        wall = col(lambda m: m.get("wall_s"))
        cores = [c / w for c, w in zip(cpu, wall) if w and w > 1]
        out.append({"kind": k, "runs": len(rows), "sizes": sorted({t for _, t in rows}),
                    "wall_p50_s": pct(wall, .5), "wall_p95_s": pct(wall, .95),
                    "cores_p50": round(pct(cores, .5) or 0, 2), "cores_p95": round(pct(cores, .95) or 0, 2),
                    "mem_p50_gb": round((pct(col(lambda m: m.get("box_mem_peak") or m.get("mem_peak")), .5) or 0) / 2**30, 2),
                    "mem_p95_gb": round((pct(col(lambda m: m.get("box_mem_peak") or m.get("mem_peak")), .95) or 0) / 2**30, 2),
                    "queued_p95_s": pct(col(lambda m: m.get("queued_s")), .95),
                    "oom_kills": sum(m.get("oom_kills") or 0 for m in ms)})
    h = con.execute("SELECT COUNT(*) n, AVG(cpu_busy) cpu, MAX(psi_cpu) psi_cpu_max, AVG(psi_cpu) psi_cpu_avg, "
                    "AVG(psi_mem) psi_mem_avg, MIN(mem_avail) mem_min, MAX(running_cmds) run_max, "
                    "MAX(queued_cmds) q_max, MIN(disk_free) disk_min FROM host_samples WHERE ts > ?", (since,)).fetchone()
    j = "FROM commands c JOIN boxes b ON b.id=c.box_id WHERE c.ended_at > ?" + who
    waits = con.execute(f"SELECT COUNT(*) {j} AND c.queued_s > 5", args).fetchone()[0]
    total = con.execute(f"SELECT COUNT(*) {j}", args).fetchone()[0]
    return {"days": days, "kinds": out, "host": dict(h) if h else {},
            "runs": total, "memory_waits": waits, "memory_wait_pct": round(100 * waits / total, 2) if total else 0}


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "boatd/1"

    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def _send(self, status: int, obj) -> None:
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _err(self, status: int, code: str, message: str, details: dict | None = None, **extra) -> None:
        self._send(status, {**(details or {}), **extra, "ok": False, "code": code, "message": message,
                            "error": {"code": code, "message": message}})

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_PATCH(self):  # noqa: N802
        self._route("PATCH")

    def do_DELETE(self):  # noqa: N802
        self._route("DELETE")

    def _route(self, method: str) -> None:
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        path = u.path.removeprefix("/api/v1")
        if path == "/health":
            began = time.monotonic()
            try:
                return self._send(200, health())
            finally:
                elapsed = time.monotonic() - began
                if elapsed > 1:
                    log(f"health-response ms={elapsed * 1000:.1f} waited_on=snapshot-read-or-socket-write "
                        f"refresh_stage={_HEALTH_REFRESH['stage']}")
        if not READY.is_set():
            # No pool or still reconciling: nothing but /health is answered, so no caller sees half-settled runs.
            return self._err(503, "server_not_ready", STATE["problem"] or "starting", **startup_status())
        con = None
        try:
            # Refuse new writes before opening SQLite or updating token last-used.
            # Existing status/stream/kill paths stay available to running commands.
            if method == 'POST' and (path == '/sandboxes' or path.endswith(('/resume', '/fork', '/commands'))):
                disk_admit()
            con = db()
            who = token_auth(con, self.headers.get("Authorization"))
            if not who:
                return self._err(401, "unauthorized", "bad token")
            owner, admin = who
            try:
                supplied = json.loads(self.headers.get('X-Offbox-Caller') or '{}')
                if not isinstance(supplied, dict):
                    raise ValueError('caller must be an object')
            except ValueError:
                raise Fail(400, 'invalid_caller', 'invalid X-Offbox-Caller') from None
            offbox_protection.CALLER.set(offbox_protection.request_caller(supplied, owner, self.client_address[0]))
            if parts_of(path)[:1] == ["admin"]:
                if not admin:
                    raise Fail(404, "not_found", path)
                out = self._admin(con, method, parts_of(path)[1:], q)
            elif admin:
                raise Fail(403, "admin_token", "the admin token opens /admin only; use an owner token for boxes")
            else:
                out = self._dispatch(con, method, path, q, owner)
            if out is not None:
                self._send(200, out)
        except Fail as e:
            self._err(e.status, e.code, e.message, e.details)
        except Exception as e:  # noqa: BLE001
            log(f"{method} {path}: {traceback.format_exc()[-1200:]}")
            self._err(500, "internal", str(e)[:300])
        finally:
            if con is not None:
                con.close()

    def _admin(self, con, method: str, rest: list[str], q: dict):
        """Host-level calls, admin token only: every owner's stats and boxes (no box contents), token management."""
        if rest == ["stats"] and method == "GET":
            return {"ok": True, **stats(con, float(q.get("days") or 14), q.get("owner") or None)}
        if rest == ["boxes"] and method == "GET":
            rows = con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL ORDER BY created_at").fetchall()
            return {"ok": True, "sandboxes": [box_json(con, r) for r in rows]}
        if rest == ["tokens"] and method == "GET":
            return {"ok": True, "tokens": token_list(con)}
        if rest == ["tokens"] and method == "POST":
            b = self._body()
            tok = token_create(con, b.get("owner"), bool(b.get("admin")), str(b.get("label") or ""))
            return {"ok": True, "token": tok, "note": "shown once; only its hash is stored"}
        if rest[:1] == ["tokens"] and len(rest) == 2 and method == "DELETE":
            return {"ok": True, "revoked": token_revoke(con, token_id=int(rest[1]))}
        raise Fail(404, "not_found", "/admin/" + "/".join(rest))

    def _dispatch(self, con, method: str, path: str, q: dict, owner: str):
        parts = parts_of(path)
        if path == "/limits" and method == "GET":
            n = con.execute("SELECT COUNT(*) FROM boxes WHERE deleted_at IS NULL AND state IN ('ready','running') "
                            "AND owner=?", (owner,)).fetchone()[0]
            storage = {k: v for k, v in disk_state().items() if k != 'boxes'}
            blocked = storage['level'] in ('full', 'unknown')
            return {"ok": True, "type": "limits.info", "disk": storage, "canStart": not blocked,
                    "startBlockedReason": 'server_disk_low: ' + disk.description(storage) if blocked else None,
                    "activeSandboxes": n, "maxActiveSandboxes": 1000, "creditUsedSeconds": 0,
                    "creditSecondsPerDollar": 100000, "subscriptionQuotaSeconds": 0,
                    "subscriptionRemainingSeconds": 0, "subscriptionCurrentPeriodEnd": "2099-01-01T00:00:00.000Z",
                    "subscriptionStatus": "own-server", "sandboxPlanKey": "offbox-server", "packBalanceDollars": 0,
                    "last24hUsageSeconds": 0, "startLimits": {"perMinute": 1000, "perHour": 100000, "perDay": 1000000},
                    "machineTypes": [{"type": t, "available": True, "reason": None} for t in CFG["sizes"]],
                    "host": dict(con.execute("SELECT * FROM host_samples ORDER BY ts DESC LIMIT 1").fetchone() or {})}
        if path == "/stats" and method == "GET":
            return {"ok": True, **stats(con, float(q.get("days") or 14), owner)}
        if parts[:1] == ["saved-snapshots"]:
            return self._saved(con, method, parts[1:], owner)
        if parts[:1] != ["sandboxes"]:
            raise Fail(404, "not_found", path)
        if len(parts) == 1:
            if method == "GET":
                rows = con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL AND owner=? ORDER BY created_at",
                                   (owner,)).fetchall()
                boxes = [box_json(con, r) for r in rows]
                if q.get("state"):
                    boxes = [b for b in boxes if b["state"] == q["state"]]
                return {"ok": True, "type": "sandbox.list", "sandboxes": boxes,
                        "pageInfo": {"nextCursor": None, "hasMore": False, "limit": len(boxes)}}
            if method == "POST":
                b = self._body()
                return {"ok": True, "type": "sandbox.created",
                        "sandbox": create_box(con, b, self.headers.get("Idempotency-Key"), owner)}
            raise Fail(405, "method_not_allowed", method)
        bid = parts[1]
        rest = parts[2:]
        # Every call below is about one box: someone else's box answers exactly like a box that does not exist.
        box_row(con, bid, owner)
        if not rest:
            if method == "GET":
                return {"ok": True, "type": "sandbox.info", "sandbox": box_json(con, box_row(con, bid))}
            if method == "PATCH":
                b = self._body()
                kw = {}
                if "name" in b:
                    kw["name"] = str(b["name"])[:120]
                if "ttlSeconds" in b:
                    kw["ttl"] = int(b["ttlSeconds"])
                    kw["last_active"] = now()
                if "pinned" in b:
                    kw["pinned"] = 1 if b["pinned"] else 0
                    kw['pin_until'] = b.get('pinUntil')
                    kw['pin_holder'] = offbox_protection.caller().get('holder')
                    if kw['pin_until'] is not None and (type(kw['pin_until']) not in (float, int) or
                                                       not math.isfinite(kw['pin_until'])):
                        raise Fail(400, 'invalid_pin', 'pinUntil must be a finite timestamp')
                if "labels" in b:
                    kw["labels"] = json.dumps(b["labels"])
                if kw:
                    with box_memory_lock(bid):
                        if 'pinned' in kw:
                            current = box_row(con, bid)
                            check_delete_fence(con, bid)
                            pin = box_protection(con, bid, probe=False)['pin']
                            reconciliation = b.get('pinReconcile') or {}
                            if not isinstance(reconciliation, dict):
                                raise Fail(400, 'invalid_pin', 'pinReconcile must be an object')
                            legacy_claim = (pin['active'] and pin['holder'] is None and pin['until'] is None
                                            and kw['pin_holder'] and reconciliation.get('holder') == kw['pin_holder']
                                            and type(reconciliation.get('until')) in (float, int)
                                            and math.isfinite(reconciliation['until'])
                                            and reconciliation['until'] > now())
                            if pin['active'] and pin['holder'] != kw['pin_holder'] and not legacy_claim:
                                raise Fail(409, 'sandbox_pinned', f"{bid} is pinned by {pin['holder'] or 'unknown holder'}")
                            if kw['pinned'] and current['state'] in ('stopping', 'deleted', 'error'):
                                raise Fail(409, 'sandbox_unavailable', f"{bid} is {current['state']}; cannot pin")
                            foreign = [h for h in box_protection(con, bid)['holds'] if h['holder'] != kw['pin_holder']]
                            if kw['pinned'] and foreign:
                                raise Fail(409, 'box_held', f"{bid} is held by {foreign[0]['holder']} (run {foreign[0]['run_id']})")
                            if legacy_claim:
                                box_event(con, bid, 'pin_reconcile', 'client supplied its existing local pin ownership and expiry',
                                          box_protection(con, bid, probe=False), local_pin=reconciliation)
                        set_box(con, bid, **kw)
                        if 'pinned' in kw:
                            box_event(con, bid, 'pin' if kw['pinned'] else 'unpin', 'client keep')
                return {"ok": True, "sandbox": box_json(con, box_row(con, bid))}
            if method == "DELETE":
                if self.headers.get("X-Ascii-Confirm-Delete") != bid:
                    raise Fail(400, "confirm_required", "X-Ascii-Confirm-Delete must name the box")
                delete_box(con, bid)
                return {"ok": True, "deleted": bid}
            raise Fail(405, "method_not_allowed", method)
        op = rest[0]
        if op == 'protection' and method == 'GET':
            with box_memory_lock(bid):
                snapshot = box_protection(con, bid, run_id=q.get('run_id'))
            return {'ok': True, **snapshot}
        if op == 'events' and method == 'GET':
            rows = con.execute('SELECT * FROM box_events WHERE box_id=? ORDER BY seq DESC LIMIT 50', (bid,))
            return {'ok': True, 'events': [{**dict(r), 'detail': json.loads(r['detail'])} for r in rows]}
        if op == "fork" and method == "POST":
            b = self._body()
            return {"ok": True, "sandbox": create_box(con, b, self.headers.get("Idempotency-Key"), owner, src_box=bid)}
        if op == "resume" and method == "POST":
            resume_box(con, bid, self._body())
            return {"ok": True, "sandbox": box_json(con, box_row(con, bid))}
        if op == "stop" and method == "POST":
            with box_memory_lock(bid):
                require_unprotected(con, bid)
                r = box_row(con, bid)
                if r['start_error'] and r['state'] == 'archived':
                    return {"ok": True, "sandbox": box_json(con, r)}
                set_box(con, bid, state='stopping', stopped_at=None)
            context = offbox_protection.caller()
            def stop():
                offbox_protection.CALLER.set(context)
                _bg(continue_stop, bid, 'api')
            threading.Thread(target=stop, daemon=True).start()
            return {"ok": True, "sandbox": box_json(con, box_row(con, bid))}
        if op == "sshkey" and method == "POST":
            return self._sshkey(con, bid, self._body())
        if op == "usage" and method == "GET":
            r = box_row(con, bid)
            secs = con.execute("SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) FROM commands "
                               "WHERE box_id=? AND started_at IS NOT NULL", (now(), bid)).fetchone()[0]
            return {"ok": True, "type": "sandbox.usage", "sandboxId": bid, "sandboxType": r["type"],
                    "seconds": int(secs), "dollars": 0, "running": r["state"] in LIVE}
        if op == "snapshots" and rest[1:] == ["latest"] and method == "GET":
            s = latest_snap(con, bid)
            if not s:
                raise Fail(404, "snapshot_not_found", f"{bid} has no snapshot yet")
            return {"ok": True, "type": "snapshot.latest", "snapshot": {
                "origin": "captured", "id": s["name"], "sandboxId": bid, "status": "completed", "kind": s["kind"],
                "createdAt": iso(s["created_at"]), "completedAt": iso(s["created_at"])}}
        if op == "snapshots" and len(rest) == 1 and method == "GET":
            return {"ok": True, "snapshots": [{"id": s["name"], "kind": s["kind"], "createdAt": iso(s["created_at"])}
                                              for s in con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY "
                                                                   "created_at DESC", (bid,))]}
        if op == "commands":
            return self._commands(con, method, bid, rest[1:], q)
        if op == "command-history" and len(rest) >= 2:
            r = con.execute("SELECT * FROM commands WHERE box_id=? AND command_id=?", (bid, rest[1])).fetchone()
            if not r:
                raise Fail(404, "command_not_found", rest[1])
            if rest[2:] == ["logs"]:
                which = "out" if q.get("stream", "stdout") == "stdout" else "err"
                off = int(q.get("offset") or 0)
                p = cmd_dir(bid) / f"{r['pid']}.{which}"
                with open(p, "rb") as f:
                    f.seek(off)
                    data = f.read(max(4, min(1 << 20, int(q.get('limitBytes') or (1 << 20)))))
                    size = os.fstat(f.fileno()).st_size
                data, nxt = _utf8_cut(data, off)
                return {"ok": True, "data": data, "nextOffset": nxt, "size": size,
                        "done": r["status"] not in ("queued", "running") and nxt >= size,
                        "commandId": r['command_id'], "status": r['status'],
                        "attempt": r['attempt'] or 1,
                        "metrics": host_box_metrics(r['metrics']),
                        "interruption": json.loads(r['metrics'] or '{}').get('interruption')}
            return {"ok": True, "command": cmd_status_json(con, bid, r["pid"], 0)}
        raise Fail(404, "not_found", path)

    def _saved(self, con, method: str, rest: list[str], owner: str):
        if not rest:
            if method == "GET":
                rows = con.execute("SELECT * FROM saved WHERE owner=? ORDER BY created_at", (owner,)).fetchall()
                return {"ok": True, "type": "snapshot.saved.list", "snapshots": [saved_json(r) for r in rows],
                        "allowance": {"included": 10000, "free": 10000, "used": len(rows), "extra": 0}}
            if method == "POST":
                b = self._body()
                if not b.get("name") or not b.get("sandboxId"):
                    raise Fail(400, "invalid_request", "name and sandboxId are required")
                return {"ok": True, "snapshot": save_box(con, b["sandboxId"], b["name"], owner)}
            raise Fail(405, "method_not_allowed", method)
        name = urllib.parse.unquote(rest[0])
        r = con.execute("SELECT * FROM saved WHERE owner=? AND name=?", (owner, name)).fetchone()
        if method == "GET":
            if not r:
                raise Fail(404, "snapshot_not_found", name)
            return {"ok": True, "snapshot": saved_json(r)}
        if method == "DELETE":
            if not r:
                raise Fail(404, "snapshot_not_found", name)
            if r["instance"]:
                queue_saved_delete(con, r['instance'])
            con.execute("DELETE FROM saved WHERE owner=? AND name=?", (owner, name))
            drain_saved_deletes(con)
            return {"ok": True}
        raise Fail(405, "method_not_allowed", method)

    def _sshkey(self, con, bid: str, b: dict):
        r = box_row(con, bid)
        if r["state"] not in LIVE:
            raise Fail(409, "machine_not_running", f"{bid} is {r['state']}")
        key = (b.get("key") or "").strip()
        if not re.match(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S.*)?$", key):
            raise Fail(400, "invalid_key", "expected one OpenSSH public key")
        ct_exec(bid, "install -d -m 700 -o user -g user /home/user/.ssh && touch /home/user/.ssh/authorized_keys && "
                     "chown user:user /home/user/.ssh/authorized_keys && chmod 600 /home/user/.ssh/authorized_keys && "
                     "k=$(cat) && (grep -qxF \"$k\" /home/user/.ssh/authorized_keys || echo \"$k\" >> "
                     "/home/user/.ssh/authorized_keys)", input=key.encode(), timeout=60)
        hk = ct_exec(bid, "cat /etc/ssh/ssh_host_ed25519_key.pub", timeout=30).stdout.decode().split()
        if len(hk) < 2:
            raise Fail(503, "ssh_host_key_unavailable", "no host key yet")
        set_box(con, bid, last_active=now())
        mgmt_port = _ensure_mgmt_proxy(con, bid)
        return {"ok": True, "sshEndpoint": f"{CFG['ssh_host']}:{r['ssh_port']}", "hostKey": f"{hk[0]} {hk[1]}",
                "sshUser": "user", "managementSshEndpoint": f"{CFG['ssh_host']}:{mgmt_port}"}

    def _commands(self, con, method: str, bid: str, rest: list[str], q: dict):
        if not rest and method == "POST":
            b = self._body()
            if b.get("detached"):
                return start_cmd(con, bid, b)
            # Synchronous: start, wait up to timeoutSeconds, return output.
            r = start_cmd(con, bid, b)
            end = now() + int(b.get("timeoutSeconds") or 60)
            while now() < end:
                st = cmd_status_json(con, bid, r["processId"], 1 << 20)
                if not st["running"]:
                    self._log_sync(bid, st)
                    return st
                time.sleep(0.3)
            st = cmd_status_json(con, bid, r["processId"], 1 << 20)
            if not st["running"]:
                self._log_sync(bid, st)
                return st
            kill_cmd(con, bid, r["processId"])
            st = cmd_status_json(con, bid, r["processId"], 1 << 20)
            self._log_sync(bid, st, timed_out=True)
            raise Fail(408, "command_timeout", f"command {r['processId']} timed out", st)
        if not rest:
            raise Fail(405, "method_not_allowed", method)
        pid = int(rest[0])
        if len(rest) == 1 and method == "GET":
            return cmd_status_json(con, bid, pid, int(q.get("tailBytes") or 4096))
        if len(rest) == 1 and method == "DELETE":
            cmd_row(con, bid, pid)
            cleanup = kill_cmd(con, bid, pid)
            return {"ok": True, "processId": pid, 'cleanup': cleanup}
        if rest[1:] == ["stream"] and method == "GET":
            self._stream(con, bid, pid, int(q.get("stdoutOffset") or 0), int(q.get("stderrOffset") or 0))
            return None
        raise Fail(404, "not_found", "/".join(rest))

    def _log_sync(self, bid: str, st: dict, timed_out: bool = False) -> None:
        ok = not timed_out and st["exitCode"] == 0
        toollog.emit("boatd", "exec.sync", kind="event" if ok else "error", ok=ok,
                     tag="command_timeout" if timed_out else None,
                     ids={"box": bid}, props={"pid": st["processId"], "queueMs": st["queuedMs"],
                     "runMs": st["runMs"], "killed": st["killed"], "timeoutSeconds": st["timeoutSeconds"]})

    def _stream(self, con, bid: str, pid: int, out_off: int, err_off: int) -> None:
        cmd_row(con, bid, pid)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(obj) -> None:
            b = (json.dumps(obj) + "\n").encode()
            self.wfile.write(f"{len(b):x}\r\n".encode() + b + b"\r\n")
            self.wfile.flush()
        d = cmd_dir(bid)
        offs = {"out": out_off, "err": err_off}
        started = last_beat = now()
        attempt = cmd_row(con, bid, pid)["attempt"] or 1
        emit({"type": "hello", "status": cmd_row(con, bid, pid)["status"], "attempt": attempt, "bootId": boot_id(), "serverStartedAt": iso(STARTED)})
        try:
            while True:
                sent = False
                for which, typ in (("out", "stdout"), ("err", "stderr")):
                    with open(d / f"{pid}.{which}", "rb") as f:
                        f.seek(offs[which])
                        data = f.read(256 * 1024)
                    if data:
                        text, nxt = _utf8_cut(data, offs[which])
                        if nxt > offs[which]:
                            offs[which] = nxt
                            emit({"type": typ, "data": text, "nextOffset": nxt})
                            sent = True
                r = con.execute("SELECT status, exit_code, signal, attempt, command_id, started_at, ended_at, metrics FROM commands WHERE box_id=? AND pid=?",
                                (bid, pid)).fetchone()
                if (r["attempt"] or 1) != attempt:
                    attempt = r["attempt"] or 1
                    emit({"type": "attempt", "status": r["status"], "attempt": attempt})
                if r["status"] not in ("queued", "running"):
                    if sent:
                        continue  # Drain bounded chunks before handling a final incomplete UTF-8 tail.
                    sizes = {w: (d / f"{pid}.{w}").stat().st_size for w in ("out", "err")}
                    for which, typ in (("out", "stdout"), ("err", "stderr")):
                        if offs[which] < sizes[which]:  # an incomplete UTF-8 tail: the run is over, send it as is
                            with open(d / f"{pid}.{which}", "rb") as f:
                                f.seek(offs[which])
                                rest = f.read()
                            offs[which] += len(rest)
                            emit({"type": typ, "data": rest.decode(errors="replace"), "nextOffset": offs[which]})
                    if all(offs[w] >= sizes[w] for w in sizes):
                        emit({"type": "exit", "exitCode": r["exit_code"], "signal": r["signal"],
                              "status": r["status"], "attempt": attempt, "commandId": r["command_id"],
                              "startedAt": iso(r["started_at"]), "endedAt": iso(r["ended_at"]),
                              "metrics": host_box_metrics(r['metrics']),
                              "interruption": json.loads(r['metrics'] or '{}').get('interruption'),
                              **queue_loss_json(r)})
                        break
                    continue
                if now() - started > 600:
                    emit({"type": "reconnect", "stdoutOffset": offs["out"], "stderrOffset": offs["err"]})
                    break
                if now() - last_beat > 15:
                    emit({"type": "heartbeat", "status": r["status"], 'interruption': json.loads(r['metrics'] or '{}').get('interruption')})
                    last_beat = now()
                if not sent:
                    time.sleep(0.2)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True


def parts_of(path: str) -> list[str]:
    return [p for p in path.split("/") if p]


def _utf8_cut(data: bytes, off: int) -> tuple[str, int]:
    """Decode without splitting a UTF-8 character at the end; the cut bytes come in the next read."""
    cut = len(data)
    for back in range(1, min(4, len(data)) + 1):
        b = data[-back]
        if b & 0xC0 == 0x80:
            continue
        if b >= 0xC0:
            need = 2 if b < 0xE0 else 3 if b < 0xF0 else 4
            if back < need:
                cut = len(data) - back
        break
    return data[:cut].decode(errors="replace"), off + cut


def _bg(fn, *args) -> None:
    con = db()
    try:
        fn(con, *args)
    except Exception as e:  # noqa: BLE001
        log(f"{fn.__name__}{args}: {e}")
    finally:
        con.close()


def startup() -> None:
    """Wait for the state (the pool), then reconcile, then open the API. Never exits and never needs a person:
    without the pool boatd keeps answering /health with the reason and looks again every 10 s."""
    began = phase_at = time.monotonic()
    record_boot()
    phase = "pool"
    def next_phase(next_name):
        nonlocal phase, phase_at
        current = time.monotonic()
        STATE["phases"][phase] = round(current - phase_at, 3)
        log(f"startup phase={phase} duration_s={STATE['phases'][phase]:.3f}")
        phase, phase_at = next_name, current
        _HEALTH.update(ts=0, v=None)
    said = None
    while True:
        prob = state_problem()
        if prob is None:
            break
        STATE["problem"] = prob
        if prob != said:
            log(f"degraded, serving /health only: {prob}")
            said = prob
        if pool_state() == "MISSING":
            # The import may simply not have happened yet. Plain import, never forced: a pool last used by
            # another install (after REINSTALL-OS) is taken back by install-host.sh, on purpose, by a person or agent.
            _sh(["zpool", "import", CFG["zpool"]], timeout=180)
        elif CFG.get("state_dataset"):
            _sh(["zfs", "mount", CFG["state_dataset"]], timeout=60)
        time.sleep(10)
    # Incus stays down while its state directory is not mounted (install-host.sh's drop-in); the pool is here now.
    next_phase("incus")
    STATE["problem"] = "waiting for incus"
    for i in range(60):
        if _sh(["incus", "query", "/1.0"], timeout=10)[0] == 0:
            break
        STATE["problem"] = "waiting for incus"
        if i % 10 == 0:
            _sh(["systemctl", "start", "incus.socket", "incus.service"], timeout=60)
        time.sleep(2)
    next_phase("reconcile")
    STATE["problem"] = "reconciling runs and boxes after start"
    while True:
        try:
            init_db()
            con = db()
            try:
                STATE["reconcile"] = reconcile(con)
            finally:
                con.close()
            break
        except Exception:  # noqa: BLE001
            STATE["problem"] = "start-up reconcile failed; retrying (see the boatd journal)"
            log(f"reconcile: {traceback.format_exc()[-1500:]}")
            time.sleep(15)
    next_phase("ready")
    log(f"reconciled: {json.dumps(STATE['reconcile'])}")
    log(f"reconciled in {time.monotonic() - began:.3f} s phases={json.dumps(STATE['phases'])}")
    STATE["problem"] = None
    READY.set()
    start_loop(reap_once, 15, "reaper")
    start_loop(sample_once, CFG["sample_s"], "sampler")


def serve() -> None:
    load_cfg()
    srv, said = None, False
    while srv is None:
        try:
            srv = ThreadingHTTPServer((CFG["listen"], CFG["port"]), Handler)
        except OSError as e:
            # The tailnet address is not there yet (tailscaled still starting, or logged out). Keep trying
            # instead of exiting: a restart loop would look like a crash and help nobody.
            if not said:
                log(f"cannot listen on {CFG['listen']}:{CFG['port']} yet ({e}); retrying every 5 s")
                said = True
            time.sleep(5)
    srv.daemon_threads = True
    threading.Thread(target=refresh_health_forever, daemon=True).start()
    threading.Thread(target=startup, daemon=True).start()
    log(f"boatd {VERSION} listening on {CFG['listen']}:{CFG['port']}")
    srv.serve_forever()


def need_root() -> None:
    if os.geteuid() != 0:
        print("boatd: this command is for root on the server", file=sys.stderr)
        sys.exit(1)


def need_state() -> sqlite3.Connection:
    load_cfg()
    prob = state_problem()
    if prob:
        print(f"boatd: {prob}", file=sys.stderr)
        sys.exit(1)
    init_db()
    return db()


def _opt(a: list[str], name: str) -> str | None:
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else None


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] == "serve":
        serve()
        return 0
    if a[0] == "run":
        return run_cmd(a[1], int(a[2]))
    if a[0] == "health":
        load_cfg()
        READY.set() if state_problem() is None else STATE.update(problem=state_problem())
        print(json.dumps(health(fresh=True), indent=1))
        return 0
    if a[0] == "stats":
        need_root()
        days = float(_opt(a, "--days") or 14)
        print(json.dumps(stats(need_state(), days, _opt(a, "--owner")), indent=1))
        return 0
    if a[0] == "token":
        need_root()
        con = need_state()
        sub = a[1] if len(a) > 1 else ""
        try:
            if sub == "create":
                admin = "--admin" in a
                owner = _opt(a, "--owner")
                if not admin and not owner:
                    print("usage: boatd token create --owner X [--label L] | boatd token create --admin", file=sys.stderr)
                    return 2
                # The only time the token exists in clear: on this terminal, for whoever ran the command.
                print(token_create(con, owner, admin, _opt(a, "--label") or ""))
                return 0
            if sub == "list":
                for t in token_list(con):
                    who = "admin" if t["admin"] else t["owner"]
                    print(f"{t['id']:>3}  {who:<8} created {t['created'] or '-':<25} last used {t['lastUsed'] or 'never':<25} "
                          f"{'REVOKED ' + t['revoked'] if t['revoked'] else 'live':<10} {t['label'] or ''}")
                return 0
            if sub == "revoke":
                tid, owner = _opt(a, "--id"), _opt(a, "--owner")
                if not tid and not owner:
                    print("usage: boatd token revoke --id N | --owner X", file=sys.stderr)
                    return 2
                n = token_revoke(con, int(tid) if tid else None, owner)
                print(f"revoked {n} token(s)")
                return 0 if n else 1
        except Fail as e:
            print(f"boatd: {e.message}", file=sys.stderr)
            return 2
        print("usage: boatd token create|list|revoke", file=sys.stderr)
        return 2
    if a[0] == "box":
        need_root()
        con = need_state()
        sub = a[1] if len(a) > 1 else ""
        if sub == "list":
            for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL ORDER BY owner, created_at"):
                print(f"{r['id']}  {r['owner']:<8} {r['state']:<10} {r['type']:<8} {r['name']}")
            return 0
        if sub == "chown" and len(a) > 2 and _opt(a, "--owner"):
            owner = _opt(a, "--owner")
            if owner not in CFG["owners"]:
                print(f"boatd: owner must be one of {', '.join(CFG['owners'])}", file=sys.stderr)
                return 2
            r = box_row(con, a[2])
            scratch().chown(a[2], r['owner'], owner)
            set_box(con, a[2], owner=owner)
            print(f"{a[2]} now belongs to {owner}")
            return 0
        print("usage: boatd box list | boatd box chown <box> --owner X", file=sys.stderr)
        return 2
    if a[0] == "snap-rotate":
        need_root()
        con = need_state()
        try:
            print(json.dumps(snap_rotate(con, a[1] if len(a) > 1 else "")))
        except Fail as e:
            print(f"boatd: {e.message}", file=sys.stderr)
            return 2
        return 0
    if a[0] == "pin":
        need_root()
        con = need_state()
        box_row(con, a[1])
        set_box(con, a[1], pinned=0 if "--off" in a else 1)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
