// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synchronous process-local diagnostics, callable outside Effect.
import { randomUUID } from "node:crypto";

export interface ContinuationDecision {
  readonly threadId: string;
  readonly continued: boolean;
  readonly reason?: string;
  readonly dispatched?: boolean;
  readonly reconciledAt?: string;
  readonly queuedAt?: string;
}

export const bootId = randomUUID();
const report = {
  bootId,
  completedAt: null as string | null,
  listeningAt: null as string | null,
  commandReadyAt: null as string | null,
  firstResumedProviderRequestAt: null as string | null,
  threads: [] as ContinuationDecision[],
};
export function recordContinuationDecision(decision: ContinuationDecision) {
  report.threads.push({
    ...decision,
    reconciledAt: new Date().toISOString(),
    ...(decision.continued ? { queuedAt: new Date().toISOString() } : {}),
  });
}
export function finishContinuationReport() {
  report.completedAt = new Date().toISOString();
}
export function continuationReport() {
  return {
    ...report,
    continued: report.threads.filter((thread) => thread.continued).length,
    skipped: report.threads.filter((thread) => !thread.continued).length,
    pending: report.threads.filter((thread) => thread.continued && !thread.dispatched).length,
  };
}

export function markInstallLifecycle(
  phase: "listeningAt" | "commandReadyAt" | "firstResumedProviderRequestAt",
) {
  report[phase] ??= new Date().toISOString();
}

export function markContinuationDispatched(threadId: string) {
  const index = report.threads.findIndex((thread) => thread.threadId === threadId);
  if (index >= 0)
    report.threads[index] = {
      ...report.threads[index],
      threadId,
      continued: true,
      dispatched: true,
    };
}

export function markContinuationFinished(threadId: string) {
  const index = report.threads.findIndex((thread) => thread.threadId === threadId);
  const thread = report.threads[index];
  if (thread?.continued && !thread.dispatched) {
    report.threads[index] = {
      ...thread,
      threadId,
      continued: false,
      reason: "continuation_declined",
    };
  }
}

export function markContinuationDeclined(threadId: string, reason: string) {
  const index = report.threads.findIndex((thread) => thread.threadId === threadId);
  // An independent queue wake may wait behind the continuation already sent.
  if (index >= 0 && !report.threads[index]!.dispatched)
    report.threads[index] = {
      ...report.threads[index]!,
      continued: false,
      dispatched: false,
      reason,
    };
}

const recoveredQueueRunIds = new Set<string>();
export function markQueuedRunRecovered(runId: string) {
  recoveredQueueRunIds.add(runId);
}
export function isRecoveredQueueRun(runId: string) {
  return recoveredQueueRunIds.has(runId);
}
