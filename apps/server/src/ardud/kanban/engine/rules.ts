import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KANBAN_THREAD_STAGES,
  kanbanCardModels,
  kanbanHeldUpBy,
  kanbanPickOrder,
  kanbanWaitsOnEvaluator,
  type KanbanBoard,
  type KanbanCard,
  type KanbanDiscussion,
  type KanbanGroup,
  type KanbanPool,
  type KanbanStage,
  type ModelSelection,
} from "@t3tools/contracts";

/** Who is asking for a move. `cardThread` is the card's own work or review thread. */
export type MoveRole = "owner" | "evaluator" | "cardThread" | "dispatcher" | "system";

export type MoveCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const poolKey = (model: ModelSelection): string => `${model.instanceId}/${model.model}`;

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
  view: { readonly state: string; readonly updatedAt: string },
  nowMs: number,
): boolean {
  if (card.stage !== "working" || card.activeRole !== "work" || card.stalled !== null) return false;
  if (view.state !== "idle" && view.state !== "needs-input") return false;
  const since = Math.max(
    Date.parse(view.updatedAt),
    Date.parse(card.movedAt),
    card.nudgedAt === null ? 0 : Date.parse(card.nudgedAt),
  );
  return nowMs - since >= WORKER_QUIET_MS;
}

// Words a provider uses when it is out of usage or down, not when the request is wrong.
const OUTAGE_TEXT =
  /extra usage|plan limits|usage limit|rate limit|rate_limit_error|quota|overloaded|authentication_error|access token has expired/i;

/** A failed run the same request would pass once the provider is back. */
export function isOutage(failure: {
  readonly class: string;
  readonly code: string | null;
  readonly message: string;
}): boolean {
  if (failure.class === "usage_limit") return true;
  if (failure.code === "provider.quota" || failure.code === "provider.rate-limit") return true;
  return OUTAGE_TEXT.test(failure.message);
}

export const PROBE_FIRST_MS = 5 * 60 * 1000;
export const PROBE_MAX_MS = 30 * 60 * 1000;
export const nextProbeDelay = (delayMs: number): number => Math.min(delayMs * 2, PROBE_MAX_MS);

/** Pools on a down model take no new card; threads already running are untouched. */
export function maskDownPools(
  pools: ReadonlyArray<KanbanPool>,
  down: ReadonlySet<string>,
): ReadonlyArray<KanbanPool> {
  return pools.map((pool) => (down.has(pool.key) ? { ...pool, slots: 0 } : pool));
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

/** The model of a card's that runs on `pool`, if any. */
export function modelOnPool(card: KanbanCard, pool: string): ModelSelection | null {
  if (poolKey(card.model) === pool) return card.model;
  return kanbanCardModels(card).find((entry) => poolKey(entry.model) === pool)?.model ?? null;
}

/**
 * The model a card's new work thread starts on: of the models whose pool has
 * a free slot, the highest weight; `pick` chooses among a tie.
 */
function weightedModel(
  card: KanbanCard,
  free: ReadonlyMap<string, number>,
  pick: (count: number) => number,
): ModelSelection | null {
  const open = kanbanCardModels(card).filter((entry) => (free.get(poolKey(entry.model)) ?? 0) > 0);
  if (open.length === 0) return null;
  const top = Math.max(...open.map((entry) => entry.weight));
  const tied = open.filter((entry) => entry.weight === top);
  const index = Math.min(tied.length - 1, Math.max(0, Math.floor(pick(tied.length))));
  return tied[index]?.model ?? null;
}

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

/**
 * Fill free pool slots: reviews first (oldest first), then todo in pick
 * order, skipping blocked, settled and backlog cards. Lowering a pool below what is
 * running frees nothing; it only stops new starts, and a pool at 0 takes no
 * card at all. A todo card whose work thread still holds a slot rejoins that
 * thread without taking another one. `holds` are this board's held slots.
 * A card with no work thread yet starts on its highest-weight model with a
 * free slot; `pick(n)` returns an index below n to break a tie.
 */
export function planDispatch(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
  holds: ReadonlyMap<string, string> = new Map(),
  pick: (count: number) => number = () => 0,
): ReadonlyArray<Dispatch> {
  // A board's first setup holds all card work and review until the setup evaluator ends it.
  if (board.setup?.status === "running") return [];
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
  const waiting = cards.filter(
    (card) =>
      card.settledAt === null &&
      card.activeThreadId === null &&
      card.stalled === null &&
      card.priority !== KANBAN_BACKLOG &&
      // A step that's only the evaluator's is done by an evaluator, not a new thread.
      // Reviews still go: a review never waits on the evaluator's step.
      !kanbanWaitsOnEvaluator(card),
  );
  const reviews = waiting
    .filter((card) => card.stage === "needs_review")
    .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt));
  const todos = waiting
    .filter((card) => card.stage === "todo" && !isBlocked(card, byId))
    .toSorted(kanbanPickOrder(cards));
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
          ? weightedModel(card, free, pick)
          : nextModel(board, card);
      if (model === null) continue;
      const key = poolKey(model);
      if ((slots.get(key) ?? 0) <= 0) continue;
      let thread = role === "work" ? card.workThreadId : null;
      const fresh = thread !== null && busyElsewhere(thread, key);
      // A new thread can't take a card its old thread's own work still holds up.
      if (fresh && isBlocked(card, byId, null)) continue;
      if (fresh) thread = null;
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
}

/**
 * A work thread may take a todo card that runs on its pool and project, isn't
 * running, stalled or kept for another work thread, and isn't blocked by work
 * outside the thread.
 */
export function checkClaim(board: KanbanBoard, card: KanbanCard, ctx: ClaimContext): MoveCheck {
  // Same hold as planDispatch: no card work starts while the board's setup runs.
  if (board.setup?.status === "running") return no("Setup is running");
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
    return no(`card #${card.number} waits on an evaluator's subtask first`);
  }
  const runsOn =
    card.workThreadId === null
      ? kanbanCardModels(card).map((entry) => poolKey(entry.model))
      : [poolKey(card.model)];
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
