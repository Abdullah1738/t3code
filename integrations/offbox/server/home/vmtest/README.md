# VM tests of the installer stick

End-to-end tests in a VM shaped like the home server: UEFI (OVMF), two 2 TB NVMe disks, the exact stick file
tree as a USB drive, one wired NIC with DHCP, no display, a watchdog device. Everything is driven the way the
real box will be: power on, wait, look over SSH and at the serial console, pull the plug.

## Run

On a Linux machine with `/dev/kvm` (the offbox test box; never on the Mac):

    sudo apt-get install -y qemu-system-x86 ovmf mtools dosfstools fdisk libarchive-tools squashfs-tools \
        shellcheck yamllint cloud-init netplan.io grub-common zsh
    mkdir -p ~/ohv/site        # authorized_keys + root-password.hash (the real ones: the tested tree is the stick tree)
    python3 run.py build       # build-tree.sh + mkimage.sh -> ~/ohv/tree-out, ~/ohv/stick-base.img
    ../static-check.sh         # layer A
    python3 run.py all         # c1 golden-pool c2 ... c11 sb err acc kvm-empty kvm-fat   (about 3.5 h in sequence)
    python3 run.py c7 c8       # single cases; all but c1/c4/c5/sb/err start from the disks c1 left ("golden")

Results: `~/ohv/results/<case>/` with `test.log` (one `ok`/`FAIL` line per check, with the evidence),
`result.json`, the serial console of every VM, and the stick's log volume as the case left it.
Exit code 0 only if every requested case passed. Cases are independent of each other apart from the golden
disks, so several `run.py` processes can run side by side.

## Cases

| Case | What it proves |
|---|---|
| `c1` | Power on with blank disks and the stick: one power-on later the installed system answers on SSH with the key; layout, RAID, both ESPs, firmware entries, kernel, sshd, password hash, never-stays-off settings all as specified; logs + inventory on the stick. Saves the golden disks |
| `golden-pool` | Helper: golden disks + a ZFS mirror `offbox` on the two `offbox-zfs` partitions holding a marker file and a checksummed blob |
| `c2` | Boots unattended with either NVMe removed (with and without the stick), arrays degraded, pool imported degraded. Also: firmware boot entries wiped; only one blank disk at install time (installer aborts, changes nothing, retries) |
| `c3` | Stick first in the boot order across 3 restarts: the stick's GRUB starts the installed system every time, the installer never runs, the pool data is intact |
| `c4` | Power cut while clearing disks, while partitioning, while copying, right after Ubuntu's installer registered the half-finished disks with the firmware, during final configuration: the next power-on comes back to the stick and still ends in a good install. Cut right after the last step: no second install. Cut between the finished mark and the firmware entries: the stick starts the install and it completes itself |
| `c5` | Network cable out during the whole install: completes, logs on the stick, comes online by itself when the cable is back, apt works |
| `c6` | `REINSTALL-OS` (dropped on the stick over SSH, then a restart) rebuilds the OS and keeps the pool and the machine identity; `WIPE-EVERYTHING` wipes all; without a marker the installer refuses even when forced to start, also when only pool data is left |
| `c7` | `poweroff`, `halt`, `shutdown -h now`, `systemctl poweroff/halt`, `init 0`, ACPI power button: the machine is back by itself and never off. Suspend/hibernate refused. RTC alarm armed |
| `c8` | Kernel panic, a hang where nothing but real-time busy loops gets CPU time (only the hardware watchdog can end it), root disk not found in the initramfs: back up, or restarting, without anyone. Oops: the setting is checked; a real one only where the `lkdtm` module exists |
| `c9` | A boot that lands in emergency mode is reachable over SSH, restarts by itself, can be held for debugging, and is normal again once the cause is fixed |
| `c10` | A new kernel that cannot boot is tried exactly once and the machine falls back; it is never tried again. A good new kernel is promoted by the health check and protected from autoremove |
| `c11` | `install-host.sh` on the stick-installed system (pool on the two labelled partitions, Incus, boatd) and three hard power cuts under load with the pool healthy and data intact |
| `sb` | Extra: the same with Secure Boot enforced, including the stick starting the installed system |
| `err` | Extra: a failed install (test hook) is logged, stays reachable, and the automatic retry succeeds |
| `acc` | Extra: `acceptance.sh` runs to its end on a VM install without shell errors, and its `--test-watchdog` / `--after-watchdog` pair works (the hardware verdicts themselves only mean something on the real board) |
| `kvm-empty` | The box with a network KVM attached: USB keyboard and mouse plus a virtual USB drive with no medium. First the manual menu entry "installer session only" is picked with the keyboard (session up, nothing installed, status page on screen); then C1 (zero-touch install, status page visible, nothing secret on it, login prompt with addresses on tty1) and C3 (three restarts with the stick first: never reinstalls, pool intact) in that shape |
| `kvm-fat` | The same with the KVM's drive holding an unrelated FAT volume that enumerates before the stick (the stick is not `/dev/sda`) and carries files named `WIPE-EVERYTHING` and `REINSTALL-OS.txt`: C1 and C3 again; the foreign volume is ignored and unchanged |
| `macstick` | Extra, needs `OHV_MAC_STICK=<image>`: a disk image made on the Mac by `write-stick.zsh --image` (diskutil's partition table, macOS FAT32) installs, logs to its log volume and, left in, starts the installed system |
| `ts` | Extra, needs a throw-away auth key in `OFFBOX_TS_TEST_KEY`: installer and installed system join the tailnet by themselves; reached from the Mac with the real key |

## How it works

- `mkimage.sh` builds a raw disk image with the stick's layout (MBR, FAT32 16 GiB + 4 GiB) from the
  `build-tree.sh` output with mtools; no root. Each VM gets a copy-on-write overlay of it.
- `vm.py`: one QEMU/KVM machine (`vm.kvm = "empty" | "fat"` adds a network KVM's USB devices; keys can be pressed over QMP). Power cut = SIGKILL of QEMU. Clean stop = restart with QEMU told to exit at
  the reset. Disks can be left out, the network cable pulled (`set_link`), the power button pressed (QMP).
- `run.py`: the cases. Checks never stop a case; exceptions do.
- Test settings reach the guest through QEMU fw_cfg (`opt/offbox/…`): the test SSH key, shorter hold times,
  a test tailnet name, the one-time failure for `err`. Real hardware has no fw_cfg; the scripts then use
  their built-in defaults. The real private key never leaves the Mac: the VMs are driven with a key generated
  on the test machine, and the real public key in `authorized_keys` is checked for presence (and used for
  real in `ts`).
- `test_plan.py`: unit tests of the disk decision; `subiquity_check.py`: the ISO's own subiquity and curtin
  validate the autoinstall file (both run from `static-check.sh`).

## What a VM cannot show

The board's firmware (POST, boot order, power-loss behaviour, RTC wake from S5), the real watchdog
(`sp5100_tco`), the real NIC, memory training and stability, temperatures. Those are `acceptance.sh` and the
"hardware-only" rows of `../FAILURE-MODES.md`.
