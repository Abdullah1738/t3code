"""Outside readers use the server export, never the server's writable database."""

import os
import sqlite3
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


class UnsafeStateDatabase(sqlite3.OperationalError):
    pass


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
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=timeout,
                           check_same_thread=check_same_thread)


def ready_generation(con, *, max_age=120):
    """The exporter clears ready while paging, then publishes a new watermark."""
    try:
        metadata = dict(con.execute("SELECT key,value FROM ardud_readonly_meta"))
        updated = metadata["updated_at"]
        if not isinstance(updated, str):
            raise ValueError("timestamp is not text")
        at = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        if at.tzinfo is None:
            raise ValueError("timestamp has no timezone")
        age = (datetime.now(timezone.utc) - at).total_seconds()
        if metadata.get("ready") != "1" or not -30 <= age <= max_age:
            raise ValueError("not ready or stale")
    except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
        raise UnsafeStateDatabase("Robob read-only replica missing readiness or stale (>120s); waiting for server export") from exc
    return updated


def state_ro(path, *, timeout=30, check_same_thread=True):
    con = connect_ro(path, timeout=timeout, check_same_thread=check_same_thread)
    try:
        con.execute("BEGIN")
        ready_generation(con)
    except Exception:
        con.close()
        raise
    return con


def native_ro(path, *, timeout=30):
    # Until OpenCode owns an export metadata contract, never reap against a
    # native snapshot that stopped updating. Stat does not open the live DB.
    path = safe_path(path)
    if not -30 <= time.time() - path.stat().st_mtime <= 120:
        raise UnsafeStateDatabase("OpenCode read-only export stale (>120s); refusing reaper evidence")
    return connect_ro(path, timeout=timeout)


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
