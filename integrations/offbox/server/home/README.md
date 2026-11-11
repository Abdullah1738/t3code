# Home server: the headless installer stick

The home offbox server (ASUS Prime B850M-A WiFi, Ryzen 9 9950X3D, 192 GB, 2x 2 TB NVMe) has no screen and no
keyboard. This directory builds the USB stick that installs it with zero touch, the tests that prove it, and
the Mac-side scripts for the day it arrives. It replaces the `os` and `ts` steps of `../bootstrap.zsh`.

    stick in, power on  ->  Ubuntu Server 24.04 (HWE) on both NVMe  ->  `offbox-server` on the tailnet
    then, from the Mac:     ../bootstrap.zsh <tailnet-ip> home      (ZFS pool, Incus, boatd, client config)

## What is where

| Path | What |
|---|---|
| `stick/` | Our files for the stick's boot volume (`OFFBOX`): GRUB config, NoCloud autoinstall, installer scripts, everything copied onto the installed system (`offbox/target/rootfs`) |
| `logvol/` | Initial content of the stick's log volume (`OFFBOXLOG`) |
| `versions.env` | Pinned Ubuntu ISO and Tailscale package (URL + sha256) |
| `build-tree.sh` | Assembles the exact stick file tree + sha256 manifests. Same result on Linux and macOS |
| `write-stick.zsh` | Mac: finds the stick by what it is, partitions it (no sudo, no dd), copies, verifies against the manifests, ejects |
| `watch-install.zsh` | Mac: which stage is the box in, and what to do when it stays silent |
| `read-stick-log.zsh` | Mac: summary of what a re-plugged stick recorded |
| `acceptance.sh` | Day-one checks on the real hardware for everything a VM cannot prove |
| `static-check.sh` | Verification layer A: shellcheck, YAML, cloud-init schema, the ISO's own subiquity + curtin validators, unit tests |
| `FAILURE-MODES.md` | Verification layer B: every failure, how it shows up headless, what happens by itself, what to do |
| `vmtest/` | Verification layer C: end-to-end tests in a VM shaped like the box (`vmtest/README.md`) |

Not in git, supplied when the tree is built (`--site DIR`): `authorized_keys` (public key for root) and
`root-password.hash` (crypt hash of the emergency console password; the clear value is only in the macOS
Keychain, service `offbox-server-console`, account `root`). Added only when the real stick is written: the
Tailscale auth key (`tailscale-authkey`, from Keychain service `offbox-tailscale-authkey`) and the BIOS file.

## The stick

MBR, two FAT32 volumes, the rest unused:

- `OFFBOX` (16 GB): the files of the Ubuntu live-server ISO plus ours. UEFI boots `EFI/boot/bootx64.efi`
  (Ubuntu's signed shim) straight from FAT32. The installer never writes here, except to delete a marker file.
  It is exactly the tree `build-tree.sh` produced and the VM tests booted; `offbox/MANIFEST.sha256` lists it.
- `OFFBOXLOG` (4 GB): the only volume written to during an install. `stage.log` (one line per step),
  `logs/NNNN-<utc>/` per installer boot (journal, subiquity/curtin logs, plan, hardware inventory),
  `installed/` (reports of the installed system while the stick is in). Marker files go here (or on `OFFBOX`).

Both volumes mount on macOS, so the stick is also the "black box" when nothing else can be seen.

### What a boot from the stick does

The stick's GRUB decides by itself after 5 seconds:

| Internal disks | Marker file on the stick | Result |
|---|---|---|
| blank, or an install that never finished | none | full install |
| a finished install | none | the stick's GRUB loads the installed system's boot menu from the disks. Nothing is installed |
| pool data but no finished-install mark | none | installer refuses, stays reachable, tries again every 30 min |
| our layout | `REINSTALL-OS` | ESP, `/boot` and `/` are rebuilt; the two `offbox-zfs` partitions are not written to |
| anything | `WIPE-EVERYTHING` | full install over everything, pool included |

The installer repeats the decision itself before touching a disk (`offbox/installer/plan.py`), so a wrong
turn in GRUB cannot wipe a finished install. The marker file is deleted after it was acted on and remembered
on the disks, so a marker that cannot be deleted (stick gone read-only) does not cause a reinstall loop.

To reinstall later without anyone at the box, with the stick left in:

    ssh root@offbox-server 'p=$(lsblk -lnpo NAME,LABEL | awk "\$2==\"OFFBOXLOG\"{print \$1}"); mount $p /mnt && touch /mnt/REINSTALL-OS && umount /mnt && reboot'

The installed system finds the marker on its next boot, points the firmware at the stick and restarts.

### What the install produces

- Identical GPT on both NVMe: `offbox-esp` 1 GiB, `offbox-boot` 2 GiB (mdraid1, ext4, `/boot`), `offbox-root`
  150 GiB (mdraid1, ext4, `/`), `offbox-zfs` rest (for the pool `offbox`, created later by
  `install-host.sh`). No swap. Targets are "the two NVMe disks of equal size", never the stick; anything else
  aborts with the reason on the stick and over SSH.
- GRUB + shim on both ESPs (plus the removable path `EFI/BOOT/BOOTX64.EFI`), a firmware entry per disk,
  `offbox-esp-sync` keeps the second ESP equal after updates and restores lost entries. Either disk alone boots.
  The `/boot` array uses RAID metadata 1.0 (superblock at the end), so the stick's GRUB, which has no
  mdraid support, can read it as a plain ext4 partition.
- The disks only become bootable for the firmware as the installer's last step, after the finished-install
  mark. Until then the stick is pinned as the next boot device (`BootNext`) and the boot entries Ubuntu's
  installer registers on its own are removed again: a power cut mid-install comes back to the stick.
- Hostname `offbox-server`, root by SSH key only, sshd on every interface, emergency console password, UTC.
- Tailscale installed from the stick and joined during the install as `offbox-server`
  (`--ssh=false --accept-dns=false`); the installer session itself joins as `offbox-installer`.
  No key on the stick = LAN only (`offbox-installer.local` / `offbox-server.local`, DHCP host names).
- Never stays off: `poweroff`, `halt`, `shutdown -h` and the power button restart; sleep is masked; an RTC
  alarm is kept armed (15 min ahead while running, 3 min ahead at every shutdown); the chipset watchdog is driven by
  systemd (60 s); panic and oops restart after 10 s; `/boot` and the ESP are `nofail`; degraded arrays boot;
  emergency mode brings up network + sshd and restarts by itself; a new kernel is tried once and only becomes
  the default after `offbox-boot-health` passed (4 min after boot); security updates install by themselves
  and never restart the machine.
- `offbox-status` prints the state of all of that in a dozen lines.

## Building and writing the stick

    # 1. tree (Linux box or Mac; downloads the pinned ISO + Tailscale package into --cache)
    ./build-tree.sh --cache ~/ohv/cache --site ~/.local/share/offbox/home-server/site --out ~/ohv/tree-out
    # 2. tests on that tree (Linux with KVM; see vmtest/README.md)
    ./static-check.sh && python3 vmtest/run.py all
    # 3. the same tree on the Mac (identical manifest sha256 = identical bytes), then the stick
    ./write-stick.zsh --tree <tree> --bios <A5677.CAP> --yes

`write-stick.zsh` identifies the stick by media name, exact size, USB, removable, external and physical, and
checks again immediately before erasing; `/dev/disk4`, the Samsung SSD and internal disks are refused. After
copying it re-mounts the stick, compares every file with the manifests, names every file that is not in the
tested tree (expected: `tailscale-authkey` and the BIOS file, nothing else), checks both file systems and
ejects.

## On the day

1. `./watch-install.zsh` on the Mac while the box is powered on for the first time. It ends with the next two
   commands when the installed server answers on the tailnet.
2. `ssh root@<ip> 'bash -s' < acceptance.sh`, then once each `--test-watchdog`, `--test-rtc-wake`, and pull
   the power cable (the one thing only the BIOS decides: "Restore AC Power Loss").
3. `../bootstrap.zsh <tailnet-ip> home`.
4. Nothing visible after 90 minutes: `watch-install.zsh` prints the order of checks; the stick, plugged back
   into the Mac, tells the rest (`./read-stick-log.zsh`).

## Test hooks

The installer and the installed system read a few settings from QEMU's fw_cfg (`opt/offbox/<name>`: shorter
hold times, an extra SSH key, a test tailnet name). The files do not exist on real hardware, so the defaults in
the scripts are what the real box runs.
