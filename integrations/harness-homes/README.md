# harness-homes

Builds Robob's three isolated harness homes from one non-secret manifest, so the
Claude Code and Codex agents Robob runs do not use the personal `~/.claude` or
`~/.codex` homes.

- Claude Code home: `~/.robob/harness-homes/claude` (`CLAUDE_CONFIG_DIR`)
- Codex home: `~/.robob/harness-homes/codex` (`CODEX_HOME`)
- Codex Terra home: `~/.robob/harness-homes/codex-cu` (`CODEX_HOME`)

Stdlib Python only. Auth is never written here: credentials come from each
instance's environment, and OAuth state stays in the home it was created in.

## Files

- `manifest.json`: the single source. Homes, skill roots, canonical AGENTS.md,
  shared MCP servers (including recall's canonical `http://127.0.0.1:18765/mcp`
  service), PATH, hooks, Codex model extension, Claude knobs.
- `generate_homes.py`: `generate [--home-root DIR] [--dry-run]` writes all homes
  idempotently (atomic writes, one line per changed file). `check [--home-root DIR]`
  compares their owned contents with the manifest and catalog. `mcp-diff`
  compares the manifest's MCPs with OpenCode's (see "MCP parity with OpenCode").
- `vendor/codex-models-0.166.0.json`: Codex's model catalog at rust-v0.166.0
  (Apache-2.0). `vendor/README.md` has the URL and sha256.
- `overlays/claude.md`, `overlays/codex.md`, `overlays/codex-cu.md`:
  per-harness instructions. `codex-cu` gets the shared Codex overlay first,
  then its own draft overlay; generation fails if the latter is missing or empty.
  Its deployment still requires owner approval.
- `install.zsh`: copies the package to `~/.local/share/harness-homes`, generates,
  checks. `--check` only checks. `--with-agent` also loads the LaunchAgent.
- `launchd/com.ardud.harness-homes.plist`: runs `generate` every 5 minutes so
  new skills and AGENTS.md edits reach the homes.
- `tests/test_generate_homes.py`: temp-dir tests only.

## Source parity checks

`generate` also writes `parity-manifest.json` in each home. This is metadata,
not another copy of the skills or guards. Skills remain symlinks into every
`skillRoots` entry; hook implementations remain in the shared integrations.
The native harnesses discover skill metadata themselves, so the OpenCode-only
compact-skill-catalog plugin does not need a native port. No skill count is pinned.

`check --json [--home-root DIR]` runs the same read-only check as `check` and
returns `{schemaVersion: 1, ok: boolean, failures: string[], homes: [...]}`.
Each home entry is `{harness, home, parityManifestPath}`. Exit 0 means all
owned files, skill links, and parity metadata match current sources; exit 1
means drift or an unreadable required source. Check never refreshes metadata.

Each parity manifest has schema version 1 and these fields:

- `harness`, `manifestSha256`, `generator: {path, sha256}`.
- `artifacts: [{path, sha256}]`: absolute paths and SHA-256 of expected bytes
  for every owned generated file except this parity manifest. Claude covers
  `settings.json`, `.claude.json`, `CLAUDE.md`, `overlay.md`; each Codex home
  covers `config.toml`, `hooks.json`, `AGENTS.md`, `models.json`. Hashes come
  from the generator's plan, never from potentially edited output files.
  Only `.claude.json` has `format: "claude-owned-json"`: hash the projection
  `{mcpServers, hasCompletedOnboarding}` as recursively key-sorted compact JSON
  (`separators=(",", ":")`, UTF-8, `ensure_ascii=False`, no trailing newline).
  CLI-managed projects/counters remain preserved and do not invalidate parity.
  All other artifacts omit `format` and retain raw-byte SHA-256.
- `skills: [{name, source, sha256}]`, hashing the source `SKILL.md`.
- `mcpServers`: the manifest's shared non-secret server specifications.
- `runtimeMcpServers: ["t3-code"]`: injected per thread, not proven by home generation.
- `guards: [{id, sources: [{path, sha256}]}]` and harness-filtered `hooks`.
- `instructions: {canonical: {path, sha256}, overlays: [{path, sha256}]}`.
- `compactSkillCatalog: {required: false, reason}`.

## MCP parity with OpenCode

OpenCode keeps its MCPs in `~/.config/opencode/opencode.jsonc` (top-level
`mcp`); the native homes get theirs from `mcpServers` here. The manifest's
`mcpParity` block (`{"opencodeConfig": "...", "ignore": []}`) makes `check`
and `check --json` fail until both sides list the same servers, so an MCP
added in one place cannot quietly miss the other harnesses.

- Ids are compared as sets. An OpenCode entry with `"enabled": false` counts
  as absent (a missing `enabled` means enabled). Ids in `ignore` are skipped on
  both sides; use it only for servers meant to live in one place.
- For shared ids it also compares transport (`url` vs `command`), the url or
  command path, args, and env key names (never values).
- A missing or unparseable OpenCode config is a check failure (fail closed).
  `generate` never fails on parity; it prints `warning: mcp parity: ...` on stderr.
- `mcp-diff [--json] [--opencode-config PATH]` prints both sides per id with a
  status (`ok`, `mismatch`, `opencode-only`, `native-only`, `ignored`,
  `disabled`); exit 1 on drift. It is read-only.
- Parity follows the configured homes. A `--home-root` run (tests, the
  harness-cli canary) skips it unless `--opencode-config PATH` is given.
- The JSONC reader is stdlib-only: it strips `//` and `/* */` comments outside
  strings and trailing commas, then uses `json`.

To fix drift, add the server to whichever side lacks it (or to `ignore`), then
run `generate` so the homes pick it up.

Readiness consumers should run the existing generator check, not trust a
standalone `ok` flag in an old artifact. These checks prove config/source
parity only; they do not prove hook trust, MCP authentication, injected T3
tools, or a native turn's runtime behavior. Recall can be overridden with
thread-scoped headers by the provider adapter.

## Run

```sh
cd integrations/harness-homes
/opt/homebrew/bin/python3 tests/test_generate_homes.py
```

To verify the packaged draft without touching live homes, use a fresh temporary
root outside the configured homes:

```sh
/opt/homebrew/bin/python3 generate_homes.py generate --home-root /path/to/isolated-homes
/opt/homebrew/bin/python3 generate_homes.py check --home-root /path/to/isolated-homes
```

The production model is `gpt-6.1-terra`; it depends on the plain-ID 9router combo
from #226. Until that is live, an isolated Codex CLI proof can pass
`-m cx/gpt-6.1-terra`; the CU catalog carries the same upstream metadata and
1,050,000/450,000 limits for both IDs. Activation also needs the pinned binary
from #249.

Deploy with `integrations/deploy.zsh harness-homes [--with-agent]`. Nothing uses
the homes until the release; the evaluator installs them.

## Rules the generator enforces

- Memory is off in both harnesses (DECISIONS 15): Claude `autoMemoryEnabled`,
  `autoDreamEnabled` and the two `CLAUDE_CODE_DISABLE_*MEMORY` env vars; Codex
  `features.memories`/`chronicle` and `memories.*` set to false.
- Refuses a home inside `~/.claude`, `~/.codex` or `/Volumes/ExternalSSD/codex`.
- Skill links never delete a real directory or a symlink pointing elsewhere.
  Two skills with the same name stop the run with both paths.
- The Codex catalog changes only the three extended slugs. The CU catalog retains
  those entries, raises Terra to 1,050,000, and adds its prefixed alias using
  the original Terra metadata. Compaction is 450,000.
- Shared MCPs, skills and Codex-scoped hooks also go to `codex-cu`; native
  `node_repl` is exclusive to that home. Codex has `computer_use=false`;
  Claude denies its computer and node-repl tool names.
- Hook manifest entries apply to all harnesses by default. An optional
  `harness` string (`claude` or `codex`) restricts them; `codex` also selects
  `codex-cu`.
- `t3-code` is never in the manifest: Robob injects it per thread.
