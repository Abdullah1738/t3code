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

## Commands

```bash
node cli.mjs scan [--dry-run] [--since ISO] [--max-age-hours 6] [--seed] [--json] [--verbose]
node cli.mjs status
```

- `--dry-run` shows the plan without sending anything or touching state.
- `--seed` marks every incident found as handled without acting.
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
