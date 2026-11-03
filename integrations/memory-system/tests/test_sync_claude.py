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

    def test_timestamps_keep_transcript_time_not_local(self):
        rec_ = rec("u1", "user", "old work", ts="2026-07-31T06:53:47.268Z")
        write_lines(self.top, [rec_])
        self.sync()
        con = sqlite3.connect(self.db)
        ts = con.execute("SELECT timestamp FROM episodic_events WHERE source='claude'").fetchone()[0]
        con.close()
        import datetime
        self.assertEqual(ts, int(datetime.datetime(2026, 7, 31, 6, 53, 47, 268000,
                                                    tzinfo=datetime.timezone.utc).timestamp()))

    def test_raw_journal_keeps_invalid_utf8_exactly(self):
        bad = (json.dumps(rec("u1", "user", "caf")) + "\n").encode()
        bad = bad.replace(b"caf", b"caf\xff")
        os.makedirs(os.path.dirname(self.top), exist_ok=True)
        with open(self.top, "wb") as f:
            f.write(bad)
        self.sync()
        con = sqlite3.connect(self.db)
        raw = bytes(con.execute("SELECT raw FROM native_capture_raw ORDER BY line_no").fetchone()[0])
        sha = con.execute("SELECT sha1 FROM native_capture_raw ORDER BY line_no").fetchone()[0]
        con.close()
        import hashlib
        self.assertEqual(raw, bad)
        self.assertEqual(sha, hashlib.sha1(bad).hexdigest())

    def test_failing_file_is_recorded_and_quarantined(self):
        bad = os.path.join(self.home, "projects/-repo/broken.jsonl")
        write_lines(bad, [rec("x1", "user", "fine")])
        real = self.sc.project

        def boom(r, path, n):
            if "broken" in path:
                raise ValueError("boom")
            return real(r, path, n)

        self.sc.project = boom
        try:
            self.sync()
        finally:
            self.sc.project = real
        con = sqlite3.connect(self.db)
        err, count, until = con.execute(
            "SELECT error, error_count, quarantined_until FROM native_capture_files WHERE path=?", (bad,)).fetchone()
        con.close()
        self.assertIn("boom", err)
        self.assertEqual(count, 1)
        self.assertGreater(until, time.time())

    def test_equal_agent_filenames_under_two_parents_do_not_collide(self):
        """agent-X.jsonl under two parents is two transcripts: neither retires or re-journals the other."""
        a = os.path.join(self.home, "projects/-repo/PARENT-A/subagents/agent-same.jsonl")
        b = os.path.join(self.home, "projects/-repo/PARENT-B/subagents/agent-same.jsonl")
        write_lines(a, [rec("ua1", "user", "from parent A", agent="same")])
        write_lines(b, [rec("ub1", "user", "from parent B", agent="same")])
        self.sync()
        self.sync()
        con = sqlite3.connect(self.db)
        live = con.execute("SELECT count(*) FROM native_capture_files WHERE retired=0").fetchone()[0]
        retired = con.execute("SELECT count(*) FROM native_capture_files WHERE retired=1").fetchone()[0]
        raw = con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0]
        con.close()
        self.assertEqual(live, 2)
        self.assertEqual(retired, 0)
        self.assertEqual(raw, 2)  # each line journaled once, not once per tick
        self.assertEqual(sorted(r[4] for r in self.rows()), ["from parent A", "from parent B"])

    def test_first_encounter_read_failure_is_quarantined_and_others_continue(self):
        """A file that cannot be read on its first pass still gets a durable failure row."""
        bad = os.path.join(self.home, "projects/-repo/unreadable.jsonl")
        write_lines(bad, [rec("x1", "user", "never read")])
        write_lines(self.top, [rec("u1", "user", "captured meanwhile")])
        real_open = open

        def deny(path, *a, **k):
            if path == bad:
                raise PermissionError(13, "Permission denied", path)
            return real_open(path, *a, **k)

        import builtins
        builtins.open = deny
        try:
            s = self.sync()
        finally:
            builtins.open = real_open
        self.assertEqual(s["errors"], 1)
        self.assertIn("captured meanwhile", [r[4] for r in self.rows()])
        con = sqlite3.connect(self.db)
        row = con.execute("SELECT error, quarantined_until FROM native_capture_files WHERE path=?", (bad,)).fetchone()
        con.close()
        self.assertIsNotNone(row, "no ledger row for a file that failed on its first pass")
        self.assertIn("PermissionError", row[0])
        self.assertGreater(row[1], time.time())


if __name__ == "__main__":
    unittest.main()
