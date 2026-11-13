# Synthetic seed provenance

All data inputs are numeric aggregates. This table records inputs; it is not a calibration result. The final refinement was approved in the #1352 discussion. After one 120-second warm-up /60-second diagnostic, these load inputs are frozen for the prescribed .9 calibration; any fidelity gaps go back to the evaluator before further changes.

| Field | Source | Value used |
|---|---|---|
| Board count | .9 cumulative board decode-cache entries; evaluator clarification |17|
| Large primary cards / open / settled | Packet live override |4,290 /3,900 /390|
| Large secondary cards | Packet live override |1,320|
| Large secondary open / settled | .9 trace, second-ranked largest open-card read |1,048 /272|
| Small board card counts | Backup rank3/rank4 counts, alternating across15 boards |114 and22|
| Primary discussions | Packet live override |3,224|
| Other total discussions | Backup discussions/card ratio, rounded |See ranked table|
| Open discussions | .9 complete tickBoard parent groups, max settleDiscussion per board |See ranked table|
| Active cards / active reviewers / inactive review landings | .9 per-board tickStep maxima: missingThread /reviewerBackstop /landing |See ranked table|
| Parked cards | .9 tickLocalWaits latest parked counters, sorted numeric ranks |98,64,11,5,4,4,3,3,2,2,1,1,1,1,0,0,0|
| Wait kind/deadline | Synthetic choice; backup predates waits, trace lacks per-kind census |time /24h after seed; no expiration in run|
| Non-active card stages | Backup per-board stage counts; live active/review counts override maintenance-relevant states |shape.json boardRanks[].stages; inactive working→todo, review landing counts from trace|
| Subtasks, asks, links/card | Backup marginal count percentiles |shape.json boardRanks[] distributions|
| Open asks | Backup open-ask count/card, scaled |Primary18, secondary26, small0;44 total|
| Nested strings (task text/note, ask text, link URL/label), title and description | Backup byte-size percentiles |shape.json boardRanks[] distributions; synthetic ASCII text|
| Card JSON byte budget | Backup per-board JSON byte percentiles |Inverse-CDF interpolation; nested text capped to row budget, remainder filled by synthetic prompt|
| Row identifiers, titles, bodies, URLs | Synthetic |load-* ids; example.invalid links; no copied text|
| Models/pools | Backup pool totals; synthetic single-model provider stand-in |67 slots:18 primary,33 secondary,11 across eight rank3-sized boards,5 across seven rank4-sized boards. Small-board slots are apportioned evenly with remainder to earlier ranks. Original pool vectors:18=10+0+5+1+0+2;33=1+0+1+30+0+1;11=0+0+0+9+0+2;5=0+0+1+1+0+3.|
| Active/detached thread references | .9 per-board missingThread and silentRunBackstop maxima; evaluator-approved relationship |Primary19 active +14 detached=33; secondary13+7=20. Small ranks use their own counts, with detached=max(0,silentRunBackstop-active); when active exceeds silent count the active count takes precedence. Other ToDo cards have no thread.|
| Thread-card joins and history | Real persistence relationships for linked cards |addThreadCard and putThreadLink for each linked card; inactive links ended, active role from trace. Completed historical cards retain synthetic links.|
| Review/PR shape | .9 reviewerBackstop and landing counts; synthetic PR metadata |One-step Load review chain; landing cards have reviewStep1 and an open PR link watched by their idle thread. Active reviewers have open PRs. Counts are trace-derived; exact PR/wait-kind census is unavailable. Existing parked-count seed remains time waits; PR checks remain pending.|
| Adapter boundary | Synthetic full KanbanThreads facade |Replaces internal shell/failure/receipt/send behavior as well as external transport; view timestamps refresh on reads. This omits product work and is a fidelity gap, not a claim of a full real provider composition.|
| Outbox | Synthetic commands with effects:[] |Queue observed but command-generated outbox pressure is not reproduced.|
| Statev2 history | Synthetic linked threads +driven events |Historical multi-million-row projection footprint is not seeded by this version|
| Provider write kinds and rates | .9 exact-minute writer caller counts +event-type spans |284 parentless +200 start writes/min;122 other commands/min;189 pacing calls/min|
| Provider turn-end notifications | .9 exact-minute KanbanService.turnEndedUnlocked |13/min (replaces unmeasured200/min assumption)|
| Tick scheduling | Real apps/server/src/ardud/kanban/layer.ts |Forked KanbanService.tick every30s; actual worker queue; no direct tickStep driving|
| Status/asks polling | .9 exact-minute route counts and packet status cadence |status4/min;asks1/min|
| Explicit board_get/open-card probe polling | .9 exact-minute caller roots; evaluator approved |board_get0/min;KanbanStore.read-rooted open-card calls17/min;KanbanTools-rooted open-card calls9/min. Both reader probes call the real store; transport/auth are outside this composition. Tick/dispatch reads are results, never driver inputs.|
| Status ledger size | Packet approx3.5MB /synthetic formatter estimate |21,875 synthetic ledger items; actual response bytes recorded|
| Random sequence | Fixed synthetic seed |20,261,113 plus board rank|

## Ranked board inputs

| Rank | Cards | Open cards | Total discussions | Open discussions | Active cards | Active reviewers | Inactive review landings | Parked |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4290 | 3900 | 3224 | 56 | 19 | 2 | 95 | 98 |
| 2 | 1320 | 1048 | 1247 | 92 | 13 | 0 | 2 | 64 |
| 3 | 114 | 114 | 118 | 3 | 0 | 0 | 0 | 11 |
| 4 | 22 | 22 | 25 | 19 | 2 | 2 | 0 | 5 |
| 5 | 114 | 114 | 118 | 7 | 3 | 0 | 1 | 4 |
| 6 | 22 | 22 | 25 | 11 | 4 | 0 | 0 | 4 |
| 7 | 114 | 114 | 118 | 2 | 0 | 0 | 0 | 3 |
| 8 | 22 | 22 | 25 | 7 | 2 | 0 | 0 | 3 |
| 9 | 114 | 114 | 118 | 1 | 2 | 0 | 0 | 2 |
| 10 | 22 | 22 | 25 | 3 | 1 | 0 | 0 | 2 |
| 11 | 114 | 114 | 118 | 4 | 2 | 0 | 0 | 1 |
| 12 | 22 | 22 | 25 | 1 | 0 | 0 | 0 | 1 |
| 13 | 114 | 114 | 118 | 2 | 1 | 1 | 0 | 1 |
| 14 | 22 | 22 | 25 | 8 | 0 | 0 | 0 | 1 |
| 15 | 114 | 114 | 118 | 2 | 2 | 1 | 0 | 0 |
| 16 | 22 | 22 | 25 | 5 | 0 | 0 | 0 | 0 |
| 17 | 114 | 114 | 118 | 4 | 0 | 0 | 0 | 0 |

Active/discussion trace ranks are sorted by the largest open-card read in complete tickBoard spans. The parked array was independently sorted; assignment to synthetic ranks is an explicit approximation. Backup counts and percentiles predate the live board split and are labelled separately from live overrides.

The first three frozen .9 calibration runs use telemetry schema1 from snapshot4a92a50dd0. Independent audit found GC boundary-delivery and100ms stall-sampling gaps. Their data is retained with those limitations. Schema2 clips GC entries by timestamps, drains pending records, initializes zero counters and treats a probe gap≥1s conservatively; reports additionally reject histogram maxima≥1s. These are measurement corrections, not seed/rate tuning. A new comparison needs all runs on the same corrected instrumentation.

## Separate #1365 latency seed

latency-shape.json adds only aggregate projection-thread counts from the authorized scratch clone:56,543 total;52,918 active;3,621 archived;4 deleted. It uses these counts, the already measured130,622 runs/5,518,254 nodes and per-table JSON byte percentiles. The legacy board-link open count5884 is not the shell archive split. SQL bulk inserts synthetic rows in1024-row quantile buckets after real migrations. Sqlite.layerConfig creates startup indexes on the fresh DB, then ensureShellLookupIndexes runs again after seed. postSeedIndexEnsureMs is an idempotent ensure, not building the index on a populated upgraded DB (#1364 owns the live-size release check). The result records index presence.

Latency transport uses the real control HTTP route, EnvironmentAuth, SessionStore, McpSessionRegistry, MCP middleware/tool transport and ProjectionStore. Unused control services are mocked. The WebSocket adapter is harness-owned; it invokes real loadShellSnapshotParts under a foreground scope, without production WS authentication/RPC decoding. This boundary is in result.json. Reader/writer entry and release use Deferred barriers. After #1365 the archive may queue on the background lane; that behavior is part of the measurement.
