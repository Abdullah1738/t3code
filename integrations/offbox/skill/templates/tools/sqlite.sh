#!/bin/bash
# Noble's apt CLI (3.45) lacks -noinit. Keep the package, divert only its CLI to a verified upstream build.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! declare -F offbox_fetch >/dev/null; then
  source "$(dirname "${BASH_SOURCE[0]}")/fetch.sh"
fi
offbox_sqlite_ok() {
  /usr/bin/sqlite3 -safe -noinit -json -readonly -- :memory: 'select 1' >/dev/null 2>&1
}
offbox_sqlite_cleanup() {
  local legacy=/opt/homebrew/opt/sqlite/bin/sqlite3
  # Old scratch test runs left this exact link in shared pool boxes; it is not a supported mirror.
  if [ -L "$legacy" ] && [ "$(readlink "$legacy")" = /usr/bin/sqlite3 ]; then
    "${priv[@]}" rm -- "$legacy"
  fi
}
priv=()
if [ "$(id -u)" != 0 ]; then priv=(sudo -n); fi
if offbox_sqlite_ok; then
  offbox_sqlite_cleanup
  exit 0
fi
action=upgraded
[ -x /usr/bin/sqlite3 ] || action='installed missing'
"${priv[@]}" apt-get update -qq >/dev/null
"${priv[@]}" apt-get install -y -qq --no-install-recommends sqlite3 >/dev/null
if ! offbox_sqlite_ok; then
  [ "$(uname -m)" = x86_64 ] || { echo 'offbox: SQLite tools require x86_64' >&2; exit 1; }
  stage=$(mktemp -d)
  trap 'rm -rf -- "$stage"' EXIT
  offbox_fetch https://sqlite.org/2026/sqlite-tools-linux-x64-3540100.zip "$stage/tools.zip"
  # SHA3-256 published at https://sqlite.org/download.html for this exact release archive.
  python3 - "$stage" <<'PY'
import hashlib
from pathlib import Path
import sys
import zipfile

stage = Path(sys.argv[1])
archive = stage / 'tools.zip'
expected = '555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f'
if hashlib.sha3_256(archive.read_bytes()).hexdigest() != expected:
    sys.exit('offbox: SQLite archive checksum mismatch')
with zipfile.ZipFile(archive) as bundle:
    (stage / 'sqlite3').write_bytes(bundle.read('sqlite3'))
PY
  chmod 755 "$stage/sqlite3"
  "$stage/sqlite3" -safe -noinit -json -readonly -- :memory: 'select 1' >/dev/null
  "${priv[@]}" install -d /usr/local/lib/offbox
  "${priv[@]}" install -m 755 "$stage/sqlite3" /usr/local/lib/offbox/sqlite3-3.54.1
  "${priv[@]}" dpkg-divert --quiet --local --add --rename --divert /usr/bin/sqlite3.distrib /usr/bin/sqlite3
  "${priv[@]}" ln -sfn /usr/local/lib/offbox/sqlite3-3.54.1 /usr/bin/sqlite3
fi
/usr/bin/sqlite3 -safe -noinit -- :memory: 'select 1' >/dev/null
offbox_sqlite_ok
offbox_sqlite_cleanup
echo "offbox: $action sqlite3 on ${OFFBOX_BOX_ID:-$(hostname)}" >&2
