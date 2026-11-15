import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as McpDeadline from "./McpDeadline.ts";
import * as McpTaskTrace from "../ardud/observability/McpTaskTrace.ts";
import { delegationTaskIdentity, delegationIdShape } from "./delegationTaskIdentity.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readCallerIdentity } from "./callerIdentity.ts";
import * as McpCallAnalytics from "../ardud/analytics/McpCall.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import type { CallerRow } from "../orchestration-v2/ProjectionStore.ts";
import { claudeRecoveryResult } from "../orchestration-v2/launchRecovery.ts";
import { stalledSummary } from "../orchestration-v2/delegatedTaskProgress.ts";
import {
  type AnalyticsEvent,
  CommandId,
  type RunAttemptId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskStatusResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { latestRootProviderFailure, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import {
  effortOptionId,
  mergeSelection,
  resolveSelection,
} from "@t3tools/client-runtime/ardud/models/harnessRouting";
import * as DelegatedTaskProgressGuard from "../orchestration-v2/DelegatedTaskProgressGuard.ts";
import * as Clock from "effect/Clock";
import * as SendAcknowledgement from "../ardud/orchestration/ThreadSendAcknowledgement.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  ProjectionRecordField,
  ThreadListCandidate,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  subagentResultForRun,
  delegatedTaskProgress,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
// ardud: who is redeeming a secretRef
import { SecretRedeemer } from "../ardud/auth/heldSecrets.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientRuntimeModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ProviderStartProgress from "../ardud/orchestration/ProviderStartProgress.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
// Bun's HTTP client closes a silent request after five minutes. Leave room for
// the final projection read and response before that transport deadline.
const MAX_WAIT_TIMEOUT_MS = 4 * 60 * 1_000 + 30 * 1_000;
const remainingWaitMs = (startNanos: bigint, timeoutMs: number | undefined) =>
  Clock.monotonicTimeNanos.pipe(
    Effect.map((now) =>
      Math.max(
        0,
        Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)) -
          Number(now - startNanos) / 1_000_000,
      ),
    ),
  );
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly selectionRouting?: NonNullable<OrchestratorMcpDelegateTaskResult["selectionRouting"]>;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpTaskStatusResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

type CallerParent = { readonly thread: CallerRow };

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);
const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

function failure(
  code: OrchestratorMcpFailure["code"],
  message: string,
  reason?: OrchestratorMcpFailure["reason"],
): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({
    reason:
      reason ??
      (code === "invalid_request"
        ? "invalid_args"
        : code === "runtime_mode_escalation_denied"
          ? "runtime_mode_escalation"
          : code === "interaction_mode_escalation_denied"
            ? "interaction_mode_escalation"
            : code === "capability_denied"
              ? "capability_missing"
              : undefined),
    code,
    message,
  });
}

/**
 * A caller's thread is live while it is not archived, runs on the caller's
 * provider instance, and has an active run or a background subagent that
 * instance started. A background subagent outlives its run and calls tools
 * with its thread's credential, which is revoked when the provider process
 * goes away.
 */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (isOrchestratorMcpFailure(error)) return error;
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

function errorMessage(error: unknown): string {
  return (
    userFacingDispatchErrorMessage(error) ??
    (error instanceof Error ? error.message : String(error))
  );
}

function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    lastRunError: task.lastRunError,
    missedRuns: task.missedRuns,
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  // Driver availability comes from the registry, even when health probes are skipped.
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

function supportedInheritedOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (descriptors === undefined) return options;
  return options?.filter((option) => {
    // Legacy variants are canonicalized and checked by the selection resolver.
    if (option.id === "variant") return true;
    if (option.id === "fastMode" && option.value === false) return true;
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    return (
      descriptor !== undefined &&
      (descriptor.type !== "select" ||
        descriptor.options.some((choice) => choice.id === option.value))
    );
  });
}

/**
 * Models without descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always fail: downstream
 * consumers disagree on whether the first or last value of a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    // Legacy selections retain this enforced marker after fast mode leaves the catalog.
    if (selection.id === "fastMode" && selection.value === false) continue;
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

export function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

export function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    result.hasPendingQuestion ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems" | "providerTurns"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: Pick<ResolvedTarget, "modelSelection" | "supportedRuntimeModes">,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      failure(
        "runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      ),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      failure(
        "invalid_request",
        `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      ),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function requestIdentity(scope: McpInvocationScope): string {
  // Credentials change across catalog refreshes and restarts; the caller thread does not.
  return scope.thread === undefined
    ? scope.requestNamespace
    : `thread:${stablePart(scope.environmentId)}:${stablePart(scope.thread.threadId)}`;
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(requestIdentity(input.scope)),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function delegationCommandId(
  scope: McpThreadInvocationScope,
  parent: Pick<OrchestrationV2ThreadProjection, "subagents">,
  key: string,
): CommandId {
  // Old receipts used the credential namespace. Recover those tasks too, so
  // rotating a credential during an upgrade does not duplicate accepted work.
  for (const task of parent.subagents) {
    if (
      task.origin !== "app_owned" ||
      task.threadId !== scope.thread.threadId ||
      !task.id.startsWith("node:delegated-task:")
    )
      continue;
    let command: string;
    try {
      command = decodeURIComponent(task.id.slice("node:delegated-task:".length));
    } catch {
      continue;
    }
    const parts = command.split(":");
    if (
      parts.length === 5 &&
      parts[0] === "command" &&
      parts[1] === "mcp" &&
      parts[3] === "delegate-task" &&
      parts[4] === stablePart(key)
    )
      return CommandId.make(command);
  }
  return CommandId.make(
    [
      "command",
      "mcp",
      "delegate-task",
      stablePart(scope.environmentId),
      stablePart(scope.thread.threadId),
      stablePart(key),
    ].join(":"),
  );
}

function findDelegatedTask(
  parent: Pick<OrchestrationV2ThreadProjection, "subagents">,
  threadId: ThreadId,
  taskId: NodeId,
) {
  const exact = parent.subagents.find(
    (task) => task.id === taskId && task.origin === "app_owned" && task.threadId === threadId,
  );
  if (exact !== undefined) return exact;
  const identity = delegationTaskIdentity(taskId);
  return identity === undefined
    ? undefined
    : parent.subagents.find(
        (task) =>
          task.origin === "app_owned" &&
          task.threadId === threadId &&
          delegationTaskIdentity(task.id)?.key === identity.key,
      );
}

function threadCreationIds(namespace: string, requestKey: string, index: number) {
  const identity = stablePart(namespace);
  const key = stablePart(requestKey);
  return {
    commandId: (operation: string) =>
      CommandId.make(`command:mcp:${identity}:${operation}:${key}:${index}`),
    threadId: ThreadId.make(`thread:mcp:${identity}:${key}:${index}`),
    messageId: MessageId.make(`message:mcp:${identity}:${key}:${index}`),
  };
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(requestIdentity(input.scope)),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

/** The same links `list_thread_pull_requests` reports, without the snapshot details. */
function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  shell: ThreadListCandidate & Pick<OrchestrationV2ThreadShell, "visibleItemCount">,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return item.prompt ?? item.requestKind;
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "html_render":
      return `Showed the page "${item.htmlRender.title}".`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const lifetime = yield* Effect.scope;
  const serviceScope = yield* Scope.fork(lifetime);
  const stopping = yield* Deferred.make<void>();
  // Wake HTTP callers before closing the service-owned preparation/observation fibers.
  yield* Scope.addFinalizer(lifetime, Deferred.succeed(stopping, undefined));
  const untilShutdown = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.raceFirst(
      effect.pipe(McpDeadline.awaitInterruptibly),
      Deferred.await(stopping).pipe(
        Effect.andThen(
          failure(
            "orchestration_error",
            "The server is shutting down. Retry after reconnecting; reuse the same clientRequestId for delegate_task.",
          ),
        ),
      ),
    );
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const startProgress = yield* Effect.serviceOption(ProviderStartProgress.ProviderStartProgress);
  const startState = (
    run: OrchestrationV2Run | null | undefined,
    turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  ) =>
    ProviderStartProgress.startState(
      run,
      turns,
      run == null || Option.isNone(startProgress)
        ? null
        : startProgress.value.get(run.id, run.activeAttemptId),
    );
  const readStartState = Effect.fnUntraced(function* (run: OrchestrationV2Run | null | undefined) {
    if (
      run == null ||
      run.activeAttemptId == null ||
      !["preparing", "starting", "running"].includes(run.status)
    )
      return startState(run, []);
    const { providerTurns } = yield* threadManagement
      .getThreadRecords(
        run.threadId,
        ["providerTurns"],
        { providerTurnAttemptId: run.activeAttemptId },
        { projectionOnly: true },
      )
      .pipe(NodeSqliteClient.foregroundReads, Effect.mapError(threadManagementFailure));
    return startState(run, providerTurns);
  });
  const progressGuard = yield* Effect.serviceOption(
    DelegatedTaskProgressGuard.DelegatedTaskProgressGuard,
  );
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  // awaitInterruptibly has its own span; keep call attributes on the named service span.
  const traceUntilShutdown = (prefix: "t3.delegate" | "t3.task") =>
    Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      const span = yield* Effect.option(Effect.currentSpan);
      return yield* untilShutdown(
        Option.isSome(span) ? effect.pipe(Effect.withParentSpan(span.value)) : effect,
      ).pipe(McpTaskTrace.withTrace(prefix));
    });

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const scheduledTaskWorkspaceStrategy = Effect.fn("scheduledTaskWorkspaceStrategy")(function* (
    workspaceRoot: string,
  ): Effect.fn.Return<ScheduledTask["workspaceStrategy"]> {
    // Only a confirmed non-repository uses root; other failures surface when the worktree launches.
    const isRepository = yield* gitDriver
      .execute({
        operation: "OrchestratorMcpService.scheduledTaskWorkspaceStrategy",
        cwd: workspaceRoot,
        args: ["rev-parse", "--git-dir"],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      })
      .pipe(
        Effect.as(true),
        Effect.catchTags({
          GitCommandError: (error) => Effect.succeed(error.reason !== "not_a_repository"),
        }),
      );
    return isRepository
      ? { type: "worktree", baseRef: "main", startFromOrigin: true }
      : { type: "root" };
  });

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    options?: { readonly projectionOnly: boolean },
  ) =>
    threadManagement
      .getThreadRecords(threadId, fields, { turnItemTypes: [], messageRoles: ["user"] }, options)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const creationNamespaces = Effect.fn("OrchestratorMcpService.creationNamespaces")(function* (
    scope: McpThreadInvocationScope,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(scope.thread.threadId, ["turnItems"], {
        turnItemTypes: ["thread_created"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const namespaces = new Set([scope.requestNamespace]);
    for (const item of records.turnItems ?? []) {
      if (item.type !== "thread_created") continue;
      const parts = item.targetThreadId.split(":");
      if (parts.length !== 5 || parts[0] !== "thread" || parts[1] !== "mcp") continue;
      // Only this parent's creation records can supply another credential's namespace.
      const decoded = yield* Effect.try(() => decodeURIComponent(parts[2]!)).pipe(Effect.option);
      if (Option.isSome(decoded)) namespaces.add(decoded.value);
    }
    return [...namespaces];
  });

  const unrecordedCreation = Effect.fn("OrchestratorMcpService.unrecordedCreation")(function* (
    scope: McpThreadInvocationScope,
    projectId: ProjectId,
    key: string,
    index: number,
  ) {
    const traces = yield* threadManagement
      .findMcpThreadCreations({ projectId, requestKey: key, index })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to check earlier create_threads receipts."),
        ),
      );
    const owned: Array<ReturnType<typeof threadCreationIds>> = [];
    let unresolved = false;
    for (const trace of traces) {
      const namespace = yield* Effect.try(() =>
        decodeURIComponent(trace.threadId.split(":")[2]!),
      ).pipe(Effect.option);
      if (Option.isNone(namespace)) {
        unresolved = true;
        continue;
      }
      // New identities already include their caller; this lookup is only for legacy namespaces.
      if (namespace.value.startsWith("thread:")) continue;
      const ids = threadCreationIds(namespace.value, key, index);
      if (ids.threadId !== trace.threadId || ids.commandId("create-thread") !== trace.commandId) {
        unresolved = true;
        continue;
      }
      const records = yield* threadManagement
        .getThreadRecords(
          trace.threadId,
          ["messages"],
          {
            messageIds: [ids.messageId],
            messageRoles: ["user"],
            turnItemTypes: [],
          },
          { projectionOnly: true },
        )
        .pipe(Effect.mapError(threadManagementFailure));
      const sender = records.messages.find(
        (message) => message.id === ids.messageId,
      )?.senderThreadId;
      if (sender === scope.thread.threadId) owned.push(ids);
      else if (sender === undefined) unresolved = true;
    }
    if (unresolved || owned.length > 1)
      return yield* failure(
        "ambiguous_replay",
        "An earlier create_threads with this clientRequestId may have created a thread; check t3_thread_list. No new work was created.",
      );
    return owned[0];
  });

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords({ projectId, threadId }, [], {
        turnItemTypes: [],
        messageRoles: ["user"],
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const loadCallerShell = Effect.fn("OrchestratorMcpService.loadCallerShell")(function* (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId | undefined,
  ) {
    const thread = yield* readCallerIdentity(threadManagement, threadId, providerInstanceId).pipe(
      Effect.mapError(threadManagementFailure),
      (effect) =>
        McpDeadline.withDeadline(effect, { code: "caller_unresolved", threadId, stage: "caller" }),
    );
    if (thread === null || thread.deletedAt !== null) {
      return yield* failure("thread_not_found", "The calling thread was not found.");
    }
    return { thread };
  });

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: {
          runtimeMode: clientRuntimeModeCeiling(scope.client),
          interactionMode: "default",
        } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
      } as const;
    }
    const parent = yield* loadCallerShell(scope.thread.threadId, scope.thread.providerInstanceId);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadCallerShell(
      threadScope.thread.threadId,
      threadScope.thread.providerInstanceId,
    );
    return { scope: threadScope, parent } as const;
  });

  const resolveProjectTarget = (
    parent: CallerParent | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a T3 thread.",
            ),
          );

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${threadId} was not found.`);
    }
    return yield* loadProjectThread(shell.projectId, threadId);
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? yield* loadProjection(threadId, [
            "runs",
            "messages",
            "subagents",
            "providerThreads",
            "providerTurns",
            "runtimeRequests",
            "contextTransfers",
            "turnItems",
          ])
        : yield* loadTargetThread(threadId);
    return { ...caller, target } as const;
  });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: CallerParent | undefined,
    target: CallerParent,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: CallerParent | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = Effect.fn("OrchestratorMcpService.assertLiveCaller")(function* (
    scope: McpInvocationScope,
    parent: CallerParent,
  ) {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const records = yield* loadProjection(parent.thread.id, ["runs"]);
    const activeRun = ThreadManagementService.latestActiveRun(records);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return yield* readCallerIdentity(
        threadManagement,
        parent.thread.id,
        scope.thread?.providerInstanceId,
      ).pipe(
        Effect.mapError(threadManagementFailure),
        (effect) =>
          McpDeadline.withDeadline(effect, {
            code: "caller_unresolved",
            threadId: parent.thread.id,
            stage: "caller",
          }),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    if (
      parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
    ) {
      return yield* notActive;
    }
  });

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* ThreadReadMetrics.read("caller", loadCaller(scope));
    const shell = yield* ThreadReadMetrics.read(
      "shell",
      threadManagement.getThreadShell(threadId).pipe(Effect.mapError(threadManagementFailure)),
    );
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${threadId} is no longer available.`);
    }
    const target = yield* ThreadReadMetrics.read(
      "records",
      threadManagement
        .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
          "runs",
          "runtimeRequests",
          "contextTransfers",
        ])
        .pipe(Effect.mapError(threadManagementFailure)),
    );
    return { parent, target, shell } as const;
  });

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const assertTargetEnabledForProject = (
    parent: CallerParent,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    let instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    if (input.migrateSelection && instanceId !== undefined) {
      const inherited = input.parent.thread.modelSelection;
      const candidateModel =
        input.target?.model ?? (instanceId === inherited.instanceId ? inherited.model : undefined);
      if (candidateModel !== undefined) {
        const routed = resolveSelection({ instanceId, model: candidateModel });
        if (routed.kind === "mapped") instanceId = routed.selection.instanceId;
      }
    }
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: CallerParent;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly delegateSelection?: boolean;
    readonly migrateSelection?: boolean;
    /**
     * Set only when the command that will dispatch this target already has a receipt: that
     * dispatch can only replay the recorded result, never start anything new, so filtering
     * candidates by the project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different command id than the
     * one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    let requestedInstanceId = input.target?.providerInstanceId;
    let requestedDriver = input.target?.driverKind;
    let requestedModel = input.target?.model;
    let requestedSuffix: string | undefined;
    let inheritedSelection = input.parent.thread.modelSelection;
    const originalSelection = inheritedSelection;
    const requestedOptions = input.target?.options;
    let inheritedWasMapped = false;
    let requestedWasMapped = false;

    // A duplicate must not disappear when the compatibility merge canonicalizes effort ids.
    if (input.delegateSelection && requestedOptions !== undefined) {
      const invalid = invalidOptionSelections(requestedOptions, undefined);
      if (invalid.length > 0) return yield* failure("invalid_request", invalid.join(" "));
    }
    if (
      input.delegateSelection &&
      (input.migrateSelection || inheritedSelection.instanceId !== "opencode")
    ) {
      const invalid = invalidOptionSelections(inheritedSelection.options ?? [], undefined);
      if (invalid.length > 0) return yield* failure("invalid_request", invalid.join(" "));
      if (input.migrateSelection && inheritedSelection.instanceId === "opencode") {
        const folded = mergeSelection(inheritedSelection, {});
        if (folded.kind === "conflict") return yield* failure("invalid_request", folded.reason);
        inheritedSelection = folded.selection;
        const routed = resolveSelection(inheritedSelection);
        if (routed.kind === "conflict") return yield* failure("invalid_request", routed.reason);
        inheritedWasMapped = routed.kind === "mapped";
        inheritedSelection = routed.selection;
      }
    }
    if (input.delegateSelection && input.migrateSelection && input.target?.model !== undefined) {
      // Older callers can name a legacy OpenCode slug after the parent moved to a native driver.
      if (input.target.providerInstanceId !== undefined && input.target.driverKind !== undefined) {
        const source = input.providers.find(
          (provider) => provider.instanceId === input.target?.providerInstanceId,
        );
        if (source !== undefined && source.driver !== input.target.driverKind) {
          return yield* failure(
            "invalid_request",
            `Provider instance ${source.instanceId} does not use driver ${input.target.driverKind}.`,
          );
        }
      }
      const explicitSource =
        input.target.providerInstanceId ??
        (input.target.driverKind === undefined || input.target.driverKind === "opencode"
          ? "opencode"
          : undefined);
      if (explicitSource === "opencode") {
        const explicit = resolveSelection({
          instanceId: "opencode" as ProviderInstanceId,
          model: input.target.model,
        });
        if (explicit.kind === "mapped") {
          requestedWasMapped = true;
          requestedInstanceId = explicit.selection.instanceId;
          requestedModel = explicit.selection.model;
          requestedSuffix = explicit.effort ?? undefined;
          requestedDriver = undefined;
        }
      }
    }
    let mappedDestination = requestedWasMapped;
    if (input.delegateSelection && input.migrateSelection) {
      // Resolve the requested legacy identity before looking up its destination provider/model.
      const candidateInstance =
        requestedInstanceId ??
        (requestedDriver === undefined || requestedDriver === "opencode"
          ? originalSelection.instanceId
          : undefined);
      const candidateModel =
        requestedModel ??
        (candidateInstance === originalSelection.instanceId ? originalSelection.model : undefined);
      if (
        candidateInstance !== undefined &&
        candidateModel !== undefined &&
        (requestedDriver === undefined || requestedDriver === "opencode")
      ) {
        const routed = resolveSelection({
          instanceId: candidateInstance,
          model: candidateModel,
        });
        if (routed.kind === "conflict") return yield* failure("invalid_request", routed.reason);
        if (routed.kind === "mapped") {
          mappedDestination = true;
          requestedInstanceId = routed.selection.instanceId;
          requestedModel = routed.selection.model;
          // An inherited suffix is an old value, not a new override.
          if (!requestedWasMapped && input.target?.model !== undefined) {
            requestedSuffix = routed.effort ?? undefined;
          }
          requestedDriver = undefined;
        }
      }
    }
    if (
      input.delegateSelection &&
      input.migrateSelection &&
      originalSelection.instanceId === "opencode" &&
      inheritedSelection.instanceId !== originalSelection.instanceId &&
      requestedInstanceId === undefined &&
      requestedDriver === undefined &&
      requestedModel === undefined
    ) {
      mappedDestination = true;
    }
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === inheritedSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= inheritedSelection.instanceId;
    if (
      inheritedWasMapped &&
      instanceId === inheritedSelection.instanceId &&
      (requestedModel === undefined || requestedModel === inheritedSelection.model)
    ) {
      mappedDestination = true;
    }

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    if (
      mappedDestination &&
      provider.driver !== (instanceId === "codex-cu" ? "codex" : instanceId)
    ) {
      return yield* failure(
        "invalid_request",
        `Mapped provider instance ${instanceId} uses unexpected driver ${provider.driver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    // Harness routing names default instances; custom instance ids still use their driver's effort.
    const effortInstanceId = (
      (provider.driver === "claudeAgent" || provider.driver === "codex") &&
      effortOptionId(instanceId) === "variant"
        ? provider.driver
        : instanceId
    ) as ProviderInstanceId;

    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider?.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      (requestedModel !== undefined || input.delegateSelection === true) &&
      provider !== undefined &&
      (provider.models.length > 0 || mappedDestination) &&
      !provider.models.some((candidate) => candidate.slug === model)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${model} is not advertised by provider ${instanceId}.`,
      );
    }

    const descriptors = provider.models.find((candidate) => candidate.slug === model)?.capabilities
      ?.optionDescriptors;
    const inheritedOptions = supportedInheritedOptions(inheritedSelection.options, descriptors);
    if (!input.delegateSelection && requestedOptions !== undefined) {
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
    let options = inheritsOptions ? inheritedOptions : undefined;
    if (
      input.delegateSelection &&
      (input.migrateSelection ||
        effortInstanceId === "claudeAgent" ||
        effortInstanceId === "codex" ||
        effortInstanceId === "codex-cu")
    ) {
      const effortId = effortOptionId(effortInstanceId);
      const optionOverridesEffort =
        requestedOptions?.some((option) => option.id === effortId || option.id === "variant") ===
        true;
      const overridesEffort = requestedSuffix !== undefined || optionOverridesEffort;
      const requestedIds = new Set(requestedOptions?.map((option) => option.id));
      const mergedOptions =
        requestedOptions === undefined
          ? undefined
          : requestedOptions.length === 0
            ? []
            : [
                ...(options ?? []).filter(
                  (option) =>
                    !requestedIds.has(option.id) &&
                    !(overridesEffort && (option.id === effortId || option.id === "variant")),
                ),
                ...requestedOptions,
              ];
      const merged = mergeSelection(
        inheritsOptions
          ? {
              ...inheritedSelection,
              instanceId: effortInstanceId,
              options: inheritedOptions ?? [],
              ...(overridesEffort || requestedOptions?.length === 0
                ? {
                    options: (inheritedOptions ?? []).filter(
                      (option) => option.id !== effortId && option.id !== "variant",
                    ),
                  }
                : {}),
            }
          : { instanceId, model, options: [] },
        {
          instanceId: effortInstanceId,
          model,
          ...(mergedOptions === undefined ? {} : { options: mergedOptions }),
          ...(requestedSuffix === undefined
            ? {}
            : requestedOptions?.length === 0
              ? { variant: null }
              : { variant: requestedSuffix }),
        },
      );
      if (merged.kind === "conflict") return yield* failure("invalid_request", merged.reason);
      options = requestedOptions?.length === 0 ? [] : merged.selection.options;
      if (options !== undefined && options.length > 1) {
        const order = [
          ...(inheritsOptions ? (inheritedOptions ?? []) : []),
          ...(requestedOptions ?? []),
        ];
        const position = (id: string) => {
          const index = order.findIndex(
            (option) => option.id === id || (id === effortId && option.id === "variant"),
          );
          return index < 0 ? order.length : index;
        };
        options = [...options].sort((a, b) => position(a.id) - position(b.id));
      }
    } else if (requestedOptions !== undefined) {
      const selections = new Map(
        (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      for (const selection of requestedOptions) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    if (input.delegateSelection) {
      if (
        (effortInstanceId === "claudeAgent" ||
          effortInstanceId === "codex" ||
          effortInstanceId === "codex-cu") &&
        options?.some((option) => option.id === "variant")
      ) {
        return yield* failure("invalid_request", `Model ${model} cannot use a variant option.`);
      }
      if (mappedDestination && (options?.length ?? 0) > 0 && descriptors === undefined) {
        return yield* failure(
          "invalid_request",
          `Options for ${model} on provider ${instanceId} cannot be checked against the provider catalog.`,
        );
      }
      const invalid = invalidOptionSelections(options ?? [], descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }
    const requestedProviderInstanceId = requestedWasMapped
      ? ("opencode" as ProviderInstanceId)
      : (input.target?.providerInstanceId ??
        (input.target?.driverKind === undefined || input.target.driverKind === "opencode"
          ? originalSelection.instanceId
          : instanceId));
    const sourceModel = input.target?.model ?? originalSelection.model;
    const sourceOptions =
      requestedOptions ??
      (requestedProviderInstanceId === originalSelection.instanceId &&
      sourceModel === originalSelection.model
        ? originalSelection.options
        : undefined);
    const requested = {
      providerInstanceId: requestedProviderInstanceId,
      model: sourceModel,
      ...(sourceOptions === undefined ? {} : { options: sourceOptions }),
    };
    const describeOptions = (selections: ModelSelection["options"]) =>
      selections?.length
        ? ` (${selections.map(({ id, value }) => `${id} ${value}`).join(", ")})`
        : "";
    const selectionRouting =
      mappedDestination &&
      resolveSelection({
        instanceId: requestedProviderInstanceId,
        model: sourceModel,
      }).kind === "mapped"
        ? {
            requested,
            reason: "harness-migration" as const,
            message: `Routed ${requestedProviderInstanceId}/${sourceModel}${describeOptions(sourceOptions)} → ${instanceId}/${model}${describeOptions(options)} by harness migration; this is the same route as ${instanceId}/${model}, not a separate fallback.`,
          }
        : undefined;
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
      ...(selectionRouting === undefined ? {} : { selectionRouting }),
    };
  });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal: boolean | "background" = false,
    acknowledgementOperation = "task-status-acknowledge",
    onProgress?: (value: Partial<OrchestratorMcpDelegateTaskResult>) => void,
    observe?: (result: OrchestratorMcpDelegateTaskResult) => Effect.Effect<void>,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const identity = delegationTaskIdentity(taskId);
    let idShape: NonNullable<NonNullable<AnalyticsEvent["props"]>["idShape"]> =
      delegationIdShape(taskId);
    const idHint = () =>
      idShape === "thread_id" || idShape === "child_thread_id"
        ? " This looks like a thread id (childThreadId). Pass the taskId that delegate_task returned. Use t3_thread_read for the child thread."
        : " Expected the taskId returned by delegate_task.";
    const callerOwned =
      identity?.canonical === true &&
      identity.environment === stablePart(scope.environmentId) &&
      identity.thread === stablePart(scope.thread.threadId);
    let idCanonical =
      identity?.canonical === true && (callerOwned || identity.thread === undefined);
    let foundBy: NonNullable<NonNullable<AnalyticsEvent["props"]>["foundBy"]> = "none";
    let notFoundReason: NonNullable<NonNullable<AnalyticsEvent["props"]>["notFoundReason"]> =
      identity === undefined ? "not_a_delegation_id" : "non_canonical_id";
    yield* McpCallAnalytics.setTaskLookup({ foundBy, idCanonical, idShape });
    yield* requireCapability(scope);
    let parentProjection = yield* threadManagement
      .getThreadRecords(
        scope.thread.threadId,
        ["runs", "subagents", "contextTransfers"],
        undefined,
        { projectionOnly: true },
      )
      .pipe(NodeSqliteClient.foregroundReads, Effect.mapError(threadManagementFailure), (effect) =>
        McpTaskTrace.stage(effect, "parent_records", "t3.task"),
      );
    if (
      parentProjection.subagents.some(
        (task) =>
          task.origin === "app_owned" &&
          task.threadId === scope.thread.threadId &&
          task.childThreadId === String(taskId),
      )
    ) {
      idShape = "child_thread_id";
      yield* McpCallAnalytics.setTaskLookup({ foundBy, idCanonical, idShape });
    }
    let task = findDelegatedTask(parentProjection, scope.thread.threadId, taskId);
    if (task !== undefined)
      yield* McpCallAnalytics.setTaskLookup({
        foundBy: task.id === taskId ? "subagents" : "request_key_recovery",
        idCanonical,
      });
    if (task === undefined || task.childThreadId === null) {
      let detail = "";
      if (identity?.canonical && (callerOwned || identity.thread === undefined)) {
        const state = yield* threadManagement.getDelegationCommandState(identity.commandId).pipe(
          NodeSqliteClient.readOnly,
          NodeSqliteClient.foregroundReads,
          Effect.mapError((error) => failure("orchestration_error", errorMessage(error))),
          (effect) => McpTaskTrace.stage(effect, "command_receipt", "t3.task"),
        );
        if (
          "threadId" in state &&
          (state.threadId !== scope.thread.threadId ||
            state.commandType !== "delegated_task.request")
        ) {
          yield* McpCallAnalytics.setTaskLookup({
            foundBy: "none",
            notFoundReason:
              state.threadId !== scope.thread.threadId
                ? "other_thread"
                : "not_a_delegation_command",
            idCanonical: false,
          });
          return yield* failure("task_not_found", `No delegated task has this id.${idHint()}`);
        }
        yield* Effect.annotateCurrentSpan({ "t3.task.creation_state": state.status });
        switch (state.status) {
          case "accepted":
            foundBy = "receipt";
            notFoundReason = "accepted";
            detail =
              " This delegation was saved; its task projection is catching up. Retry task_status with this task id.";
            break;
          case "rejected":
            foundBy = "receipt";
            notFoundReason = "rejected";
            detail = " This delegation was rejected.";
            break;
          case "pending":
            if (!callerOwned) {
              idCanonical = false;
              break;
            }
            notFoundReason = "pending";
            detail =
              " This delegation is still being created; retry task_status with this task id, or retry delegate_task with the same clientRequestId.";
            break;
          case "abandoned":
          case "never_saved":
            if (!callerOwned) {
              idCanonical = false;
              break;
            }
            notFoundReason = state.status;
            // A task committed after the first projection read must win over a missing receipt.
            parentProjection = yield* threadManagement
              .getThreadRecords(
                scope.thread.threadId,
                ["runs", "subagents", "contextTransfers"],
                undefined,
                { projectionOnly: true },
              )
              .pipe(
                NodeSqliteClient.foregroundReads,
                Effect.mapError(threadManagementFailure),
                (effect) => McpTaskTrace.stage(effect, "parent_records", "t3.task"),
              );
            task = findDelegatedTask(parentProjection, scope.thread.threadId, taskId);
            if (task === undefined)
              detail =
                state.status === "abandoned"
                  ? ` This delegation was not created: the create stopped after ${state.elapsedSeconds} s waiting at dispatch/threadManagement.dispatch (${state.reason}). Nothing ran. Retry delegate_task with the same clientRequestId.`
                  : " This delegation was never saved. Retry delegate_task with the same clientRequestId.";
            break;
        }
      }
      if (task === undefined || task.childThreadId === null) {
        if (task !== undefined) {
          foundBy = task.id === taskId ? "subagents" : "request_key_recovery";
          notFoundReason = "missing_child_thread";
        }
        yield* McpCallAnalytics.setTaskLookup({ foundBy, notFoundReason, idCanonical });
        return yield* failure(
          "task_not_found",
          `No delegated task has this id.${detail}${idHint()}`,
        );
      }
    }
    yield* McpCallAnalytics.setTaskLookup({
      foundBy: task.id === taskId ? "subagents" : "request_key_recovery",
      idCanonical,
    });
    taskId = task.id;
    onProgress?.({ childThreadId: task.childThreadId, childNodeId: task.id });
    // Keep failures available if assistant-result hydration exceeds the status deadline.
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "nodes",
          "turnItems",
        ],
        { messageRoles: ["user"], turnItemTypes: ["error"], omitSettledLeafNodes: true },
        { projectionOnly: true },
      )
      .pipe(NodeSqliteClient.foregroundReads, Effect.mapError(threadManagementFailure), (effect) =>
        McpTaskTrace.stage(effect, "child_records", "t3.task"),
      );
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const unfinishedRuns = childControls.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          !(run.status === "queued" && run.queueHeld === true),
      )
      .toSorted((a, b) => b.ordinal - a.ordinal);
    const currentRun = unfinishedRuns.find((run) => run.status !== "queued") ?? unfinishedRuns[0];
    const terminalStatus =
      terminalRun === undefined
        ? null
        : terminalRun.delegatedTaskStall === undefined
          ? taskStatusForRun(terminalRun)
          : "failed";
    onProgress?.({
      childRunId: childRun?.id ?? null,
      currentRunId: currentRun?.id ?? null,
      currentRunStatus: currentRun?.status ?? null,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      hasPendingChildRuns: hasPendingChildRuns(childControls, childRun),
      ...startState(currentRun ?? childRun, childControls.providerTurns),
    });
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const resultRunAncestors = new Set<RunId>();
    let resultSource = taskResultRun;
    while (resultSource !== undefined && !resultRunAncestors.has(resultSource.id)) {
      resultRunAncestors.add(resultSource.id);
      const previous: RunId | undefined = resultSource.restartContinuationOfRunId;
      resultSource =
        previous === undefined ? undefined : childControls.runs.find((run) => run.id === previous);
    }
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? progress.state === "waiting_for_children" &&
            progress.resultRun !== undefined &&
            resultRunAncestors.has(progress.resultRun.id)
            ? "waiting_for_children"
            : "result_available"
          : "working"
        : progress.state;
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(
          NodeSqliteClient.readOnly,
          NodeSqliteClient.foregroundReads,
          Effect.mapError(threadManagementFailure),
          (effect) => McpTaskTrace.stage(effect, "pending_result", "t3.task"),
        ));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const reportedStatus =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(taskResultRun ?? childRun)
          : taskStatusForRun(taskResultRun ?? childRun) === "queued"
            ? "queued"
            : "running";
    const resultRun = taskResultRun ?? childRun;
    const stall = isTerminalTaskStatus(reportedStatus) ? resultRun?.delegatedTaskStall : undefined;
    const status = stall === undefined ? reportedStatus : "failed";
    const providerFailure =
      status === "failed"
        ? latestRootProviderFailure(resultRun ?? null, childControls.turnItems)
        : null;
    const taskFailure =
      status !== "failed"
        ? undefined
        : providerFailure !== null
          ? {
              category: providerFailure.category ?? "unknown",
              code: providerFailure.code,
              message: providerFailure.message.slice(0, 2_000),
              retryable: providerFailure.retryable,
            }
          : stall === undefined
            ? undefined
            : {
                category: "unknown" as const,
                code: null,
                message: stalledSummary(stall, null).slice(0, 2_000),
                retryable: null,
              };
    onProgress?.({ status, ...(taskFailure === undefined ? {} : { failure: taskFailure }) });
    const resultTransfer = taskResultTransfer(parentProjection, childControls, task) ?? null;
    const summaryRun =
      task.result === null
        ? taskResultRun
        : (childControls.runs.find((run) => run.id === resultTransfer?.sourcePoint.runId) ??
          childRun);
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id, childRun?.id, summaryRun?.id].filter(
          (id): id is RunId => id !== undefined,
        ),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        ["messages", "turnItems"],
        {
          messageRoles: ["assistant"],
          messageRunIds: resultRunIds,
          turnItemRunIds: resultRunIds,
          turnItemTypes: ["assistant_message"],
        },
        { projectionOnly: true },
      )
      .pipe(NodeSqliteClient.foregroundReads, Effect.mapError(threadManagementFailure), (effect) =>
        McpTaskTrace.stage(effect, "result", "t3.task"),
      );
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: [...childControls.turnItems, ...resultRecords.turnItems],
    };
    const resultText = (run: OrchestrationV2Run) => {
      const partial = subagentResultForRun(childProjection, run);
      return run.delegatedTaskStall === undefined
        ? partial.text
        : stalledSummary(
            run.delegatedTaskStall,
            partial.messageId === null && partial.turnItemId === null ? null : partial.text,
          );
    };
    const projectedResult =
      summaryRun !== undefined && isTerminalTaskStatus(status)
        ? subagentResultForRun(childProjection, summaryRun)
        : null;
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? resultText(taskResultRun)
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : resultText(terminalRun)
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const resultModelRun = task.result !== null ? summaryRun : taskResultRun;
    const recoveredRun =
      resultModelRun?.launchRecovery?.kind === "model_access" ? resultModelRun : undefined;
    const modelSelection = recoveredRun?.modelSelection ??
      childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const activeRun = taskResultRun ?? childRun;
    const activeError = (childProjection.turnItems ?? [])
      .filter((item) => item.runId === activeRun?.id && item.type === "error")
      .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const retry =
      !isTerminalTaskStatus(status) &&
      activeError?.type === "error" &&
      activeError.retry !== undefined &&
      activeError.status === "running"
        ? {
            state: "retrying" as const,
            lastError: activeError.failure.message,
            since: DateTime.formatIso(activeError.startedAt ?? activeError.updatedAt),
            attempt: activeError.retry.attempt,
            delayMs: activeError.retry.retryDelayMs ?? 0,
            filesMayBePartlyWritten: true,
          }
        : activeRun?.transientRecovery === undefined ||
            status === "completed" ||
            status === "interrupted" ||
            status === "cancelled"
          ? null
          : {
              state: status === "failed" ? ("failed_transient" as const) : ("resuming" as const),
              lastError:
                status === "failed"
                  ? (derivedResult ?? activeRun.transientRecovery.firstError.message)
                  : activeRun.transientRecovery.firstError.message,
              since: activeRun.transientRecovery.since,
              attempt: 1,
              delayMs: activeRun.status === "starting" ? 1000 : 0,
              filesMayBePartlyWritten: true,
            };
    const finishedOn = claudeRecoveryResult(recoveredRun, null).finishedOn;
    const response = {
      retry,
      partial: false,
      currentRunId: currentRun?.id ?? null,
      currentRunStatus: currentRun?.status ?? null,
      taskId: task.id,
      childThreadId: task.childThreadId,
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      ...(taskFailure === undefined ? {} : { failure: taskFailure }),
      startedAt: childRun?.startedAt == null ? null : DateTime.formatIso(childRun.startedAt),
      ...startState(
        isTerminalTaskStatus(status) ? childRun : (currentRun ?? childRun),
        childControls.providerTurns,
      ),
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      ...(finishedOn === undefined ? {} : { finishedOn }),
      options: modelSelection.options ?? [],
      ...(task.selectionRouting === undefined ? {} : { selectionRouting: task.selectionRouting }),
      ...(Option.isSome(progressGuard)
        ? progressGuard.value.status(task.childThreadId)
        : { lastProgressAt: null, lastProgressKind: null, thinkingSince: null }),
      ...(stall === undefined
        ? {}
        : {
            lastProgressAt: DateTime.formatIso(stall.lastProgressAt),
            lastProgressKind: stall.lastProgressKind,
            thinkingSince: null,
          }),
      ...((task.failureReason ?? (stall === undefined ? undefined : "stalled")) === undefined
        ? {}
        : { failureReason: "stalled" as const }),
      summary: derivedResult,
      resultLooksIncomplete: projectedResult?.incomplete != null,
      ...(projectedResult?.incomplete == null
        ? {}
        : { incompleteReason: projectedResult.incomplete }),
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        childControls.runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, task.id, childRun),
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
    if (observe !== undefined) yield* observe(response);
    if (
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const acknowledge = Effect.gen(function* () {
        const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
        const acknowledgementRequestKey = yield* requestKey(undefined);
        yield* threadManagement
          .dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: stableCommandId({
              scope,
              requestKey: acknowledgementRequestKey,
              operation: acknowledgementOperation,
            }),
            parentThreadId: scope.thread.threadId,
            taskId,
            observedByRunId:
              observingRun?.providerInstanceId === scope.thread.providerInstanceId
                ? observingRun.id
                : null,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
      });
      if (acknowledgeTerminal === "background") {
        // Delivery writes belong to the service lifetime, never the status read's latency.
        yield* acknowledge.pipe(
          Effect.timeout("10 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("task-status acknowledgement deferred", { taskId, cause }),
          ),
          Effect.forkIn(serviceScope),
        );
      } else if (observe !== undefined) {
        const delivery = yield* acknowledge.pipe(Effect.forkIn(serviceScope));
        yield* Fiber.join(delivery);
      } else {
        yield* acknowledge;
      }
    }
    return response;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    observe?: (result: OrchestratorMcpDelegateTaskResult) => Effect.Effect<void>,
  ) {
    const streamError = (error: unknown) =>
      failure(
        "orchestration_error",
        `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
      );
    // Sequences are global, so one cursor taken before the first read
    // replays anything either thread records after it.
    const afterSequence = yield* threadManagement
      .getThreadEventSequence(scope.thread.threadId)
      .pipe(Effect.mapError(streamError));
    const initial = yield* readTask(scope, taskId, false, true, undefined, undefined, observe);
    if (endsTaskWait(initial)) {
      return Option.some(initial);
    }
    // One stream per event type, so transcript events never fill a buffer.
    return yield* Stream.mergeAll(
      TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
        threadManagement.streamStoredEventsFrom({
          threadId: thread === "parent" ? scope.thread.threadId : initial.childThreadId,
          afterSequence,
          eventType,
        }),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.mapError(streamError),
      Stream.mapEffect(() => readTask(scope, taskId, false, true, undefined, undefined, observe)),
      Stream.filter(endsTaskWait),
      Stream.runHead,
    );
  });

  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */
  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: CallerParent | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
        readonly live?: boolean;
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.live ??
        (caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent))));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  return OrchestratorMcpService.of({
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: bindToCurrentThread
          ? { type: "root" }
          : yield* scheduledTaskWorkspaceStrategy(project.workspaceRoot),
        modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const { task } = yield* scheduledTasks.upsert(upsertInput).pipe(
        // ardud: a secretRef from a board ask is only for the thread it was given to.
        Effect.provideService(SecretRedeemer, parent?.thread.id ?? null),
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not schedule task: ${error.message}`),
        ),
      );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        const visibleTasks = tasks.filter(
          (task) => projectId === undefined || task.projectId === projectId,
        );
        // Liveness belongs to the caller snapshot, not each scheduled task's summary.
        const live =
          visibleTasks.length > 0 &&
          (parent === undefined
            ? scope.client?.access !== "read-only"
            : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, parent))));
        return {
          tasks: yield* Effect.forEach(visibleTasks, (task) =>
            summarizeScheduledTask(scope, { parent, limits, live }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a T3 thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Rebinding changes where runs execute, so the workspace strategy must
        // follow: unbinding a root-strategy task in a Git project would
        // otherwise run loose prompts in the shared project checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : input.bindToCurrentThread
              ? { type: "root" as const }
              : yield* scheduledTaskWorkspaceStrategy(
                  (yield* requireProject(existing.projectId)).workspaceRoot,
                );
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks.upsert(upsertInput).pipe(
          // ardud: a secretRef from a board ask is only for the thread it was given to.
          Effect.provideService(SecretRedeemer, parent?.thread.id ?? null),
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
          ),
        );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: Effect.fn("OrchestratorMcpService.requestSecret")(function* (scope, input) {
      const waitStartedAt = yield* Clock.monotonicTimeNanos;
      let closeCard = Effect.void;
      const request = Effect.gen(function* () {
        const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
        const threadId = threadScope.thread.threadId;
        const run = ThreadManagementService.latestActiveRun(
          yield* loadProjection(parent.thread.id, ["runs"]),
        );
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== threadScope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Asking for a secret requires an active run owned by this MCP provider session.",
          );
        }
        const runId = run.id;
        const nodeId = run.rootNodeId;
        const key = yield* requestKey(input.clientRequestId);
        const turnItemId = TurnItemId.make(
          `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
        );
        const record = (secretStatus: "pending" | "cancelled") =>
          threadManagement
            .dispatch({
              type: "secret_request.record",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `secret-${secretStatus}`,
              }),
              threadId: threadId,
              runId,
              nodeId,
              turnItemId,
              label: input.label,
              reason: input.reason,
              ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
              secretStatus,
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Could not record the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
        // A delayed pending commit must finish before cleanup, even when the caller is gone.
        const pending = yield* record("pending").pipe(Effect.forkIn(serviceScope));
        closeCard = Fiber.await(pending).pipe(
          Effect.andThen(record("cancelled")),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not close a secret request card", { cause }),
          ),
          Effect.asVoid,
        );
        yield* Fiber.join(pending);
        const status = yield* Effect.gen(function* () {
          while (true) {
            const projection = yield* threadManagement
              .getThreadRecords(threadId, ["runs", "turnItems"], {
                turnItemTypes: ["secret_request"],
                messageRoles: [],
              })
              .pipe(
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to read the secret request: ${errorMessage(error)}`,
                  ),
                ),
              );
            const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
            if (item?.type === "secret_request" && item.secretStatus !== "pending") {
              return item.secretStatus;
            }
            const current = projection.runs.find((candidate) => candidate.id === runId);
            if (
              current === undefined ||
              ThreadManagementService.isTerminalRunStatus(current.status)
            ) {
              return "cancelled" as const;
            }
            yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
          }
        });
        if (status !== "saved") return { status };
        const secretRef = yield* secretRequests.savedRef({ threadId, turnItemId });
        if (Option.isNone(secretRef)) {
          return yield* failure(
            "orchestration_error",
            "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
          );
        }
        return { status, secretRef: secretRef.value };
      });
      const response = yield* request.pipe(
        McpDeadline.awaitInterruptibly,
        Effect.timeoutOption(
          Duration.millis(yield* remainingWaitMs(waitStartedAt, input.timeoutMs)),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) &&
          Option.isSome(exit.value) &&
          (exit.value.value.status === "saved" || exit.value.value.status === "declined")
            ? Effect.void
            : closeCard.pipe(Effect.forkIn(serviceScope), Effect.asVoid),
        ),
      );
      const result = Option.isSome(response) ? response.value : { status: "timed_out" as const };
      yield* Effect.annotateCurrentSpan({ "secret_request.status": result.status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status: result.status });
      return result;
    }, untilShutdown),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope) {
      const { parent, limits } = yield* loadCaller(scope);
      const providers = yield* loadProviders;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const modelPreferences = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providerModelPreferences ?? {}),
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inheritedSelection = parent?.thread.modelSelection;
      const inheritedDescriptors = providers
        .find((provider) => provider.instanceId === inheritedSelection?.instanceId)
        ?.models.find((model) => model.slug === inheritedSelection?.model)
        ?.capabilities?.optionDescriptors;
      return {
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: parent?.thread.modelSelection.instanceId ?? null,
        inheritedModel: parent?.thread.modelSelection.model ?? null,
        inheritedOptions:
          supportedInheritedOptions(inheritedSelection?.options, inheritedDescriptors) ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          const constraints = providerConstraints(
            provider,
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          return {
            providerInstanceId: provider.instanceId,
            driverKind: provider.driver,
            displayName: provider?.displayName ?? null,
            models:
              provider?.models
                .filter(
                  (model) =>
                    model.isCustom ||
                    !modelPreferences[provider.instanceId]?.hiddenModels.includes(model.slug),
                )
                .map((model) => ({
                  id: model.slug,
                  label: model.name ?? null,
                  ...(model.capabilities?.optionDescriptors === undefined
                    ? {}
                    : { options: model.capabilities.optionDescriptors }),
                })) ?? [],
            ...(provider.supportedRuntimeModes === undefined ||
            provider.supportedRuntimeModes.length === 0
              ? {}
              : { runtimeModes: [...provider.supportedRuntimeModes] }),
            canRunChildTask: constraints.length === 0,
            canRunCrossProviderChildTask: constraints.length === 0,
            constraints: [...constraints],
          };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      const waitStartedAt = yield* Clock.monotonicTimeNanos;
      yield* Effect.annotateCurrentSpan({
        "t3.mcp.caller_thread_id": callerScope.thread?.threadId ?? null,
        "t3.delegate.mode": input.mode === "wait" ? "wait" : "async",
        ...(input.clientRequestId === undefined
          ? {}
          : {
              "t3.delegate.client_request_id": input.clientRequestId,
            }),
        ...(input.target?.providerInstanceId === undefined
          ? {}
          : {
              "t3.delegate.provider_instance_id": input.target.providerInstanceId,
            }),
        ...(input.target?.model === undefined ? {} : { "t3.delegate.model": input.target.model }),
      });
      let retryKey = input.clientRequestId;
      const bounded = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>, taskId?: string) =>
        McpDeadline.withDeadline(effect, {
          code: stage === "caller" ? "caller_unresolved" : "delegation_timeout",
          threadId: callerScope.thread?.threadId,
          stage,
          wait:
            stage === "dispatch"
              ? "threadManagement.dispatch"
              : stage === "receipt"
                ? "threadManagement.hasReceipt"
                : stage === "caller"
                  ? "caller identity"
                  : stage,
          ...(retryKey === undefined ? {} : { requestKey: retryKey }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(stage === "dispatch" ? { onTimeout: "detach" as const } : {}),
        }).pipe((bounded) => McpTaskTrace.stage(bounded, stage));
      const { scope, parent } = yield* bounded(
        "caller",
        loadThreadCaller(callerScope, "delegate_task"),
      );
      const parentRecords = yield* bounded(
        "parent_records",
        loadProjection(parent.thread.id, ["runs", "subagents"], { projectionOnly: true }).pipe(
          NodeSqliteClient.foregroundReads,
        ),
      );
      const parentRun = parentRecords.runs
        .filter(ThreadManagementService.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
      const providers = yield* bounded("catalog", loadProviders);
      const key = yield* bounded("request_key", requestKey(input.clientRequestId));
      retryKey = key;
      const commandId = delegationCommandId(scope, parentRecords, key);
      const expectedTaskId = IdAllocator.derive.delegatedTaskNode({ commandId });
      yield* McpCallAnalytics.trackDelegation(
        expectedTaskId,
        threadManagement.getCommandReceipt(commandId).pipe(
          Effect.map(Option.isSome),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        "t3.delegate.client_request_id": key,
        "t3.delegate.task_id": expectedTaskId,
        "t3.delegate.command_id": commandId,
      });
      const isRetryOfAcceptedDelegation = yield* bounded(
        "receipt",
        threadManagement
          .hasReceipt(commandId)
          .pipe(NodeSqliteClient.readOnly, NodeSqliteClient.foregroundReads),
      );
      yield* Effect.annotateCurrentSpan({
        "t3.delegate.retry_of_accepted": isRetryOfAcceptedDelegation,
      });
      const settings = yield* bounded(
        "settings",
        serverSettings.getSettings.pipe(
          Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
        ),
      );
      const target = yield* bounded(
        "selection",
        resolveTargetRechecking({
          parent,
          target: input.target,
          providers,
          delegateSelection: true,
          migrateSelection: settings.ardudHarnessMigration?.selections === "apply",
          skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
        }),
      );
      yield* Effect.annotateCurrentSpan({
        "t3.delegate.provider_instance_id": target.modelSelection.instanceId,
        "t3.delegate.model": target.modelSelection.model,
      });
      const runtimeMode = yield* resolveRuntimeMode(
        parent.thread.runtimeMode,
        input.runtimeMode,
        target,
      );
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        input.interactionMode,
      );
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
      if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
        const project = yield* bounded("workspace", requireProject(parent.thread.projectId));
        const base = yield* gitDriver
          .resolveCommit({
            cwd: parent.thread.worktreePath ?? project.workspaceRoot,
            revision: "HEAD",
          })
          .pipe(
            Effect.mapError(() =>
              failure("invalid_request", "Unable to resolve the parent checkout commit."),
            ),
            (effect) => bounded("workspace", effect),
          );
        // Launch preparation creates the worktree from the project root, so a
        // parent checkout in another repository (such as a Git folder inside
        // Scratch) would hand it a commit it cannot find.
        if (parent.thread.worktreePath !== null) {
          yield* gitDriver
            .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
            .pipe(
              Effect.mapError(() =>
                failure(
                  "invalid_request",
                  `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                ),
              ),
              (effect) => bounded("workspace", effect),
            );
        }
        workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
      }
      const dispatchAccepted = yield* Deferred.make<void, OrchestratorMcpFailure>();
      const upgradeCompletionWake = Effect.fn("OrchestratorMcpService.upgradeCompletionWake")(
        (taskId: NodeId) =>
          threadManagement
            .dispatch({
              type: "delegated_task.wake-policy",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: "delegate-task-wake-policy",
              }),
              parentThreadId: scope.thread.threadId,
              taskId,
              completionWake: "always",
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                  taskId,
                  outcome:
                    error._tag === "OrchestratorCommandPreviouslyRejectedError"
                      ? "previously_rejected"
                      : "dispatch_failed",
                  error,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                  taskId,
                  outcome: "defect",
                  cause,
                }),
              ),
              Effect.asVoid,
            ),
      );
      // ThreadManagementService.dispatch is the chokepoint for this command
      // type's own enablement check, using the same command id and its
      // receipt-replay exemption, so no separate assert runs here.
      const { result, preparation } = yield* threadManagement
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: taskPrompt(input),
          ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
          ...(input.title === undefined ? {} : { title: input.title }),
          modelSelection: target.modelSelection,
          ...(target.selectionRouting === undefined
            ? {}
            : { selectionRouting: target.selectionRouting }),
          runtimeMode,
          interactionMode,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          // Async delegations wake the parent on every child terminal; wait
          // delegations deliver through the blocking tool call, so a wake is
          // only needed if the parent settled first (timeout, disconnect).
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          Effect.tapError((error) =>
            error._tag === "OrchestratorCommandRejectedError" ||
            error._tag === "OrchestratorCommandPreviouslyRejectedError"
              ? McpCallAnalytics.setSaved(false)
              : Effect.void,
          ),
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to create delegated task: ${errorMessage(error)}`,
                ),
          ),
          (dispatch) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const result = yield* restore(dispatch);
                const createdRun = result.storedEvents.find(
                  (stored) =>
                    stored.event.type === "run.created" &&
                    stored.event.payload.workspacePreparation !== undefined,
                );
                // A late commit must schedule preparation before its bounded waiter can leave.
                const preparation =
                  createdRun?.event.type === "run.created"
                    ? yield* threadLaunch
                        .prepareRun({
                          commandId,
                          threadId: createdRun.event.threadId,
                          runId: createdRun.event.payload.id,
                        })
                        .pipe(Effect.forkIn(serviceScope, { uninterruptible: false }))
                    : undefined;
                return { result, preparation };
              }),
            ),
          Effect.onExit((exit) =>
            Deferred.done(
              dispatchAccepted,
              Exit.map(exit, () => undefined),
            ),
          ),
          (effect) => bounded("dispatch", effect, expectedTaskId),
          Effect.onExit((exit) => {
            if (input.mode !== "wait" || Exit.isSuccess(exit)) return Effect.void;
            // The caller has no waiter after a dispatch timeout or disconnect.
            // Await this create before upgrading, including when it already committed.
            return Deferred.await(dispatchAccepted).pipe(
              Effect.andThen(upgradeCompletionWake(expectedTaskId)),
              Effect.catchCause(() => Effect.void),
              Effect.forkIn(serviceScope, { uninterruptible: false }),
              Effect.asVoid,
            );
          }),
        );
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      // Receipt existence includes rejections; the persisted task proves this delegation was saved.
      yield* McpCallAnalytics.setSaved(true);
      const taskId = taskEvent.event.payload.id;
      yield* Effect.annotateCurrentSpan({
        "t3.delegate.task_id": taskId,
        "t3.delegate.provider_instance_id": taskEvent.event.payload.providerInstanceId,
        "t3.delegate.model": taskEvent.event.payload.model,
        "t3.delegate.outcome": "accepted",
      });
      const childThreadId = taskEvent.event.payload.childThreadId;
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (childThreadId === null) {
        return yield* failure("orchestration_error", "Accepted delegation has no child thread.");
      }
      const childRun =
        childRunEvent?.event.type === "run.created" ? childRunEvent.event.payload : undefined;
      const snapshot = yield* Ref.make<OrchestratorMcpDelegateTaskResult>({
        taskId,
        childThreadId,
        childRunId: childRun?.id ?? null,
        childNodeId: taskId,
        status: "running",
        startedAt: childRun?.startedAt == null ? null : DateTime.formatIso(childRun.startedAt),
        ...startState(childRun, []),
        ...(childRun === undefined ? { startPending: true } : {}),
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId: taskEvent.event.payload.providerInstanceId,
        model: taskEvent.event.payload.model,
        options: childRun?.modelSelection?.options ?? target.modelSelection.options ?? [],
        summary: null,
        resultContextTransferId: null,
        latestTerminalRunId: null,
        latestTerminalStatus: null,
        latestTerminalSummary: null,
        latestTerminalResultContextTransferId: null,
        hasPendingQuestion: false,
        pendingApproval: null,
        waitTimedOut: input.mode === "wait",
      });
      const observe = (value: OrchestratorMcpDelegateTaskResult) => Ref.set(snapshot, value);
      const continuation = yield* Effect.gen(function* () {
        if (preparation !== undefined) yield* Fiber.join(preparation);
        if (input.mode !== "wait")
          return yield* readTask(scope, taskId, false, true, undefined, undefined, observe);
        const waited = yield* waitForTask(scope, taskId, observe);
        if (Option.isSome(waited)) return waited.value;
        return { ...(yield* Ref.get(snapshot)), waitTimedOut: true };
      }).pipe(Effect.forkIn(serviceScope));
      const response = yield* Fiber.join(continuation).pipe(
        Effect.timeoutOption(
          Duration.millis(
            yield* remainingWaitMs(waitStartedAt, input.mode === "wait" ? input.timeoutMs : 10_000),
          ),
        ),
        (effect) => McpTaskTrace.stage(effect, "wait"),
        // A disconnect must not leave an event subscription behind. Interrupt
        // observation without joining a potentially blocked read or writer.
        Effect.ensuring(
          Fiber.interrupt(continuation).pipe(Effect.forkIn(serviceScope), Effect.asVoid),
        ),
      );
      const answer = Option.isSome(response)
        ? response.value
        : {
            ...(yield* Ref.get(snapshot)),
            waitTimedOut: input.mode === "wait",
          };
      // A slow writer must not hide the identity of an already accepted task.
      if (input.mode === "wait" && (answer.waitTimedOut || !isTerminalTaskStatus(answer.status))) {
        yield* upgradeCompletionWake(taskId).pipe(Effect.forkIn(serviceScope));
      }
      yield* Effect.annotateCurrentSpan({
        "t3.delegate.outcome": answer.waitTimedOut
          ? "timeout_wait"
          : isTerminalTaskStatus(answer.status)
            ? "completed"
            : "accepted",
      });
      return answer;
    }, traceUntilShutdown("t3.delegate")),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(function* (callerScope, taskId) {
      yield* Effect.annotateCurrentSpan({
        "t3.mcp.caller_thread_id": callerScope.thread?.threadId ?? null,
        "t3.task.task_id": taskId,
      });
      const scope = yield* requireThreadScope(callerScope, "task_status");
      yield* requireCapability(scope);
      if (scope.client?.access === "read-only") {
        return yield* failure(
          "capability_denied",
          "Task result acknowledgement requires write access.",
          "read_only_client",
        );
      }
      const startedAt = yield* Clock.monotonicTimeNanos;
      let partial: Omit<
        Extract<OrchestratorMcpTaskStatusResult, { partial: true }>,
        "retryHint"
      > = {
        taskId,
        partial: true,
        stoppedAt: "caller",
      };
      const parentSpan = yield* Effect.option(Effect.currentSpan);
      const read = Effect.gen(function* () {
        const caller = yield* readCallerIdentity(
          threadManagement,
          scope.thread.threadId,
          scope.thread.providerInstanceId,
        ).pipe(Effect.mapError(threadManagementFailure), (effect) =>
          McpTaskTrace.stage(effect, "caller", "t3.task"),
        );
        if (caller === null || caller.deletedAt !== null)
          return yield* failure("thread_not_found", "The calling thread was not found.");
        if (!isLiveCallerShell(caller, scope.thread.providerInstanceId))
          return yield* failure(
            "parent_not_active",
            "The calling provider no longer owns an active thread run.",
          );
        partial = { ...partial, callerResolved: true, stoppedAt: "parent_records" };
        return yield* readTask(scope, taskId, false, "background", undefined, (progress) => {
          partial = {
            ...partial,
            ...progress,
            partial: true,
            stoppedAt: progress.childThreadId === undefined ? "result" : "child_records",
          };
        });
      });
      // SQLite snapshot acquisition masks interruption. Let the service finish
      // cancellation and rollback without making the response wait for them.
      const result = yield* Effect.acquireUseRelease(
        read.pipe(
          (effect) =>
            Option.isSome(parentSpan)
              ? effect.pipe(Effect.withParentSpan(parentSpan.value))
              : effect,
          Effect.forkIn(serviceScope, { uninterruptible: false }),
        ),
        (reader) => Fiber.join(reader).pipe(Effect.timeoutOption("10 seconds")),
        (reader) => Fiber.interrupt(reader).pipe(Effect.forkIn(serviceScope), Effect.asVoid),
      );
      if (Option.isSome(result)) {
        yield* Effect.annotateCurrentSpan({ "t3.task.result": "found" });
        return result.value;
      }
      yield* Effect.annotateCurrentSpan({ "t3.task.result": "partial" });
      const answer = {
        ...partial,
        retryHint:
          `Robob was busy and this read stopped at ${partial.stoppedAt}. The task itself is unaffected. Retry task_status in a few seconds` +
          (partial.childThreadId === undefined
            ? "."
            : ", or read childThreadId with t3_thread_read."),
      };
      const now = yield* Clock.monotonicTimeNanos;
      yield* Effect.logWarning("orchestrator-mcp.task-status.partial", {
        taskId,
        stoppedAt: answer.stoppedAt,
        elapsedMs: Number(now - startedAt) / 1_000_000,
        callerThreadId: scope.thread.threadId,
      });
      return answer;
    }, traceUntilShutdown("t3.task")),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_cancel");
      const current = yield* readTask(scope, input.taskId);
      const taskId = current.taskId;
      const key = yield* requestKey(input.clientRequestId);
      const parentProjection = yield* loadProjection(scope.thread.threadId, ["subagents"]);
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
        }
        const { subagents } = yield* threadManagement
          .getThreadRecords(threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (task.origin === "app_owned" && task.childThreadId !== null) {
            yield* assertStoppable(task.childThreadId);
          }
        }
      });
      yield* assertStoppable(current.childThreadId);
      const parentTask = parentProjection.subagents.find(
        (task) => task.id === taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery =
        parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : threadManagement
              .dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-completion-delivery",
                }),
                parentThreadId: scope.thread.threadId,
                taskId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to dispose delegated task ${taskId} completion delivery: ${errorMessage(error)}`,
                  ),
                ),
              );
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
        const reason = input.reason ?? "Cancellation requested by parent task";
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: current.childThreadId,
            ...(reason === undefined ? {} : { reason }),
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to stop delegated task ${taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        yield* threadManagement
          .stopDelegatedTasks({ threadId: current.childThreadId, commandId, reason })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Stopped delegated task ${taskId}, but not every task it delegated: ${errorMessage(error)}`,
              ),
            ),
          );
        const stopped = yield* threadManagement
          .getThreadRecords(current.childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* threadManagement
            .dispatch({
              type: "queued-run.cancel",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `cancel-task-queued-run:${run.id}`,
              }),
              threadId: current.childThreadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
        }
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: parentProjection.thread.runtimeMode,
          interactionMode: parentProjection.thread.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      if (isTerminalTaskStatus(current.status)) {
        yield* stopWithinLimit;
        yield* disposeCompletionDelivery;
        return {
          taskId,
          status: current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      if (current.childRunId === null && current.workState !== "waiting_for_children") {
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${taskId} has no recorded child run to settle.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId,
            cause,
          }),
        ),
      );
      const stopped = yield* readTask(scope, taskId);
      return {
        taskId,
        status: isTerminalTaskStatus(stopped.status) ? stopped.status : "cancel_requested",
      };
    }),
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(
          yield* loadProjection(parent.thread.id, ["runs"]),
        );
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const legacyNamespaces = yield* Effect.cached(creationNamespaces(scope));
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              let ids = threadCreationIds(requestIdentity(scope), key, index);
              // Check the old receipt family before creating new thread-scoped work.
              for (const namespace of yield* legacyNamespaces) {
                const legacy = threadCreationIds(namespace, key, index);
                if (yield* threadManagement.hasReceipt(legacy.commandId("create-thread"))) {
                  ids = legacy;
                  break;
                }
              }
              if (!(yield* threadManagement.hasReceipt(ids.commandId("create-thread")))) {
                ids =
                  (yield* unrecordedCreation(scope, parent.thread.projectId, key, index)) ?? ids;
              }
              const commandId = ids.commandId("create-thread");
              const threadId = ids.threadId;
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: ids.commandId("dispatch-thread"),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: ids.messageId,
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId, ["runs"]);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: ids.commandId("record-created-thread"),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      const projectThreads = yield* threadManagement
        .getThreadListCandidates(projectId)
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      const statuses = input.statuses === undefined ? null : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter(
          (thread) =>
            input.includeSubagents !== false || thread.lineage.relationshipToParent !== "subagent",
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
            right.id.localeCompare(left.id),
        )
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const shells =
        page.length === 0
          ? []
          : (yield* threadManagement
              .getShellSnapshot({
                location: "active",
                threadIds: page.map((thread) => thread.id),
              })
              .pipe(Effect.mapError(threadManagementFailure))).threads;
      const shellsById = new Map(shells.map((shell) => [shell.id, shell]));
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.flatMap((candidate) => {
          const shell = shellsById.get(candidate.id);
          return shell === undefined
            ? []
            : [
                listItemFromShell(
                  {
                    ...candidate,
                    visibleItemCount: shell.visibleItemCount,
                  },
                  nowMs,
                ),
              ];
        }),
        nextCursor,
        total: filtered.length,
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(
      function* (scope, rawInput) {
        const callerThreadId = scope.thread?.threadId;
        if (rawInput.threadId === undefined && callerThreadId === undefined) {
          return yield* failure(
            "invalid_request",
            "threadId is required when the caller is not a T3 thread.",
          );
        }
        const input = { ...rawInput, threadId: (rawInput.threadId ?? callerThreadId)! };
        const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
        const view = input.view ?? "messages";
        const afterPosition = input.afterPosition ?? -1;
        const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
        const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
        const timeline = yield* ThreadReadMetrics.read(
          "timeline",
          threadManagement
            .getTimelinePage(input.threadId, {
              afterPosition,
              limit,
              view,
              ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
            })
            .pipe(Effect.mapError(threadManagementFailure)),
        );
        const page = timeline.items;
        const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
        for (const row of page) {
          if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
          const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
          ids.push(row.item.messageId);
          messageIdsByThread.set(row.sourceThreadId, ids);
        }
        const sourceMessages = yield* ThreadReadMetrics.read(
          "messages",
          Effect.forEach(
            [...messageIdsByThread],
            ([threadId, messageIds]) =>
              threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
                Effect.map((records) => [threadId, records.messages] as const),
                Effect.mapError(threadManagementFailure),
              ),
            { concurrency: 1 },
          ),
        );
        const messagesByThreadId = new Map(sourceMessages);
        yield* ThreadReadMetrics.read(
          "acknowledgement",
          Effect.gen(function* () {
            const returnedRunIds = new Set(
              page
                .filter((row) => row.sourceThreadId === target.thread.id)
                .map((row) => row.item.runId),
            );
            const tasks =
              parent === undefined ||
              (input.textOffset ?? 0) !== 0 ||
              !target.runs.some((run) => returnedRunIds.has(run.id)) ||
              target.thread.lineage.parentThreadId !== parent.thread.id ||
              target.thread.lineage.relationshipToParent !== "subagent"
                ? []
                : directAppOwnedChildTasks(
                    yield* loadProjection(parent.thread.id, ["subagents"]),
                    target,
                    returnedRunIds,
                  );
            if (
              parent !== undefined &&
              scope.thread !== undefined &&
              tasks.length > 0 &&
              (input.textOffset ?? 0) === 0
            ) {
              const parentResults = yield* loadProjection(parent.thread.id, ["contextTransfers"]);
              for (const task of tasks) {
                const transfer = taskResultTransfer(parentResults, target, task);
                const resultRunId =
                  transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
                const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
                const resultRecords = yield* threadManagement
                  .getThreadRecords(target.thread.id, ["messages", "turnItems", "providerTurns"], {
                    messageRoles: ["assistant"],
                    messageRunIds: resultRunIds,
                    turnItemRunIds: resultRunIds,
                    turnItemTypes: ["assistant_message", "error"],
                  })
                  .pipe(Effect.mapError(threadManagementFailure));
                if (
                  pageIncludesTerminalTaskResult({
                    parent: parentResults,
                    page,
                    task,
                    target: { ...target, ...resultRecords },
                    maxChars,
                  })
                ) {
                  yield* readTask(
                    scope as McpThreadInvocationScope,
                    task.id,
                    false,
                    true,
                    "thread-read-acknowledge",
                  );
                }
              }
            }
          }),
        );
        const now = yield* Clock.currentTimeMillis;
        return yield* ThreadReadMetrics.render(
          () =>
            ({
              thread: threadDetail(target, timeline.totalItems, shell, now),
              recentRuns: target.runs
                .toSorted((left, right) => right.ordinal - left.ordinal)
                .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
                .map(threadRun),
              items: page.map((row) =>
                timelineItem({
                  row,
                  maxChars,
                  messagesByThreadId,
                  ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
                }),
              ),
              nextPosition: page.at(-1)?.position ?? null,
              hasMore: timeline.hasMore,
            }) satisfies OrchestratorMcpThreadReadResult,
        );
      },
      (effect) => effect.pipe(NodeSqliteClient.foregroundReads),
    ),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      return yield* SendAcknowledgement.bounded(
        (clientRequestId) =>
          Effect.gen(function* () {
            const { parent, limits, target } = yield* SendAcknowledgement.waitingOn(
              loadScopedThread(scope, input.threadId),
              `target thread read for thread ${input.threadId}`,
            );
            yield* assertLiveCallerForOtherThread(scope, parent, target);
            yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
            yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

            const mode = input.mode ?? "auto";
            const key = yield* requestKey(clientRequestId);
            // Recover sends accepted by older builds before the caller's credential was rebound.
            const messages =
              scope.thread === undefined
                ? []
                : (yield* SendAcknowledgement.waitingOn(
                    threadManagement
                      .getThreadRecords(input.threadId, ["messages"], {
                        messageRoles: ["user"],
                        turnItemTypes: [],
                      })
                      .pipe(Effect.mapError(threadManagementFailure)),
                    `prior send read for thread ${input.threadId}`,
                  )).messages;
            const prior =
              scope.thread === undefined
                ? undefined
                : messages.find((message) => {
                    const parts = message.id.split(":");
                    return (
                      message.senderThreadId === scope.thread?.threadId &&
                      parts.length === 5 &&
                      parts[0] === "message" &&
                      parts[1] === "mcp" &&
                      parts[3] === "thread-send" &&
                      parts[4] === stablePart(key)
                    );
                  });
            const messageId =
              prior?.id ??
              stableOperationMessageId({
                scope,
                requestKey: key,
                operation: "thread-send",
              });
            const commandId =
              prior === undefined
                ? stableCommandId({ scope, requestKey: key, operation: "thread-send" })
                : CommandId.make(
                    `command:mcp:${prior.id.split(":")[2]}:thread-send:${stablePart(key)}`,
                  );
            const result = yield* SendAcknowledgement.waitingOn(
              threadManagement
                .sendToThread({
                  projectId: target.thread.projectId,
                  commandId,
                  threadId: input.threadId,
                  ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
                  messageId,
                  text: input.message,
                  attachments: [],
                  mode,
                  createdBy: "agent",
                  creationSource: "mcp",
                })
                .pipe(
                  Effect.mapError((error) =>
                    isThreadManagementError(error)
                      ? threadManagementFailure(error)
                      : failure(
                          "orchestration_error",
                          `Unable to send to thread ${input.threadId}: ${errorMessage(error)}`,
                        ),
                  ),
                ),
              `message dispatch for thread ${input.threadId}`,
            );
            // Delivery is the committed route, not provider acceptance. Claude's priority-next
            // steer may wait for a tool boundary; that wait must never hold the MCP reply.
            return {
              threadId: input.threadId,
              messageId,
              runId: result.run.id,
              ...(result.run.delegatedTaskId === undefined
                ? {}
                : { taskId: result.run.delegatedTaskId }),
              status: result.run.status,
              delivery: result.delivery,
            } satisfies OrchestratorMcpThreadSendResult;
          }),
        serviceScope,
        input.clientRequestId,
      ).pipe(Effect.provideService(Crypto.Crypto, crypto));
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const waitStartedAt = yield* Clock.monotonicTimeNanos;
      const call = yield* Effect.serviceOption(McpCallAnalytics.McpCall);
      if (Option.isSome(call)) call.value.waitStage = "lookup.caller";
      let snapshot: OrchestratorMcpThreadWaitResult | undefined;
      let snapshotRun: OrchestrationV2Run | null | undefined;
      let acceptedAttemptId: RunAttemptId | null | undefined;
      const waiting = Effect.gen(function* () {
        yield* loadCaller(scope);
        if (Option.isSome(call)) {
          call.value.waitStage = "lookup.target";
          call.value.readerLane = "foreground";
        }
        // This path needs one thread row and one run, never shell/history hydration.
        const records = yield* threadManagement
          .getThreadRecords(
            input.threadId,
            ["runs"],
            input.runId === undefined ? { latestRunOnly: true } : { runIds: [input.runId] },
            { projectionOnly: true },
          )
          .pipe(
            NodeSqliteClient.foregroundReads,
            Effect.mapError((cause) =>
              NodeSqliteClient.readerLaneFailure(cause) !== undefined
                ? failure(
                    "lookup_timeout",
                    `Robob could not acquire the foreground reader for thread ${input.threadId}. Nothing changed. Retry t3_thread_wait, or check the task with task_status.`,
                  )
                : cause._tag === "OrchestratorProjectionError" &&
                    isProjectionStoreThreadNotFoundError(cause.cause)
                  ? failure("thread_not_found", `Thread ${input.threadId} was not found.`)
                  : threadManagementFailure(cause),
            ),
          );
        if (records.thread.deletedAt !== null)
          return yield* failure("thread_not_found", `Thread ${input.threadId} was not found.`);
        const selected = records.runs[0];
        if (input.runId !== undefined && selected === undefined)
          return yield* failure(
            "run_not_found",
            `Run ${input.runId} was not found in thread ${input.threadId}.`,
          );
        snapshotRun = selected;
        snapshot = {
          threadId: input.threadId,
          runId: selected?.id ?? null,
          status: selected === undefined ? "idle" : runOutcome(selected),
          timedOut: true,
          ...startState(selected, []),
        };
        snapshot = { ...snapshot, ...(yield* readStartState(selected)) };
        if (selected != null && snapshot.startPending === false)
          acceptedAttemptId = selected.activeAttemptId;
        if (Option.isSome(call)) {
          call.value.waitLookupMs = Number((yield* Clock.monotonicTimeNanos) - waitStartedAt) / 1e6;
          call.value.waitStage = "waiting";
          // Event-driven waiting still uses background history and restart-continuation reads.
          call.value.readerLane = "background";
        }
        // Leave a bounded slice of the caller's budget for the final native-ACK read.
        const remaining = yield* remainingWaitMs(waitStartedAt, input.timeoutMs);
        const result = yield* threadManagement
          .waitForThread({
            projectId: records.thread.projectId,
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            timeoutMs: Math.max(1, remaining - Math.min(250, remaining / 4)),
          })
          .pipe(
            NodeSqliteClient.backgroundReads,
            Effect.catchIf(
              (cause) => NodeSqliteClient.readerLaneFailure(cause) !== undefined,
              () => Effect.succeed({ run: selected ?? null, timedOut: true }),
            ),
            Effect.mapError(threadManagementFailure),
          );
        snapshotRun = result.run;
        snapshot = {
          threadId: input.threadId,
          runId: result.run?.id ?? null,
          status: result.run === null ? "idle" : runOutcome(result.run),
          timedOut: result.timedOut,
          ...startState(result.run, []),
          ...(result.run != null && result.run.activeAttemptId === acceptedAttemptId
            ? { startPending: false, startProgress: null }
            : {}),
        } satisfies OrchestratorMcpThreadWaitResult;
        const finalState = yield* readStartState(result.run);
        return {
          ...snapshot,
          ...(snapshot.startPending === false
            ? { startPending: false, startProgress: null }
            : finalState),
        };
      });
      const result = yield* waiting.pipe(
        McpDeadline.awaitInterruptibly,
        Effect.timeoutOption(
          Duration.millis(yield* remainingWaitMs(waitStartedAt, input.timeoutMs)),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            if (Option.isSome(call) && call.value.waitLookupMs === undefined)
              call.value.waitLookupMs =
                Number((yield* Clock.monotonicTimeNanos) - waitStartedAt) / 1e6;
          }),
        ),
      );
      if (Option.isSome(result)) return result.value;
      return (
        (snapshot === undefined
          ? undefined
          : {
              ...snapshot,
              ...(snapshot.startPending
                ? { startProgress: startState(snapshotRun, []).startProgress }
                : {}),
            }) ??
        (yield* failure(
          "lookup_timeout",
          `Robob took longer than ${Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)) / 1000} s to read thread ${input.threadId}. Nothing changed. Retry t3_thread_wait, or check the task with task_status.`,
        ))
      );
    }, untilShutdown),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* requestKey(input.clientRequestId);
      const result = yield* threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ServerSettings.ServerSettingsService
> = Layer.effect(OrchestratorMcpService, make);
