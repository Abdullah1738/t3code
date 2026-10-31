"""offbox run: sync, run as a boat background command, stream, propagate exit, pull artifacts. Plus logs/wait."""

from __future__ import annotations

import base64
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import api, lease, node_version, pool, ssh_sync
from . import prune
from .common import (EXIT_BUSY, EXIT_INFRA, EXIT_WAIT_TIMEOUT, LOGS_DIR, RUN_TTL_S, TTL_REFRESH_S, TTL_RETRY_S, OffboxError,
                     atomic_write_json, db, event, new_id, now, offsets_path, read_json, say, silence)

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
    if [ ! -f "$_offbox_goroot/.offbox-manifest" ]; then _offbox_old=missing
    elif _offbox_manifest_matches "$_offbox_goroot"; then _offbox_old=ok
    else _offbox_old=mismatch; fi
    _offbox_marks=no
    { [ -f "$_offbox_goroot/src/strconv/ctoa.go" ] || [ -f "$_offbox_goroot/src/syscall/syscall_linux_accept4.go" ]; } && _offbox_marks=yes
    echo "offbox: Go repair: old tree manifest=$_offbox_old old-release-files=$_offbox_marks version_written=$(stat -c %z "$_offbox_goroot/VERSION" 2>/dev/null | cut -c1-16) manifest_written=$(stat -c %z "$_offbox_goroot/.offbox-manifest" 2>/dev/null | cut -c1-16)" >&2
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
  # Every systemctl call is bounded: a stalled start must not hold up the user's command.
  if timeout 10 systemctl is-failed --quiet docker 2>/dev/null; then
    echo 'offbox: docker had failed; restarting it' >&2
    sudo -n timeout 10 systemctl reset-failed docker 2>/dev/null
    sudo -n timeout "${OFFBOX_DOCKER_TIMEOUT:-90}" systemctl start docker ||
      { echo 'offbox: docker still fails to start (or timed out):' >&2; timeout 10 systemctl status docker --no-pager -n 5 >&2; }
  fi
) || true'''.replace('__HOOK_B64__', DOCKER_HOOK_B64)

# A boat resume can bring back an /etc/ld.so.cache that lacks libraries installed on the box (libpq5 on
# 28 Oct), so ctypes.util.find_library and psycopg fail. Rebuild the cache; never fails the run.
LDCACHE_REPAIR = r'''(
  [ -x /sbin/ldconfig ] || exit 0
  _offbox_skip="$HOME/.offbox/ldcache-uncached"
  _offbox_missing() (
    for _offbox_lib in /usr/lib/lib*.so.* /usr/lib/*-linux-gnu/lib*.so.*; do
      [ -L "$_offbox_lib" ] && [ -e "$_offbox_lib" ] && printf '%s\n' "${_offbox_lib##*/}"
    done | LC_ALL=C grep -E '\.so\.[0-9]+$' | LC_ALL=C sort -u |
      LC_ALL=C comm -13 <(LC_ALL=C /sbin/ldconfig -p 2>/dev/null | awk 'NR > 1 { print $1 }' | LC_ALL=C sort -u) - |
      LC_ALL=C comm -23 - <(LC_ALL=C sort -u "$_offbox_skip" 2>/dev/null)
  )
  _offbox_before=$(_offbox_missing)
  [ -n "$_offbox_before" ] || exit 0
  if command -v flock >/dev/null 2>&1; then
    exec 9>/tmp/offbox-ldcache.lock && flock -x -w 60 9 || exit 0
    _offbox_before=$(_offbox_missing)
    [ -n "$_offbox_before" ] || exit 0
  fi
  if ! sudo -n /sbin/ldconfig >/dev/null 2>&1; then
    echo "offbox: linker cache lacks $(printf '%s\n' "$_offbox_before" | head -n 3 | tr '\n' ' ')and sudo -n ldconfig failed; put 'sudo ldconfig;' before your command" >&2
    exit 0
  fi
  _offbox_after=$(_offbox_missing)
  _offbox_fixed=$(LC_ALL=C comm -23 <(printf '%s\n' "$_offbox_before") <(printf '%s\n' "$_offbox_after"))
  if [ -n "$_offbox_fixed" ]; then
    echo "offbox: linker cache lacked $(printf '%s\n' "$_offbox_fixed" | head -n 3 | tr '\n' ' ')- ran ldconfig" >&2
  fi
  # Links ldconfig never caches (file name is not the library's soname) must not rerun it each time.
  if [ -n "$_offbox_after" ]; then
    mkdir -p "${_offbox_skip%/*}" && printf '%s\n' "$_offbox_after" >> "$_offbox_skip"
  fi
) || true'''

SETUP_FAILED_MARKER = "offbox-setup-failed"
# boat's agent could not start the command's systemd scope: the box's systemd is broken and our script never ran.
# A stop + resume fixes it (bx_azff4qna 21 Oct, bx_z9u6f9c8 30 Oct).
SCOPE_FAILED = re.compile(r"^Failed to start transient scope unit: ")
# Go failing to read its own std tree (a box read glitch, not the user's code). User module paths never match.
GO_STD_GLITCH = re.compile(r"package (unsafe|internal/\S+|runtime(/\S+)?) is not in std \(/usr/local/go/src/|"
                           r"build constraints exclude all Go files in /usr/local/go/src/(internal|runtime|unsafe)\b")
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


def scope_failed(log_path: Path | None) -> bool:
    """True when the run's only output is boat's scope error: nothing of ours ran."""
    if not log_path or not Path(log_path).exists():
        return False
    lines = [ln for ln in Path(log_path).read_text(errors="replace").splitlines() if ln.strip()]
    return bool(lines) and all(SCOPE_FAILED.match(ln) for ln in lines)


def exit_recording_command(script: str, run_id: str) -> str:
    """Run the remote script under a parent shell that writes its exit code to ~/.offbox/exit/<run>.rc,
    so a run boat later reports as lost still has its real status on the box."""
    f = f'"$HOME/.offbox/exit/{run_id}.rc"'
    outer = "\n".join([
        'mkdir -p "$HOME/.offbox/exit" 2>/dev/null',
        'find "$HOME/.offbox/exit" -name "*.rc" -mtime +2 -delete 2>/dev/null',
        'bash -lc "$0"',
        '__offbox_rc=$?',
        f'{{ echo "$__offbox_rc" > {f}.tmp && mv -f {f}.tmp {f}; }} 2>/dev/null',
        'exit "$__offbox_rc"',
    ])
    return "bash -c " + shlex.quote(outer) + " " + shlex.quote(script)


def recorded_exit(box_id: str, run_id: str) -> int | None:
    """The exit code the run's wrapper left on the box, or None if the file is missing or unreadable."""
    try:
        p = ssh_sync.ssh(box_id, f'cat "$HOME/.offbox/exit/{run_id}.rc"', timeout=20)
    except (OSError, subprocess.TimeoutExpired, OffboxError):
        return None
    if p.returncode != 0:
        return None
    try:
        return int(p.stdout.decode(errors="replace").strip())
    except ValueError:
        return None


def steps_exit(log_path: Path | None, planned: int) -> int | None:
    """For --step runs: the first nonzero step rc (else 0), but only when every planned step reported."""
    if planned <= 0:
        return None
    res = dict(step_results(log_path))
    if not all(n in res for n in range(1, planned + 1)):
        return None
    return next((res[n] for n in range(1, planned + 1) if res[n] != 0), 0)


def recover_lost_exit(box_id: str, run_id: str, log_path: Path | None, planned: int) -> tuple[int | None, str]:
    """A run boat reports as lost may still have ended: take its real code from the box, else the step lines."""
    code = recorded_exit(box_id, run_id)
    if code is not None:
        return code, "the box's exit file"
    code = steps_exit(log_path, planned)
    if code is not None:
        return code, "the step results"
    return None, ""


def report_exit(cmd: str, code: int | None, step_res: list[tuple[int, int]] | None = None, planned: int = 0,
                where: str = "remote") -> None:
    """Always the last offbox line, so a caller's own `| tail` / `; echo` can't be mistaken for it."""
    if step_res is not None:
        say(steps_summary(step_res, planned))
    if code == 1 and last_stage_is_grep(cmd):
        say("exit 1 may be from the trailing grep (no match) or an earlier stage. Use --step for each command.")
    if code == 137 or any(rc == 137 for _, rc in (step_res or [])):
        say("exit 137 = the box killed the command for memory. Rerun with --size xlarge.")
    if code is None:
        say("remote exit unknown (process lost); offbox exits 90")
    else:
        say(f"{where} exit {code}" + (masked_status_hint(cmd) if code == 0 else ""))


def build_env(extra: list[str]) -> tuple[dict, list[str]]:
    # Boxes have no AWS instance metadata (169.254.169.254 is blackholed); boto3 without credentials waits ~2 s per lookup.
    env = {"CI": "1", "AWS_EC2_METADATA_DISABLED": "true"}
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
                  steps: list[str] | None = None, node: str = "") -> str:
    cmd = steps_block(steps) if steps else command_block(
        argv[0] if len(argv) == 1 else " ".join(shlex.quote(a) for a in argv))
    cd = f"$HOME/{rdir}" + (f"/{rel}" if rel and rel != "." else "")
    lines = ["set -a", f'[ -f "{env_file}" ] && . "{env_file}"; rm -f "{env_file}"' if env_file else ":", "set +a",
             f'export OFFBOX_RUN_ID={run_id}',
              DOCKER_REPAIR,
              LDCACHE_REPAIR,
              '[ -x /usr/local/bin/offbox-wait-images ] && /usr/local/bin/offbox-wait-images',
              f'cd "{cd}" || {{ echo "offbox: remote dir {cd} missing (did sync run?)" >&2; exit 97; }}',
              GO_REPAIR,
              node,
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
        # client_pid: `offbox wait` on a run still queued for a box can tell a live client from one that died.
        con.execute("""INSERT INTO runs (run_id, owner, session_id, thread_id, repo_root, cwd, cmd, mode, status, start_at,
                       log_path, pulls, rel_cwd, local_cwd, client_pid) VALUES (?,?,?,?,?,?,?,?, 'starting', ?,?,?,?,?,?)""",
                    (self.run_id, me["owner"], me.get("session"), me.get("thread"), me["repo_root"], str(self.cwd),
                     cmd_text[:4000], "bg" if a.bg else "fg", now(), str(self.log_path),
                     json.dumps(a.pull or []), self.rel, str(self.cwd), os.getpid()))
        con.commit()
        t0 = now()
        size = lease.typecheck_size(cmd_text, me["repo_root"], a.size)
        if size != a.size:
            say("typecheck run: using an xlarge box (tsc ran out of memory on large); pass --size to override")
        env, explicit = build_env(a.env or [])
        env_file = f"/home/user/.offbox/env/{self.run_id}.env"
        body = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in env.items()).encode()
        for attempt in (1, 2):
            row = pool.acquire(me, size=size, template=a.template, base=a.base, fresh=a.fresh, run_id=self.run_id)
            self.lease_row = row
            self.box = row["box_id"]
            rdir = row["remote_dir"]
            self.record(box_id=self.box, size=row["size"], remote_dir=rdir, setup_s=round(now() - t0, 2),
                        docker=int(lease.uses_docker(cmd_text, me["repo_root"])))
            try:
                self._prepare_box(con, a, rdir, env_file, body)
                break
            except lease.DeadMount as e:
                dead = self.box
                self.record(box_id=None)  # our run row must not point at the box we stop
                lease.set_aside_dead_mount(con, dead, e.reason)
                pool.release_guard(row)
                self.lease_row = self.box = None
                if attempt == 2:
                    raise OffboxError(f"{dead} has a dead filesystem ({e.reason}), and so did the box before it; "
                                      "both are set aside. Nothing ran: retry", code=EXIT_INFRA) from e
                say(f"{dead} has a dead filesystem ({e.reason}): stopped and set aside (offbox list --all shows it). "
                    "Trying another box")
        try:
            w = node_version.want(self.root, self.cwd)
            node_block = node_version.block(w) if w else ""
        except Exception:
            node_block = ""
        script = remote_script(rdir, self.rel, a.cmd, env_file, self.run_id, steps=steps or None,
                               node=node_block)
        # From this point a lost response may mean the command executed. Never run it locally again.
        self.started = True
        try:
            r = api.cmd_start(self.box, exit_recording_command(script, self.run_id))
        except api.ApiError as e:
            # A 4xx answer (400 E2BIG, 409 not ready, 429 rate limit) means boat refused it: nothing ran.
            # Without this the run sat "starting" for an hour and held the box until it stopped.
            # Cloudflare 521-526 except 524 never reached boat, so nothing ran; 520, 524 and network errors stay started.
            if (e.status or 0) in REFUSED_STATUSES or (e.status or 0) in api.CF_NOT_DELIVERED:
                self.started = False
                if e.api_code in ("sandbox_not_ready", "machine_not_running"):
                    # boat says the box is stopped: let offbox's next run resume it (lease._reuse) instead of a
                    # hand-run `boat resume`.
                    con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (self.box,))
                    con.commit()
                    ssh_sync.close_master(self.box)
                    event(con, self.box, "lease_not_ready", str(e)[:200])
                    raise OffboxError(f"{e}. Nothing ran; offbox resumes {self.box} on the next run. "
                                      "Retry; don't run `boat resume` by hand.", code=EXIT_INFRA) from e
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

    def _prepare_box(self, con, a, rdir, env_file, body) -> None:
        """Everything before the command starts. Raises lease.DeadMount when the box's filesystem is dead."""
        # The probe goes before prune: prune's ssh hangs on a dead filesystem.
        reason = ssh_sync.probe_home(self.box)
        if reason:
            raise lease.DeadMount(self.box, reason)
        prune.run(con, self.box, rdir)
        # Env values go through a 0600 file (never the command text, which boat keeps 90 days in history).
        err: list = []
        tw = threading.Thread(target=lambda: _safe(err, ssh_sync.put_file, self.box, env_file, body))
        tw.start()
        push_exc = None
        try:
            if not a.no_sync:
                st = ssh_sync.push(self.box, self.root, rdir, with_git=a.git, includes=getattr(a, "include", None))
                self.record(sync_s=st.get("seconds"), sent_bytes=st.get("sent"))
                say(f"synced {self.root.name} -> {self.box} ({st.get('files', 0)} files changed, "
                    f"{st.get('sent', 0) / 1024:.0f} KiB sent, {st.get('seconds')}s)")
                skipped = ssh_sync.tracked_secret_matches(self.root, getattr(a, "include", None))
                if skipped:
                    say(f"not synced (secret filter) though tracked by git: {', '.join(skipped[:5])}"
                        f"{' ...' if len(skipped) > 5 else ''}. If tests need them: --include <path>")
        except Exception as e:  # noqa: BLE001 - held until the env upload has finished, then re-raised
            push_exc = e
        finally:
            tw.join()
        # A dead mount may have failed either transfer; prefer that over an ordinary error from the other.
        for e in (push_exc, err[0] if err else None):
            reason = ssh_sync.dead_mount(str(e)) if e is not None else None
            if reason:
                raise lease.DeadMount(self.box, reason) from e
        if push_exc is not None:
            raise push_exc
        if err:
            raise err[0]

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
        ok = False
        try:
            ok = lease.ensure_ttl(box_id, RUN_TTL_S, api.get(box_id))
        except OffboxError:
            ok = False
        if stop_evt.wait(TTL_REFRESH_S if ok else TTL_RETRY_S):
            return


def _echo(stream, b: bytes) -> bool:
    """Echo a chunk to the caller. A closed pipe stops the echo only; the log keeps the output."""
    try:
        stream.buffer.write(b)
        stream.flush()
        return True
    except (BrokenPipeError, ValueError):
        silence(stream)
        return False


def _close(frames) -> None:
    close = getattr(frames, "close", None)
    if close:
        close()


# Upper bound for joining the TTL keeper when a follower ends: its ensure_ttl call can be inside a 60 s request.
_KEEPER_JOIN_S = 65


def _commit(log_path: Path, out_off: int, err_off: int, log_bytes: int) -> None:
    """Commit a checkpoint after a chunk is flushed to the local log: the remote offsets and the log length they match.
    A holder that dies before this write leaves the chunk past logBytes, so a takeover trusts only logBytes."""
    try:
        atomic_write_json(offsets_path(Path(log_path)),
                          {"stdoutOffset": out_off, "stderrOffset": err_off, "logBytes": log_bytes})
    except OSError:
        pass


# Matches outage.WAIT_MAX_S: the auto-stop now holds ~25 min, so a run can ride out an outage that long.
OUTAGE_FOLLOW_S = 1800


def follow(box_id: str, pid: int, log_path: Path | None, echo: bool = True, run_id: str | None = None,
           start_offsets=(0, 0), stop_evt: threading.Event | None = None, until: float | None = None,
           replay_path: Path | None = None, mirror_path: Path | None = None, mirror_keep: int = 0) -> int | None:
    """Stream a remote command's output until it exits. Setting stop_evt (see lease._follow_bounded) makes it
    return None at the next frame, reconnect or retry pause; it then closes its stream and joins its TTL keeper.
    Past `until` (a time.time()-style deadline) it raises EXIT_WAIT_TIMEOUT and leaves the remote run alone.
    The per-stream offsets are saved beside the local log after every chunk, so a waiter that takes over a dead
    holder's follow resumes from them (see offsets_path) instead of replaying output."""
    out_off, err_off = start_offsets
    stop_evt = stop_evt or threading.Event()
    keeper = threading.Thread(target=_ttl_keeper, args=(box_id, stop_evt), daemon=True)
    keeper.start()
    # A takeover replays into `replay_path`, which the caller prepared with the committed prefix. It is opened for
    # append (never truncated) so that prefix survives, and its checkpoint starts at the length it already holds.
    target = replay_path or log_path
    lf = open(target, "ab") if target else None
    # A takeover also mirrors every committed chunk into the original log (`mirror_path`), so a lock-blocked
    # `logs --follow` sees the new output while the owner runs. The mirror is opened for append, never truncated.
    # Never truncated: the original keeps its committed prefix, and readers only trust bytes up to its checkpoint.
    # A missing or empty original is created here (nothing in it to lose); a nonempty one is continued in place.
    mf = None
    if mirror_path:
        if mirror_keep == 0 and not (Path(mirror_path).exists() and Path(mirror_path).stat().st_size > 0):
            mf = open(mirror_path, "ab")
        else:
            mf = open(mirror_path, "r+b")
            # The original already holds the committed prefix; new output continues at that point.
            mf.seek(mirror_keep)
    if lf:
        # Checkpoint before the first byte: a holder that dies inside its first chunk still leaves one, so a waiter
        # never prints bytes that its takeover will replay (no checkpoint at all = a holder from before checkpoints).
        _commit(target, out_off, err_off, lf.tell())
        if mf:
            # The mirror's zero (or current) checkpoint, written before the first byte, so a follower that reads the
            # original right away sees a valid committed length rather than none.
            _commit(mirror_path, out_off, err_off, mf.tell())
    failures = 0
    frames = None
    down_from = None  # since when boat's API has been unreachable during this follow

    def timed_out() -> OffboxError:
        return OffboxError(f"--timeout reached; {run_id or f'{box_id}:{pid}'} keeps running on {box_id} "
                           f"(nothing was stopped). Wait again: offbox wait {run_id or ''}".rstrip(),
                           code=EXIT_WAIT_TIMEOUT, started=True)

    def left() -> float | None:
        return None if until is None else until - now()

    try:
        while True:
            if stop_evt.is_set():
                return None
            # Outside the retry try below, so it ends the wait instead of counting as a stream failure.
            if until is not None and now() >= until:
                raise timed_out()
            try:
                again = False
                # A quiet stream must not hold the caller past its deadline: the socket read times out at the deadline.
                read_s = 90 if until is None else max(1.0, min(90.0, left()))
                if down_from is not None:
                    # Inside an outage the attach may not outrun the outage window either.
                    read_s = max(1.0, min(read_s, OUTAGE_FOLLOW_S - (now() - down_from)))
                frames = api.cmd_attach(box_id, pid, out_off, err_off, timeout=read_s, deadline=until)
                for fr in frames:
                    if stop_evt.is_set():
                        return None
                    # A frame from a live attach means boat answers: this stream's outage (if any) is over.
                    down_from = None
                    # Absolute: a frame that arrives after the deadline (even an exit) is not accepted.
                    if until is not None and now() >= until:
                        raise timed_out()
                    t = fr.get("type")
                    if t in ("stdout", "stderr"):
                        data = fr.get("data") or ""
                        b = data.encode()
                        if echo:
                            echo = _echo(sys.stdout if t == "stdout" else sys.stderr, b)
                        nxt = fr.get("nextOffset")
                        if t == "stdout":
                            out_off = nxt if nxt is not None else out_off + len(b)
                        else:
                            err_off = nxt if nxt is not None else err_off + len(b)
                        if lf:
                            lf.write(b)
                            lf.flush()
                            # Commit after the flush: a holder dying in between leaves this chunk past logBytes.
                            _commit(target, out_off, err_off, lf.tell())
                            if mf:
                                mf.write(b)
                                mf.flush()
                                _commit(mirror_path, out_off, err_off, mf.tell())
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
                    if until is not None and now() >= until:
                        again = True
                        break
                if again:
                    _close(frames)
                    continue
                raise OffboxError("output stream closed without an exit frame")
            except api.StreamDeadline:
                # api.stream shut the socket at `until`: the deadline, not a broken stream to retry.
                raise timed_out()
            except (OffboxError, OSError, TimeoutError) as e:
                if stop_evt.is_set():
                    return None
                if until is not None and now() >= until:
                    raise timed_out()
                failures += 1
                failed_at = now()  # an outage window starts at the first failure that proves boat is down
                st = None
                boat_down = False
                # The outage window runs on the wall clock: attach and status requests that hang count against it
                # too, so the limit cannot slip by failure count alone.
                if down_from is not None and now() - down_from >= OUTAGE_FOLLOW_S:
                    raise OffboxError(f"lost the output stream of {box_id}:{pid}: boat's API was down for "
                                      f"{int(OUTAGE_FOLLOW_S)}s: {e}", started=True)
                try:
                    # Status and the retry pause share the deadline: a blocked status request must not outrun it.
                    # During an outage it is also capped to the outage window left, so one call cannot outrun it.
                    status_s = max(1.0, min(60.0, left() if until is not None else 60.0))
                    if down_from is not None:
                        status_s = max(1.0, min(status_s, OUTAGE_FOLLOW_S - (now() - down_from)))
                    # An absolute end (the caller's until, the outage window) is what makes api.cmd_status skip the
                    # connect retries: without it a not-delivered 52x would be sent six times, outside the window.
                    ends = [now() + status_s]
                    if until is not None:
                        ends.append(until)
                    if down_from is not None:
                        ends.append(down_from + OUTAGE_FOLLOW_S)
                    try:
                        st = api.cmd_status(box_id, pid, timeout=status_s, retries=0, deadline=min(ends))
                    except OffboxError as se:
                        boat_down = getattr(se, "outage", False)
                except OffboxError:
                    pass
                if until is not None and now() >= until:
                    raise timed_out()
                down_from = (down_from or failed_at) if boat_down else None
                if st and not st.get("running") and st.get("status") in ("exited", "lost"):
                    if st.get("status") == "lost":
                        return None
                    if failures > 3:
                        return st.get("exitCode")
                if failures > 20 and (down_from is None or now() - down_from >= OUTAGE_FOLLOW_S):
                    raise OffboxError(f"lost the output stream of {box_id}:{pid}: {e}", started=True)
                pause = min(10, 1 + failures)
                if down_from is not None:
                    # boat's API is down, not the run: keep reattaching, but never pause past the outage window.
                    pause = min(pause, max(0.0, OUTAGE_FOLLOW_S - (now() - down_from)))
                if until is not None:
                    pause = max(0.0, min(pause, left()))
                if stop_evt.wait(pause):
                    return None
                if until is not None and now() >= until:
                    raise timed_out()
    finally:
        stop_evt.set()
        _close(frames)  # closes the HTTP response (api.stream reads it inside `with`)
        # The keeper's ensure_ttl can sit in a 60 s request; a waiter past its deadline must not wait on it.
        keeper.join(_KEEPER_JOIN_S if until is None else max(0.0, min(_KEEPER_JOIN_S, left() or 0.0)))
        if lf:
            lf.close()
        if mf:
            mf.close()


def do_pulls(box_id: str, row: dict, pulls: list[str]) -> None:
    for p in pulls:
        st = ssh_sync.pull(box_id, row["remote_dir"], row["rel_cwd"] or ".", p, Path(row["local_cwd"]))
        if st.get("ok"):
            say(f"pulled {p} ({st.get('files', 0)} files)")
        else:
            say(f"pull {p} failed: {st.get('error')}")


def go_std_glitch(box: str | None, run_id: str, log_path: Path | None, code: int | None) -> bool:
    """Hint and record a Go std-tree read glitch. Exit codes stay unchanged: no retry, no remapping."""
    if code in (None, 0) or not log_path or not Path(log_path).exists():
        return False
    if not GO_STD_GLITCH.search(Path(log_path).read_text(errors="replace")):
        return False
    con = db()
    since = None
    if box:
        row = con.execute("SELECT max(ts) FROM events WHERE box_id=? AND kind IN ('lease_resume','lease_new')",
                          (box,)).fetchone()
        since = row[0] if row else None
    secs = round(now() - since) if since is not None else "unknown"
    event(con, box, "go_std_glitch", f"{run_id} {secs}s after resume")
    say(f"Go could not read its own standard library on {box} ('is not in std'). This is a box glitch seen "
        "right after a resume, not your code. Rerun the same command.")
    return True


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

    # Installed before rn.start(): a tool-call timeout's SIGTERM during the pool wait or the lease must reach
    # run_remote's not-started finish ('killed'). With the default handler Python died there and the row stayed
    # 'starting' with no box (31 Oct, run-1031-145121-2b9f).
    old = {s: signal.signal(s, on_sig) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
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
        code = None
        try:
            code = rn.stream()
        except KeyboardInterrupt:
            # Kill delivery may be uncertain. Keep the slot reserved until status proves exit.
            rn.record(error='interrupted; awaiting confirmed remote termination')
            return 130
    finally:
        for s, h in old.items():
            signal.signal(s, h)
    if code is None:
        code, how = recover_lost_exit(rn.box, rn.run_id, rn.log_path, len(getattr(a, "steps", None) or []))
        if code is not None:
            say(f"boat lost track of the remote process after it ended; exit {code} taken from {how}")
    if code not in (0, None) and scope_failed(rn.log_path):
        rn.started = False
        rn.record(error="box could not start the command (systemd scope)")
        finish(rn.run_id, None, "infra")
        con = db()
        event(con, rn.box, "box_broken", f"{rn.run_id} transient scope failed")
        try:
            # images=False: docker-images.sh needs a working systemd and may hang on this box.
            lease.stop_box(con, rn.box, "broken: transient scope failed", images=False, locked=True)
            after = "offbox stopped it, so the next run resumes it clean"
        except OffboxError as e:
            after = f"offbox could not stop it ({e}); run: offbox release {rn.box}"
        raise OffboxError(f"{rn.box} could not start the command (systemd: transient scope failed); "
                          f"nothing ran. {after}. Retry.", code=EXIT_INFRA)
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
    go_std_glitch(rn.box, rn.run_id, rn.log_path, code)
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
