"""sync_claude: child-aware, lossless, checkpointed capture of Claude transcripts."""

import importlib
import json
import os
import sqlite3
import sys
import tempfile
import time
import types
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
SCHEMA = open(os.path.join(SRC, "schema.sql")).read()
SESSION = "11111111-aaaa-4bbb-8ccc-000000000001"
AGENT = "a1b2c3d4"
GRAND = "e5f6a7b8"


def rec(uuid, typ, text, sid=SESSION, agent=None, ts="2026-10-31T10:00:00Z", block=None, role=None):
    msg = {"role": role or ("user" if typ == "user" else "assistant"),
           "content": block if block is not None else [{"type": "text", "text": text}]}
    r = {"type": typ, "uuid": uuid, "sessionId": sid, "timestamp": ts, "cwd": "/repo", "message": msg}
    if agent:
        r["agentId"] = agent
        r["isSidechain"] = True
    return r


def write_lines(path, records, partial=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        for r in records:
            f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
        f.write(partial)


class ClaudeSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.db = os.path.join(root, "memory.db")
        self.home = os.path.join(root, "claude")
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        self.roots = [{"driver": "claudeAgent", "instance": "claudeAgent", "root": self.home,
                       "path": self.home, "exists": True}]
        self.seeded = os.path.join(root, "seeded.jsonl")
        os.environ.update(MEMORY_DB=self.db, HARNESS_SEEDED_MANIFEST=self.seeded)
        import sync_claude
        self.sc = importlib.reload(sync_claude)
        self.top = os.path.join(self.home, "projects/-repo/%s.jsonl" % SESSION)
        self.child = os.path.join(self.home, "projects/-repo/%s/subagents/agent-%s.jsonl" % (SESSION, AGENT))
        self.grand = os.path.join(self.home, "projects/-repo/%s/subagents/agent-%s.jsonl" % (SESSION, GRAND))

    def tearDown(self):
        self.tmp.cleanup()
        for k in ("MEMORY_DB", "HARNESS_SEEDED_MANIFEST"):
            os.environ.pop(k, None)

    def sync(self):
        args = types.SimpleNamespace(deadline=0)
        return self.sc.ClaudeSync(args, roots=self.roots).run()

    def rows(self, session=None):
        con = sqlite3.connect(self.db)
        q = ("SELECT session_id, turn_id, speaker, content_type, content FROM episodic_events WHERE source='claude'")
        args = ()
        if session:
            q += " AND session_id=?"
            args = (session,)
        out = con.execute(q + " ORDER BY id", args).fetchall()
        con.close()
        return out

    def test_children_keyed_by_agent_no_duplicates_on_rerun(self):
        write_lines(self.top, [rec("u1", "user", "top prompt"), rec("a1", "assistant", "top answer")])
        write_lines(self.child, [rec("cu1", "user", "child task", agent=AGENT),
                                 rec("ca1", "assistant", "child answer", agent=AGENT)])
        write_lines(self.grand, [rec("gu1", "user", "grand task", agent=GRAND)])
        self.sync()
        keys = {r[0] for r in self.rows()}
        self.assertEqual(keys, {SESSION, f"{SESSION}:agent:{AGENT}", f"{SESSION}:agent:{GRAND}"})
        self.assertNotIn(SESSION, [k for k in keys if ":agent:" in k])
        n = len(self.rows())
        self.sync()
        self.assertEqual(len(self.rows()), n)

    def test_append_adds_exactly_the_new_line(self):
        write_lines(self.top, [rec("u1", "user", "one")])
        self.sync()
        self.assertEqual(len(self.rows()), 1)
        write_lines(self.top, [rec("a1", "assistant", "two")])
        s = self.sync()
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(s["rows"], 1)

    def test_partial_last_line_waits_until_complete(self):
        full = json.dumps(rec("a1", "assistant", "finished later"))
        write_lines(self.top, [rec("u1", "user", "one")], partial=full[:30])
        self.sync()
        self.assertEqual(len(self.rows()), 1)
        with open(self.top, "a") as f:
            f.write(full[30:] + "\n")
        self.sync()
        self.assertEqual([r[4] for r in self.rows()][-1], "finished later")

    def test_shrunk_file_keeps_old_events_and_adds_new(self):
        write_lines(self.top, [rec("u1", "user", "old one"), rec("a1", "assistant", "old two")])
        self.sync()
        os.remove(self.top)
        write_lines(self.top, [rec("u9", "user", "replacement")])
        self.sync()
        contents = [r[4] for r in self.rows()]
        self.assertIn("old one", contents)
        self.assertIn("old two", contents)
        self.assertIn("replacement", contents)
        con = sqlite3.connect(self.db)
        raw = con.execute("SELECT count(*) FROM native_capture_raw WHERE path=?", (self.top,)).fetchone()[0]
        con.close()
        self.assertEqual(raw, 3)

    def test_recall_note_is_skipped(self):
        write_lines(self.top, [rec("u1", "user", "<recall>a note the hook injected</recall>"),
                               rec("u2", "user", "real prompt")])
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["real prompt"])

    def test_seeded_range_kept_raw_not_projected(self):
        write_lines(self.top, [rec("u1", "user", "seeded one"), rec("u2", "user", "seeded two"),
                               rec("u3", "user", "native new")])
        with open(self.seeded, "w") as f:
            f.write(json.dumps({"native_session_id": SESSION, "path": self.top, "first_line": 1,
                                "last_line": 2}) + "\n")
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["native new"])
        con = sqlite3.connect(self.db)
        raw = con.execute("SELECT count(*) FROM native_capture_raw WHERE path=?", (self.top,)).fetchone()[0]
        con.close()
        self.assertEqual(raw, 3)

    def test_bad_file_does_not_block_others(self):
        bad = os.path.join(self.home, "projects/-repo/broken.jsonl")
        write_lines(bad, [rec("x1", "user", "fine line")], partial="")
        real = self.sc.project

        def flaky(r, path, n):
            if "broken" in path:
                raise ValueError("boom")
            return real(r, path, n)

        self.sc.project = flaky
        try:
            write_lines(self.top, [rec("u1", "user", "still captured")])
            s = self.sync()
        finally:
            self.sc.project = real
        self.assertEqual(s["errors"], 1)
        self.assertIn("still captured", [r[4] for r in self.rows()])

    def test_missing_root_is_reported_not_empty(self):
        self.roots = [{"driver": "claudeAgent", "instance": "x", "root": "/nope", "path": "/nope", "exists": False}]
        s = self.sync()
        self.assertEqual(s["files"], 0)

    def test_tool_use_and_error_result(self):
        write_lines(self.top, [
            rec("a1", "assistant", "", block=[{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"cmd": "ls"}}]),
            rec("u2", "user", "", block=[{"type": "tool_result", "tool_use_id": "t1", "is_error": True,
                                          "content": "boom failed"}]),
        ])
        self.sync()
        kinds = [(r[2], r[3]) for r in self.rows()]
        self.assertIn(("assistant", "tool_call"), kinds)
        self.assertIn(("system", "error"), kinds)


if __name__ == "__main__":
    unittest.main()
