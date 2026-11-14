"""Relocated bases discard only CMake's stale absolute-path metadata."""
import contextlib
import io
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated
from offbox_lib import common, lease, ssh_sync


MOVED = b"offbox-base-checkout-relocated\n"


class CMakeRelocationTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(lease, "_bring_up", return_value={}))
        self.stack.enter_context(patch.object(lease.api, "rename"))
        self.stack.enter_context(patch.object(lease, "remote_dir_for", return_value="w/new"))
        self.stderr = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.ssh = self.stack.enter_context(patch.object(ssh_sync, "ssh"))

    def create(self, base_dir="w/old"):
        return lease._create_row(self.con, self.me, "scratch", "base:repo:warm", base_dir,
                                 "large", common.now(), box_held=True)

    def relocation(self):
        return self.con.execute("SELECT detail FROM events WHERE kind='base_relocated'").fetchall()

    def test_one_ssh_cleans_after_move_and_records_count_and_removals(self):
        self.ssh.return_value = subprocess.CompletedProcess([], 0, MOVED +
            b"CMake cache removed: /old/build -> /new/build\ncmake_caches_removed=1\n", b"")
        self.assertEqual(self.create()["state"], "running")
        self.ssh.assert_called_once()
        command = self.ssh.call_args.args[1]
        self.assertLess(command.index('mv --'), command.index('timeout -k 5 60 bash'))
        self.assertIn(shlex.quote(lease._cmake_cache_cleanup_shell()), command)
        self.assertEqual(self.ssh.call_args.kwargs["timeout"], 120)
        detail = self.relocation()[0][0]
        self.assertIn("from=w/old to=w/new cmake_caches_removed=1", detail)
        self.assertIn("/old/build -> /new/build", detail)
        self.assertIn("CMake cache removed", self.stderr.getvalue())

    def test_cleanup_failure_or_timeout_never_fails_lease(self):
        outcomes = [
            subprocess.CompletedProcess([], 1, MOVED, b"permission denied"),
            subprocess.CompletedProcess([], 0, MOVED +
                b"CMake cache cleanup failed (rc=124); continuing lease\n", b""),
            subprocess.TimeoutExpired("ssh", 120, output=MOVED),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=outcome):
                self.con.execute("DELETE FROM events")
                self.ssh.side_effect = outcome if isinstance(outcome, Exception) else None
                self.ssh.return_value = outcome
                self.assertEqual(self.create()["state"], "running")
                self.assertIn("cmake_caches_removed=unknown", self.relocation()[0][0])
        self.assertIn("permission denied", self.stderr.getvalue())
        self.assertIn("rc=124", self.stderr.getvalue())
        self.assertIn("SSH timed out", self.stderr.getvalue())

    def test_move_failures_keep_existing_error_handling(self):
        for outcome in (subprocess.CompletedProcess([], 1, b"", b"move failed"),
                        subprocess.TimeoutExpired("ssh", 120)):
            with self.subTest(outcome=outcome):
                self.ssh.side_effect = outcome if isinstance(outcome, Exception) else None
                self.ssh.return_value = outcome
                with self.assertRaises((common.OffboxError, subprocess.TimeoutExpired)):
                    self.create()
                self.assertFalse(self.relocation())

    def test_same_or_absent_base_needs_no_ssh_or_event(self):
        for base in (None, "", "w/new"):
            self.create(base)
        self.ssh.assert_not_called()
        self.assertFalse(self.relocation())

    def test_guarded_noop_does_not_record_relocation(self):
        self.ssh.return_value = subprocess.CompletedProcess([], 0, b"", b"")
        self.create()
        self.assertFalse(self.relocation())


class CMakeCleanupShellTests(unittest.TestCase):
    def test_queued_nested_or_vanished_cache_does_not_abort_remaining_cleanup(self):
        orders = {
            "parent first": ("build/parent", "build/parent/CMakeFiles/TryCompile", "build/later"),
            "child first": ("build/parent/CMakeFiles/TryCompile", "build/parent", "build/later"),
            "vanished entry": ("build/vanished", "build/parent", "build/later"),
        }
        for name, order in orders.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                for build in ("build/parent", "build/parent/CMakeFiles/TryCompile", "build/later"):
                    path = root / build
                    path.mkdir(parents=True, exist_ok=True)
                    (path / "CMakeCache.txt").write_text("CMAKE_CACHEFILE_DIR:INTERNAL=/old/base\n")
                    (path / "CMakeFiles").mkdir(exist_ok=True)
                    (path / "output.bin").write_text("warm")
                # Freeze find's queue to cover both legal traversal orders without filesystem timing.
                queue = " ".join(shlex.quote(str(root / build / "CMakeCache.txt")) for build in order)
                shell = "find() { printf '%s\\0' " + queue + "; }; " + lease._cmake_cache_cleanup_shell()
                result = subprocess.run(["bash", "-c", shell, "cleanup", str(root)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = 3 if name == "child first" else 2
                self.assertIn(f"cmake_caches_removed={expected}", result.stdout)
                for build in ("build/parent", "build/later"):
                    self.assertFalse((root / build / "CMakeCache.txt").exists())
                    self.assertFalse((root / build / "CMakeFiles").exists())
                    self.assertEqual((root / build / "output.bin").read_text(), "warm")

    def test_unreadable_cache_does_not_prevent_later_cleanup_or_final_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for name in ("unreadable", "later"):
                build = root / name
                (build / "CMakeFiles").mkdir(parents=True)
                (build / "CMakeCache.txt").write_text("CMAKE_CACHEFILE_DIR:INTERNAL=/old/base\n")
            shell = r'''find() { printf '%s\0' "$1/unreadable/CMakeCache.txt" "$1/later/CMakeCache.txt"; }
sed() { case "$*" in *unreadable*) return 1;; *) command sed "$@";; esac; }
''' + lease._cmake_cache_cleanup_shell()
            result = subprocess.run(["bash", "-c", shell, "cleanup", str(root)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 1)
            self.assertIn("cmake_caches_removed=1", result.stdout)
            self.assertTrue((root / "unreadable/CMakeCache.txt").exists())
            self.assertFalse((root / "later/CMakeCache.txt").exists())

    def test_real_moved_tree_preserves_matching_caches_outputs_and_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            old, new = root / "old checkout", root / "new's $(touch UNEXPECTED)"
            stale = ["build/x", "native/.cxx/Debug/hash/arm64-v8a", "build/space ' $()\t\nline"]
            entries = {name: str(old / name) for name in stale}
            entries.update({"build/already-stale": "/unrelated/older/base",
                            "build/matching": str(new / "build/matching"),
                            "build/no-internal": None,
                            "node_modules/dependency/build": str(old / "node_modules/dependency/build")})
            for name, previous in entries.items():
                build = old / name
                (build / "CMakeFiles").mkdir(parents=True)
                (build / "CMakeFiles/state").write_text("metadata")
                (build / "CMakeCache.txt").write_text(
                    "CMAKE_CACHEFILE_DIR:INTERNAL=" + previous + "\n" if previous else "OTHER=keep\n")
                (build / "libbuilt.so").write_text("warm output")
            external = root / "external"
            external.mkdir()
            outside_cache = external / "CMakeCache.txt"
            outside_cache.write_text("CMAKE_CACHEFILE_DIR:INTERNAL=/old/outside\n")
            (old / "linked-tree").symlink_to(external, target_is_directory=True)
            (old / "cache-link").mkdir()
            (old / "cache-link/CMakeCache.txt").symlink_to(outside_cache)
            subprocess.run(["mv", str(old), str(new)], check=True)
            result = subprocess.run(["bash", "-c", lease._cmake_cache_cleanup_shell(), "cleanup", str(new)],
                                    capture_output=True, text=True, timeout=60, cwd=root)
            self.assertEqual(result.returncode, 0, result.stderr)
            # A newline cannot occur in CMake's one-line cache entry, so that case is still stale metadata.
            for name in entries:
                build = new / name
                keep = name in ("build/matching", "build/no-internal", "node_modules/dependency/build")
                self.assertEqual((build / "CMakeCache.txt").exists(), keep, name)
                self.assertEqual((build / "CMakeFiles").exists(), keep, name)
                self.assertEqual((build / "libbuilt.so").read_text(), "warm output")
            self.assertIn("cmake_caches_removed=4", result.stdout)
            self.assertIn("/unrelated/older/base ->", result.stdout)
            self.assertTrue(outside_cache.exists())
            self.assertTrue((new / "cache-link/CMakeCache.txt").is_symlink())
            self.assertFalse((root / "UNEXPECTED").exists())

    def test_failed_removal_is_reported_without_counting_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            build = Path(tmp).resolve()
            (build / "CMakeCache.txt").write_text("CMAKE_CACHEFILE_DIR:INTERNAL=/old\n")
            shell = "rm() { return 1; }; " + lease._cmake_cache_cleanup_shell()
            result = subprocess.run(["bash", "-c", shell, "cleanup", str(build)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 1)
            self.assertIn("cmake_caches_removed=0", result.stdout)
            self.assertTrue((build / "CMakeCache.txt").exists())


if __name__ == "__main__":
    unittest.main()
