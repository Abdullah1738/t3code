"""Leases: bounded repository pools, create / fork / resume / resize, plus ttl policy."""

from __future__ import annotations

import contextlib
import os
import re
import shlex
import subprocess
import time
from pathlib import Path

from . import api, capacity, ssh_sync
from .common import (SIZES, BOX_WEDGED_NOTE, CAP_PATH, DEAD_MOUNT_NOTE, EXIT_BUSY, EXIT_CAP, IDLE_STOP_S, RUN_TTL_S, TEMPLATES_DIR, TOO_BIG_NOTE, OffboxError, db, event,
                     file_lock, iso, log, month_key, new_id, now, read_json, say)
from .identity import remote_dir_for

# Direct (non-pool) callers only: pool callers skip an archiving box instead of waiting under the pool lock.
ARCHIVING_WAIT_S = 120
RESUME_STUCK_S = 90
SHRINK_REFUSED = (400, 409, 422)  # boat's answers to "data does not fit the smaller size"
SHRINK_TEXT = re.compile(r"\b(disk|fits?|shrink\w*|smaller|too small|size)\b", re.I)  # ...and what that answer talks about
DISK_TOO_BIG = re.compile(r"needs\s+([\d.]+)\s*GiB of disk but the largest '([\w-]+)' machine holds\s+([\d.]+)\s*GiB",
                          re.I)  # boat's 409 for a stopped box whose disk outgrew every machine of its size
# Template sizes for new boxes and resumes. The harness template is large too (2026-11-01): xlarge is picked per run
# by auto_size for container stacks; 0 of ~2,300 harness-template runs in 13-31 Oct hit an OOM.
DEFAULT_SIZE = {"crpko-harness": "large", "crpko-go": "large", "crpko-node": "large", "generic": "default"}


def _rank(size: str | None) -> int:
    return SIZES.index(size) if size in SIZES else SIZES.index("default")


def natural_size(con, row) -> str:
    """Size a stopped pooled box resumes at when a run asks for nothing bigger.

    Its template's size (generic stays default); bases and fresh boxes never go below large, which is what
    ordinary Go/Python runs got before boxes were shrunk."""
    src = row["source"] or ""
    if src in ("template:generic", "recipe:generic"):
        return "default"
    size = "large"
    if src.startswith("base:"):
        b = con.execute("SELECT size FROM bases WHERE name=?", (src[5:],)).fetchone()
        size = (b and b["size"]) or "large"
    elif src.startswith(("template:", "recipe:")):
        size = DEFAULT_SIZE.get(src.split(":", 1)[1], "large")
    return size if _rank(size) >= _rank("large") else "large"


DOCKER_CMD = re.compile(r"docker|podman|compose|testcontainers|localstack", re.I)
DOCKER_MANIFEST = re.compile(r"testcontainers|dockertest")


def uses_docker(cmd: str, repo_root: str) -> bool:
    """A remote run that (probably) starts containers: Docker in the command, or a repo whose tests pull in
    testcontainers/dockertest (Go, Python or Node manifests)."""
    if DOCKER_CMD.search(cmd or ""):
        return True
    for name in ("go.mod", "pyproject.toml", "package.json", "requirements.txt", "requirements-dev.txt"):
        try:
            with open(os.path.join(repo_root, name), errors="replace") as f:
                if DOCKER_MANIFEST.search(f.read(400_000)):
                    return True
        except OSError:
            continue
    return False


TYPECHECK_CMD = re.compile(r"\btsc(-rs)?\b|\btypecheck\b")


def typecheck_size(cmd: str, repo_root: str, size: str | None) -> str | None:
    """Type-check runs in JS/TS repos get xlarge: large boxes get OOM-killed (exit 137) on the Robob server
    typecheck. An explicit size always wins; only repos with a package.json are affected."""
    if size:
        return size
    if TYPECHECK_CMD.search(cmd or "") and os.path.isfile(os.path.join(repo_root or "", "package.json")):
        return "xlarge"
    return None


# A run that starts a big container stack: compose/LocalStack in the command, the harness repo itself, or a whole
# suite (`./...`, a bare pytest/make test) in a repo whose tests pull in testcontainers. Single containers and
# narrow tests fit large (16 GB; measured per-job peak ~12 GB, 13-31 Oct).
BIG_STACK_CMD = re.compile(r"\bcompose\b|docker-compose|localstack|testcontainers")
WHOLE_SUITE_CMD = re.compile(r"\./\.\.\.|\bmake\s+test|\bpytest(?![^;&|]*::)")
# An exit 137 bumps the next runs of the same kind of command for a few days. It used to put the whole repo on
# xlarge for 14 days: 2 OOMs in backoffice-core sent 1,391 ordinary runs to xlarge (13 Oct - 5 Nov).
OOM_WINDOW_S = 3 * 86400
# command_kinds() reads the job out of each ;/&&/||/| part of a command: shell setup statements are dropped, then
# env assignments, wrappers (timeout, nice, uv run, npx, go, ...) and their options are skipped.
_SETUP = {"set", "export", "cd", "source", ".", "trap", "unset", "local", "shopt", "ulimit", "umask", "alias",
          "pushd", "popd", "declare", "readonly"}
# Wrapper word -> its options that take a value (skipped with the value). A wrapper's first other word that is a
# number is its own argument too (timeout 1800, nice 10).
_WRAPPERS = {
    "env": {"-u", "--unset", "-C", "--chdir", "-S"}, "time": {"-f", "-o"}, "command": set(), "sudo": {"-u", "-g"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"}, "nice": {"-n", "--adjustment"},
    "taskpolicy": {"-c", "-t", "-l", "-p"}, "stdbuf": {"-i", "-o", "-e"}, "xvfb-run": {"-s", "-n", "-e", "-f"},
    "bash": set(), "sh": set(), "zsh": set(),
    "uv": {"--with", "--python", "-p", "--project", "--directory", "--group", "--extra", "--package", "--env-file",
           "--with-requirements", "--index", "--index-url", "--from"},
    "run": {"--with", "--python", "-p", "--project", "--directory", "--group", "--extra", "--package", "--env-file",
            "--with-requirements", "--from"},
    "npx": {"-p", "--package"}, "pnpm": {"-C", "--dir", "--filter", "-F"},
    "yarn": {"--cwd"}, "npm": {"--prefix", "-w", "--workspace"}, "bunx": {"-p", "--package"},
    "exec": set(), "dlx": set(), "poetry": {"-C", "--directory"}, "pipenv": set(), "python": set(),
    "python3": set(), "-m": set(), "go": {"-C"}, "vp": set(), "corepack": set(),
}
_KIND_WORD = re.compile(r"[A-Za-z][\w.+-]*")
_DURATION = re.compile(r"\d+(\.\d+)?[smhd]?")  # timeout 1800 / 30m, nice 10
# Plumbing and output filters say nothing about how much memory the job needs.
_KIND_NOISE = {"echo", "printf", "exit", "true", "false", "[", "[[", "grep", "rg", "head", "tail", "sed", "awk",
               "sort", "uniq", "wc", "tee", "cat", "ls", "mkdir", "rm", "cp", "mv", "do", "done", "then", "fi",
               "if", "for", "while", "until", "wait", "sleep", "date", "pwd", "cut", "tr", "xargs", "git", "return",
               "case", "esac", "else", "elif", "nvm", "which", "type", "chmod", "touch", "ln", "find", "jq"}
_KIND_ALIAS = {"i": "install", "ci": "install", "add": "install", "sync": "install"}


def _part_kind(words: list[str]) -> str | None:
    i = 0
    while i < len(words):
        if words[i].rsplit("/", 1)[-1] in _SETUP:  # a setup statement, even behind `bash -c`
            return None
        w = words[i]
        base = w.rsplit("/", 1)[-1]
        if not base.startswith("@"):
            base = base.split("@", 1)[0]  # npx vitest@3 / pnpm@11 -> vitest / pnpm
        if "=" in w.split("/")[0] and not w.startswith("-"):  # VAR=value
            i += 1
            continue
        if base in _WRAPPERS:
            opts = _WRAPPERS[base]
            i += 1
            while i < len(words) and (words[i].startswith("-") or _DURATION.fullmatch(words[i])) \
                    and words[i] not in ("-c", "--call", "-lc"):
                opt = words[i].split("=", 1)[0]
                i += 2 if (opt in opts and "=" not in words[i]) else 1
            continue
        if base.startswith("-") or base.startswith("@"):  # incl. `-c`: what follows is the command
            i += 1
            continue
        m = _KIND_WORD.match(base)
        if not m or m.group(0).lower() in _KIND_NOISE:
            return None
        kind = _KIND_ALIAS.get(m.group(0).lower(), m.group(0).lower())
        if kind == "make":  # make's target is the job: `make test` and `make type` are different kinds
            target, j = "", i + 1
            while j < len(words):
                x = words[j]
                if x in ("-C", "-f", "-I", "-j", "-l", "-o", "-W", "--directory", "--file", "--include-dir"):
                    j += 2 if not (x == "-j" and (j + 1 >= len(words) or not words[j + 1].isdigit())) else 1
                    continue
                if x.startswith("-") or "=" in x:
                    j += 1
                    continue
                target = x
                break
            kind = f"make {target}".strip()
        return kind
    return None


def command_kinds(cmd: str) -> set[str]:
    """Job kinds in a command: pytest, test (go/vp/npm test), vitest, tsc, typecheck, make <target>, install..."""
    kinds = set()
    for part in re.split(r"&&|\|\||;|\n|\|", cmd or ""):
        kind = _part_kind(part.replace("'", " ").replace('"', " ").replace("(", " ").replace(")", " ").split())
        if kind:
            kinds.add(kind)
    # A dependency install comes before nearly every job, so it names the job only when it is all there is.
    return (kinds - {"install"}) or kinds


def oom_recent(con, repo_key: str, cmd: str = "", within: int = OOM_WINDOW_S) -> str | None:
    """Size to bump this run to: one above the size whose run of the same kind was killed for memory (exit 137)
    in this repo lately. None when nothing of this kind was."""
    kinds = command_kinds(cmd)
    if not kinds:
        return None
    best = None
    for size, oom_cmd in con.execute(
            "SELECT COALESCE(r.size,'large'), r.cmd FROM runs r JOIN leases l USING(box_id) WHERE l.repo_key=? "
            "AND r.exit_code=137 AND COALESCE(r.size,'') != 'xlarge' AND r.start_at>?",
            (repo_key, now() - within)).fetchall():
        if kinds & command_kinds(oom_cmd or ""):
            up = SIZES[min(SIZES.index(size if size in SIZES else "large") + 1, len(SIZES) - 1)]
            if _rank(up) < _rank("large"):
                up = "large"
            if best is None or _rank(up) > _rank(best):
                best = up
    return best


# Test runners whose suite may start containers in a testcontainers/compose repo (explicit xlarge kept for them).
SUITE_RUNNER_CMD = re.compile(r"\bmake\s+(-\S+\s+(\S+\s+)?)*\S*(test|integration|e2e)|"
                              r"\b(vitest|jest|mocha|ava|playwright)\b|"
                              r"\b(npm|pnpm|yarn|bun)\s+(run\s+)?test|\bvp\s+(run\s+)?test|\bnode\s+--test|"
                              r"\bgo\s+test\b|\bpytest\b|\bcargo\s+test|\bgradlew?\b.*\b(test|check|integration)")
# One named test or test file.
NARROW_TEST_CMD = re.compile(r"\s-run[\s=]|::|--tests\s|--test-name-pattern|\s-t\s|\.(test|spec)\.[jt]sx?\b|"
                             r"\btest_\w+\.py\b|\w+_test\.py\b")
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")


def xlarge_needed(cmd: str, repo_root: str, repo_key: str) -> bool:
    """An explicit --size xlarge is kept for: anything that runs Docker, a type-check, the harness repo, or a whole
    suite in a repo with testcontainers or a compose file (`make test-integration` brings up its stack)."""
    if typecheck_size(cmd, repo_root, None) or DOCKER_CMD.search(cmd or "") or "harness" in repo_key:
        return True
    if not WHOLE_SUITE_CMD.search(cmd or "") and not SUITE_RUNNER_CMD.search(cmd or ""):
        return False
    if NARROW_TEST_CMD.search(cmd or "") and not re.search(r"\./\.\.\.|\bmake\s+test", cmd or ""):
        # One test or file (WHOLE_SUITE_CMD reads any bare pytest as a suite, so it can't veto this): the OOM bump or
        # OFFBOX_ALLOW_XLARGE covers the rare big one.
        return False
    return uses_docker("", repo_root) or any(os.path.isfile(os.path.join(repo_root, n)) for n in COMPOSE_FILES)


def auto_size(con, cmd: str, me: dict, size: str | None) -> tuple[str | None, str]:
    """Size for a run -> (size or None, reason). None means the template/base size (large for Go/Node/harness,
    default for generic).

    An explicit size wins, except --size xlarge on a command no xlarge rule covers and no same-kind OOM backs: that
    runs on large. 1,054 hand-picked xlarge runs (13 Oct - 5 Nov) were mostly uv sync + pytest and narrow go tests.
    OFFBOX_ALLOW_XLARGE=1 keeps an explicit xlarge."""
    rk = me.get("repo_key") or ""
    root = me.get("repo_root") or ""
    if size == "xlarge" and os.environ.get("OFFBOX_ALLOW_XLARGE") != "1" and not xlarge_needed(cmd, root, rk) \
            and oom_recent(con, rk, cmd) != "xlarge":
        return "large", ("--size xlarge isn't needed for this command (no container stack, type-check or recent "
                         "out-of-memory kill of this kind): running it on large. If it is killed for memory (exit "
                         "137), the next run of this kind goes to xlarge by itself; OFFBOX_ALLOW_XLARGE=1 forces xlarge")
    if size:
        return size, ""
    tc = typecheck_size(cmd, root, None)
    if tc:
        return tc, "typecheck run: using an xlarge box (tsc ran out of memory on large); pass --size to override"
    if BIG_STACK_CMD.search(cmd or "") or "harness" in rk:
        return "xlarge", "container stack run: using an xlarge box; pass --size to override"
    if WHOLE_SUITE_CMD.search(cmd or "") and uses_docker("", root):
        return "xlarge", "whole suite in a testcontainers repo: using an xlarge box; pass --size to override"
    bump = oom_recent(con, rk, cmd)
    if bump:
        return bump, f"a run like this one was killed for memory here in the last 3 days: using a {bump} box"
    return None, ""


def docker_recent(con, box_id: str | None = None, within: int = 7200, repo_root: str | None = None,
                  thread: str | None = None) -> bool:
    """Docker ran lately on this box (its stop archives images and its next boot reloads them, so stop it less),
    or for this repo/thread (local-first then leaves the next check on the box). Recency counts from the run's
    start or end; a run still going counts.

    runs.docker starts from the command and manifest (uses_docker) and is cleared at the end of a run that started
    no container (runs.finish), so only a run still going counts on its command text alone. 13 Oct - 5 Nov, 1,826
    runs got the 20-minute Docker idle window from a testcontainers manifest alone (ruff, make type, uv sync)."""
    if box_id:
        where, args = "box_id=?", [box_id]
    else:
        where, args = "(repo_root=? OR thread_id=?)", [repo_root or "-", thread or "-"]
    t = now() - within
    sql = (f"SELECT 1 FROM runs WHERE {where} AND mode!='local' AND (start_at>? OR end_at>? OR "
           "(end_at IS NULL AND status IN ('starting','running'))) AND (docker=1 OR (end_at IS NULL AND "
           "(cmd LIKE '%docker%' OR cmd LIKE '%compose%' OR cmd LIKE '%testcontainers%'))) LIMIT 1")
    return con.execute(sql, (*args, t, t)).fetchone() is not None


def idle_for(con, box_id: str, size: str | None, snap: dict | None = None) -> int:
    return capacity.idle_seconds(size, snap, docker=docker_recent(con, box_id))


def cap_check() -> None:
    cap = read_json(CAP_PATH, {})
    if cap.get("capped"):
        raise OffboxError(f"spend cap hit: ${cap.get('spend', 0):.2f} this month (cap ${cap.get('cap', 500):.0f}). New leases are refused.",
                          code=EXIT_CAP)


def pick_template(root: Path, repo_key: str) -> str:
    if repo_key == "crpko-devops":
        return "crpko-go"
    if "harness" in repo_key:
        return "crpko-harness"
    for n in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        if (root / n).is_file():
            return "crpko-harness"
    gomod = root / "go.mod"
    if gomod.is_file():
        try:
            if "testcontainers" in gomod.read_text(errors="replace"):
                return "crpko-harness"
        except OSError:
            pass
        return "crpko-go"
    if (root / "package.json").is_file():
        return "crpko-node"
    return "generic"


def find_lease(con, owner: str, root: str):
    capacity.schema(con)
    # A box with an unconfirmed prune worker is never handed back, not even to its own caller.
    mapped = con.execute("SELECT l.*, c.remote_dir AS caller_dir FROM pool_callers c JOIN leases l USING(box_id) "
                         "WHERE c.owner=? AND c.repo_root=? AND l.state IN ('running','stopped') "
                         "AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=l.box_id)", (owner, root)).fetchone()
    if mapped:
        out = dict(mapped)
        out['remote_dir'] = out.pop('caller_dir')
        return out
    return con.execute("SELECT * FROM leases WHERE owner=? AND repo_root=? AND state IN ('running','stopped') "
                       "AND NOT EXISTS (SELECT 1 FROM prune_holds h WHERE h.box_id=leases.box_id) "
                       "ORDER BY last_used_at DESC LIMIT 1", (owner, root)).fetchone()


def active_runs(con, box_id: str) -> int:
    return con.execute("SELECT COUNT(*) FROM runs WHERE box_id=? AND status IN ('starting','running')",
                       (box_id,)).fetchone()[0]


def box_name(me: dict, repo_key: str) -> str:
    who = (me.get("title") or me.get("thread") or me.get("owner") or "local")[:50]
    return f"offbox {repo_key} | {who}"


def ensure_ttl(box_id: str, ttl: int, s: dict | None = None) -> bool:
    """Make the boat auto-stop deadline at least `ttl` seconds away (PATCH resets it to now+ttl).
    True when the deadline is far enough already or the PATCH succeeded; False when the PATCH failed (warned)."""
    try:
        if s and s.get("archiveAfter"):
            from .common import iso_ts
            left = (iso_ts(s["archiveAfter"]) or 0) - now()
            if left >= ttl - 60:
                return True
        api.set_ttl(box_id, ttl)
        return True
    except OffboxError as e:
        say(f"warning: could not set auto-stop on {box_id}: {e}")
        return False


def idle_ttl(box_id: str) -> None:
    """After a run: stop after the box size's idle window unless another run is active (it refreshes its own ttl)."""
    con = db()
    if active_runs(con, box_id):
        return
    row = con.execute("SELECT size FROM leases WHERE box_id=?", (box_id,)).fetchone()
    ttl = idle_for(con, box_id, row["size"] if row else None)
    if docker_recent(con, box_id):
        # Grace past the reaper's limit so its stop (which archives Docker images first) usually wins over boat's ttl.
        ttl += 300
    try:
        api.set_ttl(box_id, ttl)
    except OffboxError:
        pass


def bootstrap_fresh(box_id: str) -> None:
    """Fresh box (not from a template/base): put tool caches under $HOME so stop/fork keep them."""
    script = (TEMPLATES_DIR / "common-env.sh").read_bytes()
    p = ssh_sync.ssh(box_id, "bash -s", input=script, timeout=120)
    if p.returncode != 0:
        say(f"warning: cache env bootstrap failed on {box_id}: {p.stderr.decode(errors='replace')[-200:]}")


def _start_from(con, table: str, row, sz: str, name: str, idem: str) -> dict | None:
    """Start a box from a template/base row: its saved snapshot, else a fork of its stopped box.

    None when boat has deleted the stopped box's data (14 days after it stopped); the row is marked expired."""
    kind = table[:-1]
    if row["saved"]:
        say(f"starting {kind} {row['name']} from its saved snapshot {row['saved']} as {sz}")
        try:
            return api.create(sz, RUN_TTL_S, name, f"{idem}-{kind}-saved", saved=row["saved"])
        except api.ApiError as e:
            if not api.data_gone(e):
                raise
            say(f"saved snapshot {row['saved']} of {kind} {row['name']} is gone ({e}); forking its box")
            con.execute(f"UPDATE {table} SET saved=NULL WHERE name=?", (row["name"],))
            con.commit()
            event(con, row["box_id"], f"{kind}_saved_gone", f"{row['name']} {row['saved']}: {e}")
    if row["expired_at"]:
        return None
    say(f"forking {kind} {row['name']} ({row['box_id']}) as {sz}")
    try:
        return api.fork(row["box_id"], RUN_TTL_S, f"{idem}-{kind}", sz)
    except api.ApiError as e:
        if not api.data_gone(e):
            raise
        con.execute(f"UPDATE {table} SET expired_at=? WHERE name=?", (now(), row["name"]))
        con.commit()
        event(con, row["box_id"], f"{kind}_expired", f"{row['name']}: {e}")
        return None


def supply_size(want: str | None, floor: str = "large") -> str | None:
    """`want` when boat has machines of that size, else the biggest size below it that does (never below the floor,
    and never below large). None when nothing fits."""
    if not want or capacity.supply_until(want) is None:
        return want
    lo = max(floor or "large", "large", key=_rank)
    for n in reversed(SIZES):
        if _rank(lo) <= _rank(n) < _rank(want) and capacity.supply_until(n) is None:
            return n
    return None


def resume_size(con, row, size: str | None) -> str:
    """The size _reuse resumes a stopped row at: the requested size when it is bigger than the natural one."""
    nat = natural_size(con, row)
    return size if _bigger(size, nat) else nat


def _fit_new(sz: str, size: str | None) -> str:
    """A new box's size, one size smaller while boat has no machines of `sz`. Explicit --size waits instead."""
    fit = supply_size(sz, size or "large")
    if fit is None:
        raise api.SupplyOut(sz, None, f"supply for size {sz} is over until {iso(capacity.supply_until(sz))}",
                            tried=False)
    if fit != sz:
        say(f"boat has no {sz} machines right now; creating a {fit} box instead (pass --size {sz} to wait for {sz})")
    return fit


def _new_box(con, me: dict, size: str | None, template: str | None, base: str | None, fresh: bool):
    """-> (sandbox dict, source label, base_remote_dir or None, size).

    Source "recipe:<template>" is a fresh box that _bring_up builds from the template's recipe because boat
    deleted the template's data."""
    root = Path(me["repo_root"])
    rk = me["repo_key"]
    idem = new_id("lease")
    name = box_name(me, rk)
    if not fresh:
        brow = None
        if base:
            full = base if ":" in base else f"{rk}:{base}"
            brow = con.execute("SELECT * FROM bases WHERE name=?", (full,)).fetchone()
            if not brow:
                raise OffboxError(f"no saved base '{full}'. See `offbox bases`.", code=2)
        elif not template:
            brow = con.execute("SELECT * FROM bases WHERE repo_key=? AND is_default=1 "
                               "AND (expired_at IS NULL OR saved IS NOT NULL)", (rk,)).fetchone()
        if brow:
            sz = _fit_new(size or brow["size"] or "large", size)
            s = _start_from(con, "bases", brow, sz, name, idem)
            if s:
                return s, f"base:{brow['name']}", brow["remote_dir"], sz
            if base:
                raise OffboxError(f"saved base '{brow['name']}' is gone: boat deletes a stopped box's data after 14 "
                                  f"days. Run without --base and `offbox save` again; `offbox base rm "
                                  f"{brow['short'] or brow['name']}` drops the entry.", code=2)
            say(f"default base {brow['name']} is gone (boat deleted its data); using the repo template")
    tname = template or (None if fresh else pick_template(root, rk))
    if tname and not fresh:
        trow = con.execute("SELECT * FROM templates WHERE name=?", (tname,)).fetchone()
        if not trow and tname != "generic":
            trow = con.execute("SELECT * FROM templates WHERE name='generic'").fetchone()
            if trow:
                say(f"template {tname} not built yet; using generic")
        if trow:
            sz = _fit_new(size or DEFAULT_SIZE.get(tname, "default"), size)
            s = _start_from(con, "templates", trow, sz, name, idem)
            if s:
                return s, f"template:{trow['name']}", None, sz
            say(f"template {trow['name']} is gone (boat deleted its data); building this box from its recipe "
                f"instead, which takes a few minutes. The reaper rebuilds the template.")
            s = api.create(sz, RUN_TTL_S, name, idem + "-recipe")
            return s, f"recipe:{trow['name']}", None, sz
    sz = _fit_new(size or DEFAULT_SIZE.get(tname or "generic", "default"), size)
    say(f"creating a fresh {sz} box (no template/base available)")
    s = api.create(sz, RUN_TTL_S, name, idem)
    return s, "fresh", None, sz


# A recipe fallback runs inside a lease bring-up (harness ~6 min). Past this it is cancelled and the box retired,
# not waited for: the TTL keeper would otherwise keep the box alive and billing while the pool lock is held.
RECIPE_TIMEOUT_S = 15 * 60


def _retire_recipe_box(box_id: str, pid, why: str) -> bool:
    """A box whose recipe did not finish cleanly is never handed out or reused: it may be half built, or its recipe
    may still be changing it. Quarantine it (pools and reuse only take running/stopped leases), stop the recipe, and
    delete the box: deletion is the one proof the recipe can no longer touch it. A failed delete leaves the lease
    quarantined and the reaper deletes it on a later pass. True once deleted."""
    con = db()
    con.execute("UPDATE leases SET state='quarantined' WHERE box_id=?", (box_id,))
    con.commit()
    event(con, box_id, "lease_quarantined", why[:300])
    if pid is not None:
        try:
            api.cmd_kill(box_id, pid)
        except OffboxError as e:
            say(f"warning: could not stop the recipe process on {box_id}: {e}")
    try:
        return delete_box(con, box_id, f"recipe cancelled: {why}"[:300])
    except OffboxError as e:
        say(f"warning: could not delete {box_id} ({e}); it stays quarantined until the reaper deletes it")
        return False


def run_recipe(box_id: str, name: str, box_held: bool = False) -> None:
    """Build a template's environment on this box (the script `offbox template build` runs). Only a recipe that
    exits 0 makes the box ready. Any other outcome (failure, error, lost stream, timeout) retires the box and
    raises, so a half-built box is never marked ready or reused.

    box_held: the caller already holds box-<id> (a pool creator). flock is not reentrant, so the recipe must not
    take it again: that second attempt waits 60 s, fails, and retires the box."""
    from . import bases
    from .common import LOGS_DIR
    t = now()
    log_path = LOGS_DIR / f"recipe-{name}-{box_id}.log"
    pid = None
    code = None
    try:
        # The box lock keeps the reaper from idle-stopping the box while the recipe runs.
        with contextlib.ExitStack() as held:
            if not box_held:
                held.enter_context(file_lock("box-" + box_id, timeout=60))
            script, _sha = bases.recipe(name)
            ssh_sync.put_file(box_id, "/home/user/.offbox/recipe.sh", script.encode(), mode="700")
            bases.template_uploads(name, box_id)
            r = api.cmd_start(box_id, "bash -lc " + shlex.quote("bash ~/.offbox/recipe.sh"))
            pid = r["processId"]
            event(db(), box_id, "lease_recipe_pid", str(pid))
            code = _follow_bounded(box_id, pid, log_path, RECIPE_TIMEOUT_S)
    except Exception as e:  # noqa: BLE001 - an upload/start/follow error is a failed recipe like any other
        code = f"error: {e}"
    touch(box_id)
    event(db(), box_id, "lease_recipe", f"{name} exit={code} {round(now() - t)}s")
    if code == 0:
        return
    what = (f"did not finish within {RECIPE_TIMEOUT_S // 60} min" if code == "timeout"
            else f"failed ({str(code)[:200]})")
    gone = _retire_recipe_box(box_id, pid, f"{name} recipe {what}")
    raise OffboxError(f"recipe {name} {what} on {box_id}; log {log_path}. "
                      + ("The box was deleted." if gone else "The box is quarantined until the reaper deletes it."))


def _follow_bounded(box_id: str, pid: int, log_path, timeout_s: float):
    """follow() in a helper thread, joined up to timeout_s. On timeout the follower is told to stop and joined
    (it notices within one frame, or when its stream read times out); its TTL keeper is joined inside follow()."""
    import threading
    from .runs import follow
    result: dict = {}
    stop_evt = threading.Event()

    def run():
        try:
            result["code"] = follow(box_id, pid, log_path, echo=False, stop_evt=stop_evt)
        except Exception as e:  # noqa: BLE001
            result["code"] = f"error: {e}"

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout_s)
    if th.is_alive():
        stop_evt.set()
        th.join(_FOLLOW_STOP_S)
        return "timeout"
    return result.get("code")


# A follower sees the stop signal at its next frame, or when its stream read times out (api.cmd_attach: 90 s), then
# joins its TTL keeper (runs._KEEPER_JOIN_S).
_FOLLOW_STOP_S = 160


def _bring_up(box_id: str, fresh: bool = False, recipe: str | None = None, box_held: bool = False,
              since: float | None = None, stale_error: str | None = None, on_state=None) -> dict:
    from . import outage
    options = {"on_state": on_state} if on_state is not None else {}
    with outage.accepted_machine():
        s = api.wait_state(box_id, api.LIVE_STATES, timeout=900, since=since, stale_error=stale_error, **options)
        try:
            ssh_sync.setup(box_id)
            ssh_sync.wait_ssh(box_id)
        except capacity.CapacityError:
            raise
        except OffboxError as e:
            raise BoxNotReady(box_id, s, e) from e
        if recipe:
            run_recipe(box_id, recipe, box_held=box_held)
        elif fresh:
            bootstrap_fresh(box_id)
    return s


def refresh_box(con, box_id: str) -> None:
    """Resume and stop a stopped box: boat counts its 14-day data limit from the last stop."""
    row = con.execute('SELECT note FROM leases WHERE box_id=?', (box_id,)).fetchone()
    if row and (row['note'] or '').startswith(BOX_WEDGED_NOTE):
        return
    if con.execute("SELECT 1 FROM kv WHERE k=?", (f"resume_unanswered:{box_id}",)).fetchone():
        raise ResumeUnresolved(f"{box_id} has an unanswered resume; refresh deferred")
    capacity.check(con)
    _resume_confirmed(con, box_id, 600, None)
    api.wait_state(box_id, api.LIVE_STATES, timeout=60)
    api.stop(box_id)
    event(con, box_id, "refresh", "resume + stop restarts boat's 14-day data limit")


def acquire(me: dict, size: str | None = None, template: str | None = None, base: str | None = None,
            fresh: bool = False, run_id: str | None = None) -> dict:
    from .pool import acquire as pooled
    return pooled(me, size, template, base, fresh, run_id)


def acquire_private(me: dict, size: str | None = None, template: str | None = None, base: str | None = None,
            fresh: bool = False) -> dict:
    """Return a dict lease row with the box running, ssh ready and ttl >= RUN_TTL_S.

    A pool caller's row carries the new box's lock in "_guard". It is taken before the row exists and stays held
    through bring-up, so no other caller can adopt the box while it is being made; the pool releases it."""
    from .identity import require_proven
    require_proven(me, "run")
    cap_check()
    con = db()
    pooled = me["owner"].startswith("pool:")
    # A pool creator's bring-up is not serialized on the owner lock: the pool's own slot limit bounds concurrent
    # creators, and each new box is guarded by its own lock instead (taken below, before the row exists).
    owner_lock = None if pooled else file_lock(f"lease-{me['owner']}-{me['repo_root']}", timeout=1200)
    if owner_lock is not None:
        owner_lock.__enter__()
    try:
        row = None if pooled else find_lease(con, me["owner"], me["repo_root"])
        if row and (base or fresh) and row["state"] in ("running", "stopped"):
            say(f"note: --base/--fresh only apply to a NEW lease; reusing {row['box_id']} "
                f"(`offbox release` first to start over)")
        if row:
            got = _reuse(con, row, size)
            if got:
                return got
        t = now()
        s, source, base_dir, sz = _new_box(con, me, size, template, base, fresh)
        box_id = s["id"]
        hold = None
        if pooled:
            hold = file_lock(f"box-{box_id}", timeout=0)
            hold.__enter__()
        try:
            got = _create_row(con, me, box_id, source, base_dir, sz, t, box_held=hold is not None, since=t)
        except BaseException:
            if hold is not None:
                hold.__exit__(None, None, None)
            raise
        if hold is not None:
            got["_guard"] = hold
        return got
    finally:
        if owner_lock is not None:
            owner_lock.__exit__(None, None, None)


def _create_row(con, me: dict, box_id: str, source: str, base_dir, sz, t, box_held: bool = False,
                since: float | None = None) -> dict:
    rdir = remote_dir_for(me["repo_root"])
    is_recipe = source.startswith("recipe:")
    # A recipe-sourced box is 'bringing_up' until its recipe has finished: pools and reuse only take
    # running/stopped leases, so a process killed mid-bring-up (Ctrl-C, SIGTERM, a tool timeout) leaves a row no
    # one can hand out as ready. The reaper deletes such rows (see reap._reap).
    state = "bringing_up" if is_recipe else "running"
    con.execute("""INSERT OR REPLACE INTO leases (box_id, owner, thread_id, session_id, thread_title, manager_thread,
                   repo_root, repo_key, remote_dir, size, source, state, created_at, last_used_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (box_id, me["owner"], me.get("thread"), me.get("session"), me.get("title"), me.get("manager"),
                 me["repo_root"], me["repo_key"], rdir, sz, source, state, t, t))
    con.commit()
    event(con, box_id, "lease_new", f"source={source} size={sz} owner={me['owner']} repo={me['repo_root']}")
    try:
        _bring_up(box_id, fresh=(source == "fresh"),
                  recipe=source.split(":", 1)[1] if is_recipe else None, box_held=box_held, since=since)
        try:
            api.rename(box_id, box_name(me, me["repo_key"]))
        except OffboxError:
            pass
        if base_dir and base_dir != rdir:
            ssh_sync.ssh(box_id, f"if [ -d ~/{base_dir} ] && [ ! -e ~/{rdir} ]; then mkdir -p ~/$(dirname {rdir}) "
                                 f"&& mv ~/{base_dir} ~/{rdir}; fi", timeout=60)
    except api.SupplyOut as e:
        # boat never gave the box a machine: a plain box is dropped from our records; a recipe box is retired below.
        if is_recipe:
            _retire_recipe_box(box_id, None, f"bring-up failed before the recipe finished: {e}")
        else:
            con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
            con.commit()
            event(con, box_id, "lease_gone", "supply out")
        raise
    except OffboxError as e:
        # A recipe-sourced box that failed anywhere in bring-up (before, during or after the recipe) is blank or
        # half built. It must not stay a pool candidate, or a later acquisition would hand it out as ready.
        if is_recipe:
            _retire_recipe_box(box_id, None, f"bring-up failed before the recipe finished: {e}")
        raise
    event(con, box_id, "lease_ready", f"{round(now() - t, 1)}s")
    # Only now is a recipe box reusable: the recipe finished (exit 0) and the bring-up completed.
    con.execute("UPDATE leases SET ssh_ready_at=?, state=CASE WHEN state='bringing_up' THEN 'running' ELSE state END "
                "WHERE box_id=?", (now(), box_id))
    con.commit()
    return dict(con.execute("SELECT * FROM leases WHERE box_id=?", (box_id,)).fetchone())


def _bigger(a: str | None, b: str | None) -> bool:
    """True when size a is strictly bigger than size b (unknown sizes count as default)."""
    if not a:
        return False
    rank = {n: i for i, n in enumerate(SIZES)}
    return rank.get(a, 1) > rank.get(b or "default", 1)


class ArchivingSkip(OffboxError):
    """A box that cannot be resumed yet is skipped by pool callers like a busy box."""


class ResumeStuck(ArchivingSkip):
    """The archived retry was spent; this caller must not resume the box again."""


class ResumeStopped(ArchivingSkip):
    """A pending attempt is confirmed stopped; reconcile its siblings before choosing its one retry."""


class _ResumeExpired(Exception):
    """The stopped box's data expired while a resume was being requested."""


def _forget_expired(con, box_id: str, why: str) -> None:
    """boat deleted this stopped box's data (14 days after its stop): nothing to resume, a new box replaces it."""
    say(f"lease {box_id} expired ({why}); starting a new box")
    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
    from . import allocation
    allocation.clear_resume(con, box_id)
    event(con, box_id, "lease_expired", why)


class DiskTooBig(OffboxError):
    """A stopped box's disk outgrew every machine of its size, so boat refuses the resume. The box is marked
    (leases.note) and left stopped and untouched; pool callers skip it and stop counting it toward the pool."""

    def __init__(self, box_id: str, need: str, size: str, holds: str):
        super().__init__(f"{box_id} needs {need} GiB of disk but '{size}' holds {holds} GiB")
        self.need, self.size, self.holds = need, size, holds


def _too_big(con, box_id: str, e: api.ApiError):
    """DiskTooBig for boat's 'disk outgrew its machine size' refusal (marks the lease), else None."""
    m = DISK_TOO_BIG.search(str(e)) if (e.status or 0) in SHRINK_REFUSED else None
    if not m:
        return None
    need, size, holds = m.group(1), m.group(2), m.group(3)
    con.execute("UPDATE leases SET note=? WHERE box_id=?",
                (f"{TOO_BIG_NOTE} needs {need} GiB, {size} holds {holds} GiB", box_id))
    con.commit()
    event(con, box_id, "lease_too_big", f"needs {need} GiB, {size} holds {holds} GiB")
    return DiskTooBig(box_id, need, size, holds)


class DeadMount(OffboxError):
    """A box's home filesystem died (ENOTCONN): nothing ran there. The run moves to another box; the dead one is
    set aside by set_aside_dead_mount (stopped, marked, out of the pool, never deleted)."""

    def __init__(self, box_id: str, reason: str):
        super().__init__(f"{box_id} has a dead filesystem ({reason})")
        self.box_id, self.reason = box_id, reason


def set_aside(con, box_id: str, kind: str, reason: str, run_id: str | None = None) -> bool:
    """Remove a broken box from selection before trying to stop it. Never archive images or delete its disk."""
    # A terminal run is no longer reconciled by the pool/reaper. Its marker must commit in the same transaction,
    # before any event logging, TTL update, resume bookkeeping or network stop can be interrupted.
    with con:
        con.execute("UPDATE leases SET note=? WHERE box_id=?", (f"{kind}: {reason}"[:500], box_id))
        if run_id:
            con.execute("UPDATE runs SET error='box wedged before the command', status='infra', exit_code=NULL, "
                        "end_at=? WHERE run_id=? AND status IN ('starting','running')", (now(), run_id))
            con.execute("INSERT INTO events VALUES (?,?,?,?)", (now(), box_id, 'box_wedged', reason[:2000]))
    from . import allocation
    allocation.clear_resume(con, box_id)
    event_kind = "lease_" + kind.replace('-', '_')
    event(con, box_id, event_kind, reason)
    if run_id:
        event(con, box_id, 'run_end', f'{run_id} status=infra exit=None; box wedged before the command')
    try:
        return stop_box(con, box_id, f"set aside: {kind}", images=False, locked=True)
    except (OffboxError, OSError, subprocess.TimeoutExpired) as e:
        # The reaper's idle stop catches it later; a dead box must not block the run from moving on.
        event(con, box_id, event_kind + "_stop_failed", str(e)[:300])
        return False


def set_aside_dead_mount(con, box_id: str, reason: str) -> None:
    set_aside(con, box_id, DEAD_MOUNT_NOTE.rstrip(':'), reason)


class BoxNotReady(OffboxError):
    """Boat confirmed the machine is live, but its SSH setup/readiness failed."""

    def __init__(self, box_id: str, state: dict, cause: OffboxError):
        super().__init__(f"{box_id} is live but SSH did not become ready; nothing ran: {cause}",
                         code=cause.code, started=cause.started, outage=cause.outage)
        self.box_id, self.state = box_id, state


class ResumeUnresolved(OffboxError):
    """A resume may have been accepted, but its box could not be confirmed."""

    def __init__(self, message, cause=None):
        super().__init__(message, started=bool(cause and cause.started), outage=bool(cause and cause.outage))
        self.status = getattr(cause, 'status', None)


class ResumeProvisionStalled(OffboxError):
    """An unanswered resume was accepted, but never became usable within its provisioning cap."""


def _wait_unanswered_resume(con, box_id):
    from . import outage
    seconds = capacity.setting("OFFBOX_RESUME_PROVISION_SECONDS", 300, minimum=1, maximum=900)
    key = f'resume_provision:{box_id}'
    saved = con.execute('SELECT v FROM kv WHERE k=?', (key,)).fetchone()
    end = float(saved[0]) if saved else time.time() + seconds
    if not saved:
        con.execute('INSERT INTO kv VALUES (?,?,?)', (key, str(end), time.time()))
        con.commit()
    with outage.accepted_machine():
        while True:
            left = end - time.time()
            budget_left = api.left()
            if budget_left is not None:
                if budget_left <= 0.05:
                    raise ResumeUnresolved(f"resume of {box_id} still needs confirmation; nothing ran. Retry later")
                left = min(left, budget_left)
            if left <= 0:
                con.execute("UPDATE leases SET state='resume_stalled' WHERE box_id=?", (box_id,))
                con.commit()
                raise ResumeProvisionStalled(f"unanswered resume of {box_id} stayed provisioning for {seconds}s; "
                                             "nothing ran; set aside and trying a new box")
            try:
                state = api.get(box_id, deadline=time.time() + left)
            except OffboxError:
                state = None
            else:
                if state is None or state.get('dataExpiredAt'):
                    _forget_expired(con, box_id, 'confirmed missing or expired during resume provisioning')
                    raise _ResumeExpired
            if state and state.get("state") in api.LIVE_STATES:
                from . import allocation
                allocation.clear_resume(con, box_id)
                return
            pause = min(2, max(0, end - time.time()))
            budget_left = api.left()
            if budget_left is not None:
                pause = min(pause, max(0, budget_left))
            time.sleep(pause)


def _resume_confirmed(con, box_id: str, ttl: int, size: str | None, pending: bool = False, retry: bool = True,
                      confirm_only: bool = False):
    from . import allocation
    with allocation.guard(box_id, reconcile=pending):
        return _resume_under_guard(con, box_id, ttl, size, pending, retry, confirm_only)


def _resume_under_guard(con, box_id: str, ttl: int, size: str | None, pending: bool = False, retry: bool = True,
                        confirm_only: bool = False):
    key = f"resume_unanswered:{box_id}"

    def mark_pending():
        con.execute("INSERT OR REPLACE INTO kv(k,v,ts) VALUES (?, ?, ?)", (key, size or "", now()))
        con.commit()

    def clear_pending():
        con.execute("DELETE FROM kv WHERE k=?", (key,))
        con.commit()

    def confirm(unanswered):
        log(f"resume_unanswered {box_id}")
        # A read timeout is not a refusal. Only resend if boat confirms the box stayed stopped for the full window.
        seconds = capacity.setting("OFFBOX_RESUME_CONFIRM_SECONDS", 120, minimum=0, maximum=120)
        end = time.monotonic() + seconds
        last = None
        observed = False
        unreadable = False
        observations = 0
        previous_read = time.monotonic()
        while True:
            left = end - time.monotonic()
            from . import outage
            remaining = outage.allocation_left()
            if remaining is not None:
                left = min(left, remaining)
            budget_left = api.left()
            if budget_left is not None:
                if budget_left <= 0.05:
                    raise ResumeUnresolved(f"resume of {box_id} still needs confirmation; nothing ran. Retry later") from unanswered
                left = min(left, budget_left)
            if left <= 0:
                break
            try:
                last = api.get(box_id, deadline=time.time() + left)
            except OffboxError:
                last = None
                observed = False
                unreadable = True
            else:
                if last is None or last.get('dataExpiredAt'):
                    _forget_expired(con, box_id, 'confirmed missing or expired after unanswered resume')
                    raise _ResumeExpired
            if last is None:
                unreadable = True
            read_at = time.monotonic()
            if read_at > end or read_at - previous_read > 3:
                unreadable = True
            previous_read = read_at
            if last and last.get("state") in api.STARTING_STATES + api.LIVE_STATES:
                if last.get('state') in api.LIVE_STATES:
                    from . import allocation
                    allocation.clear_resume(con, box_id)
                return last
            if last and last.get("state") not in api.STOPPED_STATES:
                raise ResumeUnresolved(f"resume of {box_id} was unanswered; its state could not be confirmed; "
                                       "nothing ran. Retry later") from unanswered
            if last:
                observed = True
                observations += 1
            left = end - time.monotonic()
            remaining = outage.allocation_left()
            if remaining is not None:
                left = min(left, remaining)
            budget_left = api.left()
            if budget_left is not None:
                if budget_left <= 0.05:
                    raise ResumeUnresolved(f"resume of {box_id} still needs confirmation; nothing ran. Retry later") from unanswered
                left = min(left, budget_left)
            if remaining is not None and remaining <= 0:
                raise ResumeUnresolved(f"resume of {box_id} was unanswered; its state could not be confirmed; "
                                       "nothing ran. Retry later") from unanswered
            if left <= 0:
                break
            # Leave time for a final observation near the boundary, not a second after it.
            time.sleep(min(2, max(0, left - 0.05)))
            if left <= 0.05:
                break
        if not last or not observed or unreadable or observations < 2:
            raise ResumeUnresolved(f"resume of {box_id} was unanswered; its state could not be confirmed; "
                                   "nothing ran. Retry later") from unanswered
        return False

    def send():
        # The persistent marker is written before sending: a killed client cannot forget an ambiguous resume.
        from . import outage
        from . import allocation
        other = con.execute("SELECT l.box_id FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                            "WHERE l.repo_key=(SELECT repo_key FROM leases WHERE box_id=?) "
                            "AND l.box_id<>? AND l.state IN ('running','stopped') "
                            "AND COALESCE(l.note,'') NOT LIKE ? LIMIT 1",
                            (box_id, box_id, BOX_WEDGED_NOTE + '%')).fetchone()
        if other:
            raise allocation.Unresolved(f"{other[0]} has an unanswered resume; reconcile before sending another")
        if outage.allocation_left() == 0:
            from .pool import PoolBusyError
            raise PoolBusyError("allocation wait expired before resume; nothing ran")
        mark_pending()
        try:
            api.resume(box_id, ttl, size)
        except OffboxError as e:
            if isinstance(e, api.NetworkError) or (isinstance(e, api.ApiError) and e.status in (502, 504, 520, 524)):
                return e
            clear_pending()
            raise
        clear_pending()
        return None

    unanswered = None if pending else send()
    if pending or unanswered is not None:
        confirmed = confirm(unanswered)
        if confirmed:
            return confirmed, False
        if confirm_only:
            from . import allocation
            con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
            allocation.clear_resume(con, box_id)
            raise ResumeStopped(f"{box_id} stayed archived after its unanswered resume; attempt settled")
        if not retry:
            raise ResumeUnresolved(f"resume of {box_id} was unanswered after its archived retry; "
                                   "nothing ran. Retry later") from unanswered
        unanswered = send()
        if unanswered is not None:
            confirmed = confirm(unanswered)
            if confirmed:
                return confirmed, True
            raise ResumeUnresolved(f"resume of {box_id} was unanswered twice; nothing ran. Retry later") from unanswered
        return None, True
    return None, False


def _bring_up_resumed(con, box_id, confirmed, retried, request_resume=None, *, since=None, stale_error=None,
                      skip_archiving=False):
    left_stopped = bool(confirmed)
    if confirmed and confirmed.get('state') in api.STARTING_STATES:
        _wait_unanswered_resume(con, box_id)
    sent_at = now()

    def check_resume(state):
        nonlocal sent_at, retried, left_stopped
        if state.get('state') not in api.STOPPED_STATES:
            left_stopped = True
        if left_stopped or now() - sent_at < RESUME_STUCK_S:
            return
        if not retried and request_resume is not None:
            retried = True
            observed, _ = request_resume(retry=False)
            if observed:
                left_stopped = True
                if observed.get('state') in api.STARTING_STATES:
                    _wait_unanswered_resume(con, box_id)
            sent_at = now()
            event(con, box_id, 'resume_resent', f'still archived after {RESUME_STUCK_S}s')
            return
        con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
        con.commit()
        event(con, box_id, 'resume_stuck', f'still archived after two resumes, {RESUME_STUCK_S}s each')
        message = f"boat didn't start {box_id} after two resumes; nothing ran, retry"
        if skip_archiving:
            raise ResumeStuck(message, code=EXIT_BUSY)
        raise OffboxError(message)

    try:
        return _bring_up(box_id, since=since, stale_error=stale_error, on_state=check_resume)
    except (api.SupplyOut, capacity.CapacityError, ArchivingSkip, ResumeProvisionStalled, BoxNotReady):
        raise
    except OffboxError as e:
        raise ResumeUnresolved(f"{box_id} was resumed but did not become ready; nothing ran: {e}", e) from e


def _reuse(con, row, size: str | None, skip_archiving: bool = False, retrying: bool = False, before_grow=None):
    # Selection may have preceded another holder's quarantine. Re-read after the caller acquired the box lock.
    current = con.execute('SELECT note FROM leases WHERE box_id=?', (row['box_id'],)).fetchone()
    if current and (current['note'] or '').startswith(BOX_WEDGED_NOTE):
        return None
    box_id = row["box_id"]
    from . import allocation
    allocation.recover_resumes(con, row['repo_key'])
    pending = con.execute("SELECT v FROM kv WHERE k=?", (f"resume_unanswered:{box_id}",)).fetchone()
    if pending:
        pending_size = pending[0] if pending[0] in SIZES else None
        try:
            confirmed, retried = _resume_confirmed(con, box_id, RUN_TTL_S, pending_size, pending=True,
                                                  confirm_only=skip_archiving)
            up = _bring_up_resumed(con, box_id, confirmed, retried, skip_archiving=skip_archiving)
        except _ResumeExpired:
            return None
        want = up.get("type") if isinstance(up, dict) else None
        want = want if want in SIZES else row["size"]
        con.execute("UPDATE leases SET state='running', size=?, ssh_ready_at=? WHERE box_id=?", (want, now(), box_id))
        con.commit()
        if _bigger(size, want):
            raise ResumeUnresolved(f"resume of {box_id} came up as {want}; retry to resize to {size}; nothing ran")
        return dict(con.execute("SELECT * FROM leases WHERE box_id=?", (box_id,)).fetchone())
    # Fast path: lease marked running and the ssh master answers -> no API calls at all.
    if row["state"] == "running" and not _bigger(size, row["size"]) and ssh_sync.cfg_path(box_id).exists():
        p = subprocess.run(ssh_sync.ssh_base(box_id) + ["-O", "check", box_id], capture_output=True, timeout=10)
        if p.returncode == 0:
            ensure_ttl(box_id, max(RUN_TTL_S, idle_for(con, box_id, row["size"])))
            return dict(row)
    s = api.get(box_id)
    if s is None or s.get("state") in ("error", "cancelled"):
        con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
        allocation.clear_resume(con, box_id)
        event(con, box_id, "lease_gone", f"state={s and s.get('state')}")
        return None
    if s.get("dataExpiredAt"):
        _forget_expired(con, box_id, f"boat deleted its data at {s['dataExpiredAt']}")
        return None
    st = s.get("state")
    if st == "archiving":
        if skip_archiving:
            raise ArchivingSkip(f"{box_id} is archiving; skipping it for now", code=EXIT_BUSY)
        say(f"{box_id} is stopping; waiting to resume it")
        s = api.wait_state(box_id, api.STOPPED_STATES + api.LIVE_STATES, timeout=ARCHIVING_WAIT_S)
        st = s.get("state")
    # After the archiving wait: a box that came back live still gets the size check below.
    have = s.get("type") or row["size"]
    want = have
    if st in api.LIVE_STATES and _bigger(size, have):
        # Grow a live box only for an explicit bigger --size. Never stop one just to shrink it (that costs a start).
        want = size
        if active_runs(con, box_id):
            raise OffboxError(f"lease {box_id} is {have} with a run in progress; can't resize to {want} now",
                              code=2)
        if capacity.supply_until(want):
            # Never stop a live box to grow it into a size boat cannot give right now.
            raise api.SupplyOut(want, box_id, f"supply for size {want} is over until "
                                              f"{iso(capacity.supply_until(want))}", tried=False)
        say(f"resizing {box_id} {have} -> {want} (stop + resume)")
        capacity.check(con)
        if before_grow is not None:
            before_grow(box_id)
        api.stop(box_id)
        con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
        con.commit()
        event(con, box_id, "lease_resize_stop", f"{have} -> {want}")
        ssh_sync.close_master(box_id)
        if skip_archiving:
            raise ArchivingSkip(f"{box_id} is stopping to grow to {want}; skipping it for now", code=EXIT_BUSY)
        # Direct callers wait for the stop, but no longer than the archiving wait: a stop that sticks in
        # archiving, or a box that bounces back to idle, must not hold the caller for 15 minutes.
        try:
            s = api.wait_state(box_id, api.STOPPED_STATES, timeout=ARCHIVING_WAIT_S)
        except OffboxError:
            s = api.get(box_id)
            st = s and s.get("state")
            if st in api.LIVE_STATES and not _bigger(want, s.get("type") or have):
                pass  # live and already big enough: use it
            elif st in api.LIVE_STATES:
                # The stop didn't take and the box is live at its old size. Record that, and refuse rather than
                # hand out a box smaller than the run asked for.
                got = s.get("type") or have
                con.execute("UPDATE leases SET state='running', size=? WHERE box_id=?", (got, box_id))
                con.commit()
                event(con, box_id, "lease_resize_bounced", f"{got}, wanted {want}")
                raise OffboxError(f"{box_id} came back {got} instead of stopping to grow to {want}; "
                                  f"nothing ran, retry") from None
            else:
                # Still stopping: the stop was asked for, so the next caller resumes it once boat says archived.
                ssh_sync.close_master(box_id)
                con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (box_id,))
                con.commit()
                raise
        st = s.get("state")
    if st in api.STOPPED_STATES and want == have:
        # A resume costs a start either way: come back at the requested size or the box's natural size,
        # not the size some earlier run grew it to.
        want = resume_size(con, row, size)
    t = now()
    if st in api.STOPPED_STATES:
        # Boat has no machines of this size right now: come back one size smaller (an explicit --size waits instead).
        fit = supply_size(want, size or "large")
        if fit is None:
            raise api.SupplyOut(want, box_id, f"supply for size {want} is over until "
                                              f"{iso(capacity.supply_until(want))}", tried=False)
        if fit != want:
            say(f"boat has no {want} machines right now; resuming {box_id} as {fit} instead "
                f"(pass --size {want} to wait for {want})")
            want = fit
        say(f"resuming stopped lease {box_id} ({want})")
        def request_resume(retry=True):
            nonlocal want
            try:
                confirmed, retried = _resume_confirmed(con, box_id, RUN_TTL_S,
                                                       want if want != s.get("type") else None, retry=retry)
            except api.ApiError as e:
                if e.api_code in api.DATA_GONE:
                    _forget_expired(con, box_id, str(e))
                    raise _ResumeExpired from e
                # boat refuses to shrink a box whose disk no longer fits the smaller size; keep its size then.
                if not s.get("type") or not _bigger(s.get("type"), want) or (e.status or 0) not in SHRINK_REFUSED \
                        or not SHRINK_TEXT.search(f"{e.api_code} {e}"):
                    tb = _too_big(con, box_id, e)
                    if tb:
                        raise tb from e
                    raise
                if capacity.supply_until(s.get("type")):
                    raise api.SupplyOut(s.get("type"), box_id, str(e), tried=True) from e
                say(f"could not shrink {box_id} to {want} ({e}); resuming as {s.get('type')}")
                want = s.get("type")
                try:
                    confirmed, retried = _resume_confirmed(con, box_id, RUN_TTL_S, None, retry=retry)
                except api.ApiError as e2:
                    tb = _too_big(con, box_id, e2)
                    if tb:
                        raise tb from e2
                    raise
            return confirmed, retried

        try:
            confirmed, retried = request_resume(retry=not retrying)
            up = _bring_up_resumed(con, box_id, confirmed, retrying or retried, request_resume,
                                  since=t, stale_error=s.get('error'), skip_archiving=skip_archiving)
        except _ResumeExpired:
            return None
        if isinstance(up, dict) and up.get("type") in SIZES:
            want = up["type"]
        event(con, box_id, "lease_resume", f"{round(now() - t, 1)}s size={want}")
    elif st in api.LIVE_STATES or st in api.STARTING_STATES:
        try:
            _bring_up(box_id)
        except BoxNotReady:
            raise
        except OffboxError as e:
            raise ResumeUnresolved(f"{box_id} did not become ready; nothing ran: {e}", e) from e
        ensure_ttl(box_id, max(RUN_TTL_S, idle_for(con, box_id, want)), s)
    else:
        raise OffboxError(f"lease {box_id} in unexpected state {st}")
    con.execute("UPDATE leases SET state='running', size=?, ssh_ready_at=? WHERE box_id=?", (want, now(), box_id))
    con.commit()
    return dict(con.execute("SELECT * FROM leases WHERE box_id=?", (box_id,)).fetchone())


def keep_images(box_id: str) -> None:
    """Best effort: archive Docker images into $HOME before a stop (boat snapshots drop image layers)."""
    if not ssh_sync.cfg_path(box_id).exists():
        return
    try:
        p = ssh_sync.ssh(box_id, "bash -s", input=(TEMPLATES_DIR / "docker-images.sh").read_bytes(), timeout=900)
        out = (p.stdout + p.stderr).decode(errors="replace").strip().splitlines()
        if out and "none to keep" not in out[-1] and "already kept" not in out[-1]:
            event(db(), box_id, "keep_images", out[-1][:300])
    except Exception as e:  # noqa: BLE001
        event(db(), box_id, "keep_images_failed", str(e)[:300])


_HOLDS_DDL = ("CREATE TABLE IF NOT EXISTS prune_holds ("
              "box_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, created_at REAL NOT NULL)")


def ensure_holds(con) -> None:
    """Create the prune_holds table if this database predates it. common.db() builds only the old schema, and
    capacity.schema() is not guaranteed to have run first, so every hold path makes the table itself."""
    con.execute(_HOLDS_DDL)


def clear_prune_hold(con, box_id: str) -> None:
    """Release a box's prune hold. Call only once no remote process can still run there: the box is deleted.
    Never by time alone. Callers outside a box-locked, fresh-confirmed path must use release_if_confirmed."""
    ensure_holds(con)
    con.execute("DELETE FROM prune_holds WHERE box_id=?", (box_id,))
    con.commit()


def settle_stranded_runs(con, box_id: str) -> int:
    """Mark the box's starting/running runs lost. Call only once boat has confirmed the box is gone or stopped, so
    no process can still be running them. A run that outlived its client (no one left to end it) is then not
    counted as active forever. Caller holds 'box-<id>'. Returns how many runs were settled."""
    cur = con.execute("UPDATE runs SET status='lost', end_at=? WHERE box_id=? AND status IN ('starting','running')",
                      (now(), box_id))
    con.commit()
    if cur.rowcount:
        event(con, box_id, "run_lost", f"{cur.rowcount} stranded run(s) settled: box confirmed gone or stopped")
    return cur.rowcount


def _release_locked(con, box_id: str, run_id: str | None = None) -> bool:
    """The confirmation and release, for a caller that already holds 'box-<id>'. Not reentrant: never call it
    without the lock held. Boat is asked first, not after the active-run check: a box confirmed gone or stopped has
    no live process, so its stranded runs are settled and then the hold can go. A live box with an active run is
    never released. A failed read is not confirmation. run_id, when given, limits the clear to that run's hold."""
    try:
        s = api.get(box_id)
    except OffboxError:
        return False  # a failed read is not confirmation: keep the hold, a later pass retries
    if s is not None and s.get("state") not in api.STOPPED_STATES:
        return False  # boat reports it live: its runs may be real, so nothing is settled and nothing released
    settle_stranded_runs(con, box_id)
    if active_runs(con, box_id):
        return False
    ensure_holds(con)
    if run_id is None:
        con.execute("DELETE FROM prune_holds WHERE box_id=?", (box_id,))
    else:
        con.execute("DELETE FROM prune_holds WHERE box_id=? AND run_id=?", (box_id, run_id))
    con.commit()
    return True


def release_if_confirmed(con, box_id: str, run_id: str | None = None) -> bool:
    """For a caller that does NOT hold the box lock: take it (no wait), then confirm and release. A busy lock keeps
    the hold, since a run may be allocating the box right now."""
    try:
        with file_lock('box-' + box_id, timeout=0):
            if con.execute("SELECT 1 FROM kv WHERE k=?", (f"resume_unanswered:{box_id}",)).fetchone():
                return False
            return _release_locked(con, box_id, run_id)
    except OffboxError:
        return False


def stop_box(con, box_id: str, reason: str, wait: bool = False, images: bool = True, locked: bool = False) -> bool:
    """Stop a box. locked=True when the caller already holds 'box-<id>' (reap, release, save); then the hold is
    released with _release_locked, since the lock is not reentrant."""
    if images:
        keep_images(box_id)
    release = _release_locked if locked else release_if_confirmed
    try:
        api.stop(box_id)
        if wait:
            api.wait_state(box_id, api.STOPPED_STATES, timeout=900)
    except api.ApiError as e:
        if e.status == 404:
            from . import allocation
            allocation.clear_resume(con, box_id)
            # Release first, then retire the lease only if no hold remains. A failed confirmation keeps the lease
            # state and the hold, so the reaper revisits this box and releases it on a later pass.
            if release(con, box_id):
                con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
                con.commit()
            return False
        raise
    ssh_sync.close_master(box_id)
    con.execute("UPDATE leases SET state='stopped' WHERE box_id=? AND state='running'", (box_id,))
    con.commit()
    # Clear the hold only after boat confirms the box is stopped; a stop merely accepted, or a box resumed in the
    # meantime, keeps its hold.
    release(con, box_id)
    event(con, box_id, "stop", reason)
    return True


def delete_box(con, box_id: str, reason: str) -> bool:
    from .spend import record_final_usage
    record_final_usage(con, box_id)
    ssh_sync.close_master(box_id)
    d = api.delete(box_id)
    op = (d.get("operation") or {}).get("id")
    con.execute("UPDATE leases SET state='deleted', deleted_at=? WHERE box_id=?", (now(), box_id))
    from . import allocation
    allocation.clear_resume(con, box_id)
    clear_prune_hold(con, box_id)  # deleted: no remote process survives
    event(con, box_id, "delete", f"{reason} op={op}")
    return True


def touch(box_id: str) -> None:
    con = db()
    con.execute("UPDATE leases SET last_used_at=? WHERE box_id=?", (now(), box_id))
    con.commit()


def wait_ready_after(box_id: str, seconds: float) -> None:
    time.sleep(seconds)
