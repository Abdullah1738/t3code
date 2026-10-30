"""Small commands: local exemptions, list, release, ssh, ports, status, logs, wait."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time

from . import api, capacity, lease, pool, ssh_sync
from .common import (CAP_PATH, EXEMPTIONS, EXIT_WAIT_TIMEOUT, LOGS_DIR, TOO_BIG_NOTE, OffboxError, ago,
                     atomic_write_json, db, event, file_lock, iso, month_key, now, read_json, say)

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
        note = f"  [{d['note']}]" if (d.get("note") or "").startswith(TOO_BIG_NOTE) else ""
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
        with file_lock('box-'+r['box_id'], timeout=1):
            _release_one(con, r, delete)


def _release_one(con, r, delete):
        if lease.active_runs(con, r["box_id"]):
            say(f"{r['box_id']}: run in progress, not released")
            return
        if delete:
            lease.delete_box(con, r["box_id"], "release --delete")
            print(f"deleted {r['box_id']}")
        else:
            if r["state"] == "running":
                lease.stop_box(con, r["box_id"], "release")
            print(f"stopped {r['box_id']} (free; disk kept; next offbox run resumes it)")


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


def status(me: dict) -> None:
    con = db()
    cap = read_json(CAP_PATH, {})
    try:
        L = api.limits()
        sps = L.get("creditSecondsPerDollar") or 100000
        print(f"account: plan {L.get('sandboxPlanKey')} {L.get('subscriptionStatus')}, can start: {L.get('canStart')}, "
              f"active boxes {L.get('activeSandboxes')}/{L.get('maxActiveSandboxes')}, "
              f"plan left ${(L.get('subscriptionRemainingSeconds') or 0) / sps:.2f}, packs ${L.get('packBalanceDollars')}")
    except OffboxError as e:
        print(f"account: unreachable ({e})")
    capped = cap.get("capped")
    print(f"cap: {'CAPPED' if capped else 'ok'} (last spend ${cap.get('spend', 0):.2f})")
    s = capacity.snapshot(con)
    print('starts: ' + ', '.join(f"{w['used']}/{w['cap']} in {w['window']}s" for w in s['counts']) +
          (f"; next local allowance {iso(s['retry_at'])}" if s['blocked'] else '; allowance available'))
    try:
        for b in api.list_boxes():
            r = con.execute("SELECT repo_key, owner FROM leases WHERE box_id=?", (b["id"],)).fetchone()
            print(f"  {b['id']:<12} {b.get('state'):<9} {b.get('type'):<8} {(b.get('name') or '')[:60]}")
    except OffboxError as e:
        print(f"boxes: {e}")
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


def _tail(path, pos: int, echo: bool) -> int:
    """Consume the holder's local log from `pos`; print the new bytes only when echoing. Returns the new position."""
    try:
        with open(path, "rb") as f:
            f.seek(pos)
            data = f.read()
    except OSError:
        return pos
    if data and echo:
        sys.stdout.write(data.decode(errors="replace"))
        sys.stdout.flush()
    return pos + len(data)


def _wait_locked(r, echo, timeout=None):
    """A foreground `offbox run` holds its box lock until it has recorded the run's end, so while another process
    holds the lock, poll the run row (and tail the local log) instead of failing on the lock.
    `pos` is the local-log byte count already delivered (printed when echoing, or appended by the takeover follow)."""
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
                # The holder writes its last output before it records the end and releases the lock: drain that first.
                pos = _tail(log_path, pos, echo)
                cur = _run_row(r['run_id'])
                if cur['status'] not in ('starting', 'running'):
                    return _settled(cur)
                # Take over the follow from the offsets the holder had reached, so nothing is printed or logged twice.
                from .runs import load_offsets
                return _wait_run(cur, echo, until=deadline, start_offsets=load_offsets(log_path))
            finally:
                guard.__exit__(None, None, None)
        pos = _tail(log_path, pos, echo)
        cur = _run_row(r['run_id'])
        if cur['status'] not in ('starting', 'running'):
            # Drain the holder's final bytes that landed after the poll above, then report the recorded end.
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


def _wait_run(r, echo, until=None, start_offsets=(0, 0)):
    from .runs import do_pulls, finish, follow, go_std_glitch, recover_lost_exit
    if r['status'] not in ('starting','running'):
        return r['exit_code'] if r['exit_code'] is not None else 90
    code = follow(r["box_id"], r["process_id"], LOGS_DIR / f"{r['run_id']}.log", echo=echo, run_id=r["run_id"],
                  until=until, start_offsets=start_offsets)
    if code is None:
        code, how = recover_lost_exit(r["box_id"], r["run_id"], LOGS_DIR / f"{r['run_id']}.log", 0)
        if code is not None:
            print(f"offbox: boat lost track of the remote process after it ended; exit {code} taken from {how}",
                  file=sys.stderr)
    pulls = json.loads(r["pulls"] or "[]")
    if pulls:
        con = db()
        row = dict(con.execute("SELECT * FROM runs WHERE run_id=?",
                               (r["run_id"],)).fetchone())
        do_pulls(r["box_id"], row, pulls)
    finish(r['run_id'], code)
    go_std_glitch(r["box_id"], r["run_id"], LOGS_DIR / f"{r['run_id']}.log", code)
    print(f"{r['run_id']}: exit={code}")
    return 90 if code is None else code
