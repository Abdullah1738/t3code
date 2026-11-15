import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, capacity, common, home_run_observation as observation, misc


class HomeRunObservation(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in (("LOGS_DIR", self.root / "logs"), ("BACKEND_STATE", self.root / "backend-state.json"),
                            ("STATE", self.root), ("DB_PATH", self.root / "offbox-home.db"), ("_BACKEND", "server")):
            self.stack.enter_context(patch.object(common, name, value))
        self.stack.enter_context(patch.object(misc, "LOGS_DIR", common.LOGS_DIR))
        self.stack.enter_context(patch.object(misc, "CAP_PATH", self.root / "cap.json"))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(common, "home_config", return_value={"url": "http://home/api/v1"}))
        self.stack.enter_context(patch.object(common, "now", return_value=1794728890))
        self.row = dict(run_id="run-test", status="running", mode="bg", owner="owner", repo_root="/repo",
                        box_id="bx_home", process_id=1, exit_code=None)

    def state(self, name):
        common.BACKEND_STATE.write_text(json.dumps(dict(state=name, last_ok=1794728800)))

    def test_wait_and_follow_logs_show_last_successful_read_before_waiting(self):
        observation.observe("run-test", "stream heartbeat")
        for state in ("home_down", "home_slow"):
            self.state(state)
            for read in (lambda: misc.wait("run-test", 1), lambda: misc.logs("run-test", True)):
                with self.subTest(state=state, read=read), patch.object(misc, "_run_row", return_value=self.row), \
                        patch.object(misc, "_require_my_run"), patch.object(misc, "_wait_locked", return_value=124), \
                        contextlib.redirect_stderr(io.StringIO()) as output:
                    self.assertEqual(read(), 124)
                text = output.getvalue()
                self.assertIn("run-test is still on home", text)
                self.assertIn("last good run read: stream heartbeat at " + observation.stamp(1794728890), text)
                self.assertIn("Do not kill it because of this health-check flap", text)

    def test_status_shows_home_run_when_monitor_routes_status_to_boat(self):
        self.state("home_down")
        observation.observe("run-test", "queued")
        with contextlib.closing(common.db()) as con:
            con.execute("INSERT INTO runs(run_id,status,mode,owner,repo_root) VALUES (?,?,?,?,?)",
                        ("run-test", "running", "bg", "owner", "/repo"))
            con.commit()
        with patch.object(api, "BACKEND", "boat"), patch.object(api, "limits", side_effect=common.OffboxError("offline")), \
                patch.object(api, "list_boxes", side_effect=common.OffboxError("offline")), \
                patch.object(capacity, "snapshot", return_value={"counts": [], "blocked": False}), \
                patch.object(capacity, "supply_status", return_value={}), \
                patch.object(misc.outage, "current", return_value=None), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            misc.status({"owner": "owner", "repo_root": "/repo"})
        self.assertIn("run-test is still on home", output.getvalue())
        self.assertIn("last good run read: queued at " + observation.stamp(1794728890), output.getvalue())

    def test_no_record_uses_dated_health_without_claiming_a_run_read(self):
        self.state("home_slow")
        output = []
        observation.notice(self.row, emit=output.append)
        self.assertIn("last good run read: not recorded; last good health read: " + observation.stamp(1794728800), output[0])

    def test_boat_and_terminal_runs_do_not_get_home_flap_notice(self):
        self.state("home_down")
        output = []
        observation.notice(self.row, backend="boat", emit=output.append)
        observation.notice(dict(self.row, status="done"), emit=output.append)
        self.assertEqual(output, [])


    def test_stream_records_real_remote_reply_even_when_health_is_down(self):
        from offbox_lib import runs
        self.state("home_down")
        frames = [{"type": "hello", "attempt": 1}, {"type": "exit", "status": "exited", "exitCode": 0}]
        with patch.object(api, "cmd_attach", return_value=iter(frames)), patch.object(runs, "_ttl_keeper"):
            self.assertEqual(runs.follow("bx_home", 1, None, echo=False, run_id="run-test"), 0)
        read = json.loads((common.LOGS_DIR / "run-test.home-read.json").read_text())
        self.assertEqual((read["kind"], read["at"]), ("exited", 1794728890))


    def test_legacy_run_without_sidecar_uses_its_accepted_command_receipt(self):
        self.state("home_down")
        output = []
        observation.notice(dict(self.row, command_at=1794728890), emit=output.append)
        self.assertIn("last good run read: command accepted at " + observation.stamp(1794728890), output[0])


if __name__ == "__main__":
    unittest.main()
