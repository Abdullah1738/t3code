"""End-to-end health notification state, without the live bridges or data."""
import json
import fcntl
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import health_check as hc


class HealthIncidents(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = 1_700_000_000
        self.day = "20261104"
        self.ok = True
        self.other_ok = True
        self.notices = []
        self.messages = []
        self.send_ok = True
        self.imessage_ok = True
        self.patches = [
            mock.patch.object(hc, "LOGS", self.tmp.name),
            mock.patch.object(hc, "STATE", os.path.join(self.tmp.name, "state.json")),
            mock.patch.object(hc, "LAST", os.path.join(self.tmp.name, "last.json")),
            mock.patch.object(hc.time, "time", side_effect=lambda: self.now),
            mock.patch.object(hc.time, "strftime", side_effect=lambda *_: self.day),
            mock.patch.object(hc, "notify", side_effect=self.notify),
            mock.patch.object(hc, "telegram_delivered", return_value=True),
            mock.patch.object(hc, "muse_problem_safe_to_skip", return_value=False),
            mock.patch.object(hc, "notify_capture_imessage", side_effect=self.imessage),
            mock.patch.object(hc, "CHECKS", [("sync", self.sync), ("muse_lag", self.muse)]),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(setattr, hc, "DRY_RUN", False)

    def sync(self):
        return self.other_ok, "sync is " + ("ok" if self.other_ok else "down")

    def muse(self):
        return self.ok, "muse is " + ("ok" if self.ok else "down")

    def notify(self, severity, text, key):
        self.notices.append((severity, text, key))
        return self.send_ok

    def imessage(self, key):
        self.messages.append(key)
        return self.imessage_ok

    def run_check(self, *args):
        with mock.patch.object(sys, "argv", ["health_check.py", *args]), mock.patch("builtins.print"):
            hc.main()

    def state(self):
        with open(hc.STATE) as f:
            return json.load(f)

    def set_capture(self, last_ok):
        os.makedirs(os.path.join(self.tmp.name, "state"), exist_ok=True)
        with open(os.path.join(self.tmp.name, "state", "capture.last_ok"), "w") as f:
            f.write(str(last_ok))

    def test_two_consecutive_failures_one_problem_and_one_recovery(self):
        self.ok = False
        self.run_check()  # first failure never alerts
        self.assertEqual(self.notices, [])
        self.run_check("--dry-run")
        self.assertEqual(self.state()["failing"]["muse_lag"]["consecutive_failures"], 1)
        self.run_check()  # second failure
        self.assertEqual([n[0] for n in self.notices], ["attention"])
        self.day = "20261105"
        self.run_check()  # no daily repeats in a single incident
        self.assertEqual(len(self.notices), 1)
        self.ok = True
        self.run_check()
        self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention", "info"])
        self.assertEqual(self.notices[1][1], "Memory system recovered: muse_lag.")
        self.assertNotIn("muse_lag", self.state()["failing"])

    def test_single_failure_recovers_silently_then_new_incident(self):
        self.ok = False
        self.run_check()
        self.ok = True
        self.run_check()
        self.assertEqual(self.notices, [])
        self.ok = False
        self.run_check()
        self.assertEqual(self.notices, [])
        self.run_check()
        self.assertEqual(len(self.notices), 1)

    def test_failed_notices_retry_with_stable_incident_keys(self):
        self.ok = False
        self.run_check()
        self.send_ok = False
        self.run_check()
        key = self.notices[-1][2]
        self.send_ok = True
        self.run_check()
        self.assertEqual(self.notices[-1][2], key)
        self.ok = True
        self.send_ok = False
        self.run_check()
        recovery_key = self.notices[-1][2]
        self.send_ok = True
        self.run_check()
        self.assertEqual(self.notices[-1][2], recovery_key)
        self.run_check()
        self.assertEqual(len(self.notices), 4)

    def test_ambiguous_problem_send_is_replayed_before_recovery(self):
        self.ok = False
        self.run_check()
        self.send_ok = False
        self.run_check()
        self.ok = True
        self.send_ok = True
        self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention", "attention", "info"])
        self.assertEqual(self.notices[0][2], self.notices[1][2])
        self.run_check()
        self.assertEqual(len(self.notices), 3)

    def test_recovery_after_first_attempt_was_interrupted(self):
        self.ok = False
        self.run_check()
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE)
        with mock.patch.object(hc, "notify", side_effect=RuntimeError("stopped")):
            with self.assertRaises(RuntimeError):
                self.run_check()
        self.ok = True
        self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention", "info"])

    def test_first_muse_notice_not_attempted_if_prior_alert_failed_during_recovery(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.send_ok = False
        self.ok = True
        self.run_check()
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.run_check()
        self.send_ok = True
        self.run_check()
        self.run_check()
        keys = {n[2] for n in self.notices if n[0] == "attention" and "- muse_lag:" in n[1]}
        self.assertEqual(len(keys), 2)

    def test_crash_during_problem_send_is_replayed_before_recovery(self):
        self.ok = False
        self.run_check()
        with mock.patch.object(hc, "notify", side_effect=RuntimeError("stopped")):
            with self.assertRaises(RuntimeError):
                self.run_check()
        self.ok = True
        self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention", "info"])

    def test_existing_notified_incident_and_other_check_are_preserved(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"muse_lag": {"since": 1, "msg": "old", "notified_day": "20261104"}}}, f)
        self.ok = False
        self.other_ok = False
        self.run_check()
        self.assertEqual([n[1] for n in self.notices], ["Memory system problem:\n- sync: sync is down"])
        self.ok = True
        self.run_check()
        self.assertEqual(self.notices[-1][1], "Memory system recovered: muse_lag.")

    def test_legacy_muse_migration_recovery_does_not_wait_on_new_problem_key(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"muse_lag": {"since": 1, "msg": "old", "notified_day": "20261104"}}}, f)
        with mock.patch.object(hc, "telegram_delivered", side_effect=lambda key: ":recovered:" in key):
            self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["info"])
        self.assertEqual(self.state()["muse_recoveries"], [])

    def test_legacy_failing_muse_keeps_migration_flag_until_recovery(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"muse_lag": {"since": 1, "msg": "old", "notified_day": "20261104"}}}, f)
        self.ok = False
        self.run_check()
        self.ok = True
        with mock.patch.object(hc, "telegram_delivered", side_effect=lambda key: ":recovered:" in key):
            self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["info"])
        self.assertEqual(self.state()["muse_recoveries"], [])

    def test_failed_recovery_is_requeued_with_new_key_only_after_definite_failure(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        with mock.patch.object(hc, "telegram_delivered", side_effect=lambda key: ":recovered:" not in key):
            self.run_check()
            old_recovery = self.notices[-1][2]
            with mock.patch.object(hc, "muse_problem_safe_to_skip", side_effect=lambda key: key == old_recovery):
                self.run_check()
        self.assertNotEqual(self.notices[-1][2], old_recovery)

    def test_recovery_transition_survives_crash_during_other_notifications(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.other_ok = False
        old_notify = self.notify

        def crash_on_other(severity, text, key):
            if "- sync:" in text:
                raise RuntimeError("process stopped")
            return old_notify(severity, text, key)

        with mock.patch.object(hc, "notify", side_effect=crash_on_other):
            with self.assertRaisesRegex(RuntimeError, "process stopped"):
                self.run_check()
        self.run_check()
        self.assertEqual(sum(n[1] == "Memory system recovered: muse_lag." for n in self.notices), 1)
        self.assertEqual(sum("- sync:" in n[1] for n in self.notices), 1)

    def test_other_check_crash_does_not_lose_the_muse_problem(self):
        self.ok = False
        self.run_check()
        self.other_ok = False

        def crash_on_other(severity, text, key):
            if "- sync:" in text:
                raise RuntimeError("process stopped")
            return self.notify(severity, text, key)

        with mock.patch.object(hc, "notify", side_effect=crash_on_other):
            with self.assertRaises(RuntimeError):
                self.run_check()
        self.run_check()
        self.assertEqual(sum("- muse_lag:" in n[1] for n in self.notices), 1)
        self.assertEqual(sum("- sync:" in n[1] for n in self.notices), 1)

    def test_legacy_recovery_and_new_failure_survive_muse_send_crash(self):
        self.other_ok = False
        self.run_check()
        self.other_ok = True
        self.ok = False
        self.run_check()

        def crash_on_muse(severity, text, key):
            if "- muse_lag:" in text:
                raise RuntimeError("stopped")
            return self.notify(severity, text, key)

        with mock.patch.object(hc, "notify", side_effect=crash_on_muse):
            with self.assertRaises(RuntimeError):
                self.run_check()
        self.other_ok = False
        self.run_check()
        self.assertEqual(sum("Memory system recovered: sync." == n[1] for n in self.notices), 1)
        self.assertEqual(sum("- sync:" in n[1] for n in self.notices), 2)

    def test_stable_imessage_key_survives_process_death(self):
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE)

        def interrupted(key):
            self.messages.append(key)
            raise RuntimeError("process stopped after enqueue")

        with mock.patch.object(hc, "notify_capture_imessage", side_effect=interrupted):
            self.run_check()
        self.run_check()
        self.assertEqual(self.messages[0], self.messages[1])

    def test_capture_failure_does_not_block_unrelated_checks(self):
        self.other_ok = False
        with mock.patch.object(hc, "capture_notice", side_effect=RuntimeError("cannot read marker")):
            self.run_check()
        self.assertEqual(len(self.notices), 1)
        self.assertIn("sync is down", self.notices[0][1])
        with open(hc.LAST) as f:
            self.assertFalse(json.load(f)["checks"]["sync"]["ok"])

    def test_simultaneous_run_is_skipped_without_changing_state_or_sending(self):
        self.ok = False
        self.run_check()
        with open(hc.STATE) as f:
            saved = f.read()
        with open(hc.STATE + ".lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.run_check()
            with open(hc.STATE) as f:
                self.assertEqual(f.read(), saved)
        self.assertEqual(self.notices, [])
        self.run_check()
        self.assertEqual(len(self.notices), 1)

    def test_pending_recovery_finishes_before_new_incident_notice(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.send_ok = False
        self.run_check()
        self.ok = False
        self.run_check()
        self.send_ok = True
        self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention", "info", "info", "info", "attention"])

    def test_second_incident_that_recovers_while_prior_recovery_pending_is_queued(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.send_ok = False
        self.ok = True
        self.run_check()
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.run_check()
        self.send_ok = True
        start = len(self.notices)
        self.run_check()
        self.assertEqual([n[0] for n in self.notices[start:]], ["info", "attention", "info"])

    def test_failed_earlier_recovery_blocks_later_recovery_and_problem(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.send_ok = False
        self.run_check()
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        self.run_check()
        calls = []

        def fail_first_recovery(severity, text, key):
            calls.append(key)
            return severity != "info"

        with mock.patch.object(hc, "notify", side_effect=fail_first_recovery):
            self.run_check()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(self.state()["muse_recoveries"]), 2)

    def test_recovery_waits_for_delivered_problem_and_new_problem_waits_for_recovery(self):
        delivered = set()
        with mock.patch.object(hc, "telegram_delivered", side_effect=lambda key: key in delivered):
            self.ok = False
            self.run_check()
            self.run_check()
            problem = self.notices[-1][2]
            self.ok = True
            self.run_check()
            self.assertEqual(len(self.notices), 1)
            delivered.add(problem)
            self.run_check()
            recovery = self.notices[-1][2]
            self.assertEqual(self.notices[-1][0], "info")
            self.ok = False
            self.run_check()
            self.run_check()
            self.assertEqual(len(self.notices), 2)
            delivered.add(recovery)
            self.run_check()
            self.assertEqual(len(self.notices), 3)
            self.assertEqual(self.notices[-1][0], "attention")

    def test_definitely_failed_problem_can_clear_without_a_false_recovery(self):
        self.ok = False
        self.run_check()
        self.run_check()
        self.ok = True
        with mock.patch.object(hc, "telegram_delivered", return_value=False), \
                mock.patch.object(hc, "muse_problem_safe_to_skip", return_value=True):
            self.run_check()
        self.assertEqual([n[0] for n in self.notices], ["attention"])
        self.assertEqual(self.state()["muse_recoveries"], [])

    def test_changing_failure_details_do_not_change_ambiguous_retry_payload(self):
        seen = {}

        def strict_notify(severity, text, key):
            if key in seen:
                self.assertEqual(seen[key], (severity, text))
            seen[key] = (severity, text)
            return self.send_ok

        self.ok = False
        self.run_check()
        self.send_ok = False
        with mock.patch.object(hc, "notify", side_effect=strict_notify):
            self.run_check()
            with mock.patch.object(hc, "CHECKS", [("muse_lag", lambda: (False, "later age"))]):
                self.run_check()
            self.ok = True
            self.send_ok = True
            self.run_check()
        self.assertEqual(len(seen), 2)

    def test_real_telegram_enqueue_contract_for_changing_details(self):
        # Mirror Telegram Store.enqueue's id/payload check rather than just
        # treating each mocked CLI return as a successful send.
        accepted = {}
        calls = 0

        def bridge(severity, text, key):
            nonlocal calls
            calls += 1
            spec = (severity, text)
            if key in accepted and accepted[key] != spec:
                return False
            accepted[key] = spec
            return calls != 1  # first enqueue lands but its ack is lost

        self.ok = False
        self.run_check()
        with mock.patch.object(hc, "notify", side_effect=bridge):
            self.run_check()
            with mock.patch.object(hc, "CHECKS", [("muse_lag", lambda: (False, "new age"))]):
                self.run_check()
            self.ok = True
            self.run_check()
        self.assertEqual(calls, 3)
        self.assertEqual(len(accepted), 2)

    def test_raw_capture_six_hours_once_and_rearms_after_success(self):
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE + 1)
        self.run_check()
        self.assertEqual(self.messages, [])
        self.now += 1
        self.run_check("--dry-run")
        self.assertEqual(self.messages, [])
        self.run_check()
        self.run_check()
        self.assertEqual(len(self.messages), 1)
        previous = self.messages[0]
        self.now += 120
        self.set_capture(self.now)
        self.run_check()
        self.now += hc.CAPTURE_IMESSAGE_AGE
        self.run_check()
        self.assertEqual(len(self.messages), 2)
        self.assertNotEqual(previous, self.messages[1])

    def test_missing_marker_counts_from_first_observation_and_retries(self):
        self.run_check()
        self.now += hc.CAPTURE_IMESSAGE_AGE
        self.imessage_ok = False
        self.run_check()
        self.imessage_ok = True
        self.run_check()
        self.run_check()
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.messages[0], self.messages[1])

    def test_missing_marker_later_supplied_can_prove_an_older_outage(self):
        self.run_check()
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE)
        self.run_check()
        self.assertEqual(len(self.messages), 1)

    def test_missing_success_does_not_trust_old_watch_since(self):
        os.makedirs(os.path.join(self.tmp.name, "state"), exist_ok=True)
        with open(os.path.join(self.tmp.name, "state", "capture.watch_since"), "w") as f:
            f.write(str(self.now - hc.CAPTURE_IMESSAGE_AGE - 1))
        self.other_ok = False
        self.run_check()
        self.assertEqual(self.messages, [])

    def test_missing_success_uses_legacy_sync_failing_since(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"sync": {"since": self.now - hc.CAPTURE_IMESSAGE_AGE - 1,
                       "notified_day": self.day, "msg": "down"}}}, f)
        self.other_ok = False
        self.run_check()
        self.assertEqual(len(self.messages), 1)

    def test_older_fallback_marker_does_not_rearm(self):
        old = self.now - 8 * 3600
        fresh = self.now - 7 * 3600
        with open(os.path.join(self.tmp.name, "capture_last.json"), "w") as f:
            json.dump({"last_ok_ts": old}, f)
        self.set_capture(fresh)
        self.run_check()
        self.set_capture("")
        self.run_check()
        self.set_capture(fresh)
        self.run_check()
        self.assertEqual(len(self.messages), 1)

    def test_older_marker_reappearing_after_unmarked_outage_is_same_incident(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"sync": {"since": self.now - 7 * 3600,
                       "notified_day": self.day, "msg": "down"}}}, f)
        self.other_ok = False
        self.run_check()
        self.set_capture(self.now - 8 * 3600)
        self.run_check()
        self.assertEqual(len(self.messages), 1)

    def test_restored_marker_newer_than_legacy_failure_but_before_first_observation(self):
        with open(hc.STATE, "w") as f:
            json.dump({"failing": {"sync": {"since": self.now - 8 * 3600,
                       "notified_day": self.day, "msg": "down"}}}, f)
        self.other_ok = False
        self.run_check()
        self.set_capture(self.now - 7 * 3600)
        self.run_check()
        self.assertEqual(len(self.messages), 1)

    def test_fresh_success_during_earlier_notice_prevents_stale_alert(self):
        self.set_capture(self.now - 8 * 3600)
        self.other_ok = False

        def notify_then_capture(severity, text, key):
            self.now += 1
            self.set_capture(self.now)
            return self.notify(severity, text, key)

        with mock.patch.object(hc, "notify", side_effect=notify_then_capture):
            self.run_check()
        self.assertEqual(self.messages, [])

    def test_capture_success_during_marker_read_is_not_discarded(self):
        self.set_capture(self.now - 8 * 3600)
        def success_during_status_read(name):
            self.now += 1
            self.set_capture(self.now)
            return {"last_ok_ts": self.now - 8 * 3600}

        with mock.patch.object(hc, "stage_status", side_effect=success_during_status_read):
            self.run_check()
        self.assertEqual(self.messages, [])

    def test_capture_marker_shapes(self):
        for marker, expected in [
            ("", None), ("0", None), ("invalid", None), ("NaN", None),
            ("Infinity", None), (str(self.now + 1), None),
            (str(self.now - 60), self.now - 60),
        ]:
            with self.subTest(marker=marker):
                self.set_capture(marker)
                self.assertEqual(hc.capture_last_success(self.now), expected)

    def test_capture_prefers_fresh_marker_over_stale_status(self):
        self.set_capture(self.now)
        with open(os.path.join(self.tmp.name, "capture_last.json"), "w") as f:
            json.dump({"last_ok_ts": self.now - 8 * 3600}, f)
        self.run_check()
        self.assertEqual(self.messages, [])

    def test_cancelled_send_rearms_once_with_new_key(self):
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE)
        self.run_check()
        first = self.messages[0]
        with mock.patch.object(hc, "capture_send_retryable", return_value=True):
            self.run_check()
        self.assertEqual(len(self.messages), 2)
        self.assertNotEqual(first, self.messages[1])
        with mock.patch.object(hc, "capture_send_retryable", return_value=False):
            self.run_check()
        self.assertEqual(len(self.messages), 2)

    def test_cancelled_send_after_lost_ack_rearms(self):
        self.set_capture(self.now - hc.CAPTURE_IMESSAGE_AGE)
        self.imessage_ok = False
        self.run_check()
        first = self.messages[0]
        self.imessage_ok = True
        with mock.patch.object(hc, "capture_send_retryable", return_value=True):
            self.run_check()
        self.assertNotEqual(first, self.messages[1])


class SpectrumSend(unittest.TestCase):
    def test_reads_owner_route_and_calls_session_bound_send(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.sqlite")
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
                db.execute("INSERT INTO kv VALUES ('route', ?)", (json.dumps({"id": "owner-thread", "generation": 7}),))
            with mock.patch.object(hc, "SPECTRUM_DB", path), \
                    mock.patch.object(hc.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
                self.assertTrue(hc.notify_capture_imessage("capture-key"))
            args = run.call_args.args[0]
            self.assertEqual(args[:3], [hc.BUN, hc.SPECTRUM_CLI, "send"])
            self.assertEqual(args[args.index("--session") + 1], "owner-thread@7")
            self.assertEqual(args[args.index("--key") + 1], "capture-key")
            self.assertIn("6 hours", args[args.index("--text") + 1])

    def test_missing_route_and_failed_send_are_retryable(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(hc, "SPECTRUM_DB", os.path.join(directory, "missing")):
                self.assertFalse(hc.notify_capture_imessage("key"))

    def test_only_cancelled_outbox_row_may_be_requeued(self):
        import hashlib

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "state.sqlite")
            key = "memory-capture-stall:incident"
            row_id = "send:" + hashlib.sha256(key.encode()).hexdigest()
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE outbox (id TEXT PRIMARY KEY, state TEXT, attempts INTEGER)")
                db.execute("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
                db.execute("INSERT INTO outbox VALUES (?, 'pending', 0)", (row_id,))
            cases = [
                ("pending", 0, None, False),
                ("cancelled", 0, None, True),
                ("cancelled", 1, None, False),
                ("cancelled", 0, f"firstAttempt:{row_id}", False),
                ("cancelled", 0, f"sendAmbiguous:{row_id}", False),
                ("cancelled", 0, f"chunk:{row_id}:0", False),
                ("failed", 1, f"sendAmbiguous:{row_id}", True),
                ("uncertain", 1, None, False),
                ("sent", 1, f"chunk:{row_id}:0", False),
            ]
            with mock.patch.object(hc, "SPECTRUM_DB", path):
                self.assertFalse(hc.capture_send_retryable("unknown"))
                for state, attempts, mark, expected in cases:
                    with self.subTest(state=state, attempts=attempts, mark=mark):
                        with sqlite3.connect(path) as db:
                            db.execute("UPDATE outbox SET state=?, attempts=? WHERE id=?", (state, attempts, row_id))
                            db.execute("DELETE FROM kv")
                            if mark:
                                value = "false" if state == "failed" else '{"accepted":true}'
                                db.execute("INSERT INTO kv VALUES (?, ?)", (mark, value))
                        self.assertEqual(hc.capture_send_retryable("incident"), expected)

    def test_telegram_recovery_waits_for_sent_state(self):
        import hashlib

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "telegram.sqlite")
            key = "problem-key"
            row_id = "notify:" + hashlib.sha256(key.encode()).hexdigest()
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE outbox (id TEXT PRIMARY KEY, state TEXT, attempts INTEGER)")
                db.execute("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
                db.execute("INSERT INTO outbox VALUES (?, 'pending', 0)", (row_id,))
            with mock.patch.object(hc, "TG_DB", path):
                for status in ("pending", "sending", "uncertain", "failed", "cancelled", "sent"):
                    with self.subTest(status=status):
                        with sqlite3.connect(path) as db:
                            db.execute("UPDATE outbox SET state=? WHERE id=?", (status, row_id))
                        self.assertEqual(hc.telegram_delivered(key), status == "sent")
                self.assertFalse(hc.telegram_delivered("unknown"))
                with sqlite3.connect(path) as db:
                    db.execute("UPDATE outbox SET state='uncertain' WHERE id=?", (row_id,))
                    db.execute("INSERT INTO kv VALUES (?, ?)", (f"chunk:{row_id}:0", '{"accepted":true}'))
                self.assertTrue(hc.telegram_delivered(key))
                with sqlite3.connect(path) as db:
                    db.execute("DELETE FROM kv")
                cases = [("failed", 1, "false", True), ("failed", 1, "true", False),
                         ("failed", 1, None, False), ("cancelled", 0, None, True),
                         ("cancelled", 1, "true", False), ("uncertain", 1, "true", False),
                         ("pending", 0, None, False), ("sent", 1, "false", False)]
                for status, attempts, marker, expected in cases:
                    with self.subTest(status=status, attempts=attempts, marker=marker):
                        with sqlite3.connect(path) as db:
                            db.execute("UPDATE outbox SET state=?, attempts=? WHERE id=?", (status, attempts, row_id))
                            db.execute("DELETE FROM kv")
                            if marker is not None:
                                db.execute("INSERT INTO kv VALUES (?, ?)", (f"sendAmbiguous:{row_id}", marker))
                        self.assertEqual(hc.muse_problem_safe_to_skip(key), expected)

if __name__ == "__main__":
    unittest.main()
