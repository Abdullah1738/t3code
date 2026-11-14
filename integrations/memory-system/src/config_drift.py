"""Recover missed OpenCode config notifications on the location-reaper cadence.

Only hashes go into the ledger: resolved config can contain credentials. There
is no server-side idle/evict transaction in 2.0.22, so activity is checked again
immediately before eviction. Failed or unknown safety probes never mean idle.
"""
import copy
import fcntl
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.parse
from datetime import datetime
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
    reason = live_queued_work(directory, now)
    if reason:
        return reason
    for route in ("/api/form", "/api/permission/request", "/api/shell"):
        if items(route, directory):
            return route.rsplit("/", 1)[-1]
    # Forms can be followed by a resumed session while the other probes run.
    running, unknown = reaper.running_dirs(sid_dir)
    return "running-session" if directory in running or unknown else None


def live_queued_work(directory, now):
    """The export can lag new inbox items; ask the owning service before evicting.

    Session listing is global and filtered by directory; it does not boot a
    location. Visit every page, including children and archived sessions.
    """
    query = {"directory": directory, "order": "desc", "limit": 100}
    first_path = "/api/session?" + urllib.parse.urlencode(query)
    path, cursors, first_ids = first_path, set(), None
    for _ in range(1000):
        page = get(path, dict)
        sessions, cursor = page.get("data"), page.get("cursor")
        if not isinstance(sessions, list) or not isinstance(cursor, dict):
            raise ValueError("invalid session page")
        ids = []
        for session in sessions:
            sid = session["id"]
            if not isinstance(sid, str) or not sid.startswith("ses_") or session["location"]["directory"] != directory:
                raise ValueError("invalid session location")
            ids.append(sid)
            times = session["time"]
            if not isinstance(times, dict) or any(times.get(key) is None for key in ("created", "updated")):
                raise ValueError("missing mandatory session timestamps")
            for key in ("created", "updated", "viewed"):
                value = times.get(key)
                if key in times and value is None:
                    raise ValueError("null session timestamp")
                if value is not None:
                    if isinstance(value, str):
                        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
                        if at.tzinfo is None:
                            raise ValueError("session timestamp lacks timezone")
                        ms = at.timestamp() * 1000
                    else:
                        ms = value
                    if isinstance(ms, bool) or not isinstance(ms, (int, float)) or not math.isfinite(ms):
                        raise ValueError("invalid session timestamp")
                    if now * 1000 - ms < reaper.ACTIVE_MIN * 60000:
                        return "recent-session"
            inbox = get("/api/session/" + urllib.parse.quote(sid, safe="") + "/inbox", dict)
            if not isinstance(inbox.get("data"), list):
                raise ValueError("invalid session inbox")
            if inbox["data"]:
                return "queued-work"
        if first_ids is None:
            first_ids = ids
        next_cursor = cursor.get("next")
        if next_cursor is None:
            # A session admitted during pagination is also work to defer to.
            latest = get(first_path, dict)
            if not isinstance(latest.get("data"), list):
                raise ValueError("invalid session readback")
            return "sessions-changed" if [s["id"] for s in latest["data"]] != first_ids else None
        if not isinstance(next_cursor, str) or next_cursor in cursors:
            raise ValueError("invalid session cursor")
        cursors.add(next_cursor)
        path = "/api/session?" + urllib.parse.urlencode({"cursor": next_cursor, "limit": 100})
    raise ValueError("session page budget exhausted")


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


class ReferenceProbeError(ValueError):
    pass


def cleanup_probe(state, save, logs, sid_dir, last, keep, now):
    scratch = state.get("probe")
    if not scratch:
        return
    try:
        probe = Path(scratch)
        if probe.is_symlink() or probe.parent.resolve() != logs.resolve() or not probe.name.startswith("opencode-config-drift-"):
            raise ValueError("unowned reference probe path")
        if busy(scratch, sid_dir, last, keep, now):
            raise ValueError("reference probe is busy")
        status, _ = reaper.api("DELETE", "/api/debug/location?" + reaper.loc_q(scratch))
        if status != 204:
            raise ValueError("scratch eviction failed")
        shutil.rmtree(scratch, ignore_errors=True)
        del state["probe"]
        save()
    except Exception as e:
        if isinstance(e, urllib.error.HTTPError):
            e.close()
        raise ReferenceProbeError("reference cleanup failed") from e


def fresh_documents(config, state, save, logs, sid_dir, last, keep, now):
    # Persist ownership before booting: a failed/ambiguous cleanup is retried
    # before any new probe is created, including after process interruption.
    state["probe"] = tempfile.mkdtemp(prefix="opencode-config-drift-", dir=logs)
    save()
    try:
        return documents(get("/api/config?" + reaper.loc_q(state["probe"]), list), config)
    except Exception as e:
        if isinstance(e, urllib.error.HTTPError):
            e.close()
        raise ReferenceProbeError("reference read failed") from e
    finally:
        cleanup_probe(state, save, logs, sid_dir, last, keep, now)


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

        if state.get("probe"):
            loaded.discard(state["probe"])
            if dry_run:
                decision("would-clean-probe", state["probe"])
            else:
                cleanup_probe(state, save, logs, sid_dir, last, keep, now)

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
                resolved = digest(observed_entries)
                if previous.get("version") == version and previous.get("done"):
                    if previous.get("verified") == resolved:
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
                    expected = fresh_documents(config, state, save, logs, sid_dir, last, keep, now)
                    if content_hash(shared_roots) != shared:
                        raise ValueError("config changed during reference probe")
                observed = documents(observed_entries, config)
                # Resolved comparison catches drift present before the first run.
                # A matching document cannot prove plugin/skill content is fresh,
                # so new input versions still get one conservative idle refresh.
                mismatch = observed != expected
                if version_for(paths) != version or content_hash(shared_roots) != shared:
                    raise ValueError("config changed during pass")
                if (previous.get("version") == version and previous.get("done")
                        and previous.get("verified") is None and not previous.get("invalidated") and not mismatch):
                    # A saved 204 may have lost only its warmup response. Accept
                    # a matching, stable readback without another eviction.
                    ledger[directory]["verified"] = resolved
                    save()
                    decision("reconciled", directory, version=version)
                    continue
                if previous.get("version") == version and previous.get("pending"):
                    # Only a stale-to-fresh document transition proves that an
                    # ambiguous send applied. Plugin-only changes have no such
                    # readback; leave those uncertain rather than guessing.
                    if previous.get("resolved_mismatch") and not mismatch:
                        ledger[directory] = {"version": version, "done": True, "verified": resolved}
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
                    # 2.0.22 has per-location eviction. Never broaden a failed
                    # request into a global shutdown of unrelated locations.
                    raise
                ledger[directory] = {"version": version, "done": True}
                save()
                decision("reloaded", directory, version=version, resolved_mismatch=mismatch)
                # Boot fresh services now, particularly for the HOME model probe.
                warmed = get("/api/config?" + reaper.loc_q(directory), list)
                if version_for(paths) != version or content_hash(shared_roots) != shared or documents(warmed, config) != expected:
                    ledger[directory]["invalidated"] = True
                    save()
                    raise ValueError("config changed during warmup")
                ledger[directory]["verified"] = digest(warmed)
                save()
            except Exception as e:
                if isinstance(e, ReferenceProbeError):
                    raise
                # HTTPError strings omit response payloads/config credentials.
                if isinstance(e, urllib.error.HTTPError):
                    e.close()
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
