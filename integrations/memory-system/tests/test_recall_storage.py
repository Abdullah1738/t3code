"""Synthetic only: hot/cold projection, source immutability and resumable copy."""

import json
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import recall_migrate as migration
import recall_storage as storage
import robob_readonly


@contextmanager
def database(path):
    con = sqlite3.connect(path)
    try:
        with con:
            yield con
    finally:
        con.close()


SCHEMA = """
CREATE TABLE episodic_events(
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, session_id TEXT NOT NULL,
 turn_id TEXT, timestamp INTEGER NOT NULL, speaker TEXT NOT NULL, content TEXT NOT NULL,
 content_type TEXT NOT NULL, model TEXT, tokens_used INTEGER, metadata_json TEXT,
 content_fts TEXT, UNIQUE(source,session_id,turn_id));
CREATE INDEX original_session_index ON episodic_events(source,session_id);
CREATE TABLE thread_aliases(alias_key TEXT PRIMARY KEY, session_id TEXT, metadata_json TEXT);
CREATE TABLE attachments(id INTEGER PRIMARY KEY, payload BLOB);
CREATE TABLE capture_progress(source TEXT PRIMARY KEY, offset INTEGER);
CREATE TABLE compound_ledger(source TEXT, k INTEGER, payload BLOB, PRIMARY KEY(source,k)) WITHOUT ROWID;
CREATE VIEW canonical_counts AS SELECT source,count(*) AS n FROM episodic_events GROUP BY source;
"""


def event(con, i, content=None, **kwargs):
    values = {"id": i, "source": "opencode", "session_id": "session-a", "turn_id": "turn-" + str(i),
              "timestamp": 100 + i, "speaker": "user", "content": content or "message " + str(i),
              "content_type": "text", "model": "model", "tokens_used": 1,
              "metadata_json": '{"cwd":"/work","kind":"text"}', "content_fts": content or "duplicate"}
    values.update(kwargs)
    con.execute("INSERT INTO episodic_events(" + ",".join(values) + ") VALUES(" + ",".join("?" for _ in values) + ")", tuple(values.values()))


@unittest.skipIf(sqlite3.sqlite_version_info < (3, 47, 0), "contentless_unindexed requires SQLite >=3.47")
class RecallStorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cold = self.root / "source" / "memory.db"
        self.cold.parent.mkdir()
        self.hot = self.root / "recall_hot.db"
        con = sqlite3.connect(self.cold)
        con.executescript(SCHEMA)
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def populate(self, count=6, journal=True, legacy=False):
        con = sqlite3.connect(self.cold)
        if legacy:
            con.executescript("""CREATE VIRTUAL TABLE episodic_fts USING fts5(content,content='episodic_events',content_rowid='id');
                CREATE TRIGGER episodic_fts_insert AFTER INSERT ON episodic_events BEGIN
                INSERT INTO episodic_fts(rowid,content) VALUES(new.id,new.content); END;
                CREATE VIRTUAL TABLE episodic_text_fts USING fts5(content,source UNINDEXED,
                    content='',contentless_delete=1,contentless_unindexed=1);
                CREATE TABLE fts_build_state(name TEXT PRIMARY KEY,next_id INTEGER);""")
        for i in range(1, count + 1):
            event(con, i)
        con.execute("INSERT INTO thread_aliases VALUES('alias-a','session-a','{}')")
        con.execute("INSERT INTO attachments VALUES(1,?)", (b"\x00\xffattached",))
        con.execute("INSERT INTO capture_progress VALUES('opencode',999)")
        con.executemany("INSERT INTO compound_ledger VALUES(?,?,?)", [("a", 1, b"one"), ("a", 9, b"two"), ("b", 1, b"three")])
        if journal:
            storage.install_change_journal(con)
        con.commit()
        con.close()

    def catch_up(self, **kwargs):
        for _ in range(100):
            stats = storage.build_index(self.cold, self.hot, **kwargs)
            if stats["caught_up"]:
                return stats
        self.fail("index did not catch up")

    def hits(self, term, table="episodic_fts"):
        with database(self.hot) as con:
            return [r[0] for r in con.execute(f"SELECT rowid FROM {table} WHERE {table} MATCH ? ORDER BY rowid", (term,))]

    def test_full_fts_bounded_excerpt_metadata_and_health(self):
        self.populate()
        con = sqlite3.connect(self.cold)
        full = "prefix " * 3000 + "beyondprefixneedle"
        metadata = json.dumps({"payload": "x" * 40000, "cwd": "/important", "kind": "reasoning", "nested": {"large": "y" * 40000}})
        con.execute("UPDATE episodic_events SET content=?,metadata_json=? WHERE id=1", (full, metadata))
        event(con, 7, "onlytoolneedle", content_type="tool_result", speaker="assistant")
        event(con, 8, "badmetadata", metadata_json="{broken")
        con.commit()
        con.close()
        stats = self.catch_up(max_rows=2)
        self.assertEqual([1], self.hits("beyondprefixneedle"))
        self.assertEqual([1], self.hits("beyondprefixneedle", "episodic_text_fts"))
        self.assertEqual([7], self.hits("onlytoolneedle"))
        self.assertEqual([], self.hits("onlytoolneedle", "episodic_text_fts"))
        with database(self.hot) as con:
            text, meta, duplicate = con.execute("SELECT content,metadata_json,content_fts FROM episodic_events WHERE id=1").fetchone()
            self.assertEqual(storage.EXCERPT_CHARS, len(text))
            self.assertNotIn("beyondprefixneedle", text)
            self.assertIsNone(duplicate)
            self.assertLessEqual(len(meta), storage.METADATA_CHARS)
            self.assertEqual("/important", json.loads(meta)["cwd"])
            self.assertEqual("reasoning", json.loads(meta)["kind"])
            self.assertTrue(json.loads(con.execute("SELECT metadata_json FROM episodic_events WHERE id=8").fetchone()[0])["_recall_invalid_metadata"])
            self.assertEqual(("opencode", "session-a", "user", 101), con.execute("SELECT source,session_id,speaker,ts FROM episodic_text_fts WHERE rowid=1").fetchone())
            plan = con.execute("EXPLAIN QUERY PLAN SELECT id FROM episodic_events WHERE session_id=? ORDER BY timestamp,id", ("session-a",)).fetchall()
            self.assertIn("idx_episodic_session_timestamp", str(plan))
            health = con.execute("SELECT source_max_id,source_change_seq,last_id,change_seq,observed_at,checkpoint_at FROM recall_index_state").fetchone()
            self.assertEqual((8, stats["source_change_seq"], 8, stats["source_change_seq"]), health[:4])
            self.assertIsNotNone(health[4])
            self.assertIsNotNone(health[5])
        idle = storage.build_index(self.cold, self.hot)
        self.assertEqual(0, idle["rows_processed"])
        self.assertTrue(idle["caught_up"])
        health = storage.index_health(self.hot)
        self.assertTrue(health["caught_up"])
        self.assertEqual(0, health["change_backlog"])

    def test_updates_deletes_reprojection_restart_and_id_move(self):
        self.populate()
        self.catch_up(max_rows=2)
        con = storage.connect_cold_writer(self.cold)
        con.execute("UPDATE episodic_events SET content='updatedneedle',speaker='system' WHERE id=1")
        con.execute("DELETE FROM episodic_events WHERE id=2")
        con.execute("DELETE FROM episodic_events WHERE id=3")
        event(con, 30, "reprojectionneedle", turn_id="turn-3")
        con.execute("UPDATE episodic_events SET id=40,content='movedneedle' WHERE id=4")
        # REPLACE's implicit delete is journalled by configured writer connections.
        con.execute("INSERT OR REPLACE INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,content_type) VALUES('opencode','session-a','turn-5',500,'user','replacementneedle','text')")
        con.close()
        self.catch_up(max_rows=1)
        self.assertEqual([1], self.hits("updatedneedle"))
        self.assertEqual([], self.hits("updatedneedle", "episodic_text_fts"))
        self.assertEqual([30], self.hits("reprojectionneedle"))
        self.assertEqual([40], self.hits("movedneedle"))
        with database(self.hot) as con:
            ids = [r[0] for r in con.execute("SELECT id FROM episodic_events ORDER BY id")]
            self.assertEqual([1, 6, 30, 40, 41], ids)
        self.assertEqual([41], self.hits("replacementneedle"))

    def test_projection_failure_rolls_back_batch_and_watermarks(self):
        self.populate()
        storage.build_index(self.cold, self.hot, max_rows=0)
        project = storage._project
        calls = 0

        def fail_second(con, row):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic crash")
            project(con, row)

        with patch.object(storage, "_project", fail_second):
            with self.assertRaisesRegex(RuntimeError, "synthetic crash"):
                storage.build_index(self.cold, self.hot)
        with database(self.hot) as con:
            self.assertEqual((0, 0), con.execute("SELECT last_id,change_seq FROM recall_index_state").fetchone())
            self.assertEqual(0, con.execute("SELECT count(*) FROM episodic_events").fetchone()[0])
        self.catch_up()
        self.assertEqual(6, len(self.hits("message")))

    def test_builder_requires_journal_and_rejects_aliases_and_other_store(self):
        self.populate(journal=False)
        with self.assertRaisesRegex(ValueError, "journal"):
            storage.build_index(self.cold, self.hot)
        self.assertFalse(self.hot.exists())
        con = sqlite3.connect(self.cold)
        storage.install_change_journal(con)
        con.commit()
        con.close()
        with self.assertRaisesRegex(ValueError, "aliases"):
            storage.build_index(self.cold, self.cold)
        link = self.root / "hardlink.db"
        os.link(self.cold, link)
        with self.assertRaisesRegex(ValueError, "aliases"):
            storage.build_index(self.cold, link)
        self.catch_up()
        other = self.root / "other.db"
        with database(self.cold) as src, database(other) as dst:
            src.backup(dst)
        with self.assertRaisesRegex(ValueError, "another cold store"):
            storage.build_index(other, self.hot)

    def test_builder_refuses_unready_migrated_store(self):
        self.populate()
        with database(self.cold) as con:
            con.execute("CREATE TABLE recall_migration_state(singleton INTEGER PRIMARY KEY,ready INTEGER)")
            con.execute("INSERT INTO recall_migration_state VALUES(1,0)")
        with self.assertRaisesRegex(ValueError, "not ready"):
            storage.build_index(self.cold, self.hot)
        self.assertFalse(self.hot.exists())

    def test_live_source_and_destination_aliases_rejected_before_sqlite(self):
        self.populate()
        with patch.object(robob_readonly, "_live_paths", return_value={self.cold}):
            with patch.object(sqlite3, "connect", side_effect=AssertionError("must not open SQLite")):
                for operation in (
                    lambda: storage.build_index(self.cold, self.hot),
                    lambda: storage.index_health(self.cold),
                    lambda: storage.connect_cold_writer(self.cold),
                    lambda: migration.dry_run(self.cold, self.root / "new"),
                    lambda: migration.migrate(self.cold, self.root / "new", offline_confirmed=True),
                ):
                    with self.assertRaises(robob_readonly.UnsafeStateDatabase):
                        operation()
        live = self.root / "fake-live.sqlite"
        live.write_bytes(b"not a database; never opened")
        target = self.root / "live-alias"
        target.mkdir()
        os.link(live, target / "memory.db")
        os.link(live, self.hot)
        with patch.object(robob_readonly, "_live_paths", return_value={live}):
            with patch.object(sqlite3, "connect", side_effect=AssertionError("must not open SQLite")):
                with self.assertRaises(robob_readonly.UnsafeStateDatabase):
                    migration.migrate(self.cold, target, offline_confirmed=True)
                with self.assertRaises(robob_readonly.UnsafeStateDatabase):
                    storage.build_index(self.cold, self.hot)

    def test_deadline_and_reader_snapshot_release(self):
        self.populate()
        stats = storage.build_index(self.cold, self.hot, seconds=0)
        self.assertTrue(stats["timed_out"])
        self.assertEqual(0, stats["rows_processed"])
        self.catch_up()
        con = storage.connect_cold_writer(self.cold)
        con.execute("UPDATE episodic_events SET content='fresh' WHERE id=1")
        self.assertEqual(0, storage.checkpoint(con, truncate=True)["busy"])
        con.close()

    def test_pruned_journal_is_refused_instead_of_skipping_mutation(self):
        self.populate()
        self.catch_up()
        con = storage.connect_cold_writer(self.cold)
        con.execute("UPDATE episodic_events SET content='first' WHERE id=1")
        con.execute("UPDATE episodic_events SET content='second' WHERE id=2")
        con.execute("DELETE FROM recall_event_changes WHERE seq=1")
        con.close()
        with self.assertRaisesRegex(ValueError, "pruned"):
            storage.build_index(self.cold, self.hot)

    def test_failed_sql_deadline_does_not_commit_half_a_projection(self):
        self.populate()
        storage.build_index(self.cold, self.hot, max_rows=0)
        original = storage._project

        def interrupted(con, row):
            original(con, row)
            raise sqlite3.OperationalError("interrupted")

        # Force expiry after setup so the interrupted batch follows the same
        # rollback path as a SQLite progress-handler cancellation.
        with patch.object(storage, "_project", interrupted):
            with self.assertRaises(sqlite3.OperationalError):
                storage.build_index(self.cold, self.hot)
        self.assertEqual(0, storage.index_health(self.hot)["last_id"])
        self.catch_up()

    def test_change_during_materialized_scan_is_replayed_next_tick(self):
        self.populate()
        original = storage._event_page
        changed = False

        def page_then_change(*args, **kwargs):
            nonlocal changed
            rows = original(*args, **kwargs)
            if not changed:
                changed = True
                con = storage.connect_cold_writer(self.cold)
                con.execute("UPDATE episodic_events SET content='concurrentneedle' WHERE id=1")
                con.execute("DELETE FROM episodic_events WHERE id=2")
                event(con, 7, "appendneedle")
                con.close()
            return rows

        with patch.object(storage, "_event_page", page_then_change):
            storage.build_index(self.cold, self.hot)
        self.catch_up()
        self.assertEqual([1], self.hits("concurrentneedle"))
        self.assertEqual([7], self.hits("appendneedle"))
        with database(self.hot) as con:
            self.assertEqual(0, con.execute("SELECT count(*) FROM episodic_events WHERE id=2").fetchone()[0])

    def test_pages_bound_bytes_without_skipping_rows(self):
        self.populate(journal=False)
        target = self.root / "small-pages"
        with patch.object(migration, "PAGE_BYTES", 1):
            self.complete_migration(target, max_rows=5)
        con = sqlite3.connect(self.cold)
        storage.install_change_journal(con)
        con.commit()
        con.close()
        with patch.object(storage, "PAGE_CHARS", 1):
            self.catch_up(max_rows=3)
        with database(self.hot) as con:
            self.assertEqual(6, con.execute("SELECT count(*) FROM episodic_events").fetchone()[0])

    def complete_migration(self, target, **kwargs):
        for _ in range(100):
            stats = migration.migrate(self.cold, target, offline_confirmed=True, **kwargs)
            if stats["ready"]:
                return stats
        self.fail("migration did not complete")

    def test_dry_run_readonly_and_execute_requires_confirmation(self):
        self.populate(journal=False, legacy=True)
        target = self.root / "new"
        before = migration.file_signature(self.cold)
        report = migration.dry_run(self.cold, target)
        self.assertTrue(report["dry_run"])
        self.assertFalse(target.exists())
        self.assertEqual(before, migration.file_signature(self.cold))
        self.assertEqual(6, report["source_identity"]["max_event_id"])
        self.assertIn("episodic_fts", report["omitted_objects"])
        with self.assertRaisesRegex(migration.MigrationError, "offline-confirmed"):
            migration.migrate(self.cold, target)
        self.assertFalse(target.exists())
        result = subprocess.run([sys.executable, str(SRC / "recall_migrate.py"), "--source", str(self.cold),
                                 "--target-dir", str(target)], capture_output=True, text=True)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(json.loads(result.stdout)["dry_run"])

    def test_migration_resumes_preserves_canonical_and_omits_fts(self):
        self.populate(journal=False, legacy=True)
        con = sqlite3.connect(self.cold)
        con.execute("UPDATE sqlite_sequence SET seq=999 WHERE name='episodic_events'")
        con.commit()
        con.close()
        before = migration.file_signature(self.cold)
        target = self.root / "new"
        stats = migration.migrate(self.cold, target, offline_confirmed=True, max_rows=2, batch_rows=2)
        self.assertFalse(stats["ready"])
        self.assertLessEqual(stats["rows_processed"], 2)
        final = self.complete_migration(target, max_rows=3, batch_rows=2)
        self.assertEqual("ready", final["phase"])
        self.assertEqual(before, migration.file_signature(self.cold))
        copied = target / "memory.db"
        with database(copied) as con:
            self.assertEqual([1, 2, 3, 4, 5, 6], [r[0] for r in con.execute("SELECT id FROM episodic_events ORDER BY id")])
            self.assertEqual(0, con.execute("SELECT count(*) FROM episodic_events WHERE content_fts IS NOT NULL").fetchone()[0])
            self.assertEqual("message 1", con.execute("SELECT content FROM episodic_events WHERE id=1").fetchone()[0])
            self.assertEqual(("session-a", "{}"), con.execute("SELECT session_id,metadata_json FROM thread_aliases WHERE alias_key='alias-a'").fetchone())
            self.assertEqual(b"\x00\xffattached", con.execute("SELECT payload FROM attachments").fetchone()[0])
            self.assertEqual(3, con.execute("SELECT count(*) FROM compound_ledger").fetchone()[0])
            self.assertEqual(999, con.execute("SELECT offset FROM capture_progress").fetchone()[0])
            names = {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
            self.assertIn("original_session_index", names)
            self.assertIn("canonical_counts", names)
            self.assertIn("recall_events_insert", names)
            self.assertNotIn("episodic_fts", names)
            self.assertNotIn("episodic_fts_data", names)
            self.assertNotIn("episodic_text_fts_content", names)
            self.assertNotIn("fts_build_state", names)
            self.assertEqual(999, con.execute("SELECT seq FROM sqlite_sequence WHERE name='episodic_events'").fetchone()[0])
        self.assertTrue(migration.migrate(self.cold, target, offline_confirmed=True)["ready"])
        stats = storage.build_index(copied, self.hot)
        self.assertTrue(stats["caught_up"])
        con = storage.connect_cold_writer(copied)
        event(con, 1000, "postmigrationneedle")
        con.close()
        storage.build_index(copied, self.hot)
        self.assertEqual([1000], self.hits("postmigrationneedle"))

    def test_same_source_alias_existing_target_and_nonempty_wal_rejected(self):
        self.populate(journal=False)
        with self.assertRaisesRegex(migration.MigrationError, "different directory"):
            migration.dry_run(self.cold, self.cold.parent)
        target = self.root / "new"
        target.mkdir()
        (target / "memory.db").symlink_to(self.cold)
        with self.assertRaisesRegex(ValueError, "aliases"):
            migration.migrate(self.cold, target, offline_confirmed=True)
        other_target = self.root / "unrelated"
        other_target.mkdir()
        sqlite3.connect(other_target / "memory.db").close()
        with self.assertRaisesRegex(migration.MigrationError, "already exists"):
            migration.migrate(self.cold, other_target, offline_confirmed=True)
        con = sqlite3.connect(self.cold)
        con.execute("PRAGMA journal_mode=WAL")
        event(con, 7)
        con.commit()
        before = migration.file_signature(self.cold)
        with self.assertRaisesRegex(migration.MigrationError, "nonempty -wal"):
            migration.migrate(self.cold, self.root / "wal-target", offline_confirmed=True)
        self.assertEqual(before, migration.file_signature(self.cold))
        con.close()

    def test_non_fts_triggers_and_fts_named_ancillary_tables_preserved(self):
        self.populate(journal=False, legacy=True)
        with database(self.cold) as con:
            con.executescript("""CREATE TABLE episodic_fts_audit(id INTEGER PRIMARY KEY,note TEXT);
                INSERT INTO episodic_fts_audit VALUES(1,'keep this canonical table');
                CREATE TABLE canonical_audit(id INTEGER PRIMARY KEY);
                CREATE TRIGGER log_canonical_event AFTER INSERT ON episodic_events BEGIN
                    INSERT INTO canonical_audit VALUES(new.id); END;""")
        target = self.root / "audit"
        self.complete_migration(target)
        with database(target / "memory.db") as con:
            self.assertEqual("keep this canonical table", con.execute("SELECT note FROM episodic_fts_audit").fetchone()[0])
            self.assertEqual(0, con.execute("SELECT count(*) FROM canonical_audit").fetchone()[0])
            event(con, 99)
            self.assertEqual(99, con.execute("SELECT id FROM canonical_audit").fetchone()[0])

    def test_muse_alias_and_ledger_roundtrip(self):
        self.populate(journal=False, legacy=True)
        with database(self.cold) as con:
            event(con, 71, "Muse reasoning transcript", source="muse", speaker="assistant",
                  metadata_json='{"kind":"reasoning","cwd":"/repo/muse","parent":"root-a"}')
            con.execute("INSERT INTO thread_aliases VALUES('robob-thread:muse-a','session-a','{\"source\":\"muse\"}')")
            con.executescript("""CREATE TABLE muse_sessions(session_id TEXT PRIMARY KEY,title TEXT,parent_id TEXT);
                CREATE TABLE muse_sync_files(path TEXT PRIMARY KEY,offset INTEGER,head_sha TEXT);
                INSERT INTO muse_sessions VALUES('session-a','Muse title','root-a');
                INSERT INTO muse_sync_files VALUES('/sessions/muse-a/session.jsonl',12345,'fingerprint');""")
        target = self.root / "muse"
        self.complete_migration(target, max_rows=4, batch_rows=2)
        with database(self.cold) as src, database(target / "memory.db") as dst:
            for table in ("muse_sessions", "muse_sync_files", "thread_aliases", "attachments", "capture_progress"):
                self.assertEqual(src.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(),
                                 dst.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall())
            cols = ",".join(c for c in storage.EVENT_COLUMNS if c != "content_fts")
            self.assertEqual(src.execute(f"SELECT {cols} FROM episodic_events ORDER BY id").fetchall(),
                             dst.execute(f"SELECT {cols} FROM episodic_events ORDER BY id").fetchall())
        storage.build_index(target / "memory.db", self.hot)
        self.assertEqual([71], self.hits("reasoning", "episodic_text_fts"))

    def test_source_mutation_between_resume_is_refused(self):
        self.populate(journal=False)
        target = self.root / "new"
        migration.migrate(self.cold, target, offline_confirmed=True, max_rows=2)
        with database(self.cold) as con:
            con.execute("UPDATE episodic_events SET content='mutated' WHERE id=6")
        with self.assertRaisesRegex(migration.MigrationError, "signature/schema/max id"):
            migration.migrate(self.cold, target, offline_confirmed=True)
        with database(target / "memory.db") as con:
            self.assertEqual(0, con.execute("SELECT ready FROM recall_migration_state").fetchone()[0])

    def test_source_mutation_during_page_aborts_before_target_commit(self):
        self.populate(journal=False)
        target = self.root / "new"
        page = migration._page
        changed = False

        def mutate(*args, **kwargs):
            nonlocal changed
            rows = page(*args, **kwargs)
            if not changed:
                changed = True
                with database(self.cold) as con:
                    con.execute("UPDATE episodic_events SET content='changed' WHERE id=1")
            return rows

        with patch.object(migration, "_page", mutate):
            with self.assertRaisesRegex(migration.MigrationError, "source identity/files changed"):
                migration.migrate(self.cold, target, offline_confirmed=True)
        with database(target / "memory.db") as con:
            self.assertEqual(0, con.execute("SELECT ready FROM recall_migration_state").fetchone()[0])
            self.assertEqual(0, con.execute("SELECT sum(copied) FROM recall_migration_tables").fetchone()[0])

    def test_last_source_check_revokes_ready_after_final_commit(self):
        self.populate(journal=False)
        target = self.root / "new"
        unchanged = migration.assert_unchanged
        changed = False

        def mutate_after_ready(source, expected):
            nonlocal changed
            path = target / "memory.db"
            if path.exists() and not changed:
                with database(path) as con:
                    ready = con.execute("SELECT ready FROM recall_migration_state").fetchone()[0]
                if ready:
                    changed = True
                    with database(self.cold) as con:
                        con.execute("UPDATE episodic_events SET content='late-change' WHERE id=1")
            return unchanged(source, expected)

        with patch.object(migration, "assert_unchanged", mutate_after_ready):
            with self.assertRaisesRegex(migration.MigrationError, "source identity/files changed"):
                migration.migrate(self.cold, target, offline_confirmed=True)
        with database(target / "memory.db") as con:
            self.assertEqual(0, con.execute("SELECT ready FROM recall_migration_state").fetchone()[0])

    def test_target_id_validation_detects_tampering(self):
        self.populate(journal=False)
        target = self.root / "new"
        # Stop after all rows copied but before the validation pass.
        migration.migrate(self.cold, target, offline_confirmed=True, max_rows=12)
        with database(target / "memory.db") as con:
            con.execute("UPDATE episodic_events SET id=42 WHERE id=1")
        with self.assertRaisesRegex(migration.MigrationError, "validation failed"):
            self.complete_migration(target, max_rows=5)


if __name__ == "__main__":
    unittest.main()
