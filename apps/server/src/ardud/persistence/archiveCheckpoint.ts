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

// Kept in an evaluated worker so bundled builds need no worker file on disk.
// A complete PASSIVE checkpoint (checkpointed === log) syncs the WAL, copies every
// frame into the database file and syncs that file, all with F_FULLFSYNC here, off
// the event loop and off the writer connection.
const source = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let archive;
parentPort.on('message', ({ id, operation }) => {
  let main;
  let ok = false;
  try {
    const db = operation === 'flush-main'
      ? (main = new DatabaseSync(workerData.filename))
      : (archive ??= new DatabaseSync(workerData.archiveFilename));
    db.exec('PRAGMA busy_timeout=0; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
    const result = db.prepare('PRAGMA main.wal_checkpoint(PASSIVE)').get();
    ok = result.busy === 0 && result.log >= 0 && result.checkpointed === result.log;
  } catch {
    ok = false;
  } finally {
    try { main?.close(); } catch { ok = false; }
  }
  parentPort.postMessage({ id, ok });
});`;

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
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      // One operation at a time; a barrier waits for an in-flight periodic checkpoint
      // instead of failing because the worker happened to be busy.
      const serial = yield* Semaphore.make(1);
      let worker: NodeWorkerThreads.Worker | undefined;
      let pending: { readonly id: number; readonly complete: (ok: boolean) => void } | undefined;
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
          pending?.complete(false);
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
        (operation: "checkpoint" | "flush-main") =>
          Effect.callback<boolean>((resume) => {
            if (closed || pending !== undefined || now() < retryAt) {
              resume(Effect.succeed(false));
              return;
            }
            if (worker === undefined) {
              try {
                const instance = new NodeWorkerThreads.Worker(source, {
                  eval: true,
                  workerData: { filename, archiveFilename: archiveFilename(filename) },
                });
                worker = instance;
                const failed = () => {
                  if (worker !== instance) return;
                  worker = undefined;
                  workerFailed();
                  const waiting = pending;
                  pending = undefined;
                  waiting?.complete(false);
                  instance.unref();
                };
                instance.on("message", (result: { readonly id: number; readonly ok: boolean }) => {
                  if (worker !== instance || pending?.id !== result.id) return;
                  const waiting = pending;
                  pending = undefined;
                  retryDelay = 1000;
                  instance.unref();
                  waiting.complete(result.ok === true);
                });
                instance.on("error", failed);
                instance.on("exit", failed);
                instance.unref();
              } catch {
                workerFailed();
                resume(Effect.succeed(false));
                return;
              }
            }
            const instance = worker;
            const id = ++requestId;
            pending = { id, complete: (ok) => resume(Effect.succeed(ok)) };
            instance.ref();
            try {
              // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
              instance.postMessage({ id, operation });
            } catch {
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
            Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(false) }),
            serial.withPermits(1),
            Effect.tap((ok) => {
              if (ok || now() < warnAfter) return Effect.void;
              warnAfter = now() + 30_000;
              return Effect.logWarning(
                "History archive checkpoint did not complete; archive movement must wait.",
                {
                  operation,
                },
              );
            }),
          ),
      );

      yield* forkParked(
        Effect.sleep("10 seconds").pipe(
          Effect.andThen(request("checkpoint").pipe(Effect.repeat(Schedule.spaced("10 seconds")))),
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
