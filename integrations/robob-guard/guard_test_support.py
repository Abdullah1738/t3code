"""Default process observations for guard simulations, independent of the host."""
import subprocess
import unittest
from unittest.mock import patch


class GuardTestCase(unittest.TestCase):
    def setUp(self):
        super().setUp()
        real_run = subprocess.run

        def run(command, *args, **kwargs):
            if command[0] in ("/usr/bin/lsappinfo", "/bin/ps"):
                # Process-specific tests override run with their own observations.
                # Unknown lookups must fail here instead of reaching the live app.
                self.assertIn(command, [
                    ["/usr/bin/lsappinfo", "info", "-only", "pid", "-app", "com.ardud.robob"],
                    ["/bin/ps", "-axo", "pid=,comm="],
                    ["/bin/ps", "-axo", "pid=,ppid=,comm=,args="],
                ], "provide an explicit process fixture for this lookup")
                return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
            return real_run(command, *args, **kwargs)

        for target, options in [
            ("guard.subprocess.run", dict(side_effect=run)),
            ("guard.protected_tier_tick", {}),
            ("guard.boot_epoch", dict(return_value=0)),
        ]:
            patcher = patch(target, **options)
            patcher.start()
            self.addCleanup(patcher.stop)
