#!/usr/bin/env python3
"""offbox-person tests. Uses a fake offbox (box home = a local dir) and a fake agent-browser; never a real box."""

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
TOOL = HERE.parent / "bin" / "offbox-person"
FAKES = HERE / "fakes"


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class OffboxPersonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="person-test-"))
        self.root = self.tmp / "root"
        self.boxhome = self.tmp / "boxhome"
        self.boxhome.mkdir()
        self.calls = self.tmp / "offbox.log"
        self.ab_log = self.tmp / "ab.log"
        self.env = {
            **os.environ,
            "OFFBOX_PERSON_ROOT": str(self.root),
            "OFFBOX_PERSON_OFFBOX": str(FAKES / "offbox"),
            "OFFBOX_PERSON_AGENT_BROWSER": str(FAKES / "agent-browser"),
            "FAKE_LOG": str(self.calls),
            "FAKE_BOXHOME": str(self.boxhome),
            "FAKE_AB_LOG": str(self.ab_log),
        }

    def tearDown(self):
        self.tool("down", "moni", check=False)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def tool(self, *args, input_text="", check=True):
        p = subprocess.run([str(TOOL), *args], env=self.env, input=input_text,
                           capture_output=True, text=True, timeout=120)
        if check and p.returncode != 0:
            self.fail(f"offbox-person {args} rc={p.returncode}: {p.stderr}")
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
        port1 = self.tool("up", "moni").stdout.strip()
        port2 = self.tool("up", "moni").stdout.strip()
        self.assertEqual(port1, port2)
        ports_calls = [c for c in self.offbox_calls() if c["args"][0] == "ports"]
        self.assertEqual(len(ports_calls), 1)
        self.assertTrue(pid_alive(int(self.state()["TUNNEL_PID"])))
        self.assertTrue((self.boxhome / "person" / "launch.py").exists())
        self.assertEqual((self.boxhome / "person" / "config.json").read_text().strip(), "{}")
        person_dir = self.root / "moni"
        self.assertFalse((person_dir / ".git").exists())
        self.assertEqual(list(person_dir.iterdir()), [])

    def test_every_offbox_call_is_person_scoped_and_never_falls_back(self):
        self.tool("up", "moni")
        for c in self.offbox_calls():
            self.assertEqual(c["thread"], "person:moni")
            self.assertEqual(os.path.realpath(c["cwd"]), os.path.realpath(self.root / "moni"))
        for c in self.offbox_calls():
            if c["args"][0] == "run":
                self.assertIn("--no-fallback", c["args"])
                self.assertIn("--remote", c["args"])

    def test_browser_passes_session_cdp_and_human_input_flags(self):
        self.tool("up", "moni")
        port = self.state()["LOCAL_PORT"]
        self.tool("browser", "moni", "--", "snapshot", "-i")
        args = json.loads(self.ab_log.read_text())
        self.assertEqual(args, ["--session", "person-moni", "--cdp", port,
                                "--input-mode", "human", "snapshot", "-i"])

    def test_secret_round_trip_through_box(self):
        self.tool("secret", "set", "moni", "token", input_text="s3cret")
        f = self.boxhome / "person" / "secrets" / "token"
        self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        self.assertEqual(self.tool("secret", "get", "moni", "token").stdout, "s3cret")
        self.assertIn("token", self.tool("secret", "list", "moni").stdout.split())
        self.tool("secret", "rm", "moni", "token")
        self.assertNotEqual(self.tool("secret", "get", "moni", "token", check=False).returncode, 0)

    def test_secret_name_is_validated(self):
        p = self.tool("secret", "set", "moni", "../evil", input_text="x", check=False)
        self.assertNotEqual(p.returncode, 0)

    def test_run_executes_in_person_work_dir(self):
        self.tool("run", "moni", "--", "echo", "hi")
        runs = [c for c in self.offbox_calls() if c["args"][0] == "run"]
        self.assertIn("cd ~/person/work && echo hi", runs[-1]["args"][-1])

    def test_down_cleans_state_and_stops_tunnel(self):
        self.tool("up", "moni")
        pid = int(self.state()["TUNNEL_PID"])
        self.tool("down", "moni")
        self.assertFalse((self.root / "state" / "moni.env").exists())
        for _ in range(50):
            if not pid_alive(pid):
                break
            time.sleep(0.1)
        self.assertFalse(pid_alive(pid))
        self.assertTrue(any(c["args"][0] == "release" for c in self.offbox_calls()))

    def test_person_slug_is_validated(self):
        self.assertNotEqual(self.tool("up", "Bad!", check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
