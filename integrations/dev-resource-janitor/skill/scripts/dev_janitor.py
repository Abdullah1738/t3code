#!/opt/homebrew/bin/python3
"""Dev resource janitor: find and stop agent leftovers (iOS simulators, Expo/Metro
servers, Docker containers incl. LocalStack, Docker Desktop itself) that no agent
session has touched in the last hour.

  dev_janitor.py scan                 read-only; prints JSON inventory + candidates
  dev_janitor.py apply --ids a,b,...  re-scans, acts only on ids that are STILL
                                      candidates, appends to the audit log

Evidence of "used in the last hour" (any one keeps the resource):
  - resource younger than IDLE_MIN (booted/started/created)
  - any OpenCode session message created in the last IDLE_MIN minutes mentions one
    of the resource's tokens (sim UDID or name; expo cwd or port; container name,
    id, compose dir or published host port). Sessions titled "Dev resource
    janitor..." are ignored.
  - a running OpenCode session's directory contains the expo cwd (or vice versa)
  - containers: non-healthcheck log lines in the last IDLE_MIN minutes
  - Docker Desktop is only a candidate when zero containers are running and no
    session mentioned "docker" in the last IDLE_MIN minutes (ad-hoc containers
    like `docker run --rm` are invisible otherwise; quitting Docker under a
    running session broke a review on 2026-09-29).
Stdlib only. Opens opencode.db read-only.
"""
import argparse, calendar, json, os, re, signal, sqlite3, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from active_sessions import active_session_ids  # noqa: E402

IDLE_MIN = int(os.environ.get("DEV_JANITOR_IDLE_MIN", "60"))
OC_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
LOG_DIR = os.path.expanduser("~/.local/share/dev-janitor")
AUDIT = os.path.join(LOG_DIR, "audit.jsonl")
LAST = os.path.join(LOG_DIR, "last.json")
KEEP_FILE = os.path.expanduser("~/.config/opencode/dev-janitor-keep.txt")
DOCKER = "/usr/local/bin/docker" if os.path.exists("/usr/local/bin/docker") else "docker"
SELF_TITLE = "Dev resource janitor"
SELF_MARKER = "DEV-RESOURCE-JANITOR-RUN"  # put in the scheduled prompt; such sessions are ignored
HEALTH_RE = re.compile(r"health|/_localstack|GET /_|readyz|livez|ping", re.I)
os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + os.environ.get("PATH", "")


def sh(cmd, timeout=60):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:  # noqa: BLE001
        return 99, "", str(e)


def etime_s(v):
    v = v.strip()
    d = 0
    if "-" in v:
        dd, v = v.split("-", 1)
        d = int(dd)
    parts = [int(x) for x in v.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return d * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def procs():
    rc, out, _ = sh(["ps", "-axo", "pid=,ppid=,etime=,rss=,command="])
    res = []
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)", line)
        if m:
            res.append({"pid": int(m[1]), "ppid": int(m[2]), "age_s": etime_s(m[3]),
                        "rss_mb": int(m[4]) // 1024, "cmd": m[5]})
    return res


def cwd_of(pid):
    rc, out, _ = sh(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
    for l in out.splitlines():
        if l.startswith("n"):
            return l[1:]
    return None


def keep_list():
    try:
        return [l.strip() for l in open(KEEP_FILE) if l.strip() and not l.startswith("#")]
    except FileNotFoundError:
        return []


def running_sessions():
    return active_session_ids(timeout=20)


def session_evidence(tokens_by_res, running):
    """tokens_by_res: {res_id: [token,...]} -> {res_id: [{session,title,at,token}]}"""
    since = int((time.time() - IDLE_MIN * 60) * 1000)
    c = sqlite3.connect(f"file:{OC_DB}?mode=ro", uri=True, timeout=30)
    titles = {}
    hits = {rid: {} for rid in tokens_by_res}
    for sid, t, data in c.execute(
            "SELECT session_id, time_created, data FROM session_message WHERE time_created >= ?", (since,)):
        if sid not in titles:
            row = c.execute("SELECT title, directory FROM session_v2 WHERE id=?", (sid,)).fetchone()
            me = c.execute("SELECT 1 FROM session_message WHERE session_id=? AND type='user' AND instr(data, ?) > 0 LIMIT 1",
                           (sid, SELF_MARKER)).fetchone()
            titles[sid] = (row or ("", ""))[:2] + (bool(me),)
        if titles[sid][2] or (titles[sid][0] or "").startswith(SELF_TITLE):
            continue
        for rid, toks in tokens_by_res.items():
            for tok in toks:
                if tok and tok in data:
                    prev = hits[rid].get(sid)
                    if not prev or prev["at_ms"] < t:
                        hits[rid][sid] = {"session": sid, "title": titles[sid][0], "at_ms": t, "token": tok,
                                          "running": bool(running and sid in running)}
                    break
    dirs = {}
    if running:
        for sid in running:
            row = c.execute("SELECT directory FROM session_v2 WHERE id=?", (sid,)).fetchone()
            if row:
                dirs[sid] = row[0]
    out = {}
    for rid, d in hits.items():
        lst = sorted(d.values(), key=lambda x: -x["at_ms"])
        for x in lst:
            x["at"] = time.strftime("%H:%M", time.localtime(x.pop("at_ms") / 1000))
        out[rid] = lst
    return out, dirs


def scan():
    now = time.time()
    running, run_err = running_sessions()
    ps = procs()
    by_pid = {p["pid"]: p for p in ps}
    resources = []

    # iOS simulators
    rc, out, err = sh(["xcrun", "simctl", "list", "-j", "devices", "booted"])
    booted = []
    if rc == 0:
        for rt, devs in json.loads(out).get("devices", {}).items():
            for d in devs:
                if d.get("state") == "Booted":
                    booted.append(d)
    for d in booted:
        udid = d["udid"]
        lp = next((p for p in ps if p["cmd"].startswith("launchd_sim") and udid in p["cmd"]), None)
        resources.append({"id": "sim:" + udid, "kind": "simulator", "name": d["name"],
                          "age_s": lp["age_s"] if lp else None,
                          "tokens": [udid, d["name"]]})
    # Simulator.app left open with no booted device
    sim_app = next((p for p in ps if p["cmd"].endswith("/Simulator.app/Contents/MacOS/Simulator")), None)
    if rc == 0 and not booted and sim_app:
        resources.append({"id": "simulator-app", "kind": "simulator-app", "pids": [sim_app["pid"]],
                          "age_s": sim_app["age_s"], "rss_mb": sim_app["rss_mb"], "tokens": []})

    # Expo / Metro servers
    for p in ps:
        c = p["cmd"]
        if not re.search(r"(expo(/bin/cli)?|\.bin/expo)\s+start|react-native\s+start|metro\s+serve", c):
            continue
        if c.startswith("npm exec") or c.startswith("/bin/") or "grep" in c:
            continue
        port = re.search(r"--port[ =](\d+)", c)
        port = port[1] if port else "8081"
        cwd = cwd_of(p["pid"]) or ""
        parent = by_pid.get(p["ppid"])
        pgroup = [p["pid"]]
        if parent and re.match(r"(npm exec|npx|node .*npx-cli)", parent["cmd"]):
            pgroup.append(parent["pid"])
        resources.append({"id": f"expo:{p['pid']}", "kind": "expo", "pid": p["pid"], "pids": pgroup,
                          "age_s": p["age_s"], "rss_mb": p["rss_mb"], "cwd": cwd, "port": port,
                          "cmd": c[:200],
                          "tokens": [t for t in [cwd, f"--port {port}", f":{port}"] if t]})

    # Docker
    docker_up = False
    rc, out, err = sh([DOCKER, "info", "--format", "{{.ServerVersion}}"], timeout=20)
    docker_up = rc == 0 and out.strip() != ""
    vm = next((p for p in ps if "Virtualization.VirtualMachine" in p["cmd"]), None)
    containers = []
    if docker_up:
        rc, out, _ = sh([DOCKER, "ps", "-q", "--no-trunc"], timeout=30)
        ids = out.split()
        if ids:
            rc, out, _ = sh([DOCKER, "inspect"] + ids, timeout=60)
            for ci in json.loads(out or "[]"):
                name = ci["Name"].lstrip("/")
                started = ci["State"].get("StartedAt", "")
                try:
                    st = calendar.timegm(time.strptime(started[:19], "%Y-%m-%dT%H:%M:%S"))
                except Exception:  # noqa: BLE001
                    st = now
                labels = ci["Config"].get("Labels") or {}
                ports = []
                for _, binds in (ci["NetworkSettings"].get("Ports") or {}).items():
                    for b in binds or []:
                        if b.get("HostPort"):
                            ports.append(b["HostPort"])
                rc2, lo, le = sh([DOCKER, "logs", "--since", f"{IDLE_MIN}m", ci["Id"]], timeout=30)
                lines = [l for l in (lo + le).splitlines() if l.strip() and not HEALTH_RE.search(l)]
                wd = labels.get("com.docker.compose.project.working_dir", "")
                toks = [name, ci["Id"][:12]] + [f":{p}" for p in sorted(set(ports))] + ([wd] if wd else [])
                containers.append({"id": "container:" + name, "kind": "container", "name": name,
                                   "image": ci["Config"].get("Image"), "age_s": int(now - st),
                                   "ports": sorted(set(ports)), "compose_dir": wd,
                                   "recent_log_lines": len(lines), "log_sample": lines[-3:],
                                   "tokens": toks})
        resources.extend(containers)
        resources.append({"id": "docker-desktop", "kind": "docker-desktop",
                          "age_s": vm["age_s"] if vm else None, "vm_rss_mb": vm["rss_mb"] if vm else None,
                          "tokens": ["docker ", "docker\\", "docker-compose", "docker compose"]})

    evidence, run_dirs = session_evidence({r["id"]: r["tokens"] for r in resources}, running)
    keep = keep_list()
    for r in resources:
        reasons = []
        r["sessions"] = evidence.get(r["id"], [])[:5]
        if running is None:
            reasons.append("cannot_read_running_sessions: " + (run_err or ""))
        if any(k and (k in r["id"] or k == r.get("name") or k == r.get("cwd")) for k in keep):
            reasons.append("keep_file")
        if r.get("age_s") is None or r["age_s"] < IDLE_MIN * 60:
            reasons.append("younger_than_idle_window")
        if r["sessions"]:
            reasons.append("mentioned_by_session_in_last_hour")
        if r["kind"] == "expo" and r.get("cwd"):
            # Only a running session inside the project counts. A session in a parent
            # directory (e.g. the janitor itself in ~) is not evidence of use.
            for sid, d in run_dirs.items():
                if d and (r["cwd"] == d.rstrip("/") or d.startswith(r["cwd"] + "/")):
                    reasons.append(f"running_session_in_cwd:{sid}")
                    break
        if r["kind"] == "container" and r["recent_log_lines"]:
            reasons.append("recent_container_logs")
        if r["kind"] == "docker-desktop":
            alive = [c for c in containers if c["id"]]
            if alive:
                reasons.append(f"containers_running:{len(alive)}")
        r["keep_reasons"] = reasons
        r["candidate"] = not reasons
    return {"ts": int(now), "idle_min": IDLE_MIN, "running_sessions": len(running or []),
            "docker_up": docker_up, "resources": resources,
            "candidates": [r["id"] for r in resources if r["candidate"]]}


def audit(entry):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(AUDIT, "a") as f:
        f.write(json.dumps(entry) + "\n")


def act(r):
    k = r["kind"]
    if k == "simulator":
        udid = r["id"].split(":", 1)[1]
        rc, o, e = sh(["xcrun", "simctl", "shutdown", udid], timeout=120)
        return rc == 0, (o + e).strip()
    if k == "expo":
        for pid in r["pids"]:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        time.sleep(3)
        alive = [p for p in r["pids"] if os.path.exists(f"/proc/{p}") or sh(["ps", "-p", str(p)])[0] == 0]
        for pid in alive:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return True, f"terminated {r['pids']}"
    if k == "container":
        rc, o, e = sh([DOCKER, "stop", "-t", "30", r["name"]], timeout=90)
        return rc == 0, (o + e).strip()
    if k == "docker-desktop":
        rc, o, e = sh([DOCKER, "desktop", "stop"], timeout=180)
        return rc == 0, (o + e).strip()
    if k == "simulator-app":
        quit_simulator_app()
        return sh(["pgrep", "-x", "Simulator"])[0] != 0, "Simulator.app quit"
    return False, "unknown kind"


def apply(ids):
    order = {"sim": 0, "simulator-app": 1, "expo": 2, "container": 3, "docker-desktop": 4}
    want = [i.strip() for i in ids.split(",") if i.strip()]
    done = []
    for rid in sorted(want, key=lambda x: order.get(x.split(":")[0], 9)):
        st = scan()  # re-scan before every action; state may have changed
        r = next((x for x in st["resources"] if x["id"] == rid), None)
        if not r:
            done.append({"id": rid, "ok": True, "action": "gone"})
            continue
        if not r["candidate"]:
            done.append({"id": rid, "ok": False, "action": "skipped", "keep_reasons": r["keep_reasons"]})
            continue
        ok, msg = act(r)
        entry = {"ts": int(time.time()), "id": rid, "kind": r["kind"], "ok": ok, "msg": msg[:300],
                 "age_s": r.get("age_s"), "detail": {k: r.get(k) for k in ("name", "cwd", "port", "image", "rss_mb", "vm_rss_mb")}}
        audit(entry)
        done.append(entry)
    booted = sh(["xcrun", "simctl", "list", "devices", "booted"])[1]
    if "(Booted)" not in booted and any(d.get("kind") == "simulator" and d.get("ok") for d in done):
        quit_simulator_app()
    return done


def quit_simulator_app():
    """Quit Simulator.app when no device is booted. osascript alone is unreliable."""
    if sh(["pgrep", "-x", "Simulator"])[0] != 0:
        return
    sh(["osascript", "-e", 'quit app "Simulator"'], timeout=20)
    time.sleep(3)
    if sh(["pgrep", "-x", "Simulator"])[0] == 0:
        sh(["pkill", "-TERM", "-x", "Simulator"])
        audit({"ts": int(time.time()), "id": "simulator-app", "kind": "simulator-app", "ok": True,
               "msg": "no booted devices; Simulator.app terminated"})


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    a = sub.add_parser("apply")
    a.add_argument("--ids", required=True)
    args = ap.parse_args()
    if args.cmd == "scan":
        st = scan()
        os.makedirs(LOG_DIR, exist_ok=True)
        json.dump(st, open(LAST, "w"), indent=1)
        print(json.dumps(st, indent=1))
    else:
        print(json.dumps(apply(args.ids), indent=1))


if __name__ == "__main__":
    main()
