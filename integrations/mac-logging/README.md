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
explicit in `skippedS`. Queries run in 15-minute chunks, checkpointing the cursor
after each completed chunk. A failed query retains the unfinished suffix for retry.
Boot observations include `observedAt` (Unix seconds) for the boot marker; duplicate
markers at the same instant count once. Other observations remain aggregated.
It rolls up yesterday on the first hourly run after 00:05 UTC. It writes only
its own state, day logs, rollups and probe samples, and never changes crash evidence.

Disk samples use `statvfs`, sizes of the known Robob/OpenCode/recall database
and WAL files (metadata only), the guard's cached TMPDIR measurement, and an hourly cached directory inventory of worktrees, caches and backup repositories.
The collector scans immediate children independently with `du -skl`, in batches
of at most 128 paths / 32 KiB of arguments. Its 15 s allowance grows to 60 s
for slow children. Completed children stay cached for 24 hours; missing and
stale children get the hourly inventory's remaining time, up to 210 s within
the collector's 290 s deadline. Crash collection runs first.

A separate `com.abdullah.mac-deep-inventory` LaunchAgent runs daily at 03:30
local time (Asia/Dubai on this Mac). It starts with the four SSD worktree farms
and checkpoints the next root to visit, so interrupted passes rotate fairly.
Cheap batches can share a turn; known timeouts follow healthy discovery and
refresh work. Unknown children get a 15-second probe; a batch deadline falls
back to individual probes. A timed-out child is split into immediate entries,
with each completed part checkpointed and at most ten minutes per child per
pass. The child has no total until its listing and every part are complete
and fresh; its own directory allocation is included. Parts do not recurse.
The hourly scanner leaves unfinished parts and recent timeouts to this pass.
The daily budget is 90 minutes; du runs under nice 10
and utility scheduling without inherited launchd background I/O policy.
Termination keeps completed rows; unfinished children remain explicit partials.
Both entry points acquire `state/disk-inventory.lock` non-blocking. A busy
daily pass exits cleanly; a busy hourly scan logs `skipReason=deep_pass_running`
and cached totals while crash collection continues. `disk.deep.start`,
`disk.deep.root`, `disk.deep.parts` and `disk.deep.end` record coverage, ages,
timeout time, parts progress and stop reason.
`childrenRemaining` counts known eligible children; `rootsPartial` on pass
summaries counts roots whose listing was unavailable, so zero remaining with
unlisted roots is not complete coverage. All totals count hardlink occurrences,
can exceed physical use, and are not freeable-space estimates.

Samples expose
`inventorySourceErrors`, `inventoryAgeS` (null if absent), and `inventoryStale`
(absent or older than two hours). These do not affect the sample's own success.
The five largest positive deltas in that tracked set are flattened as
`grower1Path`/`grower1DeltaGb` through `grower5…`. `baseline=1` means no prior
sample; `count=0` means no known positive growth, not a full-disk scan. GB is
1024³ bytes, matching the guard's existing units. This avoids a recursive scan
inside the guard. Snapshot age refers to the last completed restic snapshot,
including one whose subsequent Dropbox mirror failed; unknown counters
are omitted rather than reported as zero. A restic exit code of -1 means it
was not reached. Fix versions use the sweep's known version transition or
local package metadata; unavailable versions are `unknown`.

Every `backup.run` includes `trigger` and `lastGoodSnapshotAgeS`. The latter
comes from a lock-free restic snapshot query, even on admission skips. On probe
failure, memory backups fall back to the status file's last successful backup
time; unavailable ages remain null. `lastGoodSnapshotSource` identifies `restic`
or `status_file`, and `lastGoodSnapshotError` retains a fixed probe error. The probe
uses an inherited password or the target's fixed Keychain entry, never a supplied
password command/file, with one second for Keychain and three for restic.
Lock skips include holder parent PID, elapsed process age, and a command reduced
to a known executable and first argument; other arguments are redacted. Ancestry
supplies a best-effort holder trigger, including `agent`; unavailable details are
null/unknown. A proven missing PID becomes `stale_lock`. No lock is changed.
Nonzero exits are failures with `failedStage` and `failReason`, including failure
reasons passed through the legacy skip argument. Lock and load/boot deferrals
retain their skip behavior. Memory failure stages use only fresh status metadata;
unavailable stages are `unknown` and unrecognized stages are `other`.
The memory-backup emitter sends `failureStage` on `backup.run`: `admission`, `stage`, `repo`, `disk`, `replica`, `verify`, `files`, `restic`, `prune`, `dropbox`, `manifest`, or `unknown`; other strings become `unknown` and non-strings are omitted.
Daily rollups count `backup.skipped_runs`, `backup.ok_runs` and `backup.failed_runs` by target;
`log.rollup` flattens them as e.g. `backup.skipped_runs.memory`. Healthy lock
skips count only as skips.

Samples also include `internalFreeGbDelta`/`externalFreeGbDelta`, compared with
each volume's last numeric measurement even across failed samples.
`internalDeltaFromTs`/`externalDeltaFromTs` and the matching `DeltaWindowS`
give each comparison's window; `deltaFromTs`/`deltaWindowS` use the internal
comparison when available, otherwise external. Unknown deltas are null with a
`deltaUnavailable` reason. Legacy state recovers missing numeric baselines from at
most 1 MiB of each of today's and yesterday's logs; missing or corrupt state
starts a tagged baseline instead. Samples also include optional `internal`/`external` `PurgeableGb` and
`LocalSnapshotCount`. Four read-only diskutil/tmutil calls run concurrently
under one five-second budget, including cleanup. Missing purgeable keys are
`PurgeableError=unsupported`, never zero; command failures carry short error
enums and omit the unavailable number. Snapshot names and volume labels are
discarded. A timed-out batch emits one `disk.probe_slow`; an already eight-second
sample skips probing. A lock inherited by probe children prevents accumulating
processes if a kernel wait survives SIGKILL.

`topMover1Path`/`topMover1GbDelta` show the largest absolute tracked size change,
including shrinkage. Movers require fresh inventories in both samples and
exclude partial totals. Confirmed missing tracked roots and database/WAL files
are recorded as zero, so creation and deletion contribute to mover deltas.
An unavailable backing mount, failed reads and older states without an explicit
measurement remain unknown; an omitted path is never assumed to be zero.
Changes of at least 20 GB on either volume emit one
`disk.swing` event with `previousTs`, `sampleTs`, both free-space deltas and up
to three flattened `topMover` pairs. These events never alert. The inventory is
hourly and covers selected roots, so movers are evidence of tracked changes,
not a complete accounting of each free-space delta.

A volume losing more than 10 GB since its last numeric sample emits one
`disk.drop` with its delta, window, purgeable space and local snapshot count
(null when unavailable). Its five `grower…Name`/`grower…Bytes` pairs are positive
directory growth from the existing inventory: immediate directory children of
the two big roots, or the other tracked roots. File entries and deeper names
are excluded. Fresh, fully measured child directories remain useful evidence
when their parent scan is partial. `inventoryComplete=false` explicitly marks
missing, stale, partial or reused inventory on either side; stale or reused
snapshots supply no growers. A newly created child directory has a zero baseline
only when a prior complete parent entry set proves that path was absent.
Partial inventories and older snapshots without that evidence remain unknown.
An unknown directory baseline also makes the event incomplete.
These events never alert or launch extra scans.

## Memory samples

`com.abdullah.mac-memory` runs `memory.py` every 300 seconds independently of
inventory, through `/bin/zsh` for launchd file access. `memory.sample` contains
swap MB, VM page counts and page size, pressure/free percentage, load averages,
the top 15 footprints with compressed MB, watched daemons with elapsed time,
process/parent-1 counts, and disk0's second iostat sample. MB/GB use powers of
1024. `top` MEM already includes compressed pages. A filtered second top reads
watched PIDs outside the first 15. At most 512 watched PIDs are queried; excess
is explicit in `watchedOmitted` and makes the sample partial. Each subprocess,
including notifications, has a ten-second timeout. Failed probes are null with
fixed `…Error` codes; watched PID failures retain null metrics per PID.

`state/memory.json` retains swap counter baselines and alert receipts under a
separate nonblocking lock. `swapinsDelta`/`swapoutsDelta` compare successful reads
on the same boot, with `deltaWindowS`; first reads, resets, gaps over an hour and
clock rollback establish a null baseline. Missing/failed probes remain unknown.
No process arguments, command output or notification text enter the day log.

Swap above 16 GB, critical pressure in two consecutive samples, a footprint
above 8 GB, or fseventsd above 4 GB queues a Telegram notification and writes
`memory.alert`. Critical means `vm.memory_pressure >= 2` or free percentage
below 15; unavailable/healthy samples or gaps over ten minutes reset the streak. Each reason has a six-hour cooldown
across day boundaries. Keys start `mac-memory:<reason>:<YYYYMMDD>` with a time
suffix so another alert can be queued after six hours on the same day. An
unconfirmed send retains its exact key/text for idempotent retry. For a diagnostic
sample without notifications, run `TOOLLOG_DIR=<private-temp-dir> /usr/bin/python3
integrations/mac-logging/memory.py --no-alert`.

## Source events

`disk.inventory` and `crash.collect` retain `count` and `sourceErrors` summary
counts. Each unavailable source also emits an error-kind `disk.inventory.source`
or `crash.source` with `source` (root path or `unified`), `failure` (`timeout`,
`exit`, `permission`, `parse`, `missing-total`, or `partial`), `exitCode` (null when no
exit code is available), and `elapsedMs`. Budget-exhausted roots get their own
timeout line without launching another command. Confirmed missing inventory
paths retain a zero total without a source error.

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
root emits an error with `failure=partial`, `partial=true`, and the available
children's `bytes`. The aggregate includes only recorded child measurements. `failedCount` includes one additional
incomplete remainder when the root deadline stops enumeration; it is not a
count of every unvisited child. Summing child du totals does not deduplicate
hard links across children and excludes the root directory's own blocks.
Root attempts rotate oldest first, with never-attempted roots ahead of measured
ones. Budget-skipped roots retain their place; full failed attempts rotate too.
Shortened failed attempts keep priority for a full allowance on the next run.
`disk.inventory.turn` identifies each attempted root's `source` and `turn`.
Child attempts rotate the same way. A failed child retains its last good size
and timestamp in `childState`; missing, stale or unreadable children keep the
root partial. `cachedCount` and `ageS` describe retained measurements.
If every child fails without a last-good measurement, the root has no size.
Inventory state retains child sizes in `children` and aggregate flags in `partials`.
Summary `sourceErrors` counts affected roots, not their child error lines.
Partial roots are excluded from growth comparisons on both sides, so changing
scan coverage cannot become a reported grower.

`disk.sample` reports success when its own measurements succeed; cached inventory
errors or staleness are metadata rather than sample failures. Its `sourceErrors`
still counts failures of its own free-space and existing-file stat measurements.
Confirmed missing optional database/WAL files retain zero sizes. The filtered unified-log query
has a one-hour maximum window, split into contiguous 15-minute chunks under a
shared 135 s budget, allowing four chunks at the observed 30 s cost plus headroom.
Each command has at most 60 s, shortened to that shared
budget and the collector's remaining absolute budget. Its source event/error and
`crash.collect` record `windowStart` and `windowEnd` (Unix seconds), `windowS`,
`skippedS` (older time omitted by the cap), `chunks` (planned for this attempt),
and `chunksDone`. Each completed chunk emits its observations and saves its cursor
before the next command. The next chunk excludes that cursor's instant, including
when log's second rounding/end padding returns overlapping rows. Missing or invalid
event timestamps fail the chunk rather than risk attributing events twice.
On failure, `unifiedRetry` retains the exact unfinished suffix until it succeeds;
completed chunks are not queried again. An old one-hour retry is split the same
way. Chunk checkpoints retain unreported `skippedS`, including after the final
chunk, so interruption before the source result cannot hide a coverage gap.
Once the source result reports the gap, a retained suffix clears that metadata.
After a delayed retry completes, the next run applies the recent-hour cap
again and reports any omitted older time in `skippedS`.

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
IPS headers are read as at most 4096 bytes before decoding, so invalid body
bytes cannot break a valid header. Unreadable or malformed files are skipped
individually; each report source logs `unreadableCount` without file contents.

`collector.main` sets a 290 s absolute work deadline, leaving ten seconds for
state/log overhead within five minutes. Crash collection has at most 165 s for
three 10 s report sources, the shared 135 s log budget, and daily rollup. The disk
wait check follows with at most 45 s for ps and alerts, shortened to the remaining
absolute budget. The disk tooling probe follows, then inventory uses what remains.
No log command starts once its shared budget is exhausted. No live configuration
or schedule change is needed for this order.

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

## Processes stuck in disk wait

Each hourly run emits `proc.disk_wait` from a read-only, 10 s-bounded
`ps -axo pid,ppid,etime,stat,comm,args`. It counts processes observed in
`U` with a process age of at least ten minutes, retaining the ten oldest
(`pid`, `ppid`, `ageS`, `stat`, `comm`, `args`). Arguments are limited
to 300 characters, with credential-like values redacted; no environment
is logged. `stuckUnmount` and `mountPoint` flag an unmount among all matches,
even if it is outside the ten retained entries. A failed ps records an error
without stopping the other collector sources.

Process age is not time continuously spent in U: this is an hourly observation,
and an old process can be caught during normal I/O. An umount aged at least
30 minutes, or another process aged at least six hours, triggers one Telegram
attention alert per PID/start time. A bounded ps start-time lookup prevents
PID reuse from suppressing a new incident. Failed notifications retry with
the same key and frozen text; they never fail collection. The shared 45 s disk-wait
budget defers remaining alerts to the next run when notifications are slow.
Daily `diskWait` rollups give runs with matches, maximum process age, and
the latest stuck-unmount mount point.

A kernel-stuck unmount can block the stat child of plain lsof, even for an
unrelated APFS file, and may also affect diskutil. While a U-state umount
exists, use `lsof -b -w` with a subprocess timeout, preferably selecting
a PID. It skips stat/lstat/readlink, so pathname queries may return
'Resource temporarily unavailable'; missing output does not prove a file
has no holders. A reboot clears a stuck umount. The collector only reports
it and never changes mounts or restarts the Mac.

## Install after review and owner approval

Installation and checks refuse dirty upkeep source or HEAD absent from origin/main.
`--dry-run` can describe a proposed branch without installing it. No
installer starts or restarts any service. Install the helper first:

```sh
zsh integrations/mac-logging/install.zsh
zsh integrations/cve-sweep/install.zsh
zsh integrations/health-backup/install.zsh
zsh integrations/mac-logging/install-jobs.zsh
```

Each accepts `--dry-run` or `--check`. The final installer updates only the
disk check and two janitor scripts, retaining timestamped copies.
Memory-system belongs to the Recall board and is deployed from
`robob/recall-golive`; send changes there as port requests. This installer
refuses targets under `~/.local/share/memory-system`.
The helper installer writes the proposed
`com.abdullah.mac-log-collector.plist` and
`com.abdullah.mac-deep-inventory.plist`; the evaluator separately loads them
after approval. Existing job schedules and backup LaunchAgents stay in place.
The collector starts via `/bin/zsh` because launchd attributes Full Disk Access to the job's own program.
The jobs fail open if the helper is missing.

## Fixture checks

```sh
offbox run -- 'PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/mac-logging/tests -v && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/dev-resource-janitor/tests -v'
```

Tests use private temporary roots and mock commands. Never use a real upkeep
run to test instrumentation: those jobs can remove software, kill processes,
prune snapshots and send alerts.
