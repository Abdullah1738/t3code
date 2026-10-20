# Inbox triage

Read-only INBOX mail, WhatsApp and iMessage/SMS collection every **300 seconds**. Free filters precede one Haiku call per nonempty batch. Only hits wake the live owner iMessage session for full-message review. There is no quiet window.

## Install or update

Requires the existing robob-watch runner, mailsearch/mail_oauth authentication, wa-db helper, read access to the chat stores and the existing OpenRouter key. Configure local identities before enabling a fresh installation:

1. Create `~/Documents/assistant/inbox-triage/settings.json` from `settings.template.json`. Set the self WhatsApp JID, group mention names and excluded iMessage chat IDs/identifiers (assistant bridge, self-chat and chats already handled elsewhere); set `configured` to true.
2. From this directory run `/usr/bin/python3 -B install.py`. It copies only the named source files and registers `watcher.json`. Missing prefs/noise files are seeded from templates; existing files are preserved.
3. Run `unset BUN_INSPECT` then `robob-watch test inbox-triage` and `robob-watch show inbox-triage`.

This package lives under `checks/` because `integrations/deploy.zsh robob-watch` intentionally excludes the live `watchers/` state tree. Its dedicated installer updates only this check, not the runner or unrelated integrations. No service restart is needed: the runner reads the definition each tick and each check starts a fresh process.

The installer waits for `check.lock` (65 seconds maximum), atomically replaces source files and preserves the lock inode. It never copies/deletes cursors, queues, outboxes, run logs, credentials or local settings/preferences. Existing paused state is preserved. New installs baseline at their first run; upgrades keep all cursors.

## Execution bounds and recovery

- Accounts run concurrently, each with a 25-second total budget including one transient retry. Mail workers have a 19-second alarm and save fully processed prefixes when a batch runs long.
- Classification has a 20-second wall-clock budget. The runner kills the whole check process group at 60 seconds, well below the five-minute cadence.
- `check.lock` prevents overlap; a separate `dry-run.lock` means replay diagnostics cannot suppress a scheduled check. Contention exits 75 so the runner cannot overwrite a prior output acknowledgement. Installation registers paused under the lock and resumes after release.
- OTP context is checked across the whole message before redacting preview fields. FETCH literals must have valid UIDs; omitted messages are confirmed expunged before the cursor can advance past them.
- Atomic cursor + candidate queue writes happen before classification. Hits commit to an outbox before stdout; the runner's `.run-ok` acknowledges them. Failed sources retain their last successful cursor. Model failures become manual-review candidates without a second call.
- Messages and context are untrusted data. No outgoing messages, payments or read-flag mutations happen in this check.

Local data: `~/Documents/assistant/inbox-triage/{prefs.md,noise.json,settings.json,runs.jsonl,batches/}`. State: `~/.local/share/robob-watch/watchers/inbox-triage/`. Keep both outside git. Only generic templates belong here.

## Verify

```sh
/usr/bin/python3 -B -m unittest -v test_triage.py test_mail_retry.py test_install.py test_lock.py
unset BUN_INSPECT
robob-watch test inbox-triage
```

A historical mail replay does not advance live cursors or send notifications:

```sh
/usr/bin/python3 -B triage.py --dry-run-hours 2 --report "$HOME/Documents/assistant/inbox-triage/replay.json"
```

Usage and cost are logged per real run; empty batches have no model cost. The schedule has up to 288 checks/day, not necessarily 288 model calls. Review actual token/USD usage before estimating a monthly total.
