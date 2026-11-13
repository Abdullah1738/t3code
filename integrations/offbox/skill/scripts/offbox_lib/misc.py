"""Small commands: local exemptions, list, release, ssh, ports, status, logs, wait."""

from __future__ import annotations

import codecs
import contextlib
import json
import os
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

from . import api, capacity, lease, outage, pool, ssh_sync
from .common import (BOX_WEDGED_NOTE, CAP_PATH, DEAD_MOUNT_NOTE, EXEMPTIONS, EXIT_INFRA, EXIT_WAIT_TIMEOUT, LOGS_DIR, RUN_TTL_S, TOO_BIG_NOTE,
                     OffboxError, ago, atomic_write_json, checkpoint, db, event, file_lock, iso, month_key, now,
                     offsets_path, out, read_json, require_mine, say, silence)
from .common import mine as token_mine  # release() has its own `mine` flag
from .identity import require_proven

WAIT_POLL_S = 5
KILL_CONFIRM_S = 40
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
    event(db(), None, "exemption_add", f"session={ses} thread={me.get('thread')} ttl={secs}s reason={reason[:200]}")
    print(f"exempt until {iso(e['expires_at'])} (session {ses}). Heavy work still competes with Abdullah's Mac: "
          f"prefer offbox run when you can.")


def list_leases(me: dict, show_all: bool, as_json: bool) -> None:
    con = db()
    capacity.schema(con)
    if show_all:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') ORDER BY last_used_at DESC").fetchall()
    else:
        # The caller's own leases are selected by owner. An unproven caller's owner string is shared, so it sees none.
        require_proven(me, "list")
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') AND (owner=? OR box_id IN "
                           "(SELECT box_id FROM pool_callers WHERE owner=?)) ORDER BY last_used_at DESC",
                           (me['owner'], me['owner'])).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["active_runs"] = lease.active_runs(con, r["box_id"])
        out.append(d)
    if as_json:
        print(json.dumps(out, indent=1))
        return
    if not out:
        print("no leases" + ("" if show_all else " for this thread (use --all)"))
    for d in out:
        pin = " pinned" if (d.get("pinned_until") or 0) > now() else ""
        note = f"  [{d['note']}]" if (d.get("note") or "").startswith((TOO_BIG_NOTE, DEAD_MOUNT_NOTE, BOX_WEDGED_NOTE)) else ""
        print(f"{d['box_id']:<12} {d['state']:<8} {d['size'] or '':<8} {d['repo_key']:<24} used {ago(d['last_used_at']):>6} "
              f"ago runs:{d['active_runs']}{pin}{note}  {d['source'] or ''}  {(d['thread_title'] or d['owner'])[:40]}")


def release(me: dict, box_id: str | None, mine: bool, delete: bool) -> None:
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
        if _report_prune_hold(con, r["box_id"]):
            continue
        # A foreground run holds box-<id> while it streams, so a hung run shows up as a lock timeout. Name the active
        # runs on that path too; the recheck under the lock still decides before any mutation.
        try:
            with file_lock('box-'+r['box_id'], timeout=1):
                _release_one(con, r, delete)
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
    ids = [x[0] for x in con.execute("SELECT run_id FROM runs WHERE box_id=? AND status IN ('starting','running') "
                                     "ORDER BY start_at", (box_id,))]
    if not ids:
        return False
    where = " (the box lock is held by a live client)" if lock_held else ""
    say(f"{box_id}: run in progress, not released{where}: {', '.join(ids)}. If it is hung, stop it with "
        "`offbox kill <run>` and release again.")
    return True


def _release_one(con, r, delete):
        if _report_prune_hold(con, r["box_id"]):
            return
        if lease.active_runs(con, r["box_id"]):
            _report_active_runs(con, r["box_id"])
            return
        if delete:
            lease.delete_box(con, r["box_id"], "release --delete")
            print(f"deleted {r['box_id']}")
        else:
            if r["state"] in ("running", "resume_stalled"):
                lease.stop_box(con, r["box_id"], "release")
            if r['state'] == 'resume_stalled':
                print(f"stop requested for {r['box_id']} (disk kept; remains set aside)")
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
                                  "AND (box_id IS NULL OR (COALESCE(error,'')='' AND command_id IS NULL "
                                  "AND NOT EXISTS (SELECT 1 FROM kv WHERE k IN (?,?,?))))"
                                  + (" AND box_id IS NULL" if not r["box_id"] else ""),
                                  (now(), error, rid, *start_keys)).rowcount
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
    if r["status"] not in ("starting", "running"):
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
    if not start_check.api_pid(con, r) and start_check.recovery_marked(con, r) and r['box_id']:
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
    box, pid = r["box_id"], r["process_id"]
    # DELETE may fail (timeout) while the process is already gone, so the GET is the authority. Only a 404 (None)
    # or an explicit running:false counts as stopped; a DELETE error alone, an error on the GET, or an empty/unknown
    # status keeps the row (and the lease's active-run reservation) as it is.
    kill_err = None
    try:
        api.cmd_kill(box, pid)
    except OffboxError as e:
        kill_err = str(e)
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
    con = db()
    con.execute("DELETE FROM kv WHERE k=?", (f"start_unknown:{rid}",))
    con.commit()
    finish(rid, 143, "killed", catch_up=False)
    print(f"killed run {rid} (process {pid} on box {box}). `offbox release [--delete]` works now."
          + (f" (kill request failed but boat reports the process gone: {kill_err})" if kill_err else ""))
    return 0


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


def status(me: dict) -> None:
    from . import common, home
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
                  "Runs go back home after three good health checks")
        if st.get("degraded"):
            print(f"home server degraded: {'; '.join(str(x) for x in st['degraded'][:3])}")
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
            print(f"  {b['id']:<12} {b.get('state'):<9} {b.get('type'):<8} {(b.get('name') or '')[:60]}{held}")
    except OffboxError as e:
        print(f"boxes: boat API unreachable ({e})")
    print(f"you: {me['owner']} repo {me['repo_root']}")


def _run_row(run_id: str):
    con = db()
    r = con.execute("SELECT * FROM runs WHERE run_id=? OR run_id LIKE ?", (run_id, f"%{run_id}")).fetchone()
    if not r:
        raise OffboxError(f"no run {run_id}", code=2)
    return r


def _require_my_run(r) -> None:
    """logs, wait and kill ask the box about the run. On another owner's box every answer is 404, which would
    settle a live run as lost: refuse before asking (common.require_mine)."""
    if r["box_id"]:
        require_mine(db(), r["box_id"])


LOG_READ_WAIT_S = 10


def _catch_up_log(r, budget: float | None = None, *, locked: bool = False, live: bool = False,
                  lock_wait: float = 0) -> str:
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
        waited = guard.enter_context(log_lock(r['run_id'], timeout=0 if locked or live else
                                             min(lock_wait, lock_wait if budget is None else max(0, budget))))
    except OffboxError:
        guard.close()
        return 'n/a'
    try:
        ck = read_json(offsets_path(path), {})
        # Reuse a completed check published by the holder we just waited for. Sequential reads still check history,
        # since a server can publish more retained output after settlement.
        if (waited and r['command_id'] and isinstance(ck, dict) and ck != before and ck.get('settledCheck')
                and ck.get('settledCommandId') == r['command_id']
                and checkpoint(path) is not None and path.exists() and path.stat().st_size == ck['logBytes']):
            return 'complete'
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        remaining = None if budget is None else max(0, budget - (time.time() - started))
        deadline = time.time() + (30 if remaining is None else remaining)
        result = _catch_up_log_locked(r, path, remaining, live=live) if r['command_id'] else 'n/a'
        if not live and result in ('complete', 'caught_up'):
            ck = checkpoint(path)
            atomic_write_json(offsets_path(path), dict(ck, settledCommandId=r['command_id'], settledCheck=time.time_ns()))
        if not live and r['mode'] == 'bg' and not _has_data(path):
            return _empty_log_fallback(r, path, deadline, result)
        return result
    except OSError as e:
        return 'incomplete:' + str(e)
    finally:
        guard.close()


def _empty_log_fallback(r, path, deadline, result) -> str:
    """Only replace an empty settled log, under the run lock; never wake a box to read it."""
    # boatd's history reads its full host-side logs; the container has no additional copy to recover over SSH.
    if api.BACKEND == 'server':
        return result
    tmp = None
    try:
        with api.budget(max(0, deadline - time.time())):
            box = api.get(r['box_id'])
            if not box or box.get('state') not in api.LIVE_STATES:
                return result
            # The wrapper copy is optional on older runs; boat also keeps a process log on its live machine.
            paths = [f'.offbox/out/{r["run_id"]}.log']
            wrapper_pid = r['wrapper_pid'] or r['process_id']
            if wrapper_pid:
                paths.append(f'.ascii/processes/{int(wrapper_pid)}.log')
            command = 'for f in ' + ' '.join(shlex.quote(p) for p in paths) + '; do '
            command += 'if test -s "$HOME/$f"; then cat "$HOME/$f"; exit $?; fi; done; exit 44'
            remaining = api.left()
            left = min(10, deadline - time.time(), 10 if remaining is None else remaining)
            if left <= 0:
                return result
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.remote.', delete=False) as dst:
                tmp = dst.name
                proc = subprocess.run(ssh_sync.ssh_base(r['box_id']) + [r['box_id'], command],
                                      stdout=dst, stderr=subprocess.DEVNULL, timeout=left)
            if proc.returncode == 0 and os.path.getsize(tmp):
                os.replace(tmp, path)
                tmp = None
                # A merged remote log has no per-stream offsets. Do not invent a checkpoint for history.
                offsets_path(path).unlink(missing_ok=True)
                event(db(), r['box_id'], 'output_recovered', f"{r['run_id']} remote log bytes={path.stat().st_size}")
                return 'incomplete:remote log has no stream checkpoint'
    except (OffboxError, OSError, subprocess.TimeoutExpired, ValueError):
        pass
    finally:
        if tmp is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
    return result


def _catch_up_log_locked(r, path, budget, *, live=False) -> str:
    started = time.time()
    deadline = started + (30 if budget is None else budget)
    tmp = None
    try:
        ck = checkpoint(path)
        length = path.stat().st_size
        if ck is None or (not length and r['mode'] == 'bg'):
            if length:
                # Legacy bytes have no stream mapping. Equal lengths cannot prove that both streams are here.
                return 'incomplete:no checkpoint'
            ck = dict(stdoutOffset=0, stderrOffset=0, logBytes=0)
        keep = ck['logBytes']
        if min(keep, ck['stdoutOffset'], ck['stderrOffset']) < 0 or length < keep:
            return 'incomplete:invalid checkpoint'
        offsets = [ck['stdoutOffset'], ck['stderrOffset']]
        sizes = [0, 0]
        with tempfile.NamedTemporaryFile(mode='wb', dir=path.parent, prefix=path.name + '.catchup.',
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
                snapshot = None
                empty_pages = 0
                while True:
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    page = api.history_logs(r['box_id'], r['command_id'], which, offsets[i], deadline=deadline)
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    if page.get('size') is not None:
                        sizes[i] = max(sizes[i], int(page['size']) - ck[which + 'Offset'])
                        if snapshot is None:
                            snapshot = int(page['size'])
                    if budget is None:
                        deadline = started + min(180, 30 + sum(sizes) / 1_000_000)
                    data = (page.get('data') or '').encode()
                    nxt = page.get('nextOffset')
                    nxt = offsets[i] + len(data) if nxt is None else int(nxt)
                    if nxt <= offsets[i] and not page.get('done') and not (live and snapshot is not None and nxt >= snapshot):
                        if not live and r['mode'] == 'bg' and not length and not data and nxt == offsets[i] and empty_pages < 2:
                            empty_pages += 1
                            continue
                        return 'incomplete:no progress'
                    if nxt != offsets[i] + len(data):
                        return 'incomplete:invalid history offset'
                    dst.write(data)
                    empty_pages = 0
                    offsets[i] = nxt
                    if live and dst.tell() >= length:
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
            log_bytes = dst.tell()
        if time.time() >= deadline:
            return 'incomplete:timeout'
        if live and log_bytes < length:
            return 'incomplete:history behind local log'
        if offsets == [ck['stdoutOffset'], ck['stderrOffset']] and length == keep and checkpoint(path) is not None:
            return 'complete'
        if tmp is not None:
            os.replace(tmp, path)
            tmp = None
        atomic_write_json(offsets_path(path),
                          dict(stdoutOffset=offsets[0], stderrOffset=offsets[1], logBytes=log_bytes))
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


def _catch_up_finished(con, run_id, budget: float = 10) -> None:
    """Best effort under the maintenance caller's box lock; history errors cannot undo settlement."""
    try:
        r = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        result = _catch_up_log(r, budget=min(10, budget), locked=True)
        if result == 'n/a' or result.startswith('incomplete:'):
            reason = result.split(':', 1)[1] if ':' in result else 'run log lock held'
            event(con, r['box_id'], 'log_catchup_failed', f"{run_id} {reason}")
    except Exception as e:
        event(con, None, 'log_catchup_failed', f"{run_id} {e}")


def _incomplete_log(r, result) -> None:
    settled = r['status'] not in ('starting', 'running')
    p = LOGS_DIR / f"{r['run_id']}.log"
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
        return
    if settled:
        say(f"{r['run_id']} run ended {r['status']} exit={r['exit_code']}")


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


def logs(run_id: str, do_follow: bool) -> int:
    r = _run_row(run_id)
    _require_my_run(r)
    p = LOGS_DIR / f"{r['run_id']}.log"
    if r['status'] == 'lost' and r['box_id']:
        if do_follow:
            return _wait_locked(r, echo=True)
        from .runs import reconcile_lost
        with file_lock('box-' + r['box_id'], timeout=0):
            reconcile_lost(db(), r['box_id'])
            r = _run_row(r['run_id'])
    from . import start_check
    if do_follow and r['status'] == 'infra' and start_check.recovery_marked(db(), r):
        return _wait_locked(r, echo=True)
    if r['status'] in ('starting', 'running'):
        if do_follow:
            return _wait_locked(r, echo=True)
        _refresh_running_ttl(r)
        result = _catch_up_log(r, budget=10, live=True) if r['status'] == 'running' else 'n/a'
        _tail(p, 0, True)
        _incomplete_log(r, result)
        if r['mode'] != 'local':
            if not r['box_id'] or not r['process_id']:
                from .start_check import hint
                check = ('; check: ' + hint(r['box_id'], r['run_id'])) if r['box_id'] else ''
                say(f"{_not_started(r)}; no output yet. Follow it with: offbox logs {r['run_id']} --follow{check}")
            st = p.stat() if p.exists() else None
            written = time.strftime('%H:%M:%S', time.localtime(st.st_mtime)) if st else 'never'
            say(f"{r['run_id']} is still running; this local copy ({st.st_size if st else 0} bytes, last written "
                f"{written}) includes the output fetched so far. Use `offbox logs --follow {r['run_id']}` "
                f"or `offbox wait {r['run_id']} --timeout <s>` for current output.")
        return 0
    result = _catch_up_log(r, lock_wait=LOG_READ_WAIT_S)
    _tail(p, 0, True)
    _incomplete_log(r, result)
    from .runs import settled_steps_code, planned_steps
    code = settled_steps_code(r, r['exit_code'], catch_up=False, history_result=result)
    if planned_steps(r) and code is None:
        return EXIT_INFRA
    if r['mode'] == 'bg' and not _has_data(p):
        if result in ('complete', 'caught_up'):
            say(f"no output recorded for {r['run_id']} (server history checked)")
        return 1
    return 0


def wait(run_id: str, timeout: float | None) -> int:
    r = _run_row(run_id)
    _require_my_run(r)
    from . import start_check
    unknown = r['status'] == 'infra' and start_check.recovery_marked(db(), r)
    if (r["status"] not in ("starting", "running", "lost") and not unknown) or (r['status'] == 'lost' and not r['box_id']):
        return _settled(r, until=None if timeout is None else now() + timeout)
    return _wait_locked(r, echo=False, timeout=timeout)


def _settled(r, echo=False, pos=0, *, locked=False, until=None) -> int:
    from .runs import repo_setup_failed, settled_steps_code, planned_steps
    budget = None if until is None else max(0, until-now())
    result = _catch_up_log(r, budget=budget, lock_wait=LOG_READ_WAIT_S)
    if until is not None and now() >= until:
        _incomplete_log(r, result)
        raise _wait_timeout(r)
    if echo:
        _tail(LOGS_DIR / f"{r['run_id']}.log", pos, True)
    if result in ('complete', 'caught_up') and r['mode'] == 'bg' and not _has_data(LOGS_DIR / f"{r['run_id']}.log"):
        say(f"{r['run_id']} settled with no output on record")
    else:
        _incomplete_log(r, result)
    if repo_setup_failed(r['exit_code'], LOGS_DIR / f"{r['run_id']}.log"):
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    if r['error'] == 'box wedged before the command':
        say(f"{r['box_id']} was wedged before the command and set aside. Nothing ran: retry")
    code = settled_steps_code(r, r['exit_code'], catch_up=False, history_result=result)
    _report_deps_hint(r, code, LOGS_DIR / f"{r['run_id']}.log")
    status = r['status']
    if planned_steps(r) and code is not None and status in ('done', 'failed', 'infra', 'lost'):
        status = 'done' if code == 0 else 'failed'
        if (status, code) != (r['status'], r['exit_code']):
            con = db()
            try:
                con.execute("UPDATE runs SET status=?,exit_code=? WHERE run_id=? "
                            "AND status IN ('done','failed','infra','lost')", (status, code, r['run_id']))
                con.commit()
            finally:
                con.close()
    out(f"{r['run_id']}: {status} exit={code}")
    if code is None and r['box_id']:
        from .start_check import hint
        say(r['error'] or f"exit unknown; check: {hint(r['box_id'], r['run_id'])}")
    return code if code is not None else 90


def _tail(path, pos: int, echo: bool, limit: int | None = None) -> int:
    """Consume the holder's local log from `pos`, up to `limit` bytes when given (the committed length: bytes past it
    are not yet checkpointed and must not be printed). Prints only when echoing. Returns the new position."""
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
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
                    except (OSError, ValueError):
                        silence(sys.stdout)
                pos += len(data)
            if echo and getattr(sys.stdout, 'buffer', None) is None:
                try:
                    sys.stdout.write(decoder.decode(b'', final=True))
                    sys.stdout.flush()
                except (OSError, ValueError):
                    silence(sys.stdout)
    except OSError:
        pass
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


def _wait_locked(r, echo, timeout=None):
    """A foreground `offbox run` holds its box lock until it has recorded the run's end, so while another process
    holds the lock, poll the run row (and tail the local log) instead of failing on the lock.
    `pos` is the local-log byte count already delivered (printed when echoing). While the run may still be taken
    over, only checkpointed bytes are delivered (see runs.follow): a takeover replays everything past the checkpoint,
    and a log with no checkpoint at all (a holder from before checkpoints) is replayed whole into an emptied log."""
    from .runs import _ended, reconcile_lost
    deadline = None if timeout is None else now() + timeout
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    from . import start_check
    if start_check.recovery_marked(db(), r) and not start_check.api_pid(db(), r):
        r = _wait_start_receipt(r, deadline)
    if r['status'] != 'lost':
        r = _wait_for_start(r, deadline)
    if (r['status'] == 'lost' and db().execute(
            "SELECT 1 FROM kv WHERE k=? AND v='fenced'", (f"lost_confirmed:{r['run_id']}",)).fetchone()):
        return _settled(r, echo=echo, until=deadline)
    if r['status'] not in ('starting', 'running', 'lost') or not r['box_id']:
        return _settled(r, echo=echo, until=deadline)
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
                if cur['status'] not in ('starting', 'running'):
                    # The holder wrote its last output, recorded the end and released the lock between two polls.
                    # Nothing will be replayed now, so drain the whole rest of the log.
                    return _settled(cur, echo=echo, pos=pos, locked=True, until=deadline)
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
                return _replay_takeover(cur, echo, deadline, start, log_path, keep, has_checkpoint=ck is not None)
            finally:
                guard.__exit__(None, None, None)
        ck = checkpoint(log_path)
        if ck:
            pos = _tail(log_path, pos, echo, ck["logBytes"])
        cur = _run_row(r['run_id'])
        if cur['status'] not in ('starting', 'running', 'lost') or (cur['status'] == 'lost' and db().execute(
                'SELECT 1 FROM kv WHERE k=?', (f"lost_confirmed:{cur['run_id']}",)).fetchone()):
            # Settled: nothing will be replayed, so drain the whole rest of the log.
            return _settled(cur, echo=echo, pos=pos, until=deadline)
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
                return _holder_stuck(cur, st, log_path, pos, echo, deadline)
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


def _holder_stuck(r, st, log_path, pos: int, echo: bool, deadline=None) -> int:
    """boat says the process ended, but the client holding the box lock never recorded it. Report boat's exit code
    instead of waiting on that client for ever. The row is left to its holder (or the reaper once the holder is gone).
    A lost process's recovery reads the box, so it is bounded by the caller's deadline like the rest of the wait."""
    from .runs import _status_code, settled_steps_code
    code, how = _status_code(st), "boat's process status"
    if code is None:
        code, how = _recover_by(r, log_path, deadline)
    code = settled_steps_code(r, code, log_path=log_path, until=deadline)
    _tail(log_path, pos, echo)
    say(f"{r['run_id']} ended on {r['box_id']} over {_grace(r)}s ago, but the offbox process following it has not "
        f"recorded the end (it looks stuck); exit {code} taken from {how}. Full output: offbox logs {r['run_id']}")
    out(f"{r['run_id']}: exit={code}")
    if code is None:
        say(f"exit unknown; inspect with offbox ssh {r['box_id']}")
    return 90 if code is None else code


def _recover_by(r, log_path, deadline):
    """recover_lost_exit for a wait: the box read gets only what is left of the caller's deadline (20 s without one),
    and an answer that arrives at or past the deadline is not accepted, so nothing is published or settled from it
    (--timeout is 124 and the run is left alone)."""
    from .runs import recover_lost_exit, planned_steps
    budget = 20.0 if deadline is None else deadline - now()
    if budget <= 0:
        raise _wait_timeout(r)
    try:
        code, how = recover_lost_exit(r["box_id"], r["run_id"], log_path, planned_steps(r), timeout=min(20.0, budget))
    except OffboxError:
        if deadline is not None and now() >= deadline:
            raise _wait_timeout(r) from None
        raise
    if deadline is not None and now() >= deadline:
        raise _wait_timeout(r)
    return code, how


def _wait_timeout(r) -> OffboxError:
    if r['status'] not in ('starting', 'running'):
        return OffboxError(f"--timeout reached while reading {r['run_id']}'s log; run ended "
                           f"{r['status']} exit={r['exit_code']}. Retry: offbox wait {r['run_id']}",
                           code=EXIT_WAIT_TIMEOUT)
    return OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was stopped). "
                       f"Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)


def _not_started(r) -> str:
    if r['mode'] == 'local':
        return f"{r['run_id']} runs on this Mac (local fallback), not on a box"
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


def _client_alive(pid: int | None, start_at: float | None) -> bool:
    """Is the `offbox run` that inserted this row still running? Unknown (no pid recorded) counts as alive.
    A live pid that started after the run did is a reused pid, so the client is gone."""
    if not pid:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    began = _pid_started_at(pid)
    return began is None or start_at is None or began <= start_at + 2


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
                            "AND status IN ('starting','running')",
                            (now(), "client ended before it got a box", cur['run_id']))
                con.commit()
                say(f"{cur['run_id']}: its offbox client (pid {pid}) ended before it got a box; never started, "
                    "nothing ran")
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
    """True when the local log exists and holds bytes. Such a log may be legacy output with no checkpoint, which must
    never be rewritten in place before the replay is confirmed."""
    try:
        return os.path.getsize(log_path) > 0
    except OSError:
        return False


def _replay_takeover(cur, echo, deadline, start, log_path, keep, has_checkpoint=False):
    """Take over a run's follow without touching the original local log until the replay is confirmed.

    The temp file beside the log starts as the committed prefix (`keep` bytes); the replay appends the bytes the remote
    run still produces. It replaces the original log and checkpoint only when the replay ends with a real exit code.
    A deadline, a lost stream (unknown exit) or any error removes the temp files and keeps the original."""
    from .runs import log_lock
    with log_lock(cur['run_id'], until=deadline):
        ck = checkpoint(log_path)
        if ck is not None:
            start, keep = (ck['stdoutOffset'], ck['stderrOffset']), ck['logBytes']
            has_checkpoint = True
        return _replay_takeover_locked(cur, echo, deadline, start, log_path, keep, has_checkpoint)


def _replay_takeover_locked(cur, echo, deadline, start, log_path, keep, has_checkpoint):
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
                return _finalize(cur, code, log_path, until=deadline, echo=echo)
            raise OffboxError(f"takeover of {cur['run_id']} ended without a known exit; the original log is kept")
        # Publish the replacement log and checkpoint before the run is recorded as settled.
        os.replace(tmp, log_path)
        if os.path.exists(tmp_ck):
            os.replace(tmp_ck, offsets_path(log_path))
        return _finalize(cur, code, log_path, until=deadline, echo=echo)
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
    from .runs import Interrupted, finish, follow
    try:
        code = follow(r["box_id"], r["process_id"], log_path, echo=echo, run_id=r["run_id"], until=until,
                      start_offsets=start_offsets, replay_path=replay_path, mirror_path=mirror_path,
                      mirror_keep=mirror_keep, receipt_locked=True)
    except Interrupted as e:
        # Final on the server: the run will not go on. Recorded here so a later wait answers at once.
        code = finish(r["run_id"], e.code, "interrupted")
        if code is None:
            raise OffboxError(f"{r['run_id']}: steps incomplete after the server restart; remote exit unknown",
                              code=EXIT_INFRA, started=True) from None
        raise
    if code is None:
        code, how = _recover_by(r, log_path, until)
        if code is not None:
            say(f"boat lost track of the remote process after it ended; exit {code} taken from {how}")
    return code


def _report_deps_hint(r, code, log_path) -> None:
    from .runs import box_deps_hint, step_results
    if code not in (0, None) or any(rc != 0 for _, rc in step_results(log_path)):
        hint = box_deps_hint(Path(r['repo_root'] or '.'), log_path)
        if hint:
            say(hint)


def _finalize(r, code, log_path, until=None, *, echo=False) -> int:
    """Record a known end: pulls, the settled row (finish), std-tree hint and the exit line. Only after the log that
    describes this run is in its final place, so a concurrent follower never sees 'settled' with an old log."""
    from .runs import (do_pulls, finish, go_std_glitch, repo_setup_failed,
                       settle_box_wedged, wedged_message, settled_steps_code)
    try:
        delivered = os.path.getsize(log_path)
    except OSError:
        delivered = 0
    if repo_setup_failed(code, log_path):
        finish(r['run_id'], EXIT_INFRA, 'infra', until=until)
        if echo:
            _tail(log_path, delivered, True)
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    con = db()
    with contextlib.nullcontext() if until is None else api.budget(max(0, until-now())):
        wedged = settle_box_wedged(con, r, code)
    if wedged:
        say(wedged_message(r['box_id'], *wedged))
        return EXIT_INFRA
    pulls = json.loads(r["pulls"] or "[]")
    if pulls:
        con = db()
        row = dict(con.execute("SELECT * FROM runs WHERE run_id=?",
                               (r["run_id"],)).fetchone())
        do_pulls(r["box_id"], row, pulls, until=until)
    if until is not None and now() >= until:
        raise _wait_timeout(r)
    code = settled_steps_code(r, code, log_path=log_path, locked=True, until=until)
    code = finish(r['run_id'], code, until=until, report=True)
    if dict(r).get('mode') == 'bg' and not _has_data(log_path):
        settled = _run_row(r['run_id'])
        result = _catch_up_log(settled, budget=None if until is None else max(0, until-now()),
                               lock_wait=LOG_READ_WAIT_S)
        if result in ('complete', 'caught_up') and not _has_data(log_path):
            say(f"{r['run_id']} settled with no output on record")
        else:
            _incomplete_log(settled, result)
    if until is not None and now() >= until:
        raise _wait_timeout(_run_row(r['run_id']))
    # finish can fill a detached run's log after its stream ended. Only these new bytes remain undelivered.
    if echo:
        _tail(log_path, delivered, True)
    go_std_glitch(r["box_id"], r["run_id"], log_path, code)
    _report_deps_hint(r, code, log_path)
    out(f"{r['run_id']}: exit={code}")
    if code is None:
        say(f"exit unknown; inspect with offbox ssh {r['box_id']}")
    return 90 if code is None else code


def _wait_run(r, echo, until=None, start_offsets=(0, 0), replay_path=None):
    """Non-takeover wait (the lock was free, or this process holds it): follow, then record the end."""
    from .runs import follow  # noqa: F401  (kept so the module-level patch points stay valid)
    if r['status'] not in ('starting','running'):
        return _settled(r, echo=echo, locked=True, until=until)
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    code = _resolve_exit(r, log_path, until, start_offsets, replay_path, echo=echo)
    return _finalize(r, code, log_path, until=until, echo=echo)


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
