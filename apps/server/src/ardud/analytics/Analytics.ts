import {
  AnalyticsError,
  AnalyticsEvent,
  AnalyticsIngestInput,
  AnalyticsReadInput,
  type AnalyticsReadResult,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  accumulate,
  boundedLines,
  finishRollup,
  makeAccumulator,
  type AnalyticsRollup,
} from "./rollup.ts";

export interface AnalyticsOptions {
  readonly queueCapacity: number;
  readonly maxEventBytes: number;
  readonly maxBatchBytes: number;
  readonly maxFileBytes: number;
  /** Includes the active file. */
  readonly maxSegmentsPerDay: number;
  readonly retentionDays: number;
}

const DEFAULTS: AnalyticsOptions = {
  queueCapacity: 4_096,
  maxEventBytes: 8_192,
  maxBatchBytes: 256 * 1_024,
  maxFileBytes: 50 * 1_024 * 1_024,
  maxSegmentsPerDay: 4,
  retentionDays: 30,
};
const DAY_MS = 86_400_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const RETRY_DELAY_MS = 5_000;
const MAX_WRITE_ATTEMPTS = 3;
const DROP_WARNING_INTERVAL_MS = 60_000;
const droppedEvents = Metric.counter("t3_analytics_dropped_events_total");
const ambiguousAppends = Metric.counter("t3_analytics_ambiguous_appends_total");
const LOG_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?\.ndjson$/;
const OWNED_FILE =
  /^(\d{4}-\d{2}-\d{2})(?:\.[1-9]\d*)?\.ndjson$|^rollup-(\d{4}-\d{2}-\d{2})\.json(?:\.tmp)?$/;
const EventJson = Schema.fromJsonString(AnalyticsEvent);
const RollupJson = Schema.fromJsonString(Schema.Unknown);
const decodeEvent = Schema.decodeUnknownEffect(AnalyticsEvent, { onExcessProperty: "error" });
const decodeLine = Schema.decodeUnknownEffect(EventJson, { onExcessProperty: "error" });
const decodeIngest = Schema.decodeUnknownEffect(AnalyticsIngestInput, {
  onExcessProperty: "error",
});
const decodeRead = Schema.decodeUnknownEffect(AnalyticsReadInput, { onExcessProperty: "error" });
const encodeEvent = Schema.encodeEffect(EventJson);
const encodeRollup = Schema.encodeEffect(RollupJson);

class AnalyticsValidationError extends Schema.TaggedError<AnalyticsValidationError>()(
  "AnalyticsValidationError",
  {
    reason: Schema.Literals([
      "timestamp-window",
      "event-size",
      "batch-size",
      "queue-full",
      "invalid-day",
    ]),
  },
) {}

interface PendingEvent {
  readonly day: string;
  readonly line: string;
  readonly bytes: number;
  attempts: number;
}

type DropReason = "capacity" | "retention" | "retry-limit" | "shutdown";

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly record: (event: AnalyticsEvent) => Effect.Effect<void>;
    readonly ingest: (input: {
      readonly events: readonly AnalyticsEvent[];
    }) => Effect.Effect<void, AnalyticsError>;
    readonly read: (
      input: AnalyticsReadInput,
    ) => Effect.Effect<AnalyticsReadResult, AnalyticsError>;
  }
>()("t3/ardud/analytics/Analytics") {}

function boundedOptions(input: Partial<AnalyticsOptions>): AnalyticsOptions {
  const positive = (value: number | undefined, maximum: number) =>
    value !== undefined && Number.isFinite(value) && value >= 1
      ? Math.min(Math.floor(value), maximum)
      : maximum;
  return {
    queueCapacity: positive(input.queueCapacity, DEFAULTS.queueCapacity),
    maxEventBytes: positive(input.maxEventBytes, DEFAULTS.maxEventBytes),
    maxBatchBytes: positive(input.maxBatchBytes, DEFAULTS.maxBatchBytes),
    maxFileBytes: positive(input.maxFileBytes, DEFAULTS.maxFileBytes),
    maxSegmentsPerDay: positive(input.maxSegmentsPerDay, DEFAULTS.maxSegmentsPerDay),
    retentionDays: positive(input.retentionDays, DEFAULTS.retentionDays),
  };
}

function dayOf(time: number): string {
  return DateTime.formatIsoDateUtc(DateTime.makeUnsafe(time));
}

function oldestDay(now: number, retentionDays: number): string {
  return dayOf(now - (retentionDays - 1) * DAY_MS);
}

const make = Effect.fnUntraced(function* (input: Partial<AnalyticsOptions>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const options = boundedOptions(input);
  const directory = path.join(config.logsDir, "analytics");
  const disk = yield* Semaphore.make(1);
  const wakeups = yield* Queue.dropping<void, Cause.Done>(1);
  const retries = yield* Queue.dropping<void, Cause.Done>(1);
  const encoder = new TextEncoder();
  let pending: PendingEvent[] = [];
  let accepting = true;
  let lastMaintenanceDay: string | undefined;
  let retryAt = 0;
  const incompleteDays = new Set<string>();
  const dirtyDays = new Set<string>();
  const dropWarnings = new Map<DropReason, { count: number; nextAt: number }>();

  // Drop accounting also runs on request paths, where per-event spans would be too frequent.
  const countDropped = Effect.fnUntraced(function* (count: number, reason: DropReason) {
    if (count > 0) {
      yield* Metric.update(Metric.withAttributes(droppedEvents, { reason }), count);
      const now = yield* Clock.currentTimeMillis;
      const warning = dropWarnings.get(reason) ?? { count: 0, nextAt: now };
      warning.count += count;
      dropWarnings.set(reason, warning);
      if (now >= warning.nextAt) {
        const accumulated = warning.count;
        warning.count = 0;
        warning.nextAt = now + DROP_WARNING_INTERVAL_MS;
        yield* Effect.logWarning("Analytics events dropped.", { count: accumulated, reason });
      }
    }
  });

  const listFiles = Effect.fn("Analytics.listFiles")(function* () {
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
    return yield* fileSystem.readDirectory(directory);
  });

  const scanDay = Effect.fn("Analytics.scanDay")(function* (
    day: string,
    files: readonly string[],
    filter?: AnalyticsReadInput,
  ) {
    const full = makeAccumulator();
    const filtered =
      filter?.kind !== undefined ||
      filter?.boardId !== undefined ||
      filter?.tool !== undefined ||
      filter?.outcome !== undefined
        ? makeAccumulator()
        : full;
    const samples: AnalyticsEvent[] = [];
    const limit = filter?.limit ?? 100;
    let cursor = 0;
    const selected = files
      .flatMap((file) => {
        const match = LOG_FILE.exec(file);
        return match?.[1] === day ? [{ file, segment: Number(match[2] ?? 0) }] : [];
      })
      .sort((a, b) => b.segment - a.segment);

    // Decoding every line already sits inside the scan span; per-line spans swamp the log.
    const consume = Effect.fnUntraced(function* (line: string | null) {
      if (line === "") return;
      const event =
        line === null
          ? undefined
          : yield* decodeLine(line).pipe(Effect.orElseSucceed(() => undefined));
      if (!event || dayOf(DateTime.toEpochMillis(DateTime.makeUnsafe(event.ts))) !== day) {
        full.invalidLines++;
        if (filtered !== full) filtered.invalidLines++;
        return;
      }
      accumulate(full, event);
      if (
        (filter?.kind !== undefined && filter.kind !== event.kind) ||
        (filter?.boardId !== undefined && filter.boardId !== event.boardId) ||
        (filter?.tool !== undefined && filter.tool !== event.tool) ||
        (filter?.outcome !== undefined && filter.outcome !== event.outcome)
      )
        return;
      if (filtered !== full) accumulate(filtered, event);
      if (samples.length < limit) samples.push(event);
      else {
        samples[cursor] = event;
        cursor = (cursor + 1) % limit;
      }
    });

    for (const { file } of selected) {
      const lines = boundedLines(options.maxEventBytes);
      yield* fileSystem.stream(path.join(directory, file), { chunkSize: 16_384 }).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.forEach(lines.push(chunk), consume, { discard: true })),
      );
      yield* Effect.forEach(lines.finish(), consume, { discard: true });
    }
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      full: finishRollup(full, day, generatedAt),
      result: {
        rollup: finishRollup(filtered, day, generatedAt),
        samples: [...samples.slice(cursor), ...samples.slice(0, cursor)].toReversed(),
      },
      hasFiles: selected.length > 0,
    };
  });

  const persistRollup = Effect.fn("Analytics.persistRollup")(function* (rollup: AnalyticsRollup) {
    const target = path.join(directory, `rollup-${rollup.day}.json`);
    const temporary = `${target}.tmp`;
    const json = yield* encodeRollup(rollup);
    yield* fileSystem.writeFileString(temporary, `${json}\n`, { mode: 0o600 });
    yield* fileSystem.rename(temporary, target);
    dirtyDays.delete(rollup.day);
  });

  const maintain = Effect.fn("Analytics.maintain")(function* (flushCurrent = false) {
    const now = yield* Clock.currentTimeMillis;
    const today = dayOf(now);
    if (!flushCurrent && lastMaintenanceDay === today) return;
    const cutoff = oldestDay(now, options.retentionDays);
    const files = yield* listFiles();
    const retained: string[] = [];
    for (const file of files) {
      const owned = OWNED_FILE.exec(file);
      const day = owned?.[1] ?? owned?.[2];
      if (!day) continue;
      const segment = LOG_FILE.exec(file)?.[2];
      if (
        day < cutoff ||
        day > dayOf(now + FUTURE_SKEW_MS) ||
        (segment !== undefined && Number(segment) >= options.maxSegmentsPerDay) ||
        file.endsWith(".tmp")
      ) {
        yield* fileSystem.remove(path.join(directory, file), { force: true });
        if (day < cutoff) dirtyDays.delete(day);
      } else retained.push(file);
    }
    const days = new Set(
      retained.flatMap((file) => {
        const match = LOG_FILE.exec(file);
        return match?.[1] ? [match[1]] : [];
      }),
    );
    for (const day of days) {
      if (day >= today && !flushCurrent) continue;
      let refresh = dirtyDays.has(day) || !retained.includes(`rollup-${day}.json`);
      if (!refresh) {
        const rollupInfo = yield* fileSystem.stat(path.join(directory, `rollup-${day}.json`));
        const rollupTime = Option.map(rollupInfo.mtime, (date) => date.getTime());
        for (const file of retained) {
          if (LOG_FILE.exec(file)?.[1] !== day) continue;
          const logInfo = yield* fileSystem.stat(path.join(directory, file));
          if (
            Option.isNone(rollupTime) ||
            Option.isNone(logInfo.mtime) ||
            logInfo.mtime.value.getTime() >= rollupTime.value
          ) {
            refresh = true;
            break;
          }
        }
      }
      if (refresh) yield* persistRollup((yield* scanDay(day, retained)).full);
    }
    lastMaintenanceDay = today;
  });

  const rotate = Effect.fn("Analytics.rotate")(function* (day: string) {
    const active = path.join(directory, `${day}.ndjson`);
    if (options.maxSegmentsPerDay === 1) {
      yield* fileSystem.remove(active, { force: true });
      return;
    }
    yield* fileSystem.remove(
      path.join(directory, `${day}.${options.maxSegmentsPerDay - 1}.ndjson`),
      { force: true },
    );
    for (let segment = options.maxSegmentsPerDay - 2; segment >= 0; segment--) {
      const source = segment === 0 ? active : path.join(directory, `${day}.${segment}.ndjson`);
      if (yield* fileSystem.exists(source)) {
        yield* fileSystem.rename(source, path.join(directory, `${day}.${segment + 1}.ndjson`));
      }
    }
  });

  const drain = Effect.fn("Analytics.drain")(function* (force = false) {
    if (pending.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    if (!force && now < retryAt) return;
    const cutoff = oldestDay(now, options.retentionDays);
    for (const day of incompleteDays) if (day < cutoff) incompleteDays.delete(day);
    let remaining = pending.length;
    while (remaining > 0 && pending.length > 0) {
      const first = pending[0]!;
      if (first.day < cutoff) {
        let expired = 0;
        while (expired < remaining && pending[expired]!.day < cutoff) expired++;
        pending.splice(0, expired);
        remaining -= expired;
        yield* countDropped(expired, "retention");
        continue;
      }
      let bytes = 0;
      let attempted: PendingEvent[] = [];
      for (const next of pending.slice(0, remaining)) {
        if (next.day !== first.day || bytes + next.bytes > options.maxFileBytes) break;
        attempted.push(next);
        bytes += next.bytes;
      }
      let appending = false;
      yield* Effect.gen(function* () {
        yield* maintain();
        const target = path.join(directory, `${first.day}.ndjson`);
        let size = yield* fileSystem.stat(target).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(0),
          ),
        );
        const separatorBytes = incompleteDays.has(first.day) && size > 0 ? 1 : 0;
        if (size + separatorBytes + first.bytes > options.maxFileBytes) {
          yield* rotate(first.day);
          size = 0;
        }
        if (incompleteDays.has(first.day)) {
          // An append can write a prefix before failing. Replay is at least once;
          // a separator prevents a torn suffix from swallowing the next complete event.
          if (size > 0) {
            yield* fileSystem.writeFileString(target, "\n", { flag: "a", mode: 0o600 });
            size++;
          }
          incompleteDays.delete(first.day);
        }
        bytes = 0;
        let count = 0;
        for (const entry of attempted) {
          if (size + bytes + entry.bytes > options.maxFileBytes) break;
          bytes += entry.bytes;
          count++;
        }
        attempted = attempted.slice(0, count);
        appending = true;
        yield* fileSystem.writeFileString(target, attempted.map((entry) => entry.line).join(""), {
          flag: "a",
          mode: 0o600,
        });
        // Held entries remain in pending (and consume capacity) until append succeeds.
        pending.splice(0, attempted.length);
        appending = false;
        remaining -= attempted.length;
        retryAt = 0;
        dirtyDays.add(first.day);
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            if (appending) {
              incompleteDays.add(first.day);
              yield* Metric.update(ambiguousAppends, 1);
            }
            for (const entry of attempted) entry.attempts++;
            const exhausted = attempted.filter((entry) => entry.attempts >= MAX_WRITE_ATTEMPTS);
            if (exhausted.length > 0) {
              const dropped = new Set(exhausted);
              pending = pending.filter((entry) => !dropped.has(entry));
              yield* countDropped(exhausted.length, "retry-limit");
            }
            retryAt = (yield* Clock.currentTimeMillis) + RETRY_DELAY_MS;
            if (accepting && pending.length > 0) yield* Queue.offer(retries, undefined);
          }),
        ),
      );
    }
  });

  // Request paths only touch bounded memory and wake the writer; they never acquire its disk lock.
  const prepare = Effect.fnUntraced(function* (raw: AnalyticsEvent) {
    const event = yield* decodeEvent(raw);
    const now = yield* Clock.currentTimeMillis;
    const time = DateTime.toEpochMillis(DateTime.makeUnsafe(event.ts));
    const day = dayOf(time);
    if (day < oldestDay(now, options.retentionDays) || time > now + FUTURE_SKEW_MS) {
      return yield* new AnalyticsValidationError({ reason: "timestamp-window" });
    }
    const line = `${yield* encodeEvent(event)}\n`;
    const bytes = encoder.encode(line).byteLength;
    if (bytes > options.maxEventBytes || bytes > options.maxFileBytes) {
      return yield* new AnalyticsValidationError({ reason: "event-size" });
    }
    return { day, line, bytes, attempts: 0 };
  });

  const record: Analytics["Service"]["record"] = Effect.fnUntraced(function* (event) {
    const entry = yield* prepare(event).pipe(Effect.orElseSucceed(() => undefined));
    if (!entry) return;
    const accepted = yield* Effect.sync(() => {
      if (!accepting || pending.length >= options.queueCapacity) return false;
      pending.push(entry);
      Queue.offerUnsafe(wakeups, undefined);
      return true;
    });
    if (!accepted) yield* countDropped(1, "capacity");
  });

  const ingest: Analytics["Service"]["ingest"] = Effect.fn("Analytics.ingest")(function* (raw) {
    const input = yield* decodeIngest(raw).pipe(
      Effect.mapError((cause) => new AnalyticsError({ operation: "ingest", cause })),
    );
    const batch: PendingEvent[] = [];
    let bytes = 0;
    for (const event of input.events) {
      const entry = yield* prepare(event).pipe(
        Effect.mapError((cause) => new AnalyticsError({ operation: "ingest", cause })),
      );
      bytes += entry.bytes;
      if (bytes > options.maxBatchBytes) {
        return yield* new AnalyticsError({
          operation: "ingest",
          cause: new AnalyticsValidationError({ reason: "batch-size" }),
        });
      }
      batch.push(entry);
    }
    const accepted = yield* Effect.sync(() => {
      if (!accepting || pending.length + batch.length > options.queueCapacity) return false;
      pending.push(...batch);
      Queue.offerUnsafe(wakeups, undefined);
      return true;
    });
    if (!accepted)
      return yield* new AnalyticsError({
        operation: "ingest",
        cause: new AnalyticsValidationError({ reason: "queue-full" }),
      });
  });

  const read: Analytics["Service"]["read"] = Effect.fn("Analytics.read")(function* (raw) {
    const input = yield* decodeRead(raw).pipe(
      Effect.mapError((cause) => new AnalyticsError({ operation: "read", cause })),
    );
    const date = DateTime.make(`${input.day}T00:00:00.000Z`);
    if (Option.isNone(date) || DateTime.formatIsoDateUtc(date.value) !== input.day) {
      return yield* new AnalyticsError({
        operation: "read",
        cause: new AnalyticsValidationError({ reason: "invalid-day" }),
      });
    }
    return yield* disk
      .withPermit(
        Effect.gen(function* () {
          yield* drain(true);
          yield* maintain();
          const scan = yield* scanDay(input.day, yield* listFiles(), input);
          if (scan.hasFiles) yield* persistRollup(scan.full);
          return scan.result;
        }),
      )
      .pipe(Effect.mapError((cause) => new AnalyticsError({ operation: "read", cause })));
  });

  // Recording storage failures through the server logger could recursively enqueue more events.
  const writer = yield* Stream.fromQueue(wakeups).pipe(
    Stream.runForEach(() => disk.withPermit(drain()).pipe(Effect.ignore)),
    Effect.forkScoped,
  );
  const retryWorker = yield* Stream.fromQueue(retries).pipe(
    Stream.runForEach(() =>
      Effect.sleep(RETRY_DELAY_MS).pipe(
        Effect.andThen(disk.withPermit(drain()).pipe(Effect.ignore)),
      ),
    ),
    Effect.forkScoped,
  );
  yield* disk.withPermit(maintain()).pipe(Effect.ignore, Effect.forkScoped);
  const maintenanceWorker = yield* Effect.forever(
    Effect.sleep("1 hour").pipe(
      Effect.andThen(
        disk
          .withPermit(
            Effect.gen(function* () {
              yield* drain();
              yield* maintain();
            }),
          )
          .pipe(Effect.ignore),
      ),
    ),
  ).pipe(Effect.forkScoped);

  // Registered after the worker so scope closure drains accepted entries before interrupting it.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      accepting = false;
      yield* Fiber.interrupt(retryWorker);
      yield* Fiber.interrupt(maintenanceWorker);
      yield* Queue.end(wakeups);
      yield* Effect.gen(function* () {
        yield* Fiber.join(writer);
        yield* disk.withPermit(
          Effect.gen(function* () {
            yield* drain(true);
            yield* maintain(true);
          }),
        );
      }).pipe(Effect.interruptible, Effect.timeout("2 seconds"), Effect.ignore);
      yield* Fiber.interrupt(writer);
      yield* countDropped(pending.length, "shutdown");
      pending = [];
      for (const [reason, warning] of dropWarnings) {
        if (warning.count > 0)
          yield* Effect.logWarning("Analytics events dropped.", { count: warning.count, reason });
      }
      dropWarnings.clear();
    }),
  );

  return Analytics.of({ record, ingest, read });
});

export const layerWith = (options: Partial<AnalyticsOptions>) =>
  Layer.effect(Analytics, make(options));
export const layer = layerWith({});
