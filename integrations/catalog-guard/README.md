# catalog-guard

Repairs a partial OpenCode model catalog in Robob.

Robob probes the shared OpenCode service once at startup and keeps that model
list until something refreshes it. If the probe lands before OpenCode's
plugins have settled, it can store a free-only list (the 11-model catalog seen
on 2026-10-18 and 2026-10-19), and every `opus/*` delegation is then refused.

Every 150 s (`com.ardud.catalog-guard`) `check`:

1. Reads `~/.robob/caches/opencode.json` (read-only). If `opus/claude-opus-5-5`
   and `opus/cx/gpt-6.1-sol` are present it stops there, without any network call.
2. Otherwise asks the OpenCode service (`127.0.0.1:49374`, `/api/model` for the
   home directory, which is where Robob probes) which models it lists.
3. If the service lists watched models the cache lacks, sends Robob's targeted
   `server.refreshProviders {instanceId: "opencode"}` over the WS RPC, at most
   once per 5 minutes, then re-reads the cache and logs one line.

It never restarts Robob or OpenCode and never calls `POST /api/location/reload`
(that cancels pending permissions in every location). Nothing is logged when
the catalog is healthy.

```bash
node cli.mjs check --dry-run                 # decide and print only
node cli.mjs check --dry-run --cache <copy>  # judge a saved cache file
node cli.mjs status                          # state file
```

Log: `~/Library/Logs/catalog-guard.log`. State:
`~/.local/share/catalog-guard/data/state.json`. Tests: `npm test`.

Install: `./integrations/deploy.zsh catalog-guard`, copy
`scripts/com.ardud.catalog-guard.plist` to `~/Library/LaunchAgents/`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ardud.catalog-guard.plist`.
