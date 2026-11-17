"""Tracked filter overrides stay additive and never send modified secrets implicitly."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import ssh_sync
from test_tracked_ignored import TrackedIgnoredTests


class TrackedFiltersTests(unittest.TestCase):
    def setUp(self):
        self.fx = TrackedIgnoredTests()
        self.fx.setUp()
        self.addCleanup(self.fx.doCleanups)
        self.paths = {
            "pkg/__pycache__/m.cpython-315.pyc": "heavy",
            "infra/.terraform/.terraform.lock.hcl": "heavy",
            "vend/fixtures/a/node_modules/@fx/p/index.js": "node_modules",
            "node_modules/x/index.js": "blocked_node",
            "fixtures/key1.pem": "clean_secret",
            "fixtures/root-ca.pem": "dirty_secret",
            ".env": "dirty_secret",
            "link/node_modules/x/index.js": "blocked_node",
        }
        for path in self.paths:
            self.fx.write(path, "fixture\n")
        self.fx.git("add", "-f", ".")
        self.fx.git("commit", "-qm", "filter fixtures")
        for path, kind in self.paths.items():
            if kind == "dirty_secret":
                self.fx.write(path, "modified\n")
        self.fx.write("pkg/__pycache__/other.pyc", "untracked\n")
        target = Path(self.fx.tmp.name) / "linked-target"
        shutil.move(self.fx.src / "link", target)
        os.symlink(target, self.fx.src / "link")

    def push(self, with_git=False, includes=None):
        st = ssh_sync._push_files("testbox", self.fx.src, str(self.fx.remote), with_git, 60, includes)
        expected = ssh_sync._tracked_content(self.fx.src, includes, with_git)
        st.update(ssh_sync._verify_content("testbox", self.fx.src, str(self.fx.remote), expected, 60, None))
        return st

    def test_repo_matrix_and_counters(self):
        for with_git in (False, True):
            with self.subTest(with_git=with_git):
                self.fx.remote = Path(self.fx.tmp.name) / f"remote-{with_git}"
                st = self.push(with_git)
                for path, kind in self.paths.items():
                    sent = kind in ("heavy", "node_modules") or (with_git and kind == "clean_secret")
                    if path.startswith("link/"):
                        self.assertTrue((self.fx.remote / "link").is_symlink())
                        self.assertNotIn(path, ssh_sync._tracked_content(self.fx.src, None, with_git))
                    else:
                        self.assertEqual(self.fx.on_box(path), sent, path)
                self.assertFalse(self.fx.on_box("pkg/__pycache__/other.pyc"))
                self.assertEqual(st["tracked_heavy"], 2)
                self.assertEqual(st["tracked_heavy_sent"], 2)
                self.assertEqual(st["tracked_node_modules_sent"], 2)
                self.assertEqual(st["tracked_secret_sent"], 2 if with_git else 0)
                self.assertEqual(st["tracked_left_out"], {"secret": 2 if with_git else 4, "node_modules": 2})
                self.assertLessEqual(len(st["tracked_left_out_first"]), 5)
                note = ssh_sync.tracked_left_out_note(st)
                self.assertEqual(note.count("tracked files not synced"), 1)
                self.assertNotIn("\n", note)
                left = sum(st["tracked_left_out"].values())
                self.assertEqual(ssh_sync.verified_note(st),
                    f"verified {st['verified']} of {st['tracked_total']} tracked files ({left} left out, see above)")
                hints = ssh_sync.tracked_secret_matches(self.fx.src, None, with_git)
                self.assertEqual(set(hints), {".env", "fixtures/root-ca.pem"} if with_git else
                                 {".env", "config/.env", "fixtures/key1.pem", "fixtures/root-ca.pem"})
                again = self.push(with_git)
                for name in ("heavy", "node_modules", "secret"):
                    self.assertEqual(again[f"tracked_{name}_sent"], 0)
                self.assertIsNone(ssh_sync.tracked_ignored_note(again))

    def test_pass_two_preserves_box_installs_even_with_redundant_include(self):
        self.fx.remote.mkdir()
        keep = ["pkg/__pycache__/box.pyc", "infra/.terraform/providers/box",
                "vend/fixtures/a/node_modules/box", "node_modules/box", "nested/.gradle/box"]
        for path in keep:
            p = self.fx.remote / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("box install\n")
        self.push(includes=["vend/fixtures/a/node_modules/@fx/p/index.js",
                            "infra/.terraform/.terraform.lock.hcl"])
        for path in keep:
            self.assertEqual((self.fx.remote / path).read_text(), "box install\n")
        for cmd in self.fx.rsyncs:
            if "--files-from=-" in cmd:
                self.assertFalse(any(arg.startswith("--delete") for arg in cmd))

    def test_untracked_include_below_excluded_tracked_ancestor_still_refused(self):
        path = "vend/fixtures/a/node_modules/@fx/p/untracked.js"
        self.fx.write(path, "scratch\n")
        with self.assertRaisesRegex(ssh_sync.OffboxError, "excluded ancestor"):
            ssh_sync.push_filters(self.fx.src, False, [path])

    def test_staged_and_unstaged_secrets_are_both_dirty(self):
        self.fx.git("add", "-f", "fixtures/root-ca.pem")
        dirty = ssh_sync._dirty_tracked(self.fx.src)
        self.assertIn("fixtures/root-ca.pem", dirty)
        self.assertIn(".env", dirty)
        sent = ssh_sync._tracked_skipped(self.fx.src, set(), True, dirty=dirty)
        self.assertNotIn("fixtures/root-ca.pem", sent)
        self.assertNotIn(".env", sent)
        self.assertIn("fixtures/key1.pem", sent)

    def test_index_flags_cannot_hide_modified_secrets(self):
        for object_format in ("sha1", "sha256"):
            self.fx.src = Path(self.fx.tmp.name) / object_format
            self.fx.src.mkdir()
            self.fx.remote = Path(self.fx.tmp.name) / f"remote-{object_format}"
            self.fx.git("init", "-q", f"--object-format={object_format}")
            cases = []
            flags = {"ordinary": (), "assume": ("--assume-unchanged",),
                     "skip": ("--skip-worktree",), "both": ("--assume-unchanged", "--skip-worktree")}
            for flag in flags:
                for change in ("clean", "unstaged", "staged", "staged_reverted"):
                    path = f"fixtures/{flag}-{change}.pem"
                    self.fx.write(path, "fixture\n")
                    cases.append((path, flag, change))
            self.fx.git("add", "-f", "--", *(path for path, _, _ in cases))
            self.fx.git("commit", "-qm", "index flag fixtures")
            for path, flag, change in cases:
                if change in ("staged", "staged_reverted"):
                    self.fx.write(path, "staged\n")
                    self.fx.git("add", "-f", "--", path)
                for option in flags[flag]:
                    self.fx.git("update-index", option, "--", path)
                if change == "unstaged":
                    self.fx.write(path, "modified\n")
                elif change == "staged_reverted":
                    self.fx.write(path, "fixture\n")
            st = self.push(True)
            hints = ssh_sync.tracked_secret_matches(self.fx.src, None, True)
            verified = ssh_sync._tracked_content(self.fx.src, None, True)
            for path, flag, change in cases:
                with self.subTest(object_format=object_format, flag=flag, change=change):
                    clean = change == "clean"
                    self.assertEqual(self.fx.on_box(path), clean)
                    self.assertEqual(path in verified, clean)
                    self.assertEqual(path in hints, not clean)
            self.assertEqual(st["tracked_secret_sent"], 4)
            self.assertEqual(st["tracked_left_out"]["secret"], 12)

    def test_secret_symlinks_compare_with_head_in_both_object_formats(self):
        for object_format in ("sha1", "sha256"):
            self.fx.src = Path(self.fx.tmp.name) / object_format
            self.fx.src.mkdir()
            self.fx.git("init", "-q", f"--object-format={object_format}")
            for path in ("clean.pem", "dirty.pem"):
                os.symlink("committed-target", self.fx.src / path)
            self.fx.git("add", "--", "clean.pem", "dirty.pem")
            self.fx.git("commit", "-qm", "secret symlinks")
            self.fx.git("update-index", "--assume-unchanged", "--", "dirty.pem")
            (self.fx.src / "dirty.pem").unlink()
            os.symlink("modified-target", self.fx.src / "dirty.pem")
            with self.subTest(object_format=object_format):
                sent = ssh_sync._tracked_skipped(self.fx.src, set(), True)
                self.assertIn("clean.pem", sent)
                self.assertNotIn("dirty.pem", sent)
                expected = ssh_sync._tracked_content(self.fx.src, None, True)
                self.assertIn("clean.pem", expected)
                self.assertNotIn("dirty.pem", expected)

    def test_push_checks_dirty_set_once_and_records_telemetry(self):
        with patch.object(ssh_sync, "_dirty_tracked", wraps=ssh_sync._dirty_tracked) as dirty, \
             patch.object(ssh_sync.git_snapshot, "snapshot") as snapshot, \
             patch.object(ssh_sync.toollog, "span") as span:
            snapshot.return_value.__enter__.return_value = None
            data = {"props": {}}
            span.return_value.__enter__.return_value = data
            st = ssh_sync.push("testbox", self.fx.src, str(self.fx.remote), True,
                               includes=["fixtures/key1.pem"])
        self.assertEqual(dirty.call_count, 1)
        for key in ssh_sync.TRACKED_SYNC_FIELDS:
            self.assertEqual(data["props"][key], st[key])

    def test_missing_filtered_files_do_not_delete_box_caches(self):
        self.push(True)
        path = "pkg/__pycache__/m.cpython-315.pyc"
        (self.fx.src / path).unlink()
        self.push(True)
        self.assertEqual((self.fx.remote / path).read_text(), "fixture\n")

    def test_left_out_paths_with_control_characters_stay_on_one_line(self):
        note = ssh_sync.tracked_left_out_note({
            "tracked_left_out": {"secret": 1},
            "tracked_left_out_first": ["fixtures/line\nbreak\tkey.pem"]})
        self.assertNotIn("\n", note)
        self.assertNotIn("\t", note)
        self.assertIn(r"line\nbreak\tkey.pem", note)

    def test_nested_secret_still_obeys_secret_rule_inside_heavy_or_modules(self):
        paths = ["pkg/__pycache__/key.pem", "vend/node_modules/key.pem",
                 "pkg/__pycache__/.env.example"]
        for path in paths:
            self.fx.write(path, "fixture\n")
        self.fx.git("add", "-f", "--", *paths)
        self.fx.git("commit", "-qm", "overlapping filters")
        self.fx.write(paths[0], "modified\n")
        for with_git in (False, True):
            self.fx.remote = Path(self.fx.tmp.name) / f"overlap-{with_git}"
            self.push(with_git)
            self.assertFalse(self.fx.on_box(paths[0]))
            self.assertEqual(self.fx.on_box(paths[1]), with_git)
            self.assertTrue(self.fx.on_box(paths[2]))

    def test_transfer_counter_handles_local_and_ssh_rsync_directions(self):
        for direction in (">", "<"):
            with self.subTest(direction=direction):
                output = "\n".join(
                    f"{ssh_sync.ITEM}{direction}f+++++++++ {path}"
                    for path in ("pkg/__pycache__/m.cpython-315.pyc",
                                 "infra/.terraform/.terraform.lock.hcl",
                                 "vend/fixtures/a/node_modules/@fx/p/index.js", "fixtures/key1.pem"))
                with patch.object(ssh_sync, "_rsync", side_effect=["", output]):
                    st = ssh_sync._push_files("testbox", self.fx.src, str(self.fx.remote), True, 60, None)
                self.assertEqual(st["tracked_heavy_sent"], 2)
                self.assertEqual(st["tracked_node_modules_sent"], 1)
                self.assertEqual(st["tracked_secret_sent"], 1)

    def test_no_left_out_preserves_verified_wording(self):
        self.assertEqual(ssh_sync.verified_note({"verified": 123, "tracked_total": 123}),
                         "verified 123 tracked files")
        self.assertIsNone(ssh_sync.tracked_left_out_note({}))

    def test_dirty_check_failure_fails_closed(self):
        with patch.object(ssh_sync.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"", b"")):
            with self.assertRaisesRegex(ssh_sync.OffboxError, "against HEAD"):
                ssh_sync._dirty_tracked(self.fx.src)


if __name__ == "__main__":
    unittest.main()
