#!/opt/homebrew/bin/python3
"""Start one detached janitor cycle; alert failures through Telegram, never stdout."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


STATE_DIR = Path(os.environ.get(
    "DEV_JANITOR_WATCH_STATE", os.path.expanduser("~/.local/share/dev-janitor/hourly")
))
STALE_SECONDS = 4 * 60 * 60
ALERT_SECONDS = 6 * 60 * 60


def write_json(path, state):
    fd, name = tempfile.mkstemp(prefix=f".{path.stem}-", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_state(state):
    write_json(STATE_DIR / "state.json", state)


def alert(kind, text):
    import dev_janitor

    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    # check and the prune subcommand can run concurrently; the worker owns a different lock/state file.
    with (STATE_DIR / "alerts.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = STATE_DIR / "alerts.json"
        try:
            saved = json.loads(path.read_text())
            last_alerts = saved.get("last_alerts", {}) if isinstance(saved, dict) else {}
            if not isinstance(last_alerts, dict):
                last_alerts = {}
        except (OSError, ValueError):
            last_alerts = {}
        now = time.time()
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        previous = last_alerts.get(kind, {})
        if not isinstance(previous, dict):
            previous = {}
        recent = previous.get("recent", {})
        recent = dict(recent) if isinstance(recent, dict) else {}
        # Keep the six-hour text history: alternating failures must not reset each other's cooldown.
        if isinstance(previous.get("text_hash"), str):
            recent.setdefault(previous["text_hash"], {"at": previous.get("at"),
                                                     "delivery_key": previous.get("delivery_key")})
        # Older state stored only timestamps. Keep its cooldown when upgrading.
        recent = {h: {"at": entry} if isinstance(entry, (int, float)) else entry
                  for h, entry in recent.items()}
        recent = {h: entry for h, entry in recent.items()
                  if isinstance(entry, dict) and isinstance(entry.get("at"), (int, float))
                  and now - entry["at"] < ALERT_SECONDS}
        deduped = text_hash in recent
        delivery_key = recent.get(text_hash, {}).get("delivery_key")
        telegram_ok = False
        error = "deduplicated for 6 hours" if deduped else None
        if not deduped:
            # Bridge keys are permanent. Persist a fresh identity per occurrence before a send can time out.
            delivery_key = f"dev-janitor:{kind}:{uuid.uuid4().hex}"
            recent[text_hash] = {"at": now, "delivery_key": delivery_key}
            last_alerts[kind] = {"text_hash": text_hash, "at": now, "delivery_key": delivery_key,
                                 "recent": recent}
            write_json(path, {"last_alerts": last_alerts})
            override = os.environ.get("DEV_JANITOR_TELEGRAM_CMD")
            cmd = [override] if override else [
                "/Users/ardud/.bun/bin/bun", "/Users/ardud/.local/share/telegram-bridge/src/cli.ts"]
            try:
                result = subprocess.run(
                    ["env", "-u", "BUN_INSPECT", *cmd, "notify", "--source", "Dev janitor",
                     "--severity", "attention", "--text", text, "--key", delivery_key],
                    capture_output=True, text=True, timeout=20)
                telegram_ok = result.returncode == 0
                if not telegram_ok:
                    error = f"Telegram exited {result.returncode}: {result.stderr.strip()}"[:500]
            except (OSError, subprocess.SubprocessError) as e:
                error = str(e)[:500]
        dev_janitor.audit({"ts": now, "event": "alert", "kind": kind, "text": text,
                           "telegram_ok": telegram_ok, "error": error, "deduplicated": deduped,
                           "delivery_key": delivery_key})


def read_state():
    try:
        with (STATE_DIR / "state.json").open() as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {"status": "failed", "error": "unreadable worker state"}


def check():
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE_DIR / "lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            state = read_state()
            if time.time() - state.get("started_at", time.time()) > STALE_SECONDS:
                alert("worker_stale", "dev-janitor: hourly worker still running after 4 hours")
            return

        previous = read_state()
        # Report-only findings and liveness problems are already in audit.jsonl (record_report).
        # Any stdout from this check reaches the owner's iMessage, so failures use Telegram too.
        if previous.get("status") == "running":
            alert("worker_lost", "dev-janitor: previous hourly worker exited without recording a result")
        elif previous.get("status") == "failed":
            alert("worker_failed", "dev-janitor: " + str(previous.get("error", "hourly worker failed"))[:500])

        write_state({"status": "running", "started_at": time.time()})
        try:
            # The check runner kills its own process group after 60s. A new session and closed pipes let the
            # worker finish independently; the inherited flock prevents another hourly cycle from overlapping.
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "worker", str(lock.fileno())],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, pass_fds=(lock.fileno(),))
        except Exception as e:  # noqa: BLE001
            write_state({"status": "failed", "error": f"could not start hourly worker: {e}"})
            alert("spawn_failed", f"dev-janitor: could not start hourly worker: {e}"[:500])


def worker(lock_fd):
    # The parent acquired this lock before spawning us; keep its inherited file descriptor open until exit.
    os.fstat(lock_fd)
    started = time.monotonic()
    stats = {"found": 0, "killed": 0}
    ok = False
    dev_janitor = None
    try:
        import dev_janitor

        scan = dev_janitor.scan()
        dev_janitor.record_report(scan)
        stats["found"] = len(scan["resources"])
        candidates = scan["candidates"]
        if candidates:
            # apply() re-scans immediately before *each* action; do not act on the initial snapshot alone.
            results = dev_janitor.apply(",".join(candidates), stats)
            failures = [f"{r['id']} ({r.get('msg') or r.get('action')})"
                        for r in results if not r.get("ok") and r.get("action") != "skipped"]
            if failures:
                raise RuntimeError("apply failed: " + "; ".join(failures))
        ok = True
        write_state({"status": "ok", "finished_at": time.time(),
                     "liveness_unavailable": scan.get("liveness_unavailable"),
                     "processes": {key: scan.get("processes", {}).get(key, []) for key in ("candidates", "problems", "checked", "skipped", "budget_skipped")}})
    except Exception as e:  # noqa: BLE001
        write_state({"status": "failed", "error": str(e)[:500], "finished_at": time.time()})
        return 1
    finally:
        if dev_janitor is not None:
            dev_janitor.log_run(started, stats["found"], stats["killed"], ok)
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        check()
    elif len(sys.argv) == 3 and sys.argv[1] == "worker":
        sys.exit(worker(int(sys.argv[2])))
    elif len(sys.argv) == 4 and sys.argv[1] == "alert":
        alert(sys.argv[2], sys.argv[3])
    else:
        sys.exit("usage: janitor_watch.py check | worker FD | alert KIND TEXT")
