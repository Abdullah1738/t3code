"""Tests use only short-lived processes and files in a temporary directory."""

import json
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "src"
RUNNER = SRC / "run_limited.py"


def fixture_status(pid):
    return subprocess.run(
        ["/bin/ps", "-p", str(pid), "-o", "stat="],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip()


def cleanup_fixture(pids_file):
    if not pids_file.exists():
        return
    for pid in map(int, pids_file.read_text().split()):
        # Never signal a PID reused by an unrelated process.
        command = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=5,
        ).stdout
        if str(pids_file) in command:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


class RunLimitedTest(unittest.TestCase):
    def assert_fixture_stopped(self, pids_file):
        for pid in map(int, pids_file.read_text().split()):
            deadline = time.monotonic() + 2
            while True:
                status = fixture_status(pid)
                if not status or status.startswith("Z") or time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
            self.assertTrue(not status or status.startswith("Z"), f"process {pid} still running: {status}")

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
                self.assertEqual(
                    result.stderr,
                    "[run_limited: 134464 earlier bytes dropped]\n" + "X" * 65536,
                )
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

    def test_wrapper_sigterm_kills_child_group(self):
        # Also check the other two supported signals and a descendant that
        # ignores SIGTERM after its group leader has exited.
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig), tempfile.TemporaryDirectory() as directory:
                pids_file = Path(directory) / "pids"
                child = (
                    "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                    "print('ready', flush=True); time.sleep(120)"
                )
                parent = (
                    "import os,subprocess,sys,time; "
                    "p=subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]], "
                    "stdout=subprocess.PIPE, text=True); "
                    "p.stdout.readline(); "
                    "print('started', flush=True); "
                    "open(sys.argv[1] + '.tmp', 'w').write(f'{os.getpid()} {p.pid}'); "
                    "os.replace(sys.argv[1] + '.tmp', sys.argv[1]); "
                    "time.sleep(120)"
                )
                entry = f"import sys; sys.path.insert(0, {str(SRC)!r}); import run_limited as r; r.KILL_GRACE_SECONDS=0.2; sys.exit(r.main())"
                wrapper = subprocess.Popen(
                    [sys.executable, "-c", entry, "--seconds", "120", "--", sys.executable,
                     "-c", parent, str(pids_file), child],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    deadline = time.monotonic() + 5
                    while not pids_file.exists() and wrapper.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(pids_file.exists(), "child did not start")
                    wrapper.send_signal(sig)
                    stdout, stderr = wrapper.communicate(timeout=5)
                    self.assertEqual(wrapper.returncode, 128 + sig, stderr)
                    self.assertEqual(stdout, "started\n")
                    self.assert_fixture_stopped(pids_file)
                finally:
                    if wrapper.poll() is None:
                        wrapper.kill()
                        wrapper.communicate(timeout=5)
                    cleanup_fixture(pids_file)

    def test_stop_during_launch_and_replay(self):
        child = (
            "import os,signal,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            "print('ready',flush=True); time.sleep(120)"
        )
        parent = (
            "import os,subprocess,sys,time; "
            "p=subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]], "
            "stdout=subprocess.PIPE,text=True); p.stdout.readline(); "
            "print('started',flush=True); "
            "open(sys.argv[1]+'.tmp','w').write(f'{os.getpid()} {p.pid}'); "
            "os.replace(sys.argv[1]+'.tmp',sys.argv[1]); "
            "time.sleep(120) if sys.argv[3]=='launch' else None"
        )
        entry = """
import os, signal, sys, time
sys.path.insert(0, sys.argv[1])
import run_limited as r
r.KILL_GRACE_SECONDS = 0.2
phase, pids, marker = sys.argv[2:5]
real_popen, real_replay = r.subprocess.Popen, r.replay_capture
def ready():
    while not os.path.exists(pids): time.sleep(0.01)
    open(marker, 'w').close()
    time.sleep(1)
def delayed_popen(*a, **kw):
    process = real_popen(*a, **kw)
    ready()
    return process
def delayed_replay(*a, **kw):
    if not os.path.exists(marker): ready()
    return real_replay(*a, **kw)
if phase == 'launch': r.subprocess.Popen = delayed_popen
else: r.replay_capture = delayed_replay
sys.exit(r.run([sys.executable, '-c', sys.argv[5], pids, sys.argv[6], phase], 120))
"""
        for phase in ("launch", "replay"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                pids_file = Path(directory) / "pids"
                marker = Path(directory) / "barrier"
                wrapper = subprocess.Popen(
                    [sys.executable, "-c", entry, str(SRC), phase, str(pids_file), str(marker), parent, child],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    deadline = time.monotonic() + 5
                    while not marker.exists() and wrapper.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(marker.exists(), f"{phase} barrier not reached")
                    wrapper.send_signal(signal.SIGTERM)
                    stdout, stderr = wrapper.communicate(timeout=5)
                    self.assertEqual(wrapper.returncode, 143, stderr)
                    self.assertEqual(stdout, "started\n")
                    self.assert_fixture_stopped(pids_file)
                finally:
                    if wrapper.poll() is None:
                        wrapper.kill()
                        wrapper.communicate(timeout=5)
                    cleanup_fixture(pids_file)

    def test_stop_during_timeout_grace_keeps_original_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            pids_file = Path(directory) / "pids"
            term_file = Path(directory) / "term"
            child = """
import os, signal, sys, time
def on_term(*_):
    open(sys.argv[2], 'w').close()
signal.signal(signal.SIGTERM, on_term)
open(sys.argv[1], 'w').write(str(os.getpid()))
time.sleep(120)
"""
            entry = f"import sys; sys.path.insert(0, {str(SRC)!r}); import run_limited as r; r.KILL_GRACE_SECONDS=2; sys.exit(r.main())"
            wrapper = subprocess.Popen(
                [sys.executable, "-c", entry, "--seconds", "0.3", "--", sys.executable,
                 "-c", child, str(pids_file), str(term_file)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not term_file.exists() and wrapper.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(term_file.exists(), "child did not receive timeout TERM")
                time.sleep(1.2)
                sent = time.monotonic()
                wrapper.send_signal(signal.SIGTERM)
                _, stderr = wrapper.communicate(timeout=5)
                self.assertEqual(wrapper.returncode, 143, stderr)
                self.assertLess(time.monotonic() - sent, 1.7)
                self.assert_fixture_stopped(pids_file)
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.communicate(timeout=5)
                cleanup_fixture(pids_file)

    def test_replay_does_not_change_surviving_writer_offset(self):
        spec = importlib.util.spec_from_file_location("run_limited_test", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryFile() as capture, tempfile.TemporaryFile() as replay:
            capture.write(b"original")
            capture.flush()
            original_pread = os.pread
            def writer_then_read(fd, size, offset):
                os.write(capture.fileno(), b"-more")
                return original_pread(fd, size, offset)
            with mock.patch.object(runner.os, "pread", side_effect=writer_then_read):
                runner.replay_capture(capture, replay)
            replay.seek(0)
            self.assertEqual(replay.read(), b"original")
            self.assertEqual(os.pread(capture.fileno(), 13, 0), b"original-more")

    def test_output_replay_capped(self):
        summary = '{"message_type":"summary","snapshot_id":"abc123","data_added_packed":42}\n'
        output = "X" * (200000 - len(summary) - 1) + "\n" + summary
        result = subprocess.run(
            [sys.executable, str(RUNNER), "--seconds", "5", "--", sys.executable, "-c",
             "import sys; sys.stdout.write('X' * (200000-len(sys.argv[1])-1)+'\\n'+sys.argv[1])", summary],
            capture_output=True, text=True, timeout=10,
        )
        header = "[run_limited: 134464 earlier bytes dropped]\n"
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, header + output[-65536:])
        self.assertTrue(result.stdout.endswith(summary))
        # This is the grep used by memory_backup.sh after combining the streams.
        parsed = subprocess.run(
            ["/bin/bash", "-c", "grep '\"message_type\":\"summary\"' | tail -1"],
            input=result.stdout + result.stderr, capture_output=True, text=True, check=True,
        )
        self.assertEqual(json.loads(parsed.stdout)["snapshot_id"], "abc123")

    def test_replay_cap_boundaries_on_both_streams(self):
        for size in (0, 1, 65535, 65536, 65537):
            with self.subTest(size=size):
                result = subprocess.run(
                    [sys.executable, str(RUNNER), "--seconds", "5", "--", sys.executable, "-c",
                     "import sys; n=int(sys.argv[1]); sys.stdout.write('O'*n); sys.stderr.write('E'*n)", str(size)],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0)
                dropped = max(0, size - 65536)
                header = f"[run_limited: {dropped} earlier bytes dropped]\n" if dropped else ""
                self.assertEqual(result.stdout, header + "O" * min(size, 65536))
                self.assertEqual(result.stderr, header + "E" * min(size, 65536))


if __name__ == "__main__":
    unittest.main()
