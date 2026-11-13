"""A relocated base must not reuse Gradle's absolute project execution history."""
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skill" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import common, identity, lease, pool, ssh_sync  # noqa: E402
if __package__:
    from .client_fixtures import Isolated
else:
    from client_fixtures import Isolated


class BaseCheckoutTests(Isolated):
    def setUp(self):
        super().setUp()
        self.home = Path(self.tmp.name) / "box-home"
        self.home.mkdir()
        self.stack.enter_context(patch.object(lease, "_bring_up", return_value={}))
        self.stack.enter_context(patch.object(lease.api, "rename"))
        self.stack.enter_context(patch.object(lease, "remote_dir_for", return_value="w/new"))
        self.ssh = self.stack.enter_context(patch.object(ssh_sync, "ssh", side_effect=self.remote))

    def remote(self, box, command, **kwargs):
        env = {k: v for k, v in os.environ.items() if k != "BASH_ENV"}
        return subprocess.run(["bash", "-c", command], capture_output=True,
                              env={**env, "HOME": str(self.home)})

    def file(self, path, text="warm"):
        target = self.home / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def create(self, source="base:repo:warm", base_dir="w/old", **kwargs):
        return lease._create_row(self.con, self.me, "scratch", source, base_dir, "large", common.now(), **kwargs)

    def test_changed_base_checkout_clears_project_metadata_and_keeps_warm_outputs(self):
        self.file("w/old/.gradle/8.14.4/executionHistory/executionHistory.bin", "/home/user/w/old")
        self.file("w/old/android/.gradle/8.14.4/executionHistory/executionHistory.bin")
        for path in (".gradle/caches/modules-2/dependency.jar", "w/old/lib/build/classes/A.class",
                     "w/old/node_modules/package/index.js"):
            self.file(path)
        self.assertEqual(self.create()["state"], "running")
        self.assertFalse((self.home / "w/old").exists())
        self.assertFalse((self.home / "w/new/.gradle").exists())
        self.assertFalse((self.home / "w/new/android/.gradle").exists())
        for path in (".gradle/caches/modules-2/dependency.jar", "w/new/lib/build/classes/A.class",
                     "w/new/node_modules/package/index.js"):
            self.assertEqual((self.home / path).read_text(), "warm")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE kind='base_checkout_cleared'")
                         .fetchone()[0], 1)

    def test_same_checkout_keeps_metadata(self):
        history = self.file("w/new/.gradle/8.14.4/executionHistory/executionHistory.bin")
        self.create(base_dir="w/new")
        self.assertTrue(history.exists())
        self.ssh.assert_not_called()

    def test_non_base_box_keeps_metadata(self):
        for source in ("fresh", "template:generic"):
            with self.subTest(source=source):
                history = self.file("w/new/.gradle/8.14.4/executionHistory/executionHistory.bin")
                self.create(source=source, base_dir=None)
                self.assertTrue(history.exists())
        self.ssh.assert_not_called()

    def test_existing_destination_is_not_cleaned_or_overwritten(self):
        old = self.file("w/old/.gradle/history")
        current = self.file("w/new/.gradle/history", "current")
        self.create()
        self.assertTrue(old.exists())
        self.assertEqual(current.read_text(), "current")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE kind='base_checkout_cleared'")
                         .fetchone()[0], 0)

    def test_symlinks_do_not_clear_caches_outside_the_checkout(self):
        external = self.file(".gradle/caches/modules-2/dependency.jar")
        module = self.home / "w/old/android"
        module.mkdir(parents=True)
        (module / ".gradle").symlink_to(self.home / ".gradle", target_is_directory=True)
        (module / "linked-project").symlink_to(self.home / ".gradle", target_is_directory=True)
        self.create()
        self.assertFalse((self.home / "w/new/android/.gradle").is_symlink())
        self.assertTrue((self.home / "w/new/android/linked-project").is_symlink())
        self.assertTrue(external.exists())

    def test_base_path_is_quoted(self):
        base_dir = "w/base's $(touch UNEXPECTED)"
        self.file(f"{base_dir}/.gradle/history")
        self.create(base_dir=base_dir)
        self.assertFalse((self.home / "w/new/.gradle").exists())
        self.assertFalse((self.home / base_dir).exists())
        self.assertFalse((self.home / "UNEXPECTED").exists())

    def test_regular_file_named_gradle_is_preserved(self):
        self.file("w/old/subproject/.gradle", "source")
        self.create()
        self.assertEqual((self.home / "w/new/subproject/.gradle").read_text(), "source")

    def test_missing_base_checkout_needs_no_cleanup(self):
        self.create()
        self.assertFalse((self.home / "w/new").exists())
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE kind='base_checkout_cleared'")
                         .fetchone()[0], 0)

    def test_pool_creator_already_holds_the_box_lock(self):
        self.file("w/old/.gradle/history")
        with patch.object(lease, "file_lock", side_effect=AssertionError("box lock is not reentrant")):
            self.create(box_held=True)
        self.assertFalse((self.home / "w/new/.gradle").exists())

    def test_cleanup_failure_stops_before_the_move(self):
        history = self.file("w/old/.gradle/history")
        self.ssh.side_effect = None
        self.ssh.return_value = subprocess.CompletedProcess([], 1, b"", b"permission denied")
        with self.assertRaises(common.OffboxError):
            self.create()
        self.assertTrue(history.exists())
        self.assertIsNone(self.con.execute("SELECT ssh_ready_at FROM leases WHERE box_id='scratch'").fetchone()[0])

    def test_unconfirmed_relocation_cannot_be_reacquired(self):
        outcomes = (
            subprocess.CompletedProcess([], 1, b"", b"permission denied"),
            subprocess.TimeoutExpired("ssh", 120),
            KeyboardInterrupt(),
        )
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__):
                self.file("w/old/.gradle/history")
                self.ssh.side_effect = outcome if isinstance(outcome, BaseException) else None
                self.ssh.return_value = outcome
                with self.assertRaises((common.OffboxError, subprocess.TimeoutExpired, KeyboardInterrupt)):
                    self.create()
                row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='scratch'").fetchone())
                self.assertEqual(row["state"], "bringing_up")
                self.assertIsNone(lease.find_lease(self.con, self.me["owner"], self.me["repo_root"]))
                candidates, _ = pool.candidates(self.con, self.me["repo_key"], "large", None, self.me)
                self.assertFalse(candidates)
                with patch.object(lease.api, "get", side_effect=AssertionError("unavailable box reused")):
                    self.assertIsNone(lease._reuse(self.con, {**row, "state": "running"}, None))
                with patch.object(identity, "require_proven"), patch.object(lease, "cap_check"), \
                        patch.object(lease, "_new_box", return_value=({"id": "replacement"}, "fresh", None, "large")):
                    got = lease.acquire_private(self.me)
                self.assertEqual(got["box_id"], "replacement")
                self.con.execute("DELETE FROM leases WHERE box_id='replacement'")
                self.con.commit()

    def test_active_run_prevents_cleanup(self):
        history = self.file("w/old/.gradle/history")
        self.con.execute("INSERT INTO runs(run_id,box_id,status) VALUES ('other','scratch','running')")
        self.con.commit()
        with self.assertRaises(common.OffboxError):
            self.create()
        self.ssh.assert_not_called()
        self.assertTrue(history.exists())
