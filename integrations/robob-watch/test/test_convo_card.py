import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
    if os.environ.get("FAKE_SHARE_FAIL"):
        print("tunnel not up", file=sys.stderr); sys.exit(3)
    if os.environ.get("FAKE_SHARE_SLEEP"):
        import time; time.sleep(float(os.environ["FAKE_SHARE_SLEEP"]))
    print(json.dumps({"url": os.environ.get("FAKE_SHARE_URL") or "https://x.trycloudflare.com/" + args[2] + "/",
                      "created": True, "metadataWarnings": json.loads(os.environ.get("FAKE_BRIDGE_WARN") or "[]")}))
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

# Language check: English unless FAKE_LANG maps the text to another language.
FAKE_LANGID = """#!/usr/bin/python3
import json, os, sys
langs = json.loads(os.environ.get("FAKE_LANG") or "{}")
print(json.dumps([{"top": langs.get(t, "en")} for t in json.load(sys.stdin)]))
"""
REAL_LANGID = os.path.join(HERE, "..", "helpers", "convo-card", "english.js")


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
            CONVO_CARD_BRIDGE_STATE=os.path.join(self.dir, "bridge-state"),
            CONVO_CARD_WACLI=self._exe("wacli", FAKE_WACLI), CONVO_CARD_BRIDGE=self._exe("bridge", FAKE_BRIDGE),
            CONVO_CARD_CHECK=self._exe("card-check", FAKE_CHECK), CONVO_CARD_LANGID=self._exe("langid", FAKE_LANGID),
            FAKE_WACLI_LOG=self.logs["wacli"],
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
        # A name or message that looks like a placeholder is never filled in.
        self.msg(PHONE, "T2", T0 + 1, text='" id=thread x="')
        self.run_card("build", "--slug", "lydia-chat", "--them", "{{DATA}}", "--title", "{{DATA}}")
        with open(os.path.join(self.card(), "index.html")) as f:
            page = f.read()
        self.assertEqual(page.count('id="thread"'), 1)
        self.assertIn("<title>{{DATA}} chat</title>", page)
        for word in ("Moni", "Abdullah's", "Lydia"):
            with open(os.path.join(HERE, "..", "helpers", "convo-card", "page.html")) as f:
                self.assertNotIn(word, f.read())

    def test_text_that_is_not_plainly_english_is_pending(self):
        self.msg(PHONE, "AM", T0, text="እሺ")
        self.msg(PHONE, "EM", T0 + 1, text="ok 👍")
        self.msg(PHONE, "FR", T0 + 2, text="très bien")
        self.msg(PHONE, "ES", T0 + 3, text="Necesito ayuda con el perro")
        self.msg(PHONE, "DE", T0 + 4, text="Guten Tag")
        self.msg(PHONE, "EN", T0 + 5, text="Lydia walked the dogs and they're eating, thanks")
        self.msg(PHONE, "VI", T0 + 6, media="video", caption="ምግብ")
        # Every word is in the English word list, so only the language check catches these.
        self.msg(PHONE, "ES2", T0 + 7, text="Sin embargo")
        self.msg(PHONE, "DE2", T0 + 8, text="Ich bin in Berlin")
        env = dict(self.env, FAKE_LANG=json.dumps({"Sin embargo": "es", "Ich bin in Berlin": "de"}))
        out = json.loads(self.run_card("build", "--chat", "971500000001", "--slug", "lydia-chat", "--them", "Lydia",
                                       "--me", "Moni", "--since", SINCE, env=env).stdout)
        self.assertEqual([p["id"] for p in out["pending"]], ["AM", "FR", "ES", "DE", "VI", "ES2", "DE2"])

    def test_language_check_that_cannot_run_reviews_every_worded_message(self):
        self.msg(PHONE, "EN", T0, text="Lydia walked the dogs")
        self.msg(PHONE, "OK", T0 + 1, text="ok 👍")
        env = dict(self.env, CONVO_CARD_LANGID="/usr/bin/false")
        out = json.loads(self.run_card("build", "--chat", "971500000001", "--slug", "lydia-chat", "--them", "Lydia",
                                       "--me", "Moni", "--since", SINCE, env=env).stdout)
        self.assertEqual([p["id"] for p in out["pending"]], ["EN"])

    @unittest.skipUnless(os.path.exists("/usr/bin/osascript"), "needs macOS")
    def test_real_recognizer_tells_english_from_dictionary_words(self):
        # Apple's on-device recognizer (no network).
        self.msg(PHONE, "ES", T0, text="Sin embargo")
        self.msg(PHONE, "DE", T0 + 1, text="Ich bin in Berlin")
        self.msg(PHONE, "EN", T0 + 2, text="Booby is vomiting, should I call the vet?")
        self.msg(PHONE, "EN2", T0 + 3, text="on my way")
        env = dict(self.env, CONVO_CARD_LANGID=f"/usr/bin/osascript -l JavaScript {REAL_LANGID}")
        out = json.loads(self.run_card("build", "--chat", "971500000001", "--slug", "lydia-chat", "--them", "Lydia",
                                       "--me", "Moni", "--since", SINCE, env=env).stdout)
        self.assertEqual([p["id"] for p in out["pending"]], ["ES", "DE"])

    def test_group_senders_are_told_apart(self):
        group = "120363000000000001@g.us"
        self.msg(group, "G1", T0, text="hi", sender="971500000005@s.whatsapp.net")
        self.msg(group, "G2", T0 + 1, text="hello", sender="971500000006@s.whatsapp.net")
        self.run_card("build", "--chat", group, "--slug", "dog-group", "--since", SINCE)
        a, b = self.data("dog-group")["messages"]
        self.assertEqual((a["who"], b["who"]), ("+971500000005", "+971500000006"))
        self.assertNotEqual(a["from"], b["from"])

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
        # Anything a real build would change counts, e.g. the footer after a different --me.
        out = json.loads(self.build("--dry-run", "--me", "Abdullah").stdout)
        self.assertFalse(out["same"])
        self.assertIn("foot", [x.get("field") for x in out["diffs"]])
        self.assertEqual(sorted(os.listdir(self.card())), before)

    def test_photo_that_cannot_download_stays_pending(self):
        self.msg(LID, "P9", T0, from_me=1, media="image", caption="Card 9")
        out = json.loads(self.build().stdout)
        m = self.data()["messages"][0]
        self.assertEqual(m["type"], "image")
        self.assertNotIn("image", m)
        # Nobody has seen what it shows, so it can't count as done.
        self.assertEqual(out["pending"], [{"id": "P9", "type": "image", "reason": "not downloaded"}])
        p = self.run_card("translate", "--slug", "lydia-chat", "--id", "P9", "--none", code=3)
        self.assertIn("isn't downloaded", p.stderr)
        self.assertEqual(json.loads(self.build().stdout)["pending"][0]["id"], "P9")
        # Once the photo can be fetched, a dry run says a real build would change the card.
        self.set_photos({"P9": "nine"})
        out = json.loads(self.build("--dry-run").stdout)
        self.assertFalse(out["same"])
        self.assertEqual(out["photos_not_downloaded"], ["P9"])

    def test_identity_mapped_after_the_first_build_is_read(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        con = sqlite3.connect(os.path.join(self.store, "session.db"))
        con.execute("delete from whatsmeow_lid_map")
        con.execute("insert into whatsmeow_lid_map values ('2222', '971500000001')")
        con.commit()
        con.close()
        self.msg("2222@lid", "T2", T0 + 5, from_me=1, text="hello")
        self.run_card("build", "--slug", "lydia-chat")
        self.assertEqual([m["id"] for m in self.data()["messages"]], ["T1", "T2"])

    def test_card_made_from_an_unmapped_lid_follows_the_phone(self):
        self.msg("3333@lid", "L1", T0, text="hi")
        self.run_card("build", "--chat", "3333@lid", "--slug", "lid-chat", "--them", "Sam", "--since", SINCE)
        con = sqlite3.connect(os.path.join(self.store, "session.db"))
        con.execute("insert into whatsmeow_lid_map values ('3333', '971500000009')")
        con.commit()
        self.msg("971500000009@s.whatsapp.net", "L2", T0 + 1, text="hello")
        self.run_card("build", "--slug", "lid-chat")
        with open(os.path.join(self.card("lid-chat"), ".convo.json")) as f:
            self.assertEqual(json.load(f)["chat"], "971500000009@s.whatsapp.net")
        # The phone moves to a new LID: still the same chat.
        con.execute("delete from whatsmeow_lid_map where pn='971500000009'")
        con.execute("insert into whatsmeow_lid_map values ('4444', '971500000009')")
        con.commit()
        con.close()
        self.msg("4444@lid", "L3", T0 + 2, from_me=1, text="see you")
        self.run_card("build", "--slug", "lid-chat")
        self.assertEqual([m["id"] for m in self.data("lid-chat")["messages"]], ["L1", "L2", "L3"])

    def test_second_card_for_the_same_chat_is_refused(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        p = self.run_card("build", "--chat", "971500000001", "--slug", "other-chat", code=2)
        self.assertIn("lydia-chat already shows this chat", p.stderr)
        self.assertFalse(os.path.exists(self.card("other-chat")))
        p = self.run_card("build", "--chat", LID, "--slug", "other-chat", code=2)
        self.assertIn("lydia-chat already shows this chat", p.stderr)
        self.assertFalse(os.path.exists(self.card("other-chat")))
        self.build()

    def test_sent_card_keeps_its_window(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        with open(os.path.join(self.card(), ".sent.json"), "w") as f:
            json.dump({"moni": {"url": "https://x", "key": "k"}}, f)
        before = json.load(open(os.path.join(self.card(), ".convo.json")))["since"]
        p = self.run_card("build", "--slug", "lydia-chat", "--days", "1", code=2)
        self.assertIn("already sent to moni", p.stderr)
        self.assertEqual(json.load(open(os.path.join(self.card(), ".convo.json")))["since"], before)
        self.run_card("build", "--slug", "lydia-chat", "--since", "2026-10-20T00:00+04:00")
        self.run_card("build", "--slug", "lydia-chat", "--days", "1", "--narrow")

    def test_never_sent_card_can_be_narrowed(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.run_card("build", "--slug", "lydia-chat", "--days", "1")
        self.assertTrue(os.path.exists(self.card()))

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

    def test_whitespace_change_in_the_source_drops_its_translation(self):
        self.msg(PHONE, "AM", T0, text="እሺ")
        self.build()
        self.run_card("translate", "--slug", "lydia-chat", "--id", "AM", "--text", "OK")
        self.edit("AM", " እሺ ")
        out = json.loads(self.build().stdout)
        self.assertEqual(out["pending"], [{"id": "AM", "type": "text", "reason": "changed"}])

    def test_translation_moved_to_another_message_does_not_show(self):
        # Same text in both, so only the message id tells them apart.
        self.msg(PHONE, "A1", T0, text="እሺ")
        self.msg(PHONE, "A2", T0 + 1, text="እሺ")
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
        self.assertEqual(opt("--subcaption"), "Lydia replied")
        self.assertTrue(opt("--key").startswith("convo-lydia-chat-moni-R1-"))
        self.assertEqual(self.log("check"), [["page", self.card()]])
        # Same last message, same link: nothing new goes out.
        out = json.loads(self.send("--to", "moni").stdout)
        self.assertFalse(out["sent"])
        self.assertEqual([c[0] for c in self.log("bridge")], ["share", "app", "share"])
        # A new message makes a new card.
        self.msg(PHONE, "R2", T0 + 200, text="Meet at noon on Sat 24 Oct, 24/10/2026")
        self.build()
        self.run_card("translate", "--slug", "lydia-chat", "--id", "R2", "--none")
        self.send("--to", "moni")
        app = self.log("bridge")[-1]
        self.assertEqual(app[0], "app")
        self.assertEqual(app[app.index("--subcaption") + 1], "Lydia replied")   # never the message text
        self.assertIn("-R2-", app[app.index("--key") + 1])
        # Never a picture of the chat, never WhatsApp.
        self.assertFalse(any(c[0] in ("send-file", "send") for c in self.log("bridge")))

    def test_card_for_the_chat_you_are_in_goes_without_to(self):
        import sqlite3
        db = os.path.join(self.dir, "bridge-state", "chats", "moni")
        os.makedirs(db)
        con = sqlite3.connect(os.path.join(db, "state.sqlite"))
        con.execute("create table kv (key text primary key, value text)")
        con.execute("insert into kv values ('route', ?)", (json.dumps({"id": self.SESSION, "generation": 1}),))
        con.commit()
        con.close()
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.run_card("send", "--slug", "lydia-chat", "--session", self.SESSION + "@1", "--to", "moni")
        app = self.log("bridge")[-1]
        self.assertEqual(app[0], "app")
        self.assertNotIn("--to", app)
        # A stale generation is not this chat's session: it stays an owner relay (--to).
        self.msg(PHONE, "T2", T0 + 100, text="hello")
        self.build()
        self.run_card("send", "--slug", "lydia-chat", "--session", self.SESSION + "@0", "--to", "moni")
        self.assertIn("--to", self.log("bridge")[-1])

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

    def test_card_text_cannot_be_overridden(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        # Caption and subcaption are fixed phrases: free text could carry a time that goes stale in the chat.
        self.send("--to", "moni", "--subcaption", "Back in an hour", code=2)
        self.send("--to", "moni", "--caption", "Lydia at 5", code=2)
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

    def test_event_the_runner_never_recorded_is_printed_again(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.msg(PHONE, "T2", T0 + 10, text="a")
        run = lambda rid, now: self.watch("--now", now, env=dict(self.env, WATCH_RUN=rid)).stdout
        self.assertEqual(run("r1", "1100"), "")
        first = run("r2", "1300")   # the runner gets killed before it records r2's output
        self.assertIn("msgid T2", first)
        again = run("r3", "1400")
        self.assertEqual(again, first)
        with open(os.path.join(self.wdir, ".run-ok"), "w") as f:
            f.write("r3\n")         # r3 was recorded: nothing to repeat
        self.assertEqual(run("r4", "1500"), "")
        # A new burst after an unrecorded one carries both.
        self.msg(PHONE, "T3", T0 + 20, text="b")
        run("r5", "1600")
        lost = run("r6", "1800")
        self.assertIn("msgid T3", lost)
        self.msg(PHONE, "T4", T0 + 30, text="c")
        run("r7", "1900")
        both = run("r8", "2100")
        self.assertIn("msgid T3", both)
        self.assertIn("msgid T4", both)

    def test_window_change_is_not_reported(self):
        self.msg(PHONE, "OLD", T0 - 3 * 86400, text="older")
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.assertIn("since", json.load(open(os.path.join(self.wdir, "cursor.json"))))
        self.build("--since", "2026-10-20T00:00+04:00")
        self.assertEqual(self.watch("--now", "1001", "--force").stdout, "")
        self.msg(PHONE, "T2", T0 + 10, text="new one")
        out = self.watch("--now", "1002", "--force").stdout
        self.assertIn("1 new message(s)", out)
        self.assertIn("msgid T2", out)
        self.assertNotIn("OLD", out)
        self.build("--since", SINCE)   # never sent, so narrowing is allowed
        self.assertEqual(self.watch("--now", "1003", "--force").stdout, "")

    def test_cursor_without_since_is_kept(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        path = os.path.join(self.wdir, "cursor.json")
        cur = json.load(open(path))
        del cur["since"]
        json.dump(cur, open(path, "w"))
        self.assertEqual(self.watch("--now", "1001", "--force").stdout, "")
        self.assertIn("since", json.load(open(path)))

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

    def test_edits_and_deletes_update_the_card(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.msg(PHONE, "T2", T0 + 1, text="see you")
        self.build()
        self.watch("--now", "1000")
        self.edit("T1", "hi there")
        out = self.watch("--now", "1000", "--force").stdout
        self.assertIn("1 edited or deleted message(s) in the Lydia chat", out)
        self.assertIn("- Lydia (edited): hi there (msgid T1)", out)
        self.assertEqual(self.watch("--now", "1001", "--force").stdout, "")
        con = sqlite3.connect(os.path.join(self.store, "wacli.db"))
        con.execute("update messages set revoked=1 where msg_id='T2'")
        con.commit()
        con.close()
        out = self.watch("--now", "1002", "--force").stdout
        self.assertIn("- Lydia: message deleted (msgid T2)", out)

    def test_message_deleted_for_me_is_not_reported(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.msg(PHONE, "T2", T0 + 1, text="gone", deleted_for_me=1)
        self.assertEqual(self.watch("--now", "1000", "--force").stdout, "")

    def test_identity_mapped_later_is_watched(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        con = sqlite3.connect(os.path.join(self.store, "session.db"))
        con.execute("delete from whatsmeow_lid_map")
        con.execute("insert into whatsmeow_lid_map values ('2222', '971500000001')")
        con.commit()
        con.close()
        self.msg("2222@lid", "T2", T0 + 5, from_me=1, text="hello")
        self.assertIn("- Moni: hello (msgid T2)", self.watch("--now", "1000", "--force").stdout)

    def test_new_event_gets_its_own_replay_budget(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        with open(os.path.join(self.wdir, ".convo-outbox.json"), "w") as f:
            json.dump({"run": "r0", "lines": ["CONVO_CARD_UPDATE old"], "at": 900, "replays": 3}, f)
        run = lambda rid: self.watch("--now", "1000", "--force", env=dict(self.env, WATCH_RUN=rid)).stdout
        self.msg(PHONE, "T2", T0 + 1, text="a")
        first = run("r1")
        self.assertIn("msgid T2", first)
        self.assertNotIn("old", first)
        # r1 was never recorded: the new event is printed again, whatever the old one used up.
        self.assertIn("msgid T2", run("r2"))

    def test_crash_between_outbox_and_cursor_is_not_reported_twice(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        cursor = os.path.join(self.wdir, "cursor.json")
        with open(cursor) as f:
            before = f.read()
        self.msg(PHONE, "T2", T0 + 1, text="a")
        run = lambda rid: self.watch("--now", "1000", "--force", env=dict(self.env, WATCH_RUN=rid)).stdout
        first = run("r1")
        with open(cursor, "w") as f:
            f.write(before)            # the run died after its outbox write, before the cursor write
        again = run("r2")
        self.assertEqual(again.count("msgid T2"), 1)
        self.assertEqual(again, first)
        with open(os.path.join(self.wdir, ".run-ok"), "w") as f:
            f.write("r2\n")
        self.assertEqual(run("r3"), "")

    def test_share_down_alert_is_not_doubled_after_a_crash(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        with open(os.path.join(self.card(), ".sent.json"), "w") as f:   # a file:// link never answers 200
            json.dump({"moni": {"url": "file:///nonexistent/convo-card-share", "key": "k"}}, f)
        share = os.path.join(self.wdir, "share.json")
        with open(share, "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)
        env = dict(self.env, FAKE_SHARE_FAIL="1")   # the re-share fails too, so the alert is printed
        run = lambda rid, now: self.watch("--now", now, env=dict(env, WATCH_RUN=rid)).stdout
        first = run("r1", "1000")
        self.assertEqual(first.count("CONVO_CARD_SHARE_DOWN"), 1)
        with open(share, "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)   # died after the outbox write, before share.json
        self.assertEqual(run("r2", "2000").count("CONVO_CARD_SHARE_DOWN"), 1)

    def dead_moni_link(self, url):
        with open(os.path.join(self.card(), ".sent.json"), "w") as f:
            json.dump({"moni": {"url": url, "card_url": url + "/?v=1", "key": "k", "last_id": "R1"}}, f)

    def test_dead_link_is_reshared_quietly_and_the_new_link_is_probed(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        hits = []

        class Live(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), Live)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        new = "http://127.0.0.1:%d/" % srv.server_address[1]
        old = "file:///nonexistent/convo-card-old-share"
        self.dead_moni_link(old)
        with open(os.path.join(self.card(), ".sent.json")) as f:
            before = f.read()
        with open(os.path.join(self.wdir, "share.json"), "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)
        env = dict(self.env, FAKE_SHARE_URL=new)
        # The second failed probe re-shares: no output, nothing sent, the new link is the one probed.
        self.assertEqual(self.watch("--now", "1000", env=env).stdout, "")
        self.assertEqual([c[0] for c in self.log("bridge")], ["share"])
        self.assertEqual(self.log("bridge")[0], ["share", "--app", "lydia-chat", "--days", "30"])
        with open(os.path.join(self.card(), ".sent.json")) as f:
            self.assertEqual(f.read(), before)
        with open(os.path.join(self.wdir, "share.json")) as f:
            share = json.load(f)
        self.assertEqual(share["moved"], {"moni": {"old": old, "url": new}})
        # Next probe (after PROBE_S) targets the new link: it answers, so nothing is printed or re-shared.
        self.assertEqual(self.watch("--now", "1700", env=env).stdout, "")
        self.assertEqual(len(self.log("bridge")), 1)
        self.assertGreaterEqual(len(hits), 2)
        self.assertEqual(set(hits), {"/"})

    def live_url(self):
        class Live(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), Live)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return "http://127.0.0.1:%d/" % srv.server_address[1]

    def test_legacy_dead_link_with_high_fail_count_is_reshared(self):
        # State written before this change: 37 failed probes, the old link already alerted.
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        old = "file:///nonexistent/convo-card-old-share"
        self.dead_moni_link(old)
        new = self.live_url()
        share = os.path.join(self.wdir, "share.json")
        with open(share, "w") as f:
            json.dump({"last_probe": 0, "fails": 37, "alerted_url": old}, f)
        env = dict(self.env, FAKE_SHARE_URL=new)
        self.assertEqual(self.watch("--now", "1000", env=env).stdout, "")
        self.assertEqual([c[0] for c in self.log("bridge")], ["share"])
        with open(share) as f:
            state = json.load(f)
        self.assertEqual(state["moved"], {"moni": {"old": old, "url": new}})
        self.assertEqual(state["fails"], 0)
        self.assertNotIn("alerted_url", state)

    def test_dry_run_never_calls_the_bridge_or_saves_state(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.dead_moni_link("file:///nonexistent/convo-card-old-share")
        share = os.path.join(self.wdir, "share.json")
        with open(share, "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)
        with open(share) as f:
            before = f.read()
        self.watch("--now", "1000", "--dry-run")
        self.assertEqual(self.log("bridge"), [])
        with open(share) as f:
            self.assertEqual(f.read(), before)

    def test_stalled_reshare_still_alerts_and_saves_state(self):
        # The bridge hangs; the watch budget is tight so the re-share times out inside it. The alert still prints
        # once and is saved, so the next run does not repeat it.
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.dead_moni_link("file:///nonexistent/convo-card-old-share")
        share = os.path.join(self.wdir, "share.json")
        with open(share, "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)
        env = dict(self.env, FAKE_SHARE_SLEEP="60", CONVO_CARD_WATCH_BUDGET="18")
        out = self.watch("--now", "1000", env=env).stdout
        self.assertEqual(out.count("CONVO_CARD_SHARE_DOWN"), 1)
        self.assertIn("could not re-share", out)
        with open(share) as f:
            state = json.load(f)
        self.assertEqual(state["alerted_url"], "file:///nonexistent/convo-card-old-share")
        # The bridge answers next time with a live link: the watch recovers silently and clears the saved alert.
        recovered = dict(self.env, FAKE_SHARE_URL=self.live_url())
        self.assertEqual(self.watch("--now", "1700", env=recovered).stdout, "")
        with open(share) as f:
            self.assertNotIn("alerted_url", json.load(f))

    def test_failed_reshare_alerts_once_and_never_sends(self):
        self.msg(PHONE, "T1", T0, text="hi")
        self.build()
        self.watch("--now", "1000")
        self.dead_moni_link("file:///nonexistent/convo-card-old-share")
        with open(os.path.join(self.wdir, "share.json"), "w") as f:
            json.dump({"last_probe": 0, "fails": 1}, f)
        env = dict(self.env, FAKE_SHARE_FAIL="1")
        # One failed probe is still quiet; the second triggers the failed re-share and the single alert.
        out = self.watch("--now", "1000", env=env).stdout
        self.assertEqual(out.count("CONVO_CARD_SHARE_DOWN"), 1)
        self.assertIn("Do not send a card", out)
        self.assertNotIn("run `convo-card send", out)
        # Each later probe retries the bridge re-share (a share call, never a card); the alert stays printed once.
        self.assertEqual(self.watch("--now", "1700", env=env).stdout, "")
        self.assertEqual(self.watch("--now", "2400", env=env).stdout, "")
        self.assertEqual([c[0] for c in self.log("bridge")], ["share", "share", "share"])
        self.assertNotIn("app", [c[0] for c in self.log("bridge")])


if __name__ == "__main__":
    unittest.main()
