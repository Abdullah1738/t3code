import contextlib
import fcntl
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memguard", Path(__file__).with_name("memguard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class MemguardTests(unittest.TestCase):
    def test_footprint_units_and_shapes(self):
        for text, expected in [("phys_footprint: 22 GB", 22528), ("phys_footprint: 6353 MB", 6353), ("phys_footprint: 1.5 GB", 1536), ("phys_footprint: 2048 KB", 2), ("phys_footprint: 1 TB", 1048576), ("phys_footprint: 0 MB", 0), ("other: 22 GB", None), ("phys_footprint: unknown", None)]:
            with self.subTest(text=text):
                self.assertEqual(guard.footprint_mb(text), expected)

    def test_keep_mount_version_class(self):
        for version, expected in [("ovnfs v0.2.4 go1.27", False), ("ovnfs v0.3.0 go1.27", True), ("ovnfs v0.3.1", True), ("ovnfs v0.10.0", True), ("ovnfs v1.0.0", True), ("ovnfs development", False), ("ovnfs v0.3", False)]:
            with self.subTest(version=version):
                self.assertEqual(guard.supports_keep_mount(version), expected)

    def test_blocked_read_never_accumulates_probes(self):
        with patch.object(guard, "mounted", return_value=True), patch.object(guard.subprocess, "Popen") as popen:
            child = popen.return_value
            child.poll.return_value = None
            reader = guard.Readback("/test/mount")
            for _ in range(100):
                self.assertEqual(reader.sample()["read"], "pending")
            self.assertEqual(popen.call_count, 1)

    def test_bare_directory_is_not_a_healthy_mount(self):
        with patch.object(guard, "mounted", side_effect=[True, False]), patch.object(guard.subprocess, "Popen") as popen:
            child = popen.return_value
            child.poll.return_value = 0
            child.communicate.return_value = ('{"read":"ok","errno":null}', '')
            reader = guard.Readback("/test/mount")
            reader.sample()
            self.assertEqual(reader.sample()["read"], "not_mounted")

    def test_unreaped_probe_keeps_exclusion_after_parent_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = (Path(directory) / "guard.lock").open("a+")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            real_popen = subprocess.Popen
            children = []

            def start_probe(*args, **kwargs):
                # A blocked child retains the inherited open-file lock even
                # after the guard gives up waiting and closes its own handle.
                child = real_popen([sys.executable, "-c", "import sys; print('ready',flush=True); sys.stdin.read()"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, pass_fds=kwargs["pass_fds"])
                self.assertEqual(child.stdout.readline().strip(), "ready")
                children.append(child)
                return child

            try:
                with patch.object(guard, "mounted", return_value=True), patch.object(guard.subprocess, "Popen", side_effect=start_probe):
                    reader = guard.Readback("/test/mount", lock.fileno())
                    reader.sample()
                lock.close()
                with (Path(directory) / "guard.lock").open("a+") as other:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                children[0].communicate("")
                with (Path(directory) / "guard.lock").open("a+") as other:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                lock.close()
                for child in children:
                    if child.poll() is None:
                        child.kill()
                    child.communicate()

    def test_mount_table_error_does_not_end_observation(self):
        with patch.object(guard, "mounted", side_effect=[subprocess.TimeoutExpired("mount", 2), False]):
            reader = guard.Readback("/test/mount")
            self.assertEqual(reader.sample()["read"], "mount_table_error")
            self.assertEqual(reader.sample()["read"], "not_mounted")

    def test_initial_sample_failures_do_not_suppress_restart(self):
        for error in [subprocess.TimeoutExpired("mount", 2), OSError("mount unavailable"), RuntimeError("mount failed")]:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as directory:
                status = json.dumps({"pid": 123, "mount": "/private/test"})
                replies = [subprocess.CompletedProcess([], 0, status, ""), subprocess.CompletedProcess([], 0, "phys_footprint: 20 GB", ""), subprocess.CompletedProcess([], 0, "ovnfs v0.3.0", "")]
                with patch.object(guard.Path, "home", return_value=Path(directory)), patch.object(guard.sys, "argv", ["memguard"]), patch.object(guard, "command", side_effect=replies), patch.object(guard, "mounted", side_effect=error), patch.object(guard, "monitor_restart", return_value=0) as restart, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(guard.main(), 0)
                    restart.assert_called_once()

    def test_restart_failure_still_gets_post_exit_readback(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "restart"
            binary.write_text("#!/bin/sh\nsleep 0.03\nexit 7\n")
            binary.chmod(0o755)
            output = io.StringIO()
            with contextlib.redirect_stdout(output), patch.object(guard.Readback, "sample", return_value={"mount_entry": True, "read": "ok"}):
                code = guard.monitor_restart(str(binary), "/test/mount", after=.04, interval=.01, budget=2)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(code, 7)
            samples = [e for e in events if e["event"] == "mount_readback"]
            self.assertTrue(any(e["phase"] == "during" for e in samples))
            self.assertGreaterEqual(sum(e["phase"] == "after" for e in samples), 2)


if __name__ == "__main__":
    unittest.main()
