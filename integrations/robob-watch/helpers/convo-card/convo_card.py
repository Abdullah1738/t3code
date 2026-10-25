#!/usr/bin/python3
"""convo-card: a live WhatsApp conversation card (an iMessage app card) for one chat.

Use the defaults. Every option has one; don't stop to ask which to pick.

    convo-card build --chat NUMBER|JID [--slug SLUG] [--title T] [--me NAME] [--them NAME]
                     [--subtitle T] [--since ISO | --days N] [--dry-run]
        Read the chat from wacli's store (read only), download its photos and rebuild the card folder.
        Later runs need only --slug; options you pass are saved for next time.
    convo-card translate --slug SLUG --id MSGID (--text ENGLISH | --none) [--caption LABEL] [--by WHO]
        Store the English for one message, bound to that exact message (its id + sha256 of its exact text,
        caption or photo bytes). If the message changes, the translation stops showing and send refuses again.
        Every photo and every message that isn't plainly English waits for this. Look at each one first
        (`show` prints the photo path); --none = nothing in it to translate (English already).
    convo-card send --slug SLUG --session S [--to CHAT] [--days N] [--dry-run]
        Rebuilds, refuses while any translation is pending or stale, runs `card-check page`, then shares
        the page and sends ONE live app card (`app --to CHAT`), keyed per last message + page URL, so
        a repeat is a no-op. CHAT defaults to owner (Abdullah); S = the CURRENT session id of the chat
        you are in. It never sends WhatsApp and never sends a picture of the chat.
    convo-card show --slug SLUG       config, pending items (with photo paths), send journal
    convo-card watch --slug SLUG      watcher check (state in $WATCH_DIR): prints CONVO_CARD_UPDATE once
        a burst of new messages has been quiet for 2 min, CONVO_CARD_SHARE_DOWN when a shared link
        fails twice in a row. Exits 1 while the wacli sync daemon is down. Under robob-watch ($WATCH_RUN) an
        event the runner never recorded is printed again (.convo-outbox.json in the state dir).

Card folder ~/.local/share/imessage-apps/<slug>/ (served): index.html, data.json, preview.png, media/.
The page re-reads data.json every 25s, so a rebuild shows up on the open card by itself.
Private dotfiles in the same folder (the bridge never serves dot paths): .convo.json (config),
.messages.json, .translations.json, .sent.json, .preview-key, .lock.

Env overrides: CONVO_CARD_ROOT, CONVO_CARD_BRIDGE (bridge CLI command, space separated),
CONVO_CARD_WACLI, CONVO_CARD_CHECK, CONVO_CARD_PREVIEW_LIB, CONVO_CARD_NO_IMAGE=1 (skip Chrome, tests),
WACLI_STORE_DIR.
"""
import argparse, fcntl, hashlib, html, json, os, re, shlex, shutil, subprocess, sys, tempfile, time
import importlib.util, unicodedata, urllib.request
from importlib.machinery import SourceFileLoader
from datetime import datetime, timezone, timedelta
from pathlib import Path

HOME = Path.home()
HERE = Path(__file__).resolve().parent
DXB = timezone(timedelta(hours=4))
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")      # bridge app slug
CHAT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")     # bridge chat slug
SESSION_RE = re.compile(r"^[A-Za-z0-9:_@.-]{6,200}$")
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
QUIET_S = 120
PROBE_S = 600
OUTBOX_TTL = 3600         # an event the runner never recorded is printed again for up to an hour,
OUTBOX_MAX_REPLAYS = 3    # at most this many times (same rule as wa-db's whatsapp-new-message outbox)
LABELS = {"audio": "Voice message", "ptt": "Voice message", "video": "Video", "gif": "GIF",
          "sticker": "Sticker", "document": "Document", "location": "Location",
          "live_location": "Live location"}
# A card's subcaption is frozen in the chat while the page keeps changing, so it never carries a time or date.
# The default is a fixed phrase; an override with a digit or one of these words is refused.
NO_TIME = re.compile(r"\d|\b(today|tonight|tomorrow|yesterday|now|ago|noon|midnight|morning|evening|afternoon|"
                     r"night|week(end)?|month|(mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?|"
                     r"jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|"
                     r"oct(ober)?|nov(ember)?|dec(ember)?)\b", re.I)
WORDS_FILE = "/usr/share/dict/words"
CHAT_WORDS = {"ok", "okay", "thx", "pls", "plz", "lol", "yeah", "yep", "nope", "hi", "hey", "bye", "omg", "btw"}
STEMS = (("ies", "y"), ("ied", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e"),
         ("ly", ""), ("er", ""), ("er", "e"), ("est", ""), ("est", "e"))


def die(msg, code=2):
    print(f"convo-card: {msg}", file=sys.stderr)
    sys.exit(code)


def _cmd(env, default):
    v = os.environ.get(env)
    return shlex.split(v) if v else default


def root():
    return Path(os.environ.get("CONVO_CARD_ROOT") or HOME / ".local/share/imessage-apps")


def wacli_cmd():
    return _cmd("CONVO_CARD_WACLI", [str(HOME / ".local/bin/wacli")])


def bridge_cmd():
    return _cmd("CONVO_CARD_BRIDGE", ["/Users/ardud/.bun/bin/bun", str(HOME / ".local/share/spectrum-bridge/src/cli.ts")])


def check_cmd():
    return _cmd("CONVO_CARD_CHECK", [str(HOME / ".local/bin/card-check")])


def wadb():
    """The sibling wa-db helper (no .py suffix), for its read-only store access and name lookup."""
    path = str(HERE.parent / "wa-db")
    loader = SourceFileLoader("wadb", path)
    spec = importlib.util.spec_from_loader("wadb", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def atomic_write(path, data, mode="w"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, mode) as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(path, obj):
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else str(p).encode())
        h.update(b"\0")
    return h.hexdigest()


def clean(s, n=None):
    s = re.sub(r"[\x00-\x1f\x7f]+", " ", str(s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    if n and len(s) > n:
        s = s[: n - 1].rstrip() + "…"
    return s


_words = None


def english_words():
    global _words
    if _words is None:
        try:
            with open(WORDS_FILE, errors="replace") as f:
                _words = {w.strip().lower() for w in f}
        except OSError:
            _words = set()    # no word list: every message with letters gets reviewed
    return _words


def known_word(w, names):
    if w in names or w in CHAT_WORDS:
        return True
    words = english_words()
    if w in words:
        return True
    for suf, rep in STEMS:
        if w.endswith(suf) and len(w) - len(suf) >= 2:
            b = w[: -len(suf)] + rep
            if b in words or (not rep and len(b) > 2 and b[-1] == b[-2] and b[:-1] in words):
                return True
    return False


def needs_review(s, names=()):
    """True unless the text is confidently English: only ASCII letters, and every word is in the system word
    list (simple suffixes stripped) or is a chat name. Emoji, digits and punctuation alone need nothing.
    A false alarm costs one `translate --none`; a miss shows an untranslated message as done."""
    s = (s or "").replace("\u2019", "'")
    if any(ch.isalpha() and ord(ch) > 127 for ch in s):
        return True
    s = re.sub(r"'(s|t|re|ll|ve|d|m)\b", "", s.lower())
    return not all(known_word(w, names) for w in re.findall(r"[a-z]+", s))


def chat_names(cfg):
    return {w for n in (cfg["me"], cfg["them"], cfg["title"], "Abdullah") for w in re.findall(r"[a-z]+", n.lower())}


def local(ts):
    return datetime.fromtimestamp(ts, DXB)


class Lock:
    def __init__(self, d):
        self.path = Path(d) / ".lock"

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.f = open(self.path, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def card_dir(slug):
    if not SLUG_RE.match(slug or ""):
        die(f"bad --slug {slug!r}: lowercase letters, digits and dashes, up to 64")
    return root() / slug


def slugify(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40]


# ---------- config ----------

def identify(chat):
    """(main jid, every jid the chat is stored under, display name) for --chat."""
    w = wadb()
    jid = w.norm(chat)
    if not re.match(r"^[0-9]+@(s\.whatsapp\.net|lid|g\.us)$", jid):
        die(f"bad --chat {chat!r}: a phone number or a WhatsApp JID")
    con = w.connect()
    try:
        jids = w.resolve(con, jid)
        main = next((j for j in jids if j.endswith("@s.whatsapp.net")), jid)
        if main.endswith("@g.us"):
            row = con.execute("select coalesce(name,'') from chats where jid=?", (main,)).fetchone()
            name = row[0] if row else ""
        else:
            name = w.name_of(con, main)
    finally:
        con.close()
    if not any(ch.isalpha() for ch in name or ""):   # an emoji-only push name is no name
        name = "Group chat" if main.endswith("@g.us") else "+" + main.split("@")[0]
    return main, jids, clean(name, 40)


def resolve_config(a, d, ident=None):
    """Saved config + whatever this run passed. First build needs --chat; the rest has defaults."""
    cfg = read_json(d / ".convo.json", {})
    if a.chat:
        main, jids, name = ident or identify(a.chat)
        if cfg.get("chat") not in (None, main):
            die(f"{d.name} already belongs to {cfg['chat']}; pick another --slug for {main}")
        cfg["chat"], cfg["jids"] = main, jids
        cfg.setdefault("them", name)
    if not cfg.get("chat"):
        die("first build needs --chat NUMBER|JID")
    for k in ("title", "me", "them", "subtitle"):
        v = getattr(a, k, None)
        if v is not None:
            cfg[k] = clean(v, 60)
    cfg.setdefault("me", "Abdullah")
    cfg.setdefault("title", cfg["them"])
    cfg.setdefault("subtitle", "via Abdullah's WhatsApp")
    since = getattr(a, "since", None)
    if since:
        try:
            dt = datetime.fromisoformat(since)
        except ValueError:
            die(f"bad --since {since!r}: ISO time like 2026-10-24T00:00+04:00")
        cfg["since"] = int((dt if dt.tzinfo else dt.replace(tzinfo=DXB)).timestamp())
    elif "since" not in cfg or getattr(a, "days", None):
        days = getattr(a, "days", None) or 3
        start = datetime.now(DXB).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
        cfg["since"] = int(start.timestamp())
    return cfg


# ---------- messages ----------

def download(chat, msg_id, media_dir, dry_run):
    """media/<id>.<ext>; reuses a file that is already there. None when wacli can't get it."""
    if not ID_RE.match(msg_id):
        return None
    have = sorted(p for p in media_dir.glob(msg_id + ".*") if not p.name.startswith("."))
    if have:
        return have[0]
    if dry_run:
        return None
    media_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=media_dir, prefix=".dl-"))
    try:
        p = subprocess.run([*wacli_cmd(), "--read-only", "media", "download", "--chat", chat, "--id", msg_id,
                            "--output", str(tmp) + "/"], capture_output=True, text=True, timeout=180,
                           stdin=subprocess.DEVNULL)
        files = [f for f in tmp.iterdir() if f.is_file()]
        if p.returncode != 0 or not files:
            print(f"convo-card: photo {msg_id} not downloaded: {(p.stderr or p.stdout).strip()[:200]}", file=sys.stderr)
            return None
        ext = files[0].suffix.lower() or ".jpg"
        dest = media_dir / (msg_id + ext)
        os.replace(files[0], dest)
        os.chmod(dest, 0o644)
        return dest
    except (OSError, subprocess.SubprocessError) as e:
        print(f"convo-card: photo {msg_id} not downloaded: {e}", file=sys.stderr)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch(cfg, d, dry_run=False):
    """The chat since cfg.since as private message records, oldest first."""
    w = wadb()
    con = w.connect()
    group = cfg["chat"].endswith("@g.us")
    q = ",".join("?" * len(cfg["jids"]))
    rows = con.execute(
        f"select rowid, chat_jid, msg_id, coalesce(sender_jid,''), coalesce(sender_name,''), from_me, ts,"
        f" coalesce(text,''), coalesce(display_text,''), lower(coalesce(media_type,'')), coalesce(media_caption,''),"
        f" coalesce(filename,''), coalesce(reaction_to_id,''), coalesce(revoked,0), coalesce(deleted_for_me,0)"
        f" from messages where chat_jid in ({q}) and ts >= ? order by ts, rowid", (*cfg["jids"], cfg["since"])).fetchall()
    names = chat_names(cfg)
    out = {}
    for (rowid, chat_jid, msg_id, sender, sender_name, from_me, ts, text, display, media, caption, filename,
         reaction, revoked, deleted) in rows:
        if reaction or revoked or deleted or not msg_id:
            continue
        if from_me:
            side, who, frm = "out", cfg["me"], "me"
        elif group:
            num = sender.split("@")[0]
            who = clean(w.name_of(con, sender) or sender_name or ("+" + num if sender.endswith("@s.whatsapp.net")
                                                                 else "Someone"), 40)
            side, frm = "in", sha(sender)[:8]
        else:
            side, who, frm = "in", cfg["them"], "them"
        m = {"rowid": rowid, "id": msg_id, "side": side, "who": who, "from": frm, "ts": int(ts)}
        # A translation is bound to the message id and the exact source (raw text, caption, photo bytes): any
        # change, or a translation copied from another message, no longer matches.
        if media == "image":
            raw = caption or text
            path = download(chat_jid, msg_id, d / "media", dry_run)
            m.update(type="image", caption=raw.strip())
            if path:
                m["image"] = "media/" + path.name
                m["sha"] = sha("image", msg_id, path.read_bytes(), raw)
            else:
                m["sha"] = sha("image-missing", msg_id, raw)
            m["needs"] = True    # a photo can carry text in any language, so someone always has to look at it
        elif media:
            label = LABELS.get(media, "Attachment")
            if media == "document" and filename:
                label += ": " + clean(filename, 60)
            raw = caption or text
            m.update(type="other", label=label, caption=raw.strip(), sha=sha("other", msg_id, label, raw),
                     needs=needs_review(raw, names))
        else:
            raw = text if text.strip() else display
            if not raw.strip():
                continue
            m.update(type="text", text=raw.strip(), sha=sha("text", msg_id, raw), needs=needs_review(raw, names))
        out[msg_id] = m
    con.close()
    return sorted(out.values(), key=lambda m: (m["ts"], m["rowid"]))


def compose(cfg, msgs, translations, now=None):
    """data.json for the page, plus the pending list (missing or stale translations)."""
    items, pending = [], []
    for m in msgs:
        e = translations.get(m["id"])
        ok = bool(e) and e.get("sha") == m["sha"]
        t = local(m["ts"])
        it = {"id": m["id"], "side": m["side"], "who": m["who"], "from": m.get("from") or m["side"],
              "time": t.strftime("%H:%M"), "day": t.strftime("%a %d %b"), "ts": m["ts"], "type": m["type"]}
        for k in ("text", "image", "caption", "label"):
            if m.get(k):
                it[k] = m[k]
        if ok and e.get("caption") and not it.get("caption"):
            it["caption"] = e["caption"]
        if ok and e.get("text"):
            it["translation"] = e["text"]
            it["translation_by"] = e.get("by") or "agent"
        if (m["needs"] or e) and not ok:
            it["translation_pending"] = True
            reason = "changed" if e else ("not downloaded" if m["type"] == "image" and not m.get("image") else "missing")
            pending.append({"id": m["id"], "type": m["type"], "reason": reason})
        items.append(it)
    last = items[-1] if items else None
    if not last:
        status = "No messages yet"
    elif last["side"] == "out":
        status = f"{cfg['me']} sent {last['time']}"
    else:
        status = f"{last['who']} replied {last['time']}"
    now = now or time.time()
    since = local(cfg["since"])
    group = cfg["chat"].endswith("@g.us")
    data = {
        "title": cfg["title"],
        "initial": next((ch.upper() for ch in cfg["title"] if ch.isalnum()), "#"),
        "subtitle": cfg["subtitle"],
        "since": since.strftime("Since %a %d %b, %H:%M"),
        "foot": (f"Since {since.strftime('%a %d %b, %H:%M')}" if group
                 else f"{cfg['me']} and {cfg['them']} · {since.strftime('Since %a %d %b, %H:%M')}"),
        "status": status,
        "last_id": last["id"] if last else None,
        "pending_translations": len(pending),
        "messages": items,
        "updated": local(now).strftime("%H:%M"),
        "updated_iso": local(now).isoformat(timespec="seconds"),
    }
    data["v"] = sha(json.dumps([data["title"], status, [{k: x.get(k) for k in ("id", "type", "text", "image", "caption", "translation")}
                                                       for x in items[-2:]]], ensure_ascii=False))[:10]
    return data, pending


# ---------- page + preview ----------

def page_html(data):
    t = (HERE / "page.html").read_text()
    e = lambda s: html.escape(str(s), quote=True)
    for k, v in (("{{OG_TITLE}}", e(data["title"] + " chat")), ("{{OG_DESC}}", e(data["status"])),
                 ("{{V}}", e(data["v"])), ("{{INITIAL}}", e(data["initial"])), ("{{NAME}}", e(data["title"])),
                 ("{{SUBTITLE}}", e(data["subtitle"]))):
        t = t.replace(k, v)
    # Inline copy of data.json for the first paint; escaped so no message text can close the script tag.
    seed = json.dumps(data, ensure_ascii=False)
    for c, u in (("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"), ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        seed = seed.replace(c, u)
    return t.replace("{{DATA}}", seed)


def preview_doc(d, data):
    e = lambda s: html.escape(str(s or ""), quote=True)
    rows = []
    for m in data["messages"][-2:]:
        if m["type"] == "image" and m.get("image"):
            inner = f'<img class="pic" src="{(d / m["image"]).absolute().as_uri()}">'
            if m.get("caption"):
                inner += f'<div class="t cap">{e(m["caption"])}</div>'
        elif m["type"] == "image":
            inner = f'<div class="pic">{e(m.get("caption") or "Photo")}</div>'
        else:
            inner = f'<div class="t">{e(m.get("text") or m.get("caption") or m.get("label"))}</div>'
        rows.append(f'<div class="row {m["side"]}"><div class="bubble">{inner}</div></div>')
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
*{{box-sizing:border-box;margin:0}} html,body{{width:1200px;height:630px;overflow:hidden}}
body{{background:#0b141a;color:#e9edef;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}}
.hd{{height:118px;background:#1f2c34;display:flex;align-items:center;padding:0 48px;gap:26px;flex:none}}
.av{{width:84px;height:84px;border-radius:50%;background:#2a7d6b;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:700;color:#fff;flex:none}}
.nm{{font-size:48px;font-weight:700;line-height:1.1}} .st{{font-size:30px;color:#8696a0;margin-top:6px}}
.wall{{flex:1;background:#0b141a;padding:40px 56px;display:flex;flex-direction:column;justify-content:flex-end;gap:22px;overflow:hidden}}
.row{{display:flex}} .row.out{{justify-content:flex-end}}
.bubble{{max-width:700px;border-radius:26px;padding:20px 26px;font-size:46px;line-height:1.3;overflow:hidden}}
.row.in .bubble{{background:#202c33}} .row.out .bubble{{background:#005c4b}}
.t{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:620px}} .cap{{font-size:34px;margin-top:10px}}
img.pic{{display:block;width:560px;height:200px;object-fit:cover;object-position:top;border-radius:18px}}
.pic{{font-size:40px;font-weight:600}}
</style></head><body>
<div class="hd"><div class="av">{e(data["initial"])}</div><div><div class="nm">{e(data["title"])}</div><div class="st">{e(data["status"])}</div></div></div>
<div class="wall">{"".join(rows)}</div></body></html>"""


def render_preview(d, data):
    """preview.png (1200x630, the bubble image); re-rendered only when what it shows changed."""
    key_path, out = d / ".preview-key", d / "preview.png"
    if os.environ.get("CONVO_CARD_NO_IMAGE") == "1":
        return
    if out.exists() and (key_path.read_text().strip() if key_path.exists() else "") == data["v"]:
        return
    try:
        sys.path.insert(0, os.environ.get("CONVO_CARD_PREVIEW_LIB") or str(HOME / ".local/libexec/card-preview"))
        import cardpreview
        cardpreview.render_html(preview_doc(d, data), str(out), 1200, 630)
        atomic_write(key_path, data["v"] + "\n")
    except Exception as e:  # the page still updates; card-check flags a missing/old preview before any send
        print(f"convo-card: preview not rendered: {e}", file=sys.stderr)


def render(d, cfg, msgs, now=None):
    translations = read_json(d / ".translations.json", {})
    data, pending = compose(cfg, msgs, translations, now)
    write_json(d / "data.json", data)
    page = page_html(data)
    if not (d / "index.html").exists() or (d / "index.html").read_text() != page:
        atomic_write(d / "index.html", page)
    render_preview(d, data)
    return data, pending


def build(d, cfg, dry_run=False):
    msgs = fetch(cfg, d, dry_run)
    if dry_run:
        return msgs, None
    write_json(d / ".convo.json", cfg)
    write_json(d / ".messages.json", msgs)
    return msgs, render(d, cfg, msgs)


VOLATILE = ("updated", "updated_iso")   # build time only; everything else a build writes is compared


def cmd_build(a):
    if not a.slug and not a.chat:
        die("build needs --chat (first time) or --slug")
    slug, ident = a.slug, None
    if not slug:
        ident = identify(a.chat)
        name = a.them or ident[2]
        slug = (slugify(name) + "-chat") if slugify(name) else "wa-" + ident[0].split("@")[0][:40]
    d = card_dir(slug)
    cfg = resolve_config(a, d, ident)
    if a.dry_run:   # reads only: no lock file, no folder for a card that doesn't exist yet
        msgs, _ = build(d, cfg, dry_run=True)
        data, pending = compose(cfg, msgs, read_json(d / ".translations.json", {}))
        cur = read_json(d / "data.json", {}) or {}
        old = {m.get("id"): m for m in cur.get("messages", [])}
        diffs = []
        if [m.get("id") for m in cur.get("messages", [])] != [m["id"] for m in data["messages"]]:
            diffs.append({"field": "order", "now": [m.get("id") for m in cur.get("messages", [])],
                          "would_be": [m["id"] for m in data["messages"]]})
        for m in data["messages"]:
            o = old.pop(m["id"], None)
            if o is None:
                diffs.append({"id": m["id"], "change": "new"})
                continue
            for k in sorted(set(m) | set(o)):   # empty and absent render the same
                if (m.get(k) or None) != (o.get(k) or None):
                    diffs.append({"id": m["id"], "field": k, "now": o.get(k), "would_be": m.get(k)})
        diffs += [{"id": i, "change": "gone"} for i in old]
        for k in sorted((set(data) | set(cur)) - {"messages", *VOLATILE}):
            if (cur.get(k) or None) != (data.get(k) or None):
                diffs.append({"field": k, "now": cur.get(k), "would_be": data.get(k)})
        print(json.dumps({"dry_run": True, "slug": slug, "dir": str(d), "messages": len(data["messages"]),
                          "pending": pending, "same": not diffs, "diffs": diffs}, ensure_ascii=False, indent=1))
        return
    with Lock(d):
        msgs, (data, pending) = build(d, cfg)
    print(json.dumps({"slug": slug, "dir": str(d), "messages": len(data["messages"]), "status": data["status"],
                      "pending": pending,
                      "next": ("translate each pending id (`convo-card show --slug %s` lists them), then send" % slug)
                      if pending else "send"}, ensure_ascii=False, indent=1))


def load(slug):
    d = card_dir(slug)
    cfg = read_json(d / ".convo.json")
    if not cfg:
        die(f"no card {slug!r} yet: run `convo-card build --chat NUMBER --slug {slug}` first")
    return d, cfg


def cmd_translate(a):
    d, cfg = load(a.slug)
    if a.none == bool(a.text):
        die("pass exactly one of --text ENGLISH or --none")
    with Lock(d):
        msgs = read_json(d / ".messages.json", [])
        m = next((x for x in msgs if x["id"] == a.id), None)
        if not m:
            die(f"message {a.id} is not on the card (build first; ids come from `convo-card show`)")
        tr = read_json(d / ".translations.json", {})
        tr[a.id] = {"sha": m["sha"], "text": None if a.none else clean(a.text, 2000), "by": clean(a.by, 40),
                    "at": datetime.now(DXB).isoformat(timespec="seconds")}
        if a.caption:
            tr[a.id]["caption"] = clean(a.caption, 120)
        write_json(d / ".translations.json", tr)
        data, pending = render(d, cfg, msgs)
    print(json.dumps({"stored": a.id, "pending": pending}, ensure_ascii=False))


def bridge(*args, timeout=60):
    env = {k: v for k, v in os.environ.items() if k != "BUN_INSPECT"}
    p = subprocess.run([*bridge_cmd(), *args], capture_output=True, text=True, timeout=timeout, env=env,
                       stdin=subprocess.DEVNULL)
    out = p.stdout.strip()
    try:
        data = json.loads(out.splitlines()[-1]) if out else {}
    except Exception:
        data = {"raw": out[:300]}
    if p.returncode != 0:
        raise RuntimeError(f"bridge {args[0]} failed ({p.returncode}): {(p.stderr or out).strip()[:300]}")
    return data


def subcaption(data):
    """A fixed phrase, never message text: the subcaption stays in the chat after the page has moved on, and
    message text can carry times and dates no filter catches."""
    m = data["messages"][-1]
    if m["side"] == "in":
        return clean(f"{m['who']} replied", 200)
    what = {"image": "a photo", "other": "a file"}.get(m["type"], "a message")
    return clean(f"{m['who']} sent {what}", 200)


def cmd_send(a):
    d, cfg = load(a.slug)
    if not CHAT_RE.match(a.to):
        die(f"bad --to {a.to!r}: a bridge chat slug (owner, moni, ...)")
    if not SESSION_RE.match(a.session or ""):
        die("--session must be the current session id of the chat you are in")
    with Lock(d):
        msgs, (data, pending) = build(d, cfg)
        if pending:
            die(f"{len(pending)} translation(s) pending or stale ({', '.join(p['id'] for p in pending)}): "
                f"look at each (`convo-card show --slug {a.slug}`), `convo-card translate` it, then send again", 3)
        if not data["messages"]:
            die("nothing on the card yet", 3)
        p = subprocess.run([*check_cmd(), "page", str(d)], capture_output=True, text=True, timeout=400,
                           stdin=subprocess.DEVNULL)
        if p.returncode != 0:
            die(f"card-check failed ({p.returncode}), not sending:\n" + (p.stdout + p.stderr).strip()[-1500:], 3)
        caption = a.caption or f"{cfg['title']} chat"
        if a.subcaption and NO_TIME.search(a.subcaption):
            die(f"--subcaption must not carry a number, time, day or date (the card's text never updates); "
                f"leave it out for the default: {a.subcaption!r}")
        sub = clean(a.subcaption, 200) if a.subcaption else subcaption(data)
        if a.dry_run:
            print(json.dumps({"dry_run": True, "to": a.to, "caption": caption, "subcaption": sub,
                              "publish": ["publish", "--app", a.slug] if a.to == "owner"
                              else ["share", "--app", a.slug, "--days", str(a.days)]}, ensure_ascii=False, indent=1))
            return
        pub = bridge("publish", "--app", a.slug) if a.to == "owner" else bridge("share", "--app", a.slug, "--days", str(a.days))
        url = pub.get("publicURL") or pub.get("url") or ""
        if pub.get("metadataWarnings"):
            die(f"bridge flagged the page metadata: {pub['metadataWarnings']}", 3)
        if not url.startswith("https://"):
            die(f"bridge returned no https URL: {pub}", 3)
        key = f"convo-{a.slug}-{a.to}-{data['last_id']}-{sha(url)[:8]}"[:200]
        sent = read_json(d / ".sent.json", {})
        if (sent.get(a.to) or {}).get("key") == key:
            print(json.dumps({"sent": False, "reason": "already sent for this message and link", "key": key}))
            return
        card_url = url.rstrip("/") + "/?v=" + data["v"]
        res = bridge("app", "--url", card_url, "--caption", caption, "--subcaption", sub,
                     "--summary", "Live WhatsApp chat", "--session", a.session, "--key", key, "--to", a.to)
        sent[a.to] = {"key": key, "url": url, "card_url": card_url, "last_id": data["last_id"],
                      "at": datetime.now(DXB).isoformat(timespec="seconds"), "op": res.get("id"),
                      "created": res.get("created")}
        write_json(d / ".sent.json", sent)
    print(json.dumps({"sent": True, "to": a.to, "url": card_url, "key": key, "created": res.get("created")}))


def cmd_show(a):
    d, cfg = load(a.slug)
    msgs = read_json(d / ".messages.json", [])
    data, pending = compose(cfg, msgs, read_json(d / ".translations.json", {}))
    by_id = {m["id"]: m for m in msgs}
    for p in pending:
        m = by_id[p["id"]]
        p["who"] = m["who"]
        if m.get("image"):
            p["image"] = str(d / m["image"])
        for k in ("text", "caption", "label"):
            if m.get(k):
                p[k] = m[k]
    print(json.dumps({"slug": a.slug, "dir": str(d), "chat": cfg["chat"], "jids": cfg["jids"],
                      "title": cfg["title"], "me": cfg["me"], "them": cfg["them"], "subtitle": cfg["subtitle"],
                      "since": data["since"], "messages": len(msgs), "status": data["status"], "pending": pending,
                      "built": (read_json(d / "data.json", {}) or {}).get("updated_iso"),
                      "sent": read_json(d / ".sent.json", {})}, ensure_ascii=False, indent=1))


# ---------- watcher check ----------

def probe(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=15) as r:
            return r.status == 200
    except Exception:
        return False


def cmd_watch(a):
    d, cfg = load(a.slug)
    state = Path(a.state_dir or os.environ.get("WATCH_DIR") or die("watch needs --state-dir or $WATCH_DIR"))
    w = wadb()
    ok, why = w.daemon_status()
    if not ok:
        die(why, 1)
    con = w.connect()
    q = ",".join("?" * len(cfg["jids"]))
    top = con.execute(f"select coalesce(max(rowid),0) from messages where chat_jid in ({q})", cfg["jids"]).fetchone()[0]
    now = a.now or time.time()
    cur = read_json(state / "cursor.json")
    if not cur:
        if not a.dry_run:
            write_json(state / "cursor.json", {"rowid": top})
        return
    rows = con.execute(
        f"select rowid, msg_id, from_me, coalesce(text,''), coalesce(display_text,''), lower(coalesce(media_type,'')),"
        f" coalesce(media_caption,''), coalesce(sender_jid,'') from messages where chat_jid in ({q}) and rowid > ?"
        f" and coalesce(reaction_to_id,'') = '' and coalesce(revoked,0) = 0 order by rowid", (*cfg["jids"], cur["rowid"])).fetchall()
    # Lines this run prints, and the state writes that consume them. The writes happen only after the lines are
    # in the outbox, so a run killed before the runner records its output prints them again next time.
    out, writes, carry, replays = [], [], [], 0
    run = os.environ.get("WATCH_RUN", "")
    outbox = state / ".convo-outbox.json"
    ob = read_json(outbox) if run else None
    if ob:
        okid = (state / ".run-ok").read_text().strip() if (state / ".run-ok").exists() else ""
        if ob.get("run") != okid and now - ob.get("at", 0) < OUTBOX_TTL and ob.get("replays", 0) < OUTBOX_MAX_REPLAYS:
            carry, replays = ob.get("lines", []), ob.get("replays", 0) + 1
        elif not a.dry_run:
            outbox.unlink()
    if rows:
        pend = read_json(state / "pending.json") or {}
        if pend.get("max_rowid") != rows[-1][0]:
            pend = {"max_rowid": rows[-1][0], "first_seen": pend.get("first_seen") or now, "last_change": now}
            writes.append(lambda p=pend: write_json(state / "pending.json", p))
        if a.force or now - pend["last_change"] >= QUIET_S:
            sent = sorted(read_json(d / ".sent.json", {}) or {})
            out.append(f"CONVO_CARD_UPDATE {a.slug}: {len(rows)} new message(s) in the {cfg['title']} chat, last msgid="
                       f"{rows[-1][1]} rowid={rows[-1][0]}. Card sent before to: {', '.join(sent) or 'nobody'}.")
            for rowid, mid, from_me, text, display, media, caption, sender in rows[-8:]:
                who = cfg["me"] if from_me else (w.name_of(con, sender) or cfg["them"]
                                                 if cfg["chat"].endswith("@g.us") else cfg["them"])
                body = (f"[{media.upper()}] " if media else "") + (caption or text or ("" if media else display))
                out.append(f"- {who}: {clean(body, 160)} (msgid {mid})")
            top_row = rows[-1][0]
            writes.append(lambda: write_json(state / "cursor.json", {"rowid": top_row}))
            writes.append(lambda: (state / "pending.json").unlink() if (state / "pending.json").exists() else None)
    con.close()
    share = read_json(state / "share.json") or {}
    urls = sorted({v["url"] for k, v in (read_json(d / ".sent.json", {}) or {}).items() if k != "owner" and v.get("url")})
    if urls and now - share.get("last_probe", 0) >= PROBE_S:
        bad = [u for u in urls if not probe(u)]
        share["last_probe"] = now
        share["fails"] = share.get("fails", 0) + 1 if bad else 0
        if share["fails"] >= 2 and share.get("alerted_url") != bad[0]:
            out.append(f"CONVO_CARD_SHARE_DOWN {a.slug}: {bad[0]} failed {share['fails']} probes in a row; run "
                       f"`convo-card send --slug {a.slug} --to <chat> --session <yours>` to re-share and resend.")
            share["alerted_url"] = bad[0]
        if not bad:
            share.pop("alerted_url", None)
        writes.append(lambda: write_json(state / "share.json", share))
    lines = carry + out
    if not a.dry_run:
        if run and out:
            write_json(outbox, {"run": run, "lines": lines, "at": now if not carry else ob.get("at", now),
                                "replays": replays})
        elif run and carry:
            write_json(outbox, dict(ob, run=run, replays=replays))
        for f in writes:
            f()
    if lines:
        print("\n".join(lines))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="convo-card", description=__doc__,
                                 epilog="Use the defaults: every option has one. Don't stop to ask.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="read the chat and rebuild the card folder")
    b.add_argument("--chat", help="phone number or JID (first build only)")
    b.add_argument("--slug", help="card folder name (default <them>-chat)")
    b.add_argument("--title", help="header name (default: --them)")
    b.add_argument("--me", help="who the outgoing messages are from (default Abdullah)")
    b.add_argument("--them", help="the other side's name (default: WhatsApp contact name, else the number)")
    b.add_argument("--subtitle", help="header line (default \"via Abdullah's WhatsApp\")")
    b.add_argument("--since", help="ISO start time (default: start of the day 2 days ago, Dubai)")
    b.add_argument("--days", type=int, help="start N days back at midnight instead of --since (default 3)")
    b.add_argument("--dry-run", action="store_true", help="compare with the current data.json, write nothing")
    t = sub.add_parser("translate", help="store the English for one message")
    t.add_argument("--slug", required=True)
    t.add_argument("--id", required=True)
    t.add_argument("--text")
    t.add_argument("--none", action="store_true", help="the message has nothing to translate")
    t.add_argument("--caption", help="short label shown under a photo with no caption of its own")
    t.add_argument("--by", default="agent")
    s = sub.add_parser("send", help="check, share and send the live card")
    s.add_argument("--slug", required=True)
    s.add_argument("--session", required=True)
    s.add_argument("--to", default="owner", help="bridge chat slug (default owner)")
    s.add_argument("--days", type=int, default=30, help="public link lifetime for non-owner chats (default 30)")
    s.add_argument("--caption", help="default '<title> chat'")
    s.add_argument("--subcaption", help="default: last message, without times")
    s.add_argument("--dry-run", action="store_true")
    sh = sub.add_parser("show", help="config, pending translations, send journal")
    sh.add_argument("--slug", required=True)
    wt = sub.add_parser("watch", help="watcher check")
    wt.add_argument("--slug", required=True)
    wt.add_argument("--state-dir")
    wt.add_argument("--dry-run", action="store_true")
    wt.add_argument("--now", type=float, help=argparse.SUPPRESS)
    wt.add_argument("--force", action="store_true", help="skip the quiet window")
    a = ap.parse_args(argv)
    if a.cmd == "build" and a.days is not None and a.days < 1:
        die("--days must be 1 or more")
    if a.cmd == "send" and not 1 <= a.days <= 30:
        die("--days must be 1-30")
    {"build": cmd_build, "translate": cmd_translate, "send": cmd_send, "show": cmd_show, "watch": cmd_watch}[a.cmd](a)


if __name__ == "__main__":
    main()
