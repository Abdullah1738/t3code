"""Mirror Google accounts (gmail, fund, juno) through the Gmail REST API.

The API has no per-day download cap like Gmail IMAP (~2.5 GB/day), so the first backfill runs
at full speed. Afterwards history.list gives exact adds, deletes and label changes.
Tokens come from ortie through ~/.local/libexec/mail/mail_oauth.py; they are never printed.
"""
import base64
import http.client
import json
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import common
import mailparse
import store

sys.path.insert(0, common.MAIL_LIBEXEC)
import mail_oauth  # noqa: E402

HOST = "gmail.googleapis.com"
WORKERS = 12
BATCH = 200


class HttpError(RuntimeError):
    def __init__(self, status, body):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status


class Api:
    def __init__(self, acct):
        self.acct = acct
        self.lock = threading.Lock()
        self.local = threading.local()
        self.token = None
        self.checked = 0.0

    def _token(self):
        with self.lock:
            if self.token is None or time.time() - self.checked > 300:
                mail_oauth.ensure_fresh(self.acct)
                self.token = mail_oauth.get_token(self.acct)
                self.checked = time.time()
            return self.token

    def _renew(self, stale):
        with self.lock:
            if self.token == stale:
                mail_oauth.refresh(self.acct, reason="gmail api 401")
                self.token = mail_oauth.get_token(self.acct)
                self.checked = time.time()

    def _conn(self, reset=False):
        c = getattr(self.local, "conn", None)
        if reset and c is not None:
            c.close()
            c = None
        if c is None:
            c = http.client.HTTPSConnection(HOST, timeout=60)
            self.local.conn = c
        return c

    def get(self, path, params=None):
        q = "?" + urllib.parse.urlencode(params, doseq=True) if params else ""
        url = f"/gmail/v1/users/me/{path}{q}"
        delay = 1.0
        for attempt in range(8):
            tok = self._token()
            try:
                c = self._conn(reset=attempt > 0)
                c.request("GET", url, headers={"Authorization": f"Bearer {tok}", "Accept-Encoding": "identity"})
                r = c.getresponse()
                body = r.read()
            except (OSError, http.client.HTTPException):
                time.sleep(delay)
                delay = min(delay * 2, 30)
                continue
            if r.status == 200:
                return json.loads(body)
            if r.status == 401:
                self._renew(tok)
                continue
            if r.status == 404:
                raise HttpError(404, body.decode("utf-8", "replace"))
            if r.status in (403, 429) or r.status >= 500:
                text = body.decode("utf-8", "replace")
                if r.status == 403 and "rate" not in text.lower() and "quota" not in text.lower():
                    raise HttpError(r.status, text)
                time.sleep(delay)
                delay = min(delay * 2, 60)
                continue
            raise HttpError(r.status, body.decode("utf-8", "replace"))
        raise RuntimeError(f"{self.acct}: gave up on {path}")


def _labels(api):
    out = {}
    for lb in api.get("labels").get("labels", []):
        out[lb["id"]] = lb["name"] if lb.get("type") == "user" else lb["id"]
    return out


def _folders(label_ids, names):
    return ", ".join(names.get(x, x) for x in (label_ids or []))


class Skipped:
    """A message that failed on its own; the next full listing (daily) retries it."""

    def __init__(self, mid, err):
        self.mid, self.err = mid, err


def _fetch(api, acct, mid, names, me):
    try:
        m = api.get(f"messages/{mid}", {"format": "raw"})
        raw = base64.urlsafe_b64decode(m["raw"] + "=" * (-len(m["raw"]) % 4))
    except HttpError as e:
        if e.status == 404:
            return None
        return Skipped(mid, e)
    except (RuntimeError, KeyError, ValueError) as e:
        return Skipped(mid, e)
    p = mailparse.parse(raw)
    ts = int(m.get("internalDate", 0)) // 1000 or p["ts"]
    rel = mailparse.raw_path(acct, ts, mid)
    mailparse.save_raw(rel, raw)
    labels = m.get("labelIds") or []
    return dict(p, source="email", account=acct, ext_id=mid, conv=m.get("threadId"), ts=ts,
                from_me=int("SENT" in labels or p["sender_addr"] == me), folders=_folders(labels, names),
                path=rel, size=len(raw), junk=int("SPAM" in labels), conv_name=None)


def _fetch_many(db, api, acct, ids, names, stats, stop):
    me = common.MAIL_ACCOUNTS[acct]["user"].lower()
    ids = list(ids)
    with ThreadPoolExecutor(WORKERS) as pool:
        for i in range(0, len(ids), BATCH):
            if stop is not None and stop.is_set():
                return False
            chunk = ids[i:i + BATCH]
            got = [x for x in pool.map(lambda mid: _fetch(api, acct, mid, names, me), chunk) if x]
            bad = [x for x in got if isinstance(x, Skipped)]
            items = [x for x in got if not isinstance(x, Skipped)]
            if bad and len(bad) * 2 > len(chunk):
                # Most of the batch failed: an outage, not bad messages. Retry the pass later.
                raise RuntimeError(f"{acct}: {len(bad)}/{len(chunk)} fetches failed, e.g. {bad[0].err}")
            for b in bad:
                common.log(f"{acct}: skipped message {b.mid} this pass ({b.err})")
            with store.writing(db):
                for it in items:
                    stats[store.upsert(db, it)] += 1
            if len(ids) > BATCH:
                common.log(f"{acct}: fetched {min(i + BATCH, len(ids))}/{len(ids)}")
    return True


def _list_all(api):
    ids, token = [], None
    while True:
        params = {"maxResults": 500, "includeSpamTrash": "true", "fields": "messages(id),nextPageToken"}
        if token:
            params["pageToken"] = token
        page = api.get("messages", params)
        ids.extend(m["id"] for m in page.get("messages", []))
        token = page.get("nextPageToken")
        if not token:
            return ids


def _full(db, api, acct, names, stats, stop):
    start = api.get("profile")["historyId"]
    listed = _list_all(api)
    known = store.known_ext_ids(db, "email", acct)
    missing = [m for m in listed if m not in known]
    common.log(f"{acct}: {len(listed)} on server, {len(missing)} to fetch")
    if not _fetch_many(db, api, acct, missing, names, stats, stop):
        return None
    listed = set(listed)
    gone = known - listed
    with store.writing(db):
        if listed or not known:  # an empty listing is never read as "everything was deleted"
            stats["deleted"] += store.mark_deleted(db, "email", acct, gone)
        # A message the listing missed earlier (pagination shifts while mail arrives) comes back here.
        store.undelete(db, "email", acct, store.deleted_ext_ids(db, "email", acct) & listed)
    return start


def _relabel(db, acct, mid, label_ids, names):
    return db.execute("UPDATE items SET folders=?, junk=?, updated_at=? WHERE source='email' AND account=? AND ext_id=?",
                      (_folders(label_ids, names), int("SPAM" in label_ids), int(time.time()), acct, mid)).rowcount


def _incremental(db, api, acct, since, names, stats, stop):
    added, deleted, relabel, token, latest = [], set(), {}, None, since
    while True:
        params = {"startHistoryId": since, "maxResults": 500,
                  "historyTypes": ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]}
        if token:
            params["pageToken"] = token
        page = api.get("history", params)
        latest = page.get("historyId", latest)
        for h in page.get("history", []):
            for a in h.get("messagesAdded", []):
                added.append(a["message"]["id"])
                deleted.discard(a["message"]["id"])
            for d in h.get("messagesDeleted", []):
                deleted.add(d["message"]["id"])
            for key in ("labelsAdded", "labelsRemoved"):
                for x in h.get(key, []):
                    relabel[x["message"]["id"]] = x["message"].get("labelIds", [])
        token = page.get("nextPageToken")
        if not token:
            break
    known = store.known_ext_ids(db, "email", acct)
    new = [m for m in dict.fromkeys(added) if m not in known and m not in deleted]
    if not _fetch_many(db, api, acct, new, names, stats, stop):
        return None
    with store.writing(db):
        store.undelete(db, "email", acct, {m for m in added if m in known and m not in deleted})
        for mid, labels in relabel.items():
            if mid not in deleted and _relabel(db, acct, mid, labels, names):
                stats["updated"] += 1
        stats["deleted"] += store.mark_deleted(db, "email", acct, deleted)
    return latest


def sync(acct, db, stop=None):
    """One pass. Returns a stats dict."""
    api = Api(acct)
    stats = {"added": 0, "updated": 0, "same": 0, "deleted": 0}
    key = f"mail:{acct}"
    st = store.get_state(db, key, {})
    names = _labels(api)
    hist = None
    if st.get("history_id"):
        try:
            hist = _incremental(db, api, acct, st["history_id"], names, stats, stop)
        except HttpError as e:
            if e.status != 404:
                raise
            common.log(f"{acct}: history {st['history_id']} expired, doing a full listing")
    if hist is None and not (stop is not None and stop.is_set()):
        hist = _full(db, api, acct, names, stats, stop)
        st["last_full"] = int(time.time())
    if hist is not None:
        st["history_id"] = hist
        st["last_ok"] = int(time.time())
        with store.writing(db):
            store.set_state(db, key, st)
    return stats
