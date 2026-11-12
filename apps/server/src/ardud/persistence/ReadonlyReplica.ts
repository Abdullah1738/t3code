import * as NodeWorkerThreads from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import { createReadonlyReplica, type ReadonlyReplicaOptions } from "./readonlyExport.ts";

class ReadonlyReplica extends Context.Service<
  ReadonlyReplica,
  { readonly run: Effect.Effect<void> }
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
  | { readonly type: "opened" | "step" }
  | { readonly type: "published"; readonly cycleMs?: number }
  | {
      readonly type: "failed";
      readonly stage: string;
      readonly error: string;
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
};
const fail = (stage, error) => {
  try { replica?.close(); } catch {}
  const held = error && error.code === 'READONLY_REBUILD_HELD';
  parentPort.postMessage({
    type: 'failed',
    stage: held ? 'rebuild-held' : stage,
    error: describe(error),
    quiet: held && error.notify === false,
  });
};
try {
  replica = (${replicaFactory})(require('node:sqlite'), require('node:fs'), require('node:path'), workerData);
  beat('opened');
  const step = () => {
    try {
      const more = replica.step();
      beat(more ? 'step' : 'published');
      if (!more) cycleStarted = Date.now() + ${idleMs};
      setTimeout(step, more ? 10 : ${idleMs});
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
  const clock = yield* Clock.Clock;
  const stallMs = Duration.toMillis(Duration.fromInputUnsafe(options.stallTimeout));
  let lastBeat = clock.currentTimeMillisUnsafe();
  const slowMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.slowCycle ?? defaultSupervisorOptions.slowCycle!),
  );
  let slowCycleMs: number | undefined;
  let slowLoggedAt = Number.NEGATIVE_INFINITY;
  const signal = (worker: ExportWorker) =>
    Effect.callback<never, ReadonlyExportUnavailable>((resume) => {
      const onMessage = (message: WorkerMessage) => {
        if (message?.type === "failed") {
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
        const held = error.stage === "rebuild-held";
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
  const run = superviseReadonlyExport(
    () =>
      new NodeWorkerThreads.Worker(source, {
        eval: true,
        execArgv: [],
        workerData: options,
      }) as unknown as ExportWorker,
  );
  return ReadonlyReplica.of({ run });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const replica = yield* ReadonlyReplica;
    yield* forkParked(replica.run);
  }),
).pipe(Layer.provide(Layer.effect(ReadonlyReplica, make)));
