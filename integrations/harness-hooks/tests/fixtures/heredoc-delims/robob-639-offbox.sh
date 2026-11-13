offbox run --bg --git --pull tmp/sync639-final-r10 -- 'set -euo pipefail
mkdir -p tmp/sync639-final-r10
if [[ ! -x node_modules/.bin/vp ]]; then pnpm install --frozen-lockfile --ignore-scripts > tmp/sync639-final-r10/install.log 2>&1; fi
node node_modules/vite-plus/bin/vp lint apps/server/scripts/ardud/sync-bench apps/server/scripts/migrate-dev-db.ts apps/server/scripts/migrate-dev-db.test.ts apps/server/src/server.ts apps/server/src/ardud/perf/syncBenchAutomation.ts apps/server/src/ardud/perf/syncBenchAutomation.test.ts apps/web/src/ardud/syncBench.ts apps/web/src/main.tsx > tmp/sync639-final-r10/lint.log 2>&1
SYNC_CHECK_DIR=$(mktemp -d "$PWD/tmp/sync639-check.XXXXXXXX")
export SYNC_CHECK_DIR
node --input-type=module <<'\''NODE'\''
import fs from "node:fs";
import path from "node:path";
fs.writeFileSync(path.join(process.env.SYNC_CHECK_DIR,"types.json"), JSON.stringify({
extends:path.resolve("apps/server/tsconfig.json"),
include:[path.resolve("apps/server/src/server.ts"),path.resolve("apps/server/src/ardud/perf/syncBenchAutomation.test.ts"),path.resolve("apps/server/scripts/ardud/sync-bench/*.ts"),path.resolve("apps/server/scripts/migrate-dev-db.ts")]
}));
NODE
node node_modules/typescript/bin/tsc --noEmit -p "$SYNC_CHECK_DIR/types.json" > tmp/sync639-final-r10/types.log 2>&1
(cd apps/server && node ../../node_modules/vite-plus/bin/vp test run scripts/ardud/sync-bench/frames.test.ts scripts/ardud/sync-bench/metrics.test.ts scripts/ardud/sync-bench/ownedChild.test.ts scripts/ardud/sync-bench/preflight.test.ts scripts/ardud/sync-bench/seed.test.ts scripts/ardud/sync-bench/seed.integration.test.ts scripts/ardud/sync-bench/setup.test.ts scripts/ardud/sync-bench/shutdown.test.ts src/ardud/perf/syncBenchAutomation.test.ts > ../../tmp/sync639-final-r10/tests.log 2>&1)
node --input-type=module > tmp/sync639-final-r10/fixture.log 2>&1 <<'\''NODE'\''
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {createFixture} from "./apps/server/scripts/ardud/sync-bench/fixture.ts";
import {seedFixture} from "./apps/server/scripts/ardud/sync-bench/seed.ts";
const source = path.resolve("tmp/sync639-r10-fixture-source");
await createFixture({dir:source,scale:1,threads:3,items:2});
const db = new DatabaseSync(path.join(source,"db/statev2.sqlite"));
const at = "2026-11-09T00:00:00.000Z";
const links = [{host:"github.com",repository:"benchmark/fixture",number:1,url:"https://github.com/benchmark/fixture/pull/1",source:"agent",linkedAt:at,snapshot:null,stack:null,watch:{startedAt:at,headSha:null,failedChecks:[],passed:false,passedChecks:[],passedPending:[],remarksThrough:at,remarkIds:[],conflicting:false,conflictHead:null,conflictWokeFor:null,wakes:0}}];
db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'\''$.pullRequests'\'',json(?)) WHERE thread_id='\''sync-thread-0'\''").run(JSON.stringify(links));
db.close();
await seedFixture({seed:source,dir:path.resolve("tmp/sync639-r10-fixture"),scale:1});
fs.writeFileSync("tmp/sync639-final-r10/expected-pr.json",JSON.stringify(links));
NODE
node scripts/perf/sync-bench.ts run --fixture tmp/sync639-r10-fixture --output tmp/sync639-r10-node --repeats 1 --background-ms 0 > tmp/sync639-final-r10/node.log 2>&1
cp tmp/sync639-r10-node/result.json tmp/sync639-final-r10/node-result.json
cp tmp/sync639-r10-node/server.trace.ndjson tmp/sync639-final-r10/node-trace.ndjson
node --input-type=module <<'\''NODE'\''
import fs from "node:fs";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
const report="tmp/sync639-final-r10";
const trace=fs.readFileSync(report+"/node-trace.ndjson","utf8").trim().split("\n").map(JSON.parse);
const guards=trace.filter(x=>x.name==="SyncBenchmark.startPullRequestAutomation");
assert.equal(guards.length,3);
assert(guards.every(x=>x.attributes["sync_benchmark.pr_automation_paused"]===true));
assert.equal(trace.filter(x=>/^(PullRequestSyncReactor\.|PullRequestWatchReactor\.|ThreadPullRequestServiceV2\.(start|synchronize))/.test(x.name)).length,0);
const result=JSON.parse(fs.readFileSync(report+"/node-result.json","utf8"));
assert.equal(result.samples.length,3);
assert(result.samples.every(x=>x.syncMs>0));
fs.writeFileSync(report+"/startup-proof.json",JSON.stringify({guards,blockedWorkerSpans:0,samples:result.samples.length},null,2));
NODE
'
