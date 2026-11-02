"""Widen episodic_events.source to accept 'claude' (schema_version 2).

The source CHECK is widened IN PLACE by editing the stored table definition
inside one short transaction (the sqlite_master route sync_muse already uses).
Widening a CHECK cannot invalidate an existing row, so no table copy happens:
on a memory.db of about 100 GB this is a catalog edit, where the 12-step table
copy would run for about an hour in one non-resumable transaction and be killed
by every tick. Nothing on the migration path scans episodic_events or its FTS
index. Before commit the transaction checks the stored CHECK, then proves the
live one with a savepoint probe row that is always rolled back. It commits or
rolls back as a whole.

Idempotent: a table that already accepts 'claude' is left alone. A CHECK of an
unknown shape (a source missing from the known set) is refused, not guessed at.
Only the native syncs (sync_claude, sync_codex, sync_thread_identity) call
migrate(); sync_muse and sync_opencode_v2 keep their own widening paths.
"""

import re
import sqlite3

TARGET_VERSION = 2
META_DDL = "CREATE TABLE IF NOT EXISTS harness_schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
KNOWN_OLD = ("codex", "hermes", "opencode", "muse")
SOURCE_CHECK = re.compile(r"CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)", re.I)
TABLE_HEAD = re.compile(r"^(\s*CREATE\s+TABLE\s+)(IF\s+NOT\s+EXISTS\s+)?(\"?)episodic_events\3(?=[\s(])", re.I)
# Savepoint probe row: it fills every NOT NULL column and is always rolled back.
PROBE_SESSION = "schema-widen-probe"
PROBE_TEXT = "schemawidenprobe"  # the FTS token a leaked probe row would match
PROBE_INSERT = (
    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
    " VALUES (?,?,?,0,'user',?,'text')"
)


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


def _probe_widened_check(con):
    """Prove the widened source CHECK is live, leaving no row behind.

    Inside a savepoint, a 'claude' row must insert and a 'bogus' row must be refused by the
    CHECK. The savepoint is always rolled back, so the probe row and its FTS and
    AUTOINCREMENT side effects never reach the commit. Two single-row inserts and their
    index lookups: nothing here scans a table or runs integrity_check.
    """
    con.execute("SAVEPOINT widen_probe")
    try:
        try:
            con.execute(PROBE_INSERT, ("claude", PROBE_SESSION, PROBE_SESSION, PROBE_TEXT))
        except sqlite3.IntegrityError as e:
            raise SchemaError(f"episodic_events refuses source 'claude' after widening: {e}") from e
        try:
            con.execute(PROBE_INSERT, ("bogus", PROBE_SESSION, PROBE_SESSION, PROBE_TEXT))
        except sqlite3.IntegrityError as e:
            # Only the source differs from the accepted row, so any other error here is
            # not the CHECK speaking and must not count as a refusal.
            if "CHECK constraint failed" not in str(e):
                raise SchemaError(f"probing the episodic_events source CHECK failed: {e}") from e
        else:
            raise SchemaError("episodic_events accepts source 'bogus' after widening; the CHECK is not live")
    finally:
        con.execute("ROLLBACK TO widen_probe")
        con.execute("RELEASE widen_probe")


def _widen_in_place(con):
    """Loosen the source CHECK in the stored schema (sqlite_master), in one short transaction.

    Widening a CHECK cannot invalidate an existing row, so no table copy is needed. This is
    the route sync_muse already uses (sqlite.org/lang_altertable.html, "other kinds of
    changes"). It is a catalog edit, where a 12-step rebuild of a ~100 GB memory.db would
    run for about an hour in one non-resumable transaction. The schema_version bump makes
    other connections re-read the schema. Everything checked before commit is cheap: the
    stored CHECK names 'claude', and _probe_widened_check shows that the live CHECK accepts
    'claude' and refuses 'bogus'. Any failure rolls the whole edit back.
    """
    con.execute("BEGIN IMMEDIATE")
    try:
        old_sql = _table_sql(con)
        if not needs_migration(old_sql):
            con.execute("COMMIT")
            return False  # another tailer widened it first
        allowed = _allowed(old_sql)
        new_check = "CHECK(source IN (" + ", ".join(f"'{x}'" for x in allowed + ["claude"]) + "))"
        new_sql = SOURCE_CHECK.sub(new_check, old_sql, count=1)
        if "'claude'" not in new_sql or new_sql == old_sql:
            raise SchemaError("could not widen the episodic_events source CHECK; refusing to migrate")
        version = con.execute("PRAGMA schema_version").fetchone()[0]
        con.execute("PRAGMA writable_schema=ON")
        try:
            con.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='episodic_events'", (new_sql,))
            con.execute(f"PRAGMA schema_version={version + 1}")
        finally:
            con.execute("PRAGMA writable_schema=OFF")
        _set_version(con)
        # verify inside the transaction; any failure rolls the whole edit back
        if "'claude'" not in _table_sql(con):
            raise SchemaError("episodic_events still rejects 'claude' after widening")
        _probe_widened_check(con)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return True


def migrate(con):
    """Bring memory.db to TARGET_VERSION. Safe to call on every run; returns True when it changed the schema.

    The only schema change is the in-place CHECK widening (see module docstring). There is
    deliberately no table-copy path here: a copy of memory.db is not resumable and would not
    finish inside any tailer's kill budget. Nothing on this path scans episodic_events or
    episodic_fts, so a run costs about the same whatever the table size.
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
