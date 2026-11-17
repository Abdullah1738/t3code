"""Box-state polling retains the selected home box through reachable read timeouts."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, home
import test_home_box_slow as fixtures


class HomeStateSlow(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.HomeBoxSlow()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.clock = self.fixture.clock

    def test_two_slow_state_reads_keep_the_box_until_ready(self):
        calls = []
        def read(box, *, deadline):
            calls.append((box, deadline - self.clock.t))
            if len(calls) <= 2:
                self.clock.sleep(deadline - self.clock.t)
                raise api.NetworkError("GET /sandboxes/homebox timed out")
            return {"state": "running"}
        with patch.object(api, "get", side_effect=read), patch.object(api, "resume") as resume, \
                home.wait_budget(), contextlib.redirect_stderr(io.StringIO()):
            result = api.wait_state("homebox", api.LIVE_STATES, timeout=120)
        self.assertEqual(result, {"state": "running"})
        self.assertEqual([box for box, _ in calls], ["homebox"] * 3)
        self.assertEqual([seconds for _, seconds in calls], [5, 15, 15])
        resume.assert_not_called()
        self.assertFalse(common.HOME_FAILURES.exists())

    def test_state_poll_deadline_is_not_outage_evidence(self):
        def read(box, *, deadline):
            self.clock.sleep(max(0, deadline - self.clock.t))
            raise api.NetworkError("GET timed out")
        with patch.object(api, "get", side_effect=read), home.wait_budget():
            with self.assertRaises(api.BudgetExpired) as caught:
                api.wait_state("homebox", api.LIVE_STATES, timeout=10)
        self.assertLessEqual(self.clock.t, 1010.01)
        self.assertFalse(caught.exception.outage)


if __name__ == "__main__":
    unittest.main()
