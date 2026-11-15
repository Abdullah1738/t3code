import {
  AnalyticsError,
  AnalyticsEvent,
  AnalyticsIngestInput,
  AnalyticsReadInput,
  KanbanOwnerAsk,
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
import { makeReadPager } from "./readPages.ts";
import { sampleMix } from "./samples.ts";
import * as BoardsDatabase from "../persistence/BoardsDatabase.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { askKind, askLatencyRollup, type AskTimingRow } from "./askLatency.ts";
import {
  accumulate,
  boundedLines,
  finishRollup,
  makeAccumulator,
  type AnalyticsRollup,
} from "./rollup.ts";

const readAskKindFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    KanbanOwnerAsk.mapFields(
      ({ kind, options, multi, draft, action, change, changes, respond }) => ({
        kind,
        options,
        multi,
        draft,
        action,
        change,
        changes,
        respond,
      }),
    ),
  ),
);

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
      "invalid-cursor",
    ]),
  },
) {}

interface PendingEvent {
  readonly day: string;
  readonly line: string;
  readonly event: AnalyticsEvent;
  readonly bytes: number;
  attempts: number;
}

type DropReason = "capacity" | "retention" | "retry-limit" | "shutdown";

export class Analytics extends Context.Service<
  Analytics,
  {
    readonly record: (event: AnalyticsEvent) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void, AnalyticsError>;
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
  const boards = yield* Effect.serviceOption(BoardsDatabase.BoardsDatabase);
  const options = boundedOptions(input);
  const directory = path.join(config.logsDir, "analytics");
  const disk = yield* Semaphore.make(1);
  const readPager = makeReadPager();
  const wakeups = yield* Queue.dropping<void, Cause.Done>(1);
  const retries = yield* Queue.dropping<void, Cause.Done>(1);
  const encoder = new TextEncoder();
  let pending: PendingEvent[] = [];
  let accepting = true;
  let lastMaintenanceDay: string | undefined;
  let retryAt = 0;
  const dirtyDays = new Set<string>();
  // Only recently read views are resident. Each owns bounded per-kind samples, never the day log.
  const views = new Map<
    string,
    {
      day: string;
      filter: AnalyticsReadInput | undefined;
      accumulator: ReturnType<typeof makeAccumulator>;
      samples: ReturnType<typeof sampleMix>;
      signature: string;
    }
  >();
  const matches = (event: AnalyticsEvent, filter?: AnalyticsReadInput) =>
    (filter?.boardId === undefined || event.kind !== "performance.long-task") &&
    (filter?.kind === undefined || filter.kind === event.kind) &&
    (filter?.boardId === undefined || filter.boardId === event.boardId) &&
    (filter?.cardId === undefined || filter.cardId === event.cardId) &&
    (filter?.cardNumber === undefined ||
      filter.cardNumber === event.cardNumber ||
      filter.cardNumber === event.callerCardNumber ||
      filter.cardNumber === event.props?.cardNumber) &&
    (filter?.tool === undefined || filter.tool === event.tool) &&
    (filter?.outcome === undefined || filter.outcome === event.outcome) &&
    (filter?.responseDelivery === undefined || filter.responseDelivery === event.responseDelivery);
  const viewKey = (day: string, filter?: AnalyticsReadInput) =>
    JSON.stringify([
      day,
      filter?.kind,
      filter?.boardId,
      filter?.cardId,
      filter?.cardNumber,
      filter?.tool,
      filter?.outcome,
      filter?.responseDelivery,
    ]);
  const invalidate = (day: string) => {
    for (const [key, view] of views) if (view.day === day) views.delete(key);
  };
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

  const signature = Effect.fn("Analytics.signature")(function* (
    day: string,
    files: readonly string[],
  ) {
    const rows: string[] = [];
    for (const file of files.toSorted()) {
      if (LOG_FILE.exec(file)?.[1] !== day) continue;
      const info = yield* fileSystem.stat(path.join(directory, file));
      rows.push(
        `${file}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`,
      );
    }
    return rows.join("|");
  });

  const scanDay = Effect.fn("Analytics.scanDay")(function* (
    day: string,
    files: readonly string[],
    filter?: AnalyticsReadInput,
  ) {
    const accumulator = makeAccumulator();
    const samples = sampleMix(500, filter?.kind);
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
        accumulator.invalidLines++;
        return;
      }
      if (!matches(event, filter)) return;
      accumulate(accumulator, event);
      samples.add(event);
    });

    for (const { file } of selected) {
      const lines = boundedLines(options.maxEventBytes);
      yield* fileSystem.stream(path.join(directory, file), { chunkSize: 16_384 }).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Effect.forEach(lines.push(chunk), consume, { discard: true })),
      );
      yield* Effect.forEach(lines.finish(), consume, { discard: true });
    }
    return {
      accumulator,
      samples,
    };
  });

  const getView = Effect.fn("Analytics.getView")(function* (
    day: string,
    files: readonly string[],
    filter?: AnalyticsReadInput,
  ) {
    const key = viewKey(day, filter);
    const fingerprint = yield* signature(day, files);
    if ([...views.values()].some((view) => view.day === day && view.signature !== fingerprint))
      invalidate(day);
    const cached = views.get(key);
    if (cached?.signature === fingerprint) return cached;
    const scan = yield* scanDay(day, files, filter);
    const view = {
      day,
      filter,
      accumulator: scan.accumulator,
      samples: scan.samples,
      signature: fingerprint,
    };
    // FIFO bounds cardinality across days and arbitrary filter combinations.
    if (views.size >= 16) views.delete(views.keys().next().value!);
    views.set(key, view);
    return view;
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
        invalidate(day);
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
      if (refresh) {
        const view = yield* getView(day, retained);
        yield* persistRollup(
          finishRollup(view.accumulator, day, DateTime.formatIso(yield* DateTime.now)),
        );
      }
    }
    lastMaintenanceDay = today;
  });

  const rotate = Effect.fn("Analytics.rotate")(function* (day: string) {
    invalidate(day);
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

  const unterminatedTail = Effect.fn("Analytics.unterminatedTail")(function* (
    target: string,
    size: number,
  ) {
    if (size === 0) return false;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(target, { flag: "r" });
        yield* file.seek(BigInt(size - 1), "start");
        const last = new Uint8Array(1);
        return (yield* file.read(last)) === 1 && last[0] !== 10;
      }),
    );
  });

  const drain = Effect.fn("Analytics.drain")(function* (force = false) {
    if (pending.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    if (!force && now < retryAt) return;
    const cutoff = oldestDay(now, options.retentionDays);
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
        const files = yield* listFiles();
        yield* getView(first.day, files);
        const target = path.join(directory, `${first.day}.ndjson`);
        let size = yield* fileSystem.stat(target).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(0),
          ),
        );
        let separate = yield* unterminatedTail(target, size);
        if (size + (separate ? 1 : 0) + first.bytes > options.maxFileBytes) {
          yield* rotate(first.day);
          size = 0;
          separate = false;
        }
        if (separate) {
          // Disk is authoritative after restart or an ambiguous append. One byte is enough
          // to keep a torn suffix from swallowing the next complete event.
          yield* fileSystem.writeFileString(target, "\n", { flag: "a", mode: 0o600 });
          size++;
        }
        bytes = 0;
        let count = 0;
        for (const entry of attempted) {
          if (size + bytes + entry.bytes > options.maxFileBytes) break;
          bytes += entry.bytes;
          count++;
        }
        attempted = attempted.slice(0, count);
        // Rotation or recovery may have invalidated the old retained-event view.
        yield* getView(first.day, yield* listFiles());
        appending = true;
        yield* fileSystem.writeFileString(target, attempted.map((entry) => entry.line).join(""), {
          flag: "a",
          mode: 0o600,
        });
        // Update only after confirmed append; an ambiguous append invalidates and is rebuilt from disk.
        const fingerprint = yield* signature(first.day, yield* listFiles());
        for (const view of views.values()) {
          if (view.day !== first.day) continue;
          for (const entry of attempted) {
            if (!matches(entry.event, view.filter)) continue;
            accumulate(view.accumulator, entry.event);
            view.samples.add(entry.event);
          }
          view.signature = fingerprint;
        }
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
              invalidate(first.day);
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
    return { day, line, bytes, event, attempts: 0 };
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
      // Older clients still emit this after a send. The stored server answer is authoritative.
      if (
        event.kind === "ask.answered" ||
        event.kind === "ask.seen" ||
        event.kind === "ask.notified"
      )
        continue;
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

  const readAskRows = Effect.fn("Analytics.readAskRows")(function* (day: string) {
    if (Option.isNone(boards)) return undefined;
    yield* boards.value.ready;
    const sql = boards.value.sql;
    const rows = yield* sql<
      Omit<AskTimingRow, "kind"> & {
        cardNumber: number;
        kind: string | null;
        askJson: string | null;
      }
    >`
      SELECT c.board_id AS boardId, c.id AS cardId, c.number AS cardNumber,
        json_extract(a.value, '$.id') AS askId,
        json_extract(a.value, '$.at') AS createdAt,
        json_extract(a.value, '$.closedAt') AS closedAt,
        CASE WHEN json_extract(a.value, '$.answer.by._tag') = 'owner'
          AND json_extract(a.value, '$.answer.verdict') != 'dropped'
          THEN json_extract(a.value, '$.answer.at') END AS answeredAt,
        json_extract(a.value, '$.blocking') AS blocking,
        json_extract(a.value, '$.timing.kind') AS kind,
        CASE WHEN json_extract(a.value, '$.timing.kind') IS NULL THEN a.value END AS askJson,
        (SELECT MIN(value) FROM json_each(a.value, '$.timing.notified')) AS notifiedAt,
        (SELECT MIN(value) FROM json_each(a.value, '$.timing.firstSeen')) AS firstSeenAt
      FROM ardud_kanban_cards c, json_each(c.json, '$.asks') a
      WHERE json_extract(a.value, '$.at') <= ${`${day}T23:59:59.999Z`}
        AND COALESCE(json_extract(a.value, '$.to'), 'owner') != 'evaluator'
    `.pipe(NodeSqliteClient.readOnly);
    return rows.map(({ askJson, ...row }) => {
      // Asks created before timing metadata still carry their response shape.
      const fields = row.kind === null ? readAskKindFields(askJson) : Option.none();
      return {
        ...row,
        blocking: Boolean(row.blocking),
        kind: row.kind ?? (Option.isSome(fields) ? askKind(fields.value) : "unknown"),
      };
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
    if (input.cursor !== undefined) {
      const page = readPager.resume(input);
      if (page) return page;
      return yield* new AnalyticsError({
        operation: "read",
        cause: new AnalyticsValidationError({ reason: "invalid-cursor" }),
      });
    }
    const storedRows = yield* readAskRows(input.day).pipe(
      Effect.mapError((cause) => new AnalyticsError({ operation: "read", cause })),
    );
    return yield* disk
      .withPermit(
        Effect.gen(function* () {
          yield* drain(true);
          yield* maintain();
          const files = yield* listFiles();
          const view = yield* getView(input.day, files, input);
          const full = yield* getView(input.day, files);
          const generatedAt = DateTime.formatIso(yield* DateTime.now);
          const withAskLatency = (rollup: AnalyticsRollup, filter?: AnalyticsReadInput) =>
            storedRows === undefined
              ? rollup
              : {
                  ...rollup,
                  askLatency: askLatencyRollup(
                    storedRows.filter(
                      (row) =>
                        (filter?.boardId === undefined || row.boardId === filter.boardId) &&
                        (filter?.cardId === undefined || row.cardId === filter.cardId) &&
                        (filter?.cardNumber === undefined || row.cardNumber === filter.cardNumber),
                    ),
                    input.day,
                    generatedAt,
                  ),
                };
          if (full.signature)
            yield* persistRollup(
              withAskLatency(finishRollup(full.accumulator, input.day, generatedAt)),
            );
          return readPager.read(
            input,
            withAskLatency(finishRollup(view.accumulator, input.day, generatedAt), input),
            view.samples.entries().map((sample) => sample.event),
          );
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

  const flush = disk
    .withPermit(drain(true))
    .pipe(Effect.mapError((cause) => new AnalyticsError({ operation: "write", cause })));
  return Analytics.of({ record, flush, ingest, read });
});

export const layerWith = (options: Partial<AnalyticsOptions>) =>
  Layer.effect(Analytics, make(options));
export const layer = layerWith({});
