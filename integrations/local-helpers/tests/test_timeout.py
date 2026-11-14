"""bin/timeout, the GNU-style timeout shim. Run: /usr/bin/python3 -B -m unittest discover -s tests -p test_timeout.py"""
import os
import signal
import subprocess
import time
import unittest

TIMEOUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "timeout")


def run(*args, stdin=None):
    started = time.monotonic()
    proc = subprocess.run([TIMEOUT, *args], input=stdin, capture_output=True, text=True, timeout=30)
    return proc.returncode, proc.stdout, proc.stderr, time.monotonic() - started


class TimeoutShimTest(unittest.TestCase):
    def test_times_out_with_124(self):
        rc, _, _, took = run("0.3", "sleep", "10")
        self.assertEqual(rc, 124)
        self.assertLess(took, 5)

    def test_passes_the_command_status_and_output_through(self):
        rc, out, _, _ = run("5", "sh", "-c", "cat; exit 7", stdin="hello\n")
        self.assertEqual((rc, out), (7, "hello\n"))
        self.assertEqual(run("5", "true")[0], 0)

    def test_kill_after_sends_kill_to_a_command_that_ignores_term(self):
        rc, _, _, took = run("-k", "0.3", "0.2", "sh", "-c", 'trap "" TERM; sleep 10')
        self.assertEqual(rc, 137)
        self.assertLess(took, 5)

    def test_kill_after_forms(self):
        for flags in (["-k0.3"], ["--kill-after=0.3"], ["--kill-after", "0.3"], ["-k", "0.005m"]):
            with self.subTest(flags=flags):
                rc, _, _, took = run(*flags, "0.2", "sh", "-c", 'trap "" TERM; sleep 10')
                self.assertEqual(rc, 137)
                self.assertLess(took, 5)

    def test_kill_after_unused_when_term_is_enough(self):
        self.assertEqual(run("-k", "5", "0.2", "sleep", "10")[0], 124)

    def test_signal_forms(self):
        for flags in (["-s", "INT"], ["-sINT"], ["--signal=SIGINT"], ["--signal", "int"], ["-s", "2"]):
            with self.subTest(flags=flags):
                self.assertEqual(run(*flags, "0.2", "sleep", "10")[0], 124)
        self.assertEqual(run("-s", "KILL", "0.2", "sleep", "10")[0], 137)

    def test_preserve_status_reports_the_signal(self):
        self.assertEqual(run("--preserve-status", "0.2", "sleep", "10")[0], 128 + signal.SIGTERM)
        self.assertEqual(run("--preserve-status", "5", "sh", "-c", "exit 3")[0], 3)

    def test_durations(self):
        # Each finishes long before its limit, so a misread unit would time out instead.
        for text in ("5", "5s", "1m", "1h", "1d", "2.5", ".5m", "0"):
            with self.subTest(duration=text):
                self.assertEqual(run(text, "sleep", "0.05")[0], 0)
        self.assertEqual(run("0.1s", "sleep", "10")[0], 124)

    def test_bad_input_exits_125(self):
        for args in (["abc", "true"], ["5x", "true"], ["-1", "true"], ["-s", "NOPE", "1", "true"],
                     ["-k", "x", "1", "true"], ["5"], [], ["--bogus", "1", "true"]):
            with self.subTest(args=args):
                rc, _, err, _ = run(*args)
                self.assertEqual(rc, 125)
                self.assertTrue(err.startswith(("timeout:", "usage:", "Unknown option")), err)

    def test_command_that_cannot_run(self):
        rc, _, err, _ = run("5", "no-such-command-xyz")
        self.assertEqual(rc, 127)
        self.assertIn("no-such-command-xyz", err)
        self.assertEqual(run("5", "/etc/hosts")[0], 126)

    def test_options_after_the_duration_belong_to_the_command(self):
        rc, out, _, _ = run("5", "sh", "-c", 'echo "$1"', "sh", "-k")
        self.assertEqual((rc, out), (0, "-k\n"))

    def test_command_killed_by_its_own_signal(self):
        proc = subprocess.run([TIMEOUT, "5", "sh", "-c", "kill -INT $$"], capture_output=True, timeout=30)
        self.assertEqual(proc.returncode, -signal.SIGINT)

    def test_grandchildren_are_killed_so_the_pipe_closes(self):
        # Without the process-group kill, the background sleep keeps stdout open for 10 s.
        rc, _, _, took = run("0.3", "sh", "-c", "sleep 10 & sleep 10")
        self.assertEqual(rc, 124)
        self.assertLess(took, 5)

    def test_foreground_kills_only_the_command(self):
        rc, _, _, took = run("--foreground", "0.3", "sleep", "10")
        self.assertEqual(rc, 124)
        self.assertLess(took, 5)

    def test_term_to_timeout_reaches_the_command(self):
        proc = subprocess.Popen([TIMEOUT, "30", "sh", "-c", "echo $$; exec sleep 30"], stdout=subprocess.PIPE, text=True)
        child = int(proc.stdout.readline())
        proc.send_signal(signal.SIGTERM)
        # Like GNU, timeout then dies of the same signal.
        self.assertEqual(proc.wait(timeout=10), -signal.SIGTERM)
        proc.stdout.close()
        time.sleep(0.1)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_verbose_names_the_signal(self):
        _, _, err, _ = run("-v", "0.2", "sleep", "10")
        self.assertIn("sending signal TERM to command 'sleep'", err)


if __name__ == "__main__":
    unittest.main()
