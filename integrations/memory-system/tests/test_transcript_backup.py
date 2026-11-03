"""transcript_backup_manifest: lists child files, refuses credentials, mismatch fails.

Temp dirs only:  python3 -m unittest discover -s tests -p 'test_transcript_backup.py' -v
"""
import hashlib
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

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def test_lists_child_and_archived_files_with_instance_paths(self):
        paths = {f["path"] for f in tbm.build(self.root)["files"]}
        self.assertIn("claude/projects/-p/abc/subagents/agent-x.jsonl", paths)
        self.assertIn("codex/archived_sessions/old.jsonl", paths)
        self.assertIn("codex/sessions/2026/rollout.jsonl", paths)

    def test_build_refuses_a_stage_that_still_has_credentials(self):
        # The purge runs before build; if a credential is still staged, the run fails.
        self.write("claude/projects/.credentials.json", b'{"token":"SECRET"}')
        with self.assertRaises(tbm.Forbidden) as cm:
            tbm.build(self.root)
        self.assertIn(".credentials.json", str(cm.exception))

    def test_build_refuses_auth_settings_keys_and_sqlite(self):
        for rel in ("codex/auth.json", "claude/projects/settings.local.json",
                    "codex/sessions/state.sqlite", "codex/sessions/state.sqlite-wal", "codex/k.key"):
            self.write(rel, b"x")
        with self.assertRaises(tbm.Forbidden) as cm:
            tbm.build(self.root)
        msg = str(cm.exception)
        for name in ("auth.json", "settings.local.json", "state.sqlite", "k.key"):
            self.assertIn(name, msg)

    def test_manifest_matches_staged_copy(self):
        m = tbm.build(self.root, stamp="T1")
        self.assertEqual(tbm.verify(m, self.root), [])
        listed = {entry["path"]: entry for entry in m["files"]}
        rel = "codex/sessions/2026/rollout.jsonl"
        data = b'{"type":"session_meta"}\n'
        self.assertEqual(listed[rel]["size"], len(data))
        self.assertEqual(listed[rel]["sha256"], hashlib.sha256(data).hexdigest())

    def test_mismatch_fails(self):
        m = tbm.build(self.root, stamp="T1")
        self.write("codex/sessions/2026/rollout.jsonl", b'{"type":"changed"}\n')
        problems = tbm.verify(m, self.root)
        self.assertTrue(any("changed since manifest" in p and "rollout.jsonl" in p for p in problems), problems)

    def test_verify_reports_a_credential_that_appeared_after_the_manifest(self):
        m = tbm.build(self.root, stamp="T1")
        self.write("codex/auth.json", b'{"OPENAI_API_KEY":"SECRET"}')
        problems = tbm.verify(m, self.root)
        self.assertTrue(any("forbidden file in staged copy" in p and "auth.json" in p for p in problems), problems)

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
        with open(path) as f:
            self.assertIn("files", json.load(f))

    def test_prepare_cleans_all_roots_without_touching_symlink_targets(self):
        stage = os.path.join(self.tmp.name, "stage")
        root = os.path.join(stage, "files", "transcripts")
        os.makedirs(os.path.join(root, "missing", "subtree", "auth.json"))
        with open(os.path.join(root, "missing", "subtree", "auth.json", "key"), "w") as f:
            f.write("credential in excluded directory")
        os.makedirs(os.path.join(root, "other"))
        with open(os.path.join(root, "other", "session.jsonl"), "w") as f:
            f.write("keep")
        outside = os.path.join(self.tmp.name, "outside")
        os.mkdir(outside)
        with open(os.path.join(outside, "auth.json"), "w") as f:
            f.write("do not touch")
        os.symlink(outside, os.path.join(root, "missing", "subtree", "auth.json", "external"))
        os.symlink(outside, os.path.join(root, "other", "link"))
        os.symlink(outside, os.path.join(root, "codex"))
        manifest_dir = os.path.join(stage, "files", "transcript-manifest")
        os.mkdir(manifest_dir)
        with open(os.path.join(manifest_dir, "old.json"), "w") as f:
            f.write("old")
        tbm.prepare(stage, ["codex/sessions", "claude/projects"])
        self.assertFalse(os.path.lexists(os.path.join(root, "missing", "subtree", "auth.json")))
        self.assertFalse(os.path.lexists(os.path.join(root, "other", "link")))
        self.assertTrue(os.path.isfile(os.path.join(root, "other", "session.jsonl")))
        self.assertTrue(os.path.isfile(os.path.join(outside, "auth.json")))
        self.assertTrue(os.path.isdir(os.path.join(root, "codex", "sessions")))
        self.assertEqual(os.listdir(manifest_dir), [])
        self.assertEqual(tbm.verify(tbm.build(root), root), [])

    def test_manifest_fails_closed_on_links_and_special_files(self):
        for name, target in (("file-link", "no-file"), ("dir-link", self.root)):
            os.symlink(target, os.path.join(self.root, name))
        os.mkfifo(os.path.join(self.root, "pipe"))
        with self.assertRaises(tbm.Forbidden) as cm:
            tbm.build(self.root)
        for name in ("file-link", "dir-link", "pipe"):
            self.assertIn(name, str(cm.exception))

    def test_stage_and_transcript_root_must_not_be_symlinks(self):
        stage = os.path.join(self.tmp.name, "stage")
        os.makedirs(os.path.join(stage, "files"))
        os.symlink(self.root, os.path.join(stage, "files", "transcripts"))
        with self.assertRaises(tbm.Forbidden):
            tbm.prepare(stage, ["codex/sessions"])
        with self.assertRaises(tbm.Forbidden):
            tbm.build(os.path.join(stage, "files", "transcripts"))

    def test_verify_rejects_duplicate_and_malformed_manifests(self):
        manifest = tbm.build(self.root)
        manifest["files"].append(manifest["files"][0])
        self.assertIn("duplicate manifest path", tbm.verify(manifest, self.root)[0])
        self.assertEqual(tbm.verify({"files": []}, self.root), ["invalid manifest root"])
        self.assertEqual(tbm.verify({"root": "transcripts"}, self.root), ["invalid manifest files"])

    def test_publish_copies_verified_bytes_and_refuses_changed_tree(self):
        staged_dir = os.path.join(self.tmp.name, "manifest-staging")
        published_dir = os.path.join(self.tmp.name, "data", "backup-manifests")
        path = tbm.write(tbm.build(self.root, stamp="T2"), staged_dir)
        published = tbm.publish(path, self.root, published_dir)
        with open(path, "rb") as before, open(published, "rb") as after:
            self.assertEqual(before.read(), after.read())
        self.write("extra.jsonl", b"changed")
        with self.assertRaises(tbm.Forbidden):
            tbm.publish(path, self.root, published_dir)

    def test_prepare_fails_on_unsupported_entries(self):
        stage = os.path.join(self.tmp.name, "stage")
        root = os.path.join(stage, "files", "transcripts")
        os.makedirs(root)
        os.mkfifo(os.path.join(root, "pipe"))
        with self.assertRaises(tbm.Forbidden):
            tbm.prepare(stage, ["codex/sessions"])


if __name__ == "__main__":
    unittest.main()
