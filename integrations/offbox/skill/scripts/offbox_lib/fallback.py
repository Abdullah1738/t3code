"""Local fallback (infra failure / spend cap): run under a 2-slot global semaphore with taskpolicy -b."""

from __future__ import annotations

import fcntl
import os
import shlex
import subprocess
import time
import uuid

from .common import LOCAL_SEM, LOCKS_DIR, db, ensure_dirs, event, log, now, say, warn_loud
from .identity import telegram

SLOTS = 2


def allowed(argv: list[str], error, cwd: str) -> bool:
    """Heavy commands never spill onto the Mac; small commands retain the existing fallback."""
    if error.started:
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
    """Record every failure; the bridge sends the first and summarizes the rest hourly."""
    con = db()
    event(con, None, "infra_failure", msg[:500])
    telegram(f"offbox: boat infra failure; heavy runs remain remote-only. Latest: {msg[:300]}",
             f"offbox-infra-{uuid.uuid4()}", severity="attention", burst_key="infra")


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
    con = db()
    if run_id:
        con.execute("UPDATE runs SET mode='local', status=?, exit_code=?, end_at=?, error=? WHERE run_id=?",
                    ("done" if code == 0 else "failed", code, now(), reason[:500], run_id))
        con.commit()
    event(con, None, "local_run", f"exit={code} {round(now() - t)}s reason={reason[:200]}")
    return code
