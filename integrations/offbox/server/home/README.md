# Home server: the headless installer stick

The home offbox server (ASUS Prime B850M-A WiFi, Ryzen 9 9950X3D, 192 GB, 2x 2 TB NVMe) has no monitor and
nobody sitting at it. This directory builds the USB stick that installs it with zero touch, the tests that
prove it, and the Mac-side scripts for the day it arrives. It replaces the `os` and `ts` steps of
`../bootstrap.zsh`.

A network KVM (GL.iNet Comet with its ATX board) is attached at install time: HDMI and a USB keyboard/mouse
(and a virtual USB drive) on the rear ports, power and reset on the front-panel header. The install does not
need it: the zero-touch path is unchanged and finishes alone if the KVM is dead or unplugged. What the KVM
adds is eyes and hands: everything useful is also on the HDMI console, the BIOS is reachable, and a few
manual menu entries exist. See "With the KVM" below.

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

The menu is shown on the screen for those 5 seconds. A key press stops the countdown (that is how a manual
entry is picked); nothing else on the stick ever waits for a key. Manual entries, never chosen automatically:
"boot the installed system from the internal disks", "installer session only, installs nothing (shell + SSH)",
"Boot from next volume", "UEFI Firmware Settings".

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

## With the KVM

**What is on the screen.** The stick's menu; the kernel and boot messages of the installer and of the
installed system (no `quiet`, no `splash`, `console=tty0` last on the command line); during an install a
status page on its own console (Alt+F8, made the visible one): stage lines, addresses, and when it waits, the
reason and the countdown. Alt+F1 is Ubuntu's own installer screen, Alt+F2 a shell. On the installed system:
a login prompt on tty1 with the server's addresses above it (root + the console password from Keychain
`offbox-server-console`); in emergency mode the state, the SSH address and the restart countdown.
Nothing secret is printed there: no auth key, no password hash, no shell traces.

**Other USB devices.** The KVM's keyboard, mouse and virtual drive do not confuse anything: the stick's
volumes are found by what is on them, never by device name, other FAT volumes are only looked at read-only,
marker files count only on the stick's own two volumes, and install targets are NVMe disks only. Do not
attach the stick and a virtual-media copy of it at the same time: two identical boot volumes are ambiguous.

**BIOS settings through the KVM, before the first install.** `Delete` or `F2` during POST enters setup, `F7`
switches between EZ Mode and Advanced Mode, `F8` at the ASUS logo is the boot menu. Names are from ASUS's
"PRIME / ProArt / TUF GAMING AMD 800 Series BIOS Manual" (E25269, the BIOS manual on this board's support
page); it is series-wide, states no factory defaults, and says options vary with BIOS version and CPU, so
anything marked (unconfirmed) is to be checked against the screen.

| Where | Setting | Set to | Why |
|---|---|---|---|
| Advanced > APM Configuration | Restore AC Power Loss | Power On | after a power cut the machine must start by itself; only the BIOS can decide this |
| Advanced > APM Configuration | ErP Ready | Disabled | "Enabled" switches off the wake sources, RTC wake included |
| Advanced > APM Configuration | Power On By RTC | leave Disabled | Linux arms the RTC alarm itself; the BIOS option would override it with a fixed date (unconfirmed: whether Disabled blocks the OS alarm on this board; `acceptance.sh --test-rtc-wake` decides) |
| Boot > Boot Configuration | Wait For 'F1' If Error | Disabled | a fan or new-CPU warning must not hold the boot |
| Boot > Boot Configuration | Fast Boot | Disabled | full USB initialisation on every boot (stick, KVM keyboard) |
| Boot > CSM (Compatibility Support Module) | Launch CSM | Disabled | UEFI only. The manual says it is forced to Disabled on integrated graphics, which is this machine's case |
| Boot > Secure Boot | OS Type | either | "Other OS" = Secure Boot off, "Windows UEFI Mode" = on (ASUS FAQ 1049829; the default on this board is unconfirmed). Both states are tested: cases `c1`… with it off, `sb` with it enforced |
| Ai Tweaker | Ai Overclock Tuner | Auto | no EXPO/DOCP profile for the first boot with 4 DIMMs; raise it later, after `acceptance.sh --memory-full` |
| Ai Tweaker > DRAM Timing Control | Memory Context Restore | Auto for the first boot | the first boot trains memory for 5-15 min (black screen or logo, Q-LED DRAM); Enabled later shortens every boot |
| Boot | Boot Option Priorities | after the install: the two "Ubuntu" entries (one per NVMe disk) first | the installer does this itself; check it. The stick may stay anywhere in the list: with a finished install it only starts the disks |
| Advanced > AMD fTPM configuration | Firmware TPM switch / Erase fTPM NV for factory reset | leave | see the prompt below |

The fTPM prompt: ASUS says it appears "when you install with a new CPU for the first time or replace with
another CPU" (FAQ 1051544): "New CPU installed, fTPM/PSP NV corrupted or fTPM/PSP NV structure changed.
Press Y to reset fTPM … Press N to keep previous fTPM record and continue system boot …" (wording from a user
post on ASUS's forum; the FAQ shows it only as a picture). Nothing on this server uses the TPM (no disk
encryption): answer **Y**. It is the one prompt that can stop a first boot, and it needs the KVM keyboard.

**Virtual media instead of the stick (fallback, untested on the Comet).** The Comet can present a disk image
as a USB drive. A stick image made by the same Mac code path as the real stick (`write-stick.zsh --image`,
booted in the VM as case `macstick`) is kept at
`~/.robob/scratch/2026-11-06-our-boat-dev-spend-is-42883890/usb-installer/virtual-media/offbox-stick.img`
(22.5 GB sparse; no Tailscale key and no BIOS file in it, so an install from it is LAN-only until
`tailscale up` is run by hand). Mount it in the Comet as a **disk** (not CD), read-write if the Comet allows.
Mounted read-only the install still works, but: no logs or stage lines are written back to the image (they
stay in the installer's RAM: read them over SSH or on the status page while it runs), the installed system
cannot add its boot reports, and a marker file cannot be deleted after use (it is remembered on the disks
instead, so there is still no reinstall loop). Remove the physical stick first.

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

1. KVM screen open; BIOS settings from the table above (first power-on: enter setup with `Delete`).
2. `OFFBOX_KVM_URL=https://<kvm> ./watch-install.zsh` on the Mac. It ends with the next two commands when the
   installed server answers on the tailnet.
3. `ssh root@<ip> 'bash -s' < acceptance.sh`, then the steps it lists under "steps to drive with the KVM"
   (`acceptance.sh --kvm-steps` prints only those), and Abdullah pulls the power cable once (the one thing
   neither Linux nor the KVM can do: real loss of mains power).
4. `../bootstrap.zsh <tailnet-ip> home`.
5. Nothing visible: the KVM screen first; then `watch-install.zsh` prints the order of checks; the stick,
   plugged back into the Mac, tells the rest (`./read-stick-log.zsh`).

## Test hooks

The installer and the installed system read a few settings from QEMU's fw_cfg (`opt/offbox/<name>`: shorter
hold times, an extra SSH key, a test tailnet name). The files do not exist on real hardware, so the defaults in
the scripts are what the real box runs.
