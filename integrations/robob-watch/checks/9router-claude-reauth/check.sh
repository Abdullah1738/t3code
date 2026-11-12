#!/bin/sh
set -eu
umask 077
DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
# robob-watch test copies this file to a scratch directory. Refuse rather than
# accidentally launching a real worker or sending a real alert from that copy.
EXPECTED="$HOME/.local/share/robob-watch/watchers/9router-claude-reauth"
if [ "$DIR" != "$EXPECTED" ] || [ "${WATCH_DIR:-}" != "$EXPECTED" ]; then
  echo 'Refusing live check outside its exact watcher directory; use synthetic tests.' >&2
  exit 1
fi
# Even a manually invoked check must not bypass the parent's deployment hold.
if [ -e "$DIR/ENABLE_REQUIRED" ]; then
  exit 0
fi
# Runner normally serializes each watcher; this also protects against a second
# invocation from a shell or a second runner. The lock file must never be removed.
exec /usr/bin/lockf -k -t 0 "$DIR/supervisor.lock" /usr/bin/env node "$DIR/supervisor.mjs" --live
