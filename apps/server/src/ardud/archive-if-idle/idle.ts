import {
  CommandId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

export interface IdleBlocker {
  readonly reason: ThreadNotIdleReason;
  readonly detail: string;
}

export interface IdleInput {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "subagents" | "providerThreads"
  >;
  /** A run whose restart continuation is still owed, so the thread wakes on its own. */
  readonly restartContinuationPending: boolean;
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
  if (input.restartContinuationPending) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} still owes a continuation after a restart.`,
    };
  }
  if (thread.limitRecovery?.autoResume === true) {
    return {
      reason: "pending-wake",
      detail: `Thread ${thread.id} resumes on its own when its usage limit resets.`,
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
    const active = input.projection.providerThreads.find(
      (providerThread) => providerThread.id === thread.activeProviderThreadId,
    );
    const native = active?.nativeThreadRef?.nativeId ?? null;
    if (native !== input.expectedNativeSessionId) {
      return {
        reason: "session-changed",
        detail:
          native === null
            ? `Thread ${thread.id} has no active native session, not ${input.expectedNativeSessionId}.`
            : `Thread ${thread.id} is on native session ${native}, not ${input.expectedNativeSessionId}.`,
      };
    }
  }
  return null;
};
