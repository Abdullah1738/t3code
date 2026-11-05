#!/opt/homebrew/bin/python3
"""Stop idle `cua-driver mcp` processes that OpenCode keeps per location.

OpenCode 2 boots one set of location services (plugins, MCP clients) per
directory a session touches and keeps it loaded for days. Each loaded location
owns its own `cua-driver mcp` stdio process, so the process count grows with
every worktree/chat directory used (97+ seen on 2026-09-29).

Evicting whole locations does not stick: the OpenChamber session-board runtime
polls /api/form and /api/permission/request per pending board directory every
45 s, which boots the location (and a new cua-driver) again within a minute.
So this job disconnects only the cua-driver MCP client in idle locations:

  POST /api/experimental/mcp/cua-driver/disconnect?location[directory]=DIR
      -> status "disabled", child process exits, location stays loaded.
  POST /api/experimental/mcp/cua-driver/connect?location[directory]=DIR
      -> reconnects in <1 s.

Per loaded location (GET /api/debug/location; MEMORY_BACKEND picks OpenChamber's
proxy or the OpenCode service directly, see backend.py):
  keep/reconnect - a running session lives there (GET /api/session/active),
                   or any session there was created/updated/viewed within
                   ACTIVE_MIN, or the directory is in the keep file
  disconnect     - no session activity for IDLE_MIN and no pending permission
  leave          - in between (hysteresis)

A disconnected location is reconnected on the next run (every 5 min) once a
session there becomes active again, or immediately if OpenCode evicts and
reboots the location. The OpenChamber MCP reconnect plugin only retries
"failed" servers, not "disabled" ones.

Then kills orphaned `cua-driver mcp` processes (parent is launchd, or the
parent opencode server no longer has that cwd loaded) older than ORPHAN_MIN.
The CuaDriver.app `serve` daemon is never touched.

Status: logs/location_reaper_last.json. --dry-run prints the plan only.
"""
import argparse, json, os, sqlite3, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backend  # noqa: E402

ROOT = Path.home() / ".local/share/memory-system"
LOGS = ROOT / "logs"
OC_DB = Path(backend.opencode_db())
KEEP_FILE = Path.home() / ".config/opencode/location-reaper-keep.txt"
STATUS = LOGS / "location_reaper_last.json"
SERVER = os.environ.get("LOCATION_REAPER_MCP", "cua-driver")
IDLE_MIN = int(os.environ.get("LOCATION_IDLE_MIN", "60"))
ACTIVE_MIN = 15
ORPHAN_MIN = 10
CUA_BIN = str(Path.home() / ".local/bin/cua-driver")


def api(method, path, timeout=30):
    req = backend.opencode_request(method, path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, (json.loads(body) if body else None)


def loc_q(d):
    return urllib.parse.urlencode({"location[directory]": d})


def last_activity_by_dir():
    con = backend.robob_readonly.native_ro(OC_DB, timeout=20)
    rows = con.execute(
        "SELECT directory, id, max(coalesce(time_updated,0), coalesce(time_viewed,0), "
        "coalesce(time_created,0)) FROM session_v2").fetchall()
    con.close()
    last, sid_dir = {}, {}
    for d, sid, t in rows:
        sid_dir[sid] = d
        if d and t > last.get(d, 0):
            last[d] = t
    return last, sid_dir


def running_dirs(sid_dir):
    _, active = api("GET", "/api/session/active")
    ids = list((active or {}).get("data", {}).keys())
    unknown = [s for s in ids if s not in sid_dir]
    if unknown:
        con = backend.robob_readonly.native_ro(OC_DB, timeout=20)
        q = "SELECT id, directory FROM session_v2 WHERE id IN (%s)" % ",".join("?" * len(unknown))
        sid_dir.update(dict(con.execute(q, unknown).fetchall()))
        con.close()
    return {sid_dir.get(s) for s in ids} - {None}, [s for s in ids if s not in sid_dir]


def mcp_status(d):
    _, r = api("GET", "/api/mcp?" + loc_q(d))
    for s in (r or {}).get("data", []):
        if s.get("name") == SERVER:
            return (s.get("status") or {}).get("status")
    return None


def cua_procs():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,etime=,command="],
                         capture_output=True, text=True).stdout
    procs, servers = [], set()
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, ppid, etime, cmd = int(parts[0]), int(parts[1]), parts[2], parts[3]
        if "opencode" in cmd and " serve" in cmd:
            servers.add(pid)
        if cmd == CUA_BIN + " mcp" or cmd.startswith(CUA_BIN + " mcp "):
            procs.append({"pid": pid, "ppid": ppid, "age_s": etime_s(etime)})
    for p in procs:
        r = subprocess.run(["lsof", "-a", "-p", str(p["pid"]), "-d", "cwd", "-Fn"],
                           capture_output=True, text=True).stdout
        p["cwd"] = next((l[1:] for l in r.splitlines() if l.startswith("n")), None)
    return procs, servers


def serving_pids():
    """PIDs listening on the OpenCode service port (robob backend), so the orphan
    sweep only judges that server's children by its own loaded locations."""
    port = urllib.parse.urlsplit(backend.opencode_url()).port or 80
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                         capture_output=True, text=True).stdout
    return {int(x) for x in out.split() if x.strip().isdigit()}


def etime_s(e):
    days = 0
    if "-" in e:
        d, e = e.split("-", 1)
        days = int(d)
    parts = [int(x) for x in e.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def bump(st, k):
    st["kept"][k] = st["kept"].get(k, 0) + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--idle-min", type=int, default=IDLE_MIN)
    a = ap.parse_args()
    t0 = time.time()
    now_ms = int(t0 * 1000)
    st = {"ts": int(t0), "dry_run": a.dry_run, "state": "done", "server": SERVER, "backend": backend.name(),
          "disconnected": [], "reconnected": [], "kept": {}, "killed_orphans": [], "errors": []}
    try:
        _, locs = api("GET", "/api/debug/location")
        loaded = [l["directory"] for l in (locs or []) if l.get("directory")]
        last, sid_dir = last_activity_by_dir()
        run_dirs, _ = running_dirs(sid_dir)
        keep = set()
        if KEEP_FILE.exists():
            keep = {l.strip() for l in KEEP_FILE.read_text().splitlines()
                    if l.strip() and not l.startswith("#")}
        idle_ms, active_ms = a.idle_min * 60000, ACTIVE_MIN * 60000
        for d in loaded:
            try:
                status = mcp_status(d)
                age = now_ms - last.get(d, 0)
                if status is None:
                    bump(st, "no_server")
                    continue
                wanted = d in run_dirs or d in keep or age < active_ms
                if wanted:
                    if status == "disabled":
                        if not a.dry_run:
                            api("POST", f"/api/experimental/mcp/{SERVER}/connect?" + loc_q(d))
                        st["reconnected"].append(d)
                    else:
                        bump(st, "active")
                    continue
                if status == "disabled":
                    bump(st, "already_disconnected")
                    continue
                if age < idle_ms:
                    bump(st, "recent")
                    continue
                _, perms = api("GET", "/api/permission/request?" + loc_q(d))
                items = perms.get("data", perms) if isinstance(perms, dict) else perms
                if items:
                    bump(st, "pending_permission")
                    continue
                if a.dry_run:
                    st["disconnected"].append(d)
                    continue
                # re-check right before disconnecting
                rd, unknown = running_dirs(sid_dir)
                if d in rd or unknown:
                    bump(st, "became_running")
                    continue
                api("POST", f"/api/experimental/mcp/{SERVER}/disconnect?" + loc_q(d))
                st["disconnected"].append(d)
            except Exception as e:
                st["errors"].append(f"{d}: {e!r}")
                if len(st["errors"]) >= 5:
                    st["state"] = "error"
                    break
        if not a.dry_run and st["disconnected"]:
            time.sleep(3)
        # orphan sweep
        _, locs = api("GET", "/api/debug/location")
        loaded_now = {l["directory"] for l in (locs or []) if l.get("directory")}
        procs, servers = cua_procs()
        if backend.is_robob():
            servers &= serving_pids()
        for p in procs:
            orphan = p["ppid"] == 1 or (p["ppid"] in servers and p["cwd"] not in loaded_now)
            if orphan and p["age_s"] >= ORPHAN_MIN * 60:
                if not a.dry_run:
                    try:
                        os.kill(p["pid"], 15)
                    except ProcessLookupError:
                        pass
                st["killed_orphans"].append({k: p[k] for k in ("pid", "ppid", "cwd", "age_s")})
        st["loaded"] = len(loaded_now)
        st["cua_procs"] = len(procs) - (0 if a.dry_run else len(st["killed_orphans"]))
    except Exception as e:
        st["state"] = "error"
        st["errors"].append(repr(e))
    st["duration_s"] = round(time.time() - t0, 1)
    if not a.dry_run:
        LOGS.mkdir(parents=True, exist_ok=True)
        tmp = STATUS.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=1))
        tmp.replace(STATUS)
    print(json.dumps(st if a.dry_run else {k: (len(v) if isinstance(v, list) else v)
                                          for k, v in st.items()}, indent=1))
    return 0 if st["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
