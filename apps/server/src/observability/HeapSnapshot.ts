// @effect-diagnostics nodeBuiltinImport:off - V8 diagnostics and statfs have no Effect equivalents.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

type HeapStats = Pick<NodeV8.HeapInfo, "used_heap_size" | "heap_size_limit">;

const snapshotAt = Config.schema(
  Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 })),
  "T3CODE_HEAP_SNAPSHOT_AT",
).pipe(Config.withDefault(0.7));
const MAX_TRIGGER_BYTES = 1.4 * 1024 ** 3;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const writeHeapSnapshot = Effect.fn("server.heapSnapshot", { root: true })(
  function* (logsDir: string, heap: HeapStats = NodeV8.getHeapStatistics()) {
    const fs = yield* FileSystem.FileSystem;
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(logsDir, `server-${process.pid}-${timestamp}.heapsnapshot`);
    yield* Effect.annotateCurrentSpan({ path });
    yield* Effect.try(() => NodeV8.writeHeapSnapshot(path)).pipe(
      Effect.tapError(() => fs.remove(path, { force: true }).pipe(Effect.ignore)),
    );
    yield* Effect.logInfo("Wrote heap snapshot.", {
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      path,
    });
    return path;
  },
  Effect.catch((cause) => Effect.logWarning("Failed to write heap snapshot.", { cause })),
);

const cleanup = Effect.fn("server.heapSnapshot.cleanup")(
  function* (logsDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const cutoff = DateTime.toEpochMillis(yield* DateTime.now) - RETENTION_MS;
    for (const name of yield* fs.readDirectory(logsDir)) {
      if (!name.startsWith("server-") || !name.endsWith(".heapsnapshot")) continue;
      const path = NodePath.join(logsDir, name);
      yield* Effect.gen(function* () {
        const info = yield* fs.stat(path);
        if (
          info.type === "File" &&
          Option.isSome(info.mtime) &&
          info.mtime.value.getTime() < cutoff
        ) {
          yield* fs.remove(path);
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to remove old heap snapshot.", { path, cause }),
        ),
      );
    }
  },
  Effect.catch((cause) => Effect.logWarning("Failed to clean up heap snapshots.", { cause })),
);

const readFreeBytes = Effect.fn("server.heapSnapshot.freeBytes")(function* (logsDir: string) {
  const stats = yield* Effect.tryPromise(() => NodeFSP.statfs(logsDir));
  return stats.bavail * stats.bsize;
});

export const layerWith = (
  logsDir: string,
  readHeapStats: () => HeapStats = NodeV8.getHeapStatistics,
  freeBytes: typeof readFreeBytes = readFreeBytes,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* cleanup(logsDir);
      const threshold = yield* snapshotAt.pipe(
        Effect.catch(() =>
          Effect.logWarning("Invalid T3CODE_HEAP_SNAPSHOT_AT; using 0.70.").pipe(Effect.as(0.7)),
        ),
      );
      let attempted = false;
      let lowDiskLogged = false;
      // A snapshot blocks the event loop for seconds; acceptable once per process
      // for automatic diagnostics. Manual SIGUSR2 requests remain available.
      const snapshot = Effect.fn("server.heapSnapshot.capture")(function* (heap: HeapStats) {
        attempted = true;
        yield* writeHeapSnapshot(logsDir, heap);
      });
      const tick = Effect.gen(function* () {
        if (attempted) return;
        const heap = yield* Effect.try(readHeapStats);
        // Real huge-string OOMs occur well below V8's nominal 4 GiB limit.
        if (heap.used_heap_size < Math.min(MAX_TRIGGER_BYTES, threshold * heap.heap_size_limit))
          return;
        const availableBytes = yield* freeBytes(logsDir);
        if (availableBytes < 2 * heap.used_heap_size) {
          if (!lowDiskLogged) {
            lowDiskLogged = true;
            yield* Effect.logWarning("Skipped heap snapshot: insufficient disk space.", {
              heapUsedBytes: heap.used_heap_size,
              heapLimitBytes: heap.heap_size_limit,
              availableBytes,
              logsDir,
            });
          }
          return;
        }
        // A manual signal may have captured while statfs was in flight.
        if (!attempted) yield* snapshot(heap);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to check heap snapshot threshold.", { cause }),
        ),
      );
      if (threshold > 0) {
        yield* Effect.sleep("30 seconds").pipe(
          Effect.andThen(tick),
          Effect.forever,
          Effect.forkScoped,
        );
      }
      if ((yield* HostProcess.Platform) === "win32") return;
      const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem>());
      const onSignal = () => void runFork(Effect.suspend(() => snapshot(readHeapStats())));
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGUSR2", onSignal)),
        () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
      );
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { logsDir } = yield* ServerConfig.ServerConfig;
    return layerWith(logsDir);
  }),
);
