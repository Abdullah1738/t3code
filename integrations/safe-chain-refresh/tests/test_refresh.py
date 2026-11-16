from __future__ import annotations

import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import plistlib
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import refresh


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.cache = self.home / ".safe-chain/malwareDatabase_npm.json"
        self.cache.parent.mkdir()
        self.cache.write_text('[{"package_name":"keep","version":"*","reason":"MALWARE"}]')
        self.cached = self.cache.read_bytes()
        self.metrics = mock.patch.object(refresh.toollog, "emit")
        self.metrics.start()

    def tearDown(self):
        self.metrics.stop()
        self.scratch.cleanup()

    def node(self, body):
        executable = self.root / "node"
        executable.write_text(f"#!{sys.executable}\n" + body)
        executable.chmod(0o755)
        return str(executable)

    def run_refresh(self, code, timeout=2):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            result = refresh.refresh(self.home, self.root / "vendor", self.node(code), timeout)
        return result, output.getvalue()

    def test_success_runs_only_list_helper_in_a_scratch_cwd(self):
        result, _ = self.run_refresh(
            "import json, os\nfrom pathlib import Path\n"
            "assert Path.cwd() != Path(os.environ['HOME'])\n"
            "assert Path.cwd().name.startswith('safe-chain-refresh-')\n"
            "assert Path(__import__('sys').argv[1]).name == 'refresh.mjs'\n"
            "print(json.dumps({'expected':5,'refreshed':5,'cached':0,'failed':0}))\n")
        self.assertEqual(result, (0, "ok"))
        self.assertEqual(self.cache.read_bytes(), self.cached)
        self.assertFalse((self.home / "package.json").exists())
        self.assertFalse((self.home / "node_modules").exists())
        state = json.loads((self.home / ".local/share/safe-chain-refresh/state.json").read_text())
        self.assertEqual((state["status"], state["refreshed"]), ("ok", 5))

    def test_timeout_stops_its_child_and_preserves_cache_without_logging_child_text(self):
        popen = subprocess.Popen
        def ready_child(*args, **kwargs):
            proc = popen(*args, **kwargs)
            self.assertEqual(proc.stdout.readline(), b"ready\n")
            return proc
        start = time.monotonic()
        with mock.patch.object(refresh.subprocess, "Popen", side_effect=ready_child):
            result, output = self.run_refresh(
                "import os, sys, time, signal\nfrom pathlib import Path\n"
                "Path(os.environ['HOME'],'child.pid').write_text(str(os.getpid()))\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "print('ready',flush=True)\n"
                "print('private-mirror-credential',file=sys.stderr,flush=True)\n"
                "sys.stderr.buffer.write(b'\\xff'); sys.stderr.flush()\n"
                "time.sleep(60)\n", timeout=.15)
        self.assertLess(time.monotonic() - start, 3)
        self.assertEqual(result, (1, "timeout"))
        self.assertIn("deadline 0.15s exceeded", output)
        self.assertNotIn("private-mirror-credential", output)
        self.assertEqual(self.cache.read_bytes(), self.cached)
        pid = int((self.home / "child.pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_lock_prevents_overlapping_child(self):
        runtime = self.home / ".local/share/safe-chain-refresh"
        runtime.mkdir(parents=True)
        with (runtime / "refresh.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result, output = self.run_refresh("raise SystemExit('must not run')\n")
        self.assertEqual(result, (0, "locked"))
        self.assertIn("another refresh is running", output)
        self.assertFalse((runtime / "state.json").exists())

    def test_timeout_stops_descendants_even_when_the_leader_exits_and_pipes_close(self):
        for close_pipes in (False, True):
            with self.subTest(close_pipes=close_pipes):
                read_fd, write_fd = os.pipe()
                spawned = []
                popen = subprocess.Popen
                def ready_child(*args, **kwargs):
                    proc = popen(*args, **kwargs, pass_fds=(write_fd,))
                    spawned.append(proc)
                    os.close(write_fd)
                    self.assertEqual(proc.stdout.readline(), b"ready\n")
                    return proc
                code = (
                    "import os, signal, time\n"
                    "ready_r, ready_w = os.pipe()\n"
                    "child = os.fork()\n"
                    "if child == 0:\n"
                    "    os.close(ready_r)\n"
                    "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                    + ("    os.close(0); os.close(1); os.close(2)\n" if close_pipes else "") +
                    "    os.write(ready_w, b'1'); os.close(ready_w)\n"
                    "    time.sleep(60)\n"
                    "else:\n"
                    f"    os.close({write_fd})\n"
                    "    os.close(ready_w); os.read(ready_r, 1); os.close(ready_r)\n"
                    "    print('ready', flush=True)\n"
                    "    time.sleep(60)\n")
                try:
                    with mock.patch.object(refresh.subprocess, "Popen", side_effect=ready_child):
                        result, _ = self.run_refresh(code, timeout=.15)
                    self.assertEqual(result, (1, "timeout"))
                    # Only the descendant holds this writer; EOF confirms its exit without PID polling.
                    self.assertEqual(select.select([read_fd], [], [], 1)[0], [read_fd])
                    self.assertEqual(os.read(read_fd, 1), b"")
                    self.assertEqual(self.cache.read_bytes(), self.cached)
                finally:
                    for proc in spawned:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=1)
                    os.close(read_fd)
                    if not spawned:
                        os.close(write_fd)

    def test_cached_fallback_and_failure_are_not_reported_as_fresh_success(self):
        for code, expected in [
            ("print('{\"expected\":5,\"refreshed\":4,\"cached\":1,\"failed\":0}')\n", "cached"),
            ("raise SystemExit(1)\n", "failed"),
            ("print('{\"expected\":5,\"refreshed\":5,\"cached\":false,\"failed\":0}')\n", "failed"),
        ]:
            with self.subTest(status=expected, code=code):
                result, _ = self.run_refresh(code)
                self.assertEqual(result, (1, expected))
                self.assertEqual(self.cache.read_bytes(), self.cached)

    def test_cleanup_errors_keep_timeout_state_and_do_not_escape(self):
        child = mock.Mock(pid=1234567)
        child.communicate.side_effect = subprocess.TimeoutExpired("fixture", 1)
        with mock.patch.object(refresh.subprocess, "Popen", return_value=child), mock.patch.object(refresh.os, "killpg"):
            result, _ = self.run_refresh("unused", timeout=.1)
        self.assertEqual(result, (1, "timeout"))
        child.stdout.close.assert_called_once()
        child.stderr.close.assert_called_once()
        state = json.loads((self.home / ".local/share/safe-chain-refresh/state.json").read_text())
        self.assertEqual(state["status"], "timeout")
        child.communicate.side_effect = None
        child.communicate.return_value = (b"", b"")
        with mock.patch.object(refresh.os, "killpg", side_effect=PermissionError):
            self.assertEqual(refresh.stop_child(child), (b"", b""))

    @unittest.skipUnless(shutil.which("node"), "node is required for the installed-API contract")
    def test_helper_uses_installed_api_and_detects_cached_fallback_and_upgrade_drift(self):
        vendor = self.root / "vendor"
        (vendor / "src/api").mkdir(parents=True)
        (vendor / "src/config").mkdir()
        (vendor / "src/environment").mkdir()
        (vendor / "package.json").write_text(json.dumps({"name":"@aikidosec/safe-chain","type":"module","version":"1.5.29"}))
        (vendor / "src/config/settings.js").write_text(
            "export function setVersion(v) { if(v !== '1.5.29') throw Error(); }\n"
            "export const defaultMalwareListBaseUrl = 'https://default.test';\n"
            "export function getMalwareListBaseUrl() { return process.env.FIXTURE_BASE || defaultMalwareListBaseUrl; }\n"
            "export function getMinimumPackageAgeHours() { return Number(process.env.FIXTURE_AGE || 48); }\n")
        (vendor / "src/environment/userInteraction.js").write_text("export const ui = {writeWarning(){}, writeVerbose(){}};")
        keys = ["NPM_MALWARE_LIST", "PYPI_MALWARE_LIST", "NPM_NEW_PACKAGES_LIST_2D", "PYPI_NEW_PACKAGES_LIST_2D",
                "NPM_NEW_PACKAGES_LIST_7D", "PYPI_NEW_PACKAGES_LIST_7D", "SAFE_PATCHES_LIST"]
        api = vendor / "src/api/remoteList.js"
        prefix = "import {ui} from '../environment/userInteraction.js';\nexport const ListType = " + json.dumps({key:key for key in keys}) + ";\n"
        for implementation, expected in [
            ("export async function getRemoteList() { return []; }", {"expected":5,"refreshed":5,"cached":0,"failed":0}),
            ("export async function getRemoteList() { ui.writeWarning('secret mirror URL'); return []; }", {"expected":5,"refreshed":0,"cached":5,"failed":0}),
        ]:
            api.write_text(prefix + implementation)
            result = subprocess.run([shutil.which("node"), str(PACKAGE / "refresh.mjs"), str(vendor)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[-1]), expected)
            self.assertNotIn("secret mirror URL", result.stdout + result.stderr)
        requests = self.root / "requests.jsonl"
        api.write_text(prefix + "import fs from 'node:fs';\nexport async function getRemoteList(key) {\n"
                       f"fs.appendFileSync({json.dumps(str(requests))}, key+'\\n');\n"
                       "if(key === 'NPM_MALWARE_LIST') { ui.writeWarning('secret'); await new Promise(setImmediate); }\n"
                       "if(key === 'PYPI_MALWARE_LIST') throw Error('secret');\nreturn []; }")
        for base, age, duration in [("https://default.test", "48", "2D"),
                                     ("https://mirror.test", "48", "7D"),
                                     ("https://default.test", "49", "7D")]:
            with self.subTest(base=base, age=age):
                requests.write_text("")
                env = dict(os.environ, FIXTURE_BASE=base, FIXTURE_AGE=age)
                result = subprocess.run([shutil.which("node"), str(PACKAGE / "refresh.mjs"), str(vendor)],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(set(requests.read_text().splitlines()), {
                    "SAFE_PATCHES_LIST", "NPM_MALWARE_LIST", "PYPI_MALWARE_LIST",
                    "NPM_NEW_PACKAGES_LIST_"+duration, "PYPI_NEW_PACKAGES_LIST_"+duration})
                self.assertEqual(json.loads(result.stdout.splitlines()[-1]),
                                 dict(expected=5, refreshed=3, cached=1, failed=1))
        api.write_text(prefix + "export async function getRemoteList(key) {\n"
                       "if(key === 'NPM_MALWARE_LIST') return new Promise(() => setInterval(() => {}, 1000));\nreturn []; }")
        captured = io.StringIO()
        with contextlib.redirect_stderr(captured):
            outcome = refresh.refresh(self.home, vendor, shutil.which("node"), 1)
        self.assertEqual(outcome, (1, "timeout"))
        state = json.loads((self.home / ".local/share/safe-chain-refresh/state.json").read_text())
        self.assertEqual((state["expected"], state["refreshed"], state["failed"]), (5, 4, 0))
        self.assertEqual(self.cache.read_bytes(), self.cached)
        api.write_text("export const ListType = {}; export async function getRemoteList() {}")
        result = subprocess.run([shutil.which("node"), str(PACKAGE / "refresh.mjs"), str(vendor)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)


class InstallTests(unittest.TestCase):
    def test_launchd_reloads_only_its_own_changed_definition_and_check_detects_unapplied_change(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            loaded = False
            calls = []
            def run(command, **kwargs):
                nonlocal loaded
                if command[0] == "git":
                    return subprocess.CompletedProcess(command, 0)
                self.assertEqual(command[0], "launchctl")
                self.assertIn(refresh.LABEL, " ".join(command))
                calls.append(command[1])
                rc = 0
                if command[1] == "print":
                    rc = 0 if loaded else 1
                elif command[1] == "bootstrap":
                    loaded = True
                elif command[1] == "bootout":
                    loaded = False
                return subprocess.CompletedProcess(command, rc)
            with mock.patch.object(refresh.subprocess, "check_output", side_effect=[temp, ""] * 3), \
                 mock.patch.object(refresh.subprocess, "run", side_effect=run):
                self.assertEqual(refresh.install(home, check=False, dry_run=False, no_launch=False), 0)
                self.assertEqual(calls, ["print", "bootstrap"])
                calls.clear()
                self.assertEqual(refresh.install(home, check=False, dry_run=False, no_launch=False), 0)
                self.assertEqual(calls, ["print"])
                changed = plistlib.loads(refresh.plist_bytes(home))
                changed["StartInterval"] = 1200
                calls.clear()
                with mock.patch.object(refresh, "plist_bytes", return_value=plistlib.dumps(changed)):
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(refresh.install(home, check=True, dry_run=False, no_launch=False), 1)
                    calls.clear()
                    self.assertEqual(refresh.install(home, check=False, dry_run=False, no_launch=False), 0)
                    self.assertEqual(calls, ["print", "bootout", "bootstrap"])
                    self.assertEqual(refresh.install(home, check=True, dry_run=False, no_launch=False), 0)

    def test_install_check_and_drift_in_an_isolated_committed_repository_without_launchd(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo = root / "repo"
            package = repo / "integrations/safe-chain-refresh"
            shutil.copytree(PACKAGE, package, ignore=shutil.ignore_patterns("tests", "__pycache__"))
            home = root / "home with spaces"
            home.mkdir()
            home = home.resolve()
            env = dict(os.environ, HOME=str(home), PYTHONDONTWRITEBYTECODE="1")
            def git(*args):
                return subprocess.run(["git", "-C", str(repo), *args], env=env, capture_output=True, text=True, check=True)
            git("init")
            git("add", "integrations")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
            git("update-ref", "refs/remotes/origin/main", "HEAD")
            command = [sys.executable, str(package / "refresh.py"), "install", "--home", str(home), "--no-launch"]
            installed = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            checked = subprocess.run(command + ["--check"], env=env, capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            installed_command = [sys.executable, str(home / ".local/bin/safe-chain-refresh"),
                                 "install", "--home", str(home), "--no-launch", "--check"]
            checked = subprocess.run(installed_command, env=env, capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            plist = plistlib.loads((home / "Library/LaunchAgents/com.ardud.safe-chain-refresh.plist").read_bytes())
            self.assertEqual(plist["StartInterval"], 1800)
            self.assertEqual(plist["ProgramArguments"][1], str(home / ".local/share/safe-chain-refresh/refresh.py"))
            self.assertTrue((home / ".local/bin/safe-chain-refresh").is_symlink())
            (home / ".local/share/safe-chain-refresh/refresh.mjs").write_text("drift")
            for check_command in (command + ["--check"], installed_command):
                checked = subprocess.run(check_command, env=env, capture_output=True, text=True)
                self.assertEqual(checked.returncode, 1)
                self.assertIn("FAIL", checked.stderr)
                self.assertNotIn("Traceback", checked.stderr)
            self.assertEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
            (home / ".local/share/safe-chain-refresh/launchd/com.ardud.safe-chain-refresh.plist").unlink()
            checked = subprocess.run(installed_command, env=env, capture_output=True, text=True)
            self.assertEqual(checked.returncode, 1)
            self.assertIn("FAIL", checked.stderr)
            self.assertNotIn("Traceback", checked.stderr)
            (package / "uncommitted").write_text("do not install")
            refused = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(refused.returncode, 1)
            self.assertIn("source must be clean and merged", refused.stderr)


if __name__ == "__main__":
    unittest.main()
