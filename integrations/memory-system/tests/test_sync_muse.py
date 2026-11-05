"""Muse Code capture: tail session.jsonl logs into a scratch memory.db."""

import importlib
import json
from replica_fixture import ready
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

SCHEMA = open(os.path.join(SRC, "schema.sql")).read().replace(
    "CHECK(source IN ('codex', 'hermes', 'opencode', 'muse'))", "CHECK(source IN ('codex', 'hermes', 'opencode'))"
)

T0 = 1_792_000_000_000_000  # microseconds


def rec(i, ptype, payload, sid="S"):
    return {
        "schema_version": 1,
        "id": f"r{i:04d}",
        "stream": {"kind": "session", "id": sid},
        "sequence": i,
        "recorded_at": T0 + i * 1_000_000,
        "record_type": "event",
        "payload_type": ptype,
        "payload": payload,
    }


def run(i, event, sid="S"):
    return rec(i, "runtime.session", {"kind": "run", "run_id": "run1", "event": event}, sid)


def main_log(sid):
    return [
        {"retained_frame": "session_permission_transaction", "children": []},
        rec(1, "runtime.session.metadata", {"record": {"workspace_root": "/repo/x", "model_id": "muse-wonder-1.0"}}, sid),
        rec(2, "runtime.user_intent.accepted", {"refill_blocks": [{"kind": "text", "text": "Fix the flaky kafka test"}]}, sid),
        run(3, {"kind": "started", "prompt": "<runtime_info>T3</runtime_info> Fix the flaky kafka test"}, sid),
        run(4, {"kind": "reasoning_committed", "text": ""}, sid),
        run(5, {"kind": "reasoning_summary_committed", "text": "Look at the consumer group rebalance"}, sid),
        run(6, {"kind": "assistant_tool_calls_committed", "tool_calls": [
            {"call_id": "c1", "name": "bash", "args": "{\"cmd\": \"go test ./kafka\"}"}]}, sid),
        run(7, {"kind": "tool_result_batch_committed", "results": [
            {"tool_call_index": 0, "tool_call_id": "c1", "text": "FAIL rebalance timeout"}]}, sid),
        run(8, {"kind": "task", "event": {"kind": "output", "chunk": "noise"}}, sid),
        run(9, {"kind": "assistant_message_committed", "message_id": "m1", "text": "Raised the session timeout; tests pass."}, sid),
        run(10, {"kind": "terminal", "terminal": "completed"}, sid),
    ]


def observer_log(sid):
    return [
        rec(1, "runtime.user_intent.accepted", {"refill_blocks": [{"kind": "text", "text": "observe"}]}, sid),
        run(2, {"kind": "started", "prompt": "You are a reminder observer for the main agent."}, sid),
        run(3, {"kind": "assistant_message_committed", "text": "no reminder"}, sid),
    ]


def write(path, records, partial=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
        f.write(partial)


class MuseSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.db = os.path.join(root, "memory.db")
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        self.sessions = os.path.join(root, "muse/sessions")
        self.status = os.path.join(root, "muse_last.json")
        self.robob_db = os.path.join(root, "nope.sqlite")
        os.environ.update(MEMORY_DB=self.db, MUSE_SESSIONS=self.sessions, ROBOB_STATE_DB=self.robob_db,
                          MUSE_STATUS=self.status)
        import sync_muse

        self.sm = importlib.reload(sync_muse)
        self.main = os.path.join(self.sessions, "2026/10/15/S1/session.jsonl")
        self.obs = os.path.join(self.sessions, "2026/10/15/S1/subagent/C1/session.jsonl")

    def tearDown(self):
        self.tmp.cleanup()
        for k in ("MEMORY_DB", "MUSE_SESSIONS", "ROBOB_STATE_DB", "MUSE_STATUS"):
            os.environ.pop(k, None)

    def sync(self, **kw):
        args = types.SimpleNamespace(full=False, only=None, deadline=0)
        vars(args).update(kw)
        return self.sm.MuseSync(args).run()

    def rows(self, sid="S1"):
        con = sqlite3.connect(self.db)
        out = con.execute(
            "SELECT turn_id, speaker, content_type, content, json_extract(metadata_json,'$.kind') FROM episodic_events"
            " WHERE source='muse' AND session_id=? ORDER BY timestamp, id",
            (sid,),
        ).fetchall()
        con.close()
        return out

    def test_widens_check_projects_and_is_idempotent(self):
        write(self.main, main_log("S1"))
        write(self.obs, observer_log("C1"))
        stats = self.sync()
        rows = self.rows()
        kinds = [(r[1], r[2], r[4]) for r in rows]
        self.assertEqual(
            kinds,
            [("user", "text", "user"), ("assistant", "text", "reasoning"), ("assistant", "tool_call", "tool_call"),
             ("system", "tool_result", "tool_result"), ("assistant", "text", "assistant")],
        )
        self.assertEqual(rows[0][3], "Fix the flaky kafka test")
        self.assertIn("go test ./kafka", rows[2][3])
        self.assertEqual(stats["skipped_observers"], 1)
        self.assertEqual(self.rows("C1"), [])
        con = sqlite3.connect(self.db)
        sql = con.execute("SELECT sql FROM sqlite_master WHERE name='episodic_events'").fetchone()[0]
        self.assertIn("'muse'", sql)
        self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        meta = con.execute("SELECT title, cwd, model, parent_id FROM muse_sessions WHERE session_id='S1'").fetchone()
        self.assertEqual(meta[1:], ("/repo/x", "muse-wonder-1.0", None))
        con.close()
        again = self.sync()
        self.assertEqual((again["changed"], again["rows"]), (0, 0))
        self.assertEqual(len(self.rows()), 5)

    def test_tails_appends_and_waits_for_partial_lines(self):
        log = main_log("S1")
        tail = json.dumps(log[-2])
        write(self.main, log[:-2], partial=tail[:40])
        self.sync()
        self.assertEqual(len(self.rows()), 4)
        write(self.main, log)
        self.sync()
        rows = self.rows()
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[-1][3], "Raised the session timeout; tests pass.")

    def test_rewritten_log_is_reprojected(self):
        write(self.main, main_log("S1"))
        self.sync()
        log = main_log("S1")
        log[2]["payload"]["refill_blocks"][0]["text"] = "A different prompt entirely"
        write(self.main, log[:3])
        stats = self.sync()
        self.assertEqual(stats["reset"], 1)
        self.assertEqual([r[3] for r in self.rows()], ["A different prompt entirely"])

    def test_failed_run_becomes_error_row(self):
        log = main_log("S1")[:3] + [run(4, {"kind": "terminal", "terminal": "failed", "reason": "model overloaded"}, "S1")]
        write(self.main, log)
        self.sync()
        self.assertEqual(self.rows()[-1][1:4], ("system", "error", "run ended: failed (model overloaded)"))

    def test_undecided_child_is_read_again(self):
        write(self.obs, observer_log("C1")[:1])
        self.sync()
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT offset, skip FROM muse_sync_files").fetchone(), (0, 0))
        con.close()
        write(self.obs, observer_log("C1"))
        stats = self.sync()
        self.assertEqual(stats["skipped_observers"], 1)
        self.assertEqual(self.rows("C1"), [])

    def test_bad_record_and_bad_file_do_not_block_others(self):
        bad = os.path.join(self.sessions, "2026/10/14/A/session.jsonl")
        log = main_log("A")
        log.insert(3, run(50, ["not", "a", "dict"], "A"))
        log.insert(3, rec(51, "runtime.session", {"kind": "run", "event": ["x"]}, "A"))
        log.insert(3, rec(52, "runtime.user_intent.accepted", {"refill_blocks": "oops", "model_messages": [None, 3]}, "A"))
        log.insert(3, run(53, {"kind": "assistant_message_committed", "text": {"x": 1}}, "A"))
        log.insert(3, rec(54, "runtime.session", {"kind": "run", "event": {"kind": "started", "prompt": 7}}, "A"))
        write(bad, log, partial="")
        with open(bad, "a") as f:
            f.write("{not json\n")
        write(self.main, main_log("S1"))
        real_project = self.sm.project

        def flaky(rec_, st, rel):
            if rec_.get("id") == "r0009" and "A" in rel:
                raise ValueError("boom")
            return real_project(rec_, st, rel)

        self.sm.project = flaky
        try:
            stats = self.sync()
        finally:
            self.sm.project = real_project
        self.assertEqual(stats["errors"], 0)
        self.assertGreaterEqual(stats["bad_records"], 1)
        self.assertEqual(len(self.rows("S1")), 5)
        self.assertEqual(len(self.rows("A")), 4)  # everything but the record that raised
        st = json.load(open(self.status))
        self.assertTrue(st["ok"])

    def test_file_error_is_isolated_and_reported(self):
        bad = os.path.join(self.sessions, "2026/10/14/A/session.jsonl")
        write(bad, main_log("A"))
        write(self.main, main_log("S1"))
        real_open = open

        def unreadable(path, *args, **kwargs):
            if os.fspath(path) == bad:
                raise PermissionError("unreadable fixture")
            return real_open(path, *args, **kwargs)

        # VM test runners may be root, where chmod(0) does not deny reads.
        with patch("builtins.open", side_effect=unreadable):
            stats = self.sync()
        self.assertEqual(stats["errors"], 1)
        self.assertEqual(len(self.rows("S1")), 5)
        st = json.load(open(self.status))
        self.assertFalse(st["ok"])
        self.assertIn("A:", st["errors"][0])

    def test_unexpected_check_raises_and_rows_never_vanish(self):
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA writable_schema=ON")
        con.execute("UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE name='episodic_events'",
                    ("CHECK(source IN ('codex', 'hermes', 'opencode'))", "CHECK(source IN ('codex','hermes','opencode'))"))
        v = con.execute("PRAGMA schema_version").fetchone()[0]
        con.execute(f"PRAGMA schema_version={v + 1}")
        con.execute("PRAGMA writable_schema=OFF")
        con.commit()
        con.close()
        write(self.main, main_log("S1"))
        with self.assertRaises(RuntimeError):
            self.sync()
        # Even if the widening were skipped, an insert that fails the CHECK must raise, not vanish.
        sm = self.sm
        args = types.SimpleNamespace(full=False, only=None, deadline=0)
        orig = sm.allow_muse_source
        sm.allow_muse_source = lambda con: False
        try:
            stats = sm.MuseSync(args).run()
        finally:
            sm.allow_muse_source = orig
        self.assertEqual(stats["errors"], 1)
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT count(*) FROM muse_sync_files WHERE size > 0").fetchone()[0], 0)
        con.close()

    def test_quiet_undecided_child_becomes_subagent(self):
        child = os.path.join(self.sessions, "2026/10/15/S1/subagent/C2/session.jsonl")
        write(child, [rec(1, "runtime.user_intent.accepted", {"refill_blocks": [{"text": "check the deploy logs"}]}, "C2")])
        old = os.stat(child).st_mtime - 3600
        os.utime(child, (old, old))
        self.sync()
        self.assertEqual([r[3] for r in self.rows("C2")], ["check the deploy logs"])
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT parent_id FROM muse_sessions WHERE session_id='C2'").fetchone()[0], "S1")
        con.close()

    def test_nested_subagent_parent_is_direct_parent(self):
        log = main_log("G1")
        log[3] = run(3, {"kind": "started", "prompt": "Investigate the flaky consumer"}, "G1")
        grand = os.path.join(self.sessions, "2026/10/15/S1/subagent/C1/subagent/G1/session.jsonl")
        write(grand, log)
        self.sync()
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT parent_id FROM muse_sessions WHERE session_id='G1'").fetchone()[0], "C1")
        con.close()

    def test_replaced_log_with_same_head_is_reprojected(self):
        log = main_log("S1")
        write(self.main, log[:6])
        self.sync()
        os.remove(self.main)
        log2 = main_log("S1")
        log2[9]["payload"]["event"]["text"] = "A totally new answer"
        write(self.main, log2[:5] + [log2[9]] + log2[6:9] + log2[10:])
        stats = self.sync()
        self.assertEqual(stats["reset"], 1)
        self.assertIn("A totally new answer", [r[3] for r in self.rows()])

    def test_chunked_read_resumes(self):
        self.sm.CHUNK_BYTES = 200
        try:
            write(self.main, main_log("S1"))
            self.sync()
        finally:
            self.sm.CHUNK_BYTES = 8 << 20
        self.assertEqual(len(self.rows()), 5)
        again = self.sync()
        self.assertEqual(again["rows"], 0)

    def test_robob_titles_and_parent_including_late_mapping(self):
        write(self.main, main_log("S1"))
        self.sync()
        con = sqlite3.connect(self.robob_db)
        ready(con)
        con.executescript("""
            CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT, provider TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, title TEXT, payload_json TEXT);
        """)
        con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)",
                    ("t-child", "muse", json.dumps({"nativeThreadRef": {"nativeId": "S1"}, "createdAt": "2026-10-15T18:34:00Z"})))
        con.execute("INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?)",
                    ("t-child", "MuseExp build", json.dumps({"lineage": {"parentThreadId": "t-parent"}})))
        for nid, at in (("ses_old", "2026-10-15T10:00:00Z"), ("ses_live", "2026-10-15T18:00:00Z"),
                        ("ses_later", "2026-10-15T19:00:00Z")):
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)",
                        ("t-parent", "opencode", json.dumps({"nativeThreadRef": {"nativeId": nid}, "createdAt": at})))
        con.commit()
        con.close()
        stats = self.sync()  # log unchanged: only the late metadata pass runs
        self.assertEqual(stats["changed"], 0)
        self.assertEqual(stats["late_meta"], 1)
        con = sqlite3.connect(self.db)
        row = con.execute("SELECT title, parent_id, robob_thread_id FROM muse_sessions WHERE session_id='S1'").fetchone()
        con.close()
        self.assertEqual(row, ("MuseExp build", "ses_live", "t-child"))

    def test_duplicate_reasoning_dropped_when_summary_exists(self):
        log = main_log("S1")
        log[4] = run(4, {"kind": "reasoning_committed", "message_id": "m0", "text": "raw thoughts"}, "S1")
        log[5] = run(5, {"kind": "reasoning_summary_committed", "message_id": "m0", "text": "Look at the rebalance"}, "S1")
        log.insert(6, run(55, {"kind": "reasoning_committed", "message_id": "m0", "text": "raw thoughts again"}, "S1"))
        write(self.main, log)
        self.sync()
        texts = [r[3] for r in self.rows() if r[4] == "reasoning"]
        self.assertEqual(texts, ["raw thoughts", "Look at the rebalance"])


if __name__ == "__main__":
    unittest.main()
