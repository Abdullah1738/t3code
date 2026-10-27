import type { KanbanBoardSummary } from "@t3tools/contracts";

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
