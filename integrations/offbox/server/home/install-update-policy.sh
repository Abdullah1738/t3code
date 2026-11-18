#!/bin/bash
# Install only the daily-update policy. No apt, systemctl, Incus or daemon action.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${1:-/}
SRC=$HERE/stick/offbox/target/rootfs
CONF=etc/needrestart/conf.d/50-offbox.conf
WRITER=usr/local/sbin/offbox-restart-pending
APT=etc/apt/apt.conf.d/52offbox-unattended
HOOK=etc/apt/apt.conf.d/zz-offbox-restart-pending

# Validate the complete payload before enabling its apt hook.
perl -c "$SRC/$CONF"
python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$SRC/$WRITER"
test -s "$SRC/$APT"
test -s "$SRC/$HOOK"
copy() {
  local source=$1 dest=$2 mode=$3 temp
  mkdir -p "$(dirname "$dest")"
  temp=$(mktemp "$(dirname "$dest")/.offbox-update.XXXXXX")
  if ! install -m "$mode" "$source" "$temp" || ! mv -f "$temp" "$dest"; then
    rm -f "$temp"
    return 1
  fi
}
copy "$SRC/$CONF" "$ROOT/$CONF" 0644
copy "$SRC/$WRITER" "$ROOT/$WRITER" 0755
copy "$SRC/$APT" "$ROOT/$APT" 0644
copy "$SRC/$HOOK" "$ROOT/$HOOK" 0644
