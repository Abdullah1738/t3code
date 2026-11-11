#!/bin/bash
# build-tree.sh: assemble the exact file tree of the installer stick, plus a sha256 manifest of it.
#
#   build-tree.sh --cache DIR --site DIR --out DIR
#
#   --cache  downloads live here (Ubuntu ISO, Tailscale package); fetched if missing, sha256-checked always
#   --site   per-server inputs that are not in git:  authorized_keys  (SSH public key for root)
#                                                    root-password.hash  (crypt(3) hash of the console password)
#   --out    result:  OUT/boot/  -> stick partition 1 (OFFBOX)      OUT/MANIFEST.boot.sha256
#                     OUT/log/   -> stick partition 2 (OFFBOXLOG)   OUT/MANIFEST.log.sha256
#
# Runs unchanged on Linux (the VM test box) and on macOS (the Mac that writes the stick). Both must produce the
# same manifests: that is how "the stick holds the bytes that passed the tests" is checked.
# Not in the tree, added only when the real stick is written: tailscale-authkey (secret) and the BIOS file.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE='' SITE='' OUT=''
while [ $# -gt 0 ]; do
  case $1 in
    --cache) CACHE=$2; shift 2 ;;
    --site) SITE=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    *) echo "usage: build-tree.sh --cache DIR --site DIR --out DIR" >&2; exit 2 ;;
  esac
done
if [ -z "$CACHE" ] || [ -z "$SITE" ] || [ -z "$OUT" ]; then
  echo "usage: build-tree.sh --cache DIR --site DIR --out DIR" >&2
  exit 2
fi
# shellcheck source=versions.env
. "$HERE/versions.env"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() { # fetch URL FILE SHA256
  if [ ! -s "$2" ]; then
    echo "downloading $1"
    curl -fL --retry 3 -o "$2.part" "$1"
    mv "$2.part" "$2"
  fi
  local got
  got=$(sha "$2")
  if [ "$got" != "$3" ]; then
    echo "sha256 mismatch for $2: got $got, want $3" >&2
    exit 1
  fi
}
manifest() { # manifest DIR: "sha256  ./path" lines, byte-sorted, the same on Linux and macOS
  (cd "$1" && find . -type f ! -name MANIFEST.sha256 -print | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s  %s\n' "$(sha "$f")" "$f"
  done)
}

for f in authorized_keys root-password.hash; do
  [ -s "$SITE/$f" ] || { echo "missing $SITE/$f" >&2; exit 1; }
done
mkdir -p "$CACHE"
fetch "$ISO_URL" "$CACHE/$ISO_NAME" "$ISO_SHA256"
fetch "$TAILSCALE_DEB_URL" "$CACHE/$TAILSCALE_DEB" "$TAILSCALE_DEB_SHA256"
fetch "$TAILSCALE_KEYRING_URL" "$CACHE/tailscale-archive-keyring.gpg" "$TAILSCALE_KEYRING_SHA256"

case $OUT in /* ) ;; *) OUT=$PWD/$OUT ;; esac
[ -n "$OUT" ] && [ "$OUT" != / ] || exit 2
if [ -d "$OUT" ]; then chmod -R u+w "$OUT" 2>/dev/null || true; fi
rm -rf "$OUT"
mkdir -p "$OUT/boot" "$OUT/log"

# 1. the Ubuntu ISO's files. FAT32 has no symlinks; the ISO's three (ubuntu -> ., dists/stable, dists/unstable)
#    are not needed by the installer.
echo "extracting $ISO_NAME"
bsdtar -xf "$CACHE/$ISO_NAME" -C "$OUT/boot"
chmod -R u+w "$OUT/boot"
find "$OUT/boot" -type l -exec rm -f {} +
rm -rf "$OUT/boot/[BOOT]"
[ -s "$OUT/boot/casper/hwe-vmlinuz" ] && [ -s "$OUT/boot/EFI/boot/bootx64.efi" ] && [ -s "$OUT/boot/.disk/info" ] ||
  { echo "the ISO did not extract as expected" >&2; exit 1; }
if [ -n "$(find "$OUT/boot" -type f -size +4294967295c | head -1)" ]; then
  echo "a file is too large for FAT32" >&2
  exit 1
fi

# 2. our files on top (this replaces boot/grub/grub.cfg)
(cd "$HERE/stick" && find . -type f ! -name .DS_Store ! -name '._*' ! -name '*.pyc' ! -path '*/__pycache__/*' -print) | while IFS= read -r f; do
  mkdir -p "$OUT/boot/$(dirname "$f")"
  cp "$HERE/stick/$f" "$OUT/boot/$f"
done
(cd "$HERE/logvol" && find . -type f ! -name .DS_Store ! -name '._*' ! -name '*.pyc' ! -path '*/__pycache__/*' -print) | while IFS= read -r f; do
  mkdir -p "$OUT/log/$(dirname "$f")"
  cp "$HERE/logvol/$f" "$OUT/log/$f"
done

# 3. per-server inputs and packages
mkdir -p "$OUT/boot/offbox/site" "$OUT/boot/offbox/pkgs"
cp "$SITE/authorized_keys" "$SITE/root-password.hash" "$OUT/boot/offbox/site/"
cp "$CACHE/$TAILSCALE_DEB" "$CACHE/tailscale-archive-keyring.gpg" "$OUT/boot/offbox/pkgs/"

# 4. version = hash over everything we added (not the ISO), so it is the same wherever it is built
find "$OUT" -name .DS_Store -exec rm -f {} +
{
  echo "$ISO_NAME $ISO_SHA256"
  (cd "$OUT/boot" && find ./boot/grub/grub.cfg ./nocloud ./offbox -type f ! -name VERSION -print | LC_ALL=C sort |
    while IFS= read -r f; do printf '%s  %s\n' "$(sha "$f")" "$f"; done)
} > "$OUT/version-input.txt"
printf '%s %s\n' "$(sha "$OUT/version-input.txt" | cut -c1-16)" "$ISO_NAME" > "$OUT/boot/offbox/VERSION"
rm -f "$OUT/version-input.txt"

# 5. manifests (also kept on the stick itself)
manifest "$OUT/boot" > "$OUT/MANIFEST.boot.sha256"
manifest "$OUT/log" > "$OUT/MANIFEST.log.sha256"
cp "$OUT/MANIFEST.boot.sha256" "$OUT/boot/offbox/MANIFEST.sha256"
echo "tree: $OUT"
echo "version: $(cat "$OUT/boot/offbox/VERSION")"
echo "files: boot=$(wc -l < "$OUT/MANIFEST.boot.sha256" | tr -d ' ') log=$(wc -l < "$OUT/MANIFEST.log.sha256" | tr -d ' ')"
echo "manifest sha256: boot=$(sha "$OUT/MANIFEST.boot.sha256") log=$(sha "$OUT/MANIFEST.log.sha256")"
