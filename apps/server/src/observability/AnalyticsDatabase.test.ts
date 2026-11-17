import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as Analytics from "../ardud/analytics/Analytics.ts";
import * as AnalyticsDatabase from "./AnalyticsDatabase.ts";
import { sampleProcessDiskRead } from "./processDiskRead.ts";

const decodeEvent = Schema.decodeUnknownEffect(AnalyticsEvent, { onExcessProperty: "error" });

vi.mock("./processDiskRead.ts", async (original) => {
  let bytes = 500;
  return {
    ...(await original<typeof import("./processDiskRead.ts")>()),
    sampleProcessDiskRead: vi.fn(async () => ({ bytes: (bytes += 500), identity: "same-process" })),
  };
});

it.effect("flushes actual SQL completions once per minute through the analytics schema", () =>
  Effect.gen(function* () {
    const initialSamples = vi.mocked(sampleProcessDiskRead).mock.calls.length;
    const output = yield* Queue.unbounded<AnalyticsEvent>();
    const recorded: AnalyticsEvent[] = [];
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const analytics = Layer.effect(
      Analytics.Analytics,
      Effect.gen(function* () {
        // Match boot: analytics constructs persistence before the flushing layer.
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(vi.mocked(sampleProcessDiskRead).mock.calls.length, initialSamples + 1);
        yield* sql`SELECT 3 AS value`.pipe(Effect.withTracerEnabled(false));
        yield* TestClock.adjust("30 seconds");
        return {
          record: (event: AnalyticsEvent) =>
            decodeEvent(event).pipe(
              Effect.orDie,
              Effect.flatMap((decoded) =>
                Effect.sync(() => {
                  recorded.push(decoded);
                  Queue.offerUnsafe(output, decoded);
                }),
              ),
            ),
          flush: Effect.void,
          ingest: () => Effect.void,
          read: () => Effect.die("unused"),
        };
      }),
    ).pipe(Layer.provide(database));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1 AS value`.pipe(Effect.withTracerEnabled(false));
      yield* sql`SELECT 2 AS value`.pipe(Effect.withTracerEnabled(false));
      assert.strictEqual(recorded.length, 0);
      yield* TestClock.adjust("1 minute");
      const process = yield* Queue.take(output);
      const summary = yield* Queue.take(output);
      assert.strictEqual(process.kind, "db.process.disk_read");
      assert.strictEqual(process.props?.readBytes, 500);
      assert.strictEqual(process.props?.sampleMs, 90000);
      assert.strictEqual(summary.kind, "db.statement.summary");
      assert.strictEqual(summary.props?.count, 3);
      assert.strictEqual(summary.props?.resultCount, 3);
      assert.strictEqual(summary.props?.sampleMs, 90000);
      assert.strictEqual(JSON.stringify(summary).includes("SELECT"), true);
      assert.strictEqual("sql" in (summary.props ?? {}), false);
      yield* TestClock.adjust("1 minute");
      const next = yield* Queue.take(output);
      assert.strictEqual(next.kind, "db.process.disk_read");
      assert.strictEqual(next.props?.sampleMs, 60000);
      assert.strictEqual(
        recorded.filter((event) => event.kind === "db.statement.summary").length,
        1,
      );
    }).pipe(
      Effect.provide(
        Layer.merge(database, AnalyticsDatabase.layer).pipe(
          Layer.provide(analytics),
          Layer.provide(AnalyticsDatabase.layerStatementStats),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("records the reader workload interval and lane without SQL or bindings", () =>
  Effect.gen(function* () {
    const events: AnalyticsEvent[] = [];
    yield* Effect.gen(function* () {
      const observer = yield* NodeSqliteClient.StatementObserver;
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
        AnalyticsDatabase.layer.pipe(
          Layer.provide(
            Layer.mock(Analytics.Analytics)({
              record: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            }),
          ),
          Layer.provide(AnalyticsDatabase.layerStatementStats),
        ),
      ),
    );
    const event = events[0]!;
    assert.deepEqual(yield* decodeEvent(event), event);
    assert.equal(event.props?.readerLane, "background");
    assert.equal(event.props?.span, "KanbanThreads.find");
    assert.equal(
      DateTime.toEpochMillis(DateTime.makeUnsafe(event.ts)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(event.startedAt!)),
      200,
    );
  }).pipe(Effect.scoped),
);
