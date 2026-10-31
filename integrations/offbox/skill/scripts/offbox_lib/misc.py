"""Small commands: local exemptions, list, release, ssh, ports, status, logs, wait."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time

from . import api, capacity, lease, outage, pool, ssh_sync
from .common import (CAP_PATH, DEAD_MOUNT_NOTE, EXEMPTIONS, EXIT_WAIT_TIMEOUT, LOGS_DIR, TOO_BIG_NOTE, OffboxError,
                     ago, atomic_write_json, checkpoint, db, event, file_lock, iso, month_key, now, offsets_path,
                     read_json, say)

WAIT_POLL_S = 5


def parse_ttl(s: str) -> int:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([smhd]?)", s.strip())
    if not m:
        raise OffboxError(f"bad duration {s} (use 30m, 2h, 1d)", code=2)
    return int(float(m.group(1)) * {"": 60, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)])


def local_exempt(me: dict, reason: str | None, ttl: str, do_list: bool, do_clear: bool) -> None:
    with file_lock("exemptions", timeout=30):
        cur = [e for e in read_json(EXEMPTIONS, []) if (e.get("expires_at") or 0) > now()]
        if do_list:
            print(json.dumps(cur, indent=1))
            return
        ses = me.get("session")
        if do_clear:
            keep = [e for e in cur if not (e.get("session_id") == ses or (me.get("thread") and
                                                                           e.get("thread_id") == me.get("thread")))]
            atomic_write_json(EXEMPTIONS, keep)
            event(db(), None, "exemption_clear", f"session={ses} removed={len(cur) - len(keep)}")
            print(f"cleared {len(cur) - len(keep)} exemption(s)")
            return
        if not reason or len(reason.strip()) < 8:
            raise OffboxError('give a real reason: offbox local --reason "why this must run on the Mac" [--ttl 2h]', code=2)
        if not ses and not me.get("thread"):
            say("note: no OPENCODE_SESSION_ID; the exemption is recorded but the gate can't match it to a session")
        secs = parse_ttl(ttl)
        e = {"session_id": ses, "thread_id": me.get("thread"), "reason": reason.strip()[:500],
             "created_at": now(), "expires_at": now() + secs, "repo_root": me.get("repo_root"), "pid": os.getppid()}
        cur.append(e)
        atomic_write_json(EXEMPTIONS, cur)
    event(db(), None, "exemption_add", f"session={ses} thread={me.get('thread')} ttl={secs}s reason={reason[:200]}")
    print(f"exempt until {iso(e['expires_at'])} (session {ses}). Heavy work still competes with Abdullah's Mac: "
          f"prefer offbox run when you can.")


def list_leases(me: dict, show_all: bool, as_json: bool) -> None:
    con = db()
    capacity.schema(con)
    if show_all:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped') ORDER BY last_used_at DESC").fetchall()
    else:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped') AND (owner=? OR box_id IN "
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
        note = f"  [{d['note']}]" if (d.get("note") or "").startswith((TOO_BIG_NOTE, DEAD_MOUNT_NOTE)) else ""
        print(f"{d['box_id']:<12} {d['state']:<8} {d['size'] or '':<8} {d['repo_key']:<24} used {ago(d['last_used_at']):>6} "
              f"ago runs:{d['active_runs']}{pin}{note}  {d['source'] or ''}  {(d['thread_title'] or d['owner'])[:40]}")


def release(me: dict, box_id: str | None, mine: bool, delete: bool) -> None:
    con = db()
    capacity.schema(con)
    if box_id:
        rows = con.execute("SELECT * FROM leases WHERE box_id=? AND state IN ('running','stopped')", (box_id,)).fetchall()
    elif mine:
        rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped') AND (owner=? OR box_id IN "
                           "(SELECT box_id FROM pool_callers WHERE owner=?))", (me['owner'],me['owner'])).fetchall()
    else:
        row = lease.find_lease(con, me['owner'], me['repo_root'])
        rows = [row] if row else []
    if not rows:
        say("nothing to release")
        return
    for r in rows:
        # A foreground run holds box-<id> while it streams, so a hung run shows up as a lock timeout. Name the active
        # runs on that path too; the recheck under the lock still decides before any mutation.
        try:
            with file_lock('box-'+r['box_id'], timeout=1):
                _release_one(con, r, delete)
        except OffboxError as e:
            if "timed out waiting for lock" not in str(e):
                raise
            if not _report_active_runs(con, r["box_id"], lock_held=True):
                say(f"{r['box_id']}: box is busy (another offbox process holds it); not released. Try again shortly.")


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
        if lease.active_runs(con, r["box_id"]):
            _report_active_runs(con, r["box_id"])
            return
        if delete:
            lease.delete_box(con, r["box_id"], "release --delete")
            print(f"deleted {r['box_id']}")
        else:
            if r["state"] == "running":
                lease.stop_box(con, r["box_id"], "release")
            print(f"stopped {r['box_id']} (free; disk kept; next offbox run resumes it)")


def kill_run(run_id: str) -> int:
    """Stop a hung starting/running box run. The row is marked killed only after boat confirms the process is gone.
    No box lock: the hung run's client may be holding it."""
    from .runs import finish
    r = _run_row(run_id)
    rid = r["run_id"]
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
    if box_id:
        return box_id
    con = db()
    r = lease.find_lease(con, me["owner"], me["repo_root"])
    if not r:
        raise OffboxError("no lease for this thread + repo (run `offbox run -- true` to create one)", code=2)
    return r["box_id"]


def ssh_shell(me: dict, box_id: str | None, cmd: list[str]) -> int:
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


def logs(run_id: str, do_follow: bool) -> int:
    from .runs import finish, follow
    r = _run_row(run_id)
    if r["status"] in ("starting", "running") and r["box_id"] and r["process_id"]:
        s = api.get(r["box_id"])
        if s and s.get("state") in api.LIVE_STATES:
            if do_follow:
                return _wait_locked(r, echo=True)
            st = api.cmd_status(r["box_id"], r["process_id"]) or {}
            sys.stdout.write(st.get("stdout") or "")
            sys.stderr.write(st.get("stderr") or "")
            return 0
    p = LOGS_DIR / f"{r['run_id']}.log"
    if p.exists() and p.stat().st_size:
        sys.stdout.write(p.read_text(errors="replace"))
        return 0
    if r["box_id"] and r["command_id"]:
        for which, out in (("stdout", sys.stdout), ("stderr", sys.stderr)):
            off = 0
            while True:
                d = api.history_logs(r["box_id"], r["command_id"], which, off)
                out.write(d.get("data") or "")
                off = d.get("nextOffset") or off
                if d.get("done") or not d.get("data"):
                    break
    return 0


def wait(run_id: str, timeout: float | None) -> int:
    r = _run_row(run_id)
    if r["status"] not in ("starting", "running"):
        return _settled(r)
    return _wait_locked(r, echo=False, timeout=timeout)


def _settled(r) -> int:
    print(f"{r['run_id']}: {r['status']} exit={r['exit_code']}")
    return r["exit_code"] if r["exit_code"] is not None else 90


def _tail(path, pos: int, echo: bool, limit: int | None = None) -> int:
    """Consume the holder's local log from `pos`, up to `limit` bytes when given (the committed length: bytes past it
    are not yet checkpointed and must not be printed). Prints only when echoing. Returns the new position."""
    try:
        with open(path, "rb") as f:
            f.seek(pos)
            data = f.read() if limit is None else f.read(max(0, limit - pos))
    except OSError:
        return pos
    if data and echo:
        sys.stdout.write(data.decode(errors="replace"))
        sys.stdout.flush()
    return pos + len(data)


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
    deadline = None if timeout is None else now() + timeout
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    pos, said = 0, False
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
                    _tail(log_path, pos, echo)
                    return _settled(cur)
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
            _tail(log_path, pos, echo)
            return _settled(cur)
        if deadline is not None and now() >= deadline:
            raise OffboxError(f"--timeout reached; {r['run_id']} keeps running on {r['box_id']} (nothing was stopped). "
                              f"Wait again: offbox wait {r['run_id']}", code=EXIT_WAIT_TIMEOUT)
        if not said:
            say(f"{r['run_id']} is still followed by another offbox process (its own `offbox run` or another wait); "
                f"waiting for it to record the end")
            said = True
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
    from .runs import follow, recover_lost_exit
    code = follow(r["box_id"], r["process_id"], log_path, echo=echo, run_id=r["run_id"], until=until,
                  start_offsets=start_offsets, replay_path=replay_path, mirror_path=mirror_path,
                  mirror_keep=mirror_keep)
    if code is None:
        code, how = recover_lost_exit(r["box_id"], r["run_id"], log_path, 0)
        if code is not None:
            print(f"offbox: boat lost track of the remote process after it ended; exit {code} taken from {how}",
                  file=sys.stderr)
    return code


def _finalize(r, code, log_path) -> int:
    """Record a known end: pulls, the settled row (finish), std-tree hint and the exit line. Only after the log that
    describes this run is in its final place, so a concurrent follower never sees 'settled' with an old log."""
    from .runs import do_pulls, finish, go_std_glitch
    pulls = json.loads(r["pulls"] or "[]")
    if pulls:
        con = db()
        row = dict(con.execute("SELECT * FROM runs WHERE run_id=?",
                               (r["run_id"],)).fetchone())
        do_pulls(r["box_id"], row, pulls)
    finish(r['run_id'], code)
    go_std_glitch(r["box_id"], r["run_id"], log_path, code)
    print(f"{r['run_id']}: exit={code}")
    return 90 if code is None else code


def _wait_run(r, echo, until=None, start_offsets=(0, 0), replay_path=None):
    """Non-takeover wait (the lock was free, or this process holds it): follow, then record the end."""
    from .runs import follow  # noqa: F401  (kept so the module-level patch points stay valid)
    if r['status'] not in ('starting','running'):
        return r['exit_code'] if r['exit_code'] is not None else 90
    log_path = LOGS_DIR / f"{r['run_id']}.log"
    code = _resolve_exit(r, log_path, until, start_offsets, replay_path, echo=echo)
    return _finalize(r, code, log_path)
