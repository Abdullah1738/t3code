import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ReplyBuilders from "./ReplyBuilders.ts";

it.effect("shares two builder permits and releases them after failure or interruption", () =>
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
    yield* ReplyBuilders.bounded(Effect.fail("failed")).pipe(Effect.ignore);
    const held = yield* Deferred.make<void>();
    const interrupted = yield* Effect.forkChild(
      ReplyBuilders.bounded(Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
    );
    yield* Deferred.await(held);
    yield* Fiber.interrupt(interrupted);
    yield* Effect.all([ReplyBuilders.bounded(Effect.void), ReplyBuilders.bounded(Effect.void)], {
      concurrency: "unbounded",
    });
  }).pipe(Effect.provide(ReplyBuilders.layer)),
);
