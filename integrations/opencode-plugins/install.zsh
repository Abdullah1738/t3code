#!/bin/zsh -f
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
reload_helper="$repo/integrations/local-helpers/libexec/opencode-reload/opencode_reload.py"
reload_sources=(integrations/local-helpers/libexec/opencode-reload integrations/local-helpers/libexec/toollog)
mode=install
reload_flags=()
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) [[ $mode == install ]] || { print -u2 'choose --check or --dry-run'; exit 2 }; mode="${arg#--}" ;;
    --allow-reload) reload_flags=(--allow-reload) ;;
    *) print -u2 'usage: install.zsh [--check | --dry-run] [--allow-reload]'; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix" "${reload_sources[@]}")"
  [[ -z "$dirty" ]] || { print -u2 "opencode-plugins: uncommitted changes under $prefix or reload helper dependencies; commit and push first"; return 1; }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 'opencode-plugins: cannot read origin/main'; return 1; }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "opencode-plugins: HEAD $head is not on origin/main; merge and push first"
    return 1
  fi
}

# The import stays outside plugin/: OpenCode auto-loads each plugin/*.ts file.
files=("$here"/lib/*.ts "$here"/lib/*.mjs "$here"/plugin/*.ts)
for src in "${files[@]}" "$reload_helper" "$repo/integrations/local-helpers/libexec/toollog/toollog.py"; do
  [[ -f "$src" && -r "$src" ]] || { print -u2 "opencode-plugins: missing or unreadable source: $src"; exit 1; }
done
if [[ $mode == dry-run ]]; then
  reload_flags+=(--dry-run)
fi
pairs=()
rc=0
changed=0
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
  pairs+=(--pair "$src" "$dst")
  if ! cmp -s "$src" "$dst"; then
    changed=1
  fi
done
[[ $mode != check ]] || exit $rc
[[ $mode != install || $changed == 0 ]] || pushed
python3 -B "$reload_helper" --installer opencode-plugins "${reload_flags[@]}" "${pairs[@]}"
[[ $mode != dry-run ]] || { print 'opencode-plugins: dry run; nothing changed'; exit 0; }
print "opencode-plugins: installed $(git -C "$repo" rev-parse --short HEAD)"
