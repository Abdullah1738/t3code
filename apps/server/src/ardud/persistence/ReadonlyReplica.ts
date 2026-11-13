import { annotateSqliteError, ErrorObserver } from "@t3tools/shared/nodeSqliteErrors";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  createReadonlyReplica,
  type ReadonlyReplicaOptions,
  type ReadonlyExportMetrics,
} from "./readonlyExport.ts";

export class ReadonlyReplicaMaintenanceError extends Schema.TaggedError<ReadonlyReplicaMaintenanceError>()(
  "ReadonlyReplicaMaintenanceError",
  {},
) {
  override get message() {
    return "Readonly export could not be stopped for maintenance.";
  }
}

export type ReplicaMaintenance = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | ReadonlyReplicaMaintenanceError, R>;

export class ReadonlyReplica extends Context.Service<
  ReadonlyReplica,
  { readonly run: Effect.Effect<void>; readonly withMaintenance: ReplicaMaintenance }
>()("t3/ardud/persistence/ReadonlyReplica") {}

export class ReadonlyExportUnavailable extends Schema.TaggedError<ReadonlyExportUnavailable>()(
  "ReadonlyExportUnavailable",
  {
    stage: Schema.String,
    reason: Schema.String,
    /** A held-back rebuild repeats every restart; only some are worth a warning. */
    quiet: Schema.optional(Schema.Boolean),
  },
) {}

/** Messages the export worker posts to its supervisor. */
type WorkerMessage =
  | { readonly type: "metrics"; readonly metrics: ReadonlyExportMetrics }
  | { readonly type: "opened" | "step" }
  | { readonly type: "published"; readonly cycleMs?: number }
  | {
      readonly type: "failed";
      readonly stage: string;
      readonly error: string;
      readonly native?: {
        readonly errcode?: unknown;
        readonly errstr?: unknown;
        readonly code?: unknown;
        readonly sqliteFile?: unknown;
        readonly sqliteRole?: unknown;
        readonly sqliteOperation?: unknown;
      };
      readonly quiet?: boolean;
    };

/** What the supervisor needs from a worker; a node Worker satisfies it. */
export interface ExportWorker {
  on(event: "message", listener: (message: WorkerMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  off(event: "message" | "error" | "exit", listener: (...args: never[]) => void): unknown;
  terminate(): Promise<number>;
}

export interface SupervisorOptions {
  /** No heartbeat for this long means the worker is hung; it is replaced. */
  readonly stallTimeout: Duration.Input;
  readonly restartDelay: Duration.Input;
  /** A worker stuck in native code may never exit; stop waiting for it. */
  readonly terminateTimeout: Duration.Input;
  /** While an automatic rebuild is held back, reopen this rarely (default 5 min). */
  readonly heldRestartDelay?: Duration.Input;
  /** A refresh cycle slower than this is logged (default 30 s, at most every 10 min). */
  readonly slowCycle?: Duration.Input;
}

const defaultSupervisorOptions: SupervisorOptions = {
  // A step is one bounded page; between cycles the worker idles 15 s.
  stallTimeout: "10 minutes",
  restartDelay: "15 seconds",
  terminateTimeout: "30 seconds",
  heldRestartDelay: "5 minutes",
  slowCycle: "30 seconds",
};

const SLOW_CYCLE_LOG_INTERVAL_MS = 10 * 60_000;

const HEARTBEAT_MS = 5_000;

/**
 * Self-contained worker source. Every failure carries its message back, and
 * progress posts a throttled heartbeat, so the supervisor can log why the
 * export stopped and replace a worker that went silent (9 Nov: an export that
 * failed every 15 s for 32 h left no trace anywhere).
 */
export const exportWorkerSource = (replicaFactory: string, idleMs = 15_000) => `
const { parentPort, workerData } = require('node:worker_threads');
const describe = (error) => String((error && error.message) || error).slice(0, 2000);
let replica;
let lastBeat = 0;
let lastMetrics = 0;
let cycleStarted = Date.now();
const beat = (type) => {
  const now = Date.now();
  if (type === 'published') {
    lastBeat = now;
    parentPort.postMessage({ type, cycleMs: now - cycleStarted });
  } else if (type !== 'step' || now - lastBeat >= ${HEARTBEAT_MS}) {
    lastBeat = now;
    parentPort.postMessage({ type });
  }
  if (now - lastMetrics >= ${HEARTBEAT_MS}) {
    lastMetrics = now;
    const metrics = replica?.takeMetrics?.();
    if (metrics) parentPort.postMessage({ type: 'metrics', metrics });
  }
};
const fail = (stage, error) => {
  try { replica?.close(); } catch {}
  const pendingRedaction = error && error.code === 'REDACTION_PENDING';
  const held = error && error.code === 'READONLY_REBUILD_HELD';
  parentPort.postMessage({
    type: 'failed',
    stage: pendingRedaction ? 'redaction-pending' : held ? 'rebuild-held' : stage,
    error: describe(error),
    native: { errcode: error && error.errcode, errstr: error && error.errstr, code: error && error.code, sqliteFile: error && error.sqliteFile, sqliteRole: error && error.sqliteRole, sqliteOperation: error && error.sqliteOperation },
    quiet: pendingRedaction || (held && error.notify === false),
  });
};
try {
  replica = (${replicaFactory})(require('node:sqlite'), require('node:fs'), require('node:path'), workerData);
  beat('opened');
  const step = () => {
    try {
      const more = replica.step();
      beat(more ? 'step' : 'published');
      if (more) setTimeout(step, 10);
      else {
        const idleUntil = Date.now() + ${idleMs};
        const idle = () => {
          try {
            const woke = replica.pollIdentities?.() === true;
            beat('step');
            if (woke || Date.now() >= idleUntil) {
              cycleStarted = Date.now();
              step();
            } else setTimeout(idle, Math.min(1000, idleUntil - Date.now()));
          } catch (error) { fail('idle', error); }
        };
        setTimeout(idle, Math.min(1000, ${idleMs}));
      }
    } catch (error) {
      fail('step', error);
    }
  };
  step();
} catch (error) {
  fail('open', error);
}
`;

/**
 * Runs one worker until it fails, exits or stops sending heartbeats. Never
 * succeeds: the caller logs the failure and starts a fresh worker.
 */
export const superviseExportWorker = Effect.fn("ReadonlyReplica.superviseExportWorker")(function* (
  spawn: () => ExportWorker,
  options: SupervisorOptions = defaultSupervisorOptions,
): Effect.fn.Return<never, ReadonlyExportUnavailable> {
  const observer = yield* ErrorObserver;
  const clock = yield* Clock.Clock;
  const stallMs = Duration.toMillis(Duration.fromInputUnsafe(options.stallTimeout));
  let lastBeat = clock.currentTimeMillisUnsafe();
  const slowMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.slowCycle ?? defaultSupervisorOptions.slowCycle!),
  );
  let metrics: ReadonlyExportMetrics = {
    phaseMs: {},
    phaseSteps: {},
    identityRows: 0,
    identityLagMaxMs: 0,
  };
  let metricsLoggedAt = Number.NEGATIVE_INFINITY;
  let slowCycleMs: number | undefined;
  let slowLoggedAt = Number.NEGATIVE_INFINITY;
  const signal = (worker: ExportWorker) =>
    Effect.callback<never, ReadonlyExportUnavailable>((resume) => {
      const onMessage = (message: WorkerMessage) => {
        if (message?.type === "failed") {
          if (message.native)
            annotateSqliteError(
              message.native,
              {
                file:
                  typeof message.native.sqliteFile === "string"
                    ? message.native.sqliteFile
                    : "readonly-export:unknown",
                role:
                  message.native.sqliteRole === "primary" || message.native.sqliteRole === "replica"
                    ? message.native.sqliteRole
                    : "unknown",
                connection: "export-worker",
                operation:
                  typeof message.native.sqliteOperation === "string"
                    ? message.native.sqliteOperation
                    : message.stage,
                span: "ReadonlyReplica.superviseExportWorker",
              },
              observer,
            );
          resume(
            Effect.fail(
              new ReadonlyExportUnavailable({
                stage: message.stage,
                reason: message.error,
                quiet: message.quiet === true,
              }),
            ),
          );
        } else {
          lastBeat = clock.currentTimeMillisUnsafe();
          if (message?.type === "metrics") {
            for (const [phase, ms] of Object.entries(message.metrics.phaseMs))
              metrics.phaseMs[phase] = (metrics.phaseMs[phase] ?? 0) + ms;
            for (const [phase, steps] of Object.entries(message.metrics.phaseSteps))
              metrics.phaseSteps[phase] = (metrics.phaseSteps[phase] ?? 0) + steps;
            metrics = {
              ...metrics,
              identityRows: metrics.identityRows + message.metrics.identityRows,
              identityLagMaxMs: Math.max(
                metrics.identityLagMaxMs,
                message.metrics.identityLagMaxMs,
              ),
            };
          }
          if (message?.type === "published" && (message.cycleMs ?? 0) > slowMs)
            slowCycleMs = Math.max(slowCycleMs ?? 0, message.cycleMs!);
        }
      };
      const onError = (error: Error) =>
        resume(
          Effect.fail(
            new ReadonlyExportUnavailable({ stage: "worker", reason: String(error?.message) }),
          ),
        );
      const onExit = (code: number) =>
        resume(
          Effect.fail(
            new ReadonlyExportUnavailable({ stage: "worker", reason: `exited with ${code}` }),
          ),
        );
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      return Effect.sync(() => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      });
    });
  const watchdog = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(Math.max(10, Math.min(stallMs / 4, 30_000))));
      const now = clock.currentTimeMillisUnsafe();
      if (slowCycleMs !== undefined && now - slowLoggedAt >= SLOW_CYCLE_LOG_INTERVAL_MS) {
        // Its own span: the worker span stays open while the worker is healthy.
        yield* Effect.logWarning(
          `Readonly export cycle took ${Math.round(slowCycleMs / 1000)}s; outside readers allow 45-120s`,
        ).pipe(
          Effect.annotateLogs({ cycleMs: slowCycleMs }),
          Effect.withSpan("ardud.readonlyExport.slowCycle"),
        );
        slowLoggedAt = now;
        slowCycleMs = undefined;
      }
      if (Object.keys(metrics.phaseSteps).length && now - metricsLoggedAt >= 60_000) {
        yield* Effect.logInfo("Readonly export phase timings").pipe(
          Effect.annotateLogs({ phaseMs: metrics.phaseMs, phaseSteps: metrics.phaseSteps }),
          Effect.withSpan("ardud.readonlyExport.cyclePhases"),
        );
        if (metrics.identityRows)
          yield* Effect.logInfo("Readonly identity publication lag").pipe(
            Effect.annotateLogs({ rows: metrics.identityRows, maxLagMs: metrics.identityLagMaxMs }),
            Effect.withSpan("ardud.readonlyExport.identityPublishLag"),
          );
        metrics = { phaseMs: {}, phaseSteps: {}, identityRows: 0, identityLagMaxMs: 0 };
        metricsLoggedAt = now;
      }
      const silent = now - lastBeat;
      if (silent > stallMs) {
        return yield* new ReadonlyExportUnavailable({
          stage: "stalled",
          reason: `no progress for ${Math.round(silent / 1000)}s; replacing the worker`,
        });
      }
    }
  });
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: spawn,
      catch: (error) => new ReadonlyExportUnavailable({ stage: "spawn", reason: String(error) }),
    }),
    (worker) => Effect.raceFirst(signal(worker), watchdog),
    (worker) =>
      Effect.promise(() => worker.terminate()).pipe(
        Effect.timeout(options.terminateTimeout),
        Effect.catch(() => Effect.logWarning("Readonly export worker did not stop; abandoning it")),
        Effect.asVoid,
      ),
  );
});

/**
 * Supervise forever: every failure is logged with its reason, then retried.
 * A held-back rebuild (same reason inside the backoff window) reopens every
 * 5 minutes and warns only when the exporter says a notice is due (hourly).
 */
export const superviseReadonlyExport = (
  spawn: () => ExportWorker,
  options: SupervisorOptions = defaultSupervisorOptions,
): Effect.Effect<never> =>
  Effect.forever(
    superviseExportWorker(spawn, options).pipe(
      Effect.catch((error) => {
        const message = `Readonly export unavailable (${error.stage}): ${error.reason}; restarting the export worker`;
        const held = error.stage === "rebuild-held" || error.stage === "redaction-pending";
        return (error.quiet ? Effect.logDebug(message) : Effect.logWarning(message)).pipe(
          Effect.annotateLogs({ stage: error.stage, reason: error.reason }),
          Effect.as(
            held
              ? (options.heldRestartDelay ?? defaultSupervisorOptions.heldRestartDelay!)
              : options.restartDelay,
          ),
        );
      }),
      // A span, so the warning lands in server.trace.ndjson; the server's plain
      // stdout is only persisted when the server itself crashes.
      Effect.withSpan("ardud.readonlyExport.worker"),
      Effect.flatMap((delay) => Effect.sleep(delay)),
    ),
  );

export const makeCoordinatedReplica = Effect.fn("ReadonlyReplica.makeCoordinated")(function* (
  spawn: () => ExportWorker,
  options: SupervisorOptions = defaultSupervisorOptions,
) {
  const gate = yield* Semaphore.make(1);
  const workers = new Set<ExportWorker>();
  let active: Fiber.Fiber<never, never> | undefined;
  const trackedSpawn = () => {
    const worker = spawn();
    workers.add(worker);
    worker.on("exit", () => workers.delete(worker));
    return worker;
  };
  const run = Effect.forever(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* gate.withPermit(
          Effect.gen(function* () {
            const next = yield* Effect.forkScoped(superviseReadonlyExport(trackedSpawn, options), {
              startImmediately: true,
            });
            active = next;
            return next;
          }),
        );
        yield* Fiber.await(fiber);
      }),
    ),
  );
  const withMaintenance: ReplicaMaintenance = (effect) =>
    gate.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (active) {
            yield* Fiber.interrupt(active);
            active = undefined;
          }
          // A timed-out termination is not permission to mutate beneath that worker.
          if (workers.size) return yield* new ReadonlyReplicaMaintenanceError({});
          return yield* restore(effect);
        }),
      ),
    );
  return ReadonlyReplica.of({ run, withMaintenance });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const options: ReadonlyReplicaOptions = {
    sourcePath: config.dbPath,
    replicaPath:
      process.env.ROBOB_READONLY_DB ??
      path.join(path.dirname(config.dbPath), "readonly", "state.sqlite"),
    boardPath: path.join(path.dirname(config.dbPath), "boards.sqlite"),
    archivePath: path.join(path.dirname(config.dbPath), "archive.sqlite"),
  };
  const source = exportWorkerSource(createReadonlyReplica.toString());
  return yield* makeCoordinatedReplica(
    () =>
      new NodeWorkerThreads.Worker(source, {
        eval: true,
        execArgv: [],
        workerData: options,
      }) as unknown as ExportWorker,
  );
});

export const serviceLayer = Layer.effect(ReadonlyReplica, make);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const replica = yield* ReadonlyReplica;
    yield* forkParked(replica.run);
  }),
).pipe(Layer.provideMerge(serviceLayer));
