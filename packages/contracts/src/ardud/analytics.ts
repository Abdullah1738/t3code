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
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+\-]*$/),
);
const Id = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+\-]*$/),
);
const Measurement = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const McpOutcome = Schema.Literals(["ok", "error", "timeout", "refused"]);
const McpPhase = Schema.Literals(["caller", "dispatch", "result", "handler"]);
export const AnalyticsEvent = Schema.Struct({
  ts: Timestamp,
  kind: Label,
  surface: Schema.Literals(["web", "desktop", "mobile", "server"]),
  route: Label,
  boardId: Schema.optionalKey(Id),
  cardId: Schema.optionalKey(Id),
  discussionId: Schema.optionalKey(Id),
  threadId: Schema.optionalKey(Id),
  durationMs: Schema.optionalKey(Measurement),
  tool: Schema.optionalKey(Label),
  build: Schema.optionalKey(Label),
  callerThreadId: Schema.optionalKey(Id),
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
      number: Schema.optionalKey(Measurement),
      from: Schema.optionalKey(Label),
      to: Schema.optionalKey(Label),
      actor: Schema.optionalKey(
        Schema.Literals(["owner", "thread", "evaluator", "script", "system"]),
      ),
      msInPrevStage: Schema.optionalKey(Measurement),
      round: Schema.optionalKey(Measurement),
      chain: Schema.optionalKey(Label),
      verdict: Schema.optionalKey(Schema.Literals(["clear", "feedback"])),
      head: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/))),
      action: Schema.optionalKey(Schema.Literals(["set", "clear"])),
      reasonClass: Schema.optionalKey(Label),
      errorClass: Schema.optionalKey(Label),
      model: Schema.optionalKey(Label),
      kind: Schema.optionalKey(Label),
      blocking: Schema.optionalKey(Schema.Boolean),
      ageMs: Schema.optionalKey(Measurement),
      used: Schema.optionalKey(Measurement),
      slots: Schema.optionalKey(Measurement),
      waiting: Schema.optionalKey(Measurement),
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
  boards: Schema.Array(
    Schema.Struct({
      boardId: Id,
      moves: Schema.Array(Schema.Struct({ from: Label, to: Label, count: Measurement })),
      timeInStage: Schema.Array(Schema.Struct({ stage: Label, ...LatencyFields })),
      reviewRounds: Schema.Array(
        Schema.Struct({ cardId: Id, rounds: Measurement, verdicts: Measurement }),
      ),
      verdictCounts: Schema.Record(Label, Measurement),
      reviewDuration: Schema.Struct(LatencyFields),
      stalls: Schema.Array(
        Schema.Struct({
          reasonClass: Label,
          sets: Measurement,
          clears: Measurement,
          ...LatencyFields,
        }),
      ),
      failureCounts: Schema.Record(Label, Measurement),
      restarts: Measurement,
      openAsks: Schema.Array(
        Schema.Struct({
          cardId: Id,
          key: Label,
          kind: Label,
          blocking: Schema.Boolean,
          createdAt: Timestamp,
          ageMs: Measurement,
        }),
      ),
      openAsksAsOf: Schema.NullOr(Timestamp),
      incompleteAskSnapshots: Measurement,
      poolUtilisation: Schema.Array(
        Schema.Struct({
          hour: Label,
          poolKey: Label,
          samples: Measurement,
          used: Measurement,
          slots: Measurement,
          waiting: Measurement,
          utilisation: Schema.NullOr(Measurement),
        }),
      ),
      overflow: Measurement,
    }),
  ),
  mcpCalls: Schema.Array(
    Schema.Struct({
      tool: Label,
      hour: Label,
      build: Label,
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
