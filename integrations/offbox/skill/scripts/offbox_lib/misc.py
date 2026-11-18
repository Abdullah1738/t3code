"""Small commands: local exemptions, list, release, ssh, ports, status, logs, wait."""

from __future__ import annotations

import codecs
import contextlib
import json
import hashlib
import os
import shutil
import sqlite3
import re
import signal
import shlex
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from time import monotonic, sleep

import toollog

from . import api, capacity, lease, outage, pool, ssh_sync
from .common import (BOX_WEDGED_NOTE, CAP_PATH, DEAD_MOUNT_NOTE, EXEMPTIONS, EXIT_BUSY, EXIT_INFRA, EXIT_NOT_STARTED, EXIT_WAIT_TIMEOUT, LOGS_DIR, RUN_TTL_S, TOO_BIG_NOTE,
                     OffboxError, ago, atomic_write_json, checkpoint, db, event, file_lock, iso, is_silenced, kv_get, log, now,
                     delivered_bytes, offsets_path, out, read_json, record_delivery, require_mine, say, silence, size_summary)
from .common import mine as token_mine  # release() has its own `mine` flag
from .identity import require_proven

WAIT_POLL_S = 5
KILL_CONFIRM_S = 40
KILL_REQUEST_S = 125  # Two 60-second DELETE attempts plus retry overhead, bounded by api.budget.
# A lock-blocked waiter asks boat about the process this often, and once boat has said it ended for HOLDER_GRACE_S
# while the holder still hasn't recorded the end, the waiter stops waiting for that holder (it looks stuck).
STATUS_POLL_S = 30
HOLDER_GRACE_S = 60
# A holder with --pull paths copies them back after the process ends (up to 30 min a path), so it gets longer.
PULL_GRACE_S = 1860


def parse_ttl(s: str) -> int:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smhd]?)", s.strip())
    if not m:
        raise OffboxError(f"bad duration {s} (use 30m, 2h, 1d)", code=2)
    return int(float(m.group(1)) * {"": 60, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])


def local_exempt(me: dict, reason: str | None, ttl: str, do_list: bool, do_clear: bool) -> None:
    # Listing is read-only. Adding or clearing an exemption writes a grant for a session id that the proof is about.
    if not do_list:
        require_proven(me, "local exemption")
    with file_lock("exemptions", timeout=30):
        cur = [e for e in read_json(EXEMPTIONS, []) if (e.get("expires_at") or 0) > now()]
        if do_list:
            print(json.dumps(cur, indent=1))
            return
        ses = me.get("session")
        if do_clear:
            thread = me.get("thread")
            if me.get("driver") == "claudeAgent":
                # A Claude parent and its in-process children share one session id, so the session names none of
                # them. Clear only the caller's own thread's entries, never a parent's or a sibling's.
                def mine(e):
                    return bool(thread) and e.get("thread_id") == thread
            else:
                def mine(e):
                    return e.get("session_id") == ses or bool(thread and e.get("thread_id") == thread)
            keep = [e for e in cur if not mine(e)]
            atomic_write_json(EXEMPTIONS, keep)
            event(db(), None, "exemption_clear", f"session={ses} thread={thread} removed={len(cur) - len(keep)}")
            print(f"cleared {len(cur) - len(keep)} exemption(s)")
            return
        if not reason or len(reason.strip()) < 8:
            raise OffboxError('give a real reason: offbox local --reason "why this must run on the Mac" [--ttl 2h]', code=2)
        if not ses and not me.get("thread"):
            say("note: no OPENCODE_SESSION_ID; the exemption is recorded but the gate can't match it to a session")
        secs = parse_ttl(ttl)
        # The driver goes with the session id: the monitor matches a native UUID only under the driver it was written
        # for, and an entry without one is read as OpenCode. The execution kind tells the monitor that a Claude
        # in-process child's entry covers that child's thread only, not the session it shares with its parent.
        e = {"session_id": ses, "driver": me.get("driver") or "opencode", "thread_id": me.get("thread"),
             "execution_kind": me.get("executionKind"),
             "reason": reason.strip()[:500], "created_at": now(), "expires_at": now() + secs,
             "repo_root": me.get("repo_root"), "pid": os.getppid()}
        cur.append(e)
        atomic_write_json(EXEMPTIONS, cur)
    import toollog
    toollog.emit("gate", "local.override", ids={"thread": me.get("thread")},
                 props={"ttlSeconds": secs, "reasonLength": len(reason.strip())})
    event(db(), None, "exemption_add", f"session={ses} thread={me.get('thread')} ttl={secs}s reason={reason[:200]}")
    print(f"exempt until {iso(e['expires_at'])} (session {ses}). Heavy work still competes with Abdullah's Mac: "
          f"prefer offbox run when you can.")


def list_leases(me: dict, show_all: bool, as_json: bool) -> None:
    con = db()
    capacity.schema(con, import_legacy=False)
    if show_all:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') ORDER BY last_used_at DESC").fetchall()
    else:
        # The caller's own leases are selected by owner. An unproven caller's owner string is shared, so it sees none.
        require_proven(me, "list")
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') AND (owner=? OR box_id IN "
                           "(SELECT box_id FROM pool_callers WHERE owner=?)) ORDER BY last_used_at DESC",
                           (me['owner'], me['owner'])).fetchall()
    out = []
    from . import box_disk
    for r in rows:
        d = dict(r)
        d["active_runs"] = lease.active_runs(con, r["box_id"])
        from . import unfit
        d['suspect'] = unfit.get(con, d['box_id'])
        d['disk_full'] = (d.get('note') or '').startswith(box_disk.NOTE)
        d['disk_space'] = (kv_get(con, 'disk_full:' + d['box_id']) or {}).get('space', {})
        out.append(d)
    if as_json:
        print(json.dumps(out, indent=1))
        return
    if not out:
        print("no leases" + ("" if show_all else " for this thread (use --all)"))
    for d in out:
        suspect = d.get("suspect")
        if suspect:
            print(f"{d['box_id']}: suspect: {suspect['reason']} ({suspect['source']}, expires {iso(suspect['expires_at'])})")
        pin = " pinned" if (d.get("pinned_until") or 0) > now() else ""
        note = f"  [{d['note']}]" if d['state'] == 'resume_stalled' or (d.get("note") or "").startswith((TOO_BIG_NOTE, DEAD_MOUNT_NOTE, BOX_WEDGED_NOTE, 'disk-full:', pool.RECYCLED_NOTE)) else ""
        print(f"{d['box_id']:<12} {('disk_full' if d['disk_full'] else d['state']):<8} {d['size'] or '':<8} {d['repo_key']:<24} used {ago(d['last_used_at']):>6} "
              f"ago runs:{d['active_runs']}{pin}{note}  {d['source'] or ''}  {(d['thread_title'] or d['owner'])[:40]}")


def release(me: dict, box_id: str | None, mine: bool, delete: bool, *, override=False) -> None:
    # An explicit box id still ends another caller's lease, so it is refused for an unproven caller too.
    require_proven(me, "release")
    con = db()
    capacity.schema(con)
    if box_id:
        # Another owner's box on the home server answers 404 to this token: a stop or delete would read that as
        # "gone" and retire a lease whose box is alive. Refused before anything (ssh included) reaches the box.
        require_mine(con, box_id)
        rows = con.execute("SELECT * FROM leases WHERE box_id=? AND state IN ('running','stopped','resume_stalled')", (box_id,)).fetchall()
    elif mine:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') AND (owner=? OR box_id IN "
                           f"(SELECT box_id FROM pool_callers WHERE owner=?)) AND {token_mine()}",
                           (me['owner'],me['owner'])).fetchall()
    else:
        row = lease.find_lease(con, me['owner'], me['repo_root'])
        if row is None:
            row = con.execute("SELECT l.* FROM leases l JOIN prune_holds h USING(box_id) "
                              f"WHERE l.state IN ('running','stopped') AND {token_mine('l')} AND ((l.owner=? AND l.repo_root=?) OR "
                              "EXISTS (SELECT 1 FROM pool_callers c WHERE c.box_id=l.box_id AND c.owner=? "
                              "AND c.repo_root=?)) ORDER BY l.last_used_at DESC LIMIT 1",
                              (me['owner'], me['repo_root'], me['owner'], me['repo_root'])).fetchone()
        rows = [row] if row else []
    if not rows:
        say("nothing to release")
        return
    for r in rows:
        lease.release_hold_if_worker_gone(con, r["box_id"])
        if not override and _report_prune_hold(con, r["box_id"]):
            continue
        # A foreground run holds box-<id> while it streams, so a hung run shows up as a lock timeout. Name the active
        # runs on that path too; the recheck under the lock still decides before any mutation.
        try:
            with contextlib.nullcontext() if override else file_lock('box-'+r['box_id'], timeout=1):
                _release_one(con, r, delete, me, override=override)
        except OffboxError as e:
            if "timed out waiting for lock" not in str(e):
                raise
            lease.release_hold_if_worker_gone(con, r["box_id"])
            if _report_prune_hold(con, r["box_id"]):
                continue
            if not _report_active_runs(con, r["box_id"], lock_held=True):
                say(f"{r['box_id']}: box is busy (another offbox process holds it); not released. Try again shortly.")


def _report_prune_hold(con, box_id: str) -> bool:
    hold = con.execute("SELECT run_id, created_at FROM prune_holds WHERE box_id=?", (box_id,)).fetchone()
    if hold is None:
        return False
    since = time.strftime('%H:%M', time.localtime(hold['created_at']))
    say(f"{box_id}: held by an unconfirmed checkout cleanup (prune {hold['run_id']}, since {since}); reap retries it")
    return True


def _report_active_runs(con, box_id: str, lock_held: bool = False) -> bool:
    """Name the starting/running runs on a box and suggest kill. Returns False when there are none."""
    ids = [f"{x[0]} (holder {x[1] or 'unknown holder'})" for x in con.execute(
                                     "SELECT run_id,owner FROM runs WHERE box_id=? AND (" + lease.reserved_run_sql() + ") "
                                     "ORDER BY start_at", (box_id,))]
    if not ids:
        return False
    where = " (the box lock is held by a live client)" if lock_held else ""
    say(f"{box_id}: run in progress, not released{where}: {', '.join(ids)}. If it is hung, stop it with "
        "`offbox kill <run>` and release again, or explicitly use --override-protection.")
    return True


def _release_one(con, r, delete, me=None, *, override=False):
        if not override and _report_prune_hold(con, r["box_id"]):
            return
        if not override and lease.active_runs(con, r["box_id"]):
            _report_active_runs(con, r["box_id"])
            return
        if delete or r['state'] in ('running', 'resume_stalled'):
            lease.check_protection(con, r['box_id'], override=override)
        if delete:
            lease.delete_box(con, r["box_id"], "release --delete", **({'override': True} if override else {}))
            print(f"deleted {r['box_id']}")
        else:
            if r["state"] in ("running", "resume_stalled"):
                lease.stop_box(con, r["box_id"], "release", **({'override': True} if override else {}))
            if r['state'] == 'resume_stalled':
                print(f"stop requested for {r['box_id']} (disk kept; remains set aside)")
                return
            pin = lease.foreign_pin(con, r['box_id'], me)
            if pin:
                print(f"stopped {r['box_id']} (disk kept; pinned by {pin[0]} until {iso(pin[1])}; other runs won't pick it)")
                return
            if (r['note'] or '').startswith(pool.RECYCLED_NOTE):
                print(f"stopped {r['box_id']} (disk kept; detached from the repository pool)")
                return
            print(f"stopped {r['box_id']} (free; disk kept; next offbox run resumes it)")


CANCEL_WAIT_S = 15
CANCEL_POLL_S = 0.5


def _cancel_before_start(r):
    rid, client, start_at = r["run_id"], r["client_pid"], r["start_at"]
    if not client:
        raise OffboxError(f"run {rid}: no client pid is recorded, so kill cannot tell which process to stop. "
                          "Stop it with Ctrl-C or its tool, or run `offbox reap` once it is gone", code=2)
    if client <= 1 or client == os.getpid():
        raise OffboxError(f"run {rid}: refusing to signal invalid client pid {client}", code=2)
    alive = _client_alive(client, start_at)
    if alive:
        began = _pid_started_at(client)
        if began is None or start_at is None:
            raise OffboxError(f"run {rid}: cannot prove client pid {client}'s start time; nothing was stopped. "
                              "Stop it with Ctrl-C or its tool, or run `offbox reap` once it is gone", code=2)
        alive = began <= start_at + 2
    deadline = time.monotonic() + CANCEL_WAIT_S
    sent = False
    while True:
        r = _run_row(rid)
        if r['status'] == 'forwarded':
            return r, _follow_forwarded(r, 'kill')
        if (r['client_pid'], r['start_at']) != (client, start_at):
            return _cancel_before_start(r)
        if r["status"] not in ("starting", "running"):
            if r["status"] == "killed":
                where = f"box {r['box_id']} returned to the pool" if r["box_id"] else "queued, no box used"
                print(f"cancelled run {rid} before its command started (client pid {client} stopped; {where})")
            else:
                print(f"run {rid} settled as {r['status']}; nothing else was stopped")
            return r, 0
        if r["process_id"]:
            return r, None
        if alive and not sent:
            # Only the proven client may unwind its preparation and release the pool guard.
            try:
                os.kill(client, signal.SIGTERM)
                sent = True
            except ProcessLookupError:
                alive = False
            except PermissionError as e:
                raise OffboxError(f"run {rid}: cannot signal client pid {client}: {e}", code=2) from e
        if not alive or time.monotonic() >= deadline:
            if alive and _client_alive(client, start_at):
                cur = _run_row(rid)
                if cur["status"] not in ("starting", "running") or cur["process_id"]:
                    continue
                say(f"run {rid}: sent SIGTERM to client {client}; it has not settled the row yet, "
                    "check `offbox list`")
                return r, 1
            con = db()
            start_keys = tuple(f"{kind}:{rid}" for kind in
                               ("start_unknown", "start_unattached", "containers_expected"))
            pending = con.execute("SELECT 1 FROM kv WHERE k IN (?,?,?)", start_keys).fetchone()
            if r["box_id"] and (r["error"] or r["command_id"] or pending):
                say(f"run {rid}: remote start unconfirmed on {r['box_id']}; row left as {r['status']}, "
                    "box remains reserved. `offbox reap` fences or reconciles the start")
                return r, 1
            error = "client ended before its command started" if r["box_id"] else "client ended before it got a box"
            # A pending cmd_start has no process_id either. Preserve its evidence for the reaper's start fence,
            # including evidence the client records between our read and this write.
            changed = con.execute("UPDATE runs SET status='lost', end_at=?, error=? WHERE run_id=? "
                                  "AND process_id IS NULL AND status IN ('starting','running') "
                                  "AND client_pid IS ? AND start_at IS ? "
                                  "AND (box_id IS NULL OR (COALESCE(error,'')='' AND command_id IS NULL "
                                  "AND NOT EXISTS (SELECT 1 FROM kv WHERE k IN (?,?,?))))"
                                  + (" AND box_id IS NULL" if not r["box_id"] else ""),
                                  (now(), error, rid, client, start_at, *start_keys)).rowcount
            con.commit()
            if not changed:
                alive = False
                continue
            where = f"; box {r['box_id']} returns to the pool via the reaper" if r["box_id"] else ""
            print(f"run {rid}: settled as lost ({error}); nothing was stopped{where}")
            return _run_row(rid), 0
        time.sleep(min(CANCEL_POLL_S, max(0, deadline - time.monotonic())))


def kill_run(run_id: str, me: dict | None = None) -> int:
    """Cancel the caller's pre-command run, or confirm a started remote process stopped.

    With a caller (`me`), the run must be the caller's own: an unproven caller is refused, and a proven one may only
    stop a run its owner string names. Killing another execution's run is an authority transfer, like a release."""
    from .runs import confirmed_lost, finish
    r = _run_row(run_id)
    rid = r["run_id"]
    if me is not None:
        require_proven(me, "kill")
        if r["owner"] != me["owner"]:
            raise OffboxError(f"run {rid} belongs to another caller; only its owner can kill it", code=2)
    if r['status'] == 'forwarded':
        return _follow_forwarded(r, 'kill')
    settled_home = (api.BACKEND == 'server' and r['status'] not in ('starting', 'running')
                    and r['process_id'] and r['mode'] != 'local')
    if r["status"] not in ("starting", "running") and not settled_home:
        raise OffboxError(f"run {rid} is already {r['status']}; nothing to kill", code=2)
    if r["mode"] == "local":
        raise OffboxError(f"run {rid} is a local run (no box); kill its process on this Mac instead", code=2)
    _require_my_run(r)
    needs_id_proof = not r["process_id"] or db().execute(
        "SELECT 1 FROM kv WHERE k=?", (f"start_unknown:{rid}",)).fetchone() is not None
    if not r["process_id"]:
        r, result = _cancel_before_start(r)
        if result is not None:
            return result
    from . import start_check
    con = db()
    if not settled_home and not start_check.api_pid(con, r) and start_check.recovery_marked(con, r) and r['box_id']:
        with file_lock('box-' + r['box_id'], timeout=1):
            r = _run_row(rid)
            if r['status'] not in ('starting', 'running'):
                raise OffboxError(f"run {rid} is already {r['status']}; nothing to kill", code=2)
            if not start_check.api_pid(con, r):
                result = start_check.check(r['box_id'], rid, claim=start_check.claims_enabled(con, rid))
                if result.code is not None or result.verdict == 'fenced':
                    start_check.settle(con, r, result, 'offbox kill checked an unattached start')
                    con.execute('DELETE FROM kv WHERE k=?', (f'start_unknown:{rid}',))
                    con.commit()
                    return 0
                start_check.remember_wrapper(con, r, result.pid)
                con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'start_unknown:{rid}', r['box_id']))
                con.commit()
                say(f"run {rid}: remote termination unconfirmed; reservation kept. "
                    + start_check.hint(r['box_id'], rid, result.pid))
                return 1
    if needs_id_proof:
        _require_my_run(r)
        # Concurrent recovery can overwrite process_id with an OS PID. Check the API's command identity before
        # sending a kill: a 404 or an ID collision is not proof that this run stopped.
        proof = None
        if r["box_id"] and r["command_id"]:
            try:
                proof = api.cmd_status(r["box_id"], r["process_id"])
            except OffboxError:
                pass
        if not proof or proof.get("commandId") != r["command_id"]:
            con = db()
            con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)", (f"start_unknown:{rid}", r["box_id"]))
            con.commit()
            say(f"run {rid}: process {r['process_id']} has no confirmed API command ID; "
                "reservation kept until the box stops")
            return 1
    if not r["box_id"]:
        raise OffboxError(f"run {rid} has process {r['process_id']} but no box; cannot stop it", code=2)
    if settled_home:
        return _cleanup_settled_home(r)
    box, pid = r["box_id"], r["process_id"]
    # DELETE may fail (timeout) while the process is already gone, so the GET is the authority. Only a 404 (None)
    # or an explicit running:false counts as stopped; a DELETE error alone, an error on the GET, or an empty/unknown
    # status keeps the row (and the lease's active-run reservation) as it is.
    event(con, box, 'run_kill_requested', f"{rid} owner={(me or {}).get('owner') or r['owner'] or 'unknown'}")
    try:
        kill_err = None
        try:
            with api.budget(KILL_REQUEST_S):
                api.cmd_kill(box, pid)
        except OffboxError as e:
            kill_err = str(e)
        try:
            event(con, box, 'run_kill_confirming', f"{rid} owner={(me or {}).get('owner') or r['owner'] or 'unknown'}")
        except sqlite3.Error as error:
            # A failed event commit must not retain the writer while finish opens another connection.
            try:
                con.rollback()
            except sqlite3.Error:
                pass
            from .runs import state_warning
            state_warning(rid, None, error)
        say(f"run {rid}: kill requested for process {pid} on {box}; waiting up to {KILL_CONFIRM_S} s for it to stop")
        started = monotonic()
        deadline = started + KILL_CONFIRM_S
        st = {}
        status_err = None
        while True:
            left = deadline - monotonic()
            if left <= 0:
                break
            try:
                # Home boatd acknowledges DELETE before its cgroup has stopped. Bound each GET too, so a slow or
                # failing tracker cannot turn the confirmation window into several minutes of HTTP retries.
                st = api.cmd_status(box, pid, timeout=min(5, left), retries=0, deadline=time.time() + left)
                status_err = None
                if st is None or st.get('status') == 'lost' or st.get('running') is False:
                    break
            except OffboxError as e:
                status_err = str(e)
            left = deadline - monotonic()
            if left <= 0:
                break
            sleep(min(1 if monotonic() - started < 5 else 2, left))
        if status_err is not None:
            say(f"run {rid}: could not read process {pid} on {box} after kill ({status_err}); row left as {r['status']}")
            return 1
        if st is not None and st.get('status') == 'lost':
            try:
                st = confirmed_lost(box, rid, timeout=min(20, max(0, deadline - monotonic())))
            except OffboxError:
                st = None
            if st is None:
                say(f"run {rid}: remote termination unconfirmed on {box}; row left as {r['status']}")
                return 1
        if st is not None and st.get("running") is not False:
            why = "still reports it running" if st.get("running") else "returned no clear running state"
            say(f"run {rid}: boat {why} after {KILL_CONFIRM_S} s for process {pid} on {box}; row left as {r['status']}"
                + (f" (kill error: {kill_err})" if kill_err else "")
                + f". The box may still be stopping it: re-run `offbox kill {rid}` (safe to repeat), "
                  f"or check `offbox logs {rid}`.")
            return 1
        from .runs import _status_code, remember_interruption
        code, final_status = 143, 'killed'
        if st and st.get('status') in ('exited', 'interrupted'):
            observed = _status_code(st)
            if observed is not None:
                code = observed
                final_status = 'interrupted' if st['status'] == 'interrupted' else \
                    ('killed' if st.get('signal') or code in (137, 143) else 'done' if code == 0 else 'failed')
                remember_interruption(rid, st)
        if final_status == 'killed':
            code = 143
        finish(rid, code, final_status, catch_up=False)
        con = None
        try:
            con = db()
            con.execute("DELETE FROM kv WHERE k=?", (f"start_unknown:{rid}",))
            con.commit()
        except sqlite3.Error as error:
            message = (f"{rid}: remote termination confirmed; local start-marker cleanup failed ({error}). "
                       f"Read/repair its result with: offbox wait {rid}; do not rerun the command")
            say("warning: " + message)
            log(message)
        finally:
            if con:
                con.close()
        outcome = f"killed run {rid}" if final_status == 'killed' else f"run {rid} ended {final_status} exit={code}"
        print(f"{outcome} (process {pid} on box {box}). `offbox release [--delete]` works now."
              + (f" (kill request failed but boat reports the process gone: {kill_err})" if kill_err else ""))
        if isinstance((st or {}).get('cleanup'), dict):
            from .runs import cleanup_summary, save_run_state
            save_run_state(rid, cleanup=st['cleanup'])
            print(cleanup_summary(st['cleanup']))
        return 0
    finally:
        try:
            with contextlib.closing(db()) as kill_con:
                event(kill_con, box, 'run_kill_finished', f'{rid} confirmation finished')
        except sqlite3.Error as error:
            say(f'warning: {rid}: could not record kill confirmation completion ({error})')



def _cleanup_settled_home(r):
    from .runs import cleanup_summary, save_run_state
    result = api.cmd_kill(r['box_id'], r['process_id'])
    info = result.get('cleanup') if isinstance(result, dict) else None
    info = info if isinstance(info, dict) else {}
    save_run_state(r['run_id'], cleanup=info)
    summary = cleanup_summary(info) + (' (0 stopped)' if info.get('cleanup') == 'clean' else '')
    print(f"run {r['run_id']} (process {r['process_id']} on box {r['box_id']}): {summary}")
    remaining = info.get('remaining')
    count = info.get('leftover_killed')
    known = info.get('cleanup') == 'clean' or (info.get('cleanup') == 'stopped' and type(count) is int and count >= 0)
    return 0 if known and type(remaining) is int and remaining == 0 else 1


def resolve_box(me: dict, box_id: str | None) -> str:
    # Ports uses this for both explicit IDs and the caller's lease; refuse before either selection.
    require_proven(me, "this box action")
    con = db()
    if box_id:
        require_mine(con, box_id)
        return box_id
    r = lease.find_lease(con, me["owner"], me["repo_root"])
    if not r:
        raise OffboxError("no lease for this thread + repo (run `offbox run -- true` to create one)", code=2)
    return r["box_id"]


def ssh_shell(me: dict, box_id: str | None, cmd: list[str]) -> int:
    # Gated first, with or without an explicit box: an explicit id names a box this caller may not own, and the
    # no-id path acquires a lease. Nothing below (lease, API, ssh setup, subprocess) may run for an unproven caller.
    require_proven(me, "ssh")
    row = None
    if not box_id:
        row = lease.acquire(me)
        box_id = row["box_id"]
        rdir = row["remote_dir"]
    else:
        require_mine(db(), box_id)
        s = api.get(box_id)
        if not s or s.get("state") not in api.LIVE_STATES:
            raise OffboxError(f"{box_id} is not running", code=2)
        ssh_sync.setup(box_id)
        rdir = None
    lease.touch(box_id)
    args = ssh_sync.ssh_base(box_id) + (["-t"] if sys.stdin.isatty() and not cmd else []) + [box_id]
    if cmd:
        args.append(" ".join(cmd))
    elif rdir:
        args.append(f"cd ~/{rdir} 2>/dev/null; exec bash -l")
    try:
        return subprocess.call(args)
    finally:
        pool.release_guard(row)


def _free_port(start: int) -> int:
    for p in range(start, start + 200):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise OffboxError("no free local port", code=2)


def ports(me: dict, remote: int, local: int | None, box_id: str | None, reverse: bool = False) -> int:
    box = resolve_box(me, box_id)
    s = api.get(box)
    if not s or s.get("state") not in api.LIVE_STATES:
        raise OffboxError(f"{box} is not running; run something first", code=2)
    ssh_sync.setup(box)
    if reverse:
        # The Mac-side service already listens, so its port is never guessed.
        lp = local or remote
        say(f"reverse tunnel {box}:127.0.0.1:{remote} -> this Mac 127.0.0.1:{lp}  (Ctrl-C to close; keeps the lease warm)")
    else:
        lp = local or _free_port(remote)
        say(f"tunnel http://127.0.0.1:{lp} -> {box}:127.0.0.1:{remote}  (Ctrl-C to close; keeps the lease warm)")
    p = ssh_sync.tunnel(box, remote, lp, reverse)
    try:
        while p.poll() is None:
            time.sleep(60)
            lease.touch(box)
            lease.ensure_ttl(box, 30 * 60)
    except KeyboardInterrupt:
        p.terminate()
    return 0


STATUS_CALL_S = 12   # `offbox status` answers fast even when boat's API hangs (each call gets its own budget)


def _home_run_notices(me):
    from . import common
    from .home_run_observation import notice
    path = common.db_path_for("server")
    if common.home_state().get("state") not in ("home_down", "home_slow") or not path.exists():
        return
    try:
        with contextlib.closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)) as con:
            con.row_factory = sqlite3.Row
            for row in con.execute("SELECT * FROM runs WHERE owner=? AND repo_root=? AND status IN ('starting','running')",
                                   (me["owner"], me["repo_root"])):
                notice(row, backend="server", emit=print)
    except sqlite3.Error:
        pass


def status(me: dict, run_id: str | None = None) -> None:
    if run_id:
        r = _run_row(run_id)
        print(f"{r['run_id']}: {r['status']} box={r['box_id'] or '-'} exit={r['exit_code']} log={r['log_path']}")
        line = size_summary(r)
        if line:
            print(line)
        return
    from . import unfit
    with db() as disk_con:
        for row in disk_con.execute("SELECT * FROM leases WHERE pinned_until>? AND pinned_until<=? "
                                    "AND state!='deleted' ORDER BY pinned_until", (now(), now()+86400)):
            holder = kv_get(disk_con, 'pin_owner:' + row['box_id']) or row['owner'] or 'unknown holder'
            print(f"{row['box_id']}: pin expires {iso(row['pinned_until'])}; holder {holder}")
            saved = kv_get(disk_con, 'pin_saved:' + row['box_id'])
            if saved:
                print(f"    retained disk snapshot: {saved}")
        for row in disk_con.execute("SELECT * FROM events WHERE json_valid(detail) AND "
                                    "json_extract(detail,'$.version')=1 ORDER BY ts DESC LIMIT 5"):
            detail = json.loads(row['detail'])
            who = detail['caller']
            print(f"{iso(row['ts'])} {row['box_id'] or '-'} {detail['action']}: {detail['reason']} "
                  f"actor={who['actor']} pid={who.get('pid')} thread={who.get('thread_id') or '-'}")
        for row in disk_con.execute("SELECT box_id FROM leases WHERE state != 'deleted'"):
            mark = unfit.get(disk_con, row['box_id'])
            if mark:
                print(f"{row['box_id']}: suspect: {mark['reason']} ({mark['source']}, expires {iso(mark['expires_at'])})")
        for row in disk_con.execute("SELECT box_id FROM leases WHERE note LIKE 'disk-full:%'"):
            info = kv_get(disk_con, 'disk_full:' + row['box_id']) or {}
            print(f"{row['box_id']}: disk_full " + ', '.join(
                f"{name} {value.get('free_bytes', '?')} bytes free"
                for name, value in info.get('space', {}).items()))
    from . import common
    con = db()
    cap = read_json(CAP_PATH, {})
    if common.home_config() is not None:
        st = common.home_state()
        since = f" since {iso(st['since'])}" if st.get("since") else ""
        if api.BACKEND == "server":
            print(f"backend: home offbox server ({st.get('state')}{since}); Boat is the standby")
        else:
            why = st.get("reason") or ("pinned to Boat" if common.backend_pinned() else "home unreachable")
            print(f"backend: Boat, standing in for the home offbox server ({st.get('state')}{since}: {why}). "
                  "New submissions probe home before choosing Boat")
        daily = st.get("flaps_today") or {}
        if daily:
            print(f"home flaps today ({daily.get('day')}): slow={daily.get('slow', 0)} "
                  f"slow_max_s={daily.get('slow_max_s', 0)} starting={daily.get('starting', 0)} "
                  f"starting_max_s={daily.get('starting_max_s', 0)} down={daily.get('down', 0)}")
        _home_run_notices(me)
        if st.get("degraded"):
            print(f"home server degraded: {'; '.join(str(x) for x in st['degraded'][:3])}")
    for row in (st.get('disk') or {}).get('filesystems', []) if common.home_config() is not None else []:
        print(f"home disk {row['filesystem']}: {row['free_bytes'] / 1024**3:.1f} GiB free "
              f"({row.get('free_pct', 0):.1f}%), inodes {row.get('free_inodes', '?')}, {row.get('level', '?')}")
    d = outage.current()
    if d:
        print(f"boat.dev: DOWN since {iso(d['since'])} ({d.get('reason')}), last failure {ago(d.get('seen'))} ago")
    try:
        with api.budget(STATUS_CALL_S):
            L = api.limits()
        sps = L.get("creditSecondsPerDollar") or 100000
        print(f"account: plan {L.get('sandboxPlanKey')} {L.get('subscriptionStatus')}, can start: {L.get('canStart')}, "
              f"active boxes {L.get('activeSandboxes')}/{L.get('maxActiveSandboxes')}, "
              f"plan left ${(L.get('subscriptionRemainingSeconds') or 0) / sps:.2f}, packs ${L.get('packBalanceDollars')}")
    except OffboxError as e:
        print(f"account: boat API unreachable ({e})")
    capped = cap.get("capped")
    print(f"cap: {'CAPPED' if capped else 'ok'} (last spend ${cap.get('spend', 0):.2f})")
    s = capacity.snapshot(con)
    print('starts: ' + ', '.join(f"{w['used']}/{w['cap']} in {w['window']}s" for w in s['counts']) +
          (f"; next local allowance {iso(s['retry_at'])}" if s['blocked'] else '; allowance available'))
    for size, e in sorted(capacity.supply_status().items()):
        print(f"boat supply: {size} out until {iso(e['until'])} (since {iso(e['since'])})")
    try:
        with api.budget(STATUS_CALL_S):
            boxes = api.list_boxes()
        for b in boxes:
            hold = con.execute("SELECT created_at FROM prune_holds WHERE box_id=?", (b["id"],)).fetchone()
            held = f" prune-held since {time.strftime('%H:%M', time.localtime(hold['created_at']))}" if hold else ''
            snapshot_bytes = b.get('snapshotBytes')
            held += f" snapshots {snapshot_bytes / 1024**3:.1f} GiB" if snapshot_bytes is not None else ''
            reason = lease.boot_dead(con, b['id'])
            if reason:
                held += f' set aside [{reason}]'
            retained = con.execute('SELECT note FROM leases WHERE box_id=?', (b['id'],)).fetchone()
            if retained and (retained['note'] or '').startswith(pool.RECYCLED_NOTE):
                held += f" detached [{retained['note']}]"
            print(f"  {b['id']:<12} {b.get('state'):<9} {b.get('type'):<8} {(b.get('name') or '')[:60]}{held}")
            pin = (b.get('protection') or {}).get('pin') or {}
            expiry = common.iso_ts(pin.get('until'))
            if pin.get('active') and expiry is not None and now() < expiry <= now()+86400:
                print(f"    pin expires {pin['until']}; holder {pin.get('holder') or 'unknown holder'}")
            if b.get('lastEvent'):
                e = b['lastEvent']
                print(f"    {e['action']}: {e['reason']} actor={e['caller']['actor']} "
                      f"pid={e['caller'].get('pid')} run={e['caller'].get('run_id') or '-'}")
    except OffboxError as e:
        print(f"boxes: boat API unreachable ({e})")
    for row in con.execute("SELECT r.* FROM runs r JOIN kv k ON k.k='failover_queue:' || r.run_id "
                           "WHERE r.status='starting' AND r.box_id IS NULL AND r.process_id IS NULL"):
        print(_not_started(row))
    print(f"you: {me['owner']} repo {me['repo_root']}")


def _run_row(run_id: str):
    con = db()
    r = con.execute("SELECT * FROM runs WHERE run_id=? OR run_id LIKE ?", (run_id, f"%{run_id}")).fetchone()
    if not r:
        raise OffboxError(f"no run {run_id}", code=2)
    _require_my_run(r)
    if r['status'] == 'forwarded':
        return r  # The shared receipt now belongs to the destination backend, not this forwarding row.
    from .runs import finish, restore_run_state, terminal_result
    from . import start_check
    recovered = restore_run_state(r)
    _require_my_run(recovered)
    if terminal_result(recovered) and (r['status'] in ('starting','running') or
                                     (recovered['status'] == 'killed' and (r['exit_code'] is None or
                                      (r['status'] == 'failed' and r['exit_code'] in (137,143)))) or
                                     (r['exit_code'] is None and (r['status'] == 'lost' or
                                      (r['status'] == 'infra' and start_check.recovery_marked(con, r))))):
        from .pulls import TERMINAL
        if not json.loads(r['pulls'] or '[]') or r['pull_state'] in TERMINAL:
            finish(r['run_id'], recovered['exit_code'], recovered['status'], catch_up=False)
    return recovered


def _require_my_run(r) -> None:
    """logs, wait and kill ask the box about the run. On another owner's box every answer is 404, which would
    settle a live run as lost: refuse before asking (common.require_mine)."""
    if r["box_id"]:
        require_mine(db(), r["box_id"])


LOG_READ_WAIT_S = 10


def _checkpoint_bytes(path):
    try:
        size = path.stat().st_size
        keep = (checkpoint(path) or {}).get('logBytes', 0)
        return keep if 0 <= keep <= size else 0
    except (OSError, ValueError, TypeError):
        return 0


def _catch_up_log(r, budget: float | None = None, *, locked: bool = False, live: bool = False,
                  lock_wait: float = 0) -> str:
    stats = dict(run=r['run_id'], live=live, result='error', seconds=0, pages=[0, 0], bytes=0,
                 slowest_ms=0, lock_wait_ms=0, budget=budget, page_ms=[[], []], page_ms_omitted=[0, 0])
    started = monotonic()
    try:
        result = _fetch_log(r, budget, locked=locked, live=live, lock_wait=lock_wait, stats=stats)
        stats['result'] = result
        if live:
            from .home_run_observation import notice_queue_after_read
            notice_queue_after_read(r['run_id'], row=r, path=_shown_log(LOGS_DIR / f"{r['run_id']}.log"))
        return result
    finally:
        stats['seconds'] = round(monotonic() - started, 3)
        detail = json.dumps(stats, separators=(',', ':'))
        # Diagnostics must not wait on a writer, migrate the DB, or backfill owners after a fetch deadline.
        try:
            from . import common
            with contextlib.closing(sqlite3.connect(common.DB_PATH, timeout=0, isolation_level=None)) as con:
                event(con, r['box_id'], 'logs_fetch', detail)
        except sqlite3.Error:
            with contextlib.suppress(OSError):
                log(f"logs_fetch {r['box_id'] or '-'} {detail}")
        except OSError:
            pass


def _fetch_log(r, budget, *, locked, live, lock_wait, stats) -> str:
    """Settled history reads need only the run lock; live recovery still takes box then run."""
    from .runs import log_lock
    if (r['status'] in ('starting', 'running') and not live) or not r['box_id']:
        return 'n/a'
    if not r['command_id'] and (live or r['mode'] != 'bg'):
        return 'n/a'
    path = LOGS_DIR / f"{r['run_id']}.log"
    started = time.time()
    before = read_json(offsets_path(path), {})
    guard = contextlib.ExitStack()
    try:
        if live and not locked:
            guard.enter_context(file_lock('box-' + r['box_id'], timeout=0))
        lock_started = monotonic()
        try:
            waited = guard.enter_context(log_lock(r['run_id'], timeout=0 if locked or live else
                                                 min(lock_wait, lock_wait if budget is None else max(0, budget))))
        finally:
            stats['lock_wait_ms'] = round((monotonic() - lock_started) * 1000, 3)
    except OffboxError:
        guard.close()
        return 'n/a'
    published_before = _checkpoint_bytes(path)
    try:
        ck = read_json(offsets_path(path), {})
        # Reuse a completed check published by the holder we just waited for. Sequential reads still check history,
        # since a server can publish more retained output after settlement.
        if (waited and r['command_id'] and isinstance(ck, dict) and ck != before and ck.get('settledCheck')
                and ck.get('settledCommandId') == r['command_id']
                and checkpoint(path) is not None and not _remote_copy(path)
                and path.exists() and path.stat().st_size == ck['logBytes']):
            return 'complete'
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        remaining = None if budget is None else max(0, budget - (time.time() - started))
        deadline = time.time() + (30 if remaining is None else remaining)
        history_budget = remaining
        boat_bg = not live and api.BACKEND == 'boat' and r['mode'] == 'bg'
        if boat_bg and remaining is not None:
            history_budget = remaining / 2
        result = _catch_up_log_locked(r, path, history_budget, live=live, stats=stats) if r['command_id'] else 'n/a'
        if locked and not live and r['mode'] == 'bg' and api.BACKEND == 'boat':
            event(db(), r['box_id'], 'log_catchup_result', f"{r['run_id']} {result}")
        if not live and result in ('complete', 'caught_up'):
            ck = checkpoint(path)
            atomic_write_json(offsets_path(path), dict(ck, settledCommandId=r['command_id'], settledCheck=time.time_ns()))
        diagnostic_only = not live and api.BACKEND == 'boat' and _diagnostic_only(r, path)
        incomplete_checkpoint = result not in ('complete', 'caught_up') and checkpoint(path) is not None
        if not live and r['mode'] == 'bg' and (not _has_data(path) or _remote_copy(path)
                                              or diagnostic_only or incomplete_checkpoint):
            # Without a caller deadline history keeps its size-adaptive budget; SSH gets its own bounded attempt.
            if boat_bg and budget is None:
                deadline = time.time() + 10
            return _empty_log_fallback(r, path, deadline, result)
        return result
    except OSError as e:
        return 'incomplete:' + str(e)
    finally:
        stats['bytes'] = max(0, _checkpoint_bytes(path) - published_before)
        try:
            if not live:
                from .pulls import footer
                footer(r['run_id'])
        finally:
            guard.close()


def _diagnostic_only(r, path):
    if checkpoint(path) is None:
        return False
    wrapper = False
    marker = f"offbox-command-started: {r['run_id']}\n".encode()
    with path.open('rb') as src:
        while line := src.readline(4096):
            if line == marker:
                return False
            wrapper |= line.startswith(b'offbox evidence wrapper pid=')
    return wrapper


def _remote_copy(path):
    meta = read_json(Path(str(path) + '.remote.json'), {})
    return meta if Path(str(path) + '.remote').is_file() else {}


def _remote_result(r, path, result):
    meta = _remote_copy(path)
    reason = ' '.join((result.removeprefix('incomplete:') if result != 'n/a' else 'history unavailable').splitlines())
    if result in ('complete', 'caught_up'):
        reason = 'history empty'
    raw, received_stderr, _ = _received_output(path, meta)
    received = 'received output and ' if raw != Path(str(path) + '.remote') else ''
    result = f"incomplete:{received}box copy {meta['source']}; history: {reason}"
    if ('reason' in meta and meta.get('exit_code') == r['exit_code']
            and _remote_view_current(path, raw, meta, received_stderr)):
        return result
    meta.update(reason=reason, exit_code=r['exit_code'])
    if not meta.get('merged'):
        reason_tag = {'history empty': 'history_empty', 'timeout': 'history_timeout',
                      'no progress': 'history_no_progress'}.get(reason, 'history_unavailable')
        toollog.emit('run', 'run.log_stream_missing', kind='error', ok=False, ids={'run': r['run_id']},
                     props={'stream': 'stderr', 'backend': api.BACKEND, 'reason': reason_tag})
    atomic_write_json(Path(str(path) + '.remote.json'), meta)
    if raw == path:
        return f"incomplete:received output only; could not combine box copy {meta['source']}; history: {reason}"
    try:
        _write_remote_view(path, raw, meta, received_stderr)
    except OSError as e:
        return result + f'; view unavailable: {e}'
    return result


def _received_output(path, meta):
    raw = Path(str(path) + '.remote')
    ck = checkpoint(path)
    if meta.get('merged') or not ck or not ck['logBytes']:
        return raw, False, 0
    received_stderr = bool(ck['stderrOffset'])
    tmp = None
    try:
        with path.open('rb') as local, raw.open('rb') as remote:
            local_info, remote_info = os.fstat(local.fileno()), os.fstat(remote.fileno())
            if local_info.st_size < ck['logBytes']:
                return path, received_stderr, 0
            generation = repr((ck, tuple((s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
                                        for s in (local_info, remote_info)))).encode()
            combined = Path(str(raw) + '.received-' + hashlib.sha256(generation).hexdigest()[:20])
            if combined.exists():
                return combined, received_stderr, ck['logBytes']
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.received.', delete=False) as dst:
                tmp = dst.name
                # Stream offsets cannot separate an interleaved prefix. Keep it whole alongside the box copy.
                left = ck['logBytes']
                while left:
                    chunk = local.read(min(left, 64 * 1024))
                    if not chunk:
                        return path, received_stderr, 0
                    dst.write(chunk)
                    left -= len(chunk)
                dst.write(b'\n')
                shutil.copyfileobj(remote, dst, 64 * 1024)
            os.replace(tmp, combined)
            tmp = None
            return combined, received_stderr, ck['logBytes']
    except OSError:
        return path, received_stderr, 0
    finally:
        if tmp is not None:
            Path(tmp).unlink(missing_ok=True)


def _remote_footer(path, meta, received_stderr):
    notice = ''
    if not meta.get('merged'):
        reason = meta.get('reason', 'history unavailable')
        notice = (f"offbox: remaining stderr for this run could not be fetched ({reason}); received stderr is included\n"
                  if received_stderr else
                  f"offbox: stderr for this run could not be fetched ({reason}); output shows stdout only\n")
    from . import resources
    saved = read_json(path.with_suffix('.state.json'), {})
    footer = resources.summary(saved.get('resources') or resources.unavailable('boat', 1))
    code = meta.get('exit_code')
    exit_line = f'remote exit {code}' if code is not None else 'remote exit unknown'
    return ('\n' + notice + footer + f"\noffbox: {exit_line}\n").encode()


def _remote_view_current(path, raw, meta, received_stderr):
    footer = _remote_footer(path, meta, received_stderr)
    try:
        with Path(str(raw) + '.view').open('rb') as src:
            if os.fstat(src.fileno()).st_size != raw.stat().st_size + len(footer):
                return False
            src.seek(-len(footer), os.SEEK_END)
            return src.read() == footer
    except OSError:
        return False


def _write_remote_view(path, raw, meta, received_stderr):
    footer = _remote_footer(path, meta, received_stderr)
    view = Path(str(raw) + '.view')
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.view.', delete=False) as dst:
        tmp = dst.name
        try:
            with raw.open('rb') as src:
                shutil.copyfileobj(src, dst, 64 * 1024)
            dst.write(footer)
            dst.flush()
            os.replace(tmp, view)
        finally:
            Path(tmp).unlink(missing_ok=True)


def _raw_log(path):
    meta = _remote_copy(path)
    return _received_output(path, meta)[0] if meta else path


def _shown_log(path):
    return _display_log(path)[0]


def _display_log(path):
    meta = _remote_copy(path)
    if not meta:
        return path, 0
    raw, received_stderr, received_bytes = _received_output(path, meta)
    if raw == path:
        return path, 0
    view = Path(str(raw) + '.view')
    if received_bytes:
        record_delivery(raw, min(delivered_bytes(path), received_bytes))
    try:
        # Raw and rendered files share the payload prefix even when rendering fails between reads.
        payload_size = raw.stat().st_size
        record_delivery(raw, min(delivered_bytes(view), payload_size))
        if not _remote_view_current(path, raw, meta, received_stderr):
            _write_remote_view(path, raw, meta, received_stderr)
        record_delivery(view, min(delivered_bytes(raw), payload_size))
    except OSError:
        return raw, received_bytes
    return view, received_bytes


def _empty_log_fallback(r, path, deadline, result) -> str:
    """Keep the optional box copy separate from checkpointed history; never wake a box to read it."""
    # boatd's history reads its full host-side logs; the container has no additional copy to recover over SSH.
    if api.BACKEND == 'server':
        return result
    if _remote_copy(path):
        return _remote_result(r, path, result)
    tmp = None
    try:
        with api.budget(max(0, deadline - time.time())):
            box = api.get(r['box_id'])
            if not box or box.get('state') not in api.LIVE_STATES:
                return result
            # The wrapper copy is optional on older runs; boat also keeps a process log on its live machine.
            paths = [f'.offbox/out/{r["run_id"]}.log']
            prefix = f'.offbox/out/{r["run_id"]}'
            wrapper_pid = r['wrapper_pid'] or r['process_id']
            if wrapper_pid:
                paths.append(f'.ascii/processes/{int(wrapper_pid)}.log')
            command = (f'p={shlex.quote(prefix)}; '
                       'if test -f "$HOME/$p.stdout" && test -f "$HOME/$p.stderr"; then '
                       'printf "streams %s %s\\n" "$(wc -c < "$HOME/$p.stdout")" "$(wc -c < "$HOME/$p.stderr")" >&2; '
                       'cat "$HOME/$p.stdout" "$HOME/$p.stderr"; exit $?; fi; ')
            command += 'for f in ' + ' '.join(shlex.quote(p) for p in paths) + '; do '
            command += 'if test -s "$HOME/$f"; then printf "%s\\n" "$f" >&2; cat "$HOME/$f"; exit $?; fi; done; exit 44'
            remaining = api.left()
            left = min(10, deadline - time.time(), 10 if remaining is None else remaining)
            if left <= 0:
                return result
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.remote.', delete=False) as dst:
                tmp = dst.name
                proc = subprocess.run(ssh_sync.ssh_base(r['box_id']) + [r['box_id'], command],
                                      stdout=dst, stderr=subprocess.PIPE, timeout=left)
            if proc.returncode == 0 and os.path.getsize(tmp):
                source = (proc.stderr or b'').decode(errors='replace').strip() or 'remote process log'
                streams = re.fullmatch(r'streams (\d+) (\d+)', source)
                meta = dict(source=f'{prefix}.stdout + {prefix}.stderr' if streams else source, merged=bool(streams))
                if streams:
                    lengths = [int(streams[1]), int(streams[2])]
                    if sum(lengths) != os.path.getsize(tmp):
                        return 'incomplete:box streams changed during fetch'
                    hashes = []
                    with open(tmp, 'rb') as src:
                        for length in lengths:
                            digest = hashlib.sha256()
                            left = length
                            while left:
                                chunk = src.read(min(left, 64 * 1024))
                                digest.update(chunk)
                                left -= len(chunk)
                            hashes.append(digest.hexdigest())
                    meta.update(lengths=lengths, hashes=hashes)
                atomic_write_json(Path(str(path) + '.remote.json'), meta)
                size = os.path.getsize(tmp)
                os.replace(tmp, Path(str(path) + ".remote"))
                tmp = None
                event(db(), r['box_id'], 'output_recovered', f"{r['run_id']} remote log bytes={size}")
                return _remote_result(r, path, result)
    except (OffboxError, OSError, subprocess.TimeoutExpired, ValueError):
        pass
    finally:
        if tmp is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
    return result


def _preamble_first(dst, stdout_bytes, run_id):
    # History has separate streams, so its stdout-first merge otherwise puts setup after the command's output.
    # Only a fresh settled recovery can reorder bytes: existing checkpoints and delivery cursors must stay valid.
    marker = f'offbox-command-started: {run_id}\n'.encode()
    end = dst.tell()
    dst.seek(stdout_bytes)
    with tempfile.TemporaryFile() as prefix:
        while line := dst.readline(64 * 1024):
            prefix.write(line)
            if line == marker:
                break
        else:
            dst.seek(end)
            return
        size = prefix.tell()
        left = stdout_bytes
        while left:
            count = min(left, 64 * 1024)
            left -= count
            dst.seek(left)
            chunk = dst.read(count)
            dst.seek(left + size)
            dst.write(chunk)
        dst.seek(0)
        prefix.seek(0)
        shutil.copyfileobj(prefix, dst, 64 * 1024)
    dst.seek(end)


def _recover_live_suffix(r, path, ck, length, deadline, stats):
    from . import live_logs
    from .runs import _commit
    staged = path.with_name(path.name + '.recovery')
    source = path.stat()
    identity = dict(checkpoint=ck, box=r['box_id'], command=r['command_id'], inode=[source.st_dev, source.st_ino])
    saved = read_json(offsets_path(staged), {})
    prior = None
    with contextlib.suppress(ValueError, TypeError):
        prior = checkpoint(staged)
    valid = (isinstance(saved, dict) and saved.get('base') == identity and prior is not None and staged.exists()
             and prior['stdoutOffset'] >= ck['stdoutOffset'] and prior['stderrOffset'] >= ck['stderrOffset']
             and 0 <= prior['logBytes'] <= staged.stat().st_size
             and prior['logBytes'] == prior['stdoutOffset'] + prior['stderrOffset'] - ck['stdoutOffset'] - ck['stderrOffset'])
    if not valid:
        staged.write_bytes(b'')
        prior = dict(stdoutOffset=ck['stdoutOffset'], stderrOffset=ck['stderrOffset'], logBytes=0)
        atomic_write_json(offsets_path(staged), dict(prior, base=identity))
    # Only checkpointed staging bytes can be reused after an interrupted page write. The original raw suffix
    # stays intact until accumulated history covers it, including when several frames interleave past a failed commit.
    with staged.open('r+b') as dst:
        dst.truncate(prior['logBytes'])
    result = _catch_up_live(r, staged, max(0, deadline - time.time()), stats, recovery_base=identity)
    recovered = checkpoint(staged)
    size = recovered['logBytes']
    if size < length - ck['logBytes']:
        live_logs.note(r['run_id'], 'recovery_staged', staged_bytes=size,
                       remaining_uncommitted_bytes=length - ck['logBytes'] - size)
        return 'incomplete:uncommitted suffix remains' if size else 'incomplete:history behind local log'
    with staged.open('rb') as src, path.open('r+b') as dst:
        dst.seek(ck['logBytes'])
        left = size
        while left:
            chunk = src.read(min(left, 64 * 1024))
            if not chunk:
                raise OSError('short recovery file')
            dst.write(chunk)
            left -= len(chunk)
        dst.truncate()
        dst.flush()
        published = dict(stdoutOffset=recovered['stdoutOffset'], stderrOffset=recovered['stderrOffset'], logBytes=dst.tell())
        _commit(path, published['stdoutOffset'], published['stderrOffset'], published['logBytes'])
    live_logs.note(r['run_id'], 'flush', bytes=size, **published)
    if checkpoint(path) == published:
        for temporary in (staged, offsets_path(staged)):
            with contextlib.suppress(OSError):
                temporary.unlink()
    return result if result.startswith('incomplete:') else 'caught_up'


def _catch_up_live(r, path, budget, stats, *, recovery_base=None):
    from . import live_logs
    from .runs import _commit, remember_interruption
    deadline = time.time() + (10 if budget is None else budget)
    ck = checkpoint(path)
    length = path.stat().st_size
    if ck is None:
        if length:
            return 'incomplete:no checkpoint'
        ck = dict(stdoutOffset=0, stderrOffset=0, logBytes=0)
    if min(ck.values()) < 0 or length < ck['logBytes']:
        return 'incomplete:invalid checkpoint'
    if _remote_copy(path):
        return 'incomplete:retained copy needs settled verification'
    if length > ck['logBytes']:
        return _recover_live_suffix(r, path, ck, length, deadline, stats)
    offsets = [ck['stdoutOffset'], ck['stderrOffset']]
    errors, behind, wrote, attempted = [], [0, 0], False, set()
    with path.open('r+b') as dst:
        dst.seek(ck['logBytes'])
        def flush(i, data):
            nonlocal wrote
            dst.write(data)
            dst.flush()
            offsets[i] += len(data)
            if recovery_base is None:
                _commit(path, *offsets, dst.tell())
            else:
                atomic_write_json(offsets_path(path), dict(stdoutOffset=offsets[0], stderrOffset=offsets[1],
                                                          logBytes=dst.tell(), base=recovery_base))
            wrote = True
            live_logs.note(r['run_id'], 'flush' if recovery_base is None else 'recovery_staged', bytes=len(data),
                           stdoutOffset=offsets[0], stderrOffset=offsets[1],
                           **{('logBytes' if recovery_base is None else 'staged_bytes'): dst.tell()})
        with contextlib.closing(live_logs.pages(r['box_id'], r['command_id'], offsets, until=deadline, stats=stats)) as history:
            for i, page, error in history:
                attempted.add(i)
                if error:
                    errors.append(error)
                    continue
                remember_interruption(r['run_id'], page)
                if api.BACKEND == 'server' and page.get('status'):
                    from .home_run_observation import observe
                    observe(r['run_id'], page['status'], status=page['status'], attempt=page.get('attempt'))
                data = (page.get('data') or '').encode()
                observed = int(page.get('nextOffset', offsets[i] + len(data)))
                if data:
                    flush(i, data)
                behind[i] = max(0, int(page['size']) - observed) if page.get('size') is not None else 0
        if len(attempted) < 2:
            errors.append('timeout')
    if errors or any(behind):
        if any(behind):
            live_logs.note(r['run_id'], 'backlog', remaining_bytes=sum(behind))
        return 'incomplete:' + ('more output available' if any(behind) else ','.join(errors))
    return 'caught_up' if wrote else 'complete'


def _catch_up_log_locked(r, path, budget, *, live=False, stats=None) -> str:
    if live:
        return _catch_up_live(r, path, budget, stats)
    from .runs import remember_interruption
    started = time.time()
    deadline = started + (30 if budget is None else budget)
    tmp = None
    try:
        ck = checkpoint(path)
        length = path.stat().st_size
        if ck is None and not _has_data(path):
            length = 0  # A journal-owned footer is reconstructible and has no remote stream offsets.
        remote = _remote_copy(path)
        if remote and ck is None:
            length = 0
        if ck is None or (not length and r['mode'] == 'bg'):
            if length:
                # Legacy bytes have no stream mapping. Equal lengths cannot prove that both streams are here.
                return 'incomplete:no checkpoint'
            ck = dict(stdoutOffset=0, stderrOffset=0, logBytes=0)
        keep = ck['logBytes']
        if min(keep, ck['stdoutOffset'], ck['stderrOffset']) < 0 or length < keep:
            return 'incomplete:invalid checkpoint'
        # Verify a retained copy from stream zero without changing the checkpointed prefix's layout: readers may
        # still hold delivery positions into its interleaved bytes. Append only bytes beyond those stream offsets.
        offsets = [0, 0] if remote else [ck['stdoutOffset'], ck['stderrOffset']]
        sizes = [0, 0]
        digests = [hashlib.sha256(), hashlib.sha256()]
        copied = [0, 0]
        with tempfile.NamedTemporaryFile(mode='w+b', dir=path.parent, prefix=path.name + '.catchup.',
                                         delete=False) as dst:
            tmp = dst.name
            with open(path, 'rb') as src:
                left = keep
                while left:
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    chunk = src.read(min(left, 64 * 1024))
                    if not chunk:
                        return 'incomplete:short local log'
                    dst.write(chunk)
                    left -= len(chunk)
            for i, which in enumerate(('stdout', 'stderr')):
                header, trimming = bytearray(), which == 'stderr'
                snapshot = None
                empty_pages = 0
                while True:
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    page_started = monotonic()
                    try:
                        page = api.history_logs(r['box_id'], r['command_id'], which, offsets[i], deadline=deadline)
                    finally:
                        if stats is not None:
                            elapsed_ms = round((monotonic() - page_started) * 1000, 3)
                            stats['pages'][i] += 1
                            stats['slowest_ms'] = max(stats['slowest_ms'], elapsed_ms)
                            # Keep the summary bounded even when retained history has thousands of pages.
                            if len(stats['page_ms'][i]) < 8:
                                stats['page_ms'][i].append(elapsed_ms)
                            else:
                                stats['page_ms_omitted'][i] += 1
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    remember_interruption(r['run_id'], page, until=deadline)
                    if live and api.BACKEND == 'server' and page.get('status'):
                        from .home_run_observation import observe
                        observe(r['run_id'], page['status'], status=page['status'], attempt=page.get('attempt'))
                    if page.get('size') is not None:
                        sizes[i] = max(sizes[i], int(page['size']) - (0 if remote else ck[which + 'Offset']))
                        if snapshot is None:
                            snapshot = int(page['size'])
                    if budget is None:
                        deadline = started + min(180, 30 + sum(sizes) / 1_000_000)
                    data = (page.get('data') or '').encode()
                    nxt = page.get('nextOffset')
                    nxt = offsets[i] + len(data) if nxt is None else int(nxt)
                    # Older home servers omit size; an empty live page can mean the command is quiet.
                    if live and not data and nxt == offsets[i] and not page.get('done') and page.get('size') is None:
                        break
                    if nxt <= offsets[i] and not page.get('done') and not (live and snapshot is not None and nxt >= snapshot):
                        if not live and r['mode'] == 'bg' and not length and not data and nxt == offsets[i] and empty_pages < 2:
                            empty_pages += 1
                            continue
                        return 'incomplete:no progress'
                    if nxt != offsets[i] + len(data):
                        return 'incomplete:invalid history offset'
                    if remote.get('lengths'):
                        # stdout matches its prefix; stderr also has the outer wrapper's PID diagnostic first.
                        expected = remote['lengths'][i]
                        payload = data
                        if trimming:
                            header.extend(payload)
                            if b'\n' not in header and len(header) <= 256:
                                payload = b''
                            else:
                                payload = bytes(header)
                                match = re.match(rb'offbox evidence wrapper pid=\d+\n', payload)
                                if match:
                                    payload = payload[match.end():]
                                trimming = False
                        chunk = payload[:max(0, expected - copied[i])]
                        digests[i].update(chunk)
                        copied[i] += len(chunk)
                    skip = max(0, ck[which + 'Offset'] - offsets[i]) if remote else 0
                    dst.write(data[skip:])
                    empty_pages = 0
                    offsets[i] = nxt
                    if live and not remote and dst.tell() >= length:
                        # Publish each validated page before fetching more: a later failure must keep this progress.
                        dst.flush()
                        if tmp is not None:
                            os.replace(tmp, path)
                            tmp = None
                        atomic_write_json(offsets_path(path),
                                          dict(stdoutOffset=offsets[0], stderrOffset=offsets[1], logBytes=dst.tell()))
                    if live and (snapshot is None or nxt >= snapshot):
                        break
                    if page.get('done'):
                        if page.get('size') is not None and nxt < int(page['size']):
                            return 'incomplete:history ended early'
                        break
            if remote:
                if any(offsets[i] < ck[which + 'Offset'] for i, which in enumerate(('stdout', 'stderr'))):
                    return 'incomplete:history behind local log'
                size = Path(str(path) + '.remote').stat().st_size
                available = offsets[0]
                if remote.get('lengths'):
                    if copied != remote['lengths'] or [d.hexdigest() for d in digests] != remote['hashes']:
                        return 'incomplete:history behind box copy'
                    available = sum(offsets)
                if not sum(offsets):
                    return 'incomplete:history empty'
                if available < size:
                    return 'incomplete:history behind box copy'
            if not keep and not live:
                _preamble_first(dst, offsets[0], r['run_id'])
            log_bytes = dst.tell()
        if time.time() >= deadline:
            return 'incomplete:timeout'
        if live and log_bytes < length:
            return 'incomplete:history behind local log'
        if offsets == [ck['stdoutOffset'], ck['stderrOffset']] and length == keep and checkpoint(path) is not None:
            if remote:
                Path(str(path) + '.remote.json').unlink(missing_ok=True)
            return 'complete'
        if remote and not log_bytes:
            return 'incomplete:history empty'
        if tmp is not None:
            os.replace(tmp, path)
            tmp = None
        atomic_write_json(offsets_path(path),
                          dict(stdoutOffset=offsets[0], stderrOffset=offsets[1], logBytes=log_bytes))
        if remote:
            Path(str(path) + '.remote.json').unlink(missing_ok=True)
        # No follower can own these under the run lock. Discard abandoned replay files so a stale replay cannot
        # later replace the completed log with the prefix captured before the run settled.
        takeover = path.with_name(path.name + '.takeover')
        takeover.unlink(missing_ok=True)
        offsets_path(takeover).unlink(missing_ok=True)
        return 'caught_up'
    except (OffboxError, OSError, ValueError, TypeError) as e:
        return 'incomplete:' + ('timeout' if time.time() >= deadline else str(e))
    finally:
        if tmp is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp)


def _catch_up_finished(con, run_id, budget: float = 10, *, row=None) -> str | None:
    """Best effort under the maintenance caller's box lock; history errors cannot undo settlement."""
    from .runs import planned_steps
    try:
        r = row if row is not None else con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        # Step settlement fetched and validated its output before commit. Replacing it here could invalidate the exit.
        if planned_steps(r):
            return
        result = _catch_up_log(r, budget=min(10, budget), locked=True)
        from . import resources
        resources.finalize(r)
        from .pulls import footer
        footer(run_id)
        if result == 'n/a' or result.startswith('incomplete:'):
            reason = result.split(':', 1)[1] if ':' in result else 'run log lock held'
            event(con, r['box_id'], 'log_catchup_failed', f"{run_id} {reason}")
        return result
    except Exception as e:
        event(con, None, 'log_catchup_failed', f"{run_id} {e}")
        return 'incomplete:' + str(e)


def _live_log_notice(r, path, result, seconds) -> bool:
    from .home_run_observation import queued_on_home
    read = read_json(LOGS_DIR / f"{r['run_id']}.home-read.json", {})
    queued = r['status'] == 'queued' or queued_on_home(dict(r), read, path=path)
    if queued:
        since = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(r['start_at'])) if r['start_at'] else 'unknown'
        elapsed = f", {max(0, now() - r['start_at']):.0f}s" if r['start_at'] else ''
        say(f"{r['run_id']} is queued on the server (since {since}{elapsed}); nothing has run yet. "
            f"Keep reading: offbox logs {r['run_id']} --follow, or offbox wait {r['run_id']} --timeout 570")
        return True
    if not result.startswith('incomplete:'):
        return False
    size = path.stat().st_size if path.exists() else 0
    reason = ' '.join(result.split(':', 1)[1].splitlines())
    duration = f' after {seconds:.1f}s' if seconds is not None else ''
    say(f"{r['run_id']} is still running; fetched {size} bytes so far ({reason}{duration}); "
        f"more output is on the server. Keep reading: offbox logs {r['run_id']} --follow, "
        f"or offbox wait {r['run_id']} --timeout 570")
    return True


def _incomplete_log(r, result, *, seconds=None) -> bool:
    if r['status'] == 'source_gone':
        return False
    settled = r['status'] not in ('starting', 'running', 'queued')
    p = LOGS_DIR / f"{r['run_id']}.log"
    p = _shown_log(p)
    if not settled:
        return _live_log_notice(r, p, result, seconds)
    size = p.stat().st_size if p.exists() else 0
    if result == 'n/a' and settled and r['mode'] != 'local':
        reason = ("another reader is fetching this run's log" if r['box_id'] and r['command_id']
                  else 'server history is unavailable')
        say(f"{r['run_id']} local log is {size} bytes; {reason}, so it couldn't be checked against the server "
            "and may be incomplete; retry")
    elif result.startswith('incomplete:'):
        say(f"{r['run_id']} local log stops at {size} bytes and the rest couldn't be fetched "
            f"({result.split(':', 1)[1]}); this output is incomplete")
    else:
        return False
    if settled:
        say(f"{r['run_id']} run ended {r['status']} exit={r['exit_code']}")
    return True


def _refresh_running_ttl(r, until=None) -> None:
    if r['status'] != 'running' or r['mode'] == 'local' or not (r['box_id'] and r['process_id']):
        return
    seconds = 5 if until is None else min(5, max(0, until - now()))
    if seconds <= 0:
        return
    try:
        with api.budget(seconds):
            box = api.get(r['box_id'])
            if box and box.get('state') in api.LIVE_STATES:
                lease.ensure_ttl(r['box_id'], RUN_TTL_S, box)
    except OffboxError:
        pass


def _validated_step_row(r, code):
    import offbox_disk_space
    if dict(r).get('mode') != 'local' and offbox_disk_space.result(_raw_log(LOGS_DIR / f"{r['run_id']}.log"), code).get('infra_failure'):
        return dict(r, status='infra', exit_code=code)
    from .runs import planned_steps
    if not planned_steps(r):
        return r
    status = r['status']
    if code is None:
        status = 'infra'
    elif status in ('done', 'failed', 'infra', 'lost'):
        status = 'done' if code == 0 else 'failed'
    return dict(r, status=status, exit_code=code)


def _follow_forwarded(r, command, *, timeout=None, follow=False) -> int:
    reason = '(reason not in the client log)'
    backend = r['error']
    source = 'Boat' if backend == 'server' else 'the home offbox server'
    try:
        with (LOGS_DIR / f"{r['run_id']}.client.log").open('rb') as stream:
            stream.seek(max(0, os.fstat(stream.fileno()).st_size - 64 * 1024))
            for line in reversed(stream.read(64 * 1024).decode(errors='replace').splitlines()):
                if backend == 'server':
                    if 'home offbox server is back; this run leaves the Boat queue' in line:
                        reason = 'home offbox server is back'
                        break
                elif 'this run goes to Boat instead' in line or 'this run is going to Boat' in line:
                    match = (re.search(r'not reachable \((.*)\); this run goes to Boat instead', line) or
                             re.search(r'home (?:offbox )?server (?:is )?(.+); this run is going to Boat', line))
                    if match:
                        reason = match[1]
                    break
    except OSError:
        pass
    say(f"{r['run_id']} moved from {source} to {backend}: {reason}")
    env = dict(os.environ, OFFBOX_BACKEND=r['error'])
    env.pop('OFFBOX_BACKGROUND_RUN', None)
    args = [sys.executable, str(Path(__file__).resolve().parents[1] / 'offbox.py'), command, r['run_id']]
    if timeout is not None:
        args += ['--timeout', str(max(0, timeout))]
    if follow:
        args += ['--follow']
    return subprocess.call(args, env=env)


def _never_started(r) -> bool:
    if r['mode'] == 'local':
        return False
    if r['status'] == 'killed':
        return not r['box_id'] and not r['process_id']
    queued_busy = r['status'] == 'busy' and r['exit_code'] == EXIT_BUSY and not r['box_id']
    if (r['status'] == 'infra' or queued_busy) and not r['command_id'] and not r['process_id']:
        error = r['error'] or ''
        if 'nothing ran' in error.lower() or (not r['box_id'] and re.match(r'^box bx_\w+ went to error:', error)):
            from . import start_check
            with contextlib.closing(db()) as con:
                return not start_check.recovery_marked(con, r)
    return (r['status'] == 'lost' and r['exit_code'] is None
            and (r['error'] == 'client ended before it got a box' or
                 (not r['box_id'] and not r['process_id'])))


def _report_never_started(r) -> int:
    from . import queue_lifecycle
    if r['status'] == 'killed':
        say(f"{r['run_id']}: killed while queued; never started; nothing ran, safe to rerun")
        say(queue_lifecycle.last_end(r['run_id']))
        return 130
    client_log = LOGS_DIR / f"{r['run_id']}.client.log"
    try:
        with client_log.open('rb') as stream:
            stream.seek(max(0, client_log.stat().st_size - 16384))
            tail = stream.read().decode(errors='replace').splitlines()[-20:]
    except OSError:
        tail = []
    code = EXIT_NOT_STARTED
    if r['status'] in ('infra', 'busy'):
        error = r['error'] or ''
        match = re.search(r'nothing ran \(exit (\d+)\)', error, re.I)
        code = r['exit_code'] if r['exit_code'] is not None else int(match[1]) if match else EXIT_INFRA
        reason = error if code == 2 else ' '.join(error.split())[:300] + '; nothing ran, safe to rerun'
        say(f"{r['run_id']}: never started: {reason}")
    else:
        guess = '' if client_log.exists() else ' (caller interrupted?)'
        say(f"{r['run_id']}: never started: the offbox client that queued it ended before it got a box"
            f"{guess}; nothing ran, safe to rerun")
    say(queue_lifecycle.last_end(r['run_id']))
    if tail:
        say(f"client log: {client_log}")
        for line in tail:
            say(line)
    return code


def logs(run_id: str, do_follow: bool) -> int:
    r = _run_row(run_id)
    _require_my_run(r)
    line = size_summary(r)
    if line:
        say(line)
    from .home_run_observation import notice
    notice(r)
    if r['status'] == 'source_gone':
        say(r['error'])
        return 2
    if r['status'] == 'forwarded':
        return _follow_forwarded(r, 'logs', follow=do_follow)
    if _never_started(r):
        return _report_never_started(r)
    p = LOGS_DIR / f"{r['run_id']}.log"
    if r['status'] == 'lost' and r['exit_code'] is None and r['box_id']:
        if do_follow:
            return _wait_locked(r, echo=True)
        from .runs import reconcile_lost
        with file_lock('box-' + r['box_id'], timeout=0):
            reconcile_lost(db(), r['box_id'])
            r = _run_row(r['run_id'])
    from . import start_check
    if do_follow and r['status'] == 'infra' and start_check.recovery_marked(db(), r):
        return _wait_locked(r, echo=True)
    if r['status'] in ('starting', 'running', 'queued'):
        if do_follow:
            return _wait_locked(r, echo=True)
        _refresh_running_ttl(r)
        started = monotonic()
        result = _catch_up_log(r, budget=10, live=True) if r['status'] == 'running' else 'n/a'
        _tail(_shown_log(p), 0, True)
        follower = read_json(LOGS_DIR / f"{r['run_id']}.follower.json", {})
        if follower:
            last = follower.get('last_write')
            age = f"{max(0, int(now() - last))} s ago" if last is not None else 'never'
            observed = follower.get('server_output_at')
            detail = f'; server output observed {max(0, int(now() - observed))} s ago' if observed is not None else ''
            if follower.get('remaining_bytes'):
                age_at_fetch = max(0, int(now() - follower['backlog_at']))
                detail += f"; at least {follower['remaining_bytes']} bytes behind at fetch {age_at_fetch} s ago"
            if follower.get('event') == 'recovery_staged':
                detail += f"; recovered {follower.get('staged_bytes', 0)} uncommitted bytes"
            say(f"follower last wrote {age}; last event: {follower.get('event', 'unknown')}{detail}")
        notified = _incomplete_log(r, result, seconds=monotonic() - started)
        if r['mode'] != 'local' and not notified:
            if not r['box_id'] or not r['process_id']:
                from .start_check import hint
                check = ('; check: ' + hint(r['box_id'], r['run_id'])) if r['box_id'] else ''
                say(f"{_not_started(r)}; no output yet. Follow it with: offbox logs {r['run_id']} --follow{check}")
            st = p.stat() if p.exists() else None
            written = time.strftime('%H:%M:%S', time.localtime(st.st_mtime)) if st else 'never'
            say(f"{r['run_id']} is still running; this local copy ({st.st_size if st else 0} bytes, last written "
                f"{written}) includes the output fetched so far. For completion, hand off "
                f"`offbox wait {r['run_id']}` using the remote-compute skill’s Waiting for a run route; "
                "end your turn and do not poll logs.")
        return 0
    from .runs import settled_steps_code, planned_steps, killed_result, report_killed
    killed = killed_result(r['run_id'], wait=r['exit_code'] is None, row=r)
    try:
        result = _catch_up_log(r, lock_wait=LOG_READ_WAIT_S)
    except OffboxError as error:
        if killed is None or not killed['process_id']:
            raise
        say(f"warning: {r['run_id']}: output after offbox kill could not be fetched ({error})")
        result = 'unavailable'
    from .pulls import footer
    footer(r['run_id'])
    from . import resources
    resources.finalize(r)
    _tail(_shown_log(p), 0, True)
    from .runs import report_interruption
    report_interruption(r)
    if killed is None:
        killed = killed_result(r['run_id'], wait=r['exit_code'] is None, row=r)
    if killed is not None and killed['process_id']:
        return report_killed(killed, p)
    code = settled_steps_code(r, r['exit_code'], catch_up=False, history_result=result)
    _report_deps_hint(r, code, p)
    _incomplete_log(_validated_step_row(r, code), result)
    if code is None:
        from .run_evidence import report
        report(dict(r), p)
    from . import native_crash
    native_crash.readback(r, code, _raw_log(p), report=True)
    from .runs import space_result
    space_result(r['run_id'], code, p, report=True)
    import offbox_disk_space
    if (offbox_disk_space.result(_raw_log(p), code).get('infra_failure') or
            read_json(LOGS_DIR / f"{r['run_id']}.state.json", {}).get('infra_failure')):
        return EXIT_INFRA
    if planned_steps(r) and code is None:
        return EXIT_INFRA
    if r['mode'] == 'bg' and not _has_data(_shown_log(p)):
        if result in ('complete', 'caught_up'):
            say(f"no output recorded for {r['run_id']} (server history checked)")
        return 1
    return 0


def wait(run_id: str, timeout: float | None, *, summary: bool = False) -> int:
    r = _run_row(run_id)
    _require_my_run(r)
    line = size_summary(r)
    if line:
        say(line)
    from .home_run_observation import notice
    notice(r)
    path = LOGS_DIR / f"{run_id}.log"
    delivered = delivered_bytes(path) if summary else 0
    from . import start_check
    from .runs import Interrupted
    unknown = r['status'] == 'infra' and start_check.recovery_marked(db(), r)
    try:
        if (r["status"] not in ("starting", "running", "lost") and not unknown) or (r['status'] == 'lost' and (r['exit_code'] is not None or not r['box_id'])):
            code = _settled(r, show_failure=True, until=None if timeout is None else now() + timeout)
        else:
            code = _wait_locked(r, echo=False, timeout=timeout, show_failure=True)
    except Interrupted as error:
        if summary:
            _wait_summary(run_id, error.code, delivered)
        raise
    if summary:
        # A forwarded wait is another CLI process on the destination backend; it prints its own summary.
        try:
            forwarded = _run_row(run_id)['status'] == 'forwarded'
        except (sqlite3.Error, OffboxError):
            forwarded = r['status'] == 'forwarded'
        if not forwarded:
            _wait_summary(run_id, code, delivered)
    if r['status'] != 'forwarded' and json.loads(dict(r).get('pulls') or '[]'):
        from .pulls import report
        report(run_id, until=None if timeout is None else now())
    return code


def _wait_summary(run_id: str, code: int, delivered: int) -> None:
    path = LOGS_DIR / f"{run_id}.log"
    out(f"{run_id}: backend={api.BACKEND} exit={code} log={path}")
    # This is optional context; a failed read must not replace the command's known exit code.
    with contextlib.suppress(sqlite3.Error), contextlib.closing(db()) as con:
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        line = size_summary(row) if row else ""
        if line:
            out(line)
    # Keep the summary and preview within the harness's completion-notification tail. Already delivered output
    # stays quiet, including failures shown by an earlier logs/follow/wait invocation.
    try:
        with path.open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            pos = max(0, size - 4096, delivered if delivered <= size else 0)
            stream.seek(pos)
            tail = stream.read(4096).decode('utf-8', errors='replace').splitlines()[-8:]
        text = '\n'.join(tail)[-640:]
        if text:
            out('Output tail:\n' + text)
            if not is_silenced(sys.stdout):
                record_delivery(path, size)
    except OSError:
        pass


def _settled(r, echo=False, pos=0, *, locked=False, until=None, show_failure=False) -> int:
    if r['status'] == 'source_gone':
        say(r['error'])
        return 2
    if r['status'] == 'forwarded':
        return _follow_forwarded(r, 'logs' if echo else 'wait', follow=echo,
                                 timeout=None if echo or until is None else until-now())
    if _never_started(r):
        return _report_never_started(r)
    from . import pulls
    from .runs import killed_result, complete_killed
    killed = killed_result(r['run_id'], wait=r['exit_code'] in (None, 137, 143), until=until, row=r)
    lost = False
    if r['status'] == 'lost' and r['exit_code'] is None:
        with contextlib.closing(db()) as con:
            lost = con.execute("SELECT 1 FROM kv WHERE k=? AND v!='fenced'",
                               (f"lost_confirmed:{r['run_id']}",)).fetchone() is not None
    if killed is None and json.loads(dict(r).get('pulls') or '[]') and (lost or (
            r['exit_code'] is not None and (r['status'] in ('done', 'failed', 'interrupted', 'killed')
                                           or dict(r).get('pull_state') in ('pending', 'running')))):
        pulls.wait(r['run_id'], until=until)
        with contextlib.closing(db()) as con:
            current = con.execute('SELECT * FROM runs WHERE run_id=?', (r['run_id'],)).fetchone()
        if current is not None and current['status'] in ('starting', 'running'):
            from .runs import finish
            finish(r['run_id'], r['exit_code'], r['status'], until=until, catch_up=False, bookkeeping=False)
        killed = killed_result(r['run_id'], wait=r['exit_code'] in (None, 137, 143), until=until, row=r)
    from .runs import repo_setup_failed, settled_steps_code, planned_steps
    budget = None if until is None else max(0, until-now())
    try:
        result = _catch_up_log(r, budget=budget, lock_wait=LOG_READ_WAIT_S)
    except OffboxError as error:
        if killed is None or not killed['process_id']:
            raise
        say(f"warning: {r['run_id']}: output after offbox kill could not be fetched ({error})")
        result = 'unavailable'
    if killed is not None and killed['process_id']:
        if echo:
            _tail_selected(LOGS_DIR / f"{r['run_id']}.log", pos, True)
        return complete_killed(killed, pulls=json.loads(dict(r).get('pulls') or '[]'), until=until)
    code = settled_steps_code(r, r['exit_code'], catch_up=False, history_result=result)
    if code is None:
        killed = killed_result(r['run_id'], wait=True, until=until, row=r)
        if killed is not None and killed['process_id']:
            return complete_killed(killed, pulls=json.loads(dict(r).get('pulls') or '[]'), until=until)
    checked = _validated_step_row(r, code)
    from . import resources
    resources.finalize(r)
    if until is not None and now() >= until:
        _incomplete_log(checked, result)
        raise _wait_timeout(checked)
    if echo:
        _tail_selected(LOGS_DIR / f"{r['run_id']}.log", pos, True)
    elif show_failure and r['mode'] == 'bg' and code not in (0, None):
        _failure_tail(LOGS_DIR / f"{r['run_id']}.log")
    if result in ('complete', 'caught_up') and r['mode'] == 'bg' and not _has_data(_shown_log(LOGS_DIR / f"{r['run_id']}.log")):
        say(f"{r['run_id']} settled with no output on record")
    else:
        _incomplete_log(checked, result)
    if repo_setup_failed(r['exit_code'], LOGS_DIR / f"{r['run_id']}.log"):
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    if r['error'] == 'box wedged before the command':
        say(f"{r['box_id']} was wedged before the command and set aside. Nothing ran: retry")
    _report_deps_hint(r, code, LOGS_DIR / f"{r['run_id']}.log")
    status = checked['status']
    if planned_steps(r) and code is not None and status in ('done', 'failed', 'infra', 'lost'):
        if (status, code) != (r['status'], r['exit_code']):
            con = db()
            try:
                con.execute("UPDATE runs SET status=?,exit_code=? WHERE run_id=? "
                            "AND status IN ('done','failed','infra','lost')", (status, code, r['run_id']))
                con.commit()
            finally:
                con.close()
    from . import native_crash
    r = native_crash.readback(checked, code, _raw_log(LOGS_DIR / f"{r['run_id']}.log"), report=True)
    if r['status'] in ('infra', 'killed'):
        status = r['status']
    if not echo and code == 0:
        resources.display(r['run_id'])
    from .runs import report_interruption
    report_interruption(r)
    line = size_summary(r)
    if line:
        out(line)
    out(f"{r['run_id']}: {status} exit={code}" + resources.failure_suffix(r['run_id'], code))
    if code is None:
        from .run_evidence import report
        report(dict(r), LOGS_DIR / f"{r['run_id']}.log", until=until)
    if code is None and r['box_id']:
        from .start_check import hint
        say(r['error'] or f"exit unknown; check: {hint(r['box_id'], r['run_id'])}")
    from .runs import space_result
    effective = space_result(r['run_id'], code, report=True) if r['mode'] != 'local' else code
    pulls.footer(r['run_id'])
    return effective if effective is not None else 90


def _failure_tail(path) -> None:
    path, received_bytes = _display_log(path)
    # Repeated waits and waits after a follower must not replay output already delivered by another invocation.
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    delivered = delivered_bytes(path)
    delivered = delivered if delivered <= size else 0
    if delivered < received_bytes:
        # Keep the received source's own tail visible when the recovered copy is much larger.
        _tail(path, max(delivered, received_bytes - 16384), True, limit=received_bytes)
        delivered = delivered_bytes(path)
    pos = max(0, size - 16384, delivered if delivered <= size else 0)
    _tail(path, pos, True, limit=size)


def _tail_selected(path, pos: int, echo: bool) -> int:
    # The fallback copy has its own layout and delivery cursor, independent of the checkpointed log.
    selected = _shown_log(path)
    return _tail(selected, pos if selected == path else delivered_bytes(selected), echo)


def _tail(path, pos: int, echo: bool, limit: int | None = None) -> int:
    """Consume the holder's local log from `pos`, up to `limit` bytes when given (the committed length: bytes past it
    are not yet checkpointed and must not be printed). Prints only when echoing. Returns the new position."""
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    echo = echo and not is_silenced(sys.stdout)
    delivered = 0
    try:
        with open(path, 'rb') as f:
            f.seek(pos)
            while limit is None or pos < limit:
                data = f.read(64 * 1024 if limit is None else min(64 * 1024, limit - pos))
                if not data:
                    break
                if echo:
                    try:
                        stream = getattr(sys.stdout, 'buffer', None)
                        if stream is not None:
                            stream.write(data)
                            stream.flush()
                        else:
                            sys.stdout.write(decoder.decode(data))
                            sys.stdout.flush()
                        delivered = pos + len(data)
                    except (OSError, ValueError):
                        silence(sys.stdout)
                        echo = False
                pos += len(data)
            if echo and getattr(sys.stdout, 'buffer', None) is None:
                try:
                    sys.stdout.write(decoder.decode(b'', final=True))
                    sys.stdout.flush()
                except (OSError, ValueError):
                    silence(sys.stdout)
    except OSError:
        pass
    if delivered:
        record_delivery(path, delivered)
    return pos


def _truncate(path, size: int) -> None:
    """Cut a local log back to its committed length (a holder died after writing a chunk but before committing it)."""
    from .runs import log_lock
    with log_lock(Path(path).stem):
        try:
            if os.path.getsize(path) > size:
                with open(path, "r+b") as f:
                    f.truncate(size)
        except OSError:
            pass


def _wait_locked(r, echo, timeout=None, *, show_failure=False):
    """A foreground `offbox run` holds its box lock until it has recorded the run's end, so while another process
    holds the lock, poll the run row (and tail the local log) instead of failing on the lock.
    `pos` is the local-log byte count already delivered (printed when echoing). While the run may still be taken
    over, only checkpointed bytes are delivered (see runs.follow): a takeover replays everything past the checkpoint,
    and a log with no checkpoint at all (a holder from before checkpoints) is replayed whole into an emptied log."""
    from .runs import _ended, reconcile_lost
    deadline = None if timeout is None else now() + timeout
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    if r['status'] == 'lost' and r['exit_code'] is not None:
        return _settled(r, echo=echo, until=deadline, show_failure=show_failure)
    from . import start_check
    if start_check.recovery_marked(db(), r) and not start_check.api_pid(db(), r):
        r = _wait_start_receipt(r, deadline)
    if r['status'] != 'lost':
        r = _wait_for_start(r, deadline)
    if (r['status'] == 'lost' and db().execute(
            "SELECT 1 FROM kv WHERE k=? AND v='fenced'", (f"lost_confirmed:{r['run_id']}",)).fetchone()):
        return _settled(r, echo=echo, until=deadline, show_failure=show_failure)
    if r['status'] not in ('starting', 'running', 'lost') or not r['box_id']:
        return _settled(r, echo=echo, until=deadline, show_failure=show_failure)
    _refresh_running_ttl(r, deadline)
    pos, said = 0, False
    polled, ended_at = None, None
    # The row we poll: refreshed each loop, so a PID the holder records later (it starts with NULL) is picked up.
    probe_pid, last_size = None, -1
    while True:
        guard = file_lock('box-' + r['box_id'], timeout=0)
        try:
            guard.__enter__()
        except OffboxError:
            pass
        else:
            try:
                budget = 20 if deadline is None else min(20, max(0, deadline - now()))
                reconcile_lost(db(), r['box_id'], timeout=budget, until=deadline)
                if deadline is not None and now() >= deadline:
                    raise _wait_timeout(r)
                cur = _run_row(r['run_id'])
                if cur['box_id'] != r['box_id']:
                    # A background disk retry keeps the run id but changes its box. Drop the old box lock first.
                    guard.__exit__(None, None, None)
                    guard = contextlib.nullcontext()
                    return _wait_locked(cur, echo, None if deadline is None else max(0,deadline-now()),
                                        show_failure=show_failure)
                if cur['status'] not in ('starting', 'running'):
                    # The holder wrote its last output, recorded the end and released the lock between two polls.
                    # Nothing will be replayed now, so drain the whole rest of the log.
                    return _settled(cur, echo=echo, pos=pos, locked=True, until=deadline, show_failure=show_failure)
                ck = checkpoint(log_path)
                # Nothing below may touch the original log before the replay is confirmed. A deadline that has already
                # passed ends the wait here, with the log and its checkpoint exactly as they were.
                if deadline is not None and now() >= deadline:
                    raise OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was "
                                      f"stopped). Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)
                # `ck is not None` is the validity test; a checkpoint at zero bytes is valid and committed.
                if ck is not None:
                    _tail(log_path, pos, echo, ck["logBytes"])
                    start = (ck["stdoutOffset"], ck["stderrOffset"])
                    keep = ck["logBytes"]
                else:
                    # Its bytes can't be mapped to stream offsets and none were delivered: replay the run from the start.
                    start, keep = (0, 0), 0
                return _replay_takeover(cur, echo, deadline, start, log_path, keep, has_checkpoint=ck is not None,
                                        show_failure=show_failure)
            finally:
                guard.__exit__(None, None, None)
        ck = checkpoint(log_path)
        if ck:
            pos = _tail(log_path, pos, echo, ck["logBytes"])
        cur = _run_row(r['run_id'])
        if dict(cur).get('pull_state') == 'running':
            from .pulls import wait
            wait(cur['run_id'], until=deadline)
            cur = _run_row(r['run_id'])
        if cur['box_id'] != r['box_id']:
            return _wait_locked(cur, echo, None if deadline is None else max(0,deadline-now()),
                                show_failure=show_failure)
        if cur['status'] not in ('starting', 'running', 'lost') or (cur['status'] == 'lost' and (
                cur['exit_code'] is not None or db().execute(
                    'SELECT 1 FROM kv WHERE k=?', (f"lost_confirmed:{cur['run_id']}",)).fetchone())):
            # Settled: nothing will be replayed, so drain the whole rest of the log.
            return _settled(cur, echo=echo, pos=pos, until=deadline, show_failure=show_failure)
        if deadline is not None and now() >= deadline:
            raise OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was stopped). "
                              f"Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)
        # Output still arriving means the holder is alive and following: the grace restarts with each new byte.
        size = os.path.getsize(log_path) if os.path.exists(log_path) else 0
        if size != last_size:
            last_size, ended_at = size, None
        if cur['process_id'] != probe_pid:
            probe_pid, polled, ended_at = cur['process_id'], None, None
        if cur['process_id'] and (polled is None or now() - polled >= STATUS_POLL_S):
            polled = now()
            st = _ended(cur['box_id'], cur['process_id'], deadline, cur['run_id'])
            # The deadline may pass during the status request: such an answer is not accepted (--timeout is 124).
            if deadline is not None and now() >= deadline:
                raise OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was "
                                  f"stopped). Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)
            # Output that arrived during the status request is progress too: re-read the log before deciding.
            grown = os.path.getsize(log_path) if os.path.exists(log_path) else 0
            if grown != last_size:
                last_size, ended_at = grown, None
            else:
                ended_at = (ended_at or now()) if st else None
            if st and ended_at is not None and now() - ended_at >= _grace(cur):
                return _holder_stuck(cur, st, log_path, pos, echo, deadline, show_failure=show_failure)
        if not said:
            say(f"{r['run_id']} is still followed by another offbox process (its own `offbox run` or another wait); "
                f"waiting for it to record the end")
            said = True
        pause = WAIT_POLL_S if deadline is None else max(0.0, min(WAIT_POLL_S, deadline - now()))
        time.sleep(pause)


def _grace(r) -> int:
    try:
        pulls = json.loads(r["pulls"] or "[]")
    except (ValueError, TypeError):
        pulls = []
    return PULL_GRACE_S if pulls else HOLDER_GRACE_S


def _holder_stuck(r, st, log_path, pos: int, echo: bool, deadline=None, *, show_failure=False) -> int:
    """boat says the process ended, but the client holding the box lock never recorded it. Report boat's exit code
    instead of waiting on that client for ever. The row is left to its holder (or the reaper once the holder is gone).
    A lost process's recovery reads the box, so it is bounded by the caller's deadline like the rest of the wait."""
    from .runs import _status_code, settled_steps_code, interruption_info, interruption_message
    code, how = _status_code(st), "boat's process status"
    from .runs import killed_result, complete_killed
    killed = killed_result(r['run_id'], wait=code in (None, 137, 143), until=deadline, row=r, known_code=code)
    if killed is not None and killed['process_id']:
        _tail_selected(log_path, pos, echo)
        return complete_killed(killed, log_path, pulls=json.loads(r['pulls'] or '[]'), until=deadline)
    if code is None:
        code, how = _recover_by(r, log_path, deadline)
    receipt_code = code
    if json.loads(r['pulls'] or '[]'):
        from .pulls import wait
        wait(r['run_id'], until=deadline)
    killed = killed_result(r['run_id'], wait=code is None, until=deadline, row=r, known_code=code)
    if killed is not None and killed['process_id']:
        _tail_selected(log_path, pos, echo)
        return complete_killed(killed, log_path, pulls=json.loads(r['pulls'] or '[]'), until=deadline)
    code = settled_steps_code(r, code, log_path=log_path, until=deadline)
    _report_deps_hint(r, code, log_path)
    from . import resources
    resources.finalize(r)
    _tail_selected(log_path, pos, echo)
    failure = show_failure and not echo and r['mode'] == 'bg' and code not in (0, None)
    if failure:
        _failure_tail(log_path)
    if st.get('status') == 'interrupted':
        say(interruption_message(r['run_id'], interruption_info(st) or {}))
    say(f"{r['run_id']} ended on {r['box_id']} over {_grace(r)}s ago, but the offbox process following it has not "
        f"recorded the end (it looks stuck); exit {code} taken from {how}. Full output: offbox logs {r['run_id']}")
    out(f"{r['run_id']}: {'failed ' if failure else ''}exit={code}" + resources.failure_suffix(r['run_id'], code))
    if code is None:
        from .run_evidence import report
        report(dict(r), log_path, until=deadline, receipt_code=receipt_code)
        say(f"exit unknown; inspect with offbox ssh {r['box_id']}")
    from .runs import space_result
    from . import native_crash
    native_crash.readback(r, code, _raw_log(log_path), report=True)
    effective = space_result(r['run_id'], code, log_path, report=True)
    return 90 if effective is None else effective


def _recover_by(r, log_path, deadline):
    """recover_lost_exit for a wait: the box read gets only what is left of the caller's deadline (20 s without one),
    and an answer that arrives at or past the deadline is not accepted, so nothing is published or settled from it
    (--timeout is 124 and the run is left alone)."""
    from .runs import recover_lost_exit, planned_steps, killed_result
    killed = killed_result(r['run_id'], wait=True, until=deadline, row=r)
    if killed is not None and killed['process_id']:
        return killed['exit_code'], 'offbox kill'
    budget = 20.0 if deadline is None else deadline - now()
    if budget <= 0:
        raise _wait_timeout(r)
    try:
        code, how = recover_lost_exit(r["box_id"], r["run_id"], log_path, planned_steps(r), timeout=min(20.0, budget))
    except OffboxError:
        if deadline is not None and now() >= deadline:
            raise _wait_timeout(r) from None
        killed = killed_result(r['run_id'], wait=True, until=deadline, row=r)
        if killed is not None and killed['process_id']:
            return killed['exit_code'], 'offbox kill'
        raise
    if deadline is not None and now() >= deadline:
        raise _wait_timeout(r)
    return code, how


def _wait_timeout(r) -> OffboxError:
    if dict(r).get('pull_state') == 'running':
        from .pulls import report
        report(r['run_id'], until=now())
    if r['status'] not in ('starting', 'running'):
        return OffboxError(f"--timeout reached while reading {r['run_id']}'s log; run ended "
                           f"{r['status']} exit={r['exit_code']}. Retry: offbox wait {r['run_id']}",
                           code=EXIT_WAIT_TIMEOUT)
    return OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was stopped). "
                       f"Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)


def _failover_queued(r):
    from . import common
    if common.backend() != 'boat' or r['status'] != 'starting' or r['box_id'] or r['process_id']:
        return False
    with contextlib.closing(db()) as con:
        return con.execute('SELECT 1 FROM kv WHERE k=?', ('failover_queue:' + r['run_id'],)).fetchone() is not None


def _not_started(r) -> str:
    if r['mode'] == 'local':
        return f"{r['run_id']} runs on this Mac (local fallback), not on a box"
    if _failover_queued(r):
        return f"{r['run_id']} queued on Boat, waiting for a box or home"
    if not r['box_id']:
        return f"{r['run_id']} has no box yet (queued for a pool box)"
    return f"{r['run_id']} has {r['box_id']} but its command hasn't started yet"


def _pid_started_at(pid: int) -> float | None:
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=10,
                             env=dict(os.environ, LC_ALL="C")).stdout.strip()
        return time.mktime(time.strptime(" ".join(out.split()), "%a %b %d %H:%M:%S %Y")) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _client_alive(pid: int | None, start_at: float | None, *, reaper_run=None) -> bool:
    """Is the `offbox run` that inserted this row still running? Unknown (no pid recorded) counts as alive.
    A live pid that started after the run did is a reused pid, so the client is gone."""
    alive, check, began = _client_check(pid, start_at)
    if not alive and reaper_run:
        with contextlib.suppress(Exception):
            age = f'{now() - start_at:.3f}' if start_at is not None else 'unknown'
            log(f"reaper no-box run {reaper_run} client_pid={pid} check={check} "
                f"age_s={age} row_start_at={start_at} observed_start_at={began}")
    return alive


def _client_check(pid, start_at):
    if not pid:
        return True, 'no_pid', None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False, 'pid_missing', None
    except PermissionError:
        pass
    began = _pid_started_at(pid)
    alive = began is None or start_at is None or began <= start_at + 2
    check = 'identity_unavailable' if began is None or start_at is None else 'alive' if alive else 'pid_reused'
    return alive, check, began


def _wait_start_receipt(row, deadline, *, locked=False):
    """Recover a dead client's unrecorded start under the same lock as run/reap."""
    from . import start_check
    con = db()
    while True:
        if deadline is not None and now() >= deadline:
            raise _wait_timeout(row)
        try:
            guard = contextlib.nullcontext() if locked else file_lock('box-' + row['box_id'], timeout=0)
            guard.__enter__()
        except OffboxError:
            pass
        else:
            try:
                row = _run_row(row['run_id'])
                if row['status'] not in ('starting', 'running') and not (
                        row['status'] == 'infra' and start_check.recovery_marked(con, row)):
                    return row
                if start_check.api_pid(con, row):
                    return row
                budget = start_check.SSH_TIMEOUT_S if deadline is None else min(start_check.SSH_TIMEOUT_S, max(0, deadline-now()))
                result = start_check.check(row['box_id'], row['run_id'],
                                           claim=start_check.claims_enabled(con, row['run_id']), timeout=budget)
                if deadline is not None and now() >= deadline:
                    raise _wait_timeout(row)
                if result.code is not None or result.verdict == 'fenced':
                    start_check.settle(con, row, result, 'client ended before the command was recorded as started', until=deadline)
                    say(f"{row['run_id']} on {row['box_id']}: "
                        + (f"ran, exit {result.code}; live output unavailable" if result.code is not None
                           else 'never started, nothing ran') + '; ' + start_check.hint(row['box_id'], row['run_id'], result.pid))
                    return _run_row(row['run_id'])
                if result.verdict == 'unknown':
                    start_check.settle(con, row, result, 'client ended before the command was recorded as started')
                    raise OffboxError(f"{row['run_id']} on {row['box_id']}: start unknown; offbox reap or check: "
                                      + start_check.hint(row['box_id'], row['run_id']), started=True,
                                      run_id=row['run_id'], box=row['box_id'])
                start_check.remember_wrapper(con, row, result.pid)
                con.execute("UPDATE runs SET status='running' WHERE run_id=?", (row['run_id'],))
                con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f"start_unattached:{row['run_id']}", '1'))
                con.commit()
            finally:
                guard.__exit__(None, None, None)
        time.sleep(WAIT_POLL_S if deadline is None else max(0, min(WAIT_POLL_S, deadline-now())))


def _wait_for_start(r, deadline):
    """Poll a run row until it has a box and a started command (box_id and process_id), or settles; return that row.
    A run queued for a pool box has no box_id, and one still syncing has no process_id: there is no box lock to
    take and no process to attach to yet (31 Oct: `wait` crashed on 'box-' + None while a run waited for its pool)."""
    said = None
    while True:
        cur = _run_row(r['run_id'])
        from . import start_check
        if cur['status'] not in ('starting', 'running') or (cur['box_id'] and start_check.api_pid(db(), cur)):
            return cur
        pid = cur['client_pid'] if 'client_pid' in cur.keys() else None
        if start_check.recovery_marked(db(), cur) and cur['box_id']:
            return _wait_start_receipt(cur, deadline)
        if not _client_alive(pid, cur['start_at']):
            if not cur['box_id']:
                con = db()
                con.execute("UPDATE runs SET status='lost', end_at=?, error=? WHERE run_id=? AND box_id IS NULL "
                            "AND status IN ('starting','running') AND client_pid IS ? AND start_at IS ?",
                            (now(), "client ended before it got a box", cur['run_id'], pid, cur['start_at']))
                con.commit()
                continue
            return _wait_start_receipt(cur, deadline)
        if deadline is not None and now() >= deadline:
            raise OffboxError(f"--timeout reached; {_not_started(cur)} (nothing was stopped). "
                              f"Wait again: offbox wait {cur['run_id']}", code=EXIT_WAIT_TIMEOUT)
        msg = f"{_not_started(cur)}; " + ("waiting for it to end" if cur['mode'] == 'local' else
                                          "waiting for a box" if not cur['box_id'] else "waiting for it to start")
        if msg != said:
            say(msg)
            said = msg
        pause = WAIT_POLL_S if deadline is None else max(0.0, min(WAIT_POLL_S, deadline - now()))
        time.sleep(pause)


def _has_data(log_path) -> bool:
    """Pull receipts alone aren't command output. Legacy command bytes still require confirmed replay."""
    try:
        with open(log_path, 'rb') as stream:
            prefix = stream.read(256)
        marker = f'\n[offbox {Path(log_path).stem} pulls]\n'.encode()
        return bool(prefix) and not prefix.startswith(marker)
    except OSError:
        return False


def _replay_takeover(cur, echo, deadline, start, log_path, keep, has_checkpoint=False, *, show_failure=False):
    """Take over a run's follow without touching the original local log until the replay is confirmed.

    The temp file beside the log starts as the committed prefix (`keep` bytes); the replay appends the bytes the remote
    run still produces. It replaces the original log and checkpoint only when the replay ends with a real exit code.
    A deadline, a lost stream (unknown exit) or any error removes the temp files and keeps the original."""
    from .runs import log_lock
    with log_lock(cur['run_id'], until=deadline):
        from .live_logs import note
        note(cur['run_id'], 'takeover')
        ck = checkpoint(log_path)
        if ck is not None:
            start, keep = (ck['stdoutOffset'], ck['stderrOffset']), ck['logBytes']
            has_checkpoint = True
        return _replay_takeover_locked(cur, echo, deadline, start, log_path, keep, has_checkpoint,
                                        show_failure=show_failure)


def _replay_takeover_locked(cur, echo, deadline, start, log_path, keep, has_checkpoint, *, show_failure=False):
    tmp = log_path.with_name(log_path.name + ".takeover")
    tmp_ck = offsets_path(tmp)
    try:
        prefix = b""
        if keep:
            with open(log_path, "rb") as src:
                prefix = src.read(keep)
        with open(tmp, "wb") as dst:
            dst.write(prefix)
        # The replay's follow commits checkpoints into tmp: it starts at the committed prefix, then tracks the stream.
        # Mirroring makes new output visible to a lock-blocked follower of the original log. It is safe when the
        # original has a committed length (`has_checkpoint`), or when it holds no data at all (absent or empty, so the
        # mirror creates it). A nonempty log with no checkpoint (a legacy holder) is never written in place.
        mirror = log_path if (has_checkpoint or not _has_data(log_path)) else None
        code = _resolve_exit(cur, log_path, deadline, start, tmp, echo=echo, mirror_path=mirror, mirror_keep=keep)
        if code is None:
            confirmed = db().execute('SELECT 1 FROM kv WHERE k=?', (f"lost_confirmed:{cur['run_id']}",)).fetchone()
            if confirmed:
                tmp.unlink(missing_ok=True)
                tmp_ck.unlink(missing_ok=True)
                return _finalize(cur, code, log_path, until=deadline, echo=echo, show_failure=show_failure)
            raise OffboxError(f"takeover of {cur['run_id']} ended without a known exit; the original log is kept")
        # Publish the replacement log and checkpoint before the run is recorded as settled.
        os.replace(tmp, log_path)
        if os.path.exists(tmp_ck):
            os.replace(tmp_ck, offsets_path(log_path))
        return _finalize(cur, code, log_path, until=deadline, echo=echo, show_failure=show_failure)
    except BaseException:
        for p in (tmp, tmp_ck):
            try:
                os.remove(p)
            except OSError:
                pass
        raise


def _resolve_exit(r, log_path, until, start_offsets, replay_path, echo=True, mirror_path=None, mirror_keep=0):
    """Attach and follow the run to its end. Returns the real exit code, or None when the outcome is unknown (the
    stream was lost and no exit could be recovered). Nothing is recorded here: the caller decides what to publish.
    `echo` is the caller's choice: a quiet exit-code wait does not print the remote output. `mirror_path` (a takeover
    only) receives every committed chunk too, so a concurrent follower of the original log sees the output live."""
    from .runs import Interrupted, finish, follow, killed_result
    killed = killed_result(r['run_id'], row=r)
    if killed is not None and killed['process_id']:
        return killed['exit_code']
    try:
        code = follow(r["box_id"], r["process_id"], log_path, echo=echo, run_id=r["run_id"], until=until,
                      start_offsets=start_offsets, replay_path=replay_path, mirror_path=mirror_path,
                      mirror_keep=mirror_keep, receipt_locked=True)
    except Interrupted as e:
        # Final on the server: the run will not go on. Recorded here so a later wait answers at once.
        from .runs import remember_interruption
        remember_interruption(r['run_id'], {'interruption': e.interruption}, until=until)
        if json.loads(r['pulls'] or '[]'):
            from .runs import save_run_state
            save_run_state(r['run_id'], until=until, status='interrupted', exit_code=e.code)
            from .pulls import wait
            wait(r['run_id'], until=until)
        code = finish(r["run_id"], e.code, "interrupted", until=until)
        if code is None:
            raise OffboxError(f"{r['run_id']}: steps incomplete after the interruption; remote exit unknown",
                              code=EXIT_INFRA, started=True) from None
        raise
    except OffboxError:
        killed = killed_result(r['run_id'], wait=True, until=until, row=r)
        if killed is None or not killed['process_id']:
            raise
        return killed['exit_code']
    if code is None:
        killed = killed_result(r['run_id'], wait=True, until=until, row=r)
        if killed is not None and killed['process_id']:
            return killed['exit_code']
        code, how = _recover_by(r, log_path, until)
        if code is not None:
            say(f"boat lost track of the remote process after it ended; exit {code} taken from {how}")
    return code


def _report_deps_hint(r, code, log_path) -> None:
    from .runs import box_deps_hint, report_box_hint, step_results
    results = step_results(_raw_log(log_path))
    if code not in (0, None) or any(rc != 0 for _, rc in results):
        hint = box_deps_hint(Path(r['repo_root'] or '.'), log_path)
        report_box_hint(code, results, hint)


def _finalize(r, code, log_path, until=None, *, echo=False, show_failure=False) -> int:
    """Record a known end: pulls, the settled row (finish), std-tree hint and the exit line. Only after the log that
    describes this run is in its final place, so a concurrent follower never sees 'settled' with an old log."""
    from .runs import (finish, go_std_glitch, repo_setup_failed,
                       settle_box_wedged, wedged_message, settled_steps_code)
    show_failure = show_failure and not echo and dict(r).get('mode') == 'bg'
    receipt_code = code
    delivered = delivered_bytes(log_path)
    try:
        if delivered > os.path.getsize(log_path):
            delivered = 0
    except OSError:
        delivered = 0
    if repo_setup_failed(code, log_path):
        finish(r['run_id'], EXIT_INFRA, 'infra', until=until)
        if echo:
            _tail_selected(log_path, delivered, True)
        elif show_failure:
            _failure_tail(log_path)
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    from .runs import state_warning
    quarantine_pending = code == 97
    failure_tail_shown = False
    try:
        from .runs import killed_result, complete_killed
        killed = killed_result(r['run_id'], wait=True, until=until, row=r, known_code=code) if code in (None, 137, 143) else None
        if killed is not None and killed['process_id']:
            _tail_selected(log_path, delivered, echo)
            return complete_killed(killed, log_path, pulls=json.loads(r['pulls'] or '[]'), until=until)
        con = db()
        with contextlib.nullcontext() if until is None else api.budget(max(0, until-now())):
            wedged = settle_box_wedged(con, r, code)
        quarantine_pending = False
        if wedged:
            if show_failure:
                _failure_tail(log_path)
            say(wedged_message(r['box_id'], *wedged))
            return EXIT_INFRA
        if json.loads(r['pulls'] or '[]'):
            from .pulls import wait
            wait(r['run_id'], until=until)
        if until is not None and now() >= until:
            raise _wait_timeout(r)
        from .runs import killed_result, report_killed
        killed = killed_result(r['run_id'], wait=True, until=until, row=r, known_code=code) if code in (None, 137, 143) else None
        if killed is not None and killed['process_id']:
            _tail_selected(log_path, delivered, echo)
            return report_killed(killed, log_path)
        code = settled_steps_code(r, code, log_path=log_path, locked=True, until=until,
                                  report_start_failure=False)
        code = finish(r['run_id'], code, until=until, report=True, run=r)
        killed = killed_result(r['run_id'], row=r, known_code=code) if code in (None, 137, 143) else None
        if killed is not None and killed['process_id']:
            return report_killed(killed, log_path)
        if dict(r).get('mode') == 'bg' and not _has_data(log_path):
            settled = _run_row(r['run_id'])
            result = _catch_up_log(settled, budget=None if until is None else max(0, until-now()),
                                   lock_wait=LOG_READ_WAIT_S)
            if result in ('complete', 'caught_up') and not _has_data(log_path):
                say(f"{r['run_id']} settled with no output on record")
            else:
                _incomplete_log(settled, result)
            from . import native_crash
            native_crash.readback(settled, code, _raw_log(log_path), report=True)
        if until is not None and now() >= until:
            raise _wait_timeout(_run_row(r['run_id']))
        # Catch-up must also drain bytes whose stream echo failed before recording later bytes as delivered.
        if echo:
            _tail_selected(log_path, delivered, True)
        elif show_failure and code not in (0, None):
            _failure_tail(log_path)
            failure_tail_shown = True
        go_std_glitch(r["box_id"], r["run_id"], log_path, code)
        _report_deps_hint(r, code, log_path)
    except sqlite3.Error as error:
        if not quarantine_pending:
            code = finish(r['run_id'], code, until=until, run=r)
        state_warning(r['run_id'], code, error)
    failure = show_failure and code not in (0, None)
    if failure and not failure_tail_shown:
        _failure_tail(log_path)
    from . import resources
    resources.finalize(r)
    if not echo and code == 0:
        resources.display(r['run_id'])
    line = size_summary(r)
    if line:
        out(line)
    out(f"{r['run_id']}: {'failed ' if failure else ''}exit={code}" + resources.failure_suffix(r['run_id'], code))
    if code is None:
        from .run_evidence import report
        report(dict(r), log_path, until=until, receipt_code=receipt_code)
        say(f"exit unknown; inspect with offbox ssh {r['box_id']}")
    from .runs import space_result
    effective = space_result(r['run_id'], code, log_path, report=True)
    from . import pulls
    pulls.footer(r['run_id'])
    return 90 if effective is None else effective


def _wait_run(r, echo, until=None, start_offsets=(0, 0), replay_path=None, *, show_failure=False):
    """Non-takeover wait (the lock was free, or this process holds it): follow, then record the end."""
    if r['status'] not in ('starting','running'):
        return _settled(r, echo=echo, locked=True, until=until, show_failure=show_failure)
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    code = _resolve_exit(r, log_path, until, start_offsets, replay_path, echo=echo)
    return _finalize(r, code, log_path, until=until, echo=echo, show_failure=show_failure)


def stats(days: float, as_json: bool) -> None:
    """`offbox stats`: what runs actually use, from the server's per-run cgroup numbers (wall, cores, memory peak,
    memory waits). Use it to pick sizes and to see when the server needs more RAM or a second box."""
    if api.BACKEND != "server":
        raise OffboxError("offbox stats needs the offbox server backend", code=2)
    d = api.call("GET", f"/stats?days={days:g}")
    if as_json:
        print(json.dumps(d, indent=1))
        return
    h = d.get("host") or {}
    gb = 2 ** 30
    print(f"last {d['days']:g} days: {d['runs']} runs, {d['memory_waits']} waited for memory "
          f"({d['memory_wait_pct']}%; add RAM above 1%)")
    if h.get("n"):
        print(f"host: cpu busy avg {100 * (h.get('cpu') or 0):.0f}%, cpu pressure avg {h.get('psi_cpu_avg') or 0:.1f}% "
              f"max {h.get('psi_cpu_max') or 0:.0f}% (2nd box above 20% sustained), min free mem "
              f"{(h.get('mem_min') or 0) / gb:.0f} GB, most runs at once {h.get('run_max')}, most queued "
              f"{h.get('q_max')}, min disk free {(h.get('disk_min') or 0) / gb:.0f} GB")
    print(f"{'repo kind':<44} {'runs':>5} {'wall p50/p95':>14} {'cores p50/p95':>14} {'mem GB p50/p95':>15} {'oom':>4}")
    for k in d.get("kinds") or []:
        w50, w95 = k.get("wall_p50_s") or 0, k.get("wall_p95_s") or 0
        print(f"{k['kind'][:44]:<44} {k['runs']:>5} {w50:>6.0f}s/{w95:>5.0f}s {k['cores_p50']:>6.1f}/{k['cores_p95']:<6.1f} "
              f"{k['mem_p50_gb']:>7.1f}/{k['mem_p95_gb']:<6.1f} {k['oom_kills']:>4}")


def run_events(run_id, as_json=False):
    with contextlib.closing(db()) as con:
        run = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        if run is None:
            run = con.execute('SELECT * FROM runs WHERE run_id LIKE ?', ('%' + run_id,)).fetchone()
        if run is None:
            raise OffboxError(f'no run {run_id}', code=2)
        require_mine(con, run['box_id'])
        run_id = run['run_id']
        rows = [dict(r) for r in con.execute("SELECT * FROM events WHERE "
                "CASE WHEN json_valid(detail) THEN json_extract(detail,'$.run_id')=? "
                "OR json_extract(detail,'$.old_run_id')=? OR json_extract(detail,'$.new_run_id')=? "
                "OR json_extract(detail,'$.caller.run_id')=? "
                "ELSE detail LIKE ? END ORDER BY ts", (run_id, run_id, run_id, run_id, run_id + ' %'))]
    if as_json:
        print(json.dumps(rows))
    else:
        for r in rows:
            print(f"{iso(r['ts'])} {r['kind']} {r['box_id'] or '-'} {r['detail']}")
