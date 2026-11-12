import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { restartMarker, shutdownWithinBudget } from "./shutdown.ts";

it.effect("clears the old restart marker on boot and publishes it before provider shutdown", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "restart-marker-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const marker = NodePath.join(dir, "restarting");
    yield* Effect.promise(() => NodeFSP.writeFile(marker, "stale"));
    const mark = yield* restartMarker(dir);
    assert.isFalse(
      yield* Effect.promise(() =>
        NodeFSP.access(marker).then(
          () => true,
          () => false,
        ),
      ),
    );
    yield* mark;
    let closed = false;
    const checkMarker = Effect.promise(async () => {
      const value = JSON.parse(await NodeFSP.readFile(marker, "utf8"));
      assert.equal(value.pid, process.pid);
      assert.isAtLeast(value.at, Date.now() / 1000 - 5);
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
    yield* restartMarker(dir);
    assert.isFalse(
      yield* Effect.promise(() =>
        NodeFSP.access(marker).then(
          () => true,
          () => false,
        ),
      ),
    );
  }).pipe(Effect.scoped),
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
