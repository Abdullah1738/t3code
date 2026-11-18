import { annotateSqliteError, ErrorObserver } from "@t3tools/shared/nodeSqliteErrors";
import {
  workerMemoryLimits,
  workerMemoryHeartbeatSource,
  trackWorkerMemory,
} from "@t3tools/shared/workerMemory";
// Worker lifecycle is the native boundary; SQL work stays off the event loop.
// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as NodeWorkerThreads from "node:worker_threads";

import { forkParked } from "../../serverActivation.ts";
import { archiveCheckpointWorkerSource } from "./archiveCheckpointWorker.ts";
import { archiveFilename } from "./historyArchiveSql.ts";

export class HistoryArchiveDurability extends Context.Service<
  HistoryArchiveDurability,
  {
    /** Main's committed history is on disk (F_FULLFSYNC) before the archive copies it. */
    readonly flushHistorySource: Effect.Effect<boolean>;
    /**
     * Every archive commit made so far is on disk (F_FULLFSYNC) before main deletes the
     * hot row. The live writer commits archive copies without any sync of its own, so
     * this is the only barrier between "copied" and "deleted".
     */
    readonly syncArchive: Effect.Effect<boolean>;
  }
>()("t3/ardud/persistence/archiveCheckpoint/HistoryArchiveDurability") {}

/** A reader holding an older archive snapshot only blocks the barrier briefly. */
const SYNC_ARCHIVE_ATTEMPTS = 4;
const SYNC_ARCHIVE_RETRY = "250 millis";

// Main NORMAL commits must reach disk before the archive copy can outlive them, and
// the archive copy must reach disk before main deletes the row. Both barriers and
// the periodic archive checkpoints run in this worker, never on the writer.
export const archiveCheckpointLayer = (filename: string) =>
  Layer.effect(
    HistoryArchiveDurability,
    Effect.gen(function* () {
      const observer = yield* ErrorObserver;
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      // One operation at a time; a barrier waits for an in-flight periodic checkpoint
      // instead of failing because the worker happened to be busy.
      const serial = yield* Semaphore.make(1);
      let worker: NodeWorkerThreads.Worker | undefined;
      let pending:
        | {
            readonly id: number;
            readonly complete: (
              ok: boolean,
              reason: string,
              attributes?: Record<string, number | string>,
            ) => void;
          }
        | undefined;
      let requestId = 0;
      // Only a broken worker (error, exit, hang) backs off respawning. A checkpoint that
      // could not finish (a pinned reader) is reported to the caller, which paces itself.
      let retryAt = 0;
      let retryDelay = 1000;
      let warnAfter = 0;
      let closed = false;
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.promise(async () => {
          closed = true;
          pending?.complete(false, "closed");
          pending = undefined;
          await worker?.terminate();
          worker = undefined;
        }),
      );

      const workerFailed = () => {
        retryAt = now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };

      const request = Effect.fn("HistoryArchiveDurability.checkpoint")(
        (operation: "checkpoint" | "flush-main" | "maintenance") =>
          Effect.suspend(() => {
            const elapsed = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
            const queuedAt = elapsed();
            let workerAt = queuedAt;
            let reason = "incomplete";
            let resultFields: Readonly<Record<string, number | string>> = {};
            const work = Effect.callback<boolean>((resume) => {
              workerAt = elapsed();
              if (closed || pending !== undefined || now() < retryAt) {
                reason = closed ? "closed" : pending !== undefined ? "worker_busy" : "backoff";
                resume(Effect.succeed(false));
                return;
              }
              if (worker === undefined) {
                try {
                  const instance = trackWorkerMemory(
                    new NodeWorkerThreads.Worker(
                      workerMemoryHeartbeatSource("checkpoint") + archiveCheckpointWorkerSource,
                      {
                        eval: true,
                        resourceLimits: workerMemoryLimits.checkpoint,
                        workerData: { filename, archiveFilename: archiveFilename(filename) },
                      },
                    ),
                    "checkpoint",
                  );
                  worker = instance;
                  const failed = (failure: "worker_error" | "worker_exit") => {
                    if (worker !== instance) return;
                    worker = undefined;
                    workerFailed();
                    const waiting = pending;
                    pending = undefined;
                    waiting?.complete(false, failure);
                    instance.unref();
                  };
                  instance.on(
                    "message",
                    (result: {
                      readonly id: number;
                      readonly ok: boolean;
                      readonly failure?: unknown;
                      readonly file: string;
                      readonly walBytes?: number;
                      readonly checkpoint?: {
                        readonly busy?: number;
                        readonly log: number;
                        readonly checkpointed: number;
                      };
                      readonly truncate?: { readonly busy: number };
                    }) => {
                      if (worker !== instance || pending?.id !== result.id) return;
                      if (result.failure)
                        annotateSqliteError(
                          result.failure,
                          {
                            file: result.file,
                            role: "primary",
                            connection: "archive-checkpoint",
                            operation: "checkpoint",
                            span: "HistoryArchiveDurability.checkpoint",
                          },
                          observer,
                        );
                      const waiting = pending;
                      pending = undefined;
                      retryDelay = 1000;
                      instance.unref();
                      waiting.complete(
                        result.ok === true,
                        result.ok
                          ? "complete"
                          : result.failure
                            ? "sql_error"
                            : result.checkpoint?.busy
                              ? "checkpoint_busy"
                              : result.checkpoint &&
                                  result.checkpoint.log > result.checkpoint.checkpointed
                                ? "checkpoint_backlog"
                                : "incomplete",
                        {
                          ...(result.walBytes === undefined
                            ? {}
                            : { "db.wal.bytes": result.walBytes }),
                          ...(result.checkpoint === undefined
                            ? {}
                            : {
                                "db.wal.log_frames": result.checkpoint.log,
                                "db.wal.checkpointed_frames": result.checkpoint.checkpointed,
                                ...(result.checkpoint.busy === undefined
                                  ? {}
                                  : { "db.wal.checkpoint_busy": result.checkpoint.busy }),
                              }),
                          ...(result.truncate === undefined
                            ? {}
                            : { "db.wal.truncate_busy": result.truncate.busy }),
                        },
                      );
                    },
                  );
                  instance.on("error", () => failed("worker_error"));
                  instance.on("exit", () => failed("worker_exit"));
                  instance.unref();
                } catch {
                  reason = "startup_error";
                  workerFailed();
                  resume(Effect.succeed(false));
                  return;
                }
              }
              const instance = worker;
              const id = ++requestId;
              pending = {
                id,
                complete: (ok, why, attributes = {}) => {
                  reason = why;
                  resultFields = attributes;
                  return resume(
                    Effect.annotateCurrentSpan({
                      "archive.operation": operation,
                      ...attributes,
                    }).pipe(Effect.as(ok)),
                  );
                },
              };
              instance.ref();
              try {
                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
                instance.postMessage({ id, operation });
              } catch {
                reason = "send_error";
                pending = undefined;
                worker = undefined;
                workerFailed();
                instance.unref();
                void instance.terminate();
                resume(Effect.succeed(false));
              }
              return Effect.sync(() => {
                if (pending?.id !== id) return;
                pending = undefined;
                worker = undefined;
                workerFailed();
                instance.unref();
                void instance.terminate();
              });
            }).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.sync(() => {
                    reason = "timeout";
                    return false;
                  }),
              }),
              serial.withPermits(1),
              Effect.tap((ok) => {
                const ended = elapsed();
                const fields = {
                  operation,
                  reason,
                  durationMs: Math.max(0, ended - queuedAt),
                  queueMs: Math.max(0, workerAt - queuedAt),
                  workerWaitMs: Math.max(0, ended - workerAt),
                  db: operation === "flush-main" ? "statev2" : "history-archive",
                  connection: "archive-checkpoint",
                  separateConnection: true,
                  separateFromBoardsDatabase: true,
                  sharesBoardLock: false,
                  ...resultFields,
                };
                if (ok || now() < warnAfter) return Effect.void;
                warnAfter = now() + 30_000;
                return Effect.logWarning(
                  // Fixed diagnostic fields; one event for the checkpoint, not one per retry phase.
                  JSON.stringify({
                    event:
                      "History archive checkpoint did not complete; archive movement must wait.",
                    ...fields,
                  }),
                ).pipe(Effect.annotateLogs(fields));
              }),
            );
            return work;
          }),
      );

      yield* forkParked(
        Effect.sleep("1 minute").pipe(
          Effect.andThen(request("maintenance").pipe(Effect.repeat(Schedule.spaced("1 minute")))),
        ),
      );
      const flushHistorySource = request("flush-main");
      const syncArchive = Effect.gen(function* () {
        for (let attempt = 1; attempt <= SYNC_ARCHIVE_ATTEMPTS; attempt++) {
          if (yield* request("checkpoint")) return true;
          if (attempt < SYNC_ARCHIVE_ATTEMPTS) yield* Effect.sleep(SYNC_ARCHIVE_RETRY);
        }
        return false;
      });
      return HistoryArchiveDurability.of({ flushHistorySource, syncArchive });
    }),
  );
