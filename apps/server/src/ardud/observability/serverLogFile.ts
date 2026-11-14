import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import { TraceMaintenanceError, type TraceMaintenance } from "@t3tools/shared/observability";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;

export class Maintenance extends Context.Service<
  Maintenance,
  {
    readonly withMaintenance: TraceMaintenance;
  }
>()("t3/ardud/observability/serverLogFile/Maintenance") {}

function withoutAccessors(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (typeof value !== "object" || value === null || Redactable.isRedactable(value)) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return seen.get(value);
  const copy: object = Array.isArray(value)
    ? []
    : Object.create(prototype === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    Object.defineProperty(
      copy,
      key,
      "value" in descriptor
        ? { ...descriptor, value: withoutAccessors(descriptor.value, seen) }
        : { enumerable: descriptor.enumerable ?? false, value: "[Getter]" },
    );
  }
  return copy;
}

export const make = Effect.fn("serverLogFile.make")(function* (options: {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rotation = {
    filePath: options.filePath,
    maxBytes,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
  };
  let sink = yield* makeAsyncRotatingFileSink(rotation);
  let paused = false;
  let buffer: string[] = [];
  let writeFailed = false;
  let repairTail = true;
  const mutex = yield* Semaphore.make(1);
  const console = yield* Console.Console;
  // Effect's formatter honors Redacted values and Redactable hooks, including
  // annotations. Keep credentials out of this sink exactly as in OTLP logs.
  const formatter = Logger.make((record) => {
    let text: string;
    try {
      text = `${Formatter.formatJson(withoutAccessors(Logger.formatStructured.log(record)))}\n`;
    } catch {
      // A user-supplied inspection hook must not fail the effect being logged.
      text = `${JSON.stringify({ message: "server log record could not be serialized", level: record.logLevel.toUpperCase(), timestamp: record.date.toISOString() })}\n`;
    }
    const bytes = Buffer.byteLength(text);
    return bytes <= maxBytes
      ? text
      : `${JSON.stringify({
          message: "server log record exceeded file size limit",
          level: record.logLevel.toUpperCase(),
          timestamp: record.date.toISOString(),
          originalBytes: bytes,
        })}\n`;
  });
  const drain = Effect.gen(function* () {
    const records = buffer;
    buffer = [];
    // Batch appends without allowing a batch to exceed the rotation limit.
    // No per-record spans or synchronous filesystem calls on the logging path.
    let batch: string[] = [];
    let bytes = 0;
    const write = Effect.fnUntraced(
      function* (text: string) {
        if (repairTail) {
          const bytes = yield* fs
            .readFile(options.filePath)
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed(new Uint8Array())
                  : Effect.fail(error),
              ),
            );
          const end = bytes.lastIndexOf(10) + 1;
          if (end < bytes.length) yield* fs.truncate(options.filePath, end);
          sink = yield* makeAsyncRotatingFileSink(rotation).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          repairTail = false;
        }
        yield* sink.write(text);
      },
      Effect.catch(() =>
        Effect.sync(() => {
          writeFailed = true;
          repairTail = true;
          console.error("server log file write failed", {
            filePath: options.filePath,
            operation: "append",
          });
        }),
      ),
    );
    for (const record of records) {
      const size = Buffer.byteLength(record);
      if (bytes + size > maxBytes && batch.length > 0) {
        yield* write(batch.join(""));
        batch = [];
        bytes = 0;
      }
      batch.push(record);
      bytes += size;
    }
    if (batch.length > 0) yield* write(batch.join(""));
  });
  // Timer, shutdown and redaction share one drain; a cancelled OS append must
  // finish before maintenance rewrites or rotates any file.
  const flush = mutex
    .withPermit(drain)
    .pipe(Effect.uninterruptible, Effect.withTracerEnabled(false));
  yield* Effect.addFinalizer(() => flush);
  yield* Effect.sleep("1 second").pipe(Effect.andThen(flush), Effect.forever, Effect.forkScoped);
  const withMaintenance: Maintenance["Service"]["withMaintenance"] = (effect) =>
    mutex
      .withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            paused = true;
            writeFailed = false;
            yield* drain;
            if (writeFailed) {
              paused = false;
              return yield* new TraceMaintenanceError({});
            }
            const result = yield* restore(effect).pipe(Effect.exit);
            const reopened = yield* makeAsyncRotatingFileSink(rotation).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.exit,
            );
            if (Exit.isFailure(reopened)) return yield* new TraceMaintenanceError({});
            sink = reopened.value;
            paused = false;
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
            return result.value;
          }),
        ),
      )
      .pipe(Effect.withTracerEnabled(false));
  const logger = Logger.make((record) => {
    if (!paused) buffer.push(formatter.log(record));
  });
  return { logger, withMaintenance };
});
