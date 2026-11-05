#!/opt/homebrew/bin/python3
"""Start one detached janitor cycle and report the previous cycle's failure to robob-watch."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


STATE_DIR = Path(os.environ.get(
    "DEV_JANITOR_WATCH_STATE", os.path.expanduser("~/.local/share/dev-janitor/hourly")
))
STALE_SECONDS = 4 * 60 * 60


def write_state(state):
    fd, name = tempfile.mkstemp(prefix=".state-", dir=STATE_DIR)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(state, f)
        os.replace(name, STATE_DIR / "state.json")
    finally:
        if os.path.exists(name):
            os.unlink(name)


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
                print("dev-janitor: hourly worker still running after 4 hours")
            return

        previous = read_state()
        if previous.get("status") == "running":
            print("dev-janitor: previous hourly worker exited without recording a result")
        elif previous.get("status") == "failed":
            print("dev-janitor: " + str(previous.get("error", "hourly worker failed"))[:500])

        write_state({"status": "running", "started_at": time.time()})
        try:
            # The check runner kills its own process group after 60s. A new session and closed pipes let the
            # worker finish independently; the inherited flock prevents another hourly cycle from overlapping.
            subprocess.Popen([sys.executable, os.path.abspath(__file__), "worker", str(lock.fileno())],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, pass_fds=(lock.fileno(),))
        except Exception as e:  # noqa: BLE001
            write_state({"status": "failed", "error": f"could not start hourly worker: {e}"})
            print(f"dev-janitor: could not start hourly worker: {e}")


def worker(lock_fd):
    # The parent acquired this lock before spawning us; keep its inherited file descriptor open until exit.
    os.fstat(lock_fd)
    try:
        import dev_janitor

        scan = dev_janitor.scan()
        os.makedirs(dev_janitor.LOG_DIR, exist_ok=True)
        with open(dev_janitor.LAST, "w") as f:
            json.dump(scan, f, indent=1)
        candidates = scan["candidates"]
        if candidates:
            # apply() re-scans immediately before *each* action; do not act on the initial snapshot alone.
            results = dev_janitor.apply(",".join(candidates))
            failures = [f"{r['id']} ({r.get('msg') or r.get('action')})"
                        for r in results if not r.get("ok") and r.get("action") != "skipped"]
            if failures:
                raise RuntimeError("apply failed: " + "; ".join(failures))
        write_state({"status": "ok", "finished_at": time.time()})
    except Exception as e:  # noqa: BLE001
        write_state({"status": "failed", "error": str(e)[:500], "finished_at": time.time()})
        return 1
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["check"]:
        check()
    elif len(sys.argv) == 3 and sys.argv[1] == "worker":
        sys.exit(worker(int(sys.argv[2])))
    else:
        sys.exit("usage: janitor_watch.py check")
