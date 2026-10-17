// @effect-diagnostics nodeBuiltinImport:off - a standalone script: argv, files and stdout.
/**
 * Coord import, standalone.
 *
 *   node apps/server/src/ardud/missions/import/run.ts \
 *     --coord-db <coord.db copy> --status-dir <dir> [--crw-db <crw.db copy>] [--crw-config <config.json>] \
 *     [--mission crpko] [--target <sqlite file>] [--apply] [--out <report.txt>]
 *
 * Dry run is the default: it reads the sources, builds the records, diffs them
 * against `--target` (an empty in-memory store when omitted) and prints the
 * report. Nothing is written anywhere except the report file.
 *
 * `--apply` writes core records into `--target`, which must be a scratch copy
 * (never the live Robob database; the running server owns that one). The live
 * import runs inside the server once the router can take rooms and messages.
 */
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as MissionStore from "../store/MissionStore.ts";
import { applyImport, diffImport, memoryRouterSink } from "./apply.ts";
import { buildImportPlan } from "./mapping.ts";
import { readSources } from "./readers.ts";
import { renderReport } from "./report.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "coord-db": { type: "string" },
    "status-dir": { type: "string" },
    "crw-db": { type: "string" },
    "crw-config": { type: "string" },
    mission: { type: "string", default: "crpko" },
    target: { type: "string" },
    apply: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const coordDb = values["coord-db"];
const statusDir = values["status-dir"];
if (coordDb === undefined || statusDir === undefined) {
  process.stderr.write(
    "usage: run.ts --coord-db PATH --status-dir DIR [--crw-db PATH] [--crw-config PATH] [--mission ID] [--target PATH] [--apply] [--out PATH]\n",
  );
  process.exit(2);
}
if (values.apply && values.target === undefined) {
  process.stderr.write("--apply needs --target (a scratch sqlite copy, never the live database)\n");
  process.exit(2);
}

const paths = {
  coordDb,
  statusDir,
  crwDb: values["crw-db"] ?? null,
  crwConfig: values["crw-config"] ?? null,
};

const plan = buildImportPlan(readSources(paths), { missionId: values.mission });
const target = values.target ?? ":memory:";
// The router has no tables yet; an empty in-memory sink stands in for it.
const router = memoryRouterSink();

const program = Effect.gen(function* () {
  const diff = yield* diffImport(plan, router.sink);
  // Router parts are only diffed here: with no router tables there is nowhere real to write them.
  const applied = values.apply ? yield* applyImport(plan, null) : undefined;
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
    MissionStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: target }))),
  ),
);

const report = await Effect.runPromise(program);
if (values.out !== undefined) NodeFS.writeFileSync(values.out, report);
process.stdout.write(report);
