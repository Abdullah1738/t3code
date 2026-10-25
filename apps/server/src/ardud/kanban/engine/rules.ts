import {
  KANBAN_THREAD_STAGES,
  type KanbanBoard,
  type KanbanCard,
  type KanbanPool,
  type KanbanStage,
  type ModelSelection,
} from "@t3tools/contracts";

/** Who is asking for a move. `cardThread` is the card's own work or review thread. */
export type MoveRole = "owner" | "evaluator" | "cardThread" | "dispatcher" | "system";

export type MoveCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const DONE_STAGES: ReadonlySet<KanbanStage> = new Set(["completed", "deployed", "verified"]);

export const poolKey = (model: ModelSelection): string => `${model.instanceId}/${model.model}`;

export const isDone = (stage: KanbanStage) => DONE_STAGES.has(stage);

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

/** Every PR link merged or closed. A card with no PR has nothing to wait for. */
export function prsLanded(card: KanbanCard): boolean {
  return card.links
    .filter((link) => link.kind === "pr")
    .every((link) => link.state === "merged" || link.state === "closed");
}

export function isBlocked(card: KanbanCard, byId: ReadonlyMap<string, KanbanCard>): boolean {
  return card.blockedBy.some((id) => {
    const blocker = byId.get(id);
    return blocker !== undefined && !isDone(blocker.stage);
  });
}

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

export interface Dispatch {
  readonly cardId: KanbanCard["id"];
  readonly role: "work" | "review";
  readonly pool: string;
  readonly model: ModelSelection;
}

/**
 * Fill free pool slots: reviews first (oldest first), then todo by priority
 * and age, skipping blocked and settled cards. Lowering a pool below what is
 * running frees nothing; it only stops new starts.
 */
export function planDispatch(
  board: KanbanBoard,
  cards: ReadonlyArray<KanbanCard>,
  pools: ReadonlyArray<KanbanPool>,
): ReadonlyArray<Dispatch> {
  const free = new Map<string, number>();
  for (const pool of pools) free.set(pool.key, pool.slots);
  for (const card of cards) {
    if (card.activePool !== null && free.has(card.activePool)) {
      free.set(card.activePool, (free.get(card.activePool) ?? 0) - 1);
    }
  }
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const waiting = cards.filter(
    (card) => card.settledAt === null && card.activeThreadId === null && card.stalled === null,
  );
  const reviews = waiting
    .filter((card) => card.stage === "needs_review")
    .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt));
  const todos = waiting
    .filter((card) => card.stage === "todo" && !isBlocked(card, byId))
    .toSorted((a, b) => a.priority - b.priority || a.movedAt.localeCompare(b.movedAt));

  const plan: Array<Dispatch> = [];
  for (const [role, list] of [
    ["review", reviews],
    ["work", todos],
  ] as const) {
    for (const card of list) {
      const model = nextModel(board, card);
      const key = poolKey(model);
      const left = free.get(key) ?? 0;
      if (left <= 0) continue;
      free.set(key, left - 1);
      plan.push({ cardId: card.id, role, pool: key, model });
    }
  }
  return plan;
}
