# local-helpers

Small scripts that live under `~/.local` instead of a service directory: the
mail OAuth heal and OTP watcher, the shared link-preview helper, the quick
card builder, the MacBook power alerts and the Juno proxy. Edit them here,
then install.

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

## Quint

`bin/quint` installs as `~/.local/bin/quint`. The wrapper checks `java -version` for Java 21+
in `QUINT_JAVA_HOME` (an invalid explicit override fails), Homebrew's
`/opt/homebrew/opt/openjdk`, `JAVA_HOME`, Linux's PATH Java, then `/usr/libexec/java_home -v '21+'`.
Install a missing JDK with `brew install openjdk`. It finds the real CLI via
`QUINT_BIN`, PATH (skipping itself and symlinks to itself), then
`~/.nvm/versions/node/v26.2.0/bin/quint`; the CLI's directory supplies node
on short agent PATHs. Missing CLI: `npm i -g @informalsystems/quint@0.33.1`.

Verify without `--server-endpoint` gets a free local port. Explicit endpoints
must name a free `localhost:<port>` or `127.0.0.1:<port>`; the wrapper starts its
own server on IPv4 loopback there, normalizes the client endpoint to
`127.0.0.1:<port>`, and never attaches to an existing server. Other commands pass
through. `QUINT_APALACHE_ARCHIVE` selects the reviewed archive (default
`~/.local/share/apalache-patched/apalache-0.62.4-grpc-1.75.0.tgz`); a missing or
mismatched archive/JAR fails before starting Java. Each verify uses a private
temporary distribution and `QUINT_HOME`, with a refusing fallback launcher and
the pinned JAR available to TLC. Quint-side launch/download attempts fail even
if Quint exits zero. The wrapper stops only its own server and CLI PIDs on
completion or signals. Port ownership is checked with `/proc` on Linux or `lsof` on macOS; v1alpha reflection must answer before Quint runs.
Pass each backend option once; repeated endpoint/version options, including aliases, are refused.

CVE-2022-3171 is a protobuf runtime bug; the stock protobuf-java 3.25.8 runtime is patched. Its pre-22 reflection gencode warning is separate; #787 aligns gRPC to 1.75.0, generated with 3.25.8.
The guard pins archive SHA256 `51e0e9832eb589d346370b54377850697a597e3dfc23dd49246a02df421c9174` and JAR `a90f5802b6cfdb59c548513f0be2725ebd7c53a79cb96277cb349e48ea0b8f66`, always setting `error_on_unsafe_pre22_gencode=true`; unsafe JVM overrides, Java option-file loaders (`@argfile`, `-XX:VMOptionsFile`, `-XX:Flags`), and ambiguous backslash/whitespace spellings are refused. Expand file options explicitly for guarded verify.
The source patch binds Apalache to `127.0.0.1` only. Quint 0.33.1 requires v1alpha reflection (`dist/src/apalache.js:212,242`), so it remains registered.
The pre-22 v1alpha gencode warning reported by Crpko #2329 can still appear outside the guarded wrapper; #54 closes that bypass. No reflection classes are regenerated here.
`QUINT_ALLOW_VULNERABLE_APALACHE=1` explicitly bypasses this guard with a visible warning, permitting Quint's original cache/download/launch behavior; it never silences the protobuf warning.
Upstream Apalache 0.63.0 still has no dependency fix (#787's 11 Nov check); issue filing and all installations remain owner-approved evaluator actions.

Agent PATHs put `~/.local/share/quint-guard/bin` immediately after the blocker dirs, before nvm; its only tool is a symlink to `~/.local/bin/quint`.
The shared shell fence refuses direct npm/Node/package-runner `quint verify`; use `/Users/ardud/.local/bin/quint` or explicitly set `QUINT_ALLOW_VULNERABLE_APALACHE=1`.
Bare `quint` relies on the managed PATH when the hook cannot see the executing shell's PATH. Other subcommands pass through; the shared `~/.quint` cache is untouched.
Offbox provisions this same wrapper ahead of repo binaries and stages the hash-checked #55 archive under `~/.offbox/quint`; use `offbox run -- quint verify …` (package runners bypass PATH).
LISTEN alone can precede usable gRPC reflection; the wrapper probes Quint's reflection symbol within the existing 30-second startup deadline, retaining the fallback sentinel.
Release the offbox client with `integrations/offbox/install.zsh` as well as local-helpers; existing and fresh boxes receive the assets on their next run, without changing `~/.quint`.

Offbox investigation (9 Nov 2026, crpko-devops pool `bx_2vtg2veh`, three
remote calls including one pre-command failure): Quint 0.33.1 downloads
`https://github.com/apalache-mc/apalache/releases/download/v0.62.4/apalache.tgz`
without checking the HTTP status before tar extraction. `curl -sSIL` and
Node fetch both returned **504, text/html, 92 bytes**; `file` identified HTML
starting with `<html><body><h1>504 Gateway Time-out</h1>`. This reproduces the
invalid-archive cause: GitHub's error response is passed to tar as a tgz.
It is independent of Java. Successful downloads on other boxes are consistent
with an intermittent asset failure. The guarded wrapper uses the pinned archive;
for diagnosing a fresh download use `curl --fail --location`, then `file`
and `tar tzf` before extraction. A manual cache transfer must use the approved
patched distribution, not an unguarded stock 0.62.4 download.

The separate offbox signature `Unrecognized VM option 'G1PeriodicGCInterval'`
indicates an older JVM (Java 11 in the reports); Apalache requires Java 21+.
Current offbox templates include JDK 21 and select a full JDK for Java commands.
The wrapper checks its selected JDK before launching the backend; use
`QUINT_JAVA_HOME` to select another Java 21+ installation explicitly.

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

`apalache/build-patched.sh` builds Apalache 0.62.4 (`7954daf7563a69cce9d0b89c8542e40bf46f7c6e`) with all gRPC modules at 1.75.0 and protobuf/protoc 3.25.8; ScalaPB stays at 0.11.20.
Rebuild on Linux/JDK 21: `offbox run --remote -- 'JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 integrations/local-helpers/apalache/build-patched.sh'` (requires git, curl, Python 3 and sha256sum).
Output: `tmp/apalache-patched-0.62.4/apalache-0.62.4-grpc-1.75.0.tgz`; SHA256 `51e0e9832eb589d346370b54377850697a597e3dfc23dd49246a02df421c9174`.
The recipe checks resolved dependencies and reflection bytecode, records the JAR hash, and retains v1alpha reflection for quint 0.33.1; installation and wrapper selection are separate.
Launch with `JVM_ARGS=-Dcom.google.protobuf.error_on_unsafe_pre22_gencode=true apalache/bin/apalache-mc server --port=<n>`; the patched server binds `127.0.0.1:<n>` and keeps v1alpha reflection for Quint.
As of 9 Nov 2026, upstream main has no dependency fix after 0.62.4; the upstream issue draft is on Robob card #787 and has not been filed.

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
