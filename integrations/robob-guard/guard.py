#!/usr/bin/python3
"""Recover an unavailable Robob backend; the decision function performs no I/O."""
import copy
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

APP = "/Applications/Robob.app"
EXECUTABLE = APP + "/Contents/MacOS/Robob"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
BACKOFF = (120, 300, 600, 600)
HOLD_MAX_AGE = 30 * 60
HEALTH_DEADLINE = 3
DESKTOP_STARTUP_GRACE = 180
UNREADY_WINDOW = 180
UNREADY_MIN_TICKS = 3
REPLACE_COOLDOWN = 15 * 60
CHECK_ERROR_MIN_TICKS = 4


def initial_state():
    return dict(down_count=0, last_reopen=None, history=[], backoff_step=0,
                failed_reopens=0, awaiting_reopen=False, next_retry=0,
                failure_episode=None, crash_episode=None, alerts_sent=[], pending_alerts={},
                unready_since=None, unready_last=None, unready_ticks=0,
                unready_desktop=None, last_replace=None,
                check_error_count=0, check_error_since=None)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_hold(hold, now, alive):
    return (isinstance(hold, dict) and isinstance(hold.get("by"), str)
            and bool(hold["by"]) and type(hold.get("pid")) is int and hold["pid"] > 0
            and finite_number(hold.get("startedAt")) and 0 <= now - hold["startedAt"] < HOLD_MAX_AGE
            and finite_number(hold.get("beatAt")) and 0 <= now - hold["beatAt"] < 90
            and alive)


def reset_unready(state):
    state.update(unready_since=None, unready_last=None, unready_ticks=0, unready_desktop=None)


def reset_check_errors(state):
    state.update(check_error_count=0, check_error_since=None)


def record_check_error(state, now, backend_up):
    state["check_error_count"] += 1
    if state["check_error_since"] is None:
        state["check_error_since"] = int(now)
    if backend_up is not True and state["check_error_count"] >= CHECK_ERROR_MIN_TICKS:
        key = "robob-guard:%s:check-error" % state["check_error_since"]
        if key not in state["alerts_sent"]:
            state["pending_alerts"].setdefault(key, dict(kind="check-error", at=now))


def decide(previous, *, now, up, boot_time, hold=None, hold_pid_alive=False, desktop=None):
    state = copy.deepcopy(previous)
    if (boot_time is not None and boot_time <= now and state["last_reopen"] is not None
            and state["last_reopen"] < boot_time):
        # A pre-boot attempt cannot still be starting, or delay this boot's launch.
        state.update(down_count=0, last_reopen=None, failed_reopens=0, backoff_step=0,
                     awaiting_reopen=False, next_retry=0, failure_episode=None, last_replace=None)
        reset_unready(state)
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
            reset_unready(state)
            return state, ["hold:" + str(by)], action
        statuses.append("stale-hold:" + str(by))
    if up:
        state.update(down_count=0, failed_reopens=0, backoff_step=0,
                     awaiting_reopen=False, next_retry=0, failure_episode=None)
        reset_unready(state)
        statuses.append("up")
    else:
        state["down_count"] += 1
        statuses.append("down " + str(state["down_count"]))
        if desktop is not None:
            if "startedAt" not in desktop or now - desktop["startedAt"] < DESKTOP_STARTUP_GRACE:
                reset_unready(state)
                return state, statuses + ["desktop-starting-or-unverified"], "backoff"
            identity = "%s:%s" % (desktop["pid"], desktop["identity"])
            # Missing checks do not prove that the backend stayed unready between them.
            if (state["unready_desktop"] != identity or state["unready_last"] is None
                    or not 0 <= now - state["unready_last"] <= 90):
                reset_unready(state)
                state.update(unready_desktop=identity, unready_since=now)
            state["unready_ticks"] += 1
            state["unready_last"] = now
            elapsed = now - state["unready_since"]
            statuses.append("unready:%s/%.0fs" % (state["unready_ticks"], elapsed))
            if state["unready_ticks"] < UNREADY_MIN_TICKS or elapsed < UNREADY_WINDOW:
                return state, statuses, "backoff"
            if state["last_replace"] is not None and now - state["last_replace"] < REPLACE_COOLDOWN:
                remaining = REPLACE_COOLDOWN - (now - state["last_replace"])
                return state, statuses + ["replace-cooldown:%.0fs" % remaining], "backoff"
        else:
            reset_unready(state)
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
                if desktop is not None:
                    action = "replace"
                    state["last_replace"] = now
                    reset_unready(state)
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
    for key in ("down_count", "backoff_step", "failed_reopens", "unready_ticks", "check_error_count"):
        if type(state[key]) is not int or state[key] < 0:
            return defaults
    for key in ("last_reopen", "failure_episode", "crash_episode", "last_replace", "unready_since", "unready_last", "check_error_since"):
        if state[key] is not None and not finite_number(state[key]):
            return defaults
    if ((state["unready_desktop"] is not None and not isinstance(state["unready_desktop"], str))
            or not finite_number(state["next_retry"]) or type(state["awaiting_reopen"]) is not bool
            or not isinstance(state["history"], list)
            or any(not finite_number(t) for t in state["history"])
            or not isinstance(state["alerts_sent"], list)
            or any(not isinstance(k, str) for k in state["alerts_sent"])
            or not isinstance(state["pending_alerts"], dict)):
        return defaults
    for key, alert in state["pending_alerts"].items():
        if (not isinstance(key, str) or not isinstance(alert, dict)
                or alert.get("kind") not in ("failed-reopen", "crash-loop", "check-error")
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


def process_diagnostics():
    from quit_reason import registered_desktop_pids
    detail = {}
    try:
        targets = sorted(registered_desktop_pids())
        detail["lsappinfo_pid"] = targets[0] if len(targets) == 1 else targets[:5]
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        targets = None
        detail["lsappinfo_error"] = type(error).__name__
    try:
        output = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,comm=,args="],
                                check=True, capture_output=True, text=True, timeout=5).stdout
        alive, others = set(), []
        for line in output.splitlines():
            fields = line.split(None, 3)
            if len(fields) < 3 or not fields[0].isdigit() or not fields[1].isdigit():
                continue
            pid, ppid = int(fields[0]), int(fields[1])
            alive.add(pid)
            if fields[2] == EXECUTABLE and pid not in (targets or []) and len(others) < 5:
                others.append(dict(pid=pid, ppid=ppid, args=(fields[3] if len(fields) == 4 else "")[:160]))
        detail["lsappinfo_alive"] = (targets[0] in alive if targets and len(targets) == 1
                                    else [pid in alive for pid in targets] if targets is not None else "unknown")
        detail["robob_processes"] = others
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        detail.update(lsappinfo_alive="unknown", processes_error=type(error).__name__)
    return "processes=" + json.dumps(detail, separators=(",", ":"))


def backend_ready(home):
    paths = [home / ".robob/components/robob-guard.json", home / ".robob/components/t3ctl.json",
             home / ".robob/ardud-control.json"]
    config_path = next((path for path in paths if path.exists()), None)
    if config_path is None:
        if desktop_snapshot() is not None:
            raise ValueError("missing control credential for desktop health")
        return False
    if config_path.stat().st_mode & 0o077:
        raise ValueError("control credential must be chmod 600")
    config = read_json(config_path, {})
    if not isinstance(config, dict):
        raise ValueError("invalid control credential")
    url, token = config.get("url"), config.get("token")
    if not isinstance(url, str) or not isinstance(token, str) or not token:
        raise ValueError("invalid control credential")
    target = urlsplit(url)
    if (target.scheme not in ("http", "https") or target.hostname not in ("127.0.0.1", "localhost", "::1")
            or target.username or target.password or target.query or target.fragment):
        raise ValueError("guard health must target a local backend")
    # curl bounds the entire exchange, including a partial/slow HTTP response.
    # Credentials go over stdin; neither argv nor logged errors contain them.
    request = "url = " + json.dumps(url.rstrip("/") + "/api/ardud/control/health") + "\n"
    request += "header = " + json.dumps("Authorization: Bearer " + token) + "\n"
    try:
        result = subprocess.run(
            ["/usr/bin/curl", "-q", "--config", "-", "--silent", "--noproxy", "*",
             "--max-time", str(HEALTH_DEADLINE), "--max-filesize", "65536", "--write-out", "\n%{http_code}"],
            input=request, text=True, capture_output=True, timeout=HEALTH_DEADLINE + 2,
            env=clean_environment(home))
    except subprocess.TimeoutExpired:
        return False
    if result.returncode:
        return False
    body, _, status = result.stdout.rpartition("\n")
    if status in ("401", "403"):
        raise ValueError("control health credential rejected")
    try:
        health = json.loads(body)
    except ValueError:
        return False
    return (status == "200" and isinstance(health, dict) and health.get("ok") is True
            and health.get("status") in ("healthy", "degraded", "recovered-unverified"))


def desktop_identity(pid):
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart=,comm="],
                            capture_output=True, text=True, timeout=2, env={"LC_ALL": "C", "PATH": SYSTEM_PATH})
    if result.returncode:
        return None
    fields = result.stdout.strip().split(None, 5)
    if len(fields) != 6 or fields[5] != EXECUTABLE:
        return None
    return " ".join(fields[:5])


def desktop_snapshot():
    if not process_up():
        return None
    from quit_reason import desktop_pid
    pid = desktop_pid()
    if pid is None:
        return None
    identity = desktop_identity(pid)
    if identity is None:
        return {}  # A present but unverified desktop is never a signal target.
    started = time.mktime(time.strptime(identity, "%a %b %d %H:%M:%S %Y"))
    return dict(pid=pid, identity=identity, startedAt=started)


def stop_unready_desktop(home, expected):
    from quit_reason import desktop_pid
    pid = desktop_pid()
    if pid is None:
        return True
    identity = desktop_identity(pid)
    if pid != expected["pid"] or identity != expected["identity"]:
        return False
    started = time.mktime(time.strptime(identity, "%a %b %d %H:%M:%S %Y"))
    if time.time() - started < DESKTOP_STARTUP_GRACE:
        return False
    # The provenance file is in userdata, which may be on a blocked volume.
    # Never wait for an uninterruptible write in the guard process itself.
    reason_error = None
    try:
        reason = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("quit_reason.py")),
             "--initiator", "guard", "--reason", "backend-unready", "--target-pid", str(pid)],
            env=clean_environment(home), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if reason.wait(timeout=3):
            reason_error = "nonzero-exit"
    except subprocess.TimeoutExpired:
        reason.terminate()
        reason_error = "timeout"
    except OSError:
        reason_error = "spawn-failed"
    if reason_error:
        append_log(home / ".local/state/robob-guard/guard.log", time.time(),
                   ["quit-reason-unavailable:" + reason_error], "replace",
                   "initiator=guard reason=backend-unready target-pid=%s" % pid)
    latest = desktop_snapshot()
    if latest is None:
        return not backend_ready(home)
    if latest is not None and (latest.get("pid") != pid or latest.get("identity") != identity):
        return False
    # Only the LaunchServices desktop is eligible, never matching provider/Node
    # workers. Recheck its birth time before each signal to avoid PID reuse.
    for sig, seconds in [(signal.SIGTERM, 3), (signal.SIGKILL, 2)]:
        if backend_ready(home):
            if sig == signal.SIGKILL:
                raise ValueError("desktop recovered after SIGTERM; keeping replacement cooldown")
            return False
        current = desktop_identity(pid)
        if current is None:
            if desktop_snapshot() is None:
                return True
            if sig == signal.SIGKILL:
                raise ValueError("new desktop after SIGTERM; keeping replacement cooldown")
            return False
        if current != identity:
            if sig == signal.SIGKILL:
                raise ValueError("desktop changed after SIGTERM; keeping replacement cooldown")
            return False
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            if desktop_snapshot() is None:
                return True
            if sig == signal.SIGKILL:
                raise ValueError("new desktop after SIGTERM; keeping replacement cooldown")
            return False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            current = desktop_identity(pid)
            if current is None:
                if desktop_snapshot() is None:
                    return True
                raise ValueError("new desktop after signal; keeping replacement cooldown")
            if current != identity:
                raise ValueError("desktop changed after signal; keeping replacement cooldown")
            time.sleep(0.1)
    raise subprocess.TimeoutExpired("desktop recovery", 5)


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
    subprocess.run(["/usr/bin/open", "-g", "-a", APP, "--env", f"ROBOB_LAUNCH_INITIATOR=guard:{int(time.time() * 1000)}"], env=clean_environment(home),
                   cwd="/", stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=20)


def notify(home, key, alert):
    dubai = datetime.timezone(datetime.timedelta(hours=4), "Dubai")
    when = datetime.datetime.fromtimestamp(alert["at"], dubai).strftime("%d %b %H:%M:%S Dubai")
    event = {"failed-reopen": "Three consecutive Robob reopens failed",
             "crash-loop": "Robob reopened more than four times within an hour",
             "check-error": "Robob guard checks keep failing; backend readiness is not confirmed"}[alert["kind"]]
    followup = (". Recovery is blocked; check guard.log." if alert["kind"] == "check-error"
                else ". The guard will keep trying.")
    command = [str(home / ".bun/bin/bun"), str(home / ".local/share/telegram-bridge/src/cli.ts"),
               "notify", "--source", "Robob guard", "--severity", "attention",
               "--text", event + " at " + when + followup, "--key", key]
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
        up = None
        step = "backend_ready"
        try:
            up = backend_ready(home)
            step = "desktop_snapshot"
            desktop = None if up else desktop_snapshot()
            step = "decide"
            state, statuses, action = decide(previous, now=now, up=up, boot_time=boot_epoch(),
                hold=hold, hold_pid_alive=pid_alive(hold.get("pid")) if isinstance(hold, dict) else False,
                desktop=desktop)
            detail = "backend-ready" if up else "backend-unready"
            if action in ("reopen", "replace"):
                # Serialize the last hold read and open against installer hold acquisition.
                with (root / "hold.lock").open("a") as hold_lock:
                    fcntl.flock(hold_lock, fcntl.LOCK_EX)
                    latest = read_json(hold_path, None)
                    step = "backend_ready"
                    up = backend_ready(home)
                    step = "desktop_snapshot"
                    desktop = None if up else desktop_snapshot()
                    now = time.time()
                    step = "decide"
                    state, statuses, action = decide(previous, now=now, up=up, boot_time=boot_epoch(),
                        hold=latest, hold_pid_alive=pid_alive(latest.get("pid")) if isinstance(latest, dict) else False,
                        desktop=desktop)
                    detail = "backend-ready" if up else "backend-unready"
                    if action in ("reopen", "replace"):
                        # Failed recovery operations use the same retry budget as failed opens.
                        step = "persist_attempt"
                        atomic_json(state_path, state)
                        step = "stop_unready_desktop"
                        if action == "replace" and not stop_unready_desktop(home, desktop):
                            state = copy.deepcopy(previous)
                            reset_unready(state)
                            action = "backoff"
                            detail = "recovery-cancelled"
                        elif action == "replace" and backend_ready(home):
                            # A surviving backend can recover as the desktop exits.
                            # Keep the attempt budget already consumed by stopping it.
                            action = "backoff"
                            detail = "backend-recovered-after-stop"
                        else:
                            step = "reopen"
                            try:
                                reopen(home)
                            except (OSError, subprocess.SubprocessError) as error:
                                detail += " open-failed:" + type(error).__name__
            reset_check_errors(state)
        except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
            # An unknown observation breaks the consecutive-unready window.
            state = read_state(state_path)
            reset_unready(state)
            record_check_error(state, now, up)
            statuses, action = ["check-error:" + type(error).__name__], "none"
            detail = "step=%s errors=%s %s" % (step, state["check_error_count"], error)
        if up is not True or statuses[0].startswith("check-error:"):
            detail += " " + process_diagnostics()
        atomic_json(state_path, state)
        for key, alert in list(state["pending_alerts"].items()):
            state = notification_result(state, key, notify(home, key, alert))
            atomic_json(state_path, state)
            detail += " alert:" + key + (":retry" if key in state["pending_alerts"] else ":sent")
            if action == "none":
                action = "alert"
        append_log(root / "guard.log", now, statuses, action, detail)


if __name__ == "__main__":
    check(Path.home())
