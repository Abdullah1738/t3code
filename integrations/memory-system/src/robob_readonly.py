"""Outside readers use the server export, never the server's writable database."""

import os
import json
import sqlite3
import stat
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path


class UnsafeStateDatabase(sqlite3.OperationalError):
    pass


class ReplicaNotReady(UnsafeStateDatabase):
    pass


class ReplicaReplaced(sqlite3.OperationalError):
    pass


class _ReplicaConnection(sqlite3.Connection):
    pass


_warnings = threading.local()


def reset_replica_warnings():
    _warnings.snapshots = {}


def replica_warnings():
    return list(getattr(_warnings, "snapshots", {}).values())


def replica_warning(path):
    return getattr(_warnings, "snapshots", {}).get(str(Path(path).expanduser().resolve()))


def annotate_result(result):
    snapshots = replica_warnings()
    if isinstance(result, dict):
        snapshots = list({snapshot["warning"]: snapshot for snapshot in
                          [*result.get("replica_warnings", []), *snapshots]}.values())
    notices = [snapshot["warning"] for snapshot in snapshots]
    if not notices:
        return result
    notice = "\n".join(notices)
    if isinstance(result, str):
        return f"{notice}\n\n{result}"
    if isinstance(result, dict):
        result = {**result, "replica_warnings": snapshots}
        if isinstance(result.get("answer"), str) and not result["answer"].startswith(notice):
            result["answer"] = f"{notice}\n\n{result['answer']}"
        if isinstance(result.get("note"), str):
            from recall_note import bounded_note
            original = bounded_note(result["note"])
            if original and original.startswith(notice):
                result["note"] = original
            else:
                result["note"] = bounded_note(f"{notice}\n\n{original or ''}")
                if result["note"] is None:
                    # Optional history can be omitted; never cut an instruction
                    # or let the native hook silently discard the stale label.
                    result["note"] = bounded_note(notice)
                    result["sources"] = []
    return result


def _timestamp(value):
    at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if at.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return at


def _live_rebuild(con, metadata, age, now):
    if age >= 6 * 60 * 60:
        return None, "age_cap"
    started = metadata.get("rebuild_started_at")
    if not started:
        return None, "no_rebuild"
    try:
        start = _timestamp(started)
        if start > now:
            return None, "invalid_rebuild_time"
        if metadata.get("rebuild_finished_at") and _timestamp(metadata["rebuild_finished_at"]) >= start:
            return None, "rebuild_finished"
        sql_progress = json.loads(metadata.get("rebuild_progress") or "{}")
        if sql_progress.get("event") in ("abort", "publish"):
            return None, "sql_rebuild_terminal"
        sidecar = con.replica_path.with_name(con.replica_path.name + ".rebuild.json")
        with sidecar.open() as handle:
            info = os.fstat(handle.fileno())
            diagnostics = json.loads(handle.read(16_384))
        if not -30 <= now.timestamp() - info.st_mtime < 300:
            return None, "sidecar_stale"
        if diagnostics.get("replica_identity") != list(con.replica_identity):
            return None, "identity_mismatch"
        if diagnostics.get("rebuild_started_at") != started:
            return None, "start_mismatch"
        if diagnostics.get("rebuild_finished_at") and _timestamp(diagnostics["rebuild_finished_at"]) >= start:
            return None, "rebuild_finished"
        progress = json.loads(diagnostics["rebuild_progress"])
        if progress.get("kind") != "full" or metadata.get("rebuild_kind", "full") != "full":
            return None, "not_full_rebuild"
        if progress.get("event") not in ("start", "progress"):
            return None, "not_in_progress"
        return {"rebuild_started_at": started, "table": progress.get("table") or "pending",
                "rows": progress.get("rows", 0)}, None
    except FileNotFoundError:
        return None, "sidecar_missing"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None, "invalid_rebuild_evidence"


def _log_stale(event, metadata, age, source, details=None, reason=None):
    print(json.dumps({"component": "readonly-replica", "event": event, "source": source,
                      "age_s": age, "rebuild_started_at": metadata.get("rebuild_started_at"),
                      **(details or {}), **({"reason": reason} if reason else {})}),
          file=sys.stderr, flush=True)


def file_identity(path):
    info = safe_path(path).stat()
    return info.st_dev, info.st_ino


def ensure_same_file(con, path):
    if con.replica_identity != file_identity(path):
        raise ReplicaReplaced("read-only replica inode changed during read")


def connection_generation(con, path, *, native=False):
    ensure_same_file(con, path)
    updated = native_generation(con) if native else ready_generation(con)
    return (*con.replica_identity, updated)


def state_db(*overrides):
    for key in (*overrides, "ROBOB_READONLY_DB"):
        if os.environ.get(key):
            return os.environ[key]
    return str(Path.home() / ".robob/userdata/readonly/state.sqlite")


def opencode_db():
    return (os.environ.get("OPENCODE_DB") or os.environ.get("OPENCODE_READONLY_DB")
            or str(Path.home() / ".robob/userdata/readonly/opencode.sqlite"))


def _live_paths():
    homes = {Path.home() / ".robob", Path.home() / ".t3",
             Path("/Volumes/ExternalSSD/robob-data")}
    for key in ("T3CODE_HOME", "ROBOB_HOME"):
        if os.environ.get(key):
            homes.add(Path(os.environ[key]).expanduser())
    paths = {home / "userdata" / name for home in homes for name in ("statev2.sqlite", "state.sqlite")}
    paths.add(Path.home() / ".local/share/opencode/opencode.db")
    if os.environ.get("XDG_DATA_HOME"):
        paths.add(Path(os.environ["XDG_DATA_HOME"]).expanduser() / "opencode/opencode.db")
    return paths


def safe_path(path):
    """Check names, resolved aliases and inode identity before SQLite sees a path.

    Only filesystem paths are accepted; callers cannot inject SQLite URI options.
    stat/resolve inspect metadata only, not the live database's contents.
    """
    raw = os.fspath(path)
    if not isinstance(raw, str) or raw.startswith("file:") or "\x00" in raw:
        raise UnsafeStateDatabase("database must be a filesystem path, not a SQLite URI")
    candidate = Path(os.path.abspath(os.path.expanduser(raw)))
    live_paths = _live_paths()
    try:
        resolved = candidate.resolve()
        if candidate in live_paths or resolved in {p.resolve() for p in live_paths}:
            raise UnsafeStateDatabase("refusing live Robob/OpenCode DB; use ROBOB_READONLY_DB or OPENCODE_READONLY_DB")
        try:
            info = resolved.stat()
        except FileNotFoundError:
            return resolved
        for live in live_paths:
            try:
                live_info = live.stat()
            except FileNotFoundError:
                continue
            if (info.st_dev, info.st_ino) == (live_info.st_dev, live_info.st_ino):
                raise UnsafeStateDatabase("refusing hardlink to live Robob/OpenCode DB; use a read-only export")
    except (OSError, RuntimeError) as exc:
        if isinstance(exc, UnsafeStateDatabase):
            raise
        raise UnsafeStateDatabase("cannot verify database is separate from live Robob/OpenCode state") from exc
    return resolved


def connect_ro(path, *, timeout=30, check_same_thread=True):
    path = safe_path(path)
    try:
        info = path.stat()
    except FileNotFoundError:
        raise FileNotFoundError(f"Read-only database {path} not found; waiting for owner export") from None
    if not stat.S_ISREG(info.st_mode):
        raise UnsafeStateDatabase("read-only replica must be a regular file")
    con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=timeout,
                         check_same_thread=check_same_thread, factory=_ReplicaConnection)
    con.replica_identity = info.st_dev, info.st_ino
    con.replica_path = path
    try:
        ensure_same_file(con, path)
    except Exception:
        con.close()
        raise
    return con


def _rebuild_status(con, metadata):
    if not metadata.get("rebuild_started_at") or metadata.get("rebuild_finished_at"):
        return ""
    # This sidecar advances outside the publication transaction. It explains a
    # rejected read; it never supplies readiness, generation or freshness.
    try:
        with con.replica_path.with_name(con.replica_path.name + ".rebuild.json").open() as diagnostic:
            diagnostics = json.loads(diagnostic.read(16_384))
        if (diagnostics.get("replica_identity") == list(con.replica_identity)
                and diagnostics.get("rebuild_started_at") == metadata.get("rebuild_started_at")):
            metadata = {**metadata, **{key: diagnostics[key] for key in (
                "rebuild_started_at", "rebuild_finished_at", "rebuild_progress")}}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    if not metadata.get("rebuild_started_at") or metadata.get("rebuild_finished_at"):
        return ""
    rebuilding = f"; rebuilding since {metadata['rebuild_started_at']}"
    try:
        progress = json.loads(metadata.get("rebuild_progress", "{}"))
        if progress.get("event") == "abort":
            rebuilding = f"; rebuild aborted since {metadata['rebuild_started_at']}"
        rebuilding += f" (table {progress.get('table') or 'pending'}, {progress.get('rows', 0)} rows)"
    except (ValueError, TypeError, AttributeError):
        pass
    return rebuilding


def ready_generation(con, *, max_age=120, source="Robob", schema_version=None, require_destructive=False,
                     allow_rebuild=False):
    """Pin readiness to the snapshot; only opted-in content reads may use a live rebuild."""
    metadata = {}
    age = None
    try:
        metadata = dict(con.execute(
            "SELECT key,value FROM ardud_readonly_meta "
            "WHERE key IN ('schema_version','destructive_ready','updated_at','ready','generation',"
            "'rebuild_kind','rebuild_started_at','rebuild_progress','rebuild_finished_at')"))
        if schema_version is not None and metadata.get("schema_version") != schema_version:
            raise ValueError("unsupported export schema")
        if require_destructive and metadata.get("destructive_ready") != "1":
            raise ValueError("native metadata changed during validation")
        updated = metadata.get("updated_at", "missing")
        if hasattr(con, "replica_identity"):
            con.replica_warning = None
        now = datetime.now(timezone.utc)
        if metadata.get("ready") == "1":
            if not isinstance(updated, str):
                raise ValueError("timestamp is not text")
            at = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if at.tzinfo is None:
                raise ValueError("timestamp has no timezone")
            age = (now - at).total_seconds()
        if metadata.get("ready") != "1" or not -30 <= age <= max_age:
            reason = "not_ready" if metadata.get("ready") != "1" else "not_allowed"
            details = None
            if metadata.get("ready") == "1" and age > max_age and allow_rebuild and not require_destructive:
                details, reason = _live_rebuild(con, metadata, age, now)
            if details is not None:
                warning = (f"replica as of {updated}; rebuild in progress since {details['rebuild_started_at']} "
                           f"({details['table']}, {details['rows']} rows)")
                con.replica_warning = warning
                snapshots = getattr(_warnings, "snapshots", {})
                snapshots[str(con.replica_path)] = {"updated_at": updated, **details, "warning": warning}
                _warnings.snapshots = snapshots
                if getattr(con, "_last_stale_warning", None) != warning:
                    _log_stale("stale-served", metadata, age, source, details)
                    con._last_stale_warning = warning
                return updated
            _log_stale("stale-refused", metadata, age, source, reason=reason)
            rebuilding = _rebuild_status(con, metadata)
            status = "not ready" if metadata.get("ready") != "1" else "stale"
            raise ReplicaNotReady(
                f"{source} recall replica {status} (generation {metadata.get('generation', 'unknown')}, "
                f"updated_at {updated}, ready {metadata.get('ready', 'missing')}){rebuilding}; retry later")
    except ReplicaNotReady:
        raise
    except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
        # The lineage retry boundary classifies interrupts as timeouts.
        if isinstance(exc, sqlite3.OperationalError) and "interrupt" in str(exc).lower():
            raise
        _log_stale("stale-refused", metadata, age, source, reason="invalid_readiness")
        raise UnsafeStateDatabase(f"{source} read-only replica missing readiness or stale (>{max_age}s); waiting for server export") from exc
    if hasattr(con, "replica_path"):
        getattr(_warnings, "snapshots", {}).pop(str(con.replica_path), None)
    return updated


def state_ro(path, *, timeout=30, check_same_thread=True, allow_rebuild=False):
    con = connect_ro(path, timeout=timeout, check_same_thread=check_same_thread)
    try:
        con.execute("BEGIN")
        ready_generation(con, allow_rebuild=allow_rebuild)
    except Exception:
        con.close()
        raise
    return con


def native_generation(con, *, require_destructive=False):
    return ready_generation(con, source="OpenCode", schema_version="1", require_destructive=require_destructive)


def refresh_native(con, *, require_destructive=False):
    """End the previous read and pin readiness and data to one new snapshot."""
    con.rollback()
    try:
        con.execute("BEGIN")
        generation = native_generation(con, require_destructive=require_destructive)
        rows = con.execute("PRAGMA database_list").fetchall()
        ensure_same_file(con, next(row[2] for row in rows if row[1] == "main"))
        return generation
    except Exception:
        con.rollback()
        raise


def native_ro(path, *, timeout=30, check_same_thread=True, require_destructive=False):
    con = connect_ro(path, timeout=timeout, check_same_thread=check_same_thread)
    try:
        refresh_native(con, require_destructive=require_destructive)
    except Exception:
        con.close()
        raise
    return con


def native_capture_generation(con, sid):
    row = con.execute("SELECT applied_seq,dirty FROM ardud_native_sessions WHERE id=?", (sid,)).fetchone()
    if row is None or row[0] is None or row[1] != 0:
        raise UnsafeStateDatabase(f"OpenCode session {sid} export incomplete or deferred; retry next capture")
    return row[0]


def main():
    # The backup script resolves through the same guard before invoking sqlite3.
    path = safe_path(state_db("ROBOB_STATE_DB"))
    con = state_ro(path)
    generation = ready_generation(con)
    con.close()
    print(generation if sys.argv[1:] == ["--generation"] else path)


if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
