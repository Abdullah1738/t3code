import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
export function parentTaskCancellationRequest(
  runId: OrchestrationV2Run["id"] | undefined,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  return items
    .filter((item) => item.type === "run_interrupt_request")
    .findLast((item) => item.runId === runId);
}

export function restartInterrupted(task: {
  readonly status: string;
  readonly cancelReason?: string | undefined;
}): boolean {
  return (
    (task.status === "cancelled" || task.status === "interrupted") &&
    (task.cancelReason === "server_shutdown" || task.cancelReason === "server_restart")
  );
}

export function normalizeIdleTimeout(value?: number): number {
  return value === undefined || value === 0 || !Number.isFinite(value)
    ? DEFAULT_IDLE_TIMEOUT_MS
    : Math.min(2 * 60 * 60_000, Math.max(60_000, value));
}

export function stalledSummary(
  stall: NonNullable<OrchestrationV2Run["delegatedTaskStall"]>,
  partial: string | null,
): string {
  const phase = stall.phase ?? stallPhase(stall.lastProgressKind, false);
  const after =
    phase === "first_event"
      ? "run start"
      : phase === "post_tool"
        ? `tool ${stall.lastProgressTool ?? stall.lastProgressKind}`
        : stall.lastProgressKind === "command_execution_timeout"
          ? "foreground command exceeding its tool timeout plus 60 s grace"
          : stall.lastProgressKind;
  const exit =
    stall.lastProgressExitCode === undefined ? "" : ` (exit ${stall.lastProgressExitCode})`;
  return `stalled: no model output for ${Math.floor((stall.silentSeconds ?? stall.idleTimeoutMs / 1000) / 60)} min after ${after}${exit} at ${DateTime.formatIso(stall.lastProgressAt)}; no final report${partial ? `\n\nPartial assistant result:\n${partial}` : ""}`;
}

const toolFinishedKinds = new Set([
  "command_execution_finished",
  "dynamic_tool_finished",
  "file_change_finished",
  "file_search_finished",
  "web_search_finished",
]);

export function stallPhase(
  kind: string,
  reasoning: boolean,
): "post_tool" | "first_event" | "mid_turn" {
  return reasoning
    ? "mid_turn"
    : kind === "run_started"
      ? "first_event"
      : toolFinishedKinds.has(kind)
        ? "post_tool"
        : "mid_turn";
}

export function silentRecoveryStillSafe(
  projection: ProgressProjection,
  run: OrchestrationV2Run,
  recovery: NonNullable<OrchestrationV2Run["delegatedTaskStallRecovery"]>,
): boolean {
  const at = DateTime.toEpochMillis(DateTime.makeUnsafe(recovery.lastProgressAt));
  if (
    run.delegatedTaskStallRecovery !== undefined ||
    run.transientRecovery !== undefined ||
    run.activeAttemptId !== recovery.attemptId ||
    progressBlockers(projection, run.id) ||
    latestQualifyingProgress(projection, run.id) > at
  )
    return false;
  const items = projection.turnItems.filter((item) => item.runId === run.id);
  if (
    items.some((item) => item.type === "reasoning" && DateTime.toEpochMillis(item.updatedAt) >= at)
  )
    return false;
  return (
    recovery.phase !== "first_event" ||
    !(
      items.some((item) => isProgressActivity(item) || item.type === "assistant_message") ||
      projection.messages.some(
        (message) =>
          message.runId === run.id && message.role === "assistant" && message.text.length > 0,
      )
    )
  );
}

export function supportsSilentRecovery(driver: string | undefined): boolean {
  // Claude's retry-health path owns native evidence, query fencing and network recovery.
  return driver === "codex";
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

export function commandProgressDeadline(
  item: OrchestrationV2TurnItem,
  lastOutputAt = -Infinity,
): number {
  if (item.type !== "command_execution" || item.timeoutMs === 0) return Infinity;
  // Older Claude projections predate timeout metadata. Bash cannot run in the
  // foreground for more than ten minutes, even when its requested limit is lost.
  const timeout =
    item.timeoutMs ?? (item.nativeItemRef?.driver === "claudeAgent" ? 600_000 : undefined);
  if (timeout === undefined || item.startedAt === null) return Infinity;
  return (
    Math.max(
      DateTime.toEpochMillis(item.startedAt) + timeout,
      DateTime.toEpochMillis(item.updatedAt),
      lastOutputAt,
    ) + 60_000
  );
}

export function progressBlockers(
  projection: ProgressProjection,
  runId: OrchestrationV2Run["id"],
  now = -Infinity,
  outputActivity?: ReadonlyMap<TurnItemId, number>,
): boolean {
  return (
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.turnItems.some(
      (item) =>
        item.runId === runId &&
        active(item.status) &&
        isProgressActivity(item) &&
        commandProgressDeadline(item, outputActivity?.get(item.id)) > now,
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
