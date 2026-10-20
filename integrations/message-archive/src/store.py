"""The index database: one `items` row per message plus an external-content FTS5 index."""
import contextlib
import json
import os
import sqlite3
import threading
import time

import common


class FairLock:
    """FIFO lock. SQLite's own busy wait polls, so a thread that commits and starts again at once
    can starve the others for minutes; the daemon's sync threads take turns through this instead."""

    def __init__(self):
        self._cv = threading.Condition()
        self._next = 0
        self._serving = 0

    def acquire(self):
        with self._cv:
            ticket = self._next
            self._next += 1
            while ticket != self._serving:
                self._cv.wait()

    def release(self):
        with self._cv:
            self._serving += 1
            self._cv.notify_all()


WRITE = FairLock()


@contextlib.contextmanager
def writing(db):
    """One write transaction, serialized with the other threads in this process. Commits on exit."""
    WRITE.acquire()
    try:
        if db.in_transaction:
            db.commit()
        # Take the write lock up front: a deferred transaction that upgrades from a stale read
        # snapshot fails with "database is locked" at once instead of waiting.
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
    finally:
        WRITE.release()

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,            -- email | imessage | whatsapp
  account TEXT NOT NULL,           -- mail account name, or the chat source
  ext_id TEXT NOT NULL,            -- stable id inside the source
  msgid TEXT,                      -- RFC822 Message-ID (email), used to fold copies in several folders
  conv TEXT,                       -- thread / chat id
  conv_name TEXT,
  ts INTEGER NOT NULL,             -- unix seconds
  from_me INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  sender_addr TEXT,
  recipients TEXT,
  subject TEXT,
  body TEXT,
  folders TEXT,                    -- folder or label names, space separated
  attachments TEXT,
  path TEXT,                       -- raw .eml.zst under the archive root (email only)
  size INTEGER,
  junk INTEGER NOT NULL DEFAULT 0,  -- spam / junk folder
  deleted_at INTEGER,              -- gone from the source; the archive keeps it
  updated_at INTEGER NOT NULL,
  UNIQUE(source, account, ext_id)
);
CREATE INDEX IF NOT EXISTS items_ts ON items(ts);
CREATE INDEX IF NOT EXISTS items_conv ON items(source, conv, ts);
CREATE INDEX IF NOT EXISTS items_msgid ON items(msgid);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  subject, body, sender, recipients, conv_name, attachments,
  content='items', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, subject, body, sender, recipients, conv_name, attachments)
  VALUES (new.id, new.subject, new.body, new.sender, new.recipients, new.conv_name, new.attachments);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, subject, body, sender, recipients, conv_name, attachments)
  VALUES ('delete', old.id, old.subject, old.body, old.sender, old.recipients, old.conv_name, old.attachments);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF subject, body, sender, recipients, conv_name, attachments ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, subject, body, sender, recipients, conv_name, attachments)
  VALUES ('delete', old.id, old.subject, old.body, old.sender, old.recipients, old.conv_name, old.attachments);
  INSERT INTO items_fts(rowid, subject, body, sender, recipients, conv_name, attachments)
  VALUES (new.id, new.subject, new.body, new.sender, new.recipients, new.conv_name, new.attachments);
END;
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
"""

FIELDS = ("source", "account", "ext_id", "msgid", "conv", "conv_name", "ts", "from_me", "sender",
          "sender_addr", "recipients", "subject", "body", "folders", "attachments", "path", "size",
          "junk", "deleted_at")
TEXT_FIELDS = ("conv_name", "sender", "recipients", "subject", "body", "attachments")
MAX_BODY = 100_000


def connect(readonly=False):
    if readonly:
        if not os.path.exists(common.DB_PATH):
            raise common.NotMounted(f"no archive at {common.DB_PATH} (is {common.VOLUME} mounted?)")
        db = sqlite3.connect(f"file:{common.DB_PATH}?mode=ro", uri=True, timeout=30)
    else:
        common.require_volume()
        db = sqlite3.connect(common.DB_PATH, timeout=60)
        db.execute("PRAGMA busy_timeout=60000")
        # FTS5 segment merges reread big parts of the index; the 2 MB default cache turns every
        # merge into a stream of small reads and spills on the USB disk.
        db.execute("PRAGMA cache_size=-131072")
        db.execute("PRAGMA mmap_size=1073741824")
        WRITE.acquire()
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(SCHEMA)
        finally:
            WRITE.release()
    db.execute("PRAGMA busy_timeout=60000")
    db.row_factory = sqlite3.Row
    return db


def _clean(item):
    row = {k: item.get(k) for k in FIELDS}
    body = row.get("body") or ""
    row["body"] = body[:MAX_BODY]
    for k in TEXT_FIELDS:
        if row[k] is not None:
            row[k] = str(row[k]).replace("\x00", "")
    row["from_me"] = int(bool(row.get("from_me")))
    row["junk"] = int(bool(row.get("junk")))
    row["ts"] = int(row.get("ts") or 0)
    return row


def upsert(db, item):
    """Insert or update one message. Rewrites the FTS row only when indexed text changed."""
    row = _clean(item)
    now = int(time.time())
    cur = db.execute("SELECT id, " + ", ".join(FIELDS[3:]) + " FROM items WHERE source=? AND account=? AND ext_id=?",
                     (row["source"], row["account"], row["ext_id"])).fetchone()
    if cur is None:
        cols = FIELDS + ("updated_at",)
        db.execute(f"INSERT INTO items({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   tuple(row[k] for k in FIELDS) + (now,))
        return "added"
    changed = [k for k in FIELDS[3:] if row[k] != cur[k]]
    # A message that disappeared from the source keeps its archived text: never blank it out.
    for k in ("body", "subject", "attachments"):
        if k in changed and not row[k] and cur[k]:
            changed.remove(k)
    if not changed:
        return "same"
    db.execute(f"UPDATE items SET {', '.join(f'{k}=?' for k in changed)}, updated_at=? WHERE id=?",
               tuple(row[k] for k in changed) + (now, cur["id"]))
    return "updated"


def mark_deleted(db, source, account, ext_ids, when=None):
    when = int(when or time.time())
    n = 0
    for ext in ext_ids:
        n += db.execute("UPDATE items SET deleted_at=?, updated_at=? WHERE source=? AND account=? AND ext_id=? "
                        "AND deleted_at IS NULL", (when, when, source, account, ext)).rowcount
    return n


def undelete(db, source, account, ext_ids):
    """Clear deleted_at on rows the source lists again (a bad listing or a message moved back)."""
    when = int(time.time())
    n = 0
    for ext in ext_ids:
        n += db.execute("UPDATE items SET deleted_at=NULL, updated_at=? WHERE source=? AND account=? AND ext_id=? "
                        "AND deleted_at IS NOT NULL", (when, source, account, ext)).rowcount
    return n


def deleted_ext_ids(db, source, account, prefix=None):
    sql = "SELECT ext_id FROM items WHERE source=? AND account=? AND deleted_at IS NOT NULL"
    args = (source, account)
    if prefix:
        sql += " AND ext_id >= ? AND ext_id < ?"
        args += (prefix, prefix + "\U0010ffff")
    return {r[0] for r in db.execute(sql, args)}


def get_state(db, key, default=None):
    r = db.execute("SELECT value FROM sync_state WHERE key=?", (key,)).fetchone()
    if r is None or r[0] is None:
        return default
    try:
        return json.loads(r[0])
    except ValueError:
        return default


def set_state(db, key, value):
    db.execute("INSERT INTO sync_state(key, value, updated_at) VALUES (?, ?, ?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
               (key, json.dumps(value), int(time.time())))


def known_ext_ids(db, source, account, prefix=None):
    if prefix:
        rows = db.execute("SELECT ext_id FROM items WHERE source=? AND account=? AND ext_id >= ? AND ext_id < ?",
                          (source, account, prefix, prefix + "\U0010ffff"))
    else:
        rows = db.execute("SELECT ext_id FROM items WHERE source=? AND account=?", (source, account))
    return {r[0] for r in rows}
