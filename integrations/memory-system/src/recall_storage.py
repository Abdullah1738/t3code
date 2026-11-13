"""Cold transcript journal and bounded, restartable hot recall projection.

Only the offline migration installs the journal on an existing store. Search
workers never write cold storage, and indexing never opens a long read snapshot.
The journal is deliberately retained: pruning it needs a consumer-retention policy.
"""

import json
import math
import os
from pathlib import Path
import sqlite3
import time
import uuid

from robob_readonly import safe_path


EVENT_COLUMNS = (
    "id", "source", "session_id", "turn_id", "timestamp", "speaker", "content",
    "content_type", "model", "tokens_used", "metadata_json", "content_fts",
)
EXCERPT_CHARS = 8192
METADATA_CHARS = 8192
BATCH_ROWS = 100
PAGE_CHARS = 2_000_000  # One larger event still has to be read/indexed whole.
JOURNAL_TRIGGERS = ("recall_events_insert", "recall_events_update", "recall_events_delete")


def read_rows(con, sql, params=()):
    cursor = con.execute(sql, params)
    try:
        return cursor.fetchall()
    finally:
        cursor.close()


def connect_reader(path):
    con = sqlite3.connect(safe_path(path).as_uri() + "?mode=ro", uri=True,
                          timeout=0.1, isolation_level=None)
    con.execute("PRAGMA query_only=ON")
    con.execute("PRAGMA busy_timeout=100")
    con.execute("PRAGMA cache_size=-8192")
    return con


def configure_writer(con, busy_ms=250):
    """Call outside a transaction; capture owns when its commits happen."""
    con.execute(f"PRAGMA busy_timeout={int(busy_ms)}")
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA wal_autocheckpoint=0")
    con.execute("PRAGMA recursive_triggers=ON")
    con.execute("PRAGMA cache_size=-8192")


def checkpoint(con, truncate=False):
    """A busy reader is reported, not waited out; never call within a write txn."""
    if con.in_transaction:
        raise ValueError("checkpoint requires a committed writer")
    previous = read_rows(con, "PRAGMA busy_timeout")[0][0]
    con.execute("PRAGMA busy_timeout=0")
    try:
        busy, frames, checkpointed = read_rows(
            con, "PRAGMA wal_checkpoint(" + ("TRUNCATE" if truncate else "PASSIVE") + ")"
        )[0]
        return {"busy": busy, "frames": frames, "checkpointed": checkpointed}
    finally:
        con.execute(f"PRAGMA busy_timeout={previous}")


def install_change_journal(con):
    """Install on the NEW cold copy, or on a synthetic fixture, never the old DB.

    UPDATE includes both ids so an explicit primary-key move removes the old hit.
    Writer connections should enable recursive_triggers for REPLACE's implicit delete.
    """
    con.execute("SAVEPOINT recall_journal_setup")
    try:
        con.execute("CREATE TABLE IF NOT EXISTS recall_store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.execute("INSERT OR IGNORE INTO recall_store_meta VALUES('store_uuid',?)", (str(uuid.uuid4()),))
        con.execute("INSERT OR IGNORE INTO recall_store_meta VALUES('journal_version','1')")
        con.execute("""CREATE TABLE IF NOT EXISTS recall_event_changes(
            seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL)""")
        con.execute("""CREATE TRIGGER IF NOT EXISTS recall_events_insert AFTER INSERT ON episodic_events BEGIN
            INSERT INTO recall_event_changes(event_id) VALUES(new.id); END""")
        con.execute("""CREATE TRIGGER IF NOT EXISTS recall_events_delete AFTER DELETE ON episodic_events BEGIN
            INSERT INTO recall_event_changes(event_id) VALUES(old.id); END""")
        con.execute("""CREATE TRIGGER IF NOT EXISTS recall_events_update AFTER UPDATE ON episodic_events BEGIN
            INSERT INTO recall_event_changes(event_id) VALUES(old.id);
            INSERT INTO recall_event_changes(event_id) SELECT new.id WHERE new.id != old.id; END""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_episodic_session_timestamp ON episodic_events(session_id,timestamp,id)")
        con.execute("RELEASE recall_journal_setup")
    except BaseException:
        con.execute("ROLLBACK TO recall_journal_setup")
        con.execute("RELEASE recall_journal_setup")
        raise


def connect_cold_writer(path):
    """Open an already migrated store without implicitly changing its schema."""
    path = safe_path(path)
    con = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True,
                          timeout=0.25, isolation_level=None)
    try:
        _source_identity(con, path)
        configure_writer(con)
        return con
    except BaseException:
        con.close()
        raise


def _source_identity(con, path):
    try:
        meta = dict(read_rows(con, "SELECT key,value FROM recall_store_meta"))
        triggers = {r[0] for r in read_rows(con, "SELECT name FROM sqlite_master WHERE type='trigger'")}
        if meta.get("journal_version") != "1" or not meta.get("store_uuid") or not set(JOURNAL_TRIGGERS) <= triggers:
            raise ValueError("cold store has no complete recall change journal; migrate offline first")
        if read_rows(con, "SELECT 1 FROM sqlite_master WHERE name='recall_migration_state'"):
            if read_rows(con, "SELECT ready FROM recall_migration_state WHERE singleton=1") != [(1,)]:
                raise ValueError("cold store migration is not ready")
        read_rows(con, "SELECT seq,event_id FROM recall_event_changes LIMIT 0")
    except sqlite3.DatabaseError as exc:
        raise ValueError("cold store has no recall change journal; migrate offline first") from exc
    st = os.stat(path)
    return json.dumps([str(Path(path).resolve()), st.st_dev, st.st_ino, meta["store_uuid"]])


def _separate_paths(source, target):
    if Path(source).resolve() == Path(target).resolve() or (
        Path(target).exists() and os.path.samefile(source, target)
    ):
        raise ValueError("source and target must be different files, not aliases")


def _setup_hot(con, identity):
    if sqlite3.sqlite_version_info < (3, 47, 0):
        raise RuntimeError("hot recall storage requires SQLite >= 3.47 (contentless_unindexed)")
    con.execute("BEGIN IMMEDIATE")
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS recall_index_state(
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
            source_identity TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0,
            change_seq INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL,
            source_max_id INTEGER NOT NULL DEFAULT 0, source_change_seq INTEGER NOT NULL DEFAULT 0,
            observed_at REAL, checkpoint_at REAL, checkpoint_busy INTEGER,
            checkpoint_frames INTEGER, checkpointed_frames INTEGER)""")
        state = read_rows(con, "SELECT version,source_identity FROM recall_index_state WHERE singleton=1")
        if state and state[0] != (1, identity):
            raise ValueError("hot index belongs to another cold store or schema version; use a new index path")
        if not state:
            if read_rows(con, "SELECT 1 FROM sqlite_master WHERE name='episodic_events'"):
                raise ValueError("refusing to adopt an existing unrecognized event database as a hot index")
            con.execute("""INSERT INTO recall_index_state(singleton,version,source_identity,last_id,change_seq,updated_at)
                        VALUES(1,1,?,0,0,?)""", (identity, time.time()))
        con.execute("""CREATE TABLE IF NOT EXISTS episodic_events(
            id INTEGER PRIMARY KEY, source TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT,
            timestamp INTEGER NOT NULL, speaker TEXT NOT NULL, content TEXT NOT NULL,
            content_type TEXT NOT NULL, model TEXT, tokens_used INTEGER, metadata_json TEXT,
            content_fts TEXT, UNIQUE(source,session_id,turn_id))""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_episodic_session_timestamp ON episodic_events(session_id,timestamp,id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_recall_source_session ON episodic_events(source,session_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_recall_timestamp ON episodic_events(timestamp)")
        con.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
            content, content='', contentless_delete=1)""")
        con.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS episodic_text_fts USING fts5(
            content, source UNINDEXED, session_id UNINDEXED, speaker UNINDEXED, ts UNINDEXED,
            content='', contentless_delete=1, contentless_unindexed=1)""")
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def _check_hot_destination(con, identity):
    names = {r[0] for r in read_rows(con, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if not names:
        return
    if "recall_index_state" not in names:
        raise ValueError("hot destination is not an existing recall index; use a new index path")
    if read_rows(con, "SELECT version,source_identity FROM recall_index_state WHERE singleton=1") != [(1, identity)]:
        raise ValueError("hot index belongs to another cold store or schema version; use a new index path")


def index_health(index_path):
    """Read durable progress without opening cold storage or starting index work."""
    con = connect_reader(index_path)
    try:
        cursor = con.execute("SELECT * FROM recall_index_state WHERE singleton=1")
        try:
            row = cursor.fetchone()
            if row is None:
                raise ValueError("hot index has no state")
            result = dict(zip((c[0] for c in cursor.description), row))
        finally:
            cursor.close()
        result["caught_up"] = result["last_id"] >= result["source_max_id"] and result["change_seq"] >= result["source_change_seq"]
        result["id_backlog"] = max(0, result["source_max_id"] - result["last_id"])
        result["change_backlog"] = max(0, result["source_change_seq"] - result["change_seq"])
        return result
    finally:
        con.close()


def _event_page(con, last_id, hi, limit):
    cursor = con.execute("SELECT " + ",".join(EVENT_COLUMNS) +
                         " FROM episodic_events WHERE id>? AND id<=? ORDER BY id LIMIT ?", (last_id, hi, limit))
    rows, chars = [], 0
    try:
        for row in cursor:
            rows.append(row)
            chars += len(row[6]) + len(row[10] or "")
            if chars >= PAGE_CHARS:
                break
        return rows
    finally:
        cursor.close()


def _metadata(text):
    if text is None:
        return None
    try:
        def invalid_constant(value):
            raise ValueError("invalid JSON constant: " + value)
        obj = json.loads(text, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError):
        return '{"_recall_invalid_metadata":true}'
    if len(text) <= METADATA_CHARS:
        return text

    def trim(value, depth=0):
        if isinstance(value, str):
            return value[:512]
        if depth >= 3 and isinstance(value, (list, dict)):
            return None
        if isinstance(value, dict):
            return {str(k)[:128]: trim(v, depth + 1) for k, v in list(value.items())[:24]}
        if isinstance(value, list):
            return [trim(v, depth + 1) for v in value[:8]]
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value

    result = {"_recall_truncated": True}
    if isinstance(obj, dict):
        # Small routing fields survive even when a large tool payload precedes them.
        for key, value in sorted(obj.items(), key=lambda item: len(json.dumps(item[1]))):
            candidate = {**result, str(key)[:128]: trim(value)}
            if len(json.dumps(candidate, ensure_ascii=False)) <= METADATA_CHARS:
                result = candidate
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def _remove(con, event_id):
    existed = bool(read_rows(con, "SELECT 1 FROM episodic_events WHERE id=?", (event_id,)))
    for name in ("episodic_fts", "episodic_text_fts", "episodic_events"):
        con.execute(f"DELETE FROM {name} WHERE " + ("id" if name == "episodic_events" else "rowid") + "=?", (event_id,))
    return int(existed)


def _project(con, row):
    event_id, source, sid, turn, ts, speaker, content, kind, model, tokens, metadata, _ = row
    # Reprojection can allocate a new id for an existing turn before its old delete
    # reaches the journal consumer. Clear the old hit as well as the id being replaced.
    for old_id, in read_rows(con, "SELECT id FROM episodic_events WHERE source=? AND session_id=? AND turn_id=?",
                            (source, sid, turn)):
        if old_id != event_id:
            _remove(con, old_id)
    _remove(con, event_id)
    con.execute("INSERT INTO episodic_events VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
                (event_id, source, sid, turn, ts, speaker, content[:EXCERPT_CHARS], kind,
                 model, tokens, _metadata(metadata)))
    con.execute("INSERT INTO episodic_fts(rowid,content) VALUES(?,?)", (event_id, content))
    if kind == "text" and speaker in ("user", "assistant"):
        con.execute("""INSERT INTO episodic_text_fts(rowid,content,source,session_id,speaker,ts)
                    VALUES(?,?,?,?,?,?)""", (event_id, content, source, sid, speaker, ts))


def build_index(source_path, index_path, max_rows=1000, seconds=5.0):
    """Consume bounded cold id/journal pages; index rows and watermarks commit together.

    A zero-row call is a cheap status/initialization call. Time is a cooperative SQL
    deadline, not a hard process limit: one Python string/FTS tokenization may overrun.
    The source journal must not be truncated while this index consumes it.
    """
    if max_rows < 0 or seconds < 0:
        raise ValueError("max_rows and seconds must be nonnegative")
    source_path, index_path = safe_path(source_path), safe_path(index_path)
    _separate_paths(source_path, index_path)
    started = time.monotonic()
    deadline = started + seconds
    source = connect_reader(source_path)
    hot = None
    initialized = False
    stats = {"rows_processed": 0, "rows_indexed": 0, "rows_deleted": 0, "batches": 0, "timed_out": False}
    try:
        identity = _source_identity(source, source_path)
        source_max = read_rows(source, "SELECT coalesce(max(id),0) FROM episodic_events")[0][0]
        journal_max = read_rows(source, "SELECT coalesce(max(seq),0) FROM recall_event_changes")[0][0]
        hot = sqlite3.connect(index_path, timeout=0.25, isolation_level=None)
        _check_hot_destination(hot, identity)
        configure_writer(hot)
        _setup_hot(hot, identity)
        initialized = True
        hot.execute("UPDATE recall_index_state SET source_max_id=?,source_change_seq=?,observed_at=?",
                    (source_max, journal_max, time.time()))
        interrupted = lambda: int(time.monotonic() >= deadline)
        source.set_progress_handler(interrupted, 1000)
        hot.set_progress_handler(interrupted, 1000)
        changes_turn = True
        while stats["rows_processed"] < max_rows and time.monotonic() < deadline:
            hot.execute("BEGIN IMMEDIATE")
            try:
                last_id, change_seq = read_rows(hot, "SELECT last_id,change_seq FROM recall_index_state")[0]
                if change_seq > journal_max:
                    raise ValueError("cold change journal moved backwards; refusing stale projection")
                limit = min(BATCH_ROWS, max_rows - stats["rows_processed"])
                use_changes = change_seq < journal_max and (changes_turn or last_id >= source_max)
                indexed = deleted = 0
                if use_changes:
                    changes = read_rows(source, "SELECT seq,event_id FROM recall_event_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?",
                                        (change_seq, journal_max, limit))
                    if not changes or changes[0][0] != change_seq + 1 or any(
                        second[0] != first[0] + 1 for first, second in zip(changes, changes[1:])
                    ):
                        raise ValueError("cold change journal was pruned before consumption")
                    ids = list(dict.fromkeys(r[1] for r in changes))
                    for event_id in ids:
                        # A page of large tool outputs must not all live in memory.
                        rows = read_rows(source, "SELECT " + ",".join(EVENT_COLUMNS) + " FROM episodic_events WHERE id=?", (event_id,))
                        if rows:
                            _project(hot, rows[0])
                            indexed += 1
                        else:
                            deleted += _remove(hot, event_id)
                    change_seq = changes[-1][0]
                    processed = len(changes)
                elif last_id < source_max:
                    rows = _event_page(source, last_id, source_max, limit)
                    for row in rows:
                        _project(hot, row)
                        indexed += 1
                    last_id = rows[-1][0] if rows else source_max
                    processed = len(rows)
                else:
                    hot.execute("ROLLBACK")
                    break
                hot.execute("UPDATE recall_index_state SET last_id=?,change_seq=?,updated_at=?",
                            (last_id, change_seq, time.time()))
                hot.execute("COMMIT")
                stats["rows_processed"] += processed
                stats["rows_indexed"] += indexed
                stats["rows_deleted"] += deleted
                stats["batches"] += 1
                changes_turn = not use_changes
            except BaseException:
                if hot.in_transaction:
                    hot.execute("ROLLBACK")
                raise
    except sqlite3.OperationalError as exc:
        if "interrupt" not in str(exc).lower() or time.monotonic() < deadline:
            raise
        stats["timed_out"] = True
    finally:
        source.set_progress_handler(None, 0)
        source.close()
        if hot is not None:
            hot.set_progress_handler(None, 0)
            try:
                if hot.in_transaction:
                    hot.execute("ROLLBACK")
                state = read_rows(hot, "SELECT last_id,change_seq,updated_at FROM recall_index_state") if initialized else []
                if state:
                    last_id, change_seq, updated_at = state[0]
                    stats.update(last_id=last_id, change_seq=change_seq, updated_at=updated_at,
                                 source_max_id=source_max, source_change_seq=journal_max,
                                 caught_up=last_id >= source_max and change_seq >= journal_max)
                    stats["checkpoint"] = checkpoint(hot, truncate=True)
                    result = stats["checkpoint"]
                    hot.execute("""UPDATE recall_index_state SET checkpoint_at=?,checkpoint_busy=?,
                                checkpoint_frames=?,checkpointed_frames=?""",
                                (time.time(), result["busy"], result["frames"], result["checkpointed"]))
                    # Flush the small health update too; its result is returned while
                    # durable metadata describes the preceding completed attempt.
                    stats["health_checkpoint"] = checkpoint(hot, truncate=True)
            finally:
                hot.close()
    stats["timed_out"] = stats["timed_out"] or (not stats.get("caught_up", False) and time.monotonic() >= deadline)
    stats["elapsed_seconds"] = time.monotonic() - started
    return stats
