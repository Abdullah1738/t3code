import { assert, it } from "@effect/vitest";
import { RunId, type AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as QueueDrainDiagnostics from "./QueueDrainDiagnostics.ts";

it.effect("limits each thread and reason independently and expires the limit", () => {
  const rows: AnalyticsEvent[] = [];
  return Effect.gen(function* () {
    const skipped = yield* QueueDrainDiagnostics.make;
    const input = {
      threadId: "thread:one",
      reason: "usage_limit",
      queuedCount: 16,
      head: { id: RunId.make("run:head"), ordinal: 84 },
    };
    yield* skipped(input);
    yield* skipped(input);
    yield* skipped({ ...input, reason: "no_eligible" });
    yield* skipped({ ...input, threadId: "thread:two" });
    assert.lengthOf(rows, 3);
    assert.deepInclude(rows[0]!, {
      kind: "orchestration.queue_drain_skipped",
      threadId: "thread:one",
    });
    assert.deepEqual(rows[0]!.props, {
      reason: "usage_limit",
      queuedCount: 16,
      headRunId: "run:head",
      headOrdinal: 84,
    });
    yield* TestClock.adjust("599999 millis");
    yield* skipped(input);
    assert.lengthOf(rows, 3);
    yield* TestClock.adjust("1 millis");
    yield* skipped(input);
    assert.lengthOf(rows, 4);
  }).pipe(
    Effect.provide(
      Layer.mock(Analytics.Analytics)({
        record: (row) =>
          Effect.sync(() => {
            rows.push(row);
          }),
      }),
    ),
  );
});

it.effect("an analytics failure cannot fail queue processing", () =>
  Effect.gen(function* () {
    const skipped = yield* QueueDrainDiagnostics.make;
    yield* skipped({
      threadId: "thread:one",
      reason: "no_eligible",
      queuedCount: 0,
      head: undefined,
    });
  }).pipe(
    Effect.provide(Layer.mock(Analytics.Analytics)({ record: () => Effect.die("writer down") })),
  ),
);
