import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { RestartMarkerJson, restartMarker, shutdownWithinBudget } from "./shutdown.ts";

const decodeRestartMarker = Schema.decodeEffect(RestartMarkerJson);

it.effect("clears the old restart marker on boot and publishes it before provider shutdown", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "restart-marker-" });
    const marker = path.join(dir, "restarting");
    yield* TestClock.setTime(1_700_000_000_000);
    yield* fs.writeFileString(marker, "stale");
    const mark = yield* restartMarker(dir);
    assert.isFalse(yield* fs.exists(marker));
    yield* TestClock.adjust("1250 millis");
    const shutdownAt = yield* Clock.currentTimeMillis;
    yield* mark;
    let closed = false;
    const checkMarker = Effect.gen(function* () {
      const value = yield* decodeRestartMarker(yield* fs.readFileString(marker));
      assert.equal(value.pid, process.pid);
      assert.equal(value.at, shutdownAt / 1000);
    });
    yield* shutdownWithinBudget({
      prepare: checkMarker,
      closeProviders: checkMarker.pipe(
        Effect.andThen(
          Effect.sync(() => {
            closed = true;
          }),
        ),
      ),
      checkpoint: Effect.void,
    });
    assert.isTrue(closed);
    const _markAgain = yield* restartMarker(dir);
    assert.isFalse(yield* fs.exists(marker));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores restart marker cleanup and write failures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "restart-marker-" });
    const marker = path.join(dir, "restarting");
    yield* fs.makeDirectory(marker);
    yield* fs.writeFileString(path.join(marker, "keep"), "existing");
    const mark = yield* restartMarker(dir);
    yield* mark;
    assert.equal(yield* fs.readFileString(path.join(marker, "keep")), "existing");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reaches provider cleanup and checkpoint within nine seconds when every phase stalls",
  () =>
    Effect.gen(function* () {
      const phases = yield* Ref.make<string[]>([]);
      const stall = (name: string) =>
        Ref.update(phases, (xs) => [...xs, name]).pipe(Effect.andThen(Effect.never));
      const fiber = yield* shutdownWithinBudget({
        prepare: stall("prepare"),
        closeProviders: stall("providers"),
        checkpoint: stall("checkpoint"),
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      yield* Fiber.join(fiber);
      assert.deepEqual(yield* Ref.get(phases), ["prepare", "providers", "checkpoint"]);
    }),
);

it.effect("still closes providers after preparation fails", () =>
  Effect.gen(function* () {
    let closed = false;
    yield* shutdownWithinBudget({
      prepare: Effect.fail("prepare failed"),
      closeProviders: Effect.sync(() => {
        closed = true;
      }),
      checkpoint: Effect.void,
    });
    assert.isTrue(closed);
  }),
);
