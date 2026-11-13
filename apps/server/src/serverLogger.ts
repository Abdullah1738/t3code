import { RotatingFileSink } from "@t3tools/shared/logging";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SharedObservability from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redactable from "effect/Redactable";
import * as References from "effect/References";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpLogger from "effect/observability/OtlpLogger";

import * as ServerConfig from "./config.ts";

/**
 * `Logger.consolePretty` prints message objects with `util.inspect`, which
 * collapses a `Cause` passed as a field (`{ cause }`) to
 * `{ failures: [ [Object] ] }`. Render those fields with `Cause.pretty`, the
 * same text a `Cause` passed as its own log argument already gets.
 */
const consolePretty = (): Logger.Logger<unknown, void> => {
  const pretty = Logger.consolePretty();
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
    }),
  );
};

function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A message with its own redaction hook already decides how it prints.
  if (Redactable.isRedactable(value)) return value;
  // Copy descriptors rather than entries so getters are never invoked and
  // symbol keys survive the copy.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype, descriptors) : value;
}

export const layer = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const hostName = yield* HostProcess.Hostname;
  const layerMinimumLogLevel = Layer.succeed(References.MinimumLogLevel, config.logLevel);

  // Desktop buffers stdout until a backend failure. Keep sparse lock diagnostics
  // independently of that buffer and the high-volume trace rotation.
  const boardLockSink = yield* Effect.try(
    () =>
      new RotatingFileSink({
        filePath: `${config.logsDir}/board-locks.ndjson`,
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 4,
      }),
  ).pipe(
    Effect.catch(() =>
      Effect.logWarning("board lock diagnostic log unavailable").pipe(Effect.as(undefined)),
    ),
  );
  const boardLockLogger = Logger.make(({ fiber, message }) => {
    if (fiber.getRef(References.CurrentLogAnnotations)["board.waiting_on"] === undefined) return;
    const line = Array.isArray(message) ? message[0] : message;
    try {
      if (typeof line === "string") boardLockSink?.write(`${line}\n`);
    } catch {
      // Console/OTLP still receive the record. A failed diagnostic sink must
      // never replace a board write's saved/retry result with a logger defect.
    }
  });

  const logs = config.otlpLogsExport;
  const otlpLogger =
    config.otlpLogsUrl === undefined
      ? undefined
      : OtlpLogger.make({
          url: config.otlpLogsUrl,
          exportInterval: `${logs.exportIntervalMs} millis`,
          headers: logs.headers,
          resource: ServerConfig.otlpResource(config, hostName),
        });

  // `Logger.layer` writes the whole logger set rather than adding to it, so
  // every logger the server wants has to be named in this one call.
  // `Logger.tracerLogger` reaches a collector by attaching each message to the
  // active span as a span event, which covers only messages logged inside a
  // recorded span and files them under traces. The OTLP logger carries the same
  // messages as log records stamped with their trace and span ids, so it is a
  // superset: keeping both would export every in-span message twice.
  const layerLogger = Logger.layer(
    otlpLogger === undefined
      ? [consolePretty(), Logger.tracerLogger, boardLockLogger]
      : [consolePretty(), otlpLogger, boardLockLogger],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(OtlpExporter.layerFlusher),
    Layer.provide(SharedObservability.layerOtlpSerialization(logs.protocol)),
  );

  return Layer.mergeAll(layerLogger, layerMinimumLogLevel);
}).pipe(Layer.unwrap);
