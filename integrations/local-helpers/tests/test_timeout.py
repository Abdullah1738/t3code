"""bin/timeout, the GNU-style timeout shim. Run: /usr/bin/python3 -B -m unittest discover -s tests -p test_timeout.py"""
import os
import pty
import select
import signal
import subprocess
import time
import unittest

TIMEOUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "timeout")


def run(*args, stdin=None):
    started = time.monotonic()
    proc = subprocess.run([TIMEOUT, *args], input=stdin, capture_output=True, text=True, timeout=30)
    return proc.returncode, proc.stdout, proc.stderr, time.monotonic() - started


class Pty:
    """argv run as the foreground job of a fresh terminal, the way a shell prompt starts it."""

    def __init__(self, argv):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.execv(argv[0], argv)
            finally:
                os._exit(127)
        self.out = b""

    def read_until(self, text, deadline=10):
        end = time.monotonic() + deadline
        while text.encode() not in self.out:
            left = end - time.monotonic()
            if left <= 0 or not self._read(left):
                raise AssertionError(f"no {text!r} in {self.out!r}")

    def _read(self, wait):
        if not select.select([self.fd], [], [], wait)[0]:
            return False
        try:
            chunk = os.read(self.fd, 4096)
        except OSError:  # EIO once the terminal's last user exits
            return False
        self.out += chunk
        return bool(chunk)

    def send(self, data):
        os.write(self.fd, data)

    def wait(self, deadline=10, flags=0):
        end = time.monotonic() + deadline
        while time.monotonic() < end:
            got, status = os.waitpid(self.pid, os.WNOHANG | flags)
            if got:
                return status
            self._read(0.05)
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)
        raise AssertionError(f"still running; output {self.out!r}")

    def finish(self):
        status = self.wait()
        while self._read(0.05):
            pass
        os.close(self.fd)
        return status


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


    def test_command_can_read_the_terminal(self):
        term = Pty([TIMEOUT, "5", "/usr/bin/perl", "-e", 'my $line = <STDIN>; print "read:$line"'])
        term.send(b"hello\n")
        status = term.finish()
        self.assertIn(b"read:hello", term.out)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_terminal_is_handed_back_to_the_caller(self):
        # If timeout left the terminal with the command's group, the shell's own read would stop on SIGTTIN.
        for inner, rc in (("0.3 sleep 5", 124), ("5 sh -c 'read a; echo a:$a'", 0)):
            with self.subTest(inner=inner):
                term = Pty(["/bin/sh", "-c", f"{TIMEOUT} {inner}; echo rc=$?; read b; echo b:$b"])
                if rc == 0:
                    term.send(b"one\n")
                term.read_until(f"rc={rc}")
                term.send(b"two\n")
                term.read_until("b:two")
                self.assertEqual(os.waitstatus_to_exitcode(term.finish()), 0)

    def test_ctrl_z_stops_timeout_and_resume_continues_the_command(self):
        # One process: a non-interactive sh exits when its child stops, which would hide what timeout does.
        term = Pty([TIMEOUT, "5", "/usr/bin/perl", "-e", '$| = 1; print "ready\\n"; sleep 1; print "done\\n"'])
        term.read_until("ready")
        term.send(b"\x1a")
        self.assertTrue(os.WIFSTOPPED(term.wait(flags=os.WUNTRACED)))
        os.kill(term.pid, signal.SIGCONT)
        term.read_until("done")
        self.assertEqual(os.waitstatus_to_exitcode(term.finish()), 0)

    def test_ctrl_c_on_the_terminal_ends_the_command(self):
        term = Pty([TIMEOUT, "5", "sh", "-c", "echo ready; sleep 5"])
        term.read_until("ready")
        term.send(b"\x03")
        self.assertEqual(os.waitstatus_to_exitcode(term.finish()), -signal.SIGINT)


if __name__ == "__main__":
    unittest.main()
