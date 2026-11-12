"""Delete old checkout dirs on a pooled box so its disk stops growing run after run."""
from __future__ import annotations

import os
import re
import secrets
import shlex
import subprocess
import time
from typing import NamedTuple

from . import capacity, common, ssh_sync
from .common import event, kv_get, kv_set, log, now, say

# Checkout dirs offbox itself makes (identity.remote_dir_for). Anything else on the box is left alone.
DIR_RE = re.compile(r"^w/[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$")
EVERY_S = 6 * 3600
# A box that ran out of budget (slow FUSE home, heavy load) is tried again this soon, not after 6 h.
RETRY_S = 20 * 60
# Seconds the box spends moving dirs before it leaves the rest for the next prune, so a slow box
# delays the run by about this much (a 30 s ssh timeout used to kill the script mid-move).
BUDGET_S = 8
# The whole foreground prune (first ssh plus any follow-up probe) must return within this, the caller's budget.
CALLER_BUDGET_S = 20
# A worker often runs `npm ci` and then tests minutes or hours later: never pull a dir out from under it.
FLOOR_S = 12 * 3600
# Deletes in the background so the run doesn't wait; fstrim hands freed blocks back so boat's
# stopped-box disk size can shrink. A killed rm leaves ~/.offbox/trash for the next prune.
BACKGROUND = ("(S=; command -v setsid >/dev/null 2>&1 && S=setsid; "
              "$S nohup nice -n 19 sh -c 'rm -rf \"$HOME/.offbox/trash\"; sudo -n fstrim / >/dev/null 2>&1' "
              "</dev/null >/dev/null 2>&1 &)")


def _stale_with_times(con, box_id: str, current: str) -> list[tuple[str, int]]:
    keep_n = capacity.setting("OFFBOX_PRUNE_KEEP", 10, minimum=1, maximum=500)
    days = capacity.setting("OFFBOX_PRUNE_DAYS", 3, minimum=1, maximum=60)
    cutoff = now() - days * 86400
    rows = con.execute("""SELECT remote_dir, MAX(COALESCE(start_at, 0)) AS last,
                                 SUM(CASE WHEN status IN ('starting', 'running') THEN 1 ELSE 0 END) AS active
                          FROM runs WHERE box_id=? AND remote_dir IS NOT NULL
                          GROUP BY remote_dir ORDER BY last DESC""", (box_id,)).fetchall()
    out: list[tuple[str, int]] = []
    kept = 0
    floor = now() - FLOOR_S
    for r in rows:
        d = r["remote_dir"]
        if not DIR_RE.match(d):
            continue
        if d == current or r["active"] or r["last"] >= floor:
            kept += 1
            continue
        if r["last"] >= cutoff and kept < keep_n:
            kept += 1
            continue
        out.append((d, int(r["last"])))
    return out


def stale_dirs(con, box_id: str, current: str) -> list[str]:
    return [d for d, _ in _stale_with_times(con, box_id, current)]


def script(dirs: list[str], run_id: str) -> str:
    # Every filesystem probe (absent/symlink test, dir test, mv) runs inside one child per dir, in its own
    # process group, so a hung probe is killed as a whole at the budget. No probe starts once the budget is
    # spent: remaining dirs are reported "left" without being touched. "busy" means a group member could not
    # be confirmed gone; the script stops. A dropped ssh (HUP/PIPE) is ignored so the background delete starts.
    # The done marker (named by run_id, known to the caller) is written last, so a caller can tell the worker
    # finished even after its ssh gave up.
    # The marker lives outside the trash tree, which BACKGROUND deletes, and is written before BACKGROUND starts.
    marker = f'"$HOME/.offbox/done/{run_id}"'
    lines = ["set -m", "trap '' PIPE HUP", "busy=",
             'mkdir -p "$HOME/.offbox/started" || exit 0',
             f'echo $$ > "$HOME/.offbox/started/{run_id}" || exit 0',
             'mkdir -p "$HOME/.offbox/trash" "$HOME/.offbox/done" || exit 0',
             f't="$HOME/.offbox/trash/{run_id}"', 'mkdir -p "$t" || exit 0',
             # Probe classes: 0 moved, 5 settled (absent or not a real dir), 4 busy, anything else left.
             'one() { ( if [ ! -d "$1" ] || [ -L "$1" ]; then exit 5; fi; mv "$1" "$2"; exit $? ) & p=$!; '
             # kill -0 on the negative pgid checks every member of the group, not only the leader.
             f'while kill -0 -- -"$p" 2>/dev/null; do '
             f'if [ "$SECONDS" -ge {BUDGET_S} ]; then kill -KILL -- -"$p" 2>/dev/null; k=0; '
             'while kill -0 -- -"$p" 2>/dev/null && [ "$k" -lt 25 ]; do sleep 0.2; k=$((k+1)); done; '
             'wait "$p" 2>/dev/null; if kill -0 -- -"$p" 2>/dev/null; then return 4; fi; return 3; fi; sleep 0.2; done; '
             'wait "$p"; }']
    for i, d in enumerate(dirs):
        q = shlex.quote(d)
        # The budget gate comes first, so no probe runs after the budget. A dir reached after that is
        # "left" (unknown, retried), not probed.
        lines.append(f'if [ -n "$busy" ] || [ "$SECONDS" -ge {BUDGET_S} ]; then echo "left "{q}; '
                     f'else one "$HOME"/{q} "$t/{i}"; rc=$?; '
                     f'case "$rc" in 0) echo "pruned "{q};; 5) echo "skip "{q};; 4) echo "busy "{q}; busy=1;; '
                     f'*) echo "left "{q};; esac; fi')
    # Completion is signalled only when no group member could be confirmed gone (busy is empty): a busy script
    # writes neither the marker nor the "done" line, so the caller keeps the box held. BACKGROUND only deletes
    # the trash tree, never the marker, and starts after the completion signal.
    lines += ['if [ -z "$busy" ]; then', f'  echo ok > {marker}; echo "done {run_id}"', "fi",
              BACKGROUND, "exit 0"]
    return "\n".join(lines) + "\n"


def _quiesced(box_id: str, run_id: str, remaining_s: float) -> bool:
    """True only if the remote done marker is seen within remaining_s. Never waits past the caller's deadline."""
    if remaining_s < 1:
        return False
    polls = max(1, int(remaining_s / 0.5))
    try:
        p = ssh_sync.ssh(box_id, f'for i in $(seq 1 {polls}); do [ -f "$HOME/.offbox/done/{run_id}" ] && exit 0; '
                                 f'sleep 0.5; done; exit 1', timeout=remaining_s)
        return p.returncode == 0
    except Exception:  # noqa: BLE001 - an unknown worker state is treated as not quiesced
        return False


def worker_gone(box_id: str, run_id: str, hold_age_s: float, timeout_s: float = 10) -> bool | None:
    """Probe one worker over SSH. An unreachable box or an unreadable marker is unknown, never gone."""
    try:
        rid = shlex.quote(run_id)
        command = (f'done_file="$HOME/.offbox/done/"{rid}; started="$HOME/.offbox/started/"{rid}; '
                   'if [ -f "$done_file" ]; then :; '
                   'elif [ -f "$started" ]; then '
                   'pid=$(cat "$started") || exit 2; '
                   'case "$pid" in ""|*[!0-9]*|0) exit 2;; esac; '
                   'kill -0 "$pid" 2>/dev/null && exit 1; '
                   'elif [ -e "$started" ] || [ -e "$done_file" ]; then exit 2; '
                   f'elif {"true" if hold_age_s > 120 else "false"}; then :; else exit 1; fi; '
                   'rm -f -- "$started" "$done_file" || exit 2; exit 0')
        p = ssh_sync.ssh(box_id, command, timeout=timeout_s)
        return {0: True, 1: False}.get(p.returncode)
    except Exception:  # noqa: BLE001 - housekeeping must keep the hold on every unknown outcome
        return None


def _settled_map(raw) -> dict[str, int]:
    """Read the settled record. Accepts the current {dir: last} map and the older list of bare names
    (a bare name means "settled at any generation", the old meaning)."""
    if isinstance(raw, dict):
        return {str(d): int(v) for d, v in raw.items()}
    if isinstance(raw, list):
        return {str(d): -1 for d in raw}
    return {}


def _protected(con, box_id: str) -> bool:
    return con.execute("SELECT 1 FROM bases WHERE box_id=? UNION ALL SELECT 1 FROM templates WHERE box_id=?",
                       (box_id, box_id)).fetchone() is not None


class Result(NamedTuple):
    pruned: int = 0
    timed_out: bool = False


def run(con, box_id: str, current: str) -> Result:
    """Move old checkouts out of ~/w; report the count and this pass's SSH timeout. Never raises."""
    timed_out = False
    try:
        key = f"prune:{box_id}"
        # The throttle reads the record fresh; the settled list is read without the age limit, so a failed or
        # aged-out pass can't drop it and replay settled dirs (they are re-offered only after they go stale again).
        raw = kv_get(con, key)
        prev = kv_get(con, key, max_age=EVERY_S)
        if prev is not None and not (prev.get("left") and now() - prev.get("at", 0) >= RETRY_S):
            return Result()
        if _protected(con, box_id):
            return Result()
        # settled maps dir -> the last-used time it was settled at. It only suppresses that generation: a recreated
        # checkout that is used and goes stale again has a newer last-used time, so it is offered again.
        settled = _settled_map((raw or {}).get("settled"))
        rows = _stale_with_times(con, box_id, current)
        dirs = [d for d, last in rows if settled.get(d) != last]
        # Every path below keeps the settled map, so a failed pass never replays settled dirs on the next one.
        kv_set(con, key, {"at": now(), "stale": len(dirs), "left": len(dirs), "settled": settled})
        if not dirs:
            return Result()
        run_id = f"{common.now()}-{os.getpid()}-{secrets.token_hex(3)}"
        # The hold is taken before the remote script can start and released only when its worker is confirmed gone.
        # While held, the allocator never hands this box to anyone (pool.candidates, lease resume).
        con.execute("INSERT OR REPLACE INTO prune_holds(box_id, run_id, created_at) VALUES (?,?,?)",
                    (box_id, run_id, now()))
        con.commit()
        deadline = time.monotonic() + CALLER_BUDGET_S
        out: list[str] = []
        rc: int | None = None
        try:
            p = ssh_sync.ssh(box_id, "bash -s", input=script(dirs, run_id).encode(), timeout=BUDGET_S + 12)
            out = p.stdout.decode(errors="replace").splitlines()
            rc = p.returncode
            finished = rc == 0 and f"done {run_id}" in out  # the script prints this only after its last child is gone
        except (subprocess.TimeoutExpired, OSError) as e:
            timed_out = isinstance(e, subprocess.TimeoutExpired)
            # The remote script may still be running. Only a seen done marker releases the hold.
            log(f"prune {box_id} ssh failed ({type(e).__name__}); checking the remote worker")
            finished = _quiesced(box_id, run_id, deadline - time.monotonic())
        if finished:
            con.execute("DELETE FROM prune_holds WHERE box_id=? AND run_id=?", (box_id, run_id))
            con.commit()
        done = [ln[len("pruned "):] for ln in out if ln.startswith("pruned ") and ln[len("pruned "):] in dirs]
        skipped = [ln[len("skip "):] for ln in out if ln.startswith("skip ") and ln[len("skip "):] in dirs]
        # Settled outcomes are pruned and skipped (absent or not a real dir); everything else stays pending.
        left_n = len(dirs) - len(done) - len(skipped)
        if not finished:
            log(f"prune {box_id}: remote worker not confirmed finished; box held, {left_n} left for retry")
        elif left_n:
            log(f"prune {box_id}: {left_n} left for retry (ssh rc {rc})")
        lasts = dict(rows)
        for d in done + skipped:
            settled[d] = lasts[d]
        kv_set(con, key, {"at": now(), "stale": len(dirs), "left": left_n, "settled": settled})
        if done:
            con.executemany("DELETE FROM pool_callers WHERE box_id=? AND remote_dir=?", [(box_id, d) for d in done])
            con.commit()
            event(con, box_id, "box_prune", f"{len(done)} of {len(dirs)} stale: " + " ".join(done))
            say(f"pruned {len(done)} old checkout(s) on {box_id} (OFFBOX_PRUNE_KEEP / OFFBOX_PRUNE_DAYS)")
        return Result(len(done), timed_out)
    except Exception as e:  # noqa: BLE001 - housekeeping must never fail a run
        log(f"prune {box_id} skipped: {e}")
        return Result(0, timed_out)
