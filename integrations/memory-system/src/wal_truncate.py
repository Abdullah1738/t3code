#!/opt/homebrew/bin/python3
"""Zero-wait WAL reset for the capture databases, run at the end of every tick.

The capture writers turn off auto-checkpoints (wal_autocheckpoint=0 and
SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE) so they never stall on a checkpoint mid-tick.
Nothing else checkpointed memory.db, so its WAL only ever grew (9.2 GB on
2026-11-06) and the sqlite3_rsync replica backup timed out on every run.

For each database this tries PASSIVE (copy what it can, never waits), then,
only when every WAL frame is already in the main file, TRUNCATE (reset the
WAL to 0 bytes). busy_timeout is 0: a reader or writer that holds the WAL
just means "try again next tick". It never fails the tick; it prints one JSON
line per database for the capture log.
"""

import argparse
import json
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, ".local/share/memory-system/data")
DEFAULT_DBS = (
    os.environ.get("MEMORY_DB", os.path.join(DATA, "memory.db")),
    os.environ.get("OPENCODE_RAW_DB", os.path.join(DATA, "opencode_raw.db")),
)


def wal_bytes(path):
    try:
        return os.path.getsize(path + "-wal")
    except FileNotFoundError:
        return 0


def truncate(path):
    """Return a result dict; never raises for SQLite errors or a missing file."""
    out = {"db": os.path.basename(path), "wal_before": wal_bytes(path)}
    started = time.monotonic()
    if not os.path.exists(path):
        out["skipped"] = "missing"
        return out
    con = None
    try:
        con = sqlite3.connect(path, timeout=0, isolation_level=None)
        con.execute("PRAGMA busy_timeout=0")
        mode = con.execute("PRAGMA journal_mode").fetchone()[0]
        if mode.lower() != "wal":
            out["skipped"] = f"journal_mode={mode}"
            return out
        busy, log, done = con.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        out["passive"] = [busy, log, done]
        if busy == 0 and log == done:
            busy, log, done = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            out["truncate"] = [busy, log, done]
            out["truncated"] = busy == 0
        else:
            out["truncated"] = False
            out["reason"] = "busy" if busy else "frames pinned by a reader"
    except sqlite3.Error as exc:
        out["truncated"] = False
        out["error"] = str(exc)
    finally:
        if con is not None:
            con.close()
        out["wal_after"] = wal_bytes(path)
        out["secs"] = round(time.monotonic() - started, 2)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dbs", nargs="*", help="databases (default: memory.db and opencode_raw.db)")
    args = ap.parse_args(argv)
    for path in args.dbs or DEFAULT_DBS:
        print("WAL " + json.dumps(truncate(path)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
