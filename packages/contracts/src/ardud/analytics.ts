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
const McpOutcome = Schema.Literals([
  "ok",
  "error",
  "timeout",
  "refused",
  "interrupted",
  "interrupted_by_shutdown",
]);
const McpPhase = Schema.Literals(["caller", "dispatch", "result", "handler"]);
const GeneralEvent = Schema.Struct({
  ts: Timestamp,
  kind: Label.check(Schema.makeFilter((kind) => kind !== "run.usage")),
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
      createdAt: Schema.optionalKey(Timestamp),
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
    }),
  ),
});
const ModelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const TokenCount = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
);
export const RunUsageEvent = Schema.Struct({
  ...GeneralEvent.fields,
  kind: Schema.Literal("run.usage"),
  surface: Schema.Literal("server"),
  runId: Id,
  threadId: Id,
  role: Schema.Literals(["work", "review", "evaluator", "discussion", "delegated", "chat"]),
  providerInstance: Label,
  model: ModelId,
  effort: Schema.NullOr(Label),
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cachedInputTokens: TokenCount,
  reasoningTokens: TokenCount,
  wallMs: Schema.NullOr(Measurement),
  turnCount: Measurement,
  endReason: Schema.Literals(["completed", "failed", "interrupted", "cancelled"]),
  usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
  reviewRound: TokenCount,
});
export type RunUsageEvent = typeof RunUsageEvent.Type;
export const AnalyticsEvent = Schema.Union([GeneralEvent, RunUsageEvent]);
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
export const AnalyticsIngestInput = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      ...GeneralEvent.fields,
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
  cardId: Schema.optionalKey(Id),
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
const UsageTotals = Schema.Struct({
  runs: Measurement,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cachedInputTokens: TokenCount,
  reasoningTokens: TokenCount,
  wallMs: Schema.NullOr(Measurement),
  turnCount: Measurement,
  completeRuns: Measurement,
  partialRuns: Measurement,
  unavailableRuns: Measurement,
});
const CardUsage = Schema.Struct({
  ...UsageTotals.fields,
  boardId: Id,
  cardId: Id,
  evaluatorWakes: Measurement,
  reviewRounds: Measurement,
});
export const AnalyticsRollup = Schema.Struct({
  day: AnalyticsReadInput.fields.day,
  generatedAt: Timestamp,
  scope: Schema.Literal("retained-events"),
  total: Measurement,
  invalidLines: Measurement,
  kindCounts: Schema.Record(Label, Measurement),
  errorCounts: Schema.Record(Label, Measurement),
  topSlowRpcs: Schema.Array(Schema.Struct({ method: Label, ...LatencyFields })),
  askAnswerLatency: Schema.Struct(LatencyFields),
  usage: Schema.Struct({
    totals: UsageTotals,
    perModel: Schema.Array(
      Schema.Struct({ providerInstance: Label, model: ModelId, ...UsageTotals.fields }),
    ),
    perRole: Schema.Array(
      Schema.Struct({ role: RunUsageEvent.fields.role, ...UsageTotals.fields }),
    ),
    perBoard: Schema.Array(Schema.Struct({ boardId: Id, ...UsageTotals.fields })),
    cards: Schema.Array(CardUsage),
    topCardsByTokens: Schema.Array(CardUsage),
    topCardsByWallMs: Schema.Array(CardUsage),
  }),
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
