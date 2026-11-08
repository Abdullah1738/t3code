import * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import { createReadonlyReplica, type ReadonlyReplicaOptions } from "./readonlyExport.ts";

class ReadonlyReplica extends Context.Service<
  ReadonlyReplica,
  { readonly run: Effect.Effect<void> }
>()("t3/ardud/persistence/ReadonlyReplica") {}

class ReadonlyExportUnavailable extends Schema.TaggedError<ReadonlyExportUnavailable>()(
  "ReadonlyExportUnavailable",
  {},
) {}

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
  const runOnce = Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        new NodeWorkerThreads.Worker(
          `
      const { parentPort, workerData } = require('node:worker_threads');
      let replica;
      try {
        replica = (${createReadonlyReplica.toString()})(require('node:sqlite'), require('node:fs'), require('node:path'), workerData);
        const step = () => {
          try {
            const more = replica.step();
            setTimeout(step, more ? 10 : 15_000);
          } catch (error) {
            replica.close();
            parentPort.postMessage({ failed: true });
          }
        };
        step();
      } catch (error) {
        replica?.close();
        parentPort.postMessage({ failed: true });
      }
    `,
          { eval: true, execArgv: [], workerData: options },
        ),
      catch: () => new ReadonlyExportUnavailable(),
    }),
    (worker) =>
      Effect.callback<void, ReadonlyExportUnavailable>((resume) => {
        const fail = () => resume(Effect.fail(new ReadonlyExportUnavailable()));
        worker.once("error", fail);
        worker.once("exit", fail);
        worker.once("message", fail);
      }),
    (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
  );
  const run = runOnce.pipe(
    Effect.catch(() =>
      Effect.logWarning("Readonly export unavailable; outside reads remain on the replica"),
    ),
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.asVoid,
  );
  return ReadonlyReplica.of({ run });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const replica = yield* ReadonlyReplica;
    yield* forkParked(replica.run);
  }),
).pipe(Layer.provide(Layer.effect(ReadonlyReplica, make)));
