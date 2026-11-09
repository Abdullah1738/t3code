// Worker lifecycle is the native boundary; SQL work stays off the event loop.
// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as NodeWorkerThreads from "node:worker_threads";

import { forkParked } from "../../serverActivation.ts";
import { archiveFilename } from "./historyArchiveSql.ts";

export class HistoryArchiveDurability extends Context.Service<
  HistoryArchiveDurability,
  { readonly flushHistorySource: Effect.Effect<boolean> }
>()("t3/ardud/persistence/archiveCheckpoint/HistoryArchiveDurability") {}

// Kept in an evaluated worker so bundled builds need no worker file on disk.
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

// Main NORMAL commits must reach disk before the archive's FULL copy can outlive
// them. This barrier and periodic archive checkpoints never run on the writer.
export const archiveCheckpointLayer = (filename: string) =>
  Layer.effect(
    HistoryArchiveDurability,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      let worker: NodeWorkerThreads.Worker | undefined;
      let pending: { readonly id: number; readonly complete: (ok: boolean) => void } | undefined;
      let requestId = 0;
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
                  retryAt = now() + retryDelay;
                  retryDelay = Math.min(retryDelay * 2, 30_000);
                  const waiting = pending;
                  pending = undefined;
                  waiting?.complete(false);
                  instance.unref();
                };
                instance.on("message", (result: { readonly id: number; readonly ok: boolean }) => {
                  if (worker !== instance || pending?.id !== result.id) return;
                  const waiting = pending;
                  pending = undefined;
                  if (result.ok) {
                    retryDelay = 1000;
                  } else {
                    retryAt = now() + retryDelay;
                    retryDelay = Math.min(retryDelay * 2, 30_000);
                  }
                  instance.unref();
                  waiting.complete(result.ok === true);
                });
                instance.on("error", failed);
                instance.on("exit", failed);
                instance.unref();
              } catch {
                retryAt = now() + retryDelay;
                retryDelay = Math.min(retryDelay * 2, 30_000);
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
              retryAt = now() + retryDelay;
              retryDelay = Math.min(retryDelay * 2, 30_000);
              instance.unref();
              void instance.terminate();
              resume(Effect.succeed(false));
            }
            return Effect.sync(() => {
              if (pending?.id !== id) return;
              pending = undefined;
              worker = undefined;
              retryAt = now() + retryDelay;
              retryDelay = Math.min(retryDelay * 2, 30_000);
              instance.unref();
              void instance.terminate();
            });
          }).pipe(
            Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(false) }),
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
      return HistoryArchiveDurability.of({ flushHistorySource });
    }),
  );
