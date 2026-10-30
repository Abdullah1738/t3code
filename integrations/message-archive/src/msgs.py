"""msgs: one search over the local email mirror, iMessage and WhatsApp.

  msgs QUERY                      ranked search (see `msgs help-query`)
  msgs search QUERY [-n N|--limit N] [--since X] [--until X] [--from X] [--in X] [--date] [--json] [--junk] [--all-copies]
  msgs show ID [--raw] [--html]   full message (email from the local .eml), chat lines around it
  msgs thread ID [-n N]           whole email thread or N chat lines either side
  msgs status [--json]            counts and last sync per source
  msgs sync [SOURCE...] [--full]  one pass now (email accounts, imessage, whatsapp)
  msgs daemon                     keep everything current (LaunchAgent com.ardud.message-archive)
"""
import argparse
import fcntl
import json
import os
import re
import signal
import stat
import sys
import threading
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import common  # noqa: E402
import mailparse  # noqa: E402
import search  # noqa: E402
import store  # noqa: E402

MAIL_EVERY = 180
CHAT_EVERY = 30
IMESSAGE_FULL_EVERY = 6 * 3600
MAIL_FULL_EVERY = 24 * 3600


def fmt_ts(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "????-??-?? ??:??"


def one_line(s, n):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def where(r):
    return r["account"] if r["source"] == "email" else r["source"]


def print_hit(r):
    who = "Me" if r["from_me"] and r["source"] != "email" else (r["sender"] or "")
    if r["source"] == "email":
        head = f"{one_line(who, 40)}: {one_line(r['subject'], 90)}"
    else:
        head = f"{one_line(r['conv_name'], 40)} / {one_line(who, 30)}"
    flags = "".join([" [junk]" if r["junk"] else "", " [deleted]" if r["deleted_at"] else ""])
    print(f"{r['id']:>8}  {fmt_ts(r['ts'])}  {where(r):<9} {head}{flags}")
    snip = one_line(r["snip"], 160)
    if snip:
        print(f"{'':>10}{snip}")


def row_json(r):
    d = {k: r[k] for k in r.keys() if k not in ("body",)}
    d["date"] = fmt_ts(r["ts"])
    return d


def _when_term(flag, v, since):
    if since and re.fullmatch(r"\d{1,5}[hdwmy]", v, re.I):
        return f"newer_than:{v}"
    try:
        search._date(v)
    except search.QueryError:
        if since:
            sys.exit(f"msgs: {flag} expects YYYY-MM-DD or an age like 7d, 24h, 2w, 3m, 1y")
        if re.fullmatch(r"\d{1,5}[hdwmy]", v, re.I):
            return f"older_than:{v}"
        sys.exit(f"msgs: {flag} expects YYYY-MM-DD or an age like 7d, 24h, 2w, 3m, 1y")
    return f"{'after' if since else 'before'}:{v}"


def _search_query(args):
    parts = [" ".join(args.query)]
    if args.since:
        parts.append(_when_term("--since", args.since, True))
    if args.until:
        parts.append(_when_term("--until", args.until, False))
    if args.from_:
        parts.append('from:"%s"' % args.from_.replace('"', ""))
    if args.in_:
        parts.append('in:"%s"' % args.in_.replace('"', ""))
    return " ".join(p for p in parts if p)


def cmd_search(args):
    db = store.connect(readonly=True)
    q = _search_query(args)
    t = time.time()
    try:
        rows = search.run(db, q, limit=args.n, sort="date" if args.date else "rank",
                          include_junk=args.junk, dedupe=not args.all_copies)
    except search.QueryError as e:
        sys.exit(f"msgs: {e}")
    counts = search.chat_counts(db, rows)
    if args.json:
        for r in rows:
            d = row_json(r)
            if r["source"] == "whatsapp" and r["conv"] in counts:
                d["chat_messages"] = counts[r["conv"]]
                d["stub"] = counts[r["conv"]] <= search.STUB_MAX
            print(json.dumps(d, ensure_ascii=False))
    else:
        for r in rows:
            print_hit(r)
        for conv, n in counts.items():
            if n > search.STUB_MAX:
                continue
            name = next((r["conv_name"] for r in rows if r["conv"] == conv and r["conv_name"]), None) or conv
            print(f'note: WhatsApp chat "{name}" has only {n} message(s) on this Mac; the rest is on the phone. '
                  f"Fetch older history: wa read {conv} --more 2", file=sys.stderr)
        print(f"-- {len(rows)} hit(s) in {time.time() - t:.2f}s", file=sys.stderr)


def _get(db, ident):
    r = db.execute("SELECT * FROM items WHERE id=?", (ident,)).fetchone()
    if r is None:
        sys.exit(f"msgs: no item {ident}")
    return r


def cmd_show(args):
    db = store.connect(readonly=True)
    r = _get(db, args.id)
    if r["source"] == "email":
        try:
            raw = mailparse.load_raw(r["path"]) if r["path"] else None
        except Exception as e:  # missing, truncated or corrupt .eml.zst
            print(f"(raw file unreadable: {type(e).__name__}; showing the indexed text)", file=sys.stderr)
            raw = None
        if args.raw and raw:
            sys.stdout.buffer.write(raw)
            return
        body = r["body"]
        if raw:
            p = mailparse.parse(raw)
            body = p["body"]
            if args.html:
                import email
                msg = email.message_from_bytes(raw)
                for part in msg.walk():
                    if part.get_content_type() == "text/html":
                        body = mailparse._part_text(part)
                        break
        copies = db.execute("SELECT account, folders FROM items WHERE msgid=? AND id!=?", (r["msgid"], r["id"])).fetchall() \
            if r["msgid"] else []
        print(f"Account: {r['account']}   Folder: {r['folders']}{'   (deleted on server)' if r['deleted_at'] else ''}")
        if copies:
            print("Also in: " + "; ".join(f"{c['account']}:{c['folders']}" for c in copies))
        print(f"Date:    {fmt_ts(r['ts'])}\nFrom:    {r['sender']}\nTo:      {r['recipients']}\nSubject: {r['subject']}")
        if r["attachments"]:
            print(f"Files:   {r['attachments']}")
        print(f"File:    {os.path.join(common.MAIL_DIR, r['path']) if r['path'] else '-'}\n")
        print(body)
    else:
        _chat_context(db, r, args.n if hasattr(args, "n") else 5)


def _chat_context(db, r, n):
    before = db.execute("SELECT * FROM items WHERE source=? AND conv=? AND (ts < ? OR (ts = ? AND id < ?)) "
                        "ORDER BY ts DESC, id DESC LIMIT ?", (r["source"], r["conv"], r["ts"], r["ts"], r["id"], n)).fetchall()
    after = db.execute("SELECT * FROM items WHERE source=? AND conv=? AND (ts > ? OR (ts = ? AND id > ?)) "
                       "ORDER BY ts, id LIMIT ?", (r["source"], r["conv"], r["ts"], r["ts"], r["id"], n)).fetchall()
    print(f"{r['source']}: {r['conv_name']}\n")
    for x in list(reversed(before)) + [r] + after:
        mark = ">" if x["id"] == r["id"] else " "
        who = "Me" if x["from_me"] else (x["sender"] or "?")
        extra = f" [{x['attachments']}]" if x["attachments"] else ""
        print(f"{mark} {x['id']:>8} {fmt_ts(x['ts'])} {who}: {x['body'] or ''}{extra}")


def cmd_thread(args):
    db = store.connect(readonly=True)
    r = _get(db, args.id)
    if r["source"] != "email":
        _chat_context(db, r, args.n)
        return
    if r["conv"]:
        rows = db.execute("SELECT * FROM items WHERE source='email' AND account=? AND conv=? ORDER BY ts",
                          (r["account"], r["conv"])).fetchall()
    else:
        subj = (r["subject"] or "").lower()
        for p in ("re:", "fwd:", "fw:"):
            while subj.startswith(p):
                subj = subj[len(p):].strip()
        rows = db.execute("SELECT * FROM items WHERE source='email' AND account=? AND lower(subject) LIKE ? "
                          "ORDER BY ts", (r["account"], f"%{subj}%")).fetchall() if subj else [r]
    seen = set()
    for x in rows:
        k = x["msgid"] or x["id"]
        if k in seen:
            continue
        seen.add(k)
        print(f"{'>' if x['id'] == r['id'] else ' '} {x['id']:>8} {fmt_ts(x['ts'])} {one_line(x['sender'], 40)}: "
              f"{one_line(x['body'], 140)}")


def cmd_status(args):
    db = store.connect(readonly=True)
    rows = db.execute("SELECT source, account, count(*) n, sum(deleted_at IS NOT NULL) del, min(ts) lo, max(ts) hi, "
                      "sum(COALESCE(size, 0)) bytes FROM items GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
    states = {r["key"]: (json.loads(r["value"] or "{}"), r["updated_at"]) for r in db.execute("SELECT * FROM sync_state")}
    out = []
    for r in rows:
        key = f"mail:{r['account']}" if r["source"] == "email" else r["source"]
        st = states.get(key, ({}, None))[0]
        out.append({"source": r["source"], "account": r["account"], "messages": r["n"], "deleted": r["del"],
                    "oldest": fmt_ts(r["lo"]), "newest": fmt_ts(r["hi"]), "raw_mb": round((r["bytes"] or 0) / 1e6),
                    "last_sync": fmt_ts(st.get("last_ok")) if st.get("last_ok") else "never"})
    if args.json:
        print(json.dumps(out, indent=1))
        return
    for o in out:
        print(f"{o['source']:<9}{o['account']:<10}{o['messages']:>8} msgs {o['deleted']:>6} deleted  "
              f"{o['oldest'][:10]}..{o['newest'][:10]}  {o['raw_mb']:>6} MB raw  synced {o['last_sync']}")
    size = sum(os.path.getsize(common.DB_PATH + s) for s in ("", "-wal") if os.path.exists(common.DB_PATH + s))
    print(f"index {size / 1e9:.2f} GB at {common.DB_PATH}")


class Locked(RuntimeError):
    pass


def lock(name):
    d = os.path.join(common.ROOT, "locks")
    os.makedirs(d, mode=0o700, exist_ok=True)
    f = open(os.path.join(d, f"{name}.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        raise Locked(name)
    return f


def sync_one(name, stop=None, full=False):
    common.require_volume()
    lk = lock(name)
    db = store.connect()
    try:
        t = time.time()
        if name == "imessage":
            import imessage_sync
            stats = imessage_sync.sync(db, stop=stop, full=full)
        elif name == "whatsapp":
            import whatsapp_sync
            stats = whatsapp_sync.sync(db, stop=stop, full=full)
        elif common.MAIL_ACCOUNTS[name]["kind"] == "gmail":
            import gmail_sync
            if full:
                with store.writing(db):
                    st = store.get_state(db, f"mail:{name}", {})
                    st.pop("history_id", None)
                    store.set_state(db, f"mail:{name}", st)
            stats = gmail_sync.sync(name, db, stop=stop)
        else:
            import imap_sync
            stats = imap_sync.sync(name, db, stop=stop)
        stats["secs"] = round(time.time() - t, 1)
        return stats
    finally:
        db.close()
        lk.close()


def cmd_sync(args):
    names = args.sources or list(common.MAIL_ACCOUNTS) + list(common.CHAT_SOURCES)
    bad = [n for n in names if n not in common.MAIL_ACCOUNTS and n not in common.CHAT_SOURCES]
    if bad:
        sys.exit(f"msgs: unknown source {', '.join(bad)}")
    rc = 0
    for n in names:
        try:
            print(f"{n}: {sync_one(n, full=args.full)}", flush=True)
        except Locked:
            print(f"{n}: busy (the daemon is syncing it)")
        except Exception as e:
            rc = 1
            print(f"{n}: ERROR {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(rc)


def _loop(name, every, stop, full_every=None):
    last_full = 0.0
    backoff = every
    while not stop.is_set():
        if not common.volume_ready():
            stop.wait(60)
            continue
        full = bool(full_every) and time.time() - last_full > full_every
        try:
            stats = sync_one(name, stop=stop, full=full and last_full > 0)
            if full:
                last_full = time.time()
            if stats.get("added") or stats.get("deleted") or stats.get("updated") or stats["secs"] > 30:
                common.log(f"{name}: {stats}")
            backoff = every
        except Locked:
            pass
        except Exception as e:
            common.log(f"{name}: ERROR {type(e).__name__}: {e}")
            backoff = min(backoff * 2, 3600)
        stop.wait(backoff)


def cmd_daemon(args):
    stop = threading.Event()

    def handle(sig, frame):
        common.log(f"signal {sig}, stopping")
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    for fd in (1, 2):  # launchd creates the log files 0644 before our umask applies
        try:
            if stat.S_ISREG(os.fstat(fd).st_mode):
                os.fchmod(fd, 0o600)
        except OSError:
            pass
    common.log(f"daemon start, archive {common.ROOT}")
    threads = [threading.Thread(target=_loop, args=("imessage", CHAT_EVERY, stop, IMESSAGE_FULL_EVERY), daemon=True),
               threading.Thread(target=_loop, args=("whatsapp", CHAT_EVERY, stop, IMESSAGE_FULL_EVERY), daemon=True)]
    for a, cfg in common.MAIL_ACCOUNTS.items():
        full_every = MAIL_FULL_EVERY if cfg["kind"] == "gmail" else None
        threads.append(threading.Thread(target=_loop, args=(a, MAIL_EVERY, stop, full_every), daemon=True))
    for t in threads:
        t.start()
    while not stop.is_set():
        stop.wait(5)
    for t in threads:
        t.join(timeout=60)
    common.log("daemon stopped")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmds = {"search", "show", "thread", "status", "sync", "daemon", "help-query"}
    if argv and argv[0] not in cmds and not argv[0].startswith("-"):
        argv.insert(0, "search")
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return
    ap = argparse.ArgumentParser(prog="msgs")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query", nargs="+")
    s.add_argument("-n", "--limit", "--max", dest="n", type=int, default=20)
    s.add_argument("--since", "--after", dest="since", metavar="X", help="YYYY-MM-DD or age like 7d, 24h, 2w")
    s.add_argument("--until", "--before", dest="until", metavar="X", help="YYYY-MM-DD or age like 7d, 24h, 2w")
    s.add_argument("--from", dest="from_", metavar="X", help="sender filter (same as from:X)")
    s.add_argument("--in", "--source", dest="in_", metavar="X", help="email, imessage, whatsapp or chats")
    s.add_argument("--date", action="store_true", help="newest first instead of best match")
    s.add_argument("--json", action="store_true")
    s.add_argument("--junk", action="store_true", help="include spam/junk")
    s.add_argument("--all-copies", action="store_true", help="don't fold the same email found in several folders")
    s.set_defaults(fn=cmd_search)
    s = sub.add_parser("show")
    s.add_argument("id", type=int)
    s.add_argument("--raw", action="store_true")
    s.add_argument("--html", action="store_true")
    s.add_argument("-n", type=int, default=5)
    s.set_defaults(fn=cmd_show)
    s = sub.add_parser("thread")
    s.add_argument("id", type=int)
    s.add_argument("-n", type=int, default=25)
    s.set_defaults(fn=cmd_thread)
    s = sub.add_parser("status")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_status)
    s = sub.add_parser("sync")
    s.add_argument("sources", nargs="*")
    s.add_argument("--full", action="store_true", help="rescan everything (edits, deletions)")
    s.set_defaults(fn=cmd_sync)
    s = sub.add_parser("daemon")
    s.set_defaults(fn=cmd_daemon)
    s = sub.add_parser("help-query")
    s.set_defaults(fn=lambda a: print(search.__doc__.strip()))
    args = ap.parse_args(argv)
    try:
        args.fn(args)
    except common.NotMounted as e:
        sys.exit(f"msgs: {e}")
    except BrokenPipeError:
        pass


if __name__ == "__main__":
    main()
