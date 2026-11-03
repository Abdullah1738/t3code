#!/opt/homebrew/bin/python3
"""Delete OpenCode sessions with no activity for 30 days (launchd: com.abdullah.session-reaper).

Authorized by Abdullah 2026-09-29: memory.db is the searchable record of every
session, so the live opencode.db only keeps the last 30 days. A session is
deleted only after it is proven to be both in memory and in the Dropbox backup:

Backup gate (once per run, run refuses to delete anything if it fails)
  - logs/backup_last.json: last run ok, stage done, no backup.lock held
  - replica DBs on the SSD were last written by that successful run
  - logs/dropbox_mirror_live.json written by that run, ok, no errors
  - Dropbox listing of /Backups/memory-system/live has every local repo file
    that existed at the end of that run (name + size), and the run's restic
    snapshot file matches by Dropbox content_hash

Per session (every node of the tree, because delete cascades to children)
  - no activity (session row or any message) for STALE_DAYS
  - not running, not suspended, no inbox/pending rows, not the last session of
    a scheduled task, not on the session board backlog, not in
    ~/.config/opencode/session-reaper-keep.txt
  - native: live + replica memory ledger stamped with the session's
    time_updated (all messages projected), replica raw_sessions row current,
    and every live message present in the replica opencode_raw.db with the
    same time_updated and sha256 of its exact data
  - migrated (Codex/Hermes copy): no messages added after import, replica
    ledger row present, and replica memory.db has the original session's
    events (skipped when the copy has no messages)

Deletes go through the OpenCode API (DELETE /api/session/{id}), never raw SQL.
MEMORY_BACKEND (see backend.py) picks the route: openchamber proxies through
OpenChamber and reads its scheduled tasks and board; robob talks to the OpenCode
service directly, reads Robob's scheduled tasks and board from its state DB, and
archives the Robob thread bound to each deleted root session.
Throttled per run. Audit trail: logs/session_reaper-YYYYMM.jsonl.
Status: logs/session_reaper_last.json (checked by health_check.py).

  session_reaper.py --dry-run [--limit N]   verify and report, delete nothing
  session_reaper.py                         delete up to the per-run caps
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backend  # noqa: E402

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".local/share/memory-system")
DATA = os.path.join(ROOT, "data")
LOGS = os.path.join(ROOT, "logs")
OC_DB = backend.opencode_db()
MEM_DB = os.path.join(DATA, "memory.db")
REPLICA = "/Volumes/ExternalSSD/memory-system-backup/replica"
LIVE_REPO = "/Volumes/ExternalSSD/memory-system-backup/restic/live"
DROPBOX_LIVE = "/Backups/memory-system/live"
KEEP_FILE = os.path.join(HOME, ".config/opencode/session-reaper-keep.txt")
OC_CONF = os.path.join(HOME, ".config/openchamber")
STATUS = os.path.join(LOGS, "session_reaper_last.json")

STALE_DAYS = 30
MAX_SESSIONS = 400        # sessions (incl. children) deleted per run
MAX_MESSAGES = 150000     # messages deleted per run
PAUSE = 0.3               # seconds between deletes
SLOW_DELETE = 15          # stop the run if one delete takes longer (live sessions share the DB lock)
IMPORT_SLACK_MS = 60000


class Gate(Exception):
    pass


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def ro(path):
    c = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=60)
    c.execute("PRAGMA busy_timeout=60000")
    return c


def http(method, path, timeout=120):
    req = backend.opencode_request(method, path)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]


def running_ids():
    try:
        code, body = http("GET", "/api/session/active", timeout=30)
    except (TimeoutError, OSError) as e:
        raise Gate(f"{backend.label()} slow/unreachable reading running sessions ({e!r}); stopping")
    if code != 200 or not isinstance(body, dict) or "data" not in body:
        raise Gate(f"cannot read running sessions from {backend.label()} ({code})")
    return set(body["data"])


# ------------------------------------------------------------------ backup gate
def backup_gate(check_dropbox=True):
    st = json.load(open(os.path.join(LOGS, "backup_last.json")))
    if not (st.get("ok") and st.get("stage") == "done" and st.get("last_success_ts") == st.get("ts")):
        raise Gate(f"last memory backup not successful: {st.get('stage')} {st.get('message', '')[:120]}")
    if os.path.isdir(os.path.join(LOGS, "backup.lock")):
        raise Gate("memory backup is running")
    end, start = st["ts"], st["ts"] - st.get("duration_s", 0)
    for db in ("memory.db", "opencode_raw.db"):
        p = os.path.join(REPLICA, db)
        if not os.path.isfile(p):
            raise Gate(f"replica {p} missing (SSD mounted?)")
        for f in (p, p + "-wal"):
            if os.path.exists(f) and os.path.getmtime(f) > end + 5:
                raise Gate(f"replica {os.path.basename(f)} changed after the last successful backup")
    mp = os.path.join(LOGS, "dropbox_mirror_live.json")
    mj = json.load(open(mp))
    if not mj.get("ok") or mj.get("errors") or os.path.getmtime(mp) < start:
        raise Gate("Dropbox mirror of the last backup run not verified")
    snap = st.get("snapshot") or ""
    snaps = [n for n in os.listdir(os.path.join(LIVE_REPO, "snapshots")) if snap and n.startswith(snap)]
    if len(snaps) != 1:
        raise Gate(f"restic snapshot {snap} not found in {LIVE_REPO}")
    ev = {"backup_ts": end, "snapshot": snaps[0]}
    if check_dropbox:
        sys.path.insert(0, os.path.join(ROOT, "src"))
        import dropbox_mirror as dm
        rem = dm.Api().list_files(DROPBOX_LIVE)
        loc = dm.local_files(LIVE_REPO)
        missing = [k for k, v in loc.items()
                   if os.path.getmtime(v["abs"]) <= end and (k not in rem or rem[k]["size"] != v["size"])]
        if missing:
            raise Gate(f"{len(missing)} backup repo files missing in Dropbox, e.g. {missing[0]}")
        key = "snapshots/" + snaps[0]
        if key not in rem or rem[key]["hash"] != dm.dbx_hash(os.path.join(LIVE_REPO, key)):
            raise Gate(f"snapshot {snaps[0][:8]} not verified in Dropbox")
        ev["dropbox_files"] = len(rem)
    return ev


# ------------------------------------------------------------------ protection
def keep_file_ids():
    try:
        with open(KEEP_FILE) as fh:
            return {l.split()[0] for l in fh if l.strip() and not l.startswith("#")}
    except FileNotFoundError:
        return set()


def protected_ids():
    return keep_file_ids() | scheduled_ids() | backlog_ids() | rollback_ids()


def scheduled_ids():
    # The old OpenChamber tasks' last sessions stay protected after the cutover
    # for as long as their config is around.
    if backend.is_robob():
        return robob_scheduled_ids() | openchamber_scheduled_ids()
    return openchamber_scheduled_ids()


def openchamber_scheduled_ids():
    keep = set()
    pdir = os.path.join(OC_CONF, "projects")
    for n in os.listdir(pdir) if os.path.isdir(pdir) else []:
        try:
            for t in json.load(open(os.path.join(pdir, n))).get("scheduledTasks") or []:
                sid = (t.get("state") or {}).get("lastSessionId")
                if sid:
                    keep.add(sid)
        except Exception:
            continue
    return keep


def robob_scheduled_ids():
    # Fail closed: without Robob's task list a task's last session could be deleted.
    try:
        con = backend.robob_ro()
        try:
            return backend.scheduled_task_session_ids(con)
        finally:
            con.close()
    except Exception as e:
        raise Gate(f"cannot read Robob scheduled tasks ({e!r})")


def backlog_ids():
    return robob_backlog_ids() if backend.is_robob() else openchamber_backlog_ids()


def openchamber_backlog_ids():
    # Sessions on the OpenChamber board Backlog lane are never deleted. Fail closed:
    # if the board can't be read, no run.
    p = os.path.join(OC_CONF, "session-board.json")
    try:
        board = json.load(open(p))
        return {r["sessionId"] for r in board["records"] if r.get("backlog")}
    except FileNotFoundError:
        return set()
    except Exception as e:
        raise Gate(f"cannot read session board backlog ({e!r})")


def robob_backlog_ids():
    # Protects OpenCode sessions behind unsettled kanban cards (active, work and
    # review threads) and open kanban thread links. The retired ardud_board_rows
    # Backlog is no longer read. Fail closed: a state DB that can't be read stops the run.
    try:
        con = backend.robob_ro()
        try:
            ids = backend.kanban_session_ids(con)
        finally:
            con.close()
    except Exception as e:
        raise Gate(f"cannot read Robob kanban references ({e!r})")
    return ids


def rollback_ids():
    # OpenCode sessions behind threads that moved to another driver within 90 days.
    # They are the migration's rollback source and stay until that window passes.
    if not backend.is_robob():
        return set()
    try:
        con = backend.robob_ro()
        try:
            return backend.migrated_rollback_session_ids(con)
        finally:
            con.close()
    except Exception as e:
        raise Gate(f"cannot read migrated thread rollback pins ({e!r})")


def control_gate():
    # Deleted root sessions get their Robob thread archived, so the control API
    # has to answer before anything is deleted.
    try:
        code, body = backend.control("GET", "/health", timeout=30)
    except Exception as e:
        raise Gate(f"Robob control API unreachable ({e!r})")
    if code != 200:
        raise Gate(f"Robob control API not healthy (HTTP {code} {backend._err(body)})")


def archive_robob_thread(ses_id, quiet_before):
    """Archive the Robob thread bound to a deleted root session. Returns
    (thread id, archived, reason), (None, False, None) when no thread is bound,
    or raises. reason says why a kept thread was kept.

    by-native also resolves sessions a thread used before a context reset,
    rebind or provider switch, so a stale old session can map to a thread that
    is still in use. Only archive when the deleted session is the one the
    thread runs on now (backend.current_native_session), and the thread has
    been quiet since quiet_before (the stale cutoff). The control API's
    archive-if-idle then refuses a busy thread (running, queued, background
    work, pending request or wake) under the thread's dispatch lock, so the
    server, not this check, decides whether the archive happens."""
    thread = backend.thread_for_session(ses_id)
    if not thread:
        return None, False, None
    tid = thread["threadId"]
    if backend.current_native_session(tid, quiet_before) != ses_id:
        return tid, False, "thread moved on"
    if thread.get("archived"):
        return tid, True, None
    res = backend.archive_if_idle(tid, expected_session=ses_id)
    return tid, res["archived"], res["reason"]


# A deleted root session is gone for good, so a failed thread archive is kept in
# a pending file and retried at the start of later runs. Only a persistent
# failure (PENDING_ARCHIVE_TRIES failed retries) alerts.
PENDING_ARCHIVE_TRIES = 5


def pending_path():
    return os.path.join(LOGS, "state", "reaper_pending_archive.json")


def load_pending():
    try:
        with open(pending_path()) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def save_pending(pending):
    p = pending_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(pending, fh, indent=1)
    os.replace(tmp, p)


def queue_archive_retry(ses_id, err):
    pending = load_pending()
    e = pending.get(ses_id)
    if e is None:
        e = pending[ses_id] = {"attempts": 0, "first_ts": int(time.time())}
    else:
        e["attempts"] = e.get("attempts", 0) + 1
    e["last_error"] = str(err)[:200]
    save_pending(pending)


def retry_pending_archives(quiet_before, st):
    pending = load_pending()
    if not pending:
        return
    for ses_id in list(pending):
        e = pending[ses_id]
        try:
            thread_id, archived, reason = archive_robob_thread(ses_id, quiet_before)
        except Exception as err:
            e["attempts"] = e.get("attempts", 0) + 1
            e["last_error"] = str(err)[:200]
            if e["attempts"] >= PENDING_ARCHIVE_TRIES:
                del pending[ses_id]
                st["errors"].append(f"{ses_id}: archiving its Robob thread failed "
                                    f"{PENDING_ARCHIVE_TRIES} times: {str(err)[:120]}")
            continue
        del pending[ses_id]
        st["archive_retried"] = st.get("archive_retried", 0) + 1
        st.setdefault("archive_retry_audit", []).append(
            {"id": ses_id, "thread": thread_id, "archived": archived, "reason": reason})
        if thread_id and not archived:
            st["kept_threads"] = st.get("kept_threads", 0) + 1
    save_pending(pending)


# ------------------------------------------------------------------ candidates
SESS_SQL = """
SELECT s.id, s.parent_id, s.title, s.directory, s.time_updated, s.time_suspended,
       json_extract(s.metadata, '$.migration.sourceSessionID'),
       json_extract(s.metadata, '$.migration.importedAt'),
       (SELECT max(time_created) FROM session_message m WHERE m.session_id = s.id),
       (SELECT count(*) FROM session_message m WHERE m.session_id = s.id)
FROM session_v2 s
"""


def load_sessions(oc):
    out = {}
    for r in oc.execute(SESS_SQL):
        sid, parent, title, d, tu, susp, src, imp, last_msg, n = r
        out[sid] = dict(id=sid, parent=parent, title=title, dir=d, tu=tu, suspended=susp,
                        src=src, imported=imp, last=max(tu or 0, last_msg or 0), n=n,
                        migrated=src is not None or imp is not None)
    busy = {r[0] for r in oc.execute("SELECT session_id FROM session_inbox UNION SELECT session_id FROM session_pending")}
    oc.commit()
    return out, busy


def plan(sessions, busy, running, keep, now_ms):
    cutoff = now_ms - STALE_DAYS * 86400000
    kids = {}
    for s in sessions.values():
        if s["parent"]:
            kids.setdefault(s["parent"], []).append(s["id"])
    reason = {}
    for s in sessions.values():
        sid = s["id"]
        if sid in running:
            reason[sid] = "running"
        elif s["last"] >= cutoff:
            reason[sid] = "recent"
        elif s["suspended"]:
            reason[sid] = "suspended"
        elif sid in busy:
            reason[sid] = "inbox_or_pending"
        elif sid in keep:
            reason[sid] = "protected"
    memo = {}

    def ok(sid, depth=0):
        if sid not in memo:
            memo[sid] = sid not in reason and depth < 50 and all(ok(k, depth + 1) for k in kids.get(sid, []))
        return memo[sid]

    def tree(sid):
        out = [sid]
        for k in kids.get(sid, []):
            out += tree(k)
        return out

    roots = [s for s in sessions.values()
             if ok(s["id"]) and not (s["parent"] in sessions and ok(s["parent"]))]
    roots.sort(key=lambda s: s["last"])
    blocked = sum(1 for s in sessions.values() if s["id"] not in reason and not ok(s["id"]))
    return [(r, tree(r["id"])) for r in roots], reason, blocked


# ------------------------------------------------------------------ verification
class Verifier:
    def __init__(self, oc):
        self.oc = oc
        self.mem = ro(MEM_DB)
        self.rmem = ro(os.path.join(REPLICA, "memory.db"))
        self.rraw = ro(os.path.join(REPLICA, "opencode_raw.db"))

    def ledger(self, db, sid):
        r = db.execute("SELECT native, time_updated FROM opencode_sync_sessions WHERE session_id=?", (sid,)).fetchone()
        db.commit()
        return r

    def check(self, s):
        sid = s["id"]
        if s["migrated"]:
            if s["n"] and s["imported"]:
                post = self.oc.execute(
                    "SELECT count(*) FROM session_message WHERE session_id=? AND time_created>?",
                    (sid, s["imported"] - IMPORT_SLACK_MS)).fetchone()[0]
                self.oc.commit()
                if post:
                    return f"migrated_continued:{post} messages after import are not in memory"
            if not self.ledger(self.rmem, sid):
                return "replica_ledger_missing"
            if s["n"]:
                if not s["src"]:
                    return "migrated_without_source_id"
                hit = self.rmem.execute("SELECT 1 FROM episodic_events WHERE session_id=? LIMIT 1", (s["src"],)).fetchone()
                self.rmem.commit()
                if not hit:
                    return "memory_missing_original"
            return None
        for name, db in (("live", self.mem), ("replica", self.rmem)):
            led = self.ledger(db, sid)
            if not led or led[0] != 1 or led[1] != s["tu"]:
                return f"{name}_ledger_not_current"
        rs = self.rraw.execute("SELECT time_updated FROM raw_sessions WHERE id=?", (sid,)).fetchone()
        if not rs or rs[0] != s["tu"]:
            return "replica_raw_session_not_current"
        have = {i: (tu, sha) for i, tu, sha in self.rraw.execute(
            "SELECT id, time_updated, sha256 FROM raw_messages WHERE session_id=?", (sid,))}
        self.rraw.commit()
        last, seen = -1, 0
        while True:
            rows = self.oc.execute(
                "SELECT id, seq, time_updated, data FROM session_message WHERE session_id=? AND seq>? ORDER BY seq LIMIT 300",
                (sid, last)).fetchall()
            self.oc.commit()
            if not rows:
                break
            for mid, seq, tu, data in rows:
                h = have.get(mid)
                if not h or h[0] != tu or h[1] != hashlib.sha256(data.encode("utf-8")).hexdigest():
                    return f"replica_message_mismatch:{mid}"
                seen += 1
            last = rows[-1][1]
        if seen != s["n"]:
            return "message_count_changed"
        return None


# ------------------------------------------------------------------ main
def write_status(st):
    tmp = STATUS + ".tmp"
    json.dump(st, open(tmp, "w"), indent=1)
    os.replace(tmp, STATUS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=MAX_SESSIONS, help="max sessions to delete/verify this run")
    ap.add_argument("--max-messages", type=int, default=MAX_MESSAGES)
    ap.add_argument("--no-dropbox-check", action="store_true", help="dry-run only: skip the Dropbox listing")
    args = ap.parse_args()
    if args.no_dropbox_check and not args.dry_run:
        ap.error("--no-dropbox-check is only allowed with --dry-run")

    t0 = time.time()
    st = {"ts": int(t0), "dry_run": args.dry_run, "state": "running", "deleted_roots": 0,
          "deleted_sessions": 0, "deleted_messages": 0, "skipped": {}, "errors": []}
    audit = open(os.path.join(LOGS, time.strftime("session_reaper-%Y%m.jsonl")), "a")
    try:
        ev = backup_gate(check_dropbox=not args.no_dropbox_check)
        st["evidence"] = ev
        oc = ro(OC_DB)
        running = running_ids()
        if backend.is_robob():
            st["backend"] = "robob"
            control_gate()
        sessions, busy = load_sessions(oc)
        work, reason, blocked = plan(sessions, busy, running, protected_ids(), int(t0 * 1000))
        st["sessions_total"] = len(sessions)
        st["stale_trees"] = len(work)
        st["stale_sessions"] = sum(len(t) for _, t in work)
        st["blocked_by_live_relatives"] = blocked
        st["kept"] = {k: sum(1 for v in reason.values() if v == k) for k in set(reason.values())}
        log(f"gate ok (snapshot {ev['snapshot'][:8]}); {len(sessions)} sessions, "
            f"{st['stale_trees']} stale trees ({st['stale_sessions']} sessions)")
        quiet_before = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t0 - STALE_DAYS * 86400))
        if backend.is_robob() and not args.dry_run:
            retry_pending_archives(quiet_before, st)
        ver = Verifier(oc)
        n_sess = n_msgs = 0
        for root, tree in work:
            nodes = [sessions[i] for i in tree]
            msgs = sum(s["n"] or 0 for s in nodes)
            if n_sess + len(nodes) > args.limit or (n_sess and n_msgs + msgs > args.max_messages):
                st["remaining_trees"] = st.get("remaining_trees", 0) + 1
                continue
            bad = None
            for s in nodes:
                bad = ver.check(s)
                if bad:
                    break
            if bad:
                key = bad.split(":")[0]
                st["skipped"][key] = st["skipped"].get(key, 0) + 1
                if len(st.setdefault("skipped_examples", [])) < 20:
                    st["skipped_examples"].append({"id": root["id"], "reason": bad, "title": (root["title"] or "")[:80]})
                continue
            rec = {"ts": int(time.time()), "id": root["id"], "title": root["title"], "dir": root["dir"],
                   "last_activity_ms": max(s["last"] for s in nodes), "sessions": tree, "messages": msgs,
                   "migrated_from": root["src"], "snapshot": ev["snapshot"][:8]}
            n_sess += len(nodes)
            n_msgs += msgs
            if args.dry_run:
                st["deleted_roots"] += 1
                continue
            # re-check right before deleting: backup evidence still current,
            # nothing changed, nothing started
            if os.path.isdir(os.path.join(LOGS, "backup.lock")) or \
                    os.path.getmtime(os.path.join(REPLICA, "memory.db")) > ev["backup_ts"] + 5:
                st["stopped"] = "memory backup started; replica evidence no longer final"
                break
            live_now = running_ids() | backlog_ids()
            if any(s["id"] in live_now for s in nodes):
                st["skipped"]["protected_before_delete"] = st["skipped"].get("protected_before_delete", 0) + 1
                continue
            changed = False
            for s in nodes:
                r = oc.execute("SELECT time_updated, (SELECT count(*) FROM session_message WHERE session_id=?) FROM session_v2 WHERE id=?",
                               (s["id"], s["id"])).fetchone()
                if not r or r[0] != s["tu"] or r[1] != s["n"]:
                    changed = True
                    break
            kids_now = oc.execute("SELECT count(*) FROM session_v2 WHERE parent_id IN (%s)" % ",".join("?" * len(tree)), tree).fetchone()[0]
            oc.commit()
            if changed or kids_now != len(tree) - 1:
                st["skipped"]["changed_before_delete"] = st["skipped"].get("changed_before_delete", 0) + 1
                continue
            # A migration can pin any node after planning, without changing the
            # OpenCode tree. Read Robob again immediately before the DELETE.
            rollback_now = rollback_ids()
            if any(s["id"] in rollback_now for s in nodes):
                st["skipped"]["protected_before_delete"] = st["skipped"].get("protected_before_delete", 0) + 1
                continue
            try:
                t1 = time.time()
                code, body = http("DELETE", "/api/session/" + urllib.parse.quote(root["id"]))
            except (TimeoutError, OSError) as e:
                code, body = None, repr(e)
                st["stopped"] = f"delete request failed/timed out ({e!r}); stopping to protect live sessions"
                time.sleep(10)
            dt = time.time() - t1
            gone = oc.execute("SELECT count(*) FROM session_v2 WHERE id IN (%s)" % ",".join("?" * len(tree)), tree).fetchone()[0] == 0
            oc.commit()
            if code is None and gone:
                rec["note"] = "delete request timed out but rows are gone"
            elif code not in (200, 204, 404) or not gone:
                if code is not None:
                    st["errors"].append(f"{root['id']}: HTTP {code} {str(body)[:120]} gone={gone}")
                if st.get("stopped") or len(st["errors"]) >= 5:
                    if not st.get("stopped"):
                        raise Gate("too many delete errors")
                    break
                continue
            rec["delete_secs"] = round(dt, 2)
            if backend.is_robob():
                try:
                    thread_id, archived, reason = archive_robob_thread(root["id"], quiet_before)
                    rec["robob_thread"] = thread_id
                    if thread_id and not archived:
                        rec["robob_thread_kept"] = reason
                        st["kept_threads"] = st.get("kept_threads", 0) + 1
                except Exception as e:
                    rec["robob_thread_error"] = str(e)[:200]
                    queue_archive_retry(root["id"], str(e))
                    st["archive_retry_queued"] = st.get("archive_retry_queued", 0) + 1
            audit.write(json.dumps(rec, ensure_ascii=False) + "\n")
            audit.flush()
            st["deleted_roots"] += 1
            st["deleted_sessions"] += len(tree)
            st["deleted_messages"] += msgs
            if dt > SLOW_DELETE:
                st["stopped"] = f"delete took {dt:.0f}s; stopping to protect live sessions"
                break
            time.sleep(PAUSE)
        st["remaining_trees"] = st["stale_trees"] - st["deleted_roots"] - sum(st["skipped"].values())
        if args.dry_run:
            st["would_delete_roots"] = st.pop("deleted_roots")
            st["would_delete_sessions"] = n_sess
            st["would_delete_messages"] = n_msgs
            st["deleted_roots"] = 0
        st["state"] = "error" if st["errors"] else "done"
    except Gate as e:
        # A Gate after an error was recorded (e.g. an exhausted archive retry)
        # must not hide it: health_check treats "gated" as healthy.
        st["state"] = "error" if st["errors"] else "gated"
        st["message"] = str(e)
    except Exception as e:
        st["state"] = "error"
        st["message"] = f"{type(e).__name__}: {e}"
    st["duration_s"] = int(time.time() - t0)
    if not args.dry_run:
        try:
            prev = json.load(open(STATUS))
        except Exception:
            prev = {}
        st["last_ok_ts"] = st["ts"] if st["state"] == "done" else prev.get("last_ok_ts")
        write_status(st)
    print(json.dumps(st, indent=1), flush=True)
    return 0 if st["state"] in ("done", "gated") else 1


if __name__ == "__main__":
    sys.exit(main())
