"""Index iMessage/SMS from ~/Library/Messages/chat.db (read-only).

About 90% of rows keep their text only in `attributedBody` (an NSAttributedString typedstream),
so plain SQL on `text` misses most messages. decode_attributed() pulls the string out.
Names come from the macOS Contacts databases. Reading chat.db needs Full Disk Access for the
python binary that runs this (see README).
"""
import glob
import os
import re
import sqlite3
import time

import common
import store

APPLE_EPOCH = 978307200
TAPBACK_MIN = 2000


def decode_attributed(blob):
    if not blob:
        return None
    i = blob.find(b"NSString")
    if i < 0:
        return None
    j = blob.find(b"+", i + 8, i + 16)
    if j < 0:
        return None
    p = j + 1
    if p >= len(blob):
        return None
    n = blob[p]
    p += 1
    if n == 0x81:
        n = int.from_bytes(blob[p:p + 2], "little")
        p += 2
    elif n == 0x82:
        n = int.from_bytes(blob[p:p + 4], "little")
        p += 4
    elif n == 0x83:
        n = int.from_bytes(blob[p:p + 8], "little")
        p += 8
    return blob[p:p + n].decode("utf-8", "replace")


def apple_ts(v):
    if not v:
        return 0
    return int(v / 1_000_000_000 + APPLE_EPOCH) if v > 10_000_000_000 else int(v + APPLE_EPOCH)


def digits(s):
    return re.sub(r"\D", "", s or "")


def load_contacts():
    """Map normalised phone tails and emails to display names from every local AddressBook DB."""
    by_phone, by_email = {}, {}
    paths = glob.glob(os.path.join(common.ADDRESSBOOK, "AddressBook-v22.abcddb"))
    paths += glob.glob(os.path.join(common.ADDRESSBOOK, "Sources", "*", "AddressBook-v22.abcddb"))
    for p in paths:
        try:
            db = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5)
            names = {}
            for pk, first, last, org, nick in db.execute(
                    "SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME FROM ZABCDRECORD"):
                n = " ".join(x for x in (first, last) if x) or org or nick
                if n:
                    names[pk] = n.strip()
            for owner, num in db.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER"):
                d = digits(num)
                if owner in names and len(d) >= 7:
                    by_phone.setdefault(d[-9:], names[owner])
            for owner, addr in db.execute("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS"):
                if owner in names and addr:
                    by_email.setdefault(addr.strip().lower(), names[owner])
            db.close()
        except sqlite3.Error:
            continue
    return by_phone, by_email


class Names:
    def __init__(self):
        self.phone, self.email = load_contacts()

    def handle(self, h):
        if not h:
            return None
        if "@" in h:
            return self.email.get(h.lower())
        d = digits(h)
        return self.phone.get(d[-9:]) if len(d) >= 7 else None

    def label(self, h):
        n = self.handle(h)
        return f"{n} ({h})" if n and h else (h or n)


def open_chatdb():
    return sqlite3.connect(f"file:{common.CHAT_DB}?mode=ro", uri=True, timeout=30)


def chat_names(src, names):
    """chat ROWID -> (identifier, display name)."""
    out = {}
    members = {}
    for cid, hid in src.execute("SELECT chj.chat_id, h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID=chj.handle_id"):
        members.setdefault(cid, []).append(hid)
    for cid, ident, display, style in src.execute("SELECT ROWID, chat_identifier, display_name, style FROM chat"):
        if display:
            name = display
        elif style == 43 or len(members.get(cid, [])) > 1:
            ppl = [names.handle(h) or h for h in members.get(cid, [])]
            name = ", ".join(ppl[:6]) + (f" +{len(ppl) - 6}" if len(ppl) > 6 else "")
        else:
            name = names.label(ident)
        out[cid] = (ident, name)
    return out


QUERY = """
SELECT m.ROWID, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.service, m.cache_has_attachments,
       m.date_edited, m.date_retracted, m.is_spam, h.id AS handle, cmj.chat_id
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
WHERE m.ROWID > ? AND m.associated_message_type < ? AND m.item_type = 0
ORDER BY m.ROWID
LIMIT ?
"""


def attachments(src, rowids):
    out = {}
    if not rowids:
        return out
    for i in range(0, len(rowids), 900):
        part = rowids[i:i + 900]
        q = ("SELECT maj.message_id, a.transfer_name, a.mime_type FROM message_attachment_join maj "
             "JOIN attachment a ON a.ROWID=maj.attachment_id WHERE maj.message_id IN (%s)" % ",".join("?" * len(part)))
        for mid, name, mime in src.execute(q, part):
            out.setdefault(mid, []).append(name or mime or "attachment")
    return out


def _item(row, chats, names, atts):
    rid, guid, text, ab, date, from_me, service, has_att, edited, retracted, spam, handle, chat_id = row
    body = text if text else decode_attributed(ab)
    body = (body or "").replace("\ufffc", "").strip()
    ident, cname = chats.get(chat_id, (handle, names.label(handle)))
    sender = "Me" if from_me else names.label(handle)
    return {
        "source": "imessage", "account": "imessage", "ext_id": guid, "conv": str(chat_id or ident or ""),
        "conv_name": cname, "ts": apple_ts(date), "from_me": from_me, "sender": sender,
        "sender_addr": None if from_me else handle, "recipients": None, "subject": None, "body": body,
        "folders": service, "attachments": " | ".join(atts.get(rid, [])), "path": None, "size": None,
        "junk": int(bool(spam)), "deleted_at": apple_ts(retracted) if retracted else None,
    }, rid, edited


def sync(db, stop=None, full=False):
    """Index new rows past the stored ROWID cursor; `full` rescans everything for edits and unsends."""
    stats = {"added": 0, "updated": 0, "same": 0, "deleted": 0}
    src = open_chatdb()
    names = Names()
    chats = chat_names(src, names)
    st = store.get_state(db, "imessage", {})
    if full and not (names.phone or names.email):
        # An unreadable AddressBook would rewrite every row with bare numbers; wait for the next one.
        common.log("imessage: contacts unreadable, skipping the full rescan")
        full = False
    cursor = 0 if full else int(st.get("rowid", 0))
    top = cursor
    while True:
        if stop is not None and stop.is_set():
            break
        rows = src.execute(QUERY, (cursor, TAPBACK_MIN, 5000)).fetchall()
        if not rows:
            break
        atts = attachments(src, [r[0] for r in rows if r[7]])
        batch = [_item(row, chats, names, atts) for row in rows]
        with store.writing(db):
            for it, rid, _ in batch:
                stats[store.upsert(db, it)] += 1
        cursor = batch[-1][1]
        top = max(top, cursor)
    if not full:
        # Pick up recent edits and unsends, which change rows below the cursor.
        recent_ns = int((time.time() - 3 * 86400 - APPLE_EPOCH) * 1_000_000_000)
        rows = src.execute(QUERY.replace("m.ROWID > ?", "(m.date_edited > ? OR m.date_retracted > ?)"),
                           (recent_ns, recent_ns, TAPBACK_MIN, 5000)).fetchall()
        atts = attachments(src, [r[0] for r in rows if r[7]])
        batch = [_item(row, chats, names, atts) for row in rows]
        with store.writing(db):
            for it, _, _ in batch:
                stats[store.upsert(db, it)] += 1
    st["rowid"] = max(int(st.get("rowid", 0)), top)
    st["last_ok"] = int(time.time())
    if full:
        st["last_full"] = int(time.time())
    with store.writing(db):
        store.set_state(db, "imessage", st)
    src.close()
    return stats
