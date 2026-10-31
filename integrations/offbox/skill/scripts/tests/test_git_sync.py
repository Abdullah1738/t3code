"""Exercise Git metadata sync with real Git/rsync and an offline SSH transport."""
import contextlib
import hashlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import ssh_sync
from offbox_lib.common import OffboxError


class GitSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="offbox-git-test-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                   GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")
        self.stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.source = self.base / "source"
        self.source.mkdir()
        self.git(self.source, "init", "-q", "--initial-branch=main", "--template=")
        (self.source / "tracked.txt").write_text("base\n")
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-qm", "base")
        self.base_head = self.git(self.source, "rev-parse", "HEAD")
        self.git(self.source, "update-ref", "refs/remotes/origin/base", self.base_head)
        self.worktree = self.base / "selected worktree"
        self.git(self.source, "worktree", "add", "-q", "--detach", str(self.worktree))
        (self.worktree / "tracked.txt").write_text("selected\n")
        self.git(self.worktree, "commit", "-qam", "selected commit")
        self.head = self.git(self.worktree, "rev-parse", "HEAD")
        self.remote = self.base / "remote checkout"
        self.real_run = subprocess.run
        self.stack.enter_context(patch.object(ssh_sync, "log"))
        # Keep actual rsync/Git behavior; replace only the network transport.
        self.stack.enter_context(patch.object(ssh_sync.subprocess, "run", side_effect=self.run_local))
        self.stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=self.ssh_local))

    @staticmethod
    def git(root, *args):
        p = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
        if p.returncode:
            raise AssertionError(f"git {args}: {p.stderr}")
        return p.stdout.strip()

    def run_local(self, cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            cmd = list(cmd)
            cmd[-1] = cmd[-1].removeprefix("testbox:")
        return self.real_run(cmd, **kwargs)

    def ssh_local(self, box, command, input=None, timeout=120, check=False):
        return self.real_run(["sh", "-c", command], input=input, capture_output=True,
                             timeout=timeout, check=check)

    def push(self, root=None, **kwargs):
        return ssh_sync.push("testbox", root or self.worktree, str(self.remote), **kwargs)

    @staticmethod
    def contents(root):
        return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in root.rglob("*") if p.is_file()}

    def test_detached_worktree_history_is_portable_and_source_is_unchanged(self):
        before = self.contents(self.source / ".git")
        self.push(with_git=True)
        self.assertEqual(before, self.contents(self.source / ".git"))
        self.assertTrue((self.remote / ".git").is_dir(), "remote needs a real git-dir, not a local pointer")
        # Make every original worktree gitdir path inaccessible, as it is on a VM.
        self.source.rename(self.base / "source unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD^"), self.base_head)
        self.assertEqual(self.git(self.remote, "show", "HEAD^:tracked.txt"), "base")
        self.assertEqual(self.git(self.remote, "merge-base", "HEAD", "origin/base"), self.base_head)
        self.assertEqual(self.git(self.remote, "status", "--porcelain"), "")
        self.git(self.remote, "fsck", "--full")

    def test_excludes_private_metadata_other_worktrees_and_unreachable_objects(self):
        sibling = self.base / "unrelated worktree"
        self.git(self.source, "worktree", "add", "-q", "-b", "unrelated", str(sibling))
        (sibling / "private.txt").write_text("unrelated committed content\n")
        self.git(sibling, "add", ".")
        self.git(sibling, "commit", "-qm", "unrelated")
        unrelated = self.git(sibling, "rev-parse", "HEAD")
        self.git(self.source, "config", "remote.origin.url", "https://fake-secret@example.invalid/repo")
        (self.source / ".git" / "credentials").write_text("private credential canary")
        (self.source / ".git" / "hooks").mkdir(exist_ok=True)
        (self.source / ".git" / "hooks" / "pre-commit").write_text("private hook canary")
        (self.worktree / ".env").write_text("private env canary")
        (self.worktree / "credentials.json").write_text("private file canary")
        self.git(self.worktree, "add", ".env", "credentials.json")
        staged = self.git(self.worktree, "rev-parse", ":.env")
        self.git(self.worktree, "tag", "-a", "v1", "-m", "ancestor tag", self.base_head)
        # Ensure object packing cannot simply copy an existing shared pack.
        self.git(self.source, "repack", "-ad")
        before = self.contents(self.source / ".git")
        self.push(with_git=True, includes=[".git"])
        self.assertEqual(before, self.contents(self.source / ".git"))
        self.source.rename(self.base / "source unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "v1^{}"), self.base_head)
        self.assertNotIn("unrelated", self.git(self.remote, "for-each-ref"))
        for oid in (unrelated, staged):
            p = subprocess.run(["git", "-C", str(self.remote), "cat-file", "-e", oid], capture_output=True)
            self.assertNotEqual(p.returncode, 0)
        for path in (".git/worktrees", ".git/hooks", ".git/logs", ".git/credentials",
                     ".git/commondir", ".git/objects/info/alternates", ".env", "credentials.json"):
            self.assertFalse((self.remote / path).exists(), path)
        self.assertNotIn("fake-secret", (self.remote / ".git/config").read_text())
        self.git(self.remote, "fsck", "--full")

    def test_pack_stream_does_not_require_writable_source_objects(self):
        objects = self.source / ".git/objects"
        directories = [objects, *(p for p in objects.rglob("*") if p.is_dir())]
        modes = [(path, path.stat().st_mode & 0o777) for path in directories]
        before = self.contents(self.source / ".git")
        try:
            for path, mode in modes:
                path.chmod(mode & ~0o222)
            self.push(with_git=True)
        finally:
            for path, mode in modes:
                path.chmod(mode)
        self.assertEqual(before, self.contents(self.source / ".git"))
        self.source.rename(self.base / "source unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD^"), self.base_head)
        self.git(self.remote, "fsck", "--full")

    def test_branch_head_dirty_files_and_warm_pointer_replacement(self):
        self.git(self.worktree, "switch", "-qc", "selected")
        (self.worktree / "tracked.txt").write_text("staged\n")
        self.git(self.worktree, "add", "tracked.txt")
        (self.worktree / "tracked.txt").write_text("unstaged\n")
        (self.worktree / "untracked.txt").write_text("new\n")
        self.remote.mkdir()
        (self.remote / ".git").write_bytes((self.worktree / ".git").read_bytes())
        before = self.contents(self.source / ".git")
        self.push(with_git=True)
        self.assertEqual(before, self.contents(self.source / ".git"))
        self.assertEqual(self.git(self.remote, "symbolic-ref", "HEAD"), "refs/heads/selected")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "show", ":tracked.txt"), "selected")
        self.assertEqual((self.remote / "tracked.txt").read_text(), "unstaged\n")
        self.assertEqual((self.remote / "untracked.txt").read_text(), "new\n")
        # Subsequent sync replaces stale history, rather than retaining remote refs.
        self.git(self.remote, "update-ref", "refs/heads/stale", self.head)
        self.git(self.worktree, "commit", "-qam", "next")
        new_head = self.git(self.worktree, "rev-parse", "HEAD")
        self.push(with_git=True)
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), new_head)
        self.assertNotIn("stale", self.git(self.remote, "for-each-ref"))

    def test_plain_checkout_and_no_git_sync(self):
        self.push(root=self.source, with_git=True)
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.base_head)
        self.assertEqual(self.git(self.remote, "status", "--porcelain"), "")
        before = self.contents(self.remote / ".git")
        self.push(with_git=False)
        self.assertEqual(before, self.contents(self.remote / ".git"))
        self.remote = self.base / "fresh no git"
        self.push(with_git=False, includes=[".git"])
        self.assertFalse((self.remote / ".git").exists())

    def test_shallow_worktree_keeps_only_available_ancestry(self):
        self.git(self.worktree, "branch", "tip")
        shallow = self.base / "shallow"
        self.git(self.source, "clone", "-q", "--depth=1", "--branch=tip", self.source.as_uri(), str(shallow))
        self.worktree = self.base / "shallow worktree"
        self.git(shallow, "worktree", "add", "-q", "--detach", str(self.worktree))
        self.push(with_git=True)
        shallow.rename(self.base / "shallow unavailable")
        self.source.rename(self.base / "source unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "--is-shallow-repository"), "true")
        self.assertEqual(self.git(self.remote, "rev-list", "HEAD"), self.head)
        self.git(self.remote, "fsck", "--full")

    def test_alternate_objects_become_self_contained(self):
        shared = self.base / "shared clone"
        self.git(self.source, "clone", "-q", "--shared", str(self.source), str(shared))
        self.worktree = self.base / "shared worktree"
        self.git(shared, "worktree", "add", "-q", "--detach", str(self.worktree))
        self.push(with_git=True)
        shared.rename(self.base / "shared unavailable")
        self.source.rename(self.base / "source unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.base_head)
        self.assertEqual(self.git(self.remote, "show", "HEAD:tracked.txt"), "base")
        self.assertFalse((self.remote / ".git/objects/info/alternates").exists())
        self.git(self.remote, "fsck", "--full")

    def partial_clone(self, *extra):
        self.git(self.worktree, "branch", "tip")
        self.git(self.source, "config", "uploadpack.allowFilter", "true")
        partial = self.base / "partial clone"
        self.git(self.source, "clone", "-q", "--filter=blob:none", "--single-branch",
                 "--branch=tip", *extra, self.source.as_uri(), str(partial))
        return partial

    def test_partial_clone_missing_history_sends_head_only_without_fetching(self):
        partial = self.partial_clone()
        self.git(partial, "switch", "-q", "--detach", self.head)
        missing = self.git(partial, "rev-list", "--objects", "--missing=print", "HEAD")
        self.assertTrue(any(row.startswith("?") for row in missing.splitlines()))
        self.source.rename(self.base / "source unavailable")
        before = self.contents(partial / ".git")
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            self.push(root=partial, with_git=True)
        self.assertEqual(before, self.contents(partial / ".git"))
        self.assertIn("partial clone missing 1 older objects; sending HEAD only", err.getvalue())
        self.assertEqual(len(err.getvalue().strip().splitlines()), 1)
        partial.rename(self.base / "partial unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "rev-parse", "--is-shallow-repository"), "true")
        self.assertEqual(self.git(self.remote, "rev-list", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "show", "HEAD:tracked.txt"), "selected")
        self.assertEqual(self.git(self.remote, "status", "--porcelain"), "")
        self.git(self.remote, "fsck", "--full")

    def test_partial_clone_missing_head_files_fails_fast_without_fetching(self):
        partial = self.partial_clone("--no-checkout")
        self.source.rename(self.base / "source unavailable")
        before = self.contents(partial / ".git")
        with self.assertRaisesRegex(OffboxError, "partial clone and some of HEAD's own files are not local"):
            self.push(root=partial, with_git=True)
        self.assertEqual(before, self.contents(partial / ".git"))
        self.assertFalse(self.remote.exists())

    def test_missing_objects_outside_a_partial_clone_still_fail_the_pack(self):
        blob = self.git(self.worktree, "rev-parse", f"{self.base_head}:tracked.txt")
        loose = self.source / ".git/objects" / blob[:2] / blob[2:]
        loose.chmod(0o600)
        loose.unlink()
        with self.assertRaisesRegex(OffboxError, "git pack-objects failed"):
            self.push(with_git=True)
        self.assertFalse(self.remote.exists())

    def test_partial_clone_with_all_reachable_objects_exports_offline(self):
        partial = self.partial_clone()
        self.assertEqual(self.git(partial, "show", "HEAD^:tracked.txt"), "base")
        missing = self.git(partial, "rev-list", "--objects", "--missing=print", "HEAD")
        self.assertFalse(any(row.startswith("?") for row in missing.splitlines()))
        self.source.rename(self.base / "source unavailable")
        before = self.contents(partial / ".git")
        self.push(root=partial, with_git=True)
        self.assertEqual(before, self.contents(partial / ".git"))
        partial.rename(self.base / "partial unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), self.head)
        self.assertEqual(self.git(self.remote, "show", "HEAD^:tracked.txt"), "base")
        self.git(self.remote, "fsck", "--full")

    def test_metadata_partial_transfer_is_fatal_and_cleans_staging(self):
        def partial(cmd, **kwargs):
            if cmd[0] == ssh_sync.RSYNC and "/.offbox-git-" in cmd[-1]:
                return subprocess.CompletedProcess(cmd, 24, "", "file vanished")
            return self.run_local(cmd, **kwargs)
        with patch.object(ssh_sync.subprocess, "run", side_effect=partial):
            with self.assertRaisesRegex(OffboxError, "Git history sync.*24"):
                self.push(with_git=True)
        self.assertFalse(list(self.remote.glob(".offbox-git-*")))
        self.assertFalse((self.remote / ".git").exists())

    def test_unborn_head_fails_before_sync(self):
        empty = self.base / "empty"
        empty.mkdir()
        self.git(empty, "init", "-q", "--template=")
        with self.assertRaisesRegex(OffboxError, "committed HEAD"):
            self.push(root=empty, with_git=True)
        self.assertFalse(self.remote.exists())

    def test_changed_head_during_sync_fails_instead_of_running_stale_history(self):
        def change_head(cmd, **kwargs):
            result = self.run_local(cmd, **kwargs)
            if cmd[0] == ssh_sync.RSYNC and "/.offbox-git-" not in cmd[-1]:
                self.git(self.worktree, "switch", "-q", "--detach", self.base_head)
            return result
        with patch.object(ssh_sync.subprocess, "run", side_effect=change_head):
            with self.assertRaisesRegex(OffboxError, "HEAD changed while syncing"):
                self.push(with_git=True)

    def test_replace_refs_do_not_rewrite_exported_ancestry(self):
        self.git(self.worktree, "replace", self.head, self.base_head)
        before = self.contents(self.source / ".git")
        self.push(with_git=True)
        self.assertEqual(before, self.contents(self.source / ".git"))
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD^"), self.base_head)
        self.assertEqual(self.git(self.remote, "show", "HEAD:tracked.txt"), "selected")
        self.assertFalse((self.remote / ".git/refs/replace").exists())

    def test_sha256_history_keeps_object_format(self):
        source = self.base / "sha256"
        source.mkdir()
        self.git(source, "init", "-q", "--template=", "--object-format=sha256")
        (source / "content").write_text("sha256 content")
        self.git(source, "add", ".")
        self.git(source, "commit", "-qm", "sha256")
        head = self.git(source, "rev-parse", "HEAD")
        self.worktree = self.base / "sha256 worktree"
        self.git(source, "worktree", "add", "-q", "--detach", str(self.worktree))
        self.push(with_git=True)
        source.rename(self.base / "sha256 unavailable")
        self.assertEqual(self.git(self.remote, "rev-parse", "HEAD"), head)
        self.assertEqual(self.git(self.remote, "rev-parse", "--show-object-format"), "sha256")
        self.git(self.remote, "fsck", "--full")


if __name__ == "__main__":
    unittest.main()
