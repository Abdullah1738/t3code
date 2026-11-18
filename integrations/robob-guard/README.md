# Robob guard

Recovers `/Applications/Robob.app` in the background when its backend is unavailable,
and at login. It never reads the Robob database or signals OpenCode/provider workers.
An unready registered desktop can be terminated before reopening. Only an unexpired
install hold with a fresh heartbeat holds off recovery. There
is no stay-quit file or mode switch.

`com.ardud.robob-guard` checks every 30 seconds, including `RunAtLoad`.
It calls the same authenticated `/api/ardud/control/health` endpoint as
`t3ctl health`, with a three-second total HTTP deadline and no deep-health SSD
reads. It uses a guard component credential when provisioned, otherwise the
existing t3ctl component credential or shared control credential. The file must be
private; rejected credentials/configuration errors are logged without restarting
the app. Healthy, degraded and recovered-unverified responses count as reachable.
Two down checks open an absent app, with only HOME, USER and the system PATH in its
environment. Within five minutes of boot, the first down check opens it.
Attempts from before the current boot lose their startup grace and retry delay;
attempts made on this boot still get the full 90 seconds to start. Install
heartbeats take precedence over the startup reopen.
A failed process-list read cannot trigger an open. If a desktop is present but
health is unavailable, the guard identifies it through LaunchServices, verifies
its executable and birth time, and gives a new desktop three minutes to start.
After that grace, replacement requires at least three consecutive unready checks
spanning another three minutes. Recovery, a hold, a different desktop or a gap
over 90 seconds resets that observation window. Replacement attempts are limited
to one per 15 minutes, including failed attempts; the remaining cooldown is logged.
Eligible unready desktops get SIGTERM, then SIGKILL after three seconds if needed.
Every signal rechecks identity; provider/Node workers are never selected. Recovery
attempts to record a guard quit reason before signalling, with a bounded provenance
write. An unavailable handoff is logged locally and does not prevent recovery.
The guard rechecks health and the install hold under the hold lock before acting,
then rechecks desktop identity and health after the provenance handoff. Recovery
or a new desktop cancels the stale action. Surviving workers without a registered
desktop do not prevent ordinary absent-desktop reopening.
A dead PID retained by LaunchServices counts as an absent desktop. The quit-reason
CLI reports `no desktop` and the watchdog hold skips its reason handoff in that case.

After each attempt it allows 90 seconds to start. If still unavailable, it waits
2, 5, 10, then 10 minutes between failure detection and the next retry,
forever. A ready backend resets the failure count and backoff. Reopen
history spans recovery so repeated crashes can still be detected. One
Telegram attention alert reports three consecutive failed reopens, and one
reports more than four reopens in an hour. Ordinary reopens are silent.
An `open` exit status of zero does not prove launch or readiness: silent no-ops
consume the same failed-reopen budget while backend health stays unavailable.
Four consecutive check errors with readiness unavailable or unknown queue one
attention alert per error episode. A successful check ends that episode; errors
still reset the consecutive-unready observation window without selecting a target.
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
lives, up to **30 minutes from startedAt**. Heartbeats and restarting a missing
beater cannot extend that deadline. Reusing an expired cycle is refused until
the owner stops it; a subsequent install cycle obtains a new hold. `beat --by NAME --pid PID` updates a matching hold; `stop` removes only
a matching hold and terminates its verified beater. Concurrent live owners
are refused, including nested children trying to replace an expired live parent's
cycle. A delayed beat can resume before the creation deadline, without moving it.
An old beater cannot update a replacement hold.

A hold counts only when its PID lives, creation is less than 30 minutes old,
and its beat is less than 90 seconds old (missing, nonnumeric and future
timestamps are invalid). At the age limit the beater stops and the guard
ignores the hold even if its owner and heartbeat remain alive. Stale/dead holds are logged and left in
place, and do not prevent reopening. Install holds reset the down count.

The cutover scripts source `scripts/install-hold.zsh` before their first quit.
It shares a verified parent hold across nested scripts and uses `zshexit`,
so existing mount-cleanup EXIT traps still run. The release installer uses
`apps/desktop/scripts/robob-install-hold.mjs` around the whole install and
failure-relaunch window. If the deployed helper is missing, scripts warn and
continue: **the guard may then reopen Robob mid-install**. Any other hold
acquisition failure aborts before quitting.

After any quit, the release installer releases its hold only when authenticated
health succeeds (and, after a swap, a new boot identity is present). A failed
launch, readiness timeout or failed fallback relaunch keeps the installer alive
with its heartbeat beyond the attempt timeout, but only until the hold age cap. Its recovery log and one attention
alert request repair or compatible rollback from another Terminal. Finish repair or rollback within that cap: once it expires the guard can
recover the app independently. Keep the
owner running and pass its logged `holdBy`/`holdPid` as `ROBOB_INSTALL_HOLD_BY`
and `ROBOB_INSTALL_HOLD_PID` to a rollback. Recovery preserves the original
failure exit code. The external supervisor must gate both successful and failed
child exits, including exhausted retries; see `release-supervisor.md`.

If the legacy before-launch hook returns 70 (files could not be restored),
the installer stays alive while waiting for manual repair and a healthy Robob,
but its hold still expires at 30 minutes. Keep that installer running until repair is done.
Killing it or reaching the age cap ends its hold-off and the guard can reopen Robob.

## State and installation

State, log, locks and beater identity live in `~/.local/state/robob-guard/`:
`state.json`, `guard.log`, `check.lock`, `hold.lock`, `hold-beater.json`.
The log has one UTC line per check (`up`, `down n`, `hold:NAME`, or
`stale-hold:NAME` plus the action). Over 1 MiB it trims to the last 2000 lines.
Unready and check-error rows include the LaunchServices PID, its liveness, and up
to five other Robob-executable processes (PID, PPID, first 160 argument characters).
Check-error rows also name the failing step and consecutive error count. Diagnostic
read failures appear in the row and do not change the recovery decision.
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
