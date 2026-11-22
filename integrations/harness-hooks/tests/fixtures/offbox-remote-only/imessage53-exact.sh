cat > /Users/ardud/.robob/board-artifacts/imessage-probe-53-implementation.rei35d/REVIEW-R1.md <<'REPORT'
# #53 review round 1 — failure-owner causeKinds

Finding: an alreadyLogged router.catch1 carries the probe's causeKind, but both readers returned before using it. The owning control.request_failed row counted the failure correctly but lost its HTTP/transport breakdown.

Fix: retain validated probe cause kind by requestId before skipping the catch. Both readers defer request detail observation until after all catches, so the owning topErrorTags entry receives the kind once, independently of file order or batch summaries. No failure/error-rate/total increments are added. Missing owners do not create error entries. No live logging or router behavior changes.

## Input-class matrix

| Shape | Owner | Probe cause | Coverage |
| --- | --- | --- | --- |
| HTTP 503 | ControlError / control.request_failed | http | Real ControlClient TS mock; Python replay |
| ECONNREFUSED | TypeError / control.request_failed | transport | Real ControlClient TS mock; Python replay |
| Invalid JSON after HTTP 200 | SyntaxError / control.invalid_json | http | Real ControlClient TS mock; Python replay; proves classification follows catch |
| Body read timeout after HTTP 200 | TimeoutError / control.request_failed | http | Real ControlClient TS mock; Python replay; distinct from router's bounded timeout |
| Repeated catches for one request | One counted owner | Once | Each shape with duplicate catches, both file orders, with/without call summary |
| Matching requestId, boolean alreadyLogged true | One counted owner | Attached | TS and Python correlation guards |
| Missing owner or catch requestId | Existing owner count | No inferred association | TS and Python correlation guards |
| Different requestId | Existing owner count | No inferred association | TS and Python correlation guards |
| Other catch tag | Existing owner count | No probe association | TS and Python correlation guards |
| Invalid cause kind | Existing owner count | Rejected | TS and Python correlation guards |
| Unmarked catch | Owner plus independent catch | No transfer | TS and Python correlation guards |
| Malformed owner requestId | Existing owner count | Rejected | Python defensive-reader regression |
| Independent BoundedTimeout | Own router.catch1 owner | timeout | Existing TS/Python five-outcome and dedup regressions retained |

Four touched files: spectrum-bridge/src/log-rollup.ts, test/failure-dedup.test.ts, local-helpers/libexec/toollog/toollog.py, tests/test_toollog.py. No external configuration or deployment changes needed for this revision; eventual evaluator release still installs BOTH integration packages.

Validation/review/head will be recorded after completion.
REPORT
offbox run --bg --step 'bun install --frozen-lockfile && bun run check' --step 'bun test test/prompt-probe.test.ts test/toollog.test.ts test/inbound-latency.test.ts test/router-sendblue.test.ts test/failure-dedup.test.ts test/log-causes.test.ts test/rollup-causes.test.ts test/probe-policy.test.ts' --step 'bun test' --step 'python3 -I ../local-helpers/tests/test_toollog.py'
