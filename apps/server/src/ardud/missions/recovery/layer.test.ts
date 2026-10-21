import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { laneThread, masterThread } from "../asks/AsksService.testkit.ts";
import { recoveryTakesRestartedRun } from "./continuationGate.ts";
import { RecoveryLoops } from "./layer.ts";
import { harness, world } from "./testkit.ts";

const threads = [laneThread, masterThread, ThreadId.make("t-stranger")];
const started = { startedAt: DateTime.makeUnsafe("2026-10-17T09:00:00.000Z") };
const root = (id: ThreadId) => ({
  id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
});
const taken = (threadId: ThreadId) => recoveryTakesRestartedRun(root(threadId), started);

/** Which threads Robob's restart continuation leaves to recovery, while and after the loops run. */
const ownership = (env: Record<string, string>) => {
  const { layer } = harness();
  return Effect.gen(function* () {
    yield* world();
    const loops = RecoveryLoops.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
    const running = yield* Layer.build(loops).pipe(
      Effect.andThen(Effect.forEach(threads, taken)),
      Effect.scoped,
    );
    const stopped = yield* Effect.forEach(threads, taken);
    return { running, stopped };
  }).pipe(Effect.provide(layer));
};

it.effect("recovery takes over the restart continuation of mission members only", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* ownership({}), {
      running: [true, true, false],
      stopped: [false, false, false],
    });
  }),
);

it.effect("with recovery off, Robob continues every cut turn as before", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* ownership({ T3CODE_ARDUD_MISSIONS_RECOVERY: "false" }), {
      running: [false, false, false],
      stopped: [false, false, false],
    });
  }),
);

/** How often recovery released the router's boot hold: at build, then after the boot delay. */
const bootPasses = (env: Record<string, string>) => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* world();
    const loops = RecoveryLoops.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );
    return yield* Layer.build(loops).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const atBuild = fake.bootPasses;
          yield* TestClock.adjust("44 seconds");
          const beforePass = fake.bootPasses;
          yield* TestClock.adjust("1 second");
          return [atBuild, beforePass, fake.bootPasses];
        }),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provide(layer));
};

it.effect("router wakes are let go once recovery's boot pass is done, or at once when off", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* bootPasses({}), [0, 0, 1]);
    assert.deepEqual(yield* bootPasses({ T3CODE_ARDUD_MISSIONS_RECOVERY: "false" }), [1, 1, 1]);
  }),
);

it.effect("a shutdown during the boot delay keeps the router's wakes held", () => {
  const { fake, layer } = harness();
  return Effect.gen(function* () {
    yield* world();
    const loops = RecoveryLoops.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
    );
    yield* Layer.build(loops).pipe(Effect.andThen(TestClock.adjust("10 seconds")), Effect.scoped);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(fake.bootPasses, 0);
  }).pipe(Effect.provide(layer));
});
