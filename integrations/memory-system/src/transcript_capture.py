"""Shared checkpointed capture for native transcripts (Claude, Codex).

Two tables sit in memory.db:
  native_capture_files  one ledger row per representation of a logical
                        transcript: the logical byte offset consumed (uncompressed
                        bytes for .zst), the physical size at the last pass, the
                        head sha1 that identifies the representation, quarantine
                        state.
  native_capture_raw    append-only journal of every complete line read, as BLOB
                        (exact bytes; nothing decoded, clipped or replaced).

Identity: a transcript is keyed by its logical name (the file name with a
trailing .zst removed) under its root, so an archive move or a .jsonl ->
.jsonl.zst conversion keeps the same identity. A physical file change that is
not an append (inode change, head bytes changed, logical size below the offset)
starts a NEW representation row at offset 0; old rows, their events and their
raw lines are never deleted.

Only complete (newline-terminated) lines are consumed. A file that errors is
quarantined for QUARANTINE_SECS and the other files continue. Each file batch
commits its events, raw lines and ledger in one transaction.
"""

import hashlib
import os
import sqlite3
import time

HEAD_BYTES = 4096
TAIL_BYTES = 4096
QUARANTINE_SECS = 600
BATCH_BYTES = 8 << 20
ZST = ".zst"

DDL = """
CREATE TABLE IF NOT EXISTS native_capture_files(
  rep_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  logical TEXT NOT NULL,
  inode INTEGER,
  head_len INTEGER NOT NULL DEFAULT 0,
  head_sha1 TEXT,
  tail_sha1 TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  phys_size INTEGER,
  mtime REAL,
  lines INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_since INTEGER,
  instance TEXT,
  session_key TEXT,
  quarantined_until INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS native_capture_files_path ON native_capture_files(path, retired, rep_id);
CREATE INDEX IF NOT EXISTS native_capture_files_logical ON native_capture_files(logical, retired, rep_id);
CREATE TABLE IF NOT EXISTS native_capture_raw(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  rep_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  raw BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS native_capture_raw_rep ON native_capture_raw(rep_id, line_no);
CREATE TABLE IF NOT EXISTS native_capture_roots(
  instance TEXT NOT NULL,
  root TEXT NOT NULL,
  last_pass_at INTEGER NOT NULL,
  files INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY(instance, root)
);
"""


def logical_name(path, root=None):
    """Identity of one transcript across archive moves and compression, qualified by its location.

    Keyed by the path relative to its root, with only the representation changes
    normalized: a trailing .zst is dropped, and the sessions/ and archived_sessions/
    trees (Codex) are treated as one. Two files that share a basename but sit under
    different parents or homes (agent-X.jsonl under two sessions, the same name in two
    configured roots) keep distinct identities, so one never retires or quarantines
    the other. Without a root the path is used as given.
    """
    rel = os.path.relpath(path, root) if root else path
    if rel.endswith(ZST):
        rel = rel[: -len(ZST)]
    parts = rel.split(os.sep)
    if parts and parts[0] == "archived_sessions":
        parts[0] = "sessions"  # archive moves keep the same transcript identity
    return os.sep.join(parts)


def seed_stem(path):
    """Identity used to match seeded (transplanted) ranges, independent of directory and compression.

    The file stem of the rollout: 'rollout-X' for rollout-X.jsonl, rollout-X.jsonl.zst and a copy
    moved between sessions/ and archived_sessions/. Both the manifest and the live file go through
    this same function, so the two sides cannot normalise differently.
    """
    base = os.path.basename(path)
    for ext in (ZST, ".jsonl"):
        if base.endswith(ext):
            base = base[: -len(ext)]
    return base


def seed_identity(path, roots):
    """(home realpath, rollout stem) of a transcript, or None when no given home contains it.

    Seeded ranges are matched on this identity from both sides: the manifest entry and the live
    file. The home part keeps two homes that hold a rollout with the same stem apart; the stem part
    keeps a rollout that moved between sessions/ and archived_sessions/, or was compressed, on the
    same identity.
    """
    real = os.path.realpath(path)
    for r in roots:
        base = os.path.realpath(r["path"])
        if real.startswith(base + os.sep):
            return (base, seed_stem(path))
    return None


def zstd_bin():
    import shutil

    return os.environ.get("ZSTD_BIN") or shutil.which("zstd")


def decompressed_head(path, length):
    """First `length` decompressed bytes of a .zst transcript (zstd -dc, stops early)."""
    import subprocess

    zstd = zstd_bin()
    if not zstd:
        raise FileNotFoundError("zstd missing")
    p = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        data = p.stdout.read(length)
    finally:
        p.stdout.close()
        p.kill()
        p.wait()
    return data


def head_sha1(path, length):
    """sha1 of the first `length` bytes of the LOGICAL transcript (decompressed for .zst).

    Plain and compressed copies of one transcript share a logical head, so an
    archive move or a .jsonl -> .jsonl.zst conversion keeps the representation.
    """
    if path.endswith(ZST):
        return hashlib.sha1(decompressed_head(path, length)).hexdigest()
    with open(path, "rb") as f:
        return hashlib.sha1(f.read(length)).hexdigest()


def ensure_schema(con):
    con.executescript(DDL)
    # A ledger created by the previous round lacks tail_sha1; add it in place (nullable, safe).
    cols = {r[1] for r in con.execute("PRAGMA table_info(native_capture_files)")}
    if "tail_sha1" not in cols:
        con.execute("ALTER TABLE native_capture_files ADD COLUMN tail_sha1 TEXT")
    # complete = 1 only when the pass that committed it reached the end of the stream. A .zst
    # checkpoint from a killed pass has complete = 0 and must not take the unchanged shortcut.
    if "complete" not in cols:
        con.execute("ALTER TABLE native_capture_files ADD COLUMN complete INTEGER NOT NULL DEFAULT 0")
    for name, sql_type in (("error_since", "INTEGER"), ("instance", "TEXT"), ("session_key", "TEXT")):
        if name not in cols:
            con.execute(f"ALTER TABLE native_capture_files ADD COLUMN {name} {sql_type}")


_COLS = ("rep_id", "path", "head_len", "head_sha1", "tail_sha1", "complete", "offset", "phys_size", "mtime", "lines", "last_ok_at",
         "error", "error_count", "error_since", "quarantined_until", "inode", "instance", "session_key")


def _same_representation(row, path, st):
    """True when the stored representation still describes this physical file.

    Plain files: the inode must match, the head bytes must match, the file must not
    have shrunk, and the bytes already consumed (the tail window before the offset)
    must match the stored checksum. An append keeps all of these; an in-place rewrite
    changes the head or the consumed tail (equal size included).
    A rewrite that changes only bytes outside both windows is not detected by this
    check; the head/tail windows bound the cost to O(1) per tick for each file.
    A .zst conversion must match the consumed tail as well as the logical head.
    """
    if not path.endswith(ZST):
        if row["inode"] is not None and row["inode"] != st.st_ino:
            return False
        if row.get("tail_sha1") and row["offset"]:
            try:
                if tail_sha1(path, row["offset"]) != row["tail_sha1"]:
                    return False  # consumed bytes changed in place (equal size or not)
            except OSError:
                return False
    elif row.get("offset") and row.get("tail_sha1"):
        try:
            if compressed_tail_sha1(path, row["offset"]) != row["tail_sha1"]:
                return False
        except OSError:
            return False
    return _matches(row, path, st)


def tail_sha1(path, offset):
    """sha1 of the last TAIL_BYTES bytes before `offset` (the consumed, complete part of a plain file)."""
    start = max(0, offset - TAIL_BYTES)
    with open(path, "rb") as f:
        f.seek(start)
        return hashlib.sha1(f.read(offset - start)).hexdigest()


def compressed_tail_sha1(path, offset):
    """Hash the consumed tail of a compressed stream; None if the checkpoint is past EOF."""
    import subprocess

    zstd = zstd_bin()
    if not zstd:
        raise FileNotFoundError("zstd missing")
    proc = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    tail, remaining = b"", offset
    try:
        while remaining:
            block = proc.stdout.read(min(65536, remaining))
            if not block:
                return None
            remaining -= len(block)
            tail = (tail + block)[-TAIL_BYTES:]
        return hashlib.sha1(tail).hexdigest()
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def compressed_equals_plain(compressed, plain):
    """True only when both simultaneously readable representations have the same bytes."""
    import subprocess

    zstd = zstd_bin()
    if not zstd:
        return False
    proc = None
    try:
        with open(plain, "rb") as f:
            before = os.fstat(f.fileno())
            compressed_before = os.stat(compressed)
            proc = subprocess.Popen([zstd, "-dc", compressed], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            while True:
                block = proc.stdout.read(65536)
                if not block:
                    break
                if block != f.read(len(block)):
                    return False
            if f.read(1) or proc.wait() != 0:
                return False
            after = os.fstat(f.fileno())
            compressed_after = os.stat(compressed)
            signature = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
            return signature(before) == signature(after) and signature(compressed_before) == signature(compressed_after)
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        if proc:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
            proc.wait()


def _matches(row, path, st):
    """A stored representation still describes this transcript: same logical head, not shrunk."""
    if row["head_len"]:
        try:
            if head_sha1(path, row["head_len"]) != row["head_sha1"]:
                return False
        except (OSError, FileNotFoundError):
            return False
    if row["phys_size"] is not None and st.st_size < row["phys_size"] and not path.endswith(ZST):
        return False  # plain file shrank: a rewrite, not an append
    return row["offset"] <= _logical_bytes(path, st)


def _logical_bytes(path, st):
    """Upper bound for the logical byte offset: physical size for plain files, unbounded for .zst."""
    return st.st_size if not path.endswith(ZST) else 1 << 62


def open_representation(con, path, st, now=None, key=None, instance=None):
    """Return the live ledger row (dict) for this transcript's current representation.

    The row is keyed by the logical transcript (see logical_name). A plain file
    and its .zst copy share it; a rewrite (head changed, plain file shrank) or an
    inode change retires the old row and starts a new one at offset 0. The old
    row, its events and its raw lines stay.
    """
    logical = key or logical_name(path)
    rows = con.execute(
        f"SELECT {','.join(_COLS)} FROM native_capture_files WHERE logical=? AND retired=0 ORDER BY rep_id DESC",
        (logical,),
    ).fetchall()
    for r in rows:
        row = dict(zip(_COLS, r))
        if _same_representation(row, path, st):
            if row["path"] != path or (instance is not None and row["instance"] != instance):
                con.execute("UPDATE native_capture_files SET path=?, instance=coalesce(?,instance) WHERE rep_id=?",
                            (path, instance, row["rep_id"]))
                row["path"] = path
                if instance is not None:
                    row["instance"] = instance
            return row
    if rows:
        con.execute("UPDATE native_capture_files SET retired=1 WHERE logical=? AND retired=0", (logical,))
    head_len = min(st.st_size, HEAD_BYTES) if not path.endswith(ZST) else HEAD_BYTES
    head = head_sha1(path, head_len)
    cur = con.execute(
        "INSERT INTO native_capture_files(path, logical, inode, head_len, head_sha1, offset, phys_size, mtime, instance)"
        " VALUES(?,?,?,?,?,0,?,?,?)",
        (path, logical, st.st_ino, head_len, head, st.st_size, st.st_mtime, instance),
    )
    return dict(rep_id=cur.lastrowid, path=path, head_len=head_len, head_sha1=head, offset=0, phys_size=None, mtime=None,
                lines=0, last_ok_at=None, error=None, error_count=0, error_since=None, quarantined_until=0,
                inode=st.st_ino, instance=instance, session_key=None)


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


def quarantined(con, logical, now=None):
    now = int(time.time()) if now is None else now
    row = con.execute(
        "SELECT max(quarantined_until) FROM native_capture_files WHERE logical=? AND retired=0", (logical,)
    ).fetchone()
    return bool(row and row[0] and row[0] > now)


def follow_quarantined_move(con, path, logical, instance):
    """Move error evidence with a disappeared pathname, without touching its checkpoint."""
    rows = con.execute("SELECT rep_id,path FROM native_capture_files WHERE logical=? AND retired=0", (logical,)).fetchall()
    if len(rows) == 1 and rows[0][1] != path and not os.path.exists(rows[0][1]):
        con.execute("UPDATE native_capture_files SET path=?, instance=coalesce(instance,?) WHERE rep_id=?",
                    (path, instance, rows[0][0]))


def record_error(con, rep_id, message, now=None):
    """Durable per-file failure: error text, count, and the 10-minute quarantine."""
    now = int(time.time()) if now is None else now
    # Pre-migration error rows have unknown onset; another failure cannot make them younger.
    con.execute(
        "UPDATE native_capture_files SET error=?, error_since=CASE WHEN error_count>0 AND error_since IS NULL"
        " THEN NULL ELSE coalesce(error_since,?) END, error_count=error_count+1, quarantined_until=?"
        " WHERE rep_id=?",
        (str(message)[:500], now, now + QUARANTINE_SECS, rep_id),
    )


def record_ok(con, rep_id, offset, phys_size, mtime, lines, now=None, tail=None, complete=False, inode=None,
              instance=None, session_key=None, clear_error=True):
    """Commit one batch: the offset consumed, the physical identity it was read from, and the checksums.

    `tail` is the tail checksum at `offset` (plain files), the value the next pass verifies.
    `complete` is True only for the batch that reached the end of the stream. Every other batch
    writes False, so a pass killed partway never leaves a checkpoint that looks finished. `inode`
    restamps the identity when a file became a different representation under the same logical name.
    """
    now = int(time.time()) if now is None else now
    con.execute(
        "UPDATE native_capture_files SET offset=?, phys_size=?, mtime=?, lines=?, last_ok_at=?,"
        " error=CASE WHEN ? THEN NULL ELSE error END,"
        " error_count=CASE WHEN ? THEN 0 ELSE error_count END,"
        " error_since=CASE WHEN ? THEN NULL ELSE error_since END,"
        " quarantined_until=CASE WHEN ? THEN 0 ELSE quarantined_until END,"
        " tail_sha1=coalesce(?, tail_sha1), inode=coalesce(?, inode),"
        " instance=coalesce(?,instance), session_key=coalesce(?,session_key),"
        " complete=CASE WHEN ? THEN 1 ELSE 0 END WHERE rep_id=?",
        (offset, phys_size, mtime, lines, now, clear_error, clear_error, clear_error, clear_error,
         tail, inode, instance, session_key, 1 if complete else 0, rep_id),
    )


def merge_session_key(current, observed):
    """An empty key marks conflicting identities and is never a resolvable session."""
    if not isinstance(observed, str) or not observed:
        return current
    if current is None:
        return observed
    return current if current == observed else ""


def record_root_pass(con, instance, root, files, errors, now=None):
    now = int(time.time()) if now is None else now
    con.execute(
        "INSERT INTO native_capture_roots(instance,root,last_pass_at,files,errors) VALUES(?,?,?,?,?)"
        " ON CONFLICT(instance,root) DO UPDATE SET last_pass_at=excluded.last_pass_at,"
        " files=excluded.files, errors=excluded.errors",
        (instance, os.path.realpath(root), now, files, errors),
    )
