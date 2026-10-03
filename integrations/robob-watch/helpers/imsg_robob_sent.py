#!/usr/bin/python3
"""Tell robob's (the assistant's) iMessage sends apart from Abdullah's own.

Both send from Abdullah's account, so chat.db alone can't tell them apart: since late
Sep 2026 Abdullah's iPhone sends also carry reply_to_guid, so that is no signal.
Attribution instead matches each outgoing message against the send tool calls the
assistant actually made (OpenCode session_message rows near the message time):
`imsg send --text/--file`, osascript `tell application "Messages" to send ...`,
cua-driver type_text, and similar. Attachments under ~/Library/Messages/Attachments/imsg/
were sent with the imsg CLI, which only the assistant uses.

  imsg-robob-sent [--cache FILE] < imsg-history.jsonl
      prints {"<id>": "robob" | "abdullah" | "unknown"} for every is_from_me message.

As a module: attribute(msgs, cache_path=None) -> {id: verdict}.
"unknown" means the OpenCode DB could not be read. Read-only; never writes either DB.
"""
import datetime, json, os, re, shlex, sqlite3, sys, time, unicodedata

OC_DB = os.environ.get("ROBOB_OPENCODE_DB", os.path.expanduser("~/.local/share/opencode/opencode.db"))
# The send tool call starts before the message lands in chat.db; osascript sends run under
# `alarm 90` and LLM steps can stream for minutes before the tool runs.
WINDOW_BEFORE_MS = 6 * 60 * 1000
WINDOW_AFTER_MS = 30 * 1000
# A young "abdullah" verdict may just mean the assistant's row isn't flushed yet: don't cache it.
SETTLE_MS = 10 * 60 * 1000
PREFIX = 40

_SEND_TERMS = ("send", "type_text")
_OSA_SEND = re.compile(r'\bsend\s+"((?:[^"\\]|\\.)*)"', re.S)
_OSA_FILE = re.compile(r'POSIX file\s+"([^"]+)"')
_SEND_CALL = re.compile(r"\bimsg\s+send\b|application \"Messages\" to send|type_text")
# Indirect-send fallback only for texts long enough not to collide with chat ("Kk", "Cute").
BLOB_MIN = 30


def norm(s):
    s = unicodedata.normalize("NFKC", s or "").replace("\ufffc", "")
    s = s.translate({0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x2014: "-", 0x2013: "-"})
    s = re.sub(r"[^\w']+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def to_ms(iso):
    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _from_command(cmd):
    """(texts, files) passed to message-sending commands inside a shell command string."""
    texts, files = [], []
    if "send" not in cmd:
        return texts, files
    # osascript one-liners escape apostrophes as '"'"' inside a single-quoted script.
    osa = cmd.replace("'\"'\"'", "'")
    for m in _OSA_SEND.finditer(osa):
        texts.append(m.group(1).replace('\\"', '"'))
    files += _OSA_FILE.findall(osa)
    if "imsg" in cmd:
        try:
            toks = shlex.split(cmd)
        except ValueError:
            toks = None
        if toks is None:
            texts += [m.group(1)[1:-1] for m in re.finditer(r"--text\s+(\"(?:[^\"\\]|\\.)*\"|'[^']*')", cmd)]
        else:
            in_send = False
            for i, t in enumerate(toks):
                if t == "imsg" or t.endswith("/imsg"):
                    in_send = i + 1 < len(toks) and toks[i + 1] == "send"
                elif in_send and i + 1 < len(toks) and t == "--text":
                    texts.append(toks[i + 1])
                elif in_send and i + 1 < len(toks) and t == "--file":
                    files.append(toks[i + 1])
    return texts, files


def sent_payloads(inp):
    """(texts, files) a tool input sent as messages, or ([], []) for anything else."""
    texts, files = [], []
    if not isinstance(inp, dict):
        return texts, files
    for k in ("command", "code"):
        v = inp.get(k)
        if isinstance(v, str):
            t, f = _from_command(v)
            texts += t
            files += f
            if k == "code" and "type_text" in v:
                texts += [m.group(1) for m in re.finditer(r'text\s*:\s*"((?:[^"\\]|\\.)*)"', v)]
    return texts, files


class Sends:
    """Send payloads from the assistant's tool calls, loaded lazily per time window."""

    def __init__(self, db=OC_DB):
        self.db = db
        self.loaded = []  # (lo, hi) windows already fetched
        self.items = []  # (time_ms, norm_text, basenames)
        self.blobs = []  # (time_ms, normalized raw input of a send call)

    def _load(self, lo, hi):
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=3)
        try:
            q = ("SELECT time_created, data FROM session_message WHERE time_created BETWEEN ? AND ? "
                 "AND type='assistant' AND (" + " OR ".join("data LIKE ?" for _ in _SEND_TERMS) + ")")
            rows = con.execute(q, [lo, hi] + [f"%{t}%" for t in _SEND_TERMS]).fetchall()
        finally:
            con.close()
        for tc, data in rows:
            try:
                j = json.loads(data)
            except ValueError:
                continue
            for c in j.get("content") or []:
                if c.get("type") != "tool":
                    continue
                inp = (c.get("state") or {}).get("input")
                texts, files = sent_payloads(inp)
                t0 = ((c.get("time") or {}).get("created")) or tc
                for t in texts:
                    self.items.append((t0, norm(t), ()))
                if files:
                    self.items.append((t0, "", tuple(os.path.basename(f) for f in files)))
                # Texts passed indirectly (heredoc file + --text "$(cat f)") only show up in the raw input.
                raw = " ".join(v for v in (inp or {}).values() if isinstance(v, str)) if isinstance(inp, dict) else ""
                if _SEND_CALL.search(raw):
                    self.blobs.append((t0, norm(raw)))
        self.loaded.append((lo, hi))

    def near(self, t):
        lo, hi = t - WINDOW_BEFORE_MS, t + WINDOW_AFTER_MS
        if not any(a <= lo and hi <= b for a, b in self.loaded):
            self._load(lo, hi)
        return [x for x in self.items if lo <= x[0] <= hi]

    def blobs_near(self, t):
        self.near(t)
        lo, hi = t - WINDOW_BEFORE_MS, t + WINDOW_AFTER_MS
        return [b for ts, b in self.blobs if lo <= ts <= hi]


def text_match(sent, got):
    if not sent or not got:
        return False
    if sent == got:
        return True
    if len(got) >= PREFIX and len(sent) >= PREFIX:
        return sent[:PREFIX] == got[:PREFIX]
    # imsg splits nothing, but long texts can be trimmed or sent in parts
    return len(got) >= 12 and (got in sent or sent in got) and min(len(got), len(sent)) >= 0.5 * max(len(got), len(sent))


def classify_one(m, sends):
    atts = m.get("attachments") or []
    paths = [(a.get("original_path") or a.get("filename") or "") for a in atts]
    if any("/Messages/Attachments/imsg/" in p for p in paths):
        return "robob"
    t = to_ms(m["created_at"])
    cands = sends.near(t)
    got = norm(m.get("text"))
    if got and any(text_match(s, got) for _, s, _ in cands):
        return "robob"
    if len(got) >= BLOB_MIN and any(got[:PREFIX] in b for b in sends.blobs_near(t)):
        return "robob"
    names = {os.path.basename(a.get("transfer_name") or a.get("filename") or "") for a in atts} - {""}
    if names and any(names & set(f) for _, _, f in cands):
        return "robob"
    return "abdullah"


def attribute(msgs, cache_path=None, db=OC_DB, now_ms=None):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    cache = {}
    if cache_path and os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path))
        except (OSError, ValueError):
            cache = {}
    sends = Sends(db)
    out, dirty = {}, False
    for m in msgs:
        if not m.get("is_from_me"):
            continue
        k = str(m["id"])
        if k in cache:
            out[m["id"]] = cache[k]
            continue
        try:
            v = classify_one(m, sends)
        except (sqlite3.Error, OSError):
            out[m["id"]] = "unknown"
            continue
        out[m["id"]] = v
        if v == "robob" or now_ms - to_ms(m["created_at"]) > SETTLE_MS:
            cache[k] = v
            dirty = True
    if cache_path and dirty:
        keep = dict(sorted(cache.items(), key=lambda kv: int(kv[0]))[-2000:])
        tmp = cache_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(keep, f)
        os.replace(tmp, cache_path)
    return out


def main(argv):
    cache = None
    if len(argv) >= 2 and argv[0] == "--cache":
        cache = argv[1]
    msgs = [json.loads(l) for l in sys.stdin if l.strip()]
    print(json.dumps({str(k): v for k, v in attribute(msgs, cache).items()}))


if __name__ == "__main__":
    main(sys.argv[1:])
