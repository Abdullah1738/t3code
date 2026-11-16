import { PROVIDER_START_CLEANUP_TIMEOUT_MS } from "./providerStartDeadlinePolicy.ts";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  MessageId,
  ProviderInstanceId,
  standardModelSelection,
  type OrchestrationV2Run,
  NodeId,
  OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Orchestrator from "./Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RestartPacing from "../ardud/restart-pacing/RestartPacing.ts";
import * as RestartPacingState from "../ardud/restart-pacing/RestartPacingState.ts";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as RestartPacingTestkit from "../ardud/restart-pacing/RestartPacing.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const replacementSessionId = ProviderSessionId.make(
  "provider-session:effect-worker-restart:replacement",
);
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");
const decodeProjection = Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection);

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

it.effect("delivers deadline cleanup to the exact turn after its start effect settled", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const stopped: Array<
      Parameters<ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"]>[0]
    > = [];
    const now = yield* DateTime.now;
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      ...restartEffect(now, { type: "detach" }),
      request: {
        type: "provider-turn.interrupt",
        startTimeout: true,
        providerSessionId: oldSessionId,
        providerThreadId,
        providerTurnId,
      },
    };
    const layer = layerExecutorFor({
      events,
      interrupt: (input) =>
        Effect.sync(() => {
          stopped.push(input);
        }),
    });
    yield* (yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(Effect.provide(layer))).execute(
      effect,
    );
    assert.lengthOf(stopped, 1);
    assert.equal(stopped[0]?.providerTurnId, providerTurnId);
    assert.isFalse(stopped[0]?.stopBackgroundWork);
  }),
);

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly restartInterrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interruptAndAwaitTerminal"];
  readonly detach?: ProviderSessionManager.ProviderSessionManagerV2["Service"]["detach"];
  readonly stopBackgroundWork?: ProviderSessionManager.ProviderSessionManagerV2Shape["stopBackgroundWork"];
  readonly isSessionLive?: ProviderSessionManager.ProviderSessionManagerV2Shape["isLive"];
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly start?: ProviderTurnStartService.ProviderTurnStartServiceV2["Service"]["start"];
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly mcpRegistry?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
  readonly pacing?: Layer.Layer<RestartPacing.RestartPacing>;
  readonly projections?: Partial<ProjectionStore.ProjectionStoreV2Shape>;
}) {
  let restartRun: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("test"),
    modelSelection: standardModelSelection({
      instanceId: ProviderInstanceId.make("test"),
      model: "test",
    }),
    providerThreadId,
    userMessageId: MessageId.make("test-message"),
    rootNodeId: NodeId.make("test-root"),
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: DateTime.makeUnsafe(0),
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: () => Effect.void,
        interruptAndAwaitTerminal:
          input.restartInterrupt ??
          ((request) =>
            record(
              request.replacementProviderSessionId === undefined
                ? "interrupt"
                : `interrupt:${request.replacementProviderSessionId}`,
            )),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        stopBackgroundWork: input.stopBackgroundWork ?? (() => Effect.succeed([])),
        shutdown: Effect.void,
        sweepOrphanedThreads: () => Effect.void,
        observeThreadSessionUpdates: () => Effect.void,
        refreshThreadSessionUpdates: () => Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeed(Option.none()),
        isLive: input.isSessionLive ?? (() => Effect.succeed(false)),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        release: () => record("release"),
        detach: input.detach ?? (() => record("detach")),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start:
          input.start ??
          (() =>
            Effect.gen(function* () {
              yield* record("start");
              if (
                input.failFirstStart !== undefined &&
                (yield* Ref.getAndSet(input.failFirstStart, false))
              ) {
                return yield* new ProviderTurnStartService.ProviderTurnStartError({
                  runId,
                  cause: "simulated first start failure",
                });
              }
            })),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({ respond: () => Effect.void }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(EffectOutbox.EffectOutboxV2)({ get: () => Effect.succeed(Option.none()) }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: (input) =>
            Effect.sync(() => {
              if (
                restartRun.activeAttemptId !== input.activeAttemptId ||
                restartRun.status !== input.expectedStatus
              )
                return { committed: false, storedEvents: [] };
              for (const event of input.events)
                if (event.type === "run.updated") restartRun = event.payload;
              return { committed: true, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.sync(() => ({ runs: [restartRun] }) as never),
          ...input.projections,
        }),
        input.pacing ??
          RestartPacingTestkit.layer.pipe(
            Layer.provide(
              ServerSettings.layerTest(
                input.continueAfterRestart === true
                  ? { continueThreadsAfterServerUpdate: true }
                  : {},
              ),
            ),
          ),
        input.mcpRegistry ?? McpSessionRegistryTestkit.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

it("does not retry pure interrupt races where the turn is already gone", () => {
  assert.isTrue(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ProviderAdapterInterruptError: ... ACP provider turn provider-turn:x is not active",
    ),
  );
  assert.isTrue(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.restart",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.start",
      "Provider session provider-session:x is not active.",
    ),
  );
  assert.isFalse(
    EffectWorker.isNonRetryableProviderTurnControlFailure(
      "provider-turn.interrupt",
      "ACP hard teardown failed unexpectedly; the session is poisoned",
    ),
  );
});

it.effect("executes and surfaces failures from thread credential revocation", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const revoked: string[] = [];
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: "effect:credential-revoke",
      commandId: CommandId.make("command:credential-revoke"),
      threadId,
      request: { type: "mcp-credential.revoke-thread" },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      leaseExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    const execute = (fail: boolean) =>
      Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        return yield* Effect.exit(executor.execute(effect));
      }).pipe(
        Effect.provide(
          layerExecutorFor({
            events,
            mcpRegistry: Layer.succeed(
              McpSessionRegistry.McpSessionRegistry,
              McpSessionRegistry.McpSessionRegistry.of({
                issue: () => Effect.die("unused"),
                resolve: () => Effect.succeed(undefined),
                touch: () => Effect.void,
                revokeProviderSession: () => Effect.void,
                revokeAll: Effect.void,
                revokeThread: (id) =>
                  fail
                    ? Effect.die("database unavailable")
                    : Effect.sync(() => {
                        revoked.push(id);
                      }),
              }),
            ),
          }),
        ),
      );
    assert.isTrue(Exit.isSuccess(yield* execute(false)));
    assert.deepEqual(revoked, [threadId]);
    assert.isTrue(Exit.isFailure(yield* execute(true)));
  }),
);

it.effect("settles a stopped run when its adapter has already lost the native turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          cause: "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), ["thread.background-work.settle"]);
  }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  },
])("reports a rollback blocked by $name only after the last attempt", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      rollback: () => Effect.fail(failure),
      threads: {
        dispatch: (command) =>
          Ref.update(failures, (current) =>
            command.type === "checkpoint.rollback.fail" ? [...current, command.message] : current,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const rollback: EffectOutbox.OrchestrationEffectV2 = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: rollbackCheckpointId,
          scopeId: rollbackScopeId,
          restoreFiles: true,
        },
      };
      yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
      assert.deepEqual(yield* Ref.get(failures), []);
      yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(failures), [message]);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("requeues a replay-safe claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-settlement-failure";
    const workerId = "worker-replay-safe-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated replay-safe settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({ execute: () => Effect.void }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retries), 1);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a process-bound executor failure retryable when retry settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-retry-settlement-failure";
    const workerId = "worker-process-bound-retry-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-retry-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-retry-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-retry-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retryAttempts = yield* Ref.make(0);
    const terminalizations = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      retry: () =>
        Ref.updateAndGet(retryAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutbox.EffectOutboxError({
                    operation: "retry",
                    effectId,
                    cause: "simulated retry settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      fail: () => Ref.update(terminalizations, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new EffectWorker.OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated provider execution failure",
            }),
          ),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(retryAttempts), 2);
    assert.equal(yield* Ref.get(terminalizations), 0);
  }),
);

it.effect("keeps a max-attempt replay-safe failure terminal when fail settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-replay-safe-terminal-settlement-failure";
    const workerId = "worker-replay-safe-terminal-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-replay-safe-terminal-settlement-failure"),
      threadId: ThreadId.make("thread:worker-replay-safe-terminal-settlement-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 5,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const failAttempts = yield* Ref.make(0);
    const retries = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      fail: () =>
        Ref.updateAndGet(failAttempts, (count) => count + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.fail(
                  new EffectOutbox.EffectOutboxError({
                    operation: "fail",
                    effectId,
                    cause: "simulated terminal settlement failure",
                  }),
                )
              : Effect.succeed(true),
          ),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.fail(
            new EffectWorker.OrchestrationEffectExecutionError({
              effectId,
              effectType: claimedEffect.request.type,
              cause: "simulated terminal cleanup failure",
            }),
          ),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId, maxAttempts: 5 }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(failAttempts), 2);
    assert.equal(yield* Ref.get(retries), 0);
  }),
);

it.effect("uses durable deadlines, notifications, and a slow liveness poll", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const available = yield* Queue.unbounded<void>();
    const now = yield* DateTime.now;
    const nextClaimableAt = yield* Ref.make<Option.Option<DateTime.Utc>>(
      Option.some(DateTime.add(now, { milliseconds: 100 })),
    );
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Queue.take(available),
      awaitStartWork: Effect.never,
      runStartOnce: Effect.succeed(false),
      nextStartClaimableAt: Effect.succeed(Option.none()),
      awaitControlWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runControlOnce: Effect.succeed(false),
      nextControlClaimableAt: Effect.succeed(Option.none()),
      runOnce: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(attempts, (current) => current + 1);
        if (count === 2) {
          yield* Ref.set(nextClaimableAt, Option.some(DateTime.add(now, { milliseconds: 5_000 })));
        }
        if (count === 3) yield* Ref.set(nextClaimableAt, Option.none());
        return false;
      }),
      nextClaimableAt: Ref.get(nextClaimableAt),
      drain: () => Effect.succeed(0),
    });
    const awaitAttempts = Effect.fnUntraced(function* (expected: number) {
      while ((yield* Ref.get(attempts)) < expected) {
        yield* Effect.yieldNow;
      }
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      controlLaneConcurrency: 0,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    yield* awaitAttempts(1);
    yield* TestClock.adjust("99 millis");
    assert.equal(yield* Ref.get(attempts), 1);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(2);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 2);

    yield* Queue.offer(available, undefined);
    yield* awaitAttempts(3);
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 3);

    yield* TestClock.adjust("1 millis");
    yield* awaitAttempts(4);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not hot-loop when a claim fails", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      awaitStartWork: Effect.never,
      runStartOnce: Effect.succeed(false),
      nextStartClaimableAt: Effect.succeed(Option.none()),
      awaitControlWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runControlOnce: Effect.succeed(false),
      nextControlClaimableAt: Effect.succeed(Option.none()),
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(
        Effect.andThen(
          new EffectWorker.OrchestrationEffectWorkerError({
            operation: "claim",
            cause: "simulated database failure",
          }),
        ),
      ),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      controlLaneConcurrency: 0,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("999 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("backs off briefly when a due deadline loses a claim race", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const now = yield* DateTime.now;
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      awaitStartWork: Effect.never,
      runStartOnce: Effect.succeed(false),
      nextStartClaimableAt: Effect.succeed(Option.none()),
      awaitControlWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runControlOnce: Effect.succeed(false),
      nextControlClaimableAt: Effect.succeed(Option.none()),
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(Effect.as(false)),
      nextClaimableAt: Effect.succeed(Option.some(now)),
      drain: () => Effect.succeed(0),
    });

    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 1,
      controlLaneConcurrency: 0,
      livenessPollIntervalMs: 1_000,
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );

    while ((yield* Ref.get(attempts)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust("24 millis");
    assert.equal(yield* Ref.get(attempts), 1);
    yield* TestClock.adjust("1 millis");
    while ((yield* Ref.get(attempts)) < 2) yield* Effect.yieldNow;
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("safely retries after replacement cleanup succeeds and start fails", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const failFirstStart = yield* Ref.make(true);
    const effect = restartEffect(now, {
      type: "replace",
      replacementProviderSessionId: replacementSessionId,
    });
    const layer = layerExecutorFor({ events, failFirstStart });

    const first = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(executor.execute(effect));
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.isFailure(first));

    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute(effect);
    }).pipe(Effect.provide(layer));

    assert.deepEqual(yield* Ref.get(events), [
      `interrupt:${replacementSessionId}`,
      "detach",
      "start",
      "start",
    ]);
  }),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      leaseExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);

it.effect.each([
  "provider-turn.start",
  "provider-runtime.continue",
  "queued continuation",
  "held queued continuation",
] as const)("settles an expired restart admission for %s without offering native work", (type) =>
  Effect.gen(function* () {
    const queued = type === "queued continuation" || type === "held queued continuation";
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const now = yield* DateTime.now;
    const base = restartEffect(now, { type: "detach" });
    const effect = {
      ...base,
      request:
        type === "provider-turn.start"
          ? { type, runId }
          : {
              type: "provider-runtime.continue" as const,
              sourceRunId: runId,
              ...(queued ? { queued: true } : {}),
            },
    };
    let admissions = 0;
    const expire = Effect.sync(() => {
      admissions++;
    }).pipe(
      Effect.andThen(
        Effect.fail(new RestartPacing.RestartAdmissionTimeoutError({ deadline: now })),
      ),
    );
    const layer = layerExecutorFor({
      events,
      pacing: Layer.mock(RestartPacing.RestartPacing)({
        settingsSnapshot: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          continueThreadsAfterServerUpdate: true,
        }),
        acquireRun: () => expire,
        acquire: () => expire,
        dispatched: () => Effect.void,
        release: () => Effect.void,
        releaseRun: () => Effect.void,
      }),
      projections: {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              {
                id: runId,
                activeAttemptId: attemptId,
                status: queued ? "queued" : "starting",
                queueHeld: type === "held queued continuation",
              },
            ],
          } as never),
      },
      threads: {
        getThreadRecords: () =>
          Effect.succeed({
            ...queuedProjection,
            runs: [
              {
                ...queuedProjection.runs[0]!,
                status: queued ? "queued" : "cancelled",
                queueHeld: type === "held queued continuation",
                startedAt: queued ? null : now,
                completedAt: queued ? null : now,
              },
            ],
            messages: [
              {
                id: queuedProjection.runs[0]!.userMessageId,
                threadId,
                runId,
                nodeId: null,
                role: "user",
                text: "Work",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "user",
                creationSource: "web",
              },
            ],
          } as typeof queuedProjection),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 0, storedEvents: [] };
          }),
        recoverDelegatedTask: () =>
          Ref.update(events, (events) => [...events, "recover-delegation"]),
      },
    });
    yield* (yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(Effect.provide(layer))).execute(
      effect,
    );
    assert.deepEqual(
      yield* Ref.get(events),
      type === "provider-runtime.continue" || type === "held queued continuation"
        ? ["recover-delegation"]
        : [],
    );
    assert.equal(admissions, type === "held queued continuation" ? 0 : 1);
    if (type !== "provider-runtime.continue" && type !== "held queued continuation")
      assert.deepEqual(commands, [
        {
          type: "run.start-expire",
          phase: "restart_admission",
          commandId: CommandId.make(
            `${effect.id}:${type === "queued continuation" ? "queued-admission-expired" : "admission-expired"}`,
          ),
          threadId,
          runId,
          expectedAttemptId: attemptId,
          deadline: now,
        },
      ]);
    else assert.deepEqual(commands, []);
  }),
);

it.effect.each(["interrupt", "detach"] as const)(
  "bounds the compound restart before native admission when %s never answers",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const expired: Array<
        Parameters<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>[0]
      > = [];
      const layer = layerExecutorFor({
        events,
        restartInterrupt: () =>
          stage === "interrupt"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        detach: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        threads: {
          dispatch: (command) =>
            Effect.sync(() => {
              expired.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
        },
      });
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
        Effect.provide(layer),
      );
      const execution = yield* executor
        .execute(restartEffect(yield* DateTime.now, { type: "detach" }))
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(PROVIDER_START_CLEANUP_TIMEOUT_MS);
      assert.equal((yield* Fiber.join(execution))._tag, "Failure");
      assert.deepEqual(yield* Ref.get(events), []);
      assert.deepEqual(expired, []);
    }).pipe(Effect.scoped),
);

const slotTime = DateTime.makeUnsafe(0);
const queuedProjection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
  thread: {
    id: threadId,
    projectId: ProjectId.make("project:slot"),
    title: "Restart slot",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: slotTime,
    updatedAt: slotTime,
    archivedAt: null,
    deletedAt: null,
    createdBy: "system",
    creationSource: "server",
  },
  runs: [
    {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      providerThreadId,
      userMessageId: "message:slot",
      rootNodeId: "node:slot",
      activeAttemptId: attemptId,
      status: "queued",
      queueHeld: false,
      queuePosition: 1,
      requestedAt: slotTime,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: slotTime,
});

const slotPacing = RestartPacing.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ServerSettings.layerTest({ restartPacing: { maxActive: 1, spacingMs: 0 } }),
      Layer.succeed(RestartPacing.RestartLoad, () => 0),
      Layer.succeed(RestartPacingState.RestartPacingState, {
        wake: () => Effect.succeed(true),
        hasSuccessor: () => Effect.succeed(false),
        describe: () => Effect.succeed({ priority: 3, activityAt: 0 }),
        pending: () => Effect.succeed(true),
        sourceForRun: (threadId, sourceRunId) => Effect.succeed({ threadId, sourceRunId }),
        active: () => Effect.succeed(true),
        status: () => Effect.succeed(true),
      }),
    ),
  ),
  Layer.orDie,
);

it.effect("a failed admitted continuation cannot block the next outbox provider start", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const executor = layerExecutorFor({
      events,
      pacing: slotPacing,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.succeed(queuedProjection),
        dispatch: (command) =>
          Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "dispatch failed",
            }),
          ),
        recoverDelegatedTask: () => Effect.void,
      },
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([
        {
          id: "slot:continuation",
          commandId: CommandId.make("slot:continue"),
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: runId, queued: true },
        },
        {
          id: "slot:start",
          commandId: CommandId.make("slot:start"),
          threadId: ThreadId.make("thread:next"),
          request: { type: "provider-turn.start", runId: RunId.make("run:next") },
        },
      ]);
      yield* worker.drain();
      assert.deepEqual(yield* Ref.get(events), ["start"]);
      assert.equal(Option.getOrThrow(yield* outbox.get("slot:start")).status, "succeeded");
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(
          Layer.provideMerge(
            Layer.merge(
              executor,
              EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect.each(["defect", "cancelled"] as const)(
  "an admitted continuation releases on %s",
  (outcome) =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const entered = yield* Deferred.make<void>();
      const executorLayer = layerExecutorFor({
        events,
        pacing: slotPacing,
        continueAfterRestart: true,
        threads: {
          getThreadRecords: () => Effect.succeed(queuedProjection),
          dispatch: () =>
            outcome === "defect"
              ? Effect.die("dispatch defect")
              : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          recoverDelegatedTask: () => Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const pacing = yield* RestartPacing.RestartPacing;
        const effect = {
          ...restartEffect(yield* DateTime.now, { type: "detach" }),
          request: { type: "provider-runtime.continue" as const, sourceRunId: runId, queued: true },
        };
        const fiber = yield* executor.execute(effect).pipe(Effect.forkChild);
        if (outcome === "cancelled") {
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        }
        assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
        assert.equal(
          yield* pacing.acquire({
            threadId: ThreadId.make("thread:next"),
            sourceRunId: RunId.make("run:next"),
          }),
          0,
        );
      }).pipe(Effect.provide(Layer.merge(executorLayer, slotPacing)));
    }),
);

it.effect.each(["success", "failure", "defect", "cancelled"] as const)(
  "a provider start releases its admission on %s",
  (outcome) =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const entered = yield* Deferred.make<void>();
      const executorLayer = layerExecutorFor({
        events,
        pacing: slotPacing,
        start: () =>
          outcome === "success"
            ? Effect.void
            : outcome === "failure"
              ? Effect.fail(
                  new ProviderTurnStartService.ProviderTurnStartError({
                    runId,
                    cause: "start failed",
                  }),
                )
              : outcome === "defect"
                ? Effect.die("start defect")
                : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const pacing = yield* RestartPacing.RestartPacing;
        const effect = {
          ...restartEffect(yield* DateTime.now, { type: "detach" }),
          request: { type: "provider-turn.start" as const, runId },
        };
        const fiber = yield* executor.execute(effect).pipe(Effect.forkChild);
        if (outcome === "cancelled") {
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        }
        const exit = yield* Fiber.await(fiber);
        assert.equal(Exit.isSuccess(exit), outcome === "success");
        assert.equal(
          yield* pacing.acquire({
            threadId: ThreadId.make("thread:next"),
            sourceRunId: RunId.make("run:next"),
          }),
          0,
        );
      }).pipe(Effect.provide(Layer.merge(executorLayer, slotPacing)));
    }),
);

it.effect("retries native settlement after cancellation already released its session", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const live = yield* Ref.make(true);
    const failSettlement = yield* Ref.make(true);
    let settlements = 0;
    const layer = layerExecutorFor({
      events,
      isSessionLive: () => Ref.get(live),
      stopBackgroundWork: () =>
        Ref.getAndSet(live, false).pipe(Effect.map((wasLive) => (wasLive ? [oldSessionId] : []))),
      threads: {
        dispatch: (command) =>
          Effect.gen(function* () {
            settlements++;
            if (yield* Ref.getAndSet(failSettlement, false))
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "transient write failure",
              });
            return { sequence: 1, storedEvents: [] };
          }),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const effect = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-session.stop-background-work",
          throughRunOrdinal: 1,
          runAttempts: [],
          onlyIfCancelled: true,
          backgroundThreads: [
            { providerSessionId: oldSessionId, providerThreadId, providerTurnId },
          ],
        },
      } satisfies EffectOutbox.OrchestrationEffectV2;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(executor.execute(effect))));
      assert.isFalse(yield* Ref.get(live));
      yield* executor.execute(effect);
      assert.equal(settlements, 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("long preparation does not discard an admitted provider start's retry", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    let starts = 0;
    const commands: string[] = [];
    const executorLayer = layerExecutorFor({
      events,
      pacing: slotPacing,
      start: () =>
        Effect.suspend(() => {
          starts++;
          return starts === 1
            ? TestClock.adjust("31 minutes").pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderTurnStartService.ProviderTurnStartError({
                      runId,
                      cause: "retryable preparation failure before native admission",
                    }),
                  ),
                ),
              )
            : Effect.void;
        }),
      threads: {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command.type);
            return { sequence: 0, storedEvents: [] };
          }),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const effect = {
        ...restartEffect(yield* DateTime.now, { type: "detach" }),
        request: { type: "provider-turn.start" as const, runId },
      };
      const first = yield* executor.execute(effect, { willRetry: true }).pipe(Effect.result);
      assert.equal(first._tag, "Failure");
      yield* executor.execute(effect, { willRetry: true });
      assert.equal(starts, 2, "the admitted retry must reach ProviderTurnStartService");
      assert.deepEqual(commands, []);
    }).pipe(Effect.provide(Layer.merge(executorLayer, slotPacing)));
  }),
);

it.effect.each([
  "reset",
  "interrupted",
  "superseded",
  "provider-changed",
  "valid",
  "settings-failed",
] as const)("a %s continuation retires before restart admission when it cannot dispatch", (kind) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const source = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      providerThreadId,
      userMessageId: "message:source",
      rootNodeId: "node:source",
      activeAttemptId: attemptId,
      status: "cancelled",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    let projection = yield* decodeProjection({
      thread: {
        id: threadId,
        projectId: "project:source",
        title: "Source",
        providerInstanceId: "codex",
        modelSelection: source.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      },
      runs: kind === "reset" ? [] : [source],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [
        {
          id: source.userMessageId,
          threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Work",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: "user",
          creationSource: "web",
        },
      ],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: now,
    });
    if (kind === "interrupted")
      projection = {
        ...projection,
        turnItems: [{ runId, type: "run_interrupt_request" } as never],
      };
    if (kind === "superseded")
      projection = {
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            id: RunId.make("run:newer"),
            ordinal: 2,
            status: "completed",
            startedAt: DateTime.add(now, { seconds: 1 }),
          },
        ],
      };
    if (kind === "provider-changed")
      projection = {
        ...projection,
        thread: {
          ...projection.thread,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
      };
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    let settingsReads = 0;
    let dispatches = 0;
    let settingsUnavailable = kind === "settings-failed";
    const executor = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.succeed(projection),
        recoverDelegatedTask: () => Effect.void,
        dispatch: () =>
          kind === "settings-failed"
            ? Effect.sync(() => {
                dispatches++;
                return {} as never;
              })
            : Effect.die("admission is held"),
      },
      pacing: Layer.succeed(RestartPacing.RestartPacing, {
        settingsSnapshot: Effect.suspend(() => {
          settingsReads++;
          return settingsUnavailable
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "fixture",
                  operation: "read-file",
                  cause: "transient read failure",
                }),
              )
            : Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                continueThreadsAfterServerUpdate: true,
              });
        }),
        register: () => Effect.void,
        release: () => Effect.void,
        releaseRun: () => Effect.void,
        dispatched: () => Effect.void,
        acquireRun: () => Effect.succeed(0),
        acquire: () => Effect.succeed(kind === "settings-failed" ? 0 : 15000),
      }),
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* outbox.enqueue([
        {
          id: "effect:stale-continuation",
          commandId: CommandId.make("command:stale-continuation"),
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: runId },
        },
      ]);
      assert.isTrue(yield* outbox.hasPendingRunContinuation(threadId));
      yield* worker.drain();
      const pending = kind === "valid" || kind === "settings-failed";
      assert.equal(yield* outbox.hasPendingRunContinuation(threadId), pending);
      assert.equal(
        Option.getOrThrow(yield* outbox.get("effect:stale-continuation")).status,
        pending ? "pending" : "succeeded",
      );
      if (kind === "settings-failed") {
        assert.equal(settingsReads, 1);
        assert.equal(dispatches, 0);
        settingsUnavailable = false;
        yield* TestClock.adjust("100 millis");
        yield* worker.drain();
        assert.equal(dispatches, 1);
        assert.isFalse(yield* outbox.hasPendingRunContinuation(threadId));
        assert.equal(
          Option.getOrThrow(yield* outbox.get("effect:stale-continuation")).status,
          "succeeded",
        );
      }
    }).pipe(
      Effect.provide(
        EffectWorker.layer.pipe(
          Layer.provide(executor),
          Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        ),
      ),
    );
  }),
);

it.effect.each(["owner message", "owner continuation", "agent wake"] as const)(
  "a superseded recovery wake preserves distinct queued input: %s",
  (kind) =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const now = yield* DateTime.now;
      const queuedId = RunId.make("run:thread:preserved:ordinal:3");
      const newerId = RunId.make("run:thread:preserved:ordinal:12");
      const queued = {
        ...queuedProjection.runs[0]!,
        id: queuedId,
        ordinal: 3,
        ...(kind === "owner continuation"
          ? { restartContinuationOfRunId: RunId.make("run:thread:preserved:ordinal:2") }
          : {}),
      };
      let projection = yield* decodeProjection({
        ...queuedProjection,
        runs: [
          queued,
          {
            ...queued,
            id: newerId,
            ordinal: 12,
            status: "interrupted",
            userMessageId: MessageId.make("message:newer-interrupted"),
          },
        ],
        messages: [
          {
            id: queued.userMessageId,
            threadId,
            runId: queuedId,
            nodeId: null,
            role: "user",
            text: "Keep this distinct queued request",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "agent wake" ? "agent" : "user",
            creationSource: kind === "agent wake" ? "server" : "web",
          },
          {
            id: MessageId.make("message:newer-interrupted"),
            threadId,
            runId: newerId,
            nodeId: null,
            role: "user",
            text: "Unrelated work already in flight",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "agent",
            creationSource: "server",
          },
        ],
      });
      const pacing = RestartPacing.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ restartPacing: { spacingMs: 20_000 } }),
            Layer.succeed(RestartPacing.RestartLoad, () => 2),
            Layer.succeed(RestartPacingState.RestartPacingState, {
              wake: () => Effect.succeed(true),
              hasSuccessor: () => Effect.succeed(true),
              describe: () => Effect.succeed({ priority: 0, activityAt: 0 }),
              pending: () => Effect.succeed(true),
              sourceForRun: () => Effect.succeed(undefined),
              active: () => Effect.succeed(false),
              status: () => Effect.succeed(true),
            }),
          ),
        ),
      );
      const prepared = Layer.effect(
        RestartPacing.RestartPacing,
        Effect.gen(function* () {
          const service = yield* RestartPacing.RestartPacing;
          yield* service.register({ threadId, sourceRunId: newerId });
          return service;
        }),
      ).pipe(Layer.provide(pacing), Layer.orDie);
      const layer = layerExecutorFor({
        events,
        pacing: prepared,
        continueAfterRestart: true,
        projections: { getThreadRecords: () => Effect.succeed(projection) },
        threads: {
          getThreadRecords: () => Effect.succeed(projection),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "queued-run.cancel")
                projection = {
                  ...projection,
                  runs: projection.runs.map((run) =>
                    run.id === command.runId ? { ...run, status: "cancelled" as const } : run,
                  ),
                };
              return { sequence: 0, storedEvents: [] };
            }),
        },
      });
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
        Effect.provide(layer),
      );
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: { type: "provider-runtime.continue", sourceRunId: queuedId, queued: true },
      });
      assert.equal(projection.runs.find((run) => run.id === queuedId)?.status, "queued");
      assert.equal(projection.messages[0]?.text, "Keep this distinct queued request");
      assert.deepEqual(yield* Ref.get(events), []);
    }),
);
