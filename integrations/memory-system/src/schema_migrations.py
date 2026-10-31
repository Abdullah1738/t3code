"""Widen episodic_events.source to accept 'claude' (schema_version 2).

SQLite cannot alter a CHECK constraint, so the table is rebuilt once inside one
transaction: the new table keeps every row id, the indexes and triggers (both
FTS feeds included) are re-created from their stored SQL, and sqlite_sequence
keeps the higher of the old and new counters so a deleted top id is never
reused. Idempotent: a table that already accepts 'claude' is left alone.
An unknown CHECK shape is refused rather than guessed at.

Only the native tailers call migrate(); sync_muse and sync_opencode_v2 keep
their own widening paths.
"""

import re
import sqlite3

TARGET_VERSION = 2
META_DDL = "CREATE TABLE IF NOT EXISTS harness_schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
KNOWN_OLD = ("codex", "hermes", "opencode", "muse")
SOURCE_CHECK = re.compile(r"CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)", re.I)
TABLE_HEAD = re.compile(r"^(\s*CREATE\s+TABLE\s+)(IF\s+NOT\s+EXISTS\s+)?(\"?)episodic_events\3(?=[\s(])", re.I)


class SchemaError(RuntimeError):
    pass


def _table_sql(con):
    row = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_events'").fetchone()
    if not row or not row[0]:
        raise SchemaError("memory.db has no episodic_events table")
    return row[0]


def _allowed(sql):
    """Source values in the CHECK in declared order, or None when there is no CHECK."""
    m = SOURCE_CHECK.search(sql)
    if not m:
        return None
    return [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]


def needs_migration(sql):
    allowed = _allowed(sql)
    if allowed is None:
        return False  # no source CHECK at all: already accepts 'claude'
    if "claude" in allowed:
        return False
    missing = [s for s in KNOWN_OLD if s not in allowed]
    if missing:
        raise SchemaError(
            f"episodic_events source CHECK {allowed} is not a known shape (missing {missing}); refusing to migrate"
        )
    return True


def _set_version(con):
    con.execute(
        "INSERT INTO harness_schema_meta(key, value) VALUES('schema_version', ?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(TARGET_VERSION),),
    )


def _rebuild(con):
    """Rebuild episodic_events with 'claude' in its CHECK. Caller holds no transaction."""
    old_sql = _table_sql(con)
    allowed = _allowed(old_sql) + ["claude"]
    check = "CHECK(source IN (" + ", ".join(f"'{s}'" for s in allowed) + "))"
    new_sql = SOURCE_CHECK.sub(check, old_sql, count=1)
    new_sql = TABLE_HEAD.sub(r"\1episodic_events_new", new_sql, count=1)
    if "'claude'" not in new_sql or "episodic_events_new" not in new_sql:
        raise SchemaError("could not rewrite the episodic_events definition; refusing to migrate")
    objs = con.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name='episodic_events'"
        " AND type IN ('index','trigger') AND sql IS NOT NULL"
    ).fetchall()
    old_seq_row = con.execute("SELECT seq FROM sqlite_sequence WHERE name='episodic_events'").fetchone()
    old_seq = old_seq_row[0] if old_seq_row else 0
    con.execute("BEGIN IMMEDIATE")
    try:
        # Re-check under the write lock: another tailer may have migrated first.
        if not needs_migration(_table_sql(con)):
            con.execute("COMMIT")
            return False
        con.execute(new_sql)
        cols = ", ".join(r[1] for r in con.execute("PRAGMA table_info(episodic_events)"))
        con.execute(f"INSERT INTO episodic_events_new({cols}) SELECT {cols} FROM episodic_events")
        old_n = con.execute("SELECT count(*) FROM episodic_events").fetchone()[0]
        new_n = con.execute("SELECT count(*) FROM episodic_events_new").fetchone()[0]
        if old_n != new_n:
            raise SchemaError(f"row count mismatch during rebuild: {old_n} -> {new_n}")
        con.execute("DROP TABLE episodic_events")
        con.execute("ALTER TABLE episodic_events_new RENAME TO episodic_events")
        for _typ, _name, sql in objs:
            con.execute(sql)
        new_seq = con.execute("SELECT seq FROM sqlite_sequence WHERE name='episodic_events'").fetchone()
        new_seq = new_seq[0] if new_seq else 0
        con.execute("DELETE FROM sqlite_sequence WHERE name='episodic_events'")
        con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES('episodic_events', ?)", (max(old_seq, new_seq),))
        _set_version(con)
        if not needs_migration(_table_sql(con)) and "'claude'" in _table_sql(con):
            con.execute("COMMIT")
        else:
            raise SchemaError("episodic_events still rejects 'claude' after rebuild")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return True


def migrate(con):
    """Bring memory.db to TARGET_VERSION. Safe to call on every run. Returns True if it rebuilt the table."""
    prev = con.isolation_level
    con.isolation_level = None  # explicit BEGIN/COMMIT for the rebuild
    try:
        con.execute(META_DDL)
        if needs_migration(_table_sql(con)):
            return _rebuild(con)
        _set_version(con)
        return False
    finally:
        con.isolation_level = prev
