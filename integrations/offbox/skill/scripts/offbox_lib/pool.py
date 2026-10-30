"""Bounded repository pools; one run per box (including sync and artifact pulls)."""

from __future__ import annotations

import hashlib
import time

from . import capacity
from .common import EXIT_BUSY, EXIT_INFRA, SIZES, TOO_BIG_NOTE, OffboxError, db, file_lock, now, say
from .identity import remote_dir_for

WAIT_DEFAULT_S = 600
WAIT_MAX_S = 1200
PROGRESS_EVERY_S = 60


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


TOO_BIG_LIKE = f"{TOO_BIG_NOTE}%"  # a box marked too big frees its pool slot and is never offered again


def members(con, key):
    return con.execute(f"""SELECT l.* FROM leases l JOIN pool_members p USING(box_id)
        WHERE p.pool_key=? AND l.state IN ('running','stopped') AND COALESCE(l.note,'') NOT LIKE ?
        ORDER BY (l.state='running') DESC, l.last_used_at DESC""", (key, TOO_BIG_LIKE)).fetchall()


def _room(con, key) -> bool:
    return len(members(con, key)) < capacity.setting("OFFBOX_POOL_SIZE", 4, maximum=8)


def candidates(con, key, size, source, me=None):
    # Existing boxes count toward the cap once adopted; surplus legacy boxes are left intact.
    rows = con.execute("""SELECT l.*, p.pool_key FROM leases l LEFT JOIN pool_members p USING(box_id)
        WHERE l.repo_key=? AND l.state IN ('running','stopped')
        AND COALESCE(l.note,'') NOT LIKE ?
        AND NOT EXISTS (SELECT 1 FROM bases b WHERE b.box_id=l.box_id)
        AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.box_id=l.box_id)
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.box_id=l.box_id AND r.status IN ('starting','running'))
        AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=l.box_id)
        ORDER BY (l.state='running') DESC, (l.size=?) DESC, l.last_used_at DESC""",
        (key, TOO_BIG_LIKE, size)).fetchall()
    full = not _room(con, key)
    out = []
    for r in rows:
        if r["pool_key"] not in (None, key) or (full and r["pool_key"] is None):
            continue
        if source and r["source"] != source:
            continue
        out.append(r)
    # Running boxes first: the caller's own box (its checkout is already synced there), then the smallest that
    # fits. A running box bigger than this run needs (grown by an earlier --size run) goes after a stopped box
    # while starts are plentiful: the stopped one resumes at the right size and the big one stops on its short
    # idle timer.
    from . import lease
    rank = {n: i for i, n in enumerate(SIZES)}
    want = rank.get(size or "", 0)
    plentiful = capacity.starts_plentiful(capacity.snapshot(con))
    mine = set()
    if me and me.get("owner") and me.get("repo_root"):
        mine = {r[0] for r in con.execute("SELECT box_id FROM pool_callers WHERE owner=? AND repo_root=?",
                                          (me["owner"], me["repo_root"]))}

    def fit(r):
        if r["state"] != "running":
            return (1, 0, 0)  # stable sort keeps most-recently-used first
        have = rank.get(r["size"] or "default", 1)
        own = 0 if r["box_id"] in mine else 1
        if have < want:
            return (0, 2, have)  # needs a grow
        if plentiful and own and have > max(want, rank.get(lease.natural_size(con, r), 1)):
            return (2, 0, have)
        return (0, own, have)
    out.sort(key=fit)
    return out, not full


def acquire(me, size=None, template=None, base=None, fresh=False, run_id=None):
    con = db()
    try:
        return _acquire(con, me, size, template, base, fresh, run_id)
    finally:
        con.close()


def _acquire(con, me, size, template, base, fresh, run_id):
    from . import lease
    lease.cap_check()
    capacity.schema(con)
    key = me["repo_key"]
    source = ("fresh" if fresh else f"base:{base if ':' in base else key+':'+base}" if base else
              f"template:{template}" if template else None)
    wait = wait_seconds()
    started = time.monotonic()
    deadline = started + wait
    said, last_error = False, None
    next_refresh = 0
    next_progress = 0
    while True:
        lease.cap_check()
        # Only the latest pass decides whether a timeout was a start limit (90) or plain busy (92).
        last_error = None
        # Every candidate is also protected by its box lock. The DB run reservation bridges
        # detached commands and prevents a reaper or another client from syncing over them.
        with file_lock(lock_name(key), timeout=max(1, deadline-time.monotonic())):
            if time.monotonic() >= next_refresh:
                _refresh_background(con, key)
                next_refresh = time.monotonic() + 10
            rows, can_create = candidates(con, key, size, source, me)
            stopped_tries = 0
            stopped_error = None
            stopped_failed = False  # the last stopped box tried could not be used (error or gone)
            for row in rows:
                if row['state'] != 'running':
                    # One resume per pass, a second only after the first stopped box failed to come up;
                    # later running rows may still be free either way.
                    if stopped_tries >= 2 or (stopped_tries == 1 and not stopped_failed):
                        continue
                    try:
                        capacity.check(con)
                    except capacity.CapacityError as e:
                        last_error = e
                        continue
                guard = file_lock("box-"+row["box_id"], timeout=0)
                try:
                    guard.__enter__()
                except OffboxError:
                    continue
                try:
                    if lease.active_runs(con, row["box_id"]):
                        continue
                    try:
                        # A live box grows for an explicit bigger --size but never shrinks (that costs a start);
                        # a stopped one resumes at max(--size, its natural size) inside lease._reuse.
                        grow = (row['state'] == 'running' and bool(size)
                                and SIZES.index(row['size'] or 'default') < SIZES.index(size))
                        if grow:
                            capacity.check(con)
                        if row['state'] != 'running':
                            stopped_tries += 1
                        got = lease._reuse(con, row, size, skip_archiving=True)
                    except capacity.CapacityError as e:
                        last_error = e
                        continue
                    except lease.ArchivingSkip as e:
                        # Busy-like: the box is still archiving, so try the next member. It does not
                        # make the pool look full, so a create below still runs when under cap.
                        if row['state'] != 'running':
                            stopped_tries -= 1  # skipped, not tried: the next stopped member still gets its turn
                        say(f"skipping pool box {row['box_id']}: {e}")
                        continue
                    except lease.DiskTooBig as e:
                        # Marked and left stopped: it no longer counts toward the pool. Not stopped_error, so a
                        # still-full pool queues (exit 92) instead of failing with the resume error (exit 90).
                        stopped_failed = True
                        can_create = _room(con, key)
                        say(f"skipping {row['box_id']}: its disk needs {e.need} GiB but '{e.size}' holds {e.holds} GiB. "
                            f"It stays stopped with its disk and no longer counts toward the pool (remove it with: "
                            f"offbox release {row['box_id']} --delete). Trying other pool boxes, then a fresh lease.")
                        continue
                    except OffboxError as e:
                        if row['state'] == 'running' or e.code != EXIT_INFRA:
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
                finally:
                    if guard is not None:
                        guard.__exit__(None, None, None)
            if stopped_error is not None and not can_create:
                raise stopped_error
            if can_create:
                try:
                    capacity.check(con)
                    shared = dict(me, owner="pool:"+key, thread=None, session=None, title="repository pool", manager=None)
                    creator = getattr(lease, 'acquire_private', lease.acquire)
                    got = creator(shared, size, template, base, fresh)
                    guard = file_lock("box-"+got["box_id"], timeout=0)
                    guard.__enter__()
                    try:
                        _claim(con, me, got, run_id)
                    except BaseException:
                        guard.__exit__(None, None, None)
                        raise
                    got["_guard"] = guard
                    return got
                except capacity.CapacityError as e:
                    last_error = e
        t = time.monotonic()
        if t >= deadline:
            if last_error:
                raise capacity.CapacityError(str(last_error))
            busy, cap, waiting = queue_state(con, key, run_id)
            raise PoolBusyError(f"repository pool busy/full for {key}: {busy}/{cap} boxes stayed busy for "
                                f"{int(t-started)}s; remote queue timed out. Nothing ran (exit {EXIT_BUSY}, not an "
                                f"infra failure): retry, or raise OFFBOX_POOL_WAIT_SECONDS (max {WAIT_MAX_S})")
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


def _claim(con, me, row, run_id):
    bid = row["box_id"]
    row["remote_dir"] = remote_dir_for(me["repo_root"])
    con.execute("INSERT OR REPLACE INTO pool_members VALUES (?,?)", (bid, me["repo_key"]))
    con.execute("INSERT OR REPLACE INTO pool_callers VALUES (?,?,?,?)",
                (me["owner"], me["repo_root"], bid, row["remote_dir"]))
    # Shared leases outlive their original worker's archive state.
    con.execute("UPDATE leases SET thread_gone_since=NULL, last_used_at=? WHERE box_id=?", (now(), bid))
    if run_id:
        con.execute("UPDATE runs SET box_id=?,remote_dir=?,size=? WHERE run_id=?",
                    (bid, row["remote_dir"], row["size"], run_id))
    con.commit()


def _refresh_background(con, key):
    """Detached runs have no lock holder; reclaim completed slots without waiting for the reaper."""
    from . import api, runs
    rows = con.execute("""SELECT r.* FROM runs r JOIN leases l USING(box_id)
        WHERE l.repo_key=? AND r.mode='bg' AND r.status='running' AND r.process_id IS NOT NULL""", (key,)).fetchall()
    for row in rows:
        try:
            with file_lock('box-'+row['box_id'], timeout=0):
                st = api.cmd_status(row['box_id'], row['process_id'])
                if st and not st.get('running') and st.get('status') == 'exited':
                    import json
                    pulls = json.loads(row['pulls'] or '[]')
                    if pulls:
                        runs.do_pulls(row['box_id'], dict(row), pulls)
                    runs.finish(row['run_id'], st.get('exitCode'))
        except OffboxError:
            pass


def release_guard(row):
    guard = row.pop("_guard", None) if row else None
    if guard:
        guard.__exit__(None, None, None)
