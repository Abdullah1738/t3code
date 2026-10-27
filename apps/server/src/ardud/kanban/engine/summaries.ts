/**
 * Board list counts, kept from the change feed so a board list never opens
 * board feeds. Only cards and discussions that add to a count are kept,
 * plus the ids of the board's threads so thread lists can leave them out.
 * After the first list, a list resends a board only when it changed and only
 * the threads started since the last list.
 */
import {
  kanbanNeedsOwner,
  type KanbanBoard,
  type KanbanBoardListEntry,
  type KanbanBoardSummary,
  type KanbanCard,
  type KanbanChange,
  type KanbanDiscussion,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

type CardCount = "owner" | "running" | null;

interface BoardTally {
  board: KanbanBoard;
  readonly cards: Map<string, CardCount>;
  readonly unread: Map<string, number>;
  readonly threads: Set<ThreadId>;
  /** The board changed since the last list. */
  boardChanged: boolean;
  /** Threads started since the last list. */
  readonly started: Array<ThreadId>;
}

/** Mutable on purpose: one per watcher, folded over its own changes. */
export type BoardTallies = Map<string, BoardTally>;

// A card waiting on the owner, or with an open ask, counts there even while a thread holds it.
const cardCount = (card: KanbanCard): CardCount =>
  card.settledAt !== null
    ? null
    : kanbanNeedsOwner(card)
      ? "owner"
      : card.activeThreadId !== null
        ? "running"
        : null;

// Same rule as the board snapshot's unread entries.
const unreadOf = (discussion: KanbanDiscussion) => {
  const owner = discussion.participants.find((entry) => entry.actor._tag === "owner");
  return Math.max(0, discussion.lastSeq - (owner?.lastReadSeq ?? 0));
};

export function tallyBoards(
  boards: ReadonlyArray<{
    readonly board: KanbanBoard;
    readonly cards: ReadonlyArray<KanbanCard>;
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
      });
    return true;
  }
  const tally = tallies.get(boardId);
  if (!tally) return false;
  switch (change._tag) {
    case "card":
      return setEntry(tally.cards, change.card.id, cardCount(change.card), null);
    case "cardRemoved":
      return setEntry(tally.cards, change.cardId, null, null);
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

const countsOf = (tally: BoardTally) => {
  let needsOwner = 0;
  let running = 0;
  let unread = 0;
  for (const count of tally.cards.values()) {
    if (count === "owner") needsOwner += 1;
    else if (count === "running") running += 1;
  }
  for (const count of tally.unread.values()) unread += count;
  return { needsOwner, running, unread };
};

export function summaries(tallies: BoardTallies): ReadonlyArray<KanbanBoardSummary> {
  return [...tallies.values()].map((tally) => ({
    board: tally.board,
    ...countsOf(tally),
    threadIds: [...tally.threads],
  }));
}

/** One list for the stream: whole when first, else only what changed since the last. */
export function listUpdate(
  tallies: BoardTallies,
  first: boolean,
): ReadonlyArray<KanbanBoardListEntry> {
  return [...tallies.values()].map((tally) => {
    const entry = {
      boardId: tally.board.id,
      board: first || tally.boardChanged ? tally.board : null,
      ...countsOf(tally),
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
 * made that copy follows it and sets it back.
 */
export const follow = <E, R>(
  tallies: BoardTallies,
  changes: Stream.Stream<{ readonly boardId: string; readonly change: KanbanChange }, E, R>,
): Stream.Stream<ReadonlyArray<KanbanBoardListEntry>, E, R> =>
  Stream.concat(
    Stream.sync(() => listUpdate(tallies, true)),
    changes.pipe(
      Stream.mapAccumArray(
        () => tallies,
        (state, batch) => {
          let moved = false;
          for (const entry of batch) {
            if (applyChange(state, entry.boardId, entry.change)) moved = true;
          }
          return [state, moved ? [listUpdate(state, false)] : []] as const;
        },
      ),
    ),
  );
