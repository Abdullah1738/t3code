"""Box evidence for a command start whose response was lost. Callers hold the box lock."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import sqlite3
import shlex
import subprocess

from . import ssh_sync
from .common import OffboxError, db, db_retry, event, local_error, now, write

SSH_TIMEOUT_S = 10
GRACE_S = 5
REFUSED_RC = 98
REFUSED_MARKER = 'offbox-claim-refused'


@dataclass(frozen=True)
class Result:
    verdict: str = 'unknown'
    code: int | None = None
    pid: int | None = None


def hint(box: str, run: str, pid: int | None = None) -> str:
    receipt = f'offbox ssh {box} -- \'cat "$HOME/.offbox/exit/{run}.rc"\''
    return receipt + (f'; logs: offbox ssh {box} -- \'cat "$HOME/.ascii/processes/{pid}.log"\'' if pid else '')


def claims_enabled(con, run: str) -> bool:
    return con.execute('SELECT 1 FROM kv WHERE k=?', (f'start_claim:{run}',)).fetchone() is not None


def claim_id(con, run: str) -> str:
    row = con.execute('SELECT v FROM kv WHERE k=?', ('start_claim:' + run,)).fetchone()
    return row[0] if row and row[0].startswith('claim-') else run


def recovery_marked(con, row) -> bool:
    return con.execute('SELECT 1 FROM kv WHERE k IN (?,?)',
                       (f"start_unattached:{row['run_id']}", f"start_unknown:{row['run_id']}")).fetchone() is not None


def api_pid(con, row) -> int | None:
    """Old recovery rows stored an OS PID here. Only a recorded API command identity makes those IDs trusted."""
    if not row['command_id'] and recovery_marked(con, row):
        return None
    return row['process_id']


def remember_wrapper(con, row, pid: int | None) -> None:
    # Preserve a known API ID, but quarantine legacy recovery IDs even when today's SSH probe has no PID.
    trusted = api_pid(con, row)
    legacy = row['process_id'] if trusted is None else None
    con.execute('UPDATE runs SET process_id=?, wrapper_pid=COALESCE(?,wrapper_pid,?) WHERE run_id=?',
                (trusted, pid, legacy, row['run_id']))


def script(run: str, claim: bool, claim_key: str | None = None) -> str:
    # Keep IDs out of the literal pgrep pattern: this checking shell must not match itself.
    return '\n'.join([
        f'r={shlex.quote(run)}',
        f'k={shlex.quote(claim_key or run)}',
        'd="$HOME/.offbox/claim/$k"; c=legacy',
        ('mkdir -p "$HOME/.offbox/claim" 2>/dev/null; '
         'if mkdir "$d" 2>/dev/null; then c=won; : > "$d/by-fence"; '
         'elif [ -f "$d/by-fence" ]; then c=won; '
         'elif [ -d "$d" ]; then c=taken; else c=error; fi') if claim else ':',
        '[ "$c" = won ] && rm -f "$HOME/.offbox/env/$k.env"',
        'rc=-; [ -f "$HOME/.offbox/exit/$r.rc" ] && rc=$(cat "$HOME/.offbox/exit/$r.rc" 2>/dev/null)',
        'p=x; if command -v pgrep >/dev/null 2>&1; then '
        'pgrep -f "offbox/(claim/$k|exit/$r[.]rc)" >/dev/null 2>&1; s=$?; '
        'case "$s" in 0) p=1;; 1) p=0;; esac; fi',
        # Completion may race the first read and the process probe.
        '[ -f "$HOME/.offbox/exit/$r.rc" ] && rc=$(cat "$HOME/.offbox/exit/$r.rc" 2>/dev/null)',
        'pid=-; [ -f "$d/pid" ] && pid=$(cat "$d/pid" 2>/dev/null)',
        'printf "offbox-start claim=%s rc=%s proc=%s pid=%s\\n" "$c" "$rc" "$p" "$pid"',
    ])


def check(box: str, run: str, *, claim: bool = True, timeout: float = SSH_TIMEOUT_S) -> Result:
    try:
        con = db()
        try:
            key = claim_id(con, run)
        finally:
            con.close()
        p = ssh_sync.ssh(box, script(run, claim, key), timeout=timeout)
    except (OSError, subprocess.TimeoutExpired, OffboxError):
        return Result()
    m = re.search(r'^offbox-start claim=(won|taken|legacy|error) rc=(-|\d+) proc=([01x]) pid=(-|\d+)$',
                  p.stdout.decode(errors='replace'), re.M) if p.returncode == 0 else None
    if not m:
        return Result()
    c, rc, proc, pid = m.groups()
    code = int(rc) if rc != '-' and 0 <= int(rc) <= 255 else None
    wrapper_pid = int(pid) if pid != '-' and int(pid) > 1 else None
    if code is not None:
        return Result('started', code, wrapper_pid)
    if proc == 'x' or c in ('error', 'legacy'):
        return Result(pid=wrapper_pid)
    if c == 'won' and proc == '0':
        return Result('fenced')
    return Result('started', pid=wrapper_pid)


def settle(con, row, result: Result, reason: str, *, until: float | None = None, foreign: bool = False) -> None:
    """End the row, retaining a separate reservation whenever execution is still possible."""
    rid, box = row['run_id'], row['box_id']
    code = result.code
    if result.code is not None:
        from .runs import do_pulls
        pulls = json.loads(row['pulls'] or '[]')
        if pulls:
            do_pulls(box, dict(row), pulls, until=until, foreign=foreign)
        from .runs import settled_steps_code
        code = settled_steps_code(row, code, locked=True, until=until)
    from .runs import claim_terminal_log, emit_terminal, save_run_state, state_warning, terminal_result
    log_row = None
    def persist():
        nonlocal log_row
        with write(con):
            current = con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
            if terminal_result(current):
                log_row = claim_terminal_log(con, current)
                con.execute('DELETE FROM kv WHERE k=?', (f'start_unknown:{rid}',))
                return current['status'], current['exit_code'], current['error']
            remember_wrapper(con, current, result.pid)
            if result.code is not None:
                status, error = (('infra', 'steps incomplete') if code is None else
                                 (('done' if code == 0 else 'failed'), None))
            elif result.verdict == 'fenced':
                from .runs import BACKGROUND_RUN_ENV
                from . import home
                pending = (row['mode'] == 'bg' and os.environ.get(BACKGROUND_RUN_ENV) == rid) or (
                    row['mode'] == 'fg' and os.environ.get(home.RETURNED_HOME_ENV)
                    and home.PRE_START.get() == rid and row['client_pid'] == os.getpid())
                status, error = ('starting' if pending else 'lost'), f'{reason}; never started, nothing ran'
                con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'lost_confirmed:{rid}', 'fenced'))
            else:
                status = 'infra'
                error = f'{rid} on {box}: start unknown: {reason}; ssh check failed or command may still be running; {hint(box, rid)}'
                con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'start_unknown:{rid}', box))
            con.execute("UPDATE runs SET status=?, exit_code=?, end_at=?, error=? "
                        "WHERE run_id=? AND (status IN ('starting','running') OR "
                        "(status='infra' AND EXISTS (SELECT 1 FROM kv WHERE k='start_unknown:' || runs.run_id)))",
                        (status, code, None if status == 'starting' else now(), error, rid))
            if result.code is not None or result.verdict == 'fenced':
                con.execute('DELETE FROM kv WHERE k=?', (f'start_unknown:{rid}',))
            log_row = claim_terminal_log(con, con.execute("SELECT * FROM runs WHERE run_id=?", (rid,)).fetchone())
            return status, code, error
    try:
        status, code, error = db_retry(persist)
    except sqlite3.Error as error:
        if result.code is None:
            raise local_error(error, run_id=rid, started=result.verdict != 'fenced') from error
        save_run_state(rid, wrapper_pid=result.pid, status='infra' if code is None else ('done' if code == 0 else 'failed'),
                       known_exit_code=result.code, exit_code=code, end_at=now())
        state_warning(rid, code, error)
        return
    if log_row is not None:
        emit_terminal(log_row)
    try:
        if code is not None and row['mode'] == 'bg':
            from .misc import _catch_up_finished
            _catch_up_finished(con, rid, budget=10 if until is None else max(0, until-now()))
        from .box_disk import hand_back
        hand_back(con, con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone(), until=until)
        event(con, box, 'start_settled', f'{rid} {status} exit={code}: {error or reason}')
    except sqlite3.Error as error:
        state_warning(rid, code, error)
