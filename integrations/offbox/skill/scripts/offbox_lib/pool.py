"""Bounded repository pools; one run per box (including sync and artifact pulls)."""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import os
import sqlite3
import traceback
from pathlib import Path
import time

from . import common, capacity, prepare, home
from .common import (BOX_WEDGED_NOTE, DEAD_MOUNT_NOTE, EXIT_BUSY, EXIT_INFRA, EXIT_LOCAL, RUN_TTL_S, SIZES, TOO_BIG_NOTE, OffboxError, db, file_lock, new_id,
                     busy, db_retry, iso, kv_get, kv_set, local_error, log, now, say, write)
from .common import backend, owner_scoped, token_owner
from .common import mine as token_mine  # `mine` is a local name here (the caller's own boxes)
from .identity import normalize_repo_name, remote_dir_for

WAIT_DEFAULT_S = 600
WAIT_MAX_S = 1200
# At home a full pool is a queue, not a refusal (owner, 13 Nov 2026: no caps, agents wait for a slot). The server
# has its own memory queue behind this one. The numbers above are for the Boat standby, where a box costs money.
HOME_WAIT_S = 86400
HOME_POOL_SIZE, HOME_POOL_MAX = 8, 64
PROGRESS_EVERY_S = 60
AFFINITY_WAIT_S = 60
LOCK_WAIT_S = 30
# A create slot is claimed under the pool lock and the box is made after it. A slot whose process died is dropped at
# once; the age bound only covers a reused pid (a recipe bring-up can take ~30 min).
PENDING_MAX_S = 3600
POLL_BUSY_MS = 150
_PIN_SKIPS = contextvars.ContextVar('pool_pin_skips', default=None)


def _pin_available(con, box_id, me=None, *, record=True):
    from . import lease
    pin = lease.foreign_pin(con, box_id, me)
    if not pin:
        return True
    seen = _PIN_SKIPS.get()
    if record and seen is not None and box_id not in seen['boxes']:
        seen['boxes'].add(box_id)
        detail = json.dumps(dict(run=seen['run'], owner=pin[0], until=iso(pin[1])))
        if not seen['run'] or not con.execute(
                "SELECT 1 FROM events WHERE box_id=? AND kind='pool_skip_pinned' "
                "AND CASE WHEN json_valid(detail) THEN json_extract(detail, '$.run') END=?",
                (box_id, seen['run'])).fetchone():
            common.event(con, box_id, 'pool_skip_pinned', detail)
    return False


class PoolBusyError(capacity.CapacityError):
    """Every pool box stayed busy for the whole queue wait. Nothing ran; not a boat failure."""

    def __init__(self, msg: str):
        super().__init__(msg, code=EXIT_BUSY)


def at_home() -> bool:
    return backend() == "server"


def wait_max() -> int:
    return HOME_WAIT_S if at_home() else WAIT_MAX_S


def wait_seconds() -> int:
    return capacity.setting("OFFBOX_POOL_WAIT_SECONDS", HOME_WAIT_S if at_home() else WAIT_DEFAULT_S, minimum=0,
                            maximum=wait_max())


def pool_size() -> int:
    """Boxes one repository pool may have. More callers than that wait for one of them."""
    if at_home():
        return capacity.setting("OFFBOX_POOL_SIZE", HOME_POOL_SIZE, maximum=HOME_POOL_MAX)
    return capacity.setting("OFFBOX_POOL_SIZE", 4, maximum=16)


def _span(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds}s" if seconds < 3600 else f"{seconds // 3600}h{seconds % 3600 // 60:02d}m"


def _queue_key(key):
    # Home tokens cannot share boxes, even when their checkouts have the same repository key.
    return f"{token_owner()}:{key}" if owner_scoped() else key


def _unreserve(con, token):
    con.execute("UPDATE pool_waiters SET reserved=0 WHERE token=?", (token,))
    con.commit()


def _unreserve_and_release(con, token, guard):
    try:
        _unreserve(con, token)
    finally:
        guard.__exit__(None, None, None)


def _waiters(con, key):
    with write(con):
        key = _queue_key(key)
        rows = con.execute("SELECT * FROM pool_waiters WHERE pool_key=? "
                           "ORDER BY queued_at,rowid", (key,)).fetchall()
        live = []
        for row in rows:
            if _alive(row['pid']):
                if not row['reserved']:
                    live.append(row)
            else:
                con.execute("DELETE FROM pool_waiters WHERE token=?", (row['token'],))
        return live


def pool_cap(con, key):
    """Keep one effective cap; contributions outlive detached clients only while their run holds a box."""
    with write(con):
        key = _queue_key(key)
        live = []
        for row in con.execute("SELECT * FROM pool_cap_callers WHERE pool_key=?", (key,)).fetchall():
            if row['granted'] and row['run_id']:
                # Match lease.active_runs for this caller's run, rather than another run that reused its box.
                active = con.execute("SELECT 1 FROM runs WHERE run_id=? AND box_id IS NOT NULL AND "
                                     "(status IN ('starting','running') OR EXISTS "
                                     "(SELECT 1 FROM kv WHERE k='start_unknown:' || runs.run_id) OR "
                                     "(status='lost' AND exit_code IS NULL AND NOT EXISTS "
                                     "(SELECT 1 FROM kv WHERE k='lost_confirmed:' || runs.run_id)))",
                                     (row['run_id'],)).fetchone() is not None
            else:
                active = _alive(row['pid'])
            if active:
                live.append(row)
            else:
                con.execute("DELETE FROM pool_cap_callers WHERE token=?", (row['token'],))
        winner = max(live, key=lambda r: r['cap']) if live else None
        limit = HOME_POOL_MAX if at_home() else 16
        cap = min(limit, winner['cap']) if winner else (HOME_POOL_SIZE if at_home() else 4)
        con.execute("INSERT OR REPLACE INTO pool_caps VALUES (?,?,?,?)",
                    (key, cap, winner['pid'] if winner else None, now()))
        return cap


def _older(con, key, token, row=None):
    """Every size can grow/resume, as in candidates(); a create slot can serve every source."""
    for waiter in _waiters(con, key):
        if waiter['token'] == token:
            return False
        if row is not None:
            from . import lease
            owner = con.execute('SELECT owner FROM runs WHERE run_id=?', (waiter['run_id'],)).fetchone()
            if lease.foreign_pin(con, row['box_id'], dict(owner=owner[0]) if owner else None):
                continue
        if row is None or _matches(row, waiter['source']):
            return True
    return False


def _matches(row, source):
    return not source or (row['source'] or '').replace('recipe:', 'template:', 1) == source


def queue_state(con, key, run_id=None, *, source=None, size=None, token=None):
    pool_cap(con, key)
    _waiters(con, key)
    _pending(con, key)
    # Member adoption and pending-slot removal commit together. Read both from one SQLite snapshot,
    # even when the queue deadline leaves no time to take the pool lock for a progress/timeout line.
    con.execute('BEGIN')
    try:
        return _queue_snapshot(con, key, run_id, source, token)
    finally:
        con.commit()


def _queue_snapshot(con, key, run_id, source, token):
    from . import lease
    rows = members(con, key)
    busy = held = unusable = idle = 0
    for row in rows:
        bid = row['box_id']
        active = lease.active_runs(con, bid)
        guard = file_lock('box-' + bid, timeout=0)
        locked = False
        try:
            guard.__enter__()
        except OffboxError:
            locked = True
        else:
            guard.__exit__(None, None, None)
        if active or locked:
            busy += 1
        elif con.execute("SELECT 1 FROM prune_holds WHERE box_id=?", (bid,)).fetchone():
            held += 1
            unusable += 1
        elif not _pin_available(con, bid, record=False) or not _matches(row, source):
            unusable += 1
        else:
            idle += 1
    queue_key = _queue_key(key)
    waiters = con.execute("SELECT * FROM pool_waiters WHERE pool_key=? AND reserved=0 ORDER BY queued_at,rowid",
                          (queue_key,)).fetchall()
    place = next((i for i, w in enumerate(waiters, 1)
                  if w['token'] == token or (run_id and w['run_id'] == run_id)), None)
    pending = con.execute("SELECT COUNT(*) FROM pool_pending WHERE pool_key=?", (key,)).fetchone()[0]
    cap = con.execute("SELECT cap FROM pool_caps WHERE pool_key=?", (queue_key,)).fetchone()[0]
    return dict(busy=busy, idle=idle, unusable=unusable, pending=pending, cap=cap,
                held=held, total=len(rows), serving=sum(_matches(r, source) for r in rows),
                place=place, waiting=len(waiters))


def _queue_line(state, source=None):
    cap = state['cap']
    surplus = max(0, state['total'] - cap)
    reason = f" ({cap}-box pool + {surplus} legacy/surplus member(s))" if surplus else ''
    if state['total'] + state['pending'] > cap and state['pending']:
        reason += f" (cap fell with {state['pending']} create(s) in progress)"
    line = (f"{state['busy']} busy{reason} + {state['unusable']} idle that can't serve this run "
            f"(other template/base/size or checkout cleanup) + {state['pending']} being created")
    if state['idle']:
        line += f" + {state['idle']} idle compatible"
    line += f" / {cap}-box pool"
    if source:
        line += f"; {state['serving']} of {state['total']} members can serve {source}"
    if state['held']:
        line += f"; {state['held']} held by checkout cleanup"
    if state['place'] is not None:
        line += f"; #{state['place']} of {state['waiting']}"
    return line


def split_pool_notice(con, me) -> str:
    """Name legacy basename-pool boxes without transferring ownership or bypassing either pool's cap."""
    root = me['repo_root']
    fallback = normalize_repo_name(Path(root).name)
    if fallback == me['repo_key']:
        return ''
    rows = con.execute("""SELECT l.box_id, l.state FROM leases l JOIN pool_members p USING(box_id)
        WHERE l.repo_root=? AND l.repo_key=? AND p.pool_key=? AND l.state IN ('running','stopped')
        ORDER BY l.box_id""", (root, fallback, fallback)).fetchall()
    if not rows:
        return ''
    boxes = ', '.join(f"{r['box_id']} (pool {fallback}, {r['state']})" for r in rows)
    return f". Split-off boxes for this checkout: {boxes}"


def lock_name(key: str) -> str:
    return "pool-" + hashlib.sha256(key.encode()).hexdigest()[:20]


@contextlib.contextmanager
def _pool_lock(key: str, deadline: float, wait: int, *, prepare_end: float | None = None,
               box_id: str = "repository pool", check_home=None):
    """Queue expiry means busy; a selected box's readiness deadline also bounds its claim."""
    from . import allocation
    continuation = prepare.guard(box_id, prepare_end) if prepare_end is not None else contextlib.nullcontext()
    with continuation:
        acquired = False
        try:
            while not acquired:
                allocation.check_source()
                if check_home is not None:
                    check_home()
                started = time.monotonic()
                timeout = min(LOCK_WAIT_S, max(0, deadline - started))
                queue = allocation._QUEUE.get()
                if queue is not None and queue.get('check_source') is not None:
                    timeout = min(2, timeout)
                lk = file_lock(lock_name(key), timeout=timeout)
                try:
                    with prepare.guard(box_id), prepare.phase("lock_wait", box_id):
                        lk.__enter__()
                        acquired = True
                except prepare.Stalled:
                    raise
                except OffboxError as e:
                    if time.monotonic() < deadline:
                        continue
                    if check_home is not None and wait > 0:
                        check_home(force=True)
                    if timeout >= LOCK_WAIT_S and time.monotonic() - started >= LOCK_WAIT_S:
                        detail = f"other offbox runs kept its pool lock for {LOCK_WAIT_S}s"
                    else:
                        detail = "boxes stayed busy; remote queue timed out"
                    hint = ("leave it waiting with --bg and `offbox wait <run>`" if at_home() else
                            f"retry, or raise OFFBOX_POOL_WAIT_SECONDS (max {wait_max()})")
                    raise PoolBusyError(f"repository pool busy/full for {key}: {detail}. "
                                        f"Nothing ran (exit {EXIT_BUSY}): {hint}") from e
            allocation.check_source()
            yield
        finally:
            if acquired:
                lk.__exit__(None, None, None)


def _alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (PermissionError, TypeError, ValueError, OverflowError):
        pass
    return True


def _pending(con, key) -> int:
    """Pool boxes being created right now (their slots count toward the cap). Dead or too old slots are dropped."""
    n = 0
    for r in con.execute("SELECT token, pid, created_at FROM pool_pending WHERE pool_key=?", (key,)).fetchall():
        if now() - r["created_at"] < PENDING_MAX_S and _alive(r["pid"]):
            n += 1
        else:
            with write(con):
                con.execute("DELETE FROM pool_pending WHERE token=?", (r["token"],))
    return n


TOO_BIG_LIKE = f"{TOO_BIG_NOTE}%"  # a box marked too big frees its pool slot and is never offered again
DEAD_LIKE = f"{DEAD_MOUNT_NOTE}%"  # same for a box whose filesystem died
WEDGED_LIKE = f"{BOX_WEDGED_NOTE}%"


def members(con, key):
    # token_mine(): on the home server a pool only holds this token owner's boxes, even when two owners' checkouts share
    # a repository key. Another owner's box answers 404 to our token, which reads as "gone".
    return con.execute(f"""SELECT l.* FROM leases l JOIN pool_members p USING(box_id)
        WHERE p.pool_key=? AND {token_mine('l')} AND l.state IN ('running','stopped') AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM kv WHERE k='boot_dead:' || l.box_id)
        ORDER BY (l.state='running') DESC, l.last_used_at DESC""", (key, TOO_BIG_LIKE, DEAD_LIKE, WEDGED_LIKE)).fetchall()


def _source_member(con, key, source) -> bool:
    if any(_matches(r, source) for r in members(con, key)):
        return True
    # A box from this source still being created by another caller: waiting for it can help.
    return _pending(con, key) > 0 and con.execute("SELECT 1 FROM pool_pending WHERE pool_key=? AND source=?",
                                                  (key, source)).fetchone() is not None


def _room(con, key) -> bool:
    return len(members(con, key)) + _pending(con, key) < pool_cap(con, key)


def own_boxes(con, me):
    if not me or not me.get("owner") or not me.get("repo_root"):
        return set()
    return {r[0] for r in con.execute("SELECT box_id FROM pool_callers WHERE owner=? AND repo_root=?",
                                     (me["owner"], me["repo_root"]))}


def candidates(con, key, size, source, me=None):
    from . import lease
    # Existing boxes count toward the cap once adopted; surplus legacy boxes are left intact.
    rows = con.execute(f"""SELECT l.*, p.pool_key FROM leases l LEFT JOIN pool_members p USING(box_id)
        WHERE l.repo_key=? AND {token_mine('l')} AND l.state IN ('running','stopped')
        AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM bases b WHERE b.box_id=l.box_id)
        AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.box_id=l.box_id)
        AND (EXISTS (SELECT 1 FROM pool_callers c WHERE c.box_id=l.box_id AND c.owner=? AND c.repo_root=?)
             OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.box_id=l.box_id AND r.status IN ('starting','running')))
        AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=l.box_id)
        ORDER BY (l.state='running') DESC, (l.size=?) DESC, l.last_used_at DESC""",
        (key, TOO_BIG_LIKE, DEAD_LIKE, WEDGED_LIKE, (me or {}).get("owner"), (me or {}).get("repo_root"),
         size)).fetchall()
    full = not _room(con, key)
    out = []
    for r in rows:
        if not _pin_available(con, r['box_id'], me):
            continue
        if lease.boot_dead(con, r['box_id']):
            continue
        if r["pool_key"] not in (None, key) or (full and r["pool_key"] is None):
            continue
        # A box built from a template's recipe (the template had expired) serves that template's runs too.
        if not _matches(r, source):
            continue
        out.append(r)
    # Running boxes first: the caller's own box (its checkout is already synced there), then the smallest that
    # fits. A running xlarge box this run doesn't need (grown for an earlier run) goes after a stopped box while
    # starts are plentiful, even when it is the caller's own: the stopped one resumes at the right size and the big
    # one stops on its short idle timer. 13 Oct - 5 Nov, 5,448 ordinary runs went to the caller's own grown xlarge
    # box. Only xlarge: a large box over a generic (default) box's size costs less than the resume.
    from . import lease
    rank = {n: i for i, n in enumerate(SIZES)}
    want = rank.get(size or "", 0)
    plentiful = capacity.starts_plentiful(capacity.snapshot(con))
    mine = own_boxes(con, me)

    def fit(r):
        have = rank.get(r["size"] or "default", 1)
        own = r["box_id"] in mine
        if at_home():
            return (int(r['state'] != 'running'), int(not own), int(have < want), have)
        oversized = have > max(want, rank.get(lease.natural_size(con, r), 1))
        if r["state"] == "running" and plentiful and oversized and (not own or r["size"] == "xlarge"):
            return (2, 0, have)
        needs_start = r["state"] != "running" or have < want
        target = lease.resume_size(con, r, size) if r["state"] != "running" else size
        if own and (not needs_start or (plentiful and lease.supply_size(target, size or "large") is not None)):
            return (-1, int(needs_start), have)
        if r["state"] != "running":
            return (1, 0, 0)
        if have < want:
            return (0, 2, have)
        return (0, 0 if own else 1, have)
    out.sort(key=fit)
    return out, not full


class _QueuePoll:
    def __init__(self, con, wait, run_id, *, deadline=None):
        self.con, self.run_id = con, run_id
        self.deadline = time.monotonic() + wait if deadline is None else deadline

    def call(self, operation):
        # Only DB polling/selection uses this budget, never a machine start or a remote command.
        timeout = self.con.execute('PRAGMA busy_timeout').fetchone()[0]
        try:
            while True:
                self.con.execute(f'PRAGMA busy_timeout={POLL_BUSY_MS}')
                try:
                    return operation()
                except sqlite3.OperationalError as error:
                    if not busy(error):
                        raise
                    self.con.rollback()
                    from . import allocation
                    allocation.check_source()
                    log(f"pool queue {self.run_id or '-'} poll failed:\n" + traceback.format_exc())
                    left = self.deadline - time.monotonic()
                    if left <= 0:
                        raise local_error(error, run_id=self.run_id) from error
                    say(f"{self.run_id or 'pool queue'}: local state DB busy; still queued, retrying next poll")
                    time.sleep(min(2, left))
                    if time.monotonic() >= self.deadline:
                        raise local_error(error, run_id=self.run_id) from error
        finally:
            self.con.execute(f'PRAGMA busy_timeout={timeout}')


def _clear_queue_rows(con, me, run_id):
    def clear():
        with write(con):
            con.execute('DELETE FROM pool_pending WHERE pool_key=? AND pid=?', (me['repo_key'], os.getpid()))
            # A parallel run by the same owner may have claimed this checkout meanwhile.
            con.execute("DELETE FROM pool_callers WHERE owner=? AND repo_root=? AND NOT EXISTS "
                        "(SELECT 1 FROM runs WHERE owner=? AND repo_root=? AND run_id<>? "
                        "AND box_id IS NOT NULL AND status IN ('starting','running'))",
                        (me['owner'], me['repo_root'], me['owner'], me['repo_root'], run_id or ''))
    db_retry(clear)


def acquire(me, size=None, template=None, base=None, fresh=False, run_id=None, exclude=None, check_source=None):
    token = _PIN_SKIPS.set(dict(run=run_id, boxes=set()))
    try:
        return _acquire_with_pins(me, size, template, base, fresh, run_id, exclude, check_source)
    finally:
        _PIN_SKIPS.reset(token)


def _acquire_with_pins(me, size, template, base, fresh, run_id, exclude, check_source):
    import toollog
    handoff = None
    with toollog.span("pool", "run.lease", ids={"run": run_id}, tag="lease_failed") as data:
        started = time.monotonic()
        try:
            row = _acquire_logged(me, size, template, base, fresh, run_id, exclude, check_source)
        except home.FailbackReady as ready:
            handoff = ready
            data["props"]["outcome"] = "ready"
        except BaseException:
            toollog.emit("pool", "run.queue", kind="error", ok=False, duration_ms=(time.monotonic()-started)*1000,
                         ids={"run": run_id}, props={"queued": True, "waitMs": (time.monotonic()-started)*1000}, tag="queue_failed")
            raise
        if handoff is None:
            data["ids"] = {"run": run_id, "box": row["box_id"]}
            data["props"]["leaseKind"] = row.pop("_log_lease_kind", "reused")
            data["props"]["size"] = row.get("size")
            if data["props"]["leaseKind"] == "reused":
                from . import lease
                lease.report_reused_template(me, row, template)
            return row
    raise handoff


def _acquire_logged(me, size=None, template=None, base=None, fresh=False, run_id=None, exclude=None, check_source=None):
    from . import allocation
    con = db()
    token = new_id('waiter')
    queue_start = time.monotonic()
    granted, got = False, None
    key = me['repo_key']
    source = _source(key, template, base, fresh)
    try:
        with allocation.scope(key), allocation.queue(), prepare.attempts():
            queue = allocation._QUEUE.get()
            queue['check_source'] = check_source
            queue["log_setup_ms"] = 0
            poll = _QueuePoll(con, queue['wait'], run_id, deadline=queue['end'])
            poll.call(lambda: capacity.schema(con))
            def register():
                with write(con):
                    con.execute("INSERT INTO pool_waiters(pool_key,token,pid,run_id,queued_at,source,size) VALUES (?,?,?,?,?,?,?)",
                                (_queue_key(key), token, os.getpid(), run_id, now(), source, size))
                    con.execute("INSERT INTO pool_cap_callers(token,pool_key,pid,run_id,cap) VALUES (?,?,?,?,?)",
                                (token, _queue_key(key), os.getpid(), run_id, pool_size()))
            poll.call(register)
            while True:
                try:
                    got = _acquire(con, me, size, template, base, fresh, run_id, exclude, token)
                    poll.call(lambda: con.execute("UPDATE pool_cap_callers SET granted=1 WHERE token=?", (token,)))
                    granted = True
                    if home.failed_over():
                        import toollog
                        toollog.emit("backend", "backend.failover_queue_done", ids={"run": run_id},
                                     duration_ms=(time.monotonic()-queue_start)*1000, props={"outcome": "boat_box"})
                    if not run_id:
                        got['_pool_cap_token'] = token
                    import toollog
                    elapsed = max(0, (time.monotonic() - queue_start) * 1000 - queue["log_setup_ms"])
                    toollog.emit("pool", "run.queue", kind="perf", duration_ms=elapsed, ok=True,
                                 ids={"run": run_id}, props={"waitMs": elapsed, "queued": elapsed > 1000, "position": 1})
                    return got
                except prepare.Stalled as e:
                    con.execute("UPDATE leases SET state=CASE WHEN source LIKE 'recipe:%' THEN 'quarantined' "
                                "ELSE 'resume_stalled' END, note=? WHERE box_id=?", (str(e), e.box))
                    prepare.move_once(e)
                    say(f"{e}; trying once more")
                except PoolBusyError as e:
                    if 'kept its pool lock' not in str(e):
                        state = poll.call(lambda: queue_state(con, key, run_id, source=source, size=size, token=token))
                        import toollog
                        toollog.emit("pool", "run.queue", ids={"run": run_id}, ok=False,
                                     props={"queued": True, "position": state.get("place"),
                                            "waitMs": (time.monotonic()-queue_start)*1000})
                        e.args = (f"{e}; {_queue_line(state, source)}",)
                    raise
    except (sqlite3.Error, OffboxError) as error:
        if got is not None:
            release_guard(got)
        if isinstance(error, sqlite3.Error) or error.code == EXIT_LOCAL:
            log(f"pool queue {run_id or '-'} failed:\n" + traceback.format_exc())
            try:
                _clear_queue_rows(con, me, run_id)
            except sqlite3.Error:
                log(f"pool queue {run_id or '-'} cleanup failed:\n" + traceback.format_exc())
            if isinstance(error, sqlite3.Error):
                raise local_error(error, run_id=run_id) from error
        raise
    finally:
        def cleanup():
            with write(con):
                con.execute("DELETE FROM pool_waiters WHERE token=?", (token,))
                if not granted:
                    con.execute("DELETE FROM pool_pending WHERE pool_key=? AND pid=?", (_queue_key(key), os.getpid()))
                if not granted:
                    con.execute("DELETE FROM pool_cap_callers WHERE token=?", (token,))
        try:
            db_retry(cleanup)
        except sqlite3.Error:
            log(f"pool queue {run_id or '-'} caller cleanup failed:\n" + traceback.format_exc())
        con.close()


def _source(key, template, base, fresh):
    return ("fresh" if fresh else f"base:{base if ':' in base else key+':'+base}" if base else
            f"template:{template}" if template else None)


@contextlib.contextmanager
def _lease_work(*, selected=True):
    from . import allocation, home
    queue = allocation._QUEUE.get()
    started = time.monotonic()
    if queue is not None:
        if selected and home.failed_over():
            home.BOAT_SELECTED.set(True)
        queue["queue_wait_s"] = max(0, started - queue.get("started", queue["end"] - queue["wait"]) - queue.get('log_setup_ms', 0) / 1000)
        home.QUEUE_WAIT.set(queue["queue_wait_s"])
    try:
        yield
    finally:
        if queue is not None:
            queue["log_setup_ms"] = queue.get("log_setup_ms", 0) + (time.monotonic()-started)*1000


def _reuse_prepared(con, row, *args, **kwargs):
    from . import lease
    with _lease_work(), prepare.guard(row['box_id']) as budget:
        got = lease._reuse(con, row, *args, **kwargs)
        if got:
            got['_prepare_end'] = budget.end
        return got


def _reconcile_pinned(con, row):
    """Observe an abandoned start without resuming, preparing or handing out its pinned disk."""
    from . import allocation, api, lease
    bid = row['box_id']
    try:
        guard = file_lock('box-' + bid, timeout=0)
        guard.__enter__()
    except OffboxError:
        return
    try:
        with _lease_work(selected=False), prepare.guard(bid):
            try:
                confirmed, _ = lease._resume_confirmed(con, bid, RUN_TTL_S, None, pending=True, confirm_only=True)
                if confirmed and confirmed.get('state') in api.STARTING_STATES:
                    lease._wait_unanswered_resume(con, bid)
            except api.BoxBootFailed as error:
                lease._set_aside_boot(con, bid, error)
            except lease.ResumeStopped:
                pass  # Confirmed stopped; its pin and pool slot remain intact.
            except (allocation.Busy, allocation.Fenced, lease.ArchivingSkip):
                pass  # Another starter or a stopping box must not prevent use of a ready peer.
            except lease.ResumeProvisionStalled as error:
                con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?", (str(error), bid))
                con.commit()
    finally:
        guard.__exit__(None, None, None)


def _acquire(con, me, size, template, base, fresh, run_id, exclude=None, waiter=None):
    from . import allocation, api, home, lease, outage
    from .identity import require_proven
    # A pooled box is mapped to the caller's owner string. An unproven caller's string is shared, so it can't take one.
    require_proven(me, "run")
    lease.cap_check()
    key = me["repo_key"]
    source = _source(key, template, base, fresh)
    queue = allocation._QUEUE.get()
    wait = queue['wait']
    deadline = queue['end']
    poll = _QueuePoll(con, wait, run_id, deadline=deadline)
    poll.call(lambda: capacity.schema(con))
    poll.call(lambda: allocation.recover_resumes(con, key))
    started = queue.get('started', deadline - wait)
    protected_base = bool(base and not fresh and home.active() and home.base_needs_home(source[5:]))
    next_home_probe = time.monotonic() + outage.PROBE_EVERY_S
    failover = home.failed_over()
    probe_every = home.failback_probe_seconds()
    queue.setdefault("next_failback_probe", started + probe_every)

    def check_home(*, force=False):
        nonlocal next_home_probe
        if failover and not home.BOAT_SELECTED.get() and time.monotonic() >= queue["next_failback_probe"]:
            why = home.probe(timeout=min(5, home.PROBE_TIMEOUT_S), wait=False)
            t = time.monotonic()
            queue["next_failback_probe"] = t + probe_every
            import toollog
            toollog.emit("backend", "backend.failback_probe", ids={"run": run_id},
                         props={"ok": why is None, "class": (home.PROBE_FACTS.get() or {}).get("class", "hard"),
                                "waited_s": t-started})
            if why is None:
                state = poll.call(lambda: queue_state(con, key, run_id, source=source, size=size, token=waiter))
                raise home.FailbackReady(run_id, t-started, state)
        if not protected_base or (not force and time.monotonic() < next_home_probe):
            return
        # Foreground pool holders never reach _refresh_background's API checks. Probe without a pool lock.
        why = home.preflight_reason()
        next_home_probe = time.monotonic() + outage.PROBE_EVERY_S
        if why:
            raise OffboxError(f"home offbox server not reachable ({why})", outage=True, run_id=run_id)

    lock_options = {'check_home': check_home} if protected_base or failover else {}
    said, last_error = False, None
    next_refresh = 0
    next_progress = 0
    previous_state = None
    create_first = False
    resume_stall = None
    unusable = set(exclude or ())
    pending_retries = set()
    pending_busy = {}
    affinity_deadline = min(deadline, started + AFFINITY_WAIT_S)
    grew = False
    prune_checked = False
    mine = own_boxes(con, me)

    def before_grow(bid):
        nonlocal grew
        if bid in mine and time.monotonic() >= deadline:
            raise lease.ArchivingSkip(f"no time left to grow your box {bid}; trying a ready box", code=EXIT_BUSY)
        if grew:
            raise lease.ArchivingSkip("already stopped one pool box to grow; trying another ready box", code=EXIT_BUSY)
        grew = True

    def readiness_failed(row, error):
        bid = row['box_id']
        if bid not in mine:
            raise error
        if con.execute("SELECT 1 FROM kv WHERE k IN (?,?)",
                       (f"resume_unanswered:{bid}", f"resume_provision:{bid}")).fetchone():
            raise lease.ResumeUnresolved(f"{bid} still has an unanswered resume; nothing ran. Retry later", error) from error
        observed_size = error.state.get('type')
        known_size = observed_size if observed_size in SIZES else row['size']
        con.execute("UPDATE leases SET state='running', size=?, ssh_ready_at=NULL WHERE box_id=?", (known_size, bid))
        con.commit()
        unusable.add(bid)
        say(f"could not prepare your box {bid} ({error}); trying other pool boxes")

    while True:
        allocation.check_source()
        lease.cap_check()
        pending = poll.call(lambda: con.execute("SELECT l.* FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                              f"WHERE l.repo_key=? AND {token_mine('l')} AND l.state IN ('running','stopped') "
                              "AND COALESCE(l.note,'') NOT LIKE ? LIMIT 1", (key, WEDGED_LIKE)).fetchone())
        if create_first or (pending and (pending['box_id'] in unusable or
                                            pending_busy.get(pending['box_id'], 0) > time.monotonic())):
            pending = None
        if pending and not _pin_available(con, pending['box_id'], me):
            if not allocation.resume_inflight(con, pending['box_id']):
                _reconcile_pinned(con, pending)
            pending = None
        if pending and lease.boot_dead(con, pending['box_id']):
            pending = None
        if pending and allocation.resume_inflight(con, pending['box_id']):
            pending = None
        bid = guard = None
        def select_pending():
            nonlocal pending, bid, guard
            acquired = False
            try:
                bid = pending["box_id"]
                with _pool_lock(key, deadline, wait, **lock_options):
                    con.execute("UPDATE pool_waiters SET reserved=0 WHERE token=?", (waiter,))
                    con.commit()
                    alternatives = candidates(con, key, size, source, me)[0] if not _matches(pending, source) else []
                    can_use_other = False
                    for alternative in alternatives:
                        other = alternative['box_id']
                        # An unresolved resume fences new machine starts: only a ready running peer can avoid recovery.
                        if (other == bid or other in unusable or alternative['state'] != 'running'
                                or (size and SIZES.index(alternative['size'] or 'default') < SIZES.index(size))
                                or allocation.resume_inflight(con, other)
                                or lease.active_runs(con, other) or _older(con, key, waiter, alternative)):
                            continue
                        try:
                            with file_lock('box-' + other, timeout=0):
                                can_use_other = True
                                break
                        except OffboxError:
                            continue
                    if can_use_other or _older(con, key, waiter, pending):
                        pending = None
                    else:
                        guard = file_lock("box-" + bid, timeout=0)
                        try:
                            guard.__enter__()
                        except OffboxError:
                            pending = None  # the sender/another reconciler owns this box; choose a peer or queue
                        else:
                            if not _pin_available(con, bid, me):
                                guard.__exit__(None, None, None)
                                pending = None
                            else:
                                acquired = True
                                con.execute("UPDATE pool_waiters SET reserved=1 WHERE token=?", (waiter,))
                                con.commit()
            except BaseException:
                if acquired:
                    guard.__exit__(None, None, None)
                raise
        if pending:
            poll.call(select_pending)
        if pending:
            try:
                pending = con.execute("SELECT l.* FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                                      "WHERE l.box_id=? AND l.state IN ('running','stopped') "
                                      "AND COALESCE(l.note,'') NOT LIKE ?", (bid, WEDGED_LIKE)).fetchone()
                if not pending:
                    _unreserve_and_release(con, waiter, guard)
                    continue
                if lease.active_runs(con, bid):
                    raise lease.ResumeUnresolved(f"{bid} has an active run and an unanswered resume; nothing ran")
                try:
                    got = _reuse_prepared(con, pending, size, skip_archiving=True)
                except lease.BoxNotReady as e:
                    readiness_failed(pending, e)
                    _unreserve_and_release(con, waiter, guard)
                    continue
                except (lease.ArchivingSkip, allocation.Busy, allocation.Fenced) as e:
                    if isinstance(e, lease.ResumeStopped) or getattr(e, 'resume_retry_box', None) == bid:
                        pending_retries.add(bid)
                    _unreserve_and_release(con, waiter, guard)
                    say(str(e))
                    pending_busy[bid] = time.monotonic() + 2
                    continue
                except (lease.ResumeProvisionStalled, prepare.Stalled) as e:
                    con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?", (str(e), bid))
                    con.commit()
                    prepare.move_once(e)
                    resume_stall, create_first = e, True
                    _unreserve_and_release(con, waiter, guard)
                    say(str(e))
                    continue
                if got is None:
                    _unreserve_and_release(con, waiter, guard)
                    continue
                if source and (pending["source"] or "").replace("recipe:", "template:", 1) != source:
                    raise lease.ResumeUnresolved(f"{bid} had an unanswered resume; it was checked, "
                                                 "retry the requested source")
                _claim(con, me, got, run_id)
                # Transfer guard ownership to the caller.
                got["_guard"] = guard
                return got
            except BaseException:
                _unreserve_and_release(con, waiter, guard)
                raise
        # Only the latest pass decides whether a timeout was a start limit (90) or plain busy (92).
        last_error = None
        if time.monotonic() >= next_refresh:
            # Outside the pool lock: it asks boat about every detached run.
            _refresh_background(con, key)
            next_refresh = time.monotonic() + 10
        if not prune_checked:
            # Before reserving a create slot, and outside the pool lock: a held warm box may be ready now.
            _recheck_prune_holds(con, key)
            prune_checked = True
        tried = set(unusable)
        stopped_tries = 0
        stopped_error = None
        capacity_outage = None
        start_limit = None
        stopped_failed = False  # the last stopped box tried could not be used (error or gone)
        while True:
            # The pool lock covers only the choice: a box (its box lock taken without waiting) or a create slot.
            # The resume or create runs after it is released, so one slow boat call never holds up other callers
            # (31 Oct: a 900 s resume under this lock failed every other edge-api run with exit 90).
            def select():
                nonlocal last_error, start_limit
                guard = None
                try:
                    row = guard = token = None
                    wait_own = False
                    with _pool_lock(key, deadline, wait, **lock_options):
                        con.execute("UPDATE pool_waiters SET reserved=0 WHERE token=?", (waiter,))
                        con.commit()
                        rows, can_create = candidates(con, key, size, source, me)
                        if create_first:
                            # Retain unanswered markers on excluded boxes, without letting them block a replacement.
                            siblings, _ = candidates(con, key, None, None, me)
                            for sibling in siblings:
                                pending_sibling = con.execute("SELECT 1 FROM kv WHERE k=?",
                                                             (f"resume_unanswered:{sibling['box_id']}",)).fetchone()
                                if allocation.resume_inflight(con, sibling['box_id']):
                                    continue
                                if sibling['state'] == 'stopped' or pending_sibling:
                                    sibling_guard = file_lock('box-' + sibling['box_id'], timeout=0)
                                    try:
                                        sibling_guard.__enter__()
                                    except OffboxError:
                                        continue
                                    try:
                                        con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?",
                                                    ('unanswered-resume: set aside after sibling provisioning stall', sibling['box_id']))
                                        con.commit()
                                    finally:
                                        sibling_guard.__exit__(None, None, None)
                            con.commit()
                            rows, can_create = [], _room(con, key)
                        pending = allocation.abandoned_resumes(con, key)
                        # Abandoned sends must be reconciled before any new start. Locked/in-flight markers are busy.
                        can_create = can_create and not pending
                        if con.execute("SELECT 1 FROM kv WHERE k=?", ("create_unanswered:" + key,)).fetchone():
                            # Replaying the retained key resolves the old allocation; it is not a new pool slot.
                            rows, can_create = [], True
                        # A failed-over run can still use home when it recovers, even without a compatible Boat box.
                        if (not failover and source and not rows and not can_create and not pending
                                and not _source_member(con, key, source)):
                            cap = pool_cap(con, key)
                            raise OffboxError(
                                f"this run needs a new {key} pool box ({source}), but the pool is full "
                                f"({len(members(con, key))}/{cap} boxes, none from {source}), so waiting can't help. Nothing ran. "
                                "Run without --fresh/--base/--template (a dead box is set aside by itself), or free a slot: "
                                "offbox list --all, then offbox release <id> --delete." + split_pool_notice(con, me), code=2)
                        for r in rows:
                            if (r["box_id"] in tried or _older(con, key, waiter, r)
                                    or allocation.resume_inflight(con, r['box_id'])):
                                continue
                            if pending and any(p['box_id'] != r['box_id'] for p in pending) and r['state'] != 'running':
                                continue
                            needs_grow = (r['state'] == 'running' and bool(size)
                                          and SIZES.index(r['size'] or 'default') < SIZES.index(size))
                            if needs_grow and grew:
                                continue
                            preferred = r['box_id'] in mine and time.monotonic() < affinity_deadline
                            if r['state'] != 'running':
                                # After a failed resume, try every eligible stopped box before creating a new one.
                                if stopped_tries == 1 and not stopped_failed:
                                    continue
                                # boat has no machines of the size this box would resume at: not a try, nothing to wait on.
                                fit_size = lease.resume_size(con, r, size)
                                if lease.supply_size(fit_size, size or "large") is None:
                                    last_error = api.SupplyOut(fit_size, r["box_id"],
                                                               f"supply for size {fit_size} is over", tried=False)
                                    continue
                                try:
                                    capacity.check(con)
                                except capacity.CapacityError as e:
                                    if capacity_outage is not None:
                                        raise
                                    start_limit = e
                                    last_error = e
                                    continue
                            g = file_lock("box-"+r["box_id"], timeout=0)
                            try:
                                g.__enter__()
                            except OffboxError:
                                if preferred:
                                    wait_own = True
                                    break
                                continue
                            guard = g
                            if not _pin_available(con, r['box_id'], me):
                                g.__exit__(None, None, None)
                                guard = None
                                continue
                            if lease.active_runs(con, r["box_id"]):
                                g.__exit__(None, None, None)
                                guard = None
                                if preferred:
                                    wait_own = True
                                    break
                                continue
                            row, guard = r, g
                            # Counted as a member from now on, so a creator can't overfill the pool while this resumes.
                            con.execute("INSERT OR REPLACE INTO pool_members VALUES (?,?)", (r["box_id"], key))
                            con.commit()
                            break
                        if outage.allocation_left() == 0:
                            if guard is not None:
                                guard.__exit__(None, None, None)
                            raise PoolBusyError("allocation wait expired; nothing ran")
                        if row is None and can_create and not wait_own and not _older(con, key, waiter):
                            try:
                                capacity.check(con)
                                token = new_id("create")
                                with write(con):
                                    con.execute("INSERT INTO pool_pending VALUES (?,?,?,?,?)",
                                                (token, key, os.getpid(), now(), source))
                                    con.execute("UPDATE pool_waiters SET reserved=1 WHERE token=?", (waiter,))
                            except capacity.CapacityError as e:
                                if capacity_outage is not None:
                                    raise
                                start_limit = e
                                last_error = e
                        if row is not None:
                            con.execute("UPDATE pool_waiters SET reserved=1 WHERE token=?", (waiter,))
                            con.commit()
                    return row, guard, token, can_create, wait_own
                except BaseException:
                    if guard is not None:
                        guard.__exit__(None, None, None)
                    raise
            row, guard, token, can_create, wait_own = poll.call(select)
            if wait_own:
                # Never hold the pool lock while waiting: other checkouts can use the foreign boxes.
                time.sleep(min(1, max(0, affinity_deadline - time.monotonic())))
                with api.budget(max(0, affinity_deadline - time.monotonic())):
                    _refresh_background(con, key, pull_artifacts=False)
                continue
            if row is not None:
                tried.add(row["box_id"])
                try:
                    try:
                        # A live box grows for an explicit bigger --size but never shrinks (that costs a start);
                        # a stopped one resumes at max(--size, its natural size) inside lease._reuse.
                        grow = (row['state'] == 'running' and bool(size)
                                and SIZES.index(row['size'] or 'default') < SIZES.index(size))
                        if grow:
                            capacity.check(con)
                        if row['state'] != 'running':
                            stopped_tries += 1
                        options = {'retrying': True} if row['box_id'] in pending_retries else {}
                        wait_for_own = row['box_id'] in mine
                        if wait_for_own:
                            needs_start = grow or row['state'] != 'running'
                            budget = max(0, min(AFFINITY_WAIT_S, deadline - time.monotonic()))
                            # Affinity bounds waiting for our box; a selected box gets its own readiness window.
                            # Resize stops yield to the queue, so their wait is excluded on the resume attempt.
                            if not wait and not needs_start:
                                budget = AFFINITY_WAIT_S  # a zero queue wait still permits a ready box's health check
                            with api.budget(budget):
                                got = _reuse_prepared(con, row, size, skip_archiving=False,
                                                   before_grow=before_grow, **options)
                        else:
                            got = _reuse_prepared(con, row, size, skip_archiving=True, before_grow=before_grow, **options)
                    except (lease.ResumeProvisionStalled, prepare.Stalled) as e:
                        con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?",
                                    (str(e), row['box_id']))
                        con.commit()
                        prepare.move_once(e)
                        resume_stall = e
                        create_first = True
                        say(str(e))
                        continue
                    except lease.BoxNotReady as e:
                        readiness_failed(row, e)
                        stopped_error, stopped_failed = e, True
                        continue
                    except (allocation.Busy, allocation.Fenced) as error:
                        if getattr(error, 'resume_retry_box', None) == row['box_id']:
                            pending_retries.add(row['box_id'])
                        if row['state'] != 'running':
                            stopped_tries -= 1
                        continue
                    except (lease.ResumeUnresolved, allocation.Unresolved):
                        # This attempt itself was unanswered; retain its reconciliation failure.
                        raise
                    except api.BoatAtCapacity as e:
                        # Try every other eligible stopped box, but keep this one in the pool for the next round.
                        capacity_outage = e
                        stopped_failed = True
                        continue
                    except api.SupplyOut as e:
                        # This box's size is out: the next member gets its turn in this pass.
                        if row['state'] != 'running':
                            if e.tried:
                                stopped_failed = True
                            else:
                                stopped_tries -= 1
                        last_error = e
                        say(f"skipping {row['box_id']}: {e}. Trying other pool boxes")
                        continue
                    except capacity.CapacityError:
                        raise
                    except lease.ArchivingSkip as e:
                        if isinstance(e, lease.ResumeStuck):
                            unusable.add(row['box_id'])
                        elif row['box_id'] in mine and time.monotonic() < affinity_deadline:
                            # Yield readiness/box guards into the queue while preserving the caller's cache affinity.
                            say(str(e))
                            break
                        # Busy-like: the box is still archiving, so try the next member. It does not
                        # make the pool look full, so a create still runs when under cap.
                        if row['state'] != 'running':
                            stopped_tries -= 1  # skipped, not tried: the next stopped member still gets its turn
                        say(f"skipping pool box {row['box_id']}: {e}")
                        continue
                    except lease.DiskTooBig as e:
                        # Marked and left stopped: it no longer counts toward the pool. Not stopped_error, so a
                        # still-full pool queues (exit 92) instead of failing with the resume error (exit 90).
                        stopped_failed = True
                        say(f"skipping {row['box_id']}: its disk needs {e.need} GiB but '{e.size}' holds {e.holds} GiB. "
                            f"It stays stopped with its disk and no longer counts toward the pool (remove it with: "
                            f"offbox release {row['box_id']} --delete). Trying other pool boxes, then a fresh lease.")
                        continue
                    except OffboxError as e:
                        if isinstance(e, home.StartWaitFailed):
                            raise
                        if isinstance(e, api.BudgetExpired) and con.execute("SELECT 1 FROM kv WHERE k IN (?,?)",
                                (f"resume_unanswered:{row['box_id']}", f"resume_provision:{row['box_id']}")).fetchone():
                            raise
                        if (row['state'] == 'running' and not wait_for_own) or e.code != EXIT_INFRA:
                            raise
                        # A stopped box failed to resume: a running box later in the list may still be free.
                        stopped_error = e
                        stopped_failed = True
                        say(f"could not resume {row['box_id']} ({e}); trying other pool boxes")
                        continue
                    if got:
                        _claim(con, me, got, run_id)
                        got["_guard"] = guard
                        guard = None
                        got["_log_lease_kind"] = "reused"
                        say(f"reusing repository pool box {got['box_id']} ({got['size']})")
                        return got
                    if row['state'] != 'running':
                        stopped_failed = True  # the box is gone; another stopped box may still be fine
                    continue
                finally:
                    if guard is not None:
                        _unreserve_and_release(con, waiter, guard)
            if token is not None:
                try:
                    shared = dict(me, owner="pool:"+key, thread=None, session=None, title="repository pool", manager=None)
                    creator = getattr(lease, 'acquire_private', lease.acquire)
                    selected_before = home.BOAT_SELECTED.get()
                    try:
                        with _lease_work(), prepare.guard('new allocation') as budget:
                            got = creator(shared, size, template, base, fresh)
                            got['_prepare_end'] = budget.end
                            got['_log_lease_kind'] = 'saved-base' if str(got.get('source', '')).startswith('base:') else 'fresh'
                    except allocation.Busy:
                        # The allocation lock rejected us before any create/resume request was sent.
                        home.BOAT_SELECTED.set(selected_before)
                        break
                    except allocation.Fenced:
                        break
                    except capacity.CapacityError as e:
                        if resume_stall is not None:
                            e.args = (f"{e} Earlier cause: {resume_stall}",)
                        if not isinstance(e, (api.SupplyOut, api.BoatAtCapacity)):
                            raise
                        last_error = e
                        break
                    except OffboxError as e:
                        if isinstance(e, (common.SourceGone, home.StartWaitFailed)):
                            raise
                        if resume_stall is not None:
                            refused = 400 <= (getattr(e, 'status', None) or 0) < 500
                            wrapped = OffboxError(f"{resume_stall}. Replacement allocation failed: {e}; nothing ran",
                                                  code=e.code, started=e.started or resume_stall.started,
                                                  outage=not refused and home.may_fail_over()
                                                  and (e.outage or resume_stall.outage))
                            wrapped.status = getattr(e, 'status', None)
                            raise wrapped from e
                        raise
                    # acquire_private hands over the box lock it took before the row existed.
                    guard = got.pop("_guard", None)
                    if guard is None:
                        guard = file_lock("box-"+got["box_id"], timeout=0)
                        guard.__enter__()
                    try:
                        # The member row and the slot's removal happen in one step under the pool lock, so a
                        # selection never sees the box as neither a member nor a pending slot.
                        with _pool_lock(key, deadline, wait, prepare_end=got['_prepare_end'], box_id=got['box_id'], **lock_options):
                            _claim(con, me, got, run_id, pending_token=token)
                            token = None
                    except BaseException:
                        guard.__exit__(None, None, None)
                        raise
                    got["_guard"] = guard
                    return got
                finally:
                    if token is not None:
                        # Failed create: removing the slot only lowers the count, so no lock is needed.
                        con.execute("DELETE FROM pool_pending WHERE token=?", (token,))
                        con.execute("UPDATE pool_waiters SET reserved=0 WHERE token=?", (waiter,))
                        con.commit()
            if capacity_outage is not None:
                raise capacity_outage
            if start_limit is not None:
                raise start_limit
            if stopped_error is not None and not can_create:
                raise stopped_error
            break
        t = time.monotonic()
        if last_error and not isinstance(last_error, (api.SupplyOut, api.BoatAtCapacity)):
            raise last_error
        check_home(force=wait > 0 and t >= deadline)
        if t >= deadline:
            if last_error:
                raise last_error
            hint = ("leave it waiting with --bg and `offbox wait <run>`" if at_home() else
                    f"retry, or raise OFFBOX_POOL_WAIT_SECONDS (max {wait_max()})")
            raise PoolBusyError(f"repository pool busy/full for {key}: boxes stayed busy for {int(t-started)}s; "
                                f"remote queue timed out. Nothing ran (exit {EXIT_BUSY}): {hint}" +
                                split_pool_notice(con, me))
        if isinstance(last_error, api.BoatAtCapacity):
            raise last_error
        state = poll.call(lambda: queue_state(con, key, run_id, source=source, size=size, token=waiter))
        if t >= next_progress or state != previous_state:
            import toollog
            toollog.emit("pool", "run.queue", ids={"run": run_id},
                         props={"queued": True, "position": state.get("place"), "waitMs": (t-started)*1000})
            detail = _queue_line(state, source)
            if failover:
                if not said:
                    say(f"queued for a {key} pool box on Boat (home is down): {detail}; waits until a Boat box "
                        f"frees or home is back, no time limit; checking home every {probe_every} s. "
                        "Run it with --bg or in a background shell if your tool call has a timeout")
                    said = True
                else:
                    say(f"still queued for a {key} pool box on Boat: waited {int(t-started)} s, {detail}"
                        f" · checking home every {probe_every} s")
            elif home.unlimited_queue():
                if not said:
                    say(f"queued for a {key} pool box on home: {detail}; no time limit; "
                        "leave it waiting with --bg and `offbox wait <run>`")
                    said = True
                else:
                    say(f"still queued for a {key} pool box: waited {int(t-started)} s, {detail}")
            elif not said:
                say(f"queued for a {key} pool box: {detail}; will wait up to {_span(wait)}" +
                    (f" ({last_error})" if last_error else "") +
                    (". It starts by itself when a box is free: leave it waiting, do not retry or kill it. For a long "
                     "wait use --bg and `offbox wait <run>`." if at_home() else
                     f". Use a tool timeout above {wait}s or run this in a background shell.") + split_pool_notice(con, me))
                said = True
            else:
                say(f"still queued for a {key} pool box: waited {_span(t-started)} of {_span(wait)}, {detail}" +
                    split_pool_notice(con, me))
            previous_state = state
            next_progress = t + PROGRESS_EVERY_S
        time.sleep(min(2, max(0, deadline-time.monotonic())))


def try_warm(me, size, source, exclude, run_id):
    token = _PIN_SKIPS.set(dict(run=run_id, boxes=set()))
    try:
        return _try_warm(me, size, source, exclude, run_id)
    finally:
        _PIN_SKIPS.reset(token)


def _try_warm(me, size, source, exclude, run_id):
    """Claim a free running peer once, without resuming, growing or creating a box."""
    from . import api, lease, ssh_sync
    con = db()
    try:
        capacity.schema(con)
        key = me['repo_key']
        source = source.replace('recipe:', 'template:', 1) if source else None
        got = None
        with _pool_lock(key, time.monotonic() + 1, 0):
            rows, _ = candidates(con, key, size, source, me)
            for row in rows:
                bid = row['box_id']
                if bid in exclude or row['state'] != 'running' or row['size'] != size or _older(con, key, None, row):
                    continue
                guard = file_lock('box-' + bid, timeout=0)
                try:
                    guard.__enter__()
                except OffboxError:
                    continue
                claimed = False
                try:
                    # A prior holder may have changed the lease or marked it cold after our first scan.
                    current, _ = candidates(con, key, size, source, me)
                    row = next((r for r in current if r['box_id'] == bid), None)
                    if row is None or row['state'] != 'running' or row['size'] != size or lease.active_runs(con, bid):
                        continue
                    if con.execute("SELECT 1 FROM events WHERE box_id=? AND kind='cold_home' AND ts>? LIMIT 1",
                                   (bid, now() - 15 * 60)).fetchone():
                        continue
                    if con.execute("SELECT 1 FROM kv WHERE k IN (?,?,?)",
                                   (f'resume_unanswered:{bid}', f'resume_provision:{bid}',
                                    f'delete_pending:{bid}')).fetchone():
                        continue
                    got = dict(row)
                    con.execute('INSERT OR REPLACE INTO pool_members VALUES (?,?)', (bid, key))
                    con.commit()
                    got['_guard'] = guard
                    claimed = True
                    break
                finally:
                    if not claimed:
                        guard.__exit__(None, None, None)
        if got is not None:
            claimed = False
            try:
                # The peer's idle TTL can expire during a first push. Refresh outside the pool lock,
                # still holding its box guard, before changing the run's assignment.
                try:
                    with api.budget(10):
                        if not lease.ensure_ttl(got['box_id'], RUN_TTL_S):
                            return None
                        # A cached running lease and a successful TTL update can both outlive its machine.
                        peer = api.get(got['box_id'], deadline=time.time() + 10)
                        if not peer or peer.get('state') not in api.LIVE_STATES or peer.get('dataExpiredAt') or peer.get('heldRuns') \
                                or peer.get('type') != got['size']:
                            return None
                        left = api.left()
                        if left is not None and left <= 0:
                            return None
                        ready = ssh_sync.ssh(got['box_id'], 'true', timeout=min(10, left) if left is not None else 10)
                        if ready.returncode != 0:
                            return None
                except common.SshHostKeyMismatch:
                    raise
                except home.StartWaitFailed:
                    raise
                except Exception:  # noqa: BLE001 - malformed API responses also make this optional peer unusable
                    return None
                _claim(con, me, got, run_id)
                claimed = True
                lease.report_reused_template(me, got)
                return got
            finally:
                if not claimed:
                    release_guard(got)
    except common.SshHostKeyMismatch:
        raise
    except home.StartWaitFailed:
        raise
    except OffboxError:
        # A contended pool is optional here: keep the already-held cold box.
        return None
    finally:
        con.close()
    return None


def _recheck_prune_holds(con, key) -> bool:
    """At most two five-second probes before allocation; share the per-box throttle across callers."""
    from . import prune
    rows = con.execute(f"SELECT h.box_id, h.run_id FROM prune_holds h JOIN leases l USING(box_id) "
                       f"WHERE l.repo_key=? AND {token_mine('l')} AND l.state='running' "
                       "AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.box_id=l.box_id "
                       "AND r.status IN ('starting','running')) ORDER BY l.last_used_at DESC",
                       (key,)).fetchall()
    released = False
    deadline = time.monotonic() + 10
    checks = 0
    for row in rows:
        if checks >= 2 or time.monotonic() >= deadline:
            break
        bid = row['box_id']
        try:
            with file_lock('prunecheck-' + bid, timeout=0):
                check_key = f'prunecheck:{bid}'
                last = kv_get(con, check_key)
                if last is not None and now() - last < 60:
                    continue
                kv_set(con, check_key, now())
                checks += 1
                released = prune.recheck(con, bid, row['run_id'], deadline - time.monotonic()) or released
        except common.SshHostKeyMismatch:
            raise
        except OffboxError:
            pass
    return released


def _claim(con, me, row, run_id, *, pending_token=None):
    bid = row["box_id"]
    row["remote_dir"] = remote_dir_for(me["repo_root"])
    row["_new_checkout"] = con.execute(
        "SELECT 1 FROM pool_callers WHERE owner=? AND repo_root=? AND box_id=?",
        (me["owner"], me["repo_root"], bid)).fetchone() is None
    last = con.execute("SELECT box_id FROM pool_callers WHERE owner=? AND repo_root=?",
                       (me["owner"], me["repo_root"])).fetchone()
    if last is None:
        last = con.execute("SELECT box_id FROM runs WHERE owner=? AND repo_root=? AND box_id IS NOT NULL "
                           "AND run_id<>? ORDER BY start_at DESC LIMIT 1",
                           (me["owner"], me["repo_root"], run_id or "")).fetchone()
    if last and last[0] != bid:
        old = con.execute("SELECT state, pinned_until FROM leases WHERE box_id=?", (last[0],)).fetchone()
        state = old[0] if old else "gone"
        state = ('set aside' if state == 'resume_stalled' or kv_get(con, 'boot_dead:' + last[0]) else
                 state if state in ("stopped", "archived") else "busy" if state == "running" else "gone")
        if state == 'gone' and old and old['pinned_until']:
            deletion = con.execute("SELECT ts, kind, detail FROM events WHERE box_id=? AND kind IN "
                                   "('delete','reap_forget','reap_expired','lease_gone','lease_expired') "
                                   "ORDER BY ts DESC LIMIT 1", (last[0],)).fetchone()
            evidence = (f"{deletion['kind']} at {iso(deletion['ts'])}: {deletion['detail']}" if deletion else
                        "no deletion event recorded; data loss unconfirmed")
            state += f" (was pinned; {evidence})"
        detail = ("new checkout there, dependencies not carried over" if row["_new_checkout"]
                  else "existing checkout there")
        say(f"your last box {last[0]} is {state}; using {bid} ({detail})")
    # Progress readers do not take the pool lock: adoption and slot removal must share a database commit.
    with write(con):
        con.execute("INSERT OR REPLACE INTO pool_members VALUES (?,?)", (bid, me["repo_key"]))
        con.execute("INSERT OR REPLACE INTO pool_callers VALUES (?,?,?,?)",
                    (me["owner"], me["repo_root"], bid, row["remote_dir"]))
        # Shared leases outlive their original worker's archive state.
        con.execute("UPDATE leases SET thread_gone_since=NULL, last_used_at=? WHERE box_id=?", (now(), bid))
        if run_id:
            con.execute("UPDATE runs SET box_id=?,remote_dir=?,size=? WHERE run_id=?",
                        (bid, row["remote_dir"], row["size"], run_id))
        if pending_token is not None:
            con.execute("DELETE FROM pool_pending WHERE token=?", (pending_token,))


def _refresh_background(con, key, pull_artifacts=True):
    """Detached runs have no lock holder; reclaim completed slots without waiting for the reaper."""
    from . import api, runs, start_check
    from .misc import _catch_up_finished
    rows = con.execute(f"""SELECT r.* FROM runs r JOIN leases l USING(box_id)
        WHERE l.repo_key=? AND {token_mine('l')} AND r.mode='bg' AND (r.status IN ('starting','running','lost') OR (r.status='infra' AND EXISTS
        (SELECT 1 FROM kv WHERE k='start_unknown:' || r.run_id)))
        """, (key,)).fetchall()
    for row in rows:
        if api.left() is not None and api.left() <= 0:
            break
        try:
            with file_lock('box-'+row['box_id'], timeout=0):
                row = con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
                row = runs.restore_run_state(row)
                if runs.terminal_result(row):
                    runs.finish(row['run_id'], row['exit_code'], row['status'], run=row)
                    continue
                runs.reconcile_lost(con, row['box_id'], foreign=True)
                row = runs.restore_run_state(con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone())
                if row['status'] not in ('starting','running') and not (
                        row['status'] == 'infra' and start_check.recovery_marked(con, row)):
                    _catch_up_finished(con, row['run_id'])
                    continue
                pid = start_check.api_pid(con, row)
                if not pid:
                    if start_check.recovery_marked(con, row):
                        result = start_check.check(row['box_id'], row['run_id'],
                                                   claim=start_check.claims_enabled(con, row['run_id']),
                                                   timeout=min(10, api.left() or 10))
                        if result.code is not None and not pull_artifacts and json.loads(row['pulls'] or '[]'):
                            # Affinity waits leave artifact-bearing runs reserved for a later full refresh.
                            start_check.remember_wrapper(con, row, result.pid)
                            con.commit()
                            continue
                        if result.code is not None or result.verdict == 'fenced':
                            start_check.settle(con, row, result, 'pool checked an unattached start',
                                               until=None if api.left() is None else time.time() + api.left(),
                                               foreign=True)
                        else:
                            start_check.remember_wrapper(con, row, result.pid)
                            con.commit()
                    continue
                left = api.left()
                options = {} if left is None else {"deadline": time.time() + left, "retries": 0}
                st = api.cmd_status(row['box_id'], pid, **options)
                if st and not st.get('running') and st.get('status') in ('exited', 'lost'):
                    if st.get('status') == 'lost':
                        confirmed = runs.confirmed_lost(row['box_id'], row['run_id'], timeout=min(20, api.left() or 20))
                        if confirmed is None:
                            continue
                        st = {**st, **confirmed}
                    code = st.get('exitCode')
                    if code is None and row['command_id']:
                        code = (api.history_get(row['box_id'], row['command_id']) or {}).get('exitCode')
                    if (st.get('status') == 'exited' and code == runs.EXIT_REPO_SETUP
                            and runs.REPO_SETUP_FAILED_MARKER in (st.get('stderr') or '').splitlines()):
                        runs.finish(row['run_id'], EXIT_INFRA, 'infra')
                        continue
                    wedged = runs.settle_box_wedged(con, row, code)
                    if wedged:
                        say(runs.wedged_message(row['box_id'], *wedged))
                        continue
                    pulls = json.loads(row['pulls'] or '[]')
                    if pulls:
                        if not pull_artifacts:
                            continue  # pulls keep the slot reserved until the normal follower/reaper finishes
                        runs.do_pulls(row['box_id'], dict(row), pulls, foreign=True)
                    status, code = runs.completed_result(row, {**st, 'exitCode':code})
                    runs.finish(row['run_id'], code, status, run=row)
        except OffboxError:
            pass


def release_guard(row):
    guard = row.pop('_guard', None) if row else None
    if guard is not None:
        guard.__exit__(None, None, None)
    token = row.pop('_pool_cap_token', None) if row else None
    if token:
        def clear():
            with contextlib.closing(db()) as con:
                con.execute("DELETE FROM pool_cap_callers WHERE token=?", (token,))
        try:
            db_retry(clear)
        except sqlite3.Error as error:
            log(f"pool cap caller {token} cleanup failed: {error}")
