#!/bin/zsh
# write-stick.zsh: write the offbox installer onto the USB stick from this Mac, verify it, eject it.
#
#   write-stick.zsh --tree DIR [--bios FILE] [--no-authkey] [--report FILE] --yes
#   write-stick.zsh --tree DIR --image FILE        same layout and copy steps into a disk image (for the VM test
#                                                  that boots a macOS-made file system); no secrets, no BIOS
#   write-stick.zsh --verify --tree DIR            re-check a stick that is plugged in (no writing)
#
# DIR is the output of build-tree.sh. No sudo, no dd: diskutil partitions the stick (MBR, FAT32 "OFFBOX" 16 GB +
# FAT32 "OFFBOXLOG" 4 GB, rest unused) and the files are copied.
#
# The stick is found by what it is, never by its device number:
#   media name "SanDisk 3.2Gen1", 123009761280 bytes, USB, removable, external, physical, exactly one match.
# That check runs again immediately before the disk is erased. Anything internal, the Samsung "ExternalSSD"
# and /dev/disk4 are refused outright.
set -euo pipefail
setopt null_glob

STICK_MEDIA="SanDisk 3.2Gen1"
STICK_BYTES=123009761280
P1=OFFBOX
P2=OFFBOXLOG
AUTHKEY_SERVICE=offbox-tailscale-authkey
AUTHKEY_ACCOUNT=ardud

TREE= BIOS= IMAGE= REPORT= YES=0 AUTHKEY=1 VERIFY_ONLY=0
while (( $# )); do
  case $1 in
    --tree) TREE=$2; shift 2 ;;
    --bios) BIOS=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    --report) REPORT=$2; shift 2 ;;
    --no-authkey) AUTHKEY=0; shift ;;
    --verify) VERIFY_ONLY=1; shift ;;
    --yes) YES=1; shift ;;
    *) print -u2 "unknown option $1"; exit 2 ;;
  esac
done
[[ -n $TREE && -s $TREE/MANIFEST.boot.sha256 && -s $TREE/MANIFEST.log.sha256 && -d $TREE/boot && -d $TREE/log ]] ||
  { print -u2 "--tree must be the output directory of build-tree.sh"; exit 2; }
[[ -z $BIOS || -s $BIOS ]] || { print -u2 "BIOS file $BIOS not found"; exit 2; }

say() { print -r -- "$@"; [[ -n $REPORT ]] && print -r -- "$@" >> $REPORT; return 0; }
info() { diskutil info -plist $1 2>/dev/null | plutil -extract $2 raw - 2>/dev/null || true; }

# is_stick DEV: 0 only when DEV is the SanDisk stick. Prints why not otherwise.
is_stick() {
  local dev=$1 why=()
  [[ $dev == /dev/disk4 || $dev == /dev/disk4s* ]] && why+=("is /dev/disk4")
  [[ $(info $dev WholeDisk) == true ]] || why+=("not a whole disk")
  [[ $(info $dev MediaName) == $STICK_MEDIA ]] || why+=("media name '$(info $dev MediaName)'")
  [[ $(info $dev TotalSize) == $STICK_BYTES ]] || why+=("size $(info $dev TotalSize)")
  [[ $(info $dev BusProtocol) == USB ]] || why+=("bus '$(info $dev BusProtocol)'")
  [[ $(info $dev RemovableMedia) == true ]] || why+=("not removable")
  [[ $(info $dev Internal) == false ]] || why+=("internal")
  [[ $(info $dev VirtualOrPhysical) == Physical ]] || why+=("not physical")
  [[ $(info $dev MediaName) == *Samsung* || $(info $dev MediaName) == *990* ]] && why+=("Samsung disk")
  if (( ${#why} )); then print -r -- "${(j:, :)why}"; return 1; fi
  return 0
}

find_stick() {
  local found=() d
  for d in $(diskutil list external physical | sed -n 's|^\(/dev/disk[0-9]*\) .*|\1|p'); do
    is_stick $d >/dev/null && found+=($d)
  done
  if (( ${#found} != 1 )); then
    print -u2 "expected exactly one '$STICK_MEDIA' $STICK_BYTES-byte USB stick, found ${#found}: $found"
    diskutil list external physical >&2
    return 1
  fi
  print -r -- $found[1]
}

mount_point() { info $1 MountPoint; }

# copy_tree SRC DST: plain files only, no extended attributes / resource forks (they would become ._ files on FAT)
copy_tree() {
  local src=$1 dst=$2
  (cd $src && find . -type d -print) | while IFS= read -r d; do mkdir -p "$dst/$d"; done
  (cd $src && find . -type f -print) | while IFS= read -r f; do
    cp -X "$src/$f" "$dst/$f"
  done
}

# verify_volume MANIFEST MOUNT ALLOWED...: every manifest file must match; other files are listed.
# ALLOWED are extra paths that are expected (secrets, BIOS). Returns 1 on any mismatch or unexpected file.
verify_volume() {
  local manifest=$1 mnt=$2 bad=0 n=0 line want f got
  shift 2
  local allowed=("$@")
  while IFS= read -r line; do
    want=${line%%  *}
    f=${line#*  }
    n=$((n + 1))
    if [[ ! -f $mnt/$f ]]; then say "  MISSING $f"; bad=$((bad + 1)); continue; fi
    got=$(shasum -a 256 "$mnt/$f" | cut -d' ' -f1)
    if [[ $got != $want ]]; then say "  DIFFERS $f"; bad=$((bad + 1)); fi
  done < $manifest
  local extra=() unexpected=0 rel
  (cd $mnt && find . -type f -print | LC_ALL=C sort) | while IFS= read -r rel; do
    grep -qxF -- "$rel" <(sed 's/^[0-9a-f]*  //' $manifest) && continue
    [[ $rel == ./offbox/MANIFEST.sha256 ]] && continue
    if (( ${allowed[(Ie)$rel]} )); then
      say "  extra (expected): $rel  $(stat -f %z "$mnt/$rel") bytes"
    else
      say "  extra (not in the tested tree): $rel  $(stat -f %z "$mnt/$rel") bytes"
      print -r -- "$rel" >> $TMPDIR/offbox-stick-unexpected.$$
    fi
  done
  if [[ -s $TMPDIR/offbox-stick-unexpected.$$ ]]; then
    unexpected=$(wc -l < $TMPDIR/offbox-stick-unexpected.$$ | tr -d ' ')
    rm -f $TMPDIR/offbox-stick-unexpected.$$
  fi
  say "  $mnt: $((n - bad))/$n manifest files identical, $bad wrong, $unexpected unexpected extra file(s)"
  (( bad == 0 && unexpected == 0 ))
}

clean_mac_litter() { # macOS drops these on any volume it mounts; none of them belong on the stick
  local mnt=$1
  dot_clean -m $mnt 2>/dev/null || true
  rm -rf $mnt/.Spotlight-V100 $mnt/.Trashes $mnt/.TemporaryItems 2>/dev/null || true
  find $mnt -name '._*' -type f -delete 2>/dev/null || true
  find $mnt -name .DS_Store -type f -delete 2>/dev/null || true
  rm -f $mnt/.fseventsd/fseventsd-uuid $mnt/.fseventsd/0* 2>/dev/null || true
}

ALLOWED_BOOT=()
[[ -n $BIOS ]] && ALLOWED_BOOT+=("./${BIOS:t}")
(( AUTHKEY )) && ALLOWED_BOOT+=("./tailscale-authkey")
# The log volume gains files as soon as a server has booted from the stick; nothing extra is expected on a fresh one.
ALLOWED_LOG=()

verify_stick() {
  local dev=$1 ok=0 m1 m2
  diskutil mountDisk $dev >/dev/null
  m1=$(mount_point ${dev}s1); m2=$(mount_point ${dev}s2)
  [[ -d $m1 && -d $m2 ]] || { say "volumes did not mount"; return 1; }
  clean_mac_litter $m1; clean_mac_litter $m2
  say "verifying $m1 against MANIFEST.boot.sha256 ($(shasum -a 256 $TREE/MANIFEST.boot.sha256 | cut -c1-16)...)"
  verify_volume $TREE/MANIFEST.boot.sha256 $m1 $ALLOWED_BOOT || ok=1
  say "verifying $m2 against MANIFEST.log.sha256"
  verify_volume $TREE/MANIFEST.log.sha256 $m2 $ALLOWED_LOG || ok=1
  return $ok
}

# ----------------------------------------------------------------------------------------------------------------
if [[ -n $IMAGE ]]; then
  # Same partition + copy code path, into a raw image file instead of the stick.
  rm -f $IMAGE
  mkfile -n 21g $IMAGE
  DEV=$(hdiutil attach -imagekey diskimage-class=CRawDiskImage -nomount $IMAGE | awk 'NR==1{print $1}')
  [[ $DEV == /dev/disk* && $(info $DEV VirtualOrPhysical) == Virtual ]] || { print -u2 "image did not attach as a virtual disk"; exit 1; }
  trap 'hdiutil detach $DEV >/dev/null 2>&1 || true' EXIT
  AUTHKEY=0; BIOS=; ALLOWED_BOOT=()
else
  DEV=$(find_stick)
fi
say "target: $DEV  ($(info $DEV MediaName), $(info $DEV TotalSize) bytes, $(info $DEV BusProtocol), removable=$(info $DEV RemovableMedia))"
[[ -n $IMAGE ]] || diskutil list $DEV

if (( VERIFY_ONLY )); then
  verify_stick $DEV && say "VERIFY: OK" || { say "VERIFY: FAILED"; exit 1; }
  exit 0
fi

if [[ -z $IMAGE ]]; then
  say "current contents (about to be erased):"
  for v in $(diskutil list $DEV | sed -n 's/.* \(disk[0-9]*s[0-9]*\)$/\1/p'); do
    m=$(mount_point /dev/$v)
    [[ -n $m ]] && { say "  $v at $m:"; ls -A "$m" | sed 's/^/    /' | head -40; }
  done
  (( YES )) || { print -u2 "pass --yes to erase $DEV and write the installer"; exit 3; }
  # Identity check again, right before the erase.
  why=$(is_stick $DEV) || { print -u2 "REFUSING: $DEV is not the stick any more ($why)"; exit 1; }
  [[ $(find_stick) == $DEV ]] || { print -u2 "REFUSING: stick moved"; exit 1; }
fi

say "partitioning $DEV: MBR, FAT32 $P1 16 GB, FAT32 $P2 4 GB, rest unused"
diskutil partitionDisk $DEV MBR "MS-DOS FAT32" $P1 16G "MS-DOS FAT32" $P2 4G "Free Space" UNUSED R >/dev/null
M1=$(mount_point ${DEV}s1); M2=$(mount_point ${DEV}s2)
[[ -d $M1 && -d $M2 && $(info ${DEV}s1 VolumeName) == $P1 && $(info ${DEV}s2 VolumeName) == $P2 ]] ||
  { print -u2 "partitions did not come up as expected"; exit 1; }
# belt and braces: the mount points must sit on the device we just checked
[[ $(info $M1 ParentWholeDisk) == ${DEV:t} && $(info $M2 ParentWholeDisk) == ${DEV:t} ]] || { print -u2 "mount points are not on $DEV"; exit 1; }

say "copying $(wc -l < $TREE/MANIFEST.boot.sha256 | tr -d ' ') files to $M1 ..."
copy_tree $TREE/boot $M1
copy_tree $TREE/log $M2
if [[ -n $BIOS ]]; then
  cp -X $BIOS $M1/${BIOS:t}
  say "BIOS file: ${BIOS:t} ($(stat -f %z $BIOS) bytes, sha256 $(shasum -a 256 $BIOS | cut -c1-16)...)"
fi
if (( AUTHKEY )); then
  if security find-generic-password -s $AUTHKEY_SERVICE -a $AUTHKEY_ACCOUNT >/dev/null 2>&1; then
    security find-generic-password -s $AUTHKEY_SERVICE -a $AUTHKEY_ACCOUNT -w | tr -d '\r\n ' > $M1/tailscale-authkey
    [[ -s $M1/tailscale-authkey ]] || { print -u2 "auth key came out empty"; exit 1; }
    say "tailscale-authkey: written from Keychain ($AUTHKEY_SERVICE/$AUTHKEY_ACCOUNT), $(stat -f %z $M1/tailscale-authkey) bytes (value not shown)"
  else
    say "tailscale-authkey: NOT written (no Keychain item $AUTHKEY_SERVICE/$AUTHKEY_ACCOUNT): the server will be LAN only"
    ALLOWED_BOOT=(${ALLOWED_BOOT:#./tailscale-authkey})
  fi
fi
sync
clean_mac_litter $M1; clean_mac_litter $M2
sync

# Read everything back from the device, not from the cache: unmount, mount, hash.
diskutil unmountDisk $DEV >/dev/null
RESULT=0
verify_stick $DEV || RESULT=1
if (( AUTHKEY )) && [[ -f $(mount_point ${DEV}s1)/tailscale-authkey ]]; then
  [[ $(shasum -a 256 $(mount_point ${DEV}s1)/tailscale-authkey | cut -d' ' -f1) == \
     $(security find-generic-password -s $AUTHKEY_SERVICE -a $AUTHKEY_ACCOUNT -w | tr -d '\r\n ' | shasum -a 256 | cut -d' ' -f1) ]] &&
    say "  tailscale-authkey on the stick matches the Keychain value" || { say "  tailscale-authkey on the stick DIFFERS from Keychain"; RESULT=1; }
fi
if [[ -n $BIOS ]]; then
  [[ $(shasum -a 256 $(mount_point ${DEV}s1)/${BIOS:t} | cut -d' ' -f1) == $(shasum -a 256 $BIOS | cut -d' ' -f1) ]] &&
    say "  ${BIOS:t} on the stick matches the source file" || { say "  ${BIOS:t} on the stick DIFFERS"; RESULT=1; }
fi
diskutil unmountDisk $DEV >/dev/null
for s in 1 2; do
  if diskutil verifyVolume ${DEV}s$s >/dev/null 2>&1; then say "  file system check ${DEV}s$s: clean"; else say "  file system check ${DEV}s$s: PROBLEM"; RESULT=1; fi
done
say "layout:"
diskutil list $DEV | sed 's/^/  /' | while IFS= read -r l; do say "$l"; done
if [[ -n $IMAGE ]]; then
  diskutil unmountDisk $DEV >/dev/null 2>&1 || true
  hdiutil detach $DEV >/dev/null
  trap - EXIT
  say "image written: $IMAGE"
else
  diskutil mountDisk $DEV >/dev/null && diskutil unmountDisk $DEV >/dev/null   # proves it mounts cleanly once more
  diskutil eject $DEV >/dev/null && say "ejected: $DEV" || { say "eject FAILED"; RESULT=1; }
fi
(( RESULT == 0 )) && say "RESULT: OK" || say "RESULT: FAILED"
exit $RESULT
