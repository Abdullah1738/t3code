# local-helpers

Small scripts that live under `~/.local` instead of a service directory: the
mail OAuth heal and OTP watcher, the shared link-preview helper, the quick
card builder, the MacBook power alerts and the Juno proxy. Edit them here,
then install.

`qcard --send CHAT --session ID` targets CHAT: own-chat app reply, `app --to` for another local chat, or an `agent-ask` link relay for a remote chat. Without `--session`, it only publishes/shares. The default key is `qcard:SLUG:CHAT`; retain `--key` across retries. Tests can set `QCARD_BRIDGE` (shell-split command) and `QCARD_BRIDGE_STATE` (bridge state directory).

| Source | Installed as | Used by |
| --- | --- | --- |
| `bin/opencode`, `libexec/opencode/` | `~/.local/bin/opencode`, `~/.local/libexec/opencode/` | terminal CLI shim; shares the service binary path with `opencode-web` |
| `libexec/toollog/` | `~/.local/libexec/toollog/` | `toollog`, native harness hooks, homes, canaries and rcsim |
| `libexec/mail/` | `~/.local/libexec/mail/` | `himalaya-heal`, `mailsearch`, otp watchers, message-archive (`MAIL_LIBEXEC`) |
| `libexec/card-preview/` | `~/.local/libexec/card-preview/` | ride cards (`RIDE_CARD_PREVIEW_LIB`), coordinated-project daily cards |
| `libexec/qcard/` | `~/.local/libexec/qcard/` | `qcard` |
| `bin/vp`, `libexec/vp/` | `~/.local/bin/vp`, `~/.local/libexec/vp/` | current checkout’s pinned `vp`; dependencyless worktrees try `vp.toolchain`, then main, for `fmt`/`lint` using the worktree’s Vite config, imported helpers and local JS plugins with borrowed packages; compares toolchain/plugin versions, lockfile snapshots and package type; preserves worktree paths, ignores and overrides; other commands give an offbox hint |
| `juno-proxy/` | `~/.local/share/juno-proxy/` | `com.abdullah.juno-proxy`: HTTP/CONNECT proxy and `/proxy.pac` on the Tailscale IP, port 8118, so tailnet devices reach Juno hosts through this Mac's VPN |
| `lydia-ticks/` | `~/.local/share/lydia-ticks/` | `com.ardud.lydia-ticks-server` (Bun, 127.0.0.1:18820: saves each tick on Lydia's checklist and serves the per-day history page) and `com.ardud.lydia-ticks-tunnel` (Cloudflare tunnel for https://lydia.abdullah.fund). `tunnel.json` (tunnel credentials), `history-token` (the private history link) and `ticks.db*` (Lydia's data) stay live-only, never in the repo |
| `bin/` | `~/.local/bin/` | agents and skills; `power-unplug-telegram.sh` and `battery-low-telegram.sh` for the power agents; `cards-tunnel`, `cards-health` and `cards-tunnel-setup` for the card links; `opencode-web` for the emergency OpenCode web UI; `rclaude` for an interactive Claude Code launched like Robob's claudeAgent threads (pinned harness binary, `~/.robob/harness-homes/claude`, 9router env and model/effort from `~/.robob/userdata/settings.json`; `rclaude --rclaude-print` shows the resolved command) |
| `launchd/` | `~/Library/LaunchAgents/` | `local.ardud.otp-watch`, `local.ardud.otp-idle`, `local.ardud.mail-token-refresh`, `com.abdullah.juno-proxy`, `com.ardud.power-unplug-telegram` (Telegram when the MacBook is unplugged or plugged back in, every 20s), `com.ardud.battery-low-telegram` (Telegram every 5 min on battery at 20% or less), `com.ardud.cards-tunnel` (the named Cloudflare tunnel for cards.abdullah.fund), `com.ardud.cards-health` (every 5 min: restarts the tunnel when the public link stops answering, Telegram after two misses and when it's back), `com.ardud.lydia-ticks-server` and `com.ardud.lydia-ticks-tunnel` (see `lydia-ticks/` above; code changes restart them), `com.ardud.opencode-web` (always-on service-binary `opencode serve` with a major.minor version guard on 127.0.0.1:4096, the emergency web UI at https://opencode.tail, independent of Robob and the OpenCode service; waits for a hand-started copy on the port to exit instead of killing it) |

`opencode` runs `/Volumes/ExternalSSD/opencode2/current/bin/opencode`, the binary
used by `com.ardud.opencode-service`, forwarding arguments and exit status.
`opencode-web` uses the same path from `libexec/opencode/service-bin.zsh`.
Before serving it checks the selected binary against that fixed reference by
running both with `--version`;
an unreadable version or different major.minor version logs one refusal line
and exits nonzero. `OPENCODE_WEB_BIN` can select another binary, subject to the
same check. This only needs the installed service binary, so the emergency UI
can still start when Robob and the OpenCode service are down.

`install.zsh` also keeps two links in `~/.local/bin`: `wa` and `mailsend`
point at the deployed robob-watch helpers (deploy robob-watch first). It
writes `~/.local/bin/uber` as a small wrapper that runs the newest nvm
node's `@crafter/uber-cli` with that node's absolute path, so ride watchers
with a short `PATH` still run it. It never replaces an `uber` file it didn't
write.

```bash
./install.zsh --check      # does the live copy match this commit?
./install.zsh --dry-run    # what would change
./install.zsh              # install, reload changed agents, smoke check
```

It installs the git-tracked files only (ignored caches never ship) and refuses
uncommitted or unpushed work (`--allow-unpushed` is for tests). Each file gets
its fixed mode (`kc-read`, `kc-write` and `otp-watch.py` stay 700). Every
replaced file keeps a `<file>.bak-<timestamp>` copy next to it (never
overwriting an older one), so a bad install rolls back with a `mv`. Changed plists are reloaded; a plist that won't load is
restored from its backup. Every run also loads any managed agent that isn't
loaded. `otp-idle` and the Juno proxy keep running, so new code for them
restarts that agent (`kickstart -k`). A plist reload or restart that a failed run didn't get to
is kept as a marker in `~/.local/state/local-helpers` and done by the next run;
a plist's marker names the backup launchd was running, so the run that does the
reload can still go back to it. If a marker doesn't name one (an older
installer's empty marker), the running job is left alone and the run says how
to reload it by hand. Only one install runs at a time (a lock in the
same folder; a second run waits up to 5 minutes, `--check` waits too).
The smoke check parses every Python file, imports the libraries from their
installed path, runs `qcard templates` and `uber --version` under a bare
`PATH`, checks the shell scripts' syntax and lints the plists. `--check` also reports missing links, wrong
modes (the `uber` wrapper too), unloaded agents and pending reloads or
restarts.

Tokens, passwords, cached IPs, OTP state and generated pages stay outside the
repo: Keychain, `~/.local/state/{mail-oauth,otp-watch}`, `~/.cache`,
`~/.local/share/imessage-apps`.

The Mirage watchdog runs every minute as `com.ardud.mirage-beacon-keepalive`.
Its helper is `bin/mirage-beacon-keepalive`, with client detection and restart
functions in `libexec/mirage/`. Three failed health checks allow a restart only
when every Mirage process has no established remote TCP or connected UDP flow.
`lsof` and `nettop` are combined because Network.framework UDP flows may only
appear in nettop. Duplicate descriptors/rows count once by transport 5-tuple;
idle connections still block a restart, as do unavailable or malformed samples.
There are no force-failure switches. State stays in
`~/.local/state/mirage-beacon-keepalive`, logs in
`~/Library/Logs/mirage-beacon-keepalive.log`.

Before installation, while a client is streaming, run this from the checkout
for a read-only detector check (no probes, state writes, quit or launch):

```bash
./integrations/local-helpers/bin/mirage-beacon-keepalive --detect-clients
```

It prints JSON: `streaming` with at least one flow and the client's peer is
the expected result (exit 10). `clear` exits 0; `unknown` exits 20 and blocks
restarts. A real-stream check must be repeated after installation with
`~/.local/bin/mirage-beacon-keepalive --detect-clients`. Fixture tests and a
dummy listener do not establish that the live iPad stream is detected.

After approval, from the merged checkout: `./integrations/local-helpers/install.zsh`
then `./integrations/local-helpers/install.zsh --check`. This installs all
managed local helpers and loads/reloads their plists, so inspect `--dry-run`
before approving. The Mirage agent is a short run and picks up code on its
next tick; it needs no forced kickstart.

Focused watchdog tests: from this directory,
`/usr/bin/python3 -B -m unittest discover -s tests -p test_mirage.py -v`.
They use normalized socket captures and a disposable loopback listener with
stubbed application commands, never the installed watchdog or Mirage app.

The delivery card builder that used to live in `~/.local/libexec/delivery-card`
is retired; delivery cards come from `app-api-cli/delivery_cards.py`.

`~/.local/bin/power-unplug-telegram.sh --test` sends one test alert without
changing the saved power state (`~/.local/state/power-source`). A change whose
alert couldn't be sent waits in `power-source.pending` and is retried every run
with the same Telegram key and text (the bridge only dedupes an identical resend).
Nothing is sent unless that file was written.

Tests: `/usr/bin/python3 -m unittest discover -s tests` (each install test runs
the installer from a throwaway git copy of this package, with a temp `HOME` and
a fake `launchctl`; the power alert tests use a fake `pmset` and notifier).

## timeout

macOS has no `timeout(1)`, and agents write `timeout 40 cmd` out of Linux habit.
`bin/timeout` is a GNU-compatible Perl shim installed as `~/.local/bin/timeout`:
`timeout [-s SIG] [-k DUR] [--preserve-status] [--foreground] [-v] DURATION CMD...`,
durations take `s`/`m`/`h`/`d`, and it exits 124 on timeout, 137 when KILL was
needed, 125/126/127 for its own, can't-run and not-found errors. The command
runs in its own process group so the signal also reaches its children; TERM,
INT, HUP and QUIT sent to timeout are passed on. When timeout owns the terminal
it hands it to that group (so the command can read it) and takes it back after;
Ctrl-Z stops both. Tests:
`/usr/bin/python3 -B -m unittest discover -s tests -p test_timeout.py`.

`quint` is retired (owner rule 2026-11-21); the stub refuses with QUINT_RETIRED.

Card links: the spectrum bridge serves every `share` at `https://cards.abdullah.fund/s/<token>/` from
127.0.0.1:18793 (its config.json `shareOrigin`). `cards-tunnel` runs the named Cloudflare tunnel that forwards
there; both agents idle until the tunnel exists. One time, after Abdullah ran `cloudflared tunnel login` and
picked abdullah.fund: `~/.local/bin/cards-tunnel-setup` creates the tunnel (credentials in
`~/.cloudflared/cards-tunnel.json`, never in this repo), points the DNS name at it and starts it.

`robob-read-watchdog` probes `t3ctl threads --active --limit 5` with a 10-second
request deadline every 30 seconds. A separate 20-second child deadline also
covers a probe stuck before JavaScript starts (`ROBOB_WD_PROBE_DEADLINE` overrides it).
After three minutes of failed reads it sends
one Telegram alert, then one recovery when reads work again. It clears the
incident quietly while Robob is closed or `tmux -L restart` has the
`robob-restart` session. State and stderr live in
`~/.local/state/robob-read-watchdog/`.

After approval, run `integrations/local-helpers/install.zsh` from the merged,
pushed checkout (it installs and loads the agent). If it needs loading manually:
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.robob-read-watchdog.plist`.
Unload with `launchctl bootout gui/$(id -u)/com.ardud.robob-read-watchdog`.

Installers can call `robob-read-watchdog --sustain 300 --every 30 --give-up 1800`
to require five minutes of consecutive healthy reads. Any failed probe resets
the healthy window; timeout exits 1. This mode sends no notifications. All modes
share probe state: after the child deadline the watchdog sends one TERM, waits
at most two seconds, then records a surviving child's PID and start time in
`stuck_probe`. Further runs skip the probe until that identity is gone.
An unreadable start time keeps suppression in place; an initially unreadable
identity is recorded as `unknown` and retained until the PID is gone.
Start-time identities and stuck-time diagnostics use UTC, so manual and launchd
runs agree even when they have different `TZ` settings.
`ROBOB_WD_PROBE`, `ROBOB_WD_NOTIFY`, `ROBOB_WD_APP_RUNNING`,
`ROBOB_WD_RESTARTING` and `ROBOB_WD_SLEEP` accept replacement commands;
`ROBOB_WD_STATE` overrides the state directory. `ROBOB_WD_NOW` accepts epoch
seconds or a command returning epoch seconds for an advancing test clock.

## Repo Node and pnpm selection

`python3 integrations/local-helpers/install-node-pin.py` prints the exact proposed
shell-file and helper diffs without writing. After approval, run the same command
with `--install` from a clean revision on `origin/main`; `--check` reports drift.
The installer preserves existing shell-file contents and keeps backups.

The helper selects the highest installed nvm Node satisfying the nearest
`.nvmrc` or `.node-version` and `engines.node`, falling back to engines when the
file pin is unavailable. pnpm uses the `packageManager` major, or the lockfile
format (v9 prefers pnpm 10, then 9). It reads installed package metadata and the
Corepack cache, runs the selected cached CLI directly, and never installs a
runtime or downloads a package manager. Missing versions produce an explicit
install hint. The safe-chain pnpm function remains in place.

zsh uses chpwd/preexec hooks and a DEBUG trap for noninteractive snapshot PATH
restoration; Bash wraps cd/pushd/popd (preserving existing functions) and passes BASH_ENV to its children. Start a fresh shell
after changing a pin in the current directory. Unpinned directories retain
the incoming PATH. `zsh -f` and fresh `bash --noprofile --norc` without BASH_ENV
explicitly bypass shell setup; they need the helper sourced by their caller.

Focused verification:
`PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s integrations/local-helpers/tests -p test_repo_node_pin.py`.

`toollog read --board agent-tools --kind error --limit 50` reads today's UTC
NDJSON. Use `--day YYYY-MM-DD` for another day, `--name dotted.name` to filter,
or another board slug for that board's logs. `toollog rollup --board agent-tools`
writes `~/.robob/logs/tools/agent-tools/rollup-YYYY-MM-DD.json`.
Non-error hook rows stop when the day file reaches 35 MiB; other components
continue to 50 MiB. Errors always continue. `logCaps` identifies any reached
budget, including older markers as `component: all`.
Allowed/rewritten non-error decisions are sampled 1-in-128 and omit default
optional props. Missing `repeatCount` means 1, `cwdClass` means `other`, and
`matchedRoot`/`argv0Class` mean `none`. Rollup weights counts, rates, duration
percentiles by `sampleRate`; `sampled: true` marks estimates,
while `recordedRows` reports the stored count. Denials and other hook errors
keep every row and all their context.
Hook rollups include `topThreadsByRule` (`--top N`, default 20) and `repeatLoops`
for attributed threads refused more than 20 times in a sliding hour. Rankings
exclude allowed decisions and split denied/rewritten counts; loops also split
by decision. Legacy rows without a decision count only when `kind: error` or
`ok: false`. Unexpected sampled refusals retain their weight and are marked
`sampled: true`. `unattributedByRule` keeps `unknown:*` refusal buckets visible
outside thread rankings and loops. `unrecognizedThreadIds` counts refusals with
IDs outside the native or Robob thread formats, including test fixtures;
`unrecognizedThreadIdsSampled` marks a weighted estimate for that counter. Loop windows
can include the previous UTC day's last hour; daily totals stay local.
`threadIdSource` distinguishes a resolved Robob ID from a native session fallback
or missing identity. `repeatCount` tracks matching session/rule/first-word retries
until a 60-second gap; native counts are best effort when hooks overlap.
When an error tag has no IDs, its `sampleId` gives the day file, timestamp and
one-based physical line number so the original record can still be found.

`toollog refusals --day YYYY-MM-DD [--rule R] [--top N] [--json]` prints the
day's denied/rewritten hook decisions grouped by rule and command shape; the
agent-tools rollup carries the same data as `refusalShapes`. Each shape has
`count` (denied plus sampleRate-weighted rewrites, `~`/`sampled` when estimated),
`distinctThreads`, `unattributed` (`unknown:*` rows), `retryWithin5m` (the same
thread hit the same rule and shape again within 300 s, so it was stuck; the
previous UTC day's last 5 minutes count as context), `harness` and `topProjects`.
Denials rank first; past 100 shapes the rest fold into `other`. Rows marked
`source: test` are excluded and counted in `excludedTestRows`.
Hooks write `cmdShape` and `project` on refusals only. A shape fails closed: it
keeps operators, env var names, one- or two-letter flags, and program names,
subcommands, file extensions and long options from fixed vocabularies. Anything
else (paths, quoted text, numbers, variables, attached flag values, unknown
programs as `<cmd>`, unknown options as `--<opt>`) becomes a placeholder, e.g.
`sqlite3 <path.sqlite> <q>`. Escaped characters stay inside their word, and a
heredoc body is dropped; if its delimiter can't be read or its terminator never
matches exactly, the rest of the command is dropped and the shape ends in `...`.
No raw command is stored.
`project` is the folder name of the git repository the command ran in (the main
checkout for worktrees). Rows written before shapes existed group as
`coarse:<firstWord> cwd:<cwdClass>`.
The Python logger has one source in `libexec/toollog/`; the other integrations'
source symlinks are materialized beside their entry points by their installers.

## vp toolchain

The optional fmt/lint copy is managed from any repo worktree with
`~/.local/libexec/vp/toolchain init [dir]`, `sync [--install]`, or `status`.
It is a detached worktree configured in `git config vp.toolchain`; unset that
key to return to main-only fallback. The shim updates it from the local
`origin/main` ref without fetching or installing. After a toolchain version
bump, run `toolchain sync --install`. The frozen install selects only the root
and `oxlint-plugin-t3code` importers, whose runtime dependencies lint loads.

To try an uninstalled branch, run its absolute `integrations/local-helpers/bin/vp`
path from the target worktree. Config snapshots and Vite’s cache stay in a
private temporary directory; the borrowed install is read-only.

`vp` outcomes: `${XDG_STATE_HOME:-~/.local/state}/vp-shim/events.jsonl` (5 MB rotation).

## vnc-hold

`com.ardud.vnc-hold` holds a shared loopback Screen Sharing session. macOS
relocks when the remote session that unlocked the console ends; another
connected session prevents that. Keep Screen Sharing enabled with Apple auth
(type 30). The helper caches the Keychain login password in memory per
connection, checks for a locked console twice, and attempts an unlock. An
unconfirmed attempt pauses typing across restarts until the Keychain password
changes or `vnc-hold reset-attempts` is requested.

- `vnc-hold status`: state, LaunchAgent state/pid and a fresh lock read; exit 0
  only when connected, fresh, unlocked and without a typing pause or error.
- `vnc-hold selftest` (`--once`): authenticate a second shared session and close
  it, without typing or changing daemon state.
- `vnc-hold reset-attempts`: request clearing the pause on the next daemon check.

State: `~/.local/state/vnc-hold/state.json` (atomic writes, including keepalives).
`typing_paused` is a boolean; `typing_paused_reason` explains it. Timestamps are
Unix seconds. Logs: `~/Library/Logs/vnc-hold.log`, rotated at 256 KiB with two
backups. Passwords stay out of logs/state/argv; only a paused password's SHA-256
is persisted. Type-30 AES uses the ephemeral DH key in openssl's `-K` argument;
openssl cannot read a raw `-K` key from stdin.

Before any install/restart, start a temporary `vnc-hold run` with a separate
`VNC_HOLD_STATE_DIR` and verify it connected. Keep it alive until the new
LaunchAgent's pid is connected and the console reads unlocked. Stop only the
captured temporary pid. Never lock the screen to test this helper. Automatic
unlock still requires the separately supervised live proof.
