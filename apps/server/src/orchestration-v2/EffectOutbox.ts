import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderSessionId,
  RunAttemptId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const StoppedRunAttempts = Schema.Array(
  Schema.Struct({ runId: RunId, attemptId: Schema.NullOr(RunAttemptId) }),
);

export const OrchestrationEffectRequestV2 = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("provider-session.reconcile-root"),
    providerThreadId: ProviderThreadId,
    nodeId: NodeId,
    startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.reconcile-turn"),
    preserveBackgroundWork: Schema.optional(Schema.Boolean),
    releasedAt: Schema.optional(Schema.DateTimeUtcFromString),
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
  }),
  Schema.Struct({
    type: Schema.Literal("notification.delivery.accept"),
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-runtime.continue"),
    sourceRunId: RunId,
    queued: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.detach"),
    providerSessionId: ProviderSessionId,
    detail: Schema.optional(Schema.String),
    revokeMcpCredential: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-session.stop-background-work"),
    throughRunOrdinal: Schema.Number,
    runAttempts: StoppedRunAttempts,
    backgroundThreads: Schema.Array(
      Schema.Struct({
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        providerTurnId: ProviderTurnId,
      }),
    ),
    onlyIfCancelled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("mcp-credential.revoke-thread"),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.start"),
    runId: RunId,
    retryDelayMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.interrupt"),
    startTimeout: Schema.optional(Schema.Boolean),
    startTimeoutContext: Schema.optional(
      Schema.Struct({
        runId: RunId,
        code: Schema.String,
        provider: Schema.String,
      }),
    ),
    startingRun: Schema.optional(
      Schema.Struct({
        runId: RunId,
        attemptId: RunAttemptId,
        runOrdinal: Schema.Number,
      }),
    ),
    replacementProviderSessionId: Schema.optional(ProviderSessionId),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    subagent: Schema.optional(Schema.Struct({ id: NodeId, nativeTaskId: Schema.String })),
    stopThroughRunOrdinal: Schema.optional(Schema.Number),
    stopRunAttempts: Schema.optional(StoppedRunAttempts),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.steer"),
    // Accepted input only needs replay-safe mailbox bookkeeping on later attempts.
    providerAccepted: Schema.optional(Schema.Boolean),
    followUpPending: Schema.optional(Schema.Boolean),
    activeTurnOnly: Schema.optional(Schema.Boolean),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("provider-turn.restart"),
    expectedAttemptId: Schema.optional(RunAttemptId),
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    interruptedAttemptId: RunAttemptId,
    runId: RunId,
    sessionTransition: Schema.optional(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("replace"),
          replacementProviderSessionId: ProviderSessionId,
        }),
        Schema.Struct({ type: Schema.Literal("detach") }),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime-request.respond"),
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    decision: Schema.optional(ProviderApprovalDecision),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  Schema.Struct({
    type: Schema.Literal("provider-thread.rollback"),
    restoreFiles: Schema.optional(Schema.Boolean),
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint.capture"),
    runId: RunId,
    scopeId: CheckpointScopeId,
  }),
  Schema.Struct({
    type: Schema.Literal("scheduled-tasks.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("preview.cleanup"),
  }),
  Schema.Struct({
    type: Schema.Literal("attachment.cleanup"),
    attachmentIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("thread-title.generate"),
    kind: Schema.Union([
      Schema.Struct({ type: Schema.Literal("initial"), messageId: MessageId }),
      Schema.Struct({ type: Schema.Literal("regenerate") }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("delegated-tasks.stop"),
    reason: Schema.optional(Schema.String),
  }),
]);
export type OrchestrationEffectRequestV2 = typeof OrchestrationEffectRequestV2.Type;

export const START_LANE_EFFECT_TYPES = ["provider-turn.start"] as const satisfies ReadonlyArray<
  OrchestrationEffectRequestV2["type"]
>;

export const CONTROL_LANE_EFFECT_TYPES = [
  "provider-session.reconcile-root",
  "provider-session.reconcile-turn",
  "notification.delivery.accept",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "runtime-request.respond",
  "delegated-tasks.stop",
  "provider-session.detach",
  "provider-session.stop-background-work",
  "mcp-credential.revoke-thread",
  "checkpoint.capture",
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "attachment.cleanup",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS = [
  "provider-session.reconcile-root",
  "provider-session.reconcile-turn",
  "notification.delivery.accept",
  "provider-runtime.continue",
  "provider-session.detach",
  "provider-session.stop-background-work",
  "mcp-credential.revoke-thread",
  "provider-thread.rollback",
  "checkpoint.capture",
  "scheduled-tasks.cleanup",
  "terminal.cleanup",
  "preview.cleanup",
  "attachment.cleanup",
  "thread-title.generate",
  "delegated-tasks.stop",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const PROCESS_BOUND_EFFECT_TYPES = [
  "provider-turn.start",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "provider-turn.restart",
  "runtime-request.respond",
] as const satisfies ReadonlyArray<OrchestrationEffectRequestV2["type"]>;

export const OrchestrationEffectStatusV2 = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OrchestrationEffectStatusV2 = typeof OrchestrationEffectStatusV2.Type;

/**
 * Command retries are deduplicated by their receipts first, and a run's effects
 * are re-enqueued only around one server restart, so a week is far longer than
 * either and leaves recent history for debugging. Failed rows are kept: storage
 * cleanup keeps a deleted thread's worktree while any of its effects failed.
 */
export const SETTLED_EFFECT_RETENTION = Duration.days(7);
const PRUNE_BATCH_SIZE = 200;

export interface OrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly status: OrchestrationEffectStatusV2;
  readonly attemptCount: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export interface PendingOrchestrationEffectV2 {
  readonly id: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly request: OrchestrationEffectRequestV2;
  readonly availableAt?: DateTime.Utc;
}

export const nativeNoticeAcceptanceEffect = (
  threadId: ThreadId,
  messageId: MessageId,
): PendingOrchestrationEffectV2 => {
  const commandId = CommandId.make(`command:notice-native-accepted:${threadId}:${messageId}`);
  return {
    id: `effect:${commandId}`,
    commandId,
    threadId,
    request: { type: "notification.delivery.accept", messageId },
  };
};

export class EffectOutboxError extends Schema.TaggedError<EffectOutboxError>()(
  "EffectOutboxError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration effect outbox ${this.operation} failed${this.effectId === undefined ? "" : ` for ${this.effectId}`}.`;
  }
}

const isEffectOutboxError = Schema.is(EffectOutboxError);

export interface EffectOutboxV2Shape {
  readonly awaitAvailable: Effect.Effect<void>;
  readonly awaitControlAvailable: Effect.Effect<void>;
  readonly awaitStartAvailable: Effect.Effect<void>;
  readonly notifyAvailable: (count?: number) => Effect.Effect<void>;
  readonly wakeRestartEffect: (effectId: string) => Effect.Effect<boolean, EffectOutboxError>;
  /** Persist rows only. Notify workers after the surrounding transaction commits. */
  readonly enqueue: (
    effects: ReadonlyArray<PendingOrchestrationEffectV2>,
  ) => Effect.Effect<void, EffectOutboxError>;
  readonly get: (
    effectId: string,
  ) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
  readonly listPendingSteerTurns: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<ReadonlyArray<ProviderTurnId>, EffectOutboxError>;
  readonly pendingRunContinuation: (
    threadId: ThreadId,
  ) => Effect.Effect<string | null, EffectOutboxError>;
  readonly hasPendingRunContinuation: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, EffectOutboxError>;
  readonly hasRunContinuationAt: (input: {
    readonly threadId: ThreadId;
    readonly requestedAt: DateTime.Utc;
    readonly startupAt: DateTime.Utc;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly hasPendingRunStart: (input: {
    readonly threadId: ThreadId;
    readonly runIds: ReadonlyArray<RunId>;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly listRestartContinuations: Effect.Effect<
    ReadonlyArray<OrchestrationEffectV2>,
    EffectOutboxError
  >;
  readonly listByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEffectV2>, EffectOutboxError>;
  readonly listStartTimeoutStops: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEffectV2>, EffectOutboxError>;
  readonly cancelUnsettled: (input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
    readonly reason: string;
  }) => Effect.Effect<ReadonlyArray<string>, EffectOutboxError>;
  readonly signalCancellations: (effectIds: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly awaitCancellation: (effectId: string) => Effect.Effect<void>;
  readonly clearCancellation: (effectId: string) => Effect.Effect<void>;
  /** Resolves once the effect is neither pending nor running, or right away when it does not exist. */
  readonly awaitSettled: (effectId: string) => Effect.Effect<void, EffectOutboxError>;
  readonly reconcileAfterProcessLoss: Effect.Effect<
    { readonly requeued: number; readonly cancelled: number },
    EffectOutboxError
  >;
  readonly claimNext: (input: {
    readonly workerId: string;
    readonly threadId?: ThreadId;
    readonly leaseDurationMs: number;
    readonly excludeRestartContinuations?: boolean;
    readonly onlyEffectTypes?: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
  }) => Effect.Effect<Option.Option<OrchestrationEffectV2>, EffectOutboxError>;
  readonly nextClaimableAt: Effect.Effect<Option.Option<DateTime.Utc>, EffectOutboxError>;
  readonly nextControlClaimableAt: Effect.Effect<Option.Option<DateTime.Utc>, EffectOutboxError>;
  readonly nextStartClaimableAt: Effect.Effect<Option.Option<DateTime.Utc>, EffectOutboxError>;
  readonly succeed: (input: {
    readonly effectId: string;
    readonly workerId: string;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly retry: (input: {
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
    readonly delayMs: number;
    readonly steerAccepted?: boolean;
    readonly steerFollowUpPending?: boolean;
    readonly refundAttempt?: boolean;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly fail: (input: {
    readonly effectId: string;
    readonly workerId: string;
    readonly error: string;
  }) => Effect.Effect<boolean, EffectOutboxError>;
  readonly pruneSettled: Effect.Effect<number, EffectOutboxError>;
}

export class ExecutingEffect extends Context.Reference<OrchestrationEffectV2 | undefined>(
  "t3/orchestration-v2/ExecutingEffect",
  { defaultValue: () => undefined },
) {}

export class EffectOutboxV2 extends Context.Service<EffectOutboxV2, EffectOutboxV2Shape>()(
  "t3/orchestration-v2/EffectOutbox/EffectOutboxV2",
) {}

type EffectRow = {
  readonly effect_id: string;
  readonly command_id: string;
  readonly thread_id: string;
  readonly effect_type: string;
  readonly payload_json: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly available_at: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly last_error: string | null;
};

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

const rowToEffect = (row: EffectRow) =>
  decodeRequest(row.payload_json).pipe(
    Effect.map((request): OrchestrationEffectV2 => ({
      id: row.effect_id,
      commandId: CommandId.make(row.command_id),
      threadId: ThreadId.make(row.thread_id),
      request,
      status: row.status as OrchestrationEffectStatusV2,
      attemptCount: row.attempt_count,
      availableAt: row.available_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
    })),
  );

/**
 * ardud: threads that may hold a pending run continuation, so the probe can skip
 * the database for every other thread. Kanban calls it on each thread read
 * (tens of thousands of times in 15 minutes) and the shared background reader
 * queued those point reads for seconds behind heavy reads.
 *
 * Only `enqueue` inserts outbox rows and no update returns a settled row to
 * pending, so once the startup seed has run, a thread without a mark has none.
 * A mark is dropped only when the probe finds nothing, no enqueue happened
 * during that probe, and every effect it was marked for has been seen by a
 * statement. Until then an insert may still be uncommitted. Keyed by SQL client
 * because KanbanThreads may build its own EffectOutbox over the same database.
 */
interface ContinuationMarks {
  seeded: boolean;
  seedRetryAt: number;
  generation: number;
  readonly seedLock: Semaphore.Semaphore;
  readonly threads: Map<string, { generation: number; readonly unseen: Set<string> }>;
}
const continuationMarksByClient = new WeakMap<object, ContinuationMarks>();
const continuationMarksFor = (sql: object): ContinuationMarks => {
  const existing = continuationMarksByClient.get(sql);
  if (existing !== undefined) return existing;
  const created: ContinuationMarks = {
    seeded: false,
    seedRetryAt: 0,
    generation: 0,
    seedLock: Semaphore.makeUnsafe(1),
    threads: new Map(),
  };
  continuationMarksByClient.set(sql, created);
  return created;
};
const markContinuation = (marks: ContinuationMarks, threadId: string, effectId: string) => {
  const mark = marks.threads.get(threadId) ?? { generation: 0, unseen: new Set<string>() };
  mark.generation = ++marks.generation;
  mark.unseen.add(effectId);
  marks.threads.set(threadId, mark);
};
const sawContinuation = (marks: ContinuationMarks, threadId: string, effectId: string) => {
  marks.threads.get(threadId)?.unseen.delete(effectId);
};

export const layer: Layer.Layer<EffectOutboxV2, never, SqlClient.SqlClient> = Layer.effect(
  EffectOutboxV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const marks = continuationMarksFor(sql);
    const available = yield* Queue.dropping<void>(64);
    const controlAvailable = yield* Queue.dropping<void>(64);
    const startAvailable = yield* Queue.dropping<void>(64);
    const cancellationSignals = new Map<string, Deferred.Deferred<void>>();
    const settledSignals = new Map<string, Deferred.Deferred<void>>();
    const signalSettled = (effectIds: ReadonlyArray<string>) =>
      Effect.forEach(
        effectIds,
        (effectId) => {
          const signal = settledSignals.get(effectId);
          if (signal === undefined) return Effect.void;
          settledSignals.delete(effectId);
          return Deferred.succeed(signal, undefined);
        },
        { discard: true },
      );
    const notifyAvailable = (count = 1) => {
      const signals = Array.from(
        { length: Math.min(64, Math.max(0, Math.floor(count))) },
        () => undefined,
      );
      // Each lane needs its own notifications so a waiter in one lane cannot
      // consume the only wakeup for work that another lane can claim.
      return Queue.offerAll(available, signals).pipe(
        Effect.andThen(Queue.offerAll(controlAvailable, signals)),
        Effect.andThen(Queue.offerAll(startAvailable, signals)),
        Effect.asVoid,
      );
    };
    // An earlier effect waiting out a retry backoff still blocks later ones, so
    // a turn cannot start while a failed rollback is about to restore files.
    // A pending restart wake holds no provider or filesystem resources. Fresh
    // user turns must pass it while restart admission is paced.
    const claimableCandidatePredicate = (availableBefore?: string) =>
      sql`
        ${
          availableBefore === undefined
            ? sql`1 = 1`
            : sql`candidate.available_at <= ${availableBefore}`
        }
        AND candidate.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_v2_effect_outbox AS active
          WHERE active.thread_id = candidate.thread_id
            -- Timeout Stop and successor admission join in the start service.
            -- Both lanes must run for its bounded wait to observe settlement.
            AND NOT (
              (candidate.effect_type = 'provider-turn.start'
                AND active.effect_type = 'provider-turn.interrupt'
                AND COALESCE(json_extract(active.payload_json, '$.startTimeout'), 0) = 1)
              OR (active.effect_type = 'provider-turn.start'
                AND candidate.effect_type = 'provider-turn.interrupt'
                AND COALESCE(json_extract(candidate.payload_json, '$.startTimeout'), 0) = 1)
            )
            -- Native input already arrived; its bookkeeping cannot wait for a start or steer.
            AND candidate.effect_type != 'notification.delivery.accept'
            AND (
              active.status = 'running'
              OR (
                active.status = 'pending'
                AND active.rowid < candidate.rowid
                AND active.effect_type != 'provider-runtime.continue'
                AND NOT (active.effect_type = 'provider-turn.start' AND COALESCE(active.last_error, '') = 'Resuming after restart')
              )
            )
            AND (
              (
                candidate.effect_type = 'thread-title.generate'
                AND active.effect_type = 'thread-title.generate'
              )
              OR
              (
                candidate.effect_type != 'thread-title.generate'
                AND active.effect_type != 'thread-title.generate'
              )
            )
        )
      `;

    const cancellationSignal = (effectId: string) => {
      const existing = cancellationSignals.get(effectId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      cancellationSignals.set(effectId, created);
      return created;
    };

    const decodeRows = (operation: string, rows: ReadonlyArray<EffectRow>) =>
      Effect.forEach(rows, rowToEffect).pipe(
        Effect.mapError((cause) => new EffectOutboxError({ operation, cause })),
      );

    const probeRunContinuation = (threadId: ThreadId) =>
      sql<{ effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
          AND effect_type = 'provider-runtime.continue'
          AND COALESCE(json_extract(payload_json, '$.queued'), 0) <> 1
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows[0]?.effect_id ?? null),
        NodeSqliteClient.readOnly,
      );

    // Rows left by an earlier process. Uses the status-led claim index; until a
    // seed succeeds every probe reads the database, and a failed seed waits 5 s.
    const seedContinuationMarks = marks.seedLock.withPermits(1)(
      Effect.gen(function* () {
        if (marks.seeded || (yield* Clock.currentTimeMillis) < marks.seedRetryAt) return;
        const rows = yield* sql<{ thread_id: string; effect_id: string }>`
          SELECT thread_id, effect_id FROM orchestration_v2_effect_outbox
          WHERE status IN ('pending', 'running')
            AND effect_type = 'provider-runtime.continue'
            AND COALESCE(json_extract(payload_json, '$.queued'), 0) <> 1
        `.pipe(NodeSqliteClient.readOnly);
        for (const row of rows) {
          if (marks.threads.has(row.thread_id)) continue;
          marks.threads.set(row.thread_id, { generation: ++marks.generation, unseen: new Set() });
        }
        marks.seeded = true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            marks.seedRetryAt = (yield* Clock.currentTimeMillis) + 5_000;
            yield* Effect.logWarning("effect_outbox.continuation_seed_failed", { cause });
          }),
        ),
      ),
    );

    const pendingRunContinuation = Effect.fn("EffectOutbox.pendingRunContinuation")(
      function* (threadId: ThreadId) {
        if (!marks.seeded) yield* seedContinuationMarks;
        if (!marks.seeded) return yield* probeRunContinuation(threadId);
        const mark = marks.threads.get(threadId);
        if (mark === undefined) return null;
        const generation = mark.generation;
        const effectId = yield* probeRunContinuation(threadId);
        if (effectId !== null) sawContinuation(marks, threadId, effectId);
        else if (
          marks.threads.get(threadId) === mark &&
          mark.generation === generation &&
          mark.unseen.size === 0
        )
          marks.threads.delete(threadId);
        return effectId;
      },
      Effect.mapError((cause) => new EffectOutboxError({ operation: "get", cause })),
    );

    const service: EffectOutboxV2Shape = {
      enqueue: Effect.fn("EffectOutbox.enqueue")(
        function* (effects) {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          yield* Effect.forEach(
            effects,
            (effect) =>
              sql<{ readonly effect_id: string }>`
              INSERT INTO orchestration_v2_effect_outbox (
                effect_id,
                command_id,
                thread_id,
                effect_type,
                payload_json,
                status,
                attempt_count,
                available_at,
                created_at,
                updated_at
              )
              VALUES (
                ${effect.id},
                ${effect.commandId},
                ${effect.threadId},
                ${effect.request.type},
                ${encodeRequest(effect.request)},
                'pending',
                0,
                ${DateTime.formatIso(effect.availableAt ?? now)},
                ${nowIso},
                ${nowIso}
              )
              ON CONFLICT(effect_id) DO NOTHING
              RETURNING effect_id
            `.pipe(
                Effect.tap((inserted) =>
                  Effect.sync(() => {
                    // Marked before commit: the probe must not miss it once it commits.
                    if (
                      inserted.length > 0 &&
                      effect.request.type === "provider-runtime.continue" &&
                      effect.request.queued !== true
                    )
                      markContinuation(marks, effect.threadId, effect.id);
                  }),
                ),
              ),
            { concurrency: 1, discard: true },
          );
          // EventSink owns the corresponding post-commit notification.
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "enqueue", cause })),
      ),
      get: (effectId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE effect_id = ${effectId}
          LIMIT 1
        `.pipe(
          Effect.flatMap((rows) => {
            const row = rows[0];
            return row === undefined
              ? Effect.succeed(Option.none())
              : rowToEffect(row).pipe(Effect.map(Option.some));
          }),
          Effect.mapError((cause) => new EffectOutboxError({ operation: "get", effectId, cause })),
        ),
      awaitAvailable: Queue.take(available),
      awaitControlAvailable: Queue.take(controlAvailable),
      awaitStartAvailable: Queue.take(startAvailable),
      notifyAvailable,
      listPendingSteerTurns: Effect.fn("EffectOutbox.listPendingSteerTurns")(
        function* (providerSessionId) {
          const rows = yield* sql<{ readonly turn_id: string }>`
            SELECT DISTINCT json_extract(payload_json, '$.providerTurnId') AS turn_id
            FROM orchestration_v2_effect_outbox
            WHERE status IN ('pending', 'running') AND effect_type = 'provider-turn.steer'
              AND json_extract(payload_json, '$.providerSessionId') = ${providerSessionId}
              AND COALESCE(json_extract(payload_json, '$.providerAccepted'), 0) <> 1
          `;
          return rows.map((row) => ProviderTurnId.make(row.turn_id));
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "list", cause })),
      ),
      pendingRunContinuation,
      hasPendingRunContinuation: Effect.fn("EffectOutbox.hasPendingRunContinuation")((threadId) =>
        pendingRunContinuation(threadId).pipe(Effect.map((id) => id !== null)),
      ),
      hasRunContinuationAt: Effect.fn("EffectOutbox.hasRunContinuationAt")(
        function* ({ threadId, requestedAt, startupAt }) {
          // Retirement can beat a racing start claim. Keep only wakes submitted
          // before that retirement in this boot's backlog, even after settlement.
          const rows = yield* sql`
            SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND effect_type = 'provider-runtime.continue'
              AND COALESCE(json_extract(payload_json, '$.queued'), 0) <> 1
              AND (status IN ('pending', 'running') OR (
                completed_at >= ${DateTime.formatIso(requestedAt)}
                AND completed_at >= ${DateTime.formatIso(startupAt)}
              ))
            LIMIT 1
          `;
          return rows.length > 0;
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "get", cause })),
      ),
      hasPendingRunStart: Effect.fn("EffectOutbox.hasPendingRunStart")(
        function* ({ threadId, runIds }) {
          if (runIds.length === 0) return false;
          const rows = yield* sql`
            SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
              AND effect_type = 'provider-turn.start'
              AND json_extract(payload_json, '$.runId') IN ${sql.in(runIds)}
            LIMIT 1
          `;
          return rows.length > 0;
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "get", cause })),
      ),
      listByCommandId: (commandId) =>
        sql<EffectRow>`
          SELECT *
          FROM orchestration_v2_effect_outbox
          WHERE command_id = ${commandId}
          ORDER BY created_at ASC, effect_id ASC
        `.pipe(
          Effect.flatMap((rows) => decodeRows("list", rows)),
          Effect.mapError((cause) =>
            isEffectOutboxError(cause)
              ? cause
              : new EffectOutboxError({ operation: "list", cause }),
          ),
        ),
      cancelUnsettled: Effect.fn("EffectOutbox.cancelUnsettled")(
        function* ({ threadId, runId, effectTypes, reason }) {
          if (effectTypes.length === 0) return [];
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${reason}
            WHERE thread_id = ${threadId}
              AND (${runId ?? null} IS NULL OR json_extract(payload_json, '$.runId') = ${runId ?? null})
              AND status IN ('pending', 'running')
              AND effect_type IN ${sql.in(effectTypes)}
              AND NOT (effect_type = 'provider-turn.steer'
                AND COALESCE(json_extract(payload_json, '$.providerAccepted'), 0) = 1)
            RETURNING effect_id
          `;
          // The update read these rows, so they are committed or settle with its transaction.
          for (const { effect_id } of rows) sawContinuation(marks, threadId, effect_id);
          return rows.map(({ effect_id }) => effect_id);
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "cancel-unsettled", cause })),
      ),
      signalCancellations: Effect.fn("EffectOutbox.signalCancellations")(function* (effectIds) {
        yield* Effect.forEach(
          effectIds,
          (effectId) => {
            const signal = cancellationSignals.get(effectId);
            return signal === undefined ? Effect.void : Deferred.succeed(signal, undefined);
          },
          { discard: true },
        );
        yield* signalSettled(effectIds);
        if (effectIds.length > 0) yield* notifyAvailable(effectIds.length);
      }),
      awaitCancellation: (effectId) => Deferred.await(cancellationSignal(effectId)),
      clearCancellation: (effectId) =>
        Effect.sync(() => {
          cancellationSignals.delete(effectId);
        }),
      awaitSettled: Effect.fn("EffectOutbox.awaitSettled")(function* (effectId) {
        // Registered before the read, so a settle right after it still resolves.
        const signal = settledSignals.get(effectId) ?? Deferred.makeUnsafe<void>();
        settledSignals.set(effectId, signal);
        const effect = yield* service.get(effectId);
        if (Option.exists(effect, ({ status }) => status === "pending" || status === "running")) {
          return yield* Deferred.await(signal);
        }
        yield* signalSettled([effectId]);
      }),
      listStartTimeoutStops: Effect.fn("EffectOutbox.listStartTimeoutStops")(
        function* (threadId) {
          const rows = yield* sql<EffectRow>`
            SELECT * FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.interrupt'
              AND json_extract(payload_json, '$.startTimeout') = 1
              AND status != 'succeeded'
            ORDER BY created_at, effect_id
          `;
          return yield* Effect.forEach(rows, rowToEffect);
        },
        Effect.mapError(
          (cause) => new EffectOutboxError({ operation: "list-start-timeout-stops", cause }),
        ),
      ),
      reconcileAfterProcessLoss: Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const cancelledRows = yield* sql<{ readonly effect_id: string }>`
          UPDATE orchestration_v2_effect_outbox
          SET
            status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = ${now},
            updated_at = ${now},
            last_error = 'Cancelled because the server process ended before the effect completed.'
          WHERE status IN ('pending', 'running')
            AND effect_type IN ${sql.in(PROCESS_BOUND_EFFECT_TYPES)}
            AND NOT (effect_type = 'provider-turn.steer'
              AND (COALESCE(json_extract(payload_json, '$.providerAccepted'), 0) = 1
                OR COALESCE(json_extract(payload_json, '$.followUpPending'), 0) = 1))
          RETURNING effect_id
        `;
        const requeuedRows = yield* sql<{ readonly effect_id: string }>`
          UPDATE orchestration_v2_effect_outbox
          SET
            status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            available_at = ${now},
            updated_at = ${now},
            last_error = 'Requeued after the previous server process ended.'
          WHERE status = 'running'
            AND (effect_type IN ${sql.in(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS)}
              OR (effect_type = 'provider-turn.steer'
                AND (json_extract(payload_json, '$.providerAccepted') = 1
                  OR json_extract(payload_json, '$.followUpPending') = 1)))
          RETURNING effect_id
        `;
        if (requeuedRows.length > 0) yield* notifyAvailable(requeuedRows.length);
        return { requeued: requeuedRows.length, cancelled: cancelledRows.length };
      }).pipe(
        Effect.mapError(
          (cause) => new EffectOutboxError({ operation: "reconcile-process-loss", cause }),
        ),
      ),
      // The worker polls for the next effect even when there is no work to claim.
      claimNext: Effect.fnUntraced(
        function* ({
          workerId,
          threadId,
          leaseDurationMs,
          excludeRestartContinuations = false,
          onlyEffectTypes,
        }) {
          if (onlyEffectTypes?.length === 0) return Option.none();
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const leaseExpiresAt = DateTime.formatIso(
            DateTime.add(now, { milliseconds: Math.max(1, leaseDurationMs) }),
          );
          // Empty safety claims are expected while the daemon is idle. Tracing
          // this query records the full SQL text on every poll and can dominate
          // the local trace without adding actionable information.
          const claimStatement = sql<EffectRow>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'running',
              attempt_count = attempt_count + 1,
              lease_owner = ${workerId},
              lease_expires_at = ${leaseExpiresAt},
              updated_at = ${nowIso},
              last_error = NULL
            WHERE effect_id = (
              SELECT candidate.effect_id
              FROM orchestration_v2_effect_outbox AS candidate
              WHERE ${claimableCandidatePredicate(nowIso)}
                AND ${threadId === undefined ? sql`1 = 1` : sql`candidate.thread_id = ${threadId}`}
                AND ${excludeRestartContinuations ? sql`candidate.effect_type != 'provider-runtime.continue'` : sql`1 = 1`}
                AND ${onlyEffectTypes === undefined ? sql`1 = 1` : sql`candidate.effect_type IN ${sql.in(onlyEffectTypes)}`}
              ORDER BY candidate.available_at ASC, candidate.created_at ASC, candidate.effect_id ASC
              LIMIT 1
            )
            RETURNING *
          `;
          const rows = yield* claimStatement.pipe(Effect.withTracerEnabled(false));
          const row = rows[0];
          if (row === undefined) return Option.none();
          if (row.effect_type === "provider-runtime.continue")
            sawContinuation(marks, row.thread_id, row.effect_id);
          cancellationSignals.set(row.effect_id, Deferred.makeUnsafe<void>());
          return Option.some(yield* rowToEffect(row));
        },
        Effect.mapError((cause) => new EffectOutboxError({ operation: "claim", cause })),
      ),
      listRestartContinuations: Effect.gen(function* () {
        const rows =
          yield* sql<EffectRow>`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-runtime.continue' AND status IN ('pending', 'running') ORDER BY created_at, effect_id`;
        return yield* Effect.forEach(rows, rowToEffect);
      }).pipe(
        Effect.mapError(
          (cause) => new EffectOutboxError({ operation: "list-restart-continuations", cause }),
        ),
      ),
      nextClaimableAt: Effect.gen(function* () {
        const rows = yield* sql<{ readonly available_at: string | null }>`
          SELECT MIN(candidate.available_at) AS available_at
          FROM orchestration_v2_effect_outbox AS candidate
          WHERE ${claimableCandidatePredicate()}
        `.pipe(Effect.withTracerEnabled(false));
        const availableAt = rows[0]?.available_at;
        if (availableAt === undefined || availableAt === null) return Option.none();
        const parsed = DateTime.make(availableAt);
        if (Option.isNone(parsed)) {
          return yield* new EffectOutboxError({
            operation: "next-claimable",
            cause: `Invalid available_at timestamp: ${availableAt}`,
          });
        }
        return parsed;
      }).pipe(
        Effect.mapError((cause) =>
          isEffectOutboxError(cause)
            ? cause
            : new EffectOutboxError({ operation: "next-claimable", cause }),
        ),
      ),
      nextControlClaimableAt: Effect.gen(function* () {
        const rows = yield* sql<{ readonly available_at: string | null }>`
          SELECT MIN(candidate.available_at) AS available_at
          FROM orchestration_v2_effect_outbox AS candidate
          WHERE ${claimableCandidatePredicate()}
            AND candidate.effect_type IN ${sql.in(CONTROL_LANE_EFFECT_TYPES)}
        `.pipe(Effect.withTracerEnabled(false));
        const availableAt = rows[0]?.available_at;
        if (availableAt === undefined || availableAt === null) return Option.none();
        const parsed = DateTime.make(availableAt);
        if (Option.isNone(parsed)) {
          return yield* new EffectOutboxError({
            operation: "next-claimable",
            cause: `Invalid available_at timestamp: ${availableAt}`,
          });
        }
        return parsed;
      }).pipe(
        Effect.mapError((cause) =>
          isEffectOutboxError(cause)
            ? cause
            : new EffectOutboxError({ operation: "next-claimable", cause }),
        ),
      ),
      nextStartClaimableAt: Effect.gen(function* () {
        const rows = yield* sql<{ readonly available_at: string | null }>`
          SELECT MIN(candidate.available_at) AS available_at
          FROM orchestration_v2_effect_outbox AS candidate
          WHERE ${claimableCandidatePredicate()}
            AND candidate.effect_type IN ${sql.in(START_LANE_EFFECT_TYPES)}
        `.pipe(NodeSqliteClient.readOnly, Effect.withTracerEnabled(false));
        const availableAt = rows[0]?.available_at;
        if (availableAt === undefined || availableAt === null) return Option.none();
        const parsed = DateTime.make(availableAt);
        if (Option.isNone(parsed)) {
          return yield* new EffectOutboxError({
            operation: "next-claimable",
            cause: `Invalid available_at timestamp: ${availableAt}`,
          });
        }
        return parsed;
      }).pipe(
        Effect.mapError((cause) =>
          isEffectOutboxError(cause)
            ? cause
            : new EffectOutboxError({ operation: "next-claimable", cause }),
        ),
      ),
      succeed: Effect.fn("EffectOutbox.succeed")(
        function* ({ effectId, workerId }) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'succeeded',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = NULL
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* signalSettled([effectId]);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "succeed", effectId, cause }),
            ),
          ),
      ),
      wakeRestartEffect: Effect.fn("EffectOutbox.wakeRestartEffect")(
        function* (effectId) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET available_at = MIN(available_at, ${now}), updated_at = ${now}
            WHERE effect_id = ${effectId} AND status = 'pending'
              AND effect_type IN ('provider-runtime.continue', 'provider-turn.start')
            RETURNING effect_id
          `;
          if (rows.length > 0) yield* notifyAvailable();
          return rows.length > 0;
        },
        (effect, effectId) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "wake-restart", effectId, cause }),
            ),
          ),
      ),
      retry: Effect.fn("EffectOutbox.retry")(
        function* ({
          effectId,
          workerId,
          error,
          delayMs,
          steerAccepted,
          steerFollowUpPending,
          refundAttempt,
        }) {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const availableAt = DateTime.formatIso(
            DateTime.add(now, { milliseconds: Math.max(0, delayMs) }),
          );
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'pending',
              attempt_count = MAX(0, attempt_count - ${refundAttempt === true ? 1 : 0}),
              available_at = ${availableAt},
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = ${nowIso},
              payload_json = CASE
                WHEN ${steerAccepted === true} AND effect_type = 'provider-turn.steer'
                THEN json_set(payload_json, '$.providerAccepted', json('true'))
                WHEN ${steerFollowUpPending === true} AND effect_type = 'provider-turn.steer'
                THEN json_set(payload_json, '$.followUpPending', json('true'))
                ELSE payload_json END,
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "retry", effectId, cause }),
            ),
          ),
      ),
      fail: Effect.fn("EffectOutbox.fail")(
        function* ({ effectId, workerId, error }) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql<{ readonly effect_id: string }>`
            UPDATE orchestration_v2_effect_outbox
            SET
              status = 'failed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = ${now},
              updated_at = ${now},
              last_error = ${error}
            WHERE effect_id = ${effectId}
              AND status = 'running'
              AND lease_owner = ${workerId}
            RETURNING effect_id
          `;
          if (rows.length === 1) {
            cancellationSignals.delete(effectId);
            yield* signalSettled([effectId]);
            yield* notifyAvailable();
          }
          return rows.length === 1;
        },
        (effect, { effectId }) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new EffectOutboxError({ operation: "fail", effectId, cause }),
            ),
          ),
      ),
      pruneSettled: Effect.gen(function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtractDuration(yield* DateTime.now, SETTLED_EFFECT_RETENTION),
        );
        // Each batch is its own statement, so a large backlog never holds the
        // write lock for long. SQLite otherwise prefers the claim index and
        // scans retained settled rows even when nothing has expired.
        const deleteBatch = sql<{ readonly effect_id: string }>`
          DELETE FROM orchestration_v2_effect_outbox
          WHERE rowid IN (
            SELECT rowid
            FROM orchestration_v2_effect_outbox INDEXED BY orchestration_v2_effect_outbox_settled_idx
            WHERE status IN ('succeeded', 'cancelled')
              AND completed_at < ${cutoff}
            LIMIT ${PRUNE_BATCH_SIZE}
          )
          RETURNING effect_id
        `;
        let pruned = 0;
        while (true) {
          const deleted = (yield* deleteBatch).length;
          pruned += deleted;
          if (deleted < PRUNE_BATCH_SIZE) return pruned;
          yield* Effect.sleep(Duration.millis(50));
        }
      }).pipe(
        Effect.mapError((cause) => new EffectOutboxError({ operation: "prune-settled", cause })),
      ),
    };

    return service;
  }),
);

export const layerPruneWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    yield* forkParked(
      outbox.pruneSettled.pipe(
        Effect.catch((cause) => Effect.logWarning("Failed to prune settled effects", { cause })),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
      ),
    );
  }),
);
