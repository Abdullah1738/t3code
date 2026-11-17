# offbox

Sends heavy agent work (test suites, installs, builds, Docker) to the home offbox
server (`server/`, once `server/bootstrap.zsh <ip> client` has written
`~/.local/share/offbox/server.json`) or to boat.dev VMs (always, until then, and as
the standby while home is down) instead of the Mac, and runs light Go checks
locally in a macOS sandbox.

`offbox exec [box_id] [--timeout N] [--cwd DIR] [--json] -- <cmd...>` uses the authenticated, owner-checked control API on home or Boat when the guest stops, masks or replaces sshd (such as TorSSH testhost); timeout defaults to 60s, clamped to 1..600, and it returns the remote exit code (90 for API/transport failure).
Never bypass a host-key mismatch by editing known_hosts or disabling strict checking; `boat exec` is Boat-only and returns 404 for home boxes.

| Path here | Live copy |
| --- | --- |
| `skill/` | `~/.config/opencode/skills/remote-compute/` (the `remote-compute` skill, `offbox` CLI, classifier, monitor, box templates) |
| `plugin/offbox-gate.ts` | `~/.config/opencode/plugin/offbox-gate.ts` (OpenCode shell gate, loads at OpenCode start) |
| `bin/boat` | `~/.local/bin/boat` (boat CLI wrapper, signs in from Keychain `boat-api`/`ardud`) |
| `launchd/com.ardud.offbox-monitor.plist` | `~/Library/LaunchAgents/` (load monitor + reaper) |
| `launchd/com.ardud.offbox-home-monitor.plist` | `~/Library/LaunchAgents/` (home server health check, every minute: `skill/scripts/home_monitor.py tick`) |
| (link) | `~/.local/bin/offbox` -> `skill/scripts/offbox.py` in the live skill |

State stays outside the repo: `~/.local/share/offbox/` (offbox.db for Boat,
offbox-home.db for the home server, repo-keys.db for checkout identity shared by both, logs, backups, `server.json`,
`backend-state.json`), gate mode `~/.config/opencode/offbox-gate.json`, boat token under
`~/Library/Application Support/ascii/boat/`.

`skill/scripts/blockers/` goes first on every agent shell's PATH. Besides the
`docker` guard it holds `wacli`, `himalaya` and `himalaya-heal`, which refuse
raw sends so agents go through `wa` and `mailsend` (robob-watch helpers). Those
send right away and keep a sent record; they don't wait for Abdullah's OK.
Reads and drafts pass through.

## Two monitors

`com.ardud.offbox-home-monitor` watches the home server (`server/home/`) and is a second LaunchAgent on
purpose. The load monitor is a KeepAlive loop that samples the Mac every 10 s, with its own lock and its
spend/reap jobs. The home check is a one-shot every 60 s (`StartInterval`, no KeepAlive): it cannot pile up
(launchd folds intervals missed during sleep into one run, and a tick that finds `home-monitor.lock` held exits
at once), the loop cannot starve it, and a crash in one never stops the other. It shares no code with the loop.

Each tick asks `GET <server.json url>/health` (4 s, no token) and whether the Mac itself is online (tailnet
up, internet reachable). Two failed checks in a row with the Mac online mean down; three good checks in a row
mean up again. A failure while the Mac is offline, or on the first tick after a gap of more than 150 s (sleep,
reboot), counts for nothing, and so does a check less than 30 s after the last one (a manual run next to
the scheduled one). The verdict goes to `~/.local/share/offbox/backend-state.json`, which the offbox
client reads on every run (down: runs go to Boat). Once per outage it starts a repair agent in its own Robob
thread (Fable 5.2, standard mode, through the control API with the `offbox` component credential; runbook:
`server/home/REPAIR-RUNBOOK.md`) and sends one Telegram. An outage that starts within 30 minutes of the last
alert or recovery is the same outage: same thread, no second Telegram. A later outage reuses the thread if it
is still open. On recovery the thread is told, Telegram is not. "Up but degraded" (a dead disk) is one
Telegram per set of reasons per day, no thread. All thresholds are constants at the top of `home_monitor.py`.

Until `bootstrap.zsh` writes `server.json` (or while it says `"disabled": true`) a tick does nothing: no
network, no files. `home_monitor.py tick --dry-run` (or `OFFBOX_HOME_MONITOR_DRY_RUN=1`) checks and records
state but starts no thread and sends nothing, and prints what it would have done; `home_monitor.py status`
prints the state. Events are in `~/.local/share/offbox/home-monitor.log`.

## Repo Node and pnpm

Before running user code, offbox selects Node satisfying the nearest `.nvmrc` /
`.node-version` and `engines.node` together. Missing versions are installed through
nvm from official Node archives, checked against SHASUMS256 and staged before
activation. The crpko-node recipe carries nvm Node 20, 22 (>=22.13), and 24;
it does not depend on the base image's system Node.

For repos with `pnpm-lock.yaml`, selection is `packageManager` (including 11+) >
CI `PNPM_VERSION` / `pnpm/action-setup` > lockfile compatibility (9.0 → pnpm 10,
never 11+ by fallback). A checksum-verified package and PATH shim in the box-local
cache avoid Corepack's implicit latest lookup. Each run prints `offbox: node vX
(...)` and `offbox: pnpm vX (<source>)`; matching installed toolchains need no
network calls. Repos without Node pins or a pnpm lockfile keep their behaviour.

Toolchain downloads allow 20 s to connect, fail below 30 KB/s for 60 s, cap each
attempt at 600 s, and retry all errors twice (including partial transfers and
connection resets). Cached archives survive runs; extraction is staged, so an
incomplete install is never selected.

Toolchain exit code:

- **99**: pinned Node/pnpm/Quint provisioning, checksum verification, or activation
  failed. The user command never started. No box-default fallback.

Quint runs use CLI 0.33.1 in a box-local cache behind the guarded wrapper. The
first run installs it; warm runs check its version without npm. An explicit
`QUINT_BIN` is preserved. Setup prints `offbox-quint:` events and a guarded CLI
status line; runs without a Quint command or repo spec skip provisioning.

## Changing it

This tree is the source of truth. Every change is committed and pushed to
`origin main` before it goes live; `install.zsh` refuses unpushed changes.

```bash
cd integrations/offbox/skill/scripts
python3 test-runner.py python3 -m unittest discover -s tests -p 'test_*.py'
python3 test-runner.py python3 -m unittest discover -s ../../tests -p 'test_*.py'
OFFBOX_RULES=../heavy-rules.json python3 classify.py --test
(cd tests && unset BUN_INSPECT && python3 ../test-runner.py bun test classify.test.ts gate-plugin.test.ts toollog.test.ts)
cd ../.. && git commit ... && git push origin HEAD:main
./install.zsh --dry-run && ./install.zsh               # or: integrations/deploy.zsh offbox
./install.zsh --check                                   # live copy == repo, HEAD on origin
```

Use `skill/scripts/test-runner.py` around the server unittest suite and pytest
entry points too. It gives the entire process tree a temporary tool-log directory;
shared client fixtures and pytest use a fresh directory for each test. Direct
unittest/pytest writers without an override drop events. `OFFBOX_LOG_DIR` selects
the writer, retention and rollup directory; `OFFBOX_TOOL_LOG_DIR` remains a
compatible fallback. Neither override isolates the CLI's database or run state.

`offbox log-rollup --day YYYY-MM-DD --live-only` writes a separate
`rollup-live-YYYY-MM-DD.json` with `records` and `excludedRecords` counts. It
excludes explicit test events, fixture run IDs and run events without a run ID.
Legacy events without run IDs outside `run.*` remain included, so old test noise
without identifying metadata cannot be separated reliably. The day file and
ordinary rollup stay intact.

`install.zsh` restarts the monitor LaunchAgent and loads the home monitor (reloading it when its plist
changed). A gate plugin change only takes effect after an OpenCode restart, which needs Abdullah's go.
