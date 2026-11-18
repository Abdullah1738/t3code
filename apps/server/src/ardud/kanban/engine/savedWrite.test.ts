import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as BoardLocks from "./boardLocks.ts";
import * as SavedWrite from "./savedWrite.ts";

it.effect.each(["success", "failure"] as const)(
  "whole-call diagnostics keep outside waits out of board-hold reports on %s",
  (outcome) =>
    Effect.gen(function* () {
      const locks = yield* BoardLocks.make();
      const held = yield* Deferred.make<void>();
      const releaseHold = yield* Deferred.make<void>();
      const outside = yield* Deferred.make<void>();
      const releaseOutside = yield* Deferred.make<void>();
      const holds: Array<ReadonlyArray<SavedWrite.SubStep>> = [];
      const calls: Array<ReadonlyArray<SavedWrite.SubStep>> = [];
      const pending = yield* SavedWrite.subSteps(
        "card.reviewResult",
        locks.board(
          "a",
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHold)),
              Effect.withSpan("review.write"),
            );
            yield* locks.outside(
              Deferred.succeed(outside, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOutside)),
                Effect.withSpan("review.cancelQueued"),
              ),
            );
            if (outcome === "failure") return yield* Effect.fail("cancellation failed");
          }),
        ),
        true,
      ).pipe(
        Effect.exit,
        Effect.provideService(SavedWrite.subStepReporter, (steps) => holds.push(steps)),
        Effect.provideService(SavedWrite.callSubStepReporter, (steps) => calls.push(steps)),
        Effect.forkChild,
      );
      yield* Deferred.await(held);
      yield* TestClock.adjust(6_000);
      yield* Deferred.succeed(releaseHold, undefined);
      yield* Deferred.await(outside);
      assert.deepEqual(yield* locks.holders, []);
      assert.deepEqual(holds, [[{ subStep: "review.write", ms: 6_000 }]]);
      yield* TestClock.adjust(8_000);
      yield* Deferred.succeed(releaseOutside, undefined);
      assert.equal(Exit.isFailure(yield* Fiber.join(pending)), outcome === "failure");
      assert.deepEqual(holds, [[{ subStep: "review.write", ms: 6_000 }]]);
      assert.deepEqual(calls, [
        [
          { subStep: "review.cancelQueued", ms: 8_000 },
          { subStep: "review.write", ms: 6_000 },
        ],
      ]);
    }),
);
