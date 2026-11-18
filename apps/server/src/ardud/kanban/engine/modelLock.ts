import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";

/** Registers ownership before an interruptible outside call can lose its result. */
export const acquire = Effect.fn("KanbanModelLock.acquire")(function* (lock: Semaphore.Semaphore) {
  return yield* Effect.acquireRelease(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        while (!(yield* lock.takeIfAvailable(1))) {
          // withPermits cleans up cancelled waits; only the masked take transfers ownership.
          yield* restore(Effect.interruptible(lock.withPermits(1)(Effect.void)));
        }
        let held = true;
        return Effect.uninterruptible(
          Effect.suspend(() => {
            if (!held) return Effect.void;
            held = false;
            return Effect.asVoid(lock.release(1));
          }),
        );
      }),
    ),
    (release) => release,
  );
});
