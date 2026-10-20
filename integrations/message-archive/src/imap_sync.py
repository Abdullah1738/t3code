"""Mirror IMAP accounts (iCloud, Outlook) folder by folder, incrementally by UID.

ext_id is "<folder>:<uidvalidity>:<uid>". A message moved to another folder shows up as a new
row there and the old row is marked deleted (the archive keeps it). Search folds copies by
Message-ID. Login reuses the mailsearch credentials: keychain for iCloud, ortie XOAUTH2 with the
mail_oauth self-heal for Outlook.
"""
import imaplib
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import common
import mailparse
import store

sys.path.insert(0, common.MAIL_LIBEXEC)
import mail_oauth  # noqa: E402

CHUNK = 50
WORKERS = {"icloud": 4, "outlook": 4}
IDLE_RECONNECT = 600  # servers may drop a connection idle for 30 min; don't reuse one older than this
BAD_LIMIT = 3  # a single UID that fails this many times is skipped until the daemon restarts
RETRY_SLEEP = 2
SKIP = re.compile(r"(?i)^(drafts|outbox|notes|sync issues|conversation history|calendar|contacts|tasks|journal)(/.*)?$")
SENT = re.compile(r"(?i)^(sent|sent messages|sent items)$")
JUNK = re.compile(r"(?i)^(junk|junk e-?mail|spam|unwanted)$")
LIST_RE = re.compile(rb'\((?P<flags>[^)]*)\) (?P<sep>"[^"]*"|NIL) (?P<name>.+)$')
UID_RE = re.compile(rb"UID (\d+)")
DATE_RE = re.compile(rb'INTERNALDATE "([^"]+)"')
imaplib._MAXLINE = 10_000_000


def quote(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def connect(acct, timeout=60):
    cfg = common.MAIL_ACCOUNTS[acct]
    if acct == "icloud":
        pw = subprocess.run([common.KC_READ, "himalaya-icloud", "himalaya"], capture_output=True, text=True,
                            timeout=30, stdin=subprocess.DEVNULL).stdout.strip()
        if not pw:
            raise RuntimeError("icloud: keychain password missing")
        m = imaplib.IMAP4_SSL(cfg["host"], timeout=timeout)
        m.login(cfg["user"], pw)
        return m
    return mail_oauth.xoauth2_connect(acct, cfg["host"], cfg["user"], timeout=timeout)


def folders(m):
    typ, data = m.list()
    out = []
    for line in data or []:
        if not isinstance(line, bytes):
            continue
        mm = LIST_RE.match(line)
        if not mm:
            continue
        if b"\\noselect" in mm.group("flags").lower():
            continue
        name = mm.group("name").decode("utf-8", "replace").strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        if not SKIP.match(name):
            out.append(name)
    return out


def select(m, folder):
    typ, data = m.select(quote(folder), readonly=True)
    if typ != "OK":
        raise RuntimeError(f"select {folder}: {data}")
    exists = int(data[0]) if data and data[0] else 0
    uv = int(m.untagged_responses.get("UIDVALIDITY", [b"0"])[0])
    return exists, uv


def search_uids(m, crit):
    typ, data = m.uid("SEARCH", None, crit)
    if typ != "OK":
        raise RuntimeError(f"uid search: {data}")
    return [int(x) for x in (data[0] or b"").split()]


def _internaldate(meta):
    mm = DATE_RE.search(meta)
    if not mm:
        return 0
    try:
        return int(datetime.strptime(mm.group(1).decode(), "%d-%b-%Y %H:%M:%S %z").timestamp())
    except ValueError:
        return 0


class Pool:
    """One IMAP connection per worker thread, each with the current folder selected."""

    def __init__(self, acct):
        self.acct = acct
        self.local = threading.local()
        self.conns = []
        self.lock = threading.Lock()

    def get(self, folder, reset=False):
        c = getattr(self.local, "conn", None)
        if c is not None and time.time() - getattr(self.local, "used", 0) > IDLE_RECONNECT:
            reset = True
        if reset and c is not None:
            try:
                c.logout()
            except Exception:
                pass
            c = None
        if c is None:
            self.local.conn = None
            c = connect(self.acct)
            self.local.conn = c
            self.local.folder = None
            with self.lock:
                self.conns.append(c)
        if self.local.folder != folder:
            self.local.folder = None
            select(c, folder)
            self.local.folder = folder
        self.local.used = time.time()
        return c

    def drop(self):
        """Forget this thread's connection (after an error) so the next get() reconnects."""
        c = getattr(self.local, "conn", None)
        self.local.conn = None
        self.local.folder = None
        if c is not None:
            try:
                c.logout()
            except Exception:
                pass

    def close(self):
        for c in self.conns:
            try:
                c.logout()
            except Exception:
                pass


class Rejected(RuntimeError):
    """The server answered NO/BAD for a FETCH (the connection itself is fine)."""


BAD = {}  # (acct, folder, uidvalidity, uid) -> failed single-UID fetches since the daemon started
_BAD_LOCK = threading.Lock()


def _fetch_raw(pool, folder, uids):
    for attempt in range(3):
        try:
            c = pool.get(folder, reset=attempt > 0)
            typ, data = c.uid("FETCH", ",".join(map(str, uids)), "(UID INTERNALDATE BODY.PEEK[])")
            if typ != "OK":
                raise Rejected(f"fetch: {data}")
            return data
        except imaplib.IMAP4.abort as e:
            err = e
        except imaplib.IMAP4.error as e:
            err = Rejected(str(e))
        except (OSError, Rejected) as e:
            err = e
        pool.drop()
        if attempt == 2:
            raise err
        common.log(f"{pool.acct}/{folder}: fetch retry ({err})")
        time.sleep(RETRY_SLEEP * (attempt + 1))


def _fetch_chunk(pool, acct, folder, uv, uids):
    try:
        data = _fetch_raw(pool, folder, uids)
    except Rejected as e:
        # One bad message must not stall the folder: fetch the chunk one UID at a time.
        if len(uids) == 1:
            with _BAD_LOCK:
                key = (acct, folder, uv, uids[0])
                BAD[key] = BAD.get(key, 0) + 1
            common.log(f"{acct}/{folder}: uid {uids[0]} rejected ({e}); skipped this pass")
            return []
        common.log(f"{acct}/{folder}: chunk rejected ({e}); fetching {len(uids)} UIDs one by one")
        items = []
        for u in uids:
            items.extend(_fetch_chunk(pool, acct, folder, uv, [u]))
        return items
    return _items(acct, folder, uv, data)


def _items(acct, folder, uv, data):
    me = common.MAIL_ACCOUNTS[acct]["user"].lower()
    items = []
    for part in data:
        if not isinstance(part, tuple) or len(part) < 2:
            continue
        meta, raw = part[0], part[1]
        um = UID_RE.search(meta)
        if not um or not raw:
            continue
        uid = int(um.group(1))
        ext = f"{folder}:{uv}:{uid}"
        p = mailparse.parse(raw)
        ts = _internaldate(meta) or p["ts"]
        rel = mailparse.raw_path(acct, ts, f"{folder}-{uv}-{uid}")
        mailparse.save_raw(rel, raw)
        items.append(dict(p, source="email", account=acct, ext_id=ext, conv=None, conv_name=None, ts=ts,
                          from_me=int(bool(SENT.match(folder)) or p["sender_addr"] == me), folders=folder,
                          path=rel, size=len(raw), junk=int(bool(JUNK.match(folder)))))
    return items


def _sync_folder(db, pool, ex, acct, folder, stats, stop):
    key = f"mail:{acct}:{folder}"
    st = store.get_state(db, key, {})
    c = pool.get(folder)
    pool.local.folder = None  # force a fresh SELECT so EXISTS/UIDVALIDITY are current
    exists, uv = select(c, folder)
    pool.local.folder = folder
    prefix = f"{folder}:{uv}:"
    if st.get("uidvalidity") not in (None, uv):
        old = f"{folder}:{st['uidvalidity']}:"
        with store.writing(db):
            stats["deleted"] += store.mark_deleted(db, "email", acct, store.known_ext_ids(db, "email", acct, old))
        common.log(f"{acct}/{folder}: UIDVALIDITY changed {st['uidvalidity']} -> {uv}, refetching")
        st = {}
    server = search_uids(c, "ALL")
    known = {int(x[len(prefix):]) for x in store.known_ext_ids(db, "email", acct, prefix)}
    with _BAD_LOCK:
        skipped = {u for (a, f, v, u), n in BAD.items() if (a, f, v) == (acct, folder, uv) and n >= BAD_LIMIT}
    missing = sorted(set(server) - known - skipped)
    if missing:
        common.log(f"{acct}/{folder}: {len(server)} on server, {len(missing)} to fetch")
    chunks = [missing[i:i + CHUNK] for i in range(0, len(missing), CHUNK)]
    done = 0
    for i in range(0, len(chunks), 20):
        if stop is not None and stop.is_set():
            return False
        for items in ex.map(lambda ch: _fetch_chunk(pool, acct, folder, uv, ch), chunks[i:i + 20]):
            # One short write per chunk so the lock is never held while waiting on the network.
            with store.writing(db):
                for it in items:
                    stats[store.upsert(db, it)] += 1
            done += len(items)
        if len(missing) > 1000:
            common.log(f"{acct}/{folder}: fetched {done}/{len(missing)}")
    with store.writing(db):
        # Deletions: only trust the listing when it agrees with the server's message count, and
        # never read an empty listing as "everything was deleted".
        if len(server) == exists and (server or not known):
            gone = known - set(server)
            if gone:
                stats["deleted"] += store.mark_deleted(db, "email", acct, {f"{prefix}{u}" for u in gone})
        back = store.deleted_ext_ids(db, "email", acct, prefix) & {f"{prefix}{u}" for u in server}
        if back:
            store.undelete(db, "email", acct, back)
        store.set_state(db, key, {"uidvalidity": uv, "exists": exists, "last_ok": int(time.time())})
    return True


def sync(acct, db, stop=None):
    stats = {"added": 0, "updated": 0, "same": 0, "deleted": 0}
    pool = Pool(acct)
    ex = ThreadPoolExecutor(WORKERS.get(acct, 2))
    try:
        names = folders(pool.get("INBOX"))
        complete = True
        for folder in names:
            if stop is not None and stop.is_set():
                complete = False
                break
            try:
                if not _sync_folder(db, pool, ex, acct, folder, stats, stop):
                    complete = False
                    break
            except (OSError, imaplib.IMAP4.error, RuntimeError) as e:
                # One unreadable folder (or a connection dropped while idle) must not stop the rest.
                common.log(f"{acct}/{folder}: skipped this pass ({type(e).__name__}: {e})")
                pool.drop()
                complete = False
        if complete:
            with store.writing(db):
                store.set_state(db, f"mail:{acct}", {"folders": names, "last_ok": int(time.time())})
    finally:
        ex.shutdown(wait=True)
        pool.close()
    return stats
