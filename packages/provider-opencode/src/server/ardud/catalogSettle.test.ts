import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import type { OpenCode2Model } from "../status.ts";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import {
  boundedCatalogRead,
  catalogDiffersFromSnapshot,
  followOpenCode2CatalogChanges,
  isOpenCode2CatalogFrame,
  makeSettledOpenCode2ModelLoader,
  readSettledOpenCode2Models,
  type SettledOpenCode2Catalog,
} from "./catalogSettle.ts";

const model = (slug: string): OpenCode2Model => {
  const [providerID, ...rest] = slug.split("/");
  return { providerID: providerID!, id: rest.join("/"), name: slug, variants: [] };
};
// What a cold home directory listed on 2.0.22 before and after its plugins settled.
const FREE = ["opencode/big-pickle", "opencode/beam-free", "ollama/qwen2.5-coder:3b"].map(model);
const OPUS = ["opus/claude-opus-5-5", "opus/cx/gpt-6.1-sol", "opus/gpt-6-astra"].map(model);
const FULL = [...FREE, ...OPUS];
const slugs = (models: ReadonlyArray<OpenCode2Model>) =>
  models.map((m) => `${m.providerID}/${m.id}`).toSorted();

/** Moves the test clock in small steps, so sleeps started along the way come due in the window. */
const advance = (millis: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(millis / 50) }),
    () => TestClock.adjust("50 millis"),
    {
      discard: true,
    },
  );

/** A read that answers from `replies` in order, then repeats the last one. */
const scripted = (replies: Array<ReadonlyArray<OpenCode2Model>>) => {
  let reads = 0;
  const read = Effect.sync(() => replies[Math.min(reads++, replies.length - 1)]!);
  return { read, reads: () => reads };
};

describe("readSettledOpenCode2Models", () => {
  it.effect("reads past a partial first listing once the catalog event arrives", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<void>();
      const { read } = scripted([FREE, FULL]);
      const fiber = yield* readSettledOpenCode2Models(read, Queue.take(changes)).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Queue.offer(changes, undefined);
      yield* advance(1500);
      const result = yield* Fiber.join(fiber);
      NodeAssert.equal(result.settled, true);
      NodeAssert.deepEqual(slugs(result.models), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits out a cold directory: empty, then partial, then complete", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<void>();
      const { read, reads } = scripted([[], [], FREE, FULL]);
      const fiber = yield* readSettledOpenCode2Models(read, Queue.take(changes)).pipe(
        Effect.forkChild,
      );
      // Two empty reads, then the partial one; it waits for the catalog event.
      yield* advance(3000);
      NodeAssert.equal(reads(), 3);
      yield* Queue.offer(changes, undefined);
      yield* advance(1500);
      const result = yield* Fiber.join(fiber);
      NodeAssert.equal(result.settled, true);
      NodeAssert.deepEqual(slugs(result.models), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits longer for a directory that listed nothing at first", () =>
    Effect.gen(function* () {
      const { read, reads } = scripted([[], FREE, FREE, FULL]);
      const fiber = yield* readSettledOpenCode2Models(read, Effect.never).pipe(Effect.forkChild);
      // Past a warm directory's pause, a cold one still waits for its event.
      yield* advance(2000);
      NodeAssert.equal(reads(), 2);
      yield* advance(30_000);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("takes a warm directory's listing after one confirming read", () =>
    Effect.gen(function* () {
      const { read, reads } = scripted([FULL]);
      const fiber = yield* readSettledOpenCode2Models(read, Effect.never).pipe(Effect.forkChild);
      yield* advance(2000);
      const result = yield* Fiber.join(fiber);
      NodeAssert.equal(result.settled, true);
      NodeAssert.equal(reads(), 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports a listing that never holds still as unsettled", () =>
    Effect.gen(function* () {
      let reads = 0;
      const read = Effect.sync(() => (reads++ % 2 === 0 ? FREE : FULL));
      const fiber = yield* readSettledOpenCode2Models(read, Effect.never).pipe(Effect.forkChild);
      yield* advance(60_000);
      NodeAssert.equal((yield* Fiber.join(fiber)).settled, false);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never confirms a listing with the read right after a catalog event", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<void>();
      // The read woken by provider.updated can still see the partial catalog.
      const { read } = scripted([FREE, FREE, FULL]);
      yield* Queue.offer(changes, undefined);
      const fiber = yield* readSettledOpenCode2Models(read, Queue.take(changes)).pipe(
        Effect.forkChild,
      );
      yield* advance(5000);
      const result = yield* Fiber.join(fiber);
      NodeAssert.equal(result.settled, true);
      NodeAssert.deepEqual(slugs(result.models), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("gives up on a model list that never answers", () =>
    Effect.gen(function* () {
      const fiber = yield* boundedCatalogRead(Effect.never).pipe(Effect.flip, Effect.forkChild);
      yield* advance(11_000);
      const error = yield* Fiber.join(fiber);
      NodeAssert.ok(OpenCodeRuntime.isOpenCodeRuntimeError(error));
      NodeAssert.equal(error.operation, "model.list");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("makeSettledOpenCode2ModelLoader", () => {
  const loaderOver = (results: Array<SettledOpenCode2Catalog | "fail">) =>
    Effect.gen(function* () {
      const next = yield* Ref.make(0);
      const read = Ref.getAndUpdate(next, (n) => n + 1).pipe(
        Effect.flatMap((n) => {
          const result = results[Math.min(n, results.length - 1)]!;
          return result === "fail" ? Effect.fail("unreachable" as const) : Effect.succeed(result);
        }),
      );
      return yield* makeSettledOpenCode2ModelLoader(read);
    });
  const run = <A, E>(load: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = yield* load.pipe(Effect.forkChild);
      yield* advance(10_000);
      return yield* Fiber.join(fiber);
    });

  it.effect("confirms a first catalog, which picks up what an early partial one lacked", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver([
        { models: FREE, settled: true },
        { models: FULL, settled: true },
      ]);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("never lets a partial listing replace a known complete catalog", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver([
        { models: FULL, settled: true },
        { models: FREE, settled: false },
      ]);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("takes a later catalog that only adds models", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver([
        { models: FREE, settled: true },
        { models: FULL, settled: false },
      ]);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FREE));
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the known catalog when a refresh fails", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver([{ models: FULL, settled: true }, "fail"]);
      yield* run(load);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails when nothing was ever listed", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver(["fail"]);
      NodeAssert.equal(yield* run(Effect.flip(load)), "unreachable");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("drops a removed model once a second settled read confirms it", () =>
    Effect.gen(function* () {
      const retired = FULL.filter((m) => m.id !== "gpt-6-astra");
      const load = yield* loaderOver([
        { models: FULL, settled: true },
        { models: FULL, settled: true },
        { models: retired, settled: true },
        { models: retired, settled: true },
      ]);
      yield* run(load);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(retired));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps models a single settled read lost when the next read disagrees", () =>
    Effect.gen(function* () {
      const load = yield* loaderOver([
        { models: FULL, settled: true },
        { models: FULL, settled: true },
        { models: FREE, settled: true },
        { models: FREE, settled: false },
      ]);
      yield* run(load);
      NodeAssert.deepEqual(slugs(yield* run(load)), slugs(FULL));
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("catalog changes", () => {
  it("reads only the probe directory's model and provider updates", () => {
    const frame = (type: string, directory: string) =>
      JSON.stringify({ id: "evt_1", type, location: { directory }, data: {} });
    NodeAssert.equal(isOpenCode2CatalogFrame(frame("model.updated", "/Users/a"), "/Users/a"), true);
    NodeAssert.equal(
      isOpenCode2CatalogFrame(frame("provider.updated", "/Users/a"), "/Users/a"),
      true,
    );
    NodeAssert.equal(isOpenCode2CatalogFrame(frame("model.updated", "/work"), "/Users/a"), false);
    NodeAssert.equal(
      isOpenCode2CatalogFrame(frame("agent.updated", "/Users/a"), "/Users/a"),
      false,
    );
    NodeAssert.equal(isOpenCode2CatalogFrame('{"type":"model.updated"', "/Users/a"), false);
  });

  it("only treats a ready snapshot with the same models and variants as current", () => {
    const snapshot = (status: string, models: ReadonlyArray<OpenCode2Model>, installed = true) => ({
      installed,
      status,
      models: [
        ...models.map((m) => ({
          slug: `${m.providerID}/${m.id}`,
          isCustom: false,
          capabilities: {
            optionDescriptors:
              m.variants.length === 0
                ? []
                : [{ id: "variant", options: m.variants.map((v) => ({ id: v.id })) }],
          },
        })),
        { slug: "my/custom", isCustom: true },
      ],
    });
    const withHigh = FULL.map((m, index) =>
      index === 0 ? { ...m, variants: [{ id: "high" }] } : m,
    );
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("ready", FULL), withHigh), true);
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("ready", withHigh), withHigh), false);
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("ready", FULL), FULL.toReversed()), false);
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("ready", FREE), FULL), true);
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("error", FULL), FULL), true);
    // The pending startup snapshot's own probe is still running.
    NodeAssert.equal(catalogDiffersFromSnapshot(snapshot("warning", [], false), FULL), false);
  });

  it.effect("coalesces a burst of updates into one re-read", () =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<void>();
      const changes = yield* Ref.make(0);
      yield* followOpenCode2CatalogChanges({
        subscribe: Effect.succeed(Stream.fromQueue(notices)),
        onChange: Ref.update(changes, (n) => n + 1),
      });
      // One re-read for subscribing, since a change may have gone by unseen.
      yield* advance(2000);
      NodeAssert.equal(yield* Ref.get(changes), 1);
      yield* Queue.offerAll(notices, [undefined, undefined, undefined]);
      yield* advance(2000);
      NodeAssert.equal(yield* Ref.get(changes), 2);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("subscribes again after the stream drops and re-reads once", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      const changes = yield* Ref.make(0);
      yield* followOpenCode2CatalogChanges({
        subscribe: Ref.updateAndGet(subscriptions, (n) => n + 1).pipe(
          Effect.map((n): Stream.Stream<void, string> =>
            n === 1 ? Stream.fail("dropped") : Stream.never,
          ),
        ),
        onChange: Ref.update(changes, (n) => n + 1),
      });
      yield* advance(8000);
      NodeAssert.equal(yield* Ref.get(subscriptions), 2);
      NodeAssert.equal(yield* Ref.get(changes), 2);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("keeps watching when a re-read fails", () =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<void>();
      const attempts = yield* Ref.make(0);
      yield* followOpenCode2CatalogChanges({
        subscribe: Effect.succeed(Stream.fromQueue(notices)),
        onChange: Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(Effect.fail("boom"))),
      });
      yield* advance(2000);
      yield* Queue.offer(notices, undefined);
      yield* advance(2000);
      NodeAssert.equal(yield* Ref.get(attempts), 2);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("backs off when the server drops each stream right away", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      yield* followOpenCode2CatalogChanges({
        subscribe: Ref.update(subscriptions, (n) => n + 1).pipe(
          Effect.as(Stream.empty as Stream.Stream<void>),
        ),
        onChange: Effect.void,
      });
      // At 0, 5, 15 and 35 seconds, not every 5 seconds.
      yield* advance(36_000);
      NodeAssert.equal(yield* Ref.get(subscriptions), 4);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("backs off while the server refuses to subscribe", () =>
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make(0);
      yield* followOpenCode2CatalogChanges({
        subscribe: Ref.update(subscriptions, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail("down")),
        ),
        onChange: Effect.void,
      });
      // At 0, 5, 15 and 35 seconds.
      yield* advance(36_000);
      NodeAssert.equal(yield* Ref.get(subscriptions), 4);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
