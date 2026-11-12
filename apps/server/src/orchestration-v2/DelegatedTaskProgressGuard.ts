import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  normalizeIdleTimeout,
  isProgressActivity,
  progressBlockers,
  latestQualifyingProgress,
  stalledSummary,
} from "./delegatedTaskProgress.ts";

type Progress = {
  lastProgressAt: DateTime.Utc;
  lastProgressKind: string;
  thinkingSince: DateTime.Utc | null;
};
type Child = Progress & {
  run: OrchestrationV2Run;
  idleTimeoutMs: number;
  inactiveSince: DateTime.Utc | null;
  stopping: boolean;
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
          blockers: new Set(),
          seen: new Map(),
        };
        children.set(event.threadId, child);
      }
      if (run.status === "running" && child.lastProgressKind === "not_started") {
        child.lastProgressAt = event.occurredAt;
        child.lastProgressKind = "run_started";
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
      for (const [threadId, child] of children) {
        if (
          child.inactiveSince !== null &&
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.inactiveSince) >=
            child.idleTimeoutMs
        ) {
          children.delete(threadId);
          limits.delete(threadId);
          continue;
        }
        if (
          child.stopping ||
          child.run.status !== "running" ||
          child.blockers.size > 0 ||
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(child.lastProgressAt) <
            child.idleTimeoutMs
        )
          continue;
        const snapshot = yield* engine.getThreadRecords(
          threadId,
          ["runs", "turnItems", "runtimeRequests", "messages"],
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
          continue;
        const observed = latestQualifyingProgress(snapshot, run.id);
        if (observed > DateTime.toEpochMillis(child.lastProgressAt)) {
          child.lastProgressAt = DateTime.makeUnsafe(observed);
          child.lastProgressKind = "projection_progress";
          child.thinkingSince = null;
          continue;
        }
        const stall = {
          idleTimeoutMs: child.idleTimeoutMs,
          lastProgressAt: child.lastProgressAt,
          lastProgressKind: child.lastProgressKind,
        };
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
      }
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
            blockers: new Set(),
            seen: new Map(),
          });
        }
        return yield* Effect.forever(Effect.sleep("1 second").pipe(Effect.andThen(check)));
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
