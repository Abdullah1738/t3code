"""Exercise include boundaries with real rsync, using only synthetic local trees."""
import os
import contextlib
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests._env import isolate_home
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
EXCLUDED_ANCESTORS = tuple(dict.fromkeys(
    prefix + pattern.rstrip("/").replace("*", "fixture")
    for pattern in ssh_sync.SECRET_EXCLUDES + ssh_sync.HEAVY_EXCLUDES
    for prefix in ("", "foo/")
))


def write(root, rel, text="synthetic\n"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=True)


@pytest.fixture(autouse=True)
def home_backend(tmp_path):
    with contextlib.ExitStack() as stack:
        isolate_home(stack, tmp_path)
        yield


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


@pytest.fixture
def unignored_repo(tmp_path, monkeypatch):
    for key in list(os.environ):
        if key.startswith("GIT_"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    root = tmp_path / "unignored"
    root.mkdir()
    git(root, "init", "-q", "--template=")
    return root


@pytest.mark.parametrize("ancestor", EXCLUDED_ANCESTORS)
def test_tracked_excluded_ancestor_refuses_before_box_work(unignored_repo, ancestor):
    root = unignored_repo
    directory = ancestor
    included = f"{directory}/request.txt"
    for rel in (included, f"{directory}/tracked-readme.txt", f"{directory}/unrequested-secret.txt"):
        write(root, rel)
    git(root, "add", f"{directory}/tracked-readme.txt")
    # Real rsync establishes the baseline: opening this directory must not expose its other children.
    before = sent(root)
    assert not any(p.startswith(directory + "/") for p in before)
    with pytest.raises(OffboxError) as refused:
        sent(root, [included])
    assert refused.value.code == 2
    assert repr(included) in str(refused.value)
    assert repr(directory) in str(refused.value)
    assert "can't send only the named path there" in str(refused.value)
    assert "mktemp -d ./.scratch.XXXX" in str(refused.value)
    assert "committed or included file" in str(refused.value)
    assert "inline" not in str(refused.value)
    assert "argv" not in str(refused.value)
    args = cli.build_parser().parse_args(["run", "--include", included, "--", "echo", "ok"])
    with patch.object(runs, "db") as database, patch.object(runs.pool, "acquire") as acquire, \
            patch.object(cli, "log"), patch.object(cli, "say"), \
            patch("offbox_lib.fallback.run_local") as fallback, \
            patch("offbox_lib.fallback.note_infra_failure") as infra:
        assert cli.cmd_run(args, {"repo_root": str(root)}) == 2
    database.assert_not_called()
    acquire.assert_not_called()
    fallback.assert_not_called()
    infra.assert_not_called()


@pytest.mark.parametrize("ancestor", EXCLUDED_ANCESTORS)
@pytest.mark.parametrize("overlap", ("none", "directory-first", "file-first"))
def test_explicit_excluded_directory_still_sends_its_subtree(unignored_repo, ancestor, overlap):
    root = unignored_repo
    directory = ancestor
    requested = {f"{directory}/request.txt", f"{directory}/tracked-readme.txt"}
    for rel in requested | {"foo/unrequested.txt"}:
        write(root, rel)
    git(root, "add", f"{directory}/tracked-readme.txt")
    before = sent(root)
    includes = [directory]
    if overlap == "directory-first":
        includes.append(f"{directory}/request.txt")
    elif overlap == "file-first":
        includes.insert(0, f"{directory}/request.txt")
    after = sent(root, includes)
    assert {p for p in after - before if not p.endswith("/")} == requested


@pytest.mark.parametrize("ancestor", EXCLUDED_ANCESTORS)
def test_untracked_excluded_ancestor_sends_only_named_file(unignored_repo, ancestor):
    root = unignored_repo
    directory = ancestor
    included = f"{directory}/request.txt"
    for rel in (included, f"{directory}/unrequested-secret.txt"):
        write(root, rel)
    before = sent(root)
    after = sent(root, [included])
    assert {p for p in after - before if not p.endswith("/")} == {included}


@pytest.mark.parametrize("template", ssh_sync.SAFE_ENV_TEMPLATES)
def test_tracked_safe_template_directory_preserves_baseline(unignored_repo, template):
    root = unignored_repo
    directory = f"foo/{template}/nested"
    included = f"{directory}/request.txt"
    for rel in (included, f"{directory}/tracked-readme.txt", f"{directory}/normal-sibling.txt"):
        write(root, rel)
    git(root, "add", f"{directory}/tracked-readme.txt")
    assert sent(root, [included]) == sent(root)


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
        assert cmd[0] != ssh_sync.RSYNC or "--dry-run" in cmd, "no transfer may start during inspection"
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
    assert "committed or included file" in str(refused.value)
    assert "inline" not in str(refused.value)
    assert "argv" not in str(refused.value)


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
def test_tracked_file_in_ignored_ancestor_preserved(repo, tracked):
    write(repo, tracked)
    git(repo, "add", "-f", tracked)
    paths = sent(repo, CASES["a"][0])
    # tmp/* leaves tmp itself visible; a direct tracked child is sent in pass 2 in that case.
    assert {p for p in paths if p.startswith("tmp/") and not p.endswith("/")} <= {tracked, "tmp/cards/x/f.tar"}
    assert "tmp/cards/x/f.tar" in paths


@pytest.mark.parametrize("with_git", (False, True))
def test_ignored_tracked_ancestor_accepts_directory_include(repo, with_git):
    tracked = "tmp/cards/tracked.txt"
    write(repo, tracked)
    git(repo, "add", "-f", tracked)
    included = "tmp/cards/x/red-go"
    paths = sent(repo, filters=ssh_sync.push_filters(repo, with_git, [included]))
    assert "tmp/cards/x/red-go/main.go" in paths
    assert "tmp/cards/x/sibling" not in paths
    assert "tmp/other/deep/scratch" not in paths


def test_no_sync_does_not_validate_unused_include(repo):
    args = cli.build_parser().parse_args(["run", "--no-sync", "--include", "tmp/cards/x/f.tar", "--", "echo", "ok"])
    with patch.object(ssh_sync, "push_filters", side_effect=AssertionError("no sync requested")), \
            patch.object(runs, "_run_remote", return_value=0):
        assert runs.run_remote(args, {"repo_root": str(repo)}) == 0


@pytest.mark.parametrize("tracked", (False, True))
def test_file_include_never_walks_path_max_sibling(repo, tracked):
    write(repo, "tmp/card-x/proof.py")
    if tracked:
        write(repo, "tmp/memory/cutover/a.zsh")
        git(repo, "add", "-f", "tmp/memory/cutover/a.zsh")
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
    } | ({"tmp/memory/", "tmp/memory/cutover/", "tmp/memory/cutover/a.zsh"}
         if tracked and "--filter=+ /tmp/memory/cutover/a.zsh" in cmd else set())


@pytest.mark.parametrize("directory_first", (False, True))
def test_whole_ignored_directory_with_redundant_child_include(repo, directory_first):
    write(repo, "tmp/tracked.txt")
    git(repo, "add", "-f", "tmp/tracked.txt")
    includes = ["tmp", "tmp/cards/x/f.tar"] if directory_first else ["tmp/cards/x/f.tar", "tmp"]
    assert sent(repo, includes) == sent(repo, ["tmp"])


@pytest.mark.parametrize("directory_first", (False, True))
def test_parent_include_authorizes_excluded_descendant_with_tracked_files(unignored_repo, directory_first):
    root = unignored_repo
    for rel in ("foo/.aws/request.txt", "foo/.aws/other.txt", "foo/tracked-readme.txt"):
        write(root, rel)
    git(root, "add", "foo/tracked-readme.txt", "foo/.aws/other.txt")
    includes = ["foo", "foo/.aws/request.txt"] if directory_first else ["foo/.aws/request.txt", "foo"]
    assert sent(root, includes) == sent(root, ["foo"])


RSYNC_IGNORE_CASES = (
    (".gitignore", "tmp/*\n", "src/tmp/cards", True),
    (".gitignore", "/tmp/*\n", "src/tmp/cards", False),
    ("src/.gitignore", "tmp/*\n", "src/deep/tmp/cards", True),
    ("src/.gitignore", "/tmp/*\n", "src/tmp/cards", True),
    ("src/.gitignore", "/tmp/*\n", "src/deep/tmp/cards", False),
    (".git/info/exclude", "tmp/*\n", "src/tmp/cards", True),
    (".git/info/exclude", "/tmp/*\n", "src/tmp/cards", False),
    (".gitignore", "**/tmp/*\n", "src/tmp/cards", True),
    (".gitignore", "tmp/\n!tmp/\n", "src/tmp/cards", True),
)


@pytest.mark.parametrize("ignore_file,rule,directory,excluded", RSYNC_IGNORE_CASES)
def test_effective_rsync_ignore_full_push(unignored_repo, ignore_file, rule, directory, excluded):
    root = unignored_repo
    write(root, ignore_file, rule)
    included = f"{directory}/request.txt"
    tracked = f"{directory}/tracked.txt"
    unrequested = f"{directory}/unrequested-secret.txt"
    for rel in (included, tracked, unrequested):
        write(root, rel)
    git(root, "add", "-f", tracked)
    dest = root.parent / "remote"
    real_run = subprocess.run

    def local_transport(cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            cmd = [str(part).removeprefix("testbox:") for part in cmd]
        return real_run(cmd, **kwargs)

    def local_ssh(box, command, input=None, timeout=120, check=False):
        return real_run(["sh", "-c", command], input=input, capture_output=True, timeout=timeout, check=check)

    with patch.object(ssh_sync.subprocess, "run", side_effect=local_transport), \
            patch.object(ssh_sync, "_watch_rsync", side_effect=lambda cmd, timeout, input=None, **kw:
                         local_transport(cmd, capture_output=True, text=True, input=input, timeout=timeout)), \
            patch.object(ssh_sync, "_progress_args", return_value=()), \
            patch.object(ssh_sync, "log"), patch.object(ssh_sync, "ssh", side_effect=local_ssh):
        baseline = ssh_sync.push("testbox", root, str(dest))
        assert (dest / tracked).exists()
        assert (dest / unrequested).exists() is not excluded
        if excluded:
            assert baseline["tracked_ignored"] == 1
        result = ssh_sync.push("testbox", root, str(dest), includes=[included])
        assert baseline["verified"] == result["verified"] == 1
        assert baseline["repaired"] == result["repaired"] == 0
        assert (dest / included).exists()
        assert (dest / tracked).exists()
        assert (dest / unrequested).exists() is not excluded


@pytest.mark.parametrize("failure", ("oserror", "timeout", "rc23", "ignore-read"))
def test_effective_filter_probe_fails_closed_before_allocation(unignored_repo, failure):
    root = unignored_repo
    write(root, "src/tracked.txt")
    write(root, "src/request.txt")
    write(root, ".gitignore", "")
    git(root, "add", "src/tracked.txt")
    args = cli.build_parser().parse_args(["run", "--include", "src/request.txt", "--", "echo", "ok"])
    real_run = subprocess.run
    real_copy = ssh_sync.shutil.copyfile

    def fail(cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            assert "--dry-run" in cmd and not any("testbox:" in str(p) for p in cmd)
            if failure == "oserror":
                raise OSError("synthetic rsync failure")
            if failure == "timeout":
                raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])
            if failure == "rc23":
                return subprocess.CompletedProcess(cmd, 23, b"", b"synthetic rsync failure")
        return real_run(cmd, **kwargs)

    def copy(source, dest):
        if failure == "ignore-read":
            raise PermissionError("synthetic unreadable ignore file")
        return real_copy(source, dest)

    with patch.object(ssh_sync.subprocess, "run", side_effect=fail), \
            patch.object(ssh_sync.shutil, "copyfile", side_effect=copy), \
            patch.object(runs, "db") as database, patch.object(runs.pool, "acquire") as acquire, \
            pytest.raises(OffboxError) as refused:
        runs.run_remote(args, {"repo_root": str(root)})
    assert refused.value.code == 2
    assert "src/request.txt" in str(refused.value)
    assert "couldn't tell what else sits beside it" in str(refused.value)
    database.assert_not_called()
    acquire.assert_not_called()


@pytest.mark.parametrize("name", (
    "line\nname", "carriage\rname", "tab\tname", "backslash\\name",
    "escape\\#012name", "escape\\#134name", "café", "space name",
))
def test_effective_filter_probe_preserves_filename_bytes(unignored_repo, name):
    root = unignored_repo
    directory = f"src/{name}"
    write(root, f"{directory}/tracked.txt")
    write(root, f"{directory}/request.txt")
    git(root, "add", f"{directory}/tracked.txt")
    assert directory in ssh_sync._visible_include_ancestors(root, {directory}, f"{directory}/request.txt")
    assert ssh_sync.push_filters(root, False, [f"{directory}/request.txt"])


def test_tracked_cutover_with_ignored_scratch(repo, request):
    tracked = "tmp/memory/cutover/a.zsh"
    included = "tmp/card-1/run.sh"
    for rel in (tracked, included, "tmp/other/big.txt", "tmp/memory/cutover/untracked.zsh"):
        write(repo, rel)
    git(repo, "add", "-f", tracked)
    paths = sent(repo, [included])
    assert included in paths
    if request.node.callspec.params["repo"] != "tmp/*":
        assert tracked in paths
    assert "tmp/other/big.txt" not in paths
    assert "tmp/memory/cutover/untracked.zsh" not in paths


@pytest.mark.parametrize("count", (ssh_sync.MAX_TRACKED_INCLUDE_FILES, ssh_sync.MAX_TRACKED_INCLUDE_FILES + 1))
def test_ignored_tracked_file_bound(repo, count):
    for n in range(count):
        write(repo, f"tmp/cards/memory/{n}.txt")
    git(repo, "add", "-f", "tmp/cards/memory")
    included = "tmp/cards/x/f.tar"
    if count <= ssh_sync.MAX_TRACKED_INCLUDE_FILES:
        assert included in sent(repo, [included])
    else:
        with pytest.raises(OffboxError) as refused:
            sent(repo, [included])
        assert refused.value.code == 2
        assert f"{count} tracked files" in str(refused.value)
        assert f"limit {ssh_sync.MAX_TRACKED_INCLUDE_FILES}" in str(refused.value)
        assert "mktemp -d ./.scratch.XXXX" in str(refused.value)
        assert "committed or included file" in str(refused.value)
        assert "inline" not in str(refused.value)
        assert "argv" not in str(refused.value)


@pytest.mark.parametrize("name", ("plain", "space name", "bracket[ab]", "star*name", "query?name", "back\\slash"))
def test_tracked_reopen_is_literal_and_skips_protected_paths(repo, name):
    tracked = f"tmp/cards/memory/{name}/a.txt"
    secret = "tmp/cards/memory/.aws/credentials"
    heavy = "tmp/cards/memory/node_modules/package/index.js"
    safe = "tmp/cards/memory/.env.example"
    for rel in (tracked, secret, heavy, safe, f"tmp/cards/memory/{name}/sibling.txt",
                "tmp/cards/memory/bracketa/a.txt", "tmp/cards/memory/starXname/a.txt", "tmp/cards/memory/queryXname/a.txt"):
        write(repo, rel)
    git(repo, "add", "-f", tracked, secret, heavy, safe)
    included = "tmp/cards/x/f.tar"
    paths = sent(repo, [included])
    assert {p for p in paths if not p.endswith("/") and p.startswith("tmp/")} == {included, tracked, safe}


@pytest.fixture
def local_push(monkeypatch):
    real_run = subprocess.run

    def transport(cmd, **kwargs):
        if cmd[0] == ssh_sync.RSYNC:
            cmd = [str(part).removeprefix("testbox:") for part in cmd]
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(ssh_sync.subprocess, "run", transport)
    monkeypatch.setattr(ssh_sync, "_watch_rsync", lambda cmd, timeout, input=None, **kw:
                        transport(cmd, capture_output=True, text=True, input=input, timeout=timeout))
    monkeypatch.setattr(ssh_sync, "_progress_args", lambda binary: ())
    monkeypatch.setattr(ssh_sync, "log", lambda *args: None)
    monkeypatch.setattr(ssh_sync, "ssh", lambda box, command, input=None, timeout=120, check=False:
                        real_run(["sh", "-c", command], input=input, capture_output=True,
                                 timeout=timeout, check=check))


def test_full_push_preserves_tracked_set_and_pull(repo, local_push, monkeypatch):
    tracked = "tmp/memory/cutover/a.zsh"
    included = "tmp/card-1"
    for rel in (tracked, f"{included}/run.sh", "tmp/other/big.txt",
                "tmp/memory/cutover/sibling.zsh", "tmp/memory/.aws/secret", "tmp/memory/node_modules/x"):
        write(repo, rel)
    git(repo, "add", "-f", tracked, "tmp/memory/.aws/secret", "tmp/memory/node_modules/x")
    baseline, dest = repo.parent / "baseline", repo.parent / "remote"
    baseline_stats = ssh_sync.push("testbox", repo, str(baseline))
    write(dest, "tmp/box-only/cache", "keep")
    write(dest, f"{included}/stale.txt", "delete")
    result = ssh_sync.push("testbox", repo, str(dest), includes=[included])
    assert baseline_stats["verified"] == result["verified"] == 6
    assert (dest / "tmp/memory/node_modules/x").exists()
    assert baseline_stats["repaired"] == result["repaired"] == 0
    files = lambda root: {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()}
    assert files(dest) == files(baseline) | {f"{included}/run.sh", "tmp/box-only/cache"}
    write(dest, f"{included}/out.json", '{"ok":true}')
    assert ssh_sync.pull("testbox", str(dest), ".", f"{included}/out.json", repo)["ok"]
    assert (repo / included / "out.json").read_text() == '{"ok":true}'


@pytest.mark.parametrize("with_git", (False, True))
def test_subdir_push_and_pull_use_their_respective_roots(repo, local_push, monkeypatch, with_git):
    tracked, included = "tmp/memory/cutover/a.zsh", "tmp/cards/x/red-go"
    write(repo, tracked)
    git(repo, "add", "-f", tracked)
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base")
    monkeypatch.chdir(repo / "src")
    dest = repo.parent / "remote"
    ssh_sync.push("testbox", repo, str(dest), with_git=with_git, includes=[included])
    assert (dest / included / "main.go").exists()
    assert (dest / tracked).exists()
    assert not (dest / "tmp/cards/x/sibling").exists()
    assert not (dest / "tmp/other").exists()
    write(dest, "src/out.json", '{"subdir":true}')
    assert ssh_sync.pull("testbox", str(dest), "src", "out.json", Path.cwd())["ok"]
    assert (repo / "src/out.json").read_text() == '{"subdir":true}'
    if with_git:
        assert git(dest, "rev-parse", "HEAD").stdout == git(repo, "rev-parse", "HEAD").stdout
    filters = ssh_sync.push_filters(repo, with_git, [included])
    assert "--filter=P /tmp/**" in filters
    assert "--filter=- /.git" in filters


def test_tracked_reopen_fits_macos_argv_limit(repo):
    directory = "tmp/cards/" + "/".join(f"{n:02d}-" + "x" * 90 for n in range(19))
    for n in range(ssh_sync.MAX_TRACKED_INCLUDE_FILES):
        write(repo, f"{directory}/{n}.txt")
    git(repo, "add", "-f", directory)
    included = "tmp/cards/x/f.tar"
    filters = ssh_sync.push_filters(repo, False, [included])
    # Linux's larger ARG_MAX would otherwise hide a regression on the Mac client.
    assert sum(len(os.fsencode(arg)) + 1 for arg in filters) < ssh_sync.MAX_INCLUDE_FILTER_BYTES
    paths = sent(repo, filters=filters)
    assert {p for p in paths if not p.endswith("/") and p.startswith("tmp/")} == {
        included, *(f"{directory}/{n}.txt" for n in range(ssh_sync.MAX_TRACKED_INCLUDE_FILES)),
    }


def test_tracked_symlink_does_not_stat_its_target(repo, local_push, monkeypatch):
    link = repo / "tmp/cards/link"
    link.symlink_to("/inaccessible/target")
    git(repo, "add", "-f", "tmp/cards/link")
    baseline, dest = repo.parent / "baseline", repo.parent / "remote"
    ssh_sync.push("testbox", repo, str(baseline))
    assert (baseline / "tmp/cards/link").is_symlink()
    real_is_dir = Path.is_dir

    def is_dir(path):
        if path == link:
            raise PermissionError("tracked symlink target must not be inspected")
        return real_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", is_dir)
    ssh_sync.push("testbox", repo, str(dest), includes=["tmp/cards/x/f.tar"])
    assert (dest / "tmp/cards/link").is_symlink()
    assert os.readlink(dest / "tmp/cards/link") == "/inaccessible/target"
    assert (dest / "tmp/cards/x/f.tar").exists()


@pytest.mark.parametrize("name", ("card[ab]", "card*", "card?", "back\\slash"))
def test_explicit_include_names_are_literal(repo, name):
    included = f"tmp/{name}/run.sh"
    tracked = f"tmp/{name}/tracked.txt"
    for rel in (included, tracked, f"tmp/{name}/sibling.txt",
                "tmp/carda/unrequested.txt", "tmp/cardb/unrequested.txt", "tmp/backslash/unrequested.txt"):
        write(repo, rel)
    git(repo, "add", "-f", tracked)
    paths = sent(repo, [included])
    assert {p for p in paths if p.startswith("tmp/") and not p.endswith("/")} == {included, tracked}


def test_distinct_deep_tracked_paths_refuse_before_argv_limit(repo):
    for n in range(ssh_sync.MAX_TRACKED_INCLUDE_FILES):
        directory = f"tmp/cards/branch-{n}/" + "/".join("deep-" + "x" * 65 for _ in range(8))
        write(repo, f"{directory}/tracked.txt")
        git(repo, "add", "-f", f"{directory}/tracked.txt")
    with pytest.raises(OffboxError) as refused:
        ssh_sync.push_filters(repo, False, ["tmp/cards/x/f.tar"])
    assert refused.value.code == 2
    assert "include filters need" in str(refused.value)
    assert f"limit {ssh_sync.MAX_INCLUDE_FILTER_BYTES}" in str(refused.value)
    assert "mktemp -d ./.scratch.XXXX" in str(refused.value)
    assert "committed or included file" in str(refused.value)
    assert "inline" not in str(refused.value)
    assert "argv" not in str(refused.value)


@pytest.mark.parametrize("kind", ("include", "tracked"))
@pytest.mark.parametrize("indexed,actual", (
    ("tmp/cards/alias/file.txt", "Tmp/cards/alias/file.txt"),
    ("tmp/cards/café/file.txt", "tmp/cards/cafe\u0301/file.txt"),
    ("tmp/cards/alias/file.txt", "tmp/cards/alias/File.txt"),
    ("tmp/cards/alias/café.txt", "tmp/cards/alias/cafe\u0301.txt"),
))
def test_aliases_refuse_before_transfer(repo, monkeypatch, kind, indexed, actual):
    write(repo, indexed)
    git(repo, "add", "-f", indexed)
    included = indexed if kind == "include" else "tmp/cards/x/f.tar"
    real_disk_path = ssh_sync._disk_path

    def disk_path(root, path, names):
        # Linux has no APFS case/NFC aliases; model the resolver's actual disk spelling there too.
        return actual if path == indexed else real_disk_path(root, path, names)

    monkeypatch.setattr(ssh_sync, "_disk_path", disk_path)
    with patch.object(ssh_sync, "_rsync") as transfer, pytest.raises(OffboxError) as refused:
        ssh_sync.push("testbox", repo, "unused", includes=[included])
    transfer.assert_not_called()
    assert refused.value.code == 2
    assert "disk spelling" in str(refused.value)
    assert repr(actual) in str(refused.value)
    assert "mktemp -d ./.scratch.XXXX" in str(refused.value)
    assert "committed or included file" in str(refused.value)
    assert "inline" not in str(refused.value)
