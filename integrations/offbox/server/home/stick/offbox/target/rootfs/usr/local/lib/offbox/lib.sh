#!/bin/bash
# Shared helpers for the offbox-* scripts on the installed server. Sourced.
STATE=/var/lib/offbox
RUN=/run/offbox
mkdir -p "$STATE" "$RUN" 2>/dev/null || true

# Test knobs: QEMU fw_cfg entries opt/offbox/<name>. Absent on real hardware, so the defaults apply there.
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

say() {
  echo "$*"
  echo "offbox: $*" > /dev/kmsg 2>/dev/null || true
  # also straight to the serial port (kernel-log lines of this priority are kept off the consoles)
  timeout 2 sh -c 'echo "offbox: $1" > /dev/ttyS0' _ "$*" 2>/dev/null || true
}

# screen TEXT: one line on the visible console (the HDMI output a network KVM shows), next to say's log line.
# Only for the few states a person looking at the screen must see. Never put anything secret through it.
screen() {
  timeout 2 sh -c 'printf "\r\noffbox: %s\r\n" "$1" > /dev/tty0' _ "$*" 2>/dev/null || true
}

booted_kernel() {
  local a
  for a in $(cat /proc/cmdline); do
    case $a in BOOT_IMAGE=*) a=${a##*/}; echo "${a#vmlinuz-}"; return 0 ;; esac
  done
  uname -r
}

# ESP partitions of the two system disks (GPT name offbox-esp), one device per line.
# Falls back to "EFI system partitions on NVMe disks" if the names are missing.
esp_parts() {
  local out
  out=$(lsblk -lnpo NAME,PARTLABEL 2>/dev/null | awk '$2=="offbox-esp"{print $1}')
  if [ -z "$out" ]; then
    out=$(lsblk -lnpo NAME,PARTTYPE 2>/dev/null | awk 'tolower($2)=="c12a7328-f81f-11d2-ba4b-00a0c93ec93b" && $1 ~ /nvme/{print $1}')
  fi
  if [ -n "$out" ]; then echo "$out"; fi
}

# with_esp DEV CMD...: run CMD with the ESP's mount point appended. Mounts and unmounts it when needed.
with_esp() {
  local dev=$1 mnt rc own=0
  shift
  mnt=$(findmnt -n -o TARGET --source "$dev" 2>/dev/null | head -1)
  if [ -z "$mnt" ]; then
    mnt=$RUN/esp-${dev##*/}
    mkdir -p "$mnt"
    mount -t vfat -o rw,umask=077,tz=UTC "$dev" "$mnt" 2>/dev/null || return 1
    own=1
  fi
  "$@" "$mnt"
  rc=$?
  if [ "$own" = 1 ]; then umount "$mnt" 2>/dev/null; fi
  return $rc
}

# The installer stick, if it is still plugged in: prints "<boot-partition> <log-partition>" (either may be -).
stick_parts() {
  local p mnt=$RUN/stick-probe boot=- logp=-
  mkdir -p "$mnt"
  for p in $(lsblk -lnpo NAME,FSTYPE,PARTLABEL 2>/dev/null | awk '$2=="vfat" && $3!="offbox-esp"{print $1}'); do
    mount -t vfat -o ro "$p" "$mnt" 2>/dev/null || continue
    [ -e "$mnt/OFFBOX-LOG-VOLUME" ] && logp=$p
    [ -e "$mnt/offbox/installer/plan.py" ] && boot=$p
    umount "$mnt" 2>/dev/null
  done
  echo "$boot $logp"
}
