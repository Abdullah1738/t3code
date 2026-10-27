import type { KanbanBoardListEntry, KanbanBoardSummary } from "@t3tools/contracts";

const NONE: ReadonlySet<string> = new Set();

/**
 * Threads the boards started: work, review and evaluator threads. The owner
 * reaches them from their cards and discussions, so thread lists leave them out.
 */
export function boardThreadIds(
  boards: ReadonlyArray<KanbanBoardSummary> | undefined,
): ReadonlySet<string> {
  if (boards === undefined) return NONE;
  const ids = new Set<string>();
  for (const summary of boards) {
    for (const id of summary.threadIds) ids.add(id);
  }
  return ids.size === 0 ? NONE : ids;
}

/** Drops board threads, keeping the same array when nothing is dropped. */
export function withoutBoardThreads<T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
  boardThreads: ReadonlySet<string>,
): ReadonlyArray<T> {
  if (boardThreads.size === 0) return threads;
  const kept = threads.filter((thread) => !boardThreads.has(thread.id));
  return kept.length === threads.length ? threads : kept;
}

/**
 * Folds one board list update into the list so far. A null board is the one
 * already held, and thread ids only add up: the stream sends each new one once,
 * and a reconnect's whole list repeats the ones already held.
 */
export function mergeBoardList(
  previous: ReadonlyArray<KanbanBoardSummary> | undefined,
  update: ReadonlyArray<KanbanBoardListEntry>,
): ReadonlyArray<KanbanBoardSummary> {
  const held = new Map(previous?.map((summary) => [summary.board.id, summary]));
  return update.flatMap((entry) => {
    const before = held.get(entry.boardId);
    const board = entry.board ?? before?.board;
    if (board === undefined) return [];
    const known = before?.threadIds ?? [];
    const seen = new Set(known);
    const added = entry.threadIds.filter((id) => !seen.has(id));
    return [
      {
        board,
        needsOwner: entry.needsOwner,
        running: entry.running,
        unread: entry.unread,
        threadIds: added.length === 0 ? known : [...known, ...added],
      },
    ];
  });
}
