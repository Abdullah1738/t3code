import type {
  NodeId,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

export const CONTEXT_RESET_TITLE = "Context reset";

/**
 * The chat divider for a run that started a fresh provider thread. It reuses the
 * `compaction` item so every client already renders it as a timeline divider.
 */
export const contextResetTurnItem = (input: {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly run: Pick<OrchestrationV2Run, "id" | "ordinal">;
  readonly nodeId: NodeId | null;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id" | "driver">;
  readonly now: DateTime.Utc;
}): OrchestrationV2TurnItem => ({
  id: input.id,
  threadId: input.threadId,
  runId: input.run.id,
  nodeId: input.nodeId,
  providerThreadId: input.providerThread.id,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: input.run.ordinal * 100 - 2,
  status: "completed",
  title: CONTEXT_RESET_TITLE,
  startedAt: input.now,
  completedAt: input.now,
  updatedAt: input.now,
  type: "compaction",
  driver: input.providerThread.driver,
  summary: "Fresh session started from the agent's resume note.",
});
