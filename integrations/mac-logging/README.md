# Mac upkeep logs

## Suspension leases

Every upkeep SIGSTOP needs a durable deadline and a follow-up. Use an explicit
`--deadline 10m` (recommended; required, maximum 60m) and `--then cont|kill`:

```sh
mac-suspend stop --pid 123 --deadline 10m --then cont --reason 'resource pressure' --actor 'mac worker' --card '#118'
mac-suspend list --json
mac-suspend resume --pid 123
mac-suspend kill --pid 123
mac-suspend sweep --json
```

The ledger is `~/.robob/logs/tools/mac/state/suspend-lease.json` (or beneath
`TOOLLOG_DIR/state`), locked across each operation and fsynced before SIGSTOP.
Every signal rechecks pid + start time and records a read-back. Resume and kill
require an owned lease; kill sends TERM, waits five seconds if still alive,
then sends KILL. Failed recovery retains the lease for the next sweep.
PID reuse drops the old lease without signalling its replacement. System,
Robob, provider and GUI processes are protected. The tool never signals
unowned stops, including debugger stops and Ctrl-Z jobs.

`com.abdullah.mac-suspend` runs a separate sweep every minute, with a 50-second
whole-run limit and bounded ps/launchctl calls. `install.zsh` copies the helper,
wrapper and plist; the evaluator loads the LaunchAgent after review.
Subprocess timeouts are centralized in `TIMEOUTS` (ps 8s, protection list 5s, owner list 3s, procinfo 2s, notify 5s), only the stopped-process listing retries once, and timed-out calls log `cmd`, `timeoutS`, `elapsedMs` and `loadAvg1` on `suspend.error`.
`mac-log-status` checks its launchd state and three-minute logging cadence.
Events use toollog: `suspend.stop`, `suspend.stop_failed`, `suspend.resume`,
`suspend.kill`, `suspend.expired`, `suspend.cleared`, `suspend.orphan`,
`suspend.alert`, `suspend.sweep` and `suspend.error`. Orphans log at first sight
and once after ten minutes of observation. The latter and failed kills queue
one Telegram attention alert per pid + start; uncertain delivery retries use
the same key and text. Agent prompts and the janitor rule are updated separately
after owner approval.

Source scripts use `toollog.py` (or the `toollog.sh` bridge) for local metadata at
`~/.robob/logs/tools/mac/YYYY-MM-DD.ndjson`, with UTC dates. Run
`mac-log-rollup --day YYYY-MM-DD` to write `rollup-YYYY-MM-DD.json`; with no day,
it rolls up yesterday. Quantiles use nearest rank. `okRate`/`failedRate` use
lines with an explicit `ok`; `errorRate` is the share of error-kind lines.

Each hourly collector run emits `homebrew.integrity` with dangling opt links,
missing dependencies, status and duration. Formula runtime dependencies are
checked from linked Cellar receipts without starting Homebrew; unreadable or
absent receipts are counted in `receiptErrors`. The read-only `brew missing`
secondary covers casks too, runs at nice 15, has a 240-second timeout and
disables auto-update and analytics. Broken results send a Telegram attention
alert with a stable key for that exact set of links
and dependencies; unchanged failures are not sent again. A secondary failure
is logged in `brewError` and cannot suppress a finding. A completed local scan
without findings is `ok`; `error` means no check completed. Repairs are
suggested, never run by the collector.

Run `mac-log-status` for last-seen times, ages, last outcomes and overdue jobs,
or `mac-log-status --json` for the same report as JSON. `--now ISO` freezes the
cadence clock (include `Z` or an explicit UTC offset); launchd checks always
describe the current state. The command exits 1 for overdue jobs, unreadable
input (including invalid timestamps) or a launchd state other than `loaded`,
and 2 for invalid option syntax.
JSON includes an overall `ok` boolean and `launchd`, mapping each of
`com.abdullah.mac-log-collector`, `com.abdullah.mac-deep-inventory`,
`com.abdullah.mac-memory`, `com.abdullah.mac-cpu`, `com.abdullah.mac-ssd-read-probe`
and `com.abdullah.mac-guard` to `loaded`, `not-loaded`
or `unknown`. Each read-only `launchctl print gui/<uid>/<label>` has a two-second
timeout per label. Only an explicit
`Could not find service` error means `not-loaded`; other failures are `unknown`.
Status never loads or restarts agents, and does not send notifications.
It reads the UTC day files covering the last 36 hours (three files before noon
UTC, two from noon onward). Missing and unreadable files are listed separately.
Malformed rows, including invalid timestamps and dates that overflow when
converted to UTC, are skipped and counted. Future timestamps are ignored.
It contacts no external services and creates no files or locks. The live guard
worker check uses one bounded local `t3ctl status` request.

The single cadence table is `CADENCES` in `status.py`, with schedule sources
beside each row. Logging applies from 13 Nov 2026 UTC. Maximum gaps are two
hours for disk sampling (guard every 30 minutes), inventory and crash collection
(hourly collector), and janitor (hourly watcher); seven hours for health backup
(every six), five hours for memory backup (every four), and 26 hours for the
daily CVE sweep (09:00 Dubai / 05:00 UTC).
The hourly collector's tooling, process-wait and clone-wedge probes also allow
two hours. `memory.sample` runs every five minutes and allows 15 minutes;
`cpu.sample` runs every minute and allows three minutes, from 15 Nov UTC;
`disk.deep.end` completes the daily 03:30 Dubai pass and allows 26 hours.
The memory, deep-pass and clone-wedge rows apply from 14 Nov UTC, when they
first logged; the others apply from 13 Nov. Alerts and conditional detail
events do not have independent cadence rows.

`LATE` means the last line is older than the maximum gap. `SILENT` means that
gap has elapsed and there is no matching line in the available 36-hour window.
Before logging applies a row is `PENDING`; after that it gets one maximum gap
of startup grace. A failed or skipped run still proves the job ran: `lastOk`
reports the last line's boolean outcome (null if omitted), independently of
cadence. Backups match `props.target` exactly (`health` or `memory`).
An on-cadence `backup.failed_<stage>` line with `ok=false` and `skipped=0`
sets `lastSeen` and `lastOk=false`; it is a failed run, not a skip. The separate
daily `backup.failed_runs` counters count those same failed runs by target.

Daily rollups add `jobs` and `missingJobs`, leaving all existing keys intact.
The jobs view is frozen at the end of the requested UTC day and reads that day
and its predecessor, capped to 36 hours. Each job has `lastSeen` (normalized
UTC), `lastOk`, `lines` (matching lines in that window), `ageMin`, `gapMaxMin`,
`since`, and `status`. `missingJobs` contains the `LATE` and `SILENT` job keys;
backup keys are `backup.run:health` and `backup.run:memory`.

Each row includes the exact `kern.boottime` epoch and UTC `bootTime` when
available. The minute CPU sampler and hourly collector share a nonblocking boot
lock. Each newly seen boot is saved immediately, including its kernel reason
strings; a second reboot during the evidence wait leaves it queued for finalization.
After the ten-minute panic-file window closes, `boot.observed` records
the previous boot, the last prior sample's uptime, the gap from the last prior log row,
ResetCounter faults/failure count, panic and shutdown-stall reports within ten
minutes of boot, and Jetsam reports in the preceding two hours. Missing evidence
remains null or carries a per-field source error. The gap measures logging silence; it does
not establish how long the Mac froze.

A clean boot requires the adjacent shutdown record from `last -y reboot shutdown`
and no positive panic/reset-fault evidence. A shutdown-stall report records a
slow orderly shutdown; its presence alone does not make the boot unclean.
The record includes the requested operation, loginwindow sender PID/bundle and
confirmation time, launchd's caller chain, sessionlogoutd's non-update verdict,
and the raw `kern.shutdownreason`/`kern.bootreason` values from that same boot.
The sender identifies a process; the human or automation activating the request
remains unknown. A `wdog,reset_in_1` token alone does not establish an unclean
boot or a forced watchdog timeout; `forcedWatchdogTimeout` stays null without
explicit timeout/check-in-failure evidence. Shutdown-stall files are decoded
with `spindump -i` on a private copy to obtain the actual sample start/end;
the filename timestamp (or mtime when absent) matches reports to boots. The
native decoder appends input metadata, so the original file is never passed
to it. Decode failures preserve presence and a source error.
#92 found no numeric shutdown cause on this Apple-silicon host; any future numeric code is retained as unmapped,
without Intel cause tables. Filtered unified-log queries cover the three minutes
before boot for shutdown context and the first three minutes after boot for
shutdown cause, using the shared `logwindow` reader with explicit UTC bounds,
reboot splits, a 15-second process-group deadline and timestamp filtering.
The post-boot read starts at the first whole second at or after boot.
ResetCounter uses plain reads, without sudo. Observations are
timestamped at boot (`observedAt` records collection time), persisted once per
boot and survive the daily log cap. Unclean boots and orderly shutdown stalls queue one
Telegram alert with a stable boot key; failed sends retry that same key/text,
even across later boots. Unfinished observations remain in a persistent queue;
each invocation retries one queued boot alongside the current boot. A late
append to an earlier UTC day rebuilds that day's rollup and publishes updated
`log.rollup` counts with its `day`; failed repairs remain queued. Rollup writers
share a per-day lock so an older snapshot cannot overwrite a repair.
CPU process, host-tick and child baselines reset on boot changes. Rollups add
`boots` and `uncleanBoots`, also emitted in `log.rollup`.

The collector reads DiagnosticReports and a filtered `log show`, retaining a
separate cursor per source so an unavailable source is retried. Its first run
looks back one hour. Report cursors cover since their last successful read.
Unified-log windows cover at most the most recent 90 minutes, including retries;
older time is skipped with exact `skippedS` and reason `lag_ceiling`. Queries start
with 60 seconds of log and grow after successes. Two successful sizes estimate
fixed startup cost separately from window work. Queries normally target 10 seconds
of window work, increasing that target to amortize significant startup cost within
the command deadline. Queries usually cover at most 15 minutes; startup-dominated
reads may grow to the 90-minute ceiling. When the budget allows, a nominal-size
probe checks window cost before a large jump. Accelerating marginal cost keeps
queries within 15 minutes for the rest of the run. Each completed chunk checkpoints its cursor. A
failed query retains the unfinished suffix, then continues into a fresh window
when that suffix finishes. Each command has a 60-second cap including bounded
process-group cleanup; the unified source shares a 135-second budget.
Queries use UTC input as well as output. A shared boot helper reads current
`kern.boottime` and `last -y reboot` with two-second command timeouts. Because
`last` prints only minutes, a bounded Darwin wtmp reader refines matching
historical boots to seconds. If a known boot cannot be refined, both readers
skip that entire minute: `crash.source` reports `reason=bootUnresolved` and
`skippedS`, and mac-log-window reports the same reason with `status: partial` (exit 2). Other
intervals keep running; no query is sent into the unresolved minute.
Chunks stop at boot seconds with no end padding across a boot. The shared
planner also isolates the following second: macOS accepts only whole-second
query bounds, and starting at a rounded boot second can still select the old
epoch. The boot-second piece gets at most 10 seconds per attempt. It remains pending
on failures one and two; failure three explicitly skips it with `crash.source`
`reason=bootSecondUnreadable` and `skippedS`, rather than retrying indefinitely.
The attempt count is durable. The following piece starts safely one second
later and its completed rows are not read again. mac-log-window also caps each boot
second at 10 seconds and labels any unfinished result partial. Failed pre-boot
intervals remain in `unifiedBootPending` while later boot intervals can finish.
A frozen retry ending before a newer boot is retained as a hole rather than
blocking fresh coverage. Hole retries reserve one full call for fresh data.
Clipping holes at the moving ceiling is checkpointed before retry I/O, with
unreported skips retained separately. Completed unified observations are queued
with their cursor checkpoint; a fixed log day and `observationId` make replay
idempotent under the daily log's writer lock. Deferred gap records also keep
a fixed identity and day until delivery is checkpointed. Writes handle short
write counts; replay acknowledges only complete, valid matching records. The identity check reads that day's
file in 64 KiB blocks only for these observations (no raw message storage).
Each completed retry prefix is checkpointed; these holes obey the same moving
90-minute ceiling and explicit skip records as the normal suffix.
`crash.unified.chunk` records requested bounds, elapsed time and outcome;
`crash.unified.skip` records ceiling skips before advancing the cursor. Positive
skip records and summaries survive the daily log cap so omitted time stays explicit.
`crash.collect.stopReason` distinguishes completion, deadline and command failure.
Boot observations include `observedAt` (Unix seconds) for the boot marker; duplicate
markers at the same instant count once. Other observations remain aggregated.
It rolls up yesterday on the first hourly run after 00:05 UTC. It writes only
its own state, day logs, rollups and probe samples, and never changes crash evidence.
Before any job can create today's log, it checks today's and yesterday's files
(from the logging start date). If either is absent it emits one `log.missing_day`
error per UTC reporting day, with `ids.runId`, the missing dates in `props.source`
and their count. This uses collector state to suppress repeats; status and rollup
readers never append log lines. A failed append retains the missing dates for
retry and advances the daily marker only after a successful append. `emit()`
returns true on append and false on failure, while existing callers ignore it.
A stopped collector is visible through status's
missing-file report and silent jobs.

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
refresh work after one early part attempt per root. Ordinary children that will expire
during the pass are refreshed before more parts work can crowd them out.
Individual probes use 1.5 times the child's last successful duration, bounded
to 15–120 seconds. Children without timing data start at 60 seconds; legacy
short probes get at least 60 seconds or twice their last allowance, up to 120.
A known-cost probe below 60 seconds gets one doubled retry per pass and stays
in ordinary discovery. Only a full probe of at least 60 seconds establishes a
timeout for descent. Deep batches first learn a cost, then reserve twice the
estimated work within their deadline. Legacy timeouts with no recorded
allowance or parts get one probe conversion. Batch deadlines fall back to
individual probes. A confirmed timed-out child is split into immediate entries,
with each completed part checkpointed and at most ten minutes per child per
pass. A part whose measured or sibling-estimated cost exceeds the time left
is deferred to the next pass. Checkpointed parts and their parent have a 72-hour freshness window so
three nightly passes can finish a child. Ordinary children of the SSD worktree
farms and crpko-devops/tmp retain their real timestamps for 48 hours, so a
sweep larger than one nightly budget can converge. Other roots keep 24 hours.
An expired ordinary child makes its root partial until measured again.
The child has no total until its listing and every part are complete and
fresh; the total retains the oldest part's timestamp. At expiry it becomes
partial with no total again. Its own directory allocation is included.
Parts do not recurse. The hourly scanner leaves parts parents and recent
timeouts to this pass.
The daily budget is 90 minutes; du runs under nice 10
and utility scheduling with explicit `taskpolicy -d throttle` disk I/O policy.
The hourly du children also use `-d throttle`; scan roots, accounting and cache
semantics are unchanged.
Termination keeps completed rows; unfinished children remain explicit partials.
Both entry points acquire `state/disk-inventory.lock` non-blocking. A busy
daily pass exits cleanly; a busy hourly scan logs `skipReason=deep_pass_running`
and cached totals while crash collection continues. `disk.deep.start`,
`disk.deep.root`, `disk.deep.parts` and `disk.deep.end` record coverage, ages,
timeout time, parts progress, the parts freshness window and stop reason.
Pass timeout totals include all command timeouts; `probeTimeouts` and
`secondsInProbeTimeouts` report the short-probe subset, and
`probeAllowanceMedianS` reports the median individual probe allowance.
Timeout source events include `allowanceS`.
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

The minute CPU sampler also checks the severe free-space floors every two
minutes: internal 15 GB, ExternalSSD 100 GB. `disk.floor_check` reads statvfs
only; it neither runs du nor traverses the SSD. Each volume has an independent
episode in `state/disk-low.json`, separate from the older 150 GB advisory's
12-hour cooldown. Recovery emits `disk.low_cleared` with the episode duration.

On a crossing, a separate child has six seconds to measure recent direct
children of the user's `getconf DARWIN_USER_TEMP_DIR`, with at most 0.5 seconds
per du. Symlinks are excluded. Budget failures emit `disk.movers_skipped`;
completed sizes survive a later timeout. Other growers, including the opencode
directory, reuse the swing inventory and delta calculation. First sightings
report size without claiming a measured delta. The child emits `disk.low` with
up to three movers, then sends through the existing Telegram notify command.
Successful sends happen once per episode; failures log `disk.alert` and retry
the frozen text/key on the next check. The inherited directory lock prevents
overlapping workers without creating a file on an exhausted filesystem.
No new watcher or LaunchAgent is needed.

Checkpoint failures never block launch or notification: the detector passes its
observation directly to the child. Only the child can use the small emergency
checkpoint at `/Volumes/ExternalSSD/.mac-upkeep/disk-low.json`, with a 250 ms
budget per operation. It skips that copy when the SSD is unmounted, unavailable
or below its floor. The backup preserves frozen messages and send receipts and
migrates back to normal state when writes recover. If neither location can be
written, notification still uses a deterministic episode key; Telegram retains
the first accepted payload and rejects changed retries. Local event/receipt
durability then depends on storage recovering. Mover cache writes are optional,
so failed writes retain attribution already measured. The listing deadline
covers opening, advancing, statting and closing the iterator.

## Mac tailnet guard

`com.abdullah.mac-tailnet` invokes `collector.py --tailnet` every 60 seconds,
independently of the hourly collector's slow disk scans. `tailnet.py` calls only
`/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json` (15-second
timeout, no socket override). It never changes Tailscale preferences or reconnects.
A valid Running/online response is up; explicit Stopped, NeedsLogin,
NeedsMachineAuth, NoState, Starting or Running/offline is down. Missing or invalid
CLI data is unknown. Unknown CLI checks probe home SSH (100.75.104.72:22) and the
remote Mullvad de-dus-wg-102 DNS listener (100.64.1.71:53), using ordinary TCP
connections through the Mac's Tailscale interface. Either success proves up.
If neither responds, a read-only HTTPS request to `SELF_HTTPS_URL`
(`https://abdullahs-macbook-pro.tailcca332.ts.net:18400/`) accepts any HTTP status
as reachable, including application errors. Only when every probe fails can
unknown CLI evidence count toward an outage. An unavailable probe tool leaves
the outcome unknown and breaks the streak without claiming recovery.
Explicit down states require `THRESHOLD_CHECKS=3` AND `THRESHOLD_SECONDS=180`;
unknown CLI evidence requires `UNKNOWN_THRESHOLD_CHECKS=5` AND
`UNKNOWN_THRESHOLD_SECONDS=300`. Both count and wall-clock gates apply, even
when minute ticks bunch under load. Any up tick resets the streak. Recovery is
sent only for an alerted outage.

`state/tailnet.json` and a separate nonblocking lock preserve streaks and queued
notification payloads across invocations. Keys and text remain identical on retry,
including after a timeout that may have followed durable Telegram queueing.
Recovery uses a distinct key. The first run drops legacy unproven counters and
pending timeout alerts, while preserving already alerted explicit-state outages.
Unix timestamps measure outages across processes; monotonic time measures CLI
and probe duration. The CLI timeout is 15 s, pgrep 3 s, each of two probes 6 s
(`nc -z -G 5`), HTTPS has an 8 s curl deadline and a 9 s subprocess deadline,
and at most one Telegram send is attempted per invocation (10 s).
The subprocess budget is at most 49 s per run.

`tailnet.sample` adds `outcome`, `cliOutcome`, `confirmedDown`, `cliMs` (also
`statusDurationMs`), `loadAvg1`, and `confirmedBy` (`home_tcp`, `peer_tcp`,
`self_https`, or null). Unknown CLI evidence adds `confirmProbes` (host to
port/ok/error/ms) and, if HTTPS ran, `selfHttpsReachable` / `selfHttpsError`. Backend state,
online flag, IP count, CLI exit/timeout and extension PIDs remain available.
Running samples retain a home SSH probe; its failure alone never overrides a
healthy CLI. `tailnet.cli_slow` records unknown CLI evidence resolved up by peers,
at most once per 900 seconds, with `suppressed` counting intervening occurrences.
`tailnet.state` and `tailnet.extension` record initial observations and changes;
switching between successful probe sources alone does not emit a state change.
a PID change alone is not a crash. `tailnet.alert` / `tailnet.recovery` record
notification queue acceptance or failure. Failed sends retry next minute.
Only configured probe addresses enter these events; raw CLI output, identity,
other peers and notification text are discarded. `mac-log-status` and daily
rollups flag a missing sample after three minutes. The app CLI's “Skip a start
command” and “Peer connection was rejected” logs are known harmless noise;
check for `EditPrefs` and backend changes when verifying read-only behavior.

After review and merge/push, run `zsh integrations/mac-logging/install.zsh`
(`--dry-run` first, `--check` after). The installer copies but never loads agents.
Bootstrap `~/Library/LaunchAgents/com.abdullah.mac-tailnet.plist` in the user's GUI
domain for the minute checks; keep `com.abdullah.mac-log-collector` hourly.
Removing the minute agent stops checks; no Tailscale change is needed.

## CPU samples

`com.abdullah.mac-cpu` runs `cpu.py` every 60 seconds at normal priority,
through `/bin/zsh` for launchd file access. One `/bin/ps` inventory reads PID,
parent, uid, cumulative CPU time, RSS, state, start time and elapsed time with a
30-second timeout. Normal samples never invoke top. The sampler never changes
another process.

`state/cpu.json` retains PID, start time, cumulative CPU seconds, host CPU ticks,
the daily spike counter and Unix observation time under its own nonblocking lock. CPU seconds
and percentages compare successful inventories; 100% is one full core.
New/reused PIDs and counter resets start at zero. Disappeared processes are
dropped; their final CPU usage is unknown, so totals cover surviving processes.
The first run, clock reset or gap over an hour establishes a baseline with
null CPU totals and no top rows. Legacy monotonic timestamps establish one
fresh baseline on upgrade. Monotonic time measures only each run's duration;
Apple's Python 3.9 gives it a different epoch in each process, so it cannot
measure intervals across minute invocations. Failed inventories emit a fixed `failure`
code and `durationMs` without advancing state.

`cpu.sample` includes `windowS`, `cpuS`, load averages, logical CPU count,
total CPU percent, process count, runnable/uninterruptible counts, the top 15
families (count, CPU, RSS MiB) and top 20 PIDs (parent, family, CPU seconds and
percent, RSS MiB, elapsed time and optional script hint). Families use the
innermost app bundle or executable basename; Python versions and mds variants
are grouped. Only node/bun/python PIDs in that top 20 get a separate batched
argv read with a five-second timeout and a start-time recheck. Hint failure
sets `hintError` without losing numeric CPU evidence.

`cpu.spike` captures up to 15 PIDs with parent families and redacted 160-character commands when load1 > 2× logical CPUs, plus host/unattributed CPU, observed spawn families and runnable thread counts; it is capped at 240 records/day and 8192 bytes/record, and is conditional rather than a cadence job.

Host tick deltas add `systemCpuPct`, `userPct`, `sysPct`, `nicePct`, `idlePct` and
`unattributedCpuPct` on the same one-core=100% scale; a failed read sets
`systemCpuError` without losing the sample. The first valid read is a baseline.
`spawned`/`exited` compare PID + start time, and `spawnedFamilies` counts only
new processes still visible at the next inventory. `pidAdvance` is omitted:
long-lived high PIDs hid a real 200-process burst after allocator wrap on this Mac.
The optional thread read has a two-second timeout.

`userPct` excludes nice time; user + sys + nice is busy CPU. `kernelTaskPct`
is null on normal samples. Spikes read the second frame of a
`top -l 2 -s 1 -pid 0` call with a 15-second timeout, `kernelTaskWindowS: 1` and cumulative
`kernelTaskTime` for reference; failure sets `kernelTaskError`. `kernelTaskWallMs`
records the call's wall time rounded to the nearest millisecond, including errors.
The expensive read is limited to once per 30 minutes, including failed
attempts, using a wall timestamp in the existing sampler state. Skipped spikes
report null CPU with `kernelTaskSkipped: "rate"`; quiet samples retain the
cooldown, and a clock rollback starts a fresh cooldown.
System time also runs in other
processes, so neither kernel_task nor sys time should be added to process CPU.

Exited-child CPU comes from `proc_pid_rusage` V1, converted from Mach ticks.
Darwin 27's `ps -S` did not include it in the fork/wait proof. `childCpu` lists
ten parent PIDs with their family and the parent's family in `parentFamily`;
`childCpuFamilies` groups those family pairs before truncation. `childCpuPct`
sums all readable parent deltas, separately from `totalCpuPct`.
The reader captures Mach time before ps; later process starts are excluded with
coverage reason `identity`, preventing PID reuse from corrupting a baseline.
Ancestors are read before children to avoid racing a reaping transfer.
Old CPU of disappeared descendants is subtracted when reaping transfers their
lifetime counters. Ambiguous transfers (including possible orphan adoption) are excluded and counted in
`childUncertainParents`. `unattributedAfterChildrenPct` subtracts the recovered
child CPU from the original gap, floored at zero. Baseline or unavailable child
readings leave the total null, rather than claiming zero.

`childReadable`/`childUnreadable` and `childCoverage` expose failures by uid and
fixed reason. Other-user processes, including launchd, normally deny reads;
if PID 1 is readable, its child CPU is labelled `orphaned-exited`.
`lostParents` counts vanished parents known from the old tree or child counters;
parents born and gone inside the interval remain invisible. The syscall pass
has a 30-second budget and adds no process inventory command.
`observedSpawnsLowerBound`, its per-minute rate and `observedSpawnsByParent`
count new PID/start identities still present in the next snapshot. They miss
processes that exit between snapshots and are not an exact exec counter.

Hints and spike commands use the janitor's reviewed #45 `leftover_processes.redact` helper,
loaded from the sibling source tree or the installed
`~/.config/opencode/skills/dev-resource-janitor/scripts/` directory (including
its `active_sessions.py` dependency). No janitor scan runs. Hints omit inline
programs and reduce paths to a basename, or the first directory after
`ExternalSSD/` or `.local/share/` plus basename; intervening directories use
`…`. Spike commands replace home prefixes with `~`; argv never enters sampler state. If the helper is
missing, labels are omitted and the CPU measurements remain available.

The logger bounds labels and lists and caps samples at 7000 bytes and spikes at 8192
bytes, dropping lowest-ranked detail rows if necessary (`topOmitted` and
`familiesOmitted`). At 1440 scheduled runs and 240 spikes/day, CPU records
use at most 12.1 MB/day. The existing shared
day-log cap and retention still apply. The installer copies the new helpers
and plist; the evaluator must load `com.abdullah.mac-cpu` after review.

## Minute disk-wait samples

The existing `com.abdullah.mac-cpu` 60-second schedule runs `u_sample.py`
before the CPU probe, using one wide `ps` snapshot of PID, parent, start/elapsed/
CPU times, state, executable and argv, capped at five seconds. A 1,024-column
executable field preserves Darwin paths before taking their basename; argv
stays last. It never reads a volume or invokes lsof. Errors
leave CPU sampling running and retain the last U state. Exiting `?` states
are accepted; isolated torn rows are skipped with a `proc.u_parse` diagnostic
(argv omitted). More than five bad rows and over 10% bad fails the probe.

`proc.u_sample` requires the same PID/start time observed in U for ≥60 s.
`ageS` is process age; the first observation is a baseline. Non-U observations,
PID reuse, backward clocks or gaps over three minutes reset it. Snapshots
cannot prove what happened between observations. `count` and `byComm` (top 50)
cover qualifying processes; up to 15 `procs` include parent attribution, CPU
seconds and argv (≤200 characters, known secrets redacted). `volume` is the
first `/Volumes/<name>`, `/var/folders` or `/Users/<user>` argv prefix, or null:
a hint, not a measured wait location. Unquoted names with spaces yield only
the first word. PID 99184 stays counted but gets one detail row per UTC day.
`lsofStuck` and up to five `lsofCallers` identify the parents starting lsof.
Plain lsof can block on any wedged volume regardless of its target path or port.

Private, nonblocking-locked `state/proc-u.json` keeps U baselines, the daily
marker and one episode, using Unix wall-clock times only and no argv. Episodes
start on a qualifying nonempty sample and close after three successful empty
samples; errors/partial reads cannot close them. One `proc.u_episode` row
records closure, retried after append failure. Other empty minutes are silent;
there are no new alerts. A permanent waiter such as 99184 keeps the episode
open even while its detail is suppressed. Rollup `uEpisodes` lists episodes sampled or closed
that UTC day, retaining original starts across midnight, end (null while open),
last seen, peak count, 15 volume hints and ten comms by peak concurrent count.
Summaries cover all processes before detail truncation. U rows cap at 16 KiB
with omission counters (≤23.6 MB per 1440 nonempty samples); shared retention
and the day cap apply. The evaluator copies helpers with `install.zsh` in the
batched release; no new or changed plist is needed.

## Memory samples

`com.abdullah.mac-memory` runs `memory.py` every 300 seconds independently of
inventory, through `/bin/zsh` for launchd file access. `memory.sample` contains
swap MB, VM page counts and page size, raw pressure counter/level and free percentage,
load averages,
the top 15 footprints with compressed MB, watched daemons with elapsed time,
process/parent-1 counts, and disk0's second iostat sample. MB/GB use powers of
1024. `top` MEM already includes compressed pages. The single-snapshot CPU column
is omitted because it reports zero without a preceding observation; use
`cpu.sample` for CPU usage. One full, memory-sorted top snapshot
supplies growth tracking for every observed PID and the first15 logged holders,
plus watched PIDs, including those below15.
ps supplies command names, elapsed time and process start time and matches the snapshot by PID.
At most512 watched PIDs are retained; excess
is explicit in `watchedOmitted` and makes the sample partial. Each subprocess,
including notifications, has a ten-second timeout. If top times out, up to three
previous holders get a five-second `footprint` probe and a bounded birth recheck;
if the full ps scan also fails, bounded per-PID birth checks bracket each probe.
`fallback` records these outcomes. No RSS substitution is used. Failed probes are null with
fixed `…Error` codes; watched PID failures retain null metrics per PID.

`state/memory.json` retains swap counter baselines and alert receipts under a
separate nonblocking lock. `swapinsDelta`/`swapoutsDelta` compare successful reads
on the same boot, with `deltaWindowS`; first reads, resets, gaps over an hour and
clock rollback establish a null baseline. Missing/failed probes remain unknown.
No process arguments, command output or notification text enter the day log.

Swap above 16 GB, critical pressure in two consecutive samples, a footprint
above 8 GB, or fseventsd above 2 GiB queues a Telegram notification and writes
`memory.alert`. Critical means `kern.memorystatus_vm_pressure_level == 4` or
free percentage below 15; unavailable/healthy samples or gaps over ten minutes reset the streak.
`pressureLevel` logs that level (1 normal, 2 warning, 4 critical); `pressure` keeps
`vm.memory_pressure` as a raw counter and never determines an alert. The level
streak starts fresh when upgrading from the old counter-based implementation.

A separate `fseventsd_growth` reason warns on footprint growth above 100 MiB/h
for three consecutive intervals spanning at least 15 minutes. A baseline plus
three five-minute samples is required; one jump does not qualify. Samples log
`fseventsdGrowthMbPerHour`, `fseventsdGrowthSamples`, `fseventsdGrowthPid` and
`fseventsdGrowthWindowS`. State follows each watched PID on the same boot;
elapsed-age discontinuities, a flat/falling reading or
a gap over ten minutes reset its streak. A timed-out top or ps sample preserves unmeasured
history as a gap for up to twenty minutes, without creating a new observation.
The same tracker supplies `growth`: any holder at least4 GiB, growing above1 GiB/h
over at least three consecutive intervals spanning30 minutes. That reason uses
PID plus exact start time and boot identity. Samples include measured growth rates.
Each reason has a six-hour cooldown across day boundaries. Footprint and growth
can escalate earlier when a holder adds at least4 GiB since its last alert, or
another holder qualifies. Swap can escalate after another4 GiB used; its initial
trigger stays above16 GiB. All reasons retain a minimum30-minute alert gap.
`memory.alert` includes the holder PID, footprint, growth rate and escalation/fallback
flags; the two-line notification names the holder, swap and compressor sizes.
Keys start `mac-memory:<reason>:<YYYYMMDD>` with a time
suffix so another alert can be queued after six hours on the same day. An
unconfirmed send retains its exact key/text for idempotent retry. For a diagnostic
sample without notifications, run `TOOLLOG_DIR=<private-temp-dir> /usr/bin/python3
integrations/mac-logging/memory.py --no-alert`.

## Forensic log windows

`mac-log-window --start 2026-11-16T08:22:00Z --end 2026-11-16T08:24:00Z
--predicate 'eventMessage CONTAINS[c] "PMU"' --info --debug --out evidence.ndjson`
reads `log show` with a deadline and keeps only parsed timestamps inside the
requested inclusive UTC window, preserving the original row bytes and timestamp
precision through nanoseconds. Use explicit
UTC bounds. `--deadline` defaults to 90 seconds (maximum 600); group termination
allows up to 3 seconds for TERM and 1 second to reap after KILL.
`--slice 15m` divides the window and remaining budget between consecutive reads;
a timed-out slice does not prevent later reads while budget remains. Shared
slice edges are kept only once. Rows outside each slice are excluded even when
they fall inside the overall window. `--keep-outside` saves them separately in
`<out>.outside.ndjson`; they are never incident evidence.

Every read, with or without `--slice`, also splits at known boot times. The
shared helper refines minute-only reboot history to seconds. `<out>.summary.json`
adds `boots` (UTC timestamps used); each slice cut by a boot has `bootSplit: true`.
Boot discovery uses the same deadline as the reads. Slice planning is incremental;
an unresolved minute is reported as one gap even with a tiny `--slice`.
The boot second is isolated with at most six seconds to read plus four seconds
for termination and reaping. Other intervals retain the remaining budget. An
unresolved boot minute is omitted with `reason: bootUnresolved`, status `partial`
and exit 2. `--predicate` is optional. A final log count/finished trailer is ignored.

Exit codes are 0 complete, 2 partial (deadline or unresolved boot minute), and 1 error (including bad args
or a nonzero log exit). `<out>.summary.json` records arguments, UTC bounds,
status, exit code, elapsed milliseconds, `rowsIn`, `rowsOutside`, earliest/latest
outside timestamps (`outsideFirst`/`outsideLast`), `unparsed`, greatest kept
`lastInWindowTs`, per-slice results and a reason. A partial result is incomplete;
`lastInWindowTs` is an observation, not proof of coverage. Unparseable rows are
counted and excluded. Validation errors also write a summary when `--out` is
supplied and its parent is writable. The helper writes only the output and its
sidecars and never requests root access.

## Source events

Unified `crash.source` and completed `crash.unified.chunk` records include
`outsideRows`, `outsideFirst`, `outsideLast` (UTC epoch seconds) and
`unparsedRows` only when those counts are nonzero. Source records aggregate
chunk counts; unparseable timestamps and outside rows never become observations.

`disk.inventory` and `crash.collect` retain `count` and `sourceErrors` summary
counts. Each unavailable source also emits an error-kind `disk.inventory.source`
or `crash.source` with `source` (root path or `unified`), `failure` (`timeout`,
`exit`, `permission`, `parse`, `missing-total`, or `partial`), `exitCode` (null when no
exit code is available), and `elapsedMs`. Budget-exhausted roots get their own
timeout line without launching another command. Confirmed missing inventory
paths retain a zero total without a source error.

`disk.inventory` also reports `rootsOk`, `rootsPartial`, `rootsTimeout`,
`rootsDenied` and `scanMs`. Timeout/denial counts include affected children and
can overlap the partial count. Daily `diskInventory` rollups sum those counts
and scan time across `scans`; lock-skipped hourly runs are excluded.

Only these source errors accept a diagnostic `error.message`: the first stderr
or filesystem-error line, trimmed to 300 characters with credential-like text
redacted. No du stdout, unified log messages, report contents or arbitrary
exception text is logged. Parse failures use fixed messages. Commands use the
C locale so permission diagnostics can be identified consistently.

Denied children retain readable bytes (zero when du can read nothing), with
`denied=true`, `estimate=true`, and `partial=false` on the child. They are
refreshed only by the deep pass. Roots whose only gaps are denied children
report `completeWithDenied`; `disk.inventory.rootsComplete` includes these
roots and `rootsCompleteWithDenied` names their count. Their cached root stays
in `partials` so disk-growth attribution does not treat estimates as exact.
Vanished children count as zero only after lstat confirms absence on available
storage. Attributable batch errors affect only their child; unknown diagnostics
retain conservative batch handling.

Child source events retain deep probe cost metrics, errors and notable successes
(new ≥1 GiB, change ≥1 GiB or ≥20%, or ≥10 seconds). Root summaries and the hourly inventory
carry denial, timeout, backoff and estimate counts and the top three child costs.
Batch costs are equal shares of command time, not individual timings.
`disk.deep.end.secondsByRoot` accounts for root turns without double-counting
batched child rows. Failed 600-second leaf scans retry only in deep passes,
with delays of 1, 2, 4 then 8 days. Budget-truncated probes do not acquire this
backoff. Parent probes still descend immediately into checkpointed parts.

Big roots emit child source events with `bytes`, `exitCode`, `elapsedMs`,
`partial`, and `deniedCount`, plus a root aggregate with `completedCount` and
`failedCount`. `deniedCount` sums only explicit numeric permission-denial counts.
Root aggregates also report `partialChildCount`: cached children without a valid
numeric denial count whose `partial` flag is true or unknown. An explicit zero
denial count does not contribute to `partialChildCount`. Both counts preserve
the root's existing `partial` flag. Child timeouts/errors remain named source errors. An incomplete
root emits an error with `failure=partial`, `partial=true`, and the available
children's `bytes`. The aggregate includes only recorded child measurements. `failedCount` includes one additional
incomplete remainder when the root deadline stops enumeration; it is not a
count of every unvisited child. Summing child du totals does not deduplicate
hard links across children and excludes the root directory's own blocks.
Root attempts rotate oldest first, with never-attempted roots ahead of measured
ones. Budget-skipped roots retain their place; full failed attempts rotate too.
Shortened failed attempts keep priority for a full allowance on the next run.
`disk.inventory.root` summarizes each root once per run, including `deniedCount`
and `partialChildCount`. Detailed child sizes stay
in `state/disk-inventory.json` (`childState`); successful child lines are retained
only for changes of at least 1 GiB or 20%, new children of at least 1 GiB,
or measurements taking at least ten seconds. Partial and error diagnostics
are always retained.
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
Confirmed missing optional database/WAL files retain zero sizes. Unified source
results and `crash.collect` retain `windowStart`, `windowEnd` (Unix seconds),
`windowS`, `skippedS`, `chunks` and `chunksDone`. With adaptive sizing, `chunks`
estimates the total using the current chunk size; on completion it equals
`chunksDone`. Chunk bounds exclude the previous cursor even when log's second
rounding returns overlapping rows. Unparseable timestamps are counted and excluded.
Unified `crash.source` results also include `partialRows` for unsuccessful reads.
`bootUnresolvedS` records unresolved boot minutes omitted during the run;
`bootSecondUnreadableS` records boot seconds omitted after three failures.
All fragments of that second share the failure count; the terminal count stays
until the second is older than the moving ceiling, preventing a fourth query.
`partialRows` counts complete row objects received from an unsuccessful command,
including an incomplete JSON array on timeout. They are diagnostic counts only:
none become observations and the failed interval does not advance. A source
summary has `partial=true` while any boot interval remains pending.
Retry checkpoints retain unreported `skippedS`, including after the final chunk,
so interruption before the source result cannot hide a coverage gap. Once the
source result reports the gap, a retained suffix clears that metadata. Retries
older than the moving 90-minute ceiling log the exact additional skip before
checkpointing that ceiling; a retry inside it preserves its frozen end. Finishing
a retry continues into a fresh window within the same run's remaining budget.

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

## Folder budgets

`disk-budgets.json`, installed beside the collector, assigns folder budgets in
GiB to owner boards. The hourly collector emits `disk.budget` for every path,
using complete inventory child/parts caches or root sums. `~/.robob/userdata`
is excluded from its parent sum; symlinked targets are never measured. Missing
paths report zero, while unavailable or incomplete measurements report a stale
last complete size (or null). `sizeAgeS` is the measurement's age, rather than
the last collector run's age.

Targets outside those cached levels are measured only by the daily deep pass,
using its existing lock, wall budget, per-folder cap and checkpointed scanner.
`disk.budget.over` follows three consecutive UTC hourly over-budget samples,
at most once per path per UTC day. Stale/missing observations and gaps reset
the streak. These events do not send notifications.

`mac-log-rollup` includes `diskBudgets.topOverBudget`, ordered by excess at each
path's latest fresh daily observation. Growth uses the nearest fresh sample to
24 hours earlier (within two hours), using measurement times from `sizeAgeS`;
it is null when that baseline is missing. `sizeTs` and `growthWindowS` record
the measurement time and actual comparison interval. Overlapping parent and
child budgets are independent and must not be added together.

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

`disk.clone_wedge` also records U-state `cp -c`/`clonefile` commands of any
age, and groups of U processes naming the same absolute path in three
one-second samples. Both must remain in U in every sample; CPU may advance.
It records PID, process age, path, CPU delta and wait
channel (`-` when macOS hides it). The probe uses only `ps`, never pathname
lookups. Argument parsing is best effort: `ps` does not preserve argv quoting,
so ambiguous pathname fragments, quotes and escapes do not establish
shared-path identity. Clone commands with ambiguous operands still qualify
under their own PID identity.
Umount is excluded and remains covered by `proc.disk_wait`.
One Telegram alert per PID/start incident uses the existing notify helper;
shared-path waiters alert together, and failed sends retry frozen text/key.
This is an I/O workload signal: CPU or device progress can mean slow APFS
extent copying, so the alert does not diagnose deadlock or recommend a kill.
The clone probe shares the disk-wait budget, with its own 20 s ceiling.

Each hourly run selects processes in `U` aged at least ten minutes, then
samples their state and cumulative CPU time six times, one second apart.
Only `U` in every sample with no CPU progress counts as stuck. Processes
that leave `U` or use CPU appear in `busy`, for information only, with no
alerts. Vanished PIDs are dropped. Calls are bounded to ten seconds within
a shared 45 s budget; a partial observation needs at least three samples
to classify a stall. Failed sources never stop the rest of collection.

`processAgeS` is uptime. `stuckForS` is a lower bound from the first consecutive
hourly stuck observation, reset by recovery, CPU progress or PID reuse.
For umount, it includes process age because unmounting is its only task.
Alerts use `stuckForS`: thirty minutes for umount, six hours otherwise.
Each PID/start time alerts once; failures retry the same frozen text and key.
The event retains ten stuck and ten busy processes, six state samples each,
and at most 300 characters of arguments, with credential-like text redacted.
`stuckUnmount` and `mountPoint` cover all stuck matches, including omitted rows.

Daily `diskWait` rollups report stuck runs, maximum `stuckForS`, the latest
stuck-unmount mount point, busy runs and five top busy command names.
Old lines still count; their uptime maximum is kept as `legacyMaxProcessAgeS`.

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

## Volume crawl attribution

The minute CPU snapshot selects candidates for `scan.volume_crawl` for `du`,
`rg`, `find`, `fd`, `ncdu` and `dust` alive for at least 30 seconds. It matches
filesystem operands resolving to `/`, a volume root, the home directory, or an
immediate child of ExternalSSD. Implicit operands use cwd; explicit operands
are resolved before classification. `rg -n foo src/` from a repo cwd is scoped;
from `/Volumes/ExternalSSD` it names an immediate child and qualifies. A single
`lsof -a -d cwd -p … -Fn` call has a two-second timeout for all candidates;
missing cwd still permits attribution from absolute operands. `?` exiting
processes are skipped. A separate two-second helper reads NUL-delimited
Darwin `KERN_PROCARGS2` vectors for at most 32 candidates and four ancestors
each. Candidate batches rotate if there are more. Reads have 256 KiB per-PID
and 1 MiB total output limits. `proc_pidinfo` identity must match before/after
the read and the original ps start-second, UID, PPID and executable name.
Unreadable, changed or oversized vectors skip classification; flattened ps
text is never reparsed as argv. No extra ps snapshot or environment dump runs.
The metadata snapshot keeps full `comm` last so Darwin does not truncate the
existing CPU family labels and interpreter hints. Native reads require LP64;
the executable path's pointer-aligned boundary locates the first argument,
preserving leading empty arguments without consuming environment entries.

Records retain PID, PPID, up to four ancestor PID/name pairs, cwd, elapsed
seconds and CPU percent from matching consecutive process identities (null on
baseline). `argv` holds executable and resolved filesystem operands only;
patterns, find expressions and option values are omitted. Paths are retained
without the general logger's home/secret-word replacement. A project/UUID thread
identifier in a recognized `t3ctl`
identity operand or the exact `ROBOB_THREAD_ID` environment key is retained;
shell programs and query text never supply identity. `providerPid` and `provider`
identify the nearest Claude, Codex or OpenCode ancestor below Robob (including
known Node CLI entry points). `providerSessionId` accepts explicit UUID session
arguments and OpenCode `ses_` identifiers. Codex app-server and OpenCode server
processes have null session/thread identifiers with `providerSessionAmbiguous=true`.
The checked live Claude processes expose `--resume=<uuid>` or
`--session-id=<uuid>`; their named environment key was absent. `t3ctl native`
can resolve a logged provider session ID later; the sampler makes no API calls.
Parsed identifiers and scan operands are cached in CPU state for at most 512
processes, keyed by PID, snapshot start time, PPID, UID and executable name.
Each cache miss joins the existing bounded argv batch; failed reads are cached
until identity changes or eviction. Exited processes leave the cache. Raw argv,
prompts, settings and other environment values stay out of CPU state.
Lines are capped at 8 KiB by dropping trailing operands with `argvOmitted`.
Oversized cwd/thread strings become null with `stringsOmitted`; parent names
are bounded. Unknown option arity skips classification instead of guessing
filesystem operands.
The existing day cap and retention apply.
Ncdu import mode is excluded because it reads an inventory rather than crawling.
Fd execution clauses are excluded through their literal semicolon terminator
or argv end; fd options and scan roots after a terminator are still parsed.

Argument vectors retain spaces, quotes, backslashes and empty operands.
This event is attribution evidence, never authority to kill or throttle a PID.
A process may exit between the argv read and lsof. Missing cwd
prevents classification of relative operands. Crawls shorter than 30 seconds
or wholly between minute samples are outside this detector's coverage.

### Launchd SSD read probe

The separate `com.abdullah.mac-ssd-read-probe` job runs every 60 seconds through
`/bin/zsh -fc 'exec /usr/bin/python3 "$@"' -- <script> sample`, the same granted
identity as guard and read-watchdog. It measures what the real jobs can read,
without creating another ungranted TCC requester. CPU/U inventory cannot hold
this schedule even if its lsof child is stuck forever.
`mac-log-status` also checks for missing probe rows, allowing three minutes
before reporting the detector late or silent.

The reader stats and reads 4 KiB from `/Volumes/ExternalSSD/.mac-upkeep/probe.bin`
(created by `install.zsh`). Both share a three-second Popen/poll deadline. A
stalled child is abandoned without kill/wait and its PID plus exact `ps lstart`
suppresses the next reader (`stuckPrior=true`). State and child output remain
on the internal disk under `~/.local/state/mac-upkeep`.
The job uses `AbandonProcessGroup=true` so launchd preserves these children when
the minute parent exits; later runs use their saved identities to avoid pile-up.

Every run also discovers sandboxd with `pgrep -x sandboxd` and counts `ps -M -p`
rows minus the header. Both commands share a two-second deadline; an abandoned
helper's PID plus kernel birth time suppresses new helpers until it clears.
`sandboxdThreads` is null when unavailable. A read can pass during an approval
jam, so a count of 20 or more also counts as a failed run. The event retains
read outcome (`ok`, `slow` above 500 ms, `timeout`, `error`), separate `statMs` and
`readMs`, symbolic errno, ProcessType, nice and loadavg1 alongside that count.

Two consecutive failed runs atomically write
`~/.local/state/mac-upkeep/ssd-launchd-read-blocked` with `since`, `lastOutcome`,
`errno`, `sandboxdThreads` and nullable `promptingPath`; `lastOutcome=jam` when only the thread count tripped. The latch
queues one deduplicated Telegram alert naming the cause through the collector's
notification path. Only the first latch run captures tccd AUTHREQ_PROMPTING
messages from the last five minutes, bounded at 15 seconds with Popen/abandon;
its last responsible path, if found, is saved as `promptingPath` in the marker.
It never runs that capture each minute. Restart tools must check the marker.

An `ok` read with a known count below 20 removes the marker and queues one
recovery line. Slow reads or an unavailable thread inventory cannot clear an
existing interlock. Notification retries preserve exact keys/text and never
write alerts to stdout. The evaluator loads only the new probe label after
review; the CPU job retains its original launcher. Installer tests set
`MAC_LOG_SSD_PROBE_FILE` for fixture init/check; live reads use the fixed target.

## Host telemetry

`host.spawn_sample` reports sampled births/exits once a minute, with parent
identities, runnable threads by current priority, CPU advancement and offbox
command classes. Births are a lower bound from five-second PID/start-time
snapshots, not a fork or exec count. `status` and rollups show the latest
birth rate with its snapshot cadence, three parents and runnable priority-4-or-lower count. Overload
events carry the sample as context without changing alert thresholds.

Each native pass has a 1.5-second cooperative deadline and reads threads for
at most 300 candidate processes. A separate daemon worker isolates a stuck
kernel call; the publisher reports stale/in-flight coverage instead of
waiting. Coverage, unreadable argv/tasks and missing CPU baselines are explicit.
Only derived labels are cached per PID/start identity; argv is never logged.
Cost includes per-minute summed wall/CPU time, individual phase costs and guard
decisions. CPU above 2% of a core per minute or two consecutive ticks at the
1.5s wall bound reduce coverage, prioritizing runnable hints and highest CPU
gain. Summed minute wall time is data, not a cost trigger. If halving the thread
cap does not reduce thread-read wall time, further pressure slows cadence to
15s instead of continuing to shrink coverage. Five calm minutes (CPU below 1%,
no tick at 1s) start recovery: restore 5s cadence first, then double the cap
once per calm minute up to 300. Candidate selection has separate phase timing.
A shared 75ms soft argv/CPU allocation leaves room for a 25ms thread pass every
tick within the 1.5s overall deadline. Runnable hints with unread CPU data
remain eligible for thread reads and carry an unknown CPU baseline.
Argv runs first so a slow CPU census cannot starve new parent/offbox labels.
Thread counts are null only when no minimal pass fits or is readable, and retry
on the next tick. Runnable counts describe the latest tick, not the sum
of repeated censuses; offbox counts/RSS describe that same tick. CPU deltas use
the last readable per-identity baseline (`offboxWindowS` is the tick window,
`cpuWindowMaxS` exposes older baselines); RSS is a sum, not unique physical memory.

`com.abdullah.mac-host` is a separate long-lived Standard job. It emits
`host.vitals` every 30 seconds and `host.families_lite` every 60 seconds without
starting subprocesses. Install copies its plist; the evaluator loads this new
label separately. It does not require restarting the other logger jobs.

Vitals include load, swap bytes, raw memory-pressure counter, memorystatus free
percentage, pressure level, VM pages and counter deltas. Baseline/reset deltas
are null. Runnable/U counts describe processes with a matching thread;
`runnableThreads` counts threads. Permission failures and exits make state
coverage partial. The separate state worker publishes counts with `stateAgeS`; a blocked worker
never delays vitals. Snapshots older than32 seconds are omitted
(`statesAvailable=false`). A two-second state walk disables further walks until restart.
Family rows contain executable names/counts; Python argv reads retain only a
script basename or module. Unreadable names and bounded inventory work are
reported as partial. More than512 family rows set `partial`,
`familiesOmitted` and `processesOmitted`. Families run on a separate thread so they cannot hold up
vitals. A nonblocking local datagram wakes vitals immediately on `cpu.timeout`.

Portable fixtures run with the suite above. The read-only Mac ABI check is:

```sh
MAC_HOST_LIVE_TEST=1 PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -I -m unittest discover -s integrations/mac-logging/tests -p test_host_live.py -v
```

## Mac guard

`com.abdullah.mac-guard` runs a 30-second Interactive loop, logging `macguard.*`
to the same day files. `mac-log-status` shows its last sample, strain, actions
and Robob memory restarts in 24 hours, and its critical worker.

Under sustained strain it terminates stuck/orphaned build and tool trees,
softens CPU hogs, then suspends and terminates persistent hogs. Live or unknown
build owners and GUI apps get softening only. Stopped survivors resume when
strain clears. Provider CLIs, their node/bun wrappers, OpenCode, Robob and
macOS system processes are never signalled or reniced. Integration services
and their children are protected from the strain ladder.
Recovery cancels queued strain-ladder kills, including while paused and across
daemon restarts; memory-runaway kills remain independent of strain.

The memory backstop uses top's footprint (including compressed pages), never
RSS: >=16 GiB growing >=1 GiB/min over 60 seconds, or >=48 GiB regardless of
growth. It terminates the offending PID only, including integration workers
and GUI apps; agents, OpenCode, Robob and macOS remain exempt. Protected
runaways alert and call one critical responder. All signals recheck PID birth
identity. Evidence lives in `~/.robob/board-artifacts/mac-guard/`.

Signal 7 catches slow leaks without waiting for load or pressure: footprint
over 8 GiB and growth over 1 GiB/hour across at least 30 minutes. Its bounded
history persists by PID and birth time, retaining missing-sample gaps. Other
processes use the strain ladder; protected holders alert the responder.
Only eligible offenders activate signal 7 and strain. A protected slow leak
alone cannot authorize strain-ladder actions against other processes.
Eligible leaking GUI apps get a normal Quit AppleEvent addressed to the exact
PID. Two minutes later, only a surviving identical app still over the slow-leak
threshold and still growing may receive TERM, then KILL ten seconds later.
Each step rechecks identity and bundle ID. Queued force-quits also require
current growth and service protection after a
pause or restart. Foreground app main executables in
`/System/Applications` (such as Activity Monitor) qualify; system daemons,
background apps, helpers, agents, OpenCode and Robob do not.
Dia (`company.thebrowser.dia`), Messages (`com.apple.MobileSMS`), Robob
(`com.ardud.robob`), Finder (`com.apple.finder`), Terminal (`com.apple.Terminal`),
iTerm2 (`com.googlecode.iterm2`), Ghostty (`com.mitchellh.ghostty`) and Warp
(`dev.warp.Warp-Stable`, `dev.warp.Warp`, `dev.warp.Warp-Preview`) are exempt
from this slow GUI exception even when renamed. A failed or ambiguous Quit
alerts the responder and never authorizes force-quit. `macguard.slow_leak`
and `macguard.action` include bundle identity, footprint series and growth;
the responder reports evidence and actions on the Mac board.
The single ten-second-bounded top read includes every process so Robob's tree
total cannot disappear below the twenty largest holders; snapshots retain the
top twenty plus footprint history for all matched PIDs.

A Robob process crossing the growth threshold, or the app tree totaling
>=24 GiB, requests the overload watchdog's detached `restart` subcommand.
Missing helpers, install holds, restart/install tmux sessions, release builds,
server uptime under ten minutes, the SSD read-blocked interlock and a memory restart within an hour skip it
and alert the responder. The guard calls the fork's
`integrations/robob-overload-restart` installed copy through
`/bin/zsh -f ~/.local/share/robob-overload-restart/launchd-entry.zsh restart <stamp>`.
It skips with an alert while that watchdog is missing or disabled. The watchdog's
own limits still apply, including expiry where enforced by the installed version.
Its LaunchAgent need not be loaded for this direct call.

The call runs in detached tmux session `restart/mac-guard-restart`, so it does
not collide with the watchdog's `restart/robob-restart` exclusion. The guard
records the attempt before launch, then reads the watchdog's stamped result
receipt and the detached command's exit status. Success requires both a success
receipt and a zero exit. Missing/off helpers and refusals
consume the hourly attempt allowance and alert the responder once; they never
select an alternate helper. Responder delivery failures retain the incident
and retry the same request during cooldown, including status or send failures
for an existing worker. Uncertain requests stay bound to the original worker
and operation, even if it finishes before acknowledgment. Logs and exit status stay in the guard's evidence
directory. `macguard.robob_restart.detail` records the refusal or install hold.

On socket `qf-install`, a live pane in a session matching `^install\d*$` holds
the restart when it runs a non-shell command or had activity within 30 minutes.
Dead panes and older idle shells do not hold it. Failed or timed-out probes
hold it; a confirmed absent tmux server does not.

The separate runnable/idle diagnostic requires two valid minute samples of
load >=100, host idle >=30% and process R >=64 (or >5s Robob lag). It records
one thread/CPU-progress/stack/core packet per episode; it never selects a victim.
Spindump and powermetrics are bounded, without sudo; permission failures are
recorded as unavailable evidence. Stack capture runs outside the guard loop.

Worker launches persist their request ID and exact payload before using the
control API (`t3ctl create` does not forward a request ID). After an uncertain
response the guard looks up the deterministic thread ID first. A matching
thread is adopted after its user-message history confirms acceptance of the
full saved safety prompt with a durable run. If complete history shows that
initial message missing, the guard resumes that same launch through
`POST /threads/:threadId/resume-launch`. The server reuses the original
initial-message command and receipt, so a late original dispatch cannot accept
a second run. Both paths apply the create API's prompt trimming. Pause is
checked between history and recovery. It retains the launch payload and any restart
report until acceptance is confirmed, including after strain clears. Only an
authoritative missing thread permits a re-POST of the same create payload and
request ID. Unavailable lookups or message history wait;
they never authorize a second worker. HTTP requests allow 45 seconds; the
parent bounds each isolated helper's full lifetime to 50 seconds in a background
executor, leaving sampling and the strain ladder running. Pending launches
reconcile on later ticks even after strain clears. `macguard.worker_create`
and `macguard.worker_lookup` record `durationS` and failures (`timeout`,
`http_status` with the status in `errno`, `bad_response`, or `unavailable`).

Overload transitions (`host.overload`, emitted by the host sampler) also drive
an immediate reclaim pass before the guard's fork-based probes. A fresh onset
runs the installed janitor worker under its hourly lock (120-second timeout),
reuses the GUI leak rule when recent footprint history is available, lowers
eligible local builds/tests to nice 10 with `setpriority`, then starts or steers
the existing critical worker. Offbox holders and their descendants are exempt
from every guard action. Builds below providers, including release-build clones,
remain eligible; the provider itself stays protected. This path never invokes
`taskpolicy` or sends process signals of its own.

Passes are limited to one per 20 minutes, persisted across restarts. A fresh
peak can repeat the pass for the same episode after 20 minutes if the previous
pass observed less than 1 GiB of RSS reduction. Unknown counters do not count
as memory freed. RSS deltas are observations, not proof that the rung caused
the decrease. No overload is inferred from raw load or missing samples.

Read `guard.reclaim` rows in the mac day file and
`~/.local/state/mac-guard/guard.log`. Each pass writes a census under the normal
guard evidence directory, including the original overload row, families/spawn
samples, kept identities, rung results and the never-touch list. The next
host-vitals row after completion fills in pressure/swap after the pass;
`after: null` means that row has not arrived. Worker delivery retries use the
existing durable responder path, including its idempotent launch/steer IDs.
Each rung also records the latest logged swap/pressure before and after it,
with observation timestamps. A fresh janitor report with inventory problems
produces `inventory-unavailable`, even if the worker exited zero; missing or
stale reports are labelled. Priority actions retain individual command/syscall
outcomes, bounded error reasons and known errno values. `gone` identifies an
exited process; `partial` records a successful renice followed by a failed
backgrounding command. Action evidence survives the day-file cap.
Install the corresponding janitor reporter update too: its scan timestamp must
retain fractional seconds to pass the guard's strict report-freshness check.

Pause with `touch ~/.local/state/mac-guard/paused`; remove that file to resume.
`MAC_GUARD_DRY_RUN=1` records proposed actions while sending no signals,
notifications, restarts or worker launches. Neither mode changes the separate
Robob crash reopener. The installer copies files and plists without loading
agents; installation and read-back belong to the evaluator after review.
