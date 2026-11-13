export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

/**
 * A by-id miss can be a race: a draft or new thread opens a moment before the
 * server commits it. Keep retrying for this long before showing "not found".
 */
export const THREAD_NOT_FOUND_GRACE_MS = 12_000;
const THREAD_NOT_FOUND_MAX_RETRY_DELAY_MS = 2_000;

export function threadNotFoundRetryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), THREAD_NOT_FOUND_MAX_RETRY_DELAY_MS);
}
