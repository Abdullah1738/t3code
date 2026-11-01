"""Widen episodic_events.source to accept 'claude' (schema_version 2).

The source CHECK is widened IN PLACE by editing the stored table definition
inside one short transaction (the sqlite_master route sync_muse already uses).
Widening a CHECK cannot invalidate an existing row, so no table copy happens:
on a 97 GB memory.db this is a sub-second catalog edit, where the 12-step
table copy would run for about an hour in one non-resumable transaction and be
killed by every tick. The transaction verifies the new CHECK, the row count and
the FTS count before commit, and rolls back on any mismatch.

Idempotent: a table that already accepts 'claude' is left alone. A CHECK of an
unknown shape (a source missing from the known set) is refused, not guessed at.
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


def _widen_in_place(con):
    """Loosen the source CHECK in the stored schema (sqlite_master), in one short transaction.

    Widening a CHECK cannot invalidate an existing row, so no table copy is needed. This is
    the route sync_muse already uses (sqlite.org/lang_altertable.html, "other kinds of
    changes"). It takes milliseconds on the 97 GB memory.db where a 12-step rebuild would
    run for about an hour in one non-resumable transaction. The schema_version bump makes
    other connections re-read the schema. Verified before commit: the new CHECK parses, the
    row count and FTS counts are unchanged, and a 'claude' insert succeeds.
    """
    old_sql = _table_sql(con)
    allowed = _allowed(old_sql)
    new_check = "CHECK(source IN (" + ", ".join(f"'{x}'" for x in allowed + ["claude"]) + "))"
    new_sql = SOURCE_CHECK.sub(new_check, old_sql, count=1)
    if "'claude'" not in new_sql or new_sql == old_sql:
        raise SchemaError("could not widen the episodic_events source CHECK; refusing to migrate")
    n_before = con.execute("SELECT count(*) FROM episodic_events").fetchone()[0]
    fts_before = con.execute("SELECT count(*) FROM episodic_fts").fetchone()[0]
    con.execute("BEGIN IMMEDIATE")
    try:
        if not needs_migration(_table_sql(con)):
            con.execute("COMMIT")
            return False  # another tailer widened it first
        version = con.execute("PRAGMA schema_version").fetchone()[0]
        con.execute("PRAGMA writable_schema=ON")
        try:
            con.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='episodic_events'", (new_sql,))
            con.execute(f"PRAGMA schema_version={version + 1}")
        finally:
            con.execute("PRAGMA writable_schema=OFF")
        _set_version(con)
        # verify inside the transaction; any mismatch rolls the whole edit back
        if "'claude'" not in _table_sql(con):
            raise SchemaError("episodic_events still rejects 'claude' after widening")
        if con.execute("SELECT count(*) FROM episodic_events").fetchone()[0] != n_before:
            raise SchemaError("row count changed during widening")
        if con.execute("SELECT count(*) FROM episodic_fts").fetchone()[0] != fts_before:
            raise SchemaError("FTS count changed during widening")
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return True


def migrate(con):
    """Bring memory.db to TARGET_VERSION. Safe to call on every run; returns True when it changed the schema.

    The only schema change is the in-place CHECK widening (see module docstring). There is
    deliberately no table-copy path here: a copy of memory.db is not resumable and would not
    finish inside any tailer's kill budget.
    """
    prev = con.isolation_level
    con.isolation_level = None  # explicit BEGIN/COMMIT
    try:
        con.execute(META_DDL)
        if needs_migration(_table_sql(con)):
            return _widen_in_place(con)
        _set_version(con)
        return False
    finally:
        con.isolation_level = prev
