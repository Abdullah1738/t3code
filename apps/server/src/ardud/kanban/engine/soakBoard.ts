/**
 * A synthetic board the size and shape of the biggest real one (Crpko, 10 Nov 2026:
 * about 3,700 cards, 1,060 in To-Do with three in four blocked, 110 waiting for
 * review, three cards blocking 423 others, most startable cards at the lowest
 * priority). The soak test seeds it and drives the engine over it; nothing here
 * does I/O, and the same seed always builds the same board.
 */
import {
  KANBAN_BACKLOG,
  KANBAN_DONE_STAGES,
  KanbanCardId,
  type KanbanBoard,
  type KanbanCard,
  type KanbanLink,
  type KanbanWait,
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

/** Open cards (To-Do and awaiting review) parked on a wait. */
export const SOAK_WAIT_SHARE = 0.05;
/** At least one card of every kind of park below, so the smoke board has them all. */
export const SOAK_WAITS_MIN = 15;

/**
 * The parks the soak seeds, one after the other and round again. `from` is where
 * the card sits. `ends` is when its wait is over: at the first tick (`start`),
 * when the driver changes the reading or the time comes mid-run (`mid`), or not
 * in this run (`never`: these are the steady cost of a parked card). `thread`:
 * the card has an idle work thread. On a pull request wait that thread watches
 * the PR, so the tick reads the PR from the thread's view; without one the host
 * reader is asked.
 *
 * Script waits are not seeded: their checks are real processes that the
 * scripts' own pass starts, and this harness runs no scripts.
 */
export const SOAK_PARKS = [
  { kind: "merge", on: "merge", from: "todo", ends: "mid", thread: false },
  { kind: "merge, own thread", on: "merge", from: "todo", ends: "mid", thread: true },
  { kind: "push, own thread", on: "push", from: "todo", ends: "never", thread: true },
  { kind: "time, due", on: "time", from: "todo", ends: "start", thread: false },
  { kind: "time", on: "time", from: "todo", ends: "mid", thread: false },
  { kind: "time, far off", on: "time", from: "todo", ends: "never", thread: true },
  { kind: "card, done", on: "card", from: "todo", ends: "start", thread: false },
  { kind: "card, open", on: "card", from: "todo", ends: "never", thread: true },
  { kind: "merge, open", on: "merge", from: "todo", ends: "never", thread: false },
  { kind: "push", on: "push", from: "review", ends: "mid", thread: false },
  { kind: "ci", on: "ci", from: "review", ends: "mid", thread: false },
  { kind: "ci, pending", on: "ci", from: "review", ends: "never", thread: false },
  { kind: "push, open", on: "push", from: "review", ends: "never", thread: false },
  { kind: "merge, reviewed", on: "merge", from: "reviewed", ends: "mid", thread: false },
  { kind: "time, reviewed", on: "time", from: "reviewed", ends: "mid", thread: false },
] as const satisfies ReadonlyArray<{
  readonly kind: string;
  readonly on: KanbanWait["on"];
  /** `review`: awaiting review. `reviewed`: its review passed, it sits in review with nobody on it. */
  readonly from: "todo" | "review" | "reviewed";
  readonly ends: "start" | "mid" | "never";
  readonly thread: boolean;
}>;

export type SoakPark = (typeof SOAK_PARKS)[number];

/** One parked card, and what the driver needs to end its wait. */
export interface SoakParked {
  readonly cardId: KanbanCard["id"];
  readonly park: SoakPark;
  /** The pull request it waits on, if any. */
  readonly pr: string | null;
  /** The commit a push wait was set at. */
  readonly sinceHead: string | null;
  /** The card it waits on, if any. */
  readonly waitsOn: KanbanCard["id"] | null;
  /** An idle work thread the harness must stand up; it watches `pr` when there is one. */
  readonly workThreadId: string | null;
}

export interface SoakWaitsInput {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly seed: number;
  readonly nowMs: number;
  /** When a `mid` time wait comes due, from `nowMs`. */
  readonly midMs: number;
  /** Steps in each review chain, by name: a reviewed card has passed them all. */
  readonly chainSteps: ReadonlyMap<string, number>;
}

/**
 * Parks about one open card in twenty on a wait, of every kind in SOAK_PARKS.
 * Returns the board's cards with the waits set and what was parked.
 *
 * The parked cards are To-Do cards no other card waits on, so the blocking
 * graph and the seeded review queue stay as they were; a park that sits in
 * review moves its card there. A card whose wait ends in the run has no
 * blockers, so that the wake can start it.
 */
export function soakWaits(input: SoakWaitsInput): {
  readonly cards: ReadonlyArray<KanbanCard>;
  readonly parked: ReadonlyArray<SoakParked>;
} {
  const random = soakRandom(input.seed);
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const byId = new Map(input.cards.map((card) => [card.id as string, card]));
  const blockers = new Set(input.cards.flatMap((card) => card.blockedBy as ReadonlyArray<string>));
  const open = input.cards.filter((card) => card.stage === "todo" || card.stage === "needs_review");
  const blocked = (card: KanbanCard) =>
    card.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && !KANBAN_DONE_STAGES.has(blocker.stage);
    });
  const free = input.cards.filter((card) => card.stage === "todo" && !blockers.has(card.id));
  for (let i = free.length - 1; i > 0; i -= 1) {
    const j = random.below(i + 1);
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  const done = input.cards.filter((card) => card.stage === "verified");
  const held = input.cards.filter((card) => card.stage === "todo" && blocked(card));
  const count = Math.max(SOAK_WAITS_MIN, Math.round(open.length * SOAK_WAIT_SHARE));
  // The wait was set half a minute ago: after every seeded card last moved.
  const at = iso(input.nowMs - 30_000);
  const patched = new Map<string, KanbanCard>();
  const parked: Array<SoakParked> = [];
  for (let i = 0; i < count; i += 1) {
    const park = SOAK_PARKS[i % SOAK_PARKS.length]!;
    const card = free.pop();
    if (card === undefined) break;
    const onPr = park.on === "merge" || park.on === "push" || park.on === "ci";
    const pr = onPr ? `https://github.com/soak/app/pull/${1000 + i}` : null;
    const sinceHead = park.on === "push" ? `a${1000 + i}000` : null;
    const workThreadId = park.thread ? `soak-parked-thread-${i}` : null;
    const waitsOn = park.on !== "card" ? null : random.pick(park.ends === "start" ? done : held).id;
    const until =
      park.on !== "time"
        ? null
        : iso(
            park.ends === "start"
              ? input.nowMs - 10_000
              : park.ends === "mid"
                ? input.nowMs + input.midMs
                : input.nowMs + 20 * DAY_MS,
          );
    const wait: KanbanWait = {
      on: park.on,
      script: null,
      args: null,
      pr: pr as KanbanWait["pr"],
      card: waitsOn,
      ask: null,
      until,
      sinceHead,
      note: `Soak: ${park.kind}`,
      by: { _tag: "owner" },
      at,
      wakeRole: null,
      expiredAt: null,
      status: null,
      lastCheckedAt: null,
      failures: 0,
      problem: null,
    };
    // A merge wait's PR is one the card tracks; a push or ci wait points at one it only cites.
    const link: KanbanLink | null =
      pr === null
        ? null
        : {
            kind: "pr",
            url: pr as KanbanLink["url"],
            label: null,
            state: park.on === "merge" ? "open" : null,
            checkedAt: park.on === "merge" ? at : null,
          };
    patched.set(card.id, {
      ...card,
      ...(park.from === "review" ? { stage: "needs_review" as const, blockedBy: [] } : {}),
      ...(park.from === "reviewed"
        ? {
            stage: "in_review" as const,
            blockedBy: [],
            reviewStep: input.chainSteps.get(card.reviewChain ?? "") ?? 1,
          }
        : {}),
      ...(park.from === "todo" && park.ends !== "never"
        ? { blockedBy: [], priority: card.priority === KANBAN_BACKLOG ? 3 : card.priority }
        : {}),
      links: link === null ? card.links : [...card.links, link],
      workThreadId: workThreadId as KanbanCard["workThreadId"],
      wait,
    });
    parked.push({ cardId: card.id, park, pr, sinceHead, waitsOn, workThreadId });
  }
  return { cards: input.cards.map((card) => patched.get(card.id) ?? card), parked };
}
