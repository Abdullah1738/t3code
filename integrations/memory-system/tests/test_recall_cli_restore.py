"""Exercise the real CLI against isolated pre- and post-migration stores."""

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import build_text_fts
import recall_core as rc


class RecallCliRestoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cold = self.root / "memory.db"
        self.hot = self.root / "recall_hot.db"
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("RECALL_")}
        self.env.update(RECALL_DATA=str(self.root), PYTHONDONTWRITEBYTECODE="1",
                        PYTHONPATH=str(SRC), OPENCODE_DB=str(self.root / "absent.db"))
        with sqlite3.connect(self.root / "recall_catalog.db") as con:
            con.executescript(rc.CATALOG_SCHEMA)
            con.execute("INSERT INTO sessions(session_id,source,title,first_ts,last_ts) "
                        "VALUES('session-one','codex','CRP-14150 history',100,100)")

    def store(self, path, *, indexed=True, text_index=True, body="CRP-14150 restored history"):
        with sqlite3.connect(path) as con:
            con.executescript("""
                CREATE TABLE episodic_events(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,
                    timestamp INTEGER,speaker TEXT,content TEXT,content_type TEXT,metadata_json TEXT);
                CREATE INDEX idx_episodic_session_timestamp ON episodic_events(session_id,timestamp,id);
            """)
            con.execute("INSERT INTO episodic_events VALUES(1,'codex','session-one',100,'user',?,'text','{}')", (body,))
            con.execute("INSERT INTO episodic_events VALUES(2,'codex','tool-only',101,'tool','CRP-14150 tool secret','tool_result','{}')")
            if not indexed:
                return
            con.execute("CREATE VIRTUAL TABLE episodic_fts USING fts5(content)")
            con.execute("INSERT INTO episodic_fts(rowid,content) SELECT id,content FROM episodic_events")
            if text_index:
                for ddl in build_text_fts.DDL:
                    con.execute(ddl)
                con.execute("INSERT INTO episodic_text_fts(rowid,content,source,session_id,speaker,ts) "
                            "SELECT id,content,source,session_id,speaker,timestamp FROM episodic_events WHERE id=1")

    def cli(self, *args, **env):
        return subprocess.run([sys.executable, "-B", str(SRC / "recall_cli.py"), *args],
                              cwd=self.root, env=self.env | env, text=True, capture_output=True, timeout=5)

    def test_query_with_and_without_text_index(self):
        self.store(self.cold, indexed=False)
        for text_index in (True, False):
            path = self.root / f"hot-{text_index}.db"
            self.store(path, text_index=text_index)
            for flags in ((), ("--exact",), ("--source", "codex", "--since", "1", "--until", "200"), ("--tools",)):
                with self.subTest(text_index=text_index, flags=flags):
                    result = self.cli("query", "CRP-14150", "--json", *flags, RECALL_HOT_DB=str(path))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    sessions = json.loads(result.stdout)["sessions"]
                    ids = {s["session_id"] for s in sessions}
                    self.assertIn("session-one", ids)
                    self.assertEqual("tool-only" in ids, "--tools" in flags)
                    warnings = result.stderr.splitlines()
                    if not text_index and "--tools" not in flags:
                        self.assertEqual(len(warnings), 1, result.stderr)
                        self.assertIn("falling back to episodic_fts", warnings[0])
                    else:
                        self.assertEqual(warnings, [])

    def test_default_uses_hot_store_and_view_reads_cold(self):
        self.store(self.cold, indexed=False, body="CRP-14150 complete cold transcript")
        self.store(self.hot, body="CRP-14150 hot preview")
        result = self.cli("query", "CRP-14150", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("hot preview", json.loads(result.stdout)["sessions"][0]["hits"][0]["snippet"])
        result = self.cli("list", "-n", "3", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)[0]["session_id"], "session-one")
        result = self.cli("view", "session-one#e1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("complete cold transcript", result.stdout)

    def test_explicit_memory_override_keeps_legacy_store(self):
        self.store(self.cold, body="CRP-14150 explicit legacy store")
        self.store(self.hot, body="CRP-14150 wrong sibling")
        result = self.cli("query", "CRP-14150", "--json", RECALL_MEM_DB=str(self.cold))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("explicit legacy store", json.loads(result.stdout)["sessions"][0]["hits"][0]["snippet"])

    def test_no_indexes_reports_configuration_error(self):
        self.store(self.cold, indexed=False)
        result = self.cli("query", "CRP-14150", "--json")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("RECALL_HOT_DB", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_fallback_filters_tools_before_hit_limit(self):
        self.store(self.cold, indexed=False)
        self.store(self.hot, text_index=False)
        with sqlite3.connect(self.hot) as con:
            con.execute("UPDATE episodic_events SET content=? WHERE id=1", ("extra words " * 100 + "CRP-14150",))
            con.execute("DELETE FROM episodic_fts WHERE rowid=1")
            con.execute("INSERT INTO episodic_fts(rowid,content) SELECT id,content FROM episodic_events WHERE id=1")
            for i in range(3, 253):
                con.execute("INSERT INTO episodic_events VALUES(?,'codex','tool-only',101,'tool','CRP-14150','tool_result','{}')", (i,))
                con.execute("INSERT INTO episodic_fts(rowid,content) VALUES(?,'CRP-14150')", (i,))
        result = self.cli("query", "CRP-14150", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([s["session_id"] for s in json.loads(result.stdout)["sessions"]], ["session-one"])


if __name__ == "__main__":
    unittest.main()
