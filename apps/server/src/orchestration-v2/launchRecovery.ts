import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

const models = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

export function isAutomaticClaudeRecovery(
  driver: string,
  run: Pick<
    OrchestrationV2Run,
    | "launchRecovery"
    | "transientRecovery"
    | "delegatedTaskStallRecovery"
    | "restartContinuationOfRunId"
  >,
) {
  return (
    driver === "claudeAgent" &&
    (run.launchRecovery !== undefined ||
      run.transientRecovery !== undefined ||
      run.delegatedTaskStallRecovery !== undefined ||
      run.restartContinuationOfRunId !== undefined)
  );
}

export function claudeRecoveryExcluded(failure: OrchestrationV2ProviderFailure) {
  return (
    failure.claudeAccess?.refusalFree !== true ||
    failure.claudeAccess.refused ||
    failure.category === "content_filter"
  );
}

export function nextClaudeFallbackModel(selection: ModelSelection): ModelSelection | undefined {
  const model = models[models.indexOf(selection.model) + 1];
  if (!models.includes(selection.model) || model === undefined) return undefined;
  return { instanceId: selection.instanceId, model, options: [{ id: "effort", value: "high" }] };
}

export function claudeRecoveryResult(run: OrchestrationV2Run | undefined, text: string | null) {
  if (run?.status !== "completed" || run.launchRecovery?.kind !== "model_access") return { text };
  const finishedOn = run.modelSelection.model;
  return { finishedOn, text: `${text ?? ""}\n\nfinishedOn: ${finishedOn}` };
}

// An accepted attempt may have performed actions. Only pending backoff can
// carry first-turn replay permission through a restart; reporting is retained.
export function continuedLaunchRecovery(
  source: OrchestrationV2Run | undefined,
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
) {
  if (source?.launchRecovery === undefined) return undefined;
  return {
    ...source.launchRecovery,
    replayAllowed:
      source.launchRecovery.replayAllowed !== false &&
      !turns.some((turn) => turn.runAttemptId === source.activeAttemptId),
  };
}

export function launchRecoveryDelayMs(run: OrchestrationV2Run, nowMs: number) {
  const recovery = run.launchRecovery;
  return recovery === undefined
    ? 0
    : Math.max(0, Date.parse(recovery.since) + recovery.delayMs - nowMs);
}

// Only native status evidence authorizes a replay. Claude's synthetic model_not_found
// also represents refusals and must never be used as the discriminator.
export function nextLaunchRecovery(input: {
  thread: OrchestrationV2AppThread;
  run: OrchestrationV2Run;
  failure: OrchestrationV2ProviderFailure;
  driver: string;
  automated: boolean;
  text: string;
  jitter: number;
}) {
  const { run, failure } = input;
  const evidence = failure.claudeAccess;
  if (
    input.driver !== "claudeAgent" ||
    claudeRecoveryExcluded(failure) ||
    evidence?.beforeResponse !== true ||
    failure.category === "context_exhausted" ||
    run.transientRecovery !== undefined ||
    run.delegatedTaskStallRecovery !== undefined ||
    run.launchRecovery?.replayAllowed === false ||
    input.thread.archivedAt !== null ||
    input.thread.deletedAt !== null
  )
    return undefined;
  const access =
    evidence?.status === 401 ||
    evidence?.status === 403 ||
    evidence?.status === 404 ||
    evidence?.status === 429;
  const delegated =
    run.delegatedTaskId !== undefined &&
    (run.ordinal === 1 ||
      (run.launchRecovery?.kind === "model_access" && run.launchRecovery.replayAllowed === true)) &&
    input.thread.lineage?.relationshipToParent === "subagent";
  const relay =
    input.automated &&
    /(?:\bplease relay\b|\[Watcher event\b)/i.test(input.text) &&
    (access || failure.category === "transient");
  if (relay && failure.retryable === false) return undefined;
  const index = models.indexOf(run.modelSelection.model);
  const kind: "model_access" | "relay" | undefined = relay
    ? "relay"
    : delegated && access && index >= 0
      ? "model_access"
      : undefined;
  if (kind === undefined || (run.launchRecovery !== undefined && run.launchRecovery.kind !== kind))
    return undefined;
  if (kind === "relay" && run.launchRecovery !== undefined) return undefined;
  let modelSelection: ModelSelection = run.modelSelection;
  let retriesOnModel = (run.launchRecovery?.retriesOnModel ?? 0) + 1;
  let fresh = false;
  if (kind === "model_access" && retriesOnModel > 1) {
    const next = nextClaudeFallbackModel(run.modelSelection);
    if (next === undefined) return undefined;
    modelSelection = next;
    retriesOnModel = 0;
    fresh = true;
  }
  return {
    modelSelection,
    fresh,
    recovery: {
      kind,
      replayAllowed: true,
      retriesOnModel,
      attempt: (run.launchRecovery?.attempt ?? 0) + 1,
      delayMs: 20_000 + Math.floor(Math.max(0, Math.min(1, input.jitter)) * 20_000),
    },
  };
}
