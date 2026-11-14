import { assert, it } from "@effect/vitest";
import { AnalyticsEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Analytics from "../analytics/Analytics.ts";
import { accumulate, finishRollup, makeAccumulator } from "../analytics/rollup.ts";
import { observe, sendMode } from "./ControlRequestAnalytics.ts";

const decodeAnalyticsEvent = Schema.decodeUnknownSync(AnalyticsEvent, {
  onExcessProperty: "error",
});

it.effect(
  "records canonical routes, response status and setup duration in spans and hourly analytics",
  () =>
    Effect.gen(function* () {
      const samples: AnalyticsEvent[] = [];
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* observe(
        "control.events",
        TestClock.adjust("25 millis").pipe(
          Effect.as(HttpServerResponse.stream(Stream.never, { status: 200 })),
        ),
        { path: "/api/ardud/control/events", method: "GET" },
      ).pipe(
        Effect.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                samples.push(event);
              }),
          }),
        ),
        Effect.withTracer(tracer),
      );
      assert.equal(samples.length, 1);
      assert.deepEqual(decodeAnalyticsEvent(samples[0]), samples[0]);
      assert.equal(samples[0]!.durationMs, 25);
      assert.equal(samples[0]!.route, "control.events");
      assert.equal(samples[0]!.props!.httpRoute, "/api/ardud/control/events");
      assert.equal(samples[0]!.props!.httpMethod, "GET");
      assert.equal(samples[0]!.props!.status, 200);
      const span = spans.find((span) => span.name === "ArdudControl.request")!;
      assert.deepInclude(Object.fromEntries(span.attributes), {
        "http.route": "/api/ardud/control/events",
        "http.request.method": "GET",
        "http.response.status_code": 200,
        "control.duration_ms": 25,
      });
      const accumulator = makeAccumulator();
      for (const sample of samples) accumulate(accumulator, sample);
      const rows = finishRollup(
        accumulator,
        "2026-01-01",
        "2026-01-01T00:00:00.000Z",
      ).controlRoutes!;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.p95Ms, 25);
      assert.deepEqual(rows[0]!.statuses, { "200": 1 });
    }),
);

it.effect(
  "rolls up identity, dispatch, steer and request reads with total, reader wait and outcome",
  () =>
    Effect.gen(function* () {
      const samples: AnalyticsEvent[] = [];
      yield* Effect.gen(function* () {
        for (const [method, mode, status] of [
          ["control.identity.resolve", null, 200],
          ["control.send", "auto", 200],
          ["control.send", "steer", 409],
          ["control.send", "queue", 200],
          ["control.send", "restart", 200],
          ["control.requests", null, 503],
          ["control.thread", null, 200],
          ["control.messages", null, 200],
        ] as const) {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            observe(
              method,
              Effect.gen(function* () {
                if (mode !== null) yield* sendMode(mode);
                const readerWait = yield* NodeSqliteClient.ReaderWaitObserver;
                readerWait?.(40);
                readerWait?.(10);
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return HttpServerResponse.empty({ status });
              }),
            ),
          );
          yield* Deferred.await(entered);
          yield* TestClock.adjust("100 millis");
          yield* Deferred.succeed(release, undefined);
          assert.equal((yield* Fiber.join(fiber)).status, status);
        }
      }).pipe(
        Effect.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                samples.push(event);
              }),
          }),
        ),
      );
      const accumulator = makeAccumulator();
      for (const event of samples) {
        assert.equal(event.kind, "rpc.request");
        assert.equal(event.durationMs, 100);
        assert.equal(event.props?.waitMs, 50);
        assert.equal(event.outcome, event.props!.status! >= 400 ? "error" : "ok");
        accumulate(accumulator, event);
      }
      assert.equal(samples.length, 8);
      const rollup = finishRollup(accumulator, "2026-01-01", "2026-01-01T00:00:00.000Z");
      assert.sameMembers(
        rollup.topSlowRpcs.map((x) => x.method),
        [
          "control.identity.resolve",
          "control.send.auto",
          "control.send.steer",
          "control.send.queue",
          "control.send.restart",
          "control.requests",
          "control.thread",
          "control.messages",
        ],
      );
      for (const method of rollup.topSlowRpcs) {
        assert.equal(method.count, 1);
        assert.equal(method.maxMs, 100);
        assert.equal(method.totalWaitMs, 50);
        assert.deepEqual(
          method.outcomes,
          ["control.send.steer", "control.requests"].includes(method.method)
            ? { error: 1 }
            : { ok: 1 },
        );
      }
    }),
);

it.effect("records interruption and preserves the request exit when analytics defects", () =>
  Effect.gen(function* () {
    const samples: AnalyticsEvent[] = [];
    const entered = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      observe(
        "control.requests",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(
        Effect.provide(
          Layer.mock(Analytics.Analytics)({
            record: (event) =>
              Effect.sync(() => {
                samples.push(event);
              }),
          }),
        ),
      ),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.outcome, "interrupted");
    const response = yield* observe(
      "control.identity.resolve",
      Effect.succeed(HttpServerResponse.empty({ status: 200 })),
    ).pipe(
      Effect.provide(Layer.mock(Analytics.Analytics)({ record: () => Effect.die("observer") })),
    );
    assert.equal(response.status, 200);
  }),
);
