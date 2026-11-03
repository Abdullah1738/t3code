"""Query parsing and ranked search over the archive.

Syntax (Gmail-like, works for every source):
  words "exact phrase" word*  a OR b  -word
  from:moni  to:amazon  subject:invoice  chat:"family"   (field filters, quotes for spaces)
  from:me  in:email|imessage|whatsapp|chats  account:gmail  after:2026-01-01  before:2026-10-01
  newer_than:30d  older_than:1y  has:attachment  is:junk  is:deleted
"""
import re
import shlex
import time
from datetime import datetime

FIELD_COLS = {"from": "sender", "to": "recipients", "subject": "subject", "chat": "conv_name",
              "file": "attachments", "body": "body"}
SOURCES = {"email": ["email"], "mail": ["email"], "imessage": ["imessage"], "sms": ["imessage"],
           "whatsapp": ["whatsapp"], "wa": ["whatsapp"], "chats": ["imessage", "whatsapp"]}
UNITS = {"d": 86400, "w": 7 * 86400, "m": 30 * 86400, "y": 365 * 86400, "h": 3600}
WEIGHTS = "5.0, 1.0, 3.0, 1.0, 2.0, 2.0"  # subject, body, sender, recipients, conv_name, attachments


class QueryError(ValueError):
    pass


def _date(v):
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m", "%Y"):
        try:
            return int(datetime.strptime(v, fmt).timestamp())
        except ValueError:
            continue
    raise QueryError(f"bad date {v!r} (use YYYY-MM-DD)")


def _span(v):
    m = re.fullmatch(r"(\d{1,5})([hdwmy])", v.lower())
    if not m:
        raise QueryError(f"bad span {v!r} (use 30d, 6m, 1y)")
    return int(m.group(1)) * UNITS[m.group(2)]


def _fts_term(t):
    star = t.endswith("*")
    t = t.rstrip("*")
    if not t:
        return None
    return '"' + t.replace('"', '""') + '"' + ("*" if star else "")


def parse(q):
    """Return (fts_expression or None, sql_where list, params list, flags dict)."""
    try:
        tokens = shlex.split(q)
    except ValueError:
        tokens = q.replace('"', " ").split()
    pos, neg, where, params = [], [], [], []
    flags = {"junk": False, "deleted": True}
    pending_or = False
    for tok in tokens:
        if tok == "OR":
            pending_or = True
            continue
        negate = tok.startswith("-") and len(tok) > 1
        if negate:
            tok = tok[1:]
        key, sep, val = tok.partition(":")
        key = key.lower()
        if sep and val and key in ("in", "source"):
            srcs = SOURCES.get(val.lower())
            if not srcs:
                raise QueryError(f"unknown source {val!r} (email, imessage, whatsapp, chats)")
            where.append(f"items.source {'NOT ' if negate else ''}IN ({','.join('?' * len(srcs))})")
            params += srcs
        elif sep and val and key == "account":
            where.append("items.account " + ("!= ?" if negate else "= ?"))
            params.append(val.lower())
        elif sep and val and key in ("after", "newer_than"):
            ts = _date(val) if key == "after" else int(time.time()) - _span(val)
            where.append("items.ts >= ?")
            params.append(ts)
            flags["min_ts"] = max(flags.get("min_ts", ts), ts)
        elif sep and val and key == "before":
            where.append("items.ts < ?")
            params.append(_date(val))
        elif sep and val and key == "older_than":
            where.append("items.ts < ?")
            params.append(int(time.time()) - _span(val))
        elif sep and key == "has" and val.lower() in ("attachment", "attachments"):
            where.append("(items.attachments IS NULL OR items.attachments = '')" if negate
                         else "(items.attachments IS NOT NULL AND items.attachments != '')")
        elif sep and key == "is" and val.lower() in ("junk", "spam"):
            flags["junk"] = True
            where.append("items.junk = " + ("0" if negate else "1"))
        elif sep and key == "is" and val.lower() == "deleted":
            where.append("items.deleted_at IS " + ("" if negate else "NOT ") + "NULL")
        elif sep and key in ("from", "to") and val.lower() == "me":
            where.append("items.from_me = " + ("0" if (key == "from") == negate else "1"))
        elif sep and val and key in FIELD_COLS:
            term = _fts_term(val)
            if term:
                expr = f"{FIELD_COLS[key]} : {term}"
                (neg if negate else pos).append(expr)
                if pending_or and not negate and len(pos) >= 2:
                    pos[-2:] = [f"({pos[-2]} OR {pos[-1]})"]
        else:
            term = _fts_term(tok if not negate else tok)
            if not term:
                continue
            if negate:
                neg.append(term)
            elif pending_or and pos:
                pos[-1] = f"({pos[-1]} OR {term})"
            else:
                pos.append(term)
        pending_or = False
    if neg and not pos:
        raise QueryError("a query needs at least one positive word next to -word")
    fts = " AND ".join(pos) if pos else None
    for n in neg:
        fts = f"({fts}) NOT {n}"
    return fts, where, params, flags


def chat_counts(db, rows):
    """{conv: total items in that WhatsApp chat} for each distinct WhatsApp chat in rows.

    Counts every item in the chat, not just the hits, so a chat with one matching voice note
    is still known to hold nothing else on this Mac. One indexed count per chat.
    """
    counts = {}
    for conv in {r["conv"] for r in rows if r["source"] == "whatsapp" and r["conv"]}:
        counts[conv] = db.execute(
            "SELECT count(*) FROM items WHERE source = 'whatsapp' AND conv = ?", (conv,)).fetchone()[0]
    return counts


STUB_MAX = 3  # a WhatsApp chat with this many messages or fewer on the Mac is a stub


def chat_sizes(db, rows):
    """{conv: count} for WhatsApp chats in rows that are stubs on this Mac."""
    return {c: n for c, n in chat_counts(db, rows).items() if n <= STUB_MAX}


def run(db, q, limit=20, sort="rank", include_junk=False, dedupe=True):
    fts, where, params, flags = parse(q)
    if not include_junk and not flags["junk"]:
        where.append("items.junk = 0")
    if fts and flags.get("min_ts") is not None:
        own_transaction = not db.in_transaction
        if own_transaction:
            db.execute("BEGIN")
        try:
            floor = db.execute("SELECT min(id) FROM items INDEXED BY items_ts WHERE ts >= ?",
                               (flags["min_ts"],)).fetchone()[0]
            if floor is None:
                return []
            # Every row inside the window has id >= its minimum, including backfills.
            # Keep both reads on one snapshot in case a sync changes an older row's timestamp.
            return _run(db, fts, where, params, limit, sort, dedupe, floor)
        finally:
            if own_transaction:
                db.rollback()
    return _run(db, fts, where, params, limit, sort, dedupe)


def _run(db, fts, where, params, limit, sort, dedupe, floor=None):
    now = int(time.time())
    if fts:
        sql = (f"SELECT items.*, snippet(items_fts, -1, '[', ']', '...', 14) AS snip, "
               f"bm25(items_fts, {WEIGHTS}) AS score FROM items_fts JOIN items ON items.id = items_fts.rowid "
               f"WHERE items_fts MATCH ?")
        args = [fts]
        if floor is not None:
            sql += " AND items_fts.rowid >= ?"
            args.append(floor)
        args += params
    else:
        sql = "SELECT items.*, substr(COALESCE(items.body, ''), 1, 160) AS snip, 0.0 AS score FROM items WHERE 1"
        args = list(params)
    for w in where:
        sql += f" AND ({w})"
    if sort == "date" or not fts:
        sql += " ORDER BY items.ts DESC"
    else:
        # bm25 is negative (lower is better); older hits lose up to half their weight over three years.
        sql += " ORDER BY score / (1.0 + max(0, ? - items.ts) / 94608000.0) ASC"
        args.append(now)
    sql += " LIMIT ?"
    args.append(limit * 4 if dedupe else limit)
    out, seen = [], set()
    for r in db.execute(sql, args):
        key = (r["msgid"] or "").lower() if r["source"] == "email" and r["msgid"] else None
        if dedupe and key:
            if key in seen:
                continue
            seen.add(key)
        out.append(r)
        if len(out) >= limit:
            break
    return out
