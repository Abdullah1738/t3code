# stream-recovery

Detects and cleans up after "The OpenCode event stream was lost and could not
reconnect." incidents.

When Robob's OpenCode adapter loses the shared event stream it calls `failAll`:
every running turn is marked failed, running background subagents are marked
failed and their completion wakes are dropped, and any queued messages behind a
failed turn get held. OpenCode itself usually keeps working, so the damage is on
the Robob side: threads look dead, replies made after the drop are invisible,
messages sent around the drop may never have reached OpenCode, and held queues
block every later queued message.

## What a scan does

1. Reads failed runs and failed subagents from `~/.robob/userdata/statev2.sqlite`
   (read-only) and groups them into incidents: a cluster with a stream-lost
   error, or a burst of 3+ subagents failed within 2s with no result.
2. Waits 90s after the last failure, then per affected thread (failed-run
   threads plus the top-level parents of lost subagents):
    - skips archived threads, threads that
     recovered on their own with nothing pending, and stale sessions;
   - finds user messages that never reached OpenCode (by Robob prompt ids
     `msg_t3_turn_<ses>:<attempt>` / `msg_t3_steer_<ses>:<message>`), replies
     OpenCode made that Robob never showed, orphaned subagents (still running or
     finished after the drop), pending OpenCode forms, and held queued runs;
    - cancels only verified held coordination pulses older than 24h before the drop, resumes the
     thread's queue (`queue.resume` over the Robob WS RPC), and sends one note to
      the thread (control API, mode queue, idempotent `clientRequestId`) listing
     what it lost and asking it to pick up where it was.
   - iMessage threads get no note; they show up in the Telegram summary.
3. Sends one Telegram summary per incident (`stream-recovery:<incident id>`).

Handled incidents are recorded in `~/.local/share/stream-recovery/data/state.json`.
An incident that hit errors is retried on later scans, up to 3 attempts.

## Restart watch

A Robob restart (app update, crash, install) runs startup recovery, which marks
every native background subagent Robob still had open as `cancelled` with no
result. Their wake-ups never come, so parents sit idle or start over. Each scan
also looks for those:

- Reads `cancelled` provider-native subagents and top-level `cancelled`/`failed`
  runs (statev2, read-only), plus `interrupted` runs and native subagents whose turn has no
  `run_interrupt_request` item: an OpenCode crash leaves turns that way (31 Oct, SIGBUS),
  while every Stop writes that item first. Cancelled queued messages and user Stops are excluded. A cluster
  (rows <= 10s apart) is a restart when it has 3+ rows across 2+ top-level
  thread trees, or when any row falls in a Robob/OpenCode server start window.
  Own turns in that window get recovered even when no children were running.
- Server start signal: `~/.robob/userdata/server-runtime.json` (`pid`,
  `startedAt` = ready time, written after startup recovery) plus the process
  start from `ps -o lstart=`. Scans keep a short history in `state.servers`;
  the window runs from the last scan that saw the previous server (so shutdown
  cancels count) or process start minus 60s, to ready plus 60s.
  OpenCode's LaunchAgent PID and process start supply its independent window.
- Not a restart: a user Stop (its turn has a `run_interrupt_request` item), a
  burst inside one thread tree, delegated `task_cancel` (app-owned rows), and
  sessions the stall watch interrupted itself.
- Fast (owner, 1 Nov): scans run every 15s and act 20s after the last cancel
  (`RESTART_SETTLE_MS`), so a cut thread gets its note within about 35s of
  Robob being back. Threads Robob already continued are busy and skipped. The
  installer's `pending.json` no longer holds notes back. The incident stays
  open until the restart window has closed, so a run cut late still joins it.
  The stall watch inside the same scan keeps a once-a-minute pace
  (`lastStallScan`).
- Per lost subagent: re-dispatched (same session resumed, or same title with a
  `(resume)`-style suffix), still running, finished (result never delivered,
  or delivered: in Robob or in the parent's OpenCode history after a later
  turn), cut, or stale (idle 6h+ before the restart).
- One note per affected idle thread, including crw and handed-off parents (control API, mode queue,
  `clientRequestId` = incident id) listing title, model, child session, start
  time, and the original prompt (statev2 `payload.prompt`) or the finished
  result, and asking it to resume each cut one by session id. Handled children
  are still listed so a parent can pass them to its replacement thread. Notes
  explain that macOS boot wipes `$TMPDIR`, including `$TMPDIR/opencode`.
  Archived threads and threads stopped since the restart get no note;
  iMessage threads are reported in the summary.
- Rechecks active turns in both Robob and OpenCode before mutations. Fresh
  turns are deferred until idle; queue delivery cannot interrupt or steer a racing turn.
  The hold-back lasts 30 min from when Robob was ready again
  (`RESTART_RESUME_WINDOW_MS`). A thread that goes idle inside the window gets
  the note (a coord wake in between does not tell it its turn was cut). After
  the window, a thread that is still busy or has started a run since its cut
  counts as resumed by itself: no note, but its held queue is still released.
  A note already sent is never re-sent or relabelled.
  Per-thread progress and the durable message receipt prevent resends after
  partial failures. Restart failures are excluded from the stream-loss scan.
- Cancels held `[coord]` messages older than 2h with a verified `coord:`
  client-request namespace, lists them in the note, and resumes the remaining
  queue with idempotent commands. Other messages, including legacy lane pulses
  without verifiable provenance, are preserved regardless of age.
- One Telegram summary per restart (`stream-recovery:rs-<time>`), sent once
  every affected thread has settled. It names each thread (up to 12 per line)
  under noted, resumed by themselves, queue released and skipped (with the
  reason), plus iMessage reports, queues still held and errors. A thread Robob
  cannot find is retried 3 scans first. Finished incidents keep only per-thread
  flags in state. Incident ids start `rs-`.

## Stall watch

Every scan also checks the sessions OpenCode reports as running
(`/api/session/active`) for ones that stopped moving without failing, e.g. a
model stream that died mid tool call and left the session "running" for hours.

- It fingerprints each session's newest two messages. Text and reasoning parts
  carry no timestamps, so the quiet clock starts at the later of the first
  scan that saw the current fingerprint and the newest timestamp in it. A
  freshly started watcher therefore needs a full limit before it acts, and a
  dry run against a scratch state dir never finds a stall.
- Limits: 30 min when waiting on the model (twice the opus `chunkTimeout`). A
  running shell gets its own `timeout` (default 2 min) plus 30 min, or 8h when
  its timeout is off. Other running tools and subagents get 2h, since a running
  tool's output never shows up in the message. Sessions waiting on a question,
  form or permission are never touched, and neither is a parent whose subagent
  session is still active.
- A stuck session that is its Robob thread's current session is interrupted
  through Robob (`POST /threads/:id/interrupt`, `expectedRunId` guards the
  observed run). If OpenCode is still running
  2 min later, it is interrupted in OpenCode directly. When Robob has no run to
  stop, OpenCode is interrupted right away. Subagent sessions, unmapped
  sessions and old sessions of a thread that moved on are interrupted in
  OpenCode only.
- Once Robob's run and OpenCode's session have both let go, a thread whose run
  was interrupted gets a note telling it to carry on. crw, iMessage and
  archived threads get none (crw nudges its own jobs once they are idle).
- One Telegram summary per stall (`stream-recovery:st-<ses>-<quiet start>`):
  info when cleared, error when it is still stuck 10 min after the interrupt.
  After 3 interrupts of one session in 24h it only reports.
- A Robob thread that shows a run as running for 15 min while its OpenCode session is not active and has no message from the last 15 min (the turn never reached OpenCode, as on #433 after the 29 Oct restart) is interrupted through Robob, gets the carry-on note (not crw/iMessage) and one Telegram summary. It waits while the installer's resume is pending and only reports after 3 interrupts of a session in 24h. Ghost candidates are kept under `ghosts` in the state file.

Stalls are kept in the same state file (`watch`, `stalls`, `servers`, `ghosts`).

## Harness cutover and installer protocol

Recovery reads authenticated `GET /api/ardud/control/harness-cutover/status`:

```json
{"ok":true,"cutover":{"active":true,"completed":false,"claimedThreadIds":["thread-id"],"claimedRunIds":["source-run-id"]}}
```

`claimedRuns: [{threadId, runId}]` is also accepted. While active, claimed threads
get no restart/stream-loss note, stall interruption, or queue release. Retained
run claims suppress only the old cut runs after completion, not future restarts
of those threads. Status must expose prepared input claims before ledger creation;
missing/invalid/unauthorized status fails closed rather than assuming no claims.
Claims are rechecked before mutation. The server must establish preparation before
recovery starts, and fence dispatch against its cutover ledger to close a claim
arriving between the last GET and the mutation.

Only an explicit OpenCode provider binding/selection plus a valid `ses_` ID can
be a ghost candidate. A stale OpenCode alias on a Claude/Codex selection is not
OpenCode liveness evidence. Native IDs never reach OpenCode session APIs; native
child outcomes without a provider-neutral proof are labelled unknown, not cut.
Robob restart recovery can resume native-only incidents without OpenCode being up.
Native stall/ghost intervention remains disabled until authoritative native
progress and guarded interruption are available.

The source-controlled preparation helper uses only control API reads, validates
the exact stopped-card manifest, and atomically publishes a private version-1
input. It refuses truncated active-thread lists, missing source run IDs and
replacement of a different existing input. Run immediately before the installer's
snapshot/restart, with dispatch already paused/drained by the coordinator:

```bash
T3_CONTROL_TOKEN_FILE="$HOME/.robob/components/t3ctl.json" \
  node /Volumes/ExternalSSD/t3code-fork/integrations/stream-recovery/scripts/prepare-cutover.mjs \
  --stopped-cards /Users/ardud/.robob/reports/perf-arch-20261105/stopped-cards.json
```

Default output is `~/.robob/harness-cutover-input.json`; use `--output` for a
non-default server base directory. `--dry-run` validates without writing.
The input is `{version:1, stoppedCards:[{n,stage,id,thread}],
interruptedThreads:[{threadId,runId}]}`. Queue-only roots with no current run and
child threads are not interrupted roots. The helper does not pause dispatch,
restart, launch turns, change board state, or read a database.

The untracked desktop installer must call the helper **before** its snapshot,
then classify the pending snapshot before any generic resume:

```bash
T3_CONTROL_TOKEN_FILE="$HOME/.robob/components/t3ctl.json" \
  node /Volumes/ExternalSSD/t3code-fork/integrations/stream-recovery/scripts/installer-resume-plan.mjs \
  "$HOME/.robob/restart-snapshots/pending.json"
```

Only `resumeThreadIds` may get its generic message. Keep
`cutoverPendingThreadIds` and `unresolvedThreadIds` in pending.json; remove
`cutoverCompletedThreadIds` without sending. A nonzero helper exit means no
generic sends and no clearing pending.json. Preserve source `activeRunId` (or
`latestRunId` for waiting roots) in the installer snapshot; completed claims
without a matching source run are unresolved, not permission to resume. Recheck
the plan immediately before each generic send. The retired Missions endpoint
is not an ownership check. The helper accepts a second status-fixture path for
offline installer tests; normal use fetches authenticated status.

Preparation and status claims are required before installing these recovery
changes. Deploying them against a server without status intentionally holds
recovery. Existing runtime DB reads in `lib/io.mjs` are unchanged by this protocol;
the separate read-replica/API migration must remove those before live use under
the new storage architecture.

## Commands

```bash
node cli.mjs scan [--dry-run] [--since ISO] [--max-age-hours 6] [--seed] [--json] [--verbose]
node cli.mjs status
```

- `--dry-run` shows the plan without sending anything or touching state.
- `--seed` marks every incident found (stream drops and restarts) as handled
  without acting, and skips the stall watch.
- Use `STREAM_RECOVERY_DATA=<dir>` to dry-run against a scratch state dir.

## Install

```bash
integrations/deploy.zsh stream-recovery
node ~/.local/share/stream-recovery/cli.mjs scan --seed --max-age-hours 72
cp integrations/stream-recovery/scripts/com.ardud.stream-recovery.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.stream-recovery.plist
```

Runs every 15s (stall watch once a minute), log `~/Library/Logs/stream-recovery.log`. Disable with
`launchctl bootout gui/$(id -u)/com.ardud.stream-recovery`.

Tests: `node --test test/*.test.mjs`.
