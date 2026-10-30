"""Portable, read-only Git history export; never copy a checkout's private git-dir."""

from __future__ import annotations

from contextlib import contextmanager
import os
from pathlib import Path
import signal
import subprocess
import tempfile

from .common import OffboxError, say


def _git_env() -> dict[str, str]:
    # Do not let a caller's index/object-dir override escape this checkout. In
    # particular, object traversal must not fetch or honor local history rewrites.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1",
               GIT_NO_LAZY_FETCH="1", GIT_GRAFT_FILE=os.devnull)
    return env


def _git(root: Path, *args: str, input: str | None = None, stdin=None) -> str:
    try:
        p = subprocess.run(["git", "-C", str(root), *args], input=input,
                           stdin=stdin, capture_output=True, text=True, env=_git_env(), timeout=3600)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise OffboxError(f"cannot prepare --git history ({type(e).__name__})", code=2) from e
    if p.returncode:
        raise OffboxError(f"cannot prepare --git history: git {args[0]} failed ({p.returncode}); "
                          "a committed HEAD and locally available history are required", code=2)
    return p.stdout.strip()


def _is_partial_clone(root: Path) -> bool:
    # `git config --get-regexp` exits 1 when nothing matches, so it can't go through _git().
    try:
        p = subprocess.run(["git", "-C", str(root), "config", "--get-regexp",
                            r"^(extensions\.partialclone|remote\..*\.promisor)$"],
                           capture_output=True, text=True, env=_git_env(), timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise OffboxError(f"cannot prepare --git history ({type(e).__name__})", code=2) from e
    for line in p.stdout.splitlines():
        key, _, value = line.partition(" ")
        if key.endswith(".promisor") and value.strip().lower() not in ("true", "yes", "on", "1"):
            continue
        if value.strip():
            return True
    return False


def _missing(root: Path, revisions: list[str], *, history: bool = True) -> int:
    # _git_env() disables lazy fetching, so this only reports what is missing; it never fetches.
    out = _git(root, "rev-list", "--objects", "--no-object-names", "--missing=print", "--stdin",
               *([] if history else ["--no-walk"]), input="\n".join(revisions) + "\n")
    return sum(1 for line in out.splitlines() if line.startswith("?"))


def _pack_objects(root: Path, dest: Path, revisions: str, revs: bool = True) -> None:
    # A named pack makes Git create a temporary file in the SOURCE object dir,
    # then rename it to the destination (which may be on another filesystem).
    # Stream instead: index-pack performs every object write in the destination.
    # revs=False takes an exact object list instead of revisions to walk.
    try:
        with tempfile.TemporaryFile(dir=dest) as revfile:
            revfile.write(revisions.encode())
            revfile.seek(0)
            with subprocess.Popen(
                ["git", "-C", str(root), "pack-objects", "--stdout", *(["--revs"] if revs else []),
                 "--no-reuse-delta", "--threads=1"],
                stdin=revfile, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_git_env(),
            ) as producer:
                try:
                    index_error = None
                    try:
                        _git(dest, "index-pack", "--stdin", "--threads=1", stdin=producer.stdout)
                    except OffboxError as e:
                        index_error = e
                    finally:
                        # Release our pipe reader so an early index-pack failure
                        # cannot leave pack-objects blocked while we wait for it.
                        producer.stdout.close()
                    code = producer.wait(timeout=3600)
                    if code and (index_error is None or code != -signal.SIGPIPE):
                        # A producer failure leaves an incomplete stream, so the
                        # resulting index-pack error is only a downstream symptom.
                        raise OffboxError(f"cannot prepare --git history: git pack-objects failed ({code}); "
                                          "a committed HEAD and locally available history are required; "
                                          "partial clones must contain all reachable objects "
                                          "(--git never fetches)", code=2) from index_error
                    if index_error is not None:
                        raise index_error
                finally:
                    if producer.poll() is None:
                        producer.kill()
    except (OSError, subprocess.TimeoutExpired) as e:
        raise OffboxError(f"cannot prepare --git history ({type(e).__name__})", code=2) from e


def _head(root: Path) -> tuple[str, str]:
    return (_git(root, "rev-parse", "--verify", "HEAD^{commit}"),
            _git(root, "rev-parse", "--symbolic-full-name", "HEAD"))


@contextmanager
def snapshot(root: Path):
    """Yield an independent git-dir with exact HEAD, its ancestors and ancestor refs.

    Only reachable history is packed, not other worktrees, dangling objects,
    stashes, hooks, reflogs, config/credentials or local index contents. The
    exported index starts at HEAD; working files are synced separately as usual.
    A partial clone whose history is not all local exports HEAD alone, shallow.
    """
    head, symbolic = _head(root)
    object_format = _git(root, "rev-parse", "--show-object-format")
    rows = _git(root, "for-each-ref", f"--merged={head}", "--format=%(objectname) %(refname)",
                "refs/heads/", "refs/remotes/", "refs/tags/")
    refs = dict(line.split(" ", 1)[::-1] for line in rows.splitlines())
    if symbolic.startswith("refs/heads/"):
        refs[symbolic] = head
    revisions = sorted({head, *refs.values()})

    # Only a partial clone may lack history on purpose; anywhere else a missing
    # object is damage, and the pack failure below reports it.
    missing = _missing(root, revisions) if _is_partial_clone(root) else 0
    if missing:
        if _missing(root, [head], history=False):
            raise OffboxError("cannot send --git history: this checkout is a partial clone and some of HEAD's own "
                              "files are not local (--git never fetches); run without --git", code=2)
        say(f"--git: {root.name} is a partial clone missing {missing} older objects; sending HEAD only "
            "(a one-commit shallow .git). For full history use a full clone.")
        refs = {ref: oid for ref, oid in refs.items() if oid == head}

    with tempfile.TemporaryDirectory(prefix="offbox-git-") as tmp:
        dest = Path(tmp)
        _git(dest, "init", "-q", "--template=", f"--object-format={object_format}")
        gitdir = dest / ".git"
        gitdir.chmod(0o700)
        # A full pack resolves alternates and needs no path back to the source.
        if missing:
            objects = _git(root, "rev-list", "--objects", "--no-object-names", "--no-walk", head)
            _pack_objects(root, dest, objects + "\n", revs=False)
        else:
            _pack_objects(root, dest, "\n".join(revisions) + "\n")

        shallow = Path(_git(root, "rev-parse", "--path-format=absolute", "--git-path", "shallow"))
        if missing:
            (gitdir / "shallow").write_text(head + "\n")
        elif shallow.is_file():
            reachable = set(_git(root, "rev-list", head).splitlines())
            boundary = [oid for oid in shallow.read_text().splitlines() if oid in reachable]
            if boundary:
                (gitdir / "shallow").write_text("\n".join(boundary) + "\n")
        for ref, oid in refs.items():
            path = gitdir / ref
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(oid + "\n")
        (gitdir / "HEAD").write_text((f"ref: {symbolic}" if symbolic.startswith("refs/heads/") else head) + "\n")
        _git(dest, "read-tree", "HEAD")
        if _head(root) != (head, symbolic):
            raise OffboxError("HEAD changed while preparing --git history; retry after the checkout is stable", code=2)
        yield gitdir
        if _head(root) != (head, symbolic):
            raise OffboxError("HEAD changed while syncing --git history; retry after the checkout is stable", code=2)
