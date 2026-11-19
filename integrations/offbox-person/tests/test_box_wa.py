"""Exercise the installed box wrapper with local CLI stand-ins, never a real account."""
import ast
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
WA = PACKAGE / "box/wa"
NO_SESSION = "sync: unknown (no systemd user session; is lingering on?)"


def older_pythons():
    candidates = [shutil.which(name) for name in ("python3.8", "python3.9", "python3.10", "python3.11")]
    candidates += ["/usr/bin/python3"]
    result = []
    for path in dict.fromkeys(p for p in candidates if p and Path(p).exists()):
        version = subprocess.run([path, "-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                                 capture_output=True, text=True, timeout=10)
        if version.returncode == 0 and version.stdout.strip() in ("3.8", "3.9", "3.10", "3.11"):
            result.append(path)
    return result


def python_bodies(path):
    source = path.read_text()
    if path.suffix == ".py" or source.startswith(("#!/usr/bin/python3", "#!/usr/bin/env python3")):
        return [source]
    bodies = re.findall(r"python3(?: -I)? -c '([^']*)'", source)
    bodies += [m[1] for m in re.findall(
        r"python3[^\n]*<<'([A-Z_]+)'[^\n]*\n(.*?)\n\1(?:\n|$)", source, re.S)]
    return bodies


def check_python38(source):
    # feature_version does not enforce the old f-string grammar on newer Python.
    if re.search(r"\{[^{}\n]*\\[^{}\n]*\}", source):
        raise SyntaxError("backslash in f-string replacement field")
    ast.parse(source, feature_version=(3, 8))


class PythonCompatibilityTest(unittest.TestCase):
    def sources(self):
        paths = sorted((PACKAGE / "box").glob("*")) + sorted((PACKAGE / "bin").glob("*"))
        paths += [PACKAGE.parent / "robob-watch/helpers/wa-db"]
        return [(path, body) for path in paths if path.is_file() for body in python_bodies(path)]

    def test_all_box_python_has_no_backslash_fields_and_uses_python38_syntax(self):
        sources = self.sources()
        self.assertGreaterEqual(len(sources), 10)
        for path, body in sources:
            with self.subTest(path=path):
                check_python38(body)

    def test_guard_rejects_original_search_line(self):
        old = r'print(f"({ts:%d-%m-%y %H:%M}) {m.get(\"ChatName\") or m[\"ChatJID\"]} | {who}: {text[:300]}  [{m[\"ChatJID\"]} {m[\"MsgID\"]}]")'
        with self.assertRaisesRegex(SyntaxError, "backslash"):
            check_python38(old)

    def test_compile_with_older_python_when_available(self):
        interpreters = older_pythons()
        if not interpreters:
            self.skipTest("no Python 3.8-3.11 on PATH; static guard still runs")
        for interpreter in interpreters:
            for path, body in self.sources():
                with self.subTest(python=interpreter, path=path):
                    result = subprocess.run([interpreter, "-I", "-c", "import sys; compile(sys.stdin.read(), sys.argv[1], 'exec')", str(path)],
                                            input=body, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)


class BoxWaTest(unittest.TestCase):
    def setUp(self):
        # Unix socket paths must fit macOS's 104-byte sockaddr_un.
        self.temp = tempfile.TemporaryDirectory(prefix="wa-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.person = self.root / "person"
        self.bin = self.person / "bin"
        self.bin.mkdir(parents=True)
        (self.person / "wa/store").mkdir(parents=True)
        (self.person / "wa/store/session.db").touch()
        self.log = self.root / "systemctl.jsonl"
        self.runtime = self.root / "run" / str(os.getuid())
        self.env = {**os.environ, "HOME": str(self.root), "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "WA_RUNTIME_DIR_BASE": str(self.root / "run"), "FAKE_SYSTEMCTL_LOG": str(self.log)}
        self.env.pop("XDG_RUNTIME_DIR", None)
        self.env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        self.env.pop("BASH_ENV", None)
        self.script("wacli", '''import json, os, sys
if "--version" in sys.argv:
    print("wacli 0.20.0")
elif sys.argv[1:3] == ["auth", "status"]:
    print(json.dumps({"authenticated": os.environ.get("FAKE_AUTH", "1") == "1"}))
elif sys.argv[1] == "auth":
    print(json.dumps({"event": "pair_code", "data": {"code": "1234-5678"}}, separators=(",", ":")), file=sys.stderr)
else:
    print(os.environ.get("FAKE_SEARCH_JSON", '{"data":{"messages":[]}}'))
''')
        self.script("wa-db", 'import sys\nprint("reader " + " ".join(sys.argv[1:]))\n')
        self.script("systemctl", '''import json, os, sys
with open(os.environ["FAKE_SYSTEMCTL_LOG"], "a") as f:
    f.write(json.dumps({"args": sys.argv[1:], "runtime": os.environ.get("XDG_RUNTIME_DIR"), "bus": os.environ.get("DBUS_SESSION_BUS_ADDRESS")}) + "\\n")
if not os.environ.get("XDG_RUNTIME_DIR") or os.environ.get("FAKE_BUS_ERROR"):
    print("Failed to connect to bus: No medium found", file=sys.stderr)
    sys.exit(1)
if "is-active" in sys.argv:
    key = "FAKE_LINK_STATE" if "wa-link.service" in sys.argv else "FAKE_SYNC_STATE"
    state = os.environ.get(key, "inactive" if key == "FAKE_LINK_STATE" else "active")
    if "--quiet" not in sys.argv: print(state)
    sys.exit(0 if state == "active" else 3)
if "show" in sys.argv:
    print(os.environ.get("FAKE_LINK_LOAD", "not-found") if "LoadState" in sys.argv else "1")
if "stop" in sys.argv:
    if "wa-link.service" in sys.argv and os.environ.get("FAKE_LINK_LOAD", "not-found") == "not-found":
        print("Unit wa-link.service not loaded", file=sys.stderr)
        sys.exit(5)
    if os.environ.get("FAKE_STOP_ERROR"):
        sys.exit(1)
''')
        self.script("awk", 'print("1000000000")\n')

    def script(self, name, body):
        path = self.bin / name
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def bus(self):
        self.runtime.mkdir(parents=True)
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(self.runtime / "bus"))
        self.addCleanup(sock.close)

    def run_wa(self, *args):
        return subprocess.run(["bash", str(WA), *args], env=self.env, text=True, capture_output=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_search_output_and_timestamp_shapes(self):
        fixtures = [
            ({"ChatName": "Home", "SenderName": "Ana", "Text": "hello\nthere"}, "Home | Ana: hello / there"),
            ({"SenderJID": "9715@s.whatsapp.net", "Text": "fallback"}, "chat@g.us | 9715: fallback"),
            ({"ChatName": "Home", "FromMe": True, "Text": "x" * 305}, "Home | Me: " + "x" * 300),
            ({"ChatName": "Home", "SenderName": "Ana", "MediaType": "image"}, "Home | Ana: [image]"),
            ({"SenderName": "Ana", "MediaCaption": "caption"}, "chat@g.us | Ana: caption"),
            ({"SenderName": "Ana", "Filename": "scan.pdf"}, "chat@g.us | Ana: scan.pdf"),
        ]
        for suffix in ("Z", ".1Z", ".12Z", ".123Z", ".1234Z", ".12345Z", ".123456Z", ".123456789Z", ".1+00:00", ".123456789-02:30"):
            with self.subTest(timestamp=suffix):
                messages = [{"ChatJID": "chat@g.us", "MsgID": "m%d" % i,
                             "Timestamp": "2026-11-17T10:20:30" + suffix, **fields} for i, (fields, _) in enumerate(fixtures)]
                self.env["FAKE_SEARCH_JSON"] = json.dumps({"data": {"messages": messages}})
                result = self.run_wa("search", "housekeeper", "--limit", "6")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                clock = "16:50" if suffix.endswith("-02:30") else "14:20"
                self.assertEqual(result.stdout, "".join("(17-11-26 %s) %s  [chat@g.us m%d]\n" % (clock, text, i)
                                                        for i, (_, text) in enumerate(fixtures)))

    def test_status_and_chats_reach_systemd_bus_over_ssh(self):
        self.bus()
        self.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/browser/session/bus"
        for command, expected in (("status", "online pid ?\n"), ("chats", "reader chats 3\n")):
            with self.subTest(command=command):
                result = self.run_wa(command, "3")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)
                self.assertEqual(result.stderr, "")
        self.assertTrue(any("show" in c["args"] for c in self.calls()))
        for call in self.calls():
            self.assertEqual(call["runtime"], str(self.runtime))
            self.assertEqual(call["bus"], "unix:path=" + str(self.runtime / "bus"))

    def test_missing_bus_is_unknown_and_reads_still_work(self):
        for make_directory in (False, True):
            if make_directory:
                self.runtime.mkdir(parents=True)
                (self.runtime / "bus").touch()  # A regular file is not a bus socket.
            with self.subTest(runtime_directory=make_directory):
                result = self.run_wa("status")
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, NO_SESSION + "\n")
                self.assertEqual(result.stderr, "")
                result = self.run_wa("chats", "3")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "reader chats 3\n")
                self.assertEqual(result.stderr, "")
                self.assertEqual(self.calls(), [])

    def test_missing_bus_blocks_mutations_and_watchers_before_side_effects(self):
        for command in (("start",), ("restart",), ("stop",), ("link", "971500000000"), ("new", "9715", "watch")):
            with self.subTest(command=command):
                result = self.run_wa(*command)
                self.assertEqual(result.returncode, 2)
                self.assertIn(NO_SESSION, result.stderr)
                self.assertNotIn("Failed to connect to bus", result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertFalse((self.person / "wa/link.events.log").exists())

    def test_setup_exports_bus_without_restarting_sync(self):
        self.bus()
        self.env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/browser/session/bus"
        result = subprocess.run(["bash", str(PACKAGE / "box/wa-setup.sh")], env=self.env,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual([c["args"] for c in self.calls()], [["--user", "daemon-reload"]])
        self.assertEqual(self.calls()[0]["runtime"], str(self.runtime))
        self.assertEqual(self.calls()[0]["bus"], "unix:path=" + str(self.runtime / "bus"))

    def test_unreachable_socket_is_unknown_and_never_raw_bus_error(self):
        self.bus()
        self.env["FAKE_BUS_ERROR"] = "1"
        for command in (("status",), ("link-status",), ("chats", "3"), ("start",), ("restart",), ("stop",), ("link", "9715"), ("new", "9715", "watch")):
            with self.subTest(command=command):
                result = self.run_wa(*command)
                if command[0] == "chats":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout, "reader chats 3\n")
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(NO_SESSION, result.stdout + result.stderr)
                    self.assertNotIn("offline", result.stdout)
                self.assertNotIn("Failed to connect to bus", result.stderr)
        self.assertFalse((self.person / "wa/link.events.log").exists())

    def test_status_unit_state_matrix(self):
        self.bus()
        for sync, link, expected in (("active", "unknown", "online pid ?"),
                                     ("inactive", "active", "linking (link job running)"),
                                     ("inactive", "inactive", "offline (linked)"),
                                     ("failed", "unknown", "offline (linked)"),
                                     ("unknown", "unknown", "offline (linked)")):
            with self.subTest(sync=sync, link=link):
                self.env.update(FAKE_SYNC_STATE=sync, FAKE_LINK_STATE=link)
                result = self.run_wa("status")
                self.assertEqual(result.stdout, expected + "\n")
                self.assertEqual(result.returncode, 0 if sync == "active" else 1)
                self.assertEqual(result.stderr, "")
                result = self.run_wa("link-status")
                self.assertEqual(result.stdout, "linked\nlink job: %s\nsync: %s\n" % (link, sync))
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_stop_with_absent_or_loaded_link_unit_and_sync_stop_failure(self):
        self.bus()
        for load in ("not-found", "loaded"):
            for stop_error in (False, True):
                with self.subTest(link_load=load, stop_error=stop_error):
                    self.log.unlink(missing_ok=True)
                    self.env["FAKE_LINK_LOAD"] = load
                    self.env["FAKE_STOP_ERROR"] = "1" if stop_error else ""
                    result = self.run_wa("stop")
                    self.assertEqual(result.returncode, 2 if stop_error else 0, result.stderr)
                    self.assertEqual(result.stdout, "" if stop_error else "stopped\n")
                    stops = [c["args"] for c in self.calls() if "stop" in c["args"]]
                    if load == "not-found":
                        self.assertEqual(stops, [["--user", "stop", "wacli-sync.service"]])
                    if stop_error:
                        self.assertIn("could not stop", result.stderr)

    def test_search_output_on_pre312_interpreters(self):
        interpreters = older_pythons()
        if not interpreters:
            self.skipTest("no Python before 3.12 installed")
        for interpreter in interpreters:
            with self.subTest(python=interpreter):
                alias = self.bin / "python3"
                alias.unlink(missing_ok=True)
                alias.symlink_to(interpreter)
                self.test_search_output_and_timestamp_shapes()

    def test_link_job_passes_systemd_bus_to_its_shell(self):
        self.bus()
        self.env["FAKE_AUTH"] = "0"
        self.script("systemd-run", '''import os, subprocess, sys
env = dict(os.environ)
env.pop("XDG_RUNTIME_DIR", None)
env.pop("DBUS_SESSION_BUS_ADDRESS", None)
for arg in sys.argv:
    if arg.startswith("--setenv="):
        key, value = arg[len("--setenv="):].split("=", 1)
        env[key] = value
sys.exit(subprocess.call(sys.argv[sys.argv.index("bash"):], env=env))
''')
        result = self.run_wa("link", "971500000000")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "1234-5678\n")
        self.assertEqual(result.stderr, "")
        enabled = [c for c in self.calls() if "enable" in c["args"]]
        self.assertEqual(len(enabled), 1)
        self.assertEqual(enabled[0]["runtime"], str(self.runtime))
        self.assertEqual(enabled[0]["bus"], "unix:path=" + str(self.runtime / "bus"))


if __name__ == "__main__":
    unittest.main()
