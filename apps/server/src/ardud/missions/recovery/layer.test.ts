import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
