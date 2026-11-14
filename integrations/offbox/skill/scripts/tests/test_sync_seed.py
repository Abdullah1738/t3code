"""Offline first-sync seeding and progress tests."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tests._env import clean_env
from offbox_lib import runs, ssh_sync  # noqa: E402
from test_capacity import Isolated  # noqa: E402


class SyncSeedTests(Isolated):
    def setUp(self):
        super().setUp()
        self.base = Path(self.tmp.name).resolve()
        self.src = self.base / "repo"
        self.src.mkdir()
        self.box_home = self.base / "box"
        (self.box_home / "w").mkdir(parents=True)
        (self.src / "tracked.txt").write_text("unchanged\n")
        self.current = "w/current-123abc"
        self.sibling = "w/sibling-abcdef"
        self.rsyncs = []
        self.real_run = subprocess.run
        self.stack.enter_context(patch.object(ssh_sync, "log"))
        self.stack.enter_context(patch.object(ssh_sync, "_watch_rsync", side_effect=self.watch_local))
        self.stack.enter_context(patch.object(ssh_sync, "_progress_args", return_value=()))

        self.stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=self.fake_ssh))
        self.stack.enter_context(patch.object(ssh_sync.subprocess, "run", side_effect=self.run_local))

    def add_run(self, remote, root=None, box="box", at=1):
        root = root or str(self.src)
        self.con.execute("INSERT INTO runs(run_id,box_id,repo_root,remote_dir,start_at) VALUES (?,?,?,?,?)",
                         (f"r{self.con.total_changes}", box, root, remote, at))
        self.con.commit()

    def fake_ssh(self, box, command, **kwargs):
        return self.real_run(["sh", "-c", command], env=clean_env(HOME=str(self.box_home)),
                             capture_output=True, timeout=kwargs.get("timeout"))

    def watch_local(self, cmd, timeout, input=None, **kwargs):
        return subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="surrogateescape",
                              timeout=timeout, input=input)

    def run_local(self, cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            self.rsyncs.append(list(cmd))
            cmd = list(cmd)
            cmd[-1] = str(self.box_home / cmd[-1].removeprefix("box:"))
        return self.real_run(cmd, **kwargs)

    def push(self):
        with patch.object(runs.identity, "repo_key", return_value="repo"):
            candidates = runs._seed_candidates(self.con, "box", self.current, "repo")
        return ssh_sync.push("box", self.src, self.current, seed_candidates=candidates)

    def test_new_checkout_copies_sibling_without_sharing_inodes_or_deleting_it(self):
        sibling = self.box_home / self.sibling
        sibling.mkdir()
        (sibling / "tracked.txt").write_text("unchanged\n")
        # rsync compares size and mtime before using the basis file.
        os.utime(sibling / "tracked.txt", ns=((self.src / "tracked.txt").stat().st_atime_ns,
                                                (self.src / "tracked.txt").stat().st_mtime_ns))
        (sibling / "sibling-only.txt").write_text("keep\n")
        self.add_run(self.sibling)
        self.push()
        self.assertIn("--copy-dest=../sibling-abcdef", self.rsyncs[0])
        self.assertIn("--delete", self.rsyncs[0])
        self.assertFalse(any("--link-dest" in a for a in self.rsyncs[0]))
        self.assertTrue((sibling / "sibling-only.txt").exists())
        dest = self.box_home / self.current / "tracked.txt"
        self.assertNotEqual(dest.stat().st_ino, (sibling / "tracked.txt").stat().st_ino)
        dest.write_text("changed\n")
        self.assertEqual((sibling / "tracked.txt").read_text(), "unchanged\n")
        ssh_sync.log.assert_any_call(f"push_seed box {self.current} from={self.sibling}")

    def test_existing_checkout_does_not_seed(self):
        (self.box_home / self.sibling).mkdir()
        (self.box_home / self.current).mkdir()
        self.add_run(self.sibling)
        self.push()
        self.assertFalse(any(a.startswith("--copy-dest") for a in self.rsyncs[0]))

    def test_seed_same_size_same_second_different_content_is_not_reused(self):
        sibling = self.box_home / self.sibling
        sibling.mkdir()
        src, basis = self.src / "tracked.txt", sibling / "tracked.txt"
        src.write_text("pin=721dcbf6\n")
        basis.write_text("pin=0366b5ae\n")
        os.utime(src, ns=(1794618566083649423, 1794618566083649423))
        os.utime(basis, ns=(1794618566083434298, 1794618566083434298))
        self.add_run(self.sibling)
        self.push()
        self.assertEqual((self.box_home / self.current / "tracked.txt").read_bytes(), src.read_bytes())
        self.assertEqual(basis.read_text(), "pin=0366b5ae\n")
        self.assertIn("--checksum", self.rsyncs[0])

    def test_wrong_box_repo_and_invalid_names_are_ignored(self):
        other = self.base / "other"
        other.mkdir()
        self.add_run("w/other-111111", box="other-box")
        self.add_run("w/other-222222", root=str(other))
        self.add_run("w/../bad")
        with patch.object(runs.identity, "repo_key", side_effect=lambda p: "other" if p == other else "repo"):
            self.assertEqual(runs._seed_candidates(self.con, "box", self.current, "repo"), [])
        self.assertEqual(ssh_sync._seed("box", self.current, []), (True, None))

    def test_missing_newest_candidate_tries_older(self):
        self.add_run("w/missing-123456", at=20)
        self.add_run(self.sibling, at=10)
        (self.box_home / self.sibling).mkdir()
        self.push()
        self.assertIn("--copy-dest=../sibling-abcdef", self.rsyncs[0])

    def test_probe_failure_falls_back_to_plain_push(self):
        self.add_run(self.sibling)
        with patch.object(ssh_sync, "ssh", return_value=subprocess.CompletedProcess([], 255, b"", b"failed")):
            self.push()
        self.assertFalse(any(a.startswith("--copy-dest") for a in self.rsyncs[0]))

if __name__ == "__main__":
    unittest.main()
