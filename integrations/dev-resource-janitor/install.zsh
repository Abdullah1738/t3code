#!/bin/zsh -f
# Install the dev-resource-janitor skill from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]    copy skill/ over the live skill, keeping a backup outside the skills directory
#   install.zsh --check        exit 1 if the live skill differs from this tree
#
# The live skill is ~/.config/opencode/skills/dev-resource-janitor. The hourly scheduled janitor and the
# worktree reaper read it from there, so the evaluator installs only after the card is approved.
set -eu

here="${0:A:h}"
src="$here/skill"
live="$HOME/.config/opencode/skills/dev-resource-janitor"
stamp="$(date +%Y%m%d-%H%M%S)"
excludes=(--exclude __pycache__ --exclude '*.pyc' --exclude '*.bak*' --exclude .DS_Store)

mode=install
dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --check) mode=check ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check]"; exit 2 ;;
  esac
done

[[ -d "$src" ]] || { print -u2 "dev-resource-janitor: missing $src"; exit 1 }

if [[ $mode == check ]]; then
  out="$(rsync -rlp --checksum --dry-run --itemize-changes "${excludes[@]}" "$src/" "$live/")"
  if [[ -n "$out" ]]; then
    print -u2 "dev-resource-janitor: live skill differs from $src:"
    print -u2 -r -- "$out"
    exit 1
  fi
  print "dev-resource-janitor: live skill matches $src"
  exit 0
fi

backup_dir="$HOME/.local/share/dev-janitor/backups/skill-$stamp"
changes="$(rsync -rlp --checksum --dry-run --itemize-changes "${excludes[@]}" "$src/" "$live/" 2>/dev/null || true)"
if [[ -z "$changes" ]]; then
  print "dev-resource-janitor: nothing to install (live skill already matches)"
  exit 0
fi
print -r -- "$changes"
if (( dry )); then
  print "dev-resource-janitor: --dry-run, nothing written"
  exit 0
fi

mkdir -p "$backup_dir"
if [[ -d "$live" ]]; then
  rsync -rlp "${excludes[@]}" "$live/" "$backup_dir/"
fi
mkdir -p "$live"
rsync -rlp --checksum "${excludes[@]}" "$src/" "$live/"
print "dev-resource-janitor: installed. Previous copy kept at $backup_dir"
