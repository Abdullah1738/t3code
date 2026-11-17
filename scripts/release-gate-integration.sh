#!/usr/bin/env bash
set -uo pipefail
script_dir=$(cd -- "${BASH_SOURCE[0]%/*}" && pwd) || exit $?

usage() {
  echo "Usage: $0 <out-dir> <integration-name> [test-file ...]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
out_dir=$1
name=$2
case "$name" in
  ''|.|..|*/*) usage ;;
esac
[[ -d "$PWD/integrations/$name" ]] || usage
shift 2

test_args=(test)
for file in "$@"; do
  test_args+=("${file#"integrations/$name/"}")
done

mkdir -p "$out_dir" || exit $?
log="$out_dir/integration-$name.log"
(
  cd "integrations/$name" || exit $?
  if ! command -v bun >/dev/null 2>&1; then
    echo GATE_BUN_MISSING
    exit 127
  fi
  source "$script_dir/release-gate-env.sh" || exit $?
  version=$(bun --version) || exit $?
  printf 'GATE_BUN_VERSION %s\n' "$version"

  if [[ -f bun.lock || -f bun.lockb ]]; then
    bun install --frozen-lockfile
    rc=$?
    if [[ $rc -ne 0 ]]; then
      printf 'GATE_INSTALL_FAILED rc=%s\n' "$rc"
      exit "$rc"
    fi
  else
    echo GATE_NO_LOCKFILE
  fi
  bun "${test_args[@]}"
) > "$log" 2>&1
rc=$?
printf '%s\n' "$rc" > "$out_dir/integration-$name.rc" || exit $?
tail -n 40 "$log"
version=$(awk '/^GATE_BUN_VERSION / { sub(/^GATE_BUN_VERSION /, ""); print; exit }' "$log")
printf 'GATE_BUN integration-%s %s\n' "$name" "$version"
printf 'GATE_STEP integration-%s rc=%s\n' "$name" "$rc"
exit "$rc"
