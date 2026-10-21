// @effect-diagnostics globalDate:off -- Day dividers follow the reader's local calendar.
/**
 * The owner chat holds one thread per session since September, hundreds of them,
 * and each rendered thread holds a live subscription. The chat page renders only a
 * window of the newest threads and widens it a day at a time on request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_THREADS = 2;

/** Local calendar day, so a divider lands on the day the owner sees on the clock. */
export function imessageDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Index of the first thread to render, for threads sorted oldest first. The base
 * window is the newest two threads or everything from the last 24 hours, whichever
 * is more; each earlier day adds every thread of the next older calendar day.
 */
export function imessageThreadWindowStart(
  threads: ReadonlyArray<{ readonly createdAt: string }>,
  now: number,
  earlierDays: number,
): number {
  const recentFrom = now - DAY_MS;
  let start = Math.max(0, threads.length - MIN_RECENT_THREADS);
  while (start > 0 && Date.parse(threads[start - 1]!.createdAt) >= recentFrom) start -= 1;
  for (let day = 0; day < earlierDays && start > 0; day += 1) {
    const key = imessageDayKey(threads[start - 1]!.createdAt);
    while (start > 0 && imessageDayKey(threads[start - 1]!.createdAt) === key) start -= 1;
  }
  return start;
}
