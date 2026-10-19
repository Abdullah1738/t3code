# robob-watch

Durable watcher runner for Robob (the iMessage agent). Watchers poll a check command (default every 30s) and, on a new event, wake the live iMessage agent turn with context via the spectrum-bridge `POST /wake` endpoint (fallbacks: bridge `send` to the live route session, then telegram-bridge `notify`). Wakes still pending after 120s trigger a one-time heads-up text.

Layout (runtime lives at `~/.local/share/robob-watch`; this directory is the canonical source):
- `src/runner.ts` runner loop (10s tick), `src/cli.ts` CLI (add/list/show/remove/pause/resume/test/fire-test), `src/lib.ts` shared logic
- `helpers/` check helpers: whatsapp-new-message, output-changed, email-new-message, wa-lock
- `test/` bun tests
- `scripts/com.ardud.robob-watch.plist` LaunchAgent, `scripts/robob-watch` CLI wrapper for `~/.local/bin`
- `skill/SKILL.md` the `robob-watchers` agent skill (installed at `~/.config/opencode/skills/robob-watchers`)

Runtime state (`watchers/`, `archive/`, `runner.log`, `runner.pid`, `wa.lock`) is not tracked.

Versioned check packages live under `checks/`. The [inbox triage installer](checks/inbox-triage/README.md) deploys its five-minute check and definition separately, preserving the live watcher's cursors and private preferences.

Install/sync: copy `src test helpers package.json tsconfig.json` to `~/.local/share/robob-watch`, the wrapper to `~/.local/bin/robob-watch`, the plist to `~/Library/LaunchAgents/`, the skill to `~/.config/opencode/skills/robob-watchers/`, then `launchctl kickstart -k gui/$(id -u)/com.ardud.robob-watch`.
