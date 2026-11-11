# Failure modes of the headless install and of the installed server

The server has no monitor and nobody at it. What can be seen: its HDMI output through a network KVM (GL.iNet
Comet, attached at install time), the tailnet, the LAN from the Mac, and the stick once it is plugged back
into the Mac. Every row says how the failure shows up through those three, what the
machine does by itself, what to do next, and what proves it.

Proof column:

- `C1` … `C11`, `sb`, `err`, `acc`, `kvm-empty`, `kvm-fat`, `macstick`, `ts`: VM test cases in `vmtest/run.py` (one case each; see `vmtest/README.md`).
- `unit`: `vmtest/test_plan.py` (the disk decision and what may be wiped).
- `static`: `static-check.sh`.
- `D`: the manifest check of the written stick (`write-stick.zsh`).
- **hardware-only (check on arrival)**: cannot be proven in a VM. `acceptance.sh` checks it where a script can.
- *not tested*: the code path exists, nothing exercised it. Listed so nobody assumes otherwise.

Tools: the network KVM on the HDMI port, with its keyboard and its power/reset buttons (K), `watch-install.zsh`
(W), `read-stick-log.zsh` with the stick in the Mac (R), `offbox-status` on the server (S), `acceptance.sh` (A).
Where K helps it comes first. Nothing depends on it: row 1.14.

## 1. Before Linux starts (board, firmware, stick)

| # | Failure | How it shows up headless | What happens by itself | What to do next | Proof |
|---|---|---|---|---|---|
| 1.1 | Machine does not power on (PSU switch, front-panel header, cable) | K: no video signal, power LED on the ATX board dark. W: nothing answers | Nothing | K: press power on the ATX board. Still dark: a person checks the PSU switch (I), 24-pin + 8-pin CPU power, and that the ATX board sits on F_PANEL | **hardware-only (check on arrival)**; the power press is remote |
| 1.2 | First boot trains 4 DIMMs for 5-15 min (normal) | K: black screen or the ASUS logo for minutes, power LED on. W: nothing answers | Training finishes, boot continues | K: watch, wait 20 min before touching anything | **hardware-only (check on arrival)** |
| 1.3 | No POST: CPU/RAM seating, a DIMM that does not train | K: power LED on, no picture ever. Never a DHCP lease. R: `stage.log` has no line | Nothing | K: reset, then hard off/on (long press) once. Still nothing: a person reads the Q-LED on the board (CPU/DRAM/VGA/BOOT), reseats RAM, tries one DIMM in slot A2 | **hardware-only (check on arrival)** |
| 1.4 | BIOS too old for the 9950X3D | Same as 1.3 (Q-LED CPU) | Nothing | BIOS FlashBack: stick in the FlashBack port, hold the button 3 s; file `A5677.CAP` (BIOS 1804) is in the stick root. ASUS lists the CPU from the first BIOS, so this should not be needed. FlashBack on a stick with two partitions is unproven: if the LED goes solid after 5 s, copy `A5677.CAP` alone to a FAT32 single-partition stick | **hardware-only (check on arrival)** |
| 1.5 | Firmware waits at a prompt ("Press F1", fTPM "New CPU installed … Y/N") | K: the prompt is on the screen. W: nothing answers. R: no line | Nothing | K: answer it with the KVM keyboard (`F1`; fTPM prompt: `Y`, nothing here uses the TPM), then set "Wait For 'F1' If Error" = Disabled (README: BIOS settings). Before the KVM this needed a person | **hardware-only (check on arrival)**, now drivable remotely |
| 1.6 | Firmware does not boot the stick (boot order, port) | K: BIOS setup, a "no boot device" message, or another system starting. R: no new line in `stage.log` | Nothing | K: `F8` at the logo and pick the stick, or Boot > Boot Option Priorities. If the stick is not listed: a person moves it to another rear USB port | **hardware-only (check on arrival)**, now drivable remotely |
| 1.7 | Secure Boot is enforced (ASUS default varies) | — | Stick boots through Ubuntu's signed shim → GRUB → kernel; the installed system too; ZFS module loads | Nothing | `sb` |
| 1.8 | Stick's GRUB takes the wrong entry | Serial/VGA line `offbox: installed=… marker=… -> …` | Installer has its own guard (2.7) | — | `C1` `C3` `C6` |
| 1.9 | Stick written wrongly / bit rot | Verified before it leaves the Mac; `offbox/MANIFEST.sha256` is on the stick for a later re-check (`write-stick.zsh --verify`) | — | Rewrite the stick | `D` |
| 1.10 | Stick dies or is pulled after the install | Server keeps running; next boot finds no stick and boots the disks | — | Nothing | `C2` (no-stick variants) |
| 1.11 | A key is pressed while the stick's menu counts down (KVM keyboard, a stuck key) | K: the menu is on the screen, no countdown | Waits there: this is the manual way in, and the only place the stick waits (the installed system's own 3 s boot menu behaves the same) | K: Enter on the highlighted entry (the default is already selected) or reset. KVM dead as well: a person presses the power button | Picking an entry with the keyboard: `kvm-empty`. The waiting itself is GRUB's normal behaviour, *not tested* |
| 1.12 | Other USB devices next to the stick (the KVM's keyboard, mouse, virtual drive; an unrelated FAT volume, even one holding files named like our marker files) | — | Ignored: the stick's volumes are found by content, other volumes are only read, markers count only on the stick, targets are NVMe only | Nothing. Do not attach the stick and a virtual-media copy of it together | `kvm-empty` `kvm-fat` `unit` |
| 1.13 | Installing from the KVM's virtual media instead of the stick, mounted read-only | K: status page shows stage lines; R has nothing new | Install works; logs stay in RAM (`/run/offbox/log-ram`), no boot reports on the image, markers are remembered on the disks instead of deleted | Read the logs over SSH while it runs; mount read-write if the KVM can | Image boot: `macstick`. On the Comet, and read-only: *not tested* |
| 1.14 | The KVM itself is unreachable (its network, its power, its Tailscale) | Its web page does not load | The install and the server do not depend on it in any way | Everything in this table still works without K: W, the LAN, R. A person power-cycles the KVM when convenient | by design: every VM case but `kvm-*` runs without a keyboard or screen |

## 2. While the installer runs

| # | Failure | How it shows up headless | What happens by itself | What to do next | Proof |
|---|---|---|---|---|---|
| 2.1 | Normal install | W: "installer system on the tailnet/LAN", stage lines; R: `late-done` | Installs, restarts into the installed system (about 8 min in the VM) | Nothing | `C1` |
| 2.2 | No network at all (cable, switch, router) | K: status page says `addresses: none yet (no DHCP lease)`. W: nothing. R: `live-unreachable` with NIC state, later `late-done` | Install completes offline (nothing is downloaded); the server comes online when the cable does | Fix the cable; no reinstall | `C5` |
| 2.3 | Kernel has no driver for the NIC | K: status page, no address; Alt+F2 shell: `lspci -nnk`. R: `live-unreachable`; `inventory/lspci.txt` shows the controller without "Kernel driver in use" | As 2.2: installs, but the server stays offline | Needs a newer kernel/driver brought on a stick. The HWE kernel on the stick (7.0) carries `r8169` for RTL8125/8126 | **hardware-only (check on arrival)** |
| 2.4 | No Tailscale key on the stick, key expired (after 2026-11-25) or rejected | W: "installed on LAN, not on the tailnet"; S: `ts_state=NeedsLogin`; journal of `offbox-tailscale-join` | Everything else works; reachable as `offbox-server.local` / DHCP name; join retried every 2 min | `tailscale up --auth-key=…` over LAN SSH (W prints the command) | `C1` (no key), `ts` (with key) |
| 2.4a | The tailnet already has a machine called `offbox-server` (an earlier install that was wiped with `WIPE-EVERYTHING`, which makes a new node; `REINSTALL-OS` keeps the old one) | W finds it anyway (it looks for names starting `offbox-`); the admin console shows `offbox-server-1` | Works under the `-1` name and its 100.x address | Delete the stale machine in the Tailscale admin console; the name frees up | Seen in `ts` (a leftover test node made the next one `offbox-vmtest-1`) |
| 2.5 | Tailnet join fails during install (no internet yet, clock wrong) | R: stage `tailscale … retries after boot` | Installed system retries every 2 min with the key copied from the stick; key file is deleted once joined | Nothing | `C5` (offline install), `ts` |
| 2.6 | Not exactly two NVMe disks of equal size (one missing, one dead on arrival, wrong size) | K: status page shows `abort`, the reason and the restart countdown. W: installer reachable, stage `abort`, reason in `plan.json`; R: same | Nothing is changed. Holds 30 min reachable, restarts, decides again | K: BIOS > Advanced > NVMe Configuration shows which disk the firmware sees (menu name unconfirmed). Fix the hardware; no other action | `C2` (one blank disk), `unit` |
| 2.7 | Disks already hold a finished install, no marker file | Serial: `-> disk`; if the installer is started anyway: stage `refuse` | Stick GRUB loads the installed system's own boot menu from the disks (it can read `/boot` because that array uses RAID metadata 1.0); the installer, if started anyway, refuses, points the firmware at the disks and restarts | Nothing. To reinstall: marker file (2.10) | `C3` `C6` `sb` `unit` |
| 2.8 | Disks hold pool data but no finished-install mark | K: status page shows `refuse` and the reason. W/R: stage `refuse`, reason names the partitions | Nothing is changed; reachable; retries every 30 min | Decide: `REINSTALL-OS` (keeps the pool) or `WIPE-EVERYTHING` | `C6` `unit` |
| 2.9 | Leftovers on the disks (half an install, old partitions, no pool, no finished mark) | R: plan reason "interrupted install or leftovers" | Full install | Nothing | `C4` `err` `unit` |
| 2.10 | `REINSTALL-OS` / `WIPE-EVERYTHING` | R: plan line names the marker | Acts on it, deletes the marker, records it on the ESPs. `REINSTALL-OS` never writes to the `offbox-zfs` partitions or the partition table and keeps ssh host keys, tailnet identity, boatd token | — | `C6` `unit` |
| 2.11 | Marker asks for something impossible (both markers; `REINSTALL-OS` on disks without our layout) | W/R: stage `abort` with the reason | Nothing changed; holds 30 min, restarts. With the disks first in the boot order the installed system comes back and does not hand the same marker to the installer twice | Remove the marker over SSH (`rm /run/offbox/logvol/<MARKER>`) | `unit` (decision); the restart path *not tested* |
| 2.12 | Marker cannot be deleted (stick read-only) | R: `warn … recorded as used` | Marker identity is stored on both ESPs and ignored from then on: no reinstall loop | Delete the file on the Mac | `unit` (ignored when recorded); the read-only stick itself *not tested* |
| 2.13 | Power cut during the install (any point) | R: several `live-start` lines, one `late-done` | Next power-on comes back to the stick and installs again from the start. The finished-install mark is written last, and while an install runs the stick is pinned as the firmware's next boot device (`BootNext`, stage `firmware-next`) | Nothing | `C4` (cuts 1-5) |
| 2.13a | Same, in the one minute after Ubuntu's installer registered the disks with the firmware (it always does, and puts them first) and before our last step removed that again, **on a firmware that ignores `BootNext`** | LAN: a machine `offbox-server` answers on SSH with the key, but `offbox-status` does not exist and `/etc/offbox/installed` is missing | Nothing: a plain, half-configured Ubuntu keeps running | Over SSH: `efibootmgr` (find the USB entry), `efibootmgr -n <its number> && reboot`: the stick installs again | In the VM `BootNext` works: `C4` (cut 4). The board's firmware: **hardware-only (check on arrival)**: the stage log of the first install shows `firmware-next`; A checks that `efibootmgr -n` is accepted |
| 2.13b | Power cut after the finished-install mark is written but before the disks are bootable for the firmware | R: `marked` without `late-done` | Next power-on: the stick starts the finished install; its first health check completes the boot entries and the removable path | Nothing | `C4` (cut 7) |
| 2.14 | Power cut right after the install finished | — | Next power-on boots the installed system; no second install | Nothing | `C4` (cut 6) |
| 2.15 | The install itself fails (subiquity/curtin error, bad disk, a bug in our late step) | K: status page shows `install-failed`, then the countdown. W: installer reachable, stage `install-failed` then `hold`; R: first errors + full logs | Logs to the stick, stays reachable 10 min, restarts by force (the live system's normal shutdown waits for ENTER at "remove the installation medium") and tries again. From the third failure in a row it waits a day between tries | Read the error (W/R); `touch /run/offbox/hold` keeps the session | `err` |
| 2.16 | Installer hangs (neither finishes nor fails) | R: last stage line is old; W: installer reachable | Restart after 2 h, then the normal decision | K: status page (Alt+F8) and Ubuntu's installer screen (Alt+F1) show where it stands; reset restarts it at once. Look while it is reachable | *not tested* |
| 2.17 | Stick's log volume unusable or full | R: no/old logs | Install does not depend on it (logs go to RAM); oldest boots are deleted below 400 MB free | W over the network | *not tested* |
| 2.18 | Stick pulled during the install | W: installer stops answering | Installer dies with its media. Next boot with the stick back in: 2.9 | K: reset once the stick is back (Plug the stick back in, press the power button) | *not tested* |

## 3. The installed server: staying up

| # | Failure | How it shows up headless | What happens by itself | What to do next | Proof |
|---|---|---|---|---|---|
| 3.1 | Somebody runs `poweroff`, `halt`, `shutdown -h`, `init 0`, or presses the power button | Short SSH drop | Ends in a restart; the machine never switches off | Nothing | `C7` |
| 3.2 | Suspend / hibernate requested | Command is refused | Stays up | Nothing | `C7` |
| 3.3 | Mains power lost and restored | Server gone, then back | Depends on the BIOS setting "Restore AC Power Loss" = Power On. The OS cannot set it | K: set Advanced > APM Configuration > Restore AC Power Loss = Power On before the first install. The test itself needs a person: Abdullah pulls the cable for 30 s (A prints it). If it then stays off: K, press power, check the setting | **hardware-only (check on arrival)**: the setting is now remote, the test is not
| 3.4 | A real power-off anyway (`poweroff -ff`, thermal trip) | Server gone | RTC alarm is armed 15 min ahead while running and 3 min ahead at every shutdown; wakes the board if it honours RTC wake from S5 (ErP off) | K: press power; that is the remote way out of any real power-off. A `--test-rtc-wake` | Armed: `C7`. Wake from S5: **hardware-only (check on arrival)** |
| 3.5 | Kernel panic / oops | Short drop; console `Kernel panic` | Restart after 10 s | S after it is back; `journalctl -b -1` | Panic: `C8`. Oops: the setting `panic_on_oops=1` is checked in `C8`; a real oops is *not tested* (the module to provoke one is not on the server) |
| 3.6 | Hard hang (all CPUs stuck) | Dead to ping/SSH for 1-2 min | Hardware watchdog (systemd, 60 s) resets the machine | K: the frozen picture shows it; reset if the watchdog has not fired after 5 min | `C8` with QEMU's i6300esb (and A's own `--test-watchdog` in `acc`). The board's `sp5100_tco`: **hardware-only (check on arrival)**, A `--test-watchdog` |
| 3.7 | Root file system not found at boot | Not reachable | Initramfs restarts instead of waiting at a prompt (`panic=10`), again and again | K: the screen shows the restart loop. `F8`, boot the stick, entry "installer session only", then over SSH `touch /run/offbox/logvol/REINSTALL-OS && reboot`, and `F8` + the stick once more: it reinstalls the OS and keeps the pool | `C8` |
| 3.8 | Boot lands in emergency/rescue mode (bad fstab entry, failed mount) | K: `EMERGENCY MODE` lines with the SSH address and the countdown, and a root login on the console. W/LAN: SSH answers; `systemctl is-active emergency.target` = active | The agent starts network, sshd and tailscaled by hand where the normal units did not come up, and restarts after 10 min (1 h from the third time in a row) | Fix over SSH; `touch /run/offbox/hold` stops the restart | `C9` (failed mount: the normal sshd was already up; the agent's own sshd start was *not tested*) |
| 3.9 | `/boot` or the ESP cannot be mounted | S: failed units | Boot continues (`nofail`, 30 s) | Repair at leisure | `C2` (ESP of the missing disk) |
| 3.10 | A new kernel does not boot | Longer restart; console `Loading Linux <new version>` once, then a panic | Tried exactly once; the next boot uses the previous kernel; the bad one is recorded and never tried again | `offbox-kernel-trial status` | `C10` |
| 3.11 | A new kernel boots but the machine is unhealthy (no link that worked before, sshd down, pool not imported, a unit from `health.d` down) | S: `health=… unhealthy` | Restart into the previous kernel; new one marked bad | Same | Promotion path `C10`; the unhealthy-verdict path *not tested* |
| 3.12 | Security updates | — | Installed daily, never restart the machine. A new kernel waits for the next restart, then 3.10 | Restart when convenient | Settings `C1`; a real unattended run *not tested* |
| 3.13 | One NVMe fails or is removed | S / `cat /proc/mdstat`: `[U_]`; `zpool status`: DEGRADED | Boots and runs from the other disk alone (either one); pool imports degraded | Replace the disk, see "Replacing a disk" | `C2` |
| 3.14 | Firmware boot entries lost (CMOS cleared, BIOS update, board replaced) | — | Both ESPs carry the removable path `EFI/BOOT/BOOTX64.EFI`: boots anyway. The health check 4 min after boot (`offbox-esp-sync`) puts an entry per disk back, first in the boot order | Nothing | `C2` (cleared-firmware variants) |
| 3.15 | Stick left plugged in for good | — | Every boot ends in the installed system, never a reinstall | Nothing | `C3` |
| 3.16 | Pool import slow or failing | S: `zpool=`; health `zfs-pool-not-imported` | Boot does not wait for it (3 min limit) | `zpool import`, `zpool status` | Degraded import `C2`; power cuts `C11` |
| 3.17 | Hard power cuts under load | — | md and ZFS come back clean; Incus and boatd start | `zpool scrub` now and then | `C11` |
| 3.18 | Tailscale node key expiry | — | Does not expire (node is tagged `tag:offbox`) | — | `ts` |
| 3.19 | Tailscale down or logged out later | W: installed on LAN only | LAN path stays: sshd on all interfaces, mDNS name, DHCP name | Rejoin over LAN SSH | LAN SSH `C1`…; rejoin *not tested* |
| 3.20 | Memory errors with 4 DIMMs at speed | Random crashes, MCE lines | Panic → restart (3.5) | A (3 min pass), A `--memory-full` overnight; lower the memory speed in the BIOS. K: memory speed in Ai Tweaker > Ai Overclock Tuner | **hardware-only (check on arrival)** |
| 3.21 | CPU / NVMe too hot | Throttling, thermal power-off (then 3.4) | — | A: temperatures under load | **hardware-only (check on arrival)** |
| 3.22 | NVMe wearing out, year two | SMART values | Nothing automatic (no monitoring daemon is installed offline) | A prints SMART; add `smartd` alerts in the host setup | **hardware-only (check on arrival)** |
| 3.23 | Root file system full | S: failed units; health `root-not-writable` | — | Clean up over SSH | *not tested* |
| 3.24 | Clock wrong (new board, dead battery) | Log file names use a counter, not the date | timesyncd corrects it once online; tailnet join retried | — | *not tested* |
| 3.25 | Serial console absent (`console=ttyS0` with no UART) | S: `serial-getty@ttyS0` may show as failed | Harmless | Ignore, or drop `console=ttyS0` from `/etc/default/grub.d/90-offbox.cfg` | **hardware-only (check on arrival)** |

## Replacing a disk (3.13)

With the new, blank disk in (say it is `/dev/nvme1n1`, the good one `/dev/nvme0n1`):

    sgdisk -R /dev/nvme1n1 /dev/nvme0n1 && sgdisk -G /dev/nvme1n1     # same partition table, new GUIDs
    mdadm --add /dev/md0 /dev/nvme1n1p2 && mdadm --add /dev/md1 /dev/nvme1n1p3
    mkfs.vfat -F 32 /dev/nvme1n1p1 && offbox-esp-sync                 # second ESP
    zpool replace offbox <old-partition-guid> /dev/disk/by-partlabel/…  # or by-partuuid of nvme1n1p4
    efibootmgr -c -d /dev/nvme1n1 -p 1 -L ubuntu-disk2 -l '\EFI\ubuntu\shimx64.efi'

Then `cat /proc/mdstat` and `zpool status` until both are complete. The machine stays in service throughout.

## What only a person at the box can fix

With the KVM working: a machine without power or without any picture (1.1, 1.3: cables, seating, the Q-LED),
BIOS FlashBack (1.4: a button on the board), moving the stick to another port (1.6), and the one test that
needs the mains cable pulled (3.3). Firmware prompts (1.5), the boot order (1.6), power-on after a real
power-off (3.4) and a boot that cannot find its disks (3.7) are now handled from the KVM.
Without the KVM (1.14) those four need a person again; everything else recovers by itself or leaves a session
reachable over the LAN or the tailnet, exactly as before.
