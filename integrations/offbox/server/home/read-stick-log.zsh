#!/bin/zsh
# read-stick-log.zsh: summarise what the installer stick recorded, once it is plugged back into this Mac.
#
#   read-stick-log.zsh [--volume /Volumes/OFFBOXLOG] [--save DIR]
#
# Prints: how far each installer boot got, what was decided about the disks and why, the first real error if
# there was one, what hardware Linux saw (disks, NIC + driver + link, board, BIOS), and the reports the
# installed system added. --save copies the log volume to DIR for a closer look (without the installer's
# Tailscale identity, which is a secret).
set -u
setopt null_glob
VOL= SAVE=
while (( $# )); do
  case $1 in
    --volume) VOL=$2; shift 2 ;;
    --save) SAVE=$2; shift 2 ;;
    *) print -u2 "usage: read-stick-log.zsh [--volume DIR] [--save DIR]"; exit 2 ;;
  esac
done
if [[ -z $VOL ]]; then
  for v in /Volumes/OFFBOXLOG*; do [[ -e $v/OFFBOX-LOG-VOLUME ]] && VOL=$v && break; done
fi
[[ -n $VOL && -e $VOL/OFFBOX-LOG-VOLUME ]] || { print -u2 "no OFFBOXLOG volume mounted (plug the stick into this Mac)"; exit 1; }

hr() { print -r -- "---- $*"; }
hr "stick log volume: $VOL"
markers=($VOL/(#i)(WIPE-EVERYTHING|REINSTALL-OS)(|.txt)(N))
(( ${#markers} )) && print -r -- "marker file(s) present: ${markers:t}   <- the next boot from this stick will act on them"
[[ -s $VOL/fail-count ]] && print -r -- "failed installs in a row: $(tr -cd 0-9 < $VOL/fail-count)"

if [[ ! -s $VOL/stage.log ]]; then
  cat <<'EOF'
stage.log is empty: no installer session ever wrote to this stick.
That means the server never booted Linux from it. Causes, most likely first:
  - the board did not boot from USB (boot order, or the stick is in a port the firmware does not boot from)
  - the board did not POST at all (CPU/RAM not seated, memory training still running, BIOS too old for the CPU:
    BIOS FlashBack with A5677.CAP on this stick is the screenless fix)
  - Secure Boot refused the stick's bootloader (unlikely: it is Ubuntu's signed shim)
None of these can be told apart without the board's Q-LED or a screen.
EOF
  exit 1
fi

hr "stage log (last 40 lines; one line per step, 'boot=N' is the installer boot number)"
tail -40 $VOL/stage.log

hr "installer boots"
last_dir=
for d in $VOL/logs/[0-9]*(/N); do
  last=$(tail -1 $d/stage.log 2>/dev/null | cut -c1-150)
  print -r -- "${d:t}: ${last:-no stage.log}"
  last_dir=$d
done

if [[ -n $last_dir ]]; then
  hr "last installer boot: ${last_dir:t}"
  if [[ -s $last_dir/plan.json ]]; then
    /usr/bin/python3 -I - $last_dir/plan.json <<'EOF'
import json, sys
p = json.load(open(sys.argv[1]))
print(f"decision: action={p.get('action')} mode={p.get('mode')}")
print(f"reason:   {p.get('reason')}")
for d in p.get("facts", {}).get("nvme", []):
    parts = ", ".join(f"p{x['number']}:{x.get('name') or '-'}:{x.get('fstype') or '-'}" for x in d.get("partitions", []))
    print(f"disk:     {d['path']} {d.get('model')} {d['size'] / 1e12:.2f} TB  [{parts or 'no partitions'}]")
others = [d for d in p.get("facts", {}).get("all_disks", []) if not str(d.get("name", "")).startswith(("nvme", "loop", "ram", "zram"))]
for d in others:
    print(f"other:    {d.get('name')} {d.get('tran')} {d.get('model')} {int(d.get('size') or 0) / 1e9:.0f} GB")
EOF
  else
    print "no plan.json: the installer did not get as far as looking at the disks (subiquity never reached early-commands)"
  fi
  inv=$last_dir/inventory
  if [[ -d $inv ]]; then
    hr "hardware as Linux saw it"
    [[ -s $inv/dmi.txt ]] && grep -E 'board_name|bios_version|bios_date|product_name' $inv/dmi.txt
    [[ -s $inv/cpu.txt ]] && grep -m1 'model name' $inv/cpu.txt
    [[ -s $inv/meminfo.txt ]] && grep MemTotal $inv/meminfo.txt
    if [[ -s $inv/lspci.txt ]]; then
      print "network controllers (a line without 'Kernel driver in use' = no driver in this kernel):"
      awk '/Ethernet controller|Network controller/{p=1; print "  " $0; next} p && /Kernel driver in use/{print "    " $0} /^[0-9a-f]/{if(!/Ethernet controller|Network controller/)p=0}' $inv/lspci.txt
    fi
    [[ -s $inv/nics.txt ]] && grep -E '^== |Speed:|Link detected:|^(up|down|unknown)$' $inv/nics.txt | paste -sd' ' - | sed 's/== /\n  /g'
    [[ -s $inv/ip.txt ]] && { print "addresses:"; grep -E 'inet ' $inv/ip.txt | grep -v ' lo$' | sed 's/^/  /'; }
  fi
  hr "first errors in that boot"
  found=0
  for f in $last_dir/early.log $last_dir/prepare.log $last_dir/late.log; do
    [[ -s $f ]] || continue
    if grep -n -m3 -E 'Traceback|failed rc=|No such file|not found|cannot|Error|error:' $f >/dev/null 2>&1; then
      print -r -- "${f:t}:"; grep -n -m5 -E 'Traceback|failed rc=|cannot |Error|error:' $f | cut -c1-200 | sed 's/^/  /'; found=1
    fi
  done
  if [[ -s $last_dir/subiquity-server-debug.log ]]; then
    if grep -q -E 'Traceback|ERROR' $last_dir/subiquity-server-debug.log; then
      print "subiquity-server-debug.log:"; grep -n -E 'ERROR|Traceback' $last_dir/subiquity-server-debug.log | head -8 | cut -c1-220 | sed 's/^/  /'; found=1
    fi
  fi
  if [[ -s $last_dir/curtin-install.log ]] && grep -q -E 'Traceback|finish: cmd-install.*FAIL' $last_dir/curtin-install.log; then
    print "curtin-install.log:"; grep -n -E 'Traceback|FAIL|Error' $last_dir/curtin-install.log | head -8 | cut -c1-220 | sed 's/^/  /'; found=1
  fi
  (( found )) || print "none found in early/prepare/late/subiquity/curtin logs"
  print -r -- "full logs: $last_dir/  (journal.txt, installer-logs.tgz, inventory/)"
fi

hr "reports from the installed system"
reps=($VOL/installed/*.txt(Nom))
if (( ${#reps} )); then
  print -r -- "${#reps} report(s); newest: ${reps[1]:t}"
  head -16 $reps[1] | cut -c1-200
else
  print "none: the installed system never booted with this stick plugged in (or never booted)"
fi

hr "reading"
last=$(tail -1 $VOL/stage.log)
case $last in
  *" installed-system "*) print "The installed system booted and wrote here last. If it is not reachable: its report above shows ip= and tailscale=." ;;
  *" late-done "*) print "The install finished. The installed system has not reported yet: either it has not booted with the stick in, or it did not boot." ;;
  *" hold "*|*" refuse "*|*" abort "*) print "The installer stopped on purpose (see 'decision' and 'reason' above). It restarts by itself after the hold and decides again." ;;
  *" install-failed "*) print "subiquity failed the install; the errors above are the place to start. It retries by itself." ;;
  *" live-start "*|*" live-ready "*) print "Linux booted from the stick but the network never came up and subiquity never started the install: check the NIC lines above, then journal.txt." ;;
  *" live-reachable "*) print "The installer session was up with a network, but subiquity did not reach early-commands: journal.txt and subiquity-server-debug.log (autoinstall config rejected?)." ;;
  *" deadline "*) print "The install neither finished nor failed within the deadline and the installer restarted itself." ;;
  *) print "Last step: $last" ;;
esac

if [[ -n $SAVE ]]; then
  mkdir -p $SAVE
  rsync -a --exclude ts-installer --exclude 'tailscale-authkey*' --exclude .fseventsd --exclude .Spotlight-V100 --exclude .Trashes $VOL/ $SAVE/
  print -r -- "saved a copy to $SAVE (without the installer's Tailscale identity)"
fi
