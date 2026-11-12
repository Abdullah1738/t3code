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
    if kw.get('start_new_session'): ready()
    return process
def delayed_replay(*a, **kw):
    if not os.path.exists(marker): ready()
    return real_replay(*a, **kw)
if phase == 'launch': r.subprocess.Popen = delayed_popen
else: r.replay_capture = delayed_replay
sys.exit(r.run([sys.executable, '-c', sys.argv[5], pids, sys.argv[6], phase], 120 if phase == 'launch' else 0.3))
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

    def run_escaped_fixture(self, patch="", seconds=1, expected=124, double_fork=False):
        with tempfile.TemporaryDirectory() as directory:
            pids_file = Path(directory) / "pids"
            child = """
import os, signal, sys, time
sys.stderr.write('noise' * 1000)
sys.stderr.flush()
os.setsid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
print('ready', flush=True)
time.sleep(120)
"""
            parent = """
import os, subprocess, sys
p = subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]], stdout=subprocess.PIPE, text=True)
p.stdout.readline()
open(sys.argv[1], 'w').write(f'{os.getpid()} {p.pid}')
"""
            if double_fork:
                intermediate = """
import subprocess, sys
p = subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]], stdout=subprocess.PIPE, text=True)
p.stdout.readline()
open(sys.argv[1], 'w').write(f'{sys.argv[3]} {p.pid}')
"""
                parent = f"""
import os, subprocess, sys, time
p = subprocess.Popen([sys.executable, '-c', {intermediate!r}, sys.argv[1], sys.argv[2], str(os.getpid())])
p.wait()
time.sleep(120)
"""
            entry = f"""
import os, signal, sys
sys.path.insert(0, {str(SRC)!r})
import run_limited as r
r.KILL_GRACE_SECONDS = 0.1
r.KILL_VERIFY_SECONDS = 1
{patch}
sys.exit(r.run([sys.executable, '-c', sys.argv[1], sys.argv[2], sys.argv[3]], {seconds}))
"""
            try:
                result = subprocess.run(
                    [sys.executable, '-c', entry, parent, str(pids_file), child],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected == 125:
                    pid = int(pids_file.read_text().split()[1])
                    self.assertIn(f"run_limited: survivors after SIGKILL: {pid} ", result.stderr)
                    self.assertFalse(fixture_status(pid).startswith('Z'))
                    self.assertTrue(fixture_status(pid))
                    self.assertIn(f"survivors after SIGKILL: {pid} ", result.stderr[-600:])
                else:
                    self.assert_fixture_stopped(pids_file)
                return result
            finally:
                cleanup_fixture(pids_file)

    def test_timeout_kills_orphan_after_intermediate_reaped(self):
        self.run_escaped_fixture(double_fork=True)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin original-parent identity regression')
    def test_timeout_kills_descendant_in_other_group(self):
        self.run_escaped_fixture()

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin original-parent identity regression')
    def test_survivor_reported(self):
        self.run_escaped_fixture(patch="""
real_kill = r.ChildTree.signal_pid
def ignore_kill(self, process, sig):
    if sig != signal.SIGKILL:
        real_kill(self, process, sig)
r.ChildTree.signal_pid = ignore_kill
""", expected=125)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin original-parent identity regression')
    def test_wrapper_signals_kill_descendant_in_other_group(self):
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=sig):
                self.run_escaped_fixture(patch=f"""
real_refresh = r.ChildTree.refresh
sent = False
def stop_with_zombie_leader(self):
    global sent
    alive = real_refresh(self)
    if not sent and any(p.pid != self.leader for p in alive):
        # The leader exits immediately after publishing the grandchild PID.
        os.waitid(os.P_PID, self.leader, os.WEXITED | os.WNOWAIT)
        sent = True
        os.kill(os.getpid(), {int(sig)})
    return alive
r.ChildTree.refresh = stop_with_zombie_leader
""", seconds=120, expected=128 + sig)

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin original-parent identity regression')
    def test_signal_during_final_reap(self):
        self.run_escaped_fixture(patch="""
real_refresh = r.ChildTree.refresh
replayed = False
in_boundary = False
real_replay = r.replay_capture
def replay(*args):
    global replayed
    replayed = True
    return real_replay(*args)
def hide_until_boundary(self):
    global in_boundary
    alive = real_refresh(self)
    if not replayed:
        # Force the original normal-exit path while the escaped child lives.
        if any(p.pid != self.leader for p in alive):
            os.waitid(os.P_PID, self.leader, os.WEXITED | os.WNOWAIT)
        return []
    if not in_boundary:
        in_boundary = True
        assert signal.SIGTERM in signal.pthread_sigmask(signal.SIG_BLOCK, [])
        # Past replay's cleanup check, with the leader still unreaped. TERM
        # becomes pending, then must be handled after the final reap unmasks.
        os.kill(os.getpid(), signal.SIGTERM)
    return alive
r.ChildTree.refresh = hide_until_boundary
r.replay_capture = replay
""", seconds=120, expected=143)

    def test_child_spawned_during_term_grace_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            pids_file = Path(directory) / "pids"
            child = "import os,sys,time; os.setsid(); print('ready',flush=True); time.sleep(120)"
            parent = """
import os, signal, subprocess, sys, time
def on_term(*_):
    p = subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[1]], stdout=subprocess.PIPE, text=True)
    p.stdout.readline()
    open(sys.argv[1], 'w').write(f'{os.getpid()} {p.pid}')
signal.signal(signal.SIGTERM, on_term)
time.sleep(120)
"""
            entry = f"import sys; sys.path.insert(0, {str(SRC)!r}); import run_limited as r; r.KILL_GRACE_SECONDS=.3; sys.exit(r.main())"
            try:
                result = subprocess.run(
                    [sys.executable, '-c', entry, '--seconds', '1', '--', sys.executable,
                     '-c', parent, str(pids_file), child],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 124, result.stderr)
                self.assert_fixture_stopped(pids_file)
            finally:
                cleanup_fixture(pids_file)

    def test_reused_pid_not_signalled_or_followed(self):
        spec = importlib.util.spec_from_file_location("run_limited_test", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = runner
        spec.loader.exec_module(runner)
        old = runner.ProcessInfo(900001, 1, 900001, 'S', 123, 0, 'owned')
        reused = runner.ProcessInfo(900001, 1, 900002, 'S', 124, 0, 'unrelated')
        foreign_child = runner.ProcessInfo(900003, 900001, 900002, 'S', 125, 124, 'unrelated child')
        tree = runner.ChildTree(old.pid)
        tree.members[old.pid] = old
        with mock.patch.object(runner, 'process_table', return_value={old.pid: reused, foreign_child.pid: foreign_child}), \
             mock.patch.object(runner.os, 'kill') as kill:
            tree.signal_pid(old, signal.SIGKILL)
            self.assertEqual(tree.refresh(), [])
            self.assertNotIn(foreign_child.pid, tree.members)
            kill.assert_not_called()

    def test_reused_pid_can_be_a_new_descendant(self):
        spec = importlib.util.spec_from_file_location("run_limited_test", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = runner
        spec.loader.exec_module(runner)
        leader = runner.ProcessInfo(900001, 1, 900001, 'Z', 123, 0, 'leader')
        old = runner.ProcessInfo(900002, 900001, 900002, 'Z', 124, 123, 'old')
        replacement = runner.ProcessInfo(900002, 900001, 900002, 'S', 125, 123, 'new child')
        tree = runner.ChildTree(leader.pid)
        tree.members = {leader.pid: leader, old.pid: old}
        tree.identities = {leader.identity, old.identity}
        with mock.patch.object(runner, 'process_table', return_value={leader.pid: leader, replacement.pid: replacement}):
            self.assertEqual(tree.refresh(), [replacement])
            self.assertEqual(tree.identities, {123, 124, 125})

    @unittest.skipUnless(sys.platform == 'darwin', 'Darwin atomic process record regression')
    def test_native_ownership_does_not_use_stale_ps_ancestry(self):
        spec = importlib.util.spec_from_file_location("run_limited_test", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = runner
        spec.loader.exec_module(runner)
        def native(pid, flavor, arg, pointer, size):
            record = pointer._obj
            if flavor == 13:
                record.pid, record.ppid, record.pgid, record.status = pid, 1, 900099, 2
            else:
                self.assertEqual(flavor, 17)
                record.uniqueid, record.parent_uniqueid = 125, 1
            return size
        fake_ps = subprocess.CompletedProcess([], 0, '900002 900001 900001 S Thu Nov 12 00:00:00 2026 stale command\n', '')
        with mock.patch.object(runner.subprocess, 'run', return_value=fake_ps), \
             mock.patch.object(runner.LIBPROC, 'proc_pidinfo', side_effect=native):
            record = runner.process_table()[900002]
            self.assertEqual((record.ppid, record.pgid, record.identity), (1, 900099, 125))

    def test_replay_does_not_change_surviving_writer_offset(self):
        spec = importlib.util.spec_from_file_location("run_limited_test", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = runner
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
