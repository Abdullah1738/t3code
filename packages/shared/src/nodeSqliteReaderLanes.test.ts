import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Connection } from "effect/sql/SqlConnection";
import { makeReaderLanes, ReaderLane } from "./nodeSqliteReaderLanes.ts";

// Routing-only fixtures never execute SQL on this connection.
const connection = {} as Connection;

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
