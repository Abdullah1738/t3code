# ovnfs SSD recovery

A monitor copied to the internal disk, so it survives the disappearance of
`/Volumes/ExternalSSD`. It only acts after seeing that mount disappear and return;
it does not manage steady-state hangs, memory or checkout retention.

It records daemon identity from `ovnfs --json status` before the drop. After five
stable observations of the returned volume it waits for a loading daemon, accepts
a peer's completed recovery, or launches the pinned `ovnfs serve` with an inherited
startup lease after excluding owners in every retained state-directory generation
and confirming the recorded pre-drop PID/birth has exited. It refuses unfinished or
unreadable unmount receipts before launching. An unresponsive holder, including one
whose returned Unix status says absent, receives one SIGTERM only when its recorded
PID, process birth and kernel argument fingerprint (or exact descriptor/listener)
still match, and no unknown peer is observed. TERM keeps the mount in the supported build. It never removes
state files, alters checkout contents, force-kills, or requests unmount recovery. A stuck TERM,
unknown holder or different build needs an operator. Logs distinguish those cases.

The supported build is e2f9f0e629a1 (Robob #700 startup fixes on the node-cache
branch). Porting to another build requires checking TERM keep-mount, start.lock,
loading status and saved-port fencing again. The executable stays behind the
existing `~/.local/bin/ovnfs` memory-limit wrapper.

Before a drop it retains the state directory and startup/state lock descriptors.
Every new monitor process starts unarmed, including one loading a healthy journal;
it must observe a healthy daemon and capture fresh witnesses before a new drop.
After return it fences the original and current startup domains, then probes their
state locks and relative admin/NFS sockets. This catches a peer replacement between
status polls, including renamed binaries and the interval between admin bind and
state locking. Temporary POSIX lock queries establish kernel lock-domain identity;
device/inode numbers alone cannot establish equivalence across remounts. Kernel
socket peer PIDs can veto recovery; only an identity previously reported by ovnfs
status can authorize TERM. It retains intermediate generations across repeated
drops and rechecks exclusion before starting or accepting a peer's recovery.

Automatic recovery requires valid retained witnesses. Revoked/unreadable controls,
an uncaptured intermediate generation, or a watcher restart during pending recovery
require an operator. The tests use directory replacement; survival of these witnesses
through physical SSD removal is unproven. Open references can also affect clean eject.

The watcher uses an internal singleton lock, observes `start.lock` before TERM,
and pauses memguard before recovery using a private hardlink with durable intent. A running memguard or a foreign pause (including an expired one) defers
recovery. Our pause survives monitor restarts and is removed after readiness; it
expires for memguard after 30 minutes. A published pause is never renewed;
expiry or malformed own state is logged and requires an operator. A crash before/after publishing the link can be reconciled
without adopting a foreign pause. The inherited startup lease serializes other CLI starts; ovnfs owns stale socket
cleanup. Readiness checks status, the mount table and cached `nfsstat` parameters
against the reported socket or TCP transport and port; it does not traverse
checkouts. This proves control-plane readiness, not arbitrary checkout I/O.

Install only after owner approval and landing on origin/main:

```sh
./integrations/deploy.zsh ovnfs-recovery --dry-run
./integrations/deploy.zsh ovnfs-recovery
./integrations/ovnfs-recovery/install.zsh --check
launchctl print gui/$(id -u)/com.abdullah.ovnfs-recovery
tail -30 ~/Library/Logs/ovnfs-recovery.log
```

An existing loaded monitor is never stopped by the installer. Updating it requires
an approved `launchctl bootout gui/$(id -u)/com.abdullah.ovnfs-recovery` before the
install command. It never restarts Robob, OpenCode, memguard or ovnfs at install.

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s integrations/ovnfs-recovery -p test_recovery.py -v
```

Tests include native disposable processes, file locks, socket listeners and the pinned
CLI's status against temporary state; daemon launches and TERM are substituted.
A live SSD-disconnect drill
would interrupt every working lane and needs separate owner approval. Recovery
state is `~/.local/state/ovnfs-recovery/state.json`; logs are in
`~/Library/Logs/ovnfs-recovery.log`. No network or database access is involved.
