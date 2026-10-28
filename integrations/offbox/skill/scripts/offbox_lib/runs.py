"""offbox run: sync, run as a boat background command, stream, propagate exit, pull artifacts. Plus logs/wait."""

from __future__ import annotations

import base64
import json
import os
import re
import shlex
import signal
import sys
import threading
import time
from pathlib import Path

from . import api, lease, pool, ssh_sync
from .common import (EXIT_BUSY, EXIT_INFRA, LOGS_DIR, RUN_TTL_S, TTL_REFRESH_S, OffboxError, db, event, new_id, now, say)

BG_TTL_S = 6 * 3600
# cmd_start answers that prove boat refused the command (nothing ran). Other 4xx and network errors stay ambiguous.
REFUSED_STATUSES = (400, 401, 403, 404, 409, 413, 422, 429)
ENV_ALLOW = ("TZ", "LANG", "LC_ALL", "GOFLAGS", "GOPROXY", "GONOSUMDB", "GOPRIVATE", "GOTOOLCHAIN", "CGO_ENABLED",
             "NODE_OPTIONS", "NODE_ENV", "JEST_WORKERS", "FORCE_COLOR", "NO_COLOR", "PYTHONUNBUFFERED", "PYTEST_ADDOPTS",
             "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "RUST_BACKTRACE", "CARGO_TERM_COLOR", "TERM")
ENV_DENY_HINTS = ("AWS_", "TOKEN", "SECRET", "PASSWORD", "KEY", "CREDENTIAL", "SESSION", "COOKIE", "AUTH")
# Read from this checkout's skill root, not common.TEMPLATES_DIR: the live copy lacks the file until install.zsh runs.
DOCKER_HOOK_B64 = base64.b64encode(
    (Path(__file__).resolve().parents[2] / "templates" / "boat-sync-docker-firewall").read_bytes()).decode()


GO_REPAIR = r'''# Box-local, not just client-local: SSH/manual invocations can overlap pooled runs.
(
  _offbox_fail() { echo "offbox: Go repair: $*" >&2; exit 97; }
  exec 9>/tmp/offbox-go-repair.lock || _offbox_fail 'cannot open repair lock'
  flock -x -w 300 9 || _offbox_fail 'cannot acquire repair lock within 300s'
  _offbox_stale=()
  for _offbox_dir in /usr/local/.offbox-go.??????; do
    [[ $_offbox_dir =~ /\.offbox-go\.[a-zA-Z0-9]{6}$ ]] || continue
    [ -d "$_offbox_dir" ] && [ ! -L "$_offbox_dir" ] || continue
    _offbox_stale+=("$_offbox_dir")
    # A killed process may have stopped between the two renames. Keep its only copy.
    if [ ! -e /usr/local/go ] && [ ! -L /usr/local/go ]; then
      for _offbox_backup in "$_offbox_dir/old" "$_offbox_dir/go"; do
        if sudo -n test -d "$_offbox_backup"; then
          echo 'offbox: Go repair: restoring interrupted GOROOT swap' >&2
          sudo -n mv -T -- "$_offbox_backup" /usr/local/go || _offbox_fail 'interrupted swap restore failed'
          break
        fi
      done
    fi
  done
  _offbox_goroot=
  if command -v go >/dev/null 2>&1; then
    _offbox_goroot=$(GOTOOLCHAIN=local go env GOROOT 2>/dev/null) || _offbox_goroot=
  fi
  # A half-swap may have removed bin/go as well; do not depend on a working go env.
  if [ -z "$_offbox_goroot" ] && [ -f /usr/local/go/VERSION ]; then
    _offbox_goroot=/usr/local/go
  fi
  [ -n "$_offbox_goroot" ] || exit 0
  _offbox_version=$(head -n 1 "$_offbox_goroot/VERSION") || _offbox_fail 'cannot read GOROOT/VERSION'
  _offbox_reason=
  if [ ! -s "$_offbox_goroot/src/unsafe/unsafe.go" ] || [ -e "$_offbox_goroot/go" ] ||
     [ ! -x "$_offbox_goroot/bin/go" ]; then
    _offbox_reason=broken
  fi
  if [[ $_offbox_version =~ ^go([0-9]+)\.([0-9]+)(\.|rc|beta|$) ]]; then
    _offbox_major=$((10#${BASH_REMATCH[1]}))
    _offbox_minor=$((10#${BASH_REMATCH[2]}))
    if (( _offbox_major > 1 || (_offbox_major == 1 && _offbox_minor >= 25) )); then
      if [ -f "$_offbox_goroot/src/runtime/traceexp.go" ]; then
        echo 'offbox: removing stale Go runtime/traceexp.go overlay' >&2
        sudo -n rm -f -- "$_offbox_goroot/src/runtime/traceexp.go" || _offbox_fail 'stale overlay removal failed'
      fi
      if (( _offbox_major == 1 && _offbox_minor >= 26 )) &&
         { [ -f "$_offbox_goroot/src/strconv/ctoa.go" ] || [ -f "$_offbox_goroot/src/syscall/syscall_linux_accept4.go" ]; }; then
        _offbox_reason=mixed
      fi
    fi
  fi
  _offbox_inventory() (
    set -o pipefail
    cd "$1" || exit 1
    # Include paths, types, sizes and symlink targets; exclude only our own root stamp.
    # NUL records keep filenames unambiguous. No file contents or mtimes are scanned.
    LC_ALL=C find . ! -type d ! -path './.offbox-manifest' -printf '%P\t%y\t%s\t%l\0' |
      LC_ALL=C sort -z | sha256sum
  )
  _offbox_manifest_matches() {
    [ -f "$1/.offbox-manifest" ] && [ ! -L "$1/.offbox-manifest" ] || return 1
    local inventory
    inventory=$(_offbox_inventory "$1") || return 1
    [ "$(cat "$1/.offbox-manifest")" = "offbox-go-tree-v1 $_offbox_version $inventory" ]
  }
  # Missing stamps are untrusted legacy installs: never bless their current file list.
  if [ "$_offbox_goroot" = /usr/local/go ] && [ -z "$_offbox_reason" ] &&
     ! _offbox_manifest_matches "$_offbox_goroot"; then
    _offbox_reason=mixed
  fi
  _offbox_valid() {
    [ "$(head -n 1 "$1/VERSION")" = "$_offbox_version" ] &&
      [ -s "$1/src/unsafe/unsafe.go" ] && [ ! -e "$1/go" ] &&
      _offbox_manifest_matches "$1" &&
      [[ $(GOTOOLCHAIN=local GOROOT="$1" "$1/bin/go" version) = "go version $_offbox_version "* ]] &&
      GOENV=off GOFLAGS= GOTOOLCHAIN=local GOWORK=off GO111MODULE=off GOROOT="$1" "$1/bin/go" build std >/dev/null
  }
  if [ -n "$_offbox_reason" ]; then
    [[ $_offbox_version =~ ^go1\.[0-9]+\.[0-9]+$ ]] || _offbox_fail "unsupported release $_offbox_version"
    [ "$_offbox_goroot" = /usr/local/go ] && [ ! -L /usr/local/go ] || _offbox_fail "refusing to replace unmanaged GOROOT $_offbox_goroot"
    # Stage beside GOROOT: /tmp may be on another filesystem, making mv a partial copy.
    _offbox_stage=$(sudo -n mktemp -d /usr/local/.offbox-go.XXXXXX) || _offbox_fail 'cannot create staging directory'
    _offbox_saved=0
    _offbox_installed=0
    _offbox_tree_id=
    _offbox_cleanup() {
      _offbox_rc=$?
      trap - EXIT HUP INT TERM
      if (( !_offbox_installed )) && { (( _offbox_saved )) || [ ! -e /usr/local/go ]; } &&
         sudo -n test -d "$_offbox_stage/old"; then
        echo 'offbox: Go repair: rollback to previous GOROOT' >&2
        if [ -e /usr/local/go ] || [ -L /usr/local/go ]; then
          if [ -z "$_offbox_tree_id" ] || [ -L /usr/local/go ] ||
             [ "$(stat -c '%d:%i' /usr/local/go 2>/dev/null)" != "$_offbox_tree_id" ]; then
            echo "offbox: Go repair: destination changed; backup retained at $_offbox_stage/old" >&2
            exit 97
          fi
          sudo -n rm -rf -- /usr/local/go || exit 97
        fi
        if ! sudo -n mv -T -- "$_offbox_stage/old" /usr/local/go; then
          echo "offbox: Go repair: rollback failed; backup retained at $_offbox_stage/old" >&2
          exit 97
        fi
      fi
      # If the first rename failed, retain any partial backup for diagnosis/recovery.
      if (( !_offbox_saved )) && sudo -n test -e "$_offbox_stage/old"; then
        echo "offbox: Go repair: failed backup retained at $_offbox_stage/old" >&2
      else
        sudo -n rm -rf -- "$_offbox_stage" || _offbox_rc=97
      fi
      exit "$_offbox_rc"
    }
    trap _offbox_cleanup EXIT
    trap 'exit 97' HUP INT TERM
    sudo -n chown "$(id -u):$(id -g)" "$_offbox_stage" || _offbox_fail 'cannot prepare staging directory'
    echo "offbox: replacing $_offbox_reason $_offbox_version GOROOT from official archive" >&2
    curl -fsSL --retry 3 "https://go.dev/dl/${_offbox_version}.linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" -o "$_offbox_stage/go.tgz" || _offbox_fail 'official archive download failed'
    tar -xzf "$_offbox_stage/go.tgz" -C "$_offbox_stage" || _offbox_fail 'official archive extraction failed'
    _offbox_manifest=$(_offbox_inventory "$_offbox_stage/go") || _offbox_fail 'archive inventory failed'
    printf 'offbox-go-tree-v1 %s %s\n' "$_offbox_version" "$_offbox_manifest" > "$_offbox_stage/go/.offbox-manifest" || _offbox_fail 'cannot write official tree manifest'
    _offbox_valid "$_offbox_stage/go" || _offbox_fail 'archive verification failed; GOROOT untouched'
    _offbox_tree_id=$(stat -c '%d:%i' "$_offbox_stage/go") || _offbox_fail 'cannot identify replacement tree'
    [ ! -e "$_offbox_stage/old" ] && [ ! -L "$_offbox_stage/old" ] || _offbox_fail 'backup destination exists'
    sudo -n mv -T -- /usr/local/go "$_offbox_stage/old" || _offbox_fail 'GOROOT backup rename failed'
    _offbox_saved=1
    [ ! -e /usr/local/go ] && [ ! -L /usr/local/go ] || _offbox_fail 'install destination exists'
    sudo -n mv -T -- "$_offbox_stage/go" /usr/local/go || _offbox_fail 'GOROOT install rename failed'
    _offbox_valid /usr/local/go || _offbox_fail 'post-swap verification failed'
    _offbox_installed=1
    echo "offbox: Go repair: verified $_offbox_version GOROOT" >&2
  elif (( ${#_offbox_stale[@]} )); then
    # Never discard the last recoverable tree just because VERSION looks healthy.
    [ "$_offbox_goroot" = /usr/local/go ] || exit 0
    _offbox_valid /usr/local/go || _offbox_fail 'verification failed; stale backups retained'
  fi
  for _offbox_dir in "${_offbox_stale[@]}"; do
    sudo -n rm -rf -- "$_offbox_dir" || _offbox_fail "cannot remove stale staging directory $_offbox_dir"
  done
) || { echo offbox-setup-failed >&2; exit 97; }'''

# boat.dev (28 Oct 2026) runs /usr/local/bin/sync-docker-firewall after dockerd starts (docker.service.d drop-in).
# Boxes resumed from older snapshots can lack it, and systemd then kills dockerd (203/EXEC). Never fails the run.
DOCKER_REPAIR = r'''(
  grep -qsF /usr/local/bin/sync-docker-firewall /etc/systemd/system/docker.service.d/*.conf || exit 0
  if [ ! -x /usr/local/bin/sync-docker-firewall ]; then
    echo 'offbox: restoring boat docker hook /usr/local/bin/sync-docker-firewall' >&2
    _offbox_t=$(mktemp) || exit 0
    printf '%s' '__HOOK_B64__' | base64 -d > "$_offbox_t" &&
      sudo -n install -m 755 "$_offbox_t" /usr/local/bin/sync-docker-firewall ||
      echo 'offbox: could not restore the docker hook' >&2
    rm -f "$_offbox_t"
  fi
  if systemctl is-failed --quiet docker 2>/dev/null; then
    echo 'offbox: docker had failed; restarting it' >&2
    sudo -n systemctl reset-failed docker 2>/dev/null
    sudo -n systemctl start docker ||
      { echo 'offbox: docker still fails to start:' >&2; systemctl status docker --no-pager -n 5 >&2; }
  fi
) || true'''.replace('__HOOK_B64__', DOCKER_HOOK_B64)

SETUP_FAILED_MARKER = "offbox-setup-failed"
STEP_RESULT = re.compile(r"offbox step (\d+) rc=(-?\d+): ")


PIPELINE_STATUS = r'''__offbox_pipeline_status() {
  # $1 accumulates the rightmost failure; the remaining args are PIPESTATUS.
  # Positional args avoid collisions with callers' readonly shell variables.
  while (( $# > 2 )); do
    if (( $2 != 0 && $2 != 141 )); then
      set -- "$2" "${@:3}"
    else
      set -- "$1" "${@:3}"
    fi
  done
  if (( $2 != 0 )); then return "$2"; fi
  return "$1"
}'''


def standalone_pipeline(cmd: str) -> bool:
    """Conservatively recognize a single pipeline, not a shell list/control flow.

    Normalize SIGPIPE only here: changing a compound script's exit afterward
    could report success even though && or errexit skipped subsequent checks.
    Reject list operators even inside parentheses: shlex removes quotes, so
    quoted parentheses must never hide real control flow. Uncertain syntax
    keeps plain pipefail.
    """
    if any(mark in cmd for mark in ("<<", "`", "#", "\n")) or cmd.rstrip().endswith("\\"):
        return False
    try:
        lx = shlex.shlex(cmd.strip(), posix=True, punctuation_chars=True)
        lx.whitespace = " \t\r"
        tokens = list(lx)
    except ValueError:
        return False
    depth, pipes, previous = 0, 0, ""
    for token in tokens:
        if token in {"if", "then", "else", "elif", "fi", "while", "until", "for", "do", "done",
                     "case", "esac", "select", "function", "{", "}", "!", "time", "coproc"}:
            return False
        # shlex groups punctuation, e.g. `);` and `)|`; inspect each operator.
        parts = re.findall(r"&&|\|\||\|&|[<>]&|&>>?|[();&|<>]", token) if re.fullmatch(r"[();&|<>]+", token) else [token]
        for part in parts:
            if part in (";", "&", "&&", "||"):
                return False
            if part == "(":
                depth += 1
            elif part == ")":
                depth -= 1
                if depth < 0:
                    return False
            elif depth == 0:
                if part in ("|", "|&"):
                    pipes += 1
            previous = part
    return depth == 0 and pipes > 0 and previous not in ("|", "|&")


def command_block(cmd: str) -> str:
    """Protect ordinary command pipelines; --step retains its own pipefail semantics."""
    if standalone_pipeline(cmd):
        return 'set -o pipefail\n' + PIPELINE_STATUS + '\n' + cmd + '\n__offbox_pipeline_status 0 "${PIPESTATUS[@]}"'
    return "set -o pipefail\n" + cmd


def masked_status_hint(cmd: str) -> str:
    """Explain explicit status masking by a caller's final echo/true."""
    try:
        lx = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lx.whitespace = " \t\r"
        toks = list(lx)
    except ValueError:
        return ""
    last: list[str] = []
    sep = None
    for t in toks:
        if t in (";", "&&", "||", "&", "\n", ";;"):
            last, sep = [], t
        else:
            last.append(t)
    if not last:
        return ""
    # After `&&` the earlier command must have passed for the echo to run at all.
    if sep not in (None, "&&") and last[0] in ("echo", "printf", "true", ":"):
        return (f" (status of the final `{' '.join(last)[:60]}`, not of the commands before it; "
                "save rc=$? and end with `exit $rc`)")
    return ""


def last_stage_is_grep(cmd: str) -> bool:
    """True when the final pipeline stage of the final command in the string is grep."""
    try:
        lx = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lx.whitespace = " \t\r"
        toks = list(lx)
    except ValueError:
        return False
    stage: list[str] = []
    for t in toks:
        if t in (";", "&&", "||", "&", "\n", ";;", "|", "|&"):
            stage = []
        else:
            stage.append(t)
    return bool(stage) and os.path.basename(stage[0]) in ("grep", "egrep", "fgrep")


def steps_block(steps: list[str]) -> str:
    """Each step runs in its own subshell with pipefail; a failing step does not stop the next one."""
    lines = ["__offbox_first=0"]
    for n, step in enumerate(steps, 1):
        label = " ".join(step.split())[:60]
        lines += ["(", "set -o pipefail", step, ")", "__offbox_rc=$?",
                  f'echo "offbox step {n} rc=$__offbox_rc: "{shlex.quote(label)} >&2',
                  '[ "$__offbox_rc" -eq 0 ] || [ "$__offbox_first" -ne 0 ] || __offbox_first=$__offbox_rc']
    lines.append('exit "$__offbox_first"')
    return "\n".join(lines)


def step_results(log_path: Path | None) -> list[tuple[int, int]]:
    """(step number, rc) for every step line the remote script printed into the run log."""
    if not log_path or not Path(log_path).exists():
        return []
    out = []
    for line in Path(log_path).read_text(errors="replace").splitlines():
        m = STEP_RESULT.search(line)
        if m:
            out.append((int(m.group(1)), int(m.group(2))))
    return out


def steps_summary(results: list[tuple[int, int]], planned: int) -> str:
    ok = sum(1 for _, rc in results if rc == 0)
    failed = [f"step {n} rc={rc}" for n, rc in results if rc != 0]
    text = f"offbox steps: {ok} ok, {len(failed)} failed"
    if failed:
        text += " (" + ", ".join(failed) + ")"
    if planned > len(results):
        text += f", {planned - len(results)} not run"
    return text


def setup_failed(log_path: Path | None) -> bool:
    return bool(log_path) and Path(log_path).exists() and SETUP_FAILED_MARKER in Path(log_path).read_text(errors="replace")


def report_exit(cmd: str, code: int | None, step_res: list[tuple[int, int]] | None = None, planned: int = 0,
                where: str = "remote") -> None:
    """Always the last offbox line, so a caller's own `| tail` / `; echo` can't be mistaken for it."""
    if step_res is not None:
        say(steps_summary(step_res, planned))
    if code == 1 and last_stage_is_grep(cmd):
        say("exit 1 may be from the trailing grep (no match) or an earlier stage. Use --step for each command.")
    if code is None:
        say("remote exit unknown (process lost); offbox exits 90")
    else:
        say(f"{where} exit {code}" + (masked_status_hint(cmd) if code == 0 else ""))


def build_env(extra: list[str]) -> tuple[dict, list[str]]:
    env = {"CI": "1"}
    for k in ENV_ALLOW:
        if os.environ.get(k):
            env[k] = os.environ[k]
    explicit = []
    for spec in extra:
        if "=" in spec:
            k, v = spec.split("=", 1)
        else:
            k, v = spec, os.environ.get(spec)
            if v is None:
                say(f"--env {k}: not set locally, skipped")
                continue
        env[k] = v
        explicit.append(k)
    return env, explicit


def remote_script(rdir: str, rel: str, argv: list[str], env_file: str | None, run_id: str,
                  steps: list[str] | None = None) -> str:
    cmd = steps_block(steps) if steps else command_block(
        argv[0] if len(argv) == 1 else " ".join(shlex.quote(a) for a in argv))
    cd = f"$HOME/{rdir}" + (f"/{rel}" if rel and rel != "." else "")
    lines = ["set -a", f'[ -f "{env_file}" ] && . "{env_file}"; rm -f "{env_file}"' if env_file else ":", "set +a",
             f'export OFFBOX_RUN_ID={run_id}',
              DOCKER_REPAIR,
              '[ -x /usr/local/bin/offbox-wait-images ] && /usr/local/bin/offbox-wait-images',
              f'cd "{cd}" || {{ echo "offbox: remote dir {cd} missing (did sync run?)" >&2; exit 97; }}',
              GO_REPAIR,
              cmd]
    return "\n".join(lines)


class Runner:
    def __init__(self, a, me: dict):
        self.a, self.me = a, me
        self.run_id = new_id("run")
        self.root = Path(me["repo_root"])
        self.cwd = Path(os.getcwd()).resolve()
        try:
            self.rel = str(self.cwd.relative_to(self.root))
        except ValueError:
            self.rel = "."
        self.box = None
        self.pid = None
        self.started = False
        self.killed = False
        self.lease_row = None
        self.log_path = LOGS_DIR / f"{self.run_id}.log"

    def record(self, **kw):
        con = db()
        cols = ", ".join(f"{k}=?" for k in kw)
        con.execute(f"UPDATE runs SET {cols} WHERE run_id=?", (*kw.values(), self.run_id))
        con.commit()

    def start(self) -> dict:
        a, me = self.a, self.me
        con = db()
        steps = getattr(a, "steps", None) or []
        if steps:
            cmd_text = " ; ".join(steps)[:4000]
        else:
            cmd_text = " ".join(shlex.quote(x) for x in a.cmd) if len(a.cmd) > 1 else a.cmd[0]
        con.execute("""INSERT INTO runs (run_id, owner, session_id, thread_id, repo_root, cwd, cmd, mode, status, start_at,
                       log_path, pulls, rel_cwd, local_cwd) VALUES (?,?,?,?,?,?,?,?, 'starting', ?,?,?,?,?)""",
                    (self.run_id, me["owner"], me.get("session"), me.get("thread"), me["repo_root"], str(self.cwd),
                     cmd_text[:4000], "bg" if a.bg else "fg", now(), str(self.log_path),
                     json.dumps(a.pull or []), self.rel, str(self.cwd)))
        con.commit()
        t0 = now()
        row = pool.acquire(me, size=a.size, template=a.template, base=a.base, fresh=a.fresh, run_id=self.run_id)
        self.lease_row = row
        self.box = row["box_id"]
        rdir = row["remote_dir"]
        self.record(box_id=self.box, size=row["size"], remote_dir=rdir, setup_s=round(now() - t0, 2),
                    docker=int(lease.uses_docker(cmd_text, me["repo_root"])))
        env, explicit = build_env(a.env or [])
        env_file = f"/home/user/.offbox/env/{self.run_id}.env"
        body = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in env.items()).encode()
        # Env values go through a 0600 file (never the command text, which boat keeps 90 days in history).
        err: list = []
        tw = threading.Thread(target=lambda: _safe(err, ssh_sync.put_file, self.box, env_file, body))
        tw.start()
        if not a.no_sync:
            st = ssh_sync.push(self.box, self.root, rdir, with_git=a.git, includes=getattr(a, "include", None))
            self.record(sync_s=st.get("seconds"), sent_bytes=st.get("sent"))
            say(f"synced {self.root.name} -> {self.box} ({st.get('files', 0)} files changed, "
                f"{st.get('sent', 0) / 1024:.0f} KiB sent, {st.get('seconds')}s)")
            skipped = ssh_sync.tracked_secret_matches(self.root, getattr(a, "include", None))
            if skipped:
                say(f"not synced (secret filter) though tracked by git: {', '.join(skipped[:5])}"
                    f"{' ...' if len(skipped) > 5 else ''}. If tests need them: --include <path>")
        tw.join()
        if err:
            raise err[0]
        script = remote_script(rdir, self.rel, a.cmd, env_file, self.run_id, steps=steps or None)
        # From this point a lost response may mean the command executed. Never run it locally again.
        self.started = True
        try:
            r = api.cmd_start(self.box, "bash -lc " + shlex.quote(script))
        except api.ApiError as e:
            # A 4xx answer (400 E2BIG, 409 not ready, 429 rate limit) means boat refused it: nothing ran.
            # Without this the run sat "starting" for an hour and held the box until it stopped.
            if (e.status or 0) in REFUSED_STATUSES:
                self.started = False
                if "E2BIG" in str(e):
                    # Usage error, not infra: no infra alert, no retry, no fallback.
                    raise OffboxError(f"{e}: the command is too long for one exec; put it in a script file "
                                      "in the repo and run that", code=2) from e
            raise
        self.pid = r["processId"]
        self.started = True
        self.record(process_id=self.pid, command_id=r.get("commandId"), status="running")
        lease.touch(self.box)
        event(con, self.box, "run_start", f"{self.run_id} pid={self.pid} env={','.join(explicit) or '-'} "
                                          f"cmd={cmd_text[:200]}")
        return row

    # ------------------------------------------------------------ streaming
    def stream(self, echo: bool = True) -> int | None:
        """Attach until exit. Returns exit code (None if lost)."""
        return follow(self.box, self.pid, self.log_path, echo=echo, run_id=self.run_id)

    def kill(self):
        if self.box and self.pid and not self.killed:
            self.killed = True
            try:
                api.cmd_kill(self.box, self.pid)
                say(f"killed remote process {self.pid} on {self.box}")
            except OffboxError as e:
                say(f"could not kill remote process: {e}")


def _safe(err: list, fn, *args):
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001
        err.append(e if isinstance(e, OffboxError) else OffboxError(f"{type(e).__name__}: {e}"))


def _ttl_keeper(box_id: str, stop_evt: threading.Event):
    """Keep the boat auto-stop deadline >= RUN_TTL_S away while attached. Never shortens a longer deadline."""
    while True:
        try:
            lease.ensure_ttl(box_id, RUN_TTL_S, api.get(box_id))
        except OffboxError:
            pass
        if stop_evt.wait(TTL_REFRESH_S):
            return


def follow(box_id: str, pid: int, log_path: Path | None, echo: bool = True, run_id: str | None = None,
           start_offsets=(0, 0)) -> int | None:
    out_off, err_off = start_offsets
    stop_evt = threading.Event()
    keeper = threading.Thread(target=_ttl_keeper, args=(box_id, stop_evt), daemon=True)
    keeper.start()
    lf = open(log_path, "ab") if log_path else None
    failures = 0
    try:
        while True:
            try:
                again = False
                for fr in api.cmd_attach(box_id, pid, out_off, err_off):
                    t = fr.get("type")
                    if t in ("stdout", "stderr"):
                        data = fr.get("data") or ""
                        b = data.encode()
                        if echo:
                            (sys.stdout if t == "stdout" else sys.stderr).buffer.write(b)
                            (sys.stdout if t == "stdout" else sys.stderr).flush()
                        if lf:
                            lf.write(b)
                            lf.flush()
                        nxt = fr.get("nextOffset")
                        if t == "stdout":
                            out_off = nxt if nxt is not None else out_off + len(b)
                        else:
                            err_off = nxt if nxt is not None else err_off + len(b)
                    elif t == "reconnect":
                        out_off, err_off = fr.get("stdoutOffset", out_off), fr.get("stderrOffset", err_off)
                        again = True
                        break
                    elif t == "exit":
                        return fr.get("exitCode") if fr.get("exitCode") is not None else (
                            128 + 15 if fr.get("signal") else None)
                    elif t == "error":
                        raise OffboxError(f"attach error: {fr.get('error')} {fr.get('message')}")
                    failures = 0
                if again:
                    continue
                raise OffboxError("output stream closed without an exit frame")
            except (OffboxError, OSError, TimeoutError) as e:
                failures += 1
                st = None
                try:
                    st = api.cmd_status(box_id, pid)
                except OffboxError:
                    pass
                if st and not st.get("running") and st.get("status") in ("exited", "lost"):
                    if st.get("status") == "lost":
                        return None
                    if failures > 3:
                        return st.get("exitCode")
                if failures > 20:
                    raise OffboxError(f"lost the output stream of {box_id}:{pid}: {e}", started=True)
                time.sleep(min(10, 1 + failures))
    finally:
        stop_evt.set()
        if lf:
            lf.close()


def do_pulls(box_id: str, row: dict, pulls: list[str]) -> None:
    for p in pulls:
        st = ssh_sync.pull(box_id, row["remote_dir"], row["rel_cwd"] or ".", p, Path(row["local_cwd"]))
        if st.get("ok"):
            say(f"pulled {p} ({st.get('files', 0)} files)")
        else:
            say(f"pull {p} failed: {st.get('error')}")


def finish(run_id: str, code: int | None, status: str | None = None) -> None:
    con = db()
    r = con.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
    if not r:
        return
    st = status or ("lost" if code is None else ("done" if code == 0 else "failed"))
    con.execute("UPDATE runs SET status=?, exit_code=?, end_at=? WHERE run_id=? AND status IN ('starting','running')",
                (st, code, now(), run_id))
    con.commit()
    if r["box_id"]:
        # Extend auto-stop as well as the reaper threshold when the start budget is tight.
        lease.touch(r["box_id"])
        lease.idle_ttl(r['box_id'])
        event(con, r["box_id"], "run_end", f"{run_id} status={st} exit={code} {round(now() - (r['start_at'] or now()))}s")


def run_remote(a, me: dict) -> int:
    """Foreground or --bg remote run. Raises OffboxError(code 90/91/92) before the command starts."""
    rn = Runner(a, me)
    try:
        return _run_remote(a, rn)
    except OffboxError as e:
        e.started = e.started or rn.started
        raise
    except KeyboardInterrupt:
        if not rn.started:
            finish(rn.run_id, 130, 'killed')
        raise
    except Exception as e:
        if not rn.started:
            finish(rn.run_id, None, 'infra')
        rn.record(error=str(e)[:500])
        raise OffboxError(f"remote run error: {type(e).__name__}: {e}", started=rn.started) from e
    finally:
        pool.release_guard(rn.lease_row)


def _run_remote(a, rn) -> int:
    interrupted = {"sig": None}

    def on_sig(signum, _frame):
        interrupted["sig"] = signum
        rn.kill()
        raise KeyboardInterrupt

    try:
        rn.start()
    except OffboxError as e:
        if not rn.started:
            finish(rn.run_id, None, "busy" if e.code == EXIT_BUSY else "infra")
        rn.record(error=str(e)[:500])
        raise
    if a.bg:
        # Nobody stays attached to refresh the deadline: give the box a long one. The reaper stops it
        # IDLE_STOP_S after the process ends (it checks process status itself).
        lease.ensure_ttl(rn.box, BG_TTL_S, api.get(rn.box))
        print(rn.run_id)
        say(f"started in background on {rn.box}. Follow: offbox logs {rn.run_id} --follow ; wait: offbox wait {rn.run_id}")
        return 0
    old_int = signal.signal(signal.SIGINT, on_sig)
    old_term = signal.signal(signal.SIGTERM, on_sig)
    old_hup = signal.signal(signal.SIGHUP, on_sig)
    code = None
    try:
        code = rn.stream()
    except KeyboardInterrupt:
        # Kill delivery may be uncertain. Keep the slot reserved until status proves exit.
        rn.record(error='interrupted; awaiting confirmed remote termination')
        return 130
    finally:
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGHUP, old_hup)
    if code == 97 and setup_failed(rn.log_path):
        # The preamble failed before the user command was reached, so nothing ran and fallback is allowed.
        rn.started = False
        rn.record(error="box setup failed (exit 97)")
        finish(rn.run_id, None, "infra")
        raise OffboxError("box setup failed (exit 97), not your command", code=EXIT_INFRA)
    if a.pull:
        con = db()
        do_pulls(rn.box, dict(con.execute("SELECT * FROM runs WHERE run_id=?", (rn.run_id,)).fetchone()), a.pull)
    finish(rn.run_id, code)
    if code is None:
        say("remote process was lost (box restarted?); treating as infra failure")
    steps = getattr(a, "steps", None) or []
    if steps:
        res = step_results(rn.log_path)
        failed = next((n for n, rc in res if rc != 0), None)
        report_exit(steps[failed - 1] if failed else "", code, res, len(steps))
    else:
        report_exit(a.cmd[0] if len(a.cmd) == 1 else shlex.join(a.cmd), code)
    return 90 if code is None else code
