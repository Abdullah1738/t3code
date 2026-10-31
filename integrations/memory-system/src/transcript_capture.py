"""Shared checkpointed capture for native transcripts (Claude, Codex).

Two tables sit in memory.db:
  native_capture_files  one ledger row per (path, inode) representation: the
                        byte offset of the last complete line consumed, a
                        sha1 of the first 4 KB, size, mtime and quarantine
                        state.
  native_capture_raw    append-only journal of every complete line read, raw
                        bytes, never clipped. Projection can be re-derived
                        from it, and it is what the backup keeps.

Rules: only complete (newline-terminated) lines are consumed. A changed head,
an inode change or a size below the offset starts a NEW representation row
(new id, offset 0); earlier events and raw lines are never deleted. A file
that errors is quarantined for QUARANTINE_SECS and the other files continue.
Each file batch commits events, raw lines and the ledger in one transaction.
"""

import hashlib
import os
import sqlite3
import time

HEAD_BYTES = 4096
QUARANTINE_SECS = 600
BATCH_BYTES = 8 << 20

DDL = """
CREATE TABLE IF NOT EXISTS native_capture_files(
  rep_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  inode INTEGER,
  head_len INTEGER NOT NULL DEFAULT 0,
  head_sha1 TEXT,
  offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  mtime REAL,
  last_ok_at INTEGER,
  error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  quarantined_until INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS native_capture_files_path ON native_capture_files(path, retired, rep_id);
CREATE TABLE IF NOT EXISTS native_capture_raw(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  rep_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS native_capture_raw_path ON native_capture_raw(path, line_no);
"""


def head_sha1(path, length):
    """sha1 of the first `length` bytes (length = min(size at creation, HEAD_BYTES))."""
    with open(path, "rb") as f:
        return hashlib.sha1(f.read(length)).hexdigest()


def ensure_schema(con):
    con.executescript(DDL)


def _same_head(path, row):
    """True when the file still starts with the bytes the representation was identified by."""
    n = row["head_len"]
    if n == 0:
        return True
    try:
        return os.path.getsize(path) >= n and head_sha1(path, n) == row["head_sha1"]
    except OSError:
        return False


def open_representation(con, path, st, now=None):
    """Return the ledger row (dict) for the file's current representation.

    The live row is reused while the inode matches, the head bytes it was
    identified by are unchanged and the file has not shrunk below its offset.
    Anything else starts a NEW row at offset 0 and retires the old one; the old
    row, its events and its raw lines stay (history is never deleted).
    """
    cols = ("rep_id", "head_len", "head_sha1", "offset", "size", "mtime", "last_ok_at", "error",
            "error_count", "quarantined_until", "inode")
    rows = con.execute(
        f"SELECT {','.join(cols)} FROM native_capture_files WHERE path=? AND retired=0 ORDER BY rep_id DESC",
        (path,),
    ).fetchall()
    for r in rows:
        row = dict(zip(cols, r))
        if row["inode"] == st.st_ino and row["offset"] <= st.st_size and _same_head(path, row):
            return row
    if rows:
        con.execute("UPDATE native_capture_files SET retired=1 WHERE path=? AND retired=0", (path,))
    head_len = min(st.st_size, HEAD_BYTES)
    head = head_sha1(path, head_len)
    cur = con.execute(
        "INSERT INTO native_capture_files(path, inode, head_len, head_sha1, offset, size, mtime)"
        " VALUES(?,?,?,?,0,?,?)",
        (path, st.st_ino, head_len, head, st.st_size, st.st_mtime),
    )
    return dict(rep_id=cur.lastrowid, head_len=head_len, head_sha1=head, offset=0, size=None, mtime=None,
                last_ok_at=None, error=None, error_count=0, quarantined_until=0, inode=st.st_ino)


def read_complete_lines(path, offset, max_bytes=BATCH_BYTES):
    """Yield (line_bytes, end_offset) for complete lines after offset, up to max_bytes.

    A final line without a newline is not returned: the writer is still on it.
    """
    with open(path, "rb") as f:
        f.seek(offset)
        pos = offset
        budget = max_bytes
        while budget > 0:
            line = f.readline()
            if not line.endswith(b"\n"):
                return
            pos += len(line)
            budget -= len(line)
            yield line, pos


def raw_sha1(line):
    return hashlib.sha1(line).hexdigest()


def quarantined(con, path, now=None):
    now = int(time.time()) if now is None else now
    row = con.execute(
        "SELECT max(quarantined_until) FROM native_capture_files WHERE path=? AND retired=0", (path,)
    ).fetchone()
    return bool(row and row[0] and row[0] > now)


def record_error(con, rep_id, message, now=None):
    now = int(time.time()) if now is None else now
    con.execute(
        "UPDATE native_capture_files SET error=?, error_count=error_count+1, quarantined_until=?"
        " WHERE rep_id=?",
        (str(message)[:500], now + QUARANTINE_SECS, rep_id),
    )


def record_ok(con, rep_id, offset, size, mtime, now=None):
    now = int(time.time()) if now is None else now
    con.execute(
        "UPDATE native_capture_files SET offset=?, size=?, mtime=?, last_ok_at=?, error=NULL,"
        " error_count=0, quarantined_until=0 WHERE rep_id=?",
        (offset, size, mtime, now, rep_id),
    )


def ensure_file(path):
    """Filesystem check used by callers: True if the path exists and is a regular file."""
    return os.path.isfile(path)
