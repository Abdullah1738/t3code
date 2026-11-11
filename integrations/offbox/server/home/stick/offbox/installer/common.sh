#!/bin/bash
# Shared helpers for the installer-side scripts on the offbox stick (live-setup, early, late, error).
# Sourced, never run. Everything here must work with nobody watching: no prompts, no hard failures.

export OFFBOX_SRC=/cdrom/offbox
RUN=/run/offbox
LOGMNT=$RUN/logvol
mkdir -p "$RUN"
# The status screen of the installer session lives on its own virtual console (live-setup.sh draws it).
# tty1 is Ubuntu's installer UI and tty2-6 are shells; none of them is touched.
SCREEN_VT=8

# Test knobs come from QEMU fw_cfg (opt/offbox/<name>). The files do not exist on real hardware, so the
# defaults below are what the real box runs.
testcfg() {
  local f=/sys/firmware/qemu_fw_cfg/by_name/opt/offbox/$1/raw
  if [ ! -d /sys/firmware/qemu_fw_cfg ]; then modprobe -q qemu_fw_cfg 2>/dev/null || true; fi
  if [ -r "$f" ]; then tr -d '\n' < "$f"; fi
}
cfgval() {
  local v
  v=$(testcfg "$1")
  echo "${v:-$2}"
}

now() { date -u +%Y%m%dT%H%M%SZ; }

cmdline_arg() {
  local a
  for a in $(cat /proc/cmdline); do
    case $a in "$1"=*) echo "${a#*=}"; return 0 ;; esac
  done
  return 1
}

# efibootmgr is not part of the live installer session (the installer only runs it inside the target), but
# the ISO's package pool carries it and its libraries are present. Unpack it on first use and put it in
# /usr/local/sbin: /run is mounted noexec, a binary cannot run from there.
efibootmgr() {
  local bin deb tmp
  bin=$(type -P efibootmgr)
  if [ -z "$bin" ]; then
    deb=$(find /cdrom/pool/main/e/efibootmgr -name 'efibootmgr_*_amd64.deb' 2>/dev/null | sort | tail -1)
    if [ -n "$deb" ]; then
      tmp=$(mktemp -d /tmp/offbox-efibootmgr.XXXXXX)
      dpkg -x "$deb" "$tmp" 2>/dev/null
      bin=$(find "$tmp" -type f -name efibootmgr 2>/dev/null | head -1)
      if [ -n "$bin" ] && install -m 0755 "$bin" /usr/local/sbin/efibootmgr 2>/dev/null; then
        bin=/usr/local/sbin/efibootmgr
      else
        bin=''
      fi
      rm -rf "$tmp"
    fi
  fi
  if [ -z "$bin" ]; then echo "efibootmgr is not available in this session" >&2; return 127; fi
  "$bin" "$@"
}

# Firmware boot order while an install is in progress.
# Ubuntu's installer always registers the disks with the firmware when it installs GRUB (its last own step,
# minutes before our late.sh has finished the system), and puts them first in the boot order. A power cut
# after that would start a half-configured system. Two measures:
#   pin_stick_next     BootNext = the entry this session was started from (the stick). BootNext outranks the
#                      boot order for exactly one boot, so the next power-on comes back to the stick.
#   drop_disk_entries  delete boot entries that point at the target disks' ESPs.
# late.sh clears BootNext (unpin_stick_next) once the install is finished and the disks are bootable.
pin_stick_next() {
  local cur
  cur=$(efibootmgr 2>/dev/null | sed -n 's/^BootCurrent: //p')
  [ -n "$cur" ] || return 1
  efibootmgr -n "$cur" >/dev/null 2>&1 || return 1
  echo "$cur"
}
unpin_stick_next() {
  efibootmgr 2>/dev/null | grep -q '^BootNext' || return 0
  efibootmgr -N >/dev/null 2>&1
}
drop_disk_entries() {
  local d pu n
  for d in "$@"; do
    [ -b "${d}p1" ] || continue
    pu=$(blkid -o value -s PARTUUID "${d}p1" 2>/dev/null)
    [ -n "$pu" ] || continue
    for n in $(efibootmgr -v 2>/dev/null | grep -i "$pu" | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\).*/\1/p'); do
      efibootmgr -b "$n" -B >/dev/null 2>&1 && stage firmware-cleanup "removed the boot entry Boot$n (${d}p1)"
    done
  done
}

# ---- the log volume (stick partition 2, FAT32, the only stick volume the installer writes to)
logvol_mounted() { mountpoint -q "$LOGMNT" && [ -e "$LOGMNT/OFFBOX-LOG-VOLUME" ]; }

logvol_mount() {
  logvol_mounted && return 0
  local src disk p
  src=$(findmnt -n -o SOURCE /cdrom 2>/dev/null || true)
  disk=
  [ -n "$src" ] && disk=$(lsblk -no PKNAME "$src" 2>/dev/null | head -1)
  mkdir -p "$LOGMNT"
  # Partitions of the stick first, then any other FAT volume (a second stick, a rebuilt layout).
  for p in $( { [ -n "$disk" ] && lsblk -lnpo NAME,FSTYPE "/dev/$disk" | awk '$2=="vfat"{print $1}'
                lsblk -lnpo NAME,FSTYPE | awk '$2=="vfat"{print $1}'; } | awk '!seen[$0]++'); do
    [ "$p" = "$src" ] && continue
    # Look read-only first: other USB volumes (a KVM's virtual drive, a forgotten stick) are never written to.
    mount -t vfat -o ro,tz=UTC "$p" "$LOGMNT" 2>/dev/null || continue
    if [ ! -e "$LOGMNT/OFFBOX-LOG-VOLUME" ]; then
      umount "$LOGMNT" 2>/dev/null || true
      continue
    fi
    umount "$LOGMNT" 2>/dev/null || true
    if mount -t vfat -o rw,flush,quiet,umask=077,shortname=mixed,tz=UTC "$p" "$LOGMNT" 2>/dev/null &&
       touch "$LOGMNT/.offbox-write-test" 2>/dev/null; then
      rm -f "$LOGMNT/.offbox-write-test"
      echo "$p" > "$RUN/logvol.dev"
      return 0
    fi
    # Our log volume, but it cannot be written (read-only virtual media, a write-protected stick):
    # logs stay in RAM for this boot.
    umount "$LOGMNT" 2>/dev/null || true
    echo "$p" > "$RUN/logvol.readonly"
    return 1
  done
  return 1
}

logvol_umount() {
  sync
  mountpoint -q "$LOGMNT" && umount "$LOGMNT" 2>/dev/null
  return 0
}

# One directory per installer boot: logs/NNNN-<utc>. The counter survives a wrong RTC.
bootdir() {
  if [ -s "$RUN/bootdir" ]; then cat "$RUN/bootdir"; return 0; fi
  local seq=0 d
  if logvol_mount; then
    mkdir -p "$LOGMNT/logs"
    [ -s "$LOGMNT/logs/seq" ] && seq=$(tr -cd 0-9 < "$LOGMNT/logs/seq")
    seq=$(( ${seq:-0} + 1 ))
    echo "$seq" > "$LOGMNT/logs/seq"
    d=$LOGMNT/logs/$(printf '%04d' "$seq")-$(now)
    # Keep the volume from filling up: drop the oldest boots when under 400 MB free.
    while [ "$(df -Pm "$LOGMNT" | awk 'NR==2{print $4}')" -lt 400 ] 2>/dev/null; do
      local old
      old=$(find "$LOGMNT/logs" -mindepth 1 -maxdepth 1 -type d | sort | head -1)
      [ -n "$old" ] || break
      rm -rf "$old"
    done
  else
    d=$RUN/log-ram
  fi
  mkdir -p "$d"
  echo "$seq" > "$RUN/bootseq"
  echo "$d" > "$RUN/bootdir"
  echo "$d"
}

# stage NAME [detail...]: one line per step, appended to the stick at once. This is the first thing to read
# when the box has gone quiet.
stage() {
  local s=$1 line
  shift
  line="$(now) boot=$(cat "$RUN/bootseq" 2>/dev/null || echo 0) $s $*"
  echo "$line" >> "$RUN/stage.log"
  echo "$s" > "$RUN/stage"
  echo "offbox: $line" > /dev/kmsg 2>/dev/null || true
  echo "offbox: $line" > /dev/console 2>/dev/null || true
  # Ubuntu keeps kernel-log lines of this priority off the consoles, so also write to the serial port directly
  # (a serial console server or the VM tests read it there; with no UART this fails at once and is ignored).
  timeout 2 sh -c 'echo "offbox: $1" > /dev/ttyS0' _ "$line" 2>/dev/null || true
  if logvol_mounted; then
    echo "$line" >> "$LOGMNT/stage.log"
    sync -f "$LOGMNT/stage.log" 2>/dev/null || sync
  fi
}

inventory() {
  local d trace=0
  # the files below capture stderr: keep a caller's `set -x` trace out of them
  case $- in *x*) trace=1; set +x ;; esac
  d=$(bootdir)/inventory
  mkdir -p "$d"
  : > "$d/nics.txt"
  {
    lsblk -o NAME,PATH,TYPE,TRAN,SIZE,RM,MODEL,SERIAL,FSTYPE,LABEL,PARTLABEL,MOUNTPOINTS
    echo; lsblk -J -b -O
  } > "$d/lsblk.txt" 2>&1
  blkid > "$d/blkid.txt" 2>&1
  lspci -nnk > "$d/lspci.txt" 2>&1
  lsusb > "$d/lsusb.txt" 2>&1
  { ip -d addr; echo; ip route; echo; ip -6 route; echo; resolvectl status 2>&1; } > "$d/ip.txt" 2>&1
  for n in /sys/class/net/*; do
    n=${n##*/}
    [ "$n" = lo ] && continue
    { echo "== $n"; cat "/sys/class/net/$n/operstate" 2>&1; ethtool "$n" 2>&1; ethtool -i "$n" 2>&1; } >> "$d/nics.txt"
  done
  dmesg > "$d/dmesg.txt" 2>&1
  { uname -a; cat /proc/cmdline; echo; head -30 /proc/cpuinfo; echo; grep -c ^processor /proc/cpuinfo; } > "$d/cpu.txt" 2>&1
  cat /proc/meminfo > "$d/meminfo.txt" 2>&1
  cat /proc/mdstat > "$d/mdstat.txt" 2>&1
  lsmod > "$d/lsmod.txt" 2>&1
  efibootmgr -v > "$d/efibootmgr.txt" 2>&1
  if command -v dmidecode >/dev/null; then dmidecode > "$d/dmidecode.txt" 2>&1; fi
  if command -v nvme >/dev/null; then nvme list > "$d/nvme.txt" 2>&1; fi
  { for f in /sys/class/dmi/id/{sys_vendor,product_name,board_vendor,board_name,board_version,bios_vendor,bios_version,bios_date}; do
      echo "${f##*/}: $(cat "$f" 2>/dev/null)"; done; } > "$d/dmi.txt" 2>&1
  sync
  [ "$trace" = 1 ] && set -x
  return 0
}

# Copy everything useful to the stick. Called every few seconds by the live agent and at every exit path.
sync_logs() {
  local d
  d=$(bootdir)
  cp "$RUN/stage.log" "$d/stage.log" 2>/dev/null
  journalctl -b --no-pager -o short-iso > "$d/journal.txt" 2>/dev/null
  dmesg > "$d/dmesg.txt" 2>/dev/null
  cat /proc/mdstat > "$d/mdstat.txt" 2>/dev/null
  for f in "$RUN"/plan.json "$RUN"/prepare.log "$RUN"/late.log "$RUN"/early.log "$RUN"/live.log /autoinstall.yaml \
           /var/log/cloud-init.log /var/log/cloud-init-output.log \
           /var/log/installer/subiquity-server-debug.log /var/log/installer/subiquity-server-info.log \
           /var/log/installer/curtin-install.log /var/log/installer/installer-journal.txt; do
    [ -e "$f" ] && cp "$f" "$d/" 2>/dev/null
  done
  # The complete installer log tree and any crash reports, as one archive (file names there are not FAT-safe).
  tar -czf "$d/installer-logs.tgz.tmp" -C / var/log/installer var/crash 2>/dev/null &&
    mv -f "$d/installer-logs.tgz.tmp" "$d/installer-logs.tgz"
  sync
}

# hold_then_reboot SECONDS REASON: stay reachable (SSH, tailnet) for a while, then restart and try again.
# `touch /run/offbox/hold` over SSH stops the countdown for as long as the file exists.
hold_then_reboot() {
  local secs=$1 reason=$2 end
  stage hold "seconds=$secs reason=$reason (touch /run/offbox/hold to stay here)"
  end=$(( $(date +%s) + secs ))
  # for the status screen (live-setup.sh): what it is waiting for and until when; and bring that screen up
  printf '%s\n%s\n' "$end" "$reason" > "$RUN/hold-until"
  chvt "$SCREEN_VT" 2>/dev/null || true
  sync_logs
  while [ "$(date +%s)" -lt "$end" ] || [ -e "$RUN/hold" ]; do
    sleep 5
  done
  stage reboot "after hold: $reason"
  sync_logs
  reboot_now
}

# reboot_now: restart the machine at once and for certain. An orderly shutdown of the live session can stop at
# "Please remove the installation medium, then press ENTER" (nobody is there), so it is skipped: the logs are
# on the stick and the stick is unmounted, nothing else in this session needs a clean shutdown.
reboot_now() {
  touch /run/casper-no-prompt 2>/dev/null
  logvol_umount
  sync
  systemctl reboot --force --force 2>/dev/null
  sleep 15
  reboot -f -f 2>/dev/null
  sleep 15
  echo 1 > /proc/sys/kernel/sysrq 2>/dev/null
  echo b > /proc/sysrq-trigger
}
