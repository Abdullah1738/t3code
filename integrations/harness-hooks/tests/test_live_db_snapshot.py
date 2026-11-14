if __package__:
    from . import test_environment
else:
    import test_environment

import argparse
from contextlib import ExitStack, closing
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import live_db_snapshot as helper


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        if self.server.fail:
            self.send_error(503)
            return
        raw = json.dumps({"card": self.server.card}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.db = self.root / "fixture.sqlite"
        self.source = sqlite3.connect(self.db)
        self.addCleanup(self.source.close)
        self.source.execute("pragma journal_mode=wal")
        self.source.execute("create table example(value text)")
        self.source.execute("insert into example values ('private row must not be logged')")
        self.source.commit()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.requests = []
        self.server.fail = False
        self.ask = {"id": "q1", "text": "May I copy the database?", "options": [{"id": "yes", "label": "Approve copy"}],
                    "answer": {"by": {"_tag": "owner"}, "verdict": "picked", "optionIds": ["yes"],
                               "at": datetime.now(timezone.utc).isoformat()}}
        self.server.card = {"id": "card-fixture", "asks": [self.ask]}
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        token = self.root / "component.json"
        token.write_text(json.dumps({"token": "fixture-token"}))
        token.chmod(0o600)
        self.stack.enter_context(patch.dict(os.environ, {
            "HARNESS_HOOKS_CONTROL_URL": f"http://127.0.0.1:{self.server.server_port}/api/ardud/control",
            "HARNESS_HOOKS_TOKEN_FILE": str(token), "TOOLLOG_ROOT": str(self.root / "tools")}))
        self.stack.enter_context(patch.object(Path, "home", return_value=self.root))
        self.stack.enter_context(patch.object(helper.statev2_guard, "protected_databases", return_value={self.db.resolve()}))
        self.args = argparse.Namespace(card="card-fixture", ask="q1", db=str(self.db), board=None, out_parent=str(self.root / "output"))

    def snapshot(self):
        return helper.snapshot(self.args)

    def test_owner_approved_wal_snapshot_and_metadata_only(self):
        result = self.snapshot()
        path = Path(result["path"])
        with closing(sqlite3.connect(path)) as db:
            self.assertEqual(db.execute("select * from example").fetchall(), [("private row must not be logged",)])
        self.assertEqual(result["method"], "sqlite-backup")
        self.assertEqual(result["bytes"], path.stat().st_size)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(path.parent.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.server.requests, [("/api/ardud/kanban/cards/card-fixture", "Bearer fixture-token")])
        state = self.root / ".local/state/harness-hooks"
        for log in state.glob("*.jsonl"):
            self.assertNotIn("private row", log.read_text())
            self.assertNotIn("fixture-token", log.read_text())
        row = json.loads((state / "decisions.jsonl").read_text())
        self.assertEqual(row["check"], "allowed")
        self.assertGreater(row["bytes"], 0)
        self.assertEqual(row["db"], str(self.db.resolve()))

    def test_owner_and_answer_checks(self):
        cases = [
            ("evaluator", {"by": {"_tag": "evaluator"}}, "not from owner"),
            ("thread", {"by": {"_tag": "thread"}}, "not from owner"),
            ("declined", {"optionIds": ["reject"]}, "does not approve"),
            ("many picks", {"optionIds": ["approve", "reject"]}, "does not approve"),
            ("old", {"at": (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()}, "24 hours"),
            ("future", {"at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}, "24 hours"),
            ("naive", {"at": "2026-11-14T05:46:29"}, "24 hours"),
            ("invalid", {"at": "not a time"}, "24 hours"),
        ]
        original = dict(self.ask["answer"])
        for name, changes, reason in cases:
            with self.subTest(name=name):
                self.ask["answer"] = {**original, **changes}
                with self.assertRaisesRegex(helper.Refused, reason):
                    self.snapshot()
        self.assertFalse(Path(self.args.out_parent).exists())
        rows = (self.root / ".local/state/harness-hooks/decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(rows), len(cases))

    def test_missing_ask_and_copy_wording(self):
        self.args.ask = "q404"
        with self.assertRaisesRegex(helper.Refused, "ask not found"):
            self.snapshot()
        self.args.ask = "q1"
        self.ask["text"] = "May I inspect statistics?"
        with self.assertRaisesRegex(helper.Refused, "does not mention"):
            self.snapshot()

    def test_approval_shapes(self):
        for verdict, option, title in [("approve", None, "VACUUM"), ("picked", "approve", "snapshot"), ("picked", "yes", "clone")]:
            with self.subTest(verdict=verdict, title=title):
                self.ask["text"] = ""
                self.ask["title"] = title
                self.ask["answer"].update(verdict=verdict, optionIds=[option] if option else [])
                helper.approval(self.server.card, "q1", datetime.now(timezone.utc))

    def test_approval_time_boundary_and_utc_offset(self):
        now = datetime(2026, 11, 14, 8, tzinfo=timezone.utc)
        for stamp, allowed in [("2026-11-13T08:00:00Z", False),
                               ("2026-11-13T08:00:01Z", True),
                               ("2026-11-14T12:00:00+04:00", True),
                               ("2026-11-14T08:00:01Z", False)]:
            with self.subTest(stamp=stamp):
                self.ask["answer"]["at"] = stamp
                if allowed:
                    helper.approval(self.server.card, "q1", now)
                else:
                    with self.assertRaisesRegex(helper.Refused, "24 hours"):
                        helper.approval(self.server.card, "q1", now)

    def test_second_use_and_card_alias(self):
        self.snapshot()
        self.args.card = "41"
        self.args.board = "recall"
        alias = self.root / "alias.sqlite"
        alias.symlink_to(self.db)
        self.args.db = str(alias)
        with self.assertRaisesRegex(helper.Refused, "already used"):
            self.snapshot()
        self.assertEqual(len(list(Path(self.args.out_parent).iterdir())), 1)

    def test_existing_output_parent_is_not_chmodded(self):
        parent = Path(self.args.out_parent)
        parent.mkdir(mode=0o755)
        with self.assertRaisesRegex(helper.Refused, "output parent must be private"):
            self.snapshot()
        self.assertEqual(parent.stat().st_mode & 0o777, 0o755)

    def test_database_not_protected(self):
        self.args.db = str(self.root / "other.sqlite")
        with self.assertRaisesRegex(helper.Refused, "not protected"):
            self.snapshot()
        self.assertEqual(self.server.requests, [])

    def test_control_down_and_permissions_fail_closed(self):
        self.server.fail = True
        with self.assertRaisesRegex(helper.Refused, "control API unavailable"):
            self.snapshot()
        self.server.fail = False
        Path(os.environ["HARNESS_HOOKS_TOKEN_FILE"]).chmod(0o644)
        with self.assertRaisesRegex(helper.Refused, "control API unavailable"):
            self.snapshot()
        self.assertFalse(Path(self.args.out_parent).exists())

    def test_concurrent_claim_is_one_shot(self):
        state = self.root / "claims"
        barrier = threading.Barrier(2)
        results = []
        def take():
            barrier.wait()
            try:
                helper.claim(state, "card-fixture", "q1", self.db)
                results.append("allowed")
            except helper.Refused:
                results.append("refused")
        workers = [threading.Thread(target=take) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertCountEqual(results, ["allowed", "refused"])

    def test_failed_copy_consumes_approval(self):
        with patch.object(helper, "copy_database", side_effect=sqlite3.Error("private contents")):
            with self.assertRaisesRegex(helper.Refused, "snapshot failed"):
                self.snapshot()
        with self.assertRaisesRegex(helper.Refused, "already used"):
            self.snapshot()

    def test_clone_only_when_open_fails(self):
        destination = self.root / "clone.sqlite"
        with patch.object(helper.sqlite3, "connect", side_effect=sqlite3.OperationalError), patch.object(helper.subprocess, "run") as run:
            self.assertEqual(helper.copy_database(self.db, destination), "apfs-clone")
            self.assertEqual(len(run.call_args_list), 3)
            self.assertTrue(all(call.args[0][:2] == ["/bin/cp", "-c"] for call in run.call_args_list))
        with patch.object(helper.sqlite3, "connect", side_effect=[self.source, sqlite3.OperationalError]), patch.object(helper.subprocess, "run") as run:
            with self.assertRaises(sqlite3.Error):
                helper.copy_database(self.db, destination)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
