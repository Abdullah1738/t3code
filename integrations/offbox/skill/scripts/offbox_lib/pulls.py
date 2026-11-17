"""Claim artifact settlement and publish remote files against the pusher's local snapshot."""
import contextlib
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import uuid

from . import common, ssh_sync


TERMINAL = ('none', 'done', 'partial', 'failed')


def baseline_path(run_id):
    return common.LOGS_DIR / f'{run_id}.pull-baseline.json'


def fingerprint(path, *, dir_fd=None):
    try:
        mode = os.stat(path, dir_fd=dir_fd, follow_symlinks=False).st_mode
    except FileNotFoundError:
        return 'absent'
    if not stat.S_ISREG(mode):
        return 'non-file'
    digest = hashlib.sha256()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        return 'absent'
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            return 'non-file'
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        return 'unstable'
    return {'sha256': digest.hexdigest(), 'bytes': after.st_size}


def safe_path(root, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise common.OffboxError(f'--pull path must be relative to the cwd: {relative}', code=2)
    target = root / path
    # Check every ancestor, including links which still resolve inside the tree: neither a snapshot nor a
    # publisher should traverse a directory that another process can retarget outside the worktree.
    for part in target.parents:
        if part == root:
            break
        if part.is_symlink():
            raise common.OffboxError(f'pull path traverses a symlink: {relative}', code=2)
    return target


def local_matches(root, pattern):
    """Expand local glob components without descending through symlink directories."""
    parts = Path(pattern).parts
    if Path(pattern).is_absolute() or '..' in parts:
        return  # Path validation stays at the existing rsync boundary.
    def walk(path, remaining):
        if not remaining:
            if path.exists() or path.is_symlink():
                yield path
            return
        if path.is_symlink() or not path.is_dir():
            return
        first, *rest = remaining
        if first == '**':
            yield from walk(path, rest)
            for child in sorted(path.iterdir()):
                if child.is_dir() and not child.is_symlink():
                    yield from walk(child, remaining)
        else:
            for child in sorted(path.iterdir()):
                if fnmatch.fnmatchcase(child.name, first):
                    yield from walk(child, rest)
    yield from walk(root, parts)


def files_under(root):
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            yield Path(directory) / name


def snapshot_baseline(cwd, paths):
    root = Path(cwd).resolve()
    files = {}
    for pattern in paths:
        matches = list(local_matches(root, pattern))
        if not matches:
            files[pattern] = 'absent'
        for path in matches:
            entries = files_under(path) if path.is_dir() and not path.is_symlink() else (path,)
            for entry in entries:
                safe_path(root, entry.relative_to(root))
                files[entry.relative_to(root).as_posix()] = fingerprint(entry)
    return {'cwd': str(root), 'paths': paths, 'files': files}


def record_baseline(run_id, cwd, paths, snapshot=None):
    common.atomic_write_json(baseline_path(run_id), snapshot if snapshot is not None else snapshot_baseline(cwd, paths))
    with contextlib.closing(common.db()) as con:
        con.execute("UPDATE runs SET pull_state='pending' WHERE run_id=? AND pull_state IS NULL", (run_id,))


def records(run_id):
    path = common.LOGS_DIR / f'{run_id}.pulls.jsonl'
    if not path.exists():
        return []
    result = []
    for line in path.read_text().splitlines():
        try:
            result.append(json.loads(line))
        except ValueError:
            pass  # A killed writer may leave its final line incomplete.
    return result


def record(row, kind, **values):
    owner = row['_pull_owner']
    data = dict(run_id=row['run_id'], box=row['box_id'], pid=owner['pid'], role=owner['role'], claim=owner.get('claim'),
                ts=common.now(), **values)
    data.setdefault('ms', round((common.now()-row['_pull_started_at'])*1000))
    with (common.LOGS_DIR / f"{row['run_id']}.pulls.jsonl").open('a') as stream:
        stream.write(json.dumps(dict(kind=kind, **data), sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    with database(row.get('_pull_until')) as con:
        common.event(con, row['box_id'], kind, json.dumps(data, sort_keys=True))


@contextlib.contextmanager
def database(until=None):
    with contextlib.closing(common.db() if until is None else common.db(until=until)) as con:
        yield con


def footer(run_id):
    entries = records(run_id)
    if not entries:
        return
    # Remote stream checkpoints never include these bytes. Catch-up may truncate them; recreate the footer
    # from its journal after catch-up, rather than changing the remote stdout/stderr offsets.
    path = common.LOGS_DIR / f'{run_id}.log'
    marker = f'\n[offbox {run_id} pulls]\n'
    content = (marker + ''.join('offbox: ' + entry['kind'] + ' ' + json.dumps(entry, sort_keys=True) + '\n'
                               for entry in entries)).encode()
    from .runs import log_lock
    guard = log_lock(run_id, timeout=0)
    try:
        guard.__enter__()
    except common.OffboxError:
        return  # The holder or next reader reconstructs it from the journal.
    try:
        if common.checkpoint(path) is None and (not path.exists() or path.stat().st_size == 0):
            return  # A footer-only legacy log would prevent the next history read from recovering output.
        path.touch(exist_ok=True)
        with path.open('r+b') as stream:
            size = stream.seek(0, 2)
            start = max(0, size-len(content)-256)
            stream.seek(start)
            tail = stream.read()
            if tail.endswith(content):
                return
            previous = tail.find(marker.encode())
            stream.seek(start+previous if previous >= 0 else size)
            stream.write(content)
            stream.truncate()
    finally:
        guard.__exit__(None, None, None)


@contextlib.contextmanager
def publication_parent(root, relative):
    safe_path(root, relative)
    # Pin each ancestor without following links. All subsequent operations use this directory handle,
    # even if another process renames the directory or replaces its former name with a symlink.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with contextlib.ExitStack() as stack:
        parent = os.open(root, flags)
        stack.callback(os.close, parent)
        for part in relative.parts[:-1]:
            try:
                child = os.open(part, flags, dir_fd=parent)
            except FileNotFoundError:
                try:
                    os.mkdir(part, dir_fd=parent)
                except FileExistsError:
                    pass
                child = os.open(part, flags, dir_fd=parent)
            parent = child
            stack.callback(os.close, parent)
        yield parent


def publication_location(root, relative, parent, *, recovery=False):
    """Locate a pinned parent after renames without following replacement directory symlinks."""
    pinned = os.fstat(parent)
    def matches(path):
        try:
            safe_path(root, path.relative_to(root) / relative.name)
            current = path.stat(follow_symlinks=False)
            return (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino)
        except (OSError, common.OffboxError):
            return False
    if matches(root / relative.parent):
        return root / relative
    # Only a concurrent rename takes this path; the usual publication needs no tree traversal.
    for directory, dirs, _ in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        if matches(Path(directory)):
            return Path(directory) / relative.name
    if recovery:
        # A directory moved out of the tree can already contain a publication or displaced inode.
        # Resolve the held descriptor for receipts only; never reopen it through a replacement path.
        if sys.platform == 'darwin':
            directory = os.fsdecode(fcntl.fcntl(parent, 50, bytes(1024)).split(b'\0', 1)[0])  # F_GETPATH
        else:
            directory = os.readlink(f'/proc/self/fd/{parent}')
        actual = Path(directory)
        current = actual.stat(follow_symlinks=False)
        if (current.st_dev, current.st_ino) == (pinned.st_dev, pinned.st_ino):
            return actual / relative.name
    raise common.OffboxError(f'pull directory moved outside the worktree: {relative}; publication cannot continue')


def receipt_path(path, root):
    return path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)


def atomic_copy(source, destination, *, expected=None, root=None, backup_record=None, written_record=None):
    root = root if root is not None else destination.parent
    relative = destination.relative_to(root)
    with publication_parent(root, relative) as parent:
        publication_location(root, relative, parent)
        # Stage on the destination filesystem and publish exclusively so a concurrent save always wins.
        name = f'.{destination.name}.offbox-tmp-{uuid.uuid4().hex}'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        backup, published = None, False
        try:
            with os.fdopen(fd, 'wb') as output, source.open('rb') as incoming:
                shutil.copyfileobj(incoming, output)
                metadata = os.fstat(incoming.fileno())
                os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            os.utime(name, ns=(metadata.st_atime_ns, metadata.st_mtime_ns), dir_fd=parent,
                     follow_symlinks=False)
            if expected is None:
                alternate = destination.name
                while True:
                    try:
                        os.link(name, alternate, src_dir_fd=parent, dst_dir_fd=parent,
                                follow_symlinks=False)
                        return publication_location(root, relative.with_name(alternate), parent, recovery=True)
                    except FileExistsError:
                        alternate = destination.name + '-' + uuid.uuid4().hex
            if fingerprint(destination.name, dir_fd=parent) != expected:
                return False
            if expected != 'absent':
                saved = f'.{destination.name}.offbox-local-{uuid.uuid4().hex}'
                try:
                    os.replace(destination.name, saved, src_dir_fd=parent, dst_dir_fd=parent)
                except FileNotFoundError:
                    return False
                backup = saved
                # Retain the displaced inode even on success: an already-open writer may still save into it.
                if fingerprint(backup, dir_fd=parent) != expected:
                    return False
            try:
                os.link(name, destination.name, src_dir_fd=parent, dst_dir_fd=parent,
                        follow_symlinks=False)
                published = True
                actual = publication_location(root, relative, parent, recovery=True)
                if written_record:
                    written_record(actual)
                return actual
            except FileExistsError:
                return False
        finally:
            try:
                if backup is not None and not published:
                    try:
                        os.link(backup, destination.name, src_dir_fd=parent, dst_dir_fd=parent,
                                follow_symlinks=False)
                    except FileExistsError:
                        pass  # A concurrent save owns the path; the displaced version remains in the backup.
                    except OSError as error:
                        raise common.OffboxError(f'could not restore {relative}; local version retained at '
                                                 f'{publication_location(root, relative.with_name(backup), parent, recovery=True)}: {error}') from error
            finally:
                try:
                    if backup is not None and backup_record:
                        backup_record(publication_location(root, relative.with_name(backup), parent, recovery=True))
                finally:
                    os.unlink(name, dir_fd=parent)


def transfer(row, paths, *, until=None, foreign=False):
    run_id = row['run_id']
    owner = row['_pull_owner']
    root = Path(row['local_cwd']).resolve()
    label = row['local_cwd']
    snapshot = baseline_path(run_id)
    baseline = json.loads(snapshot.read_text()) if snapshot.exists() else None
    if baseline is None:
        common.say(f'{run_id}: no pull baseline (older client or --no-sync); pulling with overwrite enabled')
    elif baseline['cwd'] != str(root):
        raise common.OffboxError(f'{run_id}: pull baseline belongs to another directory')
    summary = row['_pull_summary']
    seen = set()
    previous = {e['path']: e for e in records(run_id) if e['kind'] == 'pull_file'}
    with tempfile.TemporaryDirectory(prefix=run_id + '-pull-', dir=common.LOGS_DIR) as temporary:
        for index, pattern in enumerate(paths):
            if until is not None and common.now() >= until:
                raise common.OffboxError('artifact pull deadline reached; wait again', code=common.EXIT_WAIT_TIMEOUT)
            stage = Path(temporary) / str(index)
            stage.mkdir()
            opts = {} if until is None else {'timeout': max(.001, min(1800, until-common.now()))}
            prefix = (f'settled background run {run_id} (not this run): pull {pattern} into {label}'
                      if foreign else f'{run_id}: pull {pattern}')
            conflicts_before = summary['conflicts']
            try:
                st = ssh_sync.pull(row['box_id'], row['remote_dir'], row['rel_cwd'] or '.', pattern,
                                   stage, relative=True, **opts)
                with database(until) as con:
                    kind = 'run_pulled' if st.get('ok') else 'run_pull_failed'
                    error = f"not created on the box: {st.get('error')}" if st.get('missing') else st.get('error')
                    common.event(con, row['box_id'], kind, f'{run_id} {pattern} -> {label} ' +
                                 (f"files={st.get('files', 0)}" if st.get('ok') else f'error={error}'))
                if not st.get('ok'):
                    summary['errors'] += 1
                    record(row, 'pull_file', path=pattern, bytes=0, sha256=None, outcome='failed', error=st.get('error'))
                    common.say(f'{prefix}: not created on the box' if st.get('missing') else
                               f"{prefix} failed: {st.get('error')}")
                    continue
                for source in files_under(stage):
                    if until is not None and common.now() >= until:
                        raise common.OffboxError('artifact pull deadline reached; wait again', code=common.EXIT_WAIT_TIMEOUT)
                    relative = source.relative_to(stage).as_posix()
                    if relative in seen:
                        continue
                    seen.add(relative)
                    incoming = fingerprint(source)
                    if not isinstance(incoming, dict):
                        raise common.OffboxError(f'pull returned a non-regular file: {relative}')
                    destination = safe_path(root, relative)
                    local = fingerprint(destination)
                    original = baseline['files'].get(relative, 'absent') if baseline else local
                    prior = previous.get(relative, {})
                    # A recovered owner may revisit files the dead owner already published.
                    own_write = prior.get('outcome') in ('written', 'unchanged') and local == {
                        'sha256': prior.get('sha256'), 'bytes': prior.get('bytes')}
                    conflict = (local != original or original == 'unstable') and not own_write
                    published_at = None
                    recorded = False
                    if not conflict and local != incoming:
                        def preserve(backup):
                            relative_backup = receipt_path(backup, root)
                            record(row, 'pull_backup', path=relative, backup=relative_backup)
                            common.say(f'{run_id}: preserving local version of {relative} at {relative_backup}')
                        def written(actual):
                            nonlocal recorded
                            recorded = True
                            summary['files'] += 1
                            summary['bytes'] += incoming['bytes']
                            # The journal must account for publication before secondary backup bookkeeping
                            # can fail or reach its SQLite deadline.
                            record(row, 'pull_file', path=relative, **incoming, outcome='written',
                                   written_copy=receipt_path(actual, root))
                        published_at = atomic_copy(source, destination, expected=local, root=root,
                                                   backup_record=preserve, written_record=written)
                        conflict = not published_at
                    if conflict:
                        alternate = safe_path(root, relative + '.offbox-pulled')
                        alternate = atomic_copy(source, alternate, root=root)
                        summary['conflicts'] += 1
                        message = (f'offbox: {run_id}: NOT pulled {relative}: changed locally after the push '
                                   f'(pulled copy at {receipt_path(alternate, root)}; '
                                   f'settler {owner["role"]} pid {owner["pid"]})')
                        common.say(message.removeprefix('offbox: '))
                        record(row, 'pull_conflict', path=relative, **incoming, outcome='conflict', message=message,
                               pulled_copy=receipt_path(alternate, root))
                        outcome = 'conflict'
                    elif local == incoming:
                        outcome = 'unchanged'
                    else:
                        outcome = 'written'
                    if not recorded:
                        record(row, 'pull_file', path=relative, **incoming, outcome=outcome)
                        summary['files'] += 1
                        summary['bytes'] += incoming['bytes']
                if foreign:
                    common.say(f'settled background run {run_id} (not this run) and pulled {pattern} '
                               f'into {label} ({st.get("files", 0)} files)')
                elif summary['conflicts'] == conflicts_before:
                    common.say(f'{run_id}: pulled {pattern} ({st.get("files", 0)} files)')
            except sqlite3.Error:
                raise
            except Exception as error:
                if ((isinstance(error, common.OffboxError) and error.code == common.EXIT_WAIT_TIMEOUT) or
                        (isinstance(error, subprocess.TimeoutExpired) and until is not None and common.now() >= until)):
                    raise common.OffboxError('artifact pull deadline reached; wait again', code=common.EXIT_WAIT_TIMEOUT,
                                             started=True, run_id=run_id) from error
                summary['errors'] += 1
                with database(until) as con:
                    common.event(con, row['box_id'], 'run_pull_failed', f'{run_id} {pattern} -> {label} error={error}')
                record(row, 'pull_file', path=pattern, bytes=0, sha256=None, outcome='failed', error=str(error))
                common.say(f'{prefix} failed: {error}')
    return summary


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def settle(run_id, role, *, until=None, foreign=False):
    """Return False while another live settler owns this run; never hold a DB transaction over rsync."""
    owner = dict(pid=os.getpid(), role=role, claim=uuid.uuid4().hex)
    old_owner = None
    with database(until) as con:
        with common.write(con):
            row = dict(con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone())
            paths = json.loads(row['pulls'] or '[]')
            if not paths:
                con.execute("UPDATE runs SET pull_state='none' WHERE run_id=? AND pull_state IS NULL", (run_id,))
                return True
            if row['pull_state'] in TERMINAL:
                return True
            if row['pull_state'] == 'running':
                old_owner = json.loads(row['pull_owner'])
                token = old_owner.get('claim')
                released = token and any(entry['kind'] == 'pull_end' and entry.get('claim') == token
                                         and entry.get('outcome') == 'pending' for entry in records(run_id))
                if _alive(old_owner['pid']) and not released:
                    return False
            con.execute("UPDATE runs SET pull_state='running',pull_started_at=?,pull_ended_at=NULL,pull_owner=? "
                        'WHERE run_id=?', (common.now(), json.dumps(owner), run_id))
    row['_pull_owner'] = owner
    row['_pull_until'] = until
    row['_pull_started_at'] = common.now()
    started = time.monotonic()
    summary = dict(files=0, bytes=0, conflicts=0, errors=0)
    row['_pull_summary'] = summary
    state = 'failed'
    try:
        record(row, 'pull_start', retaken_from=old_owner)
        if old_owner:
            reason = 'released' if released else 'dead'
            common.say(f'{run_id}: retaking pull from {reason} settler {old_owner["role"]} pid {old_owner["pid"]}')
        from . import runs
        runs.do_pulls(row['box_id'], row, paths, until=until, foreign=foreign)
        state = 'partial' if summary['conflicts'] or summary['errors'] else 'done'
        if summary['errors'] and not summary['files']:
            state = 'failed'
    except (sqlite3.Error, KeyboardInterrupt, SystemExit):
        state = 'pending'
        raise
    except Exception as error:
        if isinstance(error, common.OffboxError) and error.code == common.EXIT_WAIT_TIMEOUT:
            state = 'pending'
            raise
        summary['errors'] += 1
        summary['error'] = str(error)
        common.say(f'{run_id}: pulls failed (settler {role} pid {owner["pid"]}): {error}')
    finally:
        from . import runs
        try:
            record(row, 'pull_end', **summary, outcome=state, ms=round((time.monotonic()-started)*1000))
            runs.save_run_state(run_id, until=until, pulls=dict(state=state, owner=owner,
                started_at=row['_pull_started_at'], ended_at=common.now(), events=records(run_id), **summary))
        except BaseException as error:
            state = 'pending'
            raise
        finally:
            try:
                with database(until) as con:
                    con.execute('UPDATE runs SET pull_state=?,pull_ended_at=?,pull_summary=? WHERE run_id=? AND pull_owner=?',
                                (state, common.now(), json.dumps(summary), run_id, json.dumps(owner)))
                if state == 'pending':
                    with contextlib.suppress(sqlite3.Error, common.OffboxError):
                        record(row, 'pull_end', **summary, outcome='pending')
            except (sqlite3.Error, common.OffboxError) as error:
                # The durable release lets a later wait reclaim even if this process stays alive and SQLite
                # prevented clearing its claim. No file transfer follows this release.
                with contextlib.suppress(common.OffboxError):
                    runs.save_run_state(run_id, until=until, pulls=dict(state='pending', owner=owner,
                        started_at=row['_pull_started_at'], ended_at=common.now(), events=records(run_id), **summary))
                with contextlib.suppress(sqlite3.Error, common.OffboxError):
                    record(row, 'pull_end', **summary, outcome='pending', bookkeeping_error=str(error))
                raise
    return True


def report(run_id, *, until=None):
    with database(until) as con:
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
    if row is None:
        return
    state = row['pull_state'] or 'none'
    if state == 'none' or not json.loads(row['pulls'] or '[]'):
        return
    if state == 'running':
        owner = json.loads(row['pull_owner'])
        common.say(f'{run_id}: pulls: still running (owner pid {owner["pid"]}, role {owner["role"]})')
    else:
        summary = json.loads(row['pull_summary'] or '{}')
        common.say(f'{run_id}: pulls: {state} ({summary.get("files", 0)} files, {summary.get("conflicts", 0)} conflicts)')
        for entry in records(run_id):
            if entry['kind'] == 'pull_conflict':
                common.say(entry['message'].removeprefix('offbox: '))
        if summary.get('errors'):
            common.say(f'{run_id}: pull errors: {summary.get("error") or str(summary["errors"]) + " paths failed; see run log"}')


def wait(run_id, role='wait', *, until=None, foreign=False):
    while True:
        with database(until) as con:
            row = con.execute('SELECT pulls,pull_state FROM runs WHERE run_id=?', (run_id,)).fetchone()
        if row is None:
            raise common.OffboxError(f'no run {run_id}', code=2)
        if row['pull_state'] in TERMINAL or not json.loads(row['pulls'] or '[]'):
            return
        if until is not None and common.now() >= until:
            report(run_id, until=until)
            raise common.OffboxError(f'{run_id}: artifact pull deadline reached; wait again', code=common.EXIT_WAIT_TIMEOUT,
                                     started=True, run_id=run_id)
        if settle(run_id, role, until=until, foreign=foreign):
            if until is not None and common.now() >= until:
                report(run_id, until=until)
                raise common.OffboxError(f'{run_id}: artifact pull deadline reached; wait again',
                                         code=common.EXIT_WAIT_TIMEOUT, started=True, run_id=run_id)
            return
        time.sleep(min(.1, max(0, until-common.now())) if until is not None else .1)
