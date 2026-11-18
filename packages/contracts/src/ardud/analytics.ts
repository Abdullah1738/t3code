import { McpReasonClass, McpInvalidField, McpRefusedAt } from "./mcpReasonClass.ts";
import { ClaudeApiErrorDetails } from "./claudeApiError.ts";
import { McpDenyReason } from "./mcpDenyReason.ts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { OrchestrationV2CancelReason } from "../orchestrationV2.ts";

const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value: string) => {
    const parsed = DateTime.make(value);
    return parsed._tag === "Some" && DateTime.formatIso(parsed.value) === value;
  }),
);

// Labels stay metadata-only; the provider diagnostics below carry scrubbed, bounded excerpts.
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
const McpCallerRole = Schema.Literals([
  "work",
  "review",
  "evaluator",
  "discussion",
  "owner",
  "unattached",
  "none",
]);
const McpCallerKind = Schema.Literals([
  "board_thread",
  "plain_thread",
  "delegated_child",
  "cli",
  "unknown",
]);
const Measurement = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const McpReplyPhases = Schema.Struct({
  caller: Schema.optionalKey(Measurement),
  admission: Schema.optionalKey(Measurement),
  read: Schema.optionalKey(Measurement),
  mutate: Schema.optionalKey(Measurement),
  commit: Schema.optionalKey(Measurement),
  ack: Schema.optionalKey(Measurement),
});
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
export const McpPhase = Schema.Literals([
  "caller",
  "dispatch",
  "result",
  "handler",
  "parent_records",
  "child_records",
  "catalog",
  "request_key",
  "receipt",
  "settings",
  "selection",
  "workspace",
  "lane_wait",
  "query",
  "render",
]);
// Pool identities include custom model slugs and provider suffixes such as [1m].
const PoolKey = Schema.String.check(
  Schema.isMaxLength(4608),
  Schema.isPattern(/^[a-zA-Z0-9_.:/#@%+!~'()*[\],=-]*$/),
);
const PoolChangeFields = {
  poolKey: PoolKey,
  fromPoolKey: Schema.optionalKey(PoolKey),
  fromSlots: Schema.NullOr(Measurement),
  toSlots: Schema.NullOr(Measurement),
  op: Schema.Literals(["set", "add", "remove", "replace", "auto_zero"]),
  actorKind: Schema.Literals(["evaluator", "owner", "script", "system"]),
  actorId: Schema.NullOr(DerivedId),
};
export const KanbanPoolChange = Schema.Struct({ at: Timestamp, ...PoolChangeFields });
export type KanbanPoolChange = typeof KanbanPoolChange.Type;
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
  "duplicate",
  "stale_reminder",
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
const DetachedOutcome = Schema.Literals(["committed", "failed", "capped"]);
const EventOutcome = Schema.Union([McpOutcome, EvaluatorOutcome, DetachedOutcome]);
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
// Provider instance/model ids may include punctuation excluded from routing labels.
const RuntimeCounts = Schema.Record(Schema.String.check(Schema.isMaxLength(512)), Measurement);
const RuntimeSampleProps = {
  runningTurns: Schema.optionalKey(
    Schema.Struct({
      total: Measurement,
      byProvider: RuntimeCounts,
      byModel: RuntimeCounts,
    }),
  ),
  runningByOrigin: Schema.optionalKey(
    Schema.Struct({
      boardWork: Measurement,
      boardReview: Measurement,
      boardEvaluator: Measurement,
      delegatedChild: Measurement,
      scheduledTask: Measurement,
      other: Measurement,
    }),
  ),
  queuedRuns: Schema.optionalKey(Measurement),
  providerSessions: Schema.optionalKey(RuntimeCounts),
  host: Schema.optionalKey(
    Schema.Struct({
      load1: Measurement,
      load5: Measurement,
      load15: Measurement,
      rssMiB: Measurement,
      heapUsedMiB: Measurement,
      eventLoopLagP99Ms: Schema.optionalKey(Measurement),
    }),
  ),
};

const GeneralEvent = Schema.Struct({
  ts: Timestamp,
  kind: Label.check(Schema.makeFilter((kind) => kind !== "run.usage")),
  surface: Schema.Literals(["web", "desktop", "mobile", "server"]),
  route: Label,
  boardId: Schema.optionalKey(Id),
  cardId: Schema.optionalKey(Id),
  discussionId: Schema.optionalKey(Id),
  restartAdmission: Schema.optionalKey(
    Schema.Struct({
      sourceRunId: DerivedId,
      runId: Schema.optionalKey(DerivedId),
      classification: Label,
      queuedAtMs: Measurement,
      waitedMs: Measurement,
      positionAtEntry: Measurement,
      position: Measurement,
      total: Measurement,
      maxQueueDepth: Measurement,
      active: Measurement,
      maxActive: Measurement,
      loaded: Schema.Boolean,
      rule: Schema.optionalKey(Schema.Literals(["no_progress", "absolute_backstop", "wall_time"])),
    }),
  ),
  threadId: Schema.optionalKey(DerivedId),
  // Claude API diagnostics are scrubbed at the adapter boundary, before truncation.
  claudeApiError: Schema.optionalKey(ClaudeApiErrorDetails),
  durationMs: Schema.optionalKey(Measurement),
  phase: Schema.optionalKey(Label),
  waitedMs: Schema.optionalKey(Measurement),
  lateMs: Schema.optionalKey(Measurement),
  afterCap: Schema.optionalKey(Schema.Boolean),
  detachedOutcomeWake: Schema.optionalKey(
    Schema.Literals([
      "sent",
      "sent_after_restart",
      "suppressed_retry_saved",
      "suppressed_definite",
    ]),
  ),
  tool: Schema.optionalKey(Label),
  build: Schema.optionalKey(Label),
  bootId: Schema.optionalKey(Id),
  startedAt: Schema.optionalKey(Timestamp),
  committed: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
  taskId: Schema.optionalKey(DerivedId),
  ticket: Schema.optionalKey(DerivedId),
  mode: Schema.optionalKey(Schema.Literals(["native", "cua-driver"])),
  from: Schema.optionalKey(Label),
  to: Schema.optionalKey(Label),
  age_ms: Schema.optionalKey(Measurement),
  parentThreadId: Schema.optionalKey(DerivedId),
  parentRunId: Schema.optionalKey(DerivedId),
  noticeMessageId: Schema.optionalKey(DerivedId),
  noticeKind: Schema.optionalKey(
    Schema.Literals(["finished", "failed", "stopped", "mixed", "unknown"]),
  ),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        childTaskId: DerivedId,
        status: Label,
        terminalAt: Schema.NullOr(Timestamp),
        delayMs: Schema.NullOr(Measurement),
      }),
    ),
  ),
  oldStatus: Schema.optionalKey(Label),
  newStatus: Schema.optionalKey(Label),
  reason: Schema.optionalKey(Label),
  callerThreadId: Schema.optionalKey(DerivedId),
  callerRole: Schema.optionalKey(McpCallerRole),
  callerKind: Schema.optionalKey(McpCallerKind),
  cardNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  callerCardNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  callerCardStage: Schema.optionalKey(Label),
  writePhases: Schema.optionalKey(
    Schema.Struct({
      lockWait: Measurement,
      read: Measurement,
      write: Measurement,
      replyWait: Measurement,
    }),
  ),
  cardStage: Schema.optionalKey(Label),
  denyReason: Schema.optionalKey(McpDenyReason),
  reasonClass: Schema.optionalKey(McpReasonClass),
  invalidField: Schema.optionalKey(McpInvalidField),
  refusedAt: Schema.optionalKey(McpRefusedAt),
  replyStage: Schema.optionalKey(Label),
  replyPhases: Schema.optionalKey(McpReplyPhases),
  requestTiming: Schema.optionalKey(
    Schema.Struct({ authMs: Measurement, dispatchMs: Measurement, preHandlerMs: Measurement }),
  ),
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
  callerReaderLane: Schema.optionalKey(Label),
  /** Legacy caller-lookup lane; new rows emit this alias for one release. */
  readerLane: Schema.optionalKey(Label),
  waitStage: Schema.optionalKey(Schema.Literals(["lookup.caller", "lookup.target", "waiting"])),
  waitLookupMs: Schema.optionalKey(Measurement),
  writerWaitMs: Schema.optionalKey(Measurement),
  readerWaitMs: Schema.optionalKey(Measurement),
  cardNextStages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        stage: Schema.Literals(["caller", "occupancy", "cards", "ranking", "rules"]),
        durationMs: Measurement,
        readerWaitMs: Measurement,
        queryMs: Measurement,
        completed: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(5)),
  ),
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
      ...RuntimeSampleProps,
      total: Schema.optionalKey(Measurement),
      distinctCwds: Schema.optionalKey(Measurement),
      maxPerSecond: Schema.optionalKey(Measurement),
      windowMs: Schema.optionalKey(Measurement),
      overflow: Schema.optionalKey(Measurement),
      top: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            operation: Label,
            subcommand: Label,
            cwdHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
            count: Measurement,
          }),
        ).check(Schema.isMaxLength(20)),
      ),
      on: Schema.optionalKey(Label),
      until: Schema.optionalKey(Timestamp),
      script: Schema.optionalKey(Label),
      number: Schema.optionalKey(Measurement),
      from: Schema.optionalKey(Label),
      to: Schema.optionalKey(Label),
      actor: Schema.optionalKey(
        Schema.Literals(["owner", "thread", "evaluator", "script", "system"]),
      ),
      seq: Schema.optionalKey(Measurement),
      target: Schema.optionalKey(Schema.Literals(["live_thread", "steer", "start", "none"])),
      msInPrevStage: Schema.optionalKey(Measurement),
      round: Schema.optionalKey(Measurement),
      chain: Schema.optionalKey(Label),
      verdict: Schema.optionalKey(Schema.Literals(["clear", "feedback"])),
      head: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/))),
      action: Schema.optionalKey(
        Schema.Literals(["set", "clear", "resumed", "restarted", "failed"]),
      ),
      effort: Schema.optionalKey(Label),
      lastProgressKind: Schema.optionalKey(Label),
      lastProgressTool: Schema.optionalKey(Label),
      silentSeconds: Schema.optionalKey(Measurement),
      attempt: Schema.optionalKey(Schema.NullOr(Measurement)),
      maxRetries: Schema.optionalKey(Schema.NullOr(Measurement)),
      // Provider diagnostics are required to explain retries; never include tool or prompt bodies.
      errorMessage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
      waitSinceResponseMs: Schema.optionalKey(Measurement),
      guardFiredDuringRetry: Schema.optionalKey(Schema.Boolean),
      reasonClass: Schema.optionalKey(Label),
      errorClass: Schema.optionalKey(Label),
      cancelReason: Schema.optionalKey(OrchestrationV2CancelReason),
      runId: Schema.optionalKey(DerivedId),
      attemptId: Schema.optionalKey(DerivedId),
      stage: Schema.optionalKey(Label),
      outcome: Schema.optionalKey(Label),
      retryCount: Schema.optionalKey(Measurement),
      discoveryMs: Schema.optionalKey(Schema.NullOr(Measurement)),
      attachmentsMs: Schema.optionalKey(Schema.NullOr(Measurement)),
      sdkOpenMs: Schema.optionalKey(Schema.NullOr(Measurement)),
      mcpRegistrationMs: Schema.optionalKey(Schema.NullOr(Measurement)),
      sdkAcceptMs: Schema.optionalKey(Schema.NullOr(Measurement)),
      model: Schema.optionalKey(Label),
      provider: Schema.optionalKey(Label),
      operation: Schema.optionalKey(Label),
      exitCode: Schema.optionalKey(Schema.Int),
      kind: Schema.optionalKey(Label),
      ageMs: Schema.optionalKey(Measurement),
      slot: Schema.optionalKey(Schema.Literals(["take", "release"])),
      why: Schema.optionalKey(Label),
      held: Schema.optionalKey(Schema.Boolean),
      holdsSlot: Schema.optionalKey(Schema.Boolean),
      carried: Schema.optionalKey(Measurement),
      candidateCount: Schema.optionalKey(Measurement),
      used: Schema.optionalKey(Measurement),
      slots: Schema.optionalKey(Measurement),
      waiting: Schema.optionalKey(Measurement),
      method: Schema.optionalKey(Label),
      httpMethod: Schema.optionalKey(Label),
      httpRoute: Schema.optionalKey(Label),
      pathHint: Schema.optionalKey(Label),
      pathHash: Schema.optionalKey(Label),
      remoteKind: Schema.optionalKey(Schema.Literals(["loopback", "remote", "unknown"])),
      receiveToHandlerMs: Schema.optionalKey(Measurement),
      handlerMs: Schema.optionalKey(Measurement),
      responseReadyMs: Schema.optionalKey(Measurement),
      writeOutMs: Schema.optionalKey(Measurement),
      queryShape: Schema.optionalKey(Label),
      controlClient: Schema.optionalKey(Label),
      userAgent: Schema.optionalKey(Label),
      readerLane: Schema.optionalKey(Label),
      readerAcquireMs: Schema.optionalKey(Measurement),
      readerQueryMs: Schema.optionalKey(Measurement),
      readerStatements: Schema.optionalKey(Measurement),
      serializationMs: Schema.optionalKey(Measurement),
      requestId: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,64}$/)),
      ),
      itemCount: Schema.optionalKey(Measurement),
      itemsTotal: Schema.optionalKey(Measurement),
      responseBytes: Schema.optionalKey(Measurement),
      readerHolders: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            lane: Label,
            holder: Label,
            holdMs: Measurement,
          }),
        ).check(Schema.isMaxLength(8)),
      ),
      readerTimings: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            lane: Label,
            waitMs: Measurement,
            queryMs: Measurement,
            statements: Measurement,
          }),
        ).check(Schema.isMaxLength(8)),
      ),
      replyAdmissions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            lane: Label,
            waitMs: Measurement,
            runMs: Measurement,
            acquired: Schema.Boolean,
          }),
        ).check(Schema.isMaxLength(8)),
      ),
      span: Schema.optionalKey(Label),
      errorTag: Schema.optionalKey(Label),
      code: Schema.optionalKey(Label),
      boardId: Schema.optionalKey(Id),
      cardNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      saved: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("unknown")])),
      foundBy: Schema.optionalKey(
        Schema.Literals(["subagents", "receipt", "request_key_recovery", "none"]),
      ),
      notFoundReason: Schema.optionalKey(
        Schema.Literals([
          "non_canonical_id",
          "never_saved",
          "not_a_delegation_id",
          "other_thread",
          "not_a_delegation_command",
          "accepted",
          "rejected",
          "pending",
          "abandoned",
          "missing_child_thread",
        ]),
      ),
      idCanonical: Schema.optionalKey(Schema.Boolean),
      commandId: Schema.optionalKey(DerivedId),
      taskId: Schema.optionalKey(DerivedId),
      receiptState: Schema.optionalKey(Schema.Literal("accepted")),
      missingLookup: Schema.optionalKey(Schema.Literals(["subagents", "child_thread_id"])),
      dispatchFenceRecovered: Schema.optionalKey(Schema.Boolean),
      retryPath: Schema.optionalKey(
        Schema.Literals(["receipt_fast", "attached_pending", "dispatched"]),
      ),
      idShape: Schema.optionalKey(
        Schema.Literals(["task_id", "thread_id", "child_thread_id", "empty", "other"]),
      ),
      cause: Schema.optionalKey(
        Schema.Literals(["client_disconnect", "shutdown", "deadline", "stop", "unknown"]),
      ),
      waitMs: Schema.optionalKey(Measurement),
      originKind: Schema.optionalKey(Label),
      poolKey: Schema.optionalKey(PoolKey),
      fromPoolKey: Schema.optionalKey(PoolKey),
      fromSlots: Schema.optionalKey(PoolChangeFields.fromSlots),
      toSlots: Schema.optionalKey(PoolChangeFields.toSlots),
      op: Schema.optionalKey(PoolChangeFields.op),
      actorKind: Schema.optionalKey(PoolChangeFields.actorKind),
      actorId: Schema.optionalKey(PoolChangeFields.actorId),
      key: Schema.optionalKey(Label),
      reason: Schema.optionalKey(Label),
      itemKind: Schema.optionalKey(Label),
      openToolSince: Schema.optionalKey(Timestamp),
      effectId: Schema.optionalKey(DerivedId),
      effectType: Schema.optionalKey(Label),
      commandType: Schema.optionalKey(Label),
      failedRunId: Schema.optionalKey(DerivedId),
      startedRunId: Schema.optionalKey(DerivedId),
      failureCode: Schema.optionalKey(Label),
      headRunId: Schema.optionalKey(DerivedId),
      headOrdinal: Schema.optionalKey(Measurement),
      queuedCount: Schema.optionalKey(Measurement),
      heldCount: Schema.optionalKey(Measurement),
      phase: Schema.optionalKey(Label),
      threadList: Schema.optionalKey(
        Schema.Struct({
          phase: Schema.Literals(["caller", "project", "candidates", "shell", "render"]),
          batchCount: Measurement,
          candidateRows: Measurement,
          elapsedMs: Measurement,
          readerWaitMs: Measurement,
          queryMs: Measurement,
        }),
      ),
      subSteps: Schema.optionalKey(
        Schema.Array(Schema.Struct({ subStep: Label, ms: Measurement })).check(
          Schema.isMaxLength(3),
        ),
      ),
      tickId: Schema.optionalKey(Id),
      activeTickId: Schema.optionalKey(Id),
      byRead: Schema.optionalKey(
        Schema.Record(Label, Schema.Struct({ count: Measurement, ms: Measurement })),
      ),
      byStep: Schema.optionalKey(
        Schema.Record(Label, Schema.Struct({ count: Measurement, ms: Measurement })),
      ),
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
      openNoticesAtCreation: Schema.optionalKey(Measurement),
      answeredVia: Schema.optionalKey(Schema.Literals(["single", "batch", "free_text"])),
      status: Schema.optionalKey(Measurement),
      count: Schema.optionalKey(Measurement),
      database: Schema.optionalKey(Label),
      connection: Schema.optionalKey(Label),
      lane: Schema.optionalKey(Label),
      sqlFingerprint: Schema.optionalKey(Label),
      failures: Schema.optionalKey(Measurement),
      readBytes: Schema.optionalKey(Measurement),
      sampleMs: Schema.optionalKey(Measurement),
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
  cancelReason: Schema.optionalKey(OrchestrationV2CancelReason),
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
      claudeApiError: Schema.optionalKey(Schema.Never),
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
  cardNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
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
  claudeApiErrors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        status: Schema.NullOr(Schema.Number),
        model: ModelId,
        host: Label,
        attempts: Measurement,
        giveUps: Measurement,
      }),
    ),
  ),
  restartAdmission: Schema.optionalKey(
    Schema.Struct({
      scope: Schema.Literal("server-wide"),
      groupBy: Schema.Literal("boot-hour"),
      loadedTimeShare: Schema.Null,
      basis: Schema.String.check(Schema.isMaxLength(160)),
      overflow: Measurement,
      groups: Schema.Array(
        Schema.Struct({
          bootId: Id,
          hour: Label,
          maxQueueDepth: Measurement,
          admissions: Measurement,
          failuresByRule: Schema.Record(Label, Measurement),
          maxActiveObserved: Measurement,
          maxActive: Measurement,
          loadedObservations: Measurement,
          observations: Measurement,
          wait: Schema.Struct({
            count: Measurement,
            p50Ms: Schema.NullOr(Measurement),
            p90Ms: Schema.NullOr(Measurement),
            maxMs: Schema.NullOr(Measurement),
            approximate: Schema.Boolean,
          }),
        }),
      ),
    }),
  ),
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
  runtimeSamples: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        hour: Label,
        samples: Measurement,
        runningTurnsMax: Measurement,
        runningTurnsAvg: Measurement,
        queuedRunsMax: Schema.NullOr(Measurement),
        load1Max: Measurement,
        sampleMsMax: Measurement,
      }),
    ).check(Schema.isMaxLength(24)),
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
  mcpFailureBreakdown: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        tool: Label,
        code: Label,
        ...LatencyFields,
        byReason: Schema.Record(Label, Measurement),
        byRole: Schema.Record(Label, Measurement),
        byCallerReaderLane: Schema.Record(Label, Measurement),
      }),
    ),
  ),
  mcpFailureContexts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        tool: Label,
        code: Label,
        errorTag: Label,
        denyReason: Label,
        callerRole: Label,
        cardStage: Label,
        ...LatencyFields,
      }),
    ),
  ),
  mcpReplyTimeouts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        tool: Label,
        code: Schema.Literal("reply_timeout"),
        errorTag: Label,
        denyReason: Label,
        callerRole: Label,
        cardStage: Label,
        ...LatencyFields,
        replyPhases: Schema.Record(Label, Schema.Struct(LatencyFields)),
        writePhases: Schema.Record(Label, Schema.Struct(LatencyFields)),
      }),
    ),
  ),
  dbSlowBySpan: Schema.Array(
    Schema.Struct({
      span: Label,
      key: Label,
      phase: Label,
      totalWaitMs: Measurement,
      ...LatencyFields,
    }),
  ),
  dbStatementFamilies: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        database: Label,
        connection: Label,
        lane: Label,
        fingerprint: Label,
        family: Label,
        calls: Measurement,
        totalMs: Measurement,
        maxMs: Measurement,
        returnedRows: Measurement,
        failures: Measurement,
      }),
    ),
  ),
  processDiskRead: Schema.optionalKey(
    Schema.Struct({
      readBytes: Measurement,
      sampleMs: Measurement,
      samples: Measurement,
      unavailableSamples: Measurement,
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
      poolChanges: Schema.optionalKey(Schema.Array(KanbanPoolChange)),
      poolUtilisation: Schema.Array(
        Schema.Struct({
          hour: Label,
          poolKey: PoolKey,
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
      reasonClasses: Schema.Record(Label, Measurement),
      invalidFields: Schema.Record(Label, Measurement),
      notFoundReasons: Schema.optionalKey(Schema.Record(Label, Measurement)),
      foundByCounts: Schema.optionalKey(Schema.Record(Label, Measurement)),
      idShapeCounts: Schema.optionalKey(Schema.Record(Label, Measurement)),
      errors: Schema.Array(
        Schema.Struct({ errorTag: Label, errorPhase: McpPhase, count: Measurement }),
      ),
      failedThenRetried: Measurement,
      retrySucceeded: Measurement,
      dispatchTimeouts: Schema.optionalKey(
        Schema.Struct({
          committed: Measurement,
          failed: Measurement,
          capped: Measurement,
          noOutcome: Measurement,
        }),
      ),
    }),
  ),
  mcpOverflow: Schema.Struct({
    groups: Measurement,
    retryAttempts: Measurement,
    detachedOutcomes: Schema.optionalKey(Measurement),
  }),
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
