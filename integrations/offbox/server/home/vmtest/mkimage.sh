#!/bin/bash
# mkimage.sh TREE_OUT IMAGE: turn build-tree.sh's output into a raw disk image shaped like the real stick:
# MBR, partition 1 FAT32 "OFFBOX" (16 GiB) with OUT/boot, partition 2 FAT32 "OFFBOXLOG" (4 GiB) with OUT/log.
# Needs sfdisk, dosfstools and mtools; no root.
set -euo pipefail
TREE=$1
IMG=$2
P1_MIB=16384
P2_MIB=4096
rm -f "$IMG"
truncate -s $(( (1 + P1_MIB + P2_MIB + 1) * 1024 * 1024 )) "$IMG"
sfdisk --quiet "$IMG" <<EOF
label: dos
label-id: 0x0ffb0c5e
unit: sectors
start=2048, size=$(( P1_MIB * 2048 )), type=c, bootable
start=$(( 2048 + P1_MIB * 2048 )), size=$(( P2_MIB * 2048 )), type=c
EOF
O1=$(( 2048 * 512 ))
O2=$(( (2048 + P1_MIB * 2048) * 512 ))
mkfs.vfat -F 32 -n OFFBOX --offset 2048 "$IMG" $(( P1_MIB * 1024 )) >/dev/null
mkfs.vfat -F 32 -n OFFBOXLOG --offset $(( 2048 + P1_MIB * 2048 )) "$IMG" $(( P2_MIB * 1024 )) >/dev/null
export MTOOLS_SKIP_CHECK=1
# shellcheck disable=SC2046
mcopy -i "$IMG@@$O1" -s -Q -b $(find "$TREE/boot" -mindepth 1 -maxdepth 1) ::
# shellcheck disable=SC2046
mcopy -i "$IMG@@$O2" -s -Q -b $(find "$TREE/log" -mindepth 1 -maxdepth 1) ::
echo "image: $IMG ($(du -h "$IMG" | cut -f1) used)"
