import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ActivityReadMetrics from "./ActivityReadMetrics.ts";
import { McpCall, callOutcome } from "./McpCall.ts";
const isAnalyticsEvent = Schema.is(AnalyticsEvent);

it.effect.each(["success", "interrupt"] as const)(
  "activity timings survive %s and use named spans",
  (outcome) =>
    Effect.gen(function* () {
      const state: McpCall["Service"] = {
        callerResolved: true,
        callerResolveMs: 0,
        readerLane: "background",
        phase: "handler",
        saved: "unknown",
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* ActivityReadMetrics.step(
        "history",
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan;
          assert.equal(span.name, "KanbanService.activity.load.history");
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.provideService(McpCall, state), Effect.forkChild);
      yield* Deferred.await(entered);
      const snapshot = () =>
        callOutcome(Exit.succeed({ content: [] }), state).props?.activityStages;
      assert.isFalse(snapshot()?.[0]?.completed);
      assert.isAtLeast(snapshot()?.[0]?.durationMs ?? -1, 0);
      if (outcome === "success") {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
      } else yield* Fiber.interrupt(fiber);
      assert.equal(snapshot()?.[0]?.completed, outcome === "success");
      assert.isTrue(
        isAnalyticsEvent({
          ts: "2026-11-17T00:00:00.000Z",
          kind: "mcp.call",
          surface: "server",
          route: "mcp",
          props: { activityStages: snapshot() },
        }),
      );
      assert.isFalse("started" in snapshot()![0]!);
    }),
);
