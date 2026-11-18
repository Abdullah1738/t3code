"""The d9b6 background holder keeps its queued identity and selected home box on a read timeout."""
import contextlib
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, home, lease, pool, runs
import test_home_box_slow as fixtures


class BackgroundQueuedBoxSlow(unittest.TestCase):
    def test_d9b6_background_xlarge_waiter_keeps_home_identity_and_grant(self):
        fixture = fixtures.HomeBoxSlow()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        f, clock = fixture.f, fixture.clock
        f.box("homebox", member=True, size="xlarge")
        f.busy("homebox")
        f.con.execute("INSERT INTO runs(run_id,status,mode) VALUES ('run-d9b6','starting','bg')")
        f.con.commit()
        began = clock.t
        def free(t):
            if t >= began + 2159:
                f.con.execute("UPDATE runs SET status='done' WHERE run_id='run-homebox'")
        clock.on_sleep = free
        waits, calls = [], []
        def read(box, **kwargs):
            calls.append(box)
            waits.append([tuple(row) for row in f.con.execute(
                "SELECT token,run_id,reserved FROM pool_waiters WHERE run_id='run-d9b6'")])
            if len(calls) == 1:
                clock.sleep(5)
                raise api.NetworkError("deadline passed during GET /sandboxes/homebox: timed out")
            return {"id": box, "state": "running", "type": "xlarge"}
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS="5000", OFFBOX_POOL_SIZE="1",
                        **{runs.BACKGROUND_RUN_ENV: "run-d9b6"}), \
                patch.object(api, "get", side_effect=read), patch.object(lease, "ensure_ttl"), \
                patch.object(lease, "_bring_up", return_value={"state": "running"}), \
                patch.object(lease, "acquire_private", side_effect=AssertionError("keep background grant")), \
                home.wait_budget(), contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(f.me, size="xlarge", run_id="run-d9b6")
        pool.release_guard(got)
        self.assertEqual(got["box_id"], "homebox")
        self.assertEqual(calls, ["homebox", "homebox"])
        self.assertTrue(waits[0])
        self.assertEqual(waits[0], waits[1], "same queue token, run identity and reservation survive the retry")
        self.assertGreaterEqual(home.QUEUE_WAIT.get(), 2159)
        row = f.con.execute("SELECT status,mode FROM runs WHERE run_id='run-d9b6'").fetchone()
        self.assertEqual(tuple(row), ("starting", "bg"))
        self.assertEqual(f.execs, [])
        self.assertFalse(common.HOME_FAILURES.exists())


if __name__ == "__main__":
    unittest.main()
