"""Real native producer-to-consumer checks using only temporary SQLite fixtures."""

import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import zlib
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

import health_check
import location_reaper
import recall_core
import robob_readonly
import session_reaper
import sync_opencode_v2
from export_opencode import Exporter


class NativeExportConsumersTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / "source.sqlite"
        self.target = self.root / "readonly/opencode.sqlite"
        self.memory = self.root / "memory.sqlite"
        self.raw = self.root / "raw.sqlite"
        self.src = sqlite3.connect(self.source, isolation_level=None)
        self.addCleanup(self.src.close)
        self.src.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE session_v2(
              id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,title TEXT,metadata TEXT,
              time_created INTEGER,time_updated INTEGER,time_viewed INTEGER,time_suspended INTEGER);
            CREATE TABLE session_message(
              id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,
              time_created INTEGER,time_updated INTEGER,data TEXT);
            CREATE UNIQUE INDEX message_seq ON session_message(session_id,seq);
            CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY,seq INTEGER);
            CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,payload TEXT);
            CREATE TABLE session_pending(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
            INSERT INTO session_v2 VALUES ('ses_root',NULL,'/fixture','بحث Unicode',NULL,1,1,1,NULL);
            INSERT INTO session_v2 VALUES ('ses_child','ses_root','/fixture','Child',NULL,1,1,1,NULL);
            INSERT INTO event_sequence VALUES ('ses_root',1),('ses_child',1);
            INSERT INTO session_inbox VALUES ('inbox_child','ses_child','{}');
            INSERT INTO session_pending VALUES ('pending_child','ses_child','{}');
        """)
        # Repeated multibyte text crosses the producer's 1 KiB chunk boundaries.
        self.text = "x" * 1014 + "مرحبا 🛰 漢字 café\n" * 400
        self.payload = json.dumps({"text": self.text}, ensure_ascii=False, separators=(",", ":"))
        self.src.execute("INSERT INTO session_message VALUES ('msg_root','ses_root','user',1,1,1,?)",
                         (self.payload,))
        self.src.execute("INSERT INTO session_message VALUES ('msg_child','ses_child','user',1,1,1,?)",
                         (json.dumps({"text": "child question"}),))
        with closing(sqlite3.connect(self.memory)) as mem:
            mem.executescript((SRC / "schema.sql").read_text())
            mem.execute("CREATE TABLE attachments(sha256 TEXT PRIMARY KEY,mime TEXT,"
                        "size INTEGER NOT NULL,data BLOB NOT NULL,first_seen INTEGER NOT NULL)")
            mem.commit()
        self.args = SimpleNamespace(full=False, only=None, limit=0, deadline=0, progress="")
        self.exporter = Exporter(self.source, self.target, page_size=2, chunk_size=1024, read_ms=100)
        self.addCleanup(self.exporter.close)

    def finish(self):
        for _ in range(1000):
            if not self.exporter.step():
                return
        self.fail("fixture export did not finish within its step budget")

    def advance_until(self, predicate):
        for _ in range(1000):
            if predicate():
                return
            if not self.exporter.step():
                self.fail("fixture export published before reaching the requested stage")
        self.fail("fixture export did not reach the requested stage")

    def sync_paths(self):
        return patch.multiple(sync_opencode_v2, SRC_DB=str(self.target),
                              MEM_DB=str(self.memory), RAW_DB=str(self.raw))

    def capture(self):
        with self.sync_paths():
            sync = sync_opencode_v2.Sync(self.args)
        try:
            return sync.run()
        finally:
            sync.src.close()
            sync.raw.close()
            sync.mem.close()

    def assert_raw(self, mid, payload):
        with closing(sqlite3.connect(self.raw)) as raw:
            digest, size, compressed = raw.execute(
                "SELECT sha256,raw_size,data_zlib FROM raw_messages WHERE id=?", (mid,)).fetchone()
        data = payload.encode("utf-8")
        self.assertEqual(zlib.decompress(compressed), data)
        self.assertEqual(size, len(data))
        self.assertEqual(digest, hashlib.sha256(data).hexdigest())

    def append_reply(self):
        reply = "Réponse tardive — جواب متأخر 🛰"
        payload = json.dumps({"time": {"completed": 2}, "content": [{"type": "text", "text": reply}]},
                             ensure_ascii=False)
        # A message append need not update session_v2.time_updated.
        self.src.execute("INSERT INTO session_message VALUES ('msg_reply','ses_root','assistant',2,2,2,?)",
                         (payload,))
        self.src.execute("UPDATE event_sequence SET seq=2 WHERE aggregate_id='ses_root'")
        return reply, payload

    def test_export_view_unicode_capture_and_late_append(self):
        self.finish()
        with closing(robob_readonly.native_ro(self.target)) as exported:
            self.assertEqual(exported.execute(
                "SELECT type FROM sqlite_schema WHERE name='session_message'").fetchone(), ("view",))
            self.assertEqual(exported.execute(
                "SELECT COUNT(*),MAX(seq) FROM session_message WHERE session_id='ses_root'").fetchone(), (1, 1))
            self.assertEqual(exported.execute(
                "SELECT data FROM session_message WHERE id='msg_root'").fetchone()[0], self.payload)
        with patch.object(recall_core, "OPENCODE_DB", self.target), \
                patch.object(recall_core, "_local", threading.local()):
            with closing(recall_core.opencode_ro()) as native:
                self.assertEqual(native.execute(
                    "SELECT title FROM session_v2 WHERE id='ses_root'").fetchone(), ("بحث Unicode",))
                self.assertEqual(recall_core._opencode_edges(native)["ses_child"], {"ses_root"})
        self.assertEqual(self.capture()["errors"], 0)
        self.assert_raw("msg_root", self.payload)

        reply, payload = self.append_reply()
        self.exporter.begin_cycle()
        self.finish()
        with closing(robob_readonly.native_ro(self.target)) as exported:
            self.assertEqual(exported.execute(
                "SELECT session_id,COUNT(*),MAX(seq) FROM session_message GROUP BY session_id ORDER BY session_id"
            ).fetchall(), [("ses_child", 1, 1), ("ses_root", 2, 2)])
            self.assertEqual(exported.execute(
                "SELECT data FROM session_message WHERE id='msg_reply'").fetchone()[0], payload)
            self.assertEqual(exported.execute(
                "SELECT time_updated FROM session_v2 WHERE id='ses_root'").fetchone(), (1,))
        self.assertEqual(self.capture()["errors"], 0)
        self.assert_raw("msg_root", self.payload)
        self.assert_raw("msg_reply", payload)
        with closing(sqlite3.connect(self.memory)) as mem:
            self.assertEqual(mem.execute(
                "SELECT content FROM episodic_events WHERE turn_id='msg_root'").fetchone(), (self.text,))
            self.assertEqual(mem.execute(
                "SELECT content FROM episodic_events WHERE turn_id='msg_reply'").fetchone(), (reply,))
            self.assertEqual(mem.execute(
                "SELECT max_seq,msg_count FROM opencode_sync_progress WHERE session_id='ses_root'"
            ).fetchone(), (2, 2))

    def test_real_queues_and_dirty_session_pins_reach_health_and_reaper(self):
        self.finish()
        self.exporter.begin_cycle()
        self.advance_until(lambda: self.exporter.phase == "publish")
        self.append_reply()
        self.finish()
        with patch.object(health_check, "OC_DB", str(self.target)):
            with closing(health_check.ro(str(self.target))) as native:
                self.assertTrue(native.in_transaction)
                self.assertEqual(native.execute(
                    "SELECT id,session_id FROM session_inbox").fetchall(), [("inbox_child", "ses_child")])
                self.assertEqual(native.execute(
                    "SELECT session_id FROM session_pending WHERE id='readonly:pending:ses_root'"
                ).fetchone(), ("ses_root",))
        with patch.object(session_reaper, "OC_DB", str(self.target)):
            with closing(session_reaper.ro(str(self.target))) as native:
                sessions, busy = session_reaper.load_sessions(native)
        self.assertEqual(busy, {"ses_root", "ses_child"})
        self.assertEqual(sessions["ses_root"]["n"], 1)
        self.assertEqual(sessions["ses_child"]["parent"], "ses_root")

        self.exporter.begin_cycle()
        self.finish()
        with closing(robob_readonly.native_ro(self.target)) as native:
            sessions, busy = session_reaper.load_sessions(native)
        self.assertEqual(busy, {"ses_child"})
        self.assertEqual(sessions["ses_root"]["n"], 2)

    def test_same_millisecond_rewrite_updates_raw_and_projection_at_new_export_fence(self):
        self.finish()
        self.assertEqual(self.capture()["errors"], 0)
        replacement = self.payload.replace("مرحبا", "أهلاً")
        self.src.execute("UPDATE session_message SET data=? WHERE id='msg_root'", (replacement,))
        self.src.execute("UPDATE event_sequence SET seq=2 WHERE aggregate_id='ses_root'")
        self.exporter.begin_cycle()
        self.finish()
        with closing(robob_readonly.native_ro(self.target)) as native:
            self.assertEqual(native.execute("SELECT COUNT(*),MAX(seq),MAX(time_updated) FROM session_message"
                                            " WHERE session_id='ses_root'").fetchone(), (1, 1, 1))
        stats = self.capture()
        self.assertEqual((stats["sessions"], stats["errors"], stats["raw_upserts"], stats["reprojected"]), (1, 0, 1, 1))
        self.assert_raw("msg_root", replacement)
        with closing(sqlite3.connect(self.memory)) as mem:
            self.assertEqual(mem.execute("SELECT content FROM episodic_events WHERE turn_id='msg_root'").fetchone(),
                             (json.loads(replacement)["text"],))
            self.assertEqual(mem.execute("SELECT applied_seq FROM opencode_sync_export_progress"
                                         " WHERE session_id='ses_root'").fetchone(), (2,))
        with closing(sqlite3.connect(self.raw)) as raw:
            archived = json.loads(zlib.decompress(raw.execute(
                "SELECT row_json_zlib FROM raw_sessions WHERE id='ses_root'").fetchone()[0]))
        columns = [col[1] for col in self.src.execute("PRAGMA table_info(session_v2)")]
        original = dict(zip(columns, self.src.execute("SELECT * FROM session_v2 WHERE id='ses_root'").fetchone()))
        self.assertEqual(archived, original)
        self.assertEqual(self.capture()["sessions"], 0)

    def test_one_unstable_initial_session_does_not_block_completed_sibling(self):
        def partial_root():
            state = self.exporter.out.execute("SELECT id,offset FROM ardud_native_payload").fetchone()
            return state is not None and state[0] == "msg_root" and state[1] >= 1024

        self.advance_until(partial_root)
        replacement = self.payload.replace("مرحبا", "أهلاً")
        self.src.execute("UPDATE session_message SET data=? WHERE id='msg_root'", (replacement,))
        self.src.execute("UPDATE event_sequence SET seq=2 WHERE aggregate_id='ses_root'")
        self.finish()
        with closing(sqlite3.connect(self.target)) as exported:
            meta = dict(exported.execute("SELECT key,value FROM ardud_readonly_meta"))
            self.assertEqual((meta["ready"], meta["history_ready"]), ("1", "0"))
            self.assertEqual(exported.execute(
                "SELECT session_id FROM session_pending WHERE id='readonly:pending:ses_root'"
            ).fetchone(), ("ses_root",))
        with closing(robob_readonly.native_ro(self.target)) as native:
            self.assertEqual(native.execute(
                "SELECT id,dirty,applied_seq IS NULL FROM ardud_native_sessions ORDER BY id"
            ).fetchall(), [("ses_child", 0, 0), ("ses_root", 1, 1)])
        stats = self.capture()
        self.assertEqual((stats["sessions"], stats["errors"]), (1, 0))
        with closing(sqlite3.connect(self.memory)) as mem:
            self.assertEqual(mem.execute(
                "SELECT session_id FROM opencode_sync_sessions").fetchall(), [("ses_child",)])
            self.assertIsNone(mem.execute(
                "SELECT 1 FROM opencode_sync_progress WHERE session_id='ses_root'").fetchone())
        with closing(sqlite3.connect(self.raw)) as raw:
            self.assertEqual(raw.execute("SELECT id FROM raw_messages").fetchall(), [("msg_child",)])
        with patch.object(recall_core, "OPENCODE_DB", self.target), \
                patch.object(recall_core, "_local", threading.local()):
            with closing(recall_core.opencode_ro()) as native:
                self.assertEqual(recall_core._opencode_edges(native)["ses_child"], {"ses_root"})
        with patch.object(health_check, "OC_DB", str(self.target)), \
                patch.object(health_check, "MEM_DB", str(self.memory)):
            self.assertEqual(health_check.check_lag(), (True, "0 sessions behind; 1 sessions deferred by native export"))
        with patch.object(session_reaper, "OC_DB", str(self.target)):
            with closing(session_reaper.ro(str(self.target))) as native:
                _, busy = session_reaper.load_sessions(native)
                self.assertIn("ses_root", busy)
        with patch.object(location_reaper, "OC_DB", self.target):
            activity, _ = location_reaper.last_activity_by_dir()
            self.assertGreater(activity["/fixture"], 1)

        self.exporter.begin_cycle()
        self.finish()
        self.assertEqual(self.capture()["errors"], 0)
        self.assert_raw("msg_root", replacement)

    def test_raced_metadata_blocks_reapers_but_not_general_readers(self):
        self.finish()
        self.exporter.begin_cycle()
        self.advance_until(lambda: self.exporter.phase == "publish")
        self.append_reply()
        self.assertTrue(self.exporter.step())
        self.assertTrue(self.exporter.validating)
        self.advance_until(lambda: self.exporter.phase == "publish")
        self.src.execute("INSERT INTO session_inbox VALUES ('late_inbox','ses_root','{}')")
        self.finish()
        with closing(robob_readonly.native_ro(self.target)) as native:
            self.assertEqual(dict(native.execute(
                "SELECT key,value FROM ardud_readonly_meta"))["destructive_ready"], "0")
        with self.assertRaises(robob_readonly.UnsafeStateDatabase):
            robob_readonly.native_ro(self.target, require_destructive=True)
        with patch.object(session_reaper, "OC_DB", str(self.target)), \
                patch.object(location_reaper, "OC_DB", self.target):
            with self.assertRaises(robob_readonly.UnsafeStateDatabase):
                session_reaper.ro(str(self.target))
            with self.assertRaises(robob_readonly.UnsafeStateDatabase):
                location_reaper.last_activity_by_dir()
        self.assertEqual(self.capture()["errors"], 0)
        self.exporter.begin_cycle()
        self.finish()
        with closing(robob_readonly.native_ro(self.target, require_destructive=True)) as native:
            _, busy = session_reaper.load_sessions(native)
            self.assertIn("ses_root", busy)

    def prepare_reaper_archive(self):
        self.src.executescript("""
            DELETE FROM session_inbox;
            DELETE FROM session_pending;
            DELETE FROM session_message WHERE session_id='ses_child';
            DELETE FROM event_sequence WHERE aggregate_id='ses_child';
            DELETE FROM session_v2 WHERE id='ses_child';
        """)
        self.finish()
        self.assertEqual(self.capture()["errors"], 0)
        replica = self.root / "backup-fixture"
        replica.mkdir()
        # Only temporary fixtures are copied; no runtime database is involved.
        for source, name in ((self.memory, "memory.db"), (self.raw, "opencode_raw.db")):
            with closing(sqlite3.connect(source)) as original, closing(sqlite3.connect(replica / name)) as backup:
                original.backup(backup)
        return replica

    def reaper_after_verified_mutation(self, mutate):
        replica = self.prepare_reaper_archive()
        logs = self.root / "reaper-logs"
        logs.mkdir()
        status = logs / "status.json"
        actual_verifier = session_reaper.Verifier
        actual_ro = session_reaper.ro
        verified = []
        test = self

        class MutatingVerifier(actual_verifier):
            def check(self, sess):
                reason = super().check(sess)
                test.assertIsNone(reason)
                verified.append(sess["id"])
                test.assertEqual(self.verified_fences[sess["id"]], 1)
                mutate()
                return reason

        def fixture_ro(path):
            con = actual_ro(path)
            self.addCleanup(con.close)
            return con

        with patch.multiple(session_reaper, OC_DB=str(self.target), MEM_DB=str(self.memory),
                            REPLICA=str(replica), LOGS=str(logs), STATUS=str(status)), \
                patch.object(session_reaper, "ro", side_effect=fixture_ro), \
                patch.object(session_reaper, "Verifier", MutatingVerifier), \
                patch.object(session_reaper.backend, "is_robob", return_value=False), \
                patch.object(session_reaper, "backup_gate", return_value={"backup_ts": 9_999_999_999, "snapshot": "fixture"}), \
                patch.object(session_reaper, "running_ids", return_value=set()), \
                patch.object(session_reaper, "protected_ids", return_value=set()), \
                patch.object(session_reaper, "rollback_ids", return_value=set()), \
                patch.object(session_reaper, "http", side_effect=AssertionError("DELETE must never be sent")) as http, \
                patch.object(sys, "argv", ["session_reaper.py"]), patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(session_reaper.main(), 0)
            http.assert_not_called()
        self.assertEqual(verified, ["ses_root"])
        report = json.loads(status.read_text())
        self.assertEqual(report["state"], "done")
        self.assertEqual(report["deleted_roots"], 0)
        self.assertEqual(report["skipped"], {"changed_before_delete": 1})
        with closing(robob_readonly.native_ro(self.target, require_destructive=True)) as native:
            self.assertEqual(native.execute("SELECT COUNT(*) FROM session_v2").fetchone(), (1,))
            self.assertEqual(native.execute("SELECT time_updated,(SELECT COUNT(*) FROM session_message"
                                            " WHERE session_id='ses_root') FROM session_v2"
                                            " WHERE id='ses_root'").fetchone(), (1, 1))

    def test_reaper_does_not_delete_when_final_validation_discovers_dirty_pinned_work(self):
        def publish_dirty_pin():
            self.exporter.begin_cycle()
            self.advance_until(lambda: self.exporter.phase == "publish")
            self.append_reply()
            self.finish()
            with closing(robob_readonly.native_ro(self.target, require_destructive=True)) as native:
                self.assertEqual(native.execute("SELECT dirty,applied_seq FROM ardud_native_sessions"
                                                " WHERE id='ses_root'").fetchone(), (1, 1))
                self.assertEqual(native.execute("SELECT session_id FROM session_pending WHERE"
                                                " id='readonly:pending:ses_root'").fetchone(), ("ses_root",))
        self.reaper_after_verified_mutation(publish_dirty_pin)

    def test_reaper_does_not_delete_when_clean_applied_fence_changes_after_verification(self):
        def publish_clean_new_fence():
            self.src.execute("UPDATE session_message SET data=? WHERE id='msg_root'",
                             (self.payload.replace("مرحبا", "أهلاً"),))
            self.src.execute("UPDATE event_sequence SET seq=2 WHERE aggregate_id='ses_root'")
            self.exporter.begin_cycle()
            self.finish()
            with closing(robob_readonly.native_ro(self.target, require_destructive=True)) as native:
                self.assertEqual(native.execute("SELECT dirty,applied_seq FROM ardud_native_sessions"
                                                " WHERE id='ses_root'").fetchone(), (0, 2))
                self.assertEqual(native.execute("SELECT COUNT(*) FROM session_pending").fetchone(), (0,))
        self.reaper_after_verified_mutation(publish_clean_new_fence)


if __name__ == "__main__":
    unittest.main()
