"""Delete old checkout dirs on a pooled box so its disk stops growing run after run."""
from __future__ import annotations

import os
import re
import secrets
import shlex
import subprocess

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
# A worker often runs `npm ci` and then tests minutes or hours later: never pull a dir out from under it.
FLOOR_S = 12 * 3600
# Deletes in the background so the run doesn't wait; fstrim hands freed blocks back so boat's
# stopped-box disk size can shrink. A killed rm leaves ~/.offbox/trash for the next prune.
BACKGROUND = ("(S=; command -v setsid >/dev/null 2>&1 && S=setsid; "
              "$S nohup nice -n 19 sh -c 'rm -rf \"$HOME/.offbox/trash\"; sudo -n fstrim / >/dev/null 2>&1' "
              "</dev/null >/dev/null 2>&1 &)")


def stale_dirs(con, box_id: str, current: str) -> list[str]:
    keep_n = capacity.setting("OFFBOX_PRUNE_KEEP", 10, minimum=1, maximum=500)
    days = capacity.setting("OFFBOX_PRUNE_DAYS", 3, minimum=1, maximum=60)
    cutoff = now() - days * 86400
    rows = con.execute("""SELECT remote_dir, MAX(COALESCE(start_at, 0)) AS last,
                                 SUM(CASE WHEN status IN ('starting', 'running') THEN 1 ELSE 0 END) AS active
                          FROM runs WHERE box_id=? AND remote_dir IS NOT NULL
                          GROUP BY remote_dir ORDER BY last DESC""", (box_id,)).fetchall()
    out: list[str] = []
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
        out.append(d)
    return out


def script(dirs: list[str], run_id: str) -> str:
    # Every filesystem probe (absent/symlink test, dir test, mv) runs inside one child per dir, in its own
    # process group, so a hung probe is killed as a whole at the budget. No probe starts once the budget is
    # spent: remaining dirs are reported "left" without being touched. "busy" means a group member could not
    # be confirmed gone; the script stops. A dropped ssh (HUP/PIPE) is ignored so the background delete starts.
    # The done marker (named by run_id, known to the caller) is written last, so a caller can tell the worker
    # finished even after its ssh gave up.
    marker = f'"$HOME/.offbox/trash/.done-{run_id}"'
    lines = ["set -m", "trap '' PIPE HUP", "busy=",
             'mkdir -p "$HOME/.offbox/trash" || exit 0',
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
    lines += [BACKGROUND, "exit 0"]
    # Written last, after BACKGROUND has started: the worker is finished once this file exists.
    lines += [f'echo ok > {marker}', "exit 0"]
    return "\n".join(lines) + "\n"


def _quiesced(box_id: str, run_id: str) -> bool:
    """True only if the remote worker's done marker is seen. Bounded: the ssh gives up after ~40 s."""
    try:
        p = ssh_sync.ssh(box_id, f'for i in $(seq 1 60); do [ -f "$HOME/.offbox/trash/.done-{run_id}" ] && exit 0; '
                                 f'sleep 0.5; done; exit 1', timeout=40)
        return p.returncode == 0
    except Exception:  # noqa: BLE001 - an unknown worker state is treated as not quiesced
        return False


def _protected(con, box_id: str) -> bool:
    return con.execute("SELECT 1 FROM bases WHERE box_id=? UNION ALL SELECT 1 FROM templates WHERE box_id=?",
                       (box_id, box_id)).fetchone() is not None


def run(con, box_id: str, current: str) -> int:
    """Move old checkouts on box_id out of ~/w. Returns how many moved. Never raises."""
    try:
        key = f"prune:{box_id}"
        prev = kv_get(con, key, max_age=EVERY_S)
        if prev is not None and not (prev.get("left") and now() - prev.get("at", 0) >= RETRY_S):
            return 0
        if _protected(con, box_id):
            return 0
        dirs = stale_dirs(con, box_id, current)
        # Counted as all left until the box answers, so a timed-out or failed ssh is retried after RETRY_S.
        kv_set(con, key, {"at": now(), "stale": len(dirs), "left": len(dirs)})
        if not dirs:
            return 0
        run_id = f"{common.now()}-{os.getpid()}-{secrets.token_hex(3)}"
        try:
            p = ssh_sync.ssh(box_id, "bash -s", input=script(dirs, run_id).encode(), timeout=BUDGET_S + 12)
            out = p.stdout.decode(errors="replace").splitlines()
            ok = p.returncode == 0
        except (subprocess.TimeoutExpired, OSError) as e:
            # The remote script may still be running (it ignores HUP and only stops at its own budget or
            # when its children are gone). Don't hand the box back until its worker is confirmed finished.
            out, ok = [], False
            log(f"prune {box_id} ssh failed ({type(e).__name__}); waiting for the remote worker to finish")
            if not _quiesced(box_id, run_id):
                kv_set(con, key, {"at": now(), "stale": len(dirs), "left": len(dirs)})
                log(f"prune {box_id}: remote worker not confirmed finished; box left pending")
                return 0
        done = [ln[len("pruned "):] for ln in out if ln.startswith("pruned ") and ln[len("pruned "):] in dirs]
        skipped = [ln[len("skip "):] for ln in out if ln.startswith("skip ") and ln[len("skip "):] in dirs]
        # Settled outcomes are pruned and skipped (absent or not a real dir); everything else stays pending.
        left_n = len(dirs) - len(done) - len(skipped)
        if not ok or any(ln.startswith("busy ") for ln in out):
            log(f"prune {box_id}: {left_n} left for retry (ssh rc {p.returncode})")
        kv_set(con, key, {"at": now(), "stale": len(dirs), "left": left_n})
        if done:
            con.executemany("DELETE FROM pool_callers WHERE box_id=? AND remote_dir=?", [(box_id, d) for d in done])
            con.commit()
            event(con, box_id, "box_prune", f"{len(done)} of {len(dirs)} stale: " + " ".join(done))
            say(f"pruned {len(done)} old checkout(s) on {box_id} (OFFBOX_PRUNE_KEEP / OFFBOX_PRUNE_DAYS)")
        return len(done)
    except Exception as e:  # noqa: BLE001 - housekeeping must never fail a run
        log(f"prune {box_id} skipped: {e}")
        return 0
