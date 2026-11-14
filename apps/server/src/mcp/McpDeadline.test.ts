import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as McpDeadline from "./McpDeadline.ts";

it.effect("a fail-fast caller error retains the same-key retry instruction", () =>
  Effect.gen(function* () {
    const error = yield* McpDeadline.withDeadline(
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "caller_unresolved",
          message: "Reader unavailable. Nothing was saved; retry the same call.",
        }),
      ),
      {
        code: "caller_unresolved",
        threadId: ThreadId.make("caller"),
        stage: "caller",
        requestKey: "same-key",
      },
    ).pipe(Effect.flip);
    assert.equal(error.code, "caller_unresolved");
    assert.equal(
      error.message,
      "Reader unavailable. Nothing was saved; retry the same call. Retry only with the same clientRequestId: same-key.",
    );
  }),
);

it.effect("an outer deadline reports the nested caller read that is still pending", () =>
  Effect.gen(function* () {
    const advance = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    const input = {
      code: "caller_unresolved",
      stage: "caller",
      threadId: ThreadId.make("caller"),
    } as const;
    const pending = yield* McpDeadline.withDeadline(
      McpDeadline.waitingOn(Deferred.await(advance), "statev2 foreground caller row").pipe(
        Effect.andThen(
          McpDeadline.withDeadline(
            McpDeadline.waitingOn(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              "statev2 background caller shell",
            ),
            input,
          ),
        ),
      ),
      input,
    ).pipe(
      Effect.flip,
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.forkChild,
    );
    yield* TestClock.adjust("2 seconds");
    yield* Deferred.succeed(advance, undefined);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("8 seconds");
    assert.equal((yield* Fiber.join(pending)).code, "caller_unresolved");
    assert.deepEqual(logs, [
      [
        "MCP operation timed out",
        {
          code: "caller_unresolved",
          stage: "caller",
          threadId: "caller",
          threadKind: "thread",
          elapsedMs: 10000,
          wait: "statev2 background caller shell",
          waitElapsedMs: 8000,
        },
      ],
    ]);
  }),
);

it.effect.each(["caller", "parent_records", "dispatch", "receipt"] as const)(
  "logs elapsed time and the pending operation when $stage expires",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const logs: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      const pending = yield* McpDeadline.withDeadline(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        {
          code: stage === "caller" ? "caller_unresolved" : "delegation_timeout",
          stage,
          threadId: ThreadId.make("caller"),
          wait: stage === "caller" ? "caller identity" : `threadManagement.${stage}`,
        },
      ).pipe(
        Effect.flip,
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      const failure = yield* Fiber.join(pending);
      assert.equal(failure.code, stage === "caller" ? "caller_unresolved" : "delegation_timeout");
      if (stage === "parent_records") {
        assert.equal(
          failure.message,
          "delegate_task timed out during parent_records for thread caller. Nothing was saved; retry the same call.",
        );
      }
      assert.deepEqual(logs, [
        [
          "MCP operation timed out",
          {
            code: failure.code,
            stage,
            threadId: "caller",
            threadKind: "thread",
            elapsedMs: 10000,
            wait: stage === "caller" ? "caller identity" : `threadManagement.${stage}`,
            waitElapsedMs: 10000,
          },
        ],
      ]);
    }),
);

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

it.effect("logs a delegated caller's pending foreground read without changing its deadline", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    const threadId = ThreadId.make("thread:delegated-task:caller");
    const pending = yield* McpDeadline.withDeadline(
      McpDeadline.waitingOn(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        "statev2 foreground caller row",
      ),
      { code: "caller_unresolved", threadId, stage: "caller" },
    ).pipe(
      Effect.flip,
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10 seconds");
    const failure = yield* Fiber.join(pending);
    assert.equal(failure.code, "caller_unresolved");
    assert.equal(
      failure.message,
      `Caller resolution timed out during caller for thread ${threadId}. Nothing was saved; retry the same call.`,
    );
    assert.deepEqual(logs, [
      [
        "MCP operation timed out",
        {
          code: "caller_unresolved",
          stage: "caller",
          threadId,
          threadKind: "delegated-task",
          elapsedMs: 10000,
          wait: "statev2 foreground caller row",
          waitElapsedMs: 10000,
        },
      ],
    ]);
  }),
);

it.effect.each([
  {
    code: "delegation_timeout",
    stage: "dispatch",
    taskId: "task",
    message:
      "delegate_task timed out during dispatch for thread caller. Task task may still be created; check it with task_status. Retry only with the same clientRequestId: retry.",
  },
  {
    code: "delegation_timeout",
    stage: "dispatch",
    taskId: undefined,
    message:
      "delegate_task timed out during dispatch for thread caller. Creation may still complete. Retry only with the same clientRequestId: retry.",
  },
  {
    code: "delegation_timeout",
    stage: "caller",
    taskId: "task",
    message:
      "delegate_task timed out during caller for thread caller. Task task was accepted; use task_status to recover it. Retry only with the same clientRequestId: retry.",
  },
  {
    code: "caller_unresolved",
    stage: "records",
    taskId: "task",
    message:
      "Caller resolution timed out during records for thread caller. Task task was accepted; use task_status to recover it. Retry only with the same clientRequestId: retry.",
  },
] as const)("preserves $code text during $stage", ({ code, stage, taskId, message }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const pending = yield* McpDeadline.withDeadline(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      {
        code,
        stage,
        threadId: ThreadId.make("caller"),
        ...(taskId === undefined ? {} : { taskId }),
        requestKey: "retry",
      },
    ).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10 seconds");
    assert.equal((yield* Fiber.join(pending)).message, message);
  }),
);

it.effect.each(["catalog", "request_key", "receipt", "settings", "selection", "workspace"])(
  "a pre-dispatch %s timeout says nothing was saved",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const pending = yield* McpDeadline.withDeadline(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
        {
          code: "delegation_timeout",
          stage,
          threadId: ThreadId.make("caller"),
          requestKey: "retry",
        },
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      assert.equal(
        (yield* Fiber.join(pending)).message,
        `delegate_task timed out during ${stage} for thread caller. Nothing was saved; retry the same call. Retry only with the same clientRequestId: retry.`,
      );
      yield* Deferred.await(stopped);
    }),
);

it.effect.each([
  { outcome: "committed", masked: false },
  { outcome: "failed", masked: false },
  { outcome: "capped", masked: false },
  { outcome: "capped", masked: true },
] as const)(
  "a detached create logs $outcome (masked=$masked) and cleans up its watchdog",
  ({ outcome, masked }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const capLogged = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const logs: Array<Record<string, unknown>> = [];
      const logger = Logger.make(({ message }) => {
        if (!Array.isArray(message) || message[0] !== "MCP detached operation finished") return;
        const fields: unknown = message[1];
        if (typeof fields !== "object" || fields === null || !("outcome" in fields)) return;
        logs.push({ ...fields });
        Deferred.doneUnsafe(fields.outcome === "capped" ? capLogged : settled, Effect.void);
      });
      let commits = 0;
      const operation = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          outcome === "failed"
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "create failed",
                }),
              )
            : Effect.sync(() => {
                commits++;
              }),
        ),
        Effect.ensuring(Deferred.succeed(stopped, undefined)),
      );
      const pending = yield* McpDeadline.withDeadline(
        masked ? Effect.uninterruptible(operation) : operation,
        {
          code: "delegation_timeout",
          stage: "dispatch",
          threadId: ThreadId.make("caller"),
          requestKey: "retry",
          taskId: "task",
          onTimeout: "detach",
        },
      ).pipe(
        Effect.flip,
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(pending)).code, "delegation_timeout");
      assert.equal(commits, 0);
      assert.isFalse(yield* Deferred.isDone(stopped));
      if (outcome === "capped") {
        yield* TestClock.adjust("110 seconds");
        yield* Deferred.await(capLogged);
        assert.deepEqual(logs[0], {
          outcome: "capped",
          requestKey: "retry",
          taskId: "task",
          cancellationPending: true,
        });
        if (masked) assert.isFalse(yield* Deferred.isDone(stopped));
      }
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);
      yield* Deferred.await(stopped);
      const expectedCommits = outcome === "committed" || masked ? 1 : 0;
      assert.equal(commits, expectedCommits);
      if (outcome === "capped") {
        assert.lengthOf(logs, 2);
        assert.deepInclude(logs[1], { requestKey: "retry", taskId: "task", afterCap: true });
        assert.oneOf(logs[1]!.outcome, ["committed", "failed"]);
      } else assert.deepEqual(logs, [{ outcome, requestKey: "retry", taskId: "task" }]);
      const logCount = logs.length;
      yield* TestClock.adjust("2 minutes");
      assert.equal(commits, expectedCommits);
      assert.equal(logs.length, logCount);
    }),
);
