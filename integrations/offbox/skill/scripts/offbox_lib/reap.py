"""Reaper: stop idle leases (free; boat keeps the disk 14 days after the stop); delete only archived-7d /
unused-30d unpinned leases; forget leases whose data boat deleted; keep pinned leases, bases and templates past
boat's 14 days (bases.upkeep). Every action is logged to events + offbox.log."""

from __future__ import annotations

from . import api, bases, capacity, lease
from .common import (ARCHIVED_DELETE_S, IDLE_STOP_S, KEEPALIVE_S, UNUSED_DELETE_S, OffboxError, db, event, file_lock,
                     iso_ts, now, say)
from .identity import thread_get

# The monitor kills a reap pass at 120 s; keep every boat call and wait inside this budget.
REAP_BUDGET_S = 100


def _protected(con) -> set[str]:
    ids = {r[0] for r in con.execute("SELECT box_id FROM bases")}
    ids |= {r[0] for r in con.execute("SELECT box_id FROM templates")}
    return ids


def reap(dry: bool = False) -> list[str]:
    actions: list[str] = []
    con = db()
    try:
        with file_lock("reap", timeout=5), api.budget(REAP_BUDGET_S):
            return _reap(con, dry, actions)
    except OffboxError as e:
        if "timed out waiting for lock" in str(e):
            return ["another reap is running"]
        raise


def _still_bringing_up(con, box_id: str) -> bool:
    row = con.execute("SELECT state FROM leases WHERE box_id=?", (box_id,)).fetchone()
    return bool(row) and row["state"] == "bringing_up"


def _bringup_lock(row) -> str:
    """The lock a live acquisition holds for its whole bring-up (lease.acquire_private). A pool creator holds its
    box lock instead, so its bring-up never waits on other pool callers."""
    if row["owner"].startswith("pool:"):
        return f"box-{row['box_id']}"
    return f"lease-{row['owner']}-{row['repo_root']}"


def _forget(con, box_id: str, actions: list[str], dry: bool = False) -> None:
    actions.append(f"{'would forget' if dry else 'forget'} {box_id}: quarantined and gone from boat")
    if not dry:
        con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
        con.commit()
        event(con, box_id, "reap_forget", "recipe box no longer exists on boat")


def _retire_locked(con, bid: str, row, dry: bool, act, actions: list[str]) -> None:
    """Delete a quarantined or abandoned bring-up box. The bring-up lock is taken first (no wait), then the row is
    re-read: a live acquisition that finished meanwhile is left alone. act() takes the box lock itself."""
    if dry:
        actions.append(f"would delete {bid}: recipe box quarantined or bring-up abandoned")
        return
    try:
        # Probe only: act() takes box-<id> itself, so a pool row's box lock can't be held across it.
        with file_lock(_bringup_lock(row), timeout=0):
            if row["state"] == "bringing_up" and not _still_bringing_up(con, bid):
                return
    except OffboxError:
        return  # a live acquisition holds the bring-up lock: skip it this pass
    act(bid, "delete", "recipe cancelled, box quarantined or bring-up abandoned",
        lambda bid=bid: lease.delete_box(con, bid, "reap: recipe box quarantined or abandoned"))


def _reap(con, dry: bool, actions: list[str]) -> list[str]:
    capacity.schema(con)
    # Local runs (local-first or fallback) whose offbox process died without recording an end.
    stale = con.execute("SELECT run_id FROM runs WHERE mode='local' AND status IN ('starting','running') "
                        "AND start_at<?", (now() - 6 * 3600,)).fetchall()
    for (rid,) in stale:
        actions.append(f"{'would mark' if dry else 'mark'} local run {rid} lost")
        if not dry:
            con.execute("UPDATE runs SET status='lost', end_at=? WHERE run_id=?", (now(), rid))
    if stale and not dry:
        con.commit()
    # Foreground/--bg runs that never got a box (client died while waiting in the pool): nothing remote to check.
    # Two hours is past any pool wait, so live waiters are never touched.
    nobox = con.execute("SELECT run_id FROM runs WHERE mode IN ('fg','bg') AND box_id IS NULL "
                        "AND status IN ('starting','running') AND start_at<?", (now() - 2 * 3600,)).fetchall()
    for (rid,) in nobox:
        actions.append(f"{'would mark' if dry else 'mark'} no-box run {rid} lost")
        if not dry:
            con.execute("UPDATE runs SET status='lost', end_at=?, error=? WHERE run_id=?",
                        (now(), "client ended before it got a box", rid))
    if nobox and not dry:
        con.commit()
    # A no-box run whose own `offbox run` client is gone never got a box: mark it lost now, not after 2 h.
    from .misc import _client_alive
    orphan = [tuple(r) for r in con.execute(
        "SELECT run_id, client_pid, start_at FROM runs WHERE mode IN ('fg','bg') AND box_id IS NULL "
        "AND status IN ('starting','running') AND client_pid IS NOT NULL").fetchall()]
    for rid, pid, start_at in orphan:
        if _client_alive(pid, start_at):
            continue
        actions.append(f"{'would mark' if dry else 'mark'} no-box run {rid} lost (client {pid} gone)")
        if not dry:
            con.execute("UPDATE runs SET status='lost', end_at=?, error=? WHERE run_id=? AND box_id IS NULL "
                        "AND status IN ('starting','running')", (now(), "client ended before it got a box", rid))
            con.commit()
    pooled = {r[0] for r in con.execute('SELECT box_id FROM pool_members')}
    snap = capacity.snapshot(con)
    protected = _protected(con)
    try:
        live = {b["id"]: b for b in api.list_boxes()}
    except OffboxError as e:
        return [f"boat list failed: {e}"]

    def act(box_id, what, why, fn):
        line = f"{'would ' if dry else ''}{what} {box_id}: {why}"
        actions.append(line)
        if not dry:
            try:
                with file_lock('box-'+box_id, timeout=0):
                    if lease.active_runs(con, box_id):
                        actions[-1] += ' (busy; skipped)'
                        return
                    fn()
            except OffboxError as e:
                event(con, box_id, f"reap_{what}_failed", f"{why}: {e}")
                actions[-1] += f" (FAILED: {e})"

    refreshes = 0  # resume+stop of pinned leases near boat's 14-day limit; a few per pass (120 s budget)
    # A lease with an open prune hold stays on the list even if it is marked deleted: its hold is released only
    # after fresh confirmation, and a failed or busy release must be retried on a later pass.
    rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped') "
                       "OR box_id IN (SELECT box_id FROM prune_holds)").fetchall()
    for r in rows:
        bid = r["box_id"]
        b = live.get(bid)
        if bid in protected:
            continue
        if b is None:
            if not dry:
                # Release first. The lease is retired only once no hold remains: a busy lock or a failed read keeps
                # the hold and the lease state, so a later pass finds it again and retries.
                if lease.release_if_confirmed(con, bid):
                    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), bid))
                    con.commit()
                    event(con, bid, "reap_forget", "box no longer exists on boat")
                    actions.append(f"forget {bid}: gone from boat")
                else:
                    actions.append(f"hold kept {bid}: gone from boat, not yet confirmed")
            else:
                actions.append(f"forget {bid}: gone from boat")
            continue
        if b.get("dataExpiredAt"):
            # Same release rule as a box gone from boat: nothing can run on a box whose data is deleted, but the
            # hold goes only after a locked, fresh confirmation; a busy lock leaves it for a later pass.
            if not dry:
                if lease.release_if_confirmed(con, bid):
                    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), bid))
                    con.commit()
                    event(con, bid, "reap_expired", f"boat deleted its data at {b['dataExpiredAt']}")
                    actions.append(f"forget {bid}: boat deleted its data")
                else:
                    actions.append(f"hold kept {bid}: boat deleted its data, not yet confirmed")
            else:
                actions.append(f"forget {bid}: boat deleted its data")
            continue
        state = b.get("state")
        running_runs = lease.active_runs(con, bid)
        if running_runs:
            _check_stale_runs(con, bid, state, dry, actions)
            running_runs = lease.active_runs(con, bid)
        idle = now() - (r["last_used_at"] or r["created_at"] or now())
        docker = lease.docker_recent(con, bid)
        idle_limit = capacity.idle_seconds(r["size"], snap, docker=docker)
        if not dry and state in api.STOPPED_STATES and r["state"] == "running":
            con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (bid,))
            con.commit()
        if not dry and state in api.STOPPED_STATES:
            # The snapshot above may be stale: release only after a locked, fresh confirmation.
            lease.release_if_confirmed(con, bid)
        # thread status for deletion decisions
        gone_since = r["thread_gone_since"]
        if bid in pooled:
            gone_since = None
        elif r["thread_id"]:
            ts, _t = thread_get(r["thread_id"])
            if ts == "gone" and not gone_since:
                gone_since = now()
                if not dry:
                    con.execute("UPDATE leases SET thread_gone_since=? WHERE box_id=?", (gone_since, bid))
                    con.commit()
            elif ts == "ok" and gone_since:
                gone_since = None
                if not dry:
                    con.execute("UPDATE leases SET thread_gone_since=NULL WHERE box_id=?", (bid,))
                    con.commit()
        pinned = (r["pinned_until"] or 0) > now()
        if running_runs:
            continue
        if gone_since and now() - gone_since > ARCHIVED_DELETE_S and not pinned:
            act(bid, "delete", f"thread archived {round((now() - gone_since) / 86400, 1)}d",
                lambda bid=bid: lease.delete_box(con, bid, "reap: thread archived 7d"))
            continue
        if idle > UNUSED_DELETE_S and not pinned:
            act(bid, "delete", f"unused {round(idle / 86400, 1)}d, not pinned",
                lambda bid=bid: lease.delete_box(con, bid, "reap: unused 30d"))
            continue
        if state in api.LIVE_STATES and idle <= idle_limit and not dry and not running_runs:
            # Docker boxes get boat-ttl grace so this reaper's stop (which archives images first) wins.
            lease.ensure_ttl(bid, max(60, int(idle_limit-idle)) + (300 if docker else 0), b)
        if state in api.LIVE_STATES and idle > idle_limit:
            act(bid, "stop", f"idle {int(idle // 60)}m",
                lambda bid=bid: lease.stop_box(con, bid, "reap: idle", locked=True))  # act() holds box-<id>
        stopped = iso_ts(b.get("stoppedAt"))
        if pinned and state in api.STOPPED_STATES and stopped and now() - stopped > KEEPALIVE_S and refreshes < 2:
            refreshes += 1
            act(bid, "refresh", f"pinned, stopped {round((now() - stopped) / 86400, 1)}d",
                lambda bid=bid: lease.refresh_box(con, bid))
    # Boxes whose recipe was cancelled (lease._retire_recipe_box) and whose delete failed then: delete them now.
    # 'bringing_up' rows are left behind by a bring-up that never finished (Ctrl-C, SIGTERM, a tool timeout): the
    # recipe cannot be trusted, so the box is retired like a quarantined one.
    # A live acquisition holds its bring-up lock (_bringup_lock) for the whole bring-up, so cleanup takes that same
    # lock without waiting and re-reads the row under it. A selection made before the lock is stale: a row that became
    # running (or was reused) is skipped, never deleted.
    for r in con.execute("SELECT box_id, owner, repo_root, state FROM leases "
                         "WHERE state IN ('quarantined','bringing_up')").fetchall():
        bid = r["box_id"]
        if r["state"] == "bringing_up" and not dry and not _still_bringing_up(con, bid):
            continue
        if bid in live:
            _retire_locked(con, bid, r, dry, act, actions)
        else:
            if r["state"] == "bringing_up" and not dry:
                try:
                    with file_lock(_bringup_lock(r), timeout=0):
                        if not _still_bringing_up(con, bid):
                            continue
                except OffboxError:
                    continue  # a live acquisition holds the lock: leave it to that process
                _forget(con, bid, actions)
            else:
                _forget(con, bid, actions, dry=dry)
    # Templates/bases: make sure they are stopped (they are free when stopped).
    for bid in protected:
        b = live.get(bid)
        if b and b.get("state") in api.LIVE_STATES:
            busy = con.execute("SELECT COUNT(*) FROM events WHERE box_id=? AND kind LIKE 'template_build%' AND ts>?",
                               (bid, now() - 3 * 3600)).fetchone()[0]
            if not busy:
                act(bid, "stop", "template/base left running", lambda bid=bid: api.stop(bid))
    bases.upkeep(con, live, dry, actions, act)
    # Orphans: offbox-named live boxes we have no record of (e.g. a crashed create).
    known = {r[0] for r in con.execute("SELECT box_id FROM leases")} | protected
    for bid, b in live.items():
        if bid in known or not (b.get("name") or "").startswith("offbox"):
            continue
        created = iso_ts(b.get("createdAt")) or now()
        if b.get("state") in api.LIVE_STATES and now() - created > IDLE_STOP_S:
            act(bid, "stop", "unregistered offbox box", lambda bid=bid: api.stop(bid))
    return actions


def _check_stale_runs(con, bid: str, state: str, dry: bool, actions: list[str]) -> None:
    try:
        with file_lock('box-'+bid, timeout=0):
            _check_unlocked(con, bid, state, dry, actions)
    except OffboxError:
        pass


def _check_unlocked(con, bid: str, state: str, dry: bool, actions: list[str]) -> None:
    """Runs marked running on a box that is stopped, or whose process ended while nobody was attached."""
    for run in con.execute("SELECT * FROM runs WHERE box_id=? AND status IN ('starting','running')", (bid,)).fetchall():
        status, code = None, None
        if run['status'] == 'starting' and not run['process_id'] and now()-(run['start_at'] or 0) < 3600:
            continue
        if state in api.STOPPED_STATES or state in ('error','cancelled'):
            status = "lost"
        elif state not in api.LIVE_STATES:
            continue
        elif run["process_id"]:
            try:
                st = api.cmd_status(bid, run["process_id"])
            except OffboxError:
                continue
            if st is None:
                # Missing/unavailable status is not proof a process stopped.
                continue
            elif not st.get("running") and st.get('status') in ('exited','lost'):
                code = st.get("exitCode")
                status = "lost" if st.get("status") == "lost" else ("done" if code == 0 else "failed")
        elif run['error']:
            # Ambiguous cmd_start: quarantine until the box stops, never free it for another sync.
            continue
        elif now() - (run["start_at"] or 0) > 3600:
            status = "infra"
        if status:
            actions.append(f"{'would mark' if dry else 'mark'} run {run['run_id']} {status}")
            if not dry:
                if run['mode'] == 'bg' and status in ('done','failed') and run['pulls']:
                    import json
                    from .runs import do_pulls
                    do_pulls(bid, dict(run), json.loads(run['pulls']))
                con.execute("UPDATE runs SET status=?, exit_code=?, end_at=? WHERE run_id=?",
                            (status, code, now(), run["run_id"]))
                con.commit()
                event(con, bid, "run_reaped", f"{run['run_id']} {status} exit={code}")
                if state in api.LIVE_STATES:
                    from .runs import settle_docker
                    settle_docker(con, run, status)
                    # The run's client died: the box still has its 30-min run ttl. Bring it to the idle window.
                    lease.idle_ttl(bid)


def print_actions(actions: list[str]) -> None:
    if not actions:
        say("reap: nothing to do")
    for a in actions:
        print(a)
