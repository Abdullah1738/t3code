"""The hourly watcher is bounded separately from its scan/apply worker."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from janitor_test_safety import JanitorTestCase
import io
from unittest.mock import Mock, patch


SCRIPTS = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import dev_janitor  # noqa: E402
import janitor_watch  # noqa: E402


class WorkerTests(JanitorTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.patch = patch.object(janitor_watch, "STATE_DIR", self.state_dir)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        for name, value in (("LOG_DIR", str(self.root)), ("AUDIT", str(self.root / "audit.jsonl"))):
            p = patch.object(dev_janitor, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(dev_janitor, "emit")
        p.start()
        self.addCleanup(p.stop)

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
                patch.object(dev_janitor, "record_report"), \
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
                patch.object(dev_janitor, "record_report"), \
                patch.object(dev_janitor, "sh", return_value=(1, "", "")), \
                patch.object(dev_janitor, "audit"), \
                patch.object(dev_janitor, "act", return_value=(False, "failed")) as act:
            self.assertEqual(janitor_watch.worker(lock.fileno()), 1)
        self.assertEqual(scan.call_count, 3)
        act.assert_called_once_with(a)
        state = janitor_watch.read_state()
        self.assertEqual(state["status"], "failed")
        self.assertIn("expo:1 (failed)", state["error"])

    def test_worker_keeps_liveness_and_report_only_findings_in_audit(self):
        processes = {"candidates": [{"pid": 42}], "problems": ["control api timed out"],
                     "checked": 8, "skipped": 1, "budget_skipped": 2,
                     "owner_calls": {"by_native": {"count": 3, "p50_ms": 10, "p95_ms": 20,
                                                   "max_ms": 20, "failures": {"404": 1}}}}
        report = {"ts": 123, "resources": [], "candidates": [], "processes": processes,
                  "liveness_unavailable": "control api projects: timed out"}
        with (self.state_dir / "lock").open("a+") as lock, \
                patch.object(dev_janitor, "scan", return_value=report), \
                patch.object(dev_janitor, "LAST", str(self.root / "last.json")), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(janitor_watch.worker(lock.fileno()), 0)
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(janitor_watch.read_state()['processes'], processes)
        entry = json.loads((self.root / "audit.jsonl").read_text())
        self.assertEqual(entry, {"ts": 123, "event": "report", "processes": processes,
                                 "liveness_unavailable": report["liveness_unavailable"]})

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
def log_run(*args): pass
def record_report(scan): pass
""")
        env = {**os.environ, "DEV_JANITOR_WATCH_STATE": str(self.state_dir), "FAKE_ROOT": str(self.root),
               "PYTHONDONTWRITEBYTECODE": "1",
               "DEV_JANITOR_TELEGRAM_CMD": str(self.root / "no-production-notifications")}
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

    def test_installer_ships_wrapper_and_pruner_and_backs_up_outside_skills(self):
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
        self.assertEqual((scripts / "tmpdir_prune.py").read_bytes(), (SCRIPTS / "tmpdir_prune.py").read_bytes())
        backups = list((home / ".local/share/dev-janitor/backups").glob("skill-*/scripts/janitor_watch.sh"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "old wrapper\n")
        self.assertEqual(list((home / ".config/opencode/skills").glob("*.bak-*")), [])


class QuietCheckTests(JanitorTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / "hourly"
        self.state.mkdir()
        self.argv_log = self.root / "telegram.jsonl"
        self.command = self.root / "fake telegram"
        self.command.write_text(f"#!{sys.executable}\n" + """
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
key = args[args.index('--key') + 1]
spec = {name: args[args.index('--' + name) + 1] for name in ('source', 'severity', 'text')}
receipts_path = Path(os.environ['DEV_JANITOR_TEST_ARGV']).with_name('bridge-receipts.json')
receipts = json.loads(receipts_path.read_text()) if receipts_path.exists() else {}
rc = int(os.environ.get('DEV_JANITOR_TEST_RC', '0'))
status, created = 503, False
if rc == 0:
    # Telegram's /notify receipts survive forever: same key/content replays; changed content conflicts.
    if key not in receipts:
        receipts[key] = spec
        receipts_path.write_text(json.dumps(receipts))
        status, created = 202, True
    elif receipts[key] == spec:
        status = 200
    else:
        status, rc = 409, 1
saved = json.loads((Path(os.environ['DEV_JANITOR_WATCH_STATE']) / 'alerts.json').read_text())
kind = key.split(':')[1]
persisted = saved.get('last_alerts', {}).get(kind, {}).get('delivery_key') == key
with open(os.environ['DEV_JANITOR_TEST_ARGV'], 'a') as f:
    f.write(json.dumps({'argv': args, 'inspect': os.environ.get('BUN_INSPECT'),
                        'status': status, 'created': created, 'persisted': persisted}) + '\\n')
print(json.dumps({'created': created}))
print('Telegram diagnostic', file=sys.stderr)
sys.exit(rc)
""")
        self.command.chmod(0o755)
        self.env = {**os.environ, "DEV_JANITOR_TELEGRAM_CMD": str(self.command),
                    "DEV_JANITOR_WATCH_STATE": str(self.state), "DEV_JANITOR_TEST_ARGV": str(self.argv_log),
                    "BUN_INSPECT": "must-be-removed", "PYTHONDONTWRITEBYTECODE": "1"}
        for p in (patch.dict(os.environ, self.env), patch.object(janitor_watch, "STATE_DIR", self.state),
                  patch.object(dev_janitor, "LOG_DIR", str(self.root)),
                  patch.object(dev_janitor, "AUDIT", str(self.root / "audit.jsonl"))):
            p.start()
            self.addCleanup(p.stop)

    def calls(self):
        return [json.loads(line) for line in self.argv_log.read_text().splitlines()] if self.argv_log.exists() else []

    def audits(self):
        path = self.root / "audit.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def check(self, previous=None, spawn_error=None):
        if previous is not None:
            janitor_watch.write_state(previous)
        real_popen = subprocess.Popen
        worker = Mock()

        def popen(argv, *args, **kwargs):
            if len(argv) > 2 and argv[2] == "worker":
                if spawn_error:
                    raise spawn_error
                return worker(argv, *args, **kwargs)
            return real_popen(argv, *args, **kwargs)

        with patch.object(janitor_watch.subprocess, "Popen", side_effect=popen), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            janitor_watch.check()
        self.assertEqual(out.getvalue(), "")
        return worker

    def assert_alert(self, kind, ok=True):
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        args = calls[0]["argv"]
        self.assertEqual(args[:5], ["notify", "--source", "Dev janitor", "--severity", "attention"])
        self.assertEqual(args[-2], "--key")
        self.assertRegex(args[-1], rf"^dev-janitor:{kind}:[0-9a-f]{{32}}$")
        self.assertIsNone(calls[0]["inspect"])
        self.assertTrue(calls[0]["persisted"], "delivery identity must be on disk before the send")
        entry = self.audits()[-1]
        self.assertEqual((entry["event"], entry["kind"], entry["telegram_ok"]), ("alert", kind, ok))
        self.assertEqual(entry["text"], args[args.index("--text") + 1])
        self.assertEqual(entry["delivery_key"], args[-1])
        return entry

    def test_no_previous_state_is_silent(self):
        worker = self.check()
        worker.assert_called_once()
        self.assertEqual((self.calls(), self.audits()), ([], []))

    def test_production_defaults_still_use_live_audit_and_telegram(self):
        with patch.dict(os.environ):
            for key in ('DEV_JANITOR_LOG_DIR', 'DEV_JANITOR_WATCH_STATE', 'DEV_JANITOR_TELEGRAM_CMD'):
                os.environ.pop(key, None)
            default_log = Path.home() / '.local/share/dev-janitor'
            defaults = runpy.run_path(str(SCRIPTS / 'dev_janitor.py'))
            self.assertEqual(defaults['AUDIT'], str(default_log / 'audit.jsonl'))
            defaults = runpy.run_path(str(SCRIPTS / 'janitor_watch.py'))
            self.assertEqual(defaults['STATE_DIR'], default_log / 'hourly')
            with patch.object(janitor_watch.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                janitor_watch.alert('default_command', 'production default command')
            self.assertEqual(run.call_args.args[0][3:5], [
                '/Users/ardud/.bun/bin/bun', '/Users/ardud/.local/share/telegram-bridge/src/cli.ts'])

    def test_empty_problem_only_and_candidate_reports_never_notify(self):
        for processes, liveness in [
            ({"candidates": [], "problems": [], "checked": 0, "skipped": 0, "budget_skipped": 0}, None),
            ({"candidates": [], "problems": ["liveness_unavailable: control api projects: timed out"]},
             "control api projects: timed out"),
            ({"candidates": [{"pid": 123, "command": "report-only"}], "problems": []}, None),
        ]:
            with self.subTest(processes=processes):
                self.check({"status": "ok", "processes": processes, "liveness_unavailable": liveness})
                self.assertEqual((self.calls(), self.audits()), ([], []))

    def test_failed_worker_uses_telegram_and_truncates_error(self):
        error = "scan exploded; $(touch should-not-exist) `true`\n" + "x" * 600
        self.check({"status": "failed", "error": error})
        entry = self.assert_alert("worker_failed")
        self.assertEqual(entry["text"], "dev-janitor: " + error[:500])
        self.assertIsNone(entry["error"])

    def test_same_failure_is_deduped_across_worker_state_overwrites(self):
        failure = {"status": "failed", "error": "scan exploded"}
        self.check(failure)
        self.check({"status": "ok"})
        self.check(failure)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(len(self.audits()), 2)
        self.assertTrue(self.audits()[-1]["deduplicated"])
        self.assertEqual(self.audits()[-1]["delivery_key"], self.audits()[0]["delivery_key"])
        self.assertNotIn("last_alerts", janitor_watch.read_state())

    def test_dedupe_expires_at_six_hours(self):
        failure = {"status": "failed", "error": "scan exploded"}
        for at, expected_calls in [(100000, 1), (121599, 1), (121600, 2)]:
            with patch.object(janitor_watch.time, "time", return_value=at):
                self.check(failure)
            self.assertEqual(len(self.calls()), expected_calls)

    def test_changed_text_and_kind_are_not_suppressed(self):
        self.check({"status": "failed", "error": "first"})
        self.check({"status": "failed", "error": "second"})
        self.check({"status": "running"})
        self.assertEqual(len(self.calls()), 3)
        self.assertEqual([call["status"] for call in self.calls()], [202, 202, 202])
        self.assertTrue(all(entry["telegram_ok"] for entry in self.audits()))

    def test_bridge_permanent_receipts_survive_changed_text_and_cooldown_expiry(self):
        cases = [
            (100000, "a", 1),
            (100001, "a", 1),
            (100002, "b", 2),
            (100003, "a", 2),
            (121599, "a", 2),
            (121600, "a", 3),
            (121601, "b", 3),
            (121602, "b", 4),
        ]
        for at, text, expected_calls in cases:
            with self.subTest(at=at, text=text), patch.object(janitor_watch.time, "time", return_value=at):
                self.check({"status": "failed", "error": text})
            self.assertEqual(len(self.calls()), expected_calls)
        calls = self.calls()
        self.assertEqual([call["status"] for call in calls], [202] * 4)
        self.assertTrue(all(call["created"] and call["persisted"] for call in calls))
        keys = [call["argv"][-1] for call in calls]
        self.assertEqual(len(set(keys)), 4)
        self.assertEqual([entry["delivery_key"] for entry in self.audits()],
                         [keys[0], keys[0], keys[1], keys[0], keys[0], keys[2], keys[1], keys[3]])
        self.assertTrue(all(entry["telegram_ok"] for entry in self.audits() if not entry["deduplicated"]))

    def test_bridge_fixture_replays_identical_keys_and_rejects_changed_payload(self):
        self.check({"status": "failed", "error": "first"})
        original = self.calls()[0]["argv"]
        repeat = subprocess.run([str(self.command), *original], capture_output=True, text=True, timeout=5)
        self.assertEqual(repeat.returncode, 0)
        self.assertEqual((self.calls()[-1]["status"], self.calls()[-1]["created"]), (200, False))
        changed = list(original)
        changed[changed.index("--text") + 1] = "a different failure"
        conflict = subprocess.run([str(self.command), *changed], capture_output=True, text=True, timeout=5)
        self.assertEqual(conflict.returncode, 1)
        self.assertEqual(self.calls()[-1]["status"], 409)

    def test_timeout_after_queue_acceptance_preserves_occurrence_and_cooldown(self):
        real_run = subprocess.run

        def accepted_then_timeout(*args, **kwargs):
            self.assertEqual(real_run(*args, **kwargs).returncode, 0)
            raise subprocess.TimeoutExpired("fake", 20)

        failure = {"status": "failed", "error": "a"}
        with patch.object(janitor_watch.time, "time", return_value=100000), \
                patch.object(janitor_watch.subprocess, "run", side_effect=accepted_then_timeout):
            self.check(failure)
        first_key = self.calls()[0]["argv"][-1]
        self.assertTrue(self.calls()[0]["persisted"])
        self.assertEqual(self.audits()[-1]["delivery_key"], first_key)
        self.assertFalse(self.audits()[-1]["telegram_ok"])
        with patch.object(janitor_watch.time, "time", return_value=100001):
            self.check(failure)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.audits()[-1]["delivery_key"], first_key)
        with patch.object(janitor_watch.time, "time", return_value=121600):
            self.check(failure)
        self.assertEqual([call["status"] for call in self.calls()], [202, 202])
        self.assertNotEqual(self.calls()[-1]["argv"][-1], first_key)

    def test_old_timestamp_state_keeps_cooldown_then_creates_a_new_occurrence(self):
        text = "dev-janitor: a"
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        janitor_watch.write_json(self.state / "alerts.json", {"last_alerts": {"worker_failed": {
            "text_hash": text_hash, "at": 100000, "recent": {text_hash: 100000}}}})
        with patch.object(janitor_watch.time, "time", return_value=100001):
            self.check({"status": "failed", "error": "a"})
        self.assertEqual(self.calls(), [])
        self.assertTrue(self.audits()[-1]["deduplicated"])
        self.assertIsNone(self.audits()[-1]["delivery_key"])
        with patch.object(janitor_watch.time, "time", return_value=121600):
            self.check({"status": "failed", "error": "a"})
        self.assert_alert("worker_failed")

    def test_dedupe_handles_interleaved_failure_texts_and_failed_sends(self):
        cases = [
            ("repeated", ["a", "a"], [1, 1]),
            ("alternating", ["a", "b", "a"], [1, 2, 2]),
            ("repeated_and_alternating", ["a", "b", "b", "a"], [1, 2, 2, 2]),
        ]
        for rc in ("0", "1"):
            for label, texts, expected in cases:
                with self.subTest(label=label, rc=rc), patch.dict(os.environ, {"DEV_JANITOR_TEST_RC": rc}):
                    janitor_watch.write_json(self.state / "alerts.json", {"last_alerts": {}})
                    baseline = len(self.calls())
                    for index, (text, count) in enumerate(zip(texts, expected)):
                        with patch.object(janitor_watch.time, "time", return_value=100000 + index):
                            self.check({"status": "failed", "error": text})
                        self.assertEqual(len(self.calls()) - baseline, count)

    def test_lost_worker(self):
        self.check({"status": "running", "started_at": 1})
        self.assert_alert("worker_lost")

    def test_stale_locked_worker(self):
        janitor_watch.write_state({"status": "running", "started_at": time.time() - 14401})
        with (self.state / "lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.check().assert_not_called()
        self.assert_alert("worker_stale")

    def test_healthy_locked_worker_is_silent(self):
        janitor_watch.write_state({"status": "running", "started_at": time.time()})
        with (self.state / "lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.check().assert_not_called()
        self.assertEqual((self.calls(), self.audits()), ([], []))

    def test_spawn_failure(self):
        self.check(spawn_error=OSError("cannot fork"))
        self.assert_alert("spawn_failed")
        self.assertEqual(janitor_watch.read_state()["status"], "failed")

    def test_telegram_failure_is_silent_and_audited(self):
        with patch.dict(os.environ, {"DEV_JANITOR_TEST_RC": "1"}):
            self.check({"status": "failed", "error": "scan exploded"})
        self.assertIn("Telegram exited 1", self.assert_alert("worker_failed", ok=False)["error"])

    def test_missing_telegram_command_and_timeout_are_silent_and_audited(self):
        with patch.dict(os.environ, {"DEV_JANITOR_TELEGRAM_CMD": str(self.root / "missing")}):
            self.check({"status": "failed", "error": "first"})
        self.assertFalse(self.audits()[-1]["telegram_ok"])
        with patch.object(janitor_watch.subprocess, "run", side_effect=subprocess.TimeoutExpired("fake", 20)) as run:
            self.check({"status": "failed", "error": "second"})
        self.assertEqual(run.call_args.kwargs["timeout"], 20)
        self.assertFalse(self.audits()[-1]["telegram_ok"])
        self.assertIn("timed out", self.audits()[-1]["error"])

    def test_corrupt_alert_state_recovers(self):
        (self.state / "alerts.json").write_text("not json")
        self.check({"status": "failed", "error": "scan exploded"})
        self.assert_alert("worker_failed")

    def test_shell_prune_failure_and_check_diagnostics_never_reach_watcher(self):
        scripts = self.root / "scripts"
        scripts.mkdir()
        # The shell calls the real alert subcommand. Its check is replaced with noisy diagnostics, never a worker.
        (scripts / "janitor_watch.py").write_text("""
import sys
if sys.argv[1] == 'check':
    print('noisy check')
    print('check diagnostic', file=sys.stderr)
else:
    import os, runpy
    script_dir = sys.argv.pop(1)
    sys.path.insert(0, script_dir)
    import dev_janitor
    dev_janitor.LOG_DIR = os.environ['DEV_JANITOR_LOG_DIR']
    dev_janitor.AUDIT = dev_janitor.LOG_DIR + '/audit.jsonl'
    runpy.run_path(script_dir + '/janitor_watch.py', run_name='__main__')
""")
        wrapper = self.root / "python-wrapper"
        wrapper.write_text(f"#!{sys.executable}\n" + f"""
import os, sys
args = sys.argv[1:]
if 'alert' in args:
    args.insert(1, {str(SCRIPTS)!r})
os.execv({sys.executable!r}, [{sys.executable!r}, *args])
""")
        wrapper.chmod(0o755)
        tl = self.root / "tmpdir-prune"
        tl.mkdir()
        (tl / "rc").write_text("1\n")
        (tl / "err").write_text("fake prune failure\n")
        # A live PID skips detached prune startup, so this test cannot prune any files.
        (tl / "pid").write_text(str(os.getpid()))
        env = {**self.env, "DEV_JANITOR_SCRIPT_DIR": str(scripts), "DEV_JANITOR_PYTHON": str(wrapper),
               "DEV_JANITOR_LOG_DIR": str(self.root)}
        proc = subprocess.run(["/bin/zsh", str(SCRIPTS / "janitor_watch.sh")], env=env,
                              capture_output=True, text=True, timeout=10)
        self.assertEqual((proc.returncode, proc.stdout, proc.stderr), (0, "", ""))
        self.assert_alert("tmpdir_prune")
        self.assertIn("check diagnostic", (self.root / "watch.err").read_text())


if __name__ == "__main__":
    unittest.main()
