"""Ship the reviewed backend to owner boxes without using their ~/.quint cache."""

import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shlex
import uuid

from . import common, java_version, ssh_sync

CLI_VERSION = '0.33.1'
PREFIX = 'offbox-quint: '
QUINT_WORD = re.compile(r'(?<![A-Za-z0-9_])(?:quint|apalache)(?![A-Za-z0-9_])')

ARCHIVE_SHA = '51e0e9832eb589d346370b54377850697a597e3dfc23dd49246a02df421c9174'
ARCHIVE_NAME = 'apalache-0.62.4-grpc-1.75.0.tgz'
REMOTE_ARCHIVE = f'/home/user/.offbox/quint/{ARCHIVE_SHA}.tgz'


def wrapper_path():
    source = Path(__file__).resolve().parents[4] / 'local-helpers/bin/quint'
    return source if source.is_file() else common.SKILL_DIR / 'tools/quint'


def ensure_archive(box):
    if common.person():
        return
    archive = Path.home() / '.local/share/apalache-patched' / ARCHIVE_NAME
    # Unrelated offbox work remains usable on hosts without the optional backend.
    # The wrapper itself refuses verify if the pinned archive is unavailable.
    if not archive.is_file():
        return
    target = shlex.quote(REMOTE_ARCHIVE)
    check = f'test -f {target} && test "$(sha256sum {target} | cut -d " " -f1)" = {ARCHIVE_SHA}'
    if ssh_sync.ssh(box, check, timeout=30).returncode == 0:
        return
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA:
        raise common.OffboxError('pinned Quint backend archive sha256 mismatch; nothing uploaded')
    temporary = REMOTE_ARCHIVE + '.' + uuid.uuid4().hex
    ssh_sync.put_file(box, temporary, data, mode='600', timeout=300)
    pending = shlex.quote(temporary)
    ssh_sync.ssh(box, f'test "$(sha256sum {pending} | cut -d " " -f1)" = {ARCHIVE_SHA} && mv {pending} {target}', check=True, timeout=30)


def trigger(root: Path, rel: str, argv: list[str], steps=None) -> str:
    cwd = (root / rel).resolve()
    for command in steps or [argv[0] if len(argv) == 1 else shlex.join(argv)]:
        if java_version._command_needs_java(command, cwd, QUINT_WORD):
            return 'command'
    # Specs often live below specs/ or model/ rather than the invocation directory.
    for folder, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in ('.git', 'node_modules', '.venv', '.t3', '.offbox')]
        if any(name.endswith('.qnt') and (Path(folder) / name).is_file() for name in files):
            return 'repo-marker'
    return ''


def block(reason: str = ''):
    if common.person():
        return ':'
    source = wrapper_path().read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    encoded = base64.b64encode(source).decode()
    # Content-addressed paths let an in-flight run keep its exact wrapper when
    # the evaluator releases a newer one. The archive has its own immutable pin.
    staging = f'''__offbox_quint_bin="$HOME/.offbox/quint/{digest}/bin"
mkdir -p "$__offbox_quint_bin" || exit 97
printf %s {shlex.quote(encoded)} | base64 -d > "$__offbox_quint_bin/quint.new.$$" || exit 97
chmod 700 "$__offbox_quint_bin/quint.new.$$" && mv "$__offbox_quint_bin/quint.new.$$" "$__offbox_quint_bin/quint" || exit 97
export __offbox_quint_bin
export QUINT_APALACHE_ARCHIVE={shlex.quote(REMOTE_ARCHIVE)}
export PATH="$__offbox_quint_bin:$PATH"
'''
    return staging + (CLI_SHELL.replace('@VERSION@', CLI_VERSION)
                      .replace('@EXIT@', str(common.EXIT_TOOLCHAIN))
                      .replace('@TRIGGER@', shlex.quote(reason)) if reason else '')


CLI_SHELL = r'''
__offbox_quint_start=$SECONDS
__offbox_quint_event() {
  printf 'offbox-quint: {"attempt":"%s","result":"%s","duration_s":%s,"trigger":"%s"}\n' \
    "$1" "$2" "$((SECONDS - __offbox_quint_start))" @TRIGGER@ >&2
}
__offbox_quint_fail() {
  echo "offbox: quint @VERSION@ install failed ($1); set QUINT_BIN or retry" >&2
  __offbox_quint_event result failed
  exit @EXIT@
}
__offbox_quint_ready() {
  local version
  version=$(timeout -k 2 15 "$1/bin/quint" --version 2>/dev/null) && [ "$version" = '@VERSION@' ]
}
__offbox_quint_ensure() (
  prefix="$HOME/.offbox/quint/cli-@VERSION@"
  # Hold the lock through verification and rename. A second run checks the
  # winner's complete install instead of publishing into its directory.
  flock -w 660 9 || __offbox_quint_fail lock-timeout
  if __offbox_quint_ready "$prefix"; then
    result=present
  else
    __offbox_quint_event install pending
    temporary="$prefix.tmp.$$"
    trap 'rm -rf -- "$temporary"' EXIT
    if timeout -k 5 600 npm install -g --prefix "$temporary" @informalsystems/quint@@VERSION@ >/dev/null 2>&1; then
      __offbox_quint_ready "$temporary" || __offbox_quint_fail version-mismatch
    else
      __offbox_quint_fail "npm-exit-$?"
    fi
    # Only an invalid cache can be here while holding the lock.
    rm -rf -- "$prefix" || __offbox_quint_fail cache-replace
    mv -T -- "$temporary" "$prefix" || __offbox_quint_fail cache-publish
    result=installed
  fi
  echo "offbox: quint @VERSION@ (guarded; cli $result $((SECONDS - __offbox_quint_start))s)" >&2
  __offbox_quint_event result "$result"
) 9> "$HOME/.offbox/quint/cli-@VERSION@.lock"
# Older bases can have the wrapper without its shebang interpreter.
__offbox_quint_runtime() (
  flock -w 360 8 || __offbox_quint_fail zsh-lock-timeout
  [ ! -x /bin/zsh ] || exit 0
  if timeout -k 5 300 sudo -n bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq zsh' >/dev/null 2>&1; then
    [ -x /bin/zsh ] || __offbox_quint_fail zsh-missing
  else
    __offbox_quint_fail "zsh-apt-exit-$?"
  fi
) 8> "$HOME/.offbox/quint/runtime.lock"
__offbox_quint_event check pending
if [ ! -x /bin/zsh ]; then
  __offbox_quint_runtime || exit @EXIT@
fi
if [ "${QUINT_BIN+x}" = x ]; then
  # The wrapper validates explicit overrides; provisioning must not mask them.
  export QUINT_BIN
  echo "offbox: quint @VERSION@ (guarded; cli present $((SECONDS - __offbox_quint_start))s; caller QUINT_BIN)" >&2
  __offbox_quint_event result present
else
  __offbox_quint_ensure || exit @EXIT@
  export QUINT_BIN="$HOME/.offbox/quint/cli-@VERSION@/bin/quint"
fi
unset -f __offbox_quint_ready __offbox_quint_ensure __offbox_quint_runtime __offbox_quint_fail __offbox_quint_event
'''


def setup_events(path: Path, run=None):
    import offbox_protocol
    identity = offbox_protocol.for_run(run, path)
    attempt, prelude = 1, True
    with path.open(errors='replace') as stream:
        for line in stream:
            marker = identity.parse(line)
            if marker and marker.kind == 'retry':
                attempt = marker.fields['attempt']
                prelude = True
            elif identity.blocks_replay(line):
                prelude = False
            elif prelude and line.startswith(PREFIX):
                try:
                    data = json.loads(line[len(PREFIX):])
                    if (data.get('attempt') in ('check', 'install', 'result') and
                            data.get('result') in ('pending', 'present', 'installed', 'failed') and
                            data.get('trigger') in ('command', 'repo-marker')):
                        yield attempt, data
                except (ValueError, AttributeError):
                    continue


def failed_setup(path: Path | None, *, run=None) -> bool:
    if path is None:
        return False
    try:
        text = path.read_text(errors='replace')
        import offbox_protocol
        identity = offbox_protocol.for_run(run, path)
        # Earlier attempts and command-emitted diagnostics cannot stand in for
        # a failure in the final prelude of a stepped run.
        final = []
        for line in text.splitlines():
            marker = identity.parse(line)
            if marker and marker.kind == 'retry':
                final.clear()
            else:
                final.append(line)
        if identity.blocks_replay('\n'.join(final)):
            return False
        for line in reversed(final):
            if not line.startswith(PREFIX):
                continue
            try:
                data = json.loads(line[len(PREFIX):])
                return (data.get('attempt') == 'result' and data.get('result') == 'failed' and
                        data.get('trigger') in ('command', 'repo-marker'))
            except (ValueError, AttributeError):
                return False
        return False
    except OSError:
        return False


def record(con, run, path: Path, backend: str) -> None:
    """Keep setup analytics out of the command stream and deduplicate settlement."""
    import toollog
    try:
        for attempt, data in setup_events(path, run):
            key = f'quint_event:{run["run_id"]}:{attempt}:{data["attempt"]}'
            if con.execute('SELECT 1 FROM kv WHERE k=?', (key,)).fetchone():
                continue
            data.update(box=run['box_id'], backend=backend, run_attempt=attempt)
            common.event(con, run['box_id'], 'quint_ensure', json.dumps(dict(run=run['run_id'], **data)))
            toollog.emit('run', 'run.quint_ensure', ids={'run': run['run_id'], 'box': run['box_id']},
                         props=dict(quint_phase=data['attempt'], quint_result=data['result'], attempt=attempt,
                                    quint_trigger=data['trigger'], backend='home' if backend == 'server' else backend),
                         duration_ms=data['duration_s'] * 1000, ok=data['result'] != 'failed')
            con.execute('INSERT OR IGNORE INTO kv(k,v) VALUES (?,?)', (key, '1'))
            con.commit()
    except Exception:
        pass
