"""Read watchdog against a fake clock, probe and notifier. Nothing is sent."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parents[1]
SCRIPT = HERE / "bin/robob-read-watchdog"


class RobobReadWatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="read-watchdog-test-")
        self.home = Path(self.temp.name)
        self.state = self.home / "state"
        self.log = self.home / "calls.jsonl"
        self.clock = self.home / "clock"
        self.clock.write_text("0")
        self.sequence = self.home / "sequence.json"
        self.sequence.write_text("[]")
        self.processes = []
        self.child_records = self.home / "children.jsonl"
        fake = self.home / "fake command"
        fake.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
root = Path(os.environ['HOME'])
clock = root / 'clock'
now = int(clock.read_text())
kind = sys.argv[1]
if kind == 'now':
    print(now)
    sys.exit(0)
if kind == 'sleep':
    clock.write_text(str(now + int(sys.argv[2])))
    sys.exit(0)
entry = {'kind': kind, 'at': now}
rc = 0
if kind == 'probe':
    seq = root / 'sequence.json'
    values = json.loads(seq.read_text())
    rc = values.pop(0) if values else int(os.environ.get('FAKE_PROBE_RC', '1'))
    seq.write_text(json.dumps(values))
    print('probe output must be discarded')
    if rc:
        print(os.environ.get('FAKE_ERROR', '  request timed out  \\nsecond diagnostic'), file=sys.stderr)
    clock.write_text(str(now + int(os.environ.get('FAKE_PROBE_SECONDS', '0'))))
    entry['rc'] = rc
elif kind == 'notify':
    args = sys.argv[2:]
    entry['args'] = dict(zip(args[::2], args[1::2]))
    entry['inspector'] = os.environ.get('BUN_INSPECT')
    rc = int(os.environ.get('FAKE_NOTIFY_RC', '0'))
    if os.environ.get('FAKE_LOST_ACK') or os.environ.get('FAKE_DEDUPE'):
        db = root / 'accepted.json'
        seen = json.loads(db.read_text()) if db.exists() else {}
        key = entry['args']['--key']
        text = entry['args']['--text']
        if key in seen:
            rc = 0 if seen[key] == text else 1
        else:
            seen[key] = text
            db.write_text(json.dumps(seen))
            rc = 1 if os.environ.get('FAKE_LOST_ACK') else 0
elif kind == 'app':
    rc = int(os.environ.get('FAKE_APP_RC', '0'))
elif kind == 'restart':
    rc = int(os.environ.get('FAKE_RESTART_RC', '1'))
with (root / 'calls.jsonl').open('a') as out:
    out.write(json.dumps(entry) + '\\n')
sys.exit(rc)
''')
        fake.chmod(0o755)
        fake_bin = self.home / ".local/bin"
        fake_bin.mkdir(parents=True)
        if sys.platform != "darwin":
            # The watchdog is a Mac launchd helper; emulate BSD date, not its incident logic.
            date = fake_bin / "date"
            date.write_text(f"#!{sys.executable}\n" + '''import sys, time
if len(sys.argv) != 4 or sys.argv[1] != '-r' or not sys.argv[3].startswith('+'):
    sys.exit(2)
print(time.strftime(sys.argv[3][1:], time.localtime(int(sys.argv[2]))))
''')
            date.chmod(0o755)
        command = shlex.quote(str(fake))
        self.env = {
            "HOME": str(self.home), "PATH": "/usr/bin:/bin", "TZ": "Asia/Dubai",
            "ROBOB_WD_STATE": str(self.state), "ROBOB_WD_PROBE": command + " probe",
            "ROBOB_WD_NOTIFY": command + " notify", "ROBOB_WD_APP_RUNNING": command + " app",
            "ROBOB_WD_RESTARTING": command + " restart", "ROBOB_WD_NOW": command + " now",
            "ROBOB_WD_SLEEP": command + " sleep", "BUN_INSPECT": "ws://127.0.0.1:1/x",
        }

    def tearDown(self):
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        for child in self.probe_children():
            if self.start_time(child["pid"]) == child["start"]:
                try:
                    os.kill(child["pid"], signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.temp.cleanup()

    def start_time(self, pid):
        result = subprocess.run(["/bin/ps", "-o", "lstart=", "-p", str(pid)],
                                env={**os.environ, "TZ": "UTC0", "LC_ALL": "C"},
                                capture_output=True, text=True, timeout=5)
        return result.stdout.rstrip("\n") if result.returncode == 0 else None

    def probe_children(self):
        if not self.child_records.exists():
            return []
        return [json.loads(line) for line in self.child_records.read_text().splitlines()]

    def use_blocking_probe(self, ignore_term=True, deadline=1):
        blocker = self.home / "blocking_probe.py"
        blocker.write_text('''import json, os, signal, subprocess, time
from pathlib import Path
root = Path(os.environ['HOME'])
if os.environ['FAKE_IGNORE_TERM'] == '1':
    def ignore_term(signum, frame):
        with (root / 'terms.jsonl').open('a') as out:
            out.write(str(os.getpid()) + '\\n')
    signal.signal(signal.SIGTERM, ignore_term)
pid = os.getpid()
start = subprocess.check_output(['/bin/ps', '-o', 'lstart=', '-p', str(pid)],
                                env={**os.environ, 'TZ': 'UTC0', 'LC_ALL': 'C'}, text=True).rstrip('\\n')
with (root / 'children.jsonl').open('a') as out:
    out.write(json.dumps({'pid': pid, 'start': start}) + '\\n')
while root.exists() and not (root / 'release_probe').exists():
    time.sleep(0.05)
''')
        self.env.update({
            "ROBOB_WD_PROBE": f"{shlex.quote(sys.executable)} -I {shlex.quote(str(blocker))}",
            "ROBOB_WD_PROBE_DEADLINE": str(deadline),
            "FAKE_IGNORE_TERM": "1" if ignore_term else "0",
        })

    def assert_stuck_child(self):
        children = self.probe_children()
        self.assertEqual(len(children), 1)
        child = children[0]
        self.assertEqual((self.state / "stuck_probe").read_text(),
                         f"{child['pid']} {child['start']}\n")
        self.assertEqual(self.start_time(child["pid"]), child["start"])
        return child["pid"]

    def install_ps_fault(self, first_call, result):
        (self.home / "ps-fault.json").write_text(json.dumps({"first_call": first_call, "result": result}))
        wrapper = self.home / ".local/bin/ps"
        wrapper.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
from pathlib import Path
root = Path(os.environ['HOME'])
counter = root / 'ps-count'
number = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(number))
fault = json.loads((root / 'ps-fault.json').read_text())
if number >= fault['first_call']:
    if fault['result'] == 'whitespace':
        print('   ')
    sys.exit(1 if fault['result'] == 'error' else 0)
os.execv('/bin/ps', ['ps', *sys.argv[1:]])
''')
        wrapper.chmod(0o755)

    def terms(self):
        log = self.home / "terms.jsonl"
        return log.read_text().splitlines() if log.exists() else []

    def release_children(self):
        (self.home / "release_probe").touch()
        deadline = time.monotonic() + 5
        while any(self.start_time(row["pid"]) is not None for row in self.probe_children()):
            self.assertLess(time.monotonic(), deadline, "fake child did not exit")
            time.sleep(0.05)

    def run_script(self, *args, at=None, expected=0, **fake):
        env = self.env.copy()
        if at is not None:
            env["ROBOB_WD_NOW"] = str(at)
            self.clock.write_text(str(at))
        env.update({"FAKE_" + key.upper(): str(value) for key, value in fake.items()})
        result = subprocess.run(["/bin/zsh", str(SCRIPT), *args], env=env,
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, expected, result.stderr)
        return result

    def calls(self, kind):
        rows = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return [row for row in rows if row["kind"] == kind]

    def notifications(self):
        return [row["args"] for row in self.calls("notify")]

    def fail_until_alert(self, **fake):
        for tick in range(0, 181, 30):
            self.run_script(at=tick, **fake)

    def test_one_alert_after_three_minutes_and_one_recovery(self):
        for tick in range(0, 180, 30):
            self.assertEqual(self.run_script(at=tick).stdout, "")
            self.assertEqual(self.notifications(), [])
        self.run_script(at=180)
        self.assertEqual(self.notifications(), [{
            "--source": "robob-watchdog", "--severity": "attention",
            "--key": "robob-read-stall:197001010400",
            "--text": "Robob reads failing since 04:00 (request timed out)",
        }])
        self.assertEqual((self.state / "first_fail").read_text().strip(), "0")
        for tick in (210, 240):
            self.run_script(at=tick)
        self.assertEqual(len(self.notifications()), 1)
        self.run_script(at=270, probe_rc=0)
        self.assertEqual(self.notifications()[1], {
            "--source": "robob-watchdog", "--severity": "info",
            "--key": "robob-read-stall:197001010400:up",
            "--text": "Robob reads work again (failing 04:00-04:04)",
        })
        for name in ("first_fail", "alerted", "last_error", "attention_text", "recovery_text"):
            self.assertFalse((self.state / name).exists(), name)
        self.run_script(at=300, probe_rc=0)
        self.assertEqual(len(self.notifications()), 2)
        self.assertTrue(all(row["inspector"] is None for row in self.calls("notify")))
        self.run_script(at=330)
        self.assertEqual((self.state / "first_fail").read_text().strip(), "330")

    def test_failed_attention_retries_without_marking_alerted(self):
        for tick in range(0, 180, 30):
            self.run_script(at=tick)
        self.run_script(at=180, notify_rc=1, expected=1)
        self.assertFalse((self.state / "alerted").exists())
        self.run_script(at=210)
        self.assertEqual(len(self.notifications()), 2)
        self.assertEqual(self.notifications()[0], self.notifications()[1])
        self.assertTrue((self.state / "alerted").exists())

    def test_retries_keep_identical_text_after_lost_acknowledgements(self):
        for tick in range(0, 180, 30):
            self.run_script(at=tick)
        self.run_script(at=180, lost_ack=1, expected=1)
        self.run_script(at=210, dedupe=1, error="different error")
        self.assertEqual(self.notifications()[0], self.notifications()[1])
        self.run_script(at=270, probe_rc=0, lost_ack=1, expected=1)
        self.assertTrue((self.state / "alerted").exists())
        self.run_script(at=330, probe_rc=0, dedupe=1)
        self.assertEqual(self.notifications()[2], self.notifications()[3])
        self.assertFalse((self.state / "alerted").exists())
        self.assertEqual(len(json.loads((self.home / "accepted.json").read_text())), 2)

    def test_pending_attention_is_reconciled_when_probe_recovers(self):
        # The whole acknowledgement/probe transition matrix: accepted and rejected sends,
        # with probes either still failing or already recovered on the retry tick.
        for accepted, recovered in ((False, False), (False, True), (True, False), (True, True)):
            with self.subTest(accepted=accepted, recovered=recovered):
                self.run_script(at=0, app_rc=1)
                for tick in range(0, 180, 30):
                    self.run_script(at=tick)
                before = len(self.notifications())
                opts = {"lost_ack": 1} if accepted else {"notify_rc": 1}
                self.run_script(at=180, expected=1, **opts)
                self.assertFalse((self.state / "alerted").exists())
                self.run_script(at=210, probe_rc=0 if recovered else 1, dedupe=1)
                sent = self.notifications()[before:]
                self.assertEqual(sent[0], sent[1])
                if recovered:
                    self.assertEqual([row["--severity"] for row in sent],
                                     ["attention", "attention", "info"])
                    self.assertFalse((self.state / "alerted").exists())
                else:
                    self.assertEqual(len(sent), 2)
                    self.assertTrue((self.state / "alerted").exists())
                # Separate incidents get separate bridge keys in this shared fixture.
                (self.home / "accepted.json").unlink(missing_ok=True)

    def test_closed_app_or_restart_clears_incident_without_probe_or_notify(self):
        for condition in ({"app_rc": 1}, {"restart_rc": 0}):
            with self.subTest(condition=condition):
                self.fail_until_alert()
                probes = len(self.calls("probe"))
                alerts = len(self.notifications())
                self.run_script(at=210, **condition)
                self.assertEqual(len(self.calls("probe")), probes)
                self.assertEqual(len(self.notifications()), alerts)
                self.assertFalse((self.state / "first_fail").exists())
                self.assertFalse((self.state / "alerted").exists())
                self.run_script(at=240, probe_rc=0)
                self.assertEqual(len(self.notifications()), alerts)

    def test_brief_failure_recovers_silently_and_resets_timer(self):
        self.run_script(at=0)
        self.run_script(at=150, probe_rc=0)
        self.run_script(at=180)
        self.run_script(at=330)
        self.assertEqual(self.notifications(), [])
        self.assertEqual((self.state / "first_fail").read_text().strip(), "180")

    def test_error_is_first_line_trimmed_bounded_and_redacted(self):
        cases = [
            ("   " + "x" * 200 + "   \nsecond line", "x" * 120),
            ("Authorization: Bearer dummy-credential", "Authorization [redacted]"),
            ("HTTP failed: bearer dummy-credential", "HTTP failed: bearer [redacted]"),
            ("request failed token=dummy-credential", "request failed token [redacted]"),
            ("TOKEN: dummy-credential", "TOKEN [redacted]"),
            ("", "probe failed without stderr"),
        ]
        for error, expected in cases:
            with self.subTest(error=error):
                self.run_script(at=0, probe_rc=0)
                self.fail_until_alert(error=error)
                self.assertEqual((self.state / "last_error").read_text().strip(), expected)
                self.assertEqual(self.notifications()[-1]["--text"],
                                 f"Robob reads failing since 04:00 ({expected})")
                self.assertNotIn("dummy-credential", json.dumps(self.notifications()))

    def test_sustain_waits_five_full_minutes_after_initial_failures(self):
        self.sequence.write_text(json.dumps([1, 1]))
        result = self.run_script("--sustain", "300", "--every", "30", probe_rc=0,
                                 app_rc=1, restart_rc=0)
        probes = self.calls("probe")
        self.assertEqual([row["rc"] for row in probes], [1, 1] + [0] * 11)
        # Eleven readings delimit ten full 30-second intervals of healthy reads.
        self.assertEqual(probes[-1]["at"] - probes[2]["at"], 300)
        self.assertEqual(result.stdout, "reads healthy for 5 min\n")
        self.assertEqual(self.calls("notify"), [])
        self.assertEqual(self.calls("app"), [])
        self.assertTrue(self.state.is_dir())
        self.assertFalse((self.state / "first_fail").exists())

    def test_sustain_starts_clock_after_first_success_completes(self):
        self.run_script("--sustain", "30", "--every", "15", probe_rc=0, probe_seconds=10)
        self.assertEqual([row["at"] for row in self.calls("probe")], [0, 15, 30])
        self.assertEqual(self.clock.read_text(), "40")

    def test_sustain_keeps_thirty_second_cadence_with_slow_reads(self):
        self.run_script("--sustain", "300", "--every", "30", probe_rc=0, probe_seconds=10)
        self.assertEqual([row["at"] for row in self.calls("probe")], list(range(0, 301, 30)))
        self.assertEqual(self.clock.read_text(), "310")
        self.assertEqual(self.calls("notify"), [])

    def test_sustain_failure_midway_resets_healthy_window(self):
        self.sequence.write_text(json.dumps([0] * 6 + [1]))
        self.run_script("--sustain", "300", "--every", "30", probe_rc=0)
        probes = self.calls("probe")
        self.assertEqual(probes[6]["rc"], 1)
        self.assertEqual(probes[-1]["at"], 510)
        self.assertEqual(probes[-1]["at"] - probes[7]["at"], 300)
        self.assertEqual(self.calls("notify"), [])

    def test_sustain_gives_up_with_failure_since_and_last_error(self):
        result = self.run_script("--sustain", "300", "--give-up", "600", expected=1)
        self.assertEqual(self.clock.read_text(), "600")
        self.assertEqual(result.stdout,
                         "installed but reads still failing since 04:00 (request timed out)\n")
        self.assertEqual(len(self.calls("probe")), 20)
        self.assertTrue(self.state.is_dir())
        self.assertFalse((self.state / "first_fail").exists())
        self.assertEqual(self.calls("notify"), [])

    def test_sustain_deadline_is_not_extended_by_oversized_interval(self):
        self.run_script("--sustain", "300", "--every", "400", "--give-up", "100",
                        expected=1, probe_seconds=10)
        self.assertEqual([row["at"] for row in self.calls("probe")], [0])
        self.assertEqual(self.clock.read_text(), "100")
        self.assertEqual(self.calls("notify"), [])

    def test_deadline_sends_term_and_records_failure_without_stuck_identity(self):
        self.use_blocking_probe(ignore_term=False)
        started = time.monotonic()
        self.run_script(at=0)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(len(self.probe_children()), 1)
        self.assertFalse((self.state / "stuck_probe").exists())
        self.assertEqual((self.state / "last_error").read_text().strip(), "probe timed out after 1s")

    def test_ignored_term_is_abandoned_and_next_tick_does_not_spawn(self):
        self.use_blocking_probe()
        started = time.monotonic()
        self.run_script(at=0)
        self.assertLess(time.monotonic() - started, 4)
        pid = self.assert_stuck_child()
        self.assertRegex((self.state / "last_error").read_text(), rf"^probe stuck since \d\d:\d\d UTC \(pid {pid}\)")
        self.run_script(at=30)
        self.assertEqual(len(self.probe_children()), 1)
        self.assertEqual(self.terms(), [str(pid)])
        self.assertIn("prior probe still stuck", (self.state / "last_error").read_text())

    def test_sustain_and_ticks_share_identity_across_time_zones(self):
        # Fixed UTC, positive offset, negative/DST offset, and inherited system zone.
        zones = ("UTC0", "Asia/Dubai", "America/New_York", None)
        for capture_zone in zones:
            with self.subTest(capture_zone=capture_zone):
                self.child_records.unlink(missing_ok=True)
                (self.home / "terms.jsonl").unlink(missing_ok=True)
                (self.home / "release_probe").unlink(missing_ok=True)
                self.use_blocking_probe()
                if capture_zone is None:
                    self.env.pop("TZ", None)
                else:
                    self.env["TZ"] = capture_zone
                self.run_script("--sustain", "30", "--give-up", "1", expected=1)
                pid = self.assert_stuck_child()
                record = (self.state / "stuck_probe").read_text()
                for retry_zone in zones:
                    with self.subTest(retry_zone=retry_zone):
                        if retry_zone is None:
                            self.env.pop("TZ", None)
                        else:
                            self.env["TZ"] = retry_zone
                        self.run_script(at=30)
                        self.assertEqual(len(self.probe_children()), 1)
                        self.assertEqual((self.state / "stuck_probe").read_text(), record)
                        self.assertIn("prior probe still stuck", (self.state / "last_error").read_text())
                        self.assertEqual(self.terms(), [str(pid)])
                self.release_children()
                (self.state / "stuck_probe").unlink()

    def test_unreadable_start_time_never_releases_a_live_prior_guard(self):
        prior = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"])
        self.processes.append(prior)
        self.state.mkdir()
        record = f"{prior.pid} {self.start_time(prior.pid)}\n"
        for result in ("error", "empty", "whitespace"):
            with self.subTest(result=result):
                self.install_ps_fault(first_call=1, result=result)
                (self.state / "stuck_probe").write_text(record)
                self.run_script(at=0)
                self.assertEqual(self.calls("probe"), [])
                self.assertEqual((self.state / "stuck_probe").read_text(), record)
                self.assertIn("prior probe still stuck", (self.state / "last_error").read_text())

    def test_unreadable_start_time_during_capture_or_timeout_keeps_suppression(self):
        # Whole lookup-failure class: initial capture, before TERM, after TERM;
        # each lookup may fail, succeed without output, or return whitespace.
        for phase, first_call, expected_terms in (("capture", 1, 0), ("before_term", 2, 0),
                                                   ("after_term", 3, 1)):
            for result in ("error", "empty", "whitespace"):
                with self.subTest(phase=phase, result=result):
                    self.child_records.unlink(missing_ok=True)
                    (self.home / "terms.jsonl").unlink(missing_ok=True)
                    (self.home / "ps-count").unlink(missing_ok=True)
                    (self.home / "release_probe").unlink(missing_ok=True)
                    self.use_blocking_probe()
                    self.install_ps_fault(first_call, result)
                    self.run_script(at=0)
                    child = self.probe_children()[0]
                    expected_start = "unknown" if phase == "capture" else child["start"]
                    record = f"{child['pid']} {expected_start}\n"
                    self.assertEqual((self.state / "stuck_probe").read_text(), record)
                    self.assertEqual(len(self.terms()), expected_terms)
                    self.run_script(at=30)
                    self.assertEqual(len(self.probe_children()), 1)
                    self.assertEqual((self.state / "stuck_probe").read_text(), record)
                    self.assertIn("prior probe still stuck", (self.state / "last_error").read_text())
                    self.assertEqual(len(self.terms()), expected_terms)
                    # Restoring ps cannot prove reuse when capture never had an identity.
                    if phase == "capture":
                        (self.home / ".local/bin/ps").unlink()
                        self.run_script(at=60)
                        self.assertEqual(len(self.probe_children()), 1)
                        self.assertEqual((self.state / "stuck_probe").read_text(), record)
                    self.release_children()
                    (self.state / "stuck_probe").unlink()

    def test_stale_record_is_cleared_for_dead_reused_and_malformed_identities(self):
        dead = subprocess.Popen([sys.executable, "-I", "-c", "pass"])
        dead.wait(timeout=5)
        records = [f"{dead.pid} Tue Nov 17 00:00:00 2026\n",
                   f"{os.getpid()} Tue Nov 17 00:00:00 1999\n", "", "not-a-pid\n", "0 x\n"]
        for record in records:
            with self.subTest(record=record):
                self.state.mkdir(exist_ok=True)
                (self.state / "stuck_probe").write_text(record)
                before = len(self.calls("probe"))
                self.run_script(at=0, probe_rc=0)
                self.assertEqual(len(self.calls("probe")), before + 1)
                self.assertFalse((self.state / "stuck_probe").exists())

    def test_stuck_child_alerts_once_and_recovers_after_identity_exits(self):
        normal_probe = self.env["ROBOB_WD_PROBE"]
        self.use_blocking_probe()
        self.fail_until_alert()
        pid = self.assert_stuck_child()
        self.run_script(at=210)
        self.assertEqual(len(self.notifications()), 1)
        self.assertEqual(self.notifications()[0]["--severity"], "attention")
        self.assertIn(f"prior probe still stuck since", self.notifications()[0]["--text"])
        self.assertIn(f"(pid {pid})", self.notifications()[0]["--text"])
        (self.home / "release_probe").touch()
        deadline = time.monotonic() + 5
        while self.start_time(pid) is not None and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIsNone(self.start_time(pid))
        self.env["ROBOB_WD_PROBE"] = normal_probe
        self.run_script(at=240, probe_rc=0)
        self.run_script(at=270, probe_rc=0)
        self.assertEqual([row["--severity"] for row in self.notifications()], ["attention", "info"])
        self.assertFalse((self.state / "stuck_probe").exists())
        self.assertFalse((self.state / "first_fail").exists())

    def test_sustain_caps_probe_at_give_up_and_abandons_one_child(self):
        self.use_blocking_probe(deadline=20)
        started = time.monotonic()
        result = self.run_script("--sustain", "30", "--every", "1", "--give-up", "1", expected=1)
        self.assertLess(time.monotonic() - started, 4)
        self.assertIn("probe stuck since", result.stdout)
        self.assert_stuck_child()
        self.assertEqual(self.calls("notify"), [])
        # --sustain must consume the same prior-child identity as a tick.
        self.run_script("--sustain", "30", "--every", "1", "--give-up", "2", expected=1)
        self.assertEqual(len(self.probe_children()), 1)
        self.run_script(at=60)
        self.assertEqual(len(self.probe_children()), 1)

    def test_tick_and_sustain_race_does_not_spawn_two_children(self):
        self.use_blocking_probe()
        process = subprocess.Popen(["/bin/zsh", str(SCRIPT), "--sustain", "30", "--give-up", "4"],
                                   env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(process)
        deadline = time.monotonic() + 5
        while not self.probe_children() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(len(self.probe_children()), 1)
        self.run_script(at=0)
        self.assertEqual(len(self.probe_children()), 1)
        self.assertEqual((self.state / "last_error").read_text().strip(), "another probe is running")
        self.assertEqual(process.wait(timeout=7), 1)
        self.assert_stuck_child()

    def test_invalid_arguments_do_not_probe_or_notify(self):
        for args in (("--sustain",), ("--sustain", "0"), ("--sustain", "-1"),
                     ("--sustain", "abc"), ("--sustain", "300", "--every", "0"),
                     ("--sustain", "300", "--give-up", "-1"), ("--unknown", "5"),
                     ("--every", "5")):
            with self.subTest(args=args):
                self.assertIn("usage:", self.run_script(*args, expected=2).stderr)
        self.assertEqual(self.calls("probe"), [])
        self.assertEqual(self.calls("notify"), [])


if __name__ == "__main__":
    unittest.main()
