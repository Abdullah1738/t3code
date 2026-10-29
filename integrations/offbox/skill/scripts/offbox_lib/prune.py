"""Delete old checkout dirs on a pooled box so its disk stops growing run after run."""
from __future__ import annotations

import re
import shlex

from . import capacity, ssh_sync
from .common import event, kv_get, kv_set, log, now, say

# Checkout dirs offbox itself makes (identity.remote_dir_for). Anything else on the box is left alone.
DIR_RE = re.compile(r"^w/[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$")
EVERY_S = 6 * 3600
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


def script(dirs: list[str]) -> str:
    lines = ['t="$HOME/.offbox/trash/$(date +%s)-$$"', 'mkdir -p "$t" || exit 0']
    for i, d in enumerate(dirs):
        q = shlex.quote(d)
        lines.append(f'if [ -d "$HOME"/{q} ] && [ ! -L "$HOME"/{q} ]; then '
                     f'mv "$HOME"/{q} "$t/{i}" && echo "pruned "{q}; fi')
    lines += [BACKGROUND, "exit 0"]
    return "\n".join(lines) + "\n"


def _protected(con, box_id: str) -> bool:
    return con.execute("SELECT 1 FROM bases WHERE box_id=? UNION ALL SELECT 1 FROM templates WHERE box_id=?",
                       (box_id, box_id)).fetchone() is not None


def run(con, box_id: str, current: str) -> int:
    """Move old checkouts on box_id out of ~/w. Returns how many moved. Never raises."""
    try:
        key = f"prune:{box_id}"
        if kv_get(con, key, max_age=EVERY_S) is not None or _protected(con, box_id):
            return 0
        dirs = stale_dirs(con, box_id, current)
        kv_set(con, key, {"at": now(), "stale": len(dirs)})
        if not dirs:
            return 0
        p = ssh_sync.ssh(box_id, "bash -s", input=script(dirs).encode(), timeout=30)
        out = p.stdout.decode(errors="replace").splitlines()
        done = [ln[len("pruned "):] for ln in out if ln.startswith("pruned ") and ln[len("pruned "):] in dirs]
        if done:
            con.executemany("DELETE FROM pool_callers WHERE box_id=? AND remote_dir=?", [(box_id, d) for d in done])
            con.commit()
            event(con, box_id, "box_prune", f"{len(done)} of {len(dirs)} stale: " + " ".join(done))
            say(f"pruned {len(done)} old checkout(s) on {box_id} (OFFBOX_PRUNE_KEEP / OFFBOX_PRUNE_DAYS)")
        return len(done)
    except Exception as e:  # noqa: BLE001 - housekeeping must never fail a run
        log(f"prune {box_id} skipped: {e}")
        return 0
