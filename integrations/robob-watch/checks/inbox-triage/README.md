# Inbox triage

Read-only INBOX mail, WhatsApp and iMessage/SMS collection every **300 seconds**. Free filters precede one Haiku call per nonempty batch. Only hits wake the live owner iMessage session for full-message review. Urgent security, crypto withdrawal, card and driver items also go to Telegram when bridge health says the chat cannot process them. There is no quiet window.

## Install or update

Requires the existing robob-watch runner, mailsearch/mail_oauth authentication, wa-db helper, read access to the chat stores and the existing OpenRouter key. Configure local identities before enabling a fresh installation:

1. Create `~/Documents/assistant/inbox-triage/settings.json` from `settings.template.json`. Set the self WhatsApp JID, group mention names and excluded iMessage chat IDs/identifiers (self-chat and chats already handled elsewhere); set `configured` to true. Chats with a Robob line in them are skipped by themselves: the line comes from the bridge's `sendblueNumber` in `~/.config/spectrum-bridge/config.json`, plus any extra numbers in `robob_lines`.
2. From this directory run `/usr/bin/python3 -B install.py`. It copies only the named source files and registers `watcher.json`. Missing prefs/noise files are seeded from templates; existing files are preserved.
3. Run `unset BUN_INSPECT` then `robob-watch test inbox-triage` and `robob-watch show inbox-triage`.

This package lives under `checks/` because `integrations/deploy.zsh robob-watch` intentionally excludes the live `watchers/` state tree. Its dedicated installer updates only this check, not the runner or unrelated integrations. No service restart is needed: the runner reads the definition each tick and each check starts a fresh process.

The installer waits for `check.lock` (65 seconds maximum), atomically replaces source files and preserves the lock inode. It never copies/deletes cursors, queues, outboxes, run logs, credentials or local settings/preferences. Existing paused state is preserved. New installs baseline at their first run; upgrades keep all cursors.

## Execution bounds and recovery

- Accounts run concurrently, each with a 25-second total budget including one transient retry. Mail workers have a 19-second alarm and save fully processed prefixes when a batch runs long.
- Classification has a 20-second wall-clock budget, cut so it answers by second 44 of the run. The chat follow-up checks stop starting items at seconds 32 (before classifying) and 46 (after); items they don't reach stay candidates and `answer_check_errors` says so. With no time left the batch goes to manual review without a call. The runner kills the whole check process group at 60 seconds, well below the five-minute cadence.
- `check.lock` prevents overlap; a separate `dry-run.lock` means replay diagnostics cannot suppress a scheduled check. Contention exits 75 so the runner cannot overwrite a prior output acknowledgement. Installation registers paused under the lock and resumes after release.
- OTP context is checked across the whole message before redacting preview fields. FETCH literals must have valid UIDs; omitted messages are confirmed expunged before the cursor can advance past them.
- Atomic cursor + candidate queue writes happen before classification. Hits commit to an outbox before stdout; the runner's `.run-ok` acknowledges them. Failed sources retain their last successful cursor. Model failures become manual-review candidates without a second call.
- A chat message is dropped once it has been dealt with: its chat has a Robob line in it (`robob_chat`), or it was answered. In a direct chat a later message or tapback from the owner, or from a Robob line, counts. In a group only a swipe reply or tapback on that very message counts, since he may be talking to someone else. Failed, unsent, retracted, revoked or removed follow-ups never count. Both are checked against the live stores when the batch is built, again after classifying, and once more if an unacknowledged wake is replayed (the replayed wake is rebuilt from the batch file as it stands), so a candidate that was already queued still gets dropped. If that replay check took more than 3 s and cleared the whole batch, the run stops there and the next run collects. Mail has no such check. A store that can't be read drops nothing.
- The classifier also sees `live_work`: open payments from `commerce open-flows --minutes 60` and whether a phone task holds `~/.local/share/phone-lock/priority-hold`, and each message lists the payments it surely came after (`after_payments`, from exact times). A bank or card prompt counts as likely ours only when it lists that payment and nothing in it contradicts it; a phone task alone, a prompt that didn't come after any payment, or a mismatch needs checking against order work. The batch and the wake carry the same list. If either can't be read it says so, and a bank prompt is never called "not ours".
- Bank payment deadlines and scheduled autopays are parsed before charge checks and the general classifier, including bank mail with bulk headers. They record source IDs in money-cases; successes close matching rows. A tracking write that cannot finish stays queued. Dry replays only detect and never write the money books. Payment reminders are emitted by money-cases alone.
- Card charge and decline alerts (iMessage SMS or bank mail) go through `../money-cases` first, until second 24 of the run (owner rule, nightly review 24 Oct: find the receipt or his own words before asking, and wait for the receipt from a merchant he already pays). Explained, waiting, already-asked and money-case alerts drop (`charge_explained`, `charge_wait`, `charge_asked`, `charge_case`), and the bank's mail copy of an SMS already passed on drops as asked. A fresh charge with nothing found stays queued for five minutes in case its receipt comes with it (`held_for_receipt`); one the time budget didn't reach waits up to 30 minutes. The rest reach the classifier with a `charge_check` note and go to the agent even if it skips them. Runs outside the live watcher use a copy of the money books in their own folder (`scratch-money`). If money-cases can't be loaded or read, the alert goes to the classifier as before and `charge_check_errors` says why. This needs the money-cases package installed next to this one.
- Source health lives in `cursor.json` (`source_health`). A source that fails (or only half reads) 3 runs in a row or 5 times in an hour gets one Telegram alert, then at most one every 6 hours while it stays broken. The alert's key and text are saved (`health_pending`) before it is sent, and a retry after a failed or lost send repeats exactly that, so the bridge never sees changed text under a key it already has; sources that fall due meanwhile get the next alert. A pending alert the bridge never takes is dropped after 6 hours. The runner's own alert never fires for this, because runs that wake on other sources count as successes. Only the live watcher sends; `robob-watch test` logs `health_alerts_skipped` instead.
- Urgent Telegram alerts use a three-second bridge health probe, stable per-item keys and 48-hour sent bookkeeping. The batch and wake mark successful sends so the agent follows up only if something changed. During the outage, selected hits stay queued while collection continues; their wake waits for chat recovery, avoiding a second Telegram alert through the runner fallback. Pending Telegram payloads keep their original text until acknowledged. Scratch and dry runs record would-send IDs. Withdrawal candidates check the newest same-reference status in the batch/queue, then the last 24 hours of the mail archive under a shared three-second budget; unavailable lookups say `not checked`. No watcher context change is needed.
- Messages and context are untrusted data. Only the owner Telegram alerts described above send messages; no payments or read-flag mutations happen in this check.

Local data: `~/Documents/assistant/inbox-triage/{prefs.md,noise.json,settings.json,runs.jsonl,batches/}`. State: `~/.local/share/robob-watch/watchers/inbox-triage/`. Keep both outside git. Only generic templates belong here.

## Verify

```sh
/usr/bin/python3 -B -m unittest -v test_triage.py test_urgent.py test_mail_retry.py test_install.py test_lock.py
unset BUN_INSPECT
robob-watch test inbox-triage
```

A historical replay (mail, WhatsApp and iMessage) does not advance live cursors or send notifications. It reads exactly the requested window (up to 20,000 rows per chat source, and says so in `source_errors` if it stops early) and classifies every candidate, 64 at a time. The report lists every dropped id with its reason:

```sh
/usr/bin/python3 -B triage.py --dry-run-hours 2 --report "$HOME/Documents/assistant/inbox-triage/replay.json"
```

Usage and cost are logged per real run; empty batches have no model cost. The schedule has up to 288 checks/day, not necessarily 288 model calls. Review actual token/USD usage before estimating a monthly total.
