import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeStaleWhileRevalidate } from "./staleWhileRevalidate.ts";

it.effect("joins one computation, serves stale values, and refreshes in the background", () =>
  Effect.gen(function* () {
    let runs = 0;
    const gate = yield* Deferred.make<void>();
    const cached = makeStaleWhileRevalidate(
      Effect.gen(function* () {
        runs += 1;
        if (runs === 1) yield* Deferred.await(gate);
        return runs;
      }),
      1_000,
    );

    const first = yield* Effect.forkChild(cached);
    const second = yield* Effect.forkChild(cached);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, undefined);
    expect(yield* Fiber.join(first)).toBe(1);
    expect(yield* Fiber.join(second)).toBe(1);
    expect(runs).toBe(1);

    // Fresh: no recompute.
    expect(yield* cached).toBe(1);
    expect(runs).toBe(1);

    // Stale: the old value comes back at once and one refresh runs.
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* cached).toBe(1);
    yield* Effect.yieldNow;
    expect(runs).toBe(2);
    expect(yield* cached).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a caller's timeout does not cancel the shared computation", () =>
  Effect.gen(function* () {
    let runs = 0;
    const cached = makeStaleWhileRevalidate(
      Effect.gen(function* () {
        runs += 1;
        yield* Effect.sleep(Duration.seconds(10));
        return "done";
      }),
      60_000,
    );

    const timedOut = yield* Effect.forkChild(
      cached.pipe(Effect.timeoutOption(Duration.seconds(1))),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(1));
    expect((yield* Fiber.join(timedOut))._tag).toBe("None");

    const later = yield* Effect.forkChild(cached);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(9));
    expect(yield* Fiber.join(later)).toBe("done");
    expect(runs).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);
