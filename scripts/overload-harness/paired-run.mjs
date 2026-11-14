import * as NodeModule from "node:module";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { instrumentHarness, instrumentSqlite, makeMeasurement } from "./paired-measurement.mjs";

globalThis.__overloadMeasurement = makeMeasurement({
  now: () => NodePerfHooks.performance.now(),
  wallNow: () => Date.now(),
  elu: () => NodePerfHooks.performance.eventLoopUtilization(),
});
NodeModule.registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const instrument = url.endsWith("/apps/server/scripts/overload-harness.ts")
      ? instrumentHarness
      : url.endsWith("/packages/shared/src/nodeSqliteClient.ts")
        ? instrumentSqlite
        : undefined;
    if (!instrument) return loaded;
    const source =
      typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    const instrumented = instrument(source);
    globalThis.__overloadMeasurement.hook(
      url.endsWith("overload-harness.ts") ? "harness" : "sqlite",
      source,
      instrumented,
    );
    return { ...loaded, source: instrumented };
  },
});
const releaseFile = process.argv.find((arg) => arg.startsWith("--release="))?.slice(10);
const readyFile = process.argv.find((arg) => arg.startsWith("--ready="))?.slice(8);
if (releaseFile) {
  if (!readyFile) throw new Error("A paired release needs a ready path");
  await NodeFSP.mkdir(NodePath.dirname(readyFile), { recursive: true });
  await NodeFSP.writeFile(
    readyFile,
    JSON.stringify({ readyAt: new Date().toISOString(), pid: process.pid, node: process.version }) +
      "\n",
  );
  const deadline = Date.now() + 60 * 60 * 1000;
  let release;
  while (release === undefined) {
    try {
      release = JSON.parse(await NodeFSP.readFile(releaseFile, "utf8"));
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    if (Date.now() > deadline) throw new Error("Paired release did not arrive within one hour");
    if (release === undefined) await NodeTimersPromises.setTimeout(250);
  }
  if (!Number.isFinite(release.epochMs) || release.epochMs < Date.now() - 1000)
    throw new Error("Paired release must name a future epoch");
  await NodeTimersPromises.setTimeout(Math.max(0, release.epochMs - Date.now()));
}
await import("./run.mjs");
