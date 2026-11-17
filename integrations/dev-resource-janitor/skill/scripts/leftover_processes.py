"""Process evidence and opt-in session cleanup. Unknown or incomplete always keeps."""
import ctypes
import datetime
import json
import math
import os
import re
import shlex
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import active_sessions

IDLE_GRACE = 2 * 60 * 60
NATIVE_KEYS = {"CLAUDE_CODE_SESSION_ID": "claudeAgent", "CODEX_THREAD_ID": "codex"}
THREAD_KEYS = {"T3_THREAD_ID", "T3CODE_THREAD_ID", "ROBOB_THREAD_ID"}
TERMINAL = {"completed", "cancelled", "failed", "interrupted"}
OWNER_CALL_TIMEOUT = 20
OBSERVATION_BUDGET = 10 * 60
OWNER_ENDPOINTS = ("by_native", "detail", "recovery")


def redact_opaque_token(match):
    token = match.group()
    if token.startswith(("/", "~/", "./")):
        return token
    segments = token.split("/")
    if (len(segments) > 1
            and re.fullmatch(r'[\w.@+~-]+(?:/[\w.@+~-]+)+/?', token)
            # Slash-separated opaque credentials also have short segments.
            and (any(segment.startswith('.') for segment in segments)
                 or re.search(r'\.[a-zA-Z][a-zA-Z0-9]{0,9}$', segments[-1]))
            and all(len(segment) < 32 or re.search(r'\.[a-zA-Z][a-zA-Z0-9]{0,9}$', segment)
                    for segment in segments)):
        return token
    return re.sub(r'(?<![\w-])[A-Za-z0-9_+/=.\-]{32,}(?![\w-])', '[REDACTED]', token)


def redact(command):
    # Redact before shortening: a truncated flag value must not escape matching.
    command = re.sub(r'(?i)([a-z][a-z0-9+.-]*://)[^\s/?#]*@', r'\1[REDACTED]@', command)
    command = re.sub(r'(?i)((?:authorization|proxy-authorization)[= :]+(?:basic|bearer)\s+)\S+',
                     r'\1[REDACTED]', command)
    command = re.sub(r"(?i)([\"'][\w-]*(?:token|password|secret|key|authorization)[\w-]*[\"']\s*:\s*)([\"'])(.*?)\2",
                     r'\1"[REDACTED]"', command)
    command = re.sub(r'(?i)(bearer\s+|(?:--|\b)[\w-]*(?:token|password|passwd|secret|credential|api[-_]?key|authorization)[\w-]*[= :]+)(?:"[^"]*"|\x27[^\x27]*\x27|\S+)',
                     r'\1[REDACTED]', command)
    command = re.sub(r'(?i)(?<![a-z0-9])(?:sk-|ghp_|github_pat_|xox[baprs]-)[\w.-]+', '[REDACTED]', command)
    # Inspect whole tokens so @ in a Homebrew path cannot split off an opaque suffix.
    # Explicit credentials above still redact inside otherwise readable paths.
    command = re.sub(r'''[^\s"';&|()<>`{}]+''', redact_opaque_token, command)
    # Generic key flags, query-string values and short credential aliases too.
    command = re.sub(r'(?i)((?:--key|--auth|--pass|--pwd|\bkey|\bauth)[= :]+)(?:"[^"]*"|\x27[^\x27]*\x27|\S+)',
                     r'\1[REDACTED]', command)
    return command


def run(argv, timeout=15, allow_empty=False):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode and not (allow_empty and result.returncode == 1 and not result.stdout):
        raise RuntimeError(f"{os.path.basename(argv[0])}: exit {result.returncode}")
    return result.stdout


def parse_ps(raw):
    rows = {}
    for line in raw.splitlines():
        parts = line.split(None, 8)
        if len(parts) != 9 or not parts[0].isdigit():
            raise RuntimeError("ps: malformed process inventory")
        pid = int(parts[0])
        rows[pid] = {"pid": pid, "ppid": int(parts[1]), "start": " ".join(parts[2:7]),
                     "tty": parts[7], "args": parts[8]}
    return rows


def processes(pid=None):
    select = ["-p", str(pid)] if pid else ["-ax"]
    return parse_ps(run(["/bin/ps", *select, "-o", "pid=,ppid=,lstart=,tty=,args="]))


def parse_top(raw):
    memory = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0].isdigit():
            memory[int(parts[0])] = {"mem": parts[-2], "cmprs": parts[-1]}
    if not memory:
        raise RuntimeError("top: no process memory rows")
    return memory


def launch_services():
    labels = {}
    # The GUI domain alone misses system daemons; both service tables must be readable.
    for raw in (run(["/bin/launchctl", "list"]), run(["/bin/launchctl", "print", "system"])):
        for line in raw.splitlines():
            fields = line.split()
            if len(fields) == 3 and fields[0].isdigit():
                labels[int(fields[0])] = fields[2]
    return labels


def native_binding(pid):
    """Only allowlisted session identifiers leave KERN_PROCARGS2; never dump environments."""
    try:
        ids = environment_values(pid, THREAD_KEYS | set(NATIVE_KEYS))
    except (OSError, ValueError):
        return None
    return {key: value for key, value in ids.items()
            if re.fullmatch(r"[A-Za-z0-9:_/%.-]{1,600}", value)} or None


def environment_values(pid, keys):
    """An empty readable environment differs from an unavailable observation."""
    lib = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(1024 * 1024)
    buf = ctypes.create_string_buffer(size.value)
    if lib.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "process metadata unavailable")
    data = buf.raw[:size.value]
    if len(data) < 4:
        raise ValueError("process metadata incomplete")
    argc = struct.unpack("i", data[:4])[0]
    pos = data.find(b"\0", 4) + 1
    while pos < len(data) and data[pos] == 0:
        pos += 1
    ids = {}
    for item in data[pos:].split(b"\0")[argc:]:
        key, sep, value = item.partition(b"=")
        name = key.decode(errors="replace")
        if sep and name in keys:
            ids[name] = value.decode()
    return ids


def parent_chain(row, rows):
    chain, seen = [], {row["pid"]}
    parent = row["ppid"]
    while parent and parent not in seen:
        seen.add(parent)
        ancestor = rows.get(parent)
        if not ancestor:
            chain.append({"pid": parent, "missing": True})
            break
        chain.append(ancestor)
        parent = ancestor["ppid"]
    return chain


def family(row):
    try:
        program = os.path.basename(shlex.split(row["args"])[0]).lower()
    except (ValueError, IndexError):
        return None
    if program.startswith(("python", "next-server")):
        return program
    if program in {"node", "cua-driver", "claude", "codex", "opencode", "npx", "bun"}:
        return program
    if program == "agent-browser-darwin-arm64":
        return "agent-browser"
    return None


def keep_reason(row, chain, labels, keep):
    args = row["args"].lower()
    if row["tty"] not in {"??", "?", "-"}:
        return "tty"
    # A service's children can be per-thread MCPs, so only the process itself
    # inherits the registration exemption, not every descendant of Robob.
    if row["pid"] in labels:
        return "launchd_registered"
    if ".app/contents/" in args and "/python.app/" not in args:
        return "application"
    if re.search(r"cua-driver\s+serve\b|codex\s+app-server\b|opencode.*\bserve\b|robob|telegram|offbox.*(?:_bg-queue|queue.*worker)", args):
        return "shared_service"
    if any(k and (k == str(row["pid"]) or k in row["args"]) for k in keep):
        return "keep_file"
    return None


def probe(row):
    pid = str(row["pid"])
    cwd_raw = run(["/usr/sbin/lsof", "-b", "-w", "-a", "-p", pid, "-d", "cwd", "-Fn"])
    cwd = next((line[1:] for line in cwd_raw.splitlines() if line.startswith("n")), None)
    if not cwd:
        raise RuntimeError("cwd unavailable")
    sockets = run(["/usr/sbin/lsof", "-b", "-w", "-nP", "-a", "-p", pid, "-iTCP", "-FnT"], allow_empty=True)
    return {"cwd": cwd, "cwd_exists": os.path.exists(cwd),
            "listeners": sorted(line[1:] for line in sockets.splitlines() if line.startswith("n")),
            "tcp_states": sorted(line[4:] for line in sockets.splitlines() if line.startswith("TST=")),
            "binding": native_binding(row["pid"])}


def owner_call_summary(calls):
    summary = {}
    for kind in OWNER_ENDPOINTS:
        samples = calls.get(kind, [])
        durations = sorted(ms for ms, _ in samples)
        failures = {}
        for _, status in samples:
            if status is not None:
                failures[status] = failures.get(status, 0) + 1
        summary[kind] = {
            "count": len(samples),
            "p50_ms": round(durations[math.ceil(len(durations) * .50) - 1], 3) if durations else None,
            "p95_ms": round(durations[math.ceil(len(durations) * .95) - 1], 3) if durations else None,
            "max_ms": round(durations[-1], 3) if durations else None,
            "failures": failures,
        }
    return summary


def control(path, calls=None):
    kind = ("by_native" if path.startswith("/threads/by-native/") else
            "recovery" if path.startswith("/recovery/") else "detail")
    started, status, failed = time.perf_counter(), 0, True
    try:
        status, body = active_sessions._control_get(path, timeout=OWNER_CALL_TIMEOUT)
        if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
            raise RuntimeError(f"owner api: status {status}")
        failed = False
        return body
    finally:
        if calls is not None:
            calls.setdefault(kind, []).append(((time.perf_counter() - started) * 1000,
                                              str(status) if failed else None))


def owner(binding, calls=None):
    if not binding:
        return None
    tids = {value for key, value in binding.items() if key in THREAD_KEYS}
    views = []
    for key, driver in NATIVE_KEYS.items():
        if key in binding:
            body = control("/threads/by-native/" + urllib.parse.quote(binding[key], safe="") +
                           "?driver=" + driver + "&view=owner", calls=calls)
            thread = body.get("thread")
            if not isinstance(thread, dict) or not thread.get("threadId"):
                return None
            tids.add(thread["threadId"])
            views.append(thread)
    if len(tids) != 1:
        return None
    tid = tids.pop()
    # Resolve every binding before a keep marker, so conflicting ids stay unknown.
    if any(view.get("deleted") is True for view in views):
        return {"thread": {"threadId": tid}, "keep_reason": "owner_deleted"}
    if any(view.get("state") != "idle" or view.get("status") not in TERMINAL for view in views):
        return {"thread": {"threadId": tid}, "keep_reason": "owner_has_work_or_not_ended"}
    body = control("/threads/" + urllib.parse.quote(tid, safe=""), calls=calls)
    detail = body.get("thread")
    if not isinstance(detail, dict) or detail.get("threadId") != tid:
        return None
    # Recovery pages are ordered by thread id. The strict prefix cursor starts
    # before this exact owner; never infer the owner's absence from a page.
    recovery = control("/recovery/snapshot?" + urllib.parse.urlencode({
        "active": "false", "cursor": tid[:-1], "limit": 500}), calls=calls)
    entries = recovery.get("threads")
    if not isinstance(entries, list):
        return None
    entry = next((e for e in entries if e.get("threadId") == tid), None)
    if not entry:
        return None
    return {"thread": detail, "recovery": entry}


def owner_clear(value, roster):
    if not value:
        return False
    thread, recovery = value["thread"], value["recovery"]
    tid = thread["threadId"]
    if thread.get("state") != "idle" or thread.get("status") not in TERMINAL:
        return False
    if not (thread.get("settled") is True or thread.get("archived") is True):
        return False
    if thread.get("activeRunId", "unknown") is not None or thread.get("pendingRequests") != []:
        return False
    if recovery.get("pendingRequests") != [] or recovery.get("runtime") not in {"present", "absent"}:
        return False
    if recovery["runtime"] == "present" and recovery.get("heldWork") is not False:
        return False
    run_info = recovery.get("run")
    if run_info is not None and run_info.get("status") not in TERMINAL:
        return False
    children = recovery.get("children")
    if not isinstance(children, list) or any(c.get("status") not in TERMINAL for c in children):
        return False
    descendants = {tid}
    while True:
        added = {t["threadId"] for t in roster["threads"].values() if t.get("parentThreadId") in descendants}
        if added <= descendants:
            break
        descendants |= added
    for t in roster["threads"].values():
        if (t["threadId"] in descendants or t.get("rootThreadId") == tid) and active_sessions.in_use(t):
            return False
    if any(v in roster["opencode"] for v in (thread.get("nativeSessionId"),)):
        return False
    return True


def temporary(args):
    try:
        argv = shlex.split(args)
        program = os.path.basename(argv[0]).lower()
        if program.startswith('python'):
            index = 1
            while index < len(argv):
                option = argv[index]
                if option == '-m':
                    module = argv[index + 1]
                    return module == 'http.server' or module.rsplit('.', 1)[-1] in {'serve', 'server'}
                if option in {'-c', '--'} or not option.startswith('-'):
                    return False
                if option in {'-W', '-X'}:
                    index += 2
                elif option in {'-B', '-E', '-I', '-O', '-OO', '-s', '-S', '-u', '-v', '-q'} or option.startswith(('-W', '-X')):
                    index += 1
                else:
                    return False
            return False
        if program == 'npx':
            return len(argv) > 1 and argv[1] == 'serve'
        if program in {'node', 'bun'}:
            script = os.path.basename(argv[1])
            return script == 'vite' or (script == 'next' and len(argv) > 2 and argv[2] == 'dev')
        return False
    except (ValueError, IndexError):
        return False


def mcp(args):
    low = args.lower()
    return ("cua-driver" in low and re.search(r"\bmcp\b", low) is not None) or any(
        marker in low for marker in ("dia-mcp", "dia-agent-bridge", "perplexity-mcp", "@perplexity-ai/mcp-server", "perplexity/server"))


def expired(thread, now):
    try:
        updated = datetime.datetime.fromisoformat(thread["updatedAt"].replace("Z", "+00:00")).timestamp()
        return now - updated >= IDLE_GRACE
    except (KeyError, ValueError, TypeError):
        return False


def cwd_inventory(rows):
    raw = run(["/usr/sbin/lsof", "-b", "-w", "-a", "-p", ",".join(str(pid) for pid in rows),
               "-d", "cwd", "-Fpn"], timeout=15)
    hints, pid = {}, None
    for line in raw.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            hints[pid] = line[1:]
    return hints


def ordered_processes(rows, cursor, hints):
    urgent, remaining = [], []
    for row in sorted(rows.values(), key=lambda value: value["pid"]):
        if not family(row):
            continue
        cwd = hints.get(row["pid"])
        in_temp = cwd and any(cwd == root or cwd.startswith(root + '/') for root in
                              {'/tmp', '/private/tmp', '/var/folders', '/private/var/folders'})
        likely = temporary(row['args']) or row['ppid'] == 1 or in_temp or (cwd and not os.path.exists(cwd))
        (urgent if likely else remaining).append(row)
    ordered = urgent + remaining
    ranks = {row['pid']: 0 for row in urgent} | {row['pid']: 1 for row in remaining}
    if isinstance(cursor, dict):
        after = (cursor['priority'], cursor['pid'])
    else:
        after = (1, cursor) if cursor else (-1, 0)
    # Resume the whole priority-ordered cycle. Resetting the urgent prefix on
    # every run can consume every budget before the same later entries are seen.
    return ([row for row in ordered if (ranks[row['pid']], row['pid']) > after] +
            [row for row in ordered if (ranks[row['pid']], row['pid']) <= after]), ranks


def detect(rows, memory, labels, roster, keep=(), inspect=probe, resolve=owner,
           refresh=processes, refresh_roster=active_sessions.checked_snapshot, now=None, deadline=None, cursor=0, cwd_hints=None):
    report = {"report_only": True, "inventory": [], "candidates": [], "problems": [],
              "checked": 0, "skipped": 0, "budget_skipped": 0, "next_cursor": cursor}
    calls = {}
    if resolve is owner:
        resolve = lambda binding: owner(binding, calls=calls)
    if not roster["complete"]:
        report["problems"] = ["liveness_unavailable: " + "; ".join(roster["problems"])]
    now = time.time() if now is None else now
    resolved = {}
    ordered, ranks = ordered_processes(rows, cursor, cwd_hints or {})
    for row in ordered:
        program = family(row)
        if not program:
            continue
        chain = parent_chain(row, rows)
        item = {key: row[key] for key in ("pid", "ppid", "start", "tty")}
        item.update(program=program, command=redact(row["args"]), memory=memory.get(row["pid"]),
                    launch_label=labels.get(row["pid"]), owner=None,
                    parent_chain=[{**{k: p[k] for k in ("pid", "ppid", "start") if k in p},
                                   "command": redact(p.get("args", "")), "missing": p.get("missing", False),
                                   "launch_label": labels.get(p["pid"])} for p in chain])
        report["inventory"].append(item)
        reason = keep_reason(row, chain, labels, keep)
        if not reason and not roster["complete"]:
            reason = "liveness_unavailable"
        if not reason and deadline is not None and time.monotonic() >= deadline:
            reason = "observation_budget_exhausted"
            report["budget_skipped"] += 1
        if not reason and not (temporary(row["args"]) or mcp(row["args"])):
            reason = "unproven_process"
        try:
            if not reason:
                report["checked"] += 1
                report["next_cursor"] = {"priority": ranks[row["pid"]], "pid": row["pid"]}
                # Unbound stdio children need no per-PID lsof/API probes.
                if inspect is probe and mcp(row["args"]) and not native_binding(row["pid"]):
                    item.update(candidate=False, keep_reason="unknown_owner")
                    continue
                details = inspect(row)
                item.update(cwd=details["cwd"], cwd_exists=details["cwd_exists"], listeners=details["listeners"])
                binding_key = tuple(sorted((details["binding"] or {}).items()))
                if binding_key not in resolved:
                    resolved[binding_key] = resolve(details["binding"])
                own = resolved[binding_key]
                item["owner"] = own["thread"]["threadId"] if own else None
                if not own:
                    reason = "unknown_owner"
                elif own.get("keep_reason"):
                    reason = own["keep_reason"]
                elif not owner_clear(own, roster):
                    reason = "owner_has_work_or_not_ended"
                elif any(k == details["cwd"] for k in keep):
                    reason = "keep_file"
                elif any(state != "LISTEN" for state in details["tcp_states"]):
                    reason = "connected_client"
                elif mcp(row["args"]) and not expired(own["thread"], now):
                    reason = "idle_grace"
                elif not item["memory"]:
                    reason = "memory_unavailable"
                elif any(p.get("missing") for p in chain):
                    reason = "parent_chain_incomplete"
                else:
                    # Both positive owner proof and a full fresh roster are
                    # required; a settled label alone cannot exclude held work.
                    fresh = refresh_roster()
                    if not fresh["complete"]:
                        report["problems"].append("liveness_unavailable: " + "; ".join(fresh["problems"]))
                        reason = "liveness_unavailable"
                    else:
                        current = refresh(row["pid"]).get(row["pid"])
                        again = inspect(current) if current == row else None
                        current_owner = resolve(again["binding"]) if again else None
                        if again != details or current_owner != own or not owner_clear(current_owner, fresh):
                            reason = "changed_before_report"
                        else:
                            item["evidence"] = ["exact_terminal_settled_owner", "no_held_queued_or_delegated_work",
                                                "identity_cwd_listeners_owner_rechecked",
                                                "temporary_server_command" if temporary(row["args"]) else "bound_stdio_mcp_idle_2h"]
                            if not details["cwd_exists"]:
                                item["evidence"].append("deleted_cwd")
                            item["candidate"] = True
                            report["candidates"].append(dict(item))
        except Exception as exc:
            reason = "observation_unavailable: " + type(exc).__name__ + ": " + redact(str(exc))
        if reason:
            item.update(candidate=False, keep_reason=reason)
    if report["problems"]:
        report["candidates"] = []
        for item in report["inventory"]:
            if item.get("candidate"):
                item.update(candidate=False, keep_reason="liveness_unavailable")
    report["skipped"] = len(report["inventory"]) - report["checked"]
    report["owner_calls"] = owner_call_summary(calls)
    return report


def browser_metadata(pid):
    values = environment_values(pid, {"AGENT_BROWSER_SESSION", "AGENT_BROWSER_NAMESPACE",
                                      "AGENT_BROWSER_SOCKET_DIR"})
    session = values.get("AGENT_BROWSER_SESSION")
    if not session or session in {".", ".."} or not re.fullmatch(r"[\w.-]{1,128}", session):
        raise ValueError("session unavailable")
    # lsof binds the session to this daemon, including custom socket directories
    # and namespaces; guessing a path can close a different session.
    raw = run(["/usr/sbin/lsof", "-b", "-w", "-nP", "-a", "-p", str(pid), "-U", "-Fn"])
    paths = {line[1:] for line in raw.splitlines() if line.startswith("n/") and line.endswith(".sock")}
    matches = [Path(path) for path in paths if Path(path).name == session + ".sock"]
    if len(matches) != 1:
        raise ValueError("session socket ambiguous or unavailable")
    sock = matches[0]
    if sock.with_suffix(".pid").read_text().strip() != str(pid):
        raise ValueError("session pid sidecar mismatch")
    return {"session": session, "socket": str(sock), "namespace": values.get("AGENT_BROWSER_NAMESPACE"),
            "socket_dir": values.get("AGENT_BROWSER_SOCKET_DIR"), "binding": native_binding(pid)}


def cpu_processes():
    raw = run(["/bin/ps", "-ax", "-o", "pid=,ppid=,lstart=,tty=,time=,rss=,args="])
    result = {}
    for line in raw.splitlines():
        fields = line.split(None, 10)
        if len(fields) != 11:
            raise ValueError("CPU observation incomplete")
        times = fields[8].split(":")
        if len(times) not in {2, 3}:
            raise ValueError("CPU time unavailable")
        seconds = sum(float(value) * 60 ** i for i, value in enumerate(reversed(times)))
        row = parse_ps(" ".join(fields[:8] + [fields[10]]))[int(fields[0])]
        result[row["pid"]] = {**row, "cpu_seconds": seconds, "rss_kib": int(fields[9])}
    if not result:
        raise ValueError("CPU observation empty")
    return result


def descendants(pid, rows):
    found = {pid}
    while True:
        more = {p for p, row in rows.items() if row["ppid"] in found}
        if more <= found:
            return found - {pid}
        found |= more


def detect_agent_browsers(rows, before, after, roster, labels, keep=(), *, metadata=browser_metadata,
                          resolve=owner, now=None, window_s=0, deadline=None):
    report = {"inventory": [], "candidates": [], "problems": [], "actions": [],
              "reap_enabled": os.environ.get("DEV_JANITOR_REAP_AGENT_BROWSER") == "1"}
    now = time.time() if now is None else now
    calls, owners = {}, {}
    if resolve is owner:
        resolve = lambda binding: owner(binding, calls=calls)
    for row in rows.values():
        if family(row) != "agent-browser":
            continue
        item = {**row, "args": redact(row["args"]), "session": None, "socket": None,
                "owner_state": "unknown", "owner": None, "children": [], "candidate": False}
        report["inventory"].append(item)
        try:
            item["age_s"] = now - time.mktime(time.strptime(row["start"], "%a %b %d %H:%M:%S %Y"))
            details = metadata(row["pid"])
            item.update(session=details["session"], socket=details["socket"], namespace=details.get("namespace"),
                        socket_dir=details.get("socket_dir"), binding=details["binding"])
            reason = keep_reason(row, parent_chain(row, rows), labels, keep)
            if any(value in keep for value in (details["session"], details["socket"], str(Path(details["socket"]).parent))):
                reason = reason or "keep_file"
            if deadline is not None and time.monotonic() >= deadline:
                reason = reason or "observation_budget_exhausted"
            if not reason and (row["ppid"] != 1 or item["age_s"] < IDLE_GRACE):
                reason = "not_orphaned_or_young"
            if not reason and (not roster["complete"] or window_s < 1):
                reason = "observation_incomplete"
            tree = descendants(row["pid"], before)
            if not reason and tree != descendants(row["pid"], after):
                reason = "child_tree_changed"
            for pid in tree | {row["pid"]}:
                first, last = before.get(pid), after.get(pid)
                identity = lambda value: {k: value.get(k) for k in ("pid", "ppid", "start", "args", "tty")} if value else None
                if (not first or not last or identity(first) != identity(last)
                        or (pid == row["pid"] and identity(first) != identity(row))):
                    reason = reason or "process_identity_changed"
                    continue
                delta = last["cpu_seconds"] - first["cpu_seconds"]
                if delta < 0:
                    reason = reason or "observation_incomplete"
                if pid != row["pid"]:
                    item["children"].append({"pid": pid, "ppid": first["ppid"], "start": first["start"], "tty": first["tty"],
                                             "command": redact(first["args"]), "cpu_delta_s": delta,
                                             "cpu_seconds": last["cpu_seconds"],
                                             "rss_kib": last["rss_kib"]})
                    if delta > 0:
                        reason = reason or "child_busy"
            if not reason:
                binding = details["binding"]
                if not binding:
                    # Readable-but-unbound is still unknown ownership. In particular,
                    # OpenCode cloud-browser sessions do not inherit native ids.
                    reason = "unknown_owner"
                else:
                    key = tuple(sorted(binding.items()))
                    if key not in owners:
                        owners[key] = resolve(binding)
                    own = owners[key]
                    if own:
                        item["owner"] = own["thread"]["threadId"]
                    if own and own.get("keep_reason") == "owner_has_work_or_not_ended":
                        item["owner_state"] = "live-owner"
                    elif (own and not own.get("keep_reason")
                          and own["thread"].get("state") is not None and own["thread"].get("status") is not None
                          and (own["thread"]["state"] != "idle" or own["thread"]["status"] not in TERMINAL)):
                        item["owner_state"] = "live-owner"
                    if own and not own.get("keep_reason") and owner_clear(own, roster) and expired(own["thread"], now):
                        item["owner_state"] = "ended-owner"
                    else:
                        reason = "unknown_owner" if not own else own.get("keep_reason", "owner_not_clear_or_recent")
            if reason:
                item["keep_reason"] = reason
            else:
                item["candidate"] = True
                report["candidates"].append(dict(item))
        except Exception as exc:
            item["keep_reason"] = "observation_unavailable: " + type(exc).__name__
    report["owner_calls"] = owner_call_summary(calls)
    return report


def scan_agent_browsers(roster, keep=()):
    try:
        rows = processes()
        if not any(family(row) == "agent-browser" for row in rows.values()):
            return detect_agent_browsers(rows, {}, {}, roster, {}, keep)
        labels = launch_services()
        before = cpu_processes()
        started = time.monotonic()
        # Two top samples provide a bounded observation window without a polling
        # loop. CPU progress is measured with cumulative ps times on either side.
        run(["/usr/bin/top", "-l", "2", "-s", "1", "-stats", "pid,cpu"], timeout=15)
        after = cpu_processes()
        return detect_agent_browsers(rows, before, after, roster, labels, keep,
                                     window_s=time.monotonic() - started, deadline=started + OBSERVATION_BUDGET)
    except Exception as exc:
        return {"inventory": [], "candidates": [], "actions": [],
                "reap_enabled": os.environ.get("DEV_JANITOR_REAP_AGENT_BROWSER") == "1",
                "problems": ["browser_observation_unavailable: " + type(exc).__name__]}


def browser_tree_matches(item, rows):
    current = rows.get(item["pid"])
    if not current or any(current.get(k) != item.get(k) for k in ("pid", "ppid", "start", "args", "tty")):
        return False
    if descendants(item["pid"], rows) != {child["pid"] for child in item["children"]}:
        return False
    return all(all(rows[child["pid"]].get(k) == child[k] for k in ("ppid", "start", "tty", "cpu_seconds"))
               and redact(rows[child["pid"]]["args"]) == child["command"] for child in item["children"])


def revalidate_agent_browser(item, *, metadata=browser_metadata, resolve=owner,
                             snapshot=active_sessions.checked_snapshot, observe=cpu_processes, now=None):
    details = metadata(item["pid"])
    if any(details.get(k) != item.get(k) for k in ("session", "socket", "namespace", "socket_dir", "binding")):
        return False
    roster = snapshot()
    # Provider and workspace reads can outlast the roster's active-thread read.
    # Resolve this exact owner after all of them, before the final tree checks.
    own = resolve(details["binding"]) if details["binding"] else None
    return bool(roster["complete"] and own and not own.get("keep_reason")
                and own["thread"]["threadId"] == item["owner"] and owner_clear(own, roster)
                and expired(own["thread"], time.time() if now is None else now)
                and browser_tree_matches(item, observe()))


def close_agent_browser(item):
    # agent-browser 0.38.2 connection.rs uses newline-delimited JSON. Sending
    # close on this existing socket avoids the CLI's ensure_daemon/respawn path
    # and its HOME/XDG/namespace routing, while retaining graceful state cleanup.
    meta = browser_metadata(item["pid"])
    if any(meta.get(key) != item.get(key) for key in ("session", "socket", "namespace", "socket_dir")):
        raise ValueError("session identity changed")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(30)
        stream.connect(item["socket"])
        if sys.platform == "darwin":
            # sys/un.h: SOL_LOCAL=0, LOCAL_PEERPID=2. The kernel binds the
            # connection to the PID; a replaced socket must never receive close.
            peer = struct.unpack("i", stream.getsockopt(0, 2, struct.calcsize("i")))[0]
        else:
            peer = struct.unpack("3i", stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                                        struct.calcsize("3i")))[0]
        if peer != item["pid"] or not browser_tree_matches(item, cpu_processes()):
            raise ValueError("daemon or child tree changed")
        stream.sendall(json.dumps({"id": "janitor-" + str(time.time_ns()), "action": "close"}).encode() + b"\n")
        with stream.makefile("rb") as reply:
            response = reply.readline(65537)
        if len(response) > 65536 or json.loads(response).get("success") is not True:
            raise RuntimeError("session close failed")


def reap_agent_browsers(report, *, rescan=None, close=close_agent_browser, refresh=processes, validate=None):
    if os.environ.get("DEV_JANITOR_REAP_AGENT_BROWSER") != "1":
        return []
    if rescan is None:
        rescan = lambda: scan_agent_browsers(active_sessions.checked_snapshot())
    if validate is None:
        validate = revalidate_agent_browser
    actions = []
    for original in report.get("candidates", []):
        entry = {"pid": original["pid"], "session": original["session"], "ok": False, "action": "kept"}
        try:
            fresh = rescan()
            def identity(item):
                return ({key: item.get(key) for key in ("pid", "ppid", "start", "args", "tty", "session", "socket", "namespace", "socket_dir", "owner", "binding")},
                        sorted((child["pid"], child["start"]) for child in item["children"]))
            candidate = next((item for item in fresh["candidates"] if identity(item) == identity(original)), None)
            if fresh.get("problems") or not candidate:
                entry["reason"] = "changed_before_close"
            else:
                if not validate(candidate):
                    entry["reason"] = "owner_or_child_tree_changed"
                else:
                    entry["action"] = "close"
                    close(candidate)
                    remaining = refresh()
                    identities = [(candidate["pid"], candidate["start"])] + [(c["pid"], c["start"]) for c in candidate["children"]]
                    entry.update(action="close", ok=not any(remaining.get(pid, {}).get("start") == start for pid, start in identities))
                    if not entry["ok"]:
                        entry["reason"] = "close_incomplete"
        except Exception as exc:
            entry["reason"] = type(exc).__name__
        actions.append(entry)
    return actions


def report_summary(report):
    result = {key: report[key] for key in ("candidates", "problems", "checked", "skipped", "budget_skipped", "owner_calls")}
    if "agent_browser" in report:
        result["agent_browser"] = report["agent_browser"]
    return result


def scan(roster, keep=(), cursor=0):
    try:
        rows = processes()
        labels = launch_services()
        memory = parse_top(run(["/usr/bin/top", "-l", "1", "-stats", "pid,command,mem,cmprs"], timeout=30))
        try:
            hints = cwd_inventory(rows)
        except Exception:
            hints = {}
        report = detect(rows, memory, labels, roster, keep, deadline=time.monotonic() + OBSERVATION_BUDGET,
                        cursor=cursor, cwd_hints=hints)
        report["agent_browser"] = scan_agent_browsers(roster, keep)
        return report
    except Exception as exc:
        return {"report_only": True, "inventory": [], "candidates": [],
                "problems": ["process_inventory_unavailable: " + type(exc).__name__],
                "checked": 0, "skipped": 0, "budget_skipped": 0, "next_cursor": cursor,
                "owner_calls": owner_call_summary({})}
