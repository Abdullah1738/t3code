#!/opt/homebrew/bin/python3
"""Dev resource janitor: find and stop agent leftovers (iOS simulators, Expo/Metro
servers, Docker containers incl. LocalStack, Docker Desktop itself) that no agent
session has touched in the last hour.

  dev_janitor.py scan                 read-only; prints JSON inventory + candidates
  dev_janitor.py apply --ids a,b,...  re-scans, acts only on ids that are STILL
                                      candidates, appends to the audit log

Liveness comes from the complete active-session API snapshot. Recent-message
history is not exposed there, so legacy cleanup stays report-only until that
usage check can be satisfied through a supported API. Process leftovers have a
separate report-only inventory and cannot become action ids.
Stdlib only. Liveness comes from the supported control and session APIs.
"""
import argparse, calendar, json, os, re, signal, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import active_sessions  # noqa: E402
import leftover_processes  # noqa: E402
sys.path.insert(0, os.path.expanduser("~/.local/lib/mac-logging"))
try:
    from toollog import emit
except Exception:
    def emit(*args, **kwargs):
        pass


def log_kill(resource, ok):
    try:
        kind = resource.get("kind")
        mapped = {"simulator": "sim", "simulator-app": "sim", "expo": "metro"}.get(kind, "docker")
        if kind == "container" and "localstack" in resource.get("image", "").lower():
            mapped = "localstack"
        sessions = resource.get("sessions") or []
        owner = resource.get("owner_thread") or next((x.get("threadId") for x in sessions if x.get("threadId")), None)
        emit("janitor", "event" if ok else "error", "janitor.kill", ok=ok,
             ids={"threadId": owner}, props={"resourceKind": mapped, "ageS": resource.get("age_s")},
             error_tag=None if ok else "janitor.kill_failed")
    except Exception:
        pass


def log_run(started, found, killed, ok):
    try:
        emit("janitor", "perf" if ok else "error", "janitor.run", ok=ok,
             duration_ms=(time.monotonic()-started)*1000, props={"found": found, "killed": killed},
             error_tag=None if ok else "janitor.failed")
    except Exception:
        pass


IDLE_MIN = int(os.environ.get("DEV_JANITOR_IDLE_MIN", "60"))
LOG_DIR = os.path.expanduser(os.environ.get("DEV_JANITOR_LOG_DIR", "~/.local/share/dev-janitor"))
AUDIT = os.path.join(LOG_DIR, "audit.jsonl")
LAST = os.path.join(LOG_DIR, "last.json")
KEEP_FILE = os.path.expanduser("~/.config/opencode/dev-janitor-keep.txt")
DOCKER = "/usr/local/bin/docker" if os.path.exists("/usr/local/bin/docker") else "docker"
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


def running_sessions(snap=None):
    snap = active_sessions.checked_snapshot(timeout=20) if snap is None else snap
    dirs, err = active_sessions.directories(snap)
    if err:
        return None, {}, err
    return set(snap["opencode"]), dirs, None


def session_evidence(tokens_by_res, running, native_dirs=None):
    # The active roster has no complete recent-message history. Absence of a
    # mention cannot be proved from it; scan keeps these legacy resources.
    return {rid: [] for rid in tokens_by_res}, dict(native_dirs or {})


def process_cursor():
    try:
        with open(LAST) as report:
            value = json.load(report).get('processes', {}).get('next_cursor', 0)
        if type(value) is int and value >= 0:
            return value
        if (isinstance(value, dict) and type(value.get('priority')) is int and value['priority'] in (0, 1)
                and type(value.get('pid')) is int and value['pid'] > 0):
            return value
        return 0
    except (OSError, ValueError, AttributeError):
        return 0


def scan():
    now = time.time()
    live = active_sessions.checked_snapshot(timeout=20)
    running, native_dirs, run_err = running_sessions(live)
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
                          "cmd": leftover_processes.redact(c),
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

    evidence, run_dirs = session_evidence({r["id"]: r["tokens"] for r in resources}, running, native_dirs)
    keep = keep_list()
    for r in resources:
        reasons = []
        r["sessions"] = evidence.get(r["id"], [])[:5]
        if running is None:
            # Incomplete active set: a missing source means "unknown", so nothing is a candidate.
            reasons.append("liveness_unavailable: " + (run_err or ""))
        reasons.append("usage_history_unavailable: complete recent-message history is not exposed by the active API")
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
            "liveness_unavailable": run_err,
            "processes": leftover_processes.scan(live, keep, cursor=process_cursor()),
            "docker_up": docker_up, "resources": resources,
            "candidates": [r["id"] for r in resources if r["candidate"]]}


def record_report(st):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LAST, "w") as report:
        json.dump(st, report, indent=1)
    audit({"ts": st["ts"], "event": "report", "liveness_unavailable": st["liveness_unavailable"],
           "processes": {key: st["processes"][key] for key in ("candidates", "problems", "checked", "skipped", "budget_skipped")}})


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


def apply(ids, stats=None):
    stats = stats if stats is not None else {}
    order = {"sim": 0, "simulator-app": 1, "expo": 2, "container": 3, "docker-desktop": 4}
    want = [i.strip() for i in ids.split(",") if i.strip()]
    stats["found"] = max(stats.get("found", 0), len(want))
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
        try:
            ok, msg = act(r)
        except Exception:
            log_kill(r, False)
            raise
        log_kill(r, ok)
        if ok:
            stats["killed"] = stats.get("killed", 0) + 1
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


def run(stats=None):
    stats = stats if stats is not None else {}
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    scan_parser = sub.add_parser("scan")
    scan_parser.add_argument("--no-write", action="store_true", help="read-only live dry run; no report files or logs")
    a = sub.add_parser("apply")
    a.add_argument("--ids", required=True)
    args = ap.parse_args()
    if args.cmd == "scan":
        st = scan()
        stats["found"] = len(st["resources"])
        if not args.no_write:
            record_report(st)
        print(json.dumps(st, indent=1))
        return len(st["resources"]), 0, True
    else:
        results = apply(args.ids, stats)
        print(json.dumps(results, indent=1))
        return len(results), sum(r.get("ok", False) and r.get("action") != "gone" for r in results), all(r.get("ok") or r.get("action") == "skipped" for r in results)


def main():
    started = time.monotonic()
    stats = {"found": 0, "killed": 0}
    ok = False
    try:
        _, _, ok = run(stats)
    finally:
        if not (sys.argv[1:2] == ["scan"] and "--no-write" in sys.argv[2:]):
            log_run(started, stats["found"], stats["killed"], ok)


if __name__ == "__main__":
    main()
