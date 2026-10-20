"""Turn a raw RFC822 message into index fields, and keep the raw bytes on disk (zstd)."""
import email
import email.policy
import hashlib
import html
import os
import re
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr, parsedate_to_datetime

from compression import zstd

import common

# Tag patterns stop at the next "<" so a page full of unclosed "<" stays linear.
_DROP_OPEN = re.compile(r"(?i)<(script|style|head|title)\b[^<>]*>")
_BREAKS = re.compile(r"(?i)<\s*(br|/p|/div|/tr|/li|/h\d|/table)\b[^<>]*>")
_TAG = re.compile(r"<[^<>]*>")
_SPACE = re.compile(r"[ \t\r\f\v\u00a0\u200b\u200c\u200d\u2060\ufeff\u034f]+")
_BLANKS = re.compile(r"\n\s*\n+")
HTML_CAP = 1_000_000  # the stored body is cut to 100k anyway
SUBJECT_RE = re.compile(rb"(?im)^subject:[ \t]*(.*)$")


def _drop_blocks(s):
    """Remove <script>/<style>/<head>/<title> blocks. An unclosed opener only drops the tag itself."""
    low = s.lower()
    out, pos, unclosed = [], 0, set()
    while True:
        m = _DROP_OPEN.search(s, pos)
        if not m:
            break
        tag = m.group(1).lower()
        end = -1 if tag in unclosed else low.find(f"</{tag}", m.end())
        out.append(s[pos:m.start()])
        out.append(" ")
        if end < 0:
            unclosed.add(tag)
            pos = m.end()
        else:
            close = s.find(">", end)
            pos = len(s) if close < 0 else close + 1
    out.append(s[pos:])
    return "".join(out)


def html_to_text(s):
    s = _drop_blocks(s[:HTML_CAP])
    s = _BREAKS.sub("\n", s)
    s = _TAG.sub(" ", s)
    s = html.unescape(s)
    return squash(s)


def squash(s):
    s = _SPACE.sub(" ", s)
    s = _BLANKS.sub("\n", s)
    return s.strip()


def hdr(v):
    if v is None:
        return ""
    try:
        return str(make_header(decode_header(str(v)))).strip()
    except Exception:
        return str(v).strip()


def _part_text(part):
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        payload = None
    if payload is None:
        return ""
    try:
        charset = str(part.get_content_charset() or "utf-8")
        return payload.decode(charset, "replace")
    except Exception:  # unknown or broken charsets ("idna", junk names)
        return payload.decode("utf-8", "replace")


def parse(raw):
    """Return dict(subject, sender, sender_addr, recipients, ts, msgid, body, attachments).

    Never raises: a message the email package can't handle becomes a stub with its raw text as
    the body, so one odd message can't stall an account's sync.
    """
    try:
        return _parse(raw)
    except Exception as e:
        common.log(f"mailparse: stub for unparseable message ({type(e).__name__}: {e})")
        m = SUBJECT_RE.search(raw[:65536])
        return {"subject": hdr(m.group(1).decode("utf-8", "replace")) if m else "", "sender": "", "sender_addr": "",
                "recipients": "", "ts": 0, "msgid": None, "attachments": "",
                "body": squash(raw[:200_000].decode("utf-8", "replace"))}


def _parse(raw):
    msg = email.message_from_bytes(raw, policy=email.policy.compat32)
    subject = hdr(msg.get("Subject"))
    from_name, from_addr = parseaddr(hdr(msg.get("From")))
    rcpts = []
    for h in ("To", "Cc", "Bcc", "Delivered-To"):
        for name, addr in getaddresses([hdr(v) for v in msg.get_all(h, [])]):
            if addr or name:
                rcpts.append(f"{name} <{addr}>" if name and addr else (addr or name))
    ts = 0
    try:
        d = parsedate_to_datetime(msg.get("Date"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        ts = int(d.timestamp())
    except Exception:
        ts = 0
    plain, htmls, atts = [], [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        try:
            fname = part.get_filename()
        except Exception:
            fname = None
        # compat32 hands back Header objects for 8-bit headers, so stringify before using.
        disp = str(part.get("Content-Disposition") or "").lower()
        if fname or disp.startswith("attachment"):
            atts.append(hdr(fname) if fname else ctype)
            continue
        if ctype == "text/plain":
            plain.append(_part_text(part))
        elif ctype == "text/html":
            htmls.append(_part_text(part))
    body = squash("\n".join(plain)) if any(p.strip() for p in plain) else html_to_text("\n".join(htmls))
    return {
        "subject": subject,
        "sender": f"{from_name} <{from_addr}>" if from_name and from_addr else (from_addr or from_name),
        "sender_addr": (from_addr or "").lower(),
        "recipients": ", ".join(dict.fromkeys(rcpts)),
        "ts": ts,
        "msgid": hdr(msg.get("Message-ID")).strip("<>") or None,
        "body": body,
        "attachments": " | ".join(atts),
    }


def raw_path(account, ts, key):
    d = datetime.fromtimestamp(ts or 0, timezone.utc)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", key)[:120]
    if len(safe) < len(key) or safe != key:
        safe = f"{safe[:80]}-{hashlib.sha1(key.encode()).hexdigest()[:12]}"
    return os.path.join(account, f"{d:%Y}", f"{d:%m}", f"{safe}.eml.zst")


def save_raw(rel, raw):
    full = os.path.join(common.MAIL_DIR, rel)
    try:
        if os.path.getsize(full) > 0:
            return
    except OSError:
        pass
    os.makedirs(os.path.dirname(full), mode=0o700, exist_ok=True)
    tmp = full + ".part"
    with open(tmp, "wb") as f:
        f.write(zstd.compress(raw, level=6))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, full)


def load_raw(rel):
    with open(os.path.join(common.MAIL_DIR, rel), "rb") as f:
        return zstd.decompress(f.read())
