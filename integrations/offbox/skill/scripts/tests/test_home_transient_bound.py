"""Alternating startup and timeout replies cannot renew the overall transient wait forever."""
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import allocation, home, outage
import home_monitor as hm
from test_home_backend import HomeFiles
from test_home_monitor import Sim, ONLINE
from test_wait_lock import Clock


class TransientEpisodeBound(HomeFiles):
    def test_healthy_queue_time_pauses_the_transient_episode(self):
        self.configure()
        starting = {"ok": False, "starting": True, "phase": "reconcile"}
        for accounting in ("idle", "progress"):
            for initial in ("slow", "reconcile"):
                clock = Clock()
                def read(timeout):
                    return starting if int((clock.t - 1900) / 5) % 2 else "no answer (TimeoutError)"
                with self.subTest(accounting=accounting, initial=initial), home.wait_budget(), \
                        patch.object(outage.time, "monotonic", clock.now), \
                        patch.object(home, "tcp_connects", return_value=True), patch.object(home, "say"), \
                        outage.allocation_budget(600):
                    home.begin_transient(clock.now)
                    home.wait_deadline(600, clock=clock.now)
                    if accounting == "idle":
                        with outage.queue_idle():
                            clock.sleep(900)
                    else:
                        clock.sleep(900)
                        outage.queue_progress()
                    self.assertEqual(home.WAIT_BUDGET.get()["transient_since"], 1900)
                    reason = home.wait_while_starting(initial, clock=clock.now, sleep=clock.sleep, read=read)
                    self.assertIsNotNone(reason)
                    self.assertEqual(clock.t, 2500, "only healthy queue time is excluded; alternation stays bounded")

    def test_each_slow_startup_transition_keeps_the_original_queue_deadline(self):
        self.configure()
        starting = {"ok": False, "starting": True, "phase": "reconcile"}
        for initial in ("slow", "reconcile"):
            clock = Clock()
            def read(timeout):
                return starting if int((clock.t - 1000) / 5) % 2 else "no answer (TimeoutError)"
            with self.subTest(initial=initial), patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="40"), \
                    patch.object(outage.time, "monotonic", clock.now), \
                    patch.object(home, "tcp_connects", return_value=True), patch.object(home, "say"), \
                    allocation.queue() as queue:
                clock.sleep(15)
                reason = home.wait_while_starting(initial, clock=clock.now, sleep=clock.sleep, read=read)
                self.assertEqual(queue["end"], 1040)
                self.assertIsNotNone(reason)
                self.assertEqual(clock.t, 1040)

    def test_failed_pass_time_is_spent_and_answer_timestamps_stay_real(self):
        self.configure()
        clock = Clock()
        with home.wait_budget(), patch.object(outage.time, "monotonic", clock.now), \
                outage.allocation_budget(600):
            home.begin_transient(clock.now)
            home.wait_deadline(600, clock=clock.now)
            budget = home.WAIT_BUDGET.get()
            budget.update(last_answer=995, slow_anchor=995, slow_end=1295)
            clock.sleep(6)
            outage.queue_api_failed()
            outage.queue_progress()
            self.assertEqual((budget["end"], budget["transient_since"]), (1600, 1000))
            clock.sleep(10)
            outage.queue_progress()
            self.assertEqual((budget["end"], budget["transient_since"]), (1610, 1010))
            self.assertEqual(outage.allocation_left(), 594)
            self.assertEqual((budget["last_answer"], budget["slow_anchor"], budget["slow_end"]), (995, 995, 1295))

    def test_client_alternation_is_bounded_from_first_slow_failure(self):
        self.configure()
        starting = {"ok": False, "starting": True, "phase": "reconcile"}
        for initial in ("slow", "reconcile"):
            clock = Clock()
            def read(timeout):
                return starting if int((clock.t - 1000) / 5) % 2 else "no answer (TimeoutError)"
            with self.subTest(initial=initial), patch.object(home, "tcp_connects", return_value=True), \
                    patch.object(home, "say"):
                reason = home.wait_while_starting(initial, clock=clock.now, sleep=clock.sleep, read=read)
            self.assertIsNotNone(reason)
            self.assertLessEqual(clock.t, 1600, "startup replies must not move the original 600 s deadline")

    def test_monitor_alternation_reaches_down_once_at_overall_starting_bound(self):
        for first in ("starting", "slow"):
            sim = Sim(self)
            sim.tick()
            with self.subTest(first=first):
                for index in range(11):
                    mode = first if index % 2 == 0 else ("slow" if first == "starting" else "starting")
                    if mode == "starting":
                        result = sim.tick(ok=False, health={"starting": True, "phase": "reconcile"})
                    else:
                        sim.now += 60
                        result = hm.tick(sim.dir, clock=lambda: sim.now, effects=sim.fx,
                                         check=lambda u: dict(ok=False, error="timeout", health={}),
                                         retry=lambda u: dict(ok=False, error="timeout", health={}),
                                         mac=lambda u: dict(ONLINE, peer_online=True), tcp=lambda u: True)
                    if index < 10:
                        self.assertEqual(sim.fx.calls, [])
                self.assertEqual(result["state"], "home_down")
                self.assertEqual(len(sim.fx.created), 1)
                self.assertEqual(len(sim.fx.telegrams), 1)


class RecoveredEpisodeBound(HomeFiles):
    def test_ready_health_then_auth_timeout_starts_a_new_episode(self):
        from offbox_lib import api, common
        self.configure()
        common.select_backend("server")
        clock = Clock()
        starting = {"ok": False, "starting": True, "phase": "reconcile"}
        seen = []
        def recovered_probe():
            home.begin_transient(clock.now)
            clock.sleep(263)
            home.note_home_answer(clock.now)
            return None
        def auth(backend, timeout):
            seen.append(clock.t)
            if len(seen) <= 2:
                clock.sleep(timeout)
                return "authenticated API timed out"
            return home.wait_while_starting("reconcile", clock=clock.now, sleep=clock.sleep,
                                            read=lambda timeout: starting)
        with home.wait_budget(), patch.object(home, "probe", side_effect=recovered_probe), \
                patch.object(home, "tcp_connects", return_value=True), patch.object(home, "say"), \
                patch.object(home.time, "monotonic", clock.now), patch.object(home.time, "sleep", clock.sleep), \
                patch.object(api, "probe_backend", side_effect=auth):
            with self.assertRaises(home.StartWaitFailed):
                home.preflight_reason()
        self.assertEqual(seen[0], 1263)
        self.assertGreaterEqual(clock.t, 1863, "a true recovery must not revive the old t=1000 episode")
        self.assertLessEqual(clock.t, 1868)


if __name__ == "__main__":
    unittest.main()
