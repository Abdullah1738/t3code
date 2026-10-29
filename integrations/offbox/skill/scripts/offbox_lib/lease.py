"""Leases: bounded repository pools, create / fork / resume / resize, plus ttl policy."""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

from . import api, capacity, ssh_sync
from .common import (SIZES, CAP_PATH, EXIT_BUSY, EXIT_CAP, IDLE_STOP_S, RUN_TTL_S, TEMPLATES_DIR, OffboxError, db, event,
                     file_lock, month_key, new_id, now, read_json, say)
from .identity import remote_dir_for

# Direct (non-pool) callers only: pool callers skip an archiving box instead of waiting under the pool lock.
ARCHIVING_WAIT_S = 120
SHRINK_REFUSED = (400, 409, 422)  # boat's answers to "data does not fit the smaller size"
SHRINK_TEXT = re.compile(r"\b(disk|fits?|shrink\w*|smaller|too small|size)\b", re.I)  # ...and what that answer talks about
DEFAULT_SIZE = {"crpko-harness": "xlarge", "crpko-go": "large", "crpko-node": "large", "generic": "default"}


def _rank(size: str | None) -> int:
    return SIZES.index(size) if size in SIZES else SIZES.index("default")


def natural_size(con, row) -> str:
    """Size a stopped pooled box resumes at when a run asks for nothing bigger.

    Its template's size (generic stays default); bases and fresh boxes never go below large, which is what
    ordinary Go/Python runs got before boxes were shrunk."""
    src = row["source"] or ""
    if src == "template:generic":
        return "default"
    size = "large"
    if src.startswith("base:"):
        b = con.execute("SELECT size FROM bases WHERE name=?", (src[5:],)).fetchone()
        size = (b and b["size"]) or "large"
    elif src.startswith("template:"):
        size = DEFAULT_SIZE.get(src[9:], "large")
    return size if _rank(size) >= _rank("large") else "large"


DOCKER_CMD = re.compile(r"docker|compose|testcontainers|localstack")
DOCKER_MANIFEST = re.compile(r"testcontainers|dockertest")


def uses_docker(cmd: str, repo_root: str) -> bool:
    """A remote run that (probably) starts containers: Docker in the command, or a repo whose tests pull in
    testcontainers/dockertest (Go, Python or Node manifests)."""
    if DOCKER_CMD.search(cmd or ""):
        return True
    for name in ("go.mod", "pyproject.toml", "package.json", "requirements.txt", "requirements-dev.txt"):
        try:
            with open(os.path.join(repo_root, name), errors="replace") as f:
                if DOCKER_MANIFEST.search(f.read(400_000)):
                    return True
        except OSError:
            continue
    return False


def docker_recent(con, box_id: str | None = None, within: int = 7200, repo_root: str | None = None,
                  thread: str | None = None) -> bool:
    """Docker ran lately on this box (its stop archives images and its next boot reloads them, so stop it less),
    or for this repo/thread (local-first then leaves the next check on the box). Recency counts from the run's
    start or end; a run still going counts."""
    if box_id:
        where, args = "box_id=?", [box_id]
    else:
        where, args = "(repo_root=? OR thread_id=?)", [repo_root or "-", thread or "-"]
    t = now() - within
    sql = (f"SELECT 1 FROM runs WHERE {where} AND mode!='local' AND (start_at>? OR end_at>? OR "
           "(end_at IS NULL AND status IN ('starting','running'))) AND (docker=1 OR cmd LIKE '%docker%' "
           "OR cmd LIKE '%compose%' OR cmd LIKE '%testcontainers%') LIMIT 1")
    return con.execute(sql, (*args, t, t)).fetchone() is not None


def idle_for(con, box_id: str, size: str | None, snap: dict | None = None) -> int:
    return capacity.idle_seconds(size, snap, docker=docker_recent(con, box_id))


def cap_check() -> None:
    cap = read_json(CAP_PATH, {})
    if cap.get("capped"):
        raise OffboxError(f"spend cap hit: ${cap.get('spend', 0):.2f} this month (cap $500). New leases are refused.",
                          code=EXIT_CAP)


def pick_template(root: Path, repo_key: str) -> str:
    if repo_key == "crpko-devops":
        return "crpko-go"
    if "harness" in repo_key:
        return "crpko-harness"
    for n in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        if (root / n).is_file():
            return "crpko-harness"
    gomod = root / "go.mod"
    if gomod.is_file():
        try:
            if "testcontainers" in gomod.read_text(errors="replace"):
                return "crpko-harness"
        except OSError:
            pass
        return "crpko-go"
    if (root / "package.json").is_file():
        return "crpko-node"
    return "generic"


def find_lease(con, owner: str, root: str):
    capacity.schema(con)
    # A box with an unconfirmed prune worker is never handed back, not even to its own caller.
    mapped = con.execute("SELECT l.*, c.remote_dir AS caller_dir FROM pool_callers c JOIN leases l USING(box_id) "
                         "WHERE c.owner=? AND c.repo_root=? AND l.state IN ('running','stopped') "
                         "AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=l.box_id)", (owner, root)).fetchone()
    if mapped:
        out = dict(mapped)
        out['remote_dir'] = out.pop('caller_dir')
        return out
    return con.execute("SELECT * FROM leases WHERE owner=? AND repo_root=? AND state IN ('running','stopped') "
                       "AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=leases.box_id) "
                       "ORDER BY last_used_at DESC LIMIT 1", (owner, root)).fetchone()


def active_runs(con, box_id: str) -> int:
    return con.execute("SELECT COUNT(*) FROM runs WHERE box_id=? AND status IN ('starting','running')",
                       (box_id,)).fetchone()[0]


def box_name(me: dict, repo_key: str) -> str:
    who = (me.get("title") or me.get("thread") or me.get("owner") or "local")[:50]
    return f"offbox {repo_key} | {who}"


def ensure_ttl(box_id: str, ttl: int, s: dict | None = None) -> None:
    """Make the boat auto-stop deadline at least `ttl` seconds away (PATCH resets it to now+ttl)."""
    try:
        if s and s.get("archiveAfter"):
            from .common import iso_ts
            left = (iso_ts(s["archiveAfter"]) or 0) - now()
            if left >= ttl - 60:
                return
        api.set_ttl(box_id, ttl)
    except OffboxError as e:
        say(f"warning: could not set auto-stop on {box_id}: {e}")


def idle_ttl(box_id: str) -> None:
    """After a run: stop after the box size's idle window unless another run is active (it refreshes its own ttl)."""
    con = db()
    if active_runs(con, box_id):
        return
    row = con.execute("SELECT size FROM leases WHERE box_id=?", (box_id,)).fetchone()
    ttl = idle_for(con, box_id, row["size"] if row else None)
    if docker_recent(con, box_id):
        # Grace past the reaper's limit so its stop (which archives Docker images first) usually wins over boat's ttl.
        ttl += 300
    try:
        api.set_ttl(box_id, ttl)
    except OffboxError:
        pass


def bootstrap_fresh(box_id: str) -> None:
    """Fresh box (not from a template/base): put tool caches under $HOME so stop/fork keep them."""
    script = (TEMPLATES_DIR / "common-env.sh").read_bytes()
    p = ssh_sync.ssh(box_id, "bash -s", input=script, timeout=120)
    if p.returncode != 0:
        say(f"warning: cache env bootstrap failed on {box_id}: {p.stderr.decode(errors='replace')[-200:]}")


def _new_box(con, me: dict, size: str | None, template: str | None, base: str | None, fresh: bool):
    """-> (sandbox dict, source label, base_remote_dir or None, size)."""
    root = Path(me["repo_root"])
    rk = me["repo_key"]
    idem = new_id("lease")
    name = box_name(me, rk)
    if not fresh:
        brow = None
        if base:
            full = base if ":" in base else f"{rk}:{base}"
            brow = con.execute("SELECT * FROM bases WHERE name=?", (full,)).fetchone()
            if not brow:
                raise OffboxError(f"no saved base '{full}'. See `offbox bases`.", code=2)
        elif not template:
            brow = con.execute("SELECT * FROM bases WHERE repo_key=? AND is_default=1", (rk,)).fetchone()
        if brow:
            sz = size or brow["size"] or "large"
            say(f"forking saved base {brow['name']} ({brow['box_id']}) as {sz}")
            s = api.fork(brow["box_id"], RUN_TTL_S, idem, sz)
            return s, f"base:{brow['name']}", brow["remote_dir"], sz
    tname = template or (None if fresh else pick_template(root, rk))
    if tname and not fresh:
        trow = con.execute("SELECT * FROM templates WHERE name=?", (tname,)).fetchone()
        if not trow and tname != "generic":
            trow = con.execute("SELECT * FROM templates WHERE name='generic'").fetchone()
            if trow:
                say(f"template {tname} not built yet; using generic")
        if trow:
            sz = size or DEFAULT_SIZE.get(tname, "default")
            say(f"forking template {trow['name']} ({trow['box_id']}) as {sz}")
            s = api.fork(trow["box_id"], RUN_TTL_S, idem, sz)
            return s, f"template:{trow['name']}", None, sz
    sz = size or DEFAULT_SIZE.get(tname or "generic", "default")
    say(f"creating a fresh {sz} box (no template/base available)")
    s = api.create(sz, RUN_TTL_S, name, idem)
    return s, "fresh", None, sz


def _bring_up(box_id: str, fresh: bool = False) -> dict:
    s = api.wait_state(box_id, api.LIVE_STATES, timeout=900)
    ssh_sync.setup(box_id)
    ssh_sync.wait_ssh(box_id)
    if fresh:
        bootstrap_fresh(box_id)
    return s


def acquire(me: dict, size: str | None = None, template: str | None = None, base: str | None = None,
            fresh: bool = False, run_id: str | None = None) -> dict:
    from .pool import acquire as pooled
    return pooled(me, size, template, base, fresh, run_id)


def acquire_private(me: dict, size: str | None = None, template: str | None = None, base: str | None = None,
            fresh: bool = False) -> dict:
    """Return a dict lease row with the box running, ssh ready and ttl >= RUN_TTL_S."""
    cap_check()
    con = db()
    with file_lock(f"lease-{me['owner']}-{me['repo_root']}", timeout=1200):
        row = None if me['owner'].startswith('pool:') else find_lease(con, me["owner"], me["repo_root"])
        if row and (base or fresh) and row["state"] in ("running", "stopped"):
            say(f"note: --base/--fresh only apply to a NEW lease; reusing {row['box_id']} "
                f"(`offbox release` first to start over)")
        if row:
            got = _reuse(con, row, size)
            if got:
                return got
        t = now()
        s, source, base_dir, sz = _new_box(con, me, size, template, base, fresh)
        box_id = s["id"]
        rdir = remote_dir_for(me["repo_root"])
        con.execute("""INSERT OR REPLACE INTO leases (box_id, owner, thread_id, session_id, thread_title, manager_thread,
                       repo_root, repo_key, remote_dir, size, source, state, created_at, last_used_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?)""",
                    (box_id, me["owner"], me.get("thread"), me.get("session"), me.get("title"), me.get("manager"),
                     me["repo_root"], me["repo_key"], rdir, sz, source, t, t))
        con.commit()
        event(con, box_id, "lease_new", f"source={source} size={sz} owner={me['owner']} repo={me['repo_root']}")
        try:
            _bring_up(box_id, fresh=(source == "fresh"))
            try:
                api.rename(box_id, box_name(me, me["repo_key"]))
            except OffboxError:
                pass
            if base_dir and base_dir != rdir:
                ssh_sync.ssh(box_id, f"if [ -d ~/{base_dir} ] && [ ! -e ~/{rdir} ]; then mkdir -p ~/$(dirname {rdir}) "
                                     f"&& mv ~/{base_dir} ~/{rdir}; fi", timeout=60)
        except OffboxError:
            raise
        event(con, box_id, "lease_ready", f"{round(now() - t, 1)}s")
        con.execute("UPDATE leases SET ssh_ready_at=? WHERE box_id=?", (now(), box_id))
        con.commit()
        return dict(con.execute("SELECT * FROM leases WHERE box_id=?", (box_id,)).fetchone())


def _bigger(a: str | None, b: str | None) -> bool:
    """True when size a is strictly bigger than size b (unknown sizes count as default)."""
    if not a:
        return False
    rank = {n: i for i, n in enumerate(SIZES)}
    return rank.get(a, 1) > rank.get(b or "default", 1)


class ArchivingSkip(OffboxError):
    """The box is still archiving. Pool callers skip it (like a busy box) instead of waiting under the pool lock."""


def _reuse(con, row, size: str | None, skip_archiving: bool = False):
    box_id = row["box_id"]
    # Fast path: lease marked running and the ssh master answers -> no API calls at all.
    if row["state"] == "running" and not _bigger(size, row["size"]) and ssh_sync.cfg_path(box_id).exists():
        p = subprocess.run(ssh_sync.ssh_base(box_id) + ["-O", "check", box_id], capture_output=True, timeout=10)
        if p.returncode == 0:
            ensure_ttl(box_id, max(RUN_TTL_S, idle_for(con, box_id, row["size"])))
            return dict(row)
    s = api.get(box_id)
    if s is None or s.get("state") in ("error", "cancelled"):
        con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
        con.commit()
        event(con, box_id, "lease_gone", f"state={s and s.get('state')}")
        return None
    st = s.get("state")
    if st == "archiving":
        if skip_archiving:
            raise ArchivingSkip(f"{box_id} is archiving; skipping it for now", code=EXIT_BUSY)
        say(f"{box_id} is stopping; waiting to resume it")
        s = api.wait_state(box_id, api.STOPPED_STATES + api.LIVE_STATES, timeout=ARCHIVING_WAIT_S)
        st = s.get("state")
    # After the archiving wait: a box that came back live still gets the size check below.
    have = s.get("type") or row["size"]
    want = have
    if st in api.LIVE_STATES and _bigger(size, have):
        # Grow a live box only for an explicit bigger --size. Never stop one just to shrink it (that costs a start).
        want = size
        if active_runs(con, box_id):
            raise OffboxError(f"lease {box_id} is {have} with a run in progress; can't resize to {want} now",
                              code=2)
        say(f"resizing {box_id} {have} -> {want} (stop + resume)")
        capacity.check(con)
        api.stop(box_id)
        if skip_archiving:
            # Pool callers hold the pool lock: start the stop and skip the box. A later pass resumes it at the
            # bigger size once boat reports it archived.
            ssh_sync.close_master(box_id)
            con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
            con.commit()
            event(con, box_id, "lease_resize_stop", f"{have} -> {want}")
            raise ArchivingSkip(f"{box_id} is stopping to grow to {want}; skipping it for now", code=EXIT_BUSY)
        # Direct callers wait for the stop, but no longer than the archiving wait: a stop that sticks in
        # archiving, or a box that bounces back to idle, must not hold the caller for 15 minutes.
        try:
            s = api.wait_state(box_id, api.STOPPED_STATES, timeout=ARCHIVING_WAIT_S)
        except OffboxError:
            s = api.get(box_id)
            st = s and s.get("state")
            if st in api.LIVE_STATES and not _bigger(want, s.get("type") or have):
                pass  # live and already big enough: use it
            elif st in api.LIVE_STATES:
                # The stop didn't take and the box is live at its old size. Record that, and refuse rather than
                # hand out a box smaller than the run asked for.
                got = s.get("type") or have
                con.execute("UPDATE leases SET state='running', size=? WHERE box_id=?", (got, box_id))
                con.commit()
                event(con, box_id, "lease_resize_bounced", f"{got}, wanted {want}")
                raise OffboxError(f"{box_id} came back {got} instead of stopping to grow to {want}; "
                                  f"nothing ran, retry") from None
            else:
                # Still stopping: the stop was asked for, so the next caller resumes it once boat says archived.
                ssh_sync.close_master(box_id)
                con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
                con.commit()
                raise
        st = s.get("state")
    if st in api.STOPPED_STATES and want == have:
        # A resume costs a start either way: come back at the requested size or the box's natural size,
        # not the size some earlier run grew it to.
        nat = natural_size(con, row)
        want = size if _bigger(size, nat) else nat
    t = now()
    if st in api.STOPPED_STATES:
        say(f"resuming stopped lease {box_id} ({want})")
        try:
            api.resume(box_id, RUN_TTL_S, want if want != s.get("type") else None)
        except api.ApiError as e:
            # boat refuses to shrink a box whose disk no longer fits the smaller size; keep its size then.
            if not s.get("type") or not _bigger(s.get("type"), want) or (e.status or 0) not in SHRINK_REFUSED \
                    or not SHRINK_TEXT.search(f"{e.api_code} {e}"):
                raise
            say(f"could not shrink {box_id} to {want} ({e}); resuming as {s.get('type')}")
            want = s.get("type")
            api.resume(box_id, RUN_TTL_S, None)
        up = _bring_up(box_id)
        if isinstance(up, dict) and up.get("type") in SIZES:
            want = up["type"]
        event(con, box_id, "lease_resume", f"{round(now() - t, 1)}s size={want}")
    elif st in api.LIVE_STATES or st in api.STARTING_STATES:
        _bring_up(box_id)
        ensure_ttl(box_id, max(RUN_TTL_S, idle_for(con, box_id, want)), s)
    else:
        raise OffboxError(f"lease {box_id} in unexpected state {st}")
    con.execute("UPDATE leases SET state='running', size=?, ssh_ready_at=? WHERE box_id=?", (want, now(), box_id))
    con.commit()
    return dict(con.execute("SELECT * FROM leases WHERE box_id=?", (box_id,)).fetchone())


def keep_images(box_id: str) -> None:
    """Best effort: archive Docker images into $HOME before a stop (boat snapshots drop image layers)."""
    if not ssh_sync.cfg_path(box_id).exists():
        return
    try:
        p = ssh_sync.ssh(box_id, "bash -s", input=(TEMPLATES_DIR / "docker-images.sh").read_bytes(), timeout=900)
        out = (p.stdout + p.stderr).decode(errors="replace").strip().splitlines()
        if out and "none to keep" not in out[-1] and "already kept" not in out[-1]:
            event(db(), box_id, "keep_images", out[-1][:300])
    except Exception as e:  # noqa: BLE001
        event(db(), box_id, "keep_images_failed", str(e)[:300])


_HOLDS_DDL = ("CREATE TABLE IF NOT EXISTS prune_holds ("
              "box_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at REAL NOT NULL)")


def ensure_holds(con) -> None:
    """Create the prune_holds table if this database predates it. common.db() builds only the old schema, and
    capacity.schema() is not guaranteed to have run first, so every hold path makes the table itself."""
    con.execute(_HOLDS_DDL)


def clear_prune_hold(con, box_id: str) -> None:
    """Release a box's prune hold. Call only once no remote process can still run there: the box is deleted.
    Never by time alone. Callers outside a box-locked, fresh-confirmed path must use release_if_confirmed."""
    ensure_holds(con)
    con.execute("DELETE FROM prune_holds WHERE box_id=?", (box_id,))
    con.commit()


def _release_locked(con, box_id: str, run_id: str | None = None) -> bool:
    """The confirmation and release, for a caller that already holds 'box-<id>'. Not reentrant: never call it
    without the lock held. Clears the hold only if no run is active and boat reports the box stopped or gone,
    re-read now, not from an earlier snapshot. run_id, when given, limits the clear to that run's hold."""
    if active_runs(con, box_id):
        return False
    try:
        s = api.get(box_id)
    except OffboxError:
        return False  # a failed read is not confirmation: keep the hold, a later pass retries
    if s is not None and s.get("state") not in api.STOPPED_STATES:
        return False
    ensure_holds(con)
    if run_id is None:
        con.execute("DELETE FROM prune_holds WHERE box_id=?", (box_id,))
    else:
        con.execute("DELETE FROM prune_holds WHERE box_id=? AND run_id=?", (box_id, run_id))
    con.commit()
    return True


def release_if_confirmed(con, box_id: str, run_id: str | None = None) -> bool:
    """For a caller that does NOT hold the box lock: take it (no wait), then confirm and release. A busy lock keeps
    the hold, since a run may be allocating the box right now."""
    try:
        with file_lock('box-' + box_id, timeout=0):
            return _release_locked(con, box_id, run_id)
    except OffboxError:
        return False


def stop_box(con, box_id: str, reason: str, wait: bool = False, images: bool = True, locked: bool = False) -> bool:
    """Stop a box. locked=True when the caller already holds 'box-<id>' (reap, release, save); then the hold is
    released with _release_locked, since the lock is not reentrant."""
    if images:
        keep_images(box_id)
    release = _release_locked if locked else release_if_confirmed
    try:
        api.stop(box_id)
        if wait:
            api.wait_state(box_id, api.STOPPED_STATES, timeout=900)
    except api.ApiError as e:
        if e.status == 404:
            # Release first, then retire the lease only if no hold remains. A failed confirmation keeps the lease
            # state and the hold, so the reaper revisits this box and releases it on a later pass.
            if release(con, box_id):
                con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
                con.commit()
            return False
        raise
    ssh_sync.close_master(box_id)
    con.execute("UPDATE leases SET state='stopped' WHERE box_id=? AND state='running'", (box_id,))
    con.commit()
    # Clear the hold only after boat confirms the box is stopped; a stop merely accepted, or a box resumed in the
    # meantime, keeps its hold.
    release(con, box_id)
    event(con, box_id, "stop", reason)
    return True


def delete_box(con, box_id: str, reason: str) -> bool:
    from .spend import record_final_usage
    record_final_usage(con, box_id)
    ssh_sync.close_master(box_id)
    d = api.delete(box_id)
    op = (d.get("operation") or {}).get("id")
    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
    con.commit()
    clear_prune_hold(con, box_id)  # deleted: no remote process survives
    event(con, box_id, "delete", f"{reason} op={op}")
    return True


def touch(box_id: str) -> None:
    con = db()
    con.execute("UPDATE leases SET last_used_at=? WHERE box_id=?", (now(), box_id))
    con.commit()


def wait_ready_after(box_id: str, seconds: float) -> None:
    time.sleep(seconds)
