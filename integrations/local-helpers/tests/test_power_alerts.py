"""The power alert scripts against a fake pmset and a fake Telegram notify. Nothing is sent."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"
BATT = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t%d%%; discharging; 2:00 remaining present: true\n"


class PowerAlertTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="power-alerts-test-")
        self.batt = os.path.join(self.home, "batt.txt")
        self.out = os.path.join(self.home, "notify.log")
        for name, body in (("pmset", '#!/bin/sh\ncat "$FAKE_BATT"\n'),
                           ("notify", '#!/bin/sh\nshift 2  # cli.ts notify\nprintf "%s|" "$@" >> "$FAKE_OUT"\necho "BUN_INSPECT=${BUN_INSPECT-unset}" >> "$FAKE_OUT"\n'
                                      'exit "${FAKE_NOTIFY_RC:-0}"\n')):
            with open(os.path.join(self.home, name), "w") as fh:
                fh.write(body)
            os.chmod(os.path.join(self.home, name), 0o755)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_script(self, name, power, *args, rc=0, notify_rc=0, notify=None, lost_ack=False, pmset_then_lock=False):
        with open(self.batt, "w") as fh:
            fh.write(power)
        env = {"FAKE_NOTIFY_RC": str(notify_rc), "HOME": self.home, "PATH": "/usr/bin:/bin", "POWER_PMSET": os.path.join(self.home, "pmset"),
               "POWER_NOTIFY": notify or os.path.join(self.home, "notify"), "FAKE_BATT": self.batt, "FAKE_OUT": self.out,
               "BUN_INSPECT": "ws://127.0.0.1:1/inspect"}
        if lost_ack:
            env["FAKE_LOST_ACK"] = "1"
        if pmset_then_lock:
            # The state dir turns read-only right after the notify call (pending already saved).
            lock = os.path.join(self.home, "lock-notify")
            with open(lock, "w") as fh:
                fh.write('#!/bin/sh\n"$REAL_NOTIFY" "$@"; rc=$?\nchmod 555 "$HOME/.local/state"\nexit $rc\n')
            os.chmod(lock, 0o755)
            env["REAL_NOTIFY"], env["POWER_NOTIFY"] = env["POWER_NOTIFY"], lock
        try:
            r = subprocess.run(["/bin/zsh", os.path.join(HERE, "bin", name), *args], env=env, capture_output=True,
                               text=True, timeout=30)
        finally:
            os.chmod(os.path.join(self.home, ".local/state"), 0o755) if pmset_then_lock else None
        self.assertEqual(r.returncode, rc, r.stderr)

    def sent(self):
        if not os.path.exists(self.out):
            return []
        with open(self.out) as fh:
            return [line.split("|") for line in fh.read().splitlines()]

    def test_unplug_and_replug_each_alert_once(self):
        self.run_script("power-unplug-telegram.sh", AC)  # first run only records the state
        self.assertEqual(self.sent(), [])
        self.run_script("power-unplug-telegram.sh", BATT % 57)
        self.run_script("power-unplug-telegram.sh", BATT % 56)
        self.run_script("power-unplug-telegram.sh", AC)
        sent = self.sent()
        self.assertEqual(len(sent), 2, sent)
        self.assertEqual(sent[0][:6], ["--source", "Battery", "--severity", "attention", "--text",
                                       "MacBook was just UNPLUGGED (battery 57%). Plug it back in."])
        self.assertTrue(sent[0][7].startswith("power-batt:"))
        self.assertEqual(sent[1][5], "MacBook plugged back in (battery 100%).")
        self.assertEqual(sent[1][3], "info")
        self.assertTrue(all(s[-1] == "BUN_INSPECT=unset" for s in sent))  # bun can't bind the server's port

    def test_test_flag_sends_one_message_and_keeps_the_state(self):
        self.run_script("power-unplug-telegram.sh", AC)
        self.run_script("power-unplug-telegram.sh", AC, "--test")
        sent = self.sent()
        self.assertEqual(len(sent), 1)
        self.assertIn("Test: the unplug alert works", sent[0][5])
        self.assertTrue(sent[0][7].startswith("power-test:"))
        self.run_script("power-unplug-telegram.sh", AC)
        self.assertEqual(len(self.sent()), 1)

    def test_a_failed_alert_is_retried_with_the_same_key(self):
        # Sol r1: the new source used to be saved before the send, so a failed send was never retried.
        self.run_script("power-unplug-telegram.sh", AC)
        self.run_script("power-unplug-telegram.sh", BATT % 57, rc=1, notify_rc=1)
        self.run_script("power-unplug-telegram.sh", BATT % 56)
        self.run_script("power-unplug-telegram.sh", BATT % 55)
        sent = self.sent()
        self.assertEqual(len(sent), 2, sent)
        self.assertEqual(sent[0][7], sent[1][7])  # one dedupe key: a send that did go through isn't repeated
        self.assertTrue(sent[0][7].startswith("power-batt:"))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".local/state/power-source.pending")))

    def test_a_change_that_reverts_before_it_was_sent_drops_the_alert(self):
        self.run_script("power-unplug-telegram.sh", AC)
        self.run_script("power-unplug-telegram.sh", BATT % 57, rc=1, notify_rc=1)
        self.run_script("power-unplug-telegram.sh", AC)
        self.assertEqual(len(self.sent()), 1)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".local/state/power-source.pending")))
        self.run_script("power-unplug-telegram.sh", BATT % 50)
        sent = self.sent()
        self.assertEqual(len(sent), 2)
        self.assertNotEqual(sent[0][7], sent[1][7])  # a new unplug gets a new key

    def bridge(self):
        """A notify that behaves like the Telegram bridge's outbox: a key it already has is a duplicate (fine) with
        the same text and a conflict (exit 1) with other text. FAKE_LOST_ACK: keep the message but report failure."""
        path = os.path.join(self.home, "bridge-notify")
        with open(path, "w") as fh:
            fh.write("#!/usr/bin/python3\nimport json, os, sys\n"
                     "a = sys.argv[3:]\nkey, text = a[a.index('--key') + 1], a[a.index('--text') + 1]\n"
                     "db = os.environ['FAKE_OUT'] + '.db'\n"
                     "seen = json.load(open(db)) if os.path.exists(db) else {}\n"
                     "if key in seen: sys.exit(0 if seen[key] == text else 1)\n"
                     "seen[key] = text\njson.dump(seen, open(db, 'w'))\n"
                     "sys.exit(1 if os.environ.get('FAKE_LOST_ACK') else 0)\n")
        os.chmod(path, 0o755)
        return path

    def accepted(self):
        with open(self.out + ".db") as fh:
            return json.load(fh)

    def test_a_retry_after_a_lost_reply_resends_the_same_text(self):
        # Sol r2: the retry used to rebuild the text with the newer battery %, and the bridge refuses a known key
        # with other text, so the change could never be confirmed.
        notify = self.bridge()
        self.run_script("power-unplug-telegram.sh", AC, notify=notify)
        self.run_script("power-unplug-telegram.sh", BATT % 57, rc=1, notify=notify, lost_ack=True)
        self.run_script("power-unplug-telegram.sh", BATT % 56, notify=notify)
        got = self.accepted()
        self.assertEqual(list(got.values()), ["MacBook was just UNPLUGGED (battery 57%). Plug it back in."])
        state = os.path.join(self.home, ".local/state/power-source")
        with open(state) as fh:
            self.assertEqual(fh.read().strip(), "batt")
        self.assertFalse(os.path.exists(state + ".pending"))

    def test_nothing_is_sent_without_a_saved_key_and_an_unsaved_source_keeps_the_key(self):
        # Sol r2: write failures used to send anyway under a key that was never kept, so every run sent again.
        notify = self.bridge()
        state_dir = os.path.join(self.home, ".local/state")
        state = os.path.join(state_dir, "power-source")
        self.run_script("power-unplug-telegram.sh", AC, notify=notify)
        os.chmod(state_dir, 0o555)
        try:
            self.run_script("power-unplug-telegram.sh", BATT % 57, rc=1, notify=notify)
            self.assertFalse(os.path.exists(self.out + ".db"))  # no pending key, no send
        finally:
            os.chmod(state_dir, 0o755)
        # The send goes through but saving the source fails: the key stays, so the next run only confirms it.
        self.run_script("power-unplug-telegram.sh", BATT % 57, rc=1, notify=notify, pmset_then_lock=True)
        self.run_script("power-unplug-telegram.sh", BATT % 55, notify=notify)
        self.assertEqual(len(self.accepted()), 1)
        with open(state) as fh:
            self.assertEqual(fh.read().strip(), "batt")

    def test_output_naming_no_power_source_changes_nothing(self):
        # Sol r1: empty or odd pmset output used to count as battery: a false unplug, then a false replug.
        for name in ("power-unplug-telegram.sh", "battery-low-telegram.sh"):
            self.run_script(name, AC)
            self.run_script(name, "")
            self.run_script(name, "pmset: some diagnostic 5%\n")
            self.run_script(name, AC)
        self.assertEqual(self.sent(), [])
        with open(os.path.join(self.home, ".local/state/power-source")) as fh:
            self.assertEqual(fh.read().strip(), "ac")

    def test_low_battery_alerts_only_on_battery_at_20_or_less(self):
        self.run_script("battery-low-telegram.sh", AC)
        self.run_script("battery-low-telegram.sh", BATT % 21)
        self.assertEqual(self.sent(), [])
        self.run_script("battery-low-telegram.sh", BATT % 20)
        self.run_script("battery-low-telegram.sh", BATT % 5)
        sent = self.sent()
        self.assertEqual([s[5] for s in sent], ["MacBook battery at 20%. Plug it in.", "MacBook battery at 5%. Plug it in."])
        self.assertTrue(all(s[-1] == "BUN_INSPECT=unset" for s in sent))

    def test_no_emoji_in_alert_texts(self):
        for name in ("power-unplug-telegram.sh", "battery-low-telegram.sh"):
            with open(os.path.join(HERE, "bin", name), encoding="utf-8") as fh:
                self.assertTrue(fh.read().isascii(), name)


if __name__ == "__main__":
    unittest.main()
