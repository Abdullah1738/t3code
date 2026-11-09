import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import type { Connection } from "effect/sql/SqlConnection";

export const ReaderLane = Context.Reference<"auth" | "identity" | "view">(
  "@t3tools/shared/nodeSqliteClient/ReaderLane",
  { defaultValue: () => "view" },
);

/** Bounded admission for one reserved connection; opened after migrations. */
export const makeReaderLanes = Effect.fnUntraced(function* <E, R>(
  make: () => Effect.Effect<Effect.Effect<Connection | undefined>, E, R>,
) {
  const slot = yield* Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    let waiting = 0;
    let starting = 0;
    const take = (permits: number) =>
      Effect.suspend(() => {
        if (waiting >= 256)
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(new Error("Reader lane admission queue full"), {
                operation: "readerAdmission",
                message: "Reader lane admission queue full",
              }),
            }),
          );
        waiting++;
        return semaphore.take(permits).pipe(
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
            if (waiting >= 256)
              return Effect.fail(
                new SqlError({
                  reason: classifySqliteError(new Error("Reader lane admission queue full"), {
                    operation: "readerAdmission",
                    message: "Reader lane admission queue full",
                  }),
                }),
              );
            waiting++;
            // Use Semaphore's own atomic acquire/finalizer handoff.
            return semaphore
              .withPermits(permits)(effect)
              .pipe(
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
