#!/usr/bin/env python3
"""offbox-person-backup tests: fake offbox, boat, Dropbox mirror and Telegram; real restic on a temp repo."""

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / "bin" / "offbox-person-backup"
FAKES = HERE / "fakes"
RESTIC = shutil.which("restic") or "/opt/homebrew/bin/restic"
BOX = "bx_test"


@unittest.skipUnless(os.access(RESTIC, os.X_OK), "restic not installed")
class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="person-backup-test-"))
        self.root = self.tmp / "root"
        (self.root / "moni").mkdir(parents=True)
        self.home = self.tmp / "snapshot-home"
        self.dropbox = self.tmp / "dropbox"
        self.dropbox.mkdir()
        for rel, body in {
            "person/profile/Default/Cookies": "cookie-db",
            "person/profile/Default/GPUCache/data_1": "gpu",
            "person/files/statement.csv": "a,b\n",
            "person/secrets/token.json": "{}",
            "person/session.sh": "#!/bin/sh\n",
            ".config/himalaya/config.toml": "[accounts.moni]\n",
            ".bashrc": "export X=1\n",
            ".cloakbrowser/chrome": "big binary",
            "person/wiki/README.md": "wiki clone",
            "person/venv/bin/python": "venv",
            "person/bin/himalaya": "her mail client",
            "go/src/app/main.go": "package main\n",
            "go/pkg/mod/cache/x.zip": "module cache",
        }.items():
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body)
        leases = self.tmp / "leases.json"
        leases.write_text(json.dumps([
            {"box_id": "bx_old", "repo_key": "moni", "repo_root": str(self.root / "moni"), "state": "deleted",
             "last_used_at": 9e9},
            {"box_id": BOX, "repo_key": "moni", "repo_root": str(self.root / "moni"), "state": "stopped",
             "last_used_at": 100},
            {"box_id": "bx_other", "repo_key": "other", "repo_root": "/x", "state": "running", "last_used_at": 200},
        ]))
        self.boat_log = self.tmp / "boat.log"
        self.mirror_log = self.tmp / "mirror.log"
        self.notify_log = self.tmp / "notify.log"
        self.env = {
            **os.environ,
            "OFFBOX_PERSON_ROOT": str(self.root),
            "OFFBOX_PERSON_OFFBOX": str(FAKES / "offbox"),
            "OFFBOX_PERSON_BOAT": str(FAKES / "boat"),
            "OFFBOX_PERSON_RESTIC": RESTIC,
            "OFFBOX_PERSON_PY": sys.executable,
            "OFFBOX_PERSON_MIRROR": str(FAKES / "dropbox_mirror.py"),
            "OFFBOX_PERSON_NOTIFY": str(FAKES / "notify"),
            "OFFBOX_PERSON_RESTIC_PASSWORD_COMMAND": "echo test-password",
            "OFFBOX_PERSON_CAFFEINATE": "",
            "OFFBOX_PERSON_TMUTIL": "",
            "OFFBOX_PERSON_POLL": "1",
            "FAKE_LOG": str(self.tmp / "offbox.log"),
            "FAKE_LIST_JSON": str(leases),
            "FAKE_BASES_JSON": str(self.tmp / "bases.json"),
            "FAKE_BOAT_LOG": str(self.boat_log),
            "FAKE_SNAPSHOT_DIR": str(self.home),
            "FAKE_SNAPSHOT_ID": "snap-1",
            "FAKE_DROPBOX": str(self.dropbox),
            "FAKE_NOTIFY_LOG": str(self.notify_log),
            "FAKE_MIRROR_LOG": str(self.mirror_log),
        }
        (self.tmp / "bases.json").write_text("[]")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def backup(self, *args, check=True, **env):
        r = subprocess.run([str(TOOL), *(args or ("moni",))], env={**self.env, **env}, capture_output=True,
                           text=True, timeout=120)
        if check and r.returncode != 0:
            self.fail(f"backup rc={r.returncode}\n{r.stderr}\n{self.log()}")
        return r

    def log(self):
        return "".join(p.read_text() for p in (self.root / "state").glob("moni-backup-*.log"))

    def status(self):
        return json.loads((self.root / "state" / "moni-backup.json").read_text())

    def boat_calls(self):
        return [json.loads(line) for line in self.boat_log.read_text().splitlines()] if self.boat_log.exists() else []

    def pulls(self):
        return [c for c in self.boat_calls() if c[:2] == ["snapshot", "pull"]]

    def restic(self, *args):
        env = {**os.environ, "RESTIC_REPOSITORY": str(self.root / "restic" / "moni"),
               "RESTIC_PASSWORD_COMMAND": "echo test-password", "RESTIC_CACHE_DIR": str(self.tmp / "cache")}
        return subprocess.run([RESTIC, *args], env=env, capture_output=True, text=True, check=True).stdout

    def backed_up_files(self):
        out = self.restic("ls", "latest", "--json")
        stage = str(self.stage() / "pull" / "home_user") + "/"
        return {e["path"].split(stage, 1)[1] for e in map(json.loads, out.splitlines())
                if e.get("type") == "file" and stage in e.get("path", "")}

    def stage(self):
        return (self.root / "stage").resolve() / "moni"

    def mirror_calls(self):
        return [json.loads(line) for line in self.mirror_log.read_text().splitlines()] if self.mirror_log.exists() else []

    def dropbox_files(self):
        return {str(p.relative_to(self.dropbox)): p.read_bytes() for p in self.dropbox.rglob("*") if p.is_file()}

    def lock_is_free(self):
        with open(self.root / "state" / "moni-backup.lock", "a") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False

    def assert_no_plaintext(self):
        self.assertEqual(list((self.root / "stage").iterdir()), [], "plaintext pull left on the Mac")
        mounts = subprocess.run(["/sbin/mount"], capture_output=True, text=True).stdout
        self.assertNotIn(f" on {self.stage()} (", mounts, "stage image still attached")

    def test_backs_up_her_data_without_reinstallable_parts_and_mirrors_it(self):
        self.backup()
        st = self.status()
        self.assertTrue(st["ok"])
        self.assertEqual((st["box"], st["boat_snapshot"], st["stage"]), (BOX, "snap-1", "done"))
        self.assertEqual(self.backed_up_files(), {
            "person/profile/Default/Cookies", "person/profile/Default/GPUCache/data_1",
            "person/files/statement.csv", "person/secrets/token.json", "person/session.sh",
            ".config/himalaya/config.toml", ".bashrc", "person/bin/himalaya", "go/src/app/main.go"})
        pulled = {c[i + 1] for c in self.pulls() for i, a in enumerate(c) if a == "--path"}
        for skipped in (".cloakbrowser", "person/wiki", "person/venv", "go", "go/pkg"):
            self.assertNotIn("/home/user/" + skipped, pulled)
        self.assertIn("/home/user/go/src", pulled)
        self.assertTrue((self.dropbox / "Backups/offbox-person/moni/restic/config").is_file())
        self.assert_no_plaintext()
        self.assertFalse(self.notify_log.exists())

    def test_same_snapshot_is_skipped_and_a_new_one_is_backed_up(self):
        self.backup()
        self.backup()
        self.assertEqual(len(self.pulls()), 1)
        self.assertEqual(self.status()["stage"], "unchanged")
        self.assertTrue(self.status()["ok"])
        (self.home / "person/files/new.txt").write_text("new")
        self.backup(FAKE_SNAPSHOT_ID="snap-2")
        self.assertEqual(len(self.pulls()), 2)
        self.assertIn("person/files/new.txt", self.backed_up_files())
        self.assertEqual(self.status()["last_boat_snapshot"], "snap-2")
        self.backup("moni", "--force", FAKE_SNAPSHOT_ID="snap-2")
        self.assertEqual(len(self.pulls()), 3)

    def test_falls_back_to_the_saved_base_when_no_lease_is_left(self):
        (self.tmp / "leases.json").write_text("[]")
        (self.tmp / "bases.json").write_text(json.dumps([{"name": "moni:person", "box_id": "bx_base"}]))
        self.backup()
        self.assertEqual(self.status()["box"], "bx_base")

    def test_a_missing_file_fails_but_skipped_cache_files_do_not(self):
        self.backup(FAKE_BOAT_DROP="person/profile/Default/GPUCache/data_1")
        self.assertTrue(self.status()["ok"])
        r = self.backup("moni", check=False, FAKE_SNAPSHOT_ID="snap-2", FAKE_BOAT_DROP="person/profile/Default/Cookies")
        self.assertEqual(r.returncode, 1)
        st = self.status()
        self.assertFalse(st["ok"])
        self.assertEqual(st["stage"], "pull")
        self.assertEqual(st["last_boat_snapshot"], "snap-1")
        self.assertIn("failed at pull", self.notify_log.read_text())
        self.assertNotIn("Cookies", self.log(), "her file names must not reach the Mac log")
        self.assert_no_plaintext()

    def test_truncated_listing_pulls_whole_home_and_restic_still_excludes(self):
        self.backup(FAKE_TREE_TRUNCATED="1")
        self.assertEqual([c[i + 1] for c in self.pulls() for i, a in enumerate(c) if a == "--path"], ["/home/user"])
        files = self.backed_up_files()
        self.assertIn("person/profile/Default/Cookies", files)
        self.assertFalse({f for f in files if f.startswith((".cloakbrowser", "person/wiki", "person/venv", "go/pkg"))})
        self.assertIn("go/src/app/main.go", files)

    def test_lost_local_repo_is_never_replaced_over_the_dropbox_copy(self):
        self.backup()
        before = sorted(p.relative_to(self.dropbox) for p in self.dropbox.rglob("*") if p.is_file())
        shutil.rmtree(self.root / "restic" / "moni")
        r = self.backup("moni", check=False, FAKE_SNAPSHOT_ID="snap-2")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "repo"))
        self.assertFalse((self.root / "restic" / "moni").exists())
        (self.root / "state" / "moni-backup.json").unlink()  # even with no local record of earlier backups
        r = self.backup("moni", check=False, FAKE_SNAPSHOT_ID="snap-3")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "repo"))
        after = sorted(p.relative_to(self.dropbox) for p in self.dropbox.rglob("*") if p.is_file())
        self.assertEqual(before, after)
        self.assertEqual(self.pulls()[1:], [])

    def test_a_different_repo_in_dropbox_is_not_overwritten(self):
        self.backup()
        cfg = self.dropbox / "Backups/offbox-person/moni/restic/config"
        cfg.write_text("someone else's repo")
        r = self.backup("moni", check=False, FAKE_SNAPSHOT_ID="snap-2")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "dropbox"))
        self.assertEqual(cfg.read_text(), "someone else's repo")
        self.assert_no_plaintext()

    def test_a_hung_pull_times_out_and_leaves_no_plaintext(self):
        t = time.time()
        r = self.backup("moni", check=False, FAKE_BOAT_HANG="snapshot pull", OFFBOX_PERSON_PULL_TIMEOUT="2")
        self.assertLess(time.time() - t, 30)
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "pull"))
        self.assert_no_plaintext()

    def test_a_failed_pull_is_retried_from_a_fresh_listing(self):
        self.backup(FAKE_BOAT_PULL_FAILS="1")
        self.assertEqual(len(self.pulls()), 2)
        self.assertEqual(len([c for c in self.boat_calls() if c[:2] == ["snapshot", "tree"]]), 2)
        self.assertIn("not ready yet", self.log())
        self.assertTrue(self.status()["ok"])
        self.assert_no_plaintext()

    def test_a_pull_that_keeps_failing_alerts_once_and_leaves_no_plaintext(self):
        r = self.backup("moni", check=False, FAKE_BOAT_PULL_FAILS="9")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "pull"))
        self.assertEqual(len(self.pulls()), 3)
        self.assertEqual(self.notify_log.read_text().count("failed at pull"), 1)
        self.assert_no_plaintext()

    def test_a_hung_listing_times_out_with_an_alert(self):
        r = self.backup("moni", check=False, FAKE_BOAT_HANG="snapshot tree", OFFBOX_PERSON_CALL_TIMEOUT="2")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "snapshot"))
        self.assertIn("failed at snapshot", self.notify_log.read_text())

    def test_term_during_pull_removes_the_plaintext_at_once(self):
        proc = subprocess.Popen([str(TOOL), "moni"], env={**self.env, "FAKE_BOAT_HANG": "snapshot pull"},
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cookies = self.stage() / "pull/home_user/person/profile/Default/Cookies"
        deadline = time.time() + 60
        while not cookies.exists() and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue(cookies.exists(), "pull never started")
        t = time.time()
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=20)
        self.assertLess(time.time() - t, 10)
        self.assert_no_plaintext()
        self.assertTrue(self.lock_is_free())

    def test_all_backs_up_every_person_dir(self):
        (self.root / "bin").mkdir()  # install.zsh puts the LaunchAgent's copy of the script here
        r = self.backup("--all")
        self.assertEqual(r.returncode, 0)
        self.assertTrue(self.status()["ok"])
        self.assertFalse((self.root / "state" / "bin-backup.json").exists())

    def test_a_live_lock_skips_and_after_stop_waits_for_it(self):
        lock = self.root / "state" / "moni-backup.lock"
        lock.parent.mkdir(parents=True)
        holder = subprocess.Popen([sys.executable, "-c", (
            "import fcntl, sys, time\n"
            "f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(60)"),
            str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            self.backup()
            self.assertEqual(self.pulls(), [])
            self.assertIn("still running", self.log())
            waiter = subprocess.Popen([str(TOOL), "moni", "--after-stop"], env=self.env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(3)
            self.assertIsNone(waiter.poll(), "post-stop backup must wait for the running one")
            holder.kill()
            holder.wait()
            self.assertEqual(waiter.wait(timeout=60), 0)
            self.assertEqual(len(self.pulls()), 1)
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()

    def test_names_differing_only_in_case_are_both_kept(self):
        self.backup(FAKE_BOAT_EXTRA=json.dumps({"person/files/README": "upper", "person/files/Readme": "mixed"}))
        self.assertLessEqual({"person/files/README", "person/files/Readme"}, self.backed_up_files())
        self.assert_no_plaintext()

    def test_read_only_folders_are_backed_up_and_removed(self):
        self.backup(FAKE_BOAT_CHMOD="person/secrets/token.json=400,person/files=555")
        self.assertLessEqual({"person/files/statement.csv", "person/secrets/token.json"}, self.backed_up_files())
        self.assert_no_plaintext()

    def test_a_missing_project_lock_file_is_not_ignored(self):
        (self.home / "person/work/app").mkdir(parents=True)
        (self.home / "person/work/app/yarn.lock").write_text("lock")
        r = self.backup("moni", check=False, FAKE_BOAT_DROP="person/work/app/yarn.lock")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "pull"))

    def test_a_damaged_local_repo_is_not_mirrored_over_dropbox(self):
        self.backup()
        before = self.dropbox_files()
        shutil.rmtree(self.root / "restic" / "moni" / "data")
        (self.home / "person/files/new.txt").write_text("new")
        r = self.backup("moni", check=False, FAKE_SNAPSHOT_ID="snap-2")
        self.assertEqual((r.returncode, self.status()["stage"]), (1, "check"))
        self.assertEqual(self.dropbox_files(), before)
        self.assertIn("failed at check", self.notify_log.read_text())
        self.assert_no_plaintext()

    def test_dropbox_files_are_deleted_only_after_a_prune(self):
        self.backup()
        self.backup(FAKE_SNAPSHOT_ID="snap-2")
        self.backup(FAKE_SNAPSHOT_ID="snap-2")  # unchanged, nothing pruned: no mirror at all
        stamp = self.root / "state" / "moni-backup-prune.stamp"
        old = time.time() - 2 * 86400
        os.utime(stamp, (old, old))
        self.backup(FAKE_SNAPSHOT_ID="snap-2")  # unchanged, but the daily prune ran
        self.assertEqual(["--delete" in c for c in self.mirror_calls()], [True, False, True])

    def test_tool_errors_naming_her_files_stay_out_of_the_log(self):
        err = ("open /home/user/person/files/Bank Statement.pdf: permission denied\n"
               "error reading `person/files/statement.csv`\nperson/files/Tax Return 2025.pdf: changed")
        self.backup(FAKE_BOAT_PULL_FAILS="1", FAKE_BOAT_PULL_ERROR=err)
        log = self.log()
        for name in ("Bank Statement", "statement.csv", "Tax Return"):
            self.assertNotIn(name, log)
        self.assertIn("lines naming paths hidden", log)


if __name__ == "__main__":
    unittest.main()
