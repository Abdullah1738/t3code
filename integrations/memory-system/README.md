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
  not stamped, retried next run, and the run exits 1. `OPENCODE_READONLY_DB` selects
  the source export (default `~/.robob/userdata/readonly/opencode.sqlite`);
  legacy `OPENCODE_DB` overrides it but cannot point at the live database.
- `src/sync_muse.py` - incremental Muse Code capture (source `muse`): tails each
  `~/.local/share/muse/sessions/**/session.jsonl` from its last byte offset
  (`muse_sync_files`), projects prompts, answers, reasoning summaries and tool
  calls/results, skips Muse's reminder-observer children, and keeps Robob thread
  titles and parents in `muse_sessions`. Runs inside the capture tick.
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
  plists. `src/export_opencode.py` is the sole native live-DB reader: it produces
  `~/.robob/userdata/readonly/opencode.sqlite` for all other native consumers.

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
- `com.abdullah.opencode-readonly` - paced native export, continuous with 15s
  between completed cycles; reference plist in `scripts/`. It is independent of
  Robob restarts and runs at background CPU/I/O priority.
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
  server-owned replica (`ROBOB_READONLY_DB`, default
  `~/.robob/userdata/readonly/state.sqlite`; `ROBOB_STATE_DB` overrides it)
  for the board backlog. The reaper deletes nothing while the Robob board can't be read, and
  archives the Robob thread of each deleted root session.

All Robob state readers, including recall (`RECALL_STATE_DB` overrides the shared
setting), identity capture, native transcript reports and the backup table dump,
refuse the live database and its filesystem aliases. They never fall back when
the export is missing. State readers require `ardud_readonly_meta.ready=1` and an
ISO `updated_at` within two minutes. The server must clear readiness while paging
and publish a fresh timestamp only after catchup completes; recall rebuilds its
lineage cache at that boundary or when the file is replaced. Backup coverage is limited to tables
the server exports; missing tables are logged, not read from the live database.
OpenCode capture and native lineage/activity readers use the separate native
export (`session_v2`, `session_message`, inbox/pending tables), not Robob's
`state.sqlite`. Deploy the native exporter LaunchAgent before these consumers;
until its first fresh metadata generation, readers deliberately refuse partial
evidence. Capture skips individual incomplete/dirty sessions rather than blocking
completed sessions. No live OpenCode fallback is permitted,
even through `OPENCODE_DB` symlinks/hardlinks.

### Native export

The producer copies only `session_v2` (all columns, required by lossless raw
capture), the seven message columns used by capture/reaper checks, and
`id,session_id` from inbox/pending. It never copies events, instructions, project
tables, credentials or queue payloads. OpenCode 2.0.22's indexed per-session
`event_sequence` detects message changes without scanning every payload or
relying on session timestamps (which do not advance for appended messages).
Small session/queue metadata is paged every pass, including claim/view updates
that do not emit events. Deleted rows are pruned in bounded pages.

Source is a separate `mode=ro`, `query_only` WAL connection. Source statements
have a 25ms SQLite progress budget; 64KiB blob reads close before target writes
and the 5ms pacing delay. No read transaction or blob handle spans a step, sleep,
target commit or large-payload assembly. Very large JSON cells use persistent
chunk staging; no source index/schema is written. Disk I/O for one chunk cannot
be hard wall-clock bounded; the byte cap bounds the work and the transaction is
closed immediately afterwards. Message versions and strict event fences discard
mixed-version data. Each session pass has a fixed upper message sequence, so a
streaming session cannot keep extending its pass forever. A final small metadata
pass marks sessions with later work as synthetic `session_pending` protection
rows (`readonly:pending:<session-id>`); they cannot become deletion candidates
until a following payload pass catches up. These markers contain no queue text
and are not commands or writable native state.
Payloads are stored as bounded chunks with a small metadata pointer. The exported
`session_message` view exposes the unchanged seven-column read contract; only a
consumer selecting `data` assembles that message's ordered chunks. Count/max and
session lookups never assemble payloads. Replaced/deleted/interrupted payloads
enter a durable retirement queue. After publication the producer drains that queue
in paced pages before starting another replacement cycle, so cleanup keeps up with
new copies rather than accumulating obsolete payloads. No large delete or cell
rewrite is needed. First run copies history once,
resumably, so it needs free space for exported history plus interrupted/old chunks
awaiting cleanup. Later passes skip unchanged aggregate sequences. Dirty sessions
are re-read through their fixed fence, including historical messages: native
millisecond timestamps cannot safely identify same-ms payload rewrites.
Readiness/freshness is metadata, never file mtime. `history_ready` diagnoses global
bootstrap completeness; capture/health use the per-session completion ledger so
one unstable session cannot block completed history. Capture never stamps a
dirty/incomplete session as imported. Reapers additionally require
`destructive_ready=1`, which means no source commit raced the final metadata pass.
If that pass races again, non-destructive readers can proceed but reapers refuse
the generation. This is still an eventual snapshot, not a source mutation lock.
Freshness stays anchored to the oldest pass input, so a very slow first bootstrap
can finish stale, then publish a fresh generation after the next incremental pass.

Producer source configuration: `OPENCODE_EXPORT_SOURCE_DB` (default
`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`). Destination:
`OPENCODE_READONLY_DB` (same default as consumers). The source override is
producer-only; `OPENCODE_DB` remains a guarded legacy reader override. Python 3.11+
is required for incremental blob I/O; the plist uses Homebrew Python.

For first deployment, sync this integration, create its log directory, install
`scripts/com.abdullah.opencode-readonly.plist` in `~/Library/LaunchAgents/`, and
bootstrap that agent. Wait for `ready=1` and fresh `updated_at` in the **export**
before restarting the recall/capture readers. After an OpenCode schema change or
source-file replacement, rebuild this disposable export (never alter live state).
The producer refuses overlapping instances and source/target aliases.

Tests: `python3 -m unittest discover -s tests -p 'test_*.py'` and
`bash tests/test_stages.sh`.
Linux/offbox shell fixtures: `python3 tests/run_shell_fixtures.py` (requires
sqlite3, restic and rsync; remaps macOS-only utilities in temporary copies).
Python tests require SQLite >= 3.47 for the FTS schema and the recall server's
MCP/Starlette dependencies.

Deploy: `integrations/deploy.zsh memory-system`, then
`launchctl kickstart -k gui/$(id -u)/com.abdullah.recall`.
