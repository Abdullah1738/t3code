#!/bin/zsh -f
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
mode=install
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) [[ $mode == install ]] || { print -u2 'choose --check or --dry-run'; exit 2 }; mode="${arg#--}" ;;
    *) print -u2 'usage: install.zsh [--check | --dry-run]'; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix")"
  [[ -z "$dirty" ]] || { print -u2 "opencode-plugins: uncommitted changes under $prefix; commit and push first"; return 1; }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 'opencode-plugins: cannot read origin/main'; return 1; }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "opencode-plugins: HEAD $head is not on origin/main; merge and push first"
    return 1
  fi
}

# The import stays outside plugin/: OpenCode auto-loads each plugin/*.ts file.
files=("$here"/lib/*.mjs "$here"/plugin/*.ts)
rc=0
stamp="$(date +%Y%m%d-%H%M%S)-$$"
[[ $mode != install ]] || pushed
for src in "${files[@]}"; do
  rel="${src#$here/}"
  dst="$HOME/.config/opencode/$rel"
  if [[ $mode == check ]]; then
    if [[ ! -e "$dst" ]]; then
      print "opencode-plugins: $rel not installed"
      rc=1
    elif ! cmp -s "$src" "$dst"; then
      print -u2 "opencode-plugins: drift: $dst differs from the repo"
      rc=1
    else
      print "opencode-plugins: $rel matches"
    fi
    continue
  fi
  cmp -s "$src" "$dst" && continue
  print "update $dst"
  [[ $mode != dry-run ]] || continue
  mkdir -p "${dst:h}"
  [[ ! -e "$dst" ]] || cp -p "$dst" "$dst.bak-$stamp"
  cp -p "$src" "$dst"
done
[[ $mode != check ]] || exit $rc
[[ $mode != dry-run ]] || { print 'opencode-plugins: dry run; nothing changed'; exit 0; }
print "opencode-plugins: installed $(git -C "$repo" rev-parse --short HEAD)"
print "A plugin change needs an OpenCode restart. Ask Abdullah for his go; this installer does not restart it."
