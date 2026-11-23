import {
  MessageId,
  type NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProjectionStore from "./ProjectionStore.ts";
import { providerUserMessageText } from "./ProviderMessageText.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { PROVIDER_START_CLEANUP_TIMEOUT_MS } from "./providerStartDeadlinePolicy.ts";
import * as KanbanStore from "../ardud/kanban/store/KanbanStore.ts";
import {
  postRecoveryIdentity,
  postRecoveryPending,
} from "../ardud/kanban/engine/ownerReplyWake.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    steerNotDelivered: Schema.optional(Schema.Boolean),
    turnEnded: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);
const isTurnNotActiveError = Schema.is(ProviderAdapter.ProviderAdapterTurnNotActiveError);
const isSteerRunError = Schema.is(ProviderAdapter.ProviderAdapterSteerRunError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interrupt: (input: {
    readonly confirmStopped?: boolean;
    readonly startingRun?: {
      readonly runId: RunId;
      readonly attemptId: RunAttemptId;
      readonly runOrdinal: number;
    };
    readonly stopBackgroundWork?: boolean;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly subagent?: {
      readonly id: NodeId;
      readonly nativeTaskId: string;
      readonly requestedAt?: DateTime.Utc;
    };
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<
    void | ProviderAdapter.ProviderAdapterV2SubagentOutcome,
    ProviderTurnControlError
  >;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const kanban = yield* Effect.serviceOption(KanbanStore.KanbanStore);

    const stopAndConfirm = Effect.fn("ProviderTurnControlService.stopAndConfirm")(function* (
      runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      input: Parameters<ProviderTurnControlServiceV2Shape["interrupt"]>[0],
      providerThread: Parameters<
        ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"]
      >[0]["providerThread"],
      stop: Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
    ) {
      // Subscribe before sending Stop: adapters can emit the terminal synchronously.
      const subscription =
        runtime.subscribeEvents === undefined ? undefined : yield* runtime.subscribeEvents;
      const observedEnd =
        runtime.hasObservedTurnEnd?.({
          providerThreadId: input.providerThreadId,
          providerTurnId: input.providerTurnId,
          ...(input.startingRun === undefined ? {} : { attemptId: input.startingRun.attemptId }),
        }) ?? Effect.succeed(false);
      yield* Effect.gen(function* () {
        const stopped = yield* Effect.result(stop);
        // Missing local ownership also follows ambiguous provider failures.
        // A no-op Stop still needs native settlement evidence.
        if (stopped._tag === "Failure" && !isTurnNotActiveError(stopped.failure))
          return yield* stopped.failure;
        if (yield* observedEnd) return;
        if (
          input.replacementProviderSessionId === undefined &&
          runtime.holdsWorkForThread !== undefined &&
          !(yield* runtime.holdsWorkForThread(providerThread))
        )
          return;
        if (subscription === undefined)
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "interrupt",
            providerTurnId: input.providerTurnId,
            cause: "The provider cannot observe stop settlement.",
          });
        const targetTurns = new Set([input.providerTurnId]);
        const terminal = yield* subscription.events.pipe(
          Stream.filterEffect((event) =>
            Effect.gen(function* () {
              if (
                event.type === "provider_session.updated" &&
                event.providerSession.id === input.providerSessionId &&
                event.providerSession.status === "stopped"
              )
                return true;
              if (
                event.type === "provider_turn.updated" &&
                input.startingRun !== undefined &&
                event.providerTurn.providerThreadId === input.providerThreadId &&
                event.providerTurn.runAttemptId === input.startingRun.attemptId
              ) {
                targetTurns.add(event.providerTurn.id);
                return yield* observedEnd;
              }
              if (
                (event.type !== "turn.native-ended" &&
                  (event.type !== "turn.terminal" || event.nativeWorkEnded !== true)) ||
                event.providerThreadId !== input.providerThreadId
              )
                return false;
              // The turn update may predate this subscription. The manager's
              // exact-attempt cache observes native ends before publishing them.
              return targetTurns.has(event.providerTurnId) || (yield* observedEnd);
            }),
          ),
          Stream.runHead,
        );
        if (Option.isNone(terminal))
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "interrupt",
            providerTurnId: input.providerTurnId,
            cause: "The provider stream ended without confirming that the expired turn stopped.",
          });
      }).pipe(Effect.ensuring(subscription?.close ?? Effect.void));
    });

    const load = Effect.fn("ProviderTurnControlService.load")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly allowReplacementInterrupt?: boolean;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) {
      const context = yield* projections.getProviderControlContext(input.threadId, input);
      const { providerThread, providerTurn } = context;
      const targetsRecordedSession = providerThread?.providerSessionId === input.providerSessionId;
      const targetsCommittedReplacement =
        (input.operation === "restart" || input.allowReplacementInterrupt === true) &&
        input.replacementProviderSessionId !== undefined &&
        providerThread?.providerSessionId === input.replacementProviderSessionId;
      if (
        providerThread === undefined ||
        providerTurn === undefined ||
        providerTurn.providerThreadId !== providerThread.id
      ) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      const steerSession =
        input.operation === "steer" ? yield* sessions.get(input.providerSessionId) : undefined;
      if (steerSession !== undefined && Option.isNone(steerSession)) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: "steer",
          providerTurnId: input.providerTurnId,
          cause: new ProviderSessionManager.ProviderSessionEndedError({
            providerSessionId: input.providerSessionId,
            ...(context.run === undefined ? {} : { runId: context.run.id }),
          }),
        });
      }
      // A later restart can rebind this thread before an accepted steer runs.
      // Recover the saved message if its original session ended, while keeping
      // live adapter calls guarded by the recorded binding.
      if (!targetsRecordedSession && !targetsCommittedReplacement) {
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          cause: "The recorded provider execution target is no longer valid.",
        });
      }
      // A restart-session command commits the replacement binding before its
      // process-bound effect runs. The old live runtime must still receive
      // the interrupt, but only when the projection matches the exact
      // replacement captured by that same durable effect.
      const interruptProviderThread = targetsRecordedSession
        ? providerThread
        : { ...providerThread, providerSessionId: input.providerSessionId };
      if (providerTurn.status !== "running") {
        if (input.operation === "steer") {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "steer",
            providerTurnId: input.providerTurnId,
            turnCompleted: providerTurn.status === "completed",
            steerNotDelivered: true,
            turnEnded: true,
            cause: "The provider turn ended before the steering message was delivered.",
          });
        }
        return {
          context,
          providerThread: interruptProviderThread,
          providerTurn,
          session: Option.none(),
        };
      }
      const session = steerSession ?? (yield* sessions.get(input.providerSessionId));
      if (Option.isNone(session)) {
        // Interrupt/restart against a already-released session must not fail
        // the durable effect (and retry 5x). The turn may still look running
        // in projection until recovery/finalization; there is no live adapter
        // to interrupt.
        if (input.operation === "interrupt" || input.operation === "restart") {
          yield* Effect.logWarning(
            "Provider interrupt/restart found no live session; treating as already stopped",
            {
              threadId: input.threadId,
              operation: input.operation,
              providerSessionId: input.providerSessionId,
              providerTurnId: input.providerTurnId,
              providerTurnStatus: providerTurn.status,
            },
          );
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        return yield* new ProviderTurnControlError({
          threadId: input.threadId,
          operation: input.operation,
          providerTurnId: input.providerTurnId,
          steerNotDelivered: input.operation === "steer",
          cause: new ProviderSessionManager.ProviderSessionEndedError({
            providerSessionId: input.providerSessionId,
            ...(context.run === undefined ? {} : { runId: context.run.id }),
          }),
        });
      }
      return { context, providerThread: interruptProviderThread, providerTurn, session };
    });

    return ProviderTurnControlServiceV2.of({
      interrupt: Effect.fn("ProviderTurnControlService.interrupt")(
        function* (input) {
          if (input.startingRun !== undefined) {
            const { providerThread } = yield* projections.getProviderControlContext(
              input.threadId,
              input,
            );
            if (providerThread?.providerSessionId !== input.providerSessionId)
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The expired starting run's session binding changed.",
              });
            const runtime = yield* sessions.get(input.providerSessionId);
            if (Option.isNone(runtime)) return;
            if (runtime.value.interruptStartingRun === undefined)
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The adapter cannot stop an unregistered starting turn.",
              });
            return yield* stopAndConfirm(
              runtime.value,
              input,
              providerThread,
              runtime.value.interruptStartingRun({
                providerThread,
                ...input.startingRun,
                stopBackgroundWork: false,
              }),
            ).pipe(Effect.timeout(PROVIDER_START_CLEANUP_TIMEOUT_MS));
          }
          const loaded = yield* load({
            ...input,
            operation: "interrupt",
            allowReplacementInterrupt: input.stopBackgroundWork === false,
          });
          const session = Option.isSome(loaded.session)
            ? loaded.session
            : yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            if (input.subagent !== undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "No live provider session can confirm this subagent's outcome.",
              });
            }
            return;
          }
          if (input.subagent !== undefined) {
            if (session.value.stopSubagent === undefined) {
              return yield* new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause: "The provider does not support stopping a native subagent.",
              });
            }
            return yield* session.value.stopSubagent({
              providerThread: loaded.providerThread,
              nativeTaskId: input.subagent.nativeTaskId,
              ...(input.subagent.requestedAt === undefined
                ? {}
                : { requestedAt: input.subagent.requestedAt }),
            });
          }
          // A settled turn reaches its adapter too: only the adapter knows
          // whether it still runs work for the thread, and each one either
          // stops it or reports there is nothing left to stop.
          const interrupt = session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
            requestRuntimeRestart: input.stopBackgroundWork ?? true,
            ...(input.stopBackgroundWork === false ? { stopBackgroundWork: false } : {}),
          });
          if (input.confirmStopped === true) {
            return yield* stopAndConfirm(
              session.value,
              input,
              loaded.providerThread,
              interrupt,
            ).pipe(Effect.timeout(PROVIDER_START_CLEANUP_TIMEOUT_MS));
          }
          yield* input.stopBackgroundWork === false
            ? interrupt.pipe(Effect.timeout(PROVIDER_START_CLEANUP_TIMEOUT_MS))
            : interrupt;
          // The wait is real time: ingestion runs on other fibers and never
          // advances a test clock, so a test clock would hold Stop forever.
          yield* Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + 2_000;
            while (
              loaded.providerTurn.status === "running" &&
              (yield* Clock.currentTimeMillis) < deadline
            ) {
              const current = yield* projections.getProviderControlContext(input.threadId, input);
              if (
                current.providerTurn?.status !== "running" &&
                current.attempt?.status !== "running"
              ) {
                return;
              }
              yield* Effect.sleep("10 millis");
            }
          }).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "interrupt",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      interruptAndAwaitTerminal: Effect.fn("ProviderTurnControlService.interruptAndAwaitTerminal")(
        function* (input) {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // No live adapter: nothing can emit a terminal provider-turn update
            // from interrupt. Do not poll for projection terminalization or the
            // restart effect stalls; let detach/start proceed.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          const runtime = loaded.session.value;
          yield* runtime.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });
          // The session manager records a native turn end as the event leaves
          // the adapter, while its projection write can sit behind a backlog of
          // earlier events for longer than the cleanup deadline. The native end
          // is what frees the session for the replacement prompt.
          const nativeEnded =
            runtime.hasObservedTurnEnd?.({
              providerThreadId: input.providerThreadId,
              providerTurnId: input.providerTurnId,
            }) ?? Effect.succeed(false);

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            if (yield* nativeEnded) return;
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Provider terminal events are projected on a detached ingestion
            // fiber. Yield through the Node event loop instead of sleeping on
            // Effect's clock so deterministic runtimes cannot deadlock a
            // command that is waiting for that projection.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "restart",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
      steer: Effect.fn("ProviderTurnControlService.steer")(
        function* (input) {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const runtime = loaded.session.value;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          const text = yield* providerUserMessageText(message);
          // Running turns receive steering without passing provider-start admission.
          const recovery = postRecoveryIdentity(input.messageId);
          if (
            input.messageId.startsWith("kanban:post-recovery:") &&
            Option.isSome(kanban) &&
            (recovery === null ||
              !(yield* postRecoveryPending(kanban.value, recovery.discussionId, recovery.seq)))
          )
            return;
          yield* runtime
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  // Session loss cannot establish nondelivery after an unconfirmed submission.
                  if (makeProviderFailure({ cause }).retryable === false) {
                    return yield* new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "steer",
                      providerTurnId: input.providerTurnId,
                      cause,
                    });
                  }
                  // Release removes the runtime before its durable recovery marker commits.
                  // Compare the captured runtime too: a reopened shared ID owns different work.
                  const session = yield* sessions.get(input.providerSessionId);
                  if (Option.isNone(session) || session.value !== runtime) {
                    return yield* new ProviderTurnControlError({
                      threadId: input.threadId,
                      operation: "steer",
                      providerTurnId: input.providerTurnId,
                      cause: new ProviderSessionManager.ProviderSessionEndedError({
                        providerSessionId: input.providerSessionId,
                        runId: run.id,
                      }),
                    });
                  }
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: current.providerTurn?.status === "completed",
                    steerNotDelivered: isSteerRunError(cause) && cause.delivery === "not_sent",
                    cause,
                  });
                }),
              ),
            );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnControlError(cause)
                ? cause
                : new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
