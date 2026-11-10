// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Reads gate, tier B: the statev2 reader mechanism in isolation.
 *
 * Runs in one process with the tree's own production statev2 client
 * (`Sqlite.layerFromPath`: archive attachments, snapshot gate, reader lanes
 * where the tree has them) and real ProjectionStore reads on a fresh clone of
 * a synthetic fixture. Two holders run back-to-back read transactions that
 * scan every turn item in the reader worker (seconds of SQLite time, one row
 * back), which is how a background read holds the reader without holding the
 * main thread. Meanwhile the probes run sequentially, so each measures its
 * own queue wait and nothing else:
 *
 * - foreground: shell page (500 rows), thread snapshot window, full thread snapshot
 *   (wrapped in `foregroundReads` when the tree has it; base has no lanes);
 * - reserved: auth and identity lane round trips;
 * - background: a small untagged read (it should wait; that is the design).
 *
 * Also: a writer committing every 50 ms during the load (writes must not wait
 * for readers), interrupted foreground reads (client disconnects) followed by
 * fresh probes, and the process's RSS / disk I/O per phase.
 *
 * usage: node packages/perf-harness/src/readsLaneGate.ts FIXTURE LABEL OUT.json [default|off]
 * The same file runs unchanged in the base tree (copy it there); it only uses
 * APIs both trees have and feature-detects `foregroundReads`.
 */
import { constants, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { resolve } from "node:path";

const [fixtureDir, label, out, lanesArg] = process.argv.slice(2);
if (!fixtureDir || !label || !out) {
  console.error("usage: readsLaneGate.ts FIXTURE LABEL OUT.json [default|off]");
  process.exit(2);
}
const lanes = lanesArg === "off" ? "off" : "default";
if (lanes === "off") {
  process.env.ROBOB_STATEV2_FOREGROUND_READERS = "0";
  process.env.ROBOB_BOARDS_FOREGROUND_READERS = "0";
}

export const readsLaneWorkload = {
  version: 2,
  idleCycles: 30,
  holders: 2,
  holderWarmupMs: 1000,
  loadedMs: 30_000,
  writerEveryMs: 50,
  abortBurst: 20,
  abortAfterMs: 5,
  afterAbortCycles: 10,
} as const;

const Effect = await import("effect/Effect");
const Fiber = await import("effect/Fiber");
const Layer = await import("effect/Layer");
const SqlClient = await import("effect/sql/SqlClient");
const NodeServices = await import("@effect/platform-node/NodeServices");
const NodeSqliteClient = (await import("@t3tools/shared/nodeSqliteClient")) as Record<string, unknown> &
  typeof import("@t3tools/shared/nodeSqliteClient");
const Sqlite = await import("../../../apps/server/src/persistence/Sqlite.ts");
const Projection = await import("../../../apps/server/src/orchestration-v2/ProjectionStore.ts");
const { ThreadId } = await import("@t3tools/contracts");
const { percentiles } = await import("./metrics.ts");

type Eff<A> = import("effect/Effect").Effect<A, unknown, unknown>;
const foreground: <A>(effect: Eff<A>) => Eff<A> =
  typeof NodeSqliteClient.foregroundReads === "function"
    ? (NodeSqliteClient.foregroundReads as <A>(effect: Eff<A>) => Eff<A>)
    : (effect) => effect;
const hasLanes = typeof NodeSqliteClient.foregroundReads === "function";

const fixture = JSON.parse(readFileSync(resolve(fixtureDir, "fixture.json"), "utf8"));
if (fixture.synthetic !== true) throw new Error("Synthetic fixture marker required");
const home = mkdtempSync(resolve(tmpdir(), "robob-reads-lane-gate-"));
cpSync(resolve(fixtureDir, "userdata"), resolve(home, "userdata"), {
  recursive: true,
  mode: constants.COPYFILE_FICLONE,
});

const readIo = () => {
  try {
    const io = readFileSync("/proc/self/io", "utf8");
    return {
      readBytes: Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1] ?? 0),
      writeBytes: Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1] ?? 0),
    };
  } catch {
    return { readBytes: 0, writeBytes: 0 };
  }
};
const threads = () => {
  try {
    return Number(readFileSync("/proc/self/status", "utf8").match(/^Threads:\s+(\d+)/m)?.[1] ?? 0);
  } catch {
    return 0;
  }
};
const resources: Array<Record<string, number | string>> = [];
const sample = (at: string) => {
  console.error(`[${label}] phase ${at} t=${Math.round(performance.now())}ms`);
  resources.push({ at, rssBytes: process.memoryUsage().rss, threads: threads(), ...readIo() });
};

const probes: Record<string, Record<string, Array<number>>> = {};
const failures: Record<string, Array<string>> = {};
const record = (phase: string, probe: string, ms: number) => ((probes[phase] ??= {})[probe] ??= []).push(ms);
const holders = { loadedMs: [] as Array<number>, failures: 0 };
const writer = { commitMs: [] as Array<number>, failures: 0 };
const aborted = { issued: 0, completedBeforeAbort: 0 };

const layer = Projection.layer.pipe(
  Layer.provideMerge(Sqlite.layerFromPath(resolve(home, "userdata/statev2.sqlite"))),
  Layer.provideMerge(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Projection.ProjectionStoreV2;
  const thread = ThreadId.make("synthetic-thread-20");
  const time = <A>(effect: Eff<A>) =>
    Effect.suspend(() => {
      const start = performance.now();
      return Effect.map(effect, () => performance.now() - start);
    });
  // Same routing as production: Orchestrator wraps these ProjectionStore reads in
  // `readOnly` (Orchestrator.ts getShellSnapshot / getThreadSnapshotWindow /
  // getThreadSnapshot / getThreadShell); WS RPCs and environment HTTP add
  // `foregroundReads` on the candidate.
  const ro = NodeSqliteClient.readOnly as <A>(effect: Eff<A>) => Eff<A>;
  const run: Record<string, () => Eff<unknown>> = {
    shellPage: () => foreground(ro(store.getShellSnapshot({ location: "active", limit: 501 }))),
    threadWindow: () => foreground(ro(store.getThreadSnapshotWindow(thread, { rowLimit: 200 }))),
    threadSnapshot: () => foreground(ro(store.getThreadSnapshot(thread))),
    auth: () => NodeSqliteClient.authReadOnly(sql`SELECT count(*) AS n FROM sqlite_schema`),
    identity: () => NodeSqliteClient.identityReadOnly(sql`SELECT count(*) AS n FROM sqlite_schema`),
    backgroundSmall: () => ro(store.getThreadShell(thread)),
  };
  const cycle = (phase: string) =>
    Effect.forEach(
      Object.keys(run),
      (probe) =>
        time(run[probe]!()).pipe(
          Effect.tap((ms) => Effect.sync(() => record(phase, probe, ms))),
          Effect.catchCause((cause) => Effect.sync(() => (failures[probe] ??= []).push(String(cause).slice(0, 300)))),
        ),
      { discard: true },
    );
  // Warm every lane and slot (prepared statements, page cache).
  for (let i = 0; i < 3; i++) yield* Effect.all(Object.values(run).map((f) => f()), { concurrency: "unbounded" });
  yield* Effect.sync(() => console.error(`[${label}] warmed t=${Math.round(performance.now())}ms`));
  yield* sql`CREATE TABLE IF NOT EXISTS gate_scratch (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`;
  const holderTransaction = sql
    .withTransaction(
      Effect.andThen(
        sql`SELECT count(*) AS n, sum(length(payload_json)) AS bytes FROM orchestration_v2_projection_turn_items`,
        sql`SELECT count(*) AS n FROM orchestration_v2_projection_threads`,
      ),
    )
    .pipe(NodeSqliteClient.readOnly);
  const holderIdleMs = yield* time(holderTransaction);
  yield* Effect.sync(() => console.error(`[${label}] holder alone ${Math.round(holderIdleMs)}ms`));
  sample("idle-start");
  for (let i = 0; i < readsLaneWorkload.idleCycles; i++) yield* cycle("idle");
  sample("idle-end");
  let stop = false;
  const holderLoops = yield* Effect.forEach(Array.from({ length: readsLaneWorkload.holders }), () =>
    Effect.forkChild(
      Effect.gen(function* () {
        while (!stop) {
          const exit = yield* Effect.exit(time(holderTransaction));
          if (exit._tag === "Success") holders.loadedMs.push(exit.value);
          else holders.failures++;
        }
      }),
    ),
  );
  const writerLoop = yield* Effect.forkChild(
    Effect.gen(function* () {
      let id = 0;
      while (!stop) {
        const exit = yield* Effect.exit(time(sql`INSERT INTO gate_scratch (body) VALUES (${`w${id++}`})`));
        if (exit._tag === "Success") writer.commitMs.push(exit.value);
        else writer.failures++;
        yield* Effect.sleep(readsLaneWorkload.writerEveryMs);
      }
    }),
  );
  yield* Effect.sleep(readsLaneWorkload.holderWarmupMs);
  const until = performance.now() + readsLaneWorkload.loadedMs;
  while (performance.now() < until) yield* cycle("loaded");
  sample("loaded-end");
  // Client disconnects: foreground reads interrupted while queued or running.
  yield* Effect.forEach(
    Array.from({ length: readsLaneWorkload.abortBurst }),
    () =>
      Effect.suspend(() => {
        aborted.issued++;
        return run.shellPage!().pipe(
          Effect.timeoutOption(readsLaneWorkload.abortAfterMs),
          Effect.tap((result) => Effect.sync(() => (result._tag === "Some" ? aborted.completedBeforeAbort++ : undefined))),
          Effect.ignore,
        );
      }),
    { concurrency: "unbounded", discard: true },
  );
  for (let i = 0; i < readsLaneWorkload.afterAbortCycles; i++) yield* cycle("afterAbort");
  stop = true;
  yield* Effect.forEach(holderLoops, Fiber.join, { discard: true });
  yield* Fiber.join(writerLoop);
  const checkpoint = yield* sql<{ busy: number; log: number; checkpointed: number }>`PRAGMA wal_checkpoint(PASSIVE)`;
  sample("end");
  return { holderIdleMs, checkpoint: checkpoint[0] ?? null };
});

const started = new Date().toISOString();
// Reader workers and their ports are unref'd (the server's listener keeps it alive);
// a bare script must hold the event loop open while a worker statement runs.
const keepAlive = setInterval(() => undefined, 1000);
let result: { holderIdleMs: number; checkpoint: unknown };
try {
  result = (await Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(layer)) as import("effect/Effect").Effect<
      { holderIdleMs: number; checkpoint: unknown },
      unknown,
      never
    >,
  )) as { holderIdleMs: number; checkpoint: unknown };
} finally {
  clearInterval(keepAlive);
  rmSync(home, { recursive: true, force: true });
}
const dist = (values: ReadonlyArray<number>) => {
  const d = percentiles(values);
  return { n: values.length, p50: d?.p50 ?? 0, p95: d?.p95 ?? 0, p99: d?.p99 ?? 0, max: d?.max ?? 0 };
};
const summary: Record<string, Record<string, ReturnType<typeof dist>>> = {};
for (const [phase, byProbe] of Object.entries(probes))
  for (const [probe, values] of Object.entries(byProbe)) (summary[phase] ??= {})[probe] = dist(values);
summary.load = { holder: dist(holders.loadedMs), writerCommit: dist(writer.commitMs) };
const report = {
  tier: "B",
  label,
  lanes,
  hasLanes,
  workload: readsLaneWorkload,
  fixtureHash: String(fixture.fixtureHash ?? ""),
  startedAt: started,
  host: { cpus: cpus().length, memBytes: totalmem(), node: process.version },
  holderIdleMs: result.holderIdleMs,
  checkpoint: result.checkpoint,
  probes,
  failures,
  holders,
  writer,
  aborted,
  resources,
  summary,
};
writeFileSync(out, JSON.stringify(report));
const line = (phase: string) =>
  Object.entries(summary[phase] ?? {})
    .map(([probe, s]) => `${probe} ${Math.round(s.p50)}/${Math.round(s.p95)}`)
    .join(" | ");
console.log(`[${label}] holderIdle=${Math.round(result.holderIdleMs)}ms`);
console.log(`[${label}] idle: ${line("idle")}`);
console.log(`[${label}] loaded: ${line("loaded")}`);
console.log(`[${label}] load: ${line("load")}`);
