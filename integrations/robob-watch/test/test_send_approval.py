"""send-approval against fake bridge stores, a fake Robob state db, the real bridge formatter (bun), a scripted
judge and scripted Sendblue statuses. No network."""
import json
import os
import sqlite3
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "helpers", "send-approval")
FORMATTER = os.path.join(HERE, "..", "..", "spectrum-bridge", "src", "formatting.ts")
BUN = os.environ.get("BUN") or os.path.expanduser("~/.bun/bin/bun")
DRAFTED = (int(time.time() * 1000) - 3600_000) // 1000
TOK = chr(64) + "4" + chr(64)  # a DCP boundary id; the bridge drops it when it stands alone
OWNER = "+971585134795"
MONI = "+971585933213"
TEXT = "Hallo Thomas, kannst du die Buchung bitte stornieren?"
PREVIEW = "WhatsApp to OnAir (+4916091958774):\n" + TEXT + "\n(draft 3a9bbbf545)"
NOW = int(time.time() * 1000)


# Sendblue's view of each handle h-<outbox id>-<n>: by default DELIVERED over iMessage a second after the row's
# sent-at, with the text the bridge sends for bubble n (its own formatter) or the file bubble after the text.
# FAKE_STATUS json {handle: {field: value}} overrides fields (status, service, date_updated, content, ...).
FAKE_DELIVERY = """import glob, json, os, sqlite3, subprocess, sys, time
hs = json.load(sys.stdin)
m = json.load(open(os.environ["FAKE_STATUS"])) if os.path.exists(os.environ["FAKE_STATUS"]) else {}
root = os.environ["SEND_APPROVAL_BRIDGE_DIR"]
rows = {}
for db in [os.path.join(root, "state.sqlite")] + glob.glob(os.path.join(root, "chats", "*", "state.sqlite")):
    con = sqlite3.connect(db)
    for oid, payload in con.execute("select id, payload from outbox"):
        at = con.execute("select value from kv where key = ?", ("sent-at:" + oid,)).fetchone()
        rows[oid] = (json.loads(payload).get("text") or "", int(at[0]) if at else 0)
js = ("const m = await import(process.argv.at(-1)); const xs = JSON.parse(await Bun.stdin.text());"
      "console.log(JSON.stringify(xs.map(x => m.splitFormatted(m.formatText(x.trim() ? x : ''), m.BUBBLE_CHARS)"
      ".map(c => c.text))))")
texts = sorted({rows[h.rsplit("-", 1)[0][2:]][0] for h in hs if h.rsplit("-", 1)[0][2:] in rows})
out = subprocess.run([os.environ["SEND_APPROVAL_BUN"], "-e", js, os.environ["SEND_APPROVAL_FORMATTER"]],
                     input=json.dumps(texts), capture_output=True, text=True, cwd="/").stdout if texts else "[]"
chunks = dict(zip(texts, json.loads(out)))
res = {}
for h in hs:
    oid, n = h.rsplit("-", 1)[0][2:], int(h.rsplit("-", 1)[1])
    text, at = rows.get(oid, ("", 0))
    cs = chunks.get(text, [])
    v = {"is_outbound": True, "message_handle": h, "status": "DELIVERED", "service": "iMessage",
         "date_updated": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime((at + 1000) // 1000)) + ".%03dZ" % ((at + 1000) % 1000),
         "content": cs[n] if n < len(cs) else "", "media_url": "" if n < len(cs) else "https://x.test/f"}
    v.update(m.get(h, {}))
    res[h] = v
print(json.dumps(res))
"""


def fenced(text):
    return "```\n" + text + "\n```"


def iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".%03dZ" % (ms % 1000)


class Bridge:
    def __init__(self, root, chat=None):
        d = root if chat is None else os.path.join(root, "chats", chat)
        os.makedirs(d, exist_ok=True)
        self.con = sqlite3.connect(os.path.join(d, "state.sqlite"))
        self.con.executescript(
            "create table kv(key text primary key, value text not null);"
            "create table inbound(id text primary key, payload text, state text);"
            "create table outbox(id text primary key, payload text, state text, attempts integer, providerId text unique,"
            " reminderId text);")

    def shown(self, oid, text, at, state="sent", attachment=None, bubbles=None):
        p = {"id": oid, "kind": "conversation", "text": text}
        if attachment:
            p["attachment"] = attachment
        self.con.execute("insert into outbox values (?,?,?,1,?,null)", (oid, json.dumps(p), state, oid))
        self.con.execute("insert into kv values (?,?)", ("sent-at:" + oid, str(at)))
        if bubbles is None:  # a short text is one bubble, a file one more
            bubbles = (1 if text.strip() else 0) + (1 if attachment else 0)
        for n in range(bubbles):  # what delivery.ts checkpoints per bubble
            self.con.execute("insert into kv values (?,?)", ("chunk:%s:%d" % (oid, n),
                             json.dumps({"accepted": True, "providerId": "h-%s-%d" % (oid, n)})))
        self.con.commit()

    def typed(self, iid, text, at, sender=OWNER, source="typed", audio=False, received=None, attachments=None):
        p = {"id": iid, "text": text, "receivedAt": at if received is None else received, "source": source,
             "isAudioMessage": audio, "attachments": attachments or []}
        if at is not None:
            p["sentAt"] = at
        if sender is not None:
            p["sender"] = sender
        self.con.execute("insert into inbound values (?,?,'done')", (iid, json.dumps(p)))
        self.con.commit()


class SendApprovalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "bridge")
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w") as fh:
            json.dump({"owner": OWNER, "transport": "sendblue"}, fh)
        self.owner = Bridge(self.root)
        self.state_db = os.path.join(self.tmp.name, "statev2.sqlite")
        self.judge_in = os.path.join(self.tmp.name, "judge.json")
        self.judge = "cat > %s; echo 0.9" % self.judge_in
        self.log = os.path.join(self.tmp.name, "decisions.jsonl")
        self.status = os.path.join(self.tmp.name, "status.json")
        self.delivery = os.path.join(self.tmp.name, "delivery.py")
        with open(self.delivery, "w") as fh:
            fh.write(FAKE_DELIVERY)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self):
        return {"PATH": "/usr/bin:/bin", "HOME": self.tmp.name, "SEND_APPROVAL_LOG": self.log,
                "SEND_APPROVAL_FORMATTER": FORMATTER, "SEND_APPROVAL_BUN": BUN}

    def run_check(self, *args, judge=None, session=None, drafted=DRAFTED):
        env = {**self.env(), "SEND_APPROVAL_BRIDGE_DIR": self.root, "SEND_APPROVAL_STATE_DB": self.state_db,
               "SEND_APPROVAL_JUDGE": self.judge if judge is None else judge,
               "SEND_APPROVAL_DELIVERY": "/usr/bin/python3 " + self.delivery, "FAKE_STATUS": self.status}
        if session:
            env["OPENCODE_SESSION_ID"] = session
        r = subprocess.run(["/usr/bin/python3", HELPER, "check", *args, "--drafted-at", str(drafted)],
                           capture_output=True, text=True, env=env)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def run_check_raw(self, *args):
        r = subprocess.run(["/usr/bin/python3", HELPER, *args], capture_output=True, text=True, env=self.env())
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def ok(self, iid, preview=PREVIEW, **kw):
        return self.run_check("--inbound", iid, "--preview", preview, **kw)

    def statuses(self, m):
        with open(self.status, "w") as fh:
            json.dump(m, fh)

    def clear(self):
        for t in ("outbox", "kv", "inbound"):
            self.owner.con.execute("delete from " + t)
        self.owner.con.commit()

    def judged(self):
        with open(self.judge_in) as fh:
            return json.load(fh)

    # ------------------------------------------------------------ bridge

    def test_preview_then_owner_ok_is_approved_and_the_judge_sees_the_exchange(self):
        self.owner.shown("o1", "Here it is:\n\n" + PREVIEW + "\n\nOK to send?", NOW - 60_000)
        self.owner.typed("A1", "Okay send it", NOW - 30_000)
        code, out, err = self.ok("A1")
        self.assertEqual(code, 0, err)
        self.assertIn("approved: his reply A1", out)
        state = self.judged()
        self.assertEqual(state["reply"], "Okay send it")
        self.assertIn(TEXT, state["shown"])
        self.assertEqual(state["between"], [])
        with open(self.log) as fh:
            self.assertEqual(json.loads(fh.read().splitlines()[-1])["decision"], "approved")

    def test_spacing_and_one_quote_level_still_match_but_every_character_counts(self):
        self.owner.shown("o1", "> WhatsApp to OnAir (+4916091958774):\n>  Hallo Thomas,  kannst du die Buchung "
                         "bitte stornieren?\n> (draft 3a9bbbf545)", NOW - 60_000)
        self.owner.typed("A1", "yes", NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 0)
        curly = PREVIEW.replace("Hallo Thomas,", "\u201cHallo Thomas,").replace("stornieren?", "stornieren?\u201d")
        self.assertEqual(self.ok("A1", preview=curly)[0], 2)  # added quotes are a different line
        # Emphasis marks the agent added around a line are characters of the preview he didn't get as is.
        self.clear()
        self.owner.shown("o2", "**WhatsApp to OnAir (+4916091958774):**\n" + TEXT + "\n(draft 3a9bbbf545)", NOW - 60_000)
        self.owner.typed("A2", "yes", NOW - 30_000)
        self.assertEqual(self.ok("A2")[0], 2)

    def test_url_and_edge_characters_must_match_exactly(self):
        # Astra r1 B1: "invoice_" was approved after "invoice" was shown (edge marks were stripped).
        pv = "WhatsApp to Bob (+971500000001):\nPay at https://example.test/invoice_\n(draft 0123456789)"
        self.owner.shown("o1", pv.replace("invoice_", "invoice"), NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertEqual(self.ok("A1", pv, judge="exit 1")[0], 2)
        self.assertEqual(self.ok("A1", pv)[0], 2)
        for mark in ("*", "~", "`", "_"):
            self.clear()
            self.owner.shown("o2", pv.replace("invoice_", "invoice") + mark, NOW - 60_000)
            self.owner.typed("A1", "send it", NOW - 30_000)
            self.assertEqual(self.ok("A1", pv)[0], 2, mark)
        self.clear()
        self.owner.shown("o3", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertEqual(self.ok("A1", pv)[0], 0)

    def test_a_shortened_or_longer_text_is_not_the_preview(self):
        # Sol r1: "I agree only if you refund the deposit." used to approve "I agree".
        self.owner.shown("o1", "WhatsApp to Bob (+971500000001):\nI agree only if you refund the deposit.\n"
                         "(draft 0123456789)", NOW - 60_000)
        self.owner.typed("A1", "ok", NOW - 30_000)
        self.assertEqual(self.ok("A1", "WhatsApp to Bob (+971500000001):\nI agree\n(draft 0123456789)")[0], 2)
        self.assertEqual(self.ok("A1", "WhatsApp to Bob (+971500000001):\nI agree only if you refund the "
                                       "deposit.\n(draft 0123456789)")[0], 0)

    def test_changed_address_code_or_recipient_role_is_not_the_preview(self):
        mail = "Email from me@x.com (icloud)\nTo: a_b@example.com\nCc: c@example.com\nSubject: Ab_C\n%s\n(draft 1111111111)"
        self.owner.shown("o1", mail % "Code AB_C-12", NOW - 60_000)
        self.owner.typed("A1", "send", NOW - 30_000)
        self.assertEqual(self.ok("A1", mail % "Code AB_C-12")[0], 0)
        self.assertEqual(self.ok("A1", (mail % "Code AB_C-12").replace("a_b@", "ab@"))[0], 2)
        self.assertEqual(self.ok("A1", mail % "Code ABC-12")[0], 2)
        swapped = (mail % "Code AB_C-12").replace("To: a_b", "Cc: a_b").replace("Cc: c@", "To: c@")
        self.assertEqual(self.ok("A1", swapped)[0], 2)

    def test_preview_must_end_with_the_draft_line(self):
        self.assertEqual(self.ok("A1", "WhatsApp to OnAir:\n" + TEXT)[0], 2)
        self.assertIn("ending with (draft <id>)", self.ok("A1", TEXT)[2])

    def test_request_before_the_draft_is_not_an_ok(self):
        # 22 Oct 16:37: "Follow up with the host please" and the agent sent straight away.
        self.owner.typed("R1", "Follow up with the host please", NOW - 60_000)
        code, _, err = self.ok("R1")
        self.assertEqual(code, 2)
        self.assertIn("wasn't shown this draft", err)

    def test_text_shown_without_the_preview_block_is_refused(self):
        self.owner.shown("o1", "Here's a cleaner version: \u201c" + TEXT + "\u201d", NOW - 60_000)
        self.owner.typed("A1", "Okay send it", NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 2)

    def test_preview_shown_after_the_reply_does_not_count(self):
        self.owner.typed("A1", "Okay send it", NOW - 60_000)
        self.owner.shown("o1", PREVIEW, NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 2)

    def test_reply_is_ordered_by_when_he_sent_it_not_when_it_arrived(self):
        # Sol r1: a backfilled old "send it" arriving after a new preview.
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 90_000, received=NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 2)
        self.owner.typed("A2", "send it", None, received=NOW - 20_000)
        self.assertIn("no send time", self.ok("A2")[2])

    def test_preview_older_than_24h_or_not_delivered_is_ignored(self):
        self.owner.shown("o1", PREVIEW, NOW - 25 * 3600 * 1000)
        self.owner.shown("o2", PREVIEW, NOW - 60_000, state="uncertain")
        self.owner.typed("A1", "Okay send it", NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 2)

    def test_synthetic_voice_guest_and_moni_replies_are_refused(self):
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("wake:abc", "Okay send it", NOW - 30_000)
        self.owner.typed("V1", "Okay send it", NOW - 29_000, audio=True)
        self.owner.typed("C1", "Okay send it", NOW - 28_000, source="composed")
        self.owner.typed("G1", "Okay send it", NOW - 27_000, sender="+15550000000")
        group = Bridge(self.root, "group-sb_gro")
        group.shown("g0", PREVIEW, NOW - 60_000)
        group.typed("M1", "Okay send it", NOW - 26_000, sender=MONI)
        for iid in ("wake:abc", "V1", "C1", "G1", "M1", "nope"):
            self.assertEqual(self.ok(iid)[0], 2, iid)

    def admin(self, role="admin", name="Moni", routes=None):
        with open(os.path.join(self.root, "access.json"), "w") as fh:
            json.dump({"people": [{"name": name, "role": role, "addresses": ["moni@example.com", MONI]}],
                       "groups": []}, fh)
        # The bridge's saved routes (owner store kv sbChats): chat key -> chat dir.
        self.routes(routes if routes is not None else {"dm:" + MONI: "moni", "group:abc123": "group-sb_gro"})
        if not hasattr(self, "moni"):
            self.moni = Bridge(self.root, "moni")
        return self.moni

    def routes(self, m):
        self.owner.con.execute("insert or replace into kv values ('sbChats', ?)",
                               (json.dumps({k: {"slug": v} for k, v in m.items()}),))
        self.owner.con.commit()

    def test_his_word_after_her_ok_and_hers_after_his_go_to_the_judge(self):
        # Sol (moni-admin r1 B1): checking Moni's OK used to drop what he said in her chat, and the other way round.
        moni = self.admin()
        moni.shown("m0", PREVIEW, NOW - 60_000)
        moni.typed("M1", "yes send it", NOW - 30_000, sender=MONI)
        moni.typed("A9", "wait, do not send it", NOW - 20_000, sender=OWNER)
        self.assertEqual(self.ok("M1")[0], 0)  # the stub judge says yes, but it has to see his veto
        self.assertEqual(self.judged()["later"], [{"from": "Abdullah", "role": "owner", "text": "wait, do not send it"}])
        self.assertEqual(self.ok("M1", judge="exit 1")[0], 2)  # no plain-OK fallback past his message
        moni.con.execute("delete from inbound where id = 'A9'")
        moni.con.commit()
        # A photo from him after her OK can't be read: refuse.
        moni.typed("P1", "", NOW - 20_000, sender=OWNER, attachments=[{"guid": "https://x.test/p.jpg"}])
        code, _, err = self.ok("M1")
        self.assertEqual(code, 2)
        self.assertIn("Abdullah sent something after the preview", err)
        moni.con.execute("delete from inbound where id = 'P1'")
        moni.con.commit()
        # His veto typed while the judge thinks.
        db = os.path.join(self.root, "chats", "moni", "state.sqlite")
        late = json.dumps({"id": "L1", "text": "no, hold it", "sentAt": NOW, "receivedAt": NOW, "source": "typed",
                           "sender": OWNER, "attachments": []})
        slow = ("cat > %s; /usr/bin/python3 -c \"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                "c.execute('insert into inbound values (?,?,?)', ('L1', sys.argv[2], 'done')); c.commit()\" %s '%s'; "
                "echo 0.9") % (self.judge_in, db, late)
        code, _, err = self.ok("M1", judge=slow)
        self.assertEqual(code, 2)
        self.assertIn("wrote again while the OK was being checked", err)
        # And the other way round: her "hold it" after his OK in a group they share reaches the judge.
        group = Bridge(self.root, "group-sb_gro")
        group.shown("g0", PREVIEW, NOW - 60_000)
        group.typed("G1", "send it", NOW - 30_000, sender=OWNER)
        group.typed("G2", "hold it, I'll call them", NOW - 20_000, sender=MONI)
        self.assertEqual(self.ok("G1")[0], 0)
        self.assertEqual(self.judged()["later"], [{"from": "Moni", "role": "admin", "text": "hold it, I'll call them"}])

    def test_her_own_chat_comes_from_the_bridge_routes_not_her_name(self):
        # Sol (moni-admin r1 B2): the dir named like her could be a group's, and a renamed admin keeps her old dir.
        moni = self.admin(routes={"dm:" + MONI: "moni-2", "group:abc123": "moni"})
        moni.shown("m0", PREVIEW, NOW - 60_000)
        moni.typed("M1", "yes send it", NOW - 30_000, sender=MONI)
        code, _, err = self.ok("M1")  # "moni" is a group's dir here
        self.assertEqual(code, 2)
        self.assertIn("by an admin in her own chat", err)
        self.admin(routes={"dm:" + MONI: "moni", "group:abc123": "moni"})
        self.assertEqual(self.ok("M1")[0], 2)  # a dir a group also uses is nobody's own chat
        self.admin(name="Monika", routes={"dm:" + MONI: "moni"})
        self.assertEqual(self.ok("M1")[0], 0)  # renamed, still her saved route
        self.admin(routes={})
        self.assertEqual(self.ok("M1")[0], 2)  # no saved route, no own chat
        self.admin(routes={"dm:moni@example.com": "moni"})
        self.assertEqual(self.ok("M1")[0], 0)  # her other address routes there too

    def test_an_admin_named_like_him_or_the_assistant_is_still_an_admin(self):
        # Sol (moni-admin r2): the role came from the display name, so an admin called "Abdullah" could OK in any
        # chat, and one called "assistant" had a long veto clipped like the assistant's own text.
        moni = self.admin(name="Abdullah")
        group = Bridge(self.root, "group-sb_gro")
        group.shown("g0", PREVIEW, NOW - 60_000)
        group.typed("G1", "yes send it", NOW - 30_000, sender=MONI)
        self.assertEqual(self.ok("G1")[0], 2)
        self.assertEqual(self.ok("G1", judge="exit 1")[0], 2)
        self.owner.shown("o0", PREVIEW, NOW - 60_000)
        self.owner.typed("O1", "yes send it", NOW - 30_000, sender=MONI)
        self.assertEqual(self.ok("O1")[0], 2)
        moni.shown("m0", PREVIEW, NOW - 60_000)
        moni.typed("M1", "yes send it", NOW - 30_000, sender=MONI)
        self.assertEqual(self.ok("M1")[0], 0)  # her own chat still works
        moni.con.execute("delete from outbox")
        moni.con.execute("delete from kv")
        moni.con.execute("delete from inbound")
        moni.con.commit()
        self.admin(name="assistant")
        moni.shown("m1", PREVIEW, NOW - 60_000)
        moni.typed("M2", "yes send it", NOW - 30_000, sender=MONI)
        veto = "x " * 750 + "STOP: do not send this draft. " + "y " * 750
        moni.typed("M3", veto, NOW - 20_000, sender=MONI)
        picky = "cat > %s; grep -q 'STOP: do not send' %s && echo 0.1 || echo 0.9" % (self.judge_in, self.judge_in)
        self.assertEqual(self.ok("M2", judge=picky)[0], 2)
        self.assertEqual(self.judged()["later"], [{"from": "assistant", "role": "admin", "text": veto}])

    def test_odd_access_json_never_breaks_his_own_ok(self):
        # Sol (moni-admin r1 S1): {"people": 1} raised a TypeError on his own OK.
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        for bad in ({"people": 1}, {"people": [{"name": "Moni", "role": "admin", "addresses": 5}]}, [], "x"):
            with open(os.path.join(self.root, "access.json"), "w") as fh:
                json.dump(bad, fh)
            code, _, err = self.ok("A1")
            self.assertEqual(code, 0, (bad, err))

    def test_moni_as_admin_oks_in_her_own_chat_like_him(self):
        # 24 Oct, owner: "Moni is an admin, you do not need to ask me."
        moni = self.admin()
        moni.shown("m0", PREVIEW, NOW - 60_000)
        moni.typed("M1", "yes send it", NOW - 30_000, sender=MONI)
        code, out, err = self.ok("M1")
        self.assertEqual(code, 0, err)
        self.assertIn("Moni's reply M1", out)
        state = self.judged()
        self.assertEqual(state["reply"], "yes send it")
        moni.typed("M2", "wait, change the date", NOW - 20_000, sender=MONI)
        self.ok("M1")
        self.assertEqual(self.judged()["later"], [{"from": "Moni", "role": "admin", "text": "wait, change the date"}])
        with open(self.log) as fh:
            self.assertEqual(json.loads(fh.read().splitlines()[-1])["approver"], "Moni")

    def test_moni_ok_needs_admin_role_her_own_chat_typed_text_and_the_preview_there(self):
        moni = self.admin(role="person")
        moni.shown("m0", PREVIEW, NOW - 60_000)
        moni.typed("M1", "yes send it", NOW - 30_000, sender=MONI)
        self.assertEqual(self.ok("M1")[0], 2)  # not an admin
        self.admin()
        self.assertEqual(self.ok("M1")[0], 0)
        moni.typed("V1", "yes send it", NOW - 29_000, sender=MONI, audio=True)
        moni.typed("G1", "yes send it", NOW - 28_000, sender="+15550000000")
        moni.typed("wake:m", "yes send it", NOW - 27_000, sender=MONI)
        for iid in ("V1", "G1", "wake:m"):
            self.assertEqual(self.ok(iid)[0], 2, iid)
        # Her OK in a group, even with the preview there, isn't her own chat.
        group = Bridge(self.root, "group-sb_gro")
        group.shown("g0", PREVIEW, NOW - 60_000)
        group.typed("GM", "yes send it", NOW - 26_000, sender=MONI)
        self.assertEqual(self.ok("GM")[0], 2)
        # The preview has to be in her chat: shown only to him doesn't count for her reply.
        self.clear()
        self.admin()  # clear() wiped the saved routes in the owner store
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        moni.con.execute("delete from outbox")
        moni.con.execute("delete from kv")
        moni.con.commit()
        code, _, err = self.ok("M1")
        self.assertEqual(code, 2)
        self.assertIn("Moni wasn't shown this draft's preview", err)

    def test_owner_ok_in_a_group_chat_needs_the_preview_in_that_chat(self):
        group = Bridge(self.root, "group-sb_gro")
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        group.typed("G2", "Yes of course go for it", NOW - 30_000, sender=OWNER)
        self.assertEqual(self.ok("G2")[0], 2)
        group.shown("g1", PREVIEW, NOW - 45_000)
        self.assertEqual(self.ok("G2")[0], 0)

    def test_judge_says_no(self):
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "Send me a full translation", NOW - 30_000)
        code, _, err = self.ok("A1", judge="echo 0.3")
        self.assertEqual(code, 2)
        self.assertIn("doesn't read as an OK", err)

    def test_judge_gets_everything_said_after_the_preview(self):
        self.owner.shown("o1", PREVIEW, NOW - 90_000)
        self.owner.shown("o2", "Want me to make it shorter?", NOW - 80_000)
        self.owner.typed("B1", "hmm", NOW - 70_000)
        self.owner.typed("A1", "ok", NOW - 60_000)
        for i in range(5):
            self.owner.typed("L%d" % i, "unrelated %d" % i, NOW - 50_000 + i)
        tail = "x " * 1500 + "wait, do not send it"
        self.owner.typed("L9", tail, NOW - 40_000)
        self.assertEqual(self.ok("A1")[0], 0)
        state = self.judged()
        self.assertEqual([b["text"] for b in state["between"]], ["Want me to make it shorter?", "hmm"])
        self.assertEqual(len(state["later"]), 6)
        self.assertEqual(state["later"][-1], {"from": "Abdullah", "role": "owner", "text": tail})  # his words are never clipped

    def test_too_much_said_after_the_preview_is_refused_not_clipped(self):
        self.owner.shown("o1", PREVIEW, NOW - 90_000)
        self.owner.typed("A1", "ok", NOW - 80_000)
        for i in range(41):
            self.owner.typed("L%d" % i, "msg %d" % i, NOW - 70_000 + i)
        self.assertIn("too much was said", self.ok("A1")[2])
        self.owner.con.execute("delete from inbound where id like 'L%'")
        self.owner.typed("L0", "y" * 4001, NOW - 70_000)
        self.assertIn("too long", self.ok("A1")[2])

    def test_judge_down_fails_closed_except_a_plain_ok_right_after(self):
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "Yeah send it please", NOW - 30_000)
        self.owner.typed("A2", "Yeah but change the date first", NOW - 20_000)
        broken = "exit 1"
        self.assertEqual(self.ok("A1", judge=broken)[0], 2)  # A2 came later
        self.assertEqual(self.ok("A2", judge=broken)[0], 2)  # not a plain OK
        self.owner.con.execute("delete from inbound where id = 'A2'")
        self.owner.con.commit()
        code, out, _ = self.ok("A1", judge=broken)
        self.assertEqual(code, 0)
        self.assertIn("right after the preview", out)

    def test_plain_ok_fallback_refuses_numbers_and_qualifiers(self):
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        for i, reply in enumerate(("OK 3400", "ok but shorter", "send it tomorrow", "yes?", "send it to Bob")):
            self.owner.typed("R%d" % i, reply, NOW - 30_000)
            self.assertEqual(self.ok("R%d" % i, judge="exit 1")[0], 2, reply)
            self.owner.con.execute("delete from inbound")
            self.owner.con.commit()

    def test_file_needs_that_file_delivered_with_the_preview(self):
        sha = "ab" * 32
        pv = "WhatsApp to OnAir (+4916091958774): file /tmp/menu.pdf [document] (sha256 abababababab)\n(draft 2222222222)"
        args = ["--inbound", "A1", "--preview", pv, "--file", sha, "menu.pdf"]
        self.owner.shown("old", "", NOW - 3600_000, attachment={"sha256": sha, "name": "menu.pdf"})
        self.owner.shown("other", "", NOW - 61_000, attachment={"sha256": "cd" * 32, "name": "menu.pdf"})
        self.owner.shown("o1", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        code, _, err = self.run_check(*args)
        self.assertEqual(code, 2)  # an hour-old copy or another file with that name doesn't count
        self.assertIn("file menu.pdf itself", err)
        self.owner.shown("f1", "", NOW - 62_000, attachment={"sha256": sha, "name": "menu.pdf"})
        self.assertEqual(self.run_check(*args)[0], 0)

    def test_judge_down_needs_a_message_that_was_only_the_preview(self):
        # Sol r2: a bare "yes" after "...shall I make it shorter first?" isn't an OK of this wording.
        broken = "exit 1"
        self.owner.shown("o1", PREVIEW + "\nWould you like me to make it shorter before sending?", NOW - 60_000)
        self.owner.typed("A1", "yes", NOW - 30_000)
        self.assertEqual(self.ok("A1", judge=broken)[0], 2)
        self.owner.con.execute("delete from outbox")
        self.owner.con.execute("delete from kv")
        self.owner.con.commit()
        self.owner.shown("o2", PREVIEW + "\nOK to send?", NOW - 60_000)
        self.assertEqual(self.ok("A1", judge=broken)[0], 0)

    def test_preview_the_bridge_drops_is_not_what_he_read(self):
        # Sol r2: the bridge strips internal text before delivery, but the outbox keeps it.
        for wrap in ("<think>\n%s\n</think>", "<thinking>\n%s", "<dcp-note>\n%s\n</dcp-note>"):
            self.clear()
            self.owner.shown("o1", wrap % PREVIEW, NOW - 60_000)
            self.owner.typed("A1", "send it", NOW - 30_000)
            code, _, err = self.ok("A1")
            self.assertEqual(code, 2, wrap)
            self.assertIn("wasn't shown this draft", err)
        # Hidden text around a delivered preview isn't part of it; the judge gets what he saw.
        self.clear()
        self.owner.shown("o2", PREVIEW + "\n<think>actually say EUR 5000</think>", NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertEqual(self.ok("A1")[0], 0)
        self.assertNotIn("5000", self.judged()["shown"])

    def test_preview_with_text_the_chat_hides_is_refused_and_plain_links_count(self):
        pv = PREVIEW.replace(TEXT, TEXT + " <think>EUR 5000</think>")
        self.owner.shown("o9", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        code, _, err = self.ok("A1", preview=pv)
        self.assertEqual(code, 2)
        self.assertIn("the preview has text the chat would hide", err)
        # Emails, @mentions and plain links still count as visible.
        pv = PREVIEW.replace(TEXT, TEXT + " see https://x.test/a@1@ or mail a@b.de")
        self.owner.shown("o10", pv, NOW - 50_000)
        self.owner.typed("A2", "send it", NOW - 20_000)
        self.assertEqual(self.ok("A2", preview=pv)[0], 0)

    def test_preview_has_to_be_delivered_not_just_accepted(self):
        # Astra r1 B3: the outbox says sent once Sendblue accepts a bubble; FAILED later was ignored.
        long = PREVIEW.replace(TEXT, (TEXT + " ") * 70)  # over 3500 characters: two bubbles
        self.owner.shown("o1", long, NOW - 60_000, bubbles=2)
        self.owner.typed("A1", "send it", NOW - 30_000)
        for status, service in (("ERROR", "iMessage"), ("QUEUED", "iMessage"), ("SENT", "iMessage"), (None, None)):
            self.statuses({"h-o1-1": {"status": status, "service": service}})
            code, _, err = self.ok("A1", preview=long)
            self.assertEqual(code, 2, status)
            self.assertIn("isn't confirmed delivered", err)
        self.statuses({"h-o1-1": {"status": "SENT", "service": "SMS"}})  # SMS stops at SENT
        self.assertEqual(self.ok("A1", preview=long)[0], 0)
        self.statuses({})
        self.assertEqual(self.ok("A1", preview=long)[0], 0)
        self.owner.con.execute("delete from kv where key = 'chunk:o1:0'")
        self.owner.con.commit()
        self.assertIn("no record of its bubbles", self.ok("A1", preview=long)[2])

    def test_preview_delivered_after_his_reply_does_not_count(self):
        # Astra r2 B2: accepted before his reply, delivered after it. His OK was to something else.
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.statuses({"h-o1-0": {"date_updated": iso(NOW - 10_000)}})
        code, _, err = self.ok("A1", judge="exit 1")
        self.assertEqual(code, 2)
        self.assertIn("after his reply", err)
        self.statuses({"h-o1-0": {"status": "SENT", "service": "SMS", "date_updated": iso(NOW - 10_000)}})
        self.assertIn("after his reply", self.ok("A1")[2])
        self.statuses({"h-o1-0": {"date_updated": None}})
        self.assertIn("no delivery time", self.ok("A1")[2])
        self.statuses({"h-o1-0": {"date_updated": iso(NOW - 31_000)}})
        self.assertEqual(self.ok("A1", judge="exit 1")[0], 0)

    def test_file_delivered_after_his_reply_does_not_count(self):
        sha = "ab" * 32
        pv = "WhatsApp to OnAir (+4916091958774): file /tmp/menu.pdf [document] (sha256 abababababab)\n(draft 2222222222)"
        args = ["--inbound", "A1", "--preview", pv, "--file", sha, "menu.pdf"]
        self.owner.shown("f1", "", NOW - 62_000, attachment={"sha256": sha, "name": "menu.pdf"})
        self.owner.shown("o1", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.statuses({"h-f1-0": {"date_updated": iso(NOW - 5_000)}})
        self.assertIn("file menu.pdf itself", self.run_check(*args)[2])
        self.statuses({"h-f1-0": {"media_url": ""}})  # Sendblue has a message there, but no file in it
        self.assertIn("file menu.pdf itself", self.run_check(*args)[2])
        self.statuses({})
        self.assertEqual(self.run_check(*args)[0], 0)

    def test_every_bubble_needs_its_own_delivered_message_with_its_text(self):
        # Astra r2 B3: an uncertain retry the bridge matched by text alone checkpointed one handle twice.
        long = PREVIEW.replace(TEXT, (TEXT + " ") * 70)
        self.owner.shown("o1", long, NOW - 60_000, bubbles=2)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.owner.con.execute("update kv set value = ? where key = 'chunk:o1:1'",
                               (json.dumps({"accepted": True, "providerId": "h-o1-0"}),))
        self.owner.con.commit()
        self.assertIn("one Sendblue message on record for two bubbles", self.ok("A1", preview=long)[2])
        # Fewer bubbles on record than the bridge splits the text into, or a renamed one.
        self.clear()
        self.owner.shown("o1", long, NOW - 60_000, bubbles=1)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertIn("1 bubbles on record for 2", self.ok("A1", preview=long)[2])
        self.clear()
        self.owner.shown("o1", PREVIEW, NOW - 60_000, bubbles=2)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertIn("2 bubbles on record for 1", self.ok("A1")[2])
        self.clear()
        self.owner.shown("o1", PREVIEW, NOW - 60_000, bubbles=0)
        self.owner.con.execute("insert into kv values ('chunk:o1:00', ?)",
                               (json.dumps({"accepted": True, "providerId": "h-o1-0"}),))
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertIn("no record of its bubbles", self.ok("A1")[2])
        # The message Sendblue delivered has to read like the bubble the bridge sent; it only curls quotes.
        self.clear()
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.statuses({"h-o1-0": {"content": "WhatsApp to OnAir (+4916091958774):\nHallo Thomas\n(draft 3a9bbbf545)"}})
        self.assertIn("reads differently", self.ok("A1")[2])
        curly = "WhatsApp to OnAir (+4916091958774):\n" + TEXT + " \u2018ok\u2019\n(draft 3a9bbbf545)"
        pv = PREVIEW.replace(TEXT, TEXT + " 'ok'")
        self.clear()
        self.owner.shown("o1", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.statuses({"h-o1-0": {"content": curly}})
        self.assertEqual(self.ok("A1", preview=pv)[0], 0)
        self.statuses({"h-o1-0": {"is_outbound": False}})
        self.assertIn("isn't confirmed delivered", self.ok("A1", preview=pv)[2])

    def test_file_has_to_be_delivered_too(self):
        sha = "ab" * 32
        pv = "WhatsApp to OnAir (+4916091958774): file /tmp/menu.pdf [document] (sha256 abababababab)\n(draft 2222222222)"
        self.owner.shown("f1", "", NOW - 62_000, attachment={"sha256": sha, "name": "menu.pdf"})
        self.owner.shown("o1", pv, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.statuses({"h-f1-0": {"status": "ERROR", "service": "iMessage"}})
        self.assertIn("file menu.pdf itself", self.run_check("--inbound", "A1", "--preview", pv, "--file", sha,
                                                             "menu.pdf")[2])

    def test_photon_transport_cannot_confirm_delivery(self):
        with open(os.path.join(self.root, "config.json"), "w") as fh:
            json.dump({"owner": OWNER}, fh)
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertIn("delivery to him can't be confirmed", self.ok("A1")[2])

    def test_his_voice_note_after_the_ok_is_read_and_unreadable_ones_refuse(self):
        # Astra r1 B4: a voice "wait, do not send it" after a typed OK was dropped from the judge's view.
        import hashlib
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        voice = [{"guid": "https://cdn.test/v1.m4a", "fileName": "v1.m4a", "mimeType": "audio/x-m4a"}]
        self.owner.typed("V1", "", NOW - 20_000, audio=True, attachments=voice)
        code, _, err = self.ok("A1")
        self.assertEqual(code, 2)  # no transcript: can't know what he said
        self.assertIn("can't be read as text", err)
        key = "transcript:" + hashlib.sha256(b"https://cdn.test/v1.m4a").hexdigest()
        self.owner.con.execute("insert into kv values (?,?)", (key, json.dumps("Wait, do not send it")))
        self.owner.con.commit()
        self.assertEqual(self.ok("A1")[0], 0)  # the judge stub approves; what matters is what it saw
        self.assertEqual(self.judged()["later"], [{"from": "Abdullah (voice note, transcribed)",
                                                   "role": "owner", "text": "Wait, do not send it"}])
        self.assertEqual(self.ok("A1", judge="exit 1")[0], 2)  # judge down: no plain-OK shortcut with a later note
        photo = [{"guid": "https://cdn.test/p.jpg", "fileName": "p.jpg", "mimeType": "image/jpeg"}]
        self.owner.typed("P1", "", NOW - 10_000, attachments=photo)
        self.assertIn("can't be read as text", self.ok("A1")[2])

    def test_a_reply_with_an_attachment_is_not_a_plain_ok(self):
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000,
                         attachments=[{"guid": "https://cdn.test/p.jpg", "fileName": "p.jpg"}])
        self.assertIn("wasn't typed by Abdullah", self.ok("A1")[2])

    def test_preview_from_before_the_draft_or_an_old_reply_does_not_count(self):
        # Astra r1 B5: the same content redrafted later must not ride on a preview shown for the old draft.
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        self.assertIn("wasn't shown", self.ok("A1", drafted=(NOW - 45_000) // 1000)[2])
        self.assertEqual(self.ok("A1", drafted=(NOW - 90_000) // 1000)[0], 0)
        self.clear()
        self.owner.shown("o2", PREVIEW, NOW - 25 * 3600_000 - 60_000)
        self.owner.typed("A2", "send it", NOW - 25 * 3600_000)
        self.assertIn("older than 24h", self.ok("A2", drafted=(NOW - 26 * 3600_000) // 1000)[2])

    def test_his_new_message_while_the_judge_thinks_refuses(self):
        # Astra r1 B6: a "wait" typed during the judge call was never read.
        db = os.path.join(self.root, "state.sqlite")
        late = json.dumps({"id": "L1", "text": "wait, do not send it", "sentAt": NOW, "receivedAt": NOW,
                           "source": "typed", "sender": OWNER, "attachments": []})
        slow = ("cat > %s; /usr/bin/python3 -c \"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                "c.execute('insert into inbound values (?,?,?)', ('L1', sys.argv[2], 'done')); c.commit()\" %s '%s'; "
                "echo 0.9") % (self.judge_in, db, late)
        self.owner.shown("o1", PREVIEW, NOW - 60_000)
        self.owner.typed("A1", "send it", NOW - 30_000)
        code, _, err = self.ok("A1", judge=slow)
        self.assertEqual(code, 2)
        self.assertIn("wrote again while the OK was being checked", err)

    def test_judge_score_has_to_be_a_probability(self):
        # Astra r1 S2: "nan" passed the threshold check.
        self.owner.shown("o1", PREVIEW + "\nWant it shorter?", NOW - 60_000)
        self.owner.typed("A1", "Do not send it", NOW - 30_000)
        for bad in ("nan", "inf", "-1", "1.5", "yes"):
            code, _, err = self.ok("A1", judge="echo " + bad)
            self.assertEqual(code, 2, bad)
            self.assertIn("judge unavailable", err)

    def test_judge_down_fallback_works_for_a_quoted_mail_preview(self):
        # Astra r1 S1 / Sol r3 S2: a reply preview has quoted lines of its own.
        pv = ("Email from me@x.com (icloud)\nTo: host@example.com\nSubject: Re: Hi\n\nThanks!\n\n"
              "> the original line\n> 5 units requested.\n-- \nAbdullah\n(draft 1111111111)")
        self.owner.shown("o1", pv + "\nOK to send?", NOW - 60_000)
        self.owner.typed("A1", "yes send it", NOW - 30_000)
        self.assertEqual(self.ok("A1", pv, judge="exit 1")[0], 0)
        self.clear()  # the agent quoting the whole block once still counts
        self.owner.shown("o2", "\n".join("> " + x if x else ">" for x in pv.split("\n")), NOW - 60_000)
        self.owner.typed("A2", "yes send it", NOW - 30_000)
        self.assertEqual(self.ok("A2", pv, judge="exit 1")[0], 0)

    def test_visible_follows_the_bridge_formatter(self):
        # Astra r1 S3 / Sol r3 S1: code, URLs and a header phrase inside a sentence reach him intact.
        for text in ("a `%s` b" % TOK, "https://x.test/search?q=%s" % TOK, "The manual says [Compressed conversation "
                     "section] in its heading.", "5 * 3 * 2", "**bold** is fine"):
            self.assertEqual(self.run_check_raw("visible", text)[0], 0, text)
        for text in ("x %s y" % TOK, "hi <think>x</think>", "[Compressed conversation section]\nhi", "a ``` b"):
            self.assertEqual(self.run_check_raw("visible", text)[0], 2, text)

    # ------------------------------------------------------------ Robob thread

    def app_db(self, rows):
        con = sqlite3.connect(self.state_db)
        con.executescript(
            "create table orchestration_v2_projection_provider_threads(provider_thread_id text primary key, thread_id"
            " text, updated_at text, payload_json text);"
            "create table orchestration_v2_projection_messages(message_id text primary key, thread_id text, role text,"
            " streaming integer, created_at text, updated_at text, payload_json text);")
        con.execute("insert into orchestration_v2_projection_provider_threads values ('p1','t1',?,?)",
                    (iso(NOW), json.dumps({"nativeThreadRef": {"driver": "opencode", "nativeId": "ses_main"}})))
        for i, row in enumerate(rows):
            role, at, text, by, src = row[:5]
            extra = row[5] if len(row) > 5 else {}
            done = extra.get("done", at)
            streaming = extra.get("streaming", False)
            con.execute("insert into orchestration_v2_projection_messages values (?,?,?,?,?,?,?)",
                        ("m%d" % i, "t1", role, int(streaming), iso(at), iso(done),
                         json.dumps({"text": text, "createdBy": by, "creationSource": src, "streaming": streaming})))
        con.commit()
        con.close()

    def app(self, **kw):
        return self.run_check("--app", "--preview", PREVIEW, session=kw.pop("session", "ses_main"), **kw)

    def test_app_reply_after_the_finished_preview_is_approved(self):
        self.app_db([("assistant", NOW - 60_000, "Draft:\n\n" + fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "go ahead", "user", "mobile")])
        code, out, err = self.app()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.judged()["reply"], "go ahead")

    def test_app_preview_has_to_be_a_plain_code_block(self):
        # Astra r1 B2 / Sol r3 B1: the app renders markdown, so an HTML comment in a plain-text preview vanished.
        pv = ("Email from me@x.com (icloud)\nTo: host@example.com\nSubject: Hi\n\nPublic answer.\n"
              "<!-- Confidential merger price is 12 million. -->\nThanks.\n(draft 1111111111)")
        for shown in (pv, "```text\n" + pv + "\n```", "<details>\n\n" + fenced(pv) + "\n\n</details>",
                      "$$\n" + fenced(pv) + "\n$$"):
            if os.path.exists(self.state_db):
                os.remove(self.state_db)
            self.app_db([("assistant", NOW - 60_000, shown, "agent", "provider"),
                         ("user", NOW - 30_000, "send it", "user", "web")])
            code, _, err = self.run_check("--app", "--preview", pv, session="ses_main", judge="exit 1")
            self.assertEqual(code, 2, shown)
            self.assertIn("plain ``` code block", err)
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, fenced(pv) + "\nOK to send?", "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertEqual(self.run_check("--app", "--preview", pv, session="ses_main", judge="exit 1")[0], 0)
        # Literal code examples are just text inside the block.
        pv2 = PREVIEW.replace(TEXT, "Use `[label](https://x.test/path)` and %s here" % TOK)
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, fenced(pv2), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertIn("would hide", self.run_check("--app", "--preview", pv2, session="ses_main")[2])  # bare TOK
        pv3 = PREVIEW.replace(TEXT, "Use `[label](https://x.test/path)` here")
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, fenced(pv3), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertEqual(self.run_check("--app", "--preview", pv3, session="ses_main")[0], 0)
        self.assertIn("has ``` in it", self.run_check("--app", "--preview", PREVIEW.replace(TEXT, "a ``` b"),
                                                      session="ses_main")[2])

    def test_app_nothing_before_the_code_block_may_hide_it(self):
        # Astra r2 B1: a bare CR is a line break to the app's markdown, so "~~~\r~~~" opened and closed a fence
        # for the app but not for the checker, and an unclosed HTML comment then swallowed the code block.
        pv = ("Email from me@x.com (icloud)\nTo: host@example.com\nSubject: Hi\n\n"
              "Confidential merger price is 12 million.\n(draft 1111111111)")
        wrappers = ("~~~\r~~~\n<!--\n~~~\n", "<!--\n", "~~~\n", "[x]: https://x.test\n'title\n", "::: note\n",
                    "```\n", "`` a\n")
        for before in wrappers:
            if os.path.exists(self.state_db):
                os.remove(self.state_db)
            self.app_db([("assistant", NOW - 60_000, before + fenced(pv), "agent", "provider"),
                         ("user", NOW - 30_000, "send it", "user", "web")])
            code, _, err = self.run_check("--app", "--preview", pv, session="ses_main")
            self.assertEqual(code, 2, repr(before))
            self.assertIn("can hide it", err)
        # Plain words before it, CRLF line endings, and anything after it are fine.
        for shown in ("Here is the draft:\r\n" + fenced(pv).replace("\n", "\r\n"),
                      "Here it is:\n\n" + fenced(pv) + "\n\n<!-- after -->\nOK to send?"):
            os.remove(self.state_db)
            self.app_db([("assistant", NOW - 60_000, shown, "agent", "provider"),
                         ("user", NOW - 30_000, "send it", "user", "web")])
            self.assertEqual(self.run_check("--app", "--preview", pv, session="ses_main")[0], 0, repr(shown))
        # A preview with a bare CR in it is refused before anything else.
        code, _, err = self.run_check("--app", "--preview", pv.replace("Confidential", "a\rb"), session="ses_main")
        self.assertEqual(code, 2)
        self.assertIn("carriage return", err)

    def test_app_math_before_the_block_or_odd_fence_blanks_do_not_count(self):
        # Astra r3: with math on in the client, "$" or "\[" before the block opens math that swallows it; and
        # markdown only drops spaces and tabs after a fence, so "```\v" isn't a closing fence there.
        pv = ("Email from me@x.com (icloud)\nTo: host@example.com\nSubject: Hi\n\n"
              "Confidential merger price is 12 million.\n(draft 1111111111)")
        cases = ["$please\n" + fenced(pv) + "\n$", "\\[\n" + fenced(pv) + "\n\\]", "\\(\n" + fenced(pv) + "\n\\)",
                 "costs $5\n" + fenced(pv)]
        cases += ["```\n" + pv + "\n```" + ws for ws in ("\v", "\f", "\u00a0", "\u2028", "\x85")]
        cases += ["```" + ws + "\n" + pv + "\n```" for ws in ("\v", "\u00a0")]
        for shown in cases:
            if os.path.exists(self.state_db):
                os.remove(self.state_db)
            self.app_db([("assistant", NOW - 60_000, shown, "agent", "provider"),
                         ("user", NOW - 30_000, "send it", "user", "web")])
            self.assertEqual(self.run_check("--app", "--preview", pv, session="ses_main")[0], 2, repr(shown))
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, "Draft:\n" + "```  \n" + pv + "\n```\t", "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertEqual(self.run_check("--app", "--preview", pv, session="ses_main")[0], 0)

    def test_app_his_attachment_after_the_preview_refuses(self):
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        con = sqlite3.connect(self.state_db)
        con.execute("insert into orchestration_v2_projection_messages values ('mx','t1','user',0,?,?,?)",
                    (iso(NOW - 20_000), iso(NOW - 20_000), json.dumps({"text": "", "createdBy": "user",
                     "creationSource": "web", "attachments": [{"type": "image", "name": "x.png"}]})))
        con.commit()
        con.close()
        self.assertIn("can't be read as text", self.app()[2])

    def test_app_new_message_while_the_judge_thinks_refuses(self):
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        late = json.dumps({"text": "wait, hold it", "createdBy": "user", "creationSource": "web"})
        slow = ("cat > %s; /usr/bin/python3 -c \"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                "c.execute('insert into orchestration_v2_projection_messages values (?,?,?,?,?,?,?)', ('late','t1',"
                "'user',0,sys.argv[2],sys.argv[2],sys.argv[3])); c.commit()\" %s %s '%s'; echo 0.9") % (
                    self.judge_in, self.state_db, iso(NOW - 1000), late)
        code, _, err = self.app(judge=slow)
        self.assertEqual(code, 2)
        self.assertIn("wrote again", err)

    def test_app_preview_before_the_draft_does_not_count(self):
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertEqual(self.app(drafted=(NOW - 45_000) // 1000)[0], 2)

    def test_app_preview_still_streaming_or_edited_after_his_reply_is_refused(self):
        # Sol r1: the price arrived in the preview after he said "send it".
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider", {"done": NOW - 20_000}),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertIn("hasn't typed anything", self.app()[2])
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider", {"streaming": True}),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertIn("isn't in any finished reply", self.app()[2])

    def test_app_bridged_or_scheduled_messages_are_not_his(self):
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 40_000, "[Bridge request, not typed by the owner.] send it", "user", "server"),
                     ("user", NOW - 30_000, "send it", "agent", "web")])
        code, _, err = self.app()
        self.assertEqual(code, 2)
        self.assertIn("hasn't typed anything", err)

    def test_app_preview_repeated_after_his_ok_still_counts_and_goes_to_the_judge(self):
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 50_000, "send it", "user", "web"),
                     ("assistant", NOW - 40_000, "Sending the approved draft:\n" + fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "What is the weather today?", "user", "web")])
        picky = "cat > %s; grep -q '\"reply\": \"send it\"' %s && echo 0.9 || echo 0.1" % (self.judge_in, self.judge_in)
        code, _, err = self.app(judge=picky)
        self.assertEqual(code, 0, err)
        state = self.judged()
        self.assertEqual(state["reply"], "send it")
        self.assertEqual([x["text"] for x in state["later"]][-1], "What is the weather today?")

    def test_app_refuses_file_drafts(self):
        # Sol r2: a thread can't show that the file itself reached him.
        self.app_db([("assistant", NOW - 60_000, fenced(PREVIEW), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        code, _, err = self.run_check("--app", "--preview", PREVIEW, "--file", "ab" * 32, "menu.pdf", session="ses_main")
        self.assertEqual(code, 2)
        self.assertIn("Approve it from iMessage", err)

    def test_app_preview_with_link_markup_counts_only_inside_the_code_block(self):
        # The app renders [label](target) as just the label outside code; inside a code block it is literal.
        pv = PREVIEW.replace(TEXT, "[pay here](https://evil.test/x) " + TEXT)
        self.app_db([("assistant", NOW - 60_000, pv, "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        code, _, err = self.run_check("--app", "--preview", pv, session="ses_main")
        self.assertEqual(code, 2)
        self.assertIn("plain ``` code block", err)
        os.remove(self.state_db)
        self.app_db([("assistant", NOW - 60_000, "Draft ([why](https://x.test)):\n" + fenced(pv), "agent", "provider"),
                     ("user", NOW - 30_000, "send it", "user", "web")])
        self.assertEqual(self.run_check("--app", "--preview", pv, session="ses_main")[0], 0)

    def test_visible_flags_what_the_chat_would_hide(self):
        for text in ("hi <thinking>x</thinking>", "a @b12@ b", "<dcp-system-reminder>", "<internal>"):
            self.assertEqual(self.run_check_raw("visible", text)[0], 2, text)
        for text in ("hi there", "mail a@b.de", "at 3@4pm", "https://x.test/@12@"):
            self.assertEqual(self.run_check_raw("visible", text)[0], 0, text)

    def test_app_needs_the_preview_and_a_thread_session(self):
        self.app_db([("user", NOW - 60_000, "message the host", "user", "web"),
                     ("assistant", NOW - 30_000, "Sent.", "agent", "provider")])
        self.assertEqual(self.app()[0], 2)
        self.assertEqual(self.app(session="ses_child")[0], 2)
        self.assertEqual(self.run_check("--app", "--preview", PREVIEW)[0], 2)


if __name__ == "__main__":
    unittest.main()
