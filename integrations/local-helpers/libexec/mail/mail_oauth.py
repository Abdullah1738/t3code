#!/usr/bin/env python3
"""Shared OAuth/XOAUTH2 self-heal for the mail tools (mailsearch, otp-idle, otp-watch, himalaya-heal).

Microsoft's consumer IMAP frontends intermittently answer a valid XOAUTH2 login with
"NO User is authenticated but not connected", and the bad state sticks per token and per
frontend IP for hours. Healing = try other frontend IPs, and refresh the access token
(rate-limited, under a lock) when logins keep failing. Never prints tokens.
"""
import fcntl
import imaplib
import json
import os
import random
import socket
import ssl
import subprocess
import time

HOME = os.path.expanduser("~")
ORTIE = f"{HOME}/.local/bin/ortie"
KC_READ = f"{HOME}/.local/libexec/mail/kc-read"
STATE_DIR = f"{HOME}/.local/state/mail-oauth"
LOG_FILE = f"{STATE_DIR}/heal.log"
ORTIE_ACCOUNTS = ("gmail", "fund", "outlook", "juno")
MIN_REFRESH_GAP_S = 90      # don't refresh if the token was issued this recently
EARLY_REFRESH_S = 10 * 60   # proactive refresh when less than this is left

AUTH_FLAKE_MARKERS = ("authenticated but not connected", "xoauth2 failed", "authenticate failed",
                      "authenticationfailed", "invalid credentials", "login failed")


def is_auth_failure(text):
    t = (text or "").lower()
    return any(m in t for m in AUTH_FLAKE_MARKERS)


def log(msg):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            if os.path.getsize(LOG_FILE) > 256 * 1024:
                os.replace(LOG_FILE, LOG_FILE + ".1")
        except OSError:
            pass
        with open(LOG_FILE, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{os.getpid()}] {msg}\n")
    except OSError:
        pass


def token_meta(acct):
    """Return (issued_at, expires_in) from the keychain entry, without exposing the token."""
    try:
        r = subprocess.run([KC_READ, f"ortie-{acct}"], capture_output=True, text=True, timeout=15,
                           stdin=subprocess.DEVNULL)
        d = json.loads(r.stdout)
        return int(d.get("issued_at") or 0), int(d.get("expires_in") or 0)
    except Exception:
        return 0, 0


def token_age(acct):
    issued, _ = token_meta(acct)
    return time.time() - issued if issued else None


def seconds_left(acct):
    issued, exp = token_meta(acct)
    return issued + exp - time.time() if issued else None


def refresh(acct, reason="", force=False):
    """Refresh the ortie access token once, serialized across processes.

    Skips when another process refreshed within MIN_REFRESH_GAP_S (unless force).
    Returns True if the token is fresh afterwards.
    """
    if acct not in ORTIE_ACCOUNTS:
        return False
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(f"{STATE_DIR}/{acct}.lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        age = token_age(acct)
        if not force and age is not None and age < MIN_REFRESH_GAP_S:
            return True
        try:
            r = subprocess.run([ORTIE, "-a", acct, "token", "refresh"], capture_output=True, text=True,
                               timeout=30, stdin=subprocess.DEVNULL)
            ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            ok = False
            r = None
        err = "" if ok or r is None else (r.stderr or r.stdout).strip().splitlines()[-1:]
        log(f"{acct}: token refresh {'ok' if ok else 'FAILED'} ({reason}){' ' + str(err)[:160] if err else ''}")
        return ok


def ensure_fresh(acct, margin=EARLY_REFRESH_S):
    """Proactively refresh when the token expires within `margin` seconds."""
    left = seconds_left(acct)
    if left is None or left < margin:
        return refresh(acct, reason=f"expiring ({int(left) if left is not None else '?'}s left)", force=True)
    return True


def get_token(acct, timeout=30):
    r = subprocess.run([ORTIE, "token", "show", "-r", "-a", acct], capture_output=True, text=True,
                       timeout=timeout, stdin=subprocess.DEVNULL)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"credential command failed (ortie rc={r.returncode})")
    return r.stdout.strip()


def _v4_addrs(host, port):
    try:
        addrs = list(dict.fromkeys(a[4][0] for a in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)))
    except socket.gaierror:
        addrs = []
    random.shuffle(addrs)
    return addrs


class _PinnedIMAP(imaplib.IMAP4_SSL):
    """IMAP4_SSL to a specific IP while keeping SNI/cert checks for the real hostname."""

    def __init__(self, host, ip, timeout):
        self._pin_ip = ip
        super().__init__(host, 993, timeout=timeout)

    def _create_socket(self, timeout):
        raw = socket.create_connection((self._pin_ip, self.port), timeout)
        return self.ssl_context.wrap_socket(raw, server_hostname=self.host)


def xoauth2_connect(acct, host, user, timeout=30, deadline=None, max_tries=None):
    """Log in with XOAUTH2, healing MS frontend flakes and stale tokens.

    Tries different frontend IPs; after repeated auth failures refreshes the token once and
    keeps trying. Raises RuntimeError("IMAP auth failed: ...") when it gives up.
    """
    ms = acct == "outlook"
    max_tries = max_tries or (8 if ms else 2)
    addrs = _v4_addrs(host, 993) or [None]
    good_file = os.path.expanduser(f"~/.cache/mail-oauth-good-ip-{acct}")
    if ms:
        # Try the last frontend that accepted AUTH first (MS often has only a few healthy ones).
        try:
            good = open(good_file).read().strip()
            if good:
                addrs = [good] + [a for a in addrs if a != good]
        except OSError:
            pass
    refreshed = False
    last = None
    tok = get_token(acct, timeout)
    for i in range(max_tries):
        if deadline and time.monotonic() > deadline - 2:
            break
        ip = addrs[i % len(addrs)]
        t = timeout if not deadline else max(3, min(timeout, deadline - time.monotonic()))
        try:
            M = _PinnedIMAP(host, ip, t) if ip else imaplib.IMAP4_SSL(host, timeout=t)
        except (OSError, ssl.SSLError) as e:
            last = e
            continue
        blob = f"user={user}\x01auth=Bearer {tok}\x01\x01".encode()
        try:
            if ms and hasattr(M, "sock"):
                # MS frontends sometimes hang at AUTH; fail fast and rotate to another IP.
                M.sock.settimeout(min(t, 4))
            M.authenticate("XOAUTH2", lambda _: blob)
            if ms and hasattr(M, "sock"):
                M.sock.settimeout(t)
                if ip:
                    try:
                        os.makedirs(os.path.dirname(good_file), exist_ok=True)
                        open(good_file, "w").write(ip)
                    except OSError:
                        pass
            if i:
                log(f"{acct}: login ok on try {i + 1} ({ip}){' after refresh' if refreshed else ''}")
            return M
        except (socket.timeout, TimeoutError, ssl.SSLError, ConnectionError) as e:
            # Hung/broken frontend, not a token problem: try the next IP.
            last = e
            try:
                M.shutdown()
            except Exception:
                pass
            continue
        except imaplib.IMAP4.error as e:
            last = e
            try:
                M.shutdown()
            except Exception:
                pass
            # Google: one failure means a bad token. MS: refresh after a couple of bad frontends.
            if not refreshed and (not ms or i >= 1):
                refreshed = True
                if refresh(acct, reason=f"login failed: {str(e)[:60]}"):
                    tok = get_token(acct, timeout)
            elif ms:
                time.sleep(0.3)
    log(f"{acct}: login gave up after retries: {str(last)[:120]}")
    raise RuntimeError(f"IMAP auth failed: {str(last)[:160]}")


HIMALAYA = "/opt/homebrew/bin/himalaya"


def _himalaya_account(argv):
    for i, a in enumerate(argv):
        if a in ("-a", "--account") and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--account="):
            return a.split("=", 1)[1]
    return None


def himalaya_heal(argv, timeout=None):
    """Run himalaya; on XOAUTH2 failure refresh the ortie token and retry (MS: a few times)."""
    acct = _himalaya_account(argv)
    tries = 8 if acct == "outlook" else 2 if acct in ORTIE_ACCOUNTS else 1
    refreshed = False
    r = None
    for i in range(tries):
        r = subprocess.run([HIMALAYA] + argv, capture_output=True, text=True, timeout=timeout,
                           stdin=subprocess.DEVNULL)
        if r.returncode == 0 or not is_auth_failure(r.stdout + r.stderr):
            break
        if not refreshed and (acct != "outlook" or i >= 1):
            refreshed = True
            refresh(acct, reason="himalaya auth failure")
        # MS DNS TTL is 5s: waiting a moment lets himalaya land on another frontend.
        time.sleep(1.5 if acct == "outlook" else 0.5)
    if i and r.returncode == 0:
        log(f"{acct}: himalaya ok on try {i + 1}{' after refresh' if refreshed else ''}")
    elif r.returncode != 0 and i:
        log(f"{acct}: himalaya still failing after {i + 1} tries")
    return r


def main(argv):
    import sys
    if len(argv) >= 2 and argv[0] == "token":
        # himalaya token.command: refresh a few minutes early, then print the token.
        ensure_fresh(argv[1], margin=5 * 60)
        sys.stdout.write(get_token(argv[1]))
        return 0
    if argv and argv[0] == "refresh":
        accts = argv[1:] or list(ORTIE_ACCOUNTS)
        bad = [a for a in accts if not ensure_fresh(a)]
        return 1 if bad else 0
    if argv and argv[0] == "himalaya":
        r = himalaya_heal(argv[1:])
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        return r.returncode
    sys.stderr.write("usage: mail_oauth.py token ACCT | refresh [ACCT...] | himalaya ARGS...\n")
    return 2


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
