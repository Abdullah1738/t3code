#!/usr/bin/python3
"""Recover only after an observed disappearance of the configured SSD mount."""
import argparse
import ctypes
import errno
import hashlib
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time
import threading
from contextlib import contextmanager, ExitStack
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


def process_args(pid):
    # KERN_PROCARGS2 keeps argv attached to the process when its state-volume
    # vnodes disappear. Never log/persist raw argv or the trailing environment.
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "cannot inspect process arguments")
    if not 4 < size.value <= 1024 * 1024:
        raise ValueError("invalid kernel argument size")
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), "cannot inspect process arguments")
    return decode_args(buf.raw[:size.value])


def decode_args(raw):
    count = int.from_bytes(raw[:4], "little", signed=True)
    if not 0 < count <= len(raw):
        raise ValueError("invalid kernel argument count")
    end = raw.index(b"\0", 4)
    executable = os.fsdecode(raw[4:end])
    rest = raw[end + 1:].lstrip(b"\0")
    args = []
    for _ in range(count):
        end = rest.index(b"\0")
        args.append(os.fsdecode(rest[:end]))
        rest = rest[end + 1:]
    return executable, args


def state_arguments(args):
    states = []
    i = 1
    while i < len(args):
        flag, equal, value = args[i].partition("=")
        if flag in ("--state", "-state"):
            if not equal:
                i += 1
                if i >= len(args):
                    return None
                value = args[i]
            states.append(value)
        i += 1
    return states


def serves_state(process):
    _, args = process
    # Both forms are emitted by the pinned CLI: globals before `serve`, or
    # `serve -state ...`. Unknown leading options cannot prove ownership.
    i = 1
    while i < len(args) and args[i].startswith("-"):
        flag, equal, _ = args[i].partition("=")
        if flag in ("--json", "-json"):
            i += 1
        elif flag in ("--state", "-state", "--mount", "-mount",
                      "--daemon-timeout", "--color"):
            i += 1 if equal else 2
        else:
            return False
    states = state_arguments(args)
    return (i < len(args) and args[i] == "serve" and bool(states)
            and all(os.path.isabs(value) and os.path.normpath(value) == STATE for value in states))


def args_digest(process):
    return hashlib.sha256(json.dumps(process, ensure_ascii=True).encode()).hexdigest()


def file_identity(stat):
    return stat.st_dev, stat.st_ino


def same_lock_domain(left, right):
    # dev/inode can repeat across remounts. A temporary POSIX lock, queried by
    # another process, proves that the two descriptors reach the same kernel
    # lock domain. The pinned CLI uses flock, which also conflicts with this
    # marker on Darwin. A busy marker is a veto, never an identity result.
    try:
        fcntl.lockf(left, fcntl.LOCK_EX | fcntl.LOCK_NB, 1)
    except BlockingIOError:
        return None
    try:
        result = subprocess.run(
            [sys.executable, __file__, "--lock-owner", str(right)], pass_fds=(right,),
            capture_output=True, text=True, timeout=3, stdin=subprocess.DEVNULL, cwd="/")
        if result.returncode:
            raise RuntimeError("lock domain could not be verified")
        owner = int(result.stdout)
        return owner == os.getpid()
    finally:
        fcntl.lockf(left, fcntl.LOCK_UN, 1)


def directory_probe(fd):
    # A subprocess can enter a retained directory vnode without changing the
    # watcher's cwd. Relative sockets and exact-file lsof then address the old
    # generation even when STATE names a newly mounted directory.
    result = subprocess.run(
        [sys.executable, __file__, "--probe-dir", str(fd)], pass_fds=(fd,),
        capture_output=True, text=True, timeout=8, stdin=subprocess.DEVNULL, cwd="/")
    if result.returncode:
        raise RuntimeError("retained state directory cannot be inspected")
    data = json.loads(result.stdout)
    if (not isinstance(data, dict) or type(data.get("live")) is not bool
            or not isinstance(data.get("holders"), list)
            or not all(type(pid) is int and pid > 1 for pid in data["holders"])):
        raise RuntimeError("invalid directory probe")
    return data


def probe_directory(fd):
    os.fchdir(fd)
    live = False
    peers = []
    paths = ["state.lock"]
    for path in ("admin.sock", "nfs.sock"):
        try:
            os.stat(path)
        except FileNotFoundError:
            continue
        paths.append(path)
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(1)
            try:
                client.connect(path)
                live = True
                # Kernel peer identity is exclusion evidence only. It never
                # supplies authority to signal a process not recorded by status.
                peers.append(client.getsockopt(0, 2))  # Darwin LOCAL_PEERPID
            except OSError as e:
                if e.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                    raise
    result = subprocess.run(["/usr/sbin/lsof", "-nP", "-t", "--"] + paths,
                            capture_output=True, text=True, timeout=5,
                            stdin=subprocess.DEVNULL)
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise RuntimeError("exact-file owner probe unavailable")
    print(json.dumps({"live": live, "holders": peers + [int(pid) for pid in result.stdout.split()]}))


class Generation:
    def __init__(self, path):
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        self.witnesses = {}
        try:
            self.key = file_identity(os.fstat(self.fd))
            for name in ("start.lock", "state.lock"):
                self.witnesses[name] = os.open(name, os.O_RDWR, dir_fd=self.fd)
        except Exception:
            self.close()
            raise

    def close(self):
        for fd in self.witnesses.values():
            os.close(fd)
        self.witnesses = {}
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    @contextmanager
    def lock(self, name):
        if self.fd is None:
            raise RuntimeError("retained state directory is closed; needs operator")
        with os.fdopen(os.open(name, os.O_RDWR, dir_fd=self.fd), "r+") as file:
            same = same_lock_domain(self.witnesses[name], file.fileno())
            if same is None:
                yield False
                return
            if not same:
                raise RuntimeError("state lock generation changed; needs operator")
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            yield file

    def probe(self):
        with self.lock("state.lock") as free:
            data = directory_probe(self.fd)
            data["quiet"] = bool(free) and not data["live"]
            data["holders"] = set(data["holders"]) - {os.getpid()}
            return data


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
        self.generations = []
        # A healthy journal cannot restore the previous process's open FDs.
        # Only a fresh healthy observation can arm this watcher instance.
        self.unwitnessed = True
        self.returning = False

    def close_generations(self):
        for generation in self.generations:
            generation.close()
        self.generations = []

    def remember_generation(self):
        generation = Generation(STATE)
        self.close_generations()
        self.generations = [generation]
        self.unwitnessed = False

    def observe_generation(self):
        try:
            key = file_identity(os.stat(STATE))
            if self.returning or not self.generations or self.generations[-1].key != key:
                self.generations.append(Generation(STATE))
                self.returning = False
        except OSError:
            self.unwitnessed = True
            raise

    @contextmanager
    def start_fence(self):
        if self.unwitnessed or not self.generations:
            self.log("no retained pre-drop state generation; needs operator")
            yield None
            return
        if any(generation.fd is None for generation in self.generations):
            raise RuntimeError("retained state directory is closed; needs operator")
        self.observe_generation()
        current = Generation(STATE)
        try:
            same = same_lock_domain(self.generations[-1].witnesses["start.lock"],
                                    current.witnesses["start.lock"])
        except Exception:
            current.close()
            raise
        if same is None:
            current.close()
            yield None
            return
        if same:
            current.close()
        else:
            self.generations.append(current)
        generations = self.generations
        unique = []
        groups = {}
        for generation in reversed(generations):
            for group, other in enumerate(unique):
                same = same_lock_domain(generation.witnesses["start.lock"],
                                        other.witnesses["start.lock"])
                if same is None:
                    yield None
                    return
                if same:
                    groups[id(generation)] = group
                    break
            else:
                groups[id(generation)] = len(unique)
                unique.append(generation)
        with ExitStack() as stack:
            locks = [stack.enter_context(generation.lock("start.lock"))
                     for generation in unique]
            if not all(locks):
                yield None
                return
            probes = [dict(generation.probe(), current=groups[id(generation)] == 0)
                      for generation in generations]
            yield locks[0], probes

    def peer_recovery_safe(self):
        with self.start_fence() as fence:
            return bool(fence) and all(probe["quiet"] for probe in fence[1] if not probe["current"])

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
        if not started:
            return None
        identity = {"pid": pid, "birth": started, "port": data.get("port", 0)}
        try:
            process = process_args(pid)
            if serves_state(process) and birth(pid) == started:
                identity["args_digest"] = args_digest(process)
        except (OSError, ValueError):
            pass
        return identity

    def owner_matches(self, old, process=None):
        if not old or not old.get("birth") or birth(old["pid"]) != old["birth"]:
            return False
        if (process is not None and serves_state(process)
                and old.get("args_digest") == args_digest(process)):
            return True
        # Exact descriptors or the exact persisted listener remain sufficient
        # for journals made before argument proofs were recorded.
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
        with self.start_fence() as fence:
            if not fence:
                return
            lock, probes = fence
            if not receipt_safe(Path(STATE) / "unmount.json"):
                self.log("unfinished or unreadable unmount receipt; needs operator")
                return
            # Remount can revoke the old lock/socket generation. A negative
            # status is not enough while our recorded daemon is still alive.
            if not recorded_exit(self.data.get("old")):
                self.log("pre-drop daemon has not verifiably exited; needs operator")
                return
            if not all(probe["quiet"] for probe in probes):
                self.log("a daemon or startup survives in a state generation; replacement refused")
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
            self.spawn(lock)

    def spawn(self, lock):
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
            with self.start_fence() as fence:
                if not fence:
                    return
                _, probes = fence
                kind, _ = self.status()
                if kind not in ("absent", "held", "port"):
                    return
                old = self.data.get("old")
                if not all(probe["quiet"] for probe in probes):
                    holders = set().union(*(probe["holders"] for probe in probes))
                    try:
                        process = process_args(old["pid"]) if old else None
                    except (OSError, ValueError):
                        process = None
                    if (not old or holders != {old.get("pid")}
                            or not self.owner_matches(old, process)):
                        self.log("surviving holder is not solely the verified pre-drop daemon; needs operator")
                        return
                    if self.data.get("signalled") == old:
                        self.log("recorded daemon still alive after TERM; needs operator (no force kill)")
                        return
                    self.data["signalled"] = old
                    self.save()
                    self.log("TERM verified pre-drop daemon pid %s (keep-mount)" % old["pid"])
                    os.kill(old["pid"], signal.SIGTERM)
                    return
                if kind != "absent":
                    return
            # Reacquire and repeat exclusion in start(): a peer may have won
            # the lease after our observation. No historical PID alone fences it.
            self.start()

    def tick(self):
        volume, mounted = self.mounts()
        if volume is None:
            if self.data.get("seen"):
                self.returning = True
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
            # Keep each returned generation, including a second drop before
            # recovery completes. A later current pathname cannot exclude it.
            self.observe_generation()
            self.data["stable"] = self.data.get("stable", 0) + 1
            if self.data["stable"] < 5:
                self.save()
                return
        if not pending and time.monotonic() - self.last_status < 30:
            return
        self.last_status = time.monotonic()
        kind, data = self.status()
        action = decide(pending, kind, kind == "ready" and self.mount_ready(data, mounted))
        if action == "recovered" and not self.peer_recovery_safe():
            action = "wait"
        if kind == "ready":
            self.data["owner"] = self.identity(data)
            if not pending or action == "recovered":
                self.remember_generation()
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
    parser.add_argument("--probe-dir", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--lock-owner", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.lock_owner is not None:
        # Darwin struct flock: off_t, off_t, pid_t, short, short.
        raw = fcntl.fcntl(args.lock_owner, fcntl.F_GETLK,
                          struct.pack("@qqihh", 0, 1, 0, fcntl.F_WRLCK, os.SEEK_SET))
        _, _, pid, kind, _ = struct.unpack("@qqihh", raw)
        print(pid if kind != fcntl.F_UNLCK else 0)
        return
    if args.probe_dir is not None:
        probe_directory(args.probe_dir)
        return
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
