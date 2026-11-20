"""Exercise qcard's send CLI with isolated bridge state and a fake bridge process."""
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
REFUSAL = "bridge app failed (HTTP 403): Use agent-ask to reach this chat on its box"
FAKE_BRIDGE = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
assert "BUN_INSPECT" not in os.environ
with open(os.environ["FAKE_BRIDGE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
plan = json.loads(os.environ["FAKE_BRIDGE_PLAN"])
if args[0] == "publish":
    print(json.dumps({"url": "https://cards.tail/card", "metadataWarnings": ["test warning"]}))
elif args[0] == "share":
    print(json.dumps({"publicUrl": "https://cards.example/card"}))
elif args[0] == "shares":
    print('{"shares": []}')
elif args[0] in ("app", "agent-ask"):
    if plan.get(args[0] + "_error"):
        # Valid-looking JSON must not turn a non-zero exit into success.
        print('{"id": "should-not-succeed", "created": true}')
        print(plan[args[0] + "_error"], file=sys.stderr)
        sys.exit(1)
    if plan.get("invalid_json"):
        print("not JSON")
    else:
        print(json.dumps(plan.get("ack", {"id": "areq_fake", "created": True})))
else:
    sys.exit("unexpected command " + args[0])
'''
LAUNCHER = r'''
import importlib.machinery, importlib.util, os, sys
from pathlib import Path
root = Path(sys.argv.pop(1))
sys.path.insert(0, str(root / "libexec/qcard"))
loader = importlib.machinery.SourceFileLoader("qcard_cli", str(root / "bin/qcard"))
spec = importlib.util.spec_from_loader(loader.name, loader)
qcard = importlib.util.module_from_spec(spec)
loader.exec_module(qcard)
qcard.APPS = os.environ["FAKE_APPS"]
qcard.log_render = lambda *_args, **_kwargs: None
qcard.shot = lambda *_args: sys.exit("unit test tried to launch Chrome")
qcard.main()
'''


class QcardSendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="qcard-send-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / "bridge-state"
        self.state.mkdir()
        self.log = self.root / "bridge.jsonl"
        self.fake = self.root / "fake bridge.py"
        self.fake.write_text(FAKE_BRIDGE)
        self.launcher = self.root / "launch.py"
        self.launcher.write_text(LAUNCHER)
        self.route("owner", "owner-session", 2)
        self.route("local-chat", "local-session", 3)
        self.configure({"moni": {"kind": "remote-box"}})

    def route(self, chat, session, generation):
        db = self.state / ("state.sqlite" if chat == "owner" else f"chats/{chat}/state.sqlite")
        db.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(db) as con:
            con.execute("create table if not exists kv (key text primary key, value text)")
            con.execute("insert or replace into kv values ('route', ?)",
                        (json.dumps({"id": session, "generation": generation}),))

    def configure(self, backends):
        (self.state / "config.json").write_text(json.dumps({"chatBackends": backends}))

    def run_card(self, chat="owner", session="owner-session@2", *, plan=None, extra=()):
        self.log.write_text("")
        env = {**os.environ, "QCARD_BRIDGE": shlex.join([sys.executable, "-I", str(self.fake)]),
               "QCARD_BRIDGE_STATE": str(self.state), "FAKE_APPS": str(self.root / "apps"),
               "FAKE_BRIDGE_LOG": str(self.log), "FAKE_BRIDGE_PLAN": json.dumps(plan or {}),
               "TOOLLOG_ROOT": str(self.root / "logs"), "BUN_INSPECT": "must-be-stripped"}
        args = [sys.executable, "-I", str(self.launcher), str(ROOT), "stat", "--json",
                '{"title":"Fixture card", "value":123}', "--no-og", "--send", chat]
        if session:
            args += ["--session", session]
        return subprocess.run([*args, *extra], capture_output=True, text=True, env=env, timeout=15)

    def calls(self, command):
        return [a for a in map(json.loads, self.log.read_text().splitlines()) if a[0] == command]

    def events(self):
        return [json.loads(line) for p in (self.root / "logs/imessage").glob("*.ndjson")
                for line in p.read_text().splitlines()]

    def result(self, process):
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout)

    def assert_relay(self, process, chat="moni", key=None):
        result = self.result(process)
        calls = self.calls("agent-ask")
        self.assertEqual(len(calls), 1)
        args = calls[0]
        key = key or f"qcard:{result['slug']}:{chat}"
        self.assertEqual(args[args.index("--to") + 1], chat)
        self.assertEqual(args[args.index("--session") + 1], "owner-session@2")
        self.assertEqual(args[args.index("--key") + 1], key)
        request = next(a.removeprefix("--text=") for a in args if a.startswith("--text="))
        self.assertIn("bridge send with dedupe key " + json.dumps(key), request)
        self.assertIn("Keep that same key on any retry", request)
        self.assertIn("done only after bridge acceptance", request)
        self.assertIn("declined with the send error", request)
        self.assertEqual(json.loads(request.splitlines()[-1]), f"{result['caption']}: {result['url']}")
        self.assertNotIn("--url", args)
        self.assertEqual(result["sent"], {"relayed": True, "status": "relayed", "ack": "areq_fake",
                                          "created": True, "to": chat, "key": key})
        self.assertIn("relay", [e["name"] for e in self.events()])
        self.assertNotIn(result["url"], json.dumps(self.events()))
        return result

    def test_owner_own_session_keeps_app_reply(self):
        for session in ("owner-session", "owner-session@2"):
            with self.subTest(session=session):
                result = self.result(self.run_card(session=session, extra=("--summary", "Card summary")))
                self.assertEqual(len(self.calls("publish")), 1)
                self.assertEqual(self.calls("share"), [])
                self.assertEqual(self.calls("agent-ask"), [])
                args, = self.calls("app")
                self.assertNotIn("--to", args)
                self.assertEqual(args[args.index("--key") + 1], f"qcard:{result['slug']}:owner")
                self.assertEqual(args[args.index("--summary") + 1], "Card summary")
                self.assertIn("--subcaption", args)
                self.assertEqual(result["metadataWarnings"], ["test warning"])
                self.assertTrue(result["url"].startswith("https://cards.tail/"))

    def test_remote_chat_pre_detection_relays_link_only(self):
        result = self.assert_relay(self.run_card("moni"))
        self.assertEqual(self.calls("app"), [])
        self.assertEqual(self.calls("publish"), [])
        self.assertEqual(self.calls("share")[0][-2:], ["--days", "7"])
        self.assertTrue(result["url"].startswith("https://cards.example/"))

    def test_other_local_chat_gets_explicit_recipient(self):
        for session in ("owner-session@2", "another-session"):
            with self.subTest(session=session):
                result = self.result(self.run_card("local-chat", session=session))
                args, = self.calls("app")
                self.assertEqual(args[args.index("--to") + 1], "local-chat")
                self.assertEqual(args[args.index("--key") + 1], f"qcard:{result['slug']}:local-chat")
                self.assertEqual(self.calls("agent-ask"), [])

    def test_local_chat_own_session_omits_to(self):
        for session in ("local-session", "local-session@3"):
            with self.subTest(session=session):
                self.result(self.run_card("local-chat", session))
                self.assertNotIn("--to", self.calls("app")[0])

    def test_stale_or_invalid_route_never_becomes_own_chat(self):
        for generation in (None, True, -1, "2", 3):
            with self.subTest(generation=generation):
                self.route("owner", "owner-session", generation)
                self.result(self.run_card())
                self.assertIn("--to", self.calls("app")[0])

    def test_remote_403_fallback_keeps_target_and_key(self):
        for config in ('{"chatBackends":{}}', '{invalid', '{"chatBackends":null}'):
            with self.subTest(config=config):
                (self.state / "config.json").write_text(config)
                result = self.assert_relay(self.run_card("moni", plan={"app_error": REFUSAL}))
                args, = self.calls("app")
                self.assertEqual(args[args.index("--to") + 1], "moni")
                self.assertEqual(args[args.index("--key") + 1], result["sent"]["key"])
                self.assertIn("bridge.error", [e["name"] for e in self.events()])

    def test_non_remote_errors_never_trigger_relay(self):
        self.configure({})
        for error in ("bridge app failed (HTTP 403): Forbidden",
                      "bridge app failed (HTTP 503): Use agent-ask to reach this chat on its box",
                      "Use agent-ask to reach this chat on its box", "connection reset"):
            with self.subTest(error=error):
                process = self.run_card("moni", plan={"app_error": error})
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(error, process.stderr)
                self.assertEqual(self.calls("agent-ask"), [])
                self.assertEqual(process.stdout, "")

    def test_agent_ask_failure_is_not_success(self):
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                self.configure({} if fallback else {"moni": {"kind": "remote-box"}})
                plan = {"agent-ask_error": "bridge agent-ask failed (HTTP 503): remote box offline"}
                if fallback:
                    plan["app_error"] = REFUSAL
                process = self.run_card("moni", plan=plan)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn("remote box offline", process.stderr)
                self.assertEqual(process.stdout, "")
                self.assertNotIn("relay", [e["name"] for e in self.events()])

    def test_bad_relay_ack_or_json_fails(self):
        for plan in ({"ack": {}}, {"ack": {"id": "areq_fake"}},
                     {"ack": {"id": "", "created": True}}, {"invalid_json": True}):
            with self.subTest(plan=plan):
                process = self.run_card("moni", plan=plan)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn("bridge agent-ask failed", process.stderr)
                self.assertEqual(process.stdout, "")
                self.assertNotIn("relay", [e["name"] for e in self.events()])

    def test_explicit_key_and_json_quoted_link_survive(self):
        self.assert_relay(self.run_card("moni", extra=("--key", "request:89", "--caption", 'A "quoted" card\nlink')),
                          key="request:89")

    def test_no_session_only_publishes_or_shares(self):
        for chat in ("owner", "moni", "local-chat"):
            with self.subTest(chat=chat):
                result = self.result(self.run_card(chat, session=None))
                self.assertNotIn("sent", result)
                self.assertEqual(self.calls("app"), [])
                self.assertEqual(self.calls("agent-ask"), [])
                self.assertEqual(len(self.calls("publish" if chat == "owner" else "share")), 1)


if __name__ == "__main__":
    unittest.main()
