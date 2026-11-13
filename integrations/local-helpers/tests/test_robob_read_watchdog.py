"""Read watchdog against a fake clock, probe and notifier. Nothing is sent."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
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
        command = shlex.quote(str(fake))
        self.env = {
            "HOME": str(self.home), "PATH": "/usr/bin:/bin", "TZ": "Asia/Dubai",
            "ROBOB_WD_STATE": str(self.state), "ROBOB_WD_PROBE": command + " probe",
            "ROBOB_WD_NOTIFY": command + " notify", "ROBOB_WD_APP_RUNNING": command + " app",
            "ROBOB_WD_RESTARTING": command + " restart", "ROBOB_WD_NOW": command + " now",
            "ROBOB_WD_SLEEP": command + " sleep", "BUN_INSPECT": "ws://127.0.0.1:1/x",
        }

    def tearDown(self):
        self.temp.cleanup()

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
        self.assertFalse(self.state.exists())

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
        self.assertEqual(len(self.calls("probe")), 21)
        self.assertFalse(self.state.exists())
        self.assertEqual(self.calls("notify"), [])

    def test_sustain_deadline_is_not_extended_by_oversized_interval(self):
        self.run_script("--sustain", "300", "--every", "400", "--give-up", "100",
                        expected=1, probe_seconds=10)
        self.assertEqual([row["at"] for row in self.calls("probe")], [0, 100])
        self.assertEqual(self.clock.read_text(), "110")
        self.assertEqual(self.calls("notify"), [])

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
