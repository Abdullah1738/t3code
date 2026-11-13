# Mac upkeep logs

Source scripts use `toollog.py` (or the `toollog.sh` bridge) for local metadata at
`~/.robob/logs/tools/mac/YYYY-MM-DD.ndjson`, with UTC dates. Run
`mac-log-rollup --day YYYY-MM-DD` to write `rollup-YYYY-MM-DD.json`; with no day,
it rolls up yesterday. Quantiles use nearest rank. `okRate`/`failedRate` use
lines with an explicit `ok`; `errorRate` is the share of error-kind lines.

The collector reads DiagnosticReports and a filtered `log show`, retaining a
separate cursor per source so an unavailable source is retried. Its first run
looks back one hour. Report cursors cover since their last successful read.
Unified-log queries cover at most the most recent hour; skipped older time is
explicit in `skippedS`. A failed query retains the exact bounded window for retry,
and success advances its cursor to that window end.
It rolls up yesterday on the first hourly run after 00:05 UTC. It writes only
its own state, day logs, rollups and probe samples, and never changes crash evidence.

Disk samples use `statvfs`, sizes of the known Robob/OpenCode/recall database
and WAL files (metadata only), the guard's cached TMPDIR measurement, and an hourly cached directory inventory of worktrees, caches and backup repositories.
The collector gathers directory sizes with read-only du calls outside the guard,
allowing up to 60 s per root under a shared 210 s scan budget. The two big
roots (`~/.local/share` and `~/.robob`) run first, one first-level child at a
time with a 15 s child timeout. Each root gets at most 60 s. The collector
also limits the scan to the time remaining in its five-minute run budget,
reserving 65 s for crash collection after the existing disk tooling probe. Samples expose
`inventorySourceErrors`, `inventoryAgeS` (null if absent), and `inventoryStale`
(absent or older than two hours). These do not affect the sample's own success.
The five largest positive deltas in that tracked set are flattened as
`grower1Path`/`grower1DeltaGb` through `grower5…`. `baseline=1` means no prior
sample; `count=0` means no known positive growth, not a full-disk scan. GB is
1024³ bytes, matching the guard's existing units. This avoids a recursive scan
inside the guard. Snapshot age refers to the last completed restic snapshot,
including one whose subsequent Dropbox mirror failed; unknown counters/age
are omitted rather than reported as zero. A restic exit code of -1 means it
was not reached. Fix versions use the sweep's known version transition or
local package metadata; unavailable versions are `unknown`.

## Source events

`disk.inventory` and `crash.collect` retain `count` and `sourceErrors` summary
counts. Each unavailable source also emits an error-kind `disk.inventory.source`
or `crash.source` with `source` (root path or `unified`), `failure` (`timeout`,
`exit`, `permission`, `parse`, `missing-total`, or `partial`), `exitCode` (null when no
exit code is available), and `elapsedMs`. Budget-exhausted roots get their own
timeout line without launching another command. Missing inventory paths are skipped.

Only these source errors accept a diagnostic `error.message`: the first stderr
or filesystem-error line, trimmed to 300 characters with credential-like text
redacted. No du stdout, unified log messages, report contents or arbitrary
exception text is logged. Parse failures use fixed messages. Commands use the
C locale so permission diagnostics can be identified consistently.

A completed du that exits 1 solely because of unreadable entries still supplies
a usable root total. That source emits a successful event with `partial=true`
and `deniedCount` plus the readable `bytes`; the cached inventory retains those flags in `partials`.
Other exits and timeouts do not supply usable du totals. A partial total measures
only readable entries; permission grants remain an owner action.

Big roots emit child source events with `bytes`, `exitCode`, `elapsedMs`,
`partial`, and `deniedCount`, plus a root aggregate with `completedCount` and
`failedCount`. Child timeouts/errors remain named source errors. An incomplete
root emits an error with `failure=partial`, `partial=true`, and the completed
children's `bytes` as a lower bound. `failedCount` includes one additional
incomplete remainder when the root deadline stops enumeration; it is not a
count of every unvisited child. Summing child du totals does not deduplicate
hard links across children and excludes the root directory's own blocks.
Missing totals are never replaced with an old total, even within 24 hours.
If every child fails, the root has an error and no cached size. Inventory state
retains completed child sizes in `children` and aggregate flags in `partials`.
Summary `sourceErrors` counts affected roots, not their child error lines.
Partial roots are excluded from growth comparisons on both sides, so changing
scan coverage cannot become a reported grower.

`disk.sample` reports success when its own measurements succeed; cached inventory
errors or staleness are metadata rather than sample failures. Its `sourceErrors`
still counts failures of its own free-space and existing-file stat measurements.
Missing optional database/WAL files are skipped. The filtered unified-log query
has a one-hour maximum window and a timeout of at most 60 s, shortened to the
collector's remaining absolute budget. Its source event/error and
`crash.collect` record `windowStart` and `windowEnd` (Unix seconds), `windowS`,
and `skippedS` (older time omitted by the cap). On failure, `unifiedRetry`
retains the exact window until it succeeds; then the cursor advances to its end.

Report sources have independent checkpoints. Each attempt allows up to 10 s per
source, capped by the collector's absolute deadline. Directory enumeration,
stat calls and the small IPS header read are interrupted at that deadline with
a scoped Unix alarm. The alarm is cancelled before updating counts or marking
a filename complete. A timeout emits a named `crash.source` error with
`partial=true` when work has completed, while completed crash counts are still
emitted. `<source>Pending` state holds the frozen start/end and completed
filenames (metadata only); retries skip those filenames, retaining progress
without counting them again. The source cursor advances to that window's end
only after enumeration completes. Reports arriving after that end remain for
the next window. Healthy sources continue independently.

`collector.main` sets a 290 s absolute work deadline, leaving ten seconds for
state/log overhead within five minutes. Report work, the log query and daily
rollup share that deadline; no log command starts once the budget is exhausted.

## diskutil hangs

Each hourly collector run emits `disk.tooling_probe`: a 20 s `diskutil list
-plist` check, daemon PID/uptime/state, and a 10 s `hdiutil info` control.
`storagekitdPid` and `storagekitdUptimeS` are numbers when available; both are
omitted if `ps` cannot read them within 3 s.
A timeout records `blockedIn` and a private sample path under the log's
`state/diskutil-samples/` (retained for 7 days). Sampling has a separate
15 s budget before the child is killed and reaped. A PID marker and a run lock
prevent overlapping probes; a surviving child produces a skipped event.
Daily rollups include `diskTooling` probe/timeout counts, max duration and the
latest blocking frame. Skipped events do not count as attempted probes.

Two consecutive timeouts for the same storagekitd PID trigger one Telegram
attention alert; failed sends retry on the next timeout or surviving-child
skip using the same key and message. Success resets
the consecutive count. A StorageKit wait means storagekitd isn't answering.
First run `sudo killall storagekitd`. If `diskutil list` still times out after
10 s, run `sudo kill -9 <pid>` using storagekitd's PID from the alert. The alert
also includes its uptime. If the PID is unavailable or has changed since the
alert, read the current one with `ps -axo pid,etime,comm` before using it.
launchd respawns storagekitd on demand. The collector never runs `sudo` or
daemon kill commands, restarts daemons, or changes mounts.

On 13 Nov 2026, `sudo killall storagekitd` returned 0 but pid 80846 (up 17 h
52 m) ignored SIGTERM. `sudo kill -9 80846` cleared it; launchd restarted
storagekitd and `diskutil list` improved from an 8 s timeout to 0.04–0.74 s.

## Install after review and owner approval

All scripts refuse dirty upkeep source or HEAD absent from origin/main. No
installer starts or restarts any service. Install the helper first:

```sh
zsh integrations/mac-logging/install.zsh
zsh integrations/cve-sweep/install.zsh
zsh integrations/health-backup/install.zsh
zsh integrations/mac-logging/install-jobs.zsh
```

Each accepts `--dry-run` or `--check`. The final installer updates only the
memory backup, disk check and two janitor scripts, retaining timestamped
copies. This avoids deploying unrelated integration changes or skill wording.
The helper installer writes the proposed
`com.abdullah.mac-log-collector.plist`; the evaluator must separately load it
after approval. Existing job schedules and backup LaunchAgents stay in place.
The jobs fail open if the helper is missing.

## Fixture checks

```sh
offbox run -- 'PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/mac-logging/tests -v && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/dev-resource-janitor/tests -v'
```

Tests use private temporary roots and mock commands. Never use a real upkeep
run to test instrumentation: those jobs can remove software, kill processes,
prune snapshots and send alerts.
