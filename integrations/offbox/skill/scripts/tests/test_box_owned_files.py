"""Files on the box the box user can't delete (root-owned LocalStack cache, 31 Oct, Crpko #1057) must not fail the sync."""
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

DENIED = """rsync: [generator] delete_file: rmdir(tmp/localstack/var-lib/cache/certs) failed: Permission denied (13)
rsync: [generator] delete_file: unlink(tmp/localstack/var-lib/cache/server.test.pem.crt) failed: Permission denied (13)
rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.5.0]
"""


class BoxOwnedFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="offbox-owned-test-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.src, self.remote = base / "src", base / "remote"
        self.src.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, env, clear=True))
        subprocess.run(["git", "-C", str(self.src), "init", "-q"], check=True)
        (self.src / ".git/info").mkdir(parents=True, exist_ok=True)
        (self.src / ".git/info/exclude").write_text("tmp/\n")
        (self.src / "a.txt").write_text("a\n")
        (self.src / "tmp/diag").mkdir(parents=True)
        (self.src / "tmp/diag/run.sh").write_text("echo hi\n")
        self.real_run = subprocess.run
        self.denials = 0
        stack.enter_context(patch.object(ssh_sync, "log"))
        stack.enter_context(patch.object(ssh_sync.subprocess, "run", side_effect=self.run_local))
        self.ssh = stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=AssertionError("no ssh expected")))

    def run_local(self, cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC and self.denials:
            # rsync can't delete root-owned files on a real box; locally the owner always can, so fake the answer.
            self.denials -= 1
            return subprocess.CompletedProcess(cmd, 23, "", DENIED)
        if cmd[0] == ssh_sync.RSYNC:
            cmd = list(cmd)
            cmd[-1] = cmd[-1].removeprefix("testbox:")
        return self.real_run(cmd, **kwargs)

    def push(self, includes=None):
        return ssh_sync.push("testbox", self.src, str(self.remote), includes=includes)

    def box_cache(self, rel="tmp/localstack/var-lib/cache"):
        d = self.remote / rel
        (d / "certs").mkdir(parents=True)
        (d / "certs/server.test.pem.crt").write_text("x")  # not *.pem: a secret-filtered file is never deleted
        (d / "machine.json").write_text("{}")
        return d

    def test_include_under_ignored_tmp_keeps_the_boxs_other_tmp_files(self):
        self.push(includes=["tmp/diag"])
        cache = self.box_cache()
        (self.remote / "tmp/diag/stale.txt").write_text("old")
        self.push(includes=["tmp/diag"])  # deleted the box's tmp/localstack before the fix (23 when root owns it)
        self.assertTrue((cache / "machine.json").exists())
        self.assertTrue((self.remote / "tmp/diag/run.sh").exists())
        self.assertFalse((self.remote / "tmp/diag/stale.txt").exists(), "the included path still mirrors")

    def test_include_of_a_file_under_tmp(self):
        self.push(includes=["tmp/diag/run.sh"])
        cache = self.box_cache()
        self.push(includes=["tmp/diag/run.sh"])
        self.assertTrue((cache / "machine.json").exists())

    def test_no_protect_rule_without_an_ignored_ancestor(self):
        (self.src / "configs").mkdir()
        (self.src / "configs/.env").write_text("X=1\n")
        f = ssh_sync.push_filters(self.src, False, ["configs/.env", "tmp/diag", "tmp/other"])
        self.assertEqual([x for x in f if x.startswith("--filter=P")], ["--filter=P /tmp/**"])

    def test_denied_delete_is_reclaimed_and_synced_again(self):
        self.push()
        cache = self.box_cache("build/cache")      # not ignored, not local: --delete must remove it
        self.denials = 1
        self.ssh.side_effect = lambda box, command, **kw: subprocess.CompletedProcess([], 0, b"", b"")
        self.push()
        self.assertFalse(cache.exists())
        self.assertEqual(self.ssh.call_count, 1)
        box, command = self.ssh.call_args[0]
        self.assertEqual(box, "testbox")
        self.assertIn("sudo -n chown -R", command)
        self.assertIn(str(self.remote), command)

    def test_denied_twice_fails_after_one_reclaim(self):
        self.denials = 2
        self.ssh.side_effect = lambda box, command, **kw: subprocess.CompletedProcess([], 0, b"", b"")
        with self.assertRaisesRegex(OffboxError, r"failed \(23\)"):
            self.push()
        self.assertEqual(self.ssh.call_count, 1)

    def test_reclaim_failure_is_a_plain_infra_error_naming_the_fix(self):
        self.denials = 1
        self.ssh.side_effect = lambda *a, **kw: subprocess.CompletedProcess([], 1, b"", b"sudo: a password is required")
        with self.assertRaises(OffboxError) as cm:
            self.push()
        self.assertEqual(cm.exception.code, 90)
        self.assertIn("sudo chown -R user:user", str(cm.exception))

    def test_box_side_opendir_denial_after_reclaim_is_not_a_soft_pass(self):
        # The second 23 must not look like a local unreadable file (the soft path); it's an infra failure, exit 90.
        opendir = ('rsync: [generator] opendir "tmp/localstack/var-lib/cache" failed: Permission denied (13)\n'
                   "rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.5.0]\n")
        self.assertIsNone(ssh_sync._soft_partial(opendir))
        rsyncs = []

        def fake(cmd, **kw):
            if cmd[0] == ssh_sync.RSYNC:
                rsyncs.append(cmd)
                return subprocess.CompletedProcess(cmd, 23, "", DENIED if len(rsyncs) == 1 else opendir)
            return self.real_run(cmd, **kw)

        self.ssh.side_effect = lambda *a, **kw: subprocess.CompletedProcess([], 0, b"", b"")
        with patch.object(ssh_sync.subprocess, "run", side_effect=fake):
            with self.assertRaises(OffboxError) as cm:
                self.push()
        self.assertEqual(cm.exception.code, 90)
        self.assertEqual(len(rsyncs), 2)
        self.assertEqual(self.ssh.call_count, 1)

    def test_receiver_denied_parsing(self):
        self.assertEqual(ssh_sync._receiver_denied(DENIED), ["tmp/localstack/var-lib/cache/certs",
                                                            "tmp/localstack/var-lib/cache/server.test.pem.crt"])
        self.assertIsNone(ssh_sync._receiver_denied(
            DENIED + 'rsync: [receiver] write failed on "/home/user/w/r/a": Transport endpoint is not connected (107)\n'))
        self.assertIsNone(ssh_sync._receiver_denied('rsync: [sender] send_files failed to open "/x": Permission denied (13)'))


if __name__ == "__main__":
    unittest.main()
