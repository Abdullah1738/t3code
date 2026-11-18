"""macOS Keychain integration tests. Every item is confined to a disposable keychain."""
import fcntl
import select
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

MAIL = Path(__file__).resolve().parents[1] / "libexec/mail"
spec = importlib.util.spec_from_file_location("kc_helpers", MAIL / "kc_helpers.py")
kc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kc)


@unittest.skipUnless(sys.platform == "darwin", "requires macOS security")
class KeychainTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="kc-selftest-"))
        self.addCleanup(shutil.rmtree, self.temp)
        # Spaces and quotes exercise security -i's argument parser as well as KC_KEYCHAIN.
        self.keychain = self.temp / 'test " keychain.keychain-db'
        self.security("create-keychain", "-p", "")
        self.addCleanup(self.security, "delete-keychain")
        self.security("unlock-keychain", "-p", "")
        self.log = self.temp / "logs/kc.log"
        self.env = dict(os.environ, KC_KEYCHAIN=str(self.keychain), KC_LOG=str(self.log))
        self.service = "kc-selftest-" + uuid.uuid4().hex
        self.first = json.dumps({"access_token": "test-access-first-" + uuid.uuid4().hex,
                                 "refresh_token": "test-refresh-first-" + uuid.uuid4().hex,
                                 "issued_at": 1, "expires_in": 3600}).encode()
        self.second = json.dumps({"access_token": "test-access-second-" + uuid.uuid4().hex,
                                  "refresh_token": "test-refresh-second-" + uuid.uuid4().hex}).encode()

    def security(self, *args):
        result = subprocess.run(["/usr/bin/security", *args, str(self.keychain)],
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, "security fixture operation failed")
        return result

    def helper(self, name, raw=None, service=None, account=None, **env):
        return subprocess.run([str(MAIL / name), service or self.service, *([account] if account else [])],
                              input=raw, capture_output=True, timeout=20, env=dict(self.env, **env))

    def put(self, raw, service=None, account="ortie"):
        with patch.dict(os.environ, self.env):
            self.assertTrue(kc.store_item(service or self.service, account, raw))

    def stored(self, service=None, account="ortie"):
        with patch.dict(os.environ, self.env):
            return kc.read_item(service or self.service, account)

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_roundtrip(self):
        result = self.helper("kc-write", self.first)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.helper("kc-read").stdout, self.first + b"\n")
        self.assertEqual(self.stored(), (0, self.first))

    def test_invalid_input_never_changes_primary_or_backup(self):
        self.put(self.first)
        self.put(self.second, self.service + ".last-good")
        for raw, reason in [(b"", "empty"), (b" \n\t ", "empty"), (b"not json", "nonjson"),
                            (b"[]", "nonjson"), (b"null", "nonjson"), (b'"string"', "nonjson"),
                            (b"123", "nonjson"), (b"true", "nonjson"), (b"{}", "no-access-token"),
                            (b'{"access_token":""}', "no-access-token"),
                            (b'{"access_token":"  "}', "no-access-token"),
                            (b'{"access_token":null}', "no-access-token"),
                            (b'{"access_token":12}', "no-access-token"),
                            (b'{"access_token":true}', "no-access-token"),
                            (b'{"access_token":[]}', "no-access-token"),
                            (b'{"access_token":{}}', "no-access-token"),
                            (b'{"access_token":"ok","x":NaN}', "nonjson"),
                            (b'{"access_token":"ok","x":Infinity}', "nonjson"),
                            (b'{"access_token":"ok","x":-Infinity}', "nonjson"),
                            (b'{"access_token":"ok","x":1e400}', "nonjson"),
                            (b'{"access_token":"ok","x":-1e400}', "nonjson"),
                            (b'{"access_token":"\xff"}', "nonjson")]:
            with self.subTest(raw=raw):
                result = self.helper("kc-write", raw)
                self.assertEqual(result.returncode, 65)
                self.assertIn(reason.encode(), result.stderr)
                self.assertEqual(self.stored(), (0, self.first))
                self.assertEqual(self.stored(self.service + ".last-good"), (0, self.second))
                self.assertEqual(self.events()[-1]["event"], "write-refused-" + reason)

    def test_refresh_token_carried_for_all_missing_forms(self):
        for replacement in [{}, {"refresh_token": ""}, {"refresh_token": None},
                            {"refresh_token": " "}, {"refresh_token": 7}]:
            with self.subTest(replacement=replacement):
                self.put(self.first)
                raw = json.dumps(dict(access_token="new-access-token", **replacement)).encode()
                self.assertEqual(self.helper("kc-write", raw).returncode, 0)
                self.assertEqual(json.loads(self.stored()[1])["refresh_token"],
                                 json.loads(self.first)["refresh_token"])
                self.assertEqual(self.events()[-3]["event"], "refresh-token-carried")

    def test_second_write_backs_up_first(self):
        self.assertEqual(self.helper("kc-write", self.first).returncode, 0)
        self.assertEqual(self.helper("kc-write", self.second).returncode, 0)
        self.assertEqual(self.stored(self.service + ".last-good"), (0, self.first))
        self.assertEqual(self.stored(), (0, self.second))
        self.assertEqual([event["event"] for event in self.events()],
                         ["write-ok", "backup-saved", "write-ok"])

    def test_fallback_for_empty_invalid_and_missing_primary(self):
        self.put(self.first, self.service + ".last-good")
        self.assertEqual(self.helper("kc-read").stdout, self.first + b"\n")
        for raw in [b"", b"no json", b"[]", b"{}", b'{"access_token":""}']:
            with self.subTest(raw=raw):
                self.put(raw)
                result = self.helper("kc-read")
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, self.first + b"\n")
                self.assertEqual(self.events()[-1]["event"], "read-fallback")
                self.assertEqual(self.stored(), (0, raw))

    def test_invalid_backup_does_not_hide_failure(self):
        self.put(b"", self.service + ".last-good")
        self.assertEqual(self.helper("kc-read").returncode, 44)
        self.put(b"{}")
        result = self.helper("kc-read")
        self.assertEqual(result.returncode, 65)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(self.events()[-1]["event"], "read-failed")

    def test_missing_primary_and_backup_returns_44(self):
        result = self.helper("kc-read")
        self.assertEqual(result.returncode, 44)
        self.assertEqual(result.stdout, b"")

    def test_valid_primary_does_not_log_or_consult_backup(self):
        self.put(self.first)
        self.put(self.second, self.service + ".last-good")
        self.assertEqual(self.helper("kc-read").stdout, self.first + b"\n")
        self.assertFalse(self.log.exists())

    def test_repair_carries_refresh_from_backup_and_preserves_it(self):
        self.put(b"")
        self.put(self.first, self.service + ".last-good")
        self.assertEqual(self.helper("kc-write", b'{"access_token":"repaired"}').returncode, 0)
        self.assertEqual(json.loads(self.stored()[1])["refresh_token"],
                         json.loads(self.first)["refresh_token"])
        self.assertEqual(self.stored(self.service + ".last-good"), (0, self.first))

    def test_damaged_access_token_does_not_lose_refresh(self):
        for token in ["", None, 42, [], {}]:
            for extra in ["ascii", "é", "😀"]:
                with self.subTest(access_token=token, content=extra):
                    damaged = dict(json.loads(self.first), access_token=token, label=extra)
                    self.put(json.dumps(damaged, ensure_ascii=False).encode())
                    self.assertEqual(self.helper("kc-write", b'{"access_token":"repaired"}').returncode, 0)
                    self.assertEqual(json.loads(self.stored()[1])["refresh_token"], damaged["refresh_token"])
                    self.assertEqual(self.stored(self.service + ".last-good")[0], 44)

    def test_incomplete_feeder_and_killed_writer_leave_primary_unchanged(self):
        self.put(self.first)
        for kill in [False, True]:
            with self.subTest(kill_writer=kill):
                process = subprocess.Popen([str(MAIL / "kc-write"), self.service], env=self.env,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    process.stdin.write(b'{"access_token":"partial')
                    process.stdin.flush()
                    self.assertEqual(self.stored(), (0, self.first))
                    if kill:
                        process.kill()
                    out, _ = process.communicate(timeout=15)
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(out, b"")
                    self.assertEqual(self.stored(), (0, self.first))
                    self.assertEqual(self.stored(self.service + ".last-good")[0], 44)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()

    def test_complete_json_waits_for_eof(self):
        self.put(self.first)
        process = subprocess.Popen([str(MAIL / "kc-write"), self.service], env=self.env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(self.second)
            process.stdin.flush()
            self.assertEqual(self.stored(), (0, self.first))
            out, err = process.communicate(timeout=15)
            self.assertEqual(process.returncode, 0, err)
            self.assertEqual(out, b"")
            self.assertEqual(self.stored(), (0, self.second))
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_failed_backup_aborts_primary_write(self):
        self.put(self.first)
        with patch.dict(os.environ, self.env), patch.object(kc, "store_item", return_value=False):
            self.assertEqual(kc.write_locked(self.service, "ortie", self.second, json.loads(self.second)), 74)
        self.assertEqual(self.stored(), (0, self.first))
        self.assertEqual(self.events()[-1]["event"], "backup-failed")

    def test_verification_failure_restores_previous_primary(self):
        self.put(self.first)
        real_read = kc.read_item
        calls = 0

        def mismatch_once(service, account):
            nonlocal calls
            calls += 1
            if calls == 3:  # current, verified backup, then primary read-back
                return 0, b""
            return real_read(service, account)

        with patch.dict(os.environ, self.env), patch.object(kc, "read_item", side_effect=mismatch_once):
            self.assertEqual(kc.write_locked(self.service, "ortie", self.second, json.loads(self.second)), 74)
        self.assertEqual(self.stored(), (0, self.first))
        self.assertEqual(self.events()[-1]["event"], "write-verify-failed-restored")

    def test_read_error_never_overwrites_primary(self):
        self.put(self.first)
        with patch.dict(os.environ, self.env), patch.object(kc, "read_item", return_value=(36, b"")):
            self.assertEqual(kc.write_locked(self.service, "ortie", self.second, json.loads(self.second)), 36)
        self.assertEqual(self.stored(), (0, self.first))

    def test_logging_failure_does_not_fail_write_or_fallback(self):
        self.put(self.first)
        self.assertEqual(self.helper("kc-write", self.second, KC_LOG=str(self.temp)).returncode, 0)
        self.put(b"")
        result = self.helper("kc-read", KC_LOG=str(self.temp))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, self.first + b"\n")

    def test_log_events_have_metadata_and_no_values_and_rotate(self):
        self.assertEqual(self.helper("kc-write", self.first).returncode, 0)
        self.assertEqual(self.helper("kc-write", self.second).returncode, 0)
        self.assertEqual(self.helper("kc-write", b"").returncode, 65)
        self.put(b"")
        self.assertEqual(self.helper("kc-read").returncode, 0)
        text = self.log.read_text()
        events = self.events()
        self.assertEqual(len(events), 5)
        for event in events:
            self.assertEqual(set(event), {"ts", "pid", "ppid", "parent_cmd", "service", "event", "bytes"})
            self.assertLessEqual(len(event["parent_cmd"]), 80)
            self.assertTrue(event["ts"].endswith("+00:00"))
        for raw in [self.first, self.second]:
            for key, value in json.loads(raw).items():
                if "token" in key:
                    self.assertNotIn(value, text)
                    self.assertNotIn(value.encode().hex(), text)
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)
        with self.log.open("a") as out:
            out.write(" " * (256 * 1024))
        self.assertEqual(self.helper("kc-write", self.second).returncode, 0)
        self.assertTrue(Path(str(self.log) + ".1").exists())
        self.assertEqual(self.events()[-1]["event"], "write-ok")

    def test_optional_account_quotes_and_utf8_roundtrip(self):
        account = 'test " account\\suffix'
        service = self.service + ' " service\\suffix'
        raw = json.dumps({"access_token": 'é " \\ \n\t secret'}, ensure_ascii=False).encode()
        self.assertEqual(self.helper("kc-write", raw, service, account).returncode, 0)
        self.assertEqual(self.helper("kc-read", service=service, account=account).stdout, raw + b"\n")

    def test_pretty_printed_json_roundtrip(self):
        raw = json.dumps(json.loads(self.first), indent=2).encode() + b"\n"
        self.assertEqual(self.helper("kc-write", raw).returncode, 0)
        self.assertEqual(self.helper("kc-read").stdout, raw + b"\n")
        self.assertEqual(self.helper("kc-write", self.second).returncode, 0)
        self.assertEqual(self.stored(self.service + ".last-good"), (0, raw))

    def test_large_blob_roundtrip(self):
        raw = json.dumps({"access_token": "test-large-" + "x" * 2200}).encode()
        self.assertEqual(self.helper("kc-write", raw).returncode, 0)
        self.assertEqual(self.helper("kc-read").stdout, raw + b"\n")

    def test_outlook_sized_escaping_roundtrip(self):
        raw = json.dumps({"access_token": 'test-é-"-\\-\n\t-' + "x" * 2200,
                          "refresh_token": 'refresh-"-\\-é'}, ensure_ascii=False).encode()
        self.assertGreater(len(raw), 2200)
        self.assertEqual(self.helper("kc-write", raw).returncode, 0)
        self.assertEqual(self.helper("kc-read").stdout, raw + b"\n")
        self.assertEqual(self.helper("kc-write", self.first).returncode, 0)
        self.assertEqual(self.stored(self.service + ".last-good"), (0, raw))

    def test_oversized_blob_refused_without_modifying_primary_or_backup(self):
        self.put(self.first)
        self.put(self.second, self.service + ".last-good")
        raw = json.dumps({"access_token": "test-too-large-" + "x" * 12000}).encode()
        self.assertEqual(self.helper("kc-write", raw).returncode, 65)
        self.assertEqual(self.stored(), (0, self.first))
        self.assertEqual(self.stored(self.service + ".last-good"), (0, self.second))
        self.assertEqual(self.events()[-1]["event"], "write-refused-too-large")

    def test_parent_command_never_logs_opaque_positional_credential(self):
        opaque = "opaque-value-" + uuid.uuid4().hex
        script = self.temp / "parent.py"
        script.write_text("import os,subprocess,sys\nsubprocess.run([" +
                          repr(str(MAIL / "kc-write")) + ",sys.argv[2]],input=b'{}',check=False)\n")
        subprocess.run(["/usr/bin/python3", "-I", "parent.py", opaque, self.service],
                       cwd=self.temp, env=self.env, capture_output=True, timeout=15)
        self.assertEqual(len(self.events()), 1)
        self.assertNotIn(opaque, self.log.read_text())
        self.assertNotIn("parent.py", self.events()[0]["parent_cmd"])

    def test_mutating_child_holds_lock_after_writer_is_killed(self):
        self.put(self.first)
        ready, release = self.temp / "ready", self.temp / "release"
        os.mkfifo(ready)
        os.mkfifo(release)
        fake = self.temp / "security-fixture.py"
        fake.write_text("#!/usr/bin/python3 -I\n" +
                        "import os,shlex,subprocess,sys\n" +
                        "if sys.argv[1:] != ['-i']:\n" +
                        "    os.execv('/usr/bin/security',['security',*sys.argv[1:]])\n" +
                        "command=sys.stdin.buffer.read()\n" +
                        "args=shlex.split(command.decode())\n" +
                        "if args[args.index('-s')+1] == " + repr(self.service) + ":\n" +
                        "    gate=os.open(" + repr(str(release)) + ",os.O_RDWR)\n" +
                        "    with open(" + repr(str(ready)) + ", 'w') as out: out.write('ready')\n" +
                        "    os.read(gate,1)\n" +
                        "r=subprocess.run(['/usr/bin/security','-i'],input=command,capture_output=True)\n" +
                        "sys.exit(r.returncode)\n")
        fake.chmod(0o700)
        launcher = self.temp / "writer.py"
        launcher.write_text("import importlib.util,sys\n" +
                            "spec=importlib.util.spec_from_file_location('kc'," + repr(str(MAIL / "kc_helpers.py")) + ")\n" +
                            "kc=importlib.util.module_from_spec(spec);spec.loader.exec_module(kc)\n" +
                            "kc.SECURITY=" + repr(str(fake)) + "\n" +
                            "sys.exit(kc.main())\n")
        fd = os.open(ready, os.O_RDONLY | os.O_NONBLOCK)
        writer = subprocess.Popen(["/usr/bin/python3", "-I", str(launcher), "write", self.service],
                                  env=self.env, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        later = None
        try:
            writer.stdin.write(self.second)
            writer.stdin.close()
            writer.stdin = None
            self.assertTrue(select.select([fd], [], [], 15)[0], "writer never reached mutation")
            self.assertEqual(os.read(fd, 5), b"ready")
            writer.kill()
            writer.wait(timeout=10)
            lock_path = next((self.temp / "kc-locks").glob("*.lock"))
            with lock_path.open("a") as lock:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            later = subprocess.Popen([str(MAIL / "kc-write"), self.service], env=self.env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            later.stdin.write(self.first)
            later.stdin.close()
            later.stdin = None
            gate = os.open(release, os.O_WRONLY | os.O_NONBLOCK)
            os.write(gate, b"x")
            os.close(gate)
            out, err = later.communicate(timeout=20)
            self.assertEqual(later.returncode, 0, err)
            self.assertEqual(out, b"")
            self.assertEqual(self.stored(), (0, self.first))
            self.assertEqual(self.stored(self.service + ".last-good"), (0, self.second))
        finally:
            os.close(fd)
            # Release any surviving fixture child even when an assertion failed.
            try:
                gate = os.open(release, os.O_WRONLY | os.O_NONBLOCK)
                os.write(gate, b"x")
                os.close(gate)
            except OSError:
                pass
            for process in [writer, later]:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=20)

    def test_existing_icloud_password_read(self):
        self.put(b"test-app-password", "himalaya-icloud", "himalaya")
        result = self.helper("kc-read", service="himalaya-icloud", account="himalaya")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"test-app-password\n")


if __name__ == "__main__":
    unittest.main()
