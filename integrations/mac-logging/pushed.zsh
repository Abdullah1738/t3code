# The installed source must be clean and reachable from origin/main, not just a local branch.
require_pushed() {
  [[ -z $(git -C "$repo" status --porcelain -- integrations/mac-logging integrations/cve-sweep integrations/health-backup integrations/memory-system/scripts/memory_backup.sh integrations/dev-resource-janitor integrations/robob-watch/watchers/disk-space-guard) ]] || { print -u2 'mac: uncommitted upkeep changes'; return 1; }
  local remote
  remote=$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)
  [[ -n $remote ]] && git -C "$repo" merge-base --is-ancestor HEAD "$remote" || { print -u2 'mac: HEAD not on origin/main; merge and push before install'; return 1; }
}

require_mode() {
  /usr/bin/python3 -c 'import os,stat,sys; sys.exit(stat.S_IMODE(os.stat(sys.argv[1]).st_mode) != int(sys.argv[2],8))' "$1" "$2"
}
