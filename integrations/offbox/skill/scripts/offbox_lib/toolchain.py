"""Shared, bounded download prelude for repo toolchains (exit 99 never runs user code)."""

from pathlib import Path

EXIT_TOOLCHAIN = 99
FETCH = (Path(__file__).resolve().parents[2] / "templates/tools/fetch.sh").read_text()

SHELL = FETCH + r'''
__offbox_curl() {
  local attempt rc=1 retries=0 option previous=
  for option in "${OFFBOX_FETCH_BOUNDS[@]}"; do
    [ "$previous" != --retry ] || { retries=$option; break; }
    previous=$option
  done
  # Keep the shared bounds, but retry all errors explicitly (including curl 18/35/56).
  for ((attempt=1; attempt<=retries+1; attempt++)); do
    command curl -q "${OFFBOX_FETCH_BOUNDS[@]}" --retry 0 "$@" && return 0
    rc=$?
    echo "offbox: toolchain download attempt $attempt/$((retries+1)) failed (curl exit $rc)" >&2
  done
  return "$rc"
}
__offbox_stop() {
  echo "offbox: toolchain unavailable: $*; nothing ran (exit 99)" >&2
  exit 99
}
__offbox_pin_command() {
  local entry tail=$PATH rest= sep=
  export __offbox_toolchain_bin="$HOME/.offbox/toolchains/commands/${OFFBOX_RUN_ID:-current}"
  mkdir -p "$__offbox_toolchain_bin" || __offbox_stop "cannot create toolchain shim directory"
  if [ "$2" != "$__offbox_toolchain_bin/$1" ]; then
    ln -sf "$2" "$__offbox_toolchain_bin/$1" || __offbox_stop "cannot activate $1 shim"
  fi
  while :; do
    entry=${tail%%:*}
    if [ "$entry" != "$__offbox_toolchain_bin" ]; then
      rest="$rest$sep$entry"; sep=:
    fi
    [[ $tail == *:* ]] || break
    tail=${tail#*:}
  done
  export PATH="$__offbox_toolchain_bin${sep:+:}$rest"
}
'''
