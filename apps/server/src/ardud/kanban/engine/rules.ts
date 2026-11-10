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
  kanbanPickOrder,
  kanbanRetryNotBefore,
  kanbanSchedule,
  kanbanScriptStep,
  kanbanWaitsOnEvaluator,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanGroup,
  type KanbanPool,
  type KanbanStage,
  type ModelSelection,
} from "@t3tools/contracts";
import { selectionEffort } from "@t3tools/client-runtime/ardud/models/harnessRouting";

/**
 * Who is asking for a move. `cardThread` is the card's own work or review thread.
 * `script` is a board script, from its output.
 */
export type MoveRole = "owner" | "evaluator" | "cardThread" | "dispatcher" | "system" | "script";

export type MoveCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
const no = (reason: string): MoveCheck => ({ ok: false, reason });

/**
 * Only the dispatcher puts a card into a thread stage, because that is the
 * moment a pool slot is taken. Everyone else moves cards between the quiet
 * stages, and a move out of a thread stage frees the slot.
 */
export function checkMove(role: MoveRole, card: KanbanCard, to: KanbanStage): MoveCheck {
  const from = card.stage;
  if (from === to) return no(`card is already in ${to}`);
  if (KANBAN_THREAD_STAGES.includes(to) && role !== "dispatcher") {
    return no(`only the dispatcher moves a card into ${to}; move it to todo or needs_review`);
  }
  switch (role) {
    case "dispatcher":
      if (from === "todo" && to === "working") return ok;
      if (from === "needs_review" && to === "in_review") return ok;
      return no(`dispatcher cannot move ${from} -> ${to}`);
    case "cardThread":
      if (from === "working" && (to === "needs_review" || to === "needs_owner")) return ok;
      return no(
        `a card thread can move working -> needs_review or needs_owner, not ${from} -> ${to}`,
      );
    case "system":
      // Review results and PR merges.
      if (from === "in_review" && (to === "todo" || to === "completed")) return ok;
      return no(`system cannot move ${from} -> ${to}`);
    case "script":
      if (card.settledAt !== null) return no("card is settled");
      if (KANBAN_THREAD_STAGES.includes(from)) {
        return no(`a script doesn't move a card a thread has (${from})`);
      }
      if (!(to === "completed" || to === "deployed" || to === "verified")) {
        return no(`a script moves a card only to completed, deployed or verified, not ${to}`);
      }
      return ok;
    case "evaluator":
    case "owner":
      if (card.settledAt !== null) return no("card is settled");
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

/** A Working card whose worker sat idle, or stuck on its own question, for WORKER_QUIET_MS. */
export function workerQuietDue(
  card: KanbanCard,
  view: { readonly state: string; readonly quietSince: string },
  nowMs: number,
): boolean {
  if (card.stage !== "working" || card.activeRole !== "work" || card.stalled !== null) return false;
  if (view.state !== "idle" && view.state !== "needs-input") return false;
  const since = Math.max(
    Date.parse(view.quietSince),
    Date.parse(card.movedAt),
    card.nudgedAt === null ? 0 : Date.parse(card.nudgedAt),
  );
  return nowMs - since >= WORKER_QUIET_MS;
}

/** How long a thread whose turn ended may wait on its own background work before the board treats it as stopped. */
export const BACKGROUND_GRACE_MS = 60 * 60 * 1000;

/** A thread whose turn ended while its own subagents or background tasks still run, within the grace. */
export function waitingOnBackground(
  view: { readonly state: string; readonly quietSince: string; readonly backgroundWork: number },
  nowMs: number,
): boolean {
  return (
    view.state === "idle" &&
    view.backgroundWork > 0 &&
    nowMs - Date.parse(view.quietSince) < BACKGROUND_GRACE_MS
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
  /extra usage|plan limits|usage limit|rate limit|rate_limit_error|quota|overloaded|authentication_error|access token has expired|timed out waiting for response headers/i;

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
  /** Start a new thread: the card's old work thread is busy in another pool. */
  readonly fresh: boolean;
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

/** The newest stamp on any card: the clock of a caller that passes none. */
const newestStamp = (cards: ReadonlyArray<KanbanCard>): number => {
  let newest = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const at = Date.parse(card.updatedAt);
    if (at > newest) newest = at;
  }
  return newest;
};

/**
 * A board's held slots (thread id to pool) as the dispatcher reads them, with the
 * time of the read. The dispatcher's plan call hands planDispatch its holds and
 * no clock, so `asOf` is the time a waiting retry is measured against there. A
 * plain Map is a HeldSlots with no time.
 */
export type HeldSlots = ReadonlyMap<string, string> & { readonly asOf?: number };
export const heldSlots = (entries: Iterable<readonly [string, string]>, asOf: number): HeldSlots =>
  Object.assign(new Map(entries), { asOf });

/**
 * Fill free pool slots: reviews first (oldest first), then todo in pick
 * order (see `schedule`), skipping blocked, settled and backlog cards. Lowering a pool below what is
 * running frees nothing; it only stops new starts, and a pool at 0 takes no
 * card at all. A todo card whose work thread still holds a slot rejoins that
 * thread without taking another one. `holds` are this board's held slots.
 * A card with no work thread yet starts on its highest-weight model with a
 * free slot; `pick(n)` returns an index below n to break a tie. `nowMs` is the
 * clock waiting cards age against; left out, it is the board's newest card stamp.
 *
 * Not before: a card whose run failed waits in its queue for its one retry and
 * is not started until its backoff is over (kanbanRetryNotBefore). It holds no
 * slot meanwhile, and once due it is a card like any other: same rank, same
 * age, same wait for a free slot. The clock for this is `nowMs`, else the
 * holds' `asOf`, else the board's newest card stamp.
 */
export function planDispatch(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: HeldSlots = new Map(),
  pick: (count: number) => number = () => 0,
  nowMs?: number,
): ReadonlyArray<Dispatch> {
  // A board's first setup holds all card work and review until the setup evaluator ends it.
  if (board.setup?.status === "running") return [];
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
  const clock = nowMs ?? holds.asOf;
  let newest: number | undefined;
  const retryHeld = (card: KanbanCard) => {
    const notBefore = kanbanRetryNotBefore(card);
    if (notBefore === null) return false;
    return notBefore > (clock ?? (newest ??= newestStamp(cards)));
  };
  const waiting = cards.filter(
    (card) =>
      (kept === null || kept.has(card.id)) &&
      card.settledAt === null &&
      card.activeThreadId === null &&
      card.stalled === null &&
      card.priority !== KANBAN_BACKLOG &&
      !retryHeld(card) &&
      // A step that's only the evaluator's is done by an evaluator, not a new thread.
      // Reviews still go: a review never waits on the evaluator's step.
      !kanbanWaitsOnEvaluator(card),
  );
  const reviews = waiting
    .filter((card) => card.stage === "needs_review")
    .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt));
  const todos = waiting
    .filter((card) => card.stage === "todo" && !isBlocked(card, byId))
    .toSorted(kanbanPickOrder(cards, { nowMs }));
  const busyElsewhere = (thread: string, key: string) =>
    [...holding].some(([other, threads]) => other !== key && threads.has(thread));

  const plan: Array<Dispatch> = [];
  for (const [role, list] of [
    ["review", reviews],
    ["work", todos],
  ] as const) {
    for (const card of list) {
      // Once a card has a work thread it stays on that thread's model.
      const model =
        role === "work" && card.workThreadId === null
          ? weightedModel(card, pools, free, pick)
          : nextModel(board, card);
      if (model === null) continue;
      const key = poolFor(pools, model)?.key;
      if (key === undefined || (slots.get(key) ?? 0) <= 0) continue;
      let thread = role === "work" ? card.workThreadId : null;
      const fresh = thread !== null && busyElsewhere(thread, key);
      // A new thread can't take a card its old thread's own work still holds up.
      if (fresh && isBlocked(card, byId, null)) continue;
      if (fresh) thread = null;
      if (
        thread !== null &&
        kept !== null &&
        cards.some((other) => other.activeThreadId === thread && !kept.has(other.id))
      )
        continue;
      const joins = thread !== null && (holding.get(key)?.has(thread) ?? false);
      if (joins && (carrying.get(thread ?? "") ?? 0) >= MAX_BATCH) continue;
      if (!joins) {
        const left = free.get(key) ?? 0;
        if (left <= 0) continue;
        free.set(key, left - 1);
      }
      if (thread !== null) {
        carrying.set(thread, (carrying.get(thread) ?? 0) + 1);
        const set = holding.get(key) ?? new Set<string>();
        set.add(thread);
        holding.set(key, set);
      }
      plan.push({ cardId: card.id, role, pool: key, model, joins, fresh });
    }
  }
  return plan;
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
 * Whether a planned start still holds against fresh state. A pass plans every
 * start from one snapshot, then starts each card on its own: a card whose row
 * changed since the snapshot waits for the next pass, and the board's gates,
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
    (isBlocked(card, byId) || (dispatch.fresh && isBlocked(card, byId, null)))
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
}

/**
 * A work thread may take a todo card that runs on its pool and project, isn't
 * running, stalled or kept for another work thread, and isn't blocked by work
 * outside the thread.
 */
export function checkClaim(board: KanbanBoard, card: KanbanCard, ctx: ClaimContext): MoveCheck {
  // Same hold as planDispatch: no card work starts while the board's setup runs.
  if (board.setup?.status === "running") return no("Setup is running");
  if (board.pause && !board.pause.keep.includes(card.id)) {
    return no(`the board is paused: ${board.pause.reason}`);
  }
  if (card.stage !== "todo") return no(`card #${card.number} is in ${card.stage}, not todo`);
  if (card.settledAt !== null) return no(`card #${card.number} is settled`);
  if (card.activeThreadId !== null) return no(`card #${card.number} already has a thread`);
  if (card.workThreadId !== null && card.workThreadId !== ctx.threadId) {
    return no(`card #${card.number} goes back to its own work thread`);
  }
  if (card.stalled !== null) {
    return no(`card #${card.number} is flagged stalled: ${card.stalled.reason}`);
  }
  if (card.priority === KANBAN_BACKLOG) return no(`card #${card.number} is in the backlog`);
  if (kanbanWaitsOnEvaluator(card)) {
    return no(
      `card #${card.number} waits on ${kanbanScriptStep(card) ? "a script's" : "an evaluator's"} subtask first`,
    );
  }
  const pools = ctx.pools ?? [];
  const runsOn =
    card.workThreadId === null
      ? kanbanCardModels(card).map((entry) => poolOf(pools, entry.model))
      : [poolOf(pools, card.model)];
  if (!runsOn.includes(ctx.pool)) {
    return no(`card #${card.number} runs on ${runsOn.join(" or ")}; this thread runs ${ctx.pool}`);
  }
  if ((card.projectId ?? board.defaultProjectId) !== ctx.projectId) {
    return no(`card #${card.number} runs in another project`);
  }
  // The claim makes the card this thread's, so a block by the thread's own work doesn't count.
  const blocker = kanbanHeldUpBy(card, ctx.byId, ctx.threadId);
  if (blocker) return no(`card #${card.number} waits on #${blocker.number}`);
  if (ctx.slots <= 0) return no(`the ${ctx.pool} pool is paused`);
  if (ctx.carrying >= MAX_BATCH) {
    return no(`this thread already carries ${ctx.carrying} cards (max ${MAX_BATCH})`);
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
  const order = kanbanPickOrder(input.cards);
  return [...reasons]
    .flatMap(([id, why]) => {
      const card = byId.get(id);
      return card && checkClaim(input.board, card, ctx).ok ? [{ card, why }] : [];
    })
    .toSorted((a, b) => order(a.card, b.card))
    .slice(0, input.limit ?? MAX_BATCH);
}
