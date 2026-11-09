import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as Sqlite from "./nodeSqliteClient.ts";

const transport = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  let finish: (code: number) => void = () => {};
  const completion = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const emit = (name: string, value: unknown) => listeners.get(name)?.forEach((fn) => fn(value));
  const control = {
    submitted: () => {},
    emit,
    finish: () => {
      finish(1);
      emit("exit", 1);
    },
  };
  return {
    control,
    runtime: {
      completion,
      on: (name: string, fn: (...args: any[]) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
        if (name === "message") queueMicrotask(() => fn({ type: "ready" }));
      },
      postMessage: () => control.submitted(),
      ref: () => {},
      unref: () => {},
      terminate: () => completion,
    },
  };
});
vi.mock("./nodeSqliteReaderProcess.ts", () => ({ startReaderProcess: () => transport.runtime }));

it.live("awaits retirement when stop precedes autocommit cancellation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reader-retirement-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode=WAL`;
      const submitted = yield* Deferred.make<void>();
      transport.control.submitted = () => {
        Deferred.doneUnsafe(submitted, Effect.void);
      };
      const read = yield* sql`SELECT 1`.pipe(Sqlite.authReadOnly, Effect.forkChild);
      yield* Deferred.await(submitted);
      // Error retirement clears pending immediately, but physical exit is delayed.
      transport.control.emit("error", new Error("synthetic IPC failure"));
      const interrupt = yield* Fiber.interrupt(read).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(interrupt.pollUnsafe());
      transport.control.finish();
      yield* Fiber.join(interrupt);
    }).pipe(
      Effect.ensuring(Effect.sync(transport.control.finish)),
      Effect.provide(
        Sqlite.layer({
          filename: `${dir}/fixture.sqlite`,
          readerWorker: true,
          authReaderProcess: true,
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
