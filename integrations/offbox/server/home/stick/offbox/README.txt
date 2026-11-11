offbox home server: headless installer stick
============================================

Plug this stick into the server and power it on. Nothing else is needed: no screen, no keyboard.

What it does
  - Blank disks (or an install that lost power half-way): installs Ubuntu Server on the two NVMe disks.
  - A finished install is already on the disks: does NOT install. It starts the installed system instead,
    so the stick can stay plugged in for good.
  - To reinstall on purpose, create an empty file in the root of the OFFBOXLOG volume of this stick:
        REINSTALL-OS      rebuilds the operating system, keeps the data pool
        WIPE-EVERYTHING   erases both disks completely and installs from scratch
    then plug the stick in and restart the server (a short press of its power button restarts it).
    The file is deleted once it has been acted on.

Where to look when something is wrong
  - OFFBOXLOG volume, file stage.log: one line per step, newest at the bottom.
  - OFFBOXLOG volume, folder logs/: full logs and a hardware inventory per installer boot.
  - OFFBOXLOG volume, folder installed/: reports written by the installed system at each boot.
  On the Mac:  integrations/offbox/server/home/read-stick-log.zsh  summarises all of it.

Files
  offbox/installer/   scripts the installer runs (decision logic: plan.py)
  offbox/target/      files copied into the installed system
  offbox/site/        the SSH public key and the console password hash for this server
  offbox/pkgs/        Tailscale package
  nocloud/            the autoinstall configuration
  tailscale-authkey   (optional, secret) lets the server join the tailnet by itself
  A5677.CAP           (optional) ASUS BIOS for USB BIOS FlashBack on the PRIME B850M-A WIFI
