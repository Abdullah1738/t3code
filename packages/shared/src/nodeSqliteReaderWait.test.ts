import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";
import * as NodeSqlite from "node:sqlite";

it.live(
  "counts reader acquisitions once per borrow or transaction even with tracing disabled",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(path.join(dir, "test.sqlite"));
        try {
          db.exec("PRAGMA journal_mode = WAL");
        } finally {
          db.close();
        }
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const waits: number[] = [];
        yield* sql`SELECT 1`.pipe(SqliteClient.readOnly);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* sql`SELECT 2`;
            }),
          )
          .pipe(SqliteClient.readOnly, SqliteClient.foregroundReads);
        assert.equal(waits.length, 0);
        yield* sql`SELECT 1`.pipe(
          SqliteClient.readOnly,
          Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT 1`;
              yield* sql`SELECT 2`;
            }),
          )
          .pipe(
            SqliteClient.readOnly,
            SqliteClient.foregroundReads,
            Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
          );
        assert.equal(waits.length, 2);
        assert.isTrue(waits.every((ms) => Number.isFinite(ms) && ms >= 0));
        assert.deepEqual(
          yield* sql`SELECT 3 AS n`.pipe(
            SqliteClient.readOnly,
            Effect.provideService(SqliteClient.ReaderWaitObserver, () => {
              throw new Error("observer");
            }),
          ),
          [{ n: 3 }],
        );
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(dir, "test.sqlite"),
            readerWorker: true,
            foregroundReaderSlots: 1,
          }),
        ),
        Effect.withTracerEnabled(false),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])(
  "records interrupted reader acquisition (transaction=%s)",
  (transaction) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waits: number[] = [];
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const read = transaction ? sql.withTransaction(sql`SELECT 1`) : sql`SELECT 1`;
        const fiber = yield* Effect.forkChild(
          read.pipe(
            SqliteClient.readOnly,
            Effect.provideService(SqliteClient.ReaderWaitObserver, (ms) => waits.push(ms)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert.equal(waits.length, 1);
        assert.isAbove(waits[0]!, 0);
      }).pipe(
        Effect.provide(
          SqliteClient.layer({
            filename: path.join(dir, "test.sqlite"),
            readerWorker: true,
            beforeAcquire: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
