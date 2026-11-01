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
  the seven MCP servers, PATH, hooks, Codex model extension, Claude knobs.
- `generate_homes.py`: `generate [--home-root DIR] [--dry-run]` writes all homes
  idempotently (atomic writes, one line per changed file). `check [--home-root DIR]`
  compares their owned contents with the manifest and catalog.
- `vendor/codex-models-0.166.0.json`: Codex's model catalog at rust-v0.166.0
  (Apache-2.0). `vendor/README.md` has the URL and sha256.
- `overlays/claude.md`, `overlays/codex.md`, `overlays/codex-cu.md`:
  per-harness instructions. The `codex-cu` overlay must be owner-approved before
  it is placed in the package; generation fails closed if it is missing or empty.
- `install.zsh`: copies the package to `~/.local/share/harness-homes`, generates,
  checks. `--check` only checks. `--with-agent` also loads the LaunchAgent.
- `launchd/com.ardud.harness-homes.plist`: runs `generate` every 5 minutes so
  new skills and AGENTS.md edits reach the homes.
- `tests/test_generate_homes.py`: temp-dir tests only.

## Run

```sh
cd integrations/harness-homes
/opt/homebrew/bin/python3 tests/test_generate_homes.py
```

Before approval, an isolated proof can supply the draft explicitly, without
copying it into the package or live homes. Use a fresh temporary root outside the
configured homes and the same source for both commands:

```sh
/opt/homebrew/bin/python3 generate_homes.py generate --home-root /path/to/isolated-homes \
  --codex-cu-overlay /Volumes/ExternalSSD/t3code-fork/tmp/robob-board/computer-use/integrations/harness-homes/overlays/codex-cu.md
/opt/homebrew/bin/python3 generate_homes.py check --home-root /path/to/isolated-homes \
  --codex-cu-overlay /Volumes/ExternalSSD/t3code-fork/tmp/robob-board/computer-use/integrations/harness-homes/overlays/codex-cu.md
```

The draft override is rejected without `--home-root` and for a root overlapping
any configured home. It is not an approval or a production install mechanism.
The production model is `gpt-6.1-terra`; it depends on the plain-ID 9router combo
from #226. Until that is live, an isolated Codex CLI proof can pass
`-m cx/gpt-6.1-terra`; the CU catalog carries the same upstream metadata and
1,050,000/450,000 limits for both IDs.

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
  `harnesses` list restricts them; `codex` also selects `codex-cu`.
- `t3-code` is never in the manifest: Robob injects it per thread.
