"""Git-tracked files the repo's .gitignore matches still reach the box (31 Oct, Crpko #696: a tracked
package-lock.json under `/package-lock.json` never synced, so `npm ci` failed with EUSAGE)."""
import contextlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import ssh_sync  # noqa: E402
from offbox_lib.common import OffboxError  # noqa: E402


class TrackedIgnoredTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="offbox-tracked-test-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.src, self.remote = base / "src", base / "remote"
        self.src.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                   GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, env, clear=True))
        self.git("init", "-q")
        self.write(".gitignore", "/package-lock.json\ndist/\ntest/*\ndocs/*\n!docs/KEEP.md\n.env*\n")
        self.write("package.json", "{}\n")
        self.write("package-lock.json", '{"lockfileVersion": 3}\n')
        self.write("src/api/test/route.js", "export {}\n")    # rsync reads `test/*` more broadly than git
        self.write("docs/KEEP.md", "kept\n")
        self.write("docs/forced.md", "force-added\n")
        self.write("config/.env", "SECRET=1\n")              # tracked, ignored and secret: stays home
        self.write("config/.env.example", "SECRET=\n")       # tracked, ignored, a safe template: goes
        self.write("vendor/node_modules/x/index.js", "1\n")  # tracked under a heavy exclude: stays home
        self.git("add", "-f", ".")
        self.git("commit", "-qm", "base")
        self.write("dist/local.js", "build output\n")        # ignored and untracked: never sent
        self.write("docs/untracked.md", "scratch\n")
        self.rsyncs = []
        self.real_run = subprocess.run
        stack.enter_context(patch.object(ssh_sync, "log"))
        stack.enter_context(patch.object(ssh_sync.subprocess, "run", side_effect=self.run_local))
        stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=AssertionError("no ssh expected")))

    def write(self, rel, text):
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.src), *args], check=True, capture_output=True)

    def run_local(self, cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            self.rsyncs.append(cmd)
            cmd = list(cmd)
            cmd[-1] = cmd[-1].removeprefix("testbox:")
        return self.real_run(cmd, **kwargs)

    def push(self, includes=None):
        return ssh_sync.push("testbox", self.src, str(self.remote), includes=includes)

    def on_box(self, rel):
        return (self.remote / rel).exists()

    def test_tracked_files_gitignore_skips_are_sent(self):
        st = self.push()
        self.assertTrue(self.on_box("package-lock.json"))
        self.assertTrue(self.on_box("src/api/test/route.js"))
        self.assertTrue(self.on_box("docs/KEEP.md"))
        self.assertTrue(self.on_box("docs/forced.md"))
        self.assertTrue(self.on_box("config/.env.example"))
        self.assertEqual(len(self.rsyncs), 2)
        self.assertGreaterEqual(st["tracked_ignored"], 4)
        self.assertIn("package-lock.json", st["tracked_ignored_first"])
        self.assertIn("package-lock.json", ssh_sync.tracked_ignored_note(st))
        again = self.push()
        self.assertEqual(again["tracked_ignored"], st["tracked_ignored"])
        self.assertIsNone(ssh_sync.tracked_ignored_note(again), "nothing changed: no line on later runs")

    def test_untracked_ignored_secret_and_heavy_files_stay_home(self):
        self.push()
        for rel in ("dist/local.js", "docs/untracked.md", "config/.env", "vendor/node_modules/x/index.js"):
            self.assertFalse(self.on_box(rel), rel)

    def test_secret_tracked_file_still_needs_include(self):
        self.push(includes=["config/.env"])
        self.assertTrue(self.on_box("config/.env"))

    def test_box_only_ignored_files_survive_and_the_lock_stays_current(self):
        self.push()
        (self.remote / "dist").mkdir(exist_ok=True)
        (self.remote / "dist/box.js").write_text("built on the box\n")
        self.write("package-lock.json", '{"lockfileVersion": 3, "v": 2}\n')
        self.push()
        self.assertTrue(self.on_box("dist/box.js"), "pass 1 --delete must not touch ignored box files")
        self.assertEqual((self.remote / "package-lock.json").read_text(), '{"lockfileVersion": 3, "v": 2}\n')

    def test_one_rsync_when_nothing_tracked_is_skipped(self):
        self.git("rm", "-q", "--cached", "package-lock.json", "src/api/test/route.js", "docs/KEEP.md",
                 "docs/forced.md", "config/.env.example")
        self.git("commit", "-qm", "untrack")
        st = self.push()
        self.assertEqual(len(self.rsyncs), 1)
        self.assertNotIn("tracked_ignored", st)
        self.assertIsNone(ssh_sync.tracked_ignored_note(st))

    def test_tracked_file_deleted_in_the_checkout_is_not_an_error(self):
        (self.src / "package-lock.json").unlink()
        st = self.push()
        self.assertFalse(self.on_box("package-lock.json"))
        self.assertNotIn("package-lock.json", st.get("tracked_ignored_first", []))

    def test_ignored_submodule_dir_is_not_sent(self):
        # A gitlink is listed by ls-files as a dir; pass 2 must not recurse into it past its .gitignore.
        sub = Path(self.tmp.name) / "sub"
        sub.mkdir()
        subprocess.run(["git", "-C", str(sub), "init", "-q"], check=True, capture_output=True)
        (sub / "f.txt").write_text("f\n")
        subprocess.run(["git", "-C", str(sub), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(sub), "commit", "-qm", "s"], check=True, capture_output=True)
        self.write(".gitignore", (self.src / ".gitignore").read_text() + "/ext/\n")
        subprocess.run(["git", "-C", str(self.src), "-c", "protocol.file.allow=always", "submodule", "add", "-f",
                        "-q", str(sub), "ext"], check=True, capture_output=True)
        self.git("commit", "-qam", "submodule")
        (self.src / "ext/scratch.log").write_text("local only\n")
        self.push()
        self.assertFalse(self.on_box("ext/scratch.log"))

    def test_tracked_dir_replaced_by_symlink_is_not_an_error(self):
        # Pass 1 sends the link itself; pass 2 must not walk the index entries that now sit under it.
        target = Path(self.tmp.name) / "elsewhere"
        target.mkdir()
        (target / "data.txt").write_text("d\n")
        self.write("linked/data.txt", "tracked\n")
        self.write(".gitignore", (self.src / ".gitignore").read_text() + "/linked/\n")
        self.git("add", "-f", "linked/data.txt")
        self.git("commit", "-qm", "linked")
        import shutil
        shutil.rmtree(self.src / "linked")
        os.symlink(target, self.src / "linked")
        sent = []
        real_run = ssh_sync.subprocess.run

        def record(cmd, **kw):
            if cmd[0] == ssh_sync.RSYNC and "--files-from=-" in cmd:
                sent.append(kw.get("input") or "")
            return self.run_local(cmd, **kw)
        with patch.object(ssh_sync.subprocess, "run", side_effect=record):
            st = self.push()
        self.assertTrue(sent, "the fixture still has other tracked-ignored files for pass 2")
        self.assertNotIn("linked/data.txt", "\0".join(sent))
        self.assertNotIn("linked/data.txt", st.get("tracked_ignored_first", []))
        self.assertTrue((self.remote / "linked").is_symlink())

    def test_case_alias_of_a_secret_dir_is_not_sent(self):
        # APFS is case-insensitive: the index can keep `.AWS/canary` after the dir was renamed to `.aws`.
        # The excludes must apply to the on-disk name. The identity check is patched so the alias path runs
        # on case-sensitive filesystems too.
        self.write(".aws/canary", "secret\n")
        index_names = b".AWS/canary\0"
        real_run = ssh_sync.subprocess.run

        def fake_ls_files(cmd, **kw):
            if cmd[:3] == ["git", "-C", str(self.src)] and "ls-files" in cmd:
                return subprocess.CompletedProcess(cmd, 0, index_names, b"")
            return real_run(cmd, **kw)
        with patch.object(ssh_sync.subprocess, "run", side_effect=fake_ls_files), \
                patch.object(ssh_sync, "_same_file", return_value=True):
            out = ssh_sync._tracked_skipped(self.src, set())
        self.assertNotIn(".aws/canary", out)
        self.assertNotIn(".AWS/canary", out)
        self.assertEqual(ssh_sync._disk_path(self.src, ".AWS/canary", {}), ".aws/canary")

    def test_not_a_git_repo_is_one_pass(self):
        plain = Path(self.tmp.name) / "plain"
        plain.mkdir()
        (plain / "a.txt").write_text("a\n")
        ssh_sync.push("testbox", plain, str(self.remote))
        self.assertEqual(len(self.rsyncs), 1)
        self.assertTrue(self.on_box("a.txt"))

    def test_second_pass_failure_is_an_infra_error(self):
        def fail_second(cmd, **kw):
            if cmd[0] == ssh_sync.RSYNC and "--files-from=-" in cmd:
                return subprocess.CompletedProcess(cmd, 12, "", "rsync: connection unexpectedly closed")
            return self.run_local(cmd, **kw)
        with patch.object(ssh_sync.subprocess, "run", side_effect=fail_second):
            with self.assertRaises(OffboxError) as cm:
                self.push()
        self.assertEqual(cm.exception.code, 90)
        self.assertIn("failed (12)", str(cm.exception))

    def test_note_counts_the_rest(self):
        st = {"tracked_ignored": 7, "tracked_ignored_first": ["a", "b", "c", "d", "e"], "tracked_ignored_sent": 1}
        self.assertEqual(ssh_sync.tracked_ignored_note(st),
                         "also synced 7 git-tracked file(s) that .gitignore matches: a, b, c, d, e (+2 more)")

    def test_offbox_skips(self):
        for rel in ("a/.aws/creds", "b/.docker/config.json", "x/node_modules/y.js", "c/.env", "k.pem"):
            self.assertTrue(ssh_sync._offbox_skips(rel), rel)
        for rel in ("e/.env.example", "go.sum", "package-lock.json", "docker/config.json"):
            self.assertFalse(ssh_sync._offbox_skips(rel), rel)


if __name__ == "__main__":
    unittest.main()
