import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
export function normalizeIdleTimeout(value?: number): number {
  return value === undefined || value === 0 || !Number.isFinite(value)
    ? DEFAULT_IDLE_TIMEOUT_MS
    : Math.min(2 * 60 * 60_000, Math.max(60_000, value));
}

export function stalledSummary(
  stall: NonNullable<OrchestrationV2Run["delegatedTaskStall"]>,
  partial: string | null,
): string {
  return `Stalled: no tool call or text for ${stall.idleTimeoutMs / 60_000} min (last progress ${DateTime.formatIso(stall.lastProgressAt)}: ${stall.lastProgressKind}); interrupted by Robob.${partial ? `\n\nPartial assistant result:\n${partial}` : ""}`;
}

type ProgressProjection = Pick<
  OrchestrationV2ThreadProjection,
  "turnItems" | "runtimeRequests" | "messages"
>;
const active = (status: string) =>
  status === "pending" || status === "running" || status === "waiting";
const activityTypes = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "compaction",
]);
export const isProgressActivity = (item: OrchestrationV2TurnItem): boolean =>
  activityTypes.has(item.type) || (item.type === "subagent" && item.origin === "provider_native");

export function progressBlockers(
  projection: ProgressProjection,
  runId: OrchestrationV2Run["id"],
): boolean {
  return (
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.turnItems.some(
      (item) => item.runId === runId && active(item.status) && isProgressActivity(item),
    )
  );
}

export function latestQualifyingProgress(
  projection: ProgressProjection,
  runId: OrchestrationV2Run["id"],
): number {
  return Math.max(
    0,
    ...projection.runtimeRequests.map((request) =>
      Math.max(
        DateTime.toEpochMillis(request.createdAt),
        request.resolvedAt === null ? 0 : DateTime.toEpochMillis(request.resolvedAt),
      ),
    ),
    ...projection.messages
      .filter(
        (message) =>
          message.runId === runId && message.role === "assistant" && message.text.length > 0,
      )
      .map((message) => DateTime.toEpochMillis(message.updatedAt)),
    ...projection.turnItems
      .filter(
        (item) =>
          item.runId === runId &&
          (isProgressActivity(item) || (item.type === "assistant_message" && item.text.length > 0)),
      )
      .map((item) => DateTime.toEpochMillis(item.updatedAt)),
  );
}
