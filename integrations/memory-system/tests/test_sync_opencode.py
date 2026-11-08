"""OpenCode sync: messages appended after a session's first sync must reach recall."""

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from replica_fixture import ready, native_ready

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import robob_readonly

SCHEMA = open(os.path.join(SRC, "schema.sql")).read()
ATTACHMENTS = ("CREATE TABLE IF NOT EXISTS attachments(sha256 TEXT PRIMARY KEY, mime TEXT,"
               " size INTEGER NOT NULL, data BLOB NOT NULL, first_seen INTEGER NOT NULL);")

NOW = int(time.time() * 1000)


class SyncOpencodeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sync-opencode-")
        self.src_path = os.path.join(self.tmp, "opencode.db")
        self.mem_path = os.path.join(self.tmp, "memory.db")
        self.raw_path = os.path.join(self.tmp, "opencode_raw.db")
        os.environ["OPENCODE_DB"] = self.src_path
        os.environ["MEMORY_DB"] = self.mem_path
        os.environ["OPENCODE_RAW_DB"] = self.raw_path

        mem = sqlite3.connect(self.mem_path)
        mem.executescript(SCHEMA)
        mem.executescript(ATTACHMENTS)
        mem.commit()
        mem.close()

        src = sqlite3.connect(self.src_path)
        src.executescript("""
            CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
              title TEXT, metadata TEXT, time_created INTEGER, time_updated INTEGER);
            CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
              seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
            CREATE UNIQUE INDEX session_message_session_seq ON session_message(session_id, seq);
        """)
        src.execute("PRAGMA journal_mode=WAL")
        ready(src)
        src.execute("INSERT INTO session_v2 VALUES ('ses_a', NULL, '/repo', 'Title', NULL, ?, ?)",
                    (NOW - 60_000, NOW - 60_000))
        src.execute("INSERT INTO session_message VALUES ('msg_u1', 'ses_a', 'user', 1, ?, ?, ?)",
                    (NOW - 60_000, NOW - 60_000, json.dumps({"text": "first question"})))
        native_ready(src)
        src.commit()
        self.src = src

    def tearDown(self):
        self.src.close()
        for k in ("OPENCODE_DB", "MEMORY_DB", "OPENCODE_RAW_DB"):
            os.environ.pop(k, None)

    def load(self):
        import sync_opencode_v2 as s
        importlib.reload(s)
        return s

    def run_sync(self, s):
        args = type("A", (), {"full": False, "only": None, "limit": 0, "deadline": 0,
                              "progress": ""})()
        sync = s.Sync(args)
        stats = sync.run()
        sync.mem.close()
        sync.raw.close()
        sync.src.close()
        return stats

    def add_assistant(self, mid, seq, completed=True, text="assistant answer"):
        # session_v2.time_updated is left alone on purpose: that is the bug being fixed
        t = {"created": NOW - 30_000}
        if completed:
            t["completed"] = NOW - 20_000
        data = {"agent": "build", "model": {"id": "m", "providerID": "p"},
                "time": t, "content": [{"type": "text", "text": text}]}
        self.src.execute("INSERT INTO session_message VALUES (?, 'ses_a', 'assistant', ?, ?, ?, ?)",
                          (mid, seq, NOW - 30_000, NOW - 20_000, json.dumps(data)))
        self.src.execute("UPDATE ardud_native_sessions SET applied_seq=applied_seq+1 WHERE id='ses_a'")
        self.src.commit()

    def open_sync(self):
        s = self.load()
        args = type("A", (), {"full": False, "only": None, "limit": 0, "deadline": 0,
                              "progress": ""})()
        sync = s.Sync(args)
        for con in (sync.src, sync.raw, sync.mem):
            self.addCleanup(con.close)
        return sync

    def mem(self):
        return sqlite3.connect(self.mem_path)

    def test_message_added_later_reaches_recall(self):
        s = self.load()
        self.run_sync(s)
        self.add_assistant("msg_a1", 2, text="the late assistant reply")
        self.run_sync(s)

        m = self.mem()
        ids = {r[0] for r in m.execute("SELECT msg_id FROM opencode_sync_messages")}
        self.assertEqual(ids, {"msg_u1", "msg_a1"})
        texts = [r[0] for r in m.execute(
            "SELECT content FROM episodic_events WHERE source='opencode' AND session_id='ses_a'")]
        self.assertIn("the late assistant reply", texts)
        self.assertIn("first question", texts)
        m.close()

    def test_unchanged_session_is_skipped(self):
        s = self.load()
        self.run_sync(s)
        self.add_assistant("msg_a1", 2, text="late reply")
        self.run_sync(s)

        sync = s.Sync(type("A", (), {"full": False, "only": None, "limit": 0, "deadline": 0,
                                     "progress": ""})())
        self.assertEqual(sync.changed_sessions(), [])
        sync.mem.close()
        sync.raw.close()
        sync.src.close()

    def rewrite_user_same_timestamp(self):
        self.src.execute("UPDATE session_message SET data=? WHERE id='msg_u1'",
                         (json.dumps({"text": "same-ms replacement"}),))
        self.src.execute("UPDATE ardud_native_sessions SET applied_seq=2 WHERE id='ses_a'")
        self.src.commit()

    def test_same_timestamp_payload_revision_is_reprojected(self):
        s = self.load()
        self.run_sync(s)
        self.rewrite_user_same_timestamp()
        stats = self.run_sync(s)
        self.assertEqual((stats["sessions"], stats["raw_upserts"], stats["reprojected"]), (1, 1, 1))
        with closing(self.mem()) as mem:
            self.assertEqual(mem.execute("SELECT content FROM episodic_events WHERE turn_id='msg_u1'").fetchone(),
                             ("same-ms replacement",))
            self.assertEqual(mem.execute("SELECT applied_seq FROM opencode_sync_export_progress").fetchone(), (2,))

    def test_raw_commit_before_failed_projection_does_not_hide_revision_on_retry(self):
        s = self.load()
        self.run_sync(s)
        self.rewrite_user_same_timestamp()
        sync = self.open_sync()
        with patch.object(sync, "_project_chunk", side_effect=RuntimeError("projection interrupted")):
            self.assertEqual(sync.run()["errors"], 1)
        self.assertEqual(sync.mem.execute("SELECT applied_seq FROM opencode_sync_export_progress").fetchone(), (1,))
        sync = self.open_sync()
        stats = sync.run()
        self.assertEqual((stats["errors"], stats["raw_upserts"], stats["reprojected"]), (0, 0, 1))
        self.assertEqual(sync.mem.execute("SELECT content FROM episodic_events WHERE turn_id='msg_u1'").fetchone(),
                         ("same-ms replacement",))
        self.assertEqual(sync.mem.execute("SELECT applied_seq FROM opencode_sync_export_progress").fetchone(), (2,))

    def test_existing_archive_adopts_export_fence_without_recompressing_unchanged_payloads(self):
        s = self.load()
        self.run_sync(s)
        with closing(self.mem()) as mem, mem:
            mem.execute("DELETE FROM opencode_sync_export_progress")
        stats = self.run_sync(s)
        self.assertEqual((stats["sessions"], stats["raw_upserts"]), (1, 0))

    def test_unready_source_fails_before_creating_raw_archive(self):
        s = self.load()
        self.src.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")
        self.src.commit()
        with self.assertRaises(s.robob_readonly.UnsafeStateDatabase):
            s.Sync(None)
        self.assertFalse(os.path.exists(self.raw_path))

    def test_incomplete_session_is_deferred_without_global_history_gate(self):
        self.src.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='history_ready'")
        self.src.execute("UPDATE ardud_native_sessions SET applied_seq=NULL,dirty=1")
        self.src.commit()
        sync = self.open_sync()
        self.assertEqual(sync.changed_sessions(), [])
        self.assertEqual(sync.run()["errors"], 0)
        self.assertEqual(sync.mem.execute("SELECT * FROM opencode_sync_sessions").fetchall(), [])

    def test_missing_export_ledger_has_no_capture_bypass(self):
        self.src.execute("DROP TABLE ardud_native_sessions")
        self.src.commit()
        sync = self.open_sync()
        with self.assertRaises(sqlite3.OperationalError):
            sync.changed_sessions()

    def test_dirty_applied_session_is_deferred(self):
        self.src.execute("UPDATE ardud_native_sessions SET dirty=1")
        self.src.commit()
        sync = self.open_sync()
        self.assertEqual(sync.changed_sessions(), [])

    def test_message_view_remains_compatible_with_capture(self):
        self.src.executescript("""
            ALTER TABLE session_message RENAME TO message_rows;
            CREATE VIEW session_message AS
              SELECT id,session_id,type,seq,time_created,time_updated,data FROM message_rows;
        """)
        self.run_sync(self.load())
        with closing(self.mem()) as mem:
            self.assertEqual(mem.execute("SELECT msg_id FROM opencode_sync_messages").fetchall(), [("msg_u1",)])

    def test_message_page_revalidates_readiness_after_commit(self):
        sync = self.open_sync()
        pages = sync.session_messages("ses_a", page=1)
        self.assertEqual(next(pages)[0][0], "msg_u1")
        self.src.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")
        self.src.execute("INSERT INTO session_message VALUES ('partial', 'ses_a', 'user', 2, ?, ?, '{}')", (NOW, NOW))
        self.src.commit()
        with self.assertRaises(robob_readonly.UnsafeStateDatabase):
            next(pages)

    def test_message_page_rejects_stale_metadata_even_with_recent_write(self):
        sync = self.open_sync()
        pages = sync.session_messages("ses_a", page=1)
        next(pages)
        ready(self.src, updated_at=(datetime.now(timezone.utc) - timedelta(seconds=121)).isoformat())
        self.src.commit()
        with self.assertRaises(robob_readonly.UnsafeStateDatabase):
            next(pages)

    def test_message_page_rejects_session_becoming_dirty(self):
        sync = self.open_sync()
        pages = sync.session_messages("ses_a", page=1)
        next(pages)
        self.src.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='history_ready'")
        self.src.execute("UPDATE ardud_native_sessions SET dirty=1")
        self.src.commit()
        with self.assertRaises(robob_readonly.UnsafeStateDatabase):
            next(pages)

    def test_unsettled_assistant_is_retried(self):
        s = self.load()
        self.add_assistant("msg_a1", 2, completed=False, text="still streaming")
        self.run_sync(s)

        m = self.mem()
        stamp = m.execute("SELECT time_updated FROM opencode_sync_sessions "
                          "WHERE session_id='ses_a'").fetchone()[0]
        self.assertEqual(stamp, -1)
        self.assertIsNone(m.execute("SELECT 1 FROM opencode_sync_progress "
                                    "WHERE session_id='ses_a'").fetchone())
        self.assertIsNone(m.execute("SELECT 1 FROM opencode_sync_export_progress "
                                    "WHERE session_id='ses_a'").fetchone())
        m.close()

        self.src.execute("UPDATE session_message SET data=? WHERE id='msg_a1'",
                         (json.dumps({"agent": "build", "model": {"id": "m", "providerID": "p"},
                                      "time": {"created": NOW - 30_000, "completed": NOW - 20_000},
                                       "content": [{"type": "text", "text": "finished now"}]}),))
        self.src.execute("UPDATE ardud_native_sessions SET applied_seq=applied_seq+1 WHERE id='ses_a'")
        self.src.commit()
        self.run_sync(s)

        m = self.mem()
        texts = [r[0] for r in m.execute(
            "SELECT content FROM episodic_events WHERE source='opencode' AND session_id='ses_a'")]
        self.assertIn("finished now", texts)
        progress = m.execute("SELECT max_seq, msg_count FROM opencode_sync_progress "
                             "WHERE session_id='ses_a'").fetchone()
        self.assertEqual(progress, (2, 2))
        self.assertEqual(m.execute("SELECT applied_seq FROM opencode_sync_export_progress "
                                   "WHERE session_id='ses_a'").fetchone(), (3,))
        m.close()

    def test_lone_surrogate_is_cleaned(self):
        s = self.load()
        data = {"agent": "build", "model": {"id": "m", "providerID": "p"},
                "time": {"created": NOW - 30_000, "completed": NOW - 20_000},
                "content": [
                    {"type": "tool", "name": "bash", "id": "call_1",
                     "state": {"status": "completed", "input": {"cmd": "x"},
                               "content": [{"type": "text", "text": "before \udc4d after"}]}},
                    {"type": "text", "text": "smile \U0001F600 done"}]}
        self.src.execute("INSERT INTO session_message VALUES ('msg_a1', 'ses_a', 'assistant', 2, ?, ?, ?)",
                         (NOW - 30_000, NOW - 20_000, json.dumps(data)))
        self.src.commit()
        self.run_sync(s)

        m = self.mem()
        rows = dict(m.execute("SELECT content_type, content FROM episodic_events "
                              "WHERE source='opencode' AND session_id='ses_a' "
                              "AND content_type IN ('tool_result', 'text') "
                              "AND speaker IN ('system', 'assistant')").fetchall())
        self.assertEqual(rows["tool_result"], "before \ufffd after")
        self.assertIn("smile \U0001F600 done", rows["text"])
        progress = m.execute("SELECT max_seq, msg_count FROM opencode_sync_progress "
                             "WHERE session_id='ses_a'").fetchone()
        self.assertEqual(progress, (2, 2))
        m.close()

    def test_failing_session_does_not_block_others(self):
        s = self.load()
        self.src.execute("INSERT INTO session_v2 VALUES ('ses_b', NULL, '/repo', 'B', NULL, ?, ?)",
                         (NOW - 120_000, NOW - 120_000))
        self.src.execute("INSERT INTO session_message VALUES ('msg_b1', 'ses_b', 'user', 1, ?, ?, ?)",
                          (NOW - 120_000, NOW - 120_000, json.dumps({"text": "b question"})))
        native_ready(self.src)
        self.src.commit()

        class Failing(s.Sync):
            def sync_session(self, sess):
                if sess["id"] == "ses_b":
                    raise RuntimeError("boom")
                return super().sync_session(sess)

        args = type("A", (), {"full": False, "only": None, "limit": 0, "deadline": 0,
                              "progress": ""})()
        sync = Failing(args)
        stats = sync.run()
        sync.mem.close()
        sync.raw.close()
        sync.src.close()

        self.assertEqual(stats["errors"], 1)
        self.assertEqual(stats["failed"], ["ses_b"])
        m = self.mem()
        texts = [r[0] for r in m.execute(
            "SELECT content FROM episodic_events WHERE source='opencode' AND session_id='ses_a'")]
        self.assertIn("first question", texts)
        self.assertIsNone(m.execute("SELECT 1 FROM opencode_sync_sessions "
                                    "WHERE session_id='ses_b'").fetchone())
        m.close()
        sync = s.Sync(args)
        self.assertIn("ses_b", [x["id"] for x in sync.changed_sessions()])
        sync.mem.close()
        sync.raw.close()
        sync.src.close()


if __name__ == "__main__":
    unittest.main()
