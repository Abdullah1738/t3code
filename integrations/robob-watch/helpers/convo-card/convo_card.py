#!/usr/bin/python3
"""convo-card: a live WhatsApp conversation card (an iMessage app card) for one chat.

Use the defaults. Every option has one; don't stop to ask which to pick.

    convo-card build --chat NUMBER|JID [--slug SLUG] [--title T] [--me NAME] [--them NAME]
                     [--subtitle T] [--since ISO | --days N] [--narrow] [--dry-run]
        Read the chat from wacli's store (read only), download its photos and rebuild the card folder.
        Later runs need only --slug; options you pass are saved for next time. A chat gets one card: a second
        slug for the same chat is refused. A sent card keeps its earlier messages unless --narrow (Abdullah
        asked for a shorter window).
        The card shows recent history by design. For a longer one run `build --slug SLUG --since ISO`, then
        translate anything pending; the open card picks it up within 25 s, no resend.
    convo-card translate --slug SLUG --id MSGID (--text ENGLISH | --none) [--caption LABEL] [--by WHO]
        Store the English for one message, bound to that exact message (its id + sha256 of its exact text,
        caption or photo bytes). If the message changes, the translation stops showing and send refuses again.
        Every photo and every message that isn't plainly English waits for this. Look at each one first
        (`show` prints the photo path); --none = nothing in it to translate (English already). A photo
        that hasn't downloaded can't be marked: build again to retry the download.
    convo-card send --slug SLUG --session S [--to CHAT] [--days N] [--dry-run]
        Rebuilds, refuses while any translation is pending or stale, runs `card-check page`, then shares
        the page and sends ONE live app card (`app --to CHAT`), keyed per last message + page URL, so
        a repeat is a no-op. CHAT defaults to owner (Abdullah); S = the CURRENT session id of the chat
        you are in. Caption '<title> chat' and subcaption ('Lydia replied', 'Moni sent a photo') are
        fixed phrases: the card's text never updates, so it never carries message text, times or dates.
        It never sends WhatsApp and never sends a picture of the chat.
    convo-card show --slug SLUG       config, pending items (with photo paths), send journal
    convo-card watch --slug SLUG      watcher check (state in $WATCH_DIR): prints CONVO_CARD_UPDATE once
        new, edited or deleted messages have been quiet for 2 min. A shared link that fails twice in a row is
        re-shared quietly (new link kept in $WATCH_DIR/share.json; .sent.json is left alone, nothing is sent).
        CONVO_CARD_SHARE_DOWN prints only when the re-share fails too: tell the owner, never send a card for it.
        Changing a card's window (--since/--days) is not reported. Exits 1 while the wacli sync daemon is down.
        Under robob-watch ($WATCH_RUN) an event the runner never recorded is printed again (.convo-outbox.json
        in the state dir).

Card folder ~/.local/share/imessage-apps/<slug>/ (served): index.html, data.json, preview.png, media/.
The page re-reads data.json every 25s, so a rebuild shows up on the open card by itself.
Private dotfiles in the same folder (the bridge never serves dot paths): .convo.json (config),
.messages.json, .translations.json, .sent.json, .preview-key, .lock.

Env overrides: CONVO_CARD_ROOT, CONVO_CARD_BRIDGE (bridge CLI command, space separated),
CONVO_CARD_WACLI, CONVO_CARD_CHECK, CONVO_CARD_LANGID (language check, default english.js = Apple's
on-device recognizer), CONVO_CARD_PREVIEW_LIB, CONVO_CARD_NO_IMAGE=1 (skip Chrome, tests), WACLI_STORE_DIR.
"""
import argparse, fcntl, hashlib, html, json, os, re, shlex, shutil, sqlite3, subprocess, sys, tempfile, time
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
WATCH_BUDGET_S = float(os.environ.get("CONVO_CARD_WATCH_BUDGET") or 48)   # robob-watch SIGKILLs a check at 60 s
T_START = time.monotonic()
OUTBOX_TTL = 3600         # an event the runner never recorded is printed again for up to an hour,
OUTBOX_MAX_REPLAYS = 3    # at most this many times (same rule as wa-db's whatsapp-new-message outbox)
LABELS = {"audio": "Voice message", "ptt": "Voice message", "video": "Video", "gif": "GIF",
          "sticker": "Sticker", "document": "Document", "location": "Location",
          "live_location": "Live location"}
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


def under_test():
    """True under `ROBOB_TEST=1`, bun test (NODE_ENV=test) or pytest (PYTEST_CURRENT_TEST)."""
    return bool(os.environ.get("ROBOB_TEST")) or os.environ.get("NODE_ENV") == "test" or bool(os.environ.get("PYTEST_CURRENT_TEST"))


def bridge_cmd():
    return _cmd("CONVO_CARD_BRIDGE", ["/Users/ardud/.bun/bin/bun", str(HOME / ".local/share/spectrum-bridge/src/cli.ts")])


def bridge_state():
    return Path(os.environ.get("CONVO_CARD_BRIDGE_STATE") or HOME / ".config/spectrum-bridge")


def own_chat(to, session):
    """True when the session is the recipient chat's own live route: the bridge refuses --to from any chat
    but the owner's, so a card for the chat you are in goes as a plain reply in it."""
    db = bridge_state() / ("state.sqlite" if to == "owner" else f"chats/{to}/state.sqlite")
    if not db.is_file():
        return False
    try:
        con = sqlite3.connect(f"{db.absolute().as_uri()}?mode=ro", uri=True, timeout=5)
        try:
            row = con.execute("select value from kv where key = 'route'").fetchone()
        finally:
            con.close()
        route = json.loads(row[0]) if row and row[0] else None
    except (OSError, ValueError, sqlite3.Error):
        return False
    if not isinstance(route, dict) or not isinstance(route.get("id"), str):
        return False
    g = route.get("generation")
    if not isinstance(g, int) or isinstance(g, bool) or g < 0:
        return False
    return session in (route["id"], f"{route['id']}@{g}")


def check_cmd():
    return _cmd("CONVO_CARD_CHECK", [str(HOME / ".local/bin/card-check")])


def langid_cmd():
    return _cmd("CONVO_CARD_LANGID", ["/usr/bin/osascript", "-l", "JavaScript", str(HERE / "english.js")])


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


def _words_check(s, names):
    """'review', 'plain' (no words, or only chat words and names) or 'ask' (dictionary words: the language
    recognizer decides, since 'Sin embargo' and 'Ich bin in Berlin' are all in the word list too)."""
    s = (s or "").replace("\u2019", "'")
    if any(ch.isalpha() and ord(ch) > 127 for ch in s):
        return "review"
    words = re.findall(r"[a-z]+", re.sub(r"'(s|t|re|ll|ve|d|m)\b", "", s.lower()))
    if not all(known_word(w, names) for w in words):
        return "review"
    return "ask" if any(w not in names and w not in CHAT_WORDS for w in words) else "plain"


def english(texts):
    """Apple's on-device recognizer says English for each text. Can't run -> all False (reviewed)."""
    if not texts:
        return []
    try:
        p = subprocess.run(langid_cmd(), input=json.dumps(texts), capture_output=True, text=True, timeout=60)
        res = json.loads(p.stdout) if p.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        res = None
    if not isinstance(res, list) or len(res) != len(texts):
        print("convo-card: language check didn't run; every message with words waits for translate",
              file=sys.stderr)
        return [False] * len(texts)
    return [isinstance(r, dict) and r.get("top") == "en" for r in res]


def needs_review(texts, names=()):
    """One flag per text: True unless it is confidently English, meaning ASCII letters only, every word in
    the system word list (simple suffixes stripped) or a chat name, and the recognizer calls it English.
    Emoji, digits and punctuation alone need nothing. A false alarm costs one `translate --none`; a miss
    shows an untranslated message as done."""
    verdicts = [_words_check(s, names) for s in texts]
    asks = [s for s, v in zip(texts, verdicts) if v == "ask"]
    en = iter(english(asks))
    return [v == "review" or (v == "ask" and not next(en)) for v in verdicts]


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


def when(ts):
    t = local(ts)
    return f"{t:%a} {t.day} {t:%b}, {t:%H:%M}"


def other_card_showing(d, chats):
    """(slug, saved since) of another card folder already showing one of these chat JIDs, else None."""
    for p in sorted(root().glob("*/.convo.json")):
        if p.parent == d:
            continue
        other = read_json(p, {})
        if not isinstance(other, dict) or not other.get("chat"):
            continue
        if {other["chat"], *(other.get("jids") or [])} & chats:
            return p.parent.name, other.get("since")
    return None


def resolve_config(a, d, ident=None):
    """Saved config + whatever this run passed. First build needs --chat; the rest has defaults."""
    cfg = read_json(d / ".convo.json", {})
    if a.chat:
        main, jids, name = ident or identify(a.chat)
        mine = {cfg["chat"], *cfg.get("jids", [])} if cfg.get("chat") else set()
        if mine and not mine & {main, *jids}:
            die(f"{d.name} already belongs to {cfg['chat']}; pick another --slug for {main}")
        if not cfg.get("chat"):   # a new card: a chat gets one card, not a second slug
            hit = other_card_showing(d, {main, *jids})
            if hit:
                slug, s = hit
                since_txt = f" (since {when(s)})" if isinstance(s, int) else ""
                die(f"{slug} already shows this chat{since_txt}: use --slug {slug} instead of making a second card")
        cfg["chat"], cfg["jids"] = main, list(dict.fromkeys([*jids, *cfg.get("jids", [])]))
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
    new_since = None
    if since:
        try:
            dt = datetime.fromisoformat(since)
        except ValueError:
            die(f"bad --since {since!r}: ISO time like 2026-10-24T00:00+04:00")
        new_since = int((dt if dt.tzinfo else dt.replace(tzinfo=DXB)).timestamp())
    elif "since" not in cfg or getattr(a, "days", None):
        days = getattr(a, "days", None) or 3
        start = datetime.now(DXB).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
        new_since = int(start.timestamp())
    if new_since is not None:
        # A card someone has already been sent keeps its earlier messages unless Abdullah asked for less.
        sent = sorted(read_json(d / ".sent.json", {}) or {})
        was = cfg.get("since")
        if was is not None and new_since > was and sent and not getattr(a, "narrow", False):
            die(f"this would take messages before {when(new_since)} off a card already sent to {', '.join(sent)}: "
                f"leave out --since/--days to keep the window, or pass --narrow if Abdullah asked for a shorter one")
        cfg["since"] = new_since
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


def chat_jids(w, con, cfg):
    """Every JID the chat is stored under now. A phone-LID mapping can appear or change after the first
    build, so every saved identity is resolved again, not just the one the card was made from."""
    known = list(dict.fromkeys([cfg["chat"], *cfg.get("jids", [])]))
    return list(dict.fromkeys(j for k in known for j in (k, *w.resolve(con, k))))


def canonical(cfg):
    """A card made from an unmapped LID switches to the phone JID once it is known (it stays stable)."""
    if cfg["chat"].endswith("@lid"):
        cfg["chat"] = next((j for j in cfg["jids"] if j.endswith("@s.whatsapp.net")), cfg["chat"])


def body_of(media, text, display, caption):
    """The source text the card shows for a row (and binds a translation to)."""
    if media:
        return caption or text
    return text if text.strip() else display


def sender_who(w, con, cfg, from_me, sender, sender_name):
    if from_me:
        return cfg["me"]
    if not cfg["chat"].endswith("@g.us"):
        return cfg["them"]
    num = sender.split("@")[0]
    return clean(w.name_of(con, sender) or sender_name or ("+" + num if sender.endswith("@s.whatsapp.net")
                                                         else "Someone"), 40)


def fetch(cfg, d, dry_run=False):
    """The chat since cfg.since as private message records, oldest first. Refreshes cfg['jids']."""
    w = wadb()
    con = w.connect()
    group = cfg["chat"].endswith("@g.us")
    cfg["jids"] = chat_jids(w, con, cfg)
    canonical(cfg)
    q = ",".join("?" * len(cfg["jids"]))
    rows = con.execute(
        f"select rowid, chat_jid, msg_id, coalesce(sender_jid,''), coalesce(sender_name,''), from_me, ts,"
        f" coalesce(text,''), coalesce(display_text,''), lower(coalesce(media_type,'')), coalesce(media_caption,''),"
        f" coalesce(filename,''), coalesce(reaction_to_id,''), coalesce(revoked,0), coalesce(deleted_for_me,0)"
        f" from messages where chat_jid in ({q}) and ts >= ? order by ts, rowid", (*cfg["jids"], cfg["since"])).fetchall()
    names = chat_names(cfg)
    out, check = {}, {}
    for (rowid, chat_jid, msg_id, sender, sender_name, from_me, ts, text, display, media, caption, filename,
         reaction, revoked, deleted) in rows:
        if reaction or revoked or deleted or not msg_id:
            continue
        who = sender_who(w, con, cfg, from_me, sender, sender_name)
        side = "out" if from_me else "in"
        frm = "me" if from_me else (sha(sender)[:8] if group else "them")
        m = {"rowid": rowid, "id": msg_id, "side": side, "who": who, "from": frm, "ts": int(ts)}
        # A translation is bound to the message id and the exact source (raw text, caption, photo bytes): any
        # change, or a translation copied from another message, no longer matches.
        raw = body_of(media, text, display, caption)
        if media == "image":
            path = download(chat_jid, msg_id, d / "media", dry_run)
            m.update(type="image", caption=raw.strip())
            if path:
                m["image"] = "media/" + path.name
                m["sha"] = sha("image", msg_id, path.read_bytes(), raw)
            else:
                m["sha"] = sha("image-missing", msg_id, raw)
                if dry_run:
                    m["unchecked"] = True    # a real build would try to download it
            m["needs"] = True    # a photo can carry text in any language, so someone always has to look at it
        elif media:
            label = LABELS.get(media, "Attachment")
            if media == "document" and filename:
                label += ": " + clean(filename, 60)
            m.update(type="other", label=label, caption=raw.strip(), sha=sha("other", msg_id, label, raw))
            check[msg_id] = raw
        else:
            if not raw.strip():
                continue
            m.update(type="text", text=raw.strip(), sha=sha("text", msg_id, raw))
            check[msg_id] = raw
        out[msg_id] = m
    con.close()
    for msg_id, needs in zip(check, needs_review(list(check.values()), names)):
        if msg_id in out:
            out[msg_id]["needs"] = needs
    return sorted(out.values(), key=lambda m: (m["ts"], m["rowid"]))


def compose(cfg, msgs, translations, now=None):
    """data.json for the page, plus the pending list (missing or stale translations)."""
    items, pending = [], []
    for m in msgs:
        e = translations.get(m["id"])
        unseen = m["type"] == "image" and not m.get("image")   # nobody can have looked at it: never done
        ok = bool(e) and e.get("sha") == m["sha"] and not unseen
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
            reason = "not downloaded" if unseen else ("changed" if e else "missing")
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
    # Inline copy of data.json for the first paint; escaped so no message text can close the script tag.
    seed = json.dumps(data, ensure_ascii=False)
    for c, u in (("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"), ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        seed = seed.replace(c, u)
    fill = {"OG_TITLE": e(data["title"] + " chat"), "OG_DESC": e(data["status"]), "V": e(data["v"]),
            "INITIAL": e(data["initial"]), "NAME": e(data["title"]), "SUBTITLE": e(data["subtitle"]), "DATA": seed}
    # One pass over the template, so a name or message that looks like a placeholder is never filled in.
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda mo: fill.get(mo.group(1), mo.group(0)), t)


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
        # A photo not on disk yet may download in a real build, so the result can't be called the same.
        unchecked = [m["id"] for m in msgs if m.get("unchecked")]
        print(json.dumps({"dry_run": True, "slug": slug, "dir": str(d), "messages": len(data["messages"]),
                          "pending": pending, "same": not diffs and not unchecked, "diffs": diffs,
                          "photos_not_downloaded": unchecked}, ensure_ascii=False, indent=1))
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
        if m["type"] == "image" and not m.get("image"):
            die(f"photo {a.id} isn't downloaded, so nobody can have looked at it: run `convo-card build "
                f"--slug {a.slug}` to retry the download, then look at it and translate", 3)
        tr = read_json(d / ".translations.json", {})
        tr[a.id] = {"sha": m["sha"], "text": None if a.none else clean(a.text, 2000), "by": clean(a.by, 40),
                    "at": datetime.now(DXB).isoformat(timespec="seconds")}
        if a.caption:
            tr[a.id]["caption"] = clean(a.caption, 120)
        write_json(d / ".translations.json", tr)
        data, pending = render(d, cfg, msgs)
    print(json.dumps({"stored": a.id, "pending": pending}, ensure_ascii=False))


def bridge(*args, timeout=60):
    # Under a test, only an injected stub bridge may run: the real one would send iMessage.
    if under_test() and not os.environ.get("CONVO_CARD_BRIDGE"):
        sys.exit(f"refused: test run; convo-card would send via the real bridge ({args[0] if args else '?'}); "
                 "set CONVO_CARD_BRIDGE to a stub")
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
        caption = clean(f"{cfg['title']} chat", 200)
        sub = subcaption(data)
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
        to = [] if own_chat(a.to, a.session) else ["--to", a.to]
        res = bridge("app", "--url", card_url, "--caption", caption, "--subcaption", sub,
                     "--summary", "Live WhatsApp chat", "--session", a.session, "--key", key, *to)
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

# Cloudflare in front of cards.abdullah.fund answers Python's default agent (Python-urllib/x) with 403, error 1010.
PROBE_UA = "Mozilla/5.0 (compatible; convo-card-probe)"


def probe(url, timeout=15):
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": PROBE_UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def left():
    """Seconds left in this watch run's budget, so the probes, the re-share and the alert all finish in time."""
    return WATCH_BUDGET_S - (time.monotonic() - T_START)


def reshare(slug, timeout):
    """The page's new share link, or None. Same bridge call send makes; no card is sent."""
    try:
        pub = bridge("share", "--app", slug, "--days", "30", timeout=timeout)
    except (RuntimeError, OSError, subprocess.TimeoutExpired):
        return None
    url = pub.get("publicURL") or pub.get("url") or ""
    return url if url.startswith("http") else None


def watch_rows(w, con, cfg):
    """Every message in the card's window by id (rowid order), with a fingerprint of what the card shows for it,
    plus the chat's newest rowid."""
    jids = chat_jids(w, con, cfg)
    q = ",".join("?" * len(jids))
    rows = con.execute(
        f"select rowid, msg_id, from_me, coalesce(sender_jid,''), coalesce(sender_name,''), coalesce(text,''),"
        f" coalesce(display_text,''), lower(coalesce(media_type,'')), coalesce(media_caption,''),"
        f" coalesce(revoked,0), coalesce(deleted_for_me,0) from messages where chat_jid in ({q}) and ts >= ?"
        f" and coalesce(reaction_to_id,'') = '' and coalesce(msg_id,'') != '' order by rowid",
        (*jids, cfg["since"])).fetchall()
    top = con.execute(f"select coalesce(max(rowid),0) from messages where chat_jid in ({q})", jids).fetchone()[0]
    out = {}
    for rowid, mid, from_me, sender, sender_name, text, display, media, caption, revoked, deleted in rows:
        body = body_of(media, text, display, caption)
        gone = bool(revoked or deleted or not (media or body.strip()))   # not on the card
        out[mid] = {"rowid": rowid, "fp": ("-" if gone else "") + sha(media, body, gone)[:16], "gone": gone,
                    "who": sender_who(w, con, cfg, from_me, sender, sender_name),
                    "body": (f"[{media.upper()}] " if media else "") + body}
    return top, out


def watch_changes(cur, rows):
    """[(kind, msg_id)] for what changed on the card since the cursor: new, edited, deleted or dropped messages."""
    fps = cur.get("fps")
    changes = []
    for mid, r in rows.items():
        if fps is None:   # cursor from before fingerprints: everything up to its rowid was seen
            kind = "new" if r["rowid"] > cur.get("rowid", 0) and not r["gone"] else None
        elif mid not in fps:
            kind = None if r["gone"] else "new"
        elif fps[mid] != r["fp"]:
            # "-" marks a row the card didn't show (revoked, empty): one that fills in later is new to the card.
            was_shown = not fps[mid].startswith("-")
            kind = ("deleted" if was_shown else None) if r["gone"] else ("edited" if was_shown else "new")
        else:
            kind = None
        if kind:
            changes.append((kind, mid))
    # Shown before, now gone from the store or out of the card's window (--since moved): off the card too.
    changes += [("dropped", mid) for mid, fp in (fps or {}).items() if mid not in rows and not fp.startswith("-")]
    return changes


def cmd_watch(a):
    d, cfg = load(a.slug)
    state = Path(a.state_dir or os.environ.get("WATCH_DIR") or die("watch needs --state-dir or $WATCH_DIR"))
    w = wadb()
    ok, why = w.daemon_status()
    if not ok:
        die(why, 1)
    now = a.now or time.time()
    run = os.environ.get("WATCH_RUN", "")
    outbox = state / ".convo-outbox.json"
    ob = read_json(outbox) or {}
    if "lines" in ob:   # single-batch outbox from before 25 Oct
        ob = {"run": ob.get("run"), "batches": [{"lines": ob["lines"], "at": ob.get("at", 0),
                                                 "replays": ob.get("replays", 0)}]}
    con = w.connect()
    top, rows = watch_rows(w, con, cfg)
    con.close()
    fps = {mid: r["fp"] for mid, r in rows.items()}
    cur = read_json(state / "cursor.json")
    # State writes run in order, and only after this run's lines are in the outbox, so a run killed before the
    # runner records its output prints them again next time instead of losing them.
    pre, writes = [], []
    oc = ob.get("cursor")
    if oc and cur is not None and oc.get("seq", 0) > cur.get("seq", 0):
        # The run that printed the outbox died before its cursor write. Commit that cursor now, or the same
        # changes would be reported again on top of the replay.
        cur = oc
        pre.append(lambda: write_json(state / "cursor.json", oc))
    if cur is None:
        if not a.dry_run:
            write_json(state / "cursor.json", {"rowid": top, "seq": 0, "fps": fps, "since": cfg["since"]})
        return
    carry = []
    if run and ob.get("batches"):
        okid = (state / ".run-ok").read_text().strip() if (state / ".run-ok").exists() else ""
        if ob.get("run") != okid:
            # Each batch keeps its own replay budget, so a new event never inherits an older one's.
            carry = [dict(b, replays=b.get("replays", 0) + 1) for b in ob["batches"]
                     if now - b.get("at", 0) < OUTBOX_TTL and b.get("replays", 0) < OUTBOX_MAX_REPLAYS]
    out, nc = [], None
    prev_fps, prev_since = cur.get("fps"), cur.get("since")
    if prev_fps is not None and prev_since is not None and prev_since != cfg["since"]:
        # A window change is not a chat change: a message that entered the window was already in the chat
        # before the cursor (not new), one that left it isn't reported, and edits to seen messages still are.
        cur = dict(cur, fps={mid: prev_fps.get(mid, r["fp"]) for mid, r in rows.items()
                             if mid in prev_fps or r["rowid"] <= cur.get("rowid", 0)})
    changes = watch_changes(cur, rows)
    pend = read_json(state / "pending.json") or {}
    if changes:
        sig = sha(*[f"{k}:{m}:{fps.get(m)}" for k, m in changes])
        if pend.get("sig") != sig:
            pend = {"sig": sig, "first_seen": pend.get("first_seen") or now, "last_change": now}
            writes.append(lambda p=pend: write_json(state / "pending.json", p))
        if a.force or now - pend["last_change"] >= QUIET_S:
            new = [m for k, m in changes if k == "new"]
            changed = len(changes) - len(new)
            what = " and ".join(x for x in (f"{len(new)} new message(s)" if new else "",
                                            f"{changed} edited or deleted message(s)" if changed else "") if x)
            last = (new or [m for k, m in changes])[-1]
            sent = sorted(read_json(d / ".sent.json", {}) or {})
            out.append(f"CONVO_CARD_UPDATE {a.slug}: {what} in the {cfg['title']} chat, last msgid={last}. "
                       f"Card sent before to: {', '.join(sent) or 'nobody'}.")
            for kind, mid in changes[-8:]:
                r = rows.get(mid)
                if kind == "dropped":
                    out.append(f"- message no longer in the chat (msgid {mid})")
                elif kind == "deleted":
                    out.append(f"- {r['who']}: message deleted (msgid {mid})")
                else:
                    tag = " (edited)" if kind == "edited" else ""
                    out.append(f"- {r['who']}{tag}: {clean(r['body'], 160)} (msgid {mid})")
            nc = {"rowid": top, "seq": cur.get("seq", 0) + 1, "fps": fps, "since": cfg["since"]}
            writes.append(lambda: write_json(state / "cursor.json", nc))
            writes.append(lambda: (state / "pending.json").unlink() if (state / "pending.json").exists() else None)
    else:
        if pend:
            writes.append(lambda: (state / "pending.json").unlink() if (state / "pending.json").exists() else None)
        if prev_fps != fps or prev_since != cfg["since"]:   # silent differences, or the card's window moved
            quiet = {"rowid": top, "seq": cur.get("seq", 0), "fps": fps, "since": cfg["since"]}
            writes.append(lambda: write_json(state / "cursor.json", quiet))
    share = read_json(state / "share.json") or {}
    sent = read_json(d / ".sent.json", {}) or {}
    moved = share.get("moved") or {}
    # .sent.json keeps the link each send made. A quiet re-share is kept here instead, so the journal stays honest.
    targets = {}
    for k, v in sent.items():
        if k == "owner" or not v.get("url"):
            continue
        m = moved.get(k)
        targets[k] = m["url"] if m and m.get("old") == v["url"] else v["url"]
    urls = sorted(set(targets.values()))
    if urls and now - share.get("last_probe", 0) >= PROBE_S:
        bad = [u for u in urls if not probe(u, timeout=max(1, min(15, left() - 5)))]
        share["last_probe"] = now
        share["fails"] = share.get("fails", 0) + 1 if bad else 0
        why = "it still doesn't answer after a re-share"
        if bad:
            # The link is dead (the bridge restarted and made a new one). Re-share the page as send does and probe
            # the link it returns from now on. Nothing is sent; a card goes out only on a real chat change. This
            # runs at the first failed probe, so links already dead before this change get it too.
            fresh = None
            budget = left() - 10          # leave room to probe, alert and save before robob-watch's 60 s kill
            if a.dry_run:
                why = "a dry run does not re-share"
            elif budget >= 5:
                fresh = reshare(a.slug, timeout=min(30, budget))
            else:
                why = "the watch check ran out of time"
            if fresh is None:
                if budget >= 5 and not a.dry_run:
                    why = "the bridge could not re-share it"
            else:
                for k, u in targets.items():
                    if u in bad:
                        moved[k] = {"old": sent[k]["url"], "url": fresh}
                share["moved"] = moved
                if probe(fresh, timeout=max(1, min(15, left() - 5))):
                    bad, share["fails"] = [], 0
                else:
                    bad = [fresh]
                    why = f"the new link {fresh} doesn't answer either"
        if bad and share.get("alerted_url") != bad[0]:
            head = f"CONVO_CARD_SHARE_DOWN {a.slug}: {bad[0]} "
            # A run that died after its outbox write but before share.json is being replayed with this alert.
            if not any(x.startswith(head) for b in carry for x in b["lines"]):
                out.append(f"{head}is down ({why}). Tell Abdullah the {cfg['title']} chat card's link is down. "
                           "Do not send a card or message anyone; he decides.")
            share["alerted_url"] = bad[0]
        if not bad:
            share.pop("alerted_url", None)
        writes.append(lambda: write_json(state / "share.json", share))
    batches = carry + ([{"lines": out, "at": now, "replays": 0}] if out else [])
    if not a.dry_run:
        for f in pre:
            f()
        if run and (batches or nc):
            write_json(outbox, {"run": run, "batches": batches, "cursor": nc})
        elif run and outbox.exists():
            outbox.unlink()
        for f in writes:
            f()
    lines = [x for b in batches for x in b["lines"]]
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
    b.add_argument("--narrow", action="store_true",
                   help="allow a later start on a card that was already sent (only if Abdullah asked for less)")
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
