---
name: robob-watchers
description: Use whenever you'd watch/monitor/wait for something for the owner ("let me know when X", waiting on a reply, deploy, price, email, PR). Set up a durable robob-watch watcher that wakes the agent with context.
---

# Robob watchers

`robob-watch` runs small check commands on a schedule (default every 15s, or within ~1s of a trigger file changing) and, when one prints something, **wakes the agent**: the event arrives as a new turn in whichever iMessage session is live (it follows session rotation and `/new`), together with the context you saved when you set it up. The agent handles it and its reply goes to the owner as usual.

## When to use

Any time the owner wants to hear about something that hasn't happened yet: "tell me when Nik replies", "watch for the Apple order email", "ping me when the deploy is green", "let me know if the price drops under X", "when the PR gets reviewed". Also when *you* are waiting on someone else's reply to continue a task.

Always actually create the watcher in the same turn. Never promise "I'll keep an eye on it" without one; nothing else will wake you. Then tell the owner in one line what you're watching and until when.

## Add one

```bash
robob-watch add --id nik-macbook --title "Nik replied on WhatsApp (MacBook order)" \
  --check 'whatsapp-new-message 971506575224@s.whatsapp.net' \
  --interval 30 \
  --mode wake --expires 14d --max-fires 1 \
  --session CURRENT_SESSION_ID \
  --context-file /path/to/context.txt     # or --context "..."
```

Or `robob-watch add --json file.json` with `{id, title, check, interval_s, mode, context, expires_at ("14d" or ISO), max_fires, serial, triggers, trigger_gap_s, quiet, trip, relays, created_by_session}`. Add `--replace` to redefine an existing id (its state is kept, and since 1 Oct 2026 the prime run is skipped: a replace-prime once swallowed a real Dynamic reply that landed mid-prime).

`add` runs the check once to **prime** it: baseline helpers record what's already there, so old items never fire. Read the `prime` line in the output. If it says "printed (NOT delivered)", your check fires on existing data and needs fixing.

- **id**: short kebab-case, unique (`apple-order-email`, `crpko-deploy-1234`).
- **mode**: `wake` (default) wakes the agent to act. `notify` just texts the event to the owner with no agent involved; use it only for plain FYIs that need no thinking.
- **interval**: default 15s, minimum 5s. Use 10-15s for chat, WhatsApp and email replies (with a trigger, the interval is only a fallback), and 60-300s for web pages, prices and CI. Be kind to rate limits.
- **trigger** (push, preferred for anything local): `--trigger FILE` (repeatable, up to 8) runs the check on the next 1s tick after FILE's mtime or size changes, instead of waiting for the interval. It is rate-limited to one run per 2s, or `trigger_gap_s` in watcher.json for expensive checks. It never overrides a failing watcher's backoff. Busy files change often, so put a cheap gate at the top of the check:
  - iMessage: `~/Library/Messages/chat.db-wal` and `~/Library/Messages/chat.db`. Gate on `select max(message_id) from chat_message_join where chat_id=N` (~5ms) before calling `imsg history`.
  - WhatsApp: nothing to add. A check using `whatsapp-new-message` gets `~/.wacli/wacli.db-wal` + `wacli.db` as triggers automatically (and an old `whatscli/session.db` trigger is swapped out).
  - Your own scripts: touch a file in `$WATCH_DIR` and trigger on it.
  - Remote things (email, web, CI) have no local file. Poll them, or push via a daemon, the way otp-idle does IMAP IDLE for OTPs (agent-mail skill).
- **quiet** (watcher.json only, since 24 Oct 2026): `{"start": 23, "end": 8, "time_zone": "Asia/Dubai"}` holds every event, new or retried, until the window ends (same key, sent once). The check still runs. Use it for nags and reminders that must not land at night.
- **expires**: always set one that fits (hours for a deploy, 1-2 weeks for a human reply). The default is 14d. On expiry the owner gets a short "expired without firing" note.
- **max-fires**: default 1 (fire once, then done). Use `0` (unlimited) or N for ongoing feeds.
- **serial**: set automatically only for checks that drive the legacy whatscli TUI (`wa read/send/...`, `wa tui`). `whatsapp-new-message` and `wa-db` read a database and need no lock.
- **Where latency goes** (measured 30 Sep 2026): runner tick (1s) + trigger or interval wait + check time + bridge pickup. The bridge now starts a wake turn immediately, because watcher wakes skip the 15s owner-typing grace. If the agent is already mid-turn, the wake still waits for that turn to finish, and nothing at the watcher level can change that.

## Writing the context (the important part)

The context is all the woken agent knows. Put what to do on a fire in its first 280 characters: later fires show only that start plus a `robob-watch context <id>` pointer. Write it for a fresh agent with no memory of this chat:

1. **Owner's intent**: what they asked and why ("owner asked Nik on 27 Sep to order X for Y").
2. **Background**: names, numbers, links, what has already been said and to whom.
3. **What to do on fire**: "tell the owner what he said", "if he asks about budget, draft a reply", "check the deploy logs and summarise failures".
4. **What NOT to do**: "don't message Nik or Jashwanth without the owner's OK", "don't merge", "don't buy".

Keep it under ~1500 characters. Never put secrets in it (it's stored in plain text).

## Messaging anyone besides the owner (since 24 Oct 2026)

A watcher whose check or context sends WhatsApp (`wa draft`, `wa send`) can name who it may message with relays; they are optional. Relays give the fire his stops and the ETA throttle, so add them when a watcher messages third parties on his behalf.

- **relays** (watcher.json, optional): `[{"to": "<phone jid, group jid or +number>", "name": "Pam's group", "quote": "<his words allowing it>", "at": "<when he said it>"}]`, up to 8. Only people he named, in his words; with no quote there is no relay. Use the phone jid, not an `@lid` (`wa-db resolve` gives both); relay-ok and relays-off still match a person by either. Stops live outside watcher.json (`watchers/.relay-stops.json`), so no replace, pause or removal of a watcher lifts one; only a grant whose `at` is after the stop does (`at` can't be in the future). `--owner-only` (or `"relays": []`) means the fire tells only the owner. A watcher without a `relays` field has no relay lines in its wake, and `robob-watch add` prints a note on what relays would add. `robob-watch unscoped` lists those watchers for information.
- **trip**: give watchers of one trip or job the same tag (`"trip": "dus-oct"`), so one stop reaches all of them.
- The wake text lists who may hear from the watcher. Before each message to one of them, the agent runs `robob-watch relay-ok <id> --to <jid>` (add `--eta <ISO>` for an ETA change) and sends only on `ok`. It says no to anyone unlisted or stopped, to an ETA that moved less than 15 min since the last one this watcher sent that person, and to more than one ETA update an hour per person (across the trip) unless it moved an hour or more. Sends are counted in `watchers/.relay-sent.json` (a week), so removing a finished watcher doesn't reset what people were told. 23 Oct: ETA flips reached Pam's group and the driver 5-7 times in an evening.
- **"Stop updating X"** (or "stop updating people"): run `robob-watch relays-off <id> [--to <jid>] --quote "<his words>"`. It stops X (or everyone) on every watcher of that trip at once, by name, so retagging one later doesn't free it; grants added later that predate it are covered too. Then tell him it's done and which watchers it covered. Exit 3 means no listed relay matched, and an `@lid` it can't map is refused; check the jid before telling him. Don't ask which flight or watcher he meant.

## Check contract

- A zsh command run in the watcher's dir with `WATCH_DIR` (and `WATCH_ID`) set, PATH including the helpers, a 60s timeout, and no TTY.
- **Nothing new**: print nothing, exit 0. **Event**: print the event text on stdout, exit 0. Print only what's new and keep it short.
- **Non-zero exit** counts as a failure: exponential backoff, and after 5 in a row the owner gets one alert (via Telegram). **Escalation (since 4 Oct 2026):** a `wake` watcher that has been failing for 15+ min also **wakes the agent** once per failure run (source `robob-watch <id> failing`, iMessage text as fallback) with the error and repair steps, and its retries stay at most 5 min apart. If you get one of these: fix the cause (e.g. `wa start`), `robob-watch resume <id>`, confirm with `show`, log it and end with `NO_REPLY` unless something was missed or you can't fix it. A **timeout** is treated as transient: it retries at least every 120s (or the interval, if longer) and alerts only once the watcher has been failing 10+ minutes.
- Keep your own state (baselines, last-seen) in `$WATCH_DIR`. The first run should record a baseline and print nothing.
- An event that can't be delivered is kept and retried with the same key before the check runs again, so nothing is lost or doubled.

## Helpers (on PATH inside checks)

- `whatsapp-new-message JID [--from NAME]`: new incoming (non-"Me:") messages for that person/group since the last run, as `(dd-mm-yy HH:MM:SS) Name: text` lines. Since 1 Oct 2026 it reads **wacli's durable store** (`~/.wacli/wacli.db`, written live by the `com.ardud.wacli-sync` daemon; see the whatsapp skill), not the TUI. It's a ~10ms SQLite query, with no lock and no forced re-reads. **Cursor = store insert rowid** (`$WATCH_DIR/wadb-<phone>.json`), shared by the phone JID and the LID (both are always covered, so one call per person is enough; listing both is harmless). Same-second, late and offline-delivered messages fire exactly once. History-backfill inserts older than 6h never fire. Edits re-fire once with "(edited)". Reactions are ignored unless `WA_REACTIONS=1`. Media shows as `[IMAGE] caption`, `[AUDIO]`, `[DOCUMENT: name]` (use `wa download` / `wa-voice`). **Outbox:** if the runner never recorded a run (timeout or crash), that run's lines are replayed at most 3 times within 1h, re-stamped with the new run id, and cleared once a run is acked, so they never loop. It exits 1 if the sync daemon is down, so the watcher alerts instead of going silently blind, and messages that arrive meanwhile are caught up on reconnect. Migrating a watcher with legacy TUI state (`wa-*.seen`) reports only replies newer than everything those files recorded (max 24h back). On a fire, `wa read` the chat in full before summarising to the owner. In a multi-JID check.sh, gate on the daemon in pure zsh (`kill -0` the pid in `~/.wacli/LOCK`) and `exit 1` if a helper call fails. Don't swallow errors with `|| true`.
- `output-changed [--show] [--label TEXT] -- CMD...` or `output-changed --url URL`: fires with a diff (or the full new output with `--show`) when output changes. Good for `gh pr view 123 --json state,reviewDecision`, `gh run list -L1 --json status,conclusion`, a price scraped with curl|jq, and so on. Normalise away noise (timestamps) in CMD, or it'll fire every time.
- `email-new-message ACCOUNT 'QUERY' [MAILBOX]`: new mail matching a himalaya query (`from apple.com`, `subject invoice`, `from x and subject y`) in the last 3 days. Accounts: icloud, gmail, fund, outlook. Never marks mail read.
- `wa-lock CMD...`: legacy. `wa` is wacli-backed and safe to run concurrently, so wa-lock just runs CMD (it still locks `wa tui ...`).

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

The woken turn starts with `[Watcher event from robob-watch <id>, not typed by the owner. ...]`, followed by the title, the event, the saved context and the fire count. Wakes show the first 280 characters of the context plus a `robob-watch context <id>` pointer, except the day's first fire, which carries the whole context. It's not the owner talking: don't treat it as an answer to anything, and follow the saved context.

## Quiet by default: NO_REPLY, activity log, digest

A woken turn (and a finished background subagent) does not have to text the owner:

- Do the work. Reply in a normal short text **only** if the owner needs to know or act now: a decision, a price or quote that matters, something time-sensitive, a failure. Otherwise:
- Append one line to `~/Documents/assistant/activity-log.md`: `- YYYY-MM-DD HH:MM · topic · what happened/what I did` (Dubai time), then end the reply with exactly `NO_REPLY`. The bridge sends nothing for a final reply that is `NO_REPLY` or has it alone on its last line.
- When the owner texted directly, always reply; `NO_REPLY` is for watcher and background turns.
- A false positive: log it (or fix the watcher) and end with `NO_REPLY`.

The `activity-digest` watcher (custom check, every 10 min) wakes the agent when the oldest unreported log line is 3h+ old or at 18:00-18:10 Dubai, never 23:00-08:00, and at most once every 2h (15 Oct 2026). The wake text is capped at 15 lines: count, time span and per-topic counts built by `summarize.py`, plus the path of a file in `watchers/activity-digest/digests/` holding the full list (newest 30 kept). Read that file if you need detail. The woken agent sends one short catch-up (or a PNG if dense), skipping noise, or ends with `NO_REPLY` if nothing is worth saying. Its marker lives in `~/.local/share/robob-watch/watchers/activity-digest/marker` (count of lines already reported). Write context for your own watchers with this in mind: say what counts as worth a text right away.

**Delivery fallbacks**, in order: bridge `wake` → plain iMessage `send` into the live session (the owner sees the event text, no agent turn) → Telegram notify. Failure and expiry alerts go Telegram-first. `robob-watch logs ID` shows `via=wake` for a normal wake.

**While the agent is busy:** a wake never interrupts the current turn. It queues and runs as its own separate turn right after the current one finishes. It is never batched with the owner's texts and never treated as the answer to a pending question or approval.

**2-minute heads-up (opt-in, off by default since 2026-09-30):** only watchers with `"headsup": true` in watcher.json get this; the owner found raw heads-ups confusing, so leave it off unless he asks. When enabled, the runner tracks each delivered wake (`wakes` in `state.json`). It watches the bridge inbound row `wake:<sha256 of key>`: `pending` means still queued, and anything else means the router has taken it. If the row is still `pending` 120s after delivery (the agent is stuck on a long turn), the owner gets ONE short plain text in the live session: "Heads-up from watcher <title>: <event, truncated>. I'll follow up properly when I'm free." It falls back to Telegram if that send fails, and uses an idempotent key, so it's never sent twice. If the row is consumed before 120s, nothing extra is sent. The log shows `heads-up ... via=...` or `wake ... consumed (...)`. When you pick up a woken turn after a heads-up, the owner already has the gist, so give the proper follow-up without repeating the whole event.

## Manage and clean up

```bash
robob-watch list                  # status, fires, expiry, last run, failures, undelivered events
robob-watch show ID               # definition, state, last 20 log lines
robob-watch logs ID [-n 100]
robob-watch pause ID | resume ID [--expires 7d]   # resume also re-arms a done/expired watcher
robob-watch remove ID             # archived under ~/.local/share/robob-watch/archive/
```

Remove watchers once the thing is resolved, or when the owner says to stop. Done and expired watchers stay listed until removed. Remove them when you notice them.

- Nightly 2026-10-15: `add --json` with `--replace` reads the expiry from the key `expires` (ISO or "14d"), not `expires_at`. Using `expires_at` silently resets it to the 14d default. After a replace, check `watcher.json` `expires_at` and fix it with `robob-watch resume ID --expires <ISO>`.
- Nightly 2026-10-15: an email watcher whose filter changes gets a new seen-file key (`sha256(acct|mbox|query)`). Copy `mail-<oldkey>.seen` and `.seen.init` to the new key before `--replace`, or the new query re-baselines and misses the mail that prompted the change.

## Troubleshooting

- Runner: one LaunchAgent `com.ardud.robob-watch` (KeepAlive, ticks every 1s; each tick is a stat per trigger file plus a JSON read per watcher, about 0% CPU). `robob-watch runner` or `launchctl print gui/$(id -u)/com.ardud.robob-watch`. Log: `~/.local/share/robob-watch/runner.log`. You may restart it: `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.
- **Mass "timed out after 60s" (root cause, 3-4 Oct 2026):** the plist had `ProcessType=Background`, which clamps the runner and every check to background QoS. Under a load spike (Docker tests, emulators, simulators; load 50-110) macOS starves background work for minutes while the UI stays smooth: `taskpolicy -c background` on the trivial `time-reached` check did not finish in 100s (0.1s normally), and a killed check sat runnable with 0s CPU for 9+ min. Now `ProcessType=Standard`. If it comes back, check `ps -o pri -p $(cat ~/.local/share/robob-watch/runner.pid)`: it must be 20+, not 4. Never set Background/Adaptive on this runner.
- Runner behaviour since 4 Oct 2026: at most 6 checks run at once (`ROBOB_WATCH_MAX_CONCURRENT`), and queue time does not count against the 60s timeout. A timeout SIGKILLs the check's whole process group and returns within 5s even if the kernel hasn't reaped it. The bridge sqlite reads are async, so they never freeze other watchers' timers. Each run's duration is stored (`last_run_ms`, shown in `list`), and runs over 15s or queued over 5s are logged as `slow run: check Xs, queued Ys`.
- Email checks: each `email-new-message` call is a fresh himalaya IMAP login (~2.5-3.5s for iCloud). Put several senders into **one** OR query per mailbox (`'from a.com or from b.com or subject X'`) instead of one call per sender. Results match: verified on 4 Oct for insurer-quotes-monika (8 logins down to 1), dynamic-ticket (5 to 2) and monika-insurer-replies (3 to 1). Changing the query changes the seen-file key (`mail-<sha>.seen`), so merge the old seen files into the new one first, or old mail fires again.
- Per-watcher files: `~/.local/share/robob-watch/watchers/<id>/{watcher.json,state.json,log}` plus the check's own state files.
- "wacli sync daemon is not running": `wa status`; restart with `wa start` (kickstarts `com.ardud.wacli-sync`, or bootstraps the plist if it was booted out). The `com.ardud.wacli-guard` LaunchAgent does this by itself every 2 min (log `~/.local/share/wacli/guard.log`), so a long outage means the repair itself fails; check `~/.local/share/wacli/sync.events.log` for `logged_out` (re-pair, see the whatsapp skill). Nothing is lost: the daemon catches up on reconnect and the cursor then delivers.
- A WhatsApp watcher re-firing the same old messages (1 Oct 2026 bug, fixed): check for a stale `wadb-*.json.outbox` in the watcher dir. Pause the watcher, delete `wadb-*` files, run the check once with `WATCH_DIR` set to baseline it, then resume.
- A watcher firing repeatedly on noise: fix the check (normalise its output), then `--replace`.
- Flaky local CLIs (`imsg history` stalls for 25s+ now and then; since 3 Oct 2026 imsg 0.15.3 takes 1.5-3s even when healthy against the 360MB chat.db, so never set a per-call cap under ~9s — a 2.5s cap made the Moni watcher time out most calls and wake 3-4 min late; a stalled call rarely recovers, but a fresh one usually works): in custom checks, gate on a cheap local read first, then use a per-call timeout well above the healthy time (9s) with a few retries, keep the whole check under 60s, and treat a transient stall as "nothing new" (exit 0, cursor unchanged, so nothing is lost). Exit non-zero only if the stall lasts about 10 min or more. For LLM classifier calls (jev), fail open. Example: `watchers/moni-robob-requests/classify.py`.
- **iMessage history: read chat.db, not `imsg history`** (3 Oct 2026: `imsg history` stalled 20+ min and the Moni watcher went blind, missing her requests). Query `message` + `chat_message_join` + `attachment` read-only (~10ms), decoding `attributedBody` when `text` is NULL. Keep imsg only as a fallback. Reference: `sqlite_history()` in `watchers/moni-robob-requests/classify.py`.
- A check that can be killed at 60s never advances its cursor, so it loops failing and nothing is delivered (moni-robob-requests, 3 Oct: Moni's order was lost for 20+ min). Give classifier checks an internal SIGALRM budget (~35s) that forwards everything fail-open, and log slow stages. See `watchers/moni-robob-requests/classify.py` (`CLASSIFY_BUDGET_S`, `stage()`).
- iMessage "who sent this?" (robob vs Abdullah, same account): `reply_to_guid` is NOT a signal (Abdullah's iPhone sets it too since late Sep 2026; that mislabel made the Moni classifier wake on her replies to him). Use the helper `imsg_robob_sent.py` (`attribute(msgs, cache)` in Python, or `imsg-history-json | imsg_robob_sent.py`), which matches outgoing messages against the assistant's real send tool calls in the OpenCode DB. Verdicts: robob / abdullah / unknown (DB unreadable).
- Source: Robob fork `/Volumes/ExternalSSD/t3code-fork/integrations/robob-watch/src/{lib,runner,cli}.ts` (tests: `bun test` there; deploy with `integrations/deploy.zsh robob-watch`, live copy `~/.local/share/robob-watch`). The bridge side (`wake`) lives in the same fork under `integrations/spectrum-bridge`.
