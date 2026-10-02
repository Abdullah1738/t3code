#!/usr/bin/env python3
"""Build episodic_text_fts: a contentless FTS5 index over user/assistant text
events only, with source/session/speaker/timestamp stored as UNINDEXED columns.

Why: memory_search_history defaults to user/assistant text, but episodic_fts
indexes every event (tool output is ~85% of the bytes). Filtering episodic_fts
hits by content_type means reading each candidate row, and content_type sits
after the (often huge) content column, so SQLite walks the overflow pages of
every tool output that matches. This index answers the default search without
touching episodic_events until the final top hits.

Safe to run while the sync tick is writing: triggers are created first (new
rows are indexed as they arrive), then pre-existing rows are backfilled in
small committed chunks up to the max id seen at creation. Resumable: progress
is kept in fts_build_state. `--drop` removes the table, triggers and state
(the file does not shrink without a VACUUM). Re-running on a built index only
refreshes the triggers.

Notes: every process that writes episodic_events needs SQLite >= 3.47 once the
triggers exist (contentless_unindexed). The final 'optimize' rewrites the whole
index (~2.7GB) in one transaction, blocking other writers for a few minutes
and growing the WAL by about that much; checkpoint afterwards.

Run: .venv/bin/python src/build_text_fts.py [--chunk 200000] [--drop]
"""
import argparse
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DB = os.path.join(ROOT, "data", "memory.db")
NAME = "episodic_text_fts"
COND_NEW = "new.content_type = 'text' AND new.speaker IN ('user', 'assistant')"
COND_OLD = "old.content_type = 'text' AND old.speaker IN ('user', 'assistant')"

DDL = [
    f"""CREATE VIRTUAL TABLE IF NOT EXISTS {NAME} USING fts5(
        content, source UNINDEXED, session_id UNINDEXED, speaker UNINDEXED, ts UNINDEXED,
        content='', contentless_delete=1, contentless_unindexed=1)""",
    f"""CREATE TRIGGER IF NOT EXISTS {NAME}_insert AFTER INSERT ON episodic_events
        WHEN {COND_NEW} BEGIN
        INSERT INTO {NAME}(rowid, content, source, session_id, speaker, ts)
        VALUES (new.id, new.content, new.source, new.session_id, new.speaker, new.timestamp);
        END""",
    f"""CREATE TRIGGER IF NOT EXISTS {NAME}_delete AFTER DELETE ON episodic_events
        WHEN {COND_OLD} BEGIN
        DELETE FROM {NAME} WHERE rowid = old.id;
        END""",
    # INSERT OR REPLACE on episodic_events is not supported: with
    # recursive_triggers off the implicit delete does not fire the delete trigger.
    f"""CREATE TRIGGER IF NOT EXISTS {NAME}_update AFTER UPDATE OF
        id, content, content_type, speaker, source, session_id, timestamp ON episodic_events BEGIN
        DELETE FROM {NAME} WHERE rowid = old.id;
        INSERT INTO {NAME}(rowid, content, source, session_id, speaker, ts)
        SELECT new.id, new.content, new.source, new.session_id, new.speaker, new.timestamp
        WHERE {COND_NEW};
        END""",
    """CREATE TABLE IF NOT EXISTS fts_build_state(
        name TEXT PRIMARY KEY, next_id INTEGER NOT NULL, hi INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, started_at REAL, finished_at REAL)""",
]


def connect():
    con = sqlite3.connect(MEM_DB, timeout=600, isolation_level=None)
    con.execute("PRAGMA busy_timeout=600000")
    return con


def drop(con):
    con.execute("BEGIN IMMEDIATE")
    for t in ("insert", "delete", "update"):
        con.execute(f"DROP TRIGGER IF EXISTS {NAME}_{t}")
    con.execute(f"DROP TABLE IF EXISTS {NAME}")
    # DROP of a contentless_unindexed table can leave its _content shadow behind
    for sfx in ("content", "data", "idx", "docsize", "config"):
        con.execute(f"DROP TABLE IF EXISTS {NAME}_{sfx}")
    con.execute("CREATE TABLE IF NOT EXISTS fts_build_state(name TEXT PRIMARY KEY, next_id INTEGER NOT NULL, "
                "hi INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, started_at REAL, finished_at REAL)")
    con.execute("DELETE FROM fts_build_state WHERE name=?", (NAME,))
    con.execute("COMMIT")
    print(f"dropped {NAME}", flush=True)


def setup(con):
    """Create table + triggers and record the backfill bound atomically, so
    every row is covered exactly once: ids <= hi by backfill, later ones by the
    insert trigger."""
    con.execute("BEGIN IMMEDIATE")
    existed = con.execute("SELECT 1 FROM sqlite_master WHERE name=?", (NAME,)).fetchone() is not None
    con.execute(f"DROP TRIGGER IF EXISTS {NAME}_update")  # recreated below with the current column list
    if not existed:
        # a plain DROP TABLE leaves the _content shadow behind, which blocks CREATE
        for sfx in ("content", "data", "idx", "docsize", "config"):
            con.execute(f"DROP TABLE IF EXISTS {NAME}_{sfx}")
    for s in DDL:
        con.execute(s)
    if not existed:
        # table was missing (first run or dropped by hand): any old state is void
        con.execute("DELETE FROM fts_build_state WHERE name=?", (NAME,))
    row = con.execute("SELECT next_id, hi, done FROM fts_build_state WHERE name=?", (NAME,)).fetchone()
    if row is None:
        lo, hi = con.execute("SELECT COALESCE(min(id),0), COALESCE(max(id),0) FROM episodic_events").fetchone()
        con.execute("INSERT INTO fts_build_state(name, next_id, hi, done, started_at) VALUES(?,?,?,0,?)",
                    (NAME, lo, hi, time.time()))
        row = (lo, hi, 0)
    con.execute("COMMIT")
    return row


def backfill(con, chunk):
    next_id, hi, done = setup(con)
    if done:
        print(f"{NAME} already built (hi={hi})", flush=True)
        return
    t0, n_total = time.time(), 0
    start = next_id
    while next_id <= hi:
        end = min(next_id + chunk - 1, hi)
        t = time.time()
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute(
            f"INSERT INTO {NAME}(rowid, content, source, session_id, speaker, ts) "
            "SELECT id, content, source, session_id, speaker, timestamp FROM episodic_events "
            "WHERE id BETWEEN ? AND ? AND content_type = 'text' AND speaker IN ('user', 'assistant') "
            # rows the update trigger already indexed would hit a rowid conflict
            f"AND id NOT IN (SELECT id FROM {NAME}_content WHERE id BETWEEN ? AND ?)",
            (next_id, end, next_id, end))
        n = cur.rowcount
        con.execute("UPDATE fts_build_state SET next_id=? WHERE name=?", (end + 1, NAME))
        con.execute("COMMIT")
        n_total += max(n, 0)
        pct = 100.0 * (end - start + 1) / max(1, hi - start + 1)
        print(f"{time.strftime('%H:%M:%S')} ids {next_id}..{end} +{n} rows ({time.time()-t:.1f}s) "
              f"total {n_total} {pct:.1f}%", flush=True)
        next_id = end + 1
    print(f"backfill done: {n_total} rows in {time.time()-t0:.0f}s; optimizing", flush=True)
    t = time.time()
    con.execute(f"INSERT INTO {NAME}({NAME}) VALUES('optimize')")
    con.execute("UPDATE fts_build_state SET done=1, finished_at=? WHERE name=?", (time.time(), NAME))
    print(f"optimize {time.time()-t:.0f}s; {NAME} ready", flush=True)
    con.execute("PRAGMA wal_checkpoint(PASSIVE)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=200_000)
    ap.add_argument("--drop", action="store_true")
    a = ap.parse_args()
    if sqlite3.sqlite_version_info < (3, 47, 0):
        sys.exit(f"sqlite {sqlite3.sqlite_version} too old (contentless_unindexed needs 3.47+)")
    con = connect()
    if a.drop:
        drop(con)
    else:
        backfill(con, a.chunk)


if __name__ == "__main__":
    main()
