"""OpenCode sync: messages appended after a session's first sync must reach recall."""

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

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
        src.execute("INSERT INTO session_v2 VALUES ('ses_a', NULL, '/repo', 'Title', NULL, ?, ?)",
                    (NOW - 60_000, NOW - 60_000))
        src.execute("INSERT INTO session_message VALUES ('msg_u1', 'ses_a', 'user', 1, ?, ?, ?)",
                    (NOW - 60_000, NOW - 60_000, json.dumps({"text": "first question"})))
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
        sync.run()
        sync.mem.close()
        sync.raw.close()
        sync.src.close()

    def add_assistant(self, mid, seq, completed=True, text="assistant answer"):
        # session_v2.time_updated is left alone on purpose: that is the bug being fixed
        t = {"created": NOW - 30_000}
        if completed:
            t["completed"] = NOW - 20_000
        data = {"agent": "build", "model": {"id": "m", "providerID": "p"},
                "time": t, "content": [{"type": "text", "text": text}]}
        self.src.execute("INSERT INTO session_message VALUES (?, 'ses_a', 'assistant', ?, ?, ?, ?)",
                         (mid, seq, NOW - 30_000, NOW - 20_000, json.dumps(data)))
        self.src.commit()

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
        m.close()

        self.src.execute("UPDATE session_message SET data=? WHERE id='msg_a1'",
                         (json.dumps({"agent": "build", "model": {"id": "m", "providerID": "p"},
                                      "time": {"created": NOW - 30_000, "completed": NOW - 20_000},
                                      "content": [{"type": "text", "text": "finished now"}]}),))
        self.src.commit()
        self.run_sync(s)

        m = self.mem()
        texts = [r[0] for r in m.execute(
            "SELECT content FROM episodic_events WHERE source='opencode' AND session_id='ses_a'")]
        self.assertIn("finished now", texts)
        progress = m.execute("SELECT max_seq, msg_count FROM opencode_sync_progress "
                             "WHERE session_id='ses_a'").fetchone()
        self.assertEqual(progress, (2, 2))
        m.close()


if __name__ == "__main__":
    unittest.main()
