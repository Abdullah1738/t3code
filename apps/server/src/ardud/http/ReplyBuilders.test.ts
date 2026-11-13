import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ReplyBuilders from "./ReplyBuilders.ts";

it.effect.each(["agent", "interactive"] as const)(
  "%s bounds builders and releases permits after failure or interruption",
  (lane) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let peak = 0;
      let started = 0;
      const build = ReplyBuilders.bounded(
        Effect.gen(function* () {
          active++;
          peak = Math.max(peak, active);
          started++;
          if (started === 2) yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(release).pipe(Effect.ensuring(Effect.sync(() => active--)));
        }),
        lane,
      );
      const burst = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 10 }, () => build),
          { concurrency: "unbounded" },
        ),
      );
      yield* Deferred.await(ready);
      expect(started).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(burst);
      expect(peak).toBe(2);
      yield* ReplyBuilders.bounded(Effect.fail("failed"), lane).pipe(Effect.ignore);
      const held = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        ReplyBuilders.bounded(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
          lane,
        ),
      );
      yield* Deferred.await(held);
      yield* Fiber.interrupt(interrupted);
      yield* Effect.all(
        [ReplyBuilders.bounded(Effect.void, lane), ReplyBuilders.bounded(Effect.void, lane)],
        {
          concurrency: "unbounded",
        },
      );
    }).pipe(Effect.provide(ReplyBuilders.layer)),
);

it.effect("admits an interactive snapshot while agent builders and their queue are saturated", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let started = 0;
    const bulk = ReplyBuilders.bounded(
      Effect.gen(function* () {
        if (++started === 2) yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(release);
      }),
    );
    const burst = yield* Effect.all([bulk, bulk, bulk], { concurrency: "unbounded" }).pipe(
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    // Completion before releasing bulk reads proves independent admission without a timing threshold.
    expect(yield* ReplyBuilders.interactive(Effect.succeed("snapshot"))).toBe("snapshot");
    expect(started).toBe(2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(burst);
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);
