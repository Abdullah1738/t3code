# Robob stall notifications

Runs `t3ctl health --deep --json` every two minutes. Three or more separate UTC
minutes with a recorded stall of at least five seconds in the trailing ten
minutes queue a Telegram notification. One alert per UTC hour, keyed
`robob-stall:YYYY-MM-DDTHH`. Recovery queues once after ten minutes without a
five-second stall, complete sampler coverage, and a healthy verdict with a state read under two seconds.

The check sends Telegram directly and prints nothing to stdout. It never wakes
an agent. `stall-state.json` holds the last alert, active incident and pending
notification. The exact pending key and text survive failed acknowledgements.
Queue acceptance is not a delivery receipt. `robob-watch test` and registration
priming are dry runs: scratch tests have no `WATCH_RUN`, and primes have a `prime-` prefix. Both only report on stderr.

The lag log now includes quiet-sample heartbeats. The CLI reads at most 2 MiB
across the current file and its single rotation. A gap over 60 seconds, missing
log, malformed records or insufficient ten-minute history produces `unknown`
(exit 1); timeout or three recorded five-second stalls produces `stalled`
(exit 2). The existing stall warning threshold remains over two seconds, so
one-second counts describe recorded stalls, not every delay over one second.
The round trip proves an authenticated state read. It does not prove a write.
#1124 owns server readiness; its route is not yet available.

Installation requires owner approval. From the merged checkout, copy
`check.mjs`, executable `check.sh` and `watcher.json` into the private directory
`~/.local/share/robob-watch/watchers/robob-stall/`, preserving any existing
`stall-state.json`. Register with `robob-watch add --json <copied-watcher.json>
--no-prime` (add `--replace` only on an update). The definition has no expiry,
unlimited runs, a 120-second interval and an SSD dependency. No LaunchAgent
restart is needed. The check uses the installed `~/.local/bin/t3ctl`, which must
first be updated to include `deep-health.mjs` beside `t3ctl.mjs` and `client.mjs`.
Do not overwrite an old source worktree by hand; select the merged CLI source.

The server heartbeat requires a separately approved Robob release. Until that
build is running, quiet periods remain `unknown`, and recovery is suppressed
without complete sampling evidence. Local lag is used only when the target listener and boot match the persisted runtime; other targets remain unknown. Do not infer recovery from HTTP 200.

After approval and installation, run `robob-watch test robob-stall`, inspect
`robob-watch show robob-stall`, then inspect its log after the first scheduled
tick. No stdout event, no fire count and no agent wake are expected. A stall
notification is sent on the first tick if its window already qualifies; there
is no silent baseline. Verify queued Telegram notifications with the bridge's
`notifications` command if an incident is active.

Focused tests (no real messages or live database access):

```
node --test apps/server/src/ardud/control/deep-health.test.mjs integrations/robob-watch/checks/robob-stall/check.test.mjs
vp test run apps/server/src/observability/EventLoopMonitor.test.ts apps/server/src/ardud/control/t3ctl.test.ts
```
