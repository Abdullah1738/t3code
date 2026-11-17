import type { McpDenyReason } from "@t3tools/contracts";
import {
  KANBAN_AGING_MAX_STEPS,
  KANBAN_AGING_STEP_MS,
  KANBAN_BACKLOG,
  KANBAN_BOOST_FLOOR,
  KANBAN_DONE_STAGES,
  KANBAN_FANOUT_STEPS,
  KANBAN_THREAD_STAGES,
  kanbanCardFlow,
  kanbanCardModels,
  kanbanHeldUpBy,
  kanbanBoardClock,
  kanbanPickOrder,
  kanbanSchedule,
  kanbanScriptStep,
  kanbanDeciding,
  kanbanWaiting,
  kanbanWaitStale,
  kanbanWaitsOnEvaluator,
  kanbanStepSubtasks,
  kanbanWaitExpired,
  type KanbanOwnerAsk,
  kanbanReviewAlreadyDone,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardEvent,
  type KanbanScheduleCard,
  type KanbanDiscussion,
  type KanbanGroup,
  type KanbanPool,
  type KanbanStage,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { selectionEffort } from "@t3tools/client-runtime/ardud/models/harnessRouting";
import { releaseWindow } from "./subtasks.ts";
import { heldForRetry, NO_VERDICT_REASON, REFUSED_VERDICT_PREFIX } from "./retries.ts";

/**
 * Who is asking for a move. `cardThread` is the card's own work or review thread.
 * `script` is a board script, from its output.
 */
export type MoveRole = "owner" | "evaluator" | "cardThread" | "dispatcher" | "system" | "script";

export type MoveCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly denyReason?: McpDenyReason };

/** A model's reasoning level (its effort option for its driver), or null. */
export const modelLevel = (model: ModelSelection): string | null => selectionEffort(model);

/** One key per model, whatever its level: outages and the composer's list are per model. */
export const modelKey = (model: ModelSelection): string => `${model.instanceId}/${model.model}`;

/** A pool runs one model at one level: `instance/model#level`, or `instance/model` with no level. */
export const poolKey = (model: ModelSelection): string => {
  const level = modelLevel(model);
  return level === null ? modelKey(model) : `${modelKey(model)}#${level}`;
};

/**
 * The pool a model runs on. A named level is exact, for every driver: its own pool, or none.
 * Another level's pool never runs it (max on an xhigh-only pool would have its options
 * replaced by xhigh). Only a model with no level takes the first pool of its model.
 */
export function poolFor(
  pools: ReadonlyArray<KanbanPool>,
  model: ModelSelection,
): KanbanPool | undefined {
  const key = poolKey(model);
  // Compared by each pool's model, not its stored key, so a pool not yet rekeyed still matches.
  const exact = pools.find((pool) => poolKey(pool.model) === key);
  if (exact !== undefined) return exact;
  if (modelLevel(model) !== null) return undefined;
  const base = modelKey(model);
  return pools.find((pool) => modelKey(pool.model) === base);
}

/**
 * The pool an alias names. An alias is written without its instance, or with a short name,
 * so it is matched to the pool model it means: a short name is unambiguous when its pools all
 * belong to one model (one key per level is still one model). The level rule is poolFor's:
 * a named level is exact, for every driver.
 */
export function aliasPool(
  pools: ReadonlyArray<KanbanPool>,
  model: ModelSelection,
): KanbanPool | undefined {
  const joined = `${model.instanceId}/${model.model}`;
  const byName = pools.filter(
    (pool) => pool.model.model === joined || pool.model.model === model.model,
  );
  const bySuffix = pools.filter((pool) => pool.model.model.endsWith(`/${model.model}`));
  const suffixModels = new Set(bySuffix.map((pool) => modelKey(pool.model)));
  const same = byName.length > 0 ? byName : suffixModels.size === 1 ? bySuffix : [];
  const [first] = same;
  if (first === undefined) return undefined;
  const level = modelLevel(model);
  if (level === null) return first;
  return same.find((pool) => modelLevel(pool.model) === level);
}

export const isDone = (stage: KanbanStage) => KANBAN_DONE_STAGES.has(stage);

const ok: MoveCheck = { ok: true };
const no = (reason: string, denyReason: McpDenyReason = "transition_not_allowed"): MoveCheck => ({
  ok: false,
  reason,
  ...(denyReason === undefined ? {} : { denyReason }),
});

/**
 * Only the dispatcher puts a card into a thread stage, because that is the
 * moment a pool slot is taken. Everyone else moves cards between the quiet
 * stages, and a move out of a thread stage frees the slot.
 */
export function checkMove(role: MoveRole, card: KanbanCard, to: KanbanStage): MoveCheck {
  const from = card.stage;
  if (from === to) return no(`card is already in ${to}`, "stage_unchanged");
  if (
    KANBAN_THREAD_STAGES.includes(to) &&
    role !== "dispatcher" &&
    !(
      role === "system" &&
      from === "needs_review" &&
      to === "in_review" &&
      card.activeThreadId === null
    )
  ) {
    return no(
      `only the dispatcher moves a card into ${to}; move it to todo or needs_review`,
      "stage_owned_by_dispatcher",
    );
  }
  switch (role) {
    case "dispatcher":
      if (from === "todo" && to === "working") return ok;
      if (from === "needs_review" && to === "in_review") return ok;
      return no(`dispatcher cannot move ${from} -> ${to}`);
    case "cardThread":
      if (from === "working" && (to === "needs_review" || to === "needs_owner")) return ok;
      if (from === "todo" && card.activeThreadId === null && to === "needs_owner") return ok;
      if (
        (from === "todo" || from === "in_review" || from === "completed") &&
        card.activeThreadId === null &&
        to === "needs_review"
      )
        return ok;
      return no(
        `a card thread can move working -> needs_review or needs_owner, not ${from} -> ${to}`,
      );
    case "system":
      // A finished review can wait in in_review for its PRs without taking a thread slot.
      if (from === "needs_review" && to === "in_review" && card.activeThreadId === null) return ok;
      if (
        (from === "in_review" || from === "needs_review") &&
        (to === "todo" || to === "completed")
      )
        return ok;
      return no(`system cannot move ${from} -> ${to}`);
    case "script":
      if (card.settledAt !== null) return no("card is settled", "card_settled");
      if (KANBAN_THREAD_STAGES.includes(from)) {
        return no(`a script doesn't move a card a thread has (${from})`);
      }
      if (!(to === "completed" || to === "deployed" || to === "verified")) {
        return no(`a script moves a card only to completed, deployed or verified, not ${to}`);
      }
      return ok;
    case "evaluator":
    case "owner":
      if (card.settledAt !== null) return no("card is settled", "card_settled");
      return ok;
  }
}

export interface ReviewOutcome {
  readonly stage: KanbanStage;
  readonly reviewStep: number;
  readonly reviewRound: number;
  /** True when the same review thread should keep going with the next chain step. */
  readonly continueReview: boolean;
}

/**
 * Findings at any step send the card back for a fix and restart the chain.
 * Clear moves to the next step on the same review thread; after the last
 * step the card waits in review until its PRs land (see `prsLanded`).
 */
export function applyReviewResult(
  card: KanbanCard,
  chainLength: number,
  verdict: "clear" | "findings",
): ReviewOutcome {
  if (verdict === "findings") {
    return {
      stage: "todo",
      reviewStep: 0,
      reviewRound: card.reviewRound + 1,
      continueReview: false,
    };
  }
  const next = card.reviewStep + 1;
  if (next < chainLength) {
    return {
      stage: "in_review",
      reviewStep: next,
      reviewRound: card.reviewRound,
      continueReview: true,
    };
  }
  if (prsLanded(card)) {
    return {
      stage: "completed",
      reviewStep: next,
      reviewRound: card.reviewRound,
      continueReview: false,
    };
  }
  return {
    stage: "in_review",
    reviewStep: next,
    reviewRound: card.reviewRound,
    continueReview: false,
  };
}

export const reviewFinished = (card: KanbanCard, chainLength: number) =>
  card.reviewStep >= Math.max(chainLength, 1);

export const IDLE_EVALUATOR_HOURS = 6;

export const isNotice = (ask: Pick<KanbanOwnerAsk, "kind">) => ask.kind === "notice";

export type IdleEvaluatorBoard = Pick<KanbanBoard, "id" | "standingApprovals" | "releaseLedger"> & {
  readonly nextReleaseWindowAt?: string | null;
  readonly nextReleaseWindowByService?: Readonly<Record<string, string>>;
};

export const idleEvaluatorStall = (
  card: KanbanCard & { readonly lastEventAt?: string },
  nowMs: number,
  board: IdleEvaluatorBoard,
): {
  step: number;
  openEvaluatorSubtasks: string[];
  idleSinceAt: string;
  reason: string;
} | null => {
  if (
    card.settledAt !== null ||
    (card.stage !== "completed" && card.stage !== "deployed") ||
    card.stalled !== null ||
    (kanbanWaiting(card) &&
      card.wait !== undefined &&
      !kanbanWaitExpired(card.wait, nowMs) &&
      !(
        card.wait.on === "time" &&
        card.wait.until !== null &&
        Date.parse(card.wait.until) <= nowMs
      )) ||
    card.asks.some((ask) => ask.closedAt === null && ask.to !== "evaluator" && !isNotice(ask)) ||
    !kanbanWaitsOnEvaluator({ ...card, stage: "todo" })
  )
    return null;
  const open = kanbanStepSubtasks(card);
  if (open.length === 0 || open.some((subtask) => subtask.owner !== "evaluator")) return null;
  const localWindow = releaseWindow({
    approvals: board.standingApprovals,
    ledger: board.releaseLedger ?? [],
    boardId: board.id,
    at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  });
  if (
    open.some((subtask) => {
      if (!subtask.interrupting) return false;
      const next =
        subtask.service === undefined
          ? (board.nextReleaseWindowAt ?? localWindow?.next)
          : (board.nextReleaseWindowByService?.[subtask.service] ??
            releaseWindow(
              {
                approvals: board.standingApprovals,
                ledger: board.releaseLedger ?? [],
                boardId: board.id,
                at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
              },
              subtask.service,
            )?.next);
      return next !== undefined && next !== null && Date.parse(next) > nowMs;
    })
  ) {
    // An interrupting release legitimately parks the step until its pacing window opens.
    return null;
  }
  // Callers supply the latest stored event, including events outside the activity window.
  const idleSinceAt = card.lastEventAt ?? card.updatedAt;
  if (!(nowMs - Date.parse(idleSinceAt) >= IDLE_EVALUATOR_HOURS * 60 * 60_000)) return null;
  const ids = open.map((subtask) => subtask.id);
  return {
    step: open[0]!.step,
    openEvaluatorSubtasks: ids,
    idleSinceAt,
    reason: `Idle evaluator step ${ids.join(", ")}`,
  };
};

const REVIEW_EVALUATOR_WAKE_MS = 6 * 60 * 60_000;

/** All remaining steps, including later ones, must belong to the evaluator or scripts. */
export const inReviewEvaluatorStepsOnly = (card: KanbanCard) => {
  const open = card.subtasks.filter((subtask) => subtask.state === "open");
  return (
    card.stage === "in_review" &&
    card.activeThreadId === null &&
    card.settledAt === null &&
    card.stalled === null &&
    card.priority !== KANBAN_BACKLOG &&
    card.reviewStep > 0 &&
    card.reviewFindingsPending !== true &&
    !kanbanWaiting(card) &&
    !kanbanDeciding(card) &&
    !card.asks.some((ask) => ask.closedAt === null && ask.blocking) &&
    open.length > 0 &&
    open.every((subtask) => subtask.owner === "evaluator" || subtask.owner === "script")
  );
};

export const reviewEvaluatorWakeDue = (card: KanbanCard, chainLength: number, nowMs: number) =>
  inReviewEvaluatorStepsOnly(card) &&
  reviewFinished(card, chainLength) &&
  (card.nudgedAt === null || nowMs - Date.parse(card.nudgedAt) >= REVIEW_EVALUATOR_WAKE_MS);

/** A queued review keeps its thread identity, including between chain steps. */
export const reviewThreadToReuse = (board: KanbanBoard, card: KanbanCard) =>
  card.settledAt === null &&
  card.stage === "needs_review" &&
  !reviewFinished(card, chainFor(board, card)?.steps.length ?? 1)
    ? card.reviewThreadId
    : null;

/** Why a card can't be completed or deployed yet, or null. */
export function reviewGate(card: KanbanCard, chainLength: number): string | null {
  const open = card.subtasks.filter((s) => s.owner === "review" && s.state === "open");
  if (open.length > 0)
    return `card #${card.number} still has review subtask ${open.map((s) => s.id).join(", ")} open: it closes when its review passes`;
  if (!reviewFinished(card, chainLength))
    return `card #${card.number} hasn't passed its review: move it to needs_review`;
  return null;
}

/**
 * Every PR the work thread linked is merged or closed. Only those get a state
 * (syncPrs); a PR link without one is context and holds nothing. A card with
 * no PR has nothing to wait for.
 */
export function prsLanded(card: KanbanCard): boolean {
  return card.links
    .filter((link) => link.kind === "pr" && link.state !== null)
    .every((link) => link.state === "merged" || link.state === "closed");
}

export const DISCUSSION_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * A discussion settles itself after a quiet day unless it is pinned, snoozed, being replied to, or its card is still open.
 * The caller checks threads.
 */
export function discussionSettleDue(
  discussion: KanbanDiscussion,
  card: KanbanCard | null,
  nowMs: number,
): boolean {
  if (discussion.archivedAt !== null || discussion.settledAt !== null) return false;
  if (discussion.pinnedAt !== null) return false;
  if (discussion.snoozedUntil !== null && Date.parse(discussion.snoozedUntil) > nowMs) return false;
  if (discussion.participants.some((participant) => participant.typingUntil !== null)) return false;
  if (card !== null && card.stage !== "verified") return false;
  const quietSince = Math.max(
    Date.parse(discussion.lastMessageAt ?? discussion.createdAt),
    discussion.reopenedAt === null ? 0 : Date.parse(discussion.reopenedAt),
    discussion.snoozedUntil === null ? 0 : Date.parse(discussion.snoozedUntil),
  );
  return nowMs - quietSince >= DISCUSSION_IDLE_MS;
}

export const WORKER_QUIET_MS = 30 * 60 * 1000;

export const WORKER_NUDGE_EVENT = "Work thread handoff nudge attempted";

export function workerHandoffNudged(
  card: KanbanCard,
  events: ReadonlyArray<KanbanCardEvent>,
): boolean {
  const nudgedAt = card.nudgedAt;
  if (nudgedAt === null) return false;
  const since = Date.parse(nudgedAt);
  // Interrupts share nudgedAt with handoff reminders. Event order distinguishes
  // a reminder sent after an interrupt even when both have the same timestamp.
  const latest = events.findLast(
    (event) =>
      event.kind === "thread" &&
      event.actor._tag === "system" &&
      event.actor.component === "dispatcher" &&
      Date.parse(event.at) >= since &&
      (event.body === WORKER_NUDGE_EVENT ||
        event.body === "Interrupted: stuck on its own question" ||
        event.body?.startsWith("No activity for ")),
  );
  return latest === undefined || latest.body === WORKER_NUDGE_EVENT;
}

export function workerWorkDone(card: KanbanCard): boolean {
  const work = card.subtasks.filter((subtask) => subtask.owner === "work");
  return (
    work.length > 0 &&
    work.every((subtask) => subtask.state !== "open") &&
    card.reviewFindingsPending !== true
  );
}

export const RUN_SILENT_MS = 30 * 60 * 1000;

export function runSilentDue(
  card: KanbanCard,
  view: {
    readonly state: string;
    readonly lastActivityAt: string | null;
    readonly backgroundWork: number;
  },
  nowMs: number,
): boolean {
  const eligible =
    card.activeThreadId === null
      ? card.stage === "todo" || card.stage === "needs_review"
      : (card.stage === "working" && card.activeRole === "work") ||
        (card.stage === "in_review" && card.activeRole === "review");
  if (
    !eligible ||
    card.stalled !== null ||
    view.state !== "running" ||
    view.backgroundWork !== 0 ||
    view.lastActivityAt === null
  )
    return false;
  return (
    nowMs -
      Math.max(
        Date.parse(view.lastActivityAt),
        card.nudgedAt === null ? 0 : Date.parse(card.nudgedAt),
      ) >=
    RUN_SILENT_MS
  );
}

/** The worker saved this wait while it still owned the card. */
export const workerWaitDeferred = (card: KanbanCard): boolean =>
  card.stage === "working" &&
  card.activeRole === "work" &&
  card.activeThreadId !== null &&
  card.activeThreadId === card.workThreadId &&
  card.wait?.by._tag === "thread" &&
  card.wait.by.threadId === card.workThreadId &&
  !kanbanWaitStale(card);

/** A Working card whose worker sat idle, or stuck on its own question, for WORKER_QUIET_MS. */
export function workerQuietDue(
  card: KanbanCard,
  view: { readonly state: string; readonly quietSince: string },
  nowMs: number,
): boolean {
  if (card.stage !== "working" || card.activeRole !== "work" || card.stalled !== null) return false;
  if (
    (card.wait !== undefined && !workerWaitDeferred(card)) ||
    card.asks.some((ask) => ask.closedAt === null && ask.blocking)
  )
    return false;
  if (view.state !== "idle" && view.state !== "needs-input") return false;
  const since = Math.max(
    Date.parse(view.quietSince),
    Date.parse(card.movedAt),
    card.nudgedAt === null ? 0 : Date.parse(card.nudgedAt),
  );
  return nowMs - since >= WORKER_QUIET_MS;
}

export const FAILED_TURN_RESUME_MS = 2 * 60 * 1000;

export function isRuntimeFailure(failure: {
  readonly class: string;
  readonly category?: string | undefined;
  readonly code: string | null;
  readonly message: string;
  readonly retryable?: boolean | null | undefined;
}): boolean {
  if (isOutage(failure)) return false;
  if (failure.category !== undefined && failure.category !== "unknown") return false;
  return failure.class === "transport_error" && failure.retryable === true;
}

/** Failure recovery ignores background work, but keeps the ordinary nudge window. */
export function failedTurnResumeDue(
  card: KanbanCard,
  view: { readonly state: string; readonly quietSince: string },
  nowMs: number,
): boolean {
  if (card.stage !== "working" || card.activeRole !== "work" || card.stalled !== null) return false;
  if (view.state !== "idle") return false;
  return (
    nowMs - Math.max(Date.parse(view.quietSince), Date.parse(card.movedAt)) >=
      FAILED_TURN_RESUME_MS &&
    (card.nudgedAt === null || nowMs - Date.parse(card.nudgedAt) >= WORKER_QUIET_MS)
  );
}

/** How long a thread whose turn ended may wait on its own background work before the board treats it as stopped. */
export const BACKGROUND_GRACE_MS = 60 * 60 * 1000;

export const PR_WATCH_GRACE_MS = 6 * 60 * 60 * 1000;

/** An idle thread waiting on its own background work or PR watch, within that work's grace. */
export function waitingOnBackground(
  view: {
    readonly state: string;
    readonly quietSince: string;
    readonly backgroundWork: number;
    readonly backgroundWorkUntil?: string;
    readonly prWatches: number;
  },
  nowMs: number,
): boolean {
  return (
    view.state === "idle" &&
    ((view.backgroundWork > 0 &&
      nowMs <
        (view.backgroundWorkUntil === undefined
          ? Date.parse(view.quietSince) + BACKGROUND_GRACE_MS
          : Date.parse(view.backgroundWorkUntil))) ||
      // Reviewers never hold PR watches, so this shared guard needs no role check.
      (view.prWatches > 0 && nowMs - Date.parse(view.quietSince) < PR_WATCH_GRACE_MS))
  );
}

/** An In Review card whose reviewer sat idle with no verdict for WORKER_QUIET_MS (a turn end skipped for background work, or missed). */
export function reviewerQuietDue(
  card: KanbanCard,
  view: { readonly state: string; readonly quietSince: string },
  nowMs: number,
): boolean {
  if (
    card.stage !== "in_review" ||
    card.activeRole !== "review" ||
    card.activeThreadId === null ||
    card.stalled !== null
  )
    return false;
  if (view.state !== "idle") return false;
  const since = Math.max(
    Date.parse(view.quietSince),
    Date.parse(card.movedAt),
    card.nudgedAt === null ? 0 : Date.parse(card.nudgedAt),
  );
  return nowMs - since >= WORKER_QUIET_MS;
}

// Words a provider uses when it is out of usage or down, not when the request is wrong.
// A response-header timeout is the provider not answering, so it waits for the
// probe like an outage instead of flagging the card as a broken run.
const OUTAGE_TEXT =
  /extra usage|plan limits|usage limit|rate limit|rate_limit_error|quota|overloaded|authentication_error|access token has expired|timed out waiting for response headers|model unavailable/i;

/**
 * A failed run the same request would pass once the provider is back. The normalized
 * category decides when a driver sets one: quota, transient and expired auth are outages,
 * while config, model, context and content failures never are, even when their text reads
 * like an outage. Text and codes are the fallback for failures without a category.
 */
export function isOutage(failure: {
  readonly class: string;
  readonly code: string | null;
  readonly message: string;
  readonly category?: string | undefined;
}): boolean {
  switch (failure.category) {
    case "quota":
    case "transient":
    case "auth_expired":
      return true;
    case "config":
    case "model_invalid":
    case "context_exhausted":
    case "content_filter":
      return false;
    default:
      break;
  }
  if (failure.class === "usage_limit") return true;
  if (failure.code === "provider.quota" || failure.code === "provider.rate-limit") return true;
  return OUTAGE_TEXT.test(failure.message);
}

// Words a provider (or T3's own handoff budget) uses when a thread's history no longer fits the model.
const CONTEXT_FULL_TEXT =
  /prompt is too long|input is too long|context[ _]length|maximum context|context window|too many tokens|request_too_large|insufficient context allowance|too little context for a provider handoff/i;

/** A failed run whose context no longer fits. */
export function isContextFull(failure: { readonly message: string }): boolean {
  return CONTEXT_FULL_TEXT.test(failure.message);
}

/** A T3 handoff-budget failure, which provider-side compaction cannot reliably fix. */
export function isHandoffBudget(failure: { readonly message: string }): boolean {
  return /insufficient context allowance|too little context for a provider handoff/i.test(
    failure.message,
  );
}

/** How long after a fresh start a second context-full run is flagged instead of restarted. */
export const CONTEXT_FULL_RETRY_MS = 60 * 60 * 1000;

/** How long a failed evaluator waits before its one retry on the same thread. */
export const EVALUATOR_RETRY_MS = 2 * 60 * 1000;

export const PROBE_FIRST_MS = 5 * 60 * 1000;
export const PROBE_MAX_MS = 30 * 60 * 1000;
export const nextProbeDelay = (delayMs: number): number => Math.min(delayMs * 2, PROBE_MAX_MS);

/** Pools on a down model take no new card; threads already running are untouched. */
export function maskDownPools(
  pools: ReadonlyArray<KanbanPool>,
  down: ReadonlySet<string>,
): ReadonlyArray<KanbanPool> {
  return pools.map((pool) => (down.has(modelKey(pool.model)) ? { ...pool, slots: 0 } : pool));
}

/** Whether an open card holds `card` up; see kanbanHeldUpBy for the same-thread case. */
export const isBlocked = (
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  thread: string | null = card.workThreadId,
): boolean => kanbanHeldUpBy(card, byId, thread) !== undefined;

export function chainFor(board: KanbanBoard, card: KanbanCard) {
  const name = card.reviewChain ?? board.defaultReviewChain;
  return board.reviewChains.find((chain) => chain.name === name) ?? board.reviewChains[0] ?? null;
}

/** Model a card's next thread runs on: the work model, or the current review chain step. */
export function nextModel(board: KanbanBoard, card: KanbanCard): ModelSelection {
  if (card.stage === "needs_review" || card.stage === "in_review") {
    const chain = chainFor(board, card);
    const step = chain?.steps[Math.min(card.reviewStep, (chain?.steps.length ?? 1) - 1)];
    if (step) return step;
    return board.evaluatorModel;
  }
  return card.model;
}

/** The key of the pool `model` runs on; with no pool for it, its own pool key. */
export const poolOf = (pools: ReadonlyArray<KanbanPool>, model: ModelSelection): string =>
  poolFor(pools, model)?.key ?? poolKey(model);

/** The model of a card's that runs on `pool`, if any. */
export function modelOnPool(
  card: KanbanCard,
  pool: string,
  pools: ReadonlyArray<KanbanPool> = [],
): ModelSelection | null {
  if (poolOf(pools, card.model) === pool) return card.model;
  return kanbanCardModels(card).find((entry) => poolOf(pools, entry.model) === pool)?.model ?? null;
}

/**
 * The model a card's new work thread starts on: of the models whose pool has
 * a free slot, the highest weight; `pick` chooses among a tie.
 */
function weightedModel(
  card: KanbanCard,
  pools: ReadonlyArray<KanbanPool>,
  free: ReadonlyMap<string, number>,
  pick: (count: number) => number,
): ModelSelection | null {
  const open = kanbanCardModels(card).filter(
    (entry) => (free.get(poolOf(pools, entry.model)) ?? 0) > 0,
  );
  if (open.length === 0) return null;
  const top = Math.max(...open.map((entry) => entry.weight));
  const tied = open.filter((entry) => entry.weight === top);
  const index = Math.min(tied.length - 1, Math.max(0, Math.floor(pick(tied.length))));
  return tied[index]?.model ?? null;
}

/**
 * How To-Do is ordered, and the numbers a board shows for it. The rule lives in the
 * contracts package because the To-Do column lists cards in the order the dispatcher
 * takes them; these are the names the engine uses.
 *
 * A startable card is picked by rank, then by how many open cards it unblocks, then
 * by how long it has sat in To-Do. Its rank is its own priority, or that of the most
 * urgent open card it unblocks (the whole chain), lifted one step when it unblocks
 * FANOUT_STEPS[0] cards and two at FANOUT_STEPS[1], and one step per AGING_STEP_MS
 * it has been startable (at most AGING_MAX_STEPS). Lifts stop at BOOST_FLOOR: only a
 * card the owner marked P1, or one that unblocks a P1 card, ranks as P1.
 */
export const AGING_STEP_MS = KANBAN_AGING_STEP_MS;
export const AGING_MAX_STEPS = KANBAN_AGING_MAX_STEPS;
export const FANOUT_STEPS = KANBAN_FANOUT_STEPS;
export const BOOST_FLOOR = KANBAN_BOOST_FLOOR;
/** Rank, unblock count and waiting time of every open card, from one pass over the blocking graph. */
export const schedule = kanbanSchedule;
/** One card's place in the queue: what it unblocks, whether it is ready, what it waits on. */
export const cardFlow = kanbanCardFlow;

export interface Dispatch {
  readonly cardId: KanbanCard["id"];
  readonly role: "work" | "review";
  readonly pool: string;
  readonly model: ModelSelection;
  /** The card goes back to a work thread that already holds a slot in this pool. */
  readonly joins: boolean;
  /** Start a new thread when the old thread is busy elsewhere or its home card moved on. */
  readonly fresh: boolean;
  readonly freshReason?: string;
}

/** Most cards one work thread carries at once. */
export const MAX_BATCH = 4;

/**
 * Threads holding a slot, per pool. A slot belongs to a thread, not a card:
 * one work thread may carry several cards. `holds` are work threads whose
 * last card moved on mid-turn; they keep the slot until the turn ends so they
 * can take a related card next.
 */
export function poolThreads(
  cards: ReadonlyArray<KanbanCard>,
  holds: ReadonlyMap<string, string> = new Map(),
): Map<string, Set<string>> {
  const byPool = new Map<string, Set<string>>();
  const add = (pool: string, threadId: string) => {
    const set = byPool.get(pool) ?? new Set<string>();
    set.add(threadId);
    byPool.set(pool, set);
  };
  for (const card of cards) {
    if (card.activePool !== null && card.activeThreadId !== null) {
      add(card.activePool, card.activeThreadId);
    }
  }
  for (const [threadId, pool] of holds) add(pool, threadId);
  return byPool;
}

export type ReviewEvidence = NonNullable<Parameters<typeof kanbanReviewAlreadyDone>[1]>;

export interface AssignmentWakeRetry {
  readonly movedAt: string;
  readonly attempts: number;
  readonly retryAt: number;
}

export type QueueReason =
  | "archived"
  | "setup_running"
  | "paused"
  | "backlog"
  | "blocked"
  | "evaluator_step"
  | "deciding"
  | "retry_backoff"
  | "review_done"
  | "has_thread"
  | "attempted"
  | "pool_full"
  | "would_start"
  | "no_pool"
  | "joins_thread"
  | "batch_full"
  | `wait:${string}`
  | `stalled:${string}`;

type QueueEntry = { readonly card: KanbanCard; readonly role: "work" | "review" };
export interface QueuedCard {
  readonly card: number;
  readonly stage: KanbanCard["stage"];
  readonly role: "work" | "review";
  readonly hours: number;
  readonly reason: QueueReason;
  readonly blockedBy?: ReadonlyArray<number>;
  readonly pool?: string;
  readonly slots?: number;
  readonly rank?: number;
  readonly ahead?: { readonly count: number; readonly items: ReadonlyArray<number> };
  /** A held reservation may outlive its card's active link. */
  readonly held?: ReadonlyArray<{ readonly card: number | null; readonly role: "work" | "review" }>;
}

/** Eligibility and pick order shared by dispatch and current-state activity reads. */
export function dispatchQueue(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  nowMs = kanbanBoardClock(cards),
  attempted: ReadonlySet<string> = new Set(),
  reviews: ReadonlyMap<string, ReviewEvidence> = new Map(),
  assignmentWakeRetries: ReadonlyMap<string, AssignmentWakeRetry> = new Map(),
) {
  const kept = board.pause ? new Set<string>(board.pause.keep) : null;
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const queue: Array<QueueEntry> = [];
  const ineligible: Array<QueuedCard> = [];
  for (const card of cards) {
    if (card.settledAt !== null || (card.stage !== "todo" && card.stage !== "needs_review"))
      continue;
    const role = card.stage === "todo" ? "work" : "review";
    const retry = assignmentWakeRetries.get(card.id);
    const reason = (): QueueReason | undefined => {
      if (board.setup?.status === "running") return "setup_running";
      if (attempted.has(card.id)) return "attempted";
      if (retry?.movedAt === card.movedAt && nowMs < retry.retryAt) return "retry_backoff";
      if (kept !== null && !kept.has(card.id)) return "paused";
      if (card.activeThreadId !== null) return "has_thread";
      if (card.stalled !== null) {
        const { reason, by } = card.stalled;
        const kind =
          reason.startsWith("Run failed") || (by._tag === "system" && reason === NO_VERDICT_REASON)
            ? "run_failed"
            : by._tag === "system" && reason.startsWith(REFUSED_VERDICT_PREFIX)
              ? "verdict_refused"
              : "flagged";
        return `stalled:${kind}`;
      }
      if (card.priority === KANBAN_BACKLOG) return "backlog";
      if (heldForRetry(card, nowMs)) return "retry_backoff";
      if (kanbanWaitsOnEvaluator(card)) return "evaluator_step";
      if (kanbanReviewAlreadyDone(card, reviews.get(card.id))) return "review_done";
      if (kanbanWaiting(card)) return `wait:${card.wait!.on}`;
      if (kanbanDeciding(card, nowMs)) return "deciding";
      if (role === "work" && isBlocked(card, byId)) return "blocked";
      return undefined;
    };
    const excluded = reason();
    if (excluded === undefined) queue.push({ card, role });
    else
      ineligible.push({
        ...queuedCard(card, role, nowMs),
        reason: excluded,
        ...(excluded === "blocked" ? { blockedBy: blockingNumbers(card, byId) } : {}),
      });
  }
  const ranking = kanbanSchedule(cards, { nowMs });
  const pickOrder = kanbanPickOrder(cards, { nowMs });
  const priority = ({ card }: QueueEntry) => ranking.get(card.id)?.rank ?? card.priority;
  // Reviews and their follow-up work must drain before new work. Thread ids
  // alone also name first-run retries, which keep their ordinary work ranking.
  const newWork = ({ card, role }: QueueEntry) =>
    Number(role === "work" && card.reviewRound === 0 && card.reviewThreadId === null);
  queue.sort(
    (a, b) =>
      newWork(a) - newWork(b) ||
      priority(a) - priority(b) ||
      (a.role !== b.role ? (a.role === "review" ? -1 : 1) : pickOrder(a.card, b.card)),
  );
  return { queue, ineligible };
}

const queuedCard = (card: KanbanCard, role: "work" | "review", nowMs: number) => ({
  card: card.number,
  stage: card.stage,
  role,
  hours:
    Math.round(
      Math.max(0, nowMs - Date.parse(card.analyticsStageEnteredAt ?? card.movedAt)) / 36_000,
    ) / 100,
});

const blockingNumbers = (
  card: KanbanCard,
  byId: ReadonlyMap<string, KanbanCard>,
  thread = card.workThreadId,
) =>
  card.blockedBy.flatMap((id) => {
    const blocker = byId.get(id);
    return blocker && isBlocked({ ...card, blockedBy: [id] }, byId, thread) ? [blocker.number] : [];
  });

/**
 * Fill free pool slots with reviews and their follow-up work before other todos.
 * Reviews and follow-up work compete by effective urgency, reviews winning a tie.
 * Within each role, pick order uses rank, holds, then oldest first.
 * Skip blocked, settled and backlog cards. Lowering a pool below what is
 * running frees nothing; it only stops new starts, and a pool at 0 takes no
 * card at all. A todo card whose work thread still holds a slot rejoins that
 * thread without taking another one. `holds` are this board's held slots.
 * A card with no work thread yet starts on its highest-weight model with a
 * free slot; `pick(n)` returns an index below n to break a tie.
 *
 * Not before: a card whose run failed waits in its queue for its one retry and
 * is not started until its backoff is over (kanbanRetryNotBefore). It holds no
 * slot meanwhile, and once due it is a card like any other: same rank, same
 * age, same wait for a free slot.
 *
 * `nowMs` is the one clock both the retry backoff and the aging of waiting cards
 * are measured against. The dispatcher passes the real time. Left out (tests, a
 * caller with no clock) it is the board's newest card stamp (kanbanBoardClock).
 */
export function planDispatch(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: ReadonlyMap<string, string> = new Map(),
  pick: (count: number) => number = () => 0,
  nowMs?: number,
  attempted: ReadonlySet<string> = new Set(),
  reviews: ReadonlyMap<string, ReviewEvidence> = new Map(),
  workThreadHomes: ReadonlyMap<string, KanbanCard | null> = new Map(),
  assignmentWakeRetries: ReadonlyMap<string, AssignmentWakeRetry> = new Map(),
): ReadonlyArray<Dispatch> {
  return allocateDispatch(
    board,
    cards,
    pools,
    holds,
    pick,
    nowMs,
    attempted,
    reviews,
    workThreadHomes,
    assignmentWakeRetries,
    false,
  ).plan;
}

/** Deterministic slot simulation; ties use model order, with the same free-pool fallback as dispatch. */
export function dispatchQueueStatus(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: ReadonlyMap<string, string> = new Map(),
  nowMs?: number,
  reviews: ReadonlyMap<string, ReviewEvidence> = new Map(),
  workThreadHomes: ReadonlyMap<string, KanbanCard | null> = new Map(),
  assignmentWakeRetries: ReadonlyMap<string, AssignmentWakeRetry> = new Map(),
  attempted: ReadonlySet<string> = new Set(),
): ReadonlyArray<QueuedCard> {
  // Archiving is gated outside planDispatch; leave its legacy planning behavior intact.
  if (board.archivedAt !== null) {
    const clock = nowMs ?? kanbanBoardClock(cards);
    return cards.flatMap((card) =>
      card.settledAt === null && (card.stage === "todo" || card.stage === "needs_review")
        ? [
            {
              ...queuedCard(card, card.stage === "todo" ? "work" : "review", clock),
              reason: "archived" as const,
            },
          ]
        : [],
    );
  }
  return allocateDispatch(
    board,
    cards,
    pools,
    holds,
    () => 0,
    nowMs,
    attempted,
    reviews,
    workThreadHomes,
    assignmentWakeRetries,
    true,
  ).items;
}

function allocateDispatch(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: ReadonlyMap<string, string> = new Map(),
  pick: (count: number) => number = () => 0,
  nowMs?: number,
  attempted: ReadonlySet<string> = new Set(),
  reviews: ReadonlyMap<string, ReviewEvidence> = new Map(),
  workThreadHomes: ReadonlyMap<string, KanbanCard | null> = new Map(),
  assignmentWakeRetries: ReadonlyMap<string, AssignmentWakeRetry> = new Map(),
  diagnostics = false,
): { plan: ReadonlyArray<Dispatch>; items: ReadonlyArray<QueuedCard> } {
  // A board's first setup holds all card work and review until the setup evaluator ends it.
  if (!diagnostics && board.setup?.status === "running") return { plan: [], items: [] };
  const kept = board.pause ? new Set<string>(board.pause.keep) : null;
  const holding = poolThreads(cards, holds);
  const carrying = new Map<string, number>();
  for (const card of cards) {
    if (card.activeRole === "work" && card.activeThreadId !== null) {
      carrying.set(card.activeThreadId, (carrying.get(card.activeThreadId) ?? 0) + 1);
    }
  }
  const slots = new Map(pools.map((pool) => [pool.key, pool.slots]));
  const free = new Map<string, number>();
  for (const pool of pools) free.set(pool.key, pool.slots - (holding.get(pool.key)?.size ?? 0));
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const clock = nowMs ?? kanbanBoardClock(cards);
  const { queue, ineligible } = dispatchQueue(
    board,
    cards,
    clock,
    attempted,
    reviews,
    assignmentWakeRetries,
  );
  const items: Array<QueuedCard> = diagnostics ? [...ineligible] : [];
  const aheadByPool = new Map<string, Array<number>>();
  const heldByPool = new Map<string, NonNullable<QueuedCard["held"]>>();
  if (diagnostics) {
    const linked = new Map<string, KanbanCard>();
    for (const card of cards) {
      if (card.activeThreadId !== null && card.activePool !== null)
        linked.set(`${card.activePool}:${card.activeThreadId}`, card);
    }
    for (const [key, threads] of holding) {
      heldByPool.set(
        key,
        [...threads].map((thread) => {
          const card = linked.get(`${key}:${thread}`);
          return {
            card: card?.number ?? null,
            role: card?.activeRole === "review" ? "review" : "work",
          };
        }),
      );
    }
  }
  const busyElsewhere = (thread: string, key: string) =>
    [...holding].some(([other, threads]) => other !== key && threads.has(thread));

  const plan: Array<Dispatch> = [];
  for (const { role, card } of queue) {
    // An existing work thread follows the card's pinned model.
    const selected =
      role === "work" && card.workThreadId === null
        ? weightedModel(card, pools, free, pick)
        : nextModel(board, card);
    // A full fresh-work pool has no selected model. Activity still names its highest-weight choice.
    const model =
      selected ??
      (diagnostics
        ? (kanbanCardModels(card).toSorted((a, b) => b.weight - a.weight)[0]?.model ?? card.model)
        : null);
    if (model === null) continue;
    const pool = poolFor(pools, model);
    const key = pool?.key ?? poolKey(model);
    const ahead = aheadByPool.get(key) ?? [];
    const report = (reason: QueueReason, blockedBy?: ReadonlyArray<number>) => {
      if (!diagnostics) return;
      items.push({
        ...queuedCard(card, role, clock),
        reason,
        pool: key,
        slots: slots.get(key) ?? 0,
        rank: ahead.length + 1,
        ahead: { count: ahead.length, items: ahead.slice(0, 10) },
        held: heldByPool.get(key) ?? [],
        ...(blockedBy ? { blockedBy } : {}),
      });
      ahead.push(card.number);
      aheadByPool.set(key, ahead);
    };
    if (pool === undefined || (slots.get(key) ?? 0) <= 0) {
      report("no_pool");
      continue;
    }
    let thread = role === "work" ? card.workThreadId : null;
    // Missing links are legacy threads. A linked thread keeps claimed cards only
    // while its home card is still part of that batch.
    const home = thread === null ? undefined : workThreadHomes.get(thread);
    const homeMovedOn =
      home !== undefined &&
      home?.id !== card.id &&
      (home === null || !["working", "todo"].includes(home.stage) || home.workThreadId !== thread);
    const freshReason = homeMovedOn
      ? `fresh work thread: previous thread ${thread} ${home === null ? "has no home card" : `belongs to #${home.number} (${home.stage})`}`
      : undefined;
    const fresh = thread !== null && (homeMovedOn || busyElsewhere(thread, key));
    // A new thread can't take a card its old thread's own work still holds up.
    if (fresh && isBlocked(card, byId, null)) {
      report("blocked", blockingNumbers(card, byId, null));
      continue;
    }
    if (fresh) thread = null;
    if (
      thread !== null &&
      kept !== null &&
      cards.some((other) => other.activeThreadId === thread && !kept.has(other.id))
    ) {
      report("paused");
      continue;
    }
    const joins = thread !== null && (holding.get(key)?.has(thread) ?? false);
    if (joins && (carrying.get(thread ?? "") ?? 0) >= MAX_BATCH) {
      report("batch_full");
      continue;
    }
    if (!joins) {
      const left = free.get(key) ?? 0;
      if (left <= 0) {
        report("pool_full");
        continue;
      }
      free.set(key, left - 1);
    }
    if (thread !== null) {
      carrying.set(thread, (carrying.get(thread) ?? 0) + 1);
      const set = holding.get(key) ?? new Set<string>();
      set.add(thread);
      holding.set(key, set);
    }
    report(joins ? "joins_thread" : "would_start");
    plan.push({
      cardId: card.id,
      role,
      pool: key,
      model,
      joins,
      fresh,
      ...(freshReason === undefined ? {} : { freshReason }),
    });
  }
  return { plan, items };
}

/** Same provider, model and options, whatever order their keys were written in. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
const sameModel = (a: ModelSelection, b: ModelSelection): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Whether a planned start still holds against fresh state. A card whose row
 * changed since planning waits for the next pass, and the board's gates,
 * the card's blockers and the pool's room are checked again. `holds` must not
 * count this start's own reservation.
 */
export function confirmDispatch(
  board: KanbanBoard,
  planned: KanbanCard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: ReadonlyMap<string, string>,
  dispatch: Dispatch,
): boolean {
  if (board.archivedAt !== null || board.setup?.status === "running") return false;
  if (board.pause && !board.pause.keep.includes(dispatch.cardId)) return false;
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const card = byId.get(dispatch.cardId);
  if (!card || JSON.stringify(card) !== JSON.stringify(planned)) return false;
  // The plan's model came from the board as it was then. A review chain (or a step's
  // model) changed since would send this start to a reviewer the current chain no longer
  // names. A card already on a work thread stays on that thread's model, as when planned.
  if (
    (dispatch.role === "review" || card.workThreadId !== null) &&
    !sameModel(nextModel(board, card), dispatch.model)
  )
    return false;
  if (
    dispatch.role === "work" &&
    (kanbanWaitsOnEvaluator(card) ||
      isBlocked(card, byId) ||
      (dispatch.fresh && isBlocked(card, byId, null)))
  )
    return false;
  const thread = dispatch.role === "work" && !dispatch.fresh ? card.workThreadId : null;
  if (
    thread !== null &&
    board.pause &&
    cards.some((other) => other.activeThreadId === thread && !board.pause!.keep.includes(other.id))
  )
    return false;
  const pool = pools.find((candidate) => candidate.key === dispatch.pool);
  if (!pool || pool.slots <= 0 || poolFor(pools, dispatch.model)?.key !== pool.key) return false;
  const holding = poolThreads(cards, holds).get(dispatch.pool) ?? new Set<string>();
  if (dispatch.joins) {
    if (thread === null || !holding.has(thread)) return false;
    const carrying = cards.filter(
      (other) => other.activeRole === "work" && other.activeThreadId === thread,
    ).length;
    return carrying < MAX_BATCH;
  }
  return pool.slots - holding.size > 0;
}

/** What a work thread brings to a claim. */
export interface ClaimContext {
  readonly threadId: string | null;
  readonly pool: string;
  readonly projectId: string | null;
  readonly byId: ReadonlyMap<string, KanbanCard>;
  /** Cards working on the thread right now. */
  readonly carrying: number;
  /** Slots in the thread's pool; a pool at 0 is paused. */
  readonly slots: number;
  /** The board's pools, to find the pool each of the card's models runs on. */
  readonly pools?: ReadonlyArray<KanbanPool>;
  /** Now: a card held for its evaluator is let go when the time to decide runs out. */
  readonly nowMs?: number;
}

/**
 * A work thread may take a todo card that runs on its pool and project, isn't
 * running, stalled or kept for another work thread, and isn't blocked by work
 * outside the thread or awaiting review or merge.
 */
export function checkClaim(board: KanbanBoard, card: KanbanCard, ctx: ClaimContext): MoveCheck {
  // Same hold as planDispatch: no card work starts while the board's setup runs.
  if (board.setup?.status === "running") return no("Setup is running", "board_setup_running");
  if (board.pause && !board.pause.keep.includes(card.id)) {
    return no(`the board is paused: ${board.pause.reason}`, "board_paused");
  }
  if (card.stage !== "todo")
    return no(`card #${card.number} is in ${card.stage}, not todo`, "card_not_todo");
  if (card.settledAt !== null) return no(`card #${card.number} is settled`, "card_settled");
  if (card.activeThreadId !== null)
    return no(`card #${card.number} already has a thread`, "card_has_active_thread");
  if (card.workThreadId !== null && card.workThreadId !== ctx.threadId) {
    return no(`card #${card.number} goes back to its own work thread`, "not_card_owner");
  }
  if (card.stalled !== null) {
    return no(`card #${card.number} is flagged stalled: ${card.stalled.reason}`, "card_stalled");
  }
  if (card.priority === KANBAN_BACKLOG)
    return no(`card #${card.number} is in the backlog`, "card_in_backlog");
  if (kanbanWaiting(card)) {
    return no(
      `card #${card.number} is waiting (${card.wait?.note.trim() || card.wait?.on}): the board wakes it when that ends; clear the wait with card_wait first to take it now`,
      "card_waiting",
    );
  }
  if (kanbanDeciding(card, ctx.nowMs)) {
    return no(
      `card #${card.number} is held for its evaluator, who was told its wait ended (${card.deciding?.why}): it carries on when that evaluator's turn ends`,
      "evaluator_decision_pending",
    );
  }
  if (kanbanWaitsOnEvaluator(card)) {
    return no(
      `card #${card.number} waits on ${kanbanScriptStep(card) ? "a script's" : "an evaluator's"} subtask first`,
      "evaluator_step_pending",
    );
  }
  const pools = ctx.pools ?? [];
  const runsOn =
    card.workThreadId === null
      ? kanbanCardModels(card).map((entry) => poolOf(pools, entry.model))
      : [poolOf(pools, card.model)];
  if (!runsOn.includes(ctx.pool)) {
    return no(
      `card #${card.number} runs on ${runsOn.join(" or ")}; this thread runs ${ctx.pool}`,
      "model_pool_mismatch",
    );
  }
  if ((card.projectId ?? board.defaultProjectId) !== ctx.projectId) {
    return no(`card #${card.number} runs in another project`, "project_mismatch");
  }
  // A claim batches this thread's todo/working cards, but review and merge can still hold it up.
  const blocker = kanbanHeldUpBy(card, ctx.byId, ctx.threadId);
  if (blocker)
    return no(
      `card #${card.number} waits on #${blocker.number} (${blocker.stage})`,
      "dependency_blocked",
    );
  if (ctx.slots <= 0) return no(`the ${ctx.pool} pool is paused`, "pool_paused");
  if (ctx.carrying >= MAX_BATCH) {
    return no(
      `this thread already carries ${ctx.carrying} cards (max ${MAX_BATCH})`,
      "thread_batch_full",
    );
  }
  return ok;
}

export interface Candidate {
  readonly card: KanbanCard;
  readonly why: string;
}

/**
 * Todo cards worth taking into a thread that worked on `seeds`: same similar
 * group, a block either way, or the same PR or Linear issue. Only cards the
 * thread could claim, in pick order.
 */
export function relatedCandidates(input: {
  readonly board: KanbanBoard;
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly groups: ReadonlyArray<KanbanGroup>;
  readonly seeds: ReadonlyArray<KanbanCard>;
  readonly threadId: string | null;
  readonly pool: string;
  readonly projectId: string | null;
  readonly carrying: number;
  readonly slots: number;
  readonly pools?: ReadonlyArray<KanbanPool>;
  readonly limit?: number;
  readonly rankingCards?: ReadonlyArray<KanbanScheduleCard>;
}): ReadonlyArray<Candidate> {
  const byId = new Map(input.cards.map((card) => [card.id as string, card]));
  const seeds = new Set<string>(input.seeds.map((seed) => seed.id));
  const reasons = new Map<string, string>();
  const note = (id: string, why: string) => {
    if (!seeds.has(id) && !reasons.has(id)) reasons.set(id, why);
  };
  for (const seed of input.seeds) {
    for (const group of input.groups) {
      if (!group.cardIds.includes(seed.id)) continue;
      for (const id of group.cardIds) note(id, `same group as #${seed.number} (${group.name})`);
    }
    for (const id of seed.blockedBy) note(id, `blocks #${seed.number}`);
    const shared = new Map(
      seed.links.filter((link) => link.kind !== "url").map((link) => [link.url, link.kind]),
    );
    for (const card of input.cards) {
      if (card.blockedBy.includes(seed.id)) note(card.id, `waits on #${seed.number}`);
      const link = card.links.find((candidate) => shared.has(candidate.url));
      if (link) {
        note(card.id, `same ${link.kind === "pr" ? "PR" : "Linear issue"} as #${seed.number}`);
      }
    }
  }
  const ctx: ClaimContext = {
    threadId: input.threadId,
    pool: input.pool,
    projectId: input.projectId,
    byId,
    carrying: input.carrying,
    slots: input.slots,
    ...(input.pools ? { pools: input.pools } : {}),
  };
  const order = kanbanPickOrder(input.rankingCards ?? input.cards);
  return [...reasons]
    .flatMap(([id, why]) => {
      const card = byId.get(id);
      return card && checkClaim(input.board, card, ctx).ok ? [{ card, why }] : [];
    })
    .toSorted((a, b) => order(a.card, b.card))
    .slice(0, input.limit ?? MAX_BATCH);
}
