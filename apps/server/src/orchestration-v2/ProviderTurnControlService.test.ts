import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KanbanBoardId,
  KanbanCardId,
  KanbanDiscussionId,
  KanbanScriptId,
  type KanbanDiscussion,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PROVIDER_START_CLEANUP_TIMEOUT_MS } from "./providerStartDeadlinePolicy.ts";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  ProviderPromptAcceptanceError,
} from "@t3tools/provider-core/server/failure";
import * as Result from "effect/Result";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as KanbanStore from "../ardud/kanban/store/KanbanStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          listCutoverCandidates: () => Effect.die("unused listCutoverCandidates"),
          getLiveSharedProviderSessions: () => Effect.die("unused getLiveSharedProviderSessions"),
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          pageActiveThreadIds: () => Effect.die("unused pageActiveThreadIds"),
          listActiveThreadIds: () => Effect.die("unused listActiveThreadIds"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadListCandidates: () => Effect.die("unused getThreadListCandidates"),
          getCallerRow: () => Effect.die("unused getCallerRow"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadIdsForWorktree: () => Effect.die("unused getThreadIdsForWorktree"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getRunControlState: () => Effect.die("unused getRunControlState"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getPullRequestSyncSnapshot: () => Effect.die("unused PR metadata read"),
          getProviderThreadsByNativeIds: () => Effect.die("unused native ID read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          stopBackgroundWork: () => Effect.succeed([]),
          shutdown: Effect.void,
          sweepOrphanedThreads: () => Effect.void,
          observeThreadSessionUpdates: () => Effect.void,
          refreshThreadSessionUpdates: () => Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(Layer.merge(layerProjection, layerSessionManager)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
      yield* Ref.set(interruptedThread, null);
      yield* Ref.update(projection, (state) => ({
        ...state,
        providerTurns: state.providerTurns.map((turn) => ({
          ...turn,
          status: "running" as const,
          completedAt: null,
        })),
      }));
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const unrelated = yield* control
          .interrupt({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            stopBackgroundWork: false,
          })
          .pipe(Effect.result);
        assert.equal(unrelated._tag, "Failure");
        assert.isNull(yield* Ref.get(interruptedThread));
        yield* control.interrupt({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          stopBackgroundWork: false,
        });
      }).pipe(Effect.provide(layerControl));
      assert.equal((yield* Ref.get(interruptedThread))?.providerSessionId, oldSessionId);
    }),
);

// Antigravity (ACP): session/cancel resolves the prompt within milliseconds and the
// adapter finalizes the turn, but the run's ingestion can sit behind a backlog of
// projection writes for longer than the 30 second restart cleanup deadline. The
// replacement was then dropped although the native turn had already ended.
it.effect.each(["cancelled by the restart", "ended before the restart", "still running"] as const)(
  "restart cleanup settles on native turn end while the projected ACP turn lags: %s",
  (nativeState) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const acpDriver = ProviderDriverKind.make("antigravity");
      const threadId = ThreadId.make("thread:acp-restart-lag");
      const providerSessionId = ProviderSessionId.make("provider-session:acp-restart-lag");
      const providerTurnId = ProviderTurnId.make("provider-turn:acp-restart-lag");
      const attemptId = RunAttemptId.make("run-attempt:acp-restart-lag");
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("provider-thread:acp-restart-lag"),
        driver: acpDriver,
        providerInstanceId: ProviderInstanceId.make("antigravity"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: acpDriver, nativeId: "acp-session", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      // The superseded attempt is settled; the projected turn never leaves "running".
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId,
        attemptId,
      });
      // Native end evidence the session manager keeps from the adapter's
      // `turn.terminal` (nativeWorkEnded) as it leaves the event pump.
      const nativeEnded = yield* Ref.make(nativeState === "ended before the restart");
      const interrupts = yield* Ref.make(0);
      const runtime = {
        interruptTurn: () =>
          Ref.update(interrupts, (count) => count + 1).pipe(
            Effect.andThen(
              nativeState === "cancelled by the restart" ? Ref.set(nativeEnded, true) : Effect.void,
            ),
          ),
        hasObservedTurnEnd: (target: { providerThreadId: string; providerTurnId: string }) =>
          Ref.get(nativeEnded).pipe(
            Effect.map(
              (ended) =>
                ended &&
                target.providerThreadId === providerThread.id &&
                target.providerTurnId === providerTurnId,
            ),
          ),
      };
      const cleanup = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        return yield* control
          .interruptAndAwaitTerminal({
            threadId,
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId,
            interruptedAttemptId: attemptId,
          })
          .pipe(Effect.exit);
      }).pipe(
        Effect.provide(
          ProviderTurnControlService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getProviderControlContext: () =>
                    Effect.succeed({
                      providerThread,
                      providerTurn: projection.providerTurns[0],
                      attempt: projection.attempts[0],
                    } as never),
                }),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                  get: () =>
                    Effect.succeedSome(
                      runtime as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                    ),
                }),
              ),
            ),
          ),
        ),
      );
      assert.equal(yield* Ref.get(interrupts), 1);
      // Without native end evidence the cleanup still waits for the projection.
      assert.equal(
        cleanup._tag,
        nativeState === "still running" ? "Failure" : "Success",
        nativeState,
      );
    }),
);

it.effect.each(["confirmed", "unanswered"] as const)(
  "bounds targeted parked-turn cleanup without stopping inherited work: %s",
  (cleanup) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("expired-parked");
      const sessionId = ProviderSessionId.make("expired-parked-session");
      const turnId = ProviderTurnId.make("expired-parked-turn");
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("expired-parked-thread"),
        driver,
        providerInstanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId: turnId,
        attemptId: RunAttemptId.make("expired-parked-attempt"),
      });
      const requests: Array<
        Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"]>[0]
      > = [];
      const entered = yield* Deferred.make<void>();
      const runtime = {
        interruptTurn: (request: (typeof requests)[number]) =>
          Effect.sync(() => {
            requests.push(request);
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(cleanup === "unanswered" ? Effect.never : Effect.void),
          ),
      };
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const stopping = yield* control
          .interrupt({
            threadId,
            providerSessionId: sessionId,
            providerThreadId: providerThread.id,
            providerTurnId: turnId,
            stopBackgroundWork: false,
          })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        if (cleanup === "unanswered") yield* TestClock.adjust(PROVIDER_START_CLEANUP_TIMEOUT_MS);
        assert.equal(
          (yield* Fiber.join(stopping))._tag,
          cleanup === "confirmed" ? "Success" : "Failure",
        );
      }).pipe(
        Effect.provide(
          ProviderTurnControlService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getProviderControlContext: () =>
                    Effect.succeed({
                      providerThread,
                      providerTurn: {
                        ...projection.providerTurns[0]!,
                        status: "failed",
                        completedAt: now,
                      },
                      attempt: projection.attempts[0],
                    } as never),
                }),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                  get: () =>
                    Effect.succeedSome(
                      runtime as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                    ),
                }),
              ),
            ),
          ),
        ),
      );
      assert.lengthOf(requests, 1);
      assert.equal(requests[0]?.providerTurnId, turnId);
      assert.isFalse(requests[0]?.requestRuntimeRestart);
      assert.isFalse(requests[0]?.stopBackgroundWork);
    }).pipe(Effect.scoped),
);

it.effect.each([
  { reason: null, recovery: "live" },
  ...(["timeout", "transport", "acknowledgement"] as const).flatMap((reason) =>
    (
      ["live", "released", "replaced", "session read failure", "projection read failure"] as const
    ).map((recovery) => ({ reason, recovery })),
  ),
])(
  "cited steering preserves acceptance before recovery ($reason, $recovery)",
  ({ reason, recovery }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:steer-citation");
      const providerSessionId = ProviderSessionId.make("provider-session:steer-citation");
      const providerTurnId = ProviderTurnId.make("provider-turn:steer-citation");
      const attemptId = RunAttemptId.make("run-attempt:steer-citation");
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("provider-thread:steer-citation"),
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread:steer-citation", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId,
        attemptId,
      });
      const text = `Revisit ${serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("environment:steer-citation"),
        threadId,
        messageId: MessageId.make("message:steer-citation:source"),
        text: "Ship it on Friday.",
        start: 0,
        end: 18,
        prefix: "",
        suffix: "",
      })}`;
      const message = {
        id: MessageId.make("message:steer-citation"),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      } as unknown as OrchestrationV2ConversationMessage;
      const steered = yield* Ref.make<ReadonlyArray<string>>([]);
      const failure =
        reason === null
          ? null
          : new ProviderPromptAcceptanceError({
              driver: ProviderDriverKind.make("opencode"),
              serverOrigin: "http://opencode.test",
              reason,
              budgetSeconds: 60,
            });
      let attempted = false;
      let recoveryReads = 0;
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "running",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: (input) =>
          Ref.update(steered, (texts) => [...texts, input.message.text]).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                attempted = true;
                return failure === null
                  ? Effect.void
                  : Effect.fail(
                      new ProviderAdapter.ProviderAdapterSteerRunError({
                        driver,
                        providerThreadId: providerThread.id,
                        providerTurnId,
                        cause: failure,
                      }),
                    );
              }),
            ),
          ),
        interruptTurn: () => Effect.die("unused interruptTurn"),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () =>
                Effect.suspend(() => {
                  if (attempted) {
                    recoveryReads++;
                    if (recovery === "projection read failure")
                      return Effect.fail(
                        new ProjectionStore.ProjectionStoreReadError({ threadId }),
                      );
                  }
                  return Effect.succeed({
                    providerThread,
                    providerTurn: projection.providerTurns[0],
                    attempt: projection.attempts[0],
                    message,
                    run: { id: RunId.make("run:steer-citation") } as OrchestrationV2Run,
                  });
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.suspend(() => {
                  if (attempted) {
                    recoveryReads++;
                    if (recovery === "released") return Effect.succeedNone;
                    if (recovery === "replaced") return Effect.succeedSome({ ...runtime });
                    if (recovery === "session read failure")
                      return Effect.fail(
                        new ProviderSessionManager.ProviderSessionLookupError({
                          providerSessionId,
                        }),
                      );
                  }
                  return Effect.succeedSome(runtime);
                }),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const result = yield* control
          .steer({
            threadId,
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId,
            messageId: message.id,
          })
          .pipe(Effect.result);
        if (failure === null) assert.isTrue(Result.isSuccess(result));
        else {
          assert.isTrue(Result.isFailure(result));
          if (Result.isSuccess(result)) return;
          const persisted = makeProviderFailure({ cause: result.failure });
          assert.equal(persisted.code, `provider_prompt_acceptance_${reason}`);
          assert.equal(persisted.category, "transient");
          assert.equal(persisted.retryable, false);
          assert.equal(recoveryReads, 0);
        }
      }).pipe(Effect.provide(layerControl));

      assert.deepEqual(yield* Ref.get(steered), [expandAssistantCitationsForProvider(text)]);
    }),
);

it.effect.each([
  "pending",
  "read-through pending",
  "answered",
  "answered then newer",
  "settled",
  "archived",
  "invalid identity",
] as const)("#1603 native recovery steering rechecks %s at execution", (state) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:steer-citation");
    const providerSessionId = ProviderSessionId.make("provider-session:steer-citation");
    const providerTurnId = ProviderTurnId.make("provider-turn:steer-citation");
    const attemptId = RunAttemptId.make("run-attempt:steer-citation");
    const providerThread: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make("provider-thread:steer-citation"),
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-thread:steer-citation", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const projection = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
    const text = "Retained original script body";
    const store = yield* KanbanStore.KanbanStore;
    const discussion: KanbanDiscussion = {
      id: KanbanDiscussionId.make("disc-steer-1603"),
      boardId: KanbanBoardId.make("robob"),
      cardId: KanbanCardId.make("card-steer-1603"),
      title: "Recovery steering",
      evaluatorThreadId: threadId,
      participants: [],
      lastSeq: 1,
      lastMessageAt: null,
      createdBy: { _tag: "owner" },
      createdAt: DateTime.formatIso(now),
      archivedAt: null,
      titleEditedAt: null,
      settledAt: null,
      snoozedUntil: null,
      pinnedAt: null,
      reopenedAt: null,
    };
    const post = {
      discussionId: discussion.id,
      seq: 1,
      author: { _tag: "script", scriptId: KanbanScriptId.make("script-steer-1603") } as const,
      authorName: "Sweep",
      blocks: [{ _tag: "md", text }] as const,
      answers: [],
      createdAt: discussion.createdAt,
    };
    yield* store.putDiscussion(discussion);
    yield* store.putMessage(post);
    const message = {
      id: MessageId.make(
        state === "invalid identity"
          ? "kanban:post-recovery:%:1:retained"
          : `kanban:post-recovery:${discussion.id}:1:retained`,
      ),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    } as unknown as OrchestrationV2ConversationMessage;
    const steered = yield* Ref.make<ReadonlyArray<string>>([]);
    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId,
      providerSession: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "running",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.empty,
      ensureThread: () => Effect.die("unused ensureThread"),
      resumeThread: () => Effect.die("unused resumeThread"),
      startTurn: () => Effect.die("unused startTurn"),
      steerTurn: (input) => Ref.update(steered, (texts) => [...texts, input.message.text]),
      interruptTurn: () => Effect.die("unused interruptTurn"),
      respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
      readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
      rollbackThread: () => Effect.die("unused rollbackThread"),
      forkThread: () => Effect.die("unused forkThread"),
    };
    const layerControl = ProviderTurnControlService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getProviderControlContext: () =>
              Effect.succeed({
                providerThread,
                providerTurn: projection.providerTurns[0],
                attempt: projection.attempts[0],
                message,
                run: { id: RunId.make("run:steer-citation") } as OrchestrationV2Run,
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.gen(function* () {
                // The durable steering effect already captured this message. Its
                // reply/closure lands while that effect loads the live session.
                if (state.startsWith("answered"))
                  yield* store.putMessage({
                    ...post,
                    seq: 2,
                    author: { _tag: "evaluator", threadId },
                  });
                if (state === "read-through pending" || state === "answered then newer")
                  yield* store.putMessage({ ...post, seq: 3, author: { _tag: "owner" } });
                yield* store.putDiscussion({
                  ...discussion,
                  lastSeq:
                    state === "read-through pending" || state === "answered then newer"
                      ? 3
                      : state === "answered"
                        ? 2
                        : 1,
                  participants: [
                    {
                      actor: { _tag: "evaluator", threadId },
                      name: "Evaluator",
                      lastReadSeq: 3,
                      typingUntil: null,
                      owes: "asked",
                    },
                  ],
                  settledAt: state === "settled" ? discussion.createdAt : null,
                  archivedAt: state === "archived" ? discussion.createdAt : null,
                });
                return Option.some(runtime);
              }).pipe(Effect.orDie),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      yield* control.steer({
        threadId,
        providerSessionId,
        providerThreadId: providerThread.id,
        providerTurnId,
        messageId: message.id,
      });
    }).pipe(Effect.provide(layerControl));

    assert.deepEqual(yield* Ref.get(steered), state.endsWith("pending") ? [text] : []);
  }).pipe(Effect.provide(KanbanStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect.each([
  { driver: "codex", result: "terminal" },
  { driver: "opencode", result: "terminal" },
  { driver: "claudeAgent", result: "terminal" },
  { driver: "codex", result: "idle" },
  { driver: "opencode", result: "timeout" },
  { driver: "opencode", result: "synthetic" },
  { driver: "claudeAgent", result: "unregistered" },
  { driver: "claudeAgent", result: "observed-native-only" },
  { driver: "codex", result: "observed-known-turn" },
] as const)(
  "confirms start-expire Stop on $driver via $result without stopping a shared session",
  (row) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("expiry-confirm");
      const sessionId = ProviderSessionId.make("shared-expiry-session");
      const turnId = ProviderTurnId.make("expired-turn");
      const attemptId = RunAttemptId.make("expired-attempt");
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("expired-thread"),
        driver: ProviderDriverKind.make(row.driver),
        providerInstanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = makeProjection({
        now,
        threadId,
        providerThread,
        providerTurnId: turnId,
        attemptId,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const stopEntered = yield* Deferred.make<void>();
      const ignored = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      let interrupts = 0;
      let closedSubscriptions = 0;
      const runtime = {
        hasObservedTurnEnd: (
          target: Parameters<
            NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["hasObservedTurnEnd"]>
          >[0],
        ) =>
          Effect.sync(() => {
            assert.equal(target.providerThreadId, providerThread.id);
            assert.equal(target.providerTurnId, turnId);
            assert.equal(
              target.attemptId,
              row.result === "observed-native-only" || row.result === "unregistered"
                ? attemptId
                : undefined,
            );
            return row.result === "observed-native-only" || row.result === "observed-known-turn";
          }),
        subscribeEvents: Effect.succeed({
          events: Stream.fromQueue(events).pipe(
            Stream.tap((event) =>
              event.type === "turn.terminal" &&
              (event.providerTurnId !== turnId || event.nativeWorkEnded !== true)
                ? Deferred.succeed(ignored, undefined)
                : Effect.void,
            ),
          ),
          close: Effect.sync(() => {
            closedSubscriptions++;
          }),
        }),
        holdsWorkForThread: () =>
          Effect.succeed(row.result !== "idle" && row.result !== "unregistered"),
        interruptTurn: (
          request: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"]>[0],
        ) =>
          Effect.sync(() => {
            interrupts++;
            assert.equal(request.providerTurnId, turnId);
            assert.isFalse(request.requestRuntimeRestart);
            assert.isFalse(request.stopBackgroundWork);
          }).pipe(Effect.andThen(Deferred.succeed(stopEntered, undefined))),
        interruptStartingRun: (
          request: Parameters<
            NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptStartingRun"]>
          >[0],
        ) =>
          Effect.sync(() => {
            interrupts++;
            assert.equal(request.attemptId, attemptId);
            assert.isFalse(request.stopBackgroundWork);
          }).pipe(Effect.andThen(Deferred.succeed(stopEntered, undefined))),
      };
      const layer = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () =>
                Effect.succeed({
                  providerThread,
                  providerTurn:
                    row.result === "unregistered" || row.result === "observed-native-only"
                      ? undefined
                      : {
                          ...projection.providerTurns[0]!,
                          status: "failed",
                          completedAt: now,
                        },
                  attempt: projection.attempts[0],
                  message: undefined,
                  run: undefined,
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeedSome(
                  runtime as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const stopping = yield* control
          .interrupt({
            threadId,
            providerSessionId: sessionId,
            providerThreadId: providerThread.id,
            providerTurnId: turnId,
            stopBackgroundWork: false,
            confirmStopped: true,
            ...(row.result === "unregistered" || row.result === "observed-native-only"
              ? { startingRun: { runId: RunId.make("expired-run"), attemptId, runOrdinal: 1 } }
              : {}),
          })
          .pipe(
            Effect.result,
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(stopEntered);
        if (row.result === "terminal" || row.result === "timeout" || row.result === "synthetic") {
          yield* Queue.offer(events, {
            type: "turn.terminal",
            ...(row.result === "synthetic" ? {} : { nativeWorkEnded: true as const }),
            driver,
            providerThreadId: providerThread.id,
            providerTurnId:
              row.result === "synthetic" ? turnId : ProviderTurnId.make("sibling-live-turn"),
            runOrdinal: 2,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Deferred.await(ignored);
          assert.isFalse(yield* Deferred.isDone(finished));
          if (row.result === "timeout") yield* TestClock.adjust(PROVIDER_START_CLEANUP_TIMEOUT_MS);
          else
            yield* Queue.offer(events, {
              type: "turn.terminal",
              nativeWorkEnded: true,
              driver,
              providerThreadId: providerThread.id,
              providerTurnId: turnId,
              runOrdinal: 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
        }
        const result = yield* Fiber.join(stopping);
        assert.equal(result._tag, row.result === "timeout" ? "Failure" : "Success");
        assert.equal(interrupts, 1);
        assert.equal(closedSubscriptions, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
