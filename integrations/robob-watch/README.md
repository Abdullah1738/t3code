# robob-watch

Durable watcher runner for Robob (the iMessage agent). Watchers run a check command on an interval (default every 15s, minimum 5s) or within about a second of a trigger file changing and, on a new event, wake the live iMessage agent turn with context via the spectrum-bridge `POST /wake` endpoint (fallbacks: bridge `send` to the live route session, then telegram-bridge `notify`). Wakes still pending after 120s trigger a one-time heads-up text.

Layout (runtime lives at `~/.local/share/robob-watch`; this directory is the canonical source):
- `src/runner.ts` runner loop (1s tick), `src/cli.ts` CLI (add/list/show/remove/pause/resume/test/fire-test), `src/lib.ts` shared logic
- `helpers/` check helpers: whatsapp-new-message, output-changed, email-new-message, wa-lock; plus `ride-card` and `card-check` (compact-bubble acceptance checks for ride, delivery and quick cards, linked as `~/.local/bin/card-check`; `card-check reply` lints a chat reply for structured data that has to go as a card)
- `helpers/wa`, `helpers/mailsend`: the only agent send paths for WhatsApp and email (symlinked as `~/.local/bin/wa` and `~/.local/bin/mailsend`). A draft goes out only after `helpers/send-approval` finds Abdullah's own later message approving the preview he was shown (bridge inbound id or his Robob app message). It runs the deployed bridge formatter (`~/.local/share/spectrum-bridge/src/formatting.ts`, needs `bun`) to see what the chat showed, asks Sendblue whether every bubble of the preview was delivered before his reply, one message per bubble with the bridge's text (credentials from the bridge's `credentials.env`), and in the app only accepts the preview as a plain ``` code block with nothing before it that could hide it. Tests: `test/wa-gate.test.ts`, `test/test_send_approval.py`, `test/test_mailsend.py`
- `test/` bun tests
- `scripts/com.ardud.robob-watch.plist` LaunchAgent, `scripts/robob-watch` CLI wrapper for `~/.local/bin`
- `skill/SKILL.md` the `robob-watchers` agent skill (installed at `~/.config/opencode/skills/robob-watchers`)

Runtime state (`watchers/`, `archive/`, `runner.log`, `runner.pid`, `wa.lock`) is not tracked.

Versioned check packages live under `checks/`. The [inbox triage installer](checks/inbox-triage/README.md) deploys its five-minute check and definition separately, preserving the live watcher's cursors and private preferences. The [money cases installer](checks/money-cases/README.md) does the same for the open-money-case deadline check and its `money-cases` CLI.

Install/sync: copy `src test helpers package.json tsconfig.json` to `~/.local/share/robob-watch`, the wrapper to `~/.local/bin/robob-watch`, the plist to `~/Library/LaunchAgents/`, the skill to `~/.config/opencode/skills/robob-watchers/`, then `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.
