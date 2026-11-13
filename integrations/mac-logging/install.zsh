#!/bin/zsh -f
# Copy reviewed source only. The evaluator loads/restarts agents after owner approval.
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
source "$here/pushed.zsh"
require_pushed
mode=${1:-install}
[[ $mode == install || $mode == --dry-run || $mode == --check ]] || exit 2
copy_file() {
  local src=$1 dst=$2 perm=$3
  if [[ $mode == --check ]]; then
    cmp -s "$src" "$dst" || { print -u2 "differs: $dst"; return 1; }
    /usr/bin/python3 -c 'import os,stat,sys; sys.exit(stat.S_IMODE(os.stat(sys.argv[1]).st_mode) != int(sys.argv[2],8))' "$dst" "$perm"
  elif [[ $mode == --dry-run ]]; then
    print "$src -> $dst ($perm)"
  else
    mkdir -p "${dst:h}"
    [[ ! -e $dst ]] || cp -p "$dst" "$dst.bak-$(date +%Y%m%d-%H%M%S)"
    install -m "$perm" "$src" "$dst"
  fi
}
for file in toollog.py toollog.sh jobs.py collector.py rollup.py; do
  copy_file "$here/$file" "$HOME/.local/lib/mac-logging/$file" 600
done
# A plain executable wrapper keeps imports local to the installed helper directory.
copy_file "$here/mac-log-rollup" "$HOME/.local/bin/mac-log-rollup" 755
if [[ $mode == install ]]; then
  /usr/bin/python3 - "$here/launchd/com.abdullah.mac-log-collector.plist" "$HOME/Library/LaunchAgents/com.abdullah.mac-log-collector.plist" <<'PY'
from pathlib import Path
import os,sys
src,dst=map(Path,sys.argv[1:]);dst.parent.mkdir(parents=True,exist_ok=True)
if dst.exists():
 import shutil,time
 shutil.copy2(dst,str(dst)+'.bak-'+str(int(time.time())))
dst.write_text(src.read_text().replace('__HOME__',str(Path.home())));os.chmod(dst,0o600)
PY
elif [[ $mode == --check ]]; then
  /usr/bin/python3 - "$here/launchd/com.abdullah.mac-log-collector.plist" "$HOME/Library/LaunchAgents/com.abdullah.mac-log-collector.plist" <<'PY'
from pathlib import Path
import stat,sys
src,dst=map(Path,sys.argv[1:])
assert dst.read_text() == src.read_text().replace('__HOME__',str(Path.home())), 'collector plist differs'
assert stat.S_IMODE(dst.stat().st_mode) == 0o600, 'collector plist mode differs'
PY
else
  print "proposed plist: com.abdullah.mac-log-collector (hourly); not loaded by installer"
fi
