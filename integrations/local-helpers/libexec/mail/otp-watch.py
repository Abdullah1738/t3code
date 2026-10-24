#!/usr/bin/env python3
"""Poll mail accounts via himalaya and forward OTP / verification codes to Telegram.

Runs from launchd (local.ardud.otp-watch) every 30s as a fallback, and on demand from otp-idle.py
(local.ardud.otp-idle), which holds IMAP IDLE on every inbox/junk box and runs
`otp-watch.py --account ACCT` within ~1s of new mail. Never marks mail as read.
Overlapping runs are safe: Telegram dedupes by key, and seen.json is merged under a lock on save.
State: ~/.local/state/otp-watch/seen.json (message keys already processed).
Log:   ~/.local/state/otp-watch/otp-watch.log
"""
import email
import email.policy
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
HIMALAYA = "/opt/homebrew/bin/himalaya"
sys.path.insert(0, os.path.expanduser("~/.local/libexec/mail"))
import mail_oauth  # noqa: E402
BUN = f"{HOME}/.bun/bin/bun"
TG_CLI = f"{HOME}/.local/share/telegram-bridge/src/cli.ts"
STATE_DIR = f"{HOME}/.local/state/otp-watch"
SEEN_FILE = f"{STATE_DIR}/seen.json"
LOG_FILE = f"{STATE_DIR}/otp-watch.log"

# account -> mailboxes to scan (inbox + junk/spam)
ACCOUNTS = {
    "icloud": ["Inbox", "Junk"],
    "gmail": ["Inbox", "[Gmail]/Spam"],
    "fund": ["Inbox", "[Gmail]/Spam"],
    "outlook": ["Inbox", "Junk"],
}
LABELS = {
    "icloud": "abdullahrangoonwala@icloud.com",
    "gmail": "surprisedwarrior@gmail.com",
    "fund": "me@abdullah.fund",
    "outlook": "ardudeisepic@outlook.com",
}
WINDOW_MIN = 15      # only consider mail dated within the last N minutes
PAGE_SIZE = 10
SEEN_TTL_DAYS = 3

# strong OTP intent (subject or body); generic "code"/"log in" alone is not enough
KEYWORDS = re.compile(
    r"(verification code|verify|verification|one[- ]?time|\botp\b|passcode|pass code|security code|"
    r"log ?in code|sign[- ]?in code|sign[- ]?in to|log ?in to|confirmation code|confirm your|"
    r"auth(?:entication)? code|\b2fa\b|two[- ]factor|access code|your code|the code below|this code|"
    r"code to (?:sign|log|verify|confirm|continue|complete)|code (?:is|expires)|is your (?:\w+ )?code|expires in \d+ ?min)",
    re.I,
)
PROMO = re.compile(
    r"(promo|coupon|discount|voucher|% ?off|\boff your\b|sale ends|use code at checkout|referral code|"
    r"bonus|free spins?|jackpot|rakeback|cashback|\bwager(?:ing|s)?\b|\bredeem(?:ed|able|able)?\b|"
    r"\bcasino\b|\bbetting\b|deposit (?:match|bonus|code)|invite.only offer|\bprize(?:s)?\b)",
    re.I,
)
# promo-style codes spell marketing words (10XBONUS, FREESPIN) — never real OTPs
PROMO_TOKEN = re.compile(r"bonus|free|spin|win|jackpot|promo|cash|lucky|gold|deposit", re.I)
# a code token: 4-8 digits, "123 456", or an uppercase alnum code (with at least one digit) like ABC-123 / A1B2C3
TOKEN = r"(?-i:(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9-]*\d)[A-Z0-9]{3,4}-?[A-Z0-9]{3,4}))\b"
# code near a keyword: "code: 123456", "code is 123456"
CODE_AFTER = re.compile(
    r"(?:code|otp|passcode|pin|token)\b(?:\s+(?:is|was))?\s*[:\-]?\s*" + TOKEN,
    re.I,
)
# "123456 is your code", "Use 7732 to sign in", "Enter 123456 to verify"
CODE_BEFORE = re.compile(
    r"\b" + TOKEN + r"\s+(?:is your|is the|as your|to (?:sign|log) ?in|to verify|to confirm|to continue|to complete)",
    re.I,
)
USE_CODE = re.compile(r"\b(?:use|enter|type)\s+(?:the\s+)?(?:code\s+)?" + TOKEN, re.I)
STANDALONE = re.compile(r"(?m)^\s*(\d{4,8}|\d{3} \d{3}|(?=[A-Z0-9-]*\d)[A-Z0-9]{3}-[A-Z0-9]{3})\s*$")


def log(msg):
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        if os.path.getsize(LOG_FILE) > 512 * 1024:
            os.replace(LOG_FILE, LOG_FILE + ".1")
    except OSError:
        pass
    with open(LOG_FILE, "a") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def run(cmd, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def load_seen():
    try:
        with open(SEEN_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_seen(seen):
    import fcntl
    with open(SEEN_FILE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        merged = load_seen()  # another run may have saved since we loaded
        merged.update(seen)
        cutoff = time.time() - SEEN_TTL_DAYS * 86400
        merged = {k: v for k, v in merged.items() if v >= cutoff}
        tmp = f"{SEEN_FILE}.tmp-{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(merged, f)
        os.replace(tmp, SEEN_FILE)


def html_to_text(s):
    s = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|tr|td|h\d|li)>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\u00a0\u200c\u200b]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n", s)


def body_text(raw):
    msg = email.message_from_string(raw, policy=email.policy.default)
    plain, htm = [], []
    for part in msg.walk():
        ct = part.get_content_type()
        if part.get_content_disposition() == "attachment":
            continue
        try:
            if ct == "text/plain":
                plain.append(part.get_content())
            elif ct == "text/html":
                htm.append(part.get_content())
        except Exception:
            continue
    text = "\n".join(plain) if plain else html_to_text("\n".join(htm))
    return text[:20000]


def extract_code(subject, text):
    blob = f"{subject}\n{text}"
    if not KEYWORDS.search(blob):
        return None
    if PROMO.search(subject) or (PROMO.search(text[:3000]) and not KEYWORDS.search(subject)):
        return None
    candidates = []
    for rx in (CODE_AFTER, CODE_BEFORE, USE_CODE):
        for m in rx.finditer(blob):
            candidates.append(m.group(1))
    if not candidates:
        for m in STANDALONE.finditer(text):
            candidates.append(m.group(1))
    for c in candidates:
        c = c.strip()
        digits = sum(ch.isdigit() for ch in c)
        # reject years, obvious non-codes, and pure-letter words
        if re.fullmatch(r"(19|20)\d{2}", c):
            continue
        if digits == 0:
            continue
        if not c.isdigit() and digits < 2:
            continue
        if not c.isdigit() and PROMO_TOKEN.search(c):
            continue
        return c
    return None


def magic_link(subject, text):
    if not re.search(r"(sign[- ]?in|log[- ]?in|magic link|verify)", subject, re.I):
        return None
    m = re.search(r"https://[^\s\"'<>]*(?:login|signin|sign-in|verify|magic|auth|token)[^\s\"'<>]*", text, re.I)
    return bool(m)


def notify(key, text):
    r = run([BUN, TG_CLI, "notify", "--source", "Email OTP", "--severity", "attention",
             "--text", text, "--key", key], timeout=30)
    if r.returncode != 0:
        log(f"notify failed key={key} rc={r.returncode} err={r.stderr.strip()[:300]}")
        return False
    return True


def scan(seen, bootstrap=False, only=None):
    from concurrent.futures import ThreadPoolExecutor
    items = [(a, b) for a, b in ACCOUNTS.items() if not only or a in only]
    with ThreadPoolExecutor(max_workers=max(1, len(items))) as ex:
        list(ex.map(lambda item: scan_account(seen, item[0], item[1], bootstrap), items))


def scan_account(seen, acct, boxes, bootstrap):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=WINDOW_MIN)
    if True:
        for box in boxes:
            r = None
            try:
                # retries + token refresh on XOAUTH2 failures: mail_oauth.himalaya_heal
                r = mail_oauth.himalaya_heal(["envelope", "list", "-a", acct, "-m", box,
                                              "-s", str(PAGE_SIZE), "--json"], timeout=30)
            except subprocess.TimeoutExpired:
                # a hang is network (e.g. broken IPv6), not the MS auth flake: don't retry
                r = None
            if r is None:
                log(f"{acct}/{box}: list timeout")
                continue
            if r.returncode != 0:
                log(f"{acct}/{box}: list failed: {(r.stdout + r.stderr).strip()[:200]}")
                continue
            try:
                envs = json.loads(r.stdout).get("envelopes", [])
            except Exception as e:
                log(f"{acct}/{box}: bad json {e}")
                continue
            for env in envs:
                mid = env.get("message-id") or f"{box}:{env.get('id')}"
                key = hashlib.sha1(f"{acct}|{mid}".encode()).hexdigest()[:20]
                if key in seen:
                    continue
                try:
                    dt = datetime.fromisoformat(env["date"].replace("Z", "+00:00"))
                except Exception:
                    dt = now
                if bootstrap or dt < cutoff:
                    seen[key] = time.time()
                    continue
                subject = env.get("subject") or ""
                sender = (env.get("from") or [{}])[0]
                sender_s = sender.get("name") or sender.get("email") or "?"
                try:
                    rr = mail_oauth.himalaya_heal(["message", "read", "-a", acct, "-m", box,
                                                  env["id"], "--raw"], timeout=45)
                    text = body_text(rr.stdout) if rr.returncode == 0 else ""
                except Exception as e:
                    log(f"{acct}/{box}: read failed {e}")
                    text = ""
                code = extract_code(subject, text)
                where = LABELS.get(acct, acct) + (" (junk)" if box != "Inbox" else "")
                msg = None
                if code:
                    msg = f"OTP {code}\nFrom: {sender_s}\nSubject: {subject}\nTo: {where}"
                elif magic_link(subject, text):
                    msg = f"Sign-in link email (no code)\nFrom: {sender_s}\nSubject: {subject}\nTo: {where}"
                if msg:
                    if notify(f"otp:{key}", msg[:900]):
                        log(f"notified {acct}/{box} subj={subject[:60]!r}")
                        seen[key] = time.time()
                    # on failure leave unseen so the next run retries with the same key/text
                else:
                    seen[key] = time.time()


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    bootstrap = not os.path.exists(SEEN_FILE) or "--bootstrap" in sys.argv
    only = [sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == "--account"]
    seen = load_seen()
    scan(seen, bootstrap=bootstrap, only=only)
    save_seen(seen)


if __name__ == "__main__":
    main()
