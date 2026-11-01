#!/opt/homebrew/bin/python3
"""Offbox pressure monitor: steer, background-throttle, alert; never kill work."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from monitor_sample import FIELDS, pressure, process_rows, sample_processes
from monitor_support import HOME, PREFIX, STATE, live_exemption, run, steer, telegram


def log(text):
    stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    with (STATE / "monitor.log").open("a") as output:
        output.write(stamp + " " + text + "\n")


def connect(path):
    con = sqlite3.connect(path, timeout=5)
    con.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    return con


def get(con, key, default):
    row = con.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def put(con, key, value):
    con.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, json.dumps(value)))


def throttle(group):
    # Re-read before acting: don't apply a sampled PID to an unrelated new process.
    raw = run(["/bin/ps", "-ww", "-p", ",".join(map(str, group["pids"])), "-o", FIELDS])
    wanted = set(group["keys"])
    count = 0
    for pid, row in process_rows(raw).items():
        key = str(pid) + ":" + hashlib.sha256(row["cmd"].encode()).hexdigest()[:16]
        if key in wanted:
            run(["/usr/bin/taskpolicy", "-b", "-p", str(pid)], timeout=3)
            count += 1
    return count


def message(session, group, sample, second=False):
    stage = "Second warning after five minutes of continued heavy work." if second else "Local heavy work detected during Mac pressure."
    return (PREFIX + "\n" + stage + "\n"
            f"Session {session}: {group['cpu']:.1f}% CPU, {group['rss'] / 1048576:.2f} GiB RSS; "
            f"load1 {sample['load1']}, swap {sample['swap_gb']} GiB, memory free {sample['free_pct']}%. "
            "Load the remote-compute skill and move heavy work to `offbox run -- <cmd>`. "
            "If it truly must stay local, use `offbox local --reason ...` to record an exemption. "
            + ("The monitor is applying taskpolicy -b to the heavy PIDs." if second else "The monitor never kills your work."))


def ladder(con, groups, sample, now, dry_run=False):
    records = get(con, "sessions", {})
    actions = []
    # Rank CPU-seconds plus RSS; report only classifier/CPU-qualified processes.
    for session, group in groups.items():
        old = records.get(session, {})
        delta = max(0, min(10, now - old.get("last", now - 10)))
        group["cpu_seconds"] = old.get("cpu_seconds", 0) + group["cpu"] * delta / 100
    ranked = sorted(groups, key=lambda ses: groups[ses]["cpu_seconds"] + groups[ses]["rss"] / 1048576,
                    reverse=True)
    for session in ranked:
        group = groups[session]
        record = records.setdefault(session, {})
        if now - record.get("last", 0) > 30:
            record.update(start=None, stage=0, retry=0, resource_since=None)
        record.update(last=now, cpu_seconds=group["cpu_seconds"])
        # A command name alone isn't pressure: require a real resource floor,
        # continuously for one minute, before starting or advancing the ladder.
        if group["cpu"] < 50 and group["rss"] < 1.5 * 1048576:
            record.update(start=None, stage=0, resource_since=None)
            continue
        if record.get("resource_since") is None:
            record["resource_since"] = now
        if now - record["resource_since"] < 60:
            continue
        if live_exemption(session, now):
            record.update(start=None, stage=0, resource_since=None)
            actions.append({"session": session, "action": "exempt"})
            continue
        if record.get("start") is None:
            if not sample["active"] or now < record.get("dedupe", 0):
                continue
            record.update(start=now, stage=0, retry=0)
        if now < record.get("retry", 0):
            continue
        stage = record.get("stage", 0)
        age = now - record["start"]
        target = 1 if stage == 0 else 2 if stage == 1 and age >= 300 else 3 if stage == 2 and age >= 900 else 0
        if not target:
            continue
        action = {1: "steer", 2: "steer-and-throttle", 3: "telegram"}[target]
        actions.append({"session": session, "action": action, "pids": group["pids"]})
        if dry_run:
            continue
        # Persist the retry lease before I/O so a crash cannot create a tight loop.
        record["retry"] = now + 60
        put(con, "sessions", records)
        con.commit()
        if target < 3:
            rid = f"offbox-monitor:{session}:{int(record['start'])}:{target}"
            if target == 2:
                count = throttle(group)
                log(f"throttle session={session} pids_attempted={count}")
            success = steer(session, message(session, group, sample, target == 2), rid,
                            include_parent=target == 2, driver=group.get("driver"))
        else:
            success = record.get("telegram_sent", False) or telegram(session)
            if success:
                record["telegram_sent"] = True
        log(f"action={action} session={session} success={success}")
        if success:
            record["stage"] = target
            if target == 1:
                record.update(start=now, dedupe=now + 1800)
    # End an episode as soon as its workload disappears; keep the 30-min dedupe.
    for session, record in list(records.items()):
        if session not in groups:
            record.update(start=None, stage=0, cpu_seconds=0, resource_since=None)
        if now - record.get("last", now) > 86400:
            del records[session]
    put(con, "sessions", records)
    return actions


def maintenance(con, now, pool, pending):
    executable = HOME / ".local/bin/offbox"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        return
    for name, interval, args in (("spend", 600, ["spend", "--check"]), ("reap", 300, ["reap"])):
        if now - get(con, "maintenance:" + name, 0) < interval:
            continue
        if name in pending and not pending[name].done():
            continue
        put(con, "maintenance:" + name, now)
        con.commit()
        pending[name] = pool.submit(run, [str(executable), *args], 120)


def tick(con, dry_run=False):
    now = time.time()
    sample = pressure(get(con, "pressure", {}), now)
    groups, cpu, total = sample_processes(get(con, "cpu", {}), now)
    actions = ladder(con, groups, sample, now, dry_run)
    put(con, "pressure", sample)
    put(con, "cpu", cpu)
    con.commit()
    summary = {"dry_run": dry_run, "pressure": sample["active"], "load1": sample["load1"],
               "swap_gb": sample["swap_gb"], "free_pct": sample["free_pct"],
               "processes": total, "heavy_sessions": len(groups), "actions": actions}
    if not dry_run and (actions or now - get(con, "last_summary", 0) >= 60):
        log(json.dumps(summary))
        put(con, "last_summary", now)
        con.commit()
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=["loop"])
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if bool(args.command) == args.once or (args.dry_run and not args.once):
        parser.error("use loop or --once [--dry-run]")
    STATE.mkdir(parents=True, exist_ok=True)
    if args.dry_run:
        # Dry diagnostics can coexist with the daemon, and never advance its ladder.
        con = connect(":memory:")
        disk = STATE / "monitor.db"
        if disk.exists():
            source = sqlite3.connect(f"file:{disk}?mode=ro", uri=True, timeout=5)
            source.backup(con)
            source.close()
        print(json.dumps(tick(con, True), sort_keys=True))
        con.close()
        return
    with (STATE / "monitor.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("offbox monitor: another instance holds the lock")
            return
        con = connect(STATE / "monitor.db")
        pending = {}
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="offbox-maintenance") as pool:
            while True:
                start = time.monotonic()
                try:
                    result = tick(con)
                    maintenance(con, time.time(), pool, pending)
                    if args.once:
                        print(json.dumps(result, sort_keys=True))
                        break
                except Exception as error:
                    # Do not log exception bodies: HTTP errors may include secrets.
                    log("sample-error type=" + type(error).__name__)
                    if args.once:
                        raise SystemExit(1) from None
                time.sleep(max(0, 10 - (time.monotonic() - start)))
        con.close()


if __name__ == "__main__":
    main()
