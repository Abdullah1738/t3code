"""All sources here are temporary fixtures, including the fake live DB identity."""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import backend
import native_session_reaper
import recall_core
import robob_readonly as ro
import sync_opencode_v2
import sync_thread_identity
from replica_fixture import ready


class ReadonlyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.live = self.home / ".robob/userdata/statev2.sqlite"
        self.replica = self.home / ".robob/userdata/readonly/state.sqlite"
        self.live.parent.mkdir(parents=True)
        self.replica.parent.mkdir()
        # Deliberately not SQLite: guard tests must refuse BEFORE connect.
        self.live.write_text("not a database")
        self.addCleanup(patch.stopall)
        patch.object(ro.Path, "home", return_value=self.home).start()
        patch.dict(os.environ, {"HOME": str(self.home)}, clear=True).start()

    def make_replica(self):
        with closing(sqlite3.connect(self.replica)) as con, con:
            ready(con)
            con.execute("CREATE TABLE marker(value TEXT)")
            con.execute("INSERT INTO marker VALUES ('replica')")

    def test_default_and_override_precedence(self):
        self.assertEqual(ro.state_db(), str(self.replica))
        self.assertEqual(ro.opencode_db(), str(self.replica.with_name("opencode.sqlite")))
        with patch.dict(os.environ, OPENCODE_READONLY_DB="native-export"):
            self.assertEqual(backend.opencode_db(), "native-export")
            with patch.dict(os.environ, OPENCODE_DB="legacy-export"):
                self.assertEqual(backend.opencode_db(), "legacy-export")
        with patch.dict(os.environ, ROBOB_READONLY_DB="shared", ROBOB_STATE_DB="component", RECALL_STATE_DB="recall"):
            self.assertEqual(backend.robob_state_db(), "component")
            self.assertEqual(ro.state_db("RECALL_STATE_DB"), "recall")
            self.assertEqual(ro.state_db(), "shared")

    def test_live_paths_and_aliases_refused_before_connect(self):
        symlink = self.home / "alias.sqlite"
        symlink.symlink_to(self.live)
        directory = self.home / "directory-alias"
        directory.symlink_to(self.live.parent, target_is_directory=True)
        hardlink = self.home / "hardlink.sqlite"
        os.link(self.live, hardlink)
        for path in (self.live, symlink, directory / self.live.name, hardlink,
                     self.live.as_uri() + "?mode=ro", "~/.robob/userdata/../userdata/statev2.sqlite"):
            with self.subTest(path=path), patch.object(ro.sqlite3, "connect") as connect:
                with self.assertRaises(ro.UnsafeStateDatabase):
                    ro.connect_ro(path)
                connect.assert_not_called()

    def test_physical_path_of_symlinked_userdata_refused(self):
        physical = self.home / "external/userdata"
        physical.mkdir(parents=True)
        self.live.rename(physical / self.live.name)
        # Only fixtures are moved; production metadata/content is never opened.
        self.replica.parent.rmdir()
        self.live.parent.rmdir()
        self.live.parent.symlink_to(physical, target_is_directory=True)
        with patch.object(ro.sqlite3, "connect") as connect:
            with self.assertRaises(ro.UnsafeStateDatabase):
                ro.connect_ro(physical / self.live.name)
            connect.assert_not_called()

    def test_custom_server_home_refused(self):
        custom = self.home / "custom/userdata/statev2.sqlite"
        with patch.dict(os.environ, T3CODE_HOME=str(custom.parents[1])), patch.object(ro.sqlite3, "connect") as connect:
            with self.assertRaises(ro.UnsafeStateDatabase):
                ro.connect_ro(custom)
            connect.assert_not_called()

    def test_live_opencode_and_aliases_refused_before_connect(self):
        native = self.home / ".local/share/opencode/opencode.db"
        native.parent.mkdir(parents=True)
        native.write_text("not a database")
        alias = self.home / "native-hardlink.sqlite"
        os.link(native, alias)
        link = self.home / "native-link.sqlite"
        link.symlink_to(native)
        for path in (native, alias, link):
            with self.subTest(path=path), patch.object(ro.sqlite3, "connect") as connect:
                with patch.dict(os.environ, OPENCODE_DB=str(path)):
                    with self.assertRaises(ro.UnsafeStateDatabase):
                        ro.connect_ro(backend.opencode_db())
                connect.assert_not_called()

    def test_components_and_separate_opencode_source_refuse_live_override(self):
        alias = self.home / "misconfigured.sqlite"
        os.link(self.live, alias)
        with patch.dict(os.environ, ROBOB_STATE_DB=str(alias)), patch.object(ro.sqlite3, "connect") as connect:
            with self.assertRaises(ro.UnsafeStateDatabase):
                backend.robob_ro()
            with self.assertRaises(ro.UnsafeStateDatabase):
                sync_thread_identity.sync(str(self.home / "memory.db"), str(alias))
            with patch.object(recall_core, "STATE_DB", alias):
                with self.assertRaises(ro.UnsafeStateDatabase):
                    recall_core.connect_ro(alias)
            with patch.object(recall_core, "CATALOG_DB", alias), patch.object(recall_core, "_local") as local:
                local.catalog_r = None
                local.catalog_w = None
                with self.assertRaises(ro.UnsafeStateDatabase):
                    recall_core.catalog(write=True)
            with patch.object(sync_opencode_v2, "SRC_DB", str(alias)):
                with self.assertRaises(ro.UnsafeStateDatabase):
                    sync_opencode_v2.Sync(None)
            self.assertEqual(native_session_reaper.settled_threads(alias), set())
            connect.assert_not_called()
        self.assertFalse((self.home / "memory.db").exists())

    def test_missing_does_not_connect_create_or_fallback(self):
        with patch.object(ro.sqlite3, "connect") as connect:
            with self.assertRaises(FileNotFoundError):
                backend.robob_ro()
            connect.assert_not_called()
        self.assertFalse(self.replica.exists())

    def test_readonly_real_file_with_uri_characters(self):
        self.make_replica()
        special = self.home / "replica ?# ü.sqlite"
        self.replica.rename(special)
        with closing(ro.state_ro(special)) as con:
            self.assertTrue(con.in_transaction)
            self.assertEqual(con.execute("SELECT value FROM marker").fetchone(), ("replica",))
            with self.assertRaises(sqlite3.OperationalError):
                con.execute("DELETE FROM marker")

    def test_not_ready_stale_invalid_and_missing_metadata_fail_closed(self):
        self.make_replica()
        now = datetime.now(timezone.utc)
        cases = [("0", now.isoformat()), ("1", (now - timedelta(seconds=121)).isoformat()),
                 ("1", (now + timedelta(minutes=2)).isoformat()), ("1", "bad"),
                 ("1", now.replace(tzinfo=None).isoformat()), ("1", None)]
        for flag, timestamp in cases:
            with self.subTest(flag=flag, timestamp=timestamp):
                with closing(sqlite3.connect(self.replica)) as con, con:
                    con.execute("UPDATE ardud_readonly_meta SET value=? WHERE key='ready'", (flag,))
                    con.execute("UPDATE ardud_readonly_meta SET value=? WHERE key='updated_at'", (timestamp,))
                with self.assertRaises(ro.UnsafeStateDatabase):
                    backend.robob_ro()
        with closing(sqlite3.connect(self.replica)) as con, con:
            con.execute("DROP TABLE ardud_readonly_meta")
        with self.assertRaises(ro.UnsafeStateDatabase):
            ro.state_ro(self.replica)

    def test_ready_check_and_projection_read_share_a_snapshot(self):
        self.make_replica()
        with closing(sqlite3.connect(self.replica)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            with closing(ro.state_ro(self.replica)) as reader:
                writer.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")
                writer.execute("UPDATE marker SET value='partial'")
                writer.commit()
                self.assertEqual(reader.execute("SELECT value FROM marker").fetchone(), ("replica",))
                with self.assertRaises(ro.UnsafeStateDatabase):
                    ro.state_ro(self.replica)

    def test_stale_native_export_cannot_supply_reaper_evidence(self):
        self.make_replica()
        old = time.time() - 121
        os.utime(self.replica, (old, old))
        with patch.object(ro.sqlite3, "connect") as connect:
            with self.assertRaises(ro.UnsafeStateDatabase):
                ro.native_ro(self.replica)
            connect.assert_not_called()

    def test_native_recall_reopens_replaced_export_and_never_falls_back(self):
        path = self.replica.with_name("opencode.sqlite")

        def native_fixture(target, sid):
            with closing(sqlite3.connect(target)) as con, con:
                con.execute("CREATE TABLE session_v2(id TEXT PRIMARY KEY)")
                con.execute("INSERT INTO session_v2 VALUES (?)", (sid,))

        native_fixture(path, "old")
        with patch.object(recall_core, "OPENCODE_DB", path), patch.object(recall_core, "_local", threading.local()):
            first = recall_core.opencode_ro()
            self.assertEqual(first.execute("SELECT id FROM session_v2").fetchone(), ("old",))
            other = path.with_name("next.sqlite")
            native_fixture(other, "new")
            os.replace(other, path)
            second = recall_core.opencode_ro()
            self.assertEqual(second.execute("SELECT id FROM session_v2").fetchone(), ("new",))
            with self.assertRaises(sqlite3.ProgrammingError):
                first.execute("SELECT 1")
            path.unlink()
            with patch.object(ro.sqlite3, "connect") as connect:
                self.assertIsNone(recall_core.opencode_ro())
                connect.assert_not_called()


class RecallReplicaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "export.sqlite"
        self.build(self.path, "old", "root-a")
        patch.object(recall_core, "STATE_DB", self.path).start()
        patch.object(recall_core, "_state_snapshot", None).start()
        patch.object(recall_core, "_state_snapshot_generation", None).start()
        self.addCleanup(patch.stopall)

    def build(self, path, native, root):
        with closing(sqlite3.connect(path)) as con, con:
            ready(con)
            con.executescript("""
                CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_type TEXT,stream_id TEXT,payload_json TEXT);
                CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json TEXT);
                CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT,thread_id TEXT,payload_json TEXT);
            """)
            con.execute("INSERT INTO orchestration_events VALUES (1,'unrelated','thread',NULL)")
            con.execute("INSERT INTO orchestration_v2_projection_threads VALUES ('thread',?)",
                        (json.dumps({"lineage": {"rootThreadId": root}}),))
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt','thread',?)",
                        (json.dumps({"nativeThreadRef": {"nativeId": native}}),))

    def test_atomic_replacement_with_same_sequence_rebuilds_cache(self):
        self.assertEqual(recall_core._state_cache().threads_by_native.get("old"), frozenset({"thread"}))
        other = self.path.with_name("next.sqlite")
        self.build(other, "new", "root-b")
        os.replace(other, self.path)
        result = recall_core._state_cache()
        self.assertNotIn("old", result.threads_by_native)
        self.assertEqual(result.lineage["thread"], (None, "root-b"))

    def test_new_ready_generation_rebuilds_without_event_history(self):
        recall_core._state_cache()
        with closing(sqlite3.connect(self.path)) as con, con:
            con.execute("UPDATE orchestration_v2_projection_threads SET payload_json=?",
                        (json.dumps({"lineage": {"rootThreadId": "root-b"}}),))
            ready(con)
        self.assertEqual(recall_core._state_cache().lineage["thread"], (None, "root-b"))

    def test_not_ready_even_with_warm_cache_fails_closed(self):
        recall_core._state_cache()
        with closing(sqlite3.connect(self.path)) as con, con:
            con.execute("UPDATE ardud_readonly_meta SET value='0' WHERE key='ready'")
        with self.assertRaises(ro.UnsafeStateDatabase):
            recall_core._state_cache()


if __name__ == "__main__":
    unittest.main()
