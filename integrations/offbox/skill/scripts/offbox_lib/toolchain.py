"""Shared, bounded download prelude for repo toolchains (exit 99 never runs user code)."""

EXIT_TOOLCHAIN = 99

SHELL = r'''
__offbox_curl() {
  local attempt rc=1
  # Same per-attempt bounds as templates/tools/fetch.sh; explicitly retry *all* errors, including curl 18/35/56.
  for attempt in 1 2 3; do
    command curl -q --connect-timeout 20 --speed-limit 30720 --speed-time 60 --max-time 600 "$@" && return 0
    rc=$?
    echo "offbox: toolchain download attempt $attempt/3 failed (curl exit $rc)" >&2
  done
  return "$rc"
}
__offbox_stop() {
  echo "offbox: toolchain unavailable: $*; nothing ran (exit 99)" >&2
  exit 99
}
__offbox_pin_command() {
  export __offbox_toolchain_bin="$HOME/.offbox/toolchains/commands/${OFFBOX_RUN_ID:-current}"
  mkdir -p "$__offbox_toolchain_bin" || __offbox_stop "cannot create toolchain shim directory"
  if [ "$2" != "$__offbox_toolchain_bin/$1" ]; then
    ln -sf "$2" "$__offbox_toolchain_bin/$1" || __offbox_stop "cannot activate $1 shim"
  fi
  export PATH="$__offbox_toolchain_bin:$PATH"
}
'''
