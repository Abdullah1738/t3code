// @effect-diagnostics nodeBuiltinImport:off -- exercises owned SQLite child processes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "./nodeSqliteClient.ts";

const native = vi.hoisted(() => ({
  block: false,
  entered: () => {},
  afterSpawn: () => {},
  stopped: () => {},
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      child.once("exit", () => native.stopped());
      native.afterSpawn();
      const send = child.send.bind(child);
      child.send = ((message: { source?: string }) => {
        if (native.block && message.source !== undefined) {
          native.block = false;
          // A deterministic function signals from inside sqlite3_step, after
          // SQLite holds its write lock, then stays blocked until SIGKILL.
          const setup = `
            const prototype = require('node:sqlite').DatabaseSync.prototype;
            const prepare = prototype.prepare;
            prototype.prepare = function(sql, ...args) {
              if (sql.includes('native_gate')) this.function('native_gate',
                { deterministic: true }, value => {
                  process.send({ type: 'test-native-entered' });
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
                  return value;
                });
              return prepare.call(this, sql, ...args);
            };
          `;
          message = { ...message, source: setup + message.source };
        }
        return send(message);
      }) as typeof child.send;
      child.on("message", (message: { type?: string }) => {
        if (message.type === "test-native-entered") native.entered();
      });
      return child;
    },
  };
});

it.live("acknowledges child exit when interrupted immediately after spawn", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-maintenance-spawn-"));
  const stopped = new Promise<void>((resolve) => {
    native.stopped = resolve;
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items(id INTEGER)`;
    // Interrupt from the spawn boundary itself, before acquisition can return.
    native.afterSpawn = () => Fiber.getCurrent()!.interruptUnsafe();
    const work = yield* Sqlite.idleIndexBuild(sql, "CREATE INDEX spawn_idx ON items(id)", 0).pipe(
      Effect.forkChild,
    );
    yield* Fiber.await(work);
    yield* Effect.promise(() => stopped);
    native.afterSpawn = () => {};
    yield* sql`INSERT INTO items VALUES (1)`;
    assert.deepEqual(
      yield* Sqlite.idleIndexBuild(sql, "CREATE INDEX spawn_idx ON items(id)", 0),
      Option.some(true),
    );
  }).pipe(
    Effect.provide(
      Sqlite.layer({ filename: NodePath.join(dir, "state.sqlite"), checkpointWorker: true }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        native.afterSpawn = () => {};
        native.stopped = () => {};
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

it.live("starts the quiet window when a long writer transaction releases its lease", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-maintenance-quiet-"));
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items(id INTEGER)`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO items VALUES (1)`;
        clock.mockReturnValue(120_000);
      }),
    );
    const statement = "CREATE INDEX IF NOT EXISTS quiet_idx ON items(id)";
    assert.deepEqual(yield* Sqlite.idleIndexBuild(sql, statement, 60_000), Option.none());
    clock.mockReturnValue(180_001);
    assert.deepEqual(yield* Sqlite.idleIndexBuild(sql, statement, 60_000), Option.some(true));
  }).pipe(
    Effect.provide(
      Sqlite.layer({ filename: NodePath.join(dir, "state.sqlite"), checkpointWorker: true }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        clock.mockRestore();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

it.live("hands the writer back promptly when demand arrives inside spawn", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-maintenance-admission-"));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items(id INTEGER)`;
    const spawned = yield* Deferred.make<void>();
    const writer = yield* Deferred.await(spawned).pipe(
      Effect.andThen(sql`INSERT INTO items VALUES (1)`),
      Effect.forkChild,
    );
    native.afterSpawn = () => {
      native.afterSpawn = () => {};
      Deferred.doneUnsafe(spawned, Effect.void);
    };
    const at = performance.now();
    const maintenance = yield* Sqlite.idleIndexBuild(
      sql,
      "CREATE INDEX admission_idx ON items(id)",
      0,
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16), Effect.forkChild);
    yield* Fiber.join(writer);
    assert.deepEqual(yield* Fiber.join(maintenance), Option.some(false));
    assert.isBelow(performance.now() - at, 2000);
  }).pipe(
    Effect.provide(
      Sqlite.layer({ filename: NodePath.join(dir, "state.sqlite"), checkpointWorker: true }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        native.afterSpawn = () => {};
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});

it.live.each(["write", "transaction", "interrupt"] as const)(
  "preempts a locked native index for %s, acknowledges exit, and retries",
  (action) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-maintenance-"));
    const entered = new Promise<void>((resolve) => {
      native.entered = resolve;
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE items(id INTEGER PRIMARY KEY)`;
      yield* sql`INSERT INTO items VALUES (1), (2)`;
      native.block = true;
      const work = yield* Sqlite.idleIndexBuild(
        sql,
        "CREATE INDEX IF NOT EXISTS blocked_idx ON items(native_gate(id))",
        0,
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => entered);
      const at = performance.now();
      if (action === "interrupt") yield* Fiber.interrupt(work);
      else {
        const write = sql`INSERT INTO items VALUES (3)`;
        yield* action === "transaction" ? sql.withTransaction(write) : write;
        assert.deepEqual(yield* Fiber.join(work), Option.some(false));
      }
      assert.isBelow(performance.now() - at, 2000);
      assert.lengthOf(yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'blocked_idx'`, 0);
      // A fresh child can acquire the writer and build the same named index.
      assert.deepEqual(
        yield* Sqlite.idleIndexBuild(sql, "CREATE INDEX IF NOT EXISTS blocked_idx ON items(id)", 0),
        Option.some(true),
      );
      assert.equal(
        (yield* sql<{ n: number }>`SELECT count(*) AS n FROM items INDEXED BY blocked_idx`)[0]?.n,
        action === "interrupt" ? 2 : 3,
      );
    }).pipe(
      Effect.provide(
        Sqlite.layer({ filename: NodePath.join(dir, "state.sqlite"), checkpointWorker: true }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          native.block = false;
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  },
);

it.live("gives queued writer demand precedence through scheduler yields", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sqlite-maintenance-race-"));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE items(id INTEGER)`;
    for (let i = 0; i < 40; i++) {
      const command = yield* sql`INSERT INTO items VALUES (${i})`.pipe(Effect.forkChild);
      const attempt = yield* Sqlite.idleIndexBuild(
        sql,
        "CREATE INDEX IF NOT EXISTS race_idx ON items(id)",
        0,
      ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16), Effect.forkChild);
      yield* Fiber.join(command);
      yield* Fiber.join(attempt);
    }
    assert.equal((yield* sql<{ n: number }>`SELECT count(*) AS n FROM items`)[0]?.n, 40);
  }).pipe(
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
    Effect.provide(
      Sqlite.layer({ filename: NodePath.join(dir, "state.sqlite"), checkpointWorker: true }),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
  );
});
