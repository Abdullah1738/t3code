import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { shutdownWithinBudget } from "./shutdown.ts";

it.effect(
  "reaches provider cleanup and checkpoint within nine seconds when every phase stalls",
  () =>
    Effect.gen(function* () {
      const phases = yield* Ref.make<string[]>([]);
      const stall = (name: string) =>
        Ref.update(phases, (xs) => [...xs, name]).pipe(Effect.andThen(Effect.never));
      const fiber = yield* shutdownWithinBudget({
        prepare: stall("prepare"),
        closeProviders: stall("providers"),
        checkpoint: stall("checkpoint"),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      yield* Fiber.join(fiber);
      assert.deepEqual(yield* Ref.get(phases), ["prepare", "providers", "checkpoint"]);
    }),
);

it.effect("still closes providers after preparation fails", () =>
  Effect.gen(function* () {
    let closed = false;
    yield* shutdownWithinBudget({
      prepare: Effect.fail("prepare failed"),
      closeProviders: Effect.sync(() => {
        closed = true;
      }),
      checkpoint: Effect.void,
    });
    assert.isTrue(closed);
  }),
);
