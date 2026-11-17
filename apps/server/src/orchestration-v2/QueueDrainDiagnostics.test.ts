import { assert, it } from "@effect/vitest";
import { RunId, AnalyticsEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as QueueDrainDiagnostics from "./QueueDrainDiagnostics.ts";

const decodeRow = Schema.decodeUnknownEffect(AnalyticsEvent, { onExcessProperty: "error" });

it.effect("limits each thread and reason independently and expires the limit", () => {
  const rows: AnalyticsEvent[] = [];
  return Effect.gen(function* () {
    const { skipped } = yield* QueueDrainDiagnostics.make;
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
    const { skipped } = yield* QueueDrainDiagnostics.make;
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

it.effect.each([
  ["restart_admission_timeout", "restart_admission_timeout"],
  ["provider timed out", "unknown"],
  ["provider\ttimed_out", "unknown"],
  ["provider_error!", "unknown"],
  ["provider_error…", "unknown"],
  ["e".repeat(160), "e".repeat(160)],
  ["e".repeat(161), "unknown"],
] as const)(
  "records one schema-safe terminal outcome for failure code %s",
  ([failureCode, expectedCode]) => {
    const rows: AnalyticsEvent[] = [];
    return Effect.gen(function* () {
      const { terminal } = yield* QueueDrainDiagnostics.make;
      const input = {
        threadId: "thread:one",
        failedRunId: RunId.make("run:failed"),
        failureCode,
        outcome: { reason: "pending_continuation" },
      };
      yield* terminal(input);
      yield* terminal(input);
      assert.lengthOf(rows, 1);
      yield* decodeRow(rows[0]);
      assert.deepInclude(rows[0]!, {
        kind: "orchestration.never_started_terminal_drain",
        threadId: input.threadId,
      });
      assert.deepEqual(rows[0]!.props, {
        failedRunId: input.failedRunId,
        failureCode: expectedCode,
        reason: "pending_continuation",
      });
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
  },
);
