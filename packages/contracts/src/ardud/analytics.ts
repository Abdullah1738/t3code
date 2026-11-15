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
export const EvaluatorTrigger = Schema.Literals([
  "owner_answer",
  "card_ask",
  "discussion_post",
  "step_transition",
  "step_reminder",
  "stall_run_failure",
  "system_stall",
  "review_verdict",
  "wait_ended",
  "wait_expired",
  "wait_failing",
  "report_bug",
  "evaluator_start",
  "tick_check",
  "tick_stalled",
  "tick_completed",
  "tick_deployed",
  "tick_packets",
  "nightly",
  "setup",
  "discussion_nudge",
  "thread_send",
  "legacy_queue",
]);
export type EvaluatorTrigger = typeof EvaluatorTrigger.Type;
export const EvaluatorOutcome = Schema.Literals([
  "started",
  "reused",
  "merged",
  "queued_spawn_cap",
]);
export type EvaluatorOutcome = typeof EvaluatorOutcome.Type;
export const EvaluatorReuseMissReason = Schema.Literals([
  "no_card_reuse_scope",
  "no_candidates",
  "all_candidates_rejected",
  "idle_expired",
  "archived",
  "failed",
  "missing",
  "different_purpose",
  "forced_new",
  "not_attempted",
  "legacy_queue",
]);
export type EvaluatorReuseMissReason = typeof EvaluatorReuseMissReason.Type;
const EventOutcome = Schema.Union([McpOutcome, EvaluatorOutcome]);
export const EvaluatorPurposeKind = Schema.Literals([
  "discussion",
  "nightly",
  "stalled",
  "completed",
  "deployed",
  "check",
  "packets",
  "setup",
  "request",
  "unknown",
]);
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
  authMs: Schema.optionalKey(Measurement),
  dispatchMs: Schema.optionalKey(Measurement),
  preHandlerMs: Schema.optionalKey(Measurement),
  totalMs: Schema.optionalKey(Measurement),
  clientRequestId: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  outcome: Schema.optionalKey(EventOutcome),
  purposeKind: Schema.optionalKey(EvaluatorPurposeKind),
  trigger: Schema.optionalKey(EvaluatorTrigger),
  reuseMissReason: Schema.optionalKey(EvaluatorReuseMissReason),
  errorTag: Schema.optionalKey(Label),
  errorPhase: Schema.optionalKey(McpPhase),
  saved: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
  responseDelivery: Schema.optionalKey(Schema.Literals(["pending", "finished", "closed"])),
  responseElapsedMs: Schema.optionalKey(Measurement),
  responseCloseReason: Schema.optionalKey(
    Schema.Literals(["idle_timeout", "client_error", "peer_end", "socket_error", "unknown"]),
  ),
  readerLane: Schema.optionalKey(Label),
  waitStage: Schema.optionalKey(Schema.Literals(["lookup.caller", "lookup.target", "waiting"])),
  waitLookupMs: Schema.optionalKey(Measurement),
  writerWaitMs: Schema.optionalKey(Measurement),
  readerWaitMs: Schema.optionalKey(Measurement),
  queryMs: Schema.optionalKey(Measurement),
  renderMs: Schema.optionalKey(Measurement),
  inFlightAtStart: Schema.optionalKey(
    Schema.Struct({
      session: Measurement,
      overall: Measurement,
    }),
  ),
  threadReadStages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        stage: Schema.Literals([
          "caller",
          "shell",
          "records",
          "timeline",
          "messages",
          "acknowledgement",
        ]),
        durationMs: Measurement,
        completed: Schema.Boolean,
        readerWaitMs: Measurement,
        queryMs: Measurement,
      }),
    ).check(Schema.isMaxLength(6)),
  ),
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
      provider: Schema.optionalKey(Label),
      operation: Schema.optionalKey(Label),
      exitCode: Schema.optionalKey(Schema.Int),
      kind: Schema.optionalKey(Label),
      ageMs: Schema.optionalKey(Measurement),
      used: Schema.optionalKey(Measurement),
      slots: Schema.optionalKey(Measurement),
      waiting: Schema.optionalKey(Measurement),
      method: Schema.optionalKey(Label),
      httpMethod: Schema.optionalKey(Label),
      httpRoute: Schema.optionalKey(Label),
      queryShape: Schema.optionalKey(Label),
      controlClient: Schema.optionalKey(Label),
      userAgent: Schema.optionalKey(Label),
      readerLane: Schema.optionalKey(Label),
      readerAcquireMs: Schema.optionalKey(Measurement),
      readerQueryMs: Schema.optionalKey(Measurement),
      readerStatements: Schema.optionalKey(Measurement),
      span: Schema.optionalKey(Label),
      errorTag: Schema.optionalKey(Label),
      code: Schema.optionalKey(Label),
      boardId: Schema.optionalKey(Id),
      cardNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      saved: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
      cause: Schema.optionalKey(
        Schema.Literals(["client_disconnect", "shutdown", "deadline", "stop", "unknown"]),
      ),
      waitMs: Schema.optionalKey(Measurement),
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
const ModelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const TokenCount = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
);
export const RunUsageEvent = Schema.Struct({
  ...GeneralEvent.fields,
  kind: Schema.Literal("run.usage"),
  surface: Schema.Literal("server"),
  runId: DerivedId,
  threadId: DerivedId,
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
export const AnalyticsReadSection = Schema.suspend(() =>
  Schema.Literals([
    ...(Object.keys(AnalyticsRollup.fields) as Array<keyof typeof AnalyticsRollup.fields>),
    "samples",
  ]),
);
export type AnalyticsReadSection = typeof AnalyticsReadSection.Type;
export const AnalyticsReadInput = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  kind: Schema.optionalKey(Label),
  boardId: Schema.optionalKey(Id),
  cardId: Schema.optionalKey(Id),
  tool: Schema.optionalKey(Label),
  outcome: Schema.optionalKey(EventOutcome),
  section: Schema.optionalKey(AnalyticsReadSection),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  responseDelivery: Schema.optionalKey(Schema.Literals(["pending", "finished", "closed"])),
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
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  generatedAt: Timestamp,
  scope: Schema.Literal("retained-events"),
  total: Measurement,
  invalidLines: Measurement,
  kindCounts: Schema.Record(Label, Measurement),
  textGenerationOverflow: Schema.optionalKey(Measurement),
  textGeneration: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        hour: Label,
        provider: Label,
        operation: Label,
        boardId: Schema.NullOr(Id),
        kind: Schema.Literals(["operation", "child"]),
        outcome: McpOutcome,
        ...LatencyFields,
      }),
    ),
  ),
  errorCounts: Schema.Record(Label, Measurement),
  controlRoutes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        route: Label,
        method: Label,
        hour: Label,
        statuses: Schema.Record(Label, Measurement),
        totalWaitMs: Measurement,
        deadlineExceeded: Measurement,
        ...LatencyFields,
      }),
    ),
  ),
  errorsByRoute: Schema.Array(
    Schema.Struct({
      route: Label,
      method: Label,
      status: Schema.NullOr(Measurement),
      tag: Label,
      ...LatencyFields,
    }),
  ),
  mcpErrorsByCode: Schema.Array(Schema.Struct({ tool: Label, code: Label, ...LatencyFields })),
  dbSlowBySpan: Schema.Array(
    Schema.Struct({
      span: Label,
      key: Label,
      phase: Label,
      totalWaitMs: Measurement,
      ...LatencyFields,
    }),
  ),
  longTasksByRoute: Schema.Array(
    Schema.Struct({
      route: Label,
      surface: GeneralEvent.fields.surface,
      count: Measurement,
      totalMs: Measurement,
      p95Ms: Schema.NullOr(Measurement),
      maxMs: Measurement,
      wallTimeMs: Measurement,
      wallTimeShare: Schema.NullOr(Measurement),
      approximate: Schema.Boolean,
    }),
  ),
  topSlowRpcs: Schema.Array(
    Schema.Struct({
      method: Label,
      ...LatencyFields,
      totalWaitMs: Schema.optionalKey(Measurement),
      outcomes: Schema.optionalKey(Schema.Record(Label, Measurement)),
    }),
  ),
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
  askLatency: AskLatencyRollup,
  tickPhases: Schema.optionalKey(
    Schema.Array(Schema.Struct({ boardId: Id, phase: Label, ...LatencyFields })),
  ),
  evaluatorOutcomes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        boardId: Id,
        trigger: Label,
        purposeKind: Label,
        outcome: Label,
        reuseMissReason: Schema.NullOr(Label),
        count: Measurement,
      }),
    ),
  ),
  evaluatorStartsByTrigger: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        boardId: Id,
        trigger: Label,
        count: Measurement,
      }),
    ),
  ),
  mcpCalls: Schema.Array(
    Schema.Struct({
      tool: Label,
      hour: Label,
      build: Label,
      bootId: Id,
      ...LatencyFields,
      preHandler: Schema.optionalKey(Schema.Struct(LatencyFields)),
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
  summary: Schema.Struct({
    events: Measurement,
    errors: Measurement,
    mcpCalls: Measurement,
    mcpFailures: Measurement,
    boardMoves: Measurement,
    reviewRounds: Measurement,
    stalls: Measurement,
    openAsks: Measurement,
    runs: Measurement,
  }),
  sections: Schema.Array(
    Schema.Struct({ name: AnalyticsReadSection, rows: Measurement, chars: Measurement }),
  ),
  section: Schema.optionalKey(AnalyticsReadSection),
  rows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
        value: Schema.Json,
        truncated: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  hasMore: Schema.Boolean,
  cursor: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  next: Schema.optionalKey(Schema.String),
});
export type AnalyticsReadResult = typeof AnalyticsReadResult.Type;
