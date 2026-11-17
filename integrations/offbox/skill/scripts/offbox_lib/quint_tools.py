"""Ship the reviewed backend to owner boxes without using their ~/.quint cache."""

import base64
import hashlib
from pathlib import Path
import shlex
import uuid

from . import common, ssh_sync

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


def block():
    if common.person():
        return ':'
    source = wrapper_path().read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    encoded = base64.b64encode(source).decode()
    # Content-addressed paths let an in-flight run keep its exact wrapper when
    # the evaluator releases a newer one. The archive has its own immutable pin.
    return f'''__offbox_quint_bin="$HOME/.offbox/quint/{digest}/bin"
mkdir -p "$__offbox_quint_bin" || exit 97
printf %s {shlex.quote(encoded)} | base64 -d > "$__offbox_quint_bin/quint.new" || exit 97
chmod 700 "$__offbox_quint_bin/quint.new" && mv "$__offbox_quint_bin/quint.new" "$__offbox_quint_bin/quint" || exit 97
export __offbox_quint_bin
export QUINT_APALACHE_ARCHIVE={shlex.quote(REMOTE_ARCHIVE)}
export PATH="$__offbox_quint_bin:$PATH"
'''
