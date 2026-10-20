import os
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = tempfile.mkdtemp(prefix="msgs-test-")
os.environ["MSGS_ROOT"] = ROOT
os.environ["MSGS_ADDRESSBOOK"] = os.path.join(ROOT, "ab")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import types  # noqa: E402

sys.modules.setdefault("mail_oauth", types.ModuleType("mail_oauth"))  # keep tests off the real token helper

import gmail_sync  # noqa: E402
import imap_sync  # noqa: E402
import imessage_sync  # noqa: E402
import mailparse  # noqa: E402
import search  # noqa: E402
import store  # noqa: E402
import whatsapp_sync  # noqa: E402


def typedstream(text):
    data = text.encode()
    n = len(data)
    if n < 0x80:
        ln = bytes([n])
    elif n < 0x10000:
        ln = b"\x81" + n.to_bytes(2, "little")
    else:
        ln = b"\x82" + n.to_bytes(4, "little")
    return b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + ln + data + b"\x86\x84\x02iI"


def item(**kw):
    base = dict(source="email", account="gmail", ext_id="x", msgid=None, conv=None, conv_name=None, ts=int(time.time()),
                from_me=0, sender="A <a@x.com>", sender_addr="a@x.com", recipients="me@x.com", subject="s", body="b",
                folders="INBOX", attachments="", path=None, size=1, junk=0, deleted_at=None)
    base.update(kw)
    return base


class DecoderTest(unittest.TestCase):
    def test_lengths(self):
        for text in ("hi", "x" * 200, "y" * 70000, "emoji \U0001f600 and \ufffc obj"):
            self.assertEqual(imessage_sync.decode_attributed(typedstream(text)), text)

    def test_garbage(self):
        self.assertIsNone(imessage_sync.decode_attributed(b""))
        self.assertIsNone(imessage_sync.decode_attributed(b"nothing here"))

    def test_apple_ts(self):
        self.assertEqual(imessage_sync.apple_ts(0), 0)
        self.assertEqual(imessage_sync.apple_ts(700_000_000 * 1_000_000_000), 700_000_000 + 978307200)
        self.assertEqual(imessage_sync.apple_ts(700_000_000), 700_000_000 + 978307200)


class MailParseTest(unittest.TestCase):
    RAW = (b"From: =?utf-8?q?Caf=C3=A9_Shop?= <Orders@Cafe.example>\r\nTo: Me <me@x.com>\r\nCc: b@x.com\r\n"
           b"Subject: =?utf-8?b?WW91ciBvcmRlciDinJM=?=\r\nDate: Mon, 19 Oct 2026 10:00:00 +0400\r\n"
           b"Message-ID: <abc@cafe>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n"
           b"--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><style>.x{}</style><p>Order&nbsp;#42</p><br>Thanks</html>\r\n"
           b"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"invoice.pdf\"\r\n\r\nJVBER\r\n--B--\r\n")

    def test_parse(self):
        p = mailparse.parse(self.RAW)
        self.assertEqual(p["subject"], "Your order \u2713")
        self.assertEqual(p["sender"], "Caf\u00e9 Shop <Orders@Cafe.example>")
        self.assertEqual(p["sender_addr"], "orders@cafe.example")
        self.assertIn("me@x.com", p["recipients"])
        self.assertIn("b@x.com", p["recipients"])
        self.assertEqual(p["msgid"], "abc@cafe")
        self.assertEqual(p["ts"], 1792389600)
        self.assertEqual(p["body"], "Order #42\nThanks")
        self.assertEqual(p["attachments"], "invoice.pdf")

    def test_raw_roundtrip(self):
        rel = mailparse.raw_path("icloud", 1792389600, "INBOX:1:5")
        self.assertTrue(rel.startswith("icloud/2026/10/"))
        self.assertNotIn(":", os.path.basename(rel))
        mailparse.save_raw(rel, self.RAW)
        self.assertEqual(mailparse.load_raw(rel), self.RAW)

    def test_empty_raw_file_is_rewritten(self):
        rel = mailparse.raw_path("icloud", 1792389600, "INBOX:1:6")
        full = os.path.join(mailparse.common.MAIL_DIR, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, "wb").close()  # what a power cut can leave behind
        mailparse.save_raw(rel, self.RAW)
        self.assertEqual(mailparse.load_raw(rel), self.RAW)

    def test_8bit_headers_and_odd_charsets(self):
        raw = ("From: a@x.com\r\nSubject: hi\r\nMessage-ID: <r\u00e9sum\u00e9@x>\r\nMIME-Version: 1.0\r\n"
               "Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain; charset=idna\r\n\r\n"
               "hello\r\n--B\r\nContent-Type: application/pdf\r\n"
               "Content-Disposition: attachment; filename=\"r\u00e9sum\u00e9.pdf\"\r\n\r\nJVBER\r\n--B--\r\n").encode()
        p = mailparse.parse(raw)
        self.assertEqual(p["subject"], "hi")
        self.assertIn("hello", p["body"])
        self.assertIn("sum", p["attachments"])
        self.assertTrue(p["msgid"])

    def test_parse_never_raises(self):
        orig = mailparse._parse
        mailparse._parse = lambda raw: 1 / 0
        try:
            p = mailparse.parse(b"Subject: still indexed\r\n\r\nbody text")
        finally:
            mailparse._parse = orig
        self.assertEqual(p["subject"], "still indexed")
        self.assertIn("body text", p["body"])

    def test_html_is_linear(self):
        self.assertEqual(mailparse.html_to_text("<header>Top</header><style>.a{}</style><p>x</p>"), "Top x")
        self.assertEqual(mailparse.html_to_text("<style>.a{} <p>kept</p>"), ".a{} kept")
        t = time.time()
        mailparse.html_to_text("<header>" * 3000 + "x" * 2_000_000)
        mailparse.html_to_text("<style>" * 200 + "y" * 200_000)
        mailparse.html_to_text("<" * 200_000)
        self.assertLess(time.time() - t, 5)


class StoreSearchTest(unittest.TestCase):
    def setUp(self):
        if os.path.exists(store.common.DB_PATH):
            os.remove(store.common.DB_PATH)
        self.db = store.connect()

    def tearDown(self):
        self.db.close()

    def ids(self, q, **kw):
        return [r["ext_id"] for r in search.run(self.db, q, **kw)]

    def test_concurrent_writers_take_turns(self):
        # The daemon runs one thread per source against the same file; none may hit "database is locked".
        import threading
        errors = []

        def writer(n):
            db = store.connect()
            try:
                for b in range(20):
                    db.execute("SELECT count(*) FROM items").fetchone()  # leave a read snapshot open
                    with store.writing(db):
                        for i in range(25):
                            store.upsert(db, item(account=f"a{n}", ext_id=f"{b}-{i}", body=f"note {n} {b} {i}"))
                        store.set_state(db, f"t{n}", {"b": b})
            except Exception as e:  # noqa: BLE001
                errors.append(e)
            finally:
                db.close()

        threads = [threading.Thread(target=writer, args=(n,)) for n in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM items").fetchone()[0], 6 * 20 * 25)

    def test_writing_rolls_back_on_error(self):
        with self.assertRaises(RuntimeError):
            with store.writing(self.db):
                store.upsert(self.db, item(ext_id="x"))
                raise RuntimeError("boom")
        self.assertEqual(self.db.execute("SELECT count(*) FROM items").fetchone()[0], 0)

    def test_upsert_and_fts_sync(self):
        self.assertEqual(store.upsert(self.db, item(ext_id="1", subject="Banyan Tree renewal")), "added")
        self.assertEqual(store.upsert(self.db, item(ext_id="1", subject="Banyan Tree renewal")), "same")
        self.assertEqual(self.ids('"banyan tree"'), ["1"])
        self.assertEqual(store.upsert(self.db, item(ext_id="1", subject="Lease renewal")), "updated")
        self.assertEqual(self.ids("banyan"), [])
        self.assertEqual(self.ids("lease"), ["1"])

    def test_deleted_keeps_text(self):
        store.upsert(self.db, item(source="whatsapp", account="whatsapp", ext_id="w", body="secret plan"))
        store.upsert(self.db, item(source="whatsapp", account="whatsapp", ext_id="w", body="", deleted_at=5))
        r = self.db.execute("SELECT body, deleted_at FROM items WHERE ext_id='w'").fetchone()
        self.assertEqual((r[0], r[1]), ("secret plan", 5))
        self.assertEqual(self.ids("is:deleted plan"), ["w"])

    def test_filters(self):
        now = int(time.time())
        store.upsert(self.db, item(ext_id="old", body="dinner plans", ts=now - 400 * 86400))
        store.upsert(self.db, item(ext_id="new", body="dinner tonight", ts=now - 86400, sender="Moni", from_me=0))
        store.upsert(self.db, item(source="imessage", account="imessage", ext_id="me", body="dinner?", from_me=1,
                                   sender="Me", conv_name="Moni"))
        store.upsert(self.db, item(ext_id="spam", body="dinner deal", junk=1))
        self.assertEqual(set(self.ids("dinner")), {"old", "new", "me"})
        self.assertIn("spam", self.ids("dinner", include_junk=True))
        self.assertEqual(self.ids("is:junk dinner"), ["spam"])
        self.assertEqual(self.ids("dinner newer_than:30d in:email"), ["new"])
        self.assertEqual(self.ids("dinner from:me"), ["me"])
        self.assertEqual(self.ids("dinner from:moni"), ["new"])
        self.assertEqual(self.ids("chat:moni dinner"), ["me"])
        self.assertEqual(self.ids("dinner -tonight -plans"), ["me"])
        self.assertEqual(set(self.ids("tonight OR plans")), {"old", "new"})
        self.assertEqual(self.ids("dinner before:2026-01-01" if now > 1767225600 + 86400 else "dinner older_than:1y"), ["old"])
        self.assertEqual(self.ids("dinn*", sort="date")[0], "me")

    def test_dedupe_by_msgid(self):
        store.upsert(self.db, item(ext_id="INBOX:1:1", msgid="m1", account="icloud", body="ticket"))
        store.upsert(self.db, item(ext_id="Archive:1:9", msgid="M1", account="icloud", body="ticket"))
        self.assertEqual(len(self.ids("ticket")), 1)
        self.assertEqual(len(self.ids("ticket", dedupe=False)), 2)

    def test_query_errors(self):
        with self.assertRaises(search.QueryError):
            search.parse("-only")
        with self.assertRaises(search.QueryError):
            search.parse("after:yesterday x")
        with self.assertRaises(search.QueryError):
            search.parse("in:fax x")
        with self.assertRaises(search.QueryError):
            search.parse("newer_than:99999999999999999999d x")

    def test_odd_input_is_literal(self):
        store.upsert(self.db, item(ext_id="o", body='ORD-12345 for "Abdullah" (AED 45)'))
        for q in ('ORD-12345', '"ORD-12345"', 'AED 45)', 'abdullah"', 'NEAR(x y)', 'body:ord-12345'):
            search.run(self.db, q)
        self.assertEqual(self.ids("ORD-12345"), ["o"])


class ChatSourcesTest(unittest.TestCase):
    def setUp(self):
        if os.path.exists(store.common.DB_PATH):
            os.remove(store.common.DB_PATH)
        self.db = store.connect()
        os.makedirs(os.path.join(ROOT, "ab"), exist_ok=True)
        ab = sqlite3.connect(os.path.join(ROOT, "ab", "AddressBook-v22.abcddb"))
        ab.executescript("""
            CREATE TABLE IF NOT EXISTS ZABCDRECORD (Z_PK INTEGER, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME);
            CREATE TABLE IF NOT EXISTS ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER);
            CREATE TABLE IF NOT EXISTS ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS);
            DELETE FROM ZABCDRECORD; DELETE FROM ZABCDPHONENUMBER; DELETE FROM ZABCDEMAILADDRESS;
            INSERT INTO ZABCDRECORD VALUES (1, 'Moni', NULL, NULL, NULL);
            INSERT INTO ZABCDPHONENUMBER VALUES (1, '058 593 3213');
        """)
        ab.commit()
        ab.close()

    def tearDown(self):
        self.db.close()

    def test_imessage(self):
        path = os.path.join(ROOT, "chat.db")
        if os.path.exists(path):
            os.remove(path)
        c = sqlite3.connect(path)
        c.executescript("""
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
              is_from_me INTEGER, service TEXT, cache_has_attachments INTEGER, date_edited INTEGER, date_retracted INTEGER,
              is_spam INTEGER, handle_id INTEGER, associated_message_type INTEGER, item_type INTEGER);
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT, style INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, mime_type TEXT);
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            INSERT INTO handle VALUES (1, '+971585933213');
            INSERT INTO chat VALUES (1, '+971585933213', NULL, 45);
            INSERT INTO chat_handle_join VALUES (1, 1);
            INSERT INTO attachment VALUES (1, 'menu.pdf', 'application/pdf');
            INSERT INTO message_attachment_join VALUES (2, 1);
        """)
        d = int((1792389600 - 978307200) * 1e9)
        rows = [(1, "g1", None, typedstream("Dinner at Zuma?"), d, 0, "iMessage", 0, 0, 0, 0, 1, 0, 0),
                (2, "g2", "\ufffc", None, d + 1, 1, "iMessage", 1, 0, 0, 0, 0, 0, 0),
                (3, "g3", None, typedstream("Loved it"), d + 2, 0, "iMessage", 0, 0, 0, 0, 1, 2000, 0)]
        c.executemany("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
        c.executemany("INSERT INTO chat_message_join VALUES (1, ?)", [(1,), (2,), (3,)])
        c.commit()
        c.close()
        imessage_sync.common.CHAT_DB = path
        s = imessage_sync.sync(self.db)
        self.assertEqual(s["added"], 2)
        r = self.db.execute("SELECT * FROM items WHERE ext_id='g1'").fetchone()
        self.assertEqual(r["body"], "Dinner at Zuma?")
        self.assertEqual(r["sender"], "Moni (+971585933213)")
        self.assertEqual(r["conv_name"], "Moni (+971585933213)")
        self.assertEqual(r["ts"], 1792389600)
        r = self.db.execute("SELECT * FROM items WHERE ext_id='g2'").fetchone()
        self.assertEqual((r["sender"], r["body"], r["attachments"]), ("Me", "", "menu.pdf"))
        self.assertEqual(imessage_sync.sync(self.db)["added"], 0)

    def test_whatsapp(self):
        path = os.path.join(ROOT, "wacli.db")
        if os.path.exists(path):
            os.remove(path)
        c = sqlite3.connect(path)
        c.executescript("""
            CREATE TABLE messages (rowid INTEGER PRIMARY KEY, chat_jid TEXT, chat_name TEXT, msg_id TEXT, sender_jid TEXT,
              sender_name TEXT, ts INTEGER, from_me INTEGER, text TEXT, display_text TEXT, media_type TEXT,
              media_caption TEXT, filename TEXT, revoked INTEGER, deleted_at INTEGER, edited_ts INTEGER,
              reaction_emoji TEXT, reaction_to_id TEXT);
            CREATE TABLE chats (jid TEXT, kind TEXT, name TEXT);
            CREATE TABLE contacts (jid TEXT, full_name TEXT, first_name TEXT, push_name TEXT, business_name TEXT, system_name TEXT);
            CREATE TABLE contact_aliases (jid TEXT, alias TEXT);
            INSERT INTO chats VALUES ('971585933213@s.whatsapp.net', 'dm', NULL);
            INSERT INTO messages VALUES (1, '971585933213@s.whatsapp.net', NULL, 'A', '971585933213@s.whatsapp.net', 'M',
              100, 0, 'pick up the passport', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL);
            INSERT INTO messages VALUES (2, '971585933213@s.whatsapp.net', NULL, 'B', '', '', 101, 1, NULL, NULL, 'image',
              'photo of the form', 'f.jpg', 0, NULL, NULL, NULL, NULL);
            INSERT INTO messages VALUES (3, '971585933213@s.whatsapp.net', NULL, 'C', '', '', 102, 1, NULL, NULL, NULL,
              NULL, NULL, 0, NULL, NULL, 'x', 'A');
        """)
        c.commit()
        c.close()
        whatsapp_sync.common.WACLI_DB = path
        s = whatsapp_sync.sync(self.db)
        self.assertEqual(s["added"], 2)
        r = self.db.execute("SELECT * FROM items WHERE ext_id LIKE '%/A'").fetchone()
        self.assertEqual((r["conv_name"], r["sender"]), ("Moni", "Moni"))
        r = self.db.execute("SELECT * FROM items WHERE ext_id LIKE '%/B'").fetchone()
        self.assertEqual((r["body"], r["attachments"]), ("photo of the form", "image | f.jpg"))
        # Revoked later, with wacli's placeholder text: the archived words must survive.
        c = sqlite3.connect(path)
        c.execute("UPDATE messages SET revoked=1, text=NULL, display_text='This message was deleted' WHERE rowid=1")
        c.commit()
        c.close()
        whatsapp_sync.sync(self.db, full=True)
        r = self.db.execute("SELECT * FROM items WHERE ext_id LIKE '%/A'").fetchone()
        self.assertEqual(r["body"], "pick up the passport")
        self.assertIsNotNone(r["deleted_at"])

    def test_imessage_full_rescan_needs_contacts(self):
        self.test_imessage()
        old = imessage_sync.common.ADDRESSBOOK
        imessage_sync.common.ADDRESSBOOK = tempfile.mkdtemp(dir=ROOT)
        try:
            imessage_sync.sync(self.db, full=True)
        finally:
            imessage_sync.common.ADDRESSBOOK = old
        self.assertNotIn("last_full", store.get_state(self.db, "imessage", {}))
        r = self.db.execute("SELECT * FROM items WHERE ext_id='g1'").fetchone()
        self.assertEqual(r["sender"], "Moni (+971585933213)")


def _eml(n, subject=None):
    return (f"From: s{n}@x.com\r\nTo: me@x.com\r\nSubject: {subject or f'mail {n}'}\r\nMessage-ID: <m{n}@x>\r\n"
            f"Date: Mon, 19 Oct 2026 10:00:00 +0400\r\n\r\nbody {n}\r\n").encode()


class FakeIMAP:
    """Just enough of imaplib for imap_sync: folders, SELECT, UID SEARCH and FETCH."""

    def __init__(self, server):
        self.server = server  # {"folders": {name: {uid: raw}}, "bad_uids": set(), "unselectable": set()}
        self.untagged_responses = {}
        self.folder = None

    def list(self):
        return "OK", [f'(\\HasNoChildren) "/" "{f}"'.encode() for f in self.server["folders"]]

    def select(self, name, readonly=False):
        name = name.strip('"')
        if name in self.server["unselectable"]:
            return "NO", [b"cannot select"]
        self.folder = name
        self.untagged_responses = {"UIDVALIDITY": [b"7"]}
        return "OK", [str(len(self.server["folders"][name])).encode()]

    def uid(self, cmd, *args):
        msgs = self.server["folders"][self.folder]
        if cmd == "SEARCH":
            return "OK", [" ".join(map(str, sorted(msgs))).encode()]
        uids = [int(u) for u in args[0].split(",")]
        if set(uids) & self.server["bad_uids"]:
            return "NO", [b"message unavailable"]
        out = []
        for u in uids:
            raw = msgs[u]
            out.append((f'{u} (UID {u} INTERNALDATE "19-Oct-2026 10:00:00 +0400" BODY[] {{{len(raw)}}}'.encode(), raw))
            out.append(b")")
        return "OK", out

    def logout(self):
        pass


class MailSyncTest(unittest.TestCase):
    def setUp(self):
        if os.path.exists(store.common.DB_PATH):
            os.remove(store.common.DB_PATH)
        self.db = store.connect()

    def tearDown(self):
        self.db.close()

    def rows(self, acct):
        return {r["ext_id"]: r for r in self.db.execute("SELECT * FROM items WHERE account=?", (acct,))}

    def test_imap_skips_bad_message_and_bad_folder(self):
        server = {"folders": {"INBOX": {u: _eml(u) for u in range(1, 8)}, "Broken": {}, "Archive": {9: _eml(9)}},
                  "bad_uids": {3}, "unselectable": {"Broken"}}
        old = imap_sync.connect
        imap_sync.connect = lambda acct, timeout=60: FakeIMAP(server)
        imap_sync.BAD.clear()
        imap_sync.RETRY_SLEEP = 0
        try:
            imap_sync.sync("icloud", self.db)
            rows = self.rows("icloud")
            self.assertEqual(sorted(rows), ["Archive:7:9"] + [f"INBOX:7:{u}" for u in (1, 2, 4, 5, 6, 7)])
            self.assertIsNone(store.get_state(self.db, "mail:icloud"))  # Broken kept the pass incomplete
            # The server briefly lists an empty INBOX: nothing may be marked deleted.
            saved = server["folders"]["INBOX"]
            server["folders"]["INBOX"] = {}
            server["unselectable"] = set()
            imap_sync.sync("icloud", self.db)
            self.assertFalse(any(r["deleted_at"] for r in self.rows("icloud").values()))
            # A real deletion is marked, and cleared again if the message comes back.
            server["folders"]["INBOX"] = {u: m for u, m in saved.items() if u != 2}
            imap_sync.sync("icloud", self.db)
            self.assertTrue(self.rows("icloud")["INBOX:7:2"]["deleted_at"])
            server["folders"]["INBOX"] = saved
            imap_sync.sync("icloud", self.db)
            self.assertIsNone(self.rows("icloud")["INBOX:7:2"]["deleted_at"])
        finally:
            imap_sync.connect = old

    def test_gmail_skips_bad_message_and_undeletes(self):
        import base64
        listing = ["m1", "m2", "m3"]

        class FakeApi:
            def __init__(self, acct):
                self.acct = acct

            def get(self, path, params=None):
                if path == "labels":
                    return {"labels": []}
                if path == "profile":
                    return {"historyId": "100"}
                if path == "messages":
                    return {"messages": [{"id": m} for m in listing]}
                if path == "history":
                    return {"historyId": "101"}
                mid = path.split("/")[1]
                if mid == "m2":
                    raise gmail_sync.HttpError(400, "bad message")
                raw = base64.urlsafe_b64encode(_eml(mid)).decode().rstrip("=")
                return {"raw": raw, "internalDate": "1792389600000", "labelIds": ["INBOX"], "threadId": "t" + mid}

        old = gmail_sync.Api
        gmail_sync.Api = FakeApi
        try:
            gmail_sync.sync("fund", self.db)
            self.assertEqual(sorted(self.rows("fund")), ["m1", "m3"])
            self.assertEqual(store.get_state(self.db, "mail:fund")["history_id"], "100")
            # A full listing that misses m3 marks it deleted; the next one that lists it clears that.
            listing[:] = ["m1"]
            gmail_sync._full(self.db, FakeApi("fund"), "fund", {}, {"added": 0, "updated": 0, "same": 0, "deleted": 0}, None)
            self.assertTrue(self.rows("fund")["m3"]["deleted_at"])
            listing[:] = []
            gmail_sync._full(self.db, FakeApi("fund"), "fund", {}, {"added": 0, "updated": 0, "same": 0, "deleted": 0}, None)
            self.assertIsNone(self.rows("fund")["m1"]["deleted_at"])  # empty listing deletes nothing
            listing[:] = ["m1", "m3"]
            gmail_sync._full(self.db, FakeApi("fund"), "fund", {}, {"added": 0, "updated": 0, "same": 0, "deleted": 0}, None)
            self.assertIsNone(self.rows("fund")["m3"]["deleted_at"])
        finally:
            gmail_sync.Api = old

    def test_gmail_outage_is_not_skipped(self):
        class DownApi:
            def __init__(self, acct):
                pass

            def get(self, path, params=None):
                if path == "labels":
                    return {"labels": []}
                if path == "profile":
                    return {"historyId": "5"}
                if path == "messages":
                    return {"messages": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}
                raise RuntimeError("gave up")

        old = gmail_sync.Api
        gmail_sync.Api = DownApi
        try:
            with self.assertRaises(RuntimeError):
                gmail_sync.sync("juno", self.db)
            self.assertIsNone(store.get_state(self.db, "mail:juno"))
        finally:
            gmail_sync.Api = old


class SearchFlagsTest(unittest.TestCase):
    def setUp(self):
        import msgs
        self.msgs = msgs
        self.calls = []
        self.old_run = search.run
        self.old_connect = store.connect
        search.run = lambda db, q, **kw: self.calls.append((q, kw)) or []
        store.connect = lambda readonly=False: None

    def tearDown(self):
        search.run = self.old_run
        store.connect = self.old_connect

    def run_cli(self, *argv):
        self.msgs.main(["search", *argv])
        return self.calls[-1]

    def test_limit_alias_sets_n(self):
        q, kw = self.run_cli("OpenTable", "--limit", "5")
        self.assertEqual(q, "OpenTable")
        self.assertEqual(kw["limit"], 5)

    def test_max_alias_and_short_flag(self):
        self.assertEqual(self.run_cli("x", "--max", "7")[1]["limit"], 7)
        self.assertEqual(self.run_cli("x", "-n", "3")[1]["limit"], 3)

    def test_since_date_becomes_after(self):
        q, _ = self.run_cli("OpenTable", "--since", "2026-10-20")
        self.assertEqual(q, "OpenTable after:2026-10-20")

    def test_since_after_alias(self):
        q, _ = self.run_cli("OpenTable", "--after", "2026-10-20")
        self.assertEqual(q, "OpenTable after:2026-10-20")

    def test_since_age_becomes_newer_than(self):
        q, _ = self.run_cli("OpenTable", "--since", "7d")
        self.assertEqual(q, "OpenTable newer_than:7d")
        q, _ = self.run_cli("OpenTable", "--since", "24h")
        self.assertEqual(q, "OpenTable newer_than:24h")
        q, _ = self.run_cli("OpenTable", "--since", "2w")
        self.assertEqual(q, "OpenTable newer_than:2w")

    def test_until_date_becomes_before(self):
        q, _ = self.run_cli("OpenTable", "--until", "2026-10-21")
        self.assertEqual(q, "OpenTable before:2026-10-21")

    def test_until_before_alias(self):
        q, _ = self.run_cli("OpenTable", "--before", "2026-10-21")
        self.assertEqual(q, "OpenTable before:2026-10-21")

    def test_bad_since_exits(self):
        with self.assertRaises(SystemExit):
            self.run_cli("OpenTable", "--since", "yesterday")
        self.assertEqual(self.calls, [])

    def test_from_and_in_flags(self):
        q, _ = self.run_cli("order", "--from", "Talabat", "--in", "imessage")
        self.assertEqual(q, 'order from:"Talabat" in:"imessage"')

    def test_plain_query_unchanged(self):
        q, kw = self.run_cli("hello", "world")
        self.assertEqual(q, "hello world")
        self.assertEqual(kw["limit"], 20)


class GuardTest(unittest.TestCase):
    def test_unmounted_volume_refuses(self):
        import common
        old = os.environ.pop("MSGS_ROOT")
        old_vol = common.VOLUME
        try:
            common.VOLUME = "/Volumes/definitely-not-mounted-xyz"
            with self.assertRaises(common.NotMounted):
                common.require_volume()
        finally:
            os.environ["MSGS_ROOT"] = old
            common.VOLUME = old_vol


if __name__ == "__main__":
    unittest.main()
