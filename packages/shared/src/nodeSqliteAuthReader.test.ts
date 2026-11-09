import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as SqliteClient from "./nodeSqliteClient.ts";
import * as ReaderProcess from "./nodeSqliteReaderProcess.ts";

const withLaneClient = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reader-lanes-" });
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE sessions(id INTEGER PRIMARY KEY, revoked INTEGER)`;
      yield* sql`INSERT INTO sessions VALUES (1,0)`;
      return yield* use(sql);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(dir, "synthetic.sqlite"),
          readerWorker: true,
          authReaderProcess: true,
          readerStatementLimit: "1 second",
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Ported from 4a15b49745 (origin/main): identity lookups get their own reserved lane.
it.effect("keeps identity reads read-only on their own lane and preserves an enclosing writer transaction", () =>
  withLaneClient((sql) =>
    Effect.gen(function* () {
      const viewHeld = yield* Deferred.make<void>();
      const authHeld = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hold = (ready: Deferred.Deferred<void>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT * FROM sessions`;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
          }),
        );
      const view = yield* hold(viewHeld).pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(viewHeld);
      const auth = yield* hold(authHeld).pipe(SqliteClient.authReadOnly, Effect.forkChild);
      yield* Deferred.await(authHeld);
      assert.deepEqual(
        yield* sql`SELECT revoked FROM sessions WHERE id=1`.pipe(
          SqliteClient.identityReadOnly,
          Effect.timeout("2 seconds"),
        ),
        [{ revoked: 0 }],
      );
      const refused = yield* sql`INSERT INTO sessions VALUES (2,0)`.pipe(
        SqliteClient.identityReadOnly,
        Effect.flip,
      );
      assert.equal(refused._tag, "SqlError");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(view);
      yield* Fiber.join(auth);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO sessions VALUES (3,0)`;
          const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM sessions`.pipe(
            SqliteClient.identityReadOnly,
          );
          assert.equal(rows[0]?.n, 2);
        }),
      );
    }),
  ),
);

it.effect("reserves auth while the base reader and writer are held", () =>
  withLaneClient((sql) =>
    Effect.gen(function* () {
      const view1 = yield* Deferred.make<void>();
      const writer = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const hold = (ready: Deferred.Deferred<void>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT * FROM sessions`;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
          }),
        );
      const one = yield* hold(view1).pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(view1);
      const write = yield* hold(writer).pipe(Effect.forkChild);
      yield* Deferred.await(writer);
      assert.deepEqual(
        yield* sql`SELECT revoked FROM sessions WHERE id=1`.pipe(SqliteClient.authReadOnly),
        [{ revoked: 0 }],
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(one);
      yield* Fiber.join(write);
    }),
  ),
);

it.effect("observes ACKed revocation on every reader without a session cache", () =>
  withLaneClient((sql) =>
    Effect.gen(function* () {
      for (let n = 0; n < 4; n++)
        yield* sql`SELECT * FROM sessions`.pipe(SqliteClient.authReadOnly);
      yield* sql.withTransaction(sql`UPDATE sessions SET revoked=1 WHERE id=1`);
      for (let n = 0; n < 4; n++) {
        assert.deepEqual(
          yield* sql`SELECT revoked FROM sessions WHERE id=1`.pipe(SqliteClient.readOnly),
          [{ revoked: 1 }],
        );
        assert.deepEqual(
          yield* sql`SELECT revoked FROM sessions WHERE id=1`.pipe(SqliteClient.authReadOnly),
          [{ revoked: 1 }],
        );
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE sessions SET revoked=0 WHERE id=1`;
          assert.deepEqual(
            yield* sql`SELECT revoked FROM sessions WHERE id=1`.pipe(SqliteClient.authReadOnly),
            [{ revoked: 0 }],
          );
        }),
      );
    }),
  ),
);

it.effect("retires an idle reader snapshot and rejects its commit", () => {
  const exited = Promise.withResolvers<void>();
  const start = ReaderProcess.startReaderProcess;
  const spy = vi.spyOn(ReaderProcess, "startReaderProcess").mockImplementation((...args) => {
    const runtime = start(...args);
    void runtime.completion?.then(() => exited.resolve());
    return runtime;
  });
  return withLaneClient((sql) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const read = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT * FROM sessions`;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(resume);
          }),
        )
        .pipe(SqliteClient.authReadOnly, Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      // The native guard owns its clock; observe physical exit before resuming.
      yield* Effect.promise(() => exited.promise);
      yield* Deferred.succeed(resume, undefined);
      assert.equal((yield* Fiber.join(read))._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT revoked FROM sessions`.pipe(SqliteClient.authReadOnly), [
        { revoked: 0 },
      ]);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
});

it.live("releases expired auth permits without waiting for old transaction bodies", () =>
  withLaneClient((sql) =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const hold = (ready: Deferred.Deferred<void>) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT * FROM sessions`;
              yield* Deferred.succeed(ready, undefined);
              return yield* Effect.never;
            }),
          )
          .pipe(SqliteClient.authReadOnly, Effect.exit, Effect.forkChild);
      const one = yield* hold(first);
      yield* Deferred.await(first);
      assert.equal((yield* Fiber.join(one))._tag, "Failure");
      for (let n = 0; n < 2; n++) {
        assert.deepEqual(yield* sql`SELECT revoked FROM sessions`.pipe(SqliteClient.authReadOnly), [
          { revoked: 0 },
        ]);
      }
    }),
  ),
);

it.live("kills native SQLite work before admitting replacement or checkpointing", () =>
  withLaneClient((sql) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const read = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT * FROM sessions`;
            yield* Deferred.succeed(held, undefined);
            yield* sql.unsafe(
              "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) FROM n",
            );
          }),
        )
        .pipe(SqliteClient.authReadOnly, Effect.exit, Effect.forkChild);
      yield* Deferred.await(held);
      yield* sql`UPDATE sessions SET revoked=1`;
      const result = yield* Fiber.join(read);
      assert.equal(result._tag, "Failure");
      const checkpoint = yield* sql<{ busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`;
      assert.equal(checkpoint[0]?.busy, 0);
      for (let n = 0; n < 2; n++)
        assert.deepEqual(yield* sql`SELECT revoked FROM sessions`.pipe(SqliteClient.authReadOnly), [
          { revoked: 1 },
        ]);
    }),
  ),
);

it.live("waits for submitted native work to exit when a read is cancelled", () => {
  const submitted = Promise.withResolvers<void>();
  const start = ReaderProcess.startReaderProcess;
  const spy = vi.spyOn(ReaderProcess, "startReaderProcess").mockImplementation((...args) => {
    const runtime = start(args[0], { ...args[1], reportStarted: true }, args[2]);
    const post = runtime.postMessage;
    let queryId: unknown;
    runtime.postMessage = (input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "sql" in input &&
        String(input.sql).includes("WITH RECURSIVE") &&
        "id" in input
      )
        queryId = input.id;
      post(input);
    };
    runtime.on("message", (reply: unknown) => {
      if (
        typeof reply === "object" &&
        reply !== null &&
        "started" in reply &&
        queryId !== undefined &&
        reply.started === queryId
      )
        submitted.resolve();
    });
    return runtime;
  });
  return withLaneClient((sql) =>
    Effect.gen(function* () {
      const read = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT * FROM sessions`;
            yield* sql.unsafe(
              "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) FROM n",
            );
          }),
        )
        .pipe(SqliteClient.authReadOnly, Effect.forkChild);
      yield* Effect.promise(() => submitted.promise);
      yield* sql`UPDATE sessions SET revoked=1`;
      yield* Fiber.interrupt(read);
      const rows = yield* sql<{ busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`;
      assert.equal(rows[0]?.busy, 0);
      assert.deepEqual(yield* sql`SELECT revoked FROM sessions`.pipe(SqliteClient.authReadOnly), [
        { revoked: 1 },
      ]);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
});

it.live("yields before resuming a pooled reader continuation", () => {
  const events: Array<string> = [];
  const yielded = Promise.withResolvers<void>();
  const start = ReaderProcess.startReaderProcess;
  const spy = vi.spyOn(ReaderProcess, "startReaderProcess").mockImplementation((...args) => {
    const runtime = start(...args);
    const post = runtime.postMessage;
    let queryId: unknown;
    runtime.postMessage = (input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "sql" in input &&
        String(input.sql).includes("answer") &&
        "id" in input
      )
        queryId = input.id;
      post(input);
    };
    runtime.on("message", (reply: unknown) => {
      if (
        typeof reply === "object" &&
        reply !== null &&
        "rows" in reply &&
        "id" in reply &&
        queryId !== undefined &&
        reply.id === queryId
      ) {
        // This check-phase callback was queued before the client's listener.
        // Observe the native IPC/check-phase scheduling boundary.
        setImmediate(() => {
          events.push("yield");
          yielded.resolve();
        });
      }
    });
    return runtime;
  });
  return withLaneClient((sql) =>
    Effect.gen(function* () {
      yield* sql`SELECT 42 AS answer`.pipe(
        SqliteClient.authReadOnly,
        Effect.tap(() => Effect.sync(() => events.push("result"))),
      );
      yield* Effect.promise(() => yielded.promise);
      assert.deepEqual(events, ["yield", "result"]);
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
});

it.effect("pooled readers send only result messages for SQL requests", () => {
  const replies: Array<unknown> = [];
  const start = ReaderProcess.startReaderProcess;
  const spy = vi.spyOn(ReaderProcess, "startReaderProcess").mockImplementation((...args) => {
    const runtime = start(...args);
    runtime.on("message", (reply: unknown) => replies.push(reply));
    return runtime;
  });
  return withLaneClient((sql) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* sql`SELECT 42 AS answer`.pipe(SqliteClient.authReadOnly), [
        { answer: 42 },
      ]);
      assert.equal(
        replies.filter((reply) => typeof reply === "object" && reply !== null && "rows" in reply)
          .length,
        1,
      );
      assert.isFalse(
        replies.some((reply) => typeof reply === "object" && reply !== null && "started" in reply),
      );
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
});

it.live.each(["cancellation", "expiry"] as const)(
  "waits for physical exit after idle auth transaction %s",
  (mode) => {
    const cancel = mode === "cancellation";
    const terminating = Promise.withResolvers<void>();
    const releaseExit = Promise.withResolvers<void>();
    const start = ReaderProcess.startReaderProcess;
    const spy = vi.spyOn(ReaderProcess, "startReaderProcess").mockImplementation((...args) => {
      const runtime = start(...args);
      const terminate = runtime.terminate;
      runtime.terminate = async () => {
        terminating.resolve();
        const code = await terminate();
        await releaseExit.promise;
        return code;
      };
      return runtime;
    });
    return withLaneClient((sql) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const read = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT * FROM sessions`;
              yield* Deferred.succeed(ready, undefined);
              return yield* Effect.never;
            }),
          )
          .pipe(SqliteClient.authReadOnly, Effect.exit, Effect.forkChild);
        yield* Deferred.await(ready);
        const done = yield* (
          cancel ? Effect.asVoid(Fiber.interrupt(read)) : Effect.asVoid(Fiber.join(read))
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() => terminating.promise);
        yield* Effect.yieldNow;
        assert.isUndefined(done.pollUnsafe());
        releaseExit.resolve();
        yield* Fiber.join(done);
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          releaseExit.resolve();
          spy.mockRestore();
        }),
      ),
    );
  },
);
