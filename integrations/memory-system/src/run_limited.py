#!/opt/homebrew/bin/python3
"""Run a command in its own process group with a wall-clock limit."""

import argparse
import math
import os
import signal
import subprocess
import sys
import tempfile
import time

KILL_GRACE_SECONDS = 30
MAX_REPLAY_BYTES = 65536


def child_exited_unreaped(process):
    # Popen.wait(timeout) may reap on newer Python versions. WNOWAIT keeps the
    # group leader's PID reserved while descendants still need SIGKILL.
    return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError as exc:
        # Darwin can report EPERM when the group contains only a zombie.
        print(f"could not signal process group {pid}: {exc}", file=sys.stderr)


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

    def stopped(signum, _frame):
        nonlocal received_signal
        if received_signal is None:
            received_signal = signum

    previous_handlers = {}
    try:
        # Handle a stop that arrives while Popen is launching the new session.
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            previous_handlers[sig] = signal.signal(sig, stopped)
        if received_signal is not None:
            return 128 + received_signal

        # Files let the wrapper return even if a killed child is stuck in I/O.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            try:
                process = subprocess.Popen(command, start_new_session=True, stdout=stdout, stderr=stderr)
            except OSError as exc:
                if received_signal is not None:
                    return 128 + received_signal
                print(f"cannot start {command[0]}: {exc}", file=sys.stderr)
                return 127 if isinstance(exc, FileNotFoundError) else 126

            def stop_group(grace_deadline):
                # Keep the leader unreaped until after SIGKILL so its PID cannot
                # be reused while a descendant is still in the group.
                while not child_exited_unreaped(process):
                    remaining = grace_deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    time.sleep(min(0.1, remaining))
                signal_group(process.pid, signal.SIGKILL)

            def wait_after_kill():
                deadline = time.monotonic() + 1
                while not child_exited_unreaped(process) and time.monotonic() < deadline:
                    time.sleep(0.05)

            deadline = time.monotonic() + seconds
            while received_signal is None and not child_exited_unreaped(process):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                time.sleep(min(0.1, remaining))

            timed_out = killed = False
            if received_signal is None and not child_exited_unreaped(process):
                # The timeout still gives the whole group the full grace period,
                # even if its leader exits. A stop signal can interrupt that wait.
                timed_out = True
                signal_group(process.pid, signal.SIGTERM)
                deadline = time.monotonic() + KILL_GRACE_SECONDS
                while received_signal is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    time.sleep(min(0.1, remaining))
                if received_signal is not None:
                    stop_group(deadline)
                else:
                    signal_group(process.pid, signal.SIGKILL)
                killed = True
            elif received_signal is not None:
                signal_group(process.pid, signal.SIGTERM)
                stop_group(time.monotonic() + KILL_GRACE_SECONDS)
                killed = True

            if killed:
                wait_after_kill()

            # Retain the leader through replay in case a stop arrives after it
            # exits but while a descendant is still writing to a capture.
            try:
                for capture, stream in ((stdout, sys.stdout.buffer), (stderr, sys.stderr.buffer)):
                    replay_capture(capture, stream)
            finally:
                if received_signal is not None and not killed:
                    signal_group(process.pid, signal.SIGTERM)
                    stop_group(time.monotonic() + KILL_GRACE_SECONDS)
                    wait_after_kill()

            # An uninterruptible kernel wait can outlast SIGKILL.
            code = process.wait() if child_exited_unreaped(process) else None
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
