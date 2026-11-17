"""Read-only process evidence. Unknown ownership or incomplete observations always keep."""
import ctypes
import datetime
import math
import os
import re
import shlex
import struct
import subprocess
import time
import urllib.parse

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
    lib = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(1024 * 1024)
    buf = ctypes.create_string_buffer(size.value)
    if lib.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return None
    data = buf.raw[:size.value]
    argc = struct.unpack("i", data[:4])[0]
    pos = data.find(b"\0", 4) + 1
    while pos < len(data) and data[pos] == 0:
        pos += 1
    ids = {}
    for item in data[pos:].split(b"\0")[argc:]:
        key, sep, value = item.partition(b"=")
        name = key.decode(errors="replace")
        if sep and name in THREAD_KEYS | set(NATIVE_KEYS) and re.fullmatch(rb"[A-Za-z0-9:_/%.-]{1,600}", value):
            ids[name] = value.decode()
    return ids or None


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


def scan(roster, keep=(), cursor=0):
    try:
        rows = processes()
        labels = launch_services()
        memory = parse_top(run(["/usr/bin/top", "-l", "1", "-stats", "pid,command,mem,cmprs"], timeout=30))
        try:
            hints = cwd_inventory(rows)
        except Exception:
            hints = {}
        return detect(rows, memory, labels, roster, keep, deadline=time.monotonic() + OBSERVATION_BUDGET,
                      cursor=cursor, cwd_hints=hints)
    except Exception as exc:
        return {"report_only": True, "inventory": [], "candidates": [],
                "problems": ["process_inventory_unavailable: " + type(exc).__name__],
                "checked": 0, "skipped": 0, "budget_skipped": 0, "next_cursor": cursor,
                "owner_calls": owner_call_summary({})}
