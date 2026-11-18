#!/usr/bin/python3
"""Cheap floor detection; bounded attribution runs in a separate child."""
import fcntl
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import uuid

from jobs import (SourceFailure, deadline_call, disk_throttle, du_total,
                  opencode_inventory_size, read_state, save_state, size_movers, state_path)
from toollog import emit, finite_number

# Robob's DBs and agent temp files need headroom: opencode.db alone is 67 GB
# and growing. This severe floor is independent of the 150 GB advisory guard.
INTERNAL_FREE_FLOOR_GB = 15
EXTERNAL_FREE_FLOOR_GB = 100
CHECK_EVERY_S = 120
MOVER_BUDGET_S = 6
CHILD_BUDGET_S = .5
RECENT_S = 24*3600
VOLUMES = (('internal', '/System/Volumes/Data', INTERNAL_FREE_FLOOR_GB),
           ('external', '/Volumes/ExternalSSD', EXTERNAL_FREE_FLOOR_GB))


def lock_file():
    lock = state_path('disk-low').with_suffix('.lock').open('a')
    os.chmod(lock.name, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return None
    return lock


def launch_worker(fd):
    # The inherited flock prevents another tick from adding children if this
    # one is stalled. The sampler never waits for attribution or traverses SSD.
    subprocess.Popen([sys.executable, str(Path(__file__).absolute()), 'pending', str(fd)],
                     pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def check(now=None, launch=launch_worker):
    """Minute sampler entry: once per two-minute bucket, statvfs disk reads."""
    now = time.time() if now is None else now
    lock = lock_file()
    if lock is None:
        return
    with lock:
        state = read_state('disk-low')
        at = state.get('checkedAt')
        if finite_number(at) and now >= at and int(now//CHECK_EVERY_S) == int(at//CHECK_EVERY_S):
            return
        episodes = state.setdefault('episodes', {})
        props, errors = {}, 0
        for volume, path, floor in VOLUMES:
            try:
                value = os.statvfs(path)
                free = value.f_bavail*value.f_frsize/1024**3
            except OSError:
                errors += 1
                continue  # An unavailable volume is not a recovery.
            props[volume+'FreeGb'] = round(free, 3)
            episode = episodes.get(volume)
            if free < floor:
                if episode is None:
                    episode = dict(start=now, key='disk-low:'+volume+':'+uuid.uuid4().hex,
                                   sent=False, logged=False)
                    episodes[volume] = episode
                episode.update(freeGb=free, floorGb=floor)
            elif episode is not None:
                emit('disk', 'event', 'disk.low_cleared',
                     props=dict(volume=volume, lowForS=max(0, now-episode['start'])))
                del episodes[volume]
        state['checkedAt'] = now
        save_state('disk-low', state)
        emit('disk', 'event' if not errors else 'error', 'disk.floor_check', ok=not errors,
             props=dict(props, sourceErrors=errors),
             error_tag='disk.source_unavailable' if errors else None)
        if any(not entry.get('sent') for entry in episodes.values()):
            try:
                launch(lock.fileno())
            except OSError:
                emit('disk', 'error', 'disk.alert', ok=False, props=dict(exitCode=127),
                     error_tag='disk.alert_failed')


def user_temp_dir(run):
    result = run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'], capture_output=True,
                 text=True, timeout=.5)
    if result.returncode or not result.stdout.strip():
        raise SourceFailure('unavailable', 'user temp directory unavailable')
    return Path(result.stdout.strip())


def bounded_command(command, timeout, text=False, env=None, **kwargs):
    # subprocess.run's timeout waits after kill. A du in kernel disk wait may
    # never exit; poll/abandon it instead so attribution cannot delay the alert.
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             stdin=subprocess.DEVNULL, env=env, start_new_session=True)
    # Disk exhaustion must not prevent the alert command from starting. These
    # commands have tiny output; excess output times out rather than spilling
    # into another temp file on the already-full filesystem.
    with child.stdout as out, child.stderr as err:
        os.set_blocking(out.fileno(), False)
        os.set_blocking(err.fileno(), False)
        deadline = time.monotonic()+timeout
        while child.poll() is None:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.poll()
                raise subprocess.TimeoutExpired(command, timeout)
            time.sleep(min(.01, remaining))
        stdout, stderr = out.read(65536) or b'', err.read(65536) or b''
        return subprocess.CompletedProcess(command, child.returncode,
            stdout.decode(errors='replace') if text else stdout,
            stderr.decode(errors='replace') if text else stderr)


def recent_temp_sizes(root, now, run, deadline):
    sizes, recent = {}, []
    # Limit enumeration as well as du; TMPDIR has had 160k direct children.
    with deadline_call(deadline, os.scandir, root) as entries:
        for entry in entries:
            try:
                info = deadline_call(deadline, entry.stat, follow_symlinks=False)
            except OSError:
                continue  # Scratch entries can disappear while enumerating.
            if info.st_mtime >= now-RECENT_S and not stat.S_ISLNK(info.st_mode):
                recent.append((stat.S_ISDIR(info.st_mode), info.st_mtime, entry.path))
    # Recent directories first: thousands of tiny shell receipt files must not
    # consume the scan allowance before a new transfer/snapshot directory.
    for _, _, path in sorted(recent, reverse=True):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            emit('disk', 'event', 'disk.movers_skipped', props=dict(source=str(root), skipped='budget_or_unavailable'))
            break
        try:
            size, denied, _ = du_total(path, run, min(CHILD_BUDGET_S, remaining))
            if not denied:
                sizes[path] = size
        except (OSError, SourceFailure, subprocess.TimeoutExpired):
            emit('disk', 'event', 'disk.movers_skipped', props=dict(source=path, skipped='budget_or_unavailable'))
    return sizes


def movers(volume, now, run=bounded_command, temp_dir=None):
    inventory = read_state('disk-inventory')
    previous = read_state('disk')
    sizes = {}
    if finite_number(inventory.get('at')) and 0 <= now-inventory['at'] <= 7200:
        sizes.update(inventory.get('sizes', {}))
        # The child inventory already measures opencode under .local/share.
        opencode_size = opencode_inventory_size(inventory, now)
        if opencode_size is not None:
            sizes[str(Path.home()/'.local/share/opencode')] = opencode_size
    old_sizes = dict(previous.get('sizes', {}))
    recent = {}
    if volume == 'internal':
        deadline = time.monotonic()+MOVER_BUDGET_S
        try:
            root = user_temp_dir(run) if temp_dir is None else Path(temp_dir)
            # Never follow a temp symlink onto ExternalSSD, or scan its tree.
            if deadline_call(deadline, root.resolve).is_relative_to('/Volumes'):
                raise SourceFailure('unavailable', 'temp directory on external storage')
            def bounded_run(command, **kw):
                return run(disk_throttle(command), **kw)
            recent = recent_temp_sizes(root, now, bounded_run, deadline)
        except (OSError, SourceFailure, subprocess.TimeoutExpired):
            emit('disk', 'event', 'disk.movers_skipped', props=dict(skipped='budget_or_unavailable'))
        cached = read_state('disk-low-movers')
        if finite_number(cached.get('at')) and 0 <= now-cached['at'] <= RECENT_S:
            old_sizes.update(cached.get('sizes', {}))
        sizes.update(recent)
        save_state('disk-low-movers', dict(at=now, sizes=recent))
    sizes = {path: size for path, size in sizes.items() if isinstance(path, str)
             and Path(path).is_relative_to('/Volumes/ExternalSSD') == (volume == 'external')
             and finite_number(size)}
    uncertain = set(inventory.get('partials', {})) | set(previous.get('partials', {}))
    growth = [(path, delta) for path, delta in size_movers(sizes, old_sizes, uncertain) if delta > 0]
    # First sightings are sizes, not invented deltas. A newly created snapshot
    # is still actionable before a comparable earlier measurement exists.
    candidates = {p: d for p, d in growth}
    candidates.update({p: size for p, size in recent.items() if p not in old_sizes})
    selected = sorted(candidates, key=lambda p: (-candidates[p], p))[:3]
    props = {}
    for i, path in enumerate(selected, 1):
        props['topMover%dPath' % i] = path
        props['topMover%dGb' % i] = round(sizes[path]/1024**3, 3)
        if path in old_sizes:
            props['topMover%dGbDelta' % i] = round((sizes[path]-old_sizes[path])/1024**3, 6)
    return props


def pending(run=bounded_command, now=None):
    """Called only with the detector's inherited episode lock held."""
    now = time.time() if now is None else now
    state = read_state('disk-low')
    for volume, episode in state.get('episodes', {}).items():
        if episode.get('sent'):
            continue
        if not episode.get('logged'):
            props = dict(volume=volume, freeGb=round(episode['freeGb'], 3), floorGb=episode['floorGb'])
            try:
                props.update(movers(volume, now, run))
            except Exception:
                # Optional attribution must not suppress the floor alert.
                emit('disk', 'event', 'disk.movers_skipped', props=dict(skipped='budget_or_unavailable'))
            names = ['%s %.1f GB%s' % (Path(props['topMover%dPath' % i]).name,
                     props['topMover%dGb' % i],
                     ' (size)' if 'topMover%dGbDelta' % i not in props else ' (+%.1f GB)' % props['topMover%dGbDelta' % i])
                     for i in range(1, 4) if 'topMover%dPath' % i in props]
            episode['text'] = ('Disk space critical: %s %.2f GB free (< %s GB). Recent movers: %s.' %
                               (volume, episode['freeGb'], episode['floorGb'], '; '.join(names) or 'unavailable'))
            emit('disk', 'event', 'disk.low', props=props)
            episode['logged'] = True
            save_state('disk-low', state)
        # Freeze text/key before the send. A timeout can mean it was queued;
        # Telegram's existing key deduplication makes the next tick safe.
        env = dict(os.environ)
        env.pop('BUN_INSPECT', None)
        try:
            result = run(['/Users/ardud/.bun/bin/bun', '/Users/ardud/.local/share/telegram-bridge/src/cli.ts',
                          'notify', '--source', 'Disk space guard', '--severity', 'attention',
                          '--text', episode['text'], '--key', episode['key']],
                         capture_output=True, timeout=10, env=env)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
        except OSError:
            code = 127
        emit('disk', 'event' if code == 0 else 'error', 'disk.alert', ok=code == 0,
             props=dict(volume=volume, exitCode=code), error_tag=None if code == 0 else 'disk.alert_failed')
        if code == 0:
            episode['sent'] = True
            save_state('disk-low', state)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'pending':
        with os.fdopen(int(sys.argv[2]), 'a'):
            pending()
    else:
        check()
