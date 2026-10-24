#!/usr/bin/python3
"""Push trigger for the OTP watcher: IMAP IDLE on every inbox/junk box, run otp-watch.py on new mail.

LaunchAgent local.ardud.otp-idle (KeepAlive). One thread per (account, mailbox) holds an IDLE
connection. When the server pushes EXISTS/RECENT, it runs `otp-watch.py --account ACCT`
(one run at a time per account, re-run once if more mail arrived meanwhile). otp-watch.py does all
parsing, dedupe and Telegram delivery; the 60s launchd poll (local.ardud.otp-watch) stays as a fallback.

Reconnects with backoff, re-IDLEs every 9 min and re-logs in every 45 min (OAuth tokens last ~1h).
IPv4 is forced (this Mac's IPv6 has been blackholed before). Never reads or flags messages.
Log: ~/.local/state/otp-watch/otp-idle.log
"""
import imaplib
import os
import select
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime

HOME = os.path.expanduser("~")
ORTIE = f"{HOME}/.local/bin/ortie"
KC_READ = f"{HOME}/.local/libexec/mail/kc-read"
sys.path.insert(0, f"{HOME}/.local/libexec/mail")
import mail_oauth  # noqa: E402
OTP_WATCH = f"{HOME}/.local/libexec/mail/otp-watch.py"
STATE_DIR = f"{HOME}/.local/state/otp-watch"
LOG_FILE = f"{STATE_DIR}/otp-idle.log"

# Same account/mailbox set as otp-watch.py (IMAP names).
BOXES = {
    "icloud": ("imap.mail.me.com", "abdullahrangoonwala@icloud.com", "icloud", ["INBOX", "Junk"]),
    "gmail": ("imap.gmail.com", "surprisedwarrior@gmail.com", "google", ["INBOX", "[Gmail]/Spam"]),
    "fund": ("imap.gmail.com", "me@abdullah.fund", "google", ["INBOX", "[Gmail]/Spam"]),
    "outlook": ("outlook.office365.com", "ardudeisepic@outlook.com", "outlook", ["INBOX", "Junk"]),
}
IDLE_RENEW_S = 9 * 60
RELOGIN_S = 45 * 60
DEBOUNCE_S = 1.0

_orig_gai = socket.getaddrinfo


def _gai_v4(host, port, family=0, *a, **k):
    if family in (0, socket.AF_UNSPEC):
        try:
            return _orig_gai(host, port, socket.AF_INET, *a, **k)
        except socket.gaierror:
            pass
    return _orig_gai(host, port, family, *a, **k)


socket.getaddrinfo = _gai_v4
_log_lock = threading.Lock()


def log(msg):
    with _log_lock:
        try:
            if os.path.getsize(LOG_FILE) > 512 * 1024:
                os.replace(LOG_FILE, LOG_FILE + ".1")
        except OSError:
            pass
        with open(LOG_FILE, "a") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def secret(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"credential command failed ({os.path.basename(cmd[0])} rc={r.returncode})")
    return r.stdout.strip()


def connect(acct):
    host, user, auth, _ = BOXES[acct]
    if auth == "icloud":
        M = imaplib.IMAP4_SSL(host, timeout=30)
        try:
            M.login(user, secret([KC_READ, "himalaya-icloud", "himalaya"]))
        except imaplib.IMAP4.error as e:
            raise RuntimeError(f"IMAP auth failed: {str(e)[:160]}")
        return M
    # XOAUTH2 with self-heal (other MS frontends, token refresh): mail_oauth.py
    return mail_oauth.xoauth2_connect(acct, host, user, timeout=30)

class Scanner:
    """Runs otp-watch.py for one account; coalesces bursts into at most one queued re-run."""

    def __init__(self, acct):
        self.acct = acct
        self.lock = threading.Lock()
        self.running = False
        self.again = False

    def kick(self, why):
        with self.lock:
            if self.running:
                self.again = True
                return
            self.running = True
        threading.Thread(target=self._run, args=(why,), daemon=True).start()

    def _run(self, why):
        time.sleep(DEBOUNCE_S)
        while True:
            t0 = time.time()
            try:
                r = subprocess.run(["/usr/bin/python3", OTP_WATCH, "--account", self.acct],
                                   capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
                log(f"{self.acct}: scan ({why}) rc={r.returncode} {time.time() - t0:.1f}s{(' ' + r.stderr.strip()[-200:]) if r.returncode else ''}")
            except subprocess.TimeoutExpired:
                log(f"{self.acct}: scan ({why}) timed out")
            with self.lock:
                if not self.again:
                    self.running = False
                    return
                self.again = False
                why = "more mail"


def idle_once(M, box, on_new):
    """One IDLE cycle of up to IDLE_RENEW_S. Returns when renewal is due; raises on connection trouble."""
    tag = M._new_tag()
    M.send(tag + b" IDLE\r\n")
    line = M.readline()
    if not line.startswith(b"+"):
        raise RuntimeError(f"IDLE refused on {box}: {line[:120]!r}")
    sock = M.socket()
    deadline = time.time() + IDLE_RENEW_S
    # Wait with select(): a read timeout would poison imaplib's buffered reader. Any buffered extra line
    # after a push is harmless, because one push already queues a scan of the whole account.
    while True:
        left = deadline - time.time()
        if left <= 0:
            break
        ready, _, _ = select.select([sock], [], [], min(left, 60))
        if not ready:
            continue
        line = M.readline()
        if not line:
            raise RuntimeError("connection closed")
        up = line.upper()
        if b"EXISTS" in up or b"RECENT" in up:
            on_new()
        elif up.startswith(b"* BYE"):
            raise RuntimeError(f"server BYE: {line[:120]!r}")
    M.send(b"DONE\r\n")
    while True:  # drain until the tagged completion of this IDLE
        line = M.readline()
        if not line:
            raise RuntimeError("connection closed after DONE")
        if line.startswith(tag):
            return
        if b"EXISTS" in line.upper():
            on_new()


def watch(acct, box, scanner):
    backoff = 5
    while True:
        M = None
        try:
            M = connect(acct)
            typ, _ = M.select(f'"{box}"', readonly=True)
            if typ != "OK":
                raise RuntimeError(f"select {box} failed")
            log(f"{acct}/{box}: idling")
            # Catch anything that arrived while this box was disconnected.
            scanner.kick(f"{box} connected")
            backoff = 5
            since = time.time()
            while time.time() - since < RELOGIN_S:
                idle_once(M, box, lambda: scanner.kick(f"new mail in {box}"))
        except Exception as e:  # noqa: BLE001
            log(f"{acct}/{box}: {type(e).__name__}: {str(e)[:200]}; retry in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 300)
        finally:
            if M is not None:
                try:
                    M.shutdown()
                except Exception:  # noqa: BLE001
                    pass


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    only = sys.argv[1:] or list(BOXES)
    log(f"otp-idle started pid={os.getpid()} accounts={','.join(only)}")
    threads = []
    for acct in only:
        scanner = Scanner(acct)
        for box in BOXES[acct][3]:
            t = threading.Thread(target=watch, args=(acct, box, scanner), daemon=True, name=f"{acct}/{box}")
            t.start()
            threads.append(t)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
