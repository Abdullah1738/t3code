# robob-watch

Durable watcher runner for Robob (the iMessage agent). Watchers run a check command on an interval (default every 15s, minimum 5s) or within about a second of a trigger file changing and, on a new event, wake the live iMessage agent turn with context via the spectrum-bridge `POST /wake` endpoint (fallbacks: bridge `send` to the live route session, then telegram-bridge `notify`). Wakes still pending after 120s trigger a one-time heads-up text.

Layout (runtime lives at `~/.local/share/robob-watch`; this directory is the canonical source):
- `src/runner.ts` runner loop (1s tick), `src/cli.ts` CLI (add/list/show/remove/pause/resume/test/fire-test/relay-ok/relays-off), `src/lib.ts` shared logic
- `helpers/` check helpers: whatsapp-new-message, output-changed, email-new-message, wa-lock; plus `ride-card` and `card-check` (compact-bubble acceptance checks for ride, delivery and quick cards, linked as `~/.local/bin/card-check`; `card-check reply` lints a chat reply for structured data that has to go as a card)
- `helpers/wa`, `helpers/mailsend`: the agent send paths for WhatsApp and email (symlinked as `~/.local/bin/wa` and `~/.local/bin/mailsend`). They send without waiting for Abdullah's OK (27 Oct 2026: tools suggest, they don't block). A draft prints its preview: where his OK makes sense, the agent shows it to him, then sends with `send --approved <id>`. Still refused: a draft sent twice, a draft older than 24h, a file or stored email changed since its draft, mailsend's Bcc. `helpers/send-approval` is no longer called by either helper (its `check` has no callers; `visible` still runs at draft time to keep text the chat would hide out of previews). Tests: `test/wa-gate.test.ts`, `test/test_send_approval.py`, `test/test_mailsend.py`
- `test/` bun tests
- `scripts/com.ardud.robob-watch.plist` LaunchAgent, `scripts/robob-watch` CLI wrapper for `~/.local/bin`
- `skill/SKILL.md` the `robob-watchers` agent skill (installed at `~/.config/opencode/skills/robob-watchers`)

Runtime state (`watchers/`, `archive/`, `runner.log`, `runner.pid`, `wa.lock`) is not tracked.

Versioned check packages live under `checks/`. The [inbox triage installer](checks/inbox-triage/README.md) deploys its five-minute check and definition separately, preserving the live watcher's cursors and private preferences. The [money cases installer](checks/money-cases/README.md) does the same for the open-money-case deadline check and its `money-cases` CLI.

Robob projection reads use the server-owned `~/.robob/userdata/readonly/state.sqlite`
snapshot, with `ROBOB_READONLY_DB` or the component override (`MONEY_CASES_STATE_DB`,
`SEND_APPROVAL_STATE_DB`). Live-writer paths, symlink and hardlink aliases are
refused before connecting. Missing/not-ready snapshots and exports older than
120 seconds fail closed; key/value metadata must include `ready='1'` and
`schema_version='1'`. Each request opens a read transaction before checking
metadata, so projection rows cannot come from a partial generation. There is no
live-database fallback.
Protected writers include both `state.sqlite` and `statev2.sqlite` under
`~/.robob`, `~/.t3`, and configured `ROBOB_HOME`/`T3CODE_HOME`, plus native
OpenCode's default/XDG path. Watcher check children inherit those configured
homes so explicit overrides cannot bypass the same protections.
`send-approval --app` uses current control-API messages by default so a later veto is not hidden by
replication lag; explicit snapshot overrides select offline inspection instead.
Approval against an explicit snapshot still revalidates current owner messages
through the control API before succeeding.
The money-cases installer also copies `helpers/robob_readonly.py` beside its check.

Install/sync: copy `src test helpers package.json tsconfig.json` to `~/.local/share/robob-watch`, the wrapper to `~/.local/bin/robob-watch`, the plist to `~/Library/LaunchAgents/`, the skill to `~/.config/opencode/skills/robob-watchers/`, then `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.
