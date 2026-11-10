/**
 * A synthetic board the size and shape of the biggest real one (Crpko, 10 Nov 2026:
 * about 3,700 cards, 1,060 in To-Do with three in four blocked, 110 waiting for
 * review, three cards blocking 423 others, most startable cards at the lowest
 * priority). The soak test seeds it and drives the engine over it; nothing here
 * does I/O, and the same seed always builds the same board.
 */
import {
  KANBAN_BACKLOG,
  KanbanCardId,
  type KanbanBoard,
  type KanbanCard,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A small seeded generator: `next()` in [0, 1), `below(n)` an integer under n. */
export const soakRandom = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    next,
    below: (count: number) => Math.floor(next() * count),
    chance: (share: number) => next() < share,
    pick: <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)]!,
  };
};
export type SoakRandom = ReturnType<typeof soakRandom>;

export interface SoakBoardInput {
  readonly board: Pick<KanbanBoard, "id">;
  /** Cards on the board, done ones included. */
  readonly cards: number;
  readonly seed: number;
  /** The clock the cards' stamps count back from. */
  readonly nowMs: number;
  /** Models work cards run on, with the share of cards each takes. */
  readonly workModels: ReadonlyArray<{ readonly model: ModelSelection; readonly share: number }>;
  /** Review chain names on the board; cards are spread over them evenly. */
  readonly chains: ReadonlyArray<string>;
  /** First card number; the board's own cards, if any, come before it. */
  readonly firstNumber?: number;
}

/** Shares of the real board: To-Do, waiting for review, the rest done. */
export const SOAK_TODO_SHARE = 0.3;
export const SOAK_REVIEW_SHARE = 0.03;
/** To-Do cards that wait on an open card. */
export const SOAK_BLOCKED_SHARE = 0.75;
/** Blocked cards that wait on one of the three hub cards. */
export const SOAK_HUB_SHARE = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

export function soakCards(input: SoakBoardInput): ReadonlyArray<KanbanCard> {
  const random = soakRandom(input.seed);
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const first = input.firstNumber ?? 1;
  const todoCount = Math.round(input.cards * SOAK_TODO_SHARE);
  const reviewCount = Math.round(input.cards * SOAK_REVIEW_SHARE);
  const doneCount = input.cards - todoCount - reviewCount;
  const totalShare = input.workModels.reduce((sum, entry) => sum + entry.share, 0);
  const workModel = () => {
    let roll = random.next() * totalShare;
    for (const entry of input.workModels) {
      roll -= entry.share;
      if (roll <= 0) return entry.model;
    }
    return input.workModels[0]!.model;
  };
  const cards: Array<KanbanCard> = [];
  const make = (patch: Partial<KanbanCard>): KanbanCard => {
    const number = first + cards.length;
    const movedAt = iso(input.nowMs - random.below(30 * DAY_MS) - 60_000);
    const card: KanbanCard = {
      id: KanbanCardId.make(`soak-${number}`),
      boardId: input.board.id,
      number,
      title: `Soak card ${number}`,
      description: "",
      prompt: `Do the work of soak card ${number}.`,
      subtasks: [],
      subtaskSeq: 0,
      stage: "todo",
      priority: 3,
      goalId: null,
      projects: [],
      model: workModel(),
      models: [],
      projectId: null,
      links: [],
      blockedBy: [],
      stalled: null,
      question: null,
      asks: [],
      reviewChain: input.chains.length === 0 ? null : random.pick(input.chains),
      reviewStep: 0,
      reviewRound: 0,
      activeThreadId: null,
      activeRole: null,
      activePool: null,
      workThreadId: null,
      reviewThreadId: null,
      discussionId: null,
      wakeNote: null,
      nudgedAt: null,
      settledAt: null,
      createdBy: { _tag: "owner" },
      createdAt: movedAt,
      updatedAt: movedAt,
      movedAt,
      ...patch,
    };
    cards.push(card);
    return card;
  };

  // Done cards: most verified and put away, some waiting to be deployed or verified.
  const done: Array<KanbanCard["id"]> = [];
  for (let i = 0; i < doneCount; i += 1) {
    const roll = random.next();
    const stage = roll < 0.9 ? "verified" : roll < 0.96 ? "deployed" : "completed";
    const card = make({
      stage,
      priority: 1 + random.below(4),
      reviewStep: 3,
    });
    if (stage === "verified" && random.chance(0.85)) {
      cards[cards.length - 1] = { ...card, settledAt: card.movedAt };
    }
    done.push(card.id);
  }

  // Cards waiting for a reviewer, oldest first when the dispatcher takes them.
  for (let i = 0; i < reviewCount; i += 1)
    make({ stage: "needs_review", priority: 1 + random.below(4) });

  // To-Do. The first cards are startable; three of them are the hubs half of the
  // blocked cards wait on, and blocked cards also wait on each other, so chains form.
  const startableCount = Math.max(4, Math.round(todoCount * (1 - SOAK_BLOCKED_SHARE)));
  const open: Array<KanbanCard["id"]> = [];
  const hubs: Array<KanbanCard["id"]> = [];
  for (let i = 0; i < todoCount; i += 1) {
    if (i < startableCount) {
      // Most startable cards sit at the lowest priority, as on the real board.
      const roll = random.next();
      const priority =
        i < 3
          ? 3
          : roll < 0.85
            ? 4
            : roll < 0.9
              ? 3
              : roll < 0.95
                ? 2
                : roll < 0.98
                  ? 1
                  : KANBAN_BACKLOG;
      // Some list a finished card as a blocker: that holds nothing.
      const card = make({
        priority,
        blockedBy: random.chance(0.2) && done.length > 0 ? [random.pick(done)] : [],
      });
      if (i < 3) hubs.push(card.id);
      if (priority !== KANBAN_BACKLOG) open.push(card.id);
      continue;
    }
    const blockers = new Set<KanbanCard["id"]>();
    if (random.chance(SOAK_HUB_SHARE)) blockers.add(random.pick(hubs));
    const more = blockers.size === 0 ? 1 + random.below(3) : random.below(2);
    for (let b = 0; b < more; b += 1) blockers.add(random.pick(open));
    const roll = random.next();
    const card = make({
      priority: roll < 0.1 ? 1 : roll < 0.3 ? 2 : roll < 0.65 ? 3 : 4,
      blockedBy: [...blockers],
    });
    open.push(card.id);
  }
  return cards;
}
