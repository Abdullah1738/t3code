#!/bin/zsh -f
# Copy reviewed source only. The evaluator loads/restarts agents after owner approval.
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
source "$here/pushed.zsh"
mode=${1:-install}
[[ $mode == install || $mode == --dry-run || $mode == --check ]] || exit 2
[[ $mode == --dry-run ]] || require_pushed
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
for file in overload.py overload_io.py overload_notify.py host.py host_native.py host_signal.py spawn_sample.py spawn_schema.py logwindow.py toollog.py toollog.sh jobs.py collector.py memory.py deep_inventory.py homebrew.py rollup.py status.py cpu.py cpu_labels.py tailnet.py u_sample.py ssd_probe.py volume_crawls.py process_argv.py disk_budgets.py disk-budgets.json disk_low.py; do
  copy_file "$here/$file" "$HOME/.local/lib/mac-logging/$file" 600
done
# A plain executable wrapper keeps imports local to the installed helper directory.
copy_file "$here/mac-log-rollup" "$HOME/.local/bin/mac-log-rollup" 755
copy_file "$here/mac-log-status" "$HOME/.local/bin/mac-log-status" 755
copy_file "$here/mac-log-window" "$HOME/.local/bin/mac-log-window" 755
for label in com.abdullah.mac-host com.abdullah.mac-log-collector com.abdullah.mac-deep-inventory com.abdullah.mac-memory com.abdullah.mac-cpu com.abdullah.mac-tailnet com.abdullah.mac-ssd-read-probe; do
if [[ $mode == install ]]; then
  /usr/bin/python3 - "$here/launchd/$label.plist" "$HOME/Library/LaunchAgents/$label.plist" <<'PY'
from pathlib import Path
import os,sys
src,dst=map(Path,sys.argv[1:]);dst.parent.mkdir(parents=True,exist_ok=True)
if dst.exists():
 import shutil,time
 shutil.copy2(dst,str(dst)+'.bak-'+str(int(time.time())))
dst.write_text(src.read_text().replace('__HOME__',str(Path.home())));os.chmod(dst,0o600)
PY
elif [[ $mode == --check ]]; then
  /usr/bin/python3 - "$here/launchd/$label.plist" "$HOME/Library/LaunchAgents/$label.plist" <<'PY'
from pathlib import Path
import stat,sys
src,dst=map(Path,sys.argv[1:])
assert dst.read_text() == src.read_text().replace('__HOME__',str(Path.home())), str(dst)+' differs'
assert stat.S_IMODE(dst.stat().st_mode) == 0o600, str(dst)+' mode differs'
PY
else
  print "$here/launchd/$label.plist -> $HOME/Library/LaunchAgents/$label.plist (600; not loaded by installer)"
fi
done

# Only the installer creates the fixed SSD payload. Detection never writes there.
# Fixture override applies to install/check only; the live reader has a fixed path.
probe_file=${MAC_LOG_SSD_PROBE_FILE:-/Volumes/ExternalSSD/.mac-upkeep/probe.bin}
if [[ $mode == install ]]; then
  /usr/bin/python3 "$here/ssd_probe.py" init --path "$probe_file"
elif [[ $mode == --check ]]; then
  /usr/bin/python3 "$here/ssd_probe.py" check --path "$probe_file"
else
  print "$probe_file (4096 bytes; create if missing)"
fi
