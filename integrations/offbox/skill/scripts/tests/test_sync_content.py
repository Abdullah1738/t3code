"""Tracked disk bytes, including rsync quick-check collisions, must reach the command."""
import os
import json
import fnmatch
import sqlite3
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import common, ssh_sync
from offbox_lib.common import OffboxError


class SyncContentTests(unittest.TestCase):
    def setUp(self):
        from test_tracked_ignored import TrackedIgnoredTests
        self.fx = TrackedIgnoredTests()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.enterContext(patch.object(ssh_sync, "ssh", side_effect=self.ssh_local))
        self.events_original = ssh_sync._content_event
        self.events = self.enterContext(patch.object(ssh_sync, "_content_event"))
        self.calls = []

    def ssh_local(self, box, command, input=None, timeout=120, check=False):
        self.calls.append(command)
        return self.fx.real_run(["sh", "-c", command], input=input, capture_output=True,
                                timeout=timeout, check=check)

    def collide(self, rel="package.json"):
        local, remote = self.fx.src / rel, self.fx.remote / rel
        remote.write_bytes(b"x" * local.stat().st_size)
        os.utime(remote, ns=(local.stat().st_atime_ns, local.stat().st_mtime_ns))

    def test_equal_size_and_mtime_is_repaired(self):
        self.fx.push()
        self.collide()
        st = self.fx.push()
        self.assertEqual((self.fx.remote / "package.json").read_bytes(),
                         (self.fx.src / "package.json").read_bytes())
        self.assertEqual(st["repaired"], 1)
        self.events.assert_called_once_with("testbox", ["package.json"], True, None)

    def test_clean_push_checks_once_without_an_extra_rsync(self):
        self.fx.push()
        self.fx.rsyncs.clear()
        self.calls.clear()
        st = self.fx.push()
        self.assertEqual(st["repaired"], 0)
        self.assertGreater(st["verified"], 3)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.fx.rsyncs), 2)  # normal and tracked-ignored pass, no repair
        self.events.assert_not_called()

    def test_compiled_filter_matches_all_existing_rule_forms(self):
        def previous(path):
            parts = path.split("/")
            if any(fnmatch.fnmatch(parts[-1], t) for t in ssh_sync.SAFE_ENV_TEMPLATES):
                parts = parts[:-1]
            pats = [p.rstrip("/") for p in ssh_sync.SECRET_EXCLUDES + ssh_sync.HEAVY_EXCLUDES]
            if any(fnmatch.fnmatch(seg, pat) for seg in parts for pat in pats if "/" not in pat):
                return True
            joined = "/" + "/".join(parts)
            return any(joined.endswith("/" + p) or ("/" + p + "/") in joined for p in pats if "/" in p)
        cases = ["safe/file.txt", *ssh_sync.SAFE_ENV_TEMPLATES]
        for rule in ssh_sync.SECRET_EXCLUDES + ssh_sync.HEAVY_EXCLUDES:
            value = rule.rstrip("/").replace("*", "fixture")
            for prefix in ("", "nested/"):
                cases.extend([prefix + value, prefix + value + "/file", prefix + value + "/.env.example"])
        for path in cases:
            with self.subTest(path=path):
                self.assertEqual(ssh_sync._offbox_skips(path), previous(path))

    def test_secret_filters_and_explicit_includes(self):
        st = self.fx.push()
        self.assertFalse((self.fx.remote / "config/.env").exists())
        self.assertNotIn("config/.env", ssh_sync._tracked_content(self.fx.src, None))
        st = self.fx.push(includes=["config/.env"])
        self.collide("config/.env")
        st = self.fx.push(includes=["config/.env"])
        self.assertEqual(st["repaired"], 1)
        self.assertEqual((self.fx.remote / "config/.env").read_text(), "SECRET=1\n")

    def test_dirty_staged_unusual_paths_and_symlinks_use_disk_bytes(self):
        paths = ["space name", "line\nbreak", "café", "-dash"]
        for p in paths:
            self.fx.write(p, "stage\n")
        os.symlink("space name", self.fx.src / "link")
        self.fx.git("add", "--", *paths, "link")
        for p in paths:
            self.fx.write(p, "dirty\n")
        st = self.fx.push()
        for p in paths:
            self.assertEqual((self.fx.remote / p).read_text(), "dirty\n")
        self.assertTrue((self.fx.remote / "link").is_symlink())
        self.assertEqual(st["repaired"], 0)

    def test_deleted_tracked_ignored_file_is_removed_on_reuse(self):
        self.fx.push()
        (self.fx.src / "package-lock.json").unlink()
        st = self.fx.push()
        self.assertFalse((self.fx.remote / "package-lock.json").exists())
        self.assertEqual(st["repaired"], 1)

    def test_deletion_forms_for_ignored_tracked_files(self):
        # The whole class: unstaged delete, staged delete, untrack, and staged rename.
        cases = [("unlink", True), ("rm", True), ("untrack", False), ("rename", True)]
        for form, removed in cases:
            with self.subTest(form=form):
                path = "docs/" + form + " old\nname.txt"
                self.fx.write(path, "source\n")
                self.fx.git("add", "-f", "--", path)
                self.fx.git("commit", "-qm", "fixture")
                self.fx.push()
                if form == "unlink":
                    (self.fx.src / path).unlink()
                elif form == "rm":
                    self.fx.git("rm", "-q", "--", path)
                elif form == "untrack":
                    self.fx.git("rm", "-q", "--cached", "--", path)
                else:
                    self.fx.git("mv", "--", path, "docs/new name.txt")
                self.fx.push()
                self.assertEqual((self.fx.remote / path).exists(), not removed)

    def test_tracked_directory_replaced_by_regular_file_is_valid(self):
        self.fx.write("folder/child", "child\n")
        self.fx.git("add", "folder/child")
        self.fx.push()
        (self.fx.src / "folder/child").unlink()
        (self.fx.src / "folder").rmdir()
        self.fx.write("folder", "replacement\n")
        self.fx.push()
        self.assertEqual((self.fx.remote / "folder").read_text(), "replacement\n")

    def test_ignored_tracked_file_or_link_replaced_by_directory(self):
        for original in ("file", "link"):
            with self.subTest(original=original):
                path = "docs/" + original + " swap"
                if original == "file":
                    self.fx.write(path, "old\n")
                else:
                    os.symlink("KEEP.md", self.fx.src / path)
                self.fx.git("add", "-f", "--", path)
                self.fx.push()
                (self.fx.src / path).unlink()
                self.fx.write(path + "/child", "ignored\n")
                self.fx.write(path + "/credentials.json", "filtered fixture\n")
                st = self.fx.push()
                self.assertTrue((self.fx.remote / path).is_dir())
                self.assertFalse((self.fx.remote / path).is_symlink())
                self.assertEqual(list((self.fx.remote / path).iterdir()), [])
                self.assertEqual(st["repaired"], 1)

    def test_tracked_fifo_fails_without_reading_it(self):
        self.fx.write("docs/fifo", "file\n")
        self.fx.git("add", "-f", "docs/fifo")
        (self.fx.src / "docs/fifo").unlink()
        os.mkfifo(self.fx.src / "docs/fifo")
        with self.assertRaisesRegex(OffboxError, "unsupported tracked file type.*nothing ran"):
            self.fx.push()

    def test_working_tree_type_transition_table(self):
        kinds = ("file", "link", "dir")
        for before in kinds:
            for after in kinds:
                if before == after:
                    continue
                with self.subTest(before=before, after=after):
                    rel = f"swap-{before}-{after}"
                    path = self.fx.src / rel
                    def create(kind, text):
                        if kind == "link":
                            os.symlink("package.json", path)
                        else:
                            self.fx.write(rel + ("/child" if kind == "dir" else ""), text)
                    create(before, "before\n")
                    self.fx.git("add", "-f", "--", rel)
                    self.fx.push()
                    if before == "dir":
                        (path / "child").unlink()
                        path.rmdir()
                    else:
                        path.unlink()
                    create(after, "after\n")
                    self.fx.push()
                    remote = self.fx.remote / rel
                    if after == "link":
                        self.assertEqual(os.readlink(remote), "package.json")
                    else:
                        self.assertFalse(remote.is_symlink())
                        self.assertEqual((remote / "child" if after == "dir" else remote).read_text(), "after\n")

    def test_persistent_mismatch_fails_before_synced(self):
        self.fx.push()
        self.collide()
        original = ssh_sync._rsync
        def no_repair(*args, **kwargs):
            return "" if kwargs.get("phase") == "content-repair" else original(*args, **kwargs)
        with patch.object(ssh_sync, "_rsync", side_effect=no_repair):
            with self.assertRaisesRegex(OffboxError, "package.json.*nothing ran") as caught:
                self.fx.push()
        self.assertEqual(caught.exception.code, 90)
        self.events.assert_called_once_with("testbox", ["package.json"], False, None)

    def test_git_export_does_not_bypass_working_content_verification(self):
        ssh_sync.push("testbox", self.fx.src, str(self.fx.remote), with_git=True)
        self.collide()
        st = ssh_sync.push("testbox", self.fx.src, str(self.fx.remote), with_git=True)
        self.assertEqual(st["repaired"], 1)
        self.assertEqual((self.fx.remote / "package.json").read_text(), "{}\n")

    def test_malformed_verification_cannot_claim_success(self):
        with patch.object(ssh_sync, "ssh", return_value=subprocess.CompletedProcess([], 0, b"{}", b"")):
            with self.assertRaisesRegex(OffboxError, "verification response"):
                self.fx.push()

    def test_corrupt_index_cannot_skip_verification(self):
        (self.fx.src / ".git/index").write_bytes(b"broken index")
        with self.assertRaisesRegex(OffboxError, "cannot list tracked content"):
            self.fx.push()

    def test_missing_submodule_is_outside_the_parent_manifest(self):
        oid = subprocess.check_output(["git", "-C", str(self.fx.src), "rev-parse", "HEAD"]).strip().decode()
        self.fx.git("update-index", "--add", "--cacheinfo", f"160000,{oid},missing-submodule")
        self.assertNotIn("missing-submodule", ssh_sync._tracked_content(self.fx.src, None))

    def test_event_is_persisted_with_count_and_repair_outcome(self):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE events(ts REAL, box_id TEXT, kind TEXT, detail TEXT)")
        class Connection:
            def __getattr__(self, name):
                return getattr(con, name)
            def close(self):
                pass
        # Call the real implementation captured before the per-test mock.
        with patch.object(common, "db", return_value=Connection()), patch.object(common, "log"):
            self.events_original("box", ["x"], True, "run-proof")
        kind, detail = con.execute("SELECT kind,detail FROM events").fetchone()
        self.assertEqual(kind, "sync_content_mismatch")
        self.assertEqual(json.loads(detail), {"run_id": "run-proof", "path_count": 1,
                                             "paths": ["x"], "repaired": True})
        con.close()


if __name__ == "__main__":
    unittest.main()
