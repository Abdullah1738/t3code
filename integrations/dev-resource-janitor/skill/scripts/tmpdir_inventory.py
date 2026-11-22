"""Bounded, read-only metadata and Git checks shared by TMPDIR reports and pruning."""
import contextlib
import fcntl
import os
import stat
import subprocess
import time


DISK_LOCK = os.path.expanduser('~/.robob/logs/tools/mac/state/disk-inventory.lock')
TREE_SECONDS = 25
MAX_NODES = 500000


class UsageUnavailable(Exception):
    def __init__(self, skipped, reason):
        self.skipped, self.reason = skipped, reason
        super().__init__(reason)


@contextlib.contextmanager
def disk_lock():
    os.makedirs(os.path.dirname(DISK_LOCK), mode=0o700, exist_ok=True)
    with open(DISK_LOCK, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as err:
            raise UsageUnavailable('inventory_busy', 'shared sizing lock held') from err
        yield lock.fileno()


def git(path, args, deadline, lock_fd=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise UsageUnavailable('tree_unavailable', 'Git deadline')
    try:
        p = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-C', path, *args],
                           env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'},
                           capture_output=True, text=True, timeout=min(10, remaining),
                           pass_fds=() if lock_fd is None else (lock_fd,))
    except (OSError, subprocess.SubprocessError, UnicodeError) as err:
        raise UsageUnavailable('git_unavailable', type(err).__name__) from err
    if p.returncode:
        raise UsageUnavailable('git_unavailable', 'unreadable repository or orphan git pointer')
    return p.stdout


def repository(path, deadline, lock_fd=None):
    common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], deadline, lock_fd).strip()
    records = git(path, ['worktree', 'list', '--porcelain', '-z'], deadline, lock_fd).split('\0\0')
    trees = []
    for record in records:
        fields = record.strip('\0').split('\0')
        if fields and fields[0].startswith('worktree '):
            trees.append((fields[0][9:], fields[1:]))
    own = next((fields for root, fields in trees if os.path.realpath(root) == os.path.realpath(path)), None)
    if own is None or any(x.startswith(('locked', 'prunable')) for x in own):
        raise UsageUnavailable('git_kept', 'unregistered, locked or prunable worktree')
    if git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], deadline, lock_fd):
        raise UsageUnavailable('git_kept', 'dirty, untracked or ignored files')
    count = git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], deadline, lock_fd).strip()
    if count != '0':
        raise UsageUnavailable('git_kept', 'unpublished commits')
    linked = os.path.isfile(os.path.join(path, '.git'))
    if not linked:
        # Removing a main checkout also removes every branch, tag, stash and worktree registration.
        if len(trees) != 1 or git(path, ['stash', 'list', '--format=%H'], deadline, lock_fd):
            raise UsageUnavailable('git_kept', 'main checkout has worktrees or stashes')
        if git(path, ['rev-list', '--count', '--all', '--reflog', '--not', '--remotes'], deadline, lock_fd).strip() != '0':
            raise UsageUnavailable('git_kept', 'unpublished local refs')
    return {'path': path, 'common_dir': common, 'parent_repo': trees[0][0], 'linked': linked}


def inspect(path, deadline=None, lock_fd=None):
    """A failed or partial walk never supplies evidence for removal."""
    deadline = min(deadline or float('inf'), time.monotonic() + TREE_SECONDS)
    root = os.lstat(path)
    newest, newest_ctime = root.st_mtime, root.st_ctime
    size, files, nodes, repos = 0, 0, 0, []
    stack = [path]
    while stack:
        if time.monotonic() >= deadline or nodes >= MAX_NODES:
            raise UsageUnavailable('tree_unavailable', 'metadata walk budget exceeded')
        p = stack.pop()
        st = os.lstat(p)
        nodes += 1
        if st.st_uid != os.getuid() or st.st_dev != root.st_dev:
            raise UsageUnavailable('tree_kept', 'different uid or nested mount')
        if stat.S_ISLNK(st.st_mode):
            raise UsageUnavailable('tree_kept', 'symlink')
        newest, newest_ctime = max(newest, st.st_mtime), max(newest_ctime, st.st_ctime)
        size += st.st_blocks * 512
        if os.path.basename(p) == '.git':
            repos.append(os.path.dirname(p))
        if stat.S_ISDIR(st.st_mode):
            names = set()
            with os.scandir(p) as entries:
                for entry in entries:
                    if time.monotonic() >= deadline or nodes + len(stack) >= MAX_NODES:
                        raise UsageUnavailable('tree_unavailable', 'metadata walk budget exceeded')
                    names.add(entry.name)
                    stack.append(entry.path)
            if {'HEAD', 'objects', 'refs'} <= names and os.path.basename(p) != '.git':
                raise UsageUnavailable('git_kept', 'bare repository')
        elif stat.S_ISREG(st.st_mode):
            files += 1
        else:
            raise UsageUnavailable('tree_kept', 'special file')
    repositories = [repository(repo, deadline, lock_fd) for repo in repos]
    # A linked worktree whose common git dir is in the proposed tree cannot outlive deletion of that tree.
    if any(r['linked'] and os.path.commonpath([path, r['common_dir']]) == path for r in repositories):
        raise UsageUnavailable('git_kept', 'parent repository inside candidate')
    return {'newest_mtime': newest, 'newest_ctime': newest_ctime, 'bytes': size, 'files': files,
            'mtime': root.st_mtime, 'ctime': root.st_ctime, 'uid': root.st_uid,
            'device': root.st_dev, 'inode': root.st_ino, 'repos': repositories}
