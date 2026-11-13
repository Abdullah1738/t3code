"""Socket fixtures and dummy listeners only; never execute the installed watchdog."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
LIB = HERE / "libexec/mirage"
FIXTURES = Path(__file__).parent / "fixtures/mirage"
spec = importlib.util.spec_from_file_location("mirage_clients", LIB / "clients.py")
clients = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clients)


def lsof(protocol="TCP", local="100.64.0.1:9853", peer="100.64.0.2:53876", state="ESTABLISHED"):
    return "p4100\ncMirage Beacon\nf7\nP{}\nn{}->{}\nTST={}\nTQR=0\nTQS=0\n".format(protocol, local, peer, state)


class FlowTest(unittest.TestCase):
    def test_captured_samples_and_duplicate_descriptors_are_one_flow(self):
        sample = (FIXTURES / "lsof.txt").read_text()
        self.assertEqual(len(clients.parse_lsof(sample, 4100)), 1)
        sample = (FIXTURES / "nettop.csv").read_text()
        row = sample.splitlines()[-1] + "\n"
        self.assertEqual(len(clients.parse_nettop(sample + row, 4100)), 1)
        self.assertEqual(clients.parse_lsof((FIXTURES / "lsof-udp.txt").read_text(), 4100),
                         clients.parse_nettop(sample, 4100))

    def test_address_forms(self):
        rows = [
            ("100.64.0.1:9853", "100.64.0.2:1234", True),
            ("[2001:db8::1]:9853", "[2001:db8::2]:1234", True),
            ("2001:db8::1.9853", "2001:db8::2.1234", True),
            ("fe80::1%en0.9853", "fe80::2%en0.1234", True),
            ("127.0.0.1:9853", "127.1.2.3:1234", False),
            ("[::1]:9853", "[::1]:1234", False),
            ("[::ffff:127.0.0.1]:9853", "[::ffff:127.0.0.2]:1234", False),
            ("*:9853", "*:*", False),
            ("*.9853", "*.*", False),
        ]
        for local, peer, expected in rows:
            with self.subTest(local=local, peer=peer):
                state = "LISTEN" if "*" in peer else "ESTABLISHED"
                self.assertEqual(bool(clients.parse_lsof(lsof(local=local, peer=peer, state=state), 4100)), expected)
                sample = ",state,\nMirage Beacon.4100,,\ntcp6 {}<->{},{},\n".format(local, peer, state)
                self.assertEqual(bool(clients.parse_nettop(sample, 4100)), expected)

    def test_only_established_tcp_or_connected_udp_blocks(self):
        # Entire TCP-state class: both tools' casing and separator forms, plus malformed states.
        rows = [
            ("ESTABLISHED", 1), ("Established", 1),
            ("LISTEN", 0), ("Listen", 0), ("CLOSED", 0), ("Closed", 0), ("IDLE", 0), ("BOUND", 0),
            ("SYN_SENT", 0), ("SynSent", 0), ("SYN_RCVD", 0), ("SYN_RCD", 0), ("SynReceived", 0),
            ("CLOSE_WAIT", 0), ("CloseWait", 0), ("FIN_WAIT_1", 0), ("FinWait1", 0),
            ("FIN_WAIT_2", 0), ("FinWait2", 0), ("CLOSING", 0), ("Closing", 0),
            ("LAST_ACK", 0), ("LastAck", 0), ("TIME_WAIT", 0), ("TimeWait", 0),
            ("UNKNOWN", None), ("Unknown", None), ("", None), ("ESTABLISHED?", None), ("123", None),
        ]
        for state, expected in rows:
            with self.subTest(state=state):
                sample = ",state,\nMirage Beacon.4100,,\ntcp4 100.64.0.1:9853<->100.64.0.2:53876,{},\n".format(state)
                if expected is None:
                    with self.assertRaises(clients.DetectionError):
                        clients.parse_lsof(lsof(state=state), 4100)
                    with self.assertRaises(clients.DetectionError):
                        clients.parse_nettop(sample, 4100)
                    continue
                self.assertEqual(len(clients.parse_lsof(lsof(state=state), 4100)), expected)
                self.assertEqual(len(clients.parse_nettop(sample, 4100)), expected)
        self.assertEqual(len(clients.parse_lsof(lsof(protocol="UDP").replace("TST=ESTABLISHED\n", ""), 4100)), 1)
        self.assertEqual(clients.parse_lsof("p4100\nf7\nPUDP\nn*:9854\n", 4100), set())

    def test_five_tuple_dedupes_across_tools_but_preserves_distinct_transports_and_ports(self):
        a = clients.parse_lsof(lsof(), 4100)
        b = clients.parse_nettop(",state,\nMirage Beacon.4100,,\ntcp4 100.64.0.1:9853<->100.64.0.2:53876,Established,\n", 4100)
        self.assertEqual(len(a | b), 1)
        self.assertEqual(len(a | clients.parse_lsof(lsof(protocol="UDP"), 4100)), 2)
        self.assertEqual(len(a | clients.parse_lsof(lsof(peer="100.64.0.2:53877"), 4100)), 2)

    def test_malformed_or_incomplete_output_never_means_clear(self):
        for parser, samples in [
            (clients.parse_lsof, ["", "garbage", "p4100\n", "p4100\nf3\n", "p4100\nf3\nPTCP\n",
                                  "p99\nf3\nPUDP\nn100.64.0.1:1->100.64.0.2:2\n",
                                  lsof().replace("TST=ESTABLISHED\n", ""), lsof(peer="bad:1234")]),
            (clients.parse_nettop, ["", "garbage", ",state,\nOther.99,,\n", ",state,\nMirage Beacon.4100,,\nbad row\n",
                                    ",bytes_in,\nMirage Beacon.4100,,\ntcp4 100.64.0.1:1<->100.64.0.2:2,10,\n"]),
        ]:
            for sample in samples:
                with self.subTest(parser=parser.__name__, sample=sample), self.assertRaises(clients.DetectionError):
                    parser(sample, 4100)

    def test_bound_connected_and_malformed_address_matrix(self):
        rows = [
            ("TCP", "LISTEN", "*:9853", False), ("TCP", "LISTEN", "[::]:9853", False),
            ("UDP", "", "*:9854", False), ("UDP", "", "100.64.0.1:9854", False),
            ("TCP", "ESTABLISHED", "100.64.0.1:9853->100.64.0.2:53876", True),
            ("TCP", "ESTABLISHED", "100.64.0.1:9853", None),
            ("TCP", "ESTABLISHED", "100.64.0.1:9853->*:*", None),
            ("UDP", "", "garbage", None), ("TCP", "LISTEN", "garbage", None),
            ("UDP", "", "100.64.0.1:no-port", None), ("UDP", "", "", None),
        ]
        for protocol, state, address, expected in rows:
            with self.subTest(protocol=protocol, state=state, address=address):
                sample = "p4100\nf7\nP{}\nn{}\n".format(protocol, address)
                if state:
                    sample += "TST={}\n".format(state)
                if expected is None:
                    with self.assertRaises(clients.DetectionError):
                        clients.parse_lsof(sample, 4100)
                else:
                    self.assertEqual(bool(clients.parse_lsof(sample, 4100)), expected)
        for state in ("Unknown", "Established", ""):
            with self.subTest(nettop_wildcard_state=state), self.assertRaises(clients.DetectionError):
                clients.parse_nettop(",state,\nMirage Beacon.4100,,\ntcp4 *.9853<->*.*,{},\n".format(state), 4100)

    def test_decision_matrix(self):
        flow = clients.parse_lsof(lsof(), 4100)
        for unhealthy, flows, errors, expected in [
            (True, set(), [], "restart"), (False, set(), [], "healthy"),
            (True, flow, [], "streaming"), (False, flow, [], "streaming"),
            (True, flow, ["timeout"], "streaming"), (True, set(), ["timeout"], "unknown"),
        ]:
            with self.subTest(unhealthy=unhealthy, flows=flows, errors=errors):
                self.assertEqual(clients.decision(unhealthy, flows, errors), expected)

    def test_detector_errors_and_all_processes(self):
        def result(command):
            if command[0].endswith("lsof"):
                return subprocess.CompletedProcess(command, 0, lsof().replace("4100", command[4]), "")
            raise clients.DetectionError("nettop timed out")
        with patch.object(clients, "run", side_effect=result) as run:
            flows, errors = clients.snapshot([4100, 4101])
        self.assertEqual(len(flows), 1)
        self.assertEqual(len(errors), 2)
        self.assertEqual(run.call_count, 4)
        with patch.object(clients, "run", return_value=subprocess.CompletedProcess([], 1, "", "permission denied")):
            flows, errors = clients.snapshot([4100])
            self.assertEqual(clients.decision(True, flows, errors), "unknown")
        with patch.object(clients, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            flows, errors = clients.snapshot([4100])
            self.assertEqual(clients.decision(True, flows, errors), "unknown")
        with patch.object(clients, "run", return_value=subprocess.CompletedProcess([], 1, "", "")):
            self.assertEqual(clients.mirage_pids(), [])
        with patch.object(clients, "run", side_effect=clients.DetectionError("pgrep timeout")):
            with self.assertRaises(clients.DetectionError):
                clients.mirage_pids()

    @unittest.skipUnless(os.uname().sysname == "Darwin", "macOS socket tools")
    def test_read_only_detector_on_a_dummy_loopback_listener(self):
        with tempfile.TemporaryDirectory() as home, socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE="1")
            result = subprocess.run(["/usr/bin/python3", str(LIB / "clients.py"), "--json", "--pid", str(os.getpid())],
                                    env=env, capture_output=True, text=True, timeout=35)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["flows"], 0)
            self.assertEqual(list(Path(home).iterdir()), [])


class RestartTest(unittest.TestCase):
    def run_dummy(self, status=0, late_client=False, absent=False, hold_after=0):
        with tempfile.TemporaryDirectory() as home:
            dummy = Path(home) / "listener.py"
            dummy.write_text("import socket,time\ns=socket.socket();s.bind(('127.0.0.1',0));s.listen()\n"
                             "print(s.getsockname()[1],flush=True)\ntime.sleep(30)\n")
            harness = r'''
STATE=$1; LIB=$2; status=$3; late=$4; absent=$5; hold_after=$6; now=12345
APP=Dummy; BUNDLE=test.invalid.dummy
log() { printf '%s\n' "$*" >> "$STATE/log"; }
client_detector() {
  n=$(cat "$STATE/calls" 2>/dev/null); n=$((${n:-0} + 1)); echo "$n" > "$STATE/calls"
  if [ "$late" = 1 ] && [ "$n" -gt 1 ]; then echo 'client streaming 100.64.0.2:53876'; return 10; fi
  if [ "$hold_after" -gt 0 ] && [ "$n" -gt "$hold_after" ]; then echo 'client detection unavailable: timeout'; return 20; fi
  [ "$status" = 10 ] && echo 'client streaming 100.64.0.2:53876'
  [ "$status" = 20 ] && echo 'client detection unavailable: timeout'
  return "$status"
}
open() { echo open >> "$STATE/actions"; }
osascript() { echo quit >> "$STATE/actions"; return 1; }
run_to() { shift; "$@"; }
wait_listening() { return 0; }
sleep() { /bin/sleep 0.02; }
. "$LIB/restart.sh"
/usr/bin/python3 -u "$STATE/listener.py" > "$STATE/port" & target=$!
trap 'kill "$target" 2>/dev/null; wait "$target" 2>/dev/null' EXIT
i=0
while [ ! -s "$STATE/port" ] && [ "$i" -lt 200 ]; do /bin/sleep 0.01; i=$((i+1)); done
[ -s "$STATE/port" ] || exit 2
mirage_pid() { [ "$absent" = 0 ] && kill -0 "$target" 2>/dev/null && echo "$target"; }
echo 7 > "$STATE/fails"
echo 123 > "$STATE/last_hold_log"
if [ "$absent" = 1 ]; then open_mirage; else restart_mirage "$target"; fi
if kill -0 "$target" 2>/dev/null; then echo alive > "$STATE/result"; else echo down > "$STATE/result"; fi
exit 0
'''
            result = subprocess.run(["/bin/sh", "-c", harness, "test", home, str(LIB), str(status), str(int(late_client)), str(int(absent)), str(hold_after)],
                                    capture_output=True, text=True, timeout=12)
            self.assertEqual(result.returncode, 0, result.stderr)
            read = lambda name: (Path(home) / name).read_text() if (Path(home) / name).exists() else ""
            return {name: read(name) for name in ("actions", "log", "result", "last_restart", "fails", "last_hold_log")}

    def test_unresponsive_dummy_without_clients_restarts(self):
        result = self.run_dummy()
        self.assertEqual(result["actions"].splitlines(), ["quit", "open"])
        self.assertEqual(result["result"].strip(), "down")

    def test_client_or_unknown_detector_leaves_dummy_running(self):
        for status, log in [(10, "skip: client streaming 100.64.0.2:53876"), (20, "skip: client detection unavailable")]:
            with self.subTest(status=status):
                result = self.run_dummy(status=status)
                self.assertEqual(result["actions"], "")
                self.assertEqual(result["last_restart"], "")
                self.assertEqual(result["result"].strip(), "alive")
                self.assertIn(log, result["log"])

    def test_client_arriving_during_quit_wait_blocks_escalation(self):
        result = self.run_dummy(late_client=True)
        self.assertEqual(result["actions"].splitlines(), ["quit"])
        self.assertEqual(result["result"].strip(), "alive")
        self.assertNotIn("SIGTERM", result["log"])

    def test_absent_process_opens_only_when_detector_is_clear(self):
        for status, actions in [(0, "open\n"), (10, ""), (20, "")]:
            with self.subTest(status=status):
                self.assertEqual(self.run_dummy(status=status, absent=True)["actions"], actions)

    def test_blocked_relaunch_keeps_failure_and_hold_state(self):
        result = self.run_dummy(hold_after=2)
        self.assertEqual(result["actions"].splitlines(), ["quit"])
        self.assertEqual(result["fails"].strip(), "7")
        self.assertEqual(result["last_hold_log"].strip(), "12345")
        self.assertNotIn("restart: OK", result["log"])
        self.assertNotIn("not answering yet", result["log"])

    def test_no_force_failure_hooks_remain_in_production(self):
        source = (HERE / "bin/mirage-beacon-keepalive").read_text() + (LIB / "restart.sh").read_text()
        for hook in ("force-fail", "MIRAGE_KEEPALIVE_FORCE_FAIL", "MIRAGE_KEEPALIVE_THRESHOLD"):
            self.assertNotIn(hook, source)


if __name__ == "__main__":
    unittest.main()
