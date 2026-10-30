"""Leases: bounded repository pools, create / fork / resume / resize, plus ttl policy."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import time
from pathlib import Path

from . import api, capacity, ssh_sync
from .common import (SIZES, CAP_PATH, EXIT_BUSY, EXIT_CAP, IDLE_STOP_S, RUN_TTL_S, TEMPLATES_DIR, TOO_BIG_NOTE, OffboxError, db, event,
                     file_lock, month_key, new_id, now, read_json, say)
from .identity import remote_dir_for

# Direct (non-pool) callers only: pool callers skip an archiving box instead of waiting under the pool lock.
ARCHIVING_WAIT_S = 120
SHRINK_REFUSED = (400, 409, 422)  # boat's answers to "data does not fit the smaller size"
SHRINK_TEXT = re.compile(r"\b(disk|fits?|shrink\w*|smaller|too small|size)\b", re.I)  # ...and what that answer talks about
DISK_TOO_BIG = re.compile(r"needs\s+([\d.]+)\s*GiB of disk but the largest '([\w-]+)' machine holds\s+([\d.]+)\s*GiB",
                          re.I)  # boat's 409 for a stopped box whose disk outgrew every machine of its size
DEFAULT_SIZE = {"crpko-harness": "xlarge", "crpko-go": "large", "crpko-node": "large", "generic": "default"}


def _rank(size: str | None) -> int:
    return SIZES.index(size) if size in SIZES else SIZES.index("default")


def natural_size(con, row) -> str:
    """Size a stopped pooled box resumes at when a run asks for nothing bigger.

    Its template's size (generic stays default); bases and fresh boxes never go below large, which is what
    ordinary Go/Python runs got before boxes were shrunk."""
    src = row["source"] or ""
    if src in ("template:generic", "recipe:generic"):
        return "default"
    size = "large"
    if src.startswith("base:"):
        b = con.execute("SELECT size FROM bases WHERE name=?", (src[5:],)).fetchone()
        size = (b and b["size"]) or "large"
    elif src.startswith(("template:", "recipe:")):
        size = DEFAULT_SIZE.get(src.split(":", 1)[1], "large")
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


TYPECHECK_CMD = re.compile(r"\btsc(-rs)?\b|\btypecheck\b")


def typecheck_size(cmd: str, repo_root: str, size: str | None) -> str | None:
    """Type-check runs in JS/TS repos get xlarge: large boxes get OOM-killed (exit 137) on the Robob server
    typecheck. An explicit size always wins; only repos with a package.json are affected."""
    if size:
        return size
    if TYPECHECK_CMD.search(cmd or "") and os.path.isfile(os.path.join(repo_root or "", "package.json")):
        return "xlarge"
    return None


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


def _start_from(con, table: str, row, sz: str, name: str, idem: str) -> dict | None:
    """Start a box from a template/base row: its saved snapshot, else a fork of its stopped box.

    None when boat has deleted the stopped box's data (14 days after it stopped); the row is marked expired."""
    kind = table[:-1]
    if row["saved"]:
        say(f"starting {kind} {row['name']} from its saved snapshot {row['saved']} as {sz}")
        try:
            return api.create(sz, RUN_TTL_S, name, f"{idem}-{kind}-saved", saved=row["saved"])
        except api.ApiError as e:
            if not api.data_gone(e):
                raise
            say(f"saved snapshot {row['saved']} of {kind} {row['name']} is gone ({e}); forking its box")
            con.execute(f"UPDATE {table} SET saved=NULL WHERE name=?", (row["name"],))
            con.commit()
            event(con, row["box_id"], f"{kind}_saved_gone", f"{row['name']} {row['saved']}: {e}")
    if row["expired_at"]:
        return None
    say(f"forking {kind} {row['name']} ({row['box_id']}) as {sz}")
    try:
        return api.fork(row["box_id"], RUN_TTL_S, f"{idem}-{kind}", sz)
    except api.ApiError as e:
        if not api.data_gone(e):
            raise
        con.execute(f"UPDATE {table} SET expired_at=? WHERE name=?", (now(), row["name"]))
        con.commit()
        event(con, row["box_id"], f"{kind}_expired", f"{row['name']}: {e}")
        return None


def _new_box(con, me: dict, size: str | None, template: str | None, base: str | None, fresh: bool):
    """-> (sandbox dict, source label, base_remote_dir or None, size).

    Source "recipe:<template>" is a fresh box that _bring_up builds from the template's recipe because boat
    deleted the template's data."""
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
            brow = con.execute("SELECT * FROM bases WHERE repo_key=? AND is_default=1 "
                               "AND (expired_at IS NULL OR saved IS NOT NULL)", (rk,)).fetchone()
        if brow:
            sz = size or brow["size"] or "large"
            s = _start_from(con, "bases", brow, sz, name, idem)
            if s:
                return s, f"base:{brow['name']}", brow["remote_dir"], sz
            if base:
                raise OffboxError(f"saved base '{brow['name']}' is gone: boat deletes a stopped box's data after 14 "
                                  f"days. Run without --base and `offbox save` again; `offbox base rm "
                                  f"{brow['short'] or brow['name']}` drops the entry.", code=2)
            say(f"default base {brow['name']} is gone (boat deleted its data); using the repo template")
    tname = template or (None if fresh else pick_template(root, rk))
    if tname and not fresh:
        trow = con.execute("SELECT * FROM templates WHERE name=?", (tname,)).fetchone()
        if not trow and tname != "generic":
            trow = con.execute("SELECT * FROM templates WHERE name='generic'").fetchone()
            if trow:
                say(f"template {tname} not built yet; using generic")
        if trow:
            sz = size or DEFAULT_SIZE.get(tname, "default")
            s = _start_from(con, "templates", trow, sz, name, idem)
            if s:
                return s, f"template:{trow['name']}", None, sz
            say(f"template {trow['name']} is gone (boat deleted its data); building this box from its recipe "
                f"instead, which takes a few minutes. The reaper rebuilds the template.")
            s = api.create(sz, RUN_TTL_S, name, idem + "-recipe")
            return s, f"recipe:{trow['name']}", None, sz
    sz = size or DEFAULT_SIZE.get(tname or "generic", "default")
    say(f"creating a fresh {sz} box (no template/base available)")
    s = api.create(sz, RUN_TTL_S, name, idem)
    return s, "fresh", None, sz


# A recipe fallback runs inside a lease bring-up (harness ~6 min). Past this it is cancelled and the box retired,
# not waited for: the TTL keeper would otherwise keep the box alive and billing while the pool lock is held.
RECIPE_TIMEOUT_S = 15 * 60


def _retire_recipe_box(box_id: str, pid, why: str) -> bool:
    """A box whose recipe did not finish cleanly is never handed out or reused: it may be half built, or its recipe
    may still be changing it. Quarantine it (pools and reuse only take running/stopped leases), stop the recipe, and
    delete the box: deletion is the one proof the recipe can no longer touch it. A failed delete leaves the lease
    quarantined and the reaper deletes it on a later pass. True once deleted."""
    con = db()
    con.execute("UPDATE leases SET state='quarantined' WHERE box_id=?", (box_id,))
    con.commit()
    event(con, box_id, "lease_quarantined", why[:300])
    if pid is not None:
        try:
            api.cmd_kill(box_id, pid)
        except OffboxError as e:
            say(f"warning: could not stop the recipe process on {box_id}: {e}")
    try:
        return delete_box(con, box_id, f"recipe cancelled: {why}"[:300])
    except OffboxError as e:
        say(f"warning: could not delete {box_id} ({e}); it stays quarantined until the reaper deletes it")
        return False


def run_recipe(box_id: str, name: str) -> None:
    """Build a template's environment on this box (the script `offbox template build` runs). Only a recipe that
    exits 0 makes the box ready. Any other outcome (failure, error, lost stream, timeout) retires the box and
    raises, so a half-built box is never marked ready or reused."""
    from . import bases
    from .common import LOGS_DIR
    t = now()
    log_path = LOGS_DIR / f"recipe-{name}-{box_id}.log"
    pid = None
    code = None
    try:
        # The box lock keeps the reaper from idle-stopping the box while the recipe runs.
        with file_lock("box-" + box_id, timeout=60):
            script, _sha = bases.recipe(name)
            ssh_sync.put_file(box_id, "/home/user/.offbox/recipe.sh", script.encode(), mode="700")
            bases.template_uploads(name, box_id)
            r = api.cmd_start(box_id, "bash -lc " + shlex.quote("bash ~/.offbox/recipe.sh"))
            pid = r["processId"]
            event(db(), box_id, "lease_recipe_pid", str(pid))
            code = _follow_bounded(box_id, pid, log_path, RECIPE_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - an upload/start/follow error is a failed recipe like any other
        code = f"error: {e}"
    touch(box_id)
    event(db(), box_id, "lease_recipe", f"{name} exit={code} {round(now() - t)}s")
    if code == 0:
        return
    what = (f"did not finish within {RECIPE_TIMEOUT_S // 60} min" if code == "timeout"
            else f"failed ({str(code)[:200]})")
    gone = _retire_recipe_box(box_id, pid, f"{name} recipe {what}")
    raise OffboxError(f"recipe {name} {what} on {box_id}; log {log_path}. "
                      + ("The box was deleted." if gone else "The box is quarantined until the reaper deletes it."))


def _follow_bounded(box_id: str, pid: int, log_path, timeout_s: float):
    """follow() in a helper thread, joined up to timeout_s. On timeout the follower is told to stop and joined
    (it notices within one frame, or when its stream read times out); its TTL keeper is joined inside follow()."""
    import threading
    from .runs import follow
    result: dict = {}
    stop_evt = threading.Event()

    def run():
        try:
            result["code"] = follow(box_id, pid, log_path, echo=False, stop_evt=stop_evt)
        except Exception as e:  # noqa: BLE001
            result["code"] = f"error: {e}"

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        stop_evt.set()
        th.join(_FOLLOW_STOP_S)
        return "timeout"
    return result.get("code")


# A follower sees the stop signal at its next frame, or when its stream read times out (api.cmd_attach: 90 s), then
# joins its TTL keeper (runs._KEEPER_JOIN_S).
_FOLLOW_STOP_S = 160


def _bring_up(box_id: str, fresh: bool = False, recipe: str | None = None) -> dict:
    s = api.wait_state(box_id, api.LIVE_STATES, timeout=900)
    ssh_sync.setup(box_id)
    ssh_sync.wait_ssh(box_id)
    if recipe:
        run_recipe(box_id, recipe)
    elif fresh:
        bootstrap_fresh(box_id)
    return s


def refresh_box(con, box_id: str) -> None:
    """Resume and stop a stopped box: boat counts its 14-day data limit from the last stop."""
    capacity.check(con)
    api.resume(box_id, 600)
    api.wait_state(box_id, api.LIVE_STATES, timeout=60)
    api.stop(box_id)
    event(con, box_id, "refresh", "resume + stop restarts boat's 14-day data limit")


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
        is_recipe = source.startswith("recipe:")
        # A recipe-sourced box is 'bringing_up' until its recipe has finished: pools and reuse only take
        # running/stopped leases, so a process killed mid-bring-up (Ctrl-C, SIGTERM, a tool timeout) leaves a row no
        # one can hand out as ready. The reaper deletes such rows (see reap._reap).
        state = "bringing_up" if is_recipe else "running"
        con.execute("""INSERT OR REPLACE INTO leases (box_id, owner, thread_id, session_id, thread_title, manager_thread,
                       repo_root, repo_key, remote_dir, size, source, state, created_at, last_used_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (box_id, me["owner"], me.get("thread"), me.get("session"), me.get("title"), me.get("manager"),
                     me["repo_root"], me["repo_key"], rdir, sz, source, state, t, t))
        con.commit()
        event(con, box_id, "lease_new", f"source={source} size={sz} owner={me['owner']} repo={me['repo_root']}")
        try:
            _bring_up(box_id, fresh=(source == "fresh"),
                      recipe=source.split(":", 1)[1] if is_recipe else None)
            try:
                api.rename(box_id, box_name(me, me["repo_key"]))
            except OffboxError:
                pass
            if base_dir and base_dir != rdir:
                ssh_sync.ssh(box_id, f"if [ -d ~/{base_dir} ] && [ ! -e ~/{rdir} ]; then mkdir -p ~/$(dirname {rdir}) "
                                     f"&& mv ~/{base_dir} ~/{rdir}; fi", timeout=60)
        except OffboxError as e:
            # A recipe-sourced box that failed anywhere in bring-up (before, during or after the recipe) is blank or
            # half built. It must not stay a pool candidate, or a later acquisition would hand it out as ready.
            if is_recipe:
                _retire_recipe_box(box_id, None, f"bring-up failed before the recipe finished: {e}")
            raise
        event(con, box_id, "lease_ready", f"{round(now() - t, 1)}s")
        # Only now is a recipe box reusable: the recipe finished (exit 0) and the bring-up completed.
        con.execute("UPDATE leases SET ssh_ready_at=?, state=CASE WHEN state='bringing_up' THEN 'running' ELSE state END "
                    "WHERE box_id=?", (now(), box_id))
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


def _forget_expired(con, box_id: str, why: str) -> None:
    """boat deleted this stopped box's data (14 days after its stop): nothing to resume, a new box replaces it."""
    say(f"lease {box_id} expired ({why}); starting a new box")
    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
    con.commit()
    event(con, box_id, "lease_expired", why)


class DiskTooBig(OffboxError):
    """A stopped box's disk outgrew every machine of its size, so boat refuses the resume. The box is marked
    (leases.note) and left stopped and untouched; pool callers skip it and stop counting it toward the pool."""

    def __init__(self, box_id: str, need: str, size: str, holds: str):
        super().__init__(f"{box_id} needs {need} GiB of disk but '{size}' holds {holds} GiB")
        self.need, self.size, self.holds = need, size, holds


def _too_big(con, box_id: str, e: api.ApiError):
    """DiskTooBig for boat's 'disk outgrew its machine size' refusal (marks the lease), else None."""
    m = DISK_TOO_BIG.search(str(e)) if (e.status or 0) in SHRINK_REFUSED else None
    if not m:
        return None
    need, size, holds = m.group(1), m.group(2), m.group(3)
    con.execute("UPDATE leases SET note=? WHERE box_id=?",
                (f"{TOO_BIG_NOTE} needs {need} GiB, {size} holds {holds} GiB", box_id))
    con.commit()
    event(con, box_id, "lease_too_big", f"needs {need} GiB, {size} holds {holds} GiB")
    return DiskTooBig(box_id, need, size, holds)


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
    if s.get("dataExpiredAt"):
        _forget_expired(con, box_id, f"boat deleted its data at {s['dataExpiredAt']}")
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
            if e.api_code in api.DATA_GONE:
                _forget_expired(con, box_id, str(e))
                return None
            # boat refuses to shrink a box whose disk no longer fits the smaller size; keep its size then.
            if not s.get("type") or not _bigger(s.get("type"), want) or (e.status or 0) not in SHRINK_REFUSED \
                    or not SHRINK_TEXT.search(f"{e.api_code} {e}"):
                tb = _too_big(con, box_id, e)
                if tb:
                    raise tb from e
                raise
            say(f"could not shrink {box_id} to {want} ({e}); resuming as {s.get('type')}")
            want = s.get("type")
            try:
                api.resume(box_id, RUN_TTL_S, None)
            except api.ApiError as e2:
                tb = _too_big(con, box_id, e2)
                if tb:
                    raise tb from e2
                raise
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


def settle_stranded_runs(con, box_id: str) -> int:
    """Mark the box's starting/running runs lost. Call only once boat has confirmed the box is gone or stopped, so
    no process can still be running them. A run that outlived its client (no one left to end it) is then not
    counted as active forever. Caller holds 'box-<id>'. Returns how many runs were settled."""
    cur = con.execute("UPDATE runs SET status='lost', end_at=? WHERE box_id=? AND status IN ('starting','running')",
                      (now(), box_id))
    con.commit()
    if cur.rowcount:
        event(con, box_id, "run_lost", f"{cur.rowcount} stranded run(s) settled: box confirmed gone or stopped")
    return cur.rowcount


def _release_locked(con, box_id: str, run_id: str | None = None) -> bool:
    """The confirmation and release, for a caller that already holds 'box-<id>'. Not reentrant: never call it
    without the lock held. Boat is asked first, not after the active-run check: a box confirmed gone or stopped has
    no live process, so its stranded runs are settled and then the hold can go. A live box with an active run is
    never released. A failed read is not confirmation. run_id, when given, limits the clear to that run's hold."""
    try:
        s = api.get(box_id)
    except OffboxError:
        return False  # a failed read is not confirmation: keep the hold, a later pass retries
    if s is not None and s.get("state") not in api.STOPPED_STATES:
        return False  # boat reports it live: its runs may be real, so nothing is settled and nothing released
    settle_stranded_runs(con, box_id)
    if active_runs(con, box_id):
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
