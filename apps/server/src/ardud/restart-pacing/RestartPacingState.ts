import { isRuntimeFailure } from "../kanban/engine/rules.ts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  rootRuntimeLoss,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { countsAsUserTurn } from "../control/turns.ts";
import { isRecoveredQueueRun } from "../fast-install/report.ts";
import { TurnItemId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ControlStore from "../control/ControlStore.ts";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";

export interface RestartSource {
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly effectId?: string | undefined;
  readonly activityAt?: number | undefined;
  readonly classification?: "continuation" | "recovered-queue" | "pending-continuation-race";
}

export interface RestartWait {
  readonly total: number;
  readonly active: number;
  readonly maxActive: number;
  readonly spacingMs: number;
  readonly loadHoldElapsedMs: number;
  readonly loadHoldRemainingMs: number;
}

export class RestartPacingStateError extends Schema.TaggedError<RestartPacingStateError>()(
  "RestartPacingStateError",
  { cause: Schema.Defect() },
) {}

export class RestartPacingState extends Context.Service<
  RestartPacingState,
  {
    readonly pending: (source: RestartSource) => Effect.Effect<boolean, RestartPacingStateError>;
    readonly wake: (source: RestartSource) => Effect.Effect<boolean, RestartPacingStateError>;
    readonly hasSuccessor: (
      source: RestartSource,
      runId?: RunId,
    ) => Effect.Effect<boolean, RestartPacingStateError>;
    readonly sourceForRun: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<RestartSource | undefined, RestartPacingStateError>;
    readonly describe: (source: RestartSource) => Effect.Effect<
      {
        readonly priority: number;
        readonly activityAt: number;
      },
      RestartPacingStateError
    >;
    readonly active: (
      source: RestartSource,
      runId?: RunId,
    ) => Effect.Effect<boolean, RestartPacingStateError>;
    readonly status: (
      source: RestartSource,
      position: number | null,
      wait?: RestartWait,
      isCurrent?: () => boolean,
    ) => Effect.Effect<boolean, RestartPacingStateError>;
  }
>()("t3/ardud/restart-pacing/RestartPacingState") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const control = yield* ControlStore.ControlStore;
  const boards = yield* KanbanStore.KanbanStore;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const startupAt = yield* DateTime.now;
  const pending = Effect.fn("RestartPacingState.pending")(
    function* (source: RestartSource) {
      if (source.effectId === undefined) return true;
      const effect = yield* outbox.get(source.effectId);
      return (
        Option.isSome(effect) &&
        (effect.value.status === "pending" || effect.value.status === "running")
      );
    },
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const sourceForRun = Effect.fn("RestartPacingState.sourceForRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const projection = yield* projections.getThreadRecords(threadId, ["runs"], {
        runIds: [runId],
      });
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run?.status !== "starting") return undefined;
      const sourceRunId =
        run.restartContinuationOfRunId ?? (isRecoveredQueueRun(runId) ? runId : undefined);
      if (sourceRunId !== undefined)
        return {
          threadId,
          sourceRunId,
          classification:
            run.restartContinuationOfRunId === undefined
              ? ("recovered-queue" as const)
              : ("continuation" as const),
        };
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      if (
        message === undefined ||
        message.scheduledTaskId !== undefined ||
        countsAsUserTurn({
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          messageId: message.id,
        })
      )
        return undefined;
      const recorded = yield* projections.getTurnItem({
        threadId,
        itemId: TurnItemId.make(`turn-item:restart-pacing:${runId}`),
      });
      if (recorded === null) {
        if (
          !(yield* outbox.hasRunContinuationAt({
            threadId,
            requestedAt: run.requestedAt,
            startupAt,
          }))
        )
          return undefined;
        const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
        // Only wakes requested after a provider start in this boot are fresh.
        // A racing wake stays in the backlog even if its start claim arrives later.
        if (
          runs.some(
            (candidate) =>
              candidate.id !== runId &&
              candidate.startedAt !== null &&
              DateTime.isGreaterThanOrEqualTo(candidate.startedAt, startupAt) &&
              DateTime.isLessThanOrEqualTo(candidate.startedAt, run.requestedAt),
          )
        )
          return undefined;
      }
      return { threadId, sourceRunId: runId, classification: "pending-continuation-race" as const };
    },
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const describe = Effect.fn("RestartPacingState.describe")(
    function* (source: RestartSource) {
      const projection = yield* projections.getThreadRecords(source.threadId, ["runs"]);
      const sourceChain = new Set<RunId>();
      let sourceRunId: RunId | undefined = source.sourceRunId;
      while (sourceRunId !== undefined && !sourceChain.has(sourceRunId)) {
        sourceChain.add(sourceRunId);
        sourceRunId = projection.runs.find(
          (run) => run.id === sourceRunId,
        )?.restartContinuationOfRunId;
      }
      const relevant = projection.runs.filter(
        (run) =>
          sourceChain.has(run.id) ||
          ["queued", "preparing", "starting", "running"].includes(run.status),
      );
      const { messages } = yield* projections.getThreadRecords(source.threadId, ["messages"], {
        messageIds: relevant.map((run) => run.userMessageId),
      });
      const project = yield* projects.get(projection.thread.projectId);
      const origin = yield* control.getOrigin(source.threadId);
      const link = yield* boards.threadLink(source.threadId);
      const discussion =
        link === null ? yield* boards.discussionByEvaluator(source.threadId) : null;
      const run = projection.runs.find((candidate) => candidate.id === source.sourceRunId);
      let runtimeRecovery = false;
      if (link?.role === "work") {
        const cards = yield* boards.cardsByThread(source.threadId);
        if (
          cards.some(
            (card) =>
              card.stage === "working" &&
              card.activeRole === "work" &&
              card.activeThreadId === source.threadId &&
              card.stalled === null,
          )
        ) {
          const executed = latestExecutedRun(
            projection.runs.filter(
              (candidate) => candidate.status !== "starting" && candidate.status !== "preparing",
            ),
          );
          if (executed?.status === "failed" || executed?.status === "cancelled") {
            const { turnItems } = yield* projections.getThreadRecords(
              source.threadId,
              ["turnItems"],
              { turnItemTypes: ["error"] },
            );
            const failure =
              latestRootProviderFailure(executed, turnItems) ??
              rootRuntimeLoss(executed, turnItems);
            runtimeRecovery =
              failure !== null &&
              isRuntimeFailure(failure) &&
              (failure.code === "provider.runtime_lost" ||
                failure.code === "codex.runtime_lost" ||
                failure.code === "codex.tool_host_lost");
          }
        }
      }
      const pendingUser = relevant.some((candidate) =>
        messages.some(
          (message) =>
            message.id === candidate.userMessageId &&
            message.scheduledTaskId === undefined &&
            countsAsUserTurn({
              createdBy: message.createdBy,
              creationSource: message.creationSource,
              messageId: message.id,
            }),
        ),
      );
      return {
        priority:
          origin === "imessage" ||
          (Option.isSome(project) && project.value.title === "iMessage") ||
          pendingUser
            ? 0
            : runtimeRecovery
              ? 0.5
              : link?.role === "evaluator" || discussion !== null
                ? 1
                : link !== null
                  ? 2
                  : 3,
        activityAt:
          source.activityAt ??
          DateTime.toEpochMillis(run?.startedAt ?? run?.requestedAt ?? projection.thread.updatedAt),
      };
    },
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const active = Effect.fn("RestartPacingState.active")(
    function* (source: RestartSource, runId?: RunId) {
      const projection = yield* projections.getThreadRecords(source.threadId, [
        "runs",
        "providerTurns",
      ]);
      const run =
        runId === undefined
          ? (projection.runs.find(
              (candidate) => candidate.restartContinuationOfRunId === source.sourceRunId,
            ) ?? projection.runs.find((candidate) => candidate.id === source.sourceRunId))
          : projection.runs.find((candidate) => candidate.id === runId);
      // startedAt precedes native acceptance; the startup finalizer owns
      // releasing live reservations.
      if (!run || !["preparing", "starting", "running"].includes(run.status)) return false;
      const turn = projection.providerTurns
        .filter(
          (candidate) =>
            candidate.nodeId === run.rootNodeId && candidate.runAttemptId === run.activeAttemptId,
        )
        .sort((a, b) => b.ordinal - a.ordinal)[0];
      return !turn || turn.status === "pending" || turn.status === "running";
    },
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const status = Effect.fn("RestartPacingState.status")(
    function* (
      source: RestartSource,
      position: number | null,
      wait?: RestartWait,
      isCurrent?: () => boolean,
    ) {
      // Waiting notes publish outside the pacer mutex. Check freshness under
      // the thread lock so a delayed snapshot cannot overwrite admission.
      if (isCurrent !== undefined && !isCurrent()) return true;
      const projection = yield* projections.getThreadRecords(source.threadId, ["runs"]);
      const run = projection.runs.find((candidate) => candidate.id === source.sourceRunId);
      if (!run) return true;
      const now = yield* DateTime.now;
      const itemId = TurnItemId.make(`turn-item:restart-pacing:${source.sourceRunId}`);
      const previous = yield* projections.getTurnItem({ threadId: source.threadId, itemId });
      if (previous === null && position === null) return true;
      if (position === null && previous?.status === "waiting" && source.effectId !== undefined) {
        const effect = yield* outbox.get(source.effectId);
        if (
          (Option.isNone(effect) ||
            (effect.value.status !== "pending" && effect.value.status !== "running")) &&
          (yield* outbox.hasPendingRunStart({
            threadId: source.threadId,
            runIds: projection.runs
              .filter(
                (candidate) =>
                  candidate.id === run.id || candidate.restartContinuationOfRunId === run.id,
              )
              .map((candidate) => candidate.id),
          }))
        )
          // An old claim's cleanup must not complete a replacement's wait.
          return false;
      }
      // Completion replaces the saved item, including its diagnostic detail.
      const detail =
        position === null
          ? previous?.type === "notification"
            ? previous.detail
            : undefined
          : wait === undefined
            ? undefined
            : [
                `Source: ${source.classification ?? "continuation"}.`,
                `Queue: position ${position} of ${wait.total}.`,
                ...(wait.active >= wait.maxActive
                  ? [`Active: ${wait.active}/${wait.maxActive} (maxActive).`]
                  : []),
                ...(wait.spacingMs > 0
                  ? [`Spacing: ${Math.ceil(wait.spacingMs / 1000)}s remaining.`]
                  : []),
                ...(wait.loadHoldRemainingMs > 0
                  ? [
                      `Load hold: ${Math.floor(wait.loadHoldElapsedMs / 1000)}s elapsed, ${Math.ceil(wait.loadHoldRemainingMs / 1000)}s remaining.`,
                    ]
                  : []),
              ].join(" ");
      const commandId = yield* ids.allocate.command({
        fixtureName: "restart-pacing",
        commandName: "status",
      });
      yield* sink.commitCommand({
        commandId,
        threadId: source.threadId,
        commandType: "provider-runtime.reconcile",
        acceptedAt: now,
        events: [
          {
            id: yield* ids.allocate.event({ threadId: source.threadId, commandId }),
            type: "turn-item.updated",
            threadId: source.threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: itemId,
              threadId: source.threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal:
                previous?.ordinal ?? (yield* projections.getNextTurnItemOrdinal(source.threadId)),
              type: "notification",
              source: { kind: "system" },
              outcome: "updated",
              summary:
                position === null
                  ? "Restart wait ended"
                  : `Resuming after restart (position ${position}${wait ? ` of ${wait.total}` : ""})`,
              ...(detail === undefined ? {} : { detail }),
              title: null,
              status: position === null ? "completed" : "waiting",
              startedAt: previous?.startedAt ?? now,
              completedAt: position === null ? now : null,
              updatedAt: now,
            },
          },
        ],
        effects: [],
      });
      return true;
    },
    // Linearize clearing the wait with fresh-message admission. A fresh send
    // cannot demote a stale waiting snapshot after this start was admitted.
    (effect, source) => threadCommands.withLock(source.threadId, effect),
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const wake = Effect.fn("RestartPacingState.wake")(
    (source: RestartSource) =>
      source.effectId === undefined
        ? Effect.succeed(true)
        : outbox.wakeRestartEffect(source.effectId),
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  const hasSuccessor = Effect.fn("RestartPacingState.hasSuccessor")(
    function* (source: RestartSource, runId?: RunId) {
      const { runs } = yield* projections.getThreadRecords(source.threadId, ["runs"]);
      return runs.some(
        (run) =>
          run.id !== (runId ?? source.sourceRunId) &&
          ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      );
    },
    Effect.mapError((cause) => new RestartPacingStateError({ cause })),
  );
  return RestartPacingState.of({
    pending,
    sourceForRun,
    describe,
    active,
    status,
    wake,
    hasSuccessor,
  });
});
export const layer = Layer.effect(RestartPacingState, make);
