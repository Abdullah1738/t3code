"""sync_codex: rollouts (plain, .zst, archived), root vs thread id, inherited history skipped, no duplicates."""

import hashlib
import importlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import types
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
SCHEMA = open(os.path.join(SRC, "schema.sql")).read()
ROOT_ID = "019aaaaa-root-0000-0000-000000000001"
CHILD_ID = "019bbbbb-child-0000-0000-000000000002"
ZSTD = shutil.which("zstd")


def meta(thread, root, ordinal=None):
    p = {"id": thread, "session_id": root}
    if ordinal is not None:
        p["subagent_history_start_ordinal"] = ordinal
    return {"type": "session_meta", "payload": p}


def msg(role, text):
    return {"type": "response_item", "payload": {"type": "message", "role": role,
                                                  "content": [{"type": "input_text", "text": text}]}}


def fcall(name, args, call_id):
    return {"type": "response_item", "payload": {"type": "function_call", "name": name,
                                                  "arguments": args, "call_id": call_id}}


def fout(call_id, out):
    return {"type": "response_item", "payload": {"type": "function_call_output", "call_id": call_id, "output": out}}


def write_rollout(path, lines, partial=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        for r in lines:
            f.write(json.dumps(r) + "\n")
        f.write(partial)


class CodexSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.db = os.path.join(root, "memory.db")
        self.home = os.path.join(root, "codex")
        con = sqlite3.connect(self.db)
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        self.seeded = os.path.join(root, "seeded.jsonl")
        os.environ.update(MEMORY_DB=self.db, HARNESS_SEEDED_MANIFEST=self.seeded)
        import sync_codex
        self.sx = importlib.reload(sync_codex)
        self.roots = [{"driver": "codex", "instance": "codex", "root": self.home, "path": self.home, "exists": True}]
        self.rollout = os.path.join(self.home, "sessions/2026/10/31/rollout-2026-10-31T10-00-00-%s.jsonl" % CHILD_ID)

    def tearDown(self):
        self.tmp.cleanup()
        for k in ("MEMORY_DB", "HARNESS_SEEDED_MANIFEST"):
            os.environ.pop(k, None)

    def sync(self):
        return self.sx.CodexSync(types.SimpleNamespace(deadline=0), roots=self.roots).run()

    def rows(self):
        con = sqlite3.connect(self.db)
        out = con.execute("SELECT session_id, turn_id, speaker, content_type, content,"
                          " json_extract(metadata_json,'$.root_session_id') FROM episodic_events"
                          " WHERE source='codex' ORDER BY id").fetchall()
        con.close()
        return out

    def test_child_keyed_by_thread_id_with_root_in_metadata(self):
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "child job"),
                                     msg("assistant", "child done")])
        self.sync()
        rows = self.rows()
        self.assertEqual({r[0] for r in rows}, {CHILD_ID})
        self.assertEqual({r[5] for r in rows}, {ROOT_ID})

    def test_inherited_history_before_ordinal_skipped_but_raw_kept(self):
        # start = 3: records 1 and 2 are inherited, record 3 is the child's first own record
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID, ordinal=3), msg("user", "inherited prompt"),
                                     msg("assistant", "inherited answer"), msg("user", "own prompt")])
        s = self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["own prompt"])
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0], 4)
        con.close()
        self.assertEqual(s["skipped_inherited"], 2)

    def test_boundary_uses_record_ordinal_not_line_count(self):
        """0.166 paginated records carry their own 'ordinal'; the first child record is ordinal == start.

        Records before the start are inherited (dropped). Non-message records (event lines) still
        occupy ordinals, so counting response_item lines would shift the boundary.
        """
        def stamped(rec, ordinal):
            rec = dict(rec, ordinal=ordinal)
            return rec
        lines = [
            meta(CHILD_ID, ROOT_ID, ordinal=3),
            stamped({"type": "event_msg", "payload": {"type": "task_started"}}, 0),
            stamped(msg("user", "inherited 1"), 1),
            stamped({"type": "event_msg", "payload": {"type": "agent_message"}}, 2),
            stamped(msg("assistant", "first own record"), 3),
        ]
        write_rollout(self.rollout, lines)
        s = self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["first own record"])
        # records with ordinal 0, 1, 2 are inherited (strictly before the start, 3)
        self.assertEqual(s["skipped_inherited"], 3)

    def test_tool_call_output_and_error_projected(self):
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), fcall("shell", "{\"cmd\":\"ls\"}", "c1"),
                                     fout("c1", "file.txt"),
                                     {"type": "event_msg", "payload": {"type": "error", "message": "rate limited"}}])
        self.sync()
        kinds = [(r[2], r[3]) for r in self.rows()]
        self.assertEqual(kinds, [("assistant", "tool_call"), ("system", "tool_result"), ("system", "error")])

    def test_rerun_and_append_no_duplicates(self):
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "one")])
        self.sync()
        self.sync()
        self.assertEqual(len(self.rows()), 1)
        write_rollout(self.rollout, [msg("assistant", "two")])
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["one", "two"])

    def test_archive_move_does_not_duplicate(self):
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "moved")])
        self.sync()
        archived = os.path.join(self.home, "archived_sessions", os.path.basename(self.rollout))
        os.makedirs(os.path.dirname(archived), exist_ok=True)
        shutil.move(self.rollout, archived)
        self.sync()
        self.assertEqual(len(self.rows()), 1)

    @unittest.skipUnless(ZSTD, "zstd binary not installed")
    def test_zst_rollout_is_read(self):
        plain = os.path.join(self.tmp.name, "plain.jsonl")
        write_rollout(plain, [meta(CHILD_ID, ROOT_ID), msg("user", "compressed prompt")])
        zst = self.rollout + ".zst"
        os.makedirs(os.path.dirname(zst), exist_ok=True)
        import subprocess
        subprocess.run([ZSTD, "-q", "-o", zst, plain], check=True)
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["compressed prompt"])

    def test_missing_zstd_is_recorded_error_and_others_continue(self):
        zst = os.path.join(self.home, "sessions/2026/10/31/rollout-x.jsonl.zst")
        os.makedirs(os.path.dirname(zst), exist_ok=True)
        with open(zst, "wb") as f:
            f.write(b"not really zstd")
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "still here")])
        import transcript_capture as tc
        real = tc.zstd_bin
        tc.zstd_bin = lambda: None
        try:
            s = self.sync()
        finally:
            tc.zstd_bin = real  # restored even when the run fails: no state leaks into other tests
        self.assertEqual(s["errors"], 1)
        self.assertIn("still here", [r[4] for r in self.rows()])
        con = sqlite3.connect(self.db)
        err, count, quarantined = con.execute(
            "SELECT error, error_count, quarantined_until FROM native_capture_files WHERE path=?", (zst,)).fetchone()
        con.close()
        self.assertIn("zstd missing", err)
        self.assertEqual(count, 1)
        self.assertGreater(quarantined, 0)

    def test_resumed_pass_equals_single_pass(self):
        """Chunked resume and one full pass produce the same rows (same turn ids, same count)."""
        pad = "y" * 40000
        base = [meta(CHILD_ID, ROOT_ID, ordinal=2)] + [msg("user", f"inh {i} {pad}") for i in range(3)]
        base[1]["ordinal"] = 0
        own = [dict(msg("user", f"own {i} {pad}"), ordinal=i + 2) for i in range(300)]
        # a single pass over everything
        write_rollout(self.rollout, base + own)
        self.sync()
        single = sorted(r[1] for r in self.rows())
        con = sqlite3.connect(self.db)
        con.execute("DELETE FROM episodic_events WHERE source='codex'")
        con.execute("DELETE FROM native_capture_raw")
        con.execute("DELETE FROM native_capture_files")
        con.commit()
        con.close()
        # the same content, written and synced in several passes
        os.remove(self.rollout)
        write_rollout(self.rollout, base + own[:120])
        self.sync()
        write_rollout(self.rollout, own[120:200])
        self.sync()
        write_rollout(self.rollout, own[200:])
        self.sync()
        chunked = sorted(r[1] for r in self.rows())
        self.assertEqual(len(chunked), len(single))
        self.assertEqual(chunked, single)

    def test_replay_past_eight_mib_keeps_numbering(self):
        """Resume must replay the whole consumed prefix; a single 8 MiB batch restarted line numbers."""
        pad = "x" * 60000
        lines = [meta(CHILD_ID, ROOT_ID)]
        for i in range(400):  # ~24 MB of prefix: several 8 MiB batches
            lines.append(msg("user", f"row {i} {pad}"))
        write_rollout(self.rollout, lines)
        self.sync()
        first_rows = len(self.rows())
        write_rollout(self.rollout, [msg("assistant", "after the prefix")])
        self.sync()
        rows = self.rows()
        self.assertEqual(len(rows), first_rows + 1)
        self.assertEqual(rows[-1][4], "after the prefix")
        ids = [r[1] for r in rows]
        self.assertEqual(len(ids), len(set(ids)))

    @unittest.skipUnless(ZSTD, "zstd binary not installed")
    def test_unchanged_zst_is_not_rejournaled(self):
        plain = os.path.join(self.tmp.name, "plain.jsonl")
        write_rollout(plain, [meta(CHILD_ID, ROOT_ID), msg("user", "stable")] + [msg("user", "x" * 3000)] * 20)
        zst = self.rollout + ".zst"
        os.makedirs(os.path.dirname(zst), exist_ok=True)
        import subprocess
        subprocess.run([ZSTD, "-q", "-o", zst, plain], check=True)
        self.sync()
        con = sqlite3.connect(self.db)
        raw1 = con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0]
        con.close()
        self.sync()
        self.sync()
        con = sqlite3.connect(self.db)
        raw2 = con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0]
        reps = con.execute("SELECT count(*) FROM native_capture_files WHERE retired=0").fetchone()[0]
        con.close()
        self.assertEqual(raw2, raw1)
        self.assertEqual(reps, 1)

    @unittest.skipUnless(ZSTD, "zstd binary not installed")
    def test_unchanged_zst_costs_no_decode_and_changed_zst_is_read(self):
        """An unchanged archive is not decoded on later ticks; a re-compressed larger one is read."""
        import subprocess
        plain = os.path.join(self.tmp.name, "plain.jsonl")
        write_rollout(plain, [meta(CHILD_ID, ROOT_ID), msg("user", "first")])
        zst = self.rollout + ".zst"
        os.makedirs(os.path.dirname(zst), exist_ok=True)
        subprocess.run([ZSTD, "-q", "-o", zst, plain], check=True)
        self.sync()
        import transcript_capture as tc
        real = tc.zstd_bin
        decodes = {"n": 0}
        real_head = tc.decompressed_head

        def counting(path, length):
            decodes["n"] += 1
            return real_head(path, length)

        tc.decompressed_head = counting
        try:
            self.sync()
            self.sync()
        finally:
            tc.decompressed_head = real_head
        self.assertEqual(decodes["n"], 0)
        write_rollout(plain, [msg("assistant", "appended later")] * 30)
        os.remove(zst)
        subprocess.run([ZSTD, "-q", "-o", zst, plain], check=True)
        self.sync()
        self.assertIn("appended later", [r[4] for r in self.rows()])

    def test_seeded_record_still_advances_identity_state(self):
        """A seeded record's effect on the projector must match the replay path (no events, but state)."""
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "transplanted"),
                                     msg("assistant", "transplanted answer"), msg("user", "genuine child work")])
        with open(self.seeded, "w") as f:
            f.write(json.dumps({"native_session_id": CHILD_ID, "path": self.rollout, "first_line": 2,
                                "last_line": 3}) + "\n")
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["genuine child work"])
        write_rollout(self.rollout, [msg("assistant", "later")])
        self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["genuine child work", "later"])

    def test_seeded_range_matches_after_compression(self):
        """A manifest written for the .jsonl must still suppress the same lines after .jsonl.zst."""
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), msg("user", "transplanted")])
        with open(self.seeded, "w") as f:
            f.write(json.dumps({"native_session_id": CHILD_ID, "path": self.rollout, "first_line": 2,
                                "last_line": 2}) + "\n")
        self.sync()
        self.assertEqual(self.rows(), [])
        zst = self.rollout + ".zst"
        import subprocess
        if ZSTD:
            subprocess.run([ZSTD, "-q", "-o", zst, self.rollout], check=True)
            os.remove(self.rollout)
            write_rollout(zst.replace(".zst", ""), [])  # no-op: keep the plain path absent
            os.remove(zst.replace(".zst", "")) if os.path.exists(zst.replace(".zst", "")) else None
            self.sync()
            self.assertEqual(self.rows(), [])
            raw = sqlite3.connect(self.db).execute("SELECT count(*) FROM native_capture_raw").fetchone()[0]
            self.assertGreaterEqual(raw, 2)

    def test_timestamps_keep_the_transcript_time(self):
        rec = msg("user", "old work")
        rec["timestamp"] = "2026-07-31T06:53:47.268Z"
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID), rec])
        self.sync()
        con = sqlite3.connect(self.db)
        ts = con.execute("SELECT timestamp FROM episodic_events WHERE source='codex'").fetchone()[0]
        con.close()
        import datetime
        self.assertEqual(ts, int(datetime.datetime(2026, 7, 31, 6, 53, 47, tzinfo=datetime.timezone.utc).timestamp()))

    def test_raw_journal_keeps_invalid_utf8_exactly(self):
        bad = b'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"caf\xff"}]},"timestamp":"2026-10-31T10:00:00Z"}\n'
        os.makedirs(os.path.dirname(self.rollout), exist_ok=True)
        with open(self.rollout, "wb") as f:
            f.write((json.dumps(meta(CHILD_ID, ROOT_ID)) + "\n").encode())
            f.write(bad)
        self.sync()
        con = sqlite3.connect(self.db)
        raws = [bytes(r[0]) for r in con.execute("SELECT raw FROM native_capture_raw ORDER BY line_no")]
        shas = [r[0] for r in con.execute("SELECT sha1 FROM native_capture_raw ORDER BY line_no")]
        con.close()
        self.assertEqual(raws[1], bad)
        self.assertEqual(shas[1], hashlib.sha1(bad).hexdigest())


if __name__ == "__main__":
    unittest.main()
