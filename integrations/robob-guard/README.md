# Robob guard

Reopens `/Applications/Robob.app` in the background after a close or crash,
and at login. It never quits or kills Robob or OpenCode and never reads the
Robob database. Only a fresh install heartbeat holds off reopening. There
is no stay-quit file or mode switch.

`com.ardud.robob-guard` checks every 30 seconds, including `RunAtLoad`.
It compares the full executable path from `ps -axo pid=,comm=`. Two down
checks trigger `open -g -a`, with only HOME, USER and the system PATH in its
environment. Within five minutes of boot, the first down check opens it.
A failed process-list read cannot trigger an open.

After each attempt it allows 90 seconds to start. If still absent, it waits
2, 5, 10, then 10 minutes between failure detection and the next retry,
forever. Seeing the process resets the failure count and backoff. Reopen
history spans recovery so repeated crashes can still be detected. One
Telegram attention alert reports three consecutive failed reopens, and one
reports more than four reopens in an hour. Ordinary reopens are silent.
Failed notifications retry on subsequent checks using the same key. Crash
loop episodes end after an hour without a reopen; failure episodes end on
recovery or an install hold. Alert times use Dubai time; log times use UTC.

## Install holds

```zsh
robob-install-hold start --by release-install --pid $$
trap 'robob-install-hold stop --by release-install --pid $$' EXIT
# pre-quit work, quit, install, reopen, wait for healthy (or rollback)
```

`start` atomically writes `~/.robob/install-hold.json` containing `by`, `pid`,
`startedAt`, `beatAt` (epoch seconds), starts a detached beater and prints its
PID. Every 20 seconds the beater updates the file while the installer PID
lives. `beat --by NAME --pid PID` updates a matching hold; `stop` removes only
a matching hold and terminates its verified beater. Concurrent live owners
are refused. An old beater cannot update a replacement hold.

A hold counts only when its PID lives and its beat is less than 90 seconds
old (future timestamps are invalid). Stale/dead holds are logged and left in
place, and do not prevent reopening. Install holds reset the down count.

The cutover scripts source `scripts/install-hold.zsh` before their first quit.
It shares a verified parent hold across nested scripts and uses `zshexit`,
so existing mount-cleanup EXIT traps still run. The release installer uses
`apps/desktop/scripts/robob-install-hold.mjs` around the whole install and
failure-relaunch window. If the deployed helper is missing, scripts warn and
continue: **the guard may then reopen Robob mid-install**. Any other hold
acquisition failure aborts before quitting.

If the legacy before-launch hook returns 70 (files could not be restored),
the installer stays alive and keeps its heartbeat while waiting for manual
repair and a healthy Robob. Keep that installer running until repair is done.
Killing it removes the only allowed hold-off and the guard will reopen Robob.

## State and installation

State, log, locks and beater identity live in `~/.local/state/robob-guard/`:
`state.json`, `guard.log`, `check.lock`, `hold.lock`, `hold-beater.json`.
The log has one UTC line per check (`up`, `down n`, `hold:NAME`, or
`stale-hold:NAME` plus the action). Over 1 MiB it trims to the last 2000 lines.
The guard writes only in this directory. The hold helper also writes the
install hold file. Nothing uses `~/.robob/userdata` or SQLite.

After owner approval, from the merged checkout:

```zsh
integrations/deploy.zsh robob-guard
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.robob-guard.plist
```

Deploy copies the integration, symlinks `~/.local/bin/robob-install-hold`,
and installs the plist; it does not load or restart it. The plist uses the
system Python and files on the internal disk, independent of the SSD checkout.
Emergency stop:

```zsh
launchctl bootout gui/$(id -u)/com.ardud.robob-guard
```

Tests (no app launch, live holds, notifications, or DB access):

```zsh
cd integrations/robob-guard
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest -v
```

See [release-supervisor.md](release-supervisor.md) for the exact hold patch
needed by the external release retry supervisor before the guard is enabled.
