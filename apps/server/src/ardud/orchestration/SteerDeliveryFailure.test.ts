import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as CheckpointRollback from "../../orchestration-v2/CheckpointRollbackService.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderControl from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderStart from "../../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalization from "../../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequests from "../../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitles from "../../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SteerDeliveryFailure from "./SteerDeliveryFailure.ts";
import * as RestartPacingTestkit from "../restart-pacing/RestartPacing.testkit.ts";
import { ProviderPromptAcceptanceError } from "@t3tools/provider-core/server/failure";

const threadId = ThreadId.make("thread:steer-delivery-failure");
const messageId = MessageId.make("message:saved-steer");
const runId = RunId.make("run:actual-steer-target");
const nodeId = NodeId.make("node:actual-steer-target");
const attemptId = RunAttemptId.make("attempt:actual-steer-target");
const providerThreadId = ProviderThreadId.make("provider-thread:actual-steer-target");
const providerTurnId = ProviderTurnId.make("provider-turn:actual-steer-target");
const providerSessionId = ProviderSessionId.make("session:saved-steer");
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-custom");
const now = DateTime.makeUnsafe("2026-11-12T10:00:00Z");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
const effect = {
  id: "effect:saved-steer",
  commandId: CommandId.make("command:saved-steer"),
  threadId,
  request: {
    type: "provider-turn.steer",
    providerSessionId,
    providerThreadId,
    providerTurnId,
    messageId,
  },
  status: "running",
  attemptCount: 3,
  availableAt: DateTime.formatIso(now),
  leaseOwner: "test-worker",
  leaseExpiresAt: DateTime.formatIso(now),
  createdAt: DateTime.formatIso(now),
  updatedAt: DateTime.formatIso(now),
  completedAt: null,
  lastError: "SECRET_PROVIDER_ERROR",
} satisfies EffectOutbox.OrchestrationEffectV2;

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const testLayer = Layer.mergeAll(EventSink.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(stores),
);

const seed = Effect.fn("SteerDeliveryFailureTest.seed")(function* (completion = false) {
  const sink = yield* EventSink.EventSinkV2;
  const base = { threadId, occurredAt: now };
  const events: OrchestrationV2DomainEvent[] = [
    {
      ...base,
      id: EventId.make("event:seed-thread"),
      type: "thread.created",
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:steer-delivery-failure"),
        createdBy: "user",
        creationSource: "web",
        title: "Steer delivery failure",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
      },
    },
    {
      ...base,
      id: EventId.make("event:seed-run"),
      type: "run.updated",
      runId,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:original-run"),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    {
      ...base,
      id: EventId.make("event:seed-provider-thread"),
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      ...base,
      id: EventId.make("event:seed-provider-turn"),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
        finish: null,
      },
    },
    {
      ...base,
      id: EventId.make("event:seed-message"),
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "SECRET_SAVED_MESSAGE",
        ...(completion
          ? {
              delegatedCompletion: {
                parentRunId: runId,
                generation: 1,
                taskIds: [nodeId],
              },
            }
          : {}),
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        creationSource: "web",
      },
    },
  ];
  yield* sink.write({ events });
});

const controlFailure = new ProviderControl.ProviderTurnControlError({
  threadId,
  providerTurnId,
  operation: "steer",
  cause: "SECRET_PROVIDER_ERROR",
});

const executorLayer = (
  steer: ProviderControl.ProviderTurnControlServiceV2Shape["steer"],
  threads: Partial<ThreadManagement.ThreadManagementService["Service"]> = {},
) =>
  EffectWorker.layerExecutor.pipe(
    Layer.provide(RestartPacingTestkit.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderControl.ProviderTurnControlServiceV2)({ steer }),
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderStart.ProviderTurnStartServiceV2)({}),
        Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
        Layer.mock(RunFinalization.RunFinalizationService)({}),
        Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)(threads),
        McpSessionRegistryTestkit.layer,
        ServerSettings.layerTest(),
      ),
    ),
  );

it.effect.each(
  (["timeout", "transport", "acknowledgement"] as const).flatMap((reason) =>
    [false, true].map((turnCompleted) => ({ reason, turnCompleted })),
  ),
)(
  "never replays uncertain steering ($reason, completed=$turnCompleted)",
  ({ reason, turnCompleted }) =>
    Effect.gen(function* () {
      yield* seed();
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const failure = new ProviderPromptAcceptanceError({
        driver: ProviderDriverKind.make("opencode"),
        serverOrigin: "http://opencode.test",
        reason,
        budgetSeconds: 60,
      });
      let calls = 0;
      let followups = 0;
      yield* outbox.enqueue([
        { id: effect.id, commandId: effect.commandId, threadId, request: effect.request },
      ]);
      const layer = EffectWorker.layerWithOptions({ workerId: "uncertain-steer" }).pipe(
        Layer.provide(
          executorLayer(
            () =>
              Effect.suspend(() => {
                calls++;
                return Effect.fail(
                  new ProviderControl.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "steer",
                    turnCompleted,
                    cause: failure,
                  }),
                );
              }),
            {
              getThreadRecords: (id, fields, filter) =>
                projections.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
              dispatch: () =>
                Effect.sync(() => {
                  followups++;
                  return { sequence: 1, storedEvents: [] };
                }),
            },
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.isTrue(yield* worker.runOnce);
        yield* TestClock.adjust("30 seconds");
        assert.isFalse(yield* worker.runOnce);
      }).pipe(Effect.provide(layer));
      assert.equal(calls, 1);
      assert.equal(followups, 0);
      const saved = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(saved));
      if (Option.isNone(saved)) return;
      assert.equal(saved.value.status, "failed");
      const projection = yield* projections.getThreadProjection(threadId);
      assert.lengthOf(projection.visibleTurnItems, 1);
      const notices = projection.turnItems;
      assert.lengthOf(notices, 1);
      const notice = notices[0]!;
      assert.equal(notice.type, "system_notice");
      if (notice.type !== "system_notice") return;
      assert.include(
        notice.message,
        reason === "timeout"
          ? "OpenCode did not confirm prompt acceptance within 60 seconds"
          : reason === "transport"
            ? "OpenCode prompt connection failed"
            : "OpenCode prompt acknowledgement could not be read",
      );
      assert.include(notice.message, "http://opencode.test");
      assert.include(notice.message, "Acceptance is unconfirmed");
      assert.equal(notice.title, "Message delivery unconfirmed");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "persists one visible notice with actual control metadata when the same effect is replayed",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* SteerDeliveryFailure.persist(effect);
      yield* SteerDeliveryFailure.persist(effect);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(threadId);
      assert.lengthOf(projection.turnItems, 1);
      assert.lengthOf(projection.visibleTurnItems, 1);
      const notice = projection.turnItems[0]!;
      assert.equal(notice.type, "system_notice");
      assert.equal(notice.runId, runId);
      assert.equal(notice.nodeId, nodeId);
      assert.equal(notice.providerThreadId, providerThreadId);
      assert.equal(notice.providerTurnId, providerTurnId);
      if (notice.type !== "system_notice") return;
      assert.equal(
        notice.message,
        `Message ${messageId} was saved, but delivery to the provider failed.`,
      );
      assert.notInclude(JSON.stringify(notice), "SECRET");
      const store = yield* EventStore.EventStoreV2;
      const notices = yield* store
        .read({ threadId, eventType: "turn-item.updated" })
        .pipe(Stream.runCollect);
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]!.event.providerInstanceId, providerInstanceId);
      assert.equal(notices[0]!.event.driver, driver);
      assert.equal(projection.messages[0]!.text, "SECRET_SAVED_MESSAGE");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a failed notice write retryable", () =>
  Effect.gen(function* () {
    yield* seed();
    const sink = yield* EventSink.EventSinkV2;
    const failed = yield* SteerDeliveryFailure.persist(effect).pipe(
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        commitCommand: () => Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 1 })),
      }),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(failed));
    yield* SteerDeliveryFailure.persist(effect);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).turnItems, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("publishes only on terminal failure and preserves the original send error", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const retry = yield* executor.execute(effect, { willRetry: true }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(retry));
      assert.lengthOf((yield* projections.getThreadProjection(threadId)).turnItems, 0);
      const terminal = yield* executor.execute(effect, { willRetry: false }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(terminal));
      if (Result.isFailure(terminal)) assert.strictEqual(terminal.failure.cause, controlFailure);
      assert.lengthOf((yield* projections.getThreadProjection(threadId)).visibleTurnItems, 1);
    }).pipe(Effect.provide(executorLayer(() => Effect.fail(controlFailure))));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves the original send error when notice persistence exhausts its retries", () =>
  Effect.gen(function* () {
    yield* seed();
    const sink = yield* EventSink.EventSinkV2;
    let writes = 0;
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const result = yield* executor.execute(effect).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.cause, controlFailure);
      assert.equal(writes, 3);
    }).pipe(
      Effect.provide(executorLayer(() => Effect.fail(controlFailure))),
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        commitCommand: () =>
          Effect.suspend(() => {
            writes += 1;
            return Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 1 }));
          }),
      }),
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not report failure after the completed-turn fallback succeeds", () =>
  Effect.gen(function* () {
    yield* seed();
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    let dispatched = false;
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(
      Effect.provide(
        executorLayer(
          () =>
            Effect.fail(
              new ProviderControl.ProviderTurnControlError({
                ...controlFailure,
                turnCompleted: true,
              }),
            ),
          {
            getThreadRecords: (threadId, fields, filter) =>
              projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
              }).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          },
        ),
      ),
    );
    assert.isTrue(dispatched);
    assert.lengthOf((yield* projections.getThreadProjection(threadId)).turnItems, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { stage: "projection read", willRetry: false },
  { stage: "projection read", willRetry: true },
  { stage: "mailbox acknowledgement", willRetry: false },
  { stage: "mailbox acknowledgement", willRetry: true },
] as const)(
  "does not report delivery failure after acceptance when $stage fails (retry=$willRetry)",
  ({ stage, willRetry }) =>
    Effect.gen(function* () {
      yield* seed(true);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const bookkeepingFailure = new Orchestrator.OrchestratorProjectionError({
        threadId,
        cause: "post-acceptance bookkeeping failed",
      });
      let accepted = 0;
      let acknowledgements = 0;
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const result = yield* executor.execute(effect, { willRetry }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.cause, bookkeepingFailure);
      }).pipe(
        Effect.provide(
          executorLayer(
            () =>
              Effect.sync(() => {
                accepted += 1;
              }),
            {
              getThreadRecords: (id, fields, filter) =>
                stage === "projection read"
                  ? Effect.fail(bookkeepingFailure)
                  : projections
                      .getThreadRecords(id, fields, filter)
                      .pipe(Effect.mapError(() => bookkeepingFailure)),
              dispatch: (command) =>
                Effect.suspend(() => {
                  assert.equal(command.type, "notification.delivery.accept");
                  acknowledgements += 1;
                  return Effect.fail(bookkeepingFailure);
                }),
            },
          ),
        ),
      );
      assert.equal(accepted, 1);
      assert.equal(acknowledgements, stage === "projection read" ? 0 : 1);
      assert.lengthOf((yield* projections.getThreadProjection(threadId)).visibleTurnItems, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("bounds public notice copy even for an oversized message identity", () =>
  Effect.gen(function* () {
    yield* seed();
    yield* SteerDeliveryFailure.persist({
      ...effect,
      request: {
        ...effect.request,
        messageId: MessageId.make(`message:\n${"x".repeat(20_000)}`),
      },
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const notice = (yield* projections.getThreadProjection(threadId)).turnItems[0]!;
    assert.equal(notice.type, "system_notice");
    if (notice.type !== "system_notice") return;
    assert.isBelow(notice.message.length, 300);
    assert.notInclude(notice.message, "\n");
    assert.include(notice.message, "was saved, but delivery to the provider failed.");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { stage: "projection read", recovery: "normal", eventuallySucceeds: false },
  { stage: "mailbox acknowledgement", recovery: "normal", eventuallySucceeds: false },
  { stage: "projection defect", recovery: "normal", eventuallySucceeds: false },
  { stage: "mailbox defect", recovery: "normal", eventuallySucceeds: false },
  { stage: "projection read", recovery: "restart", eventuallySucceeds: false },
  { stage: "mailbox acknowledgement", recovery: "restart", eventuallySucceeds: false },
  { stage: "projection read", recovery: "reschedule failure", eventuallySucceeds: false },
  { stage: "mailbox acknowledgement", recovery: "reschedule failure", eventuallySucceeds: false },
  { stage: "projection read", recovery: "normal", eventuallySucceeds: true },
  { stage: "mailbox acknowledgement", recovery: "normal", eventuallySucceeds: true },
] as const)(
  "keeps acceptance through retries ($stage, $recovery, succeeds=$eventuallySucceeds)",
  ({ stage, recovery, eventuallySucceeds }) =>
    Effect.gen(function* () {
      yield* seed(true);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const bookkeepingFailure = new Orchestrator.OrchestratorProjectionError({
        threadId,
        cause: "bookkeeping failed after acceptance",
      });
      let providerCalls = 0;
      let bookkeepingCalls = 0;
      let failedReschedule = false;
      // Restart recovery claims the accepted effect once without executing it.
      const executions =
        EffectWorker.DEFAULT_MAX_ACCEPTED_ATTEMPTS - (recovery === "restart" ? 1 : 0);
      const projectionFails = stage.startsWith("projection");
      const failure = stage.endsWith("defect")
        ? Effect.die(bookkeepingFailure)
        : Effect.fail(bookkeepingFailure);
      yield* outbox.enqueue([
        { id: effect.id, commandId: effect.commandId, threadId, request: effect.request },
      ]);
      const dependencies = executorLayer(
        () =>
          Effect.suspend(() => {
            providerCalls += 1;
            return providerCalls === 1 ? Effect.void : Effect.fail(controlFailure);
          }),
        {
          getThreadRecords: (id, fields, filter) =>
            Effect.suspend(() => {
              if (projectionFails) {
                bookkeepingCalls += 1;
                if (!eventuallySucceeds || bookkeepingCalls < executions) return failure;
              }
              return projections
                .getThreadRecords(id, fields, filter)
                .pipe(Effect.mapError(() => bookkeepingFailure));
            }),
          dispatch: (command) =>
            Effect.suspend(() => {
              assert.equal(command.type, "notification.delivery.accept");
              if (!projectionFails) {
                bookkeepingCalls += 1;
                if (!eventuallySucceeds || bookkeepingCalls < executions) return failure;
              }
              return Effect.succeed({ sequence: 1, storedEvents: [] });
            }),
        },
      );
      for (let attempt = 1; attempt <= executions; attempt += 1) {
        // A fresh executor each attempt excludes process-local acceptance caches.
        const layer = EffectWorker.layerWithOptions({ workerId: "acceptance-test" }).pipe(
          Layer.provide(dependencies),
        );
        const outcome = yield* Effect.gen(function* () {
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          return yield* worker.runOnce;
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(EffectOutbox.EffectOutboxV2, {
            ...outbox,
            retry: (input) =>
              Effect.suspend(() => {
                if (recovery === "reschedule failure" && !failedReschedule) {
                  failedReschedule = true;
                  return Effect.fail(
                    new EffectOutbox.EffectOutboxError({
                      operation: "retry",
                      effectId: input.effectId,
                    }),
                  );
                }
                return outbox.retry(input);
              }),
          }),
          Effect.result,
        );
        if (recovery === "reschedule failure" && attempt === 1)
          assert.isTrue(Result.isFailure(outcome));
        else assert.isTrue(Result.isSuccess(outcome));
        const persisted = yield* outbox.get(effect.id);
        assert.isTrue(Option.isSome(persisted));
        if (Option.isNone(persisted)) return;
        assert.equal(persisted.value.request.type, "provider-turn.steer");
        if (attempt < executions) {
          if (persisted.value.request.type === "provider-turn.steer")
            assert.isTrue(persisted.value.request.providerAccepted);
          if (recovery === "restart" && attempt === 1) {
            yield* outbox.enqueue([
              {
                id: "effect:unaccepted",
                commandId: effect.commandId,
                threadId,
                request: effect.request,
              },
            ]);
            yield* TestClock.adjust("30 seconds");
            const claimed = yield* outbox.claimNext({
              workerId: "lost-process",
              leaseDurationMs: 30_000,
            });
            assert.isTrue(Option.isSome(claimed));
            assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
              requeued: 1,
              cancelled: 1,
            });
            // Runtime reconciliation must preserve accepted bookkeeping in both cancellation paths.
            assert.deepEqual(
              yield* outbox.cancelUnsettled({
                threadId,
                effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
                reason: "Lost native session",
              }),
              [],
            );
          }
          yield* TestClock.adjust("30 seconds");
        } else assert.equal(persisted.value.status, eventuallySucceeds ? "succeeded" : "failed");
      }
      assert.equal(providerCalls, 1);
      assert.equal(bookkeepingCalls, executions);
      assert.lengthOf((yield* projections.getThreadProjection(threadId)).visibleTurnItems, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves accepted input while refunding an outbox retry attempt", () =>
  Effect.gen(function* () {
    yield* seed();
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([
      { id: effect.id, commandId: effect.commandId, threadId, request: effect.request },
    ]);
    for (const markAccepted of [true, false]) {
      const claimed = yield* outbox.claimNext({ workerId: "both-flags", leaseDurationMs: 30_000 });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isNone(claimed)) return;
      assert.equal(claimed.value.attemptCount, 1);
      assert.isTrue(
        yield* outbox.retry({
          effectId: effect.id,
          workerId: "both-flags",
          error: "Retry bookkeeping",
          delayMs: 0,
          refundAttempt: true,
          ...(markAccepted ? { steerAccepted: true } : {}),
        }),
      );
      const saved = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(saved));
      if (Option.isNone(saved)) return;
      assert.equal(saved.value.attemptCount, 0);
      assert.equal(saved.value.request.type, "provider-turn.steer");
      if (saved.value.request.type === "provider-turn.steer")
        assert.isTrue(saved.value.request.providerAccepted);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([false, true])(
  "preserves acceptance and the attempt refund through deferral (write fails=%s)",
  (failFirstWrite) =>
    Effect.gen(function* () {
      yield* seed();
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue([
        { id: effect.id, commandId: effect.commandId, threadId, request: effect.request },
      ]);
      let failed = false;
      const outcome = yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        return yield* worker.runOnce;
      }).pipe(
        Effect.provide(EffectWorker.layerWithOptions({ workerId: "both-flags" })),
        Effect.provideService(EffectWorker.OrchestrationEffectExecutorV2, {
          execute: () =>
            Effect.fail(
              new EffectWorker.OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                providerAccepted: true,
                deferMs: 100,
              }),
            ),
        }),
        Effect.provideService(EffectOutbox.EffectOutboxV2, {
          ...outbox,
          retry: (input) =>
            Effect.suspend(() => {
              if (failFirstWrite && !failed) {
                failed = true;
                return Effect.fail(new EffectOutbox.EffectOutboxError({ operation: "retry" }));
              }
              return outbox.retry(input);
            }),
        }),
        Effect.result,
      );
      assert.equal(Result.isFailure(outcome), failFirstWrite);
      const saved = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(saved));
      if (Option.isNone(saved)) return;
      assert.equal(saved.value.status, "pending");
      assert.equal(saved.value.attemptCount, 0);
      if (saved.value.request.type === "provider-turn.steer")
        assert.isTrue(saved.value.request.providerAccepted);
    }).pipe(Effect.provide(testLayer)),
);
