# 9router tool logs

Metadata-only UTC day logs live at `~/.robob/logs/tools/9router/YYYY-MM-DD.ndjson`.
Both dependency-free writers hash IDs, allowlist scalar metadata, and replace raw
error messages with stable tags. They share retention and cap markers across
processes and languages. Writes are best effort with no tool-work lock.

The existing `com.ardud.9router-log-poll` LaunchAgent runs an independent guard
every 15 seconds. It checks launchd and a TCP connection, restores an absent job,
and kickstarts a loaded job after 60 seconds of continuous refused connections.
Only a refused or unreachable TCP check opens a down window. Unknown launchd
state logs `listener.state_unknown`; uncertainty with no failed TCP check is
timed separately until `listener.state_resolved` or a confirmed failure.
Every transition records the TCP result; recovery also carries `downListener`
with the original failure evidence. Repairs back off to five minutes. The
guard sends one local Telegram alert after two minutes down and a recovery note
using the same incident key prefix. Delivery retries retain that key across guard
restarts. The HTTP snapshot runs in a separate child every five minutes.
The observer runs at launchd `Standard` priority and records its configured
ProcessType, nice value and scheduling priority once per supervisor start.
The guard kills and reaps its captured poll child after four minutes, recording
one `poll.timeout` with the active phase, wall time and child CPU time. It keeps
the regular five-minute schedule for the next child; it never kills by pattern.

Unknown transitions retain the router's `launchctlExit` (numeric, `timeout`,
or `oserror`) and at most 240 characters of trimmed, redacted stderr.
`listener.unknownByCause` groups their first observed outcome as
`launchctl_exit:<code>` or `launchctl_timeout`. Legacy windows without recorded
outcomes use `unknown_no_data` with a named missing-evidence reason; they cannot
be reconstructed. `observer.gap` and `guard.tick_late` describe late observer
work separately, retaining the longest recorded phase and measured/unmeasured
totals. If the unmeasured remainder exceeds that phase, the cause stays
`unknown_no_data` with `missingEvidence=unmeasured_tick_time`; a phase label
without duration evidence cannot establish a cause. Attribution uses the full
span before daily clipping.
Suspend-aware clock discrepancies and guard process changes can establish
`guard_not_scheduled`; a poll LaunchAgent's absent state alone cannot.

`poll.phases` and `guard.tick_late` emit once when a tick exceeds 30 seconds,
with wall/monotonic start/end pairs. The existing end diagnostic is timed as
`post_end_diag` before capturing the end clocks. Their fields split history scan/parse,
listener/pool history, report writes, state saves, NDJSON writes (`logWriteMs`),
lock waits and HTTP work;
nested work is not counted twice. `log.rollup` now measures only that rollup
call. `pool-alerts` emits `pool.endpoint.get` for its independent fetches.
Each measured phase also has a matching `*CpuMs` field, excluding nested work.
A phase over two minutes using less than 10% CPU is tagged
`tick_starved:<phase>`; other slow phases retain `tick_blocked:<phase>`.
Scheduling, child-wait and missing-evidence causes keep their existing rules.
`pollGaps`/`guardGaps` number measured spans over two minutes, clipped for daily
duration totals. `coverage` explains threshold-only `healthByHour`, exhaustion
episodes in `pools`, and missing legacy observer measurements.
Every `poll.complete` carries a compact `host` object, including failed polls.
Wire keys are `l1`/`l5`/`l15` (load averages), `c` (logical CPUs), `f` (free
bytes), `a` (free plus inactive bytes, an available-memory estimate), `p`
(macOS pressure: 1 normal, 2 warning, 4 critical), and optional `e` (failure
enum). `hostAtMs` beside `host` retains the poll sample time across midnight.
Anomaly `hostStartAtMs`/`hostEndAtMs` retain observation times independently
of gap boundaries, including cached guard samples reused after a tick or restart.
The full poll row addition, including `props` and the timestamp, stays within
120 bytes; memory estimates and then the longer load averages may be omitted to fit
extreme values; load1, CPU count and observed pressure/failure remain. Swap is omitted. Diagnostics share a 1.75-second command budget per
tick, never retry, and add no rows. Guard state retains host observations
between ticks and across restarts. Anomalies carry `hostStart`/`hostEnd`;
legacy boundaries remain unknown. Rollup gap and listener windows retain
these objects and expose `load1Start` when measured.

`hostLoad.hourly` reports sampled load1 average/maximum and maximum pressure.
`hoursWithLoadAbove2xCpu` lists hours containing an overload sample; it does
not estimate overload duration. `proxySummary.byHour` places request p95
beside that load. `failedSnapshots`, `pollRowsWithoutHost` and `coverage.hostLoad`
explain missing observations; no values are inferred across sampling gaps.

Finalized days are refreshed when late observer completions add a gap overlap.

`~/.local/state/9router/deploy.json` coordinates the guard with the router's
installer and release script. Only a `status: running` marker younger than five
minutes suppresses repair; failed markers permit repair immediately. A failed
transaction attributes an outage to `deploy_failed` only from its start through
five minutes after completion (start is used when completion is absent). The shared
directory lock prevents concurrent launchctl actions for up to five minutes.
The guard reclaims a dead owner's lock once its marker expires. At five minutes
it logs `guard.lock_override` with `ownerPid` (`unknown` if unavailable) and
`lockAgeMs`, then repairs even if the owner is alive or its PID was reused.
Lock age uses the acquisition file's modification time, so later marker updates
cannot prolong the ceiling. Deferral never suppresses outage alerts.
The installer, release helper and guard serialize lock-directory changes through
the persistent `deploy.json.coord` flock file. Takeover checks the retired
directory's identity before removing it, preserving a replacement acquisition.

The five-minute poll uses the existing local CLI authentication in memory and
only GETs `/api/providers`, `/api/usage/logs`, and `/api/usage/stats?period=today`.
It never calls a provider test, refresh, OAuth, reset, settings or account mutation.
The providers response supplies effective reauth markers, enabled/test state,
model locks and rate-limit expiry. The logs endpoint supplies `FAILED 4xx/5xx`
records; labels/emails are resolved to unique connection IDs in memory, then
hashed by the writer. Ambiguous labels become unresolved counts. A multiset of
record hashes avoids recounting repeated snapshots while retaining identical
records' multiplicity. The 200-record endpoint can miss traffic between polls;
`usage.coverage` records that uncertainty rather than claiming full coverage.
Its formatted timestamps are opaque source identities; no local-time conversion
is used. Today's cumulative per-connection cost is sampled once per UTC hour as
`spend.snapshot`. Hourly cost buckets are unavailable (`spend.unavailable`);
these cumulative snapshots must not be summed as hourly spend.

`9router-log-rollup [--day YYYY-MM-DD] [--full]` defaults to yesterday UTC. It streams a
fixture or real day file and writes a private `rollup-YYYY-MM-DD.json` with name
and kind counts, rates, duration percentiles and top error tags. `supervisor`
counts starts, stops, exits, reloads and deploy actions. `listener` contains
confirmed outage windows with `confirmedDownMs` (`totalDownMs` is its compatible
alias), plus `unknownStateMs` and `unknownWindows`, clipped to the UTC day.
Legacy transitions without TCP evidence or an explicit listener-failure cause
count as unknown state. Failed deploy-result events can attribute a confirmed
outage within the same transaction bound; live markers never rewrite history.
For both kinds of window,
their start and end retain the actual transition timestamps. Open windows end
at generation time or UTC midnight for duration calculation. The poller makes
yesterday's rollup on its first successful run after 00:05 UTC. Invalid lines
are counted and skipped.
Per-day private aggregate state retains exact numeric samples for percentiles,
plus an inode/device, observed size and committed byte offset. Samples grow
linearly with the day's input (the daily log cap is soft; no approximation or
sampling is applied). The state and sparse history caches expire with the source
logs. Appended bytes alone update the aggregate; replacement, truncation,
same-size rewrite or aggregate schema changes rebuild it. A SHA-256 witness
validates every committed byte before cache reuse, including truncate/regrow
and middle rewrites; validation reads raw bytes in 1 MiB chunks without JSON
parsing. The checksum extends with new complete lines at each checkpoint.
Rebuilds checkpoint
atomically every 8 MiB or 30 seconds so deadline kills retain progress.
An unfinished last line contributes provisionally to the report and is reread
until newline termination. Listener transitions, cross-day health joins and
pool history share a sparse append cache with the same checkpoint bounds.
`--full` bypasses aggregate and listener caches for comparison or repair.
`complete` means `generatedAt` is on or after the next UTC midnight; incomplete rollups are regenerated after 00:05Z, and lock `distinct` counts dedupe account/provider/model/deadline-minute while `count` keeps raw lines.

`account.lock` and `account.unlock` carry hashed account IDs, scope, classifier
cause, deadline and the source request ID when known. DB expiry is recorded on
the next connection read; `until` is the actual deadline, not the observation
time. Legacy locks without duration/cause metadata leave duration unknown.
`account.locked` samples the active deadlines already exposed by `/api/providers`
on each poll. RAM-only quota locks appear in router events, not that snapshot.
The rollup's `locks` section groups sets by provider/model/cause with duration
percentiles and the five accounts with the most lock sets; snapshots and unlocks
do not increase lock counts.

Image CLI behavior is unchanged: no paid fallback is enabled. Its request
function instruments an existing caller-supplied OpenRouter fallback if supplied.
The reauth supervisor remains notification-only in production. Its unreachable
future recovery paths are instrumented and exercised only by synthetic tests.

After review, deploy `router-logging` first, then
`catalog-guard`, `stream-recovery`, `local-helpers`. The local-helpers installer
ships the CLI wrappers, key helper, image helper and guard LaunchAgent;
it backs up the old image script before linking the shared skill entry point.
The supervisor's existing reviewed installer is a separate required step:
`integrations/deploy.zsh 9router-reauth` (the code-only watcher installer).
Do not deploy the entire watcher integration to ship this one watcher.
The local-helpers installer loads/reloads its managed LaunchAgents. For later
guard code updates, restart `com.ardud.9router-log-poll` after copying the code.
The watcher
runner picks up the new supervisor on its next tick. No 9router restart.

Focused checks (run offbox):

```
python3 -I integrations/router-logging/test/test_logging.py
node --test integrations/router-logging/test/*.test.mjs integrations/catalog-guard/test/*.test.mjs integrations/stream-recovery/test/*.test.mjs integrations/robob-watch/checks/9router-claude-reauth/supervisor.test.mjs
```
