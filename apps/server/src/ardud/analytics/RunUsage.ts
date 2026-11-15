import type {
  KanbanThreadLink,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ModelSelection,
  RunUsageEvent,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as KanbanStore from "../kanban/store/KanbanStore.ts";
import * as Analytics from "./Analytics.ts";
type Attribution = {
  readonly link: KanbanThreadLink | null;
  readonly reviewRound: number | null;
} | null;

export interface RunUsageInput {
  readonly run: Pick<
    OrchestrationV2Run,
    "id" | "threadId" | "startedAt" | "providerInstanceId" | "delegatedTaskId"
  >;
  readonly attempt: Pick<OrchestrationV2RunAttempt, "id">;
  readonly appThread: Pick<OrchestrationV2AppThread, "lineage">;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id">;
  readonly modelSelection: ModelSelection;
}
export const makeRunUsageState = () => ({
  turns: new Map<string, OrchestrationV2ProviderTurn>(),
  finished: false,
  attribution: undefined as Effect.Effect<Attribution> | undefined,
  model: undefined as string | undefined,
  mixedModels: false,
  startedAt: undefined as DateTime.Utc | null | undefined,
});

export const makeRunUsageObserver = Effect.fn("RunUsage.observeRun")(function* (
  input: RunUsageInput,
  state = makeRunUsageState(),
) {
  if (state.startedAt === undefined) state.startedAt = input.run.startedAt;
  const analytics = yield* Effect.serviceOption(Analytics.Analytics);
  const kanban = yield* Effect.serviceOption(KanbanStore.KanbanStore);
  if (Option.isSome(kanban) && input.appThread.lineage?.relationshipToParent === "subagent") {
    const parent = input.appThread.lineage.parentThreadId ?? input.appThread.lineage.rootThreadId;
    kanban.value.registerCallerParent?.(input.run.threadId, parent);
  }
  // Snapshot attribution before a worker hands its card off or a review round advances.
  const attribution: Effect.Effect<Attribution> =
    state.attribution ??
    (yield* Effect.cached(
      Effect.gen(function* () {
        if (Option.isNone(kanban)) return null;
        let link: KanbanThreadLink | null = yield* kanban.value.threadLink(input.run.threadId);
        if (link === null && input.appThread.lineage?.relationshipToParent === "subagent")
          link =
            input.appThread.lineage.parentThreadId === null
              ? null
              : yield* kanban.value.threadLink(input.appThread.lineage.parentThreadId);
        if (link === null && input.appThread.lineage?.relationshipToParent === "subagent")
          link = yield* kanban.value.threadLink(input.appThread.lineage.rootThreadId);
        const card =
          link?.role === "review" && link.cardId ? yield* kanban.value.card(link.cardId) : null;
        return { link, reviewRound: link?.role === "review" ? (card?.reviewRound ?? null) : null };
      }).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.map(Option.getOrNull),
        Effect.catchCause(() => Effect.succeed(null)),
      ),
    ));
  state.attribution = attribution;
  state.mixedModels ||= state.model !== undefined && state.model !== input.modelSelection.model;
  state.model ??= input.modelSelection.model;
  yield* attribution.pipe(Effect.forkDetach);

  // The provider consumer already owns a span; per-event spans would swamp the log.
  const observe = Effect.fnUntraced(function* (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ): Effect.fn.Return<void> {
    yield* Effect.sync(() => {
      if (
        event.type === "provider_turn.updated" &&
        event.providerTurn.providerThreadId === input.providerThread.id &&
        event.providerTurn.runAttemptId === input.attempt.id
      )
        state.turns.set(event.providerTurn.id, event.providerTurn);
    });
  });
  // Cleanup can interrupt the provider reader; finish its bounded attribution and enqueue together.
  const finish = Effect.fn("RunUsage.finish")(function* (
    status: RunUsageEvent["endReason"],
  ): Effect.fn.Return<void> {
    if (state.finished || Option.isNone(analytics)) return;
    state.finished = true;
    const now = yield* DateTime.now;
    const context = yield* attribution;
    const link = context?.link;
    const turns = [...state.turns.values()];
    const usage = turns.map((turn) => turn.turnTokenUsage);
    const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens") => {
      const known = usage.flatMap((row) => (row?.[key] === undefined ? [] : [row[key]!]));
      return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
    };
    const role =
      input.run.delegatedTaskId !== undefined ||
      input.appThread.lineage?.relationshipToParent === "subagent"
        ? "delegated"
        : link?.discussionId !== null && link?.discussionId !== undefined
          ? "discussion"
          : (link?.role ?? "chat");
    const selectedEffort = input.modelSelection.options?.find((option) =>
      ["reasoningEffort", "effort", "variant"].includes(option.id),
    )?.value;
    const event: RunUsageEvent = {
      ts: DateTime.formatIso(now),
      kind: "run.usage",
      surface: "server",
      route: "provider",
      runId: input.run.id,
      threadId: input.run.threadId,
      ...(link ? { boardId: link.boardId, ...(link.cardId ? { cardId: link.cardId } : {}) } : {}),
      role,
      providerInstance: input.run.providerInstanceId,
      // A retry may reroute models. Keep its combined counts out of a single model's totals.
      model: state.mixedModels ? "__mixed__" : input.modelSelection.model,
      effort: !state.mixedModels && typeof selectedEffort === "string" ? selectedEffort : null,
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cachedInputTokens: sum("cachedInputTokens"),
      reasoningTokens: sum("reasoningTokens"),
      wallMs:
        state.startedAt == null
          ? null
          : Math.max(0, DateTime.toEpochMillis(now) - DateTime.toEpochMillis(state.startedAt)),
      // Provider turns, including retry attempts, rather than inferred model response counts.
      turnCount: turns.length,
      endReason: status,
      usageStatus:
        usage.length > 0 && usage.every((row) => row?.usageStatus === "complete")
          ? "complete"
          : usage.some((row) => row !== undefined && row.usageStatus !== "unavailable")
            ? "partial"
            : "unavailable",
      reviewRound: role === "review" ? (context?.reviewRound ?? null) : null,
    };
    yield* analytics.value.record(event);
  }, Effect.uninterruptible);
  return { observe, finish };
});
