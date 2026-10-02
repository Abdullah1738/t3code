# Memory System

Personal long-term memory for AI agent work (Codex, Hermes, OpenCode). Lossless
merge of past sessions, continuous sync, semantic decision memory with
supersession, near-real-time cross-session recall, and a self-triaging janitor.

This directory holds **only the system**: source, scripts, schema, docs.
It never holds runtime data.

## Layout

- `src/` - pipeline + runtime
  - `sync_opencode_v2.py` - incremental OpenCode session sync (canonical ledger)
  - `chronological_extractor.py` - glm-5.3-flash fact extraction (resumable, `--active`, `--changed-since`)
  - `embed_facts.py` / `memory_retrieval.py` - Qwen3-Embedding-0.6B vectors + hybrid recall (MPS, fp16)
  - `consolidate.py` - dedupe/supersede/contradict judge (candidates -> clusters -> judge -> apply/rollback)
  - `flatten_pointers.py` - collapse multi-hop superseded_by_id chains
  - `profile_compiler.py` - compile personal profile from facts
  - `build_text_fts.py` - one-off, resumable build of `episodic_text_fts` (text-only history index used by default searches; writers need SQLite >= 3.47; not in `schema.sql`, so run it after a DB rebuild or searches fall back to the slower `episodic_fts` path)
  - `memory_mcp.py` - MCP server (streamable-HTTP `/mcp`, port 18765): memory_recall, memory_search_history, memory_session_context, memory_profile, memory_remember
  - `janitor.py` - daily scan: orphans, contradictions, coverage gaps, low-confidence profile facts. Autofix safe, Telegram digest for questions.
- `scripts/` - shell entry points (sync tick, embed/candidate chain, FTS rebuild)
- `sql/`, `schema/` - DDL
- `docs/` - design + research notes

## Runtime data lives elsewhere

All databases, vectors, logs and the live state file are **not** in this repo:

```
~/.local/share/memory-system/
  data/            memory.db, codex_raw.db (symlink -> ExternalSSD), opencode_raw.db,
                   fact_vectors.db, consolidation.db
  logs/            tick/janitor/extract logs, janitor_last.json
  HANDOFF.md       live build + ops state (source of truth for where things stand)
```

Nothing under `data/`, `logs/`, `venv/`, `.venv/` or any `*.db`/`*.wal` belongs in
git. Secrets (provider API keys) stay in `~/.config/opencode/` and are read at
runtime, never committed.

## LaunchAgents (gui/501)

- `com.abdullah.memory-sync` - sync + extract tick, every 120s
- `com.abdullah.memory-mcp` - MCP server on 127.0.0.1:18765. The plist sets
  `SoftResourceLimits`/`HardResourceLimits` `NumberOfFiles` to 8192; launchd's
  default soft limit of 256 is too low for many concurrent client sessions.
  Reference copy: `scripts/com.abdullah.memory-mcp.plist`.
- `com.abdullah.memory-janitor` - daily 09:00 triage sweep, Telegram digest

## Working agreement

Agents that fix or extend the memory system commit and push to `main` in this
repo. Keep changes commit-sized, use Conventional Commits, and never commit
runtime data, secrets, or personal facts. See `HANDOFF.md` in the runtime dir
for the current operational state before making changes.
