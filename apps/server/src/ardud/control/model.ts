/**
 * Pure mapping between t3 projections and the control API's wire shapes.
 * No services here, so it is cheap to unit test.
 */
import type {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProviderOptionSelection,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  mergeSelection,
  resolveSelection,
  selectionEffort,
} from "@t3tools/client-runtime/ardud/models/harnessRouting";
import { modelProblem } from "../kanban/engine/modelCheck.ts";

/**
 * The coarse state external callers act on:
 * - `running`: a turn is in progress (or starting/preparing);
 * - `needs-input`: the turn is blocked on an approval or a question;
 * - `waiting`: the agent's turn ended but background work (subagents, shells)
 *   is still draining and may wake it again;
 * - `queued`: only queued messages, nothing running;
 * - `idle`: nothing in flight.
 */
export type ControlThreadState = "idle" | "running" | "waiting" | "needs-input" | "queued";

export const ACTIVE_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
]);
export const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export function stateFromRunStatus(
  status: OrchestrationV2Run["status"] | "idle" | null | undefined,
  hasPendingRequest: boolean,
): ControlThreadState {
  if (hasPendingRequest) return "needs-input";
  switch (status) {
    case "preparing":
    case "starting":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "queued":
      return "queued";
    default:
      return "idle";
  }
}

export function stateFromShell(shell: OrchestrationV2ThreadShell): ControlThreadState {
  return stateFromRunStatus(
    shell.activityRunStatus ?? shell.status,
    shell.pendingRuntimeRequest !== null,
  );
}

/** Runs ordered newest first. */
export function runsNewestFirst(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  return runs.toSorted((left, right) => right.ordinal - left.ordinal);
}

export function stateFromRuns(
  runs: ReadonlyArray<OrchestrationV2Run>,
  hasPendingRequest: boolean,
): { readonly state: ControlThreadState; readonly run: OrchestrationV2Run | null } {
  const ordered = runsNewestFirst(runs);
  const active = ordered.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  const waiting = ordered.find((run) => run.status === "waiting");
  const queued = ordered.find((run) => run.status === "queued");
  const run = active ?? waiting ?? queued ?? ordered[0] ?? null;
  return { state: stateFromRunStatus(run?.status ?? null, hasPendingRequest), run };
}

const iso = (value: DateTime.DateTime | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

export function runSummary(run: OrchestrationV2Run) {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    model: formatModel(run.modelSelection),
    requestedAt: iso(run.requestedAt),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
  };
}

/** `provider/model` with `variant` split out, matching how OpenChamber callers name models. */
export function formatModel(selection: ModelSelection) {
  const variant = selection.options?.find((option) => option.id === "variant")?.value;
  const effort = selectionEffort(selection);
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    options: selection.options ?? [],
    ...(typeof variant === "string" ? { variant } : {}),
    ...(effort !== null ? { effort } : {}),
  };
}

/**
 * Off and dry-run keep the old variant behavior. Apply canonicalizes both sides
 * before merging so an explicit canonical model inherits only its own options.
 */
export function modelSelectionFrom(input: {
  readonly model?: string | undefined;
  readonly variant?: string | null | undefined;
  readonly instanceId?: string | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly base: ModelSelection;
  readonly settings?: Pick<ServerSettings, "ardudHarnessMigration"> | undefined;
}):
  | { readonly kind: "selection"; readonly selection: ModelSelection }
  | { readonly kind: "conflict"; readonly reason: string } {
  const duplicate = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    const seen = new Set<string>();
    return options?.find((option) => {
      if (seen.has(option.id)) return true;
      seen.add(option.id);
      return false;
    });
  };
  const duplicatePatch = duplicate(input.options);
  if (duplicatePatch && selectionMigrationApplies(input.settings)) {
    return {
      kind: "conflict",
      reason: `Option ${duplicatePatch.id} was specified more than once.`,
    };
  }
  if (!selectionMigrationApplies(input.settings)) {
    const instanceId = (input.instanceId ?? input.base.instanceId) as ModelSelection["instanceId"];
    const model = input.model ?? input.base.model;
    const same = instanceId === input.base.instanceId && model === input.base.model;
    const source = input.options ?? (same ? (input.base.options ?? []) : []);
    const kept = source.filter((option) => option.id !== "variant");
    const oldVariant = source.find((option) => option.id === "variant");
    const variant =
      input.variant === null
        ? undefined
        : input.variant !== undefined
          ? { id: "variant", value: input.variant }
          : oldVariant;
    const options = variant === undefined ? kept : [...kept, variant];
    return {
      kind: "selection",
      selection: {
        instanceId,
        model,
        ...(options.length > 0 ? { options } : {}),
      } as ModelSelection,
    };
  }

  const duplicateBase = duplicate(input.base.options);
  if (duplicateBase) {
    return { kind: "conflict", reason: `Stored option ${duplicateBase.id} occurs more than once.` };
  }
  const foldedBase = mergeSelection(input.base, {});
  if (foldedBase.kind === "conflict") return foldedBase;
  const routedBase = resolveSelection(foldedBase.selection);
  if (routedBase.kind === "conflict") return routedBase;
  if (routedBase.kind === "mapped") {
    const dropped = foldedBase.selection.options?.find(
      (option) =>
        option.id !== "variant" &&
        !routedBase.selection.options?.some((carried) => carried.id === option.id),
    );
    if (dropped !== undefined) {
      return {
        kind: "conflict",
        reason: `Cannot map stored option ${dropped.id} from ${input.base.model} without dropping it.`,
      };
    }
  }
  const base = routedBase.selection;

  // Old callers may send an OpenCode slug after the thread has moved to a
  // native provider. Only infer OpenCode for an exact route in the shared map.
  const legacyTarget =
    input.model !== undefined && input.instanceId === undefined
      ? resolveSelection({ instanceId: "opencode", model: input.model } as ModelSelection)
      : undefined;
  if (legacyTarget?.kind === "conflict") return legacyTarget;
  const target =
    legacyTarget?.kind === "mapped"
      ? legacyTarget
      : input.model === undefined && input.instanceId === undefined
        ? { kind: "unchanged" as const, selection: base }
        : resolveSelection({
            instanceId: input.instanceId ?? base.instanceId,
            model:
              input.model ??
              (input.instanceId === input.base.instanceId ? input.base.model : base.model),
          } as ModelSelection);
  if (target.kind === "conflict") return target;
  const suffix = target.kind === "mapped" ? target.effort : null;
  if (
    suffix !== null &&
    (input.variant === null || (input.variant !== undefined && input.variant !== suffix))
  ) {
    return { kind: "conflict", reason: `${input.model} names conflicting efforts.` };
  }
  return mergeSelection(base, {
    instanceId: target.selection.instanceId,
    model: target.selection.model,
    ...(input.options === undefined ? {} : { options: input.options }),
    variant: suffix ?? input.variant,
  });
}

export const selectionMigrationApplies = (
  settings: Pick<ServerSettings, "ardudHarnessMigration"> | undefined,
) => settings?.ardudHarnessMigration?.selections === "apply";

/** Fail closed when a selected option cannot be checked against the current catalog. */
export function selectionProblem(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string | null {
  const problem = modelProblem(providers, selection);
  if (problem !== null) return problem;
  if ((selection.options?.length ?? 0) === 0) return null;
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  if (model?.capabilities?.optionDescriptors === undefined) {
    return `Options for ${selection.model} on ${selection.instanceId} cannot be checked against the provider catalog.`;
  }
  return null;
}

export function pendingRequestSummary(
  request: OrchestrationV2RuntimeRequest,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const item = items.find(
    (candidate) =>
      (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
      candidate.requestId === request.id,
  );
  const base = {
    requestId: request.id,
    kind: request.kind === "user_input" ? ("question" as const) : ("approval" as const),
    requestKind: request.kind,
    status: request.status,
    createdAt: iso(request.createdAt),
    canRespond: request.responseCapability.type !== "not_resumable",
  };
  if (item?.type === "approval_request") {
    return {
      ...base,
      prompt: item.prompt ?? null,
      title: item.title,
      options: item.options ?? null,
    };
  }
  if (item?.type === "user_input_request") {
    return { ...base, title: item.title, questions: item.questions };
  }
  return base;
}

export function messageSummary(message: OrchestrationV2ConversationMessage) {
  return {
    messageId: message.id,
    runId: message.runId,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    createdBy: message.createdBy,
    creationSource: message.creationSource,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
    })),
    createdAt: iso(message.createdAt),
    updatedAt: iso(message.updatedAt),
  };
}

/**
 * The visible answer of a run: its newest non-empty assistant message, or its
 * last error when the run failed. Reasoning and tool output never count.
 */
export function lastAssistantText(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  runId?: string | null,
): { readonly text: string; readonly messageId: string; readonly runId: string | null } | null {
  const candidates = messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.text.trim().length > 0 &&
        (runId === undefined || runId === null || message.runId === runId),
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  const latest = candidates[0];
  return latest === undefined
    ? null
    : { text: latest.text.trim(), messageId: latest.id, runId: latest.runId };
}

/** Parses an ISO timestamp or epoch milliseconds; undefined for anything else. */
export function parseSince(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function shellSummary(
  shell: OrchestrationV2ThreadShell,
  extra: { readonly origin: string | null; readonly nativeSessionId: string | null },
) {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    state: stateFromShell(shell),
    status: shell.activityRunStatus ?? shell.status,
    origin: extra.origin,
    nativeSessionId: extra.nativeSessionId,
    model: formatModel(shell.modelSelection),
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    parentThreadId: shell.lineage.parentThreadId,
    rootThreadId: shell.lineage.rootThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    worktreePath: shell.worktreePath,
    branch: shell.branch,
    latestRunId: shell.latestRunId,
    activeRunId: shell.activeRunId,
    pendingRequest:
      shell.pendingRuntimeRequest === null
        ? null
        : {
            requestId: shell.pendingRuntimeRequest.id,
            kind:
              shell.pendingRuntimeRequest.kind === "user_input"
                ? ("question" as const)
                : ("approval" as const),
            requestKind: shell.pendingRuntimeRequest.kind,
            createdAt: iso(shell.pendingRuntimeRequest.createdAt),
          },
    latestMessage:
      shell.latestVisibleMessage === null
        ? null
        : {
            messageId: shell.latestVisibleMessage.id,
            role: shell.latestVisibleMessage.role,
            text: shell.latestVisibleMessage.text,
            updatedAt: iso(shell.latestVisibleMessage.updatedAt),
          },
    lastError: shell.lastError ?? null,
    archived: shell.archivedAt !== null,
    settled: shell.settledOverride === "settled",
    createdAt: iso(shell.createdAt),
    updatedAt: iso(shell.updatedAt),
  };
}

export type ControlThreadSummary = ReturnType<typeof shellSummary>;
