"""Saved state: bases (stopped forks of a lease) and templates (stopped golden boxes). Never named snapshots."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import time

from . import api, capacity, lease, ssh_sync
from .common import (BASES_SOFT_LIMIT, RUN_TTL_S, TEMPLATES, TEMPLATES_DIR, OffboxError, ago, db, event, file_lock,
                     iso_ts, new_id, now, say)

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,40}$")


def _caller_lease(me: dict):
    con = db()
    row = lease.find_lease(con, me["owner"], me["repo_root"])
    if not row:
        raise OffboxError("no lease for this thread + repo yet. Run something with `offbox run -- ...` first.", code=2)
    return con, row


def save(me: dict, name: str = "default", make_default: bool = False, note: str | None = None) -> dict:
    con, row = _caller_lease(me)
    # Do not stop a usable warm box only to discover there is no fork allowance.
    capacity.check(con)
    with file_lock('box-'+row['box_id'], timeout=120):
        if lease.active_runs(con, row['box_id']):
            raise OffboxError('repository pool box is busy; save after the run completes')
        return _save(me, name, make_default, note)


def _save(me: dict, name: str = "default", make_default: bool = False, note: str | None = None) -> dict:
    if not NAME_RE.match(name):
        raise OffboxError("base name: lowercase letters, digits, . _ - (max 41 chars)", code=2)
    con, row = _caller_lease(me)
    full = f"{me['repo_key']}:{name}"
    src = row["box_id"]
    s = api.get(src)
    if not s:
        raise OffboxError(f"lease box {src} no longer exists", code=2)
    t = now()
    # A fork copies the source's LATEST snapshot. Auto snapshots of a running box lag up to ~1 min, so make a fresh one:
    # idle lease -> stop it (stop always snapshots; ~4 s; the next run resumes it), busy lease -> wait for the next auto
    # snapshot that started after now.
    if s.get("state") in api.LIVE_STATES:
        ssh_sync.setup(src)
        p = ssh_sync.ssh(src, "bash -s", input=(TEMPLATES_DIR / "docker-images.sh").read_bytes(), timeout=1800)
        out = (p.stdout + p.stderr).decode(errors="replace").strip()
        if out:
            say(out.splitlines()[-1][:300])
        ssh_sync.ssh(src, "sync", timeout=60)
        if lease.active_runs(con, src):
            say("a run is in progress: waiting for the next automatic snapshot (up to ~2 min)")
            _wait_snapshot_after(src, t)
        else:
            say(f"stopping the lease {src} to capture its disk (next offbox run resumes it)")
            lease.stop_box(con, src, "save", wait=True)
    elif s.get("state") == "archiving":
        api.wait_state(src, api.STOPPED_STATES, timeout=900)
    say(f"forking {src} -> new base {full} (one start; free once stopped)")
    f = api.fork(src, 3600, new_id("base"))
    bid = f["id"]
    api.wait_state(bid, api.LIVE_STATES + api.STOPPED_STATES, timeout=900)
    try:
        api.rename(bid, f"offbox base {full}")
    except OffboxError:
        pass
    api.stop(bid)
    api.wait_state(bid, api.STOPPED_STATES, timeout=900)
    snap = api.latest_snapshot(bid) or {}
    with file_lock("bases"):
        old = con.execute("SELECT * FROM bases WHERE name=?", (full,)).fetchone()
        if make_default:
            con.execute("UPDATE bases SET is_default=0 WHERE repo_key=?", (me["repo_key"],))
        is_def = 1 if (make_default or (old and old["is_default"])) else 0
        con.execute("""INSERT OR REPLACE INTO bases (name, repo_key, short, box_id, from_box, size, remote_dir, is_default,
                       note, created_at, created_by, size_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (full, me["repo_key"], name, bid, src, row["size"], row["remote_dir"], is_def, note, now(),
                     me["owner"], snap.get("sizeBytes")))
        con.commit()
    event(con, bid, "base_save", f"{full} from={src} default={is_def} {round(now() - t)}s")
    if old and old["box_id"] != bid:
        try:
            api.delete(old["box_id"])
            event(con, old["box_id"], "base_replaced", f"{full} -> {bid}")
        except OffboxError as e:
            say(f"old base box {old['box_id']} not deleted: {e}")
    n = con.execute("SELECT COUNT(*) FROM bases").fetchone()[0]
    if n > BASES_SOFT_LIMIT:
        say(f"note: {n} saved bases (soft limit {BASES_SOFT_LIMIT}). They are free, but prune with `offbox base rm`.")
    return {"base": full, "box": bid, "from": src, "default": bool(is_def), "seconds": round(now() - t, 1)}


def _wait_snapshot_after(box_id: str, t0: float, timeout: float = 180) -> None:
    deadline = now() + timeout
    while now() < deadline:
        s = api.get(box_id) or {}
        att = iso_ts(s.get("lastSnapshotAttemptAt")) or 0
        done = iso_ts(s.get("snapshotCompletedAt")) or 0
        if att > t0 + 1 and done >= att and s.get("lastSnapshotStatus") == "completed":
            return
        time.sleep(3)
    raise OffboxError(f"no fresh snapshot of {box_id} within {int(timeout)}s; try again when the run finishes")


def list_bases(as_json: bool) -> None:
    con = db()
    rows = [dict(r) for r in con.execute("SELECT * FROM bases ORDER BY repo_key, is_default DESC, created_at DESC")]
    if as_json:
        print(json.dumps(rows, indent=1))
        return
    if not rows:
        print("no saved bases (offbox save --default after an expensive setup)")
    for r in rows:
        sz = f"{(r['size_bytes'] or 0) / 1e9:.1f}GB" if r["size_bytes"] else "?"
        print(f"{r['name']:<40} {'*default' if r['is_default'] else '':<9} {r['box_id']:<12} {r['size'] or '':<8} "
              f"{sz:<7} {ago(r['created_at']):>6} ago  {r['note'] or ''}")


def rm_base(me: dict, name: str) -> None:
    con = db()
    full = name if ":" in name else f"{me['repo_key']}:{name}"
    r = con.execute("SELECT * FROM bases WHERE name=?", (full,)).fetchone()
    if not r:
        raise OffboxError(f"no base {full}", code=2)
    busy = con.execute("SELECT COUNT(*) FROM leases WHERE state IN ('running','stopped') AND source=?",
                       (f"base:{full}",)).fetchone()[0]
    api.delete(r["box_id"])
    con.execute("DELETE FROM bases WHERE name=?", (full,))
    con.commit()
    event(con, r["box_id"], "base_rm", f"{full} (leases forked from it keep working: {busy})")
    print(f"removed base {full} ({r['box_id']})")


def keep(me: dict, days: float) -> None:
    con, row = _caller_lease(me)
    until = now() + days * 86400
    con.execute("UPDATE leases SET pinned_until=? WHERE box_id=?", (until, row["box_id"]))
    con.commit()
    event(con, row["box_id"], "keep", f"{days}d")
    print(f"pinned {row['box_id']} for {days:g} days (it still stops when idle, which is free; it won't be deleted)")


# ---------------------------------------------------------------- templates

def recipe(name: str) -> tuple[str, str]:
    p = TEMPLATES_DIR / f"{name}.sh"
    if not p.is_file():
        raise OffboxError(f"no recipe {p}", code=2)
    body = ((TEMPLATES_DIR / "common-env.sh").read_text() + "\n# ---- recipe ----\n" + p.read_text() +
            "\n# ---- keep docker images ----\n(\n" + (TEMPLATES_DIR / "docker-images.sh").read_text() + "\n)\n")
    return body, hashlib.sha256(body.encode()).hexdigest()[:12]


def template_size(name: str) -> str:
    return lease.DEFAULT_SIZE.get(name, "default")


HARNESS_REPO = "/Volumes/ExternalSSD/CrpkoArchitectureBroker/tmp/crpko-integration-harness"
HARNESS_REF = "origin/archive/main-pre-fresh-start"


def template_uploads(name: str, box_id: str) -> None:
    """Files a recipe needs from the Mac, read-only (git archive), uploaded to ~/.offbox/upload/."""
    import subprocess
    if name != "crpko-harness":
        return
    p = subprocess.run(["git", "-C", HARNESS_REPO, "archive", "--format=tar", HARNESS_REF, "docker/platform"],
                       capture_output=True, timeout=120)
    if p.returncode != 0 or not p.stdout:
        say(f"warning: could not export harness compose ({p.stderr.decode(errors='replace')[-200:]}); "
            "template will have no stack images")
        return
    ssh_sync.put_file(box_id, "/home/user/.offbox/upload/harness-platform.tar", p.stdout, mode="600")


def build_template(name: str) -> dict:
    if name not in TEMPLATES:
        raise OffboxError(f"unknown template {name}; one of {', '.join(TEMPLATES)}", code=2)
    lease.cap_check()
    script, sha = recipe(name)
    con = db()
    size = template_size(name)
    t = now()
    s = api.create(size, 3 * 3600, f"offbox template {name}", new_id(f"tpl-{name}"))
    bid = s["id"]
    event(con, bid, "template_build_start", f"{name} size={size} sha={sha}")
    try:
        try:
            api.rename(bid, f"offbox template {name}")
        except OffboxError:
            pass
        api.wait_state(bid, api.LIVE_STATES, timeout=900)
        ssh_sync.setup(bid)
        ssh_sync.wait_ssh(bid)
        ssh_sync.put_file(bid, "/home/user/.offbox/recipe.sh", script.encode(), mode="700")
        template_uploads(name, bid)
        r = api.cmd_start(bid, "bash -lc " + shlex.quote("bash ~/.offbox/recipe.sh"))
        from .runs import follow
        from .common import LOGS_DIR
        code = follow(bid, r["processId"], LOGS_DIR / f"template-{name}-{int(t)}.log", echo=True)
        if code != 0:
            raise OffboxError(f"recipe {name} failed with exit {code} (box {bid} left stopped for debugging)")
        ssh_sync.ssh(bid, "sync", timeout=120)
    except BaseException:
        try:
            api.stop(bid)
        except OffboxError:
            pass
        event(con, bid, "template_build_failed", name)
        raise
    api.stop(bid)
    api.wait_state(bid, api.STOPPED_STATES, timeout=900)
    snap = api.latest_snapshot(bid) or {}
    old = con.execute("SELECT * FROM templates WHERE name=?", (name,)).fetchone()
    con.execute("INSERT OR REPLACE INTO templates VALUES (?,?,?,?,?,?)",
                (name, bid, size, now(), sha, json.dumps({"sizeBytes": snap.get("sizeBytes"),
                                                          "build_s": round(now() - t)})))
    con.commit()
    event(con, bid, "template_build_done", f"{name} {round(now() - t)}s")
    if old and old["box_id"] != bid:
        try:
            api.delete(old["box_id"])
            event(con, old["box_id"], "template_replaced", f"{name} -> {bid}")
        except OffboxError as e:
            say(f"old template box {old['box_id']} not deleted: {e}")
    return {"template": name, "box": bid, "size": size, "seconds": round(now() - t), "sha": sha}


def list_templates(as_json: bool) -> None:
    con = db()
    rows = [dict(r) for r in con.execute("SELECT * FROM templates ORDER BY name")]
    built = {r["name"] for r in rows}
    if as_json:
        print(json.dumps({"built": rows, "missing": [n for n in TEMPLATES if n not in built]}, indent=1))
        return
    for n in TEMPLATES:
        r = next((x for x in rows if x["name"] == n), None)
        if r:
            print(f"{n:<15} {r['box_id']:<12} {r['size']:<8} built {ago(r['built_at'])} ago  recipe {r['recipe_sha']}")
        else:
            print(f"{n:<15} (not built: offbox template build {n})")
