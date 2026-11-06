# Memory System (recall)

Every session Abdullah has had with AI agents (Codex, Hermes, OpenCode/Robob, Muse Code) in
one SQLite store, with instant search, Haiku answers over the transcripts and a
cautious auto-recall plugin. No extracted facts, profiles or graphs: the
transcripts are the memory.

This directory holds only the system: source, scripts, schema. It never holds
runtime data.

## Layout

- `src/sync_opencode_v2.py` - incremental OpenCode capture into `episodic_events`
  (Codex and Hermes were one-time imports). A session is rescanned when its
  `time_updated` or its message count / max seq changes (the second catches
  appended messages, since `time_updated` does not move). The fingerprint table
  `opencode_sync_progress` starts empty, so the first runs rescan every session
  once; this is resumable (each finished session is recorded, `--deadline` stops
  between sessions). One failing session no longer stops the run: it is logged,
  not stamped, retried next run, and the run exits 1. `OPENCODE_DB` overrides the
  source db path (tests use a temp db).
- `src/sync_muse.py` - incremental Muse Code capture (source `muse`): tails each
  `~/.local/share/muse/sessions/**/session.jsonl` from its last byte offset
  (`muse_sync_files`), projects prompts, answers, reasoning summaries and tool
  calls/results, skips Muse's reminder-observer children, and keeps Robob thread
  titles and parents in `muse_sessions`. Runs inside the capture tick.
- `src/wal_truncate.py` - last step of the capture tick. The writers run with
  auto-checkpoints off, so it resets the `memory.db` and `opencode_raw.db` WALs
  with a zero-wait PASSIVE then TRUNCATE checkpoint. A reader holding old frames
  just leaves it for the next tick; it never fails the tick (`WAL {...}` lines
  in the capture log).
- `src/build_text_fts.py` - builds `episodic_text_fts`, the contentless
  user/assistant text index the search uses (writers need SQLite >= 3.47; not in
  `schema.sql`, so run it after a DB rebuild).
- `src/recall_core.py` - read-only search and reading: query planning with
  FTS5 doc frequencies (AND the rarest terms, drop common ones), session ranking,
  the session catalog (`data/recall_catalog.db`: title, dir, dates, parent),
  transcript rendering and id resolution.
- `src/recall_ask.py` - Haiku 5.5 (via 9router) plans searches, answers
  questions with [n] citations, and gates auto-recall notes (defaults to none).
- `src/recall_server.py` - MCP server on 127.0.0.1:18765 (`/mcp`: `recall_ask`,
  `recall_search`, `recall_read`, `recall_list`) plus `POST /api/inject`,
  `POST /api/ask`, `GET /api/health`. Refreshes the catalog every 60 s.
- `src/recall_cli.py` - the `recall` CLI (`list`, `query`, `search`, `view`,
  `inject`, `refresh`).
- `src/health_check.py`, `session_reaper.py`, `location_reaper.py`,
  `backend.py`, `dropbox_mirror.py` - ops.
- `scripts/` - capture tick, backup, stall watch, cold archive, LaunchAgent
  plists.

The OpenCode plugin that calls `/api/inject` lives outside the fork at
`~/.config/opencode/plugin/recall.ts` (config `~/.config/opencode/recall.json`).

## Runtime data lives elsewhere

```
~/.local/share/memory-system/
  data/   memory.db (episodic_events + FTS), opencode_raw.db, recall_catalog.db
  logs/   capture/backup/health logs, recall_server.log, recall-inject.jsonl,
          recall-plugin.jsonl
  .venv/  Python 3.14 with mcp, starlette, uvicorn (recall server only)
```

Nothing under `data/`, `logs/` or `.venv/` belongs in git.

## LaunchAgents (gui/501)

- `com.abdullah.memory-sync` - capture tick, every 120 s
- `com.abdullah.recall` - recall server on 127.0.0.1:18765. The plist raises
  `NumberOfFiles` to 8192; launchd's default 256 is too low for many clients.
  Reference copy: `scripts/com.abdullah.recall.plist`.
- `com.abdullah.memory-health` - health check every 15 min (capture, recall,
  backups, disk; also the health and Moni backups going stale after 13 h), Telegram on failure
- `com.abdullah.memory-backup` - restic every 4 h, mirrored to Dropbox.
  Snapshots hold replicas of memory.db and opencode_raw.db, plus
  `robob-state.sql`, a `.dump` of Robob's small state tables (schedules,
  projects, board, import map, thread index). The full Robob DB is not backed up.
  Replicas and restic run at background I/O priority; limits for replicas and restic backup are `MEMORY_BACKUP_REPLICA_TIMEOUT_S` (10800 s) and `MEMORY_BACKUP_RESTIC_TIMEOUT_S` (7200 s).
- `com.abdullah.session-reaper` (30 min) and `com.abdullah.location-reaper` (5 min)

## Backend (OpenChamber or Robob)

`session_reaper.py` and `location_reaper.py` pick their backend in
`src/backend.py` from `MEMORY_BACKEND`:

- `openchamber` (default): OpenCode endpoints through OpenChamber
  (`OPENCHAMBER_URL`).
- `robob`: OpenCode endpoints on the OpenCode service directly
  (`OPENCODE_SERVICE_URL`, default `http://127.0.0.1:49374`, basic auth `opencode`
  with `OPENCODE_SERVER_PASSWORD` or `~/.config/opencode-service/password`), the
  Robob control API (`T3_CONTROL_URL`/`T3_CONTROL_TOKEN`, else
  `T3_CONTROL_TOKEN_FILE`, else `~/.robob/components/memory.json`), and Robob's
  state DB read-only (`ROBOB_STATE_DB`, default `~/.robob/userdata/statev2.sqlite`)
  for the board backlog. The reaper deletes nothing while the Robob board can't be read, and
  archives the Robob thread of each deleted root session.

Tests: `python3 -m unittest discover -s tests -p 'test_*.py'` and
`bash tests/test_stages.sh`.

Deploy: `integrations/deploy.zsh memory-system`, then
`launchctl kickstart -k gui/$(id -u)/com.abdullah.recall`.
