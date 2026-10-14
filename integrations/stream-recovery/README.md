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
   - skips archived threads, crw review threads (crw owns them), threads that
     recovered on their own with nothing pending, and stale sessions;
   - finds user messages that never reached OpenCode (by Robob prompt ids
     `msg_t3_turn_<ses>:<attempt>` / `msg_t3_steer_<ses>:<message>`), replies
     OpenCode made that Robob never showed, orphaned subagents (still running or
     finished after the drop), pending OpenCode forms, and held queued runs;
   - cancels held queued runs older than 24h before the drop, resumes the
     thread's queue (`queue.resume` over the Robob WS RPC), and sends one note to
     the thread (control API, mode auto, idempotent `clientRequestId`) listing
     what it lost and asking it to pick up where it was.
   - iMessage threads get no note; they show up in the Telegram summary.
3. Sends one Telegram summary per incident (`stream-recovery:<incident id>`).

Handled incidents are recorded in `~/.local/share/stream-recovery/data/state.json`.
An incident that hit errors is retried on later scans, up to 3 attempts.

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
  through Robob (`POST /threads/:id/interrupt`). If OpenCode is still running
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

Stalls are kept in the same state file (`watch`, `stalls`).

## Commands

```bash
node cli.mjs scan [--dry-run] [--since ISO] [--max-age-hours 6] [--seed] [--json] [--verbose]
node cli.mjs status
```

- `--dry-run` shows the plan without sending anything or touching state.
- `--seed` marks every incident found as handled without acting, and skips the
  stall watch.
- Use `STREAM_RECOVERY_DATA=<dir>` to dry-run against a scratch state dir.

## Install

```bash
integrations/deploy.zsh stream-recovery
node ~/.local/share/stream-recovery/cli.mjs scan --seed --max-age-hours 72
cp integrations/stream-recovery/scripts/com.ardud.stream-recovery.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.stream-recovery.plist
```

Runs every 60s, log `~/Library/Logs/stream-recovery.log`. Disable with
`launchctl bootout gui/$(id -u)/com.ardud.stream-recovery`.

Tests: `node --test test/*.test.mjs`.
