import {
  bootId,
  recordContinuationDecision,
  finishContinuationReport,
} from "../ardud/fast-install/report.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
// ardud: stop the old root turn before committing a restart continuation.
import {
  StaleOpenCodeSessions,
  type StaleOpenCodeSession,
} from "../ardud/opencode-import/StaleRuns.ts";
import { withStartupPhase } from "../ardud/observability/StartupPhaseLog.ts";
// ardud: startup logs one bounded summary of continuation decisions.
import {
  restartContinuationDecision,
  restartContinuationRun,
  type RestartContinuationSkipReason,
} from "./RestartContinuation.ts";
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
  neverStarted,
} from "./RestartBackgroundNote.ts";

// Recovery generations scope queue wake identities; original-run admission is
// still deduplicated by the dispatcher, including overlapping boot effects.
export class RestartRecoveryBootId extends Context.Reference<string>("t3/RestartRecoveryBootId", {
  defaultValue: () => bootId,
}) {}

// Only startup continuation work may bypass global command readiness. The callback
// runs after the thread's reconciliation transaction commits, never inside it.
export class ReconciledThreadContinuation extends Context.Reference<
  (threadId: ThreadId) => Effect.Effect<void>
>("t3/ReconciledThreadContinuation", { defaultValue: () => () => Effect.void }) {}

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly staleOpenCodeAborted: number;
  readonly staleOpenCodeAbortFailed: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly staleOpenCodeAborted: number;
  readonly staleOpenCodeAbortFailed: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
}): boolean {
  return task.origin === "app_owned" && task.childThreadId !== null;
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
}

function providerThreadHasPendingBackgroundTasks(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
): boolean {
  return (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
}

function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? { ...item, status: "cancelled", secretStatus: "cancelled", completedAt: now, updatedAt: now }
    : { ...item, status: "cancelled", completedAt: now, updatedAt: now };

function latestStartedRun(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerThreadId: ProviderThreadId,
) {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      !neverStarted(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  // ardud: old test and standalone layers need not provide the optional service.
  const staleOpenCode = yield* Effect.serviceOption(StaleOpenCodeSessions);
  type RecoverySession = ProjectionStore.ProjectionRuntimeRecoveryState["providerSessions"][number];
  /**
   * Shared sessions are stopped once before thread recovery. Restore their live
   * status when deciding whether each running thread should continue.
   */
  const sessionsLiveAtStart = (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
    stoppedThisPass: ReadonlyMap<string, RecoverySession>,
  ) => {
    const sessions = new Map(projection.providerSessions.map((session) => [session.id, session]));
    for (const providerThread of projection.providerThreads) {
      const stopped =
        providerThread.providerSessionId === null
          ? undefined
          : stoppedThisPass.get(providerThread.providerSessionId);
      if (stopped !== undefined) sessions.set(stopped.id, stopped);
    }
    return [...sessions.values()];
  };

  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      // ardud: keep the settings failure distinct from an explicit opt-out.
      continuationSetting: "enabled" | "settings_disabled" | "settings_unreadable",
      stoppedThisPass: ReadonlyMap<string, RecoverySession> = new Map(),
    ) {
      const now = yield* DateTime.now;
      const recoveryBootId = yield* RestartRecoveryBootId;
      const runs = [] as Array<OrchestrationV2ThreadProjection["runs"][number]>;
      for (const run of nonterminalRuns(projection)) {
        if (run.status === "waiting") {
          const checkpointEffects = yield* outbox
            .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({
                    operation: "reconcile",
                    threadId: projection.thread.id,
                    cause,
                  }),
              ),
            );
          const hasReplayableCheckpoint = checkpointEffects.some(
            (effect) =>
              effect.request.type === "checkpoint.capture" &&
              effect.request.runId === run.id &&
              (effect.status === "pending" || effect.status === "running"),
          );
          if (hasReplayableCheckpoint) continue;
        }
        runs.push(run);
      }
      const messageRequestNodeIds = new Set(
        projection.runtimeRequests
          .filter(
            (request) =>
              request.status === "pending" && request.responseCapability.type === "message",
          )
          .map((request) => request.nodeId),
      );
      const requests = projection.runtimeRequests.filter(
        (request) => request.status === "pending" && request.responseCapability.type !== "message",
      );
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      const cancelledBackgroundWork = new Map<
        ProviderThreadId,
        Array<OrchestrationV2RestartCancelledBackgroundWork>
      >();
      const cancelledBackgroundNativeIds = new Set<string>();
      const recordCancelledBackgroundWork = (
        providerThreadId: ProviderThreadId | null | undefined,
        work: OrchestrationV2RestartCancelledBackgroundWork,
      ) => {
        if (providerThreadId == null) return;
        const existing = cancelledBackgroundWork.get(providerThreadId);
        if (existing === undefined) cancelledBackgroundWork.set(providerThreadId, [work]);
        else existing.push(work);
      };
      const recordCancelledBackgroundItem = (
        item: OrchestrationV2ThreadProjection["turnItems"][number],
      ) => {
        if (!isBackgroundCapableTurnItemType(item.type)) return;
        const awaitingId = awaitingProviderThreadId(item, projection.runs);
        const ownProviderThread =
          item.providerThreadId === awaitingId
            ? undefined
            : (projection.providerThreads ?? []).find(
                (candidate) => candidate.id === item.providerThreadId,
              );
        const work = cancelledTurnItemWork(
          item,
          ownProviderThread?.nativeThreadRef?.nativeId ?? undefined,
        );
        if (work === undefined) return;
        recordCancelledBackgroundWork(awaitingId, work);
        if (item.nativeItemRef?.nativeId != null) {
          cancelledBackgroundNativeIds.add(item.nativeItemRef.nativeId);
        }
      };
      // Queued messages are durable work, including provider notifications. Keep
      // their identities, delivery order and explicit user holds across restarts.
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      if (trigger === "startup" && continuationSetting !== "enabled") {
        for (const run of queuedRuns.filter((candidate) => candidate.queueHeld !== true))
          events.push({
            id: yield* allocateEventId(),
            type: "run.updated",
            threadId: projection.thread.id,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, queueHeld: true },
          });
      }
      if (queuedRuns.length > 0) {
        const queued = yield* projections
          .getThreadRecords(projection.thread.id, ["messages"], {
            messageIds: queuedRuns.map((run) => run.userMessageId),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "read-projections",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        for (const message of queued.messages.filter(isBufferedProviderNotification)) {
          // The provider's in-memory output buffer died with the process. Replaying
          // a provider-created wake would complete an empty turn (Claude) instead
          // of sending a prompt. Keep its identity/order and send its durable text.
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            ...(message.runId === null ? {} : { runId: message.runId }),
            occurredAt: now,
            payload: {
              ...message,
              creationSource: "server",
              text: `${message.text}\n\nContinue where you left off.`,
              updatedAt: now,
            },
          });
        }
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: now },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: now },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: now },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          // A native subagent does not come back when its cut turn resumes, so the
          // turn's continuation is told to restart it.
          if (run.status === "waiting") recordCancelledBackgroundItem(item);
          else if (item.type === "subagent" && item.origin === "provider_native")
            recordCancelledBackgroundItem(item);
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: cancelledItem(item, now),
          });
        }
      }
      // A blocking delegate_task wait dies with the turn that made it, and its
      // continuation never got the tool result. Let the child's result wake
      // the parent like an async task, so it reaches the continued turn.
      const cutRunIds = new Set(runs.map((run) => run.id));
      for (const task of projection.subagents ?? []) {
        if (
          task.origin !== "app_owned" ||
          task.runId === null ||
          !cutRunIds.has(task.runId) ||
          task.completionWake !== "settled_only" ||
          !isOrchestrationV2WorkActive(task.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          runId: task.runId,
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: { ...task, completionWake: "always", updatedAt: now },
        });
      }
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (!isNonterminalTurnItemStatus(item.status) || isAppOwnedDelegationItem(item)) {
          continue;
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        recordCancelledBackgroundItem(item);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId && isNonterminalNodeStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
            cancelledStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: now },
            });
          }
        }
      }
      // No provider process outlives the server, so a native subagent still open
      // here never reports its end, whatever state its run and item are in.
      for (const subagent of projection.subagents ?? []) {
        events.push(
          ...(yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.id,
            status: "cancelled",
            now,
            emitted: events,
            allocateEventId,
          })),
        );
      }
      // A provider-native subagent thread has no runs; left running, the child
      // would show as working forever.
      events.push(
        ...(yield* endRunlessRootTurns({
          threadId: projection.thread.id,
          providerInstanceId: projection.thread.providerInstanceId,
          projection,
          status: "cancelled",
          now,
          emitted: events,
          allocateEventId,
        })),
      );
      // ardud: only root provider threads whose running work is being cut qualify.
      const staleSessions: Array<StaleOpenCodeSession> = [];
      for (const providerThread of projection.providerThreads ?? []) {
        const needsIdle = providerThread.status === "active";
        const needsRosterClear = providerThreadHasPendingBackgroundTasks(providerThread);
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        if (
          trigger === "startup" &&
          needsIdle &&
          providerThread.ownerNodeId === null &&
          providerThread.driver === "opencode" &&
          nativeId != null &&
          nativeId.startsWith("ses_") &&
          runs.some((run) => run.providerThreadId === providerThread.id && run.status !== "queued")
        ) {
          staleSessions.push({
            sessionId: nativeId,
            providerInstanceId: providerThread.providerInstanceId,
            // This projection has no project record; don't add a separate read during recovery.
            directory: projection.thread.worktreePath ?? null,
          });
        }
        if (!needsIdle && !needsRosterClear) {
          continue;
        }
        if (providerThread.ownerNodeId === null) {
          for (const task of providerThread.pendingBackgroundTasks ?? []) {
            // A subagent already recorded covers the shells it started.
            if (
              cancelledBackgroundNativeIds.has(task.taskId) ||
              (task.parentTaskId !== undefined &&
                cancelledBackgroundNativeIds.has(task.parentTaskId))
            )
              continue;
            cancelledBackgroundNativeIds.add(task.taskId);
            recordCancelledBackgroundWork(providerThread.id, cancelledRosterTaskWork(task));
          }
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const session of projection.providerSessions.filter(
        (candidate) =>
          !stoppedThisPass.has(candidate.id) &&
          candidate.status !== "stopped" &&
          candidate.status !== "error",
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, work] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection, providerThreadId);
        if (noteRun === undefined) continue;
        // Its own event: a run snapshot read before this commit could regress
        // a lifecycle change (e.g. a checkpoint completing the run) made since.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
              noteRun.restartCancelledBackgroundWork ?? [],
              work,
            ),
          },
        });
      }
      // ardud: take the decision before cancellation, while per-thread facts are still live.
      const continuationDecision =
        trigger !== "startup"
          ? undefined
          : continuationSetting !== "enabled"
            ? { skip: continuationSetting }
            : restartContinuationDecision(
                {
                  ...projection,
                  providerSessions: sessionsLiveAtStart(projection, stoppedThisPass),
                },
                now,
              );
      const continuationRun =
        continuationDecision && "run" in continuationDecision
          ? continuationDecision.run
          : undefined;
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-${continuationRun.status === "queued" ? `queue:${recoveryBootId}` : "continuation"}:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: {
                type: "provider-runtime.continue",
                sourceRunId: continuationRun.id,
                ...(continuationRun.status === "queued" ? { queued: true } : {}),
              },
            },
          ]
        : [];
      // A source continuation can legitimately decline (for example a stale
      // native turn). Its follow-up queue still needs its own durable wake.
      if (
        trigger === "startup" &&
        continuationSetting === "enabled" &&
        continuationRun?.status !== "queued"
      ) {
        const queued = restartContinuationRun(
          { ...projection, runs: projection.runs.filter((run) => run.status === "queued") },
          now,
        );
        if (queued)
          effects.push({
            id: `effect:restart-queue:${recoveryBootId}:${queued.id}`,
            commandId,
            threadId: projection.thread.id,
            request: { type: "provider-runtime.continue", sourceRunId: queued.id, queued: true },
          });
      }
      // EventSink requires an event-bearing commit. This also makes an otherwise
      // idle queue's durable wake-up atomic with its recovery decision.
      if (events.length === 0 && !continuationRun && effects.length > 0) {
        events.push({
          id: yield* allocateEventId(),
          type: "thread.metadata-updated",
          threadId: projection.thread.id,
          occurredAt: now,
          payload: projection.thread,
        });
      }
      if (events.length === 0 && continuationRun) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: continuationRun.id,
          providerInstanceId: continuationRun.providerInstanceId,
          occurredAt: now,
          payload: continuationRun,
        });
      }
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) =>
          !stoppedThisPass.has(candidate.id) &&
          candidate.status !== "stopped" &&
          candidate.status !== "error",
      ).length;
      let retiredEffects: number;
      // ardud: count only continuation effects submitted with a committed reconciliation.
      let continuationsQueued = 0;
      // ardud: an outbox continuation can begin as soon as commitCommand returns.
      // Keep failures (including defects from a test implementation) out of recovery.
      const staleResult =
        trigger === "startup" && staleSessions.length > 0 && Option.isSome(staleOpenCode)
          ? yield* staleOpenCode.value.abort(staleSessions).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                () => Effect.succeed({ aborted: 0, failed: staleSessions.length }),
              ),
            )
          : { aborted: 0, failed: 0 };
      if (events.length === 0 && effects.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
        if (result.committed) continuationsQueued = effects.length;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
        continuationsQueued,
        staleOpenCodeAborted: staleResult.aborted,
        staleOpenCodeAbortFailed: staleResult.failed,
        continuationSkip:
          continuationDecision && "skip" in continuationDecision
            ? continuationDecision.skip
            : continuationRun && continuationsQueued === 0
              ? ("already_reconciled" as const)
              : undefined,
      };
    },
  );

  const reconcileWithCounts = Effect.fn("ProviderRuntimeRecoveryService.reconcile")(function* (
    trigger: "startup" | "shutdown",
  ) {
    // ardud: malformed settings silently fall back to an opt-out, but should not be logged as one.
    const settingsSnapshot =
      trigger === "startup"
        ? yield* settings.getSettingsWithTrust.pipe(Effect.orElseSucceed(() => null))
        : null;
    const onReconciled = yield* ReconciledThreadContinuation;
    // Reset old leases before any new worker starts. Resetting them at the end
    // would steal claims from continuations already running in this process.
    const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
      ),
    );
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    let terminalizedRuns = 0;
    let stoppedSessions = 0;
    let closedRequests = 0;
    let retiredEffects = 0;
    let staleOpenCodeAborted = 0;
    let staleOpenCodeAbortFailed = 0;
    // ardud: these counts are per recovery projection, not per emitted event.
    let continuationsQueued = 0;
    const skipped: Record<
      RestartContinuationSkipReason | "settings_disabled" | "settings_unreadable",
      number
    > = {
      settings_disabled: 0,
      settings_unreadable: 0,
      blocked: 0,
      no_provider_thread: 0,
      provider_thread_not_active: 0,
      no_session: 0,
      session_stopped_or_error: 0,
      no_running_turn: 0,
      no_candidate: 0,
      run_not_resumable: 0,
      provider_changed: 0,
      invalid_provider_thread: 0,
      no_awaited_work: 0,
      already_reconciled: 0,
    };
    const stoppedThisPass = new Map<string, RecoverySession>();
    const sharedSessions = yield* projections
      .getLiveSharedProviderSessions()
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    // Preserve live status for continuation decisions before stopping global rows.
    for (const { threadId, session } of sharedSessions) {
      stoppedThisPass.set(session.id, session);
      const now = yield* DateTime.now;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:session:${session.id}:${DateTime.formatIso(now)}`,
      );
      yield* Effect.gen(function* () {
        yield* eventSink.commitCommand({
          commandId,
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: yield* ids.allocate.event({ threadId, commandId }),
              type: "provider-session.updated",
              threadId,
              driver: session.driver,
              providerInstanceId: session.providerInstanceId,
              occurredAt: now,
              payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
            },
          ],
          effects: [],
        });
      }).pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", threadId, cause }),
        ),
      );
      stoppedSessions++;
    }

    const priority =
      trigger === "startup"
        ? yield* projections
            .getRecoveryThreadIds("interrupted-runs")
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
              ),
            )
        : [];
    const recoverThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "read-projections",
                threadId,
                cause,
              }),
          ),
        );
        // ardud: unreadable settings never enable continuation, even with a project override.
        const continuationSetting =
          settingsSnapshot === null || !settingsSnapshot.trusted
            ? ("settings_unreadable" as const)
            : resolveProjectSettings(settingsSnapshot.settings, projection.thread.projectId)
                  .settings.continueThreadsAfterServerUpdate
              ? ("enabled" as const)
              : ("settings_disabled" as const);
        const result = yield* reconcileProjection(
          projection,
          trigger,
          continuationSetting,
          stoppedThisPass,
        );
        for (const session of projection.providerSessions) {
          if (
            !stoppedThisPass.has(session.id) &&
            session.status !== "stopped" &&
            session.status !== "error"
          ) {
            stoppedThisPass.set(session.id, session);
          }
        }
        terminalizedRuns += result.terminalizedRuns;
        stoppedSessions += result.stoppedSessions;
        closedRequests += result.closedRequests;
        retiredEffects += result.retiredEffects;
        continuationsQueued += result.continuationsQueued;
        staleOpenCodeAborted += result.staleOpenCodeAborted;
        staleOpenCodeAbortFailed += result.staleOpenCodeAbortFailed;
        if (result.continuationSkip !== undefined) skipped[result.continuationSkip]++;
        if (trigger === "startup")
          recordContinuationDecision({
            threadId,
            continued: result.continuationsQueued > 0,
            ...(result.continuationsQueued > 0
              ? {}
              : { reason: result.continuationSkip ?? "no_candidate" }),
          });
        if (trigger === "startup") yield* onReconciled(threadId);
      });
    yield* Effect.forEach(priority, recoverThread, { concurrency: 4, discard: true });
    const priorityIds = new Set(priority);
    yield* Effect.forEach(
      threadIds.filter((id) => !priorityIds.has(id)),
      recoverThread,
      { concurrency: 4, discard: true },
    );
    // ardud: one startup log, including zero-candidate starts, for post-restart diagnosis.
    if (trigger === "startup") {
      finishContinuationReport();
      yield* Effect.logInfo("orchestration-v2.restart-continuation.summary", {
        threadsRead: threadIds.length,
        runsCancelled: terminalizedRuns,
        continuationsQueued,
        skipped,
      });
    }
    return {
      terminalizedRuns,
      stoppedSessions,
      closedRequests,
      retiredEffects: retiredEffects + outboxReconciliation.cancelled,
      requeuedEffects: outboxReconciliation.requeued,
      staleOpenCodeAborted,
      staleOpenCodeAbortFailed,
      recoveryIds: threadIds.length,
    } satisfies ProviderRuntimeReconciliationSummary & { readonly recoveryIds: number };
  });

  const reconcile = (trigger: "startup" | "shutdown") => {
    const work = reconcileWithCounts(trigger);
    return (
      trigger === "startup"
        ? withStartupPhase("orchestration-v2.recovery.reconcile", work, (result) => ({
            recoveryIds: result.recoveryIds,
            terminalizedRuns: result.terminalizedRuns,
          }))
        : work
    ).pipe(Effect.map(({ recoveryIds: _recoveryIds, ...summary }) => summary));
  };

  const prepareForShutdown = Effect.gen(function* () {
    const recoveryBootId = yield* RestartRecoveryBootId;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
      yield* Effect.gen(function* () {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
        if (
          !resolveProjectSettings(enabled, projection.thread.projectId).settings
            .continueThreadsAfterServerUpdate
        )
          return;
        const run = restartContinuationRun(projection, yield* DateTime.now);
        if (!run) return;
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* eventSink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            {
              id: `effect:restart-${run.status === "queued" ? `queue:${recoveryBootId}` : "continuation"}:${run.id}`,
              commandId,
              threadId,
              request: {
                type: "provider-runtime.continue",
                sourceRunId: run.id,
                ...(run.status === "queued" ? { queued: true } : {}),
              },
            },
          ],
        });
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause })),
  );

  const recover = Effect.gen(function* () {
    return (yield* reconcile("startup")) satisfies ProviderRuntimeRecoverySummary;
  });

  return ProviderRuntimeRecoveryService.of({ reconcile, prepareForShutdown, recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
