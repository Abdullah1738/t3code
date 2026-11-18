import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import {
  makeReaderPool,
  ReaderContentionObserver,
  type ReaderContention,
  makeReaderLanes,
  markNotStarted,
  ReaderLane,
  readerBusy,
  readerLaneFailure,
} from "./nodeSqliteReaderLanes.ts";

// Routing-only fixtures never execute SQL on this connection.
const connection = {} as Connection;

it.effect(
  "#1747 pool snapshots preserve queue depth and oldest lease age before cancellation",
  () =>
    Effect.gen(function* () {
      const pool = yield* makeReaderPool({
        lane: "background",
        slots: [Effect.succeed(connection)],
        queueLimit: 4,
      });
      const slot = (yield* pool.acquire)!;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* slot.lock
        .withPermits(1)(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.withSpan("KanbanAskFeed.read"), Effect.forkChild);
      yield* Deferred.await(held);
      const queued = yield* Deferred.make<void>();
      const waiter = yield* Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(slot.lock.withPermits(1)(Effect.void)),
        Effect.forkChild,
      );
      yield* Deferred.await(queued);
      yield* TestClock.adjust(25_000);
      const before = slot.snapshot();
      assert.deepEqual(before, {
        queueDepth: 1,
        oldestInFlightAgeMs: 25_000,
        holder: "KanbanAskFeed.read",
      });
      yield* Fiber.interrupt(waiter);
      assert.equal(slot.snapshot().queueDepth, 0);
      assert.equal(before.queueDepth, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.deepEqual(slot.snapshot(), { queueDepth: 0, oldestInFlightAgeMs: null, holder: null });
    }),
);

it.effect("bounds startup admission and recovers capacity on interruption", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<Connection>();
    const acquire = yield* makeReaderLanes(() => Effect.succeed(Deferred.await(ready)));
    const auth = acquire.pipe(Effect.provideService(ReaderLane, "auth"));
    const waiting = [];
    for (let n = 0; n < 256; n++) waiting.push(yield* auth.pipe(Effect.forkChild));
    yield* Effect.yieldNow;
    const failure = yield* auth.pipe(Effect.flip);
    assert.equal(failure.reason.operation, "readerAdmission");
    yield* Effect.forEach(waiting, Fiber.interrupt, { discard: true });
    yield* Deferred.succeed(ready, connection);
    const target = yield* acquire;
    assert.equal(target?.connection, connection);
  }),
);

it.effect("cancellation releases every lane permit", () =>
  Effect.gen(function* () {
    const acquire = yield* makeReaderLanes(() => Effect.succeed(Effect.succeed(connection)));
    const target = (yield* acquire)!;
    for (let n = 0; n < 50; n++) {
      const work = yield* target.lock.withPermits(1)(Effect.never).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(work);
      assert.equal(yield* target.lock.withPermits(1)(Effect.succeed("available")), "available");
    }
  }),
);

it.effect("fails closed when the reserved auth process cannot open", () =>
  Effect.gen(function* () {
    const acquire = yield* makeReaderLanes(() => Effect.succeed(Effect.succeed(undefined)));
    const failure = yield* acquire.pipe(Effect.flip);
    assert.equal(failure.reason.operation, "readerAdmission");
  }),
);

it("classifies reserved-lane failures through cause chains", () => {
  const admission = new SqlError({
    reason: classifySqliteError(new Error("Reader lane unavailable"), {
      operation: "readerAdmission",
      message: "Reader lane unavailable",
    }),
  });
  assert.strictEqual(readerLaneFailure(admission), "retryable");
  assert.strictEqual(readerLaneFailure(readerBusy("Reader lane busy", false)), "retryable");
  assert.strictEqual(readerLaneFailure(readerBusy("Reader lane busy", true)), "busy");
  const stopped = new Error("verification failed", {
    cause: new Error("Database reader exited with code null"),
  });
  assert.strictEqual(readerLaneFailure({ _tag: "Wrapper", cause: stopped }), "busy");
  assert.strictEqual(
    readerLaneFailure(markNotStarted(new Error("Database reader exited"))),
    "retryable",
  );
  assert.strictEqual(readerLaneFailure(new Error("no such table: sessions")), undefined);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.strictEqual(readerLaneFailure(cyclic), undefined);
});

// Review r3: three healthy 4 s reads at a 5 s statement limit made the third
// caller wait 8 s for the lane. Admission now has its own deadline.
it.live("bounds the wait for the lane itself and leaks no permit when it expires", () =>
  Effect.gen(function* () {
    const acquire = yield* makeReaderLanes(
      () => Effect.succeed(Effect.succeed(connection)),
      "300 millis",
    );
    const target = (yield* acquire)!;
    const release = yield* Deferred.make<void>();
    const holder = yield* target.lock
      .withPermits(1)(Deferred.await(release))
      .pipe(Effect.forkChild);
    yield* Effect.sleep("20 millis");
    for (const waiter of [
      Effect.asVoid(target.lock.withPermits(1)(Effect.succeed("ran"))),
      Effect.asVoid(target.lock.take(1)),
    ]) {
      const started = performance.now();
      const failure = yield* Effect.flip(waiter);
      const waited = performance.now() - started;
      assert.isAtLeast(waited, 250);
      assert.isBelow(waited, 1_500);
      assert.equal(failure.reason.operation, "readerBusy");
      // Busy, not retryable: a retry must not spend a second admission window.
      assert.equal(readerLaneFailure(failure), "busy");
    }
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    // Nothing leaked: the lane is free again and admits at once.
    assert.equal(yield* target.lock.withPermits(1)(Effect.succeed("free")), "free");
    assert.equal(yield* target.lock.take(1), 1);
    yield* target.lock.release(1);
  }),
);

it.live("a waiter admitted before its deadline runs normally", () =>
  Effect.gen(function* () {
    const acquire = yield* makeReaderLanes(
      () => Effect.succeed(Effect.succeed(connection)),
      "2 seconds",
    );
    const target = (yield* acquire)!;
    const holder = yield* target.lock
      .withPermits(1)(Effect.sleep("150 millis"))
      .pipe(Effect.forkChild);
    yield* Effect.sleep("20 millis");
    assert.equal(yield* target.lock.withPermits(1)(Effect.succeed("ran")), "ran");
    yield* Fiber.join(holder);
  }),
);

it.effect.each(["take", "withPermits", "withPermitsIfAvailable"] as const)(
  "attributes overlapping holder time while waiting behind %s",
  (mode) =>
    Effect.gen(function* () {
      const pool = yield* makeReaderPool({
        lane: "background",
        slots: [Effect.succeed(connection)],
        queueLimit: 4,
      });
      const slot = (yield* pool.acquire)!;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const work = Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release)));
      const holder = yield* Effect.forkChild(
        (mode === "take"
          ? slot.lock.take(1).pipe(Effect.andThen(work), Effect.ensuring(slot.lock.release(1)))
          : mode === "withPermits"
            ? slot.lock.withPermits(1)(work)
            : slot.lock.withPermitsIfAvailable(1)(work)
        ).pipe(Effect.withSpan("KanbanThreads.find")),
      );
      yield* Deferred.await(held);
      yield* TestClock.adjust("10 millis");
      const samples: ReaderContention[] = [];
      const queued = yield* Deferred.make<void>();
      const waiter = yield* Effect.forkChild(
        Deferred.succeed(queued, undefined).pipe(
          Effect.andThen(slot.lock.withPermits(1)(Effect.void)),
          Effect.provideService(ReaderContentionObserver, (sample) => {
            samples.push(sample);
          }),
        ),
      );
      yield* Deferred.await(queued);
      yield* TestClock.adjust("20 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);
      assert.deepEqual(samples, [
        { lane: "background", slot: 0, holder: "KanbanThreads.find", holdMs: 20 },
      ]);
      assert.equal(pool.inFlight(), 0);
    }),
);

it.effect("reports an ongoing holder on cancellation and removes the wait observer", () =>
  Effect.gen(function* () {
    const pool = yield* makeReaderPool({
      lane: "foreground",
      slots: [Effect.succeed(connection)],
      queueLimit: 4,
    });
    const slot = (yield* pool.acquire)!;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      slot.lock
        .withPermits(1)(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.withSpan("ProjectionStore.selectShellThreadRows")),
    );
    yield* Deferred.await(held);
    const samples: ReaderContention[] = [];
    const queued = yield* Deferred.make<void>();
    const waiter = yield* Effect.forkChild(
      Deferred.succeed(queued, undefined).pipe(
        Effect.andThen(slot.lock.take(1)),
        Effect.provideService(ReaderContentionObserver, (sample) => {
          samples.push(sample);
        }),
      ),
    );
    yield* Deferred.await(queued);
    yield* TestClock.adjust("25 millis");
    yield* Fiber.interrupt(waiter);
    assert.deepEqual(samples, [
      { lane: "foreground", slot: 0, holder: "ProjectionStore.selectShellThreadRows", holdMs: 25 },
    ]);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    assert.lengthOf(samples, 1);
    assert.equal(pool.inFlight(), 0);
  }),
);

it.effect.each(["take", "withPermits"] as const)(
  "cleans up cancellation at observer registration before %s installs its wait",
  (mode) =>
    Effect.gen(function* () {
      const pool = yield* makeReaderPool({
        lane: "background",
        slots: [Effect.succeed(connection)],
        queueLimit: 4,
      });
      const slot = (yield* pool.acquire)!;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        slot.lock
          .withPermits(1)(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.withSpan("Holder.first")),
      );
      yield* Deferred.await(held);
      const clock = yield* Clock.Clock;
      let armed = false;
      let forcedYield = false;
      const scheduler = new Scheduler.MixedScheduler();
      scheduler.shouldYield = (fiber) => {
        if (armed && !forcedYield) {
          forcedYield = true;
          queueMicrotask(() => fiber.interruptUnsafe());
          return true;
        }
        return false;
      };
      const samples: ReaderContention[] = [];
      const waiter = yield* Effect.forkChild(
        (mode === "take" ? slot.lock.take(1) : slot.lock.withPermits(1)(Effect.void)).pipe(
          Effect.provideService(ReaderContentionObserver, (sample) => {
            samples.push(sample);
          }),
          Effect.provideService(Clock.Clock, {
            ...clock,
            monotonicTimeNanosUnsafe: () => {
              armed = true;
              return clock.monotonicTimeNanosUnsafe();
            },
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
        ),
      );
      const exit = yield* Fiber.await(waiter);
      assert.isTrue(forcedYield);
      assert.equal(exit._tag, "Failure");
      assert.lengthOf(samples, 1);
      assert.equal(samples[0]!.holder, "Holder.first");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* slot.lock.withPermits(1)(Effect.void).pipe(Effect.withSpan("Holder.second"));
      assert.lengthOf(samples, 1);
      assert.equal(pool.inFlight(), 0);
    }),
);
