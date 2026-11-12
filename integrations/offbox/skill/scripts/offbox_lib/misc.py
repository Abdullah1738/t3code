"""Small commands: local exemptions, list, release, ssh, ports, status, logs, wait."""

from __future__ import annotations

import codecs
import contextlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import api, capacity, lease, outage, pool, ssh_sync
from .common import (BOX_WEDGED_NOTE, CAP_PATH, DEAD_MOUNT_NOTE, EXEMPTIONS, EXIT_INFRA, EXIT_WAIT_TIMEOUT, LOGS_DIR, TOO_BIG_NOTE,
                     OffboxError, ago, atomic_write_json, checkpoint, db, event, file_lock, iso, month_key, now,
                     offsets_path, out, read_json, say, silence)
from .identity import require_proven

WAIT_POLL_S = 5
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
        rows = con.execute("SELECT * FROM leases WHERE box_id=? AND state IN ('running','stopped','resume_stalled')", (box_id,)).fetchall()
    elif mine:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped','resume_stalled') AND (owner=? OR box_id IN "
                           "(SELECT box_id FROM pool_callers WHERE owner=?))", (me['owner'],me['owner'])).fetchall()
    else:
        row = lease.find_lease(con, me['owner'], me['repo_root'])
        if row is None:
            row = con.execute("SELECT l.* FROM leases l JOIN prune_holds h USING(box_id) "
                              "WHERE l.state IN ('running','stopped') AND ((l.owner=? AND l.repo_root=?) OR "
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


def kill_run(run_id: str, me: dict | None = None) -> int:
    """Stop a hung starting/running box run. The row is marked killed only after boat confirms the process is gone.
    No box lock: the hung run's client may be holding it.

    With a caller (`me`), the run must be the caller's own: an unproven caller is refused, and a proven one may only
    stop a run its owner string names. Killing another execution's run is an authority transfer, like a release."""
    from .runs import finish
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
    if not r["box_id"] or not r["process_id"]:
        raise OffboxError(f"run {rid} never got a box process (no box_id/process_id). Nothing remote to stop; "
                          "if the client is gone the reaper marks it lost (`offbox reap`).", code=2)
    box, pid = r["box_id"], r["process_id"]
    # DELETE may fail (timeout) while the process is already gone, so the GET is the authority. Only a 404 (None)
    # or an explicit running:false counts as stopped; a DELETE error alone, an error on the GET, or an empty/unknown
    # status keeps the row (and the lease's active-run reservation) as it is.
    kill_err = None
    try:
        api.cmd_kill(box, pid)
    except OffboxError as e:
        kill_err = str(e)
    try:
        st = api.cmd_status(box, pid)
    except OffboxError as e:
        say(f"run {rid}: could not read process {pid} on {box} after kill ({e}); row left as {r['status']}")
        return 1
    if st is not None and st.get("running") is not False:
        why = "still reports it running" if st.get("running") else "returned no clear running state"
        say(f"run {rid}: boat {why} for process {pid} on {box}; row left as {r['status']}"
            + (f" (kill error: {kill_err})" if kill_err else ""))
        return 1
    finish(rid, 143, "killed")
    print(f"killed run {rid} (process {pid} on box {box}). `offbox release [--delete]` works now."
          + (f" (kill request failed but boat reports the process gone: {kill_err})" if kill_err else ""))
    return 0


def resolve_box(me: dict, box_id: str | None) -> str:
    # Ports uses this for both explicit IDs and the caller's lease; refuse before either selection.
    require_proven(me, "this box action")
    if box_id:
        return box_id
    con = db()
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
    con = db()
    cap = read_json(CAP_PATH, {})
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
            r = con.execute("SELECT repo_key, owner FROM leases WHERE box_id=?", (b["id"],)).fetchone()
            print(f"  {b['id']:<12} {b.get('state'):<9} {b.get('type'):<8} {(b.get('name') or '')[:60]}")
    except OffboxError as e:
        print(f"boxes: boat API unreachable ({e})")
    print(f"you: {me['owner']} repo {me['repo_root']}")


def _run_row(run_id: str):
    con = db()
    r = con.execute("SELECT * FROM runs WHERE run_id=? OR run_id LIKE ?", (run_id, f"%{run_id}")).fetchone()
    if not r:
        raise OffboxError(f"no run {run_id}", code=2)
    return r


def _catch_up_log(r, budget: float | None = None, *, locked: bool = False) -> str:
    """Complete a settled log using retained history only. Maintenance callers already own the box lock."""
    if r['status'] in ('starting', 'running') or not (r['box_id'] and r['command_id']):
        return 'n/a'
    path = LOGS_DIR / f"{r['run_id']}.log"
    guard = contextlib.nullcontext() if locked else file_lock('box-' + r['box_id'], timeout=0)
    try:
        guard.__enter__()
    except OffboxError:
        return 'n/a'
    try:
        if not path.exists():
            # A detached run may never have had a follower. Its missing log has a known empty prefix.
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        return _catch_up_log_locked(r, path, budget)
    except OSError as e:
        return 'incomplete:' + str(e)
    finally:
        guard.__exit__(None, None, None)


def _catch_up_log_locked(r, path, budget) -> str:
    started = time.time()
    deadline = started + (30 if budget is None else budget)
    tmp = None
    try:
        ck = checkpoint(path)
        length = path.stat().st_size
        if ck is None:
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
                while True:
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    page = api.history_logs(r['box_id'], r['command_id'], which, offsets[i], deadline=deadline)
                    if time.time() >= deadline:
                        return 'incomplete:timeout'
                    if page.get('size') is not None:
                        sizes[i] = max(sizes[i], int(page['size']) - ck[which + 'Offset'])
                    if budget is None:
                        deadline = started + min(180, 30 + sum(sizes) / 1_000_000)
                    data = (page.get('data') or '').encode()
                    nxt = page.get('nextOffset')
                    nxt = offsets[i] + len(data) if nxt is None else int(nxt)
                    if nxt <= offsets[i] and not page.get('done'):
                        return 'incomplete:no progress'
                    if nxt != offsets[i] + len(data):
                        return 'incomplete:invalid history offset'
                    dst.write(data)
                    offsets[i] = nxt
                    if page.get('done'):
                        if page.get('size') is not None and nxt < int(page['size']):
                            return 'incomplete:history ended early'
                        break
            log_bytes = dst.tell()
        if time.time() >= deadline:
            return 'incomplete:timeout'
        if offsets == [ck['stdoutOffset'], ck['stderrOffset']] and length == keep and checkpoint(path) is not None:
            return 'complete'
        os.replace(tmp, path)
        tmp = None
        atomic_write_json(offsets_path(path),
                          dict(stdoutOffset=offsets[0], stderrOffset=offsets[1], logBytes=log_bytes))
        # No follower can own these under the box lock. Discard abandoned replay files so a stale replay cannot
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


def _catch_up_finished(con, run_id) -> None:
    """Best effort under the maintenance caller's box lock; history errors cannot undo settlement."""
    try:
        r = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        result = _catch_up_log(r, budget=10, locked=True)
        if result.startswith('incomplete:'):
            event(con, r['box_id'], 'log_catchup_failed', f"{run_id} {result.split(':', 1)[1]}")
    except Exception as e:
        event(con, None, 'log_catchup_failed', f"{run_id} {e}")


def _incomplete_log(r, result) -> None:
    if result == 'n/a' and r['status'] not in ('starting', 'running') and r['box_id'] and r['command_id']:
        # A newer run or another catch-up may own this box lock. Skipping is safe, claiming completeness is not.
        result = 'incomplete:box lock held'
    if result.startswith('incomplete:'):
        p = LOGS_DIR / f"{r['run_id']}.log"
        size = p.stat().st_size if p.exists() else 0
        say(f"{r['run_id']} local log stops at {size} bytes and the rest couldn't be fetched "
            f"({result.split(':', 1)[1]}); this output is incomplete")


def logs(run_id: str, do_follow: bool) -> int:
    r = _run_row(run_id)
    p = LOGS_DIR / f"{r['run_id']}.log"
    if r['status'] in ('starting', 'running'):
        if do_follow:
            return _wait_locked(r, echo=True)
        _tail(p, 0, True)
        if r['mode'] != 'local':
            if not r['box_id'] or not r['process_id']:
                say(f"{_not_started(r)}; no output yet. Follow it with: offbox logs {r['run_id']} --follow")
            st = p.stat() if p.exists() else None
            written = time.strftime('%H:%M:%S', time.localtime(st.st_mtime)) if st else 'never'
            say(f"{r['run_id']} is still running; this local copy ({st.st_size if st else 0} bytes, last written "
                f"{written}) only grows while someone follows it. Use `offbox logs --follow {r['run_id']}` "
                f"or `offbox wait {r['run_id']} --timeout <s>` for current output.")
        return 0
    result = _catch_up_log(r)
    _tail(p, 0, True)
    _incomplete_log(r, result)
    return 0


def wait(run_id: str, timeout: float | None) -> int:
    r = _run_row(run_id)
    if r["status"] not in ("starting", "running"):
        return _settled(r)
    return _wait_locked(r, echo=False, timeout=timeout)


def _settled(r, echo=False, pos=0, *, locked=False) -> int:
    from .runs import repo_setup_failed
    result = _catch_up_log(r, locked=locked)
    if echo:
        _tail(LOGS_DIR / f"{r['run_id']}.log", pos, True)
    _incomplete_log(r, result)
    if repo_setup_failed(r['exit_code'], LOGS_DIR / f"{r['run_id']}.log"):
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    if r['error'] == 'box wedged before the command':
        say(f"{r['box_id']} was wedged before the command and set aside. Nothing ran: retry")
    _report_deps_hint(r, r['exit_code'], LOGS_DIR / f"{r['run_id']}.log")
    out(f"{r['run_id']}: {r['status']} exit={r['exit_code']}")
    return r["exit_code"] if r["exit_code"] is not None else 90


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
    from .runs import _ended
    deadline = None if timeout is None else now() + timeout
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    r = _wait_for_start(r, deadline)
    if r['status'] not in ('starting', 'running'):
        return _settled(r, echo=echo)
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
                cur = _run_row(r['run_id'])
                if cur['status'] not in ('starting', 'running'):
                    # The holder wrote its last output, recorded the end and released the lock between two polls.
                    # Nothing will be replayed now, so drain the whole rest of the log.
                    return _settled(cur, echo=echo, pos=pos, locked=True)
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
        if cur['status'] not in ('starting', 'running'):
            # Settled: nothing will be replayed, so drain the whole rest of the log.
            return _settled(cur, echo=echo, pos=pos)
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
            st = _ended(cur['box_id'], cur['process_id'], deadline)
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
    from .runs import _status_code
    code, how = _status_code(st), "boat's process status"
    if code is None:
        code, how = _recover_by(r, log_path, deadline)
    _tail(log_path, pos, echo)
    say(f"{r['run_id']} ended on {r['box_id']} over {_grace(r)}s ago, but the offbox process following it has not "
        f"recorded the end (it looks stuck); exit {code} taken from {how}. Full output: offbox logs {r['run_id']}")
    out(f"{r['run_id']}: exit={code}")
    return 90 if code is None else code


def _recover_by(r, log_path, deadline):
    """recover_lost_exit for a wait: the box read gets only what is left of the caller's deadline (20 s without one),
    and an answer that arrives at or past the deadline is not accepted, so nothing is published or settled from it
    (--timeout is 124 and the run is left alone)."""
    from .runs import recover_lost_exit
    budget = 20.0 if deadline is None else deadline - now()
    if budget <= 0:
        raise _wait_timeout(r)
    try:
        code, how = recover_lost_exit(r["box_id"], r["run_id"], log_path, 0, timeout=min(20.0, budget))
    except OffboxError:
        if deadline is not None and now() >= deadline:
            raise _wait_timeout(r) from None
        raise
    if deadline is not None and now() >= deadline:
        raise _wait_timeout(r)
    return code, how


def _wait_timeout(r) -> OffboxError:
    return OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was stopped). "
                       f"Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)


def _not_started(r) -> str:
    if r['mode'] == 'local':
        return f"{r['run_id']} runs on this Mac (local-first), not on a box"
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


def _wait_for_start(r, deadline):
    """Poll a run row until it has a box and a started command (box_id and process_id), or settles; return that row.
    A run queued for a pool box has no box_id, and one still syncing has no process_id: there is no box lock to
    take and no process to attach to yet (31 Oct: `wait` crashed on 'box-' + None while a run waited for its pool)."""
    said = None
    while True:
        cur = _run_row(r['run_id'])
        if cur['status'] not in ('starting', 'running') or (cur['box_id'] and cur['process_id']):
            return cur
        pid = cur['client_pid'] if 'client_pid' in cur.keys() else None
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
            # It had a box, so the start request may have reached boat: leave the row to the reaper.
            raise OffboxError(f"{cur['run_id']}: its offbox client (pid {pid}) ended on {cur['box_id']} before the "
                              "command was recorded as started, so there is nothing to follow. `offbox reap` settles "
                              "the row; check `offbox list` before running it again", code=EXIT_INFRA)
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
            raise OffboxError(f"takeover of {cur['run_id']} ended without a known exit; the original log is kept")
        # Publish the replacement log and checkpoint before the run is recorded as settled.
        os.replace(tmp, log_path)
        if os.path.exists(tmp_ck):
            os.replace(tmp_ck, offsets_path(log_path))
        return _finalize(cur, code, log_path)
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
    from .runs import follow
    code = follow(r["box_id"], r["process_id"], log_path, echo=echo, run_id=r["run_id"], until=until,
                  start_offsets=start_offsets, replay_path=replay_path, mirror_path=mirror_path,
                  mirror_keep=mirror_keep)
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


def _finalize(r, code, log_path) -> int:
    """Record a known end: pulls, the settled row (finish), std-tree hint and the exit line. Only after the log that
    describes this run is in its final place, so a concurrent follower never sees 'settled' with an old log."""
    from .runs import (do_pulls, finish, go_std_glitch, repo_setup_failed,
                       settle_box_wedged, wedged_message)
    if repo_setup_failed(code, log_path):
        finish(r['run_id'], EXIT_INFRA, 'infra')
        say('repo toolchain setup failed (exit 98), not your command')
        return EXIT_INFRA
    con = db()
    wedged = settle_box_wedged(con, r, code)
    if wedged:
        say(wedged_message(r['box_id'], *wedged))
        return EXIT_INFRA
    pulls = json.loads(r["pulls"] or "[]")
    if pulls:
        con = db()
        row = dict(con.execute("SELECT * FROM runs WHERE run_id=?",
                               (r["run_id"],)).fetchone())
        do_pulls(r["box_id"], row, pulls)
    finish(r['run_id'], code)
    go_std_glitch(r["box_id"], r["run_id"], log_path, code)
    _report_deps_hint(r, code, log_path)
    out(f"{r['run_id']}: exit={code}")
    return 90 if code is None else code


def _wait_run(r, echo, until=None, start_offsets=(0, 0), replay_path=None):
    """Non-takeover wait (the lock was free, or this process holds it): follow, then record the end."""
    from .runs import follow  # noqa: F401  (kept so the module-level patch points stay valid)
    if r['status'] not in ('starting','running'):
        return r['exit_code'] if r['exit_code'] is not None else 90
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    code = _resolve_exit(r, log_path, until, start_offsets, replay_path, echo=echo)
    return _finalize(r, code, log_path)
