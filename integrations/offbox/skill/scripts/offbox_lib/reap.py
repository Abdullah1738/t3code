"""Reaper: stop idle leases (free, keeps disk); delete only archived-7d / unused-30d unpinned leases.
Bases and templates are never touched. Every action is logged to events + offbox.log."""

from __future__ import annotations

from . import api, capacity, lease
from .common import (ARCHIVED_DELETE_S, IDLE_STOP_S, UNUSED_DELETE_S, OffboxError, db, event, file_lock, iso_ts, now,
                     say)
from .identity import thread_get


def _protected(con) -> set[str]:
    ids = {r[0] for r in con.execute("SELECT box_id FROM bases")}
    ids |= {r[0] for r in con.execute("SELECT box_id FROM templates")}
    return ids


def reap(dry: bool = False) -> list[str]:
    actions: list[str] = []
    con = db()
    try:
        with file_lock("reap", timeout=5):
            return _reap(con, dry, actions)
    except OffboxError as e:
        if "timed out waiting for lock" in str(e):
            return ["another reap is running"]
        raise


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

    rows = con.execute("SELECT * FROM leases WHERE state IN ('running','stopped')").fetchall()
    for r in rows:
        bid = r["box_id"]
        b = live.get(bid)
        if bid in protected:
            continue
        if b is None:
            if not dry:
                con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), bid))
                con.commit()
                event(con, bid, "reap_forget", "box no longer exists on boat")
            actions.append(f"forget {bid}: gone from boat")
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
            act(bid, "stop", f"idle {int(idle // 60)}m", lambda bid=bid: lease.stop_box(con, bid, "reap: idle"))
    # Templates/bases: make sure they are stopped (they are free when stopped).
    for bid in protected:
        b = live.get(bid)
        if b and b.get("state") in api.LIVE_STATES:
            busy = con.execute("SELECT COUNT(*) FROM events WHERE box_id=? AND kind LIKE 'template_build%' AND ts>?",
                               (bid, now() - 3 * 3600)).fetchone()[0]
            if not busy:
                act(bid, "stop", "template/base left running", lambda bid=bid: api.stop(bid))
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


def print_actions(actions: list[str]) -> None:
    if not actions:
        say("reap: nothing to do")
    for a in actions:
        print(a)
