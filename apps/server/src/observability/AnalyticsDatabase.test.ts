import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import { layer } from "./AnalyticsDatabase.ts";

const decodeAnalyticsEvent = Schema.decodeUnknownEffect(AnalyticsEvent, {
  onExcessProperty: "error",
});

it.effect("records the reader workload interval and lane without SQL or bindings", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    yield* Effect.gen(function* () {
      const observer = yield* Sqlite.StatementObserver;
      yield* observer!.record({
        operation: "read",
        connection: "reader",
        lane: "background",
        durationMs: 200,
        span: "KanbanThreads.find",
        outcome: "success",
      });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
          ),
        ),
      ),
    );
    const event = events[0]!;
    assert.deepEqual(yield* decodeAnalyticsEvent(event), event);
    assert.equal(event.props?.readerLane, "background");
    assert.equal(event.props?.span, "KanbanThreads.find");
    assert.equal(
      DateTime.toEpochMillis(DateTime.makeUnsafe(event.ts)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(event.startedAt!)),
      200,
    );
  }),
);
