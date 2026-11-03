"""Native health tests use temporary roots and D1's capture/identity ledger shape."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)
import health_check as hc
import transcript_roots as roots

PRODUCTION_SETTINGS = hc.ROBOB_SETTINGS
DDL = """
CREATE TABLE native_capture_files (
 rep_id INTEGER PRIMARY KEY, path TEXT, inode INTEGER, offset INTEGER, phys_size INTEGER,
 complete INTEGER, error_count INTEGER, retired INTEGER DEFAULT 0, error_since INTEGER);
CREATE TABLE native_capture_roots (
 instance TEXT, root TEXT, last_pass_at INTEGER, files INTEGER, errors INTEGER,
 PRIMARY KEY(instance, root));
CREATE TABLE harness_schema_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE thread_aliases (alias_key TEXT PRIMARY KEY, last_seen INTEGER);
"""



def fake_entries(homes):
    """D1 manifest entries (transcript_roots.json shape) rooted in a temp dir."""
    return [{"driver": "claudeAgent", "instance": "claudeAgent", "root": os.path.join(homes, "claude")},
            {"driver": "codex", "instance": "codex", "root": os.path.join(homes, "codex")},
            {"driver": "codex", "instance": "codex-cu", "root": os.path.join(homes, "codex-cu")}]

class NativeHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.homes = os.path.join(self.tmp.name, "homes")
        self.ledger = os.path.join(self.tmp.name, "memory.db")
        self.settings = os.path.join(self.tmp.name, "settings.json")
        self.claude_settings = os.path.join(self.tmp.name, "claude.json")
        self.now = 1_800_000_000
        self.seen = {}
        self.write_settings()
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.executescript(DDL)
            con.execute("INSERT INTO thread_aliases VALUES ('alias', ?)", (self.now,))
        patches = [mock.patch.object(roots, "load", return_value=fake_entries(self.homes)),
                   mock.patch.object(hc, "NATIVE_LEDGER", self.ledger),
                   mock.patch.object(hc, "ROBOB_SETTINGS", self.settings),
                   mock.patch.object(hc, "CLAUDE_SETTINGS", self.claude_settings)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for directory in ("claude/projects", "codex/sessions", "codex/archived_sessions",
                          "codex-cu/sessions", "codex-cu/archived_sessions"):
            os.makedirs(os.path.join(self.homes, directory), exist_ok=True)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.executemany("INSERT INTO native_capture_roots VALUES (?, ?, ?, 0, 0)",
                            [(r["instance"], os.path.realpath(r["root"]), self.now)
                             for r in fake_entries(self.homes)])
        for rel in ("claude/projects/p/base.jsonl", "codex/sessions/base.jsonl",
                    "codex-cu/sessions/base.jsonl"):
            path = self.write(rel, b"{}\n")
            self.capture(path, 3)

    def write_settings(self, claude=True, codex=True, codex_cu=True):
        with open(self.settings, "w") as f:
            json.dump({"providerInstances": {
                "claudeAgent": {"driver": "claudeAgent", "enabled": claude, "config": {}},
                "codex": {"driver": "codex", "enabled": codex, "config": {}},
                "codex-cu": {"driver": "codex", "enabled": codex_cu, "config": {}},
            }}, f)

    def write(self, rel, data):
        path = os.path.join(self.homes, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def capture(self, path, offset, size=None, complete=1, errors=0, error_since=None):
        st = os.stat(path)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_files WHERE path=?", (path,))
            con.execute("INSERT INTO native_capture_files(path,inode,offset,phys_size,complete,error_count,error_since) "
                        "VALUES (?,?,?,?,?,?,?)", (path, st.st_ino, offset, st.st_size if size is None else size,
                                                   complete, errors, error_since))

    def timestamped(self, epoch):
        ts = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")
        return (json.dumps({"timestamp": ts}) + "\n").encode()

    def refresh(self, now):
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("UPDATE native_capture_roots SET last_pass_at=?", (now,))
            con.execute("UPDATE thread_aliases SET last_seen=?", (now,))
            con.execute("UPDATE harness_schema_meta SET value=? WHERE key='thread_identity_last_ok'", (str(now),))

    def compressed(self, rel, data):
        import transcript_capture as tc
        zstd = tc.zstd_bin()
        if not zstd:
            self.skipTest("zstd is not installed")
        result = subprocess.run([zstd, "-q", "-c"], input=data, capture_output=True, check=True)
        return self.write(rel, result.stdout)

    def report(self, now=None):
        return hc.native_roots_report(now=self.now if now is None else now, seen=self.seen)

    def problems(self, now=None):
        return self.report(now)[1]

    def test_real_settings_path(self):
        self.assertEqual(PRODUCTION_SETTINGS, os.path.join(os.path.expanduser("~"), ".robob/userdata/settings.json"))

    def test_enabled_missing_root_fails(self):
        missing = os.path.join(self.homes, "new-codex")
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex", "driver": "codex", "root": missing, "exists": False}]):
            self.assertTrue(any("root missing" in p for p in self.problems()))

    def test_disabled_never_created_root_from_real_settings_is_exempt(self):
        self.write_settings(codex_cu=False)
        missing = os.path.join(self.homes, "never-created")
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex-cu", "driver": "codex", "root": missing, "exists": False}]):
            self.assertEqual(self.problems(), [])

    def test_disappeared_disabled_root_is_not_exempt(self):
        root = os.path.realpath(os.path.join(self.homes, "was-here"))
        self.seen["roots"] = [root]
        self.write_settings(codex_cu=False)
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex-cu", "driver": "codex", "root": root, "exists": False}]):
            self.assertTrue(any("root missing" in p for p in self.problems()))

    def test_disabled_missing_root_with_prior_ledger_entry_is_not_exempt(self):
        root = os.path.realpath(os.path.join(self.homes, "gone"))
        self.write_settings(codex_cu=False)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("INSERT INTO native_capture_files(path,inode,offset,phys_size,complete,error_count) "
                        "VALUES (?,1,0,0,0,0)", (os.path.join(root, "sessions", "old.jsonl"),))
        with mock.patch.object(roots, "resolve", return_value=[
                {"instance": "codex-cu", "driver": "codex", "root": root, "exists": False}]):
            self.assertTrue(any("root missing" in p for p in self.problems()))

    def test_missing_ledger_fails_but_fresh_pass_proves_empty_root(self):
        with mock.patch.object(hc, "NATIVE_LEDGER", os.path.join(self.tmp.name, "missing.db")):
            self.assertTrue(any("ledger missing" in p for p in self.problems()))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_files")
        for entry in fake_entries(self.homes):
            for subdir in ("projects", "sessions", "archived_sessions"):
                for dirpath, _, names in os.walk(os.path.join(entry["root"], subdir)):
                    for name in names:
                        os.remove(os.path.join(dirpath, name))
        self.assertEqual(self.problems(), [])

    def test_root_pass_is_required_per_instance(self):
        root = os.path.realpath(os.path.join(self.homes, "codex"))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_roots WHERE root=?", (root,))
        self.assertTrue(any("codex: no recent successful capture pass" in p for p in self.problems()))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("INSERT INTO native_capture_roots VALUES (?, ?, ?, 0, 0)",
                        ("codex", root, self.now - hc.NATIVE_LAG_MAX - 1))
        self.assertTrue(any("codex: no recent successful capture pass" in p and "old" in p
                            for p in self.problems()))
        self.refresh(self.now)
        self.assertEqual(self.problems(), [])

    def test_empty_root_needs_its_own_fresh_pass(self):
        os.remove(os.path.join(self.homes, "codex/sessions/base.jsonl"))
        root = os.path.realpath(os.path.join(self.homes, "codex"))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_files WHERE path LIKE ?", (root + "/%",))
        self.assertEqual(self.problems(), [])
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM native_capture_roots WHERE root=?", (root,))
        self.assertTrue(any("codex: no recent successful capture pass" in p for p in self.problems()))

    def test_root_pass_table_missing_fails(self):
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DROP TABLE native_capture_roots")
        self.assertTrue(any("no recent successful capture pass" in p for p in self.problems()))

    def test_alias_watermark_read_from_real_table(self):
        self.assertEqual(self.problems(), [])
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("UPDATE thread_aliases SET last_seen=?", (self.now - 901,))
        self.assertTrue(any("thread identity refresh stale" in p for p in self.problems()))
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM thread_aliases")
        self.assertTrue(any("no thread identity refresh" in p for p in self.problems()))

    def test_identity_meta_is_preferred_even_with_no_aliases(self):
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DELETE FROM thread_aliases")
            con.execute("INSERT INTO harness_schema_meta VALUES ('thread_identity_last_ok', ?)", (str(self.now),))
        self.assertEqual(self.problems(), [])
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("INSERT INTO thread_aliases VALUES ('alias', ?)", (self.now,))
            con.execute("UPDATE harness_schema_meta SET value=?", (str(self.now - hc.NATIVE_ALIAS_MAX - 1),))
        self.assertTrue(any("thread identity refresh stale" in p for p in self.problems()))
        for bad in ("invalid", "NaN", str(self.now + 1)):
            with closing(sqlite3.connect(self.ledger)) as con, con:
                con.execute("UPDATE harness_schema_meta SET value=?", (bad,))
            self.assertTrue(any("thread identity refresh stale or invalid" in p for p in self.problems()))

    def test_missing_identity_key_falls_back_even_without_meta_table(self):
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("DROP TABLE harness_schema_meta")
        self.assertEqual(self.problems(), [])

    def test_untracked_growing_complete_file_fails_immediately(self):
        path = self.write("codex/sessions/growing.jsonl", b"{}\n")
        os.utime(path, (self.now, self.now))
        self.assertTrue(any("pending bytes" in p for p in self.problems()))
        with open(path, "ab") as f:
            f.write(b"{}\n")
        os.utime(path, (self.now + 901, self.now + 901))
        self.assertTrue(any("pending bytes" in p for p in self.problems(self.now + 901)))

    def test_untracked_timestamped_file_uses_source_age(self):
        self.write("codex/sessions/new.jsonl", self.timestamped(self.now - 10))
        self.assertEqual(self.problems(), [])

    def test_first_unconsumed_source_line_age_survives_growth_and_health_restart(self):
        consumed = self.timestamped(self.now - 10_000)
        old = self.timestamped(self.now - hc.NATIVE_LAG_MAX - 20)
        newer = self.timestamped(self.now - 10)
        path = self.write("codex/sessions/aged.jsonl", consumed + old + newer)
        self.capture(path, len(consumed))
        report, problems = self.report()
        self.assertTrue(any("aged.jsonl" in p and "920 s" in p for p in problems))
        codex = next(r for r in report if r["instance"] == "codex")
        self.assertEqual(codex["oldest_lag_s"], 920)
        with open(path, "ab") as f:
            f.write(self.timestamped(self.now))
        self.seen = {}
        self.assertTrue(any("aged.jsonl" in p and "920 s" in p for p in self.problems()))
        self.capture(path, len(consumed + old))
        self.assertFalse(any("aged.jsonl" in p for p in self.problems()))

    def test_first_unparseable_line_uses_seen_not_later_timestamp(self):
        path = self.write("codex/sessions/no-time.jsonl", b"{}\n")
        self.capture(path, 3)
        self.problems()
        with open(path, "ab") as f:
            f.write(b"{}\n" + self.timestamped(self.now + 1))
        self.assertEqual(self.problems(self.now + 1), [])
        self.seen = {}
        report, problems = self.report(self.now + 2)
        self.assertTrue(any("no-time.jsonl" in p and "oldest unknown" in p for p in problems))
        self.assertIsNone(next(r for r in report if r["instance"] == "codex")["oldest_lag_s"])

    def test_newer_source_timestamp_does_not_hide_unconsumed_observed_backlog(self):
        path = self.write("codex/sessions/mixed.jsonl", b"{}\n")
        self.capture(path, 3)
        self.problems()
        first = b"{}\n"
        with open(path, "ab") as f:
            f.write(first + self.timestamped(self.now + 901))
        self.problems(self.now + 1)
        self.capture(path, 3 + len(first))
        self.refresh(self.now + 902)
        self.assertTrue(any("mixed.jsonl" in p and "901 s" in p for p in self.problems(self.now + 902)))

    def test_unparseable_next_line_does_not_inherit_consumed_line_age(self):
        first = self.timestamped(self.now - 901)
        path = self.write("codex/sessions/old-then-unknown.jsonl", first + b"{}\n")
        self.capture(path, 0)
        self.assertTrue(any("old-then-unknown.jsonl" in p and "901 s" in p for p in self.problems()))
        self.capture(path, len(first))
        self.assertTrue(any("old-then-unknown.jsonl" in p and "oldest unknown" in p
                            for p in self.problems(self.now + 1)))

    def test_future_or_malformed_timestamp_does_not_prove_freshness(self):
        for i, line in enumerate((self.timestamped(self.now + 10), b'{"timestamp":"oops"}\n', b"{bad}\n")):
            self.write(f"codex/sessions/bad-{i}.jsonl", line)
        self.assertEqual(sum("oldest unknown" in p for p in self.problems()), 3)

    def test_future_and_malformed_timestamps_fall_back_to_seen_clock(self):
        cases = (self.timestamped(self.now + 86_400), b'{"timestamp":"bad"}\n')
        paths = [self.write(f"codex/sessions/fallback-{i}.jsonl", b"{}\n") for i in range(len(cases))]
        for path in paths:
            self.capture(path, 3)
        self.assertEqual(self.problems(), [])
        for path, line in zip(paths, cases):
            with open(path, "ab") as f:
                f.write(line)
        self.assertEqual(self.problems(self.now + 1), [])
        self.refresh(self.now + hc.NATIVE_LAG_MAX + 2)
        failures = self.problems(self.now + hc.NATIVE_LAG_MAX + 2)
        self.assertEqual(sum("fallback-" in p and "901 s" in p for p in failures), 2)

    def test_unparseable_pending_initially_unknown_stays_unknown_on_growth(self):
        path = self.write("codex/sessions/unknown.jsonl", b"{}\n")
        self.capture(path, 0)
        self.assertTrue(any("oldest unknown" in p for p in self.problems()))
        with open(path, "ab") as f:
            f.write(b"{}\n")
        self.assertTrue(any("oldest unknown" in p for p in self.problems(self.now + 1)))

    def test_incomplete_tail_is_healthy(self):
        path = self.write("codex/sessions/incomplete.jsonl", b'{}\n{"partial"')
        self.capture(path, 3)
        self.assertEqual(self.problems(), [])

    def test_fresh_append_after_idle_is_not_old(self):
        path = self.write("codex/sessions/idle.jsonl", b"{}\n")
        self.capture(path, 3)
        self.assertEqual(self.problems(), [])
        with open(path, "ab") as f:
            f.write(b"{}\n")
        self.refresh(self.now + 3600)
        self.assertEqual(self.problems(self.now + 3600), [])

    def test_partial_progress_does_not_reset_oldest_pending_time(self):
        path = self.write("codex/sessions/partial.jsonl", b"{}\n")
        self.capture(path, 3)
        self.problems()
        with open(path, "ab") as f:
            f.write(b"{}\n{}\n")
        self.problems(self.now + 1)
        self.capture(path, 6)  # consumed one line, old observed boundary still outstanding
        with open(path, "ab") as f:
            f.write(b"{}\n")
        self.assertTrue(any("pending bytes" in p for p in self.problems(self.now + 902)))

    def test_error_quarantine_older_than_30_minutes(self):
        path = self.write("claude/projects/p/error.jsonl", b"{}\n")
        self.capture(path, 3, errors=1, error_since=self.now)
        self.assertFalse(any("capture errors" in p for p in self.problems()))
        self.assertTrue(any("capture errors" in p for p in self.problems(self.now + 1801)))

    def test_unknown_legacy_error_stays_unhealthy_across_observations(self):
        path = self.write("claude/projects/p/error.jsonl", b"{}\n")
        self.capture(path, 3, errors=1)
        self.assertTrue(any("capture errors for unknown age" in p for p in self.problems()))
        self.assertTrue(any("capture errors for unknown age" in p for p in self.problems(self.now + 10)))

    def test_persisted_first_error_is_checked_without_seen_history(self):
        path = self.write("claude/projects/p/old-error.jsonl", b"{}\n")
        self.capture(path, 3, errors=5, error_since=self.now - hc.NATIVE_ERROR_MAX - 1)
        self.assertTrue(any("old-error.jsonl capture errors for 1801 s" in p for p in self.problems()))
        self.seen = {}
        self.assertTrue(any("old-error.jsonl capture errors for 1801 s" in p for p in self.problems()))

    def test_error_recovery_clears_failure(self):
        path = self.write("claude/projects/p/recovered.jsonl", b"{}\n")
        self.capture(path, 3, errors=1, error_since=self.now - hc.NATIVE_ERROR_MAX - 1)
        self.assertTrue(any("recovered.jsonl capture errors" in p for p in self.problems()))
        self.capture(path, 3)
        self.assertFalse(any("recovered.jsonl capture errors" in p for p in self.problems()))

    def test_error_since_invalid_or_future_is_unknown(self):
        path = self.write("claude/projects/p/bad-error.jsonl", b"{}\n")
        for value in ("invalid", self.now + 1):
            self.capture(path, 3, errors=1, error_since=value)
            self.assertTrue(any("bad-error.jsonl capture errors for unknown age" in p for p in self.problems()))

    def test_error_without_error_since_column_uses_observation_fallback(self):
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("ALTER TABLE native_capture_files DROP COLUMN error_since")
        path = self.write("claude/projects/p/legacy-error.jsonl", b"{}\n")
        st = os.stat(path)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("INSERT INTO native_capture_files(path,inode,offset,phys_size,complete,error_count) "
                        "VALUES (?,?,?,?,?,0)", (path, st.st_ino, 3, st.st_size, 1))
        self.assertEqual(self.problems(), [])
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("UPDATE native_capture_files SET error_count=1 WHERE path=?", (path,))
        self.assertFalse(any("capture errors" in p for p in self.problems(self.now + 1)))
        self.assertTrue(any("capture errors" in p for p in self.problems(self.now + 1802)))

    def test_compressed_source_timestamp_after_uncompressed_offset(self):
        first = self.timestamped(self.now - 10)
        old = self.timestamped(self.now - hc.NATIVE_LAG_MAX - 1)
        path = self.compressed("codex/sessions/compressed.jsonl.zst", first + old)
        self.capture(path, len(first), complete=0)
        self.assertTrue(any("compressed.jsonl.zst" in p and "901 s" in p for p in self.problems()))
        self.capture(path, len(first + old), complete=1)
        self.assertFalse(any("compressed.jsonl.zst" in p for p in self.problems()))

    def test_compressed_offset_above_cap_is_unknown_even_with_seen(self):
        path = self.compressed("codex/sessions/cap.jsonl.zst", self.timestamped(self.now))
        self.capture(path, 0, complete=1)
        self.assertEqual(self.problems(), [])
        self.capture(path, hc.NATIVE_ZSTD_MAX_OFFSET + 1, complete=0)
        self.assertTrue(any("cap.jsonl.zst" in p and "age unknown (compressed)" in p for p in self.problems()))
        self.assertTrue(any("cap.jsonl.zst" in p and "age unknown (compressed)" in p
                            for p in self.problems(self.now + 1)))

    def test_compressed_exact_cap_uses_uncompressed_offset(self):
        line = self.timestamped(self.now - hc.NATIVE_LAG_MAX - 1)
        offset = 4096
        path = self.compressed("codex/sessions/exact-cap.jsonl.zst", b"x" * offset + line)
        self.capture(path, offset, complete=0)
        with mock.patch.object(hc, "NATIVE_ZSTD_MAX_OFFSET", offset):
            self.assertTrue(any("exact-cap.jsonl.zst" in p and "901 s" in p for p in self.problems()))

    def test_compressed_changed_representation_is_unhealthy(self):
        path = self.compressed("codex/sessions/changed.jsonl.zst", self.timestamped(self.now))
        self.capture(path, 0, size=os.stat(path).st_size + 1, complete=1)
        self.assertTrue(any("changed.jsonl.zst capture checkpoint does not match file" in p
                            for p in self.problems()))

    def test_compressed_read_limits_decompressed_output(self):
        class ReadPipe:
            def __init__(self):
                self.reads = []

            def read(self, size):
                self.reads.append(size)
                return b"x" * size

            def close(self):
                pass

        class FakeProcess:
            def __init__(self):
                self.stdout = ReadPipe()

            def poll(self):
                return None

            def kill(self):
                pass

            def wait(self):
                pass

        proc = FakeProcess()
        offset = 69_000
        with mock.patch("transcript_capture.zstd_bin", return_value="zstd"), \
                mock.patch.object(hc.subprocess, "Popen", return_value=proc):
            self.assertIsNone(hc._native_first_line("unused.zst", offset, True))
        self.assertEqual(sum(proc.stdout.reads), offset + hc.NATIVE_ZSTD_LINE_LIMIT)
        self.assertLessEqual(max(proc.stdout.reads), 65536)

    def test_compressed_line_above_one_mib_is_unknown(self):
        line = b'{"pad":"' + b"x" * hc.NATIVE_ZSTD_LINE_LIMIT + b'","timestamp":"2027-01-15T08:00:00Z"}\n'
        path = self.compressed("codex/sessions/long.jsonl.zst", line)
        self.capture(path, 0, complete=0)
        self.assertTrue(any("long.jsonl.zst" in p and "unknown" in p for p in self.problems()))

    def test_compressed_incomplete_file_remains_conservative(self):
        path = self.compressed("codex/sessions/partial.jsonl.zst", b'{"partial":')
        self.capture(path, 0, complete=0)
        self.assertTrue(any("partial.jsonl.zst" in p and "unknown" in p for p in self.problems()))

    def test_compressed_pending_and_error_are_checked(self):
        path = self.write("codex/sessions/rollout.jsonl.zst", b"compressed bytes")
        self.capture(path, 0, complete=0, errors=1)
        self.assertTrue(any("pending bytes" in p for p in self.problems()))
        self.assertTrue(any("capture errors" in p for p in self.problems(self.now + 1801)))
        self.capture(path, 100, complete=1, errors=0)
        self.assertFalse(any("rollout.jsonl.zst" in p for p in self.problems()))

    def test_cleanup_period(self):
        with open(self.claude_settings, "w") as f:
            json.dump({"cleanupPeriodDays": 30}, f)
        self.assertFalse(hc.check_claude_retention()[0])
        with open(self.claude_settings, "w") as f:
            json.dump({"cleanupPeriodDays": 36500}, f)
        self.assertTrue(hc.check_claude_retention()[0])


if __name__ == "__main__":
    unittest.main()
