#!/usr/bin/python3
"""Cheap floor detection; bounded attribution runs in a separate child."""
import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from jobs import (SourceFailure, deadline_call, disk_throttle, du_total,
                  opencode_inventory_size, read_state, save_state, size_movers)
from toollog import directory, emit, finite_number

# Robob's DBs and agent temp files need headroom: opencode.db alone is 67 GB
# and growing. This severe floor is independent of the 150 GB advisory guard.
INTERNAL_FREE_FLOOR_GB = 15
EXTERNAL_FREE_FLOOR_GB = 100
CHECK_EVERY_S = 120
MOVER_BUDGET_S = 6
CHILD_BUDGET_S = .5
RECENT_S = 24*3600
STATE_IO_BUDGET_S = .25
EMERGENCY_STATE = Path('/Volumes/ExternalSSD/.mac-upkeep/disk-low.json')
VOLUMES = (('internal', '/System/Volumes/Data', INTERNAL_FREE_FLOOR_GB),
           ('external', '/Volumes/ExternalSSD', EXTERNAL_FREE_FLOOR_GB))


@contextmanager
def lock_file():
    # Lock an existing directory inode: even creating a zero-byte lock file
    # can fail with ENOSPC. Atomic state replacement leaves this inode intact.
    root = directory()
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd = os.open(root, os.O_RDONLY)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        yield fd
    finally:
        os.close(fd)


def launch_worker(fd, state):
    # The inherited flock prevents another tick from adding children if this
    # one is stalled. The sampler never waits for attribution or traverses SSD.
    # argv carries the small snapshot without a tempfile or a blocking pipe.
    subprocess.Popen([sys.executable, str(Path(__file__).absolute()), 'pending', str(fd), json.dumps(state)],
                     pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def save_primary(name, state):
    try:
        save_state(name, state)
        return True
    except OSError as exc:
        emit('disk', 'error', 'disk.state_failed', ok=False,
             props=dict(source=name, errno=exc.errno), error_tag='disk.state_unavailable')
        return False


def episode_key(volume, healthy_at):
    # Repeated detections must agree even if neither disk can checkpoint.
    # A persisted healthy observation re-arms the next episode.
    return 'disk-low:'+volume+':'+uuid.uuid5(uuid.NAMESPACE_URL, '%s:%s' % (volume, healthy_at)).hex


def check(now=None, launch=launch_worker):
    """Minute sampler entry: once per two-minute bucket, statvfs disk reads."""
    now = time.time() if now is None else now
    with lock_file() as fd:
        if fd is None:
            return
        state = read_state('disk-low')
        at = state.get('checkedAt')
        if finite_number(at) and now >= at and int(now//CHECK_EVERY_S) == int(at//CHECK_EVERY_S):
            return
        episodes = state.setdefault('episodes', {})
        healthy = state.setdefault('healthyAt', {})
        props, errors = {}, 0
        state['readings'] = readings = {}
        state['clearedKeys'] = []
        for volume, path, floor in VOLUMES:
            try:
                value = os.statvfs(path)
                free = value.f_bavail*value.f_frsize/1024**3
            except OSError:
                errors += 1
                continue  # An unavailable volume is not a recovery.
            props[volume+'FreeGb'] = round(free, 3)
            readings[volume] = dict(freeGb=free, floorGb=floor)
            episode = episodes.get(volume)
            if free < floor:
                if episode is None:
                    episode = dict(start=now, key=episode_key(volume, healthy.get(volume, 0)),
                                   sent=False, logged=False)
                    episodes[volume] = episode
                episode.update(freeGb=free, floorGb=floor)
            else:
                healthy[volume] = now
                if episode is not None:
                    emit('disk', 'event', 'disk.low_cleared',
                         props=dict(volume=volume, lowForS=max(0, now-episode['start'])))
                    state['clearedKeys'].append(episode['key'])
                    del episodes[volume]
        state['checkedAt'] = now
        saved = save_primary('disk-low', state)
        emit('disk', 'event' if not errors else 'error', 'disk.floor_check', ok=not errors,
             props=dict(props, sourceErrors=errors),
             error_tag='disk.source_unavailable' if errors else None)
        # A sent receipt may exist only in the emergency checkpoint. The
        # child reconciles it without measuring movers or notifying again.
        # A missing checkpoint can also hide an episode that has recovered.
        reconcile = not finite_number(at) or now-at > CHECK_EVERY_S*1.5
        if episodes or not saved or reconcile:
            try:
                launch(fd, state)
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
    def listing():
        with os.scandir(root) as entries:
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue  # Scratch entries can disappear while enumerating.
                if info.st_mtime >= now-RECENT_S and not stat.S_ISLNK(info.st_mode):
                    recent.append((stat.S_ISDIR(info.st_mode), info.st_mtime, entry.path))
    deadline_call(deadline, listing)
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
        save_primary('disk-low-movers', dict(at=now, sizes=recent))
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


def emergency_io(operation, *args):
    try:
        return deadline_call(time.monotonic()+STATE_IO_BUDGET_S, operation, *args)
    except (OSError, SourceFailure, ValueError):
        emit('disk', 'event', 'disk.state_skipped', props=dict(source='emergency', skipped='budget_or_unavailable'))


def read_emergency():
    try:
        with EMERGENCY_STATE.open() as stream:
            value = json.loads(stream.read(16384))
        if not isinstance(value, dict) or not isinstance(value.get('episodes', {}), dict):
            raise ValueError('invalid emergency episodes')
        healthy = value.get('healthyAt', {})
        if not isinstance(healthy, dict) or any(not finite_number(at) for at in healthy.values()):
            raise ValueError('invalid emergency recovery')
        for episode in value.get('episodes', {}).values():
            if (not isinstance(episode, dict) or not isinstance(episode.get('key'), str)
                    or not finite_number(episode.get('start'))
                    or type(episode.get('sent', False)) is not bool
                    or type(episode.get('logged', False)) is not bool
                    or episode.get('logged') and not isinstance(episode.get('text'), str)):
                raise ValueError('invalid emergency episode')
        return value
    except FileNotFoundError:
        return {}


def write_emergency(state):
    EMERGENCY_STATE.parent.mkdir(mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.disk-low-', dir=EMERGENCY_STATE.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream)
        os.replace(tmp, EMERGENCY_STATE)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def checkpoint(state, backup_ok):
    if save_primary('disk-low', state):
        if backup_ok:
            emergency_io(lambda: EMERGENCY_STATE.unlink(missing_ok=True))
    elif backup_ok:
        emergency_io(write_emergency, state)


def pending(run=bounded_command, now=None, state=None):
    """Called only with the detector's inherited episode lock held."""
    now = time.time() if now is None else now
    state = read_state('disk-low') if state is None else state
    external = state.get('readings', {}).get('external', {})
    # This code runs only in the child. Never create a shadow directory on
    # the internal disk when the SSD is unmounted, or write to a low SSD.
    backup_ok = (external.get('freeGb', 0) >= EXTERNAL_FREE_FLOOR_GB and
                 emergency_io(os.path.ismount, '/Volumes/ExternalSSD'))
    if not backup_ok:
        emit('disk', 'event', 'disk.state_skipped', props=dict(source='emergency', skipped='budget_or_unavailable'))
    cached = (emergency_io(read_emergency) or {}) if backup_ok else {}
    for volume, prior in cached.get('episodes', {}).items():
        recovered = state.get('healthyAt', {}).get(volume, 0)
        if recovered >= prior['start'] and prior['key'] not in state.get('clearedKeys', []):
            emit('disk', 'event', 'disk.low_cleared',
                 props=dict(volume=volume, lowForS=max(0, recovered-prior['start'])))
            state.setdefault('clearedKeys', []).append(prior['key'])
    episodes = state.setdefault('episodes', {})
    for volume, recovered in cached.get('healthyAt', {}).items():
        if recovered > state.get('healthyAt', {}).get(volume, 0):
            state.setdefault('healthyAt', {})[volume] = recovered
            # Recovery retires stale primary state even if this source is
            # unavailable now. Only this tick's low reading can re-arm it.
            retired = episodes.pop(volume, None)
            if (retired is not None and retired['start'] <= recovered
                    and retired['key'] not in state.get('clearedKeys', [])):
                emit('disk', 'event', 'disk.low_cleared',
                     props=dict(volume=volume, lowForS=max(0, recovered-retired['start']),
                                reason='emergency_recovery'))
                state.setdefault('clearedKeys', []).append(retired['key'])
            reading = state.get('readings', {}).get(volume)
            prior = cached.get('episodes', {}).get(volume, {})
            if (prior.get('start', 0) > recovered and finite_number(prior.get('freeGb'))
                    and finite_number(prior.get('floorGb'))):
                # A confirmed later episode is still valid during a source
                # error; retain its frozen message and receipt without re-arming.
                episodes[volume] = dict(prior)
                if reading is not None:
                    episodes[volume].update(reading)
            elif reading is not None and reading['freeGb'] < reading['floorGb']:
                episodes[volume] = dict(start=now, key=episode_key(volume, recovered),
                                        sent=False, logged=False, **reading)
    for volume, episode in episodes.items():
        prior = cached.get('episodes', {}).get(volume, {})
        if prior.get('key') == episode['key']:
            # Keep the frozen payload and any successful send receipt, while
            # retaining the detector's latest free-space reading.
            episode.update({k: prior[k] for k in ('start', 'logged', 'text', 'sent') if k in prior})
    checkpoint(state, backup_ok)
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
            checkpoint(state, backup_ok)
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
            checkpoint(state, backup_ok)


if __name__ == '__main__':
    if len(sys.argv) in (3, 4) and sys.argv[1] == 'pending':
        try:
            pending(state=json.loads(sys.argv[3]) if len(sys.argv) == 4 else None)
        finally:
            os.close(int(sys.argv[2]))
    else:
        check()
