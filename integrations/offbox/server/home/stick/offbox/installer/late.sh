#!/bin/bash
# late.sh: subiquity late-command. Ubuntu is installed and mounted at /target; this turns it into the offbox
# server: root by key, both ESPs bootable, never-stays-off settings, kernel trial, Tailscale, stick logging.
# A failed critical step exits non-zero, which fails the install and lets error.sh log, wait and retry.
# The "finished install" mark is written last, so an install that lost power before the end is redone.
# shellcheck source=common.sh
. /cdrom/offbox/installer/common.sh
exec >> "$RUN/late.log" 2>&1
set -x
T=/target
PLAN=$RUN/plan.json
SRC=$OFFBOX_SRC/target
PLANPY=$OFFBOX_SRC/installer/plan.py
it() { curtin in-target --target="$T" -- "$@"; }
die() { stage late-fail "$*"; sync_logs; exit 1; }
field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$PLAN" "$1"; }

logvol_mount || true
stage late-start "ubuntu is installed, configuring the offbox server"
{ [ -d "$T/etc" ] && mountpoint -q "$T"; } || die "/target is not mounted"
[ -s "$PLAN" ] || die "no plan.json from early.sh"
MODE=$(field mode)
# VM tests only (fw_cfg, absent on real hardware): fail the first attempt to exercise the error path.
if [ "$(testcfg fail_late_once)" = 1 ] && [ ! -s "$LOGMNT/fail-count" ]; then die "test hook fail_late_once"; fi
mapfile -t DISKS < <(python3 -c 'import json,sys; [print(d["path"]) for d in json.load(open(sys.argv[1]))["disks"]]' "$PLAN")
[ "${#DISKS[@]}" = 2 ] || die "plan.json does not name two disks"

# ---- 0. the Ubuntu installer has just registered the disks with the firmware and put them first in the
# boot order (grub-multi-install always does; nothing in the autoinstall turns it off). The system on them is
# not finished: take the entries away again and keep this stick pinned as the next boot device.
drop_disk_entries "${DISKS[@]}"
pin_stick_next >/dev/null || stage warn "could not pin this stick as the next boot device"
# The same goes for the removable path EFI/BOOT/BOOTX64.EFI it wrote to both ESPs: with neither a boot entry
# nor that path, the firmware has nothing to start on these disks until step 10 puts both back.
mkdir -p "$RUN/esp-tmp"
for d in "${DISKS[@]}"; do
  m=$(findmnt -n -o TARGET --source "${d}p1" | head -1)
  if [ -n "$m" ]; then
    rm -rf "$m/EFI/BOOT"
  elif mount -t vfat "${d}p1" "$RUN/esp-tmp" 2>/dev/null; then
    rm -rf "$RUN/esp-tmp/EFI/BOOT"
    umount "$RUN/esp-tmp"
  fi
done

# ---- 1. our files (FAT keeps no modes: 0644 by default, then the list in target/modes)
( cd "$SRC/rootfs" && find . -type f ) | while IFS= read -r f; do
  f=${f#./}
  install -D -m 0644 "$SRC/rootfs/$f" "$T/$f" || exit 1
done || die "copying target files failed"
grep -v '^#' "$SRC/modes" | while read -r f m; do
  [ -n "$f" ] || continue
  chmod "$m" "$T/$f" || exit 1
done || die "setting file modes failed"
install -d -m 700 "$T/etc/offbox" "$T/var/lib/offbox"

# ---- 2. identity and access
HOSTNAME_T=offbox-server
echo "$HOSTNAME_T" > "$T/etc/hostname"
if grep -q "127.0.1.1" "$T/etc/hosts" 2>/dev/null; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1 $HOSTNAME_T/" "$T/etc/hosts"
else
  echo "127.0.1.1 $HOSTNAME_T" >> "$T/etc/hosts"
fi
install -d -m 700 "$T/root/.ssh"
[ -s "$OFFBOX_SRC/site/authorized_keys" ] || die "no site/authorized_keys on the stick: the server would be unreachable"
install -m 600 "$OFFBOX_SRC/site/authorized_keys" "$T/root/.ssh/authorized_keys" || die "authorized_keys"
# VM tests only: an extra key handed in through QEMU fw_cfg (absent on real hardware).
TESTKEY=$(testcfg ssh_test_key)
if [ -n "$TESTKEY" ]; then echo "$TESTKEY" >> "$T/root/.ssh/authorized_keys"; fi
{ set +x; } 2>/dev/null
if [ -s "$OFFBOX_SRC/site/root-password.hash" ]; then
  it usermod -p "$(tr -d '\r\n' < "$OFFBOX_SRC/site/root-password.hash")" root || die "setting the root console password failed"
else
  it passwd -l root
fi
set -x
ln -sf /usr/share/zoneinfo/Etc/UTC "$T/etc/localtime"
echo Etc/UTC > "$T/etc/timezone"
# An offline install leaves only C.UTF-8. ssh clients (macOS) send LANG/LC_*=en_US.UTF-8; generate it so
# every remote command does not start with a setlocale warning. The system default stays C.UTF-8.
it locale-gen en_US.UTF-8 || true
# cloud-init has nothing left to do on this machine; everything is configured right here.
touch "$T/etc/cloud/cloud-init.disabled"
rm -f "$T/etc/netplan/50-cloud-init.yaml" "$T/etc/netplan/00-installer-config.yaml"
[ -e "$T/etc/ssh/ssh_host_ed25519_key" ] || it ssh-keygen -A
it netplan generate || die "netplan rejects /etc/netplan/01-offbox.yaml"

# ---- 3. boot never waits: /boot and the ESP are nofail
awk '$1 !~ /^#/ && ($2=="/boot" || $2=="/boot/efi") && $4 !~ /nofail/ { $4=$4",nofail,x-systemd.device-timeout=30s" } {print}' \
  "$T/etc/fstab" > "$T/etc/fstab.offbox" && mv -f "$T/etc/fstab.offbox" "$T/etc/fstab"
cat "$T/etc/fstab"

# ---- 4. apt: the real archive (the install itself was offline on purpose)
cat > "$T/etc/apt/sources.list.d/ubuntu.sources" <<'S'
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
S
if [ -s "$T/etc/apt/sources.list" ] && grep -qE '127\.0\.0\.1|cdrom|file:' "$T/etc/apt/sources.list"; then
  echo "# see /etc/apt/sources.list.d/ubuntu.sources" > "$T/etc/apt/sources.list"
fi
rm -f "$T"/etc/apt/apt.conf.d/*curtin-aptproxy "$T"/etc/apt/sources.list.d/*cdrom* 2>/dev/null

# ---- 5. Tailscale: package from the stick, identity from the previous install or a fresh join
if [ -s "$RUN/carry/carry.tar" ]; then
  tar -C "$T" -xpf "$RUN/carry/carry.tar" &&
    stage carry-over "kept from the previous install: $(tar -tf "$RUN/carry/carry.tar" | grep -c .) entries (ssh host keys, tailnet identity, boatd token)"
fi
TSDEB=$(find "$OFFBOX_SRC/pkgs" -maxdepth 1 -name 'tailscale_*_amd64.deb' 2>/dev/null | head -1)
TSKEY=
for f in /cdrom/tailscale-authkey /cdrom/tailscale-authkey.txt "$LOGMNT/tailscale-authkey" "$LOGMNT/tailscale-authkey.txt"; do
  if [ -s "$f" ]; then TSKEY=$f; break; fi
done
if [ -n "$TSDEB" ]; then
  cp "$TSDEB" "$T/var/tmp/tailscale.deb"
  if it dpkg -i /var/tmp/tailscale.deb; then
    it systemctl enable tailscaled
    if [ -s "$OFFBOX_SRC/pkgs/tailscale-archive-keyring.gpg" ]; then
      install -m 644 "$OFFBOX_SRC/pkgs/tailscale-archive-keyring.gpg" "$T/usr/share/keyrings/tailscale-archive-keyring.gpg"
      echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main" \
        > "$T/etc/apt/sources.list.d/tailscale.list"
    fi
    if [ -n "$TSKEY" ]; then
      tr -d '\r\n ' < "$TSKEY" > "$T/etc/offbox/tailscale-authkey"
      chmod 600 "$T/etc/offbox/tailscale-authkey"
    fi
    TSHOST=$(cfgval ts_hostname "$HOSTNAME_T")
    if [ -s "$T/var/lib/tailscale/tailscaled.state" ]; then
      stage tailscale "the tailnet identity of the previous install was kept"
    elif [ -z "$TSKEY" ]; then
      stage tailscale "no tailscale-authkey on the stick: the server will be LAN only"
    elif ! ip -4 route show default | grep -q default; then
      stage tailscale "no network right now: the server joins the tailnet by itself once it has one"
    else
      sock=$RUN/ts-target.sock
      install -d -m 700 "$T/var/lib/tailscale"
      "$T/usr/sbin/tailscaled" --state="$T/var/lib/tailscale/tailscaled.state" --socket="$sock" \
        --tun=userspace-networking --port=0 >> "$RUN/tailscaled-target.log" 2>&1 &
      tspid=$!
      for _ in 1 2 3; do
        sleep 3
        "$T/usr/bin/tailscale" --socket="$sock" up --auth-key="file:$TSKEY" --hostname="$TSHOST" --ssh=false \
          --accept-dns=false --timeout=40s >> "$RUN/tailscale-target-up.log" 2>&1 && break
      done
      if "$T/usr/bin/tailscale" --socket="$sock" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
        stage tailscale "joined the tailnet as $TSHOST, $("$T/usr/bin/tailscale" --socket="$sock" ip -4 | head -1)"
        # the node is authenticated: the installed system does not need the key any more
        rm -f "$T/etc/offbox/tailscale-authkey"
      else
        stage tailscale "join during install failed ($(tail -1 "$RUN/tailscale-target-up.log" | cut -c1-120)); the server retries after boot"
        rm -f "$T/var/lib/tailscale/tailscaled.state"
      fi
      kill "$tspid" 2>/dev/null
      wait "$tspid" 2>/dev/null
    fi
  else
    stage tailscale "installing the tailscale package failed; the server will be LAN only"
  fi
  rm -f "$T/var/tmp/tailscale.deb"
else
  stage tailscale "no tailscale package on the stick"
fi

# ---- 6. partition names and type codes (curtin sets the names but not the types; make sure of both)
# Types: 2+3 = Linux RAID, 4 = ZFS, so no other tool mistakes the pool partition for an empty Linux one.
WANT_TYPES="c12a7328-f81f-11d2-ba4b-00a0c93ec93b a19d880f-05fc-4d3b-a006-743f0f84911e a19d880f-05fc-4d3b-a006-743f0f84911e 6a898cc3-1dd2-11b2-99a6-080020736631"
for d in "${DISKS[@]}"; do
  names=$(lsblk -lno PARTLABEL "$d" | xargs)
  types=$(lsblk -lno PARTTYPE "$d" | tr 'A-Z' 'a-z' | xargs)
  if [ "$names" != "offbox-esp offbox-boot offbox-root offbox-zfs" ] || [ "$types" != "$WANT_TYPES" ]; then
    sgdisk -c 1:offbox-esp -c 2:offbox-boot -c 3:offbox-root -c 4:offbox-zfs -t 1:EF00 -t 2:FD00 -t 3:FD00 -t 4:BF01 "$d" ||
      die "naming the partitions of $d failed"
    partx -u "$d" 2>/dev/null
    udevadm trigger --settle "$d" "${d}p1" "${d}p2" "${d}p3" "${d}p4" 2>/dev/null
  fi
done
lsblk -o NAME,SIZE,TYPE,FSTYPE,PARTLABEL,PARTTYPE,MOUNTPOINTS "${DISKS[@]}"

# ---- 7. boot chain, part 1: initramfs with the watchdog drivers, GRUB files on both ESPs.
# Nothing here makes the disks bootable for the firmware: no boot entry (--no-nvram) and no removable path
# (--no-extra-removable; Ubuntu's grub-install writes that path by default).
# Until the finished-install mark is written, a restart must come back to the stick.
printf 'sp5100_tco\ni6300esb\n' >> "$T/etc/initramfs-tools/modules"
byid() {
  local l
  for l in /dev/disk/by-id/nvme-*; do
    case $l in *nvme-eui.* | *nvme-nvme.* | *_[0-9]-part*) continue ;; esac
    if [ "$(readlink -f "$l")" = "$1" ]; then echo "$l"; return 0; fi
  done
  echo "$1"
}
ESP0=${DISKS[0]}p1
ESP1=${DISKS[1]}p1
printf 'grub-efi-amd64 grub-efi/install_devices multiselect %s, %s\ngrub-efi-amd64 grub2/update_nvram boolean false\ngrub-efi-amd64 grub2/force_efi_extra_removable boolean false\n' \
  "$(byid "$ESP0")" "$(byid "$ESP1")" | it debconf-set-selections || die "debconf for grub failed"
it update-initramfs -u -k all || die "update-initramfs failed"
GRUB_QUIET_ARGS=(--no-nvram)
if it sh -c 'grub-install --help 2>&1 | grep -q -- --no-extra-removable'; then GRUB_QUIET_ARGS+=(--no-extra-removable); fi
it /usr/lib/grub/grub-multi-install "${GRUB_QUIET_ARGS[@]}" || stage warn "grub-multi-install returned an error (the ESP copy below still runs)"
it update-grub || die "update-grub failed"
VER=$(find "$T/boot" -maxdepth 1 -name 'vmlinuz-*' | sed 's/.*vmlinuz-//' | sort -V | tail -1)
[ -n "$VER" ] || die "no kernel in /target/boot"
it /usr/local/sbin/offbox-kernel-trial promote "$VER" || die "could not set $VER as the default kernel"
it /usr/local/sbin/offbox-esp-sync || die "copying the ESP to the second disk failed"

mkdir -p "$RUN/esp1"
mount -t vfat "$ESP1" "$RUN/esp1" || die "second ESP $ESP1 does not mount"
for e in "$T/boot/efi" "$RUN/esp1"; do
  for f in EFI/ubuntu/shimx64.efi EFI/ubuntu/grubx64.efi EFI/ubuntu/grub.cfg EFI/offbox/grubenv; do
    [ -s "$e/$f" ] || die "boot file $f is missing on $e"
  done
done

# ---- 8. services and the never-stays-off settings
it systemctl enable offbox-boot-report.service offbox-tailscale-join.timer offbox-rtcwake.timer \
  offbox-rtcwake-shutdown.service offbox-boot-health.timer offbox-emergency-agent.service offbox-watchdog.service ||
  die "enabling the offbox units failed"
it systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target
# poweroff and halt end in a restart
ln -sf /usr/lib/systemd/system/reboot.target "$T/etc/systemd/system/poweroff.target"
ln -sf /usr/lib/systemd/system/reboot.target "$T/etc/systemd/system/halt.target"
it systemctl enable systemd-timesyncd.service 2>/dev/null

# ---- 9. the "finished install" mark on both ESPs and in the root. From here on the stick's GRUB starts the
# installed system (it loads the ESP's grub.cfg itself) and the installer refuses to install again.
ID="$(now) mode=$MODE media=$(tr -d '\n' < /cdrom/.disk/info) tree=$(tr -d '\n' < "$OFFBOX_SRC/VERSION" 2>/dev/null)"
echo "$ID" > "$T/etc/offbox/installed"
for e in "$T/boot/efi" "$RUN/esp1"; do
  mkdir -p "$e/EFI/offbox"
  echo "$ID" > "$e/EFI/offbox/installed" || die "writing the finished-install mark to $e failed"
done
sync
# The marker file that asked for this install is used up now: record it on the ESPs, delete it from the stick.
python3 "$PLANPY" consume "$PLAN" "$T/boot/efi" "$RUN/esp1"
rc=$?
[ "$rc" = 3 ] && stage warn "a marker file could not be deleted from the stick; it is recorded as used and will be ignored"
umount "$RUN/esp1"
stage marked "finished-install mark written; making the disks bootable for the firmware"
# VM tests only (fw_cfg, absent on real hardware): hold here so a power cut can be placed in this window.
pause=$(cfgval late_pause_after_mark 0)
if [ "$pause" != 0 ]; then sleep "$pause"; fi

# ---- 10. boot chain, part 2, only now: firmware boot entries for both disks, first in the boot order, and
# the removable path EFI/BOOT/BOOTX64.EFI on both ESPs. A power cut before this point leaves disks the
# firmware cannot start, so the stick decides again; a cut inside this step leaves a finished install that the
# stick starts, and the installed system completes this step itself (offbox-esp-sync firmware).
it /usr/local/sbin/offbox-esp-sync firmware || die "making the disks bootable for the firmware failed"
mount -t vfat "$ESP1" "$RUN/esp1" || die "second ESP $ESP1 does not mount"
for e in "$T/boot/efi" "$RUN/esp1"; do
  for f in EFI/ubuntu/shimx64.efi EFI/ubuntu/grubx64.efi EFI/ubuntu/grub.cfg EFI/BOOT/BOOTX64.EFI EFI/offbox/installed; do
    [ -s "$e/$f" ] || die "boot file $f is missing on $e"
  done
done
ours=
for d in "${DISKS[@]}"; do
  pu=$(blkid -o value -s PARTUUID "${d}p1")
  num=$(efibootmgr -v | grep -i "$pu" | grep -i 'shimx64' | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\).*/\1/p' | head -1)
  [ -n "$num" ] && ours="$ours${ours:+,}$num"
done
order=$(efibootmgr | sed -n 's/^BootOrder: //p')
case "$ours" in
  *,*) case "$(echo "$order" | cut -d, -f1,2)" in
         "$ours" | "${ours#*,},${ours%,*}") stage firmware "boot entries for the two disks: $ours, first in the boot order ($order)" ;;
         *) stage warn "boot entries $ours exist but the boot order is $order" ;;
       esac ;;
  *) stage warn "firmware boot entries for both disks could not be created (have: ${ours:-none}); the removable path EFI/BOOT/BOOTX64.EFI is on both disks" ;;
esac
# The install is finished and the disks are bootable: the firmware may follow its boot order again.
unpin_stick_next || stage warn "could not clear BootNext; the next boot goes through the stick's menu once more"
efibootmgr -v

umount "$RUN/esp1"
logvol_mounted && rm -f "$LOGMNT/fail-count"
touch "$RUN/install-done"
stage late-done "install finished ($ID); restarting into the installed system"
inventory
sync_logs
exit 0
