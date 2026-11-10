/**
 * Board list counts, kept from the change feed so a board list never opens
 * board feeds. Only cards and discussions that add to a count are kept,
 * plus the ids of the board's threads so thread lists can leave them out.
 * After the first list, a list resends a board only when it changed and only
 * the threads started since the last list.
 */
import {
  kanbanAskWaitsOn,
  type KanbanBoard,
  type KanbanBoardListEntry,
  type KanbanBoardSummary,
  type KanbanChange,
  type KanbanDiscussion,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import type { SummaryCard } from "../store/summaryCard.ts";

/**
 * What a card adds to the counts. `ownerUntil` is the time (ms) until which it
 * counts for the owner: forever for an ask with no expiry or a hand-set hold,
 * the latest `expiresAt` among his answerable asks otherwise, 0 for none.
 */
interface CardCount {
  readonly ownerUntil: number;
  readonly running: boolean;
}

interface BoardTally {
  board: KanbanBoard;
  readonly cards: Map<string, CardCount>;
  /** The counts the last list carried, to notice an ask expiring between changes. */
  sent: Counts | null;
  readonly unread: Map<string, number>;
  readonly threads: Set<ThreadId>;
  /** The board changed since the last list. */
  boardChanged: boolean;
  /** Threads started since the last list. */
  readonly started: Array<ThreadId>;
}

/** Mutable on purpose: one per watcher, folded over its own changes. */
export type BoardTallies = Map<string, BoardTally>;

// The time-free half of `kanbanCardNeedsOwner`: the clock is applied when a list is built.
const cardCount = (card: SummaryCard): CardCount | null => {
  if (card.settledAt !== null) return null;
  let ownerUntil = 0;
  let open = 0;
  for (const ask of card.asks) {
    if (ask.closedAt !== null) continue;
    open += 1;
    if (kanbanAskWaitsOn(ask) !== "owner") continue;
    ownerUntil = Math.max(
      ownerUntil,
      ask.expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(ask.expiresAt),
    );
  }
  if (open === 0 && card.stage === "needs_owner") ownerUntil = Number.POSITIVE_INFINITY;
  const running = card.activeThreadId !== null;
  return ownerUntil === 0 && !running ? null : { ownerUntil, running };
};

const sameCount = (a: CardCount | null, b: CardCount | null) =>
  a === b || (a !== null && b !== null && a.ownerUntil === b.ownerUntil && a.running === b.running);

// Same rule as the board snapshot's unread entries.
const unreadOf = (discussion: KanbanDiscussion) => {
  const owner = discussion.participants.find((entry) => entry.actor._tag === "owner");
  return Math.max(0, discussion.lastSeq - (owner?.lastReadSeq ?? 0));
};

export function tallyBoards(
  boards: ReadonlyArray<{
    readonly board: KanbanBoard;
    readonly cards: ReadonlyArray<SummaryCard>;
    readonly discussions: ReadonlyArray<KanbanDiscussion>;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }>,
): BoardTallies {
  return new Map(
    boards.map(({ board, cards, discussions, threadIds }) => [
      board.id,
      {
        board,
        cards: new Map(
          cards.flatMap((card) => {
            const count = cardCount(card);
            return count === null ? [] : [[card.id, count] as const];
          }),
        ),
        unread: new Map(
          discussions.flatMap((discussion) => {
            const count = unreadOf(discussion);
            return count === 0 ? [] : [[discussion.id, count] as const];
          }),
        ),
        threads: new Set(threadIds),
        boardChanged: false,
        started: [],
        sent: null,
      },
    ]),
  );
}

/** Folds one change in; true when a summary changed. Changes to unknown boards are dropped. */
export function applyChange(tallies: BoardTallies, boardId: string, change: KanbanChange): boolean {
  if (change._tag === "board") {
    const tally = tallies.get(boardId);
    if (tally) {
      tally.board = change.board;
      tally.boardChanged = true;
    } else
      tallies.set(boardId, {
        board: change.board,
        cards: new Map(),
        unread: new Map(),
        threads: new Set(),
        boardChanged: true,
        started: [],
        sent: null,
      });
    return true;
  }
  const tally = tallies.get(boardId);
  if (!tally) return false;
  switch (change._tag) {
    case "card":
      return setCard(tally.cards, change.card.id, cardCount(change.card));
    case "cardRemoved":
      return setCard(tally.cards, change.cardId, null);
    case "discussion":
      return setEntry(tally.unread, change.discussion.id, unreadOf(change.discussion), 0);
    case "thread": {
      if (tally.threads.has(change.thread.threadId)) return false;
      tally.threads.add(change.thread.threadId);
      tally.started.push(change.thread.threadId);
      return true;
    }
    default:
      return false;
  }
}

// Entries that add nothing are left out, so a new idle card moves no count.
const setEntry = <T>(map: Map<string, T>, key: string, value: T, none: T) => {
  const changed = (map.get(key) ?? none) !== value;
  if (value === none) map.delete(key);
  else map.set(key, value);
  return changed;
};

const setCard = (map: Map<string, CardCount>, key: string, value: CardCount | null) => {
  const changed = !sameCount(map.get(key) ?? null, value);
  if (value === null) map.delete(key);
  else map.set(key, value);
  return changed;
};

interface Counts {
  readonly needsOwner: number;
  readonly running: number;
  readonly unread: number;
}

// A card the owner can act on counts there even while a thread holds it.
const countsOf = (tally: BoardTally, nowMs: number): Counts => {
  let needsOwner = 0;
  let running = 0;
  let unread = 0;
  for (const count of tally.cards.values()) {
    if (count.ownerUntil > nowMs) needsOwner += 1;
    else if (count.running) running += 1;
  }
  for (const count of tally.unread.values()) unread += count;
  return { needsOwner, running, unread };
};

/** True when a count moved with no change behind it: an ask passed its `expiresAt`. */
const countsMoved = (tallies: BoardTallies, nowMs: number) => {
  for (const tally of tallies.values()) {
    if (tally.sent === null) continue;
    const now = countsOf(tally, nowMs);
    if (now.needsOwner !== tally.sent.needsOwner || now.running !== tally.sent.running) return true;
  }
  return false;
};

export function summaries(tallies: BoardTallies, nowMs: number): ReadonlyArray<KanbanBoardSummary> {
  return [...tallies.values()].map((tally) => ({
    board: tally.board,
    ...countsOf(tally, nowMs),
    threadIds: [...tally.threads],
  }));
}

/** One list for the stream: whole when first, else only what changed since the last. */
export function listUpdate(
  tallies: BoardTallies,
  first: boolean,
  nowMs: number,
): ReadonlyArray<KanbanBoardListEntry> {
  return [...tallies.values()].map((tally) => {
    const counts = countsOf(tally, nowMs);
    tally.sent = counts;
    const entry = {
      boardId: tally.board.id,
      board: first || tally.boardChanged ? tally.board : null,
      ...counts,
      threadIds: first ? [...tally.threads] : tally.started.slice(),
    };
    tally.boardChanged = false;
    tally.started.length = 0;
    return entry;
  });
}

/**
 * The whole list now, then an update once per batch of changes that moves a
 * count, so a burst sends one list. Changes set whole records: one queued before the
 * starting read can briefly undo a newer copy it holds, and the change that
 * made that copy follows it and sets it back. An ask passing its `expiresAt`
 * is no change, so each batch also recounts: the badge drops it at the next
 * change on any board.
 */
export const follow = <E, R>(
  tallies: BoardTallies,
  changes: Stream.Stream<{ readonly boardId: string; readonly change: KanbanChange }, E, R>,
  now: () => number = Date.now,
): Stream.Stream<ReadonlyArray<KanbanBoardListEntry>, E, R> =>
  Stream.concat(
    Stream.sync(() => listUpdate(tallies, true, now())),
    changes.pipe(
      Stream.mapAccumArray(
        () => tallies,
        (state, batch) => {
          let moved = false;
          for (const entry of batch) {
            if (applyChange(state, entry.boardId, entry.change)) moved = true;
          }
          const nowMs = now();
          return [
            state,
            moved || countsMoved(state, nowMs) ? [listUpdate(state, false, nowMs)] : [],
          ] as const;
        },
      ),
    ),
  );
