// @effect-diagnostics nodeBuiltinImport:off - a standalone script: argv, files and stdout.
/**
 * Coord import, standalone.
 *
 *   node apps/server/src/ardud/missions/import/run.ts \
 *     --coord-db <coord.db copy> --status-dir <dir> [--crw-db <crw.db copy>] [--crw-config <config.json>] \
 *     [--mission crpko] [--review-pool lease|budget|lease,budget] [--target <sqlite file>] [--apply] [--out <report.txt>]
 *
 * Dry run is the default: it reads the sources, builds the records, diffs them
 * against `--target` (an empty in-memory store when omitted) and prints the
 * report. Nothing is written anywhere except the report file.
 *
 * `--apply` writes core records into `--target`, which must be a scratch copy
 * (never the live Robob database; the running server owns that one). The live
 * import runs inside the server once the router can take rooms and messages.
 *
 * `--review-pool` plans crw's review caps as mission pools (lease: native
 * holds sized by max_reviews_per_tick; budget: crw-config sized by
 * max_reviews_per_day). Without it no pool is planned: the owner picks.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MissionService from "../MissionService.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as PolicyStore from "../policy/PolicyStore.ts";
import {
  PolicySampler,
  PolicySuccession,
  PolicySuggestions,
  PolicyThreads,
} from "../policy/ports.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { applyImport, applyPools, diffImport, diffPools, memoryRouterSink } from "./apply.ts";
import { buildImportPlan, type ReviewPoolKind } from "./mapping.ts";
import { readSources } from "./readers.ts";
import { renderReport } from "./report.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "coord-db": { type: "string" },
    "status-dir": { type: "string" },
    "crw-db": { type: "string" },
    "crw-config": { type: "string" },
    mission: { type: "string", default: "crpko" },
    "review-pool": { type: "string" },
    target: { type: "string" },
    apply: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const coordDb = values["coord-db"];
const statusDir = values["status-dir"];
if (coordDb === undefined || statusDir === undefined) {
  process.stderr.write(
    "usage: run.ts --coord-db PATH --status-dir DIR [--crw-db PATH] [--crw-config PATH] [--mission ID] [--review-pool lease|budget|lease,budget] [--target PATH] [--apply] [--out PATH]\n",
  );
  process.exit(2);
}
if (values.apply && values.target === undefined) {
  process.stderr.write("--apply needs --target (a scratch sqlite copy, never the live database)\n");
  process.exit(2);
}

const reviewPools = (values["review-pool"] ?? "")
  .split(",")
  .map((kind) => kind.trim())
  .filter((kind) => kind.length > 0);
if (reviewPools.some((kind) => kind !== "lease" && kind !== "budget")) {
  process.stderr.write("--review-pool takes lease, budget or lease,budget\n");
  process.exit(2);
}

const paths = {
  coordDb,
  statusDir,
  crwDb: values["crw-db"] ?? null,
  crwConfig: values["crw-config"] ?? null,
};

const plan = buildImportPlan(readSources(paths), {
  missionId: values.mission,
  reviewPools: reviewPools as ReadonlyArray<ReviewPoolKind>,
});
const target = values.target ?? ":memory:";
// The import only creates pools, which touches none of these; they stand in
// for the running server's threads, succession, suggestions and sampler.
const offlinePorts = Layer.mergeAll(
  Layer.succeed(
    PolicyThreads,
    PolicyThreads.of({
      view: (threadId) =>
        Effect.succeed({ threadId, exists: false, idle: false, modelSelection: null }),
      setModel: () => Effect.void,
    }),
  ),
  Layer.succeed(PolicySuccession, PolicySuccession.of({ move: () => Effect.succeed([]) })),
  Layer.succeed(PolicySuggestions, PolicySuggestions.of({ propose: () => Effect.void })),
  Layer.succeed(
    PolicySampler,
    PolicySampler.of({
      sample: () =>
        Effect.succeed({ used: 0, capacity: null, window: null, resetsAt: null, runOutAt: null }),
    }),
  ),
);

// The router has no tables yet; an empty in-memory sink stands in for it.
const router = memoryRouterSink();

const program = Effect.gen(function* () {
  const core = yield* diffImport(plan, router.sink);
  const pools = yield* diffPools(plan);
  const diff = { ...core, kinds: [...core.kinds, pools] };
  // Router parts are only diffed here: with no router tables there is nowhere real to write them.
  const coreApplied = values.apply ? yield* applyImport(plan, null) : undefined;
  const poolsApplied = values.apply ? yield* applyPools(plan) : undefined;
  const applied =
    coreApplied === undefined || poolsApplied === undefined
      ? undefined
      : {
          ...coreApplied,
          commits: coreApplied.commits + poolsApplied.created,
          created: {
            ...coreApplied.created,
            ...(poolsApplied.created > 0 ? { pool: poolsApplied.created } : {}),
          },
        };
  return renderReport({
    plan,
    diff,
    mode: values.apply ? "apply" : "dry-run",
    paths: {
      "coord.db": paths.coordDb,
      status: paths.statusDir,
      "crw.db": paths.crwDb,
      "crw config": paths.crwConfig,
    },
    against:
      target === ":memory:"
        ? "empty store and empty router (in memory)"
        : `store ${target}; router: empty in-memory stand-in (diffed, never written)`,
    ...(applied === undefined ? {} : { applied }),
  });
}).pipe(
  Effect.provide(
    PolicyService.layer.pipe(
      Layer.provideMerge(PolicyStore.layer),
      Layer.provideMerge(MissionService.layer),
      Layer.provideMerge(offlinePorts),
      Layer.provideMerge(MissionStore.layer),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: target })),
    ),
  ),
);

const report = await Effect.runPromise(program);
if (values.out !== undefined) NodeFS.writeFileSync(values.out, report);
process.stdout.write(report);
