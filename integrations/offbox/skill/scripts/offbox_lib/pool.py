"""Bounded repository pools; one run per box (including sync and artifact pulls)."""

from __future__ import annotations

import contextlib
import hashlib
import os
import time

from . import capacity
from .common import (BOX_WEDGED_NOTE, DEAD_MOUNT_NOTE, EXIT_BUSY, EXIT_INFRA, RUN_TTL_S, SIZES, TOO_BIG_NOTE, OffboxError, db, file_lock, new_id,
                     now, say)
from .identity import remote_dir_for

WAIT_DEFAULT_S = 600
WAIT_MAX_S = 1200
PROGRESS_EVERY_S = 60
AFFINITY_WAIT_S = 60
# A create slot is claimed under the pool lock and the box is made after it. A slot whose process died is dropped at
# once; the age bound only covers a reused pid (a recipe bring-up can take ~30 min).
PENDING_MAX_S = 3600


class PoolBusyError(capacity.CapacityError):
    """Every pool box stayed busy for the whole queue wait. Nothing ran; not a boat failure."""

    def __init__(self, msg: str):
        super().__init__(msg, code=EXIT_BUSY)


def wait_seconds() -> int:
    return capacity.setting("OFFBOX_POOL_WAIT_SECONDS", WAIT_DEFAULT_S, minimum=0, maximum=WAIT_MAX_S)


def queue_state(con, key, run_id=None):
    """(busy boxes, pool cap, other callers still waiting for this pool). Waiters are approximate: a
    'starting' run with no box yet whose checkout already maps to this pool."""
    cap = capacity.setting("OFFBOX_POOL_SIZE", 4, maximum=8)
    busy = con.execute("""SELECT COUNT(DISTINCT r.box_id) FROM runs r JOIN pool_members p USING(box_id)
        WHERE p.pool_key=? AND r.status IN ('starting','running')""", (key,)).fetchone()[0]
    waiting = con.execute("""SELECT COUNT(*) FROM runs r WHERE r.status='starting' AND r.box_id IS NULL
        AND r.run_id<>? AND r.start_at>? AND (r.repo_root IN (SELECT repo_root FROM leases WHERE repo_key=?)
          OR r.repo_root IN (SELECT c.repo_root FROM pool_callers c JOIN pool_members p USING(box_id)
                             WHERE p.pool_key=?))""",
                          (run_id or "", now() - WAIT_MAX_S, key, key)).fetchone()[0]
    return busy, cap, waiting


def lock_name(key: str) -> str:
    return "pool-" + hashlib.sha256(key.encode()).hexdigest()[:20]


@contextlib.contextmanager
def _pool_lock(key: str, deadline: float, wait: int):
    """The pool lock covers only choosing a box or a create slot, so a wait for it is a busy pool, never infra."""
    lk = file_lock(lock_name(key), timeout=max(1, deadline - time.monotonic()))
    try:
        lk.__enter__()
    except OffboxError as e:
        raise PoolBusyError(f"repository pool busy for {key}: other offbox runs kept its pool lock for the whole "
                            f"{wait}s queue wait. Nothing ran (exit {EXIT_BUSY}, not an infra failure): retry, or "
                            f"raise OFFBOX_POOL_WAIT_SECONDS (max {WAIT_MAX_S})") from e
    try:
        yield
    finally:
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
            con.execute("DELETE FROM pool_pending WHERE token=?", (r["token"],))
            con.commit()
    return n


TOO_BIG_LIKE = f"{TOO_BIG_NOTE}%"  # a box marked too big frees its pool slot and is never offered again
DEAD_LIKE = f"{DEAD_MOUNT_NOTE}%"  # same for a box whose filesystem died
WEDGED_LIKE = f"{BOX_WEDGED_NOTE}%"


def members(con, key):
    return con.execute(f"""SELECT l.* FROM leases l JOIN pool_members p USING(box_id)
        WHERE p.pool_key=? AND l.state IN ('running','stopped') AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        AND COALESCE(l.note,'') NOT LIKE ?
        ORDER BY (l.state='running') DESC, l.last_used_at DESC""", (key, TOO_BIG_LIKE, DEAD_LIKE, WEDGED_LIKE)).fetchall()


def _source_member(con, key, source) -> bool:
    if any((r["source"] or "").replace("recipe:", "template:", 1) == source for r in members(con, key)):
        return True
    # A box from this source still being created by another caller: waiting for it can help.
    return _pending(con, key) > 0 and con.execute("SELECT 1 FROM pool_pending WHERE pool_key=? AND source=?",
                                                  (key, source)).fetchone() is not None


def _room(con, key) -> bool:
    return len(members(con, key)) + _pending(con, key) < capacity.setting("OFFBOX_POOL_SIZE", 4, maximum=8)


def own_boxes(con, me):
    if not me or not me.get("owner") or not me.get("repo_root"):
        return set()
    return {r[0] for r in con.execute("SELECT box_id FROM pool_callers WHERE owner=? AND repo_root=?",
                                     (me["owner"], me["repo_root"]))}


def candidates(con, key, size, source, me=None):
    # Existing boxes count toward the cap once adopted; surplus legacy boxes are left intact.
    rows = con.execute("""SELECT l.*, p.pool_key FROM leases l LEFT JOIN pool_members p USING(box_id)
        WHERE l.repo_key=? AND l.state IN ('running','stopped')
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
        if r["pool_key"] not in (None, key) or (full and r["pool_key"] is None):
            continue
        # A box built from a template's recipe (the template had expired) serves that template's runs too.
        if source and (r["source"] or "").replace("recipe:", "template:", 1) != source:
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


def acquire(me, size=None, template=None, base=None, fresh=False, run_id=None, exclude=None):
    from . import allocation
    con = db()
    try:
        with allocation.scope(me['repo_key']):
            return _acquire(con, me, size, template, base, fresh, run_id, exclude)
    finally:
        con.close()


def _acquire(con, me, size, template, base, fresh, run_id, exclude=None):
    from . import allocation, api, lease, outage
    from .identity import require_proven
    # A pooled box is mapped to the caller's owner string. An unproven caller's string is shared, so it can't take one.
    require_proven(me, "run")
    lease.cap_check()
    capacity.schema(con)
    key = me["repo_key"]
    allocation.recover_resumes(con, key)
    source = ("fresh" if fresh else f"base:{base if ':' in base else key+':'+base}" if base else
              f"template:{template}" if template else None)
    wait = wait_seconds()
    allocation_left = outage.allocation_left()
    if allocation_left is not None:
        wait = min(wait, allocation_left)
    started = time.monotonic()
    deadline = started + wait
    said, last_error = False, None
    next_refresh = 0
    next_progress = 0
    create_first = False
    resume_stall = None
    unusable = set(exclude or ())
    pending_retries = set()
    affinity_deadline = min(deadline, started + AFFINITY_WAIT_S)
    grew = False
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
        lease.cap_check()
        pending = con.execute("SELECT l.* FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                              "WHERE l.repo_key=? AND l.state IN ('running','stopped') "
                              "AND COALESCE(l.note,'') NOT LIKE ? LIMIT 1", (key, WEDGED_LIKE)).fetchone()
        if create_first or (pending and pending['box_id'] in unusable):
            pending = None
        if pending:
            bid = pending["box_id"]
            guard = file_lock("box-" + bid, timeout=0)
            guard.__enter__()
            try:
                pending = con.execute("SELECT l.* FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                                      "WHERE l.box_id=? AND l.state IN ('running','stopped') "
                                      "AND COALESCE(l.note,'') NOT LIKE ?", (bid, WEDGED_LIKE)).fetchone()
                if not pending:
                    guard.__exit__(None, None, None)
                    continue
                if lease.active_runs(con, bid):
                    raise lease.ResumeUnresolved(f"{bid} has an active run and an unanswered resume; nothing ran")
                try:
                    got = lease._reuse(con, pending, size, skip_archiving=True)
                except lease.BoxNotReady as e:
                    readiness_failed(pending, e)
                    guard.__exit__(None, None, None)
                    continue
                except lease.ResumeStopped as e:
                    pending_retries.add(bid)
                    guard.__exit__(None, None, None)
                    say(str(e))
                    continue
                except lease.ResumeProvisionStalled as e:
                    con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?", (str(e), bid))
                    con.commit()
                    resume_stall, create_first = e, True
                    guard.__exit__(None, None, None)
                    say(str(e))
                    continue
                if got is None:
                    guard.__exit__(None, None, None)
                    continue
                if source and (pending["source"] or "").replace("recipe:", "template:", 1) != source:
                    raise lease.ResumeUnresolved(f"{bid} had an unanswered resume; it was checked, "
                                                 "retry the requested source")
                _claim(con, me, got, run_id)
                # Transfer guard ownership to the caller.
                got["_guard"] = guard
                return got
            except BaseException:
                guard.__exit__(None, None, None)
                raise
        # Only the latest pass decides whether a timeout was a start limit (90) or plain busy (92).
        last_error = None
        if time.monotonic() >= next_refresh:
            # Outside the pool lock: it asks boat about every detached run.
            _refresh_background(con, key)
            next_refresh = time.monotonic() + 10
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
            row = guard = token = None
            wait_own = False
            with _pool_lock(key, deadline, wait):
                rows, can_create = candidates(con, key, size, source, me)
                if create_first:
                    # Retain unanswered markers on excluded boxes, without letting them block a replacement.
                    siblings, _ = candidates(con, key, None, None, me)
                    for sibling in siblings:
                        pending_sibling = con.execute("SELECT 1 FROM kv WHERE k=?",
                                                     (f"resume_unanswered:{sibling['box_id']}",)).fetchone()
                        if sibling['state'] == 'stopped' or pending_sibling:
                            con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?",
                                        ('unanswered-resume: set aside after sibling provisioning stall', sibling['box_id']))
                    con.commit()
                    rows, can_create = [], True
                pending = con.execute("SELECT l.box_id FROM leases l JOIN kv k "
                                      "ON k.k='resume_unanswered:' || l.box_id WHERE l.repo_key=? "
                                      "AND l.state IN ('running','stopped') AND COALESCE(l.note,'') NOT LIKE ? "
                                      "LIMIT 1", (key, WEDGED_LIKE)).fetchone()
                if pending:
                    raise lease.ResumeUnresolved(f"{pending[0]} has an unanswered resume; "
                                                 "retry once it has been checked; nothing ran")
                if con.execute("SELECT 1 FROM kv WHERE k=?", ("create_unanswered:" + key,)).fetchone():
                    # Replaying the retained key resolves the old allocation; it is not a new pool slot.
                    rows, can_create = [], True
                if source and not rows and not can_create and not _source_member(con, key, source):
                    busy, cap, _ = queue_state(con, key, run_id)
                    raise OffboxError(
                        f"this run needs a new {key} pool box ({source}), but the pool is full "
                        f"({len(members(con, key))}/{cap} boxes, none from {source}), so waiting can't help. Nothing ran. "
                        "Run without --fresh/--base/--template (a dead box is set aside by itself), or free a slot: "
                        "offbox list --all, then offbox release <id> --delete.", code=2)
                for r in rows:
                    if r["box_id"] in tried:
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
                    if lease.active_runs(con, r["box_id"]):
                        g.__exit__(None, None, None)
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
                if row is None and can_create and not wait_own:
                    try:
                        capacity.check(con)
                        token = new_id("create")
                        con.execute("INSERT INTO pool_pending VALUES (?,?,?,?,?)",
                                    (token, key, os.getpid(), now(), source))
                        con.commit()
                    except capacity.CapacityError as e:
                        if capacity_outage is not None:
                            raise
                        start_limit = e
                        last_error = e
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
                            if not wait and not needs_start:
                                budget = AFFINITY_WAIT_S  # a zero queue wait still permits a ready box's health check
                            with api.budget(budget):
                                got = lease._reuse(con, row, size, skip_archiving=False,
                                                   before_grow=before_grow, **options)
                        else:
                            got = lease._reuse(con, row, size, skip_archiving=True, before_grow=before_grow, **options)
                    except lease.ResumeProvisionStalled as e:
                        con.execute("UPDATE leases SET state='resume_stalled', note=? WHERE box_id=?",
                                    (str(e), row['box_id']))
                        con.commit()
                        resume_stall = e
                        create_first = True
                        say(str(e))
                        continue
                    except lease.BoxNotReady as e:
                        readiness_failed(row, e)
                        stopped_error, stopped_failed = e, True
                        continue
                    except (lease.ResumeUnresolved, allocation.Unresolved):
                        # Do not create another machine while this resume may still have been accepted.
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
                        say(f"reusing repository pool box {got['box_id']} ({got['size']})")
                        return got
                    if row['state'] != 'running':
                        stopped_failed = True  # the box is gone; another stopped box may still be fine
                    continue
                finally:
                    if guard is not None:
                        guard.__exit__(None, None, None)
            if token is not None:
                try:
                    shared = dict(me, owner="pool:"+key, thread=None, session=None, title="repository pool", manager=None)
                    creator = getattr(lease, 'acquire_private', lease.acquire)
                    try:
                        got = creator(shared, size, template, base, fresh)
                    except capacity.CapacityError as e:
                        if resume_stall is not None:
                            e.args = (f"{e} Earlier cause: {resume_stall}",)
                        if not isinstance(e, (api.SupplyOut, api.BoatAtCapacity)):
                            raise
                        last_error = e
                        break
                    except OffboxError as e:
                        if resume_stall is not None:
                            raise OffboxError(f"{resume_stall}. Replacement allocation failed: {e}; nothing ran") from e
                        raise
                    # acquire_private hands over the box lock it took before the row existed.
                    guard = got.pop("_guard", None)
                    if guard is None:
                        guard = file_lock("box-"+got["box_id"], timeout=0)
                        guard.__enter__()
                    try:
                        # The member row and the slot's removal happen in one step under the pool lock, so a
                        # selection never sees the box as neither a member nor a pending slot.
                        with _pool_lock(key, deadline, wait):
                            _claim(con, me, got, run_id)
                            con.execute("DELETE FROM pool_pending WHERE token=?", (token,))
                            con.commit()
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
        if t >= deadline:
            if last_error:
                raise last_error
            busy, cap, waiting = queue_state(con, key, run_id)
            raise PoolBusyError(f"repository pool busy/full for {key}: {busy}/{cap} boxes stayed busy for "
                                f"{int(t-started)}s; remote queue timed out. Nothing ran (exit {EXIT_BUSY}, not an "
                                f"infra failure): retry, or raise OFFBOX_POOL_WAIT_SECONDS (max {WAIT_MAX_S})")
        if isinstance(last_error, api.BoatAtCapacity):
            raise last_error
        if t >= next_progress:
            busy, cap, waiting = queue_state(con, key, run_id)
            if not said:
                say(f"queued for a {key} pool box: {busy}/{cap} busy, {waiting} other caller(s) waiting; "
                    f"will wait up to {wait}s" + (f" ({last_error})" if last_error else "") +
                    f". Use a tool timeout above {wait}s or run this in a background shell.")
                said = True
            else:
                say(f"still queued for a {key} pool box: waited {int(t-started)}s of {wait}s, "
                    f"{busy}/{cap} busy, {waiting} other caller(s) waiting")
            next_progress = t + PROGRESS_EVERY_S
        time.sleep(min(2, max(0, deadline-time.monotonic())))


def try_warm(me, size, source, exclude, run_id):
    """Claim a free running peer once, without resuming, growing or creating a box."""
    from . import lease
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
                if bid in exclude or row['state'] != 'running' or row['size'] != size:
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
                    if con.execute("SELECT 1 FROM kv WHERE k IN (?,?)",
                                   (f'resume_unanswered:{bid}', f'resume_provision:{bid}')).fetchone():
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
                if not lease.ensure_ttl(got['box_id'], RUN_TTL_S):
                    return None
                _claim(con, me, got, run_id)
                claimed = True
                return got
            finally:
                if not claimed:
                    release_guard(got)
    except OffboxError:
        # A contended pool is optional here: keep the already-held cold box.
        return None
    finally:
        con.close()
    return None


def _claim(con, me, row, run_id):
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
        old = con.execute("SELECT state FROM leases WHERE box_id=?", (last[0],)).fetchone()
        state = old[0] if old else "gone"
        state = state if state in ("stopped", "archived") else "busy" if state == "running" else "gone"
        detail = ("new checkout there, dependencies not carried over" if row["_new_checkout"]
                  else "existing checkout there")
        say(f"your last box {last[0]} is {state}; using {bid} ({detail})")
    con.execute("INSERT OR REPLACE INTO pool_members VALUES (?,?)", (bid, me["repo_key"]))
    con.execute("INSERT OR REPLACE INTO pool_callers VALUES (?,?,?,?)",
                (me["owner"], me["repo_root"], bid, row["remote_dir"]))
    # Shared leases outlive their original worker's archive state.
    con.execute("UPDATE leases SET thread_gone_since=NULL, last_used_at=? WHERE box_id=?", (now(), bid))
    if run_id:
        con.execute("UPDATE runs SET box_id=?,remote_dir=?,size=? WHERE run_id=?",
                    (bid, row["remote_dir"], row["size"], run_id))
    con.commit()


def _refresh_background(con, key, pull_artifacts=True):
    """Detached runs have no lock holder; reclaim completed slots without waiting for the reaper."""
    from . import api, runs
    from .misc import _catch_up_finished
    rows = con.execute("""SELECT r.* FROM runs r JOIN leases l USING(box_id)
        WHERE l.repo_key=? AND r.mode='bg' AND r.status='running' AND r.process_id IS NOT NULL""", (key,)).fetchall()
    for row in rows:
        if api.left() is not None and api.left() <= 0:
            break
        try:
            with file_lock('box-'+row['box_id'], timeout=0):
                left = api.left()
                options = {} if left is None else {"deadline": time.time() + left, "retries": 0}
                st = api.cmd_status(row['box_id'], row['process_id'], **options)
                if st and not st.get('running') and st.get('status') in ('exited', 'lost'):
                    code = st.get('exitCode')
                    if code is None and row['command_id']:
                        code = (api.history_get(row['box_id'], row['command_id']) or {}).get('exitCode')
                    if (st.get('status') == 'exited' and code == runs.EXIT_REPO_SETUP
                            and runs.REPO_SETUP_FAILED_MARKER in (st.get('stderr') or '').splitlines()):
                        runs.finish(row['run_id'], EXIT_INFRA, 'infra')
                        _catch_up_finished(con, row['run_id'])
                        continue
                    wedged = runs.settle_box_wedged(con, row, code)
                    if wedged:
                        say(runs.wedged_message(row['box_id'], *wedged))
                        continue
                    import json
                    pulls = json.loads(row['pulls'] or '[]')
                    if pulls:
                        if not pull_artifacts:
                            continue  # pulls keep the slot reserved until the normal follower/reaper finishes
                        runs.do_pulls(row['box_id'], dict(row), pulls)
                    runs.finish(row['run_id'], code)
                    _catch_up_finished(con, row['run_id'])
        except OffboxError:
            pass


def release_guard(row):
    guard = row.pop("_guard", None) if row else None
    if guard:
        guard.__exit__(None, None, None)
