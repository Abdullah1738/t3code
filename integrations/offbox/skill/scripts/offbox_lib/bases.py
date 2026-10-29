"""Saved state: bases (stopped forks of a lease) and templates (stopped golden boxes).

boat deletes a stopped box's data 14 days after its last stop, so each base/template box is also kept as a boat
saved snapshot (kept until deleted; the plan includes a number of them, more cost money, so offbox only uses
free slots). Without one, the reaper resumes and stops the box before day 14."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from . import api, capacity, lease, ssh_sync
from .common import (BASES_SOFT_LIMIT, DATA_KEEP_S, RUN_TTL_S, TEMPLATES, TEMPLATES_DIR, OffboxError, ago,
                     db, event, file_lock, iso, iso_ts, kv_get, kv_set, new_id, now, say)

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
    keep_saved(con, "bases", full, bid, (old and old["saved"]) or saved_name("base", full))
    if old and old["box_id"] != bid:
        try:
            api.delete(old["box_id"])
            event(con, old["box_id"], "base_replaced", f"{full} -> {bid}")
        except OffboxError as e:
            say(f"old base box {old['box_id']} not deleted: {e}")
    n = con.execute("SELECT COUNT(*) FROM bases").fetchone()[0]
    if n > BASES_SOFT_LIMIT:
        say(f"note: {n} saved bases (soft limit {BASES_SOFT_LIMIT}). Each uses one of the plan's saved-snapshot "
            f"slots; prune with `offbox base rm`.")
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


# ---------------------------------------------------------------- keeping them past boat's 14 days

def saved_name(kind: str, name: str) -> str:
    """boat saved-snapshot name: 1-63 of [a-z0-9-], starting with a letter or digit."""
    if kind == "template":
        return f"offbox-template-{name}"
    slug = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")[:44].strip("-")
    return f"offbox-base-{slug}-{hashlib.sha256(name.encode()).hexdigest()[:6]}"


def _slots_left(allowance: dict) -> int:
    included = allowance.get("included") or allowance.get("free") or 0
    return int(included) - int(allowance.get("used") or 0)


def keep_saved(con, table: str, name: str, box_id: str, sname: str, snaps: list[dict] | None = None,
               allowance: dict | None = None, timeout: float = 300) -> bool:
    """Save box_id as boat saved snapshot sname and record it. Only replaces a snapshot of that name or uses a
    free included slot: never one that costs money. Never raises."""
    try:
        if snaps is None:
            snaps, allowance = api.saved_list()
        if not any(s.get("name") == sname for s in snaps) and _slots_left(allowance or {}) <= 0:
            say(f"note: no free saved-snapshot slot for {table[:-1]} {name}; the reaper keeps its box alive instead")
            event(con, box_id, "saved_no_slot", f"{name} {sname}")
            return False
        api.save(box_id, sname)
        deadline = now() + timeout
        while True:
            snap = api.saved_get(sname) or {}
            if snap.get("status") == "ready" and snap.get("sourceSandboxId") in (None, box_id):
                break
            if snap.get("status") == "failed" or now() > deadline:
                raise OffboxError(f"saved snapshot {sname}: {snap.get('status')} {snap.get('error') or ''}")
            time.sleep(2)
    except OffboxError as e:
        say(f"warning: could not keep {table[:-1]} {name} as saved snapshot {sname}: {e}")
        event(con, box_id, "saved_failed", f"{name} {sname}: {e}")
        return False
    con.execute(f"UPDATE {table} SET saved=?, expired_at=NULL WHERE name=? AND box_id=?", (sname, name, box_id))
    con.commit()
    event(con, box_id, "saved", f"{name} -> {sname}")
    return True


def _add_status(rows: list[dict]) -> None:
    """Set status/data_until on each row. Asks boat only about box-only rows, and stops asking after one failure
    (`offbox bases --json` is read by scripts with a timeout)."""
    failed = None
    for r in rows:
        box = None
        if not r["saved"] and not r["expired_at"]:
            if failed is None:
                try:
                    box = api.get(r["box_id"])
                except OffboxError as e:
                    failed = str(e)
            if failed is not None:
                box = failed
        r["status"], r["data_until"] = keep_status(r, box)


def keep_status(row, box) -> tuple[str, float | None]:
    """-> (saved | box | expired | gone | unknown, epoch boat deletes/deleted the data or None)."""
    if row["saved"]:
        return "saved", None
    if isinstance(box, str):
        return "unknown", None
    if row["expired_at"] or (box and box.get("dataExpiredAt")):
        return "expired", row["expired_at"] or iso_ts(box.get("dataExpiredAt"))
    if box is None:
        return "gone", None
    if box.get("state") in api.STOPPED_STATES and box.get("stoppedAt"):
        return "box", iso_ts(box["stoppedAt"]) + DATA_KEEP_S
    return "box", None


def _status_text(st: str, until: float | None, fix: str) -> str:
    return {"saved": "kept (saved snapshot)",
            "box": f"box only, boat deletes it {iso(until)} unless used" if until else "box only (running)",
            "expired": f"EXPIRED: boat deleted its data {iso(until)}; {fix}",
            "gone": f"GONE: box deleted; {fix}",
            "unknown": "status unknown (boat API failed)"}[st]


def list_bases(as_json: bool) -> None:
    con = db()
    rows = [dict(r) for r in con.execute("SELECT * FROM bases ORDER BY repo_key, is_default DESC, created_at DESC")]
    _add_status(rows)
    if as_json:
        print(json.dumps(rows, indent=1))
        return
    if not rows:
        print("no saved bases (offbox save --default after an expensive setup)")
    for r in rows:
        sz = f"{(r['size_bytes'] or 0) / 1e9:.1f}GB" if r["size_bytes"] else "?"
        fix = f"`offbox base rm {r['name']}` and save again"
        print(f"{r['name']:<40} {'*default' if r['is_default'] else '':<9} {r['box_id']:<12} {r['size'] or '':<8} "
              f"{sz:<7} {ago(r['created_at']):>6} ago  {_status_text(r['status'], r['data_until'], fix)}"
              f"{'  ' + r['note'] if r['note'] else ''}")


def rm_base(me: dict, name: str) -> None:
    con = db()
    full = name if ":" in name else f"{me['repo_key']}:{name}"
    r = con.execute("SELECT * FROM bases WHERE name=?", (full,)).fetchone()
    if not r:
        raise OffboxError(f"no base {full}", code=2)
    busy = con.execute("SELECT COUNT(*) FROM leases WHERE state IN ('running','stopped') AND source=?",
                       (f"base:{full}",)).fetchone()[0]
    api.delete(r["box_id"])
    if r["saved"]:
        try:
            api.delete_saved(r["saved"])
        except OffboxError as e:
            say(f"warning: saved snapshot {r['saved']} not deleted ({e}); `boat snapshot rm {r['saved']}`")
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
    con.execute("INSERT OR REPLACE INTO templates (name, box_id, size, built_at, recipe_sha, note) VALUES (?,?,?,?,?,?)",
                (name, bid, size, now(), sha, json.dumps({"sizeBytes": snap.get("sizeBytes"),
                                                          "build_s": round(now() - t)})))
    con.commit()
    event(con, bid, "template_build_done", f"{name} {round(now() - t)}s")
    keep_saved(con, "templates", name, bid, (old and old["saved"]) or saved_name("template", name))
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
    _add_status(rows)
    built = {r["name"] for r in rows}
    if as_json:
        print(json.dumps({"built": rows, "missing": [n for n in TEMPLATES if n not in built],
                          "expired": [r["name"] for r in rows if r["status"] in ("expired", "gone")]}, indent=1))
        return
    for n in TEMPLATES:
        r = next((x for x in rows if x["name"] == n), None)
        if r:
            fix = f"runs build from the recipe until `offbox template build {n}` (the reaper starts one)"
            print(f"{n:<15} {r['box_id']:<12} {r['size']:<8} built {ago(r['built_at'])} ago  recipe {r['recipe_sha']}  "
                  f"{_status_text(r['status'], r['data_until'], fix)}")
        else:
            print(f"{n:<15} (not built: offbox template build {n})")


# ---------------------------------------------------------------- reaper upkeep

def _spawn_rebuild(con, name: str) -> bool:
    """Start `offbox template build <name>` in the background unless one started in the last 6 h."""
    recent = con.execute("SELECT COUNT(*) FROM events WHERE kind IN ('template_build_start','template_rebuild') "
                         "AND (detail=? OR detail LIKE ?) AND ts>?", (name, f"{name} %", now() - 6 * 3600)).fetchone()[0]
    if recent:
        return False
    from . import common
    log = open(common.LOGS_DIR / f"template-rebuild-{name}.log", "ab")
    try:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / "offbox.py"), "template", "build",
                          name], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        log.close()
    event(con, None, "template_rebuild", name)
    return True


def _reread(con, rows):
    out = [(t, con.execute(f"SELECT * FROM {t} WHERE name=?", (r["name"],)).fetchone()) for t, r in rows]
    return [(t, r) for t, r in out if r is not None]


def upkeep(con, live: dict, dry: bool, actions: list[str], act) -> None:
    """Keep templates and bases past boat's 14-day data limit: adopt/save saved snapshots (hourly), mark the ones
    boat already deleted, rebuild expired templates, and resume+stop unsaved boxes before day 14."""
    from .common import KEEPALIVE_S
    # The monitor gives a reap pass 120 s: a few slow steps per pass, the next pass (5 min) does the rest.
    saves, refreshes = 2, 2
    rows = [("templates", r) for r in con.execute("SELECT * FROM templates")]
    rows += [("bases", r) for r in con.execute("SELECT * FROM bases")]
    if not rows:
        return
    if not dry and kv_get(con, "saved_upkeep", max_age=3600) is None:
        try:
            snaps, allowance = api.saved_list()
        except OffboxError as e:
            snaps, allowance = None, {}
            actions.append(f"saved snapshot list failed: {e}")
        if snaps is not None:
            kv_set(con, "saved_upkeep", now())
            names = {s.get("name") for s in snaps}
            ready = {s.get("sourceSandboxId"): s.get("name") for s in snaps if s.get("status") == "ready"}
            for table, r in rows:
                if r["saved"] and r["saved"] not in names:
                    con.execute(f"UPDATE {table} SET saved=NULL WHERE name=?", (r["name"],))
                    con.commit()
                    event(con, r["box_id"], "saved_gone", f"{r['name']} {r['saved']}")
                elif not r["saved"] and r["box_id"] in ready:
                    con.execute(f"UPDATE {table} SET saved=?, expired_at=NULL WHERE name=?",
                                (ready[r["box_id"]], r["name"]))
                    con.commit()
                    event(con, r["box_id"], "saved_adopt", f"{r['name']} {ready[r['box_id']]}")
            rows = _reread(con, rows)
            for table, r in rows:
                b = live.get(r["box_id"])
                if r["saved"] or r["expired_at"] or not b or b.get("dataExpiredAt"):
                    continue
                if b.get("state") not in api.STOPPED_STATES or saves <= 0:
                    continue
                saves -= 1
                kind = table[:-1]
                if keep_saved(con, table, r["name"], r["box_id"], saved_name(kind, r["name"]), snaps, allowance,
                              timeout=30):
                    actions.append(f"saved {kind} {r['name']} as {saved_name(kind, r['name'])}")
                    snaps = snaps + [{"name": saved_name(kind, r["name"])}]
                    allowance = dict(allowance, used=int(allowance.get("used") or 0) + 1)
            rows = _reread(con, rows)
    for table, r in rows:
        if r["saved"]:
            continue
        kind, bid = table[:-1], r["box_id"]
        b = live.get(bid)
        if not r["expired_at"] and (b is None or b.get("dataExpiredAt")):
            actions.append(f"{'would mark' if dry else 'mark'} {kind} {r['name']} expired ({bid})")
            if not dry:
                con.execute(f"UPDATE {table} SET expired_at=? WHERE name=?", (now(), r["name"]))
                con.commit()
                event(con, bid, f"{kind}_expired", f"{r['name']}: boat deleted its data")
            r = {**dict(r), "expired_at": now()}
        if r["expired_at"]:
            if kind == "template" and r["name"] in TEMPLATES:
                if dry:
                    actions.append(f"would rebuild expired template {r['name']}")
                elif _spawn_rebuild(con, r["name"]):
                    actions.append(f"rebuild expired template {r['name']}")
            continue
        stopped = iso_ts(b.get("stoppedAt")) if b else None
        if b and b.get("state") in api.STOPPED_STATES and stopped and now() - stopped > KEEPALIVE_S and refreshes > 0:
            refreshes -= 1
            act(bid, "refresh", f"{kind} {r['name']} stopped {round((now() - stopped) / 86400, 1)}d, no saved snapshot",
                lambda bid=bid: lease.refresh_box(con, bid))
