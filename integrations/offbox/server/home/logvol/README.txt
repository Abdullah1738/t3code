offbox installer stick: log volume
==================================

stage.log     one line per step of every installer boot and every boot of the installed system
logs/         one folder per installer boot: inventory/, journal, subiquity and curtin logs, the plan
installed/    boot reports written by the installed server while the stick is plugged in
ts-installer/ Tailscale identity of the installer session (secret; do not share)

To reinstall on purpose, put an empty file named REINSTALL-OS (keeps the data pool) or WIPE-EVERYTHING
(erases everything) in this folder, plug the stick into the server and restart it.
