"""Native capture ages, root passes, identity and archive moves, using temporary data only."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import closing
from datetime import datetime, timezone
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import health_check as hc
import native_identity
import sync_claude
import sync_codex
import sync_thread_identity
import transcript_capture as tc
import transcript_roots


NOW = 1_800_000_000


def line(age, **fields):
    stamp = datetime.fromtimestamp(NOW - age, timezone.utc).isoformat().replace("+00:00", "Z")
    return (json.dumps(dict(timestamp=stamp, **fields)) + "\n").encode()


class Watermarks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = os.path.join(self.tmp.name, "codex")
        self.claude_home = os.path.join(self.tmp.name, "claude")
        self.db = os.path.join(self.tmp.name, "memory.db")
        os.makedirs(os.path.join(self.home, "sessions"))
        os.makedirs(os.path.join(self.home, "archived_sessions"))
        os.makedirs(os.path.join(self.claude_home, "projects"))
        with closing(sqlite3.connect(self.db)) as con:
            with open(os.path.join(SRC, "schema.sql")) as f:
                con.executescript(f.read())
            tc.ensure_schema(con)
            con.executescript(sync_thread_identity.DDL)
            con.execute("CREATE TABLE IF NOT EXISTS harness_schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            con.execute("INSERT INTO harness_schema_meta VALUES('thread_identity_last_ok',?)", (str(NOW),))
            tc.record_root_pass(con, "codex", self.home, 0, 0, NOW)
            con.commit()
        self.root = {"driver": "codex", "instance": "codex", "path": self.home,
                     "root": self.home, "exists": True}
        self.claude_root = {"driver": "claudeAgent", "instance": "claudeAgent", "path": self.claude_home,
                            "root": self.claude_home, "exists": True}
        self.patches = [mock.patch.object(hc, "NATIVE_LEDGER", self.db),
                        mock.patch.object(transcript_roots, "resolve", return_value=[self.root]),
                        mock.patch.object(hc, "_native_enabled", return_value=True)]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def write(self, data, name="rollout-test.jsonl"):
        path = os.path.join(self.home, "sessions", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def set_offset(self, path, offset, complete=False):
        st = os.stat(path)
        with closing(sqlite3.connect(self.db)) as con, con:
            rep = tc.open_representation(con, path, st, key="codex:" + tc.logical_name(path, self.home),
                                         instance="codex")
            tc.record_ok(con, rep["rep_id"], offset, st.st_size, st.st_mtime, 0, now=NOW,
                         complete=complete, inode=st.st_ino)

    def report(self, seen=None):
        return hc.native_roots_report(now=NOW, seen={} if seen is None else seen)

    def sync_codex(self):
        with mock.patch.object(sync_codex, "MEM_DB", self.db), mock.patch.object(sync_codex, "load_seeded", return_value={}):
            return sync_codex.CodexSync(types.SimpleNamespace(deadline=0), roots=[self.root]).run()

    def sync_claude(self):
        with mock.patch.object(sync_claude, "MEM_DB", self.db), mock.patch.object(sync_claude, "load_seeded", return_value={}):
            return sync_claude.ClaudeSync(types.SimpleNamespace(deadline=0), roots=[self.claude_root]).run()

    def test_preexisting_backlog_age_and_restart(self):
        self.write(line(7200, type="event_msg"))
        seen_path = os.path.join(self.tmp.name, "seen.json")
        with mock.patch.object(hc, "NATIVE_SEEN", seen_path), mock.patch.object(hc, "DRY_RUN", False), \
             mock.patch.object(hc.time, "time", return_value=NOW):
            first = hc.check_native_capture()
            os.unlink(seen_path)
            second = hc.check_native_capture()
        self.assertEqual(first, second)
        self.assertFalse(first[0])
        self.assertIn("7200", first[1])
        self.assertNotIn("unknown", first[1])

    def test_fresh_unconsumed_lines_are_healthy(self):
        self.write(line(30, type="event_msg"))
        roots, problems = self.report()
        self.assertEqual(roots[0]["oldest_lag_s"], 30)
        self.assertEqual(problems, [])

    def test_partial_progress_and_growing_file_do_not_hide_old_backlog(self):
        first, old, fresh = line(7200), line(1200), line(5)
        path = self.write(first + old + fresh)
        self.set_offset(path, len(first))
        seen = {}
        for _ in range(3):
            roots, problems = self.report(seen)
            self.assertEqual(roots[0]["oldest_lag_s"], 1200)
            self.assertTrue(any("pending bytes" in p and "1200" in p for p in problems), problems)
            with open(path, "ab") as f:
                f.write(fresh)

    def test_known_old_line_then_missing_timestamp_stays_unhealthy(self):
        path = self.write(line(7200) + b'{"type":"response_item"}\n')
        self.set_offset(path, 0)
        seen = {}
        self.assertTrue(any("7200" in p for p in self.report(seen)[1]))
        self.set_offset(path, len(line(7200)))
        roots, problems = self.report(seen)
        self.assertTrue(any("pending bytes" in p for p in problems), (roots, problems))

    def test_initially_unknown_observed_backlog_stays_old_after_partial_progress(self):
        first = b'{"type":"unknown"}\n'
        path = self.write(first + line(0))
        self.set_offset(path, 0)
        seen = {}
        self.assertTrue(any("unknown" in p for p in hc.native_roots_report(now=NOW - 901, seen=seen)[1]))
        self.set_offset(path, len(first))
        self.assertTrue(any("pending bytes" in p for p in self.report(seen)[1]))

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_compressed_incomplete_uses_unconsumed_source_age_and_complete_is_idle(self):
        first, old = line(10), line(7200)
        path = self.write(subprocess.run([tc.zstd_bin(), "-q", "-c"], input=first + old,
                                         stdout=subprocess.PIPE, check=True).stdout, "rollout-test.jsonl.zst")
        self.set_offset(path, len(first))
        roots, problems = self.report()
        self.assertEqual(roots[0]["oldest_lag_s"], 7200)
        self.assertTrue(any("pending bytes" in p and "7200" in p for p in problems), problems)
        self.set_offset(path, len(first) + len(old), complete=True)
        self.assertEqual(self.report()[1], [])

    def test_compressed_large_offset_is_unknown_and_unhealthy(self):
        path = self.write(b"not zstd", "rollout-large.jsonl.zst")
        self.set_offset(path, (256 << 20) + 1)
        _, problems = self.report()
        self.assertTrue(any("unknown" in p and "compressed" in p for p in problems), problems)

    def test_empty_root_requires_fresh_pass_and_disabled_missing_is_exempt(self):
        self.assertEqual(self.report()[1], [])
        with closing(sqlite3.connect(self.db)) as con, con:
            con.execute("DELETE FROM native_capture_roots")
        self.assertTrue(any("no recent successful capture pass" in p for p in self.report()[1]))
        with closing(sqlite3.connect(self.db)) as con, con:
            tc.record_root_pass(con, "codex", self.home, 0, 0, NOW - hc.NATIVE_LAG_MAX - 1)
        self.assertTrue(any("no recent successful capture pass" in p for p in self.report()[1]))
        missing = dict(self.root, root=os.path.join(self.tmp.name, "not-created"),
                       path=os.path.join(self.tmp.name, "not-created"), exists=False)
        with mock.patch.object(transcript_roots, "resolve", return_value=[missing]), \
             mock.patch.object(hc, "_native_enabled", return_value=False):
            self.assertEqual(self.report()[1], [])

    def test_disabled_root_pass_proves_it_existed_without_seen_file(self):
        missing = os.path.join(self.tmp.name, "previously-captured")
        with closing(sqlite3.connect(self.db)) as con, con:
            tc.record_root_pass(con, "codex", missing, 0, 0, NOW)
        root = dict(self.root, root=missing, path=missing, exists=False)
        with mock.patch.object(transcript_roots, "resolve", return_value=[root]), \
             mock.patch.object(hc, "_native_enabled", return_value=False):
            self.assertTrue(any("root missing" in p for p in self.report({})[1]))

    def test_tailer_root_passes_count_files_errors_and_only_finish_within_deadline(self):
        self.write(line(10, type="session_meta", payload={"id": "thread"}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            passed = con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance='codex'").fetchone()
            self.assertEqual(passed[1:], (1, 0))
        with mock.patch.object(sync_codex, "MEM_DB", self.db), \
             mock.patch.object(sync_codex, "load_seeded", return_value={}):
            worker = sync_codex.CodexSync(types.SimpleNamespace(deadline=1), roots=[self.root])
            with mock.patch.object(sync_codex.time, "time", side_effect=[0, 0, 2, 2]):
                worker.run()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance='codex'").fetchone(),
                             passed)
        self.sync_claude()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT files,errors FROM native_capture_roots WHERE instance='claudeAgent'").fetchone(), (0, 0))

    def test_directory_walk_error_never_updates_root_pass(self):
        os.makedirs(os.path.join(self.claude_home, "projects", "repo"))
        for module, cls, root in ((sync_claude, sync_claude.ClaudeSync, self.claude_root),
                                  (sync_codex, sync_codex.CodexSync, self.root)):
            with mock.patch.object(module, "MEM_DB", self.db), mock.patch.object(module, "load_seeded", return_value={}):
                worker = cls(types.SimpleNamespace(deadline=0), roots=[root])
                with closing(sqlite3.connect(self.db)) as con:
                    before = con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                         (root["instance"],)).fetchone()
                with mock.patch.object(module.os, "walk", side_effect=PermissionError("denied")):
                    with self.assertRaises(PermissionError):
                        worker.run()
                worker.mem.close()
                with closing(sqlite3.connect(self.db)) as con:
                    self.assertEqual(con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                                 (root["instance"],)).fetchone(), before)

    def test_existing_root_is_not_refreshed_after_it_disappears_mid_walk(self):
        os.makedirs(os.path.join(self.claude_home, "projects", "repo"))
        for module, cls, root in ((sync_claude, sync_claude.ClaudeSync, self.claude_root),
                                  (sync_codex, sync_codex.CodexSync, self.root)):
            with mock.patch.object(module, "MEM_DB", self.db), mock.patch.object(module, "load_seeded", return_value={}):
                worker = cls(types.SimpleNamespace(deadline=0), roots=[root])
                with closing(sqlite3.connect(self.db)) as con:
                    before = con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                         (root["instance"],)).fetchone()
                # A root disappearing after it was listed is not a successful pass.
                def gone(_root, **_kwargs):
                    raise FileNotFoundError("root disappeared during walk")
                    yield
                with mock.patch.object(module, "session_files", gone):
                    with self.assertRaises(FileNotFoundError):
                        worker.run()
                worker.mem.close()
                with closing(sqlite3.connect(self.db)) as con:
                    self.assertEqual(con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                                 (root["instance"],)).fetchone(), before)

    def test_root_disappears_after_initial_check_without_a_generator_exception(self):
        real_isdir = os.path.isdir
        for module, cls, root in ((sync_claude, sync_claude.ClaudeSync, self.claude_root),
                                  (sync_codex, sync_codex.CodexSync, self.root)):
            with mock.patch.object(module, "MEM_DB", self.db), mock.patch.object(module, "load_seeded", return_value={}):
                worker = cls(types.SimpleNamespace(deadline=0), roots=[root])
                with closing(sqlite3.connect(self.db)) as con:
                    before = con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                         (root["instance"],)).fetchone()
                calls = []
                def disappears(path):
                    if path == root["path"]:
                        calls.append(path)
                        return len(calls) == 1
                    return real_isdir(path)
                with mock.patch.object(module.os.path, "isdir", side_effect=disappears), \
                     mock.patch.object(module, "session_files", return_value=iter(())):
                    worker.run()
                with closing(sqlite3.connect(self.db)) as con:
                    self.assertEqual(con.execute("SELECT last_pass_at,files,errors FROM native_capture_roots WHERE instance=?",
                                                 (root["instance"],)).fetchone(), before)

    def test_unchanged_old_ledger_rows_backfill_identity_without_duplicate_events(self):
        child = os.path.join(self.claude_home, "projects", "repo", "sid", "subagents", "agent-X.jsonl")
        os.makedirs(os.path.dirname(child))
        with open(child, "wb") as f:
            f.write(line(10, sessionId="sid", uuid="one", type="user", message={"role": "user", "content": "hello"}))
        codex = self.write(line(10, type="session_meta", payload={"id": "thread"}))
        self.sync_claude()
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con, con:
            before = con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0]
            con.execute("UPDATE native_capture_files SET instance=NULL, session_key=NULL")
        self.sync_claude()
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            rows = {path: (instance, key) for path, instance, key in
                    con.execute("SELECT path,instance,session_key FROM native_capture_files WHERE retired=0")}
            self.assertEqual(rows[child], ("claudeAgent", "sid:agent:X"))
            self.assertEqual(rows[codex], ("codex", "thread"))
            self.assertEqual(con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0], before)

    def test_error_since_persists_and_clears_including_pre_migration_error(self):
        path = self.write(line(60))
        self.set_offset(path, os.stat(path).st_size)
        with closing(sqlite3.connect(self.db)) as con, con:
            rep_id = con.execute("SELECT rep_id FROM native_capture_files").fetchone()[0]
            tc.record_error(con, rep_id, "first", now=NOW - 2000)
            tc.record_error(con, rep_id, "second", now=NOW - 5)
            self.assertEqual(con.execute("SELECT error_since FROM native_capture_files").fetchone()[0], NOW - 2000)
        self.assertTrue(any("capture errors" in p for p in self.report()[1]))
        with closing(sqlite3.connect(self.db)) as con, con:
            tc.record_ok(con, rep_id, os.stat(path).st_size, os.stat(path).st_size, os.stat(path).st_mtime, 1, now=NOW)
            self.assertIsNone(con.execute("SELECT error_since FROM native_capture_files").fetchone()[0])
            con.execute("UPDATE native_capture_files SET error='old', error_count=1, error_since=NULL")
            tc.record_error(con, rep_id, "again", now=NOW)
            self.assertIsNone(con.execute("SELECT error_since FROM native_capture_files").fetchone()[0])
        self.assertTrue(any("capture errors" in p and "unknown" in p for p in self.report()[1]))

    def test_quarantined_moved_codex_file_keeps_old_error_visible(self):
        path = self.write(line(60, type="session_meta", payload={"id": "thread"}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con, con:
            rep = con.execute("SELECT rep_id FROM native_capture_files WHERE path=?", (path,)).fetchone()[0]
            con.execute("UPDATE native_capture_files SET error='old error',error_count=2,error_since=?,quarantined_until=?"
                        " WHERE rep_id=?", (NOW - 2000, NOW + 600, rep))
            tc.record_root_pass(con, "codex", self.home, 1, 1, NOW)
        self.assertTrue(any("capture errors" in p and "2000" in p for p in self.report()[1]))
        moved = os.path.join(self.home, "archived_sessions", os.path.basename(path))
        os.rename(path, moved)
        with mock.patch.object(sync_codex.time, "time", return_value=NOW):
            self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT rep_id,path,error_count,error_since FROM native_capture_files WHERE retired=0").fetchone(),
                             (rep, moved, 2, NOW - 2000))
        self.assertTrue(any("capture errors" in p and "2000" in p for p in self.report()[1]))

    def test_schema_upgrade_preserves_ledger_rows_and_is_idempotent(self):
        old_db = os.path.join(self.tmp.name, "old-ledger.db")
        with closing(sqlite3.connect(old_db)) as con, con:
            con.executescript("""
                CREATE TABLE native_capture_files(
                  rep_id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, logical TEXT NOT NULL,
                  inode INTEGER, head_len INTEGER NOT NULL DEFAULT 0, head_sha1 TEXT,
                  offset INTEGER NOT NULL DEFAULT 0, phys_size INTEGER, mtime REAL,
                  lines INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER, error TEXT,
                  error_count INTEGER NOT NULL DEFAULT 0, quarantined_until INTEGER NOT NULL DEFAULT 0,
                  retired INTEGER NOT NULL DEFAULT 0);
                INSERT INTO native_capture_files(path,logical,offset,error,error_count)
                  VALUES('/fixture','codex:fixture',17,'old failure',1);
            """)
            tc.ensure_schema(con)
            tc.ensure_schema(con)
            self.assertEqual(con.execute("SELECT path,offset,error,error_count,error_since,instance,session_key,complete "
                                         "FROM native_capture_files").fetchone(),
                             ('/fixture', 17, 'old failure', 1, None, None, None, 0))
            self.assertEqual(con.execute("SELECT count(*) FROM native_capture_roots").fetchone()[0], 0)

    def test_child_key_fallback_and_unknown_identity(self):
        child = os.path.join(self.claude_home, "projects", "repo", "sid", "subagents", "agent-X.jsonl")
        os.makedirs(os.path.dirname(child))
        with open(child, "wb") as f:
            f.write(line(10, sessionId="sid", uuid="one", type="user",
                         message={"role": "user", "content": "hello"}))
        unknown = os.path.join(self.claude_home, "projects", "repo", "unknown.jsonl")
        with open(unknown, "wb") as f:
            f.write(line(10, type="unknown"))
        self.sync_claude()
        self.write(line(10, type="response_item", payload={}), "rollout-unknown.jsonl")
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con, con:
            keys = dict(con.execute("SELECT path,session_key FROM native_capture_files"))
            self.assertEqual(keys[child], "sid:agent:X")
            self.assertIsNone(keys[unknown])
            self.assertIsNone(keys[os.path.join(self.home, "sessions", "rollout-unknown.jsonl")])
            con.execute("INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id,agent_id)"
                        " VALUES('alias','child','parent','claudeAgent','claudeAgent','sid','X')")
            self.assertEqual(native_identity.resolve_thread(con, "claudeAgent", "claude", keys[child]), "child")
            self.assertIsNone(native_identity.resolve_thread(con, "claudeAgent", "claude", None))
            self.assertIsNone(native_identity.resolve_thread(con, "codex", "codex", None))

    def test_first_encounter_failures_record_error_start_in_each_tailer(self):
        claude = os.path.join(self.claude_home, "projects", "repo", "test.jsonl")
        os.makedirs(os.path.dirname(claude))
        with open(claude, "wb") as f:
            f.write(line(1, sessionId="sid"))
        codex = self.write(line(1, type="session_meta", payload={"id": "sid"}))
        for module, cls, root, path in ((sync_claude, sync_claude.ClaudeSync, self.claude_root, claude),
                                        (sync_codex, sync_codex.CodexSync, self.root, codex)):
            with mock.patch.object(module, "MEM_DB", self.db), mock.patch.object(module, "load_seeded", return_value={}):
                worker = cls(types.SimpleNamespace(deadline=0), roots=[root])
                with mock.patch.object(module.time, "time", return_value=NOW):
                    worker._fail(path, "failed first read")
                worker.mem.close()
            with closing(sqlite3.connect(self.db)) as con:
                self.assertEqual(con.execute("SELECT error_count,error_since,instance FROM native_capture_files WHERE path=?",
                                             (path,)).fetchone(), (1, NOW, root["instance"]))

    def test_partial_batch_preserves_error_until_a_clean_eof(self):
        path = self.write(line(60))
        self.set_offset(path, 0)
        with closing(sqlite3.connect(self.db)) as con, con:
            rep_id = con.execute("SELECT rep_id FROM native_capture_files").fetchone()[0]
            tc.record_error(con, rep_id, "first", now=NOW - 2000)
            tc.record_ok(con, rep_id, 0, os.stat(path).st_size, os.stat(path).st_mtime, 0,
                         now=NOW - 100, clear_error=False)
            tc.record_error(con, rep_id, "again", now=NOW - 1)
            self.assertEqual(con.execute("SELECT error_count,error_since FROM native_capture_files").fetchone(),
                             (2, NOW - 2000))
        self.assertTrue(any("capture errors" in p and "2000" in p for p in self.report()[1]))

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_complete_archive_clears_prior_error_after_successful_retry(self):
        data = line(30, type="session_meta", payload={"id": "thread"})
        path = self.write(subprocess.run([tc.zstd_bin(), "-q", "-c"], input=data,
                                         stdout=subprocess.PIPE, check=True).stdout, "rollout-test.jsonl.zst")
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con, con:
            rep_id = con.execute("SELECT rep_id FROM native_capture_files").fetchone()[0]
            tc.record_error(con, rep_id, "zstd missing", now=1)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT error,error_count,error_since,complete FROM native_capture_files WHERE path=?",
                                         (path,)).fetchone(), (None, 0, None, 1))

    def test_error_on_one_file_does_not_block_or_miscount_root_pass(self):
        self.write(line(10, type="session_meta", payload={"id": "thread"}), "rollout-bad.jsonl")
        self.write(line(10, type="session_meta", payload={"id": "thread2"}), "rollout-good.jsonl")
        with mock.patch.object(sync_codex, "MEM_DB", self.db), mock.patch.object(sync_codex, "load_seeded", return_value={}):
            worker = sync_codex.CodexSync(types.SimpleNamespace(deadline=0), roots=[self.root])
            original = worker.sync_file
            def fail_one(path, st):
                if path.endswith("rollout-bad.jsonl"):
                    raise ValueError("bad fixture")
                return original(path, st)
            worker.sync_file = fail_one
            stats = worker.run()
        self.assertEqual((stats["files"], stats["errors"]), (2, 1))
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT files,errors FROM native_capture_roots WHERE instance='codex'").fetchone(), (2, 1))
            self.assertEqual(con.execute("SELECT session_key FROM native_capture_files WHERE path LIKE '%good.jsonl'").fetchone(),
                             ("thread2",))

    def test_conflicting_session_keys_never_bind_to_a_thread(self):
        child = os.path.join(self.claude_home, "projects", "repo", "sid", "subagents", "agent-X.jsonl")
        os.makedirs(os.path.dirname(child))
        with open(child, "wb") as f:
            f.write(line(10, sessionId="sid", type="unknown") + line(9, sessionId="other", type="unknown"))
        self.sync_claude()
        with closing(sqlite3.connect(self.db)) as con, con:
            con.execute("INSERT INTO thread_aliases(alias_key,canonical_thread_id,root_thread_id,driver,instance,native_id,agent_id)"
                        " VALUES('alias','child','parent','claudeAgent','claudeAgent','sid','X')")
            key = con.execute("SELECT session_key FROM native_capture_files WHERE path=?", (child,)).fetchone()[0]
            self.assertIsNone(native_identity.resolve_thread(con, "claudeAgent", "claude", key))
        self.sync_claude()
        with closing(sqlite3.connect(self.db)) as con:
            key = con.execute("SELECT session_key FROM native_capture_files WHERE path=?", (child,)).fetchone()[0]
            self.assertIsNone(native_identity.resolve_thread(con, "claudeAgent", "claude", key))

    def test_child_with_no_agent_id_is_not_projected_to_parent(self):
        path = os.path.join(self.claude_home, "projects", "repo", "sid", "subagents", "agent-.jsonl")
        os.makedirs(os.path.dirname(path))
        with open(path, "wb") as f:
            f.write(line(10, sessionId="sid", uuid="one", type="user", message={"role": "user", "content": "hello"}))
        self.sync_claude()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertIsNone(con.execute("SELECT session_key FROM native_capture_files WHERE path=?", (path,)).fetchone()[0])
            self.assertEqual(con.execute("SELECT count(*) FROM episodic_events WHERE source='claude'").fetchone()[0], 0)

    def test_codex_conflicting_metadata_does_not_relabel_prior_events(self):
        path = self.write(line(10, type="session_meta", payload={"id": "first"}) +
                          line(9, type="response_item", payload={"type": "message", "role": "user", "content": "first message"}) +
                          line(8, type="session_meta", payload={"id": "second"}) +
                          line(7, type="response_item", payload={"type": "message", "role": "user", "content": "second message"}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT session_id,content FROM episodic_events WHERE source='codex' ORDER BY id").fetchall(),
                             [("first", "first message"), ("second", "second message")])
            key = con.execute("SELECT session_key FROM native_capture_files WHERE path=?", (path,)).fetchone()[0]
            self.assertIsNone(native_identity.resolve_thread(con, "codex", "codex", key))

    def test_codex_empty_later_metadata_does_not_drop_previous_event(self):
        self.write(line(10, type="session_meta", payload={"id": "first"}) +
                   line(9, type="response_item", payload={"type": "message", "role": "user", "content": "kept"}) +
                   line(8, type="session_meta", payload={"id": ""}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT session_id,content FROM episodic_events WHERE source='codex'").fetchall(),
                             [("first", "kept")])

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_archive_move_and_compression_keep_row_and_events(self):
        path = self.write(line(60, type="session_meta", payload={"id": "thread"}) +
                          line(50, type="response_item", payload={"type": "message", "role": "user", "content": "hello"}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            before = con.execute("SELECT rep_id,path,session_key FROM native_capture_files WHERE retired=0").fetchone()
            counts = (con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0],
                      con.execute("SELECT count(*) FROM episodic_events").fetchone()[0])
        moved = os.path.join(self.home, "archived_sessions", os.path.basename(path))
        os.rename(path, moved)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT rep_id,path,session_key FROM native_capture_files WHERE retired=0").fetchone(),
                             (before[0], moved, "thread"))
        subprocess.run([tc.zstd_bin(), "-q", "--rm", moved], check=True)
        compressed = moved + ".zst"
        self.sync_codex()
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT rep_id,path,session_key FROM native_capture_files WHERE retired=0").fetchone(),
                             (before[0], compressed, "thread"))
            self.assertEqual(con.execute("SELECT count(*) FROM native_capture_files WHERE retired=1").fetchone()[0], 0)
            self.assertEqual((con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0],
                              con.execute("SELECT count(*) FROM episodic_events").fetchone()[0]), counts)

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_archive_rename_with_both_plain_and_zst_representations(self):
        path = self.write(line(60, type="session_meta", payload={"id": "thread"}) +
                          line(50, type="response_item", payload={"type": "message", "role": "user", "content": "hello"}))
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            before = con.execute("SELECT rep_id FROM native_capture_files WHERE retired=0").fetchone()[0]
            counts = (con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0],
                      con.execute("SELECT count(*) FROM episodic_events").fetchone()[0])
        compressed = os.path.join(self.home, "archived_sessions", os.path.basename(path) + ".zst")
        with open(compressed, "wb") as out:
            subprocess.run([tc.zstd_bin(), "-q", "-c", path], stdout=out, check=True)
        self.sync_codex()
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT rep_id FROM native_capture_files WHERE retired=0").fetchone()[0], before)
            self.assertEqual(con.execute("SELECT count(*) FROM native_capture_files WHERE retired=1").fetchone()[0], 0)
            self.assertEqual((con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0],
                              con.execute("SELECT count(*) FROM episodic_events").fetchone()[0]), counts)
        with closing(sqlite3.connect(self.db)) as con, con:
            tc.record_root_pass(con, "codex", self.home, 2, 0, NOW)
        self.assertEqual(self.report()[1], [])
        os.unlink(path)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertEqual(con.execute("SELECT rep_id,path FROM native_capture_files WHERE retired=0").fetchone(),
                             (before, compressed))
            self.assertEqual(con.execute("SELECT count(*) FROM native_capture_files WHERE retired=1").fetchone()[0], 0)
            self.assertEqual((con.execute("SELECT count(*) FROM native_capture_raw").fetchone()[0],
                              con.execute("SELECT count(*) FROM episodic_events").fetchone()[0]), counts)

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_coexisting_archive_with_extra_lines_is_captured(self):
        original = line(10, type="session_meta", payload={"id": "thread"})
        path = self.write(original)
        self.sync_codex()
        extra = line(9, type="response_item", payload={"type": "message", "role": "user", "content": "archive only"})
        compressed = os.path.join(self.home, "archived_sessions", os.path.basename(path) + ".zst")
        with open(compressed, "wb") as out:
            subprocess.run([tc.zstd_bin(), "-q", "-c"], input=original + extra, stdout=out, check=True)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertIn(("archive only",), con.execute("SELECT content FROM episodic_events WHERE source='codex'").fetchall())

    @unittest.skipUnless(tc.zstd_bin(), "zstd missing")
    def test_compressed_replacement_with_same_head_and_different_consumed_tail_is_replayed(self):
        head = line(100, type="session_meta", payload={"id": "thread"}) + line(99, type="other", payload={"data": "x" * 5000})
        old = line(90, type="response_item", payload={"type": "message", "role": "user", "content": "old tail"})
        new = line(90, type="response_item", payload={"type": "message", "role": "user", "content": "new tail"})
        path = self.write(head + old)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            old_rep = con.execute("SELECT rep_id FROM native_capture_files WHERE retired=0").fetchone()[0]
        compressed = os.path.join(self.home, "archived_sessions", os.path.basename(path) + ".zst")
        with open(compressed, "wb") as out:
            subprocess.run([tc.zstd_bin(), "-q", "-c"], input=head + new, stdout=out, check=True)
        os.unlink(path)
        self.sync_codex()
        with closing(sqlite3.connect(self.db)) as con:
            self.assertNotEqual(con.execute("SELECT rep_id FROM native_capture_files WHERE retired=0").fetchone()[0], old_rep)
            contents = {row[0] for row in con.execute("SELECT content FROM episodic_events WHERE source='codex'")}
            self.assertTrue({"old tail", "new tail"} <= contents)


if __name__ == "__main__":
    unittest.main()
