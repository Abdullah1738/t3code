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
__offbox_native_crash() {
  # EOF is a crash signal only at callers that already verified the archive checksum.
  LC_ALL=C grep -m 1 -E 'stack smashing detected|Segmentation fault|Illegal instruction|Bus error|core dumped|Aborted|free\(\): invalid|malloc\(\): |Unexpected EOF in archive|Child died with signal[[:space:]]+(4|6|7|11)([^0-9]|$)' "$1" && return 0
  case "${2:-0}" in
    132|134|135|139) echo "native signal (exit $2)" ;;
    *) return 1 ;;
  esac
}
__offbox_unpack_attempt() {
  local log=$1 statuses
  shift
  ( "$@" ) 2>&1 | tee "$log" >&2
  statuses=("${PIPESTATUS[@]}")
  [ "${statuses[0]}" = 0 ] || return "${statuses[0]}"
  return "${statuses[1]}"
}
__offbox_infra_stop() {
  printf 'offbox-space: {"phase":"toolchain","infra_failure":"%s","infra_reason":"%s"}\n' "$1" "$2" >&2
  shift 2
  echo "offbox: $* Nothing ran (exit 90)." >&2
  exit 90
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
