"""Exercise include boundaries with real rsync, using only synthetic local trees."""
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import cli, runs, ssh_sync
from offbox_lib.common import OffboxError


IGNORE_RULES = ("tmp/", "/tmp/", "tmp/*", "info/exclude")
CASES = {
    "a": (["tmp/cards/x/f.tar"], {
        "tmp/", "tmp/cards/", "tmp/cards/x/", "tmp/cards/x/f.tar",
    }),
    "b": (["tmp/cards/x/red-go/"], {
        "tmp/", "tmp/cards/", "tmp/cards/x/", "tmp/cards/x/red-go/",
        "tmp/cards/x/red-go/main.go", "tmp/cards/x/red-go/pkg/", "tmp/cards/x/red-go/pkg/lib.go",
    }),
    "b2": (["tmp/owner-answer"], {
        "tmp/", "tmp/owner-answer/", "tmp/owner-answer/setup.sh",
        "tmp/owner-answer/setup/", "tmp/owner-answer/setup/step.sh",
    }),
    "c": (["tmp/cards/x/f.tar", "tmp/cards/y/b.sh"], {
        "tmp/", "tmp/cards/", "tmp/cards/x/", "tmp/cards/x/f.tar", "tmp/cards/y/", "tmp/cards/y/b.sh",
    }),
}


def write(root, rel, text="synthetic\n"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=True)


@pytest.fixture(params=IGNORE_RULES)
def repo(tmp_path, monkeypatch, request):
    for key in list(os.environ):
        if key.startswith("GIT_"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    root = tmp_path / "src"
    root.mkdir()
    git(root, "init", "-q", "--template=")
    rule = request.param
    write(root, ".gitignore", ("" if rule == "info/exclude" else rule + "\n") + "*.pem\n")
    if rule == "info/exclude":
        write(root, ".git/info/exclude", "tmp/\n")
    for rel in ("src/main.py", "test/readme.txt", "test/certs/readme.txt"):
        write(root, rel)
    git(root, "add", ".")
    for rel in (
        "tmp/cards/x/f.tar", "tmp/cards/x/sibling", "tmp/cards/x/red-go/main.go",
        "tmp/cards/x/red-go/pkg/lib.go", "tmp/cards/y/b.sh", "tmp/cards/z/unasked",
        "tmp/other/deep/scratch", "tmp/cards/x/gnupg/private-keys-v1.d/key",
        "tmp/wt-x/.git", "tmp/wt-x/deep/deeper/scratch",
        "tmp/owner-answer/setup.sh", "tmp/owner-answer/setup/step.sh",
        "tmp/m0-a/deep/a", "tmp/m0-a/deep/more/b", "tmp/m0-a/other/c",
        "tmp/m0-b/deep/a", "tmp/m0-b/deep/more/b", "tmp/m0-b/other/c",
        "tmp/memory/deep/a", "tmp/memory/deep/more/b", "tmp/memory/other/c",
        "test/certs/x.pem",
    ):
        write(root, rel)
    return root


def sent(root, includes=None, *, filters=None, dest=None, dry_run=True, delete=False):
    dest = dest or root.parent / "dest"
    dest.mkdir(exist_ok=True)
    cmd = [ssh_sync.RSYNC, "-a", "--out-format=%n"]
    if dry_run:
        cmd.append("--dry-run")
    if delete:
        cmd.append("--delete")
    cmd += filters if filters is not None else ssh_sync.push_filters(root, False, includes)
    result = subprocess.run(cmd + [f"{root}/", f"{dest}/"], capture_output=True, text=True, check=True)
    return set(result.stdout.splitlines()) - {"./"}


@pytest.mark.parametrize("case", CASES)
def test_only_named_paths_leave_ignored_tree(repo, case):
    includes, expected = CASES[case]
    paths = sent(repo, includes)
    assert {p for p in paths if p.startswith("tmp/")} == expected


def test_tracked_siblings_of_ignored_file_still_sent(repo):
    paths = sent(repo, ["test/certs/x.pem"])
    assert {p for p in paths if p.startswith("test/")} == {
        "test/", "test/readme.txt", "test/certs/", "test/certs/readme.txt", "test/certs/x.pem",
    }


def test_sources_outside_include_are_unchanged(repo):
    before = sent(repo)
    after = sent(repo, CASES["c"][0])
    assert {p for p in before if not p.startswith("tmp/")} == {
        p for p in after if not p.startswith("tmp/")
    }
    assert "src/main.py" in before


@pytest.mark.parametrize("command", ("ls-files", "check-ignore", "tracked-check-ignore"))
@pytest.mark.parametrize("failure", ("oserror", "timeout", "rc128"))
def test_git_inspection_failure_refuses_before_rsync(repo, command, failure):
    if command == "tracked-check-ignore":
        write(repo, "tmp/cards/tracked.txt")
        git(repo, "add", "-f", "tmp/cards/tracked.txt")
    real_run = subprocess.run

    def fail(cmd, **kwargs):
        assert cmd[0] != ssh_sync.RSYNC, "no transfer may start after an inspection failure"
        if cmd[0] == "git" and (command in cmd or command == "tracked-check-ignore" and "--no-index" in cmd):
            if failure == "oserror":
                raise OSError("synthetic git failure")
            if failure == "timeout":
                raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])
            return subprocess.CompletedProcess(cmd, 128, b"", b"synthetic git failure")
        return real_run(cmd, **kwargs)

    with patch.object(ssh_sync.subprocess, "run", side_effect=fail), \
            pytest.raises(OffboxError) as refused:
        ssh_sync.push("testbox", repo, "unused", includes=CASES["a"][0])
    assert refused.value.code == 2
    assert "tmp/cards/x/f.tar" in str(refused.value)
    assert "couldn't tell what else sits beside it" in str(refused.value)
    assert "won't send it" in str(refused.value)


def test_ancestor_inspection_is_one_batched_query(repo):
    real_run = subprocess.run
    queries = []

    def record(cmd, **kwargs):
        if cmd[0] == "git" and "ls-files" in cmd:
            queries.append(cmd)
        return real_run(cmd, **kwargs)

    with patch.object(ssh_sync.subprocess, "run", side_effect=record):
        paths = sent(repo, CASES["c"][0])
    assert {p for p in paths if p.startswith("tmp/")} == CASES["c"][1]
    assert len(queries) == 1
    assert queries[0][queries[0].index("--") + 1:] == ["tmp", "tmp/cards", "tmp/cards/x", "tmp/cards/y"]


def test_refusal_reaches_cli_as_usage_error_without_fallback(repo):
    real_run = subprocess.run

    def fail(cmd, **kwargs):
        if cmd[0] == "git" and "ls-files" in cmd:
            return subprocess.CompletedProcess(cmd, 128, b"", b"synthetic git failure")
        return real_run(cmd, **kwargs)

    args = cli.build_parser().parse_args(["run", "--include", "tmp/cards/x/f.tar", "--", "echo", "ok"])
    with patch.object(ssh_sync.subprocess, "run", side_effect=fail), \
            patch("offbox_lib.localfirst.decide", return_value="test"), \
            patch.object(runs.pool, "acquire") as acquire, \
            patch.object(cli, "log"), patch.object(cli, "say"), \
            patch("offbox_lib.fallback.run_local") as fallback, \
            patch("offbox_lib.fallback.note_infra_failure") as infra:
        assert cli.cmd_run(args, {"repo_root": str(repo)}) == 2
    acquire.assert_not_called()
    fallback.assert_not_called()
    infra.assert_not_called()


@pytest.mark.parametrize("rel", (
    "foo/.gnupg/x", "foo/gnupg/x", "foo/private-keys-v1.d/x", "a.keystore", "a.kdbx",
))
def test_secret_names_require_explicit_include(repo, rel):
    write(repo, rel)
    write(repo, "public.asc")
    assert rel not in sent(repo)
    assert rel in sent(repo, [rel])
    assert "public.asc" in sent(repo)


def test_delete_keeps_box_only_files_under_ignored_top(repo):
    dest = repo.parent / "dest"
    write(dest, "tmp/box-only/deep/cache", "keep\n")
    write(dest, "tmp/cards/x/red-go/stale.go", "delete\n")
    sent(repo, CASES["b"][0], dest=dest, dry_run=False, delete=True)
    assert (dest / "tmp/box-only/deep/cache").read_text() == "keep\n"
    assert (dest / "tmp/cards/x/red-go/main.go").exists()
    assert not (dest / "tmp/cards/x/red-go/stale.go").exists()


@pytest.mark.parametrize("case", CASES)
def test_non_git_roots_guard_every_opened_ancestor(tmp_path, case):
    root = tmp_path / "plain"
    for rel in ("tmp/cards/x/f.tar", "tmp/cards/x/sibling", "tmp/cards/y/b.sh",
                "tmp/cards/x/red-go/main.go", "tmp/cards/x/red-go/pkg/lib.go",
                "tmp/owner-answer/setup.sh", "tmp/owner-answer/setup/step.sh", "tmp/other/deep/file",
                "other/normal.txt"):
        write(root, rel)
    paths = sent(root, CASES[case][0])
    assert {p for p in paths if p.startswith("tmp/")} == CASES[case][1]
    assert "other/normal.txt" in paths


@pytest.mark.parametrize("tracked", ("tmp/tracked.txt", "tmp/cards/tracked.txt", "tmp/cards/x/tracked.txt"))
def test_tracked_file_in_ignored_ancestor_refuses_before_box_work(repo, tracked, request):
    rule = request.node.callspec.params["repo"]
    write(repo, tracked)
    git(repo, "add", "-f", tracked)
    if rule == "tmp/*" and tracked == "tmp/tracked.txt":
        paths = sent(repo, CASES["a"][0])
        assert {p for p in paths if p.startswith("tmp/")} == CASES["a"][1]
        return
    top = "tmp/cards" if rule == "tmp/*" else "tmp"
    includes = CASES["a"][0]
    with patch.object(ssh_sync, "_rsync") as transfer, pytest.raises(OffboxError) as refused:
        ssh_sync.push("testbox", repo, "unused", includes=includes)
    transfer.assert_not_called()
    assert refused.value.code == 2
    assert repr(includes[0]) in str(refused.value)
    assert repr(top) in str(refused.value)
    assert "can't send only the named path there" in str(refused.value)
    assert "argv" in str(refused.value) and "--step" in str(refused.value)
    assert "move it out of the ignored directory" in str(refused.value)
    args = cli.build_parser().parse_args(["run", "--include", includes[0], "--", "echo", "ok"])
    with patch("offbox_lib.localfirst.decide", return_value="test"), \
            patch.object(runs, "db") as database, patch.object(runs.pool, "acquire") as acquire, \
            patch.object(cli, "log"), patch.object(cli, "say") as say, \
            patch("offbox_lib.fallback.run_local") as fallback, \
            patch("offbox_lib.fallback.note_infra_failure") as infra:
        assert cli.cmd_run(args, {"repo_root": str(repo)}) == 2
    database.assert_not_called()
    acquire.assert_not_called()
    fallback.assert_not_called()
    infra.assert_not_called()
    assert str(refused.value) in say.call_args.args[0]


@pytest.mark.parametrize("with_git", (False, True))
def test_ignored_tracked_ancestor_refuses_directory_include(repo, with_git):
    write(repo, "tmp/cards/tracked.txt")
    git(repo, "add", "-f", "tmp/cards/tracked.txt")
    args = cli.build_parser().parse_args(["run", *(["--git"] if with_git else []),
                                         "--include", "tmp/cards/x/red-go", "--", "echo", "ok"])
    with patch.object(runs, "db") as database, patch.object(runs.pool, "acquire") as acquire, \
            pytest.raises(OffboxError) as refused:
        runs.run_remote(args, {"repo_root": str(repo)})
    assert refused.value.code == 2
    assert "tmp/cards/x/red-go" in str(refused.value)
    database.assert_not_called()
    acquire.assert_not_called()


def test_no_sync_does_not_validate_unused_include(repo):
    args = cli.build_parser().parse_args(["run", "--no-sync", "--include", "tmp/cards/x/f.tar", "--", "echo", "ok"])
    with patch.object(ssh_sync, "push_filters", side_effect=AssertionError("no sync requested")), \
            patch.object(runs, "_run_remote", return_value=0):
        assert runs.run_remote(args, {"repo_root": str(repo)}) == 0


def test_file_include_never_walks_path_max_sibling(repo):
    write(repo, "tmp/card-x/proof.py")
    sibling = repo / "tmp/card-y"
    sibling.mkdir()
    # Relative mkdir/chdir reaches beyond PATH_MAX without constructing an invalid absolute pathname.
    subprocess.run([sys.executable, "-c", """
import os
from pathlib import Path
for _ in range(40):
    name = 'implementation-evidence-' + 'x' * 100
    os.mkdir(name)
    os.chdir(name)
Path('scratch.txt').write_text('synthetic')
"""], cwd=sibling, check=True)
    dest = repo.parent / "dest"
    dest.mkdir()
    cmd = [ssh_sync.RSYNC, "-a", "--dry-run", "--out-format=%n"]
    cmd += ssh_sync.push_filters(repo, False, ["tmp/card-x/proof.py"])
    result = subprocess.run(cmd + [f"{repo}/", f"{dest}/"], capture_output=True, text=True,
                            check=True, timeout=10)
    assert "File name too long" not in result.stderr
    assert {p for p in result.stdout.splitlines() if p.startswith("tmp/")} == {
        "tmp/", "tmp/card-x/", "tmp/card-x/proof.py",
    }
