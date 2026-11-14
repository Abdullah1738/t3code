---
name: dev-resource-janitor
description: Use to find/stop leftover iOS simulators, Expo/Metro servers, Docker containers, LocalStack, or Docker Desktop that agents left running. Runs hourly through robob-watch.
---

# Dev resource janitor

Agents boot simulators, start Expo/Metro, run LocalStack/ClickHouse/test
containers, and leave them running. This skill stops the ones no agent has
used in the last hour.

Script: `scripts/dev_janitor.py` (stdlib, supported APIs via `active_sessions.py`;
no live database opens). `scan --no-write` makes a read-only live dry run without
writing the report or audit log.

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
- `usage_history_unavailable`: the active APIs do not expose the complete recent
  message history used by the old cleanup check. Legacy resources stay kept;
  a partial latest-message read cannot prove absence of usage.
- a running session's directory is the Expo cwd or inside it
- the container logged non-healthcheck lines in the last 60 min
- Docker Desktop: any container still running
- running sessions unreadable (OpenCode service `127.0.0.1:49374` `/api/session/active`, `scripts/active_sessions.py`) -> keep everything
- Robob's active set is two complete control-API queries, unioned by threadId: every non-idle thread (`active=true`), and provider-native children updated in the last 48 h (`creationSource=provider`), including runless children that appear idle during native work. The active query already covers non-terminal MCP-delegated tasks, so completed task history is excluded. Both queries follow `nextCursor` and perform one paginated catch-up from five seconds before the walk started. If either read is incomplete or fails, everything is kept. Settled history is checked separately.
- keep file

Liveness failure is recorded as `liveness_unavailable` with its cause. Active
OpenCode ids resolve directories through `GET /api/session/:id`; native threads
use their worktree or project workspace. No roster absence proves an ended owner.

## Scheduled agent flow

(nightly 2026-10-15) Now a robob-watch watcher `dev-janitor` (mode notify, hourly), not an LLM run. Check script
`scripts/janitor_watch.sh` starts a detached, locked worker for scan and apply --ids. The worker re-scans before
each action, can run beyond the watcher's 60-second check deadline, and records its result for the next check.
An overlapping check doesn't start a second worker. Checks never print to stdout (robob-watch would forward it
to iMessage). Failed, lost or four-hour-overdue workers, spawn failures and tmpdir-prune failures go to Telegram
with `dev-janitor:<kind>:<occurrence>` keys and an audit `alert` entry, including the delivery key and whether
Telegram accepted the request. Each occurrence's key is persisted before sending: the bridge permanently
deduplicates keys, so a changed error or a repeat after the cooldown needs a new key.
Identical kind/text attempts are suppressed for six hours using `hourly/alerts.json`, separate from worker state.
Telegram failures are audited without printing; check stderr goes to `~/.local/share/dev-janitor/watch.err`.
Report-only findings and liveness problems stay in `audit.jsonl` as `report` entries and never alert.
The old scheduled task "Dev resource janitor (hourly)" (cron `17 * * * *`, Asia/Dubai) is retired and should be disabled.

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
crashed prune raises a Telegram alert on the next hourly run.

Previous flow (kept for reference), run as the Robob scheduled task "Dev resource janitor (hourly)" (cron
`17 * * * *`, Asia/Dubai), imported from OpenChamber.

1. `scan`. If `candidates` is empty, reply one line and stop.
2. For each candidate, sanity-check the `sessions`/`keep_reasons` fields and
   anything odd (e.g. a container with a volume holding unsaved work). Skip if unsure.
3. `apply --ids ...` with the remaining candidates. Order is handled by the script
   (sims, expo, containers, then Docker Desktop, which re-checks that no containers run).
4. Reply with a short list: what was stopped, memory freed (rss_mb / vm_rss_mb),
   what was kept and why. No Telegram unless something failed.

## Leftover agent processes (report-only)

`processes` in the scan report inventories Python/Node agent tools and MCP
runtimes with PID, `lstart`, parent chain to launchd, launchctl label, tty,
redacted command, exact owner when resolved, and MEM/CMPRS from one `top` sample.
MEM and CMPRS overlap; do not add them. Unknown memory is not zero.

Keep registered services/apps, the shared Cua `serve` daemon, Robob/Helpers,
Codex app-server, OpenCode services, Dia, Telegram, tty processes, offbox queue
workers, and keep-file entries. PPID 1, age, low CPU, child-count differences,
and empty lease-local `list_sessions` never establish a leftover.

Temporary HTTP/serve/vite/next servers require an exact terminal and
settled/archived owner, no queued/background/delegated work, and positive
command evidence that this is a temporary server. Only allowlisted native/thread
ids are read from process metadata. Exact native ids resolve through the control
API; recovery reads prove held-work and child state. Unavailable or ambiguous
bindings stay kept. New owner probes stop after a two-minute observation budget
(already-started bounded reads can finish); unexamined processes stay kept. Temporary-server commands, PPID-1 processes,
and temporary/deleted working directories are examined first. The whole priority-ordered cycle
resumes after the last examined priority/PID stored in the report state, so a busy
urgent prefix cannot starve later urgent or ordinary entries; read-only scans never
advance that state. Reports and log lines include checked, skipped and budget-skipped
counts (checked means an owner/binding check was attempted, including unknowns). Cua/Dia/Perplexity stdio children additionally require that
binding and at least two hours since the owner's last activity.

PID/start/args/tty, cwd, listeners/clients, native binding, owner and complete
active/delegated rosters are checked again before reporting. A connected client
keeps the process. Failed/truncated rosters produce no candidates and a reason.
Process candidates are separate from resource ids: `apply --ids` cannot act on
them. The reporter sends no signals and deletes no files.

The exact candidate list (identity, evidence, MEM/CMPRS) and failure reasons are
written to the report and one audit line; hourly checks stay silent.
Pass candidates to the evaluator for an exact TERM approval. Any KILL needs a
separate exact-PID ask; this reporter implements neither action.

## Stale git worktrees (daily, separate job)

`scripts/worktree_reaper.py` runs from LaunchAgent `com.abdullah.worktree-reaper`
every day at 04:30 (`--dry-run` to preview). It finds every repo under `~` and
`/Volumes/ExternalSSD` (depth 3) plus API workspace directories. It uses the
complete cursor-paged OpenCode `GET /api/session` list (`location.directory`,
`time.updated`, and later idle/viewed timestamps when present), plus each repo's
Robob project history (`worktreePath` or project `workspaceRoot`, `updatedAt`,
and `archivedAt` when present). Live and archived Robob threads are read
separately for the 60-day window, following `nextCursor` through every page. Each
listing gets one paginated catch-up with `updatedSince` set to five seconds before
the walk started, covering rows that moved ahead of a cursor. Walks merge duplicate
ids by newest `updatedAt`; the later catch-up row wins. The full match `total`
must stay stable within each pass, and the merged unique count must reach the
initial total (extra ids may only come from catch-up). A page failure, malformed
row/cursor, missing cursor after page one, repeated cursor, changing total,
short count, more than 400 requests, or a 180-second traversal deadline keeps
that repository report-only with `activity_history_unavailable` and its exact
reason. The request budget and deadline cover walk plus catch-up together;
per-page timeouts are unchanged. Older servers without `nextCursor` on page one
retain the single-page check, including the truncation error when `total` exceeds
the returned count. An incomplete
OpenCode history keeps all repositories. No partial list proves inactivity. The daily reaper alone reads session history;
the hourly process/resource scan does not. Directory activity and an updated-time
high-water mark are cached in `~/.local/share/dev-janitor/session-history.json`.
A full read runs at most daily (also on missing/corrupt state or cursor failure).
Between full reads, explicit newest-updated-first pages stop only after a whole
page predates the high-water mark. Ordering is checked on every page. Cache
updates are atomic, and `--dry-run` never writes them. Incremental history alone
cannot authorize removal: viewed/idle activity may change below the updated-time
cutoff. Immediately before removal, refresh the updated-time directory set and
read complete session lists for every known directory inside that worktree
(including its root), with no high-water cutoff. An unreadable/capped directory
read or ignored directory filter keeps the worktree. These reads are scoped to
the candidate; the global history still rebuilds at most daily. History stats include mode,
pages and duration. Reaper status also includes `project_history_stats` per project:
`pages`, raw `rows` (including duplicate and catch-up rows), `archived_rows`
(the archived listing's raw rows), `catch_up_rows`, `seconds`, and per-listing
counts or the exact failure. `repo_outcomes` records kept reason counts and
would-remove paths per repository.
A linked worktree is removed only when all of these hold:

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

## ovnfs (deprecated, uninstalled 2026-11-12)

ovnfs checkouts are gone; agents use git worktrees again. If `~/checkouts`,
`ovnfs` or an `ovnfs-*` LaunchAgent reappears, report it instead of cleaning it.
Salvaged checkout work is in `/Volumes/ExternalSSD/ovnfs-salvage-20261112/`; never delete it.

## Pitfalls

- Never quit Docker Desktop while any container runs or while a session
  mentioned docker in the last hour. On 2026-09-29 quitting it killed an ad-hoc
  `ch508` ClickHouse container a running review session was probing.
- `docker stop` only; never `docker rm`, `docker volume rm`, or `simctl erase/delete`.
- The CuaDriver `serve` daemon, Robob and the OpenCode service are out of scope.
