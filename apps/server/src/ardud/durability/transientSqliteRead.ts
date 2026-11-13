import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * ardud: a read that failed only because the SQLite reader went away (the
 * watchdog retired a worker stuck on another statement, the lane had no
 * worker, the worker exited) or the database was briefly locked. Every
 * statement queued behind a retired worker fails with it, so one slow query
 * used to fail live provider turns that merely had a read waiting (9 Nov).
 * Retrying such a read is safe; nothing was written.
 */
const TRANSIENT_READ_MESSAGE =
  /Database (?:auth )?reader (?:retired|failed|exited)|Reader lane unavailable|Reader lane admission queue full|database reader is unavailable|database is locked|SQLITE_BUSY/i;

export const isTransientSqliteReadFailure = (failure: unknown): boolean => {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [failure];
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (current == null || seen.has(current)) continue;
    seen.add(current);
    try {
      if (Cause.isCause(current)) {
        // Interruption is not a read failure; leave it to the caller.
        if (Cause.hasInterruptsOnly(current)) return false;
        queue.push(Cause.squash(current));
        continue;
      }
      if (typeof current === "string") {
        if (TRANSIENT_READ_MESSAGE.test(current)) return true;
        continue;
      }
      if (typeof current !== "object") continue;
      const record = current as Record<string, unknown>;
      if (typeof record.message === "string" && TRANSIENT_READ_MESSAGE.test(record.message)) {
        return true;
      }
      queue.push(record.cause, record.reason);
    } catch {
      continue;
    }
  }
  return false;
};

/**
 * Long enough to outlast a reader retirement (statements are retired after two
 * minutes, then a fresh worker starts) and a stalled lane, short enough that a
 * reader that never comes back still surfaces as a failure. The budget is
 * checked between attempts, so the last attempt may run past it (by up to one
 * reader retirement); erring long keeps a live turn alive.
 */
export const TRANSIENT_READ_RETRY_BUDGET = Duration.minutes(10);

export const transientReadRetrySchedule = (budget: Duration.Input = TRANSIENT_READ_RETRY_BUDGET) =>
  Schedule.exponential("250 millis").pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(10))),
    ),
    Schedule.upTo({ duration: budget }),
  );
