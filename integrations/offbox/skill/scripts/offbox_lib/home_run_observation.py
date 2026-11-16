"""Dated remote observations distinguish a health flap from a run changing backends."""
import datetime as dt
import math

from . import common


KINDS = {"accepted", "queued", "running", "stream connected", "stream heartbeat", "output received",
         "done", "failed", "exited", "killed", "interrupted", "lost"}


def observe(run_id, kind):
    if common.backend() != "server" or not run_id or kind not in KINDS:
        return
    try:
        common.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        common.atomic_write_json(common.LOGS_DIR / f"{run_id}.home-read.json",
                                 {"at": common.now(), "kind": kind})
    except OSError:
        pass


def stamp(at):
    return dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def notice(row, *, backend=None, emit=None):
    row = dict(row)
    if (backend or common.backend()) != "server" or row.get("mode") == "local":
        return
    if row.get("status") not in ("starting", "running"):
        return
    monitor = common.home_state()
    if monitor.get("state") not in ("home_down", "home_slow"):
        return
    run_id = row["run_id"]
    read = common.read_json(common.LOGS_DIR / f"{run_id}.home-read.json", {})
    at = read.get("at") if isinstance(read, dict) else None
    kind = read.get("kind") if isinstance(read, dict) else None
    if type(at) in (float, int) and math.isfinite(at) and at > 0 and kind in KINDS:
        evidence = f"last good run read: {kind} at {stamp(at)}"
    elif type(row.get("command_at")) in (float, int) and row.get("process_id") and math.isfinite(row["command_at"]):
        evidence = f"last good run read: command accepted at {stamp(row['command_at'])}"
    else:
        last_ok = monitor.get("last_ok")
        health = stamp(last_ok) if type(last_ok) in (float, int) and math.isfinite(last_ok) and last_ok > 0 else "not recorded"
        evidence = f"last good run read: not recorded; last good health read: {health}"
    (emit or common.say)(f"{run_id} is still on home (monitor {monitor['state']}); {evidence}. "
                         "Do not kill it because of this health-check flap; keep waiting.")
