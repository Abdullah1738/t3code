"""transcript_backup_manifest: lists child files, excludes credentials, mismatch fails.

Temp dirs only:  python3 -m unittest discover -s tests -p 'test_transcript_backup.py' -v
"""
import json
import os
import sys
import tempfile
import unittest

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import transcript_backup_manifest as tbm  # noqa: E402


class Manifest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.join(self.tmp.name, "transcripts")
        self.write("claude/projects/-p/abc.jsonl", b'{"role":"user"}\n')
        self.write("claude/projects/-p/abc/subagents/agent-x.jsonl", b'{"agentId":"x"}\n')
        self.write("codex/sessions/2026/rollout.jsonl", b'{"type":"session_meta"}\n')
        self.write("codex/archived_sessions/old.jsonl", b'{"type":"session_meta"}\n')
        # credentials and databases must never reach the manifest
        self.write("claude/projects/.credentials.json", b'{"token":"SECRET"}')
        self.write("codex/auth.json", b'{"OPENAI_API_KEY":"SECRET"}')
        self.write("claude/projects/settings.local.json", b'{"x":1}')
        self.write("codex/sessions/state.sqlite", b"SQLite format 3")
        self.write("codex/sessions/state.sqlite-wal", b"wal")
        self.write("codex/sessions/key.key", b"SECRET")

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def test_lists_child_and_archived_files(self):
        paths = {f["path"] for f in tbm.build(self.root)["files"]}
        self.assertIn("claude/projects/-p/abc/subagents/agent-x.jsonl", paths)
        self.assertIn("codex/archived_sessions/old.jsonl", paths)
        self.assertIn("codex/sessions/2026/rollout.jsonl", paths)

    def test_excludes_credentials_and_sqlite(self):
        names = {os.path.basename(f["path"]) for f in tbm.build(self.root)["files"]}
        for banned in (".credentials.json", "auth.json", "settings.local.json",
                       "state.sqlite", "state.sqlite-wal", "key.key"):
            self.assertNotIn(banned, names)

    def test_manifest_matches_staged_copy(self):
        m = tbm.build(self.root, stamp="T1")
        self.assertEqual(tbm.verify(m, self.root), [])

    def test_mismatch_fails(self):
        m = tbm.build(self.root, stamp="T1")
        self.write("codex/sessions/2026/rollout.jsonl", b'{"type":"changed"}\n')
        problems = tbm.verify(m, self.root)
        self.assertTrue(any("changed since manifest" in p and "rollout.jsonl" in p for p in problems), problems)

    def test_missing_and_extra_files_fail(self):
        m = tbm.build(self.root, stamp="T1")
        os.remove(os.path.join(self.root, "codex/archived_sessions/old.jsonl"))
        self.write("codex/sessions/new.jsonl", b"{}\n")
        problems = tbm.verify(m, self.root)
        self.assertTrue(any("missing in staged copy" in p for p in problems), problems)
        self.assertTrue(any("not in manifest" in p for p in problems), problems)

    def test_write_produces_json_in_out_dir(self):
        out = os.path.join(self.tmp.name, "manifests")
        path = tbm.write(tbm.build(self.root, stamp="T2"), out)
        self.assertEqual(os.path.basename(path), "T2.json")
        self.assertIn("files", json.load(open(path)))


if __name__ == "__main__":
    unittest.main()
