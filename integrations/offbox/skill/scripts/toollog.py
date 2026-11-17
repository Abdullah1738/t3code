"""Best-effort, metadata-only tool logs. Never pass command text or exception bodies here."""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import functools
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

CAP_BYTES = 50 * 1024 * 1024
NUMBERS = set("bytes files skipped exitCode waitMs queueMs runMs position ttlSeconds reasonLength busy idle stopped count flagsCount envCount pullCount includeCount stepCount attempt pid timeoutSeconds commandLength cmd_bytes step_count".split())
NUMBERS.update("ms slow_ms last_good_boatd_uptime_s snapshot_age_s boatd_uptime_s uptime_s slow slow_max_s slow_total_s starting starting_max_s down".split())
NUMBERS.update({'command_exit_code', 'wrapper_exit_code', 'disk_attempt', 'client_started_at', 'disk_probe_module_mtime'})
NUMBERS.update({"since", "expires_at"})
NUMBERS.add("waited_s")
NUMBERS.add("sample")
NUMBERS.update({'leftoverKilled', 'boxRc', 'incusRc', 'cgroupProcessCount'})
NUMBERS.update({'outageS', 'waitedMs', 'placeBefore', 'placeAfter'})
NUMBERS.update({'ageSeconds', 'runCount', 'waitSeconds', 'serving', 'held', 'pending', 'cap'})
NUMBERS.update({'deficit', 'members_before'})
NUMBERS.update({'created_at', 'since', 'total', 'headNeedBytes', 'freeBytes', 'running'})
NUMBERS.update({'mem_available', 'shmem', 'committed_bytes', 'committed_as', 'admitted_bytes', 'reserve', 'free_bytes', 'need_bytes'})
NUMBERS.update({'payload_current', 'payload_high', 'payload_max', 'payload_free', 'payload_reclaimable'})
NUMBERS.update(f'{fs}_{field}' for fs in ('tmp', 'var_tmp', 'home', 'workspace')
               for field in ('free_bytes', 'size_bytes'))
BOOLEANS = {"peer_online"} | set("queued killed fresh bg noSync git noFallback noRetry remote failed stale timeoutHit fallback dryRun baseGiven templateGiven sizeGiven".split())
BOOLEANS.add("ok")
BOOLEANS.update({'fifo', 'room', 'cpu_room'})
BOOLEANS.update({'retry', 'rcFilePresent', 'superseded'})
BOOLEANS.update({'deadlineKept', 'expired'})
BOOLEANS.add('queueExpired')
ENUMS = {
    'signalName': {'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGALRM', 'SIGPIPE', 'SIGQUIT'},
    "jdk_phase": {"check", "install", "result"},
    "jdk_result": {"pending", "present", "installed", "compiler-missing", "apt-failed"},
    "jdk_trigger": {"command", "repo-marker", "harness"},
    "class": {"good", "hard", "slow", "starting"},
    "outcome": {"boat_box", "good", "bad", "indeterminate", "slow", "starting", "ready", "failover"},
    "peer_path": {"direct", "relay", "unknown"},
    "refresh_stage": {"idle", "zpool", "incus", "mullvad", "sqlite"},
    "checkpoint": {"probe", "person", "post", "auto-stop", "request", "box-read"},
    "cmd_via": {"argv", "file"},
    "backend": {"home", "boat"}, "from": {"home", "boat"}, "to": {"home", "boat"},
    "reason": {"pinned", "home_up", "home_down", "unreachable", "boat_only", "boat_only_base", "infra", "cap", "busy", "person_home_down", "base_home_down"},
    "stream": {"stderr", "stdout"},
    "leaseKind": {"fresh", "reused", "saved-base"},
    "decision": {"allowed", "denied", "local-override", "boat", "wait_explicit_base", "wait_person", "wait_pinned"},
    "harness": {"opencode", "codex", "claudeAgent", "codex-cu"},
    "commandClass": {"cargo", "evm", "go-build", "go-test", "gradle", "js-test", "lint", "make-test", "pytest", "typecheck", "light", "heavy", "unknown", "test", "install", "build", "docker", "opaque", "cpu"},
    "action": {"stop", "delete", "forget", "settle", "keep", "other"},
    "linkType": {"wireguard", "residential", "down", "unknown"},
    "stage": {"ssh_setup", "ssh_drop", "readiness", "put_file", "sync", "pull", "command", "install_mid_run", "request", "reaper"},
    "infra_failure": {"enospc", "native_crash", "disk_probe"},
    "infra_reason": {"low_space_gate", "disk_exhausted", "toolchain_unpack_crash", "setup_native_crash", "go_inventory_crash", "native_crash_after_start", "probe_crashed"},
    "stateBefore": {"running", "stopped"},
    "result": {"detached", "stop_failed", "created"},
}
ENUMS['reason'].update({'killed', 'kill_file', 'unit_inactive', 'unit_failed', 'unit_unknown',
                        'memory', 'fifo', 'cpu', 'cpu_config', 'cpu_unknown', 'cpu_settle', 'admitted_alone'})
ENUMS['decision'].update({'admit', 'queue'})
ENUMS['reason'].add('cleanup_unavailable')
ENUMS['reason'].update({'history_empty', 'history_timeout', 'history_no_progress', 'history_unavailable'})
ENUMS.update({f'{fs}_fstype': {'tmpfs', 'zfs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'overlay', 'unknown'}
              for fs in ('tmp', 'var_tmp', 'home', 'workspace')})
ENUMS.update(cause={'incus_unavailable', 'exec_stream_lost', 'host_restart', 'boatd_restart', 'runner_restart'},
             phase={'before_spawn', 'running'}, cleanup={'clean', 'stopped', 'unknown'})
ENUMS['reason'].update({'incus_unavailable', 'state_unavailable', 'box_unreadable', 'invalid_receipt',
                        'cgroup_unverified', 'cgroup_kill_failed', 'cleanup_unconfirmed'})
_DAYS = set()


def directory():
    return Path(os.environ.get("OFFBOX_TOOL_LOG_DIR", str(Path.home() / ".robob/logs/tools/offbox")))


def repo_id(value):
    # A repo can be named after a customer or contain credentials in its URL.
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]


def _atom(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,79}", value))


def _ids(values):
    return {k: v for k, v in (values or {}).items()
            if k in {"run", "newRun", "box", "newBox", "thread", "card", "chat", "order", "owner"} and isinstance(v, str)
            and len(v) <= 200 and re.fullmatch(r"[A-Za-z0-9_:%.\-/]+", v)
            and not re.search(r"\d{13,}", v)}


def _props(values, *, name=None):
    out = {}
    for k, v in (values or {}).items():
        if name in {"box_suspect_set", "box_suspect_cleared", "box_skipped_suspect", "run_moved_off_suspect"}:
            if k == 'reason' and isinstance(v, str):
                out[k] = v if v in {'native_crash', 'toolchain_unpack_crash', 'setup_native_crash',
                                   'go_inventory_crash', 'native_crash_after_start'} else 'other'
                out['reasonLength'] = len(v)
                continue
            if k in {'source', 'trigger', 'kind'}:
                allowed = {'source': {'auto', 'manual'}, 'kind': {'suspect'},
                           'trigger': {'exit90', 'setup_crash', 'after_start', 'manual'}}
                if isinstance(v, str) and v in allowed[k]:
                    out[k] = v
                continue
            if k == 'expires_at' and v is None:
                out[k] = None
                continue
        if k == "reason" and name == "backend.failback" and isinstance(v, str):
            out[k] = v[:200]
        elif k in {'leftoverKilled', 'boxRc', 'cgroupProcessCount', 'placeBefore', 'placeAfter'} and v is None:
            out[k] = None
        elif k == 'stderrTail' and isinstance(v, str):
            # Only Incus' fixed transport diagnostics belong here, never arbitrary command output.
            markers = ('Lost connection to the event listener', 'websocket: close 1006',
                       'unexpected EOF', 'Incus is shutting down')
            out[k] = '; '.join(s for s in markers if s in v)
        elif k in NUMBERS and type(v) in (int, float) and math.isfinite(v):
            out[k] = v
        elif k in BOOLEANS and type(v) is bool:
            out[k] = v
        elif k in ENUMS and isinstance(v, str) and v in ENUMS[k]:
            out[k] = v
        elif k in ("boot_id", "last_good_boot_id") and isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9-]{1,64}", v):
            out[k] = v
        elif k == 'head' and isinstance(v, str) and re.fullmatch(r'bx_[A-Za-z0-9]+/[0-9]+', v):
            out[k] = v
        elif k == "day" and isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            out[k] = v
        elif k == "repo" and isinstance(v, str) and re.fullmatch(r"[a-f0-9]{16}", v):
            out[k] = v
        elif k == "size" and v in ("small", "default", "large", "xlarge"):
            out[k] = v
        elif k == "errorClass" and isinstance(v, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]{0,79}', v):
            out[k] = v
        elif k == 'base' and (v is None or isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', v)):
            out[k] = v
        elif k in ('source', 'fromSource') and isinstance(v, str) and re.fullmatch(r'(?:template|recipe|base):[A-Za-z0-9_.:-]{1,200}|fresh', v):
            out[k] = v
        elif k == "exitRelay" and isinstance(v, str) and re.fullmatch(r"[a-z]{2}-[a-z]{3}-wg-\d{3}", v):
            out[k] = v
    return out


def _append(path, record):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n").encode())
    finally:
        os.close(fd)


def emit(component, name, *, kind="event", duration_ms=None, ok=None, ids=None, props=None, tag=None):
    try:
        if not _atom(component) or not _atom(name) or kind not in ("event", "perf", "error"):
            return
        now = datetime.now(timezone.utc)
        day = now.strftime("%Y-%m-%d")
        root = directory()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        root.chmod(0o700)
        key = (str(root), day)
        if key not in _DAYS:
            cutoff = (now - timedelta(days=30)).strftime("%Y-%m-%d")
            for path in root.iterdir():
                match = re.fullmatch(r"(?:rollup-)?(\d{4}-\d{2}-\d{2})\.(?:ndjson|json|cap)", path.name)
                if match and match[1] < cutoff:
                    path.unlink(missing_ok=True)
            _DAYS.add(key)
        line = {"ts": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "tool": "offbox", "component": component, "kind": kind, "name": name}
        if type(duration_ms) in (int, float) and math.isfinite(duration_ms):
            line["durationMs"] = round(max(0, duration_ms), 3)
        if type(ok) is bool:
            line["ok"] = ok
        if clean := _ids(ids):
            line["ids"] = clean
        if clean := _props(props, name=name):
            line["props"] = clean
        if _atom(tag):
            # Messages are stable labels, never str(exception), stderr, or API response text.
            line["error"] = {"tag": tag, "message": tag.replace("_", " ")[:300]}
        path = root / (day + ".ndjson")
        if path.exists() and path.stat().st_size >= CAP_BYTES:
            try:
                fd = os.open(root / (day + ".cap"), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
                _append(path, dict(line, kind="error", name="log.cap", error={"tag": "log_cap", "message": "daily log cap"}))
            if kind != "error":
                return
        _append(path, line)
    except Exception:
        pass


@contextmanager
def span(component, name, *, ids=None, props=None, tag=None, timeout_tag=None):
    start = time.monotonic()
    data = {"ids": ids, "props": dict(props or {}), "ok": True}
    try:
        yield data
    except BaseException as error:
        data["ok"] = False
        if isinstance(error, TimeoutError) or type(error).__name__ == "TimeoutExpired":
            data["props"]["timeoutHit"] = True
            tag = timeout_tag or tag
        if name == "run.pull":
            data["props"].update(failed=True, stale=True)
        raise
    finally:
        emit(component, name, kind="perf" if data["ok"] else "error", duration_ms=(time.monotonic()-start)*1000,
             **data, tag=(tag or "operation_failed") if not data["ok"] else None)


def observed(component, name, tag, *, timeout_tag=None):
    def decorate(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            with span(component, name, tag=tag, timeout_tag=timeout_tag) as data:
                result = fn(*args, **kwargs)
                if isinstance(result, dict) and "ok" in result:
                    data["ok"] = bool(result["ok"])
                return result
        return wrapped
    return decorate


def rollup(day=None):
    """Explicit rollups may fail; callers can report the failure without affecting their work."""
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    datetime.strptime(day, "%Y-%m-%d")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("expected YYYY-MM-DD")
    root = directory()
    counts, kinds, errors, samples, durations = Counter(), Counter(), Counter(), {}, {}
    total = ok = checked = bad = malformed = 0
    sampled = False
    path = root / (day + ".ndjson")
    if path.exists():
        with path.open() as source:
            for raw in source:
                try:
                    row = json.loads(raw)
                    if not isinstance(row, dict) or row.get("tool") != "offbox" or not _atom(row.get("name")) or row.get("kind") not in ("event", "perf", "error"):
                        raise ValueError()
                    name, kind = row["name"], row["kind"]
                    weight = (row.get("props") or {}).get("sample", 1)
                    if type(weight) is not int or weight < 1:
                        weight = 1
                    sampled |= weight > 1
                    total += weight
                    counts[name] += weight
                    kinds[kind] += weight
                    if type(row.get("ok")) is bool:
                        checked += weight
                        ok += weight * row["ok"]
                    bad += weight * (kind == "error" or row.get("ok") is False)
                    ms = row.get("durationMs")
                    if type(ms) in (int, float) and math.isfinite(ms) and ms >= 0:
                        durations.setdefault(name, []).append(ms)
                    tag = (row.get("error") or {}).get("tag")
                    if _atom(tag):
                        errors[tag] += weight
                        samples.setdefault(tag, _ids(row.get("ids")))
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
    def stats(xs):
        xs.sort()
        return {"p50": xs[max(0, math.ceil(len(xs)*.50)-1)], "p95": xs[math.ceil(len(xs)*.95)-1], "max": xs[-1]}
    result = {"day": day, "total": total, "sampled": sampled, "countsByName": dict(counts), "countsByKind": dict(kinds),
              "okRate": ok/checked if checked else None, "errorRate": bad/total if total else None,
              "durationMs": {name: stats(xs) for name, xs in durations.items()}, "malformedLines": malformed,
              "topErrors": [{"tag": tag, "count": count, "sampleIds": samples[tag]} for tag, count in errors.most_common(20)]}
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    fd, tmp = tempfile.mkstemp(prefix=".rollup-", dir=root)
    try:
        with os.fdopen(fd, "w") as target:
            json.dump(result, target, separators=(",", ":"))
            target.write("\n")
        dest = root / ("rollup-" + day + ".json")
        os.replace(tmp, dest)
        return result
    finally:
        Path(tmp).unlink(missing_ok=True)


def rollup_previous():
    try:
        now = datetime.now(timezone.utc)
        if now.hour == 0 and now.minute < 5:
            return
        day = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        if not (directory() / ("rollup-" + day + ".json")).exists():
            rollup(day)
    except Exception:
        pass


if __name__ == "__main__":
    # Shell health checks pass only a result, a status label, a link kind and elapsed time.
    import sys
    try:
        if sys.argv[1] == "mullvad":
            relay = re.search(r"\b[a-z]{2}-[a-z]{3}-wg-\d{3}\b", sys.argv[3])
            emit("mullvad", "mullvad.check", kind="perf" if sys.argv[2] == "0" else "error",
                 ok=sys.argv[2] == "0", duration_ms=float(sys.argv[5]),
                 props={"exitRelay": relay[0] if relay else None, "linkType": sys.argv[4]},
                 tag="mullvad_failed" if sys.argv[2] != "0" else None)
    except Exception:
        pass
