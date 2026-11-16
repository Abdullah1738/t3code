import {
  PROVIDER_START_CLEANUP_TIMEOUT_MS,
  PROVIDER_START_TIMEOUT_MS,
  withoutProviderStartDeadline,
} from "./providerStartDeadlinePolicy.ts";
import { isAutomaticClaudeRecovery } from "./launchRecovery.ts";
import { isRecoveredQueueRun, markInstallLifecycle } from "../ardud/fast-install/report.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
// ardud: the restart note checks OpenCode children before it says they were cancelled.
import { restartNoteText } from "../ardud/opencode-import/ChildSessions.ts";
import { CodexHistoryNotSentError } from "../ardud/harness-migrate/CodexHistoryDeliveryError.ts";
import * as KanbanStore from "../ardud/kanban/store/KanbanStore.ts";
import { ownerReplyDiscussion, ownerReplyPending } from "../ardud/kanban/engine/ownerReplyWake.ts";
// ardud: unconfirmed native history must not be replaced by a lossy handoff.
import { isClaudeSeeded, seededUnconfirmed } from "../ardud/harness-migrate/seededGuard.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  makeProviderFailure,
  withPreviousFailure,
} from "@t3tools/provider-core/server/failure";
import { providerUserMessageText } from "./ProviderMessageText.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ProviderStartProgress from "../ardud/orchestration/ProviderStartProgress.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

/** These refusals leave inline context handoffs unsent and safe to restore. */
const refusedBeforePrompt = (error: unknown): boolean =>
  Predicate.isTagged(error, "ClaudeBackgroundWorkBlocksQueryReplacementError") ||
  Predicate.isTagged(error, "ProviderAdapterRecoveryRefusedError") ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const activeTurnRefusal = (
  error: unknown,
): ProviderAdapter.ProviderAdapterProtocolError | undefined =>
  isProtocolError(error) && error.reason === "previous_turn_active"
    ? error
    : Predicate.hasProperty(error, "cause")
      ? activeTurnRefusal(error.cause)
      : undefined;

const codexHistoryNotSent = (error: unknown): boolean =>
  error instanceof CodexHistoryNotSentError ||
  (Predicate.hasProperty(error, "cause") && codexHistoryNotSent(error.cause));

// Only a native resume refusal proves that this turn's prompt was never offered.
const missingCodexRollout = (error: unknown, nativeId: string | null | undefined): boolean =>
  (nativeId != null &&
    Schema.is(ProviderAdapter.ProviderAdapterResumeThreadError)(error) &&
    error.driver === "codex" &&
    Predicate.isTagged(error.cause, "CodexAppServerRequestError") &&
    Predicate.hasProperty(error.cause, "code") &&
    error.cause.code === -32600 &&
    Predicate.hasProperty(error.cause, "method") &&
    error.cause.method === "thread/resume" &&
    Predicate.hasProperty(error.cause, "errorMessage") &&
    error.cause.errorMessage === `no rollout found for thread id ${nativeId}`) ||
  (Predicate.hasProperty(error, "cause") && missingCodexRollout(error.cause, nativeId));

const nativeThreadHasRecordedTurns = (
  thread: OrchestrationV2ProviderThread,
  records: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
) =>
  thread.nativeConversationHeadRef !== null ||
  thread.forkedFrom !== null ||
  records.providerTurns.some((turn) => {
    if (turn.providerThreadId !== thread.id) return false;
    const attempt = records.attempts.find((candidate) => candidate.id === turn.runAttemptId);
    // Legacy/provider-native turns have no native-thread attribution. Keep their history.
    return (
      attempt?.nativeThreadId === undefined ||
      attempt.nativeThreadId === thread.nativeThreadRef?.nativeId
    );
  });

// These getters outlive startup while background work runs. Capture only execution rows.
const bindProviderExecution = (
  input: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
  current: Pick<
    RunExecutionService.RunExecutionServiceV2StartRootRunInput,
    "providerThread" | "attempt"
  >,
) => ({
  ...input,
  get providerThread() {
    return current.providerThread;
  },
  get attempt() {
    return current.attempt;
  },
});

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const kanban = yield* Effect.serviceOption(KanbanStore.KanbanStore);
    const startProgress = yield* Effect.serviceOption(ProviderStartProgress.ProviderStartProgress);
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    const loadRunCancelMetadata = Effect.fn("ProviderTurnStartService.loadRunCancelMetadata")(
      (threadId: ThreadId, runId: RunId) =>
        projectionStore
          .getThreadRecords(threadId, ["runs", "turnItems"], {
            runIds: [runId],
            turnItemRunIds: [runId],
            turnItemTypes: ["run_interrupt_request"],
          })
          .pipe(
            Effect.map(({ runs, turnItems }) => {
              const recorded = runs[0];
              if (
                recorded?.cancelReason !== undefined &&
                ["cancelled", "interrupted"].includes(recorded.status)
              )
                return {
                  cancelReason: recorded.cancelReason,
                  cancelDetail: recorded.cancelDetail,
                };
              const request = turnItems.findLast((item) => item.type === "run_interrupt_request");
              return {
                cancelReason: request?.cancelReason ?? runs[0]?.cancelReason,
                cancelDetail:
                  request?.cancelReason === undefined
                    ? runs[0]?.cancelDetail
                    : request.message === "Interrupt requested"
                      ? undefined
                      : request.message.slice(0, 500),
              };
            }),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
    );

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly parentThreadId: ThreadId | null;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      // One run row by primary key: these checks run about six times per turn start and
      // once at finalize, on the main-thread writer.
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore
          .getRunControlState(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && run.status === expectedStatus,
            ),
          );
      return {
        isCurrentAttemptInStatus,
        loadRecoveryAdmission: (expected: OrchestrationV2ProviderThread) =>
          projectionStore
            .getThreadRecords(input.threadId, ["runs", "providerThreads"], {
              runIds: [input.runId],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((row) => row.id === input.runId);
                const providerThread = records.providerThreads.find(
                  (row) => row.id === expected.id,
                );
                // Both decisions come from one transaction, for the native identity being offered.
                return {
                  current:
                    run?.activeAttemptId === input.attemptId &&
                    run.status === "running" &&
                    run.providerThreadId === expected.id &&
                    providerThread?.driver === expected.driver &&
                    providerThread.providerInstanceId === expected.providerInstanceId &&
                    providerThread.nativeThreadRef?.nativeId === expected.nativeThreadRef?.nativeId,
                  refused: providerThread?.nativeMetadata?.claudeRefusalObserved === true,
                };
              }),
            ),
        loadClaudeRefusal: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["providerThreads"])
            .pipe(
              Effect.map(
                (records) =>
                  records.providerThreads.find((row) => row.id === input.providerThreadId)
                    ?.nativeMetadata?.claudeRefusalObserved === true,
              ),
            ),
        loadDelegatedTask: () =>
          input.parentThreadId === null
            ? Effect.succeed(undefined)
            : projectionStore
                .getThreadRecords(input.parentThreadId, ["subagents"])
                .pipe(
                  Effect.map((parent) =>
                    parent.subagents.find((task) => task.childThreadId === input.threadId),
                  ),
                ),
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        loadRunCancelMetadata: () => loadRunCancelMetadata(input.threadId, input.runId),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemRunIds: [input.runId],
              turnItemTypes: ["run_interrupt_request"],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const reason = turnItems.find(
                  (item) => item.type === "run_interrupt_request",
                )?.message;
                return reason === "Interrupt requested" ? undefined : reason;
              }),
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
        shouldFinalizeRun: () =>
          projectionStore
            .getRunControlState(input.threadId, input.runId)
            .pipe(
              Effect.map(
                (run) =>
                  run?.activeAttemptId === input.attemptId &&
                  (run.status === "starting" || run.status === "running"),
              ),
            ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
      };
    };

    const makeRecoverySession = (
      liveSession: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      isIncomingRunCurrent: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>,
      loadRecoveryAdmission?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadRecoveryAdmission"],
      recoverResume?: (
        input: ProviderAdapter.ProviderAdapterV2TurnInput,
        compact: boolean,
        error: ProviderAdapter.ProviderAdapterV2Error,
      ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
    ) => {
      const handlesResume = recoverResume !== undefined;
      let recover = recoverResume;
      const startWithRecovery = Effect.fn("ProviderTurnStartService.startWithRecovery")(
        function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput, compact = false) {
          const start = compact ? liveSession.compactThread! : liveSession.startTurn;
          if (Option.isSome(startProgress))
            yield* startProgress.value.step(
              {
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                attemptId: turnInput.attemptId,
              },
              "start_send",
            );
          const readFailure = (cause: unknown) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: liveSession.driver,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              ...(refusedBeforePrompt(cause) ? { code: "provider_prompt_not_sent" as const } : {}),
              cause,
            });
          const incomingIsCurrent = Effect.suspend(() =>
            loadRecoveryAdmission === undefined
              ? isIncomingRunCurrent()
              : loadRecoveryAdmission(turnInput.providerThread).pipe(
                  Effect.flatMap((admission) =>
                    !admission.current
                      ? Effect.succeed(false)
                      : admission.refused
                        ? Effect.fail(new ProviderAdapter.ProviderAdapterRecoveryRefusedError())
                        : Effect.succeed(true),
                  ),
                ),
          ).pipe(Effect.mapError(readFailure));
          // Handoff delivery and stale-turn Stop can await after outer admission.
          // Guard the first native offer and the one native retry at this boundary.
          if (loadRecoveryAdmission !== undefined && !(yield* incomingIsCurrent)) return;
          const result = yield* Effect.result(start(turnInput));
          if (result._tag === "Success") return;
          if (handlesResume) {
            if (
              recover !== undefined &&
              missingCodexRollout(
                result.failure,
                turnInput.providerThread.nativeThreadRef?.nativeId,
              )
            )
              return yield* recover(turnInput, compact, result.failure);
            return yield* result.failure;
          }
          const stale = activeTurnRefusal(result.failure)?.activeTurn;
          if (stale === undefined || stale.providerThreadId !== turnInput.providerThread.id) {
            return yield* result.failure;
          }
          const owner = yield* projectionStore
            .getRunControlState(turnInput.threadId, stale.runId)
            .pipe(Effect.mapError(readFailure));
          // A different incoming run is not proof that the old turn lost ownership.
          // Missing projection state is also inconclusive; leave that turn alone.
          const terminal =
            owner !== null &&
            ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
              owner.status,
            );
          if (owner === null || (!terminal && owner.activeAttemptId === stale.attemptId)) {
            return yield* result.failure;
          }
          if (!(yield* incomingIsCurrent)) return;
          yield* liveSession
            .interruptTurn({
              providerThread: turnInput.providerThread,
              providerTurnId: stale.providerTurnId,
              requestRuntimeRestart: false,
              stopBackgroundWork: false,
            })
            .pipe(Effect.timeout(PROVIDER_START_CLEANUP_TIMEOUT_MS), Effect.mapError(readFailure));
          if (!(yield* incomingIsCurrent)) return;
          // Exactly one retry: another refusal belongs to normal start-failure handling.
          yield* start(turnInput);
        },
        Effect.ensuring(
          Effect.sync(() => {
            recover = undefined;
          }),
        ),
      );
      return {
        ...liveSession,
        startTurn: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          startWithRecovery(turnInput),
        ...(liveSession.compactThread === undefined
          ? {}
          : {
              compactThread: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                startWithRecovery(turnInput, true),
            }),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    // Restart workers keep this session too; its callbacks must not capture startup's projection.
    const makeResumedSession = (session: ProviderAdapter.ProviderAdapterV2SessionRuntime) => ({
      ...session,
      startTurn: (input: Parameters<typeof session.startTurn>[0]) =>
        Effect.sync(() => markInstallLifecycle("firstResumedProviderRequestAt")).pipe(
          Effect.andThen(session.startTurn(input)),
        ),
      ...(session.compactThread === undefined
        ? {}
        : {
            compactThread: (input: Parameters<typeof session.startTurn>[0]) =>
              Effect.sync(() => markInstallLifecycle("firstResumedProviderRequestAt")).pipe(
                Effect.andThen(session.compactThread!(input)),
              ),
          }),
    });

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    source.status === "cancelled" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId &&
                          message.attachments.length === 0 &&
                          message.text.trim().toLowerCase() === "/compact",
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const progressAttempt = { threadId: input.threadId, runId, attemptId: attempt.id };
      const finishUsage = yield* runExecution.prepareUsageBeforeStart({
        loadCancelMetadata: () => loadRunCancelMetadata(projection.thread.id, run.id),
        appThread: projection.thread,
        run,
        attempt,
        providerThread,
        modelSelection: run.modelSelection,
      });
      // Stop may have committed before registration observed its event.
      const registeredRun = yield* projectionStore
        .getRunControlState(projection.thread.id, run.id)
        .pipe(Effect.option);
      if (Option.isSome(registeredRun) && registeredRun.value !== null) {
        const current = registeredRun.value;
        if (current.status === "interrupted" || current.status === "cancelled") {
          yield* finishUsage(current.status);
          return;
        }
        if (current.activeAttemptId !== attempt.id || current.status !== "starting") return;
      }
      if (Option.isSome(startProgress))
        yield* startProgress.value.begin({
          ...progressAttempt,
          provider: run.providerInstanceId,
          model: run.modelSelection.model,
          delegated: projection.thread.lineage?.relationshipToParent === "subagent",
          providerSessionId: providerThread.providerSessionId,
          attemptOrdinal: attempt.attemptOrdinal,
        });
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
            ...(input.item.type === "error"
              ? {
                  failure: withPreviousFailure(
                    input.item.failure,
                    run.transientRecovery?.firstError,
                  ),
                }
              : {}),
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* Effect.gen(function* () {
            const settled = yield* eventSink.writeIfRunCurrent({
              threadId: projection.thread.id,
              runId,
              activeAttemptId: attempt.id,
              expectedStatus: "starting",
              events,
            });
            if (settled.committed) yield* finishUsage(status);
          }).pipe(Effect.uninterruptible);
        },
      );
      const ownerDiscussion = Option.isSome(kanban)
        ? yield* ownerReplyDiscussion(kanban.value, run.userMessageId, message.text).pipe(
            Effect.mapError((cause) => new ProviderTurnStartError({ runId, cause })),
          )
        : null;
      if (
        run.userMessageId.startsWith("kanban:wake:owner:") &&
        Option.isSome(kanban) &&
        (ownerDiscussion === null ||
          (yield* ownerReplyPending(kanban.value, ownerDiscussion, run.threadId).pipe(
            Effect.mapError((cause) => new ProviderTurnStartError({ runId, cause })),
          )) === null)
      ) {
        yield* settleRunBeforeStart({
          signal: "stale-owner-reply",
          status: "completed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "command_execution",
            title: "Owner reply already handled",
            input: "",
            output: "",
            exitCode: 0,
          },
        });
        return;
      }
      if (
        isAutomaticClaudeRecovery(providerThread.driver, run) &&
        providerThread.nativeMetadata?.claudeRefusalObserved === true
      ) {
        yield* settleRunBeforeStart({
          signal: "claude-recovery-refused",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Automatic recovery refused",
            failure: makeProviderFailure({
              class: "provider_error",
              category: "content_filter",
              code: "model_refusal",
              message: "Automatic recovery excluded after a native session refusal.",
            }),
          },
        });
        return;
      }
      const providerText = yield* Effect.result(providerUserMessageText(message));
      if (providerText._tag === "Failure") {
        yield* settleRunBeforeStart({
          signal: "provider-input-too-long",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message is too long",
            failure: makeProviderFailure({
              class: "validation_error",
              message: providerText.failure.message,
            }),
          },
        });
        return;
      }
      const userText = providerText.success;
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: userText,
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists && (yield* isManagedWorktreePath(worktreePath))) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("provider turn start failed to recreate worktree", {
                      threadId: projection.thread.id,
                      worktreePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        parentThreadId: projection.thread.lineage?.parentThreadId ?? null,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      if (run.providerRestartCleanup?.completed === false) return;

      const providerStartDeadlineAt =
        run.providerStartDeadlineAt ??
        DateTime.makeUnsafe(
          DateTime.toEpochMillis(yield* DateTime.now) + PROVIDER_START_TIMEOUT_MS,
        );
      const admitted = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "run.updated",
            threadId: projection.thread.id,
            runId: run.id,
            occurredAt: yield* DateTime.now,
            payload: { ...withoutProviderStartDeadline(run), providerStartDeadlineAt },
          },
        ],
      });
      if (!admitted.committed) return;

      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: run.modelSelection,
      });
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      if (Option.isSome(startProgress))
        yield* startProgress.value.step(progressAttempt, "session_open");
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
        }) {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message:
                  nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message,
                class: "provider_error",
              }),
            },
          });
        },
      );
      if (sessionResult._tag === "Failure") {
        if (input.willRetry === true && run.transientRecovery === undefined)
          return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = makeRecoverySession(
        sessionResult.success,
        runControls.shouldStartProviderTurn,
        isAutomaticClaudeRecovery(sessionResult.success.driver, run)
          ? runControls.loadRecoveryAdmission
          : undefined,
      );
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.willRetry === true && run.transientRecovery === undefined)
          return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      const replaceNativeThread = Effect.fn("ProviderTurnStartService.replaceNativeThread")(
        function* (source: OrchestrationV2ProviderThread, replaySeed = false) {
          const seed = source.nativeMetadata?.seededHistory;
          const { contextUsage: _usage, ...withoutUsage } = source;
          let existingProviderThread: OrchestrationV2ProviderThread = {
            ...withoutUsage,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
          };
          if (replaySeed && seed?.mode === "codex-inject" && seed.stagedPath !== undefined) {
            const { injectedNativeId: _injected, injectionPending: _pending, ...stagedSeed } = seed;
            existingProviderThread = {
              ...existingProviderThread,
              nativeMetadata: { ...source.nativeMetadata, seededHistory: stagedSeed },
            };
          }
          const replacement = yield* session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            existingProviderThread,
            forceNewNativeThread: true,
          });
          yield* Effect.logWarning("Replaced provider native session", {
            providerThreadId: source.id,
            runId,
            oldNativeThreadId: source.nativeThreadRef?.nativeId,
            newNativeThreadId: replacement.nativeThreadRef?.nativeId,
          });
          return replacement;
        },
      );
      let effectiveHandoffs = handoffs;
      let resumeFellBack = false;
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      // A preparation cut never delivered this input to the native provider. Keep
      // the original prompt even when the existing native thread has older turns.
      const restartSource = projection.runs.find(
        (candidate) => candidate.id === run.restartContinuationOfRunId,
      );
      const replayPreparationContinuation =
        restartSource !== undefined &&
        !projection.providerTurns.some(
          (turn) => turn.runAttemptId === restartSource.activeAttemptId,
        );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                candidate.attachments.length === 0 &&
                candidate.text.trim().toLowerCase() === "/compact",
            )
            .map((candidate) => candidate.id),
        ),
        run,
        attempts: projection.attempts,
      });
      // ardud: an OpenCode child still running or finished is not told as cancelled.
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : yield* restartNoteText(serverSettings, restartCancelledWork);
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending",
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        const deliveredAttemptIds = new Set(
          projection.providerTurns.map((turn) => turn.runAttemptId),
        );
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null ? 0 : Buffer.byteLength(historical.text)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        // The resume fallback summary already covers every earlier run in order. A
        // retry copy after it would rank older missed requests as the newest history.
        const missedRuns = projection.runs.filter(
          (source) =>
            !resumeFellBack &&
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: message.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns } = context;
          const missedItems =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter(
                  (item) =>
                    item.runId !== null &&
                    missedRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    historicalMessage(item) !== null,
                );
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          return retryHandoff;
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
              (item) =>
                item.runId === null ||
                projection.runs.some(
                  (source) => source.id === item.runId && source.ordinal < run.ordinal,
                ),
            ),
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: ReadonlyArray<OrchestrationV2ContextHandoff> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      if (Option.isSome(startProgress))
        yield* startProgress.value.step(progressAttempt, "thread_ensure");
      const loadedProviderThread = yield* Effect.gen(function* () {
        // ardud: a moved session is not safe to replace until it completes a turn.
        const seededGuard = seededUnconfirmed(providerThread, projection.providerTurns);
        const failSeededResume = () =>
          loadFromProvider(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId,
                cause:
                  "This thread's moved history could not be resumed, so the turn stopped instead of starting without it. Roll the move back with t3ctl harness-migrate rollback <thread>, or retry.",
              }),
            ),
          );
        const failRecoveryResume = () =>
          loadFromProvider(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId,
                cause:
                  "The original native session could not be resumed during automatic recovery.",
              }),
            ),
          );
        if (run.transientRecovery !== undefined && providerThread.nativeThreadRef?.nativeId == null)
          return yield* failRecoveryResume();
        if (nativeForkTransfer !== undefined) {
          if (seededGuard) return yield* failSeededResume();
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* loadFromProvider(
            session.forkThread({
              sourceProviderThread,
              sourceProviderTurns: sourceProjection.providerTurns,
              targetThreadId: projection.thread.id,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(sourceProviderTurn === undefined
                ? {}
                : { providerTurnId: sourceProviderTurn.id }),
            }),
          );
        }
        if (providerThread.nativeThreadRef?.nativeId == null) {
          // Codex stages an injection without a native id; Claude requires its transcript id.
          if (
            seededGuard &&
            (isClaudeSeeded(providerThread) ||
              providerThread.nativeMetadata?.seededHistory?.injectedNativeId !== undefined)
          )
            return yield* failSeededResume();
          // ardud: claim staged injection before any native side effect. An
          // interrupted claim is ambiguous and requires explicit reconciliation.
          const seeded = providerThread.nativeMetadata?.seededHistory;
          let existingProviderThread = providerThread;
          if (seeded?.mode === "codex-inject" && seeded.injectedNativeId === undefined) {
            if (seeded.injectionPending === true) {
              return yield* loadFromProvider(
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    cause: new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: session.driver,
                      detail:
                        "Moved history delivery is uncertain; reconciliation is required before retrying",
                    }),
                  }),
                ),
              );
            }
            existingProviderThread = {
              ...providerThread,
              nativeMetadata: {
                ...providerThread.nativeMetadata,
                seededHistory: { ...seeded, injectionPending: true },
              },
            };
            const claimed = yield* eventSink.writeIfProviderThreadUnchanged({
              expected: providerThread,
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                  type: "provider-thread.updated",
                  threadId: projection.thread.id,
                  driver: session.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: yield* DateTime.now,
                  payload: existingProviderThread,
                },
              ],
            });
            if (!claimed.committed) {
              return yield* new ProviderTurnStartError({
                runId,
                cause: "The adopted provider thread changed before history delivery.",
              });
            }
            if (!(yield* isCurrentAttemptInStatus("starting"))) {
              yield* eventSink.writeIfProviderThreadUnchanged({
                expected: existingProviderThread,
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                    type: "provider-thread.updated",
                    threadId: projection.thread.id,
                    driver: session.driver,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: yield* DateTime.now,
                    payload: providerThread,
                  },
                ],
              });
              return undefined;
            }
          }
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          const loading = session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            existingProviderThread,
          });
          const loaded = yield* Effect.result(loading);
          if (loaded._tag === "Success") return loaded.success;
          if (seeded?.mode === "codex-inject" && codexHistoryNotSent(loaded.failure)) {
            const cleared = yield* eventSink.writeIfProviderThreadUnchanged({
              expected: existingProviderThread,
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                  type: "provider-thread.updated",
                  threadId: projection.thread.id,
                  driver: session.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: yield* DateTime.now,
                  payload: providerThread,
                },
              ],
            });
            if (!cleared.committed) {
              return yield* new ProviderTurnStartError({
                runId,
                cause: "Could not clear the staged history delivery claim.",
              });
            }
          }
          return yield* loadFromProvider(Effect.fail(loaded.failure));
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          const context = handoffContextForThread(resumed.success);
          context.budget = yield* Effect.cached(context.budget);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          const fits = yield* deliverContextHandoffs({
            handoffs: [...handoffs, ...resumedRetryHandoff],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline:
              message.attachments.length === 0 && message.text.trim().toLowerCase() === "/compact",
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          if (run.transientRecovery !== undefined) return yield* failRecoveryResume();
          if (seededGuard) return yield* failSeededResume();
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            budget: freshContext.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          const hasPendingWork = yield* (
            session.hasPendingBackgroundWorkForThread?.(resumed.success, {
              includeSubagents: true,
            }) ??
              session.hasPendingBackgroundWork ??
              Effect.succeed(false)
          );
          if (hasPendingWork) {
            return yield* loadFromProvider(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: new ContextHandoffBackgroundWorkError(),
                }),
              ),
            );
          }
        }
        const missingRollout =
          resumed._tag === "Failure" &&
          missingCodexRollout(resumed.failure, providerThread.nativeThreadRef?.nativeId);
        if (missingRollout) {
          const recorded = yield* projectionStore.getThreadRecords(input.threadId, [
            "providerTurns",
            "attempts",
          ]);
          if (nativeThreadHasRecordedTurns(providerThread, recorded))
            return yield* loadFromProvider(Effect.fail(resumed.failure));
        }
        if (run.transientRecovery !== undefined)
          return yield* resumed._tag === "Failure"
            ? loadFromProvider(Effect.fail(resumed.failure))
            : failRecoveryResume();
        if (
          seededGuard &&
          !(
            missingRollout &&
            providerThread.nativeMetadata?.seededHistory?.mode === "codex-inject" &&
            providerThread.nativeMetadata.seededHistory.stagedPath !== undefined &&
            providerThread.nativeMetadata.seededHistory.injectionPending !== true
          )
        )
          return yield* failSeededResume();
        resumedHandoffContext = undefined;
        resumedRetryHandoff = [];
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : resumed._tag === "Success"
              ? "handoff_budget_exhausted"
              : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          replaceNativeThread(providerThread, missingRollout),
        );
        if (replacement === undefined) return undefined;
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      if (Option.isSome(startProgress))
        yield* startProgress.value.step(
          progressAttempt,
          "turn_preparation",
          loadedProviderThread.nativeThreadRef?.nativeId ?? undefined,
        );
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
      } = handoffContext;
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      // ardud: the marker belongs to the adopted native id, not a later replacement.
      const { seededHistory: _oldSeed, ...replacementMetadata } =
        loadedProviderThread.nativeMetadata ?? {};
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        // ardud: a fallback replacement drops the adopted marker; otherwise keep it,
        // including delivery updates the adapter returns.
        nativeMetadata:
          resumeFellBack &&
          providerThread.nativeMetadata?.seededHistory !== undefined &&
          loadedProviderThread.nativeMetadata?.seededHistory?.injectedNativeId !==
            loadedProviderThread.nativeThreadRef?.nativeId
            ? replacementMetadata
            : providerThread.nativeMetadata?.seededHistory === undefined
              ? loadedProviderThread.nativeMetadata
              : {
                  ...providerThread.nativeMetadata,
                  ...loadedProviderThread.nativeMetadata,
                },
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        providerStartDeadlineAt,
        status: "running",
        startedAt: now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const currentExecution = { providerThread: runningProviderThread, attempt: runningAttempt };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
        RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          // The prepared budget includes capacity reported while loading a fresh native thread.
          const contextForInput =
            turnInput.providerThread.nativeThreadRef?.nativeId ===
            loadedProviderThread.nativeThreadRef?.nativeId
              ? handoffContext
              : handoffContextForThread(turnInput.providerThread);
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact,
            providerThread: turnInput.providerThread,
            budget: contextForInput.budget,
            alreadyDeliveredItemIds: contextForInput.deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: turnInput.providerThread,
                      ...history,
                    }),
                }),
            persist: Effect.fn("ProviderTurnStartService.persist")(function* (handoff) {
              const updatedAt = yield* DateTime.now;
              yield* eventSink.write({
                events: [
                  {
                    id: yield* idAllocator.allocate.event({
                      threadId: projection.thread.id,
                    }),
                    type: "context-handoff.updated",
                    threadId: projection.thread.id,
                    runId: run.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: updatedAt,
                    payload: { ...handoff, updatedAt },
                  },
                ],
              });
            }),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId: run.id,
                  code: "provider_prompt_not_sent",
                  cause,
                }),
            ),
          );
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation || replayPreparationContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: context === "" ? userText : `${context}\n\nUser message:\n${userText}`,
            },
          }).pipe(
            // A pending marker would make the next turn abandon this native
            // session, though the refused prompt never reached it.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              refusedBeforePrompt(cause)
                ? new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    providerThreadId: providerThread.id,
                    runId: run.id,
                    code: "provider_prompt_not_sent",
                    cause,
                  })
                : cause,
            ),
          );
          // The provider already accepted the turn. A stale pending marker
          // can force a fresh thread later, but must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      const deliverySession =
        effectiveHandoffs.length === 0 &&
        retryHandoff.length === 0 &&
        restartNote === "" &&
        !noteContinuation &&
        !replayPreparationContinuation
          ? session
          : makeDeliverySession(session, startWithHandoffs);
      const recoverResume = Effect.fn("ProviderTurnStartService.recoverEmptyNativeThread")(
        function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          compact: boolean,
          error: ProviderAdapter.ProviderAdapterV2Error,
        ) {
          const source = turnInput.providerThread;
          const records = yield* projectionStore.getThreadRecords(input.threadId, [
            "providerTurns",
            "attempts",
          ]);
          const seed = source.nativeMetadata?.seededHistory;
          if (
            nativeThreadHasRecordedTurns(source, records) ||
            (seed !== undefined &&
              (seed.mode !== "codex-inject" ||
                seed.stagedPath === undefined ||
                seed.injectionPending === true))
          )
            return yield* error;
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const replacement = yield* replaceNativeThread(source, true);
          const updatedAt = yield* DateTime.now;
          const committed = yield* eventSink.writeIfRunCurrent({
            threadId: input.threadId,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "running",
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                type: "provider-thread.updated",
                threadId: input.threadId,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: updatedAt,
                payload: { ...replacement, id: source.id },
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                type: "run-attempt.updated",
                threadId: input.threadId,
                runId,
                providerInstanceId: run.providerInstanceId,
                occurredAt: updatedAt,
                payload: {
                  ...runningAttempt,
                  nativeThreadId: replacement.nativeThreadRef?.nativeId ?? undefined,
                },
              },
            ],
          });
          if (!committed.committed) return;
          currentExecution.providerThread = { ...replacement, id: source.id };
          currentExecution.attempt = {
            ...currentExecution.attempt,
            nativeThreadId: replacement.nativeThreadRef?.nativeId ?? undefined,
          };
          // Replay native injections as well as inline history into the replacement.
          effectiveHandoffs = [
            ...new Map(
              [
                ...projection.contextHandoffs.filter(
                  (handoff) =>
                    handoff.toProviderThreadId === source.id &&
                    handoff.delivery?.nativeThreadId === source.nativeThreadRef?.nativeId,
                ),
                ...effectiveHandoffs,
              ].map((handoff) => [handoff.id, handoff]),
            ).values(),
          ];
          yield* startWithHandoffs(
            {
              ...turnInput,
              providerThread: { ...replacement, id: source.id },
              nativeThreadHasTurns: false,
            },
            compact,
          );
        },
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapter.ProviderAdapterV2Error)(cause)
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: input.threadId,
                providerThreadId: providerThread.id,
                runId,
                cause,
              }),
        ),
      );
      const recoverySession = makeRecoverySession(
        deliverySession,
        runControls.shouldStartProviderTurn,
        isAutomaticClaudeRecovery(session.driver, run)
          ? runControls.loadRecoveryAdmission
          : undefined,
        recoverResume,
      );
      return runExecution.startRootRun(
        bindProviderExecution(
          {
            commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
            appThread: projection.thread,
            providerSessionId,
            session:
              run.restartContinuationOfRunId === undefined && !isRecoveredQueueRun(run.id)
                ? recoverySession
                : makeResumedSession(recoverySession),
            run: runningRun,
            rootNode: runningRootNode,
            checkpointScope,
            providerThread: runningProviderThread,
            attempt: runningAttempt,
            attemptId: attempt.id,
            loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
            loadDelegatedTask: runControls.loadDelegatedTask,
            relatedThreadIds: routableSubagents.flatMap((subagent) =>
              subagent.childThreadId === null ? [] : [subagent.childThreadId],
            ),
            relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
              subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
            ),
            providerTurnOrdinal:
              Math.max(
                0,
                ...projection.providerTurns
                  .filter((turn) => turn.providerThreadId === providerThread.id)
                  .map((turn) => turn.ordinal),
              ) + 1,
            nativeThreadHasTurns:
              // ardud: a staged Claude transcript already has native history.
              isClaudeSeeded(runningProviderThread) ||
              nativeInputRunIds.size > 0 ||
              (legacyInputRunIds.size > 0 &&
                sameNativeThread &&
                !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
            shouldStartProviderTurn: runControls.shouldStartProviderTurn,
            loadClaudeRefusal: runControls.loadClaudeRefusal,
            loadRecoveryAdmission: runControls.loadRecoveryAdmission,
            shouldFinalizeRun: runControls.shouldFinalizeRun,
            hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
            loadRunInterruptReason: runControls.loadRunInterruptReason,
            loadRunCancelMetadata: runControls.loadRunCancelMetadata,
            message: {
              messageId: message.id,
              text:
                run.transientRecovery !== undefined && attempt.reason === "retry"
                  ? "Continue where you left off after the transient API failure. Check work already completed and any partly written files before continuing; do not repeat completed actions."
                  : run.launchRecovery?.kind === "model_access"
                    ? `${userText}\n\nA previous launch failed before responding. This checkout may have partial edits from earlier work; inspect them and preserve completed work before continuing.`
                    : userText,
              attachments:
                run.transientRecovery !== undefined && attempt.reason === "retry"
                  ? []
                  : message.attachments,
              createdBy: message.createdBy,
              creationSource: message.creationSource,
              ...(message.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: message.scheduledTaskId }),
              ...(message.senderThreadId === undefined
                ? {}
                : { senderThreadId: message.senderThreadId }),
            },
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          },
          currentExecution,
        ),
      );
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          const providerTurn = yield* thread.worktreePath === null
            ? start(input)
            : withWorkspaceLease(path.resolve(thread.worktreePath), start(input));
          if (providerTurn !== undefined) yield* providerTurn;
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
    });
  }),
);
