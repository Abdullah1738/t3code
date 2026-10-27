"""Backend selection and session reaper protection rules.

Runs on the system python, touches no real data:
  python3 -m unittest discover -s tests -p 'test_*.py'
"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
sys.path.insert(0, SRC)

import backend  # noqa: E402
import session_reaper  # noqa: E402

ENV_KEYS = ("MEMORY_BACKEND", "OPENCHAMBER_URL", "OPENCODE_SERVICE_URL", "OPENCODE_SERVER_PASSWORD",
            "OPENCODE_PASSWORD_FILE", "T3_CONTROL_URL", "T3_CONTROL_TOKEN", "T3_CONTROL_TOKEN_FILE",
            "ROBOB_STATE_DB", "OPENCODE_DB")


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
    env.update(extra)
    return mock.patch.dict(os.environ, env, clear=True)


def provider_thread(con, thread_id, ses):
    payload = {"appThreadId": thread_id, "nativeThreadRef": {"driver": "opencode", "nativeId": ses}}
    con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                ("pt:" + thread_id, thread_id, None, "opencode", None, "idle", 1, 1, "t",
                 json.dumps(payload), "opencode", "opencode"))


def task_message(con, mid, thread_id, task_id, at, role="user"):
    payload = {"id": mid, "threadId": thread_id, "scheduledTaskId": task_id}
    con.execute("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, thread_id, None, None, role, 0, at, at, json.dumps(payload)))


def make_state_db(path, board=True):
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, thread_id TEXT);
        CREATE TABLE orchestration_v2_projection_provider_threads (
          provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT,
          provider_session_id TEXT, status TEXT, first_run_ordinal INTEGER, last_run_ordinal INTEGER,
          updated_at TEXT, payload_json TEXT, driver TEXT, provider_instance_id TEXT);
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, node_id TEXT, role TEXT,
          streaming INTEGER, created_at TEXT, updated_at TEXT, payload_json TEXT);
        CREATE TABLE ardud_opencode_import (native_session_id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, imported_at TEXT);
    """)
    # task A launched two threads; only the newest one is protected
    con.execute("INSERT INTO scheduled_tasks VALUES ('task:a', NULL)")
    task_message(con, "m1", "th-a-old", "task:a", "2026-10-01T00:00:00Z")
    task_message(con, "m2", "th-a-new", "task:a", "2026-10-02T00:00:00Z")
    provider_thread(con, "th-a-old", "ses_a_old")
    provider_thread(con, "th-a-new", "ses_a_new")
    # task B posts into a bound thread, imported from OpenCode
    con.execute("INSERT INTO scheduled_tasks VALUES ('task:b', 'th-b')")
    con.execute("INSERT INTO ardud_opencode_import VALUES ('ses_b', 'th-b', 't')")
    # a deleted task's old thread is not protected
    task_message(con, "m3", "th-gone", "task:gone", "2026-10-02T00:00:00Z")
    provider_thread(con, "th-gone", "ses_gone")
    if board:
        con.executescript("""
            CREATE TABLE ardud_board_rows (thread_id TEXT PRIMARY KEY, backlog INTEGER NOT NULL,
                                           deleted INTEGER NOT NULL);
            CREATE TABLE ardud_board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        con.execute("INSERT INTO ardud_board_rows VALUES ('th-back', 1, 0)")
        con.execute("INSERT INTO ardud_board_rows VALUES ('th-back-deleted', 1, 1)")
        con.execute("INSERT INTO ardud_board_rows VALUES ('th-done', 0, 0)")
        for t in ("th-back", "th-back-deleted", "th-done"):
            provider_thread(con, t, "ses_" + t.replace("-", "_"))
    con.commit()
    con.close()


class BackendSelection(unittest.TestCase):
    def test_default_is_openchamber_without_auth(self):
        with clean_env():
            self.assertEqual(backend.name(), "openchamber")
            self.assertEqual(backend.opencode_url(), "http://127.0.0.1:57123")
            self.assertEqual(backend.opencode_headers(), {})
            req = backend.opencode_request("GET", "/api/session/active")
            self.assertEqual(req.full_url, "http://127.0.0.1:57123/api/session/active")
            self.assertIsNone(req.get_header("Authorization"))

    def test_openchamber_url_override(self):
        with clean_env(OPENCHAMBER_URL="http://127.0.0.1:1/"):
            self.assertEqual(backend.opencode_url(), "http://127.0.0.1:1")

    def test_robob_uses_service_with_basic_auth(self):
        with clean_env(MEMORY_BACKEND="Robob", OPENCODE_SERVER_PASSWORD="pw"):
            self.assertTrue(backend.is_robob())
            self.assertEqual(backend.opencode_url(), "http://127.0.0.1:49374")
            req = backend.opencode_request("DELETE", "/api/session/ses_x")
            self.assertEqual(req.get_method(), "DELETE")
            self.assertEqual(req.get_header("Authorization"),
                             "Basic " + base64.b64encode(b"opencode:pw").decode())

    def test_robob_password_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "password")
            with open(p, "w") as fh:
                fh.write("filepw\n")
            with clean_env(MEMORY_BACKEND="robob", OPENCODE_PASSWORD_FILE=p,
                           OPENCODE_SERVICE_URL="http://127.0.0.1:2"):
                self.assertEqual(backend.opencode_password(), "filepw")
                self.assertEqual(backend.opencode_url(), "http://127.0.0.1:2")
            with clean_env(MEMORY_BACKEND="robob", OPENCODE_PASSWORD_FILE=os.path.join(d, "none")):
                with self.assertRaises(RuntimeError):
                    backend.opencode_headers()

    def test_unknown_backend_rejected(self):
        with clean_env(MEMORY_BACKEND="hermes"):
            with self.assertRaises(ValueError):
                backend.name()

    def test_control_config_file_must_be_private(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "ctl.json")
            with open(p, "w") as fh:
                json.dump({"url": "http://127.0.0.1:3/", "token": "tok"}, fh)
            os.chmod(p, 0o644)
            with clean_env(T3_CONTROL_TOKEN_FILE=p):
                with self.assertRaises(RuntimeError):
                    backend.control_config()
            os.chmod(p, 0o600)
            with clean_env(T3_CONTROL_TOKEN_FILE=p):
                self.assertEqual(backend.control_config(), ("http://127.0.0.1:3", "tok"))
            with clean_env(T3_CONTROL_TOKEN_FILE=p, T3_CONTROL_URL="http://h", T3_CONTROL_TOKEN="env"):
                self.assertEqual(backend.control_config(), ("http://h", "env"))
            with clean_env(T3_CONTROL_TOKEN_FILE=os.path.join(d, "none")):
                with self.assertRaises(RuntimeError):
                    backend.control_config()

    def test_control_config_reads_memory_credential_and_ignores_shared_file(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, ".robob/components"))
            for rel, tok in ((".robob/ardud-control.json", "shared"), (".robob/components/memory.json", "own")):
                p = os.path.join(d, rel)
                with open(p, "w") as fh:
                    json.dump({"url": "http://127.0.0.1:3", "token": tok}, fh)
                os.chmod(p, 0o600)
            with clean_env(), mock.patch.object(backend, "HOME", d):
                self.assertEqual(backend.control_config(), ("http://127.0.0.1:3", "own"))
                os.remove(os.path.join(d, ".robob/components/memory.json"))
                with self.assertRaises(RuntimeError):
                    backend.control_config()


class RobobState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "statev2.sqlite")

    def tearDown(self):
        self.tmp.cleanup()

    def test_current_native_session(self):
        con = sqlite3.connect(self.db)
        con.executescript("""
            CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,
                                                              active_provider_thread_id TEXT);
            CREATE TABLE orchestration_v2_projection_provider_threads (
              provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT,
              last_run_ordinal INTEGER, updated_at TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_runs (
              run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider_thread_id TEXT,
              status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_run_attempts (
              attempt_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT,
              provider_thread_id TEXT, status TEXT, payload_json TEXT);
        """)
        natives = {}

        def pt(ptid, thread_id, native, last_run=None, owner=None):
            natives[ptid] = native
            ref = None if native is None else {"nativeId": native}
            con.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?,?,?,?)",
                        (ptid, thread_id, owner, last_run, "2026-10-01T00:00:00Z",
                         json.dumps({"nativeThreadRef": ref})))

        def run(thread_id, n, ptid, status="completed", started=True,
                at="2026-09-01T00:00:00.000Z", start_at=None, attempt_started=None):
            # the run's active attempt is on ptid; attempt_started=False is an attempt
            # that never got going while the run kept an earlier startedAt
            start_at = start_at or at
            if attempt_started is None:
                attempt_started = started
            run_id, attempt_id = f"run:{thread_id}:{n}", f"attempt:{thread_id}:{n}"
            payload = {"activeAttemptId": attempt_id}
            if started:
                payload["startedAt"] = start_at
            done = None if status in ("queued", "running") else start_at
            con.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?,?,?,?,?)",
                        (run_id, thread_id, n, ptid, status, at, done, json.dumps(payload)))
            attempt = {"startedAt": start_at if attempt_started else None,
                       "nativeThreadId": natives[ptid] if attempt_started else None,
                       "completedAt": done}
            con.execute("INSERT INTO orchestration_v2_projection_run_attempts VALUES (?,?,?,?,?,?)",
                        (attempt_id, thread_id, run_id, ptid, status, json.dumps(attempt)))

        def runs(thread_id, *ptids):
            for n, ptid in enumerate(ptids, 1):
                run(thread_id, n, ptid)

        # reset: old OpenCode session, then a newer one
        pt("pt:reset-old", "reset", "ses_old")
        pt("pt:reset-new", "reset", "ses_new")
        runs("reset", "pt:reset-old", "pt:reset-new")
        # switched from OpenCode to another provider
        pt("pt:switch-old", "switch", "ses_switch")
        pt("pt:switch-new", "switch", "claude-native-id")
        runs("switch", "pt:switch-old", "pt:switch-new")
        # a native subagent's child thread (owned by a parent node, no runs of its own)
        pt("pt:child", "child", "ses_child", owner="node:parent")
        # active provider thread without a native ref yet
        pt("pt:fresh", "fresh", None)
        # startup recovery rewrote an old provider thread and moved the pointer back
        pt("pt:back-old", "back", "ses_back_old")
        pt("pt:back-new", "back", "ses_back_new")
        runs("back", "pt:back-old", "pt:back-new")
        # a dispatched reset whose new session doesn't exist yet, pointer moved back
        pt("pt:pending-old", "pending", "ses_pending_old", 1)
        pt("pt:pending-new", "pending", None, 2)
        runs("pending", "pt:pending-old", "pt:pending-new")
        # a handoff restarted the newest run on another provider thread with the same
        # ordinal, then recovery moved the pointer back to the old one
        pt("pt:hand-old", "hand", "ses_hand_old", 3)
        pt("pt:hand-new", "hand", "ses_hand_new", 3)
        runs("hand", "pt:hand-old", "pt:hand-old", "pt:hand-new")
        # an imported thread that later got a second provider thread without a run
        pt("pt:import-a", "import", "ses_import_a")
        pt("pt:import-b", "import", "ses_import_b")
        # a provider switch queued back onto an old provider thread, cancelled before it
        # started, then recovery moved the pointer to that old thread too
        pt("pt:queued-a", "queued", "ses_queued_a")
        pt("pt:queued-b", "queued", "ses_queued_b")
        runs("queued", "pt:queued-a", "pt:queued-b")
        run("queued", 3, "pt:queued-a", status="cancelled", started=False)
        # running on B while the pointer says A
        pt("pt:busy-a", "busy", "ses_busy_a")
        pt("pt:busy-b", "busy", "ses_busy_b")
        runs("busy", "pt:busy-a")
        run("busy", 2, "pt:busy-b", status="running")
        # a turn running on the thread's only session
        pt("pt:live", "live", "ses_live")
        run("live", 1, "pt:live", status="running")
        # last turn requested recently
        pt("pt:recent", "recent", "ses_recent")
        run("recent", 1, "pt:recent", at="2026-10-20T00:00:00.000Z")
        # a steering restart moved the newest run back to old provider thread A and
        # failed before that attempt started; the run kept its earlier startedAt
        pt("pt:steer-a", "steer", "ses_steer_a")
        pt("pt:steer-b", "steer", "ses_steer_b")
        runs("steer", "pt:steer-a")
        run("steer", 2, "pt:steer-a", status="failed", attempt_started=False)
        # held since September, started and failed recently
        pt("pt:held", "held", "ses_held")
        run("held", 1, "pt:held", status="failed", start_at="2026-10-21T00:00:00.000Z")
        con.executemany("INSERT INTO orchestration_v2_projection_threads VALUES (?,?)", [
            ("reset", "pt:reset-new"), ("switch", "pt:switch-new"), ("child", "pt:child"),
            ("fresh", "pt:fresh"), ("idle", None), ("back", "pt:back-old"),
            ("pending", "pt:pending-old"), ("hand", "pt:hand-old"), ("import", "pt:import-a"),
            ("queued", "pt:queued-a"), ("busy", "pt:busy-a"), ("live", "pt:live"),
            ("recent", "pt:recent"), ("steer", "pt:steer-a"), ("held", "pt:held")])
        con.commit()
        con.close()
        with clean_env(ROBOB_STATE_DB=self.db):
            self.assertEqual(backend.current_native_session("reset"), "ses_new")
            self.assertEqual(backend.current_native_session("switch"), "claude-native-id")
            self.assertEqual(backend.current_native_session("child"), "ses_child")
            self.assertIsNone(backend.current_native_session("fresh"))
            self.assertIsNone(backend.current_native_session("idle"))
            self.assertIsNone(backend.current_native_session("missing"))
            self.assertIsNone(backend.current_native_session("back"))
            self.assertIsNone(backend.current_native_session("pending"))
            self.assertIsNone(backend.current_native_session("hand"))
            self.assertIsNone(backend.current_native_session("import"))
            self.assertIsNone(backend.current_native_session("queued"))
            self.assertIsNone(backend.current_native_session("busy"))
            self.assertIsNone(backend.current_native_session("live"))
            self.assertIsNone(backend.current_native_session("steer"))
            quiet = "2026-10-01T00:00:00.000Z"
            self.assertEqual(backend.current_native_session("recent"), "ses_recent")
            self.assertIsNone(backend.current_native_session("recent", quiet))
            self.assertEqual(backend.current_native_session("reset", quiet), "ses_new")
            self.assertEqual(backend.current_native_session("child", quiet), "ses_child")
            self.assertEqual(backend.current_native_session("held"), "ses_held")
            self.assertIsNone(backend.current_native_session("held", quiet))

    def test_scheduled_task_sessions(self):
        make_state_db(self.db)
        with clean_env(ROBOB_STATE_DB=self.db):
            con = backend.robob_ro()
            self.assertEqual(backend.scheduled_task_session_ids(con), {"ses_a_new", "ses_b"})
            con.close()

    def test_board_backlog(self):
        make_state_db(self.db)
        with clean_env(ROBOB_STATE_DB=self.db):
            con = backend.robob_ro()
            self.assertEqual(backend.board_backlog_session_ids(con), {"ses_th_back"})
            con.close()

    def test_board_missing_is_none(self):
        make_state_db(self.db, board=False)
        with clean_env(ROBOB_STATE_DB=self.db):
            con = backend.robob_ro()
            self.assertIsNone(backend.board_backlog_session_ids(con))
            con.close()


class ReaperProtection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "statev2.sqlite")
        self.keep = os.path.join(self.tmp.name, "keep.txt")
        with open(self.keep, "w") as fh:
            fh.write("# comment\nses_kept why\n")
        self.conf = os.path.join(self.tmp.name, "openchamber")
        self.patches = [mock.patch.object(session_reaper, "KEEP_FILE", self.keep),
                        mock.patch.object(session_reaper, "OC_CONF", self.conf)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def write_openchamber(self, board=True):
        os.makedirs(os.path.join(self.conf, "projects"))
        with open(os.path.join(self.conf, "projects", "p.json"), "w") as fh:
            json.dump({"scheduledTasks": [{"state": {"lastSessionId": "ses_task"}}, {"state": {}}]}, fh)
        if board:
            with open(os.path.join(self.conf, "session-board.json"), "w") as fh:
                json.dump({"records": [{"sessionId": "ses_back", "backlog": True}, {"sessionId": "ses_no"}]}, fh)

    def test_robob_protected_ids(self):
        make_state_db(self.db)
        with clean_env(MEMORY_BACKEND="robob", ROBOB_STATE_DB=self.db):
            self.assertEqual(session_reaper.protected_ids(),
                             {"ses_kept", "ses_a_new", "ses_b", "ses_th_back"})
            # old OpenChamber task sessions stay protected; its board is not consulted
            self.write_openchamber()
            self.assertEqual(session_reaper.protected_ids(),
                             {"ses_kept", "ses_a_new", "ses_b", "ses_th_back", "ses_task"})

    def test_robob_without_board_table_still_runs(self):
        make_state_db(self.db, board=False)
        with clean_env(MEMORY_BACKEND="robob", ROBOB_STATE_DB=self.db):
            self.assertEqual(session_reaper.backlog_ids(), set())
            self.assertEqual(session_reaper.protected_ids(), {"ses_kept", "ses_a_new", "ses_b"})

    def test_robob_unreadable_board_fails_closed(self):
        make_state_db(self.db, board=False)
        con = sqlite3.connect(self.db)
        con.execute("CREATE TABLE ardud_board_rows (id TEXT)")
        con.commit()
        con.close()
        with clean_env(MEMORY_BACKEND="robob", ROBOB_STATE_DB=self.db):
            with self.assertRaises(session_reaper.Gate) as cm:
                session_reaper.backlog_ids()
            self.assertIn("board", str(cm.exception))

    def test_robob_missing_state_db_fails_closed(self):
        with clean_env(MEMORY_BACKEND="robob", ROBOB_STATE_DB=os.path.join(self.tmp.name, "nope.sqlite")):
            with self.assertRaises(session_reaper.Gate):
                session_reaper.protected_ids()

    def test_openchamber_path_unchanged(self):
        self.write_openchamber()
        conf = self.conf
        with clean_env():
            self.assertEqual(session_reaper.protected_ids(), {"ses_kept", "ses_task", "ses_back"})
            with open(os.path.join(conf, "session-board.json"), "w") as fh:
                fh.write("{broken")
            with self.assertRaises(session_reaper.Gate):
                session_reaper.protected_ids()
            os.remove(os.path.join(conf, "session-board.json"))
            self.assertEqual(session_reaper.backlog_ids(), set())

    def test_archive_robob_thread(self):
        q = "2026-09-22T00:00:00.000Z"
        with clean_env(MEMORY_BACKEND="robob"), \
                mock.patch.object(backend, "thread_for_session", return_value=None):
            self.assertEqual(session_reaper.archive_robob_thread("ses_x", q), (None, False))
        current = {"threadId": "t1", "archived": False}
        with clean_env(MEMORY_BACKEND="robob"), \
                mock.patch.object(backend, "thread_for_session", return_value=current), \
                mock.patch.object(backend, "current_native_session", return_value="ses_x") as cur, \
                mock.patch.object(backend, "archive_thread") as arch:
            self.assertEqual(session_reaper.archive_robob_thread("ses_x", q), ("t1", True))
            cur.assert_called_once_with("t1", q)
            arch.assert_called_once_with("t1")
        with clean_env(MEMORY_BACKEND="robob"), \
                mock.patch.object(backend, "thread_for_session", return_value={**current, "archived": True}), \
                mock.patch.object(backend, "current_native_session", return_value="ses_x"), \
                mock.patch.object(backend, "archive_thread") as arch:
            session_reaper.archive_robob_thread("ses_x", q)
            arch.assert_not_called()

    def test_archive_skips_thread_that_moved_on(self):
        # A context reset or provider switch leaves the old session bound to the live thread.
        for active in ("ses_new", "claude-native-id", None):
            with clean_env(MEMORY_BACKEND="robob"), \
                    mock.patch.object(backend, "thread_for_session",
                                      return_value={"threadId": "t1", "archived": False}), \
                    mock.patch.object(backend, "current_native_session", return_value=active), \
                    mock.patch.object(backend, "archive_thread") as arch:
                self.assertEqual(session_reaper.archive_robob_thread("ses_old", "2026-09-22T00:00:00.000Z"),
                                 ("t1", False))
                arch.assert_not_called()

    def test_by_native_404_is_no_thread(self):
        with mock.patch.object(backend, "control", return_value=(404, {"ok": False})):
            self.assertIsNone(backend.thread_for_session("ses_x"))
        with mock.patch.object(backend, "control", return_value=(500, {"ok": False})):
            with self.assertRaises(RuntimeError):
                backend.thread_for_session("ses_x")


if __name__ == "__main__":
    unittest.main()
