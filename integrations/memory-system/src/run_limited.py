#!/opt/homebrew/bin/python3
"""Run a command in its own process group with a wall-clock limit."""

import argparse
import ctypes
from dataclasses import dataclass
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid

KILL_GRACE_SECONDS = 30
KILL_VERIFY_SECONDS = 5
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
MAX_REPLAY_BYTES = 65536


def child_exited_unreaped(process):
    # Popen.wait(timeout) may reap on newer Python versions. WNOWAIT keeps the
    # group leader's PID reserved while descendants still need SIGKILL.
    return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError) as exc:
        # Darwin can report EPERM when the group contains only a zombie.
        print(f"could not signal process group {pid}: {exc}", file=sys.stderr)


class DarwinIdentity(ctypes.Structure):
    # proc_uniqidentifierinfo (flavor 17). Unlike PPID, parent_uniqueid
    # survives reparenting to launchd, including after setsid().
    _fields_ = [("uuid", ctypes.c_byte * 16), ("uniqueid", ctypes.c_uint64),
                ("parent_uniqueid", ctypes.c_uint64), ("version", ctypes.c_int32),
                ("parent_version", ctypes.c_int32), ("reserved", ctypes.c_uint64 * 2)]


class DarwinBsdInfo(ctypes.Structure):
    # proc_bsdshortinfo (flavor 13) is readable for other users' processes too.
    _fields_ = [("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32),
                ("pgid", ctypes.c_uint32), ("status", ctypes.c_uint32),
                ("comm", ctypes.c_char * 16), ("flags", ctypes.c_uint32),
                ("uids", ctypes.c_uint32 * 7)]


LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib") if sys.platform == "darwin" else None
LIBC = ctypes.CDLL(None, use_errno=True) if LIBPROC is not None else None
if LIBPROC is not None:
    LIBPROC.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
    LIBPROC.proc_pidinfo.restype = ctypes.c_int
    LIBC.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    LIBC.sysctl.restype = ctypes.c_int


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    ppid: int
    pgid: int
    state: str
    identity: int | str
    parent_identity: int | None
    command: str


def process_table(pid=None):
    selection = ["-A"] if pid is None else ["-p", str(pid)]
    result = subprocess.run(
        ["/bin/ps", *selection, "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="],
        capture_output=True, text=True, errors="replace", timeout=5,
    )
    if result.returncode and (pid is None or result.stderr.strip()):
        raise RuntimeError(f"ps failed: {result.stderr.strip()}")
    table = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 9)
        if len(fields) < 10:
            raise RuntimeError(f"invalid ps row: {line}")
        process_pid, ppid, pgid = map(int, fields[:3])
        state = fields[3]
        identity, parent_identity = " ".join(fields[4:9]), None
        if LIBPROC is not None:
            before, after, bsd = DarwinIdentity(), DarwinIdentity(), DarwinBsdInfo()
            # Both flavors allow other users' PIDs, including zombies (arg=1).
            # Bracket ownership with identity reads to reject PID reuse while
            # reading it. ps contributes only the diagnostic command label.
            records = ((17, before), (13, bsd), (17, after))
            if any(LIBPROC.proc_pidinfo(process_pid, flavor, 1, ctypes.byref(info), ctypes.sizeof(info))
                   != ctypes.sizeof(info) for flavor, info in records):
                try:
                    os.kill(process_pid, 0)
                except (ProcessLookupError, PermissionError):
                    continue
                raise RuntimeError(f"cannot identify process {process_pid}")
            if before.uniqueid != after.uniqueid:
                continue
            ppid, pgid = bsd.ppid, bsd.pgid
            state = "Z" if bsd.status == 5 else "S"
            identity, parent_identity = after.uniqueid, after.parent_uniqueid
        elif sys.platform.startswith("linux"):
            try:
                # /proc/stat is one record; field 22 is the start tick. The
                # comm field may contain spaces or parentheses.
                with open(f"/proc/{process_pid}/stat") as source:
                    stat = source.read().rsplit(")", 1)[1].split()
                state, ppid, pgid = stat[0], int(stat[1]), int(stat[2])
                identity = stat[19]
            except FileNotFoundError:
                continue
        table[process_pid] = ProcessInfo(process_pid, ppid, pgid, state, identity,
                                        parent_identity, fields[9])
    return table


def has_tree_marker(pid, marker):
    if LIBC is not None:
        # KERN_PROCARGS2 includes NUL-separated argv and environment. Only
        # compare our random marker; never log or retain other environment data.
        buffer = ctypes.create_string_buffer(os.sysconf("SC_ARG_MAX"))
        size = ctypes.c_size_t(len(buffer))
        mib = (ctypes.c_int * 3)(1, 49, pid)
        if LIBC.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
            return False
        return b"\0" + marker + b"\0" in buffer.raw[:size.value]
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/environ", "rb") as source:
                return marker in source.read().split(b"\0")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            return False
    return False


class ChildTree:
    def __init__(self, leader, marker=b""):
        self.leader = leader
        self.marker = marker
        self.members = {}
        self.identities = set()
        self.diagnostics = []

    def refresh(self):
        table = process_table()
        if not self.members and self.leader in table:
            self.members[self.leader] = table[self.leader]
            self.identities.add(table[self.leader].identity)
        while True:
            added = False
            for pid, process in table.items():
                previous = self.members.get(pid)
                if previous is not None and previous.identity == process.identity:
                    continue
                parent = self.members.get(process.ppid)
                current_parent = table.get(process.ppid)
                owned = (process.parent_identity in self.identities or
                         (parent is not None and current_parent is not None and
                          parent.identity == current_parent.identity) or
                         process.pgid == self.leader)
                leader = self.members.get(self.leader)
                # Darwin unique IDs increase at fork. Older processes cannot
                # inherit this run's marker; avoid reading their environments.
                newer = (LIBPROC is None or leader is None or
                         process.identity > leader.identity)
                if not owned and self.marker and newer and not process.state.startswith("Z"):
                    # A double fork can reap every intermediate before any ps
                    # snapshot. The inherited per-run marker still proves
                    # membership after both ancestry and session are lost.
                    owned = has_tree_marker(pid, self.marker)
                    if owned:
                        current = process_table(pid).get(pid)
                        owned = current is not None and current.identity == process.identity
                if owned:
                    self.members[pid] = process
                    self.identities.add(process.identity)
                    added = True
            if not added:
                break
        return [p for pid, p in table.items() if pid in self.members and
                p.identity == self.members[pid].identity and not p.state.startswith("Z")]

    def signal_pid(self, process, sig):
        try:
            current = process_table(process.pid).get(process.pid)
            if current is None or current.identity != process.identity or current.state.startswith("Z"):
                return
            os.kill(process.pid, sig)
        except (ProcessLookupError, PermissionError) as exc:
            self.diagnostics.append(f"could not signal process {process.pid}: {exc}")

    def stop(self):
        # Keep the leader unreaped until descendants are verified, reserving
        # its PID/PGID. Reidentify individual targets immediately before kill.
        self.refresh()
        signal_group(self.leader, signal.SIGTERM)
        for process in self.refresh():
            self.signal_pid(process, signal.SIGTERM)
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            if not self.refresh():
                return True
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        signal_group(self.leader, signal.SIGKILL)
        deadline = time.monotonic() + KILL_VERIFY_SECONDS
        signalled = set()
        while True:
            survivors = self.refresh()
            for process in survivors:
                key = (process.pid, process.identity)
                if key not in signalled:
                    self.signal_pid(process, signal.SIGKILL)
                    signalled.add(key)
            survivors = self.refresh()
            if not survivors:
                return True
            if time.monotonic() >= deadline:
                for process in survivors:
                    self.diagnostics.append(f"run_limited: survivors after SIGKILL: {process.pid} {process.command}")
                return False
            time.sleep(0.05)


def positive_seconds(value):
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("seconds must be positive and finite")
    return seconds


def replay_capture(capture, stream):
    # A positional read does not move the offset shared with a surviving writer.
    size = os.fstat(capture.fileno()).st_size
    offset = max(0, size - MAX_REPLAY_BYTES)
    if offset:
        stream.write(f"[run_limited: {offset} earlier bytes dropped]\n".encode())
    while offset < size:
        chunk = os.pread(capture.fileno(), min(MAX_REPLAY_BYTES, size - offset), offset)
        if not chunk:
            break
        stream.write(chunk)
        offset += len(chunk)
    stream.flush()


def run(command, seconds):
    received_signal = None
    killed = False
    verified = True
    marker = "_RUN_LIMITED_TREE=" + uuid.uuid4().hex
    diagnostics = []

    def stopped(signum, _frame):
        nonlocal received_signal
        if received_signal is None:
            received_signal = signum

    def stop_tree():
        nonlocal killed, verified
        killed = True
        try:
            verified = tree.stop()
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            # Attempt the group even if inspection failed, but never claim a
            # verified kill when we could not inspect the descendants.
            signal_group(process.pid, signal.SIGTERM)
            signal_group(process.pid, signal.SIGKILL)
            diagnostics.append(f"run_limited: cannot verify child tree: {exc}")
            verified = False

    previous_handlers = {}
    try:
        for sig in STOP_SIGNALS:
            previous_handlers[sig] = signal.signal(sig, stopped)
        if received_signal is not None:
            return 128 + received_signal
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                process = subprocess.Popen(command, start_new_session=True, stdout=stdout, stderr=stderr,
                                           env={**os.environ, "_RUN_LIMITED_TREE": marker.split("=", 1)[1]})
            except OSError as exc:
                if received_signal is not None:
                    return 128 + received_signal
                print(f"cannot start {command[0]}: {exc}", file=sys.stderr)
                return 127 if isinstance(exc, FileNotFoundError) else 126
            tree = ChildTree(process.pid, marker.encode())
            deadline = time.monotonic() + seconds
            timed_out = False
            try:
                try:
                    while received_signal is None:
                        # A zombie leader can still own live descendants.
                        # Active commands need no system-wide polling: snapshot
                        # before cleanup, or when the unreaped leader exits.
                        if child_exited_unreaped(process) and not tree.refresh():
                            break
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            timed_out = True
                            break
                        time.sleep(min(0.1, remaining))
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    stop_tree()
                if not killed and (timed_out or received_signal is not None):
                    stop_tree()
                try:
                    for capture, stream in ((stdout, sys.stdout.buffer), (stderr, sys.stderr.buffer)):
                        replay_capture(capture, stream)
                finally:
                    if received_signal is not None and not killed:
                        stop_tree()
            finally:
                # Defer stops across the cleanup-to-reap boundary. No live
                # descendant may cross this boundary, even on normal exit.
                mask = signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
                try:
                    pending = signal.sigpending().intersection(STOP_SIGNALS)
                    if pending and received_signal is None:
                        received_signal = min(pending)
                    if not killed:
                        try:
                            needs_stop = received_signal is not None or tree.refresh()
                        except (OSError, RuntimeError, subprocess.SubprocessError):
                            needs_stop = True
                        if needs_stop:
                            stop_tree()
                    code = process.wait() if child_exited_unreaped(process) else None
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, mask)
                    for message in [*diagnostics, *tree.diagnostics]:
                        print(message, file=sys.stderr)
            if not verified:
                return 125
            if received_signal is not None:
                return 128 + received_signal
            if timed_out:
                return 124
            return code if code >= 0 else 128 - code
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=positive_seconds, required=True)
    parser.add_argument("--background", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("a command is required after --")
    if args.background:
        # Not `taskpolicy -b` (PRIO_DARWIN_BG): darwin-background I/O to the USB
        # ExternalSSD is throttled to ~0.02-0.1 MB/s whenever anything else uses
        # the disk, so the 107 GB sqlite3_rsync replica hashed for 3 h and timed
        # out on every run from 2026-11-03 to 11-06 (unthrottled: 20 min). Lower
        # CPU priority only, and lift launchd's LowPriorityIO (IOPOL_THROTTLE),
        # which children inherit, to IOPOL_DEFAULT.
        command = ["/usr/sbin/taskpolicy", "-d", "default", "/usr/bin/nice", "-n", "10", *command]
    return run(command, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
