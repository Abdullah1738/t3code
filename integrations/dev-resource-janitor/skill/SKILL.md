---
name: dev-resource-janitor
description: Use to find/stop leftover iOS simulators, Expo/Metro servers, Docker containers, LocalStack, or Docker Desktop that agents left running. Runs hourly as a scheduled Sonnet agent.
---

# Dev resource janitor

Agents boot simulators, start Expo/Metro, run LocalStack/ClickHouse/test
containers, and leave them running. This skill stops the ones no agent has
used in the last hour.

Script: `scripts/dev_janitor.py` (stdlib, opens `opencode.db` read-only).

```bash
S=~/.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py
$S scan                      # read-only JSON: resources, keep_reasons, candidates
$S apply --ids id1,id2       # re-scans; acts only on ids that are STILL candidates
```

Local simulators/emulators are blocked since 2026-10-09 (`run-cloud` skill), so the
`sim:*` / `simulator-app` paths are only a safety net for an approved bypass. Run Cloud
sessions are not this janitor's job: the `rcsim` monitor (LaunchAgent
`com.ardud.rcsim-monitor`) heartbeats and deletes them.

Resource ids: `sim:<UDID>`, `simulator-app` (Simulator.app open with no booted device), `expo:<pid>`, `container:<name>`, `docker-desktop`.
An Expo server is only protected by a running session whose directory is the Expo cwd or inside it. A session in a parent directory such as `~` does not count.
Actions: `xcrun simctl shutdown` (quits Simulator.app when none are left booted),
SIGTERM for expo + its `npm exec` parent, `docker stop -t 30`, `docker desktop stop`.
Audit: `~/.local/share/dev-janitor/audit.jsonl`; last scan `last.json`.
Keep list (one id, name or cwd per line): `~/.config/opencode/dev-janitor-keep.txt`.

## Keep rules (any one keeps the resource)

- younger than 60 min (`DEV_JANITOR_IDLE_MIN`)
- an OpenCode session message in the last 60 min mentions its tokens: sim UDID or
  name, expo cwd or `--port N`/`:N`, container name, id, compose dir or host port,
  and for Docker Desktop the word `docker`
- a running session's directory contains the expo cwd
- the container logged non-healthcheck lines in the last 60 min
- Docker Desktop: any container still running
- running sessions unreadable (OpenCode service `127.0.0.1:49374` `/api/session/active`, `scripts/active_sessions.py`) -> keep everything
- Robob's active set is two complete control-API queries, unioned by threadId: every non-idle thread (`active=true`), and provider-native children updated in the last 48 h (`creationSource=provider`). If either is truncated or fails, the set is incomplete and everything is kept. Until the server's `creationSource` filter ships, the second query comes back truncated, so this stays fail-closed.
- keep file

Sessions whose prompt contains `DEV-RESOURCE-JANITOR-RUN` (the scheduled run
itself) and sessions titled "Dev resource janitor..." are not counted as usage.

## Scheduled agent flow

(nightly 2026-10-15) Now a robob-watch watcher `dev-janitor` (mode notify, hourly), not an LLM run. Check script
`scripts/janitor_watch.sh` runs scan, then apply --ids for candidates only. Silent on success; prints one line only if a scan or apply step fails. The old scheduled task "Dev resource janitor (hourly)" (cron `17 * * * *`, Asia/Dubai) is retired and should be disabled.

## $TMPDIR prune (hourly, same watcher, 2026-10-22)

`janitor_watch.sh` also starts `scripts/tmpdir_prune.py apply` detached (its scan
can run past the 60 s check timeout on a full `$TMPDIR`). It removes, when older
than 24 h and not open by any process: vitest root dirs (`$TMPDIR/<21-char id>`
holding only `ssr/`; vitest <5.0.3 never cleans them, ~20 MB a run) and the
crpko-devops guard-test mkdtemp dirs (`coord-scope-*`, `crpko-fdb-plan-guard-*`,
`crpko-fdb-targets-*`, `grow-agent-render-*`). `$TMPDIR/opencode` agent scratch is
only reported (`opencode_stale` in `~/.local/share/dev-janitor/tmpdir-audit.jsonl`);
deleting it stays manual because Crpko review checkouts live there. `scan --list`
previews. Paths in `~/.config/opencode/dev-janitor-keep.txt` are never touched. A
crashed prune shows up as one line on the next hourly run.

Previous flow (kept for reference), run as the Robob scheduled task "Dev resource janitor (hourly)" (cron
`17 * * * *`, Asia/Dubai), imported from OpenChamber.

1. `scan`. If `candidates` is empty, reply one line and stop.
2. For each candidate, sanity-check the `sessions`/`keep_reasons` fields and
   anything odd (e.g. a container with a volume holding unsaved work). Skip if unsure.
3. `apply --ids ...` with the remaining candidates. Order is handled by the script
   (sims, expo, containers, then Docker Desktop, which re-checks that no containers run).
4. Reply with a short list: what was stopped, memory freed (rss_mb / vm_rss_mb),
   what was kept and why. No Telegram unless something failed.

## Stale git worktrees (daily, separate job)

`scripts/worktree_reaper.py` runs from LaunchAgent `com.abdullah.worktree-reaper`
every day at 04:30 (`--dry-run` to preview). It finds every repo under `~` and
`/Volumes/ExternalSSD` (depth 3) plus every OpenCode session directory, and removes
a linked worktree only when all of these hold:

- last commit on HEAD is older than 60 days (`WORKTREE_STALE_DAYS`)
- nothing ahead: HEAD is on a remote-tracking ref, no staged, unstaged or untracked
  files, no initialized submodules
- not the main checkout, not locked, not in `~/.config/opencode/worktree-reaper-keep.txt`
- no running session, no session activity in it for 60 days, no process cwd in it,
  worktree created more than 7 days ago
- ignored files: build and dependency dirs are dropped; any other ignored file (`.env`,
  notes) is tarred to `/Volumes/ExternalSSD/worktree-reaper-archive/<date>/` first.
  Nested repos or more than 500 MB of such data keep the worktree.

Removal is plain `git worktree remove` (no `--force`). Branches, stashes and commits
stay, so restore is `git worktree add <path> <branch or sha>` (the audit line has it).
Missing worktree dirs are only reported, never pruned. Audit
`~/.local/share/dev-janitor/worktree_reaper.jsonl`, status `worktree_reaper_last.json`,
alerted by memory health check `worktree_reaper`.

## Pitfalls

- Never quit Docker Desktop while any container runs or while a session
  mentioned docker in the last hour. On 2026-09-29 quitting it killed an ad-hoc
  `ch508` ClickHouse container a running review session was probing.
- `docker stop` only; never `docker rm`, `docker volume rm`, or `simctl erase/delete`.
- The CuaDriver `serve` daemon, Robob and the OpenCode service are out of scope.
