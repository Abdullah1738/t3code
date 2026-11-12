#!/bin/zsh -f
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
live="$HOME/.local/share/ovnfs-recovery"
plist="$HOME/Library/LaunchAgents/com.abdullah.ovnfs-recovery.plist"
mode=${1:-install}
[[ $mode == install || $mode == --dry-run || $mode == --check ]] || exit 2
if [[ $mode != --dry-run ]]; then
  [[ -z $(git -C "$repo" status --porcelain -- integrations/ovnfs-recovery integrations/deploy.zsh) ]] || { print -u2 'commit recovery files before installation'; exit 1; }
  remote=$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)
  [[ -n $remote ]] && git -C "$repo" merge-base --is-ancestor HEAD "$remote" || { print -u2 'HEAD must be pushed on origin/main'; exit 1; }
fi
if [[ $mode == --dry-run ]]; then
  print "copy recovery.py -> $live/recovery.py (internal disk)"
  print "render LaunchAgent -> $plist; bootstrap it (starts recovery monitor)"
  exit 0
fi
expected=$(mktemp)
trap 'rm -f "$expected"' EXIT
/usr/bin/python3 - "$expected" "$live" "$HOME" <<'PY'
import plistlib, sys
plist = {"Label":"com.abdullah.ovnfs-recovery",
         "ProgramArguments":["/usr/bin/python3",sys.argv[2]+"/recovery.py"],
         "WorkingDirectory":"/", "RunAtLoad":True, "KeepAlive":True,
         "ThrottleInterval":10, "ProcessType":"Background",
         "StandardOutPath":sys.argv[3]+"/Library/Logs/ovnfs-recovery.log",
         "StandardErrorPath":sys.argv[3]+"/Library/Logs/ovnfs-recovery.log"}
with open(sys.argv[1],"wb") as f: plistlib.dump(plist,f)
PY
if [[ $mode == --check ]]; then
  cmp "$here/recovery.py" "$live/recovery.py"
  cmp "$expected" "$plist"
  launchctl print "gui/$(id -u)/com.abdullah.ovnfs-recovery"
  exit 0
fi
if launchctl print "gui/$(id -u)/com.abdullah.ovnfs-recovery" >/dev/null 2>&1; then
  print -u2 'Already loaded: obtain approval to bootout the monitor before updating it.'
  exit 1
fi
mkdir -p "$live" "${plist:h}" "$HOME/Library/Logs"
stamp=$(date +%Y%m%d-%H%M%S)
for dst in "$live/recovery.py" "$plist"; do
  [[ ! -f $dst ]] || cp -p "$dst" "$dst.bak-$stamp"
done
cp "$here/recovery.py" "$live/recovery.py.tmp"
chmod 644 "$live/recovery.py.tmp"
mv "$live/recovery.py.tmp" "$live/recovery.py"
cp "$expected" "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
print 'ovnfs-recovery installed; inspect launchctl and ~/Library/Logs/ovnfs-recovery.log'
