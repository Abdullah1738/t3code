"""Paths, the external-volume guard, logging and the IPv4 preference shared by every module."""
import os
import socket
import sys
import time

HOME = os.path.expanduser("~")
VOLUME = os.environ.get("MSGS_VOLUME", "/Volumes/ExternalSSD")
ROOT = os.environ.get("MSGS_ROOT", os.path.join(VOLUME, "message-archive"))
DB_PATH = os.path.join(ROOT, "index.db")
MAIL_DIR = os.path.join(ROOT, "mail")
MAIL_LIBEXEC = os.path.join(HOME, ".local/libexec/mail")
KC_READ = os.path.join(MAIL_LIBEXEC, "kc-read")
CHAT_DB = os.environ.get("MSGS_CHAT_DB", os.path.join(HOME, "Library/Messages/chat.db"))
WACLI_DB = os.environ.get("MSGS_WACLI_DB", os.path.join(HOME, ".wacli/wacli.db"))
ADDRESSBOOK = os.environ.get("MSGS_ADDRESSBOOK", os.path.join(HOME, "Library/Application Support/AddressBook"))

MAIL_ACCOUNTS = {
    "icloud": {"kind": "imap", "host": "imap.mail.me.com", "user": "abdullahrangoonwala@icloud.com"},
    "gmail": {"kind": "gmail", "user": "surprisedwarrior@gmail.com"},
    "fund": {"kind": "gmail", "user": "me@abdullah.fund"},
    "outlook": {"kind": "imap", "host": "outlook.office365.com", "user": "ardudeisepic@outlook.com"},
    "juno": {"kind": "gmail", "user": "abdullah@thejunowallet.com"},
}
CHAT_SOURCES = ("imessage", "whatsapp")

os.umask(0o077)


class NotMounted(RuntimeError):
    pass


def volume_ready():
    """True when the archive may be written. Tests point MSGS_ROOT at a temp dir instead."""
    if os.environ.get("MSGS_ROOT"):
        return True
    return os.path.ismount(VOLUME)


def require_volume():
    if not volume_ready():
        raise NotMounted(f"{VOLUME} is not mounted; not writing the archive to the boot disk")
    os.makedirs(ROOT, mode=0o700, exist_ok=True)


def log(msg):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", file=sys.stderr, flush=True)


_orig_gai = socket.getaddrinfo


def _gai_v4(host, port, family=0, *a, **k):
    # IPv6 is blackholed on some networks this Mac joins; prefer IPv4 like mailsearch does.
    if family in (0, socket.AF_UNSPEC):
        try:
            return _orig_gai(host, port, socket.AF_INET, *a, **k)
        except socket.gaierror:
            pass
    return _orig_gai(host, port, family, *a, **k)


socket.getaddrinfo = _gai_v4
