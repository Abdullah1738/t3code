"""Disk-full recovery before dispatch, and bounded pool hand-back housekeeping."""
import inspect
import contextlib
import json
import re
import subprocess

import offbox_disk_space as disk
from . import api, common, lease, prune, ssh_sync
from .common import OffboxError, event, kv_get, kv_set, now

NOTE = 'disk-full:'
# Workspace pressure uses #129's low-space warning floor; /tmp uses its hard gate.
THRESHOLDS = {'home': disk.WARN_BYTES, 'workspace': disk.WARN_BYTES, 'tmp': disk.GATE_BYTES}


def low(space):
    return next((k for k, limit in THRESHOLDS.items()
                 if type(space.get(k, {}).get('free_bytes')) is int and space[k]['free_bytes'] < limit), None)


def measure(box, workspace=None, timeout=5):
    # No findmnt subprocesses: one connection and three statvfs calls fit the picker budget.
    source = '''import json,os
from pathlib import Path
out={}
home=Path.home(); workspace=WORKSPACE or str(home/'w' if (home/'w').is_dir() else home)
for key,path in [('home',str(home)),('workspace',workspace),('tmp','/tmp')]:
 try:
  s=os.statvfs(path); out[key]=dict(path=path,free_bytes=s.f_bavail*s.f_frsize,size_bytes=s.f_blocks*s.f_frsize)
 except OSError: pass
print(json.dumps(out))
'''.replace('WORKSPACE', repr(workspace))
    try:
        with api.budget(timeout):
            p = ssh_sync.ssh(box, 'timeout 4 python3 -', input=source.encode(), timeout=timeout)
        value = json.loads(p.stdout) if p.returncode == 0 else {}
        return value if disk.valid_space(value) else {}
    except common.SshHostKeyMismatch:
        raise
    except (OffboxError, OSError, ValueError, subprocess.SubprocessError):
        return {}


def live_claims(home, proc):
    live = []
    for claim in (home/'.offbox/claim').glob('*'):
        try:
            pid = int((claim/'pid').read_text())
            if pid <= 1:
                raise ValueError('invalid claim PID')
            argv = (proc/str(pid)/'cmdline').read_bytes().split(b'\0')
            # Claim directories outlive wrappers. A reused PID must not fence yesterday's files.
            marker = ' > "$HOME/.offbox/claim/' + claim.name + '/pid" || exit 97;'
            if (len(argv) < 3 or argv[0].rsplit(b'/',1)[-1] != b'bash' or argv[1] not in (b'-c',b'-lc')
                    or b'OFFBOX_PID_RECORD' not in argv[2] or b'__offbox_signal()' not in argv[2]
                    or marker.encode() not in argv[2]):
                continue
            live.append(dict(started_at=float((claim/'epoch').read_text())))
        except FileNotFoundError:
            continue
    return live


# Freeze the guest code before a queued client can span an install, just like probe_payload.
_REAPER = ('import errno,json,os,pwd,re,stat,time\nfrom pathlib import Path\n' +
           '\n'.join(inspect.getsource(f) for f in (disk.held_paths, disk.inventory, disk.remove_checked,
                                                   disk.reap, live_claims)))


def reclaim(con, box, *, finished_at=None, until=None):
    left = lambda cap: cap if until is None else max(0, min(cap, until - now()))
    if left(1) <= 0:
        return {}
    before = measure(box, timeout=left(5))
    # Guest claim markers cover other clients too. A live wrapper's epoch keeps the age fence in place.
    source = _REAPER + '''
home=Path('/home/user')
try: live=live_claims(home,Path('/proc'))
except (OSError,ValueError): raise SystemExit(1)
reap('/tmp',pwd.getpwnam('user').pw_uid,live,finished_before=FINISHED,emit=lambda item:None)
'''.replace('FINISHED', repr(finished_at))
    try:
        if left(1) <= 0:
            return {}
        with api.budget(left(30)):
            p = ssh_sync.ssh(box, 'sudo -n timeout 28 python3 -', input=source.encode(), timeout=left(30))
        after = measure(box, timeout=left(5)) if left(1) > 0 else {}
        event(con, box, 'box_tmp_reclaimed', json.dumps(dict(before=before, after=after, exit=p.returncode)))
        return after
    except (OffboxError, OSError, subprocess.SubprocessError) as error:
        event(con, box, 'box_tmp_reclaim_failed', str(error)[:300])
        return {}


def safe_to_stop(box):
    source = _REAPER + "\nprint(json.dumps(not any(p == '/tmp' or p.startswith('/tmp/') for p in held_paths())))\n"
    try:
        with api.budget(5):
            p = ssh_sync.ssh(box, 'sudo -n timeout 4 python3 -', input=source.encode(), timeout=5)
        return p.returncode == 0 and json.loads(p.stdout) is True
    except (OffboxError, OSError, ValueError, subprocess.SubprocessError):
        return False


def keep_running(con, box):
    # /tmp can be tmpfs: skipping an explicit stop must also prevent the backend's idle stop.
    try:
        with api.budget(5):
            kept = lease.ensure_ttl(box, common.RUN_TTL_S, api.get(box))
        event(con, box, 'box_disk_full_kept', json.dumps(dict(ttl=common.RUN_TTL_S, confirmed=kept)))
    except (OffboxError, OSError, subprocess.SubprocessError) as error:
        event(con, box, 'box_disk_full_keep_failed', str(error)[:300])


def retire(con, box, space, fs, *, stop=True):
    detail = dict(backend=api.BACKEND, filesystem=fs, space=space)
    # A note survives stop/reconciliation and frees the pool slot without deleting the disk.
    con.execute('UPDATE leases SET note=? WHERE box_id=?', (NOTE + ' ' + json.dumps(detail), box))
    con.commit()
    kv_set(con, 'disk_full:' + box, detail)
    event(con, box, 'box_retired_disk_full', json.dumps(detail))
    if stop and not lease.active_runs(con, box) and safe_to_stop(box):
        try:
            lease.stop_box(con, box, 'disk full; retained for inspection', images=False, locked=True)
        except (OffboxError, OSError, subprocess.SubprocessError) as error:
            event(con, box, 'box_disk_full_stop_failed', str(error)[:300])
    else:
        keep_running(con, box)


def picker_ok(con, row):
    if (row['note'] or '').startswith(NOTE):
        return False
    if row['state'] != 'running':
        return True
    space = measure(row['box_id'])
    fs = low(space)
    if fs:
        event(con, row['box_id'], 'pool_skip_low_disk', json.dumps(dict(filesystem=fs, space=space)))
        retire(con, row['box_id'], space, fs, stop=False)
        return False
    return True  # An unavailable measurement must not fence an otherwise usable box.


class Full(OffboxError):
    def __init__(self, box, fs, space, *, cleaned=False):
        self.fs, self.space, self.cleaned = fs, space, cleaned
        free = space.get(fs, {}).get('free_bytes', 'unknown')
        super().__init__(f'{box} is out of disk ({fs}: {free} free after cleanup)', box=box, code=90)


def recover(con, box, fs, space, path=None, current=''):
    if not space:
        space = measure(box)
    row = con.execute('SELECT size FROM leases WHERE box_id=?', (box,)).fetchone()
    event(con, box, 'box_disk_full', json.dumps(dict(box_id=box, backend=api.BACKEND,
          size=row['size'] if row else None, filesystem=fs, path=path, space=space)))
    if fs != 'tmp':
        prune.run(con, box, current, force=True)
    # With no live wrapper, files predating this cleanup belong to exited work; live epochs tighten the fence.
    after = (reclaim(con, box, finished_at=now()) if fs == 'tmp' else
             measure(box, space.get('workspace', {}).get('path')))
    # Unknown measurements cannot prove cleanup succeeded.
    healthy = bool(after) and fs in after and not low(after)
    event(con, box, 'box_cleaned_disk_full', json.dumps(dict(filesystem=fs, before=space, after=after,
                                                           recovered=healthy)))
    if not healthy:
        retire(con, box, after or space, fs)
    return healthy, after or space


def push_failure(error):
    if not disk.ENOSPC.search(str(error)):
        return None
    match = re.search(r'["\'](/[^"\'\n]+)["\']', str(error))
    path = match[1] if match else None
    return ('tmp' if path and (path == '/tmp' or path.startswith('/tmp/')) else 'workspace'), path


def hand_back(con, row, *, until=None):
    if until is not None and now() >= until:
        return
    if (not row['box_id'] or row['end_at'] is None or
            not con.execute('SELECT 1 FROM pool_members WHERE box_id=?', (row['box_id'],)).fetchone()):
        return
    key = 'tmp_hand_back:' + row['run_id']
    if kv_get(con, key):
        return
    # An uncertain/lost process must keep the normal ten-minute floor. Only confirmed exits get immediate reclaim.
    finished = row['end_at'] if row['exit_code'] is not None else None
    reclaim(con, row['box_id'], finished_at=finished, **({'until': until} if until is not None else {}))
    kv_set(con, key, {'at': now()})
    marked = con.execute('SELECT note FROM leases WHERE box_id=?', (row['box_id'],)).fetchone()
    if marked and until is None and (marked['note'] or '').startswith(NOTE):
        info = kv_get(con, 'disk_full:' + row['box_id']) or {}
        retire(con, row['box_id'], info.get('space', {}), info.get('filesystem', 'tmp'))


def release(me, box):
    from .identity import require_proven
    from .common import require_mine, file_lock
    require_proven(me, 'release-disk-full')
    with contextlib.closing(common.db()) as con:
        require_mine(con, box)
        with file_lock('box-' + box, timeout=0):
            row = con.execute('SELECT * FROM leases WHERE box_id=?', (box,)).fetchone()
            if not row or not (row['note'] or '').startswith(NOTE):
                raise OffboxError(f'{box} is not marked disk_full', code=2)
            if lease.active_runs(con, box):
                raise OffboxError(f'{box} still has active runs', code=2)
            # Stopped boxes are not resumed implicitly. The next allocation probes after resume.
            space = measure(box) if row['state'] == 'running' else {}
            if low(space):
                raise OffboxError(f'{box} is still low on disk: {json.dumps(space)}', code=90)
            con.execute('UPDATE leases SET note=NULL WHERE box_id=?', (box,))
            con.execute('DELETE FROM kv WHERE k=?', ('disk_full:' + box,))
            con.commit()
            event(con, box, 'box_released_disk_full', json.dumps(space))
            common.say(f'{box} released from disk_full')
