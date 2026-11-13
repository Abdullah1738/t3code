#!/bin/sh
# Keep installer self-tests independent of the installing agent's homes and logs.
set -eu

pkg=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
py=${1:-/opt/homebrew/bin/python3}
# macOS AF_UNIX socket paths cannot fit another fixture below its long default TMPDIR.
test_root=$(mktemp -d /tmp/hc-tests.XXXXXX)
trap 'rm -rf "$test_root"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$test_root/home" "$test_root/tmp"
cd "$pkg"
env -i HOME="$test_root/home" TMPDIR="$test_root/tmp" \
  TOOLLOG_ROOT="$test_root/tools" PYTHONDONTWRITEBYTECODE=1 \
  PATH="$(dirname -- "$py"):/usr/bin:/bin:/usr/sbin:/sbin" \
  "$py" -m unittest discover -s tests >/dev/null
