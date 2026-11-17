import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  normalizeIdleTimeout,
  isProgressActivity,
  progressBlockers,
  latestQualifyingProgress,
  stalledSummary,
  stallPhase,
  silentRecoveryStillSafe,
  supportsSilentRecovery,
} from "./delegatedTaskProgress.ts";

const CLAUDE_NO_RESPONSE_BUDGET_MS = 5 * 60_000;
const CLAUDE_RETRY_FLAP_LIMIT = 20;

type Progress = {
  lastProgressAt: DateTime.Utc;
  lastProgressKind: string;
  thinkingSince: DateTime.Utc | null;
};
type Child = Progress & {
  run: OrchestrationV2Run;
  retryCheck?: Effect.Effect<boolean> | undefined;
  retrySessionId?: string | null;
  idleTimeoutMs: number;
  inactiveSince: DateTime.Utc | null;
  stopping: boolean;
  checking: boolean;
  blockers: Set<string>;
  seen: Map<string, string>;
};

export class DelegatedTaskProgressGuard extends Context.Service<
  DelegatedTaskProgressGuard,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly check: () => Effect.Effect<void>;
    readonly status: (threadId: ThreadId) => {
      lastProgressAt: string | null;
      lastProgressKind: string | null;
      thinkingSince: string | null;
    };
  }
>()("t3/orchestration-v2/DelegatedTaskProgressGuard") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const children = new Map<ThreadId, Child>();
  const limits = new Map<ThreadId, number>();
  const boot = yield* DateTime.now;

  // Called for streaming events; tracing each chunk would dominate this bookkeeping.
  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (
      event.type === "subagent.updated" &&
      event.payload.origin === "app_owned" &&
      event.payload.childThreadId !== null
    ) {
      if (["completed", "failed", "interrupted", "cancelled"].includes(event.payload.status)) {
        const current = children.get(event.payload.childThreadId);
        if (current === undefined || current.run.delegatedTaskId === event.payload.id)
          limits.delete(event.payload.childThreadId);
      } else {
        const idleTimeoutMs = normalizeIdleTimeout(event.payload.idleTimeoutMs);
        limits.set(event.payload.childThreadId, idleTimeoutMs);
        const current = children.get(event.payload.childThreadId);
        if (
          current !== undefined &&
          (current.run.delegatedTaskId === undefined ||
            current.run.delegatedTaskId === event.payload.id)
        )
          current.idleTimeoutMs = idleTimeoutMs;
      }
    }
    if (event.type === "run.created" || event.type === "run.updated") {
      const run = event.payload;
      if (run.delegatedTaskId === undefined && !limits.has(event.threadId)) return;
      let child = children.get(event.threadId);
      if (
        child !== undefined &&
        child.run.id !== run.id &&
        (run.status === "queued" || run.ordinal < child.run.ordinal)
      )
        return;
      if (child === undefined || child.run.id !== run.id) {
        const now = yield* DateTime.now;
        // Interrupted thinking can be restarted by a parent steer. It retains
        // the clock; an independently completed task's follow-up starts fresh.
        const previous = child;
        child = {
          run,
          idleTimeoutMs:
            limits.get(event.threadId) ?? previous?.idleTimeoutMs ?? normalizeIdleTimeout(),
          lastProgressAt: previous?.lastProgressAt ?? now,
          lastProgressKind:
            previous?.lastProgressKind ??
            (run.status === "running" ? "run_started" : "not_started"),
          thinkingSince: previous?.thinkingSince ?? null,
          inactiveSince: null,
          stopping: false,
          checking: false,
          blockers: new Set(),
          seen: new Map(),
        };
        children.set(event.threadId, child);
      }
      if (run.status === "running" && child.lastProgressKind === "not_started") {
        child.lastProgressAt = event.occurredAt;
        child.lastProgressKind = "run_started";
      }
      if (child.run.activeAttemptId !== run.activeAttemptId) {
        child.retryCheck = undefined;
        child.stopping = false;
        child.lastProgressAt = event.occurredAt;
        child.lastProgressKind = run.status === "running" ? "run_started" : "not_started";
        child.thinkingSince = null;
      }
      child.run = run;
      if (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) {
        child.blockers.clear();
        child.seen.clear();
        child.thinkingSince = null;
        if (
          run.status === "completed" ||
          run.status === "failed" ||
          child.stopping ||
          run.delegatedTaskStall !== undefined
        ) {
          children.delete(event.threadId);
          limits.delete(event.threadId);
        } else {
          // An immediate parent restart retains the clock, without retaining
          // tool/text payloads for a child that stays stopped.
          child.inactiveSince = event.occurredAt;
        }
      } else {
        child.inactiveSince = null;
      }
      return;
    }
    const child = children.get(event.threadId);
    if (
      event.type === "provider-thread.updated" &&
      child?.run.providerThreadId === event.payload.id &&
      child.retrySessionId !== event.payload.providerSessionId
    ) {
      child.retryCheck = undefined;
      child.retrySessionId = event.payload.providerSessionId;
    }
    if (
      child === undefined ||
      (event.type !== "runtime-request.updated" && event.runId !== child.run.id)
    )
      return;
    const progress = (kind: string) => {
      child.lastProgressAt = event.occurredAt;
      child.lastProgressKind = kind;
      child.thinkingSince = null;
    };
    if (
      event.type === "message.updated" &&
      event.payload.role === "assistant" &&
      event.payload.text.length > 0
    ) {
      const key = `text:${event.payload.id}`;
      if (child.seen.get(key) !== event.payload.text) {
        child.seen.set(key, event.payload.text);
        progress("assistant_text");
      }
    } else if (event.type === "runtime-request.updated") {
      const key = `request:${event.payload.id}`;
      const status = event.payload.status;
      if (status === "pending") child.blockers.add(key);
      else child.blockers.delete(key);
      if (child.seen.get(key) !== status) {
        child.seen.set(key, status);
        progress(status === "pending" ? "request_opened" : "request_resolved");
      }
    } else if (event.type === "turn-item.updated") {
      const item = event.payload;
      if (item.type === "reasoning") {
        child.thinkingSince ??= event.occurredAt;
        return;
      }
      if (item.type === "assistant_message" && item.text.length > 0) {
        const key = `item-text:${item.id}`;
        if (child.seen.get(key) !== item.text) {
          child.seen.set(key, item.text);
          progress("assistant_text");
        }
      }
      if (!isProgressActivity(item)) return;
      const key = `item:${item.id}`;
      const pending =
        item.status === "running" || item.status === "pending" || item.status === "waiting";
      if (pending) child.blockers.add(key);
      else child.blockers.delete(key);
      if (child.seen.get(key) !== item.status) {
        child.seen.set(key, item.status);
        progress(`${item.type}_${pending ? "started" : "finished"}`);
      }
    }
  });

  const check = Effect.fn("DelegatedTaskProgressGuard.check")(
    function* () {
      const now = yield* DateTime.now;
      yield* Effect.forEach(
        [...children],
        ([threadId, child]) =>
          Effect.gen(function* () {
            if (child.checking || children.get(threadId) !== child) return;
            child.checking = true;
            yield* Effect.gen(function* () {
              if (
                child.inactiveSince !== null &&
                DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.inactiveSince) >=
                  child.idleTimeoutMs
              ) {
                children.delete(threadId);
                limits.delete(threadId);
                return;
              }
              if (
                !child.stopping &&
                child.run.status === "running" &&
                child.blockers.size === 0 &&
                threads.getDelegatedRetryCheck !== undefined
              ) {
                // Resolve once per attempt; the adapter fences by run and attempt without a projection read per tick.
                if (child.retryCheck === undefined) {
                  const run = child.run;
                  const sessionId = child.retrySessionId;
                  const retryCheck = yield* threads.getDelegatedRetryCheck({
                    threadId,
                    runId: run.id,
                    attemptId: run.activeAttemptId,
                    noResponseBudgetMs: CLAUDE_NO_RESPONSE_BUDGET_MS,
                    flapLimit: CLAUDE_RETRY_FLAP_LIMIT,
                  });
                  if (
                    children.get(threadId) !== child ||
                    child.run.id !== run.id ||
                    child.run.activeAttemptId !== run.activeAttemptId ||
                    child.retrySessionId !== sessionId ||
                    child.run.status !== "running" ||
                    child.stopping ||
                    child.blockers.size > 0
                  )
                    return;
                  child.retryCheck = retryCheck;
                }
                const checkedRun = child.run;
                if (child.retryCheck !== undefined && (yield* child.retryCheck)) {
                  // Keep the old attempt fenced while its terminal event reaches the guard.
                  if (
                    children.get(threadId) === child &&
                    child.run.id === checkedRun.id &&
                    child.run.activeAttemptId === checkedRun.activeAttemptId
                  )
                    child.stopping = true;
                  return;
                }
              }
              if (
                child.stopping ||
                child.run.status !== "running" ||
                child.blockers.size > 0 ||
                DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.lastProgressAt) <
                  child.idleTimeoutMs
              )
                return;
              const snapshot = yield* engine.getThreadRecords(
                threadId,
                ["runs", "turnItems", "runtimeRequests", "messages", "providerThreads"],
                {
                  turnItemRunId: child.run.id,
                  messageRunIds: [child.run.id],
                  messageRoles: ["assistant"],
                },
              );
              const run = snapshot.runs.find((run) => run.id === child.run.id);
              if (
                run?.status !== "running" ||
                progressBlockers(snapshot, run.id) ||
                DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.lastProgressAt) <
                  child.idleTimeoutMs
              )
                return;
              const observed = latestQualifyingProgress(snapshot, run.id);
              if (observed > DateTime.toEpochMillis(child.lastProgressAt)) {
                child.lastProgressAt = DateTime.makeUnsafe(observed);
                child.lastProgressKind = "projection_progress";
                child.thinkingSince = null;
                return;
              }
              const phase = stallPhase(
                child.lastProgressKind,
                child.thinkingSince !== null ||
                  snapshot.turnItems.some(
                    (item) =>
                      item.runId === run.id &&
                      item.type === "reasoning" &&
                      DateTime.toEpochMillis(item.updatedAt) >=
                        DateTime.toEpochMillis(child.lastProgressAt),
                  ),
              );
              const lastTool = snapshot.turnItems
                .filter(
                  (item) =>
                    item.runId === run.id &&
                    isProgressActivity(item) &&
                    item.status !== "running" &&
                    item.status !== "pending" &&
                    item.status !== "waiting",
                )
                .toSorted(
                  (a, b) =>
                    DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
                    b.ordinal - a.ordinal,
                )[0];
              const tool =
                lastTool?.type === "dynamic_tool"
                  ? (lastTool.toolName ?? "dynamic_tool")
                  : lastTool?.type;
              const stall = {
                idleTimeoutMs: child.idleTimeoutMs,
                lastProgressAt: child.lastProgressAt,
                lastProgressKind: child.lastProgressKind,
                phase,
                ...(tool === undefined ? {} : { lastProgressTool: tool }),
                silentSeconds:
                  (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.lastProgressAt)) /
                  1000,
              };
              const record = Effect.fn("DelegatedTaskProgressGuard.recordStall")(function* (
                action: "resumed" | "restarted" | "failed",
              ) {
                yield* Effect.logWarning("delegated child stalled", {
                  threadId,
                  runId: run.id,
                  ...stall,
                  action,
                });
                if (Option.isNone(analytics)) return;
                const effort = run.modelSelection?.options?.find((o) =>
                  ["reasoningEffort", "effort", "variant"].includes(o.id),
                )?.value;
                yield* analytics.value.record({
                  ts: DateTime.formatIso(now),
                  kind: "delegated_task.stall",
                  surface: "server",
                  route: "provider",
                  threadId,
                  ...(run.delegatedTaskId === undefined ? {} : { taskId: run.delegatedTaskId }),
                  props: {
                    runId: run.id,
                    provider: run.providerInstanceId,
                    ...(run.modelSelection === undefined
                      ? {}
                      : { model: run.modelSelection.model }),
                    ...(typeof effort === "string" ? { effort } : {}),
                    phase,
                    action,
                    lastProgressKind: stall.lastProgressKind,
                    ...(tool === undefined
                      ? {}
                      : {
                          lastProgressTool: tool
                            .replace(/[^a-zA-Z0-9_.:/#@%+-]/g, "_")
                            .slice(0, 160),
                        }),
                    silentSeconds: stall.silentSeconds,
                    reasonClass:
                      phase === "mid_turn"
                        ? "mid_turn"
                        : run.delegatedTaskStallRecovery === undefined &&
                            run.transientRecovery === undefined
                          ? "silent_model"
                          : "recovery_exhausted",
                  },
                });
              });
              const recovery =
                phase === "mid_turn"
                  ? undefined
                  : {
                      phase,
                      lastProgressAt: DateTime.formatIso(child.lastProgressAt),
                      attemptId: run.activeAttemptId,
                    };
              if (
                recovery !== undefined &&
                snapshot.providerThreads.some(
                  (p) => p.id === run.providerThreadId && supportsSilentRecovery(p.driver),
                ) &&
                silentRecoveryStillSafe(snapshot, run, recovery)
              ) {
                const original =
                  recovery.phase === "first_event"
                    ? yield* engine.getThreadRecords(threadId, ["messages"], {
                        messageIds: [run.userMessageId],
                      })
                    : undefined;
                const prompt = original?.messages.find(
                  (message) => message.id === run.userMessageId,
                );
                if (recovery.phase === "post_tool" || prompt !== undefined) {
                  child.stopping = true;
                  const resumed = yield* threads
                    .sendToThread({
                      threadId,
                      projectId: snapshot.thread.projectId,
                      commandId: CommandId.make(`server:delegated-stall-recovery:${run.id}`),
                      messageId: MessageId.make(`server:delegated-stall-recovery:${run.id}`),
                      mode: "restart",
                      createdBy: "system",
                      creationSource: "server",
                      modelSelection: run.modelSelection,
                      text:
                        recovery.phase === "post_tool"
                          ? "Your last model request got no reply. Write your final report now from what you have."
                          : prompt!.text,
                      attachments: prompt?.attachments ?? [],
                      ...(prompt?.context === undefined ? {} : { context: prompt.context }),
                      delegatedTaskStallRecovery: recovery,
                    })
                    .pipe(Effect.result);
                  if (resumed._tag === "Success") {
                    child.run = resumed.success.run;
                    child.lastProgressAt = now;
                    child.lastProgressKind = "run_started";
                    child.thinkingSince = null;
                    child.stopping = false;
                    yield* record(recovery.phase === "post_tool" ? "resumed" : "restarted");
                    return;
                  }
                  // The interrupt also rechecks progress and the attempt before committing.
                  child.stopping = false;
                  yield* Effect.logWarning("delegated child recovery rejected", {
                    threadId,
                    cause: resumed.failure,
                  });
                }
              }
              child.stopping = true;
              const result = yield* threads
                .interruptThread({
                  threadId,
                  projectId: snapshot.thread.projectId,
                  runId: run.id,
                  ...(run.activeAttemptId === null ? {} : { attemptId: run.activeAttemptId }),
                  commandId: CommandId.make(
                    `server:delegated-stall:${run.id}:${DateTime.toEpochMillis(child.lastProgressAt)}`,
                  ),
                  delegatedTaskStall: stall,
                  reason: stalledSummary(stall, null),
                })
                .pipe(
                  Effect.catchCause((cause) => {
                    child.stopping = false;
                    return Effect.logWarning("delegated task stall interrupt failed", {
                      threadId,
                      cause,
                    }).pipe(Effect.as(undefined));
                  }),
                );
              if (
                result?.type === "interrupt_requested" &&
                !result.dispatch.storedEvents.some(
                  (stored) =>
                    stored.event.type === "run.updated" &&
                    stored.event.payload.delegatedTaskStall !== undefined,
                )
              )
                child.stopping = false;
              else if (result?.type === "interrupt_requested") yield* record("failed");
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("delegated task child check failed", { threadId, cause }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  child.checking = false;
                }),
              ),
            );
          }),
        { concurrency: "unbounded", discard: true },
      );
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task progress check failed", { cause }),
        ),
      ),
  );

  const start = Effect.fn("DelegatedTaskProgressGuard.start")(function* () {
    yield* forkParked(Stream.runForEach(engine.streamDomainEvents, handle));
    yield* forkParked(
      Effect.gen(function* () {
        const snapshot = yield* engine.getShellSnapshot();
        for (const shell of snapshot.threads) {
          if (shell.lineage.relationshipToParent !== "subagent" || shell.activeRunId === null)
            continue;
          const records = yield* engine.getThreadRecords(shell.id, ["runs"]);
          const run = records.runs.find((run) => run.id === shell.activeRunId);
          if (run === undefined || children.has(shell.id)) continue;
          const parentId = shell.lineage.parentThreadId;
          if (parentId !== null) {
            const parent = yield* engine.getThreadRecords(parentId, ["subagents"]);
            const task = parent.subagents.find(
              (task) =>
                task.origin === "app_owned" &&
                task.childThreadId === shell.id &&
                (run.delegatedTaskId === undefined || task.id === run.delegatedTaskId),
            );
            if (task === undefined) continue;
            limits.set(shell.id, normalizeIdleTimeout(task?.idleTimeoutMs));
          }
          children.set(shell.id, {
            run,
            idleTimeoutMs: limits.get(shell.id) ?? normalizeIdleTimeout(),
            lastProgressAt: boot,
            lastProgressKind: "server_restarted",
            thinkingSince: null,
            inactiveSince: null,
            stopping: false,
            checking: false,
            blockers: new Set(),
            seen: new Map(),
          });
        }
        // A cutoff waits for CLI settlement. Keep scanning siblings while that child is fenced.
        return yield* Effect.forever(
          Effect.sleep("1 second").pipe(Effect.andThen(() => Effect.forkScoped(check()))),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task progress guard failed", { cause }),
        ),
      ),
    );
  });
  const status = (threadId: ThreadId) => {
    const child = children.get(threadId);
    return {
      lastProgressAt: child === undefined ? null : DateTime.formatIso(child.lastProgressAt),
      lastProgressKind: child?.lastProgressKind ?? null,
      thinkingSince: child?.thinkingSince == null ? null : DateTime.formatIso(child.thinkingSince),
    };
  };
  return DelegatedTaskProgressGuard.of({ start, handle, check, status });
});
export const layer = Layer.effect(DelegatedTaskProgressGuard, make);
