import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Tracer from "effect/Tracer";
import { isSqlError, isSqlErrorReason } from "effect/sql/SqlError";
import { OtlpResource, OtlpTracer, OtlpSerialization } from "effect/observability";

import { makeSqlDiagnostics, normalizeSql, sqlFingerprint } from "./sqlDiagnostics.ts";

import { makeAsyncRotatingFileSink } from "./logging.ts";

export const OtlpProtocol = Schema.Literals(["http/json", "http/protobuf"]);
export type OtlpProtocol = typeof OtlpProtocol.Type;
export const layerOtlpSerialization = (protocol: OtlpProtocol) =>
  protocol === "http/protobuf" ? OtlpSerialization.layerProtobuf : OtlpSerialization.layerJson;

export interface SignalExport {
  readonly protocol: OtlpProtocol;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly exportIntervalMs: number;
}

export const DEFAULT_SIGNAL_EXPORT: SignalExport = {
  protocol: "http/json",
  headers: undefined,
  exportIntervalMs: 10_000,
};

const FLUSH_BUFFER_THRESHOLD = 256;

export type TraceAttributes = Readonly<Record<string, unknown>>;

export interface TraceRecordEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TraceRecordLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

interface BaseTraceRecord {
  readonly name: string;
  readonly kind: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<TraceRecordEvent>;
  readonly links: ReadonlyArray<TraceRecordLink>;
}

export interface EffectTraceRecord extends BaseTraceRecord {
  readonly type: "effect-span";
  readonly exit:
    | {
        readonly _tag: "Success";
      }
    | {
        readonly _tag: "Interrupted";
        readonly cause: string;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: string;
      };
}

export interface OtlpTraceRecord extends BaseTraceRecord {
  readonly type: "otlp-span";
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<{
    readonly name?: string;
    readonly version?: string;
    readonly attributes: Readonly<Record<string, unknown>>;
  }>;
  readonly status?:
    | {
        readonly code?: string;
        readonly message?: string;
      }
    | undefined;
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

// Summaries count only omitted successful children. Times are Unix milliseconds; durations are milliseconds.
export const SpanSummaryRecord = Schema.Struct({
  type: Schema.Literal("span-summary"),
  windowStart: Schema.Finite,
  windowEnd: Schema.Finite,
  spans: Schema.Record(
    Schema.String,
    Schema.Struct({ count: Schema.Int, totalMs: Schema.Finite, maxMs: Schema.Finite }),
  ),
});
export type SpanSummaryRecord = typeof SpanSummaryRecord.Type;
export const isSpanSummaryRecord = Schema.is(SpanSummaryRecord);

function keepFileSpan(record: TraceRecord, minDurationMs: number) {
  return (
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0 ||
    record.durationMs >= minDurationMs ||
    !record.parentSpanId ||
    (record.type === "effect-span"
      ? record.exit._tag !== "Success"
      : record.status?.code === "2" ||
        record.status?.message === "Interrupted" ||
        record.attributes["effect.fiber.interrupted"] === true) ||
    record.events.some((event) => {
      if (event.name === "sql.statement" || event.name === "sql.plan") return true;
      const level = event.attributes["effect.logLevel"];
      return (
        typeof level === "string" &&
        ["WARN", "WARNING", "ERROR", "FATAL"].includes(level.toUpperCase())
      );
    })
  );
}

function isStructuralTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value)
  );
}

export function errorTag(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      return isStructuralTag(error._tag) ? error._tag : "TaggedError";
    }
    if (error instanceof Error) {
      return isStructuralTag(error.name) ? error.name : "Error";
    }
  } catch {
    return "UnknownError";
  }
  return typeof error;
}

export function causeErrorTag(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    return errorTag(failure.value);
  }
  return cause.reasons[0]?._tag ?? "Empty";
}

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly compressBackups?: boolean;
  readonly maxTotalBytes?: number;
  readonly fileFilter?: { readonly minDurationMs: number };
  readonly onFlush?: (stats: TraceSinkFlushStats) => Effect.Effect<void>;
}

export interface TraceSinkFlushStats {
  readonly logicalWriteBytes: number;
  readonly count: number;
  readonly durationMs: number;
}

export class TraceMaintenanceError extends Schema.TaggedError<TraceMaintenanceError>()(
  "TraceMaintenanceError",
  {},
) {
  override get message() {
    return "Trace storage could not be drained for maintenance.";
  }
}
export type TraceMaintenance = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | TraceMaintenanceError, R>;
export class TraceStorageMaintenance extends Context.Service<
  TraceStorageMaintenance,
  { readonly withMaintenance: TraceMaintenance }
>()("@t3tools/shared/observability/TraceStorageMaintenance") {}
export const NoOpTraceStorageMaintenance: TraceStorageMaintenance["Service"] = {
  withMaintenance: (effect) => effect,
};

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  readonly capture?: () => (record: TraceRecord) => void;
  readonly withMaintenance?: TraceMaintenance;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface LocalFileTracerOptions extends TraceSinkOptions {
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
}

type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];
type OtlpSpanEvent = OtlpSpan["events"][number];
type OtlpSpanLink = OtlpSpan["links"][number];
type OtlpSpanStatus = OtlpSpan["status"];

interface SerializableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly status: Tracer.SpanStatus;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly events: ReadonlyArray<
    readonly [name: string, startTime: bigint, attributes: Record<string, unknown>]
  >;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markSeen(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  return false;
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return value.map((entry) => normalizeJsonValue(entry, seen));
  }
  if (value instanceof Map) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Object.fromEntries(
      Array.from(value.entries(), ([key, entryValue]) => [
        String(key),
        normalizeJsonValue(entryValue, seen),
      ]),
    );
  }
  if (value instanceof Set) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }
    return Array.from(value.values(), (entry) => normalizeJsonValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  if (markSeen(value, seen)) {
    return "[Circular]";
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeJsonValue(entryValue, seen)]),
  );
}

export function compactTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      entries.push([key, normalizeJsonValue(value)]);
    }
  }
  return Object.fromEntries(entries);
}

// Domain wrappers and transaction spans keep the original SQL failure as their cause.
// Inspect only error links, with a bounded walk; never serialize the original graph.
function hasSqlFailure(cause: Cause.Cause<unknown>): boolean {
  const pending: unknown[] = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    if (seen.size >= 64) return true;
    seen.add(value);
    try {
      if (isSqlError(value) || isSqlErrorReason(value)) return true;
      for (const key of ["cause", "reason", "error", "errors", "reasons", "defect"]) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property === undefined) continue;
        if (!("value" in property)) return true;
        const next: unknown = property.value;
        if (Array.isArray(next)) {
          if (next.length > 64) return true;
          pending.push(...next);
        } else pending.push(next);
      }
    } catch {
      return true;
    }
  }
  return false;
}

function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (ExitRuntime.isSuccess(exit)) {
    return { _tag: "Success" };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      _tag: "Interrupted",
      cause: Cause.pretty(exit.cause),
    };
  }
  return {
    _tag: "Failure",
    cause: Cause.pretty(exit.cause),
  };
}

const TRACE_ATTRIBUTE_MAX_LENGTH = 500;
const TRACE_ATTRIBUTE_TRUNCATED_LENGTH = 200;
const TRACE_ATTRIBUTE_TRUNCATION_SUFFIX = "…[truncated]";
const ALWAYS_TRUNCATED_TRACE_ATTRIBUTES: ReadonlySet<string> = new Set(["db.query.text"]);

function truncateNestedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= TRACE_ATTRIBUTE_MAX_LENGTH
      ? value
      : `${value.slice(0, TRACE_ATTRIBUTE_MAX_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
  }
  if (Array.isArray(value)) {
    const truncated = value.map(truncateNestedValue);
    return truncated.some((entry, index) => entry !== value[index]) ? truncated : value;
  }
  if (isPlainObject(value)) {
    let truncated: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = truncateNestedValue(entry);
      if (next === entry) continue;
      truncated ??= { ...value };
      truncated[key] = next;
    }
    return truncated ?? value;
  }
  return value;
}

/**
 * Returns a new record when anything was clamped; never mutates the input (the live span's
 * attributes are shared with other tracers).
 */
export function truncateTraceAttributes(attributes: TraceAttributes): TraceAttributes {
  let truncated: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" && ALWAYS_TRUNCATED_TRACE_ATTRIBUTES.has(key)) {
      if (value.length <= TRACE_ATTRIBUTE_TRUNCATED_LENGTH) continue;
      truncated ??= { ...attributes };
      truncated[key] =
        `${value.slice(0, TRACE_ATTRIBUTE_TRUNCATED_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
      continue;
    }
    const next = truncateNestedValue(value);
    if (next === value) continue;
    truncated ??= { ...attributes };
    truncated[key] = next;
  }
  return truncated ?? attributes;
}

function spanToTraceRecord(span: SerializableSpan): EffectTraceRecord {
  const status = span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>;
  const parentSpanId = Option.getOrUndefined(span.parent)?.spanId;

  return {
    type: "effect-span",
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sampled: span.sampled,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: truncateTraceAttributes(
      compactTraceAttributes(Object.fromEntries(span.attributes)),
    ),
    events: span.events.map(([name, startTime, attributes]) => ({
      name,
      timeUnixNano: String(startTime),
      attributes: truncateTraceAttributes(compactTraceAttributes(attributes)),
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: truncateTraceAttributes(compactTraceAttributes(link.attributes)),
    })),
    // SQLite errors can quote SQL or values; keep only the structural failure tag.
    exit:
      span.attributes.has("sql.fingerprint") && ExitRuntime.isFailure(status.exit)
        ? {
            _tag: Cause.hasInterruptsOnly(status.exit.cause) ? "Interrupted" : "Failure",
            cause: causeErrorTag(status.exit.cause),
          }
        : formatTraceExit(status.exit),
  };
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const rotationOptions = {
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    ...(options.compressBackups ? { compressBackups: true } : {}),
    ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
  };
  let sink = yield* makeAsyncRotatingFileSink(rotationOptions).pipe(Effect.orDie);

  let paused = false;
  let epoch = 0;
  let buffer: Array<{ readonly text: string; readonly bytes: number }> = [];
  let bufferBytes = 0;
  const maxBufferBytes = Math.max(options.maxBytes, 4 * 1024 * 1024);
  const flushRequests = yield* Queue.sliding<void>(1);
  const flushSemaphore = yield* Semaphore.make(1);
  let writeFailing = false;
  let droppedCount = 0;
  let failureReported = false;
  let pendingFlushStats: TraceSinkFlushStats = {
    logicalWriteBytes: 0,
    count: 0,
    durationMs: 0,
  };

  let windowStart = clock.currentTimeMillisUnsafe();
  const summaries = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  const enqueue = (record: TraceRecord | SpanSummaryRecord) => {
    try {
      const text = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(text);
      if (bytes > options.maxBytes) return;
      if (bufferBytes + bytes > maxBufferBytes) {
        droppedCount++;
        return;
      }
      buffer.push({ text, bytes });
      bufferBytes += bytes;
      if (buffer.length >= FLUSH_BUFFER_THRESHOLD) Queue.offerUnsafe(flushRequests, undefined);
    } catch {
      return;
    }
  };
  const flushSummary = (force = false) => {
    const now = clock.currentTimeMillisUnsafe();
    if (!force && now - windowStart < 60_000) return;
    if (summaries.size > 0) {
      enqueue({
        type: "span-summary",
        windowStart,
        windowEnd: now,
        spans: Object.fromEntries(summaries),
      });
      summaries.clear();
    }
    windowStart = now;
  };
  const flushBuffered = Effect.gen(function* () {
    if (buffer.length === 0) {
      return;
    }

    const records = buffer;
    buffer = [];
    bufferBytes = 0;
    let persistedCount = 0;

    while (persistedCount < records.length) {
      const firstRecordBytes = records[persistedCount]!.bytes;
      let nextIndex = persistedCount + 1;
      let chunkBytes = firstRecordBytes;
      while (nextIndex < records.length) {
        const nextRecordBytes = records[nextIndex]!.bytes;
        if (chunkBytes + nextRecordBytes > options.maxBytes) break;
        chunkBytes += nextRecordBytes;
        nextIndex += 1;
      }

      const chunk = records
        .slice(persistedCount, nextIndex)
        .map((record) => record.text)
        .join("");
      const startedAt = performance.now();
      const written = yield* sink.write(chunk).pipe(Effect.result);
      if (Result.isFailure(written)) {
        // A failing disk (ENOSPC, EACCES, EIO) drops the rest of the batch.
        // Retrying it would grow the backlog, and every later push would
        // retry all of it.
        writeFailing = true;
        droppedCount += records.length - persistedCount;
        return;
      }
      writeFailing = false;
      pendingFlushStats = {
        logicalWriteBytes: pendingFlushStats.logicalWriteBytes + chunkBytes,
        count: pendingFlushStats.count + nextIndex - persistedCount,
        durationMs: pendingFlushStats.durationMs + Math.max(0, performance.now() - startedAt),
      };
      persistedCount = nextIndex;
    }
  });

  const drain = Effect.gen(function* () {
    flushSummary();
    const droppedAtStart = droppedCount;
    yield* flushBuffered;
    const stats = pendingFlushStats;
    pendingFlushStats = {
      logicalWriteBytes: 0,
      count: 0,
      durationMs: 0,
    };
    if (stats.count > 0 && options.onFlush) {
      yield* options.onFlush(stats).pipe(Effect.ignore);
    }
    if (droppedCount > 0 && !failureReported) {
      failureReported = true;
      yield* Effect.logWarning(
        "Trace writer could not keep up, dropping records until it recovers",
        {
          filePath: options.filePath,
        },
      );
    } else if (failureReported && !writeFailing && droppedCount === droppedAtStart) {
      yield* Effect.logInfo("Trace writes recovered", {
        filePath: options.filePath,
        droppedCount,
      });
      failureReported = false;
      droppedCount = 0;
    }
  });
  const flush = flushSemaphore
    .withPermits(1)(drain)
    .pipe(
      // A cancelled write still completes in the OS. Finish it before another
      // flush rotates the file or the scope's finalizer drains the remaining records.
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
      // The timed fiber inherits the makeTraceSink span. That span has ended but
      // lives as long as the sink, so the tracer logger must not add logs to it.
      Effect.updateContext(Context.omit(Tracer.ParentSpan)<never>),
    );

  const close = () =>
    Effect.sync(() => flushSummary(true)).pipe(
      Effect.andThen(flush),
      Effect.andThen(sink.flush),
      Effect.ignore,
    );
  yield* Effect.addFinalizer(close);
  yield* Effect.forkScoped(
    Queue.take(flushRequests).pipe(
      Effect.timeoutOption(`${Math.min(options.batchWindowMs, 60_000)} millis`),
      Effect.andThen(flush),
      Effect.forever,
    ),
  );

  const push = (record: TraceRecord) => {
    if (paused) return;
    flushSummary();
    const minimum = options.fileFilter?.minDurationMs ?? 0;
    // Slow ancestors normally survive too; detached/forked children can outlive a fast parent.
    if (minimum > 0 && !keepFileSpan(record, minimum)) {
      const stats = summaries.get(record.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
      stats.count++;
      stats.totalMs += record.durationMs;
      stats.maxMs = Math.max(stats.maxMs, record.durationMs);
      summaries.set(record.name, stats);
    } else enqueue(record);
  };
  const withMaintenance: TraceMaintenance = (effect) =>
    flushSemaphore
      .withPermit(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            paused = true;
            epoch++;
            flushSummary(true);
            const drained = yield* drain.pipe(Effect.andThen(sink.flush), Effect.exit);
            if (ExitRuntime.isFailure(drained) || writeFailing) {
              epoch++;
              paused = false;
              return yield* new TraceMaintenanceError({});
            }
            const result = yield* restore(effect).pipe(Effect.exit);
            const reopened = yield* makeAsyncRotatingFileSink(rotationOptions).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.result,
            );
            if (Result.isFailure(reopened)) return yield* new TraceMaintenanceError({});
            sink = reopened.success;
            epoch++;
            paused = false;
            if (ExitRuntime.isFailure(result)) return yield* Effect.failCause(result.cause);
            return result.value;
          }),
        ),
      )
      .pipe(Effect.withTracerEnabled(false));
  return {
    filePath: options.filePath,
    push,
    capture: () => {
      const captured = epoch;
      return (record: TraceRecord) => {
        if (captured === epoch) push(record);
      };
    },
    withMaintenance,
    flush,
    close,
  } satisfies TraceSink;
});

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;
  private readonly sqlDiagnostics: ReturnType<typeof makeSqlDiagnostics>;
  private normalizedSql: string | undefined;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
    sqlDiagnostics: ReturnType<typeof makeSqlDiagnostics>,
  ) {
    this.delegate = delegate;
    this.sqlDiagnostics = sqlDiagnostics;
    this.push = push;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    // Cached lookup fibers retain parent spans. Traces need success status, not result payloads.
    const traceExit = ExitRuntime.isSuccess(exit)
      ? ExitRuntime.void
      : (this.normalizedSql !== undefined || hasSqlFailure(exit.cause)) &&
          !Cause.hasInterruptsOnly(exit.cause)
        ? ExitRuntime.fail({ _tag: causeErrorTag(exit.cause) })
        : exit;
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit: traceExit,
    };
    const sqlEvents: TraceRecordEvent[] = [];
    if (this.sampled && this.normalizedSql !== undefined) {
      const fingerprint = String(this.attributes.get("sql.fingerprint"));
      const statement = this.sqlDiagnostics.statement(fingerprint, this.normalizedSql);
      if (statement)
        sqlEvents.push({
          name: "sql.statement",
          timeUnixNano: String(endTime),
          attributes: statement,
        });
      const executionMs = this.attributes.get("db.statement.execution_ms");
      if (typeof executionMs === "number" && executionMs >= 1_000) {
        const plan = this.sqlDiagnostics.plan(fingerprint);
        if (plan)
          sqlEvents.push({ name: "sql.plan", timeUnixNano: String(endTime), attributes: plan });
      }
    }
    this.normalizedSql = undefined;
    this.delegate.end(endTime, traceExit);

    if (this.sampled) {
      const record = spanToTraceRecord(this);
      // SQL events have their own byte cap; the general attribute clamp would lose the full text.
      this.push({ ...record, events: [...record.events, ...sqlEvents] });
    }
  }

  attribute(key: string, value: unknown): void {
    if (key === "db.query.text" && typeof value === "string") {
      this.normalizedSql = normalizeSql(value);
      this.attribute("sql.fingerprint", sqlFingerprint(this.normalizedSql));
      value =
        this.normalizedSql.length > TRACE_ATTRIBUTE_TRUNCATED_LENGTH
          ? this.normalizedSql.slice(0, TRACE_ATTRIBUTE_TRUNCATED_LENGTH) +
            TRACE_ATTRIBUTE_TRUNCATION_SUFFIX
          : this.normalizedSql;
    }
    this.attributes.set(key, value);
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const nextAttributes = attributes ?? {};
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
      ...(options.onFlush ? { onFlush: options.onFlush } : {}),
      ...(options.fileFilter ? { fileFilter: options.fileFilter } : {}),
      ...(options.compressBackups ? { compressBackups: true } : {}),
      ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  const sqlDiagnostics = makeSqlDiagnostics();
  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(
        spanOptions,
        delegate.span(spanOptions),
        sink.capture?.() ?? sink.push,
        sqlDiagnostics,
      );
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});

const SPAN_KIND_MAP: Record<number, OtlpTraceRecord["kind"]> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

export function decodeOtlpTraceRecords(
  payload: OtlpTracer.TraceData,
): ReadonlyArray<OtlpTraceRecord> {
  const records: Array<OtlpTraceRecord> = [];

  for (const resourceSpan of payload.resourceSpans) {
    const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes ?? []);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        records.push(
          otlpSpanToTraceRecord({
            resourceAttributes,
            scopeAttributes: decodeAttributes(
              "attributes" in scopeSpan.scope && Array.isArray(scopeSpan.scope.attributes)
                ? scopeSpan.scope.attributes
                : [],
            ),
            scopeName: scopeSpan.scope.name,
            scopeVersion:
              "version" in scopeSpan.scope && typeof scopeSpan.scope.version === "string"
                ? scopeSpan.scope.version
                : undefined,
            span,
          }),
        );
      }
    }
  }

  return records;
}

function otlpSpanToTraceRecord(input: {
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scopeAttributes: Readonly<Record<string, unknown>>;
  readonly scopeName: string | undefined;
  readonly scopeVersion: string | undefined;
  readonly span: OtlpSpan;
}): OtlpTraceRecord {
  return {
    type: "otlp-span",
    name: input.span.name,
    traceId: input.span.traceId,
    spanId: input.span.spanId,
    ...(input.span.parentSpanId ? { parentSpanId: input.span.parentSpanId } : {}),
    sampled: true,
    kind: normalizeSpanKind(input.span.kind),
    startTimeUnixNano: input.span.startTimeUnixNano,
    endTimeUnixNano: input.span.endTimeUnixNano,
    durationMs:
      Number(parseBigInt(input.span.endTimeUnixNano) - parseBigInt(input.span.startTimeUnixNano)) /
      1_000_000,
    attributes: decodeAttributes(input.span.attributes),
    resourceAttributes: input.resourceAttributes,
    scope: {
      ...(input.scopeName ? { name: input.scopeName } : {}),
      ...(input.scopeVersion ? { version: input.scopeVersion } : {}),
      attributes: input.scopeAttributes,
    },
    events: decodeEvents(input.span.events),
    links: decodeLinks(input.span.links),
    status: decodeStatus(input.span.status),
  };
}

function decodeStatus(input: OtlpSpanStatus): OtlpTraceRecord["status"] {
  const code = String(input.code);
  const message = input.message;

  return {
    code,
    ...(message ? { message } : {}),
  };
}

function decodeEvents(input: ReadonlyArray<OtlpSpanEvent>): ReadonlyArray<TraceRecordEvent> {
  return input.map((current) => ({
    name: current.name,
    timeUnixNano: current.timeUnixNano,
    attributes: decodeAttributes(current.attributes),
  }));
}

function decodeLinks(input: ReadonlyArray<OtlpSpanLink>): ReadonlyArray<TraceRecordLink> {
  return input.flatMap((current) => {
    const traceId = current.traceId;
    const spanId = current.spanId;
    return {
      traceId,
      spanId,
      attributes: decodeAttributes(current.attributes),
    };
  });
}

function decodeAttributes(
  input: ReadonlyArray<OtlpResource.KeyValue>,
): Readonly<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};

  for (const attribute of input) {
    entries[attribute.key] = decodeValue(attribute.value);
  }

  return truncateTraceAttributes(compactTraceAttributes(entries));
}

function decodeValue(input: OtlpResource.AnyValue | null | undefined): unknown {
  if (input == null) {
    return null;
  }
  if ("stringValue" in input) {
    return input.stringValue;
  }
  if ("boolValue" in input) {
    return input.boolValue;
  }
  if ("intValue" in input) {
    return input.intValue;
  }
  if ("doubleValue" in input) {
    return input.doubleValue;
  }
  if ("bytesValue" in input) {
    return input.bytesValue;
  }
  if (input.arrayValue) {
    return input.arrayValue.values.map((entry) => decodeValue(entry));
  }
  if (input.kvlistValue) {
    return decodeAttributes(input.kvlistValue.values);
  }
  return null;
}

function normalizeSpanKind(input: number): OtlpTraceRecord["kind"] {
  return SPAN_KIND_MAP[input] || "internal";
}

function parseBigInt(input: string): bigint {
  try {
    return BigInt(input);
  } catch {
    return 0n;
  }
}

export const OtlpHeadersFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Record(Schema.String, Schema.String),
    SchemaTransformation.transformEffect({
      decode: (input) => {
        const headers: Record<string, string> = {};
        for (const pair of input.split(",")) {
          if (pair.trim() === "") {
            continue;
          }
          const separator = pair.indexOf("=");
          const key = separator === -1 ? "" : pair.slice(0, separator).trim();
          if (key === "") {
            return Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `Expected key=value but received ${JSON.stringify(pair.trim())}.`,
              }),
            );
          }
          try {
            headers[key] = decodeURIComponent(pair.slice(separator + 1).trim());
          } catch {
            return Effect.fail(
              new SchemaIssue.InvalidValue({
                message: `Header ${JSON.stringify(key)} has a malformed percent-encoded value.`,
              }),
            );
          }
        }
        return Effect.succeed(headers);
      },
      encode: (headers) =>
        Effect.succeed(
          Object.entries(headers)
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join(","),
        ),
    }),
  ),
);
