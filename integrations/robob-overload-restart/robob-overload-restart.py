#!/usr/bin/python3
"""Bounded overload restart watchdog. Installed disabled; checks expire 23 Nov 2026.

check: five-minute health sampler and detached tmux trigger.
restart [stamp]: serves callers with their own authority (mac-guard, Mac #91).
    Owns the hold, deadline and terminal result; keeps every limit except check expiry.
probe: read-only startup dependency checks, with no hold, quit or notification.
status: read-only internal state and listener identity.
"""
import datetime
from contextlib import contextmanager
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import uuid
import shlex
import subprocess
import sys
import tempfile
import time

HOME = Path.home()
HERE = Path(os.environ.get("ROBOB_OVERLOAD_HOME", HOME / ".local/share/robob-overload-restart"))
STATE_DIR = Path(os.environ.get("ROBOB_OVERLOAD_STATE", HOME / ".local/state/robob-overload-restart"))
STATE = STATE_DIR / "state.json"
LOG = Path(os.environ.get("ROBOB_OVERLOAD_LOG", STATE_DIR / "log.ndjson"))
APP = os.environ.get("ROBOB_OVERLOAD_APP", "/Applications/Robob.app")
EXECUTABLE = APP + "/Contents/MacOS/Robob"
USERDATA = os.environ.get("ROBOB_OVERLOAD_USERDATA", str(HOME / ".robob/userdata"))
SSD_PROBE = os.environ.get("ROBOB_OVERLOAD_SSD_PROBE", USERDATA + "/server-runtime.json")
HOLD = Path(os.environ.get("ROBOB_OVERLOAD_HOLD", HOME / ".robob/install-hold.json"))
MAC_SSD_MARKER = Path(os.environ.get("ROBOB_OVERLOAD_MAC_MARKER", HOME / ".local/state/mac-upkeep/ssd-launchd-read-blocked"))
HOLD_CLI = os.environ.get("ROBOB_OVERLOAD_HOLD_CLI", str(HOME / ".local/bin/robob-install-hold"))
OPEN_CLEAN = HERE / "open-robob-clean.zsh"
TMUX = os.environ.get("ROBOB_OVERLOAD_TMUX", "/opt/homebrew/bin/tmux")
QF_SOCKET = os.environ.get("ROBOB_OVERLOAD_QF_SOCKET", "qf-install")
QF_SESSION_RE = re.compile(os.environ.get("ROBOB_OVERLOAD_QF_SESSION_RE", r"^install\d*$"))
QF_IDLE_SEC = float(os.environ.get("ROBOB_OVERLOAD_QF_IDLE_SEC", "1800"))
NODE = os.environ.get("ROBOB_OVERLOAD_NODE", str(HOME / ".local/bin/node"))
HEALTH = HERE / "health-probe.mjs"
BUN = os.environ.get("ROBOB_OVERLOAD_BUN", str(HOME / ".bun/bin/bun"))
TELEGRAM = os.environ.get("ROBOB_OVERLOAD_TELEGRAM", str(HOME / ".local/share/telegram-bridge/src/cli.ts"))
PATH = f"{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV = dict(HOME=str(HOME), USER=os.environ.get("USER", "ardud"), PATH=PATH)
ENV.update({k: v for k, v in os.environ.items() if k.startswith("ROBOB_OVERLOAD_")})
PROBE_TIMEOUT = float(os.environ.get("ROBOB_OVERLOAD_PROBE_TIMEOUT", "8"))
PROBE_SLOW = float(os.environ.get("ROBOB_OVERLOAD_PROBE_SLOW", "4"))
RESTART_DEADLINE = float(os.environ.get("ROBOB_OVERLOAD_DEADLINE", "1500"))
NOTIFY_DELAY = float(os.environ.get("ROBOB_OVERLOAD_NOTIFY_DELAY", "30"))
NOTIFY_TIMEOUT = float(os.environ.get("ROBOB_OVERLOAD_NOTIFY_TIMEOUT", "20"))

MIN_GAP = 2 * 3600        # owner: max once per 2 hours
NEED = 4                  # consecutive stalled checks (5 min apart: 15+ min)
LONG = 8                  # rule 2 window: about 40 min with no healthy check
MAX_STEP = 420            # checks further apart than this are not consecutive
STALL_5S = max(1, int(os.environ.get("ROBOB_OVERLOAD_STALL_5S", "1")))
STALL_1S = max(1, int(os.environ.get("ROBOB_OVERLOAD_STALL_1S", "3")))
LOAD_FACTOR = float(os.environ.get("ROBOB_OVERLOAD_LOAD_FACTOR", "2"))
AGENT_COMMANDS = frozenset(("claude", "codex", "opencode", "cursor-agent", "grok"))
NODE_PROVIDER_SCRIPTS = re.compile(
    r"/(?:@anthropic-ai/claude-code/cli\.js|@openai/codex/bin/codex\.js|"
    r"opencode-ai/bin/opencode|@xai-official/grok/(?:dist/)?(?:index|cli)\.js)$")
NODE_VALUE_OPTIONS = frozenset(("-r", "--require", "--import", "--loader", "--experimental-loader",
                                "-C", "--conditions", "--title", "--icu-data-dir", "--openssl-config",
                                "--experimental-specifier-resolution"))
NODE_BOOLEAN_OPTIONS = frozenset(("--no-warnings", "--trace-warnings", "--enable-source-maps",
                                  "--no-deprecation", "--trace-deprecation", "--inspect", "--inspect-brk",
                                  "--experimental-strip-types"))
EXPIRES = "2026-11-23T00:00:00+00:00"   # check stops by itself; the tracker extends or removes it
BY = "overload-restart"
DRY = os.environ.get("ROBOB_OVERLOAD_DRY") == "1"


def iso(t=None):
    return datetime.datetime.fromtimestamp(t or time.time(), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dubai(t=None):
    tz = datetime.timezone(datetime.timedelta(hours=4))
    return datetime.datetime.fromtimestamp(t or time.time(), tz).strftime("%H:%M")


def log(event, **fields):
    row = dict(at=iso(), event=event, **fields)
    with LOG.open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps(row), flush=True)


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, value):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(value, indent=1))
    os.replace(tmp, path)


def kill_group(pid, leader_alive=True):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # Covers an interrupted fork before the child established its group.
    if leader_alive:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run(args, timeout):
    # Popen itself can wait on exec of an SSD-backed binary. Fork first, then time even exec.
    # Children keep the worker's group; the external supervisor kills all of them together.
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="command-", dir=STATE_DIR) as temp:
        output, errors = Path(temp) / "stdout", Path(temp) / "stderr"
        with output.open("w") as stdout, errors.open("w") as stderr, open(os.devnull) as stdin:
            pid = os.fork()
            if pid == 0:
                try:
                    os.chdir("/")
                    for source, target in ((stdin, 0), (stdout, 1), (stderr, 2)):
                        os.dup2(source.fileno(), target)
                    os.execve(str(args[0]), list(map(str, args)), ENV)
                except BaseException as error:
                    os.write(2, (type(error).__name__ + ":" + str(getattr(error, "errno", ""))).encode())
                finally:
                    os._exit(127)
        started = time.monotonic()
        reaped = False
        try:
            while time.monotonic() - started < timeout:
                if (result := os.waitpid(pid, os.WNOHANG))[0]:
                    reaped = True
                    status = result[1]
                    rc = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status)
                    return subprocess.CompletedProcess(args, rc, output.read_text(), errors.read_text())
                time.sleep(0.02)
            raise subprocess.TimeoutExpired(args, timeout, stderr=errors.read_text()[:200])
        finally:
            if not reaped:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # Kernel approval waits can outlive SIGKILL; never block on reap or pipes.
                os.waitpid(pid, os.WNOHANG)


def child_probe(name, operation):
    """Only the child resolves symlinks/opens dependency paths."""
    started = time.monotonic()
    result_path = STATE_DIR / ("probe-" + uuid.uuid4().hex + ".json")
    pid = os.fork()
    if pid == 0:
        try:
            operation()
            write_json(result_path, {"outcome": "ok"})
        except BaseException as error:
            write_json(result_path, {"outcome": "error", "error": type(error).__name__,
                                     "errno": getattr(error, "errno", None)})
        os._exit(0)
    outcome = {"outcome": "timeout"}
    reaped = False
    try:
        while time.monotonic() - started < PROBE_TIMEOUT:
            if os.waitpid(pid, os.WNOHANG)[0]:
                reaped = True
                outcome = read_json(result_path, {"outcome": "error"})
                break
            time.sleep(0.02)
    finally:
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, os.WNOHANG)
        result_path.unlink(missing_ok=True)
    ms = round((time.monotonic() - started) * 1000)
    if outcome["outcome"] == "ok" and ms > PROBE_SLOW * 1000:
        outcome["outcome"] = "slow"
    log("preflight.probe", name=name, ms=ms, **outcome)
    return None if outcome["outcome"] == "ok" else name + ":" + outcome["outcome"]


def notify(severity, text, key):
    if DRY:
        log("dry.notify", severity=severity, text=text, key=key)
        return True
    for attempt in range(1, 4):
        try:
            result = run([BUN, TELEGRAM, "notify", "--source", "Robob overload restart",
                          "--severity", severity, "--text", text, "--key", key], NOTIFY_TIMEOUT)
            rc, stderr = result.returncode, result.stderr[:200]
        except (OSError, subprocess.SubprocessError) as error:
            rc, stderr = -1, (str(getattr(error, "stderr", "") or type(error).__name__))[:200]
        log("notify.sent" if rc == 0 else "notify.failed", key=key, attempt=attempt,
            rc=rc, stderr=stderr)
        if rc == 0:
            return True
        if attempt < 3:
            time.sleep(NOTIFY_DELAY)
    return False


def processes(timeout=20):
    """pid -> (ppid, start time text, command)."""
    result = run(["/bin/ps", "-axo", "pid=,ppid=,lstart=,comm="], timeout)
    if result.returncode:
        raise OSError("process inventory failed")
    out = result.stdout
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 7)
        if len(parts) == 8 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]), parts[7])
    return table


def app_pid(table):
    roots = [pid for pid, (ppid, _, comm) in table.items() if comm == EXECUTABLE and ppid == 1]
    return roots[0] if len(roots) == 1 else None


def tree(table, root):
    children = {}
    for pid, (ppid, _, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    found, stack = {}, [root]
    while stack:
        pid = stack.pop()
        if pid in found or pid not in table:
            continue
        found[pid] = table[pid][1]
        stack.extend(children.get(pid, []))
    return found


def node_provider(command):
    # ps prints argv joined by spaces, not shell-escaped. Consume only the launch
    # prefix: quotes in later prompts are irrelevant, ambiguous paths/options hold.
    args = shlex.shlex(command, posix=True)
    args.whitespace_split = True
    args.commenters = ""
    value_option = False
    try:
        if Path(next(args)).name != "node":
            return None
        for token in args:
            option = token.split("=", 1)[0]
            if option in NODE_VALUE_OPTIONS:
                # A ps value may have unescaped spaces. After consuming values,
                # only positive provider identification can establish a count.
                value_option = True
                if "=" not in token:
                    next(args)
            elif token in NODE_BOOLEAN_OPTIONS:
                continue
            elif token.startswith("--") and "=" in token and option not in ("--eval", "--print"):
                value_option = True
                continue
            else:
                script = next(args) if token == "--" else token
                if script.startswith("-"):
                    return None
                if Path(script).name in AGENT_COMMANDS or NODE_PROVIDER_SCRIPTS.search("/" + script):
                    return True
                if not value_option and Path(script).suffix in (".js", ".mjs", ".cjs"):
                    return False
                return None
    except (ValueError, StopIteration):
        pass
    return None


def cost(table=None):
    result = dict(treeProcesses=None, agentProcesses=None, runningTurns=None, runningSubagents=None)
    try:
        table = processes(timeout=5) if table is None else table
        root = app_pid(table)
        if root is None:
            return result
        owned = tree(table, root)
        result["treeProcesses"] = len(owned)
        descendants = [pid for pid in owned if pid != root]
        agents = sum(Path(table[pid][2]).name in AGENT_COMMANDS for pid in descendants)
        nodes = [pid for pid in descendants if Path(table[pid][2]).name == "node"]
        if nodes:
            # comm identifies binaries; only node needs argv to distinguish CLIs from servers.
            # Never persist argv: provider arguments can contain prompts and credentials.
            out = run(["/bin/ps", "-o", "pid=,args=", "-p", ",".join(map(str, nodes))], 5)
            if out.returncode:
                return result
            classified = {}
            for line in out.stdout.splitlines():
                fields = line.split(None, 1)
                if len(fields) != 2 or not fields[0].isdigit() or int(fields[0]) in classified:
                    return result
                classified[int(fields[0])] = node_provider(fields[1])
            if set(classified) != set(nodes) or any(value is None for value in classified.values()):
                return result
            agents += sum(classified.values())
        result["agentProcesses"] = agents
    except (OSError, subprocess.SubprocessError):
        pass
    return result


def stall_evidence(report):
    lag = report.get("lag")
    source = "missing"
    counts = (None, None)
    worst = lag.get("worstMs") if isinstance(lag, dict) else None
    if isinstance(lag, dict) and any(key in lag for key in ("stalls1s", "stalls5s")):
        source = "lag"
        counts = (lag.get("stalls1s"), lag.get("stalls5s"))
    else:
        summary = report.get("summary")
        summary = summary if isinstance(summary, str) else ""
        match = re.match(r"^(?:healthy|degraded|unknown|stalled): ([0-9]+) stalls >=1s in 10 min \(([0-9]+) >=5s\)(?=$|[,;])", summary)
        if match:
            source = "summary"
            counts = tuple(map(int, match.groups()))
    valid = all(type(n) in (int, float) and math.isfinite(n) and n >= 0 and n == int(n) for n in counts)
    valid = valid and counts[1] <= counts[0]
    if not valid:
        counts = (None, None)
    if type(worst) not in (int, float) or not math.isfinite(worst) or worst < 0:
        worst = None
    return dict(source=source, stalls1s=counts[0], stalls5s=counts[1], worstMs=worst)


def connection_failed(report):
    connection = report.get("connection")
    return isinstance(connection, dict) and connection.get("status") in ("error", "failed", "timeout")


def effective_verdict(verdict, report):
    if connection_failed(report):
        return "stalled"
    if verdict != "stalled":
        return verdict
    evidence = stall_evidence(report)
    if evidence["stalls1s"] is None:
        return "unknown"
    if (evidence["stalls5s"] >= STALL_5S or evidence["stalls1s"] >= STALL_1S
            or evidence["stalls5s"] >= 1 and (evidence["worstMs"] or 0) >= 30000):
        return "stalled"
    connection = report.get("connection")
    return "slow-roundtrip" if isinstance(connection, dict) and connection.get("status") == "ok" else "unknown"


def survivors(owned):
    table = processes()
    return {pid: start for pid, start in owned.items() if pid in table and table[pid][1] == start}


def port_listening():
    try:
        return bool(run(["/usr/sbin/lsof", "-nP", "-iTCP:3773", "-sTCP:LISTEN", "-t"], 15).stdout.strip())
    except subprocess.SubprocessError:
        return True


def hold_live():
    hold = read_hold()
    if not isinstance(hold, dict):
        return None
    try:
        os.kill(int(hold.get("pid", 0)) or -1, 0)
        alive = True
    except (ProcessLookupError, ValueError, OverflowError):
        alive = False
    except PermissionError:
        alive = True
    fresh = isinstance(hold.get("beatAt"), (int, float)) and 0 <= time.time() - hold["beatAt"] < 90
    return hold.get("by", "?") if alive and fresh else None


def tmux_session(socket, name, details=None):
    try:
        rc = run([TMUX, "-L", socket, "has-session", "-t", name], 10).returncode
        if rc == 1:  # Only the documented "no session" exit establishes absence.
            return False
        detail = f"{socket}/{name}" if rc == 0 else f"{socket}/{name} probe-failed rc={rc}"
    except (OSError, subprocess.SubprocessError) as error:
        detail = f"{socket}/{name} probe-failed {type(error).__name__}"
    if details is not None:
        details["detail"] = detail
    return True


def qf_install_active(details=None):
    """Hold on active install panes or failed probes, but let old idle shells linger."""
    try:
        result = run([TMUX, "-L", QF_SOCKET, "list-panes", "-a", "-F",
                      "#{session_name}\t#{pane_dead}\t#{pane_current_command}\t#{session_activity}"], 10)
        output = (result.stdout + result.stderr).lower()
        if result.returncode == 1 or "no server running" in output or "error connecting" in output:
            return False
        if result.returncode:
            detail = f"{QF_SOCKET} probe-failed rc={result.returncode}"
        else:
            for line in result.stdout.splitlines():
                fields = line.split("\t")
                if not QF_SESSION_RE.fullmatch(fields[0]):
                    continue
                if len(fields) != 4 or fields[1] not in ("0", "1") or not fields[2]:
                    raise ValueError("unreadable pane")
                name, dead, command, activity = fields
                if dead == "1":
                    continue
                idle = max(0, time.time() - int(activity))
                if command not in ("zsh", "-zsh", "bash", "sh", "login") or idle <= QF_IDLE_SEC:
                    detail = f"{QF_SOCKET}/{name} cmd={command} idle={idle:.0f}s"
                    break
            else:
                return False
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        detail = f"{QF_SOCKET} probe-failed {type(error).__name__}"
    if details is not None:
        details["detail"] = detail
    return True


def building():
    try:
        # Detection only, never used for killing. The release path covers build.zsh, its
        # dependency install in the release clone and the clone-probe helpers (evaluator e71ca349).
        result = run(["/usr/bin/pgrep", "-fl", "build-desktop-artifact|install-robob-fast|/Volumes/ExternalSSD/tmp/release-2026"], 10)
        if result.returncode not in (0, 1):
            return ["build-probe-failed"]
        return [line[:120] for line in result.stdout.splitlines() if "pgrep" not in line][:3]
    except (OSError, subprocess.SubprocessError):
        return ["build-probe-failed"]


def deep_health():
    """Returns (verdict, summary, report). A probe that cannot finish in 90 s is "unknown", never "stalled"."""
    try:
        result = run([NODE, str(HEALTH)], 90)
    except subprocess.TimeoutExpired:
        # t3ctl has its own 30 s request limit, so this is the probe being starved, not proof about Robob.
        return "unknown", "t3ctl health --deep gave no answer in 90 s", {}
    except OSError as error:
        return "unknown", "t3ctl could not run: " + type(error).__name__, {}
    lines = result.stdout.splitlines()
    summary = lines[0][:200] if lines else ""
    try:
        report = json.loads("\n".join(lines[1:]))
        verdict = report.get("verdict")
    except (ValueError, AttributeError):
        report, verdict = {}, None
    if verdict not in ("healthy", "degraded", "unknown", "stalled"):
        # No JSON: fall back to the first word of the summary line; anything else is unknown.
        first = summary.split(":", 1)[0]
        verdict = first if first in ("healthy", "degraded", "unknown", "stalled") else "unknown"
        summary = summary or (result.stderr.strip().splitlines() or ["no output"])[0][:200]
    return verdict, summary, report


def server_started():
    """(pid, start epoch) of the server on port 3773. Taken from the listener itself:
    under launchd this script may not read server-runtime.json on the external SSD."""
    try:
        pids = run(["/usr/sbin/lsof", "-nP", "-iTCP:3773", "-sTCP:LISTEN", "-t"], 15).stdout.split()
        if len(pids) == 1 and pids[0].isdigit():
            out = run(["/bin/ps", "-o", "lstart=,comm=", "-p", pids[0]], 10).stdout.strip()
            parts = out.split(None, 5)
            if len(parts) == 6 and parts[5] == EXECUTABLE:
                return int(pids[0]), time.mktime(time.strptime(" ".join(parts[:5]), "%a %b %d %H:%M:%S %Y"))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    # No fallback to server-runtime.json: it is on the external SSD, and on 17 Nov a plain open() of it
    # from this launchd job blocked for five hours inside restart() while the install hold kept Robob down.
    return None, None


def read_hold():
    result = STATE_DIR / ("hold-read-" + uuid.uuid4().hex + ".json")
    def read():
        write_json(result, read_json(HOLD, None))
    try:
        error = child_probe("hold", read)
        if error:
            return {"pid": os.getpid(), "beatAt": time.time(), "by": error}
        return read_json(result, None)
    finally:
        result.unlink(missing_ok=True)


def preflight():
    # Clearing Mac #107 is an activation prerequisite, even if its marker is stale.
    if MAC_SSD_MARKER.exists():
        return "mac-ssd-marker"
    def open_file(path):
        with open(path, "rb") as handle:
            handle.read(1)
    for name, operation in (
        ("ssd", lambda: open_file(SSD_PROBE)),
        ("app-executable", lambda: open_file(EXECUTABLE)),
        ("userdata", lambda: os.listdir(Path(USERDATA).resolve(strict=True))),
    ):
        reason = child_probe(name, operation)
        if reason:
            return reason
    return None


def attention(reason):
    log("held", reason=reason)
    notify("attention", "Robob restart held: %s. Nothing was quit. Check Mac #106/#107 before restarting." % reason,
           "robob-overload-restart:held:" + reason)


def limits(state, own_session=False, own_hold=False, details=None):
    now = time.time()
    if (STATE_DIR / "disabled").exists():
        return "disabled"
    if not own_hold and hold_live():
        return "live-install-hold"
    if (tmux_session("install", "robob-install", details)
            or (not own_session and tmux_session("restart", "robob-restart", details))
            or qf_install_active(details)):
        return "restart-or-install-session"
    if building():
        return "building"
    _, started = server_started()
    if not started:
        return "server-start-unreadable"
    if now - started < MIN_GAP:
        return "server-up-under-two-hours"
    if now - state.get("lastRestartAt", 0) < MIN_GAP:
        return "last-restart-under-two-hours"
    return None


def probe():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    reason = preflight()
    log("probe", outcome="held" if reason else "ok", reason=reason)
    return 1 if reason else 0


def check():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (STATE_DIR / "check.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        return check_locked()


def check_locked():
    now = time.time()
    state = read_json(STATE, {})
    state.setdefault("checks", [])
    state.setdefault("lastRestartAt", 0)
    if (STATE_DIR / "disabled").exists():
        return 0
    if now >= datetime.datetime.fromisoformat(EXPIRES).timestamp():
        log("expired", note="past EXPIRES; doing nothing")
        return 0
    details = {}
    skip = limits(state, details=details)
    impact = cost()
    if skip is None and impact["treeProcesses"] is None:
        skip = "Robob is not running (the guard reopens it)"
    safety = preflight() if skip is None else None
    if safety:
        attention(safety)
    if skip or safety:
        state["checks"] = []
        state["lastSkip"] = dict(at=iso(now), why=skip or safety)
        log("check", rawVerdict=None, effectiveVerdict=None, stallSource=None, cost=impact,
            stages={}, rule=None, held=skip or safety, **details)
        write_json(STATE, state)
        return 0
    raw, summary, report = deep_health()
    report = dict(report, summary=summary)
    verdict = effective_verdict(raw, report)
    disconnected = connection_failed(report)
    if verdict == "stalled":
        # One retry so a single slow connect does not count.
        time.sleep(20)
        raw, summary, report = deep_health()
        report = dict(report, summary=summary)
        verdict = effective_verdict(raw, report)
        disconnected = disconnected and connection_failed(report)
    evidence = stall_evidence(report)
    stages = {name: "%s/%s" % ((report.get(name) or {}).get("status"), (report.get(name) or {}).get("ms"))
              for name in ("connection", "roundTrip")}
    source = evidence["source"] if evidence["source"] in ("lag", "summary") else None
    state["checks"] = (state["checks"] + [dict(at=now, verdict=verdict, rawVerdict=raw,
        effectiveVerdict=verdict, stallSource=source, summary=summary, connectionFailed=disconnected, evidence=evidence)])[-12:]

    def run_of(count):
        rows = state["checks"][-count:]
        whole = len(rows) == count and all(0 <= b["at"] - a["at"] <= MAX_STEP for a, b in zip(rows, rows[1:]))
        return rows if whole else []

    # Legacy rows contain only the unsafe raw verdict; require freshly classified evidence.
    recent = run_of(NEED)
    rule = None
    if recent and all(c.get("effectiveVerdict") == "stalled" for c in recent):
        rule = "stalled on %d checks in a row" % NEED
    else:
        recent = run_of(LONG)
        if (recent and sum(c.get("effectiveVerdict") in ("healthy", "degraded") for c in recent) <= 1
                and sum(c.get("effectiveVerdict") == "stalled" for c in recent) >= NEED):
            rule = "at most one healthy check in %d (%d stalled)" % (LONG, sum(c.get("effectiveVerdict") == "stalled" for c in recent))
    sustained = rule is not None
    hard = (verdict == "stalled" and evidence["stalls5s"] is not None
            and evidence["stalls5s"] >= 1 and (evidence["worstMs"] or 0) >= 30000)
    hard = hard or bool(sustained and all(c.get("connectionFailed") for c in recent))
    load = os.getloadavg()[0]
    ncpu = os.cpu_count() or 1
    load_limit = LOAD_FACTOR * ncpu
    pid, started = server_started()
    uptime = now - started if started else None
    reason = None
    if sustained:
        impact = cost()  # Refresh after the health retry before weighing active provider processes.
        if uptime is None:
            reason = "server start time unreadable"
        elif uptime < MIN_GAP:
            reason = "server up %d min, under the 2-hour limit" % (uptime / 60)
        elif now - state["lastRestartAt"] < MIN_GAP:
            reason = "last restart %d min ago, under the 2-hour limit" % ((now - state["lastRestartAt"]) / 60)
        elif not hard and load > load_limit:
            reason = "host load %g > %g" % (load, load_limit)
        elif not hard and impact["agentProcesses"] is None:
            reason = "agent process cost unavailable"
        elif (not hard and impact["agentProcesses"] > 0
              and (evidence["stalls5s"] or 0) < 2):
            reason = "agents running (%d), stall not hard" % impact["agentProcesses"]
        elif building():
            reason = "release build, probe or install running: " + "; ".join(building())
        else:
            reason = preflight()
            if reason:
                attention(reason)
    log("check", verdict=verdict, rawVerdict=raw, effectiveVerdict=verdict, stallSource=source, evidence=evidence,
        summary=summary, stages=stages, sustained=sustained, rule=rule, serverPid=pid, cost=impact, hardStall=hard,
        uptimeMin=round(uptime / 60) if uptime else None, load1=round(load, 1), ncpu=ncpu, loadLimit=load_limit, held=reason)
    if not sustained or reason:
        write_json(STATE, state)
        return 0
    since = recent[0]["at"]
    why = "deep health: %s since %s Dubai (%s)" % (rule, dubai(since), summary[:110])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = STATE_DIR / ("restart-%s.log" % stamp)
    state["lastRestartAt"] = now          # written before the quit: a crashed restart cannot repeat early
    state["lastRestart"] = dict(at=iso(now), why=why, log=str(out), serverPid=pid, uptimeMin=round(uptime / 60), stamp=stamp, cost=impact)
    state["checks"] = []
    write_json(STATE, state)
    command = shlex.join(["/bin/zsh", "-f", str(HERE / "launchd-entry.zsh"), "restart", stamp])
    command += " >> " + shlex.quote(str(out)) + " 2>&1"
    if DRY:
        log("dry.trigger", command=command, cost=impact)
        return 0
    try:
        started_tmux = run([TMUX, "-L", "restart", "new-session", "-d", "-s", "robob-restart", command], 20)
    except (OSError, subprocess.SubprocessError) as error:
        log("trigger.failed", error=type(error).__name__, cost=impact)
        terminal(stamp, failed("trigger-error:" + type(error).__name__))
        return 1
    if started_tmux.returncode != 0:
        log("trigger.failed", stderr=started_tmux.stderr[:200], cost=impact)
        terminal(stamp, {"ok": False, "reason": "trigger-failed"})
        return 1
    log("trigger", why=why, log=str(out), cost=impact)
    notify("info", "Robob is overloaded (%s; server up %.1f h; would stop %s agent processes, %s tree processes; running turns/subagents unavailable). Restarting it now. Watch: tmux -L restart attach -t robob-restart, or tail -f %s"
           % (why, uptime / 3600, impact["agentProcesses"], impact["treeProcesses"], out), "robob-overload-restart:%s:start" % stamp)
    return 0


def failed(reason):
    return {"ok": False, "reason": reason}


def restart_worker():
    t0 = time.monotonic()
    old_pid, _ = server_started()
    table = processes()
    root = app_pid(table)
    if root is None:
        return failed("app-process-unidentified")
    owned = tree(table, root)
    if os.getpid() in owned or os.getppid() in owned:
        return failed("inside-robob-tree")
    details = {}
    reason = limits({}, own_session=True, own_hold=True, details=details) or preflight()
    if reason:
        log("held", reason=reason, **details)
        return dict(failed(reason), **details)
    log("restart.tree", appPid=root, processes=len(owned))
    quit_at = time.time()
    try:
        run(["/usr/bin/osascript", "-e", 'tell application id "com.ardud.robob" to quit'], 8)
    except (OSError, subprocess.SubprocessError):
        pass
    sent_term = sent_tree_term = sent_kill = False
    while True:
        left = survivors(owned)
        waited = time.time() - quit_at
        if not left:
            break
        if waited >= 15 and not sent_term and root in left:
            sent_term = True      # Electron quits cleanly on SIGTERM; covers a blocked AppleEvent
            os.kill(root, signal.SIGTERM)
            log("restart.sigterm_app", waited=round(waited))
        if waited >= 75 and not sent_tree_term:
            sent_tree_term = True
            for pid in left:
                try:
                    os.kill(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
            log("restart.sigterm_tree", waited=round(waited), processes=len(left))
        if waited >= 105 and not sent_kill:
            sent_kill = True
            for pid in survivors(owned):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            log("restart.sigkill_tree", waited=round(waited), processes=len(left))
        if waited >= 135:
            break
        time.sleep(1)
    left = survivors(owned)
    app_left = [pid for pid in left if processes().get(pid, (0, "", ""))[2].startswith(APP)]
    log("restart.quit_done", seconds=round(time.time() - quit_at), survivors=len(left), appSurvivors=len(app_left))
    for _ in range(30):
        if not port_listening():
            break
        time.sleep(1)
    if app_left or port_listening():
        return failed("Robob processes or port 3773 survived the quit (%d app processes); not reopening on top of them" % len(app_left))
    opened = run(["/bin/zsh", "-f", str(OPEN_CLEAN), APP], 120)
    log("restart.opened", rc=opened.returncode, stderr=opened.stderr.strip()[:200])
    if opened.returncode:
        return failed("open-failed")
    new_pid = None
    ready = False
    until = time.monotonic() + 900
    while time.monotonic() < until:
        probe_started = time.monotonic()
        log("restart.probe", outcome="started", ms=0, elapsed=round(time.monotonic() - t0, 3),
            holdAge=round(time.monotonic() - t0, 3))
        pid, started = server_started()
        if pid and pid != old_pid and started and started > quit_at - 5:
            new_pid = pid
            _, _, report = deep_health()
            ready = (report.get("roundTrip") or {}).get("status") == "ok" and port_listening()
        log("restart.probe", outcome="ready" if ready else "not-ready",
            ms=round((time.monotonic() - probe_started) * 1000),
            elapsed=round(time.monotonic() - t0, 3), holdAge=round(time.monotonic() - t0, 3))
        if ready:
            break
        time.sleep(5)
    if not ready:
        return failed("readiness-timeout")
    return {"ok": True, "newServerPid": new_pid, "outageSeconds": round(time.time() - quit_at)}


@contextmanager
def claim_cycle(stamp):
    with (STATE_DIR / ("cycle-" + stamp + ".lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            # Forked probes can retain this fd while kernel-stuck; close alone is insufficient.
            fcntl.flock(lock, fcntl.LOCK_UN)


def terminal(stamp, outcome):
    # A timed-out tmux caller may finalize only if no supervisor owns this cycle.
    with claim_cycle(stamp) as owner:
        if not owner:
            log("result.deferred", stamp=stamp, reason="supervisor-owns-cycle")
            return 1
        return terminal_owned(stamp, outcome)


def terminal_owned(stamp, outcome):
    receipt = STATE_DIR / ("result-" + stamp + ".json")
    try:
        with receipt.open("x") as handle:
            json.dump(outcome, handle)
    except FileExistsError:
        return 0 if read_json(receipt, {}).get("ok") else 1
    ok = outcome.get("ok", False)
    log("restart.done" if ok else "restart.failed", stamp=stamp, **outcome)
    text = ("Robob restart finished; new server answered. Log: %s" % LOG if ok else
            "ROBOB IS DOWN or the restart was refused: %s. Check Mac #106/#107, then open Robob "
            "by hand if safe. Hold cleanup: %s. Log: %s" %
            (outcome.get("reason"), outcome.get("holdRelease", "not taken"), LOG))
    notify("info" if ok else "attention", text, "robob-overload-restart:%s:result" % stamp)
    return 0 if ok else 1


def restart(stamp=None):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = stamp or uuid.uuid4().hex
    if not stamp.isalnum():
        raise ValueError("invalid restart stamp")
    with claim_cycle(stamp) as owner:
        if not owner:
            log("restart.duplicate", stamp=stamp)
            return 1
        return supervise(stamp)


def supervise(stamp):
    receipt = STATE_DIR / ("result-" + stamp + ".json")
    if receipt.exists():
        return 0 if read_json(receipt, {}).get("ok") else 1
    outcome = failed("exception")
    child = None
    worker_reaped = False
    held = False
    me = os.getpid()
    result_path = STATE_DIR / ("restart-" + stamp + ".json")
    began = time.monotonic()
    lock = None

    def interrupted(signum, frame):
        raise InterruptedError("supervisor-signal-%s" % signum)

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        lock = (STATE_DIR / "restart.lock").open("a")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_json(STATE, {})
        pending = state.get("lastRestart") or {}
        # check reserves the cooldown before tmux. Only that exact cycle can consume it.
        reserved = pending.get("stamp") == stamp and not pending.get("consumed")
        details = {}
        reason = limits(dict(state, lastRestartAt=0) if reserved else state, own_session=reserved, details=details)
        if not reason:
            reason = preflight()
            if reason:
                log("held", reason=reason)
        if reason:
            outcome = dict(failed(reason), **details)
        elif DRY:
            outcome = failed("dry-run: nothing quit")
        else:
            state["lastRestartAt"] = time.time()
            state["lastRestart"] = dict(pending, stamp=stamp, consumed=True)
            write_json(STATE, state)
            log("restart.begin", stamp=stamp, deadline=RESTART_DEADLINE)
            # Even partial acquisition must be cleaned up. The holder is this bounded parent.
            held = True
            hold = run([HOLD_CLI, "start", "--by", BY, "--pid", str(me)], 30)
            if hold.returncode:
                outcome = failed("hold-start-failed")
            else:
                # No termination handler may run between fork and parent-side group setup.
                old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, previous)
                try:
                    child = os.fork()
                    if child == 0:
                        try:
                            os.setpgid(0, 0)
                            for sig in previous:
                                signal.signal(sig, signal.SIG_DFL)
                            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                            try:
                                answer = restart_worker()
                            except BaseException as error:
                                answer = failed("exception:" + type(error).__name__ + ":" + str(error)[:160])
                            write_json(result_path, answer)
                        finally:
                            # A worker setup/write failure must never execute supervisor cleanup.
                            os._exit(0)
                    try:
                        os.setpgid(child, child)
                    except ProcessLookupError:
                        pass
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                log("restart.worker", pid=child, stamp=stamp)
                # Never join a possibly kernel-stuck worker.
                while time.monotonic() - began < RESTART_DEADLINE:
                    pid, status = os.waitpid(child, os.WNOHANG)
                    if pid:
                        worker_reaped = True
                        outcome = read_json(result_path, failed("worker-exit:%s" % status))
                        break
                    time.sleep(0.05)
                else:
                    outcome = failed("deadline")
                    elapsed = round(time.monotonic() - began, 3)
                    log("restart.probe", outcome="deadline", ms=round(elapsed * 1000),
                        elapsed=elapsed, holdAge=elapsed)
    except BaseException as error:
        outcome = failed("supervisor:" + type(error).__name__ + ":" + str(error)[:160])
    finally:
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        if child:
            kill_group(child, leader_alive=not worker_reaped)
            try:
                os.waitpid(child, os.WNOHANG)
            except ChildProcessError:
                pass
        if held:
            try:
                released = run([HOLD_CLI, "stop", "--by", BY, "--pid", str(me)], 30)
                outcome["holdRelease"] = "released" if released.returncode == 0 else "failed"
                log("hold.released" if released.returncode == 0 else "hold.release_failed", rc=released.returncode)
                if released.returncode:
                    outcome["ok"] = False
            except (OSError, subprocess.SubprocessError) as error:
                log("hold.release_failed", error=type(error).__name__)
                outcome.update(ok=False, holdRelease="failed")
        result_path.unlink(missing_ok=True)
        try:
            rc = terminal_owned(stamp, outcome)
        finally:
            if lock:
                fcntl.flock(lock, fcntl.LOCK_UN)
                lock.close()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return rc


def status():
    state = read_json(STATE, {})
    pid, started = server_started()
    print(json.dumps(dict(disabled=(STATE_DIR / "disabled").exists(), expires=EXPIRES, expiresScope="check", serverPid=pid,
                          serverUptimeMin=round((time.time() - started) / 60) if started else None,
                          lastRestart=state.get("lastRestart"), lastSkip=state.get("lastSkip"),
                          checks=[dict(at=iso(c["at"]), verdict=c["verdict"]) for c in state.get("checks", [])]), indent=1))
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    sys.exit(dict(check=check, restart=lambda: restart(sys.argv[2] if len(sys.argv) > 2 else None),
                  status=status, probe=probe).get(mode, lambda: print(__doc__) or 2)())
