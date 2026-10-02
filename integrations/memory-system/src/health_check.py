#!/opt/homebrew/bin/python3
"""Memory-system pipeline health check (launchd: com.abdullah.memory-health).

Checks that the whole pipeline is flowing, not just that processes exist:
  sync      raw capture stage (com.abdullah.memory-sync) succeeded recently
  lag       native OpenCode sessions older than 30 min are in memory.db
  extract   fact extraction is keeping up and under budget
  mcp       memory MCP answers on :18765
  janitor   daily janitor ran and exited 0
  backup    last memory backup succeeded recently
  dropbox   Dropbox copy of the live backup repo is complete (name + size)
  disk      internal disk has room
  session_reaper   hourly deletion of 30-day-idle OpenCode sessions runs and is not stuck gated
  location_reaper  5-min cua-driver MCP cleanup runs without errors

Writes logs/health_last.json and logs/memory_check.log. Sends a Telegram
alert when a check starts failing (once per check per day while it keeps
failing) and an all-clear when it recovers. --dry-run prints and never
notifies.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import time

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".local/share/memory-system")
DATA = os.path.join(ROOT, "data")
LOGS = os.path.join(ROOT, "logs")
MEM_DB = os.path.join(DATA, "memory.db")
OC_DB = os.path.join(HOME, ".local/share/opencode/opencode.db")
LIVE_REPO = "/Volumes/ExternalSSD/memory-system-backup/restic/live"
DROPBOX_LIVE = "/Backups/memory-system/live"
STATE = os.path.join(LOGS, "health_state.json")
LAST = os.path.join(LOGS, "health_last.json")
BUN = os.path.join(HOME, ".bun/bin/bun")
TG_CLI = os.path.join(HOME, ".local/share/telegram-bridge/src/cli.ts")

SYNC_MAX_AGE = 15 * 60          # tick every 120 s
LAG_GRACE_MS = 30 * 60 * 1000   # settle window is 10 min
LAG_MAX = 3
EXTRACT_MAX_AGE = 6 * 3600
BUDGET = float(os.environ.get("MEMORY_EXTRACT_MONTHLY_BUDGET", "1000"))
BACKUP_MAX_AGE = 9 * 3600       # backup every 4 h
DISK_MIN_GB = 30


def ro(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    c.execute("PRAGMA busy_timeout=30000")
    return c


def launchd_exit(label):
    out = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"],
                         capture_output=True, text=True).stdout
    m = re.search(r"last exit code = (\d+|\(never exited\))", out)
    runs = re.search(r"\bruns = (\d+)", out)
    return (m.group(1) if m else None), (int(runs.group(1)) if runs else 0), bool(out)


def stage_status(name):
    """logs/<name>_last.json written by scripts/stage_lib.sh."""
    try:
        return json.load(open(os.path.join(LOGS, f"{name}_last.json")))
    except Exception:
        return None


def check_sync():
    # raw capture stage (scripts/memory_capture_tick.sh, own lock + deadline)
    _, _, loaded = launchd_exit("com.abdullah.memory-sync")
    if not loaded:
        return False, "memory-sync (capture) launch agent not loaded"
    st = stage_status("capture")
    if not st:
        return False, "no capture status (logs/capture_last.json)"
    last_ok = st.get("last_ok_ts") or 0
    age = time.time() - last_ok
    if age > SYNC_MAX_AGE:
        cur = f"; current run {st.get('state')} for {int(st.get('secs') or 0)} s" if st.get("state") == "running" \
            else f"; last run {st.get('state')} rc={st.get('rc')}"
        return False, f"last successful capture {int(age/60)} min ago{cur}"
    return True, f"last capture ok {int(age)} s ago"


def check_lag():
    mem = ro(MEM_DB)
    known = dict(mem.execute("SELECT session_id, time_updated FROM opencode_sync_sessions"))
    src = ro(OC_DB)
    cutoff = int(time.time() * 1000) - LAG_GRACE_MS
    behind = []
    for sid, tu, meta in src.execute("SELECT id, time_updated, metadata FROM session_v2 WHERE time_updated < ?", (cutoff,)):
        try:
            m = json.loads(meta) if meta else {}
        except ValueError:
            m = {}
        if isinstance(m, dict) and m.get("migration"):
            continue
        # -1 = sync saw the session but it still has an in-flight (unsettled)
        # message; session_v2.time_updated is not bumped by new messages, so
        # active sessions would otherwise look "behind". Sync staleness is
        # covered by check_sync.
        if known.get(sid) not in (tu, -1):
            behind.append(sid)
    if len(behind) > LAG_MAX:
        return False, f"{len(behind)} OpenCode sessions not synced into memory.db (e.g. {behind[0]})"
    return True, f"{len(behind)} sessions behind"


def check_extract():
    mem = ro(MEM_DB)
    last_run = mem.execute("SELECT max(created_at) FROM extraction_runs").fetchone()[0] or 0
    newest_event = mem.execute(
        "SELECT max(timestamp) FROM episodic_events WHERE source='opencode' AND timestamp > ?",
        (time.time() - 2 * 86400,)).fetchone()[0] or 0
    month = dt.date.today().replace(day=1).strftime("%s")
    spent = mem.execute("SELECT coalesce(sum(cost_usd),0) FROM extraction_runs WHERE created_at >= ?",
                        (int(month),)).fetchone()[0]
    if spent > 0.9 * BUDGET:
        return False, f"extraction spent ${spent:.0f} of ${BUDGET:.0f} this month"
    # Only stale if there is new conversation the extractor has not looked at.
    if newest_event - last_run > EXTRACT_MAX_AGE:
        return False, f"no fact extraction for {int((time.time()-last_run)/3600)} h despite new sessions"
    _, _, loaded = launchd_exit("com.abdullah.memory-extract")
    if not loaded:
        return False, "memory-extract launch agent not loaded"
    st = stage_status("extract") or {}
    if st.get("state") in ("timeout", "failed") and time.time() - (st.get("last_ok_ts") or 0) > 3600:
        return False, f"extraction runs failing (last: {st.get('state')} rc={st.get('rc')}), no success for {int((time.time() - (st.get('last_ok_ts') or 0)) / 60)} min"
    errs = 0
    files = sorted(glob.glob(os.path.join(LOGS, "extract-*.log")))[-1:]
    lines = [l for f in files for l in open(f, errors="replace") if l.startswith("DONE: ")][-10:]
    for l in lines:
        m = re.search(r"api_err=(\d+)", l)
        errs += int(m.group(1)) if m else 0
    if len(lines) >= 5 and errs >= 10:
        return False, f"{errs} extractor API errors in the last {len(lines)} ticks"
    return True, f"last run {int((time.time()-last_run)/60)} min ago, ${spent:.0f} this month"


def check_mcp():
    try:
        with socket.create_connection(("127.0.0.1", 18765), timeout=5):
            pass
    except OSError as e:
        return False, f"memory MCP not reachable on :18765 ({e})"
    return True, "listening"


def check_janitor():
    code, runs, loaded = launchd_exit("com.abdullah.memory-janitor")
    if not loaded:
        return False, "memory-janitor launch agent not loaded"
    if runs and code not in ("0", "(never exited)"):
        return False, f"janitor last exit code {code} (see logs/janitor.err.log)"
    p = os.path.join(LOGS, "janitor_last.json")
    if os.path.exists(p) and time.time() - os.path.getmtime(p) > 50 * 3600:
        return False, f"janitor has not run for {int((time.time()-os.path.getmtime(p))/3600)} h"
    # review session state (OpenChamber "Memory janitor review" sessions)
    rs = os.path.join(LOGS, "janitor-review", "state.json")
    try:
        st = json.load(open(rs))
    except Exception:
        st = None
    if st:
        status = st.get("status")
        if status == "failed":
            return False, f"janitor review session could not be opened: {str(st.get('error', ''))[:200]}"
        if status == "pending":
            age_d = (time.time() - (st.get("created_at") or 0)) / 86400
            if age_d > 7:
                return False, f"janitor review {st.get('review')} pending {int(age_d)} days (session {st.get('session_id')})"
            return True, f"exit {code}; review {st.get('review')} pending ({st.get('items')} items)"
        return True, f"exit {code}; review {st.get('review')} {status}"
    return True, f"exit {code}"


def check_backup():
    p = os.path.join(LOGS, "backup_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, "no backup status (logs/backup_last.json)"
    last_ok = st.get("last_success_ts") or 0
    if not st.get("ok"):
        return False, f"last backup failed at {st.get('stage')}: {st.get('message', '')[:200]}"
    if time.time() - last_ok > BACKUP_MAX_AGE:
        return False, f"last successful backup {int((time.time()-last_ok)/3600)} h ago"
    return True, f"snapshot {st.get('last_snapshot')} {int((time.time()-last_ok)/60)} min ago"


def check_dropbox():
    # independent of the backup job: Dropbox copy of the live repo matches the
    # local repo by name + size (full content_hash check runs in every backup)
    import sys
    sys.path.insert(0, os.path.join(ROOT, "src"))
    import dropbox_mirror as dm
    try:
        api = dm.Api()
        rem = api.list_files(DROPBOX_LIVE)
    except Exception as e:
        return False, f"Dropbox API/auth failed: {str(e)[:200]}"
    loc = dm.local_files(LIVE_REPO)
    missing = [k for k in loc if k not in rem or rem[k]["size"] != loc[k]["size"]]
    # packs written in the last backup run may still be uploading
    old = [k for k in missing if time.time() - os.path.getmtime(loc[k]["abs"]) > BACKUP_MAX_AGE]
    if old and os.path.isdir(os.path.join(LOGS, "backup.lock")):
        return True, f"backup running; {len(missing)} files still uploading to {DROPBOX_LIVE}"
    if old:
        return False, f"{len(old)} live repo files missing/different in Dropbox {DROPBOX_LIVE}"
    return True, f"{len(rem)} files in Dropbox {DROPBOX_LIVE} ({len(missing)} pending)"


def check_disk():
    free = shutil.disk_usage(HOME).free / 1e9
    if free < DISK_MIN_GB:
        return False, f"internal disk has {free:.0f} GB free"
    return True, f"{free:.0f} GB free"


def check_cold_finalize():
    # one-shot job that deletes the raw Codex/Hermes data once the cold archive is in Dropbox
    p = os.path.join(LOGS, "cold_finalize.json")
    try:
        st = json.load(open(p))
    except Exception:
        return True, "not started"
    if st.get("state") == "failed":
        return False, f"cold archive finalize failed: {st.get('message', '')[:200]}"
    return True, f"{st.get('state')}: {st.get('message', '')[:120]}"


def _reaper_status(name, max_age, ok_max_age=None):
    p = os.path.join(LOGS, f"{name}_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, f"{name} has never run ({p} missing)"
    age = time.time() - st.get("ts", 0)
    if age > max_age:
        return False, f"{name} last ran {age / 3600:.1f} h ago"
    if st.get("state") == "error":
        errs = "; ".join(str(e) for e in (st.get("errors") or [])[:3]) or st.get("message", "")
        return False, f"{name} failed: {errs[:200]}"
    if ok_max_age and time.time() - st.get("last_ok_ts", st.get("ts", 0)) > ok_max_age:
        return False, f"{name} has been gated since {time.strftime('%m-%d %H:%M', time.localtime(st.get('last_ok_ts', 0)))}: {st.get('message', '')[:160]}"
    return True, None


def check_session_reaper():
    # hourly: deletes OpenCode sessions idle 30+ days once memory + Dropbox backup are verified
    ok, msg = _reaper_status("session_reaper", 3 * 3600, ok_max_age=26 * 3600)
    if not ok:
        return ok, msg
    st = json.load(open(os.path.join(LOGS, "session_reaper_last.json")))
    return True, (f"{st.get('state')}: deleted {st.get('deleted_sessions', 0)} sessions this run, "
                  f"{st.get('remaining_trees', '?')} stale trees left, skipped {st.get('skipped', {})}")


def check_location_reaper():
    # every 5 min: disconnects cua-driver MCP from idle OpenCode locations
    ok, msg = _reaper_status("location_reaper", 30 * 60)
    if not ok:
        return ok, msg
    st = json.load(open(os.path.join(LOGS, "location_reaper_last.json")))
    return True, (f"{st.get('state')}: {st.get('cua_procs', '?')} cua-driver procs, "
                  f"{len(st.get('disconnected', []))} disconnected this run")


def check_worktree_reaper():
    # daily 04:30: removes linked git worktrees with no commits in 60 days and nothing ahead
    p = os.path.expanduser("~/.local/share/dev-janitor/worktree_reaper_last.json")
    try:
        st = json.load(open(p))
    except Exception:
        return False, f"worktree_reaper has never run ({p} missing)"
    age = time.time() - st.get("ts", 0)
    if age > 26 * 3600:
        return False, f"worktree_reaper last ran {age / 3600:.1f} h ago"
    if st.get("state") != "done":
        return False, "worktree_reaper failed: " + "; ".join(st.get("errors", [])[:3])[:200]
    return True, f"removed {len(st.get('removed', []))} worktrees this run, {st.get('worktrees', '?')} checked"


CHECKS = [("sync", check_sync), ("lag", check_lag), ("extract", check_extract),
          ("mcp", check_mcp), ("janitor", check_janitor), ("backup", check_backup),
          ("dropbox", check_dropbox), ("disk", check_disk), ("cold_finalize", check_cold_finalize),
          ("session_reaper", check_session_reaper), ("location_reaper", check_location_reaper),
          ("worktree_reaper", check_worktree_reaper)]


def notify(severity, text, key):
    r = subprocess.run([BUN, TG_CLI, "notify", "--source", "Memory health", "--severity", severity,
                        "--text", text, "--key", key], capture_output=True, text=True, timeout=60)
    return r.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    results = {}
    for name, fn in CHECKS:
        try:
            ok, msg = fn()
        except Exception as e:  # a crashing check is a failing check
            ok, msg = False, f"check crashed: {type(e).__name__}: {e}"
        results[name] = {"ok": ok, "msg": msg}

    try:
        state = json.load(open(STATE))
    except Exception:
        state = {}
    failing = state.get("failing", {})
    today = time.strftime("%Y%m%d")
    new_fail, recovered = [], []
    for name, r in results.items():
        if not r["ok"]:
            prev = failing.get(name)
            if not prev or prev.get("notified_day") != today:
                new_fail.append(name)
            failing[name] = {"since": (prev or {}).get("since", int(time.time())),
                             "msg": r["msg"], "notified_day": (prev or {}).get("notified_day")}
        elif name in failing:
            recovered.append(name)
            failing.pop(name)

    summary = {"ts": int(time.time()), "ok": all(r["ok"] for r in results.values()), "checks": results}
    if args.dry_run:
        print(json.dumps(summary, indent=1))
        return

    if new_fail:
        lines = [f"- {n}: {results[n]['msg']}" for n in new_fail]
        text = "Memory system problem:\n" + "\n".join(lines)
        key = "memory-health:" + today + ":" + ",".join(f"{n}@{failing[n]['since']}" for n in sorted(new_fail))
        if notify("error" if any(n in ("sync", "backup", "mcp") for n in new_fail) else "attention", text, key):
            for n in new_fail:
                failing[n]["notified_day"] = today
    if recovered:
        text = "Memory system recovered: " + ", ".join(recovered) + "."
        notify("info", text, f"memory-health:recovered:{int(time.time())}:{','.join(recovered)}")

    state["failing"] = failing
    for path, obj in ((STATE, state), (LAST, summary)):
        tmp = path + ".tmp"
        json.dump(obj, open(tmp, "w"), indent=1)
        os.replace(tmp, path)
    with open(os.path.join(LOGS, "memory_check.log"), "w") as f:
        f.write("ok\n" if summary["ok"] else
                "".join(f"FAIL {n}: {r['msg']}\n" for n, r in results.items() if not r["ok"]))


if __name__ == "__main__":
    main()
