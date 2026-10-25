import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.join(HERE, "..", "helpers", "convo-card", "convo_card.py")
DXB = timezone(timedelta(hours=4))
SINCE = "2026-10-24T00:00+04:00"
T0 = int(datetime(2026, 10, 24, 15, 28, tzinfo=DXB).timestamp())
PHONE, LID = "971500000001@s.whatsapp.net", "1111@lid"

# `wacli --read-only media download --chat J --id ID --output DIR/`: writes the photo bytes it was given.
FAKE_WACLI = """#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_WACLI_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
mid = args[args.index("--id") + 1]
out = args[args.index("--output") + 1]
photos = json.load(open(os.environ["FAKE_WACLI_PHOTOS"]))
if mid not in photos:
    print("media not available", file=sys.stderr); sys.exit(1)
open(os.path.join(out, "x-IMG_" + mid + ".JPEG"), "w").write(photos[mid])
"""

FAKE_BRIDGE = """#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_BRIDGE_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
if args[0] == "share":
    print(json.dumps({"url": "https://x.trycloudflare.com/" + args[2] + "/", "created": True,
                      "metadataWarnings": json.loads(os.environ.get("FAKE_BRIDGE_WARN") or "[]")}))
elif args[0] == "publish":
    print(json.dumps({"url": "https://host.ts.net:18401/" + args[2] + "/", "metadataWarnings": []}))
elif args[0] == "app":
    print(json.dumps({"id": "app:1", "created": True}))
else:
    print(json.dumps({"ok": True}))
"""

FAKE_CHECK = """#!/usr/bin/python3
import json, os, sys
with open(os.environ["FAKE_CHECK_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
code = int(os.environ.get("FAKE_CHECK_EXIT") or 0)
print("PASS" if code == 0 else "FAIL bubble: text cut")
sys.exit(code)
"""


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = os.path.join(self.dir, "store")
        os.makedirs(self.store)
        self.cards = os.path.join(self.dir, "cards")
        self.wdir = os.path.join(self.dir, "watch")
        os.makedirs(self.wdir)
        self.photos = os.path.join(self.dir, "photos.json")
        self.set_photos({})
        self.logs = {k: os.path.join(self.dir, k + ".log") for k in ("wacli", "bridge", "check")}
        with open(os.path.join(self.store, "LOCK"), "w") as f:
            f.write("pid=%d\n" % os.getpid())
        con = sqlite3.connect(os.path.join(self.store, "wacli.db"))
        con.executescript("""
            create table messages (chat_jid text, chat_name text, msg_id text, sender_jid text, sender_name text,
              ts integer, from_me integer, text text, display_text text, media_type text, media_caption text,
              filename text, reaction_to_id text, reaction_emoji text, revoked integer default 0,
              deleted_for_me integer default 0, deleted_at integer, edited integer default 0,
              unique(chat_jid, msg_id));
            create table contacts (jid text primary key, phone text, push_name text, full_name text,
              first_name text, business_name text, system_name text, updated_at integer);
            create table contact_aliases (jid text primary key, alias text, notes text);
            create table chats (jid text primary key, name text, kind text, unread_count integer,
              last_message_ts integer);
        """)
        con.execute("insert into contacts (jid, push_name) values (?, ?)", (PHONE, "Lydia W"))
        con.commit()
        con.close()
        s = sqlite3.connect(os.path.join(self.store, "session.db"))
        s.executescript("""
            create table whatsmeow_lid_map (lid text primary key, pn text unique);
            create table whatsmeow_contacts (their_jid text, full_name text, business_name text, push_name text);
            insert into whatsmeow_lid_map values ('1111', '971500000001');
        """)
        s.commit()
        s.close()
        self.env = dict(
            os.environ, WACLI_STORE_DIR=self.store, CONVO_CARD_ROOT=self.cards, CONVO_CARD_NO_IMAGE="1",
            CONVO_CARD_WACLI=self._exe("wacli", FAKE_WACLI), CONVO_CARD_BRIDGE=self._exe("bridge", FAKE_BRIDGE),
            CONVO_CARD_CHECK=self._exe("card-check", FAKE_CHECK), FAKE_WACLI_LOG=self.logs["wacli"],
            FAKE_WACLI_PHOTOS=self.photos, FAKE_BRIDGE_LOG=self.logs["bridge"], FAKE_CHECK_LOG=self.logs["check"],
        )
        self.env.pop("WATCH_DIR", None)

    def _exe(self, name, src):
        p = os.path.join(self.dir, name)
        with open(p, "w") as f:
            f.write(src)
        os.chmod(p, 0o755)
        return p

    def set_photos(self, photos):
        with open(self.photos, "w") as f:
            json.dump(photos, f)

    def msg(self, chat, mid, ts, from_me=0, text="", media="", caption="", sender="", **extra):
        con = sqlite3.connect(os.path.join(self.store, "wacli.db"))
        cols = dict(chat_jid=chat, msg_id=mid, ts=ts, from_me=from_me, text=text, media_type=media,
                    media_caption=caption, sender_jid=sender, **extra)
        con.execute(f"insert into messages ({','.join(cols)}) values ({','.join('?' * len(cols))})", list(cols.values()))
        con.commit()
        rowid = con.execute("select max(rowid) from messages").fetchone()[0]
        con.close()
        return rowid

    def edit(self, mid, text):
        con = sqlite3.connect(os.path.join(self.store, "wacli.db"))
        con.execute("update messages set text=?, edited=1 where msg_id=?", (text, mid))
        con.commit()
        con.close()

    def run_card(self, *args, code=0, env=None):
        p = subprocess.run(["/usr/bin/python3", CARD, *args], capture_output=True, text=True,
                           env=env or self.env, timeout=60)
        self.assertEqual(p.returncode, code, p.stdout + p.stderr)
        return p

    def card(self, slug="lydia-chat"):
        return os.path.join(self.cards, slug)

    def data(self, slug="lydia-chat"):
        with open(os.path.join(self.card(slug), "data.json")) as f:
            return json.load(f)

    def log(self, name):
        if not os.path.exists(self.logs[name]):
            return []
        with open(self.logs[name]) as f:
            return [json.loads(x) for x in f]

    def seed_chat(self):
        """Two photos from Moni (stored under the LID), a reply from Lydia (phone JID), plus noise."""
        self.set_photos({"P1": "photo one bytes", "P2": "photo two bytes"})
        self.msg(LID, "OLD", T0 - 3 * 86400, from_me=1, text="before the window")
        self.msg(LID, "P1", T0, from_me=1, media="image")
        self.msg(LID, "P2", T0 + 4, from_me=1, media="image", caption="ምግብ")
        self.msg(PHONE, "R1", T0 + 100, text="ok")
        self.msg(PHONE, "RX", T0 + 101, reaction_to_id="P1", reaction_emoji="+")
        self.msg(PHONE, "GONE", T0 + 102, text="deleted", revoked=1)

    def build(self, *extra, code=0):
        return self.run_card("build", "--chat", "971500000001", "--slug", "lydia-chat", "--them", "Lydia",
                             "--me", "Moni", "--since", SINCE, *extra, code=code)

    def translate_all(self):
        self.run_card("translate", "--slug", "lydia-chat", "--id", "P1", "--text", "If the dog is sick call Moni",
                      "--caption", "Card 31 · Dog is sick")
        self.run_card("translate", "--slug", "lydia-chat", "--id", "P2", "--text", "Dog food, 3x a day")


class BuildTest(Base):
    def test_build_reads_both_identities_and_skips_noise(self):
        self.seed_chat()
        out = json.loads(self.build().stdout)
        d = self.data()
        self.assertEqual([m["id"] for m in d["messages"]], ["P1", "P2", "R1"])
        self.assertEqual([m["side"] for m in d["messages"]], ["out", "out", "in"])
        self.assertEqual([m["who"] for m in d["messages"]], ["Moni", "Moni", "Lydia"])
        self.assertEqual(d["status"], "Lydia replied 15:29")
        self.assertEqual(d["title"], "Lydia")
        self.assertEqual(d["initial"], "L")
        self.assertEqual(d["foot"], "Moni and Lydia · Since Sat 24 Oct, 00:00")
        # Every photo needs someone to look at it; plain English text does not.
        self.assertEqual([p["id"] for p in out["pending"]], ["P1", "P2"])
        self.assertEqual(d["pending_translations"], 2)
        with open(os.path.join(self.card(), d["messages"][0]["image"])) as f:
            self.assertEqual(f.read(), "photo one bytes")
        self.assertEqual(d["messages"][0]["image"], "media/P1.jpeg")

    def test_page_is_generic_and_seed_cannot_break_out(self):
        self.msg(PHONE, "T1", T0, text='</script><script>alert(1)</script> & "q"')
        self.build()
        with open(os.path.join(self.card(), "index.html")) as f:
            page = f.read()
        self.assertNotIn("{{", page)
        self.assertNotIn("<script>alert", page)
        self.assertIn("<title>Lydia chat</title>", page)
        self.assertIn('content="Lydia replied 15:28"', page)
        start = page.index('<script id="seed" type="application/json">') + len('<script id="seed" type="application/json">')
        seed = json.loads(page[start:page.index("</script>", start)])
        self.assertEqual(seed["messages"][0]["text"], '</script><script>alert(1)</script> & "q"')
        for word in ("Moni", "Abdullah's", "Lydia"):
            with open(os.path.join(HERE, "..", "helpers", "convo-card", "page.html")) as f:
                self.assertNotIn(word, f.read())

    def test_foreign_text_is_pending_and_emoji_is_not(self):
        self.msg(PHONE, "AM", T0, text="እሺ")
        self.msg(PHONE, "EM", T0 + 1, text="ok 👍")
        self.msg(PHONE, "FR", T0 + 2, text="très bien")
        out = json.loads(self.build().stdout)
        self.assertEqual([p["id"] for p in out["pending"]], ["AM"])

    def test_defaults_without_flags(self):
        self.msg(PHONE, "T1", int(datetime.now(DXB).timestamp()) - 60, text="hi")
        out = json.loads(self.run_card("build", "--chat", "+971 50 000 0001").stdout)
        self.assertEqual(out["slug"], "lydia-w-chat")
        d = self.data("lydia-w-chat")
        self.assertEqual(d["subtitle"], "via Abdullah's WhatsApp")
        self.assertEqual(d["messages"][0]["who"], "Lydia W")
        # Later runs need only the slug.
        self.run_card("build", "--slug", "lydia-w-chat")

    def test_slug_owned_by_another_chat_is_refused(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        p = self.run_card("build", "--chat", "971500000002", "--slug", "lydia-chat", code=2)
        self.assertIn("already belongs to", p.stderr)

    def test_dry_run_writes_nothing_and_compares(self):
        self.seed_chat()
        out = json.loads(self.build("--dry-run").stdout)
        self.assertFalse(os.path.exists(self.card()))
        self.assertEqual(self.log("wacli"), [])
        self.assertFalse(out["same"])
        self.build()
        self.translate_all()
        before = sorted(os.listdir(self.card()))
        out = json.loads(self.build("--dry-run").stdout)
        self.assertTrue(out["same"], out["diffs"])
        self.assertEqual(out["pending"], [])
        self.assertEqual(sorted(os.listdir(self.card())), before)

    def test_photo_that_cannot_download_shows_as_missing(self):
        self.msg(LID, "P9", T0, from_me=1, media="image", caption="Card 9")
        out = json.loads(self.build().stdout)
        m = self.data()["messages"][0]
        self.assertEqual(m["type"], "image")
        self.assertNotIn("image", m)
        self.assertEqual(out["pending"], [])  # an English caption alone needs no translation

    def test_help_says_use_the_defaults(self):
        p = self.run_card("--help")
        self.assertIn("Use the defaults", p.stdout)
        self.assertIn("Don't stop to ask", p.stdout)


class TranslateTest(Base):
    def test_translation_is_bound_to_message_and_source(self):
        self.seed_chat()
        self.build()
        self.translate_all()
        d = self.data()
        self.assertEqual(d["pending_translations"], 0)
        self.assertEqual(d["messages"][0]["translation"], "If the dog is sick call Moni")
        self.assertEqual(d["messages"][0]["caption"], "Card 31 · Dog is sick")
        self.assertEqual(d["messages"][1]["caption"], "ምግብ")
        # The photo behind P1 changes: its English must stop showing and count as stale.
        os.remove(os.path.join(self.card(), "media", "P1.jpeg"))
        self.set_photos({"P1": "a different photo", "P2": "photo two bytes"})
        out = json.loads(self.build().stdout)
        self.assertEqual(out["pending"], [{"id": "P1", "type": "image", "reason": "changed"}])
        p1 = self.data()["messages"][0]
        self.assertNotIn("translation", p1)
        self.assertTrue(p1["translation_pending"])

    def test_edited_text_drops_its_translation(self):
        self.msg(PHONE, "AM", T0, text="እሺ")
        self.build()
        self.run_card("translate", "--slug", "lydia-chat", "--id", "AM", "--text", "OK")
        self.assertEqual(self.data()["messages"][0]["translation"], "OK")
        self.edit("AM", "አይ")
        out = json.loads(self.build().stdout)
        self.assertEqual(out["pending"][0]["reason"], "changed")
        self.assertNotIn("translation", self.data()["messages"][0])

    def test_translation_moved_to_another_message_does_not_show(self):
        self.msg(PHONE, "A1", T0, text="እሺ")
        self.msg(PHONE, "A2", T0 + 1, text="አይ")
        self.build()
        self.run_card("translate", "--slug", "lydia-chat", "--id", "A1", "--text", "OK")
        tr_path = os.path.join(self.card(), ".translations.json")
        with open(tr_path) as f:
            tr = json.load(f)
        tr["A2"] = dict(tr["A1"])
        with open(tr_path, "w") as f:
            json.dump(tr, f)
        out = json.loads(self.build().stdout)
        self.assertEqual(out["pending"], [{"id": "A2", "type": "text", "reason": "changed"}])
        self.assertNotIn("translation", self.data()["messages"][1])

    def test_none_marks_a_photo_done_without_text(self):
        self.set_photos({"P1": "bytes"})
        self.msg(LID, "P1", T0, from_me=1, media="image")
        self.build()
        out = json.loads(self.run_card("translate", "--slug", "lydia-chat", "--id", "P1", "--none").stdout)
        self.assertEqual(out["pending"], [])
        self.assertNotIn("translation", self.data()["messages"][0])

    def test_unknown_id_is_refused(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.run_card("translate", "--slug", "lydia-chat", "--id", "NOPE", "--text", "x", code=2)


class SendTest(Base):
    SESSION = "ardud-control:thread:abc"

    def send(self, *extra, code=0, env=None):
        return self.run_card("send", "--slug", "lydia-chat", "--session", self.SESSION, *extra, code=code, env=env)

    def test_refuses_while_translations_pending(self):
        self.seed_chat()
        self.build()
        p = self.send("--to", "moni", code=3)
        self.assertIn("pending", p.stderr)
        self.assertEqual(self.log("bridge"), [])
        self.assertEqual(self.log("check"), [])

    def test_refuses_when_card_check_fails(self):
        self.seed_chat()
        self.build()
        self.translate_all()
        env = dict(self.env, FAKE_CHECK_EXIT="1")
        p = self.send("--to", "moni", code=3, env=env)
        self.assertIn("card-check failed", p.stderr)
        self.assertEqual(self.log("check"), [["page", self.card()]])
        self.assertEqual(self.log("bridge"), [])

    def test_sends_one_live_card_and_repeat_is_a_no_op(self):
        self.seed_chat()
        self.build()
        self.translate_all()
        out = json.loads(self.send("--to", "moni").stdout)
        self.assertTrue(out["sent"])
        calls = self.log("bridge")
        self.assertEqual([c[0] for c in calls], ["share", "app"])
        self.assertEqual(calls[0], ["share", "--app", "lydia-chat", "--days", "30"])
        app = calls[1]
        opt = lambda n: app[app.index(n) + 1]
        v = self.data()["v"]
        self.assertEqual(opt("--url"), "https://x.trycloudflare.com/lydia-chat/?v=" + v)
        self.assertEqual(opt("--to"), "moni")
        self.assertEqual(opt("--session"), self.SESSION)
        self.assertEqual(opt("--caption"), "Lydia chat")
        self.assertEqual(opt("--subcaption"), "Lydia: ok")
        self.assertTrue(opt("--key").startswith("convo-lydia-chat-moni-R1-"))
        self.assertEqual(self.log("check"), [["page", self.card()]])
        # Same last message, same link: nothing new goes out.
        out = json.loads(self.send("--to", "moni").stdout)
        self.assertFalse(out["sent"])
        self.assertEqual([c[0] for c in self.log("bridge")], ["share", "app", "share"])
        # A new message makes a new card.
        self.msg(PHONE, "R2", T0 + 200, text="Done at 3:30 today, thanks")
        self.build()
        self.send("--to", "moni")
        app = self.log("bridge")[-1]
        self.assertEqual(app[0], "app")
        self.assertEqual(app[app.index("--subcaption") + 1], "Lydia: Done at , thanks")
        self.assertIn("-R2-", app[app.index("--key") + 1])
        # Never a picture of the chat, never WhatsApp.
        self.assertFalse(any(c[0] in ("send-file", "send") for c in self.log("bridge")))

    def test_owner_gets_the_tailnet_link(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.send()
        calls = self.log("bridge")
        self.assertEqual(calls[0], ["publish", "--app", "lydia-chat"])
        self.assertEqual(calls[1][calls[1].index("--to") + 1], "owner")

    def test_metadata_warnings_stop_the_send(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        env = dict(self.env, FAKE_BRIDGE_WARN='["og:image missing"]')
        self.send("--to", "moni", code=3, env=env)
        self.assertEqual([c[0] for c in self.log("bridge")], ["share"])

    def test_subcaption_with_a_time_is_refused(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.send("--to", "moni", "--subcaption", "Lydia replied at 15:29", code=2)
        self.assertEqual(self.log("bridge"), [])

    def test_bad_session_and_chat_are_refused(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.run_card("send", "--slug", "lydia-chat", "--session", "x y", code=2)
        self.send("--to", "Moni Chat", code=2)
        self.assertEqual(self.log("bridge"), [])


class WatchTest(Base):
    def watch(self, *extra, code=0, env=None):
        return self.run_card("watch", "--slug", "lydia-chat", "--state-dir", self.wdir, *extra, code=code, env=env)

    def test_baseline_then_quiet_burst(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.assertEqual(self.watch("--now", "1000").stdout, "")
        self.assertEqual(self.watch("--now", "1001").stdout, "")
        self.msg(LID, "T2", T0 + 10, from_me=1, media="image", caption="Card 5")
        self.msg(PHONE, "T3", T0 + 20, text="ok")
        self.msg(PHONE, "RX", T0 + 21, reaction_to_id="T3", reaction_emoji="+")
        self.assertEqual(self.watch("--now", "2000").stdout, "")
        self.assertEqual(self.watch("--now", "2100").stdout, "")
        out = self.watch("--now", "2121").stdout
        self.assertIn("CONVO_CARD_UPDATE lydia-chat: 2 new message(s) in the Lydia chat, last msgid=T3", out)
        self.assertIn("- Moni: [IMAGE] Card 5 (msgid T2)", out)
        self.assertIn("- Lydia: ok (msgid T3)", out)
        self.assertNotIn("RX", out)
        self.assertEqual(self.watch("--now", "2200").stdout, "")

    def test_new_message_restarts_the_quiet_window(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.msg(PHONE, "T2", T0 + 10, text="a")
        self.watch("--now", "2000")
        self.msg(PHONE, "T3", T0 + 20, text="b")
        self.assertEqual(self.watch("--now", "2100").stdout, "")
        self.assertEqual(self.watch("--now", "2200").stdout, "")
        self.assertIn("2 new message(s)", self.watch("--now", "2221").stdout)

    def test_daemon_down_fails_the_check(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        with open(os.path.join(self.store, "LOCK"), "w") as f:
            f.write("")
        p = self.watch(code=1)
        self.assertIn("wacli sync", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.wdir, "cursor.json")))

    def test_dry_run_keeps_state(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.msg(PHONE, "T2", T0 + 10, text="a")
        out = self.watch("--now", "1000", "--force", "--dry-run").stdout
        self.assertIn("1 new message(s)", out)
        with open(os.path.join(self.wdir, "cursor.json")) as f:
            cursor = json.load(f)["rowid"]
        self.assertIn("1 new message(s)", self.watch("--now", "1000", "--force").stdout)
        with open(os.path.join(self.wdir, "cursor.json")) as f:
            self.assertGreater(json.load(f)["rowid"], cursor)


if __name__ == "__main__":
    unittest.main()
