import type {
  KanbanBoard,
  KanbanCard,
  KanbanPool,
  KanbanThreadLink,
  ModelSelection,
} from "@t3tools/contracts";

import * as Rules from "../kanban/engine/rules.ts";
import { planSelection, sameValue, type SelectionPlan } from "./selectionPlan.ts";

/** Everything a board's selections can hold, read once, before any write. */
export interface BoardSnapshot {
  readonly board: KanbanBoard;
  readonly pools: ReadonlyArray<KanbanPool>;
  readonly cards: ReadonlyArray<KanbanCard>;
  /** Thread links the board still holds open (ended = 0), including reusable evaluators. */
  readonly openLinks: ReadonlyArray<KanbanThreadLink>;
}

export interface BoardConflict {
  readonly field: string;
  readonly reason: string;
}

/** Old pools that would land on one new key. The whole board fails on any of these. */
export interface PoolCollision {
  readonly newKey: string;
  readonly oldKeys: ReadonlyArray<string>;
}

/** The planned result for one board. Nothing is written until the store applies it. */
export interface BoardPlan {
  readonly boardId: string;
  readonly changed: boolean;
  readonly conflicts: ReadonlyArray<BoardConflict>;
  readonly collisions: ReadonlyArray<PoolCollision>;
  /** The board, pools, cards and open links as they will be written. Null when unchanged or blocked. */
  readonly next: {
    readonly board: KanbanBoard;
    readonly pools: ReadonlyArray<KanbanPool>;
    readonly cards: ReadonlyArray<KanbanCard>;
    readonly openLinks: ReadonlyArray<KanbanThreadLink>;
  } | null;
  /** Each value that changes, with the before and after, for the migration ledger. */
  readonly changes: ReadonlyArray<{
    readonly ref: string;
    readonly before: unknown;
    readonly after: unknown;
  }>;
}

const sameJson = sameValue;

/** Maps one selection; a conflict is reported and the value stays as it was. */
const mapOne = (
  conflicts: Array<BoardConflict>,
  field: string,
  selection: ModelSelection,
): ModelSelection => {
  const plan: SelectionPlan = planSelection(selection);
  if (plan._tag === "conflict") {
    conflicts.push({ field, reason: plan.reason });
    return selection;
  }
  return plan._tag === "mapped" ? plan.next : selection;
};

/**
 * Plans one board's selection rewrite. Pools are checked first: two old pools that land on
 * one new key are a collision, and the board is blocked (it's never summed or merged).
 * A card's occupancy is its `activePool`, so that key follows its pool's new key, and an
 * unmapped pool keeps its key.
 */
export const planBoard = (snapshot: BoardSnapshot): BoardPlan => {
  const { board, pools, cards, openLinks } = snapshot;
  const conflicts: Array<BoardConflict> = [];
  const changes: Array<{
    readonly ref: string;
    readonly before: unknown;
    readonly after: unknown;
  }> = [];

  // Pool keys: each old pool maps to its new key. Two old pools that map to one new key collide.
  const keyOf = new Map<string, string>();
  const byNewKey = new Map<string, Array<string>>();
  const mappedPools: Array<KanbanPool> = [];
  for (const pool of pools) {
    const model = mapOne(conflicts, `pool ${pool.key}`, pool.model);
    const newKey = Rules.poolKey(model);
    keyOf.set(pool.key, newKey);
    byNewKey.set(newKey, [...(byNewKey.get(newKey) ?? []), pool.key]);
    mappedPools.push({ ...pool, key: newKey, model });
  }
  const collisions: Array<PoolCollision> = [...byNewKey.entries()]
    .filter(([, oldKeys]) => oldKeys.length > 1)
    .map(([newKey, oldKeys]) => ({ newKey, oldKeys }));

  const boardNext: KanbanBoard = {
    ...board,
    managerModel: mapOne(conflicts, "managerModel", board.managerModel),
    evaluatorModel: mapOne(conflicts, "evaluatorModel", board.evaluatorModel),
    defaultCardModel: mapOne(conflicts, "defaultCardModel", board.defaultCardModel),
    reviewChains: board.reviewChains.map((chain) => ({
      ...chain,
      steps: chain.steps.map((step, index) =>
        mapOne(conflicts, `reviewChains.${chain.name}.steps.${index}`, step),
      ),
    })),
  };
  if (!sameJson(boardNext, board)) {
    changes.push({ ref: `board:${board.id}`, before: board, after: boardNext });
  }

  // Even a settled card can be reopened, so its pinned selections must follow the cutover.
  const cardsNext = cards.map((card) => {
    const model = mapOne(conflicts, `card ${card.number} model`, card.model);
    const models = card.models.map((entry) => ({
      ...entry,
      model: mapOne(conflicts, `card ${card.number} models`, entry.model),
    }));
    const activePool =
      card.activePool === null ? null : (keyOf.get(card.activePool) ?? card.activePool);
    const next = { ...card, model, models, activePool };
    if (!sameJson(next, card)) {
      changes.push({ ref: `card:${board.id}:${card.id}`, before: card, after: next });
    }
    return next;
  });

  const linksNext = openLinks.map((link) => {
    if (link.model === null) return link;
    const model = mapOne(conflicts, `thread ${link.threadId} model`, link.model);
    const next = { ...link, model };
    if (!sameJson(next, link)) {
      changes.push({ ref: `thread:${board.id}:${link.threadId}`, before: link, after: next });
    }
    return next;
  });

  // Pool changes: only pools whose key or model actually moved.
  const poolsNext = mappedPools.map((pool, index) => {
    const before = pools[index];
    if (before !== undefined && !sameJson(before, pool)) {
      // Pool keys repeat across boards, so the ref carries the board: it is the rollback's key.
      changes.push({ ref: `pool:${board.id}:${before.key}`, before, after: pool });
    }
    return pool;
  });

  // The blocked case reports; the store is never asked to write it.
  const blocked = conflicts.length > 0 || collisions.length > 0;
  const finalChanged = changes.length > 0;
  return {
    boardId: board.id,
    changed: finalChanged && !blocked,
    conflicts,
    collisions,
    next: blocked
      ? null
      : {
          board: boardNext,
          pools: poolsNext,
          cards: cardsNext,
          openLinks: linksNext,
        },
    changes,
  };
};
