import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value: string) => {
    const parsed = DateTime.make(value);
    return parsed._tag === "Some" && DateTime.formatIso(parsed.value) === value;
  }),
);

// Metadata only. Deliberately no arbitrary property bag or free-form text fields.
const Label = Schema.String.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+-]*$/),
);
const Id = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+-]*$/),
);
// Derived task/thread IDs retain encodeURIComponent's punctuation and can exceed 512 chars.
// The event byte limit still bounds the complete row.
const DerivedId = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+!~'()*-]*$/),
);
const Measurement = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
// Mergeable, bounded duration distribution; bucket upper bounds have at most 2% error.
export const LONG_TASK_HISTOGRAM_RATIO = 1.02;
export const LONG_TASK_HISTOGRAM_BUCKETS = 1024;
const LongTaskHistogram = Schema.Array(
  Schema.Tuple([Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1023 })), Measurement]),
).check(Schema.isMaxLength(LONG_TASK_HISTOGRAM_BUCKETS));
const McpOutcome = Schema.Literals([
  "ok",
  "error",
  "timeout",
  "refused",
  "interrupted",
  "interrupted_by_shutdown",
]);
const McpPhase = Schema.Literals(["caller", "dispatch", "result", "handler"]);
export const AnalyticsEvent = Schema.Struct({
  ts: Timestamp,
  kind: Label,
  surface: Schema.Literals(["web", "desktop", "mobile", "server"]),
  route: Label,
  boardId: Schema.optionalKey(Id),
  cardId: Schema.optionalKey(Id),
  discussionId: Schema.optionalKey(Id),
  threadId: Schema.optionalKey(DerivedId),
  durationMs: Schema.optionalKey(Measurement),
  tool: Schema.optionalKey(Label),
  build: Schema.optionalKey(Label),
  bootId: Schema.optionalKey(Id),
  startedAt: Schema.optionalKey(Timestamp),
  committed: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
  taskId: Schema.optionalKey(DerivedId),
  callerThreadId: Schema.optionalKey(DerivedId),
  callerResolved: Schema.optionalKey(Schema.Boolean),
  callerResolveMs: Schema.optionalKey(Measurement),
  clientRequestId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  outcome: Schema.optionalKey(McpOutcome),
  errorTag: Schema.optionalKey(Label),
  errorPhase: Schema.optionalKey(McpPhase),
  saved: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
  readerLane: Schema.optionalKey(Label),
  writerWaitMs: Schema.optionalKey(Measurement),
  props: Schema.optionalKey(
    Schema.Struct({
      method: Schema.optionalKey(Label),
      span: Schema.optionalKey(Label),
      errorTag: Schema.optionalKey(Label),
      originKind: Schema.optionalKey(Label),
      poolKey: Schema.optionalKey(Label),
      key: Schema.optionalKey(Label),
      reason: Schema.optionalKey(Label),
      phase: Schema.optionalKey(Label),
      tickId: Schema.optionalKey(Id),
      activeTickId: Schema.optionalKey(Id),
      cardsScanned: Schema.optionalKey(Measurement),
      cardsChanged: Schema.optionalKey(Measurement),
      dbMs: Schema.optionalKey(Measurement),
      queueWaitMs: Schema.optionalKey(Measurement),
      heapMB: Schema.optionalKey(Measurement),
      overlappingTicks: Schema.optionalKey(Measurement),
      createdAt: Schema.optionalKey(Timestamp),
      askId: Schema.optionalKey(Id),
      notifiedAt: Schema.optionalKey(Timestamp),
      notifiedByChannel: Schema.optionalKey(
        Schema.Struct({
          in_app: Schema.optionalKey(Timestamp),
          telegram: Schema.optionalKey(Timestamp),
          push: Schema.optionalKey(Timestamp),
        }),
      ),
      notificationChannels: Schema.optionalKey(
        Schema.Array(Schema.Literals(["in_app", "telegram", "push"])),
      ),
      firstSeenAt: Schema.optionalKey(Timestamp),
      firstSeenBySurface: Schema.optionalKey(
        Schema.Struct({
          web: Schema.optionalKey(Timestamp),
          desktop: Schema.optionalKey(Timestamp),
          mobile: Schema.optionalKey(Timestamp),
        }),
      ),
      answeredAt: Schema.optionalKey(Timestamp),
      blocking: Schema.optionalKey(Schema.Boolean),
      askKind: Schema.optionalKey(
        Schema.Literals(["approve", "pick", "draft", "action", "input", "notice"]),
      ),
      hasBatchKey: Schema.optionalKey(Schema.Boolean),
      openAsksAtCreation: Schema.optionalKey(Measurement),
      answeredVia: Schema.optionalKey(Schema.Literals(["single", "batch", "free_text"])),
      status: Schema.optionalKey(Measurement),
      count: Schema.optionalKey(Measurement),
      bytes: Schema.optionalKey(Measurement),
      p50Ms: Schema.optionalKey(Measurement),
      p95Ms: Schema.optionalKey(Measurement),
      queryLength: Schema.optionalKey(Measurement),
      resultCount: Schema.optionalKey(Measurement),
      depth: Schema.optionalKey(Measurement),
      droppedFrames: Schema.optionalKey(Measurement),
      memoryBytes: Schema.optionalKey(Measurement),
      screen: Schema.optionalKey(Label),
      containerType: Schema.optionalKey(Label),
      containerName: Schema.optionalKey(Label),
      ownerAction: Schema.optionalKey(Label),
      visibleCardCount: Schema.optionalKey(Measurement),
      visibleThreadCount: Schema.optionalKey(Measurement),
      subscriptionBytes: Schema.optionalKey(Measurement),
      subscriptionMessages: Schema.optionalKey(Measurement),
      totalMs: Schema.optionalKey(Measurement),
      maxMs: Schema.optionalKey(Measurement),
      wallTimeMs: Schema.optionalKey(Measurement),
      histogram: Schema.optionalKey(LongTaskHistogram),
    }),
  ),
});
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
export const AnalyticsIngestInput = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      ...AnalyticsEvent.fields,
      surface: Schema.Literals(["web", "desktop", "mobile"]),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type AnalyticsIngestInput = typeof AnalyticsIngestInput.Type;
export class AnalyticsError extends Schema.TaggedError<AnalyticsError>()("AnalyticsError", {
  operation: Schema.Literals(["ingest", "read", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Analytics ${this.operation} failed.`;
  }
}
export const AnalyticsReadInput = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  kind: Schema.optionalKey(Label),
  boardId: Schema.optionalKey(Id),
  tool: Schema.optionalKey(Label),
  outcome: Schema.optionalKey(McpOutcome),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type AnalyticsReadInput = typeof AnalyticsReadInput.Type;
const LatencyFields = {
  count: Measurement,
  p50Ms: Schema.NullOr(Measurement),
  p95Ms: Schema.NullOr(Measurement),
  maxMs: Schema.NullOr(Measurement),
  approximate: Schema.Boolean,
};
export const AskLatencySplit = Schema.Struct({
  sentToSeen: Schema.Struct(LatencyFields),
  seenToAnswered: Schema.Struct(LatencyFields),
  createdToAnswered: Schema.Struct(LatencyFields),
  answeredWithoutSeen: Measurement,
});
export const AskLatencyRollup = Schema.Struct({
  ...AskLatencySplit.fields,
  source: Schema.Literals(["stored-asks", "unavailable"]),
  openOver1hAtDayEnd: Schema.NullOr(Measurement),
  byBlocking: Schema.Record(Label, AskLatencySplit),
  byKind: Schema.Record(Label, AskLatencySplit),
});
export const AnalyticsRollup = Schema.Struct({
  day: AnalyticsReadInput.fields.day,
  generatedAt: Timestamp,
  scope: Schema.Literal("retained-events"),
  total: Measurement,
  invalidLines: Measurement,
  kindCounts: Schema.Record(Label, Measurement),
  errorCounts: Schema.Record(Label, Measurement),
  longTasksByRoute: Schema.Array(
    Schema.Struct({
      route: Label,
      surface: AnalyticsEvent.fields.surface,
      count: Measurement,
      totalMs: Measurement,
      p95Ms: Schema.NullOr(Measurement),
      maxMs: Measurement,
      wallTimeMs: Measurement,
      wallTimeShare: Schema.NullOr(Measurement),
      approximate: Schema.Boolean,
    }),
  ),
  topSlowRpcs: Schema.Array(Schema.Struct({ method: Label, ...LatencyFields })),
  askAnswerLatency: Schema.Struct(LatencyFields),
  askLatency: AskLatencyRollup,
  tickPhases: Schema.optionalKey(
    Schema.Array(Schema.Struct({ boardId: Id, phase: Label, ...LatencyFields })),
  ),
  mcpCalls: Schema.Array(
    Schema.Struct({
      tool: Label,
      hour: Label,
      build: Label,
      bootId: Id,
      ...LatencyFields,
      failures: Measurement,
      failureRate: Measurement,
      outcomes: Schema.Record(Label, Measurement),
      savedCounts: Schema.Record(Label, Measurement),
      errors: Schema.Array(
        Schema.Struct({ errorTag: Label, errorPhase: McpPhase, count: Measurement }),
      ),
      failedThenRetried: Measurement,
      retrySucceeded: Measurement,
    }),
  ),
  mcpOverflow: Schema.Struct({ groups: Measurement, retryAttempts: Measurement }),
});
export type AnalyticsRollup = typeof AnalyticsRollup.Type;
export const AnalyticsReadResult = Schema.Struct({
  rollup: AnalyticsRollup,
  samples: Schema.Array(AnalyticsEvent),
});
export type AnalyticsReadResult = typeof AnalyticsReadResult.Type;
