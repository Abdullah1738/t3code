import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * A saved message identity prevents duplicate timeline items, but preparation can
 * run before provider deduplication. Lost acknowledgement must be reconciled first.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  if (message.deliveryFailure?.code?.startsWith("provider_prompt_acceptance_") === true)
    return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}
