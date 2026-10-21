#!/usr/bin/env python3
"""authbox tests. Uses a fake offbox (box home = a local dir) and a fake agent-browser; never a real box."""

import json
import os
import shutil
import stat
import tempfile
import time
import unittest
from pathlib import Path

import subprocess

HERE = Path(__file__).resolve().parent
AUTHBOX = HERE.parent / "bin" / "authbox"
FAKES = HERE / "fakes"


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class AuthboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="authbox-test-"))
        self.root = self.tmp / "root"
        self.boxhome = self.tmp / "boxhome"
        self.boxhome.mkdir()
        self.calls = self.tmp / "offbox.log"
        self.ab_log = self.tmp / "ab.log"
        self.env = {
            **os.environ,
            "AUTHBOX_ROOT": str(self.root),
            "AUTHBOX_OFFBOX": str(FAKES / "offbox"),
            "AUTHBOX_AGENT_BROWSER": str(FAKES / "agent-browser"),
            "FAKE_LOG": str(self.calls),
            "FAKE_BOXHOME": str(self.boxhome),
            "FAKE_AB_LOG": str(self.ab_log),
        }

    def tearDown(self):
        self.authbox("down", "moni", check=False)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def authbox(self, *args, input_text="", check=True):
        p = subprocess.run([str(AUTHBOX), *args], env=self.env, input=input_text,
                           capture_output=True, text=True, timeout=120)
        if check and p.returncode != 0:
            self.fail(f"authbox {args} rc={p.returncode}: {p.stderr}")
        return p

    def offbox_calls(self):
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines() if line]

    def state(self, person="moni"):
        env = {}
        f = self.root / "state" / f"{person}.env"
        if f.exists():
            for line in f.read_text().splitlines():
                k, _, v = line.partition("=")
                env[k] = v
        return env

    def test_up_is_idempotent_and_keeps_person_data_out_of_mac_dir(self):
        port1 = self.authbox("up", "moni").stdout.strip()
        port2 = self.authbox("up", "moni").stdout.strip()
        self.assertEqual(port1, port2)
        ports_calls = [c for c in self.offbox_calls() if c["args"][0] == "ports"]
        self.assertEqual(len(ports_calls), 1)
        self.assertTrue(pid_alive(int(self.state()["TUNNEL_PID"])))
        self.assertTrue((self.boxhome / "authbox" / "launch.py").exists())
        self.assertEqual((self.boxhome / "authbox" / "config.json").read_text().strip(), "{}")
        person_dir = self.root / "moni"
        self.assertFalse((person_dir / ".git").exists())
        self.assertEqual(list(person_dir.iterdir()), [])

    def test_every_offbox_call_is_person_scoped_and_never_falls_back(self):
        self.authbox("up", "moni")
        for c in self.offbox_calls():
            self.assertEqual(c["thread"], "authbox:moni")
            self.assertEqual(os.path.realpath(c["cwd"]), os.path.realpath(self.root / "moni"))
        for c in self.offbox_calls():
            if c["args"][0] == "run":
                self.assertIn("--no-fallback", c["args"])
                self.assertIn("--remote", c["args"])

    def test_browser_passes_session_cdp_and_human_input_flags(self):
        self.authbox("up", "moni")
        port = self.state()["LOCAL_PORT"]
        self.authbox("browser", "moni", "--", "snapshot", "-i")
        args = json.loads(self.ab_log.read_text())
        self.assertEqual(args, ["--session", "authbox-moni", "--cdp", port,
                                "--input-mode", "human", "snapshot", "-i"])

    def test_secret_round_trip_through_box(self):
        self.authbox("secret", "set", "moni", "token", input_text="s3cret")
        f = self.boxhome / "authbox" / "secrets" / "token"
        self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        self.assertEqual(self.authbox("secret", "get", "moni", "token").stdout, "s3cret")
        self.assertIn("token", self.authbox("secret", "list", "moni").stdout.split())
        self.authbox("secret", "rm", "moni", "token")
        self.assertNotEqual(self.authbox("secret", "get", "moni", "token", check=False).returncode, 0)

    def test_secret_name_is_validated(self):
        p = self.authbox("secret", "set", "moni", "../evil", input_text="x", check=False)
        self.assertNotEqual(p.returncode, 0)

    def test_run_executes_in_authbox_work_dir(self):
        self.authbox("run", "moni", "--", "echo", "hi")
        runs = [c for c in self.offbox_calls() if c["args"][0] == "run"]
        self.assertIn("cd ~/authbox/work && echo hi", runs[-1]["args"][-1])

    def test_down_cleans_state_and_stops_tunnel(self):
        self.authbox("up", "moni")
        pid = int(self.state()["TUNNEL_PID"])
        self.authbox("down", "moni")
        self.assertFalse((self.root / "state" / "moni.env").exists())
        for _ in range(50):
            if not pid_alive(pid):
                break
            time.sleep(0.1)
        self.assertFalse(pid_alive(pid))
        self.assertTrue(any(c["args"][0] == "release" for c in self.offbox_calls()))

    def test_person_slug_is_validated(self):
        self.assertNotEqual(self.authbox("up", "Bad!", check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
