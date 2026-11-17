import { PROVIDER_START_CLEANUP_TIMEOUT_MS } from "./providerStartDeadlinePolicy.ts";
import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  increment,
  metricAttributes,
  orchestrationEffectClaimsTotal,
  orchestrationEffectQueueWait,
} from "../observability/Metrics.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as SteerDeliveryFailure from "../ardud/orchestration/SteerDeliveryFailure.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RestartPacing from "../ardud/restart-pacing/RestartPacing.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

export class OrchestrationEffectExecutionError extends Schema.TaggedError<OrchestrationEffectExecutionError>()(
  "OrchestrationEffectExecutionError",
  {
    effectId: Schema.String,
    effectType: Schema.String,
    providerAccepted: Schema.optional(Schema.Boolean),
    followUpPending: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
    deferMs: Schema.optional(Schema.Number),
  },
) {}

export const isOrchestrationEffectExecutionError = Schema.is(OrchestrationEffectExecutionError);
const isProviderSessionEndedError = Schema.is(ProviderSessionManager.ProviderSessionEndedError);

/**
 * Do not apply this to `provider-turn.restart`: that compound effect also runs
 * detach and start. Swallowing a start failure that happens to mention
 * "is not active" would drop the outbox item without ever starting the
 * replacement turn.
 */
export function isNonRetryableProviderTurnControlFailure(
  effectType: string,
  errorText: string,
): boolean {
  if (effectType !== "provider-turn.interrupt") {
    return false;
  }
  return (
    /is not active/i.test(errorText) ||
    /hard teardown is already in progress/i.test(errorText) ||
    /treating as already interrupted/i.test(errorText) ||
    /treating as already stopped/i.test(errorText)
  );
}

export interface OrchestrationEffectExecutorV2Shape {
  readonly execute: (
    effect: EffectOutbox.OrchestrationEffectV2,
    options?: { readonly willRetry: boolean },
  ) => Effect.Effect<void, OrchestrationEffectExecutionError>;
}

export class OrchestrationEffectExecutorV2 extends Context.Service<
  OrchestrationEffectExecutorV2,
  OrchestrationEffectExecutorV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectExecutorV2") {}

export const layerExecutor: Layer.Layer<
  OrchestrationEffectExecutorV2,
  never,
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunFinalizationService.RunFinalizationService
  | CheckpointRollbackService.CheckpointRollbackServiceV2
  | ProviderTurnControlService.ProviderTurnControlServiceV2
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | RuntimeRequestService.RuntimeRequestServiceV2
  | ThreadTitleRegenerationService.ThreadTitleRegenerationService
  | ThreadManagementService.ThreadManagementService
  | ServerSettings.ServerSettingsService
  | McpSessionRegistry.McpSessionRegistry
  | EventSink.EventSinkV2
  | ProjectionStore.ProjectionStoreV2
  | EffectOutbox.EffectOutboxV2
  | RestartPacing.RestartPacing
> = Layer.effect(
  OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const runFinalization = yield* RunFinalizationService.RunFinalizationService;
    const resourceCleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const checkpointRollback = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const providerTurnControl = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    const providerTurnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const runtimeRequests = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const threadTitleRegeneration =
      yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const pacing = yield* RestartPacing.RestartPacing;
    return OrchestrationEffectExecutorV2.of({
      execute: (effect, options) => {
        const willRetry = options?.willRetry ?? false;
        switch (effect.request.type) {
          case "provider-session.reconcile-root":
            return threads
              .dispatch({
                type: "thread.provider-root.settle",
                commandId: CommandId.make(`${effect.id}:settle:${effect.attemptCount}`),
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                nodeId: effect.request.nodeId,
                startedAt: effect.request.startedAt,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-session.reconcile-turn":
            return threads
              .dispatch({
                type: "thread.background-work.settle",
                runOnly: true,
                ...(effect.request.releasedAt === undefined
                  ? {}
                  : { releasedAt: effect.request.releasedAt }),
                preserveBackgroundWork: effect.request.preserveBackgroundWork === true,
                // Rejected planning has a durable receipt; a new attempt must plan again.
                commandId: CommandId.make(`${effect.id}:settle:${effect.attemptCount}`),
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-runtime.continue": {
            const { sourceRunId, queued } = effect.request;
            const source = {
              threadId: effect.threadId,
              sourceRunId,
              effectId: effect.id,
              classification: queued ? ("recovered-queue" as const) : ("continuation" as const),
            };
            let admitted = false;
            const finishDispatch = pacing.dispatched(source).pipe(
              Effect.catch(() =>
                Effect.logWarning("restart-pacing.settlement-read-failed", {
                  threadId: source.threadId,
                  sourceRunId: source.sourceRunId,
                }),
              ),
            );
            const beforeDispatch = Effect.gen(function* () {
              const deferMs = yield* pacing.acquire(source);
              if (deferMs > 0)
                return yield* new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  deferMs,
                });
              admitted = true;
            });
            return continueRestartedRun({ ...source, queued, beforeDispatch }).pipe(
              Effect.tap(() => (admitted ? Effect.void : pacing.dispatched(source, true))),
              Effect.catchTags({
                // Retire the recovery wake, preserving any saved queued input.
                RestartAdmissionSupersededError: () => Effect.void,
                RestartAdmissionTimeoutError: (error) =>
                  queued === true
                    ? Effect.gen(function* () {
                        const { runs } = yield* projections.getThreadRecords(
                          effect.threadId,
                          ["runs"],
                          { runIds: [sourceRunId] },
                        );
                        const run = runs.find((run) => run.id === sourceRunId);
                        if (run?.status !== "queued" || run.queueHeld === true) return;
                        yield* threads.dispatch({
                          type: "run.start-expire",
                          phase: "restart_admission",
                          commandId: CommandId.make(`${effect.id}:queued-admission-expired`),
                          threadId: effect.threadId,
                          runId: run.id,
                          expectedAttemptId: run.activeAttemptId,
                          deadline: error.deadline,
                          admission: error.admission,
                        });
                      })
                    : threads.recoverDelegatedTask(effect.threadId, sourceRunId),
              }),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? pacing.release(source) : finishDispatch,
              ),
              Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
              Effect.provideService(ServerSettings.ServerSettingsService, {
                ...settings,
                getSettings: pacing.settingsSnapshot,
              }),
              Effect.tapError((cause) =>
                willRetry ||
                (isOrchestrationEffectExecutionError(cause) && cause.deferMs !== undefined)
                  ? Effect.void
                  : threads.recoverDelegatedTask(effect.threadId, sourceRunId),
              ),
              Effect.mapError((cause) =>
                isOrchestrationEffectExecutionError(cause)
                  ? cause
                  : new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
              ),
            );
          }
          case "provider-session.detach":
            return providerSessions
              .detach({
                providerSessionId: effect.request.providerSessionId,
                threadId: effect.threadId,
                ...(effect.request.detail === undefined ? {} : { detail: effect.request.detail }),
                ...(effect.request.revokeMcpCredential === undefined
                  ? {}
                  : { revokeMcpCredential: effect.request.revokeMcpCredential }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "mcp-credential.revoke-thread":
            return mcpRegistry.revokeThread(effect.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.fail(
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
                ),
              ),
            );
          case "notification.delivery.accept":
            return threads
              .dispatch({
                type: "notification.delivery.accept",
                commandId: effect.commandId,
                threadId: effect.threadId,
                messageId: effect.request.messageId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.start": {
            const startRequest = effect.request;
            return Effect.gen(function* () {
              const deferMs = yield* pacing.acquireRun(
                effect.threadId,
                startRequest.runId,
                effect.id,
              );
              if (deferMs > 0)
                return yield* new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: startRequest.type,
                  deferMs,
                });
              yield* providerTurnStart.start({
                threadId: effect.threadId,
                runId: startRequest.runId,
                willRetry,
              });
            }).pipe(
              Effect.catchTags({
                RestartAdmissionTimeoutError: (error) =>
                  Effect.gen(function* () {
                    const { runs } = yield* projections.getThreadRecords(
                      effect.threadId,
                      ["runs"],
                      {
                        runIds: [startRequest.runId],
                      },
                    );
                    const run = runs.find((run) => run.id === startRequest.runId);
                    if (run === undefined) return;
                    yield* threads.dispatch({
                      type: "run.start-expire",
                      phase: "restart_admission",
                      commandId: CommandId.make(`${effect.id}:admission-expired`),
                      threadId: effect.threadId,
                      runId: run.id,
                      expectedAttemptId: run.activeAttemptId,
                      deadline: error.deadline,
                      admission: error.admission,
                    });
                  }),
              }),
              Effect.onExit((exit) =>
                pacing.releaseRun(
                  effect.threadId,
                  startRequest.runId,
                  effect.id,
                  Exit.isFailure(exit),
                ),
              ),
              Effect.delay(Duration.millis(effect.request.retryDelayMs ?? 0)),
              Effect.mapError((cause) =>
                isOrchestrationEffectExecutionError(cause)
                  ? cause
                  : new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
              ),
            );
          }
          case "provider-turn.interrupt": {
            const request = effect.request;
            return providerTurnControl
              .interrupt({
                threadId: effect.threadId,
                providerSessionId: request.providerSessionId,
                providerThreadId: request.providerThreadId,
                providerTurnId: request.providerTurnId,
                ...(request.startTimeout === true ? { stopBackgroundWork: false } : {}),
                ...(request.replacementProviderSessionId === undefined
                  ? {}
                  : { replacementProviderSessionId: request.replacementProviderSessionId }),
                ...(request.subagent === undefined
                  ? {}
                  : {
                      subagent: {
                        ...request.subagent,
                        requestedAt: DateTime.makeUnsafe(effect.createdAt),
                      },
                    }),
              })
              .pipe(
                Effect.tapError((cause) =>
                  request.subagent === undefined
                    ? Effect.void
                    : Effect.logWarning("orchestration-v2.subagent-stop-failed", {
                        effectId: effect.id,
                        cause,
                      }),
                ),
                Effect.catch((cause) =>
                  request.subagent === undefined &&
                  isNonRetryableProviderTurnControlFailure(
                    request.type,
                    Cause.pretty(Cause.fail(cause)),
                  )
                    ? Effect.void
                    : Effect.fail(cause),
                ),
                Effect.andThen((outcome) =>
                  request.startTimeout === true ||
                  (request.subagent !== undefined && outcome === undefined)
                    ? Effect.void
                    : threads.dispatch({
                        type: "thread.background-work.settle",
                        commandId: CommandId.make(`${effect.id}:background-work-settled`),
                        ...(request.subagent === undefined || outcome === undefined
                          ? {}
                          : {
                              subagent: {
                                id: request.subagent.id,
                                stoppedAt: DateTime.makeUnsafe(effect.createdAt),
                                outcome,
                              },
                            }),
                        threadId: effect.threadId,
                        providerThreadId: request.providerThreadId,
                        providerTurnId: request.providerTurnId,
                      }),
                ),
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (request.stopThroughRunOrdinal === undefined) return;
                    yield* providerSessions.stopBackgroundWork({
                      threadId: effect.threadId,
                      throughRunOrdinal: request.stopThroughRunOrdinal,
                      ...(request.stopRunAttempts === undefined
                        ? {}
                        : { runAttempts: request.stopRunAttempts }),
                      onlyIfCancelled: false,
                    });
                    const stopped = yield* projections.getThreadRecords(effect.threadId, [
                      "providerThreads",
                    ]);
                    if (
                      stopped.providerThreads.some(
                        (thread) =>
                          thread.id === request.providerThreadId && thread.driver === "claudeAgent",
                      ) &&
                      !(yield* providerSessions.isLive(request.providerSessionId))
                    )
                      yield* threads.dispatch({
                        type: "thread.background-work.settle",
                        commandId: CommandId.make(`${effect.id}:background-work-released`),
                        threadId: effect.threadId,
                        providerThreadId: request.providerThreadId,
                        providerTurnId: request.providerTurnId,
                      });
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: request.type,
                      cause,
                    }),
                ),
              );
          }
          case "provider-session.stop-background-work": {
            const request = effect.request;
            return Effect.gen(function* () {
              yield* providerSessions.stopBackgroundWork({
                threadId: effect.threadId,
                ...request,
              });
              for (const target of request.backgroundThreads) {
                if (yield* providerSessions.isLive(target.providerSessionId)) continue;
                yield* threads.dispatch({
                  type: "thread.background-work.settle",
                  commandId: CommandId.make(`${effect.id}:settle:${target.providerThreadId}`),
                  threadId: effect.threadId,
                  providerThreadId: target.providerThreadId,
                  providerTurnId: target.providerTurnId,
                });
              }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          }
          case "provider-turn.steer": {
            const request = effect.request;
            return Effect.suspend(() => {
              let providerAccepted = request.providerAccepted === true;
              let followUpPending = request.followUpPending === true && !providerAccepted;
              return Effect.gen(function* () {
                if (providerAccepted) return;
                if (followUpPending)
                  return yield* new ProviderSessionManager.ProviderSessionEndedError({
                    providerSessionId: request.providerSessionId,
                  });
                yield* providerTurnControl.steer({
                  threadId: effect.threadId,
                  providerSessionId: request.providerSessionId,
                  providerThreadId: request.providerThreadId,
                  providerTurnId: request.providerTurnId,
                  messageId: request.messageId,
                });
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    providerAccepted = true;
                  }),
                ),
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (effect.request.type !== "provider-turn.steer") return;
                    const messageId = effect.request.messageId;
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const message = projection.messages.find((row) => row.id === messageId);
                    if (message?.delegatedCompletion === undefined) return;
                    yield* threads.dispatch({
                      type: "notification.delivery.accept",
                      commandId: CommandId.make(`command:mailbox-accepted:${effect.id}`),
                      threadId: effect.threadId,
                      messageId: message.id,
                    });
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (providerAccepted) return yield* error;
                    const sessionEnded =
                      followUpPending ||
                      ("cause" in error && isProviderSessionEndedError(error.cause)) ||
                      Option.isSome(
                        yield* outbox.get(`effect:session-ended:${request.providerTurnId}`),
                      );
                    // A steer can commit after release captured its pending effects.
                    const queueFollowUp =
                      sessionEnded ||
                      ("turnEnded" in error && error.turnEnded === true && !error.turnCompleted);
                    if (
                      makeProviderFailure({ cause: error }).retryable === false ||
                      ((!("turnCompleted" in error) || !error.turnCompleted) && !queueFollowUp) ||
                      effect.request.type !== "provider-turn.steer"
                    ) {
                      return yield* error;
                    }
                    // Board-held workers may hear a live steer but must never be woken by it.
                    if (effect.request.activeTurnOnly) return;
                    // Once recovery owns the saved input, storage failures cannot abandon it.
                    followUpPending = queueFollowUp;
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const messageId = effect.request.messageId;
                    const message = projection.messages.find((item) => item.id === messageId);
                    const run = projection.runs.find((item) => item.id === message?.runId);
                    if (message === undefined || run === undefined) return yield* error;
                    // A prior attempt may have queued this message before its outbox ack failed.
                    if (queueFollowUp && run.userMessageId === message.id) return;
                    yield* threads
                      .dispatch({
                        type: "message.dispatch",
                        commandId: CommandId.make(
                          `command:steer-follow-up:${effect.id}${queueFollowUp ? `:${effect.attemptCount}` : ""}`,
                        ),
                        threadId: effect.threadId,
                        messageId: message.id,
                        text: message.text,
                        ...(message.context ? { context: message.context } : {}),
                        attachments: message.attachments,
                        ...(message.delegatedCompletion === undefined
                          ? {}
                          : { modelSelection: run.modelSelection }),
                        dispatchMode: {
                          type:
                            !queueFollowUp &&
                            message.delegatedCompletion === undefined &&
                            message.notification === undefined
                              ? "start_immediately"
                              : "queue_after_active",
                        },
                        createdBy: message.createdBy,
                        creationSource: message.creationSource,
                        ...(message.delegatedCompletion === undefined
                          ? {}
                          : { delegatedCompletion: message.delegatedCompletion }),
                        ...(message.notification === undefined
                          ? {}
                          : { notification: message.notification }),
                        ...(message.scheduledTaskId === undefined
                          ? {}
                          : { scheduledTaskId: message.scheduledTaskId }),
                        ...(message.senderThreadId === undefined
                          ? {}
                          : { senderThreadId: message.senderThreadId }),
                      })
                      .pipe(
                        // The turn that just completed leaves no further retry
                        // target once the instance is off: the completed turn
                        // stands as the thread's result instead of going
                        // through the outbox's bounded retry on a refusal that
                        // retrying cannot change.
                        Effect.catchTags({
                          ThreadManagementProviderInstanceDisabledError: (disabledError) =>
                            Effect.logInfo(
                              "orchestration-v2.effect-worker.steer-follow-up-disabled",
                              {
                                threadId: effect.threadId,
                                messageId: message.id,
                                projectId: disabledError.projectId,
                                instanceId: disabledError.instanceId,
                              },
                            ),
                        }),
                      );
                  }),
                ),
                Effect.tapError((error) => {
                  const failure = makeProviderFailure({ cause: error });
                  // Mailbox bookkeeping can fail after the provider accepted the input.
                  if (
                    providerAccepted ||
                    ((willRetry || followUpPending) && failure.retryable !== false)
                  )
                    return Effect.void;
                  return SteerDeliveryFailure.persist(
                    effect,
                    failure.retryable === false ? failure : undefined,
                  ).pipe(
                    Effect.provideService(EventSink.EventSinkV2, eventSink),
                    Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
                    Effect.retry({ times: 2 }),
                    Effect.catchCause(() =>
                      Effect.logWarning(
                        "orchestration-v2.effect-worker.steer-delivery-notice-failed",
                        { effectId: effect.id, threadId: effect.threadId },
                      ),
                    ),
                  );
                }),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      providerAccepted,
                      followUpPending,
                      cause,
                    }),
                ),
                Effect.catchDefect((cause) =>
                  providerAccepted || followUpPending
                    ? new OrchestrationEffectExecutionError({
                        effectId: effect.id,
                        effectType: request.type,
                        providerAccepted,
                        followUpPending,
                        cause,
                      })
                    : Effect.die(cause),
                ),
              );
            });
          }
          case "provider-turn.restart": {
            const request = effect.request;
            return Effect.gen(function* () {
              const { runs } = yield* projections.getThreadRecords(effect.threadId, ["runs"], {
                runIds: [request.runId],
              });
              const run = runs.find((candidate) => candidate.id === request.runId);
              if (
                run?.status !== "starting" ||
                run.activeAttemptId === null ||
                (request.expectedAttemptId !== undefined &&
                  run.activeAttemptId !== request.expectedAttemptId)
              )
                return;
              const completedCleanup =
                run.providerRestartCleanup?.completed === true ||
                (run.providerRestartCleanup === undefined &&
                  run.providerStartDeadlineAt !== undefined);
              if (!completedCleanup) {
                const now = yield* DateTime.now;
                const deadline =
                  run.providerStartDeadlineAt ??
                  DateTime.makeUnsafe(
                    DateTime.toEpochMillis(now) + PROVIDER_START_CLEANUP_TIMEOUT_MS,
                  );
                const target = run.providerRestartCleanup ?? {
                  providerSessionId: request.providerSessionId,
                  providerThreadId: request.providerThreadId,
                  providerTurnId: request.providerTurnId,
                  completed: false,
                  ...(request.sessionTransition?.type === "replace"
                    ? {
                        replacementProviderSessionId:
                          request.sessionTransition.replacementProviderSessionId,
                      }
                    : {}),
                };
                const admitted =
                  run.providerStartDeadlineAt !== undefined &&
                  run.providerRestartCleanup !== undefined
                    ? { committed: true }
                    : yield* eventSink.writeIfRunCurrent({
                        threadId: effect.threadId,
                        runId: run.id,
                        activeAttemptId: run.activeAttemptId,
                        expectedStatus: "starting",
                        events: [
                          {
                            id: EventId.make(
                              `${effect.id}:cleanup-admitted:${run.activeAttemptId}`,
                            ),
                            type: "run.updated",
                            threadId: effect.threadId,
                            runId: run.id,
                            occurredAt: now,
                            payload: {
                              ...run,
                              providerStartDeadlineAt: deadline,
                              providerRestartCleanup: target,
                            },
                          },
                        ],
                      });
                if (!admitted.committed) return;
                const remaining = Math.max(
                  0,
                  DateTime.toEpochMillis(deadline) - DateTime.toEpochMillis(yield* DateTime.now),
                );
                const cleanup = providerTurnControl
                  .interruptAndAwaitTerminal({
                    threadId: effect.threadId,
                    providerSessionId: target.providerSessionId,
                    providerThreadId: target.providerThreadId,
                    providerTurnId: target.providerTurnId,
                    interruptedAttemptId: request.interruptedAttemptId,
                    ...(target.replacementProviderSessionId === undefined
                      ? {}
                      : { replacementProviderSessionId: target.replacementProviderSessionId }),
                  })
                  .pipe(
                    Effect.andThen(
                      request.sessionTransition === undefined
                        ? Effect.void
                        : providerSessions.detach({
                            providerSessionId: request.providerSessionId,
                            threadId: effect.threadId,
                            detail:
                              request.sessionTransition.type === "replace"
                                ? "Selection change requires a provider session restart."
                                : "Provider thread handoff replaced this session binding.",
                          }),
                    ),
                  );
                const outcome =
                  remaining === 0
                    ? undefined
                    : yield* cleanup.pipe(
                        Effect.interruptible,
                        Effect.timeout(remaining),
                        Effect.result,
                      );
                if (outcome === undefined)
                  return yield* new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: request.type,
                    cause:
                      "The restart cleanup deadline expired before interruption and detach completed.",
                  });
                if (outcome._tag === "Failure") return yield* outcome.failure;
                const { runs: currentRuns } = yield* projections.getThreadRecords(
                  effect.threadId,
                  ["runs"],
                  { runIds: [run.id] },
                );
                const current = currentRuns.find((candidate) => candidate.id === run.id);
                if (
                  current?.activeAttemptId !== run.activeAttemptId ||
                  current.status !== "starting"
                )
                  return;
                const { providerStartDeadlineAt: _deadline, ...withoutDeadline } = current;
                const completed = yield* eventSink.writeIfRunCurrent({
                  threadId: effect.threadId,
                  runId: run.id,
                  activeAttemptId: run.activeAttemptId,
                  expectedStatus: "starting",
                  events: [
                    {
                      id: EventId.make(`${effect.id}:cleanup-completed:${run.activeAttemptId}`),
                      type: "run.updated",
                      threadId: effect.threadId,
                      runId: run.id,
                      occurredAt: yield* DateTime.now,
                      payload: {
                        ...withoutDeadline,
                        providerRestartCleanup: { ...target, completed: true },
                      },
                    },
                  ],
                });
                if (!completed.committed) return;
              }
              yield* providerTurnStart.start({
                threadId: effect.threadId,
                runId: run.id,
                willRetry,
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: request.type,
                    cause,
                  }),
              ),
            );
          }
          case "runtime-request.respond":
            return runtimeRequests
              .respond({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                requestId: effect.request.requestId,
                ...(effect.request.decision === undefined
                  ? {}
                  : { decision: effect.request.decision }),
                ...(effect.request.answers === undefined
                  ? {}
                  : { answers: effect.request.answers }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-thread.rollback":
            return checkpointRollback
              .execute({
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                checkpointId: effect.request.checkpointId,
                scopeId: effect.request.scopeId,
                ...(effect.request.restoreFiles === undefined
                  ? {}
                  : { restoreFiles: effect.request.restoreFiles }),
              })
              .pipe(
                Effect.tapCause((cause) =>
                  willRetry || Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : threads
                        .dispatch({
                          type: "checkpoint.rollback.fail",
                          commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
                          threadId: effect.threadId,
                          requestId: effect.commandId,
                          message: Option.match(Cause.findErrorOption(cause), {
                            onNone: () => CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
                            onSome: CheckpointRollbackService.rollbackFailureClientMessage,
                          }),
                        })
                        .pipe(
                          Effect.catchCause((recordCause) =>
                            Effect.logWarning("Failed to record rollback failure", {
                              effectId: effect.id,
                              cause: recordCause,
                            }),
                          ),
                        ),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "checkpoint.capture":
            return runFinalization
              .finalize({
                threadId: effect.threadId,
                runId: effect.request.runId,
                scopeId: effect.request.scopeId,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "scheduled-tasks.cleanup":
            return resourceCleanup.cleanupScheduledTasks(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "terminal.cleanup":
            return resourceCleanup.cleanupTerminals(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "preview.cleanup":
            return resourceCleanup.cleanupPreviews(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "attachment.cleanup":
            return resourceCleanup.cleanupAttachments(effect.request.attachmentIds).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "thread-title.generate":
            return threadTitleRegeneration
              .execute({
                threadId: effect.threadId,
                requestId: effect.commandId,
                kind: effect.request.kind,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "delegated-tasks.stop":
            return threads
              .stopDelegatedTasks({
                threadId: effect.threadId,
                commandId: effect.commandId,
                reason: effect.request.reason,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
        }
      },
    });
  }),
);

export class OrchestrationEffectWorkerError extends Schema.TaggedError<OrchestrationEffectWorkerError>()(
  "OrchestrationEffectWorkerError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isOrchestrationEffectWorkerError = Schema.is(OrchestrationEffectWorkerError);

export interface OrchestrationEffectWorkerV2Shape {
  readonly awaitWork: Effect.Effect<void>;
  readonly awaitControlWork: Effect.Effect<void>;
  readonly awaitStartWork: Effect.Effect<void>;
  readonly runOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runThreadOnce?: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runRecoveryOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runControlOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runStartOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly nextClaimableAt: Effect.Effect<
    Option.Option<DateTime.Utc>,
    OrchestrationEffectWorkerError
  >;
  readonly nextControlClaimableAt: Effect.Effect<
    Option.Option<DateTime.Utc>,
    OrchestrationEffectWorkerError
  >;
  readonly nextStartClaimableAt: Effect.Effect<
    Option.Option<DateTime.Utc>,
    OrchestrationEffectWorkerError
  >;
  readonly drain: (maxEffects?: number) => Effect.Effect<number, OrchestrationEffectWorkerError>;
}

export class OrchestrationEffectWorkerV2 extends Context.Service<
  OrchestrationEffectWorkerV2,
  OrchestrationEffectWorkerV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectWorkerV2") {}

// Accepted input needs more time to commit bookkeeping than the provider send budget.
export const DEFAULT_MAX_ACCEPTED_ATTEMPTS = 10;

export interface OrchestrationEffectWorkerOptions {
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly maxAcceptedAttempts?: number;
}

export const layerWithOptions = (
  options: OrchestrationEffectWorkerOptions = {},
): Layer.Layer<
  OrchestrationEffectWorkerV2,
  never,
  EffectOutbox.EffectOutboxV2 | OrchestrationEffectExecutorV2
> =>
  Layer.effect(
    OrchestrationEffectWorkerV2,
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executor = yield* OrchestrationEffectExecutorV2;
      const workerId = options.workerId ?? `orchestration-v2:${process.pid}`;
      const leaseDurationMs = Math.max(1, options.leaseDurationMs ?? 30_000);
      const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
      const maxAcceptedAttempts = Math.max(
        maxAttempts,
        options.maxAcceptedAttempts ?? DEFAULT_MAX_ACCEPTED_ATTEMPTS,
      );
      const isAcceptance = (effect: EffectOutbox.OrchestrationEffectV2) =>
        effect.request.type === "notification.delivery.accept" ||
        (effect.request.type === "provider-turn.steer" && effect.request.providerAccepted === true);
      const wasCancelled = (effectId: string) =>
        outbox.get(effectId).pipe(
          Effect.map(
            Option.match({
              onNone: () => false,
              onSome: (effect) => effect.status === "cancelled",
            }),
          ),
        );
      const requeueClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
        refundAttempt = false,
      ) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : !refundAttempt && isAcceptance(effect) && effect.attemptCount >= maxAcceptedAttempts
            ? terminalizeClaim(effect, cause)
            : outbox
                .retry({
                  effectId: effect.id,
                  workerId,
                  error: refundAttempt
                    ? "Resuming after restart"
                    : `Worker failed before settling the claimed effect: ${Cause.pretty(cause)}`,
                  delayMs: 0,
                  steerAccepted:
                    effect.request.type === "provider-turn.steer" &&
                    effect.request.providerAccepted === true,
                  steerFollowUpPending:
                    effect.request.type === "provider-turn.steer" &&
                    effect.request.followUpPending === true,
                  refundAttempt,
                })
                .pipe(
                  Effect.flatMap((requeued) =>
                    requeued
                      ? Effect.logWarning("Requeued effect after unexpected worker failure", {
                          effectId: effect.id,
                          effectType: effect.request.type,
                        })
                      : Effect.logWarning("Could not requeue effect after worker lost its lease", {
                          effectId: effect.id,
                          effectType: effect.request.type,
                        }),
                  ),
                  Effect.catchCause((requeueCause) =>
                    Effect.logError("Failed to requeue effect after unexpected worker failure", {
                      effectId: effect.id,
                      effectType: effect.request.type,
                      error: Cause.pretty(requeueCause),
                    }),
                  ),
                );
      const terminalizeClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return outbox
          .fail({
            effectId: effect.id,
            workerId,
            error: `Worker failed to settle an effect after execution started: ${Cause.pretty(cause)}`,
          })
          .pipe(
            Effect.flatMap((failed) =>
              failed
                ? Effect.logError("Terminalized effect after settlement failure", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                  })
                : Effect.logWarning("Could not terminalize effect after worker lost its lease", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                  }),
            ),
            Effect.catchCause((failCause) =>
              Effect.logError("Failed to terminalize effect after settlement failure", {
                effectId: effect.id,
                effectType: effect.request.type,
                error: Cause.pretty(failCause),
              }),
            ),
          );
      };
      const recoverPostSuccessSettlement = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) =>
        EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS.some(
          (effectType) => effectType === effect.request.type,
        )
          ? requeueClaim(effect, cause)
          : terminalizeClaim(effect, cause);

      // The worker probes for work repeatedly, including when the outbox is empty.
      const runOnce = Effect.fnUntraced(
        function* (
          excludeRestartContinuations = false,
          lane: "general" | "control" | "start" = "general",
          threadId?: ThreadId,
        ) {
          if (lane === "start") {
            // Idle lane probes must not queue write claims behind useful work.
            // The claim remains authoritative if another worker wins after this read.
            const next = yield* outbox.nextStartClaimableAt;
            if (
              Option.isNone(next) ||
              DateTime.toEpochMillis(next.value) > DateTime.toEpochMillis(yield* DateTime.now)
            )
              return false;
          }
          const claimExit = yield* Effect.exit(
            outbox.claimNext({
              workerId,
              ...(threadId === undefined ? {} : { threadId }),
              leaseDurationMs,
              excludeRestartContinuations,
              ...(lane === "control"
                ? { onlyEffectTypes: EffectOutbox.CONTROL_LANE_EFFECT_TYPES }
                : lane === "start"
                  ? { onlyEffectTypes: EffectOutbox.START_LANE_EFFECT_TYPES }
                  : threadId !== undefined
                    ? {
                        onlyEffectTypes: [
                          "provider-runtime.continue",
                          "provider-turn.start",
                        ] as const,
                      }
                    : {}),
            }),
          );
          yield* increment(orchestrationEffectClaimsTotal, {
            lane,
            result: Exit.isFailure(claimExit)
              ? "error"
              : Option.isNone(claimExit.value)
                ? "empty"
                : "claimed",
          });
          if (Exit.isFailure(claimExit)) return yield* Effect.failCause(claimExit.cause);
          const claimed = claimExit.value;
          if (Option.isNone(claimed)) {
            return false;
          }
          const effect = claimed.value;
          // Arm the process-local cancellation signal before re-reading durable
          // state. A cancellation that commits after the row read has begun can
          // then still win the execution race instead of falling into the gap
          // between the read and signal registration.
          const cancellation = outbox
            .awaitCancellation(effect.id)
            .pipe(Effect.as("cancelled" as const));
          const cancelledBeforeExecution = yield* Effect.gen(function* () {
            const claimedAt = DateTime.toEpochMillis(yield* DateTime.now);
            const eligibleAt = Math.max(
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.createdAt)),
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.availableAt)),
            );
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationEffectQueueWait,
                metricAttributes({ effect_type: effect.request.type }),
              ),
              Duration.millis(Math.max(0, claimedAt - eligibleAt)),
            );
            // Cancellation can commit after the durable claim but before the
            // process-local Deferred is registered. Re-read the authoritative row
            // once before starting external work; later cancellations use the
            // Deferred raced below.
            if (yield* wasCancelled(effect.id)) {
              yield* outbox.clearCancellation(effect.id);
              return true;
            }
            return false;
          }).pipe(Effect.onError((cause) => requeueClaim(effect, cause)));
          if (cancelledBeforeExecution) return true;

          // Recovery owns the last path out for work whose provider can no longer report.
          const acceptance = isAcceptance(effect);
          const durableRecovery =
            effect.request.type === "provider-session.reconcile-turn" ||
            effect.request.type === "provider-session.reconcile-root" ||
            (effect.request.type === "provider-turn.steer" &&
              !acceptance &&
              effect.request.followUpPending === true);
          const execution = executor
            .execute(effect, {
              willRetry:
                durableRecovery ||
                effect.attemptCount < (acceptance ? maxAcceptedAttempts : maxAttempts),
            })
            .pipe(
              Effect.provideService(EffectOutbox.ExecutingEffect, effect),
              Effect.as("executed" as const),
            );
          const exit = yield* Effect.exit(Effect.raceFirst(execution, cancellation)).pipe(
            Effect.ensuring(outbox.clearCancellation(effect.id)),
          );
          if (Exit.isSuccess(exit) && exit.value === "cancelled") {
            return true;
          }
          if (Exit.isSuccess(exit)) {
            return yield* Effect.gen(function* () {
              const completed = yield* outbox.succeed({ effectId: effect.id, workerId });
              if (!completed) {
                if (yield* wasCancelled(effect.id)) return true;
                return yield* new OrchestrationEffectWorkerError({
                  operation: "complete",
                  effectId: effect.id,
                  cause: "The worker no longer owns the effect lease.",
                });
              }
              return true;
            }).pipe(Effect.onError((cause) => recoverPostSuccessSettlement(effect, cause)));
          }

          const failure = Cause.findErrorOption(exit.cause);
          const acceptedSteer =
            effect.request.type === "provider-turn.steer" &&
            (effect.request.providerAccepted === true ||
              Option.exists(failure, (failure) => failure.providerAccepted === true));
          const recoveringSteer =
            effect.request.type === "provider-turn.steer" &&
            !acceptedSteer &&
            (effect.request.followUpPending === true ||
              Option.exists(failure, (failure) => failure.followUpPending === true));
          // Delivery ownership must survive rescheduling, including its error-recovery path.
          const retryEffect =
            effect.request.type === "provider-turn.steer" && (acceptedSteer || recoveringSteer)
              ? {
                  ...effect,
                  request: {
                    ...effect.request,
                    providerAccepted: acceptedSteer,
                    followUpPending: recoveringSteer,
                  },
                }
              : effect;

          if (Option.isSome(failure) && failure.value.deferMs !== undefined) {
            const deferred = yield* outbox
              .retry({
                effectId: effect.id,
                workerId,
                error: "Resuming after restart",
                delayMs: failure.value.deferMs,
                refundAttempt: true,
                steerAccepted: acceptedSteer,
                steerFollowUpPending: recoveringSteer,
              })
              .pipe(Effect.onError((cause) => requeueClaim(retryEffect, cause, true)));
            if (!deferred && !(yield* wasCancelled(effect.id)))
              return yield* new OrchestrationEffectWorkerError({
                operation: "defer",
                effectId: effect.id,
              });
            return true;
          }
          const error = Cause.pretty(exit.cause);
          // An unconfirmed steer may still be admitted after its HTTP request ends.
          const uncertainSteer =
            effect.request.type === "provider-turn.steer" &&
            makeProviderFailure({ cause: exit.cause }).retryable === false;
          const nonRetryable = isNonRetryableProviderTurnControlFailure(effect.request.type, error);
          yield* Effect.logWarning("Orchestration effect execution failed", {
            effectId: effect.id,
            effectType: effect.request.type,
            attemptCount: effect.attemptCount,
            nonRetryable,
            error,
          });
          const updated = nonRetryable
            ? yield* outbox
                .succeed({ effectId: effect.id, workerId })
                .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
            : (!acceptance && !acceptedSteer && uncertainSteer) ||
                !durableRecovery &&
                !recoveringSteer &&
                effect.attemptCount >=
                  (acceptance || acceptedSteer ? maxAcceptedAttempts : maxAttempts)
              ? yield* outbox
                  .fail({ effectId: effect.id, workerId, error })
                  .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
              : yield* outbox
                  .retry({
                    effectId: effect.id,
                    workerId,
                    error,
                    delayMs: Math.min(30_000, 100 * 2 ** Math.max(0, effect.attemptCount - 1)),
                    steerAccepted: acceptedSteer,
                    steerFollowUpPending: recoveringSteer,
                  })
                  .pipe(Effect.onError((cause) => requeueClaim(retryEffect, cause)));
          if (!updated) {
            if (yield* wasCancelled(effect.id)) return true;
            return yield* new OrchestrationEffectWorkerError({
              operation: "reschedule",
              effectId: effect.id,
              cause: "The worker no longer owns the effect lease.",
            });
          }
          return true;
        },
        (
          effect,
          _excludeRestartContinuations?: boolean,
          _lane?: "general" | "control" | "start",
          _threadId?: ThreadId,
        ) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isOrchestrationEffectWorkerError(cause)
                ? cause
                : new OrchestrationEffectWorkerError({ operation: "run", cause }),
            ),
          ),
      );

      return OrchestrationEffectWorkerV2.of({
        awaitWork: outbox.awaitAvailable,
        awaitControlWork: outbox.awaitControlAvailable,
        awaitStartWork: outbox.awaitStartAvailable,
        runOnce: runOnce(),
        runThreadOnce: (threadId) => runOnce(false, "general", threadId),
        runRecoveryOnce: runOnce(true),
        runControlOnce: runOnce(false, "control"),
        runStartOnce: runOnce(false, "start"),
        nextClaimableAt: outbox.nextClaimableAt.pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationEffectWorkerError({
                operation: "next-claimable",
                cause,
              }),
          ),
        ),
        nextControlClaimableAt: outbox.nextControlClaimableAt.pipe(
          Effect.mapError(
            (cause) => new OrchestrationEffectWorkerError({ operation: "next-claimable", cause }),
          ),
        ),
        nextStartClaimableAt: outbox.nextStartClaimableAt.pipe(
          Effect.mapError(
            (cause) => new OrchestrationEffectWorkerError({ operation: "next-claimable", cause }),
          ),
        ),
        drain: Effect.fn("EffectWorker.drain")(function* (maxEffects = Number.MAX_SAFE_INTEGER) {
          let completed = 0;
          while (completed < maxEffects && (yield* runOnce())) {
            completed += 1;
          }
          return completed;
        }),
      });
    }),
  );

export const layer = layerWithOptions();

export interface OrchestrationEffectDaemonOptions {
  readonly concurrency?: number;
  readonly controlLaneConcurrency?: number;
  readonly startLaneConcurrency?: number;
  readonly livenessPollIntervalMs?: number;
}

const DEFAULT_EFFECT_WORKER_CONCURRENCY = 4;
const DEFAULT_CONTROL_LANE_CONCURRENCY = 1;
const DEFAULT_START_LANE_CONCURRENCY = 10;
const DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS = 30_000;

export const runDaemonWithOptions = (options: OrchestrationEffectDaemonOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      const requestedConcurrency = options.concurrency ?? DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.floor(requestedConcurrency))
        : DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const requestedControlConcurrency =
        options.controlLaneConcurrency ?? DEFAULT_CONTROL_LANE_CONCURRENCY;
      const controlLaneConcurrency = Number.isFinite(requestedControlConcurrency)
        ? Math.max(0, Math.floor(requestedControlConcurrency))
        : DEFAULT_CONTROL_LANE_CONCURRENCY;
      const requestedStartConcurrency =
        options.startLaneConcurrency ?? DEFAULT_START_LANE_CONCURRENCY;
      const startLaneConcurrency = Number.isFinite(requestedStartConcurrency)
        ? Math.max(0, Math.floor(requestedStartConcurrency))
        : DEFAULT_START_LANE_CONCURRENCY;
      const requestedLivenessPollIntervalMs =
        options.livenessPollIntervalMs ?? DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      const livenessPollIntervalMs = Number.isFinite(requestedLivenessPollIntervalMs)
        ? Math.max(1, Math.floor(requestedLivenessPollIntervalMs))
        : DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      // Post-commit notifications are the low-latency path. `availableAt` is the
      // durable retry schedule, and the long liveness poll only recovers from a
      // missed in-process notification or work inserted by another process.
      const runWorker = Effect.fn("EffectWorker.runWorker")(function* (
        lane: "general" | "control" | "start",
      ) {
        const run =
          lane === "start"
            ? worker.runStartOnce
            : lane === "control"
              ? worker.runControlOnce
              : worker.runOnce;
        const next =
          lane === "start"
            ? worker.nextStartClaimableAt
            : lane === "control"
              ? worker.nextControlClaimableAt
              : worker.nextClaimableAt;
        const awaitWork =
          lane === "start"
            ? worker.awaitStartWork
            : lane === "control"
              ? worker.awaitControlWork
              : worker.awaitWork;
        yield* Effect.annotateCurrentSpan("lane", lane);
        while (true) {
          const outcome = yield* run.pipe(
            Effect.map((worked) => (worked ? ("worked" as const) : ("idle" as const))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Orchestration effect worker failed", cause).pipe(
                Effect.as("failed" as const),
              ),
            ),
          );
          if (outcome === "worked") {
            yield* Effect.yieldNow;
            continue;
          }
          if (outcome === "failed") {
            // A due row can remain visible when a claim UPDATE fails. Do not
            // feed that past deadline back into the scheduler and retry at the
            // one-millisecond floor; let transient database failures cool off.
            yield* Effect.sleep(Duration.millis(Math.min(1_000, livenessPollIntervalMs)));
            continue;
          }

          const nextClaimableAt = yield* next.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Failed to read the next orchestration effect deadline",
                cause,
              ).pipe(Effect.as(Option.none<DateTime.Utc>())),
            ),
          );
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const sleepMs = Option.match(nextClaimableAt, {
            onNone: () => livenessPollIntervalMs,
            onSome: (availableAt) => {
              const untilAvailable = DateTime.toEpochMillis(availableAt) - now;
              return Math.min(livenessPollIntervalMs, untilAvailable > 0 ? untilAvailable : 25);
            },
          });
          yield* Effect.raceFirst(
            awaitWork.pipe(Effect.as("notified" as const)),
            Effect.sleep(Duration.millis(sleepMs)).pipe(Effect.as("scheduled" as const)),
          );
        }
      });

      return yield* Effect.all(
        [
          ...Array.from({ length: concurrency }, () => runWorker("general")),
          ...Array.from({ length: controlLaneConcurrency }, () => runWorker("control")),
          ...Array.from({ length: startLaneConcurrency }, () => runWorker("start")),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  );

export const runDaemon = runDaemonWithOptions();
