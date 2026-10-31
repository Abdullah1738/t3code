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
        write_rollout(self.rollout, [meta(CHILD_ID, ROOT_ID, ordinal=2), msg("user", "inherited prompt"),
                                     msg("assistant", "inherited answer"), msg("user", "own prompt")])
        s = self.sync()
        self.assertEqual([r[4] for r in self.rows()], ["own prompt"])
        con = sqlite3.connect(self.db)
        self.assertEqual(con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0], 4)
        con.close()
        self.assertEqual(s["skipped_inherited"], 2)

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
        old = self.sx.ZSTD
        self.sx.ZSTD = None
        try:
            s = self.sync()
        finally:
            self.sx.ZSTD = old
        self.assertEqual(s["errors"], 1)
        self.assertIn("still here", [r[4] for r in self.rows()])


if __name__ == "__main__":
    unittest.main()
