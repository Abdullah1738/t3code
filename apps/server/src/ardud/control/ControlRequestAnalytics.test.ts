import { assert, it } from "@effect/vitest";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Analytics from "../analytics/Analytics.ts";
import { accumulate, finishRollup, makeAccumulator } from "../analytics/rollup.ts";
import { observe, sendMode } from "./ControlRequestAnalytics.ts";

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
