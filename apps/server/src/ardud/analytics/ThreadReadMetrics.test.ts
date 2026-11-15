import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as SqliteClient from "@t3tools/shared/nodeSqliteClient";
import { McpCall } from "./McpCall.ts";
import * as ThreadReadMetrics from "./ThreadReadMetrics.ts";

it.effect.each(["success", "interrupt"] as const)("preserves read stages on %s", (exit) =>
  Effect.gen(function* () {
    const state: McpCall["Service"] = {
      callerResolved: false, callerResolveMs: 0, readerLane: "background",
      phase: "handler", saved: "unknown",
      threadRead: { readerWaitMs: 0, queryMs: 0, renderMs: 0, threadReadStages: [] },
    };
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let parentWait = 0;
    const call = yield* ThreadReadMetrics.read("timeline", Effect.gen(function* () {
      const observer = yield* SqliteClient.ReaderWaitObserver;
      observer?.(70);
      const statements = yield* SqliteClient.StatementObserver;
      yield* statements!.record({ operation: "read", connection: "reader", durationMs: 20, waitMs: 70, outcome: "success" });
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    })).pipe(
      Effect.provideService(McpCall, state),
      Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => { parentWait += ms; }),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust(100);
    const shutdown = ThreadReadMetrics.snapshot(state.threadRead!, yield* Clock.monotonicTimeNanos);
    assert.deepEqual(shutdown, {
      readerWaitMs: 70, queryMs: 20, renderMs: 0,
      threadReadStages: [{ stage: "timeline", durationMs: 100, readerWaitMs: 70, queryMs: 20, completed: false }],
    });
    if (exit === "success") {
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(call);
    } else yield* Fiber.interrupt(call);
    assert.isFalse(shutdown.threadReadStages[0]!.completed, "a captured shutdown row must not mutate");
    assert.equal(parentWait, 70);
    assert.deepEqual(state.threadRead, {
      readerWaitMs: 70, queryMs: 20, renderMs: 0,
      threadReadStages: [{ stage: "timeline", durationMs: 100, readerWaitMs: 70, queryMs: 20, completed: true }],
    });
  }),
);
