# 9router tool logs

Metadata-only UTC day logs live at `~/.robob/logs/tools/9router/YYYY-MM-DD.ndjson`.
Both dependency-free writers hash IDs, allowlist scalar metadata, and replace raw
error messages with stable tags. They share retention and cap markers across
processes and languages. Writes are best effort with no tool-work lock.

The five-minute poll uses the existing local CLI authentication in memory and
only GETs `/api/providers`, `/api/usage/logs`, and `/api/usage/stats?period=today`.
It never calls a provider test, refresh, OAuth, reset, settings or account mutation.
The providers response supplies effective reauth markers, enabled/test state,
model locks and rate-limit expiry. The logs endpoint supplies `FAILED 4xx/5xx`
records; labels/emails are resolved to unique connection IDs in memory, then
hashed by the writer. Ambiguous labels become unresolved counts. A multiset of
record hashes avoids recounting repeated snapshots while retaining identical
records' multiplicity. The 200-record endpoint can miss traffic between polls;
`usage.coverage` records that uncertainty rather than claiming full coverage.
Its formatted timestamps are opaque source identities; no local-time conversion
is used. Today's cumulative per-connection cost is sampled once per UTC hour as
`spend.snapshot`. Hourly cost buckets are unavailable (`spend.unavailable`);
these cumulative snapshots must not be summed as hourly spend.

`9router-log-rollup [--day YYYY-MM-DD]` defaults to yesterday UTC. It streams a
fixture or real day file and writes a private `rollup-YYYY-MM-DD.json` with name
and kind counts, rates, duration percentiles and top error tags. The poller makes
yesterday's rollup on its first successful run after 00:05 UTC. Invalid lines
are counted and skipped.

Image CLI behavior is unchanged: no paid fallback is enabled. Its request
function instruments an existing caller-supplied OpenRouter fallback if supplied.
The reauth supervisor remains notification-only in production. Its unreachable
future recovery paths are instrumented and exercised only by synthetic tests.

After review and owner deploy approval, deploy `router-logging` first, then
`catalog-guard`, `stream-recovery`, `local-helpers`. The local-helpers installer
ships the CLI wrappers, key helper, image helper and five-minute LaunchAgent;
it backs up the old image script before linking the shared skill entry point.
The supervisor's existing reviewed installer is a separate required step:
`integrations/deploy.zsh 9router-reauth` (the code-only watcher installer).
Do not deploy the entire watcher integration to ship this one watcher.
No existing service restart is needed for these short-lived processes; the
local-helpers installer loads/reloads its managed LaunchAgents. The watcher
runner picks up the new supervisor on its next tick. No 9router restart.

Focused checks (run offbox):

```
python3 -I integrations/router-logging/test/test_logging.py
node --test integrations/router-logging/test/*.test.mjs integrations/catalog-guard/test/*.test.mjs integrations/stream-recovery/test/*.test.mjs integrations/robob-watch/checks/9router-claude-reauth/supervisor.test.mjs
```
