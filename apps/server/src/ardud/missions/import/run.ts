// @effect-diagnostics nodeBuiltinImport:off - a standalone script: argv, files and stdout.
/**
 * Coord import, standalone.
 *
 *   node apps/server/src/ardud/missions/import/run.ts \
 *     --coord-db <coord.db copy> --status-dir <dir> [--crw-db <crw.db copy>] [--crw-config <config.json>] \
 *     [--mission crpko] [--review-pool lease|budget|lease,budget] [--plan <plan.json>] \
 *     [--target <sqlite file>] [--apply] [--out <report.txt>]
 *
 * Dry run is the default: it reads the sources, builds the records, diffs them
 * against `--target` (an empty in-memory store when omitted) and prints the
 * report. Nothing is written anywhere except the report file.
 *
 * `--apply` writes core records, review pools, the router's rooms, messages,
 * subscriptions and read positions, and the coord enrolment of every coord.db
 * actor (crw included) into `--target`, which must be a scratch copy
 * (never the live Robob database; the running server owns that one).
 *
 * `--review-pool` plans crw's review caps as mission pools (lease: native
 * holds sized by max_reviews_per_tick; budget: crw-config sized by
 * max_reviews_per_day). Without it no pool is planned: the owner picks.
 *
 * `--plan` adds sub-missions, milestones and lane placement (see `plan.ts`).
 * The file is checked first; any problem is printed with its line and the run
 * stops with exit code 1 before the target is opened.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { MissionError } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MissionService from "../MissionService.ts";
// ardud missions: router (router tables back the import's router side)
import { routerImportSink } from "../router/adapters.ts";
import * as MissionRouter from "../router/MissionRouter.ts";
import { RouterThreads } from "../router/ports.ts";
import * as RouterStore from "../router/RouterStore.ts";
import * as PolicyService from "../policy/PolicyService.ts";
import * as PolicyStore from "../policy/PolicyStore.ts";
import {
  PolicySampler,
  PolicySuccession,
  PolicySuggestions,
  PolicyThreads,
} from "../policy/ports.ts";
import * as MissionStore from "../store/MissionStore.ts";
import { applyImport, applyPools, diffImport, diffPools } from "./apply.ts";
import { applyEnrolments, diffEnrolments, ENROLMENT_KIND } from "./enrol.ts";
import { buildImportPlan, type ReviewPoolKind } from "./mapping.ts";
import { applyPlan, diffPlan, readPlanFile } from "./plan.ts";
import { readSources } from "./readers.ts";
import { renderReport } from "./report.ts";
// ardud missions: guard (legacy schedules and watches become the master's)
import { adoptLegacyAuthority, renderAdoption } from "../guard/adopt.ts";

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
    plan: { type: "string" },
  },
});

const coordDb = values["coord-db"];
const statusDir = values["status-dir"];
if (coordDb === undefined || statusDir === undefined) {
  process.stderr.write(
    "usage: run.ts --coord-db PATH --status-dir DIR [--crw-db PATH] [--crw-config PATH] [--mission ID] [--review-pool lease|budget|lease,budget] [--plan PATH] [--target PATH] [--apply] [--out PATH]\n",
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
const planFile = values.plan;
const missionPlan = (() => {
  if (planFile === undefined) return null;
  const parsed = readPlanFile(planFile, plan);
  if (parsed._tag === "ok") return parsed.plan;
  // Nothing is read from or written to the target before the plan checks out.
  process.stderr.write(`${parsed.errors.join("\n")}\n`);
  process.exit(1);
})();
const target = values.target ?? ":memory:";
// Creating pools and enrolling coord actors touch none of these; they stand in
// for the running server's threads, succession, suggestions, sampler and sends.
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
  // Enrolling a coord actor reads and messages no thread.
  Layer.succeed(
    RouterThreads,
    RouterThreads.of({
      facts: () => Effect.succeed(null),
      creator: () => Effect.succeed(null),
      send: () =>
        Effect.fail(
          new MissionError({ code: "invalid", detail: "The offline import sends no messages." }),
        ),
      question: () => Effect.succeed(null),
      approval: () => Effect.succeed(null),
      respondApproval: () =>
        Effect.fail(
          new MissionError({ code: "invalid", detail: "The offline import answers no requests." }),
        ),
    }),
  ),
);

const program = Effect.gen(function* () {
  const router = yield* routerImportSink;
  const core = yield* diffImport(plan, router);
  const pools = yield* diffPools(plan);
  const enrolments = yield* diffEnrolments(plan);
  const planState = missionPlan === null ? undefined : yield* diffPlan(missionPlan, plan.missionId);
  const diff = {
    ...core,
    kinds: [...core.kinds, pools, enrolments, ...(planState?.kinds ?? [])],
  };
  const coreApplied = values.apply ? yield* applyImport(plan, router) : undefined;
  const poolsApplied = values.apply ? yield* applyPools(plan) : undefined;
  const enrolApplied = values.apply ? yield* applyEnrolments(plan) : undefined;
  const planApplied =
    values.apply && missionPlan !== null
      ? yield* applyPlan(missionPlan, plan.missionId)
      : undefined;
  const planCreated = Object.entries(planApplied?.created ?? {}).filter(([, n]) => n > 0);
  const applied =
    coreApplied === undefined || poolsApplied === undefined || enrolApplied === undefined
      ? undefined
      : {
          ...coreApplied,
          commits:
            coreApplied.commits +
            poolsApplied.created +
            enrolApplied.enrolled.length +
            (planApplied?.commits ?? 0),
          created: {
            ...coreApplied.created,
            ...(poolsApplied.created > 0 ? { pool: poolsApplied.created } : {}),
            ...(enrolApplied.enrolled.length > 0
              ? { [ENROLMENT_KIND]: enrolApplied.enrolled.length }
              : {}),
            ...Object.fromEntries(planCreated),
          },
        };
  // ardud missions: guard
  const adoption = yield* adoptLegacyAuthority(plan.core, { apply: values.apply });
  const report = renderReport({
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
        : `store and router tables in ${target}`,
    ...(applied === undefined ? {} : { applied }),
    ...(missionPlan === null ? {} : { missionPlan, planState }),
  });
  return report + renderAdoption(adoption);
}).pipe(
  Effect.provide(
    PolicyService.layer.pipe(
      Layer.provideMerge(MissionRouter.layer),
      Layer.provideMerge(PolicyStore.layer),
      Layer.provideMerge(MissionService.layer),
      Layer.provideMerge(offlinePorts),
      Layer.provideMerge(Layer.mergeAll(MissionStore.layer, RouterStore.layer)),
      Layer.provideMerge(NodeSqliteClient.layer({ filename: target })),
    ),
  ),
);

const report = await Effect.runPromise(program);
if (values.out !== undefined) NodeFS.writeFileSync(values.out, report);
process.stdout.write(report);
