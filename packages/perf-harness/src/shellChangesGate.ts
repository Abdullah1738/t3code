// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off - Harness process boundaries intentionally measure native I/O and wall time outside the application runtime.
/**
 * Shell-changes gate: what a shell resume costs the server as the client falls further
 * behind, to choose ROBOB_SHELL_RESUME_MAX_GAP from measurements.
 *
 * Builds a throwaway database with the tree's own migrations, appends synthetic
 * application events (thread events with realistic payload sizes, spread over a fixed set
 * of threads, plus a few project events) and times `getShellChanges` over growing ranges
 * that end at the head, each one first right after reopening the database (SQLite's own
 * cache empty; the operating system's file cache is still warm) and then repeated.
 *
 * usage: node packages/perf-harness/src/shellChangesGate.ts LABEL OUT.json [EVENTS]
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const [label, out, eventsArg] = process.argv.slice(2);
if (!label || !out) {
  console.error("usage: shellChangesGate.ts LABEL OUT.json [EVENTS]");
  process.exit(2);
}

export const shellChangesWorkload = {
  version: 1,
  events: Number(eventsArg ?? 1_000_000),
  threads: 1_500,
  // Most events are small updates; some carry tool output.
  payloadBytes: 1_200,
  largePayloadEvery: 20,
  largePayloadBytes: 24_000,
  projectEventEvery: 5_000,
  gaps: [1_000, 20_000, 100_000, 200_000, 500_000, 1_000_000],
  maxThreads: 2_000,
} as const;

const Effect = await import("effect/Effect");
const Layer = await import("effect/Layer");
const NodeServices = await import("@effect/platform-node/NodeServices");
const Sqlite = await import("../../../apps/server/src/persistence/Sqlite.ts");
const Events = await import("../../../apps/server/src/persistence/OrchestrationEventStore.ts");

const home = NodeFS.mkdtempSync(NodePath.resolve(NodeOS.tmpdir(), "robob-shell-changes-gate-"));
NodeFS.mkdirSync(NodePath.resolve(home, "userdata"), { recursive: true });
const mainPath = NodePath.resolve(home, "userdata/statev2.sqlite");
const layer = Events.layer.pipe(
  Layer.provideMerge(Sqlite.layerFromPath(mainPath)),
  Layer.provideMerge(NodeServices.layer),
);
const withStore = <A>(
  use: (
    store: (typeof Events.OrchestrationEventStore)["Service"],
  ) => import("effect/Effect").Effect<A, unknown, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* Events.OrchestrationEventStore);
    }).pipe(Effect.provide(layer)),
  );

const result: Record<string, unknown> = {
  label,
  workload: shellChangesWorkload,
  host: { cpus: NodeOS.cpus().length, node: process.version },
};

try {
  // Create the schema with the real migrations, then close it.
  await withStore((store) => store.latestApplicationSequence);
  {
    const db = new NodeSqlite.DatabaseSync(mainPath);
    // Only this newly generated synthetic database uses relaxed import settings.
    db.exec("PRAGMA synchronous=OFF; PRAGMA cache_size=-524288");
    const insert = db.prepare(
      `INSERT INTO orchestration_events (
         event_id, aggregate_kind, stream_id, stream_version, event_type,
         occurred_at, actor_kind, payload_json, metadata_json, application_event_version
       ) VALUES (?, ?, ?, ?, ?, '2026-11-10T00:00:00.000Z', 'server', ?, '{}', 2)`,
    );
    const small = JSON.stringify({ text: "x".repeat(shellChangesWorkload.payloadBytes) });
    const large = JSON.stringify({ text: "x".repeat(shellChangesWorkload.largePayloadBytes) });
    const started = performance.now();
    db.exec("BEGIN");
    for (let i = 0; i < shellChangesWorkload.events; i++) {
      const project = i % shellChangesWorkload.projectEventEvery === 0;
      insert.run(
        `synthetic-event-${i}`,
        project ? "project" : "thread",
        project
          ? `synthetic-project-${i % 3}`
          : `synthetic-thread-${i % shellChangesWorkload.threads}`,
        i,
        project ? "project.meta-updated" : "message.updated",
        i % shellChangesWorkload.largePayloadEvery === 0 ? large : small,
      );
      if (i % 20_000 === 19_999) db.exec("COMMIT; BEGIN");
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    result.generateMs = performance.now() - started;
    result.databaseBytes = NodeFS.statSync(mainPath).size;
  }

  const samples: Array<Record<string, unknown>> = [];
  for (const gap of shellChangesWorkload.gaps) {
    if (gap > shellChangesWorkload.events) continue;
    // A new open per gap: the first read starts with SQLite's own cache empty.
    samples.push(
      await withStore((store) =>
        Effect.gen(function* () {
          const head = yield* store.latestApplicationSequence;
          const range = {
            afterSequence: head - gap,
            throughSequence: head,
            maxThreads: shellChangesWorkload.maxThreads,
          };
          const time = Effect.gen(function* () {
            const started = performance.now();
            const changes = yield* store.getShellChanges(range);
            return { ms: performance.now() - started, changes };
          });
          const first = yield* time;
          const warm: number[] = [];
          for (let i = 0; i < 5; i++) warm.push((yield* time).ms);
          warm.sort((a, b) => a - b);
          return {
            gap,
            complete: first.changes.complete,
            threads: first.changes.threads.length,
            projects: first.changes.projects.length,
            firstMs: first.ms,
            warmMsP50: warm[2],
            warmMsMax: warm[4],
          };
        }),
      ),
    );
  }
  result.samples = samples;
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
