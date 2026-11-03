"""schema_migrations: widen episodic_events.source to accept 'claude' without losing rows or FTS."""

import os
import re
import sqlite3
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import schema_migrations  # noqa: E402
import build_text_fts  # noqa: E402  (DDL for the episodic_text_fts index and triggers the live DB carries)

OLD = open(os.path.join(SRC, "schema.sql")).read()  # current 4-source shape (muse included)


BIG_ROWS = 60000  # enough that a row copy is clearly slower than the in-place edit
WIDENED = "CHECK(source IN ('codex', 'hermes', 'opencode', 'muse', 'claude'))"
INSERT = ("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
          " VALUES(?,?,?,?,?,?,?)")


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "memory.db")
        con = sqlite3.connect(self.db)
        con.executescript(OLD)
        con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                    " VALUES('muse','S','t1',1,'user','hello kafka','text')")
        con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                    " VALUES('opencode','S','t2',2,'assistant','rebalance fix','text')")
        con.execute("DELETE FROM episodic_events WHERE turn_id='t2'")  # leave a gap in ids
        con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                    " VALUES('codex','S','t3',3,'user','third row','text')")
        con.commit()
        self.before = con.execute("SELECT id, source, turn_id, content FROM episodic_events ORDER BY id").fetchall()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def open(self):
        con = sqlite3.connect(self.db)
        con.isolation_level = None
        self.addCleanup(con.close)
        return con

    def _add_big_rows(self):
        con = sqlite3.connect(self.db)
        con.execute("BEGIN")
        con.executemany("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                        " VALUES('codex','S',?,?,'user',?,'text')",
                        [(f"big{i}", i, "payload " * 60 + str(i)) for i in range(BIG_ROWS)])
        con.execute("COMMIT")
        con.close()

    def _live_shape(self, con):
        """Add the episodic_text_fts index and its triggers, as build_text_fts does on the live DB."""
        for stmt in build_text_fts.DDL:
            con.execute(stmt)

    def _hits(self, con):
        """Rows matching the probe token in each FTS index."""
        return tuple(con.execute(f"SELECT count(*) FROM {t} WHERE {t} MATCH ?",
                                 (schema_migrations.PROBE_TEXT,)).fetchone()[0]
                     for t in ("episodic_fts", "episodic_text_fts"))

    def _edit_stored_check(self, con, new_check):
        """Swap the stored source CHECK the way _widen_in_place does. The caller owns the transaction."""
        old = schema_migrations._table_sql(con)
        new_sql = schema_migrations.SOURCE_CHECK.sub(new_check, old, count=1)
        version = con.execute("PRAGMA schema_version").fetchone()[0]
        con.execute("PRAGMA writable_schema=ON")
        try:
            con.execute("UPDATE sqlite_master SET sql=? WHERE type='table' AND name='episodic_events'", (new_sql,))
            con.execute(f"PRAGMA schema_version={version + 1}")
        finally:
            con.execute("PRAGMA writable_schema=OFF")

    def test_migrate_twice_is_idempotent_and_keeps_ids_and_fts(self):
        con = self.open()
        self.assertTrue(schema_migrations.migrate(con))
        self.assertFalse(schema_migrations.migrate(con))
        rows = con.execute("SELECT id, source, turn_id, content FROM episodic_events ORDER BY id").fetchall()
        self.assertEqual(rows, self.before)
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_fts WHERE episodic_fts MATCH 'kafka'").fetchone()[0], 1)
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_fts").fetchone()[0], 2)
        self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        version = con.execute("SELECT value FROM harness_schema_meta WHERE key='schema_version'").fetchone()[0]
        self.assertEqual(version, str(schema_migrations.TARGET_VERSION))
        con.close()

    def test_claude_insert_works_bogus_fails(self):
        con = self.open()
        schema_migrations.migrate(con)
        con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                    " VALUES('claude','C','u:0',9,'user','from claude','text')")
        with self.assertRaises(sqlite3.IntegrityError):
            con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                        " VALUES('bogus','C','x',9,'user','nope','text')")
        con.close()

    def test_new_id_does_not_reuse_a_deleted_top_id(self):
        con = self.open()
        top = con.execute("SELECT max(id) FROM episodic_events").fetchone()[0]
        schema_migrations.migrate(con)
        con.execute("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                    " VALUES('claude','C','u:0',9,'user','new','text')")
        new_id = con.execute("SELECT id FROM episodic_events WHERE source='claude'").fetchone()[0]
        self.assertGreater(new_id, top)
        con.close()

    def test_widening_is_in_place_and_fast_on_a_large_table(self):
        """The migration never copies rows: a large table widens in well under a tick budget."""
        import time
        self._add_big_rows()
        con = self.open()
        t0 = time.time()
        self.assertTrue(schema_migrations.migrate(con))
        dt = time.time() - t0
        # A 12-step copy of this table takes seconds (about 24x longer than the in-place edit);
        # the bound is loose for slow CI but far below a copy of 150k rows.
        self.assertLess(dt, 0.25, f"widening took {dt:.3f}s; it must not copy rows")
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events").fetchone()[0], BIG_ROWS + 2)
        con.close()

    def test_migrate_runs_no_full_table_scan(self):
        """Nothing on the migration path counts a table or checks the whole file.

        A full count holds the write lock for minutes on the live memory.db, and quick_check or
        integrity_check read every page. The trace must also see the real writes, or the
        assertions would pass on an empty trace.
        """
        self._add_big_rows()
        con = self.open()
        statements = []
        con.set_trace_callback(statements.append)
        try:
            self.assertTrue(schema_migrations.migrate(con))
            self.assertFalse(schema_migrations.migrate(con))  # the second run takes the no-op path too
        finally:
            con.set_trace_callback(None)
        self.assertTrue(any("UPDATE sqlite_master" in s for s in statements), "trace missed the schema edit")
        self.assertTrue(any("widen_probe" in s for s in statements), "trace missed the probe")
        counting = [s for s in statements if re.search(r"count\s*\(", s, re.I)]
        self.assertEqual(counting, [], f"migrate() ran a count: {counting}")
        scanning = [s for s in statements if re.search(r"quick_check|integrity_check", s, re.I)]
        self.assertEqual(scanning, [], f"migrate() ran a whole-database check: {scanning}")
        con.close()

    def test_probe_row_does_not_survive_migration(self):
        """The probe's inserts are rolled back: no row, no id gap, no FTS hit in either index.

        The probe row is a user text event, so the episodic_text_fts triggers fire on it as well.
        The rollback has to undo those too.
        """
        self._add_big_rows()
        con = self.open()
        self._live_shape(con)
        before = con.execute("SELECT count(*), max(id) FROM episodic_events").fetchone()
        seq_before = con.execute("SELECT seq FROM sqlite_sequence WHERE name='episodic_events'").fetchone()
        text_before = con.execute("SELECT count(*) FROM episodic_text_fts").fetchone()[0]
        self.assertTrue(schema_migrations.migrate(con))
        self.assertEqual(con.execute("SELECT count(*), max(id) FROM episodic_events").fetchone(), before)
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events WHERE session_id=?",
                                     (schema_migrations.PROBE_SESSION,)).fetchone()[0], 0)
        self.assertEqual(self._hits(con), (0, 0))
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_text_fts").fetchone()[0], text_before)
        # AUTOINCREMENT's counter is rolled back too, so the next real row takes the next id.
        self.assertEqual(con.execute("SELECT seq FROM sqlite_sequence WHERE name='episodic_events'").fetchone(), seq_before)
        # The probe rolled back, not the widening: the live CHECK still takes 'claude' afterwards.
        con.execute(INSERT, ("claude", "C", "after-probe", 9, "user", "real row", "text"))
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events WHERE source='claude'").fetchone()[0], 1)
        con.close()

    def test_fts_match_sees_the_probe_token_when_a_row_has_it(self):
        """Control for the zero-hit check above: the same MATCH finds a real row with the probe token."""
        con = self.open()
        self._live_shape(con)
        con.execute(INSERT, ("muse", "control", "control", 7, "user", schema_migrations.PROBE_TEXT, "text"))
        self.assertEqual(self._hits(con), (1, 1))
        self.assertTrue(schema_migrations.migrate(con))
        self.assertEqual(self._hits(con), (1, 1))  # the probe added no hit: only the control row matches
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events WHERE session_id=?",
                                     (schema_migrations.PROBE_SESSION,)).fetchone()[0], 0)
        con.close()

    def test_widening_rolls_back_when_verification_fails(self):
        """A failed verification leaves the old CHECK and schema_version in place: no half-migrated schema."""
        con = self.open()
        con.execute(schema_migrations.META_DDL)  # committed before the widening transaction, so not part of the rollback
        version_before = con.execute("PRAGMA schema_version").fetchone()[0]
        real = schema_migrations._table_sql
        calls = {"n": 0}

        def flaky(c):
            calls["n"] += 1
            sql = real(c)
            return sql.replace("'claude'", "'nope'") if calls["n"] > 2 else sql  # call 3 is the post-edit check

        schema_migrations._table_sql = flaky
        try:
            with self.assertRaisesRegex(schema_migrations.SchemaError, "still rejects 'claude'"):
                schema_migrations.migrate(con)
        finally:
            schema_migrations._table_sql = real
        self.assertNotIn("'claude'", real(con))
        self.assertEqual(con.execute("PRAGMA schema_version").fetchone()[0], version_before)
        self.assertEqual(con.execute("SELECT count(*) FROM harness_schema_meta WHERE key='schema_version'").fetchone()[0], 0)
        con.close()

    def test_probe_refusal_rolls_the_schema_edit_back(self):
        """A live CHECK that refuses 'claude' fails the probe, and the stored edit is rolled back with it."""
        con = self.open()
        con.execute("CREATE TRIGGER refuse_claude BEFORE INSERT ON episodic_events WHEN new.source = 'claude'"
                    " BEGIN SELECT RAISE(ABORT, 'refused claude'); END")
        con.execute(schema_migrations.META_DDL)
        version_before = con.execute("PRAGMA schema_version").fetchone()[0]
        with self.assertRaisesRegex(schema_migrations.SchemaError, "refuses source 'claude' after widening"):
            schema_migrations.migrate(con)
        self.assertNotIn("'claude'", schema_migrations._table_sql(con))
        self.assertEqual(con.execute("PRAGMA schema_version").fetchone()[0], version_before)
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events").fetchone()[0], len(self.before))
        con.close()

    def test_probe_refuses_when_check_accepts_bogus(self):
        """A CHECK that accepts every source is not a widened CHECK: the probe says so, and its claude row goes too."""
        con = self.open()
        con.execute("BEGIN IMMEDIATE")
        try:
            self._edit_stored_check(con, "CHECK(1 OR source IN ('codex', 'hermes', 'opencode', 'muse', 'claude'))")
            with self.assertRaisesRegex(schema_migrations.SchemaError, "accepts source 'bogus'"):
                schema_migrations._probe_widened_check(con)
            self.assertEqual(con.execute("SELECT count(*) FROM episodic_events WHERE session_id=?",
                                         (schema_migrations.PROBE_SESSION,)).fetchone()[0], 0)
        finally:
            con.execute("ROLLBACK")
        con.close()

    def test_probe_reports_a_non_check_error_as_probe_failure(self):
        """An error from the probe that isn't the CHECK must not count as a refusal.

        A trigger aborts only the bogus row, with a message that doesn't name the CHECK. The probe
        must report that as a probe failure, not as a CHECK that works.
        """
        con = self.open()
        con.execute("BEGIN IMMEDIATE")
        try:
            self._edit_stored_check(con, WIDENED)
            con.execute("CREATE TRIGGER refuse_bogus BEFORE INSERT ON episodic_events WHEN new.source = 'bogus'"
                        " BEGIN SELECT RAISE(ABORT, 'trigger refused bogus'); END")
            with self.assertRaisesRegex(schema_migrations.SchemaError, "probing the episodic_events source CHECK failed"):
                schema_migrations._probe_widened_check(con)
        finally:
            con.execute("ROLLBACK")
        con.close()

    def test_lost_race_under_the_lock_is_a_no_op(self):
        """Another tailer widened the table after this one read it: the locked recheck returns False, untouched."""
        con = self.open()
        schema_migrations.migrate(con)  # the other tailer's widening
        version_before = con.execute("PRAGMA schema_version").fetchone()[0]
        sql_before = schema_migrations._table_sql(con)
        self.assertFalse(schema_migrations._widen_in_place(con))  # what a racing caller reaches
        self.assertEqual(con.execute("PRAGMA schema_version").fetchone()[0], version_before)
        self.assertEqual(schema_migrations._table_sql(con), sql_before)
        con.close()

    def test_unknown_shape_is_refused(self):
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA writable_schema=ON")
        con.execute("UPDATE sqlite_master SET sql=replace(sql, 'hermes', 'weird') WHERE name='episodic_events'")
        con.execute("PRAGMA writable_schema=OFF")
        con.commit()
        con.close()
        con = self.open()
        with self.assertRaises(schema_migrations.SchemaError):
            schema_migrations.migrate(con)
        con.close()


if __name__ == "__main__":
    unittest.main()
