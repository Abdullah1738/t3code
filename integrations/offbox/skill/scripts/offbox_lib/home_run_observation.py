"""Dated remote observations distinguish a health flap from a run changing backends."""
import datetime as dt
import math
import os
import json
import re
import contextlib

import toollog

from . import common


KINDS = {"accepted", "queued", "running", "stream connected", "stream heartbeat", "output received",
         "done", "failed", "exited", "killed", "interrupted", "lost"}


def observe(run_id, kind, *, status=None, attempt=None):
    if common.backend() != "server" or not run_id or kind not in KINDS:
        return
    try:
        common.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        path = common.LOGS_DIR / f"{run_id}.home-read.json"
        previous = common.read_json(path, {})
        previous = previous if isinstance(previous, dict) else {}
        same_attempt = attempt is None or previous.get('attempt') == attempt
        remote = status or (kind if kind in ('queued', 'running', 'done', 'failed', 'exited', 'killed', 'interrupted', 'lost')
                            else previous.get('status') if same_attempt else None)
        common.atomic_write_json(path, {"at": common.now(), "kind": kind, "status": remote,
                                       "attempt": attempt if attempt is not None else previous.get('attempt')})
    except OSError:
        pass


def stamp(at):
    return dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def queued_on_home(row, read, *, path=None):
    if not row.get('box_id') or not row.get('process_id'):
        return False
    remote = read.get('status') if isinstance(read, dict) else None
    if remote:
        return remote == 'queued'
    # Older servers have no stream status. Their queue line is evidence only until the wrapper starts.
    try:
        with open(path if path is not None else common.LOGS_DIR / f"{row['run_id']}.log", 'rb') as log:
            log.seek(0, 2)
            log.seek(max(0, log.tell() - 65536))
            tail = log.read()
    except OSError:
        tail = b''
    lines = tail.splitlines()
    boundary, attempt = 0, None
    for i, line in enumerate(lines):
        if line.startswith(b'offbox-space: '):
            try:
                marker = json.loads(line[len(b'offbox-space: '):])
                if marker.get('phase') == 'attempt':
                    boundary, attempt = i + 1, marker.get('attempt')
            except (ValueError, AttributeError):
                pass
        retry = re.search(rb'it is queued again as attempt ([0-9]+)\s*$', line)
        if retry:
            boundary, attempt = i + 1, int(retry[1])
    if isinstance(read, dict) and read.get('attempt') and attempt and read['attempt'] != attempt:
        return False
    tail = b'\n'.join(lines[boundary:])
    if b'offbox-command-started:' in tail or b'"phase": "start"' in tail or b'"phase": "server_start"' in tail:
        return False
    return (isinstance(read, dict) and read.get('kind') == 'queued') or \
        b'offbox-server: waiting' in tail


def queue_down_notice(row, monitor, read, emit, *, path=None):
    if monitor.get('state') != 'home_down' or not queued_on_home(row, read, path=path):
        return False
    run_id = row['run_id']
    try:
        common.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(common.LOGS_DIR / f'{run_id}.home-queue-notice', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return True
    except OSError:
        return False
    os.close(fd)
    since = monitor.get('since')
    dated = stamp(since)[11:16] + 'Z' if type(since) in (int, float) and math.isfinite(since) and since > 0 else 'unknown'
    emit(f"home server is slow to answer (monitor: home_down since {dated}); this run was accepted on "
         f"{row['box_id']} and stays queued there; it will not move to Boat")
    toollog.emit('offbox', 'run.queue.home_down_notice', ids={'run': run_id, 'box': row['box_id']},
                 props={'backend': 'home', 'since': since})
    return True


def notice_queue_after_read(run_id, *, row=None, path=None):
    if (common.backend() != 'server' or not run_id or
            (common.LOGS_DIR / f'{run_id}.home-queue-notice').exists()):
        return
    monitor = common.home_state()
    if monitor.get('state') != 'home_down':
        return
    if row is None:
        with contextlib.closing(common.db()) as con:
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
    if row is None or row['status'] not in ('starting', 'running') or row['mode'] == 'local':
        return
    read = common.read_json(common.LOGS_DIR / f'{run_id}.home-read.json', {})
    queue_down_notice(dict(row), monitor, read, common.say, path=path)


def notice(row, *, backend=None, emit=None):
    row = dict(row)
    if (backend or common.backend()) != "server" or row.get("mode") == "local":
        return
    if row.get("status") not in ("starting", "running"):
        return
    monitor = common.home_state()
    if monitor.get("state") not in ("home_down", "home_slow"):
        return
    run_id = row["run_id"]
    read = common.read_json(common.LOGS_DIR / f"{run_id}.home-read.json", {})
    if queue_down_notice(row, monitor, read, emit or common.say):
        return
    at = read.get("at") if isinstance(read, dict) else None
    kind = read.get("kind") if isinstance(read, dict) else None
    if type(at) in (float, int) and math.isfinite(at) and at > 0 and kind in KINDS:
        evidence = f"last good run read: {kind} at {stamp(at)}"
    elif type(row.get("command_at")) in (float, int) and row.get("process_id") and math.isfinite(row["command_at"]):
        evidence = f"last good run read: command accepted at {stamp(row['command_at'])}"
    else:
        last_ok = monitor.get("last_ok")
        health = stamp(last_ok) if type(last_ok) in (float, int) and math.isfinite(last_ok) and last_ok > 0 else "not recorded"
        evidence = f"last good run read: not recorded; last good health read: {health}"
    (emit or common.say)(f"{run_id} is still on home (monitor {monitor['state']}); {evidence}. "
                         "Do not kill it because of this health-check flap; keep waiting.")
