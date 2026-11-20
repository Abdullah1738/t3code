import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TickTimings from "./tickTimings.ts";

it.effect("attributes inclusive reads without changing the phase wall-time partition", () =>
  Effect.gen(function* () {
    let now = 0;
    const timing = TickTimings.make(() => now);
    const first = timing.enter("thread_status");
    const firstRead = timing.read("find", "workerBackstop");
    now = 10;
    const second = timing.enter("thread_status");
    const secondRead = timing.read("view", "typing");
    now = 20;
    firstRead();
    firstRead();
    first();
    now = 30;
    secondRead();
    second();
    const result = timing.finish();
    assert.equal(result.durationMs, 30);
    assert.equal(result.phases.find((phase) => phase.phase === "thread_status")?.durationMs, 30);
    assert.deepStrictEqual(result.byRead, {
      find: { count: 1, ms: 20 },
      view: { count: 1, ms: 20 },
    });
    assert.deepStrictEqual(result.byStep, {
      workerBackstop: { count: 1, ms: 20 },
      typing: { count: 1, ms: 20 },
    });
    now = 100;
    timing.read("find", "late")();
    assert.deepStrictEqual(result.byRead.find, { count: 1, ms: 20 });
  }),
);

it.effect("attributes a failed read to its fiber's step and releases its timing", () =>
  Effect.gen(function* () {
    let now = 0;
    const timing = TickTimings.make(() => now);
    yield* TickTimings.threadRead(
      "find",
      Effect.sync(() => {
        now = 15;
      }).pipe(Effect.andThen(Effect.fail("read failed"))),
    ).pipe(
      Effect.provideService(TickTimings.current, timing),
      Effect.provideService(TickTimings.step, "turnEnd"),
      Effect.flip,
    );
    now = 20;
    const result = timing.finish();
    assert.deepStrictEqual(result.byStep, { turnEnd: { count: 1, ms: 15 } });
    assert.equal(result.phases.find((phase) => phase.phase === "thread_status")?.durationMs, 15);
  }),
);
