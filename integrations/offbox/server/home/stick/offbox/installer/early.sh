#!/bin/bash
# early.sh: subiquity early-command. Runs before the installer has looked at any disk.
# Decides (plan.py) whether this boot may install at all, prepares the disks, and writes the real storage
# section into /autoinstall.yaml (subiquity re-reads that file when this script returns).
# It only ever returns 0 with a complete plan. Every other outcome is handled here: log to the stick, stay
# reachable for a while, restart.
# shellcheck source=common.sh
. /cdrom/offbox/installer/common.sh
exec >> "$RUN/early.log" 2>&1
set -x

logvol_mount || true
bootdir >/dev/null
stage early-start "subiquity reached early-commands"
inventory

# Manual menu entry "installer session only": stop here, before any disk is looked at, and stay up.
if [ "$(cmdline_arg offbox.mode)" = shell ]; then
  touch "$RUN/hold" "$RUN/holding"
  stage shell "manual entry: nothing is installed, this session stays up (SSH, Alt+F2 shell); restart the machine to leave"
  chvt "$SCREEN_VT" 2>/dev/null || true
  sync_logs
  while :; do sleep 3600; done
fi

PLAN=$RUN/plan.json
if ! python3 "$OFFBOX_SRC/installer/plan.py" decide > "$PLAN.tmp"; then
  stage early-fail "plan.py decide crashed (see early.log)"
  touch "$RUN/holding"
  hold_then_reboot "$(cfgval hold_seconds 1800)" "plan.py decide crashed"
fi
mv -f "$PLAN.tmp" "$PLAN"
field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$PLAN" "$1"; }
ACTION=$(field action)
MODE=$(field mode)
REASON=$(field reason)
stage plan "action=$ACTION mode=${MODE:-none} reason=$REASON"
sync_logs

case $ACTION in
  install) ;;
  refuse)
    # The disks hold an install (or pool data) and nothing on the stick says to replace it. Point the firmware
    # at the internal disks for the next boot and leave.
    touch "$RUN/holding"
    hint=$(field boot_disk_hint)
    hold=$(cfgval hold_seconds 1800)
    if [ -n "$hint" ]; then
      num=$(efibootmgr -v 2>/dev/null | grep -i 'shimx64.efi' | grep -iv 'usb' | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\).*/\1/p' | head -1)
      if [ -z "$num" ]; then
        disk=/dev/$(lsblk -no PKNAME "$hint" | head -1)
        efibootmgr -c -d "$disk" -p 1 -L "ubuntu" -l '\EFI\ubuntu\shimx64.efi' >/dev/null 2>&1 || true
        num=$(efibootmgr -v 2>/dev/null | grep -i 'shimx64.efi' | grep -iv 'usb' | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\).*/\1/p' | head -1)
      fi
      if [ -n "$num" ] && efibootmgr -n "$num" >/dev/null 2>&1; then
        stage refuse "$REASON; next boot goes to the internal disks (Boot$num)"
        hold=$(cfgval refuse_boot_seconds 60)
      else
        stage refuse "$REASON; could not set the next boot entry"
      fi
    else
      stage refuse "$REASON"
    fi
    hold_then_reboot "$hold" "refused: $REASON"
    ;;
  *)
    touch "$RUN/holding"
    stage abort "$REASON"
    hold_then_reboot "$(cfgval hold_seconds 1800)" "aborted: $REASON"
    ;;
esac

# From here on the disks get changed. A power cut at any later point is fine: the next boot decides again.
# First forget the firmware boot entries of the install that is being replaced (REINSTALL-OS keeps the ESP
# partitions, so an old entry would still work), then pin this stick as the next boot device: whatever the
# boot order says, the next power-on comes back here until late.sh has finished the install.
mapfile -t TARGETS < <(python3 -c 'import json,sys; [print(x["path"]) for x in json.load(open(sys.argv[1]))["disks"]]' "$PLAN")
drop_disk_entries "${TARGETS[@]}"
if next=$(pin_stick_next); then
  stage firmware-next "until the install is finished the firmware starts this stick first (BootNext=$next)"
else
  stage warn "could not pin this stick as the next boot device (no BootCurrent or the firmware refused BootNext)"
fi
stage prepare-start "mode=$MODE"
if ! python3 "$OFFBOX_SRC/installer/plan.py" prepare "$PLAN"; then
  stage prepare-fail "disk preparation failed (see prepare.log)"
  touch "$RUN/holding"
  hold_then_reboot "$(cfgval hold_seconds 1800)" "disk preparation failed"
fi
stage prepare-done "mode=$MODE"

cp /autoinstall.yaml "$RUN/autoinstall.before.yaml"
if ! python3 "$OFFBOX_SRC/installer/plan.py" render "$PLAN" /autoinstall.yaml /autoinstall.yaml ||
   grep -q OFFBOX-PLACEHOLDER /autoinstall.yaml; then
  stage render-fail "could not write the storage section into /autoinstall.yaml"
  touch "$RUN/holding"
  hold_then_reboot "$(cfgval hold_seconds 1800)" "render failed"
fi
cp /autoinstall.yaml "$(bootdir)/autoinstall.generated.yaml"
stage early-done "storage section written, handing over to subiquity"
sync_logs
exit 0
