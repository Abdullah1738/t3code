"""offbox run: sync, run as a boat background command, stream, propagate exit, pull artifacts. Plus logs/wait."""

from __future__ import annotations

import offbox_disk_space

import base64
import contextlib
import json
import os
import re
import select
import shlex
import signal
import stat
import sqlite3
import subprocess
import sys
import threading
import traceback
import time
from pathlib import Path
from types import SimpleNamespace

from . import home, api, capacity, identity, lease, node_tools, node_version, package_manager, pnpm_version, pool, ssh_sync, run_evidence
from . import command_usage, common, containers, java_version, prune, prepare, userns
from . import resources, box_disk, queue_lifecycle
from .common import (BOX_WEDGED_NOTE, EXIT_BUSY, EXIT_DETACHED, EXIT_INFRA, EXIT_INTERRUPTED, EXIT_LOCAL, EXIT_WAIT_TIMEOUT, LOGS_DIR, ORPHAN_RUN_MAX_S,
                     RUN_TTL_S, TTL_REFRESH_S, TTL_RETRY_S, OffboxError, atomic_write_json, db, db_retry, event, file_lock, local_error, log, new_id, now,
                     is_silenced, offsets_path, person, read_json, record_delivery, say, silence, size_summary, write)


def _source_stamp():
    try:
        folder = Path(__file__).resolve().parent
        files = [*folder.glob('*.py'), folder.parent / 'offbox.py', folder.parent / 'toollog.py',
                 folder.parent / 'offbox_disk_space.py']
        return tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in sorted(files))
    except Exception:
        return None


_SOURCE_STAMP = _source_stamp()


def _log_source_change(run_id):
    try:
        current = _source_stamp()
        if current is not None and _SOURCE_STAMP is not None and current != _SOURCE_STAMP:
            import toollog
            toollog.emit('run', 'run.error', kind='error', ok=False, ids={'run': run_id},
                         props={'stage': 'install_mid_run'}, tag='install_mid_run')
    except Exception:
        pass



BG_TTL_S = ORPHAN_RUN_MAX_S
BACKGROUND_RUN_ENV = 'OFFBOX_BACKGROUND_RUN'
_background_context = None
BG_ENTRY = Path(__file__).resolve().parents[1] / 'offbox.py'
BG_READY_TIMEOUT_S = 20
RESTART_MARKER = Path(os.environ.get('T3CODE_HOME') or Path.home() / '.robob') / 'userdata/restarting'
RESTART_MARKER_MAX_S = 300
# cmd_start answers that prove boat refused the command (nothing ran). Other 4xx and network errors stay ambiguous.
REFUSED_STATUSES = (400, 401, 403, 404, 409, 413, 422, 429)
ENV_ALLOW = ("TZ", "LANG", "LC_ALL", "GOFLAGS", "GOPROXY", "GONOSUMDB", "GOPRIVATE", "GOTOOLCHAIN", "CGO_ENABLED",
             "NODE_OPTIONS", "NODE_ENV", "JEST_WORKERS", "FORCE_COLOR", "NO_COLOR", "PYTHONUNBUFFERED", "PYTEST_ADDOPTS",
             "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "RUST_BACKTRACE", "CARGO_TERM_COLOR", "TERM")
ENV_DENY_HINTS = ("AWS_", "TOKEN", "SECRET", "PASSWORD", "KEY", "CREDENTIAL", "SESSION", "COOKIE", "AUTH")
# Read from this checkout's skill root, not common.TEMPLATES_DIR: the live copy lacks the file until install.zsh runs.
DOCKER_HOOK_B64 = base64.b64encode(
    (Path(__file__).resolve().parents[2] / "templates" / "boat-sync-docker-firewall").read_bytes()).decode()
SQLITE_SETUP = ("bash -c " + shlex.quote(
    (Path(__file__).resolve().parents[2] / "templates/tools/fetch.sh").read_text() + "\n" +
    (Path(__file__).resolve().parents[2] / "templates/tools/sqlite.sh").read_text()) +
    ' || { echo "offbox: sqlite3 setup failed" >&2; exit 97; }')

# Recipes travel with this runner so an uninstalled checkout can prove the exact change.
REPO_RECIPES_DIR = Path(__file__).resolve().parents[2] / "templates" / "repos"
REPO_SETUP_FAILED_MARKER = "offbox-repo-setup-failed"
EXIT_REPO_SETUP = 98

REPO_SETUP = r'''# offbox-repo-setup
(
  set -euo pipefail
  mkdir -p "$HOME/.offbox/repo-env"
  exec 9>"$HOME/.offbox/repo-setup-@KEY@.lock"
  flock -x -w 1800 9
  export OFFBOX_REPO_ROOT="$HOME"/@ROOT@
  _offbox_base="$HOME/.offbox/repo-setup-@KEY@"
  _offbox_stamp=$(python3 - "$OFFBOX_REPO_ROOT" <<'OFFBOX_REPO_STAMP'
import base64, hashlib, re, sys
from pathlib import Path
recipe = base64.b64decode('@RECIPE@')
mod = Path(sys.argv[1]) / 'core/go.mod'
match = re.search(r'^\s*(?:require\s+)?golang\.org/x/mobile\s+(v[^\s]+)', mod.read_text(), re.M) if mod.exists() else None
version = match[1] if match else ''
print(hashlib.sha256(recipe + b'\0' + version.encode()).hexdigest())
OFFBOX_REPO_STAMP
  )
  python3 - "$_offbox_base.sh" <<'OFFBOX_REPO_RECIPE'
import base64, sys
from pathlib import Path
Path(sys.argv[1]).write_bytes(base64.b64decode('@RECIPE@'))
OFFBOX_REPO_RECIPE
  _offbox_needs_setup=false
  _offbox_recipe_mode=
  @CHECK@
  if $_offbox_needs_setup || [ "$(cat "$_offbox_base.stamp" 2>/dev/null || true)" != "$_offbox_stamp" ] ||
     [ ! -f "$HOME/.offbox/repo-env/@KEY@.sh" ]; then
    @ANNOUNCE@
    rm -f "$_offbox_base.stamp"
    _offbox_t0=$SECONDS
    bash "$_offbox_base.sh" ${_offbox_recipe_mode:+"$_offbox_recipe_mode"}
    # A successful recipe must publish the environment before we trust its stamp.
    test -f "$HOME/.offbox/repo-env/@KEY@.sh"
    printf '%s\n' "$_offbox_stamp" > "$_offbox_base.stamp.tmp"
    mv -f "$_offbox_base.stamp.tmp" "$_offbox_base.stamp"
    @READY@
  fi
) 3>&2 >>"$HOME/.offbox/repo-setup-@KEY@.log" 2>&1
_offbox_repo_rc=$?
if [ "$_offbox_repo_rc" -ne 0 ]; then
  tail -n 20 "$HOME/.offbox/repo-setup-@KEY@.log" >&2
  echo 'offbox: @KEY@ toolchain setup failed on this box; nothing ran' >&2
  echo offbox-repo-setup-failed >&2
  exit 98
fi
. "$HOME/.offbox/repo-env/@KEY@.sh" || {
  tail -n 20 "$HOME/.offbox/repo-setup-@KEY@.log" >&2
  echo 'offbox: @KEY@ toolchain setup failed on this box; nothing ran' >&2
  echo offbox-repo-setup-failed >&2
  exit 98
}
'''


def repo_setup_block(repo_key: str, rdir: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", repo_key):
        return ""
    recipe = REPO_RECIPES_DIR / f"{repo_key}.sh"
    if not recipe.is_file():
        return ""
    body = recipe.read_bytes()
    if repo_key == "crpko-devops":
        body = (REPO_RECIPES_DIR.parent / "tools/crpko.sh").read_bytes() + b"\n" + body
    body = (REPO_RECIPES_DIR.parent / "tools/fetch.sh").read_bytes() + b"\n" + body
    announce = "echo 'offbox: setting up @KEY@ toolchain on this box (first run here, a few minutes)' >&3"
    ready = 'echo "offbox: @KEY@ toolchain ready ($((SECONDS - _offbox_t0))s)" >&3'
    check = ':'
    if repo_key == "crpko-devops":
        # One invocation shares the parsed pin between readiness and setup. Status bypasses the retained log.
        check = '''export OFFBOX_REPO_STATUS_FD=3
  if [ "$(cat "$_offbox_base.stamp" 2>/dev/null || true)" = "$_offbox_stamp" ] &&
     [ -f "$HOME/.offbox/repo-env/crpko-devops.sh" ]; then
    _offbox_recipe_mode=--ensure
  fi
  _offbox_needs_setup=true'''
        announce = ready = ':'
    # The log redirection opens before the subshell can create its directories.
    return ('mkdir -p "$HOME/.offbox" || { '
            f'echo "offbox: {repo_key} toolchain setup failed on this box; nothing ran" >&2; '
            'echo offbox-repo-setup-failed >&2; exit 98; }\n'
            + REPO_SETUP.replace('@ANNOUNCE@', announce).replace('@READY@', ready)
            .replace('@KEY@', repo_key).replace('@ROOT@', shlex.quote(rdir))
            .replace('@CHECK@', check)
            .replace('@RECIPE@', base64.b64encode(body).decode()))

# Shared by pre-command probes: neither root ownership nor uninterruptible I/O can extend the deadline.
BOUNDED_PROCESS = r'''
import os, selectors, signal, subprocess, sys, time
def bounded(args, seconds, relay=False, capture=False):
    try:
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE if relay or capture else subprocess.DEVNULL,
                                 stderr=subprocess.STDOUT, start_new_session=True)
    except OSError:
        return 1, b''
    selector = selectors.DefaultSelector()
    if child.stdout:
        selector.register(child.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + seconds
    output = bytearray()
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    pass
                # No wait/communicate: even SIGKILL cannot reap a process blocked in kernel I/O.
                return 124, bytes(output)
            for key, _ in selector.select(min(left, 0.1)):
                data = os.read(key.fd, 65536)
                if data:
                    if relay:
                        os.write(2, data)
                    if capture:
                        output.extend(data)
                else:
                    selector.unregister(key.fileobj)
            rc = child.poll()
            if rc is not None and not selector.get_map():
                return (rc if rc >= 0 else 128 - rc), bytes(output)
    finally:
        if child.stdout:
            child.stdout.close()
        selector.close()
'''

# The old helper installed on a box may wait forever behind the boot-time restore. Keep this in the run
# itself so even boxes made before the fix use the bound.
IMAGE_WAIT = r'''# offbox-wait-images: bounded even on boxes with an old restore helper
(
  _offbox_seconds=${OFFBOX_IMAGE_WAIT_SECONDS:-180}
  [[ $_offbox_seconds =~ ^[1-9][0-9]{0,3}$ ]] || _offbox_seconds=180
  echo 'offbox: waiting for kept docker images' >&2
  python3 - "$_offbox_seconds" <<'OFFBOX_IMAGE_WAIT'
''' + BOUNDED_PROCESS + r'''
seconds = int(sys.argv[1])
script = r"""
set -u -o pipefail
archive=/home/user/.offbox/images/saved.tar.zst
[ -e /run/offbox-images-ready ] && exit 0
[ -s "$archive" ] || exit 0
exec 9>/run/offbox-image-restore.lock || exit 1
flock -w "$1" 9 || exit 124
[ -e /run/offbox-images-ready ] && exit 0
[ -s "$archive" ] || exit 0
until docker info >/dev/null 2>&1; do sleep 1; done
missing=0
if [ -s "$archive.tags" ]; then
  while read -r tag; do
    [ -n "$tag" ] || continue
    docker image inspect "$tag" >/dev/null 2>&1 || { missing=1; break; }
  done < "$archive.tags"
else
  missing=1
fi
if [ "$missing" = 1 ]; then
  size=$(du -h "$archive" 2>/dev/null | cut -f1)
  echo "offbox: loading kept docker images (${size:-unknown size})..." >&2
  zstd -dc "$archive" | docker load > /var/tmp/offbox-image-restore.log 2>&1 || exit 1
fi
touch /run/offbox-images-ready
"""
rc, _ = bounded(['sudo', '-n', 'timeout', '-k', '2s', f'{seconds}s', 'bash', '-c', script,
                 'offbox-image-restore', str(seconds)], seconds, relay=True)
if rc:
    # timeout itself may wait forever on a D-state docker child; supervise that probe too.
    docker_rc, _ = bounded(['timeout', '-k', '1s', '10s', 'docker', 'info'], 11)
    if docker_rc:
        ps_rc, output = bounded(['ps', '-eo', 'stat=,comm='], 2, capture=True)
        names = [parts[1] for line in output.decode(errors='replace').splitlines()
                 if len(parts := line.split(None, 1)) == 2 and parts[0].startswith('D')]
        state = f"{len(names)} ({', '.join(names[:5])})" if ps_rc == 0 else 'unknown (ps did not answer)'
        lock_rc, output = bounded(['sudo', '-n', 'lslocks', '--json', '-o', 'PID,COMMAND,MODE,PATH'], 2, capture=True)
        holder = 'unknown'
        try:
            import json
            for lock in json.loads(output)['locks'] if lock_rc == 0 else []:
                # A mode ending in '*' is a waiter, not the process holding the lock.
                if (lock.get('path') == '/run/offbox-image-restore.lock'
                        and not lock.get('mode', '').endswith('*') and (lock.get('pid') or 0) > 0):
                    comm = ' '.join((lock.get('command') or 'unknown').split())
                    holder = f"{lock['pid']} {comm}"
                    break
        except (ValueError, KeyError, TypeError, AttributeError):
            pass
        print(f'offbox-box-wedged: kept image restore did not finish in {seconds}s and docker does not answer; '
              f'D-state: {state}; lock holder: {holder}', file=sys.stderr)
        sys.exit(97)
sys.exit(1 if rc == 97 else rc)
OFFBOX_IMAGE_WAIT
  _offbox_rc=$?
  case $_offbox_rc in
    0) ;;
    97) exit 97 ;;
    124|137) echo "offbox: kept docker images still loading after ${_offbox_seconds}s; continuing without waiting" >&2 ;;
    *) echo 'offbox: could not restore kept docker images; continuing without waiting' >&2 ;;
  esac
  exit 0
) || exit $?'''


def needs_image_wait(cmd: str, repo_root: str) -> bool:
    """Skip only simple read-only commands which cannot start a container themselves.

    Scripts, make targets, tests and unknown commands can invoke Docker without naming it in argv.
    """
    if re.search(r"[;&|<>$`\n(){}*?\[\]\\]", cmd) or re.search(r"(^|\s)#", cmd):
        return True
    try:
        words = shlex.split(cmd)
    except ValueError:
        return True
    if not words:
        return True
    if words[0] in ("true", "false", ":", "pwd"):
        return len(words) != 1
    if lease.uses_docker(cmd, repo_root):
        return True
    # Go commands can execute a GOFLAGS -toolexec/-exec from the box's persistent Go env. Version is safe.
    if words == ["go", "version"]:
        return False
    return True


def image_wait_seconds() -> int:
    """The client sets the remote bound; it is not implicitly forwarded as command environment."""
    value = os.environ.get("OFFBOX_IMAGE_WAIT_SECONDS") or "180"
    return int(value) if re.fullmatch(r"[1-9][0-9]{0,3}", value) else 180


def clickhouse_suite_warning(repo_key: str, size: str, cmd: str) -> str | None:
    if repo_key != 'crpko-devops' or size not in ('large', 'xlarge'):
        return None
    words = [word.rsplit('/', 1)[-1] for word in re.findall(r'[A-Za-z0-9_./:+-]+', cmd)]
    runner = any(re.fullmatch(r'python(?:[23](?:\.\d+)?)?|pytest|npm|pnpm|npx|node', word) for word in words)
    suite = any(re.fullmatch(r'unittest|pytest|test(?:[-_:].*|\.py)?|run-static-test-shard\.mjs', word) for word in words)
    if runner and suite:
        return ('ClickHouse 24.8 alert fixtures can exhaust threads on large/xlarge boxes; '
                'use fixture max_threads=8 (raising PID limits alone does not fix it; #915)')
    return None


GO_ARCHIVE_CURL_LIMITS = "--connect-timeout 20 --speed-limit 10240 --speed-time 60 --max-time 900"

GO_REPAIR = r'''# Box-local, not just client-local: SSH/manual invocations can overlap pooled runs.
(
  _offbox_fail() {
    if [ "${_offbox_needs_go:-1}" = 1 ]; then
      echo "offbox: Go repair: $*" >&2
    else
      echo "offbox: Go repair failed ($*); continuing because this run doesn't use Go" >&2
    fi
    exit 97
  }
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
    curl -fsSL --retry 3 @GO_ARCHIVE_CURL_LIMITS@ "https://go.dev/dl/${_offbox_version}.linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" -o "$_offbox_stage/go.tgz" || _offbox_fail 'official archive download failed'
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
) || {
  if [ "${_offbox_needs_go:-1}" = 1 ]; then echo offbox-setup-failed >&2; exit 97; fi
}'''.replace('@GO_ARCHIVE_CURL_LIMITS@', GO_ARCHIVE_CURL_LIMITS)

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

# Root processes can write foreign-owned leaf files inside user-owned buckets,
# so checking only cache parents misses poisoned entries.
CACHE_OWNER_REPAIR = r'''(
  _offbox_user=$(id -un) || exit 0
  _offbox_group=$(id -gn) || exit 0
  _offbox_box=__OFFBOX_BOX__
  for _offbox_root in "$HOME/.npm" "$HOME/.cache" "$HOME/.local/share/pnpm" "$HOME/.yarn"; do
    [ -d "$_offbox_root" ] && [ ! -L "$_offbox_root" ] || continue
    _offbox_owner=$(find "$_offbox_root" ! -user "$_offbox_user" -printf '%u\n' -quit 2>/dev/null)
    [ -n "$_offbox_owner" ] || continue
    if sudo -n chown -h -R "$_offbox_user:$_offbox_group" -- "$_offbox_root" >/dev/null 2>&1; then
      echo "offbox: gave $_offbox_root back to $_offbox_user (foreign-owned entries left by an earlier run)" >&2
    else
      printf 'offbox: %s has entries owned by %s and sudo -n chown failed; run: offbox ssh %q -- sudo chown -h -R %q -- %q\n' \
        "$_offbox_root" "$_offbox_owner" "$_offbox_box" "$_offbox_user:$_offbox_group" "$_offbox_root" >&2
    fi
  done
) || true'''

# Warm boxes retain watchman roots across runs; exhaustion poisons the server until it restarts.
WATCH_REPAIR = r'''(
  _offbox_proc=${OFFBOX_INOTIFY_PROC_DIR:-/proc/sys/fs/inotify}
  _offbox_config=
  _offbox_failed=0
  for _offbox_limit in max_user_watches:524288 max_user_instances:1024; do
    _offbox_name=${_offbox_limit%:*}
    _offbox_floor=${_offbox_limit#*:}
    _offbox_value=$(cat "$_offbox_proc/$_offbox_name" 2>/dev/null) || continue
    case $_offbox_value in ''|*[!0-9]*) continue;; esac
    if [ "$_offbox_value" -lt "$_offbox_floor" ]; then
      _offbox_value=$_offbox_floor
      sudo -n sysctl -q -w "fs.inotify.$_offbox_name=$_offbox_value" >/dev/null 2>&1 || _offbox_failed=1
    fi
    _offbox_config="${_offbox_config}fs.inotify.$_offbox_name=$_offbox_value
"
  done
  if [ -n "$_offbox_config" ] &&
     [ "$(cat /etc/sysctl.d/90-offbox-inotify.conf 2>/dev/null)" != "${_offbox_config%$'\n'}" ]; then
    printf '%s' "$_offbox_config" | sudo -n tee /etc/sysctl.d/90-offbox-inotify.conf >/dev/null 2>&1 || _offbox_failed=1
  fi
  if [ "$_offbox_failed" -ne 0 ]; then
    echo 'offbox: inotify limit repair failed (sudo -n); continuing' >&2
  fi
  if command -v watchman >/dev/null 2>&1; then
    _offbox_watch=$(timeout 10 watchman watch-list 2>&1) || true
    case $_offbox_watch in
      *'Watchman needs your help'*|*poison*)
        # A healthy root path can contain these words. Keep JSON errors and surrounding diagnostics only.
        _offbox_watch=$(printf '%s' "$_offbox_watch" | python3 -c '
import json, sys
raw = sys.stdin.read()
for i, char in enumerate(raw):
    if char != "{":
        continue
    try:
        response, end = json.JSONDecoder().raw_decode(raw, i)
    except ValueError:
        continue
    if "roots" in response or "error" in response:
        raw = raw[:i] + str(response.get("error", "")) + raw[end:]
        break
print(raw)
' 2>/dev/null) || _offbox_watch=
        case $_offbox_watch in
          *'Watchman needs your help'*|*poison*)
            if timeout 10 watchman shutdown-server >/dev/null 2>&1; then
              echo 'offbox: watchman was poisoned (inotify limit); restarted it' >&2
            fi;;
        esac;;
    esac
  fi
) || true'''

SETUP_FAILED_MARKER = "offbox-setup-failed"
BOX_WEDGED_MARKER = "offbox-box-wedged"
COMMAND_STARTED_MARKER = "offbox-command-started:"
# boat's agent could not start the command's systemd scope: the box's systemd is broken and our script never ran.
# A stop + resume fixes it (bx_azff4qna 21 Oct, bx_z9u6f9c8 30 Oct).
SCOPE_FAILED = re.compile(r"^Failed to start transient scope unit: ")
# Go failing to read its own std tree (a box read glitch, not the user's code). User module paths never match.
GO_STD_GLITCH = re.compile(r"package (unsafe|internal/\S+|runtime(/\S+)?) is not in std \(/usr/local/go/src/|"
                           r"build constraints exclude all Go files in /usr/local/go/src/(internal|runtime|unsafe)\b")
STEP_RESULT = re.compile(r"offbox step (\d+) rc=(-?\d+): ")
STEP_RETRY = re.compile(r"^offbox-server: the server restarted while this run was going \(attempt \d+ is lost\); "
                        r"it is queued again as attempt \d+$")


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
    lines = [run_evidence.shell(BOUNDED_PROCESS),
             f'__offbox_evidence begin pid=$$ planned={len(steps)}',
             "__offbox_first=0", "__offbox_completed=0", "__offbox_current=0",
             # A graceful early exit must not look like a fully completed step run.
             "trap '[ \"$__offbox_completed\" -eq " + str(len(steps)) + " ] || exit 90' EXIT",
             *[f"trap '__offbox_evidence signal={name} step=$__offbox_current; exit 90' {name}"
               for name in ("HUP", "INT", "TERM")]]
    for n, step in enumerate(steps, 1):
        label = " ".join(step.split())[:60]
        lines += [f'__offbox_current={n}', f'__offbox_evidence start step={n}',
                  "(", "set -o pipefail", step, ")", "__offbox_rc=$?",
                  f'__offbox_evidence end step={n} rc=$__offbox_rc',
                  f'echo "offbox step {n} rc=$__offbox_rc: "{shlex.quote(label)} >&2 || exit 90',
                  f'__offbox_completed={n}',
                  '[ "$__offbox_rc" -eq 0 ] || [ "$__offbox_first" -ne 0 ] || __offbox_first=$__offbox_rc']
    lines.append('exit "$__offbox_first"')
    return "\n".join(lines)


def step_results(log_path: Path | None) -> list[tuple[int, int]]:
    """(step number, rc) for every step line the remote script printed into the run log."""
    if not log_path or not Path(log_path).exists():
        return []
    out = []
    for line in Path(log_path).read_text(errors="replace").splitlines():
        # Home retries append to the same stderr. Earlier attempts cannot supply a missing result.
        # The server note precedes even a retry that never reaches our command preamble.
        if line.startswith(COMMAND_STARTED_MARKER) or STEP_RETRY.fullmatch(line):
            out.clear()
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


def missing_step_count(results: list[tuple[int, int]], planned: int) -> int:
    return len(set(range(1, planned + 1)) - {n for n, _ in results})


def checked_steps_code(log_path: Path | None, planned: int, code: int | None, *, report: bool = True) -> int | None:
    missing = missing_step_count(step_results(log_path), planned)
    if missing:
        if report:
            say(f"steps incomplete: got {planned - missing} of {planned} step results; remote exit unknown")
        return None
    return steps_exit(log_path, planned) if planned and code in (None, 0) else code


def planned_steps(run) -> int:
    return int(run['step_count'] or 0) if 'step_count' in run.keys() else 0


def argument_list_failure(run, path: Path, *, report: bool) -> bool:
    try:
        text = path.read_text(errors='replace')
    except OSError:
        return False
    if (COMMAND_STARTED_MARKER in text or run_evidence.PREFIX in text
            or not re.search(r'^.*boatd-wrap: line \d+: .*Argument list too long$', text, re.M)
            or any(STEP_RETRY.fullmatch(line) for line in text.splitlines())
            or 'Error: Command not executable' not in text):
        return False
    if report:
        size = run['cmd_bytes'] if 'cmd_bytes' in run.keys() else None
        detail = f', {size} bytes' if size is not None else ', command bytes unavailable'
        say(f'the box could not start the command (argument list too long{detail}); '
            'update offbox or run a script file; a single argument over 128 KiB needs its contents '
            'in a file read by the command')
    return True


def settled_steps_code(run, code: int | None, *, log_path: Path | None = None, planned: int | None = None,
                       locked: bool = False, until: float | None = None, catch_up: bool = True,
                       report: bool = True, history_result: str | None = None,
                       report_start_failure: bool = True) -> int | None:
    """Completion requires evidence from every step, even when a process/receipt says zero.

    Reuse history catch-up before rejecting a partial follow, including for a process whose
    row is still active. The caller has already established that the process ended.
    """
    if dict(run).get('status') == 'killed':
        return dict(run).get('exit_code') or (143 if dict(run).get('process_id') else 130)
    path = log_path or LOGS_DIR / f"{run['run_id']}.log"
    from .misc import _raw_log
    disk = offbox_disk_space.result(_raw_log(path), code)
    if disk.get('infra_failure') not in (None, 'disk_probe'):
        return code
    planned = planned_steps(run) if planned is None else planned
    remote_handle = any(run[k] for k in ('command_id', 'process_id', 'wrapper_pid') if k in run.keys())
    history_identity = bool(run['box_id'] if 'box_id' in run.keys() else None) and bool(
        (run['command_id'] if 'command_id' in run.keys() else None) or
        (run['mode'] if 'mode' in run.keys() else None) == 'bg' and remote_handle)
    unsettled = (run['status'] if 'status' in run.keys() else 'running') in ('starting', 'running')
    recover_plain = (not planned and code == EXIT_INFRA and unsettled and history_identity and
                     (catch_up or history_result is not None))
    if not planned and disk.get('infra_failure') != 'disk_probe' and not recover_plain:
        return 126 if code in (None, 126) and argument_list_failure(run, path, report=report and report_start_failure) else code
    known = run['known_exit_code'] if 'known_exit_code' in run.keys() else None
    if known not in (None, 0) and code in (None, 0):
        code = known
    result = history_result
    if catch_up and (api.BACKEND == 'server' or missing_step_count(step_results(path), planned) or
                     disk.get('infra_failure') == 'disk_probe' or recover_plain):
        from .misc import _catch_up_log
        budget = 10 if until is None else min(10, max(0, until - now()))
        result = _catch_up_log(dict(run, status='done'), budget=budget, locked=locked)
        if until is not None and now() >= until:
            raise OffboxError(f"--timeout reached; wait again: offbox wait {run['run_id']}", code=EXIT_WAIT_TIMEOUT)
    path = _raw_log(path)
    # Complete old markers cannot prove the final attempt when the host's appended retry note is unread.
    history_incomplete = (api.BACKEND == 'server' and run['command_id'] and result is not None
                          and result not in ('complete', 'caught_up'))
    if code in (None, 126) and not history_incomplete and argument_list_failure(run, path, report=report and report_start_failure):
        return 126
    probe_record = offbox_disk_space.result(path, code)
    probe_crashed = probe_record.get('infra_failure') == 'disk_probe'
    if probe_crashed or recover_plain:
        try:
            with path.open(errors='replace') as output:
                command_started = any(line.startswith(COMMAND_STARTED_MARKER) for line in output)
        except OSError:
            command_started = False
        if (not command_started and 'disk_attempt' not in probe_record and
                (result not in (None, 'complete', 'caught_up') or remote_handle and result is None)):
            raise OffboxError(f"{run['run_id']}: disk probe evidence is incomplete; command execution is unknown. "
                              f"Use offbox wait {run['run_id']}; do not rerun the command.", code=EXIT_INFRA)
    if probe_crashed:
        return EXIT_INFRA
    if not planned:
        return code
    checked = checked_steps_code(path, planned, code, report=report)
    if history_incomplete:
        if report and checked is not None:
            say('steps incomplete: final attempt output unavailable; remote exit unknown')
        checked = None
    if checked is None and code not in (None, 0) and known is None:
        # A missing tail can be recovered later; it must never erase a known failure.
        try:
            with contextlib.closing(db()) as con:
                con.execute('UPDATE runs SET known_exit_code=COALESCE(known_exit_code,?) WHERE run_id=?',
                            (code, run['run_id']))
        except sqlite3.Error as error:
            save_run_state(run['run_id'], known_exit_code=code)
            state_warning(run['run_id'], None, error)
    return checked


def setup_failed(log_path: Path | None) -> bool:
    return bool(log_path) and Path(log_path).exists() and SETUP_FAILED_MARKER in Path(log_path).read_text(errors="replace")


NO_NODE_MODULES_MARKER = "OFFBOX_NO_NODE_MODULES"
DEPS_CONTEXT_MARKER = "offbox-missing-deps-context: "


def missing_deps_hint(root: Path, *, cwd: Path | None = None, repo_root: Path | None = None) -> str:
    target = node_tools.install_root(root, repo_root)
    install = node_tools.install_from(root, cwd or root, repo_root)
    node = node_version.want(repo_root or root, root)
    requirement = ""
    if node:
        ranges, label = node
        if len(ranges) == 1 and ranges[0][1] == ranges[0][0] + 1:
            version = ranges[0][0]
            exact = f"{version // 1_000_000}.{version // 1_000 % 1_000}.{version % 1_000}"
            requirement = f" Use Node v{exact} exactly ({label})."
        else:
            requirement = f" Use Node matching {label}."
    requirement += package_manager.version_note(target)
    return ("no node_modules on this box yet (fresh or pruned box). Install deps and run the command in the same call: "
            f"offbox run -- {shlex.quote(install + ' && <command>')}; offbox save --default afterwards keeps them."
            + requirement + " Check the repo's CI install flags and manager version before running.")


def box_deps_hint(root: Path, log_path: Path | None) -> str:
    # Only the remote marker proves absence: the Mac's node_modules is never synced.
    try:
        lines = log_path.read_text(errors="replace").splitlines() if log_path else []
        marked = NO_NODE_MODULES_MARKER in lines
    except OSError:
        marked = False
    if not marked:
        return ""
    package, cwd = root, root
    for line in lines:
        if not line.startswith(DEPS_CONTEXT_MARKER):
            continue
        try:
            package_rel, cwd_rel = json.loads(line[len(DEPS_CONTEXT_MARKER):])
            candidate = (root / package_rel).resolve()
            command_cwd = (root / cwd_rel).resolve()
            if candidate.is_relative_to(root.resolve()) and command_cwd.is_relative_to(root.resolve()):
                package, cwd = candidate, command_cwd
        except (ValueError, TypeError, OSError):
            pass
    return missing_deps_hint(package, cwd=cwd, repo_root=root)


def repo_setup_failed(code: int | None, log_path: Path | None) -> bool:
    return (code == EXIT_REPO_SETUP and bool(log_path) and Path(log_path).exists()
            and REPO_SETUP_FAILED_MARKER in Path(log_path).read_text(errors="replace").splitlines())


def _wedged_line(text: str) -> str | None:
    lines = text.splitlines()
    if COMMAND_STARTED_MARKER in text:
        return None
    return next((line for line in lines if line.startswith(BOX_WEDGED_MARKER + ': ')), None)


def box_wedged(log_path: Path | None) -> str | None:
    """Diagnostic only: a merged display log is not sufficient to authorize retry."""
    if log_path and Path(log_path).exists():
        return _wedged_line(Path(log_path).read_text(errors="replace"))
    return None


def settle_box_wedged(con, run, code):
    """Only a confirmed pre-command marker plus exit 97 permits moving off a box. Caller holds its box lock."""
    if code != 97 or not run:
        return None
    run = restore_run_state(run)
    # A local start fence rules out retry even when command history is unavailable.
    try:
        if run['log_path'] and COMMAND_STARTED_MARKER in Path(run['log_path']).read_text(errors='replace'):
            return None
    except OSError:
        pass
    # Display logs interleave streams and may split/glue a marker around stdout chunks. Only complete stderr
    # from offset zero authorizes retry; neither a merged log nor a status tail can prove the command never ran.
    if not run['command_id']:
        return None
    text, offset = '', 0
    # Errors leave the active row intact so a later refresh can still quarantine the box.
    for _ in range(8):
        page = api.history_logs(run['box_id'], run['command_id'], 'stderr', offset)
        text += page.get('data') or ''
        if COMMAND_STARTED_MARKER in text:
            return None
        if page.get('done'):
            evidence = _wedged_line(text)
            break
        nxt = page.get('nextOffset')
        if not nxt or nxt <= offset:
            raise OffboxError(f"{run['run_id']}: exit 97 needs complete stderr before settlement; retry")
        offset = nxt
    else:
        raise OffboxError(f"{run['run_id']}: exit 97 stderr exceeded the settlement page limit; retry")
    if not evidence:
        return None
    stopped = lease.set_aside(con, run['box_id'], 'box-wedged', evidence, run_id=run['run_id'])
    return evidence, stopped


def wedged_message(box, evidence, stopped, retry=False):
    after = 'stopped and set aside' if stopped else 'set aside (stop could not be confirmed)'
    return (f"{box} is wedged ({evidence}); {after} (offbox list --all shows it). "
            + ('Nothing ran there; running on another box' if retry else 'Nothing ran: retry'))


class BoxWedged(OffboxError):
    def __init__(self, box, evidence, stopped):
        super().__init__(wedged_message(box, evidence, stopped), code=EXIT_INFRA)
        self.box, self.evidence, self.stopped = box, evidence, stopped


def scope_failed(log_path: Path | None) -> bool:
    """True when the run's only output is boat's scope error: nothing of ours ran."""
    if not log_path or not Path(log_path).exists():
        return False
    lines = [ln for ln in Path(log_path).read_text(errors="replace").splitlines() if ln.strip()]
    return bool(lines) and all(SCOPE_FAILED.match(ln) for ln in lines)


# A measured 123,144-byte Crpko script became a 139,882-byte POST after quoting.
# Old home wrappers exec that whole POST as one argument (Linux limit 131,072,
# including NUL). Reserve 28 KiB for backend wrapping; measure the final POST.
COMMAND_INLINE_MAX = 100 * 1024


def command_payload(script: str, run_id: str, *, claim_id: str | None = None) -> tuple[str, str | None]:
    command = exit_recording_command(script, run_id, claim_id=claim_id)
    path = None
    if len(command.encode()) > COMMAND_INLINE_MAX:
        path = f"/home/user/.offbox/cmd/{claim_id or run_id}.sh"
        command = exit_recording_command(script, run_id, claim_id=claim_id, script_file=path)
    if len(command.encode()) > COMMAND_INLINE_MAX:
        raise OffboxError(f"command is {len(command.encode())} bytes, over the box start limit; "
                          "put the steps in a script file and run it; a single argument over 128 KiB needs its contents "
                          "in a file read by the command", code=2)
    return command, path


def exit_recording_command(script: str, run_id: str, *, claim_id: str | None = None,
                           script_file: str | None = None) -> str:
    """Run the remote script under a parent shell that writes its exit code to ~/.offbox/exit/<run>.rc,
    so a run boat later reports as lost still has its real status on the box."""
    f = f'"$HOME/.offbox/exit/{run_id}.rc"'
    dk = f'"$HOME/.offbox/exit/{run_id}.dk"'
    persist = '\n'.join([
        'mkdir -p "$HOME/.offbox/exit" || exit 1',
        f'printf "%s\\n" "$1" > {f}.tmp && mv -f {f}.tmp {f}',
        *(["rm -f -- " + shlex.quote(script_file),
           'find "$HOME/.offbox/cmd" -name "*.sh" -mtime +2 -delete'] if script_file else []),
        'find "$HOME/.offbox/exit" \\( -name "*.rc" -o -name "*.dk" -o -name "*.pid" -o -name "*.gate" '
        '-o -name "*.trace" -o -name "*.containers.json" -o -name "*.containers.tmp" \\) -mtime +2 -delete',
    ])
    # Filesystem calls after the preamble are just as capable of wedging as restore's flock/load. The helper
    # owns no run output descriptors and is abandoned at its deadline even if its children cannot be killed.
    persist_block = ('python3 - "$__offbox_rc" <<\'OFFBOX_EXIT_RECORD\'\n' + BOUNDED_PROCESS
                     + f"\nbounded(['bash', '-c', {persist!r}, 'offbox-exit-record', sys.argv[1]], 2)\n"
                     + 'OFFBOX_EXIT_RECORD')
    claim_id = claim_id or run_id
    marker = ('mkdir -p "$HOME/.offbox/claim" || exit 97; '
              f'mkdir "$HOME/.offbox/claim/{claim_id}" 2>/dev/null || exit 98; '
              f'printf "%s\\n" "$1" > "$HOME/.offbox/claim/{claim_id}/pid" || exit 97; '
              f'date +%s > "$HOME/.offbox/claim/{claim_id}/epoch" || exit 97; '
              'mkdir -p "$HOME/.offbox/exit" && '
              f'printf "%s\\n" "$1" > "$HOME/.offbox/exit/{run_id}.pid"')
    # Pass the wrapper's PID: the supervised writer has a different PID and may outlive its deadline.
    marker_block = ('python3 - "$$" <<\'OFFBOX_PID_RECORD\'\n' + BOUNDED_PROCESS
                    + f"\nrc, _ = bounded(['bash', '-c', {marker!r}, 'offbox-pid-record', sys.argv[1]], 2)\n"
                    + 'sys.exit(rc)\nOFFBOX_PID_RECORD')
    execute = 'bash -l ' + shlex.quote(script_file) if script_file else 'bash -lc "$0"'
    if api.BACKEND == 'boat':
        # Retained command history can lag exit; keep both streams on the live box before its idle TTL changes.
        execute = '\n'.join([
            'mkdir -p "$HOME/.offbox/out"',
            f'__offbox_output="$HOME/.offbox/out/{run_id}"',
            ': > "$__offbox_output.stdout"; : > "$__offbox_output.stderr"',
            'exec {__offbox_stdout}>&1 {__offbox_stderr}>&2',
            'exec > >(tee -a "$__offbox_output.stdout"); __offbox_out_pid=$!',
            'exec 2> >(tee -a "$__offbox_output.stderr" >&2); __offbox_err_pid=$!',
            execute,
            '__offbox_rc=$?',
            'exec 1>&$__offbox_stdout 2>&$__offbox_stderr',
            'exec {__offbox_stdout}>&- {__offbox_stderr}>&-',
            # Close both pipes before waiting, so the receipt cannot race the last buffered stderr line.
            '__offbox_drain() {',
            '  for _ in 1 2 3 4 5 6 7 8 9 10; do',
            '    kill -0 "$1" 2>/dev/null || return 0',
            '    sleep 0.05',
            '  done',
            '  kill "$1" 2>/dev/null || :',
            '}',
            '__offbox_drain "$__offbox_out_pid"',
            '__offbox_drain "$__offbox_err_pid"',
        ])
    else:
        execute += '\n__offbox_rc=$?'
    outer = "\n".join([
        f'export OFFBOX_RUN_ID={shlex.quote(run_id)}',
        run_evidence.shell(BOUNDED_PROCESS),
        "__offbox_signal() {",
        '__offbox_evidence "signal=$1"',
        '__offbox_rc=$2',
        persist_block,
        'exit "$__offbox_rc"',
        "}",
        marker_block,
        '__offbox_rc=$?',
        'if [ "$__offbox_rc" = 98 ]; then',
        f'  rm -f "$HOME/.offbox/env/{claim_id}.env"; echo offbox-claim-refused >&2; exit 98',
        'fi',
        'if [ "$__offbox_rc" -ne 0 ]; then',
        '  echo "offbox-box-wedged: run marker setup failed or did not finish in 2s (exit directory/PID write)" >&2',
        '  __offbox_rc=97',
        'else',
        # A duplicate/unconfirmed claimant must never write the owner's receipt from a signal handler.
        *[f"trap '__offbox_signal {name} {code}' {name}"
          for name, code in (("HUP", 129), ("INT", 130), ("TERM", 143))],
        '__offbox_t0=$(date +%s)',
        '__offbox_evidence wrapper pid=$$',
        execute,
        'fi',
        persist_block,
        # Whether a container started during the run (events, since testcontainers removes its own): only then
        # does the box get the longer Docker idle window. <run>.dk holds "1" (a container started) or "0" (the query
        # answered, or dockerd is plainly inactive: none did). No file = unknown (failed/odd dockerd state, timeout,
        # error): offbox keeps the Docker window.
        # dockerd is only asked while it runs: the docker CLI would socket-activate it on every run otherwise.
        # Exit 97 may be a pre-command wedged-Docker failure. Keep usage unknown, without another Docker call.
        'if [ "$__offbox_rc" != 97 ]; then',
        'if systemctl is-active --quiet docker 2>/dev/null; then',
        '  __offbox_ev=$(timeout 5 docker events --since "$__offbox_t0" --until "$(( $(date +%s) + 1 ))" '
        '--filter type=container --filter event=start --format x 2>/dev/null) && '
        f'{{ [ -n "$__offbox_ev" ] && echo 1 || echo 0; }} > {dk} 2>/dev/null',
        'elif [ "$(systemctl is-active docker 2>/dev/null)" = inactive ]; then',
        f'  echo 0 > {dk} 2>/dev/null',
        'fi',
        'fi',
        'exit "$__offbox_rc"',
    ])
    if script_file:
        return "bash -c " + shlex.quote(outer)
    return "bash -c " + shlex.quote(outer) + " " + shlex.quote(script)


def recorded_exit(box_id: str, run_id: str, timeout: float = 20) -> int | None:
    """None means no file. Failed SSH or an unreadable exit is unknown and must not free the box."""
    try:
        p = ssh_sync.ssh(box_id, f'if test -e "$HOME/.offbox/exit/{run_id}.rc"; then '
                        f'cat "$HOME/.offbox/exit/{run_id}.rc"; else exit 44; fi', timeout=timeout)
    except (OSError, subprocess.TimeoutExpired, OffboxError) as e:
        raise OffboxError(f"exit file unreadable on {box_id}: {e}", started=True) from e
    if p.returncode == 44:
        return None
    if p.returncode == 0:
        try:
            return int(p.stdout.decode(errors="replace").strip())
        except ValueError:
            pass
    raise OffboxError(f"exit file unreadable on {box_id} (ssh exit {p.returncode})", started=True)


def remote_alive(box_id: str, run_id: str, timeout: float = 20) -> str | None:
    """One bounded SSH read; missing legacy markers and failed SSH remain unknown."""
    base = f'"$HOME/.offbox/exit/{run_id}'
    cmd = (f'if test -f {base}.rc"; then echo ended; '
           f'elif p=$(cat {base}.pid" 2>/dev/null); then '
           'case "$p" in ""|*[!0-9]*|0|1) echo unknown;; *) '
           'if kill -0 "$p" 2>/dev/null; then echo alive; else echo gone; fi;; esac; '
           'else echo unknown; fi')
    try:
        p = ssh_sync.ssh(box_id, cmd, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired, OffboxError):
        return None
    result = p.stdout.decode(errors="replace").strip()
    return result if p.returncode == 0 and result in ("ended", "alive", "gone") else None


def confirmed_lost(box_id: str, run_id: str, timeout: float = 20, *, record: bool = True,
                   check_box: bool = False) -> dict | None:
    """Check retained history, then .rc, then liveness. None keeps the run reserved (alive or unknown)."""
    deadline = now() + timeout

    def left():
        remaining = deadline - now()
        if remaining <= 0:
            raise OffboxError(f"lost confirmation timed out on {box_id}", started=True)
        return remaining

    con = db()
    try:
        if record:
            con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (f'lost_checked:{run_id}', '1'))
            con.commit()
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        if row:
            row = restore_run_state(row)
        history_unknown = False
        if row and row['command_id']:
            try:
                # Leave time for the independent SSH evidence even if the tracker hangs.
                with api.budget(min(5, left() / 2)):
                    code = (api.history_get(box_id, row['command_id']) or {}).get('exitCode')
            except OffboxError as e:
                history_unknown = not (isinstance(e, api.ApiError) and e.status == 404)
                code = None
            left()
            if code is not None:
                return dict(status='exited', running=False, exitCode=code)
        if check_box:
            # A follower owns the box lock, so it must detect a stopped/deleted box without the reaper.
            try:
                with api.budget(min(5, left() / 2)):
                    box = api.get(box_id, deadline=now() + min(5, left() / 2))
                left()
            except OffboxError:
                box = {'state': 'unknown'}
            if box is None or box.get('state') in (*api.STOPPED_STATES, 'error', 'cancelled'):
                if history_unknown:
                    return None
                if record:
                    con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'lost_confirmed:{run_id}', 'box'))
                    con.commit()
                return dict(status='lost', running=False, exitCode=None)
        code = recorded_exit(box_id, run_id, timeout=left())
        left()
        if code is not None:
            return dict(status='exited', running=False, exitCode=code)
        alive = remote_alive(box_id, run_id, timeout=left())
        left()
        if alive in ('gone', 'ended'):
            # The wrapper can publish .rc and exit between remote_alive's first file test and kill -0.
            code = recorded_exit(box_id, run_id, timeout=left())
            left()
            if code is not None:
                return dict(status='exited', running=False, exitCode=code)
        if alive == 'gone':
            if history_unknown:
                return None
            if record:
                con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (f'lost_confirmed:{run_id}', '1'))
                con.commit()
            return dict(status='lost', running=False, exitCode=None)
        if alive == 'alive' and record:
            cur = con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (f'lost_spurious:{run_id}', '1'))
            con.commit()
            if cur.rowcount:
                event(con, box_id, 'run_lost_spurious', run_id)
        # 'ended' can race the first read: leave it active and read .rc on the next probe.
        return None
    finally:
        con.close()


def reconcile_lost(con, box_id: str, timeout: float = 20, state: str | None = None,
                   until: float | None = None, *, foreign: bool = False) -> None:
    """Under box-<id>: repair old lost rows before following or handing their box to another run."""
    rows = con.execute("SELECT * FROM runs WHERE box_id=? AND status='lost' AND exit_code IS NULL "
                       "AND NOT EXISTS (SELECT 1 FROM kv WHERE k='lost_confirmed:' || runs.run_id)",
                       (box_id,)).fetchall()
    if not rows:
        return
    deadline = now() + timeout
    if state is None:
        try:
            with api.budget(timeout):
                box = api.get(box_id)
            state = box.get('state') if box else None
        except OffboxError:
            state = 'unknown'
    if state == 'unknown':
        # A formerly lost row must reserve the lease while its box cannot be checked.
        con.execute("UPDATE runs SET status='running',end_at=NULL WHERE box_id=? AND status='lost' AND exit_code IS NULL "
                    "AND NOT EXISTS (SELECT 1 FROM kv WHERE k='lost_confirmed:' || runs.run_id)", (box_id,))
        con.commit()
        return
    if state in (*api.STOPPED_STATES, 'error', 'cancelled') or state is None:
        con.executemany('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)',
                        [(f"lost_confirmed:{r['run_id']}", '1') for r in rows])
        con.commit()
        return
    if state not in api.LIVE_STATES:
        return
    for row in rows:
        try:
            st = confirmed_lost(box_id, row['run_id'], max(0, deadline - now()))
        except OffboxError:
            st = None
        if st and st['status'] == 'lost':
            con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (f"lost_confirmed:{row['run_id']}", '1'))
        else:
            code = st['exitCode'] if st else None
            status = ('done' if code == 0 else 'failed') if st else 'running'
            if code == 97:
                # The quarantine service only settles active rows, so restore its reservation first.
                con.execute("UPDATE runs SET status='running',end_at=NULL WHERE run_id=? AND status='lost' AND exit_code IS NULL",
                            (row['run_id'],))
                con.commit()
                with api.budget(max(0, deadline-now())):
                    wedged = settle_box_wedged(con, row, code)
                if wedged:
                    say(wedged_message(box_id, *wedged))
                    continue
            if st and row['pulls']:
                do_pulls(box_id, dict(row), json.loads(row['pulls']), until=until, foreign=foreign)
            if until is not None and now() >= until:
                raise OffboxError(f"lost reconciliation timed out on {box_id}", code=EXIT_WAIT_TIMEOUT, started=True)
            if st:
                code = finish(row['run_id'], code, status, until=until, run=row, bookkeeping=False, report=True)
                if planned_steps(row):
                    status = 'infra' if code is None else ('done' if code == 0 else 'failed')
            else:
                con.execute("UPDATE runs SET status=?,exit_code=?,end_at=?,error=NULL WHERE run_id=? "
                            "AND status IN ('lost','running') AND exit_code IS NULL",
                            (status, code, None, row['run_id']))
            try:
                event(con, box_id, 'run_reattached', f"{row['run_id']} {status} exit={code}")
            except sqlite3.Error as error:
                if not st:
                    raise
                state_warning(row['run_id'], code, error)
        con.commit()
        if st and st.get('exitCode') is not None:
            try:
                settle_docker(con, row, status, timeout=10 if until is None else max(0, until-now()))
                from .misc import _catch_up_finished
                _catch_up_finished(con, row['run_id'], budget=10 if until is None else max(0, until-now()))
            except sqlite3.Error as error:
                state_warning(row['run_id'], code, error)


def steps_exit(log_path: Path | None, planned: int) -> int | None:
    """For --step runs: the first nonzero step rc (else 0), but only when every planned step reported."""
    if planned <= 0:
        return None
    res = dict(step_results(log_path))
    if missing_step_count(list(res.items()), planned):
        return None
    return next((res[n] for n in range(1, planned + 1) if res[n] != 0), 0)


def containers_seen(box_id: str, run_id: str, timeout: float = 10) -> bool:
    """False only when the run's wrapper got an answer from dockerd and no container started during the run."""
    try:
        p = ssh_sync.ssh(box_id, f'cat "$HOME/.offbox/exit/{run_id}.dk" 2>/dev/null || echo unknown', timeout=timeout)
    except (OSError, subprocess.TimeoutExpired, OffboxError):
        return True
    return not (p.returncode == 0 and p.stdout.decode(errors="replace").strip() == "0")


def settle_docker(con, run, status: str, timeout: float = 10) -> None:
    """A run that only mentioned Docker (command or manifest) and started no container loses runs.docker, so its
    box gets the ordinary idle window. Runs that didn't end normally keep it."""
    java_version.record(con, run, LOGS_DIR / (run["run_id"] + ".log"), api.BACKEND)
    started = time.monotonic()
    if status in ('done', 'failed', 'killed', 'lost', 'interrupted', 'infra'):
        containers.record(con, run, BOUNDED_PROCESS, timeout=timeout)
    timeout = max(0, timeout - (time.monotonic() - started))
    if timeout > 0 and run["docker"] and run["box_id"] and status in ("done", "failed") and not containers_seen(
            run["box_id"], run["run_id"], timeout=min(10, timeout)):
        con.execute("UPDATE runs SET docker=0 WHERE run_id=?", (run["run_id"],))
        con.commit()


def recover_lost_exit(box_id: str, run_id: str, log_path: Path | None, planned: int,
                      timeout: float = 20) -> tuple[int | None, str]:
    """A lost process can still have its exit on disk, in step results or in retained command history.
    Failure to read history propagates, keeping the active row available for later reconciliation."""
    deadline = time.monotonic() + timeout
    con = db()
    try:
        row = con.execute('SELECT command_id FROM runs WHERE run_id=?', (run_id,)).fetchone()
        confirmed = con.execute('SELECT v FROM kv WHERE k=?', (f'lost_confirmed:{run_id}',)).fetchone()
    finally:
        con.close()
    # Only box-state confirmation rules out SSH: a dead PID's saved exit can still be read on a live box.
    stopped = confirmed and confirmed['v'] == 'box'
    code = None if stopped else recorded_exit(box_id, run_id, timeout=timeout)
    if code is not None:
        return code, "the box's exit file"
    code = steps_exit(log_path, planned)
    if code is not None:
        return code, "the step results"
    if row and row['command_id']:
        try:
            with api.budget(max(0, deadline - time.monotonic())):
                code = (api.history_get(box_id, row['command_id']) or {}).get('exitCode')
        except api.ApiError as e:
            if not (stopped and e.status == 404):
                raise
            code = None
        if code is not None:
            return code, 'retained command history'
    return None, ""


def log_probe_error(run_id, reason):
    metadata = offbox_disk_space.client_metadata()
    saved = read_json(LOGS_DIR / f'{run_id}.state.json', {})
    metadata['client_started_at'] = saved.get('client_started_at', metadata['client_started_at'])
    detail = dict(event='run.disk_probe_error', run_id=run_id, disk_probe_error=reason, **metadata)
    line = offbox_disk_space.PROBE_INVALID
    # Recovery paths can read the same log repeatedly; one diagnosis per run is enough.
    client = LOGS_DIR / f'{run_id}.client.log'
    try:
        if client.exists() and line in client.read_text(errors='replace'):
            return
        client.parent.mkdir(parents=True, exist_ok=True)
        with client.open('a') as output:
            output.write(line + '\n' + json.dumps(detail) + '\n')
        log(line + ' ' + json.dumps(detail))
        import toollog
        toollog.emit('run', 'run.disk_probe_error', ids={'run': run_id},
                     props=dict(metadata, infra_failure='disk_probe', infra_reason='probe_crashed',
                                errorClass=reason.partition(':')[0] if ':' in reason else 'ProbeError'),
                     kind='error', ok=False, tag='disk_probe')
    except Exception:
        pass


def space_result(run_id, code, path=None, *, report=False):
    from .misc import _raw_log
    record = offbox_disk_space.result(_raw_log(path or LOGS_DIR / f'{run_id}.log'), code)
    if record.get('disk_probe_error'):
        log_probe_error(run_id, record['disk_probe_error'])
    previous = read_json(LOGS_DIR / f'{run_id}.state.json', {})
    # A missing/incomplete local log must not erase disk evidence already recorded for this exit.
    same_exit = code is not None and previous.get('wrapper_exit_code') == code
    probe_exit = code in (None, EXIT_INFRA) and previous.get('infra_failure') == 'disk_probe'
    if (not record['disk_space'] and not record['infra_failure'] and 'disk_attempt' not in record and
            (same_exit or probe_exit)):
        record.update({k: v for k, v in previous.items() if k in record or
                       k == 'disk_probe_error' or k.startswith(('tmp_', 'var_tmp_', 'home_', 'workspace_'))})
    if previous.get('disk_probe_error') and 'disk_probe_error' not in record:
        record['disk_probe_error'] = None
    if any(previous.get(k) != v for k, v in record.items()):
        try:
            save_run_state(run_id, **record)
        except OSError as error:
            state_warning(run_id, code, error)
        if record['disk_space'] or record['infra_failure']:
            try:
                import toollog
                toollog.emit('run', 'run.disk_space', ids={'run': run_id}, props=record,
                             kind='error' if record['infra_failure'] else 'event',
                             ok=not bool(record['infra_failure']), tag=record['infra_failure'])
            except Exception:
                pass
    if record.get('infra_failure'):
        if report:
            say(offbox_disk_space.message(record))
        return EXIT_INFRA
    return code


def report_exit(cmd: str, code: int | None, step_res: list[tuple[int, int]] | None = None, planned: int = 0,
                where: str = "remote", deps_hint: str = "", box_id: str | None = None) -> None:
    """Always the last offbox line, so a caller's own `| tail` / `; echo` can't be mistaken for it."""
    if step_res is not None:
        say(steps_summary(step_res, planned))
    if code == 1 and last_stage_is_grep(cmd):
        say("exit 1 may be from the trailing grep (no match) or an earlier stage. Use --step for each command.")
    if code == 137 or any(rc == 137 for _, rc in (step_res or [])):
        say("exit 137 = the box killed the command for memory. Rerun with --size xlarge.")
    failed_code = next((rc for _, rc in (step_res or []) if rc), code)
    if (where == "remote" and code != 127 and failed_code != 127 and deps_hint
            and (code not in (0, None) or any(rc != 0 for _, rc in (step_res or [])))):
        say(deps_hint)
    if code is None:
        hint = f"; inspect with offbox ssh {box_id}" if box_id else ""
        say("remote exit unknown (process lost); offbox exits 90" + hint)
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
                  steps: list[str] | None = None, node: str = "", wait_images: bool = False,
                  image_wait: int = 180, repo_key: str = "", repo_root: Path | None = None,
                  preserve_containers: str = 'private lease', box_id: str = "<box>",
                  usage: command_usage.Usage | None = None, template: str = "") -> str:
    cmd = steps_block(steps) if steps else command_block(
        argv[0] if len(argv) == 1 else " ".join(shlex.quote(a) for a in argv))
    if api.BACKEND == 'server':
        try:
            cmd = resources.wrap(cmd, BOUNDED_PROCESS)
        except Exception:
            pass
    cd = f"$HOME/{rdir}" + (f"/{rel}" if rel and rel != "." else "")
    root = '"$HOME"/' + shlex.quote(rdir)
    usage = usage or command_usage.inspect(repo_root or Path.cwd(), rel, argv, steps)
    packages = usage.packages
    local_root = (repo_root or Path.cwd()).resolve()
    missing = ' '.join(
        f'{"if" if index == 0 else "elif"} '
        f'[ -f {root}/{shlex.quote(str(package.relative_to(local_root)))}/package.json ] && '
        f'[ ! -e {root}/{shlex.quote(str(package.relative_to(local_root)))}/node_modules ]; then '
        f'__offbox_deps_context={shlex.quote(json.dumps([str(package.relative_to(local_root)), str(usage.cwd.relative_to(local_root))]))};'
        for index, package in enumerate(packages))
    missing = missing + ' fi' if packages else ':'
    if usage.install:
        advice = ('printf "\\n%s\\n" "offbox: command exited $__offbox_exit and node_modules is still missing; "'
                  + shlex.quote(f"its own install step ({usage.install}) didn't run or didn't finish. The failing line is above.")
                  + ' >&2')
    else:
        advice = (f'printf "\\n%s%s\\n%s\\n" {shlex.quote(DEPS_CONTEXT_MARKER)} '
                  f'"$__offbox_deps_context" {NO_NODE_MODULES_MARKER} >&2')
    probe_command = ('/usr/bin/python3 -I -c ' + shlex.quote(
        'import base64,zlib,sys;exec(zlib.decompress(base64.b64decode(sys.argv.pop(1))))')
        + ' "$__obsp" "$@"')
    if offbox_disk_space.PROBE_PAYLOAD_ERROR:
        log_probe_error(run_id, offbox_disk_space.PROBE_PAYLOAD_ERROR)
    probe = '__obprobe'
    deps_check = (f'__offbox_exit=$?; {probe} end "$__obsw" || '
                  '{ echo "offbox-space-probe-error: end probe failed (exit $?)" >&2; }; '
                  'if [ "${__offbox_command_started:-0}" = 1 ] && [ "$__offbox_exit" = 127 ]; then '
                  'printf \'%s\\n\' \'offbox: exit 127: a command was not found on this box (see the "…: command not found" line above)\' >&2; fi; '
                  f'if [ "${{__offbox_command_started:-0}}" = 1 ] '
                  f'&& [ "$__offbox_exit" -ne 0 ] && [ "$__offbox_exit" -ne 127 ] && [ {int(usage.uses_js)} = 1 ] '
                  f'&& [ -f {root}/package.json ] && [ ! -e {root}/node_modules ] '
                  f'; then __offbox_deps_context=; {missing}; '
                  f'if [ -n "$__offbox_deps_context" ]; then {advice}; fi; fi; '
                  'if [ -n "${__offbox_bash_env:-}" ]; then rm -f -- "$__offbox_bash_env"; fi; exit "$__offbox_exit"')
    lines = ["set -a", f'[ -f "{env_file}" ] && . "{env_file}"; rm -f "{env_file}"' if env_file else ":", "set +a",
             f'export OFFBOX_RUN_ID={run_id}',
             f'export OFFBOX_BOX_ID={shlex.quote(box_id)}',
             '__obsp=' + shlex.quote(offbox_disk_space.probe_payload()),
             '__obprobe() { echo "offbox-space-probe: $1" >&2; ' + probe_command + '; }',
             f'__obsw="$HOME/{rdir}"',
              '__offbox_command_started=0',
              'trap ' + shlex.quote(deps_check) + ' EXIT',
              probe + ' start "$__obsw" || { __obprobe_rc=$?; [ "$__obprobe_rc" != 90 ] || exit 90; '
              'echo "offbox: disk-space probe failed (exit $__obprobe_rc); the command runs without disk evidence" >&2; }',
              userns.setup(api.BACKEND, box_id),
              SQLITE_SETUP,
              DOCKER_REPAIR,
              LDCACHE_REPAIR,
              CACHE_OWNER_REPAIR.replace('__OFFBOX_BOX__', shlex.quote(box_id)),
              WATCH_REPAIR,
              (f'OFFBOX_IMAGE_WAIT_SECONDS={image_wait}\n{IMAGE_WAIT}\nunset OFFBOX_IMAGE_WAIT_SECONDS'
               if wait_images else ':'),
              containers.script(run_id, BOUNDED_PROCESS, preserve=preserve_containers),
              f'cd "{cd}" || {{ echo "offbox: remote dir {cd} missing (did sync run?)" >&2; exit 97; }}',
              repo_setup_block(repo_key, rdir),
              f"_offbox_needs_go={int(usage.needs_go)}\n{GO_REPAIR}",
              node,
              node_tools.block(rdir, repo_root),
              java_version.block(java_version.trigger(repo_root or Path.cwd(), rel, argv, steps,
                                                       repo_key=repo_key, template=template)),
              ('''for _offbox_tool in terraform aws ruby vector gh; do
  if [ "$_offbox_tool" = terraform ] && [ "${OFFBOX_TERRAFORM_STATE:-}" = skipped ]; then continue; fi
  command -v "$_offbox_tool" >/dev/null || {
    echo "offbox: required tool missing on command PATH: $_offbox_tool" >&2
    echo offbox-repo-setup-failed >&2
    exit 98
  }
done''' if repo_key == "crpko-devops" else ':'),
              '__offbox_command_started=1',
              f'echo "{COMMAND_STARTED_MARKER} {run_id}" >&2',
              # Keep caller cd/exit/traps inside a subshell so the root check always runs.
              "(\n" + cmd + "\n)"]
    return "\n".join(lines)


def _source_present(root: Path, cwd: Path) -> None:
    for path in (root, cwd):
        try:
            present = stat.S_ISDIR(path.stat().st_mode)
        except (FileNotFoundError, NotADirectoryError):
            present = False
        if not present:
            raise common.SourceGone(path)
    try:
        os.getcwd()
    except FileNotFoundError:
        # A path can have been recreated while this process still holds its deleted inode.
        raise common.SourceGone(cwd) from None


class Runner:
    def __init__(self, a, me: dict):
        self.a, self.me = a, me
        self.run_id = home.take_invocation_run() or new_id("run")
        home.flush_routing(self.run_id)
        self.root = Path(me["repo_root"])
        recorded_cwd = None
        if os.environ.get(BACKGROUND_RUN_ENV):
            with contextlib.closing(db()) as con:
                row = con.execute('SELECT local_cwd,cwd FROM runs WHERE run_id=?', (self.run_id,)).fetchone()
                if row:
                    recorded_cwd = row['local_cwd'] or row['cwd']
        self.cwd = Path(recorded_cwd or os.getcwd()).resolve()
        try:
            self.rel = str(self.cwd.relative_to(self.root))
        except ValueError:
            self.rel = "."
        self.box = None
        self.queue_s = 0.0
        self.pid = None
        self.started = False
        self.registered = False
        self.remote_code = None
        self.recovered_code = None
        self.killed = False
        self.lease_row = None
        self.cold_boxes: set[str] = set()
        self.cold_moved = False
        self.push_resumed = False
        self.wait_images = False
        self.log_path = LOGS_DIR / f"{self.run_id}.log"

    def check_source(self, checkpoint):
        try:
            _source_present(self.root, self.cwd)
        except common.SourceGone as error:
            error.checkpoint = checkpoint
            raise

    def source_gone(self, error):
        message = f"{error} (queued {self.queue_s:.1f}s; box {self.box or 'none'})"
        error.args = (message,)
        with log_lock(self.run_id):
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open('ab') as stream:
                stream.write(f"offbox: {message}\n".encode())
                length = stream.tell()
            _commit(self.log_path, 0, 0, length)
        self.record(error=message)
        with contextlib.closing(db()) as con:
            with write(con):
                con.execute('DELETE FROM pool_cap_callers WHERE run_id=?', (self.run_id,))
            event(con, self.box, 'run_source_gone',
                  f'{self.run_id} checkpoint={error.checkpoint} queue_s={self.queue_s:.1f} box={self.box or "none"} {message}')
        finish(self.run_id, 2, 'source_gone', catch_up=False, bookkeeping=False)

    def _log_pool(self, con):
        import toollog
        for backend in ("server", "boat"):
            other = None
            try:
                counts = {"busy": 0, "idle": 0, "stopped": 0}
                source = con
                if backend != common.backend():
                    path = common.db_path_for(backend)
                    if path.exists():
                        other = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=.05)
                        source = other
                    else:
                        source = None
                if source is not None:
                    for state, active in source.execute("SELECT l.state, EXISTS(SELECT 1 FROM runs r WHERE r.box_id=l.box_id AND r.status IN ('starting','running')) FROM leases l WHERE l.state IN ('running','bringing_up','stopped','archived')"):
                        counts["busy" if active or state == "bringing_up" else "stopped" if state in ("stopped", "archived") else "idle"] += 1
                toollog.emit("pool", "pool.snapshot", ids={"run": self.run_id},
                             props=dict(counts, backend="home" if backend == "server" else "boat"))
            except Exception:
                toollog.emit("pool", "pool.snapshot", kind="error", ok=False, tag="pool_snapshot",
                             props={"backend": "home" if backend == "server" else "boat"})
            finally:
                if other is not None:
                    try:
                        other.close()
                    except Exception:
                        pass

    def record(self, **kw):
        def update():
            con = db()
            try:
                cols = ", ".join(f"{k}=?" for k in kw)
                con.execute(f"UPDATE runs SET {cols} WHERE run_id=?", (*kw.values(), self.run_id))
            finally:
                con.close()
        db_retry(update)

    def decide_size(self, con, cmd_text):
        a, me = self.a, self.me
        # Freeze the decision in the submitter; --bg serializes it with the args for the detached client.
        if not hasattr(a, '_size_decision'):
            a._size_decision = lease.auto_size(con, cmd_text, me, a.size)
            size, why = a._size_decision
            if why:
                say(f"NOTE run {self.run_id} will run on {size}" +
                    (f", not the --size {a.size} you asked for" if a.size and a.size != size else "") +
                    f": {why}")
        return a._size_decision

    def register_pending(self) -> None:
        if self.registered:
            return
        a, me = self.a, self.me
        steps = getattr(a, "steps", None) or []
        cmd_text = " ; ".join(steps) if steps else (shlex.join(a.cmd) if len(a.cmd) > 1 else a.cmd[0])
        con = db()
        existing = con.execute('SELECT * FROM runs WHERE run_id=?', (self.run_id,)).fetchone()
        if existing:
            try:
                if existing['client_pid'] != os.getpid() or not (
                        (a.bg and existing['mode'] == 'bg') or os.environ.get(home.RETURNED_HOME_ENV)):
                    raise OffboxError(f'{self.run_id}: queued run belongs to another client', code=EXIT_LOCAL)
                if existing['size_note'] is None:
                    # Pre-migration queued clients never saved a decision; the original argv is still available.
                    size, why = self.decide_size(con, cmd_text)
                    self.record(size=size, requested_size=a.size, size_note=why or '')
                    if why:
                        event(con, None, "size_override", json.dumps(dict(run_id=self.run_id, requested=a.size,
                                                                         effective=size, reason=why)))
                elif not hasattr(a, '_size_decision'):
                    # A queued run can be re-entered after a backend handoff with a freshly parsed argv.
                    a._size_decision = (existing['size'], existing['size_note'])
                self.registered = True
                return
            finally:
                con.close()
        size, why = self.decide_size(con, cmd_text)
        # client_pid: `offbox wait` on a run still queued for a box can tell a live client from one that died.
        def register():
            with write(con):
                con.execute("""INSERT INTO runs (run_id, owner, session_id, thread_id, repo_root, cwd, cmd, mode, status, start_at,
                               log_path, pulls, rel_cwd, local_cwd, client_pid, step_count, size, requested_size, size_note)
                               VALUES (?,?,?,?,?,?,?,?, 'starting', ?,?,?,?,?,?,?,?,?,?)""",
                            (self.run_id, me["owner"], me.get("session"), me.get("thread"), me["repo_root"], str(self.cwd),
                             cmd_text[:4000], "bg" if a.bg else "fg", now(), str(self.log_path),
                             json.dumps(a.pull or []), self.rel, str(self.cwd), os.getpid(), len(steps), size, a.size, why or ''))
                con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'start_claim:{self.run_id}', '1'))
                if home.failed_over():
                    con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)', (f'failover_queue:{self.run_id}', '1'))
        try:
            db_retry(register)
            self.registered = True
            if why:
                event(con, None, "size_override", json.dumps(dict(run_id=self.run_id, requested=a.size,
                                                                 effective=size, reason=why)))
            try:
                save_run_state(self.run_id, resources=resources.unavailable(
                    'not_started' if api.BACKEND == 'server' else 'boat'),
                    **offbox_disk_space.client_metadata())
            except Exception:
                pass
            if a.bg:
                with log_lock(self.run_id):
                    self.log_path.parent.mkdir(parents=True, exist_ok=True)
                    self.log_path.touch()
            say(f"pending run {self.run_id}; wait: offbox wait {self.run_id}; kill: offbox kill {self.run_id}")
            event(con, None, "run_pending", self.run_id)
        finally:
            con.close()

    def start(self) -> dict:
        self.register_pending()
        a, me = self.a, self.me
        con = db()
        self._log_pool(con)
        self.require_pending(con)
        steps = getattr(a, "steps", None) or []
        cmd_text = " ; ".join(steps) if steps else (shlex.join(a.cmd) if len(a.cmd) > 1 else a.cmd[0])
        self.wait_images = wait_images = needs_image_wait(cmd_text, me["repo_root"])
        t0 = now()
        size, why = a._size_decision
        env, explicit = build_env(a.env or [])
        from . import start_check
        claim = start_check.claim_id(con, self.run_id)
        env_file = f"/home/user/.offbox/env/{claim}.env"
        body = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in env.items()).encode()
        w = node_version.want(self.root, self.cwd)
        node_block = node_version.block(w)
        pm = pnpm_version.want(self.root, self.cwd)
        if pm:
            node_block += "\n" + pnpm_version.block(pm)
        usage = command_usage.inspect(self.root, self.rel, a.cmd, steps)

        def build_command(rdir, box, preserve, source=""):
            template = a.template or (source.split(":", 1)[1] if source.startswith(("template:", "recipe:")) else "")
            script = remote_script(rdir, self.rel, a.cmd, env_file, self.run_id, steps=steps or None,
                                   node=node_block, wait_images=wait_images, image_wait=image_wait_seconds(),
                                   repo_key=me["repo_key"], repo_root=self.root,
                                   preserve_containers=preserve, box_id=box, usage=usage, template=template)
            command, path = command_payload(script, self.run_id, claim_id=claim)
            return command, path, script.encode()

        # Validate the same transport before acquiring anything; final box-specific values are checked again.
        build_command(identity.remote_dir_for(self.root), "<box>", "private lease")
        dead_attempts = 0
        replacement = None
        while True:
            excluded = self.cold_boxes | set(getattr(a, '_disk_exclude', ()))
            options = {'exclude': excluded} if excluded else {}
            queued_at = time.monotonic()
            try:
                row = replacement or pool.acquire(me, size=size, template=a.template, base=a.base, fresh=a.fresh,
                                                  run_id=self.run_id, check_source=lambda: self.check_source('queued'),
                                                  **options)
            finally:
                self.queue_s += time.monotonic() - queued_at
            replacement = None
            self.lease_row = row
            self.box = row["box_id"]
            self.check_source('slot')
            rdir = row["remote_dir"]
            self.record(box_id=self.box, size=row["size"], remote_dir=rdir, setup_s=round(now() - t0, 2),
                        docker=int(lease.uses_docker(cmd_text, me["repo_root"])))
            command, self.command_file, self.command_body = build_command(
                rdir, self.box, containers.preserve_reason(con, row), row.get("source", ""))
            self.record(cmd_bytes=len(command.encode()), cmd_via='file' if self.command_file else 'argv')
            keeper_scope = None
            if row.get('_prepare_end') is None:
                row['_prepare_end'] = prepare.Budget(self.box).end
            try:
                with _keep_ttl(self.box, row['_prepare_end']) as keeper_scope:
                    try:
                        replacement = self._prepare_box(con, a, rdir, env_file, body)
                    except box_disk.Full as failure:
                        if self.box in getattr(a, '_disk_cleaned', set()):
                            box_disk.retire(con, self.box, failure.space, failure.fs)
                            raise
                        a._disk_cleaned = getattr(a, '_disk_cleaned', set()) | {self.box}
                        healthy, space = box_disk.recover(con, self.box, failure.fs, failure.space,
                                                          getattr(failure, 'path', None), rdir)
                        if not healthy:
                            raise box_disk.Full(self.box, failure.fs, space, cleaned=True)
                        try:
                            replacement = self._prepare_box(con, a, rdir, env_file, body)
                        except box_disk.Full as repeated:
                            box_disk.retire(con, self.box, repeated.space, repeated.fs)
                            raise
                if replacement is not None:
                    pool.release_guard(row)
                    self.lease_row, self.box = replacement, replacement['box_id']
                    continue
                break
            except (prepare.Stalled, TtlUnconfirmed) as e:
                self.record(box_id=None)
                self.cold_boxes.add(self.box)
                pool.release_guard(row)
                self.lease_row = self.box = None
                if replacement is None:
                    prepare.move_once(e)
                say(f"{e}; trying another box")
            except lease.DeadMount as e:
                replacement = None
                dead_attempts += 1
                dead = self.box
                self.record(box_id=None)  # our run row must not point at the box we stop
                ttl_confirmed = keeper_scope is None or keeper_scope.settled.is_set()
                if ttl_confirmed:
                    lease.set_aside_dead_mount(con, dead, e.reason)
                pool.release_guard(row)
                self.lease_row = self.box = None
                if dead_attempts == 2:
                    raise OffboxError(f"{dead} has a dead filesystem ({e.reason}), and so did the box before it; "
                                      "both are set aside. Nothing ran: retry", code=EXIT_INFRA) from e
                prepare.move_once(e)
                action = 'stopped and set aside' if ttl_confirmed else 'set aside'
                say(f"{dead} has a dead filesystem ({e.reason}): {action} (offbox list --all shows it). "
                    "Trying another box")
            except BaseException:
                if keeper_scope is not None and not keeper_scope.settled.is_set():
                    self.record(box_id=None)  # finish must not assign an idle TTL to a fenced box
                raise
        new_checkout_hint(row, self.root, usage)
        warning = clickhouse_suite_warning(me['repo_key'], row['size'], cmd_text)
        if warning:
            say(warning)
        con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', ('containers_expected:' + self.run_id, '1'))
        con.commit()
        self.require_pending(con)
        self.check_source('push')
        # From this point a lost response may mean the command executed. Never run it locally again.
        self.started = True
        try:
            save_run_state(self.run_id, resources=resources.unavailable(
                'pending' if api.BACKEND == 'server' else 'boat'))
        except Exception:
            pass
        try:
            import toollog
            toollog.emit('run', 'run.start', ids={'run': self.run_id, 'box': self.box},
                         props={'cmd_bytes': len(command.encode()),
                                'cmd_via': 'file' if self.command_file else 'argv', 'step_count': len(steps)})
            r = api.cmd_start(self.box, command,
                              meta={"repo": me.get("repo_key"), "kind": run_kind(cmd_text), "run_id": self.run_id},
                              retry_interrupted=retry_interrupted(a))
        except home.StartWaitFailed:
            self.started = False
            raise
        except (api.ApiError, api.NetworkError) as e:
            if api.BACKEND == "server" and getattr(e, 'status', None) == 503 and e.api_code in (
                    'server_not_ready', 'server_starting'):
                self.started = False
                raise
            # A 4xx answer (400 E2BIG, 409 not ready, 429 rate limit) means boat refused it: nothing ran.
            # Without this the run sat "starting" for an hour and held the box until it stopped.
            # Cloudflare 521-526 except 524 never reached boat, so nothing ran; 520, 524 and network errors stay started.
            # Home's disk gate returns 503 before dispatch: it is a refusal, not a lost response.
            disk_refused = (isinstance(e, api.ApiError) and api.BACKEND == 'server'
                            and e.api_code == 'server_disk_low')
            if disk_refused or getattr(e, "status", None) in (*REFUSED_STATUSES, *api.CF_NOT_DELIVERED):
                self.started = False
                if e.api_code in ("sandbox_not_ready", "machine_not_running"):
                    # boat says the box is stopped: let offbox's next run resume it (lease._reuse) instead of a
                    # hand-run `boat resume`.
                    con.execute("UPDATE leases SET state='stopped' WHERE box_id=?", (self.box,))
                    con.commit()
                    ssh_sync.close_master(self.box)
                    import toollog
                    toollog.emit("run", "run.error", kind="error", ok=False, ids={"run": self.run_id, "box": self.box}, props={"stage": "readiness"}, tag="readiness")
                    event(con, self.box, "lease_not_ready", str(e)[:200])
                    raise OffboxError(f"{e}. Nothing ran; offbox resumes {self.box} on the next run. "
                                      "Retry; don't run `boat resume` by hand.", code=EXIT_INFRA) from e
                if "E2BIG" in str(e):
                    # Usage error, not infra: no infra alert, no retry, no fallback.
                    raise OffboxError(f"{e}: the command is too long for one exec; put it in a script file "
                                      "in the repo and run that", code=2) from e
            elif isinstance(e, api.NetworkError) or 500 <= (e.status or 0) < 600:
                time.sleep(start_check.GRACE_S)
                result = start_check.check(self.box, self.run_id)
                if result.code is not None:
                    self.recovered_code = result.code
                    self.remote_code = None if steps else result.code
                    # A recovered receipt may be a pre-command gate. Keep waiters pending
                    # until admission recovery decides whether this invocation needs another attempt.
                    saved = {'known_exit_code': result.code} if steps or a.bg or result.code in (90, 97, 98) else {
                        'status': 'done' if result.code == 0 else 'failed', 'exit_code': result.code, 'end_at': now()}
                    save_run_state(self.run_id, box_id=self.box, wrapper_pid=result.pid, **saved)
                    try:
                        self.record(wrapper_pid=result.pid, status='running', command_at=now())
                    except sqlite3.Error as error:
                        state_warning(self.run_id, result.code, error)
                    say(f"{self.run_id} on {self.box}: ran, exit {result.code}; live output unavailable; "
                        + start_check.hint(self.box, self.run_id))
                    return row
                current = con.execute('SELECT * FROM runs WHERE run_id=?', (self.run_id,)).fetchone()
                start_check.settle(con, current, result, f'{e} on start')
                if result.verdict == 'fenced':
                    self.started = False
                    event(con, self.box, 'cmd_start_lost', f'{self.run_id}: {e}; fenced')
                    raise OffboxError(f'{self.run_id} on {self.box}: never got the command ({e}). Nothing ran',
                                      outage=True, run_id=self.run_id, box=self.box) from e
                raise OffboxError(f'{self.run_id} on {self.box}: start unknown: {e}; '
                                  f'ssh check failed or command may still be running; '
                                  + start_check.hint(self.box, self.run_id),
                                  started=True, run_id=self.run_id, box=self.box) from e
            raise
        self.pid = r["processId"]
        from .home_run_observation import observe
        observe(self.run_id, "accepted")
        self.started = True
        save_run_state(self.run_id, box_id=self.box, process_id=self.pid, command_id=r.get("commandId"))
        try:
            self.record(process_id=self.pid, command_id=r.get("commandId"), status="running", command_at=now())
            lease.touch(self.box)
            event(con, self.box, "run_start", f"{self.run_id} pid={self.pid} env={','.join(explicit) or '-'} "
                                              f"cmd_bytes={len(command.encode())} cmd_via={'file' if self.command_file else 'argv'} "
                                              f"steps={len(steps)} cmd={cmd_text[:200]}")
        except sqlite3.Error as error:
            state_warning(self.run_id, None, error)
        return row

    def require_pending(self, con) -> None:
        row = con.execute('SELECT status FROM runs WHERE run_id=?', (self.run_id,)).fetchone()
        if not row or row['status'] != 'starting':
            if os.environ.get(BACKGROUND_RUN_ENV):
                queue_lifecycle.note(self.run_id, 'settled', 'row_no_longer_pending',
                                     status=row['status'] if row else None)
            raise OffboxError(f'{self.run_id}: settled before the command started; nothing ran', code=130)

    def _prepare_box(self, con, a, rdir, env_file, body) -> dict | None:
        """Everything before the command starts. Raises lease.DeadMount when the box's filesystem is dead."""
        with prepare.guard(self.box, self.lease_row.get('_prepare_end')):
            replacement = self._check_box(con, a, rdir)
        if replacement is not None:
            return replacement
        # A healthy first push can take 10–25 minutes. Bound source reads too, using push's existing hour allowance.
        with prepare.guard(self.box, seconds=3600), prepare.phase('push', self.box):
            while True:
                try:
                    self._sync_box(con, a, rdir, env_file, body)
                    break
                except ssh_sync.BoxStoppedDuringPush:
                    if self.push_resumed:
                        raise
                    self.push_resumed = True
                    # The pool guard is still held. Bypass _reuse's cached running/master fast path.
                    row = dict(self.lease_row, state='stopped')
                    try:
                        resumed = lease._reuse(con, row, row['size'])
                        if resumed is None:
                            raise OffboxError(f"lease {self.box} is no longer available")
                    except (common.SshHostKeyMismatch, home.StartWaitFailed):
                        raise
                    except (OffboxError, OSError, subprocess.TimeoutExpired) as e:
                        raise OffboxError(f"{e}; box stopped during push: {self.box}") from e
                    log(f"push_box_stopped_resumed {self.box}")
        space = box_disk.measure(self.box, '/home/user/' + rdir)
        fs = box_disk.low(space)
        if fs:
            raise box_disk.Full(self.box, fs, space)
        return None

    def _check_box(self, con, a, rdir) -> dict | None:
        # The probe goes before prune: prune's ssh hangs on a dead filesystem.
        forced_cold = self.lease_row.get('_cold_resume')
        reason, home_s = ssh_sync.probe_home(self.box, measure_write=not forced_cold)
        if reason:
            raise lease.DeadMount(self.box, reason)
        docker_s = ssh_sync.probe_docker_root(self.box) if self.wait_images and not forced_cold else None
        pruned = prune.run(con, self.box, rdir)
        threshold = capacity.setting('OFFBOX_COLD_HOME_SECONDS', 5)
        if forced_cold or pruned.timed_out or any(s is not None and s > threshold for s in (home_s, docker_s)):
            self.cold_boxes.add(self.box)
            resumed = self.lease_row.get('_resumed_at')
            if resumed is None:
                last = con.execute("SELECT MAX(ts) FROM events WHERE box_id=? AND kind='lease_resume'",
                                   (self.box,)).fetchone()
                resumed = last[0]
            since = f'{max(0, now() - resumed):.1f}s after resume' if resumed is not None else 'resume time unknown'
            home = f'{home_s:.3f}s' if home_s is not None else 'unknown'
            docker = f'{docker_s:.3f}s' if docker_s is not None else 'unknown'
            event(con, self.box, 'cold_home', f'home {home}, docker {docker}, {since}; '
                  f'prune_timeout={int(pruned.timed_out)} resume={forced_cold or "ordinary"}')
            # A failed existence check proves nothing; only exit 1 means a first push is safe to move.
            missing = False
            if not self.cold_moved and not a.no_sync:
                try:
                    exists = ssh_sync.ssh(self.box, 'test -d "$HOME"/' + shlex.quote(rdir), timeout=10)
                    missing = exists.returncode == 1
                except (subprocess.TimeoutExpired, OSError):
                    pass
            if missing and prepare.can_move():
                replacement = pool.try_warm(self.me, self.lease_row['size'], self.lease_row.get('source'),
                                            self.cold_boxes, self.run_id)
                if replacement is not None:
                    prepare.move_once(OffboxError(f'{self.box} has a cold disk; using a warm box'))
                    self.cold_moved = True
                    say(f'{self.box} was just resumed and its disk is still loading; '
                        f'using running box {replacement["box_id"]} instead')
                    return replacement
            say(f'{self.box} was just resumed and its disk is still loading; the first sync, installs and Docker '
                'databases on it can be slow for 5-25 min. For long runs use --bg + offbox wait.')
        return None

    def _sync_box(self, con, a, rdir, env_file, body):
        self.check_source('push')
        # Env values go through a 0600 file (never the command text, which boat keeps 90 days in history).
        err: list = []
        left = api.left()
        upload_timeout = 120 if left is None else max(.001, min(120, left))
        def upload_files():
            ssh_sync.put_file(self.box, env_file, body, '600', upload_timeout)
            if getattr(self, 'command_file', None):
                ssh_sync.put_file(self.box, self.command_file, self.command_body, '600', upload_timeout)
        upload = (err, upload_files)
        tw = None
        home = api.BACKEND == "server"
        if home:
            # A terminal identity failure must reach this thread before bulk sync can retry or hit its deadline.
            _safe(*upload, terminal_identity=True)
        else:
            tw = threading.Thread(target=_safe, args=upload, daemon=True)
            tw.start()
        push_exc = None
        try:
            if not a.no_sync:
                with prepare.phase("push", self.box):
                    candidates = _seed_candidates(con, self.box, rdir, self.me["repo_key"])
                    self.check_source('push')
                    st = ssh_sync.push(self.box, self.root, rdir, with_git=a.git, includes=getattr(a, "include", None),
                                       seed_candidates=candidates, run_id=self.run_id)
                self.record(sync_s=st.get("seconds"), sent_bytes=st.get("sent"))
                say(f"synced {self.root.name} -> {self.box} ({st.get('files', 0)} files changed, "
                    f"{st.get('sent', 0) / 1024:.0f} KiB sent, {st.get('seconds')}s; "
                    f"verified {st.get('verified', 0)} tracked files"
                    f"{', repaired ' + str(st['repaired']) if st.get('repaired') else ''})")
                note = ssh_sync.tracked_ignored_note(st)
                if note:
                    say(note)
                skipped = st.get("secret_skips", [])
                if skipped:
                    say(f"not synced (secret filter) though tracked by git: {', '.join(skipped[:5])}"
                        f"{' ...' if len(skipped) > 5 else ''}. If tests need them: --include <path>")
        except common.SshHostKeyMismatch:
            raise
        except Exception as e:  # noqa: BLE001 - held until the env upload has finished, then re-raised
            push_exc = e
        finally:
            if tw is not None:
                left = api.left()
                tw.join(timeout=max(0, left) if left is not None else None)
        self.check_source('push')
        if isinstance(push_exc, common.SourceGone):
            raise push_exc
        # Identity failures take precedence over transfer recovery, even if the other transfer saw a dead mount.
        for e in (push_exc, err[0] if err else None):
            if isinstance(e, common.SshHostKeyMismatch):
                raise e
        if not a.no_sync and push_exc is None and err and not ssh_sync.dead_mount(str(err[0])):
            # Resetting SSH can interrupt the parallel upload even when the file push recovers.
            err.clear()
            left = api.left()
            upload_timeout = 120 if left is None else max(.001, min(120, left))
            _safe(err, upload_files, terminal_identity=home)
            if err and isinstance(err[0], common.SshHostKeyMismatch):
                raise err[0]
        self.check_source('push')
        # A dead mount may have failed either transfer; prefer that over an ordinary error from the other.
        for e in (push_exc, err[0] if err else None):
            reason = ssh_sync.dead_mount(str(e)) if e is not None else None
            if reason:
                raise lease.DeadMount(self.box, reason) from e
        sync_exc = push_exc if push_exc is not None else err[0] if err else None
        if sync_exc is not None:
            disk_failure = box_disk.push_failure(sync_exc)
            if disk_failure and not isinstance(sync_exc, api.ApiError):
                fs, path = disk_failure
                failure = box_disk.Full(self.box, fs, box_disk.measure(self.box))
                failure.path = path
                raise failure from sync_exc
            from . import disk_pressure
            if api.BACKEND == 'server' and disk_pressure.is_full(sync_exc):
                disk_pressure.remember(True)
                raise OffboxError('home server out of disk during sync; nothing ran', code=EXIT_INFRA, outage=True) from sync_exc
            if re.search(r"Broken pipe|code 255|\(255\)", str(sync_exc)):
                state = _boat_state(self.box)
                if state and state not in api.LIVE_STATES:
                    raise OffboxError(f"box {self.box} was stopped by boat during the sync ({state}); nothing ran",
                                      code=EXIT_INFRA) from sync_exc
            raise sync_exc

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


def _seed_candidates(con, box_id: str, current: str, repo_key: str) -> list[str]:
    """Recent checkouts on this box whose local roots still identify as this repository."""
    rows = con.execute("""SELECT r.remote_dir, r.repo_root, MAX(COALESCE(r.start_at, 0)) AS last,
                                 EXISTS (SELECT 1 FROM pool_callers c JOIN pool_members p USING(box_id)
                                         WHERE c.box_id=r.box_id AND c.repo_root=r.repo_root
                                           AND c.remote_dir=r.remote_dir AND p.pool_key=?) AS mapped
                          FROM runs r WHERE r.box_id=? AND r.remote_dir IS NOT NULL AND r.remote_dir<>?
                          GROUP BY r.remote_dir, r.repo_root ORDER BY last DESC""",
                       (repo_key, box_id, current)).fetchall()
    out, checked = [], {}
    for row in rows:
        remote, root = row["remote_dir"], row["repo_root"]
        if not root or not prune.DIR_RE.fullmatch(remote) or remote in out:
            continue
        if row["mapped"]:
            out.append(remote)
            continue
        if root not in checked:
            path = Path(root)
            checked[root] = path.is_dir() and identity.repo_key(path) == repo_key
        if checked[root]:
            out.append(remote)
    return out


def _safe(err: list, fn, *args, terminal_identity=False):
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001
        if isinstance(e, home.StartWaitFailed):
            raise
        if terminal_identity and isinstance(e, common.SshHostKeyMismatch):
            raise
        err.append(e if isinstance(e, OffboxError) else OffboxError(f"{type(e).__name__}: {e}"))


def _boat_state(box_id: str) -> str | None:
    try:
        return (api.get(box_id) or {}).get("state")
    except OffboxError:
        return None


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


class TtlUnconfirmed(OffboxError):
    def __init__(self, box_id):
        super().__init__(f'{box_id} has an unconfirmed auto-stop update; set aside; nothing ran')


@contextlib.contextmanager
def _keep_ttl(box_id: str, prepare_end=None):
    stop_evt = threading.Event()
    requests = api.RequestScope(5)
    end = prepare_end if prepare_end is not None else prepare.Budget(box_id).end

    def refresh():
        with requests.active():
            _ttl_keeper(box_id, stop_evt)

    keeper = threading.Thread(target=refresh, daemon=True)
    keeper.start()
    failed = False
    try:
        yield requests
    except BaseException:
        failed = True
        raise
    finally:
        stop_evt.set()
        requests.cancel(preserve_mutations=True)
        requests.settled.wait(max(0, min(1, end - time.monotonic())))
        requests.cancel()
        # Socket reads wake on cancel. A stuck DNS/Keychain lookup may remain, but cannot send a late PATCH.
        keeper.join(1)
        if not requests.settled.is_set():
            # Reuse the existing persistent selection fence; keep the disk and let normal idle stopping handle it.
            with contextlib.closing(db()) as con:
                con.execute("UPDATE leases SET note=? WHERE box_id=? AND COALESCE(note,'') NOT LIKE 'disk-full:%'",
                            (BOX_WEDGED_NOTE + ' unconfirmed keeper TTL PATCH', box_id))
                con.commit()
                event(con, box_id, 'ttl_unconfirmed', 'keeper PATCH sent without acknowledgement; box set aside')
            if not failed:
                raise TtlUnconfirmed(box_id)


def _echo(stream, b: bytes) -> bool:
    """Echo a chunk to the caller. Any failure to write there stops the echo only; the log keeps the output. Not just a
    closed pipe: a redirect to a file on a volume that went away fails with EIO (31 Oct, run-1031-140118-88ca), and
    letting that reach follow()'s stream retry replayed the same chunk forever."""
    if is_silenced(stream):
        return False
    try:
        stream.buffer.write(b)
        stream.flush()
        return True
    except (OSError, ValueError):
        silence(stream)
        return False


def _close(frames) -> None:
    close = getattr(frames, "close", None)
    if close:
        close()


# Upper bound for joining the TTL keeper when a follower ends: its ensure_ttl call can be inside a 60 s request.
_KEEPER_JOIN_S = 65


class _ClientSignal(KeyboardInterrupt):
    """Unwind to stop/detach without waiting on a network-bound TTL keeper."""


def _commit(log_path: Path, out_off: int, err_off: int, log_bytes: int) -> None:
    """Commit a checkpoint after a chunk is flushed to the local log: the remote offsets and the log length they match.
    A holder that dies before this write leaves the chunk past logBytes, so a takeover trusts only logBytes."""
    try:
        atomic_write_json(offsets_path(Path(log_path)),
                          {"stdoutOffset": out_off, "stderrOffset": err_off, "logBytes": log_bytes})
    except OSError:
        pass


def _status_code(st: dict) -> int | None:
    """The exit code in an ended process's status, read like an exit frame: a signal without a code counts as 143,
    and None (boat lost the process, or gave no code) sends the caller to recover_lost_exit."""
    if st.get("status") == "lost":
        return None
    if st.get('status') == 'interrupted' and st.get('running') is not True:
        return EXIT_INTERRUPTED
    if st.get("exitCode") is not None:
        return st.get("exitCode")
    return 128 + 15 if st.get("signal") else None


def _ended(box_id: str, pid: int, until: float | None, run_id: str | None = None) -> dict | None:
    """boat's status for the process when it says the process has ended (exited or lost), else None. One bounded
    request, no retries, never past the caller's deadline; any error counts as not ended."""
    if run_id:
        from . import start_check
        with contextlib.closing(db()) as con:
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
            unattached = row and not start_check.api_pid(con, row) and start_check.recovery_marked(con, row)
        if unattached:
            return None
    try:
        left = 60.0 if until is None else max(1.0, min(60.0, until - now()))
        st = api.cmd_status(box_id, pid, timeout=left, retries=0, deadline=until)
    except OffboxError:
        return None
    remember_interruption(run_id, st)
    if st and not st.get("running") and st.get("status") in ("exited", "lost", "interrupted"):
        if st.get('status') == 'lost' and run_id:
            try:
                return confirmed_lost(box_id, run_id, 20 if until is None else min(20, max(0, until - now())),
                                      check_box=True)
            except OffboxError:
                return None
        return st
    return None


def interruption_info(status):
    if not isinstance(status, dict):
        return None
    data = status.get('command') if isinstance(status.get('command'), dict) else status
    info = data.get('interruption')
    if not isinstance(info, dict) or not info:
        metrics = data.get('metrics')
        info = metrics.get('interruption') if isinstance(metrics, dict) else None
    return dict(info) if isinstance(info, dict) and info else None


def remember_interruption(run_id, status):
    info = interruption_info(status)
    if (run_id and info is not None and
            read_json(LOGS_DIR / f'{run_id}.state.json', {}).get('interruption') != info):
        try:
            save_run_state(run_id, interruption=info)
        except OSError as error:
            say(f"warning: {run_id}: could not save interruption details ({error})")
    return info


def cleanup_summary(info):
    if info.get('cleanup') == 'clean' and type(info.get('leftover_killed')) is int and info['leftover_killed'] == 0:
        return 'cleanup: clean'
    count = info.get('leftover_killed')
    if info.get('cleanup') == 'stopped' and type(count) is int and count >= 0:
        return f'cleanup: {count} stopped'
    if type(count) is int and count > 0:
        return f'cleanup: unknown; {count} leftover processes were stopped'
    return 'cleanup: unknown'


def interruption_message(what, info, box=None):
    cause = info.get('cause') or 'server_restart'
    box = box or info.get('box_id') or 'the box'
    count = info.get('leftover_killed')
    if info.get('cleanup') == 'clean' and count == 0:
        cleanup = f'no process from this run is left on {box}; safe to start a clean rerun'
    elif info.get('cleanup') == 'stopped' and type(count) is int and count > 0:
        cleanup = f'{count} leftover processes were stopped'
    else:
        cleanup = f'process state on {box} could not be checked; cleanup is unknown'
    detail = f" {info['message']}." if info.get('message') else ''
    return (f"{what} was interrupted ({cause}); the command ran partly and was not run again. "
            f"Check what it did before running it again.{detail} Output: offbox logs {what}\n"
            + cleanup_summary(info) + '; ' + cleanup)


def report_interruption(row):
    if row['status'] == 'interrupted':
        saved = read_json(LOGS_DIR / f"{row['run_id']}.state.json", {})
        info = saved.get('interruption') or {}
        cleanup = saved.get('cleanup')
        if isinstance(cleanup, dict):
            info = {**info, 'cleanup': cleanup.get('cleanup'), 'leftover_killed': cleanup.get('leftover_killed')}
        say(interruption_message(row['run_id'], info, row['box_id']))


class Interrupted(OffboxError):
    """The server could not finish or retry the accepted command; its own exit code is unknown."""

    def __init__(self, what: str, status=None):
        self.interruption = interruption_info(status) or {}
        super().__init__(interruption_message(what, self.interruption) + f"\nexit {EXIT_INTERRUPTED}",
                         code=EXIT_INTERRUPTED, started=True)


def retry_interrupted(a) -> bool:
    """May the server run this command again by itself after a power cut? Yes for an ordinary `offbox run` (a
    synced repo plus a test or build command: running it twice is harmless). No for person-box work (her
    accounts, messages, logins: never twice without someone deciding), and no with --no-retry."""
    if api.BACKEND != "server" or getattr(a, "no_retry", False):
        return False
    return person() is None


# A cold boot of the home server can take this long (it trains memory): after a dropped stream the client keeps
# reconnecting for 15 minutes, from the byte it had reached, before it gives up on a run the server accepted.
HOME_RECONNECT_S = 900


# follow() asks boat's status at most this often while a stream sends only heartbeats.
QUIET_PROBE_S = 300
_RUNNING = object()


# Matches outage.WAIT_MAX_S: the auto-stop now holds ~25 min, so a run can ride out an outage that long.
OUTAGE_FOLLOW_S = 1800


def run_kind(cmd_text: str) -> str:
    """A short label grouping runs for right-sizing on the server: the tool and its subcommand, e.g. `go test`,
    `make test-int`, `pnpm vitest`. Flags, paths and arguments after the second word are dropped."""
    try:
        toks = shlex.split(cmd_text or "", posix=True)
    except ValueError:
        toks = (cmd_text or "").split()
    if len(toks) >= 3 and toks[0].rsplit("/", 1)[-1] in ("bash", "sh", "zsh") and toks[1].startswith("-") \
            and "c" in toks[1]:
        return run_kind(toks[2])
    words = [w for w in toks[:6] if not w.startswith("-") and "=" not in w]
    words = [w.rsplit("/", 1)[-1] for w in words]
    return " ".join(words[:2])[:60] or "?"


_log_locks = threading.local()


@contextlib.contextmanager
def log_lock(run_id: str, timeout: float = 600, *, until: float | None = None):
    """Serialize one run's log writers. Callers needing a box lock must acquire it first.

    Reentrant within a thread so takeover publication and finalization can use follow/finish safely.
    The zero-timeout file-lock attempts keep the retry pause within an interactive reader's budget.
    """
    held = getattr(_log_locks, 'held', set())
    if run_id in held:
        yield False
        return
    deadline = now() + timeout
    if until is not None:
        deadline = min(deadline, until)
    waited = False
    while True:
        guard = file_lock('log-' + run_id, timeout=0)
        try:
            guard.__enter__()
            break
        except OffboxError:
            left = deadline - now()
            if left <= 0:
                if until is not None and now() >= until:
                    raise OffboxError(f"--timeout reached; {run_id} was not stopped. "
                                      f"Wait again: offbox wait {run_id}", code=EXIT_WAIT_TIMEOUT)
                raise
            waited = True
            time.sleep(min(0.1, left))
    _log_locks.held = held
    held.add(run_id)
    try:
        yield waited
    finally:
        held.remove(run_id)
        guard.__exit__(None, None, None)


_COMMAND_RUNNING = object()


def follow(box_id: str, pid: int, log_path: Path | None, echo: bool = True, run_id: str | None = None,
           start_offsets=(0, 0), stop_evt: threading.Event | None = None, until: float | None = None,
           replay_path: Path | None = None, mirror_path: Path | None = None, mirror_keep: int = 0,
           receipt_locked: bool = False, until_command_started: bool = False):
    """Stream a remote command's output until it exits. Setting stop_evt (see lease._follow_bounded) makes it
    return None at the next frame, reconnect or retry pause; it then closes its stream and joins its TTL keeper.
    Past `until` (a time.time()-style deadline) it raises EXIT_WAIT_TIMEOUT and leaves the remote run alone.
    The per-stream offsets are saved beside the local log after every chunk, so a waiter that takes over a dead
    holder's follow resumes from them (see offsets_path) instead of replaying output."""
    if run_id:
        from . import start_check
        with contextlib.closing(db()) as con:
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
            unattached = row and not start_check.api_pid(con, row) and start_check.recovery_marked(con, row)
        if unattached:
            from .misc import _wait_start_receipt
            row = _wait_start_receipt(row, until, locked=receipt_locked)
            if row['status'] not in ('starting', 'running'):
                return row['exit_code']
            pid = row['process_id']
    guard = log_lock(run_id or Path(log_path).stem, until=until) if log_path else contextlib.nullcontext()
    with guard:
        return _follow_locked(box_id, pid, log_path, echo, run_id, start_offsets, stop_evt, until,
                              replay_path, mirror_path, mirror_keep, until_command_started)


def _follow_locked(box_id, pid, log_path, echo, run_id, start_offsets, stop_evt, until,
                   replay_path, mirror_path, mirror_keep, until_command_started=False):
    startup_tail = ""
    out_off, err_off = start_offsets
    stop_evt = stop_evt or threading.Event()
    keeper = threading.Thread(target=_ttl_keeper, args=(box_id, stop_evt), daemon=True)
    keeper.start()
    # A takeover replays into `replay_path`, which the caller prepared with the committed prefix. It is opened for
    # append (never truncated) so that prefix survives, and its checkpoint starts at the length it already holds.
    target = replay_path or log_path
    lf = open(target, "ab") if target else None
    delivered = 0
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
    # Our own server restarts (no UPS): the window for reconnecting to a run it accepted, and what the stream said
    # about the server and the attempt last time, to tell a restart and a retry from a network blip.
    home_run = api.BACKEND == "server"
    window = HOME_RECONNECT_S if home_run else OUTAGE_FOLLOW_S
    what = run_id or f"{box_id}:{pid}"
    seen = {"boot": None, "started": None, "attempt": None, "lost": False}

    def hello(fr) -> None:
        """First frame of every attach on our server: boot id, boatd start time, the run's attempt."""
        boot, started, attempt = fr.get("bootId"), fr.get("serverStartedAt"), fr.get("attempt")
        if seen["boot"] is not None and (boot != seen["boot"] or started != seen["started"]):
            how = "the machine restarted" if boot != seen["boot"] else "its service restarted"
            say(f"the offbox server restarted while this run was going ({how}); reconnected")
        elif seen["lost"]:
            say("reconnected to the offbox server")
        seen.update(boot=boot, started=started, lost=False)
        new_attempt(attempt)

    def new_attempt(attempt) -> None:
        if attempt and seen["attempt"] is not None and attempt != seen["attempt"]:
            say(f"the restart cut the run off; the server is running it again from the start (attempt {attempt}). "
                "Output continues below")
        if attempt:
            seen["attempt"] = attempt

    # How often boat's status has said the process ended with no output delivered in between. Unlike `failures`, a
    # frame does not reset it, only progress does: a failure that recurs after the first frame of every attach (31 Oct,
    # run-1031-140118-88ca: each reattach replayed one chunk, its echo raised EIO, `attached` cleared `failures`) still
    # ends with boat's exit code, while a finished run whose output is still arriving is followed to its exit frame.
    ended = {"n": 0, "at": None}
    frames = None
    down_from = None  # since when boat's API has been unreachable during this follow
    last_home_read = 0

    probed = {"at": now()}

    def ended_again() -> int:
        if ended["at"] != (out_off, err_off):
            ended["n"], ended["at"] = 0, (out_off, err_off)
        ended["n"] += 1
        return ended["n"]

    def follow_lost():
        if not run_id:
            return None
        while not stop_evt.is_set():
            if until is not None and now() >= until:
                raise timed_out()
            budget = 20 if until is None else min(20, max(0, left()))
            try:
                st = confirmed_lost(box_id, run_id, budget, check_box=True)
            except OffboxError:
                st = None
            if until is not None and now() >= until:
                raise timed_out()
            if st is not None:
                return _status_code(st)
            pause = QUIET_PROBE_S if until is None else min(QUIET_PROBE_S, max(0, left()))
            stop_evt.wait(pause)
        return None

    def probe_end():
        """On a reconnect or a long run of heartbeats: boat's exit code once its status has said the process ended
        twice with no output in between (None when boat lost it), else _RUNNING."""
        probed["at"] = now()
        st = _ended(box_id, pid, until)
        # An answer that arrives past the caller's deadline is not accepted: the wait ends with --timeout (124).
        if until is not None and now() >= until:
            raise timed_out()
        remember_interruption(run_id, st)
        if st is not None and st.get("status") == "interrupted":
            raise Interrupted(what, st)
        if st is None or ended_again() < 2:
            return _RUNNING
        if st.get('status') == 'lost':
            return follow_lost()
        return _status_code(st)

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
                    read_s = max(1.0, min(read_s, window - (now() - down_from)))
                frames = api.cmd_attach(box_id, pid, out_off, err_off, timeout=read_s, deadline=until)
                for fr in frames:
                    if stop_evt.is_set():
                        return None
                    # A frame from a live attach means boat answers: this stream's outage (if any) is over.
                    down_from = None
                    # Absolute: a frame that arrives after the deadline (even an exit) is not accepted.
                    if until is not None and now() >= until:
                        raise timed_out()
                    remember_interruption(run_id, fr)
                    t = fr.get("type")
                    if t != "error" and run_id and (now() - last_home_read >= 5 or t == "exit"):
                        from .home_run_observation import observe
                        kind = {"hello": "stream connected", "heartbeat": "stream heartbeat",
                                "reconnect": "stream connected", "attempt": "stream connected",
                                "stdout": "output received", "stderr": "output received",
                                "exit": fr.get("status", "exited")}.get(t)
                        observe(run_id, kind)
                        last_home_read = now()
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
                            if echo:
                                delivered = lf.tell()
                            if mf:
                                mf.write(b)
                                mf.flush()
                                _commit(mirror_path, out_off, err_off, mf.tell())
                        if until_command_started and t == 'stderr':
                            startup_tail += data
                            if COMMAND_STARTED_MARKER + ' ' + (run_id or '') in startup_tail.splitlines():
                                return _COMMAND_RUNNING
                            startup_tail = startup_tail[-4096:]
                    elif t == "reconnect":
                        out_off, err_off = fr.get("stdoutOffset", out_off), fr.get("stderrOffset", err_off)
                        # boat ends a healthy stream every 10 min; an ended process gets its exit frame on the next
                        # attach. If boat keeps answering with reconnects instead, take the code from its status.
                        code = probe_end()
                        if code is not _RUNNING:
                            return code
                        again = True
                        break
                    elif t == "heartbeat" and now() - probed["at"] >= QUIET_PROBE_S:
                        # A stream that only sends heartbeats can't hide a finished process for long either.
                        code = probe_end()
                        if code is not _RUNNING:
                            return code
                    elif t == "hello":
                        hello(fr)
                    elif t == "attempt":
                        new_attempt(fr.get("attempt"))
                    elif t == "exit":
                        if fr.get("status") == "interrupted" and fr.get('running') is not True:
                            raise Interrupted(what, fr)
                        if fr.get('exitCode') is None and not fr.get('signal'):
                            return follow_lost()
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
            except Interrupted:
                raise
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
                if down_from is not None and now() - down_from >= window:
                    raise OffboxError(f"lost the output stream of {box_id}:{pid}: {api.NAME}'s API was down for "
                                      f"{int(window)}s: {e}", started=True)
                try:
                    # Status and the retry pause share the deadline: a blocked status request must not outrun it.
                    # During an outage it is also capped to the outage window left, so one call cannot outrun it.
                    status_s = max(1.0, min(60.0, left() if until is not None else 60.0))
                    if down_from is not None:
                        status_s = max(1.0, min(status_s, window - (now() - down_from)))
                    # An absolute end (the caller's until, the outage window) is what makes api.cmd_status skip the
                    # connect retries: without it a not-delivered 52x would be sent six times, outside the window.
                    ends = [now() + status_s]
                    if until is not None:
                        ends.append(until)
                    if down_from is not None:
                        ends.append(down_from + window)
                    try:
                        st = api.cmd_status(box_id, pid, timeout=status_s, retries=0, deadline=min(ends))
                    except OffboxError as se:
                        boat_down = getattr(se, "outage", False)
                except OffboxError:
                    pass
                if until is not None and now() >= until:
                    raise timed_out()
                remember_interruption(run_id, st)
                down_from = (down_from or failed_at) if boat_down else None
                if home_run and boat_down and not seen["lost"]:
                    # The run was accepted, so it is never sent anywhere else (it would run twice): wait for the
                    # server and pick the output up where it stopped.
                    seen["lost"] = True
                    say(f"lost the connection to the offbox server; the run stays there. Reconnecting for up to "
                        f"{int(window // 60)} min")
                if st and st.get("status") == "interrupted" and st.get('running') is not True:
                    raise Interrupted(what, st)
                if st and not st.get("running") and st.get("status") in ("exited", "lost"):
                    if st.get("status") == "lost":
                        return follow_lost()
                    if ended_again() > 3:
                        return _status_code(st)
                if failures > 20 and (down_from is None or now() - down_from >= window):
                    raise OffboxError(f"lost the output stream of {box_id}:{pid}: {e}", started=True)
                pause = min(10, 1 + failures)
                if down_from is not None:
                    # boat's API is down, not the run: keep reattaching, but never pause past the outage window.
                    pause = min(pause, max(0.0, window - (now() - down_from)))
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
        join_s = 0 if isinstance(sys.exc_info()[1], _ClientSignal) else (
            _KEEPER_JOIN_S if until is None else max(0.0, min(_KEEPER_JOIN_S, left() or 0.0)))
        keeper.join(join_s)
        if lf:
            lf.close()
        if mf:
            mf.close()
        if delivered and log_path:
            record_delivery(mirror_path or log_path, delivered)


def new_checkout_hint(row: dict, root: Path, usage: command_usage.Usage) -> None:
    if (not row.get("_new_checkout") or not (root / "package.json").exists()
            or not usage.uses_js or not usage.packages or usage.install):
        return
    target = node_tools.install_root(usage.packages[0], root)
    install = node_tools.install_from(usage.packages[0], usage.cwd, root)
    say(f"node_modules missing on new box {row['box_id']}; prefix your command with {install} &&" + package_manager.version_note(target))


def do_pulls(box_id: str, row: dict, pulls: list[str], *, until: float | None = None,
             foreign: bool = False) -> None:
    for p in pulls:
        opts = {}
        if until is not None:
            remaining = until - now()
            if remaining <= 0:
                raise OffboxError("artifact pull deadline reached; wait again", code=EXIT_WAIT_TIMEOUT, started=True)
            opts['timeout'] = min(1800, remaining)
        detail = f"{row.get('run_id', 'unknown')} {p} -> {row['local_cwd']}"
        prefix = (f"settled background run {row['run_id']} (not this run): "
                  f"pull {p} into {row['local_cwd']}" if foreign else f"pull {p}")
        with contextlib.closing(db()) as con:
            try:
                st = ssh_sync.pull(box_id, row["remote_dir"], row["rel_cwd"] or ".", p, Path(row["local_cwd"]), **opts)
            except Exception as error:
                event(con, box_id, "run_pull_failed", f"{detail} error={error}")
                if foreign:
                    say(f"{prefix} failed: {error}")
                if isinstance(error, subprocess.TimeoutExpired) and until is not None:
                    raise OffboxError("artifact pull deadline reached; wait again", code=EXIT_WAIT_TIMEOUT, started=True) from None
                raise
            if st.get("missing"):
                event(con, box_id, "run_pull_failed", f"{detail} error=not created on the box: {st.get('error')}")
            elif st.get("ok"):
                event(con, box_id, "run_pulled", f"{detail} files={st.get('files', 0)}")
            else:
                event(con, box_id, "run_pull_failed", f"{detail} error={st.get('error')}")
        if until is not None and now() >= until:
            raise OffboxError("artifact pull deadline reached; wait again", code=EXIT_WAIT_TIMEOUT, started=True)
        if st.get("missing"):
            say(f"{prefix}: not created on the box")
        elif st.get("ok"):
            if foreign:
                say(f"settled background run {row['run_id']} (not this run) and pulled {p} "
                    f"into {row['local_cwd']} ({st.get('files', 0)} files)")
            else:
                say(f"pulled {p} ({st.get('files', 0)} files)")
        else:
            say(f"{prefix} failed: {st.get('error')}")


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


def save_run_state(run_id, **values):
    path = LOGS_DIR / f"{run_id}.state.json"
    previous = read_json(path, {})
    atomic_write_json(path, {**previous, **values})


def restore_run_state(row):
    """A remote handle/result survives a failed SQLite write; wait and reap can repair the row."""
    row = dict(row)
    saved = read_json(LOGS_DIR / f"{row['run_id']}.state.json", {})
    restored = {**dict(row), **saved}
    # A competing finisher can commit before a blocked writer saves its result to the file.
    # Keep recoverable handles, but a known terminal result already committed to SQLite wins.
    confirmed_kill = (saved.get('status') == 'killed' and saved.get('exit_code') == 143
                      and row['status'] == 'failed' and row['exit_code'] in (137, 143))
    if row['status'] == 'killed':
        restored.update(status='killed', exit_code=row['exit_code'] or (143 if row.get('process_id') else 130),
                        end_at=row.get('end_at'))
    elif terminal_result(row) and not confirmed_kill:
        for key in ('status', 'exit_code', 'end_at'):
            restored[key] = row.get(key)
    return restored


def terminal_result(row):
    return row['status'] not in ('starting', 'running') and row['exit_code'] is not None


def completed_result(row, remote_status):
    """Use durable local/box evidence before boat's synthetic lost/254 status."""
    if terminal_result(row):
        return row['status'], row['exit_code']
    code = remote_status.get('exitCode')
    state = remote_status.get('status')
    if code is None and row['command_id']:
        code = (api.history_get(row['box_id'], row['command_id']) or {}).get('exitCode')
        if code is not None:
            state = 'exited'
    if state == 'lost' or code in (None, 254):
        recovered, _ = recover_lost_exit(row['box_id'], row['run_id'], None, 0)
        if recovered is not None:
            state, code = 'exited', recovered
    return ('lost' if state == 'lost' else ('done' if code == 0 else 'failed')), code


def state_warning(run_id, code, error):
    result = f"remote exit {code}" if code is not None else "command may still be running"
    statement = "; ".join(getattr(error, "__notes__", []))
    detail = f"{error} ({statement})" if statement else str(error)
    message = (f"{run_id}: {result}; local bookkeeping failed: {detail}. "
               f"Read/repair its result with: offbox wait {run_id}; do not rerun the command")
    say("warning: " + message)
    log(message)


def claim_terminal_log(con, row):
    # Both finish and recovered-start settlement already hold the state writer. Never acquire it only to log.
    try:
        if row is None or row['status'] in ('starting', 'running'):
            return None
        if row['exit_code'] is None and con.execute('SELECT 1 FROM kv WHERE k=?', ('start_unknown:'+row['run_id'],)).fetchone():
            return None
        claimed = con.execute("UPDATE runs SET logged_end_at=? WHERE run_id=? AND logged_end_at IS NULL",
                              (now(), row['run_id']))
        return row if claimed.rowcount else None
    except Exception:
        return None


def emit_terminal(row):
    try:
        import toollog
        code, run_id = row['exit_code'], row['run_id']
        ended = row['end_at'] or now()
        elapsed = max(0, ended - (row['start_at'] or ended)) * 1000
        toollog.emit('run', 'run.end', kind='perf' if code == 0 else 'error', ok=code == 0, duration_ms=elapsed,
                     ids={'run': run_id, 'box': row['box_id']}, props={'exitCode': code, 'fallback': row['mode'] == 'local',
                            **read_json(LOGS_DIR / f'{run_id}.state.json', {})},
                     tag='run_failed' if code != 0 else None)
        if code == 127 and row['mode'] != 'local':
            # The remote shell has no readable output capture. Use only the received tail, without fetching logs.
            name = None
            try:
                with (LOGS_DIR / f'{run_id}.log').open('rb') as stream:
                    stream.seek(max(0, stream.seek(0, 2) - 65536))
                    tail = stream.read().decode(errors='replace').splitlines()[-200:]
                match = re.search(r'(?:^|\s)([A-Za-z0-9_./+-]+): command not found\s*$', '\n'.join(tail), re.M)
                name = match[1] if match and len(match[1]) <= 256 else None
            except OSError:
                pass
            with contextlib.closing(db()) as con:
                event(con, row['box_id'], 'command_not_found', json.dumps({'run': run_id, 'name': name}))
        if row['process_id'] or row['wrapper_pid']:
            command_ms = api.command_execution_ms(row['box_id'], row['process_id'], row['command_id'])
            toollog.emit('run', 'run.command', kind='perf' if code == 0 else 'error', ok=code == 0,
                         duration_ms=command_ms, ids={'run': run_id, 'box': row['box_id']},
                         props={'exitCode': code, 'timeoutHit': code == 124,
                                'cmd_bytes': row['cmd_bytes'], 'cmd_via': row['cmd_via'],
                                'step_count': planned_steps(row)}, tag='command_failed' if code != 0 else None)
    except Exception:
        pass


def killed_result(run_id, *, wait=False, until=None, row=None, known_code=None):
    """Prefer confirmed kill receipts; optional refreshes cannot erase a known result."""
    from .misc import KILL_CONFIRM_S, KILL_REQUEST_S
    cached = restore_run_state(row) if row is not None else None
    if row is not None and terminal_result(row) and row['status'] != 'killed' and row['exit_code'] not in (137, 143):
        return None
    if row is not None and row['status'] == 'killed' and row['exit_code'] is not None:
        return dict(row)
    deadline = now() + KILL_REQUEST_S + KILL_CONFIRM_S + 5
    if until is not None:
        deadline = min(deadline, until)
    while True:
        try:
            with contextlib.closing(db()) as con:
                current = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
                if current is None:
                    return None
                cached = restore_run_state(current)
                if cached['status'] == 'killed':
                    cached['exit_code'] = cached['exit_code'] or (143 if cached['process_id'] else 130)
                    if (current['status'], current['exit_code']) != ('killed', cached['exit_code']):
                        # Repair old killed/NULL rows and confirmed kills saved during a DB outage.
                        con.execute("UPDATE runs SET status='killed',exit_code=?,end_at=COALESCE(end_at,?) WHERE run_id=? "
                                    "AND (status IN ('starting','running') OR exit_code IS NULL OR "
                                    "(status='failed' AND exit_code IN (137,143)))",
                                    (cached['exit_code'], cached.get('end_at') or now(), run_id))
                        con.commit()
                    return cached
                if not wait:
                    return None
                request = con.execute("SELECT kind,ts FROM events WHERE kind IN "
                                      "('run_kill_requested','run_kill_confirming','run_kill_finished') "
                                      "AND substr(detail,1,?)=? ORDER BY rowid DESC LIMIT 1",
                                      (len(run_id) + 1, run_id + ' ')).fetchone()
        except sqlite3.Error as error:
            if cached is not None and cached['status'] == 'killed':
                cached['exit_code'] = cached['exit_code'] or (143 if cached['process_id'] else 130)
                state_warning(run_id, cached['exit_code'], error)
                return cached
            code = known_code if known_code is not None else cached['exit_code'] if cached is not None else None
            if code is None:
                raise
            state_warning(run_id, code, error)
            return None
        if request is None or request['kind'] == 'run_kill_finished':
            return None
        window = KILL_CONFIRM_S + 5 + (KILL_REQUEST_S if request['kind'] == 'run_kill_requested' else 0)
        if now() >= min(deadline, request['ts'] + window):
            return None
        # A request alone is not proof. DELETE and stop confirmation have separate bounded windows.
        time.sleep(min(.5, max(0, deadline - now())))


def report_killed(row, log_path=None):
    if row is None or row['status'] != 'killed' or not row['process_id']:
        return None
    try:
        with contextlib.closing(db()) as con:
            request = con.execute("SELECT detail FROM events WHERE kind='run_kill_requested' "
                                  "AND substr(detail,1,?)=? ORDER BY rowid DESC LIMIT 1",
                                  (len(row['run_id']) + 1, row['run_id'] + ' ')).fetchone()
    except sqlite3.Error:
        request = None  # Optional attribution cannot erase a confirmed kill.
    owner = ('; ' + request['detail'].split(' ', 1)[1]) if request else ''
    say(f"run {row['run_id']} was killed by offbox kill (process {row['process_id']} on {row['box_id']}{owner})")
    planned = planned_steps(row)
    if planned:
        from .misc import _raw_log
        path = _raw_log(log_path or LOGS_DIR / f"{row['run_id']}.log")
        try:
            text = path.read_text(errors='replace')
        except OSError:
            text = ''
        # Evidence annotates the interrupted step; it never decides the run's result.
        detail = run_evidence.describe(text, planned)
        signal_step = re.search(r'caught \w+ at step (\d+)', detail)
        try:
            results = dict(step_results(path))
        except OSError:
            results = {}
        step = int(signal_step[1]) if signal_step else next(
            (n for n in range(1, planned + 1) if n not in results), None)
        progress = f' at step {step} of {planned}' if step and 1 <= step <= planned else ''
        say(f'stopped by offbox kill{progress} ({len(results)} of {planned} step results)')
    return row['exit_code'] if row['exit_code'] is not None else 143


def complete_killed(row, log_path=None, *, pulls=(), until=None):
    pull_metadata = dict(row)
    if pulls and not (pull_metadata.get('local_cwd') and pull_metadata.get('remote_dir') and 'rel_cwd' in pull_metadata):
        say(f"warning: {row['run_id']}: artifact pull after offbox kill skipped (pull metadata unavailable)")
    elif pulls:
        try:
            do_pulls(row['box_id'], dict(row), pulls, until=until)
        except (OffboxError, OSError, subprocess.TimeoutExpired, sqlite3.Error) as error:
            say(f"warning: {row['run_id']}: artifact pull after offbox kill failed ({error})")
    resources.finalize(row)
    return report_killed(row, log_path)


def finish(run_id: str, code: int | None, status: str | None = None, *, catch_up: bool = True,
           until: float | None = None, report: bool = False, run=None, bookkeeping: bool = True, reclaim_tmp: bool = True) -> int | None:
    incoming = code
    log_row = None
    early_catchup = False
    early_history = None
    st = status or ("lost" if code is None else ("done" if code == 0 else "failed"))
    def prepare_result():
        nonlocal code, st, early_catchup, early_history
        if status == 'source_gone':
            return  # No command or step ran; only the caller's source check failed.
        if status == 'killed':
            code, st = incoming, 'killed'
            return
        prior = run
        if prior is None:
            with contextlib.closing(db()) as before:
                prior = before.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        if prior is None:
            return
        if prior['status'] == 'killed':
            code, st = prior['exit_code'] or (143 if prior['process_id'] else 130), 'killed'
            return
        if status == 'busy' and incoming == EXIT_BUSY and not any(
                prior[k] for k in ('box_id', 'command_id', 'process_id')):
            from . import start_check
            with contextlib.closing(db()) as con:
                if not start_check.recovery_marked(con, prior):
                    return  # A pre-box queue refusal has no step results to validate.
        if incoming in (None, 137, 143):
            killed = killed_result(run_id, wait=True, until=until, row=prior, known_code=incoming)
            if killed is not None:
                code, st = killed['exit_code'], 'killed'
                return
        # History can reach the server. An unvalidated wrapper result is never saved as terminal.
        if planned_steps(prior):
            code = None
        from .misc import _raw_log, _catch_up_finished
        disk = offbox_disk_space.result(_raw_log(LOGS_DIR / f'{run_id}.log'), incoming)
        if (catch_up and api.BACKEND == 'boat' and dict(prior).get('mode') == 'bg'
                and not planned_steps(prior) and disk.get('infra_failure') != 'disk_probe'):
            with contextlib.closing(db()) as output_con:
                early_history = _catch_up_finished(output_con, run_id, budget=10 if until is None else max(0, until-now()),
                                   row=dict(prior, status=st, exit_code=incoming))
            early_catchup = True
            disk = offbox_disk_space.result(_raw_log(LOGS_DIR / f'{run_id}.log'), incoming)
        known_infra = status == 'infra' and disk.get('infra_failure') != 'disk_probe'
        code = incoming if known_infra or disk.get('infra_failure') not in (None, 'disk_probe') else settled_steps_code(
            prior, incoming, locked=True, until=until, catch_up=catch_up and not early_catchup, report=report,
            history_result=early_history if isinstance(early_history, str) else None)
        if code is None:
            killed = killed_result(run_id, wait=True, until=until, row=prior, known_code=incoming)
            if killed is not None:
                code, st = killed['exit_code'], 'killed'
                return
        disk = offbox_disk_space.result(_raw_log(LOGS_DIR / f'{run_id}.log'), incoming)
        if known_infra:
            st = 'infra'
        elif planned_steps(prior) and status in (None, 'done', 'failed', 'infra'):
            st = 'infra' if code is None else ('done' if code == 0 else 'failed')
        else:
            st = status or ("lost" if code is None else ("done" if code == 0 else "failed"))
        if dict(prior).get('mode') != 'local':
            space_result(run_id, incoming if disk.get('infra_failure') == 'disk_probe' else code)
            if disk.get('infra_failure'):
                st = 'infra'
    def persist():
        nonlocal log_row
        con = db()
        try:
            with write(con):
                r = con.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
                if r:
                    if r['status'] == 'killed':
                        if r['exit_code'] is None and r['process_id']:
                            con.execute("UPDATE runs SET exit_code=143 WHERE run_id=?", (run_id,))
                    elif st == 'killed' and code == 143 and r['exit_code'] in (None, 137, 143):
                        # Kill confirmation may arrive after the attached client saved lost/infra.
                        con.execute("UPDATE runs SET status='killed',exit_code=143,end_at=? WHERE run_id=?",
                                    (now(), run_id))
                    else:
                        con.execute("UPDATE runs SET status=?, exit_code=?, end_at=? WHERE run_id=? "
                                "AND (status IN ('starting','running') OR (status='lost' AND exit_code IS NULL AND ?='infra') OR "
                                "(exit_code IS NULL AND ? IS NOT NULL AND (status='lost' OR "
                                "(status='infra' AND EXISTS (SELECT 1 FROM kv WHERE k='start_unknown:' || runs.run_id)))))",
                                (st, code, now(), run_id, st, code))
                    r = con.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
                    log_row = claim_terminal_log(con, r)
                    if terminal_result(r):
                        con.execute('DELETE FROM kv WHERE k=?', (f'start_unknown:{run_id}',))
            return r
        finally:
            con.close()
    try:
        db_retry(prepare_result, all_operational=True)
        r = db_retry(persist, all_operational=True)
    except sqlite3.Error as error:
        if code is not None:
            save_run_state(run_id, status=st, exit_code=code, end_at=now())
        if status == 'local_error':
            say(f"{run_id}: local failure could not be recorded ({error}); nothing ran, safe to retry")
        else:
            state_warning(run_id, code, error)
        return code
    if not r:
        return code
    st, code = r['status'], r['exit_code']
    if log_row is not None:
        emit_terminal(log_row)
    if r['box_id'] and reclaim_tmp:
        with contextlib.closing(db()) as handback_con:
            box_disk.hand_back(handback_con, r, until=until)
    if not r["box_id"] or not bookkeeping:
        resources.finalize(r)
        return code
    # No transaction is open while Docker/TTL calls reach the box or boat.
    con = None
    try:
        con = db()
        if catch_up and not early_catchup and not planned_steps(r) and (r['mode'] == 'bg' or con.execute(
                'SELECT 1 FROM kv WHERE k=?', (f'lost_checked:{run_id}',)).fetchone()):
            from .misc import _catch_up_finished
            _catch_up_finished(con, run_id, budget=10 if until is None else max(0, until-now()))
        settle_docker(con, r, st, timeout=10 if until is None else max(0, until-now()))
        lease.touch(r["box_id"])
        if until is None:
            lease.idle_ttl(r['box_id'])
        elif now() < until:
            with api.budget(until-now()):
                lease.idle_ttl(r['box_id'])
        event(con, r["box_id"], "run_end", f"{run_id} status={st} exit={code} {round(now() - (r['start_at'] or now()))}s")
    except sqlite3.Error as error:
        state_warning(run_id, code, error)
    finally:
        if con:
            con.close()
    resources.finalize(r)
    return code


def run_remote(a, me: dict) -> int:
    if a.bg and not os.environ.get(BACKGROUND_RUN_ENV):
        return _background(a, me)
    with prepare.attempts():
        return _run_prepared(a, me)


def _background(a, me: dict) -> int:
    if not a.no_sync and getattr(a, "include", None):
        ssh_sync.push_filters(Path(me["repo_root"]), a.git, a.include)
    rn = Runner(a, me)
    rn.register_pending()
    client_log = rn.log_path.with_suffix('.client.log')
    ready_r = ready_w = accept_r = accept_w = None
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGINT, signal.SIGTERM, signal.SIGHUP))
    interrupted = False
    def defer_interrupt(signum, frame):
        nonlocal interrupted
        interrupted = True
    # Other caller threads can still receive SIGINT and schedule its Python handler on main.
    # Defer that handler too, so caller interruption cannot reject a transferred worker.
    old_sigint = signal.signal(signal.SIGINT, defer_interrupt)
    child = None
    try:
        ready_r, ready_w = os.pipe()
        accept_r, accept_w = os.pipe()
        payload = json.dumps(dict(args=vars(a), me=me, env=dict(os.environ), backend=common.backend(),
                                  home_wait_deadline=home.wait_budget_end(),
                                  ready_fd=ready_w, accept_fd=accept_r, signal_mask=list(mask))).encode()
        boot_env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR')}
        with open(client_log, 'ab', opener=lambda p, f: os.open(p, f, 0o600)) as dst:
            # No preexec_fn: Python/CF code in a forked macOS child is unsafe even before urllib sends a request.
            child = subprocess.Popen([sys.executable, '-u', str(BG_ENTRY), '_bg-queue', rn.run_id],
                                     start_new_session=True, close_fds=True, pass_fds=(ready_w, accept_r),
                                     stdin=subprocess.PIPE, stdout=dst, stderr=subprocess.STDOUT, env=boot_env,
                                     cwd=str(rn.log_path.parent))
        # Until this publication the original caller remains the provable owner. No payload is sent before it.
        rn.record(client_pid=child.pid, start_at=now())
        os.close(ready_w)
        ready_w = None
        os.close(accept_r)
        accept_r = None
        errors = []
        def send():
            try:
                with child.stdin:
                    child.stdin.write(payload)
            except (OSError, ValueError) as error:
                errors.append(error)
        # A large command/env must not fill the pipe and block the readiness deadline.
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
        readable, _, _ = select.select([ready_r], [], [], BG_READY_TIMEOUT_S)
        ready = os.read(ready_r, 1) if readable else b''
        if ready != b'1' or errors:
            raise OffboxError(f"{rn.run_id}: background client could not detach; check {client_log}", code=EXIT_LOCAL)
        os.write(accept_w, b'1')
    except BaseException as error:
        if accept_w is not None:
            try:
                os.write(accept_w, b'0')
            except OSError:
                pass
        if child is not None and child.poll() is None:
            # This PID came from our own spawn. Never leave an unacknowledged worker able to start later.
            child.kill()
            child.wait()
        finish(rn.run_id, EXIT_LOCAL, 'local_error')
        if isinstance(error, OffboxError):
            raise
        if isinstance(error, KeyboardInterrupt):
            raise
        raise OffboxError(f"{rn.run_id}: background client could not detach; check {client_log}", code=EXIT_LOCAL) from error
    finally:
        if ready_r is not None:
            os.close(ready_r)
        if ready_w is not None:
            os.close(ready_w)
        if accept_r is not None:
            os.close(accept_r)
        if accept_w is not None:
            os.close(accept_w)
        # Deliver caller interruptions after handoff; they must not cancel the acknowledged detached worker.
        signal.signal(signal.SIGINT, old_sigint)
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        if interrupted:
            os.kill(os.getpid(), signal.SIGINT)
    print(rn.run_id, flush=True)
    background_wait_hint(rn.run_id)
    say(f"queued in background; client log: {client_log}")
    return 0


def background_wait_hint(run_id: str) -> None:
    say(f"Hand off `offbox wait {run_id}` using the remote-compute skill’s Waiting for a run route, "
        "then end your turn; completion wakes you.")


def background_queue(run_id: str, payload: dict) -> int:
    with queue_lifecycle.client(run_id) as result:
        code = _background_queue(run_id, payload)
        result['exit_code'] = code
        return code


def _background_queue(run_id: str, payload: dict) -> int:
    a, me = SimpleNamespace(**payload['args']), payload['me']
    source_failure = None
    con = db()
    try:
        with write(con):
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
            if (not row or row['mode'] != 'bg' or row['status'] != 'starting' or row['box_id'] or row['process_id']
                    or row['client_pid'] != os.getpid() or row['owner'] != me['owner']
                    or row['repo_root'] != me['repo_root'] or payload['backend'] != common.backend()):
                queue_lifecycle.note(run_id, 'settled', 'adoption_rejected', status=row['status'] if row else None)
                raise OffboxError(f'{run_id}: queued run cannot be adopted', code=EXIT_LOCAL)
            con.execute('UPDATE runs SET client_pid=?,start_at=? WHERE run_id=?', (os.getpid(), now(), run_id))
        cwd = Path(row['local_cwd'] or row['cwd'])
        try:
            _source_present(Path(me['repo_root']), cwd)
            os.chdir(cwd)
        except (common.SourceGone, FileNotFoundError, NotADirectoryError) as error:
            error = error if isinstance(error, common.SourceGone) else common.SourceGone(cwd)
            error.checkpoint = 'queued'
            source_failure = (error, max(0, now() - row['start_at']))
    finally:
        con.close()
    os.environ[BACKGROUND_RUN_ENV] = run_id
    with home.wait_budget(payload.get('home_wait_deadline')):
        return background_client(a, me, ready=payload['ready_fd'], accept=payload['accept_fd'],
                                 signal_mask=payload['signal_mask'], source_failure=source_failure)


def background_client(a, me: dict, ready=None, accept=None, signal_mask=None, source_failure=None) -> int:
    global _background_context
    _background_context = (a, me)
    from . import cli
    rid = os.environ[BACKGROUND_RUN_ENV]
    def interrupted(signum, frame):
        queue_lifecycle.received(rid, signum)
        raise _ClientSignal
    old = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    code = EXIT_LOCAL
    try:
        if ready:
            fd = ready
            signal.pthread_sigmask(signal.SIG_SETMASK, signal_mask)
            try:
                os.write(fd, b'1')
            except BrokenPipeError:
                pass  # The caller can die during handoff; the detached client still owns the queued run.
            finally:
                os.close(fd)
            try:
                # EOF means the caller died after transferring the payload. An explicit rejection fences a timeout.
                accepted = os.read(accept, 1)
            finally:
                os.close(accept)
            if accepted not in (b'1', b''):
                queue_lifecycle.note(rid, 'settled', 'handoff_rejected')
                finish(rid, EXIT_LOCAL, 'local_error')
                return EXIT_LOCAL
        rn = Runner(a, me)
        if source_failure is None:
            try:
                rn.check_source('queued')
            except common.SourceGone as error:
                source_failure = (error, 0)
        if source_failure is not None:
            error, queue_s = source_failure
            rn.queue_s = queue_s
            rn.source_gone(error)
            queue_lifecycle.note(rid, 'settled', 'source_gone', message=str(error))
            say(str(error))
            code = 2
            return code
        code = cli._run_with_retries(a, me)
        return code
    except KeyboardInterrupt:
        code = 130
        return code
    finally:
        try:
            with contextlib.closing(db()) as con:
                row = con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                if (row and row['client_pid'] == os.getpid() and row['status'] == 'starting'
                        and not row['box_id'] and not row['process_id']):
                    finish(rid, code, 'killed' if code == 130 else 'infra')
        except sqlite3.Error as error:
            # The runner already saved any known result; cleanup cannot replace it or mask an active error.
            saved = read_json(LOGS_DIR / f'{rid}.state.json', {})
            with contextlib.suppress(OSError):
                state_warning(rid, saved.get('exit_code') if isinstance(saved, dict) else None, error)
        finally:
            for s, handler in old.items():
                signal.signal(s, handler)


def forward_background(env: dict, *, backend="boat") -> None:
    if _background_context is None:
        raise OffboxError('background failover has no queued run context', code=EXIT_LOCAL)
    # Reuse the stdin protocol on failover too: an exec of the original argv would expose --env values.
    rid = os.environ.get(BACKGROUND_RUN_ENV)
    common.select_backend(backend)
    os.environ.clear()
    os.environ.update(env)
    queue_lifecycle.note(rid, 'handoff', 'forwarded', backend=backend)
    raise SystemExit(_background(*_background_context))


def retry_background(error, *, run_id=None) -> None:
    rid = os.environ.get(BACKGROUND_RUN_ENV) or run_id
    if rid and not error.started:
        returned = bool(run_id and os.environ.get(home.RETURNED_HOME_ENV))
        con = db()
        try:
            with write(con):
                row = con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                fenced = con.execute("SELECT 1 FROM kv WHERE k=? AND v='fenced'", ('lost_confirmed:' + rid,)).fetchone()
                if not row or row['process_id'] or (row['status'] != 'starting' and not (
                        returned and fenced and row['status'] == 'lost' and row['exit_code'] is None)):
                    return
                if returned and row['mode'] == 'fg' and row['client_pid'] != os.getpid():
                    return
                if fenced:
                    # Keep the old fence forever: a late delivery must still lose its original claim.
                    con.execute('UPDATE kv SET v=? WHERE k=?', (new_id('claim'), 'start_claim:' + rid))
                    con.execute('DELETE FROM kv WHERE k=?', ('lost_confirmed:' + rid,))
                con.execute("UPDATE runs SET status='starting', box_id=NULL, error=?, end_at=NULL, "
                            "logged_end_at=CASE WHEN ? THEN NULL ELSE logged_end_at END WHERE run_id=?",
                            (str(error)[:500], returned, rid))
            if returned:
                save_run_state(rid, status='starting', box_id=None, process_id=None, exit_code=None, end_at=None)
        finally:
            con.close()


def reset_disk_retry(error):
    """A background invocation keeps its public run id when nothing ran on the first box."""
    if error.started:
        raise error
    if getattr(error, 'disk_reset', False):
        return
    with contextlib.closing(db()) as con:
        with write(con):
            con.execute("UPDATE runs SET status='starting',box_id=NULL,process_id=NULL,command_id=NULL,"
                        "wrapper_pid=NULL,known_exit_code=NULL,exit_code=NULL,end_at=NULL,error=NULL,"
                        "logged_end_at=NULL WHERE run_id=? AND client_pid=?",
                        (error.run_id, os.getpid()))
            con.execute('INSERT OR REPLACE INTO kv(k,v) VALUES (?,?)',
                        ('start_claim:' + error.run_id, new_id('claim')))
    save_run_state(error.run_id, status='starting', box_id=None, process_id=None, exit_code=None,
                   command_id=None, wrapper_pid=None, known_exit_code=None, end_at=None,
                   infra_failure=None, infra_reason=None, disk_space={}, wrapper_exit_code=None)
    # The public id survives, but stream offsets and disk markers belong to the old attempt.
    # Retain its output for inspection without letting it classify the replacement's exit.
    with log_lock(error.run_id):
        path = LOGS_DIR / f'{error.run_id}.log'
        archive = '.disk-full-' + new_id('attempt')
        for old in (path, *path.parent.glob(path.name + '.*')):
            if old.is_file() and '.disk-full-' not in old.name:
                old.rename(old.with_name(old.name + archive))
    error.disk_reset = True


def clear_disk_receipt(error):
    paths = ' '.join('"$HOME"/' + shlex.quote('.offbox/exit/' + error.run_id + suffix)
                     for suffix in ('.rc', '.dk', '.pid', '.gate'))
    try:
        with api.budget(10):
            ssh_sync.ssh(error.box, 'rm -f -- ' + paths, timeout=10, check=True)
    except (OffboxError, OSError, subprocess.SubprocessError) as failure:
        finish(error.run_id, EXIT_INFRA, 'infra', catch_up=False, bookkeeping=False, reclaim_tmp=False)
        raise OffboxError(f'{error.box}: cannot clear the previous exit receipt ({failure}); '
                          'nothing ran; retry manually', code=EXIT_INFRA) from failure


def _run_prepared(a, me: dict) -> int:
    """Foreground or --bg remote run. Local state failures use exit 96; infrastructure/capacity failures retain 90/91/92."""
    # Refuse unsafe includes before allocating or preparing a box; sync validates again before transfer.
    if not a.no_sync and getattr(a, "include", None):
        ssh_sync.push_filters(Path(me["repo_root"]), a.git, a.include)
    wedged = []
    attempt = 1
    while True:
        try:
            return _run_attempt(a, me)
        except box_disk.Full as e:
            if not getattr(e, 'recovered', False):
                a._disk_exclude = set(getattr(a, '_disk_exclude', ())) | {e.box}
            if os.environ.get(BACKGROUND_RUN_ENV):
                reset_disk_retry(e)
            if getattr(e, 'recovered', False):
                if getattr(e, 'has_receipt', False):
                    clear_disk_receipt(e)
                say(str(e) + '; retrying after cleanup')
                continue
            if attempt == 2 or getattr(a, 'no_retry', False):
                if os.environ.get(BACKGROUND_RUN_ENV):
                    finish(e.run_id, EXIT_INFRA, 'infra', catch_up=False, bookkeeping=False, reclaim_tmp=False)
                raise OffboxError(str(e) + '; box marked disk_full; nothing ran', code=EXIT_INFRA) from e
            prepare.move_once(e)
            attempt += 1
            say(str(e) + '; moved this run to another box')
        except BoxWedged as e:
            wedged.append(e.box)
            if attempt == 2:
                names = (f"{wedged[0]} and {wedged[1]} were both wedged" if len(wedged) == 2 else
                         f"{e.box} was wedged on the replacement attempt")
                raise OffboxError(names + " before the command; both set aside. Nothing ran: retry", code=EXIT_INFRA) from e
            prepare.move_once(e)
            say(wedged_message(e.box, e.evidence, e.stopped, retry=True))
            attempt += 1


def _run_attempt(a, me: dict) -> int:
    rn = Runner(a, me)
    try:
        return _run_remote(a, rn)
    except OffboxError as e:
        e.started = e.started or rn.started
        e.run_id, e.box = rn.run_id, rn.box or e.box
        raise
    except KeyboardInterrupt:
        if not rn.started:
            finish(rn.run_id, 130, 'killed')
        raise
    except sqlite3.Error as error:
        log("remote runner local state failure:\n" + traceback.format_exc())
        if rn.remote_code is not None:
            if not getattr(rn, 'quarantine_pending', False):
                rn.remote_code = finish(rn.run_id, rn.remote_code)
            state_warning(rn.run_id, rn.remote_code, error)
            report_exit("", rn.remote_code)
            return EXIT_INFRA if rn.remote_code is None else rn.remote_code
        if not rn.started and rn.registered:
            finish(rn.run_id, EXIT_LOCAL, 'local_error')
        failure = local_error(error, run_id=rn.run_id if rn.registered else None, started=rn.started)
        failure.box = rn.box
        raise failure from error
    except Exception as e:
        if rn.remote_code is not None:
            state_warning(rn.run_id, rn.remote_code, e)
            report_exit("", rn.remote_code)
            return rn.remote_code
        if not rn.started and rn.registered:
            finish(rn.run_id, EXIT_LOCAL, 'local_error')
        try:
            rn.record(error=str(e)[:500])
        except sqlite3.Error as error:
            state_warning(rn.run_id, None, error)
        failure = local_error(e, run_id=rn.run_id if rn.registered else None, started=rn.started)
        failure.box = rn.box
        raise failure from e
    finally:
        _log_source_change(rn.run_id)
        pool.release_guard(rn.lease_row)


def _host_restarting(signum) -> bool:
    if signum not in (signal.SIGTERM, signal.SIGHUP):
        return False
    try:
        marker = json.loads(RESTART_MARKER.read_text())
        return (isinstance(marker, dict) and type(marker.get('pid')) is int and marker['pid'] > 0
                and type(marker.get('at')) in (int, float) and 0 <= now() - marker['at'] < RESTART_MARKER_MAX_S)
    except (OSError, ValueError):
        return False


def _detach(rn, signum) -> int:
    import toollog
    toollog.emit("run", "run.error", kind="error", ok=False, ids={"run": rn.run_id, "box": rn.box},
                 props={"stage": "install_mid_run"}, tag="install_mid_run")
    # Keep start_at: detaching must not restart #866's orphan age allowance.
    rn.record(mode='bg')
    message = (f"client lost ({signal.Signals(signum).name}); run {rn.run_id} keeps going on {rn.box}. "
               f"Re-attach: offbox wait {rn.run_id}")
    with log_lock(rn.run_id):
        rn.log_path.parent.mkdir(parents=True, exist_ok=True)
        ck = read_json(offsets_path(rn.log_path), {})
        with open(rn.log_path, 'ab') as f:
            # A signal may have interrupted the write-to-checkpoint gap. Only the committed prefix has offsets.
            if ck:
                f.truncate(ck['logBytes'])
                f.seek(0, os.SEEK_END)
            f.write(f"\noffbox: {message}\n".encode())
            length = f.tell()
        _commit(rn.log_path, ck.get('stdoutOffset', 0), ck.get('stderrOffset', 0), length)
    say(message)
    log(message)
    try:
        row = db().execute('SELECT start_at FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        remaining = max(0, int(ORPHAN_RUN_MAX_S - (now() - (row['start_at'] or 0)))) if row else 0
        if remaining:
            lease.ensure_ttl(rn.box, min(BG_TTL_S, remaining), api.get(rn.box))
    except OffboxError as e:
        say(f"could not extend {rn.box}'s deadline: {e}; the reaper will retry")
    return EXIT_DETACHED


def pre_command_disk_full(path, code):
    """Find a candidate in display output; this alone never authorizes replay."""
    from .misc import _raw_log
    path = _raw_log(path)
    if code in (None, 0) or not path.exists():
        return None
    text = path.read_text(errors='replace')
    if COMMAND_STARTED_MARKER in text:
        return None
    record = offbox_disk_space.result(path, code)
    phases = record['disk_space']
    if record.get('infra_reason') == 'low_space_gate':
        return 'tmp', None, phases.get('gate', {})
    line = next((line for line in text.splitlines() if offbox_disk_space.error_line(line)), None)
    if line:
        fs, failed_path = box_disk.push_failure(line)
        space = next((phases[p] for p in ('end', 'start', 'server_start') if p in phases), {})
        return fs, failed_path, space
    return None


def complete_stderr(row):
    if not row or not row['command_id']:
        return None
    # Display output can interleave stdout inside a stderr marker. Only the full stderr
    # stream, or the probe's pre-command receipt, can prove that a retry cannot double-run.
    text, offset = '', 0
    try:
        with api.budget(10):
            for _ in range(8):
                page = api.history_logs(row['box_id'], row['command_id'], 'stderr', offset)
                text += page.get('data') or ''
                if COMMAND_STARTED_MARKER in text:
                    return text
                if page.get('done') is True:
                    return text
                nxt = page.get('nextOffset')
                if type(nxt) is not int or nxt <= offset:
                    return None
                offset = nxt
    except (OffboxError, OSError):
        pass
    return None


def confirmed_disk_full(row, path, code, gate_receipt=None):
    from .misc import _raw_log
    raw = _raw_log(path)
    if raw.exists() and COMMAND_STARTED_MARKER in raw.read_text(errors='replace'):
        return None
    failure = pre_command_disk_full(path, code)
    if not failure and gate_receipt is None:
        return None
    text = complete_stderr(row)
    if text is not None and COMMAND_STARTED_MARKER in text:
        return None
    if gate_receipt is not None:
        return gate_receipt
    if text is None:
        if row and code == EXIT_INFRA and failure[0] == 'tmp':
            return read_gate_receipt(row, until=now()+10)
        return None
    line = next((line for line in text.splitlines() if offbox_disk_space.error_line(line)), None)
    if line:
        fs, failed_path = box_disk.push_failure(line)
        return fs, failed_path, failure[2]
    return failure


def recover_admission_log(row, code):
    from .misc import _catch_up_log, _raw_log
    until = now() + 10
    # Boat's retained box copy also serves a foreground caller whose response was lost.
    _catch_up_log(dict(row, status='done', exit_code=code, mode='bg'), budget=10, locked=True)
    path = _raw_log(LOGS_DIR / f"{row['run_id']}.log")
    if code != EXIT_INFRA or now() >= until:
        return
    if path.exists() and COMMAND_STARTED_MARKER in path.read_text(errors='replace'):
        return
    return read_gate_receipt(row, until=until)


def read_gate_receipt(row, *, until):
    from .misc import _raw_log
    path = _raw_log(LOGS_DIR / f"{row['run_id']}.log")
    if path.exists() and COMMAND_STARTED_MARKER in path.read_text(errors='replace'):
        return
    try:
        left = max(0, until - now())
        if left <= 0:
            return
        with api.budget(left):
            result = ssh_sync.ssh(row['box_id'], 'head -c 65536 -- "$HOME"/' +
                                 shlex.quote('.offbox/exit/' + row['run_id'] + '.gate'), timeout=left)
        record = json.loads(result.stdout) if result.returncode == 0 else {}
        space = record.get('space') if isinstance(record, dict) else None
        if not isinstance(record, dict) or record.get('phase') != 'gate' or not offbox_disk_space.valid_space(space):
            return
        free = space.get('tmp', {}).get('free_bytes')
        if type(free) is int and free < offbox_disk_space.GATE_BYTES:
            with log_lock(row['run_id'], until=until):
                with path.open('a') as output:
                    output.write('\n' + offbox_disk_space.MARKER + json.dumps(record) + '\n')
            return 'tmp', None, space
    except (OffboxError, OSError, ValueError, subprocess.SubprocessError):
        pass


def _run_remote(a, rn) -> int:
    interrupted = {"sig": None}

    def on_sig(signum, _frame):
        if interrupted['sig'] is None:
            interrupted["sig"] = signum
            if os.environ.get(BACKGROUND_RUN_ENV):
                queue_lifecycle.received(rn.run_id, signum)
            raise _ClientSignal

    # Installed before rn.start(): a tool-call timeout's SIGTERM during the pool wait or the lease must reach
    # run_remote's not-started finish ('killed'). With the default handler Python died there and the row stayed
    # 'starting' with no box (31 Oct, run-1031-145121-2b9f).
    old = {s: signal.signal(s, on_sig) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        try:
            with home.pre_start(rn.run_id):
                rn.start()
        except OffboxError as e:
            if not rn.started:
                if not isinstance(e, common.SourceGone):
                    try:
                        rn.check_source('push' if rn.box else 'queued')
                    except common.SourceGone as source_error:
                        e = source_error
                if isinstance(e, common.SourceGone):
                    rn.source_gone(e)
                elif e.code == EXIT_LOCAL:
                    finish(rn.run_id, EXIT_LOCAL, "local_error")
                elif not os.environ.get(BACKGROUND_RUN_ENV) and not (
                        os.environ.get(home.RETURNED_HOME_ENV) and home.unreachable(e)):
                    # Preserve a pre-box refusal's exit without assigning an exit to an uncertain command start.
                    code = e.code if not rn.box and (e.code == EXIT_BUSY or (
                        e.code in (2, EXIT_INFRA) and 'nothing ran' in str(e).lower())) else None
                    finish(rn.run_id, code, "busy" if e.code == EXIT_BUSY else "infra")
            if not isinstance(e, common.SourceGone):
                rn.record(error=str(e)[:500])
            raise e
        if rn.recovered_code in (EXIT_INFRA, 97, 98):
            # A lost start response has no local stream. Recover setup evidence before either
            # foreground settlement or background detachment can discard the admission failure.
            with contextlib.closing(db()) as con:
                row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
            rn.gate_receipt = recover_admission_log(row, rn.recovered_code)
            rn.admission_checked = True
        if a.bg and rn.recovered_code is not None and not pre_command_disk_full(rn.log_path, rn.recovered_code):
            from . import start_check
            with contextlib.closing(db()) as con:
                row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
                start_check.settle(con, row, start_check.Result('started', rn.recovered_code),
                                   'start receipt recovered')
            finish(rn.run_id, rn.recovered_code)
            print(rn.run_id)
            background_wait_hint(rn.run_id)
            if os.environ.get(BACKGROUND_RUN_ENV):
                queue_lifecycle.note(rn.run_id, 'handoff', 'handoff', box_id=rn.box, recovered_code=rn.recovered_code)
            return 0
        if a.bg and rn.recovered_code is None:
            # Nobody stays attached to refresh the deadline: give the box a long one. The reaper stops it
            # IDLE_STOP_S after the process ends (it checks process status itself).
            lease.ensure_ttl(rn.box, BG_TTL_S, api.get(rn.box))
            # Keep the detached client through admission so a disk gate can recover before handing back.
            admission = follow(rn.box, rn.pid, rn.log_path, echo=False, run_id=rn.run_id,
                               until_command_started=True)
            if admission is _COMMAND_RUNNING:
                print(rn.run_id)
                background_wait_hint(rn.run_id)
                say(f"started in background on {rn.box}")
                if os.environ.get(BACKGROUND_RUN_ENV):
                    queue_lifecycle.note(rn.run_id, 'handoff', 'handoff', box_id=rn.box, process_id=rn.pid)
                return 0
            rn.recovered_code = admission
        kill_hint = dict(run_id=rn.run_id, status='running', exit_code=None, process_id=getattr(rn, 'pid', None), box_id=rn.box,
                         step_count=len(getattr(a, 'steps', None) or []), mode='fg')
        stream_killed = None
        code = None
        try:
            code = rn.recovered_code if rn.recovered_code is not None else rn.stream()
            rn.remote_code = None if getattr(a, 'steps', None) else code
        except Interrupted as error:
            remember_interruption(rn.run_id, {'interruption': error.interruption})
            code = finish(rn.run_id, EXIT_INTERRUPTED, "interrupted")
            if code is None:
                raise OffboxError(f"{rn.run_id}: steps incomplete after the interruption; remote exit unknown",
                                  code=EXIT_INFRA, started=True) from None
            raise
        except OffboxError:
            stream_killed = killed_result(rn.run_id, wait=True, row=kill_hint)
            if stream_killed is None or not stream_killed['process_id']:
                raise
            code = stream_killed['exit_code']
    except KeyboardInterrupt:
        if rn.started and rn.box and _host_restarting(interrupted['sig']):
            return _detach(rn, interrupted['sig'])
        rn.kill()
        if not rn.started:
            raise
        # Kill delivery may be uncertain. Keep the slot reserved until status proves exit.
        rn.record(error='interrupted; awaiting confirmed remote termination')
        return 130
    finally:
        for s, h in old.items():
            signal.signal(s, h)
    killed = stream_killed or (killed_result(rn.run_id, wait=True, row=kill_hint, known_code=code)
                              if code in (None, 137, 143) else None)
    if killed is not None and killed['process_id']:
        rn.remote_code = killed['exit_code']
        return complete_killed(killed, rn.log_path, pulls=a.pull)
    if code is None:
        try:
            code, how = recover_lost_exit(rn.box, rn.run_id, rn.log_path, len(getattr(a, "steps", None) or []))
        except OffboxError:
            killed = killed_result(rn.run_id, wait=True, row=kill_hint)
            if killed is None or not killed['process_id']:
                raise
            rn.remote_code = killed['exit_code']
            return complete_killed(killed, rn.log_path, pulls=a.pull)
        if code is not None:
            say(f"boat lost track of the remote process after it ended; exit {code} taken from {how}")
    killed = killed_result(rn.run_id, wait=True, row=kill_hint, known_code=code) if code in (None, 137, 143) else None
    if killed is not None and killed['process_id']:
        rn.remote_code = killed['exit_code']
        return complete_killed(killed, rn.log_path, pulls=a.pull)
    rn.remote_code = None if getattr(a, 'steps', None) else code
    if (code in (EXIT_INFRA, 97, 98) and rn.registered and not getattr(rn, 'admission_checked', False)
            and not pre_command_disk_full(rn.log_path, code)
            and not (rn.log_path.exists() and COMMAND_STARTED_MARKER in rn.log_path.read_text(errors='replace'))):
        # An accepted start can lose its attach stream too; status alone carries no admission evidence.
        with contextlib.closing(db()) as con:
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        rn.gate_receipt = recover_admission_log(row, code)
    disk_candidate = pre_command_disk_full(rn.log_path, code)
    setup_marker = (REPO_SETUP_FAILED_MARKER if repo_setup_failed(code, rn.log_path) else
                    SETUP_FAILED_MARKER if code == 97 and setup_failed(rn.log_path) else None)
    if setup_marker and COMMAND_STARTED_MARKER in rn.log_path.read_text(errors='replace'):
        setup_marker = None
    disk_row = None
    gate_receipt = getattr(rn, 'gate_receipt', None)
    if disk_candidate or gate_receipt or setup_marker:
        with contextlib.closing(db()) as con:
            disk_row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
    disk_failure = confirmed_disk_full(disk_row, rn.log_path, code, gate_receipt)
    setup_stderr = complete_stderr(disk_row) if setup_marker and not disk_candidate else None
    setup_confirmed = (setup_stderr is not None and COMMAND_STARTED_MARKER not in setup_stderr
                       and setup_marker in setup_stderr.splitlines())
    if disk_failure:
        rn.started = False
        rn.remote_code = None
        fs, failed_path, space = disk_failure
        failure = box_disk.Full(rn.box, fs, space)
        failure.run_id = rn.run_id
        if os.environ.get(BACKGROUND_RUN_ENV):
            reset_disk_retry(failure)
        else:
            finish(rn.run_id, code, 'infra', catch_up=False, bookkeeping=False, reclaim_tmp=False)
        with contextlib.closing(db()) as con:
            if rn.box not in getattr(a, '_disk_cleaned', set()):
                a._disk_cleaned = getattr(a, '_disk_cleaned', set()) | {rn.box}
                healthy, space = box_disk.recover(con, rn.box, fs, space, path=failed_path,
                                                  current=disk_row['remote_dir'] or '')
            else:
                healthy = False
                box_disk.retire(con, rn.box, space, fs)
        # The normal pool path may pick this same box only after cleanup proved it healthy.
        failure = box_disk.Full(rn.box, fs, space, cleaned=not healthy)
        failure.disk_reset = bool(os.environ.get(BACKGROUND_RUN_ENV))
        failure.has_receipt = bool(os.environ.get(BACKGROUND_RUN_ENV))
        failure.recovered = healthy
        raise failure
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
    if code == 98 and rn.log_path.exists() and 'offbox-claim-refused' in rn.log_path.read_text(errors='replace'):
        from . import start_check
        con = db()
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        if row:
            start_check.settle(con, row, start_check.Result(), 'duplicate start claim refused (exit 98)')
        finish(rn.run_id, None, 'infra')
        raise OffboxError(f'{rn.run_id} on {rn.box}: start claim refused (exit 98); nothing ran',
                          started=True, run_id=rn.run_id, box=rn.box)
    if setup_confirmed and code == EXIT_REPO_SETUP:
        rn.started = False
        rn.record(error="repo toolchain setup failed (exit 98)")
        finish(rn.run_id, None, "infra")
        raise OffboxError("repo toolchain setup failed (exit 98), not your command", code=EXIT_INFRA)
    if code == 97:
        # Settlement must remain retryable until the pre-command quarantine decision commits.
        rn.quarantine_pending = True
        con = db()
        row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        wedged = settle_box_wedged(con, row, code)
        rn.quarantine_pending = False
        if wedged:
            rn.started = False
            raise BoxWedged(rn.box, *wedged)
    if setup_confirmed and code == 97:
        # The preamble failed before the user command was reached, so nothing ran and fallback is allowed.
        rn.started = False
        rn.record(error="box setup failed (exit 97)")
        finish(rn.run_id, None, "infra")
        raise OffboxError("box setup failed (exit 97), not your command", code=EXIT_INFRA)
    if a.pull:
        con = db()
        do_pulls(rn.box, dict(con.execute("SELECT * FROM runs WHERE run_id=?", (rn.run_id,)).fetchone()), a.pull)
    steps = getattr(a, 'steps', None) or []
    if steps:
        con = db()
        try:
            row = con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        finally:
            con.close()
        step_run = row if row is not None else dict(run_id=rn.run_id, box_id=rn.box, command_id=None, mode='fg')
        rn.remote_code = None
        code = settled_steps_code(step_run, code, log_path=rn.log_path, planned=len(steps), locked=True,
                                  report_start_failure=False)
        rn.remote_code = code
    code = finish(rn.run_id, code, report=True)
    rn.remote_code = code
    killed = killed_result(rn.run_id, row=kill_hint, known_code=code) if code in (None, 137, 143) else None
    if killed is not None and killed['process_id']:
        return report_killed(killed, rn.log_path)
    go_std_glitch(rn.box, rn.run_id, rn.log_path, code)
    if code is None:
        say("remote process was lost (box restarted?); treating as infra failure")
    resources.display(rn.run_id)
    row = getattr(rn, 'lease_row', None)
    line = size_summary(dict(requested_size=a.size, size=row['size'])) if row else ""
    if line:
        say(line)
    steps = getattr(a, "steps", None) or []
    deps_hint = box_deps_hint(rn.root, rn.log_path)
    effective = space_result(rn.run_id, code, rn.log_path, report=True)
    if steps:
        res = step_results(rn.log_path)
        failed = next((n for n, rc in res if rc != 0), None)
        report_exit(steps[failed - 1] if failed else "", code, res, len(steps), deps_hint=deps_hint, box_id=rn.box)
    else:
        report_exit(a.cmd[0] if len(a.cmd) == 1 else shlex.join(a.cmd), code, deps_hint=deps_hint, box_id=rn.box)
    return 90 if effective is None else effective
