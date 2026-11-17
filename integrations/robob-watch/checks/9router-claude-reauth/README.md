# 9router Claude reauth supervisor

Status: **notification-only detection is registered and active**. The parent
removed the deployment hold after review on 2026-11-01. The first real runner
check completed in 0.74 seconds with no pending markers. The current live entry point is hardcoded to
**notification-only detection**: it reads effective markers but cannot launch
a worker, start OAuth, mutate a lease or change credentials. A worker prompt
likewise prohibits reauth or credential writes and returns
`HUMAN_ACTION_REQUIRED`. A local boolean/file or manual confirmation cannot
enable automatic recovery.

The existing 9router exchange accepts `reauthConnectionId` but does not
atomically verify expected identity, active state and marker when it saves the
tokens. A client-side profile check, lease, or recheck cannot prevent another
actor changing the target between check and server write. A source-only fence
under development elsewhere is **not deployed or verified**. A future packet
must obtain owner release approval, deploy the server change, machine-verify
the live API capability/version and exact identity/active/marker binding,
integrate a genuinely fenced request in a fresh build, and test it before this guard is changed.
This packet does not alter or restart 9router.

## Signal and behavior

The notification-only detector GETs `/api/providers`
with local CLI auth every 60 seconds.
The first fetch has a 6-second timeout. Transient timeouts, refused/reset sockets
and HTTP 502/503/504 get one retry after 1 second, bounded at 15 seconds.
Two transient failures skip that tick without changing incidents or pending
notices; the journal keeps the first and last unavailable times and consecutive
count. An ongoing outage is checkpointed before fetching, so a runner-killed
check does not break continuity. A gap over twelve minutes before the next
check starts a fresh streak: five-minute backoff, four-minute queue wait,
90-second runner timeout and 90 seconds of slack. A valid snapshot logs
recovery and resets it.
This watcher never auto-pauses; sustained unavailability fails after 15 minutes.
The runner alerts after two failures; Telegram coalesces reminders to at most hourly.
Auth, JSON and schema errors fail immediately. Retry outcomes and skipped ticks go to the watcher log and
the private 9router tool log; successful ticks emit no wake event.
It selects only `provider=claude`, `authType=oauth`, `isActive=true`, and a
truthy effective `reauthRequiredAt`; the server has already reconciled stale
marks with the current credential fingerprint. No dashboard health labels,
access-token expiry, 429, or raw DB markers trigger a recovery. The check has
no baseline/priming: already-bad rows are processed on the first enabled run.
For each exact connection ID and marker timestamp it records a stable incident
before queuing one Telegram attention directing manual recovery; a healthy
snapshot queues nothing. Dedupe is permanent while its journal remains intact:
if the *same* marker disappears or the account is disabled and then re-enabled,
that marker does not notify again. A different effective marker is a new notice.
This is intentional to avoid repeat alerts, and may suppress a second alert for
the same unresolved incident. The detector preserves existing account budgets
and holds and fails closed if an older worker is still journaled active.

The currently unreachable future recovery design launches one global worker with `ControlClient({component:
"watchers"}).createThread()`, explicit instance `opencode`, model
`opus/cx/gpt-6.1-terra`, variant `max`, `origin=watcher`. Its incident and
idempotency key are atomically journaled before the request; missing/unknown
responses are replayed with the same key, not replaced. The thread ID is the
control server's deterministic `ardud-control:thread:` command ID; it queries
that exact thread before every possible launch replay. Model selection is also
checked against the create and thread responses. The parent reports a safe
synthetic incident using a real ControlClient create, but an overridden inert
`SMOKE_OK` prompt with no tools, fake providers, and isolated temporary state
and lease. Create and thread/run readback showed `opencode` /
`opus/cx/gpt-6.1-terra` / `max`; the reply completed, the synthetic marker
cleared, the lease was released and the smoke thread archived. No real auth
changes, alerts, or real recovery were involved. A **real recovery trigger has
not been tested live**.

Only a conclusively completed original worker can release the active lease.
`running`, `waiting`, `queued`, and `needs-input` are held. A failed,
cancelled, interrupted or rolled-back worker, an unexpected additional run,
or a partial accept (`idle` with no run) remains held with one attention for
manual investigation, even if its marker is gone. Restart recovery source
includes failed, cancelled and interrupted runs; a run may resume later.

The effective marker is read again after completion. Each connection gets at
most three worker attempts across marker changes, disable/re-enable, clears and
restarts, with 5- and 15-minute cooldowns. A changed marker is still bad, not
successful clearance. Exhausted/blocked budgets remain held indefinitely for
operator investigation, not silently reset on recovery. A human-action result or exhaustion
blocks that incident and queues one idempotent Telegram attention. A worker
waiting for input also triggers the same single attention. Each ambiguous
launch is resent at most three times, 60 seconds apart, with the exact same
key; after that the uncertain worker and lease are held for manual attention.
Telegram must report `status=healthy` and `ready`, `paired`, `enabled`, and
`telegramConnected` all true before enqueue. An attention is queued once by
stable dedupe key. Queue acceptance is not delivery: pending/sending are
rechecked each tick together with bridge health; if the bridge is unhealthy or
the alert is still pending/sending at 3 minutes, the check exits nonzero for
robob-watch escalation. The first enqueue attempt is persisted before the call
as a conservative deadline and is never reset on a replay. Legacy pending rows
without a known first enqueue time fail closed; a backwards clock also fails
closed. Independent incidents are processed before returning an error.
`sent` means Telegram accepted it, not that it was read.
Failed/uncertain or missing from the capped 50-row outbox is UNKNOWN and makes
the check fail for independent robob-watch escalation; no new dedupe key or
duplicate alert is issued. If an enqueue reply is lost and the marker clears
before retry, it checks the outbox but does not send a stale alert; a missing
row stays UNKNOWN. Service failures exit nonzero for robob-watch
backoff, not healthy. robob-watch has its own failure alerts in addition to
incident attention when a service stays down. Per-tick queueing is limited to
three new incidents. The detector stops itself at 45 seconds, before the
runner's 90-second limit; remaining incidents are persisted and processed on
later ticks.

If a future fenced implementation enables recovery, the worker is instructed to verify the real account identity independent of
the dashboard label, recheck exact ID and incident before starting and before
reattaching, and send the per-account request with `reauthConnectionId`. After
reauth it must compare a read-only per-token OAuth profile with the intended
identity, then, if feasible, perform one minimal real inference pinned directly
to the same attached token. It rechecks the token and effective marker, never
uses the provider test route or forces refresh, and must not expose credentials
or raw responses. A 429 is rate limiting, not a reason to re-login.

Worker reports retain `REAUTH_RESULT: CLEARED`, `NOT_CLEARED`, or
`HUMAN_ACTION_REQUIRED` for the existing supervisor contract. They also carry
`VERIFICATION_RESULT: VERIFIED_WORKING` or `CLEARED_UNVERIFIED` with a
`VERIFICATION_REASON`; if the marker is not confirmed cleared the result is
`NOT_VERIFIED`. **CLEARED is not VERIFIED_WORKING**: success requires the
identity match, a successful real pinned inference, and a still-enabled,
unchanged, marker-free connection. When verification is unavailable or fails,
the worker reports the applicable reason and must not repeat login. If 429
coincides with the original marker still being present, it returns
`HUMAN_ACTION_REQUIRED` so the supervisor blocks relogin for that incident.
The additional verification lines live in the worker's final report; the
supervisor still decides retries from the effective marker and its existing
human-action result, not from those lines.

It must stop for missing identity or human factor. This is an LLM worker: the
prompt is not an atomic technical guarantee against a change by a separate
actor between recheck and update. All cooperating manual actors must take the
lease and must not skip identity verification.

## Shared manual/auto lease

The lease is the symlink `recovery.lease` in this directory. Its target holds
only a kind and random owner ID, not credentials. Every acquire and release
uses a nonblocking lock on an inherited file descriptor to the permanent
`recovery.lease.guard` lockf file plus atomic symlink
creation; **never delete or replace the guard inode**, and never force-remove an
active lease. No time-based stale-lock stealing is performed. Before *any* new
manual recovery, use the exact protocol below. If acquire fails, wait; do not
open or continue a second flow.

```sh
D="$HOME/.local/share/robob-watch/watchers/9router-claude-reauth"
if ! OWNER=$(node "$D/lease.mjs" acquire-manual); then echo 'Recovery is held; stop.' >&2; else
# Perform only the intended manual login, serially; retain $OWNER.
# Once ALL browser and account mutation work has finished:
node "$D/lease.mjs" release-manual "$OWNER"
fi
```

For visibility, `node "$D/lease.mjs" status`
prints `null` or the owner metadata. If a manual holder crashes, the lease
intentionally remains held; after verifying no manual flow is still active,
the holder can release with its saved OWNER ID. For a damaged/orphaned lease,
an operator must first pause the watcher, verify the associated thread and
browser are actually stopped, and investigate the journal before repairing;
never infer safety from age alone. If a launch was ambiguous and its exact
thread cannot be found, do not release or create another automatically.

## Synthetic verification

```sh
D="$HOME/.local/share/robob-watch/watchers/9router-claude-reauth"
node --test "$D/supervisor.test.mjs"
```

The tests use temporary state, real OS lease primitives, and injected fake
router/control/Telegram functions only; they do not call the live router,
create a thread, deliver notifications, start OAuth, or mutate accounts.
Both `node --test` and `bun test` support this suite. Cases requiring the real
lease primitive run only on macOS with `/usr/bin/lockf`; other hosts report
explicit skips while portable cases still run. Run on macOS for full coverage.
The normal `robob-watch test` uses a scratch directory and is deliberately
refused: a copied check must never accidentally launch or alert. Do not use
`fire-test` for this watcher. The temporary deployment hold has been removed;
do not run the live check by hand or manufacture a real auth failure to test it.

## Parent-controlled registration and enablement

The parent registered this watcher **paused and without priming**, then resumed
the notification-only detector after the safe checks and independent review.
For a new installation only, after verifying no collision or previous live
supervisor worker, the registration command is:

```sh
unset BUN_INSPECT
D="$HOME/.local/share/robob-watch/watchers/9router-claude-reauth"
if [ -e "$D/watcher.json" ]; then
  echo 'Watcher ID already exists; stop.' >&2
else
  robob-watch add --json "$D/watcher-definition.json" --no-prime
  robob-watch show 9router-claude-reauth  # verify paused, 60s, expiry never, max fires 0
fi
```

Registration does not install or restart the Robob engine. The JSON includes
`paused: true` before the runner can observe it; `--no-prime` avoids a real
check during registration. Keep `ENABLE_REQUIRED` throughout registration.
The parent alone may remove the hold and resume **the detector** after review.
That does not enable recovery: both the live server fence and the supervisor
integration are missing. A source-only change or a successful inert smoke is
not evidence of a safe real reauth.

Inspect `supervisor-state.json` (mode 600), `recovery.lease` and Robob's exact
thread via `t3ctl status` when investigating. The journal stores the account
ID, marker timestamp and generated incident/request/lease IDs only: no hashes,
labels, OAuth URLs, codes or tokens. Do not delete or edit the journal while
there may be an active/ambiguous worker. If a blocked incident is resolved by
hand, leave the journal alone. Account-level attempt history is retained even
when a marker disappears, changes, or the account is disabled and re-enabled.
It is not automatically reset; manual intervention rather than auto-looping
is intentional.

Detector dependencies: Node 18+ on the watcher PATH, the local 9router
machine-id and CLI-secret files, port 20128, `/usr/bin/lockf`, and the Telegram
bridge. Detector-only operation does not load the Robob control client or
require the ExternalSSD. A future recovery implementation would also need the
checked-in control client and `watchers` credential. Do not change these
components as part of enabling this watcher.


## Source, timing and installation

The source of truth is `integrations/robob-watch/checks/9router-claude-reauth/`
in the Robob fork. From the repo root, run the isolated tests with:

```sh
node --test integrations/robob-watch/checks/9router-claude-reauth/supervisor.test.mjs
```

The shell records `sh` in `.phase`, retaining the previous marker for Node to
report. Node records `start`, `load`, `providers`, `save`, `telegram:<command>`
and `done`. Provider subphases distinguish credential reads, response headers,
and response body parsing. Each marker is a best-effort plain write without
fsync; it is diagnostic state, not a journal or a recovery lease. A run that
fails by itself, including at the self-deadline, writes `failed` with `at`
naming the phase where it failed. Only a run killed before it could write its
exit marker leaves its last working phase for the next run to report as stalled,
with its age.
Failure messages and phase durations use synchronous stderr writes so the
runner can retain them even when it kills a slow check. The error summary is
last so it survives the runner's 500-character stderr tail. Because the runner
discards successful stderr, a previous-stall warning is also appended directly
to the watcher log. Recovery remains a successful exit: reporting evidence must
not spend another failure or pause the watcher at its failure limit. The `done`
and `failed` markers prevent a stall warning on the next run.

The 45-second timer includes shell-to-Node startup when invoked by `check.sh`.
It does not unref; an unresolved provider promise still fails with the phase
name. Fetch retains a six-second abort across headers and JSON body. Telegram
commands retain an eight-second cap, kill their own spawned process group and
resolve on child exit without waiting for inherited stdout pipes. The whole-run
deadline also cancels an active command. A blocked synchronous filesystem call
or a process starved by the OS cannot run a Node timer: the phase marker is the
backstop when the runner kills that process. No global runner timeout changes.

After review, update this existing watcher under the board's standing install
approval using:

```sh
/usr/bin/python3 -B integrations/robob-watch/checks/9router-claude-reauth/install.py
```

The installer holds the existing `supervisor.lock` inode and atomically copies
its allowlisted code, tests, installer and README, plus the source definition's
`max_consecutive_failures` into the live `watcher.json`. It preserves all other
registration fields, including an existing `timeout_s` (defaults to 90 seconds
when absent), and leaves the journal, marker, lock, lease, deployment hold and
runtime state intact. It neither registers/resumes the watcher nor restarts
the runner.
`watcher-definition.json` is the reference for new registration;
registration remains a separate owner-approved operation. `deploy.zsh
robob-watch` excludes live `watchers/`, so it does not install this check.
Verify code readback and observe natural runner executions after installation;
the refusal of a copied `check.sh` during `robob-watch test` is intentional.
The identity fence and future recovery work in #290 still apply on top of this
notification-only build.
