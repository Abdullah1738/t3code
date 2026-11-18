"""Targeted, short-lived reason handoff immediately before a tool quits Robob."""
import argparse
import os
import re
from pathlib import Path
import subprocess
import time
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from guard import atomic_json

EXECUTABLE = "/Applications/Robob.app/Contents/MacOS/Robob"


def write_reason(home, initiator, reason, requester_pid, target_pid):
    if initiator not in ("installer", "watchdog", "guard") or not reason or len(reason) > 512:
        raise ValueError("invalid quit initiator or reason")
    if requester_pid <= 0 or target_pid <= 0:
        raise ValueError("positive requester and target PIDs required")
    atomic_json(home / ".robob/userdata/logs/desktop-quit-request.json", dict(
        at=time.time() * 1000, initiator=initiator, reason=reason,
        requesterPid=requester_pid, targetPid=target_pid))


def desktop_pid():
    # The backend and Node workers use this executable too. LaunchServices
    # identifies the registered desktop rather than every process in the bundle.
    info = subprocess.run(["/usr/bin/lsappinfo", "info", "-only", "pid", "-app", "com.ardud.robob"],
                          check=True, capture_output=True, text=True, timeout=5).stdout
    targets = set(int(value) for value in re.findall(r'\bpid[^0-9]*(\d+)', info, re.I))
    if not targets:
        return None
    if len(targets) != 1:
        raise ValueError("expected exactly one Robob desktop process")
    target = targets.pop()
    executable = subprocess.run(["/bin/ps", "-p", str(target), "-o", "comm="],
                                check=True, capture_output=True, text=True, timeout=5).stdout.strip()
    if target < 2 or executable != EXECUTABLE:
        raise ValueError("registered Robob PID does not match the desktop executable")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initiator", choices=["installer", "watchdog", "guard"], required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--target-pid", type=int)
    args = parser.parse_args()
    if args.target_pid is not None and args.target_pid < 2:
        parser.error("a desktop target PID must be greater than one")
    target = args.target_pid if args.target_pid is not None else desktop_pid()
    if target is not None:
        write_reason(Path.home(), args.initiator, args.reason, os.getppid(), target)


if __name__ == "__main__":
    main()
