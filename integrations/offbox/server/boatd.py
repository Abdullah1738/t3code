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

import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VAR = Path(os.environ.get("BOATD_VAR", "/var/lib/boatd"))
ETC = Path(os.environ.get("BOATD_ETC", "/etc/boatd"))
CMDS = VAR / "cmds"
DB_PATH = VAR / "boatd.db"
CG_ROOT = Path("/sys/fs/cgroup")
SELF = Path(__file__).resolve()
VERSION = "2.0"
STARTED = time.time()

# Snapshot retention, the one place for these numbers. Every run ends with a snapshot (kind auto; stop on a stop):
# the newest `run_keep` are kept plus the last one of each day for `run_daily_days` days. Boxes of the owners in
# `person_owners` also get timer snapshots (boatd-snap-{hourly,daily,weekly}.timer), newest N kept per kind.
RETENTION = {"run_keep": 20, "run_daily_days": 14, "person_hourly": 48, "person_daily": 30, "person_weekly": 12}
MAX_ATTEMPTS = 2                      # an interrupted run is queued again at most once

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
    "state_dataset": "",              # e.g. offbox/boatd: boatd refuses to keep state anywhere else (set by install-host.sh)
    "owners": ["ardud", "moni"], "default_owner": "ardud",
    "person_owners": ["moni"],        # their boxes get hourly/daily/weekly snapshots
    "max_running": 0,                 # hard cap on runs at once (0 = memory admission only)
    "prune_unused_days": 30,          # stopped boxes untouched this long are deleted (not pinned, not saved)
    "sample_s": 10, "keep_samples_days": 90,
}
CFG: dict = {}

LIVE = ("ready", "running")
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
"""
SAVED_V2 = """CREATE TABLE saved (owner TEXT, name TEXT, instance TEXT, source TEXT, type TEXT, status TEXT,
  error TEXT, size_bytes INTEGER, created_at REAL, snapshot_id TEXT, pending_instance TEXT,
  PRIMARY KEY (owner, name))"""


def _cols(con, table: str) -> set:
    return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}


def migrate(con) -> None:
    """Idempotent: owner columns, per-owner saved states, run attempts, hashed tokens."""
    con.executescript(SCHEMA_V2)
    owner = CFG.get("default_owner") or "ardud"
    if "owner" not in _cols(con, "boxes"):
        con.execute("ALTER TABLE boxes ADD COLUMN owner TEXT")
        con.execute("UPDATE boxes SET owner=? WHERE owner IS NULL", (owner,))
    have = _cols(con, "commands")
    for col in ("retry_interrupted INTEGER DEFAULT 0", "attempt INTEGER DEFAULT 1", "boot_id TEXT",
                "interrupted_at REAL"):
        if col.split()[0] not in have:
            con.execute(f"ALTER TABLE commands ADD COLUMN {col}")
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


READY = threading.Event()          # set once the state is there and the start-up reconcile has finished
STATE = {"problem": "starting", "reconcile": None}
_HEALTH = {"ts": 0.0, "v": None}
_HEALTH_LOCK = threading.Lock()


def health(fresh: bool = False) -> dict:
    """GET /health: no auth, no data about boxes or owners. `ok` means runs can be accepted here."""
    with _HEALTH_LOCK:
        if not fresh and _HEALTH["v"] and now() - _HEALTH["ts"] < 5:
            return _HEALTH["v"]
        reasons = []
        pool = pool_state()
        md = mdraid_state()
        ok = READY.is_set()
        if not ok:
            reasons.append(STATE["problem"] or "starting")
        if pool != "ONLINE":
            reasons.append(f"pool {CFG['zpool']} is {pool}")
        if md["state"] == "degraded":
            reasons.append("mdraid degraded: " + ", ".join(f"{k} {v}" for k, v in sorted(md["arrays"].items())))
        rc, _ = _sh(["incus", "query", "/1.0"], timeout=10)
        if rc != 0:
            ok = False
            reasons.append("incus is not answering")
        queue = running = None
        if READY.is_set():
            try:
                con = db()
                try:
                    queue = con.execute("SELECT COUNT(*) FROM commands WHERE status='queued'").fetchone()[0]
                    running = con.execute("SELECT COUNT(*) FROM commands WHERE status='running'").fetchone()[0]
                finally:
                    con.close()
            except sqlite3.Error:
                ok = False
                reasons.append("state database is not readable")
        out = {"ok": ok, "up": True, "mode": "ok" if not reasons else "degraded", "reasons": reasons,
               "pool": {"name": CFG["zpool"], "state": pool}, "mdraid": md, "queue": queue, "running": running,
               "boot_id": boot_id(), "uptime_s": int(host_uptime()), "boatd_uptime_s": int(now() - STARTED),
               "version": VERSION}
        _HEALTH.update(ts=now(), v=out)
        return out


# ---------------------------------------------------------------- incus

class Fail(Exception):
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


def incus(*args, input: bytes | None = None, timeout: float = 600, check: bool = True) -> subprocess.CompletedProcess:
    p = subprocess.run(["incus", *args], input=input, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise Fail(500, "incus_failed", f"incus {' '.join(args[:3])}: {p.stderr.decode(errors='replace')[-500:]}")
    return p


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
    return CG_ROOT / f"lxc.payload.{ct(box_id)}"


def ct_exec(box_id: str, cmd: str, input: bytes | None = None, timeout: float = 120, user: int = 0,
            check: bool = True) -> subprocess.CompletedProcess:
    args = ["exec", ct(box_id)]
    if user:
        args += ["--user", str(user), "--group", str(user), "--env", "HOME=/home/user"]
    return incus(*args, "--", "bash", "-c", cmd, input=input, timeout=timeout, check=check)


# ---------------------------------------------------------------- boxes

def new_box_id(con) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    while True:
        bid = "bx_" + "".join(secrets.choice(alphabet) for _ in range(8))
        if not con.execute("SELECT 1 FROM boxes WHERE id=?", (bid,)).fetchone():
            return bid


def next_ssh_port(con) -> int:
    used = {r[0] for r in con.execute("SELECT ssh_port FROM boxes WHERE deleted_at IS NULL AND ssh_port IS NOT NULL")}
    p = CFG["ssh_port_base"]
    while p in used:
        p += 1
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
    kw["updated_at"] = now()
    cols = ", ".join(f"{k}=?" for k in kw)
    con.execute(f"UPDATE boxes SET {cols} WHERE id=?", (*kw.values(), box_id))


def latest_snap(con, box_id: str):
    return con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC LIMIT 1", (box_id,)).fetchone()


def box_json(con, r) -> dict:
    s = CFG["sizes"].get(r["type"], CFG["sizes"]["default"])
    running = con.execute("SELECT COUNT(*) FROM commands WHERE box_id=? AND status IN ('queued','running')",
                          (r["id"],)).fetchone()[0]
    state = r["state"]
    if state == "ready" and running:
        state = "running"
    snap = latest_snap(con, r["id"])
    archive_after = None
    if state in LIVE and r["ttl"]:
        archive_after = iso((r["last_active"] or r["updated_at"]) + r["ttl"])
    return {
        "id": r["id"], "name": r["name"], "state": state, "error": r["error"], "dataExpiredAt": None,
        "stoppedAt": iso(r["stopped_at"]) if state == "archived" else None, "labels": json.loads(r["labels"] or "{}"),
        "health": "ok", "type": r["type"], "vcpu": s["vcpu"], "memoryGB": int(re.sub(r"\D", "", s["mem"])),
        "billingMultiplier": 0, "machineProvider": "offbox-server",
        "sshEndpoint": f"{CFG['ssh_host']}:{r['ssh_port']}" if r["ssh_port"] else None,
        "owner": r["owner"],
        "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]), "archiveAfter": archive_after,
        "ttlSeconds": r["ttl"], "snapshots": True, "snapshotAvailable": snap is not None,
        "snapshotCompletedAt": iso(snap["created_at"]) if snap else None,
        "lastSnapshotStatus": "completed" if snap else None, "source": r["source"], "pinned": bool(r["pinned"]),
        "environment": "offbox-server",
    }


def _ensure_proxy(box_id: str, port: int) -> None:
    devs = incus("config", "device", "list", ct(box_id), timeout=30).stdout.decode().split()
    if "ssh" in devs:
        incus("config", "device", "set", ct(box_id), "ssh", f"listen=tcp:{CFG['ssh_host']}:{port}", timeout=30)
    else:
        incus("config", "device", "add", ct(box_id), "ssh", "proxy", f"listen=tcp:{CFG['ssh_host']}:{port}",
              "connect=tcp:127.0.0.1:22", "bind=host", timeout=30)


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


def _wait_boot(box_id: str, timeout: float = 120, ssh: bool = True) -> None:
    """Wait for systemd inside the box to finish booting, then (ssh=True) for sshd on port 22."""
    end = now() + timeout
    probe = ("s=$(systemctl is-system-running 2>/dev/null); case $s in running|degraded) echo BOOTED;; esac; "
             "ss -Hltn 'sport = :22' | grep -q . && echo SSHUP")
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
        kind, ref = source
        name = ct(box_id)
        if kind == "image":
            incus("init", ref, name, "-p", "default", "-p", "offbox", timeout=900)
        elif kind == "saved":
            incus("copy", ref, name, "--instance-only", "-p", "default", "-p", "offbox", timeout=900)
        else:
            incus("copy", ct(ref), name, "--instance-only", "-p", "default", "-p", "offbox", timeout=900)
        apply_size(box_id, t)
        r = box_row(con, box_id)
        _ensure_proxy(box_id, r["ssh_port"])
        incus("start", name, timeout=300)
        _wait_boot(box_id, ssh=False)
        _fresh_identity(box_id)
        _wait_boot(box_id)
        set_box(con, box_id, state="ready", last_active=now(), error=None)
        log(f"box {box_id} ready ({kind} {ref} {t})")
    except Exception as e:  # noqa: BLE001
        log(f"provision {box_id} failed: {e}")
        set_box(con, box_id, state="error", error=str(e)[:500])
    finally:
        con.close()


def create_box(con, body: dict, idem: str | None, owner: str, src_box: str | None = None) -> dict:
    if idem:
        idem = f"{owner}:{idem}"
        r = con.execute("SELECT box_id FROM idem WHERE key=?", (idem,)).fetchone()
        if r:
            return box_json(con, box_row(con, r["box_id"], owner))
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
                "owner) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (bid, (body.get("name") or bid)[:120], t, "provisioning",
                                                          int(body.get("ttlSeconds") or 1200), t0, t0, t0,
                                                          next_ssh_port(con), src_label, owner))
    if idem:
        con.execute("INSERT INTO idem VALUES (?,?,?)", (idem, bid, t0))
    con.execute("COMMIT")
    threading.Thread(target=provision, args=(bid, source, t), daemon=True).start()
    return box_json(con, box_row(con, bid))


def snapshot(con, box_id: str, kind: str) -> str | None:
    name = f"{kind}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%f')[:-3]}"
    p = incus("snapshot", "create", ct(box_id), name, timeout=120, check=False)
    if p.returncode != 0:
        log(f"snapshot {box_id} {name} failed: {p.stderr.decode(errors='replace')[-300:]}")
        return None
    con.execute("INSERT OR REPLACE INTO snaps VALUES (?,?,?,?)", (box_id, name, kind, now()))
    return name


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
    rows = con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC", (box_id,)).fetchall()
    gone = set(snaps_to_prune(rows, CFG["retention"], now()))
    for r in rows:
        if r["name"] not in gone:
            continue
        p = incus("snapshot", "delete", ct(box_id), r["name"], timeout=120, check=False)
        if p.returncode == 0 or b"not found" in p.stderr.lower():
            con.execute("DELETE FROM snaps WHERE box_id=? AND name=?", (box_id, r["name"]))


def stop_box(con, box_id: str, why: str) -> None:
    r = box_row(con, box_id)
    if r["state"] == "archived":
        return
    set_box(con, box_id, state="stopping")
    for c in con.execute("SELECT pid FROM commands WHERE box_id=? AND status IN ('queued','running')", (box_id,)):
        kill_cmd(con, box_id, c["pid"], lost=True)
    if ct_running(box_id):
        incus("stop", ct(box_id), "--timeout", "60", timeout=120, check=False)
        if ct_running(box_id):
            incus("stop", ct(box_id), "--force", timeout=60)
    snapshot(con, box_id, "stop")
    prune_snaps(con, box_id)
    set_box(con, box_id, state="archived", stopped_at=now())
    log(f"box {box_id} stopped ({why})")


def resume_box(con, box_id: str, body: dict) -> None:
    r = box_row(con, box_id)
    if body.get("ttlSeconds"):
        set_box(con, box_id, ttl=int(body["ttlSeconds"]))
    if body.get("type") and body["type"] != r["type"]:
        t = size_of(body["type"])
        set_box(con, box_id, type=t)
    if r["state"] in LIVE or r["state"] == "provisioning":
        set_box(con, box_id, last_active=now())
        return
    set_box(con, box_id, state="resuming", error=None, last_active=now())

    def go():
        c2 = db()
        try:
            apply_size(box_id, box_row(c2, box_id)["type"])
            _ensure_proxy(box_id, box_row(c2, box_id)["ssh_port"])
            if not ct_running(box_id):
                incus("start", ct(box_id), timeout=300)
            _wait_boot(box_id)
            set_box(c2, box_id, state="ready", last_active=now())
            log(f"box {box_id} resumed")
        except Exception as e:  # noqa: BLE001
            set_box(c2, box_id, state="archived", error=str(e)[:500])
            log(f"resume {box_id} failed: {e}")
        finally:
            c2.close()
    threading.Thread(target=go, daemon=True).start()


def delete_box(con, box_id: str) -> None:
    r = box_row(con, box_id)
    if r["pinned"]:
        raise Fail(409, "sandbox_pinned", f"{box_id} is pinned; unpin it first")
    for c in con.execute("SELECT pid FROM commands WHERE box_id=? AND status IN ('queued','running')", (box_id,)):
        kill_cmd(con, box_id, c["pid"], lost=True)
    incus("delete", ct(box_id), "--force", timeout=300, check=False)
    con.execute("DELETE FROM snaps WHERE box_id=?", (box_id,))
    set_box(con, box_id, state="deleted", deleted_at=now())
    log(f"box {box_id} deleted")


# ---------------------------------------------------------------- saved snapshots

def saved_json(r) -> dict:
    return {"name": r["name"], "status": r["status"], "sourceSandboxId": r["source"], "snapshotId": r["snapshot_id"],
            "type": r["type"], "sizeBytes": r["size_bytes"], "createdAt": iso(r["created_at"]), "error": r["error"]}


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
            size = _instance_bytes(inst)
            prev = c2.execute("SELECT instance FROM saved WHERE owner=? AND name=?", key).fetchone()
            c2.execute("UPDATE saved SET instance=?, source=?, type=?, status='ready', error=NULL, size_bytes=?, "
                       "created_at=?, pending_instance=NULL WHERE owner=? AND name=?",
                       (inst, box_id, r["type"], size, now(), *key))
            if prev and prev["instance"] and prev["instance"] != inst:
                incus("delete", prev["instance"], "--force", timeout=300, check=False)
            log(f"saved {owner}/{name} <- {box_id} as {inst}")
        except Exception as e:  # noqa: BLE001
            incus("delete", inst, "--force", timeout=300, check=False)
            st = "ready" if old and old["instance"] else "failed"
            c2.execute("UPDATE saved SET status=?, error=?, pending_instance=NULL WHERE owner=? AND name=?",
                       (st, str(e)[:500], *key))
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


def start_cmd(con, box_id: str, body: dict, owner: str | None = None) -> dict:
    r = box_row(con, box_id, owner)
    if r["state"] not in LIVE:
        raise Fail(409, "machine_not_running", f"{box_id} is {r['state']}")
    command = body.get("command") or ""
    if not command:
        raise Fail(400, "invalid_command", "command is empty")
    meta = body.get("meta") or {}
    con.execute("BEGIN IMMEDIATE")
    pid = (con.execute("SELECT MAX(pid) FROM commands WHERE box_id=?", (box_id,)).fetchone()[0] or 1000) + 1
    cid = "cmd_" + secrets.token_hex(8)
    # retry_interrupted: if the host dies under this run, queue it again once (same id, next attempt). Only the
    # caller knows whether running it twice is safe, so the default is no.
    retry = 1 if body.get("retry_interrupted") is True else 0
    con.execute("INSERT INTO commands (box_id, pid, command_id, command, cwd, status, created_at, kind, repo, run_id, "
                "retry_interrupted, attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)",
                (box_id, pid, cid, command, body.get("cwd") or "/home/user", "queued", now(),
                 meta.get("kind") or guess_kind(command), meta.get("repo"), meta.get("run_id"), retry))
    con.execute("COMMIT")
    set_box(con, box_id, last_active=now())
    d = cmd_dir(box_id)
    for ext in ("out", "err"):
        (d / f"{pid}.{ext}").touch()
    err = spawn_runner(box_id, pid, 1)
    if err:
        con.execute("UPDATE commands SET status='exited', exit_code=127, ended_at=? WHERE box_id=? AND pid=?",
                    (now(), box_id, pid))
        raise Fail(500, "spawn_failed", err)
    return {"ok": True, "processId": pid, "commandId": cid, "pid": pid, "attempt": 1, "retryInterrupted": bool(retry)}


def guess_kind(command: str) -> str:
    m = re.search(r"\bOFFBOX_KIND=([\w.:/-]+)", command)
    if m:
        return m.group(1)[:80]
    return "cmd:" + (command.split() or ["?"])[0][:40]


def tail(path: Path, n: int) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - n))
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
            "attempt": r["attempt"] or 1, "retryInterrupted": bool(r["retry_interrupted"]),
            "interruptedAt": iso(r["interrupted_at"]), "bootId": boot_id(), "serverStartedAt": iso(STARTED),
            "stdout": tail(d / f"{pid}.out", tail_bytes), "stderr": tail(d / f"{pid}.err", tail_bytes),
            "metrics": json.loads(r["metrics"]) if r["metrics"] else None}


def _cg_pids(box_id: str, pid: int) -> list[int]:
    try:
        return [int(x) for x in (cg_path(box_id) / "boatd" / str(pid) / "cgroup.procs").read_text().split()]
    except (OSError, ValueError):
        return []


def kill_cmd(con, box_id: str, pid: int, lost: bool = False) -> None:
    r = con.execute("SELECT * FROM commands WHERE box_id=? AND pid=?", (box_id, pid)).fetchone()
    if not r or r["status"] not in ("queued", "running"):
        return
    (cmd_dir(box_id) / f"{pid}.kill").write_text("lost" if lost else "kill")
    for hp in _cg_pids(box_id, pid):
        try:
            os.kill(hp, signal.SIGTERM)
        except OSError:
            pass

    def later():
        time.sleep(10)
        kf = cg_path(box_id) / "boatd" / str(pid) / "cgroup.kill"
        try:
            kf.write_text("1")
        except OSError:
            pass
        time.sleep(5)
        subprocess.run(["systemctl", "stop", unit_name(box_id, pid, r["attempt"])], capture_output=True)
        c2 = db()
        try:
            c2.execute("UPDATE commands SET status=?, signal=COALESCE(signal,'SIGTERM'), ended_at=COALESCE(ended_at,?) "
                       "WHERE box_id=? AND pid=? AND status IN ('queued','running')",
                       ("lost" if lost else "exited", now(), box_id, pid))
        finally:
            c2.close()
    threading.Thread(target=later, daemon=True).start()


# ---------------------------------------------------------------- runner (boatd.py run <box> <pid>)

def mem_available() -> int:
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def predicted_peak(con, kind: str) -> int:
    rows = [json.loads(r[0]).get("box_mem_peak") or 0 for r in con.execute(
        "SELECT metrics FROM commands WHERE kind=? AND metrics IS NOT NULL ORDER BY ended_at DESC LIMIT 50", (kind,))]
    rows = sorted(x for x in rows if x)
    if len(rows) < 3:
        return int(CFG["default_peak_gb"] * 2**30)
    p95 = rows[min(len(rows) - 1, int(0.95 * len(rows)))]
    return int(p95 * 1.25)


def admitted_bytes(con) -> int:
    """Memory promised to runs that started in the last 60 s and may not have grown yet."""
    total = 0
    for r in con.execute("SELECT kind FROM commands WHERE status='running' AND started_at > ?", (now() - 60,)):
        total += predicted_peak(con, r["kind"])
    return total


ADMIT_LOCK = VAR / "admit.lock"


def admit(con, box_id: str, pid: int, kind: str, errf) -> float:
    """Wait until the host has room for this run's predicted peak. Returns seconds queued."""
    need = predicted_peak(con, kind)
    reserve = int(CFG["mem_reserve_gb"] * 2**30)
    t0 = now()
    said = False
    while True:
        if (cmd_dir(box_id) / f"{pid}.kill").exists():
            return now() - t0
        with open(ADMIT_LOCK, "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            free = mem_available() - reserve - admitted_bytes(con)
            # Oldest first, so a run queued again after a restart goes before runs submitted after it.
            head = con.execute("SELECT box_id, pid FROM commands WHERE status='queued' ORDER BY created_at, box_id, pid "
                               "LIMIT 1").fetchone()
            mine = head is None or (head["box_id"] == box_id and head["pid"] == pid)
            cap = int(CFG.get("max_running") or 0)
            room = not cap or con.execute("SELECT COUNT(*) FROM commands WHERE status='running'").fetchone()[0] < cap
            if (mine and room and free >= need) or now() - t0 > 3600:
                con.execute("UPDATE commands SET status='running', started_at=?, queued_s=?, boot_id=? "
                            "WHERE box_id=? AND pid=?", (now(), now() - t0, boot_id(), box_id, pid))
                return now() - t0
        if not said:
            why = "for earlier runs in the queue" if not (mine and room) else \
                (f"for memory (this kind peaks ~{need / 2**30:.1f} GB, {max(0, free) / 2**30:.1f} GB free "
                 "after reserve)")
            errf.write(f"offbox-server: waiting {why}\n".encode())
            errf.flush()
            said = True
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


def run_cmd(box_id: str, pid: int) -> int:
    load_cfg()
    con = db()
    r = cmd_row(con, box_id, pid)
    attempt = r["attempt"] or 1
    d = cmd_dir(box_id)
    outf = open(d / f"{pid}.out", "ab", buffering=0)
    errf = open(d / f"{pid}.err", "ab", buffering=0)
    queued = admit(con, box_id, pid, r["kind"], errf)
    code, sig = None, None
    t0 = now()
    try:
        if (d / f"{pid}.kill").exists():
            code, sig = 143, "SIGTERM"
        else:
            ct_exec(box_id, f"mkdir -p /run/boatd && cat > /run/boatd/{pid}.sh && chmod 600 /run/boatd/{pid}.sh",
                    input=r["command"].encode(), timeout=60)
            p = subprocess.run(["incus", "exec", ct(box_id), "--", "/usr/local/sbin/boatd-wrap", str(pid),
                                r["cwd"] or "/home/user"], stdin=subprocess.DEVNULL, stdout=outf, stderr=errf)
            code = p.returncode
            if code is not None and code < 0:
                sig, code = signal.Signals(-code).name, 128 - code
    except Exception as e:  # noqa: BLE001
        errf.write(f"\noffbox-server: command failed to start: {e}\n".encode())
        code = 125
    t1 = now()
    kill = (d / f"{pid}.kill").read_text() if (d / f"{pid}.kill").exists() else None
    if kill and code in (137, 143, 255, None):
        sig = sig or ("SIGKILL" if code == 137 else "SIGTERM")
    status = "lost" if kill == "lost" or (code == 255 and not ct_running(box_id)) else "exited"
    # The result goes to disk first: if boatd or this runner is gone before the database has it, the next
    # reconcile finalizes the run from this file instead of calling it interrupted.
    write_json(result_path(box_id, pid), {"attempt": attempt, "status": status, "exit_code": code, "signal": sig,
                                          "started_at": t0, "ended_at": t1, "boot_id": boot_id()})
    m = read_cg(cg_path(box_id) / "boatd" / str(pid))
    try:
        (cg_path(box_id) / "boatd" / str(pid)).rmdir()
    except OSError:
        pass
    m.update(box_window(con, box_id, t0, t1))
    m["wall_s"] = round(t1 - t0, 2)
    m["queued_s"] = round(queued, 2)
    con.execute("UPDATE commands SET status=?, exit_code=?, signal=?, ended_at=?, metrics=? WHERE box_id=? AND pid=? "
                "AND attempt=?", (status, code, sig, t1, json.dumps(m), box_id, pid, attempt))
    con.execute("UPDATE boxes SET last_active=?, updated_at=? WHERE id=?", (now(), now(), box_id))
    ct_exec(box_id, f"rm -f /run/boatd/{pid}.sh", timeout=30, check=False)
    # Snapshot after every run, on the server. Instant on ZFS; retention trims old ones.
    if ct_running(box_id):
        snapshot(con, box_id, "auto")
        prune_snaps(con, box_id)
    return 0


# ---------------------------------------------------------------- reconcile (every start, and for orphans later)

def _note(box_id: str, pid: int, text: str) -> None:
    try:
        with open(cmd_dir(box_id) / f"{pid}.err", "ab") as f:
            f.write(f"\noffbox-server: {text}\n".encode())
    except OSError:
        pass


def settle_cmd(con, c) -> str:
    """One command the database calls queued or running. Returns what was done:
    following   its unit is alive (boatd alone restarted): nothing to do, its output keeps landing in the files
    finalized   the unit ended while nobody recorded it: exit code from its result file, snapshot taken
    killed      it was being killed when its unit went away
    requeue     it never started: still queued, needs a runner again
    retry       it was running, the unit is gone with no result, and it may be retried: queued again, next attempt
    interrupted same, but not to be retried (or already retried once): final"""
    box_id, pid, attempt = c["box_id"], c["pid"], c["attempt"] or 1
    if unit_active(unit_name(box_id, pid, attempt)):
        return "following"
    res = read_result(box_id, pid, attempt)
    t = now()
    if res:
        m = {"wall_s": round((res.get("ended_at") or t) - (res.get("started_at") or t), 2),
             "queued_s": c["queued_s"], "recovered": True}
        con.execute("UPDATE commands SET status=?, exit_code=?, signal=?, ended_at=?, metrics=COALESCE(metrics, ?) "
                    "WHERE box_id=? AND pid=?", (res.get("status") or "exited", res.get("exit_code"),
                                                 res.get("signal"), res.get("ended_at") or t, json.dumps(m),
                                                 box_id, pid))
        b = con.execute("SELECT state FROM boxes WHERE id=? AND deleted_at IS NULL", (box_id,)).fetchone()
        if b and b["state"] in LIVE:
            snapshot(con, box_id, "auto")
            prune_snaps(con, box_id)
        return "finalized"
    kf = cmd_dir(box_id) / f"{pid}.kill"
    if kf.exists():
        lost = kf.read_text().strip() == "lost"
        con.execute("UPDATE commands SET status=?, signal=COALESCE(signal,'SIGTERM'), exit_code=COALESCE(exit_code,143), "
                    "ended_at=? WHERE box_id=? AND pid=?", ("lost" if lost else "exited", t, box_id, pid))
        return "killed"
    if c["status"] == "queued":
        return "requeue"
    if c["retry_interrupted"] and attempt < MAX_ATTEMPTS:
        _note(box_id, pid, f"the server restarted while this run was going (attempt {attempt} is lost); "
                           f"it is queued again as attempt {attempt + 1}")
        con.execute("UPDATE commands SET status='queued', attempt=?, started_at=NULL, queued_s=NULL, boot_id=NULL, "
                    "interrupted_at=? WHERE box_id=? AND pid=?", (attempt + 1, t, box_id, pid))
        return "retry"
    _note(box_id, pid, "the server restarted while this run was going; it did not finish and is not run again")
    con.execute("UPDATE commands SET status='interrupted', ended_at=?, interrupted_at=? WHERE box_id=? AND pid=?",
                (t, t, box_id, pid))
    return "interrupted"


def drop_cmd(con, box_id: str, pid: int, why: str) -> None:
    _note(box_id, pid, why)
    con.execute("UPDATE commands SET status='interrupted', ended_at=?, interrupted_at=? WHERE box_id=? AND pid=? "
                "AND status IN ('queued','running')", (now(), now(), box_id, pid))


def start_container(box_id: str) -> str | None:
    """Bring a box the database calls live back up (after a host restart). Returns the error text, or None."""
    c2 = db()
    try:
        r = box_row(c2, box_id)
        if not ct_running(box_id):
            apply_size(box_id, r["type"])
            _ensure_proxy(box_id, r["ssh_port"])
            incus("start", ct(box_id), timeout=300)
        _wait_boot(box_id)
        set_box(c2, box_id, state="ready", last_active=now(), error=None)
        return None
    except Exception as e:  # noqa: BLE001
        set_box(c2, box_id, state="archived", stopped_at=now(), error=f"did not start after a server restart: {e}"[:500])
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


def reconcile(con) -> dict:
    """Run at every boatd start, before the API answers. Brings database, systemd units and containers back in
    line after a boatd restart or a host crash. Safe to run twice."""
    out = {"following": 0, "finalized": 0, "killed": 0, "requeue": 0, "retry": 0, "interrupted": 0,
           "boxes_started": 0, "boxes_failed": 0, "cleaned": []}
    boxes = {r["id"]: r for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall()}
    # 1. A box whose creation was cut short: nothing useful is in it. Remove the half-made container; the row
    # stays as an error so the client that asked for it gets a clear answer.
    for bid, r in boxes.items():
        if r["state"] == "provisioning":
            incus("delete", ct(bid), "--force", timeout=300, check=False)
            set_box(con, bid, state="error", error="creation was interrupted by a server restart; create it again")
            out["cleaned"].append(f"half-created box {bid}")
    # 2. Saved states whose copy was cut short: remove exactly that copy, keep the previous one.
    for sv in con.execute("SELECT * FROM saved WHERE status='pending'").fetchall():
        if sv["pending_instance"]:
            incus("delete", sv["pending_instance"], "--force", timeout=300, check=False)
        con.execute("UPDATE saved SET status=?, error=?, pending_instance=NULL WHERE owner=? AND name=?",
                    ("ready" if sv["instance"] else "failed", "interrupted by a server restart; save again",
                     sv["owner"], sv["name"]))
        out["cleaned"].append(f"half-made saved state {sv['owner']}/{sv['name']}")
    # 3. Runs.
    spawn = []
    for c in con.execute("SELECT * FROM commands WHERE status IN ('queued','running') ORDER BY created_at, box_id, "
                         "pid").fetchall():
        act = settle_cmd(con, c)
        out[act] += 1
        if act in ("requeue", "retry"):
            spawn.append((c["box_id"], c["pid"]))
    # 4. Containers: what the database calls live runs; a stop that was under way is finished; stopped stays stopped.
    boxes = {r["id"]: r for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall()}
    want = [bid for bid, r in boxes.items() if r["state"] in LIVE + ("resuming",)]
    errs: dict[str, str | None] = {}
    threads = []
    for bid in want:
        th = threading.Thread(target=lambda b=bid: errs.__setitem__(b, start_container(b)), daemon=True)
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
                stop_box(con, bid, "finishing a stop cut short by a restart")
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
    """Established TCP connections on the box's port 22 (offbox tunnels and ssh keep a box warm, like boat)."""
    st = ct_state(box_id)
    p = st.get("pid")
    n = 0
    for f in ("tcp", "tcp6"):
        try:
            for line in Path(f"/proc/{p}/net/{f}").read_text().splitlines()[1:]:
                parts = line.split()
                if parts[1].endswith(":0016") and parts[3] == "01":
                    n += 1
        except (OSError, IndexError):
            pass
    return n


def reap_once(con) -> None:
    t = now()
    for r in con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL").fetchall():
        bid = r["id"]
        if r["state"] in LIVE:
            busy = con.execute("SELECT COUNT(*) FROM commands WHERE box_id=? AND status IN ('queued','running')",
                               (bid,)).fetchone()[0]
            if busy or ssh_sessions(bid):
                set_box(con, bid, last_active=t)
                continue
            if r["ttl"] and t > (r["last_active"] or r["updated_at"]) + r["ttl"]:
                try:
                    stop_box(con, bid, "idle ttl")
                except Exception as e:  # noqa: BLE001
                    log(f"idle stop {bid} failed: {e}")
        elif r["state"] == "archived" and not r["pinned"] and r["owner"] not in (CFG.get("person_owners") or []):
            # A person's box is never deleted for being unused: it is where her data lives.
            used = con.execute("SELECT 1 FROM saved WHERE source=? AND status='ready'", (bid,)).fetchone()
            if not used and t - (r["stopped_at"] or t) > CFG["prune_unused_days"] * 86400:
                try:
                    delete_box(con, bid)
                except Exception as e:  # noqa: BLE001
                    log(f"prune {bid} failed: {e}")
        elif r["state"] == "error" and t - (r["updated_at"] or t) > 86400:
            try:
                delete_box(con, bid)
            except Exception as e:  # noqa: BLE001
                log(f"prune {bid} failed: {e}")
    # Commands whose runner went away without recording an exit: same rules as at start-up.
    for c in con.execute("SELECT * FROM commands WHERE status IN ('queued','running') AND created_at < ? AND "
                         "COALESCE(interrupted_at, 0) < ?", (t - 30, t - 30)).fetchall():
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
        return float(line.split("avg10=")[1].split()[0])
    except (OSError, IndexError, ValueError):
        return None


def box_mem(box_id: str) -> int | None:
    """Memory a box can't give back: anon + shmem (page cache is reclaimable and would overstate needs)."""
    try:
        st = dict(line.split() for line in (cg_path(box_id) / "memory.stat").read_text().splitlines())
        return int(st.get("anon", 0)) + int(st.get("shmem", 0))
    except (OSError, ValueError):
        return None


def sample_once(con) -> None:
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


def loop(fn, every: float, name: str) -> None:
    while True:
        con = db()
        try:
            fn(con)
        except Exception:  # noqa: BLE001
            log(f"{name}: {traceback.format_exc()[-800:]}")
        finally:
            con.close()
        time.sleep(every)


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

    def _err(self, status: int, code: str, message: str) -> None:
        self._send(status, {"ok": False, "code": code, "message": message,
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
            return self._send(200, health())
        if not READY.is_set():
            # No pool or still reconciling: nothing but /health is answered, so no caller sees half-settled runs.
            return self._err(503, "server_not_ready", STATE["problem"] or "starting")
        con = db()
        try:
            who = token_auth(con, self.headers.get("Authorization"))
            if not who:
                return self._err(401, "unauthorized", "bad token")
            owner, admin = who
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
            self._err(e.status, e.code, e.message)
        except Exception as e:  # noqa: BLE001
            log(f"{method} {path}: {traceback.format_exc()[-1200:]}")
            self._err(500, "internal", str(e)[:300])
        finally:
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
            return {"ok": True, "type": "limits.info", "canStart": True, "startBlockedReason": None,
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
                if "labels" in b:
                    kw["labels"] = json.dumps(b["labels"])
                if kw:
                    set_box(con, bid, **kw)
                return {"ok": True, "sandbox": box_json(con, box_row(con, bid))}
            if method == "DELETE":
                if self.headers.get("X-Ascii-Confirm-Delete") != bid:
                    raise Fail(400, "confirm_required", "X-Ascii-Confirm-Delete must name the box")
                delete_box(con, bid)
                return {"ok": True, "deleted": bid}
            raise Fail(405, "method_not_allowed", method)
        op = rest[0]
        if op == "fork" and method == "POST":
            b = self._body()
            return {"ok": True, "sandbox": create_box(con, b, self.headers.get("Idempotency-Key"), owner, src_box=bid)}
        if op == "resume" and method == "POST":
            resume_box(con, bid, self._body())
            return {"ok": True, "sandbox": box_json(con, box_row(con, bid))}
        if op == "stop" and method == "POST":
            box_row(con, bid)
            threading.Thread(target=lambda: _bg(stop_box, bid, "api"), daemon=True).start()
            set_box(con, bid, state="stopping")
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
                    data = f.read(1 << 20)
                data, nxt = _utf8_cut(data, off)
                return {"ok": True, "data": data, "nextOffset": nxt,
                        "done": r["status"] not in ("queued", "running") and nxt >= p.stat().st_size}
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
                incus("delete", r["instance"], "--force", timeout=300, check=False)
            con.execute("DELETE FROM saved WHERE owner=? AND name=?", (owner, name))
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
        return {"ok": True, "sshEndpoint": f"{CFG['ssh_host']}:{r['ssh_port']}", "hostKey": f"{hk[0]} {hk[1]}",
                "sshUser": "user"}

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
                    return st
                time.sleep(0.3)
            kill_cmd(con, bid, r["processId"])
            raise Fail(408, "command_timeout", f"command {r['processId']} timed out")
        if not rest:
            raise Fail(405, "method_not_allowed", method)
        pid = int(rest[0])
        if len(rest) == 1 and method == "GET":
            return cmd_status_json(con, bid, pid, int(q.get("tailBytes") or 4096))
        if len(rest) == 1 and method == "DELETE":
            cmd_row(con, bid, pid)
            kill_cmd(con, bid, pid)
            return {"ok": True, "processId": pid}
        if rest[1:] == ["stream"] and method == "GET":
            self._stream(con, bid, pid, int(q.get("stdoutOffset") or 0), int(q.get("stderrOffset") or 0))
            return None
        raise Fail(404, "not_found", "/".join(rest))

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
        emit({"type": "hello", "attempt": attempt, "bootId": boot_id(), "serverStartedAt": iso(STARTED)})
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
                if sent:
                    continue
                r = con.execute("SELECT status, exit_code, signal, attempt FROM commands WHERE box_id=? AND pid=?",
                                (bid, pid)).fetchone()
                if (r["attempt"] or 1) != attempt:
                    attempt = r["attempt"] or 1
                    emit({"type": "attempt", "attempt": attempt})
                if r["status"] not in ("queued", "running"):
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
                              "status": r["status"], "attempt": attempt})
                        break
                    continue
                if now() - started > 600:
                    emit({"type": "reconnect", "stdoutOffset": offs["out"], "stderrOffset": offs["err"]})
                    break
                if now() - last_beat > 15:
                    emit({"type": "heartbeat"})
                    last_beat = now()
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
    for i in range(60):
        if _sh(["incus", "query", "/1.0"], timeout=10)[0] == 0:
            break
        STATE["problem"] = "waiting for incus"
        if i % 10 == 0:
            _sh(["systemctl", "start", "incus.socket", "incus.service"], timeout=60)
        time.sleep(2)
    while True:
        try:
            STATE["problem"] = "reconciling runs and boxes after start"
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
    log(f"reconciled: {json.dumps(STATE['reconcile'])}")
    STATE["problem"] = None
    READY.set()
    threading.Thread(target=loop, args=(reap_once, 15, "reaper"), daemon=True).start()
    threading.Thread(target=loop, args=(sample_once, CFG["sample_s"], "sampler"), daemon=True).start()


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
            box_row(con, a[2])
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
