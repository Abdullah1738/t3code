#!/usr/bin/python3
"""Reopen a missing Robob; the decision function performs no I/O."""
import copy
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import pwd
import re
import subprocess
import tempfile
import time

APP = "/Applications/Robob.app"
EXECUTABLE = APP + "/Contents/MacOS/Robob"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
BACKOFF = (120, 300, 600, 600)


def initial_state():
    return dict(down_count=0, last_reopen=None, history=[], backoff_step=0,
                failed_reopens=0, awaiting_reopen=False, next_retry=0,
                failure_episode=None, crash_episode=None, alerts_sent=[], pending_alerts={})


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_hold(hold, now, alive):
    return (isinstance(hold, dict) and isinstance(hold.get("by"), str)
            and bool(hold["by"]) and type(hold.get("pid")) is int and hold["pid"] > 0
            and finite_number(hold.get("beatAt")) and 0 <= now - hold["beatAt"] < 90
            and alive)


def decide(previous, *, now, up, boot_time, hold=None, hold_pid_alive=False):
    state = copy.deepcopy(previous)
    state["history"] = [t for t in state["history"] if 0 <= now - t < 3600]
    if not state["history"]:
        state["crash_episode"] = None
        # Pending sends retain their original idempotency keys even across recovery.
        state["alerts_sent"] = [k for k in state["alerts_sent"] if k in state["pending_alerts"]]
    statuses = []
    action = "none"
    if hold is not None:
        by = hold.get("by", "invalid") if isinstance(hold, dict) else "invalid"
        if valid_hold(hold, now, hold_pid_alive):
            state.update(down_count=0, failed_reopens=0, backoff_step=0,
                         awaiting_reopen=False, next_retry=0, failure_episode=None)
            return state, ["hold:" + str(by)], action
        statuses.append("stale-hold:" + str(by))
    if up:
        state.update(down_count=0, failed_reopens=0, backoff_step=0,
                     awaiting_reopen=False, next_retry=0, failure_episode=None)
        statuses.append("up")
    else:
        state["down_count"] += 1
        statuses.append("down " + str(state["down_count"]))
        last = state["last_reopen"]
        if last is not None and now - last < 90:
            action = "backoff"
        else:
            if state["awaiting_reopen"]:
                state["failed_reopens"] += 1
                delay = BACKOFF[min(state["backoff_step"], len(BACKOFF) - 1)]
                state["backoff_step"] = min(state["backoff_step"] + 1, len(BACKOFF) - 1)
                state.update(awaiting_reopen=False, next_retry=now + delay)
            if state["failed_reopens"] >= 3:
                key = "robob-guard:%s:failed-reopen" % state["failure_episode"]
                if key not in state["alerts_sent"]:
                    state["pending_alerts"].setdefault(key, dict(kind="failed-reopen", at=now))
            if now < state["next_retry"]:
                action = "backoff"
            elif state["down_count"] >= 2 or (boot_time is not None and 0 <= now - boot_time < 300):
                action = "reopen"
                if state["failure_episode"] is None:
                    state["failure_episode"] = int(now)
                if state["crash_episode"] is None:
                    state["crash_episode"] = int(now)
                state.update(last_reopen=now, awaiting_reopen=True)
                state["history"].append(now)
    if len(state["history"]) > 4:
        key = "robob-guard:%s:crash-loop" % state["crash_episode"]
        if key not in state["alerts_sent"]:
            state["pending_alerts"].setdefault(key, dict(kind="crash-loop", at=now))
    return state, statuses, action


def notification_result(state, key, success):
    result = copy.deepcopy(state)
    if success:
        result["pending_alerts"].pop(key, None)
        if key not in result["alerts_sent"]:
            result["alerts_sent"].append(key)
    return result


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, allow_nan=False)
            out.write("\n")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return copy.deepcopy(default)


def read_state(path):
    state = read_json(path, {})
    defaults = initial_state()
    if not isinstance(state, dict):
        return defaults
    state = dict(defaults, **state)
    for key in ("down_count", "backoff_step", "failed_reopens"):
        if type(state[key]) is not int or state[key] < 0:
            return defaults
    for key in ("last_reopen", "failure_episode", "crash_episode"):
        if state[key] is not None and not finite_number(state[key]):
            return defaults
    if (not finite_number(state["next_retry"]) or type(state["awaiting_reopen"]) is not bool
            or not isinstance(state["history"], list)
            or any(not finite_number(t) for t in state["history"])
            or not isinstance(state["alerts_sent"], list)
            or any(not isinstance(k, str) for k in state["alerts_sent"])
            or not isinstance(state["pending_alerts"], dict)):
        return defaults
    for key, alert in state["pending_alerts"].items():
        if (not isinstance(key, str) or not isinstance(alert, dict)
                or alert.get("kind") not in ("failed-reopen", "crash-loop")
                or not finite_number(alert.get("at"))):
            return defaults
    return state


def append_log(path, now, statuses, action, detail=""):
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    # Hold names and subprocess errors must not inject extra check lines.
    line = "%s %s action=%s %s" % (stamp, " ".join(statuses), action, detail)
    with path.open("a") as out:
        out.write(" ".join(line.split()) + "\n")
    if path.stat().st_size > 1024 * 1024:
        lines = path.read_text().splitlines(keepends=True)[-2000:]
        path.write_text("".join(lines))


def pid_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True


def robob_present(output):
    for line in output.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit() and fields[1] == EXECUTABLE:
            return True
    return False


def process_up():
    return robob_present(subprocess.run(["/bin/ps", "-axo", "pid=,comm="],
                         check=True, capture_output=True, text=True, timeout=10).stdout)


def boot_epoch():
    try:
        out = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.boottime"],
                             check=True, capture_output=True, text=True, timeout=5).stdout
        match = re.search(r"\bsec\s*=\s*(\d+)", out)
        return int(match[1]) if match else None
    except (OSError, subprocess.SubprocessError):
        return None


def clean_environment(home):
    return dict(HOME=str(home), USER=pwd.getpwuid(os.getuid()).pw_name, PATH=SYSTEM_PATH)


def reopen(home):
    subprocess.run(["/usr/bin/open", "-g", "-a", APP], env=clean_environment(home),
                   cwd="/", stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=20)


def notify(home, key, alert):
    dubai = datetime.timezone(datetime.timedelta(hours=4), "Dubai")
    when = datetime.datetime.fromtimestamp(alert["at"], dubai).strftime("%d %b %H:%M:%S Dubai")
    event = ("Three consecutive Robob reopens failed" if alert["kind"] == "failed-reopen"
             else "Robob reopened more than four times within an hour")
    command = [str(home / ".bun/bin/bun"), str(home / ".local/share/telegram-bridge/src/cli.ts"),
               "notify", "--source", "Robob guard", "--severity", "attention",
               "--text", event + " at " + when + ". The guard will keep trying.", "--key", key]
    try:
        subprocess.run(command, env=clean_environment(home), stdin=subprocess.DEVNULL,
                       capture_output=True, check=True, timeout=30)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def check(home):
    root = home / ".local/state/robob-guard"
    root.mkdir(parents=True, exist_ok=True)
    with (root / "check.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        now = time.time()
        state_path = root / "state.json"
        hold_path = home / ".robob/install-hold.json"
        previous = read_state(state_path)
        hold = read_json(hold_path, {"by": "invalid"}) if hold_path.exists() else None
        try:
            up = process_up()
            state, statuses, action = decide(previous, now=now, up=up, boot_time=boot_epoch(),
                hold=hold, hold_pid_alive=pid_alive(hold.get("pid")) if isinstance(hold, dict) else False)
            detail = ""
            if action == "reopen":
                # Serialize the last hold read and open against installer hold acquisition.
                with (root / "hold.lock").open("a") as hold_lock:
                    fcntl.flock(hold_lock, fcntl.LOCK_EX)
                    latest = read_json(hold_path, None)
                    latest_up = process_up()
                    now = time.time()
                    if latest_up or valid_hold(latest, now, pid_alive(latest.get("pid")) if isinstance(latest, dict) else False):
                        state, statuses, action = decide(previous, now=now, up=latest_up, boot_time=boot_epoch(),
                            hold=latest, hold_pid_alive=pid_alive(latest.get("pid")) if isinstance(latest, dict) else False)
                    else:
                        # Persist the attempt before invoking open, even if open times out.
                        atomic_json(state_path, state)
                        try:
                            reopen(home)
                        except (OSError, subprocess.SubprocessError) as error:
                            detail = "open-failed:" + type(error).__name__
            atomic_json(state_path, state)
            for key, alert in list(state["pending_alerts"].items()):
                state = notification_result(state, key, notify(home, key, alert))
                atomic_json(state_path, state)
                detail += " alert:" + key + (":retry" if key in state["pending_alerts"] else ":sent")
                if action == "none":
                    action = "alert"
            append_log(root / "guard.log", now, statuses, action, detail)
        except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
            append_log(root / "guard.log", now, ["check-error:" + type(error).__name__], "none", str(error))


if __name__ == "__main__":
    check(Path.home())
