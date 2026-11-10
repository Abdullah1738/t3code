import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import type { Connection } from "effect/sql/SqlConnection";

export const ReaderLane = Context.Reference<"auth" | "identity" | "view">(
  "@t3tools/shared/nodeSqliteClient/ReaderLane",
  { defaultValue: () => "view" },
);

// Reads a reserved reader never ran (queued behind a slow statement, or its
// process stopped first). Nothing executed for them, so a caller may run an
// idempotent read again; a read that started is never replayed.
const notStartedErrors = new WeakSet<object>();
export const markNotStarted = <E extends object>(error: E): E => {
  notStartedErrors.add(error);
  return error;
};

/** Typed "busy, retry" for a reserved reader: the process is kept, the caller is not. */
export const readerBusy = (message: string, started: boolean): SqlError => {
  const error = new SqlError({
    reason: classifySqliteError(new Error(message), { operation: "readerBusy", message }),
  });
  return started ? error : markNotStarted(error);
};

const LANE_OPERATIONS = new Set(["readerAdmission", "readerBusy", "readerSnapshot"]);
const LANE_MESSAGE =
  /^(?:Database (?:auth )?reader (?:exited|retired|failed)|Reader lane |Reader startup queue full)/;

/**
 * Classify a failure from a reserved reader lane anywhere in an error's cause
 * chain: "retryable" when no statement ran for it (lane unavailable, queue
 * full, never started), "busy" when a started read gave up or its process
 * stopped, undefined for any other failure (SQL errors, decode errors).
 */
export const readerLaneFailure = (error: unknown): "retryable" | "busy" | undefined => {
  let busy = false;
  const seen = new Set<unknown>();
  const stack: Array<unknown> = [error];
  while (stack.length > 0 && seen.size < 32) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    if (notStartedErrors.has(node)) return "retryable";
    const reason = (node as { readonly reason?: { readonly operation?: unknown } }).reason;
    const operation = typeof reason === "object" && reason !== null ? reason.operation : undefined;
    if (operation === "readerAdmission") return "retryable";
    if (typeof operation === "string" && LANE_OPERATIONS.has(operation)) busy = true;
    const message = (node as { readonly message?: unknown }).message;
    if (typeof message === "string" && LANE_MESSAGE.test(message)) busy = true;
    stack.push((node as { readonly cause?: unknown }).cause, reason);
  }
  return busy ? "busy" : undefined;
};

/** Bounded admission for one reserved connection; opened after migrations. */
export const makeReaderLanes = Effect.fnUntraced(function* <E, R>(
  make: () => Effect.Effect<Effect.Effect<Connection | undefined>, E, R>,
  /** Longest wait for the lane itself. Default: the reserved lanes' 5 s statement limit. */
  admissionLimit: Duration.Input = Duration.seconds(5),
) {
  const admissionMs = Duration.toMillis(Duration.fromInputUnsafe(admissionLimit));
  const slot = yield* Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    let waiting = 0;
    let starting = 0;
    const queueFull = () =>
      new SqlError({
        reason: classifySqliteError(new Error("Reader lane admission queue full"), {
          operation: "readerAdmission",
          message: "Reader lane admission queue full",
        }),
      });
    // Admission is bounded too (review r3): a caller still waiting for the lane
    // after admissionMs gets a typed "busy". It ran nothing, but it is not
    // marked retryable, so a retry cannot spend a second admission window.
    const admissionTimeout = () => {
      const message = `Reader lane busy: not admitted within ${admissionMs} ms`;
      return new SqlError({
        reason: classifySqliteError(new Error(message), { operation: "readerBusy", message }),
      });
    };
    // Waits, interruptibly and holding nothing afterwards, until `permits` are
    // free or the deadline passes. The probe is Semaphore's own withPermits, so
    // an interrupted or timed-out wait can never leak a permit.
    const awaitFree = (permits: number, deadline: number): Effect.Effect<void, SqlError> =>
      Effect.suspend(() => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) return Effect.fail(admissionTimeout());
        return semaphore
          .withPermits(permits)(Effect.void)
          .pipe(
            Effect.timeoutOption(Duration.millis(remaining)),
            Effect.flatMap((admitted) =>
              Option.isSome(admitted) ? Effect.void : Effect.fail(admissionTimeout()),
            ),
          );
      });
    const take = (permits: number) =>
      Effect.suspend(() => {
        if (waiting >= 256) return Effect.fail(queueFull());
        waiting++;
        const deadline = performance.now() + admissionMs;
        // takeIfAvailable takes synchronously, like Semaphore.take's last step.
        const attempt: Effect.Effect<number, SqlError> = Effect.flatMap(
          semaphore.takeIfAvailable(permits),
          (taken) =>
            taken
              ? Effect.succeed(permits)
              : Effect.flatMap(awaitFree(permits, deadline), () => attempt),
        );
        return attempt.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiting--;
            }),
          ),
        );
      });
    const lock = {
      take,
      release: (permits: number) => semaphore.release(permits),
      withPermits:
        (permits: number) =>
        <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
          Effect.suspend<A, E2 | SqlError, R2>(() => {
            if (waiting >= 256) return Effect.fail(queueFull());
            waiting++;
            const deadline = performance.now() + admissionMs;
            // Same handoff as Semaphore.withPermits: only the wait is
            // interruptible; the take and the release finalizer are atomic.
            return Effect.uninterruptibleMask((restore) => {
              const attempt: Effect.Effect<A, E2 | SqlError, R2> = Effect.flatMap(
                semaphore.takeIfAvailable(permits),
                (taken) =>
                  taken
                    ? Effect.onExit(restore(effect), () => semaphore.release(permits))
                    : Effect.flatMap(restore(awaitFree(permits, deadline)), () => attempt),
              );
              return attempt;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  waiting--;
                }),
              ),
            );
          }),
      withPermitsIfAvailable: semaphore.withPermitsIfAvailable.bind(semaphore),
    };
    const acquire = yield* make();
    const boundedAcquire = Effect.suspend(() => {
      if (starting >= 256)
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(new Error("Reader startup queue full"), {
              operation: "readerAdmission",
              message: "Reader startup queue full",
            }),
          }),
        );
      starting++;
      return acquire.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            starting--;
          }),
        ),
      );
    });
    return { acquire: boundedAcquire, lock };
  });
  return Effect.suspend(() => {
    return Effect.flatMap(slot.acquire, (connection) => {
      if (connection === undefined)
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(new Error("Reader lane unavailable"), {
              operation: "readerAdmission",
              message: "Reader lane unavailable",
            }),
          }),
        );
      return Effect.succeed({ connection, lock: slot.lock });
    });
  });
});

/** Preserve Semaphore receivers when composing writer and auth locks. */
export const bindSemaphore = (lock: Semaphore.Semaphore) => ({
  take: lock.take.bind(lock),
  release: lock.release.bind(lock),
  withPermits: lock.withPermits.bind(lock),
  withPermitsIfAvailable: lock.withPermitsIfAvailable.bind(lock),
});
