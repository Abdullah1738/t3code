"""Pressure and process sampling without retaining commands or environment secrets."""
from __future__ import annotations

import hashlib
import os
import re
import time

from classify import classify
from monitor_support import run

SESSION = re.compile(r"(?:^|\s)OPENCODE_SESSION_ID=(ses_[A-Za-z0-9_-]+)(?=\s|$)")
PWD = re.compile(r"(?:^|\s)PWD=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)")
FIELDS = "pid=,ppid=,pcpu=,rss=,command="
LOCAL_RUN = re.compile(r"\boffbox-local:run-")
OFFBOX = re.compile(r"(?:^|[\s/'\"])offbox(?:\.py)?(?:\s|$|['\"])|/offbox_lib(?:/|\b)")
# LaunchServices gives every app it launches (and, by inheritance, the app's children) this name.
APP = re.compile(r"(?:^|\s)XPC_SERVICE_NAME=application\.")


def process_rows(raw):
    rows = {}
    for line in raw.splitlines():
        fields = line.strip().split(None, 4)
        if len(fields) != 5:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
            rows[pid] = {"pid": pid, "ppid": ppid, "cpu": float(fields[2]),
                         "rss": int(fields[3]), "cmd": fields[4]}
        except ValueError:
            continue
    return rows


def sample_processes(previous, now, raw=None, plain=None):
    # A second, environment-free view locates the env suffix and avoids treating
    # a quoted OPENCODE_SESSION_ID in a shell script as its actual identity.
    if raw is None:
        raw = run(["/bin/ps", "-Aww", "-o", FIELDS, "-E"])
    if plain is None:
        plain = run(["/bin/ps", "-Aww", "-o", FIELDS])
    rows, clean = process_rows(raw), process_rows(plain)
    progress, groups = {}, {}
    for pid, row in rows.items():
        command = clean.get(pid, {}).get("cmd")
        if not command or not row["cmd"].startswith(command):
            row.update(cmd="", session=None, cwd=None, heavy=False, remote=False)
            continue
        env = row["cmd"][len(command):]
        session, cwd = SESSION.search(env), PWD.search(env)
        row.update(cmd=command, session=session[1] if session else None,
                   cwd=cwd[1] if cwd else None)
        row["remote"] = bool(OFFBOX.search(command))
        row["app"] = APP.search(env) is not None
        # Local-first runs execute here (their env carries OFFBOX_LOCAL_RUN): real Mac load the monitor must see.
        row["local_run"] = "OFFBOX_LOCAL_RUN=" in env or LOCAL_RUN.search(command) is not None
        row["heavy"] = classify(command, row["cwd"]).get("heavy", False)
    # `open` hands the caller's env to the app, so a GUI app started from an agent
    # shell (Robob by its installer, Tailscale) carries that shell's session id and
    # PWD for its whole life. The id on an app's launch process, and copies of it
    # in the app's own tree, aren't agent work.
    stale = {row["session"] for row in rows.values()
             if row.get("app") and row["ppid"] == 1 and row["session"]}
    for row in rows.values():
        if row.get("app") and row["session"] in stale:
            row.update(session=None, cwd=None)
    # Inherit identity through the OS process tree (children can clear env).
    for row in rows.values():
        current, seen = row, set()
        while not row["session"] and current["ppid"] in rows and current["ppid"] not in seen:
            seen.add(current["ppid"])
            current = rows[current["ppid"]]
            row["session"] = current["session"]
            row["cwd"] = row["cwd"] or current["cwd"]
    # Exact cwd fallback only when that directory has one known owner.
    owners = {}
    for row in rows.values():
        if row["session"] and row["cwd"]:
            owners.setdefault(row["cwd"], set()).add(row["session"])
    for row in rows.values():
        pid = row["pid"]
        if pid == os.getpid() or not row["cmd"]:
            continue
        # Remote execution includes the lightweight local Python/SSH/rsync tree.
        # Check ancestors independently of their env/session identity.
        current, seen, remote = row, set(), row["remote"] and not row.get("local_run")
        # A local-first run (marked shell or env) is real Mac load even though offbox started it.
        local = row.get("local_run")
        while not remote and not local and current["ppid"] in rows and current["ppid"] not in seen:
            seen.add(current["ppid"])
            current = rows[current["ppid"]]
            local = current.get("local_run")
            remote = current["remote"] and not local
        if remote:
            continue
        signature = hashlib.sha256(row["cmd"].encode()).hexdigest()[:16]
        key = str(pid) + ":" + signature
        old = previous.get(key, {})
        since = old.get("since", now) if now - old.get("last", 0) <= 30 else now
        if row["cpu"] > 50:
            progress[key] = {"since": since, "last": now}
        sustained = row["cpu"] > 50 and now - since >= 60
        # Classifier-matched parent processes also identify their worker tree.
        current, seen, heavy = row, set(), row["heavy"]
        while not heavy and current["ppid"] in rows and current["ppid"] not in seen:
            seen.add(current["ppid"])
            current = rows[current["ppid"]]
            if current["session"] != row["session"]:
                break
            heavy = current["heavy"]
        if not heavy and not sustained:
            continue
        # An app's cwd says nothing about which agent it works for.
        if not row["session"] and not row.get("app"):
            cwd = row["cwd"]
            if not cwd:
                output = run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], timeout=2)
                cwd = next((s[1:] for s in output.splitlines() if s.startswith("n")), None)
            candidates = owners.get(cwd, set())
            if len(candidates) == 1:
                row["session"] = next(iter(candidates))
        if not row["session"]:
            continue
        group = groups.setdefault(row["session"], {"cpu": 0.0, "rss": 0, "pids": [], "keys": []})
        group["cpu"] += row["cpu"]
        group["rss"] += row["rss"]
        group["pids"].append(pid)
        group["keys"].append(key)
    return groups, progress, len(rows)


def pressure(previous, now, load=None, swap_text=None, memory_text=None):
    load = os.getloadavg()[0] if load is None else load
    if swap_text is None:
        swap_text = run(["/usr/sbin/sysctl", "-n", "vm.swapusage"])
    if memory_text is None:
        memory_text = run(["/usr/bin/memory_pressure", "-Q"])
    swap = re.search(r"used\s*=\s*([\d.]+)([KMGT])", swap_text)
    swap_gb = float(swap[1]) * {"K": 1 / 1048576, "M": 1 / 1024, "G": 1, "T": 1024}[swap[2]] if swap else None
    free = re.search(r"(?:System-wide memory free percentage|free percentage):\s*([\d.]+)%", memory_text, re.I)
    free_pct = float(free[1]) if free else None
    continuous = now - previous.get("sampled", 0) <= 30
    high_since = previous.get("high_since") if continuous else None
    high_since = (high_since if high_since is not None else now) if load > 24 else None
    # macOS never gives swap back, so absolute swap is always "high" after a busy day.
    # Use swap GROWTH instead: >1 GiB added within the last 10 minutes of samples.
    history = [h for h in (previous.get("swap_hist") or []) if continuous and now - h[0] <= 600]
    if swap_gb is not None:
        history.append([now, round(swap_gb, 3)])
    swap_growth = (swap_gb - min(h[1] for h in history)) if (swap_gb is not None and history) else 0.0
    active = ((high_since is not None and now - high_since >= 180)
              or swap_growth > 1.0
              or (free_pct is not None and free_pct < 25))
    return {"sampled": now, "high_since": high_since, "load1": round(load, 2),
            "swap_gb": round(swap_gb, 2) if swap_gb is not None else None,
            "swap_growth_gb": round(swap_growth, 2), "swap_hist": history[-80:],
            "free_pct": free_pct, "active": bool(active)}
