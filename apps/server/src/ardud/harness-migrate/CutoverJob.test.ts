import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Cutover from "./CutoverEngine.ts";
import * as Job from "./CutoverJob.ts";

const item = {
  key: "thread",
  kind: "thread",
  ref: "one",
  payload: null,
  wake: false,
  state: "planned",
  phase: "switch",
  attempts: 0,
  reason: null,
  rollbackAttempts: 0,
  rolledBack: false,
} as const;
const pending: Cutover.CutoverStatus = {
  active: true,
  completed: false,
  claimedThreadIds: [],
  claimedRuns: [],
  items: [item],
  refusals: [],
};
const completed = { ...pending, active: false, completed: true, items: [] };
const refused = { ...pending, refusals: [{ ref: "native", reason: "offline" }] };
const exhausted = (kind: "thread" | "card" | "finalize"): Cutover.CutoverStatus => ({
  ...pending,
  items: [
    {
      ...item,
      kind,
      state: "failed",
      attempts: 3,
      reason: "failed",
      rollbackAttempts: kind === "thread" ? 1 : 0,
      rolledBack: kind === "thread",
    },
  ],
});
const terminalStates = [
  completed,
  refused,
  exhausted("thread"),
  exhausted("card"),
  exhausted("finalize"),
];
const build = (run: Cutover.HarnessCutover["Service"]["run"]) => {
  const engine = Layer.succeed(Cutover.HarnessCutover, {
    run,
    status: () => Effect.succeed(pending),
    plan: () => Effect.die("job must not replan"),
  });
  return Layer.build(Job.layer.pipe(Layer.provide(engine))).pipe(
    Effect.map((context) => Context.get(context, Job.CutoverJob)),
  );
};

it.effect("does nothing on startup and retains one paced worker beyond the request scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let runs = 0;
      const nextBatch = yield* Deferred.make<void>();
      const job = yield* build(() =>
        Effect.gen(function* () {
          runs++;
          if (runs === 1) return pending;
          yield* Deferred.succeed(nextBatch, undefined);
          return completed;
        }),
      );
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(runs, 0);
      yield* Effect.scoped(job.start());
      assert.deepStrictEqual(yield* job.start(), pending);
      yield* TestClock.adjust(1_999);
      assert.strictEqual(runs, 1);
      yield* TestClock.adjust(1);
      yield* Deferred.await(nextBatch);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(runs, 2);
    }),
  ),
);

it.effect("serializes concurrent starts while the first batch is still being accepted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const competing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let runs = 0;
      const job = yield* build(() =>
        Effect.gen(function* () {
          runs++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return pending;
        }),
      );
      const first = yield* Effect.forkChild(job.start());
      yield* Deferred.await(entered);
      const second = yield* Deferred.succeed(competing, undefined).pipe(
        Effect.andThen(job.start()),
        Effect.forkChild,
      );
      yield* Deferred.await(competing);
      assert.strictEqual(runs, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(runs, 1);
    }),
  ),
);
it.effect.each(terminalStates)(
  "stops on terminal status in the first or background batch (%j)",
  (terminal) =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const immediate of [true, false]) {
          let runs = 0;
          const stopped = yield* Deferred.make<void>();
          const job = yield* build(() =>
            Effect.gen(function* () {
              runs++;
              if (!immediate && runs === 1) return pending;
              yield* Deferred.succeed(stopped, undefined);
              return terminal;
            }),
          );
          assert.deepStrictEqual(yield* job.start(), immediate ? terminal : pending);
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(stopped);
          yield* TestClock.adjust("1 minute");
          assert.strictEqual(runs, immediate ? 1 : 2);
        }
      }),
    ),
);
it.effect("a server scope restart does not resume persisted work until explicitly requested", () =>
  Effect.gen(function* () {
    let runs = 0;
    const run = () => Effect.sync(() => (++runs === 1 ? pending : completed));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const job = yield* build(run);
        yield* job.start();
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const job = yield* build(run);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(runs, 1);
        assert.deepStrictEqual(yield* job.start(), completed);
        assert.strictEqual(runs, 2);
      }),
    );
  }),
);

it.effect("keeps processing untouched work after a different item exhausts its retries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let runs = 0;
      const settled = yield* Deferred.make<void>();
      const job = yield* build(() =>
        Effect.gen(function* () {
          runs++;
          if (runs === 1) return pending;
          if (runs === 2)
            return { ...pending, items: [...exhausted("thread").items, { ...item, key: "other" }] };
          yield* Deferred.succeed(settled, undefined);
          return completed;
        }),
      );
      yield* job.start();
      yield* TestClock.adjust("2 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.await(settled);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(runs, 3);
    }),
  ),
);
