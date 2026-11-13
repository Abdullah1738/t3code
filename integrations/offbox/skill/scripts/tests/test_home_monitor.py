"""Home server monitor: the state machine with fake probes, clock and senders; real HTTP only to local fakes.

Nothing here reaches the tailnet, the internet, Robob or Telegram: HOME is a temp dir for every test, so the
real senders have no credential and no bridge CLI to find.
"""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
OFFBOX = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
import home_monitor as hm

URL = "http://100.64.0.9:8443/api/v1"
ONLINE = {"online": True, "tailnet": True, "internet": True, "tailnet_detail": "BackendState=Running Self.Online=true",
          "internet_detail": "1.1.1.1:443 ok", "peer": "listed, offline (last seen 2026-11-12T10:00:00Z)"}
NO_TAILNET = dict(ONLINE, online=False, tailnet=False, tailnet_detail="BackendState=Stopped Self.Online=false")
NO_INTERNET = dict(ONLINE, online=False, internet=False, internet_detail="1.1.1.1:443 timeout; 8.8.8.8:443 timeout")
GOOD = {"mode": "ok", "reasons": [], "pool": "ONLINE", "mdraid": "ok", "boot_id": "boot-a", "version": "1.0",
        "uptime_s": 86400, "boatd_uptime_s": 86000}
BACKEND_KEYS = {"state", "since", "good_streak", "bad_streak", "last_check", "last_ok", "reason", "outage_id",
                "degraded"}


class FakeEffects:
    """Records every send. Like the real API it replays a repeated request id, and like the real bridge it
    refuses a repeated Telegram key whose text changed."""

    def __init__(self):
        self.created, self.sent, self.telegrams, self.calls = [], [], [], []
        self.open, self.fail, self.by_request, self.telegram_text = {}, set(), {}, {}

    def thread_open(self, thread_id):
        self.calls.append(("open", thread_id))
        return self.open.get(thread_id, False)

    def create_thread(self, title, prompt, request_id):
        self.calls.append(("create", request_id))
        if "create" in self.fail:
            return None
        if request_id not in self.by_request:
            thread_id = f"ardud-control:thread:t{len(self.created) + 1}"
            self.created.append({"thread": thread_id, "title": title, "prompt": prompt, "request_id": request_id})
            self.open[thread_id] = True
            self.by_request[request_id] = thread_id
        return self.by_request[request_id]

    def thread_send(self, thread_id, text, request_id):
        self.calls.append(("send", request_id))
        if "send" in self.fail:
            return False
        if request_id not in {item["request_id"] for item in self.sent}:
            self.sent.append({"thread": thread_id, "text": text, "request_id": request_id})
        return True

    def telegram(self, text, key):
        self.calls.append(("telegram", key))
        if self.telegram_text.setdefault(key, text) != text:
            raise AssertionError("Telegram retry changed its text for key " + key)
        if "telegram" in self.fail:
            return False
        if key not in {item["key"] for item in self.telegrams}:
            self.telegrams.append({"key": key, "text": text})
        return True


class Forbidden:
    """Any use is a test failure: for the paths that must not call anything."""

    def __getattr__(self, name):
        raise AssertionError("must not be used: " + name)

    def __call__(self, *args, **kwargs):
        raise AssertionError("must not be called")


class Sim:
    def __init__(self, case, configured=True):
        self.dir = Path(tempfile.mkdtemp(prefix="offbox-home-monitor-"))
        case.addCleanup(shutil.rmtree, self.dir, True)
        if configured:
            (self.dir / "server.json").write_text(json.dumps({"url": URL, "public_ip": "203.0.113.7",
                                                              "disabled": False}))
        self.now = 1_800_000_000.0
        self.fx = FakeEffects()
        self.checks = 0

    def tick(self, ok=True, error="timeout", health=None, mac=ONLINE, advance=60, dry_run=False, effects=None):
        self.now += advance

        def check(url):
            self.checks += 1
            assert url == URL
            return {"ok": ok, "error": "" if ok else error, "health": health or (GOOD if ok else {})}

        return hm.tick(self.dir, dry_run=dry_run, clock=lambda: self.now, check=check,
                       mac=lambda url: dict(mac), effects=effects or self.fx)

    def down(self):
        """One good check, then the two failures that mean down."""
        self.tick()
        self.tick(ok=False)
        return self.tick(ok=False)

    def up(self):
        for _ in range(hm.UP_AFTER):
            result = self.tick()
        return result

    def backend(self):
        return json.loads((self.dir / "backend-state.json").read_text())

    def state(self):
        return json.loads((self.dir / "home-monitor.json").read_text())

    def log(self):
        return (self.dir / "home-monitor.log").read_text()


class Base(unittest.TestCase):
    def setUp(self):
        home = Path(tempfile.mkdtemp(prefix="offbox-home-monitor-home-"))
        self.addCleanup(shutil.rmtree, home, True)
        self.home = home
        patcher = patch.object(hm, "HOME", home)
        patcher.start()
        self.addCleanup(patcher.stop)


class StateMachineTests(Base):
    def test_normal_up(self):
        sim = Sim(self)
        for _ in range(3):
            result = sim.tick()
        self.assertEqual((result["verdict"], result["state"], result["actions"]), ("good", "home_up", []))
        backend = sim.backend()
        self.assertEqual(set(backend), BACKEND_KEYS)
        self.assertEqual((backend["state"], backend["good_streak"], backend["bad_streak"]), ("home_up", 3, 0))
        self.assertEqual((backend["last_check"], backend["last_ok"]), (sim.now, sim.now))
        self.assertEqual((backend["reason"], backend["outage_id"], backend["degraded"]), ("", "", []))
        self.assertEqual(sim.fx.calls, [])
        self.assertFalse(list(sim.dir.glob("*.tmp.*")))

    def test_two_fails_in_a_row_mean_down_exactly_once(self):
        sim = Sim(self)
        sim.tick()
        first = sim.tick(ok=False)
        self.assertEqual((first["verdict"], first["state"], first["bad_streak"]), ("bad", "home_up", 1))
        self.assertEqual(sim.backend()["state"], "home_up")
        self.assertEqual(sim.fx.calls, [])
        second = sim.tick(ok=False, error="refused")
        self.assertEqual((second["state"], second["events"]), ("home_down", ["down"]))
        backend = sim.backend()
        self.assertEqual(set(backend), BACKEND_KEYS)
        self.assertEqual((backend["state"], backend["since"], backend["bad_streak"]), ("home_down", sim.now, 2))
        self.assertEqual(backend["reason"], "refused")
        self.assertEqual(backend["last_ok"], sim.now - 120)
        outage = backend["outage_id"]
        self.assertRegex(outage, r"^\d{8}T\d{6}Z$")
        for _ in range(5):
            sim.tick(ok=False)
        self.assertEqual(len(sim.fx.created), 1)
        self.assertEqual([item["key"] for item in sim.fx.telegrams], ["offbox-home:" + outage])
        self.assertEqual(sim.fx.sent, [])
        self.assertEqual(sim.backend()["outage_id"], outage)

        created = sim.fx.created[0]
        self.assertRegex(created["title"], r"^offbox home server down \(\d{4}-\d\d-\d\d \d\d:\d\d Dubai\)$")
        self.assertEqual(created["request_id"], f"offbox-home:{outage}:thread:1")
        prompt = created["prompt"]
        self.assertTrue(prompt.startswith(hm.PREFIX))
        for needle in ("/Volumes/ExternalSSD/t3code-fork/integrations/offbox/server/home/REPAIR-RUNBOOK.md",
                       "Outage id: " + outage, hm.stamp(sim.now - 360)[11:] + " timeout",
                       hm.stamp(sim.now - 300)[11:] + " refused", "boot_id boot-a", "uptime_s 86400",
                       "tailnet up (BackendState=Running Self.Online=true)", "internet reachable (1.1.1.1:443 ok)",
                       "listed, offline", "none reported", "WIPE-EVERYTHING", "zpool destroy", "Moni",
                       "REINSTALL-OS only with Abdullah's explicit OK", "never fast mode",
                       "home-incidents.md", URL + "/health"):
            self.assertIn(needle, prompt)
        telegram = sim.fx.telegrams[0]["text"]
        for needle in ("Home offbox is down", "Runs moved to Boat", "A repair agent is on it"):
            self.assertIn(needle, telegram)

    def test_one_fail_then_good_is_nothing(self):
        sim = Sim(self)
        sim.tick()
        sim.tick(ok=False)
        result = sim.tick()
        self.assertEqual((result["state"], result["bad_streak"], result["good_streak"]), ("home_up", 0, 1))
        sim.tick(ok=False)
        sim.tick()
        sim.tick(ok=False)
        self.assertEqual(sim.backend()["state"], "home_up")
        self.assertEqual(sim.fx.calls, [])
        self.assertIsNone(sim.state()["outage"])

    def test_mac_offline_is_never_down(self):
        for offline in (NO_TAILNET, NO_INTERNET):
            sim = Sim(self)
            sim.tick()
            checked = sim.backend()["last_check"]
            for _ in range(10):
                result = sim.tick(ok=False, mac=offline)
                self.assertEqual((result["verdict"], result["state"], result["bad_streak"]),
                                 ("indeterminate", "home_up", 0))
            # Not decisive: the client's file is untouched.
            self.assertEqual(sim.backend()["last_check"], checked)
            self.assertEqual(sim.fx.calls, [])
            self.assertIn("mac_offline", sim.log())
            # A failure seen offline also clears the streak: down needs two fresh ones with the Mac online.
            sim.tick(ok=False)
            sim.tick(ok=False, mac=offline)
            self.assertEqual(sim.tick(ok=False)["state"], "home_up")
            self.assertEqual(sim.tick(ok=False)["state"], "home_down")

    def test_mac_offline_does_not_extend_or_end_an_outage(self):
        sim = Sim(self)
        sim.down()
        before = sim.backend()
        sim.tick()
        sim.tick()
        result = sim.tick(ok=False, mac=NO_TAILNET)
        self.assertEqual((result["verdict"], result["state"], result["good_streak"]), ("indeterminate", "home_down", 0))
        self.assertEqual(sim.backend()["since"], before["since"])
        sim.tick()
        sim.tick()
        self.assertEqual(sim.tick()["state"], "home_up")

    def test_first_tick_and_wake_up_gap_do_not_count(self):
        sim = Sim(self)
        first = sim.tick(ok=False)
        self.assertEqual((first["verdict"], first["bad_streak"]), ("indeterminate", 0))
        self.assertFalse((sim.dir / "backend-state.json").exists())
        self.assertEqual(sim.tick(ok=False)["bad_streak"], 1)
        # Lid closed for eight hours with one failure on the books: the first check after it counts for nothing.
        woke = sim.tick(ok=False, advance=8 * 3600)
        self.assertEqual((woke["verdict"], woke["state"], woke["bad_streak"]), ("indeterminate", "home_up", 0))
        self.assertIn("warm-up", woke["events"][0])
        self.assertEqual(sim.tick(ok=False)["state"], "home_up")
        self.assertEqual(sim.tick(ok=False)["state"], "home_down")
        self.assertEqual(len(sim.fx.created), 1)
        # Just under the gap is an ordinary tick.
        sim2 = Sim(self)
        sim2.tick()
        sim2.tick(ok=False, advance=hm.GAP_S - 1)
        self.assertEqual(sim2.tick(ok=False, advance=hm.GAP_S - 1)["state"], "home_down")

    def test_checks_seconds_apart_count_once(self):
        # A manual run (or the installer's kickstart) right next to the scheduled one sees the same blip.
        sim = Sim(self)
        sim.tick()
        self.assertEqual(sim.tick(ok=False)["bad_streak"], 1)
        for _ in range(5):
            again = sim.tick(ok=False, advance=2)
            self.assertEqual((again["verdict"], again["state"], again["bad_streak"]), ("indeterminate", "home_up", 1))
        self.assertEqual(sim.fx.calls, [])
        self.assertEqual(sim.tick(ok=False, advance=50)["state"], "home_down")
        sim.tick(advance=60)
        for _ in range(5):
            self.assertEqual(sim.tick(advance=2)["good_streak"], 1)
        self.assertEqual(sim.backend()["state"], "home_down")
        sim.tick(advance=50)
        self.assertEqual(sim.tick()["state"], "home_up")

    def test_a_slow_tick_is_not_a_gap(self):
        sim = Sim(self)
        sim.tick()

        class Slow(FakeEffects):
            def create_thread(inner, title, prompt, request_id):
                sim.now += 140   # the sends of this tick took over two minutes
                return super().create_thread(title, prompt, request_id)

        sim.fx = Slow()
        sim.tick(ok=False)
        sim.tick(ok=False)
        self.assertEqual(sim.tick()["good_streak"], 1)
        self.assertEqual(sim.tick()["good_streak"], 2)

    def test_recovery_needs_exactly_three_good_checks_in_a_row(self):
        sim = Sim(self)
        sim.down()
        outage = sim.backend()["outage_id"]
        thread = sim.fx.created[0]["thread"]
        self.assertEqual(sim.tick()["state"], "home_down")
        self.assertEqual(sim.tick()["state"], "home_down")
        self.assertEqual(sim.tick(ok=False)["good_streak"], 0)   # two good then a bad: the count starts again
        self.assertEqual(sim.tick()["state"], "home_down")
        self.assertEqual(sim.tick()["state"], "home_down")
        self.assertEqual(sim.fx.sent, [])
        restarted = dict(GOOD, boot_id="boot-b", uptime_s=95)
        result = sim.tick(health=restarted)
        self.assertEqual((result["state"], result["events"], result["good_streak"]), ("home_up", ["up"], 3))
        backend = sim.backend()
        self.assertEqual((backend["state"], backend["since"], backend["reason"], backend["outage_id"]),
                         ("home_up", sim.now, "", ""))
        self.assertEqual(len(sim.fx.sent), 1)
        message = sim.fx.sent[0]
        self.assertEqual((message["thread"], message["request_id"]), (thread, f"offbox-home:{outage}:up:1"))
        for needle in ("answers again", outage, "boot_id boot-b", "uptime_s 95", "boot_id boot-a",
                       "boot_id changed", "home-incidents.md", "cause"):
            self.assertIn(needle, message["text"])
        for _ in range(4):
            sim.tick()
        self.assertEqual(len(sim.fx.sent), 1)
        self.assertEqual(len(sim.fx.telegrams), 1)   # none on recovery
        self.assertEqual(len(sim.fx.created), 1)

    def test_recovery_without_a_restart_says_so(self):
        sim = Sim(self)
        sim.down()
        sim.up()
        self.assertIn("boot_id is unchanged", sim.fx.sent[0]["text"])

    def test_flapping_inside_the_cool_down_is_one_thread_and_one_telegram(self):
        sim = Sim(self)
        sim.down()
        outage = sim.backend()["outage_id"]
        for flap in range(2, 6):
            sim.up()
            sim.tick(ok=False)
            self.assertEqual(sim.tick(ok=False)["state"], "home_down")
            self.assertEqual(sim.backend()["outage_id"], outage)
            self.assertEqual(sim.state()["outage"]["down_count"], flap)
        sim.up()
        self.assertEqual(len(sim.fx.created), 1)
        self.assertEqual([item["key"] for item in sim.fx.telegrams], ["offbox-home:" + outage])
        downs = [item for item in sim.fx.sent if ":down:" in item["request_id"]]
        ups = [item for item in sim.fx.sent if ":up:" in item["request_id"]]
        self.assertEqual([item["request_id"] for item in downs], [f"offbox-home:{outage}:down:{n}" for n in range(2, 6)])
        self.assertEqual(len(ups), 5)
        self.assertIn("same outage " + outage, downs[0]["text"])
        self.assertEqual({item["thread"] for item in sim.fx.sent}, {sim.fx.created[0]["thread"]})

    def test_cool_down_runs_from_the_last_recovery(self):
        sim = Sim(self)
        sim.down()
        outage = sim.backend()["outage_id"]
        sim.up()
        sim.tick(advance=hm.COOLDOWN_S - 200)   # still inside 30 minutes of the recovery
        sim.tick(ok=False)
        sim.tick(ok=False)
        self.assertEqual(sim.backend()["outage_id"], outage)
        self.assertEqual(len(sim.fx.telegrams), 1)

    def second_outage(self, sim):
        sim.down()
        first = sim.backend()["outage_id"]
        sim.up()
        sim.tick(advance=hm.COOLDOWN_S + 1)
        return first

    def test_second_outage_after_the_cool_down_reuses_an_open_thread_with_a_new_telegram(self):
        sim = Sim(self)
        first = self.second_outage(sim)
        sim.tick(ok=False)
        self.assertEqual(sim.tick(ok=False)["state"], "home_down")
        second = sim.backend()["outage_id"]
        self.assertNotEqual(first, second)
        self.assertEqual(len(sim.fx.created), 1)
        self.assertEqual([item["key"] for item in sim.fx.telegrams], ["offbox-home:" + first, "offbox-home:" + second])
        message = sim.fx.sent[-1]
        self.assertEqual((message["thread"], message["request_id"]),
                         (sim.fx.created[0]["thread"], f"offbox-home:{second}:down:1"))
        for needle in ("new outage " + second, "REPAIR-RUNBOOK.md", "Failed checks", "WIPE-EVERYTHING"):
            self.assertIn(needle, message["text"])

    def test_second_outage_with_the_thread_archived_starts_a_new_thread(self):
        for gone in (False, "missing"):
            sim = Sim(self)
            self.second_outage(sim)
            old = sim.fx.created[0]["thread"]
            if gone == "missing":
                del sim.fx.open[old]
            else:
                sim.fx.open[old] = False
            sim.tick(ok=False)
            sim.tick(ok=False)
            self.assertEqual(len(sim.fx.created), 2)
            self.assertNotEqual(sim.fx.created[1]["thread"], old)
            self.assertEqual(len(sim.fx.telegrams), 2)
            self.assertFalse([item for item in sim.fx.sent if ":down:" in item["request_id"]])
            sim.up()
            self.assertEqual(sim.fx.sent[-1]["thread"], sim.fx.created[1]["thread"])

    def test_archived_thread_during_a_flap_gets_a_new_thread_but_no_new_telegram(self):
        sim = Sim(self)
        sim.down()
        sim.up()
        sim.fx.open[sim.fx.created[0]["thread"]] = False
        sim.tick(ok=False)
        sim.tick(ok=False)
        self.assertEqual(len(sim.fx.created), 2)
        self.assertTrue(sim.fx.created[1]["request_id"].endswith(":thread:2"))
        self.assertEqual(len(sim.fx.telegrams), 1)

    def test_unknown_thread_state_waits_instead_of_guessing(self):
        sim = Sim(self)
        self.second_outage(sim)
        sim.fx.open[sim.fx.created[0]["thread"]] = None   # the control API did not answer
        sim.tick(ok=False)
        sim.tick(ok=False)
        self.assertEqual(len(sim.fx.created), 1)
        self.assertFalse([item for item in sim.fx.sent if ":down:" in item["request_id"]])
        sim.fx.open[sim.fx.created[0]["thread"]] = True
        sim.tick(ok=False)
        self.assertEqual(len([item for item in sim.fx.sent if ":down:" in item["request_id"]]), 1)

    def test_degraded_but_serving(self):
        sim = Sim(self)
        degraded = dict(GOOD, mode="degraded", reasons=["pool DEGRADED", "mdraid degraded"])
        for _ in range(5):
            result = sim.tick(health=degraded)
        self.assertEqual((result["verdict"], result["state"]), ("good", "home_up"))
        self.assertEqual(sim.backend()["degraded"], ["pool DEGRADED", "mdraid degraded"])
        self.assertEqual(sim.backend()["state"], "home_up")
        self.assertEqual(len(sim.fx.telegrams), 1)
        self.assertIn("up but degraded: pool DEGRADED; mdraid degraded", sim.fx.telegrams[0]["text"])
        self.assertTrue(sim.fx.telegrams[0]["key"].startswith("offbox-home-degraded:"))
        self.assertEqual(sim.fx.created, [])
        # The same reasons in another order are the same set.
        sim.tick(health=dict(degraded, reasons=["mdraid degraded", "pool DEGRADED"]))
        self.assertEqual(len(sim.fx.telegrams), 1)
        sim.tick(health=dict(degraded, reasons=["pool DEGRADED"]))
        self.assertEqual(len(sim.fx.telegrams), 2)
        sim.tick()
        self.assertEqual(sim.backend()["degraded"], [])
        sim.tick(health=degraded)
        self.assertEqual(len(sim.fx.telegrams), 2)   # seen today already
        sim.tick(advance=hm.DEGRADED_REALERT_S)
        sim.tick(health=degraded)
        self.assertEqual(len(sim.fx.telegrams), 3)
        self.assertEqual(len({item["key"] for item in sim.fx.telegrams}), 3)

    def test_degraded_telegram_is_retried_with_the_same_key_and_text(self):
        sim = Sim(self)
        sim.fx.fail.add("telegram")
        degraded = dict(GOOD, mode="degraded", reasons=["pool DEGRADED"])
        sim.tick(health=degraded)
        sim.tick(health=degraded)
        sim.fx.fail.clear()
        sim.tick(health=degraded)
        sim.tick(health=degraded)
        self.assertEqual(len(sim.fx.telegrams), 1)
        self.assertEqual(len([call for call in sim.fx.calls if call[0] == "telegram"]), 3)

    def test_failed_sends_stay_owed(self):
        sim = Sim(self)
        sim.fx.fail.update({"create", "telegram"})
        sim.down()
        sim.tick(ok=False)
        self.assertEqual((sim.fx.created, sim.fx.telegrams), ([], []))
        sim.fx.fail.discard("telegram")
        sim.tick(ok=False)
        # Honest text when the agent could not be started; it stays the text for this key.
        self.assertIn("could not be started yet", sim.fx.telegrams[0]["text"])
        sim.fx.fail.clear()
        sim.tick(ok=False)
        sim.tick(ok=False)
        self.assertEqual(len(sim.fx.created), 1)
        self.assertEqual(len(sim.fx.telegrams), 1)
        self.assertEqual({call[1] for call in sim.fx.calls if call[0] == "create"},
                         {sim.fx.created[0]["request_id"]})

    def test_recovery_with_no_thread_has_nobody_to_tell(self):
        sim = Sim(self)
        sim.fx.fail.add("create")
        sim.down()
        sim.up()
        sim.fx.fail.clear()   # the box is back: no agent is started after the fact
        sim.tick()
        sim.tick()
        self.assertEqual((sim.fx.created, sim.fx.sent), ([], []))

    def test_dry_run_records_state_and_sends_nothing(self):
        sim = Sim(self)
        sim.tick(dry_run=True, effects=Forbidden())
        sim.tick(ok=False, dry_run=True, effects=Forbidden())
        result = sim.tick(ok=False, dry_run=True, effects=Forbidden())
        self.assertTrue(result["dry_run"])
        self.assertEqual(result["state"], "home_down")
        self.assertEqual(sim.backend()["state"], "home_down")
        actions = {action["action"]: action for action in result["actions"]}
        self.assertEqual(set(actions), {"repair-thread", "telegram-down"})
        self.assertEqual(actions["repair-thread"]["would"], "create")
        self.assertEqual(actions["repair-thread"]["model"], "claudeAgent:claude-fable-5-2")
        self.assertEqual(actions["telegram-down"]["key"], "offbox-home:" + result["outage_id"])
        degraded = sim.tick(health=dict(GOOD, mode="degraded", reasons=["pool DEGRADED"]), dry_run=True,
                            effects=Forbidden())
        self.assertIn("telegram-degraded", [action["action"] for action in degraded["actions"]])
        # Nothing was marked done: the first real tick of the same outage does it.
        sim.tick(ok=False)
        self.assertEqual((len(sim.fx.created), len(sim.fx.telegrams)), (1, 1))

    def test_client_failures_reach_the_agent_but_never_mark_down(self):
        sim = Sim(self)
        path = sim.dir / "home-failures.jsonl"
        sim.tick()
        lines = [json.dumps({"ts": sim.now + 5 + n, "reason": "connect timeout", "run": f"r{n}"}) for n in range(30)]
        path.write_text("\n".join(lines + ["not json", json.dumps({"ts": "x"}), json.dumps([1])]) + "\n")
        for _ in range(5):
            self.assertEqual(sim.tick()["state"], "home_up")
        self.assertEqual(sim.fx.calls, [])
        with path.open("a") as output:
            output.write(json.dumps({"ts": sim.now + 1, "reason": "refused\x1b[31m", "run": ""}) + "\n")
        sim.tick(ok=False)
        sim.tick(ok=False)
        prompt = sim.fx.created[0]["prompt"]
        self.assertIn("connect timeout (run r29)", prompt)
        self.assertIn("refused?[31m", prompt)
        self.assertNotIn("\x1b", prompt)
        self.assertEqual(len(sim.state()["client_failures"]), 20)

    def test_client_failure_file_is_trimmed(self):
        sim = Sim(self)
        path = sim.dir / "home-failures.jsonl"
        path.write_text("".join(json.dumps({"ts": sim.now - 5000 + n, "reason": "x", "run": ""}) + "\n"
                                for n in range(450)))
        sim.tick()
        kept = path.read_text().splitlines()
        self.assertEqual(len(kept), 200)
        self.assertEqual(json.loads(kept[-1])["ts"], sim.now - 60 - 5000 + 449)

    def test_log_names_events_only(self):
        sim = Sim(self)
        sim.down()
        sim.up()
        log = sim.log()
        for needle in ("check-fail class=timeout verdict=bad bad_streak=1", "state=home_down outage=",
                       "action=thread-create ok=True", "action=telegram-down ok=True", "state=home_up",
                       "action=thread-send-up ok=True"):
            self.assertIn(needle, log)
        self.assertNotIn("Rules in short", log)
        # Steady good checks are not logged.
        size = len(log)
        for _ in range(5):
            sim.tick()
        self.assertEqual(len(sim.log()), size)

    def test_step_is_pure(self):
        state = hm.fresh_state(1000.0)
        obs = {"check": {"ok": False, "error": "timeout", "health": {}}, "mac": ONLINE, "client_failures": []}
        with patch.object(hm, "write_json", Forbidden()), patch.object(hm, "log", Forbidden()), \
                patch.object(hm, "ctl", Forbidden()), patch.object(hm, "_run", Forbidden()), \
                patch.object(hm.urllib.request, "urlopen", Forbidden()):
            self.assertEqual(hm.step(state, obs, 1000.0), ("indeterminate", ["skipped: warm-up after a gap"]))
            self.assertEqual(hm.step(state, obs, 1060.0), ("bad", []))
            self.assertEqual(hm.step(state, obs, 1120.0), ("bad", ["down"]))
        self.assertEqual(hm.backend_view(state)["state"], "home_down")


class InertTests(Base):
    def unconfigured(self, sdir):
        before = sorted((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in sdir.iterdir()) if sdir.exists() else None
        with patch.object(hm, "ctl", Forbidden()), patch.object(hm, "_run", Forbidden()), \
                patch.object(hm.socket, "create_connection", Forbidden()), \
                patch.object(hm.urllib.request, "build_opener", Forbidden()), \
                patch.object(hm.urllib.request, "urlopen", Forbidden()):
            result = hm.tick(sdir)   # the real probes and senders: none may be reached
        self.assertEqual(result, {"configured": False})
        after = sorted((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in sdir.iterdir()) if sdir.exists() else None
        self.assertEqual(before, after)

    def test_unconfigured_does_nothing_at_all(self):
        missing = Path(tempfile.mkdtemp(prefix="offbox-home-monitor-")) / "never-created"
        self.addCleanup(shutil.rmtree, missing.parent, True)
        self.unconfigured(missing)
        self.assertFalse(missing.exists())
        for content in (None, "", "{not json", "[]", json.dumps({"public_ip": "203.0.113.7"}),
                        json.dumps({"url": URL, "disabled": True}), json.dumps({"url": ""}),
                        json.dumps({"url": 5}), json.dumps({"url": "ftp://box/api"})):
            sim = Sim(self, configured=False)
            if content is not None:
                (sim.dir / "server.json").write_text(content)
            # A state left over from an earlier, configured time is not touched either.
            (sim.dir / "backend-state.json").write_text(json.dumps({"state": "home_down"}))
            self.unconfigured(sim.dir)
            self.assertEqual(sorted(p.name for p in sim.dir.iterdir()),
                             sorted(["backend-state.json"] + (["server.json"] if content is not None else [])))

    def test_unconfigured_process_exits_zero_silently(self):
        sim = Sim(self, configured=False)
        target = sim.dir / "state"
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "OFFBOX_STATE_DIR": str(target)}
        for args in (["tick"], ["tick", "--dry-run"]):
            result = subprocess.run([sys.executable, str(SCRIPTS / "home_monitor.py"), *args], env=env,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual((result.returncode, result.stderr), (0, ""))
            self.assertFalse(target.exists())
            self.assertEqual(list(self.home.iterdir()), [])
        status = subprocess.run([sys.executable, str(SCRIPTS / "home_monitor.py"), "status"], env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(status.returncode, 0)
        self.assertFalse(json.loads(status.stdout)["configured"])
        self.assertFalse(target.exists())

    def test_lock_held_exits_at_once(self):
        sim = Sim(self)
        with (sim.dir / "home-monitor.lock").open("a+") as holder:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            result = hm.tick(sim.dir, check=Forbidden(), mac=Forbidden(), effects=Forbidden())
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(result, {"configured": True, "skipped": "another tick holds the lock"})
            self.assertEqual(sorted(p.name for p in sim.dir.iterdir()), ["home-monitor.lock", "server.json"])
        self.assertEqual(sim.tick()["verdict"], "good")   # released: the next tick runs


class Recorder(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        self.server.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                                 "body": body})
        status, payload = self.server.route(self.command, self.path, body)
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = _answer


def serve(case, route):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    server.seen, server.route = [], route
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    case.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(5)))
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class HttpTests(Base):
    def test_health_check_against_a_real_socket(self):
        answers = {}
        server, base = serve(self, lambda method, path, body: answers["next"])
        url = base + "/api/v1"
        full = {"ok": True, "up": True, "mode": "ok", "reasons": [], "pool": {"name": "offbox", "state": "ONLINE"},
                "mdraid": {"state": "ok"}, "queue": 0, "running": 2, "boot_id": "b-1", "uptime_s": 123,
                "boatd_uptime_s": 45, "version": "0.3"}
        answers["next"] = (200, full)
        result = hm.check_health(url)
        self.assertEqual((result["ok"], result["error"]), (True, ""))
        self.assertEqual(result["health"], {"mode": "ok", "reasons": [], "pool": "ONLINE", "mdraid": "ok",
                                            "boot_id": "b-1", "version": "0.3", "uptime_s": 123,
                                            "boatd_uptime_s": 45})
        del full["boatd_uptime_s"]   # not in the contract: fine without it
        self.assertIsNone(hm.check_health(url)["health"]["boatd_uptime_s"])
        seen = server.seen[-1]
        self.assertEqual((seen["method"], seen["path"]), ("GET", "/api/v1/health"))
        self.assertNotIn("authorization", {name.lower() for name in seen["headers"]})

        answers["next"] = (200, dict(full, mode="degraded", reasons=["pool DEGRADED"]))
        self.assertEqual(hm.check_health(url)["health"]["reasons"], ["pool DEGRADED"])
        answers["next"] = (200, dict(full, ok=False, mode="degraded", reasons=["pool offbox is not imported\x00"],
                                     pool={"name": "offbox", "state": "MISSING"}))
        missing = hm.check_health(url)
        self.assertEqual((missing["ok"], missing["error"], missing["health"]["pool"]), (False, "not_ok", "MISSING"))
        self.assertEqual(hm.failure_text(missing), "health ok=false: pool offbox is not imported?")
        for answer, error in (((200, dict(full, ok="yes")), "not_ok"), ((200, [1]), "bad_json"),
                              ((200, b"<html>"), "bad_json"), ((500, {"ok": True}), "http_500"),
                              ((404, {}), "http_404")):
            answers["next"] = answer
            self.assertEqual((hm.check_health(url)["ok"], hm.check_health(url)["error"]), (False, error))

    def test_health_check_transport_failures(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        self.assertEqual(hm.check_health(f"http://127.0.0.1:{port}/api/v1")["error"], "refused")
        silent = socket.socket()
        silent.bind(("127.0.0.1", 0))
        silent.listen(1)
        self.addCleanup(silent.close)
        with patch.object(hm, "HEALTH_TIMEOUT_S", 0.3):
            started = time.monotonic()
            result = hm.check_health(f"http://127.0.0.1:{silent.getsockname()[1]}/api/v1")
        self.assertEqual((result["ok"], result["error"]), (False, "timeout"))
        self.assertLess(time.monotonic() - started, 3)

    def control(self, route):
        server, base = serve(self, route)
        credential = self.home / ".robob/components/offbox.json"
        credential.parent.mkdir(parents=True)
        credential.write_text(json.dumps({"url": base, "token": "SECRET-TOKEN-VALUE"}))
        credential.chmod(0o600)
        return server, credential

    def test_repair_thread_goes_through_the_control_api(self):
        threads = {}

        def route(method, path, body):
            if (method, path) == ("POST", "/api/ardud/control/threads"):
                thread_id = "ardud-control:thread:" + body["clientRequestId"].replace(":", "%3A")
                threads[thread_id] = {"archived": False}
                return 201, {"ok": True, "threadId": thread_id}
            for thread_id, thread in threads.items():
                quoted = "/api/ardud/control/threads/" + hm.urllib.parse.quote(thread_id, safe="")
                if (method, path) == ("GET", quoted):
                    return 200, {"ok": True, "thread": {"threadId": thread_id, "archived": thread["archived"]}}
                if (method, path) == ("POST", quoted + "/send"):
                    return 200, {"ok": True, "delivery": "steered"}
            return 404, {"ok": False, "error": {"code": "not_found"}}

        server, credential = self.control(route)
        fx = hm.Effects()
        thread_id = fx.create_thread("offbox home server down (2026-11-12 14:05 Dubai)", "PROMPT",
                                     "offbox-home:20261112T100500Z:thread:1")
        self.assertEqual(thread_id, "ardud-control:thread:offbox-home%3A20261112T100500Z%3Athread%3A1")
        created = server.seen[-1]
        self.assertEqual(created["headers"]["Authorization"], "Bearer SECRET-TOKEN-VALUE")
        self.assertEqual(created["body"], {
            "prompt": "PROMPT", "title": "offbox home server down (2026-11-12 14:05 Dubai)",
            "directory": "/Volumes/ExternalSSD/t3code-fork", "origin": "automation", "runtimeMode": "full-access",
            "clientRequestId": "offbox-home:20261112T100500Z:thread:1",
            "providerInstanceId": "claudeAgent", "model": "claude-fable-5-2",
            "options": [{"id": "effort", "value": "high"}]})
        self.assertNotIn("fastMode", json.dumps(created["body"]))
        self.assertIs(fx.thread_open(thread_id), True)
        self.assertNotIn(":", server.seen[-1]["path"].split("/threads/")[1])   # the id is percent-encoded
        self.assertTrue(fx.thread_send(thread_id, "hello", "offbox-home:x:up:1"))
        self.assertEqual(server.seen[-1]["body"], {"text": "hello", "mode": "auto",
                                                   "clientRequestId": "offbox-home:x:up:1"})
        threads[thread_id]["archived"] = True
        self.assertIs(fx.thread_open(thread_id), False)
        self.assertIs(fx.thread_open("no-such-thread"), False)
        self.assertFalse(fx.thread_send("no-such-thread", "x", "r"))
        # A credential other users can read is refused, and "could not tell" is not "archived".
        credential.chmod(0o644)
        self.assertIsNone(fx.thread_open(thread_id))
        self.assertIsNone(fx.create_thread("t", "p", "r"))
        credential.chmod(0o600)
        server.shutdown()
        server.server_close()
        self.assertIsNone(fx.thread_open(thread_id))

    def test_model_override_forms(self):
        with patch.object(hm, "REPAIR_MODEL", "opencode:opus/cc/claude-fable-5-1"), patch.object(hm, "REPAIR_EFFORT", "max"):
            self.assertEqual(hm.model_selection(), {"providerInstanceId": "opencode", "model": "opus/cc/claude-fable-5-1",
                                                    "options": [{"id": "effort", "value": "max"}]})
        with patch.object(hm, "REPAIR_MODEL", "opus/claude-opus-5-5"):
            self.assertEqual(hm.model_selection(), {"model": "opus/claude-opus-5-5", "variant": "high"})

    def test_whole_outage_with_the_real_senders_leaks_no_token(self):
        def route(method, path, body):
            if method == "POST" and path.endswith("/threads"):
                return 201, {"ok": True, "threadId": "thread-1"}
            if method == "GET":
                return 200, {"ok": True, "thread": {"archived": False}}
            return 200, {"ok": True}

        server, _ = self.control(route)
        health, base = serve(self, lambda method, path, body: (503, {"ok": False, "detail": "BODY-TEXT"}))

        class NoTelegram(hm.Effects):
            sent = []

            def telegram(self, text, key):
                self.sent.append(key)
                return True

        sim = Sim(self)
        (sim.dir / "server.json").write_text(json.dumps({"url": base + "/api/v1"}))
        clock = [1_800_000_000.0]

        def tick():
            clock[0] += 60
            return hm.tick(sim.dir, clock=lambda: clock[0], mac=lambda url: dict(ONLINE), effects=NoTelegram())

        self.assertEqual(tick()["verdict"], "indeterminate")
        self.assertEqual(tick()["check"], {"ok": False, "error": "http_503"})
        self.assertEqual(tick()["state"], "home_down")
        self.assertEqual(len(NoTelegram.sent), 1)
        self.assertEqual([item["path"] for item in server.seen], ["/api/ardud/control/threads"])
        self.assertEqual(sim.state()["outage"]["thread_id"], "thread-1")
        for path in sim.dir.iterdir():
            text = path.read_text()
            self.assertNotIn("SECRET-TOKEN-VALUE", text, path.name)
            self.assertNotIn("BODY-TEXT", text, path.name)
        self.assertFalse(any("authorization" in {name.lower() for name in item["headers"]} for item in health.seen))


class MacProbeTests(Base):
    def test_tailnet_facts(self):
        cli = self.home / "tailscale"
        cli.write_text("#!/bin/sh\ncat \"$0.json\"\n")
        cli.chmod(0o755)
        status = {"BackendState": "Running", "Self": {"Online": True}, "Peer": {
            "k1": {"HostName": "other", "DNSName": "other.ts.net.", "TailscaleIPs": ["100.64.0.2"], "Online": True},
            "k2": {"HostName": "offbox-server", "DNSName": "offbox-server.ts.net.", "TailscaleIPs": ["100.64.0.9"],
                   "Online": False, "LastSeen": "2026-11-12T10:00:00Z"}}}
        with patch.dict(os.environ, {"OFFBOX_TAILSCALE": str(cli)}), patch.object(hm, "TAILSCALE_PATHS", ()):
            Path(str(cli) + ".json").write_text(json.dumps(status))
            facts = hm.tailnet_facts(URL)
            self.assertEqual((facts["up"], facts["detail"]), (True, "BackendState=Running Self.Online=true"))
            self.assertEqual(facts["peer"], "listed, offline (last seen 2026-11-12T10:00:00Z)")
            for change in ({"BackendState": "Stopped"}, {"Self": {"Online": False}}, {"Self": None}):
                Path(str(cli) + ".json").write_text(json.dumps(dict(status, **change)))
                self.assertFalse(hm.tailnet_facts(URL)["up"])
            Path(str(cli) + ".json").write_text("not json")
            self.assertEqual(hm.tailnet_facts(URL), {"up": False, "peer": "unknown",
                                                    "detail": "tailscale CLI gave no status"})
        with patch.dict(os.environ, {"OFFBOX_TAILSCALE": ""}), patch.object(hm, "TAILSCALE_PATHS", ("/nonexistent/ts",)):
            self.assertEqual(hm.tailnet_facts(URL)["detail"], "tailscale CLI not found")

    def test_internet_needs_one_probe_and_the_mac_needs_both_facts(self):
        calls = []

        def connect(address, timeout):
            calls.append((address, timeout))
            if address[0] == "1.1.1.1":
                raise TimeoutError("timed out")
            return socket.socket()

        with patch.object(hm.socket, "create_connection", connect):
            self.assertEqual(hm.internet_facts(), {"ok": True, "detail": "8.8.8.8:443 ok"})
        self.assertEqual(calls, [(("1.1.1.1", 443), 3), (("8.8.8.8", 443), 3)])
        with patch.object(hm.socket, "create_connection", side_effect=ConnectionRefusedError()):
            self.assertEqual(hm.internet_facts(), {"ok": False, "detail": "1.1.1.1:443 refused; 8.8.8.8:443 refused"})
        up, down = {"up": True, "peer": "p", "detail": "d"}, {"up": False, "peer": "p", "detail": "d"}
        yes, no = {"ok": True, "detail": "i"}, {"ok": False, "detail": "i"}
        for tailnet, internet, online in ((up, yes, True), (down, yes, False), (up, no, False), (down, no, False)):
            with patch.object(hm, "tailnet_facts", return_value=tailnet), \
                    patch.object(hm, "internet_facts", return_value=internet):
                self.assertEqual(hm.mac_online(URL)["online"], online)


class InstallTests(unittest.TestCase):
    def test_launch_agent_is_a_one_shot_every_minute(self):
        with (OFFBOX / "launchd/com.ardud.offbox-home-monitor.plist").open("rb") as source:
            plist = plistlib.load(source)
        self.assertEqual(plist["Label"], "com.ardud.offbox-home-monitor")
        self.assertEqual(plist["ProgramArguments"],
                         ["/Users/ardud/.config/opencode/skills/remote-compute/scripts/home_monitor.py", "tick"])
        self.assertEqual((plist["StartInterval"], plist["RunAtLoad"]), (60, True))
        self.assertNotIn("KeepAlive", plist)
        self.assertNotIn("OFFBOX_HOME_MONITOR_DRY_RUN", plist.get("EnvironmentVariables", {}))
        self.assertTrue(os.access(SCRIPTS / "home_monitor.py", os.X_OK))
        self.assertTrue((SCRIPTS / "home_monitor.py").read_text().startswith("#!/opt/homebrew/bin/python3\n"))

    def test_installer_and_docs_know_the_agent(self):
        install = (OFFBOX / "install.zsh").read_text()
        self.assertIn("com.ardud.offbox-home-monitor", install)
        self.assertIn("com.ardud.offbox-monitor", install)
        runbook = (OFFBOX / "server/home/REPAIR-RUNBOOK.md").read_text()
        self.assertEqual(hm.RUNBOOK, "/Volumes/ExternalSSD/t3code-fork/integrations/offbox/server/home/REPAIR-RUNBOOK.md")
        for needle in ("WIPE-EVERYTHING", "zpool destroy", "home-incidents.md", "OFFBOX_KVM_URL", "offbox-status"):
            self.assertIn(needle, runbook)
        self.assertIn("com.ardud.offbox-home-monitor", (OFFBOX / "README.md").read_text())


if __name__ == "__main__":
    unittest.main()
