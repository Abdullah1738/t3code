# OpenCode session import

Shows existing OpenCode 2 sessions as normal threads, bound to their native
session, so sending a message continues the same `ses_...`. Reads OpenCode only
through its HTTP API; never writes to OpenCode.

## What it does

- Every root session (no `parentID`) becomes a thread with id
  `ardud-opencode-import:thread:<ses_id>`: title, created/updated time, archived
  state, and the session's last model (falls back to the default model when
  OpenCode no longer offers it). Sessions idle for more than a day start settled.
- Project: the session's OpenCode project root (repo subfolders and worktrees stay
  with their repo), else its own folder. OpenChamber's dated folders group under
  two projects, `~/.config/openchamber/chats` and `~/.config/openchamber/imessage`.
  The thread runs in the session's own folder (as its worktree path) when that
  differs from the project root. A deleted folder falls back to its nearest
  existing parent.
- History is lazy. The first time a thread is read (opened in the UI, the control
  API, MCP, or sent to) the newest 300 messages are pulled into the thread as
  read-only history. Older ones stay in OpenCode, with a note at the top. Later
  reads add only newer messages, until T3 runs a turn on the thread; from then on
  the adapter records new turns itself.
- Subagent calls in a transcript link to child threads (normal subagent lineage,
  same as live OpenCode subagents), created when the parent's history loads.
  Their own history loads when opened.
- Sessions already bound to a T3 thread are skipped, as are sessions under two
  minutes old (T3 may still be binding them).
- Re-runs are incremental: new sessions are added; title and archive changes are
  mirrored unless the thread was renamed or (un)archived in T3 since.

Tables (statev2.sqlite): `ardud_opencode_import` (shared mapping),
`ardud_thread_origin` (`imessage` from `metadata.openchamber.origin` or the
`~/.config/openchamber/imessage/` folder; children inherit it), and the private
`ardud_opencode_import_state`.

OpenCode server: the opencode provider's `serverUrl` + `serverPassword` from
settings, else `~/.local/state/opencode/service.json`.

## Usage

The server must be running for the home.

```sh
t3 ardud opencode-import --base-dir <t3 home> [--since <days>] [--limit <n>] [--dry-run]
# dev worktree: node apps/server/src/bin.ts ardud opencode-import --base-dir <home>
```

HTTP, with a bearer token from `t3 auth session issue --base-dir <home> --json`
(needs `orchestration:operate`):

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sinceDays": 2, "dryRun": false}' http://127.0.0.1:<port>/api/ardud/opencode-import/run
```

Automatic sync, off by default: `T3CODE_ARDUD_OPENCODE_SYNC=1` imports at start
and then every `T3CODE_ARDUD_OPENCODE_SYNC_MINUTES` (default 5) for sessions
touched in the last two days.
