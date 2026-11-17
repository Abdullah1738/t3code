"""Install heartbeat ownership and its detached beater."""
import argparse
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from guard import HOLD_MAX_AGE, atomic_json, finite_number, pid_alive, read_json, valid_hold
from quit_reason import write_reason, desktop_pid


class Holds:
    def __init__(self, home):
        self.home = home
        self.path = home / ".robob/install-hold.json"
        self.root = home / ".local/state/robob-guard"
        self.meta = self.root / "hold-beater.json"

    @contextmanager
    def locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "hold.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def matches(self, by, pid):
        hold = read_json(self.path, {})
        return isinstance(hold, dict) and hold.get("by") == by and hold.get("pid") == pid

    def beat(self, by, pid, token=None):
        with self.locked():
            meta = read_json(self.meta, {})
            if not self.matches(by, pid) or not pid_alive(pid) or (token and meta.get("token") != token):
                return False
            hold = read_json(self.path, {})
            now = time.time()
            if not finite_number(hold.get("startedAt")) or not 0 <= now - hold["startedAt"] < HOLD_MAX_AGE:
                return False
            hold["beatAt"] = now
            atomic_json(self.path, hold)
            return True

    def start(self, by, pid):
        with self.locked():
            if not pid_alive(pid):
                raise ValueError("install PID is not alive")
            now = time.time()
            old = read_json(self.path, {})
            if (isinstance(old, dict) and not self.matches(by, pid) and pid_alive(old.get("pid"))):
                raise ValueError("another live installer owns the hold; stop its cycle before starting another")
            started = now
            if self.matches(by, pid):
                started = old.get("startedAt")
                if not finite_number(started) or not 0 <= now - started < HOLD_MAX_AGE:
                    raise ValueError("hold expired; stop the old cycle before starting another")
            if valid_hold(old, now, pid_alive(old.get("pid")) if isinstance(old, dict) else False):
                if not self.matches(by, pid):
                    raise ValueError("another live installer owns the hold")
                meta = read_json(self.meta, {})
                if self.beater_is_ours(meta):
                    self.record_quit_reason(by, pid)
                    return meta["beaterPid"]
            token = uuid.uuid4().hex
            atomic_json(self.path, dict(by=by, pid=pid, startedAt=started, beatAt=now))
            command = [sys.executable, str(Path(__file__).resolve()), "_beater", "--by", by,
                       "--pid", str(pid), "--token", token]
            try:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
                                         env=dict(os.environ, HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1"))
                atomic_json(self.meta, dict(by=by, pid=pid, token=token, beaterPid=child.pid))
                self.record_quit_reason(by, pid)
            except Exception:
                self.path.unlink(missing_ok=True)
                raise
            return child.pid

    def record_quit_reason(self, by, pid):
        # This watchdog holds immediately before its AppleEvent/SIGTERM fallback.
        # Other holders may still be doing build preflight, so they opt in later.
        if by == "overload-restart":
            target = desktop_pid()
            if target is None:
                raise ValueError("expected one Robob desktop before watchdog quit")
            write_reason(self.home, "watchdog", by, pid, target)

    def beater_is_ours(self, meta):
        if not isinstance(meta, dict) or not pid_alive(meta.get("beaterPid")) or not meta.get("token"):
            return False
        try:
            args = subprocess.run(["/bin/ps", "-ww", "-p", str(meta["beaterPid"]), "-o", "command="],
                                  capture_output=True, check=True, text=True, timeout=5).stdout.split()
            # Check generation as well as PID before signalling a saved process.
            return "_beater" in args and meta["token"] in args
        except (OSError, subprocess.SubprocessError):
            return False

    def stop(self, by, pid):
        with self.locked():
            if not self.matches(by, pid):
                return False
            meta = read_json(self.meta, {})
            self.path.unlink()
            if meta.get("by") == by and meta.get("pid") == pid:
                if self.beater_is_ours(meta):
                    try:
                        os.kill(meta["beaterPid"], signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                self.meta.unlink(missing_ok=True)
            return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["start", "beat", "stop", "_beater"])
    parser.add_argument("--by", required=True)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--token")
    args = parser.parse_args()
    if args.pid <= 0 or not args.by.strip():
        parser.error("a positive PID and nonempty name are required")
    holds = Holds(Path.home())
    if args.command == "start":
        try:
            print(holds.start(args.by, args.pid))
        except (ValueError, OSError) as error:
            parser.exit(1, str(error) + "\n")
    elif args.command == "beat":
        return 0 if holds.beat(args.by, args.pid) else 1
    elif args.command == "stop":
        holds.stop(args.by, args.pid)
    else:
        while holds.beat(args.by, args.pid, args.token):
            time.sleep(20)
    return 0


if __name__ == "__main__":
    sys.exit(main())
