"""Copy WhatsApp messages from the wacli store (~/.wacli/wacli.db) into the archive.

wacli.db is opened read-only and never written. wacli already keeps its own FTS index; copying
the rows here lets one query cover every source, and keeps messages if the wacli store is reset.
"""
import sqlite3
import time

import common
import store
from imessage_sync import Names

QUERY = """
SELECT m.rowid, m.chat_jid, COALESCE(c.name, m.chat_name), m.msg_id, m.sender_jid, m.sender_name, m.ts, m.from_me,
       m.text, m.display_text, m.media_type, m.media_caption, m.filename, m.revoked, m.deleted_at, m.edited_ts,
       m.reaction_emoji, m.reaction_to_id, c.kind
FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
WHERE m.rowid > ?
ORDER BY m.rowid
LIMIT ?
"""


def _contacts(src):
    out = {}
    for jid, full, first, push, biz, system in src.execute(
            "SELECT jid, full_name, first_name, push_name, business_name, system_name FROM contacts"):
        n = full or system or first or push or biz
        if n:
            out[jid] = n
    try:
        for jid, alias in src.execute("SELECT jid, alias FROM contact_aliases WHERE alias IS NOT NULL AND alias != ''"):
            out[jid] = alias
    except sqlite3.Error:
        pass
    return out


def _phone_name(jid, names):
    if jid and jid.endswith("@s.whatsapp.net"):
        return names.handle("+" + jid.split("@")[0].split(":")[0])
    return None


def _item(row, contacts, names):
    (rid, chat, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display, media, caption,
     filename, revoked, deleted_at, edited_ts, emoji, reaction_to, kind) = row
    if reaction_to or emoji:
        return None
    # A revoked row's display_text is a placeholder; leave the body empty so the archived text stays.
    body = (text or "") if revoked or deleted_at else (text or display or "")
    if caption and caption not in body:
        body = f"{body}\n{caption}".strip()
    name = chat_name or contacts.get(chat) or _phone_name(chat, names) or chat
    sender = "Me" if from_me else (contacts.get(sender_jid) or _phone_name(sender_jid, names) or sender_name or sender_jid)
    return {
        "source": "whatsapp", "account": "whatsapp", "ext_id": f"{chat}/{msg_id}", "conv": chat, "conv_name": name,
        "ts": ts or 0, "from_me": from_me, "sender": sender, "sender_addr": None if from_me else sender_jid,
        "recipients": None, "subject": None, "body": body, "folders": kind,
        "attachments": " | ".join(x for x in (media, filename) if x), "path": None, "size": None, "junk": 0,
        "deleted_at": deleted_at or ((edited_ts or ts) if revoked else None),
    }


def sync(db, stop=None, full=False):
    stats = {"added": 0, "updated": 0, "same": 0, "deleted": 0}
    src = sqlite3.connect(f"file:{common.WACLI_DB}?mode=ro", uri=True, timeout=30)
    contacts = _contacts(src)
    names = Names()
    st = store.get_state(db, "whatsapp", {})
    cursor = 0 if full else int(st.get("rowid", 0))
    top = cursor
    while not (stop is not None and stop.is_set()):
        rows = src.execute(QUERY, (cursor, 5000)).fetchall()
        if not rows:
            break
        batch = [it for it in (_item(row, contacts, names) for row in rows) if it]
        with store.writing(db):
            for it in batch:
                stats[store.upsert(db, it)] += 1
        cursor = rows[-1][0]
        top = max(top, cursor)
    if not full:
        # Edits and deletions update rows below the cursor.
        since = int(time.time()) - 3 * 86400
        rows = src.execute(QUERY.replace("m.rowid > ?", "(m.edited_ts > ? OR m.deleted_at > ? OR m.revoked = 1) AND m.ts > ?"),
                           (since, since, since - 30 * 86400, 5000)).fetchall()
        batch = [it for it in (_item(row, contacts, names) for row in rows) if it]
        with store.writing(db):
            for it in batch:
                stats[store.upsert(db, it)] += 1
    st["rowid"] = max(int(st.get("rowid", 0)), top)
    st["last_ok"] = int(time.time())
    with store.writing(db):
        store.set_state(db, "whatsapp", st)
    src.close()
    return stats
