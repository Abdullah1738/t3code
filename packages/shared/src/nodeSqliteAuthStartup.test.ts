import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { makeAuthReader } from "./nodeSqliteAuthReader.ts";

const transport = vi.hoisted(() => ({
  runtimes: [] as Array<ReturnType<typeof fake>>,
  next: () => {},
}));
function fake() {
  const listening = Promise.withResolvers<void>();
  const terminating = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  let message: (value: unknown) => void = () => {};
  return {
    listening: listening.promise,
    terminating: terminating.promise,
    emit: (value: unknown) => message(value),
    finish: () => exited.resolve(0),
    completion: exited.promise,
    on: (name: string, fn: (...args: any[]) => void) => {
      if (name === "message") {
        message = fn;
        listening.resolve();
      }
    },
    postMessage: () => {},
    ref: () => {},
    unref: () => {},
    terminate: () => {
      terminating.resolve();
      return exited.promise;
    },
  };
}
vi.mock("./nodeSqliteReaderProcess.ts", () => ({
  startReaderProcess: () => {
    const runtime = fake();
    transport.runtimes.push(runtime);
    transport.next();
    return runtime;
  },
}));

it.live.each([
  { cancel: false, label: "failed" },
  { cancel: true, label: "cancelled" },
])("reaps $label startup before retry", ({ cancel }) =>
  Effect.gen(function* () {
    const acquire = yield* makeAuthReader({ filename: "unused-synthetic.sqlite" });
    const created = Promise.withResolvers<void>();
    transport.next = () => created.resolve();
    const first = yield* acquire.pipe(Effect.forkChild);
    yield* Effect.promise(() => created.promise);
    const runtime = transport.runtimes.at(-1)!;
    yield* Effect.promise(() => runtime.listening);
    const done = yield* (
      cancel ? Effect.asVoid(Fiber.interrupt(first)) : Effect.asVoid(Fiber.join(first))
    ).pipe(Effect.forkChild);
    if (!cancel) runtime.emit({ type: "unavailable", message: "temporary open failure" });
    yield* Effect.promise(() => runtime.terminating);
    yield* Effect.yieldNow;
    assert.isUndefined(done.pollUnsafe());
    runtime.finish();
    yield* Fiber.join(done);
    const retryCreated = Promise.withResolvers<void>();
    transport.next = () => retryCreated.resolve();
    const retry = yield* acquire.pipe(Effect.forkChild);
    yield* Effect.promise(() => retryCreated.promise);
    const next = transport.runtimes.at(-1)!;
    yield* Effect.promise(() => next.listening);
    next.emit({ type: "ready" });
    assert.isDefined(yield* Fiber.join(retry));
    next.finish();
  }).pipe(Effect.scoped),
);

it.live("does not retire a ready process when another acquisition is cancelled", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let waits = 0;
    const acquire = yield* makeAuthReader({ filename: "unused-synthetic.sqlite" }, (started) =>
      Effect.promise(() => {
        if (++waits !== 2) return started;
        entered.resolve();
        return resume.promise.then(() => started);
      }),
    );
    const created = Promise.withResolvers<void>();
    transport.next = () => created.resolve();
    const first = yield* acquire.pipe(Effect.forkChild);
    yield* Effect.promise(() => created.promise);
    const runtime = transport.runtimes.at(-1)!;
    yield* Effect.promise(() => runtime.listening);
    runtime.emit({ type: "ready" });
    assert.isDefined(yield* Fiber.join(first));
    let retired = false;
    void runtime.terminating.then(() => {
      retired = true;
      runtime.finish();
    });
    yield* Effect.gen(function* () {
      const other = yield* acquire.pipe(Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(other);
      assert.isFalse(retired);
      assert.isDefined(yield* acquire);
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
