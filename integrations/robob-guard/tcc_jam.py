"""Bounded sandboxd inventory and conservative, journalled TCC jam recovery."""
import collections
import datetime
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shlex
import signal
import subprocess
import tempfile
import time

TCCD = "/System/Library/PrivateFrameworks/TCC.framework/Support/tccd"
FDA_INTERPRETERS = frozenset({"/bin/zsh"})
USER = "ardud"
UID = 501
DOMAIN = "gui/501"
DENIED_LABELS = frozenset({"com.ardud.robob", "com.ardud.robob-server", "com.ardud.robob-guard",
                           "com.ardud.opencode-service", "com.ardud.opencode-web"})
ARTIFACT = ".robob/board-artifacts/launchd-ssd-open-1117/actions.ndjson"
LOG_COMMAND = ["/usr/bin/log", "show", "--last", "60s", "--style", "compact",
               "--info", "--debug", "--predicate", 'process == "tccd"']
PROTECTED = re.compile(
    r"/Applications/|/System/|/usr/libexec/|(?:^|[/\s])(?:Robob|robob|opencode|codex|claude|cursor|grok|antigravity)(?:[/\s.\-]|$)"
    r"|apps/server/(?:dist|src)/|opencode\d*(?:/|\s)|opencode-service|provider[-_]session|\bagy\b", re.I)


def run(argv, timeout=5, env=None):
    """No shell expansion; every process operation has its own deadline."""
    try:
        # Pipes + run(timeout) can wait forever after killing a kernel-stuck
        # child. Regular files and bounded wait never depend on its EOF or exit.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd="/", env=env)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                child.kill()  # Our unreaped child PID cannot have been reused.
                code = None
            out.seek(0)
            err.seek(0)
            raw_out, raw_err = out.read(2_000_001), err.read(4097)
            return dict(argv=argv, exit_code=code,
                        stdout=raw_out[:2_000_000].decode("utf-8", "replace"),
                        stderr=raw_err[:4096].decode("utf-8", "replace") or ("timeout" if code is None else ""),
                        stdout_truncated=len(raw_out) > 2_000_000, stderr_truncated=len(raw_err) > 4096)
    except (OSError, subprocess.SubprocessError) as error:
        return dict(argv=argv, exit_code=None, stdout="", stderr=type(error).__name__)


def append(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as out:
        out.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")


def stamp(now):
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_process(value):
    return (isinstance(value, dict) and type(value.get("pid")) is int and value["pid"] > 1
            and type(value.get("uid")) is int and type(value.get("ppid")) is int
            and all(isinstance(value.get(k), str) and value[k] for k in ("comm", "args", "lstart")))


def validate_state(raw):
    """Keep the TCC safety journal independent of backend-state validation."""
    state = dict(raw) if isinstance(raw, dict) else {}
    last = state.get("last_tccd_restart")
    if last is not None and not number(last):
        state.pop("last_tccd_restart")
        state["restart_disabled"] = "invalid persisted restart timestamp"
    lease = state.get("stopped")
    if lease is not None and not (isinstance(lease, dict) and valid_process(lease.get("process"))
            and number(lease.get("deadline")) and lease.get("phase", "active") in ("pending", "active")
            and isinstance(lease.get("chain"), list)
            and 1 <= len(lease["chain"]) <= 12
            and all(valid_process(p) for p in lease["chain"])
            and (lease.get("owner") is None or valid_process(lease["owner"]))
            and all(lease.get(k) is None or isinstance(lease[k], str) for k in ("label", "plist"))):
        state["invalid_stopped"] = state.pop("stopped")
        state["restart_disabled"] = "invalid persisted suspension lease; manual reconciliation needed"
    pending = state.get("pending_prompts", [])
    if not isinstance(pending, list) or any(not isinstance(r, dict)
            or not isinstance(r.get("msgID"), str) or not isinstance(r.get("path"), str)
            or not isinstance(r.get("pids"), dict)
            or any(not isinstance(p, dict) or type(p.get("pid")) is not int
                   or not isinstance(p.get("path"), str) for p in r["pids"].values()) for r in pending):
        state["pending_prompts"] = []
        state["restart_disabled"] = "invalid persisted prompt attribution"
    if state.get("episode") in ("jammed", "unknown_stall") and not isinstance(state.get("start"), str):
        state.update(episode="healthy", mode="observing")
    return state


def inventory():
    found = run(["/usr/bin/pgrep", "-x", "sandboxd"], 2)
    pids = found["stdout"].split()
    if found["exit_code"] != 0 or len(pids) != 1 or not pids[0].isdigit():
        return None, None
    pid = int(pids[0])
    result = run(["/bin/ps", "-M", "-p", str(pid)], 2)
    lines = result["stdout"].strip().splitlines()
    if result["exit_code"] != 0 or len(lines) < 2 or "PID" not in lines[0]:
        return pid, None
    # ps -M prints USER only on the first thread row, then leaves that cell blank.
    if any(str(pid) not in line.split()[:2] for line in lines[1:]):
        return pid, None
    return pid, len(lines) - 1


def parse_log(text, sandbox_pid, tccd_pid=None, window_end=None):
    requests = {}
    for line in text.splitlines():
        emitter = re.search(r"\btccd\[(\d+)(?:\]|:)", line)
        if tccd_pid is not None and (not emitter or int(emitter[1]) != tccd_pid):
            continue
        match = re.search(r"msgID=(\d+)\.(\d+)", line)
        if not match or int(match[1]) != sandbox_pid:
            continue
        key = match[0].split("=", 1)[1]
        req = requests.setdefault(key, dict(msgID=key, sequence=int(match[2]), pids={}))
        if emitter:
            req["tccd_pid"] = int(emitter[1])
        timestamp = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)", line)
        if timestamp:
            value = re.sub(r"([+-]\d\d)(\d\d)$", r"\1:\2", timestamp[1]).replace("Z", "+00:00")
            try:
                req.setdefault("time", datetime.datetime.fromisoformat(value).timestamp())
            except ValueError:
                pass
        service = re.search(r"service=([^,\s]+)", line)
        if service:
            req["service"] = service[1]
        subject = re.search(r"AUTHREQ_SUBJECT:.*?subject=(.*?),\s*$", line)
        if subject:
            req["path"] = subject[1]
        prompting = re.search(r"AUTHREQ_PROMPTING:.*?Sub:\{([^}]+)\}", line)
        if prompting:
            req.update(path=prompting[1], prompting=True)
        if "AUTHREQ_RESULT:" in line:
            req["result"] = True
        for role, body in re.findall(r"(accessing|responsible)=\{([^}]+)\}", line):
            pid = re.search(r"\bpid=(\d+)", body)
            binary = re.search(r"binary_path=([^,}]+)", body)
            if pid and binary:
                req["pids"][role] = dict(pid=int(pid[1]), path=binary[1])
        # PROMPTING's Resp block can survive when its ATTRIBUTION line was dropped.
        resp = re.search(r"Resp:\{([^}]+)\}", line)
        if resp:
            pid = re.search(r"\bpid=(\d+)", resp[1])
            binary = re.search(r"binary_path=([^,}]+)", resp[1])
            if pid and binary:
                req["pids"]["responsible"] = dict(pid=int(pid[1]), path=binary[1])
    records = list(requests.values())
    results = [r["msgID"] for r in records if r.get("result")]
    requests = [r for r in requests.values()
                if r.get("path") and r.get("service") == "kTCCServiceSystemPolicyRemovableVolumes"]
    counts = collections.Counter(r["path"] for r in requests)
    timed = [r for r in requests if "time" in r]
    if window_end is None:
        window_end = max((r["time"] for r in timed), default=0)
    rate = 0
    if len(timed) >= 2:
        first, last = min(timed, key=lambda r: r["sequence"]), max(timed, key=lambda r: r["sequence"])
        seconds = last["time"] - first["time"]
        if seconds > 0:
            rate = (last["sequence"] - first["sequence"]) / seconds
    top = []
    for path, count in counts.most_common(3):
        related = [r for r in requests if r["path"] == path]
        pids = {p["pid"] for r in related for p in r["pids"].values() if p["path"] == path}
        times = [r["time"] for r in related if "time" in r]
        # Count over the requested 60-second window, including quiet time. A
        # millisecond burst must not look sustained when replayed next tick.
        observed_rate = sum(window_end - 60 <= t <= window_end for t in times) / 60
        top.append(dict(path=path, count=count, rate=rate * count / len(requests),
                        observed_rate=observed_rate, last_time=max(times) if times else None,
                        last_sequence=max(r["sequence"] for r in related),
                        pids=sorted(pids), share=count / len(requests)))
    prompts = [r for r in requests if r.get("prompting") and not r.get("result")]
    return dict(top_subjects=top, request_rate=rate, rate_basis="sandboxd msgID delta; subject share estimated",
                records=records, results=results, prompts=sorted(prompts, key=lambda r: r["sequence"], reverse=True))


def identity(pid):
    if type(pid) is not int or pid <= 1:
        return None
    fields = {}
    # comm must be last, separately: macOS truncates it before another column.
    for field in ("uid", "ppid", "lstart", "args", "comm"):
        result = run(["/bin/ps", "-ww", "-p", str(pid), "-o", field + "="], 2)
        value = result["stdout"].strip()
        if result["exit_code"] != 0 or not value or "\n" in value:
            return None
        fields[field] = value
    try:
        fields.update(pid=pid, uid=int(fields["uid"]), ppid=int(fields["ppid"]))
    except ValueError:
        return None
    # A second birth read rejects a PID recycled during the multi-field capture.
    birth = run(["/bin/ps", "-ww", "-p", str(pid), "-o", "lstart="], 2)
    return fields if birth["exit_code"] == 0 and birth["stdout"].strip() == fields["lstart"] else None


def ancestry(proc):
    chain = [proc]
    seen = {proc["pid"]}
    while chain[-1]["ppid"] != 1:
        parent_pid = chain[-1]["ppid"]
        if parent_pid in seen or len(chain) >= 12:
            return None
        parent = identity(parent_pid)
        if not parent:
            return None
        seen.add(parent_pid)
        chain.append(parent)
    return chain


def denied(chain, user_tccd=False):
    if not chain:
        return "unverified ancestry"
    if user_tccd and not (chain[0]["uid"] == UID and chain[0]["comm"] == TCCD
                          and chain[0]["args"] == TCCD and chain[0]["ppid"] == 1):
        return "not the exact user tccd"
    for index, proc in enumerate(chain):
        if (user_tccd and index == 0 and proc["uid"] == UID and proc["comm"] == TCCD
                and proc["args"] == TCCD and proc["ppid"] == 1):
            continue
        if proc["uid"] != UID or PROTECTED.search(proc["comm"] + " " + proc["args"]):
            return "protected process or ancestry"
    # /bin/zsh and other system interpreters also run disposable agent jobs.
    # Their path alone is not an OS-service identity; #130 explicitly covers
    # these askers. UID, full ancestry and launchd ownership remain mandatory.
    return None


def jobs():
    result = run(["/bin/launchctl", "list"], 3)
    if result["exit_code"] != 0:
        return None
    return {int(parts[0]): parts[2] for line in result["stdout"].splitlines()
            if len(parts := line.split()) == 3 and parts[0].isdigit()}


def installed(home):
    found = {}
    try:
        for path in (home / "Library/LaunchAgents").glob("*.plist"):
            try:
                with path.open("rb") as source:
                    value = plistlib.load(source)
                label = value.get("Label")
                if isinstance(label, str):
                    found[label] = str(path)
            except (OSError, ValueError, plistlib.InvalidFileException):
                # An unreadable inventory cannot prove a label is a leftover.
                return None
    except OSError:
        return None
    return found


def target(pid, path, job_list, plists, request_time=None):
    proc = identity(pid)
    if not proc or proc["comm"] != path:
        return None
    try:
        birth = time.mktime(time.strptime(proc["lstart"], "%a %b %d %H:%M:%S %Y"))
    except (ValueError, OverflowError):
        return None
    if not number(request_time) or birth > request_time:
        return None
    chain = ancestry(proc)
    label, owner = None, None
    for parent in chain or []:
        if job_list and parent["pid"] in job_list:
            label, owner = job_list[parent["pid"]], parent
            break
    return dict(process=proc, chain=chain, label=label, owner=owner,
                plist=(plists or {}).get(label), request_time=request_time)


def same_process(left, right):
    # A removed launchd parent can reparent its surviving child to pid 1.
    return bool(left and right and all(left.get(k) == right.get(k)
                                      for k in ("pid", "uid", "lstart", "comm", "args")))


def action_refusal(candidate, action, user_tccd):
    expected = candidate["process"]
    current = identity(expected["pid"])
    chain = ancestry(current) if current else None
    if not same_process(current, expected) or denied(chain, user_tccd):
        return "identity or protected ancestry changed"
    if user_tccd:
        return None  # Exact uid/path/parent checks above identify the one exception.
    current_jobs = jobs()
    if current_jobs is None:
        return "launchd ownership unavailable"
    owners = [(parent, current_jobs[parent["pid"]]) for parent in chain if parent["pid"] in current_jobs]
    if candidate.get("label") in DENIED_LABELS or any(label in DENIED_LABELS for _, label in owners):
        return "protected launchd label"
    label, owner = candidate.get("label"), candidate.get("owner")
    if candidate.get("label_removed"):
        if owners or label in current_jobs.values() or action in ("remove", "bootout"):
            return "removed launchd ownership changed"
    elif label:
        if (not owner or not owners or owners[0][1] != label
                or not same_process(owners[0][0], owner) or not same_process(identity(owner["pid"]), owner)):
            return "launchd owner changed"
    elif owners or action in ("remove", "bootout"):
        return "launchd owner not attributed"
    return None


def leftover(candidate, plists):
    chain = candidate["chain"] or []
    label = candidate["label"]
    if (plists is not None and label and label.startswith(("com.ardud.", "mac.ssdprobe."))
            and label not in plists):
        return True
    for proc in chain:
        if re.search(r"/Users/ardud/\.robob/board-artifacts/|/var/folders/[^\s]+/T/", proc["args"]):
            return True
        interpreter = re.fullmatch(r"(?:node|python[\d.]*|ruby|perl|bash|sh|zsh)", Path(proc["comm"]).name)
        if proc["ppid"] == 1 and interpreter and proc["comm"] not in FDA_INTERPRETERS:
            return True
    return False


def safe_action(home, candidate, action, now, why, user_tccd=False):
    """Revalidate the entire protection boundary immediately before each mutation."""
    expected = candidate["process"]
    refusal = action_refusal(candidate, action, user_tccd)
    if refusal:
        return dict(action=action, ok=False, why=refusal)
    label = candidate.get("label")
    undo = None
    if action == "SIGSTOP":
        undo = "kill -CONT %s (after verifying lstart=%s)" % (expected["pid"], expected["lstart"])
    if action == "bootout" and candidate.get("plist"):
        undo = "launchctl bootstrap %s %s" % (DOMAIN, shlex.quote(candidate["plist"]))
    row = dict(ts=stamp(now), action=action, pid=expected["pid"], identity=expected,
               label=label, why=why, authority="Mac Upkeep #130 recovery ladder",
               undo=undo, phase="attempt")
    if action == "SIGSTOP":
        row.update(deadline=now + 60, followup="identity-checked SIGCONT if flood ceases; otherwise bootout and SIGKILL")
    # A failed evidence write must prevent the mutation.
    for path in (home / ARTIFACT, home / ".local/state/robob-guard/tcc-jam.ndjson"):
        append(path, row)
    # Journal I/O may itself stall. Recheck after it, not just before it.
    refusal = action_refusal(candidate, action, user_tccd)
    if refusal:
        return dict(action=action, ok=False, why=refusal)
    try:
        if action in ("remove", "bootout"):
            command = ["/bin/launchctl", "remove", label] if action == "remove" else ["/bin/launchctl", "bootout", DOMAIN + "/" + label]
            result = run(command, 5)
            ok = result["exit_code"] == 0
        else:
            os.kill(expected["pid"], getattr(signal, action))
            result, ok = {}, True
            if action in ("SIGSTOP", "SIGCONT"):
                result = run(["/bin/ps", "-p", str(expected["pid"]), "-o", "stat="], 2)
                result["stopped"] = result["stdout"].strip().startswith("T")
    except OSError as error:
        result, ok = dict(error=type(error).__name__), False
    row.update(phase="result", ok=ok, result=result)
    for path in (home / ARTIFACT, home / ".local/state/robob-guard/tcc-jam.ndjson"):
        append(path, row)
    return row


def recover(home, state, diagnosis, now, save):
    candidates = diagnosis["candidates"]
    plists = diagnosis["plists"]
    actions = []
    if diagnosis.get("log_exit_code") != 0:
        return [], "TCC log inventory incomplete; evidence only"
    for candidate in candidates:
        if not denied(candidate["chain"]) and leftover(candidate, plists):
            why = "leftover launchd asker prompting or flooding"
            if candidate["label"]:
                actions.append(safe_action(home, candidate, "remove", now, why))
                if not actions[-1].get("ok"):
                    return actions, "asker removal refused or failed"
                candidate = dict(candidate, label_removed=True)
            actions.append(safe_action(home, candidate, "SIGKILL", now, why))
            return actions, why
    flood = diagnosis.get("flood")
    if flood and state["flood_ticks"] >= 2 and not denied(flood["chain"]):
        why = "one subject exceeds 50 requests/s on consecutive ticks"
        stopped = state.get("stopped")
        if stopped and same_process(stopped["process"], flood["process"]):
            if stopped.get("phase", "active") != "active":
                return [], "unconfirmed STOP intent; evidence only"
            if not flood["label"] or not flood["plist"]:
                return [], "flood persists; no verified LaunchAgent to unload"
            actions.append(safe_action(home, flood, "bootout", now, why))
            if actions[-1].get("ok"):
                state["stopped"]["label_removed"] = True
                save()
                actions.append(safe_action(home, dict(flood, label_removed=True), "SIGKILL", now, why))
            return actions, why
        if stopped or "invalid_stopped" in state:
            return [], "prior suspension lease must settle before another STOP"
        # Persist the lease before STOP. No stopped process is left indefinitely.
        state["stopped"] = dict(flood, deadline=now + 60, phase="pending")
        save()
        actions.append(safe_action(home, flood, "SIGSTOP", now, why))
        if actions[-1].get("ok"):
            state["stopped"]["phase"] = "active"
        else:
            state.pop("stopped", None)
        save()
        return actions, why
    tccd = diagnosis.get("tccd_identity")
    if diagnosis["prompting"] and state["prompt_ticks"] >= 2:
        if candidates or diagnosis.get("asker_unverified"):
            return [], "asker remains; user tccd restart deferred"
        if os.environ.get("TCC_AUTO_RESTART", "").lower() not in ("1", "true", "yes"):
            return [], "TCC_AUTO_RESTART off; user tccd prompt wait (log only)"
        if state.get("restart_disabled") or not diagnosis.get("prompts"):
            return [], "unresolved or missing prompt history; user tccd restart deferred"
        last = state.get("last_tccd_restart")
        if last is not None and now - last < 3600:
            return [], "user tccd restart limited to once per 60 minutes"
        if not tccd or denied([tccd], user_tccd=True):
            return [], "user tccd identity unverified"
        state["last_tccd_restart"] = now
        save()
        actions.append(safe_action(home, dict(process=tccd), "SIGKILL", now,
                                   "persistent user tccd prompt wait", user_tccd=True))
        return actions, "persistent user tccd prompt wait"
    return [], "no safe recovery rung applies"


def diagnose(home, sandbox_pid, pending_prompts=(), now=None):
    logs = run(LOG_COMMAND, 20)
    found = run(["/usr/bin/pgrep", "-u", USER, "-x", "tccd"], 2)
    pids = found["stdout"].split()
    pid = int(pids[0]) if found["exit_code"] == 0 and len(pids) == 1 and pids[0].isdigit() else None
    parsed = parse_log(logs["stdout"], sandbox_pid, pid, window_end=now if now is not None else time.time())
    proc = identity(pid)
    sample = run(["/usr/bin/sample", str(pid), "1"], 5) if proc and not denied([proc], True) else None
    prompting = bool(sample and sample["exit_code"] == 0 and "CFUserNotificationReceiveResponse" in sample["stdout"])
    # A hidden notification can outlive the log window by hours. Never infer that
    # its asker vanished just because its original ATTRIBUTION aged out.
    combined = {r["msgID"]: r for r in pending_prompts
                if r.get("tccd_pid") == pid and r["msgID"].split(".")[0] == str(sandbox_pid)}
    prompt_ids = {r["msgID"] for r in parsed["prompts"]}
    for incoming in parsed["records"]:
        if incoming["msgID"] not in combined and incoming["msgID"] not in prompt_ids:
            continue
        prior = combined.get(incoming["msgID"], {})
        merged = dict(prior, **incoming)
        merged["pids"] = dict(prior.get("pids", {}), **incoming["pids"])
        times = [r["time"] for r in (prior, incoming) if number(r.get("time"))]
        if times:
            merged["time"] = min(times)
        combined[incoming["msgID"]] = merged
    for key in parsed["results"]:
        combined.pop(key, None)
    parsed["prompts"] = list(combined.values())
    job_list, plists = jobs(), installed(home)
    incomplete = logs["exit_code"] != 0 or logs.get("stdout_truncated", False)
    asker_unverified = incomplete or job_list is None or len(parsed["prompts"]) > 8
    candidates = []
    for req in parsed["prompts"][:8]:
        for item in req["pids"].values():
            candidate = target(item["pid"], item["path"], job_list, plists, req.get("time"))
            if candidate and candidate not in candidates:
                candidates.append(candidate)
            if candidate is None:
                status = run(["/bin/ps", "-p", str(item["pid"]), "-o", "pid="], 2)
                if status["exit_code"] != 1:
                    asker_unverified = True
        if not req["pids"]:
            asker_unverified = True
    flood = None
    if parsed["top_subjects"]:
        top = parsed["top_subjects"][0]
        # Shared interpreters and mixed requesters cannot identify one offender.
        # msgID gaps include other services and dropped records. Preserve that
        # rate as evidence, but only observed subject throughput authorizes STOP.
        if top["observed_rate"] > 50 and top["share"] > .5 and len(top["pids"]) == 1:
            flood = target(top["pids"][0], top["path"], job_list, plists, top["last_time"])
            if flood and flood not in candidates:
                candidates.append(flood)
    return dict(parsed, tccd_pid=pid, tccd_identity=proc, prompting=prompting,
                logs=logs, log_exit_code=logs["exit_code"] if not incomplete else None, sample=sample, candidates=candidates,
                flood=flood, flood_sequence=parsed["top_subjects"][0]["last_sequence"] if flood else None,
                plists=plists, asker_unverified=asker_unverified)


def unknown_evidence(home, pid):
    evidence = {}
    if pid:
        evidence["sandboxd_sample"] = run(["/usr/bin/sample", str(pid), "1"], 5)
    # #107 persists its gated child before releasing the reader.
    try:
        probe = json.loads((home / ".local/state/mac-upkeep/ssd-read-probe.json").read_text())
        child_pid = probe.get("child", {}).get("pid")
        if type(child_pid) is int and child_pid > 1:
            evidence["probe_sample"] = run(["/usr/bin/sample", str(child_pid), "1"], 5)
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    processes = run(["/bin/ps", "-axo", "pid,ppid,stat,etime,comm"], 5)
    processes["stdout"] = "\n".join(line for line in processes["stdout"].splitlines()
                                         if len(line.split()) >= 3 and "U" in line.split()[2])
    evidence["u_processes"] = processes
    evidence["logs"] = run(LOG_COMMAND[:-1] + ['process == "tccd" OR process == "sandboxd"'], 20)
    return evidence


def tick(home, guard_state, now, save, notify):
    state = validate_state(guard_state.get("tcc_jam"))
    guard_state["tcc_jam"] = state
    for key in ("high_ticks", "null_ticks", "flood_ticks", "prompt_ticks"):
        if type(state.get(key)) is not int or not 0 <= state[key] <= 10000:
            state[key] = 0
    last = state.get("last_tccd_restart")
    if last is not None and (type(last) not in (int, float) or not math.isfinite(last)):
        # Corrupt cooldown data never permits an automatic system-process action.
        state["last_tccd_restart"] = now
    last_tick = state.get("last_tick", now)
    if type(last_tick) not in (int, float) or not math.isfinite(last_tick):
        last_tick = 0
    pid, threads = inventory()
    if not 0 <= now - last_tick <= 90:
        state.update(high_ticks=0, null_ticks=0, prompt_ticks=0, flood_ticks=0)
    elif state.get("sandboxd_pid") != pid:
        state.update(high_ticks=0, prompt_ticks=0, flood_ticks=0)
    state.update(sandboxd_pid=pid, last_tick=now)
    state["high_ticks"] = min(10000, state["high_ticks"] + 1) if threads is not None and threads >= 78 else 0
    state["null_ticks"] = min(10000, state["null_ticks"] + 1) if threads is None else 0
    previous = state.get("episode", "healthy")
    mode = ("unknown_stall" if state["null_ticks"] >= 2 else
            "jammed" if state["high_ticks"] >= 2 else
            "healthy" if threads is not None and threads < 60 else "observing")
    # Hysteresis: 60..77 threads cannot clear a confirmed jam.
    if previous == "jammed" and threads is not None and threads >= 60:
        mode = "jammed"
    path = home / ".local/state/robob-guard/tcc-jam.ndjson"

    def alert(event, text, key):
        payload = dict(kind="tcc-jam", at=now, text=text)
        ok = notify(home, key, payload)
        append(path, dict(ts=stamp(now), event="notify", key=key, text=payload.get("notification_text", text),
                          exit_code=payload.get("exit_code", 0 if ok else None), success=ok))

    # STOP leases are enforced even after recovery or inventory loss. In unknown
    # stalls they remain evidence-only; the first known inventory resolves them.
    stopped = state.get("stopped")
    if (stopped and stopped.get("phase") == "pending" and threads is not None
            and now >= stopped["deadline"] and not stopped.get("intent_alerted")):
        alert("action", "SSD jam recovery has an unconfirmed STOP intent for pid %s; inspect the action journal before resuming it." %
              stopped["process"]["pid"], "tcc-jam:%s:stop-unconfirmed" % state.get("start", now))
        stopped["intent_alerted"] = True
        state["restart_disabled"] = "unconfirmed STOP intent"
    if stopped and stopped.get("phase", "active") == "active" and threads is not None and now >= stopped["deadline"]:
        result = safe_action(home, stopped, "SIGCONT", now, "flood suspension lease expired")
        current = identity(stopped["process"]["pid"])
        gone = run(["/bin/ps", "-p", str(stopped["process"]["pid"]), "-o", "pid="], 2)["exit_code"] == 1 if current is None else False
        if result.get("ok") or gone or (current is not None and not same_process(current, stopped["process"])):
            state.pop("stopped", None)
        alert("action", "SSD jam recovery: suspension lease ended for pid %s (%s)." %
              (stopped["process"]["pid"], result.get("ok")), "tcc-jam:%s:resume" % state.get("start", now))
    if mode in ("jammed", "unknown_stall") and previous != mode:
        state.update(start=stamp(now), episode=mode, prompt_ticks=0, flood_ticks=0)
        state.pop("last_action_alert", None)
        alert("start", "SSD %s: sandboxd pid=%s threads=%s. Capturing bounded evidence." %
              (mode, pid, threads), ("ssd-stall:" if mode == "unknown_stall" else "tcc-jam:") + state["start"])
    elif mode == "healthy" and previous in ("jammed", "unknown_stall"):
        alert("clear", "SSD stall all-clear: sandboxd pid=%s threads=%s." % (pid, threads),
              "tcc-jam:%s:clear" % state["start"])
        state["episode"] = "healthy"
    state["mode"] = mode
    save()
    if mode not in ("jammed", "unknown_stall"):
        state.update(prompt_ticks=0, flood_ticks=0)
        return
    row = dict(ts=stamp(now), state=mode, sandboxd_pid=pid, sandboxd_threads=threads,
               start=state["start"], action=[], why="evidence only", prompting_subject=None,
               prompting_pid=None, prompting_label=None, top_subjects=[], tccd_pid=None, prompting=False)
    if mode == "unknown_stall":
        row["evidence"] = unknown_evidence(home, pid)
    else:
        diagnosis = diagnose(home, pid, state.get("pending_prompts", []), now)
        for key in ("top_subjects", "request_rate", "rate_basis", "tccd_pid", "prompting", "log_exit_code", "sample", "logs"):
            row[key] = diagnosis[key]
        row["prompts"] = diagnosis["prompts"]
        row["asker_unverified"] = diagnosis.get("asker_unverified", False)
        row["candidates"] = diagnosis["candidates"]
        state["pending_prompts"] = diagnosis["prompts"]
        if diagnosis["prompts"]:
            row["prompting_subject"] = diagnosis["prompts"][0]["path"]
        if diagnosis["candidates"]:
            row.update(prompting_pid=diagnosis["candidates"][0]["process"]["pid"],
                       prompting_label=diagnosis["candidates"][0]["label"])
        tccd_key = diagnosis["tccd_identity"]
        state["prompt_ticks"] = state["prompt_ticks"] + 1 if diagnosis["prompting"] and state.get("tccd_identity") == tccd_key else int(diagnosis["prompting"])
        state["tccd_identity"] = tccd_key
        flood_key = diagnosis["flood"]["process"] if diagnosis["flood"] else None
        sequence = diagnosis.get("flood_sequence")
        prior_sequence = state.get("flood_sequence")
        same_flood = same_process(flood_key, state.get("flood_identity"))
        progress = (type(sequence) is int and (not same_flood or prior_sequence is None
                    or (type(prior_sequence) is int and sequence > prior_sequence)))
        state["flood_ticks"] = (state["flood_ticks"] + 1 if progress and same_flood
                                else int(bool(flood_key) and progress))
        state["flood_identity"] = flood_key
        state["flood_sequence"] = sequence
        save()
        row["action"], row["why"] = recover(home, state, diagnosis, now, save)
    append(path, row)
    if row["action"] or "log only" in row["why"]:
        signature = json.dumps([[(a["action"], a.get("pid"), a.get("ok")) for a in row["action"]], row["why"]])
        if state.get("last_action_alert") != signature:
            alert("action", "SSD jam recovery: %s. %s" %
                  (", ".join(a["action"] for a in row["action"]) or "no action", row["why"]),
                  "tcc-jam:%s:action:%s" % (state["start"], now))
            state["last_action_alert"] = signature
    save()
