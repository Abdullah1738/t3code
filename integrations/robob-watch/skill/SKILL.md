---
name: robob-watchers
description: Use whenever you'd watch/monitor/wait for something for the owner ("let me know when X", waiting on a reply, deploy, price, email, PR). Set up a durable robob-watch watcher that wakes the agent with context.
---

# Robob watchers

`robob-watch` runs small check commands on a schedule (default every 30s) and, when one prints something, **wakes the agent**: the event arrives as a new turn in whichever iMessage session is live (it follows session rotation and `/new`), together with the context you saved when you set it up. The agent handles it and its reply goes to the owner as usual.

## When to use

Any time the owner wants to hear about something that hasn't happened yet: "tell me when Nik replies", "watch for the Apple order email", "ping me when the deploy is green", "let me know if the price drops under X", "when the PR gets reviewed". Also when *you* are waiting on someone else's reply to continue a task.

Always actually create the watcher in the same turn. Never promise "I'll keep an eye on it" without one; nothing else will wake you. Then tell the owner in one line what you're watching and until when.

## Add one

```bash
robob-watch add --id nik-macbook --title "Nik replied on WhatsApp (MacBook order)" \
  --check 'whatsapp-new-message 971506575224@s.whatsapp.net' \
  --interval 30 --mode wake --expires 14d --max-fires 1 \
  --session CURRENT_SESSION_ID \
  --context-file /path/to/context.txt     # or --context "..."
```

Or `robob-watch add --json file.json` with `{id, title, check, interval_s, mode, context, expires_at ("14d" or ISO), max_fires, serial, created_by_session}`. Add `--replace` to redefine an existing id (its state is kept).

`add` runs the check once to **prime** it: baseline helpers record what's already there, so old items never fire. Read the `prime` line in the output. If it says "printed (NOT delivered)", your check fires on existing data and needs fixing.

- **id**: short kebab-case, unique (`apple-order-email`, `crpko-deploy-1234`).
- **mode**: `wake` (default) wakes the agent to act. `notify` just texts the event to the owner with no agent involved; use it only for plain FYIs that need no thinking.
- **interval**: 30s for messages and replies, 60-300s for web pages, prices and CI. The minimum is 10s. Be kind to rate limits.
- **expires**: always set one that fits (hours for a deploy, 1-2 weeks for a human reply). The default is 14d. On expiry the owner gets a short "expired without firing" note.
- **max-fires**: default 1 (fire once, then done). Use `0` (unlimited) or N for ongoing feeds.
- **serial**: set automatically when the check uses `wa`/`whatsapp-new-message`. Serial checks share one lock.

## Writing the context (the important part)

The context is all the woken agent knows. Write it for a fresh agent with no memory of this chat:

1. **Owner's intent**: what they asked and why ("owner asked Nik on 27 Sep to order X for Y").
2. **Background**: names, numbers, links, what has already been said and to whom.
3. **What to do on fire**: "tell the owner what he said", "if he asks about budget, draft a reply", "check the deploy logs and summarise failures".
4. **What NOT to do**: "don't message Nik or Jashwanth without the owner's OK", "don't merge", "don't buy".

Keep it under ~1500 characters. Never put secrets in it (it's stored in plain text).

## Check contract

- A zsh command run in the watcher's dir with `WATCH_DIR` (and `WATCH_ID`) set, PATH including the helpers, a 60s timeout, and no TTY.
- **Nothing new**: print nothing, exit 0. **Event**: print the event text on stdout, exit 0. Print only what's new and keep it short.
- **Non-zero exit** counts as a failure: exponential backoff, and after 5 in a row the owner gets one alert (via Telegram).
- Keep your own state (baselines, last-seen) in `$WATCH_DIR`. The first run should record a baseline and print nothing.
- An event that can't be delivered is kept and retried with the same key before the check runs again, so nothing is lost or doubled.

## Helpers (on PATH inside checks)

- `whatsapp-new-message JID [--from NAME]`: new incoming (non-"Me:") messages in one chat since the last run. Resolve the JID with `wa find`. Multi-line messages are joined with " / " (fixed 29 Sep 2026; before that only the first line was reported). On a fire, still `wa read` the chat in full before summarising to the owner. It takes the WhatsApp lock itself. **Gotcha:** one contact can have two chats, a phone JID (`...@s.whatsapp.net`) and a LID (`...@lid`), and replies often land in the LID chat even when we sent to the phone JID. `wa find NAME` lists both; watch every JID for that person (a small check.sh that runs the helper once per JID).
- `output-changed [--show] [--label TEXT] -- CMD...` or `output-changed --url URL`: fires with a diff (or the full new output with `--show`) when output changes. Good for `gh pr view 123 --json state,reviewDecision`, `gh run list -L1 --json status,conclusion`, a price scraped with curl|jq, and so on. Normalise away noise (timestamps) in CMD, or it'll fire every time.
- `email-new-message ACCOUNT 'QUERY' [MAILBOX]`: new mail matching a himalaya query (`from apple.com`, `subject invoice`, `from x and subject y`) in the last 3 days. Accounts: icloud, gmail, fund, outlook. Never marks mail read.
- `wa-lock CMD...` (also in ~/.local/bin): run any `wa` command under the shared WhatsApp lock. Use it for your own interactive `wa` calls while watchers are live, since the TUI can't be driven concurrently.

Custom checks: write a small script to `~/.local/share/robob-watch/watchers/<id>/check.sh` (after `add`, or create the dir first), `chmod +x`, and use `--check ./check.sh`. Test it with `robob-watch test <id>`.

## Reminders asked for over iMessage

When the owner asks for a reminder **in the iMessage chat** ("remind me at 6 to call X", "remind me tomorrow about Y"), make a robob-watch watcher, **not** a Telegram reminder. Telegram `remind` is only for requests that come from elsewhere or that he explicitly wants on Telegram.

```bash
robob-watch add --id remind-call-x --title "Reminder: call X" \
  --check "time-reached 2026-10-01T18:00:00+04:00 'Reminder: call X about the lease'" \
  --interval 30 --mode wake --expires 3d --max-fires 1 --session CURRENT_SESSION_ID \
  --context "Owner asked on iMessage (date) to be reminded to call X about the lease."
```

- `time-reached ISO [TEXT]` prints TEXT once the time has passed (Asia/Dubai offset +04:00) and nothing before.
- Always use `--mode wake` (owner's choice): the reminder arrives as an agent turn with the saved context, and the agent sends the reminder text and adds anything useful (current status, a draft, a link). Write the context so the woken agent knows exactly what to remind him of and what, if anything, to check first. `notify` only if he explicitly wants a bare text.
- Expiry must be after the due time (a day or more of slack). A Mac that is asleep/off delivers it late on the next tick.
- Confirm to the owner in one line with the exact time. Cancel with `robob-watch remove ID`; move with `add --replace`.

## Test before you rely on it

```bash
robob-watch test ID        # runs the check once on a scratch copy of its state; nothing delivered, state untouched
robob-watch fire-test ID   # sends a clearly-marked test event through the real delivery path
```

Use `test` every time. Use `fire-test` only when the delivery path itself is in doubt: it produces a real iMessage turn or text.

## What a fire looks like

The woken turn starts with `[Watcher event from robob-watch <id>, not typed by the owner. ...]`, followed by the title, the event, the saved context and the fire count. It's not the owner talking: don't treat it as an answer to anything, and follow the saved context.

## Quiet by default: NO_REPLY, activity log, digest

A woken turn (and a finished background subagent) does not have to text the owner:

- Do the work. Reply in a normal short text **only** if the owner needs to know or act now: a decision, a price or quote that matters, something time-sensitive, a failure. Otherwise:
- Append one line to `~/Documents/assistant/activity-log.md`: `- YYYY-MM-DD HH:MM · topic · what happened/what I did` (Dubai time), then end the reply with exactly `NO_REPLY`. The bridge sends nothing for a final reply that is `NO_REPLY` or has it alone on its last line.
- When the owner texted directly, always reply; `NO_REPLY` is for watcher and background turns.
- A false positive: log it (or fix the watcher) and end with `NO_REPLY`.

The `activity-digest` watcher (custom check, every 10 min) wakes the agent with unreported log lines when the oldest is 3h+ old or at 18:00-18:10 Dubai, never 23:00-08:00. The woken agent sends one short catch-up (or a PNG if dense), skipping noise, or ends with `NO_REPLY` if nothing is worth saying. Its marker lives in `~/.local/share/robob-watch/watchers/activity-digest/marker` (count of lines already reported). Write context for your own watchers with this in mind: say what counts as worth a text right away.

**Delivery fallbacks**, in order: bridge `wake` → plain iMessage `send` into the live session (the owner sees the event text, no agent turn) → Telegram notify. Failure and expiry alerts go Telegram-first. `robob-watch logs ID` shows `via=wake` for a normal wake.

**While the agent is busy:** a wake never interrupts the current turn. It queues and runs as its own separate turn right after the current one finishes. It is never batched with the owner's texts and never treated as the answer to a pending question or approval.

**2-minute heads-up:** the runner tracks each delivered wake (`wakes` in `state.json`). It watches the bridge inbound row `wake:<sha256 of key>`: `pending` means still queued, and anything else means the router has taken it. If the row is still `pending` 120s after delivery (the agent is stuck on a long turn), the owner gets ONE short plain text in the live session: "Heads-up from watcher <title>: <event, truncated>. I'll follow up properly when I'm free." It falls back to Telegram if that send fails, and uses an idempotent key, so it's never sent twice. If the row is consumed before 120s, nothing extra is sent. The log shows `heads-up ... via=...` or `wake ... consumed (...)`. When you pick up a woken turn after a heads-up, the owner already has the gist, so give the proper follow-up without repeating the whole event.

## Manage and clean up

```bash
robob-watch list                  # status, fires, expiry, last run, failures, undelivered events
robob-watch show ID               # definition, state, last 20 log lines
robob-watch logs ID [-n 100]
robob-watch pause ID | resume ID [--expires 7d]   # resume also re-arms a done/expired watcher
robob-watch remove ID             # archived under ~/.local/share/robob-watch/archive/
```

Remove watchers once the thing is resolved, or when the owner says to stop. Done and expired watchers stay listed until removed. Remove them when you notice them.

## Troubleshooting

- Runner: one LaunchAgent `com.ardud.robob-watch` (KeepAlive, ticks every 10s). `robob-watch runner` or `launchctl print gui/$(id -u)/com.ardud.robob-watch`. Log: `~/.local/share/robob-watch/runner.log`. You may restart it: `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.
- Per-watcher files: `~/.local/share/robob-watch/watchers/<id>/{watcher.json,state.json,log}` plus the check's own state files.
- "wa read returned no messages": WhatsApp is disconnected or re-linking. See the whatsapp skill (`wa status`).
- A watcher firing repeatedly on noise: fix the check (normalise its output), then `--replace`.
- Source: `~/.local/share/robob-watch/src/{lib,runner,cli}.ts`. Tests: `cd ~/.local/share/robob-watch && bun test`. The bridge side (`wake`) lives in the OpenChamber fork under `integrations/spectrum-bridge` (see openchamber-modifications).
