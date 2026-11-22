import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import fcntl
import json
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from datetime import datetime, timezone
from helpers import toollog as helper_log

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "ride-share-check.py")
CARD = os.path.join(HERE, "..", "helpers", "ride-card", "ride_card.py")

A = "aaaaaaaa-0000-4000-8000-000000000001"
B = "bbbbbbbb-0000-4000-8000-000000000002"
FARE_NOW = datetime(2026, 11, 15, 12, tzinfo=timezone.utc).timestamp()
REAL_RECEIPT = ("Total\tAED 98.25\nTrip fare\tAED 74.70\nBooking Fee\tAED 5.00\n"
                "RTA fee\tAED 5.00\nWait Time\tAED 13.55\nPayments\nCard\tAED 98.25")

FAKE_UBER = """#!/usr/bin/python3
import json, os, sys
state = json.load(open(os.environ["FAKE_UBER_STATE"]))
args = [a for a in sys.argv[1:] if a != "--json"]
with open(os.environ["FAKE_UBER_STATE"] + ".calls", "a") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["rides", "status"]:
    if state.get("status_responses"):
        out = state["status_responses"].pop(0)
        with open(os.environ["FAKE_UBER_STATE"], "w") as f:
            json.dump(state, f)
        if isinstance(out, str):
            print(out); sys.exit(0)
        print(json.dumps(out)); sys.exit(0 if out.get("ok") else 1)
    out = {"ok": True, "result": {"trip": state.get("trip")}}
elif args[:2] == ["trips", "get"]:
    t = state.get("history", {}).get(args[2])
    out = {"ok": True, "result": t} if t else {"ok": False, "error": "not found"}
elif args[:2] == ["trips", "receipt"]:
    if os.environ.get("FAKE_UBER_ABORT_WATCHER"):
        os.kill(os.getppid(), 9); sys.exit(1)
    if os.environ.get("FAKE_UBER_BAD_RECEIPT"):
        print("not JSON"); sys.exit(0)
    text = state.get("receipts", {}).get(args[2])
    out = {"ok": True, "result": {"uuid": args[2], "text": text}} if text is not None else {"ok": False, "error": "no receipt"}
else:
    out = {"ok": False, "error": "unexpected args " + " ".join(args)}
print(json.dumps(out))
"""

FAKE_BRIDGE = """#!/usr/bin/python3
import hashlib, json, os, sqlite3, sys
args = sys.argv[1:]
args = [v for a in args for v in (a.split("=", 1) if a.startswith("--") and "=" in a else [a])]
log = os.environ["FAKE_BRIDGE_LOG"]
with open(log, "a") as f:
    f.write(json.dumps(args) + "\\n")

def opt(name):
    return args[args.index(name) + 1] if name in args else None

def queue(state):
    # Like the bridge: --to ops sit in the target chat's store under hash(slug:key) with no session;
    # a chat's own ops sit under hash(key), bound to its route id and generation.
    base = os.environ["RIDE_CARD_BRIDGE_STATE"]
    h = lambda s: hashlib.sha256(s.encode()).hexdigest()
    to, key, session = opt("--to"), opt("--key"), opt("--session")
    dbs = [os.path.join(base, "state.sqlite")] + [os.path.join(base, "chats", c, "state.sqlite")
                                                 for c in sorted(os.listdir(os.path.join(base, "chats")))]
    if to:
        db = dbs[0] if to == "owner" else os.path.join(base, "chats", to, "state.sqlite")
        oid, op = args[0] + ":" + h(to + ":" + key), {}
    else:
        for db in dbs:
            con = sqlite3.connect(db)
            route = json.loads(con.execute("select value from kv where key='route'").fetchone()[0])
            con.close()
            if session in (route["id"], route["id"] + "@" + str(route["generation"])):
                break
        else:
            print('{"error":"Bridge request failed (HTTP 409)"}', file=sys.stderr); sys.exit(1)
        oid, op = args[0] + ":" + h(key), {"sessionId": route["id"], "generation": route["generation"]}
    op["content"] = opt("--text") or opt("--url")
    con = sqlite3.connect(db)
    row = con.execute("select payload from outbox where id = ?", (oid,)).fetchone()
    if row and row[0] != json.dumps(op):
        # Same id, other content (or a session-bound op from another route): the bridge says 409.
        con.close()
        print('{"error":"Bridge request failed (HTTP 409)"}', file=sys.stderr); sys.exit(1)
    if not row:
        con.execute("insert into outbox values (?, ?, ?, 0)", (oid, json.dumps(op), state))
        con.commit()
    con.close()
    return {"id": oid, "created": not row}

if args[0] in ("send", "app") and os.environ.get("FAKE_BRIDGE_PEEK"):
    # What the share journal said while the bridge call was in flight.
    with open(os.environ["FAKE_BRIDGE_PEEK"]) as f, open(os.environ["FAKE_BRIDGE_PEEK"] + ".seen", "a") as g:
        g.write(f.read() + "\\n")
if args[0] in ("send", "app") and os.environ.get("FAKE_BRIDGE_NO_TO") and opt("--to") == "owner":
    print('{"error":"Invalid command arguments"}', file=sys.stderr); sys.exit(1)  # an older bridge
if args[0] in ("send", "app") and os.environ.get("FAKE_BRIDGE_REMOTE") and opt("--to") == os.environ["FAKE_BRIDGE_REMOTE"]:
    print('Bridge request failed (HTTP 403): Use agent-ask to reach this chat on its box', file=sys.stderr); sys.exit(1)
if args[0] == "agent-ask":
    oid = "areq_" + hashlib.sha256(json.dumps(["owner", opt("--key")], separators=(",", ":")).encode()).hexdigest()
    con = sqlite3.connect(os.path.join(os.environ["RIDE_CARD_BRIDGE_STATE"], "state.sqlite"))
    row = con.execute("select id from agent_requests where id=?", (oid,)).fetchone()
    if not os.environ.get("FAKE_BUS_FAIL") or os.environ.get("FAKE_BUS_ROW") or os.environ.get("FAKE_BUS_QUEUED"):
        con.execute("insert or ignore into agent_requests values (?, ?, ?)", (oid, opt("--to"), "open"))
    if not os.environ.get("FAKE_BUS_FAIL") or os.environ.get("FAKE_BUS_QUEUED"):
        con.execute("insert or ignore into agent_wakes values (?)", (oid,))
    if con.in_transaction:
        con.commit()
    con.close()
    if os.environ.get("FAKE_BUS_FAIL"):
        print("agent bus unavailable", file=sys.stderr); sys.exit(1)
    print(json.dumps({"id": "wrong" if os.environ.get("FAKE_BUS_BAD_ACK") else oid, "created": not row})); sys.exit(0)
fail = os.environ.get("FAKE_BRIDGE_FAIL") == args[0]
if fail and os.environ.get("FAKE_BRIDGE_QUEUED"):
    queue(os.environ["FAKE_BRIDGE_QUEUED"])  # accepted, but the reply never came back
if fail:
    print(os.environ.get("FAKE_BRIDGE_ERR") or "boom", file=sys.stderr); sys.exit(1)
if args[0] == "share" and os.environ.get("FAKE_BRIDGE_CAP"):
    with open(log) as f:  # all 10 shares are live until something is unshared
        if not any(json.loads(x)[0] == "unshare" for x in f):
            print('{"error":"Bridge request failed (HTTP 409): At most 10 live shares; unshare one first"}',
                  file=sys.stderr); sys.exit(1)
if args[0] in ("send", "app"):
    print(json.dumps(queue(os.environ.get("FAKE_BRIDGE_ACK_STATE") or "sent")))
elif args[0] == "unshare":
    print(json.dumps({"app": args[2], "removed": True}))
elif args[0] == "shares" and os.environ.get("FAKE_BRIDGE_SHARES_RAW") is not None:
    print(os.environ["FAKE_BRIDGE_SHARES_RAW"])
elif args[0] == "shares":
    # Live shares are the ones shared and not unshared since; FAKE_BRIDGE_PERMANENT names stable-origin ones.
    live = {}
    with open(log) as f:
        for call in map(json.loads, f):
            if call[0] == "share":
                live[call[2]] = True
            elif call[0] == "unshare":
                live.pop(call[2], None)
    permanent = set(filter(None, os.environ.get("FAKE_BRIDGE_PERMANENT", "").split(",")))
    print(json.dumps({"shares": [{"app": a, "url": "https://x/" + a + "/", "live": True, "permanent": a in permanent}
                                 for a in live]}))
elif args[0] == "publish":
    print(json.dumps({"url": "https://host.ts.net:18401/" + args[2] + "/", "metadataWarnings": []}))
elif args[0] == "share":
    print(json.dumps({"url": "https://x.trycloudflare.com/" + args[2] + "/", "created": True, "metadataWarnings": []}))
else:
    print(json.dumps({"ok": True}))
"""


PIN = (25.0712, 55.1401)


def trip(uuid, status, plate="K 48213", name="Imran Khan", car="Black Lexus ES", eta="4 mins", north_m=5000):
    """`uber rides status --json` shape; the car sits north_m metres due north of the pickup pin."""
    t = {
        "uuid": uuid, "status": status, "pickupEta": eta, "arrivalEta": "2026-10-19T10:30:00Z",
        "pin": "9731", "fare": "AED 65.89", "headline": "Meet at Banyan Tree Residences", "detail": "",
        "stops": [{"type": "Pickup", "title": "Banyan Tree Residences",
                   "location": {"latitude": PIN[0], "longitude": PIN[1]}},
                  {"type": "Dropoff", "title": "Dubai Mall", "location": {"latitude": 25.1972, "longitude": 55.2797}}],
        "route": "encoded-polyline",
    }
    if status not in ("Searching", "Dispatching", "Matching", "Requesting", "WaitingForDispatch"):
        t["driver"] = {"name": name, "rating": 4.9, "photo": "https://cdn.example/photo-secret.jpg"}
        t["vehicle"] = {"description": car, "plate": plate,
                        "location": {"latitude": PIN[0] + north_m / 111195, "longitude": PIN[1]}}
    return t


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.fake = self._exe("uber", FAKE_UBER)
        self.bridge = self._exe("bridge", FAKE_BRIDGE)
        self.enroll = self._exe("enroll", "#!/bin/sh\necho 'moni: preparing'\n")
        self.fixture = os.path.join(self.dir, "fixture.json")
        self.set_state(None, {})
        self.hints = os.path.join(self.dir, "hints")
        os.makedirs(self.hints)
        self.audit = os.path.join(self.dir, "audit")
        os.makedirs(self.audit)
        self.state = os.path.join(self.dir, "rides.json")
        self.cards = os.path.join(self.dir, "cards")
        self.journal = os.path.join(self.dir, "journal")
        self.blog = os.path.join(self.dir, "bridge.log")
        self.bstate = os.path.join(self.dir, "bridge-state")
        self.route("abdullah", "thread-1", 3)
        self.route("moni", "moni-thread", 1)
        self.route("omar", "omar-thread", 1)
        self.route("group-run_club", "group-thread", 1)
        self.env = dict(
            os.environ, UBER_BIN=self.fake, FAKE_UBER_STATE=self.fixture, RIDE_SHARE_STATE=self.state,
            RIDE_SHARE_HINTS=self.hints, RIDE_CARD_ROOT=self.cards, RIDE_CARD_JOURNAL=self.journal,
            RIDE_CARD_NO_IMAGE="1", RIDE_CARD_BRIDGE=self.bridge, FAKE_BRIDGE_LOG=self.blog,
            RIDE_CARD_ENROLL=self.enroll, WATCH_DIR=self.dir, RIDE_CARD_BRIDGE_STATE=self.bstate,
            UBER_AUDIT_DIR=self.audit, WATCH_RUN="",
        )

    def route(self, chat, rid, generation):
        """A bridge chat store with its live route, laid out like ~/.config/spectrum-bridge."""
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        os.makedirs(d, exist_ok=True)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("create table if not exists kv (key text primary key, value text not null)")
        con.execute("create table if not exists outbox (id text primary key, payload text not null, "
                    "state text not null, attempts integer not null default 0)")
        con.execute("create table if not exists agent_requests (id text primary key, to_slug text, status text)")
        con.execute("create table if not exists agent_wakes (id text primary key)")
        con.execute("insert or replace into kv values ('route', ?)", (json.dumps({"id": rid, "generation": generation}),))
        con.commit()
        con.close()

    def outbox(self, chat):
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        rows = con.execute("select id, state, attempts from outbox order by rowid").fetchall()
        con.close()
        return rows

    def kv(self, chat, key, value):
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("insert or replace into kv values (?, ?)", (key, json.dumps(value)))
        con.commit()
        con.close()

    def ops(self, chat):
        return [row[0] for row in self.outbox(chat)]

    def journal_edit(self, who, **fields):
        path = os.path.join(self.journal, f"{A}.json")
        with open(path) as f:
            j = json.load(f)
        j["recipients"][who].update(fields)
        with open(path, "w") as f:
            json.dump(j, f)

    def rc(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card
        return ride_card

    def set_op(self, chat, state, attempts=None):
        """Move every op in a chat's outbox, as the bridge would."""
        d = self.bstate if chat == "abdullah" else os.path.join(self.bstate, "chats", chat)
        con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        con.execute("update outbox set state = ?, attempts = coalesce(?, attempts)", (state, attempts))
        con.commit()
        con.close()

    def _exe(self, name, body):
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write(body)
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        return p

    def set_state(self, trip, history, receipts=None):
        with open(self.fixture, "w") as f:
            json.dump({"trip": trip, "history": history, "receipts": receipts or {}}, f)

    def run_check_result(self, now, **extra):
        env = dict(self.env, RIDE_SHARE_NOW=str(now), **extra)
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def run_check(self, now, **extra):
        p = self.run_check_result(now, **extra)
        return [line for line in p.stdout.splitlines() if line.strip()]

    def audit_rows(self, month, *rows):
        with open(os.path.join(self.audit, f"{month}.jsonl"), "a") as f:
            for row in rows:
                f.write((row if isinstance(row, str) else json.dumps(row)) + "\n")

    def audit_quote(self, uuid, fare="AED 84.70", month="2026-10"):
        token = f"request-{uuid}"
        self.audit_rows(month, {"action": "rides.request", "outcome": "started", "token": token,
                                "detail": {"fare": fare}},
                        {"action": "rides.request", "outcome": "succeeded", "token": token,
                         "detail": {"tripUuid": uuid}})

    def receipt_calls(self, uuid):
        with open(self.fixture + ".calls") as f:
            return f.read().splitlines().count(f"trips receipt {uuid}")

    def ack(self, run):
        with open(os.path.join(self.dir, ".run-ok"), "w") as f:
            f.write(run + "\n")

    def runner_state(self, **fields):
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump(fields, f)

    def start_completed(self, uuid, receipt, now=FARE_NOW):
        self.set_state(trip(uuid, "OnTrip"), {})
        self.assertEqual(self.run_check(now), [])
        self.set_state(None, {uuid: {"status": "COMPLETED"}}, {uuid: receipt} if receipt is not None else None)

    def card_cli(self, *args, ok=True, **extra):
        p = subprocess.run([sys.executable, CARD, *args], capture_output=True, text=True,
                           env=dict(self.env, **extra), timeout=60)
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p

    def card(self, uuid):
        with open(os.path.join(self.cards, f"ride-{uuid}", "data.json")) as f:
            return json.load(f)

    def page(self, uuid):
        with open(os.path.join(self.cards, f"ride-{uuid}", "index.html")) as f:
            return f.read()

    def bridge_calls(self):
        if not os.path.exists(self.blog):
            return []
        with open(self.blog) as f:
            return [json.loads(x) for x in f]

    def share_log(self):
        p = os.path.join(self.journal, f"{A}.json")
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)

    def mark_sent(self, uuid):
        self.set_state(trip(uuid, "Accepted"), {})
        self.card_cli("send", "--trip", uuid, "--session", "thread-1@3")


class SessionRecoveryTest(Base):
    stale = {"ok": False, "error": {"code": "runtime", "message":
             "Unexpected token '<', \"<html>\r\n<h\"... is not valid JSON", "retryable": False}}
    idle = {"ok": True, "result": {"trip": None}}

    def setUp(self):
        super().setUp()
        self.browser_log = os.path.join(self.dir, "browser.calls")
        self.browser = self._exe("agent-browser", """#!/usr/bin/python3
import json, os, sys, time
with open(os.environ['FAKE_BROWSER_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAKE_BROWSER_HANG'):
    time.sleep(30)
sys.exit(int(os.environ.get('FAKE_BROWSER_EXIT', '0')))
""")
        self.env.update(UBER_AGENT_BROWSER=self.browser, FAKE_BROWSER_LOG=self.browser_log)

    def responses(self, *responses):
        with open(self.fixture, "w") as f:
            json.dump({"status_responses": responses}, f)

    def helper(self):
        import importlib.util
        with unittest.mock.patch.dict(os.environ, dict(self.env, RIDE_SHARE_NOW="1000")):
            spec = importlib.util.spec_from_file_location("heal_log_test", HELPER)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module

    def browser_calls(self):
        if not os.path.exists(self.browser_log):
            return []
        with open(self.browser_log) as f:
            return [json.loads(line) for line in f]

    def status_calls(self, count):
        with open(self.fixture + ".calls") as f:
            # Any booking/change/cancellation command would fail this assertion.
            self.assertEqual(f.read().splitlines(), ["rides status"] * count)

    def heal_row(self, reopen, retry_ok, error=None):
        with open(os.path.join(self.dir, "heals.jsonl")) as f:
            rows = [json.loads(line) for line in f]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(set(row), {"ts", "event", "reopen", "reopen_ms", "retry_ok", "error"})
        self.assertEqual(row["ts"], "1970-01-01T00:16:40Z")
        self.assertEqual(row["event"], "session_heal")
        self.assertEqual(row["reopen"], reopen)
        self.assertIs(type(row["reopen_ms"]), int)
        self.assertGreaterEqual(row["reopen_ms"], 0)
        self.assertIs(row["retry_ok"], retry_ok)
        self.assertEqual(row["error"], error)
        if error is not None:
            self.assertLessEqual(len(error), 200)
        return row

    def check_failed(self, **extra):
        with open(self.state, "w") as f:
            json.dump({"fail_since": 100}, f)
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True,
                           env=dict(self.env, RIDE_SHARE_NOW="1000", **extra), timeout=25)
        self.assertEqual(p.returncode, 1, p.stderr)
        self.assertEqual(p.stdout, "")
        with open(self.state) as f:
            self.assertEqual(json.load(f)["fail_since"], 100)
        return p

    def test_healthy_status_never_opens_browser(self):
        self.assertEqual(self.run_check(1000), [])
        self.assertEqual(self.browser_calls(), [])
        self.status_calls(1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "heals.jsonl")))

    def test_reopen_saved_profile_once_then_clear_failure_streak(self):
        with open(self.state, "w") as f:
            json.dump({"fail_since": 100}, f)
        self.responses(self.stale, self.idle)
        p = self.run_check_result(1000)
        self.assertEqual(p.stdout, "")
        self.status_calls(2)
        self.assertEqual(self.browser_calls(), [["--session", "uber-cli-default", "--profile",
                         os.path.expanduser("~/Library/Application Support/uber/profiles/default/browser"),
                         "--headed", "open", "https://m.uber.com/go/home"]])
        with open(self.state) as f:
            self.assertIsNone(json.load(f)["fail_since"])
        self.assertIn("reopening saved profile once", p.stderr)
        self.heal_row("ok", True)

    def test_recovered_active_trip_still_updates_card(self):
        self.responses(self.stale, {"ok": True, "result": {"trip": trip(A, "Accepted")}})
        self.assertEqual(self.run_check(1000), [])
        self.assertEqual(self.card(A)["state"], "assigned")
        self.status_calls(2)
        self.assertEqual(len(self.browser_calls()), 1)
        self.heal_row("ok", True)

    def test_second_stale_response_is_failure_without_another_reopen(self):
        self.responses(self.stale, self.stale, self.idle)
        self.check_failed()
        self.status_calls(2)
        self.assertEqual(len(self.browser_calls()), 1)
        self.heal_row("ok", False, "retry status not ok")

    def test_retry_other_error_still_fails(self):
        self.responses(self.stale, {"ok": False, "error": {"code": "network", "message": "offline"}})
        self.check_failed()
        self.status_calls(2)
        self.assertEqual(len(self.browser_calls()), 1)
        self.heal_row("ok", False, "retry status not ok")

    def test_malformed_retry_still_fails(self):
        self.responses(self.stale, "not JSON")
        self.check_failed()
        self.status_calls(2)
        self.assertEqual(len(self.browser_calls()), 1)
        self.heal_row("ok", False, "retry status failed")

    def test_malformed_initial_response_never_opens_browser(self):
        self.responses("not JSON")
        self.check_failed()
        self.status_calls(1)
        self.assertEqual(self.browser_calls(), [])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "heals.jsonl")))

    def test_failed_reopen_is_failure_without_retry(self):
        self.responses(self.stale, self.idle)
        self.check_failed(FAKE_BROWSER_EXIT="1")
        self.status_calls(1)
        self.assertEqual(len(self.browser_calls()), 1)
        self.heal_row("failed", False, "reopen failed")

    def test_missing_browser_still_fails(self):
        self.responses(self.stale)
        self.check_failed(UBER_AGENT_BROWSER=os.path.join(self.dir, "missing-browser"))
        self.status_calls(1)
        self.heal_row("failed", False, "reopen failed")

    def test_reopen_timeout_is_bounded_and_preserves_failure(self):
        import contextlib
        import importlib.util
        import io
        with unittest.mock.patch.dict(os.environ, dict(self.env, FAKE_BROWSER_HANG="1", RIDE_SHARE_NOW="1000")):
            spec = importlib.util.spec_from_file_location("recovery_test", HELPER)
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
            real_run = subprocess.run
            attempts = []
            def run(args, **kwargs):
                self.assertEqual(kwargs["timeout"], 15)
                if args[0] == self.browser:
                    attempts.append(args)
                    kwargs["timeout"] = 0.1
                return real_run(args, **kwargs)
            self.responses(self.stale)
            with open(self.state, "w") as f:
                json.dump({"fail_since": 100}, f)
            with unittest.mock.patch.object(m.subprocess, "run", side_effect=run), \
                    contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as exited:
                m.main()
            self.assertEqual(exited.exception.code, 1)
            self.assertIn("timed out", err.getvalue())
            self.status_calls(1)
            self.assertEqual(len(attempts), 1)
            with open(self.state) as f:
                self.assertEqual(json.load(f)["fail_since"], 100)
            self.heal_row("timeout", False, "reopen timed out")

    def test_unrelated_errors_never_reopen(self):
        errors = [
            {"code": "network", "message": "offline"},
            {"code": "auth.expired", "message": "sign in required"},
            {"code": "runtime", "message": "Unexpected token 'x', not valid JSON"},
            {"code": "runtime", "message": "upstream returned 500"},
            {"code": "runtime", "message": None},
            "not found",
        ]
        for i, error in enumerate(errors):
            with self.subTest(error=error):
                self.responses({"ok": False, "error": error})
                self.check_failed()
                self.assertEqual(self.browser_calls(), [])
                self.status_calls(i + 1)
                self.assertFalse(os.path.exists(os.path.join(self.dir, "heals.jsonl")))

    def test_unwritable_watch_dir_preserves_check_success_and_failure(self):
        # A regular file cannot hold a log even when the test process runs as root.
        for retry in (self.idle, self.stale):
            with self.subTest(retry_ok=retry["ok"]):
                self.responses(self.stale, retry)
                if retry["ok"]:
                    p = self.run_check_result(1000, WATCH_DIR=self.fixture)
                    with open(self.state) as f:
                        self.assertIsNone(json.load(f)["fail_since"])
                else:
                    p = self.check_failed(WATCH_DIR=self.fixture)
                self.assertIn("ride-share: heal log failed", p.stderr)

    def test_retry_error_details_are_not_logged(self):
        private = "cookie=SECRET https://example.test/?token=SECRET 25.0712,55.1401"
        self.responses(self.stale, {"ok": False, "error": {"code": private, "message": private}})
        self.check_failed()
        self.heal_row("ok", False, "retry status not ok")

    def test_retry_timeout_preserves_exception_and_reopen_duration(self):
        module = self.helper()
        failure = subprocess.TimeoutExpired(["private-command", "token=SECRET"], 15)
        with unittest.mock.patch.object(module, "uber", side_effect=[self.stale, failure]), \
                unittest.mock.patch.object(module.subprocess, "run"), \
                unittest.mock.patch.object(module.time, "monotonic", side_effect=[1, 1.125]), \
                unittest.mock.patch.object(module, "now_ts", return_value=1000), \
                self.assertRaises(subprocess.TimeoutExpired) as raised:
            module.rides_status()
        self.assertIs(raised.exception, failure)
        self.assertEqual(self.heal_row("ok", False, "retry status failed")["reopen_ms"], 125)

    def test_unexpected_reopen_error_preserves_exception_without_retry(self):
        module = self.helper()
        failure = OSError("cookie=SECRET https://example.test/?token=SECRET 25.0712,55.1401")
        with unittest.mock.patch.object(module, "uber", return_value=self.stale) as status, \
                unittest.mock.patch.object(module.subprocess, "run", side_effect=failure), \
                unittest.mock.patch.object(module, "now_ts", return_value=1000), \
                self.assertRaises(OSError) as raised:
            module.rides_status()
        self.assertIs(raised.exception, failure)
        self.assertEqual(status.call_count, 1)
        self.heal_row("failed", False, "reopen failed")

    def test_heal_log_keeps_newest_complete_rows_when_capped(self):
        module = self.helper()
        path = os.path.join(self.dir, "heals.jsonl")
        old = [{"attempt": i} for i in range(40)]
        with open(path, "w") as f:
            for row in old:
                f.write(json.dumps(row) + "\n")
        with unittest.mock.patch.object(module, "HEAL_LOG_MAX", 300):
            module.log_heal({"attempt": "new"})
        with open(path) as f:
            rows = [json.loads(line) for line in f]
        self.assertGreater(len(rows), 1)
        self.assertLess(len(rows), len(old))
        self.assertEqual(rows[:-1], old[-len(rows) + 1:])
        self.assertEqual(rows[-1], {"attempt": "new"})


class WatcherTest(Base):
    def test_lifecycle_one_card_ready_then_quiet_updates_and_dropoff(self):
        self.set_state(trip(A, "Searching"), {})
        self.assertEqual(self.run_check(0), [])
        self.assertEqual(self.card(A)["state"], "searching")
        self.set_state(trip(A, "Accepted"), {})
        self.assertEqual(self.run_check(30), [])
        out = self.run_check(90)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith(f"CARD_READY trip={A} rider=abdullah(assumed) missing=abdullah,moni"), out[0])
        v = self.card(A)["v"]
        self.assertEqual(self.run_check(120), [])
        self.assertEqual(self.card(A)["v"], v, "unchanged state must not bump the version")
        # the order Uber really uses: WaitingForPickup while the driver drives over, then ArrivingAtPickup
        for i, (st, north, want) in enumerate([("WaitingForPickup", 1500, "arriving"), ("ArrivingAtPickup", 300, "arriving"),
                                               ("ArrivingAtPickup", 20, "arrived"), ("OnTrip", 0, "ontrip")]):
            self.set_state(trip(A, st, eta="0 mins", north_m=north), {})
            self.assertEqual(self.run_check(150 + 30 * i), [])
            self.assertEqual(self.card(A)["state"], want, (st, north))
        self.assertGreater(self.card(A)["v"], v)
        self.set_state(None, {})
        self.assertEqual(self.run_check(300), [])
        self.assertEqual(self.card(A)["state"], "ontrip", "one empty poll keeps the live card")
        self.assertEqual(self.run_check(330), [])
        self.assertEqual(self.card(A)["state"], "unknown", "missing trip must not become completed")
        self.assertEqual(self.run_check(900), [])
        self.assertEqual(self.card(A)["state"], "unknown")
        self.set_state(None, {A: {"status": "COMPLETED"}})
        self.assertEqual(self.run_check(930), [])
        c = self.card(A)
        self.assertEqual((c["state"], c["terminal"], c["step"]), ("done", True, 4))
        self.assertEqual(self.run_check(960), [])
        with open(self.fixture + ".calls") as f:
            self.assertNotIn(f"trips get {A}", f.read().splitlines()[-1])

    def test_no_card_ready_when_already_sent_by_booking_flow(self):
        self.mark_sent(A)
        self.run_check(0)
        self.assertEqual(self.run_check(70), [])

    def test_card_ready_lists_only_missing_recipient(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="share")
        self.run_check(0)
        out = self.run_check(70)
        self.assertEqual(len(out), 1)
        self.assertIn("missing=moni", out[0])

    def test_quick_cancel_before_sharing_is_silent(self):
        self.set_state(trip(A, "Accepted"), {})
        self.assertEqual(self.run_check(0), [])
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(self.card(A)["state"], "cancelled")

    def test_shared_cancel_prints_once_after_window(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(150), [])
        self.assertEqual(self.run_check(240), [f"CANCELED trip={A} rider=abdullah(assumed)"])
        self.assertEqual(self.run_check(270), [])

    def test_cancel_then_rebook_new_card_no_cancel_line(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Searching"), {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(30), [])
        self.set_state(trip(B, "Accepted", plate="J 11111"), {A: {"status": "CANCELED"}})
        self.assertEqual(self.run_check(60), [])
        out = self.run_check(120)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith(f"CARD_READY trip={B}"))
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(self.card(A)["state"], "cancelled")
        self.assertEqual(self.card(B)["plate"], "J 11111")

    def test_cancel_fee_prints_even_when_rebooked(self):
        self.mark_sent(A)
        self.run_check(0)
        receipt = {A: "Fare\tAED 0.00\nCancellation Fee\tAED 28.00\nNew Total\tAED 28.00"}
        self.set_state(trip(B, "Searching"), {A: {"status": "CANCELED"}}, receipt)
        self.assertEqual(self.run_check(30), [f"CANCEL_FEE trip={A} rider=abdullah(assumed) fee=AED 28.00 refunded=no"])
        self.set_state(trip(B, "Accepted", plate="J 11111"), {A: {"status": "CANCELED"}}, receipt)
        self.assertEqual(self.run_check(60), [])
        out = self.run_check(120)
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith(f"CARD_READY trip={B}"), out)
        self.assertEqual(self.run_check(400), [], "no cancel line for the rebooked trip, fee not repeated")
        with open(self.fixture + ".calls") as f:
            self.assertEqual(f.read().splitlines().count(f"trips receipt {A}"), 1)

    def test_cancel_without_fee_prints_nothing_new(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Searching"), {A: {"status": "CANCELED"}}, {A: "Fare\tAED 0.00\nTotal\tAED 0.00"})
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(240), [f"CANCELED trip={A} rider=abdullah(assumed)"])

    def test_receipt_failure_is_silent(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Searching"), {A: {"status": "CANCELED"}}, None)
        self.assertEqual(self.run_check(30), [])
        self.assertEqual(self.run_check(240), [f"CANCELED trip={A} rider=abdullah(assumed)"])

    def test_completed_over_quote_reports_receipt_reason_once_even_without_shared_card(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        expected = (f"FARE_OVER trip={A} rider=abdullah(assumed) quoted=AED 84.70 "
                    "charged=AED 98.25 extra=Wait Time AED 13.55")
        self.assertEqual(self.run_check(FARE_NOW + 30), [expected])
        self.assertEqual(self.run_check(FARE_NOW + 60), [])
        self.assertEqual(self.receipt_calls(A), 1)
        with open(self.state) as f:
            self.assertEqual(json.load(f)["trips"][A]["fare_checked"], FARE_NOW + 30)

    def test_completed_small_increase_is_quiet(self):
        self.audit_quote(A)
        self.start_completed(A, "Total\tAED 90.00\nPayments")
        self.assertEqual(self.run_check(FARE_NOW + 30), [])
        self.assertEqual(self.run_check(FARE_NOW + 60), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_completed_without_matching_booking_does_not_read_receipt(self):
        self.audit_quote(B)
        self.start_completed(A, REAL_RECEIPT)
        self.assertEqual(self.run_check(FARE_NOW + 30), [])
        self.assertEqual(self.run_check(FARE_NOW + 60), [])
        self.assertEqual(self.receipt_calls(A), 0)

    def test_completed_receipt_failure_is_nonfatal_and_never_retried(self):
        self.audit_quote(A)
        self.start_completed(A, None)
        p = self.run_check_result(FARE_NOW + 30)
        self.assertEqual(p.stdout, "")
        self.assertEqual(len(p.stderr.splitlines()), 1)
        self.assertIn(f"receipt {A} failed", p.stderr)
        self.set_state(None, {A: {"status": "COMPLETED"}}, {A: REAL_RECEIPT})
        self.assertEqual(self.run_check(FARE_NOW + 60), [])
        self.assertEqual(self.receipt_calls(A), 1)
        with open(self.state) as f:
            self.assertEqual(json.load(f)["trips"][A]["fare_checked"], FARE_NOW + 30)

    def test_malformed_receipt_response_is_nonfatal_and_never_retried(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        p = self.run_check_result(FARE_NOW + 30, FAKE_UBER_BAD_RECEIPT="1")
        self.assertEqual(p.stdout, "")
        self.assertEqual(len(p.stderr.splitlines()), 1)
        self.assertEqual(self.run_check(FARE_NOW + 60), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_interrupted_receipt_does_not_replay_or_lose_other_events(self):
        self.audit_quote(A)
        self.set_state(trip(A, "OnTrip"), {})
        self.assertEqual(self.run_check(FARE_NOW), [])
        with open(self.state) as f:
            state = json.load(f)
        state["pending_cancel"][B] = {"since": FARE_NOW - 200, "rider": "abdullah", "label": "abdullah"}
        with open(self.state, "w") as f:
            json.dump(state, f)
        self.set_state(None, {A: {"status": "COMPLETED"}}, {A: REAL_RECEIPT})
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True, timeout=60,
                           env=dict(self.env, RIDE_SHARE_NOW=str(FARE_NOW + 30), FAKE_UBER_ABORT_WATCHER="1"))
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.run_check(FARE_NOW + 60), [f"CANCELED trip={B} rider=abdullah"])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_fare_receipt_tombstone_survives_old_trip_cleanup(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        self.assertTrue(self.run_check(FARE_NOW + 30)[0].startswith("FARE_OVER "))
        self.assertEqual(self.run_check(FARE_NOW + 15 * 86400), [])
        with open(self.state) as f:
            state = json.load(f)
        self.assertIn("fare_checked", state["trips"][A])
        self.set_state(trip(A, "OnTrip"), {})
        self.assertEqual(self.run_check(FARE_NOW + 15 * 86400 + 30), [])
        self.set_state(None, {A: {"status": "COMPLETED"}}, {A: REAL_RECEIPT})
        self.assertEqual(self.run_check(FARE_NOW + 15 * 86400 + 60), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_unacked_alert_survives_age_cleanup_until_acknowledged(self):
        now = datetime(2026, 11, 1, 12, tzinfo=timezone.utc).timestamp()
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT, now=now)
        out = self.run_check(now + 30, WATCH_RUN="r1")
        self.assertEqual(len(out), 1)
        self.assertEqual(self.run_check(now + 15 * 86400, WATCH_RUN="r2"), out)
        with open(self.state) as f:
            self.assertEqual(json.load(f)["trips"][A]["fare_alert"]["line"], out[0])
        self.ack("r2")
        self.assertEqual(self.run_check(now + 15 * 86400 + 30, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_replaced_attempt_cannot_checkpoint_or_emit_a_fare_alert(self):
        wdir = os.path.join(self.dir, "root", "watchers", "rides")
        os.makedirs(wdir)
        lock = sqlite3.connect(os.path.join(self.dir, "root", "relay-lock.sqlite"))
        lock.close()
        with open(os.path.join(wdir, "state.json"), "w") as f:
            json.dump({"admitted_run": {"run": "replacement", "attempt": "replacement-attempt"}}, f)
        with open(self.state, "w") as f:
            json.dump({"trips": {}, "pending": {}}, f)
        with open(self.state) as f:
            before = f.read()
        wrapper = self._exe("stale-fare", """#!/usr/bin/python3
import importlib.util, os
spec = importlib.util.spec_from_file_location('ride_share_check', os.environ['TEST_HELPER'])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.load(); t = s['trips'].setdefault('fixture', {})
m.queue_fare_alert('fixture', t, 'PRIVATE FARE')
m.finish_run(s, [])
""")
        env = dict(self.env, WATCH_DIR=wdir, WATCH_RUN="original", WATCH_ATTEMPT="original-attempt", TEST_HELPER=HELPER)
        p = subprocess.run([sys.executable, wrapper], capture_output=True, text=True, timeout=10, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout, "")
        with open(self.state) as f:
            self.assertEqual(f.read(), before)
        with open(os.path.join(wdir, "state.json"), "w") as f:
            json.dump({"admitted_run": {"run": "original", "attempt": "original-attempt"}}, f)
        p = subprocess.run([sys.executable, wrapper], capture_output=True, text=True, timeout=10, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "PRIVATE FARE")

    def test_fare_alert_replayed_after_exception_and_acked_replay(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        wrapper = self._exe("raise-after-receipt", """#!/usr/bin/python3
import importlib.util, os
spec = importlib.util.spec_from_file_location('ride_share_check', os.environ['TEST_HELPER'])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def fail(*args, **kwargs):
    raise RuntimeError('unshare failed after receipt')
m.unshare_ended = fail
m.main()
""")
        p = subprocess.run([sys.executable, wrapper], capture_output=True, text=True, timeout=60,
                           env=dict(self.env, RIDE_SHARE_NOW=str(FARE_NOW + 30), WATCH_RUN="r1", TEST_HELPER=HELPER))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("unshare failed after receipt", p.stderr)
        self.assertEqual(p.stdout, "")
        expected = (f"FARE_OVER trip={A} rider=abdullah(assumed) quoted=AED 84.70 "
                    "charged=AED 98.25 extra=Wait Time AED 13.55")
        self.assertEqual(self.run_check(FARE_NOW + 60, WATCH_RUN="r2"), [expected])
        self.ack("r2")
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)
        # A fresh trip is still detected after the replay was acknowledged.
        self.audit_quote(B)
        self.set_state(trip(B, "OnTrip"), {})
        self.assertEqual(self.run_check(FARE_NOW + 120, WATCH_RUN="r4"), [])
        self.set_state(None, {B: {"status": "COMPLETED"}}, {B: REAL_RECEIPT})
        self.assertEqual(self.run_check(FARE_NOW + 150, WATCH_RUN="r5"), [expected.replace(A, B)])
        self.assertEqual(self.receipt_calls(B), 1)

    def test_fare_alert_rebinds_unacked_runs_until_acknowledged(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        first = self.run_check(FARE_NOW + 30, WATCH_RUN="r1")
        self.assertEqual(len(first), 1)
        self.assertEqual(self.run_check(FARE_NOW + 60, WATCH_RUN="r2"), first)
        self.ack("r2")
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_status_failure_does_not_silently_ack_a_replayed_alert(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        first = self.run_check(FARE_NOW + 30, WATCH_RUN="r1")
        self.assertEqual(len(first), 1)
        p = self.run_check_result(FARE_NOW + 60, WATCH_RUN="r2", UBER_BIN=os.path.join(self.dir, "missing-uber"))
        self.assertEqual(p.stdout.splitlines(), first)
        self.ack("r2")
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_malformed_live_trip_does_not_silently_ack_a_replayed_alert(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        first = self.run_check(FARE_NOW + 30, WATCH_RUN="r1")
        self.assertEqual(len(first), 1)
        self.set_state(trip("invalid-uuid", "OnTrip"), {})
        self.assertEqual(self.run_check(FARE_NOW + 60, WATCH_RUN="r2"), first)
        self.ack("r2")
        self.set_state(None, {A: {"status": "COMPLETED"}})
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_runner_pending_or_delivery_before_ack_prevents_duplicate_fare(self):
        for delivered in (False, True):
            with self.subTest(delivered=delivered):
                uuid = A if not delivered else B
                self.audit_quote(uuid)
                self.set_state(trip(uuid, "OnTrip"), {})
                self.assertEqual(self.run_check(FARE_NOW + 100 * int(delivered), WATCH_RUN="start"), [])
                self.set_state(None, {uuid: {"status": "COMPLETED"}}, {uuid: REAL_RECEIPT})
                self.runner_state(fires=5)
                out = self.run_check(FARE_NOW + 30 + 100 * int(delivered), WATCH_RUN=f"out-{delivered}")
                self.assertEqual(len(out), 1)
                if delivered:
                    self.runner_state(fires=6)
                else:
                    self.runner_state(fires=5, pending={"event": out[0]})
                self.assertEqual(self.run_check(FARE_NOW + 60 + 100 * int(delivered), WATCH_RUN=f"next-{delivered}"), [])
                self.assertEqual(self.receipt_calls(uuid), 1)

    def test_replay_survives_interrupted_replay_before_exit(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        first = self.run_check(FARE_NOW + 30, WATCH_RUN="r1")
        self.assertEqual(len(first), 1)
        # r2 can be cut before saving its rebinding; r3 must still replay.
        wrapper = self._exe("raise-replay", """#!/usr/bin/python3
import importlib.util, os
spec = importlib.util.spec_from_file_location('ride_share_check', os.environ['TEST_HELPER'])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def fail(*args, **kwargs):
    raise RuntimeError('interrupted replay')
m.unshare_ended = fail
m.main()
""")
        p = subprocess.run([sys.executable, wrapper], capture_output=True, text=True, timeout=60,
                           env=dict(self.env, RIDE_SHARE_NOW=str(FARE_NOW + 60), WATCH_RUN="r2", TEST_HELPER=HELPER))
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), first)
        self.ack("r3")
        self.assertEqual(self.run_check(FARE_NOW + 120, WATCH_RUN="r4"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_pending_fare_is_not_lost_when_another_trip_is_checked(self):
        self.audit_quote(A)
        self.audit_quote(B)
        self.start_completed(A, REAL_RECEIPT)
        first = self.run_check(FARE_NOW + 30, WATCH_RUN="r1")
        self.assertEqual(len(first), 1)
        self.set_state(trip(B, "OnTrip"), {})
        self.assertEqual(self.run_check(FARE_NOW + 60, WATCH_RUN="r2"), first)
        self.set_state(None, {B: {"status": "COMPLETED"}}, {B: REAL_RECEIPT})
        both = self.run_check(FARE_NOW + 90, WATCH_RUN="r3")
        self.assertEqual(set(both), {first[0], first[0].replace(A, B)})
        self.ack("r3")
        self.assertEqual(self.run_check(FARE_NOW + 120, WATCH_RUN="r4"), [])
        self.assertEqual((self.receipt_calls(A), self.receipt_calls(B)), (1, 1))

    def test_fare_alert_survives_nonzero_failure_after_final_save(self):
        self.audit_quote(A)
        self.start_completed(A, REAL_RECEIPT)
        wrapper = self._exe("cut-after-save", """#!/usr/bin/python3
import importlib.util, os
spec = importlib.util.spec_from_file_location('ride_share_check', os.environ['TEST_HELPER'])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
save = m.save
def cut(s):
    save(s)
    if any(t.get('fare_alert', {}).get('run') for t in s['trips'].values()):
        os._exit(9)
m.save = cut
m.main()
""")
        p = subprocess.run([sys.executable, wrapper], capture_output=True, text=True, timeout=60,
                           env=dict(self.env, RIDE_SHARE_NOW=str(FARE_NOW + 30), WATCH_RUN="r1", TEST_HELPER=HELPER))
        self.assertEqual(p.returncode, 9)
        self.assertEqual(p.stdout, "")
        out = self.run_check(FARE_NOW + 60, WATCH_RUN="r2")
        self.assertEqual(len(out), 1)
        self.assertIn("Wait Time AED 13.55", out[0])
        self.ack("r2")
        self.assertEqual(self.run_check(FARE_NOW + 90, WATCH_RUN="r3"), [])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_audit_join_crosses_month_and_ignores_bad_rows(self):
        token = "synthetic-request"
        self.audit_rows("2026-10", "bad json", "null", {"action": "rides.request", "detail": []},
                        {"action": "rides.request", "outcome": "started", "token": token,
                         "detail": {"fare": "AED 84.70"}},
                        {"action": "other", "outcome": "started", "token": token,
                         "detail": {"fare": "AED 1.00"}})
        self.audit_rows("2026-11", {"action": "rides.request", "outcome": "succeeded", "token": token,
                                    "detail": {"tripUuid": A}})
        self.start_completed(A, REAL_RECEIPT)
        self.assertEqual(self.run_check(FARE_NOW + 30),
                         [f"FARE_OVER trip={A} rider=abdullah(assumed) quoted=AED 84.70 "
                          "charged=AED 98.25 extra=Wait Time AED 13.55"])
        self.assertEqual(self.receipt_calls(A), 1)

    def test_currency_mismatch_and_missing_total_are_quiet(self):
        self.audit_quote(A)
        self.start_completed(A, "Total\tUSD 120.00\nPayments")
        self.assertEqual(self.run_check(FARE_NOW + 30), [])
        self.assertEqual(self.receipt_calls(A), 1)
        self.audit_quote(B)
        self.start_completed(B, "Trip fare\tAED 100.00\nPayments")
        p = self.run_check_result(FARE_NOW + 30)
        self.assertEqual(p.stdout, "")
        self.assertIn(f"receipt {B} failed", p.stderr)
        self.assertEqual(self.receipt_calls(B), 1)

    def test_thresholds_are_strict_and_either_limit_can_trigger(self):
        cases = [("AED 50.00", "55.00", False), ("AED 50.00", "55.01", True),
                 ("AED 100.00", "110.00", False), ("AED 200.00", "210.00", False),
                 ("AED 200.00", "210.01", True)]
        for i, (quote, total, over) in enumerate(cases, 1):
            with self.subTest(quote=quote, total=total):
                uuid = f"cccccccc-0000-4000-8000-{i:012d}"
                self.audit_quote(uuid, quote)
                self.start_completed(uuid, f"Total\tAED {total}\nTrip fare\tAED {total}\nPayments\nTip\tAED 10.00")
                out = self.run_check(FARE_NOW + 30)
                self.assertEqual(len(out), int(over), out)
                if over:
                    self.assertEqual(out[0], f"FARE_OVER trip={uuid} rider=abdullah(assumed) "
                                     f"quoted={quote} charged=AED {total} extra=none listed")
                self.assertEqual(self.receipt_calls(uuid), 1)

    def test_late_cancel_history_after_rebook_card_ready_is_silent(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(trip(B, "Accepted", plate="J 1"), {})
        self.run_check(30)
        out = self.run_check(90)
        self.assertTrue(out and out[0].startswith(f"CARD_READY trip={B}"), out)
        self.set_state(trip(B, "Accepted", plate="J 1"), {A: {"status": "CANCELED"}})
        for t in (120, 200, 300, 400):
            self.assertEqual(self.run_check(t), [])

    def test_legacy_state_migrates_without_duplicate_events(self):
        legacy = {"trips": {A: {"first_seen": 0, "status": "OnTrip", "dest": "X", "last_seen": 0, "rider": "abdullah",
                                "rider_hinted": False, "booked_fired": 0, "driver_seen": 0}},
                  "active": A, "fail_since": None, "ending": {}, "pending_cancel": {}}
        with open(self.state, "w") as f:
            json.dump(legacy, f)
        self.set_state(trip(A, "OnTrip"), {})
        self.assertEqual(self.run_check(100), [], "already announced trip must not get CARD_READY")
        self.assertEqual(self.run_check(1000), [])
        self.set_state(None, {A: {"status": "CANCELED"}})
        self.run_check(1030)
        self.assertEqual(self.run_check(1300), [f"CANCELED trip={A} rider=abdullah(assumed)"])

    def test_card_ready_retries_once_if_still_missing(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.assertEqual(len(self.run_check(70)), 1)
        self.assertEqual(self.run_check(400), [])
        self.assertEqual(len(self.run_check(700)), 1)
        self.assertEqual(self.run_check(2000), [])

    def test_new_driver_note_survives_searching_gap(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.set_state(trip(A, "Searching"), {})
        self.run_check(30)
        self.set_state(trip(A, "Accepted", plate="Z 9", name="Omar"), {})
        self.run_check(60)
        c = self.card(A)
        self.assertEqual((c["plate"], c["note"]), ("Z 9", "New driver"))
        self.assertNotIn("last_plate", c)

    def test_malformed_uuid_leaves_cards_alone(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        self.set_state(trip("not-a-uuid", "OnTrip"), {})
        self.run_check(30)
        self.run_check(60)
        self.assertEqual(self.card(A)["state"], "ontrip")

    def test_dest_with_quotes_is_quoted(self):
        t = trip(A, "Accepted")
        t["stops"][1]["title"] = 'The "Q" Bar'
        self.set_state(t, {})
        self.run_check(0)
        out = self.run_check(70)
        self.assertIn('dest="The \\"Q\\" Bar"', out[0])

    def test_failed_after_share_prints_failed(self):
        self.mark_sent(A)
        self.run_check(0)
        self.set_state(None, {A: {"status": "UNFULFILLED"}})
        self.assertEqual(self.run_check(30), [f"FAILED trip={A} rider=abdullah(assumed) result=UNFULFILLED"])
        self.assertEqual(self.card(A)["state"], "failed")

    def test_driver_replacement_clears_old_car(self):
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.set_state(trip(A, "Searching"), {})
        self.run_check(30)
        c = self.card(A)
        self.assertEqual((c["state"], c["plate"], c["car"], c["driver"]), ("searching", None, None, None))
        self.set_state(trip(A, "Accepted", plate="Z 777", name="Omar", car="White Genesis G80"), {})
        self.run_check(60)
        c = self.card(A)
        self.assertEqual((c["plate"], c["driver"], c["car"]), ("Z 777", "Omar", "White Genesis G80"))
        self.assertNotIn("48213", self.page(A))

    def test_direct_driver_swap_marks_new_driver(self):
        self.set_state(trip(A, "ArrivingAtPickup"), {})
        self.run_check(0)
        self.set_state(trip(A, "ArrivingAtPickup", plate="Z 777", name="Omar", car=""), {})
        self.run_check(30)
        c = self.card(A)
        self.assertEqual((c["plate"], c["car"], c["note"]), ("Z 777", None, "New driver"))

    def test_unknown_gives_up_after_three_hours_without_completion(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        self.set_state(None, {})
        self.run_check(30)
        self.run_check(60)
        self.run_check(30 + 3 * 3600)
        c = self.card(A)
        self.assertEqual((c["state"], c["terminal"]), ("unknown", True))
        self.assertNotEqual(c["step"], 4)

    def test_sensitive_fields_never_public(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        blob = json.dumps(self.card(A)) + self.page(A)
        for bad in ("9731", "photo-secret", "25.0712", "55.1401", "AED 65.89", "Khan"):
            self.assertNotIn(bad, blob)

    def test_poll_log_keeps_raw_status_and_distance_not_coordinates(self):
        self.set_state(trip(A, "WaitingForPickup", eta="3 mins", north_m=900), {})
        self.run_check(0)
        self.set_state(trip(A, "ArrivingAtPickup", eta="0 mins", north_m=10), {})
        self.run_check(30)
        with open(os.path.join(self.dir, "polls.jsonl")) as f:
            raw = f.read()
        rows = [json.loads(x) for x in raw.splitlines()]
        self.assertEqual([(r["status"], r["eta"], r["dist_m"], r["card"]) for r in rows],
                         [("WaitingForPickup", "3 mins", 900, "arriving"), ("ArrivingAtPickup", "0 mins", 10, "arrived")])
        self.assertEqual(rows[0]["headline"], "Meet at Banyan Tree Residences")
        for bad in ("25.07", "55.14", "Khan", "9731"):
            self.assertNotIn(bad, raw)

    def test_poll_log_failure_never_stops_the_watcher(self):
        # a lone surrogate in Uber's text used to raise while logging, after the card but before state
        t = trip(A, "WaitingForPickup")
        t["headline"] = "Meet at \ud800 Banyan"
        self.set_state(t, {})
        self.run_check(0)
        self.assertEqual(self.run_check(90)[0].split()[:2], ["CARD_READY", f"trip={A}"])
        with open(os.path.join(self.dir, "polls.jsonl")) as f:
            self.assertEqual(json.loads(f.readline())["status"], "WaitingForPickup")
        os.remove(os.path.join(self.dir, "polls.jsonl"))
        os.mkdir(os.path.join(self.dir, "polls.jsonl"))
        self.set_state(trip(B, "Accepted"), {})
        self.run_check(120)
        self.assertEqual(self.run_check(180)[0].split()[:2], ["CARD_READY", f"trip={B}"])

    def test_scratch_watch_dir_writes_cards_inside_watch_dir(self):
        env = {k: v for k, v in self.env.items() if k not in ("RIDE_CARD_ROOT", "RIDE_CARD_JOURNAL")}
        self.set_state(trip(A, "Accepted"), {})
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True,
                           env=dict(env, RIDE_SHARE_NOW="0"), timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.dir, "cards", f"ride-{A}", "data.json")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "journal", f".{A}.lock")))
        self.assertEqual(self.bridge_calls(), [], "the check must never call the bridge")

    def test_check_never_calls_bridge(self):
        self.set_state(trip(A, "Accepted"), {})
        for t in (0, 30, 90, 120):
            self.run_check(t)
        self.assertEqual(self.bridge_calls(), [])

    def test_rider_hint_moni(self):
        with open(os.path.join(self.hints, f"rider-{A}"), "w") as f:
            f.write("moni\n")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        self.assertIn("rider=moni ", self.run_check(70)[0])
        self.assertEqual(self.card(A)["rider"], "Moni")
        self.assertIn("Moni&#x27;s ride", self.page(A))


FAKE_PREVIEW = """
import os
def render_html(doc, out, width=1200, height=630):
    flag = os.environ["FAKE_PREVIEW_FAIL"]
    if os.path.exists(flag):
        os.unlink(flag)
        raise RuntimeError("chrome hiccup")
    with open(out, "wb") as f:
        f.write(b"png")
    with open(os.environ["FAKE_PREVIEW_LOG"], "a") as f:
        f.write("render\\n")
"""


class ArrivalTest(unittest.TestCase):
    """Arrived needs Uber's ArrivingAtPickup plus the car at the pickup pin (recorded trips, Oct 2026)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card
        cls.rc = ride_card

    def live(self, *polls):
        c = None
        for st, eta, north in polls:
            c = self.rc.from_live(trip(A, st, eta=eta, north_m=north), c, "abdullah", "abdullah", 0)
        return c

    def test_waiting_for_pickup_is_on_the_way_even_near_the_pin(self):
        # 22 Oct: the card said Arrived at booking while the driver was ~5 min out
        for north in (5000, 40, 0):
            c = self.live(("WaitingForPickup", "5 mins", north))
            self.assertEqual((c["state"], c["step"]), ("arriving", 1), north)
            self.assertEqual(self.rc.texts(c)["big"], "5 mins")

    def test_arriving_at_pickup_far_from_pin_is_not_arrived(self):
        # 14 Oct trip 034e1320: ArrivingAtPickup "0 mins" for minutes while still driving in
        c = self.live(("WaitingForPickup", "2 mins", 900), ("ArrivingAtPickup", "0 mins", 400))
        self.assertEqual(c["state"], "arriving")
        t = self.rc.texts(c)
        self.assertEqual((t["big"], t["kick"]), ("Nearly there", ""))
        self.assertNotIn("rriv", t["og_title"].split("·")[-1])

    def test_arrived_at_the_pin_and_holds_through_gps_jitter(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 60))
        self.assertEqual((c["state"], c["step"]), ("arrived", 2))
        self.assertEqual(self.rc.texts(c)["big"], "Arrived")
        c = self.rc.from_live(trip(A, "ArrivingAtPickup", eta="0 mins", north_m=180), c, "abdullah", "abdullah", 30)
        self.assertEqual(c["state"], "arrived", "a jitter past 100 m keeps Arrived")
        c = self.rc.from_live(trip(A, "ArrivingAtPickup", eta="1 min", north_m=600), c, "abdullah", "abdullah", 60)
        self.assertEqual(c["state"], "arriving", "a car clearly elsewhere drops back")

    def test_replacement_driver_must_reach_the_pin_itself(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 30))
        self.assertEqual(c["state"], "arrived")
        swap = lambda north, now: self.rc.from_live(
            trip(A, "ArrivingAtPickup", plate="Z 777", name="Omar", eta="1 min", north_m=north), c, "abdullah", "abdullah", now)
        c = swap(180, 30)
        self.assertEqual((c["state"], c["note"]), ("arriving", "New driver"))
        c = swap(60, 60)
        self.assertEqual((c["state"], c["since"]), ("arrived", self.rc.iso(60)))

    def test_hold_needs_a_known_plate(self):
        t = lambda north, name: trip(A, "ArrivingAtPickup", plate=None, name=name, eta="0 mins", north_m=north)
        c = self.rc.from_live(t(30, "Imran"), None, "abdullah", "abdullah", 0)
        self.assertEqual(c["state"], "arrived")
        c = self.rc.from_live(t(180, "Omar"), c, "abdullah", "abdullah", 30)
        self.assertEqual(c["state"], "arriving")

    def test_hold_survives_plate_formatting(self):
        c = self.live(("ArrivingAtPickup", "0 mins", 30))
        self.assertEqual(c["state"], "arrived")
        for plate in ("K48213", "k 48213", "K-48213"):
            t = trip(A, "ArrivingAtPickup", plate=plate, eta="0 mins", north_m=180)
            n = self.rc.from_live(t, c, "abdullah", "abdullah", 30)
            self.assertEqual((n["state"], n["note"]), ("arrived", None), plate)

    def test_plates_in_any_script_keep_their_letters(self):
        t = trip(A, "ArrivingAtPickup", plate="أ 12345", eta="0 mins", north_m=30)
        c = self.rc.from_live(t, None, "abdullah", "abdullah", 0)
        self.assertEqual(c["state"], "arrived")
        held = self.rc.from_live(trip(A, "ArrivingAtPickup", plate="أ-12345", eta="0 mins", north_m=180),
                                 c, "abdullah", "abdullah", 30)
        self.assertEqual((held["state"], held["note"]), ("arrived", None))
        swap = self.rc.from_live(trip(A, "ArrivingAtPickup", plate="ب 12345", eta="0 mins", north_m=180),
                                 c, "abdullah", "abdullah", 30)
        self.assertEqual((swap["state"], swap["note"]), ("arriving", "New driver"))
        self.assertEqual(self.rc.plate_key("دبي ١٢٣٤٥"), self.rc.plate_key("دبي 12345"))

    def test_no_location_never_shows_arrived(self):
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["vehicle"]["location"] = None
        self.assertEqual(self.rc.from_live(t, None, "abdullah", "abdullah", 0)["state"], "arriving")
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["stops"][0]["location"] = None
        self.assertEqual(self.rc.from_live(t, None, "abdullah", "abdullah", 0)["state"], "arriving")
        t = trip(A, "ArrivingAtPickup", eta="0 mins", north_m=0)
        t["vehicle"]["location"] = {"latitude": 0, "longitude": 0}
        self.assertIsNone(self.rc.pickup_distance(t))

    def test_distance_reads_both_coordinate_shapes(self):
        t = trip(A, "ArrivingAtPickup", north_m=250)
        self.assertEqual(self.rc.pickup_distance(t), 250)
        t["vehicle"]["location"] = {"lat": PIN[0], "lng": PIN[1] + 0.001}
        self.assertAlmostEqual(self.rc.pickup_distance(t), 101, delta=2)

    def test_sample_states_follow_real_uber_order(self):
        got = [(n, c["state"]) for n, c in self.rc.sample_states()][:6]
        self.assertEqual(got, [("Searching", "searching"), ("Accepted", "assigned"), ("WaitingForPickup", "arriving"),
                               ("Nearby", "arriving"), ("AtPickup", "arrived"), ("OnTrip", "ontrip")])

    def test_acceptance_states_add_hard_cases_to_every_sample(self):
        samples = [n for n, _ in self.rc.sample_states()]
        cases = dict(self.rc.acceptance_states())
        self.assertEqual(list(cases)[:len(samples)], samples)
        self.assertEqual(cases["NewDriver"]["note"], "New driver")
        self.assertEqual(cases["LongNames"]["booker_name"], "Christopher Montgomery")
        now = self.rc.time.time()
        for name in ("Stale", "StaleNewDriver", "OnTripStale", "LongNamesNewDriverStale"):
            at = self.rc.datetime.fromisoformat(cases[name]["checked_at"].replace("Z", "+00:00")).timestamp()
            self.assertGreater(now - at, self.rc.STALE_S, name)


class RecipientTest(Base):
    def meta(self, *args, ok=True):
        return self.card_cli("meta", "--trip", A, *args, ok=ok)

    def test_extras_deduped_and_each_non_owner_gets_public_url(self):
        self.route("sara-k", "sara-thread", 1)
        p = self.meta("--rider", "sara-k", "--rider-name", "Sara", "--recipient", "moni",
                      "--recipient", "omar", "--recipient", "sara-k", "--recipient", "omar")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "sara-k", "omar"])
        self.set_state(trip(A, "Accepted"), {})
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@3").stdout)
        self.assertEqual(res, {"abdullah": "sent", "moni": "sent", "sara-k": "sent", "omar": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls].count("publish"), 1)
        for c in calls:
            if c[0] in ("send", "app"):
                to = c[c.index("--to") + 1] if "--to" in c else None
                body = " ".join(c)
                if to == "owner":
                    self.assertIn("ts.net", body)
                else:
                    self.assertNotIn("ts.net", body)
                    self.assertIn("trycloudflare.com", body)
        texts = {c[c.index("--to") + 1]: c[c.index("--text") + 1] for c in calls if c[0] == "send"}
        self.assertEqual(set(texts), {"moni", "sara-k", "omar"})
        self.assertTrue(texts["sara-k"].startswith("Your ride"))
        self.assertTrue(texts["omar"].startswith("Sara's ride"))
        app = [c for c in calls if c[0] == "app"][0]
        self.assertEqual(app[app.index("--caption") + 1], "Sara's ride")
        self.route("abdullah", "thread-1", 4)
        again = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@4").stdout)
        self.assertEqual(set(again.values()), {"already sent"})

    def test_recipient_metadata_private_and_not_in_public_files(self):
        self.route("sara-k", "sara-thread", 1)
        self.route("group-run-club-abc123", "club-thread", 1)
        self.meta("--rider", "sara-k", "--rider-name", "Sara", "--recipient", "group-run-club-abc123")
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0)
        blob = json.dumps(self.card(A)) + self.page(A)
        self.assertIn("Sara", blob)
        for bad in ("sara-k", "group-run-club", "abdullah\"", "moni\""):
            self.assertNotIn(bad, blob)
        meta = os.path.join(self.journal, f"{A}.meta.json")
        self.assertEqual(oct(os.stat(meta).st_mode & 0o777), "0o600")
        self.assertFalse(any(f.endswith("meta.json") for f in os.listdir(os.path.join(self.cards, f"ride-{A}"))))

    def test_unnamed_extra_rider_shows_no_slug(self):
        self.route("lina-2", "lina-thread", 1)
        self.meta("--rider", "lina-2")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0)
        c, page = self.card(A), self.page(A)
        self.assertIsNone(c["rider"])
        self.assertNotIn("lina", page)
        self.assertIn("The Uber", page)

    def test_invalid_recipient_and_names_rejected(self):
        self.route("sara-k", "sara-thread", 1)
        for args in (["--rider", "moni", "--recipient", "Bad Slug!"],
                     ["--rider", "+971501234567"],
                     ["--rider", "sara-k", "--rider-name", "+971 50 123 4567"],
                     ["--rider", "sara-k", "--rider-name", "<b>x</b>"]):
            p = self.meta(*args, ok=False)
            self.assertNotEqual(p.returncode, 0, args)
        self.assertFalse(os.path.exists(os.path.join(self.journal, f"{A}.meta.json")))

    def test_watcher_missing_lists_extras(self):
        self.meta("--rider", "moni", "--recipient", "omar")
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "moni")
        self.run_check(0)
        out = self.run_check(70)
        self.assertIn("missing=abdullah,omar", out[0])

    def test_non_owner_chat_reaches_only_itself(self):
        self.meta("--rider", "omar", "--rider-name", "Omar")
        self.set_state(trip(A, "Accepted"), {})
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "omar-thread@1", "--from-chat", "omar").stdout)
        self.assertEqual(res, {"omar": "sent"})
        self.assertTrue(all("--to" not in c for c in self.bridge_calls()))
        p = self.card_cli("send", "--trip", A, "--session", "x-thread@1", "--from-chat", "stranger", ok=False)
        self.assertIn("not the live session of any chat", p.stderr)

    def test_non_moni_recipient_gets_link_even_when_cards_installed(self):
        installed = self._exe("enroll-ok", "#!/bin/sh\necho 'moni: installed'\n")
        self.meta("--rider", "omar", "--rider-name", "Omar")
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", RIDE_CARD_ENROLL=installed)
        calls = self.bridge_calls()
        moni = [c for c in calls if "--to" in c and c[c.index("--to") + 1] == "moni"][0]
        omar = [c for c in calls if "--to" in c and c[c.index("--to") + 1] == "omar"][0]
        self.assertEqual(moni[0], "app", "Moni keeps her Robob Cards readiness")
        self.assertEqual(omar[0], "send", "other people get a plain public link")

    def test_display_name_with_digits_rejected(self):
        self.route("sara-k", "sara-thread", 1)
        p = self.meta("--rider", "sara-k", "--rider-name", "Al 50 12 34", ok=False)
        self.assertNotEqual(p.returncode, 0)

    def test_adding_extras_later_keeps_rider_booker_and_earlier_extras(self):
        self.route("lina", "lina-thread", 1)
        self.meta("--rider", "moni", "--booker", "moni", "--recipient", "omar")
        p = self.meta("--rider", "moni", "--recipient", "lina")
        self.assertEqual(json.loads(p.stdout)["booker"], "moni")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "omar", "lina"])

    def test_unknown_chat_refused_without_writing_metadata(self):
        cases = [
            ("rider", ["--rider", "Kabita"]),
            ("booker", ["--rider", "moni", "--booker", "kabita"]),
            ("recipient", ["--rider", "moni", "--recipient", "omar", "--recipient", "kabita"]),
            ("off-bridge booker", ["--rider", "guest", "--rider-off-bridge", "--rider-name", "Guest",
                                   "--booker", "kabita"]),
            ("off-bridge recipient", ["--rider", "guest", "--rider-off-bridge", "--rider-name", "Guest",
                                      "--recipient", "kabita"]),
        ]
        path = os.path.join(self.journal, f"{A}.meta.json")
        for role, args in cases:
            with self.subTest(role=role, existing=False):
                p = self.meta(*args, ok=False)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("no bridge chat 'kabita'", p.stderr)
                self.assertIn("--rider-off-bridge", p.stderr)
                self.assertFalse(os.path.exists(path))
        self.meta("--rider", "moni")
        with open(path) as f:
            before = f.read()
        for role, args in cases:
            with self.subTest(role=role, existing=True):
                p = self.meta(*args, ok=False)
                self.assertNotEqual(p.returncode, 0)
                with open(path) as f:
                    self.assertEqual(f.read(), before)

    def test_base_recipients_need_no_chat_store(self):
        rc = self.rc()
        with unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc, "known_chat", return_value=False):
            rc.set_meta(A, "moni", booker="owner", extras=["moni", "me"])
            self.assertEqual(rc.recipients_for(A), ["abdullah", "moni"])

    def test_off_bridge_rider_named_but_never_an_automatic_recipient(self):
        p = self.meta("--rider", "kabita", "--rider-name", "Kabita", "--rider-off-bridge")
        result = json.loads(p.stdout)
        self.assertEqual(result["recipients"], ["abdullah", "moni"])
        self.assertEqual(result["off_bridge"], ["kabita"])
        self.assertEqual(result["rider"], "kabita")
        with open(os.path.join(self.journal, f"{A}.meta.json")) as f:
            self.assertIs(json.load(f)["rider_off_bridge"], True)
        self.set_state(trip(A, "Accepted"), {})
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@3").stdout)
        self.assertEqual(res, {"abdullah": "sent", "moni": "sent"})
        self.assertEqual(self.card(A)["rider"], "Kabita")
        self.assertIn("Kabita", self.page(A))
        self.assertNotIn("kabita", json.dumps(self.card(A)) + self.page(A))
        captions = [c[c.index("--caption") + 1] for c in self.bridge_calls() if c[0] == "app"]
        self.assertEqual(captions, ["Kabita's ride"])
        self.assertNotIn("--to kabita", " ".join(" ".join(c) for c in self.bridge_calls()))

    def test_off_bridge_requires_name_and_cannot_name_base_recipient(self):
        cases = [
            (["--rider", "kabita"], "requires --rider-name"),
            (["--rider", "kabita", "--rider-name", "   "], "unsafe display name"),
            *[(["--rider", rider, "--rider-name", "Name"], "cannot name abdullah or moni")
              for rider in ("abdullah", "moni", "owner", "me", " Moni ")],
        ]
        for args, error in cases:
            with self.subTest(args=args):
                p = self.meta("--rider-off-bridge", *args, ok=False)
                self.assertNotEqual(p.returncode, 0)
                self.assertIn(error, p.stderr)
                self.assertFalse(os.path.exists(os.path.join(self.journal, f"{A}.meta.json")))

    def test_off_bridge_excluded_even_if_chat_exists_and_other_roles_repeat_it(self):
        self.route("kabita", "kabita-thread", 1)
        p = self.meta("--rider", "kabita", "--rider-name", "Kabita", "--rider-off-bridge",
                      "--booker", "kabita", "--recipient", "kabita", "--recipient", "omar")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "omar"])
        p = self.meta("--rider", "kabita")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "kabita", "omar"])
        self.assertEqual(json.loads(p.stdout)["off_bridge"], [])
        p = self.meta("--rider", "moni", "--booker", "owner")
        self.assertEqual(json.loads(p.stdout)["recipients"], ["abdullah", "moni", "kabita", "omar"])

    def test_watcher_never_requests_off_bridge_rider_after_base_chats_sent(self):
        self.meta("--rider", "kabita", "--rider-name", "Kabita", "--rider-off-bridge")
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(self.run_check(0), [])
        self.assertEqual(self.run_check(70), [])

    def test_legacy_unknown_chats_filtered_from_recipients_and_send_plan(self):
        os.makedirs(self.journal, exist_ok=True)
        with open(os.path.join(self.journal, f"{A}.meta.json"), "w") as f:
            json.dump({"trip": A, "rider": "kabita", "booker": "unknown-booker",
                       "extras": ["unknown-extra", "omar", "kabita", "omar"]}, f)
        rc = self.rc()
        with unittest.mock.patch.dict(os.environ, self.env):
            self.assertEqual(rc.recipients_for(A), ["abdullah", "moni", "omar"])
        res = json.loads(self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--dry-run").stdout)
        self.assertEqual(set(res) - {"note"}, {"abdullah", "moni", "omar"})
        self.assertNotIn("kabita", json.dumps(res))
        self.assertEqual(self.bridge_calls(), [])


class UnshareTest(Base):
    def unshares(self):
        return [c[2] for c in self.bridge_calls() if c[0] == "unshare"]

    def ended(self, uuid, status="COMPLETED", at=30):
        self.mark_sent(uuid)
        self.run_check(0)
        self.set_state(None, {uuid: {"status": status}})
        self.run_check(at)
        self.assertTrue(self.card(uuid)["terminal"])

    def test_ended_ride_link_goes_an_hour_after_the_end_once(self):
        self.ended(A)
        self.assertEqual(self.run_check(30 + 3599), [])
        self.assertEqual(self.unshares(), [], "the page stays up for an hour after the ride")
        self.assertEqual(self.run_check(30 + 3600), [])
        self.assertEqual(self.unshares(), [f"ride-{A}"])
        self.run_check(30 + 3630)
        self.assertEqual(self.unshares(), [f"ride-{A}"], "taken down once")

    def unconfirmed(self, uuid, start):
        """A shared ride Uber stops showing with no history status: frozen as unconfirmed at
        start + 30 + 3h. Returns the freeze time."""
        self.set_state(trip(uuid, "OnTrip"), {})
        self.card_cli("send", "--trip", uuid, "--session", "thread-1@3")
        self.run_check(start)
        self.set_state(None, {})
        frozen = start + 30 + 3 * 3600
        for t in (start + 30, start + 60, frozen):
            self.run_check(t)
        self.assertEqual((self.card(uuid)["state"], self.card(uuid)["terminal"]), ("unknown", True))
        return frozen

    def test_cancelled_and_unconfirmed_rides_are_unshared_too(self):
        self.ended(A, status="CANCELED")
        self.run_check(30 + 3600)
        self.assertEqual(self.unshares(), [f"ride-{A}"])
        frozen = self.unconfirmed(B, 4000)
        self.run_check(frozen + 12 * 3600)
        self.assertEqual(self.unshares(), [f"ride-{A}", f"ride-{B}"])

    def test_unconfirmed_ride_keeps_its_link_for_12h_after_it_froze(self):
        # "Checking" started 3h before the freeze; the link's clock starts at the freeze itself.
        frozen = self.unconfirmed(A, 0)
        for t in (frozen + 30, frozen + 3600, frozen + 12 * 3600 - 30):
            self.run_check(t)
        self.assertEqual(self.unshares(), [], "a ride Uber never confirmed ended may still be going")
        self.run_check(frozen + 12 * 3600)
        self.assertEqual(self.unshares(), [f"ride-{A}"])

    def test_unconfirmed_ride_that_shows_up_again_reopens_and_keeps_its_link(self):
        frozen = self.unconfirmed(A, 0)
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(frozen + 600)
        c = self.card(A)
        self.assertEqual((c["state"], c["terminal"]), ("ontrip", False), "the ride was live all along")
        for t in (frozen + 12 * 3600, frozen + 30 * 3600):
            self.run_check(t)
        self.assertEqual(self.unshares(), [], "a ride Uber shows right now keeps its link")
        self.set_state(None, {A: {"status": "COMPLETED"}})
        self.run_check(frozen + 30 * 3600 + 30)
        self.assertEqual(self.card(A)["state"], "done")
        self.run_check(frozen + 31 * 3600 + 30)
        self.assertEqual(self.unshares(), [f"ride-{A}"])

    def test_trip_uber_shows_now_is_never_unshared(self):
        self.ended(A)
        self.set_state(trip(A, "OnTrip"), {A: {"status": "COMPLETED"}})  # history and status disagree
        self.run_check(30 + 7200)
        self.assertEqual(self.unshares(), [])
        self.assertEqual(self.card(A)["state"], "done", "a history-confirmed end stays frozen")

    def hold(self, uuid):
        f = open(os.path.join(self.journal, f".{uuid}.lock"), "a")
        fcntl.flock(f, fcntl.LOCK_EX)
        self.addCleanup(f.close)
        return f

    def test_busy_trip_is_skipped_not_waited_on(self):
        self.ended(A)
        self.ended(B)
        for u in (A, B):  # previews current, so the preview retry has no reason to touch A
            open(os.path.join(self.cards, f"ride-{u}", "preview.png"), "w").close()
        self.run_check(30 + 60)
        held = self.hold(A)
        start = time.time()
        self.run_check(30 + 3600)
        self.assertLess(time.time() - start, 20, "the check never waits on another trip's lock")
        self.assertEqual(self.unshares(), [f"ride-{B}"])
        fcntl.flock(held, fcntl.LOCK_UN)
        self.run_check(30 + 3630)
        self.assertEqual(self.unshares(), [f"ride-{B}", f"ride-{A}"])

    def test_share_cap_skips_a_trip_someone_is_sending(self):
        # The cap path takes each candidate's lock without waiting: a busy one is left alone.
        self.ended(A)
        self.ended("cccccccc-0000-4000-8000-000000000001")
        self.hold(A)
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", FAKE_BRIDGE_CAP="1")
        self.assertEqual(json.loads(p.stdout)["moni"], "sent")
        self.assertEqual(self.unshares(), ["ride-cccccccc-0000-4000-8000-000000000001"])

    def test_share_cap_frees_no_ride_that_may_still_be_going(self):
        self.unconfirmed(A, int(time.time()) - 3 * 3600 - 60)  # froze a minute ago (send uses the real clock)
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1")
        self.assertIn("live shares", json.loads(p.stdout)["moni"])
        self.assertEqual(self.unshares(), [])

    def test_share_cap_spares_a_frozen_ride_uber_shows_again(self):
        # A froze as "never confirmed" over 12h ago, but Uber shows it on a trip again; B's share hits
        # the cap before the watcher has reopened A's card.
        self.unconfirmed(A, int(time.time()) - 16 * 3600)
        self.set_state(trip(B, "Accepted"), {})
        self.card_cli("refresh", "--trip", B)  # B's card, without a watcher run that would reopen A
        self.set_state(trip(A, "OnTrip"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1")
        self.assertIn("live shares", json.loads(p.stdout)["moni"])
        self.assertEqual(self.unshares(), [], "the ride Uber shows right now keeps its link")

    def test_share_cap_frees_nothing_when_uber_cant_be_read(self):
        self.unconfirmed(A, int(time.time()) - 16 * 3600)
        self.set_state(trip(B, "Accepted"), {})
        self.card_cli("refresh", "--trip", B)
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1",
                          UBER_BIN=os.path.join(self.dir, "no-such-uber"))
        self.assertIn("live shares", json.loads(p.stdout)["moni"])
        self.assertEqual(self.unshares(), [])
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", FAKE_BRIDGE_CAP="1")
        self.assertEqual(json.loads(p.stdout)["moni"], "sent")
        self.assertEqual(self.unshares(), [f"ride-{A}"], "with Uber read, a ride frozen 12h+ ago can go")

    def test_unshared_ride_that_shows_up_again_gets_a_new_link(self):
        frozen = self.unconfirmed(A, 0)
        self.run_check(frozen + 12 * 3600)
        self.assertEqual(self.unshares(), [f"ride-{A}"])
        old = self.share_log()["recipients"]["moni"]["payload"]["url"]
        self.set_state(trip(A, "OnTrip"), {})
        out = self.run_check(frozen + 13 * 3600)
        self.assertEqual(len(out), 1, "the watcher wakes the owner thread to send the new link")
        self.assertTrue(out[0].startswith(f"CARD_READY trip={A}") and "missing=moni" in out[0], out)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent", "moni": "sent"})
        shares = [c for c in self.bridge_calls() if c[0] == "share"]
        self.assertEqual(len(shares), 2, "the card is shared again")
        moni = [c for c in self.bridge_calls() if c[0] == "send" and c[c.index("--to") + 1] == "moni"]
        self.assertEqual(len(moni), 2)
        self.assertEqual(moni[-1][moni[-1].index("--key") + 1], f"uber:{A}:card:moni:relink1")
        self.assertIn(old, moni[-1][moni[-1].index("--text") + 1], "same page, shared again")
        self.assertFalse(os.path.exists(os.path.join(self.journal, f".{A}.unshared")))
        j = self.share_log()
        self.assertEqual([r["who"] for r in j["retired"]], ["moni"])
        self.assertEqual(self.run_check(frozen + 13 * 3600 + 60), [])
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent", "moni": "already sent"})

    def test_old_unconfirmed_card_without_a_freeze_time_keeps_its_link(self):
        # Frozen before ended_at existed and with no readable checked_at: `since` is when "Checking"
        # began, hours before the freeze, so it can't start the 12h clock. The 2-day share runs out.
        frozen = self.unconfirmed(A, 0)
        path = os.path.join(self.cards, f"ride-{A}", "data.json")
        with open(path) as f:
            c = json.load(f)
        c.pop("ended_at", None)
        c["checked_at"] = None
        with open(path, "w") as f:
            json.dump(c, f)
        self.run_check(frozen + 30 * 3600)
        self.assertEqual(self.unshares(), [])

    def test_live_ride_and_owner_only_card_keep_their_pages(self):
        self.set_state(trip(A, "OnTrip"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.run_check(10 * 3600)
        self.assertEqual(self.unshares(), [], "a ride still going keeps its link")
        self.set_state(trip(B, "Accepted"), {})
        self.card_cli("send", "--trip", B, "--session", "thread-1@3", "--chat", "abdullah")
        self.run_check(10 * 3600 + 30)
        self.set_state(None, {A: {"status": "COMPLETED"}, B: {"status": "COMPLETED"}})
        self.run_check(10 * 3600 + 60)
        self.run_check(20 * 3600)
        self.assertEqual(self.unshares(), [f"ride-{A}"], "the owner's tailnet card is no share")

    def test_failed_unshare_is_tried_again_next_run(self):
        self.ended(A)
        p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True, timeout=60,
                           env=dict(self.env, RIDE_SHARE_NOW=str(30 + 3600), FAKE_BRIDGE_FAIL="unshare"))
        self.assertEqual(p.returncode, 0, "a bridge hiccup must not fail the watcher")
        self.assertIn(f"unshare {A} failed", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.journal, f".{A}.unshared")))
        self.run_check(30 + 3630)
        self.assertEqual(self.unshares(), [f"ride-{A}", f"ride-{A}"])
        self.assertTrue(os.path.exists(os.path.join(self.journal, f".{A}.unshared")))

    def test_share_cap_frees_ended_rides_then_shares(self):
        # All 10 live shares in use (trip e44d36f9): an ended ride's link goes and the share is retried.
        self.ended(A)
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", FAKE_BRIDGE_CAP="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent"})
        calls = [c[:3] for c in self.bridge_calls() if c[0] in ("share", "unshare")]
        self.assertEqual(calls[-3:], [["share", "--app", f"ride-{B}"], ["unshare", "--app", f"ride-{A}"],
                                      ["share", "--app", f"ride-{B}"]])

    def test_a_backlog_goes_a_few_per_run(self):
        uuids = [f"cccccccc-0000-4000-8000-00000000000{i}" for i in range(4)]
        for u in uuids:
            self.ended(u)
        self.run_check(30 + 3600)
        self.assertEqual(len(self.unshares()), 3)
        self.run_check(30 + 3630)
        self.assertEqual(sorted(self.unshares()), sorted(f"ride-{u}" for u in uuids))

    def test_share_cap_with_nothing_ended_still_fails_plainly(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1")
        self.assertIn("live shares", json.loads(p.stdout)["moni"])
        self.assertEqual(self.unshares(), [])

    def test_stable_origin_link_is_never_retired_after_the_hour(self):
        # A's link is on the stable origin (permanent): the URL Moni already has must keep working.
        # B's is a quick tunnel and still goes an hour after its ride.
        self.env["FAKE_BRIDGE_PERMANENT"] = f"ride-{A}"
        self.ended(A)
        self.ended(B)
        for t in (30 + 3600, 30 + 7200, 30 + 30 * 86400):
            self.run_check(t)
        self.assertEqual(self.unshares(), [f"ride-{B}"])
        self.assertFalse(os.path.exists(os.path.join(self.journal, f".{A}.unshared")))

    def test_unreadable_share_list_retires_nothing_after_the_hour(self):
        self.ended(A)
        for bad in (dict(FAKE_BRIDGE_FAIL="shares"), dict(FAKE_BRIDGE_SHARES_RAW="oops"),
                    dict(FAKE_BRIDGE_SHARES_RAW='{"shares": null}')):
            p = subprocess.run([sys.executable, HELPER], capture_output=True, text=True, timeout=60,
                               env=dict(self.env, RIDE_SHARE_NOW=str(30 + 3600), **bad))
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("share list unreadable", p.stderr)
            self.assertEqual(self.unshares(), [], bad)
        self.run_check(30 + 3630)
        self.assertEqual(self.unshares(), [f"ride-{A}"], "once the list reads, the quick-tunnel link goes")

    def test_share_cap_never_frees_a_stable_origin_link(self):
        c = "cccccccc-0000-4000-8000-000000000001"
        self.env["FAKE_BRIDGE_PERMANENT"] = f"ride-{A}"
        self.ended(A)
        self.ended(c)
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", FAKE_BRIDGE_CAP="1")
        self.assertEqual(json.loads(p.stdout)["moni"], "sent")
        self.assertEqual(self.unshares(), [f"ride-{c}"], "only the quick-tunnel link is freed")

    def test_share_cap_with_only_stable_origin_links_fails_plainly(self):
        self.env["FAKE_BRIDGE_PERMANENT"] = f"ride-{A}"
        self.ended(A)
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1")
        self.assertIn("live shares", json.loads(p.stdout)["moni"])
        self.assertEqual(self.unshares(), [])

    def test_share_cap_frees_nothing_when_share_list_unreadable(self):
        self.ended(A)
        self.set_state(trip(B, "Accepted"), {})
        for bad in (dict(FAKE_BRIDGE_FAIL="shares"), dict(FAKE_BRIDGE_SHARES_RAW="oops")):
            p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_CAP="1", **bad)
            self.assertIn("live shares", json.loads(p.stdout)["moni"])
            self.assertEqual(self.unshares(), [], bad)
        p = self.card_cli("send", "--trip", B, "--session", "thread-1@3", FAKE_BRIDGE_CAP="1")
        self.assertEqual(json.loads(p.stdout)["moni"], "sent")
        self.assertEqual(self.unshares(), [f"ride-{A}"])


class PreviewRetryTest(Base):
    def test_failed_preview_retried_next_check_without_version_bump(self):
        lib = os.path.join(self.dir, "plib")
        os.makedirs(lib)
        with open(os.path.join(lib, "cardpreview.py"), "w") as f:
            f.write(FAKE_PREVIEW)
        flag = os.path.join(self.dir, "fail-once")
        open(flag, "w").close()
        log = os.path.join(self.dir, "renders")
        env = dict(RIDE_CARD_NO_IMAGE="0", RIDE_CARD_PREVIEW_LIB=lib, FAKE_PREVIEW_FAIL=flag, FAKE_PREVIEW_LOG=log)
        png = os.path.join(self.cards, f"ride-{A}", "preview.png")
        self.set_state(trip(A, "Accepted"), {})
        self.run_check(0, **env)
        self.assertFalse(os.path.exists(png))
        v = self.card(A)["v"]
        self.run_check(30, **env)
        self.assertTrue(os.path.exists(png), "preview retried on the next check")
        self.assertEqual(self.card(A)["v"], v, "a preview retry must not bump the version")
        self.run_check(60, **env)
        with open(log) as f:
            self.assertEqual(f.read().count("render"), 1, "no re-render once the preview is current")
        self.assertFalse([x for x in os.listdir(os.path.dirname(png)) if x.startswith(".preview-")])

    def test_terminal_card_preview_retried_by_watcher(self):
        lib = os.path.join(self.dir, "plib")
        os.makedirs(lib)
        with open(os.path.join(lib, "cardpreview.py"), "w") as f:
            f.write(FAKE_PREVIEW)
        flag = os.path.join(self.dir, "fail-once")
        log = os.path.join(self.dir, "renders")
        env = dict(RIDE_CARD_NO_IMAGE="0", RIDE_CARD_PREVIEW_LIB=lib, FAKE_PREVIEW_FAIL=flag, FAKE_PREVIEW_LOG=log)
        self.set_state(trip(A, "OnTrip"), {})
        self.run_check(0, **env)
        self.set_state(None, {A: {"status": "COMPLETED"}})
        open(flag, "w").close()
        self.run_check(30, **env)  # terminal transition, preview render fails
        c = self.card(A)
        self.assertEqual(c["state"], "done")
        self.set_state(None, {})
        self.run_check(60, **env)  # watcher retries the frozen card's preview
        self.assertEqual(self.card(A)["v"], c["v"])
        self.run_check(90, **env)
        with open(log) as f:
            self.assertEqual(f.read().count("render"), 2, "initial + one retry, then nothing")
        with open(self.state) as f:
            self.assertEqual(json.load(f)["preview_retry"], {})


class RemoteRideCardTest(Base):
    def setUp(self):
        super().setUp()
        self.set_state(trip(A, "Accepted"), {})

    def remote(self, who="moni"):
        with open(os.path.join(self.bstate, "config.json"), "w") as f:
            json.dump({"chatBackends": {who: {"kind": "remote-box"}}}, f)

    def send(self, **env):
        return self.card_cli("send", "--trip", A, "--session", "thread-1@3", **env)

    def calls(self, command):
        return [c for c in self.bridge_calls() if c[0] == command]

    def test_403_relays_frozen_link_with_same_key_and_leaves_owner_card(self):
        logs = os.path.join(self.dir, "logs")
        installed = self._exe("installed", "#!/bin/sh\necho 'moni: installed'\n")
        result = json.loads(self.send(FAKE_BRIDGE_REMOTE="moni", RIDE_CARD_ENROLL=installed, TOOLLOG_DIR=logs).stdout)
        self.assertEqual(result, {"abdullah": "sent", "moni": "relayed via Moni's box"})
        owner, moni = self.calls("app")
        relay, = self.calls("agent-ask")
        opt = lambda c, flag: c[c.index(flag) + 1]
        self.assertEqual(opt(owner, "--to"), "owner")
        self.assertEqual(opt(relay, "--to"), "moni")
        self.assertEqual(opt(moni, "--key"), opt(relay, "--key"))
        r = self.share_log()["recipients"]["moni"]
        request = opt(relay, "--text")
        self.assertEqual(json.loads(request.split("\n")[-1]), r["payload"]["text"])
        self.assertIn(r["payload"]["url"], request)
        self.assertIn("reconcile an ambiguous send", request)
        self.assertEqual(r["status"], "relayed")
        self.assertEqual(r["open"], [])
        self.assertTrue(r["agent_request_id"].startswith("areq_"))
        with open(os.path.join(logs, datetime.now(timezone.utc).date().isoformat() + ".ndjson")) as f:
            events = [json.loads(line) for line in f]
        error = next(e for e in events if e["name"] == "bridge.error")
        self.assertEqual(error["ids"]["helper"], "ride-card.app")
        self.assertEqual(error["props"]["stderrClass"], "auth")
        event = next(e for e in events if e["name"] == "relay")
        self.assertEqual(set(event["ids"]), {"helper", "chat", "key", "item"})
        before = self.bridge_calls()
        self.send(FAKE_BRIDGE_REMOTE="moni")
        self.assertEqual(self.bridge_calls(), before)
        self.assertEqual(self.run_check(30), [], "a relay must count as delivered for CARD_READY")

    def test_configured_remote_skips_local_install_and_direct_bridge(self):
        self.remote()
        fail_enroll = self._exe("bad-enroll", "#!/bin/sh\necho ran > \"$RIDE_CARD_ENROLL.ran\"\nexit 1\n")
        self.send(RIDE_CARD_ENROLL=fail_enroll)
        self.assertFalse(os.path.exists(fail_enroll + ".ran"))
        self.assertEqual([c[0] for c in self.bridge_calls()], ["publish", "app", "share", "agent-ask"])

    def test_dry_run_remote_with_no_local_chat_store_is_read_only(self):
        self.remote("omar")
        os.unlink(os.path.join(self.bstate, "chats", "omar", "state.sqlite"))
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "omar", "--dry-run")
        self.assertIn("via agent-ask --to omar", p.stdout)
        self.assertEqual(self.bridge_calls(), [])
        self.assertIsNone(self.share_log())

    def test_ambiguous_direct_attempt_never_switches_transport(self):
        self.send(ok=False, FAKE_BRIDGE_FAIL="send")
        self.remote()
        p = self.send(ok=False, FAKE_BRIDGE_REMOTE="moni")
        self.assertIn("may still land", p.stdout)
        self.assertEqual(self.calls("agent-ask"), [])

    def test_fallback_checks_older_unanswered_attempt_after_clean_403(self):
        self.send(ok=False, FAKE_BRIDGE_FAIL="send")
        p = self.send(ok=False, FAKE_BRIDGE_REMOTE="moni")
        self.assertIn("may still land", p.stdout)
        self.assertEqual(self.calls("agent-ask"), [])

    def test_previous_clean_403_can_relay_even_without_remote_outbox(self):
        self.send(ok=False, FAKE_BRIDGE_FAIL="send",
                  FAKE_BRIDGE_ERR="Bridge request failed (HTTP 403): Use agent-ask to reach this chat on its box")
        os.unlink(os.path.join(self.bstate, "chats", "moni", "state.sqlite"))
        self.assertIn("relayed via Moni's box", self.send().stdout)
        self.assertEqual(len(self.calls("agent-ask")), 1)

    def test_agent_ask_failure_is_failed_and_retry_keeps_key(self):
        self.remote()
        p = self.send(ok=False, FAKE_BUS_FAIL="1")
        self.assertIn("agent bus unavailable", p.stdout)
        self.assertEqual(self.share_log()["recipients"]["moni"]["status"], "failed")
        self.send()
        first, second = self.calls("agent-ask")
        self.assertEqual(first, second)

    def test_only_the_exact_remote_403_switches_to_relay(self):
        for error in ("Bridge request failed (HTTP 403): Forbidden",
                      "Bridge request failed (HTTP 500): Use agent-ask to reach this chat on its box"):
            with self.subTest(error=error):
                p = self.send(ok=False, FAKE_BRIDGE_FAIL="send", FAKE_BRIDGE_ERR=error)
                self.assertIn("failed", p.stdout)
                self.assertEqual(self.calls("agent-ask"), [])

    def test_open_bus_request_replays_same_key_before_or_after_wake_delivery(self):
        for queued in (False, True):
            with self.subTest(wake_already_queued=queued):
                self.remote()
                self.send(ok=False, FAKE_BUS_FAIL="1", FAKE_BUS_ROW="1", FAKE_BUS_QUEUED="1" if queued else "")
                with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
                    self.assertEqual(con.execute("select count(*) from agent_wakes").fetchone()[0], int(queued))
                self.assertIn("relayed via Moni's box", self.send().stdout)
                first, second = self.calls("agent-ask")[-2:]
                self.assertEqual(first, second)
                with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
                    self.assertEqual(con.execute("select count(*) from agent_wakes").fetchone()[0], 1)
                before = len(self.calls("agent-ask"))
                self.send()
                self.assertEqual(len(self.calls("agent-ask")), before, "validated ack prevents another ask")
                # Reset only the fake trip's state for the other failure window.
                if not queued:
                    self.journal_edit("moni", status="failed", open=[], agent_request_id=None)
                    with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
                        con.execute("delete from agent_wakes")

    def test_bus_answers_prove_receipt_even_if_original_ack_was_lost(self):
        for status in ("pending", "done", "done_late"):
            with self.subTest(status=status):
                self.remote()
                if not self.calls("agent-ask"):
                    self.send(ok=False, FAKE_BUS_FAIL="1", FAKE_BUS_QUEUED="1")
                self.journal_edit("moni", status="failed")
                with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
                    con.execute("update agent_requests set status=?", (status,))
                self.assertIn("relayed via Moni's box", self.send().stdout)
                self.assertEqual(len(self.calls("agent-ask")), 1)

    def test_queued_wake_lost_ack_replay_keeps_one_bus_request_and_downstream_send(self):
        self.remote()
        self.send(ok=False, FAKE_BUS_FAIL="1", FAKE_BUS_QUEUED="1")
        first, = self.calls("agent-ask")
        key = first[first.index("--key") + 1]
        text = json.loads(first[first.index("--text") + 1].split("\n")[-1])
        self.assertEqual(text, self.share_log()["recipients"]["moni"]["payload"]["text"])
        # Moni's assistant sends before the owner's ask ack arrives. A downstream
        # retry must preserve the same key even if that send's reply was lost too.
        remote_state = os.path.join(self.dir, "moni-box")
        os.makedirs(os.path.join(remote_state, "chats"))
        remote_db = os.path.join(remote_state, "state.sqlite")
        with sqlite3.connect(remote_db) as con:
            con.execute("create table kv (key text primary key, value text not null)")
            con.execute("create table outbox (id text primary key, payload text not null, state text, attempts integer)")
            con.execute("insert into kv values ('route', ?)", (json.dumps({"id": "moni-thread", "generation": 1}),))
        remote_env = dict(self.env, RIDE_CARD_BRIDGE_STATE=remote_state,
                          FAKE_BRIDGE_LOG=os.path.join(remote_state, "calls.jsonl"))
        args = [self.bridge, "send", "--text=" + text, "--session", "moni-thread@1", "--key", key]
        sent = json.loads(subprocess.run(args, env=remote_env, capture_output=True, text=True, check=True).stdout)
        self.assertTrue(sent["created"])
        self.assertIn("relayed via Moni's box", self.send().stdout)
        self.assertEqual(self.calls("agent-ask"), [first, first])
        retry = json.loads(subprocess.run(args, env=remote_env, capture_output=True, text=True, check=True).stdout)
        self.assertEqual(retry, {"id": sent["id"], "created": False})
        with sqlite3.connect(remote_db) as con:
            self.assertEqual(con.execute("select count(*) from outbox").fetchone()[0], 1)
        with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
            self.assertEqual(con.execute("select count(*) from agent_requests").fetchone()[0], 1)
            self.assertEqual(con.execute("select count(*) from agent_wakes").fetchone()[0], 1)

    def test_bad_bus_ack_is_not_success(self):
        self.remote()
        p = self.send(ok=False, FAKE_BUS_BAD_ACK="1")
        self.assertIn("bad ack", p.stdout)
        self.assertEqual(self.share_log()["recipients"]["moni"]["status"], "failed")

    def test_ambiguous_bus_status_never_claims_delivery_or_resends(self):
        for status in ("declined", "timed_out", "unknown"):
            with self.subTest(status=status):
                self.remote()
                if not self.calls("agent-ask"):
                    self.send()
                with sqlite3.connect(os.path.join(self.bstate, "state.sqlite")) as con:
                    con.execute("update agent_requests set status=?", (status,))
                p = self.send(ok=False)
                self.assertIn("may have reached", p.stdout)
                self.assertEqual(len(self.calls("agent-ask")), 1)


class SendTest(Base):
    def test_send_publishes_and_shares_once_with_stable_keys(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["publish", "app", "share", "send"])
        app = calls[1]
        self.assertIn(f"uber:{A}:card:abdullah", app)
        self.assertEqual(app[app.index("--to") + 1], "owner", "the owner's card rides --to, which no rotation cancels")
        self.assertEqual(app[app.index("--caption") + 1], "Your ride")
        moni = calls[3]
        self.assertEqual(moni[moni.index("--to") + 1], "moni")
        self.assertIn(f"uber:{A}:card:moni", moni)
        self.assertIn("trycloudflare.com", moni[moni.index("--text") + 1])
        self.assertNotIn("ts.net", " ".join(moni))
        self.route("abdullah", "thread-1", 4)  # the owner route moved on; the old marker is stale now
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("not the live session", p.stderr)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@4")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent", "moni": "already sent"})
        self.assertEqual(len(self.bridge_calls()), 4)

    def test_retry_after_failure_reuses_frozen_payload_and_key(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app")
        self.assertEqual(p.returncode, 1)
        first = [c for c in self.bridge_calls() if c[0] == "app"][0]
        self.set_state(trip(A, "OnTrip"), {})
        self.card_cli("refresh", "--trip", A)
        self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        apps = [c for c in self.bridge_calls() if c[0] == "app"]
        self.assertEqual(len(apps), 2)
        self.assertEqual(apps[0], apps[1], "retry must send the identical payload under the same key")
        self.assertEqual([c[0] for c in self.bridge_calls()].count("publish"), 1)
        self.assertNotIn("?v=", json.dumps(apps))

    def test_card_mode_for_moni_uses_app_to(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--moni-mode", "card")
        moni = [c for c in self.bridge_calls() if c[0] == "app" and c[c.index("--to") + 1] == "moni"][0]
        self.assertEqual(moni[moni.index("--caption") + 1], "Abdullah's ride")
        self.assertTrue(moni[moni.index("--url") + 1].startswith("https://x.trycloudflare.com/"))

    def test_from_moni_chat_only_sends_to_moni(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "moni")
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"])
        self.assertNotIn("--to", calls[1])

    def tree(self):
        snap = {}
        for top in (self.cards, self.journal):
            for d, _, files in os.walk(top):
                for f in files:
                    path = os.path.join(d, f)
                    with open(path, "rb") as fh:
                        snap[path] = (fh.read(), os.stat(path).st_mtime_ns)
        return snap

    def test_group_from_owner_session_gets_one_public_link_and_joins_the_ride(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"], "a group gets a link, never an app card")
        send = calls[1]
        self.assertEqual(send[send.index("--to") + 1], "group-run_club")
        self.assertEqual(send[send.index("--session") + 1], "thread-1@3")
        self.assertIn(f"uber:{A}:card:group-run_club", send)
        self.assertIn("trycloudflare.com", send[send.index("--text") + 1])
        self.assertTrue(send[send.index("--text") + 1].startswith("Abdullah's ride"))
        meta = json.loads(self.card_cli("show", "--trip", A).stdout)
        self.assertEqual(meta["recipients"], ["abdullah", "moni", "group-run_club"])
        # A later full send skips the group and still reaches the others once.
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent", "moni": "sent", "group-run_club": "already sent"})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})
        self.assertEqual(len([c for c in self.bridge_calls() if c[0] == "send" and "group-run_club" in c]), 1)

    def test_group_own_session_reaches_itself_without_meta(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        calls = self.bridge_calls()
        self.assertEqual([c[0] for c in calls], ["share", "send"])
        self.assertNotIn("--to", calls[1])
        self.assertIn(f"uber:{A}:card:group-run_club", calls[1])
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_stale_session_refused_before_anything_is_written(self):
        self.set_state(trip(A, "Accepted"), {})
        self.route("group-run_club", "group-thread-2", 1)  # the group moved to a new thread overnight
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("not the live session of any chat", p.stderr)
        self.assertIn("--chat SLUG", p.stderr)
        self.assertEqual(self.bridge_calls(), [])
        self.assertIsNone(self.share_log())
        # The owner thread, which every watcher wake lands in, sends with its current session.
        p = self.card_cli("send", "--trip", A, "--session", "thread-1", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})

    def test_non_owner_session_cannot_name_another_chat(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--chat", "group-run_club", ok=False)
        self.assertIn("only the owner's chat can send to other chats", p.stderr)
        p = self.card_cli("send", "--trip", A, "--session", "moni-thread@1", "--from-chat", "group-run_club", ok=False)
        self.assertIn("this session is in chat 'moni'", p.stderr)
        self.assertEqual(self.bridge_calls(), [])
        self.assertIsNone(self.share_log())

    def test_unknown_chat_refused(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-nobody", ok=False)
        self.assertIn("no bridge chat 'group-nobody'", p.stderr)
        self.assertEqual(self.bridge_calls(), [])

    def test_dry_run_writes_nothing_and_shows_routes(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", "--dry-run")
        out = json.loads(p.stdout)
        self.assertEqual(out["group-run_club"], "would publish+send link --to group-run_club")
        self.assertIn("no card yet", out["note"])
        self.assertEqual(self.bridge_calls(), [])
        # No card yet: nothing is built, locked or read from Uber.
        self.assertFalse(os.path.exists(self.cards))
        self.assertFalse(os.path.exists(self.journal))
        self.assertFalse(os.path.exists(self.fixture + ".calls"))
        self.mark_sent(A)
        before = self.share_log()
        end = ("import sys, time; sys.path.insert(0, sys.argv[1]); import ride_card as rc; "
               "rc.write_card(rc.to_terminal(rc.load_card(sys.argv[2]), 'COMPLETED', time.time()), force=True)")
        subprocess.run([sys.executable, "-c", end, os.path.dirname(CARD), A], env=self.env, check=True, timeout=60)
        self.assertTrue(self.card(A)["terminal"])
        before = self.tree()
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", "--dry-run")
        out = json.loads(p.stdout)
        self.assertIn("a real send would be refused", out["note"])
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--dry-run")
        self.assertEqual(json.loads(p.stdout)["abdullah"], "already sent")
        self.assertEqual(self.tree(), before, "a dry run leaves the card and the journal byte for byte")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("already ended", p.stderr)

    def sends(self):
        return [c for c in self.bridge_calls() if c[0] in ("send", "app")]

    def test_accepted_but_unacked_send_is_not_resent_by_any_route(self):
        # The group's own session queues the link, the reply is lost, then the group's route rotates
        # (its own retry now gets 409). The owner retrying over --to must not post a second link.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.assertEqual(p.returncode, 1)
        self.set_op("group-run_club", "sent", attempts=1)
        self.route("group-run_club", "group-thread-2", 1)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already queued (bridge: sent)"})
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.share_log()["recipients"]["group-run_club"]["status"], "sent")

    def test_attempt_is_on_disk_before_the_bridge_call(self):
        self.set_state(trip(A, "Accepted"), {})
        peek = os.path.join(self.journal, f"{A}.json")
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", FAKE_BRIDGE_PEEK=peek)
        with open(peek + ".seen") as f:
            seen = json.loads(f.read().strip())["recipients"]["group-run_club"]
        self.assertEqual((seen["status"], seen["via"], seen["attempts"]), ("attempting", "self", 1))
        self.assertEqual(seen["keys"], [f"uber:{A}:card:group-run_club"])

    def test_queued_op_after_a_cut_process_counts_as_sent(self):
        # Killed between the bridge accepting the op and the journal update: the next run reads the outbox.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False,
                      FAKE_BRIDGE_FAIL="send", FAKE_BRIDGE_QUEUED="pending")
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already queued (bridge: pending)"})
        self.assertEqual(len(self.sends()), 1)

    def test_maybe_delivered_op_is_never_resent(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending")
        for state, attempts in (("uncertain", 1), ("cancelled", 1)):
            self.set_op("group-run_club", state, attempts=attempts)
            p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
            self.assertEqual(p.returncode, 1)
            self.assertIn("may have reached group-run_club", p.stdout)
        self.assertEqual(len(self.sends()), 1)

    def test_rotation_before_any_attempt_retries_under_a_fresh_key(self):
        # The group's session-bound op was cancelled by a rotation before the bridge tried it:
        # nothing went out, and the same key would be a silent no-op, so the retry gets a new one.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending")
        self.route("group-run_club", "group-thread-2", 1)
        p = self.card_cli("send", "--trip", A, "--session", "group-thread-2@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], f"uber:{A}:card:group-run_club")
        self.assertEqual(second[second.index("--key") + 1], f"uber:{A}:card:group-run_club:2")
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        r = self.share_log()["recipients"]["group-run_club"]
        self.assertEqual(r["keys"], [f"uber:{A}:card:group-run_club", f"uber:{A}:card:group-run_club:2"])
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_refused_attempt_can_switch_route(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 409)"}')
        self.assertEqual(p.returncode, 1)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], second[second.index("--key") + 1])
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        self.assertEqual(second[second.index("--to") + 1], "group-run_club")
        self.assertEqual(len(self.outbox("group-run_club")), 1)

    def test_owner_card_survives_owner_route_rotation(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app",
                      FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.route("abdullah", "thread-1", 4)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@4")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already queued (bridge: pending)", "moni": "already sent"})
        self.assertEqual([c[0] for c in self.sends()], ["app", "send"])

    def test_unreadable_outbox_after_an_attempt_refuses(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send")
        os.unlink(os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite"))
        self.route("group-run_club", "group-thread", 1)
        con = sqlite3.connect(os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite"))
        con.execute("drop table outbox")
        con.commit()
        con.close()
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False)
        self.assertIn("can't read the bridge outbox", p.stdout)
        self.assertEqual(len(self.sends()), 1)

    def test_outbox_reads_ops_and_route_in_one_snapshot(self):
        # The bridge sends the op and rotates the route between two reads: a pending self op read
        # against the new route would look cancelled-before-send, and the retry would post twice.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_QUEUED="pending", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        rc, db = self.rc(), os.path.join(self.bstate, "chats", "group-run_club", "state.sqlite")
        real = rc.sqlite3.connect

        class Racing:
            def __init__(self, con):
                self.con = con

            def execute(self, *a):
                cur = self.con.execute(*a)
                rows = cur.fetchall()
                w = real(db)  # the bridge moves on right after the first statement
                w.execute("update outbox set state = 'sent', attempts = 1")
                w.execute("update kv set value = ? where key = 'route'",
                          (json.dumps({"id": "group-thread-2", "generation": 1}),))
                w.commit()
                w.close()
                return Fixed(rows)

            def close(self):
                self.con.close()

        class Fixed:
            def __init__(self, rows):
                self.rows = rows

            def fetchall(self):
                return self.rows

            def fetchone(self):
                return self.rows[0] if self.rows else None

        env = {"RIDE_CARD_BRIDGE_STATE": self.bstate, "RIDE_CARD_JOURNAL": self.journal}
        with unittest.mock.patch.dict(os.environ, env), \
                unittest.mock.patch.object(rc.sqlite3, "connect", lambda *a, **k: Racing(real(*a, **k))):
            with open(os.path.join(self.journal, f"{A}.json")) as f:
                r = json.load(f)["recipients"]["group-run_club"]
            outcome, _ = rc.standing(A, "group-run_club", r, "to")
            self.assertEqual(outcome, ("sent", "already queued (bridge: pending)"))

    def test_failed_owner_card_waits_while_the_telegram_fallback_may_send_it(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False, FAKE_BRIDGE_FAIL="app",
                      FAKE_BRIDGE_QUEUED="failed", FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        (oid,) = [o for o in self.ops("abdullah") if o.startswith("app:")]
        self.kv("abdullah", f"firstAttempt:{oid}", int(time.time() * 1000) - 60_000)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("may have reached abdullah (bridge: failed)", p.stdout)
        # Past the bridge's 24h window, an unmarked fallback still proves nothing.
        self.kv("abdullah", f"firstAttempt:{oid}", int(time.time() * 1000) - 25 * 3600 * 1000)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertIn("may have reached abdullah (bridge: failed)", p.stdout)
        self.kv("abdullah", f"fallback:{oid}", {"skipped": 1})  # the fallback gave up on it
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3")
        self.assertEqual(json.loads(p.stdout)["abdullah"], "sent")
        first, second = [c for c in self.sends() if c[0] == "app"]
        self.assertEqual(second[second.index("--key") + 1], f"uber:{A}:card:abdullah:2")

    def test_cut_attempt_with_no_op_is_only_retried_the_same_way(self):
        # The group's own request died without a reply and left nothing in the outbox yet; it can
        # still land, so the owner's --to route (another op id) must not race it.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.assertEqual(len(self.sends()), 1)
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--key") + 1], second[second.index("--key") + 1])
        self.assertNotIn("--to", second)
        self.assertEqual(len(self.outbox("group-run_club")), 1)

    def test_cut_attempt_settles_only_when_its_route_moves_on(self):
        # Time alone proves nothing: a held request can still be queued long after the CLI gave up.
        # Once the chat's live route has another session, the bridge refuses that old request.
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.journal_edit("group-run_club", attempted_at="2026-01-01T00:00:00Z")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.route("group-run_club", "group-thread", 2)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        self.assertEqual(self.sends()[-1][self.sends()[-1].index("--to") + 1], "group-run_club")
        self.assertEqual(len(self.sends()), 2)

    def test_later_refusal_keeps_an_earlier_unanswered_attempt_open(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                      FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", ok=False, FAKE_BRIDGE_FAIL="send",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 503): Bridge is not ready"}')
        self.assertIn("503", p.stdout)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("may still land", p.stdout)
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(len(self.share_log()["recipients"]["group-run_club"]["open"]), 1)

    def test_owner_route_fallback_reconciles_the_owner_chats_own_queue(self):
        # An older bridge refuses `--to owner`. The owner's own route already holds a dead op under
        # this key (cancelled by a rotation), and re-sending it would only get created:false.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", ok=False,
                          FAKE_BRIDGE_FAIL="app", FAKE_BRIDGE_ERR='{"error":"Bridge request failed (HTTP 503)"}')
        key = f"uber:{A}:card:abdullah"
        rc = self.rc()
        con = sqlite3.connect(os.path.join(self.bstate, "state.sqlite"))
        con.execute("insert into outbox values (?, ?, 'cancelled', 0)",
                    (rc.op_ids("abdullah", "card", key)["self"], json.dumps({"sessionId": "thread-1", "generation": 2})))
        con.commit()
        con.close()
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent"})
        last = [c for c in self.sends() if c[0] == "app"][-1]
        self.assertNotIn("--to", last)
        self.assertEqual(last[last.index("--key") + 1], key + ":2")

    def test_ack_for_an_op_the_bridge_already_dropped_is_not_a_send(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False,
                          FAKE_BRIDGE_FAIL="send", FAKE_BRIDGE_QUEUED="failed",
                          FAKE_BRIDGE_ERR='{"error":"Bridge request timed out"}')
        self.journal_edit("group-run_club", keys=[], key=None, open=[], attempts=0)  # the journal lost it
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club", ok=False)
        self.assertIn("already had this card", p.stdout)
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        last = self.sends()[-1]
        self.assertEqual(last[last.index("--key") + 1], f"uber:{A}:card:group-run_club:2")

    def test_queued_card_the_bridge_drops_counts_as_missing_again(self):
        # Accepted (pending), then a route rotation cancels it before any attempt: not sent after all.
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "group-thread@1", FAKE_BRIDGE_ACK_STATE="pending")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        rc = self.rc()
        env = {"RIDE_CARD_BRIDGE_STATE": self.bstate, "RIDE_CARD_JOURNAL": self.journal}
        with unittest.mock.patch.dict(os.environ, env):
            self.assertEqual(rc.sent_to(A), {"group-run_club"})
            self.set_op("group-run_club", "cancelled", attempts=0)
            self.assertEqual(rc.sent_to(A), set())
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "sent"})
        first, second = self.sends()
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        self.assertEqual(second[second.index("--to") + 1], "group-run_club")
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "group-run_club")
        self.assertEqual(json.loads(p.stdout), {"group-run_club": "already sent"})

    def test_owner_card_falls_back_to_its_own_route_on_an_older_bridge(self):
        self.set_state(trip(A, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "sent"})
        refused, sent = [c for c in self.bridge_calls() if c[0] == "app"]
        self.assertEqual(refused[refused.index("--to") + 1], "owner")
        self.assertNotIn("--to", sent)
        self.assertEqual(refused[refused.index("--key") + 1], sent[sent.index("--key") + 1])
        self.assertEqual(len(self.outbox("abdullah")), 1)
        r = self.share_log()["recipients"]["abdullah"]
        self.assertEqual((r["via"], r["no_to"]), ("self", True))
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", "--chat", "abdullah", FAKE_BRIDGE_NO_TO="1")
        self.assertEqual(json.loads(p.stdout), {"abdullah": "already sent"})

    def test_send_refuses_mismatched_trip(self):
        self.set_state(trip(B, "Accepted"), {})
        p = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.bridge_calls(), [])

    def test_send_rejects_uuid_prefix(self):
        p = self.card_cli("send", "--trip", A[:8], "--session", "thread-1@3", ok=False)
        self.assertIn("exact trip UUID", p.stderr)

    def test_caption_has_no_time_words(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card as rc
        c = {"rider": "abdullah", "dropoff": "Today Cafe 12:30 Tower"}
        p = rc.payload_for(c, "moni", "https://x/", "card")
        for s in (p["caption"], p["subcaption"], p["summary"]):
            self.assertNotRegex(s, r"(?i)\b(today|\d{1,2}:\d{2})")
        self.assertEqual(rc.payload_for({"rider": "moni", "dropoff": "Sunset Mall"}, "abdullah", "https://x/", "card")["caption"], "Moni's ride")
        for place in ("Sunset Mall", "Satwa", "Monaco Tower", "Thunder Bowl", "Friends Avenue"):
            p = rc.payload_for({"rider": "moni", "dropoff": place}, "abdullah", "https://x/", "card")
            self.assertEqual(p["subcaption"], f"To {place}")
        self.assertEqual(rc.payload_for({"rider": "moni", "dropoff": "x"}, "moni", "https://x/", "card")["caption"], "Your ride")

    def test_explicit_moni_card_mode_refused_without_bridge_support(self):
        self.set_state(trip(A, "Accepted"), {})
        env = {k: v for k, v in self.env.items()}
        p = subprocess.run([sys.executable, "-c", f"""
import sys, json; sys.path.insert(0, {os.path.dirname(CARD)!r})
import ride_card as rc
rc.bridge_app_to = lambda: False
res, failed = rc.send({A!r}, "thread-1@3", modes={{"moni": "card"}})
print(json.dumps(res))
"""], capture_output=True, text=True, env=env, timeout=60)
        res = json.loads(p.stdout.strip().splitlines()[-1])
        self.assertEqual(res["abdullah"], "sent")
        self.assertIn("app --to", res["moni"])
        self.assertFalse(any(c[0] == "app" and c[c.index("--to") + 1] == "moni" for c in self.bridge_calls()))
        with open(os.path.join(self.journal, f"{A}.json")) as f:
            self.assertNotIn("payload", json.load(f)["recipients"]["moni"])

    def test_og_text_carries_state_without_times(self):
        sys.path.insert(0, os.path.dirname(CARD))
        import ride_card as rc
        for name, c in rc.sample_states():
            t = rc.texts(c)
            self.assertNotRegex(t["og_title"] + t["og_desc"], r"\d{1,2}:\d{2}", name)
            self.assertLessEqual(len(t["og_title"]), 40)


if __name__ == "__main__":
    unittest.main()


class RenderLogTest(unittest.TestCase):
    def test_render_success_failure_and_logger_failure_do_not_change_result(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ride_log_test', CARD)
        rc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rc)
        for ok in (True, False):
            with unittest.mock.patch.object(rc, '_render_preview', return_value=ok), unittest.mock.patch.object(rc, 'log_render') as log:
                self.assertEqual(rc.render_preview({}, None), ok)
                self.assertEqual(log.call_args.args[1], ok)
        with unittest.mock.patch.object(rc.subprocess, 'Popen') as child, unittest.mock.patch.object(rc.threading, 'Thread'):
            rc.log_render(time.monotonic(), False)
            self.assertEqual(child.call_args.args[0][2:5], ['log-card-render', '--kind', 'ride'])
        with unittest.mock.patch.object(rc.subprocess, 'Popen', side_effect=OSError('unavailable')):
            rc.log_render(time.monotonic(), True)


    def test_render_chat_aliases_use_bridge_slugs_and_private_values_are_reduced(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ride_log_alias_test', CARD)
        rc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rc)
        # All accepted owner input forms must survive person -> metadata -> log reduction.
        cases = [('owner', 'owner'), ('abdullah', 'owner'), ('me', 'owner'), (' OWNER ', 'owner'),
                 ('moni', 'moni'), ('MONI', 'moni'), ('friend', 'other')]
        for value, expected in cases:
            with self.subTest(value=value), unittest.mock.patch.object(rc, '_render_preview', return_value=False), \
                    unittest.mock.patch.object(rc.subprocess, 'Popen') as child, unittest.mock.patch.object(rc.threading, 'Thread'):
                self.assertFalse(rc.render_preview({'rider': rc.person(value)}, None))
                command = child.call_args.args[0]
                self.assertEqual(command[command.index('--chat') + 1], expected)
                self.assertEqual(command[command.index('--failure-code') + 1], 'preview_missing')
        private = '+971501234567 /Users/private/PRIVATE https://private/?token=PRIVATE'
        with unittest.mock.patch.object(rc.subprocess, 'Popen') as child, unittest.mock.patch.object(rc.threading, 'Thread'):
            rc.log_render(time.monotonic(), False, chat=private, failure_code=private)
            self.assertNotIn('PRIVATE', str(child.call_args))
            self.assertNotIn('971501234567', str(child.call_args))


class BridgeListDeadlineTest(Base):
    def rows(self):
        from pathlib import Path
        return [helper_log.expand_helper(json.loads(line)) for p in Path(self.env["TOOLLOG_DIR"]).glob("*.ndjson")
                for line in p.read_text().splitlines()]

    def setUp(self):
        super().setUp()
        self.env["TOOLLOG_DIR"] = os.path.join(self.dir, "logs")
        # Health fixtures can cache their different toollog module before ride_card imports it.
        logger = unittest.mock.patch.multiple(self.rc(), tool_log=helper_log.tool_log,
                                            stderr_cause=helper_log.stderr_cause)
        logger.start()
        self.addCleanup(logger.stop)

    def test_shares_survives_old_deadline_and_keeps_permanent_links(self):
        rc = self.rc()
        def slow_list(*args, **kwargs):
            if kwargs["timeout"] < 12:
                raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
            return subprocess.CompletedProcess(args[0], 0, json.dumps({"shares": [
                {"app": "keep", "permanent": True}, {"app": "retire", "permanent": False}]}), "")
        with unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc.subprocess, "run", side_effect=slow_list):
            self.assertEqual(rc.permanent_apps(), {"keep"})

    def test_retries_only_list_timeouts_once(self):
        rc = self.rc()
        cases = [
            (subprocess.TimeoutExpired(["PRIVATE"], 20, stderr=b"PRIVATE"), True),
            (subprocess.CompletedProcess([], 1, "", '{"error":"Bridge request timed out"}'), True),
            (subprocess.CompletedProcess([], 1, "", '{"error":"Bridge request failed (HTTP 403)"}'), False),
            (FileNotFoundError(2, "No such file or directory", "PRIVATE"), False),
            (subprocess.CompletedProcess([], 0, '{"shares":null}', ""), False),
        ]
        good = subprocess.CompletedProcess([], 0, '{"shares":[]}', "")
        for first, retry in cases:
            with self.subTest(first=type(first).__name__, retry=retry), unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc.subprocess, "run", side_effect=[first, good]) as run:
                self.assertEqual(rc.permanent_apps(), set() if retry else None)
                self.assertEqual(run.call_count, 2 if retry else 1)
        with unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 20)) as run:
            self.assertIsNone(rc.permanent_apps())
            self.assertEqual(run.call_count, 2)
        for command in ("app", "send", "share", "unshare"):
            with self.subTest(command=command), unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc.subprocess, "run", side_effect=subprocess.TimeoutExpired([], 20)) as run:
                with self.assertRaises(subprocess.TimeoutExpired):
                    rc.bridge(command)
                self.assertEqual(run.call_count, 1)

    def test_error_fields_distinguish_process_and_http_deadlines(self):
        rc = self.rc()
        cases = [
            (subprocess.TimeoutExpired(["PRIVATE"], 20, stderr=b"PRIVATE"), "cli_process", True, "timeout"),
            (subprocess.CompletedProcess([], 1, "", '{"error":"Bridge request timed out"}'), "http", True, "timeout"),
            (subprocess.CompletedProcess([], 1, "", "PRIVATE Permission denied"), "none", False, "permission"),
            (FileNotFoundError(2, "No such file or directory", "PRIVATE"), "none", False, "missing_file"),
        ]
        for result, side, timed_out, cause in cases:
            with self.subTest(side=side, cause=cause), unittest.mock.patch.dict(os.environ, self.env), unittest.mock.patch.object(rc.subprocess, "run", side_effect=[result]), unittest.mock.patch.object(rc.time, "perf_counter", side_effect=[1, 1.25]):
                with self.assertRaises(Exception):
                    rc.bridge("shares", timeout=20, attempt=2)
                row = self.rows()[-1]
                self.assertEqual(row["durationMs"], 250)
                self.assertEqual(row["props"]["timeoutMs"], 20000)
                self.assertEqual(row["props"]["attempt"], 2)
                self.assertEqual(row["props"]["timeoutSide"], side)
                self.assertEqual(row["props"]["timedOut"], timed_out)
                self.assertEqual(row["props"]["stderrClass"], cause)
                self.assertNotIn("PRIVATE", json.dumps(row))

    def test_ended_ride_failure_has_safe_classification(self):
        self.set_state(trip(A, "Accepted"), {})
        self.card_cli("refresh", "--trip", A)
        with unittest.mock.patch.dict(os.environ, self.env):
            card = self.rc().load_card(A)
            self.rc().write_card(dict(card, terminal=True, state="done"))
        result = self.card_cli("send", "--trip", A, "--session", "thread-1@3", ok=False)
        self.assertEqual(result.returncode, 1)
        row = next(r for r in self.rows() if r["name"] == "helper.run" and not r["ok"])
        self.assertEqual(row["props"]["stderrClass"], "ride_ended")
        self.assertNotIn(A, json.dumps(row))


    def test_cleanup_budget_leaves_time_to_save_and_emit_alerts(self):
        import contextlib
        import importlib.util
        import io
        from pathlib import Path
        rc = self.rc()
        for prior_work in (0, 12, 49, 55):
            with self.subTest(prior_work=prior_work), unittest.mock.patch.dict(os.environ, dict(self.env, WATCH_RUN="")):
                spec = importlib.util.spec_from_file_location("ride_cleanup_budget", HELPER)
                checker = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(checker)
                clock, shares, unshares = [0], [], []
                paths = [Path(self.journal) / (u + ".json") for u in (A, B, "cccccccc-0000-4000-8000-000000000003")]
                state = {"trips": {}, "active": None, "fail_since": None, "ending": {},
                         "pending_cancel": {A: {"since": 0, "rider": "abdullah"}}, "preview_retry": {}}
                def status():
                    clock[0] += prior_work
                    return {"ok": True, "result": {"trip": None}}
                def bridge_run(args, **kwargs):
                    command, timeout = args[-1], kwargs["timeout"]
                    if command == "shares":
                        shares.append(timeout)
                        elapsed = 20 if len(shares) == 1 else 19
                        out = '{"shares":[]}'
                    else:
                        self.assertIn("unshare", args)
                        unshares.append(timeout)
                        elapsed, out = 9, '{"removed":true}'
                    clock[0] += min(elapsed, timeout)
                    if timeout <= elapsed:
                        raise subprocess.TimeoutExpired(args, timeout)
                    return subprocess.CompletedProcess(args, 0, out, "")
                output = io.StringIO()
                with unittest.mock.patch.object(checker, "load", return_value=state), unittest.mock.patch.object(checker, "now_ts", return_value=5000), unittest.mock.patch.object(checker, "rides_status", side_effect=status), unittest.mock.patch.object(rc.time, "monotonic", side_effect=lambda: clock[0]), unittest.mock.patch.object(Path, "glob", return_value=paths), unittest.mock.patch.object(rc, "public_link", return_value=True), unittest.mock.patch.object(rc, "load_card", return_value={"terminal": True, "state": "done", "ended_at": rc.iso(0)}), unittest.mock.patch.object(rc, "unshared_path", side_effect=lambda u: Path(self.journal) / (".budget-" + str(prior_work) + "-" + u)), unittest.mock.patch.object(rc.subprocess, "run", side_effect=bridge_run), contextlib.redirect_stdout(output):
                    checker.main()
                self.assertLessEqual(clock[0], max(50, prior_work))
                self.assertEqual(shares, {0: [20, 20], 12: [20, 18], 49: [1], 55: []}[prior_work])
                self.assertEqual(unshares, [10, 2] if prior_work == 0 else [])
                self.assertIn("CANCELED", output.getvalue())
                with open(self.state) as saved:
                    self.assertEqual(json.load(saved)["pending_cancel"], {})
