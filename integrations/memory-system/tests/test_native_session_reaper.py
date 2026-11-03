"""native_session_reaper: report-only never unlinks; uncaptured files are not listed.

Temp dirs only:  python3 -m unittest discover -s tests -p 'test_native_session_reaper.py' -v
"""
import io
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import native_session_reaper as nsr  # noqa: E402
import sync_thread_identity as ti  # noqa: E402
import transcript_backup_manifest as tbm  # noqa: E402
import transcript_capture as tc  # noqa: E402
import transcript_roots as tr  # noqa: E402



def fake_entries(homes):
    """D1 manifest entries (transcript_roots.json shape) rooted in a temp dir."""
    return [{"driver": "claudeAgent", "instance": "claudeAgent", "root": os.path.join(homes, "claude")},
            {"driver": "codex", "instance": "codex", "root": os.path.join(homes, "codex")},
            {"driver": "codex", "instance": "codex-cu", "root": os.path.join(homes, "codex-cu")}]

class ReportOnly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # realpath: D1's resolve() realpaths roots (macOS /var -> /private/var), and so do ledger keys.
        self.homes = os.path.join(os.path.realpath(self.tmp.name), "harness-homes")
        self.stage = os.path.join(self.tmp.name, "staged-transcripts")
        self.now = 1_800_000_000.0
        self.old = self.now - 200 * 86400
        self.file = self.write("codex/sessions/2026/rollout-old.jsonl", b'{"type":"session_meta"}\n')
        os.utime(self.file, (self.old, self.old))
        self.back_up()
        self.ledger = {self.file: self.capture(self.file)}
        p = mock.patch.object(tr, "load", return_value=fake_entries(self.homes))
        p.start()
        self.addCleanup(p.stop)

    def write(self, rel, data):
        path = os.path.join(self.homes, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def roots(self):
        return tr.resolve()

    def capture(self, path):
        st = os.stat(path)
        with open(path, "rb") as f:
            content = f.read()
        head_len = min(len(content), 4096)
        rel = os.path.relpath(path, self.homes)
        instance = {"claude": "claudeAgent", "codex": "codex", "codex-cu": "codex-cu"}[rel.split(os.sep)[0]]
        return {"offset": len(content), "phys_size": len(content), "inode": st.st_ino,
                "head_len": head_len, "head_sha1": hashlib.sha1(content[:head_len]).hexdigest(),
                "tail_sha1": hashlib.sha1(content[-4096:]).hexdigest(), "retired": 0,
                "error_count": 0, "instance": instance, "thread_id": "th-settled"}

    def make_ledger(self, session_key="native-session"):
        db = os.path.join(self.tmp.name, "memory.db")
        row = self.capture(self.file)
        with closing(sqlite3.connect(db)) as con, con:
            con.executescript(tc.DDL)
            con.executescript(ti.DDL)
            con.execute(
                "INSERT INTO native_capture_files(path,logical,inode,head_len,head_sha1,tail_sha1,"
                "offset,phys_size,error_count,retired,complete,instance,session_key)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.file, "codex:old", row["inode"], row["head_len"], row["head_sha1"], row["tail_sha1"],
                 row["offset"], row["phys_size"], 0, 0, 1, "codex", session_key),
            )
            con.execute(
                "INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id)"
                " VALUES ('alias','th-settled','th-settled','codex','codex',?)", (session_key,)
            )
        return db

    def back_up(self):
        shutil.copytree(self.homes, self.stage, dirs_exist_ok=True)
        self.manifest = tbm.build(self.stage, stamp="M")

    def test_candidate_listed_when_settled_captured_and_in_manifest(self):
        self.assertEqual(self.manifest["files"][0]["path"], "codex/sessions/2026/rollout-old.jsonl")
        out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual([c["path"] for c in out], [self.file])

    def test_ledger_alias_binds_settled_captured_file_without_thread_id_column(self):
        db = self.make_ledger()
        with closing(sqlite3.connect(db)) as con:
            self.assertNotIn("thread_id", {col[1] for col in con.execute("PRAGMA table_info(native_capture_files)")})
        ledger = nsr.load_ledger(db)
        self.assertEqual(ledger[self.file]["thread_id"], "th-settled")
        out = nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual([(c["path"], c["thread_id"]) for c in out], [(self.file, "th-settled")])

    def test_alias_must_belong_to_the_ledger_database(self):
        db = self.make_ledger()
        other = os.path.join(self.tmp.name, "other-memory.db")
        shutil.copyfile(db, other)
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("DELETE FROM thread_aliases")
        self.assertEqual(nsr.load_ledger(db), {})
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("DROP TABLE thread_aliases")
            con.execute("CREATE TABLE thread_aliases (canonical_thread_id TEXT)")
        self.assertEqual(nsr.load_ledger(db), {})
        self.assertEqual(nsr.load_ledger(other)[self.file]["thread_id"], "th-settled")

    def test_ambiguous_or_missing_alias_never_qualifies(self):
        db = self.make_ledger()
        with closing(sqlite3.connect(db)) as con, con:
            con.execute(
                "INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id,agent_id)"
                " VALUES ('child','th-settled','th-settled','codex','codex','parent','native-session')"
            )
        ledger = nsr.load_ledger(db)
        self.assertNotIn(self.file, ledger)
        self.assertEqual(nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now), [])
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("DELETE FROM thread_aliases")
        self.assertEqual(nsr.load_ledger(db), {})

    def test_codex_child_alias_qualifies_its_own_settled_thread(self):
        db = self.make_ledger("child-session")
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("UPDATE thread_aliases SET native_id='parent-session', agent_id='child-session'")
            con.execute(
                "INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id)"
                " VALUES ('parent','unsettled','unsettled','codex','codex','parent-session')"
            )
        ledger = nsr.load_ledger(db)
        self.assertEqual(ledger[self.file]["thread_id"], "th-settled")
        self.assertEqual(len(nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now)), 1)

    def test_claude_child_alias_qualifies_its_own_settled_thread(self):
        child = self.write("claude/projects/repo/sid/subagents/agent-X.jsonl", b'{"sessionId":"sid"}\n')
        os.utime(child, (self.old, self.old))
        self.back_up()
        row = self.capture(child)
        db = self.make_ledger()
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("UPDATE native_capture_files SET path=?,logical=?,inode=?,head_len=?,head_sha1=?,tail_sha1=?,"
                        "offset=?,phys_size=?,instance='claudeAgent',session_key='sid:agent:X'",
                        (child, "claude:child", row["inode"], row["head_len"], row["head_sha1"], row["tail_sha1"],
                         row["offset"], row["phys_size"]))
            con.execute("UPDATE thread_aliases SET driver='claudeAgent',instance='claudeAgent',native_id='sid',agent_id='X'")
            con.execute(
                "INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id)"
                " VALUES ('parent','unsettled','unsettled','claudeAgent','claudeAgent','sid')"
            )
        ledger = nsr.load_ledger(db)
        self.assertEqual(ledger[child]["thread_id"], "th-settled")
        out = nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual([item["path"] for item in out], [child])

    def test_duplicate_live_path_is_ambiguous_even_if_one_identity_is_missing(self):
        db = self.make_ledger()
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("INSERT INTO native_capture_files(path,logical,instance) VALUES (?,?,?)",
                        (self.file, "other", "codex"))
        self.assertNotIn(self.file, nsr.load_ledger(db))

    def test_database_path_with_uri_characters_uses_the_exact_file(self):
        db = self.make_ledger()
        special = os.path.join(self.tmp.name, "memory?#%.db")
        shutil.copyfile(db, special)
        self.assertEqual(nsr.load_ledger(special)[self.file]["thread_id"], "th-settled")

    def test_ledger_instance_must_match_the_root(self):
        ledger = {self.file: {**self.ledger[self.file], "instance": "codex-cu"}}
        self.assertEqual(nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now), [])

    def test_real_manifest_keeps_provider_instances_distinct(self):
        other = self.write("codex-cu/sessions/2026/rollout-old.jsonl", b'{"type":"other_meta"}\n')
        claude = self.write("claude/projects/example/claude.jsonl", b'{"type":"message"}\n')
        for path in (other, claude):
            os.utime(path, (self.old, self.old))
            self.ledger[path] = self.capture(path)
        self.back_up()
        # Same file name but a different provider must not satisfy codex-cu.
        with open(other, "wb") as f:
            f.write(b'{"type":"changed___"}\n')
        os.utime(other, (self.old, self.old))
        self.ledger[other] = self.capture(other)
        out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual({c["path"] for c in out}, {self.file, claude})
        paths = {entry["path"] for entry in self.manifest["files"]}
        self.assertIn("codex-cu/sessions/2026/rollout-old.jsonl", paths)
        self.assertIn("claude/projects/example/claude.jsonl", paths)

    def test_stale_backup_size_or_digest_never_qualifies(self):
        for content in (b'X' * os.path.getsize(self.file), b'longer than the archived content'):
            with self.subTest(content=content):
                with open(self.file, "wb") as f:
                    f.write(content)
                os.utime(self.file, (self.old, self.old))
                self.ledger[self.file] = self.capture(self.file)
                out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
                self.assertEqual(out, [])

    def test_malformed_missing_or_ambiguous_backup_fails_closed(self):
        for manifest in (None, {}, {"files": self.manifest["files"]},
                         {**self.manifest, "files": [dict(self.manifest["files"][0], sha256=None)]},
                         {**self.manifest, "files": self.manifest["files"] * 2}):
            with self.subTest(manifest=manifest):
                self.assertEqual(nsr.plan(self.roots(), self.ledger, manifest, {"th-settled"}, now=self.now), [])

    def test_unreadable_or_changed_during_hash_never_qualifies(self):
        with mock.patch.object(tbm, "file_info", side_effect=OSError("unreadable")):
            self.assertEqual(nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now), [])
        real_hash = tbm.file_info

        def change_after_hash(path):
            info = real_hash(path)
            with open(path, "ab") as f:
                f.write(b"new content")
            return info

        with mock.patch.object(tbm, "file_info", side_effect=change_after_hash):
            self.assertEqual(nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now), [])

    def test_unknown_ledger_fields_or_identity_fail_closed(self):
        good = self.ledger[self.file]
        for row in ({k: v for k, v in good.items() if k != "error_count"},
                    {**good, "offset": good["offset"] + 1},
                    {**good, "thread_id": None}, {**good, "error_count": 1},
                    {**good, "inode": good["inode"] + 1}, {**good, "phys_size": good["phys_size"] + 1},
                    {**good, "head_sha1": "bad"}, {**good, "tail_sha1": "bad"},
                    {**good, "retired": 1}):
            with self.subTest(row=row):
                self.assertEqual(nsr.plan(self.roots(), {self.file: row}, self.manifest,
                                          {"th-settled"}, now=self.now), [])

    def test_old_ledger_schema_without_alias_identity_fails_closed(self):
        db = os.path.join(self.tmp.name, "d1.db")
        with closing(sqlite3.connect(db)) as con, con:
            con.execute("CREATE TABLE native_capture_files (rep_id INTEGER, path TEXT, offset INTEGER, "
                        "phys_size INTEGER, complete INTEGER, error_count INTEGER, retired INTEGER)")
            con.execute("INSERT INTO native_capture_files VALUES (1, ?, ?, ?, 1, 0, 0)",
                        (self.file, os.path.getsize(self.file), os.path.getsize(self.file)))
        self.assertEqual(nsr.load_ledger(db), {})
        self.assertEqual(nsr.plan(self.roots(), nsr.load_ledger(db), self.manifest,
                                  {"th-settled"}, now=self.now), [])

    def test_unknown_state_db_cannot_partially_mark_threads_settled(self):
        state = os.path.join(self.tmp.name, "state.sqlite")
        with closing(sqlite3.connect(state)) as con, con:
            con.execute("CREATE TABLE ardud_kanban_cards (json TEXT)")
            con.execute("INSERT INTO ardud_kanban_cards VALUES (?)",
                        (json.dumps({"workThreadId": "th-settled", "settledAt": "today"}),))
        self.assertEqual(nsr.settled_threads(state), set())

    def test_unknown_root_not_eligible(self):
        roots = [{"instance": "unknown", "root": os.path.join(self.homes, "codex"), "exists": True}]
        self.assertEqual(nsr.plan(roots, self.ledger, self.manifest, {"th-settled"}, now=self.now), [])

    def test_uncaptured_file_not_listed(self):
        ledger = {self.file: {**self.ledger[self.file], "offset": 3}}
        out = nsr.plan(self.roots(), ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_file_not_in_manifest_not_listed(self):
        out = nsr.plan(self.roots(), self.ledger, {**self.manifest, "files": []}, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_unsettled_thread_not_listed(self):
        out = nsr.plan(self.roots(), self.ledger, self.manifest, set(), now=self.now)
        self.assertEqual(out, [])

    def test_recent_file_not_listed(self):
        recent = self.now - 10 * 86400
        os.utime(self.file, (recent, recent))
        out = nsr.plan(self.roots(), self.ledger, self.manifest, {"th-settled"}, now=self.now)
        self.assertEqual(out, [])

    def test_report_only_never_unlinks(self):
        state = os.path.join(self.tmp.name, "statev2.sqlite")
        ledger_db = self.make_ledger()
        with closing(sqlite3.connect(state)) as con, con:
            con.execute("CREATE TABLE ardud_kanban_cards (json TEXT)")
            con.execute("INSERT INTO ardud_kanban_cards VALUES (?)",
                        (json.dumps({"workThreadId": "th-settled", "settledAt": "today"}),))
            con.execute("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, archived_at TEXT)")
        with mock.patch.object(nsr.os, "remove") as rm, mock.patch.object(nsr.os, "unlink") as ul, \
                mock.patch.object(nsr.os, "rmdir") as rd, mock.patch.object(nsr.os, "rename") as rn, \
                mock.patch.object(nsr.os, "replace") as rp, mock.patch.object(shutil, "rmtree") as rt, \
                mock.patch("sys.stdout", new_callable=io.StringIO) as out, \
                mock.patch.object(nsr.time, "time", return_value=self.now):
            with mock.patch.object(nsr, "latest_manifest", return_value=self.manifest):
                nsr.main(["--ledger", ledger_db, "--state-db", state])
            report = json.loads(out.getvalue())
            self.assertEqual((report["mode"], report["deletes"], report["candidates"]), ("report-only", 0, 1))
            self.assertEqual(report["items"][0]["path"], self.file)
            rm.assert_not_called()
            ul.assert_not_called()
            rd.assert_not_called()
            rn.assert_not_called()
            rp.assert_not_called()
            rt.assert_not_called()
        self.assertTrue(os.path.exists(self.file))


if __name__ == "__main__":
    unittest.main()
