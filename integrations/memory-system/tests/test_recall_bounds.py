import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import recall_core as rc


class ReaderBoundsTest(unittest.TestCase):
    def test_hot_catalog_observes_same_id_updates_and_deletions(self):
        import recall_storage
        import build_text_fts
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, hot, cat = root / "cold.db", root / "hot.db", root / "catalog.db"
            writer = sqlite3.connect(source)
            writer.executescript("CREATE TABLE episodic_events(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,turn_id TEXT,timestamp INTEGER,speaker TEXT,content TEXT,content_type TEXT,model TEXT,tokens_used INTEGER,metadata_json TEXT,content_fts TEXT);")
            recall_storage.install_change_journal(writer)
            writer.execute("INSERT INTO episodic_events VALUES(1,'codex','one','turn',1,'user','first title','text',NULL,NULL,'{}',NULL)")
            writer.commit()
            recall_storage.build_index(source, hot)
            previous = rc._local
            rc._local = threading.local()
            try:
                with patch.object(rc, "MEM_DB", source), patch.object(rc, "HOT_DB", hot), patch.object(rc, "CATALOG_DB", cat):
                    rc.refresh_catalog(full=True)
                    writer.execute("UPDATE episodic_events SET content='revised title' WHERE id=1")
                    writer.commit()
                    recall_storage.build_index(source, hot)
                    for _ in range(3): rc.refresh_catalog()
                    self.assertEqual(rc.catalog_rows(["one"])["one"]["first_prompt"], "revised title")
                    writer.execute("DELETE FROM episodic_events WHERE id=1")
                    writer.commit()
                    recall_storage.build_index(source, hot)
                    for _ in range(6): rc.refresh_catalog()
                    self.assertEqual(rc.catalog_rows(["one"]), {})
            finally:
                rc.close_readers()
                con = getattr(rc._local, "catalog_w", None)
                if con: con.close()
                rc._local = previous
                writer.close()

    def test_direct_sql_is_interrupted_by_nested_request_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.db"
            sqlite3.connect(path).close()
            @rc.bounded(-1)
            def request():
                with rc.connect_ro(path) as con:
                    con.execute("WITH RECURSIVE x(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM x WHERE n<1000000) SELECT sum(n) FROM x").fetchone()
            with self.assertRaises(rc.Timeout):
                request()

    def test_operation_closes_thread_local_readers_even_on_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            con = sqlite3.connect(Path(directory) / "fixture.db")
            previous = rc._local
            rc._local = threading.local()
            rc._local.cold = con
            try:
                @rc.bounded(0.8)
                def request():
                    raise ValueError("test")
                with self.assertRaises(ValueError):
                    request()
                with self.assertRaises(sqlite3.ProgrammingError):
                    con.execute("SELECT 1")
            finally:
                rc._local = previous

    def test_catalog_miss_never_computes_transcript_on_request(self):
        with patch.object(rc, "catalog", side_effect=sqlite3.OperationalError("absent")), \
             patch.object(rc, "compute_session", side_effect=AssertionError("scan")):
            self.assertEqual(rc.catalog_rows(["new"]), {})

    def test_missing_session_index_fails_before_transcript_query(self):
        con = sqlite3.connect(":memory:")
        statements = []
        con.set_trace_callback(statements.append)
        try:
            with self.assertRaisesRegex(sqlite3.OperationalError, "session index missing"):
                rc.compute_session(con, "missing")
            self.assertFalse(any("FROM episodic_events" in sql for sql in statements))
        finally:
            con.close()
