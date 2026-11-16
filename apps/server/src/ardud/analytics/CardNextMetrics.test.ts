import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import { McpCall } from "./McpCall.ts";
import * as CardNextMetrics from "./CardNextMetrics.ts";

const isAnalyticsEvent = Schema.is(AnalyticsEvent);

it.effect.each(["success", "interrupt"] as const)(
  "captures an unfinished acquisition before %s",
  (exit) =>
    Effect.gen(function* () {
      const state: McpCall["Service"] = {
        callerResolved: false,
        callerResolveMs: 0,
        readerLane: "background",
        phase: "handler",
        saved: "unknown",
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* CardNextMetrics.stage(
        "caller",
        Effect.gen(function* () {
          (yield* Sqlite.ReaderWaitStartedObserver)?.("foreground");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          (yield* Sqlite.ReaderWaitObserver)?.(2000, "foreground");
          (yield* Sqlite.StatementTimingObserver)?.({
            operation: "read",
            connection: "reader",
            lane: "foreground",
            durationMs: 12,
            outcome: "success",
          });
          return {};
        }),
      ).pipe(
        CardNextMetrics.observe,
        Sqlite.foregroundReads,
        Effect.provideService(McpCall, state),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(2000);
      const snapshot = CardNextMetrics.snapshot(state.cardNext!, yield* Clock.monotonicTimeNanos);
      assert.deepEqual(snapshot.cardNextStages, [
        { stage: "caller", durationMs: 2000, readerWaitMs: 2000, queryMs: 0, completed: false },
      ]);
      assert.isTrue(
        isAnalyticsEvent({
          ts: "2026-11-15T00:00:00.000Z",
          kind: "mcp.call",
          surface: "server",
          route: "mcp",
          ...snapshot,
        }),
      );
      if (exit === "success") {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        assert.isTrue(state.callerResolved);
        assert.equal(state.readerLane, "foreground");
        assert.equal(state.cardNext!.stages[0]!.queryMs, 12);
      } else {
        yield* Fiber.interrupt(fiber);
        assert.isFalse(state.callerResolved);
        assert.isFalse(state.cardNext!.stages[0]!.completed);
      }
      assert.equal(state.callerResolveMs, 2000);
      assert.isFalse(snapshot.cardNextStages[0]!.completed);
      assert.equal(snapshot.cardNextStages[0]!.queryMs, 0);
    }),
);

it.effect("aggregates repeated rule passes and records the actual fallback lane", () =>
  Effect.gen(function* () {
    const state: McpCall["Service"] = {
      callerResolved: false,
      callerResolveMs: 0,
      readerLane: "background",
      phase: "handler",
      saved: "unknown",
    };
    yield* Effect.gen(function* () {
      for (let i = 0; i < 2; i++)
        yield* CardNextMetrics.stage(
          "rules",
          Effect.gen(function* () {
            const finish = (yield* Sqlite.ReaderWaitStartedObserver)?.("foreground");
            finish?.("writer", false);
            assert.equal(state.readerLane, "writer");
            finish?.("writer", true);
            (yield* Sqlite.ReaderWaitObserver)?.(0, "foreground");
            assert.equal(state.readerLane, "writer");
            (yield* Sqlite.StatementTimingObserver)?.({
              operation: "read",
              connection: "writer",
              durationMs: 5,
              outcome: "success",
            });
          }),
        );
    }).pipe(CardNextMetrics.observe, Sqlite.foregroundReads, Effect.provideService(McpCall, state));
    assert.equal(state.readerLane, "writer");
    assert.lengthOf(state.cardNext!.stages, 1);
    assert.equal(state.cardNext!.stages[0]!.queryMs, 10);
    assert.equal(state.cardNext!.stages[0]!.readerWaitMs, 0);
  }),
);

it.effect("adds both caller lookups once and clears resolution while the second is pending", () =>
  Effect.gen(function* () {
    const state: McpCall["Service"] = {
      callerResolved: false,
      callerResolveMs: 0,
      readerLane: "background",
      phase: "handler",
      saved: "unknown",
    };
    yield* Effect.gen(function* () {
      yield* CardNextMetrics.stage("caller", TestClock.adjust(10).pipe(Effect.as({})));
      assert.isTrue(state.callerResolved);
      yield* CardNextMetrics.stage(
        "caller",
        Effect.gen(function* () {
          assert.isFalse(state.callerResolved);
          yield* TestClock.adjust(20);
          return {};
        }),
      );
    }).pipe(CardNextMetrics.observe, Effect.provideService(McpCall, state));
    assert.equal(state.callerResolveMs, 30);
    assert.equal(state.cardNext!.stages[0]!.durationMs, 30);
    assert.lengthOf(state.cardNext!.stages, 1);
    assert.isTrue(state.callerResolved);
  }),
);
