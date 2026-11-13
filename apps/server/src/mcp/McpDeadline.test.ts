import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as McpDeadline from "./McpDeadline.ts";

it.effect("returns a typed deadline even while cancellation is deferred", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const operation = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.uninterruptible,
    );
    const pending = yield* McpDeadline.withDeadline(operation, {
      code: "caller_unresolved",
      threadId: ThreadId.make("caller"),
      stage: "caller",
    }).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10 seconds");
    yield* Deferred.succeed(release, undefined);
    const error = yield* Fiber.join(pending);
    assert.equal(error.code, "caller_unresolved");
  }),
);
