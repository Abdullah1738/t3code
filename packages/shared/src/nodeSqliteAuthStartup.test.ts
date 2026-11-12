import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";
import { makeAuthReader, ReadOnly, retireAuthReader } from "./nodeSqliteAuthReader.ts";
import { makeReaderLanes } from "./nodeSqliteReaderLanes.ts";

const transport = vi.hoisted(() => ({
  runtimes: [] as Array<ReturnType<typeof fake>>,
  attempts: 0,
  next: (_runtime: ReturnType<typeof fake>) => {},
  spawn: () => {},
}));
function fake() {
  const exited = Promise.withResolvers<number>();
  const terminating = Promise.withResolvers<void>();
  const posted = Promise.withResolvers<void>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let holdExit = false;
  let retired = false;
  const emit = (name: string, value: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(value);
  };
  return {
    terminating: terminating.promise,
    posted: posted.promise,
    posts: [] as Array<unknown>,
    get retired() {
      return retired;
    },
    holdExit: () => {
      holdExit = true;
    },
    emit: (value: unknown) => emit("message", value),
    fail: (error: Error) => emit("error", error),
    exit: () => {
      emit("exit", null);
      exited.resolve(1);
    },
    finish: () => exited.resolve(0),
    completion: exited.promise,
    on: (name: string, fn: (...args: unknown[]) => void) => {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(fn);
      listeners.set(name, callbacks);
    },
    postMessage(value: unknown) {
      this.posts.push(value);
      posted.resolve();
    },
    ref: () => {},
    unref: () => {},
    terminate: () => {
      retired = true;
      terminating.resolve();
      if (!holdExit) exited.resolve(0);
      return exited.promise;
    },
  };
}
vi.mock("./nodeSqliteReaderProcess.ts", () => ({
  startReaderProcess: () => {
    transport.attempts++;
    transport.spawn();
    const runtime = fake();
    transport.runtimes.push(runtime);
    transport.next(runtime);
    return runtime;
  },
}));
beforeEach(() => {
  transport.runtimes = [];
  transport.attempts = 0;
  transport.next = () => {};
  transport.spawn = () => {};
});

// Handshakes observe the acquisition, rather than relying on process or timer scheduling.
const setup = Effect.gen(function* () {
  const firstCreated = Promise.withResolvers<ReturnType<typeof fake>>();
  const secondWaiting = Promise.withResolvers<void>();
  let waits = 0;
  transport.next = (runtime) => firstCreated.resolve(runtime);
  const acquire = yield* makeReaderLanes(() =>
    makeAuthReader(
      { filename: "unused-synthetic.sqlite", readerStartupTimeout: "10 seconds" },
      (started) =>
        Effect.promise(() => {
          if (++waits === 2) secondWaiting.resolve();
          return started;
        }),
    ),
  );
  const first = yield* acquire.pipe(Effect.forkChild);
  const runtime = yield* Effect.promise(() => firstCreated.promise);
  const second = yield* acquire.pipe(Effect.forkChild);
  yield* Effect.promise(() => secondWaiting.promise);
  return { acquire, first, second, runtime };
});

it.effect("a cancelled acquisition does not reap a startup others still wait for", () =>
  Effect.gen(function* () {
    const { first, second, runtime } = yield* setup;
    yield* Fiber.interrupt(first);
    assert.isFalse(runtime.retired);
    runtime.emit({ type: "ready" });
    assert.isDefined((yield* Fiber.join(second)).connection);
    assert.strictEqual(transport.attempts, 1);
  }).pipe(Effect.scoped),
);

it.effect.each(["unavailable", "error", "exit", "timeout"] as const)(
  "retries %s startup once for both waiters",
  (kind) =>
    Effect.gen(function* () {
      const { first, second, runtime } = yield* setup;
      const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
      transport.next = (next) => replacement.resolve(next);
      if (kind === "unavailable")
        runtime.emit({ type: "unavailable", message: "temporary open failure" });
      if (kind === "error") runtime.fail(new Error("temporary spawn failure"));
      if (kind === "exit") runtime.exit();
      if (kind === "timeout") {
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(transport.attempts, 2);
      }
      const next = yield* Effect.raceFirst(
        Effect.promise(() => replacement.promise),
        Fiber.join(first).pipe(
          Effect.andThen(Effect.die("startup returned without a replacement")),
        ),
      );
      next.emit({ type: "ready" });
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      assert.strictEqual(a.connection, b.connection);
      assert.strictEqual(transport.attempts, 2);
    }).pipe(Effect.scoped),
);

it.effect.each([
  { kind: "exit", message: "Database reader exited with code null" },
  { kind: "error", message: "Database reader failed: spawn ENOMEM" },
  { kind: "unavailable", message: "unable to open database file" },
])("retains the $kind cause after exactly two failed starts", ({ kind, message }) =>
  Effect.gen(function* () {
    const { first, second, runtime } = yield* setup;
    const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (next) => replacement.resolve(next);
    const fail = (reader: ReturnType<typeof fake>) => {
      if (kind === "exit") reader.exit();
      if (kind === "error") reader.fail(new Error("spawn ENOMEM"));
      if (kind === "unavailable") reader.emit({ type: "unavailable", message });
    };
    fail(runtime);
    const next = yield* Effect.raceFirst(
      Effect.promise(() => replacement.promise),
      Fiber.join(first).pipe(Effect.andThen(Effect.die("startup returned without a replacement"))),
    );
    fail(next);
    for (const waiter of [first, second]) {
      const result = yield* Fiber.join(waiter).pipe(Effect.flip);
      assert.include(String(result), message);
      assert.strictEqual(result.reason.operation, "readerAdmission");
    }
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("bounds two timed-out starts to the original ten-second budget", () =>
  Effect.gen(function* () {
    const { first, second } = yield* setup;
    const replacement = Promise.withResolvers<void>();
    transport.next = () => replacement.resolve();
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual(transport.attempts, 2);
    yield* Effect.promise(() => replacement.promise);
    yield* TestClock.adjust("5 seconds");
    for (const waiter of [first, second]) {
      const result = yield* Fiber.join(waiter).pipe(Effect.flip);
      assert.include(String(result), "worker did not open the database within");
      assert.include(String(result), "Reader lane unavailable:");
    }
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("retries synchronous spawn failure once and preserves its cause", () =>
  Effect.gen(function* () {
    transport.spawn = () => {
      throw new Error("spawn EAGAIN");
    };
    const acquire = yield* makeReaderLanes(() =>
      makeAuthReader({ filename: "unused-synthetic.sqlite" }),
    );
    const error = yield* acquire.pipe(Effect.flip);
    assert.include(String(error), "spawn EAGAIN");
    assert.strictEqual(error.reason.operation, "readerAdmission");
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("reaps a failed start before starting its replacement", () =>
  Effect.gen(function* () {
    const { first, second, runtime } = yield* setup;
    runtime.holdExit();
    const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (next) => replacement.resolve(next);
    runtime.emit({ type: "unavailable", message: "temporary open failure" });
    yield* Effect.promise(() => runtime.terminating);
    assert.strictEqual(transport.attempts, 1);
    runtime.finish();
    const next = yield* Effect.raceFirst(
      Effect.promise(() => replacement.promise),
      Fiber.join(first).pipe(Effect.andThen(Effect.die("startup returned without a replacement"))),
    );
    next.emit({ type: "ready" });
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("reaps an opening process when its last waiter is cancelled", () =>
  Effect.gen(function* () {
    const { first, second, runtime } = yield* setup;
    yield* Fiber.interrupt(first);
    yield* Fiber.interrupt(second);
    assert.isTrue(runtime.retired);
    assert.strictEqual(transport.attempts, 1);
  }).pipe(Effect.scoped),
);

it.effect("a mid-query exit fails that statement and the next acquire starts a fresh reader", () =>
  Effect.gen(function* () {
    const { acquire, first, second, runtime } = yield* setup;
    runtime.emit({ type: "ready" });
    const { connection } = yield* Fiber.join(first);
    yield* Fiber.join(second);
    const query = yield* connection.execute("SELECT 1", [], undefined).pipe(Effect.forkChild);
    yield* Effect.promise(() => runtime.posted);
    runtime.exit();
    const result = yield* Fiber.await(query);
    assert.include(String(result), "Database reader exited with code null");
    assert.strictEqual(transport.attempts, 1);
    assert.lengthOf(runtime.posts, 1);
    const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (next) => replacement.resolve(next);
    const fresh = yield* acquire.pipe(Effect.forkChild);
    const next = yield* Effect.raceFirst(
      Effect.promise(() => replacement.promise),
      Fiber.join(fresh).pipe(Effect.andThen(Effect.die("startup returned without a replacement"))),
    );
    next.emit({ type: "ready" });
    assert.notStrictEqual((yield* Fiber.join(fresh)).connection, connection);
    assert.lengthOf(next.posts, 0);
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("does not retire a ready process when a delayed acquisition is cancelled", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const created = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (runtime) => created.resolve(runtime);
    let waits = 0;
    const acquire = yield* makeAuthReader({ filename: "unused-synthetic.sqlite" }, (started) =>
      Effect.promise(() => {
        if (++waits !== 2) return started;
        entered.resolve();
        return resume.promise.then(() => started);
      }),
    );
    const first = yield* acquire.pipe(Effect.forkChild);
    const runtime = yield* Effect.promise(() => created.promise);
    runtime.emit({ type: "ready" });
    const connection = yield* Fiber.join(first);
    const other = yield* acquire.pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    yield* Fiber.interrupt(other);
    assert.isFalse(runtime.retired);
    assert.strictEqual(yield* acquire, connection);
    resume.resolve();
  }).pipe(Effect.scoped),
);

it.effect("a delayed ready result cannot hand out a retired startup", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const created = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (runtime) => created.resolve(runtime);
    let waits = 0;
    const acquire = yield* makeAuthReader({ filename: "unused-synthetic.sqlite" }, (started) =>
      Effect.promise(() => {
        if (++waits !== 2) return started;
        entered.resolve();
        return resume.promise.then(() => ({ type: "ready" as const }));
      }),
    );
    const first = yield* acquire.pipe(Effect.forkChild);
    const runtime = yield* Effect.promise(() => created.promise);
    const second = yield* acquire.pipe(Effect.forkChild);
    yield* Effect.promise(() => entered.promise);
    const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
    transport.next = (next) => replacement.resolve(next);
    runtime.emit({ type: "unavailable", message: "temporary open failure" });
    const next = yield* Effect.raceFirst(
      Effect.promise(() => replacement.promise),
      Fiber.join(first).pipe(Effect.andThen(Effect.die("startup returned without a replacement"))),
    );
    next.emit({ type: "ready" });
    const connection = yield* Fiber.join(first);
    resume.resolve();
    assert.strictEqual(yield* Fiber.join(second), connection);
    assert.strictEqual(transport.attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("fails within the startup budget while a retired process is still exiting", () =>
  Effect.gen(function* () {
    const { first, second, runtime } = yield* setup;
    runtime.holdExit();
    yield* Effect.gen(function* () {
      runtime.emit({ type: "unavailable", message: "open failed before slow retirement" });
      yield* Effect.promise(() => runtime.terminating);
      yield* TestClock.adjust("10 seconds");
      assert.isDefined(first.pollUnsafe());
      assert.isDefined(second.pollUnsafe());
      for (const waiter of [first, second]) {
        const error = yield* Fiber.join(waiter).pipe(Effect.flip);
        assert.include(String(error), "open failed before slow retirement");
      }
      assert.strictEqual(transport.attempts, 1);
    }).pipe(Effect.ensuring(Effect.sync(() => runtime.finish())));
  }).pipe(Effect.scoped),
);

it.effect.each(["error", "retire"] as const)(
  "rechecks a retirement that changes after admission captured its promise: %s",
  (kind) =>
    Effect.gen(function* () {
      const { acquire, first, second, runtime } = yield* setup;
      runtime.emit({ type: "ready" });
      const { connection } = yield* Fiber.join(first);
      yield* Fiber.join(second);
      runtime.holdExit();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const replacement = Promise.withResolvers<ReturnType<typeof fake>>();
      transport.next = (next) => replacement.resolve(next);
      let gated = false;
      const restore: typeof Effect.interruptible = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(effect, (value) => {
          if (gated) return Effect.succeed(value);
          gated = true;
          entered.resolve();
          return Effect.as(
            Effect.promise(() => resume.promise),
            value,
          );
        });
      yield* Effect.gen(function* () {
        const contender = yield* acquire.pipe(
          Effect.provideService(ReadOnly, restore),
          Effect.forkChild,
        );
        yield* Effect.promise(() => entered.promise);
        const retirement =
          kind === "retire"
            ? yield* retireAuthReader(connection).pipe(Effect.forkChild)
            : undefined;
        if (kind === "error") runtime.fail(new Error("failed during admission"));
        yield* Effect.promise(() => runtime.terminating);
        resume.resolve();
        yield* TestClock.adjust("0 millis");
        assert.strictEqual(transport.attempts, 1);
        runtime.finish();
        const next = yield* Effect.promise(() => replacement.promise);
        next.emit({ type: "ready" });
        assert.notStrictEqual((yield* Fiber.join(contender)).connection, connection);
        if (retirement !== undefined) yield* Fiber.join(retirement);
        assert.strictEqual(transport.attempts, 2);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            resume.resolve();
            runtime.finish();
          }),
        ),
      );
    }).pipe(Effect.scoped),
);
