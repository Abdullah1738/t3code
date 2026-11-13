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
    assert.equal(
      error.message,
      "Caller resolution timed out during caller for thread caller. Nothing was saved; retry the same call.",
    );
  }),
);

it.effect.each([
  {
    code: "delegation_timeout",
    stage: "dispatch",
    message:
      "delegate_task timed out during dispatch for thread caller. Creation may still complete. Task task was accepted; use task_status to recover it. Retry only with the same clientRequestId: retry.",
  },
  {
    code: "delegation_timeout",
    stage: "caller",
    message:
      "delegate_task timed out during caller for thread caller. Task task was accepted; use task_status to recover it. Retry only with the same clientRequestId: retry.",
  },
  {
    code: "caller_unresolved",
    stage: "records",
    message:
      "Caller resolution timed out during records for thread caller. Task task was accepted; use task_status to recover it. Retry only with the same clientRequestId: retry.",
  },
] as const)("preserves $code text during $stage", ({ code, stage, message }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const pending = yield* McpDeadline.withDeadline(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      {
        code,
        stage,
        threadId: ThreadId.make("caller"),
        taskId: "task",
        requestKey: "retry",
      },
    ).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10 seconds");
    assert.equal((yield* Fiber.join(pending)).message, message);
  }),
);
