"""The hourly watcher is bounded separately from its scan/apply worker."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import io
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import dev_janitor  # noqa: E402
import janitor_watch  # noqa: E402


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.patch = patch.object(janitor_watch, "STATE_DIR", self.state_dir)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_two_slow_snapshots_complete_and_recheck_before_action(self):
        # Use a simulated clock instead of sleeping 62 seconds. The first snapshot says a resource is a
        # candidate, the fresh second one says it has become in use. No destructive action may follow.
        resource = {"id": "expo:42", "kind": "expo", "candidate": True}
        protected = {**resource, "candidate": False, "keep_reasons": ["running_session_in_cwd:thread:new"]}
        now = [0]

        def scan():
            now[0] += 31
            r = resource if now[0] == 31 else protected
            return {"resources": [r], "candidates": [r["id"]] if r["candidate"] else []}

        lock_path = self.state_dir / "test-lock"
        lock_path.touch()
        with lock_path.open() as lock, \
                patch.object(dev_janitor, "scan", side_effect=scan), \
                patch.object(dev_janitor, "LOG_DIR", str(self.root)), \
                patch.object(dev_janitor, "LAST", str(self.root / "last.json")), \
                patch.object(dev_janitor, "sh", return_value=(1, "", "")), \
                patch.object(dev_janitor, "act") as act:
            self.assertEqual(janitor_watch.worker(lock.fileno()), 0)
        self.assertEqual(now[0], 62)
        act.assert_not_called()
        self.assertEqual(json.loads((self.state_dir / "state.json").read_text())["status"], "ok")

    def test_fresh_scan_for_each_action_and_failure_is_recorded(self):
        a = {"id": "expo:1", "kind": "expo", "candidate": True, "pids": [1]}
        b = {"id": "expo:2", "kind": "expo", "candidate": True, "pids": [2]}
        snapshots = [
            {"resources": [a, b], "candidates": [a["id"], b["id"]]},
            {"resources": [a, b], "candidates": [a["id"], b["id"]]},
            {"resources": [{**b, "candidate": False, "keep_reasons": ["active"]}], "candidates": []},
        ]
        lock_path = self.state_dir / "test-lock"
        lock_path.touch()
        with lock_path.open() as lock, \
                patch.object(dev_janitor, "scan", side_effect=snapshots) as scan, \
                patch.object(dev_janitor, "LOG_DIR", str(self.root)), \
                patch.object(dev_janitor, "LAST", str(self.root / "last.json")), \
                patch.object(dev_janitor, "sh", return_value=(1, "", "")), \
                patch.object(dev_janitor, "audit"), \
                patch.object(dev_janitor, "act", return_value=(False, "failed")) as act:
            self.assertEqual(janitor_watch.worker(lock.fileno()), 1)
        self.assertEqual(scan.call_count, 3)
        act.assert_called_once_with(a)
        state = janitor_watch.read_state()
        self.assertEqual(state["status"], "failed")
        self.assertIn("expo:1 (failed)", state["error"])

    def test_detached_worker_survives_check_group_and_does_not_overlap(self):
        # The check starts in a process group like robob-watch. A fake worker blocks after inheriting the lock.
        # Killing that group simulates the 60-second watchdog: the worker must survive and exclude the next tick.
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "janitor_watch.py").write_bytes((SCRIPTS / "janitor_watch.py").read_bytes())
        (scripts / "dev_janitor.py").write_text("""
import os, time
from pathlib import Path
root = Path(os.environ['FAKE_ROOT'])
LOG_DIR = str(root)
LAST = str(root / 'last.json')
def scan():
    with (root / 'starts').open('a') as f: f.write('start\\n')
    (root / 'started').touch()
    while not (root / 'release').exists(): time.sleep(0.02)
    return {'resources': [], 'candidates': []}
def apply(ids): raise AssertionError('no candidates')
""")
        env = {**os.environ, "DEV_JANITOR_WATCH_STATE": str(self.state_dir), "FAKE_ROOT": str(self.root),
               "PYTHONDONTWRITEBYTECODE": "1"}
        cmd = [sys.executable, str(scripts / "janitor_watch.py"), "check"]
        first = subprocess.Popen(cmd, env=env, start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        first_pgid = first.pid
        stdout, stderr = first.communicate(timeout=5)
        self.assertEqual((first.returncode, stdout, stderr), (0, "", ""))

        def wait_for(predicate):
            deadline = time.monotonic() + 5
            while not predicate():
                if time.monotonic() > deadline:
                    self.fail("worker did not reach expected state")
                time.sleep(0.02)

        self.addCleanup((self.root / "release").touch)
        wait_for((self.root / "started").exists)
        try:
            os.killpg(first_pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        second = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual((second.returncode, second.stdout), (0, ""))
        self.assertEqual((self.root / "starts").read_text().splitlines(), ["start"])
        (self.root / "release").touch()
        wait_for(lambda: json.loads((self.state_dir / "state.json").read_text())["status"] == "ok")

    def test_prior_failure_is_reported_and_interrupted_worker_is_detected(self):
        for previous, expected in [
            ({"status": "failed", "error": "scan exploded"}, "scan exploded"),
            ({"status": "running", "started_at": 1}, "exited without recording a result"),
        ]:
            with self.subTest(previous=previous):
                janitor_watch.write_state(previous)
                with patch.object(janitor_watch.subprocess, "Popen"), \
                        patch("sys.stdout", new_callable=io.StringIO) as out:
                    janitor_watch.check()
                self.assertIn(expected, out.getvalue())
                self.assertEqual(janitor_watch.read_state()["status"], "running")

    def test_installer_replaces_wrapper_preserves_pruner_and_backs_up_outside_skills(self):
        home = self.root / "home"
        scripts = home / ".config/opencode/skills/dev-resource-janitor/scripts"
        scripts.mkdir(parents=True)
        old_wrapper = scripts / "janitor_watch.sh"
        old_wrapper.write_text("old wrapper\n")
        old_wrapper.chmod(0o755)
        (scripts / "tmpdir_prune.py").write_text("unchanged pruner\n")
        installer = SCRIPTS.parents[1] / "install.zsh"
        proc = subprocess.run(["/bin/zsh", str(installer)], env={**os.environ, "HOME": str(home)},
                              capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(old_wrapper.read_bytes(), (SCRIPTS / "janitor_watch.sh").read_bytes())
        self.assertTrue(os.access(old_wrapper, os.X_OK))
        self.assertTrue((scripts / "janitor_watch.py").is_file())
        self.assertEqual((scripts / "tmpdir_prune.py").read_text(), "unchanged pruner\n")
        backups = list((home / ".local/share/dev-janitor/backups").glob("skill-*/scripts/janitor_watch.sh"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "old wrapper\n")
        self.assertEqual(list((home / ".config/opencode/skills").glob("*.bak-*")), [])


if __name__ == "__main__":
    unittest.main()
