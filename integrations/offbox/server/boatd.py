#!/usr/bin/env python3
"""boatd: our own offbox server. Answers the boat.dev REST calls offbox makes (offbox_lib/api.py), backed by Incus
system containers on ZFS on one Hetzner box. Every box is a container `bx-xxxxxxxx`; offbox sees id `bx_xxxxxxxx`.

  boatd.py serve            HTTP API (tailnet only) + reaper (idle stop, snapshot retention) + metrics sampler
  boatd.py run <box> <pid>  one command, started by `serve` through systemd-run so it outlives boatd restarts
  boatd.py stats [--days N] per-kind resource report (also GET /api/v1/stats)

State: /var/lib/boatd/boatd.db (SQLite, WAL). Command logs: /var/lib/boatd/cmds/<box>/<pid>.{out,err,json}.
Auth: Bearer token in /etc/boatd/token. Config: /etc/boatd/config.json (see DEFAULTS).
Stdlib only (Python 3.12, Ubuntu 24.04)."""

from __future__ import annotations

import datetime as dt
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
    "keep_auto": 20, "keep_daily_days": 14,
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


def init_db() -> None:
    VAR.mkdir(parents=True, exist_ok=True)
    CMDS.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)


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


def box_row(con, box_id: str):
    r = con.execute("SELECT * FROM boxes WHERE id=? AND deleted_at IS NULL", (box_id,)).fetchone()
    if not r:
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
    """A copied box gets its own ssh host keys and hostname, and drops the source's authorized key list."""
    ct_exec(box_id, "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null 2>&1; "
                    f"hostnamectl set-hostname {ct(box_id)} 2>/dev/null || echo {ct(box_id)} > /etc/hostname; "
                    "systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true", timeout=60)


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


def create_box(con, body: dict, idem: str | None, src_box: str | None = None) -> dict:
    if idem:
        r = con.execute("SELECT box_id FROM idem WHERE key=?", (idem,)).fetchone()
        if r:
            return box_json(con, box_row(con, r["box_id"]))
    t = size_of(body.get("type") or (src_box and box_row(con, src_box)["type"]))
    if src_box:
        box_row(con, src_box)
        source = ("box", src_box)
        src_label = src_box
    elif body.get("from"):
        s = con.execute("SELECT * FROM saved WHERE name=?", (body["from"],)).fetchone()
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
    con.execute("INSERT INTO boxes (id, name, type, state, ttl, last_active, created_at, updated_at, ssh_port, source) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", (bid, (body.get("name") or bid)[:120], t, "provisioning",
                                                 int(body.get("ttlSeconds") or 1200), t0, t0, t0, next_ssh_port(con),
                                                 src_label))
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


def prune_snaps(con, box_id: str) -> None:
    rows = con.execute("SELECT * FROM snaps WHERE box_id=? ORDER BY created_at DESC", (box_id,)).fetchall()
    keep = set(r["name"] for r in rows[:CFG["keep_auto"]])
    days: dict[str, str] = {}
    cutoff = now() - CFG["keep_daily_days"] * 86400
    for r in rows:  # newest first: the first one seen on a day is that day's last
        day = iso(r["created_at"])[:10]
        if r["created_at"] >= cutoff and day not in days:
            days[day] = r["name"]
    keep |= set(days.values())
    for r in rows:
        if r["name"] in keep:
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


def save_box(con, box_id: str, name: str) -> dict:
    r = box_row(con, box_id)
    inst = "sv-" + hashlib.sha1(f"{name}:{now()}".encode()).hexdigest()[:12]
    old = con.execute("SELECT * FROM saved WHERE name=?", (name,)).fetchone()
    snap_id = secrets.token_hex(8)
    if old:
        con.execute("UPDATE saved SET status='pending', snapshot_id=? WHERE name=?", (snap_id, name))
    else:
        con.execute("INSERT INTO saved VALUES (?,?,?,?,?,?,?,?,?)",
                    (name, None, box_id, r["type"], "pending", None, None, now(), snap_id))

    def go():
        c2 = db()
        try:
            incus("copy", ct(box_id), inst, "--instance-only", "--stateless", timeout=900)
            size = _instance_bytes(inst)
            prev = c2.execute("SELECT instance FROM saved WHERE name=?", (name,)).fetchone()
            c2.execute("UPDATE saved SET instance=?, source=?, type=?, status='ready', error=NULL, size_bytes=?, "
                       "created_at=? WHERE name=?", (inst, box_id, r["type"], size, now(), name))
            if prev and prev["instance"] and prev["instance"] != inst:
                incus("delete", prev["instance"], "--force", timeout=300, check=False)
            log(f"saved {name} <- {box_id} as {inst}")
        except Exception as e:  # noqa: BLE001
            st = "ready" if old and old["instance"] else "failed"
            c2.execute("UPDATE saved SET status=?, error=? WHERE name=?", (st, str(e)[:500], name))
            log(f"save {name} failed: {e}")
        finally:
            c2.close()
    threading.Thread(target=go, daemon=True).start()
    return saved_json(con.execute("SELECT * FROM saved WHERE name=?", (name,)).fetchone())


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
        _ZPOOL = p.stdout.decode().strip() or "offbox"
    return _ZPOOL


# ---------------------------------------------------------------- commands

def cmd_dir(box_id: str) -> Path:
    d = CMDS / box_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def cmd_row(con, box_id: str, pid: int):
    r = con.execute("SELECT * FROM commands WHERE box_id=? AND pid=?", (box_id, pid)).fetchone()
    if not r:
        raise Fail(404, "command_not_found", f"no command {pid} on {box_id}")
    return r


def start_cmd(con, box_id: str, body: dict) -> dict:
    r = box_row(con, box_id)
    if r["state"] not in LIVE:
        raise Fail(409, "machine_not_running", f"{box_id} is {r['state']}")
    command = body.get("command") or ""
    if not command:
        raise Fail(400, "invalid_command", "command is empty")
    meta = body.get("meta") or {}
    con.execute("BEGIN IMMEDIATE")
    pid = (con.execute("SELECT MAX(pid) FROM commands WHERE box_id=?", (box_id,)).fetchone()[0] or 1000) + 1
    cid = "cmd_" + secrets.token_hex(8)
    con.execute("INSERT INTO commands (box_id, pid, command_id, command, cwd, status, created_at, kind, repo, run_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", (box_id, pid, cid, command, body.get("cwd") or "/home/user",
                                                 "queued", now(), meta.get("kind") or guess_kind(command),
                                                 meta.get("repo"), meta.get("run_id")))
    con.execute("COMMIT")
    set_box(con, box_id, last_active=now())
    d = cmd_dir(box_id)
    for ext in ("out", "err"):
        (d / f"{pid}.{ext}").touch()
    unit = f"boatd-cmd-{ct(box_id)}-{pid}"
    p = subprocess.run(["systemd-run", "--unit", unit, "--collect", "--quiet", "-p", "KillMode=mixed", "-E", "HOME=/root",
                        "-p", "TimeoutStopSec=30", sys.executable, str(SELF), "run", box_id, str(pid)],
                       capture_output=True, text=True)
    if p.returncode != 0:
        con.execute("UPDATE commands SET status='exited', exit_code=127, ended_at=? WHERE box_id=? AND pid=?",
                    (now(), box_id, pid))
        raise Fail(500, "spawn_failed", p.stderr[-300:])
    return {"ok": True, "processId": pid, "commandId": cid, "pid": pid}


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
        subprocess.run(["systemctl", "stop", f"boatd-cmd-{ct(box_id)}-{pid}"], capture_output=True)
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
    import fcntl
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
            if free >= need or now() - t0 > 3600:
                con.execute("UPDATE commands SET status='running', started_at=?, queued_s=? WHERE box_id=? AND pid=?",
                            (now(), now() - t0, box_id, pid))
                return now() - t0
        if not said:
            errf.write(f"offbox-server: waiting for memory (this kind peaks ~{need / 2**30:.1f} GB, "
                       f"{max(0, free) / 2**30:.1f} GB free after reserve)\n".encode())
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
    m = read_cg(cg_path(box_id) / "boatd" / str(pid))
    try:
        (cg_path(box_id) / "boatd" / str(pid)).rmdir()
    except OSError:
        pass
    m.update(box_window(con, box_id, t0, t1))
    m["wall_s"] = round(t1 - t0, 2)
    m["queued_s"] = round(queued, 2)
    con.execute("UPDATE commands SET status=?, exit_code=?, signal=?, ended_at=?, metrics=? WHERE box_id=? AND pid=?",
                (status, code, sig, t1, json.dumps(m), box_id, pid))
    con.execute("UPDATE boxes SET last_active=?, updated_at=? WHERE id=?", (now(), now(), box_id))
    ct_exec(box_id, f"rm -f /run/boatd/{pid}.sh", timeout=30, check=False)
    # Snapshot after every run, on the server. Instant on ZFS; retention trims old ones.
    if ct_running(box_id):
        snapshot(con, box_id, "auto")
        prune_snaps(con, box_id)
    return 0


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
        elif r["state"] == "archived" and not r["pinned"]:
            used = con.execute("SELECT 1 FROM saved WHERE source=? AND status='ready'", (bid,)).fetchone()
            if not used and t - (r["stopped_at"] or t) > CFG["prune_unused_days"] * 86400:
                try:
                    delete_box(con, bid)
                except Exception as e:  # noqa: BLE001
                    log(f"prune {bid} failed: {e}")
    # Commands whose runner died without recording an exit.
    for c in con.execute("SELECT * FROM commands WHERE status IN ('queued','running') AND created_at < ?",
                         (t - 30,)).fetchall():
        unit = f"boatd-cmd-{ct(c['box_id'])}-{c['pid']}"
        p = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True)
        if p.stdout.strip() not in ("active", "activating", "deactivating"):
            con.execute("UPDATE commands SET status='lost', ended_at=? WHERE box_id=? AND pid=? AND status IN "
                        "('queued','running')", (t, c["box_id"], c["pid"]))
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


def stats(con, days: float = 14) -> dict:
    since = now() - days * 86400
    kinds: dict[str, list] = {}
    for r in con.execute("SELECT c.kind, c.repo, c.metrics, b.type FROM commands c JOIN boxes b ON b.id=c.box_id "
                         "WHERE c.ended_at > ? AND c.metrics IS NOT NULL", (since,)):
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
    waits = con.execute("SELECT COUNT(*) FROM commands WHERE ended_at > ? AND queued_s > 5", (since,)).fetchone()[0]
    total = con.execute("SELECT COUNT(*) FROM commands WHERE ended_at > ?", (since,)).fetchone()[0]
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

    def _auth(self) -> bool:
        tok = (ETC / "token").read_text().strip()
        got = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        return bool(tok) and hmac.compare_digest(tok, got)

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
            return self._send(200, {"ok": True})
        if not self._auth():
            return self._err(401, "unauthorized", "bad token")
        con = db()
        try:
            out = self._dispatch(con, method, path, q)
            if out is not None:
                self._send(200, out)
        except Fail as e:
            self._err(e.status, e.code, e.message)
        except Exception as e:  # noqa: BLE001
            log(f"{method} {path}: {traceback.format_exc()[-1200:]}")
            self._err(500, "internal", str(e)[:300])
        finally:
            con.close()

    def _dispatch(self, con, method: str, path: str, q: dict):
        parts = [p for p in path.split("/") if p]
        if path == "/limits" and method == "GET":
            n = con.execute("SELECT COUNT(*) FROM boxes WHERE deleted_at IS NULL AND state IN ('ready','running')"
                            ).fetchone()[0]
            return {"ok": True, "type": "limits.info", "canStart": True, "startBlockedReason": None,
                    "activeSandboxes": n, "maxActiveSandboxes": 1000, "creditUsedSeconds": 0,
                    "creditSecondsPerDollar": 100000, "subscriptionQuotaSeconds": 0,
                    "subscriptionRemainingSeconds": 0, "subscriptionCurrentPeriodEnd": "2099-01-01T00:00:00.000Z",
                    "subscriptionStatus": "own-server", "sandboxPlanKey": "offbox-server", "packBalanceDollars": 0,
                    "last24hUsageSeconds": 0, "startLimits": {"perMinute": 1000, "perHour": 100000, "perDay": 1000000},
                    "machineTypes": [{"type": t, "available": True, "reason": None} for t in CFG["sizes"]],
                    "host": dict(con.execute("SELECT * FROM host_samples ORDER BY ts DESC LIMIT 1").fetchone() or {})}
        if path == "/stats" and method == "GET":
            return {"ok": True, **stats(con, float(q.get("days") or 14))}
        if parts[:1] == ["saved-snapshots"]:
            return self._saved(con, method, parts[1:])
        if parts[:1] != ["sandboxes"]:
            raise Fail(404, "not_found", path)
        if len(parts) == 1:
            if method == "GET":
                rows = con.execute("SELECT * FROM boxes WHERE deleted_at IS NULL ORDER BY created_at").fetchall()
                boxes = [box_json(con, r) for r in rows]
                if q.get("state"):
                    boxes = [b for b in boxes if b["state"] == q["state"]]
                return {"ok": True, "type": "sandbox.list", "sandboxes": boxes,
                        "pageInfo": {"nextCursor": None, "hasMore": False, "limit": len(boxes)}}
            if method == "POST":
                b = self._body()
                return {"ok": True, "type": "sandbox.created",
                        "sandbox": create_box(con, b, self.headers.get("Idempotency-Key"))}
        bid = parts[1]
        rest = parts[2:]
        if not rest:
            if method == "GET":
                return {"ok": True, "type": "sandbox.info", "sandbox": box_json(con, box_row(con, bid))}
            if method == "PATCH":
                b = self._body()
                box_row(con, bid)
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
        op = rest[0]
        if op == "fork" and method == "POST":
            b = self._body()
            return {"ok": True, "sandbox": create_box(con, b, self.headers.get("Idempotency-Key"), src_box=bid)}
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
                "createdAt": iso(s["created_at"]), "completedAt": iso(s["created_at"]),
                "hostPath": f"/var/lib/incus/storage-pools/{CFG['pool']}/containers/{ct(bid)}/.zfs/snapshot/"
                            f"snapshot-{s['name']}/rootfs"}}
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

    def _saved(self, con, method: str, rest: list[str]):
        if not rest:
            if method == "GET":
                rows = con.execute("SELECT * FROM saved ORDER BY created_at").fetchall()
                return {"ok": True, "type": "snapshot.saved.list", "snapshots": [saved_json(r) for r in rows],
                        "allowance": {"included": 10000, "free": 10000, "used": len(rows), "extra": 0}}
            if method == "POST":
                b = self._body()
                if not b.get("name") or not b.get("sandboxId"):
                    raise Fail(400, "invalid_request", "name and sandboxId are required")
                return {"ok": True, "snapshot": save_box(con, b["sandboxId"], b["name"])}
        name = urllib.parse.unquote(rest[0])
        r = con.execute("SELECT * FROM saved WHERE name=?", (name,)).fetchone()
        if method == "GET":
            if not r:
                raise Fail(404, "snapshot_not_found", name)
            return {"ok": True, "snapshot": saved_json(r)}
        if method == "DELETE":
            if not r:
                raise Fail(404, "snapshot_not_found", name)
            if r["instance"]:
                incus("delete", r["instance"], "--force", timeout=300, check=False)
            con.execute("DELETE FROM saved WHERE name=?", (name,))
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
                r = con.execute("SELECT status, exit_code, signal FROM commands WHERE box_id=? AND pid=?",
                                (bid, pid)).fetchone()
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
                              "status": r["status"]})
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


def serve() -> None:
    load_cfg()
    init_db()
    con = db()
    # Boxes caught mid-transition by a restart.
    for r in con.execute("SELECT id, state FROM boxes WHERE deleted_at IS NULL AND state IN "
                         "('provisioning','resuming','stopping')").fetchall():
        set_box(con, r["id"], state="ready" if ct_running(r["id"]) else
                ("archived" if r["state"] != "provisioning" else "error"))
    con.close()
    threading.Thread(target=loop, args=(reap_once, 15, "reaper"), daemon=True).start()
    threading.Thread(target=loop, args=(sample_once, CFG["sample_s"], "sampler"), daemon=True).start()
    srv = ThreadingHTTPServer((CFG["listen"], CFG["port"]), Handler)
    srv.daemon_threads = True
    log(f"boatd listening on {CFG['listen']}:{CFG['port']}")
    srv.serve_forever()


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] == "serve":
        serve()
        return 0
    if a[0] == "run":
        return run_cmd(a[1], int(a[2]))
    if a[0] == "stats":
        load_cfg()
        days = float(a[a.index("--days") + 1]) if "--days" in a else 14
        print(json.dumps(stats(db(), days), indent=1))
        return 0
    if a[0] == "snap-mount":
        # Read-only mount of a box snapshot (latest if none named) for backups: prints the mount path.
        load_cfg()
        con = db()
        name = a[2] if len(a) > 2 else (latest_snap(con, a[1]) or {"name": None})["name"]
        if not name:
            print("no snapshot", file=sys.stderr)
            return 1
        mnt = Path("/run/boatd-snap") / a[1]
        subprocess.run(["umount", str(mnt)], capture_output=True)
        mnt.mkdir(parents=True, exist_ok=True)
        ds = f"{zpool()}/containers/{ct(a[1])}@snapshot-{name}"
        p = subprocess.run(["mount", "-t", "zfs", "-o", "ro", ds, str(mnt)], capture_output=True, text=True)
        if p.returncode != 0:
            print(p.stderr, file=sys.stderr)
            return 1
        print(f"{mnt}/rootfs")
        return 0
    if a[0] == "snap-umount":
        mnt = Path("/run/boatd-snap") / a[1]
        subprocess.run(["umount", str(mnt)], capture_output=True)
        try:
            mnt.rmdir()
        except OSError:
            pass
        return 0
    if a[0] == "pin":
        load_cfg()
        con = db()
        set_box(con, a[1], pinned=0 if "--off" in a else 1)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
