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


def run(command, seconds):
    # A child stuck in uninterruptible I/O can hold a shell capture pipe open
    # even after SIGKILL; files let the wrapper return without waiting for it.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.Popen(command, start_new_session=True, stdout=stdout, stderr=stderr)
        except OSError as exc:
            print(f"cannot start {command[0]}: {exc}", file=sys.stderr)
            return 127 if isinstance(exc, FileNotFoundError) else 126
        deadline = time.monotonic() + seconds
        while not child_exited_unreaped(process):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(0.1, remaining))
        if child_exited_unreaped(process):
            code = process.wait()
            code = code if code >= 0 else 128 - code
        else:
            # Keep the leader unreaped during the grace period: a child can
            # outlive it, and its PID must not be reused before the group kill.
            signal_group(process.pid, signal.SIGTERM)
            time.sleep(KILL_GRACE_SECONDS)
            signal_group(process.pid, signal.SIGKILL)
            deadline = time.monotonic() + 1
            while not child_exited_unreaped(process) and time.monotonic() < deadline:
                time.sleep(0.05)
            if child_exited_unreaped(process):
                process.wait()
            # Otherwise an uninterruptible kernel wait has outlasted SIGKILL.
            code = 124
        for capture, stream in ((stdout, sys.stdout.buffer), (stderr, sys.stderr.buffer)):
            # Do not chase a still-writing, uninterruptible child's output.
            remaining = os.fstat(capture.fileno()).st_size
            capture.seek(0)
            while remaining:
                chunk = capture.read(min(65536, remaining))
                if not chunk:
                    break
                stream.write(chunk)
                remaining -= len(chunk)
            stream.flush()
        return code


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
        command = ["/usr/sbin/taskpolicy", "-b", *command]
    return run(command, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
