import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

export const seededUnconfirmed = (
  providerThread: OrchestrationV2ProviderThread,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): boolean =>
  providerThread.nativeMetadata?.seededHistory !== undefined &&
  !providerTurns.some(
    (turn) =>
      turn.providerThreadId === providerThread.id &&
      turn.status === "completed" &&
      (providerThread.nativeMetadata?.seededHistory?.mode !== "codex-inject" ||
        turn.nativeTurnRef?.nativeId != null),
  );

export const isClaudeSeeded = (providerThread: OrchestrationV2ProviderThread): boolean =>
  providerThread.nativeMetadata?.seededHistory?.mode === "claude-transcript";
