cat > /tmp/recall649-write-tests.py <<'PY'
from pathlib import Path
p=Path('/Users/ardud/checkouts/recall-649/integrations/memory-system/tests/test_recall_replica_grace.py')
p.write_text('''"""Caller fallback and publication races, using tiny isolated replicas only."""
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_recall import build_fixture
import recall_core as rc
import recall_ask as ra
import robob_readonly as ro


class GraceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        build_fixture(self.root)
        for attr, name in (("MEM_DB", "memory.db"), ("CATALOG_DB", "catalog.db"),
                           ("STATE_DB", "statev2.sqlite"), ("OPENCODE_DB", "opencode.db")):
            self.enterContext(patch.object(rc, attr, self.root / name))
        self.enterContext(patch.object(rc, "_local", threading.local()))
        self.enterContext(patch.object(rc, "_state_snapshot", None))
        self.enterContext(patch.object(rc, "_state_snapshot_generation", None))
        self.enterContext(patch.object(rc, "_caller_lineages", {}))
        self.enterContext(patch.object(rc, "_driver_bindings", {}))
        self.enterContext(patch.object(rc, "_state_reads", rc._BudgetLock(threading.BoundedSemaphore(2))))
        rc.refresh_catalog(full=True)
        self.addCleanup(rc.close_readers)
        with closing(sqlite3.connect(rc.STATE_DB)) as con, con:
            con.execute("UPDATE orchestration_v2_projection_provider_threads SET driver='codex' WHERE thread_id='thread-other'")

    def unavailable(self, path=None, *, stale=False):
        with closing(sqlite3.connect(path or rc.STATE_DB)) as con, con:
            if stale:
                con.execute("UPDATE ardud_readonly_meta SET value='2000-01-01T00:00:00Z' WHERE key='updated_at'")
            else:
                con.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")

    def lineage(self, caller="thread-other", driver="codex"):
        return ra.lineage_of(None, None, caller_thread=caller, caller_driver=driver, allow_degraded=True)

    def test_stale_cached_and_restart_gap_keep_exclusions(self):
        expected = self.lineage()
        self.assertIn("other-native", expected)
        self.unavailable(stale=True)
        now = rc.time.monotonic()
        with patch.object(rc.time, "monotonic", return_value=now + 10 * 60):
            actual = self.lineage()
        self.assertEqual(actual, expected)
        self.assertIn("cached lineage", rc.lineage_note())

    def test_not_ready_without_snapshot_answers_with_note(self):
        self.unavailable()
        result = self.lineage()
        self.assertIn("thread-other", result)
        self.assertIn("self-exclusion skipped", rc.lineage_note())
        self.assertIn("driver check skipped", rc.lineage_note())

    def test_expired_cache_is_not_reused(self):
        self.lineage()
        self.unavailable()
        now = rc.time.monotonic()
        with patch.object(rc.time, "monotonic", return_value=now + 901):
            self.assertNotIn("other-native", self.lineage())
        self.assertIn("self-exclusion skipped", rc.lineage_note())

    def test_fresh_cached_caller_does_not_take_state_slots(self):
        expected = self.lineage()
        with patch.object(rc._state_reads, "acquire", side_effect=AssertionError("read slot")):
            self.assertEqual(self.lineage(), expected)

    def test_driver_mismatch_still_refuses(self):
        self.lineage()
        with self.assertRaisesRegex(rc.UnknownCaller, "caller driver does not match"):
            self.lineage(driver="claudeAgent")

    def test_driver_only_metadata_is_reported(self):
        result = ra.lineage_of(None, None, caller_driver="codex", allow_degraded=True)
        self.assertEqual(result, set())
        self.assertIn("driver check skipped", rc.lineage_note())

    def test_legacy_session_id_can_verify_driver(self):
        self.assertIn("other-native", ra.lineage_of("other-native", None, caller_driver="codex", allow_degraded=True))

    def test_busy_slots_wait_then_skip(self):
        rc._state_reads.acquire()
        rc._state_reads.acquire()
        try:
            with patch.object(rc._state_reads.lock, "acquire", wraps=rc._state_reads.lock.acquire):
                pass
        except AttributeError:
            pass
        try:
            start = rc.time.monotonic()
            with patch.object(rc._local, "deadline", rc.Deadline(0.5), create=True):
                result = self.lineage(driver=None)
            self.assertGreaterEqual(rc.time.monotonic() - start, 0.20)
            self.assertIn("self-exclusion skipped", rc.lineage_note())
            self.assertIn("thread-other", result)
        finally:
            rc._state_reads.release()
            rc._state_reads.release()

    def test_slot_freed_during_wait_uses_fresh_lineage(self):
        rc._state_reads.acquire()
        rc._state_reads.acquire()
        acquired = threading.Event()
        original = rc._state_reads.lock
        class Observed:
            def acquire(self, *a, **kw):
                acquired.set()
                return original.acquire(*a, **kw)
            def release(self):
                original.release()
        rc._state_reads.lock = Observed()
        def free():
            self.assertTrue(acquired.wait(2))
            original.release()
        worker = threading.Thread(target=free)
        worker.start()
        try:
            self.assertIn("other-native", self.lineage())
            self.assertNotIn("skipped", rc.lineage_note())
        finally:
            original.release()
            worker.join(2)

    def test_cached_binding_refuses_mismatch_while_unsafe(self):
        self.lineage()
        self.unavailable()
        with self.assertRaisesRegex(rc.UnknownCaller, "caller driver does not match"):
            self.lineage(driver="claudeAgent")

    def test_replica_publish_during_build_and_next_call(self):
        real = rc._build_state_snapshot
        def publish(con, *args):
            result = real(con, *args)
            with closing(sqlite3.connect(rc.STATE_DB)) as writer, writer:
                writer.execute("UPDATE ardud_readonly_meta SET value='2099-01-01T00:00:00Z' WHERE key='updated_at'")
                writer.execute("UPDATE ardud_readonly_meta SET value=? WHERE key='updated_at'", (ro.datetime.now(ro.timezone.utc).isoformat(),))
            return result
        with patch.object(rc, "_build_state_snapshot", side_effect=publish):
            self.assertIn("other-native", self.lineage())
        self.assertIn("other-native", self.lineage())
        self.assertNotIn("skipped", rc.lineage_note())

    def test_opencode_not_ready_uses_cached_lineage(self):
        expected = self.lineage(caller="ses_resume_old", driver=None)
        self.unavailable(rc.OPENCODE_DB)
        self.assertEqual(self.lineage(caller="ses_resume_old", driver=None), expected)
        self.assertIn("cached lineage", rc.lineage_note())


if __name__ == "__main__":
    unittest.main()
''')
PY
/usr/bin/python3 /tmp/recall649-write-tests.py
/Users/ardud/.local/share/memory-system/.venv/bin/python -m unittest discover -s integrations/memory-system/tests -p test_recall_replica_grace.py