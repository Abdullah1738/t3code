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
# Keep the previous run's evidence before publishing interpreter startup.
WATCH_PREVIOUS_PHASE=$(cat "$DIR/.phase" 2>/dev/null || true)
WATCH_STARTED_AT="$(/bin/date +%s)000"
export WATCH_PREVIOUS_PHASE WATCH_STARTED_AT
printf '{"phase":"sh","t":%s}\n' "$WATCH_STARTED_AT" > "$DIR/.phase" || true
# Runner normally serializes each watcher; this also protects against a second
# invocation from a shell or a second runner. The lock file must never be removed.
exec /usr/bin/lockf -k -t 0 "$DIR/supervisor.lock" /usr/bin/env node "$DIR/supervisor.mjs" --live
