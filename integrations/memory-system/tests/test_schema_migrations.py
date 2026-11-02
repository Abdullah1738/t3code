"""schema_migrations: widen episodic_events.source to accept 'claude' without losing rows or FTS."""

import os
import sqlite3
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import schema_migrations  # noqa: E402

OLD = open(os.path.join(SRC, "schema.sql")).read()  # current 4-source shape (muse included)


BIG_ROWS = 60000  # enough that a row copy is clearly slower than the in-place edit


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
        return con

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
        con = sqlite3.connect(self.db)
        con.execute("BEGIN")
        con.executemany("INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type)"
                        " VALUES('codex','S',?,?,'user',?,'text')",
                        [(f"big{i}", i, "payload " * 60 + str(i)) for i in range(BIG_ROWS)])
        con.execute("COMMIT")
        con.close()
        con = self.open()
        t0 = time.time()
        self.assertTrue(schema_migrations.migrate(con))
        dt = time.time() - t0
        # A 12-step copy of this table takes seconds (about 24x longer than the in-place edit);
        # the bound is loose for slow CI but far below a copy of 150k rows.
        self.assertLess(dt, 0.25, f"widening took {dt:.3f}s; it must not copy rows")
        self.assertEqual(con.execute("SELECT count(*) FROM episodic_events").fetchone()[0], BIG_ROWS + 2)
        con.close()

    def test_widening_rolls_back_when_verification_fails(self):
        """A failed verification leaves the old CHECK in place: no half-migrated schema."""
        con = self.open()
        real = schema_migrations._table_sql
        calls = {"n": 0}

        def flaky(c):
            calls["n"] += 1
            sql = real(c)
            return sql.replace("'claude'", "'nope'") if calls["n"] > 2 else sql

        schema_migrations._table_sql = flaky
        try:
            with self.assertRaises(schema_migrations.SchemaError):
                schema_migrations.migrate(con)
        finally:
            schema_migrations._table_sql = real
        self.assertNotIn("'claude'", real(con))
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
