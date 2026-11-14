"""Container inventory belongs to a run, including runs whose wrapper was killed."""
from __future__ import annotations

import json
import re
import shlex
import sqlite3
import subprocess

from . import ssh_sync
from .common import OffboxError, log, now, say, write


def preserve_reason(con, row) -> str:
    if (row.get('pinned_until') or 0) > now():
        return 'offbox keep pin'
    # Base notes are free text, not a safe machine-readable deletion policy. Preserve every base.
    if (row.get('source') or '').startswith('base:'):
        return 'saved base'
    if not con.execute('SELECT 1 FROM pool_members WHERE box_id=?', (row['box_id'],)).fetchone():
        return 'private lease'
    return ''


REMOTE = r'''
import datetime, json, pathlib, re, shutil
receipt = pathlib.Path.home() / '.offbox/exit' / (run_id + '.containers.json')
def write(data):
    receipt.parent.mkdir(parents=True, exist_ok=True)
    tmp = receipt.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.replace(receipt)
def inventory():
    rc, out = bounded(['timeout', '-k', '1s', '3s', 'docker', 'ps', '-aq', '--no-trunc'], 4, capture=True)
    if rc:
        raise RuntimeError('container listing failed or timed out')
    ids = out.decode().split()
    if not ids:
        return []
    if not all(re.fullmatch('[a-f0-9]{64}', cid) for cid in ids):
        raise RuntimeError('unrecognized container IDs')
    fmt = '{{.Id}}\t{{.Name}}\t{{.State.Running}}\t{{.State.Pid}}\t{{.Created}}'
    rc, out = bounded(['timeout', '-k', '1s', '3s', 'docker', 'inspect', '--format', fmt, *ids], 4, capture=True)
    if rc:
        raise RuntimeError('container inspection failed or timed out')
    result = []
    for line in out.decode().splitlines():
        cid, name, running, pid, created = line.split('\t')
        if cid not in ids:
            raise RuntimeError('container inventory changed')
        threads = 0
        if pid.isdigit() and int(pid) > 0:
            try:
                status = pathlib.Path('/proc', pid, 'status').read_text()
                threads = int(re.search(r'^Threads:\s+(\d+)', status, re.M)[1])
            except (OSError, TypeError):
                pass
        result.append(dict(id=cid, name=name.lstrip('/'), running=running == 'true', threads=threads, created=created))
    return result
try:
    if phase == 'pre':
        data = dict(initial=[], initial_known=False, preserve=preserve, started=time.time())
        write(data)
        if not shutil.which('docker'):
            sys.exit(0)
        active, _ = bounded(['timeout', '2s', 'systemctl', 'is-active', '--quiet', 'docker'], 3)
        if active:
            if active not in (3, 4):
                print('offbox: Docker state check failed or timed out; continuing without removal', file=sys.stderr)
            sys.exit(0)
        initial = inventory()
        data.update(initial=initial, initial_known=True)
        # Persist before removing anything: a killed wrapper still has an ownership boundary.
        write(data)
        if initial:
            names = ', '.join(c['name'] for c in initial)
            print(f"offbox: {len(initial)} container(s) left from earlier runs: {names} (~{sum(c['threads'] for c in initial)} threads)", file=sys.stderr)
            if preserve:
                print(f'offbox: keeping earlier containers ({preserve}); report only', file=sys.stderr)
            else:
                rc, _ = bounded(['timeout', '-k', '1s', '10s', 'docker', 'rm', '-f', *[c['id'] for c in initial]], 12)
                data['remove_rc'] = rc
                write(data)
                if rc:
                    print('offbox: earlier container removal failed or timed out; continuing', file=sys.stderr)
    else:
        if not shutil.which('docker') or bounded(['timeout', '2s', 'systemctl', 'is-active', '--quiet', 'docker'], 3)[0]:
            sys.exit(0)
        data = json.loads(receipt.read_text())
        initial = {c['id'] for c in data['initial']}
        end = datetime.datetime.fromisoformat(end_iso.replace('Z', '+00:00')).timestamp()
        data['left'] = [c['name'] for c in inventory() if c['running'] and c['id'] not in initial
                        and datetime.datetime.fromisoformat(c['created'].replace('Z', '+00:00')).timestamp() <= end
                        and (data['initial_known'] or datetime.datetime.fromisoformat(
                            c['created'].replace('Z', '+00:00')).timestamp() >= data['started'])]
        data['post_checked'] = True
        write(data)
except FileNotFoundError:
    pass
except Exception as exc:
    print(f'offbox: container {phase} check unavailable ({exc}); continuing', file=sys.stderr)
'''


def script(run_id: str, bounded_process: str, *, phase: str = 'pre', preserve: str = '',
           end_iso: str = '9999-12-31T23:59:59+00:00') -> str:
    if not re.fullmatch(r'[A-Za-z0-9_-]+', run_id):
        raise ValueError('invalid run ID')
    body = bounded_process + f'\nrun_id={run_id!r}\nphase={phase!r}\npreserve={preserve!r}\nend_iso={end_iso!r}\n' + REMOTE
    # Bound the entire helper too: a lazy home filesystem can stall the receipt write.
    supervisor = bounded_process + f"\nrc, _ = bounded(['python3', '-c', {body!r}], 24, relay=True)\n"
    supervisor += "if rc: print('offbox: container check failed or timed out; continuing', file=sys.stderr)\n"
    return "python3 - <<'OFFBOX_CONTAINERS'\n" + supervisor + '\nOFFBOX_CONTAINERS\n:'


def record(con, run, bounded_process: str, timeout: float = 30) -> None:
    """Read the receipt, or finish the inventory for a killed wrapper. No removals here."""
    if not run['box_id'] or timeout <= 0:
        return
    key = 'containers_recorded:' + run['run_id']
    if not con.execute('SELECT 1 FROM kv WHERE k=?', ('containers_expected:' + run['run_id'],)).fetchone():
        return
    if con.execute('SELECT 1 FROM kv WHERE k=?', (key,)).fetchone():
        return
    import datetime
    ended = con.execute('SELECT end_at FROM runs WHERE run_id=?', (run['run_id'],)).fetchone()
    end_iso = datetime.datetime.fromtimestamp((ended and ended[0]) or now(), datetime.timezone.utc).isoformat()
    command = script(run['run_id'], bounded_process, phase='post', end_iso=end_iso)
    command += '\ncat "$HOME/.offbox/exit/"' + shlex.quote(run['run_id'] + '.containers.json')
    try:
        p = ssh_sync.ssh(run['box_id'], command, timeout=timeout)
        if p.returncode:
            return
        data = json.loads(p.stdout)
        recorded = []
        with write(con):
            if con.execute('SELECT 1 FROM kv WHERE k=?', (key,)).fetchone():
                return
            initial_key = 'containers_initial_recorded:' + run['run_id']
            if data['initial'] and not con.execute('SELECT 1 FROM kv WHERE k=?', (initial_key,)).fetchone():
                recorded.append(('stale_containers', json.dumps(dict(run=run['run_id'], **data))))
                con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (initial_key, '1'))
            if data.get('left'):
                recorded.append(('stale_containers_left', json.dumps(dict(run=run['run_id'], names=data['left']))))
            if data.get('post_checked'):
                con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (key, '1'))
            for kind, detail in recorded:
                con.execute('INSERT INTO events VALUES (?,?,?,?)', (now(), run['box_id'], kind, detail[:2000]))
        for kind, detail in recorded:
            log(f"{kind} {run['box_id']} {detail[:300]}")
        if data.get('left'):
            say('containers left after ' + run['run_id'] + ': ' + ', '.join(data['left']))
    except (OSError, subprocess.TimeoutExpired, OffboxError, ValueError, KeyError, sqlite3.Error):
        pass
