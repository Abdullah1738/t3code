import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Semaphore from "effect/Semaphore";
import { vi } from "vite-plus/test";

import * as BoardLocks from "./boardLocks.ts";
import * as ModelLock from "./modelLock.ts";

it.effect.each(["acquire", "release"] as const)(
  "cancellation at the %s boundary releases the model lock through outside",
  (boundary) =>
    Effect.gen(function* () {
      const lock = Semaphore.makeUnsafe(1);
      let releaseConstructed = false;
      const originalRelease = lock.release.bind(lock);
      const releaseSpy = vi.spyOn(lock, "release").mockImplementation((permits) => {
        releaseConstructed = true;
        return originalRelease(permits);
      });
      const base = new Scheduler.MixedScheduler();
      let victim: Fiber.Fiber<unknown, unknown> | undefined;
      let cancelled = false;
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        shouldYield: (fiber) => {
          // Interrupt after the ownership flag changes but before its permit operation completes.
          if (
            !cancelled &&
            Reflect.get(lock, "taken") === 1 &&
            (boundary === "acquire" || releaseConstructed)
          ) {
            victim = fiber;
            return true;
          }
          return base.shouldYield(fiber);
        },
        makeDispatcher: () => {
          const dispatcher = base.makeDispatcher();
          return {
            scheduleTask: (task, priority) =>
              dispatcher.scheduleTask(() => {
                if (victim !== undefined && !cancelled) {
                  cancelled = true;
                  victim.interruptUnsafe();
                }
                task();
              }, priority),
            flush: () => dispatcher.flush(),
          };
        },
      };
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const locks = yield* BoardLocks.make();
          const release = yield* locks.board(
            "model-handoff",
            locks.outside(ModelLock.acquire(lock), (release) => release, true),
          );
          yield* release;
        }),
      ).pipe(Effect.provideService(Scheduler.Scheduler, scheduler), Effect.forkChild);
      const result = yield* Fiber.await(fiber).pipe(
        Effect.ensuring(Effect.sync(() => releaseSpy.mockRestore())),
      );
      assert.isTrue(cancelled);
      assert.isTrue(Exit.isFailure(result));
      assert.isTrue(yield* lock.takeIfAvailable(1));
      assert.isFalse(yield* lock.takeIfAvailable(1));
      yield* lock.release(1);
    }),
);

it.effect("cancelling a model-lock waiter leaves the holder's permit intact", () =>
  Effect.gen(function* () {
    const lock = Semaphore.makeUnsafe(1);
    const waiting = yield* Deferred.make<void>();
    yield* lock.take(1);
    const waiter = yield* Effect.forkChild(
      Effect.scoped(
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(ModelLock.acquire(lock))),
      ),
    );
    yield* Deferred.await(waiting);
    yield* Fiber.interrupt(waiter);
    assert.isFalse(yield* lock.takeIfAvailable(1));
    yield* lock.release(1);
    assert.isTrue(yield* lock.takeIfAvailable(1));
    yield* lock.release(1);
  }),
);

it.effect("explicit model-lock release and scope cleanup release only once", () =>
  Effect.gen(function* () {
    const lock = Semaphore.makeUnsafe(1);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const release = yield* ModelLock.acquire(lock);
        assert.isFalse(yield* lock.takeIfAvailable(1));
        yield* release;
        yield* release;
      }),
    );
    assert.isTrue(yield* lock.takeIfAvailable(1));
    assert.isFalse(yield* lock.takeIfAvailable(1));
    yield* lock.release(1);
  }),
);
