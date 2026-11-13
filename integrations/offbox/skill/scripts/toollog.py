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
NUMBERS = set("bytes files skipped exitCode waitMs position ttlSeconds reasonLength busy idle stopped count flagsCount envCount pullCount includeCount stepCount attempt pid".split())
BOOLEANS = set("queued fresh bg noSync git noFallback noRetry remote failed stale timeoutHit fallback dryRun baseGiven templateGiven sizeGiven".split())
ENUMS = {
    "backend": {"home", "boat"}, "from": {"home", "boat"}, "to": {"home", "boat"},
    "reason": {"pinned", "home_up", "home_down", "unreachable", "boat_only", "boat_only_base", "infra", "cap", "busy", "person_home_down"},
    "leaseKind": {"fresh", "reused", "saved-base"},
    "decision": {"allowed", "denied", "local-override"},
    "harness": {"opencode", "codex", "claudeAgent", "codex-cu"},
    "commandClass": {"cargo", "evm", "go-build", "go-test", "gradle", "js-test", "lint", "make-test", "pytest", "typecheck", "light", "heavy", "unknown", "test", "install", "build", "docker", "opaque", "cpu"},
    "action": {"stop", "delete", "forget", "settle", "keep", "other"},
    "linkType": {"wireguard", "residential", "down", "unknown"},
    "stage": {"ssh_setup", "ssh_drop", "readiness", "put_file", "sync", "pull", "command", "install_mid_run", "request", "reaper"},
}
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
            if k in {"run", "box", "thread", "card", "chat", "order"} and isinstance(v, str)
            and len(v) <= 200 and re.fullmatch(r"[A-Za-z0-9_:%.\-/]+", v)
            and not re.search(r"\d{13,}", v)}


def _props(values):
    out = {}
    for k, v in (values or {}).items():
        if k in NUMBERS and type(v) in (int, float) and math.isfinite(v):
            out[k] = v
        elif k in BOOLEANS and type(v) is bool:
            out[k] = v
        elif k in ENUMS and isinstance(v, str) and v in ENUMS[k]:
            out[k] = v
        elif k == "repo" and isinstance(v, str) and re.fullmatch(r"[a-f0-9]{16}", v):
            out[k] = v
        elif k == "size" and v in ("small", "default", "large", "xlarge"):
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
        if clean := _props(props):
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
    path = root / (day + ".ndjson")
    if path.exists():
        with path.open() as source:
            for raw in source:
                try:
                    row = json.loads(raw)
                    if not isinstance(row, dict) or row.get("tool") != "offbox" or not _atom(row.get("name")) or row.get("kind") not in ("event", "perf", "error"):
                        raise ValueError()
                    name, kind = row["name"], row["kind"]
                    total += 1
                    counts[name] += 1
                    kinds[kind] += 1
                    if type(row.get("ok")) is bool:
                        checked += 1
                        ok += row["ok"]
                    bad += kind == "error" or row.get("ok") is False
                    ms = row.get("durationMs")
                    if type(ms) in (int, float) and math.isfinite(ms) and ms >= 0:
                        durations.setdefault(name, []).append(ms)
                    tag = (row.get("error") or {}).get("tag")
                    if _atom(tag):
                        errors[tag] += 1
                        samples.setdefault(tag, _ids(row.get("ids")))
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
    def stats(xs):
        xs.sort()
        return {"p50": xs[max(0, math.ceil(len(xs)*.50)-1)], "p95": xs[math.ceil(len(xs)*.95)-1], "max": xs[-1]}
    result = {"day": day, "total": total, "countsByName": dict(counts), "countsByKind": dict(kinds),
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
