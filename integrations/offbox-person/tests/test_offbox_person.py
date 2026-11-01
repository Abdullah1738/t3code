#!/usr/bin/env python3
"""offbox-person tests. Uses a fake offbox (box home = a local dir) and a fake agent-browser; never a real box."""

import json
import os
import shutil
import socket
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
        self.cua_log = self.tmp / "cua.log"
        self.mac_tmp = self.tmp / "mactmp"
        self.mac_tmp.mkdir()
        # session.sh only runs on a real box; the fake box gets the env file it would write, pointing at a fake cua-driver.
        (self.boxhome / "person").mkdir()
        (self.boxhome / "person" / "session.env").write_text(f"export PATH={FAKES}:$PATH\n")
        self.env = {
            **os.environ,
            "OFFBOX_PERSON_ROOT": str(self.root),
            "OFFBOX_PERSON_OFFBOX": str(FAKES / "offbox"),
            "OFFBOX_PERSON_AGENT_BROWSER": str(FAKES / "agent-browser"),
            "OFFBOX_PERSON_BACKUP": str(FAKES / "offbox-person-backup"),
            "FAKE_BACKUP_LOG": str(self.tmp / "backup.log"),
            "FAKE_LOG": str(self.calls),
            "FAKE_BOXHOME": str(self.boxhome),
            "FAKE_AB_LOG": str(self.ab_log),
            "FAKE_CUA_LOG": str(self.cua_log),
            "TMPDIR": str(self.mac_tmp),
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

    def ssh_responses(self, *responses):
        path = self.tmp / "ssh-responses.json"
        path.write_text(json.dumps(responses))
        self.env["FAKE_SSH_RESPONSES"] = str(path)
        self.calls.write_text("")

    def ssh_calls(self):
        return [c for c in self.offbox_calls() if c["args"][0] == "ssh"]

    def ab_calls(self):
        if not self.ab_log.exists():
            return []
        return [json.loads(line) for line in self.ab_log.read_text().splitlines() if line]

    def state(self, person="moni"):
        env = {}
        f = self.root / "state" / f"{person}.env"
        if f.exists():
            for line in f.read_text().splitlines():
                k, _, v = line.partition("=")
                env[k] = v
        return env

    def wait_dead(self, pid: int) -> bool:
        for _ in range(50):
            if not pid_alive(pid):
                return True
            time.sleep(0.1)
        return False

    def test_up_is_idempotent_and_keeps_person_data_out_of_mac_dir(self):
        port1 = self.tool("up", "moni").stdout.strip()
        port2 = self.tool("up", "moni").stdout.strip()
        self.assertEqual(port1, port2)
        ports_calls = [c["args"] for c in self.offbox_calls() if c["args"][0] == "ports"]
        self.assertEqual(len(ports_calls), 2)
        self.assertTrue(pid_alive(int(self.state()["TUNNEL_PID"])))
        self.assertTrue((self.boxhome / "person" / "launch.py").exists())
        self.assertTrue((self.boxhome / "person" / "session.sh").exists())
        self.assertEqual((self.boxhome / "person" / "config.json").read_text().strip(), "{}")
        person_dir = self.root / "moni"
        self.assertFalse((person_dir / ".git").exists())
        self.assertEqual(list(person_dir.iterdir()), [])

    def test_home_route_reverse_tunnels_the_mac_socks_server_to_box_1055(self):
        self.tool("up", "moni")
        st = self.state()
        self.assertEqual(st["HOME_ROUTE"], "1")
        self.assertTrue(pid_alive(int(st["SOCKS_PID"])))
        self.assertTrue(pid_alive(int(st["HOME_PID"])))
        reverse = [c["args"] for c in self.offbox_calls() if c["args"][0] == "ports" and "--reverse" in c["args"]]
        self.assertEqual(reverse, [["ports", "1055", "--local", st["SOCKS_PORT"], "--reverse"]])
        with socket.create_connection(("127.0.0.1", int(st["SOCKS_PORT"])), timeout=5) as s:
            s.sendall(b"\x05\x01\x00")
            self.assertEqual(s.recv(2), b"\x05\x00")
        session = [c["args"][-1] for c in self.offbox_calls() if c["args"][0] == "ssh" and "session.sh" in c["args"][-1]]
        self.assertIn("HOME_ROUTE=1 bash ~/person/session.sh", session[-1])

    def test_home_route_off_in_config_starts_no_socks_or_reverse_tunnel(self):
        (self.root / "moni").mkdir(parents=True)
        (self.root / "moni" / "config.json").write_text('{"home": false}')
        self.tool("up", "moni")
        self.assertEqual(self.state()["HOME_ROUTE"], "0")
        self.assertEqual(self.state()["SOCKS_PID"], "")
        self.assertFalse(any("--reverse" in c["args"] for c in self.offbox_calls()))
        session = [c["args"][-1] for c in self.offbox_calls() if c["args"][0] == "ssh" and "session.sh" in c["args"][-1]]
        self.assertIn("HOME_ROUTE=0 bash", session[-1])

    def test_every_offbox_call_is_person_scoped_and_never_falls_back(self):
        self.tool("up", "moni")
        for c in self.offbox_calls():
            self.assertEqual(c["thread"], "person:moni")
            self.assertEqual(c["pool"], "1")
            self.assertEqual(os.path.realpath(c["cwd"]), os.path.realpath(self.root / "moni"))
        for c in self.offbox_calls():
            if c["args"][0] == "run":
                self.assertIn("--no-fallback", c["args"])
                self.assertIn("--remote", c["args"])

    def test_cua_passes_tool_and_json_through_intact(self):
        self.tool("up", "moni")
        payload = '{"text": "it\'s \\"quoted\\" $HOME `x`"}'
        out = self.tool("cua", "moni", "type_text", payload).stdout
        self.assertIn('"ok": true', out)
        last = json.loads(self.cua_log.read_text().splitlines()[-1])
        self.assertEqual(last, ["call", "type_text", payload])
        self.tool("cua", "moni", "list_windows")
        self.assertEqual(json.loads(self.cua_log.read_text().splitlines()[-1]), ["call", "list_windows", "{}"])

    def test_cua_tool_name_is_validated(self):
        self.tool("up", "moni")
        self.assertNotEqual(self.tool("cua", "moni", "x;rm -rf ~", check=False).returncode, 0)

    def test_shot_lands_in_tmpdir_and_down_removes_it(self):
        self.tool("up", "moni")
        out = Path(self.tool("shot", "moni").stdout.strip())
        self.assertEqual(out.parent, self.mac_tmp / "offbox-person" / "moni")
        self.assertTrue(out.read_bytes().startswith(b"\x89PNG"))
        self.tool("down", "moni")
        self.assertFalse(out.parent.exists())

    def test_browser_passes_session_cdp_and_human_input_flags(self):
        self.tool("up", "moni")
        port = self.state()["LOCAL_PORT"]
        self.tool("browser", "moni", "--", "snapshot", "-i")
        self.assertEqual(self.ab_calls()[-1], ["--session", "person-moni", "--cdp", port,
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

    def test_wa_read_retries_box_start_once_and_returns_second_output(self):
        for command in ((), ("status",), ("link-status",), ("chats",), ("find", "Ana's $name"),
                        ("read",), ("search",), ("ids",), ("events",)):
            for code in (90, 92):
                with self.subTest(command=command, code=code):
                    self.ssh_responses({"exit": code, "stderr": "offbox: not ready\n"},
                                       {"exit": 0, "stdout": "second result\n"})
                    result = self.tool("wa", "moni", *command)
                    self.assertEqual(result.stdout, "second result\n")
                    self.assertEqual(result.stderr, "offbox: not ready\n"
                                     f"offbox-person: her box didn't start in time (offbox exit {code}); retrying once\n")
                    calls = self.ssh_calls()
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(calls[0]["args"], calls[1]["args"])
                    self.assertEqual(calls[0]["thread"], "person:moni")
                    self.assertEqual(calls[0]["pool"], "1")

    def test_wa_read_reports_last_box_failure_after_one_retry(self):
        for first, second in ((90, 90), (90, 92), (92, 90), (92, 92)):
            with self.subTest(first=first, second=second):
                self.ssh_responses({"exit": first}, {"exit": second})
                result = self.tool("wa", "moni", "status", check=False)
                self.assertEqual(result.returncode, 90)
                self.assertEqual(result.stderr,
                                 f"offbox-person: her box didn't start in time (offbox exit {first}); retrying once\n"
                                 f"offbox-person: her box didn't start (offbox exit {second}). Her WhatsApp link state is unknown: this is not 'not linked'. Try again in a few minutes.\n")
                self.assertEqual(len(self.ssh_calls()), 2)

    def test_wa_read_discards_failed_attempt_output_before_retry(self):
        self.ssh_responses({"exit": 90, "stdout": "offline (not linked)\n"},
                           {"exit": 0, "stdout": "online pid 1\n"})
        result = self.tool("wa", "moni", "status")
        self.assertEqual(result.stdout, "online pid 1\n")
        self.assertEqual(len(self.ssh_calls()), 2)

    def test_wa_read_without_retry_preserves_stdout_and_trailing_newlines(self):
        self.ssh_responses({"exit": 1, "stdout": "offline (linked)\n\n"})
        result = self.tool("wa", "moni", "status", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "offline (linked)\n\n")
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(self.ssh_calls()), 1)

    def test_wa_not_linked_and_other_exits_pass_through(self):
        for command, response in (
            (("status",), {"exit": 1, "stdout": "offline (not linked)\n"}),
            (("link-status",), {"exit": 0, "stdout": "not linked\n"}),
            (("chats",), {"exit": 2, "stderr": "wa: not linked yet\n"}),
            (("status",), {"exit": 17, "stderr": "remote error\n"}),
            (("send", "jid", "text"), {"exit": 2, "stderr": "wa: not linked yet\n"}),
        ):
            with self.subTest(command=command):
                self.ssh_responses(response)
                result = self.tool("wa", "moni", *command, check=False)
                self.assertEqual(result.returncode, response["exit"])
                self.assertEqual(result.stdout, response.get("stdout", ""))
                self.assertEqual(result.stderr, response.get("stderr", ""))
                self.assertEqual(len(self.ssh_calls()), 1)

    def test_wa_read_retry_can_return_not_linked_without_box_error(self):
        self.ssh_responses({"exit": 90}, {"exit": 2, "stderr": "wa: not linked yet\n"})
        result = self.tool("wa", "moni", "chats", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr,
                         "offbox-person: her box didn't start in time (offbox exit 90); retrying once\n"
                         "wa: not linked yet\n")
        self.assertEqual(len(self.ssh_calls()), 2)

    def test_wa_writes_and_unknown_commands_never_retry(self):
        for command in ("send", "sendfile", "new", "link", "start", "restart", "stop", "download", "unknown"):
            for code in (90, 92):
                with self.subTest(command=command, code=code):
                    self.ssh_responses({"exit": code}, {"exit": 0})
                    result = self.tool("wa", "moni", command, "arg", check=False)
                    self.assertEqual(result.returncode, 90)
                    self.assertEqual(result.stderr,
                                     f"offbox-person: her box didn't start (offbox exit {code}). Her WhatsApp link state is unknown: this is not 'not linked'. Try again in a few minutes.\n"
                                     "offbox-person: the command may have run; check before repeating it.\n")
                    self.assertEqual(len(self.ssh_calls()), 1)

    def test_wa_setup_stops_on_box_failure_at_each_step_without_retry(self):
        for step in range(3):
            for code in (90, 92):
                with self.subTest(step=step, code=code):
                    self.ssh_responses(*([{"exit": 0}] * step), {"exit": code}, {"exit": 0})
                    result = self.tool("wa", "moni", "setup", check=False)
                    self.assertEqual(result.returncode, 90)
                    self.assertEqual(result.stderr,
                                     f"offbox-person: her box didn't start (offbox exit {code}). Her WhatsApp link state is unknown: this is not 'not linked'. Try again in a few minutes.\n"
                                     "offbox-person: the command may have run; check before repeating it.\n")
                    self.assertEqual(len(self.ssh_calls()), step + 1)

    def test_wa_setup_other_failure_passes_through_without_retry(self):
        for step in range(3):
            with self.subTest(step=step):
                self.ssh_responses(*([{"exit": 0}] * step), {"exit": 17, "stderr": "setup failed\n"})
                result = self.tool("wa", "moni", "setup", check=False)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(result.stderr, "setup failed\n")
                self.assertEqual(len(self.ssh_calls()), step + 1)

    def test_down_cleans_state_and_stops_tunnels_and_socks(self):
        self.tool("up", "moni")
        st = self.state()
        pids = [int(st[k]) for k in ("TUNNEL_PID", "HOME_PID", "SOCKS_PID")]
        self.tool("down", "moni")
        self.assertFalse((self.root / "state" / "moni.env").exists())
        for pid in pids:
            self.assertTrue(self.wait_dead(pid), pid)
        self.assertTrue(any(c["args"][0] == "release" for c in self.offbox_calls()))
        stop = [c for c in self.offbox_calls() if c["args"][0] == "ssh" and "stop-browser" in c["args"][-1]]
        self.assertEqual(len(stop), 1)
        self.assertIn(["--session", "person-moni", "close"], self.ab_calls())

    def test_save_closes_browser_and_local_processes_before_snapshot(self):
        self.tool("up", "moni")
        st = self.state()
        self.tool("save", "moni")
        for k in ("TUNNEL_PID", "HOME_PID", "SOCKS_PID"):
            self.assertTrue(self.wait_dead(int(st[k])), k)
        subs = [c["args"][0] if c["args"][0] != "ssh" else c["args"][-1] for c in self.offbox_calls()]
        stop_at = max(i for i, s in enumerate(subs) if "stop-browser" in s)
        self.assertLess(stop_at, subs.index("save"))
        self.assertIn("keep", subs)

    def test_person_slug_is_validated(self):
        self.assertNotEqual(self.tool("up", "Bad!", check=False).returncode, 0)

    def test_down_and_save_start_a_background_backup(self):
        self.tool("up", "moni")
        self.tool("down", "moni")
        self.tool("save", "moni")
        log = self.tmp / "backup.log"
        for _ in range(50):
            if log.exists() and len(log.read_text().splitlines()) >= 2:
                break
            time.sleep(0.1)
        self.assertEqual(log.read_text().splitlines(), ["moni --after-stop", "moni --after-stop"])


if __name__ == "__main__":
    unittest.main()
