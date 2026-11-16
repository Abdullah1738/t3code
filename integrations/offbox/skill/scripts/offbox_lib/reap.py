"""Reaper: stop idle leases (free; boat keeps the disk 14 days after the stop); delete only archived-7d /
unused-30d unpinned leases; forget leases whose data boat deleted; keep pinned leases, bases and templates past
boat's 14 days (bases.upkeep). Every action is logged to events + offbox.log."""

from __future__ import annotations

import time
import sqlite3
import re

from . import api, bases, capacity, lease, prune
from .common import (ARCHIVED_DELETE_S, BOX_WEDGED_NOTE, EXIT_INFRA, EXIT_INTERRUPTED, IDLE_STOP_S, KEEPALIVE_S, ORPHAN_RUN_MAX_S,
                     RUN_TTL_S, UNUSED_DELETE_S, OffboxError, db, event, file_lock,
                     iso_ts, kv_set, mine, now, owner_of_root, owner_scoped, PERSON_PREFIX, require_mine, say, token_owner, write)
from .identity import thread_get

# The monitor kills a reap pass at 120 s; keep every boat call and wait inside this budget.
REAP_BUDGET_S = 100
START_GRACE_S = 300
START_CHECKS_PER_PASS = 3
# Leave cleanup time after a fair, bounded pass over run keepalives.
RENEW_BUDGET_S = 60
RENEW_BOX_BUDGET_S = 5


def _protected(con) -> set[str]:
    ids = {r[0] for r in con.execute("SELECT box_id FROM bases")}
    ids |= {r[0] for r in con.execute("SELECT box_id FROM templates")}
    return ids


def _recheck_prune_holds(con, actions: list[str]) -> None:
    # Check least recently probed first so an unreachable worker cannot starve the rest on every tick.
    rows = con.execute("SELECT h.box_id, h.run_id FROM prune_holds h JOIN leases l USING(box_id) "
                       "LEFT JOIN kv k ON k.k='prunecheck:' || h.box_id "
                       f"WHERE l.state='running' AND {mine('l')} AND h.created_at<? "
                       "AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.box_id=l.box_id "
                       "AND r.status IN ('starting','running')) "
                       "ORDER BY CAST(COALESCE(k.v, '0') AS REAL), h.created_at", (now() - 300,)).fetchall()
    deadline = time.monotonic() + 10
    for hold in rows:
        if time.monotonic() >= deadline:
            break
        kv_set(con, 'prunecheck:' + hold['box_id'], now())
        released = prune.recheck(con, hold['box_id'], hold['run_id'], deadline - time.monotonic())
        actions.append(f"prune hold {'released' if released else 'kept'} {hold['box_id']}")


def reap(dry: bool = False) -> list[str]:
    import toollog
    with toollog.span("reaper", "reaper.pass", props={"dryRun": dry}, tag="reaper_failed") as data:
        actions = _reap_logged(dry)
        data["props"]["count"] = len(actions)
        data["ok"] = not any("(FAILED:" in action or " list failed:" in action for action in actions)
        for action in actions:
            word = action.removeprefix("would ").split(" ", 1)[0]
            failed = "(FAILED:" in action or " list failed:" in action
            lost = re.fullmatch(r"(?:would )?mark (?:local |no-box )?run (\S+) lost(?: \(client \d+ gone\))?", action)
            toollog.emit("reaper", "reaper.action", kind="error" if failed else "event", ok=not failed,
                         tag="reaper_action" if failed else None, ids={"run": lost[1]} if lost else None,
                         props={"dryRun": dry, "action": word if word in {"stop", "delete", "forget", "settle", "keep"} else "other"})
        return actions


def _reap_logged(dry: bool = False) -> list[str]:
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
    if lease.pinned_until(con, box_id) > now():
        actions.append(f"keep {box_id}: pinned; backend miss does not retire its lease")
        return
    actions.append(f"{'would forget' if dry else 'forget'} {box_id}: quarantined and gone from {api.NAME}")
    if not dry:
        try:
            lease.forget_box(con, box_id, "reap_forget", f"recipe box no longer exists on {api.NAME}")
        except lease.PinnedLeaseError as pin:
            actions[-1] = f"keep {box_id}: {pin}"


def _retire_locked(con, bid: str, row, dry: bool, act, actions: list[str]) -> None:
    """Delete a quarantined or abandoned bring-up box. The bring-up lock is taken first (no wait), then the row is
    re-read: a live acquisition that finished meanwhile is left alone. act() takes the box lock itself."""
    if lease.pinned_until(con, bid) > now():
        actions.append(f"keep {bid}: pinned recipe box")
        return
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


def _mark_lost(con, run_id, error=None, *, no_box=False, expected_client=None):
    from .runs import claim_terminal_log, emit_terminal
    with write(con):
        changed = con.execute("UPDATE runs SET status='lost', end_at=?, error=COALESCE(?,error) "
                              "WHERE run_id=? AND status IN ('starting','running')" +
                              (" AND box_id IS NULL" if no_box else "") +
                              (" AND client_pid IS ? AND start_at IS ?" if expected_client is not None else ""),
                              (now(), error, run_id, *(expected_client or ())))
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone() if changed.rowcount else None
        log_row = claim_terminal_log(con, row)
    if log_row is not None:
        emit_terminal(log_row)


def _reap(con, dry: bool, actions: list[str]) -> list[str]:
    capacity.schema(con)
    # Cleanup can declare an absent client/box lost before _check_unlocked ever sees its runs.
    # A saved result is stronger evidence, including for a placeholder left by an earlier pass.
    from .runs import finish, restore_run_state, terminal_result
    recovered, unowned = set(), set()
    owned = f"(r.box_id IS NULL OR (l.box_id IS NOT NULL AND {mine('l')}))" if owner_scoped() else '1=1'
    for run in con.execute("SELECT r.* FROM runs r LEFT JOIN leases l USING(box_id) "
                           "WHERE (r.status IN ('starting','running') OR (r.status='lost' AND r.exit_code IS NULL) OR "
                           "(r.status='infra' AND r.exit_code IS NULL AND EXISTS "
                           "(SELECT 1 FROM kv WHERE k='start_unknown:' || r.run_id))) "
                           f"AND {owned}").fetchall():
        if owner_scoped() and not run['box_id']:
            owner = run['owner'] or ''
            who = owner[len(PERSON_PREFIX):] if owner.startswith(PERSON_PREFIX) else owner_of_root(run['repo_root'])
            if who != token_owner():
                unowned.add(run['run_id'])
                continue
        saved = restore_run_state(run)
        if saved['box_id']:
            require_mine(con, saved['box_id'])
        if terminal_result(saved):
            recovered.add(run['run_id'])
            if not dry:
                finish(run['run_id'], saved['exit_code'], saved['status'], catch_up=False)
            actions.append(f"{'would repair' if dry else 'repair'} run {run['run_id']} exit={saved['exit_code']}")
    # Local runs (local-first or fallback) whose offbox process died without recording an end.
    stale = con.execute("SELECT run_id FROM runs WHERE mode='local' AND status IN ('starting','running') "
                        "AND start_at<?", (now() - 6 * 3600,)).fetchall()
    for (rid,) in stale:
        if rid in recovered or rid in unowned:
            continue
        actions.append(f"{'would mark' if dry else 'mark'} local run {rid} lost")
        if not dry:
            _mark_lost(con, rid)
    # Foreground/--bg runs that never got a box (client died while waiting in the pool): nothing remote to check.
    # Old clients without a PID retain the legacy age limit; a live queued client can wait longer at home.
    nobox = con.execute("SELECT run_id,start_at FROM runs WHERE mode IN ('fg','bg') AND box_id IS NULL "
                        "AND client_pid IS NULL AND status IN ('starting','running') AND start_at<?", (now() - 2 * 3600,)).fetchall()
    for rid, start_at in nobox:
        if rid in recovered or rid in unowned:
            continue
        actions.append(f"{'would mark' if dry else 'mark'} no-box run {rid} lost")
        if not dry:
            _mark_lost(con, rid, "client ended before it got a box", no_box=True, expected_client=(None, start_at))
    # A no-box run whose own `offbox run` client is gone never got a box: mark it lost now, not after 2 h.
    from .misc import _client_alive
    orphan = [tuple(r) for r in con.execute(
        "SELECT run_id, client_pid, start_at FROM runs WHERE mode IN ('fg','bg') AND box_id IS NULL "
        "AND status IN ('starting','running') AND client_pid IS NOT NULL").fetchall()]
    for rid, pid, start_at in orphan:
        if rid in recovered or rid in unowned:
            continue
        if _client_alive(pid, start_at):
            continue
        actions.append(f"{'would mark' if dry else 'mark'} no-box run {rid} lost (client {pid} gone)")
        if not dry:
            _mark_lost(con, rid, "client ended before it got a box", no_box=True, expected_client=(pid, start_at))
    start_budget = {'checks': START_CHECKS_PER_PASS}
    pooled = {r[0] for r in con.execute('SELECT box_id FROM pool_members')}
    snap = capacity.snapshot(con)
    protected = _protected(con)
    try:
        live = {b["id"]: b for b in api.list_boxes()}
    except OffboxError as e:
        return [f"{api.NAME} list failed: {e}"]

    def act(box_id, what, why, fn, expected=None):
        line = f"{'would ' if dry else ''}{what} {box_id}: {why}"
        actions.append(line)
        if not dry:
            try:
                with file_lock('box-'+box_id, timeout=0):
                    if con.execute("SELECT 1 FROM kv WHERE k=?", (f"resume_unanswered:{box_id}",)).fetchone():
                        actions[-1] += ' (unanswered resume; skipped)'
                        return
                    if lease.active_runs(con, box_id):
                        actions[-1] += ' (busy; skipped)'
                        return
                    current = con.execute('SELECT * FROM leases WHERE box_id=?', (box_id,)).fetchone()
                    if current and (current['note'] or '').startswith((BOX_WEDGED_NOTE, 'disk-full:')):
                        from . import box_disk
                        if (current['note'] or '').startswith(box_disk.NOTE) and what == 'refresh':
                            fn()
                            return
                        if ((current['note'] or '').startswith(box_disk.NOTE) and not box_disk.safe_to_stop(box_id)):
                            box_disk.keep_running(con, box_id)
                            actions[-1] += ' (disk_full; live holders or unknown activity; kept)'
                            return
                        if what == 'stop':
                            lease.stop_box(con, box_id, 'reap: box-wedged', images=False, locked=True)
                        actions[-1] += ' (set aside; stale action skipped)'
                        return
                    if expected is not None and (not current or any(current[k] != expected[k] for k in
                            ('last_used_at', 'created_at', 'pinned_until', 'thread_gone_since'))):
                        actions[-1] += ' (lease changed; stale action skipped)'
                        return
                    fn()
            except OffboxError as e:
                event(con, box_id, f"reap_{what}_failed", f"{why}: {e}")
                actions[-1] += f" (FAILED: {e})"

    refreshes = 0  # resume+stop of pinned leases near boat's 14-day limit; a few per pass (120 s budget)
    # A lease with an open prune hold stays on the list even if it is marked deleted: its hold is released only
    # after fresh confirmation, and a failed or busy release must be retried on a later pass.
    # `live` is what this process's token can see. On the home server that is one owner's boxes, while the database
    # holds every owner's leases: only this owner's are compared with it (mine()). 12 Nov: a pass with our token
    # did not find Moni's box in its list, forgot her lease, and her next call made a second, empty box.
    rows = con.execute("SELECT * FROM leases WHERE (state IN ('running','stopped') "
                       f"OR box_id IN (SELECT box_id FROM prune_holds)) AND {mine()}").fetchall()
    _renew_live_runs(con, rows, live, protected, dry)
    if not dry:
        _recheck_prune_holds(con, actions)
    for r in rows:
        bid = r["box_id"]
        b = live.get(bid)
        if con.execute("SELECT 1 FROM kv WHERE k=?", (f"resume_unanswered:{bid}",)).fetchone():
            if not dry and (r['note'] or '').startswith('disk-full:'):
                if api.left() is not None and api.left() <= 0.05:
                    actions.append('defer retired resumes: maintenance budget exhausted')
                    return actions
                try:
                    with file_lock('box-' + bid, timeout=0):
                        lease.reconcile_retired_resume(con, bid)
                except OffboxError as error:
                    event(con, bid, 'resume_reconcile_deferred', str(error))
            actions.append(f"defer {bid}: unanswered resume needs reconciliation")
            continue
        if bid in protected:
            continue
        if (b is None or b.get('dataExpiredAt')) and lease.pinned_until(con, bid) > now():
            actions.append(f"keep {bid}: pinned; backend miss does not retire its lease")
            continue
        if b is None:
            if not dry:
                # Release first. The lease is retired only once no hold remains: a busy lock or a failed read keeps
                # the hold and the lease state, so a later pass finds it again and retries.
                if lease.release_if_confirmed(con, bid):
                    try:
                        lease.forget_box(con, bid, "reap_forget", f"box no longer exists on {api.NAME}")
                    except lease.PinnedLeaseError as pin:
                        actions.append(f"keep {bid}: {pin}")
                        continue
                    actions.append(f"forget {bid}: gone from {api.NAME}")
                else:
                    actions.append(f"hold kept {bid}: gone from {api.NAME}, not yet confirmed")
            else:
                actions.append(f"forget {bid}: gone from {api.NAME}")
            continue
        if b.get("dataExpiredAt"):
            # Same release rule as a box gone from boat: nothing can run on a box whose data is deleted, but the
            # hold goes only after a locked, fresh confirmation; a busy lock leaves it for a later pass.
            if not dry:
                if lease.release_if_confirmed(con, bid):
                    try:
                        lease.forget_box(con, bid, "reap_expired", f"{api.NAME} deleted its data at {b['dataExpiredAt']}")
                    except lease.PinnedLeaseError as pin:
                        actions.append(f"keep {bid}: {pin}")
                        continue
                    actions.append(f"forget {bid}: {api.NAME} deleted its data")
                else:
                    actions.append(f"hold kept {bid}: {api.NAME} deleted its data, not yet confirmed")
            else:
                actions.append(f"forget {bid}: {api.NAME} deleted its data")
            continue
        state = b.get("state")
        running_runs = lease.active_runs(con, bid)
        if running_runs:
            _check_stale_runs(con, bid, state, dry, actions, start_budget)
            running_runs = lease.active_runs(con, bid)
            # Failed history reconciliation must not be overwritten by release_if_confirmed's generic lost update.
            if running_runs:
                continue
        # A failed stop is retried without asking Docker; never refresh or automatically delete a wedged box.
        note = con.execute('SELECT note FROM leases WHERE box_id=?', (bid,)).fetchone()[0] or ''
        if note.startswith('disk-full:'):
            stopped = iso_ts(b.get('stoppedAt'))
            if ((r['pinned_until'] or 0) > now() and state in api.STOPPED_STATES and stopped and
                    now() - stopped > KEEPALIVE_S and refreshes < 2):
                refreshes += 1
                act(bid, 'refresh', 'disk_full pinned disk retention',
                    lambda bid=bid: lease.refresh_box(con, bid), expected=r)
        if note.startswith((BOX_WEDGED_NOTE, 'disk-full:')):
            if not running_runs and state in api.LIVE_STATES:
                act(bid, 'stop', 'set aside: box-wedged',
                    lambda bid=bid: lease.stop_box(con, bid, 'reap: box-wedged', images=False, locked=True))
            continue
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
                lambda bid=bid: lease.delete_box(con, bid, "reap: thread archived 7d"), expected=r)
            continue
        if idle > UNUSED_DELETE_S and not pinned:
            act(bid, "delete", f"unused {round(idle / 86400, 1)}d, not pinned",
                lambda bid=bid: lease.delete_box(con, bid, "reap: unused 30d"), expected=r)
            continue
        if state in api.LIVE_STATES and idle <= idle_limit and not dry and not running_runs:
            # Docker boxes get boat-ttl grace so this reaper's stop (which archives images first) wins.
            lease.ensure_ttl(bid, max(60, int(idle_limit-idle)) + (300 if docker else 0), b)
        if state in api.LIVE_STATES and idle > idle_limit:
            act(bid, "stop", f"idle {int(idle // 60)}m",
                lambda bid=bid: lease.stop_box(con, bid, "reap: idle", locked=True), expected=r)  # act() holds box-<id>
        stopped = iso_ts(b.get("stoppedAt"))
        if pinned and state in api.STOPPED_STATES and stopped and now() - stopped > KEEPALIVE_S and refreshes < 2:
            refreshes += 1
            act(bid, "refresh", f"pinned, stopped {round((now() - stopped) / 86400, 1)}d",
                lambda bid=bid: lease.refresh_box(con, bid), expected=r)
    # Boxes whose recipe was cancelled (lease._retire_recipe_box) and whose delete failed then: delete them now.
    # 'bringing_up' rows are left behind by a bring-up that never finished (Ctrl-C, SIGTERM, a tool timeout): the
    # recipe cannot be trusted, so the box is retired like a quarantined one.
    # A live acquisition holds its bring-up lock (_bringup_lock) for the whole bring-up, so cleanup takes that same
    # lock without waiting and re-reads the row under it. A selection made before the lock is stale: a row that became
    # running (or was reused) is skipped, never deleted.
    for r in con.execute("SELECT box_id, owner, repo_root, state FROM leases "
                         f"WHERE state IN ('quarantined','bringing_up') AND {mine()}").fetchall():
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


def _renew_live_runs(con, rows, live: dict, protected: set[str], dry: bool) -> None:
    if dry:
        return
    running = {r[0] for r in con.execute("SELECT DISTINCT box_id FROM runs WHERE status='running'")}
    boxes = sorted(r['box_id'] for r in rows if r['box_id'] in running and r['box_id'] not in protected
                   and (b := live.get(r['box_id'])) and b.get('state') in api.LIVE_STATES
                   and not b.get('dataExpiredAt') and not con.execute(
                       "SELECT 1 FROM kv WHERE k=?", (f"resume_unanswered:{r['box_id']}",)).fetchone())
    cursor = con.execute("SELECT v FROM kv WHERE k='reap:renew_cursor'").fetchone()
    if cursor:
        boxes = [bid for bid in boxes if bid > cursor[0]] + [bid for bid in boxes if bid <= cursor[0]]
    with api.budget(RENEW_BUDGET_S):
        for bid in boxes:
            if api.left() < RENEW_BOX_BUDGET_S:
                break
            # Persist before I/O so timeouts or a killed pass cannot restart at the same slow prefix forever.
            con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('reap:renew_cursor',?)", (bid,))
            con.commit()
            with api.budget(RENEW_BOX_BUDGET_S):
                _keep_live_runs(con, bid, live[bid], dry)


def _keep_live_runs(con, bid: str, box: dict, dry: bool) -> None:
    from .runs import remote_alive
    from . import start_check
    if dry or box.get('state') not in api.LIVE_STATES:
        return
    for run in con.execute("SELECT * FROM runs WHERE box_id=? AND status='running'", (bid,)).fetchall():
        if now() - (run['start_at'] or 0) >= ORPHAN_RUN_MAX_S:
            inserted = con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)',
                                   (f"run_orphan_cap:{run['run_id']}", '1')).rowcount
            con.commit()
            if inserted:
                event(con, bid, 'run_orphan_cap', run['run_id'])
            continue
        pid = start_check.api_pid(con, run)
        if not pid:
            if start_check.recovery_marked(con, run):
                lease.ensure_ttl(bid, RUN_TTL_S, box)
                return
            continue
        try:
            with api.budget(10):
                st = api.cmd_status(bid, pid, timeout=5, retries=0)
                alive = bool(st and st.get('running') is True)
                # A missing/lost tracker is not evidence of death; #770's wrapper marker is independent.
                if not alive and (st is None or st.get('status') == 'lost'):
                    left = api.left()
                    alive = bool(left and left > 0 and remote_alive(bid, run['run_id'], timeout=min(5, left)) == 'alive')
                if alive:
                    # Background startup may have extended the deadline since list_boxes() took its snapshot.
                    current = api.get(bid)
                    if current and current.get('state') in api.LIVE_STATES:
                        lease.ensure_ttl(bid, RUN_TTL_S, current)
                    return
        except OffboxError:
            continue


def _check_stale_runs(con, bid: str, state: str, dry: bool, actions: list[str], budget=None) -> None:
    try:
        with file_lock('box-'+bid, timeout=0), api.budget(RENEW_BOX_BUDGET_S + 10):
            _check_unlocked(con, bid, state, dry, actions, budget)
    except OffboxError:
        pass


def _check_unlocked(con, bid: str, state: str, dry: bool, actions: list[str], budget=None) -> None:
    """Runs marked running on a box that is stopped, or whose process ended while nobody was attached."""
    require_mine(con, bid)
    from .runs import EXIT_REPO_SETUP, REPO_SETUP_FAILED_MARKER, finish, restore_run_state, completed_result, terminal_result
    from .runs import confirmed_lost, reconcile_lost
    from . import start_check
    from .misc import _client_alive
    budget = budget if budget is not None else {'checks': START_CHECKS_PER_PASS}
    if not dry and state in api.STOPPED_STATES and con.execute(
            "SELECT 1 FROM kv WHERE k LIKE 'start_unknown:%' AND v=?", (bid,)).fetchone():
        for row in con.execute('SELECT * FROM runs WHERE box_id=?', (bid,)).fetchall():
            if row['process_id'] and start_check.api_pid(con, row) is None:
                start_check.remember_wrapper(con, row, None)
        con.commit()
        lease._release_locked(con, bid)
    if not dry:
        reconcile_lost(con, bid, state=state, foreign=True)
    from .runs import EXIT_REPO_SETUP, REPO_SETUP_FAILED_MARKER
    for run in con.execute("SELECT * FROM runs WHERE box_id=? AND (status IN ('starting','running') OR "
                           "(status='infra' AND EXISTS (SELECT 1 FROM kv WHERE k='start_unknown:' || runs.run_id)))",
                           (bid,)).fetchall():
        saved = restore_run_state(run)
        if terminal_result(saved):
            if not dry:
                finish(run['run_id'], saved['exit_code'], saved['status'])
            actions.append(f"{'would repair' if dry else 'repair'} run {run['run_id']} exit={saved['exit_code']}")
            continue
        run = saved
        status, code = None, None
        pid = start_check.api_pid(con, run)
        unattached = con.execute('SELECT 1 FROM kv WHERE k=?', (f"start_unattached:{run['run_id']}",)).fetchone()
        if (run['status'] == 'starting' and not pid) or unattached or (not pid and start_check.recovery_marked(con, run)):
            age = now() - (run['start_at'] or 0)
            orphan = bool(run['error']) or not _client_alive(run['client_pid'], run['start_at'])
            if orphan and age >= START_GRACE_S:
                if dry:
                    actions.append(f"would check run {run['run_id']} on {bid} over ssh")
                    continue
                left = api.left()
                if budget['checks'] <= 0 or (left is not None and left < start_check.SSH_TIMEOUT_S + 2):
                    continue
                budget['checks'] -= 1
                modern = start_check.claims_enabled(con, run['run_id'])
                result = (start_check.check(bid, run['run_id'], claim=modern)
                          if state in api.LIVE_STATES else start_check.Result())
                # Legacy wrappers cannot be fenced; receipts are still authoritative.
                if modern or result.code is not None:
                    start_check.settle(con, run, result, run['error'] or 'client ended before the command started',
                                       until=None if api.left() is None else now() + max(0, api.left()),
                                       foreign=True)
                    actions.append(f"settled run {run['run_id']} on {bid}: {result.verdict} exit={result.code}")
                    continue
            if state in api.LIVE_STATES and not pid:
                continue
            if age < 3600 or not orphan:
                continue
        if state in api.STOPPED_STATES or state in ('error','cancelled'):
            status = "lost"
            if run['command_id']:
                # Process status can disappear on stop; retained history survives it without resuming the box.
                try:
                    st = api.cmd_status(bid, pid) if pid else None
                    code = st.get('exitCode') if st else None
                except OffboxError:
                    continue
                if st:
                    if not dry:
                        from .runs import remember_interruption
                        remember_interruption(run['run_id'], st)
                    if st.get('running') is True:
                        continue
                    if st.get('status') == 'interrupted':
                        status, code = 'interrupted', EXIT_INTERRUPTED
        elif state not in api.LIVE_STATES:
            continue
        elif pid:
            try:
                st = api.cmd_status(bid, pid)
            except OffboxError:
                continue
            if st is None:
                # Missing/unavailable status is not proof a process stopped.
                continue
            if not dry:
                from .runs import remember_interruption
                remember_interruption(run['run_id'], st)
            if not st.get("running") and st.get('status') == 'interrupted':
                # The server settled the interruption without retrying the command.
                status, code = 'interrupted', EXIT_INTERRUPTED
            elif not st.get("running") and st.get('status') in ('exited','lost'):
                if st.get('status') == 'lost':
                    try:
                        confirmed = confirmed_lost(bid, run['run_id'], record=not dry)
                    except OffboxError:
                        continue
                    if confirmed is None:
                        continue
                    st = {**st, **confirmed}
                status, code = completed_result(run, st)
                # Detached runs may have no local log yet; cmd_status includes the remote stderr tail.
                if (st.get('status') == 'exited' and code == EXIT_REPO_SETUP
                        and REPO_SETUP_FAILED_MARKER in (st.get('stderr') or '').splitlines()):
                    status, code = 'infra', EXIT_INFRA
        elif run['error']:
            # Ambiguous cmd_start: quarantine until the box stops, never free it for another sync.
            continue
        elif now() - (run["start_at"] or 0) > 3600:
            status = "infra"
        if status:
            if code is None and run['command_id']:
                try:
                    code = (api.history_get(bid, run['command_id']) or {}).get('exitCode')
                except OffboxError:
                    continue
            actions.append(f"{'would mark' if dry else 'mark'} run {run['run_id']} {status}")
            if not dry:
                if code == 97:
                    from .runs import settle_box_wedged, wedged_message
                    wedged = settle_box_wedged(con, run, code)
                    if wedged:
                        actions.append(wedged_message(bid, *wedged))
                        continue
                from .runs import killed_result
                killed = killed_result(run['run_id'], wait=True, row=run, known_code=code) if code in (None, 137, 143) else None
                if killed is not None and killed['process_id']:
                    status, code = 'killed', killed['exit_code']
                if run['mode'] == 'bg' and status in ('done','failed','killed') and run['pulls']:
                    import json
                    from .runs import do_pulls
                    try:
                        do_pulls(bid, dict(run), json.loads(run['pulls']), foreign=True)
                    except (OffboxError, OSError, sqlite3.Error) as error:
                        if killed is None:
                            raise
                        say(f"warning: {run['run_id']}: artifact pull after offbox kill failed ({error})")
                from .runs import planned_steps
                code = finish(run['run_id'], code, status, run=run, bookkeeping=False, report=True)
                try:
                    settled = con.execute('SELECT * FROM runs WHERE run_id=?', (run['run_id'],)).fetchone()
                except sqlite3.Error as error:
                    from .runs import state_warning
                    state_warning(run['run_id'], code, error)
                    settled = run
                if settled['status'] == 'killed':
                    from .runs import report_killed
                    report_killed(settled)
                    status = 'killed'
                    actions[-1] = f"mark run {run['run_id']} killed by offbox kill exit={code}"
                elif planned_steps(run):
                    status = 'infra' if code is None else ('done' if code == 0 else 'failed')
                try:
                    from .misc import _catch_up_finished
                    _catch_up_finished(con, run['run_id'])
                    event(con, bid, "run_reaped", f"{run['run_id']} {status} exit={code}")
                    if state in api.LIVE_STATES:
                        from .runs import settle_docker
                        settle_docker(con, run, status)
                        # The client died: shorten the run TTL to the idle window.
                        lease.idle_ttl(bid)
                except sqlite3.Error as error:
                    from .runs import state_warning
                    state_warning(run['run_id'], code, error)


def print_actions(actions: list[str]) -> None:
    if not actions:
        say("reap: nothing to do")
    for a in actions:
        print(a)
