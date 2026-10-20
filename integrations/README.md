# Integrations

Source for the local services that run next to Robob. This tree is the source
of truth. The copies under `~/.local/share/<name>` are deploy targets: change
code here, test here, then sync it over.

| Dir | Live copy | LaunchAgent |
| --- | --- | --- |
| `agent-bridges` | `~/.local/share/agent-bridges` | `com.abdullah.agent-bridges` (supervises both bridges) |
| `spectrum-bridge` | `~/.local/share/spectrum-bridge` | via agent-bridges (iMessage / Photon) |
| `telegram-bridge` | `~/.local/share/telegram-bridge` | via agent-bridges |
| `robob-watch` | `~/.local/share/robob-watch` | `com.ardud.robob-watch` |
| `memory-system` | `~/.local/share/memory-system` | `com.abdullah.memory-*` |
| `coord` | `~/.local/share/coord` | `com.ardud.coord-pump` (delivery pump) |
| `app-api-cli` | `~/.local/share/app-api-cli` | none (order tracking, delivery store) |
| `stream-recovery` | `~/.local/share/stream-recovery` | `com.ardud.stream-recovery` (event-stream loss recovery, every 60s) |
| `scribe` | `~/.local/share/scribe` | none yet (mission lane notes; run by hand) |
| `catalog-guard` | `~/.local/share/catalog-guard` | `com.ardud.catalog-guard` (repairs a partial OpenCode model catalog, every 150s) |
| `message-archive` | `~/.local/share/message-archive` | `com.ardud.message-archive` (local mail mirror + `msgs` search over email, iMessage, WhatsApp) |

Never add credentials, SQLite state, logs, `data/`, virtualenvs, watcher
state (`robob-watch/watchers`, `archive`) or `.bak` files here. Runtime state
stays in `~/.config/<name>` and `~/.local/share/<name>/data`.

## Deploy

```bash
./integrations/deploy.zsh <name> --dry-run   # show what would change
./integrations/deploy.zsh <name>             # sync, then restart the agent yourself
```

`deploy.zsh` rsyncs source files only and never deletes runtime state on the
live side. Run the package's own checks first (`bun test` / `bun run check`
for the bridges and robob-watch, `pytest` for memory-system).
