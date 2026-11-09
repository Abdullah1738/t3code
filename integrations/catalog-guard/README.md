# catalog-guard

Repairs a partial OpenCode model catalog in Robob.

Robob probes the shared OpenCode service once at startup and keeps that model
list until something refreshes it. If the probe lands before OpenCode's
plugins have settled, it can store a free-only list (the 11-model catalog seen
on 2026-10-18 and 2026-10-19), and every `opus/*` delegation is then refused.

Every 150 s (`com.ardud.catalog-guard`) `check`:

1. Reads authenticated `GET /api/ardud/control/harness-cutover/status` and
   `~/.robob/caches/opencode.json` (read-only). Before cutover it requires
   `opus/claude-opus-5-5` and `opus/cx/gpt-6.1-sol`. While cutover is active or
   completed it requires only retained OpenCode selections, defaulting to the
   title model `surplus/glm-5.3-flash`; Claude/OpenAI requirements and the
   `opus/` prefix are removed. Optional status `retainedOpenCodeModels: string[]`
   supplies the exact retained selections. A healthy cache needs no OpenCode probe.
2. Otherwise asks the OpenCode service (`127.0.0.1:49374`, `/api/model` for the
   home directory, which is where Robob probes) which models it lists.
3. If the service lists watched models the cache lacks, sends Robob's targeted
   `server.refreshProviders {instanceId: "opencode"}` over the WS RPC, at most
   once per 5 minutes, then re-reads the cache and logs one line.

It never restarts Robob or OpenCode and never calls `POST /api/location/reload`
(that cancels pending permissions in every location). Nothing is logged when
the catalog is healthy.

Missing or malformed cutover status holds refresh; an HTML fallback with HTTP
200 is not status. The policy is rechecked before refresh. Override retained
requirements with `CATALOG_GUARD_REQUIRED='["provider/model"]'` if the server does
not publish them; `CATALOG_GUARD_PREFIX` controls pre-cutover prefix watching.
Departing Claude/OpenAI models are excluded even from explicit retained lists.
This guard compares only the `opencode` instance. Pointing
`CATALOG_GUARD_INSTANCE` at Claude/Codex is rejected rather than comparing their
cache to the OpenCode service. Native catalog readiness belongs to cutover's
provider-aware preconditions, not this OpenCode comparator.

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
