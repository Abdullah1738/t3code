import { assert, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";

import * as BoardLocks from "./boardLocks.ts";

it.effect("unrelated boards and single-card writes do not share a permit", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks.run(
        locks.access(
          "a",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        "card-a",
      ),
    );
    yield* Deferred.await(entered);
    yield* locks.board("b", Effect.void);
    yield* locks.run(locks.access("a", Effect.void, true), "card-b");
    const waiting = yield* Effect.forkChild(locks.run(locks.access("a", Effect.void), "card-a"));
    const broad = yield* Effect.forkChild(locks.board("a", Effect.void));
    yield* Effect.yieldNow;
    assert.isUndefined(waiting.pollUnsafe());
    assert.isUndefined(broad.pollUnsafe());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(waiting);
    yield* Fiber.join(broad);
  }),
);

it.effect("external I/O releases the permit and fences a stale completion even when caught", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let committed = false;
    let abandoned = false;
    let attempted = false;
    const first = yield* Effect.forkChild(
      locks
        .board(
          "a",
          Effect.gen(function* () {
            yield* locks
              .outside(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
                () =>
                  Effect.sync(() => {
                    abandoned = true;
                  }),
              )
              .pipe(Effect.catchCause(() => Effect.void));
            attempted = true;
            yield* locks.access(
              "a",
              Effect.sync(() => {
                committed = true;
              }),
              true,
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.board("a", locks.access("a", Effect.void, true));
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
    assert.isFalse(committed);
    assert.isTrue(attempted);
    assert.isTrue(abandoned);
    yield* locks.board("a", Effect.void);
  }),
);

it.effect("an expired waiter never writes later and returns its migration permit", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      locks.board(
        "a",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(entered);
    let written = false;
    const waiter = yield* Effect.forkChild(
      locks
        .board(
          "a",
          Effect.sync(() => {
            written = true;
          }),
        )
        .pipe(Effect.exit),
    );
    yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS + 1);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(waiter)));
    assert.isFalse(written);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* locks.exclusive(Effect.void);
    assert.isFalse(written);
  }),
);

it.effect.each([1, 2, 3])(
  "cancellation at permit transfer %i returns migration, board, and card permits",
  (transfer) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const prototype = Object.getPrototypeOf(Semaphore.makeUnsafe(1)) as Semaphore.Semaphore;
      const originalTake = prototype.take;
      const originalAvailable = prototype.takeIfAvailable;
      let victim: Fiber.Fiber<unknown, unknown> | undefined;
      let transfers = 0;
      let interrupted = false;
      const afterTransfer = (acquired: boolean) =>
        Effect.sync(() => {
          if (!acquired || interrupted || ++transfers !== transfer) return;
          interrupted = true;
          victim!.interruptUnsafe();
        });
      // Inject the interrupt after the semaphore owns the permit, before the
      // caller can record ownership. Cover both the old and current take paths.
      const take = vi.spyOn(prototype, "take").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return originalTake.call(this, permits).pipe(Effect.tap(() => afterTransfer(true)));
      });
      const available = vi.spyOn(prototype, "takeIfAvailable").mockImplementation(function (
        this: Semaphore.Semaphore,
        permits,
      ) {
        return originalAvailable.call(this, permits).pipe(Effect.tap(afterTransfer));
      });
      yield* Effect.gen(function* () {
        const cancelled = yield* Effect.forkChild(
          Effect.withFiber((fiber) => {
            victim = fiber;
            return locks.run(locks.access("a", Effect.void), "card-a");
          }),
        );
        assert.isTrue(Exit.isFailure(yield* Fiber.await(cancelled)));
        assert.isTrue(interrupted);
        const reuse = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* locks.run(locks.access("a", Effect.void), "card-a");
            yield* locks.board("a", Effect.void);
            yield* locks.exclusive(Effect.void);
          }).pipe(Effect.timeout(BoardLocks.WRITE_WAIT_MS)),
        );
        yield* TestClock.adjust(BoardLocks.WRITE_WAIT_MS + 1);
        yield* Fiber.join(reuse);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            take.mockRestore();
            available.mockRestore();
          }),
        ),
      );
    }),
);

it.effect(
  "migration fences in-flight I/O, while a different card does not invalidate a card write",
  () =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(
        locks.run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void);
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            yield* locks.access("a", Effect.void, true);
          }),
          "card-a",
        ),
      );
      yield* Deferred.await(entered);
      yield* locks.run(locks.access("a", Effect.void, true), "card-b");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);

      const enteredAgain = yield* Deferred.make<void>();
      const releaseAgain = yield* Deferred.make<void>();
      let committed = false;
      const stale = yield* Effect.forkChild(
        locks
          .board(
            "a",
            Effect.gen(function* () {
              yield* locks.outside(
                Deferred.succeed(enteredAgain, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseAgain)),
                ),
              );
              yield* locks.access(
                "a",
                Effect.sync(() => {
                  committed = true;
                }),
                true,
              );
            }),
          )
          .pipe(Effect.exit),
      );
      yield* Deferred.await(enteredAgain);
      yield* locks.exclusive(Effect.void);
      yield* Deferred.succeed(releaseAgain, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(stale)));
      assert.isFalse(committed);
    }),
);

it.effect(
  "a launch is cleaned up if a later association fails, but an attached launch is kept",
  () =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const cleaned: Array<string> = [];
      yield* locks
        .board(
          "a",
          Effect.gen(function* () {
            yield* locks.launched(
              "orphan",
              Effect.sync(() => {
                cleaned.push("orphan");
              }),
            );
            yield* locks.launched(
              "attached",
              Effect.sync(() => {
                cleaned.push("attached");
              }),
            );
            yield* locks.attached("attached");
            return yield* Effect.fail("association failed");
          }),
        )
        .pipe(Effect.ignore);
      assert.deepStrictEqual(cleaned, ["orphan"]);
      yield* locks.board("a", Effect.void);
    }),
);

it.effect(
  "busy board stress: row-scoped requests and saved answers survive unrelated writers",
  () =>
    Effect.gen(function* () {
      const measure = (scoped: boolean) =>
        Effect.gen(function* () {
          const locks = yield* BoardLocks.make();
          const release = yield* Deferred.make<void>();
          const entered = Array.from({ length: 40 }, () => Deferred.makeUnsafe<void>());
          let conflicts = 0;
          let answers = 0;
          const requests = yield* Effect.forEach(entered, (ready, index) =>
            Effect.forkChild(
              locks
                .run(
                  Effect.gen(function* () {
                    yield* locks.access(
                      "busy",
                      Effect.void,
                      index >= 20,
                      scoped ? `discussion:${index}` : undefined,
                    );
                    yield* locks.outside(
                      Deferred.succeed(ready, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      ),
                    );
                    if (index >= 20) answers += 1;
                  }),
                )
                .pipe(
                  Effect.catchCause(() =>
                    Effect.sync(() => {
                      conflicts += 1;
                    }),
                  ),
                ),
            ),
          );
          yield* Effect.forEach(entered, Deferred.await);
          yield* Effect.forEach(
            Array.from({ length: 32 }, (_, i) => i),
            (i) =>
              locks.run(
                locks.access("busy", Effect.void, true, scoped ? `card:${i}` : undefined),
                `card:${i}`,
              ),
            { concurrency: "unbounded" },
          );
          yield* Deferred.succeed(release, undefined);
          yield* Effect.forEach(requests, Fiber.join);
          return { conflicts, lostAnswers: 20 - answers };
        });
      const before = yield* measure(false);
      const after = yield* measure(true);
      assert.deepEqual(before, { conflicts: 40, lostAnswers: 20 });
      assert.deepEqual(after, { conflicts: 0, lostAnswers: 0 });
      yield* Effect.log("kanban stress (32 writers, 20 requests, 20 answers)", { before, after });
    }),
);

it.effect("row dependency still fences a same-row update during external I/O", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let overwritten = false;
    const reader = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void, false, "discussion:1");
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
            yield* locks.access(
              "a",
              Effect.sync(() => {
                overwritten = true;
              }),
              true,
              "discussion:1",
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.run(locks.access("a", Effect.void, true, "discussion:1"));
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(reader)));
    assert.isFalse(overwritten);
  }),
);

it.effect("a collection read after a row read restores broad conflict tracking", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const reader = yield* Effect.forkChild(
      locks
        .run(
          Effect.gen(function* () {
            yield* locks.access("a", Effect.void, false, "board");
            yield* locks.access("a", Effect.void);
            yield* locks.outside(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
          }),
        )
        .pipe(Effect.exit),
    );
    yield* Deferred.await(entered);
    yield* locks.run(locks.access("a", Effect.void, true, "card:other"), "other");
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(reader)));
  }),
);

it.effect("a stale read-only operation reruns before any write or external side effect", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let reads = 0;
    let sent = 0;
    yield* locks.run(
      Effect.gen(function* () {
        yield* locks.access("a", Effect.void);
        yield* locks.outside(
          Effect.gen(function* () {
            reads += 1;
            if (reads === 1)
              yield* Effect.forkChild(
                locks.run(locks.access("a", Effect.void, true), "other"),
              ).pipe(Effect.flatMap(Fiber.join));
          }),
          undefined,
          true,
        );
        yield* locks.outside(
          Effect.sync(() => {
            sent += 1;
          }),
        );
      }),
    );
    assert.strictEqual(reads, 2);
    assert.strictEqual(sent, 1);
  }),
);

/**
 * A board-wide operation that reads outside the gate, once a card write
 * lands during its first read. `fence` is what the read describes.
 */
const staleOnce = (bumpFenceDuringRead: boolean) =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let fence = 0;
    let reads = 0;
    let attempts = 0;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const read = locks.outsideRead(
      "view:thread-1",
      () => fence,
      Effect.gen(function* () {
        reads += 1;
        if (reads === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return `state-${reads}`;
      }),
    );
    const op = yield* Effect.forkChild(
      locks.board(
        "a",
        Effect.gen(function* () {
          attempts += 1;
          const seen = yield* read;
          yield* locks.access("a", Effect.void, true);
          return seen;
        }),
      ),
    );
    yield* Deferred.await(entered);
    // Another writer on the board while the read is out: the operation is stale.
    yield* locks.run(locks.access("a", Effect.void, true), "card-b");
    if (bumpFenceDuringRead) fence += 1;
    yield* Deferred.succeed(release, undefined);
    const seen = yield* Fiber.join(op);
    return { seen, reads, attempts };
  });

it.effect("a stale rerun replays its earlier read instead of queueing for it again", () =>
  Effect.gen(function* () {
    const { seen, reads, attempts } = yield* staleOnce(false);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(reads, 1);
    assert.strictEqual(seen, "state-1");
  }),
);

it.effect("a rerun reads again when the fence moved during the earlier read", () =>
  Effect.gen(function* () {
    const { seen, reads, attempts } = yield* staleOnce(true);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(reads, 2);
    assert.strictEqual(seen, "state-2");
  }),
);

it.effect("reads within one attempt and in separate operations are never replayed", () =>
  Effect.gen(function* () {
    const locks = yield* BoardLocks.make();
    let reads = 0;
    const read = locks.outsideRead(
      "view:thread-1",
      () => 0,
      Effect.sync(() => (reads += 1)),
    );
    const both = yield* locks.board(
      "a",
      Effect.gen(function* () {
        return [yield* read, yield* read] as const;
      }),
    );
    assert.deepStrictEqual(both, [1, 2]);
    assert.strictEqual(yield* locks.board("a", read), 3);
    // Outside any operation it is a plain read.
    assert.strictEqual(yield* read, 4);
  }),
);
