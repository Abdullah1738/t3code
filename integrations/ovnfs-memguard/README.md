# ovnfs memguard

Installs the memory guard and its existing five-minute LaunchAgent. After the
reviewed commit is on `origin/main`, run `python3 install.py`, then
`python3 install.py --check`. Installation needs the owner's approval. It does
not replace the ovnfs binary or restart its daemon directly.

The default limit remains 14336 MB with a 1200-second cooldown. The existing
`OVNFS_MEMGUARD_LIMIT_MB` and `OVNFS_MEMGUARD_COOLDOWN_S` overrides still apply.
Every restart logs its exit status and mount-table plus directory-read samples
once per second during the restart and for two minutes afterwards. A blocked
read remains one pending probe; samples never accumulate blocked processes.
The guard holds one lock through that observation window. Logs stay at
`~/Library/Logs/ovnfs-memguard.log`.

A listed mount is insufficient evidence of recovery. Look for a successful
read with `mount_entry: true`. The new guard waits up to 30 minutes for the
restart command and reports a timeout separately from a restart failure.
