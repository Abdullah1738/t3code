import {
  CommandId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { describeWork, runningBackgroundWork } from "../context-reset/backgroundWork.ts";

export const ThreadNotIdleReason = Schema.Literals([
  "archived",
  "running",
  "queued",
  "pending-request",
  "background-work",
  "pending-wake",
  "session-changed",
  "changed",
]);
export type ThreadNotIdleReason = typeof ThreadNotIdleReason.Type;

export class OrchestratorThreadNotIdleError extends Schema.TaggedError<OrchestratorThreadNotIdleError>()(
  "OrchestratorThreadNotIdleError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    reason: ThreadNotIdleReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Runs after archive-if-idle is planned and before its commit. Tests use it to
 * land work in that gap; it does nothing otherwise.
 */
export const ArchiveIfIdleBeforeCommit = Context.Reference<Effect.Effect<void>>(
  "t3/ardud/ArchiveIfIdleBeforeCommit",
  { defaultValue: () => Effect.void },
);

export interface IdleBlocker {
  readonly reason: ThreadNotIdleReason;
  readonly detail: string;
}

export interface IdleInput {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    | "thread"
    | "runs"
    | "attempts"
    | "runtimeRequests"
    | "subagents"
    | "providerThreads"
    | "providerTurns"
  >;
  /** A run whose restart continuation is still owed, so the thread wakes on its own. */
  readonly restartContinuationPending: boolean;
  /** A provider asked for a continuation turn that has not been handled yet. */
  readonly continuationOffered: boolean;
  /**
   * Provider threads whose live session still holds background work or a
   * buffered wake. Those live only in the provider's memory, not in events.
   */
  readonly providerThreadsHoldingWork: ReadonlyArray<string>;
  readonly expectedNativeSessionId: string | undefined;
  readonly now: DateTime.Utc;
}

const LIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** Why the thread is not idle enough to archive, or null when it is. */
export const idleBlocker = (input: IdleInput): IdleBlocker | null => {
  const { thread, runs, runtimeRequests } = input.projection;
  if (thread.archivedAt !== null) {
    return { reason: "archived", detail: `Thread ${thread.id} is already archived.` };
  }
  const live = runs.find((run) => LIVE_RUN_STATUSES.has(run.status));
  if (live !== undefined) {
    return { reason: "running", detail: `Thread ${thread.id} has run ${live.id} ${live.status}.` };
  }
  const queued = runs.filter((run) => run.status === "queued");
  if (queued.length > 0) {
    return {
      reason: "queued",
      detail: `Thread ${thread.id} has ${queued.length} queued run${queued.length === 1 ? "" : "s"}.`,
    };
  }
  const pending = runtimeRequests.find((request) => request.status === "pending");
  if (pending !== undefined) {
    return {
      reason: "pending-request",
      detail: `Thread ${thread.id} is waiting on ${pending.kind} request ${pending.id}.`,
    };
  }
  const background = runningBackgroundWork(input.projection);
  if (background.length > 0) {
    return {
      reason: "background-work",
      detail: `Thread ${thread.id} still runs ${background.map(describeWork).join("; ")}.`,
    };
  }
  // A native subagent's child thread runs provider turns that belong to no
  // app run, so its run list stays empty while it works.
  const runlessTurn = input.projection.providerTurns.find(
    (turn) => turn.runAttemptId === null && LIVE_TURN_STATUSES.has(turn.status),
  );
  if (runlessTurn !== undefined) {
    return {
      reason: "background-work",
      detail: `Thread ${thread.id} has provider turn ${runlessTurn.id} ${runlessTurn.status}.`,
    };
  }
  const holding = input.providerThreadsHoldingWork[0];
  if (holding !== undefined) {
    return {
      reason: "background-work",
      detail: `Thread ${thread.id} has background work or a wake held by provider thread ${holding}.`,
    };
  }
  const delivery = owedDelegatedCompletion(input.projection);
  if (delivery !== null) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} still owes run ${delivery} a delegated task report.`,
    };
  }
  if (input.restartContinuationPending) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} still owes a continuation after a restart.`,
    };
  }
  if (input.continuationOffered) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} has a provider continuation waiting to start.`,
    };
  }
  if (thread.limitRecovery?.autoResume === true) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} resumes on its own when its usage limit resets.`,
    };
  }
  // A watched pull request wakes the thread on checks, comments or conflicts.
  const watched = visibleThreadPullRequests(thread.pullRequests ?? []).find(
    (link) => link.watch !== undefined,
  );
  if (watched !== undefined) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} watches ${watched.repository}#${watched.number}.`,
    };
  }
  const snoozedUntil = thread.snoozedUntil ?? null;
  if (snoozedUntil !== null && DateTime.isGreaterThan(snoozedUntil, input.now)) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} is snoozed until ${DateTime.formatIso(snoozedUntil)}.`,
    };
  }
  if (input.expectedNativeSessionId !== undefined) {
    const changed = sessionChange(input.projection, input.expectedNativeSessionId);
    if (changed !== null) {
      return { reason: "session-changed", detail: `Thread ${thread.id} ${changed}.` };
    }
  }
  return null;
};

const LIVE_TURN_STATUSES = new Set(["pending", "running"]);
const OWED_TASK_DELIVERIES = new Set(["pending", "claimed"]);

/** The run still owed a delegated task report, which wakes the thread when sent. */
const owedDelegatedCompletion = (projection: IdleInput["projection"]): string | null => {
  const open = projection.runs.filter((run) => run.delegatedCompletion?.disposition === "open");
  const reserved = open.find((run) => (run.delegatedCompletion?.delivery?.taskIds.length ?? 0) > 0);
  if (reserved !== undefined) return reserved.id;
  const openIds = new Set<string>(open.map((run) => run.id));
  const task = projection.subagents.find(
    (subagent) =>
      subagent.runId !== null &&
      openIds.has(subagent.runId) &&
      subagent.completionDelivery !== undefined &&
      OWED_TASK_DELIVERIES.has(subagent.completionDelivery.state),
  );
  return task?.runId ?? null;
};

/**
 * The active provider thread pointer also moves when an older provider thread
 * is rewritten (startup recovery, a queued provider switch), so the session
 * only counts when the latest run actually ran on it.
 */
const sessionChange = (projection: IdleInput["projection"], expected: string): string | null => {
  const activeId = projection.thread.activeProviderThreadId;
  const active = projection.providerThreads.find((candidate) => candidate.id === activeId);
  const native = active?.nativeThreadRef?.nativeId ?? null;
  if (native === null) return `has no active native session, not ${expected}`;
  if (native !== expected) return `is on native session ${native}, not ${expected}`;
  const latest = latestExecutedRun(projection.runs);
  if (latest === null) {
    return projection.providerThreads.length === 1
      ? null
      : `has ${projection.providerThreads.length} provider threads and no run to tell which is current`;
  }
  const attempt = projection.attempts.find((candidate) => candidate.id === latest.activeAttemptId);
  if (attempt === undefined || attempt.startedAt === null) {
    return `has no started attempt on run ${latest.id}`;
  }
  if (
    attempt.nativeThreadId !== expected ||
    latest.providerThreadId !== activeId ||
    attempt.providerThreadId !== activeId
  ) {
    return `last ran run ${latest.id} on another session than ${expected}`;
  }
  return null;
};
