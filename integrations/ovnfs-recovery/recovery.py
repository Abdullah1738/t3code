#!/usr/bin/python3
"""Recover only after an observed disappearance of the configured SSD mount."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import threading
from contextlib import contextmanager
from datetime import datetime, timezone


VOLUME = "/Volumes/ExternalSSD"
STATE = VOLUME + "/.ovnfs"
MOUNT = str(Path.home() / "checkouts")
BINARY = str(Path.home() / ".local/bin/ovnfs")
RUNTIME = Path.home() / ".local/state/ovnfs-recovery"
PAUSE = Path.home() / ".local/state/ovnfs-memguard/pause-until"
# This build has serialized starts, loading status, saved-port fencing and TERM
# keep-mount. A version number alone cannot establish those fork capabilities.
SUPPORTED_BUILD = "e2f9f0e629a1"
BIRTH_PREFIX = "ps-utc-v1:"


def run(args, timeout=5, env=None):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL, cwd="/", env=env)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, "", str(e)


def mount_source(output, path):
    for line in output.splitlines():
        source, sep, rest = line.partition(" on ")
        target, sep2, _ = rest.rpartition(" (")
        if sep and sep2 and target == path:
            return source
    return None


def classify(code, out, err):
    try:
        data = json.loads(out)
        if not isinstance(data, dict):
            return "unknown", {}
        if data.get("status") == "loading":
            return "loading", data
        if code == 0 and type(data.get("pid")) is int and data["pid"] > 1:
            return "ready", data
    except ValueError:
        pass
    text = (out + " " + err).lower()
    if "permission denied" in text or "can't read state" in text:
        return "unreadable", {}
    if "already open" in text or "starting or unresponsive" in text:
        return "held", {}
    if "saved port" in text or "cannot bind persisted" in text:
        return "port", {}
    if code == 1 and text.strip() == "not running":
        return "absent", {}
    return "unknown", {}


def decide(pending, kind, mounted):
    if not pending:
        return "observe"
    if kind == "ready" and mounted:
        return "recovered"
    if kind == "absent":
        return "start"
    if kind in ("held", "port"):
        return "check-old-owner"
    return "wait"


def birth(pid):
    # ps lstart uses local time and locale by default; changed display text
    # must never become evidence that a still-live process was replaced.
    code, out, _ = run(["/bin/ps", "-p", str(pid), "-o", "lstart="],
                       env=dict(os.environ, TZ="UTC", LC_ALL="C", LANG="C"))
    if code:
        return ""
    try:
        _, month, day, clock, year = out.split()
        hours, minutes, seconds = map(int, clock.split(":"))
        months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
        stamp = datetime(int(year), months.index(month) + 1, int(day),
                         hours, minutes, seconds, tzinfo=timezone.utc)
        return BIRTH_PREFIX + str(int(stamp.timestamp()))
    except (ValueError, OverflowError):
        return ""


def supported_birth(value):
    return (isinstance(value, str) and value.startswith(BIRTH_PREFIX)
            and value[len(BIRTH_PREFIX):].isascii() and value[len(BIRTH_PREFIX):].isdigit())


def recorded_exit(old):
    if (not isinstance(old, dict) or type(old.get("pid")) is not int
            or old["pid"] <= 1 or not isinstance(old.get("birth"), str) or not old["birth"]):
        return False
    current = birth(old["pid"])
    if current and current == old["birth"]:
        return False
    if supported_birth(current) and supported_birth(old["birth"]):
        return True
    # Legacy display strings or a newer identity format are not comparable.
    # Only an explicit ESRCH can authorize replacement without comparable births.
    try:
        os.kill(old["pid"], 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        pass
    return False


@contextmanager
def lease(path):
    # Do not unlink lock files: doing so permits two holders on different inodes.
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "r+") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield f


def receipt_safe(path):
    try:
        data = json.loads(path.read_text())
        return isinstance(data, dict) and data.get("phase") == "done"
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return False


def mount_matches(data, source, stats):
    port = data.get("port")
    if data.get("proto") != "nfs" or type(port) is not int or not 0 <= port <= 65535:
        return False
    expected = "<" + STATE + "/nfs.sock>:/" if port == 0 else "127.0.0.1:/"
    if source != expected or not isinstance(stats, dict):
        return False
    entry = stats.get(expected, {})
    if not isinstance(entry, dict) or entry.get("Mount Point") != MOUNT:
        return False
    params = entry.get("Current mount parameters", {})
    if not isinstance(params, dict):
        return False
    params = params.get("NFS parameters", [])
    address = STATE + "/nfs.sock" if port == 0 else str(port)
    return isinstance(params, list) and all(p in params for p in
        ["ticotsord" if port == 0 else "tcp", "port=" + address, "mountport=" + address])


class Recovery:
    def __init__(self, runtime=RUNTIME):
        self.runtime = Path(runtime)
        self.journal = self.runtime / "state.json"
        self.data = json.loads(self.journal.read_text()) if self.journal.exists() else {}
        self.last_status = float("-inf")
        self.next_attempt = 0

    def save(self):
        tmp = self.journal.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data) + "\n")
        tmp.replace(self.journal)

    def log(self, message):
        print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)

    def mounts(self):
        code, out, err = run(["/sbin/mount"])
        if code:
            raise RuntimeError("mount inventory unavailable: " + err)
        return mount_source(out, VOLUME), mount_source(out, MOUNT)

    def status(self):
        result = run([BINARY, "--state", STATE, "--mount", MOUNT, "--json", "status"])
        kind, data = classify(*result)
        if kind == "ready" and (data.get("state") != STATE or data.get("mount") != MOUNT):
            return "unknown", {}
        return kind, data

    def identity(self, data):
        pid = data.get("pid")
        if type(pid) is not int or pid <= 1:
            return None
        started = birth(pid)
        return {"pid": pid, "birth": started, "port": data.get("port", 0)} if started else None

    def owner_matches(self, old):
        if not old or not old.get("birth") or birth(old["pid"]) != old["birth"]:
            return False
        # Exact descriptors or the exact persisted listener, never process names.
        code, out, _ = run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(old["pid"]), "-t",
                            STATE + "/state.lock"])
        if code == 0 and out.splitlines() == [str(old["pid"])]:
            return True
        port = old.get("port")
        if type(port) is int and 0 < port <= 65535:
            code, out, _ = run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(old["pid"]),
                                "-iTCP:" + str(port), "-sTCP:LISTEN", "-t"])
            return code == 0 and out.splitlines() == [str(old["pid"])]
        return False

    def memguard_running(self):
        code, out, _ = run(["/bin/launchctl", "print", "gui/" + str(os.getuid()) +
                            "/com.abdullah.ovnfs-memguard"])
        # Missing/unreadable launchd inventory is not exclusion proof.
        return code != 0 or "state = running" in out

    @contextmanager
    def pause_memguard(self):
        PAUSE.parent.mkdir(parents=True, exist_ok=True)
        own = self.runtime / "memguard-pause"
        if PAUSE.exists():
            # A hardlink proves ownership after a crash, unlike a timestamp that
            # could also have been written by a manual recovery.
            if not own.exists() or not os.path.samefile(own, PAUSE):
                yield False
                return
            token = own.read_text()
            try:
                expires = int(token.strip())
            except ValueError:
                self.log("malformed own memguard pause; needs operator")
                yield False
                return
            if expires <= time.time():
                self.log("30-minute recovery pause expired; needs operator")
                yield False
                return
            if self.data.get("pause") != token:
                self.log("published pause changed; needs operator")
                yield False
                return
            yield not self.memguard_running()
            return
        token = str(int(time.time()) + 1800) + "\n"
        self.data["pause"] = token
        self.save()  # intent must survive before publishing the pause
        own.write_text(token)
        try:
            os.link(own, PAUSE)
        except FileExistsError:
            if not os.path.samefile(own, PAUSE):
                yield False
                return
        yield not self.memguard_running()

    def release_pause(self):
        own = self.runtime / "memguard-pause"
        if (own.exists() and PAUSE.exists() and os.path.samefile(own, PAUSE)
                and PAUSE.read_text() == self.data.get("pause")):
            PAUSE.unlink()
        self.data.pop("pause", None)

    def mount_ready(self, data, source):
        code, out, _ = run(["/usr/bin/nfsstat", "-m", "-f", "JSON"])
        try:
            return code == 0 and mount_matches(data, source, json.loads(out))
        except ValueError:
            return False

    def start(self):
        # Ordinary `start` can retry a recorded forced unmount. Fence that path
        # under start.lock, then transfer the lease through the pinned build's
        # inherited-start descriptor, so no competing CLI can change the receipt
        # between this check and serve's own finishRecovery.
        with lease(Path(STATE) / "start.lock") as lock:
            if not lock:
                return
            if not receipt_safe(Path(STATE) / "unmount.json"):
                self.log("unfinished or unreadable unmount receipt; needs operator")
                return
            # Remount can revoke the old lock/socket generation. A negative
            # status is not enough while our recorded daemon is still alive.
            if not recorded_exit(self.data.get("old")):
                self.log("pre-drop daemon has not verifiably exited; needs operator")
                return
            volume, source = self.mounts()
            if self.status()[0] != "absent" or not volume:
                return
            if source is not None:
                try:
                    saved = json.loads((Path(STATE) / "state.json").read_text())
                except (OSError, ValueError):
                    return
                if not isinstance(saved, dict) or not self.mount_ready(saved, source):
                    self.log("existing mount does not match saved NFS transport; needs operator")
                    return
            with open(Path(STATE) / "serve.log", "ab") as log:
                child = subprocess.Popen(
                    [BINARY, "--state", STATE, "--mount", MOUNT, "serve", "--proto", "nfs",
                     "--starter-pid", str(os.getpid()), "--starter-fd", str(lock.fileno())],
                    pass_fds=(lock.fileno(),), start_new_session=True, cwd="/",
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            threading.Thread(target=child.wait, daemon=True).start()
            self.log("spawned ovnfs serve pid %s with inherited start lease" % child.pid)

    def recover(self, action):
        code, out, _ = run([BINARY, "version"])
        if code or SUPPORTED_BUILD not in out:
            self.log("unsupported ovnfs build; recovery requires reviewed TERM keep-mount/start fencing")
            return
        with self.pause_memguard() as paused:
            if not paused:
                self.log("another recovery or memguard owns the pause; waiting")
                return
            if not self.mounts()[0]:
                return
            if action == "check-old-owner":
                with lease(Path(STATE) / "start.lock") as locked:
                    if not locked:
                        return
                    kind, _ = self.status()
                    if kind not in ("held", "port"):
                        return
                    old = self.data.get("old")
                    if not self.owner_matches(old):
                        self.log("unresponsive holder is not the recorded pre-drop owner; needs operator")
                        return
                    if self.data.get("signalled") == old:
                        self.log("recorded daemon still alive after TERM; needs operator (no force kill)")
                        return
                    # Persist intent before signalling: a watcher crash must not send
                    # another shutdown request to the same daemon after resumption.
                    self.data["signalled"] = old
                    self.save()
                    self.log("TERM exact pre-drop daemon pid %s (keep-mount)" % old["pid"])
                    os.kill(old["pid"], signal.SIGTERM)
                return
            # The pinned serve owns stale socket cleanup. Never remove state,
            # sockets, ports or checkout contents here.
            kind, _ = self.status()
            if kind == "absent" and self.mounts()[0]:
                self.start()

    def tick(self):
        volume, mounted = self.mounts()
        if volume is None:
            if self.data.get("seen"):
                if not self.data.get("pending"):
                    self.data["old"] = self.data.get("owner")
                    self.data.pop("signalled", None)
                    self.log("SSD disappeared; retaining pre-drop daemon identity")
                self.data["pending"] = True
                self.data["stable"] = 0
                self.save()
            return
        self.data["seen"] = True
        pending = self.data.get("pending", False)
        if pending:
            self.data["stable"] = self.data.get("stable", 0) + 1
            if self.data["stable"] < 5:
                self.save()
                return
        if not pending and time.monotonic() - self.last_status < 30:
            return
        self.last_status = time.monotonic()
        kind, data = self.status()
        action = decide(pending, kind, kind == "ready" and self.mount_ready(data, mounted))
        if kind == "ready":
            self.data["owner"] = self.identity(data)
        if action == "recovered":
            self.data["pending"] = False
            self.release_pause()
            self.log("recovered: status ready and expected NFS mount present, pid %s" % data["pid"])
        self.save()
        if action in ("start", "check-old-owner") and time.monotonic() >= self.next_attempt:
            self.next_attempt = time.monotonic() + 30
            self.recover(action)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="one monitor tick (may recover after recorded drop)")
    args = parser.parse_args()
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with lease(RUNTIME / "watch.lock") as locked:
        if not locked:
            return
        watcher = Recovery()
        watcher.log("monitor started for " + VOLUME + "; no recovery without an observed drop")
        while True:
            try:
                watcher.tick()
            except Exception as e:
                watcher.log("recovery deferred: " + str(e))
            if args.once:
                return
            time.sleep(1)


if __name__ == "__main__":
    main()
