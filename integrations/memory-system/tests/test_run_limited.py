"""Tests use only short-lived processes and files in a temporary directory."""

import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

SRC = Path(__file__).resolve().parents[1] / "src"
RUNNER = SRC / "run_limited.py"


class RunLimitedTest(unittest.TestCase):
    def test_exit_and_output_passthrough_with_background_policy(self):
        entry = f"import runpy; runpy.run_path({str(RUNNER)!r}, run_name='__main__')"
        if sys.platform != "darwin":
            # taskpolicy is macOS-only; assert its arguments before emulating it.
            # --background keeps default I/O and only lowers CPU priority.
            prefix = ["/usr/sbin/taskpolicy", "-d", "default", "/usr/bin/nice", "-n", "10"]
            entry = (
                f"import sys; sys.path.insert(0, {str(SRC)!r}); import run_limited as r; "
                f"original=r.run; prefix={prefix!r}; "
                "def_background=lambda cmd, secs: original(cmd[len(prefix):], secs) if cmd[:len(prefix)]==prefix else 99; "
                "r.run=def_background; sys.exit(r.main())"
            )
        result = subprocess.run(
            [sys.executable, "-c", entry,
             "--seconds", "5", "--background", "--",
             sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(7)"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, "out\n")
        self.assertEqual(result.stderr, "err\n")

    def test_timeout_kills_child_group_after_leader_exits(self):
        with tempfile.TemporaryDirectory() as directory:
            pids_file = Path(directory) / "pids"
            child = "import signal,sys,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); sys.stderr.write('X'*200000); print('ready', flush=True); time.sleep(120)"
            parent = (
                "import os,subprocess,sys,time; "
                "p=subprocess.Popen([sys.executable,'-c',sys.argv[2]], stdout=subprocess.PIPE, text=True); "
                "p.stdout.readline(); "
                "open(sys.argv[1], 'w').write(f'{os.getpid()} {p.pid}'); "
                "time.sleep(120)"
            )
            # Shorten only the unit test's grace period; production uses 30 s.
            entry = f"import sys; sys.path.insert(0, {str(SRC)!r}); import run_limited as r; r.KILL_GRACE_SECONDS=0.2; sys.exit(r.main())"
            try:
                result = subprocess.run(
                    [sys.executable, "-c", entry, "--seconds", "1", "--", sys.executable,
                     "-c", parent, str(pids_file), child],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 124, result.stderr)
                self.assertEqual(len(result.stderr), 200000)
                leader, descendant = map(int, pids_file.read_text().split())
                for pid in (leader, descendant):
                    status = subprocess.run(
                        ["/bin/ps", "-p", str(pid), "-o", "stat="],
                        capture_output=True, text=True, timeout=5,
                    ).stdout.strip()
                    self.assertTrue(not status or status.startswith("Z"), f"process {pid} still running: {status}")
            finally:
                # If an assertion fails, don't leave this test's own fixture running.
                if pids_file.exists():
                    leader = int(pids_file.read_text().split()[0])
                    try:
                        os.killpg(leader, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass


if __name__ == "__main__":
    unittest.main()
