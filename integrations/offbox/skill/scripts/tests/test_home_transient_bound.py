"""Alternating startup and timeout replies cannot renew the overall transient wait forever."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import home
import home_monitor as hm
from test_home_backend import HomeFiles
from test_home_monitor import Sim, ONLINE
from test_wait_lock import Clock


class TransientEpisodeBound(HomeFiles):
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
