# harness-homes

Builds Robob's two isolated harness homes from one non-secret manifest, so the
Claude Code and Codex agents Robob runs never touch the personal `~/.claude` or
`~/.codex`.

- Claude Code home: `~/.robob/harness-homes/claude` (`CLAUDE_CONFIG_DIR`)
- Codex home: `~/.robob/harness-homes/codex` (`CODEX_HOME`)

Stdlib Python only. Auth is never written here: credentials come from each
instance's environment, and OAuth state stays in the home it was created in.

## Files

- `manifest.json`: the single source. Homes, skill roots, canonical AGENTS.md,
  the seven MCP servers, PATH, hooks, Codex model extension, Claude knobs.
- `generate_homes.py`: `generate [--home-root DIR] [--dry-run]` writes both homes
  idempotently (atomic writes, one line per changed file). `check [--home-root DIR]`
  verifies them and exits 1 with each failure.
- `vendor/codex-models-0.166.0.json`: Codex's model catalog at rust-v0.166.0
  (Apache-2.0). `vendor/README.md` has the URL and sha256.
- `overlays/claude.md`, `overlays/codex.md`: per-harness instructions appended to
  the canonical AGENTS.md. Empty until card B2 fills them.
- `install.zsh`: copies the package to `~/.local/share/harness-homes`, generates,
  checks. `--check` only checks. `--with-agent` also loads the LaunchAgent.
- `launchd/com.ardud.harness-homes.plist`: runs `generate` every 5 minutes so
  new skills and AGENTS.md edits reach the homes.
- `tests/test_generate_homes.py`: temp-dir tests only.

## Run

```sh
cd integrations/harness-homes
/opt/homebrew/bin/python3 -m unittest discover -s tests -v
HOME=$HOME /opt/homebrew/bin/python3 generate_homes.py generate --home-root /tmp/harness-try
HOME=$HOME /opt/homebrew/bin/python3 generate_homes.py check --home-root /tmp/harness-try
```

Deploy with `integrations/deploy.zsh harness-homes [--with-agent]`. Nothing uses
the homes until the release; the evaluator installs them.

## Rules the generator enforces

- Memory is off in both harnesses (DECISIONS 15): Claude `autoMemoryEnabled`,
  `autoDreamEnabled` and the two `CLAUDE_CODE_DISABLE_*MEMORY` env vars; Codex
  `features.memories`/`chronicle` and `memories.*` set to false.
- Refuses a home inside `~/.claude`, `~/.codex` or `/Volumes/ExternalSSD/codex`.
- Skill links never delete a real directory or a symlink pointing elsewhere.
  Two skills with the same name stop the run with both paths.
- The Codex catalog changes only the three extended slugs.
- `t3-code` is never in the manifest: Robob injects it per thread.
