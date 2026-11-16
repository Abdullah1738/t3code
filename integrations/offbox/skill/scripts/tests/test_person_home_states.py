"""Person work stays on home across every monitor state, including live slow/startup probes."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, home
from test_home_backend import HomeFiles
from test_wait_lock import Clock


class PersonHomeStates(HomeFiles):
    def test_wait_state_keeps_person_pinned_and_boat_read_contracts(self):
        self.configure()
        cases = [(f"person/{state}", {"OFFBOX_THREAD": "person:moni"}, state)
                 for state in ("home_up", "home_slow", "home_starting", "home_down")]
        cases += [("pinned", {"OFFBOX_BACKEND": "server"}, "home_down"),
                  ("boat", {"OFFBOX_BACKEND": "boat"}, "home_down")]
        for label, env, state in cases:
            with self.subTest(case=label), patch.dict(os.environ, env), \
                    patch.object(common, "_BACKEND", None), \
                    patch.object(api, "get", return_value={"state": "running"}) as read, \
                    patch.object(home, "recover_slow_read", side_effect=AssertionError("no home-routing recovery")):
                self.monitor_says(state)
                self.assertFalse(home.may_fail_over())
                self.assertEqual(api.wait_state("selected", api.LIVE_STATES), {"state": "running"})
                read.assert_called_once_with("selected")
                if label.startswith("person/"):
                    self.assertEqual(common.backend(), "server")

    def test_person_never_selects_boat_in_up_slow_starting_or_down(self):
        self.configure()
        ready = {"ok": True}
        starting = {"ok": False, "starting": True, "phase": "reconcile"}
        cases = [("home_up", [ready], False, None),
                 ("home_slow", ["no answer (TimeoutError)"] * 3 + [ready], True, None),
                 ("home_starting", [starting, starting, ready], True, None),
                 ("home_down", ["no answer (TimeoutError)"], False, 93)]
        with patch.dict(os.environ, OFFBOX_THREAD="person:moni"), \
                patch.object(os, "execve", side_effect=AssertionError("person run must never move to Boat")), \
                patch.object(home, "say"):
            for state, replies, tcp, exit_code in cases:
                clock = Clock()
                self.monitor_says(state)
                with self.subTest(state=state), patch.object(home, "_health", side_effect=replies), \
                        patch.object(home, "tcp_connects", return_value=tcp), \
                        patch.object(home.time, "monotonic", clock.now), patch.object(home.time, "sleep", clock.sleep):
                    self.assertEqual(common.default_backend(), "server")
                    self.assertEqual(common.entry_backend(["run", "--no-fallback", "--", "true"]), "server")
                    self.assertFalse(home.may_fail_over())
                    if exit_code:
                        with self.assertRaises(common.OffboxError) as error:
                            home.person_gate()
                        self.assertEqual(error.exception.code, exit_code)
                    else:
                        home.person_gate()
                    with self.assertRaises(common.OffboxError) as error:
                        home.fail_over("fixture outage", ["run", "--", "true"])
                    self.assertEqual(error.exception.code, common.EXIT_HOME_DOWN)
                    self.assertEqual(common.backend(), "server")
        self.assertFalse(common.HOME_FAILURES.exists(), "person waiting is never recorded as a Boat handoff")


if __name__ == "__main__":
    unittest.main()
