"""Recover missed OpenCode config notifications on the location-reaper cadence.

Only hashes go into the ledger: resolved config can contain credentials. There
is no server-side idle/evict transaction in 2.0.22, so activity is checked again
immediately before eviction. Failed or unknown safety probes never mean idle.
"""
import copy
import fcntl
import hashlib
import json
import os
import tempfile
import time
import urllib.error
from pathlib import Path

import location_reaper as reaper

IGNORE = {".git", "node_modules"}
NAMES = ("opencode.json", "opencode.jsonc")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def content_hash(paths):
    """Follow config/skill symlinks, including external targets, without cycles."""
    result = []

    def visit(p, ancestors):
        try:
            real = p.resolve(strict=True)
        except FileNotFoundError:
            result.append((str(p), "missing"))
            return
        if real in ancestors:
            result.append((str(p), "cycle"))
        elif p.is_dir():
            result.append((str(p), "directory"))
            for child in sorted(p.iterdir()):
                if child.name not in IGNORE:
                    visit(child, ancestors | {real})
        else:
            result.append((str(p), hashlib.sha256(p.read_bytes()).hexdigest()))

    for p in sorted(set(map(Path, paths))):
        visit(p, set())
    return digest(result)


def inputs(directory, home, config):
    roots = {config, home / ".claude/skills", home / ".agents/skills"}
    # Match ConfigDiscovery's ancestor walk, including currently absent inputs.
    for parent in (Path(directory), *Path(directory).parents):
        roots.update(parent / name for name in (*NAMES, ".opencode", ".claude/skills", ".agents/skills"))
    return roots


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def get(path, expected):
    status, body = reaper.api("GET", path)
    if status != 200 or not isinstance(body, expected):
        raise ValueError("invalid response from " + path.split("?")[0])
    return body


def items(route, directory):
    body = get(route + "?" + reaper.loc_q(directory), dict)
    if not isinstance(body.get("data"), list):
        raise ValueError("invalid data from " + route)
    return body["data"]


def busy(directory, sid_dir, last, keep, now):
    if directory in keep or now * 1000 - last.get(directory, 0) < reaper.ACTIVE_MIN * 60000:
        return "recent-or-kept"
    # Validate the active response before using the reaper's session mapping.
    active = get("/api/session/active", dict)
    if not isinstance(active.get("data"), dict):
        raise ValueError("invalid active sessions")
    if active["data"]:
        running, unknown = reaper.running_dirs(sid_dir)
        if unknown or directory in running:
            return "running-session"
        # A session that vanished between the two reads is harmless; a newly
        # seen ID in this first snapshot must still have a known directory.
        if any(s not in sid_dir or sid_dir[s] == directory for s in active["data"]):
            return "running-session"
    for route in ("/api/form", "/api/permission/request", "/api/shell"):
        if items(route, directory):
            return route.rsplit("/", 1)[-1]
    # Forms can be followed by a resumed session while the other probes run.
    running, unknown = reaper.running_dirs(sid_dir)
    return "running-session" if directory in running or unknown else None


def globally_idle(loaded, last, keep, now):
    """Fallback has no session-mapping assumption: any active ID blocks it."""
    def active():
        body = get("/api/session/active", dict)
        if not isinstance(body.get("data"), dict):
            raise ValueError("invalid active sessions")
        return bool(body["data"])

    if active():
        return False
    for directory in loaded:
        if directory in keep or now * 1000 - last.get(directory, 0) < reaper.ACTIVE_MIN * 60000:
            return False
        for route in ("/api/form", "/api/permission/request", "/api/shell"):
            if items(route, directory):
                return False
    return not active()


def documents(entries, config):
    result = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid config entry")
        if entry.get("type") == "document" and entry.get("path"):
            p = Path(entry["path"])
            if p in {config / n for n in NAMES}:
                result[str(p)] = digest(entry["info"])
    return result


def fresh_documents(config):
    # A new directory has no cached config. Never reload/evict another probe.
    with tempfile.TemporaryDirectory(prefix="opencode-config-drift-") as scratch:
        try:
            return documents(get("/api/config?" + reaper.loc_q(scratch), list), config)
        finally:
            status, _ = reaper.api("DELETE", "/api/debug/location?" + reaper.loc_q(scratch))
            if status != 204:
                raise ValueError("scratch eviction failed")


def dropped_events(path, previous):
    """Byte cursor handles append, truncation and rotation; count complete lines."""
    try:
        with path.open("rb") as f:
            st = os.fstat(f.fileno())
            identity = [st.st_dev, st.st_ino]
            offset = previous.get("offset", 0) if previous.get("identity") == identity else 0
            if st.st_size < offset:
                offset = 0
            f.seek(offset)
            count = 0
            while line := f.readline():
                if not line.endswith(b"\n"):
                    break
                offset = f.tell()
                count += b"Events were dropped" in line
            return count, {"identity": identity, "offset": offset}
    except FileNotFoundError:
        return 0, previous


def run(loaded, last, sid_dir, keep, *, dry_run=False, logs=None, home=None, config=None,
        service_log=None, now=None):
    logs = Path(logs or reaper.LOGS)
    home = Path(home or Path.home())
    config = Path(config or home / ".config/opencode")
    service_log = Path(service_log or home / "Library/Logs/opencode-service.log")
    now = time.time() if now is None else now
    st = {"state": "done", "ts": int(now), "dry_run": dry_run, "decisions": [],
          "stale_detected": 0, "reloaded": 0, "deferred_busy": 0, "failed": 0,
          "unchanged": 0, "dropped_events_new": 0, "dropped_events_total": 0}
    state_path = logs / "config_drift_state.json"

    def decision(action, directory=None, **extra):
        row = {"action": action, "directory": directory, **extra}
        st["decisions"].append(row)
        key = action.replace("-", "_")
        st[key] = st.get(key, 0) + 1
        if action == "failed":
            st["state"] = "error"
        print("config-drift " + json.dumps(row, sort_keys=True), flush=True)

    # Directory-only queries cannot address workspace refs in this API version.
    refs = [row if isinstance(row, dict) else {"directory": row} for row in loaded]
    workspace_dirs = {row["directory"] for row in refs if row.get("workspaceID")}
    loaded = {row["directory"] for row in refs if row.get("directory")} - workspace_dirs
    for directory in sorted(workspace_dirs):
        decision("deferred-busy", directory, reason="workspace-ref-unsupported")

    if not dry_run:
        logs.mkdir(parents=True, exist_ok=True)
    # Launchd serializes scheduled runs; also serialize manual non-dry runs.
    lock = None
    try:
        if not dry_run:
            lock = (logs / "config_drift.lock").open("a")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                st["state"] = "locked"
                return st
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        state = copy.deepcopy(state)
        ledger = state.setdefault("locations", {})

        def save():
            if not dry_run:
                atomic_json(state_path, state)

        count, state["log_cursor"] = dropped_events(service_log, state.get("log_cursor", {}))
        state["dropped_events_total"] = state.get("dropped_events_total", 0) + count
        st.update(dropped_events_new=count, dropped_events_total=state["dropped_events_total"])
        # Compatibility watches only skills, not Claude's growing transcript
        # store. Hashing ~/.claude recursively would read many GB every run.
        shared_roots = {config, home / ".claude/skills", home / ".agents/skills"}
        shared = content_hash(shared_roots)

        def version_for(paths):
            return digest([shared, content_hash(paths - shared_roots)])

        expected = None
        for directory in sorted(set(loaded), key=lambda d: (d != str(home), d)):
            try:
                observed_entries = get("/api/config?" + reaper.loc_q(directory), list)
                paths = inputs(directory, home, config)
                # Explicit config files can live outside the discovery roots.
                paths.update(Path(e["path"]) for e in observed_entries
                             if e.get("type") == "document" and e.get("path"))
                version = version_for(paths)
                previous = ledger.get(directory, {})
                if previous.get("version") == version and previous.get("done"):
                    st["unchanged"] += 1
                    continue
                decision("stale-detected", directory, version=version)
                reason = busy(directory, sid_dir, last, keep, now)
                if reason:
                    decision("deferred-busy", directory, reason=reason)
                    continue
                if dry_run:
                    decision("would-reload", directory, version=version)
                    continue
                if expected is None:
                    expected = fresh_documents(config)
                    if content_hash(shared_roots) != shared:
                        raise ValueError("config changed during reference probe")
                observed = documents(observed_entries, config)
                # Resolved comparison catches drift present before the first run.
                # A matching document cannot prove plugin/skill content is fresh,
                # so new input versions still get one conservative idle refresh.
                mismatch = observed != expected
                if previous.get("version") == version and previous.get("pending"):
                    # Only a stale-to-fresh document transition proves that an
                    # ambiguous send applied. Plugin-only changes have no such
                    # readback; leave those uncertain rather than guessing.
                    if previous.get("resolved_mismatch") and not mismatch:
                        ledger[directory] = {"version": version, "done": True}
                        save()
                        decision("reconciled", directory, version=version)
                        continue
                    if not previous.get("resolved_mismatch"):
                        decision("failed", directory, reason="uncertain-eviction")
                        continue
                if version_for(paths) != version or content_hash(shared_roots) != shared:
                    raise ValueError("config changed during pass")
                # Refresh the guarded export too: queued inbox/pending work may
                # have appeared while the reference location was booting.
                latest_last, latest_dirs = reaper.last_activity_by_dir()
                sid_dir.update(latest_dirs)
                reason = busy(directory, sid_dir, latest_last, keep, now)
                if reason:
                    decision("deferred-busy", directory, reason=reason)
                    continue
                if previous.get("attempt_at", 0) > now - 300:
                    decision("retry-later", directory)
                    continue
                ledger[directory] = {"version": version, "pending": True, "attempt_at": now,
                                     "resolved_mismatch": mismatch}
                save()  # Write ahead so an interrupted HTTP request is reconciled.
                try:
                    status, _ = reaper.api("DELETE", "/api/debug/location?" + reaper.loc_q(directory))
                    if status != 204:
                        raise ValueError("eviction did not return 204")
                except urllib.error.HTTPError as e:
                    e.close()
                    # A definitive HTTP failure can be retried next cadence.
                    ledger[directory]["pending"] = False
                    save()
                    if e.code == 405:
                        # Only an explicit unsupported method allows fallback.
                        # A missing/racing location (404) must never cause one.
                        if state.get("global_attempt_at", 0) > now - 600:
                            decision("retry-later", directory, reason="global-cooldown")
                            continue
                        current = get("/api/debug/location", list)
                        dirs = [row["directory"] for row in current]
                        if any(row.get("workspaceID") for row in current):
                            raise ValueError("workspace location cannot be safely refreshed")
                        versions = {}
                        for d in dirs:
                            entries = get("/api/config?" + reaper.loc_q(d), list)
                            roots = inputs(d, home, config)
                            roots.update(Path(e["path"]) for e in entries
                                         if e.get("type") == "document" and e.get("path"))
                            versions[d] = version_for(roots)
                        if content_hash(shared_roots) != shared:
                            raise ValueError("config changed before fallback")
                        latest_last, latest_dirs = reaper.last_activity_by_dir()
                        sid_dir.update(latest_dirs)
                        if not globally_idle(dirs, latest_last, keep, now):
                            decision("deferred-busy", directory, reason="global-fallback")
                            continue
                        state["global_attempt_at"] = now
                        for d, v in versions.items():
                            ledger[d] = {"version": v, "pending": True, "attempt_at": now,
                                         "resolved_mismatch": False}
                        save()
                        status, _ = reaper.api("POST", "/api/location/reload")
                        if status != 204:
                            raise ValueError("global reload did not return 204")
                        for d, v in versions.items():
                            ledger[d] = {"version": v, "done": True}
                        save()
                        decision("reloaded", directory, version=version, scope="global")
                        break
                    raise
                ledger[directory] = {"version": version, "done": True}
                save()
                decision("reloaded", directory, version=version, resolved_mismatch=mismatch)
                # Boot fresh services now, particularly for the HOME model probe.
                get("/api/config?" + reaper.loc_q(directory), list)
            except Exception as e:
                # HTTPError strings omit response payloads/config credentials.
                decision("failed", directory, error=type(e).__name__)
        save()
    except Exception as e:
        decision("failed", error=type(e).__name__)
    finally:
        if lock:
            lock.close()
    if not dry_run:
        atomic_json(logs / "config_drift_last.json", st)
    return st
