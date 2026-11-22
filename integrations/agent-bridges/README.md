# Agent Bridges Supervisor

This directory documents the small supervisor that runs both OpenChamber
bridges (spectrum and telegram) as supervised children. It is intentionally
kept as a separate package with no runtime dependencies beyond Bun.

The supervisor source and tests are vendored here for reproducible
maintenance. Do not add credentials, SQLite state, sockets, generated
dependencies, or local verification artifacts to this repository. Runtime
state remains under `~/.config/agent-bridges/`.

## What it does

- Spawns each bridge through its own `start.zsh`, so each bridge keeps
  sourcing its own credentials with its own strict mode checks.
- Restarts crashed children with exponential backoff (2 s doubling to 60 s,
  reset after a 5-minute clean run). A missing or crashing child is a backoff
  event, never a supervisor crash.
- Forwards child stdout/stderr lines to its own stdout as tagged JSON so
  launchd captures one stream.
- Writes an atomic `state.json` (supervisor pid, per-child pid, state,
  restarts, last exit) after every child state change. `bun run src/cli.ts
  status` projects that state and flags dead or stale supervisors.
- Holds a kernel `flock` so only one supervisor may run; shutdown is
  SIGTERM to children, a 10-second grace, then SIGKILL, and shutdown
  interrupts in-flight backoff waits immediately.
- `scripts/migrate-imessage-alerts.ts` is the one-time alerting-state
  migration from the spectrum bridge database to the telegram bridge
  database (both bridges must be stopped; it creates timestamped backups
  and is safe to re-run).

The supervisor never talks to OpenChamber or OpenCode itself. The bridges it
runs target OpenChamber v2 on OpenCode 2 (see each bridge's README), so after
an OpenChamber upgrade the installed bridge runtimes need the matching source
before the service is restarted.

The launchd label is `com.abdullah.agent-bridges` (plist template in this
directory); it replaces the older per-bridge `com.abdullah.spectrum-bridge`
label. Use `bun run check` and `bun test` from this directory when changing
the supervisor.

The plist sets `ProcessType` to `Interactive` because the bridge answers agents
and the owner; at the default priority it lost CPU to agent work under load
(22 Nov 2026, CLI timeouts). `integrations/deploy.zsh` does not install the plist:
copy it to `~/Library/LaunchAgents/`, then run `launchctl bootout` followed by
`launchctl bootstrap`.

## Upstream

The main OpenChamber repository remains the `upstream` Git remote. This fork is
owned by `Abdullah1738` so cumulative OpenChamber changes and the companion
bridges can be synchronized without losing local work.
