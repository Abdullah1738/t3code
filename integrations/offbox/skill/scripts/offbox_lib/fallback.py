"""Local fallback (infra failure / spend cap): run under a 2-slot global semaphore with taskpolicy -b."""

from __future__ import annotations

import datetime as dt
import fcntl
import os
import shlex
import sqlite3
import subprocess
import time

from .common import LOCAL_SEM, LOCKS_DIR, TZ, db, db_retry, ensure_dirs, event, kv_get, kv_set, log, now, say, warn_loud
from .identity import telegram

SLOTS = 2
INFRA_WINDOW_S = 3600
INFRA_ALERT_AT = 3


def allowed(argv: list[str], error, cwd: str) -> bool:
    """Heavy commands never spill onto the Mac; small commands retain the existing fallback."""
    from .common import EXIT_LOCAL
    if error.started or error.code == EXIT_LOCAL:
        return False
    try:
        from classify import classify
        cmd = argv[0] if len(argv) == 1 else shlex.join(argv)
        verdict = classify(cmd, cwd)
        # Fallback is stricter than the direct-execution gate: full installs/builds stay
        # remote even in a permanent checkout (the gate's install rules depend on cwd).
        strict = classify(cmd, '/tmp/offbox-fallback')
        if any(v.get('heavy') or v.get('error') for v in (verdict, strict)):
            return False
        # An opaque project script may hide a full suite. Only known-small direct commands
        # and classifier-approved targeted tests may use automatic local fallback.
        if any(c in cmd for c in (';', '|', '&', '`', '$', '\n', '<', '>')):
            return False
        words = shlex.split(cmd)
        if not words:
            return False
        exe = os.path.basename(words[0])
        if exe in ('echo','true','false','pwd','ls','cat','head','tail','wc','printf','date','uname','git'):
            return True
        # Go checks run on the Mac only through local-first's sandbox (localfirst.py), never through this
        # unsandboxed fallback: a check local-first refused (OS-specific code, .env reads) must stay remote.
        if exe in ('pytest','py.test','jest','vitest','mocha'):
            return True
        if exe.startswith('python') and words[1:3] == ['-m','pytest']:
            return True
        return False
    except Exception:
        return False


def note_infra_failure(msg: str) -> None:
    """Count infra failures; on the 3rd within an hour send one Telegram alert per clock hour."""
    con = db()
    hist = [t for t in (kv_get(con, "infra_failures") or []) if now() - t < INFRA_WINDOW_S]
    hist.append(now())
    kv_set(con, "infra_failures", hist)
    event(con, None, "infra_failure", msg[:500])
    if len(hist) >= INFRA_ALERT_AT:
        hour = dt.datetime.now(TZ).strftime("%Y%m%d-%H")
        key = f"offbox-infra-{hour}"
        if not kv_get(con, f"sent:{key}"):
            ok = telegram(f"offbox: {len(hist)} boat infra failures in the last hour; heavy runs remain remote-only. "
                          f"Last error: {msg[:300]}", key, severity="attention")
            if ok:
                kv_set(con, f"sent:{key}", True)


class Semaphore:
    """Counting semaphore over fcntl locks on local.sem.<n> files (auto-released if the holder dies)."""

    def __init__(self, slots: int = SLOTS):
        self.slots = slots
        self.f = None

    def acquire(self) -> int:
        ensure_dirs()
        LOCAL_SEM.touch(exist_ok=True)
        waited = False
        while True:
            for i in range(self.slots):
                f = open(f"{LOCAL_SEM}.{i}", "a+")
                try:
                    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.f = f
                    f.seek(0)
                    f.truncate()
                    f.write(f"{os.getpid()} {time.time()}\n")
                    f.flush()
                    return i
                except BlockingIOError:
                    f.close()
            if not waited:
                say(f"waiting for a local heavy-job slot ({self.slots} max, {LOCAL_SEM})")
                waited = True
            time.sleep(2)

    def release(self) -> None:
        if self.f:
            fcntl.flock(self.f, fcntl.LOCK_UN)
            self.f.close()
            self.f = None


def run_local(argv: list[str], reason: str, run_id: str | None = None) -> int:
    warn_loud(f"running LOCALLY on the Mac (throttled, taskpolicy -b): {reason}\n"
              f"command: {' '.join(shlex.quote(x) for x in argv)}")
    log(f"local fallback reason={reason} cmd={argv[:20]}")
    sem = Semaphore()
    sem.acquire()
    t = now()
    try:
        if len(argv) == 1:
            full = ["/usr/sbin/taskpolicy", "-b", "/bin/zsh", "-c", argv[0]]
        else:
            full = ["/usr/sbin/taskpolicy", "-b"] + argv
        try:
            p = subprocess.run(full)
            code = p.returncode
        except FileNotFoundError:
            say(f"command not found locally: {argv[0]}")
            code = 127
        except KeyboardInterrupt:
            code = 130
    finally:
        sem.release()
    def persist():
        con = db()
        try:
            if run_id:
                con.execute("UPDATE runs SET mode='local', status=?, exit_code=?, end_at=?, error=? WHERE run_id=?",
                            ("done" if code == 0 else "failed", code, now(), reason[:500], run_id))
            event(con, None, "local_run", f"exit={code} {round(now() - t)}s reason={reason[:200]}")
        finally:
            con.close()
    try:
        db_retry(persist)
    except sqlite3.Error as error:
        from .runs import save_run_state
        if run_id:
            save_run_state(run_id, mode='local', status='done' if code == 0 else 'failed', exit_code=code, end_at=now())
        message = (f"{run_id or 'local command'}: local exit {code}; bookkeeping failed: {error}. "
                   f"Do not rerun the command; read/repair its result with: offbox wait {run_id or ''}")
        say("warning: " + message)
        log(message)
    return code
