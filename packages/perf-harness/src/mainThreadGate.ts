// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Main-thread gate: how long the background sweeps and the turn-start run-control checks
 * keep the server's event loop from running anything else.
 *
 * The writer connection is synchronous on the main thread, so a statement there freezes
 * every request for as long as it runs. This runs the real ProjectionStore reads in one
 * process on a fresh clone of a synthetic fixture (thread payloads padded to a realistic
 * size) and records, per read, its duration and the longest gap between 1 ms timer ticks
 * while it ran: the time nothing else could run.
 *
 * usage: node packages/perf-harness/src/mainThreadGate.ts FIXTURE LABEL OUT.json
 * The same file runs unchanged in the base tree (copy it there). It reads the tree's own
 * switches from the environment (ROBOB_SWEEP_READS_ON_WRITER=1,
 * ROBOB_RUN_CONTROL_FULL_READS=1) and feature-detects `getRunControlState`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const [fixtureDir, label, out] = process.argv.slice(2);
if (!fixtureDir || !label || !out) {
  console.error("usage: mainThreadGate.ts FIXTURE LABEL OUT.json");
  process.exit(2);
}

export const mainThreadWorkload = {
  version: 1,
  // Live thread payloads carry settings, lineage and pull request links; the live
  // pull-request scan took 0.5-6 s over them. Pad the synthetic rows to this size.
  threadPayloadBytes: 16_384,
  sweepRepeats: 15,
  runControlRepeats: 300,
} as const;

const Effect = await import("effect/Effect");
const Layer = await import("effect/Layer");
const DateTime = await import("effect/DateTime");
const NodeServices = await import("@effect/platform-node/NodeServices");
const Sqlite = await import("../../../apps/server/src/persistence/Sqlite.ts");
const Projection = await import("../../../apps/server/src/orchestration-v2/ProjectionStore.ts");
const { ThreadId, RunId } = await import("@t3tools/contracts");

const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(fixtureDir, "fixture.json"), "utf8"),
);
if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
const home = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "robob-main-thread-gate-"));
NodeFS.cpSync(NodePath.resolve(fixtureDir, "userdata"), NodePath.resolve(home, "userdata"), {
  recursive: true,
  mode: NodeFS.constants.COPYFILE_FICLONE,
});
const mainPath = NodePath.resolve(home, "userdata/statev2.sqlite");

// Only this throwaway clone is edited: pad payloads. No thread has pull requests, so the
// scan visits every row and decodes none, as most of the live scan does.
{
  const db = new NodeSqlite.DatabaseSync(mainPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF");
  db.prepare(
    `UPDATE orchestration_v2_projection_threads
     SET payload_json = json_set(payload_json, '$.perfPadding', hex(randomblob(?)))`,
  ).run(Math.floor(mainThreadWorkload.threadPayloadBytes / 2));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

const pct = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

type Sample = { ms: number; frozenMs: number; rows?: number; failure?: string };

/** Longest gap between 1 ms ticks while `effect` is in flight: time the loop was frozen. */
const frozen = <A>(effect: import("effect/Effect").Effect<A, unknown, never>) =>
  Effect.gen(function* () {
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    // Let the ticker settle before the measured call.
    yield* Effect.sleep("20 millis");
    worst = 0;
    last = performance.now();
    const started = performance.now();
    const exit = yield* Effect.exit(effect);
    const ms = performance.now() - started;
    worst = Math.max(worst, performance.now() - last);
    clearInterval(timer);
    const sample: Sample = { ms, frozenMs: worst };
    if (exit._tag === "Success") {
      if (Array.isArray(exit.value)) sample.rows = exit.value.length;
    } else sample.failure = String(exit.cause).slice(0, 300);
    return sample;
  });

const layer = Projection.layer.pipe(
  Layer.provideMerge(Sqlite.layerFromPath(mainPath)),
  Layer.provideMerge(NodeServices.layer),
);

const result: Record<string, unknown> = {
  label,
  workload: mainThreadWorkload,
  fixture: { scale: fixture.scale, threads: fixture.threads, hash: fixture.fixtureHash },
  host: { cpus: NodeOS.cpus().length, node: process.version },
  switches: Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.startsWith("ROBOB_") && !name.startsWith("ROBOB_PERF_"),
    ),
  ),
};

const summarize = (samples: ReadonlyArray<Sample>) => ({
  n: samples.length,
  rows: samples[0]?.rows,
  failures: samples.filter((sample) => sample.failure !== undefined).length,
  firstFailure: samples.find((sample) => sample.failure !== undefined)?.failure,
  msP50: pct(
    samples.map((sample) => sample.ms),
    0.5,
  ),
  msMax: Math.max(...samples.map((sample) => sample.ms)),
  frozenMsP50: pct(
    samples.map((sample) => sample.frozenMs),
    0.5,
  ),
  frozenMsMax: Math.max(...samples.map((sample) => sample.frozenMs)),
});

try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Projection.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-11-10T12:00:00.000Z");
      // Warm both connections' page caches, as a running server is warm.
      yield* store.getThreadsWithPullRequests();
      yield* store.getThreadsWithPullRequests();

      const sweeps = {
        threadsWithPullRequests: [] as Array<Sample>,
        limitRecoveryCandidates: [] as Array<Sample>,
      };
      for (let i = 0; i < mainThreadWorkload.sweepRepeats; i++) {
        sweeps.threadsWithPullRequests.push(yield* frozen(store.getThreadsWithPullRequests()));
        sweeps.limitRecoveryCandidates.push(
          yield* frozen(store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })),
        );
      }
      result.sweeps = {
        threadsWithPullRequests: summarize(sweeps.threadsWithPullRequests),
        limitRecoveryCandidates: summarize(sweeps.limitRecoveryCandidates),
      };
      // A failed read is not a timing of the read.
      for (const [name, samples] of Object.entries(sweeps)) {
        const failed = samples.find((sample) => sample.failure !== undefined);
        if (failed !== undefined) throw new Error(`${name} failed: ${failed.failure}`);
      }

      // The check turn start and run finalize make: is this run still current/active?
      const threadId = ThreadId.make("synthetic-thread-20");
      const runId = RunId.make("synthetic-run-absent");
      const narrow = (
        store as unknown as {
          getRunControlState?: (
            threadId: typeof threadId,
            runId: typeof runId,
          ) => import("effect/Effect").Effect<unknown, unknown, never>;
        }
      ).getRunControlState;
      const check =
        typeof narrow === "function"
          ? narrow(threadId, runId)
          : store.getRuntimeRecoveryProjection(threadId);
      const started = performance.now();
      let worst = 0;
      let failures = 0;
      let firstFailure: string | undefined;
      for (let i = 0; i < mainThreadWorkload.runControlRepeats; i++) {
        const callStarted = performance.now();
        const exit = yield* Effect.exit(check);
        worst = Math.max(worst, performance.now() - callStarted);
        if (exit._tag === "Failure") {
          failures++;
          firstFailure ??= String(exit.cause).slice(0, 300);
        }
      }
      // A failed read is not a timing of the read: the run fails below.
      if (failures > 0) throw new Error(`run-control read failed ${failures}x: ${firstFailure}`);
      result.runControl = {
        read: typeof narrow === "function" ? "getRunControlState" : "getRuntimeRecoveryProjection",
        n: mainThreadWorkload.runControlRepeats,
        msPerCall: (performance.now() - started) / mainThreadWorkload.runControlRepeats,
        msMax: worst,
      };
    }).pipe(Effect.provide(layer)),
  );
  result.status = "ok";
} catch (error) {
  result.status = "failed";
  result.error = String(error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  NodeFS.writeFileSync(NodePath.resolve(out), JSON.stringify(result, null, 2));
  NodeFS.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "ok" ? 0 : 1);
